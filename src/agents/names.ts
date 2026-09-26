/**
 * Mitgelieferte Agenten-Namen und ihre Aliasse, ohne weitere Abhaengigkeiten.
 *
 * Welche Agenten aktiv sind (eigene dazu, geloeschte weg), weiss der Katalog
 * (src/agents/catalog.ts, Issue #49). Die Aliasse gelten dort weiter; ein Test
 * prueft, dass getAgentConfig sie gleich aufloest.
 */

export const AGENT_NAMES = [
  "general",
  "research",
  "content",
  "finance",
  "strategy",
  "critic",
  "cto",
  "coo",
] as const;

export type AgentName = (typeof AGENT_NAMES)[number];

export const AGENT_ALIASES: Record<string, AgentName> = {
  researcher: "research",
  cmo: "content",
  cfo: "finance",
  ceo: "strategy",
  "devils-advocate": "critic",
  dev: "cto",
  development: "cto",
  ops: "coo",
  operations: "coo",
  orchestrator: "general",
};

/**
 * Kennung eines Agenten (Issue #49): Schluessel in config/agents.json,
 * config/settings.json und config/topics.json.
 */
export const AGENT_ID_PATTERN = /^[a-z][a-z0-9-]{1,29}$/;

/** Nur mitgelieferte Agenten: unbekannte Namen landen bei "general". Eigene Agenten loest der Katalog auf. */
export function canonicalAgentName(agentName: string): AgentName {
  const name = agentName.toLowerCase();
  if ((AGENT_NAMES as readonly string[]).includes(name)) return name as AgentName;
  return AGENT_ALIASES[name] ?? "general";
}
