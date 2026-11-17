/**
 * Telegram-Eingang mit Aufsicht (Issue #562): Ein Konflikt (409, ein zweiter
 * Bot pollt mit demselben Token) oder ein abgelehnter Token (401) legt nur den
 * Eingang still, nicht den Prozess. WebUI, Erinnerungen, Jobs und Ziele
 * laufen weiter.
 *
 * - 409: neue Versuche mit wachsender Pause (15 Sekunden, verdoppelt, höchstens
 *   10 Minuten). Kein Start ruft deleteWebhook (telegram-runtime.ts beantwortet
 *   den Aufruf selbst), auch nicht der erste: tybo verdrängt nie einen anderen
 *   Bot, auch keinen Server im Webhook-Modus. Dessen Webhook ergibt ebenfalls 409.
 * - 401: kein neuer Versuch. Eine geänderte .env übernimmt der laufende Bot
 *   nicht von selbst; erst ein bewusster Neustart versucht es wieder.
 * - Anderes (Netz weg beim Start, 5xx): wie 409 mit wachsender Pause, mit
 *   eigener Logzeile, damit ein Rechner ohne Netz beim Hochfahren den Bot
 *   nicht beendet.
 *
 * onReady (Ziele fortsetzen) läuft genau einmal: beim ersten erfolgreichen
 * Start oder beim ersten Fehler, nie bei einer Wiederholung. grammY ruft
 * onStart vor dem ersten getUpdates; als gesund gilt der Eingang deshalb erst
 * nach einem angenommenen getUpdates (onPolling), erst dann beginnt die Pause
 * wieder von vorn.
 *
 * Der Zustand steht in data/telegram-intake.json (mit PID), damit die
 * Statusseite und `tybo pruefen` (ein eigener Prozess) dasselbe zeigen. Eine
 * Meldung je Fehlerserie geht als display_only in den Direktchat der WebUI,
 * unabhängig vom Telegram-Versand. Keine Zeile enthält den Token.
 */

import { mkdir, readFile, rename, rm, writeFile } from "fs/promises";
import { dirname, join } from "path";
import { safeErrorMessage } from "./telegram-token-mask";

type Log = (line: string) => void;

export type IntakeFailureKind = "conflict" | "unauthorized" | "other";
export type IntakeState = "ok" | IntakeFailureKind;

/** Erste Pause und Obergrenze in Sekunden */
export const RETRY_FIRST_SECONDS = 15;
export const RETRY_MAX_SECONDS = 600;

/** Quelle der Meldungen in der WebUI */
export const INTAKE_SOURCE = "telegram";

export const INTAKE_TEXT = {
  conflict: (seconds: number) =>
    `Telegram: Ein anderer Bot nutzt denselben Token (409). Telegram-Eingang pausiert, nächster Versuch in ${seconds} Sekunden.`,
  unauthorized: "Telegram lehnt den Token ab (401). Telegram-Eingang aus, bis der Token stimmt.",
  other: (reason: string, seconds: number) => `Telegram-Eingang gestört (${reason}). Nächster Versuch in ${seconds} Sekunden.`,
  recovered: "Telegram-Eingang läuft wieder.",
  running: "Telegram-Eingang läuft.",
} as const;

/** Fehlercode einer Antwort von Telegram (GrammyError trägt error_code), sonst undefined */
function errorCode(error: unknown): number | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const code = (error as { error_code?: unknown }).error_code;
  return typeof code === "number" ? code : undefined;
}

export function classifyStartError(error: unknown): IntakeFailureKind {
  const code = errorCode(error);
  if (code === 409) return "conflict";
  if (code === 401) return "unauthorized";
  return "other";
}

/** Telegram hat den Token abgelehnt (401), beim Polling wie beim Senden */
export function isTokenRejected(error: unknown): boolean {
  return classifyStartError(error) === "unauthorized";
}

/** Pause vor dem n-ten neuen Versuch (n ab 1): 15, 30, 60, … höchstens 600 Sekunden */
export function retryDelaySeconds(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(RETRY_MAX_SECONDS, RETRY_FIRST_SECONDS * 2 ** Math.min(n - 1, 20));
}

/** Gekürzte, tokenfreie Fehlermeldung für Log und Anzeige */
function reasonLine(error: unknown, tokens?: readonly string[]): string {
  const text = (tokens ? safeErrorMessage(error, tokens) : safeErrorMessage(error)).replace(/\s+/g, " ").trim();
  return (text || "unbekannter Fehler").slice(0, 160);
}

