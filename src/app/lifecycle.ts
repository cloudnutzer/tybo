/**
 * Lebenszyklus des Bot-Prozesses (Issue #342): Sperrdatei gegen einen zweiten
 * Bot, Herzschlag auf der Sperre, geordnetes Beenden über eine Closer-Liste und
 * die Prozess-Signale.
 *
 * Der Import tut nichts: kein Zeitgeber, keine Datei, keine Signal-Handler.
 * Dateisystem, Zeitgeber, Prozessprüfung und Exit lassen sich austauschen,
 * damit die Tests ohne echten Bot auskommen.
 */
import { link, readFile, rename, unlink, writeFile } from "fs/promises";
import { realpathSync } from "fs";
import { createHash, randomUUID } from "crypto";
import { basename, isAbsolute, join, resolve } from "path";
import { canonicalLstart, processCwd, stableProcessInfo, type StableProcessInfo } from "../lib/jobs/process";
import { logErrorMasked } from "../lib/telegram-token-mask";

// ---------------------------------------------------------------------------
// Sperrdatei
// ---------------------------------------------------------------------------
//
// bot.lock nennt seinen Besitzer mit PID und Startzeit (Issue #564), als JSON
// {"pid":123,"started":"Thu Nov 12 20:17:33 2026"}; die Startzeit kommt aus
// ps lstart mit fester Sprache und Zeitzone (STABLE_PS_ENV). Eine PID allein
// reicht nicht: nach einem harten Neustart vergibt das System die Nummern neu.
//
// Verwaist (und ersetzt) ist eine Sperre nur nachweislich:
// - die PID lebt nicht mehr, oder
// - unter der PID lebt ein Prozess mit anderer Startzeit, oder
// - alte Sperre nur mit PID: der lebende Prozess hat keine Befehlszeile mit
//   src/bot.ts aus diesem Ordner (relative Pfade über seinen Arbeitsordner).
// Alles Unklare (Inhalt unlesbar, Startzeit kein wirklicher Zeitpunkt in der
// Form von lstart, ps oder Arbeitsordner nicht abfragbar, ein möglicher Pfad
// nicht mehr vorhanden) gilt als belegt: lieber kein Start als zwei Bots.
//
// Anlegen und Ersetzen sind vollständig oder gar nicht sichtbar (erst eigene
// Datei, dann link bzw. rename). Aufbrechen darf nur, wer die Aufbruch-Sperre
// bot.lock.break-<hash aus altem Inhalt und Ebene, nie aus dem Pfadtext> hält, und nur, solange am
// Pfad noch genau dieser Inhalt liegt (Muster aus src/lib/file-lock.ts). So
// ergeben zwei gleichzeitige Übernahmen derselben verwaisten Sperre genau
// einen Besitzer. Eine verwaiste Aufbruch-Sperre wird nach demselben Muster
// aufgebrochen, ohne feste Tiefengrenze: jede Ebene gibt es nur, weil ein
// Start mitten in der Übernahme abgestürzt ist.
//
// Nur eine fehlende Datei (ENOENT) ist frei; jeder andere Lesefehler gilt als
// belegt.

