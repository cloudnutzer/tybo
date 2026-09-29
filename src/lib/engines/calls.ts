/**
 * Abbruch-Register aller Motor-Aufrufe (/stop, Shutdown, Neustart). Jeder
 * Motor meldet seine laufenden Prozesse hier an, auch direkte Claude-Aufrufe
 * außerhalb des Chat-Kerns (Aux-Modelle, Check-in). Zusätzlich bricht
 * abortEngineCalls die Ausführungen unter dem Schlüssel ab
 * (execution-context), wie vorher abortClaudeCalls.
 */

import { abortExecutions, abortAllExecutions, checkAborted, currentExecution } from "../execution-context";

export interface EngineProc {
  pid: number;
  kill: () => void;
}

export interface EngineCallEntry {
  proc: EngineProc;
  aborted: boolean;
  /** Beendet den Prozessbaum; der Motor gibt ihn mit (in Tests ersetzbar) */
  terminate: (proc: EngineProc) => void;
  removeListener?: () => void;
}

const activeProcs = new Map<string, Set<EngineCallEntry>>();

/** Schlüssel eines Aufrufs: abortKey, sonst die laufende Ausführung, sonst "background" */
function keyFor(key: string | undefined): string {
  return key || currentExecution()?.key || "background";
}

/**
 * Meldet einen laufenden Prozess an. Wird die laufende Ausführung
 * abgebrochen (execution-context), wird auch der Prozess beendet.
 */
export function registerEngineCall(
  key: string | undefined,
  proc: EngineProc,
  terminate: (proc: EngineProc) => void
): EngineCallEntry {
  const k = keyFor(key);
  checkAborted();
  const entry: EngineCallEntry = { proc, aborted: false, terminate };
  let set = activeProcs.get(k);
  if (!set) {
    set = new Set();
    activeProcs.set(k, set);
  }
  set.add(entry);
  const signal = currentExecution()?.controller.signal;
  const abort = () => { entry.aborted = true; entry.terminate(proc); };
  signal?.addEventListener("abort", abort, { once: true });
  entry.removeListener = () => signal?.removeEventListener("abort", abort);
  return entry;
}

export function unregisterEngineCall(key: string | undefined, entry: EngineCallEntry | undefined): void {
  entry?.removeListener?.();
  if (!entry) return;
  const k = keyFor(key);
  const set = activeProcs.get(k);
  if (!set) return;
  set.delete(entry);
  if (set.size === 0) activeProcs.delete(k);
}

/**
 * Beendet alle laufenden Motor-Aufrufe unter einem Schlüssel (/stop) samt
 * Prozessbaum und bricht die Ausführungen darunter ab. Liefert die Zahl der
 * abgebrochenen Aufrufe (Ausführungen und Prozesse nicht doppelt gezählt).
 */
export function abortEngineCalls(key: string): number {
  const tasks = abortExecutions(key);
  const set = activeProcs.get(key);
  let killed = 0;
  for (const entry of set || []) {
    entry.aborted = true;
    entry.terminate(entry.proc);
    killed++;
  }
  return Math.max(tasks, killed);
}

/** Shutdown: alle Ausführungen und alle Motor-Aufrufe beenden */
export function abortAllEngineCalls(): void {
  abortAllExecutions();
  for (const key of activeProcs.keys()) abortEngineCalls(key);
}

/** Zahl der laufenden Motor-Prozesse über alle Motoren (der Neustart wartet auf 0) */
export function activeEngineCallCount(): number {
  let n = 0;
  for (const set of activeProcs.values()) n += set.size;
  return n;
}
