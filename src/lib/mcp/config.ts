/**
 * Welche MCP-Server tybo für die Fallback-Modelle startet (Issue #332).
 *
 * Drei Quellen, zusammengeführt; bei gleichem Servernamen gilt die frühere:
 * 1. config/mcp-servers.json im Projekt (Schlüssel "servers"), jeder Befehl
 *    erlaubt, dazu "type": "http" für entfernte Server
 * 2. die Datei aus MCP_CONFIG_PATH ("servers" oder "mcpServers")
 * 3. ~/.claude.json ("mcpServers"): lokale Server nur, wenn ihr Befehl bun
 *    enthält (npx-Server hinterließen verwaiste Prozesse), http- und
 *    sse-Einträge mit URL als entfernte Server
 *
 * Platzhalter ${NAME} in url, headers und env löst expandPlaceholders über
 * die Credential Registry auf; Unbekanntes bleibt stehen, Werte werden nie
 * geloggt.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { optionalCredential } from "../credentials";

/** Lokaler Server: tybo startet ihn als Kindprozess */
export interface LocalServerSpec {
  kind: "stdio";
  command: string;
  args: string[];
  env: Record<string, string>;
}

/** Entfernter Server über Streamable HTTP, kein Prozess auf diesem Rechner */
export interface RemoteServerSpec {
  kind: "http";
  url: string;
  headers: Record<string, string>;
}

export type ServerSpec = LocalServerSpec | RemoteServerSpec;

/** Server in Startreihenfolge, Name zu Beschreibung */
export type ServerSpecs = Map<string, ServerSpec>;

export interface SpecSources {
  /** config/mcp-servers.json */
  projectFile: string;
  /** MCP_CONFIG_PATH, leer: keine */
  extraFile?: string;
  /** ~/.claude.json */
  claudeFile: string;
}

/** Ablageorte für den laufenden Prozess */
export function defaultSpecSources(): SpecSources {
  return {
    projectFile: join(process.cwd(), "config", "mcp-servers.json"),
    extraFile: process.env.MCP_CONFIG_PATH || undefined,
    claudeFile: join(process.env.HOME || "/root", ".claude.json"),
  };
}

type Entry = Record<string, unknown>;

function asRecord(value: unknown): Entry | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Entry) : undefined;
}

function stringMap(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, v] of Object.entries(asRecord(value) ?? {})) if (typeof v === "string") out[key] = v;
  return out;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Eintrag einer tybo-Konfiguration; ohne Befehl bzw. URL kein Server */
function explicitSpec(raw: Entry): ServerSpec | undefined {
  if (raw.type === "http") {
    return typeof raw.url === "string" && raw.url ? { kind: "http", url: raw.url, headers: stringMap(raw.headers) } : undefined;
  }
  if (typeof raw.command !== "string" || !raw.command) return undefined;
  return { kind: "stdio", command: raw.command, args: stringList(raw.args), env: stringMap(raw.env) };
}

/** Eintrag aus ~/.claude.json: lokale Server nur mit bun, http und sse als entfernte */
function discoveredSpec(raw: Entry): ServerSpec | undefined {
  if (raw.type === "http" || raw.type === "sse") {
    return typeof raw.url === "string" && raw.url ? { kind: "http", url: raw.url, headers: stringMap(raw.headers) } : undefined;
  }
  if (typeof raw.command !== "string" || !raw.command.includes("bun")) return undefined;
  return { kind: "stdio", command: raw.command, args: stringList(raw.args), env: stringMap(raw.env) };
}

/** Liest eine JSON-Datei; fehlt sie, undefined, ist sie kaputt, eine Logzeile */
function readJson(path: string | undefined, quiet = false): Entry | undefined {
  if (!path || !existsSync(path)) return undefined;
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf-8")));
  } catch (err) {
    if (!quiet) console.error(`[MCP] Konfiguration ${path} nicht lesbar: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/** Alle Server aus den drei Quellen, frühere Quelle gewinnt */
export function loadServerSpecs(sources: SpecSources = defaultSpecSources(), options: {
  quiet?: boolean;
  readJson?: (path: string | undefined) => Entry | undefined;
} = {}): ServerSpecs {
  const read = options.readJson ?? (path => readJson(path, options.quiet));
  const specs: ServerSpecs = new Map();
  const take = (path: string, entries: Entry | undefined, pick: (raw: Entry) => ServerSpec | undefined) => {
    let added = 0;
    for (const [name, value] of Object.entries(entries ?? {})) {
      const raw = asRecord(value);
      const spec = raw && pick(raw);
      if (!spec || specs.has(name)) continue;
      specs.set(name, spec);
      added++;
    }
    if (added > 0 && !options.quiet) console.log(`[MCP] ${path}: ${added} Server`);
  };

  const project = read(sources.projectFile);
  take(sources.projectFile, asRecord(project?.servers), explicitSpec);
  if (sources.extraFile) {
    const extra = read(sources.extraFile);
    take(sources.extraFile, asRecord(extra?.servers) ?? asRecord(extra?.mcpServers), explicitSpec);
  }
  const claude = read(sources.claudeFile);
  take(sources.claudeFile, asRecord(claude?.mcpServers), discoveredSpec);
  return specs;
}

/** Ersetzt ${NAME} im Text, auch mitten drin ("Bearer ${TOKEN}") */
export function expandPlaceholders(
  text: string,
  lookup: (name: string) => string | undefined = optionalCredential
): string {
  return text.replace(/\$\{([^}]+)\}/g, (whole, name: string) => lookup(name) || whole);
}

/** Beschreibung mit aufgelösten Platzhaltern, bereit für die Transport-Fabrik */
export function resolveSpec(
  spec: ServerSpec,
  lookup: (name: string) => string | undefined = optionalCredential
): ServerSpec {
  const each = (map: Record<string, string>) =>
    Object.fromEntries(Object.entries(map).map(([k, v]) => [k, expandPlaceholders(v, lookup)]));
  if (spec.kind === "http") return { kind: "http", url: expandPlaceholders(spec.url, lookup), headers: each(spec.headers) };
  return { ...spec, args: [...spec.args], env: each(spec.env) };
}
