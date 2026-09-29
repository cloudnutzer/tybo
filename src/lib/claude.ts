import { checkAborted, currentExecution } from "./execution-context";
import {
  abortEngineCalls,
  abortAllEngineCalls,
  activeEngineCallCount,
  registerEngineCall,
  unregisterEngineCall as unregisterAbortable,
  type EngineCallEntry,
  type EngineProc,
} from "./engines/calls";
import { terminateProcessTree } from "./process-tree";
/**
 * Go - Claude Code Subprocess Spawner
 *
 * Spawns claude CLI as a subprocess for AI processing.
 * Handles session resumption, timeouts, cleanup, and streaming progress.
 */

import { spawn } from "bun";
import { optionalEnv } from "./env";
import { MODEL_IDS } from "./model-router";
import * as creditGuard from "./credit-guard";
import { toolUsesFromEvent, type TurnTools } from "./turn-tools";
import { subprocessEnv } from "./subprocess-env";

const IS_MACOS = process.platform === "darwin";
const IS_WINDOWS = process.platform === "win32";
const CLAUDE_PATH = process.env.CLAUDE_PATH || "claude";
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";

/**
 * Default reasoning effort per model. Opus/Fable → high (seit dem
 * Opus-5.5-Wechsel am 22.9.2026, vorher xhigh); other tiers let the
 * CLI/settings decide. Overridable via ClaudeOptions.effort or the
 * CLAUDE_EFFORT env var.
 */
export function defaultEffort(model: string): string | undefined {
  if (process.env.CLAUDE_EFFORT) return process.env.CLAUDE_EFFORT;
  return model.includes("opus") || model.includes("fable") ? "high" : undefined;
}

export { conversationEnv } from "./subprocess-env";

/**
 * Umgebung eines CLI-Subprozesses (Issue #54): ohne Geheimnisse außer den
 * Freigaben, ohne CLAUDECODE, mit TYBO_SUBPROCESS=1 und dem Gespräch des
 * laufenden Aufrufs. Die Variable
 * markiert jeden Subprozess von tybo;
 * Hooks in .claude/settings.local.json prüfen darauf: Der impeccable-Stop-Hook
 * brachte in langen Sessions alte Befunde zurück, und nur die letzte
 * Nachricht kam in Telegram an (9.9.2026).
 */
function spawnEnv(cwd: string): Record<string, string> {
  return subprocessEnv({ cwd, home: HOME_DIR, conversationKey: currentExecution()?.key });
}

/** Prozessstart; nur Tests ersetzen ihn (setSpawnForTests), nie global process.env */
let spawnProcess: typeof spawn = spawn;

/** Nur für Tests: Prozessstart durch eine Attrappe ersetzen, null stellt zurück. */
export function setSpawnForTests(fn: typeof spawn | null): void {
  spawnProcess = fn ?? spawn;
}

/**
 * Uhr, Timer und Prozessbeendigung der Claude-Aufrufe (Issue #178). Nur Tests
 * ersetzen sie (setRuntimeForTests): eine Attrappe mit pid 0 darf nie echt
 * beendet werden, process.kill(-0) träfe die eigene Prozessgruppe.
 */
interface ClaudeRuntime {
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  terminate: typeof terminateProcessTree;
}

const defaultRuntime: ClaudeRuntime = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  terminate: terminateProcessTree,
};

let runtime: ClaudeRuntime = defaultRuntime;

/** Nur für Tests: Uhr, Timer und Prozessbeendigung ersetzen, null stellt zurück. */
export function setRuntimeForTests(r: Partial<ClaudeRuntime> | null): void {
  runtime = r ? { ...defaultRuntime, ...r } : defaultRuntime;
}

/** Wie oft callClaudeStreaming prüft, ob die Leerlauf-Grenze überschritten ist */
export const IDLE_CHECK_INTERVAL_MS = 15_000;

