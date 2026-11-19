/**
 * Motor in der WebUI (Issue #126, Entscheidung 0018): GET /api/engines und
 * POST /api/engines/reset und POST /api/engines/check (M14-05).
 *
 * Diese Datei importiert nichts aus src/lib; src/bot.ts übergibt die echten
 * Quellen als EnginePort (src/web/bot-engines.ts), Tests und Demo reichen
 * Attrappen herein. Die Verfügbarkeit (installiert, angemeldet, Version)
 * kommt nur über den Port, in Tests und Demo nie aus einem echten Befehl.
 *
 * Datenverträge:
 * - Standard wie defaultEngineSetting (Einstellungsdatei, TYBO_ENGINE, Claude Code).
 * - Ausnahmen stehen in engine.topics unter dem Session-Schlüssel
 *   (topic:<chat>:<topic>, dm:<chat>, web:<id>), nicht unter der ID der WebUI.
 *   sessionKey() bildet eine Gesprächs-ID der WebUI darauf ab wie beim
 *   Schreiben; eine Ausnahme ohne passendes Gespräch (Topic gelöscht, andere
 *   Gruppe) steht in der Liste als „nicht mehr zuzuordnen" und lässt sich
 *   trotzdem entfernen.
 * - „Auf Standard" entfernt genau diesen einen Eintrag. Gehört er zu einem
 *   Gespräch der WebUI, läuft das wie /motor standard: unter der Sperre des
 *   Gesprächs, die Session endet, eine laufende Antwort ergibt 409.
 *   Eine Übergabenotiz entsteht vor dem Löschen und bleibt bis zur neuen Session.
 *   Ob der Eintrag dazugehört, folgt aus dem Schlüssel selbst (Kandidat, bestätigt über
 *   sessionKey()), nie aus der Gesprächsliste: die dient nur den Titeln.
 *   Lässt sich der Schlüssel des Kandidaten nicht bilden (null oder Fehler,
 *   etwa Gruppe gerade nicht lesbar) oder der Session-Reset keine Session
 *   ermitteln, bleibt alles unverändert (503): das beweist nicht, dass keine
 *   Antwort läuft.
 */

import { createRevisionClock, type RevisionClock } from "./revision";
import type { ApiResult } from "./settings";
import type { ConversationSessionResetOptions } from "./session-reset";

export type EngineDefaultSource = "settings" | "env" | "code";

type EngineMeasurementResults = Record<"claude" | "codex" | "opencode" | "api", "measured" | "failed" | "not-measurable">;

/** Verfügbarkeit eines Motors für die Anzeige */
export interface EngineAvailability {
  engine: string;
  label: string;
  installed: boolean;
  /** null: installiert, aber nicht feststellbar, ob angemeldet */
  loggedIn: boolean | null;
  version?: string;
  /** Verständlicher Hinweis, wenn der Motor nicht bereit ist */
  message?: string;
}

export interface EngineBlockView {
  engine: string;
  cause: "threshold" | "limit" | "outage";
  since: string;
  until: string;
  resetKnown: boolean;
  window?: string;
  family?: string;
  model?: string;
  percent?: number;
}

export type EngineStageView = { id: string; engine: string; label: string; model?: string | null } & (
  | { state: "answering" | "free" | "not_ready" }
  | { state: "blocked"; blockedUntil: string; cause: EngineBlockView["cause"]; window?: string; resetKnown: boolean }
);
export type EngineUsageView = { id: string; measuredAt: string; source: string } & (
  | { state: "known"; percent: number; resetsAt?: string }
  | { state: "expired"; resetsAt: string }
);
export interface EngineSwitchView {
  order: EngineStageView[];
  auto: { enabled: boolean; threshold: number; returnBelow: number };
  usage: Readonly<Record<string, readonly EngineUsageView[]>>;
  blocks: readonly EngineBlockView[];
}

/** Nächste Antwort eines Gesprächs; keine internen Stufen oder Messlisten. */
export interface ConversationEngineStage {
  engine: string | null;
  label: string | null;
  model?: string;
  role: "first" | "backup" | "manual" | "none";
  reason?: {
    label: string;
    kind: "threshold" | "limit" | "outage" | "not_ready";
    window?: string;
    percent?: number;
    until?: string;
    resetKnown?: boolean;
    message?: string;
  };
  until?: string;
}

