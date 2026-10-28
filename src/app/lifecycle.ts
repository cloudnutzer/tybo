/**
 * Lebenszyklus des Bot-Prozesses (Issue #342): Sperrdatei gegen einen zweiten
 * Bot, Herzschlag auf der Sperre, geordnetes Beenden über eine Closer-Liste und
 * die Prozess-Signale.
 *
 * Der Import tut nichts: kein Zeitgeber, keine Datei, keine Signal-Handler.
 * Dateisystem, Zeitgeber, Prozessprüfung und Exit lassen sich austauschen,
 * damit die Tests ohne echten Bot auskommen.
 */
import { readFile, unlink, writeFile } from "fs/promises";

// ---------------------------------------------------------------------------
// Sperrdatei
// ---------------------------------------------------------------------------

/** Zugriff auf die Sperrdatei; create schlägt mit code EEXIST fehl, wenn sie schon da ist */
export interface LockFs {
  create(path: string, content: string): Promise<void>;
  /** Inhalt oder null, wenn sie fehlt oder nicht lesbar ist */
  read(path: string): Promise<string | null>;
  overwrite(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const diskLockFs: LockFs = {
  create: (path, content) => writeFile(path, content, { flag: "wx", mode: 0o600 }),
  read: path => readFile(path, "utf8").catch(() => null),
  overwrite: (path, content) => writeFile(path, content, { mode: 0o600 }),
  remove: path => unlink(path).catch(() => {}),
};

/** alive: läuft; gone: gibt es nicht mehr; unknown: nicht prüfbar (etwa EPERM), gilt als lebend */
export type PidState = "alive" | "gone" | "unknown";

/** Signal 0 prüft nur, ob der Prozess existiert */
export function probePid(pid: number, kill: (pid: number, signal: 0) => unknown = (p, s) => process.kill(p, s)): PidState {
  try {
    kill(pid, 0);
    return "alive";
  } catch (err) {
    return (err as { code?: unknown })?.code === "ESRCH" ? "gone" : "unknown";
  }
}

export interface ProcessLockOptions {
  path: string;
  pid: number;
  fs?: LockFs;
  probe?: (pid: number) => PidState;
}

export interface ProcessLock {
  /** true, wenn dieser Prozess die Sperre jetzt hält */
  acquire(): Promise<boolean>;
  /** löscht die Sperre nur, wenn sie noch diesem Prozess gehört */
  release(): Promise<void>;
  /** Herzschlag: schreibt die eigene Sperre neu, fremde bleiben unberührt; Fehler zählen nicht */
  touch(): Promise<void>;
}

/** Versuche, eine verwaiste Sperre zu ersetzen, bevor der Start aufgibt */
const LOCK_ATTEMPTS = 3;

function ownerPid(content: string): number | null {
  const digits = content.trim();
  if (!/^\d+$/.test(digits)) return null;
  const pid = Number(digits);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
}

export function createProcessLock(options: ProcessLockOptions): ProcessLock {
  const fs = options.fs ?? diskLockFs;
  const probe = options.probe ?? (pid => probePid(pid));
  const mine = String(options.pid);
  const holdsIt = async () => (await fs.read(options.path)) === mine;

  return {
    async acquire() {
      for (let attempt = 0; attempt < LOCK_ATTEMPTS; attempt++) {
        try {
          await fs.create(options.path, mine);
          return true;
        } catch (err) {
          if ((err as { code?: unknown })?.code !== "EEXIST") throw err;
        }
        const seen = (await fs.read(options.path)) ?? "";
        const owner = ownerPid(seen);
        // Unlesbarer Inhalt oder lebender (bzw. nicht prüfbarer) Besitzer: nicht anfassen
        if (owner === null || probe(owner) !== "gone") return false;
        // Nur löschen, was noch dieselbe verwaiste Sperre ist; sonst gewinnt der neue Besitzer
        if ((await fs.read(options.path)) === seen) await fs.remove(options.path);
      }
      return false;
    },
    async release() {
      if (await holdsIt()) await fs.remove(options.path);
    },
    async touch() {
      try {
        if (await holdsIt()) await fs.overwrite(options.path, mine);
      } catch {
        // Herzschlag ist nur ein Lebenszeichen
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Beenden
// ---------------------------------------------------------------------------

export interface IntervalTimers {
  setInterval(fn: () => unknown, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface LifecycleOptions {
  lock: Pick<ProcessLock, "touch" | "release">;
  exit: (code: number) => void;
  /** Abstand des Herzschlags, Standard 60 Sekunden */
  heartbeatMs?: number;
  /** Wartezeit nach den Closern, bevor die Sperre frei wird (letzte Meldungen gehen noch raus) */
  settleMs?: number;
  timers?: IntervalTimers;
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
  warn?: (line: string) => void;
  /** nach dem Freigeben, etwa ein Eintrag im Datenbank-Log; Fehler zählen nicht */
  afterRelease?: (reason: string) => Promise<unknown>;
}

export interface Lifecycle {
  isShuttingDown(): boolean;
  /** startet den Herzschlag auf der Sperre */
  startHeartbeat(): void;
  /** wiederkehrende Aufgabe, die beim Beenden als Erstes stoppt */
  every(ms: number, fn: () => unknown): void;
  /** Closer laufen beim Beenden in der Reihenfolge ihrer Anmeldung, jeder für sich abgesichert */
  onShutdown(name: string, run: () => unknown): void;
  /** nur der erste Aufruf wirkt; endet mit exit(0) */
  shutdown(reason: string): Promise<void>;
}

const HEARTBEAT_MS = 60_000;
const SETTLE_MS = 1600;

const errorName = (err: unknown) => (err instanceof Error ? err.name : typeof err);

export function createLifecycle(options: LifecycleOptions): Lifecycle {
  const timers: IntervalTimers = options.timers ?? {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: handle => clearInterval(handle as ReturnType<typeof setInterval>),
  };
  const sleep = options.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  const log = options.log ?? (line => console.log(line));
  const warn = options.warn ?? (line => console.error(line));
  const intervals: unknown[] = [];
  const closers: { name: string; run: () => unknown }[] = [];
  let stopping = false;

  const attempt = async (name: string, step: () => unknown) => {
    try {
      await step();
    } catch (err) {
      warn(`[shutdown] ${name} gescheitert (${errorName(err)})`);
    }
  };

  const every = (ms: number, fn: () => unknown) => {
    intervals.push(timers.setInterval(fn, ms));
  };

  return {
    isShuttingDown: () => stopping,
    startHeartbeat() {
      every(options.heartbeatMs ?? HEARTBEAT_MS, () => (stopping ? undefined : options.lock.touch()));
    },
    every,
    onShutdown(name, run) {
      closers.push({ name, run });
    },
    async shutdown(reason) {
      if (stopping) return;
      stopping = true;
      log(`\nReceived ${reason}. Shutting down gracefully...`);
      for (const handle of intervals.splice(0)) timers.clearInterval(handle);
      for (const closer of closers) await attempt(closer.name, closer.run);
      await sleep(options.settleMs ?? SETTLE_MS);
      // Muss laufen, sonst blockiert die Sperre den nächsten Start
      await attempt("Sperre freigeben", () => options.lock.release());
      if (options.afterRelease) await Promise.resolve().then(() => options.afterRelease!(reason)).catch(() => {});
      log("Shutdown complete.");
      options.exit(0);
    },
  };
}

// ---------------------------------------------------------------------------
// Signale
// ---------------------------------------------------------------------------

export interface SignalDeps {
  on(event: "SIGINT" | "SIGTERM" | "SIGHUP" | "uncaughtException", handler: (arg?: unknown) => unknown): void;
  /** meldet einen Absturz (etwa ins Datenbank-Log), bevor beendet wird; Fehler zählen nicht */
  report?: (error: Error) => Promise<unknown>;
  logError?: (message: string, error: unknown) => void;
}

export function installSignalHandlers(lifecycle: Pick<Lifecycle, "shutdown">, deps: SignalDeps): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    deps.on(signal, () => lifecycle.shutdown(signal));
  }
  deps.on("uncaughtException", async (arg) => {
    const error = arg instanceof Error ? arg : new Error(String(arg));
    (deps.logError ?? ((message, err) => console.error(message, err)))("Uncaught exception:", arg);
    if (deps.report) await Promise.resolve().then(() => deps.report!(error)).catch(() => {});
    await lifecycle.shutdown("uncaughtException");
  });
}
