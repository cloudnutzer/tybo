/**
 * Bestätigter Auftrag aus einem Anruf als vollständiger Chat-Turn (Issue #366),
 * ohne Telegram-Context: nach einem Neustart gibt es keinen, und die
 * Zustimmung kann auch aus dem Browser kommen. Der Ablauf entspricht dem
 * Telegram-Ablauf (src/channels/telegram/reply-turn.ts, src/lib/turn-finish.ts):
 *   - Turn des Agenten im Gespräch (Chat samt Topic) über den Streaming-Turn
 *     des Chat-Kerns (runStreamingTurn) wie askWithProgress (src/app/bot-turns.ts): Leerlauf-
 *     und Obergrenze (TYBO_CLAUDE_IDLE_MIN, TYBO_CLAUDE_MAX_MIN), Statusnachricht
 *     „Arbeite daran …“ über progressMessages statt über einen Telegram-Context,
 *     Hinweise (läuft lange, Zeitlimit) vom Bot des Agenten; im
 *     runCancelable-Bereich des Gesprächs und in runExecution: /stop bricht ab,
 *     ein Neustart wartet, bis die Antwort raus ist
 *   - Antwort im Verlauf speichern (so sieht die WebUI sie), Merk-Tags über
 *     processIntents, ein aktives /goal über onAgentTurn
 *   - [INVOKE:]-Tags: Text ohne Tags vom Agenten, dann je Aufruf (gedeckelt
 *     auf invokeBudget) die Antwort des gefragten Agenten, auch gespeichert
 *   - Rückfrage mit Optionen: Auftrag in async_tasks (needs_input, Session,
 *     Motor und Modell des Turns) und die Antwort mit Knöpfen
 *   - sonst die Antwort vom Bot des Agenten
 * Abbruch (/stop, Neustart) und Fehler enden mit einer Meldung im Gespräch,
 * ein abgebrochener Turn wird nicht gespeichert. Offene Fäden entstehen hier
 * nicht (wie bisher bei Aufträgen aus Anrufen).
 *
 * Ins Log kommen nur Kennungen, nie Auftrag oder Antwort.
 */

import { ABORT_REPLY, SHUTDOWN_ABORT_REPLY, type TurnOptions, type TurnSessionMeta } from "../chat-turn";
import type { BotRegistry } from "../bot-registry";
import { consultViaAgentBots, extractConsults, limitConsults, stripConsultTags, type RecentMessages } from "../agent-consult";
import { isAbortError, isRestartPendingError, RESTART_PENDING_REPLY, runCancelable, runExecution } from "../execution-context";
import type { IntentTarget } from "../intent-gate";
import { sessionKeyFor } from "../store/message-rules";
import type { Message, TaskChanges } from "../store/types";
import { detectTaskQuestion, taskQuestionKeyboard } from "../task-question";
import { createProgressSink, type ProgressMessages } from "../telegram-progress";
import { turnInfoCollector } from "../turn-collector";
import type { TurnTools } from "../turn-tools";

/** Agent der Aufträge aus Anrufen, wie bisher */
export const CALL_TASK_AGENT = "general";

export const CALL_TASK_TEXT = {
  failed: "Der Auftrag aus dem Anruf ist gescheitert. Bitte noch einmal versuchen.",
} as const;

type TurnCollector = ReturnType<typeof turnInfoCollector>;

export interface CallTaskTurnDeps {
  /** Streaming-Turn des Chat-Kerns (runStreamingTurn in src/lib/chat-turn.ts) */
  runStreamingTurn(opts: TurnOptions): Promise<string>;
  /** Statusnachricht im Chat samt Topic (chatProgressMessages); fehlt oder undefined: ohne Statusnachricht, nur Hinweise */
  progressMessages?(chatId: string, topicId: number | undefined): ProgressMessages | undefined;
  /** Session-ID jedes Laufs zusätzlich für den Bot (trackSessionId in src/bot.ts) */
  onSessionId?(id: string, meta: TurnSessionMeta): void | Promise<void>;
  /** Werkzeuge des Agenten für runExecution, wie askWithProgress */
  allowedTools?(agent: string): string[] | undefined;
  /** Agenten-Aufrufe ([INVOKE:]) wie im Telegram-Abschluss (callClaude in src/bot.ts); gibt bei Abbruch ABORT_REPLY zurück */
  callClaude(prompt: string, chatId: string, agent: string, topicId: number | undefined): Promise<string>;
  saveMessage(message: Message): Promise<unknown>;
  processIntents(response: string, tools: TurnTools | undefined, target: IntentTarget): Promise<unknown>;
  /** Aktives /goal im Gespräch: Gates und Judge auf die Antwort */
  onAgentTurn(sessionKey: string, agent: string, response: string): void;
  registry: Pick<BotRegistry, "sendAsAgent" | "sendTypingAsAgent" | "sendWithKeyboardAsAgent">;
  createTask(chatId: string, prompt: string, topicId: number | undefined): Promise<{ id: string } | null>;
  updateTask(taskId: string, changes: TaskChanges): Promise<unknown>;
  /** Meldung im Gespräch (Abbruch, Fehler); darf werfen */
  notice(chatId: string, text: string, topicId?: number): Promise<unknown>;
  isShuttingDown(): boolean;
  invokeBudget: number;
  /** Verlauf für den Gesprächsauszug einer Konsultation; ohne Angabe der Nachrichtenspeicher */
  recentMessages?: RecentMessages;
  /** Nach dem Turn, auch nach einem Fehler: angeforderter Neustart (scheduleRestartCheck) */
  afterTurn?(chatId: string, topicId?: number): void;
  log?(line: string): void;
}

