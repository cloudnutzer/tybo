/**
 * Anmeldung des Motors claude (Issue #349, Entscheidung E5): Abo oder eigener
 * API-Schlüssel, eingestellt mit CLAUDE_AUTH in der .env.
 *
 * - CLAUDE_AUTH=subscription: Claude Code läuft über das Abo.
 *   ANTHROPIC_API_KEY kommt in keine Umgebung eines claude-Subprozesses,
 *   auch nicht über TYBO_SUBPROCESS_ENV_ALLOW oder einen MCP-Verweis.
 * - CLAUDE_AUTH=apiKey: Claude Code läuft mit ANTHROPIC_API_KEY (Kosten nach
 *   Verbrauch). Fehlt der Schlüssel, startet kein Prozess; es gibt keinen
 *   stillen Rückfall aufs Abo (claudeAuthProblem).
 * - ohne Angabe: apiKey, wenn ANTHROPIC_API_KEY nicht leer ist, sonst
 *   subscription (das Verhalten vor CLAUDE_AUTH).
 * - ungültiger Wert: wie ohne Angabe, dazu einmal eine Warnung im Log, ohne
 *   den Wert (dort könnte versehentlich ein Schlüssel stehen).
 *
 * Gelesen wird immer aus einer übergebenen Umgebung (Standard process.env);
 * verändert wird sie nie. Motor api, Bildbeschreibung und resilient-client
 * lesen ANTHROPIC_API_KEY weiter selbst.
 */

type Env = Record<string, string | undefined>;

export type ClaudeAuthMode = "subscription" | "apiKey";

export interface ClaudeAuth {
  mode: ClaudeAuthMode;
  /** Woher der Modus kommt: CLAUDE_AUTH oder abgeleitet aus dem Schlüssel */
  source: "setting" | "derived";
  /** Getrimmter Schlüssel, nur im Modus apiKey und nur wenn vorhanden */
  apiKey?: string;
}

export const CLAUDE_AUTH_VAR = "CLAUDE_AUTH";
export const CLAUDE_KEY_VAR = "ANTHROPIC_API_KEY";

export const CLAUDE_API_KEY_MISSING =
  "Claude Code soll mit eigenem API-Schlüssel laufen (CLAUDE_AUTH=apiKey), aber ANTHROPIC_API_KEY fehlt in der .env. Schlüssel eintragen oder CLAUDE_AUTH=subscription setzen";

let warn: (line: string) => void = line => console.warn(line);
let warnedInvalid = false;

/** Nur für Tests: Ziel der Warnung ersetzen und den Einmal-Merker zurücksetzen; null stellt zurück. */
export function setClaudeAuthWarnForTests(fn: ((line: string) => void) | null): void {
  warn = fn ?? (line => console.warn(line));
  warnedInvalid = false;
}

function chosenMode(raw: string): ClaudeAuthMode | null {
  const value = raw.trim().toLowerCase();
  if (value === "subscription") return "subscription";
  if (value === "apikey") return "apiKey";
  return null;
}

/** Gültige Anmeldung des Motors claude aus der Umgebung */
export function resolveClaudeAuth(env: Env = process.env): ClaudeAuth {
  const key = (env[CLAUDE_KEY_VAR] ?? "").trim();
  const raw = env[CLAUDE_AUTH_VAR] ?? "";
  let mode = raw.trim() ? chosenMode(raw) : null;
  const source = mode ? "setting" : "derived";
  if (!mode && raw.trim() && !warnedInvalid) {
    warnedInvalid = true;
    warn(`[claude-auth] ${CLAUDE_AUTH_VAR} hat einen ungültigen Wert (erlaubt: subscription, apiKey); es gilt die Ableitung aus ${CLAUDE_KEY_VAR}`);
  }
  mode ??= key ? "apiKey" : "subscription";
  return mode === "apiKey" && key ? { mode, source, apiKey: key } : { mode, source };
}

/** Grund, warum kein claude-Prozess starten darf (apiKey ohne Schlüssel); sonst null */
export function claudeAuthProblem(env: Env = process.env): string | null {
  const auth = resolveClaudeAuth(env);
  return auth.mode === "apiKey" && !auth.apiKey ? CLAUDE_API_KEY_MISSING : null;
}

/** Läuft Claude Code über das Abo? (Abo-Messung, Abrechnungsanzeige) */
export function claudeUsesSubscription(env: Env = process.env): boolean {
  return resolveClaudeAuth(env).mode === "subscription";
}

/**
 * Setzt die Anmeldung in eine Subprozess-Umgebung: eine Kopie von target,
 * deren ANTHROPIC_API_KEY allein aus der Anmeldung von source kommt.
 */
export function withClaudeAuth(target: Record<string, string>, source: Env = process.env): Record<string, string> {
  const out = { ...target };
  delete out[CLAUDE_KEY_VAR];
  const auth = resolveClaudeAuth(source);
  if (auth.apiKey) out[CLAUDE_KEY_VAR] = auth.apiKey;
  return out;
}

/** Kennung für Zwischenspeicher: Modus und ob ein Schlüssel da ist, nie der Wert */
export function claudeAuthCacheKey(env: Env = process.env): string {
  const auth = resolveClaudeAuth(env);
  return `${auth.mode}:${auth.apiKey ? "key" : "nokey"}`;
}
