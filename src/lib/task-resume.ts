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
 * Der Prompt der Fortsetzung trägt die Kanalregeln des Kanals, in dem der
 * Knopf gedrückt wurde (Issue #358): eine Frage aus Telegram, im Browser
 * beantwortet, bekommt die Regeln der WebUI und umgekehrt. Ohne Angabe gilt
 * Telegram wie bei jedem Turn.
 *
 * Beide Pfade (Mac, Anthropic API) speichern die Antwort mit dem Topic der
 * Rückfrage und werten Merk-Tags für dieses Topic aus. Alte Aufträge des
 * Agent SDK laufen seit Issue #349 über den Mac-Pfad (Art task_resume).
 */

import { checkEngine, ENGINE_IDS, EngineNotAvailableError, getEngine, type EngineId, type EngineResult } from "./engines";
import { runExecution, isAbortError, checkAborted, currentExecution } from "./execution-context";
import { isSessionModeEnabled, getResumableSession, sessionEpoch } from "./session-manager";
import { ABORT_REPLY, canRetryResume, finalizeClaudeSession, runJsonTurn, type PriorAttempt, type TurnInfo } from "./chat-turn";
import { sessionKeyFor } from "./store/message-rules";
import { bookRunOutcome } from "./spend/credit";
import { getAgentConfigOrGeneral } from "../agents";
import { DEFAULT_PROMPT_CHANNEL, formatChannelRules, type PromptChannel } from "../agents/prompt-parts";
import { engineIsReady, engineModelAndEffort, sessionModel } from "./engine-choice";
import { stageBlock } from "./engine-switch";
import { readSwitchState } from "./engine-switch-state";
import { noteStageRun, stageFailureOf } from "./engine-switch-run";
import { scheduleClaudeUsageAfterChat } from "./engines/claude-usage";
import { engineAuto, engineBackups, getSettings } from "./settings";
import type { IntentTarget } from "./intent-gate";
import type { FoundQuestion } from "./turn-questions";

/** Was von einem gespeicherten Task gebraucht wird (Supabase oder Datei) */
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
  handoverTurn: typeof runJsonTurn;
  readSwitchState: typeof readSwitchState;
  noteStageRun: typeof noteStageRun;
  scheduleClaudeUsageAfterChat: typeof scheduleClaudeUsageAfterChat;
  checkEngine: typeof checkEngine;
  getSettings: typeof getSettings;
  now: () => number;
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
  handoverTurn: runJsonTurn,
  readSwitchState,
  noteStageRun,
  scheduleClaudeUsageAfterChat,
  checkEngine,
  getSettings,
  now: Date.now,
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

/** Prompt der Fortsetzung: Kanalregeln, dann die Antwort auf die Rückfrage */
export function taskResumePrompt(choice: string, channel: PromptChannel = DEFAULT_PROMPT_CHANNEL): string {
  return `${formatChannelRules(channel)}\n\n---\n\nUser responded: ${choice}`;
}

export interface TaskHandover {
  question: string;
  options: string[];
  originalPrompt: string;
}

/** Frage und Knopf-Antwort als gewöhnliche Nachricht an die nächste Stufe. */
export function taskHandoverPrompt(handover: TaskHandover, answer: string): string {
  return [
    "Der Nutzer hat eine Rückfrage aus diesem Gespräch per Knopf beantwortet.",
    `Ursprünglicher Auftrag: ${handover.originalPrompt.slice(0, 2_000)}`,
    `Rückfrage: ${handover.question}`,
    ...(handover.options.length ? [`Zur Auswahl standen: ${handover.options.join(" | ")}`] : []),
    `Antwort des Nutzers: ${answer}`,
    "Setze den Auftrag mit dieser Antwort fort.",
  ].join("\n");
}

export type MacResumeOutcome =
  /** Weder Task noch Topic haben eine Session: nur bestätigen */
  | { status: "no-session" }
  /** /stop oder Neustart, auch schon in der Warteschlange: nichts speichern */
  | { status: "aborted" }
  /** Alte Übersetzer und Attrappen ohne via gelten weiterhin als Resume. */
  | { status: "done"; via?: "resume"; result: EngineResult; resumeId: string; agent: string; engine: EngineId; model: string }
  | { status: "done"; via: "handover"; result: EngineResult; resumeId: string; agent: string;
      engine?: EngineId; model?: string; followUp?: Pick<FoundQuestion, "question" | "options">; notices?: string[] };

/**
 * Setzt die Session der Rückfrage mit der Knopf-Antwort über ihren Motor fort.
 * Mit Frage und Ersatzstufen übergibt eine gesperrte, nicht bereite oder
 * gescheiterte Stufe einmal an den Chat-Kern, unter derselben Gesprächssperre.
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
  deps?: Partial<TaskResumeDeps>,
  /** Kanal des Klicks; ohne Angabe Telegram */
  channel?: PromptChannel,
  handover?: TaskHandover
): Promise<MacResumeOutcome> {
  const d = deps ? { ...defaultDeps, ...deps } : defaultDeps;
  const { sessionKey, agent, chatId, topicId } = taskTarget(task, fallbackChatId);
  const allowedTools = d.allowedTools(agent);
  let claudeRan = false;
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

        // Unbekannte Motoren bleiben Fehler; bekannte, nicht verfügbare dürfen übergeben.
        if (!ENGINE_IDS.includes(engineId)) throw new EngineNotAvailableError(engineId);
        const settings = handover ? d.getSettings() : {};
        const useHandover = !!handover && engineBackups(settings).length > 0;
        const transfer = async (priorAttempts?: PriorAttempt[]): Promise<MacResumeOutcome> => {
          checkAborted();
          let info: TurnInfo | undefined;
          let sessionId: string | undefined;
          let tools: EngineResult["tools"];
          let followUp: Pick<FoundQuestion, "question" | "options"> | undefined;
          const notices: string[] = [];
          const text = await d.handoverTurn({
            userMessage: taskHandoverPrompt(handover!, choice), chatId, topicId, agentName: agent, channel,
            ...(priorAttempts ? { priorAttempts } : {}),
            longRunNotices: false,
            sink: { progress() {}, notice: text => { notices.push(text); } },
            onInfo: value => { info = value; },
            onTools: value => { tools = value; },
            onSessionId: id => { sessionId = id; },
            onQuestion: question => { followUp = { question: question.question, options: question.options }; },
          });
          checkAborted();
          if (text === ABORT_REPLY) return { status: "aborted" };
          // Eine Session des gescheiterten Motors gehört nie zu einem Ersatzmodell.
          const answeredSession = info?.engine ? sessionId : undefined;
          return { status: "done", via: "handover", agent, engine: info?.engine, model: info?.engine ? sessionModel(info.model) : info?.model,
            notices, ...(info?.engine && followUp ? { followUp } : {}),
            resumeId: answeredSession ?? "", result: { engine: info?.engine ?? engineId, text, tools,
              isError: !info?.engine && !info?.model, ...(info?.timedOut ? { timedOut: true } : {}),
              ...(answeredSession ? { sessionId: answeredSession } : {}) } };
        };
        if (useHandover) {
          let ready = false;
          if (!stageBlock({ engine: engineId }, model || undefined, d.readSwitchState(), d.now())) {
            try { ready = engineIsReady(engineId, await d.checkEngine(engineId)); } catch { /* Nicht bereit. */ }
          }
          checkAborted();
          if (!ready) return transfer();
        }
        let engine;
        try { engine = d.getEngine(engineId); } catch (error) {
          if (useHandover) return transfer();
          throw error;
        }
        const result = await engine.run({
          prompt: taskResumePrompt(choice, channel),
          streaming: false,
          resumeSessionId: resumeId,
          // Antwort auf genau diese Rückfrage: ist sie schon beantwortet, setzt der Motor nichts fort (Motor api)
          answersQuestion: true,
          timeoutMs: TASK_RESUME_TIMEOUT_MS,
          cwd: d.cwd,
          ...(model ? { model } : {}),
          ...(effort ? { effort } : {}),
          ...(allowedTools ? { allowedTools } : {}),
          abortKey: sessionKey, // /stop beendet auch diesen Prozess
        });
        void bookRunOutcome("task-resume", result.engine, model || undefined, result);
        const aborted = result.aborted || currentExecution()?.controller.signal.aborted;
        claudeRan = result.engine === "claude" && !aborted;
        if (useHandover) {
          // Eine verlorene Session sperrt nicht den ganzen Motor. Messwerte gelten trotzdem.
          const noted = d.noteStageRun({ engine: engineId }, model || undefined, aborted ? { ...result, aborted: true } : result,
            engineAuto(settings), d.now(), undefined, { abandoned: !aborted && !canRetryResume(result) });
          // Erfolg reiht die Auswertung nur ein; die Auswahl nach einem Fehler wartet darauf.
          if (!aborted && stageFailureOf(result)) {
            await noted;
            checkAborted();
            return transfer([{ stage: { engine: engineId, ...(model ? { model } : {}) }, result }]);
          }
        }
        if (aborted) return { status: "aborted" };

        if (topicSession && topicSession.engine === result.engine && topicSession.engineSessionId === resumeId) {
          await d.finalizeClaudeSession(sessionKey, agent, result, undefined, sessionModel(model), undefined, epoch);
        }
        // Immer mit Modell ("" = Standard des Motors): eine Folgefrage am Task erbt es so, statt als alt zu gelten
        return { status: "done", via: "resume", result, resumeId, agent, engine: engineId, model: sessionModel(model) };
      },
      allowedTools
    );
  } catch (error) {
    if (isAbortError(error)) return { status: "aborted" };
    throw error;
  } finally {
    if (claudeRan) d.scheduleClaudeUsageAfterChat();
  }
}

export type TaskResumeKind = "task_resume";

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
