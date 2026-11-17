/**
 * Gemeinsame Typen der Agenten (Issue #358).
 *
 * Ein Agent ist eine Rolle mit eigenem System-Prompt und eigenem Modell. Die
 * mitgelieferten stehen in src/agents/<name>.ts, eigene in config/agents.json
 * (Katalog, src/agents/catalog.ts).
 */

/** Was ein Claude-Aufruf über einen Agenten wissen muss */
export interface AgentConfig {
  /** Anzeigename, etwa "Research Agent (Deep Research)" */
  name: string;
  /** Vollständiger System-Prompt samt Basis-Teil (BASE_CONTEXT) */
  systemPrompt: string;
  /** Modell im Code; config/settings.json geht an den Aufrufstellen vor */
  model: string;
  /** Denkstufe (low, medium, high, xhigh, max); fehlt sie, entscheidet der Motor */
  effort?: string;
  /** Erlaubte Werkzeuge; fehlt die Liste, darf der Agent alle Werkzeuge, MCP-Server und Skills nutzen */
  allowedTools?: string[];
  /** Feste Topic-Nummer aus früheren Ständen; die Zuordnung steht heute in config/topics.json */
  topicId?: number;
  /** Denkweise, etwa "ReAct" oder "CoT" (nur Anzeige und Tests) */
  reasoning?: string;
  /** Kurze Beschreibung des Tons (nur Anzeige) */
  personality?: string;
}
