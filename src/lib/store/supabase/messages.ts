/**
 * Supabase-Adapter für Nachrichten (Issue #309): speichern über die Edge
 * Function store-telegram-message (erzeugt das Embedding) mit direktem
 * Insert als Rückfall, Meldungen direkt speichern, die letzten Nachrichten
 * einer Sitzung, die Rohzeilen für /board und den Zeitpunkt der jüngsten
 * Nutzernachricht (#364) lesen.
 *
 * Tabellen- und Spaltennamen, der Function-Name und die Felder des Bodys
 * sind Schnittstelle zur Datenbank und zur Edge Function und bleiben so.
 * Suche, Verlauf und Meldungs-Seiten stehen in message-reads.ts (#310).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { acceptedCreatedAt } from "../../../../supabase/functions/_shared/created-at";
import { supabaseHeaders } from "../../supabase-keys";
import { isDisplayOnly, saveAndAnnounce, sessionKeyFor, topicOf, withoutDisplayOnly } from "../message-rules";
import type { MessageStore } from "../ports";
import type { BoardRow, Message } from "../types";
import { noteEdgeResult, reportEdgeFallback } from "./edge-warning";

/**
 * PostgREST-Filter für alle, die Gesprächskontext lesen: alles außer
 * metadata.display_only = true; fehlendes Feld (NULL) und false bleiben.
 * Er steht vor order und limit, damit Meldungen keine echten Beiträge aus
 * dem Limit drängen.
 */
export const NOT_DISPLAY_ONLY_FILTER = "metadata->>display_only.is.null,metadata->>display_only.neq.true";

const TABLE = "messages";
const EDGE_FUNCTION = "store-telegram-message";
const BOARD_COLUMNS = "role, content, metadata, created_at";
/** Mehr Zeilen bekommt /board nicht, über alle Chats zusammen */
const BOARD_ROW_LIMIT = 100;

/** Was der direkte Insert braucht; Tests geben eine Attrappe mit from().insert() */
export type InsertClient = Pick<SupabaseClient, "from">;

/** Liefert den Client oder null, wenn Supabase nicht eingerichtet ist */
export type ClientSource = () => SupabaseClient | null;

/**
 * Zeile, wie sie in messages landet und wie die Edge Function sie als Body
 * bekommt: topic_id und session_key aus metadata.topicId, created_at nur,
 * wenn der Aufrufer einen gültigen, nicht zukünftigen Zeitpunkt mitgibt
 * (Issue #69, sonst Default der Datenbank). Kein Embedding.
 */
export function rowFor(message: Message): Record<string, unknown> {
  const { chat_id, role, content } = message;
  const topic = topicOf(message.metadata);
  const row: Record<string, unknown> = {
    chat_id,
    role,
    content,
    metadata: message.metadata ?? {},
    topic_id: topic,
    session_key: sessionKeyFor(chat_id, topic),
  };
  const createdAt = acceptedCreatedAt(message.created_at);
  if (createdAt) row.created_at = createdAt;
  return row;
}

/**
 * Direkter Insert ohne Edge Function, also ohne Embedding. Für Meldungen
 * (nie in der semantischen Suche) und als Rückfall. true nur ohne Fehler;
 * ein Fehler oder eine Ausnahme des Clients ergibt false.
 */
export async function insertRow(message: Message, client: InsertClient): Promise<boolean> {
  const result = await attempt(() => client.from(TABLE).insert(rowFor(message)));
  return result !== null && !result.error;
}

/** Führt eine Abfrage aus; wirft der Client (auch sofort beim Aufbau), kommt null */
function attempt<T>(run: () => PromiseLike<T>): Promise<T | null> {
  return Promise.resolve()
    .then(run)
    .catch(() => null);
}

/** Schlüssel für den Aufruf einer Edge Function: Service-Role, sonst Anon */
export function edgeKey(): string {
  return process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY || "";
}

/**
 * Ruft die Edge Function auf. true heißt: sie hat die Nachricht gespeichert
 * (mit oder ohne Vektor, siehe noteEdgeResult). false heißt: sie hat es
 * nicht getan, der Grund ist schon gemeldet, der Aufrufer schreibt direkt.
 */
