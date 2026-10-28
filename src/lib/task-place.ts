/**
 * Gesprächsbezug eines Auftrags aus async_tasks (Issue #337): zu welchem
 * Gespräch ein Auftrag gehört. Gilt für /tasks, alte atask-Knöpfe und die
 * Erinnerungen an wartende Aufträge.
 *
 * - Direktchat: chat_id ist die Telegram-Nutzer-ID oder "web", ohne
 *   thread_id. Beides ist dasselbe Gespräch: der Web-Direktchat zeigt den
 *   Telegram-Direktchat im Browser, und nach dem Abschalten von Telegram
 *   bleiben Aufträge unter der alten Nutzer-ID liegen.
 * - Telegram-Topic: chat_id der Gruppe und thread_id gleich Topic-ID. General
 *   hat keine thread_id, weil Telegram dort keine message_thread_id mitschickt.
 * - Reines Web-Gespräch: chat_id web:<id>, ohne thread_id.
 *
 * Ein Topic des Direktchats gibt es nicht: eine Nutzer-ID mit thread_id ist
 * ein eigenes Gespräch und nie der Direktchat.
 */

import { isTelegramUserId, WEB_DM_CHAT_ID } from "./channels";

type Env = Record<string, string | undefined>;

export interface TaskPlace {
  chatId: string;
  /** Topic; fehlt im Direktchat, in General und in reinen Web-Gesprächen */
  threadId?: number;
}

/** Chat-IDs des Direktchats: die Telegram-Nutzer-ID (falls gültig gesetzt) und immer "web" */
export function directChatIds(env: Env = process.env): string[] {
  const user = env.TELEGRAM_USER_ID?.trim() ?? "";
  return user !== "" && isTelegramUserId(user) ? [user, WEB_DM_CHAT_ID] : [WEB_DM_CHAT_ID];
}

/** Ort eines gespeicherten Auftrags; eine thread_id, die keine Zahl ist, zählt nicht */
export function placeOfTask(task: { chat_id: string; thread_id?: unknown }): TaskPlace {
  return typeof task.thread_id === "number" ? { chatId: task.chat_id, threadId: task.thread_id } : { chatId: task.chat_id };
}

/** Liegt der Ort im Direktchat? */
export function isDirectPlace(place: TaskPlace, directIds: readonly string[]): boolean {
  return place.threadId === undefined && directIds.includes(place.chatId);
}

/** Schlüssel des Gesprächs: gleiche Schlüssel heißen gleiches Gespräch */
function placeKey(place: TaskPlace, directIds: readonly string[]): string {
  if (isDirectPlace(place, directIds)) return "dm";
  return `${place.chatId}#${place.threadId ?? ""}`;
}

/** Gehören beide Orte zum selben Gespräch? */
export function samePlace(a: TaskPlace, b: TaskPlace, directIds: readonly string[]): boolean {
  return placeKey(a, directIds) === placeKey(b, directIds);
}

/** Chat-IDs, unter denen Aufträge dieses Gesprächs liegen können (für pending/running) */
export function placeChatIds(place: TaskPlace, directIds: readonly string[]): string[] {
  return isDirectPlace(place, directIds) ? [...directIds] : [place.chatId];
}
