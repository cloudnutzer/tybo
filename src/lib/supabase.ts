/**
 * Supabase Client Module
 *
 * Singleton Supabase client with message persistence, semantic search,
 * memory (facts/goals), and logging. Uses edge functions for embeddings
 * when available, falls back to text search.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
// Eine Prüfung für Bot und Edge-Function (Issue #69), deshalb aus supabase/functions
import { acceptedCreatedAt } from "../../supabase/functions/_shared/created-at";
import { supabaseHeaders } from "./supabase-keys";

export { acceptedCreatedAt };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Message {
  id?: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, unknown>;
  /**
   * Nur beim Schreiben (Issue #69): gültiger ISO-Zeitstempel, nicht in der
   * Zukunft (acceptedCreatedAt), sonst setzt die Datenbank ihren Default
   */
  created_at?: string;
}

export interface MemoryItem {
  id?: string;
  type: "fact" | "goal";
  content: string;
  deadline?: string;
  completed?: boolean;
  completed_at?: string;
  created_at?: string;
}

export interface LogEntry {
  id?: string;
  level: "info" | "warn" | "error" | "debug";
  service: string;
  message: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

// ---------------------------------------------------------------------------
// Singleton Client
// ---------------------------------------------------------------------------

let client: SupabaseClient | null = null;

/**
 * Get or create the singleton Supabase client.
 * Returns null if required env vars are missing.
 */
export function getSupabase(): SupabaseClient | null {
  if (client) return client;

  const url = process.env.SUPABASE_URL;
  const key =
    process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!url || !key) return null;

  client = createClient(url, key);
  return client;
}

/** Vergisst den Client, damit Tests mit eigener Umgebung neu beginnen. */
export function resetSupabaseClient(): void {
  client = null;
}

/**
 * Whether Supabase is configured and available.
 */