export interface IntakeEvent {
  state: IntakeState;
  /** Zeile wie im Log */
  message: string;
  /** Erste Meldung dieser Art in der laufenden Fehlerserie (für die WebUI-Meldung) */
  firstInSeries: boolean;
  /** Bei 409 und Anderem: Zeitpunkt des nächsten Versuchs */
  nextAttemptAt?: number;
}

export interface TelegramStartOptions {
  /** Ein getUpdates wurde angenommen: der Eingang läuft wirklich */
  onPolling(): void;
}

export interface IntakeSupervisorDeps {
  /** runtime.start; wirft bei 401, 409 oder Anderem, endet normal nach stop() */
  start(onReady: () => void, options: TelegramStartOptions): Promise<void>;
  /** Ziele fortsetzen; genau einmal */
  onReady(): unknown;
  /** Abbruch beim Beenden: wartende Wiederholungen enden, kein neuer Start */
  signal: AbortSignal;
  /** Zustandswechsel; Fehler darin beenden nichts */
  report?(event: IntakeEvent): unknown;
  log?: Log;
  now?(): number;
  /** Pause; endet vorzeitig bei Abbruch. Tests stellen die Uhr */
  sleep?(ms: number, signal: AbortSignal): Promise<void>;
  /** Für die Maskierung; Standard die Tokens der Prozess-Umgebung */
  tokens?: readonly string[];
}

export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Startet den Eingang und hält ihn am Leben. Endet, wenn der Eingang
 * normal gestoppt wurde, nach 401 oder beim Abbruch; wirft nie.
 */
export async function superviseTelegramIntake(deps: IntakeSupervisorDeps): Promise<void> {
  const log = deps.log ?? (line => console.log(line));
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? abortableSleep;
  let readyFired = false;
  const ready = () => {
    if (readyFired) return;
    readyFired = true;
    try {
      const result = deps.onReady();
      if (result instanceof Promise) result.catch(e => log(`[telegram] Fortsetzen nach dem Start gescheitert (${reasonLine(e, deps.tokens)})`));
    } catch (e) {
      log(`[telegram] Fortsetzen nach dem Start gescheitert (${reasonLine(e, deps.tokens)})`);
    }
  };
  const report = (event: IntakeEvent) => {
    try {
      const result = deps.report?.(event);
      if (result instanceof Promise) result.catch(e => log(`[telegram] Zustand nicht gemeldet (${reasonLine(e, deps.tokens)})`));
    } catch (e) {
      log(`[telegram] Zustand nicht gemeldet (${reasonLine(e, deps.tokens)})`);
    }
  };

  let attempt = 0;
  /** Arten, die in der laufenden Fehlerserie schon gemeldet sind; leer heißt: kein Fehler offen */
  const reported = new Set<IntakeFailureKind>();
  let healthyReported = false;
  const onPolling = () => {
    attempt = 0;
    if (reported.size === 0) {
      // Erster angenommener Abruf ohne vorherigen Fehler: nur der Zustand, keine Logzeile
      if (!healthyReported) report({ state: "ok", message: INTAKE_TEXT.running, firstInSeries: false });
      healthyReported = true;
      return;
    }
    healthyReported = true;
    reported.clear();
    log(`[telegram] ${INTAKE_TEXT.recovered}`);
    report({ state: "ok", message: INTAKE_TEXT.recovered, firstInSeries: false });
  };

  while (!deps.signal.aborted) {
    try {
      await deps.start(ready, { onPolling });
      return;
    } catch (error) {
      if (deps.signal.aborted) return;
      ready();
      const kind = classifyStartError(error);
      const firstInSeries = !reported.has(kind);
      reported.add(kind);
      if (kind === "unauthorized") {
        log(INTAKE_TEXT.unauthorized);
        report({ state: kind, message: INTAKE_TEXT.unauthorized, firstInSeries });
        return;
      }
      attempt++;
      const seconds = retryDelaySeconds(attempt);
      const message = kind === "conflict" ? INTAKE_TEXT.conflict(seconds) : INTAKE_TEXT.other(reasonLine(error, deps.tokens), seconds);
      log(message);
      report({ state: kind, message, firstInSeries, nextAttemptAt: now() + seconds * 1000 });
      await sleep(seconds * 1000, deps.signal);
    }
  }
}

