/**
 * Abbruch-Register aller Motor-Aufrufe (/stop, Shutdown, Neustart). Jeder
 * Motor meldet seine laufenden Prozesse hier an, auch direkte Claude-Aufrufe
 * außerhalb des Chat-Kerns (Aux-Modelle, Check-in). Zusätzlich bricht
 * abortEngineCalls die Ausführungen unter dem Schlüssel ab
 * (execution-context), wie vorher abortClaudeCalls.
 */

import { abortExecutions, abortAllExecutions, checkAborted, currentExecution } from "../execution-context";
import { hostPlatform, signalTree, startsOwnGroup, type ProcessPlatform, type TreeProc } from "./platform";

export interface EngineProc {
  pid: number;
  kill: () => void;
  /** Bei echten Subprozessen vorhanden; das Ende des Hauptprozesses beendet nicht seine Gruppe */
  exited?: Promise<unknown>;
}

export interface EngineCallEntry {
  proc: EngineProc;
  aborted: boolean;
  /** Beendet den Prozessbaum; der Motor gibt ihn mit (in Tests ersetzbar) */
  terminate: (proc: EngineProc) => void;
  removeListener?: () => void;
  /**
   * Zählt der Prozess gerade als Verarbeitung? Fehlt: immer. Die offene
   * Sitzung des Telefonhörers (Issue #257) zählt nur während eines Turns,
   * damit ein angeforderter Neustart nicht auf das Ende des Gesprächs wartet.
   */
  busy?: () => boolean;
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
  terminate: (proc: EngineProc) => void,
  options: { busy?: () => boolean } = {}
): EngineCallEntry {
  const k = keyFor(key);
  checkAborted();
  const entry: EngineCallEntry = { proc, aborted: false, terminate, ...(options.busy ? { busy: options.busy } : {}) };
  let set = activeProcs.get(k);
  if (!set) {
    set = new Set();
    activeProcs.set(k, set);
  }
  set.add(entry);
  if (proc.exited) trackEngineProcess(proc as EngineProc & { exited: Promise<unknown> });
  const signal = currentExecution()?.controller.signal;
  const abort = () => { entry.aborted = true; entry.terminate(proc); };
  signal?.addEventListener("abort", abort, { once: true });
  entry.removeListener = () => signal?.removeEventListener("abort", abort);
  return entry;
}