export function isSupabaseEnabled(): boolean {
  return getSupabase() !== null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Human-readable relative time (e.g. "2 minutes ago", "1 hour ago").
 */
export function getTimeAgo(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  if (diffHour < 24) return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`;
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return date.toLocaleDateString();
}

/**
 * Parse natural-language relative dates into ISO strings.
 * Supports: "today", "tomorrow", "in N days", "in N hours",
 * bare times like "5pm" / "17:00", and ISO date strings.
 */
export function parseRelativeDate(input: string): string | undefined {
  if (!input) return undefined;

  const lower = input.trim().toLowerCase();
  const now = new Date();

  if (lower === "today") {
    now.setHours(23, 59, 59, 0);
    return now.toISOString();
  }

  if (lower === "tomorrow") {
    now.setDate(now.getDate() + 1);
    now.setHours(23, 59, 59, 0);
    return now.toISOString();
  }

  // "in N days"
  const inDays = lower.match(/^in\s+(\d+)\s+days?$/);
  if (inDays) {
    now.setDate(now.getDate() + parseInt(inDays[1], 10));
    now.setHours(23, 59, 59, 0);
    return now.toISOString();
  }

  // "in N hours"
  const inHours = lower.match(/^in\s+(\d+)\s+hours?$/);
  if (inHours) {
    now.setHours(now.getHours() + parseInt(inHours[1], 10));
    return now.toISOString();
  }

  // "in N weeks"
  const inWeeks = lower.match(/^in\s+(\d+)\s+weeks?$/);
  if (inWeeks) {
    now.setDate(now.getDate() + parseInt(inWeeks[1], 10) * 7);
    now.setHours(23, 59, 59, 0);
    return now.toISOString();
  }

  // Bare time: "5pm", "5:30pm", "17:00"
  const timeMatch = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const meridiem = timeMatch[3];

    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;

    now.setHours(hours, minutes, 0, 0);
    // If that time already passed today, use tomorrow
    if (now.getTime() < Date.now()) {
      now.setDate(now.getDate() + 1);
    }
    return now.toISOString();
  }

  // Try ISO date string
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Session key for topic-isolated context (docs/topic-sessions.md F-1):
 *   topic:{chatId}:{topicId} | group:{chatId} | dm:{chatId} | web:{id}
 * Web-Chat-IDs ("web:<Gespraechs-ID>", WebUI) sind schon der Schluessel.
 * Canonical definition — convex.ts re-exports this.
 */
export function sessionKeyFor(chatId: string, topicId?: number | null): string {
  if (chatId.startsWith("web:")) return chatId;
  if (typeof topicId === "number") return `topic:${chatId}:${topicId}`;
  return chatId.startsWith("-") ? `group:${chatId}` : `dm:${chatId}`;
}

/**
 * Save a message. Uses the edge function endpoint for embedding generation
 * when available, falls back to direct insert. Both paths write the native
 * topic_id/session_key columns (derived from metadata.topicId).
 */
export async function saveMessage(message: Message): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  const url = process.env.SUPABASE_URL;
  const topicId =
    typeof message.metadata?.topicId === "number"
      ? message.metadata.topicId
      : null;
  const sessionKey = sessionKeyFor(message.chat_id, topicId);
  const createdAt = acceptedCreatedAt(message.created_at);

  // Nur-Anzeige-Einträge nie über die Edge-Function (kein Embedding)
  if (isDisplayOnly(message.metadata)) return insertMessageDirect(message, sb);

  // Try edge function first (generates embeddings for semantic search)
  try {
    const edgeUrl = `${url}/functions/v1/store-telegram-message`;
    const response = await fetch(edgeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...supabaseHeaders(
          process.env.SUPABASE_SERVICE_ROLE_KEY ||
            process.env.SUPABASE_ANON_KEY ||
            ""
        ),
      },
      body: JSON.stringify({
        chat_id: message.chat_id,
        role: message.role,
        content: message.content,
        metadata: message.metadata || {},
        topic_id: topicId,
        session_key: sessionKey,
        ...(createdAt ? { created_at: createdAt } : {}),
      }),
    });

    if (response.ok) return true;
  } catch {
    // Edge function unavailable, fall through to direct insert
  }

  // Direct insert fallback (no embeddings)
  return insertMessageDirect(message, sb);
}

/**
 * Direkter Insert ohne Edge-Function, also ohne Embedding. Schreibt wie
 * saveMessage topic_id/session_key aus metadata.topicId und ein gültiges
 * created_at (sonst Default der Datenbank). Für Einträge, die nie in die
 * semantische Suche sollen (display_only, Entscheidung 0006).
 */
export async function insertMessageDirect(
  message: Message,
  sb: SupabaseClient | null = getSupabase()
): Promise<boolean> {
  if (!sb) return false;
  const topicId =
    typeof message.metadata?.topicId === "number"
      ? message.metadata.topicId
      : null;
  const createdAt = acceptedCreatedAt(message.created_at);
  try {
    const { error } = await sb.from("messages").insert({
      chat_id: message.chat_id,
      role: message.role,
      content: message.content,
      metadata: message.metadata || {},
      topic_id: topicId,
      session_key: sessionKeyFor(message.chat_id, topicId),
      ...(createdAt ? { created_at: createdAt } : {}),
    });
    return !error;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Nur-Anzeige-Einträge (Entscheidung 0006): Meldungen und Dateien, die über
// src/lib/outbox.ts gesendet und festgehalten werden. Sie stehen in der
// WebUI (getConversationHistory, getTopicActivity), aber in keinem
// Gesprächskontext.
// ---------------------------------------------------------------------------

/**
 * PostgREST-Filter für Kontext-Leser: alles außer metadata.display_only =
 * true. Fehlendes metadata oder display_only (NULL) und false bleiben
 * sichtbar. Steht vor order/limit, damit Meldungen keine echten
 * Gesprächsbeiträge aus dem Limit verdrängen.
 */
export const NOT_DISPLAY_ONLY_FILTER =
  "metadata->>display_only.is.null,metadata->>display_only.neq.true";

/** true nur bei metadata.display_only === true (JSON-Boolean) */
export function isDisplayOnly(metadata: unknown): boolean {
  return (
    !!metadata &&
    typeof metadata === "object" &&
    (metadata as Record<string, unknown>).display_only === true
  );
}

/** Zweite Sicherung nach der Abfrage, z. B. für Edge-Function-Ergebnisse */
export function withoutDisplayOnly<T extends { metadata?: unknown }>(rows: T[]): T[] {
  return rows.filter((row) => !isDisplayOnly(row?.metadata));
}

/**
 * Retrieve the N most recent messages for a chat, ordered chronologically.
 *
 * topicId controls Telegram forum-topic isolation (docs/topic-sessions.md F-2):
 *   number    → only messages from that topic (metadata->>topicId match)
 *   null      → only topic-less messages (DMs / the General topic)
 *   undefined → no filter, full chat pool (legacy behavior for check-ins etc.)
 */
export async function getRecentMessages(
  chatId: string,
  limit: number = 20,
  topicId?: number | null
): Promise<Message[]> {
  const sb = getSupabase();
  if (!sb) return [];

  try {
    let q = sb
      .from("messages")
      .select("*")
      .eq("chat_id", chatId)
      .or(NOT_DISPLAY_ONLY_FILTER);

    if (topicId !== undefined) {
      // Native indexed column (idx_messages_session_key); covers both the
      // topic case and the topic-less (dm:/group:) pool via the key schema.
      q = q.eq("session_key", sessionKeyFor(chatId, topicId));
    }

    const { data, error } = await q
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return withoutDisplayOnly(data as Message[]).reverse();
  } catch {
    return [];
  }
}

/**
 * Build a formatted conversation context string from recent messages.
 * Returns lines like: "[2m ago] User: hello" / "[1m ago] Bot: hi there"
 * topicId semantics as in getRecentMessages().
 */
export async function getConversationContext(
  chatId: string,
  limit: number = 10,
  topicId?: number | null
): Promise<string> {
  const messages = await getRecentMessages(chatId, limit, topicId);
  if (messages.length === 0) return "";

  return messages
    .map((msg) => {
      const time = msg.created_at ? getTimeAgo(new Date(msg.created_at)) : "";
      const speaker = msg.role === "user" ? "User" : "Bot";
      const content = msg.role === "assistant" && msg.content.length > 800
        ? msg.content.substring(0, 800) + "..."
        : msg.content;
      return `[${time}] ${speaker}: ${content}`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Schlanke Lesefunktionen für die WebUI (Issue #17): nur die nötigen
// Spalten, nie das Embedding. Fehler ergeben eine leere Liste und eine
// Log-Zeile ohne den vollständigen Datenbankfehler.
// ---------------------------------------------------------------------------

export interface HistoryRow {
  id: string;
  created_at: string;
  role: string;
  content: string;
  metadata: Record<string, unknown> | null;
}

export interface HistoryOptions {
  limit: number;
  /** ISO-Zeitpunkt: nur Nachrichten davor ("ältere laden") */
  before?: string;
}

export interface TopicActivity {
  sessionKey: string;
  /** created_at der jüngsten Nachricht dieses Session-Schlüssels */
  lastActivity: string;
}

/** Spalten des Verlaufs; bewusst ohne embedding */
export const HISTORY_COLUMNS = "id, created_at, role, content, metadata";
/** Obergrenze der Zeilen, aus denen getTopicActivity die letzte Aktivität liest */
export const TOPIC_ACTIVITY_ROW_LIMIT = 1000;

function readFailed(what: string, error: unknown): void {
  const code =
    error && typeof error === "object" && typeof (error as any).code === "string"
      ? (error as any).code
      : error instanceof Error
        ? error.name
        : "unbekannt";
  console.warn(`[supabase] ${what} fehlgeschlagen (${code})`);
}

/**
 * Verlauf eines Session-Schlüssels, chronologisch. Liefert die jüngsten
 * `limit` Nachrichten vor `before` (bzw. die jüngsten überhaupt).
 * topicId null: Direktchat bzw. General-Thema der Gruppe (dm:/group:).
 * Wirft bei Datenbankfehlern; ohne Supabase leer.
 */
export async function getConversationHistory(
  chatId: string,
  topicId: number | null,
  options: HistoryOptions,
  sb: SupabaseClient | null = getSupabase()
): Promise<HistoryRow[]> {
  if (!sb) return [];
  let q = sb
    .from("messages")
    .select(HISTORY_COLUMNS)
    .eq("chat_id", chatId)
    .eq("session_key", sessionKeyFor(chatId, topicId));
  if (options.before) q = q.lt("created_at", options.before);
  // Lesefehler werfen statt leerer Liste: ein leerer Verlauf hieße für den Abgleich „nichts verpasst“
  let result: { data: unknown; error: unknown };
  try {
    result = await q.order("created_at", { ascending: false }).limit(options.limit);
  } catch (e) {
    throwRead("Verlauf lesen", e);
  }
  if (result.error || !Array.isArray(result.data)) throwRead("Verlauf lesen", result.error);
  return (result.data as unknown as HistoryRow[]).reverse();
}

/**
 * Letzte Nachricht je session_key eines Chats in den letzten `sinceDays`
 * Tagen, jüngste zuerst. Eine Abfrage über die jüngsten Zeilen (höchstens
 * TOPIC_ACTIVITY_ROW_LIMIT) statt einer pro Topic; was dahinter liegt,
 * fehlt im Ergebnis und gilt beim Aufrufer als unbekannt.
 */
export async function getTopicActivity(
  chatId: string,
  sinceDays: number,
  sb: SupabaseClient | null = getSupabase(),
  now: number = Date.now()
): Promise<TopicActivity[]> {
  if (!sb) return [];
  try {
    const since = new Date(now - sinceDays * 86_400_000).toISOString();
    const { data, error } = await sb
      .from("messages")
      .select("session_key, created_at")
      .eq("chat_id", chatId)
      .gte("created_at", since)
      .order("created_at", { ascending: false })
      .limit(TOPIC_ACTIVITY_ROW_LIMIT);
    if (error || !Array.isArray(data)) {
      readFailed("Aktivität lesen", error);
      return [];
    }
    const seen = new Map<string, string>();
    for (const row of data as { session_key: unknown; created_at: unknown }[]) {
      if (typeof row.session_key !== "string" || typeof row.created_at !== "string") continue;
      if (!seen.has(row.session_key)) seen.set(row.session_key, row.created_at);
    }
    return [...seen].map(([sessionKey, lastActivity]) => ({ sessionKey, lastActivity }));
  } catch (e) {
    readFailed("Aktivität lesen", e);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Nur-Anzeige-Einträge für die WebUI (Issue #47): Dateinachweis und
// gesprächsübergreifendes Abholen neuer Meldungen. Anders als die Leser oben
// werfen diese Funktionen bei Fehlern, damit der Aufrufer einen Fehler nicht
// mit „nichts da" verwechselt (sonst liefe der Abfrage-Cursor falsch an).
// ---------------------------------------------------------------------------

/** Zeile einer Meldung, mit Chat-ID für die Zuordnung zum Gespräch */
export interface DisplayOnlyRow extends HistoryRow {
  chat_id: string;
}

export interface DisplayOnlyPageOptions {
  /** Nur Einträge ab diesem Zeitpunkt (einschließlich) */
  since?: string;
  /** Seitenweise weiter nach genau diesem Eintrag (created_at, dann id) */
  after?: { createdAt: string; id: string };
  limit: number;
}

const DISPLAY_ONLY_COLUMNS = "id, created_at, chat_id, role, content, metadata";
/** Zeitpunkte aus der Datenbank bzw. ISO; nie Anführungszeichen oder Kommas im Filter */
const FILTER_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
const ROW_ID_PATTERN = /^\d{1,20}$/;

function throwRead(what: string, error: unknown): never {
  readFailed(what, error);
  throw new Error(`${what} fehlgeschlagen`);
}

/**
 * Meldungen der angegebenen Chats, älteste zuerst (created_at, dann id),
 * höchstens `limit`. Wirft bei Datenbankfehlern und ohne Supabase.
 */
export async function getDisplayOnlyPage(
  chatIds: string[],
  options: DisplayOnlyPageOptions,
  sb: SupabaseClient | null = getSupabase()
): Promise<DisplayOnlyRow[]> {
  if (!sb) throw new Error("Supabase nicht eingerichtet");
  if (chatIds.length === 0) return [];
  let q = sb
    .from("messages")
    .select(DISPLAY_ONLY_COLUMNS)
    .in("chat_id", chatIds)
    .eq("metadata->>display_only", "true");
  if (options.since) {
    if (!FILTER_TIMESTAMP_PATTERN.test(options.since)) throw new Error("ungültiger Zeitpunkt");
    q = q.gte("created_at", options.since);
  }
  if (options.after) {
    const { createdAt, id } = options.after;
    if (!FILTER_TIMESTAMP_PATTERN.test(createdAt) || !ROW_ID_PATTERN.test(id)) throw new Error("ungültiger Cursor");
    q = q.or(`created_at.gt."${createdAt}",and(created_at.eq."${createdAt}",id.gt.${id})`);
  }
  let result: { data: unknown; error: unknown };
  try {
    result = await q.order("created_at", { ascending: true }).order("id", { ascending: true }).limit(options.limit);
  } catch (e) {
    throwRead("Meldungen lesen", e);
  }
  if (result.error || !Array.isArray(result.data)) throwRead("Meldungen lesen", result.error);
  return result.data as DisplayOnlyRow[];
}

/** created_at der jüngsten Meldung der Chats, null ohne Meldung. Wirft bei Fehlern. */
export async function getLatestDisplayOnlyAt(
  chatIds: string[],
  sb: SupabaseClient | null = getSupabase()
): Promise<string | null> {
  if (!sb) throw new Error("Supabase nicht eingerichtet");
  if (chatIds.length === 0) return null;
  let result: { data: unknown; error: unknown };
  try {
    result = await sb
      .from("messages")
      .select("created_at")
      .in("chat_id", chatIds)
      .eq("metadata->>display_only", "true")
      .order("created_at", { ascending: false })
      .limit(1);
  } catch (e) {
    throwRead("Letzte Meldung lesen", e);
  }
  if (result.error || !Array.isArray(result.data)) throwRead("Letzte Meldung lesen", result.error);
  const first = (result.data as { created_at?: unknown }[])[0];
  return typeof first?.created_at === "string" ? first.created_at : null;
}

/**
 * Festgehaltener Eintrag zu einer Datei der Ablage (metadata.file.id), nur
 * Meldungen der angegebenen Chats; null, wenn es keinen gibt. Wirft bei
 * Datenbankfehlern und ohne Supabase.
 */
export async function findDisplayOnlyFile(
  fileId: string,
  chatIds: string[],
  sb: SupabaseClient | null = getSupabase()
): Promise<DisplayOnlyRow | null> {
  if (!sb) throw new Error("Supabase nicht eingerichtet");
  if (chatIds.length === 0) return null;
  let result: { data: unknown; error: unknown };
  try {
    result = await sb
      .from("messages")
      .select(DISPLAY_ONLY_COLUMNS)
      .in("chat_id", chatIds)
      .eq("metadata->>display_only", "true")
      .eq("metadata->file->>id", fileId)
      .order("created_at", { ascending: false })
      .limit(1);
  } catch (e) {
    throwRead("Datei-Eintrag lesen", e);
  }
  if (result.error || !Array.isArray(result.data)) throwRead("Datei-Eintrag lesen", result.error);
  return ((result.data as DisplayOnlyRow[])[0] ?? null);
}

/**
 * Baut den Board-Kontext aus Nachrichten (neueste zuerst). Nur-Anzeige-Einträge
 * fallen heraus; gemeinsam für Supabase und die Convex-Fassade in convex.ts.
 */
export function formatBoardMeetingContext(
  messages: { role: string; content: string; metadata?: unknown }[],
  days: number
): string {
  const rows = withoutDisplayOnly(messages);
  if (rows.length === 0) {
    return "\n\nNo recent conversations across topics.";
  }

  // Group by channel (thread_id from metadata)
  const byChannel: Record<string, typeof rows> = {};
  for (const msg of rows) {
    const threadId = (msg.metadata as any)?.thread_id;
    const channel = threadId ? `topic_${threadId}` : "general";
    if (!byChannel[channel]) byChannel[channel] = [];
    if (byChannel[channel].length < 15) byChannel[channel].push(msg);
  }

  let context = `\n\n## BOARD MEETING CONTEXT (Last ${days} days)\n`;
  context += "Review of conversations across all agents:\n\n";

  for (const [channel, messages] of Object.entries(byChannel)) {
    context += `### ${channel}\n`;
    const exchanges = messages.map((m: any) => {
      const role = m.role === "user" ? "User" : "Agent";
      const preview = m.content.substring(0, 200) + (m.content.length > 200 ? "..." : "");
      return `- ${role}: ${preview}`;
    });
    context += exchanges.join("\n") + "\n\n";
  }

  return context;
}

/**
 * Get recent messages across all channels/topics for board meeting context.
 */
export async function getBoardMeetingContext(days: number = 7): Promise<string> {
  const sb = getSupabase();
  if (!sb) return "\n\nNo conversation data available.";

  try {
    const since = new Date();
    since.setDate(since.getDate() - days);

    const { data, error } = await sb
      .from("messages")
      .select("role, content, metadata, created_at")
      .gte("created_at", since.toISOString())
      .or(NOT_DISPLAY_ONLY_FILTER)
      .order("created_at", { ascending: false })
      .limit(100);

    if (error || !Array.isArray(data)) {
      return "\n\nNo recent conversations across topics.";
    }
    return formatBoardMeetingContext(data, days);
  } catch {
    return "\n\nFailed to load conversation context.";
  }
}

/**
 * Semantic search across messages using the edge function.
 * Falls back to basic text search (ilike) when edge function is unavailable.
 */
export async function searchMessages(
  chatId: string,
  query: string,
  limit: number = 10
): Promise<Message[]> {
  const sb = getSupabase();
  if (!sb) return [];

  const url = process.env.SUPABASE_URL;

  // Try semantic search via edge function
  try {
    const edgeUrl = `${url}/functions/v1/search-memory`;
    const response = await fetch(edgeUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...supabaseHeaders(
          process.env.SUPABASE_SERVICE_ROLE_KEY ||
            process.env.SUPABASE_ANON_KEY ||
            ""
        ),
      },
      body: JSON.stringify({ chat_id: chatId, query, limit }),
    });

    if (response.ok) {
      // match_messages kennt nur Zeilen mit Embedding, Nur-Anzeige-Einträge
      // haben keins. Enthält die Antwort doch welche (Textsuche einer älteren
      // Edge-Function, gefiltert erst nach dem Limit), fehlen womöglich echte
      // Treffer: dann die eigene, vor dem Limit gefilterte Textsuche nutzen.
      const results = await response.json();
      if (Array.isArray(results)) {
        const visible = withoutDisplayOnly(results as Message[]);
        if (visible.length === results.length) return visible;
      }
    }
  } catch {
    // Edge function unavailable, fall through to text search
  }

  // Fallback: basic text search
  try {
    const { data, error } = await sb
      .from("messages")
      .select("*")
      .eq("chat_id", chatId)
      .ilike("content", `%${query}%`)
      .or(NOT_DISPLAY_ONLY_FILTER)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error || !data) return [];
    return withoutDisplayOnly(data as Message[]);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Memory: Facts
