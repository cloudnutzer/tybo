/**
 * Kanal-Weiche (Issue #227, Entscheidung 0021): tybo läuft mit Telegram, mit
 * der WebUI allein oder mit beidem. Ob Telegram eingerichtet ist, sagt nur
 * telegramConfigured; alle Weichen (Outbox, Direktchat der WebUI, Forum-Gruppe,
 * Rückfragen, bot-interne Meldungen) fragen diese eine Funktion.
 *
 * Ohne Telegram ist der Direktchat ein Web-Gespräch unter der festen Chat-ID
 * "web" (Session-Schlüssel dm:web), reine Web-Gespräche liegen wie bisher
 * unter web:<uuid>. Solche Chat-IDs gehen nie an die Telegram-API.
 */

type Env = Record<string, string | undefined>;

/** Chat-ID des Direktchats ohne Telegram */
export const WEB_DM_CHAT_ID = "web";

const USER_ID_PATTERN = /^\d{1,20}$/;
const WEB_CONVERSATION_PATTERN = /^web:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const CONVERSATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Gültige Telegram-Nutzer-ID: nur Ziffern */
export function isTelegramUserId(value: string): boolean {
  return USER_ID_PATTERN.test(value.trim());
}

/** Telegram ist eingerichtet: TELEGRAM_BOT_TOKEN gesetzt und TELEGRAM_USER_ID eine gültige Nutzer-ID */
export function telegramConfigured(env: Env = process.env): boolean {
  const token = env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  const user = env.TELEGRAM_USER_ID?.trim() ?? "";
  return token !== "" && USER_ID_PATTERN.test(user);
}

/** Chat-ID des Direktchats: die Telegram-Nutzer-ID, ohne Telegram "web" */
export function dmChatId(env: Env = process.env): string {
  return telegramConfigured(env) ? env.TELEGRAM_USER_ID!.trim() : WEB_DM_CHAT_ID;
}

/** Gesprächs-ID eines reinen Web-Gesprächs (UUID wie im Gesprächsspeicher) */
export function isWebConversationId(id: unknown): id is string {
  return typeof id === "string" && CONVERSATION_ID_PATTERN.test(id);
}

/** Chat-ID eines reinen Web-Gesprächs im Nachrichtenspeicher */
export function webConversationChatId(conversationId: string): string {
  return `web:${conversationId}`;
}

/** Gesprächs-ID aus einer Chat-ID web:<uuid>; null bei allem anderen */
export function webConversationOf(chatId: unknown): string | null {
  if (typeof chatId !== "string") return null;
  return WEB_CONVERSATION_PATTERN.exec(chatId)?.[1] ?? null;
}

/** Chat-ID, die nur in der WebUI lebt: der Web-Direktchat "web" oder ein Web-Gespräch web:<uuid> */
export function isWebChatId(chatId: unknown): chatId is string {
  return chatId === WEB_DM_CHAT_ID || webConversationOf(chatId) !== null;
}

/**
 * Zugestellt (Ergebnis von sendAndRecord aus outbox.ts): an Telegram gesendet
 * oder, bei einem Web-Ziel bzw. ohne Telegram, für die WebUI festgehalten.
 * Dienste, Jobs und Rückfragen prüfen damit statt mit sent, sonst gälte eine
 * reine WebUI-Meldung als gescheitert und würde wiederholt.
 */
export function outboxDelivered(result: { sent: boolean; recorded?: boolean; error?: unknown }): boolean {
  return result.sent || (result.recorded === true && !result.error);
}
