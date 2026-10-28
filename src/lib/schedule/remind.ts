/**
 * Der Tag `[REMIND: wann | Text]` (Issue #322): Zeitangabe lesen und
 * Erinnerungen anlegen. Der Tag-Name ist Schnittstelle zu Modell und Prompt.
 *
 * Zeitangaben (parseReminderTime), gerechnet in USER_TIMEZONE wie when.ts:
 * - alles, was parseWhen liest: „17:30", „9 Uhr", „5pm", „in 2 Stunden",
 *   „in 20 Minuten", ISO-Zeitpunkt (mit oder ohne Versatz)
 * - Tag und Uhrzeit: „morgen 9 Uhr", „morgen um 14:30", „Freitag 8:15",
 *   „2026-10-20 18 Uhr"; eine bloße Zahl als Stunde nur nach „um" bzw. „at"
 *   („morgen um 9", „um 9")
 * - nur ein Tag („morgen", „Freitag", „in 3 Tagen"): an diesem Tag um 9 Uhr,
 *   nicht wie bei Fristen um 23:59
 * Ein Zeitpunkt in der Vergangenheit gilt: die Erinnerung ist sofort fällig
 * und kommt im nächsten Durchlauf des Planers, mit Hinweis auf die
 * Verspätung. Unlesbar: nichts wird angelegt.
 *
 * Vorschlag statt Anwenden (intent-gate.ts): fixReminderTimes rechnet jede
 * Zeitangabe beim Ablegen in einen festen Zeitpunkt (ISO in UTC) um, damit
 * „in 2 Stunden" auch bei späterer Zustimmung von der Antwort aus zählt, und
 * lässt Tags mit unlesbarer Zeit oder ohne Text weg.
 *
 * Turn ohne Telegram (Denkauftrag aus dem Telefonhörer, Issue #259) in einem
 * Telegram-Gespräch: Die Erinnerung gehört weiter zu diesem Gespräch, kommt
 * aber nur in der WebUI an. Gespeichert wird sie mit der Chat-ID
 * webOnlyChatId(Telegram-Chat) und dem Topic wie sonst.
 */
import { dmChatId, isWebConversationId, webConversationChatId } from "../channels";
import type { ChoiceConversation } from "../choices";
import { remindParts } from "../memory/intents";
import { effectiveTimeZone, fromLocal, parseDay, parseWhen, type WhenOptions } from "../when";
import { shortStamp } from "./planner";

/** Vorsatz der Chat-ID einer Erinnerung, die nur in der WebUI ankommt (siehe Kopf) */
export const WEB_ONLY_PREFIX = "webui:";

/** Chat-ID für eine Erinnerung nur in der WebUI, zum Telegram-Chat chatId */
export function webOnlyChatId(chatId: string): string {
  return `${WEB_ONLY_PREFIX}${chatId}`;
}

/** Gespräch eines Turns und ob er ohne Telegram läuft (wie IntentConversation in memory/service.ts) */
export interface ReminderWhere {
  conversation?: ChoiceConversation;
  noTelegram?: { conversationId: string };
}

/**
 * Chat und Topic einer Erinnerung aus dem Gespräch des Turns, für [REMIND:]
 * und die Planungswerkzeuge des Motors api: reines Web-Gespräch als
 * web:<id>, ein Turn ohne Telegram im Web-Gespräch dort, im Direktchat bzw.
 * Topic mit Chat und Topic, aber nur für die WebUI (webOnlyChatId); sonst
 * Chat und Topic, ohne Gespräch der Direktchat.
 */
export function reminderChat(where: ReminderWhere | undefined, env: Record<string, string | undefined> = process.env): { chatId: string; topicId: number | null } {
  const conversation = where?.conversation;
  const webOnly = where?.noTelegram?.conversationId;
  if (conversation?.type === "web") return { chatId: webConversationChatId(conversation.conversationId), topicId: null };
  if (isWebConversationId(webOnly)) return { chatId: webConversationChatId(webOnly), topicId: null };
  if (conversation && webOnly) return { chatId: webOnlyChatId(conversation.chatId), topicId: conversation.topicId ?? null };
  if (conversation) return { chatId: conversation.chatId, topicId: conversation.topicId ?? null };
  return { chatId: dmChatId(env), topicId: null };
}