// ---------------------------------------------------------------------------

/**
 * Store a fact in the memory table.
 */
export async function addFact(content: string): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  try {
    const { data, error } = await sb
      .from("memory")
      .insert({ type: "fact", content })
      .select("id")
      .single();
    if (error) return false;
    // Embedding fuer Vector-Ranking, fire-and-forget (Spalte memory.embedding)
    if (data?.id) void embedFact(String(data.id), content);
    return true;
  } catch {
    return false;
  }
}

/**
 * Generate an embedding via OpenAI (text-embedding-3-small, 1536 dims).
 * Returns null when no key is set or the call fails — callers degrade to
 * lexical ranking.
 */
export async function generateEmbedding(text: string): Promise<number[] | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const res = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text.substring(0, 8000),
      }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.data[0].embedding as number[];
  } catch {
    return null;
  }
}

/** Generate + store the embedding for one memory row. Never throws. */
async function embedFact(id: string, content: string): Promise<void> {
  try {
    const sb = getSupabase();
    const embedding = await generateEmbedding(content);
    if (!sb || !embedding) return;
    await sb.from("memory").update({ embedding }).eq("id", id);
  } catch {
    // Non-critical — fact is stored, just without vector ranking
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Retrieve all stored facts.
 */
export async function getFacts(): Promise<MemoryItem[]> {
  const sb = getSupabase();
  if (!sb) return [];

  try {
    const { data, error } = await sb
      .from("memory")
      .select("*")
      .eq("type", "fact")
      .order("created_at", { ascending: false });

    if (error || !data) return [];
    return data as MemoryItem[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Memory: Goals
// ---------------------------------------------------------------------------

/**
 * Add a goal, optionally with a deadline (natural language or ISO).
 */
export async function addGoal(
  content: string,
  deadline?: string
): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  const parsedDeadline = deadline ? parseRelativeDate(deadline) : undefined;

  try {
    const { error } = await sb.from("memory").insert({
      type: "goal",
      content,
      deadline: parsedDeadline,
      completed: false,
    });
    return !error;
  } catch {
    return false;
  }
}

/**
 * Mark a goal as completed by partial text match.
 * Returns true if at least one goal was updated.
 */
export async function completeGoal(searchText: string): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  try {
    const { data: goals } = await sb
      .from("memory")
      .select("id, content")
      .eq("type", "goal")
      .eq("completed", false)
      .ilike("content", `%${searchText}%`);

    if (!goals || goals.length === 0) return false;

    const { error } = await sb
      .from("memory")
      .update({ completed: true, completed_at: new Date().toISOString() })
      .eq("id", goals[0].id);

    return !error;
  } catch {
    return false;
  }
}

/**
 * Delete a fact by partial text match.
 * Returns true if at least one fact was deleted.
 */
export async function deleteFact(searchText: string): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  try {
    const { data: facts } = await sb
      .from("memory")
      .select("id, content")
      .eq("type", "fact")
      .ilike("content", `%${searchText}%`);

    if (!facts || facts.length === 0) return false;

    const { error } = await sb
      .from("memory")
      .delete()
      .eq("id", facts[0].id);

    return !error;
  } catch {
    return false;
  }
}

/**
 * Cancel (delete) a goal by partial text match.
 * Unlike completeGoal, this removes the goal entirely rather than marking it done.
 * Returns true if at least one goal was deleted.
 */
export async function cancelGoal(searchText: string): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  try {
    const { data: goals } = await sb
      .from("memory")
      .select("id, content")
      .eq("type", "goal")
      .eq("completed", false)
      .ilike("content", `%${searchText}%`);

    if (!goals || goals.length === 0) return false;

    const { error } = await sb
      .from("memory")
      .delete()
      .eq("id", goals[0].id);

    return !error;
  } catch {
    return false;
  }
}

/**
 * Get all active (incomplete) goals.
 */
export async function getActiveGoals(): Promise<MemoryItem[]> {
  const sb = getSupabase();
  if (!sb) return [];

  try {
    const { data, error } = await sb
      .from("memory")
      .select("*")
      .eq("type", "goal")
      .eq("completed", false)
      .order("created_at", { ascending: true });

    if (error || !data) return [];
    return data as MemoryItem[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Memory Context
// ---------------------------------------------------------------------------

/**
 * Format goals into a readable list.
 */
export function formatGoalsList(goals: MemoryItem[]): string {
  if (goals.length === 0) return "No active goals.";
  return goals
    .map((g, i) => {
      const deadline = g.deadline
        ? ` (due: ${new Date(g.deadline).toLocaleDateString()})`
        : "";
      return `${i + 1}. ${g.content}${deadline}`;
    })
    .join("\n");
}

/**
 * Format facts into a readable list.
 */
export function formatFactsList(facts: MemoryItem[]): string {
  if (facts.length === 0) return "No stored facts.";
  return facts.map((f) => `- ${f.content}`).join("\n");
}

// Char budget for the facts part of the memory section (~1.500 tokens).
// Goals are always included in full — they are few and action-relevant.
const MEMORY_FACTS_CHAR_BUDGET = parseInt(
  process.env.MEMORY_CONTEXT_CHARS || "6000",
  10
);

/**
 * Rank facts by relevance to the user's message (docs/topic-sessions.md F-3).
 * Lexical word-overlap + recency — dependency-free; the memory table has no
 * embedding column on Supabase, so vector ranking is not available here.
 */
function rankFacts(facts: MemoryItem[], userMessage?: string): MemoryItem[] {
  if (!userMessage) return facts;
  const queryWords = new Set(
    userMessage
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );
  if (queryWords.size === 0) return facts;

  const scored = facts.map((fact, index) => {
    const factWords = fact.content
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/);
    let overlap = 0;
    for (const w of factWords) {
      if (w.length > 3 && queryWords.has(w)) overlap++;
    }
    // Newer facts win ties (getFacts returns newest first → lower index)
    const recency = (facts.length - index) / facts.length;
    return { fact, score: overlap * 10 + recency };
  });

  return scored.sort((a, b) => b.score - a.score).map((s) => s.fact);
}

/** PostgREST returns pgvector columns as strings — normalize to number[]. */
function parseEmbedding(raw: unknown): number[] | null {
  if (Array.isArray(raw)) return raw as number[];
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Vector ranking: facts with embeddings sorted by cosine similarity to the
 * query, facts without embeddings appended afterwards (newest first).
 */
function rankFactsByVector(
  facts: MemoryItem[],
  queryEmbedding: number[]
): MemoryItem[] {
  const withVec: { fact: MemoryItem; score: number }[] = [];
  const withoutVec: MemoryItem[] = [];
  for (const fact of facts) {
    const emb = parseEmbedding((fact as any).embedding);
    if (emb && emb.length === queryEmbedding.length) {
      withVec.push({ fact, score: cosineSimilarity(emb, queryEmbedding) });
    } else {
      withoutVec.push(fact);
    }
  }
  withVec.sort((a, b) => b.score - a.score);
  return [...withVec.map((s) => s.fact), ...withoutVec];
}

/**
 * Pure assembly of the memory context string (shared by the Supabase and
 * unified Convex layers). When userMessage is given and the facts exceed the
 * char budget, facts are relevance-ranked and truncated instead of dumped.
 */
export function buildMemoryContextString(
  facts: MemoryItem[],
  goals: MemoryItem[],
  userMessage?: string,
  queryEmbedding?: number[] | null
): string {
  const sections: string[] = [];

  if (facts.length > 0) {
    const totalChars = facts.reduce((n, f) => n + f.content.length + 3, 0);
    let selected = facts;
    let truncatedNote = "";
    if (totalChars > MEMORY_FACTS_CHAR_BUDGET) {
      const ranked = queryEmbedding
        ? rankFactsByVector(facts, queryEmbedding)
        : rankFacts(facts, userMessage);
      selected = [];
      let used = 0;
      for (const fact of ranked) {
        const cost = fact.content.length + 3;
        if (used + cost > MEMORY_FACTS_CHAR_BUDGET && selected.length >= 10) break;
        selected.push(fact);
        used += cost;
      }
      truncatedNote = `\n_(${selected.length} of ${facts.length} facts shown — most relevant to the current message)_`;
    }
    sections.push(`**Known Facts:**\n${formatFactsList(selected)}${truncatedNote}`);
  }

  if (goals.length > 0) {
    sections.push(`**Active Goals:**\n${formatGoalsList(goals)}`);
  }

  return sections.join("\n\n");
}

/**
 * Build a combined memory context string with facts and goals.
 * Over budget + userMessage: facts are vector-ranked (query embedding via
 * OpenAI); lexical overlap remains the fallback when embeddings are missing.
 */
export async function getMemoryContext(userMessage?: string): Promise<string> {
  const [facts, goals] = await Promise.all([getFacts(), getActiveGoals()]);
  const totalChars = facts.reduce((n, f) => n + f.content.length + 3, 0);
  const queryEmbedding =
    userMessage && totalChars > MEMORY_FACTS_CHAR_BUDGET
      ? await generateEmbedding(userMessage)
      : null;
  return buildMemoryContextString(facts, goals, userMessage, queryEmbedding);
}

/**
 * Facts + goals created after a timestamp — the "memory delta" injected into
 * resume prompts so live sessions learn about new memories.
 */
export async function getMemoryUpdatesSince(sinceMs: number): Promise<string> {
  const [facts, goals] = await Promise.all([getFacts(), getActiveGoals()]);
  const isNew = (item: MemoryItem) =>
    !!item.created_at && new Date(item.created_at).getTime() > sinceMs;

  const lines: string[] = [];
  for (const f of facts.filter(isNew)) lines.push(`- [fact] ${f.content}`);
  for (const g of goals.filter(isNew)) {
    const deadline = g.deadline ? ` (due: ${g.deadline})` : "";
    lines.push(`- [goal] ${g.content}${deadline}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Write a log entry to Supabase. Fails silently.
 */
export async function log(
  level: LogEntry["level"],
  service: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const sb = getSupabase();
  if (!sb) return;

  try {
    await sb.from("logs").insert({ level, service, message, metadata });
  } catch {
    // Logging should never throw
  }
}

// ---------------------------------------------------------------------------
// Async Tasks (Human-in-the-Loop — VPS mode)
// ---------------------------------------------------------------------------

export interface AsyncTask {
  id: string;
  created_at: string;
  updated_at: string;
  chat_id: string;
  original_prompt: string;
  status: "pending" | "running" | "needs_input" | "completed" | "failed";
  result?: string;
  session_id?: string;
  current_step?: string;
  pending_question?: string;
  pending_options?: { label: string; value: string }[];
  user_response?: string;
  thread_id?: number;
  processed_by?: string;
  reminder_sent?: boolean;
  metadata?: Record<string, any>;
}

/**
 * Create a new async task (used when Claude starts a long-running operation).
 */
export async function createTask(
  chatId: string,
  originalPrompt: string,
  threadId?: number,
  processedBy?: string
): Promise<AsyncTask | null> {
  const sb = getSupabase();
  if (!sb) return null;

  try {
    const { data, error } = await sb
      .from("async_tasks")
      .insert({
        chat_id: chatId,
        original_prompt: originalPrompt,
        status: "running",
        thread_id: threadId,
        processed_by: processedBy,
      })
      .select()
      .single();

    if (error) {
      console.error("createTask error:", error.message);
      return null;
    }
    return data as AsyncTask;
  } catch (err) {
    console.error("createTask exception:", err);
    return null;
  }
}

/**
 * Update an async task's fields.
 */
export async function updateTask(
  taskId: string,
  updates: Partial<Omit<AsyncTask, "id" | "created_at">>
): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  try {
    const { error } = await sb
      .from("async_tasks")
      .update({ ...updates, updated_at: new Date().toISOString() })
      .eq("id", taskId);

    if (error) {
      console.error("updateTask error:", error.message);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Get a task by its ID.
 */
export async function getTaskById(taskId: string): Promise<AsyncTask | null> {
  const sb = getSupabase();
  if (!sb) return null;

  try {
    const { data, error } = await sb
      .from("async_tasks")
      .select("*")
      .eq("id", taskId)
      .single();

    if (error) return null;
    return data as AsyncTask;
  } catch {
    return null;
  }
}

/**
 * Get tasks waiting for user input in a specific chat.
 */
export async function getPendingTasks(chatId: string): Promise<AsyncTask[]> {
  const sb = getSupabase();
  if (!sb) return [];

  try {
    const { data, error } = await sb
      .from("async_tasks")
      .select("*")
      .eq("chat_id", chatId)
      .eq("status", "needs_input")
      .order("created_at", { ascending: false });

    if (error) return [];
    return (data || []) as AsyncTask[];
  } catch {
    return [];
  }
}

/**
 * Get currently running tasks in a specific chat.
 */
export async function getRunningTasks(chatId: string): Promise<AsyncTask[]> {
  const sb = getSupabase();
  if (!sb) return [];

  try {
    const { data, error } = await sb
      .from("async_tasks")
      .select("*")
      .eq("chat_id", chatId)
      .eq("status", "running")
      .order("created_at", { ascending: false });

    if (error) return [];
    return (data || []) as AsyncTask[];
  } catch {
    return [];
  }
}

/**
 * Get tasks that have been waiting for input longer than the threshold.
 */
export async function getStaleTasks(
  thresholdMs: number = 2 * 60 * 60 * 1000
): Promise<AsyncTask[]> {
  const sb = getSupabase();
  if (!sb) return [];

  const cutoff = new Date(Date.now() - thresholdMs).toISOString();

  try {
    const { data, error } = await sb
      .from("async_tasks")
      .select("*")
      .eq("status", "needs_input")
      .eq("reminder_sent", false)
      .lt("updated_at", cutoff);

    if (error) return [];
    return (data || []) as AsyncTask[];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Node Heartbeat (Hybrid mode — local ↔ VPS health tracking)
// ---------------------------------------------------------------------------

/**
 * Update heartbeat for a node.
 */
export async function upsertHeartbeat(
  nodeId: string,
  metadata?: Record<string, any>
): Promise<boolean> {
  const sb = getSupabase();
  if (!sb) return false;

  try {
    const { error } = await sb
      .from("node_heartbeat")
      .upsert({
        node_id: nodeId,
        last_heartbeat: new Date().toISOString(),
        metadata: metadata || {},
      });

    if (error) {
      console.error("upsertHeartbeat error:", error.message);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if a node is online (heartbeat within maxAgeMs).
 */
export async function getNodeStatus(
  nodeId: string,
  maxAgeMs: number = 90_000
): Promise<{ online: boolean; lastHeartbeat: string | null }> {
  const sb = getSupabase();
  if (!sb) return { online: false, lastHeartbeat: null };

  try {
    const { data, error } = await sb
      .from("node_heartbeat")
      .select("last_heartbeat")
      .eq("node_id", nodeId)
      .single();

    if (error || !data) return { online: false, lastHeartbeat: null };

    const lastBeat = new Date(data.last_heartbeat).getTime();
    const age = Date.now() - lastBeat;

    return {
      online: age < maxAgeMs,
      lastHeartbeat: data.last_heartbeat,
    };
  } catch {
    return { online: false, lastHeartbeat: null };
  }
}

// ---------------------------------------------------------------------------
// Connection Test
// ---------------------------------------------------------------------------

/**
 * Test the Supabase connection. Returns a descriptive status string.
 */
export async function testConnection(): Promise<string> {
  const sb = getSupabase();
  if (!sb) {
    return "Supabase not configured (missing SUPABASE_URL or key env vars).";
  }

  try {
    const { error } = await sb.from("messages").select("id").limit(1);
    if (error) return `Supabase connection error: ${error.message}`;
    return "Supabase connection OK.";
  } catch (err) {
    return `Supabase connection failed: ${err}`;
  }
}
