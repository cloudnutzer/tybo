/**
 * Der eine supabase-js-Client des Bot-Prozesses. Lesen und Schreiben stehen
 * im Store-Adapter (src/lib/store/supabase/), der sich den Client hier holt;
 * ebenso Erinnerungen (src/lib/schedule/store.ts) und das Gedächtnis
 * (src/lib/memory/service.ts).
 *
 * Angelegt wird der Client beim ersten Aufruf, sobald SUPABASE_URL und
 * SUPABASE_SERVICE_ROLE_KEY gesetzt sind; bis dahin gibt es null und beim
 * nächsten Aufruf einen neuen Versuch. Tests mit eigener Umgebung beginnen
 * mit resetSupabaseClient von vorn (tests/preload-env.ts).
 *
 * Die früheren Einstiege dieser Datei (Nachrichten, Fakten, Ziele,
 * Aufträge, Logs, Heartbeat) sind seit den Store-Issues #309 bis #314 im
 * Adapter; die Weiterleitungen entfielen mit Issue #382.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

let shared: SupabaseClient | undefined;

/** Gemeinsamer Client, null ohne Supabase-Zugang in der Umgebung (env nur für Tests) */
export function getSupabase(env: Record<string, string | undefined> = process.env): SupabaseClient | null {
  if (shared) return shared;
  const { SUPABASE_URL: url, SUPABASE_SERVICE_ROLE_KEY: serviceKey } = env;
  if (url && serviceKey) shared = createClient(url, serviceKey);
  return shared ?? null;
}

/** Vergisst den Client; der nächste getSupabase liest die Umgebung neu */
export function resetSupabaseClient(): void {
  shared = undefined;
}
