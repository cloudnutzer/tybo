/**
 * Supabase-Schlüssel beider Arten (Issue #162). Alte Projekte haben JWT-Schlüssel
 * (`anon`, `service_role`), neue `sb_publishable_…` und `sb_secret_…`. Beide
 * stehen in denselben Variablen (`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`).
 *
 * Neue Schlüssel gehören nur in den Kopf `apikey`: als `Authorization: Bearer`
 * lehnt Supabase sie ab, weil sie kein JWT sind. JWT-Schlüssel gehen wie bisher
 * in beide Köpfe.
 */

/** Schlüssel der neuen Art (`sb_publishable_…`, `sb_secret_…`) */
export function isNewSupabaseKey(key: string): boolean {
  return key.startsWith("sb_");
}

/** Öffentlicher Schlüssel der neuen Art; taugt nie zum Schreiben am Rechteschutz vorbei */
export function isPublishableSupabaseKey(key: string): boolean {
  return key.startsWith("sb_publishable_");
}

/** Köpfe für direkte Aufrufe an REST-API und Edge Functions */
export function supabaseHeaders(key: string): Record<string, string> {
  if (isNewSupabaseKey(key)) return { apikey: key };
  return { apikey: key, Authorization: `Bearer ${key}` };
}
