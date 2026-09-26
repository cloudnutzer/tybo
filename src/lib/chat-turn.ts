/**
 * Chat-Kern: ein Agenten-Turn unabhaengig vom Kanal.
 *
 * Prompt bauen, Session fortsetzen, Claude aufrufen, bei Fehlern Fallback,
 * Session speichern. Telegram (src/bot.ts) und spaeter der Web-Chat nutzen
 * denselben Weg; Fortschritt und Hinweise gehen ueber einen TurnSink, das
 * Formatieren (HTML, Markdown) macht der Kanal.
 */

import {
  callClaude as callClaudeSubprocess,
  callClaudeStreaming,
  firstTextSnippet,
  type ClaudeResult,
} from "./claude";
import { sanitizeModelOutput } from "./telegram";
import { callFallbackLLMWithSource, formatFallbackReply, type FallbackResult } from "./fallback-llm";
import { buildPromptContext, buildResumePrompt } from "./prompt-builder";
import { sessionKeyFor, log as sbLog } from "./convex";
import {
  isSessionModeEnabled,
  getResumableSession,
  takeExpiredSession,
  recordSessionTurn,
  resetSession,
  getSessionsForKey,
} from "./session-manager";
import { shouldDistill, distillSession } from "./session-distill";
import { getAgentConfigOrGeneral } from "../agents";
import { resolveAgentModel, resolveAgentEffort } from "../agents/base";
import { getSettings } from "./settings";
import type { TurnTools } from "./turn-tools";

const PROJECT_ROOT = process.cwd();

export const ABORT_REPLY = "⏹️ Abgebrochen.";

// Shown instead of ABORT_REPLY when the kill came from shutdown() (SIGTERM,
// restart) rather than from the user's /stop — otherwise a lost answer looks
// like a deliberate abort (14.9.2026). Telegram and WebUI share this text.
export const SHUTDOWN_ABORT_REPLY =
  "⚠️ Der Bot wurde waehrend der Verarbeitung beendet (Neustart oder Stop), " +
  "die Antwort ging verloren. Bitte die Nachricht noch einmal schicken.";

// ---------------------------------------------------------------------------
// Long-running Claude calls: a heads-up before the hard limit and an honest
// note when the limit kills the run. 16.9.2026: a 30-minute research run was
// killed silently and the user only saw the thin OpenRouter fallback answer.
// ---------------------------------------------------------------------------
export const CLAUDE_CALL_TIMEOUT_MS = 1_800_000; // 30 min hard kill of the subprocess
export const LONG_RUN_NOTICE_MS = 1_200_000; // heads-up to the user after 20 min

export const LONG_RUN_NOTICE_TEXT =
  `⏳ Läuft seit ${LONG_RUN_NOTICE_MS / 60_000} Minuten. Bei ${CLAUDE_CALL_TIMEOUT_MS / 60_000} Minuten ` +
  `bricht der Bot den Lauf ab und holt eine kürzere Fallback-Antwort. /stop bricht sofort ab.`;

export const TIMEOUT_NOTICE_TEXT =
  `⏱ Zeitlimit: Claude wurde nach ${CLAUDE_CALL_TIMEOUT_MS / 60_000} Minuten abgebrochen, ` +
  `der Zwischenstand ist verloren. Ich hole jetzt eine kürzere Antwort über den Fallback, ` +
  `das kann noch ein paar Minuten dauern.`;

export const FALLBACK_FAILED_REPLY =
  "I'm having trouble processing right now. Please try again in a moment.";

export interface TurnProgress {
  kind: "tool" | "snippet";
  text: string;
  /**
   * Nur Telegram (Issue #52): der Snippet aus dem vor jeder Kürzung
   * bereinigten Text (Markdown-Bilder ohne Adresse). Leer: nichts anzeigen.
   * text bleibt unverändert für die WebUI.
   */
  telegramText?: string;
}

/**
 * Ausgabekanal eines Turns. Reiner Text, kein HTML.
 * start/finish sind optional: start kommt nach dem Prompt-Bau vor dem ersten
 * Claude-Aufruf, finish sobald kein Fortschritt mehr kommt (vor Zeitlimit-
 * Hinweis und Fallback, bzw. bei Abbruch). Ausstehende progress-Aufrufe sind
 * dann abgearbeitet.
 */
export interface TurnSink {
  progress(p: TurnProgress): void | Promise<void>;
  notice(text: string): void | Promise<void>;
  start?(): void | Promise<void>;
  finish?(): void | Promise<void>;
}

