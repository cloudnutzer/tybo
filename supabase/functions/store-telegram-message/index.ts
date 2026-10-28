// Deploy: supabase functions deploy store-telegram-message --no-verify-jwt (Prüfung in authorizeServer, supabase/config.toml)
/**
 * Speichert eine Nachricht in messages, mit Vektor vom eingestellten
 * Anbieter, wenn einer entsteht; sonst ohne. Die Antwort nennt immer den
 * Kurzgrund (embedding_status) und, mit Vektor, Anbieter und Modell: daran
 * erkennt tybo setup suche, ob die Suche nach Bedeutung greift. Ein Fehler
 * beim Einfügen kommt als ok: false mit HTTP 200. Spalten: row.ts; Rahmen
 * (Preflight, Schlüssel, Rumpf, Fehler): _shared/handler.ts.
 *
 * Lange Nachrichten (über 8000 Zeichen) bekommen zusätzlich Abschnitte mit
 * eigenen Embeddings (_shared/chunks.ts), nach der Antwort im Hintergrund.
 * Was dabei scheitert, ändert die Antwort nicht: die Nachricht ist
 * gespeichert, der Nachzug im Bot (src/lib/message-chunks.ts) holt die
 * Abschnitte nach.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";
import { embeddingKey, MISSING_FUNCTION_CODES, type EmbedResult, type EmbeddingConfig } from "../_shared/embedding.ts";
import { chunkWriteState, needsChunks, storeMessageChunks, type StoreChunksOutcome } from "../_shared/chunks.ts";
import { edgeHandler, edgeRuntimeWaitUntil, jsonResponse, writeRowWithModelLabel, type DbResult } from "../_shared/handler.ts";
import { messageRow } from "./row.ts";

const connect = (url: string, key: string) => createClient(url, key);

/**
 * Abschnitte einer langen Nachricht: je Abschnitt ein Embedding mit derselben
 * Einstellung wie die Nachricht, dann alle auf einmal über
 * message_chunks_write (die Datenbank prüft Anbieter und Text).
 */
function storeChunks(
  rpc: (fn: string, args: Record<string, unknown>) => DbResult,
  embed: (text: string) => Promise<EmbedResult>,
  messageId: number,
  content: string,
  config: EmbeddingConfig,
): Promise<StoreChunksOutcome> {
  return storeMessageChunks(messageId, content, config, embed, async (args) => {
    const { data, error } = await rpc("message_chunks_write", args);
    if (error) return MISSING_FUNCTION_CODES.includes(String(error.code)) ? "fehlt" : "fehler";
    return chunkWriteState(data);
  });
}

/** Ausgang der Abschnitte ins Log, feste Sätze ohne Werte */
function logChunks(outcome: StoreChunksOutcome): void {
  if (outcome.state === "ok" || outcome.state === "kurz") return;
  if (outcome.state === "kein-embedding") console.warn(`Abschnitte ohne Embedding: ${outcome.message}`);
  else console.warn(`Abschnitte nicht gespeichert (${outcome.state})`);
}

Deno.serve(
  edgeHandler(
    {
      required: ["chat_id", "role", "content"],
      missingMessage: "Missing required fields",
      failure: (error) => ({ ok: false, error }),
      async run({ body, db, embed, background }) {
        const client = db();
        const content = String(body.content);
        // Gekürzt wie im Bot: Web-Nachrichten haben bis zu 200.000 Zeichen, das Modell nimmt rund 8000 Token
        const result = await embed(content.substring(0, 8000));
        const vector = result.ok ? result.vector : null;
        const config = result.ok ? result.config : undefined;

        // Mit select("id"): die Abschnitte brauchen die ID der gespeicherten Nachricht
        const { data: inserted, error } = await writeRowWithModelLabel<{ id?: unknown }>(config && embeddingKey(config), (model) =>
          client
            .from("messages")
            .insert(model ? messageRow(body, vector, Date.now(), model) : messageRow(body, vector))
            .select("id")
            .single(),
        );

        // Abschnitte nur, wenn die Nachricht selbst ein Embedding bekam (sonst
        // sperrt die Datenbank oder es fehlt der Zugang). Im Hintergrund, damit
        // der Bot nicht auf bis zu 40 Embeddings wartet; ohne die Laufzeit-API
        // vor der Antwort. Fehler nur ins Log, nie in ok oder error
        let chunks: string | undefined;
        const messageId = Number(inserted?.id);
        if (!error && config && Number.isSafeInteger(messageId) && needsChunks(content)) {
          const task = storeChunks((fn, args) => client.rpc(fn, args), embed, messageId, content, config)
            .then((outcome) => {
              logChunks(outcome);
              return outcome.state as string;
            })
            .catch(() => {
              console.warn("Abschnitte nicht gespeichert (unerwarteter Fehler)");
              return "fehler";
            });
          chunks = background(task) ? "laeuft" : await task;
        }

        return jsonResponse({
          ok: !error,
          error: error?.message,
          embedded: !error && vector !== null,
          embedding_status: result.ok ? "ok" : result.reason,
          embedding_provider: config?.provider,
          embedding_model: config?.model,
          // Abschnitte langer Nachrichten: laeuft (im Hintergrund), ok oder fester Kurzgrund
          ...(chunks ? { chunks } : {}),
        });
      },
    },
    { env: (name) => Deno.env.get(name), connect, waitUntil: edgeRuntimeWaitUntil },
  ),
);
