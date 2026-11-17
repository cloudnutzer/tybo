/**
 * Routinen-API der WebUI (Issue #284): GET /api/routines für den Reiter
 * „Routinen", GET /api/routines/<id>/runs für den Verlauf einer Routine
 * (Issue #285), POST /api/routines/<id>/<aktion> zum Pausieren, Fortsetzen
 * und Testen (Issue #288; pause und resume nur mit {"confirm": true}, jede
 * Aktion mit {"request": "<kennung>"}: dieselbe Kennung handelt nur einmal).
 *
 * Diese Datei importiert nichts aus src/lib; src/bot.ts übergibt die echte
 * Quelle als RoutinesPort (src/web/bot-routines.ts), web:dev und Demo eine
 * Attrappe. Heraus gehen nur die Felder aus ROUTINE_API_FIELDS: keine
 * Plist- oder PM2-Objekte, keine Befehlsfehler, keine Log-Inhalte. Log-Pfade
 * stehen relativ zum Home-Ordner (~/…), damit der Benutzername nicht im
 * Browser landet; Pfade außerhalb des Home-Ordners werden zu null. Danach
 * ersetzt scrubHome den Home-Ordner in jeder Zeichenkette der Antwort durch
 * „~", gleich in welchem Feld (Zeitplan-Rohwerte, Namen, Hinweise).
 */

import type { ApiResult } from "./settings";

/** Ein Lauf, wie die Quelle ihn liefert (Form von RoutineRun aus src/lib/routines/runs.ts) */
export interface RoutineRunInput {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number;
  signal?: string;
  tail: string[];
  logPath?: string;
}

/** Eine Routine, wie die Quelle sie liefert (Form von Routine aus src/lib/routines/types.ts) */
export interface RoutineInput {
  id: string;
  name: string;
  kind: "scheduled" | "daemon";
  scheduleText: string;
  state: "active" | "paused" | "not-loaded" | "running" | "stopped" | "unknown";
  lastExit: number | null;
  logPath: string | null;
  errorLogPath: string | null;
  source: "launchd" | "pm2" | "systemd";
  own: boolean;
  wrapped: boolean;
  lastRun: RoutineRunInput | null;
  nextRun: string | null;
  /** Knöpfe der Detailansicht (Issue #288, menuActions in src/lib/routines/actions.ts); fehlt: keine */
  actions?: string[];
}

/** Aktionen der Detailansicht (Issue #288) */
export const ROUTINE_ACTIONS = ["run", "pause", "resume"] as const;
export type RoutineActionName = (typeof ROUTINE_ACTIONS)[number];

/** Ergebnis einer Aktion, wie die Quelle es liefert (Form von RoutineActionResult bzw. SettingsOutcome) */
export type RoutineActInput =
  | { status: "confirm-required" }
  | {
      status: "done" | "partial" | "failed" | "already" | "busy" | "wrong-state" | "blocked" | "unknown" | "unavailable";
      text: string;
      /** Die Routine nach der Aktion, frisch gelesen */
      routine?: RoutineInput | null;
    };

export interface RoutineListInput {
  available: boolean;
  source: "launchd" | "pm2" | "systemd" | null;
  routines: RoutineInput[];
  notes: string[];
}

/** Verlauf einer Routine: Läufe neueste zuerst */
export interface RoutineHistoryInput {
  routine: RoutineInput;
  runs: RoutineRunInput[];
}

export interface RoutinesPort {
  /** Home-Ordner, gegen den Log-Pfade gekürzt werden */
  home: string;
  list(): Promise<RoutineListInput>;
  /** Verlauf der Routine mit genau diesem Label; null, wenn es sie nicht gibt */
  runs?(id: string): Promise<RoutineHistoryInput | null>;
  /**
   * Aktion an der Routine mit genau diesem Label (Issue #288). confirm ist
   * true nur bei bestätigtem Dialog; die Quelle lehnt pause und resume
   * ohne ab. request ist die Kennung des Auftrags (validRequestKey); die
   * Quelle handelt je Kennung nur einmal. Fehlt: keine Knöpfe.
   */
  act?(id: string, action: RoutineActionName, confirm: boolean, request: string): Promise<RoutineActInput>;
}

export const ROUTINES_API_TEXT = {
  notConfigured: "Routinen sind hier nicht eingerichtet.",
  failed: "Routinen konnten nicht gelesen werden.",
  runsFailed: "Verlauf konnte nicht gelesen werden.",
  invalidId: "Ungültige Routine.",
  unknown: "Keine solche Routine.",
  invalidAction: "Ungültige Aktion.",
  confirmRequired: "Pausieren und Fortsetzen nur mit Bestätigung.",
  invalidRequest: "Auftrag ohne gültige Kennung.",
  actFailed: "Die Aktion ist fehlgeschlagen.",
} as const;

export const ROUTINE_API_FIELDS = ["id", "name", "kind", "scheduleText", "state", "lastExit", "logPath", "errorLogPath", "source", "own", "wrapped", "lastRun", "nextRun", "actions"] as const;

