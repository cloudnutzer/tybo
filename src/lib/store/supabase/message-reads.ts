/**
 * Supabase-Adapter für die lesenden Nachrichten-Methoden aus Issue #310:
 * Suche (Edge Function search-memory, sonst eigene Textsuche), Verlauf und
 * Topic-Aktivität für die WebUI, Meldungs-Seiten, jüngste Meldung und
 * Dateinachweis. Speichern, recent und boardRows stehen in messages.ts.
 *
 * Wer bei einem Fehler leer antwortet und wer wirft, ist Absicht:
 * - Suche: leer. Ohne Treffer arbeitet der Prompt einfach ohne Fundstellen.
 *   Das Nachschlagen muss beides trennen, es nimmt searchChatChecked (wirft).
 * - Topic-Aktivität: leer plus Log-Zeile; fehlende Einträge gelten beim
 *   Aufrufer als „unbekannt“.
 * - Topic-Aktivität ab einem Zeitpunkt (Issue #684): wirft. Der Aufrufer
 *   schreibt damit einen Stand fort, leer hieße dort „nichts Neues“.
 * - Verlauf und die Meldungsleser: werfen. Ein leeres Ergebnis hieße
 *   für den Abgleich der WebUI „nichts verpasst“ bzw. setzte den Cursor falsch.
 * Log-Zeilen nennen nur den Fehlercode, nie den Text des Datenbankfehlers.
 *
 * Tabellen-, Spalten- und Function-Namen sowie die Felder des Bodys sind
 * Schnittstelle und bleiben so.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { shapeHits } from "../../../../supabase/functions/_shared/chunks";
import { containsPattern } from "../../../../supabase/functions/_shared/like-pattern";
import { supabaseHeaders } from "../../supabase-keys";
import { isDisplayOnly, sessionKeyFor, withoutDisplayOnly } from "../message-rules";
import type { MessageStore } from "../ports";
import type {
  DisplayOnlyHead,
  DisplayOnlyPageOptions,
  DisplayOnlyRow,
  FactWish,
  HistoryOptions,
  HistoryRow,
  HitsWithFacts,
  MemoryItem,
  Message,
  TopicActivity,
  TopicActivityChanges,
} from "../types";
import { factFromRow } from "./memory";
import { edgeKey, NOT_DISPLAY_ONLY_FILTER, type ClientSource } from "./messages";

const TABLE = "messages";
const SEARCH_FUNCTION = "search-memory";
/** So viel Suchtext bekommt die Function, gleich lang wie beim Erzeugen der Embeddings */
const SEARCH_TEXT_LIMIT = 8_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Spalten des WebUI-Verlaufs, ohne embedding */
export const HISTORY_COLUMNS = ["id", "created_at", "role", "content", "metadata"].join(", ");
/** Höchstens so viele jüngste Zeilen wertet topicActivity aus; ältere Topics fehlen dann */
export const TOPIC_ACTIVITY_ROW_LIMIT = 1_000;
const ACTIVITY_COLUMNS = "session_key, created_at";
const NOTICE_COLUMNS = ["id", "created_at", "chat_id", "role", "content", "metadata"].join(", ");
/** Kopf einer Meldung, ohne Text und Metadaten (Issue #684) */
export const NOTICE_HEAD_COLUMNS = "id, created_at";
/** Nur Meldungen; PostgREST vergleicht den JSON-Wert als Text */
const NOTICE_FLAG: [string, string] = ["metadata->>display_only", "true"];

/**
 * Zeitpunkt, wie ihn Postgres oder toISOString liefert, bis Mikrosekunden.
 * Er landet in einem or-Filter; Anführungszeichen, Kommas und Klammern
 * kommen so gar nicht erst hinein.
 */
const CURSOR_TIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;
/** Zeilen-ID (bigint) als Ziffernfolge */
const CURSOR_ID = /^\d{1,20}$/;

type QueryResult = { data: unknown; error: unknown };
type ReadOutcome<T> = { ok: true; rows: T[] } | { ok: false; cause: unknown };

/** Führt eine Abfrage aus; Datenbankfehler, fehlende Liste und Ausnahmen landen alle in cause */
async function readRows<T>(run: () => PromiseLike<QueryResult>): Promise<ReadOutcome<T>> {
  try {
    const { data, error } = await run();
    if (!error && Array.isArray(data)) return { ok: true, rows: data as T[] };
    return { ok: false, cause: error };
  } catch (thrown) {
    return { ok: false, cause: thrown };
  }
}

