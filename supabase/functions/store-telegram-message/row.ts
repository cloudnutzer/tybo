import { acceptedCreatedAt } from "../_shared/created-at.ts";

/**
 * Zeile für messages aus dem Request-Body. Ohne Netz und ohne Deno-API,
 * damit Tests sie direkt prüfen können.
 */
export function messageRow(
  body: Record<string, any>,
  embedding: number[] | null,
  now: number = Date.now(),
  /** Womit der Vektor entstand, „anbieter:modell“ (Spalte embedding_model, Issue #168); die Datenbank prüft es */
  embeddingModel?: string,
): Record<string, unknown> {
  const { chat_id, role, content, metadata, topic_id, session_key, created_at } = body;

  // Native topic columns (docs/topic-sessions.md F-2). Derive session_key when the caller
  // doesn't send one, so older bot versions stay consistent too.
  const topicId =
    typeof topic_id === "number"
      ? topic_id
      : typeof metadata?.topicId === "number"
        ? metadata.topicId
        : null;
  const sessionKey =
    typeof session_key === "string" && session_key
      ? session_key
      : topicId !== null
        ? `topic:${chat_id}:${topicId}`
        : String(chat_id).startsWith("-")
          ? `group:${chat_id}`
          : `dm:${chat_id}`;
  // Eingangszeitpunkt (Issue #69); ungültig oder in der Zukunft: Default der Datenbank
  const createdAt = acceptedCreatedAt(created_at, now);

  return {
    chat_id,
    role,
    content,
    metadata: metadata || {},
    topic_id: topicId,
    session_key: sessionKey,
    ...(createdAt ? { created_at: createdAt } : {}),
    ...(embedding ? { embedding, ...(embeddingModel ? { embedding_model: embeddingModel } : {}) } : {}),
  };
}
