/**
 * Echte Zugriffe für die Prüfung der Dienst-Versionen (Issue #486,
 * services.ts): Befehle ohne Shell, Metrik per fetch, Prozess über ps bzw.
 * /proc, Dateien über lstat/stat/realpath. Der Bot wird nur über
 * data/restart-requested angefragt (wie bun run restart:request).
 */

import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { requestRestart } from "../restart-request";
import { SERVICES_LOCK_FILE, type ServiceDeps } from "./services";

/** Liest einen Ausgabestrom mit; text() liefert auch nach cancel() das bisher Gelesene */
function collect(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const done = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
  })().catch(() => {});
  return { done, text: () => text, cancel: () => reader.cancel().catch(() => {}) };
}

/**
 * Zeitlimit eines Befehls: expired wird beim Ablauf erfüllt, cancel räumt
 * auf, wenn der Befehl vorher fertig ist. Standard ist ein Timer; Tests
 * lösen den Ablauf aus, sobald ihr Testprozess bereit ist, statt auf die
 * Uhr zu wetten.
 */
export type CommandExpiry = (timeoutMs: number) => { expired: Promise<void>; cancel: () => void };

const timerExpiry: CommandExpiry = timeoutMs => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<void>(resolve => (timer = setTimeout(resolve, Math.max(1, timeoutMs))));
  return { expired, cancel: () => clearTimeout(timer) };
};

/**
 * Befehl ohne Shell. Nach Ablauf des Zeitlimits kehrt run zurück, auch wenn
 * der Prozess SIGTERM übergeht oder ein Kindprozess die Ausgabe offen hält:
 * SIGKILL, Ausgabe abbrechen, Exit -1. Ein Zeitablauf zählt nie als Erfolg,
 * auch wenn der Prozess danach noch mit 0 endet.
 */
export function commandRunner(expiry: CommandExpiry = timerExpiry): ServiceDeps["run"] {
  return async (cmd, timeoutMs) => {
    let proc;
    try {
      proc = Bun.spawn({ cmd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...process.env, LC_ALL: "C" } });
    } catch (error) {
      // Programm fehlt (etwa launchctl unter Linux)
      return { code: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
    }
    const stdout = collect(proc.stdout);
    const stderr = collect(proc.stderr);
    const finished = Promise.all([proc.exited, stdout.done, stderr.done]).then(([code]) => code);
    const limit = expiry(timeoutMs);
    try {
      const code = await Promise.race([finished, limit.expired.then(() => null)]);
      if (code !== null) return { code: proc.signalCode ? -1 : code, stdout: stdout.text(), stderr: stderr.text() };
    } finally {
      limit.cancel();
    }
    proc.kill("SIGKILL");
    proc.unref();
    void stdout.cancel();
    void stderr.cancel();
    return { code: -1, stdout: stdout.text(), stderr: `Zeitlimit überschritten ${stderr.text()}`.trim() };
  };
}

const run = commandRunner();

/** Ergebnis von work, oder null, wenn es nicht in timeoutMs kommt */
async function within<T>(work: Promise<T | null>, timeoutMs: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>(resolve => (timer = setTimeout(() => resolve(null), timeoutMs)));
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** Startzeit und Programmpfad eines Prozesses; null, wenn nicht lesbar oder nicht in timeoutMs */
async function processInfo(pid: number, platform: NodeJS.Platform, timeoutMs: number): Promise<{ startedMs: number; exe: string } | null> {
  const until = Date.now() + timeoutMs;
  const rest = () => Math.max(1, until - Date.now());
  const started = await run(["ps", "-o", "lstart=", "-p", String(pid)], rest());
  const startedMs = Date.parse(started.stdout.trim().replace(/\s+/g, " "));
  if (started.code !== 0 || !Number.isFinite(startedMs)) return null;
  let exe: string;
  if (platform === "linux") {
    exe = (await within(readlink(`/proc/${pid}/exe`).catch(() => ""), rest())) ?? "";
  } else {
    const r = await run(["ps", "-o", "comm=", "-p", String(pid)], rest());
    exe = r.code === 0 ? r.stdout.trim() : "";
  }
  return exe.startsWith("/") ? { startedMs, exe } : null;
}

/** Symlink-Ziel und jüngste Änderung an Pfad und Ziel; null, wenn nicht in timeoutMs lesbar */
async function fileTimes(path: string, timeoutMs: number): Promise<{ realPath: string; changedMs: number } | null> {
  const read = async () => {
    try {
      const [link, target, real] = await Promise.all([lstat(path), stat(path), realpath(path)]);
      return { realPath: real, changedMs: Math.max(link.mtimeMs, link.ctimeMs, target.mtimeMs, target.ctimeMs) };
    } catch {
      return null;
    }
  };
  return within(read(), timeoutMs);
}

/**
 * env: Umgebung samt Projekt-.env; daraus liest der Bot-Schutz
 * TYBO_LAUNCHD_LABEL und TYBO_SYSTEMD_UNIT (tybo wartung startet mit
 * --no-env-file und reicht die .env hier durch)
 */
export function realServiceDeps(root: string, env: Record<string, string | undefined> = process.env): ServiceDeps {
  return {
    platform: process.platform,
    uid: process.getuid?.() ?? 0,
    env,
    now: () => Date.now(),
    sleep: ms => Bun.sleep(ms),
    run,
    async fetchText(url, timeoutMs) {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.text()).slice(0, 2_000_000);
    },
    processInfo: (pid, timeoutMs) => processInfo(pid, process.platform, timeoutMs),
    fileTimes,
    requestBotRestart: note => requestRestart(note, join(root, "data", "restart-requested")),
    lockPath: join(root, SERVICES_LOCK_FILE),
  };
}