/** Fehlercode für die Log-Zeile: code der Datenbank, sonst der Name der Ausnahme */
function causeCode(cause: unknown): string {
  const code = cause !== null && typeof cause === "object" ? (cause as { code?: unknown }).code : undefined;
  if (typeof code === "string") return code;
  return cause instanceof Error ? cause.name : "unbekannt";
}

function logFailure(task: string, cause: unknown): void {
  console.warn(`[supabase] ${task} fehlgeschlagen (${causeCode(cause)})`);
}

/** Wie readRows, wirft aber bei jedem Fehler, mit einer Meldung ohne Details */
async function rowsOrThrow<T>(task: string, run: () => PromiseLike<QueryResult>): Promise<T[]> {
  const outcome = await readRows<T>(run);
  if (outcome.ok) return outcome.rows;
  logFailure(task, outcome.cause);
  throw new Error(`${task} fehlgeschlagen`);
}

// ---------------------------------------------------------------------------
// Suche
// ---------------------------------------------------------------------------

/** Antwort von search-memory; messages null, wenn die eigene Textsuche ran muss */
interface EdgeAnswer {
  messages: Message[] | null;
  facts: MemoryItem[] | null;
}

/**
 * Fragt search-memory, mit facts auch nach Fakten aus demselben Vektor. Eine
 * ältere Function kennt das Feld nicht und antwortet mit der Liste, dann bleibt
 * facts null. messages ist null: Function nicht erreichbar, kein 2xx, keine
 * Liste, oder eine Meldung unter den Treffern. match_messages kennt nur Zeilen
 * mit Embedding, und Meldungen haben keins; stehen trotzdem welche drin, kam die
 * Antwort aus der Textsuche einer älteren Function, die erst nach dem Limit
 * filtert, und es fehlen womöglich echte Treffer. Der Suchtext geht roh hinaus.
 */
async function edgeAnswer(chatId: string, query: string, limit: number, facts?: FactWish): Promise<EdgeAnswer> {
  const nothing: EdgeAnswer = { messages: null, facts: null };
  let body: unknown;
  try {
    const wish = facts ? { facts: { limit: facts.limit, exclude_ids: facts.excludeIds } } : {};
    const response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/${SEARCH_FUNCTION}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...supabaseHeaders(edgeKey()) },
      body: JSON.stringify({ chat_id: chatId, query: query.slice(0, SEARCH_TEXT_LIMIT), limit, ...wish }),
    });
    if (!response.ok) return nothing;
    body = await response.json();
  } catch {
    return nothing;
  }
  const combined = !Array.isArray(body) && body !== null && typeof body === "object" ? (body as { messages?: unknown; facts?: unknown }) : null;
  const rows = combined ? combined.messages : body;
  const messages = Array.isArray(rows) && !rows.some(row => isDisplayOnly(row?.metadata)) ? (rows as Message[]) : null;
  return { messages, facts: Array.isArray(combined?.facts) ? combined.facts.map(factFromRow) : null };
}

/**
 * Eigene Textsuche: Suchtext wörtlich (Platzhalterzeichen maskiert), ohne
 * Meldungen schon in der Abfrage, damit sie keine echten Treffer aus dem
 * Limit drängen. Neueste zuerst.
 */
function textQuery(client: SupabaseClient, chatId: string, query: string, limit: number) {
  const matching = client.from(TABLE).select("*").eq("chat_id", chatId).ilike("content", containsPattern(query));
  return matching.or(NOT_DISPLAY_ONLY_FILTER).order("created_at", { ascending: false }).limit(limit);
}

/** Textsuche; Fehler ergeben eine leere Liste */
async function textHits(client: SupabaseClient, chatId: string, query: string, limit: number): Promise<Message[]> {
  const outcome = await readRows<Message>(() => textQuery(client, chatId, query, limit));
  return outcome.ok ? withoutDisplayOnly(outcome.rows) : [];
}

/**
 * Suche in einem Chat: erst nach Bedeutung über die Edge Function, sonst nach
 * Text. Die Edge Function durchsucht auch die Abschnitte langer Nachrichten
 * (message_chunks). Treffer langer Nachrichten kommen in beiden Wegen nur als
 * Ausschnitt um die Suchbegriffe (excerpt: true), nie als ganzer Text; das
 * kürzt auch Antworten einer älteren Edge Function ohne Ausschnitte.
 */
