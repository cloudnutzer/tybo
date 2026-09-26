/**
 * Werkzeuge eines Turns und ihre Einstufung (Issue #53, Entscheidung 0008
 * Punkt 2).
 *
 * Die Claude-CLI meldet jeden Werkzeugaufruf als tool_use-Block (stream-json
 * bzw. json mit --verbose). Daraus entsteht pro Turn eine TurnTools-Liste.
 * Fehlt sie ganz (undefined), sind die Werkzeuge unbekannt, etwa beim
 * Rückfall-Modell; das ist etwas anderes als eine bekannte leere Liste.
 *
 * classifyTurnTools entscheidet, ob ein Turn fremde Inhalte gelesen hat. Die
 * Liste der fremden Werkzeuge steht nur hier.
 */

import { existsSync, realpathSync } from "fs";
import { dirname, isAbsolute, relative, resolve, sep } from "path";

export interface ToolUse {
  name: string;
  /** Dateipfad bzw. Suchpfad lesender Datei-Werkzeuge (Read, Grep, Glob, ...) */
  path?: string;
  /** Befehl eines Bash-Aufrufs, gekürzt */
  command?: string;
  /** Werkzeug, das außerhalb von tybo ausgeführt wurde (Sprach-Brücke: ElevenLabs) */
  external?: boolean;
}

export interface TurnTools {
  uses: ToolUse[];
  /** Arbeitsverzeichnis des Aufrufs; relative Pfade gelten von hier aus */
  cwd?: string;
}

const MAX_COMMAND_CHARS = 2000;

/** ToolUse aus einem tool_use-Block der CLI oder der Anthropic API; null ohne Namen. */
export function toolUseFromBlock(block: any): ToolUse | null {
  if (!block || block.type !== "tool_use" || typeof block.name !== "string" || !block.name) return null;
  const input = block.input && typeof block.input === "object" ? block.input : {};
  const use: ToolUse = { name: block.name };
  const path = [input.file_path, input.notebook_path, input.path].find(v => typeof v === "string" && v);
  if (path) use.path = path;
  if (typeof input.command === "string") use.command = input.command.slice(0, MAX_COMMAND_CHARS);
  return use;
}

/** Alle tool_use-Blöcke eines assistant-Ereignisses der CLI. */
export function toolUsesFromEvent(event: any): ToolUse[] {
  if (event?.type !== "assistant" || !Array.isArray(event.message?.content)) return [];
  const out: ToolUse[] = [];
  for (const block of event.message.content) {
    const use = toolUseFromBlock(block);
    if (use) out.push(use);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Einstufung
// ---------------------------------------------------------------------------

/** Holen Inhalte aus dem Netz */
const WEB_TOOLS = new Set(["WebFetch", "WebSearch"]);

/** Lesen MCP-Ressourcen (Inhalte eines MCP-Servers) */
const MCP_RESOURCE_TOOLS = new Set(["ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool"]);

/** Unter-Agenten: ihre eigenen Werkzeuge sind im Ergebnis nicht sicher sichtbar */
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);

/** Lesen Dateien; fremd, wenn der Pfad außerhalb des tybo-Projekts liegt */
const FILE_READ_TOOLS = new Set(["Read", "Grep", "Glob", "NotebookRead", "LS"]);

/**
 * Lesende MCP-Server, nach Namensbestandteil (mcp__<server>__<werkzeug>):
 * Mail, Kalender, Ablagen, Web-Scraper, Browser, Wissensdienste. Nur
 * Beschriftung im Log; jedes andere MCP-Werkzeug gilt ebenfalls als fremd,
 * weil sein Ergebnis von außerhalb kommt.
 */
const READING_MCP_PATTERNS: [RegExp, string][] = [
  [/gmail|mail|outlook|imap/i, "Mail"],
  [/calendar|kalender/i, "Kalender"],
  [/drive|dropbox|onedrive|docs/i, "Ablage"],
  [/firecrawl|apify|scrape|crawl|fetch|search|tavily|exa|brave|perplexity/i, "Web"],
  [/browser|playwright|puppeteer|chrome|computer/i, "Browser"],
  [/notion|slack|linear|github|jira|confluence|discord|telegram|whatsapp/i, "Dienst"],
];

/**
 * Bash-Befehle, die Inhalte aus dem Netz holen. Bash selbst gilt nicht als
 * fremd (tybo arbeitet ständig damit), ein Netzabruf schon.
 */
const NETWORK_COMMAND = /\b(curl|wget|lynx|w3m|yt-dlp)\b|\bgh\s+(api|issue|pr|release)\b|https?:\/\//i;

/** ElevenLabs-Systemwerkzeuge der Sprach-Brücke: steuern das Gespräch, liefern keine Inhalte */
const HARMLESS_EXTERNAL_TOOLS = new Set([
  "end_call",
  "skip_turn",
  "language_detection",
  "transfer_to_agent",
  "transfer_to_number",
  "play_keypad_touch_tone",
  "voicemail_detection",
]);

export type TurnToolsVerdict =
  | { status: "unknown" }
  | { status: "own" }
  | { status: "foreign"; reasons: string[] };

/** Echter Pfad; für noch nicht vorhandene Pfade der des nächsten vorhandenen Elternordners. */
function realPath(path: string): string {
  let current = path;
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    rest.unshift(current.slice(parent.length).replace(/^[\\/]+/, ""));
    current = parent;
  }
  try {
    return resolve(realpathSync(current), ...rest);
  } catch {
    return path;
  }
}

