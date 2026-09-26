import { AsyncLocalStorage } from "node:async_hooks";

export interface ExecutionContext { key: string; agent: string; controller: AbortController; allowedTools?: string[]; sessionLock?: boolean }
const storage = new AsyncLocalStorage<ExecutionContext>();
const active = new Set<ExecutionContext>();
const tails = new Map<string, Promise<unknown>>();
/** Gesperrte Session-Schlüssel (Löschen eines Topics aus der WebUI, Issue #29), mit Zähler */
const blocked = new Map<string, number>();
let running = 0;
const waiters: (() => void)[] = [];
const capacity = Math.max(1, Number(process.env.MAX_AGENT_PROCESSES) || 3);

export const currentExecution = () => storage.getStore();
export function checkAborted(): void { currentExecution()?.controller.signal.throwIfAborted(); }
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
  return new DOMException("Session-Schlüssel ist gesperrt", "AbortError");
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

/** Holds the session lock from context loading through successful persistence. */
export async function runExecution<T>(key: string, agent: string, fn: () => Promise<T>, allowedTools?: string[]): Promise<T> {
  const parent = currentExecution();
  if (parent?.sessionLock && parent.key === key && parent.agent === agent) { checkAborted(); return fn(); }
  if (blocked.has(key)) throw blockedError();
  const lock = `${key}:${agent}`;
  if (active.size >= 64) throw new Error("Agent queue is full");
  const task: ExecutionContext = { key, agent, controller: new AbortController(), allowedTools, sessionLock: true };
  const abortChild = () => task.controller.abort();
  if (parent?.controller.signal.aborted) abortChild();
  parent?.controller.signal.addEventListener("abort", abortChild, { once: true });
  active.add(task);
  const previous = tails.get(lock) || Promise.resolve();
  const promise = previous.catch(() => {}).then(async () => {
    task.controller.signal.throwIfAborted();
    if (running >= capacity) await new Promise<void>(resolve => waiters.push(resolve));
    else running++;
    try {
      task.controller.signal.throwIfAborted();
      return await storage.run(task, fn);
    } finally { const next = waiters.shift(); if (next) next(); else running--; }
  });
  tails.set(lock, promise);
  try { return await promise; }
  finally { parent?.controller.signal.removeEventListener("abort", abortChild); active.delete(task); if (tails.get(lock) === promise) tails.delete(lock); }
}

/** Covers all stages of a Telegram update, including callbacks and aux tasks. */
export async function runCancelable<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (blocked.has(key)) throw blockedError();
  if (active.size >= 64) throw new Error("Agent queue is full");
  const task: ExecutionContext = { key, agent: "update", controller: new AbortController() };
  active.add(task);
  try { return await storage.run(task, fn); }
  finally { active.delete(task); }
}