export type ConversationEngineChoice = { engine: string; label: string; model?: string } & (
  | { state: "answering" | "free" }
  | { state: "blocked"; blockedUntil: string; cause: EngineBlockView["cause"]; window?: string; resetKnown: boolean }
  | { state: "not_ready"; installed: boolean; message?: string }
);

export interface ConversationEngineSnapshot {
  default: string;
  timeZone: string;
  engines: Record<string, string>;
  /** Darf nach der Antwort fertig werden; der Server begrenzt die Wartezeit. */
  stages: Promise<Record<string, ConversationEngineStage>>;
  /** Teilt Prüfungen und Zustand mit stages, scheitert unabhängig davon. */
  choices?: Promise<Record<string, ConversationEngineChoice[]>>;
}

/** Die erste Ansicht wartet höchstens so lange auf einen kalten Prüf-Cache. */
export const ENGINE_PREVIEW_WAIT_MS = 200;

export interface EnginePort {
  /** Eine gemeinsame, nur lesende Vorschau für die ganze Gesprächsliste. */
  conversationSnapshot?(conversations: readonly { id: string; agent: string }[]): ConversationEngineSnapshot;
  /** Vor dem Löschen unter der Gesprächssperre die Herkunft des Motorwechsels festhalten. */
  noteHandover?(sessionKey: string): Promise<void>;
  /** Wählbare Motoren mit Anzeigenamen, Claude Code zuerst */
  engines: readonly { id: string; label: string }[];
  /** Standard-Motor ohne Ausnahme, mit Quelle */
  standard(): { engine: string; source: EngineDefaultSource };
  /** Modell für General je Motor; null heißt eigene Konfiguration des Motors. */
  resolvedModels(): Record<string, string | null>;
  /** Dieselbe Zeitzone wie /motor (USER_TIMEZONE, sonst UTC). */
  timeZone(): string;
  /** Ausnahmen aus engine.topics: Session-Schlüssel zu Motor */
  overrides(): Record<string, string>;
  /** Nur gesetzte Motoren der Agenten aus agents.<id>.engine. */
  agentEngines(): Record<string, string>;
  /** Session-Schlüssel eines Gesprächs der WebUI wie beim Schreiben; null, wenn keiner ermittelbar */
  sessionKey(conversationId: string): string | null;
  /** Installiert, angemeldet, Version je Motor */
  availability(): Promise<EngineAvailability[]>;
  /** Reihenfolge und Zustand mit genau derselben Bereitschaft wie availability. */
  switchStatus(availability: readonly EngineAvailability[]): Promise<EngineSwitchView>;
  /** Prüfung von Hand; gemeinsame Kernfunktion in src/lib, keine Chat-Turns. */
  check(): Promise<{ notMeasured: readonly string[]; measurementResults?: EngineMeasurementResults }>;
  /**
   * Entfernt die Ausnahme, wenn sie noch besteht, in der Schreibkette der
   * Einstellungen; true, wenn ein Eintrag entfernt wurde. Wirft bei
   * ungültiger Datei oder Schreibfehler.
   */
  removeOverride(sessionKey: string): Promise<boolean>;
  /**
   * Meldet Änderungen an Standard, Agentenmotoren, Ausnahmen, Sperren und sichtbaren Messwerten, gleich woher (/motor aus
   * Telegram, Browser, Terminal, Einstellungsseite, Hand). Gibt die
   * Abmeldung zurück.
   */
  subscribe?(listener: () => void): () => void;
}

/** Gespräch der WebUI mit Anzeigename */
export interface EngineConversation {
  id: string;
  title: string;
}

/** Ausnahme eines Gesprächs für die Einstellungsseite */
export interface EngineOverrideView {
  key: string;
  engine: string;
  label: string;
  /** Gesprächs-ID der WebUI; null, wenn keins mehr passt */
  conversationId: string | null;
  title: string | null;
}

/** unavailable: Session des Gesprächs nicht ermittelbar, nichts geschrieben */
export type EngineResetOutcome = "done" | "busy" | "closing" | "unavailable";

export interface EnginesApiDeps {
  /** Alle Gespräche der WebUI (Direktchat, Topics, ältere Web-Gespräche) */
  conversations(): Promise<EngineConversation[]>;
  /**
   * Ausnahme eines Gesprächs der WebUI entfernen wie /motor standard (Sperre,
   * Session-Ende); write schreibt die Einstellung, nur bei done. Fehlt, wird direkt geschrieben.
   */
  resetConversation?(conversationId: string, options: ConversationSessionResetOptions): Promise<EngineResetOutcome>;
}

