// Deploy: supabase functions deploy search-memory --no-verify-jwt (Prüfung in authorizeServer, supabase/config.toml)
import { authorizeServer } from "../_shared/auth.ts";
import { adminKey } from "../_shared/admin-key.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";
import { corsHeaders } from "../_shared/cors.ts";

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
    const { chat_id, query, limit = 10 } = await req.json();

    if (!chat_id || !query) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

    // Try semantic search if OpenAI key is available
    const openaiKey = Deno.env.get("OPENAI_API_KEY");

    if (openaiKey) {
      try {
        const res = await fetch("https://api.openai.com/v1/embeddings", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${openaiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "text-embedding-3-small",
            input: query,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          const embedding = data.data[0].embedding;

          const { data: results } = await supabase.rpc("match_messages", {
            query_embedding: embedding,
            filter_chat_id: chat_id,
            match_threshold: 0.5,
            match_count: limit,
          });

          if (results?.length) {
            return new Response(JSON.stringify(results), {
              headers: { ...corsHeaders, "Content-Type": "application/json" },
            });
          }
        }
      } catch {
        // Semantic search failed — fall through to text search
      }
    }

    // Fallback: basic text search. Nur-Anzeige-Einträge (metadata.display_only,
    // Entscheidung 0006) vor dem Limit ausschließen, sonst verdrängen sie echte Treffer
    const { data } = await supabase
      .from("messages")
      .select("*")
      .eq("chat_id", chat_id)
      .ilike("content", `%${query}%`)
      .or("metadata->>display_only.is.null,metadata->>display_only.neq.true")
      .order("created_at", { ascending: false })
      .limit(limit);

    return new Response(JSON.stringify(data || []), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(
      JSON.stringify({ error: String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