/** Zugriff auf die Sperrdatei; create schlägt mit code EEXIST fehl, wenn sie schon da ist */
export interface LockFs {
  /** legt die Datei vollständig oder gar nicht an */
  create(path: string, content: string): Promise<void>;
  /** Inhalt oder null, wenn sie fehlt (ENOENT); wirft, wenn sie da, aber nicht lesbar ist */
  read(path: string): Promise<string | null>;
  /** ersetzt den Inhalt, ohne dass je ein halber Inhalt sichtbar ist */
  overwrite(path: string, content: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const stagingPath = (path: string) => `${path}.${randomUUID()}.tmp`;

/** Dateisysteme ohne harte Links: dann wie früher direkt mit "wx" */
const NO_LINK = new Set(["EPERM", "ENOTSUP", "EOPNOTSUPP", "ENOSYS", "EXDEV"]);

const diskLockFs: LockFs = {
  async create(path, content) {
    const staging = stagingPath(path);
    await writeFile(staging, content, { flag: "wx", mode: 0o600 });
    try {
      await link(staging, path);
    } catch (err) {
      if (!NO_LINK.has((err as { code?: string })?.code ?? "")) throw err;
      await writeFile(path, content, { flag: "wx", mode: 0o600 });
    } finally {
      await unlink(staging).catch(() => {});
    }
  },
  async read(path) {
    try {
      return await readFile(path, "utf8");
    } catch (err) {
      if ((err as { code?: unknown })?.code === "ENOENT") return null;
      throw err;
    }
  },
  async overwrite(path, content) {
    const staging = stagingPath(path);
    await writeFile(staging, content, { flag: "wx", mode: 0o600 });
    try {
      await rename(staging, path);
    } catch (err) {
      await unlink(staging).catch(() => {});
      throw err;
    }
  },
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

/** Prozessabfragen der Sperre; in Tests ersetzt, damit nichts einen fremden Prozess berührt */
export interface LockInspector {
  probe(pid: number): PidState;
  /** Startzeit und Befehl (ps mit STABLE_PS_ENV); null, wenn nicht abfragbar */
  info(pid: number): StableProcessInfo | null;
  /** Arbeitsordner; null, wenn nicht abfragbar */
  cwd(pid: number): string | null;
  /** echter Pfad ohne Symlinks; missing: gibt es nicht; unknown: nicht feststellbar (etwa EACCES) */
  realpath(path: string): RealPath;
}

export type RealPath = { path: string } | "missing" | "unknown";

export const realLockInspector: LockInspector = {
  probe: pid => probePid(pid),
  info: pid => stableProcessInfo(pid),
  cwd: pid => processCwd(pid),
  realpath(path) {
    try {
      return { path: realpathSync(path) };
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      return code === "ENOENT" || code === "ENOTDIR" ? "missing" : "unknown";
    }
  },
};

/** Inhalt der Sperre; started null: alte Sperre nur mit PID (oder Startzeit damals nicht abfragbar) */
export interface LockContent {
  pid: number;
  started: string | null;
}

const validPid = (pid: unknown): pid is number => typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0;

/**
 * null: beschädigt oder unbekanntes Format. Eine Startzeit zählt nur in der
 * Form von ps lstart (STABLE_PS_ENV) und als wirklicher Zeitpunkt
 * (isStableLstart); jede andere wiche immer ab und machte aus einem lebenden
 * Bot eine scheinbar verwaiste Sperre. Zurück kommt sie in der einen
 * Schreibweise von canonicalLstart („Oct 01“ wird „Oct  1“).
 */
export function parseLockContent(content: string): LockContent | null {
  const text = content.trim();
  if (/^\d+$/.test(text)) {
    const pid = Number(text);
    return validPid(pid) ? { pid, started: null } : null;
  }
  try {
    const parsed = JSON.parse(text) as { pid?: unknown; started?: unknown };
    if (!validPid(parsed?.pid)) return null;
    if (parsed.started === null) return { pid: parsed.pid, started: null };
    const started = typeof parsed.started === "string" ? canonicalLstart(parsed.started) : null;
    if (started !== null) return { pid: parsed.pid, started };
  } catch {}
  return null;
}

export function formatLockContent(owner: LockContent): string {
  return JSON.stringify({ pid: owner.pid, started: owner.started });
}

/**
 * Urteil über eine vorgefundene Sperre.
 * free: keine Sperre; stale: nachweislich verwaist; held: belegt oder unklar.
 */
export type LockVerdict =
  | { state: "free" }
  | { state: "stale"; pid: number; why: "gone" | "other-start" | "not-this-bot" }
  | {
      state: "held";
      pid: number | null;
      /** same-start: lebender Bot; bot-command: alte Sperre, Bot aus diesem Ordner; unverifiable: nicht prüfbar; unreadable: Inhalt beschädigt */
      why: "same-start" | "bot-command" | "unverifiable" | "unreadable";
      command: string | null;
      started: string | null;
      /** nachgewiesen src/bot.ts dieses Ordners; nur dann erscheint ein Pfad im Log */
      entry?: string | null;
    };

/**
 * Läuft unter dieser Befehlszeile src/bot.ts aus root? yes nur mit Nachweis.
 * no, wenn src/bot.ts gar nicht vorkommt oder jedes Vorkommen nachweislich
 * auf eine vorhandene andere Datei zeigt. Sonst unclear: leere Befehlszeile,
 * Arbeitsordner oder Pfad nicht abfragbar, oder der Pfad existiert nicht mehr.
 *
 * ps zeigt die Argumente ohne Anführungszeichen. Ein Pfad mit Leerzeichen
 * lässt sich darum nicht in Wörter zerlegen: geprüft wird jedes Stück, das an
 * einem Wortanfang beginnt und mit src/bot.ts endet, absolut oder relativ zum
 * Arbeitsordner, jeweils mit aufgelösten Symlinks.
 *
 * Fehlt ein Stück, das der ursprüngliche Pfad sein kann (etwa
 * "/old dir/src/bot.ts" nach dem Umbenennen des Projektordners oder
 * "run alias/src/bot.ts" nach dem Entfernen eines Symlinks), bleibt es
 * unklar, auch wenn ein kürzeres Stück ("dir/src/bot.ts") auf eine vorhandene
 * fremde Datei zeigt. Ausgeschlossen sind nur Stücke ab dem Programm selbst:
 * ps zeigt es als eigenes erstes Argument. Ein Wort wie "run" oder "--watch"
 * kann dagegen Anfang eines Ordnernamens sein; darum bleibt etwa
 * "bun run src/bot.ts" aus einem anderen Checkout unklar.
 */
export function botCommandFor(command: string, pid: number, root: string, inspector: Pick<LockInspector, "cwd" | "realpath">): "yes" | "no" | "unclear" {
  return botEntryFor(command, pid, root, inspector).verdict;
}

/** Wie botCommandFor; bei yes zusätzlich src/bot.ts dieses Ordners, nie ein Stück aus der Befehlszeile */
type BotEntry = { verdict: "yes"; entry: string } | { verdict: "no" | "unclear" };

function botEntryFor(command: string, pid: number, root: string, inspector: Pick<LockInspector, "cwd" | "realpath">): BotEntry {
  // Keine Befehlszeile (etwa ein Zombie): unbekannt, nicht nachweislich fremd
  if (!command.trim()) return { verdict: "unclear" };
  const programAt = command.search(/\S/);
  const entry = join(root, "src", "bot.ts");
  const realRoot = inspector.realpath(root);
  const realEntry = typeof realRoot === "object" ? join(realRoot.path, "src", "bot.ts") : null;
  const ENTRY = "src/bot.ts";
  let unclear = false;
  let cwd: string | null | undefined;
  for (let at = command.indexOf(ENTRY); at !== -1; at = command.indexOf(ENTRY, at + 1)) {
    const end = at + ENTRY.length;
    const before = at === 0 ? "" : command[at - 1];
    if (before !== "" && before !== "/" && !/\s/.test(before)) continue;
    if (end < command.length && !/\s/.test(command[end])) continue;
    // Zeigt kein Stück auf eine vorhandene Datei (etwa Ordner umbenannt), ist nichts bewiesen
    let located = false;
    for (let start = 0; start <= at; start++) {
      if (start > 0 && !/\s/.test(command[start - 1])) continue;
      const candidate = command.slice(start, end);
      let path = candidate;
      if (!isAbsolute(candidate)) {
        if (cwd === undefined) cwd = inspector.cwd(pid);
        if (cwd === null) {
          unclear = true;
          continue;
        }
        path = resolve(cwd, candidate);
      }
      if (path === entry || path === realEntry) return { verdict: "yes", entry };
      const real = inspector.realpath(path);
      if (real === "missing") {
        // Möglicher Originalpfad, der nicht mehr da ist: nichts bewiesen
        if (start !== programAt) unclear = true;
        continue;
      }
      if (real === "unknown" || realEntry === null) {
        unclear = true;
        continue;
      }
      if (real.path === realEntry) return { verdict: "yes", entry };
      located = true;
    }
    if (!located) unclear = true;
  }
  return { verdict: unclear ? "unclear" : "no" };
}

export function judgeLock(content: string | null, root: string, inspector: LockInspector): LockVerdict {
  if (content === null) return { state: "free" };
  const owner = parseLockContent(content);
  if (!owner) return { state: "held", pid: null, why: "unreadable", command: null, started: null };
  const { pid } = owner;
  if (inspector.probe(pid) === "gone") return { state: "stale", pid, why: "gone" };
  const info = inspector.info(pid);
  if (!info) {
    // ps ohne Antwort: entweder gerade beendet oder nicht abfragbar
    if (inspector.probe(pid) === "gone") return { state: "stale", pid, why: "gone" };
    return { state: "held", pid, why: "unverifiable", command: null, started: null };
  }
  if (owner.started !== null) {
    // Verglichen wird der Zeitpunkt, nicht die Schreibweise
    const now = canonicalLstart(info.started);
    if (now === null) return { state: "held", pid, why: "unverifiable", command: null, started: null };
    if (now !== owner.started) return { state: "stale", pid, why: "other-start" };
  }
  const bot = botEntryFor(info.command, pid, root, inspector);
  const entry = bot.verdict === "yes" ? bot.entry : null;
  if (owner.started !== null) return { state: "held", pid, why: "same-start", command: info.command, started: info.started, entry };
  if (bot.verdict === "no") return { state: "stale", pid, why: "not-this-bot" };
  return { state: "held", pid, why: bot.verdict === "yes" ? "bot-command" : "unverifiable", command: info.command, started: info.started, entry };
}

/** Warum ein Start abgelehnt wurde */
export type LockRejection =
  | Extract<LockVerdict, { state: "held" }>
  | { state: "busy" }
  | { state: "error"; code: string };

export type LockAcquireResult = { ok: true } | { ok: false; rejection: LockRejection };

export interface ProcessLockOptions {
  path: string;
  pid: number;
  /** Projektordner für alte Sperren ohne Startzeit; Standard: Ordner der Sperre */
  root?: string;
  /** eigene Startzeit; Standard: aus inspector.info(pid) */
  started?: string | null;
  fs?: LockFs;
  inspector?: Partial<LockInspector>;
}

export interface ProcessLock {
  /** ok: dieser Prozess hält die Sperre jetzt; sonst der Grund */
  tryAcquire(): Promise<LockAcquireResult>;
  /** löscht die Sperre nur, wenn sie noch genau diesem Prozess gehört (PID und Startzeit) */
  release(): Promise<void>;
  /** Herzschlag: schreibt die eigene Sperre neu, fremde bleiben unberührt; Fehler zählen nicht */
  touch(): Promise<void>;
}

/** Versuche, eine verwaiste Sperre zu ersetzen, bevor der Start aufgibt */
const LOCK_ATTEMPTS = 3;

/**
 * Schlüssel der Aufbruch-Sperre für den Inhalt seen; parentKey ist der
 * Schlüssel der Ebene darüber, "" für die Sperre selbst. Er hängt nur von den
 * Inhalten ab, nie vom Pfadtext: wer dieselbe Sperre über einen anderen Pfad
 * erreicht (etwa einen Symlink auf den Ordner), landet bei derselben
 * Aufbruch-Sperre.
 */
export function breakMarkerKey(parentKey: string, seen: string): string {
  return createHash("sha256").update(`${parentKey}\n${seen}`).digest("hex").slice(0, 16);
}

/** Aufbruch-Sperre mit dem Schlüssel key neben lockPath; der Name ist auf jeder Ebene gleich lang */
export function breakMarkerPath(lockPath: string, key: string): string {
  return `${lockPath}.break-${key}`;
}

const UNREADABLE: LockRejection = { state: "held", pid: null, why: "unreadable", command: null, started: null };

export function createProcessLock(options: ProcessLockOptions): ProcessLock {
  const fs = options.fs ?? diskLockFs;
  const inspector: LockInspector = { ...realLockInspector, ...options.inspector };
  const root = options.root ?? join(options.path, "..");
  let own: string | null = null;
  const mine = () => {
    if (own !== null) return own;
    const started = options.started !== undefined ? options.started : (inspector.info(options.pid)?.started ?? null);
    return (own = formatLockContent({ pid: options.pid, started: started === null ? null : (canonicalLstart(started) ?? started) }));
  };
  const holdsIt = async () => (await fs.read(options.path)) === mine();

  /** chain: Herzschläge der Reihe nach; released: danach schreibt keiner mehr */
  let chain: Promise<void> = Promise.resolve();
  let released = false;

  /** key: Schlüssel von path als Aufbruch-Sperre, "" für die Sperre selbst */
  const attempt = async (path: string, key: string, visited: ReadonlySet<string>): Promise<LockAcquireResult> => {
    let last: LockRejection = { state: "busy" };
    for (let i = 0; i < LOCK_ATTEMPTS; i++) {
      try {
        await fs.create(path, mine());
        return { ok: true };
      } catch (err) {
        if ((err as { code?: unknown })?.code !== "EEXIST") throw err;
      }
      let seen: string | null;
      try {
        seen = await fs.read(path);
      } catch {
        // da, aber nicht lesbar (etwa EACCES): unklar, also belegt
        return { ok: false, rejection: UNREADABLE };
      }
      last = { state: "busy" };
      // gerade freigegeben: neuer Versuch
      if (seen === null) continue;
      const verdict = judgeLock(seen, root, inspector);
      if (verdict.state === "held") return { ok: false, rejection: verdict };
      if (verdict.state === "free") continue;
      const markerKey = breakMarkerKey(key, seen);
      const marker = breakMarkerPath(options.path, markerKey);
      // Nur zur Sicherheit gegen einen Kreis gleicher Namen; jede Ebene braucht eine echte Datei
      if (visited.has(marker)) return { ok: false, rejection: last };
      // Hält ein anderer gerade die Aufbruch-Sperre, nimmt er die Sperre; nächster Versuch sieht seine
      if (!(await attempt(marker, markerKey, new Set([...visited, marker]))).ok) continue;
      try {
        if ((await fs.read(path)) === seen) await fs.remove(path);
      } finally {
        if ((await fs.read(marker).catch(() => null)) === mine()) await fs.remove(marker);
      }
    }
    return { ok: false, rejection: last };
  };

  return {
    tryAcquire: () => attempt(options.path, "", new Set([options.path])),
    async release() {
      released = true;
      // Ein laufender Herzschlag schreibt erst zu Ende; danach schreibt keiner mehr.
      // Sonst könnte er nach dem Löschen die Sperre eines Nachfolgers überschreiben.
      await chain;
      if (await holdsIt()) await fs.remove(options.path);
    },
    touch() {
      const beat = chain.then(async () => {
        if (released) return;
        try {
          if (await holdsIt()) await fs.overwrite(options.path, mine());
        } catch {
          // Herzschlag ist nur ein Lebenszeichen
        }
      });
      chain = beat;
      return beat;
    },
  };
}

/** Programmname aus einfachen Zeichen, etwa bun oder node */
const SAFE_PROGRAM = /^[A-Za-z0-9._+-]+$/;
/** absoluter, reiner Dateipfad zu src/bot.ts; ohne Leerzeichen, :, @, = und Ähnliches */
const SAFE_ENTRY = /^\/[A-Za-z0-9._\/-]*src\/bot\.ts$/;

/**
 * Befehl ohne Argumente fürs Log: Programmname und, falls nachgewiesen, der
 * Pfad zu src/bot.ts. Den Pfad liefert nur judgeLock, wenn der Prozess
 * nachweislich src/bot.ts dieses Ordners ausführt (entry); ein Stück aus der
 * Befehlszeile erscheint nie, auch wenn es wie ein Pfad aussieht: es könnte
 * Zugangsdaten enthalten (etwa "--oauth2-bearer /…/src/bot.ts"). Der
 * Programmname erscheint nur, wenn er sicher ein Name ist, der Pfad nur als
 * reiner Dateipfad; sonst steht dort nur „…“.
 */
export function describeLockCommand(command: string, entry: string | null = null): string {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return "Befehl unbekannt";
  const program = basename(tokens[0]);
  if (!SAFE_PROGRAM.test(program)) return "Befehl ausgeblendet";
  const parts = [program];
  if (entry && SAFE_ENTRY.test(entry)) parts.push(entry);
  if (tokens.length > 1) parts.push("…");
  return parts.join(" ");
}

/** lstart in UTC (STABLE_PS_ENV) als „2026-11-12 20:17:33 UTC“ */
export function formatLockStart(started: string): string {
  const date = new Date(`${started} UTC`);
  if (Number.isNaN(date.getTime())) return `${started} UTC`;
  return `${date.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** Eine Zeile fürs Fehler-Log, warum der Start abgelehnt wurde */
export function lockRejectionMessage(rejection: LockRejection, path: string): string {
  switch (rejection.state) {
    case "busy":
      return `Start abgelehnt: ${basename(path)} wird gerade von einem anderen Start übernommen.`;
    case "error":
      return `Start abgelehnt: ${basename(path)} ließ sich nicht anlegen (${rejection.code}).`;
    case "held": {
      if (rejection.pid === null) {
        return `Start abgelehnt: ${basename(path)} ist unlesbar oder beschädigt (${path}). Läuft kein Bot, darf die Datei weg.`;
      }
      const command = rejection.command ? describeLockCommand(rejection.command, rejection.entry ?? null) : "Befehl unbekannt";
      const started = rejection.started ? formatLockStart(rejection.started) : "zu unbekannter Zeit";
      const line = `Start abgelehnt: ${basename(path)} gehört Prozess ${rejection.pid} (${command}), gestartet ${started}.`;
      return rejection.why === "unverifiable" ? `${line} Ob er ein Bot aus diesem Ordner ist, ließ sich nicht prüfen.` : line;
    }
  }
}

export interface AcquireOrExitOptions {
  path: string;
  exit: (code: number) => void;
  /** Standard: console.error, also stderr bzw. das Fehler-Log des Dienstes */
  error?: (line: string) => void;
}

/**
 * Sperre nehmen oder mit Code 1 enden, vorher eine Zeile auf stderr (Issue
 * #564). Braucht weder Datenbank noch Logger: der Start ist hier noch nicht
 * so weit.
 */
export async function acquireLockOrExit(lock: Pick<ProcessLock, "tryAcquire">, options: AcquireOrExitOptions): Promise<boolean> {
  let result: LockAcquireResult;
  try {
    result = await lock.tryAcquire();
  } catch (err) {
    result = { ok: false, rejection: { state: "error", code: String((err as { code?: unknown })?.code ?? errorName(err)) } };
  }
  if (result.ok) return true;
  (options.error ?? (line => console.error(line)))(lockRejectionMessage(result.rejection, options.path));
  options.exit(1);
  return false;
}

/**
 * Hält laut bot.lock in root ein Bot die Sperre? Wie beim Start: true auch
 * bei Unklarheit (Datei da, aber nicht lesbar; Inhalt beschädigt; Besitzer
 * nicht prüfbar), false nur ohne Datei (ENOENT) oder bei nachweislich
 * verwaister Sperre. Für tybo setup --web und die Meldungen im Terminal.
 */
export async function botLockHeld(root: string, inspector: Partial<LockInspector> = {}, fs: Pick<LockFs, "read"> = diskLockFs): Promise<boolean> {
  let content: string | null;
  try {
    content = await fs.read(join(root, "bot.lock"));
  } catch {
    return true;
  }
  return judgeLock(content, root, { ...realLockInspector, ...inspector }).state === "held";
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
  /** nur der erste Aufruf wirkt; endet mit exit(code), Standard 0 */
  shutdown(reason: string, code?: number): Promise<void>;
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
    async shutdown(reason, code = 0) {
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
      options.exit(code);
    },
  };
}

// ---------------------------------------------------------------------------
// Signale
// ---------------------------------------------------------------------------

export interface SignalDeps {
  on(event: "SIGINT" | "SIGTERM" | "SIGHUP" | "uncaughtException" | "unhandledRejection", handler: (arg?: unknown) => unknown): void;
  /** meldet einen Absturz (etwa ins Datenbank-Log), bevor beendet wird; Fehler zählen nicht */
  report?: (error: Error) => Promise<unknown>;
  logError?: (message: string, error: unknown) => void;
}

export function installSignalHandlers(lifecycle: Pick<Lifecycle, "shutdown">, deps: SignalDeps): void {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    deps.on(signal, () => lifecycle.shutdown(signal));
  }
  const crash = async (arg: unknown, message: string, reason: "uncaughtException" | "unhandledRejection", code?: number) => {
    const error = arg instanceof Error ? arg : new Error(String(arg));
    // Ohne Token im Log (Issue #526)
    (deps.logError ?? logErrorMasked)(message, arg);
    if (deps.report) await Promise.resolve().then(() => deps.report!(error)).catch(() => {});
    await lifecycle.shutdown(reason, code);
  };
  deps.on("uncaughtException", arg => crash(arg, "Uncaught exception:", "uncaughtException"));
  // Bun gibt eine unbehandelte Ablehnung sonst selbst aus, an der Maskierung
  // vorbei und mit vollem Token. Wie dort endet der Prozess mit Code 1, nur
  // geordnet und maskiert (Issue #526).
  deps.on("unhandledRejection", arg => crash(arg, "Unhandled rejection:", "unhandledRejection", 1));
}
