/**
 * Knopf-Antworten auf Rückfragen (async_tasks, Human-in-the-Loop) fortsetzen,
 * ohne src/bot.ts (Issue #189).
 *
 * Mac-Pfad: die Antwort setzt die Session fort, in der die Frage gestellt
 * wurde, über deren Motor mit deren Modell (Issue #122: am Task gespeichert
 * in metadata.engine/metadata.model; alte Tasks ohne Angabe gelten als
 * Claude mit dem jetzigen Modell des Agenten). Das läuft über runExecution
 * wie ein normaler Turn: dieselbe Sperre je Session-Schlüssel und Agent
 * (keine zwei --resume derselben Session gleichzeitig), derselbe Effort,
 * dieselben Werkzeuge, /stop wirkt auch in der Warteschlange. Die Session
 * wird erst innerhalb der Sperre ausgewählt.
 *
 * Alle drei Pfade (Mac, Agent SDK, Anthropic API) speichern die Antwort mit
 * dem Topic der Rückfrage und werten Merk-Tags für dieses Topic aus.
 */

import { getEngine, type EngineId, type EngineResult } from "./engines";
import { runExecution, isAbortError } from "./execution-context";
import { isSessionModeEnabled, getResumableSession, sessionEpoch } from "./session-manager";
import { finalizeClaudeSession } from "./chat-turn";
import { sessionKeyFor } from "./supabase";
import { getAgentConfigOrGeneral } from "../agents";
import { engineModelAndEffort, sessionModel } from "./engine-choice";
import type { IntentTarget } from "./intent-gate";

/** Was von einem gespeicherten Task gebraucht wird (Supabase oder Convex) */
export interface ResumableTask {
  chat_id?: string;
  thread_id?: number | null;
  session_id?: string;
  metadata?: Record<string, any>;
}

/** Wie lange die fortgesetzte Session laufen darf (wie bisher 30 Minuten) */
export const TASK_RESUME_TIMEOUT_MS = 1_800_000;

export interface TaskResumeDeps {
  runExecution: typeof runExecution;
  getEngine: typeof getEngine;
  isSessionModeEnabled: typeof isSessionModeEnabled;
  getResumableSession: typeof getResumableSession;
  sessionEpoch: typeof sessionEpoch;
  finalizeClaudeSession: typeof finalizeClaudeSession;
  /** Modell je Motor (Issue #125): Claude pro Agent, Codex aus engine.codex, OpenCode aus engine.opencode; undefined = Standard des Motors */
  resolveModel: (agent: string, engine: EngineId) => string | undefined;
  resolveEffort: (agent: string, engine: EngineId) => string | undefined;
  allowedTools: (agent: string) => string[] | undefined;
  cwd: string;
}

const defaultDeps: TaskResumeDeps = {
  runExecution,
  getEngine,
  isSessionModeEnabled,
  getResumableSession,
  sessionEpoch,
  finalizeClaudeSession,
  resolveModel: (agent, engine) => engineModelAndEffort(engine, agent).model,
  resolveEffort: (agent, engine) => engineModelAndEffort(engine, agent).effort,
  allowedTools: (agent) => getAgentConfigOrGeneral(agent)?.allowedTools,
  cwd: process.cwd(),
};

/**
 * Motor und Modell, mit denen die Rückfrage entstand (metadata.engine,
 * metadata.model). Ohne Motor: Claude (Tasks vor Issue #122). Ein
 * unbekannter Motor bleibt, was er ist, und wird nie Claude übergeben.
 * model "" heißt bewusst Standard des Motors (Codex ohne engine.codex.model,
 * Issue #125) und bleibt erhalten; nur eine fehlende Angabe (alte Tasks)
 * ist undefined.
 */
export function taskEngine(task: ResumableTask): { engine: EngineId; model?: string } {
  const engine = task.metadata?.engine;
  const model = task.metadata?.model;
  return {
    engine: typeof engine === "string" && engine ? (engine as EngineId) : "claude",
    ...(typeof model === "string" ? { model } : {}),
  };
}

/** Chat, Topic, Session-Schlüssel und Agent einer Rückfrage */
export function taskTarget(task: ResumableTask, fallbackChatId: string) {
  const chatId = task.chat_id || fallbackChatId;
  const topicId = typeof task.thread_id === "number" ? task.thread_id : undefined;
  return {
    chatId,
    topicId,
    sessionKey: sessionKeyFor(chatId, topicId ?? null),
    agent: (task.metadata?.agent_name as string | undefined) || "general",
  };
}