export function unregisterEngineCall(key: string | undefined, entry: EngineCallEntry | undefined): void {
  entry?.removeListener?.();
  if (!entry) return;
  releaseEngineProcess(entry.proc);
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

/**
 * Besitz der Motor-Prozessgruppen, unabhängig vom Abbruch-Register (Issue
 * #561). Aufrufe, Prüfungen und Abbruch-Nachläufe gehen alle hier hindurch.
 * exited, Abmeldung und gesendetes SIGKILL bedeuten nur "draining". Erst
 * eine nachweislich leere Gruppe gibt den Besitz frei. Sonst verschwinden
 * lebende Kinder nach Erfolg, Zeitlimit oder Abbruch aus dem Shutdown.
 */
interface TrackedProcess {
  state: "running" | "draining";
  terminate?: (proc: EngineProc) => void;
}
const trackedProcs = new Map<EngineProc, TrackedProcess>();
let cleanupTimer: ReturnType<typeof setTimeout> | undefined;

function engineTreeAlive(proc: TreeProc, platform: Pick<ProcessPlatform, "os" | "groupAlive">): boolean {
  if (!(proc.pid > 1)) return false;
  if (startsOwnGroup(platform.os)) {
    try {
      return platform.groupAlive(proc.pid);
    } catch {
      // Ohne Nachweis bleibt der Besitz erhalten.
      return true;
    }
  }
  return proc.exitCode === null || (proc.exitCode === undefined && !proc.signalCode);
}

function pruneEngineProcesses(): void {
  for (const [proc, entry] of trackedProcs) {
    if (entry.state === "draining" && !engineTreeAlive(proc, hostPlatform)) trackedProcs.delete(proc);
  }
}

function releaseEngineProcess(proc: EngineProc): void {
  const entry = trackedProcs.get(proc);
  if (!entry) return;
  entry.state = "draining";
  pruneEngineProcesses();
  scheduleProcessCleanup();
}

/** Nur beobachten, nie signalisieren; hält weder Bot noch Tests am Leben. */
function scheduleProcessCleanup(): void {
  if (cleanupTimer || ![...trackedProcs.values()].some(entry => entry.state === "draining")) return;
  cleanupTimer = setTimeout(() => {
    cleanupTimer = undefined;
    pruneEngineProcesses();
    scheduleProcessCleanup();
  }, ENGINE_EXIT_POLL_MS);
  cleanupTimer.unref();
}

/**
 * Hat das Beenden unter systemd begonnen (abortAllEngineCalls mit probes)? Danach startet keine
 * Prüfung mehr einen Prozess (Issue #561), auch nicht die nächste Phase
 * einer laufenden Prüfung (`codex login status` nach `codex --version`).
 */
let shuttingDown = false;

export function engineShutdownStarted(): boolean {
  return shuttingDown;
}

/** Nur für Tests: Beenden zurücknehmen (tests/preload-env.ts vor jedem Test) */
export function resetEngineShutdownForTests(): void {
  shuttingDown = false;
}

/**
 * Verfolgt die Gruppe bis zu ihrem Ende; PID 0 und 1 (Attrappen) nie.
 * terminate beendet laufende Prüfprozesse beim Beenden unter systemd.
 * Bereits freigegebene Aufrufe werden dabei nicht noch einmal abgebrochen.
 */
export function trackEngineProcess(proc: EngineProc & { exited: Promise<unknown> }, terminate?: (proc: EngineProc) => void): void {
  if (!(proc.pid > 1)) return;
  const existing = trackedProcs.get(proc);
  if (existing) {
    if (terminate) existing.terminate = terminate;
    return;
  }
  trackedProcs.set(proc, { state: "running", terminate });
  const release = () => releaseEngineProcess(proc);
  void proc.exited.then(release, release);
}

/** Zahl der noch besessenen Prozessgruppen, auch nach dem Ende des Hauptprozesses (Tests) */
export function trackedEngineProcCount(): number {
  pruneEngineProcesses();
  return trackedProcs.size;
}

/**
 * Motor-Prozesse im Abbruch-Nachlauf (Issue #561): vom ersten Signal bis
 * nach dem geplanten SIGKILL. Ein abgebrochener Aufruf meldet sich im
 * Register ab, sobald der Hauptprozess und seine Ausgabeströme enden; Kinder,
 * die das erste Signal übergehen, leben in seiner Prozessgruppe weiter, bis
 * das SIGKILL kommt. Das Beenden wartet auch auf diese Gruppen.
 */
const terminatingProcs = new Set<EngineProc>();

/**
 * Verfolgt einen Prozess ab dem ersten Signal; die Rückgabe ruft der Motor
 * nach dem SIGKILL des Nachlaufs auf. PID 0 und 1 (Attrappen) nie.
 */
export function trackEngineTermination(proc: EngineProc): () => void {
  if (!(proc.pid > 1)) return () => {};
  if (proc.exited) trackEngineProcess(proc as EngineProc & { exited: Promise<unknown> });
  terminatingProcs.add(proc);
  return () => {
    terminatingProcs.delete(proc);
    releaseEngineProcess(proc);
  };
}

/** Zahl der Prozesse im Abbruch-Nachlauf (Tests) */
export function terminatingEngineProcCount(): number {
  return terminatingProcs.size;
}

export interface EngineAbortOptions {
  /**
   * Auch die verfolgten Prüfprozesse beenden und danach keine Prüfung mehr
   * starten (engineShutdownStarted). Nur beim Beenden unter systemd
   * (src/app/bot-shutdown.ts, Issue #561); unter PM2, launchd und ohne
   * Dienst bleibt es beim bisherigen Ablauf.
   */
  probes?: boolean;
}

/**
 * Shutdown: alle Ausführungen und alle Motor-Aufrufe beenden; mit probes
 * auch alle verfolgten Prüfprozesse, danach startet keine Prüfung mehr
 * (engineShutdownStarted). Liefert die Prozesse, auf deren Ende das Beenden
 * warten soll (waitForEngineExit): die angemeldeten Aufrufe, mit probes die
 * besessenen Gruppen und die Prozesse im Abbruch-Nachlauf. Lebende Kinder
 * beendeter Aufrufe oder Prüfungen bekommen unter systemd SIGKILL, ohne den
 * abgeschlossenen Auftrag noch einmal abzubrechen. waitForEngineExit wartet
 * auch nach diesem Signal auf das Ende der Gruppe.
 */
export function abortAllEngineCalls(options: EngineAbortOptions = {}): EngineProc[] {
  if (options.probes) shuttingDown = true;
  const procs = new Set([...activeProcs.values()].flatMap(set => [...set].map(entry => entry.proc)));
  abortAllExecutions();
  for (const key of [...activeProcs.keys()]) abortEngineCalls(key);
  for (const proc of terminatingProcs) procs.add(proc);
  if (!options.probes) return [...procs];
  pruneEngineProcesses();
  for (const [proc, entry] of [...trackedProcs]) {
    try {
      if (!procs.has(proc)) {
        if (entry.state === "draining") signalTree(proc, "SIGKILL");
        else entry.terminate?.(proc);
      }
    } catch {
      // schon beendet: waitForEngineExit prüft die Gruppe ohnehin
    }
    procs.add(proc);
  }
  // Prüfprozesse, die eben erst ihr erstes Signal bekamen, stehen jetzt auch im Nachlauf
  for (const proc of terminatingProcs) procs.add(proc);
  return [...procs];
}

/**
 * Höchstens so lange wartet das Beenden auf die abgebrochenen Motor-Prozesse.
 * Länger als der längste Weg bis SIGKILL (Codex und OpenCode: 3 Sekunden nach
 * SIGINT, Claude: 1,5 Sekunden nach SIGTERM), damit dessen Zeitgeber noch im
 * laufenden Bot feuert.
 */
export const ENGINE_EXIT_WAIT_MS = 5_000;
const ENGINE_EXIT_POLL_MS = 50;

export interface EngineExitDeps {
  platform?: Pick<ProcessPlatform, "os" | "groupAlive" | "signalGroup" | "taskkill">;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Wartet, bis die Prozessbäume der abgebrochenen Motor-Aufrufe beendet sind
 * (Issue #561). Unter systemd mit KillMode=process räumt nach dem Ende des
 * Bots niemand mehr auf; ohne dieses Warten endete der Bot vor dem
 * SIGKILL-Nachlauf seiner Motoren, und ihre Prozesse blieben stehen.
 * Hintergrund-Jobs stehen nicht im Register und bleiben unberührt. Wer nach
 * timeoutMs noch lebt, bekommt SIGKILL. Liefert die Zahl dieser Nachzügler.
 */
export async function waitForEngineExit(procs: readonly EngineProc[], timeoutMs = ENGINE_EXIT_WAIT_MS, deps: EngineExitDeps = {}): Promise<number> {
  const platform = deps.platform ?? hostPlatform;
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? (ms => new Promise<void>(done => setTimeout(done, ms)));
  const alive = (proc: TreeProc) => engineTreeAlive(proc, platform);
  let waiting = (procs as readonly TreeProc[]).filter(alive);
  const until = now() + timeoutMs;
  while (waiting.length && now() < until) {
    await sleep(ENGINE_EXIT_POLL_MS);
    waiting = waiting.filter(alive);
  }
  const full: ProcessPlatform = { ...hostPlatform, ...platform };
  for (const proc of waiting) signalTree(proc, "SIGKILL", full);
  return waiting.length;
}

/** Zahl der laufenden Motor-Prozesse über alle Motoren (der Neustart wartet auf 0); ruhende offene Sitzungen zählen nicht */
export function activeEngineCallCount(): number {
  let n = 0;
  for (const set of activeProcs.values()) for (const entry of set) if (!entry.busy || entry.busy()) n++;
  return n;
}

/** Angemeldete Motor-Prozesse, auch ruhende offene Sitzungen (Tests, Aufräumen) */
export function registeredEngineCallCount(): number {
  let n = 0;
  for (const set of activeProcs.values()) n += set.size;
  return n;
}
