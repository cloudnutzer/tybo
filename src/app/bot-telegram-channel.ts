/**
 * Telegram-Kanal des laufenden Bots (Issue #344): setzt createTelegramChannel
 * mit den echten Bausteinen zusammen. Text und Medien teilen sich den
 * Abschluss eines Turns (src/lib/turn-finish.ts): speichern, Merk-Tags,
 * /goal, Konsultationen ([INVOKE:]) oder Antwort mit Rückfrage, offene Fäden.
 * Ohne Telegram baut der Bot diesen Kanal zwar, hängt ihn aber nie an.
 */
import type { Context } from "grammy";
import { getAgentByTopicId } from "../agents";
import { boardAgentNames, isActiveAgent, listAgentNames } from "../agents/catalog";
import { consultViaAgentBots, stripConsultTags } from "../lib/agent-consult";
import { gatherBoardData } from "../lib/board/data";
import { createTelegramBoardOutput, runBoardMeeting } from "../lib/board-meeting";
import { ABORT_REPLY, SHUTDOWN_ABORT_REPLY } from "../lib/chat-turn";
import { commandRegistry } from "../lib/commands/builtin";
import type { CommandServices } from "../lib/commands/types";
import { abortEngineCalls } from "../lib/engines";
import { blockExecutions, isAbortError, isExecutionActive, isRestartPendingError, RESTART_PENDING_REPLY, runCancelable } from "../lib/execution-context";
import { handleGoalCallback } from "../lib/goal-actions";
import { onAgentTurnForGoal } from "../lib/goal-engine";
import { processTurnIntents } from "../lib/intent-gate";
import { fallbackReplyForTask } from "../lib/fallback/context";
import { cleanupMedia, finishMedia, prepareMedia } from "../lib/media-turn";
import { createQueueNotifier } from "../lib/queue-notice";
import { distillSession, shouldDistill } from "../lib/session-distill";
import { getSessionsForKey, isSessionModeEnabled, resetSession } from "../lib/session-manager";
import { isVoiceEnabled, textToSpeech } from "../lib/speech";
import { storeOr } from "../lib/store";
import { directChatIds } from "../lib/task-place";
import type { TelegramRuntime } from "../lib/telegram-runtime";
import { expiredApprovalButtons } from "../channels/telegram/expired-approvals";
import { noteTurnForThreads, threadConversation } from "../lib/threads/detect";
import { takeThreadTurnHint } from "../lib/threads/hint";
import { claimTopicMappingQuestion } from "../lib/topic-setup";
import { captureTopicName, getTopicNames, recordTopicName, recordTopicNameIfMissing } from "../lib/topic-names";
import { turnInfoCollector } from "../lib/turn-collector";
import { createTurnFinish } from "../lib/turn-finish";
import type { Message } from "../lib/store/types";
import { botGroupId } from "../web/bot-telegram";
import { handleTopicServiceMessage, topicChanges } from "../web/topic-changes";
import type { BotChoices } from "./bot-choices";
import type { BotTurns } from "./bot-turns";
import { createCallbackRouter } from "../channels/telegram/callbacks";
import { createTelegramChannel } from "../channels/telegram/channel";
import { createTelegramCommands } from "../channels/telegram/commands";
import { downloadTelegramFile, type MediaInboxDeps } from "../channels/telegram/media-inbox";
import { createTelegramReply } from "../channels/telegram/reply-turn";
import { createTypingIndicator, sendResponse } from "../channels/telegram/send";
import { createUpdateScope } from "../channels/telegram/update-scope";
import { logErrorMasked } from "../lib/telegram-token-mask";

type Env = Record<string, string | undefined>;

export interface BotTelegramChannelDeps {
  env: Env;
  runtime: TelegramRuntime;
  turns: BotTurns<Context>;
  choices: Pick<BotChoices, "topicChoices" | "proactiveChoices" | "reviewResults"> & Partial<Pick<BotChoices, "jobReply">>;
  services: CommandServices;
  isShuttingDown(): boolean;
  afterTurn(chatId: string, topicId?: number): void;
  invokeBudget: number;
  /** Nur für Tests: Bausteine mit Ablage, Netz oder Dateien ersetzen (Standard die echten) */
  parts?: Partial<ChannelParts>;
}

