/**
 * Der Supabase-Weg der Nachrichten mit dem gemeinsamen Client (getSupabase),
 * für Tests, die genau diesen Weg prüfen, egal was getStore() wählt. Bis
 * Issue #382 standen gleichwertige Einstiege in src/lib/supabase.ts; hier
 * rufen sie die Bausteine des Adapters direkt auf. Speichern ohne
 * msgId-Vergabe und ohne Ereignis, wie früher; mit Ereignis speichert
 * getStore().messages.save.
 *
 * Wer einen Client übergibt (auch null), prüft genau diesen; ohne Angabe
 * gilt der gemeinsame Client zum Zeitpunkt des Aufrufs.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadBoardContext } from "../src/lib/conversation-context";
import { getSupabase } from "../src/lib/supabase";
import { activityByTopic, historyPage, supabaseMessageReads } from "../src/lib/store/supabase/message-reads";
import { insertRow, recentRows, supabaseMessages, writeMessage, type InsertClient } from "../src/lib/store/supabase/messages";
import type { HistoryOptions, HistoryRow, Message, TopicActivity } from "../src/lib/store/types";

/** Lesende Methoden über den gemeinsamen Client bzw. den übergebenen */
export function reads(client?: SupabaseClient | null) {
  return supabaseMessageReads(client === undefined ? getSupabase : () => client);
}

/** Edge Function, sonst direkter Insert; Meldungen nur direkt. Ohne Client false */
export async function saveDirect(message: Message): Promise<boolean> {
  const client = getSupabase();
  return client ? writeMessage(message, client) : false;
}

/** Direkter Insert ohne Edge Function (Weg der Meldungen). Ohne Client false */
export async function insertDirect(message: Message, client: InsertClient | null = getSupabase()): Promise<boolean> {
  return client ? insertRow(message, client) : false;
}

/** Letzte Nachrichten ohne Meldungen, älteste zuerst */
export async function recentDirect(chatId: string, limit = 20, topicId?: number | null): Promise<Message[]> {
  const client = getSupabase();
  return client ? recentRows(client, chatId, limit, topicId) : [];
}

/** Verlauf einer Sitzung für die WebUI; ohne Client leer */
export async function historyDirect(
  chatId: string,
  topicId: number | null,
  options: HistoryOptions,
  client: SupabaseClient | null = getSupabase(),
): Promise<HistoryRow[]> {
  return client ? historyPage(client, chatId, topicId, options) : [];
}

/** Jüngster Zeitpunkt je Sitzung; ohne Client leer */
export async function activityDirect(
  chatId: string,
  sinceDays: number,
  client: SupabaseClient | null = getSupabase(),
  now: number = Date.now(),
): Promise<TopicActivity[]> {
  return client ? activityByTopic(client, chatId, sinceDays, now) : [];
}

/** /board-Kontext über Supabase; ohne Client der feste Hinweis */
export async function boardDirect(days = 7): Promise<string> {
  return loadBoardContext(getSupabase() ? supabaseMessages(getSupabase) : null, days);
}
