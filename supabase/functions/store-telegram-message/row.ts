import { acceptedCreatedAt } from "../_shared/created-at.ts";

/**
 * Spalten für messages aus dem Rumpf von store-telegram-message. Ohne Netz
 * und ohne Deno-API, damit Tests die Zeile direkt prüfen können.
 *
 * - topic_id: Zahl aus topic_id, sonst aus metadata.topicId, sonst null
 *   (eigene Spalten seit docs/topic-sessions.md F-2).
 * - session_key: mitgegeben, sonst abgeleitet (topic:<chat>:<topic>,
 *   group:<chat> für negative Chat-IDs, dm:<chat>), damit auch ältere
 *   Aufrufer ohne eigenen Schlüssel dieselben Sitzungen ergeben.
 * - created_at: nur ein gültiger Zeitpunkt aus der Vergangenheit (Issue #69),
 *   sonst weggelassen; dann setzt die Datenbank ihren Default.
 * - embedding und embedding_model („anbieter:modell“, Issue #168) nur mit
 *   Vektor; die Datenbank prüft die Angabe beim Schreiben.
 */
export function messageRow(
  body: Record<string, any>,
  embedding: number[] | null,
  now: number = Date.now(),
  embeddingModel?: string,
): Record<string, unknown> {
  const topicId = topicOf(body);
  const row: Record<string, unknown> = {
    chat_id: body.chat_id,
    role: body.role,
    content: body.content,
    metadata: body.metadata || {},
    topic_id: topicId,
    session_key: sessionKeyOf(body, topicId),
  };

  const createdAt = acceptedCreatedAt(body.created_at, now);
  if (createdAt) row.created_at = createdAt;
  if (embedding) {
    row.embedding = embedding;
    if (embeddingModel) row.embedding_model = embeddingModel;
  }
  return row;
}

function topicOf(body: Record<string, any>): number | null {
  if (typeof body.topic_id === "number") return body.topic_id;
  const fromMetadata = body.metadata?.topicId;
  return typeof fromMetadata === "number" ? fromMetadata : null;
}

function sessionKeyOf(body: Record<string, any>, topicId: number | null): string {
  if (typeof body.session_key === "string" && body.session_key !== "") return body.session_key;
  const chat = body.chat_id;
  if (topicId !== null) return `topic:${chat}:${topicId}`;
  return String(chat).startsWith("-") ? `group:${chat}` : `dm:${chat}`;
}
