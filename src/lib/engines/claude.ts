/**
 * Claude Code als Motor: reicht die Anfrage an callClaude (JSON) bzw.
 * callClaudeStreaming (stream-json) aus src/lib/claude.ts weiter.
 * Argumente, Parser und Fehlererkennung bleiben dort unverändert; hier werden
 * nur die Optionen so gebaut, wie der Chat-Kern sie vorher selbst gebaut hat.
 */

import {
  callClaude as callClaudeSubprocess,
  callClaudeStreaming as callClaudeStreamingSubprocess,
  type ClaudeOptions,
  type ClaudeStreamOptions,
} from "../claude";
import type { Engine, EngineRequest, EngineResult } from "./types";

export interface ClaudeEngineDeps {
  callClaude: typeof callClaudeSubprocess;
  callClaudeStreaming: typeof callClaudeStreamingSubprocess;
}

/** Optionen für callClaude/callClaudeStreaming; nur gesetzte Felder, wie vorher im Chat-Kern */
export function claudeOptionsFor(req: EngineRequest): ClaudeStreamOptions {
  const common: ClaudeOptions = {
    prompt: req.prompt,
    ...(req.streaming ? {} : { outputFormat: "json" as const }),
    ...(req.resumeSessionId ? { resumeSessionId: req.resumeSessionId } : {}),
    ...(req.allowedTools ? { allowedTools: req.allowedTools } : {}),
    ...(req.model ? { model: req.model } : {}),
    ...(req.effort ? { effort: req.effort } : {}),
    cwd: req.cwd,
    ...(req.abortKey ? { abortKey: req.abortKey } : {}),
    ...(req.maxTurns !== undefined ? { maxTurns: String(req.maxTurns) } : {}),
    timeoutMs: req.timeoutMs,
  };
  if (!req.streaming) return common;
  return {
    ...common,
    ...(req.idleTimeoutMs !== undefined ? { idleTimeoutMs: req.idleTimeoutMs } : {}),
    ...(req.onToolStart ? { onToolStart: req.onToolStart } : {}),
    ...(req.onFirstText ? { onFirstText: req.onFirstText } : {}),
  };
}

export function createClaudeEngine(deps?: Partial<ClaudeEngineDeps>): Engine {
  const call = deps?.callClaude ?? callClaudeSubprocess;
  const callStreaming = deps?.callClaudeStreaming ?? callClaudeStreamingSubprocess;
  return {
    id: "claude",
    describe: () => "Claude Code",
    async run(req: EngineRequest): Promise<EngineResult> {
      const options = claudeOptionsFor(req);
      const result = req.streaming ? await callStreaming(options) : await call(options);
      // tools bleibt undefined, wenn die CLI nichts meldete (unbekannt, nicht leer)
      return { ...result, engine: "claude" };
    },
  };
}
