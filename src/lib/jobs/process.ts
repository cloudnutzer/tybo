/**
 * Prozesse der Hintergrund-Jobs (Issue #103): Identität und Beenden.
 *
 * Eine PID allein reicht nicht, sie kann nach dem Ende eines Prozesses neu
 * vergeben werden. Deshalb wird zu jeder PID die Startzeit festgehalten
 * (ps -o lstart=) und vor jedem Signal verglichen. Ohne Startzeit (nicht
 * festgehalten oder gerade nicht abfragbar) gibt es kein Signal: lieber
 * einen Prozess stehen lassen als einen fremden treffen.
 *
 * Claude läuft in einer eigenen Prozessgruppe (detached, setsid), getrennt
 * vom Wächter. terminateGroup beendet diese Gruppe (erst SIGTERM, nach einer
 * Frist SIGKILL) und wartet, bis kein Mitglied mehr lebt. Anders als
 * terminateProcessTree (src/lib/process-tree.ts) wartet es und meldet, ob
 * der Baum wirklich weg ist.
 */

import { readlinkSync } from "fs";
import type { ProcRef } from "./store";

export interface ProcessOps {
  /** Startzeit des Prozesses, null wenn er nicht (mehr) lebt oder ps scheitert */
  identity(pid: number): string | null;
  alive(pid: number): boolean;
  /** Signal an die ganze Gruppe; false, wenn es sie nicht (mehr) gibt */
  signalGroup(pgid: number, signal: NodeJS.Signals): boolean;
  /** Lebt noch ein Mitglied der Gruppe? */
  groupAlive(pgid: number): boolean;
  sleep(ms: number): Promise<void>;
  /** Alle Prozesse (ps -A); null, wenn ps scheitert. Fehlt bei Attrappen ohne Prozessliste */
  listProcesses?(): ProcInfo[] | null;
}

/** Eintrag der Prozessliste, identity wie identity() (ps lstart) */
export interface ProcInfo {
  pid: number;
  ppid: number;
  identity: string;
  command: string;
}

/** Zeile von `ps -A -o pid=,ppid=,lstart=,command=`; lstart hat feste Form („Thu Oct  1 06:35:20 2026") */
const PS_LINE = /^\s*(\d+)\s+(\d+)\s+([A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4})\s+(.*)$/;

export function parseProcessList(text: string): ProcInfo[] {
  const list: ProcInfo[] = [];
  for (const line of text.split("\n")) {
    const m = PS_LINE.exec(line);
    if (m) list.push({ pid: Number(m[1]), ppid: Number(m[2]), identity: m[3], command: m[4].trim() });
  }
  return list;
}

/** Alle Nachfahren von root (ohne root selbst), über die Eltern-PID */
export function descendantsOf(root: number, list: readonly ProcInfo[]): ProcInfo[] {
  const children = new Map<number, ProcInfo[]>();
  for (const p of list) {
    if (p.pid === p.ppid) continue;
    const kids = children.get(p.ppid);
    if (kids) kids.push(p);
    else children.set(p.ppid, [p]);
  }
  const result: ProcInfo[] = [];
  const queue = [root];
  const seen = new Set<number>([root]);
  while (queue.length) {
    for (const kid of children.get(queue.shift()!) ?? []) {
      if (seen.has(kid.pid)) continue;
      seen.add(kid.pid);
      result.push(kid);
      queue.push(kid.pid);
    }
  }
  return result;
}

export const realProcessOps: ProcessOps = {
  identity(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return null;
    try {
      const result = Bun.spawnSync(["ps", "-o", "lstart=", "-p", String(pid)], { stdout: "pipe", stderr: "ignore" });
      if (result.exitCode !== 0) return null;
      const text = result.stdout.toString().trim();
      return text || null;
    } catch {
      return null;
    }
  },
  alive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e: any) {
      return e?.code === "EPERM";
    }
  },
  signalGroup(pgid, signal) {
    if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
    try {
      process.kill(-pgid, signal);
      return true;
    } catch {
      return false;
    }
  },
  groupAlive(pgid) {
    if (!Number.isSafeInteger(pgid) || pgid <= 1) return false;
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (e: any) {
      return e?.code === "EPERM";
    }
  },
  sleep: ms => new Promise(r => setTimeout(r, ms)),
  listProcesses() {
    try {
      // -ww: Befehlszeile nicht auf Terminalbreite kürzen
      const result = Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,ppid=,lstart=,command="], { stdout: "pipe", stderr: "ignore" });
      return result.exitCode === 0 ? parseProcessList(result.stdout.toString()) : null;
    } catch {
      return null;
    }
  },
};

