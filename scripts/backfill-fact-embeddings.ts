/**
 * One-time backfill (idempotent, safe to re-run):
 * 1. Generate embeddings for memory rows that have none (facts + goals).
 * 2. Patch messages rows that still lack session_key (written between the
 *    SQL migration and the native-column write path going live).
 *
 * Usage: bun run scripts/backfill-fact-embeddings.ts
 */
import { join } from "path";
import { loadEnv } from "../src/lib/env";

await loadEnv(join(process.cwd(), ".env"));

const { getSupabase, generateEmbedding, sessionKeyFor } = await import(
  "../src/lib/supabase"
);

const sb = getSupabase();
if (!sb) {
  console.error("Supabase not configured");
  process.exit(1);
}

// --- 1. Memory embeddings ---
const { data: rows, error } = await sb
  .from("memory")
  .select("id, content, embedding")
  .is("embedding", null);
if (error) {
  console.error("memory query failed:", error.message);
  process.exit(1);
}
let embedded = 0;
for (const row of rows ?? []) {
  const embedding = await generateEmbedding(row.content);
  if (!embedding) continue;
  const { error: upErr } = await sb
    .from("memory")
    .update({ embedding })
    .eq("id", row.id);
  if (!upErr) embedded++;
}
console.log(`memory: ${embedded}/${rows?.length ?? 0} rows embedded`);

// --- 2. messages without session_key ---
const { data: msgs } = await sb
  .from("messages")
  .select("id, chat_id, metadata")
  .is("session_key", null)
  .limit(2000);
let patched = 0;
for (const m of msgs ?? []) {
  const topicId =
    typeof m.metadata?.topicId === "number" ? m.metadata.topicId : null;
  const { error: upErr } = await sb
    .from("messages")
    .update({ topic_id: topicId, session_key: sessionKeyFor(m.chat_id, topicId) })
    .eq("id", m.id);
  if (!upErr) patched++;
}
console.log(`messages: ${patched}/${msgs?.length ?? 0} rows patched with session_key`);
