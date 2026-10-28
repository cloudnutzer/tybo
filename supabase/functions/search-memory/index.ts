// Deploy: supabase functions deploy search-memory --no-verify-jwt (Prüfung in authorizeServer, supabase/config.toml)
/**
 * Suche in den Nachrichten eines Chats. Erst nach Bedeutung (Vektor vom
 * eingestellten Anbieter, Vergleich in der Datenbank nur mit Vektoren
 * desselben Modells), ohne Treffer oder ohne Vektor nach Text. Rahmen
 * (Preflight, Schlüssel, Rumpf, Fehler): _shared/handler.ts.
 *
 * Die Suche nach Bedeutung durchsucht auch die Abschnitte langer Nachrichten
 * (message_chunks, _shared/chunks.ts); jede Nachricht kommt höchstens einmal.
 * Treffer langer Nachrichten gehen in beiden Wegen nur als Ausschnitt um die
 * Suchbegriffe hinaus (excerpt: true), nie als ganzer Text: sie landen im Prompt.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";
import { MISSING_FUNCTION_CODES, type EmbedResult } from "../_shared/embedding.ts";
import { shapeHits } from "../_shared/chunks.ts";
import { edgeHandler, jsonResponse } from "../_shared/handler.ts";
import { containsPattern } from "../_shared/like-pattern.ts";

const connect = (url: string, key: string) => createClient(url, key);
type Db = ReturnType<typeof connect>;

/** Mindestähnlichkeit für einen Treffer nach Bedeutung */
const MATCH_THRESHOLD = 0.5;
/** Nachrichten mit metadata.display_only (Entscheidung 0006) zählen nie als Treffer */
const NOT_DISPLAY_ONLY = "metadata->>display_only.is.null,metadata->>display_only.neq.true";

/** Treffer nach Bedeutung; leer, wenn kein Vektor entsteht oder nichts passt */
async function byMeaning(db: Db, embed: (text: string) => Promise<EmbedResult>, chatId: unknown, query: string, limit: unknown): Promise<unknown[]> {
  // Gekürzt wie beim Speichern: das Modell nimmt nur rund 8000 Token
  const result = await embed(query.substring(0, 8000));
  if (!result.ok || !result.config) return [];
  const search = { query_embedding: result.vector, filter_chat_id: chatId, match_threshold: MATCH_THRESHOLD, match_count: limit };
  // Die geprüften Suchen vergleichen nur Vektoren desselben Modells und während einer Umstellung gar nichts (Issue #168)
  const checkedArgs = { p_provider: result.config.provider, p_model: result.config.model, ...search };
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
async function byText(db: Db, chatId: unknown, query: string, limit: unknown): Promise<unknown[]> {
  const ofChat = db.from("messages").select("*").eq("chat_id", chatId);
  const matching = ofChat.ilike("content", containsPattern(query)).or(NOT_DISPLAY_ONLY);
  const newestFirst = matching.order("created_at", { ascending: false });
  return ((await newestFirst.limit(limit as number)).data as unknown[] | null) ?? [];
}

Deno.serve(
  edgeHandler(
    {
      required: ["chat_id", "query"],
      missingMessage: "Missing required fields",
      failure: (error) => ({ error }),
      async run({ body, db, embed }) {
        const query = String(body.query);
        const limit = body.limit === undefined ? 10 : body.limit;
        const client = db();

        // Scheitert die Suche nach Bedeutung, bleibt die Textsuche
        const hits = await byMeaning(client, embed, body.chat_id, query, limit).catch(() => []);
        if (hits.length) return jsonResponse(shapeHits(hits as object[], query));

        return jsonResponse(shapeHits((await byText(client, body.chat_id, query, limit)) as object[], query));
      },
    },
    { env: (name) => Deno.env.get(name), connect },
  ),
);
