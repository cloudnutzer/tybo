/**
 * Telegram-Gespräche in der WebUI (Issue #17): IDs, Typen und die
 * Schnittstelle, über die der Web-Server Direktchat und Topics liest.
 *
 * Nur reine Funktionen und Typen, nichts aus src/lib. Die echte Quelle baut
 * src/web/bot-telegram.ts, der Server bekommt sie als Abhängigkeit.
 *
 * IDs sind URL-tauglich und klar getrennt von den UUIDs der Web-Gespräche:
 *   dm         Direktchat
 *   topic-<n>  Forum-Topic n; topic-1 ist General (Session-Schlüssel group:<chatId>)
 */

import type { ApiMessage, MessageLog } from "./chat";
import { isChoiceId, pickReplyInfo, type StoredMessage } from "./store";

export type TelegramConversationRef = { kind: "dm" } | { kind: "topic"; topicId: number };

/** Positive ganze Zahl ohne führende Null, höchstens 10 Stellen */
const TOPIC_ID_PATTERN = /^topic-([1-9][0-9]{0,9})$/;

export function parseTelegramConversationId(id: unknown): TelegramConversationRef | null {
  if (id === "dm") return { kind: "dm" };
  if (typeof id !== "string") return null;
  const match = TOPIC_ID_PATTERN.exec(id);
  if (!match) return null;
  const topicId = Number(match[1]);
  return Number.isSafeInteger(topicId) ? { kind: "topic", topicId } : null;
}

export function telegramTopicConversationId(topicId: number): string {
  return `topic-${topicId}`;
}

export interface TelegramConversation {
  id: string;
  title: string;
  agent: string;
  /** ISO-Zeitpunkt der letzten Nachricht; null, wenn im erfassten Zeitraum keine liegt */
  lastActivity: string | null;
  /** In der WebUI geschlossen (Issue #29); fehlt bei offenen Topics */
  closed?: true;
  /**
   * Gespeicherter Name unverändert, nur wenn er vom angezeigten Titel abweicht
   * (Bestand mit Leerraum außen). Den verlangt DELETE als Bestätigung (Issue #30).
   */
  exactTitle?: string;
}

export interface TelegramConversationList {
  dm: TelegramConversation | null;
  /** Nach lastActivity absteigend, ohne Aktivität am Ende nach Name */
  topics: TelegramConversation[];
}

export type TelegramApiMessage = ApiMessage & { agent?: string };

export interface TelegramHistory {
  /** Chronologisch, älteste zuerst */
  messages: TelegramApiMessage[];
  /** Es gibt ältere Nachrichten vor der ersten gelieferten */
  hasMore: boolean;
}

export interface TelegramSource {
  listConversations(): Promise<TelegramConversationList>;
  /**
   * Chat-ID der Forum-Gruppe, aus der die Topics stammen; null, wenn unbekannt.
   * Die Löschvorschau nennt Topic-Namen nur bei dieser Chat-ID (Issue #51).
   */
  groupChatId?(): string | null;
  /** Eintrag aus dem Bestand; null bei unbekannter ID */
  getConversation(id: string): Promise<TelegramConversation | null>;
  /** null bei unbekannter ID; before ist ein geprüfter ISO-Zeitpunkt */
  history(id: string, before?: string): Promise<TelegramHistory | null>;
}

/**
 * Neue Nachricht aus dem Nachrichtenspeicher, einem Telegram-Gespräch
 * zugeordnet (Issue #20). message fehlt bei Nachrichten, die der Browser
 * schon kennt (im Web geschrieben); dann zählt nur die Aktivität.
 */
export interface TelegramLiveEvent {
  conversationId: string;
  /** ISO-Zeitpunkt für die letzte Aktivität in der Seitenleiste */
  at: string;
  message?: TelegramApiMessage;
}

/** Name eines Topics in Telegram geändert oder Topic dort angelegt (Issue #32); nur die ID */
export interface TelegramTopicChangeEvent {
  conversationId: string;
}

