import { legacyServiceRoleKey, secretKeys, type EnvReader } from "./admin-key.ts";

/** Zeitkonstanter Vergleich, die Laufzeit hängt nur von der Länge ab */
function sameSecret(actual: string, expected: string): boolean {
  let difference = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) difference |= (actual.charCodeAt(i) || 0) ^ expected.charCodeAt(i);
  return difference === 0;
}

const denoEnv: EnvReader = (name) => Deno.env.get(name);

/**
 * Only this deployment's server may use service-role-backed functions.
 * Erlaubt (Issue #162): `apikey` gleich einem Wert aus SUPABASE_SECRET_KEYS
 * oder `Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>`. Die Functions
 * laufen mit verify_jwt = false (supabase/config.toml), die Prüfung liegt hier.
 */
export function authorizeServer(req: Request, env: EnvReader = denoEnv): Response | null {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const secrets = Object.values(secretKeys(env));
  const legacy = legacyServiceRoleKey(env);
  if (secrets.length === 0 && !legacy) return new Response("Not configured", { status: 503 });

  const apikey = req.headers.get("apikey") || "";
  // Alle Werte vergleichen, kein früher Abbruch beim ersten Treffer
  let allowed = false;
  for (const secret of secrets) if (sameSecret(apikey, secret)) allowed = true;
  if (legacy && sameSecret(req.headers.get("authorization") || "", `Bearer ${legacy}`)) allowed = true;
  return allowed ? null : new Response("Unauthorized", { status: 401 });
}
