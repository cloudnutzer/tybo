import { atomicWriteFile } from "./atomic-file";
/**
 * Topic Setup — one-time agent assignment for unmapped forum topics
 * (docs/topic-sessions.md F-5: the bot asks once).
 *
 * When a message arrives in a topic that no config or default maps to an
 * agent, the bot asks once (inline keyboard) which agent owns the topic.
 * The choice is written to config/topics.json, which base.ts hot-reloads.
 * Until answered, messages are handled by "general" as before.
 * Die Auswahl zeigt die aktiven Agenten aus dem Katalog (src/agents/catalog.ts).
 */

import { join } from "path";
import { mkdir, readFile } from "fs/promises";

const DEFAULT_ASKED_FILE = join(process.cwd(), "data", "topics-asked.json");
let ASKED_FILE = DEFAULT_ASKED_FILE;

/** Nur für Tests: data/topics-asked.json umlenken, null stellt zurück (Issue #119) */
export function setTopicsAskedFileForTests(path: string | null): void {
  ASKED_FILE = path ?? DEFAULT_ASKED_FILE;
}
export const TOPICS_CONFIG_PATH = join(process.cwd(), "config", "topics.json");
const TOPICS_CONFIG = TOPICS_CONFIG_PATH;

async function readJson(path: string): Promise<Record<string, any>> {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return {};
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true }).catch(() => {});
  await atomicWriteFile(path, JSON.stringify(value, null, 2));
}

/** true when this chat/topic has not been asked for a mapping yet. */
export async function shouldAskTopicMapping(
  chatId: string,
  topicId: number
): Promise<boolean> {
  const asked = await readJson(ASKED_FILE);
  return !asked[`${chatId}:${topicId}`];
}

export async function markTopicMappingAsked(
  chatId: string,
  topicId: number
): Promise<void> {
  try {
    const asked = await readJson(ASKED_FILE);
    asked[`${chatId}:${topicId}`] = Date.now();
    await writeJson(ASKED_FILE, asked);
  } catch (err) {
    console.error("[TopicSetup] markAsked failed:", err);
  }
}

/**
 * Schreibkette für config/topics.json (Issue #29): Lesen, Ändern und
 * Schreiben laufen am Stück, damit paralleles Anlegen (WebUI), Löschen
 * (WebUI) und die Zuordnungs-Rückfrage aus bot.ts keine Einträge verlieren.
 */
let topicsChain: Promise<unknown> = Promise.resolve();
function serializeTopics<T>(fn: () => Promise<T>): Promise<T> {
  const pending = topicsChain.catch(() => {}).then(fn);
  topicsChain = pending;
  return pending;
}

/** setTopicMapping mit accept: der Agent ist inzwischen nicht mehr aktiv (Issue #50) */
export class TopicAgentInactive extends Error {
  constructor() {
    super("Agent inzwischen gelöscht");
    this.name = "TopicAgentInactive";
  }
}

/** Eine geschriebene Zuordnung (Issue #119) */
export interface TopicMappingChange {
  chatId: string;
  topicId: number;
  agent: string;
}

export type TopicMappingListener = (change: TopicMappingChange) => void;

const mappingListeners = new Set<TopicMappingListener>();

/**
 * Meldet jede in diesem Prozess geschriebene Zuordnung (setTopicMapping,
 * setTopicMappingIfUnmapped), egal über welchen Weg: Einstellungen, Anlegen im
 * Browser, alte topicmap:-Knöpfe, Rückfrage (Issue #119). Umstellen beim
 * Löschen eines Agenten (reassignTopicMappings) zählt nicht, dort gab es die
 * Zuordnung schon. Gibt die Abmeldung zurück.
 */
export function onTopicMappingSet(listener: TopicMappingListener): () => void {
  mappingListeners.add(listener);
  return () => {
    mappingListeners.delete(listener);
  };
}

function emitMappingSet(change: TopicMappingChange): void {
  for (const listener of [...mappingListeners]) {
    try {
      listener(change);
    } catch (err) {
      console.error(`[TopicSetup] Zuhörer scheiterte (${err instanceof Error ? err.name : "Fehler"})`);
    }
  }
}

/** Zuordnung eines Topics in der gelesenen Datei: eigene Chat-ID vor "*" wie getAgentByTopicId */
function mappedAgent(config: Record<string, any>, chatId: string, topicId: number): string | undefined {
  const key = String(topicId);
  for (const id of [chatId, "*"]) {
    const chat = config[id];
    if (chat && typeof chat === "object" && typeof chat[key] === "string" && chat[key]) return chat[key];
  }
  return undefined;
}

/** Agent eines Topics laut config/topics.json (ohne eingebaute Vorgaben); wirft bei unlesbarer Datei */
export async function getMappedAgent(chatId: string, topicId: number, file: string = TOPICS_CONFIG): Promise<string | undefined> {
  return mappedAgent(await readTopicsStrict(file), chatId, topicId);
}

