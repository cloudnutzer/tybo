/**
 * Echte Abhängigkeiten für den Session-Reset eines Gesprächs (Issue #61):
 * Schlüssel wie beim Schreiben (bot-turn.ts), Sessions aus
 * src/lib/session-manager.ts, Destillat wie /new in Telegram. Nur src/bot.ts
 * bindet diese Datei ein.
 */

import { blockExecutions, isExecutionActive } from "../lib/execution-context";
import { distillSession, shouldDistill } from "../lib/session-distill";
import { getSessionsForKey, isSessionModeEnabled, resetSessionOrThrow } from "../lib/session-manager";
import { conversationSessionKey, type TelegramChatDeps } from "./bot-turn";
import { createConversationSessionReset, type ConversationSessionReset } from "./session-reset";

export function createBotSessionReset(deps: Pick<TelegramChatDeps, "userId" | "groupId" | "agentForTopic">): ConversationSessionReset {
  return createConversationSessionReset({
    sessionKey: id => conversationSessionKey(id, deps),
    isActive: isExecutionActive,
    block: blockExecutions,
    sessionsForKey: getSessionsForKey,
    shouldDistill,
    distill: distillSession,
    reset: resetSessionOrThrow,
    sessionModeEnabled: isSessionModeEnabled,
  });
}