const saveMessage = (message: Message) => storeOr(false, store => store.messages.save(message));
const topicStore = { recordTopicName, recordTopicNameIfMissing };

/** Offene Fäden (Issue #290): nach dem Versand, nur für Nachrichten */
function noteThreads(chatId: string, topicId: number | undefined, userText: string, reply: string, turnStartedAt: number): void {
  const conversation = threadConversation(chatId, topicId);
  if (conversation) noteTurnForThreads({ conversation, userText, reply, turnStartedAt });
}

/** Hinweis nach einer Erinnerung an einen offenen Faden (Issue #292), einmal vor dem Turn */
const threadHint = (chatId: string, topicId: number | undefined) => takeThreadTurnHint(threadConversation(chatId, topicId));

const CHANNEL_PARTS = {
  saveMessage,
  processIntents: processTurnIntents,
  onGoalTurn: (key: string, agent: string, reply: string) => void onAgentTurnForGoal(key, agent, reply),
  noteThreads,
  threadHint,
  captureTopicName: (topicId: number, message: unknown) => captureTopicName(topicStore, topicId, message),
  prepareMedia,
  finishMedia,
  cleanupMedia,
};
type ChannelParts = typeof CHANNEL_PARTS & { download: MediaInboxDeps["download"] };

export function wireTelegramChannel(deps: BotTelegramChannelDeps) {
  const { env, runtime, turns } = deps;
  const agents = runtime.agents;
  const owner = env.TELEGRAM_USER_ID ?? "";
  const agentFor = (chatId: string, topicId: number | undefined) => (topicId ? getAgentByTopicId(topicId, chatId) || "general" : "general");
  const typing = (ctx: Context) => createTypingIndicator(ctx);
  const { saveMessage, processIntents, noteThreads, threadHint, ...parts }: ChannelParts = {
    ...CHANNEL_PARTS,
    download: (item, ctx) => downloadTelegramFile(ctx.api, item.fileId, { token: env.TELEGRAM_BOT_TOKEN ?? "", declaredSize: item.size }),
    ...deps.parts,
  };

  const finishTurn = createTurnFinish({
    saveMessage,
    processIntents,
    onGoalTurn: parts.onGoalTurn,
    // [INVOKE:] (Issue #341): Antwort vom Bot des befragten Agenten im selben Topic
    invoke: (fromAgent, request, chatId, topicId, delivered) =>
      consultViaAgentBots({ bots: agents, fromAgent, request, chatId, threadId: topicId, ask: turns.ask, delivered }),
    invokeBudget: deps.invokeBudget,
    noteThreads,
  });

  const reply = createTelegramReply<Context>({
    runTurn: (ctx, { collector, ...run }) =>
      turns.askWithProgress(ctx, run.userMessage, run.chatId, run.agentName, run.topicId, {
        onInfo: collector.onInfo,
        onTools: collector.onTools,
        onSessionId: collector.onSessionId,
        onSessionMeta: collector.onSessionMeta,
        turnHint: run.turnHint,
        onQuestion: run.onQuestion,
      }),
    typing,
    reply: (ctx, text) => ctx.reply(text),
    sendAsAgent: (agent, chatId, text, options) => agents.sendAsAgent(agent, chatId, text, options),
    finishTurn,
    threadTurnHint: threadHint,
    isShuttingDown: deps.isShuttingDown,
    afterTurn: deps.afterTurn,
  });

  const runCommand = createTelegramCommands<Context, Awaited<ReturnType<typeof getSessionsForKey>>[number]>({
    services: deps.services,
    agentFor,
    typing,
    sessionReset: {
      isActive: isExecutionActive,
      block: blockExecutions,
      sessionsForKey: getSessionsForKey,
      shouldDistill,
      distill: distillSession,
      reset: (key, options) => resetSession(key, undefined, options),
      sessionModeEnabled: isSessionModeEnabled,
    },
    agentReply: reply,
    voice: {
      enabled: isVoiceEnabled,
      newTurn: turnInfoCollector,
      runTurn: (ctx, prompt, chatId, agent, topicId, turn) => turns.askWithProgress(ctx, prompt, chatId, agent, topicId, { onInfo: turn.onInfo, onTools: turn.onTools }),
      saveMessage,
      processIntents,
      speak: textToSpeech,
      sendText: (ctx, text) => sendResponse(ctx, text),
    },
    board: {
      agents: boardAgentNames,
      gatherData: gatherBoardData,
      stripInvocationTags: stripConsultTags,
      ask: (prompt, chatId, agent, topicId, onInfo) => turns.ask(prompt, chatId, agent, topicId, { onInfo }),
      saveMessage,
      sendAsAgent: (agent, chatId, text, options) => agents.sendAsAgent(agent, chatId, text, options),
      sendTypingAsAgent: (agent, chatId, threadId) => agents.sendTypingAsAgent(agent, chatId, threadId),
      notice: (ctx, text) => ctx.reply(text),
      run: runBoardMeeting,
      output: createTelegramBoardOutput,
    },
  });

  const scope = createUpdateScope({
    runCancelable: (key, run, options) => runCancelable(key, run, options),
    queueNotice: send => createQueueNotifier(send, getTopicNames),
    isRestartPending: isRestartPendingError,
    isAbort: isAbortError,
    restartPendingText: RESTART_PENDING_REPLY,
  });

  const { topicChoices, proactiveChoices, reviewResults } = deps.choices;
  const channel = createTelegramChannel({
    owner,
    scope,
    text: {
      jobReply: deps.choices.jobReply,
      captureTopicName: parts.captureTopicName,
      saveMessage,
      matchCommand: text => commandRegistry.match(text, "telegram"),
      runCommand,
      agentForMention: text => agents.agentForMention(text),
      isActiveAgent,
      topicAgent: (topicId, chatId) => getAgentByTopicId(topicId, chatId),
      claimTopicQuestion: claimTopicMappingQuestion,
      askTopicAgent: (chatId, topicId) => topicChoices.ask(chatId, topicId),
      agentNames: listAgentNames,
      reply,
    },
    media: {
      download: parts.download,
      prepare: parts.prepareMedia,
      finish: parts.finishMedia,
      cleanup: parts.cleanupMedia,
      saveMessage,
      agentFor,
      turnHint: threadHint,
      runTurn: (ctx, prompt, chatId, agent, topicId, turn, hint, onQuestion) =>
        turns.askWithProgress(ctx, prompt, chatId, agent, topicId, { onInfo: turn.onInfo, onTools: turn.onTools, turnHint: hint, onQuestion }),
      newTurn: turnInfoCollector,
      finishTurn,
      send: (ctx, response) => sendResponse(ctx, response),
      isShuttingDown: deps.isShuttingDown,
      typing,
      now: () => Date.now(),
      logError: logErrorMasked,
    },
    callbacks: {
      toolApproval: expiredApprovalButtons(owner),
      // Ohne Telegram keine Knöpfe in Telegram (Issue #227)
      choices: runtime.telegram ? runtime.choices : undefined,
      router: createCallbackRouter({
        topicMap: (chatId, topicId, agent) => topicChoices.legacy(chatId, topicId, agent),
        checkin: (data, message) => proactiveChoices.legacyCallback(data, message),
        goal: data => handleGoalCallback(data, { abort: abortEngineCalls }),
        review: (action, reviewId) => reviewResults.legacy(action, reviewId),
        task: {
          directChatIds: () => directChatIds(env),
          fallbackReply: (task, chatId) => fallbackReplyForTask(task, chatId),
          send: (ctx, text) => sendResponse(ctx, text),
          saveMessage,
          processIntents: (text, tools, target) => processIntents(text, tools, target),
          updateTask: (taskId, changes) => storeOr(false, store => store.tasks.update(taskId, changes)),
          noteThreads,
          abortedText: () => (deps.isShuttingDown() ? SHUTDOWN_ABORT_REPLY : ABORT_REPLY),
          typing,
        },
      }),
    },
    topicService: (chatId, message) =>
      void handleTopicServiceMessage({ groupId: () => botGroupId(env), store: topicStore, notify: topicChanges.emit }, chatId, message),
  });

  return { channel, reply };
}
