/**
 * Umgebung für Subprozesse der Motoren (Issue #54, Entscheidung 0008 Punkt 3;
 * Codex seit Issue #124).
 *
 * Subprozesse erben nicht mehr alle Geheimnisse des Bots: Variablen, deren
 * Name nach Geheimnis aussieht, werden entfernt. Ausnahmen: die Freigabeliste
 * TYBO_SUBPROCESS_ENV_ALLOW, Variablen, die eine MCP-Konfiguration des Motors
 * nennt (die CLI startet diese Server mit ihrer eigenen Umgebung), und bei
 * Claude ANTHROPIC_API_KEY (CLI im API-Modus).
 *
 * Codex: MCP-Verweise kommen aus $CODEX_HOME/config.toml bzw.
 * ~/.codex/config.toml, nicht aus den Claude-Dateien. OPENAI_API_KEY,
 * CODEX_API_KEY und die Telegram-Bot-Tokens gehen nur über die Freigabeliste
 * durch, nie über eine MCP-Referenz.
 *
 * OpenCode (Entscheidung 0019, Issue #128): MCP-Verweise ({env:NAME}) kommen
 * aus opencode.json(c) im Konfigurationsordner von OpenCode und im Projekt,
 * nicht aus den Claude-Dateien. Zugangsdaten aller Anbieter, die OpenCode
 * kennt (isOpenCodeProviderCredential, nicht nur OPENCODE_PROVIDER_KEYS),
 * und alle TELEGRAM_*-Variablen gehen nur über die Freigabeliste durch, nie
 * über eine MCP-Referenz; die ANTHROPIC_API_KEY-Ausnahme von Claude gilt nicht.
 * Anbieter erkennt tybo auch aus config.json im Konfigurationsordner,
 * opencode.json(c) in übergeordneten Ordnern und in .opencode-Ordnern,
 * OPENCODE_CONFIG, OPENCODE_CONFIG_DIR und OPENCODE_CONFIG_CONTENT;
 * MCP-Verweise zählen nur aus opencode.json(c) im Konfigurationsordner und
 * im Projekt.
 * Netzzugang, Bash und Werkzeuge bleiben unverändert; die .env bleibt lesbar.
 */