export interface ClaudeOptions {
  prompt: string;
  outputFormat?: "json" | "text";
  allowedTools?: string[];
  resumeSessionId?: string;
  timeoutMs?: number;
  cwd?: string;
  maxTurns?: string;
  /** Claude model to pin the subprocess to. Defaults to the latest Opus. */
  model?: string;
  /** Reasoning effort level (low|medium|high|xhigh). Defaults to high for Opus. */
  effort?: string;
  /**
   * Registers the subprocess under this key so /stop can kill it via
   * abortClaudeCalls(key). Typically the topic's session key.
   */
  abortKey?: string;
}

export interface ClaudeStreamOptions extends ClaudeOptions {
  /** Called when a tool starts executing. Throttled to max 1 call per 5s. */
  onToolStart?: (toolName: string) => void;
  /**
   * Called when the first meaningful text chunk arrives (plan/thinking).
   * fullText is the untruncated text block the snippet was cut from.
   */
  onFirstText?: (snippet: string, fullText: string) => void;
  /**
   * Leerlauf-Grenze (Issue #178): kommt so lange keine vollständige
   * stream-json-Zeile, wird der Prozessbaum beendet (timeoutKind "idle").
   * Ohne Angabe gilt nur timeoutMs, andere Aufrufer erben keine neue Grenze.
   */
  idleTimeoutMs?: number;
}

export interface ClaudeResult {
  text: string;
  sessionId?: string;
  isError: boolean;
  /** Anthropic's reported cost for this call (from json output), if available. */
  costUsd?: number;
  /** True when the call was killed via abortClaudeCalls() (/stop) — callers
   * must not treat this as an error (no fallback LLM, no fresh-session retry). */
  aborted?: boolean;
  /** True when the subprocess hit timeoutMs and was killed. Callers should
   * tell the user (the run's work is gone) and skip a fresh-session retry,
   * which would just burn another full timeout window. */
  timedOut?: boolean;
  /**
   * Nur callClaudeStreaming (Issue #178): warum das Zeitlimit griff. "idle":
   * länger als idleTimeoutMs keine stream-json-Zeile, "total": timeoutMs als
   * Obergrenze der Gesamtzeit.
   */
  timeoutKind?: "idle" | "total";
  /**
   * Werkzeuge dieses Aufrufs (Issue #53), aus stream-json bzw. json mit
   * --verbose. Fehlt, wenn die CLI keine Angaben lieferte (Textformat, altes
   * json-Format): dann sind sie unbekannt, nicht leer.
   */
  tools?: TurnTools;
  /**
   * Nur callClaudeStreaming bei timedOut (Issue #179): die letzten
   * Werkzeugschritte in Reihenfolge, höchstens MAX_RUN_STEPS. Die Eingabe
   * steht ungekürzt drin, damit Geheimnisse vor jeder Kürzung maskiert
   * werden können; gekürzt wird erst im Bericht.
   */
  steps?: RunStep[];
  /** Nur bei timedOut (Streaming): der letzte Textblock von Claude, ungekürzt */
  lastText?: string;
  /** Nur bei timedOut (Streaming): Laufzeit bis zum Abbruch */
  stoppedAfterMs?: number;
  /** Nur bei timedOut (Streaming): Zeit seit der letzten stream-json-Zeile beim Abbruch */
  idleForMs?: number;
}

/** Ein beobachteter Werkzeugaufruf: Name und wichtigste Eingabe (Befehl, Pfad, Adresse) */
export interface RunStep {
  name: string;
  input?: string;
}

/** So viele Schritte behält callClaudeStreaming für den Timeout-Bericht */
export const MAX_RUN_STEPS = 8;

/** Werkzeugaufruf als Schritt; null ohne Namen. Die Eingabe bleibt ungekürzt. */
export function runStepFromBlock(block: any): RunStep | null {
  if (!block || block.type !== "tool_use" || typeof block.name !== "string" || !block.name) return null;
  const input = block.input && typeof block.input === "object" ? block.input : {};
  const value = [
    input.command,
    input.file_path,
    input.notebook_path,
    input.path,
    input.url,
    input.query,
    input.pattern,
    input.description,
  ].find((v) => typeof v === "string" && v.trim() !== "");
  return value ? { name: block.name, input: value } : { name: block.name };
}

