/**
 * MCP für einen Codex-Lauf planen (M14-11, Entscheidung 0027).
 * Nur die Leser greifen auf Dateien zu. Chat und volle Jobs wenden den Plan je Lauf an.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { optionalCredential } from "../credentials";
import { projectSecrets } from "../jobs/mask";
import { CODEX_MCP_NAME_PATTERN, getSettings, type CodexMcpSettings, type CodexSandbox } from "../settings";
import {
  codexHomeDir,
  isProtectedSubprocessReference,
  isProtectedSubprocessSecret,
  isProtectedSubprocessVar,
} from "../subprocess-env";
import { secretShaped } from "./codex";

export type CodexMcpSource = "tybo" | "extra" | "claude-project" | "mcp-json" | "claude-user" | "claude-settings";
export type CodexMcpSkipReason =
  | "disabled" | "user_skip" | "sandbox" | "codex_config_unreadable"
  | "claude_disabled" | "not_approved" | "unsupported_source" | "transport"
  | "invalid_name" | "invalid_value" | "secret_in_command" | "secret_in_url"
  | "placeholder_unresolved" | "reserved_env" | "env_conflict" | "auth_unknown";

/** Ungeprüfte Werte bleiben erhalten, damit kein fehlerhafter Teil still entfällt. */
export interface CodexMcpEntry {
  name: string;
  source: CodexMcpSource;
  config?: unknown;
  claudeDisabled?: boolean;
  mcpJsonApproved?: boolean;
}

export interface CodexOwnMcpNames {
  names: ReadonlySet<string>;
  readable: boolean;
}

type Env = Readonly<Record<string, string | undefined>>;
export interface CodexMcpInput {
  sources: readonly CodexMcpEntry[];
  own: CodexOwnMcpNames;
  settings: CodexMcpSettings;
  sandbox: CodexSandbox;
  baseEnv: Env;
  parentEnv: Env;
  lookup: (name: string) => string | undefined;
  knownSecrets: readonly string[];
}

export interface CodexMcpPlan {
  passed: { name: string; kind: "stdio" | "http"; source: CodexMcpSource }[];
  own: string[];
  skipped: { name: string; source: CodexMcpSource; reason: CodexMcpSkipReason }[];
  args: string[];
  env: Record<string, string>;
  secretValues: string[];
}

export interface CodexMcpPaths {
  /** config/mcp-servers.json aus tybos Projekt, unabhängig vom Laufordner. */
  projectFile: string;
  extraFile?: string;
  cwd: string;
  home: string;
}