import { readFileSync, statSync } from "fs";
import { dirname, isAbsolute, join, resolve } from "path";
import { MODELS_DEV_PROVIDER_ENV } from "./engines/opencode-provider-env";
import type { EngineId } from "./engines/types";

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
 * Gespräch des Aufrufs gesetzt wird. TYBO_CONVERSATION_ID (Issue #227): reines
 * Web-Gespräch als Rückmeldeziel.
 */
export const CONVERSATION_VARS: readonly string[] = ["TYBO_CHAT_ID", "TYBO_TOPIC_ID", "TYBO_CONVERSATION_ID"];

/**
 * Markiert jeden Subprozess von tybo: Hooks in .claude/settings.local.json
 * prüfen darauf (Stop-Hook-Gate, 9.9.2026).
 */
export const SUBPROCESS_MARKER: Readonly<Record<string, string>> = { TYBO_SUBPROCESS: "1" };

/**
 * Bei Codex nur über die Freigabeliste, nie über eine MCP-Referenz:
 * API-Schlüssel von OpenAI (mit ChatGPT-Anmeldung nicht nötig, sonst gelten
 * API-Preise) und die Bot-Tokens von Telegram.
 */
const CODEX_ALLOW_ONLY = [/^OPENAI_API_KEY$/, /^CODEX_API_KEY$/, /^TELEGRAM_BOT_TOKEN(_|$)/];

function codexAllowOnly(name: string): boolean {
  return CODEX_ALLOW_ONLY.some(p => p.test(name));
}

/**
 * Anbieter-Schlüssel, die OpenCode von selbst aus seiner Umgebung nimmt
 * (Issue #128): OpenRouter, OpenAI, Anthropic, OpenCode Zen, Google, xAI,
 * Groq, Mistral, DeepSeek. Viele davon nutzt tybo selbst (Fallback,
 * Embeddings, Transkription); OpenCode bekommt sie nur über die
 * Freigabeliste, damit nicht versehentlich tybos Schlüssel die Rechnung zahlt.
 * Dieselbe Liste zählt in checkEngine("opencode") als Anmeldung. Die
 * Freigabepflicht gilt darüber hinaus für alle Anbieter
 * (isOpenCodeProviderCredential).
 */
export const OPENCODE_PROVIDER_KEYS: readonly string[] = [
  "OPENROUTER_API_KEY",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENCODE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
];

/**
 * Zugangsdaten, die die Anbieter-SDKs von OpenCode selbst aus der Umgebung
 * lesen, die aber in keiner models.dev-Liste `env` stehen: die
 * AWS-Credential-Chain für Bedrock (Sitzungs-Token, Web-Identity- und
 * Container-Token), Cloudflare AI Gateway und Snowflake Cortex
 * (OpenCode provider.ts).
 */
export const OPENCODE_SDK_CREDENTIALS: readonly string[] = [
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SECURITY_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "CF_AIG_TOKEN",
  "SNOWFLAKE_CORTEX_TOKEN",
];

const MODELS_DEV_ENV = new Set([...MODELS_DEV_PROVIDER_ENV, ...OPENCODE_PROVIDER_KEYS, ...OPENCODE_SDK_CREDENTIALS]);

/** Einstellungen eines Anbieters, keine Zugangsdaten: Region, Projekt, Konto, Adresse */
const PROVIDER_SETTING = /(_REGION|_LOCATION|_PROJECT|_PROJECT_ID|_RESOURCE_NAME|_ACCOUNT|_ACCOUNT_ID|_GATEWAY_ID|_PRODUCT_ID|_HOST|_ENDPOINT|_BASE_URL)$/i;

/**
 * Zugangsdaten eines Anbieters, den OpenCode kennt: Umgebungsvariablen der
 * Anbieter aus models.dev (MODELS_DEV_PROVIDER_ENV und `extra`, siehe
 * opencodeProviderVars) und der SDKs (OPENCODE_SDK_CREDENTIALS), ohne reine
 * Einstellungen wie AWS_REGION. Gilt auch für Namen, die nicht nach
 * Geheimnis aussehen (AWS_ACCESS_KEY_ID, CLARIFAI_PAT). Namen in
 * `credentialRefs` (Verweise aus Zugangsdatenfeldern, siehe
 * opencodeProviderCredentialRefs) zählen immer, auch mit Einstellungs-Endung.
 * OpenCode bekommt sie nur über die Freigabeliste.
 */
export function isOpenCodeProviderCredential(
  name: string,
  extra: ReadonlySet<string> = new Set(),
  credentialRefs: ReadonlySet<string> = new Set(),
): boolean {
  if (credentialRefs.has(name)) return true;
  if (!MODELS_DEV_ENV.has(name) && !extra.has(name)) return false;
  return isSecretName(name) || !PROVIDER_SETTING.test(name);
}

/**
 * Immer entfernt, auch bei Freigabe oder MCP-Referenz. WEB_PUSH_PRIVATE_KEY
 * (Issue #225): mit ihm könnte jeder im Namen von tybo an die Geräte pushen.
 */
const ALWAYS_REMOVED = new Set(["CLAUDECODE", ...CONVERSATION_VARS, "WEB_PASSWORD", "WEB_PUSH_PRIVATE_KEY"]);

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
 * setzen TYBO_CHAT_ID, topic:<chat>:<n> zusätzlich TYBO_TOPIC_ID. Seit Issue
 * #227: dm:web (Direktchat ohne Telegram) setzt TYBO_CHAT_ID=web, web:<uuid>
 * TYBO_CONVERSATION_ID=<uuid>. background, kein Kontext oder ein unbekanntes
 * Format setzen nichts. `bun run notify` im Subprozess legt Dateien so im
 * richtigen Gespräch ab.
 */
export function conversationEnv(key: string | undefined): Record<string, string> {
  if (!key) return {};
  const dm = /^dm:(\d{1,20}|web)$/.exec(key);
  if (dm) return { TYBO_CHAT_ID: dm[1] };
  const web = /^web:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/.exec(key);
  if (web) return { TYBO_CONVERSATION_ID: web[1] };
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

/** Datei nach Pfad, geparst und zwischengespeichert nach Änderungszeit und Größe; fehlend oder defekt: null */
const fileCache = new Map<string, { stamp: string; data: unknown }>();
function readParsed(path: string, parse: (text: string) => unknown): unknown {
  let stamp: string;
  try {
    const st = statSync(path);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    fileCache.delete(path);
    return null;
  }
  const hit = fileCache.get(path);
  if (hit && hit.stamp === stamp) return hit.data;
  let data: unknown = null;
  try {
    data = parse(readFileSync(path, "utf-8"));
  } catch {
    data = null;
  }
  fileCache.set(path, { stamp, data });
  return data;
}

function readJson(path: string): unknown {
  return readParsed(path, JSON.parse);
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

/** Konfigurationsordner von Codex: CODEX_HOME, wenn gesetzt, sonst <home>/.codex; ohne beides leer */
export function codexHomeDir(env: Env, home: string): string {
  if (env.CODEX_HOME) return resolve(env.CODEX_HOME);
  return home ? join(home, ".codex") : "";
}

const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function addName(value: unknown, out: Set<string>): void {
  if (typeof value === "string" && VAR_NAME.test(value)) out.add(value);
}

/**
 * Variablen, die die MCP-Server in `<codexHome>/config.toml` nennen, je
 * Eintrag unter `[mcp_servers.<name>]`:
 * - `env_vars`: Namen, die Codex aus der eigenen Umgebung weitergibt
 * - `env`: ${VAR}/$VAR in den Werten
 * - `bearer_token_env_var` und die Werte von `env_http_headers` (HTTP-Server)
 * Projektdateien (`.codex/config.toml`) und andere Felder zählen nicht.
 * Fehlende oder defekte Datei: leer.
 */
export function codexMcpReferencedVars(codexHome: string): Set<string> {
  const out = new Set<string>();
  if (!codexHome) return out;
  const data = readParsed(join(codexHome, "config.toml"), text => Bun.TOML.parse(text));
  const servers = data && typeof data === "object" ? (data as Record<string, unknown>).mcp_servers : undefined;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) return out;
  for (const server of Object.values(servers as Record<string, unknown>)) {
    if (!server || typeof server !== "object" || Array.isArray(server)) continue;
    const s = server as Record<string, unknown>;
    if (Array.isArray(s.env_vars)) for (const v of s.env_vars) addName(v, out);
    if (s.env && typeof s.env === "object") collectRefs(s.env, out);
    addName(s.bearer_token_env_var, out);
    if (s.env_http_headers && typeof s.env_http_headers === "object" && !Array.isArray(s.env_http_headers)) {
      for (const v of Object.values(s.env_http_headers)) addName(v, out);
    }
  }
  return out;
}

/**
 * Konfigurationsordner von OpenCode: $XDG_CONFIG_HOME/opencode, wenn
 * XDG_CONFIG_HOME ein absoluter Pfad ist, sonst <home>/.config/opencode;
 * ohne beides leer.
 */
export function opencodeConfigDir(env: Env, home: string): string {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) return join(resolve(xdg), "opencode");
  return home ? join(home, ".config", "opencode") : "";
}

/** {env:NAME} in OpenCode-Konfigurationen */
const OPENCODE_REF = /\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g;

function collectOpenCodeRefs(value: unknown, out: Set<string>): void {
  if (typeof value === "string") {
    for (const m of value.matchAll(OPENCODE_REF)) out.add(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value) collectOpenCodeRefs(v, out);
  } else if (value && typeof value === "object") {
    for (const v of Object.values(value)) collectOpenCodeRefs(v, out);
  }
}

/**
 * Variablen, die die MCP-Server von OpenCode nennen: {env:NAME} in allen
 * Werten eines Eintrags unter `"mcp"` (environment, command, headers, url),
 * gelesen aus opencode.json und opencode.jsonc im Konfigurationsordner
 * (opencodeConfigDir) und im Arbeitsverzeichnis `cwd`. Andere Abschnitte
 * (provider, agent, ...) zählen nicht. Fehlende oder defekte Dateien tragen
 * nichts bei. OpenCode setzt {env:NAME} selbst ein, deshalb muss NAME in
 * seiner Umgebung stehen.
 */
export function opencodeMcpReferencedVars(configDir: string, cwd: string): Set<string> {
  const out = new Set<string>();
  const dirs = [configDir, resolve(cwd)].filter(Boolean);
  for (const dir of dirs) {
    for (const file of ["opencode.json", "opencode.jsonc"]) {
      const data = readParsed(join(dir, file), text => Bun.JSONC.parse(text));
      const servers = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).mcp : undefined;
      if (!servers || typeof servers !== "object" || Array.isArray(servers)) continue;
      for (const server of Object.values(servers as Record<string, unknown>)) {
        if (server && typeof server === "object" && !Array.isArray(server)) collectOpenCodeRefs(server, out);
      }
    }
  }
  return out;
}