/**
 * Zustand eines festgehaltenen Prozesses:
 * same: lebt und hat dieselbe Startzeit;
 * dead: die PID lebt nicht mehr;
 * other: unter der PID lebt ein anderer Prozess (andere Startzeit);
 * unknown: die PID lebt, aber ob es derselbe Prozess ist, lässt sich nicht
 * sagen (keine Startzeit festgehalten oder Abfrage gescheitert).
 * Sicher beendet ist ein Prozess nur bei dead oder other.
 */
export type ProcessCheck = "same" | "dead" | "other" | "unknown";

export function checkProcess(ref: ProcRef, ops: ProcessOps): ProcessCheck {
  if (!ops.alive(ref.pid)) return "dead";
  if (ref.identity === null) return "unknown";
  const current = ops.identity(ref.pid);
  if (current === null) return ops.alive(ref.pid) ? "unknown" : "dead";
  return current === ref.identity ? "same" : "other";
}

/** Der festgehaltene Prozess lebt sicher nicht mehr (kein Eintrag, tot oder PID neu vergeben) */
export function processGone(ref: ProcRef | undefined, ops: ProcessOps): boolean {
  if (!ref) return true;
  const check = checkProcess(ref, ops);
  return check === "dead" || check === "other";
}

export function ownProcessRef(ops: ProcessOps): ProcRef {
  return { pid: process.pid, identity: ops.identity(process.pid) };
}

/**
 * gone: kein Mitglied der Gruppe lebt mehr (auch: gab es schon nicht mehr);
 * foreign: die PID gehört inzwischen einem anderen Prozess, nichts gesendet;
 * unverified: Startzeit fehlt oder war nicht abfragbar, nichts gesendet;
 * survived: nach SIGKILL lebt noch etwas.
 */
export type TerminateResult = "gone" | "foreign" | "unverified" | "survived";

export interface TerminateOptions {
  /** Frist nach SIGTERM, Standard 5 s */
  graceMs?: number;
  /** Frist nach SIGKILL, Standard 3 s */
  killWaitMs?: number;
  pollMs?: number;
}

/** Gezählt in Wartezeiten von ops.sleep (Attrappen warten so nicht wirklich) */
async function waitGroupGone(pgid: number, ops: ProcessOps, ms: number, pollMs: number): Promise<boolean> {
  for (let waited = 0; ; waited += pollMs) {
    if (!ops.groupAlive(pgid)) return true;
    if (waited >= ms) return false;
    await ops.sleep(pollMs);
  }
}

/**
 * Darf an die Gruppe von ref ein Signal gehen? Lebt der Anführer noch, muss
 * seine Startzeit stimmen (sonst foreign bzw. unverified). Ist er schon weg,
 * können noch Kinder in der Gruppe leben; die Gruppen-ID wird nicht neu
 * vergeben, solange die Gruppe besteht, also trifft das Signal nur sie.
 */
function signalAllowed(ref: ProcRef, ops: ProcessOps): "ok" | "foreign" | "unverified" {
  const check = checkProcess(ref, ops);
  if (check === "unknown") return "unverified";
  if (check === "other") return "foreign";
  return "ok";
}

/**
 * Beendet die Prozessgruppe, deren Anführer ref ist. Ohne festgehaltene
 * Startzeit wird nichts gesendet (unverified). Vor SIGTERM und noch einmal
 * vor SIGKILL wird die Identität geprüft: Ist die PID in der Wartefrist neu
 * vergeben worden oder nicht mehr prüfbar, geht kein weiteres Signal.
 */
export async function terminateGroup(ref: ProcRef, ops: ProcessOps, options: TerminateOptions = {}): Promise<TerminateResult> {
  const { graceMs = 5_000, killWaitMs = 3_000, pollMs = 50 } = options;
  if (ref.identity === null) return "unverified";
  const before = signalAllowed(ref, ops);
  if (before !== "ok") return before;
  if (!ops.groupAlive(ref.pid)) return "gone";
  ops.signalGroup(ref.pid, "SIGTERM");
  if (await waitGroupGone(ref.pid, ops, graceMs, pollMs)) return "gone";
  const again = signalAllowed(ref, ops);
  if (again !== "ok") return again;
  ops.signalGroup(ref.pid, "SIGKILL");
  return (await waitGroupGone(ref.pid, ops, killWaitMs, pollMs)) ? "gone" : "survived";
}

// ---------------------------------------------------------------------------
// Startzeit und Befehl für Sperrdateien (Issue #564)
// ---------------------------------------------------------------------------

/**
 * Umgebung für ps, wenn eine Startzeit gespeichert und später verglichen
 * wird: lstart hängt von Sprache (LC_*) und Zeitzone (TZ) ab. Mit C und UTC
 * sieht dieselbe Startzeit immer gleich aus, egal unter welcher Umgebung
 * Schreiber und Leser laufen.
 */
