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
