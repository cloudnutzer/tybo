/**
 * Echte Abhängigkeiten der Topic-Verwaltung (Issue #29) für src/bot.ts:
 * Topic-Zustand in data/topic-state.json, Zuordnung in config/topics.json,
 * Namen in data/topic-names.json, Sessions, Ausführungen und onMessageSaved.
 * Telegram selbst (TelegramTopicApi) baut bot.ts als Adapter um grammY
 * bot.api, weil nur dort der Bot existiert.
 *
 * Wie bot-telegram.ts bindet nur src/bot.ts diese Datei ein.
 */

import { onMessageSaved } from "../lib/convex";
import { abortExecutions, blockExecutions, isExecutionActive, waitForExecutions } from "../lib/execution-context";
import { resetSessionOrThrow } from "../lib/session-manager";
import { forgetTopicName, getTopicName, saveTopicName } from "../lib/topic-names";
import { isActiveAgent } from "../agents/catalog";
import { removeTopicMapping, setTopicMapping, TopicAgentInactive } from "../lib/topic-setup";
import { botGroupId, botTopicState } from "./bot-telegram";
import { createTopicManager, TopicAgentGone, type ExecutionPort, type TelegramTopicApi, type TopicManager } from "./topics";

type Env = Record<string, string | undefined>;

/** Ausführungen aus src/lib/execution-context.ts */
export const botExecutions: ExecutionPort = {
  isActive: isExecutionActive,
  block: blockExecutions,
  abort: abortExecutions,
  waitIdle: (key, timeoutMs) => waitForExecutions(key, timeoutMs),
};

/**
 * Zuordnung schreiben, nur wenn der Agent in der Schreibkette von
 * config/topics.json noch aktiv ist (Issue #50): ein gleichzeitiges Löschen
 * des Agenten hinterlässt so kein Topic mit gelöschtem Agenten.
 */
export async function botSetMapping(chatId: string, topicId: number, agent: string, file?: string): Promise<void> {
  try {
    await setTopicMapping(chatId, topicId, agent, file, isActiveAgent);
  } catch (e) {
    if (e instanceof TopicAgentInactive) throw new TopicAgentGone();
    throw e;
  }
}

export function createBotTopics(env: Env, api: TelegramTopicApi, log?: (message: string) => void): TopicManager {
  return createTopicManager({
    api,
    groupId: () => botGroupId(env),
    state: botTopicState,
    setMapping: (chatId, topicId, agent) => botSetMapping(chatId, topicId, agent),
    removeMapping: (chatId, topicId) => removeTopicMapping(chatId, topicId),
    saveName: saveTopicName,
    forgetName: forgetTopicName,
    getName: getTopicName,
    resetSession: resetSessionOrThrow,
    executions: botExecutions,
    onMessageSaved,
    log,
  });
}