/**
 * Cache-Ordner von OpenCode: $XDG_CACHE_HOME/opencode, wenn XDG_CACHE_HOME
 * ein absoluter Pfad ist, sonst <home>/.cache/opencode; ohne beides leer.
 */
export function opencodeCacheDir(env: Env, home: string): string {
  const xdg = env.XDG_CACHE_HOME;
  if (xdg && isAbsolute(xdg)) return join(resolve(xdg), "opencode");
  return home ? join(home, ".cache", "opencode") : "";
}

/**
 * Zusätzliche Konfigurationsquellen, die OpenCode neben opencode.json(c) im
 * Konfigurationsordner und im Projekt liest: die Datei OPENCODE_CONFIG
 * (relativ zu `cwd`), opencode.json(c) im Ordner OPENCODE_CONFIG_DIR und der
 * Inhalt von OPENCODE_CONFIG_CONTENT. Fehlende oder defekte Quellen tragen
 * nichts bei. Zählen nur für die Anbieter-Erkennung, nicht für MCP-Verweise.
 */
function opencodeExtraConfigs(env: Env, cwd: string): unknown[] {
  const out: unknown[] = [];
  const parse = (text: string) => Bun.JSONC.parse(text);
  if (env.OPENCODE_CONFIG) out.push(readParsed(resolve(cwd, env.OPENCODE_CONFIG), parse));
  if (env.OPENCODE_CONFIG_DIR) {
    const dir = resolve(cwd, env.OPENCODE_CONFIG_DIR);
    for (const file of ["opencode.json", "opencode.jsonc"]) out.push(readParsed(join(dir, file), parse));
  }
  if (env.OPENCODE_CONFIG_CONTENT) {
    try {
      out.push(parse(env.OPENCODE_CONFIG_CONTENT));
    } catch {
      // defekter Inhalt trägt nichts bei
    }
  }
  return out;
}

