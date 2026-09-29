/**
 * Demo-Modus für Screenshots (Issue #5): web:dev mit WEB_DEV_DEMO=1.
 *
 * Legt ein frisches temporäres Verzeichnis an, schreibt dort eine
 * vorbereitete Beispiel-Unterhaltung hinein und startet den Web-Server mit
 * der Option demo. Vorhandene Gespräche und Sessions aus data/ werden weder
 * gelesen noch angezeigt. Beim Stoppen wird das Verzeichnis gelöscht.
 * Direktchat und Topics kommen aus einer Attrappe (createDemoTelegram), nie
 * aus dem echten Nachrichtenspeicher. Nachrichten „aus Telegram" simuliert
 * DemoServer.receiveTelegram (Issue #20, für den Browser-Durchlauf).
 * Topics anlegen, umbenennen, schließen und löschen (Issue #29) läuft über
 * die echte Topic-Verwaltung mit einer Telegram-Attrappe (createDemoTopics);
 * nichts geht nach Telegram. Seit Issue #30 ist das ältere Beispiel-Topic
 * „Archiv" geschlossen, die Rechte des Bots sind einstellbar (topicRights)
 * und neue Topics bekommen wie im Bot den Titel aus der ersten Nachricht.
 * Status und „Jetzt neu starten" (Issue #37) kommen aus createDemoStatus:
 * der Neustart wird nur im Speicher vermerkt, nie als echter Marker.
 * Einstellungen, Agenten-Anweisungen und Modell-Listen (Issue #38) kommen aus
 * createDemoSettings, createDemoInstructions und createDemoModels: nur im
 * Speicher, ohne Netzabruf, nie config/.
 * Der Agenten-Katalog (Issue #50) kommt aus createDemoAgentCatalog: im
 * Speicher, mit den Topics der Attrappe und der Einstellungs-Attrappe
 * verbunden (gelöschte Agenten fehlen dort sofort), nie config/agents.json.
 * Rückfrage-Knöpfe (Issue #115): im Topic „Strategie" eine offene und eine
 * erledigte Werkzeug-Freigabe aus createDemoChoices, einem Register nur im
 * Speicher; nie data/choices.json.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";
import type { MessageSavedListener, SavedMessageEvent } from "../lib/convex";
import type { TopicStateEntry } from "../lib/topic-state";
import { tmpdir } from "node:os";
import { BRAND } from "../brand";
import { join } from "node:path";
import { toApiAttachment, type ApiAttachment } from "./attachments";
import { toApiMessage, type MessageSource, type WebChat } from "./chat";
import type { WebConfig } from "./config";
import { FAKE_REPLY } from "./fake-chat";
import type { FileSource, FilesDeps } from "./files";
import type { NoticeFile } from "./notice";
import { createWebServer, DEMO_HOST, type WebServer } from "./server";
import { agentLabel, FALLBACK_AGENT_NAMES } from "./agents";
import { AgentPortError, CATALOG_ID_PATTERN, type AgentCatalogPort, type TopicUsageEntry } from "./agent-catalog";
import { InstructionsChanged, type InstructionsPort } from "./instructions";
import { goalCardActions, type GoalCard, type GoalPort } from "./goals";
import { createChoicePort, type ChoicePort, type ChoiceRegister, type RegisterChoice, type RegisterDecideOutcome } from "./choices";
import { COMMANDS_TEXT, type CommandListEntry, type CommandPort } from "./commands";
import { CLAUDE_MODELS, type ModelCatalog } from "./models";
import type { EffectiveSettings, ModelAndEffort, SettingsData, SettingsPort, ValidateResult } from "./settings";
import { keyStatus, type StatusPort, type Supervisor } from "./status";
import type { EngineAvailability, EnginePort } from "./engines";
import { UploadStore } from "./uploads";
import type { KeysPort } from "./keys";
import { ConversationStore, type ReplyInfo } from "./store";
import type { ConversationSessionReset } from "./session-reset";
import { createTopicManager, TopicAgentGone, type TelegramTopicApi, type TopicManager, type TopicRights, type TopicStatePort } from "./topics";
import {
  TELEGRAM_HISTORY_LIMIT,
  type TelegramApiMessage,
  type TelegramConversation,
  type TelegramConversationList,
  type TelegramLiveEvent,
  type TelegramLiveFeed,
  type TelegramTopicChangeEvent,
  type TelegramSource,
} from "./telegram";

export const DEMO_REPLY = [
  "## Vergleich der Varianten",
  "",
  "Hier die drei Optionen im Überblick. Die Tabelle ist absichtlich breit, damit man sieht, dass sie in sich scrollt.",
  "",
  "| Variante | Kosten pro Monat | Aufwand Einrichtung | Wartung | Datenschutz | Empfehlung |",
  "|---|---|---|---|---|---|",
  "| Lokal auf dem Mac | 0 Euro | gering | selten | alles bleibt zu Hause | für den Anfang |",
  "| Kleiner VPS | etwa 5 Euro | mittel | Updates monatlich | beim Anbieter | wenn der Mac oft schläft |",
  "| Hybrid | etwa 5 Euro plus API | hoch | zwei Systeme | gemischt | nur bei Bedarf |",
  "",
  "### Beispiel für die Einstellung",
  "",
  "```sh",
  "WEB_ENABLED=true WEB_HOST=127.0.0.1 WEB_PORT=3100 WEB_PASSWORD=ein-langes-passwort bun run start   # eine sehr lange Zeile zum Scrollen",
  "```",
  "",
  "### Nächste Schritte",
  "",
  "1. Passwort mit mindestens 12 Zeichen festlegen",
  "2. Port wählen, der noch frei ist",
  "3. Im Heimnetz nur mit `WEB_HOST=0.0.0.0` freigeben",
  "4. Im Browser `http://localhost:3100` öffnen",
  "5. Anmelden und die erste Nachricht schicken",
  "6. Auf dem Handy dieselbe Adresse mit der IP des Macs öffnen",
  "7. Lesezeichen auf dem Startbildschirm ablegen",
  "8. Nach einer Woche prüfen, ob alles rund läuft",
  "",
  "> Hinweis: Im Heimnetz läuft die Verbindung unverschlüsselt.",
  "",
  "Bei Fragen einfach weiterschreiben. [REMEMBER: Demo-Tag, darf nicht sichtbar sein]",
].join("\n");

/** Schreibt die Beispiel-Unterhaltung in einen leeren Speicher. */
export async function seedDemoConversation(store: ConversationStore): Promise<string> {
  // Älteres Gespräch mit einem anderen Agenten, damit Seitenleiste und
  // Agentenfarben im Screenshot sichtbar sind
  const older = await store.createConversation("research");
  await store.appendMessage(older.id, { role: "user", text: "Was kostet ein kleiner VPS im Monat?" });
  await store.appendMessage(older.id, { role: "assistant", text: "Meist **4 bis 6 Euro** im Monat für 2 vCPU und 4 GB RAM." });
  const conversation = await store.createConversation("general");
  const id = conversation.id;
  await store.appendMessage(id, { role: "user", text: `Wie betreibe ich ${BRAND.name} am besten? Bitte mit Tabelle und Beispiel.` });
  // Angaben unter der Antwort (Issue #22); die ältere Antwort oben hat keine, wie vor #22 gespeichert
  await store.appendMessage(id, { role: "assistant", text: DEMO_REPLY, agent: "general", model: "claude-opus-5-5", durationMs: 42_000 });
  await store.appendMessage(id, { role: "user", text: "Und eine kurze Testantwort bitte, <b>ohne</b> Formatierung aus meinem Text." });
  // Wie nach einem Fallback: das Fallback-Modell steht unter der Antwort
  await store.appendMessage(id, { role: "assistant", text: FAKE_REPLY, agent: "general", model: "minimax/minimax-m2.7", durationMs: 187_000 });
  await store.appendMessage(id, { role: "user", text: "Noch eine lange Recherche, bitte" });
  await store.appendMessage(id, { role: "error", text: "Abgebrochen." });
  return id;
}

// ---------------------------------------------------------------------------
// Telegram-Attrappe für die Demo (Issue #18): Direktchat mit langem Verlauf,
// aktuelle und ältere Topics. Zeiten relativ zum Start, damit „vor 5 Min."
// und „Ältere Topics" in jedem Screenshot stimmen.
// ---------------------------------------------------------------------------

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

/** Nachrichten im Direktchat: mehr als zwei Seiten, damit das Nachladen zweimal greift */
export const DEMO_DM_MESSAGES = 120;

const DM_QUESTIONS = [
  "Was steht heute an?",
  "Erinnere mich morgen an den Zahnarzt.",
  "Wie war noch mal der Plan für den VPS?",
  "Fass mir die Mails von gestern kurz zusammen.",
  "Wie wird das Wetter am Wochenende?",
];
const DM_ANSWERS = [
  "Heute stehen **zwei Termine** an: 10 Uhr Standup, 15 Uhr Review.",
  "Erledigt, ich melde mich morgen um 9 Uhr.",
  "Plan: erst lokal testen, dann auf den VPS, am Ende `WEB_HOST` nur im Heimnetz freigeben.",
  "Drei Mails: eine Rechnung, eine Terminbestätigung, ein Newsletter.",
  "Samstag sonnig, Sonntag Regen ab Mittag.",
];