export const ENGINE_TEXT = {
  notConfigured: "Die Motor-Wahl ist nicht eingerichtet",
  invalidRequest: "Ungültige Anfrage",
  gone: "Diese Ausnahme gibt es nicht mehr.",
  busy: "In diesem Gespräch läuft gerade eine Antwort. Erst stoppen, dann auf Standard stellen.",
  closing: "Die WebUI wird gerade beendet",
  notSaved: "Der Motor konnte nicht zurückgesetzt werden",
  unassignable: "Das Gespräch dieser Ausnahme lässt sich gerade nicht zuordnen, nichts geändert. Bitte später noch einmal versuchen.",
  fileInvalid: "config/settings.json ist ungültig, nichts geändert. Bitte die Datei reparieren oder löschen.",
  availabilityFailed: "Verfügbarkeit nicht ermittelbar",
} as const;

/** Wie CONVERSATION_KEY_PATTERN in src/lib/settings.ts */
const SESSION_KEY_PATTERN = /^(topic:-?\d{1,20}:\d{1,12}|group:-\d{1,20}|dm:(?:-?\d{1,20}|web)|web:[A-Za-z0-9-]{1,64})$/;

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

/**
 * Gesprächs-ID der WebUI, zu der ein Session-Schlüssel gehören kann
 * (dm:<chat> zum Direktchat, group:<chat> zu General, topic:<chat>:<n> zum
 * Topic, web:<id> zum Web-Gespräch). Nur ein Kandidat: ob er wirklich passt,
 * entscheidet port.sessionKey.
 */
function candidateConversationId(key: string): string | null {
  if (key.startsWith("dm:")) return "dm";
  if (key.startsWith("group:")) return "topic-1";
  const topic = /^topic:-?\d{1,20}:(\d{1,12})$/.exec(key);
  if (topic) return `topic-${topic[1]}`;
  if (key.startsWith("web:")) return key.slice("web:".length);
  return null;
}

/** Anzeigename eines Motors, sonst die Kennung */
export function engineLabelOf(port: Pick<EnginePort, "engines">, id: string): string {
  return port.engines.find(e => e.id === id)?.label ?? id;
}

/**
 * Eingestellter Motor je Gespräch: Gespräch, Agent, Standard wie
 * configuredEngine in src/lib/engine-choice.ts. Ohne Schlüssel entfällt nur die Gesprächswahl.
 */
export function conversationEngines(port: Pick<EnginePort, "standard" | "overrides" | "sessionKey" | "agentEngines">, conversations: readonly { id: string; agent: string }[]): Record<string, string> {
  const standard = port.standard().engine;
  const overrides = port.overrides();
  const agents = port.agentEngines();
  const out: Record<string, string> = {};
  for (const { id, agent } of conversations) {
    let key: string | null = null;
    try {
      key = port.sessionKey(id);
    } catch {
      key = null;
    }
    out[id] = (key && Object.hasOwn(overrides, key) ? overrides[key] : undefined) ?? agents[agent] ?? standard;
  }
  return out;
}

