// Deploy: supabase functions deploy store-telegram-message --no-verify-jwt (Prüfung in authorizeServer, supabase/config.toml)
import { authorizeServer } from "../_shared/auth.ts";
import { adminKey } from "../_shared/admin-key.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";
import { corsHeaders } from "../_shared/cors.ts";
import { messageRow } from "./row.ts";
import { embedForDatabase, embeddingKey, firstReport, MISSING_COLUMN_CODES, type EnvReader } from "../_shared/embedding.ts";

const denoEnv: EnvReader = (name) => Deno.env.get(name);

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
    const body = await req.json();
    const { chat_id, role, content } = body;

    if (!chat_id || !role || !content) {
      return new Response(
        JSON.stringify({ ok: false, error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

    // Embedding vom eingestellten Anbieter (EMBEDDING_PROVIDER, Standard OpenAI);
    // ohne Schlüssel oder bei Fehler speichert die Function ohne Embedding
    const embedded = await embedForDatabase(content, denoEnv, fetch, { url: Deno.env.get("SUPABASE_URL") ?? "", key: serviceKey });
    // Passt der Anbieter nicht zur Datenbank: einmal ins Log (fester Satz ohne Werte)
    if (!embedded.ok && embedded.reason === "gesperrt" && firstReport(embedded.message)) console.warn(embedded.message);
    const embedding = embedded.ok ? embedded.vector : null;

    // Spalten samt topic_id, session_key und geprüftem created_at: row.ts. Mit
    // Angabe embedding_model prüft die Datenbank den Vektor beim Schreiben (Issue #168);
    // fehlt ihr die Spalte (Migration 20260928 nicht eingespielt), ohne Angabe wie vorher
    const label = embedded.ok && embedded.config ? embeddingKey(embedded.config) : undefined;
    let { error } = await supabase.from("messages").insert(messageRow(body, embedding, Date.now(), label));
    if (error && label && MISSING_COLUMN_CODES.includes(String(error.code))) {
      ({ error } = await supabase.from("messages").insert(messageRow(body, embedding)));
    }

    return new Response(
      // embedding_status: fester Kurzgrund ohne Werte (ok, kein-zugang, nicht-erreichbar, …);
      // embedding_provider/embedding_model: womit der Vektor entstand. Beides für den Nachweis in tybo setup suche
      JSON.stringify({
        ok: !error,
        error: error?.message,
        embedded: !error && embedding !== null,
        embedding_status: embedded.ok ? "ok" : embedded.reason,
        embedding_provider: embedded.ok ? embedded.config?.provider : undefined,
        embedding_model: embedded.ok ? embedded.config?.model : undefined,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ ok: false, error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