// ---------------------------------------------------------------------------
// Abort registry (/stop): seit Issue #121 allgemein für alle Motoren in
// src/lib/engines/calls.ts. Die Claude-Namen bleiben als dünne Aliase, bis
// alle Aufrufer umgestellt sind.
// ---------------------------------------------------------------------------

/** Prozessbaum beenden über die (in Tests ersetzbare) Laufzeit dieses Moduls */
const terminateViaRuntime = (proc: EngineProc) => runtime.terminate(proc);

function registerAbortable(key: string | undefined, proc: EngineProc): EngineCallEntry {
  return registerEngineCall(key, proc, terminateViaRuntime);
}

/** Alias von abortEngineCalls (src/lib/engines/calls.ts) */
export const abortClaudeCalls = abortEngineCalls;
/** Alias von abortAllEngineCalls (src/lib/engines/calls.ts) */
export const abortAllClaudeCalls = abortAllEngineCalls;
/** Alias von activeEngineCallCount (src/lib/engines/calls.ts) */
export const activeClaudeCallCount = activeEngineCallCount;

/**
 * Known error patterns in Claude output that indicate auth/API failures.
 */
export function isClaudeErrorResponse(text: string): boolean {
  const lower = text.toLowerCase();

  // Hard API/auth errors — always flag regardless of response length
  const hardErrors = [
    "authentication_error",
    "api error: 401",
    "api error: 403",
    "api error: 429",
    "oauth token has expired",
    "failed to authenticate",
    "invalid_api_key",
    "overloaded_error",
    "rate_limit_error",
    "insufficient_quota",
    "payment_required",
  ];
  if (hardErrors.some((p) => lower.includes(p))) return true;

  // Subscription/billing hints — only flag in short responses (<500 chars)
  // because these phrases appear legitimately in research/finance content
  if (text.length < 500) {
    const softErrors = [
      "credit balance",
      "add funds",
      "billing",
      "hit your limit",
      "usage limit",
      "usage cap",
      "message limit",
      "reached your limit",
      "out of messages",
      "no messages remaining",
      "upgrade to",
      "exceeds your plan",
      "plan limit",
      "token limit reached",
      "conversation limit",
    ];
    if (softErrors.some((p) => lower.includes(p))) return true;
  }

  return false;
}

/**
 * Determine whether a parsed Claude CLI result object represents an error,
 * using the CLI's own authoritative fields rather than fuzzy text matching.
 *
 * The CLI emits these on its `result` event / JSON output:
 *   - subtype: "success" on success, otherwise an error subtype
 *   - is_error: boolean
 *   - api_error_status: non-null when the upstream API errored
 *
 * Trusting these prevents false-positive fallbacks to OpenRouter when a
 * legitimate short reply happens to contain words like "billing" or
 * "usage limit".
 */
export function isCliResultError(result: any): boolean {
  if (!result || typeof result !== "object") return false;
  if (result.is_error === true) return true;
  if (typeof result.subtype === "string" && result.subtype !== "success") return true;
  if (result.api_error_status != null) return true;
  return false;
}

/**
 * Narrow check: does an error actually mean the subscription credit/usage
 * limit is exhausted? onCreditLimitHit() "learns" the plan ceiling from the
 * current spend, so a false positive here (overload, network, 5xx) locks in
 * a bogus ceiling — only trust explicit limit wording, never generic errors.
 */
export function isCreditLimitError(text: string): boolean {
  const lower = (text || "").toLowerCase();
  return [
    "usage limit reached",
    "hit your limit",
    "reached your limit",
    "credit balance",
    "out of messages",
    "no messages remaining",
    "insufficient_quota",
  ].some((p) => lower.includes(p));
}