/**
 * Was ein Turn ueber sich meldet (Issue #22), fuer die Zeile unter der Antwort.
 * model ist das Modell, das die Antwort tatsaechlich geliefert hat: das des
 * Agenten oder beim Fallback das Fallback-Modell. Fehlt, wenn keins geantwortet
 * hat (alle Fallbacks gescheitert). durationMs misst den Turn selbst: ab
 * Prompt-Bau bis die Antwort feststeht, samt Resume-Retry und Fallback; ohne
 * Warteschlange davor (runExecution) und ohne Versand und Speichern danach.
 */
export interface TurnInfo {
  agent: string;
  model?: string;
  durationMs: number;
}

/** Austauschbare Abhaengigkeiten, vor allem fuer Tests. */
export interface ChatTurnDeps {
  callClaude: typeof callClaudeSubprocess;
  callClaudeStreaming: typeof callClaudeStreaming;
  callFallbackLLMWithSource: (prompt: string, context?: string) => Promise<FallbackResult>;
  buildPromptContext: typeof buildPromptContext;
  buildResumePrompt: typeof buildResumePrompt;
  isSessionModeEnabled: typeof isSessionModeEnabled;
  getResumableSession: typeof getResumableSession;
  takeExpiredSession: typeof takeExpiredSession;
  recordSessionTurn: typeof recordSessionTurn;
  getSessionsForKey: typeof getSessionsForKey;
  resetSession: typeof resetSession;
  shouldDistill: typeof shouldDistill;
  distillSession: typeof distillSession;
  log: typeof sbLog;
  getAgentConfig: typeof getAgentConfigOrGeneral;
  getSettings: typeof getSettings;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (handle: unknown) => void;
  now: () => number;
}

