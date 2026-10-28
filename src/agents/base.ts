/**
 * Agenten-Basis (Issue #358): Topic-Zuordnung, Agenten-Konfiguration aus dem
 * Katalog sowie Modell und Effort je Agent.
 *
 * Typen stehen in ./types, das Nutzerprofil in ./profile, die Prompt-Bausteine
 * (BASE_CONTEXT, Kanal- und Konsultationsregeln, Tags, Zeitformat) in
 * ./prompt-parts. Diese Datei reicht sie für bestehende Aufrufer weiter.
 */
import { readFileSync, statSync } from "fs";
import { join } from "path";
import { getSettings, type Settings } from "../lib/settings";
import { DEFAULT_CLAUDE_MODEL } from "../lib/default-model";
import { getCatalogAgentConfig, resolveAgentName, type AgentConfigOptions } from "./catalog";
import type { AgentConfig } from "./types";

export type { AgentConfig } from "./types";
export { getUserProfile } from "./profile";
export {
  BASE_CONTEXT,
  DEFAULT_LONG_TASK_LIMITS,
  formatLongTaskRules,
  LONG_TASK_JOB_THRESHOLD_MIN,
  LONG_TASK_MAX_WAIT_MIN,
  LONG_TASK_RULES,
  LONG_TASKS_HEADING,
  type LongTaskLimits,
} from "./prompt-parts";

// ---------------------------------------------------------------------------
// Topic-Zuordnung
// ---------------------------------------------------------------------------

/**
 * config/topics.json: Topic-Nummer zu Agent je Chat (docs/topic-sessions.md F-5),
 *   { "-1001234567890": { "3": "research" }, "*": { "5": "finance" } }
 * "*" gilt für jeden Chat. Neu gelesen wird, sobald sich die mtime ändert,
 * Änderungen greifen also ohne Neustart.
 */
type TopicMap = Record<string, Record<string, string>>;
const TOPICS_FILE = join(process.cwd(), "config", "topics.json");
let topicsSeen: { mtimeMs: number; map: TopicMap } | undefined;

function readTopicMap(): TopicMap {
  try {
    const { mtimeMs } = statSync(TOPICS_FILE);
    if (topicsSeen?.mtimeMs !== mtimeMs) {
      topicsSeen = { mtimeMs, map: JSON.parse(readFileSync(TOPICS_FILE, "utf-8")) };
    }
    return topicsSeen.map;
  } catch {
    // Fehlt die Datei oder ist sie ungültig, gibt es keine Zuordnung
    return {};
  }
}

/** Agent eines Topics: Eintrag des Chats vor "*", sonst undefined */
export function getAgentByTopicId(topicId: number, chatId?: string): string | undefined {
  const map = readTopicMap();
  const key = String(topicId);
  const own = chatId ? map[chatId]?.[key] : undefined;
  return own || map["*"]?.[key] || undefined;
}

/** Chat-IDs mit eigener Zuordnung in config/topics.json (ohne "*"); WebUI sucht darin die Forum-Gruppe. */
export function getTopicConfigChatIds(): string[] {
  return Object.keys(readTopicMap()).filter(id => id !== "*");
}

/** Zuordnung für einen Chat, Chat-Eintrag vor "*" (für /topics) */
export function getTopicMappingForChat(chatId: string): Record<string, string> {
  const map = readTopicMap();
  return { ...map["*"], ...map[chatId] };
}

// ---------------------------------------------------------------------------
// Konfiguration aus dem Katalog
// ---------------------------------------------------------------------------

/**
 * Konfiguration eines aktiven Agenten aus dem Katalog (src/agents/catalog.ts,
 * Issue #49): mitgelieferte aus src/agents/<name>.ts, ein geänderter Prompt
 * aus config/agents.json hat Vorrang; eigene Agenten aus config/agents.json.
 * Aliasse wie "cfo" gelten. Unbekannte oder gelöschte Agenten ergeben
 * undefined; wer einen Rückfall braucht, nimmt getAgentConfigOrGeneral.
 */