export async function searchChat(client: SupabaseClient, chatId: string, query: string, limit: number): Promise<Message[]> {
  return shapeHits((await edgeAnswer(chatId, query, limit)).messages ?? (await textHits(client, chatId, query, limit)), query);
}

/**
 * Wie searchChat fürs Nachschlagen (Issue #523): wirft, wenn die Suche nicht lief,
 * leer heißt dann wirklich „nichts gefunden“. Eine leere Antwort der Function reicht
 * dafür nicht, sie antwortet auch bei einem Datenbankfehler mit einer leeren Liste.
 * Deshalb entscheidet ohne Treffer die eigene Textsuche.
 */
export async function searchChatChecked(client: SupabaseClient, chatId: string, query: string, limit: number): Promise<Message[]> {
  const { messages } = await edgeAnswer(chatId, query, limit);
  if (messages?.length) return shapeHits(messages, query);
  const rows = await rowsOrThrow<Message>("Nachrichten suchen", () => textQuery(client, chatId, query, limit));
  return shapeHits(withoutDisplayOnly(rows), query);
}

/** Wie searchChat, dazu Fakten aus demselben Vektor; der Bot rechnet dafür keinen eigenen */
export async function searchChatWithFacts(client: SupabaseClient, chatId: string, query: string, limit: number, facts: FactWish): Promise<HitsWithFacts> {
  const answer = await edgeAnswer(chatId, query, limit, facts);
  return { messages: shapeHits(answer.messages ?? (await textHits(client, chatId, query, limit)), query), facts: answer.facts };
}

// ---------------------------------------------------------------------------
// Verlauf und Aktivität für die WebUI (Meldungen bleiben drin)
// ---------------------------------------------------------------------------

/**
 * Seite des Verlaufs einer Sitzung: die jüngsten `limit` Nachrichten (vor
 * `before`, falls gesetzt), zurückgegeben älteste zuerst. topicId null
 * heißt Direktchat bzw. General der Gruppe. Wirft bei jedem Fehler.
 */
export async function historyPage(
  client: SupabaseClient,
  chatId: string,
  topicId: number | null,
  { limit, before }: HistoryOptions
): Promise<HistoryRow[]> {
  const newestFirst = await rowsOrThrow<HistoryRow>("Verlauf lesen", () => {
    let query = client.from(TABLE).select(HISTORY_COLUMNS).eq("chat_id", chatId).eq("session_key", sessionKeyFor(chatId, topicId));
    if (before) query = query.lt("created_at", before);
    return query.order("created_at", { ascending: false }).limit(limit);
  });
  return newestFirst.reverse();
}

/**
 * Jüngster Zeitpunkt je session_key eines Chats in den letzten `sinceDays`
 * mal 24 Stunden, jüngste zuerst. Eine einzige Abfrage über die jüngsten
 * TOPIC_ACTIVITY_ROW_LIMIT Zeilen. Fehler: leere Liste und eine Log-Zeile.
 */
export async function activityByTopic(
  client: SupabaseClient,
  chatId: string,
  sinceDays: number,
  now: number = Date.now()
): Promise<TopicActivity[]> {
  const outcome = await readRows<ActivityRow>(() => recentSessionKeys(client, chatId, new Date(now - sinceDays * DAY_MS).toISOString()));
  if (!outcome.ok) {
    logFailure("Aktivität lesen", outcome.cause);
    return [];
  }
  return latestBySession(outcome.rows);
}

type ActivityRow = { session_key: unknown; created_at: unknown };

/** Die jüngsten Zeilen eines Chats ab `since`, nur Sitzung und Zeitpunkt, neueste zuerst */
function recentSessionKeys(client: SupabaseClient, chatId: string, since: string) {
  const recentKeys = client.from(TABLE).select(ACTIVITY_COLUMNS).eq("chat_id", chatId).gte("created_at", since);
  return recentKeys.order("created_at", { ascending: false }).limit(TOPIC_ACTIVITY_ROW_LIMIT);
}

