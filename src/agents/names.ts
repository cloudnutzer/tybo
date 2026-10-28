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

/**
 * Aliasse an einem Ort (Issue #304). Drei Stellen loesen Namen auf, jede mit
 * ihrer eigenen Tabelle; die Unterschiede sind gewollt und in
 * tests/agent-alias-users.test.ts festgehalten. Gemeinsam ist dieser Kern.
 */
const SHARED_ALIASES = {
  researcher: "research",
  cmo: "content",
  cfo: "finance",
  ceo: "strategy",
  dev: "cto",
  ops: "coo",
  operations: "coo",
} satisfies Record<string, AgentName>;

/** Katalog (resolveAgentName, canonicalAgentName); zugleich reservierte Kennungen */
export const AGENT_ALIASES: Record<string, AgentName> = {
  ...SHARED_ALIASES,
  "devils-advocate": "critic",
  development: "cto",
  orchestrator: "general",
};

/** Bot-Registry: Absender-Bot eines Agenten; orchestrator fehlt und landet beim Haupt-Bot */
export const BOT_REGISTRY_ALIASES: Record<string, AgentName> = {
  ...SHARED_ALIASES,
  "devils-advocate": "critic",
  development: "cto",
};

/** Befehl /agent (src/agents/command-agent.ts): zusaetzlich outreach und tech */
export const COMMAND_ALIASES: Record<string, AgentName> = {
  ...SHARED_ALIASES,
  outreach: "content",
  tech: "cto",
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