const SOURCE_ORDER: readonly CodexMcpSource[] = ["tybo", "extra", "claude-project", "mcp-json", "claude-user", "claude-settings"];
const CONTROL = /[\u0000-\u001f\u007f]/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PLACEHOLDER = /\$\{|\$[A-Za-z_][A-Za-z0-9_]*/;
const CREDENTIAL_FLAG = /^--?[\w-]*(key|token|secret|password|passwd|pwd|auth|credential|cookie)[\w-]*$/i;

/** Nur sichere Namen dürfen in Anzeigen und Meldungen gelangen. Abgleich vorher im Original. */
export function safeMcpName(name: string): string {
  return CODEX_MCP_NAME_PATTERN.test(name) ? name : `unzulaessig-${createHash("sha256").update(name, "utf8").digest("hex").slice(0, 8)}`;
}

/** Einzige Bildungsregel für die vom Plan selbst belegten Kopfzeilen-Variablen. */
export function codexMcpHeaderVar(server: string, header?: string): string {
  const part = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `TYBO_MCP_${part(server)}_${header === undefined ? "BEARER" : `HEADER_${part(header)}`}_TOKEN`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

type McpReader = (path: string) => string;
/** Ein Abruf kann gelesene Dateien und geparste JSON-Daten gemeinsam zwischenspeichern. */
export interface CodexMcpReaders {
  text?: McpReader;
  json?: (path: string | undefined) => Record<string, unknown> | undefined;
}
const defaultReader: McpReader = path => readFileSync(path, "utf8");
let readFile: McpReader = defaultReader;

/** Nur für Tests: alle JSON- und TOML-Zugriffe ersetzen; null stellt zurück. */
export function setCodexMcpReaderForTests(reader: McpReader | null): void {
  readFile = reader ?? defaultReader;
}

function defaultReadJson(path: string | undefined, reader: McpReader = readFile): Record<string, unknown> | undefined {
  if (!path) return undefined;
  try {
    return record(JSON.parse(reader(path)));
  } catch {
    // Auch Parserfehler können Dateiinhalte enthalten: hier nie loggen.
    return undefined;
  }
}

/** Quellen in Vorrangfolge, auch fehlerhafte Einträge sperren spätere gleichen Namens. */
export function readCodexMcpSources(paths: CodexMcpPaths, readers: CodexMcpReaders = {}): CodexMcpEntry[] {
  const readJson = readers.json ?? (path => defaultReadJson(path, readers.text));
  const cwd = resolve(paths.cwd);
  const claude = paths.home ? readJson(join(paths.home, ".claude.json")) : undefined;
  const project = record(record(claude?.projects)?.[cwd]);
  const contains = (value: unknown, name: string) => Array.isArray(value) && value.includes(name);
  const entries: CodexMcpEntry[] = [];
  const seen = new Set<string>();
  const take = (source: CodexMcpSource, servers: unknown) => {
    for (const [name, config] of Object.entries(record(servers) ?? {})) {
      if (seen.has(name)) continue;
      seen.add(name);
      if (source === "claude-settings") {
        entries.push({ name, source });
      } else {
        const fromClaude = source === "claude-project" || source === "mcp-json" || source === "claude-user";
        entries.push({ name, source, config,
          ...(fromClaude ? { claudeDisabled: contains(project?.disabledMcpServers, name) } : {}),
          ...(source === "mcp-json" ? { mcpJsonApproved: contains(project?.enabledMcpjsonServers, name)
            && !contains(project?.disabledMcpjsonServers, name) } : {}),
        });
      }
    }
  };
  take("tybo", readJson(paths.projectFile)?.servers);
  const extra = readJson(paths.extraFile);
  take("extra", record(extra?.servers) ?? extra?.mcpServers);
  take("claude-project", project?.mcpServers);
  take("mcp-json", readJson(join(cwd, ".mcp.json"))?.mcpServers);
  take("claude-user", claude?.mcpServers);
  for (const file of [join(cwd, ".claude", "settings.json"), join(cwd, ".claude", "settings.local.json"),
    ...(paths.home ? [join(paths.home, ".claude", "settings.json")] : [])]) {
    take("claude-settings", readJson(file)?.mcpServers);
  }
  return entries;
}

/** Auch ungenutzte Profile und nicht vertraute Projektordner sperren vorsorglich ihre Namen. */
export function readCodexOwnMcpNames(codexHome: string, cwd: string, reader: McpReader = readFile): CodexOwnMcpNames {
  const paths = new Set<string>();
  if (codexHome) paths.add(resolve(codexHome, "config.toml"));
  for (let dir = resolve(cwd);;) {
    paths.add(join(dir, ".codex", "config.toml"));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  const names = new Set<string>();
  let readable = true;
  const take = (value: unknown) => {
    if (value === undefined) return;
    const servers = record(value);
    if (!servers) { readable = false; return; }
    for (const name of Object.keys(servers)) names.add(name);
  };
  for (const path of paths) {
    let text: string;
    try {
      text = reader(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") readable = false;
      continue;
    }
    try {
      const data = record(Bun.TOML.parse(text))!;
      take(data.mcp_servers);
      for (const profile of Object.values(record(data.profiles) ?? {})) take(record(profile)?.mcp_servers);
    } catch {
      readable = false;
    }
  }
  return { names, readable };
}

function stringMap(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return {};
  const entries = record(value);
  if (!entries || Object.entries(entries).some(([name, v]) => !name || CONTROL.test(name) || typeof v !== "string" || CONTROL.test(v))) return undefined;
  return entries as Record<string, string>;
}

function protectedRef(value: string): boolean {
  const refs = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
  return [...value.matchAll(refs)].some(m => isProtectedSubprocessReference(m[1] ?? m[2], "codex"));
}

function expand(value: string, lookup: CodexMcpInput["lookup"]): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name: string) =>
    isProtectedSubprocessReference(name, "codex") ? whole : lookup(name) || whole);
}

function tomlTable(entries: readonly (readonly [string, string])[]): string {
  return `{${entries.map(([name, value]) => `${JSON.stringify(name)}=${JSON.stringify(value)}`).join(",")}}`;
}

interface Candidate {
  kind: "stdio" | "http";
  args: string[];
  env: Map<string, string>;
  headerVars: string[];
}

/** Prüfung eines einzelnen Servers; weder Eingaben noch bisheriger Plan werden verändert. */
function planServer(entry: CodexMcpEntry, input: CodexMcpInput): Candidate | CodexMcpSkipReason {
  const raw = record(entry.config);
  if (raw?.type === "sse") return "transport";
  if (!raw || (raw.type !== undefined && raw.type !== "stdio" && raw.type !== "http")) return "invalid_value";
  const kind = raw.type === "http" ? "http" : "stdio";
  const env = stringMap(raw.env);
  const headers = stringMap(raw.headers);
  const args = raw.args === undefined ? [] : raw.args;
  if (!env || !headers || Object.keys(env).some(name => !ENV_NAME.test(name))
    || !Array.isArray(args) || args.some(v => typeof v !== "string" || CONTROL.test(v))) return "invalid_value";
  if (kind === "stdio" && (typeof raw.command !== "string" || !raw.command.trim() || CONTROL.test(raw.command))) return "invalid_value";
  if (kind === "http" && (typeof raw.url !== "string" || !raw.url || CONTROL.test(raw.url))) return "invalid_value";
  let url: URL | undefined;
  if (kind === "http" && !PLACEHOLDER.test(raw.url as string)) {
    try { url = new URL(raw.url as string); } catch { return "invalid_value"; }
    if (!/^https?:\/\//i.test(raw.url as string) || !["http:", "https:"].includes(url.protocol) || !url.hostname) return "invalid_value";
  }
  const resolvedEnv = Object.entries(env).map(([name, value]) => [name, expand(value, input.lookup)] as const);
  const resolvedHeaders = Object.entries(headers).map(([name, value]) => [name, expand(value, input.lookup)] as const);
  const bearer = (name: string, value: string) => /^authorization$/i.test(name) && /^Bearer /i.test(value);
  if ([...resolvedEnv, ...resolvedHeaders].some(([, value]) => CONTROL.test(value))
    || resolvedHeaders.some(([name, value]) => bearer(name, value) && !value.slice(7).trim())) return "invalid_value";

  const protectedValues = new Set(Object.entries(input.parentEnv)
    .filter(([name, value]) => isProtectedSubprocessSecret(name, "codex") && value !== undefined && value !== "")
    .map(([, value]) => value));
  const refValues = [...Object.values(env), ...Object.values(headers), ...(kind === "http" ? [raw.url as string] : [])];
  const resolvedValues = [...resolvedEnv.map(([, value]) => value),
    ...resolvedHeaders.map(([name, value]) => bearer(name, value) ? value.slice(7) : value),
    ...(kind === "http" ? [raw.url as string] : [])];
  if (Object.keys(env).some(name => isProtectedSubprocessVar(name, "codex") || name.startsWith("TYBO_MCP_"))
    || refValues.some(protectedRef) || resolvedValues.some(value => protectedValues.has(value))) return "reserved_env";

  const secret = (value: string) => PLACEHOLDER.test(value) || secretShaped(value)
    || input.knownSecrets.some(known => known.length >= 8 && value.includes(known));
  if (kind === "stdio" && (secret(raw.command as string)
    || args.some((value, i) => secret(value) || (i > 0 && CREDENTIAL_FLAG.test(args[i - 1]))))) return "secret_in_command";
  if (kind === "http" && (secret(raw.url as string) || url?.username || url?.password)) return "secret_in_url";
  if ([...resolvedEnv, ...resolvedHeaders].some(([, value]) => value.includes("${"))) return "placeholder_unresolved";
  if (kind === "http" && !resolvedHeaders.length && entry.source !== "tybo" && entry.source !== "extra"
    && !input.settings.public?.includes(entry.name)) return "auth_unknown";

  const candidate: Candidate = { kind, args: [], env: new Map(), headerVars: [] };
  const add = (field: string, value: string) => candidate.args.push("-c", `mcp_servers.${entry.name}.${field}=${value}`);
  if (kind === "stdio") {
    add("command", JSON.stringify(raw.command));
    add("args", JSON.stringify(args));
    add("env_vars", JSON.stringify(resolvedEnv.map(([name]) => name).sort()));
    for (const [name, value] of resolvedEnv) candidate.env.set(name, value);
  } else {
    add("url", JSON.stringify(raw.url));
    const httpHeaders: [string, string][] = [];
    for (const [name, value] of resolvedHeaders) {
      const isBearer = bearer(name, value);
      const variable = codexMcpHeaderVar(entry.name, isBearer ? undefined : name);
      // Auch gleiche Werte dürfen keine zwei unterschiedlich benannten Kopfzeilen vermischen.
      if (candidate.env.has(variable)) return "env_conflict";
      candidate.env.set(variable, isBearer ? value.slice(7) : value);
      candidate.headerVars.push(variable);
      if (isBearer) add("bearer_token_env_var", JSON.stringify(variable));
      else httpHeaders.push([name, variable]);
    }
    if (httpHeaders.length) add("env_http_headers", tomlTable(httpHeaders));
  }
  add("default_tools_approval_mode", JSON.stringify("approve"));
  return candidate;
}

/**
 * Feste Vorrangfolge der Gründe: disabled, sandbox, unlesbare Codex-Dateien;
 * danach own, user_skip, unsupported_source, invalid_name, Claude-Freigaben,
 * transport, invalid_value, reserved_env, secret_in_*, placeholder_unresolved,
 * auth_unknown, env_conflict. Doppelte Quellen entfallen schon vor der Prüfung.
 */
export function planCodexMcp(input: CodexMcpInput): CodexMcpPlan {
  const plan: CodexMcpPlan = { passed: [], own: [], skipped: [], args: [], env: {}, secretValues: [] };
  const globalReason = input.settings.enabled === false ? "disabled" : input.sandbox !== "full" ? "sandbox"
    : !input.own.readable ? "codex_config_unreadable" : undefined;
  if (!globalReason) plan.own = [...input.own.names].map(safeMcpName);
  const seen = new Set<string>();
  const env = new Map<string, string>();
  const headerVars = new Set<string>();
  const ordered = [...input.sources].sort((a, b) => SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
  for (const entry of ordered) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    const skip = (reason: CodexMcpSkipReason) => plan.skipped.push({ name: safeMcpName(entry.name), source: entry.source, reason });
    if (globalReason) { skip(globalReason); continue; }
    if (input.own.names.has(entry.name)) continue;
    if (input.settings.skip?.includes(entry.name)) { skip("user_skip"); continue; }
    if (entry.source === "claude-settings") { skip("unsupported_source"); continue; }
    if (!CODEX_MCP_NAME_PATTERN.test(entry.name)) { skip("invalid_name"); continue; }
    const fromClaude = entry.source === "claude-project" || entry.source === "mcp-json" || entry.source === "claude-user";
    if (fromClaude && entry.claudeDisabled) { skip("claude_disabled"); continue; }
    if (entry.source === "mcp-json" && !entry.mcpJsonApproved) { skip("not_approved"); continue; }
    const candidate = planServer(entry, input);
    if (typeof candidate === "string") { skip(candidate); continue; }
    if (candidate.headerVars.some(name => headerVars.has(name)) || [...candidate.env].some(([name, value]) =>
      (Object.hasOwn(input.baseEnv, name) && input.baseEnv[name] !== value) || (env.has(name) && env.get(name) !== value))) {
      skip("env_conflict"); continue;
    }
    plan.passed.push({ name: entry.name, kind: candidate.kind, source: entry.source });
    plan.args.push(...candidate.args);
    for (const [name, value] of candidate.env) env.set(name, value);
    for (const name of candidate.headerVars) headerVars.add(name);
  }
  plan.env = Object.fromEntries(env);
  plan.secretValues = Object.values(plan.env);
  return plan;
}

/** Nur die beiden belegten Kopfzeilen-Verweise öffnen die Ausnahme für TYBO_MCP_. */
function verifiedHeaderVars(plan: CodexMcpPlan): Set<string> {
  const http = new Set(plan.passed.filter(s => s.kind === "http" && CODEX_MCP_NAME_PATTERN.test(s.name)).map(s => s.name));
  const assignments = new Map<string, string>();
  for (let i = 0; i < plan.args.length; i++) {
    if (plan.args[i] !== "-c") continue;
    const assignment = plan.args[++i];
    if (typeof assignment !== "string") continue;
    const equal = assignment.indexOf("=");
    if (equal < 0) continue;
    assignments.set(assignment.slice(0, equal), assignment.slice(equal + 1));
  }
  const allowed = new Set<string>();
  for (const [key, text] of assignments) {
    const match = /^mcp_servers\.([A-Za-z0-9_-]{1,64})\.(bearer_token_env_var|env_http_headers)(?![\s\S])/.exec(key);
    if (!match || !http.has(match[1])) continue;
    try {
      const parsed = record(Bun.TOML.parse(`v = ${text}`))!;
      if (Object.keys(parsed).length !== 1) continue;
      const value = parsed.v;
      if (match[2] === "bearer_token_env_var") {
        if (value === codexMcpHeaderVar(match[1])) allowed.add(value);
      } else {
        for (const [header, variable] of Object.entries(record(value) ?? {})) {
          if (header && !CONTROL.test(header) && variable === codexMcpHeaderVar(match[1], header)) allowed.add(variable);
        }
      }
    } catch {
      // Ungültiges TOML belegt keine Ausnahme. Niemals den Parserfehler weiterreichen.
    }
  }
  return allowed;
}

/** Zweite Grenze gegen handgebaute Pläne; Fehlermeldungen enthalten keinerlei Quelldaten. */
export function applyCodexMcpEnv(baseEnv: Record<string, string>, plan: CodexMcpPlan): Record<string, string> {
  const allowed = verifiedHeaderVars(plan);
  for (const [name, value] of Object.entries(plan.env)) {
    if (!ENV_NAME.test(name) || CONTROL.test(name) || typeof value !== "string" || CONTROL.test(value)
      || isProtectedSubprocessVar(name, "codex")
      || (Object.hasOwn(baseEnv, name) && baseEnv[name] !== value)
      || (name.startsWith("TYBO_MCP_") && !allowed.has(name))) {
      throw new Error("Ungültige MCP-Umgebung");
    }
  }
  return { ...baseEnv, ...plan.env };
}

export interface CurrentInputs {
  parentEnv: () => Env;
  projectRoot: () => string;
  settings: () => CodexMcpSettings;
  lookup: CodexMcpInput["lookup"];
  secrets: (root: string, env: Env) => readonly string[];
}
const defaultInputs: CurrentInputs = {
  parentEnv: () => process.env,
  projectRoot: () => process.env.GO_PROJECT_ROOT || process.cwd(),
  settings: () => getSettings().engine?.codex?.mcp ?? {},
  lookup: optionalCredential,
  secrets: projectSecrets,
};
let currentInputs = defaultInputs;

/** Nur für Tests: echte Einstellungen, Credential-Cache und .env vollständig umgehen. */
export function setCodexMcpInputsForTests(inputs: CurrentInputs | null): void {
  currentInputs = inputs ?? defaultInputs;
}

/** Laufordner und tybos Projektordner bleiben getrennt; die Rechte kommen stets vom Aufrufer. */
export function currentCodexMcpPlan(input: { cwd: string; baseEnv: Record<string, string>; sandbox: CodexSandbox; context?: CurrentInputs }, readers: CodexMcpReaders = {}): CodexMcpPlan {
  // Der Prüfbericht läuft aus beliebigen Ordnern ohne geladene .env. Seine
  // Eingaben gelten nur hier, ohne globale Umgebung oder Einstellungen umzusetzen.
  const inputs = input.context ?? currentInputs;
  const parentEnv = inputs.parentEnv();
  const root = inputs.projectRoot();
  const home = input.baseEnv.HOME ?? parentEnv.HOME ?? "";
  return planCodexMcp({
    ...input,
    sources: readCodexMcpSources({ projectFile: join(root, "config", "mcp-servers.json"),
      extraFile: parentEnv.MCP_CONFIG_PATH || undefined, cwd: input.cwd, home }, readers),
    own: readCodexOwnMcpNames(codexHomeDir(parentEnv, home), input.cwd, readers.text),
    settings: inputs.settings(), parentEnv, lookup: inputs.lookup,
    knownSecrets: inputs.secrets(root, parentEnv),
  });
}