/**
 * Konfigurationsdateien, die OpenCode je nach Projekt und Ordner liest:
 * config.json, opencode.json und opencode.jsonc im Konfigurationsordner,
 * opencode.json(c) im Arbeitsverzeichnis, in jedem übergeordneten Ordner und
 * in deren Unterordner .opencode sowie in <home>/.opencode. Aufwärts bis zur
 * Wurzel, auch über das Projekt hinaus (vorsichtiger als OpenCode selbst).
 */
/**
 * Systemweite Konfiguration von OpenCode (PR #232): macOS
 * `/Library/Application Support/opencode`, Linux `/etc/opencode`, Windows
 * `%ProgramData%\\opencode`. Verwaltete Einstellungen per MDM-Profil und
 * entfernte Organisations-Konfigurationen liest tybo nicht (dokumentierte Grenze).
 */
function defaultOpenCodeSystemDirs(): string[] {
  if (process.platform === "darwin") return ["/Library/Application Support/opencode"];
  if (process.platform === "win32") return [join(process.env.ProgramData || "C:\\ProgramData", "opencode")];
  return ["/etc/opencode"];
}

let openCodeSystemDirs: () => string[] = defaultOpenCodeSystemDirs;

/** Nur für Tests: systemweite OpenCode-Ordner ersetzen, null stellt zurück */
export function setOpenCodeSystemDirsForTests(dirs: string[] | null): void {
  openCodeSystemDirs = dirs ? () => dirs : defaultOpenCodeSystemDirs;
}

function opencodeConfigFiles(configDir: string, cwd: string, home: string): string[] {
  const names = ["opencode.json", "opencode.jsonc"];
  const files: string[] = [];
  for (const dir of openCodeSystemDirs()) for (const file of names) files.push(join(dir, file));
  if (configDir) for (const file of ["config.json", ...names]) files.push(join(configDir, file));
  let dir = resolve(cwd);
  for (;;) {
    for (const file of names) files.push(join(dir, file), join(dir, ".opencode", file));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (home) for (const file of names) files.push(join(resolve(home), ".opencode", file));
  return [...new Set(files)];
}

/**
 * Einträge unter `"provider"` aller Konfigurationsquellen von OpenCode:
 * die Dateien aus opencodeConfigFiles sowie die zusätzlichen Quellen aus
 * `env` (opencodeExtraConfigs).
 */
function opencodeProviderEntries(configDir: string, cwd: string, env: Env, home: string): unknown[] {
  const docs: unknown[] = [];
  for (const file of opencodeConfigFiles(configDir, cwd, home)) {
    docs.push(readParsed(file, text => Bun.JSONC.parse(text)));
  }
  docs.push(...opencodeExtraConfigs(env, cwd));
  const out: unknown[] = [];
  for (const data of docs) {
    const providers = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>).provider : undefined;
    if (!providers || typeof providers !== "object" || Array.isArray(providers)) continue;
    out.push(...Object.values(providers as Record<string, unknown>));
  }
  return out;
}

