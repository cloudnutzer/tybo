// Deploy: supabase functions deploy embed-knowledge --no-verify-jwt (Prüfung in authorizeServer, supabase/config.toml)
/**
 * Vektor für einen Eintrag der Wissensbasis: rechnet das Embedding beim
 * eingestellten Anbieter (_shared/embedding.ts) und schreibt es in
 * knowledge.embedding. Ohne Schlüssel oder bei gesperrtem Anbieter bleibt der
 * Eintrag, wie er ist, und die Antwort sagt embedded: false mit Grund.
 * Rahmen (Preflight, Schlüssel, Rumpf, Fehler): _shared/handler.ts.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";
import { embeddingKey } from "../_shared/embedding.ts";
import { edgeHandler, jsonResponse, writeWithModelLabel } from "../_shared/handler.ts";

const connect = (url: string, key: string) => createClient(url, key);

Deno.serve(
  edgeHandler(
    {
      required: ["knowledge_id", "text"],
      missingMessage: "Missing knowledge_id or text",
      failure: (error) => ({ ok: false, error }),
      async run({ body, db, embed }) {
        const result = await embed(body.text);
        if (!result.ok) {
          // Kein Zugang bzw. gesperrt ist kein Fehler: der Eintrag gilt, nur ohne Suche nach Bedeutung
          if (result.reason === "kein-zugang" || result.reason === "gesperrt") return jsonResponse({ ok: true, embedded: false, reason: result.message });
          return jsonResponse({ ok: false, error: `Embedding fehlgeschlagen: ${result.message}` }, 502);
        }

        const label = result.config && embeddingKey(result.config);
        const columns = (model?: string) => (model ? { embedding: result.vector, embedding_model: model } : { embedding: result.vector });
        const error = await writeWithModelLabel(label, (model) => db().from("knowledge").update(columns(model)).eq("id", body.knowledge_id));
        if (error) return jsonResponse({ ok: false, error: `Supabase update error: ${error.message}` }, 500);
        return jsonResponse({ ok: true, embedded: true });
      },
    },
    { env: (name) => Deno.env.get(name), connect },
  ),
);