/** Nur fest bekannte Hinweise; fremde Prüfausgaben können Pfade und Schlüssel tragen. */
export function cleanEngineMessage(a: Pick<EngineAvailability, "label" | "message" | "installed" | "loggedIn">): string | undefined {
  if (!a.message) return undefined;
  // Wie die festen Meldungen in src/lib/engines/check.ts; API-Tests vergleichen die Originalkonstanten.
  const known = [
    `${a.label} ist nicht installiert`, `${a.label} ließ sich nicht prüfen`,
    "Codex ist nicht installiert: der Befehl codex wurde nicht gefunden (anderer Pfad über CODEX_PATH in .env)",
    "Claude Code ist nicht installiert: der Befehl claude wurde nicht gefunden (anderer Pfad über CLAUDE_PATH in .env)",
    "OpenCode ist nicht installiert: der Befehl opencode wurde nicht gefunden (anderer Pfad über OPENCODE_PATH in .env)",
    "Codex ist nicht angemeldet: im Terminal `codex login` ausführen",
    "Claude Code ist nicht angemeldet: im Terminal `claude` starten und /login ausführen",
    "OpenCode ist nicht angemeldet: im Terminal `opencode auth login` ausführen",
    "OpenCode ist nicht angemeldet: im Terminal `opencode auth login -p openrouter` ausführen",
    "Für den Motor api fehlt ANTHROPIC_API_KEY in der .env (Schlüssel aus console.anthropic.com)",
    "Claude Code soll mit eigenem API-Schlüssel laufen (CLAUDE_AUTH=apiKey), aber ANTHROPIC_API_KEY fehlt in der .env. Schlüssel eintragen oder CLAUDE_AUTH=subscription setzen",
    "Ob Claude Code angemeldet ist, ließ sich nicht feststellen (im Terminal `claude auth status`)",
    "Version von OpenCode nicht erkennbar (opencode --version)",
    "Codex-Anmeldung nicht prüfbar: codex login status ließ sich nicht starten",
    "OpenCode-Anmeldung nicht prüfbar: opencode auth list ließ sich nicht starten",
    "OpenCode-Anmeldung nicht prüfbar: Ausgabe von opencode auth list nicht erkennbar",
  ];
  if (known.includes(a.message)) return a.message;
  // Variable Teile sind ausschließlich Sekunden, Exit-Codes, Startfehlercodes und Versionsnummern.
  const patterns = [
    /^(?:Codex antwortet nicht: codex|Claude Code antwortet nicht: claude|OpenCode antwortet nicht: opencode) --version brauchte länger als \d+ s$/,
    /^(?:Codex startet nicht: codex|Claude Code startet nicht: claude|OpenCode startet nicht: opencode) --version endete mit Exit-Code (?:-?\d+|null)$/,
    /^(?:Codex-Anmeldung nicht prüfbar: codex login status|OpenCode-Anmeldung nicht prüfbar: opencode auth list) brauchte länger als \d+ s$/,
    /^OpenCode-Anmeldung nicht prüfbar: opencode auth list endete mit Exit-Code (?:-?\d+|null)$/,
    /^Claude Code ließ sich nicht starten \((?:[A-Z][A-Z0-9_]{0,31}|unbekannter Fehler)\): claude --version, später erneut prüfen$/,
    /^OpenCode \d+ wird noch nicht unterstützt \(gefunden: \d+(?:\.\d+){1,2}\); tybo braucht OpenCode 1 \(npm i -g opencode-ai@1\)$/,
  ];
  if (a.message.length <= 300 && patterns.some(pattern => pattern.test(a.message!))) return a.message;
  return a.loggedIn === null ? "Anmeldung ließ sich nicht prüfen"
    : !a.installed ? "Motor ließ sich nicht prüfen" : !a.loggedIn ? "Motor ist nicht angemeldet" : undefined;
}

/** Nur die Felder, die die Anzeige braucht, ohne rohe Ausgaben. */
function cleanAvailability(list: EngineAvailability[]): EngineAvailability[] {
  return list.map(a => ({
    engine: String(a.engine),
    label: String(a.label),
    installed: a.installed === true,
    loggedIn: a.loggedIn === true ? true : a.loggedIn === false ? false : null,
    ...(typeof a.version === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(a.version) ? { version: a.version } : {}),
    ...(cleanEngineMessage(a) ? { message: cleanEngineMessage(a) } : {}),
  }));
}

export interface EnginesApi {
  get(): Promise<ApiResult>;
  check(): Promise<ApiResult>;
  reset(body: string): Promise<ApiResult>;
}

