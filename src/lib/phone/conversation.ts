/**
 * Gesprächsbezug eines Anrufs (Issue #367): wohin Zusammenfassung und
 * Auftrags-Rückfrage gehen. Ein reines Web-Gespräch (Chat-ID web:<id>) wird
 * zu { type: "web" }, alles andere bleibt ein Telegram-Chat samt Topic; der
 * Direktchat ohne Telegram ("web") zählt dabei als Telegram-Chat, wie im
 * Rückfragen-Register.
 */

import type { ChoiceConversation } from "../choices";
import { threadConversation } from "../threads/detect";

export function chatConversation(chatId: string, topicId?: number): ChoiceConversation {
  const known = threadConversation(chatId, topicId);
  if (known) return known;
  return topicId !== undefined ? { type: "telegram", chatId, topicId } : { type: "telegram", chatId };
}
