/** Verbrauchsbericht von Claude Code (M14-21), ohne Freitext oder Zusatzguthaben. */
import type { UsageWindow, UsageWindowId } from "./usage";
import { recordUsage } from "./usage";
import { DEFAULT_CLAUDE_AUX } from "../aux-targets";
import { callClaudeStreaming } from "../claude";
import { claudeMissing } from "../claude-availability";
import { engineAutoDeps, type EngineAutoDeps } from "../engine-auto-sync";
import { applyMeasurement } from "../engine-switch";
import { withoutExecution } from "../execution-context";
import { PROJECT_ROOT } from "../env";
import { engineAuto } from "../settings";
import { engineShutdownStarted } from "./calls";
import { claudeUsesSubscription } from "./claude-auth";

/** Fünf Sekunden Reserve für Prozessende und Ablage unter dem 30-s-Deckel. */
export const CLAUDE_USAGE_TIMEOUT_MS = 25_000;
export const CLAUDE_USAGE_CHAT_GAP_MS = 10 * 60_000;
export const CLAUDE_USAGE_WATCH_GAP_MS = 30 * 60_000;
export const CLAUDE_USAGE_WATCH_TICK_MS = 5 * 60_000;
export type ClaudeUsageResult =
  | { status: "measured" }
  | { status: "failed"; reason: "Zeitlimit" | "abgebrochen" | "Programmfehler" | "kein Bericht" | "keine Fenster" | "nicht gespeichert" }
  | { status: "not-measurable"; reason: "api-key" | "missing" | "shutdown" };

export interface ClaudeUsageDeps extends EngineAutoDeps {
  call: typeof callClaudeStreaming;
  record: typeof recordUsage;
  subscription(): boolean;
  missing(): boolean;
  shutdown(): boolean;
  cwd(): string;
  log(line: string): void;
  every(ms: number, run: () => Promise<void>): () => void;
  defer(run: () => Promise<void>): () => void;
}

export interface ClaudeUsageOptions {
  signal?: AbortSignal;
  /** Die Prüfung von Hand bewertet selbst und zählt dabei aufgehobene Sperren. */
  evaluate?: boolean;
}

/** Ein Dienst je Bot, austauschbare Programm-/Uhr-/Ablagegrenzen für Tests. */
export function createClaudeUsageService(deps: Partial<ClaudeUsageDeps> = {}) {
  const d: ClaudeUsageDeps = {
    ...engineAutoDeps, call: callClaudeStreaming, record: recordUsage,
    subscription: claudeUsesSubscription, missing: claudeMissing, shutdown: engineShutdownStarted,
    cwd: () => PROJECT_ROOT, log: line => console.warn(line),
    every: (ms, run) => { const timer = setInterval(() => void run(), ms); timer.unref(); return () => clearInterval(timer); },
    defer: run => { const timer = setTimeout(() => void run(), 0); timer.unref(); return () => clearTimeout(timer); },
    ...deps,
  };
  let running: { promise: Promise<ClaudeUsageResult>; evaluate: boolean } | undefined;
  let lastAttemptAt: number | undefined;
  let lastReportAt = -Infinity;
  let stopped = false;
  let cancelDeferred: (() => void) | undefined;

  function log(line: string): void { try { d.log(line); } catch { /* Das Log darf keine Messung verwerfen. */ } }

  function failed(reason: Extract<ClaudeUsageResult, { status: "failed" }>["reason"]): ClaudeUsageResult {
    log(`[Motor] Messlauf Claude Code ohne Ergebnis (${reason})`);
    return { status: "failed", reason };
  }

  async function run(options: ClaudeUsageOptions): Promise<ClaudeUsageResult> {
    try {
      const result = await d.call({
        prompt: "/usage", model: DEFAULT_CLAUDE_AUX, cwd: d.cwd(),
        timeoutMs: CLAUDE_USAGE_TIMEOUT_MS, quiet: true, signal: options.signal,
      });
      if (options.signal?.aborted || result.aborted || d.shutdown()) return failed("abgebrochen");
      if (result.timedOut) return failed("Zeitlimit");
      const now = d.now();
      const windows = usageFromClaudeReport(result.usageReport, now);
      if (!windows.length) return failed(result.isError ? "Programmfehler" : result.usageReport ? "keine Fenster" : "kein Bericht");
      const saved = await d.record("claude", windows, { signal: options.signal });
      if (options.signal?.aborted) return failed("abgebrochen");
      if (!saved.accepted.length) return failed("nicht gespeichert");
      lastReportAt = Math.max(lastReportAt, now);
      if (running?.evaluate) {
        const usage = await d.readUsage(d.now());
        if (options.signal?.aborted || d.shutdown()) return failed("abgebrochen");
        const measured = { claude: usage.claude.filter(window => saved.accepted.includes(window.id)), codex: [], opencode: [], api: [] };
        const auto = engineAuto(d.readSettings());
        // Reine Mutation: auch beim Nachholen nach Schreibfehlern derselbe Stand.
        await d.updateState(state => applyMeasurement(state, measured, now, auto));
      }
      log("[Motor] Messlauf Claude Code mit Ergebnis");
      return { status: "measured" };
    } catch {
      return failed(options.signal?.aborted ? "abgebrochen" : "Programmfehler");
    }
  }

  function measure(options: ClaudeUsageOptions = {}): Promise<ClaudeUsageResult> {
    if (options.signal?.aborted) return Promise.resolve({ status: "failed", reason: "abgebrochen" });
    if (running) {
      // Bewertung und Abbruch gehören dem ersten Anforderer. Der Prüfkern
      // zählt eine zwischenzeitliche Freigabe anhand seines Anfangsstands.
      return waitForMeasurement(running.promise, options.signal);
    }
    if (!d.subscription()) return Promise.resolve({ status: "not-measurable", reason: "api-key" });
    if (d.missing()) return Promise.resolve({ status: "not-measurable", reason: "missing" });
    if (d.shutdown()) return Promise.resolve({ status: "not-measurable", reason: "shutdown" });
    lastAttemptAt = d.now();
    // Auch Prüfung von Hand im Chat darf keine Gesprächskennung vererben.
    const promise = withoutExecution(() => run(options)).finally(() => { running = undefined; });
    running = { promise, evaluate: options.evaluate !== false };
    return promise;
  }

  async function measureIfDue(gapMs: number, watch: boolean): Promise<void> {
    try {
      if (stopped || !d.subscription() || d.missing() || d.shutdown()) return;
      const blocked = () => d.readState().blocks.some(block => block.engine === "claude"
        && (block.cause === "threshold" || block.cause === "limit") && Date.parse(block.until) > d.now());
      if (watch && !blocked()) return;
      const usage = await d.readUsage(d.now());
      if (stopped || d.shutdown() || watch && !blocked()) return;
      // Die Datei dient nur als Startwert. Spätere stream-Werte und gescheiterte
      // Versuche dürfen die Drossel im Arbeitsspeicher nicht löschen.
      lastReportAt = Math.max(lastReportAt, ...usage.claude.filter(w => w.source === "report").map(w => Date.parse(w.measuredAt)));
      const last = Math.max(lastAttemptAt ?? -Infinity, lastReportAt);
      const age = d.now() - last;
      if (watch ? age < gapMs : age <= gapMs) return;
      await measure();
    } catch { failed("Programmfehler"); }
  }

  function afterChat(): void {
    if (stopped || cancelDeferred) return;
    cancelDeferred = withoutExecution(() => d.defer(async () => {
      cancelDeferred = undefined;
      await measureIfDue(CLAUDE_USAGE_CHAT_GAP_MS, false);
    }));
  }

  function startWatch(): () => void {
    stopped = false;
    const stop = withoutExecution(() => d.every(CLAUDE_USAGE_WATCH_TICK_MS,
      () => measureIfDue(CLAUDE_USAGE_WATCH_GAP_MS, true)));
    return () => { stopped = true; stop(); cancelDeferred?.(); cancelDeferred = undefined; };
  }

  return { measure, afterChat, startWatch, lastAttemptAt: () => lastAttemptAt };
}