/** Letzter Lauf in der Liste: ohne Ausgabe und ohne Pfad (die stehen nur im Verlauf) */
export const LAST_RUN_API_FIELDS = ["startedAt", "endedAt", "durationMs", "exitCode", "signal"] as const;
export const RUN_API_FIELDS = [...LAST_RUN_API_FIELDS, "tail", "logPath"] as const;

export type LastRunApi = {
  startedAt: string;
  endedAt: string;
  durationMs: number;
  exitCode: number;
  signal: string | null;
};

export type RunApi = LastRunApi & {
  tail: string[];
  logPath: string | null;
};

export type RoutineApi = Omit<Pick<RoutineInput, Exclude<(typeof ROUTINE_API_FIELDS)[number], "actions">>, "lastRun" | "source"> & {
  /** null: unbekannte Quelle, nie stillschweigend launchd (Issue #568) */
  source: RoutineInput["source"] | null;
  lastRun: LastRunApi | null;
  actions: RoutineActionName[];
};

export type RoutineRunsApiBody = {
  routine: RoutineApi;
  runs: RunApi[];
};

export type RoutinesApiBody = {
  available: boolean;
  source: "launchd" | "pm2" | "systemd" | null;
  routines: RoutineApi[];
  notes: string[];
};

/**
 * Absoluter Pfad relativ zum Home-Ordner: „~" oder „~/…". Liegt er außerhalb
 * (oder enthält er „..", das aus dem Home-Ordner führen könnte), null; nie
 * ein künstliches „~/../".
 */
export function homeRelativePath(path: string | null, home: string): string | null {
  if (typeof path !== "string" || !path || !home) return null;
  const sep = path.includes("\\") && !path.includes("/") ? "\\" : "/";
  const base = home.replace(/[\\/]+$/, "");
  if (!base) return null;
  if (path.split(/[\\/]/).includes("..")) return null;
  if (path === base) return "~";
  if (!path.startsWith(base + sep)) return null;
  return "~/" + path.slice(base.length + 1).split(sep).join("/");
}

const STATES = new Set(["active", "paused", "not-loaded", "running", "stopped", "unknown"]);

function isoOrNull(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
}

function lastRunApi(run: RoutineRunInput | null | undefined): LastRunApi | null {
  if (!run || typeof run !== "object") return null;
  const startedAt = isoOrNull(run.startedAt);
  const endedAt = isoOrNull(run.endedAt);
  if (!startedAt || !endedAt || typeof run.exitCode !== "number" || !Number.isInteger(run.exitCode)) return null;
  return {
    startedAt,
    endedAt,
    durationMs: typeof run.durationMs === "number" && Number.isFinite(run.durationMs) ? Math.max(0, Math.round(run.durationMs)) : 0,
    exitCode: run.exitCode,
    signal: typeof run.signal === "string" && run.signal ? run.signal : null,
  };
}

function runApi(run: RoutineRunInput, home: string): RunApi | null {
  const base = lastRunApi(run);
  if (!base) return null;
  return {
    ...base,
    tail: (Array.isArray(run.tail) ? run.tail : []).filter((l): l is string => typeof l === "string"),
    logPath: homeRelativePath(run.logPath ?? null, home),
  };
}

function toApi(r: RoutineInput, home: string): RoutineApi {
  return {
    id: String(r.id),
    name: String(r.name),
    kind: r.kind === "daemon" ? "daemon" : "scheduled",
    scheduleText: String(r.scheduleText),
    state: STATES.has(r.state) ? r.state : "unknown",
    lastExit: typeof r.lastExit === "number" && Number.isInteger(r.lastExit) ? r.lastExit : null,
    logPath: homeRelativePath(r.logPath, home),
    errorLogPath: homeRelativePath(r.errorLogPath, home),
    // Unbekannte Quellen nie als launchd ausgeben (Issue #568)
    source: r.source === "launchd" || r.source === "pm2" || r.source === "systemd" ? r.source : null,
    own: r.own === true,
    wrapped: r.wrapped === true,
    lastRun: lastRunApi(r.lastRun),
    nextRun: isoOrNull(r.nextRun),
    actions: (Array.isArray(r.actions) ? r.actions : []).filter((a): a is RoutineActionName => (ROUTINE_ACTIONS as readonly string[]).includes(a)),
  };
}

/**
 * Ersetzt den Home-Ordner in jeder Zeichenkette von value durch „~", auch in
 * JSON-Schreibweise (Rohwerte stehen als JSON im Zeitplan-Text, dort sind
 * Backslashes verdoppelt). Nur ganze Pfad-Anfänge: „/Users/alex" in
 * „/Users/alexander" bleibt stehen.
 */
