/**
 * Status-API der WebUI (Issue #37): GET /api/status und POST /api/restart.
 *
 * Diese Datei importiert nichts aus src/lib; src/bot.ts übergibt die echten
 * Quellen als StatusPort (src/web/bot-status.ts), Tests, web:dev und Demo
 * reichen Attrappen herein. Schlüssel erscheinen nur als Name und
 * set: true/false, nie mit Wert oder Teilen davon (auch nicht den letzten
 * vier Zeichen, die kommen erst mit M6).
 *
 * Neustart nur per Knopf (Entscheidung A in SPEC.md): Der Marker
 * data/restart-requested wird erst geschrieben, wenn ein Supervisor
 * (launchd, PM2 oder systemd) erkannt ist. Der Bot startet dann nach der laufenden
 * Antwort neu (src/lib/restart-request.ts).
 */

import { BRAND } from "../brand";
import type { EngineAvailability } from "./engines";
import type { ApiResult } from "./settings";

export type Supervisor = "launchd" | "pm2" | "systemd";
export type StorageBackend = "convex" | "supabase" | "none";
/** Semantische Suche (Issue #166): „aktiv“ nur nach bestandenem Nachweis */
export type SemanticSearchState = "aktiv" | "textsuche";

/**
 * Bekannte Schlüssel, die die Statusseite als gesetzt/nicht gesetzt zeigt.
 * Nur Namen aus dieser Liste werden je nachgesehen; ein Test prüft, dass die
 * Agentenbots mit AGENT_TOKEN_MAP in src/lib/bot-registry.ts übereinstimmen.
 */
