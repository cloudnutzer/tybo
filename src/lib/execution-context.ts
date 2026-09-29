import { AsyncLocalStorage } from "node:async_hooks";
import { totalmem } from "node:os";
import { BRAND } from "../brand";
import { capacityLogLine, resolveAgentCapacity, type AgentCapacity } from "./agent-capacity";

/** Belegte Plätze, während ein Turn auf einen freien wartet (Issue #188, Wartehinweis) */
export interface QueueWaitInfo {
  /** Tatsächlich belegte Plätze (ohne Wartende und Update-Bereiche) */
  running: number;
  /** Session-Schlüssel der Ausführungen auf diesen Plätzen, in Startreihenfolge */
  keys: string[];
}

/** Wartehinweis eines Update-Bereichs; notified gilt für den ganzen Turn */
interface QueueWaitHook {
  notify(info: QueueWaitInfo, stillWaiting: () => boolean): void | Promise<void>;
  delayMs: number;
  notified: boolean;
}

export interface ExecutionContext {
  key: string;
  agent: string;
  controller: AbortController;
  allowedTools?: string[];
  sessionLock?: boolean;
  queueWait?: QueueWaitHook;
}
const storage = new AsyncLocalStorage<ExecutionContext>();
const active = new Set<ExecutionContext>();
const tails = new Map<string, Promise<void>>();
/** Gesperrte Session-Schlüssel (Löschen eines Topics aus der WebUI, Issue #29), mit Zähler */
const blocked = new Map<string, number>();
/** Ausführungen, die gerade einen Platz belegen */
const holders = new Set<ExecutionContext>();
interface Waiter { task: ExecutionContext; grant(): void }
const waiters: Waiter[] = [];
/**
 * Grenze gleichzeitiger Ausführungen (Issue #208): MAX_AGENT_PROCESSES, sonst
 * nach Arbeitsspeicher. Erst beim ersten Platz oder beim Log bestimmt, nicht
 * beim Import (im Bot läuft loadEnv erst nach den Importen), danach fest bis
 * zum nächsten Start. Log und Warteschlange nutzen denselben Wert.
 */
let capacity: AgentCapacity | undefined;
let capacityLogged = false;
let memoryBytes: () => number = totalmem;
export function agentCapacity(): AgentCapacity {
  return (capacity ??= resolveAgentCapacity(process.env, memoryBytes()));
}
/** Einmal pro Prozess: gewählte Grenze und Grund ins Log (Bot-Start) */
export function logAgentCapacity(log: (line: string) => void = console.log): void {
  if (capacityLogged) return;
  capacityLogged = true;
  log(capacityLogLine(agentCapacity()));
}
/**
 * Bestimmt die Grenze beim nächsten Platz neu (Tests, die MAX_AGENT_PROCESSES
 * selbst setzen). totalmem ersetzt die Quelle des Arbeitsspeichers dauerhaft,
 * damit Tests nicht vom Rechner abhängen (tests/preload-env.ts).
 */
export function resetAgentCapacity(options: { totalmem?: () => number } = {}): void {
  capacity = undefined;
  capacityLogged = false;
  if (options.totalmem) memoryBytes = options.totalmem;
}

/** Nach so langem Warten auf einen Platz sagt tybo das im Gespräch */
export const QUEUE_NOTICE_DELAY_MS = 3000;

/**
 * Abbruch als echter AbortError (Issue #188). Nie signal.reason oder
 * throwIfAborted weiterreichen: im Bot kam dort einmal undefined an, und die
 * Prüfungen auf name === "AbortError" griffen nicht.
 */
export function abortError(message = "Ausführung abgebrochen"): DOMException {
  return new DOMException(message, "AbortError");
}
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

export const currentExecution = () => storage.getStore();
export function checkAborted(): void {
  if (currentExecution()?.controller.signal.aborted) throw abortError();
}
export function executionSignal(timeoutMs: number): AbortSignal {
  const signal = currentExecution()?.controller.signal;
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}
export function abortExecutions(key: string): number {
  let count = 0;
  for (const task of active) if (task.key === key && !task.controller.signal.aborted) {
    task.controller.abort(); count++;
  }
  return count;
}
export function abortAllExecutions(): void {
  for (const task of active) task.controller.abort();
}
/**
 * Läuft oder wartet für diesen Session-Schlüssel irgendeine Ausführung:
 * jeder Agent (runExecution, auch in der Warteschlange) und jeder
 * Update-Bereich (runCancelable). Issue #29: Löschschutz für Topics.
 */
