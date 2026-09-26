/**
 * Agentenliste der WebUI (Issue #21): welche Agenten ein neues Web-Gespräch
 * bekommen kann. Die echte Liste kommt aus dem Agenten-Katalog
 * (src/agents/catalog.ts) und wird in src/bot.ts als Funktion übergeben; diese Datei importiert nichts aus src/agents oder
 * src/lib, damit der Web-Server und web:dev ohne sie auskommen.
 */

export interface AgentInfo {
  name: string;
  label: string;
}

/** Gleiche Form wie in POST /api/conversations geprüft */
export const AGENT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
export const DEFAULT_AGENT = "general";

/**
 * Ersatzliste, wenn keine übergeben wird (web:dev, Demo, Tests). Muss zu
 * AGENTS in src/agents/index.ts passen; tests/web-agents.test.ts prüft das.
 */
export const FALLBACK_AGENT_NAMES = ["general", "research", "content", "finance", "strategy", "critic", "cto", "coo"];

/** Abkürzungen, die groß geschrieben werden */
const ACRONYMS: Record<string, string> = { cto: "CTO", coo: "COO", cfo: "CFO", ceo: "CEO", cmo: "CMO" };

/** Anzeigename, z.B. "research" wird "Research", "cto" wird "CTO". */
export function agentLabel(name: string): string {
  if (ACRONYMS[name]) return ACRONYMS[name];
  return name
    .split(/[-_]/)
    .filter(Boolean)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/**
 * Liste für GET /api/agents: gültige Namen, ohne Doppelte, General zuerst.
 * Namen ohne eigenen Anzeigenamen bekommen agentLabel().
 */
export function agentList(entries: Iterable<string | { name: string; label?: string }>): AgentInfo[] {
  const byName = new Map<string, AgentInfo>();
  for (const entry of entries) {
    const name = typeof entry === "string" ? entry : entry.name;
    if (!AGENT_NAME_PATTERN.test(name) || byName.has(name)) continue;
    const label = typeof entry === "string" ? "" : entry.label?.trim() ?? "";
    byName.set(name, { name, label: label || agentLabel(name) });
  }
  const list = [...byName.values()];
  list.sort((a, b) => Number(b.name === DEFAULT_AGENT) - Number(a.name === DEFAULT_AGENT));
  return list;
}
