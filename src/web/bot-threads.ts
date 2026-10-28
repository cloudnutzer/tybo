/**
 * Echte Quelle der Fäden-API (Issue #293) für src/bot.ts: Ablage aus
 * src/lib/threads/store.ts, Texte wie /faeden aus src/lib/threads/format.ts.
 * Schließen geht über applyThreadButton (wie die Knöpfe der Erinnerung,
 * unter der Sperre der Ablage); die offenen Rückfragen des Fadens lässt der
 * Zuhörer aus installThreadChoiceExpiry ablaufen, den src/bot.ts einrichtet.
 * Wie bot-routines.ts bindet nur src/bot.ts diese Datei ein; Tests nutzen sie
 * mit umgelenkter Ablage (setThreadsFileForTests).
 */

import type { ChoiceConversation } from "../lib/choices";
import { threadsWorkPending } from "../lib/threads/detect";
import { closedReasonText, deadlineText, reminderLine, threadAge, threadPlace } from "../lib/threads/format";
import { laterReminderTime, reminderTimeZone } from "../lib/threads/schedule";
import { applyThreadButton, listOpenThreads, listRecentlyClosedThreads, threadsEnabled, type Thread } from "../lib/threads/store";
import { WEB_DM_CHAT_ID } from "../lib/channels";
import type { ThreadRecord, ThreadsPort } from "./threads";

type Env = Record<string, string | undefined>;

export interface BotThreadsDeps {
  env?: () => Env;
  /** Direktchat (TELEGRAM_USER_ID); fehlt: nur der Web-Direktchat */
  userId?: () => string | null;
  /** Gruppe der Topics; null ohne Telegram */
  groupId?: () => string | null;
  now?: () => number;
}

/** Gespräch der WebUI und Art eines Fadens; id null, wenn die WebUI das Gespräch nicht zeigt */
export function threadWebConversation(
  c: ChoiceConversation,
  userId: string | null,
  groupId: string | null
): { type: ThreadRecord["conversation"]["type"]; id: string | null } {
  if (c.type === "web") return { type: "web", id: c.conversationId };
  if (c.chatId === WEB_DM_CHAT_ID || (userId && c.chatId === userId)) return { type: "dm", id: c.topicId === undefined ? "dm" : null };
  const topicId = c.topicId ?? 1;
  const type = topicId === 1 ? "general" : "topic";
  return { type, id: groupId && c.chatId === groupId ? `topic-${topicId}` : null };
}

export function createBotThreads(deps: BotThreadsDeps = {}): ThreadsPort {
  const env = deps.env ?? (() => process.env);
  const now = deps.now ?? (() => Date.now());

  function record(t: Thread, at: number, zone: string): ThreadRecord {
    const safe = (fn: (() => string | null) | undefined) => {
      try {
        return fn?.() ?? null;
      } catch {
        return null;
      }
    };
    const web = threadWebConversation(t.conversation, safe(deps.userId), safe(deps.groupId));
    const reminder = t.state === "open" ? reminderLine(t, zone) : null;
    return {
      id: t.id,
      nr: t.nr,
      state: t.state,
      topic: t.topic,
      context: t.context,
      question: t.question,
      conversation: { ...web, place: threadPlace(t, {}) },
      createdAt: t.createdAt,
      ageText: threadAge(t.createdAt, at),
      ...(t.deadline ? { deadline: t.deadline, deadlineText: deadlineText(t.deadline) } : {}),
      ...(t.nextReminderAt !== undefined ? { nextReminderAt: t.nextReminderAt } : {}),
      ...(reminder ? { reminderText: reminder } : {}),
      reminders: t.reminders,
      ...(t.closedAt !== undefined ? { closedAt: t.closedAt, closedReason: closedReasonText(t.closedReason) } : {}),
    };
  }

  return {
    enabled: () => threadsEnabled(env()),
    pending: () => threadsWorkPending(),
    async list(includeClosed) {
      const at = now();
      const zone = reminderTimeZone(env());
      const open = await listOpenThreads();
      const closed = includeClosed ? await listRecentlyClosedThreads(at) : [];
      return { open: open.map(t => record(t, at, zone)), closed: closed.map(t => record(t, at, zone)) };
    },
    async close(id, reason) {
      const outcome = await applyThreadButton(id, reason, at => laterReminderTime(at, env()));
      return outcome.status === "closed" ? "closed" : "not-open";
    },
  };
}
