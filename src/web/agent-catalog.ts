/**
 * Agenten-API der WebUI (Issue #50, Entscheidung 0007): Agenten-Katalog
 * lesen, System-Prompt setzen und zurücksetzen, eigene Agenten anlegen,
 * Agenten löschen, gelöschte mitgelieferte wiederherstellen, Board-Schalter.
 *
 *   GET    /api/agents                  aktive und gelöschte Agenten, revision
 *   POST   /api/agents                  { name, description, systemPrompt, model?, effort? }
 *   PATCH  /api/agents/<name>           { board }
 *   DELETE /api/agents/<name>           { confirm: "<name>" }
 *   POST   /api/agents/<name>/restore
 *   GET    /api/agents/<name>/prompt
 *   GET    /api/agents/<name>/usage     Topics, die der Agent nutzt (Löschvorschau, Issue #51)
 *   PUT    /api/agents/<name>/prompt    { text }
 *   DELETE /api/agents/<name>/prompt    zurück auf den Code-Stand
 *
 * Der Katalog selbst (config/agents.json, src/agents/catalog.ts) kommt als
 * AgentCatalogPort herein; in bot.ts botAgentCatalog aus
 * ./bot-agents.ts, in web:dev und Demo eine Attrappe im Speicher. Diese
 * Datei importiert nichts aus src/agents oder src/lib.
 *
 * Wie bei den Einstellungen laufen alle Anfragen, auch GET, durch eine
 * Kette: Versionsnummern (revision.ts) werden in der Reihenfolge der Stände
 * vergeben. Die Nummer der Liste umfasst einen Prüfwert jedes Prompts, eine
 * Prompt-Änderung ergibt also auch dann eine neue Nummer, wenn promptSource
 * gleich bleibt. Prompt-Texte gehen nie ins Log, nur Agentennamen.
 */

import { createHash } from "node:crypto";
import { agentLabel, DEFAULT_AGENT } from "./agents";
import { createRevisionClock, type Revision, type RevisionClock } from "./revision";
import { SETTINGS_TEXT, SettingsFileInvalid, type ApiResult, type SettingsApi, type SettingsPort } from "./settings";

/** Kennung eines Agenten, wie AGENT_ID_PATTERN in src/agents/names.ts (Test prüft Gleichheit) */
export const CATALOG_ID_PATTERN = /^[a-z][a-z0-9-]{1,29}$/;
/** Wie PROMPT_MAX und DESCRIPTION_MAX in src/agents/catalog.ts, in UTF-16-Codeeinheiten */
export const PROMPT_MAX_CHARS = 20_000;
export const DESCRIPTION_MAX_CHARS = 200;

/** /api/agents/<name>, /api/agents/<name>/prompt, /api/agents/<name>/restore, /api/agents/<name>/usage */
export const AGENT_ADMIN_PATH = /^\/api\/agents\/([^/]+)(?:\/(prompt|restore|usage))?$/;

export interface CatalogAgentInfo {
  name: string;
  description: string;
  origin: "builtin" | "custom";
  promptSource: "code" | "custom";
  board: boolean;
}

export interface DeletedAgentInfo {
  name: string;
  description: string;
}

/** Zuordnung aus config/topics.json; chatId "*" gilt für alle Chats, agent ist die Kennung */
export interface TopicUsageEntry {
  chatId: string;
  topicId: number;
  agent: string;
}

export interface AgentPrompt {
  /** Wie gespeichert, ohne Laufzeit-Zusätze */
  systemPrompt: string;
  /** Standard aus src/agents/<name>.ts; null bei eigenen Agenten */
  codePrompt: string | null;
  promptSource: "code" | "custom";
}

export type AgentPortErrorKind = "notFound" | "taken" | "invalid" | "fileInvalid" | "topicsInvalid" | "topicsNotMoved";

/** Fehler des Katalogs in der Sprache der WebUI; message ohne Prompt-Texte */
export class AgentPortError extends Error {
  constructor(
    public kind: AgentPortErrorKind,
    message: string
  ) {
    super(message);
    this.name = "AgentPortError";
  }
}