/**
 * Anbieter-Variablen über MODELS_DEV_PROVIDER_ENV hinaus: `env` aller
 * Anbieter in OpenCodes Zwischenspeicher von models.dev
 * (`<cacheDir>/models.json`, kennt neuere Anbieter) sowie `env` und
 * {env:NAME} der Einträge unter `"provider"` in allen Konfigurationsquellen
 * (opencodeProviderEntries, eigene Anbieter).
 * Fehlende oder defekte Dateien tragen nichts bei.
 */
export function opencodeProviderVars(configDir: string, cwd: string, cacheDir: string, env: Env = {}, home = ""): Set<string> {
  const out = new Set<string>();
  const addEnvList = (entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
    const list = (entry as Record<string, unknown>).env;
    if (Array.isArray(list)) for (const v of list) addName(v, out);
  };
  if (cacheDir) {
    const models = readJson(join(cacheDir, "models.json"));
    if (models && typeof models === "object" && !Array.isArray(models)) {
      for (const p of Object.values(models as Record<string, unknown>)) addEnvList(p);
    }
  }
  // Nur die env-Liste zählt als Anbieter-Variable; {env:NAME} in gewöhnlichen
  // Feldern (options.profile, baseURL) folgt der Namensregel, Verweise in
  // Zugangsdatenfeldern erfasst opencodeProviderCredentialRefs (PR #232, AWS_PROFILE)
  for (const p of opencodeProviderEntries(configDir, cwd, env, home)) addEnvList(p);
  return out;
}

/** Feldnamen, deren Wert ein Zugangsdatum ist (apiKey, secretAccessKey, sessionToken, Authorization, ...) */
const CREDENTIAL_FIELD = /key|token|secret|password|passwd|credential|auth|bearer|cookie|pat$/i;

function collectCredentialRefs(value: unknown, inCredential: boolean, out: Set<string>): void {
  if (typeof value === "string") {
    if (inCredential) for (const m of value.matchAll(OPENCODE_REF)) out.add(m[1]);
  } else if (Array.isArray(value)) {
    for (const v of value) collectCredentialRefs(v, inCredential, out);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) collectCredentialRefs(v, inCredential || CREDENTIAL_FIELD.test(k), out);
  }
}

/**
 * {env:NAME} in Zugangsdatenfeldern der Einträge unter `"provider"` in allen
 * Konfigurationsquellen (opencodeProviderEntries), etwa `options.apiKey`
 * oder `options.headers.Authorization`. Diese Namen sind Zugangsdaten
 * unabhängig davon, wie sie heißen (LOGIN_ACCOUNT).
 */
export function opencodeProviderCredentialRefs(configDir: string, cwd: string, env: Env = {}, home = ""): Set<string> {
  const out = new Set<string>();
  for (const p of opencodeProviderEntries(configDir, cwd, env, home)) {
    collectCredentialRefs(p, false, out);
    // "env": [...] eines eigenen Anbieters nennt die Variablen, aus denen OpenCode den
    // Schlüssel liest; sie sind Zugangsdaten, egal wie sie heißen (PR #232, LOGIN_ACCOUNT)
    const list = p && typeof p === "object" ? (p as { env?: unknown }).env : undefined;
    if (Array.isArray(list)) for (const n of list) if (typeof n === "string" && n) out.add(n);
  }
  return out;
}

type McpReader = (cwd: string, home: string, engine: EngineId, env: Env) => Set<string>;

/** MCP-Verweise des Motors: Codex aus seiner config.toml, OpenCode aus opencode.json(c), sonst die Claude-Dateien */
function defaultMcpReader(cwd: string, home: string, engine: EngineId, env: Env): Set<string> {
  if (engine === "opencode") return opencodeMcpReferencedVars(opencodeConfigDir(env, home), cwd);
  return engine === "codex" ? codexMcpReferencedVars(codexHomeDir(env, home)) : mcpReferencedVars(cwd, home);
}

let mcpReader: McpReader = defaultMcpReader;

