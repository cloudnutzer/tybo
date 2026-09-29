// Deploy: supabase functions deploy embed-knowledge --no-verify-jwt (Prüfung in authorizeServer, supabase/config.toml)
import { authorizeServer } from "../_shared/auth.ts";
import { adminKey } from "../_shared/admin-key.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";
import { corsHeaders } from "../_shared/cors.ts";
import { embedForDatabase, embeddingKey, firstReport, MISSING_COLUMN_CODES, type EnvReader } from "../_shared/embedding.ts";

const denoEnv: EnvReader = (name) => Deno.env.get(name);

/**
 * Edge function: Generate an embedding for a knowledge entry and store it in
 * the knowledge table. Anbieter aus EMBEDDING_PROVIDER (openai, gemini,
 * ollama; Standard openai mit OPENAI_API_KEY), siehe _shared/embedding.ts.
 * Ohne Schlüssel: success with embedded: false (knowledge still saved,
 * just without semantic search capability).
 */
Deno.serve(async (req) => {
  const denied = authorizeServer(req);
  if (denied) return denied;
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  // Neuer Secret-Schlüssel (default) oder alter service_role; ohne beide kein Client
  const serviceKey = adminKey((name) => Deno.env.get(name));
  if (!serviceKey) return new Response("Not configured", { status: 503 });

  try {
    const { knowledge_id, text } = await req.json();

    if (!knowledge_id || !text) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing knowledge_id or text" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // Embedding vom eingestellten Anbieter (EMBEDDING_PROVIDER, Standard OpenAI)
    const embedded = await embedForDatabase(text, denoEnv, fetch, { url: Deno.env.get("SUPABASE_URL") ?? "", key: serviceKey });
    // Passt der Anbieter nicht zur Datenbank: einmal ins Log (fester Satz ohne Werte)
    if (!embedded.ok && embedded.reason === "gesperrt" && firstReport(embedded.message)) console.warn(embedded.message);

    if (!embedded.ok && (embedded.reason === "kein-zugang" || embedded.reason === "gesperrt")) {
      // Kein Schlüssel oder Anbieter passt nicht zur Datenbank: Wissen ist gespeichert, nur ohne Embedding
      return new Response(
        JSON.stringify({ ok: true, embedded: false, reason: embedded.message }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    if (!embedded.ok) {
      // Fester Satz ohne Antworttext des Anbieters (der kann Schlüsselteile enthalten)
      return new Response(
        JSON.stringify({ ok: false, error: `Embedding fehlgeschlagen: ${embedded.message}` }),
        { status: 502, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const embedding = embedded.vector;

    // Store embedding in the knowledge table
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

    // Mit Angabe embedding_model prüft die Datenbank den Vektor beim Schreiben (Issue #168);
    // fehlt ihr die Spalte (Migration 20260928 nicht eingespielt), ohne Angabe wie vorher
    const label = embedded.config ? embeddingKey(embedded.config) : undefined;
    let { error } = await supabase
      .from("knowledge")
      .update(label ? { embedding, embedding_model: label } : { embedding })
      .eq("id", knowledge_id);
    if (error && label && MISSING_COLUMN_CODES.includes(String(error.code))) {
      ({ error } = await supabase.from("knowledge").update({ embedding }).eq("id", knowledge_id));
    }

    if (error) {
      return new Response(
        JSON.stringify({ ok: false, error: `Supabase update error: ${error.message}` }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    return new Response(
      JSON.stringify({ ok: true, embedded: true }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