/** Telegram-Chat einer Chat-ID aus webOnlyChatId; null bei jeder anderen */
export function webOnlyChatOf(chatId: string): string | null {
  return chatId.startsWith(WEB_ONLY_PREFIX) && chatId.length > WEB_ONLY_PREFIX.length ? chatId.slice(WEB_ONLY_PREFIX.length) : null;
}

/** Uhrzeit, wenn nur ein Tag genannt ist */
export const REMIND_DEFAULT_HOUR = 9;

/** Uhrzeit am Ende: „9 Uhr", „9.30 Uhr", „14:30", „5pm", „5:30 pm"; Gruppe 1 der Rest davor */
const CLOCK_AT_END = /^(.*?)\s+(?:(um|at)\s+)?(\d{1,2})(?:([:.])(\d{2}))?(?:\s?(uhr|am|pm))?$/;

function clockOf(hourText: string, minuteText: string | undefined, separator: string | undefined, suffix: string | undefined, afterUm: boolean): { hour: number; minute: number } | null {
  // Ohne Doppelpunkt, „Uhr", am/pm oder „um" ist eine Zahl keine Uhrzeit („in 3 Tagen 5")
  if (!separator && !suffix && !afterUm) return null;
  // „9.30" nur mit „Uhr", sonst wäre es leicht ein Datum
  if (separator === "." && suffix !== "uhr") return null;
  let hour = Number(hourText);
  const minute = Number(minuteText ?? 0);
  if (suffix === "am" || suffix === "pm") {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (suffix === "pm" ? 12 : 0);
  }
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/** Zeitpunkt einer Erinnerung (siehe Kopf); undefined, wenn unlesbar */
export function parseReminderTime(input: string, options: WhenOptions = {}): Date | undefined {
  const raw = String(input ?? "").normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
  const text = raw.replace(/^(?:um|at|am) /, "");
  if (!text) return undefined;
  // „um 9" allein: die nächste 9-Uhr-Zeit
  if (text !== raw && /^\d{1,2}$/.test(text)) return parseWhen(`${text} uhr`, { ...options, timeZone: effectiveTimeZone(options.timeZone) });
  const zone = effectiveTimeZone(options.timeZone);
  const at = (day: { year: number; month: number; day: number }, hour: number, minute: number) => {
    const ms = fromLocal(day.year, day.month, day.day, hour, minute, 0, zone);
    return Number.isFinite(ms) ? new Date(ms) : undefined;
  };
  const day = parseDay(text, { ...options, timeZone: zone });
  if (day) return at(day, REMIND_DEFAULT_HOUR, 0);
  const split = CLOCK_AT_END.exec(text);
  if (split) {
    const dayPart = parseDay(split[1], { ...options, timeZone: zone });
    const clock = clockOf(split[3], split[5], split[4], split[6], split[2] !== undefined);
    if (dayPart && clock) return at(dayPart, clock.hour, clock.minute);
  }
  return parseWhen(text, { ...options, timeZone: zone });
}

const REMIND_TAG = /\[REMIND:([^\]]*)\]/gi;

/**
 * Für einen Vorschlag: jede Zeit in einen festen Zeitpunkt (ISO, UTC), Tags
 * mit unlesbarer Zeit oder ohne Text fallen weg. Andere Tags bleiben.
 */
export function fixReminderTimes(tags: string, options: WhenOptions = {}): string {
  return tags
    .replace(REMIND_TAG, (_tag, body: string) => {
      const parts = remindParts(body);
      const due = parts ? parseReminderTime(parts.when, options) : undefined;
      return parts && due ? `[REMIND: ${due.toISOString()} | ${parts.text}]` : "";
    })
    .split("\n")
    .filter(line => line.trim() !== "")
    .join("\n");
}

/** Zeile der Vorschau: Text und Zeitpunkt in der Zone; null, wenn der Tag unlesbar ist */
export function describeReminder(body: string, options: WhenOptions = {}): string | null {
  const parts = remindParts(body);
  const due = parts ? parseReminderTime(parts.when, options) : undefined;
  if (!parts || !due) return null;
  return `${parts.text} (${shortStamp(due.getTime(), effectiveTimeZone(options.timeZone))})`;
}