export function createCallTaskTurn(deps: CallTaskTurnDeps): (chatId: string, task: string, topicId?: number) => Promise<void> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const agent = CALL_TASK_AGENT;

  /** Wie askWithProgress in src/app/bot-turns.ts, ohne Telegram-Context; Abbruch ergibt ABORT_REPLY */
  async function streamTurn(prompt: string, chatId: string, topicId: number | undefined, collector: TurnCollector): Promise<string> {
    const notice = (text: string) => deps.registry.sendAsAgent(agent, chatId, text, { threadId: topicId });
    const messages = deps.progressMessages?.(chatId, topicId);
    const sink = messages ? createProgressSink(messages, notice) : { progress() {}, notice };
    try {
      return await runExecution(
        sessionKeyFor(chatId, topicId ?? null),
        agent,
        () =>
          deps.runStreamingTurn({
            userMessage: prompt,
            chatId,
            agentName: agent,
            topicId,
            sink,
            onSessionId: async (id, meta) => {
              collector.onSessionId(id, meta);
              await deps.onSessionId?.(id, meta);
            },
            onSessionMeta: collector.onSessionMeta,
            onInfo: collector.onInfo,
            onTools: collector.onTools,
          }),
        deps.allowedTools?.(agent),
      );
    } catch (error) {
      if (isAbortError(error)) return ABORT_REPLY;
      throw error;
    }
  }

  async function turn(chatId: string, task: string, topicId: number | undefined): Promise<void> {
    await deps.registry.sendTypingAsAgent(agent, chatId, topicId).catch(() => {});
    const collector = turnInfoCollector();
    const response = await streamTurn(task, chatId, topicId, collector);
    if (response === ABORT_REPLY) {
      await deps.notice(chatId, deps.isShuttingDown() ? SHUTDOWN_ABORT_REPLY : ABORT_REPLY, topicId).catch(() => {});
      return;
    }

    await deps.saveMessage({ chat_id: chatId, role: "assistant", content: response, metadata: { agent, topicId, ...collector.metadata() } });
    await deps.processIntents(response, collector.tools(), { chatId, topicId, origin: "Anruf" });
    deps.onAgentTurn(sessionKeyFor(chatId, topicId ?? null), agent, response);

    const requests = extractConsults(response);
    if (requests.length > 0) {
      const ownText = stripConsultTags(response);
      if (ownText) await deps.registry.sendAsAgent(agent, chatId, ownText, { threadId: topicId });
      for (const request of limitConsults(requests, deps.invokeBudget)) {
        await consultViaAgentBots({
          bots: deps.registry,
          fromAgent: agent,
          request,
          chatId,
          threadId: topicId,
          ask: (prompt, target, targetAgent, thread) => deps.callClaude(prompt, target, targetAgent, thread),
          delivered: async (target, text) => {
            if (!text.trim() || text === ABORT_REPLY) return;
            await deps.saveMessage({ chat_id: chatId, role: "assistant", content: text, metadata: { agent: target, topicId, invokedBy: agent } }).catch(() => {});
          },
          deps: deps.recentMessages ? { recent: deps.recentMessages } : undefined,
        });
      }
      return;
    }

    const question = detectTaskQuestion(response);
    if (question.needsInput && question.options.length > 0) {
      const pending = await deps.createTask(chatId, task, topicId);
      if (pending) {
        await deps.updateTask(pending.id, {
          status: "needs_input",
          session_id: collector.sessionId(),
          pending_question: question.question || undefined,
          pending_options: question.options,
          current_step: question.text.slice(0, 500),
          metadata: collector.taskMetadata(agent),
        });
        await deps.registry.sendWithKeyboardAsAgent(agent, chatId, response, taskQuestionKeyboard(pending.id, question.options), { threadId: topicId });
        return;
      }
    }

    await deps.registry.sendAsAgent(agent, chatId, response, { threadId: topicId });
  }

  return async (chatId, task, topicId) => {
    try {
      await runCancelable(sessionKeyFor(chatId, topicId ?? null), () => turn(chatId, task, topicId));
    } catch (error) {
      let text: string = CALL_TASK_TEXT.failed;
      if (isRestartPendingError(error)) text = RESTART_PENDING_REPLY;
      else if (isAbortError(error)) text = deps.isShuttingDown() ? SHUTDOWN_ABORT_REPLY : ABORT_REPLY;
      else log(`[phone] Auftrag in ${chatId} gescheitert (${error instanceof Error ? error.name : "Fehler"})`);
      await deps.notice(chatId, text, topicId).catch(() => {});
    } finally {
      deps.afterTurn?.(chatId, topicId);
    }
  };
}