export const STABLE_PS_ENV: Record<string, string> = { LC_ALL: "C", LANG: "C", TZ: "UTC" };

/** lstart wie in PS_LINE */
const LSTART = "[A-Z][a-z]{2} [A-Z][a-z]{2} [ \\d]\\d \\d\\d:\\d\\d:\\d\\d \\d{4}";

/** Zeile von `ps -o lstart=,command=` */
const LSTART_COMMAND_LINE = new RegExp(`^\\s*(${LSTART})\\s*(.*)$`);

/** lstart in Teilen: Wochentag, Monat, Tag, Stunde, Minute, Sekunde, Jahr */
const LSTART_PARTS = /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) ([ \d]\d) (\d\d):(\d\d):(\d\d) (\d{4})$/;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Hat text genau die Form, die stableProcessInfo als Startzeit liefert, und
 * ist es ein wirklicher Zeitpunkt? Monat und Wochentag englisch (LC_ALL=C),
 * Tag im Monat vorhanden, Uhrzeit bis 23:59:59, Wochentag passt zum Datum
 * (in UTC, wie STABLE_PS_ENV). „Thu Nov 12 99:17:33 2026“ ist keiner.
 */
export function isStableLstart(text: string): boolean {
  const m = LSTART_PARTS.exec(text);
  if (!m) return false;
  const [, weekday, monthName, dayText, hh, mm, ss, yearText] = m;
  const month = MONTHS.indexOf(monthName);
  const [day, hour, minute, second, year] = [dayText, hh, mm, ss, yearText].map(t => Number(t.trim()));
  if (month < 0 || hour > 23 || minute > 59 || second > 59 || day < 1) return false;
  const date = new Date(Date.UTC(year, month, day, hour, minute, second));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day && WEEKDAYS[date.getUTCDay()] === weekday;
}

/**
 * Eine Schreibweise je Zeitpunkt: der Tag im Monat mit Leerzeichen aufgefüllt
 * wie bei ps lstart („Thu Oct  1 …“), auch wenn er als „01“ kam. null, wenn
 * text kein wirklicher Zeitpunkt ist (isStableLstart). Nur so vergleichen
 * sich zwei Startzeiten desselben Prozesses gleich.
 */
export function canonicalLstart(text: string): string | null {
  const m = LSTART_PARTS.exec(text);
  if (!m || !isStableLstart(text)) return null;
  const [, weekday, monthName, dayText, hh, mm, ss, year] = m;
  return `${weekday} ${monthName} ${String(Number(dayText.trim())).padStart(2, " ")} ${hh}:${mm}:${ss} ${year}`;
}

/** Startzeit (lstart, C und UTC) und Befehlszeile eines Prozesses */
export interface StableProcessInfo {
  started: string;
  command: string;
}

export function parseLstartCommand(text: string): StableProcessInfo | null {
  const m = LSTART_COMMAND_LINE.exec(text.split("\n")[0] ?? "");
  return m ? { started: m[1], command: m[2].trim() } : null;
}

/**
 * Startzeit und Befehl über ps mit STABLE_PS_ENV; null, wenn es die PID
 * nicht gibt oder ps scheitert. Bewusst getrennt von realProcessOps.identity:
 * die festgehaltenen Startzeiten laufender Jobs bleiben so vergleichbar.
 */
export function stableProcessInfo(pid: number): StableProcessInfo | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const result = Bun.spawnSync(["ps", "-ww", "-o", "lstart=,command=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, ...STABLE_PS_ENV },
    });
    if (result.exitCode !== 0) return null;
    return parseLstartCommand(result.stdout.toString());
  } catch {
    return null;
  }
}

/**
 * Arbeitsordner eines Prozesses: unter Linux /proc/<pid>/cwd, sonst lsof.
 * null, wenn er sich nicht feststellen lässt (fremder Nutzer, kein lsof).
 */
export function processCwd(pid: number): string | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === "linux") {
      return readlinkSync(`/proc/${pid}/cwd`);
    }
    // launchd und PM2 führen /usr/sbin nicht immer im PATH
    const lsof = Bun.which("lsof") ?? "/usr/sbin/lsof";
    const result = Bun.spawnSync([lsof, "-a", "-p", String(pid), "-d", "cwd", "-Fn"], {
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, ...STABLE_PS_ENV },
    });
    if (result.exitCode !== 0) return null;
    const line = result.stdout.toString().split("\n").find(l => l.startsWith("n"));
    return line ? line.slice(1) : null;
  } catch {
    return null;
  }
}