export function createEnginesApi(
  port: EnginePort,
  deps: EnginesApiDeps,
  log: (message: string) => void,
  clock: RevisionClock = createRevisionClock()
): EnginesApi {
  async function overrideViews(): Promise<EngineOverrideView[]> {
    let conversations: EngineConversation[] = [];
    try {
      conversations = await deps.conversations();
    } catch (e) {
      log(`Motor: Gespräche nicht lesbar (${errorName(e)})`);
    }
    const byKey = new Map<string, EngineConversation>();
    for (const c of conversations) {
      let key: string | null = null;
      try {
        key = port.sessionKey(c.id);
      } catch {
        key = null;
      }
      if (key && !byKey.has(key)) byKey.set(key, c);
    }
    return Object.entries(port.overrides())
      .map(([key, engine]) => {
        const c = byKey.get(key);
        return { key, engine, label: engineLabelOf(port, engine), conversationId: c?.id ?? null, title: c?.title ?? null };
      })
      .sort((a, b) => Number(a.conversationId === null) - Number(b.conversationId === null) || (a.title ?? a.key).localeCompare(b.title ?? b.key, "de"));
  }

  async function view(): Promise<Record<string, unknown>> {
    const [overrides, availability] = await Promise.all([
      overrideViews(),
      port.availability().then(cleanAvailability, e => {
        log(`Motor: Verfügbarkeit nicht ermittelbar (${errorName(e)})`);
        return null;
      }),
    ]);
    const standard = port.standard();
    const switching = await port.switchStatus(availability ?? []);
    const content = {
      default: { engine: standard.engine, source: standard.source },
      engines: port.engines.map(e => ({ id: e.id, label: e.label })),
      overrides,
      availability,
      resolvedModels: port.resolvedModels(),
      agentEngines: port.agentEngines(),
      timeZone: port.timeZone(),
      ...switching,
    };
    return { ...content, revision: clock.stamp("engines", content) };
  }

  return {
    async get() {
      return { status: 200, body: await view() };
    },

    async check() {
      const result = await port.check();
      return { status: 200, body: { ...(await view()), notMeasured: result.notMeasured,
        ...(result.measurementResults ? { measurementResults: result.measurementResults } : {}) } };
    },

    async reset(body) {
      let key: unknown;
      try {
        key = JSON.parse(body)?.key;
      } catch {
        return { status: 400, body: { error: ENGINE_TEXT.invalidRequest } };
      }
      if (typeof key !== "string" || !SESSION_KEY_PATTERN.test(key)) return { status: 400, body: { error: ENGINE_TEXT.invalidRequest } };
      const sessionKey = key;
      if (!Object.hasOwn(port.overrides(), sessionKey)) return { status: 404, body: { error: ENGINE_TEXT.gone, ...(await view()) } };
      // Zuordnung aus dem Schlüssel selbst, nicht aus der Gesprächsliste: eine
      // fehlende oder unvollständige Liste beweist nicht, dass keine Session läuft.
      // Nicht feststellbar (Schlüssel null oder Fehler beim Bilden): nichts ändern,
      // denn null beweist nicht, dass unter dem Schlüssel keine Antwort läuft
      const candidate = candidateConversationId(sessionKey);
      let conversation: string | null = null;
      if (candidate) {
        let candidateKey: string | null;
        try {
          candidateKey = port.sessionKey(candidate);
        } catch (e) {
          log(`Motor-Ausnahme nicht entfernt, Gespräch nicht zuzuordnen (${errorName(e)})`);
          return { status: 503, body: { error: ENGINE_TEXT.unassignable } };
        }
        if (candidateKey === null) {
          log("Motor-Ausnahme nicht entfernt, Gespräch nicht zuzuordnen (kein Schlüssel)");
          return { status: 503, body: { error: ENGINE_TEXT.unassignable } };
        }
        if (candidateKey === sessionKey) conversation = candidate;
      }
      let removed = false;
      const write = async () => {
        removed = await port.removeOverride(sessionKey);
      };
      try {
        if (conversation && deps.resetConversation) {
          const outcome = await deps.resetConversation(conversation, {
            whileBlocked: write,
            beforeReset: () => port.noteHandover?.(sessionKey) ?? Promise.resolve(),
            preserveHandover: true,
          });
          if (outcome === "busy") return { status: 409, body: { error: ENGINE_TEXT.busy } };
          if (outcome === "closing") return { status: 503, body: { error: ENGINE_TEXT.closing } };
          if (outcome === "unavailable") {
            log("Motor-Ausnahme nicht entfernt, keine Session des Gesprächs ermittelbar");
            return { status: 503, body: { error: ENGINE_TEXT.unassignable } };
          }
        } else {
          await write();
        }
      } catch (e) {
        log(`Motor-Ausnahme nicht entfernt (${errorName(e)})`);
        if (errorName(e) === "SettingsFileInvalidError") return { status: 409, body: { error: ENGINE_TEXT.fileInvalid } };
        return { status: 500, body: { error: ENGINE_TEXT.notSaved } };
      }
      if (!removed) return { status: 404, body: { error: ENGINE_TEXT.gone, ...(await view()) } };
      // Nur, dass etwas entfernt wurde, nie der Schlüssel
      log(`Motor-Ausnahme eines Gesprächs entfernt (${conversation ? "Gespräch der WebUI" : "nicht zuzuordnen"})`);
      return { status: 200, body: await view() };
    },
  };
}
