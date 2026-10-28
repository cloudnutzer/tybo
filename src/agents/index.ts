/**
 * Einstieg in die Agenten (Issue #358).
 *
 * Jedes Topic einer Telegram-Forumgruppe und jedes Gespräch im Browser hat
 * einen Agenten; ohne Zuordnung antwortet General. Zugeordnet wird in
 * config/topics.json (/topics), welche Agenten es gibt, sagt der Katalog
 * (listAgents() in ./catalog, mit eigenen und ohne gelöschte).
 */

export { getAgentByTopicId, getAgentConfig, getAgentConfigOrGeneral, getTopicMappingForChat, getUserProfile } from "./base";

import { BUILTIN_AGENTS } from "./catalog";

/** Mitgelieferte Agenten mit Kurzbeschreibung (Kopie, Änderungen wirken nicht auf den Katalog) */
export const AGENTS: Record<string, string> = { ...BUILTIN_AGENTS };