function latestBySession(rows: ActivityRow[]): TopicActivity[] {
  const latest = new Map<string, string>();
  for (const { session_key: key, created_at: at } of rows) {
    // Zeilen kommen neueste zuerst: der erste Zeitpunkt je Schlüssel ist der jüngste
    if (typeof key === "string" && typeof at === "string" && !latest.has(key)) latest.set(key, at);
  }
  return Array.from(latest, ([sessionKey, lastActivity]) => ({ sessionKey, lastActivity }));
}

/**
 * Wie activityByTopic, aber ab einem festen Zeitpunkt (einschließlich) und
 * mit Wurf bei jedem Fehler (Issue #684). Damit schreibt die WebUI ihren
 * Stand fort: Liegt `since` kurz hinter der jüngsten bekannten Nachricht,
 * kommen im Ruhezustand nur ein, zwei Zeilen zurück statt der jüngsten
 * TOPIC_ACTIVITY_ROW_LIMIT. Ein ungültiger Zeitpunkt scheitert vor der Abfrage.
 */
export async function activitySince(client: SupabaseClient, chatId: string, since: string): Promise<TopicActivityChanges> {
  if (!CURSOR_TIME.test(since)) throw new Error("ungültiger Zeitpunkt");
  const rows = await rowsOrThrow<ActivityRow>("Aktivität lesen", () => recentSessionKeys(client, chatId, since));
  return { activity: latestBySession(rows), truncated: rows.length >= TOPIC_ACTIVITY_ROW_LIMIT };
}

// ---------------------------------------------------------------------------
// Meldungen (metadata.display_only) für die WebUI
// ---------------------------------------------------------------------------

/** Abfrage auf Meldungen der genannten Chats */
function noticesOf(client: SupabaseClient, chatIds: string[], columns: string) {
  return client.from(TABLE).select(columns).in("chat_id", chatIds).eq(...NOTICE_FLAG);
}

/** or-Filter „nach diesem Eintrag“: späterer Zeitpunkt, oder gleicher Zeitpunkt und größere ID */
function afterCursor(createdAt: string, id: string): string {
  const at = `"${createdAt}"`;
  return `created_at.gt.${at},and(created_at.eq.${at},id.gt.${id})`;
}

/**
 * Eine Seite Meldungen der Chats, sortiert nach created_at und id
 * aufsteigend. Zeitpunkte gehen als Text in den Filter, so bleiben die
 * Mikrosekunden aus der Datenbank erhalten. Ungültiges since oder after
 * scheitert vor der Abfrage; leere chatIds ergeben ohne Abfrage [].
 */
export async function noticePage(client: SupabaseClient, chatIds: string[], options: DisplayOnlyPageOptions): Promise<DisplayOnlyRow[]> {
  return noticePageOf<DisplayOnlyRow>(client, chatIds, NOTICE_COLUMNS, options);
}

/**
 * Dieselbe Seite wie noticePage (Filter, Reihenfolge, Cursor, Limit), aber
 * nur id und created_at (Issue #684): Der Abholer der WebUI sieht daran, was
 * neu ist, und lädt Text und Metadaten nur dafür (noticeRows).
 */
export async function noticeHeads(client: SupabaseClient, chatIds: string[], options: DisplayOnlyPageOptions): Promise<DisplayOnlyHead[]> {
  return noticePageOf<DisplayOnlyHead>(client, chatIds, NOTICE_HEAD_COLUMNS, options);
}

async function noticePageOf<T>(client: SupabaseClient, chatIds: string[], columns: string, { since, after, limit }: DisplayOnlyPageOptions): Promise<T[]> {
  if (chatIds.length === 0) return [];
  if (since && !CURSOR_TIME.test(since)) throw new Error("ungültiger Zeitpunkt");
  if (after && !(CURSOR_TIME.test(after.createdAt) && CURSOR_ID.test(after.id))) throw new Error("ungültiger Cursor");
  return rowsOrThrow<T>("Meldungen lesen", () => {
    let query = noticesOf(client, chatIds, columns);
    if (since) query = query.gte("created_at", since);
    if (after) query = query.or(afterCursor(after.createdAt, after.id));
    return query.order("created_at", { ascending: true }).order("id", { ascending: true }).limit(limit);
  });
}

/**
 * Volle Meldungen zu Zeilen-IDs aus noticeHeads, nur Meldungen der genannten
 * Chats, sortiert wie die Seiten (Issue #684). Eine inzwischen gelöschte
 * Zeile fehlt einfach. Leere chatIds oder ids ergeben ohne Abfrage [];
 * eine ID, die keine Ziffernfolge ist, scheitert vor der Abfrage.
 */