/** ISO mit Mikrosekunden wie aus Postgres; der Cursor für ?before= muss sie behalten */
function micro(time: number, n: number): string {
  return new Date(time).toISOString().replace("Z", String(100 + (n % 900)).padStart(3, "0") + "Z");
}

/** Sortierschlüssel mit sechs Nachkommastellen (".123Z" gleich ".123000Z") */
function sortKey(value: string): string {
  return value.replace(/\.(\d{1,6})Z$/, (_, f: string) => `.${f.padEnd(6, "0")}Z`);
}

type DemoRow = ReplyInfo & {
  id: string;
  role: "user" | "assistant";
  text: string;
  createdAt: string;
  /** Meldung (Issue #47) mit Absender und ggf. Datei */
  kind?: "notice";
  source?: string;
  file?: NoticeFile;
  /** Anhänge einer eigenen Nachricht aus dem Browser (Issue #73) */
  attachments?: ApiAttachment[];
  /** Rückfrage mit Knöpfen (Issue #115) */
  choiceId?: string;
};

function demoDirectChat(now: number): DemoRow[] {
  const rows: DemoRow[] = [];
  // Alle 40 Minuten eine Nachricht, die jüngste vor 20 Minuten
  for (let n = 0; n < DEMO_DM_MESSAGES; n++) {
    const time = now - 20 * MINUTE - (DEMO_DM_MESSAGES - 1 - n) * 40 * MINUTE;
    const pair = Math.floor(n / 2);
    if (n % 2 === 0) {
      rows.push({ id: `dm-${n}`, role: "user", text: `${DM_QUESTIONS[pair % DM_QUESTIONS.length]} (Nr. ${pair + 1})`, createdAt: micro(time, n) });
    } else {
      // Jede fünfte Antwort kommt von Research, sonst General
      const agent = pair % 5 === 4 ? "research" : "general";
      // Die ältesten Antworten ohne Modell und Dauer, wie vor Issue #22 gespeichert
      const info = n < DEMO_DM_MESSAGES - 20 ? {} : { model: "claude-opus-5-5", durationMs: 3_000 + pair * 700 };
      rows.push({ id: `dm-${n}`, role: "assistant", text: DM_ANSWERS[pair % DM_ANSWERS.length], createdAt: micro(time, n), agent, ...info });
    }
  }
  return rows;
}