export const STATUS_KEY_GROUPS: ReadonlyArray<{ group: string; names: readonly string[] }> = [
  { group: "Anthropic", names: ["ANTHROPIC_API_KEY"] },
  { group: "OpenRouter", names: ["OPENROUTER_API_KEY"] },
  { group: "OpenAI", names: ["OPENAI_API_KEY"] },
  { group: "Gemini", names: ["GEMINI_API_KEY"] },
  { group: "ElevenLabs", names: ["ELEVENLABS_API_KEY"] },
  { group: "xAI", names: ["XAI_API_KEY"] },
  { group: "Google", names: ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"] },
  { group: "Notion", names: ["NOTION_TOKEN"] },
  { group: "Supabase", names: ["SUPABASE_URL", "SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"] },
  {
    group: "Telegram-Agentenbots",
    names: [
      "TELEGRAM_BOT_TOKEN_RESEARCH",
      "TELEGRAM_BOT_TOKEN_CONTENT",
      "TELEGRAM_BOT_TOKEN_FINANCE",
      "TELEGRAM_BOT_TOKEN_STRATEGY",
      "TELEGRAM_BOT_TOKEN_CRITIC",
      "TELEGRAM_BOT_TOKEN_CTO",
      "TELEGRAM_BOT_TOKEN_COO",
    ],
  },
];

export interface KeyStatus {
  name: string;
  group: string;
  set: boolean;
}

type Env = Record<string, string | undefined>;

/** Nur ja/nein: gesetzt heißt nicht leer und nicht nur Leerzeichen. Werte verlassen diese Funktion nie. */
export function keyStatus(env: Env): KeyStatus[] {
  const out: KeyStatus[] = [];
  for (const { group, names } of STATUS_KEY_GROUPS) {
    for (const name of names) out.push({ name, group, set: (env[name] ?? "").trim() !== "" });
  }
  return out;
}

/**
 * Exakt wie getBackend() in src/lib/convex.ts: Konfiguration, nicht
 * Erreichbarkeit, Convex vor Supabase. Bewusst ohne trim(): eine URL aus
 * Leerzeichen wählt dort ebenfalls das Backend, der Status zeigt dasselbe.
 */
export function storageBackend(env: Env): StorageBackend {
  if (env.CONVEX_URL) return "convex";
  if (env.SUPABASE_URL) return "supabase";
  return "none";
}

/** Ein Eintrag aus data/sessions.json (BotSession in src/lib/session-manager.ts), nur die nötigen Felder */
export interface StoredSession {
  /** "{Session-Schlüssel}:{Agent}" (BotSession.key) */
  key?: string;
  agentName: string;
  /** Motor der Session (BotSession.engine), etwa "claude" */
  engine: string;
  engineSessionId?: string;
  model: string;
  lastActivity: number;
}

export interface ResumableOptions {
  /** SESSION_MODE=resume; sonst wird nie fortgesetzt */
  sessionMode: boolean;
  /** SESSION_IDLE_HOURS in Millisekunden */
  idleMs: number;
  /** Aktuelles Modell des Agenten für diesen Motor, wie chat-turn.ts es für getResumableSession nutzt */
  modelFor(agentName: string, engine: string): string;
  /** Motor, mit dem der nächste Turn des Agenten in diesem Gespräch liefe (Issues #122, #125) */
  engineFor(agentName: string, sessionKey?: string): string;
  now: number;
}

/**
 * Fortsetzbar sind Einträge, die getResumableSession beim nächsten Turn
 * weiterführen würde: Session-Modus an, Session-ID vorhanden, innerhalb der
 * Idle-Frist (Grenze eingeschlossen), mit dem Modell und dem Motor, die für
 * den Agenten jetzt gelten.
 */
export function countResumableSessions(sessions: readonly StoredSession[], options: ResumableOptions): number {
  if (!options.sessionMode) return 0;
  let n = 0;
  for (const s of sessions) {
    if (!s.engineSessionId) continue;
    const suffix = `:${s.agentName}`;
    const sessionKey = s.key?.endsWith(suffix) ? s.key.slice(0, -suffix.length) : undefined;
    const engine = options.engineFor(s.agentName, sessionKey);
    if (s.engine !== engine) continue;
    if (options.now - s.lastActivity > options.idleMs) continue;
    if (s.model !== options.modelFor(s.agentName, engine)) continue;
    n++;
  }
  return n;
}

export interface SessionCounts {
  /** SESSION_MODE=resume */
  mode: "resume" | "off";
  /** Einträge in data/sessions.json */
  stored: number;
  resumable: number;
}

/** Echte Quellen; in bot.ts botStatus aus ./bot-status */
export interface StatusPort {
  /** Version aus package.json */
  version(): string;
  /** Kurzer Git-Hash des laufenden Codes oder null, wenn er nicht ermittelbar ist */
  commit(): Promise<string | null>;
  /** Start des Bot-Prozesses in Millisekunden seit 1970, nicht der erste Statusabruf */
  startedAt(): number;
  supervisor(): Promise<Supervisor | null>;
  storage(): StorageBackend;
  /** null, wenn data/sessions.json nicht lesbar ist */
  sessions(): Promise<SessionCounts | null>;
  /** activeExecutionCount: laufende und wartende Ausführungen plus Telegram-Verarbeitungen */
  activeExecutions(): number;
  /** activeEngineCallCount: laufende Motor-Subprozesse (heute nur Claude Code) */
  activeClaudeCalls(): number;
  /** Marker vorhanden; ein leerer zählt als Anfrage, der Inhalt nie. Wirft, wenn der Zustand unbekannt ist */
  restartRequested(): Promise<boolean>;
  /** requestRestart(note); wirft, wenn der Marker nicht geschrieben wurde */
  requestRestart(note: string): Promise<void>;
  keys(): KeyStatus[];
  /**
   * Letzter Nachweis der semantischen Suche für die Supabase-Adresse der
   * .env (data/semantic-search.json); null ohne Supabase. Wirft, wenn der
   * Zustand unbekannt ist. Fehlt die Methode, meldet die API null.
   */
  semanticSearch?(): Promise<SemanticSearchState | null>;
  /**
   * Motoren (Issue #126): installiert, angemeldet, Version je Motor. Wirft,
   * wenn es nicht ermittelbar ist; fehlt die Methode, meldet die API null.
   */
  engines?(): Promise<EngineAvailability[]>;
  now?(): number;
}

export const STATUS_TEXT = {
  notConfigured: "Status ist nicht eingerichtet",
  noSupervisor:
    `${BRAND.name} läuft nicht unter launchd, PM2 oder systemd. Ein Neustart über die WebUI würde ihn beenden, ohne dass er wieder startet. Bitte ${BRAND.name} manuell neu starten.`,
  requested: `Neustart angefordert. ${BRAND.name} startet nach der laufenden Antwort neu, sonst innerhalb von etwa 30 Sekunden.`,
  notSaved: "Neustart konnte nicht angefordert werden",
} as const;

/** Notiz im Marker und im Telegram-Hinweis des Bots */
export const RESTART_NOTE = "WebUI";

export interface StatusApi {
  get(): Promise<ApiResult>;
  restart(): Promise<ApiResult>;
}

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : typeof e;
}

