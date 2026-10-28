/**
 * Vorlage für einen eigenen Agenten im Code (Issue #360).
 *
 * Meist reicht ein eigener Agent ohne Code: WebUI, Einstellungen, Reiter
 * Agenten, oder der Abschnitt custom in config/agents.json (Katalog, Issue #49).
 * Diese Datei ist für den Fall, dass ein Agent fest zum Code gehören soll. Sie
 * ist nicht registriert und wird nirgends geladen.
 *
 * So wird daraus ein Agent:
 * 1. Datei kopieren, etwa nach src/agents/travel.ts, und Namen, Denkweise,
 *    Ton und Prompt-Abschnitte anpassen.
 * 2. Die Kennung in AGENT_NAMES (src/agents/names.ts) eintragen.
 * 3. In src/agents/catalog.ts eine Kurzbeschreibung in BUILTIN_AGENTS und
 *    einen Lader in BUILTIN_LOADERS ergänzen, für das Board auch einen Platz
 *    in BUILTIN_BOARD_ORDER.
 * 4. Optional einem Telegram-Topic zuordnen (config/topics.json, /topics).
 *
 * Prompts sind englisch, geantwortet wird in der Sprache des Nutzers. Der
 * Basis-Teil (BASE_CONTEXT) steht genau einmal vorn. Wen der Agent fragen
 * darf, hängt der Prompt-Builder aus dem Katalog an; eine feste Liste anderer
 * Agenten gehört nicht in den Prompt.
 *
 * Denkweisen der mitgelieferten Agenten (Feld reasoning, nur Anzeige):
 * ReAct (suchen und prüfen in Runden), CoT (Schritt für Schritt rechnen),
 * ToT (mehrere Wege vergleichen), RoT (Entwurf, Kritik, Überarbeitung),
 * devils-advocate (Gegenposition, Pre-Mortem), adaptive (je nach Anfrage).
 */

import type { AgentConfig } from "./types";
import { BASE_CONTEXT } from "./prompt-parts";

const role = `## ROLE: EXAMPLE AGENT
State in two or three sentences what this agent is for and which requests
it takes. List typical requests:
- First kind of request
- Second kind of request`;

const method = `## HOW YOU WORK
Describe the steps this agent follows, for example:
1. Find out what exactly is asked.
2. Gather what is needed.
3. Answer and say how certain you are.`;

const output = `## SHAPE OF THE ANSWER
Describe how a short and a long answer should look.`;

const limits = `## LIMITS
- Add the rules this agent must never break.
- Respond in the language the user uses.`;

const example: AgentConfig = {
  name: "Example Agent",
  model: "claude-opus-5-5",
  reasoning: "CoT",
  // allowedTools: ["Read", "WebSearch"], // nur diese Werkzeuge; ohne Liste darf der Agent alles
  personality: "short description of the tone",
  systemPrompt: [BASE_CONTEXT, role, method, output, limits].join("\n\n") + "\n",
};

export default example;