/** Liegt path (relativ zu cwd) nach Auflösung von Symlinks im Projekt? */
export function isInsideProject(path: string, cwd: string, projectRoot: string): boolean {
  const expanded = path.startsWith("~/") && process.env.HOME ? resolve(process.env.HOME, path.slice(2)) : path;
  const absolute = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
  const target = realPath(absolute);
  const root = realPath(resolve(projectRoot));
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel) && !rel.startsWith(`..${sep}`));
}

/** Warum dieses Werkzeug fremde Inhalte gelesen hat; null, wenn nicht. */
export function foreignReason(use: ToolUse, cwd: string, projectRoot: string): string | null {
  const name = use.name;
  if (use.external) return HARMLESS_EXTERNAL_TOOLS.has(name) ? null : `${name} (externes Werkzeug)`;
  if (WEB_TOOLS.has(name)) return name;
  if (MCP_RESOURCE_TOOLS.has(name)) return `${name} (MCP-Ressource)`;
  if (SUBAGENT_TOOLS.has(name)) return `${name} (Unter-Agent)`;
  if (name.startsWith("mcp__")) {
    const label = READING_MCP_PATTERNS.find(([pattern]) => pattern.test(name))?.[1] ?? "MCP";
    return `${name} (${label})`;
  }
  if (FILE_READ_TOOLS.has(name)) {
    // Ohne Pfad suchen Grep/Glob im Arbeitsverzeichnis
    const path = use.path ?? cwd;
    return isInsideProject(path, cwd, projectRoot) ? null : `${name} außerhalb des Projekts`;
  }
  if (name === "Bash" && use.command && NETWORK_COMMAND.test(use.command)) return "Bash mit Netzabruf";
  return null;
}

/**
 * Einstufung eines Turns: unknown ohne Werkzeugliste, foreign sobald ein
 * Werkzeug fremde Inhalte gelesen hat, sonst own.
 */
export function classifyTurnTools(tools: TurnTools | undefined, projectRoot: string): TurnToolsVerdict {
  if (!tools) return { status: "unknown" };
  const cwd = tools.cwd ?? projectRoot;
  const reasons: string[] = [];
  for (const use of tools.uses) {
    const reason = foreignReason(use, cwd, projectRoot);
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  }
  return reasons.length > 0 ? { status: "foreign", reasons } : { status: "own" };
}
