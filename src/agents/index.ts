/**
 * Go - Multi-Agent System
 *
 * Agent configuration exports and utilities.
 *
 * Architecture:
 * - Each Telegram forum topic maps to a specialized agent
 * - Agents have distinct system prompts, reasoning styles, and tool access
 * - General topic (no thread_id) uses the default Orchestrator agent
 *
 * Usage:
 * 1. Create a Telegram group with forum topics enabled
 * 2. Add your bot as admin
 * 3. Map topic IDs to agent names in config/topics.json (/topics)
 * 4. Messages in each topic will use that agent's configuration
 */

export type { AgentConfig, InvocationContext } from "./base";
export {
  BASE_CONTEXT,
  getAgentConfig,
  getAgentConfigOrGeneral,
  getAgentByTopicId,
  getTopicMappingForChat,
  topicAgentMap,
  AGENT_INVOCATION_MAP,
  canInvokeAgent,
  formatCrossAgentContext,
  canContinueInvocation,
  getUserProfile,
} from "./base";

import { BUILTIN_AGENTS } from "./catalog";

// Agent configurations
export { default as researchAgent } from "./research";
export { default as contentAgent } from "./content";
export { default as financeAgent } from "./finance";
export { default as strategyAgent } from "./strategy";
export { default as generalAgent } from "./general";
export { default as criticAgent } from "./critic";
export { default as ctoAgent } from "./cto";
export { default as cooAgent } from "./coo";

// Quick reference: mitgelieferte Agenten. Welche aktiv sind (eigene dazu,
// geloeschte weg), liefert der Katalog: listAgents() in ./catalog
export const AGENTS: Record<string, string> = { ...BUILTIN_AGENTS };
