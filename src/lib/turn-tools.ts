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
 * Liste der fremden Werkzeuge steht nur hier, die Prüfung von Bash-Befehlen
 * in bash-network.ts.
 *
 * Seit Issue #525 zählen nur noch Inhalte aus dem Netz: Dateien auf diesem
 * Rechner sind nie fremd, auch außerhalb des Projekts, und gh gegen ein Repo
 * eines eigenen Kontos (TYBO_TRUSTED_GITHUB_OWNERS) ebenfalls nicht.
 * Hochgeladene Dateien und Fotos stehen nicht in der Werkzeugliste, sie
 * meldet der Kanal als foreignInput an das Tor (intent-gate.ts).
 */

import { bashNetworkReason, trustedGithubOwners } from "./bash-network";

export interface ToolUse {
  name: string;
  /** Dateipfad bzw. Suchpfad lesender Datei-Werkzeuge (Read, Grep, Glob, ...) */
  path?: string;
  /** Befehl eines Bash-Aufrufs, gekürzt auf MAX_COMMAND_CHARS */
  command?: string;
  /**
   * Nur bei Befehlen ab MAX_COMMAND_CHARS Zeichen: Einstufung des
   * vollständigen Befehls bei der Erfassung (null: kein Netzabruf). So
   * verschwindet ein fremder Teil hinter der Kürzung nicht. Ein Befehl an der
   * Kürzungsgrenze ohne diese Angabe (ältere Einträge) oder mit beschädigter
   * Angabe gilt als fremd.
   */
  commandCut?: { reason: string | null };
  /** Werkzeug, das außerhalb von tybo ausgeführt wurde (Sprach-Brücke: ElevenLabs) */
  external?: boolean;
}

export interface TurnTools {
  uses: ToolUse[];
  /** Arbeitsverzeichnis des Aufrufs; relative Pfade gelten von hier aus */
  cwd?: string;
}

export const MAX_COMMAND_CHARS = 2000;

/** Grund für einen gekürzten Befehl ohne bekannte Einstufung */
const CUT_REASON = "Bash mit gekürztem Befehl";

/**
 * ToolUse eines Bash-Aufrufs für alle Motoren. Ab MAX_COMMAND_CHARS Zeichen
 * wird der Befehl vorher vollständig eingestuft und dann gekürzt; auch genau
 * MAX_COMMAND_CHARS Zeichen bekommen die Einstufung, damit ein Eintrag an der
 * Grenze ohne sie immer als womöglich gekürzt gilt.
 */
export function bashToolUse(command: string | undefined, githubOwners: readonly string[] = trustedGithubOwners()): ToolUse {
  if (!command) return { name: "Bash" };
  if (command.length < MAX_COMMAND_CHARS) return { name: "Bash", command };
  return { name: "Bash", command: command.slice(0, MAX_COMMAND_CHARS), commandCut: { reason: bashNetworkReason(command, githubOwners) } };
}

/** ToolUse aus einem tool_use-Block der CLI oder der Anthropic API; null ohne Namen. */
export function toolUseFromBlock(block: any): ToolUse | null {
  if (!block || block.type !== "tool_use" || typeof block.name !== "string" || !block.name) return null;
  const input = block.input && typeof block.input === "object" ? block.input : {};
  const command = typeof input.command === "string" ? bashToolUse(input.command) : undefined;
  const use: ToolUse = { name: block.name };
  const path = [input.file_path, input.notebook_path, input.path].find(v => typeof v === "string" && v);
  if (path) use.path = path;
  if (command?.command !== undefined) use.command = command.command;
  if (command?.commandCut) use.commandCut = command.commandCut;
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

/** Warum dieses Werkzeug fremde Inhalte gelesen hat; null, wenn nicht. */
export function foreignReason(use: ToolUse, githubOwners: readonly string[] = trustedGithubOwners()): string | null {
  const name = use.name;
  if (use.external) return HARMLESS_EXTERNAL_TOOLS.has(name) ? null : `${name} (externes Werkzeug)`;
  if (WEB_TOOLS.has(name)) return name;
  if (MCP_RESOURCE_TOOLS.has(name)) return `${name} (MCP-Ressource)`;
  if (SUBAGENT_TOOLS.has(name)) return `${name} (Unter-Agent)`;
  if (name.startsWith("mcp__")) {
    const label = READING_MCP_PATTERNS.find(([pattern]) => pattern.test(name))?.[1] ?? "MCP";
    return `${name} (${label})`;
  }
  if (name === "Bash" && use.commandCut !== undefined) {
    // Gekürzter Befehl: es zählt die Einstufung des vollständigen Befehls bei der Erfassung
    const cut = use.commandCut;
    if (cut && typeof cut === "object" && (cut.reason === null || typeof cut.reason === "string")) return cut.reason;
    return CUT_REASON;
  }
  if (name === "Bash" && use.command) {
    const reason = bashNetworkReason(use.command, githubOwners);
    // An der Kürzungsgrenze ohne Einstufung (ältere Einträge): der Rest des Befehls ist unbekannt
    if (!reason && use.command.length >= MAX_COMMAND_CHARS) return CUT_REASON;
    return reason;
  }
  return null;
}

/**
 * Einstufung eines Turns: unknown ohne Werkzeugliste, foreign sobald ein
 * Werkzeug fremde Inhalte gelesen hat, sonst own. Bash zählt nur mit
 * Netzabruf (bash-network.ts), lesende Datei-Werkzeuge nie. projectRoot
 * bleibt für die Aufrufer im Tor; die Einstufung hängt seit #525 nicht mehr
 * vom Ort einer Datei ab.
 */
export function classifyTurnTools(
  tools: TurnTools | undefined,
  _projectRoot: string,
  options: { githubOwners?: readonly string[] } = {}
): TurnToolsVerdict {
  if (!tools) return { status: "unknown" };
  const owners = options.githubOwners ?? trustedGithubOwners();
  const reasons: string[] = [];
  for (const use of tools.uses) {
    const reason = foreignReason(use, owners);
    if (reason && !reasons.includes(reason)) reasons.push(reason);
  }
  return reasons.length > 0 ? { status: "foreign", reasons } : { status: "own" };
}