export type MacResumeOutcome =
  /** Weder Task noch Topic haben eine Session: nur bestätigen */
  | { status: "no-session" }
  /** /stop oder Neustart, auch schon in der Warteschlange: nichts speichern */
  | { status: "aborted" }
  | { status: "done"; result: EngineResult; resumeId: string; agent: string; engine: EngineId; model: string };

/**
 * Setzt die Session der Rückfrage mit der Knopf-Antwort fort, immer über den
 * Motor der Rückfrage, auch wenn das Topic inzwischen einen anderen nutzt.
 * Bevorzugt die Session, in der die Frage gestellt wurde (task.session_id),
 * sonst die laufende Topic-Session desselben Motors und Modells. Nur wenn
 * genau die Topic-Session fortgesetzt wurde (Motor und ID gleich), zählt der
 * Aufruf als Turn dieser Session; eine alte task.session_id (nach /new,
 * Modell- oder Motorwechsel) überschreibt nie die aktuelle.
 */
export async function resumeMacTask(
  task: ResumableTask,
  fallbackChatId: string,
  choice: string,
  deps?: Partial<TaskResumeDeps>
): Promise<MacResumeOutcome> {
  const d = deps ? { ...defaultDeps, ...deps } : defaultDeps;
  const { sessionKey, agent } = taskTarget(task, fallbackChatId);
  const allowedTools = d.allowedTools(agent);
  try {
    return await d.runExecution(
      sessionKey,
      agent,
      async (): Promise<MacResumeOutcome> => {
        // Erst in der Sperre: ein Turn davor kann die Session gerade weitergeschrieben haben
        const stored = taskEngine(task);
        const engineId = stored.engine;
        // Modell und Effort des Motors der Rückfrage; nie ein Claude-Modell für Codex (Issue #125).
        // Ein gespeichertes "" bleibt Standard des Motors, auch wenn engine.codex.model inzwischen gesetzt ist
        const model = stored.model !== undefined ? stored.model : d.resolveModel(agent, engineId);
        const effort = d.resolveEffort(agent, engineId);
        const epoch = d.sessionEpoch(sessionKey);
        const topicSession = d.isSessionModeEnabled()
          ? await d.getResumableSession(sessionKey, agent, sessionModel(model), engineId)
          : undefined;
        const resumeId = task.session_id || topicSession?.engineSessionId;
        if (!resumeId) return { status: "no-session" };

        // Unbekannter oder nicht verfügbarer Motor: getEngine wirft, die
        // Session-ID geht nie an einen anderen Motor
        const engine = d.getEngine(engineId);
        const result = await engine.run({
          prompt: `User responded: ${choice}`,
          streaming: false,
          resumeSessionId: resumeId,
          timeoutMs: TASK_RESUME_TIMEOUT_MS,
          cwd: d.cwd,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(allowedTools ? { allowedTools } : {}),
          abortKey: sessionKey, // /stop beendet auch diesen Prozess
        });
        if (result.aborted) return { status: "aborted" };

        if (topicSession && topicSession.engine === result.engine && topicSession.engineSessionId === resumeId) {
          await d.finalizeClaudeSession(sessionKey, agent, result, undefined, sessionModel(model), undefined, epoch);
        }
        // Immer mit Modell ("" = Standard des Motors): eine Folgefrage am Task erbt es so, statt als alt zu gelten
        return { status: "done", result, resumeId, agent, engine: engineId, model: sessionModel(model) };
      },
      allowedTools
    );
  } catch (error) {
    if (isAbortError(error)) return { status: "aborted" };
    throw error;
  }
}

export type TaskResumeKind = "agent_sdk_resume" | "task_resume";

/**
 * Gespeicherte Antwort und Ziel der Merk-Tags einer Knopf-Antwort: immer mit
 * dem Topic der Rückfrage, sonst landet sie unter group:<chat> (saveMessage
 * leitet den Session-Schlüssel aus metadata.topicId ab).
 */
export function taskResumeRecord(
  task: ResumableTask,
  fallbackChatId: string,
  opts: { taskId: string; response: string; kind: TaskResumeKind; origin: string; agent?: string }
): {
  message: { chat_id: string; role: "assistant"; content: string; metadata: Record<string, unknown> };
  intents: IntentTarget;
} {
  const { chatId, topicId } = taskTarget(task, fallbackChatId);
  return {
    message: {
      chat_id: chatId,
      role: "assistant",
      content: opts.response,
      metadata: {
        type: opts.kind,
        taskId: opts.taskId,
        ...(opts.agent ? { agent: opts.agent } : {}),
        ...(topicId !== undefined ? { topicId } : {}),
      },
    },
    intents: { chatId, ...(topicId !== undefined ? { topicId } : {}), origin: opts.origin },
  };
}