function demoTopicChat(prefix: string, lastAt: number, agent: string, pairs: ([string, string] | [string, string, ReplyInfo])[]): DemoRow[] {
  const rows: DemoRow[] = [];
  pairs.forEach(([question, answer, info], i) => {
    const time = lastAt - (pairs.length - 1 - i) * 30 * MINUTE;
    rows.push({ id: `${prefix}-${2 * i}`, role: "user", text: question, createdAt: micro(time - 2 * MINUTE, i) });
    rows.push({
      id: `${prefix}-${2 * i + 1}`,
      role: "assistant",
      text: answer,
      createdAt: micro(time, i),
      agent,
      model: "claude-opus-5-5",
      durationMs: 8_000 + i * 5_000,
      ...info,
    });
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Meldungen und Dateien der Demo (Issue #47): ein Topic „Pipeline" mit einer
// Pipeline-Meldung, einem Bild (Vorschau) und einem HTML-Report (nur
// Download). Die Dateien liegen in einer eigenen Demo-Ablage, nie in
// data/outbox.
// ---------------------------------------------------------------------------

/** Beispieldateien der Demo; ids fest, damit Browser-Durchlauf und Tests sie kennen */
export const DEMO_FILES = {
  image: { id: "5f0c2a9e-4b1d-4c7a-8e3f-2d6b9a1c0e47", name: "Kostenverlauf September.png", mime: "image/png" },
  report: { id: "9b3e7d21-6a4f-4e8c-b5d0-7c1f2e8a9d36", name: "Report Oktober.html", mime: "text/html" },
} as const;

const DEMO_REPORT_HTML =
  "<!doctype html><title>Report</title><h1>Report Oktober</h1><script>document.title='ausgeführt'</script>";

/** Kleines PNG mit ruhigem Verlauf, ohne Abhängigkeiten gebaut */
function demoPng(width = 480, height = 200): Uint8Array {
  const crcTable = new Int32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc = (bytes: Uint8Array) => {
    let c = -1;
    for (const b of bytes) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const header = new Uint8Array(13);
  const hv = new DataView(header.buffer);
  hv.setUint32(0, width);
  hv.setUint32(4, height);
  header.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    // Balken wie ein kleines Diagramm, sonst heller Grund
    for (let x = 0; x < width; x++) {
      const bar = Math.floor(x / 40);
      const top = height - 30 - ((bar * 37) % 120);
      const inBar = x % 40 > 8 && y > top && y < height - 20;
      const i = row + 1 + x * 3;
      raw.set(inBar ? [31, 111, 214] : [236, 239, 244], i);
    }
  }
  const signature = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const parts = [signature, chunk("IHDR", header), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Inhalte der Beispieldateien */
export function demoFileContents(): Record<keyof typeof DEMO_FILES, Uint8Array> {
  return { image: demoPng(), report: new TextEncoder().encode(DEMO_REPORT_HTML) };
}

function demoNoticeRows(now: number): DemoRow[] {
  const contents = demoFileContents();
  const file = (key: keyof typeof DEMO_FILES): NoticeFile => ({ ...DEMO_FILES[key], size: contents[key].byteLength });
  return [
    {
      id: "n-0", role: "assistant", kind: "notice", source: "pipeline", createdAt: micro(now - 125 * MINUTE, 1),
      text: "**Issue #47** ist fertig: Pull Request geöffnet, `bun run check` grün.\n\n- Download-Route mit Tests\n- Abfrage alle 15 Sekunden",
    },
    { id: "n-1", role: "assistant", kind: "notice", source: "datei", createdAt: micro(now - 122 * MINUTE, 2), text: "Kostenverlauf als Bild", file: file("image") },
    { id: "n-2", role: "assistant", kind: "notice", source: "datei", createdAt: micro(now - 120 * MINUTE, 3), text: DEMO_FILES.report.name, file: file("report") },
  ];
}

// ---------------------------------------------------------------------------
// Rückfrage-Knöpfe der Demo (Issue #115): zwei Werkzeug-Freigaben im Topic
// „Strategie", die erste erledigt (in Telegram), die zweite offen
// ---------------------------------------------------------------------------

/** Kennungen fest, damit Browser-Durchlauf und Tests sie kennen */
export const DEMO_CHOICES = { done: "DemoFertig01", open: "DemoOffen001" } as const;
const DEMO_CHOICE_OPTIONS = [
  { key: "ok", label: "Erlauben" },
  { key: "no", label: "Ablehnen" },
];

function demoChoiceRows(after: number): DemoRow[] {
  return [
    {
      id: "c-0", role: "assistant", kind: "notice", source: "freigabe", createdAt: micro(after + 2 * MINUTE, 1), choiceId: DEMO_CHOICES.done,
      text: "**Strategy** möchte `WebSearch` ausführen: „Newsletter Öffnungsraten 2026“",
    },
    {
      id: "c-1", role: "assistant", kind: "notice", source: "freigabe", createdAt: micro(after + 4 * MINUTE, 2), choiceId: DEMO_CHOICES.open,
      text: "**Strategy** möchte `Write` ausführen: `docs/newsletter-plan.md`",
    },
  ];
}

export interface DemoChoices extends ChoicePort {
  /** Simuliert einen Klick in Telegram (via telegram) */
  decideInTelegram(id: string, key: string): Promise<RegisterDecideOutcome>;
}

/**
 * Rückfragen der Demo: ein Register nur im Speicher mit denselben Regeln wie
 * src/lib/choices.ts (erster Klick gewinnt, unbekannte Option lässt offen),
 * dahinter der echte ChoicePort. Nichts aus src/lib, nie data/choices.json.
 */
export function createDemoChoices(now: number = Date.now()): DemoChoices {
  const conversation = { type: "telegram" as const, chatId: DEMO_GROUP_ID, topicId: 31 };
  const choices = new Map<string, RegisterChoice>([
    [DEMO_CHOICES.done, {
      id: DEMO_CHOICES.done, conversation, options: DEMO_CHOICE_OPTIONS, state: "done",
      result: { key: "ok", label: "Erlauben", via: "telegram", at: now - 12 * DAY + 3 * MINUTE },
    }],
    [DEMO_CHOICES.open, { id: DEMO_CHOICES.open, conversation, options: DEMO_CHOICE_OPTIONS, state: "open" }],
  ]);
  const listeners = new Set<(change: { type: string; choice: RegisterChoice }) => void>();
  const copy = (c: RegisterChoice): RegisterChoice => structuredClone(c);
  async function decide(id: string, key: string, via: "telegram" | "web" | "terminal"): Promise<RegisterDecideOutcome> {
    const c = choices.get(id);
    if (!c) return { status: "unknown" };
    if (c.state === "done") return { status: "already", choice: copy(c) };
    if (c.state === "expired") return { status: "expired" };
    const option = c.options.find(o => o.key === key);
    if (!option) return { status: "invalid_key", choice: copy(c) };
    c.state = "done";
    c.result = { key: option.key, label: option.label, via, at: Date.now() };
    for (const listener of [...listeners]) listener({ type: "decided", choice: copy(c) });
    return { status: "decided", choice: copy(c) };
  }
  const register: ChoiceRegister = {
    get: async id => (choices.has(id) ? copy(choices.get(id)!) : undefined),
    list: async () => [...choices.values()].map(copy),
    decide,
    onChange(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const port = createChoicePort({ register, groupId: () => DEMO_GROUP_ID, log: () => {} });
  return { ...port, decideInTelegram: (id, key) => decide(id, key, "telegram") };
}

/** Legt die Beispieldateien in der Demo-Ablage an (dir/<id>/<name>) */
export async function writeDemoFiles(dir: string): Promise<void> {
  const contents = demoFileContents();
  for (const key of Object.keys(DEMO_FILES) as (keyof typeof DEMO_FILES)[]) {
    const { id, name } = DEMO_FILES[key];
    await mkdir(join(dir, id), { recursive: true });
    await writeFile(join(dir, id, name), contents[key]);
  }
}

/** Chat-ID der Forum-Gruppe in Demo und web:dev (nie eine echte Gruppe) */
export const DEMO_GROUP_ID = "-1000000000001";

export interface DemoTelegram extends TelegramSource {
  /** Legt eine Nachricht wie aus Telegram an (Verlauf und Aktivität); null bei unbekannter ID */
  receive(id: string, role: "user" | "assistant", text: string, agent?: string): TelegramLiveEvent | null;
  /** Legt eine Meldung wie aus der Outbox an (Issue #47), optional mit Rückfrage (choiceId, Issue #118); null bei unbekannter ID */
  receiveNotice(id: string, source: string, text: string, file?: NoticeFile, choiceId?: string): TelegramLiveEvent | null;
  /** Dateiquelle über alle Meldungen der Attrappe (Issue #47) */
  files: FileSource;
  /**
   * Nutzernachricht aus dem Browser mit Anhängen in den Verlauf (Issue #73),
   * wie der Turn im Bot sie mit metadata.attachments speichert: so zeigt der
   * Verlauf sie auch nach dem Neuladen. false bei unbekannter ID.
   */
  recordUserMessage(id: string, messageId: string, text: string, createdAt: string, attachments: ApiAttachment[]): boolean;
  /** Topic anlegen oder Titel/Agent ändern (für die Topic-Verwaltung der Demo) */
  upsertTopic(topicId: number, fields: { title?: string; agent?: string }): void;
  /** Agent je Topic (Issue #50: Topic-Zahlen und Umstellen beim Löschen eines Agenten) */
  topicAgents(): { topicId: number; agent: string }[];
}

export interface DemoTelegramOptions {
  /** Topic-Zustand (Issue #29): gelöschte fehlen, geschlossene tragen closed */
  topicState?(chatId: string): Promise<Map<number, TopicStateEntry>>;
  /** false: ohne Beispieldaten, nur General (normales web:dev) */
  seed?: boolean;
}

/** Telegram-Quelle der Demo; now ist der Startzeitpunkt. */
export function createDemoTelegram(now: number = Date.now(), options: DemoTelegramOptions = {}): DemoTelegram {
  const seed = options.seed !== false;
  const topics: (TelegramConversation & { rows: DemoRow[] })[] = seed ? [
    {
      id: "topic-443", title: "Recherche", agent: "research", lastActivity: null,
      rows: demoTopicChat("r", now - 5 * MINUTE, "research", [
        ["Was kostet ein kleiner VPS bei Hetzner?", "Ab etwa **4 Euro** im Monat für 2 vCPU und 4 GB RAM.", { engine: "claude" }],
        // Nach /motor codex (Issue #126): Antwort-Angabe mit Codex, Modell aus der Codex-Konfiguration
        ["Und bei anderen Anbietern?", "Meist ähnlich, im ersten Jahr oft günstiger, danach teurer.", { engine: "codex", model: "gpt-5.6-sol" }],
      ]),
    },
    // Meldungen und Dateien (Issue #47)
    { id: "topic-60", title: "Pipeline", agent: "general", lastActivity: null, rows: demoNoticeRows(now) },
    {
      id: "topic-12", title: "Finanzen", agent: "finance", lastActivity: null,
      // Nach /motor opencode (Issue #129): Antwort-Angabe mit OpenCode und OpenRouter-Modell
      rows: demoTopicChat("f", now - 26 * 60 * MINUTE, "finance", [
        ["Wie hoch waren die API-Kosten im August?", "Rund **38 Euro**, davon 80 % Opus.", { engine: "opencode", model: "openrouter/anthropic/claude-opus-5.5" }],
      ]),
    },
    {
      id: "topic-31", title: "Strategie", agent: "strategy", lastActivity: null,
      rows: [
        ...demoTopicChat("s", now - 12 * DAY, "strategy", [["Lohnt sich ein Newsletter?", "Nur mit festem Rhythmus, sonst nicht."]]),
        ...demoChoiceRows(now - 12 * DAY),
      ],
    },
    {
      id: "topic-7", title: "Archiv <alt> & Co", agent: "cto", lastActivity: null,
      rows: demoTopicChat("a", now - 45 * DAY, "cto", [["Welche Node-Version läuft auf dem VPS?", "Keine, dort läuft nur Bun 1.3."]]),
    },
    // General ohne gespeicherte Nachrichten: letzte Aktivität unbekannt
    { id: "topic-1", title: "General", agent: "general", lastActivity: null, rows: [] },
  ] : [{ id: "topic-1", title: "General", agent: "general", lastActivity: null, rows: [] }];
  for (const t of topics) t.lastActivity = t.rows.at(-1)?.createdAt ?? null;
  const dmRows = seed ? demoDirectChat(now) : [];
  const dm: TelegramConversation | null = seed ? { id: "dm", title: "Direktchat", agent: "general", lastActivity: dmRows.at(-1)!.createdAt } : null;

  const strip = ({ rows: _rows, ...t }: TelegramConversation & { rows: DemoRow[] }): TelegramConversation => t;
  async function list(): Promise<TelegramConversationList> {
    let states = new Map<number, TopicStateEntry>();
    let unreadable = false;
    if (options.topicState) {
      try {
        states = await options.topicState(DEMO_GROUP_ID);
      } catch {
        unreadable = true;
      }
    }
    const visible: TelegramConversation[] = [];
    for (const t of topics) {
      const topicId = Number(t.id.slice("topic-".length));
      const state = states.get(topicId);
      if (topicId !== 1 && (unreadable || state?.deleted)) continue;
      visible.push(topicId !== 1 && state?.closed ? { ...strip(t), closed: true } : strip(t));
    }
    return { dm: dm ? { ...dm } : null, topics: visible };
  }
  async function getConversation(id: string): Promise<TelegramConversation | null> {
    const current = await list();
    if (id === "dm") return current.dm;
    return current.topics.find(t => t.id === id) ?? null;
  }
  const rowsFor = (id: string) => (id === "dm" ? (dm ? dmRows : undefined) : topics.find(t => t.id === id)?.rows);

  return {
    receive(id, role, text, agent) {
      const rows = rowsFor(id);
      if (!rows) return null;
      const row: DemoRow = { id: crypto.randomUUID(), role, text, createdAt: new Date().toISOString(), ...(agent ? { agent } : {}) };
      rows.push(row);
      if (id === "dm") dm!.lastActivity = row.createdAt;
      else topics.find(t => t.id === id)!.lastActivity = row.createdAt;
      return { conversationId: id, at: row.createdAt, message: toApiMessage(row) };
    },
    recordUserMessage(id, messageId, text, createdAt, attachments) {
      const rows = rowsFor(id);
      if (!rows || rows.some(r => r.id === messageId)) return false;
      rows.push({ id: messageId, role: "user", text, createdAt, ...(attachments.length ? { attachments } : {}) });
      if (id === "dm") dm!.lastActivity = createdAt;
      else topics.find(t => t.id === id)!.lastActivity = createdAt;
      return true;
    },
    receiveNotice(id, source, text, file, choiceId) {
      const rows = rowsFor(id);
      if (!rows) return null;
      const row: DemoRow = {
        id: crypto.randomUUID(), role: "assistant", kind: "notice", source, text, createdAt: new Date().toISOString(),
        ...(file ? { file } : {}), ...(choiceId ? { choiceId } : {}),
      };
      rows.push(row);
      if (id === "dm") dm!.lastActivity = row.createdAt;
      else topics.find(t => t.id === id)!.lastActivity = row.createdAt;
      return { conversationId: id, at: row.createdAt, message: toApiMessage(row) };
    },
    files: {
      async find(fileId) {
        for (const rows of [dmRows, ...topics.map(t => t.rows)]) {
          const row = rows.find(r => r.kind === "notice" && r.file?.id === fileId);
          if (row?.file) return row.file;
        }
        return null;
      },
    },
    topicAgents: () => topics.map(t => ({ topicId: Number(t.id.slice("topic-".length)), agent: t.agent })),
    upsertTopic(topicId, fields) {
      const id = `topic-${topicId}`;
      let topic = topics.find(t => t.id === id);
      if (!topic) {
        topic = { id, title: `Topic ${topicId}`, agent: "general", lastActivity: null, rows: [] };
        topics.unshift(topic);
      }
      if (fields.title !== undefined) topic.title = fields.title;
      if (fields.agent !== undefined) topic.agent = fields.agent;
    },
    listConversations: list,
    groupChatId: () => DEMO_GROUP_ID,
    getConversation,
    async history(id, before) {
      if (!(await getConversation(id))) return null;
      const rows = rowsFor(id);
      if (!rows) return null;
      const older = before === undefined ? rows : rows.filter(r => sortKey(r.createdAt) < sortKey(before));
      const page = older.slice(-TELEGRAM_HISTORY_LIMIT);
      // toApiMessage übernimmt Agent, Modell und Dauer nur bei Antworten
      const messages: TelegramApiMessage[] = page.map(row => toApiMessage(row));
      return { messages, hasMore: older.length > page.length };
    },
  };
}

/** Telegram-Attrappe für die Topic-Verwaltung der Demo: merkt sich nur Aufrufe, neue Topics ab 900 */
export function createDemoTopicApi(rights: TopicRights = { manageTopics: true, deleteMessages: true }): TelegramTopicApi & { calls: string[] } {
  let next = 900;
  const calls: string[] = [];
  return {
    calls,
    async createForumTopic() {
      calls.push("createForumTopic");
      return { topicId: next++ };
    },
    async editForumTopic() {
      calls.push("editForumTopic");
    },
    async closeForumTopic() {
      calls.push("closeForumTopic");
    },
    async reopenForumTopic() {
      calls.push("reopenForumTopic");
    },
    async deleteForumTopic() {
      calls.push("deleteForumTopic");
    },
    async getMyRights() {
      return { ...rights };
    },
  };
}

/**
 * Topic-Zustand der Demo im Arbeitsspeicher (web:dev lädt nichts aus
 * src/lib); Verhalten wie TopicStateStore in src/lib/topic-state.ts.
 */
export function createMemoryTopicState(): TopicStatePort {
  const map = new Map<string, TopicStateEntry>();
  const key = (chatId: string, topicId: number) => `${chatId}:${topicId}`;
  return {
    async forChat(chatId) {
      const out = new Map<number, TopicStateEntry>();
      for (const [k, v] of map) if (k.startsWith(`${chatId}:`)) out.set(Number(k.slice(chatId.length + 1)), { ...v });
      return out;
    },
    async get(chatId, topicId) {
      return { ...(map.get(key(chatId, topicId)) ?? {}) };
    },
    async setFlag(chatId, topicId, flag, on) {
      const entry = { ...(map.get(key(chatId, topicId)) ?? {}) };
      if (on) entry[flag] = true;
      else delete entry[flag];
      if (Object.keys(entry).length) map.set(key(chatId, topicId), entry);
      else map.delete(key(chatId, topicId));
    },
    async claimAutoTitle(chatId, topicId) {
      const entry = map.get(key(chatId, topicId));
      if (!entry?.autoTitle) return false;
      await this.setFlag(chatId, topicId, "autoTitle", false);
      return !entry.deleted;
    },
  };
}

export interface DemoTopics {
  telegram: DemoTelegram;
  topics: TopicManager;
  /**
   * Meldet eine gespeicherte Nachricht wie der Nachrichtenspeicher des Bots
   * (Issue #30): Daraus setzt die Topic-Verwaltung den Titel neuer Topics.
   */
  messageSaved(event: SavedMessageEvent): void;
}

/**
 * Telegram-Quelle und Topic-Verwaltung für Demo und web:dev: Zustand,
 * Zuordnung und Namen nur im Arbeitsspeicher, keine Sessions und keine
 * Telegram-Ausführungen. Automatische Titel entstehen aus messageSaved
 * (Issue #30), das startDemoServer beim Schreiben in ein Topic aufruft.
 * Mit Beispieldaten ist das ältere Topic „Archiv" (topic-7) geschlossen.
 */
export function createDemoTopics(
  options: {
    seed?: boolean;
    now?: number;
    rights?: TopicRights;
    log?: (m: string) => void;
    /** Wie botSetMapping (Issue #50): Zuordnung zu einem inzwischen gelöschten Agenten wird abgelehnt */
    isActiveAgent?: (name: string) => boolean;
  } = {}
): DemoTopics {
  const state = createMemoryTopicState();
  const telegram = createDemoTelegram(options.now ?? Date.now(), { seed: options.seed, topicState: chatId => state.forChat(chatId) });
  if (options.seed !== false) void state.setFlag(DEMO_GROUP_ID, 7, "closed", true);
  const savedListeners = new Set<MessageSavedListener>();
  const topics = createTopicManager({
    api: createDemoTopicApi(options.rights),
    groupId: () => DEMO_GROUP_ID,
    state,
    setMapping: async (_chatId, topicId, agent) => {
      if (options.isActiveAgent && !options.isActiveAgent(agent)) throw new TopicAgentGone();
      telegram.upsertTopic(topicId, { agent });
    },
    removeMapping: async () => {},
    saveName: async (topicId, name) => telegram.upsertTopic(topicId, { title: name }),
    forgetName: async () => {},
    resetSession: async () => {},
    executions: { isActive: () => false, block: () => () => {}, abort: () => 0, waitIdle: async () => true },
    onMessageSaved(listener) {
      savedListeners.add(listener);
      return () => savedListeners.delete(listener);
    },
    log: options.log,
  });
  return {
    telegram,
    topics,
    messageSaved(event) {
      for (const listener of [...savedListeners]) void Promise.resolve(listener(event)).catch(() => {});
    },
  };
}

/**
 * Schreiben in ein Demo-Topic (Issue #30): meldet die Nutzernachricht wie der
 * Nachrichtenspeicher, wartet auf den automatischen Titel und meldet dann die
 * Aktivität, damit offene Seitenleisten den neuen Titel holen. Danach
 * antwortet die übergebene Attrappe.
 */
export function withDemoAutoTitle(
  chat: WebChat,
  demo: DemoTopics,
  publishActivity: (event: TelegramLiveEvent) => void
): WebChat {
  return {
    async runTurn(opts) {
      const match = /^topic-(\d+)$/.exec(opts.conversationId);
      if (match) {
        const at = new Date().toISOString();
        demo.messageSaved({ chatId: DEMO_GROUP_ID, role: "user", content: opts.text, metadata: { topicId: Number(match[1]) }, createdAt: at });
        await demo.topics.idle();
        publishActivity({ conversationId: opts.conversationId, at });
      }
      return chat.runTurn(opts);
    },
    stop: id => chat.stop(id),
    ...(chat.answer ? { answer: (id: string, text: string, approvalId: string, source?: MessageSource) => chat.answer!(id, text, approvalId, source) } : {}),
  };
}

export interface DemoStatus extends StatusPort {
  /** Notizen der angeforderten Neustarts (nur im Speicher) */
  restartNotes: string[];
}

/**
 * Status-Attrappe für web:dev und Demo (Issue #37): feste Beispielwerte,
 * einige Schlüssel als gesetzt markiert. „Jetzt neu starten" schreibt nie
 * data/restart-requested, der laufende Bot bekäme ihn sonst mit.
 */
export function createDemoStatus(options: { supervisor?: Supervisor | null; now?: () => number } = {}): DemoStatus {
  const now = options.now ?? Date.now;
  const startedAt = now() - (2 * 60 + 17) * 60_000;
  const supervisor = options.supervisor === undefined ? "launchd" : options.supervisor;
  const restartNotes: string[] = [];
  // Nur Platzhalter, damit keyStatus „gesetzt" meldet; die Werte verlassen keyStatus nie
  const keys = keyStatus({
    ANTHROPIC_API_KEY: "demo",
    OPENROUTER_API_KEY: "demo",
    GEMINI_API_KEY: "demo",
    SUPABASE_URL: "demo",
    SUPABASE_ANON_KEY: "demo",
    SUPABASE_SERVICE_ROLE_KEY: "demo",
    TELEGRAM_BOT_TOKEN_RESEARCH: "demo",
  });
  return {
    restartNotes,
    version: () => "0.0.0-demo",
    commit: async () => "demo000",
    startedAt: () => startedAt,
    supervisor: async () => supervisor,
    storage: () => "supabase",
    semanticSearch: async () => "aktiv",
    sessions: async () => ({ mode: "resume", stored: 4, resumable: 3 }),
    activeExecutions: () => 0,
    activeClaudeCalls: () => 0,
    restartRequested: async () => restartNotes.length > 0,
    requestRestart: async note => {
      restartNotes.push(note);
    },
    keys: () => keys,
    // Motoren (Issue #126): feste Angaben, nie ein echter Prüfbefehl
    engines: async () => structuredClone(DEMO_ENGINE_AVAILABILITY),
    now,
  };
}

/**
 * Schlüssel-Attrappe (Issue #62): eine .env nur im Speicher mit erfundenen
 * Platzhaltern, Ändern erlaubt. Nie die echte .env, nichts aus src/lib.
 */
export function createDemoKeys(options: { editAllowed?: boolean } = {}): KeysPort & { values: Map<string, string> } {
  const editAllowed = options.editAllowed ?? true;
  const values = new Map<string, string>([
    ["TELEGRAM_BOT_TOKEN", "000000000:demo-platzhalter-hauptbot"],
    ["TELEGRAM_USER_ID", "123456789"],
    ["ANTHROPIC_API_KEY", "demo-platzhalter-anthropic-a1b2"],
    ["OPENROUTER_API_KEY", "demo-platzhalter-openrouter-c3d4"],
    ["SUPABASE_URL", "https://demo-platzhalter.supabase.co"],
    ["SUPABASE_SERVICE_ROLE_KEY", "demo-platzhalter-supabase-e5f6"],
    ["WEB_ENABLED", "true"],
    ["USER_NAME", "Demo"],
    ...(editAllowed ? [["WEB_ALLOW_KEY_EDIT", "true"] as [string, string]] : []),
  ]);
  const atStart = Object.fromEntries(values);
  return {
    values,
    read: async () => Object.fromEntries(values),
    set: async (name, value) => {
      values.set(name, value);
    },
    remove: async name => values.delete(name),
    running: () => atStart,
    editEnabledAtStart: () => editAllowed,
  };
}

/**
 * Ziel-Attrappe (Issue #76): ein Ziel im Topic „Strategie" (topic-31), die
 * Knöpfe ändern nur den Speicher. Nichts aus src/lib, keine Goal-Engine.
 */
export function createDemoGoals(): GoalPort {
  let card: GoalCard | null = {
    goalId: 1790000000000,
    goal: "Preismodell für das Beratungspaket bis Freitag festlegen",
    agent: "strategy",
    status: "active",
    running: true,
    turnsUsed: 3,
    maxTurns: 10,
    note: "Nächster Schritt: drei Preisstufen gegen die Kosten rechnen",
    actions: ["pause", "stop"],
  };
  const listeners = new Set<(conversationId: string, card: GoalCard | null) => void>();
  const ID = "topic-31";
  return {
    async get(conversationId) {
      return conversationId === ID ? card : null;
    },
    async act(conversationId, action, goalId) {
      if (conversationId !== ID || !card || card.goalId !== goalId || !card.actions.includes(action)) {
        return { status: "stale", card: conversationId === ID ? card : null };
      }
      if (action === "stop") card = null;
      else {
        const next = { ...card };
        if (action === "pause") Object.assign(next, { status: "paused", running: false, note: "Vom User pausiert" });
        else Object.assign(next, { status: "active", running: true, ...(action === "more" ? { maxTurns: next.maxTurns + 5 } : {}) });
        next.actions = goalCardActions(next);
        card = next;
      }
      for (const listener of [...listeners]) listener(ID, card);
      return { status: "ok", card };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export interface DemoServer {
  server: WebServer;
  /** Temporäres Verzeichnis mit Sessions und Gesprächen der Demo */
  dir: string;
  /** Simuliert eine in Telegram geschriebene Nachricht: live an offene Browser; false bei unbekannter ID */
  receiveTelegram(id: string, role: "user" | "assistant", text: string, agent?: string): boolean;
  /** Simuliert eine Meldung aus einem anderen Prozess (Issue #47), optional mit Rückfrage (Issue #118): live an offene Browser */
  receiveNotice(id: string, source: string, text: string, file?: NoticeFile, choiceId?: string): boolean;
  /** Demo-Ablage der Beispieldateien (im temporären Verzeichnis) */
  filesDir: string;
  /** Rückfragen der Demo (Issue #115): decideInTelegram simuliert einen Klick in Telegram */
  choices: DemoChoices;
  /**
   * Simuliert eine geschriebene Topic-Zuordnung (Issue #119): Topic anlegen
   * oder Titel/Agent setzen und das Topic-Ereignis an offene Browser melden
   */
  changeTopic(topicId: number, fields: { title?: string; agent?: string }): void;
  stop(): Promise<void>;
}

export async function startDemoServer(
  config: WebConfig,
  deps: {
    chat?: WebChat;
    telegramChat?: WebChat;
    /** Rechte des Bots in der Demo-Gruppe (Issue #30), Standard: alle */
    topicRights?: TopicRights;
    /** Status-Attrappe (Issue #37), Standard: createDemoStatus() */
    status?: StatusPort;
    /** Motor-Attrappe (Issue #126), Standard: createDemoEngines über den Demo-Einstellungen */
    engines?: EnginePort;
    /** Einstellungen, Anweisungen, Modell-Listen (Issue #38), Standard: Attrappen im Speicher */
    settings?: SettingsPort & { data?(): SettingsData };
    instructions?: InstructionsPort;
    models?: ModelCatalog;
    /** Agenten-Katalog (Issue #50), Standard: createDemoAgentCatalog mit den Demo-Topics */
    agentCatalog?: AgentCatalogPort;
    /** Ziele (Issue #76), Standard: createDemoGoals() */
    goals?: GoalPort;
    /** Rückfragen (Issue #115), Standard: createDemoChoices() */
    choices?: DemoChoices;
    /** Slash-Befehle (Issue #77), Standard: createDemoCommands() */
    commands?: CommandPort;
    /** Schlüssel (Issue #62), Standard: createDemoKeys() im Speicher */
    keys?: KeysPort;
    /** Feste Oberflächen-Version (Issue #111), für den Versionswechsel im Browser-Durchlauf */
    uiVersion?: string;
    log?: (message: string) => void;
  } = {}
): Promise<DemoServer> {
  // Vor dem Anlegen von Dateien prüfen; createWebServer prüft noch einmal
  if (config.host !== DEMO_HOST) throw new Error(`Demo-Modus nur auf ${DEMO_HOST}, nicht auf ${config.host}`);
  const dir = await mkdtemp(join(tmpdir(), "tybo-web-demo-"));
  try {
    const dataDir = join(dir, "web");
    await seedDemoConversation(new ConversationStore({ dir: dataDir }));
    // Beispieldateien der Meldungen (Issue #47) in einer eigenen Ablage
    const filesDir = join(dir, "outbox");
    await writeDemoFiles(filesDir);
    const agents = createDemoAgents({ rights: deps.topicRights, log: deps.log, settings: DEMO_SETTINGS });
    const choices = deps.choices ?? createDemoChoices();
    const demoTopics = agents.topics;
    const { telegram, topics } = demoTopics;
    const listeners = new Set<(event: TelegramLiveEvent) => void>();
    const publish = (event: TelegramLiveEvent) => {
      for (const listener of [...listeners]) listener(event);
    };
    const topicListeners = new Set<(event: TelegramTopicChangeEvent) => void>();
    const telegramLive: TelegramLiveFeed = {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      subscribeTopicChanges(listener) {
        topicListeners.add(listener);
        return () => topicListeners.delete(listener);
      },
    };
    // Nachrichten mit Anhängen bleiben im Verlauf der Attrappe (Issue #73); ohne Anhänge wie bisher nur live
    const withAttachmentLog = (chat: WebChat): WebChat => ({
      ...chat,
      runTurn(opts) {
        if (opts.attachments?.length && opts.messageId) {
          telegram.recordUserMessage(
            opts.conversationId,
            opts.messageId,
            opts.text,
            opts.receivedAt ?? new Date().toISOString(),
            opts.attachments.map(a => toApiAttachment(opts.conversationId, a))
          );
        }
        return chat.runTurn(opts);
      },
    });
    const server = await createWebServer(config, {
      demo: true,
      dataDir,
      sessionFile: join(dir, "web-sessions.json"),
      chat: deps.chat,
      telegram,
      telegramLive,
      // Schreiben in Topics antwortet in der Demo die Attrappe; nichts geht nach Telegram
      telegramChat: deps.telegramChat ? withAttachmentLog(withDemoAutoTitle(deps.telegramChat, demoTopics, publish)) : undefined,
      // Anhänge (Issue #73): eigene Ablage im temporären Verzeichnis der Demo
      uploads: new UploadStore({ dir: join(dir, "uploads"), log: deps.log }),
      // Topics verwalten (Issue #29) gegen die Attrappe
      topics,
      // Status mit Neustart nur im Speicher (Issue #37)
      status: deps.status ?? createDemoStatus(),
      // Einstellungen nur im Speicher, Modell-Listen ohne Netz (Issue #38)
      settings: deps.settings ?? agents.settings,
      // Motor (Issue #126): Codex verfügbar, „Recherche" weicht ab; nie ein echter Prüfbefehl.
      // Über denselben Einstellungen wie /api/settings, auch wenn sie hereingereicht werden
      engines: deps.engines ?? createDemoEngines(deps.settings?.data ? (deps.settings as SettingsPort & { data(): SettingsData }) : agents.settings),
      // Agenten verwalten nur im Speicher, mit Topics und Einstellungen verbunden (Issue #50)
      agentCatalog: deps.agentCatalog ?? agents.catalog,
      instructions: deps.instructions ?? createDemoInstructions(),
      // /new aus dem Terminal-Chat (Issue #61): keine echte Session, nur der Hinweis
      resetConversation: demoSessionReset,
      models: deps.models ?? createDemoModels(),
      // Download und Vorschau der Beispieldateien (Issue #47)
      files: { source: telegram.files, dir: filesDir } satisfies FilesDeps,
      // Status-Karte eines Ziels im Topic „Strategie" (Issue #76), nur im Speicher
      goals: deps.goals ?? createDemoGoals(),
      // Rückfrage-Knöpfe im Topic „Strategie" (Issue #115), Register nur im Speicher
      choices,
      // Befehlsliste und Rückmeldungen (Issue #77) mit dem echten Register, ohne Wirkung
      commands: deps.commands ?? createDemoCommands(),
      // Schlüssel nur im Speicher, nie die echte .env (Issue #62)
      keys: deps.keys ?? createDemoKeys(),
      uiVersion: deps.uiVersion,
      log: deps.log,
    });
    return {
      server,
      dir,
      filesDir,
      choices,
      receiveNotice(id, source, text, file, choiceId) {
        const event = telegram.receiveNotice(id, source, text, file, choiceId);
        if (!event) return false;
        publish(event);
        return true;
      },
      changeTopic(topicId, fields) {
        telegram.upsertTopic(topicId, fields);
        for (const listener of [...topicListeners]) listener({ conversationId: `topic-${topicId}` });
      },
      receiveTelegram(id, role, text, agent) {
        const event = telegram.receive(id, role, text, agent);
        if (!event) return false;
        publish(event);
        return true;
      },
      async stop() {
        await server.stop();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

/**
 * Befehle der Demo (Issue #77), wie GET /api/commands sie im Bot liefert.
 * Feste Liste, weil web:dev nur aus src/web laden darf; ein Test gleicht sie
 * mit dem echten Register (src/lib/commands) ab.
 */
export const DEMO_COMMANDS: readonly CommandListEntry[] = [
  { name: "help", aliases: ["hilfe"], description: "Spickzettel aller Befehle", args: "none" },
  { name: "stop", aliases: ["abbruch"], description: "Laufende Antwort oder Ziel-Arbeit sofort abbrechen", args: "none" },
  { name: "new", aliases: ["reset"], description: "Gespräch frisch starten, der Verlauf bleibt", args: "none" },
  { name: "topics", aliases: [], description: "Welches Topic welchem Agenten gehört", args: "none" },
  {
    name: "motor",
    aliases: ["engine"],
    description: "Motor dieses Gesprächs zeigen oder wechseln (Claude Code, Codex, OpenCode)",
    args: "optional",
    argsHint: "[claude|codex|opencode|standard]",
  },
  {
    name: "agent",
    aliases: [],
    description: "Agenten anpassen, z.B. /agent research: antworte kuerzer",
    args: "optional",
    argsHint: "[<agent>[: <anweisung>|undo|reset]]",
  },
  {
    name: "goal",
    aliases: [],
    description: "Stehendes Ziel: ich arbeite selbstständig weiter, bis es erreicht ist",
    args: "optional",
    argsHint: "[<ziel>|status|pause|weiter|stop|max <n>|gate add <cmd>|gate list|gate clear]",
  },
  { name: "goals", aliases: [], description: "Gespeicherte Ziele", args: "none" },
  { name: "learn", aliases: [], description: "Quelle in die Knowledge Base destillieren", args: "optional", argsHint: "<URL oder Text>" },
  { name: "plan", aliases: [], description: "Plan-Obergrenze für das Guthaben anzeigen", args: "optional" },
  { name: "critic", aliases: [], description: "Stress-Test einer Idee durch den Critic", args: "required", argsHint: "<idee>" },
  { name: "board", aliases: [], description: "Board-Sitzung: alle Board-Agenten nacheinander, dann die Zusammenfassung", args: "optional", argsHint: "[thema]" },
  { name: "routine", aliases: [], description: "Den hier gezeigten Ablauf als Routine einfrieren", args: "optional", argsHint: "[Hinweis]" },
  { name: "jobs", aliases: [], description: "Hintergrund-Jobs: laufende und zuletzt beendete", args: "none" },
  { name: "voice", aliases: [], description: "Antwort als Sprachnachricht", args: "required", argsHint: "<text>" },
];

/** Befehlsname am Anfang der Nachricht („/New@bot x" → „new"), sonst null */
function demoCommandName(text: string): string | null {
  const m = /^\/([a-z0-9_]+)(?:@\S+)?(?:\s|$)/i.exec(text.trim());
  if (!m) return null;
  const word = m[1].toLowerCase();
  const found = DEMO_COMMANDS.find(c => c.name === word || c.aliases.includes(word));
  return found ? found.name : null;
}

/** Wie COMMAND_TEXT.voiceSent in src/lib/commands/builtin.ts (ein Test gleicht ab) */
export const DEMO_VOICE_SENT_TEXT = "Sprachnachricht in Telegram gesendet.";

/**
 * Befehls-Port für Demo, web:dev und den Browser-Durchlauf (Issue #77):
 * ausgeführt wird nichts. /new antwortet wie nach einem Reset, /board
 * scheitert wie ohne eingerichtete Board-Sitzungen (zeigt den Fehlerkasten),
 * /voice (Issue #78) zeigt eine Antwort und die Meldung wie in einem
 * gespiegelten Gespräch, ohne Audio; alle anderen melden, dass die Demo sie
 * nur nachstellt.
 */
export function createDemoCommands(): CommandPort {
  return {
    list: () => DEMO_COMMANDS.map(c => ({ ...c, aliases: [...c.aliases] })),
    match(text) {
      const name = demoCommandName(text);
      return name ? { name, whileBusy: name === "stop" } : null;
    },
    async run(req) {
      const name = demoCommandName(req.text);
      if (!name) return { failed: COMMANDS_TEXT.failed };
      if (name === "board") return { failed: COMMANDS_TEXT.boardUnavailable };
      if (name === "new") await req.notice("Neue Session gestartet. Der Verlauf bleibt stehen.");
      else if (name === "voice") {
        const args = req.text.trim().replace(/^\/\S+\s*/, "");
        await req.answer(`Demo-Antwort auf „${args}". Im Bot käme sie zusätzlich als Sprachnachricht in Telegram an.`, { agent: req.agent });
        await req.notice(DEMO_VOICE_SENT_TEXT);
      }
      else await req.notice(`/${name} ist in der Demo nur nachgestellt, es passiert nichts.`);
      return {};
    },
  };
}

/**
 * Session-Reset für Demo und web:dev (Issue #61): es gibt keine Claude-
 * Sessions, also ist nie etwas zurückzusetzen.
 */
export const demoSessionReset: ConversationSessionReset = async (_id, whileBlocked) => {
  if (whileBlocked) await whileBlocked();
  return { status: "done", reset: 0, sessionMode: true };
};

/** Effort-Stufen wie EFFORT_LEVELS in src/lib/settings.ts (die Demo importiert src/lib nicht) */
const DEMO_EFFORT_LEVELS = ["low", "medium", "high", "xhigh"] as const;

/**
 * Motoren der Demo (Issue #126), wie SELECTABLE_ENGINES, CODEX_EFFORT_LEVELS,
 * CODEX_SANDBOX_LEVELS in src/lib/settings.ts; ein Test gleicht sie ab.
 */
export const DEMO_ENGINE_OPTIONS = {
  engines: [
    { id: "claude", label: "Claude Code" },
    { id: "codex", label: "Codex" },
    { id: "opencode", label: "OpenCode" },
  ],
  codexEffortLevels: [...DEMO_EFFORT_LEVELS, "max"],
  codexSandboxLevels: ["read-only", "workspace-write", "full"],
  codexDefaultSandbox: "full",
  opencodePermissionLevels: ["ask-deny", "auto"],
  opencodeDefaultPermission: "auto",
} as const;

/** Verfügbarkeit in der Demo: alle Motoren angemeldet, erfundene Versionen */
export const DEMO_ENGINE_AVAILABILITY: EngineAvailability[] = [
  { engine: "claude", label: "Claude Code", installed: true, loggedIn: true, version: "2.1.281" },
  { engine: "codex", label: "Codex", installed: true, loggedIn: true, version: "0.155.1" },
  { engine: "opencode", label: "OpenCode", installed: true, loggedIn: true, version: "1.18.33" },
];

/** Session-Schlüssel des Direktchats der Demo (erfundene Nutzer-ID) */
export const DEMO_DM_SESSION_KEY = "dm:1000000001";
/** Das Topic „Recherche" der Demo läuft mit Codex (Ausnahme wie nach /motor codex) */
export const DEMO_CODEX_TOPIC = "topic-443";
/** Das Topic „Finanzen" der Demo läuft mit OpenCode (Ausnahme wie nach /motor opencode, Issue #129) */
export const DEMO_OPENCODE_TOPIC = "topic-12";

/** Session-Schlüssel wie conversationSessionKey im Bot, für die Demo-Gespräche */
export function demoSessionKey(conversationId: string): string | null {
  if (conversationId === "dm") return DEMO_DM_SESSION_KEY;
  const topic = /^topic-(\d{1,10})$/.exec(conversationId);
  // General kommt wie in Telegram ohne Thread-ID an: group:<chat>
  if (topic) return topic[1] === "1" ? `group:${DEMO_GROUP_ID}` : `topic:${DEMO_GROUP_ID}:${topic[1]}`;
  return /^[A-Za-z0-9-]{1,64}$/.test(conversationId) ? `web:${conversationId}` : null;
}

/** Beispielstand der Einstellungen in der Demo, mit der Codex-Ausnahme für „Recherche" und OpenCode für „Finanzen" */
export const DEMO_SETTINGS: SettingsData = {
  agents: { research: { model: "claude-sonnet-5" }, critic: { effort: "xhigh" } },
  engine: { topics: { [`topic:${DEMO_GROUP_ID}:443`]: "codex", [`topic:${DEMO_GROUP_ID}:12`]: "opencode" } },
};

/**
 * Motor-Attrappe (Issue #126) über den Einstellungen der Demo: Standard und
 * Ausnahmen aus settings.data(), Verfügbarkeit fest. Änderungen erkennt ein
 * Abgleich wie im Bot (createBotEngines), auch nach PATCH /api/settings.
 */
export function createDemoEngines(
  settings: Pick<SettingsPort, "readForWrite" | "write"> & { data(): SettingsData },
  options: { availability?: EngineAvailability[]; watchMs?: number } = {}
): EnginePort {
  const standard = () => {
    const own = settings.data().engine?.default;
    return own ? { engine: own, source: "settings" as const } : { engine: "claude", source: "code" as const };
  };
  const overrides = (): Record<string, string> => ({ ...(settings.data().engine?.topics ?? {}) });
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let last = "";
  const snapshot = () => JSON.stringify({ standard: standard(), overrides: overrides() });
  return {
    engines: DEMO_ENGINE_OPTIONS.engines,
    standard,
    overrides,
    sessionKey: demoSessionKey,
    availability: async () => structuredClone(options.availability ?? DEMO_ENGINE_AVAILABILITY),
    async removeOverride(key) {
      const current = await settings.readForWrite();
      const topics = { ...(current.engine?.topics ?? {}) };
      if (!Object.hasOwn(topics, key)) return false;
      delete topics[key];
      const engine = { ...(current.engine ?? {}) };
      if (Object.keys(topics).length) engine.topics = topics;
      else delete engine.topics;
      const next = { ...current };
      if (Object.keys(engine).length) next.engine = engine;
      else delete next.engine;
      await settings.write(next);
      return true;
    },
    subscribe(listener) {
      if (!listeners.size) {
        last = snapshot();
        timer = setInterval(() => {
          const now = snapshot();
          if (now === last) return;
          last = now;
          for (const l of [...listeners]) l();
        }, options.watchMs ?? 500);
        timer.unref?.();
      }
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
}
/** Voreinstellung der Demo, wenn weder Agent noch Standard etwas setzen */
const DEMO_CODE_DEFAULTS = { model: "claude-opus-5-5", effort: "high" } as const;

/**
 * Einstellungen-Attrappe für web:dev und Demo (Issue #38): nur im Speicher,
 * nie config/settings.json. Beispielstand: Research hat ein eigenes Modell,
 * Critic einen eigenen Effort. Prüft grob wie das Schema (bekannte Agenten,
 * Effort-Stufen, Texte ohne Steuerzeichen).
 */
export function createDemoSettings(
  initial?: SettingsData,
  /** Aktive Agenten (Issue #50: aus dem Demo-Katalog), Standard: FALLBACK_AGENT_NAMES */
  agentNames: () => readonly string[] = () => FALLBACK_AGENT_NAMES
): SettingsPort & { data(): SettingsData } {
  let data: SettingsData = structuredClone(
    initial ?? { agents: { research: { model: "claude-sonnet-5" }, critic: { effort: "xhigh" } } }
  );
  const oneOf = (list: readonly string[]) => `erlaubt: ${list.join(", ")}`;
  const text = (v: unknown) => typeof v === "string" && v.trim().length > 0 && v.length <= 200 && !/\p{Cc}/u.test(v);

  function validate(value: unknown): ValidateResult {
    const issues: { path: string; message: string }[] = [];
    const v = (value ?? {}) as SettingsData;
    const entries: [string, ModelAndEffort | undefined][] = [["defaults", v.defaults]];
    for (const [name, entry] of Object.entries(v.agents ?? {})) {
      // Wie das Schema in src/lib/settings.ts: jede gültige Kennung; aktive Agenten prüft applySettingsPatch
      if (!CATALOG_ID_PATTERN.test(name)) issues.push({ path: `agents.${name}`, message: "ungültige Agenten-Kennung" });
      entries.push([`agents.${name}`, entry]);
    }
    for (const [path, entry] of entries) {
      if (entry?.model !== undefined && !text(entry.model)) issues.push({ path: `${path}.model`, message: "ungültiger Wert" });
      if (entry?.effort !== undefined && !(DEMO_EFFORT_LEVELS as readonly string[]).includes(entry.effort)) {
        issues.push({ path: `${path}.effort`, message: `erlaubt: ${DEMO_EFFORT_LEVELS.join(", ")}` });
      }
    }
    // Motor (Issue #126) grob wie das Schema: bekannte Motoren und Stufen, Modellname ohne Leerzeichen
    const engineIds = DEMO_ENGINE_OPTIONS.engines.map(e => e.id);
    const engine = v.engine;
    if (engine?.default !== undefined && !engineIds.includes(engine.default as never)) {
      issues.push({ path: "engine.default", message: oneOf(engineIds) });
    }
    for (const [key, value] of Object.entries(engine?.topics ?? {})) {
      if (!engineIds.includes(value as never)) issues.push({ path: `engine.topics.${key}`, message: oneOf(engineIds) });
    }
    const codex = engine?.codex;
    if (codex?.model !== undefined && !/^[A-Za-z0-9][\w.:/-]*$/.test(codex.model)) issues.push({ path: "engine.codex.model", message: "ungültiger Modellname" });
    if (codex?.effort !== undefined && !(DEMO_ENGINE_OPTIONS.codexEffortLevels as readonly string[]).includes(codex.effort)) {
      issues.push({ path: "engine.codex.effort", message: oneOf(DEMO_ENGINE_OPTIONS.codexEffortLevels) });
    }
    if (codex?.sandbox !== undefined && !(DEMO_ENGINE_OPTIONS.codexSandboxLevels as readonly string[]).includes(codex.sandbox)) {
      issues.push({ path: "engine.codex.sandbox", message: oneOf(DEMO_ENGINE_OPTIONS.codexSandboxLevels) });
    }
    // OpenCode (Issue #129) wie das Schema: Modell <anbieter>/<modell>, freie Variante mit Prüfung, zwei Rechte-Stufen
    const opencode = engine?.opencode;
    if (opencode?.model !== undefined && !/^[A-Za-z0-9][\w.:/@-]*$/.test(opencode.model)) {
      issues.push({ path: "engine.opencode.model", message: "ungültiger Modellname" });
    }
    if (opencode?.variant !== undefined && !/^[a-z0-9-]{1,20}$/.test(opencode.variant)) {
      issues.push({ path: "engine.opencode.variant", message: "1 bis 20 Zeichen aus a-z, 0-9 und -" });
    }
    if (opencode?.permission !== undefined && !(DEMO_ENGINE_OPTIONS.opencodePermissionLevels as readonly string[]).includes(opencode.permission)) {
      issues.push({ path: "engine.opencode.permission", message: oneOf(DEMO_ENGINE_OPTIONS.opencodePermissionLevels) });
    }
    return issues.length ? { ok: false, issues } : { ok: true, value: v };
  }

  function effective(settings: SettingsData): EffectiveSettings {
    const out: EffectiveSettings["agents"] = {};
    for (const name of agentNames()) {
      const own = settings.agents?.[name];
      const model = own?.model ?? settings.defaults?.model;
      const effort = own?.effort ?? settings.defaults?.effort;
      out[name] = {
        model: model !== undefined ? { value: model, source: "settings" } : { value: DEMO_CODE_DEFAULTS.model, source: "code" },
        effort: effort !== undefined ? { value: effort, source: "settings" } : { value: DEMO_CODE_DEFAULTS.effort, source: "code" },
      };
    }
    return {
      agents: out,
      aux: {
        judge: { value: settings.aux?.judge ?? "claude:claude-opus-5", source: settings.aux?.judge ? "settings" : "code" },
        distill: { value: settings.aux?.distill ?? "claude:claude-haiku-4-5-20251001", source: settings.aux?.distill ? "settings" : "code" },
        review: { value: settings.aux?.review ?? "claude:claude-haiku-4-5-20251001", source: settings.aux?.review ? "settings" : "code" },
      },
      fallback: {
        openrouterModel: { value: settings.fallback?.openrouterModel ?? "minimax/minimax-m2.7", source: settings.fallback?.openrouterModel ? "settings" : "code" },
        ollamaModel: { value: settings.fallback?.ollamaModel ?? "qwen3:8b", source: settings.fallback?.ollamaModel ? "settings" : "code" },
        offlineOnly: { value: settings.fallback?.offlineOnly ?? false, source: settings.fallback?.offlineOnly !== undefined ? "settings" : "code" },
      },
      engine: { default: settings.engine?.default ? { value: settings.engine.default, source: "settings" } : { value: "claude", source: "code" } },
    };
  }

  return {
    get agents() {
      return agentNames();
    },
    effortLevels: DEMO_EFFORT_LEVELS,
    current: () => structuredClone(data),
    readForWrite: async () => structuredClone(data),
    validate,
    write: async value => {
      data = structuredClone(value);
    },
    effective,
    engineOptions: DEMO_ENGINE_OPTIONS,
    data: () => structuredClone(data),
  };
}

/** Anweisungen-Attrappe für web:dev und Demo (Issue #38): nur im Speicher, nie config/agent-overrides.json */
export function createDemoInstructions(
  initial: Record<string, string[]> = { research: ["Antworte kürzer und nenne immer die Quelle."] }
): InstructionsPort {
  const lists = new Map(Object.entries(structuredClone(initial)));
  const list = (agent: string) => lists.get(agent) ?? [];
  // Wie src/lib/agent-overrides.ts: mit unchanged nur, wenn die Liste noch so aussieht
  const assertUnchanged = (agent: string, unchanged?: (list: readonly string[]) => boolean) => {
    if (unchanged && !unchanged(list(agent))) throw new InstructionsChanged();
  };
  return {
    list: agent => [...list(agent)],
    add: async (agent, text) => {
      lists.set(agent, [...list(agent), text]);
      return list(agent).length;
    },
    clear: async (agent, unchanged) => {
      assertUnchanged(agent, unchanged);
      const n = list(agent).length;
      lists.delete(agent);
      return n;
    },
    removeLast: async (agent, unchanged) => {
      assertUnchanged(agent, unchanged);
      const current = list(agent);
      const removed = current.at(-1);
      lists.set(agent, current.slice(0, -1));
      return removed;
    },
  };
}

/** Modell-Listen ohne Netzabruf für web:dev, Demo und Browser-Durchlauf (Issue #38) */
export function createDemoModels(): ModelCatalog {
  return {
    list: async () => ({
      claude: { models: [...CLAUDE_MODELS], custom: true },
      openrouter: { models: [{ id: "minimax/minimax-m2.7", name: "MiniMax M2.7" }] },
      ollama: { models: ["qwen3:8b"] },
      opencode: { models: [...DEMO_OPENCODE_MODELS] },
    }),
  };
}

/** Kleine Liste wie aus `opencode models` für Demo und web:dev (Issue #129), OpenRouter-Kennungen mit weiterem Schrägstrich */
export const DEMO_OPENCODE_MODELS = [
  "openai/gpt-5.5",
  "openrouter/anthropic/claude-opus-5.5",
  "openrouter/moonshotai/kimi-k2",
  "openrouter/openai/gpt-5.5",
] as const;

/** Kurzbeschreibungen der mitgelieferten Agenten in der Demo */
const DEMO_BUILTIN_DESCRIPTIONS: Record<string, string> = {
  general: "General Agent - Standard-Assistent, verteilt an andere Agenten",
  research: "Research Agent - Marktrecherche, Wettbewerb",
  content: "Content Agent (CMO) - Videos, Reichweite",
  finance: "Finance Agent (CFO) - ROI, Stückkosten",
  strategy: "Strategy Agent (CEO) - große Entscheidungen",
  critic: "Critic Agent - Gegenstimme, Stresstest",
  cto: "CTO Agent - Technik, Infrastruktur",
  coo: "COO Agent - Abläufe, Aufgaben",
};
/** Kurznamen wie AGENT_ALIASES in src/agents/names.ts plus die weiteren reservierten aus dem Katalog */
const DEMO_RESERVED = ["researcher", "cmo", "cfo", "ceo", "devils-advocate", "dev", "development", "ops", "operations", "orchestrator", "outreach", "tech"];
const DEMO_BOARD_OFF = new Set(["general"]);

export interface DemoAgentCatalog extends AgentCatalogPort {
  isActive(name: string): boolean;
  names(): string[];
}

/**
 * Agenten-Katalog der Demo und von web:dev (Issue #50): nur im Speicher, nie
 * config/agents.json. Code-Prompts sind kurze Beispieltexte. Löschen stellt
 * die Topics der Telegram-Attrappe auf General um.
 */
export function createDemoAgentCatalog(options: { telegram?: DemoTelegram } = {}): DemoAgentCatalog {
  const builtins = [...FALLBACK_AGENT_NAMES];
  const codePrompt = (name: string) =>
    `Du bist der ${agentLabel(name)}-Agent von ${BRAND.name}.\n\n(Beispiel-Prompt der Demo, nicht der echte aus src/agents/${name}.ts.)`;
  const deleted = new Set<string>();
  const prompts = new Map<string, string>();
  const board = new Map<string, boolean>();
  const custom: { name: string; description: string; systemPrompt: string }[] = [];
  const names = () => [...builtins.filter(n => !deleted.has(n)), ...custom.map(c => c.name)];
  const isActive = (name: string) => names().includes(name);
  const requireActive = (name: string) => {
    if (!isActive(name)) throw new AgentPortError("notFound", "Unbekannter Agent");
  };
  return {
    isActive,
    names,
    list: () =>
      names().map(name => {
        const own = custom.find(c => c.name === name);
        return own
          ? { name, description: own.description, origin: "custom" as const, promptSource: "custom" as const, board: board.get(name) ?? false }
          : {
              name,
              description: DEMO_BUILTIN_DESCRIPTIONS[name] ?? name,
              origin: "builtin" as const,
              promptSource: prompts.has(name) ? ("custom" as const) : ("code" as const),
              board: !DEMO_BOARD_OFF.has(name) && (board.get(name) ?? true),
            };
      }),
    deleted: () => builtins.filter(n => deleted.has(n)).map(name => ({ name, description: DEMO_BUILTIN_DESCRIPTIONS[name] ?? name })),
    prompt(name) {
      if (!isActive(name)) return undefined;
      const own = custom.find(c => c.name === name);
      if (own) return { systemPrompt: own.systemPrompt, codePrompt: null, promptSource: "custom" };
      const override = prompts.get(name);
      return { systemPrompt: override ?? codePrompt(name), codePrompt: codePrompt(name), promptSource: override !== undefined ? "custom" : "code" };
    },
    isNameTaken: name => builtins.includes(name) || DEMO_RESERVED.includes(name) || custom.some(c => c.name === name),
    async topicUsage(): Promise<TopicUsageEntry[]> {
      return (options.telegram?.topicAgents() ?? []).map(t => ({ chatId: DEMO_GROUP_ID, ...t }));
    },
    async setPrompt(name, text) {
      requireActive(name);
      const own = custom.find(c => c.name === name);
      if (own) own.systemPrompt = text;
      else prompts.set(name, text);
    },
    async resetPrompt(name) {
      requireActive(name);
      if (custom.some(c => c.name === name)) throw new AgentPortError("invalid", "Eigene Agenten haben keinen Standard-Prompt");
      prompts.delete(name);
    },
    async create(input) {
      if (builtins.includes(input.name) || DEMO_RESERVED.includes(input.name) || custom.some(c => c.name === input.name)) {
        throw new AgentPortError("taken", "Kennung vergeben");
      }
      custom.push({ ...input });
    },
    async delete(name) {
      requireActive(name);
      if (name === "general") throw new AgentPortError("invalid", "General lässt sich nicht löschen");
      if (builtins.includes(name)) {
        deleted.add(name);
        prompts.delete(name);
      } else {
        custom.splice(custom.findIndex(c => c.name === name), 1);
      }
      board.delete(name);
      const moved: { chatId: string; topicId: number }[] = [];
      for (const t of options.telegram?.topicAgents() ?? []) {
        if (t.agent !== name) continue;
        options.telegram!.upsertTopic(t.topicId, { agent: "general" });
        moved.push({ chatId: DEMO_GROUP_ID, topicId: t.topicId });
      }
      return { topics: moved };
    },
    async restore(name) {
      if (!deleted.has(name)) throw new AgentPortError("notFound", "Kein gelöschter mitgelieferter Agent");
      deleted.delete(name);
    },
    async setBoard(name, on) {
      requireActive(name);
      if (name === "general") throw new AgentPortError("invalid", "General nimmt nicht am Board teil");
      board.set(name, on);
    },
  };
}

export interface DemoAgents {
  topics: DemoTopics;
  catalog: DemoAgentCatalog;
  settings: SettingsPort & { data(): SettingsData };
}

/**
 * Topics, Agenten-Katalog und Einstellungen der Demo und von web:dev als eine
 * veränderliche Einheit im Speicher (Issue #50): Löschen eines Agenten stellt
 * seine Topics um, Einstellungen und Topic-Zuordnung kennen nur aktive Agenten.
 */
export function createDemoAgents(options: Omit<Parameters<typeof createDemoTopics>[0] & {}, "isActiveAgent"> & { settings?: SettingsData } = {}): DemoAgents {
  let catalog: DemoAgentCatalog | null = null;
  const topics = createDemoTopics({ ...options, isActiveAgent: name => catalog?.isActive(name) ?? true });
  catalog = createDemoAgentCatalog({ telegram: topics.telegram });
  const current = catalog;
  return { topics, catalog: current, settings: createDemoSettings(options.settings, () => current.names()) };
}
