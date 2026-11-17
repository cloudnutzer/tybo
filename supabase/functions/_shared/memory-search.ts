/**
 * Fachlicher Teil von search-memory: Suche in den Nachrichten eines Chats. Erst
 * nach Bedeutung (Vektor vom eingestellten Anbieter, Vergleich in der Datenbank
 * nur mit Vektoren desselben Modells), ohne Treffer oder ohne Vektor nach Text.
 *
 * Die Suche nach Bedeutung durchsucht auch die Abschnitte langer Nachrichten
 * (message_chunks, chunks.ts); jede Nachricht kommt höchstens einmal. Treffer
 * langer Nachrichten gehen in beiden Wegen nur als Ausschnitt um die Suchbegriffe
 * hinaus (excerpt: true), nie als ganzer Text: sie landen im Prompt.
 *
 * Mit dem Feld facts (Issue #523) sucht derselbe Vektor auch in den Fakten, ohne
 * zweiten Aufruf beim Anbieter; die Antwort ist dann { messages, facts } statt
 * der Liste. facts null heißt: nach Bedeutung war keine Suche möglich (kein
 * Vektor, Migration fehlt, Datenbankfehler), der Bot sucht dann selbst nach Text.
 *
 * Ohne Deno-API und ohne esm.sh, damit Bun-Tests den Weg gegen echtes PostgreSQL
 * prüfen können (wie handler.ts).
 */
import { shapeHits } from "./chunks.ts";
import { FACT_MATCH_THRESHOLD, MISSING_FUNCTION_CODES, type EmbedResult } from "./embedding.ts";
import { jsonResponse, type DbResult, type EdgeFunction } from "./handler.ts";
import { containsPattern } from "./like-pattern.ts";

/** Was die Suche vom Client braucht; createClient aus supabase-js passt */
export interface SearchDb {
  rpc(name: string, args: Record<string, unknown>): DbResult;
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
}

/** Mindestähnlichkeit für einen Treffer nach Bedeutung */
const MATCH_THRESHOLD = 0.5;
/** So viele Fakten höchstens, gleich was der Aufrufer verlangt */
const MAX_FACTS = 20;
/** Nachrichten mit metadata.display_only (Entscheidung 0006) zählen nie als Treffer */
const NOT_DISPLAY_ONLY = "metadata->>display_only.is.null,metadata->>display_only.neq.true";

/** Treffer nach Bedeutung; leer, wenn kein Vektor da ist oder nichts passt */
async function byMeaning(db: SearchDb, embedded: EmbedResult | null, chatId: unknown, limit: unknown): Promise<unknown[]> {
  if (!embedded?.ok || !embedded.config) return [];
  const search = { query_embedding: embedded.vector, filter_chat_id: chatId, match_threshold: MATCH_THRESHOLD, match_count: limit };
  // Die geprüften Suchen vergleichen nur Vektoren desselben Modells und während einer Umstellung gar nichts (Issue #168)
  const checkedArgs = { p_provider: embedded.config.provider, p_model: embedded.config.model, ...search };
  // Nachrichten und Abschnitte, jede Nachricht einmal mit der besten Ähnlichkeit
  let checked = await db.rpc("match_messages_chunked_checked", checkedArgs);
  if (checked.error && MISSING_FUNCTION_CODES.includes(String(checked.error.code))) {
    // Datenbank ohne Migration 20261015: nur die Nachrichten selbst
    checked = await db.rpc("match_messages_checked", checkedArgs);
  }
  if (checked.error && MISSING_FUNCTION_CODES.includes(String(checked.error.code))) {
    // Datenbank ohne Migration 20260928: die alte Suche, dort gibt es keine Umstellung
    return ((await db.rpc("match_messages", search)).data as unknown[] | null) ?? [];
  }
  return (checked.data as unknown[] | null) ?? [];
}

/** Textsuche: Suchtext wörtlich, Nur-Anzeige-Einträge vor dem Limit heraus, neueste zuerst */
async function byText(db: SearchDb, chatId: unknown, query: string, limit: unknown): Promise<unknown[]> {
  const ofChat = db.from("messages").select("*").eq("chat_id", chatId);
  const matching = ofChat.ilike("content", containsPattern(query)).or(NOT_DISPLAY_ONLY);
  const newestFirst = matching.order("created_at", { ascending: false });
  return ((await newestFirst.limit(limit as number)).data as unknown[] | null) ?? [];
}

interface FactWish {
  limit: number;
  excludeIds: string[];
}

/** Feld facts aus dem Rumpf; null, wenn der Aufrufer keine Fakten will */
function factWish(raw: unknown): FactWish | null {
  if (!raw || typeof raw !== "object") return null;
  const { limit, exclude_ids: exclude } = raw as { limit?: unknown; exclude_ids?: unknown };
  return {
    limit: Math.min(Math.max(Math.trunc(Number(limit)) || 5, 1), MAX_FACTS),
    excludeIds: Array.isArray(exclude) ? exclude.map(String) : [],
  };
}

/** Fakten zum schon berechneten Vektor; null, wenn nach Bedeutung keine Suche möglich war */
async function factsByMeaning(db: SearchDb, embedded: EmbedResult | null, wish: FactWish): Promise<unknown[] | null> {
  if (!embedded?.ok || !embedded.config) return null;
  const { data, error } = await db.rpc("match_facts_checked", {
    p_provider: embedded.config.provider,
    p_model: embedded.config.model,
    query_embedding: embedded.vector,
    match_threshold: FACT_MATCH_THRESHOLD,
    match_count: wish.limit,
    p_exclude_ids: wish.excludeIds,
  });
  return error ? null : ((data as unknown[] | null) ?? []);
}

export const searchMemory: EdgeFunction<SearchDb> = {
  required: ["chat_id", "query"],
  missingMessage: "Missing required fields",
  failure: (error) => ({ error }),
  async run({ body, db, embed }) {
    const query = String(body.query);
    const limit = body.limit === undefined ? 10 : body.limit;
    const client = db();
    const wish = factWish(body.facts);

    // Gekürzt wie beim Speichern: das Modell nimmt nur rund 8000 Token. Einmal je Anfrage, für Nachrichten und Fakten
    const embedded = await embed(query.substring(0, 8000)).catch(() => null);

    // Scheitert die Suche nach Bedeutung, bleibt die Textsuche
    const hits = await byMeaning(client, embedded, body.chat_id, limit).catch(() => []);
    const rows = hits.length ? hits : await byText(client, body.chat_id, query, limit);
    const messages = shapeHits(rows as object[], query);
    if (!wish) return jsonResponse(messages);
    return jsonResponse({ messages, facts: await factsByMeaning(client, embedded, wish).catch(() => null) });
  },
};
