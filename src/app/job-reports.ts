/** Job-Berichte im laufenden Bot, ohne eigenen Bot oder fremden Projektordner. */
import { join } from "node:path";
import { getAgentByTopicId, getAgentConfigOrGeneral } from "../agents";
import { runStreamingTurn } from "../lib/chat-turn";
import { dmChatId, webConversationOf } from "../lib/channels";
import { abortEngineCalls } from "../lib/engines";
import { processTurnIntents } from "../lib/intent-gate";
import { withJobChain } from "../lib/jobs/chain-context";
import { createJobDeps } from "../lib/jobs/default-deps";
import { jobReportInput } from "../lib/jobs/report-input";
import { createJobReturnQueue, type RunJobReport } from "../lib/jobs/return";
import type { NoticeDeps } from "../lib/jobs/notice";
import { routineConversation } from "../lib/routine-choices";
import { storeOr } from "../lib/store";
import type { TelegramRuntime } from "../lib/telegram-runtime";
import { conversationGoneCheck } from "../lib/threads/remind";
import { botGroupId, botTopicState } from "../web/bot-telegram";
import { createTelegramChat } from "../web/bot-turn";
import type { WebChat } from "../web/chat";
import type { WebServer } from "../web/server";
import { isConversationListed } from "../web/store";
import { telegramTopicConversationId } from "../web/telegram";

export interface JobReportRunnerDeps extends Pick<NoticeDeps, "root" | "secrets"> {
  userId: string;
  groupId: string | null;
  web(): Pick<WebServer, "runJobReport"> | null;
  telegramChat: WebChat;
  conversationGone: ReturnType<typeof conversationGoneCheck>;
}

export function createJobReportRunner(deps: JobReportRunnerDeps): RunJobReport {
  return async (status, claim) => {
    const chatId = status.target.chatId ?? (status.target.topicId !== undefined ? deps.groupId : deps.userId);
    if (!chatId) return "retry";
    const conversation = routineConversation(chatId, status.target.topicId);
    if (!conversation) return "gone";
    const gone = await deps.conversationGone(conversation);
    if (gone === true) return "gone";
    if (gone === null) return "retry";
    const input = await jobReportInput(deps.root, status, deps.secrets());
    if (!input) return "gone";
    let removed = false;
    const guardedClaim = async () => {
      // Während des Wartens kann der Nutzer das Gespräch gelöscht haben.
      const missing = await deps.conversationGone(conversation);
      removed = missing === true;
      return missing === false && await claim();
    };
    const webId = webConversationOf(chatId);
    const id = webId ?? (status.target.topicId !== undefined ? telegramTopicConversationId(status.target.topicId)
      : chatId.startsWith("-") ? telegramTopicConversationId(1) : "dm");
    const web = deps.web();
    const result = await withJobChain(input.chain, async () => {
      if (web) return web.runJobReport(id, { ...input, claim: guardedClaim });
      // Reine Web-Gespräche benötigen den ChatHub, damit Verlauf und Sperre stimmen.
      if (webId || chatId === "web") return "retry" as const;
      const turn = await deps.telegramChat.runTurn({ conversationId: id, agent: "general", text: input.text,
        jobReport: { ...input, claim: guardedClaim }, sink: { progress() {}, notice() {} } });
      return turn.deferred ? "retry" as const : "done" as const;
    });
    return removed ? "gone" : result;
  };
}

export function createBotJobReports(o: {
  root: string;
  env: Record<string, string | undefined>;
  runtime: TelegramRuntime;
  web(): WebServer | null;
  isShuttingDown(): boolean;
  scheduleRestartCheck(trigger: string): void;
}) {
  const jobs = createJobDeps(o);
  const userId = dmChatId(o.env);
  const groupId = botGroupId(o.env);
  const runner = createJobReportRunner({ ...jobs, userId, groupId, web: o.web,
    conversationGone: conversationGoneCheck({ webConversationExists: id => isConversationListed(id, join(o.root, "data", "web")),
      topicDeleted: async (chatId, topicId) => (await botTopicState.get(chatId, topicId)).deleted === true }),
    telegramChat: createTelegramChat({ userId, groupId: () => groupId, agentForTopic: getAgentByTopicId,
      runStreamingTurn, abortEngineCalls, isShuttingDown: o.isShuttingDown, scheduleRestartCheck: o.scheduleRestartCheck,
      saveMessage: message => storeOr(false, store => store.messages.save(message)),
      processIntents: (text, turn) => processTurnIntents(text, turn.tools, turn),
      allowedTools: agent => getAgentConfigOrGeneral(agent)?.allowedTools,
      sendPlain: (chatId, text, topicId) => o.runtime.sendPlain(chatId, text, topicId),
      sendAsAgent: (agent, chatId, text, topicId) => o.runtime.agents.sendAsAgent(agent, chatId, text, { threadId: topicId }),
    }),
  });
  return createJobReturnQueue(jobs, runner);
}
