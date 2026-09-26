/**
 * Schlüssel der Edge Functions (Issue #162). Ohne Deno-Abhängigkeit, die
 * Umgebung kommt als Leser herein, damit Bun-Tests sie nachbilden können.
 *
 * Supabase legt in jede Function `SUPABASE_SECRET_KEYS` (JSON nach
 * Schlüsselname, etwa `{"default":"sb_secret_…"}`) und, solange es ihn gibt,
 * den alten `SUPABASE_SERVICE_ROLE_KEY`. Ungültiges JSON und leere oder
 * nicht-stringförmige Werte zählen nie als Schlüssel.
 */
export type EnvReader = (name: string) => string | undefined;

/** Alle gültigen neuen Secret-Schlüssel aus SUPABASE_SECRET_KEYS */
export function secretKeys(env: EnvReader): Record<string, string> {
  const raw = env("SUPABASE_SECRET_KEYS");
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const keys: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (typeof value === "string" && value.trim() !== "") keys[name] = value;
  }
  return keys;
}

/** Alter service_role-Schlüssel, leer zählt als nicht gesetzt */
export function legacyServiceRoleKey(env: EnvReader): string | null {
  const value = env("SUPABASE_SERVICE_ROLE_KEY");
  return value && value.trim() !== "" ? value : null;
}

/**
 * Schlüssel für den Client der Function: `SUPABASE_SECRET_KEYS.default`,
 * sonst der alte service_role-Schlüssel, sonst null (die Function antwortet
 * dann mit 503 statt mit einem Client ohne Rechte).
 */
export function adminKey(env: EnvReader): string | null {
  return secretKeys(env).default ?? legacyServiceRoleKey(env);
}
