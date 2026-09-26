/**
 * Dateinachweis für GET /api/files/<id> im Bot-Prozess (Issue #47): Die id
 * muss in einem festgehaltenen Nur-Anzeige-Eintrag des Direktchats oder der
 * Forum-Gruppe stehen, dessen Gespräch es in der WebUI gibt (nicht in einem
 * gelöschten Topic). Wie bot-telegram.ts bindet nur src/bot.ts diese Datei
 * ein; alle Zugriffe kommen als Abhängigkeiten herein.
 */

import { join } from "node:path";
import { findDisplayOnlyFile, type DisplayOnlyRow } from "../lib/convex";
import { PROJECT_ROOT } from "../lib/env";
import type { TopicStateEntry } from "../lib/topic-state";
import type { FileSource, FilesDeps } from "./files";
import { GENERAL_TOPIC_ID, botGroupId, botTopicState, liveConversationId } from "./bot-telegram";
import { pickNotice, type NoticeFile } from "./notice";
import { parseTelegramConversationId } from "./telegram";

type Env = Record<string, string | undefined>;

const USER_ID_PATTERN = /^\d{1,20}$/;

export interface FileSourceDeps {
  /** TELEGRAM_USER_ID */
  userId?: string;
  /** Chat-ID der Forum-Gruppe, bei jedem Aufruf neu */
  groupId(): string | null;
  /** Eintrag zur Datei in genau diesen Chats; wirft bei Speicherfehlern */
  find(fileId: string, chatIds: string[]): Promise<DisplayOnlyRow | null>;
  /** Topic-Zustand wie in bot-telegram.ts; Dateien gelöschter Topics gibt es nicht */
  topicState?(chatId: string): Promise<Map<number, TopicStateEntry>>;
}

export function createFileSource(deps: FileSourceDeps): FileSource {
  const userId = deps.userId && USER_ID_PATTERN.test(deps.userId) ? deps.userId : null;
  return {
    async find(id: string): Promise<NoticeFile | null> {
      let groupId: string | null = null;
      try {
        groupId = deps.groupId();
      } catch {
        groupId = null;
      }
      const chatIds = [userId, groupId].filter((c): c is string => !!c);
      if (chatIds.length === 0) return null;
      const row = await deps.find(id, chatIds);
      if (!row || typeof row.chat_id !== "string") return null;
      const file = pickNotice(row.metadata)?.file;
      if (!file || file.id !== id) return null;
      const metadata = row.metadata && typeof row.metadata === "object" ? row.metadata : {};
      const conversationId = liveConversationId({ chatId: row.chat_id, metadata }, userId, groupId);
      if (!conversationId) return null;
      const ref = parseTelegramConversationId(conversationId);
      if (groupId && ref?.kind === "topic" && ref.topicId !== GENERAL_TOPIC_ID && deps.topicState) {
        // Unlesbarer Zustand wirft weiter (503), statt eine Datei eines gelöschten Topics auszuliefern
        const states = await deps.topicState(groupId);
        if (states.get(ref.topicId)?.deleted) return null;
      }
      return file;
    },
  };
}

/** Echte Dateiquelle für src/bot.ts: Supabase und data/outbox */
export function createBotFiles(env: Env): FilesDeps {
  return {
    source: createFileSource({
      userId: env.TELEGRAM_USER_ID,
      groupId: () => botGroupId(env),
      find: findDisplayOnlyFile,
      topicState: chatId => botTopicState.forChat(chatId),
    }),
    dir: join(PROJECT_ROOT, "data", "outbox"),
  };
}
