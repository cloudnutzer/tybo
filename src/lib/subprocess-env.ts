/**
 * Umgebung für Claude-Subprozesse (Issue #54, Entscheidung 0008 Punkt 3).
 *
 * Subprozesse erben nicht mehr alle Geheimnisse des Bots: Variablen, deren
 * Name nach Geheimnis aussieht, werden entfernt. Ausnahmen: ANTHROPIC_API_KEY
 * (CLI im API-Modus), die Freigabeliste TYBO_SUBPROCESS_ENV_ALLOW und
 * Variablen, die eine MCP-Konfiguration als ${VAR} oder $VAR referenziert
 * (die Claude-CLI startet diese Server mit ihrer eigenen Umgebung).
 * Netzzugang, Bash und Werkzeuge bleiben unverändert; die .env bleibt lesbar.
 */

import { readFileSync, statSync } from "fs";
import { join, resolve } from "path";

type Env = Record<string, string | undefined>;

/** Namen, die nach Geheimnis aussehen (Groß-/Kleinschreibung egal) */
const SECRET_PATTERNS: RegExp[] = [
  /_TOKEN$/i,
  /_KEY$/i,
  /_SECRET$/i,
  /PASSWORD/i,
  /_PASS$/i,
  /^SUPABASE_/i,
  /^TELEGRAM_/i,
];

/**
 * Anmeldung der Claude-CLI im API-Modus: bleibt, wenn gesetzt und nicht leer.
 * Andere Anmelde-Tokens (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_AUTH_TOKEN) nur
 * per Freigabeliste oder MCP-Referenz.
 */
const CLI_AUTH = new Set(["ANTHROPIC_API_KEY"]);

/**
 * Gespräch eines Aufrufs. Vererbte Werte werden immer entfernt, bevor das
 * Gespräch des Aufrufs gesetzt wird.
 */
export const CONVERSATION_VARS: readonly string[] = ["TYBO_CHAT_ID", "TYBO_TOPIC_ID"];

/**
 * Markiert jeden Subprozess von tybo: Hooks in .claude/settings.local.json
 * prüfen darauf (Stop-Hook-Gate, 9.9.2026).
 */
export const SUBPROCESS_MARKER: Readonly<Record<string, string>> = { TYBO_SUBPROCESS: "1" };

/** Immer entfernt, auch bei Freigabe oder MCP-Referenz */
const ALWAYS_REMOVED = new Set(["CLAUDECODE", ...CONVERSATION_VARS, "WEB_PASSWORD"]);

export function isSecretName(name: string): boolean {
  return SECRET_PATTERNS.some(p => p.test(name));
}

/** Kommagetrennte Freigabeliste aus TYBO_SUBPROCESS_ENV_ALLOW */
export function allowList(env: Env): Set<string> {
  return new Set(
    (env.TYBO_SUBPROCESS_ENV_ALLOW ?? "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean),
  );
}

/**
 * Gespräch des laufenden Aufrufs für Subprozesse (Issue #46), abgeleitet aus
 * dem Schlüssel der Ausführung (sessionKeyFor): dm:<id> und group:<id>
 * setzen TYBO_CHAT_ID, topic:<chat>:<n> zusätzlich TYBO_TOPIC_ID. web:,
 * background, kein Kontext oder ein unbekanntes Format setzen nichts. `bun run notify` im
 * Subprozess legt Dateien so im richtigen Gespräch ab.
 */
export function conversationEnv(key: string | undefined): Record<string, string> {
  if (!key) return {};
  const dm = /^dm:(\d{1,20})$/.exec(key);
  if (dm) return { TYBO_CHAT_ID: dm[1] };
  const group = /^group:(-\d{1,20})$/.exec(key);
  if (group) return { TYBO_CHAT_ID: group[1] };
  const topic = /^topic:(-?\d{1,20}):([1-9]\d{0,9})$/.exec(key);
  if (topic) return { TYBO_CHAT_ID: topic[1], TYBO_TOPIC_ID: topic[2] };
  return {};
}

// ---------------------------------------------------------------------------
// MCP-Referenzen
// ---------------------------------------------------------------------------

const REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;

/** Alle ${VAR}/$VAR in Zeichenketten eines MCP-Server-Eintrags (Befehl, Argumente, env, Header, URL) */
function collectRefs(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(REF)) out.add(m[1] ?? m[2]);
  } else if (Array.isArray(value)) {
    for (const v of value) collectRefs(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectRefs(v, out);
  }
}

function refsFromServers(servers: unknown, out: Set<string>): void {
  if (servers && typeof servers === "object" && !Array.isArray(servers)) collectRefs(servers, out);
}

/** JSON-Datei nach Pfad, zwischengespeichert nach Änderungszeit und Größe; fehlend oder defekt: null */
const jsonCache = new Map<string, { stamp: string; data: unknown }>();
function readJson(path: string): unknown {
  let stamp: string;
  try {
    const st = statSync(path);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    jsonCache.delete(path);
    return null;
  }
  const hit = jsonCache.get(path);
  if (hit && hit.stamp === stamp) return hit.data;
  let data: unknown = null;
  try {
    data = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    data = null;
  }
  jsonCache.set(path, { stamp, data });
  return data;
}

function mcpServersOf(data: unknown): unknown {
  return data && typeof data === "object" ? (data as Record<string, unknown>).mcpServers : undefined;
}