/** Nur das Warten eines späteren Anforderers endet; der erste besitzt den Lauf. */
function waitForMeasurement(promise: Promise<ClaudeUsageResult>, signal?: AbortSignal): Promise<ClaudeUsageResult> {
  if (!signal) return promise;
  return new Promise(resolve => {
    const abort = () => resolve({ status: "failed", reason: "abgebrochen" });
    signal.addEventListener("abort", abort, { once: true });
    void promise.then(result => { signal.removeEventListener("abort", abort); resolve(result); });
    if (signal.aborted) abort();
  });
}

const claudeUsage = createClaudeUsageService();
export const measureClaudeUsage = claudeUsage.measure;
export const startClaudeUsageWatch = claudeUsage.startWatch;

let afterChat: (() => void) | undefined;
/** Erst die Verdrahtung des Bots aktiviert Messungen; reine Imports starten nichts. */
export function setClaudeUsageAfterChat(run: (() => void) | null): void { afterChat = run ?? undefined; }
export function scheduleClaudeUsageAfterChat(): void { afterChat?.(); }
export const requestClaudeUsageAfterChat = claudeUsage.afterChat;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function reportWindowId(limit: Record<string, unknown>): UsageWindowId | undefined {
  if (limit.kind === "session" || limit.kind === "weekly_all") return limit.kind;
  if (limit.kind !== "weekly_scoped" || !isRecord(limit.scope) || !isRecord(limit.scope.model)) return;
  const displayName = limit.scope.model.display_name;
  if (typeof displayName !== "string") return;
  const lower = displayName.toLowerCase();
  const family = ["fable", "opus", "sonnet", "haiku"].find(name => lower.includes(name))
    ?? lower.replace(/[^a-z0-9]/g, "-").slice(0, 40);
  if (!/[a-z0-9]/.test(family)) return;
  return `weekly_scoped:${family}`;
}

/** Rein: nur verwertbare Fenster, Messzeit ist das Ende des Laufs (Millisekunden). */
export function usageFromClaudeReport(report: unknown, finishedAt: number): UsageWindow[] {
  if (!isRecord(report) || !isRecord(report.rate_limits) || !Array.isArray(report.rate_limits.limits)) return [];
  const date = new Date(finishedAt);
  if (!Number.isFinite(date.getTime())) return [];
  const measuredAt = date.toISOString();
  const windows = new Map<UsageWindowId, UsageWindow>();
  for (const limit of report.rate_limits.limits) {
    if (!isRecord(limit)) continue;
    const id = reportWindowId(limit);
    if (!id || typeof limit.percent !== "number" || !Number.isFinite(limit.percent)) continue;
    const reset = typeof limit.resets_at === "string" ? new Date(limit.resets_at) : undefined;
    windows.set(id, {
      id, percent: Math.round(Math.max(0, Math.min(100, limit.percent))), measuredAt, source: "report",
      ...(reset && Number.isFinite(reset.getTime()) ? { resetsAt: reset.toISOString() } : {}),
    });
  }
  return [...windows.values()];
}
