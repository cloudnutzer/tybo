/**
 * Wissensdatei eines Rezepts für den Prompt (Stufe thema, Issue #491). Bis zur
 * Grenze steht sie im Prompt; was größer ist, bleibt draußen und ist erst mit
 * dem Werkzeug wissen_suchen erreichbar (SA2-1).
 */
import { lstat } from "node:fs/promises";
import { basename, join } from "node:path";
import { agentDataDir, agentsDataRoot, readRegularFile, realDirsExist, type VoiceAgentPaths } from "./base";
import type { Recipe } from "./recipe";

export const KNOWLEDGE_PROMPT_LIMIT = 40_000;
export const KNOWLEDGE_CACHE_TTL_MS = 10 * 60_000;
/** UTF-8 braucht je Zeichen höchstens vier Byte: Was größer ist, muss nicht erst gelesen werden */
const MAX_BYTES = KNOWLEDGE_PROMPT_LIMIT * 4;

export type KnowledgeResult = { status: "prompt"; text: string } | { status: "zu-gross" } | { status: "fehlt" };

export interface KnowledgeCacheOptions extends VoiceAgentPaths {
  now?: () => number;
  ttlMs?: number;
}

interface CacheEntry {
  datei: string;
  size: number;
  mtimeMs: number;
  loadedAt: number;
  result: KnowledgeResult;
}

/**
 * Cache je Kennung: Ein Gespräch fragt die Datei bei jedem Turn ab. Neu gelesen
 * wird nach Ablauf, wenn sich Größe oder Änderungszeit geändert haben und wenn
 * das Rezept auf eine andere Datei zeigt. Was nicht lesbar ist, zählt als
 * fehlend und wird nicht gemerkt.
 */
export function createKnowledgeCache(options: KnowledgeCacheOptions = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? KNOWLEDGE_CACHE_TTL_MS;
  const cache = new Map<string, CacheEntry>();

  return async function load(recipe: Pick<Recipe, "kennung" | "wissen">): Promise<KnowledgeResult> {
    const datei = recipe.wissen?.datei;
    const { kennung } = recipe;
    if (!datei) return { status: "fehlt" };
    try {
      const dir = agentDataDir(kennung, options);
      if (!(await realDirsExist([agentsDataRoot(options), dir]))) return { status: "fehlt" };
      // Die Prüfung des Rezepts hält datei direkt im Agentenordner
      const path = join(dir, basename(datei));
      const stat = await lstat(path);
      const hit = cache.get(kennung);
      if (hit && hit.datei === datei && hit.size === stat.size && hit.mtimeMs === stat.mtimeMs && now() - hit.loadedAt < ttlMs) return hit.result;
      let result: KnowledgeResult;
      if (stat.size > MAX_BYTES) result = { status: "zu-gross" };
      else {
        const text = await readRegularFile(path);
        if (text === null || !text.trim()) return { status: "fehlt" };
        result = text.length > KNOWLEDGE_PROMPT_LIMIT ? { status: "zu-gross" } : { status: "prompt", text };
      }
      cache.set(kennung, { datei, size: stat.size, mtimeMs: stat.mtimeMs, loadedAt: now(), result });
      return result;
    } catch {
      return { status: "fehlt" };
    }
  };
}