export async function noticeRows(client: SupabaseClient, chatIds: string[], ids: string[]): Promise<DisplayOnlyRow[]> {
  if (chatIds.length === 0 || ids.length === 0) return [];
  if (!ids.every(id => CURSOR_ID.test(id))) throw new Error("ungültige Zeilen-ID");
  return rowsOrThrow<DisplayOnlyRow>("Meldungen lesen", () =>
    noticesOf(client, chatIds, NOTICE_COLUMNS).in("id", ids).order("created_at", { ascending: true }).order("id", { ascending: true })
  );
}

/** created_at der jüngsten Meldung der Chats als Text der Datenbank, null ohne Meldung */
export async function newestNoticeAt(client: SupabaseClient, chatIds: string[]): Promise<string | null> {
  if (chatIds.length === 0) return null;
  const [newest] = await rowsOrThrow<{ created_at?: unknown }>("Letzte Meldung lesen", () =>
    noticesOf(client, chatIds, "created_at").order("created_at", { ascending: false }).limit(1)
  );
  return typeof newest?.created_at === "string" ? newest.created_at : null;
}

/** Jüngste Meldung der Chats, die die Datei metadata.file.id trägt, sonst null */
export async function noticeWithFile(client: SupabaseClient, fileId: string, chatIds: string[]): Promise<DisplayOnlyRow | null> {
  if (chatIds.length === 0) return null;
  const [match] = await rowsOrThrow<DisplayOnlyRow>("Datei-Eintrag lesen", () =>
    noticesOf(client, chatIds, NOTICE_COLUMNS).eq("metadata->file->>id", fileId).order("created_at", { ascending: false }).limit(1)
  );
  return match ?? null;
}

// ---------------------------------------------------------------------------
// Teil des Stores
// ---------------------------------------------------------------------------

/** Die Methoden von MessageStore, die dieses Modul trägt */
export type SupabaseMessageReads = Pick<
  MessageStore,
  | "search"
  | "searchWithFacts"
  | "history"
  | "topicActivity"
  | "topicActivitySince"
  | "displayOnlyPage"
  | "displayOnlyHeads"
  | "displayOnlyRows"
  | "latestDisplayOnlyAt"
  | "findDisplayOnlyFile"
>;

/**
 * Lesende Nachrichten-Methoden über Supabase. Ohne Client (Supabase nicht
 * eingerichtet) liefern Suche, Verlauf und Aktivität leer, ohne Log; die
 * Meldungsleser werfen, auch bei leeren chatIds, damit der Aufrufer
 * „nicht eingerichtet“ nicht mit „keine Meldung“ verwechselt.
 */
export function supabaseMessageReads(clientSource: ClientSource): SupabaseMessageReads {
  const required = (): SupabaseClient => {
    const client = clientSource();
    if (!client) throw new Error("Supabase nicht eingerichtet");
    return client;
  };
  return {
    async search(chatId, query, limit) {
      const client = clientSource();
      return client ? searchChat(client, chatId, query, limit) : [];
    },
    async searchWithFacts(chatId, query, limit, facts) {
      const client = clientSource();
      return client ? searchChatWithFacts(client, chatId, query, limit, facts) : { messages: [], facts: null };
    },
    async history(chatId, topicId, options) {
      const client = clientSource();
      return client ? historyPage(client, chatId, topicId, options) : [];
    },
    async topicActivity(chatId, sinceDays) {
      const client = clientSource();
      return client ? activityByTopic(client, chatId, sinceDays) : [];
    },
    async topicActivitySince(chatId, since) {
      const client = clientSource();
      return client ? activitySince(client, chatId, since) : { activity: [], truncated: false };
    },
    async displayOnlyPage(chatIds, options) {
      return noticePage(required(), chatIds, options);
    },
    async displayOnlyHeads(chatIds, options) {
      return noticeHeads(required(), chatIds, options);
    },
    async displayOnlyRows(chatIds, ids) {
      return noticeRows(required(), chatIds, ids);
    },
    async latestDisplayOnlyAt(chatIds) {
      return newestNoticeAt(required(), chatIds);
    },
    async findDisplayOnlyFile(fileId, chatIds) {
      return noticeWithFile(required(), fileId, chatIds);
    },
  };
}