/** Quelle der Live-Nachrichten; subscribe gibt die Abmeldung zurück */
export interface TelegramLiveFeed {
  subscribe(listener: (event: TelegramLiveEvent) => void): () => void;
  /** Namensänderungen aus Telegram (Issue #32); gibt die Abmeldung zurück */
  subscribeTopicChanges?(listener: (event: TelegramTopicChangeEvent) => void): () => void;
}

/** Standardgröße einer Seite im Verlauf */
export const TELEGRAM_HISTORY_LIMIT = 50;

const ISO_PATTERN = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Normalisiert einen ISO-Zeitpunkt nach UTC, ohne Nachkommastellen zu
 * verlieren: Postgres speichert Mikrosekunden, ein auf Millisekunden
 * gekürzter Cursor würde beim Nachladen Nachrichten überspringen.
 * Drei Stellen, wenn die Mikrosekunden null sind, sonst sechs.
 * null bei allem, was kein vollständiger ISO-Zeitpunkt ist.
 */
export function normalizeIsoTimestamp(value: string): string | null {
  const match = ISO_PATTERN.exec(value);
  if (!match) return null;
  const [, seconds, rawFraction = "", zone] = match;
  const time = Date.parse(`${seconds}${zone}`);
  if (!Number.isFinite(time)) return null;
  const fraction = rawFraction.padEnd(6, "0");
  return `${new Date(time).toISOString().slice(0, 19)}.${fraction.endsWith("000") ? fraction.slice(0, 3) : fraction}Z`;
}

/** Prüft ?before= und gibt den Zeitpunkt normalisiert zurück (siehe normalizeIsoTimestamp) */
export function parseBeforeCursor(value: string): string | null {
  return normalizeIsoTimestamp(value);
}

/**
 * msgId einer Nachricht, die im Browser in ein Telegram-Gespräch geschrieben
 * wurde (Issue #19): Nutzernachricht und Antwort werden unter dieser ID in
 * Supabase gespeichert und kommen mit ihr zurück in den Verlauf. So erkennt
 * der Browser beim Nachladen, was er schon per SSE bekommen hat. Das Präfix
 * trennt sie von den numerischen Telegram-Nachrichten-IDs.
 */
export function newWebMessageId(): string {
  return `web-${crypto.randomUUID()}`;
}

const WEB_MESSAGE_ID_PATTERN = /^web-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isWebMessageId(value: unknown): value is string {
  return typeof value === "string" && WEB_MESSAGE_ID_PATTERN.test(value);
}

/**
 * Ablage des ChatHub für Telegram-Gespräche: schreibt keine Datei. Die
 * Nachricht bekommt nur ID und Zeitpunkt für POST-Antwort und SSE; dauerhaft
 * speichert der Turn sie in Supabase (msgId = diese ID). Fehlermeldungen wie
 * „Abgebrochen." gibt es deshalb nur live, nicht im Verlauf. Anhänge einer
 * Nutzernachricht (Issue #72) gehen mit in POST-Antwort und SSE.
 */
export function createTelegramMessageLog(now: () => number = Date.now): MessageLog {
  return {
    async appendMessage(_conversationId, message) {
      const stored: StoredMessage = {
        id: isWebMessageId(message.id) ? message.id : newWebMessageId(),
        role: message.role,
        text: message.text,
        createdAt: new Date(now()).toISOString(),
        ...(message.role === "assistant" && isChoiceId(message.choiceId) ? { choiceId: message.choiceId } : {}),
        ...(message.kind === "notice"
          ? { kind: "notice" as const, ...(message.source ? { source: message.source } : {}) }
          : message.role === "assistant"
            ? pickReplyInfo(message)
            : message.role === "user" && message.attachments?.length
              ? { attachments: message.attachments }
              : {}),
      };
      return stored;
    },
  };
}