export function isExecutionActive(key: string): boolean {
  for (const task of active) if (task.key === key) return true;
  return false;
}

function blockedError(): Error {
  return abortError("Session-Schlüssel ist gesperrt");
}

/**
 * Sperrt neue Ausführungen des Schlüssels, bis die zurückgegebene Freigabe
 * aufgerufen wird: runExecution und runCancelable enden dann sofort mit
 * AbortError, wie nach /stop. Einzige Änderung am Telegram-Verhalten aus
 * Issue #29: gilt nur für ein Topic, das gerade aus der WebUI gelöscht wird.
 */
export function blockExecutions(key: string): () => void {
  blocked.set(key, (blocked.get(key) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const n = (blocked.get(key) ?? 1) - 1;
    if (n > 0) blocked.set(key, n);
    else blocked.delete(key);
  };
}

export const isExecutionBlocked = (key: string) => blocked.has(key);

/** Antwort an einen Turn, der während des Neustarts ankommt (Issue #190) */
export const RESTART_PENDING_REPLY = `🔄 ${BRAND.name} startet gerade neu, bitte gleich noch einmal schicken.`;

/** Neuer Turn während der Annahmesperre; bewusst kein AbortError, damit er nicht still verschluckt wird */
export class RestartPendingError extends Error {
  constructor() {
    super(RESTART_PENDING_REPLY);
    this.name = "RestartPendingError";
  }
}
export function isRestartPendingError(e: unknown): boolean {
  return e instanceof Error && e.name === "RestartPendingError";
}

/** Zähler der Annahmesperren (closeIntake); > 0: keine neuen Turns */
let intakeClosed = 0;

/**
 * Annahmesperre beim Neustart (Issue #190): ab dem Entschluss nehmen
 * runExecution und runCancelable keine neuen Turns mehr an und werfen
 * RestartPendingError. Was schon läuft oder wartet, läuft aus: eine
 * Ausführung innerhalb einer noch aktiven Ausführung gilt nicht als neu.
 * Gibt die Freigabe zurück (Fehlerpfade dürfen keine Sperre hinterlassen).
 */
export function closeIntake(): () => void {
  intakeClosed++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    intakeClosed--;
  };
}

export const isIntakeClosed = () => intakeClosed > 0;

/** Darf hier ein Turn beginnen? Bei geschlossener Annahme nur innerhalb einer laufenden Ausführung */
function intakeOpenHere(): boolean {
  if (intakeClosed === 0) return true;
  const parent = currentExecution();
  return !!parent && active.has(parent);
}

/** Wartet, bis keine Ausführung des Schlüssels mehr läuft; false nach Ablauf der Frist. */
export async function waitForExecutions(key: string, timeoutMs: number, pollMs = 25): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (isExecutionActive(key)) {
    const left = end - Date.now();
    if (left <= 0) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, left)));
  }
  return true;
}

/** Running agent executions + Telegram update scopes (deferred restart waits for 0). */
export const activeExecutionCount = () => active.size;