/**
 * Variablen, die MCP-Konfigurationen für einen Aufruf in `cwd` referenzieren.
 * Gelesen werden nur die Bereiche `mcpServers`: in `<home>/.claude.json` der
 * globale und der des Projekts `cwd` (keine fremden Projekte), in
 * `<cwd>/.mcp.json`, `<cwd>/.claude/settings.json`,
 * `<cwd>/.claude/settings.local.json` und `<home>/.claude/settings.json`.
 * Hooks, Berechtigungen und andere Felder zählen nicht. Fehlende oder defekte
 * Dateien tragen nichts bei.
 */
export function mcpReferencedVars(cwd: string, home: string): Set<string> {
  const out = new Set<string>();
  const dir = resolve(cwd);
  if (home) {
    const global = readJson(join(home, ".claude.json"));
    if (global && typeof global === "object") {
      refsFromServers(mcpServersOf(global), out);
      const projects = (global as Record<string, unknown>).projects;
      if (projects && typeof projects === "object" && !Array.isArray(projects)) {
        refsFromServers(mcpServersOf((projects as Record<string, unknown>)[dir]), out);
      }
    }
    refsFromServers(mcpServersOf(readJson(join(home, ".claude", "settings.json"))), out);
  }
  refsFromServers(mcpServersOf(readJson(join(dir, ".mcp.json"))), out);
  refsFromServers(mcpServersOf(readJson(join(dir, ".claude", "settings.json"))), out);
  refsFromServers(mcpServersOf(readJson(join(dir, ".claude", "settings.local.json"))), out);
  return out;
}

type McpReader = (cwd: string, home: string) => Set<string>;
let mcpReader: McpReader = mcpReferencedVars;

/** Nur für Tests: MCP-Leser ersetzen (nie die echte ~/.claude.json lesen), null stellt zurück. */
export function setMcpReaderForTests(fn: McpReader | null): void {
  mcpReader = fn ?? mcpReferencedVars;
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

export interface SubprocessEnvOptions {
  /** Quelle, Standard process.env (wird nie verändert) */
  env?: Env;
  /** Arbeitsverzeichnis des Aufrufs, Standard process.cwd() */
  cwd?: string;
  /** Heimatverzeichnis für ~/.claude.json, Standard HOME der Quelle */
  home?: string;
  /** Schlüssel der laufenden Ausführung (sessionKeyFor) für TYBO_CHAT_ID/TYBO_TOPIC_ID */
  conversationKey?: string;
}

export interface EnvFilterResult {
  env: Record<string, string>;
  /** Namen der entfernten Geheimnis-Variablen, sortiert */
  removed: string[];
}

/** Filtert die Umgebung; Kern von subprocessEnv(), ohne Log */
export function filterSubprocessEnv(opts: SubprocessEnvOptions = {}): EnvFilterResult {
  const source = opts.env ?? process.env;
  const cwd = opts.cwd ?? process.cwd();
  const home = opts.home ?? source.HOME ?? "";
  const allowed = allowList(source);
  let mcp: Set<string>;
  try {
    mcp = mcpReader(cwd, home);
  } catch {
    mcp = new Set();
  }

  const env: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || ALWAYS_REMOVED.has(name)) continue;
    if (isSecretName(name)) {
      const keep =
        (CLI_AUTH.has(name) && value !== "") || allowed.has(name) || mcp.has(name);
      if (!keep) {
        removed.push(name);
        continue;
      }
    }
    env[name] = value;
  }
  // WEB_PASSWORD wird immer entfernt, gehört aber in die Liste der Geheimnisse
  if (source.WEB_PASSWORD !== undefined) removed.push("WEB_PASSWORD");

  Object.assign(env, SUBPROCESS_MARKER);
  Object.assign(env, conversationEnv(opts.conversationKey));
  return { env, removed: removed.sort() };
}

// ---------------------------------------------------------------------------
// Einmaliges Log
// ---------------------------------------------------------------------------

let logged = false;
let logger: (line: string) => void = line => console.log(line);

/** Nur für Tests: Log-Ziel ersetzen und den Einmal-Merker zurücksetzen; null stellt zurück. */
export function setSubprocessEnvLoggerForTests(fn: ((line: string) => void) | null): void {
  logger = fn ?? (line => console.log(line));
  logged = false;
}

/**
 * Schreibt einmal pro Prozess die Namen (nie Werte) der entfernten Variablen
 * ins Log. Der Bot ruft das direkt nach loadEnv() auf; spätere Aufrufe (auch
 * aus subprocessEnv()) tun nichts mehr.
 */
export function logSubprocessEnvFilter(opts: SubprocessEnvOptions = {}): void {
  if (logged) return;
  logged = true;
  const { removed } = filterSubprocessEnv(opts);
  logger(
    removed.length
      ? `[subprocess-env] Claude-Subprozesse erben ${removed.length} Geheimnis-Variablen nicht: ${removed.join(", ")} (Freigabe: TYBO_SUBPROCESS_ENV_ALLOW)`
      : "[subprocess-env] Keine Geheimnis-Variablen zu entfernen",
  );
}

/**
 * Umgebung für einen Claude-Subprozess: Geheimnisse entfernt (mit den
 * Ausnahmen oben), CLAUDECODE und vererbte Gesprächsvariablen entfernt,
 * TYBO_SUBPROCESS=1 und das Gespräch des Aufrufs gesetzt.
 * process.env bleibt unverändert.
 */
export function subprocessEnv(opts: SubprocessEnvOptions = {}): Record<string, string> {
  logSubprocessEnvFilter(opts);
  return filterSubprocessEnv(opts).env;
}