export interface AgentCatalogPort {
  /** Aktive Agenten, General zuerst */
  list(): CatalogAgentInfo[];
  /** Gelöschte mitgelieferte (wiederherstellbar) */
  deleted(): DeletedAgentInfo[];
  /** Prompt eines aktiven Agenten (genaue Kennung), sonst undefined */
  prompt(name: string): AgentPrompt | undefined;
  /** Kennung schon vergeben (Agent, gelöschter mitgelieferter, Alias) */
  isNameTaken(name: string): boolean;
  /** Alle Zuordnungen aus config/topics.json; wirft, wenn unlesbar */
  topicUsage(): Promise<TopicUsageEntry[]>;
  setPrompt(name: string, text: string): Promise<void>;
  resetPrompt(name: string): Promise<void>;
  create(input: { name: string; description: string; systemPrompt: string }): Promise<void>;
  /** Umgestellte Topics; AgentPortError topicsNotMoved, wenn nur das Umstellen scheiterte */
  delete(name: string): Promise<{ topics: { chatId: string; topicId: number }[] }>;
  restore(name: string): Promise<void>;
  setBoard(name: string, on: boolean): Promise<void>;
}

export const AGENTS_TEXT = {
  notConfigured: "Agenten-Katalog ist nicht eingerichtet",
  invalidRequest: "Ungültige Anfrage",
  unknownAgent: "Unbekannter Agent",
  notDeleted: "Dieser Agent ist nicht gelöscht",
  generalDelete: "General lässt sich nicht löschen, Direktchat und nicht zugeordnete Topics brauchen ihn",
  generalBoard: "General leitet das Board und nimmt nicht teil",
  confirmMismatch: "Zum Löschen bitte den Namen des Agenten genau eingeben",
  customReset: "Eigene Agenten haben keinen Standard-Prompt zum Zurücksetzen",
  nameInvalid: "Kennung: a-z, 0-9 und -, 2 bis 30 Zeichen, beginnt mit einem Buchstaben",
  nameTaken: "Diese Kennung ist schon vergeben (Agent, gelöschter Agent oder Kurzname)",
  descriptionInvalid: `Beschreibung: eine Zeile, 1 bis ${DESCRIPTION_MAX_CHARS} Zeichen, ohne Steuerzeichen`,
  promptEmpty: "System-Prompt darf nicht leer sein",
  promptTooLong: `System-Prompt höchstens ${PROMPT_MAX_CHARS.toLocaleString("de-DE")} Zeichen`,
  promptControl: "System-Prompt darf außer Zeilenumbruch und Tab keine Steuerzeichen enthalten",
  boardInvalid: "board muss true oder false sein",
  modelInvalid: "Modell muss Text sein",
  effortInvalid: "Effort muss Text sein",
  catalogInvalid: "config/agents.json ist ungültig. Bitte die Datei reparieren oder aus data/backups wiederherstellen.",
  topicsInvalid: "config/topics.json ist nicht lesbar oder ungültig. Nichts gelöscht.",
  topicsNotMoved:
    "Agent gelöscht, aber seine Topics konnten nicht auf General umgestellt werden. Sie antworten trotzdem über General; bitte config/topics.json prüfen.",
  settingsNotSaved: "Agent angelegt, aber Modell und Effort nicht gespeichert. Bitte in den Einstellungen nachtragen.",
  notSaved: "Agenten-Katalog konnte nicht gespeichert werden",
  // Wie bei /agent: der System-Prompt geht nur beim Session-Start mit
  note: "Gilt ab der nächsten frischen Session des Agenten. In Telegram erzwingt /new im betroffenen Topic das sofort.",
} as const;

/**
 * Prompt wie gespeichert: CRLF wird LF, sonst unverändert. Zeilenumbrüche
 * und Tabs erlaubt, andere Steuerzeichen nicht; Länge in UTF-16-Codeeinheiten
 * wie im Katalog (string.length).
 */