async function storeViaEdge(row: Record<string, unknown>): Promise<boolean> {
  let response: Response;
  try {
    response = await fetch(`${process.env.SUPABASE_URL}/functions/v1/${EDGE_FUNCTION}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...supabaseHeaders(edgeKey()) },
      body: JSON.stringify(row),
    });
  } catch (err) {
    reportEdgeFallback(null, err);
    return false;
  }
  if (!response.ok) {
    reportEdgeFallback(response.status);
    return false;
  }
  const body: unknown = await response.json().catch(() => null);
  // ok: false meldet einen gescheiterten Insert in der Function: Nachricht fehlt
  if (body !== null && typeof body === "object" && (body as { ok?: unknown }).ok === false) {
    reportEdgeFallback(response.status, "Insert gescheitert");
    return false;
  }
  noteEdgeResult(body);
  return true;
}

/**
 * Speichert eine Nachricht ohne msgId-Vergabe und ohne Ereignis (das macht
 * saveAndAnnounce): Meldungen direkt, alles andere erst über die Edge
 * Function, bei jedem Problem dort direkt ohne Embedding.
 */
export async function writeMessage(message: Message, client: InsertClient): Promise<boolean> {
  if (isDisplayOnly(message.metadata)) return insertRow(message, client);
  const stored = await storeViaEdge(rowFor(message));
  return stored || insertRow(message, client);
}

/**
 * Die letzten `limit` Nachrichten eines Chats ohne Meldungen, älteste
 * zuerst. topicId: Zahl nur dieses Topic, null nur ohne Topic (Direktchat
 * bzw. General), undefined der ganze Chat. Fehler ergeben eine leere Liste.
 */
export async function recentRows(
  client: SupabaseClient,
  chatId: string,
  limit: number,
  topicId?: number | null
): Promise<Message[]> {
  const result = await attempt(() => {
    let query = client.from(TABLE).select("*").eq("chat_id", chatId).or(NOT_DISPLAY_ONLY_FILTER);
    // session_key ist indiziert und deckt Topic wie topic-losen Pool ab
    if (topicId !== undefined) query = query.eq("session_key", sessionKeyFor(chatId, topicId));
    return query.order("created_at", { ascending: false }).limit(limit);
  });
  const rows = result && !result.error ? (result.data as Message[] | null) : null;
  return rows ? withoutDisplayOnly(rows).reverse() : [];
}

/** Zeitpunkt `days` Kalendertage vor `now` (Ortszeit, gleiche Uhrzeit) */
function daysBefore(now: Date, days: number): Date {
  const since = new Date(now.getTime());
  since.setDate(now.getDate() - days);
  return since;
}

/**
 * Rohzeilen der letzten `days` Tage über alle Chats für /board, neueste
 * zuerst, ohne Meldungen. Ein Fehler der Datenbank ergibt eine leere Liste,
 * eine Ausnahme des Clients geht an den Aufrufer.
 */
export async function boardRowsSince(client: SupabaseClient, days: number, now: Date = new Date()): Promise<BoardRow[]> {
  const { data, error } = await client
    .from(TABLE)
    .select(BOARD_COLUMNS)
    .gte("created_at", daysBefore(now, days).toISOString())
    .or(NOT_DISPLAY_ONLY_FILTER)
    .order("created_at", { ascending: false }).limit(BOARD_ROW_LIMIT);
  if (error || !Array.isArray(data)) return [];
  return withoutDisplayOnly(data as BoardRow[]);
}

/**
 * Wie boardRowsSince, aber jeder Fehler wirft (Datenbank, Ausnahme des
 * Clients, Antwort ohne Liste): für den Check-in (#364), der einen
 * gescheiterten Abruf nie für „keine Beiträge" halten darf.
 */
export async function strictBoardRowsSince(client: SupabaseClient, days: number, now: Date = new Date()): Promise<BoardRow[]> {
  let result: { data: unknown; error: unknown };
  try {
    result = await client
      .from(TABLE)
      .select(BOARD_COLUMNS)
      .gte("created_at", daysBefore(now, days).toISOString())
      .or(NOT_DISPLAY_ONLY_FILTER)
      .order("created_at", { ascending: false }).limit(BOARD_ROW_LIMIT);
  } catch {
    throw new Error("Beiträge lesen fehlgeschlagen");
  }
  if (result.error || !Array.isArray(result.data)) throw new Error("Beiträge lesen fehlgeschlagen");
  return withoutDisplayOnly(result.data as BoardRow[]);
}

/**
 * created_at der jüngsten Nutzernachricht über alle Chats (Telegram und
 * Browser liegen in derselben Tabelle), ohne Meldungen, als Text der
 * Datenbank; null, wenn es keine gibt. Anders als boardRowsSince wirft jeder
 * Fehler (Datenbank, Ausnahme des Clients, Zeile ohne Zeit-Text): der
 * Check-in (#364) darf einen Abruffehler nie für „noch nie geschrieben" halten.
 */
export async function newestUserMessageAt(client: SupabaseClient): Promise<string | null> {
  let result: { data: unknown; error: unknown };
  try {
    result = await client
      .from(TABLE)
      .select("created_at")
      .eq("role", "user")
      .or(NOT_DISPLAY_ONLY_FILTER)
      .order("created_at", { ascending: false })
      .limit(1);
  } catch {
    throw new Error("Letzte Nutzernachricht lesen fehlgeschlagen");
  }
  if (result.error || !Array.isArray(result.data)) throw new Error("Letzte Nutzernachricht lesen fehlgeschlagen");
  if (result.data.length === 0) return null;
  const at = (result.data[0] as { created_at?: unknown } | null)?.created_at;
  if (typeof at !== "string") throw new Error("Letzte Nutzernachricht ohne Zeitpunkt");
  return at;
}

/** Die Teile von MessageStore, die dieser Adapter schon trägt */
export type SupabaseMessageParts = Pick<MessageStore, "save" | "saveDisplayOnly" | "recent" | "boardRows" | "lastUserMessageAt">;

/**
 * Nachrichten-Teil des Stores über Supabase. Ohne Client (Supabase nicht
 * eingerichtet) speichert nichts (false, kein Ereignis) und liest leer.
 */
export function supabaseMessages(clientSource: ClientSource): SupabaseMessageParts {
  const withClient = (write: (message: Message, client: InsertClient) => Promise<boolean>) => {
    return async (message: Message): Promise<boolean> => {
      const client = clientSource();
      return client ? write(message, client) : false;
    };
  };
  const save = withClient(writeMessage);
  const saveDisplayOnly = withClient(insertRow);
  return {
    save: message => saveAndAnnounce(message, save),
    saveDisplayOnly: message => saveAndAnnounce(message, saveDisplayOnly),
    async recent(chatId, limit, topicId) {
      const client = clientSource();
      return client ? recentRows(client, chatId, limit, topicId) : [];
    },
    async boardRows(days, options) {
      const client = clientSource();
      if (options?.strict) {
        if (!client) throw new Error("Supabase nicht eingerichtet");
        return strictBoardRowsSince(client, days);
      }
      return client ? boardRowsSince(client, days) : [];
    },
    async lastUserMessageAt() {
      const client = clientSource();
      if (!client) throw new Error("Supabase nicht eingerichtet");
      return newestUserMessageAt(client);
    },
  };
}