/** Wartet auf p; ein Abbruch beendet das Warten sofort mit AbortError (p läuft weiter). */
function untilAborted(p: Promise<void>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

/**
 * Einen Platz belegen (FIFO). Ein Abbruch in der Schlange entfernt den
 * Eintrag sofort; er bekommt nie einen Platz und führt nichts mehr aus.
 * Nach delayMs Wartezeit einmal pro Turn der Wartehinweis.
 */
function acquireSlot(task: ExecutionContext): Promise<void> {
  const signal = task.controller.signal;
  if (signal.aborted) return Promise.reject(abortError());
  if (holders.size < agentCapacity().limit && waiters.length === 0) {
    holders.add(task);
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };
    const waiter: Waiter = {
      task,
      grant: () => {
        cleanup();
        holders.add(task);
        resolve();
      },
    };
    const onAbort = () => {
      const i = waiters.indexOf(waiter);
      if (i < 0) return;
      waiters.splice(i, 1);
      cleanup();
      reject(abortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    waiters.push(waiter);
    const hook = task.queueWait;
    if (hook && !hook.notified) {
      timer = setTimeout(() => {
        timer = undefined;
        if (hook.notified || !waiters.includes(waiter)) return;
        hook.notified = true;
        const info: QueueWaitInfo = { running: holders.size, keys: [...holders].map(t => t.key) };
        try {
          // stillWaiting: der Hinweis kann asynchron sein (Topic-Namen); vor dem
          // Versand prüft er, ob genau dieses Warten noch besteht
          void Promise.resolve(hook.notify(info, () => waiters.includes(waiter))).catch(() => {});
        } catch {
          // Ein fehlgeschlagener Hinweis darf das Warten nicht stören
        }
      }, hook.delayMs);
    }
  });
}

function releaseSlot(task: ExecutionContext): void {
  if (!holders.delete(task)) return;
  const next = waiters.shift();
  if (next) next.grant();
}

/** Holds the session lock from context loading through successful persistence. */
export async function runExecution<T>(key: string, agent: string, fn: () => Promise<T>, allowedTools?: string[]): Promise<T> {
  const parent = currentExecution();
  // Annahmesperre vor dem frühen Rücksprung (Issue #190): ein geerbter Kontext,
  // dessen Ausführung schon endete (verzögerter Aufruf), gilt nicht als laufend
  if (!intakeOpenHere()) throw new RestartPendingError();
  if (parent?.sessionLock && parent.key === key && parent.agent === agent) { checkAborted(); return fn(); }
  if (blocked.has(key)) throw blockedError();
  const lock = `${key}:${agent}`;
  if (active.size >= 64) throw new Error("Agent queue is full");
  const task: ExecutionContext = { key, agent, controller: new AbortController(), allowedTools, sessionLock: true, queueWait: parent?.queueWait };
  const signal = task.controller.signal;
  const abortChild = () => task.controller.abort();
  if (parent?.controller.signal.aborted) abortChild();
  parent?.controller.signal.addEventListener("abort", abortChild, { once: true });
  active.add(task);
  // Session-Sperre: der Nächste wartet auf den Vorgänger und auf diesen
  // Eintrag. Endet dieser abgebrochen früher, wartet der Nächste trotzdem
  // weiter auf den Vorgänger (keine Umgehung der Sperre).
  const previous = tails.get(lock) ?? Promise.resolve();
  let done!: () => void;
  const own = new Promise<void>(resolve => (done = resolve));
  const tail = previous.then(() => own);
  tails.set(lock, tail);
  void tail.then(() => { if (tails.get(lock) === tail) tails.delete(lock); });
  try {
    await untilAborted(previous, signal);
    await acquireSlot(task);
    try {
      if (signal.aborted) throw abortError();
      return await storage.run(task, fn);
    } finally { releaseSlot(task); }
  } catch (error) {
    // Nach einem Abbruch immer ein echter AbortError, egal was fn wirft
    if (signal.aborted && !isAbortError(error)) throw abortError();
    throw error;
  } finally {
    done();
    parent?.controller.signal.removeEventListener("abort", abortChild);
    active.delete(task);
  }
}

export interface CancelableOptions {
  /**
   * Wartehinweis (Issue #188): wartet eine Ausführung in diesem Bereich
   * länger als queueNoticeMs auf einen Platz, einmal pro Bereich aufgerufen.
   * Ohne Angabe gilt der Hinweis eines umgebenden Bereichs. stillWaiting
   * sagt, ob genau dieses Warten noch besteht (nicht gestartet, nicht abgebrochen).
   */
  onQueueWait?(info: QueueWaitInfo, stillWaiting: () => boolean): void | Promise<void>;
  queueNoticeMs?: number;
}

/** Covers all stages of a Telegram update, including callbacks and aux tasks. */
export async function runCancelable<T>(key: string, fn: () => Promise<T>, options: CancelableOptions = {}): Promise<T> {
  if (blocked.has(key)) throw blockedError();
  if (!intakeOpenHere()) throw new RestartPendingError();
  if (active.size >= 64) throw new Error("Agent queue is full");
  const queueWait: QueueWaitHook | undefined = options.onQueueWait
    ? { notify: options.onQueueWait, delayMs: options.queueNoticeMs ?? QUEUE_NOTICE_DELAY_MS, notified: false }
    : currentExecution()?.queueWait;
  const task: ExecutionContext = { key, agent: "update", controller: new AbortController(), queueWait };
  active.add(task);
  try { return await storage.run(task, fn); }
  catch (error) {
    if (task.controller.signal.aborted && !isAbortError(error)) throw abortError();
    throw error;
  }
  finally { active.delete(task); }
}