/**
 * Persist a topic→agent mapping in config/topics.json (created if missing).
 * base.ts picks the change up automatically via its mtime check.
 * `file` only for tests.
 *
 * accept (Issue #50): wird innerhalb der Schreibkette geprueft; false ergibt
 * TopicAgentInactive, nichts geschrieben. Weil Agent-Loeschen die Topics in
 * derselben Kette umstellt, zeigt danach nie ein Topic auf einen geloeschten Agenten.
 */
export async function setTopicMapping(
  chatId: string,
  topicId: number,
  agent: string,
  file: string = TOPICS_CONFIG,
  accept?: (agent: string) => boolean
): Promise<void> {
  await serializeTopics(async () => {
    if (accept && !accept(agent)) throw new TopicAgentInactive();
    const config = await readJson(file);
    if (!config[chatId] || typeof config[chatId] !== "object") config[chatId] = {};
    config[chatId][String(topicId)] = agent;
    await writeJson(file, config);
  });
  emitMappingSet({ chatId, topicId, agent });
}

export type SetIfUnmappedResult = { status: "set" } | { status: "mapped"; agent: string };

/**
 * Wie setTopicMapping, schreibt aber nur, wenn das Topic in der Datei noch
 * keinen Agenten hat (Rückfrage „Welcher Agent?", Issue #119): ein
 * verspäteter Klick überschreibt nie eine inzwischen gesetzte Zuordnung.
 * Geprüft wird in derselben Schreibkette. Eine unlesbare Datei ergibt einen
 * Fehler statt eines stillen Ersetzens.
 */
export async function setTopicMappingIfUnmapped(
  chatId: string,
  topicId: number,
  agent: string,
  file: string = TOPICS_CONFIG,
  accept?: (agent: string) => boolean
): Promise<SetIfUnmappedResult> {
  const result = await serializeTopics<SetIfUnmappedResult>(async () => {
    const config = await readTopicsStrict(file);
    const existing = mappedAgent(config, chatId, topicId);
    if (existing) return { status: "mapped", agent: existing };
    if (accept && !accept(agent)) throw new TopicAgentInactive();
    if (!config[chatId] || typeof config[chatId] !== "object" || Array.isArray(config[chatId])) config[chatId] = {};
    config[chatId][String(topicId)] = agent;
    await writeJson(file, config);
    return { status: "set" };
  });
  if (result.status === "set") emitMappingSet({ chatId, topicId, agent });
  return result;
}

/**
 * Entfernt die Zuordnung eines Topics (Löschen aus der WebUI, Issue #29).
 * Fehlt die Datei oder der Eintrag, ist nichts zu tun. Eine unlesbare oder
 * beschädigte Datei wird nicht überschrieben, sondern ergibt einen Fehler.
 */
export function removeTopicMapping(
  chatId: string,
  topicId: number,
  file: string = TOPICS_CONFIG
): Promise<void> {
  return serializeTopics(async () => {
    let config: Record<string, any>;
    try {
      config = JSON.parse(await readFile(file, "utf-8"));
    } catch (e: any) {
      if (e?.code === "ENOENT") return;
      throw e;
    }
    if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("topics.json ist kein Objekt");
    const chat = config[chatId];
    if (!chat || typeof chat !== "object" || !(String(topicId) in chat)) return;
    delete chat[String(topicId)];
    await writeJson(file, config);
  });
}

/** Topic in config/topics.json; chatId "*" steht fuer alle Chats */
export interface TopicRef {
  chatId: string;
  topicId: number;
}

/**
 * Liest config/topics.json streng: fehlt die Datei, ein leeres Objekt;
 * unlesbar oder kein JSON-Objekt ergibt einen Fehler statt stillem Ersetzen.
 */
export async function readTopicsStrict(file: string = TOPICS_CONFIG): Promise<Record<string, any>> {
  let config: unknown;
  try {
    config = JSON.parse(await readFile(file, "utf-8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    throw new Error("config/topics.json ist nicht lesbar oder kein gültiges JSON");
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("topics.json ist kein Objekt");
  return config as Record<string, any>;
}

/**
 * Stellt alle Topics, deren Agent `matches` erfuellt, auf `to` um (Agent
 * loeschen, Issue #49): alle Chat-IDs und der Schluessel "*". Laeuft in der
 * Schreibkette oben; ohne Treffer bleibt die Datei unberuehrt.
 */
export function reassignTopicMappings(
  matches: (agent: string) => boolean,
  to: string,
  file: string = TOPICS_CONFIG
): Promise<TopicRef[]> {
  return serializeTopics(async () => {
    const config = await readTopicsStrict(file);
    const moved: TopicRef[] = [];
    for (const [chatId, chat] of Object.entries(config)) {
      if (!chat || typeof chat !== "object" || Array.isArray(chat)) continue;
      for (const [topicKey, agent] of Object.entries(chat as Record<string, unknown>)) {
        if (typeof agent !== "string" || !matches(agent)) continue;
        (chat as Record<string, string>)[topicKey] = to;
        moved.push({ chatId, topicId: Number(topicKey) });
      }
    }
    if (moved.length > 0) await writeJson(file, config);
    return moved;
  });
}