/**
 * Strip markdown code fences and extract JSON from Claude output.
 * Claude subprocesses often wrap JSON in ```json``` fences.
 */
export function extractJSON(output: string, key: string): any | null {
  const cleaned = output.replace(/```(?:json)?\s*/g, "").replace(/```/g, "");
  const jsonMatch = cleaned.match(
    new RegExp(`\\{[\\s\\S]*"${key}"[\\s\\S]*\\}`)
  );
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Spawn a Claude Code subprocess with proper timeout and cleanup.
 */
export async function callClaude(options: ClaudeOptions): Promise<ClaudeResult> {
  const {
    prompt,
    outputFormat = "text",
    allowedTools,
    resumeSessionId,
    timeoutMs = 300_000, // 5 minutes default
    cwd,
    maxTurns,
    model = MODEL_IDS.opus,
    effort,
    abortKey,
  } = options;

  // Pass prompt via stdin to avoid OS arg-length limits (ERR_INVALID_ARG_VALUE).
  // json mit --verbose liefert alle Ereignisse als Liste, darunter die
  // Werkzeugaufrufe (Issue #53); das Ergebnis steht im result-Ereignis.
  const args = ["-p", "--output-format", outputFormat, ...(outputFormat === "json" ? ["--verbose"] : []), "--model", model];

  const effortLevel = effort ?? defaultEffort(model);
  if (effortLevel) args.push("--effort", effortLevel);

  if (allowedTools && allowedTools.length > 0) {
    args.push("--allowedTools", allowedTools.join(","));
  }

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  if (maxTurns) {
    args.push("--max-turns", maxTurns);
  }

  // On macOS, wrap with caffeinate -i to prevent idle sleep during active tasks
  const cmd = IS_MACOS
    ? ["/usr/bin/caffeinate", "-i", CLAUDE_PATH, ...args]
    : [CLAUDE_PATH, ...args];

  checkAborted();
  const proc = spawnProcess({
    detached: !IS_WINDOWS,
    cmd,
    cwd: cwd || process.cwd(),
    env: {
      ...spawnEnv(cwd || process.cwd()),
      HOME: HOME_DIR,
      PATH: process.env.PATH || "",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Drain stderr concurrently so a full diagnostic pipe cannot stall the child.
  const stderrDrain = new Response(proc.stderr).text().catch(() => "");

  // Pipe prompt via stdin — no arg-length ceiling
  proc.stdin.write(prompt);
  proc.stdin.end();

  const abortEntry = registerAbortable(abortKey, proc);

  // Timeout with proper process kill
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    try {
      runtime.terminate(proc);
    } catch {}
  }, timeoutMs);

  try {
    const [output] = await Promise.all([new Response(proc.stdout).text(), stderrDrain]);
    clearTimeout(timeoutId);
    unregisterAbortable(abortKey, abortEntry);

    if (abortEntry?.aborted) {
      return { text: "", isError: true, aborted: true };
    }

    if (timedOut) {
      console.error(`[Claude] timeout after ${Math.round(timeoutMs / 1000)}s (model ${model}), process tree killed`);
      return { text: "", isError: true, timedOut: true };
    }

    // Parse JSON output format — trust the CLI's own error signal
    if (outputFormat === "json") {
      try {
        const parsed = JSON.parse(output);
        const events: any[] | null = Array.isArray(parsed) ? parsed : null;
        const tools: TurnTools | undefined = events
          ? { uses: events.flatMap(toolUsesFromEvent), cwd: cwd || process.cwd() }
          : undefined;
        const result = events ? events.find(e => e?.type === "result") : parsed;
        if (!result) return { text: "", isError: true, tools };
        // Self-meter the credit (fire-and-forget, fail-open)
        if (typeof result.total_cost_usd === "number") {
          creditGuard.record(result.total_cost_usd).catch(() => {});
        }
        const isErr = isCliResultError(result);
        if (isErr && isCreditLimitError(String(result.result ?? "")))
          creditGuard.onCreditLimitHit().catch(() => {});
        return {
          // Im Listenformat nie die ganze Ereignisliste als Antworttext
          text: result.result || (events ? "" : output),
          sessionId: result.session_id,
          isError: isErr,
          costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined,
          ...(tools ? { tools } : {}),
        };
      } catch {
        // Not valid JSON — fall back to the text heuristic
        return { text: output, isError: isClaudeErrorResponse(output) };
      }
    }

    // Text format — no structured signal available, use the text heuristic
    return { text: output.trim(), isError: isClaudeErrorResponse(output) };
  } catch {
    clearTimeout(timeoutId);
    unregisterAbortable(abortKey, abortEntry);
    return { text: "", isError: true, aborted: abortEntry?.aborted };
  }
}

/**
 * Run a Claude subprocess with timeout (simpler API for services).
 * Returns the raw output text. Kills process on timeout.
 */
export async function runClaudeWithTimeout(
  prompt: string,
  timeoutMs: number,
  options?: {
    allowedTools?: string[];
    cwd?: string;
  }
): Promise<string> {
  // Pass prompt via stdin to avoid OS arg-length limits (ERR_INVALID_ARG_VALUE)
  const baseCmd = [
    CLAUDE_PATH,
    "-p",
    "--output-format",
    "text",
    ...(options?.allowedTools
      ? ["--allowedTools", options.allowedTools.join(",")]
      : []),
  ];
  const cmd = IS_MACOS
    ? ["/usr/bin/caffeinate", "-i", ...baseCmd]
    : baseCmd;

  checkAborted();
  const proc = spawnProcess({
    detached: !IS_WINDOWS,
    cmd,
    cwd: options?.cwd || process.cwd(),
    env: {
      ...spawnEnv(options?.cwd || process.cwd()),
      HOME: HOME_DIR,
      PATH: process.env.PATH || "",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Drain stderr concurrently so a full diagnostic pipe cannot stall the child.
  const stderrDrain = new Response(proc.stderr).text().catch(() => "");

  // Pipe prompt via stdin — no arg-length ceiling
  proc.stdin.write(prompt);
  proc.stdin.end();

  const abortEntry = registerAbortable(currentExecution()?.key, proc);
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    try {
      runtime.terminate(proc);
    } catch {}
  }, timeoutMs);

  try {
    const [output] = await Promise.all([new Response(proc.stdout).text(), stderrDrain]);
    clearTimeout(timer);
    checkAborted();
    if (killed) throw new Error("Timeout");
    return output;
  } catch (error) {
    clearTimeout(timer);
    throw error;
  } finally { unregisterAbortable(currentExecution()?.key, abortEntry); }
}

// ---------------------------------------------------------------------------
// Friendly tool name mapping for progress updates
// ---------------------------------------------------------------------------

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  Read: "Reading file",
  Write: "Writing file",
  Edit: "Editing file",
  Glob: "Searching files",
  Grep: "Searching code",
  Bash: "Running command",
  WebSearch: "Searching the web",
  WebFetch: "Fetching page",
  Task: "Delegating task",
  AskUserQuestion: "Asking a question",
};

/** Anzeigename eines Werkzeugs (Claude-Name) für die Fortschrittsanzeige; auch der Codex-Motor nutzt ihn */
export function friendlyToolName(toolName: string): string {
  // Direct match
  if (TOOL_DISPLAY_NAMES[toolName]) return TOOL_DISPLAY_NAMES[toolName];
  // MCP tool: mcp__server__action → "Using server"
  if (toolName.startsWith("mcp__")) {
    const parts = toolName.split("__");
    const server = parts[1] || "tool";
    return `Using ${server.replace(/-/g, " ")}`;
  }
  return `Using ${toolName}`;
}

/** Texts of turns that ended the loop (text, no tool_use), in order. */
function finalTurnTexts(
  turnText: Map<string, string>,
  turnHasToolUse: Set<string>
): string[] {
  const out: string[] = [];
  for (const [id, text] of turnText) {
    if (turnHasToolUse.has(id)) continue;
    const t = text.trim();
    if (t) out.push(t);
  }
  return out;
}

/** First sentence (30 to 150 chars) of a text block, else its first 150 chars. */
export function firstTextSnippet(text: string): string {
  const match = text.match(/^.{30,150}?[.!?\n]/);
  return match ? match[0].trim() : text.substring(0, 150).trim();
}

/**
 * Spawn Claude Code subprocess with streaming JSONL output.
 * Parses events in real time and fires callbacks for progress updates.
 * Returns the same ClaudeResult as callClaude() but with live progress.
 */
export async function callClaudeStreaming(options: ClaudeStreamOptions): Promise<ClaudeResult> {
  const {
    prompt,
    allowedTools,
    resumeSessionId,
    timeoutMs = 300_000,
    cwd,
    maxTurns,
    model = MODEL_IDS.opus,
    effort,
    abortKey,
    onToolStart,
    onFirstText,
  } = options;

  // Pass prompt via stdin to avoid OS arg-length limits (ERR_INVALID_ARG_VALUE)
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", model];

  const effortLevel = effort ?? defaultEffort(model);
  if (effortLevel) args.push("--effort", effortLevel);

  if (allowedTools && allowedTools.length > 0) {
    args.push("--allowedTools", allowedTools.join(","));
  }

  if (resumeSessionId) {
    args.push("--resume", resumeSessionId);
  }

  if (maxTurns) {
    args.push("--max-turns", maxTurns);
  }

  const cmd = IS_MACOS
    ? ["/usr/bin/caffeinate", "-i", CLAUDE_PATH, ...args]
    : [CLAUDE_PATH, ...args];

  checkAborted();
  const proc = spawnProcess({
    detached: !IS_WINDOWS,
    cmd,
    cwd: cwd || process.cwd(),
    env: {
      ...spawnEnv(cwd || process.cwd()),
      HOME: HOME_DIR,
      PATH: process.env.PATH || "",
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "",
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  // Pipe prompt via stdin — no arg-length ceiling
  proc.stdin.write(prompt);
  proc.stdin.end();

  // Capture stderr for diagnostics
  const stderrPromise = new Response(proc.stderr).text().catch(() => "");

  const abortEntry = registerAbortable(abortKey, proc);

  // Zwei Grenzen (Issue #178): timeoutMs für die Gesamtzeit, idleTimeoutMs für
  // die Zeit seit der letzten vollständigen stream-json-Zeile. Die CLI schickt
  // auch während eines langen Werkzeugs oder Hilfs-Agenten alle 30 s eine
  // tool_progress-Zeile, ein arbeitender Lauf ist also nie still.
  // Der Grund wird nur einmal gesetzt, nach /stop gar nicht mehr.
  const startedAt = runtime.now();
  let lastActivityAt = startedAt;
  let timedOut = false;
  let timeoutKind: "idle" | "total" | undefined;
  let stoppedAfterMs = 0;
  let idleForMs = 0;
  const stopFor = (kind: "idle" | "total") => {
    if (timedOut || abortEntry?.aborted) return;
    const now = runtime.now();
    timedOut = true;
    timeoutKind = kind;
    stoppedAfterMs = now - startedAt;
    idleForMs = now - lastActivityAt;
    try { runtime.terminate(proc); } catch {}
  };
  const timeoutId = runtime.setTimeout(() => stopFor("total"), timeoutMs);
  const idleTimeoutMs = options.idleTimeoutMs;
  const idleCheckId =
    idleTimeoutMs && idleTimeoutMs > 0
      ? runtime.setInterval(() => {
          if (runtime.now() - lastActivityAt >= idleTimeoutMs) stopFor("idle");
        }, Math.min(IDLE_CHECK_INTERVAL_MS, idleTimeoutMs))
      : undefined;
  const clearTimers = () => {
    runtime.clearTimeout(timeoutId);
    if (idleCheckId !== undefined) runtime.clearInterval(idleCheckId);
  };
  const timeoutResult = async (): Promise<ClaudeResult> => {
    const stderr = await stderrPromise;
    console.error(
      `[Claude streaming] timeout (${timeoutKind}) after ${Math.round(stoppedAfterMs / 1000)}s, ` +
        `last activity ${Math.round(idleForMs / 1000)}s ago (model ${model}), sessionId=${sessionId || "none"}, process tree killed`
    );
    if (stderr) console.error("[Claude streaming] stderr (timeout):", stderr.substring(0, 500));
    return {
      text: "",
      sessionId,
      isError: true,
      timedOut: true,
      timeoutKind,
      tools: tools(),
      steps: [...steps],
      ...(textAccumulator ? { lastText: textAccumulator } : {}),
      stoppedAfterMs,
      idleForMs,
    };
  };

  // Throttle tool progress (max 1 per 5s)
  let lastToolProgressAt = 0;
  const TOOL_THROTTLE_MS = 5_000;

  let sessionId: string | undefined;
  let resultText = "";
  let firstTextSent = false;
  let textAccumulator = "";
  // Text per API turn, keyed by message id (stream-json emits one event per
  // content block, blocks of one turn share the id). A turn with text and no
  // tool_use ends the agentic loop; a second such turn only shows up when a
  // Stop hook makes Claude continue. The CLI's result carries just the last
  // one, so we keep all of them (see finalTurnTexts below).
  const turnText = new Map<string, string>();
  const turnHasToolUse = new Set<string>();
  // CLI's authoritative error signal from the final result event
  let resultIsError: boolean | undefined;
  let resultSubtype: string | undefined;
  let apiErrorStatus: any = null;
  let costUsd: number | undefined;

  // Alle Werkzeugaufrufe, ungedrosselt und unabhängig von onToolStart (Issue #53)
  const toolUses: TurnTools["uses"] = [];
  const tools = (): TurnTools => ({ uses: toolUses, cwd: cwd || process.cwd() });
  // Getrennt davon die letzten Schritte für den Timeout-Bericht (Issue #179):
  // ungekürzte Eingabe, nur die letzten MAX_RUN_STEPS
  const steps: RunStep[] = [];

  const handleLine = (line: string) => {
    if (!line.trim()) return;

    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      return; // skip malformed lines
    }
    // Aktivität (Issue #178): jede vollständige, gültige Zeile, auch system-,
    // tool_progress-, tool_result- und Subagenten-Ereignisse. Leere und
    // kaputte Zeilen zählen nicht, unabhängig von gedrosseltem Fortschritt.
    lastActivityAt = runtime.now();

    // Capture session_id from init event
    if (event.type === "system" && event.subtype === "init" && event.session_id) {
      sessionId = event.session_id;
    }

    // Final result event — capture the CLI's authoritative error signal
    if (event.type === "result") {
      resultText = event.result || "";
      sessionId = event.session_id || sessionId;
      resultIsError = event.is_error;
      resultSubtype = event.subtype;
      apiErrorStatus = event.api_error_status ?? null;
      if (typeof event.total_cost_usd === "number") {
        costUsd = event.total_cost_usd;
        creditGuard.record(event.total_cost_usd).catch(() => {});
      }
      return;
    }

    toolUses.push(...toolUsesFromEvent(event));

    // Claude Code CLI stream-json format:
    // type=assistant → message.content[] with tool_use and text blocks
    // type=user → tool results (we skip these)
    if (event.type === "assistant" && event.message?.content) {
      const msgId: string = event.message.id || `turn-${turnText.size}`;
      for (const block of event.message.content) {
        if (block.type === "tool_use") {
          turnHasToolUse.add(msgId);
          const step = runStepFromBlock(block);
          if (step) {
            steps.push(step);
            if (steps.length > MAX_RUN_STEPS) steps.shift();
          }
        }

        // Tool use → fire onToolStart
        if (block.type === "tool_use" && block.name && onToolStart) {
          const now = Date.now();
          if (now - lastToolProgressAt >= TOOL_THROTTLE_MS) {
            lastToolProgressAt = now;
            onToolStart(friendlyToolName(block.name));
          }
        }

        // Text block → fire onFirstText
        if (block.type === "text" && block.text) {
          turnText.set(msgId, (turnText.get(msgId) || "") + block.text);
          textAccumulator = block.text;
          if (!firstTextSent && onFirstText && textAccumulator.length > 30) {
            firstTextSent = true;
            onFirstText(firstTextSnippet(textAccumulator), textAccumulator);
          }
        }
      }
    }
  };

  try {
    const decoder = new TextDecoder();
    let buffer = "";

    for await (const chunk of proc.stdout) {
      if (timedOut) break;

      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) handleLine(line);
    }
    // Letzte Zeile ohne abschließenden Zeilenumbruch
    if (!timedOut) handleLine(buffer + decoder.decode());

    clearTimers();
    unregisterAbortable(abortKey, abortEntry);

    if (abortEntry?.aborted) {
      return { text: "", isError: true, aborted: true };
    }

    if (timedOut) return await timeoutResult();

    // If no result event (shouldn't happen), use accumulated text
    if (!resultText && textAccumulator) {
      resultText = textAccumulator;
    }

    // Stop-hook continuation guard: more than one text-only turn means Claude
    // answered, a hook pushed extra context, and Claude answered again. The
    // result event holds only the last answer; relay all of them so the
    // user's actual answer is not swallowed (DM 9.9.2026, impeccable hook).
    if (resultText && !resultIsError) {
      const finals = finalTurnTexts(turnText, turnHasToolUse);
      if (finals.length > 1) {
        console.error(`[Claude streaming] ${finals.length} final turns in one call (hook continuation?), relaying all`);
        resultText = finals.join("\n\n");
      }
    }

    // Always log diagnostics
    const stderr = await stderrPromise;
    console.error(`[Claude streaming] result: text=${resultText ? resultText.length + " chars" : "EMPTY"}, sessionId=${sessionId || "none"}, timedOut=${timedOut}`);
    if (stderr) console.error("[Claude streaming] stderr:", stderr.substring(0, 500));

    // Trust the CLI's own error signal when the result event provided one;
    // only fall back to the brittle text heuristic when no signal is present.
    // This prevents false-positive OpenRouter fallbacks on legitimate short
    // replies that happen to mention "billing", "usage limit", etc.
    const hasCliSignal = resultIsError !== undefined || resultSubtype !== undefined;
    const isErr = hasCliSignal
      ? isCliResultError({
          is_error: resultIsError,
          subtype: resultSubtype,
          api_error_status: apiErrorStatus,
        })
      : isClaudeErrorResponse(resultText);

    if (isErr && isCreditLimitError(resultText))
      creditGuard.onCreditLimitHit().catch(() => {});

    return { text: resultText, sessionId, isError: isErr, costUsd, tools: tools() };
  } catch (err) {
    clearTimers();
    unregisterAbortable(abortKey, abortEntry);
    if (abortEntry?.aborted) {
      return { text: "", isError: true, aborted: true };
    }
    // Ein Stream-Fehler nach dem Zeitlimit bleibt ein Zeitlimit: sonst
    // startete chat-turn einen frischen Resume-Versuch mit neuem Zeitfenster
    if (timedOut) return await timeoutResult();
    const stderr2 = await stderrPromise;
    console.error("[Claude streaming] exception:", err);
    if (stderr2) console.error("[Claude streaming] stderr:", stderr2.substring(0, 500));
    return { text: "", isError: true };
  }
}
