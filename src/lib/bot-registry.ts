/**
 * Alter Pfad der Agenten-Identitäten, nur noch Weiterleitung (Issue #330).
 * Das Modul steht in src/channels/telegram/identities.ts. Hier bleiben die
 * alten Namen für src/vps-gateway.ts (laut SPEC.md nicht zu ändern) und
 * src/lib/phone/task-turn.ts.
 */

export {
  AgentIdentities as BotRegistry,
  AGENT_TOKEN_MAP,
  type AgentIdentitiesOptions as BotRegistryOptions,
} from "../channels/telegram/identities";
