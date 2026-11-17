// Deploy: supabase functions deploy search-memory --no-verify-jwt (Prüfung in authorizeServer, supabase/config.toml)
/**
 * Suche in den Nachrichten eines Chats, auf Wunsch auch in den Fakten: Der
 * fachliche Teil steht in _shared/memory-search.ts, der Rahmen (Preflight,
 * Schlüssel, Rumpf, Fehler) in _shared/handler.ts.
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.116.0";
import { edgeHandler } from "../_shared/handler.ts";
import { searchMemory, type SearchDb } from "../_shared/memory-search.ts";

const connect = (url: string, key: string) => createClient(url, key) as unknown as SearchDb;

Deno.serve(edgeHandler(searchMemory, { env: (name) => Deno.env.get(name), connect }));