// --- Zustand für Statusseite und `tybo pruefen` ---

export interface StoredIntakeState {
  state: IntakeState;
  message: string;
  /** ISO-Zeitpunkt der Meldung */
  since: string;
  nextAttemptAt?: string;
  pid: number;
}

export function intakeStatePath(root: string): string {
  return join(root, "data", "telegram-intake.json");
}

export async function writeIntakeState(path: string, state: StoredIntakeState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  await rename(tmp, path);
}

/** Beim Start: alter Zustand eines früheren Prozesses gilt nicht mehr */
export async function clearIntakeState(path: string): Promise<void> {
  await rm(path, { force: true });
}

const STATES: readonly IntakeState[] = ["ok", "conflict", "unauthorized", "other"];

/** Gelesener Zustand oder null (keine Datei, unlesbar, fremdes Format) */
export async function readIntakeState(path: string): Promise<StoredIntakeState | null> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw) as Partial<StoredIntakeState>;
    if (!data || !STATES.includes(data.state as IntakeState)) return null;
    if (typeof data.message !== "string" || typeof data.since !== "string" || typeof data.pid !== "number") return null;
    return {
      state: data.state as IntakeState,
      message: data.message.slice(0, 300),
      since: data.since,
      ...(typeof data.nextAttemptAt === "string" ? { nextAttemptAt: data.nextAttemptAt } : {}),
      pid: data.pid,
    };
  } catch {
    return null;
  }
}

/** Läuft der Prozess, der den Zustand geschrieben hat? */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: der Prozess lebt, gehört aber einem anderen Nutzer
    return (e as { code?: string }).code === "EPERM";
  }
}

export interface IntakeReporterDeps {
  /** data/telegram-intake.json */
  statePath: string;
  /** Meldung in den Direktchat der WebUI (createChoicePostWeb), display_only; false, wenn sie nicht ankam */
  postWeb(conversationId: string, post: { text: string; kind: "notice"; source: string }): Promise<boolean>;
  /** Gespräch der Meldung; Standard der Direktchat "dm" */
  conversationId?: string;
  now?(): number;
  pid?: number;
  log?: Log;
}

/**
 * Zustand festhalten und je Fehlerserie einmal in die WebUI melden. Die
 * Erholung aktualisiert nur den Zustand, ohne eigene Meldung. Beim Anlegen
 * fällt der Zustand eines früheren Prozesses weg; Schreiben nacheinander.
 */
export function createIntakeReporter(deps: IntakeReporterDeps): (event: IntakeEvent) => Promise<void> {
  const log = deps.log ?? (line => console.log(line));
  const now = deps.now ?? Date.now;
  const pid = deps.pid ?? process.pid;
  let queue: Promise<void> = clearIntakeState(deps.statePath).catch(() => {});
  return event => {
    const run = queue.then(() => handle(event));
    queue = run.catch(() => {});
    return run;
  };
  async function handle(event: IntakeEvent): Promise<void> {
    const stored: StoredIntakeState = {
      state: event.state,
      message: event.message,
      since: new Date(now()).toISOString(),
      ...(event.nextAttemptAt !== undefined ? { nextAttemptAt: new Date(event.nextAttemptAt).toISOString() } : {}),
      pid,
    };
    try {
      await writeIntakeState(deps.statePath, stored);
    } catch (e) {
      log(`[telegram] Zustand des Eingangs nicht gespeichert (${e instanceof Error ? e.name : "Fehler"})`);
    }
    if (event.state === "ok" || !event.firstInSeries) return;
    try {
      const shown = await deps.postWeb(deps.conversationId ?? "dm", { text: event.message, kind: "notice", source: INTAKE_SOURCE });
      if (!shown) log("[telegram] Meldung zum Eingang nicht in der WebUI abgelegt");
    } catch (e) {
      log(`[telegram] Meldung zum Eingang nicht in der WebUI abgelegt (${e instanceof Error ? e.name : "Fehler"})`);
    }
  }
}

/** Sicht für Statusseite und Prüfbericht: nur der Zustand des laufenden Prozesses zählt */
export interface IntakeView {
  state: IntakeState;
  message: string;
  since: string;
}

export async function currentIntakeView(path: string, alive: (pid: number) => boolean = processAlive): Promise<IntakeView | null> {
  const stored = await readIntakeState(path);
  if (!stored || !alive(stored.pid)) return null;
  return { state: stored.state, message: stored.message, since: stored.since };
}