/** Nur für Tests: MCP-Leser ersetzen (nie die echte ~/.claude.json oder ~/.codex lesen), null stellt zurück. */
export function setMcpReaderForTests(fn: McpReader | null): void {
  mcpReader = fn ?? defaultMcpReader;
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
  /** Motor des Subprozesses, Standard claude */
  engine?: EngineId;
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
  const engine = opts.engine ?? "claude";
  const allowed = allowList(source);
  let mcp: Set<string>;
  try {
    mcp = mcpReader(cwd, home, engine, source);
  } catch {
    mcp = new Set();
  }
  const codex = engine === "codex";
  let providerVars = new Set<string>();
  let credentialRefs = new Set<string>();
  if (engine === "opencode") {
    try {
      providerVars = opencodeProviderVars(opencodeConfigDir(source, home), cwd, opencodeCacheDir(source, home), source, home);
    } catch {
      providerVars = new Set();
    }
    try {
      credentialRefs = opencodeProviderCredentialRefs(opencodeConfigDir(source, home), cwd, source, home);
    } catch {
      credentialRefs = new Set();
    }
  }

  const env: Record<string, string> = {};
  const removed: string[] = [];
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || ALWAYS_REMOVED.has(name)) continue;
    if (engine === "opencode" && isOpenCodeProviderCredential(name, providerVars, credentialRefs)) {
      // Anbieter-Zugangsdaten nur über die Freigabeliste, nie über eine MCP-Referenz
      if (!allowed.has(name)) {
        removed.push(name);
        continue;
      }
    } else if (isSecretName(name)) {
      const keep = engine === "opencode"
        ? allowed.has(name) || (mcp.has(name) && !/^TELEGRAM_/i.test(name))
        : codex
        ? allowed.has(name) || (mcp.has(name) && !codexAllowOnly(name))
        : (CLI_AUTH.has(name) && value !== "") || allowed.has(name) || mcp.has(name);
      if (!keep) {
        removed.push(name);
        continue;
      }
    }
    env[name] = value;
  }
  // WEB_PASSWORD und WEB_PUSH_PRIVATE_KEY werden immer entfernt, gehören aber in die Liste der Geheimnisse
  for (const name of ["WEB_PASSWORD", "WEB_PUSH_PRIVATE_KEY"]) if (source[name] !== undefined) removed.push(name);

  Object.assign(env, SUBPROCESS_MARKER);
  Object.assign(env, conversationEnv(opts.conversationKey));
  return { env, removed: removed.sort() };
}

// ---------------------------------------------------------------------------
// Einmaliges Log
// ---------------------------------------------------------------------------

const logged = new Set<EngineId>();
let logger: (line: string) => void = line => console.log(line);

/** Nur für Tests: Log-Ziel ersetzen und die Einmal-Merker zurücksetzen; null stellt zurück. */
export function setSubprocessEnvLoggerForTests(fn: ((line: string) => void) | null): void {
  logger = fn ?? (line => console.log(line));
  logged.clear();
}

const LOG_LABEL: Record<EngineId, string> = { claude: "Claude", codex: "Codex", opencode: "OpenCode" };

/**
 * Schreibt einmal pro Prozess und Motor die Namen (nie Werte) der entfernten
 * Variablen ins Log. Der Bot ruft das für Claude direkt nach loadEnv() auf;
 * spätere Aufrufe (auch aus subprocessEnv()) tun für diesen Motor nichts mehr.
 */
export function logSubprocessEnvFilter(opts: SubprocessEnvOptions = {}): void {
  const engine = opts.engine ?? "claude";
  if (logged.has(engine)) return;
  logged.add(engine);
  const { removed } = filterSubprocessEnv(opts);
  logger(
    removed.length
      ? `[subprocess-env] ${LOG_LABEL[engine]}-Subprozesse erben ${removed.length} Geheimnis-Variablen nicht: ${removed.join(", ")} (Freigabe: TYBO_SUBPROCESS_ENV_ALLOW)`
      : engine === "claude"
        ? "[subprocess-env] Keine Geheimnis-Variablen zu entfernen"
        : `[subprocess-env] ${LOG_LABEL[engine]}: keine Geheimnis-Variablen zu entfernen`,
  );
}

/**
 * Umgebung für einen Subprozess des Motors (Standard Claude): Geheimnisse
 * entfernt (mit den Ausnahmen oben), CLAUDECODE und vererbte Gesprächsvariablen entfernt,
 * TYBO_SUBPROCESS=1 und das Gespräch des Aufrufs gesetzt.
 * process.env bleibt unverändert.
 */
export function subprocessEnv(opts: SubprocessEnvOptions = {}): Record<string, string> {
  logSubprocessEnvFilter(opts);
  return filterSubprocessEnv(opts).env;
}