/** Ein Motor für die Statusseite: installiert, angemeldet (null: nicht feststellbar), Version */
function statusEngine(a: EngineAvailability): EngineAvailability {
  return {
    engine: String(a.engine),
    label: String(a.label),
    installed: a.installed === true,
    loggedIn: a.loggedIn === true ? true : a.loggedIn === false ? false : null,
    ...(typeof a.version === "string" && /^[0-9A-Za-z.+-]{1,40}$/.test(a.version) ? { version: a.version } : {}),
    ...(typeof a.message === "string" && a.message ? { message: a.message.slice(0, 300) } : {}),
  };
}

export function createStatusApi(port: StatusPort, log: (message: string) => void): StatusApi {
  const now = () => (port.now ? port.now() : Date.now());

  /** Einzelne Fehler machen ein Feld null, nicht die ganze Antwort zum 500 */
  async function safe<T>(label: string, fn: () => Promise<T> | T): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      log(`Status: ${label} nicht ermittelbar (${errorName(e)})`);
      return null;
    }
  }

  return {
    async get() {
      const [commit, supervisor, sessions, restartRequested, semanticSearch, engines] = await Promise.all([
        safe("Git-Hash", () => port.commit()),
        safe("Supervisor", () => port.supervisor()),
        safe("Sessions", () => port.sessions()),
        safe("Neustart-Marker", () => port.restartRequested()),
        safe("Semantische Suche", async () => (port.semanticSearch ? await port.semanticSearch() : null)),
        safe("Motoren", async () => (port.engines ? await port.engines() : null)),
      ]);
      const startedAt = port.startedAt();
      const current = now();
      return {
        status: 200,
        body: {
          version: { app: port.version(), commit },
          // ISO 8601 in UTC; Laufzeit in ganzen Sekunden
          startedAt: new Date(startedAt).toISOString(),
          uptimeSeconds: Math.max(0, Math.floor((current - startedAt) / 1000)),
          supervisor,
          storage: port.storage(),
          // Nur die beiden bekannten Zustände, sonst null
          semanticSearch: semanticSearch === "aktiv" || semanticSearch === "textsuche" ? semanticSearch : null,
          sessions,
          // Getrennt, nicht addieren: eine Antwort kann in beiden Zählern stecken
          running: { executions: port.activeExecutions(), claudeCalls: port.activeClaudeCalls() },
          restartRequested,
          // Nur die bekannten Felder, nie rohe Ausgaben der Prüfbefehle
          engines: Array.isArray(engines) ? engines.map(statusEngine) : null,
          keys: port.keys().map(k => ({ name: k.name, group: k.group, set: k.set === true })),
        },
      };
    },

    async restart() {
      // Erst prüfen: ohne Supervisor darf kein Marker entstehen
      let supervisor: Supervisor | null;
      try {
        supervisor = await port.supervisor();
      } catch (e) {
        log(`Neustart: Supervisor nicht ermittelbar (${errorName(e)})`);
        supervisor = null;
      }
      if (!supervisor) return { status: 409, body: { error: STATUS_TEXT.noSupervisor, supervisor: null } };
      try {
        await port.requestRestart(RESTART_NOTE);
      } catch (e) {
        log(`Neustart-Marker nicht geschrieben (${errorName(e)})`);
        return { status: 500, body: { error: STATUS_TEXT.notSaved } };
      }
      log(`Neustart angefordert über die WebUI (${supervisor})`);
      return { status: 202, body: { requested: true, supervisor, message: STATUS_TEXT.requested } };
    },
  };
}