export function scrubHome<T>(value: T, home: string): T {
  const base = home.replace(/[\\/]+$/, "");
  if (!base) return value;
  const forms = [...new Set([base, JSON.stringify(base).slice(1, -1)])].sort((a, b) => b.length - a.length);
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:${forms.map(escape).join("|")})(?![\\p{L}\\p{N}_.-])`, "gu");
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.replace(pattern, "~");
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}

/** Nur die erlaubten Felder, danach kein absoluter Home-Pfad in irgendeiner Zeichenkette */
export function routinesApiBody(list: RoutineListInput, home: string): RoutinesApiBody {
  return scrubHome(
    {
      available: list.available === true,
      source: list.source === "launchd" || list.source === "pm2" || list.source === "systemd" ? list.source : null,
      routines: (Array.isArray(list.routines) ? list.routines : []).map(r => toApi(r, home)),
      notes: (Array.isArray(list.notes) ? list.notes : []).map(String),
    },
    home
  );
}

/** Verlauf: nur erlaubte Felder, Pfade mit ~, kein absoluter Home-Pfad in irgendeiner Zeichenkette */
export function routineRunsApiBody(history: RoutineHistoryInput, home: string): RoutineRunsApiBody {
  return scrubHome(
    {
      routine: toApi(history.routine, home),
      runs: (Array.isArray(history.runs) ? history.runs : []).map(r => runApi(r, home)).filter((r): r is RunApi => r !== null),
    },
    home
  );
}

/** Label als Pfadteil: dieselben Zeichen wie die Protokoll-Dateien (src/lib/routines/runs.ts) */
export function validRoutineId(id: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(id) && !id.includes("..");
}

/** Kennung eines Auftrags, wie isChoiceRequestKey in src/lib/choices.ts */
export function validRequestKey(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(value);
}

/** HTTP-Status je Ergebnis: Sperre 403, unbekannt 404, kein launchd 409, sonst 200 mit dem Text */
const ACT_STATUS: Record<string, number> = { blocked: 403, unknown: 404, unavailable: 409 };

export function createRoutinesApi(port: RoutinesPort, log?: (message: string) => void) {
  return {
    /**
     * POST /api/routines/<id>/<aktion>; id schon dekodiert. pause und resume
     * nur mit {"confirm": true}, jede Aktion nur mit gültiger Kennung
     * {"request": …}, sonst 400 ohne Aufruf der Quelle.
     */
    async act(id: string, action: string, body: unknown): Promise<ApiResult> {
      if (!validRoutineId(id)) return { status: 400, body: { error: ROUTINES_API_TEXT.invalidId } };
      if (!(ROUTINE_ACTIONS as readonly string[]).includes(action)) return { status: 400, body: { error: ROUTINES_API_TEXT.invalidAction } };
      let parsed: unknown = body;
      if (typeof body === "string") {
        try {
          parsed = body.trim() ? JSON.parse(body) : {};
        } catch {
          return { status: 400, body: { error: ROUTINES_API_TEXT.invalidAction } };
        }
      }
      const confirm = !!parsed && typeof parsed === "object" && (parsed as Record<string, unknown>).confirm === true;
      if (action !== "run" && !confirm) return { status: 400, body: { error: ROUTINES_API_TEXT.confirmRequired } };
      const request = !!parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>).request : undefined;
      if (!validRequestKey(request)) return { status: 400, body: { error: ROUTINES_API_TEXT.invalidRequest } };
      if (!port.act) return { status: 503, body: { error: ROUTINES_API_TEXT.notConfigured } };
      try {
        const result = await port.act(id, action as RoutineActionName, confirm, request);
        if (result.status === "confirm-required") return { status: 400, body: { error: ROUTINES_API_TEXT.confirmRequired } };
        return {
          status: ACT_STATUS[result.status] ?? 200,
          body: scrubHome({ status: result.status, text: String(result.text), routine: result.routine ? toApi(result.routine, port.home) : null }, port.home),
        };
      } catch {
        // Wie routineLogLine (src/lib/routines/log.ts): nur Routinen-ID, Aktion und Kanal
        log?.(`[routinen] ${id} ${action} (web)`);
        return { status: 500, body: { error: ROUTINES_API_TEXT.actFailed } };
      }
    },
    /** GET /api/routines/<id>/runs; id schon aus der Adresse dekodiert */
    async runs(id: string): Promise<ApiResult> {
      if (!validRoutineId(id)) return { status: 400, body: { error: ROUTINES_API_TEXT.invalidId } };
      if (!port.runs) return { status: 503, body: { error: ROUTINES_API_TEXT.notConfigured } };
      try {
        const history = await port.runs(id);
        if (!history) return { status: 404, body: { error: ROUTINES_API_TEXT.unknown } };
        return { status: 200, body: routineRunsApiBody(history, port.home) };
      } catch (e) {
        log?.(`Verlauf der Routine nicht lesbar: ${e instanceof Error ? e.message : String(e)}`);
        return { status: 500, body: { error: ROUTINES_API_TEXT.runsFailed } };
      }
    },
    async get(): Promise<ApiResult> {
      try {
        return { status: 200, body: routinesApiBody(await port.list(), port.home) };
      } catch (e) {
        // Fehlertext nur ins Log, nie an den Browser
        log?.(`Routinen nicht lesbar: ${e instanceof Error ? e.message : String(e)}`);
        return { status: 500, body: { error: ROUTINES_API_TEXT.failed } };
      }
    },
  };
}