export function normalizePrompt(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: AGENTS_TEXT.promptEmpty };
  const value = raw.replace(/\r\n?/g, "\n");
  if (!value.trim()) return { ok: false, error: AGENTS_TEXT.promptEmpty };
  if (value.length > PROMPT_MAX_CHARS) return { ok: false, error: AGENTS_TEXT.promptTooLong };
  if (/[^\P{Cc}\n\t]/u.test(value)) return { ok: false, error: AGENTS_TEXT.promptControl };
  return { ok: true, value };
}

/** Beschreibung: eine Zeile, außen ohne Leerraum, 1 bis 200 Zeichen; sonst null */
export function normalizeDescription(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim();
  if (!value || value.length > DESCRIPTION_MAX_CHARS || /\p{Cc}/u.test(value)) return null;
  return value;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function parseObject(body: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(body);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function digest(text: string | undefined): string {
  return createHash("sha256").update(text ?? "").digest("hex");
}

/** Optionaler Text für Modell/Effort: fehlt, null oder leer heißt „kein eigener Wert" */
function optionalText(raw: unknown): { ok: true; value: string | undefined } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (typeof raw !== "string") return { ok: false };
  const value = raw.trim();
  return { ok: true, value: value || undefined };
}

export interface AgentsApiDeps {
  port: AgentCatalogPort;
  /** Dieselbe Instanz wie für PATCH /api/settings (dieselbe Schreibkette); ohne sie keine Modelle beim Anlegen */
  settingsApi?: SettingsApi | null;
  settingsPort?: SettingsPort | null;
  log: (message: string) => void;
  clock?: RevisionClock;
}

export interface AgentsApi {
  /** GET /api/agents */
  list(): Promise<ApiResult>;
  /** POST /api/agents */
  create(body: string): Promise<ApiResult>;
  /** Routen unter /api/agents/<name>; action undefined, "prompt", "restore" oder "usage" */
  handle(name: string, action: string | undefined, method: string, body: string): Promise<ApiResult>;
}

/** Erlaubte Methoden je Route (für 405) */
export function agentAdminMethods(action: string | undefined): string {
  if (action === "prompt") return "GET, PUT, DELETE";
  if (action === "restore") return "POST";
  if (action === "usage") return "GET";
  return "PATCH, DELETE";
}

export function createAgentsApi(deps: AgentsApiDeps): AgentsApi {
  const { port, log } = deps;
  const clock = deps.clock ?? createRevisionClock();

  let chain: Promise<unknown> = Promise.resolve();
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = chain.catch(() => {}).then(fn);
    chain = run;
    return run;
  }

  function errorName(e: unknown): string {
    return e instanceof Error ? e.name : typeof e;
  }

  const isActive = (name: string) => port.list().some(a => a.name === name);

  /** Liste mit Topic-Zahlen und Versionsnummer; unlesbare topics.json ergibt topicCount null */
  async function listView(): Promise<Record<string, unknown>> {
    const agents = port.list();
    let usage: TopicUsageEntry[] | null = null;
    try {
      usage = await port.topicUsage();
    } catch (e) {
      log(`Topic-Zuordnung nicht lesbar (${errorName(e)})`);
    }
    const list = agents.map(a => ({
      name: a.name,
      label: agentLabel(a.name),
      description: a.description,
      origin: a.origin,
      promptSource: a.promptSource,
      board: a.board,
      topicCount: usage ? usage.filter(u => u.agent === a.name).length : null,
    }));
    const deleted = port.deleted().map(d => ({ name: d.name, label: agentLabel(d.name), description: d.description }));
    const prompts = agents.map(a => [a.name, digest(port.prompt(a.name)?.systemPrompt)]);
    const topicsUnreadable = usage === null;
    const revision: Revision = clock.stamp("agents", { list, deleted, prompts, topicsUnreadable });
    const defaultAgent = list.some(a => a.name === DEFAULT_AGENT) ? DEFAULT_AGENT : list[0]?.name ?? null;
    return { agents: list, defaultAgent, deleted, topicsUnreadable, revision };
  }

  function promptView(name: string): Record<string, unknown> | null {
    const p = port.prompt(name);
    if (!p) return null;
    const view = { systemPrompt: p.systemPrompt, codePrompt: p.codePrompt, promptSource: p.promptSource };
    return { name, ...view, revision: clock.stamp(`prompt:${name}`, view) };
  }

  /** Fehler des Katalogs als Antwort; unbekannte nur mit Namen ins Log */
  async function failure(e: unknown, what: string): Promise<ApiResult> {
    if (e instanceof AgentPortError) {
      switch (e.kind) {
        case "notFound":
          return { status: 404, body: { error: AGENTS_TEXT.unknownAgent } };
        case "taken":
          return { status: 409, body: { error: AGENTS_TEXT.nameTaken } };
        case "invalid":
          return { status: 400, body: { error: e.message } };
        case "fileInvalid":
          return { status: 409, body: { error: AGENTS_TEXT.catalogInvalid } };
        case "topicsInvalid":
          return { status: 409, body: { error: AGENTS_TEXT.topicsInvalid } };
        case "topicsNotMoved":
          break;
      }
    }
    log(`Agenten-Katalog: ${what} fehlgeschlagen (${errorName(e)})`);
    return { status: 500, body: { error: AGENTS_TEXT.notSaved } };
  }

  async function create(body: string): Promise<ApiResult> {
    const parsed = parseObject(body);
    if (!parsed) return { status: 400, body: { error: AGENTS_TEXT.invalidRequest } };
    const allowed = ["name", "description", "systemPrompt", "model", "effort"];
    if (Object.keys(parsed).some(k => !allowed.includes(k))) return { status: 400, body: { error: AGENTS_TEXT.invalidRequest } };
    const name = parsed.name;
    if (typeof name !== "string" || !CATALOG_ID_PATTERN.test(name)) return { status: 400, body: { error: AGENTS_TEXT.nameInvalid } };
    const description = normalizeDescription(parsed.description);
    if (description === null) return { status: 400, body: { error: AGENTS_TEXT.descriptionInvalid } };
    const prompt = normalizePrompt(parsed.systemPrompt);
    if (!prompt.ok) return { status: 400, body: { error: prompt.error } };
    const model = optionalText(parsed.model);
    if (!model.ok) return { status: 400, body: { error: AGENTS_TEXT.modelInvalid } };
    const effort = optionalText(parsed.effort);
    if (!effort.ok) return { status: 400, body: { error: AGENTS_TEXT.effortInvalid } };
    const wantsSettings = model.value !== undefined || effort.value !== undefined;
    const settingsApi = deps.settingsApi ?? null;
    const settingsPort = deps.settingsPort ?? null;
    if (wantsSettings && (!settingsApi || !settingsPort)) return { status: 503, body: { error: SETTINGS_TEXT.notConfigured } };

    return serialize(async () => {
      if (port.isNameTaken(name)) return { status: 409, body: { error: AGENTS_TEXT.nameTaken } };
      // Modell und Effort vor dem Anlegen prüfen, mit demselben Schema wie beim Laden
      let stale = false;
      if (settingsApi && settingsPort) {
        const entry = { ...(model.value !== undefined ? { model: model.value } : {}), ...(effort.value !== undefined ? { effort: effort.value } : {}) };
        if (wantsSettings) {
          const checked = settingsPort.validate({ agents: { [name]: entry } });
          if (!checked.ok) {
            const prefix = `agents.${name}.`;
            const detail = checked.issues.map(i => `${i.path.startsWith(prefix) ? i.path.slice(prefix.length) : i.path} (${i.message})`).join(", ");
            return { status: 400, body: { error: `Ungültige Einstellungen: ${detail}` } };
          }
        }
        let current;
        try {
          current = await settingsPort.readForWrite();
        } catch (e) {
          if (!(e instanceof SettingsFileInvalid)) throw e;
          // Nur dann ein Hindernis, wenn etwas zu speichern wäre; nichts angelegt
          if (wantsSettings) return { status: 409, body: { error: SETTINGS_TEXT.fileInvalid } };
          current = null;
        }
        // Reste eines früher gelöschten gleichnamigen Agenten sollen nicht wirken
        stale = !!current?.agents?.[name];
      }
      try {
        await port.create({ name, description, systemPrompt: prompt.value });
      } catch (e) {
        return failure(e, "Anlegen");
      }
      log(`Agent angelegt: ${name}`);
      let settingsSaved = true;
      if ((wantsSettings || stale) && settingsApi) {
        // Angegebene Werte setzen; Reste eines früheren gleichnamigen Agenten entfernen
        const entry: Record<string, string | null> = {};
        if (model.value !== undefined) entry.model = model.value;
        else if (stale) entry.model = null;
        if (effort.value !== undefined) entry.effort = effort.value;
        else if (stale) entry.effort = null;
        const patch = { agents: { [name]: entry } };
        let status = 500;
        try {
          status = (await settingsApi.patch(JSON.stringify(patch))).status;
        } catch (e) {
          log(`Einstellungen für ${name} nicht gespeichert (${errorName(e)})`);
        }
        settingsSaved = status === 200;
        if (!settingsSaved) log(`Agent ${name}: Modell und Effort nicht gespeichert (Status ${status})`);
      }
      const body: Record<string, unknown> = { created: name, settingsSaved, ...(await listView()) };
      if (!settingsSaved) body.warning = AGENTS_TEXT.settingsNotSaved;
      return { status: 201, body };
    });
  }

  async function remove(name: string, body: string): Promise<ApiResult> {
    if (name === DEFAULT_AGENT) return { status: 409, body: { error: AGENTS_TEXT.generalDelete } };
    const parsed = parseObject(body);
    return serialize(async () => {
      if (!isActive(name)) return { status: 404, body: { error: AGENTS_TEXT.unknownAgent } };
      if (!parsed || parsed.confirm !== name) return { status: 400, body: { error: AGENTS_TEXT.confirmMismatch } };
      let moved: { chatId: string; topicId: number }[];
      try {
        moved = (await port.delete(name)).topics;
      } catch (e) {
        if (e instanceof AgentPortError && e.kind === "topicsNotMoved") {
          log(`Agent gelöscht: ${name}, Topics nicht umgestellt`);
          return { status: 500, body: { error: AGENTS_TEXT.topicsNotMoved, removed: name, topicsMoved: false, moved: [], ...(await listView()) } };
        }
        return failure(e, "Löschen");
      }
      log(`Agent gelöscht: ${name}, ${moved.length} Topic(s) auf General umgestellt`);
      return { status: 200, body: { removed: name, topicsMoved: true, moved, ...(await listView()) } };
    });
  }

  async function restore(name: string): Promise<ApiResult> {
    return serialize(async () => {
      if (isActive(name)) return { status: 409, body: { error: AGENTS_TEXT.notDeleted } };
      if (!port.deleted().some(d => d.name === name)) return { status: 404, body: { error: AGENTS_TEXT.unknownAgent } };
      try {
        await port.restore(name);
      } catch (e) {
        return failure(e, "Wiederherstellen");
      }
      log(`Agent wiederhergestellt: ${name}`);
      return { status: 200, body: { restored: name, ...(await listView()) } };
    });
  }

  /**
   * Löschvorschau (Issue #51): alle Zuordnungen des Agenten über alle Chats,
   * samt "*" (gilt für alle Chats). Unlesbare topics.json ergibt 409 wie beim
   * Löschen selbst, damit die Seite nie eine unvollständige Liste nennt.
   */
  async function usage(name: string): Promise<ApiResult> {
    return serialize(async () => {
      if (!isActive(name)) return { status: 404, body: { error: AGENTS_TEXT.unknownAgent } };
      let entries: TopicUsageEntry[];
      try {
        entries = await port.topicUsage();
      } catch (e) {
        log(`Topic-Zuordnung nicht lesbar (${errorName(e)})`);
        return { status: 409, body: { error: AGENTS_TEXT.topicsInvalid } };
      }
      const topics = entries
        .filter(u => u.agent === name)
        .map(u => ({ chatId: u.chatId, topicId: u.topicId }))
        .sort((a, b) => Number(b.chatId === "*") - Number(a.chatId === "*") || a.chatId.localeCompare(b.chatId) || a.topicId - b.topicId);
      return { status: 200, body: { name, topics, revision: clock.stamp(`usage:${name}`, topics) } };
    });
  }

  async function patch(name: string, body: string): Promise<ApiResult> {
    const parsed = parseObject(body);
    if (!parsed || Object.keys(parsed).length !== 1 || !("board" in parsed)) return { status: 400, body: { error: AGENTS_TEXT.invalidRequest } };
    if (typeof parsed.board !== "boolean") return { status: 400, body: { error: AGENTS_TEXT.boardInvalid } };
    const on = parsed.board;
    if (name === DEFAULT_AGENT) return { status: 409, body: { error: AGENTS_TEXT.generalBoard } };
    return serialize(async () => {
      if (!isActive(name)) return { status: 404, body: { error: AGENTS_TEXT.unknownAgent } };
      try {
        await port.setBoard(name, on);
      } catch (e) {
        return failure(e, "Board-Schalter");
      }
      log(`Agent ${name}: Board ${on ? "an" : "aus"}`);
      return { status: 200, body: await listView() };
    });
  }

  async function prompt(name: string, method: string, body: string): Promise<ApiResult> {
    if (method === "GET") {
      return serialize(async () => {
        const view = promptView(name);
        return view ? { status: 200, body: view } : { status: 404, body: { error: AGENTS_TEXT.unknownAgent } };
      });
    }
    if (method === "PUT") {
      const parsed = parseObject(body);
      if (!parsed) return { status: 400, body: { error: AGENTS_TEXT.invalidRequest } };
      const text = normalizePrompt(parsed.text);
      return serialize(async () => {
        if (!isActive(name)) return { status: 404, body: { error: AGENTS_TEXT.unknownAgent } };
        if (!text.ok) return { status: 400, body: { error: text.error } };
        try {
          await port.setPrompt(name, text.value);
        } catch (e) {
          return failure(e, "Prompt speichern");
        }
        // Nur Name und Länge, nie der Text
        log(`System-Prompt geändert: ${name} (${text.value.length} Zeichen)`);
        return { status: 200, body: { ...promptView(name)!, note: AGENTS_TEXT.note } };
      });
    }
    // DELETE: zurück auf den Stand aus dem Code
    return serialize(async () => {
      const current = port.prompt(name);
      if (!current) return { status: 404, body: { error: AGENTS_TEXT.unknownAgent } };
      if (current.codePrompt === null) return { status: 409, body: { error: AGENTS_TEXT.customReset } };
      try {
        await port.resetPrompt(name);
      } catch (e) {
        return failure(e, "Prompt zurücksetzen");
      }
      log(`System-Prompt zurückgesetzt: ${name}`);
      return { status: 200, body: { ...promptView(name)!, note: AGENTS_TEXT.note } };
    });
  }

  return {
    list: () => serialize(async () => ({ status: 200, body: await listView() })),
    create,
    async handle(name, action, method, body) {
      if (!CATALOG_ID_PATTERN.test(name)) return { status: 404, body: { error: AGENTS_TEXT.unknownAgent } };
      if (action === "prompt") return prompt(name, method, body);
      if (action === "restore") return restore(name);
      if (action === "usage") return usage(name);
      if (method === "PATCH") return patch(name, body);
      return remove(name, body);
    },
  };
}