export function getAgentConfig(name: string, opts?: AgentConfigOptions): AgentConfig | undefined {
  return getCatalogAgentConfig(name, opts);
}

/** Wie getAgentConfig, für unbekannte oder gelöschte Agenten General */
export function getAgentConfigOrGeneral(agentName: string, opts?: AgentConfigOptions): AgentConfig | undefined {
  return getAgentConfig(agentName, opts) ?? getAgentConfig("general", opts);
}

// ---------------------------------------------------------------------------
// Modell und Effort
// ---------------------------------------------------------------------------

/** Schlüssel in config/settings.json: aktiver Agent (Aliasse aufgelöst), sonst "general" */
function settingsKey(agentName: string): string {
  return resolveAgentName(agentName) ?? "general";
}

/** Woher die Resolver ihre Angaben holen; Tests reichen Fakes herein. */
export interface AgentResolveDeps {
  getAgentConfig: (agentName: string) => AgentConfig | undefined;
  getSettings: () => Settings;
}

const defaultResolveDeps: AgentResolveDeps = { getAgentConfig: getAgentConfigOrGeneral, getSettings };

/** Woher ein Wert stammt (WebUI-Einstellungen, Issue #36) */
export type ValueSource = "settings" | "env" | "code";

/** Wert aus config/settings.json: erst der Agent, dann der Standard */
function fromSettings(settings: Settings, agentName: string, field: "model" | "effort"): string | undefined {
  return settings.agents?.[settingsKey(agentName)]?.[field] ?? settings.defaults?.[field];
}

/**
 * Modell eines Agenten für Claude-Aufrufe: Einstellungsdatei (Agent, dann
 * Standard) vor dem Modell aus src/agents/<name>.ts, zuletzt DEFAULT_CLAUDE_MODEL.
 * Aliasse wie "cfo" zählen als "finance"; eigene Agenten unter ihrer
 * Kennung, unbekannte und gelöschte wie General.
 */
export function resolveAgentModel(agentName: string, deps: Partial<AgentResolveDeps> = {}): string {
  return describeAgentModel(agentName, deps).value;
}

/** Wie resolveAgentModel, zusätzlich mit Quelle. Eine eigene .env-Stufe gibt es für das Modell nicht. */
export function describeAgentModel(
  agentName: string,
  deps: Partial<AgentResolveDeps> = {}
): { value: string; source: ValueSource } {
  const d = { ...defaultResolveDeps, ...deps };
  const chosen = fromSettings(d.getSettings(), agentName, "model");
  if (chosen !== undefined) return { value: chosen, source: "settings" };
  return { value: d.getAgentConfig(agentName)?.model ?? DEFAULT_CLAUDE_MODEL, source: "code" };
}

/**
 * Effort eines Agenten: Einstellungsdatei (Agent, dann Standard) vor
 * CLAUDE_EFFORT aus .env vor dem Effort aus der Agenten-Datei. undefined heißt:
 * keinen Effort übergeben, dann entscheidet der Motor.
 */
export function resolveAgentEffort(agentName: string, deps: Partial<AgentResolveDeps> = {}): string | undefined {
  return describeAgentEffort(agentName, deps).value;
}

/** Wie resolveAgentEffort, zusätzlich mit Quelle; value undefined hat die Quelle "code". */
export function describeAgentEffort(
  agentName: string,
  deps: Partial<AgentResolveDeps> = {}
): { value: string | undefined; source: ValueSource } {
  const d = { ...defaultResolveDeps, ...deps };
  const chosen = fromSettings(d.getSettings(), agentName, "effort");
  if (chosen !== undefined) return { value: chosen, source: "settings" };
  const fromEnv = process.env.CLAUDE_EFFORT || undefined;
  if (fromEnv !== undefined) return { value: fromEnv, source: "env" };
  return { value: d.getAgentConfig(agentName)?.effort || undefined, source: "code" };
}