const defaultDeps: ChatTurnDeps = {
  callClaude: callClaudeSubprocess,
  callClaudeStreaming,
  callFallbackLLMWithSource,
  buildPromptContext,
  buildResumePrompt,
  isSessionModeEnabled,
  getResumableSession,
  takeExpiredSession,
  recordSessionTurn,
  getSessionsForKey,
  resetSession,
  shouldDistill,
  distillSession,
  log: sbLog,
  // Unbekannte oder geloeschte Agenten wie bisher mit General (Issue #49)
  getAgentConfig: getAgentConfigOrGeneral,
  getSettings,
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

function resolveDeps(deps?: Partial<ChatTurnDeps>): ChatTurnDeps {
  return deps ? { ...defaultDeps, ...deps } : defaultDeps;
}

export interface TurnOptions {
  userMessage: string;
  chatId: string;
  agentName: string;
  topicId?: number;
  sink: TurnSink;
  /** Bekommt jede Session-ID eines nicht abgebrochenen Laufs, auch bei Fehlern. */
  onSessionId?(id: string): void | Promise<void>;
  /** Agent, Modell und Dauer, sobald die Antwort feststeht; nicht bei Abbruch */
  onInfo?(info: TurnInfo): void;
  /**
   * Werkzeuge des Turns (Issue #53), sobald die Antwort feststeht; nicht bei
   * Abbruch. undefined heißt unbekannt (Fallback-Modell, CLI ohne Angaben).
   */
  onTools?(tools: TurnTools | undefined): void;
  deps?: Partial<ChatTurnDeps>;
}

/**
 * Session-aware prompt preparation, shared by both Claude paths.
 * With SESSION_MODE=resume and a live per-topic session: slim resume prompt.
 * Otherwise: full context prompt (fresh Claude session).
 */
export async function prepareClaudeCall(
  userMessage: string,
  chatId: string,
  agentName: string,
  topicId?: number,
  model?: string,
  deps?: Partial<ChatTurnDeps>
): Promise<{
  sessionKey: string;
  resumeId?: string;
  fullPrompt: string;
  fallbackContext: string;
  memoryWatermark: number;
}> {
  const d = resolveDeps(deps);
  const resolvedModel = model ?? resolveAgentModel(agentName, d);
  const memoryWatermark = Date.now();
  const sessionKey = sessionKeyFor(chatId, topicId ?? null);
  const session = d.isSessionModeEnabled()
    ? await d.getResumableSession(sessionKey, agentName, resolvedModel)
    : undefined;

  if (session?.claudeSessionId) {
    // Fallback context stays empty here on purpose: if the resume call fails
    // we retry with a fresh full prompt first, which fills it properly.
    const fullPrompt = await d.buildResumePrompt({
      userMessage,
      chatId,
      sinceMs: session.memoryWatermark ?? session.startedAt,
    });
    return {
      sessionKey,
      resumeId: session.claudeSessionId,
      fullPrompt,
      fallbackContext: "",
      memoryWatermark,
    };
  }

  // Fresh session ahead: if an expired/model-mismatched session is lying
  // around, distill its insights into memory first (fire-and-forget).
  if (d.isSessionModeEnabled()) {
    const expired = await d.takeExpiredSession(sessionKey, agentName, resolvedModel);
    if (expired && d.shouldDistill(expired)) void d.distillSession(expired);
  }

  const { fullPrompt, fallbackContext } = await d.buildPromptContext({
    userMessage,
    chatId,
    agentName,
    topicId,
  });
  return { sessionKey, resumeId: undefined, fullPrompt, fallbackContext, memoryWatermark };
}

/**
 * Record a successful turn so the topic's next message can --resume it.
 */
export async function finalizeClaudeSession(
  sessionKey: string,
  agentName: string,
  result: { sessionId?: string; isError?: boolean; text?: string },
  memoryWatermark?: number,
  model?: string,
  deps?: Partial<ChatTurnDeps>
): Promise<void> {
  const d = resolveDeps(deps);
  if (!d.isSessionModeEnabled()) return;
  if (!result.sessionId || result.isError || !result.text) return;
  // Ohne model (Telegram-Button-Antwort in src/bot.ts) lief der Aufruf in der
  // gespeicherten Session weiter, also bleibt deren Modell. Nicht aus
  // config/settings.json nachtraeglich aufloesen: nach einem Modellwechsel
  // stuende die alte Session sonst unter dem neuen Modell und wuerde weiter
  // fortgesetzt. Massgeblich ist nur der Eintrag genau dieser Session: hat
  // inzwischen ein anderer Turn eine Nachfolgesession gespeichert (oder wurde
  // die Session zurueckgesetzt), bleibt der Speicher unangetastet.
  let resolvedModel = model;
  if (!resolvedModel) {
    const stored = (await d.getSessionsForKey(sessionKey)).find(
      (s) => s.agentName === agentName && s.claudeSessionId === result.sessionId
    );
    if (!stored) return;
    resolvedModel = stored.model;
  }
  await d.recordSessionTurn(sessionKey, agentName, resolvedModel, result.sessionId, memoryWatermark);
}

/** Snippet für die Anzeige: ohne Markdown- und HTML-Zeichen, höchstens 120 Zeichen */
const cleanSnippet = (snippet: string) => snippet.replace(/[_*`<>]/g, "").substring(0, 120);

/**
 * Wraps the sink: errors never reach the Claude call, and fire-and-forget
 * progress updates are awaited before finish().
 */
function guardSink(sink: TurnSink) {
  const pending = new Set<Promise<unknown>>();
  let finished = false;

  const track = (fn: () => void | Promise<void>) => {
    try {
      const r = fn();
      if (r && typeof (r as Promise<void>).then === "function") {
        const p = Promise.resolve(r).catch(() => {});
        pending.add(p);
        void p.finally(() => pending.delete(p));
      }
    } catch {
      // Sink errors must not break the turn
    }
  };

  return {
    progress(p: TurnProgress) {
      if (finished) return;
      track(() => sink.progress(p));
    },
    async notice(text: string) {
      try {
        await sink.notice(text);
      } catch {}
    },
    async start() {
      try {
        await sink.start?.();
      } catch {}
    },
    async finish() {
      if (finished) return;
      finished = true;
      await Promise.all([...pending]);
      try {
        await sink.finish?.();
      } catch {}
    },
  };
}

type TurnMode = "json" | "streaming";

async function runTurn(mode: TurnMode, opts: TurnOptions): Promise<string> {
  const { userMessage, chatId, agentName, topicId } = opts;
  const d = resolveDeps(opts.deps);
  const startedAt = d.now();
  const sink = guardSink(opts.sink);
  const agentConfig = d.getAgentConfig(agentName);
  // Einmal pro Turn aufgeloest (config/settings.json vor .env vor Agenten-Datei):
  // Sessionpruefung, Aufruf, Retry, Speicherung und TurnInfo nutzen dasselbe.
  const resolvedModel = resolveAgentModel(agentName, d);
  const resolvedEffort = resolveAgentEffort(agentName, d);
  const streaming = mode === "streaming";
  const reportTools = (tools: TurnTools | undefined) => {
    try {
      opts.onTools?.(tools);
    } catch {
      // Die Werkzeugliste darf den Turn nie stoeren
    }
  };
  const report = (model: string | undefined) => {
    const info: TurnInfo = {
      agent: agentName,
      ...(model ? { model } : {}),
      durationMs: Math.max(0, Math.round(d.now() - startedAt)),
    };
    try {
      opts.onInfo?.(info);
    } catch {
      // Die Anzeige-Angaben duerfen den Turn nie stoeren
    }
  };

  // Assemble the prompt (topic-isolated conversation, memory, knowledge base,
  // semantic search on every message): see lib/prompt-builder. In resume
  // mode the prompt is slim: the Claude session already holds the context.
  let { sessionKey, resumeId, fullPrompt, fallbackContext, memoryWatermark } =
    await prepareClaudeCall(userMessage, chatId, agentName, topicId, resolvedModel, d);

  await sink.start();

  const baseOpts = {
    ...(agentConfig?.allowedTools ? { allowedTools: agentConfig.allowedTools } : {}),
    model: resolvedModel,
    ...(resolvedEffort ? { effort: resolvedEffort } : {}),
    timeoutMs: CLAUDE_CALL_TIMEOUT_MS,
    cwd: PROJECT_ROOT,
    abortKey: sessionKey, // /stop kills this subprocess
  };
  const streamCallbacks = {
    onToolStart: (toolName: string) => {
      sink.progress({ kind: "tool", text: toolName });
    },
    onFirstText: (snippet: string, fullText?: string) => {
      const clean = cleanSnippet(snippet);
      if (clean.length > 20) {
        // Für Telegram vor der ersten Kürzung bereinigen: ein angeschnittenes
        // Bild erkennt später niemand mehr (Issue #52)
        const forTelegram = cleanSnippet(firstTextSnippet(sanitizeModelOutput(fullText ?? snippet)));
        sink.progress({ kind: "snippet", text: clean, telegramText: forTelegram.length > 20 ? forTelegram : "" });
      }
    },
  };

  // Without resume, each message gets a fresh session; continuity then comes
  // from context + memory + semantic search. The long-run heads-up is armed
  // for the duration of each call.
  const call = async (prompt: string, resumeSessionId?: string): Promise<ClaudeResult> => {
    const timer = d.setTimer(() => {
      void sink.notice(LONG_RUN_NOTICE_TEXT);
    }, LONG_RUN_NOTICE_MS);
    try {
      const resume = resumeSessionId ? { resumeSessionId } : {};
      return streaming
        ? await d.callClaudeStreaming({ prompt, ...resume, ...baseOpts, ...streamCallbacks })
        : await d.callClaude({ prompt, outputFormat: "json", ...resume, ...baseOpts });
    } finally {
      d.clearTimer(timer);
    }
  };

  let result = await call(fullPrompt, resumeId);

  // Vom User abgebrochen (/stop): kein Retry, kein Fallback
  if (result.aborted) {
    await sink.finish();
    return ABORT_REPLY;
  }

  // Resume can fail (session file gone, CLI updated, context limit):
  // reset the session and retry once with a fresh full prompt. Not after a
  // timeout: that would burn another full window on the same task.
  if (resumeId && !result.timedOut && (result.isError || !result.text)) {
    console.warn(
      `[Session] ${streaming ? "streaming resume" : "resume"} failed for ${sessionKey}, retrying fresh`
    );
    await d.resetSession(sessionKey, agentName);
    ({ fullPrompt, fallbackContext } = await d.buildPromptContext({
      userMessage,
      chatId,
      agentName,
      topicId,
    }));
    result = await call(fullPrompt);
    if (result.aborted) {
      await sink.finish();
      return ABORT_REPLY;
    }
  }

  await finalizeClaudeSession(sessionKey, agentName, result, memoryWatermark, resolvedModel, d);

  // Track session ID for HITL task creation (if Claude asks a question with buttons)
  if (result.sessionId) await opts.onSessionId?.(result.sessionId);

  // No more progress from here on: the channel can clean up
  await sink.finish();

  // Handle errors with fallback
  if (result.isError || !result.text) {
    const label = streaming ? "Claude streaming" : "Claude";
    console.error(
      `${label} error (text=${result.text?.length || 0} chars, timedOut=${!!result.timedOut}): [content omitted]`
    );
    await d.log("warn", "bot", `${label} failed, using fallback LLM`, {
      error: result.text?.substring(0, 200),
      timedOut: !!result.timedOut,
    });
    if (result.timedOut) await sink.notice(TIMEOUT_NOTICE_TEXT);

    // Was das Fallback-Modell an Werkzeugen nutzte, ist nicht bekannt
    reportTools(undefined);
    let fallback: FallbackResult;
    try {
      fallback = await d.callFallbackLLMWithSource(userMessage, fallbackContext);
    } catch (fallbackError) {
      console.error("Fallback LLM also failed:", fallbackError);
      report(undefined);
      return FALLBACK_FAILED_REPLY;
    }
    // Strukturierte Herkunft statt den "responded via"-Zusatz zu parsen
    report(fallback.source !== "none" ? fallback.model || fallback.source : undefined);
    return formatFallbackReply(fallback);
  }

  reportTools(result.tools);
  report(resolvedModel);
  return result.text;
}

/** Turn over the streaming subprocess: tool steps and first snippet as progress. */
export function runStreamingTurn(opts: TurnOptions): Promise<string> {
  return runTurn("streaming", opts);
}

/** Turn over the JSON subprocess: no progress, only notices. */
export function runJsonTurn(opts: TurnOptions): Promise<string> {
  return runTurn("json", opts);
}
