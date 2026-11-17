/**
 * Freischaltung eines Sprachagenten (Issue #493): data/voice-agents/<kennung>/freischaltung.json.
 * Erst eine Freischaltung gibt Web-Link (SA1-6) und Telefonnummer frei. Sie gilt
 * nur für die Rezeptfassung, deren Hash sie trägt, und nur für den Inhalt der
 * Wissensdatei, deren Hash sie ebenfalls trägt. Der Hash im Dateinamen allein
 * reicht nicht: Die Datei kann danach von Hand geändert werden, und ein
 * Brückenagent liest sie bei jedem Gespräch. Jede Änderung am Rezept oder am
 * Wissen hebt die Freischaltung auf, ebenso eine fehlende oder unlesbare
 * Wissensdatei, bis die Tests wieder bestehen oder der Nutzer „Trotzdem
 * freischalten“ drückt.
 *
 * Geschrieben wird unter der Sperre der Kennung (state.ts), damit ein Speichern
 * dazwischen nicht eine veraltete Fassung freischaltet.
 */
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "../atomic-file";
import { agentDataDir, agentsDataRoot, assertFileOrMissing, ensureRealDirs, readRegularFile, realDirsExist, recipeHash, VoiceAgentError, type VoiceAgentPaths } from "./base";
import { loadRecipe, type Recipe } from "./recipe";
import { withAgentLock } from "./state";

const unlockSchema = z
  .object({
    hash: z.string().regex(/^[0-9a-f]{64}$/),
    version: z.number().int().positive(),
    /** Hash des Inhalts der Wissensdatei; null: das Rezept hat keine */
    wissenHash: z.string().regex(/^[0-9a-f]{64}$/).nullable(),
    grund: z.enum(["tests", "trotzdem"]),
    am: z.string(),
    testlauf: z.string().optional(),
  })
  .strict();

export type Unlock = z.infer<typeof unlockSchema>;

const unlockFile = (kennung: string, paths: VoiceAgentPaths) => join(agentDataDir(kennung, paths), "freischaltung.json");

/** Die Freischaltung; null ohne Datei. Eine beschädigte Datei gilt als nicht freigeschaltet und ist ein Fehler. */
export async function readUnlock(kennung: string, paths: VoiceAgentPaths = {}): Promise<Unlock | null> {
  if (!(await realDirsExist([agentsDataRoot(paths), agentDataDir(kennung, paths)]))) return null;
  const content = await readRegularFile(unlockFile(kennung, paths));
  if (content === null) return null;
  try {
    const parsed = unlockSchema.safeParse(JSON.parse(content));
    if (parsed.success) return parsed.data;
  } catch {
    // unten
  }
  throw new VoiceAgentError(`Freischaltung von ${kennung} ist beschädigt: ${unlockFile(kennung, paths)}`);
}

/**
 * Hash des Inhalts der Wissensdatei, auf die das Rezept zeigt; null ohne
 * Wissensdatei im Rezept. Fehlt die Datei oder ist sie unlesbar, ein Fehler:
 * Dann ist nicht bekannt, was der Agent weiß.
 */
export async function knowledgeHash(recipe: Pick<Recipe, "kennung" | "wissen">, paths: VoiceAgentPaths = {}): Promise<string | null> {
  const datei = recipe.wissen?.datei;
  if (!datei) return null;
  const dir = agentDataDir(recipe.kennung, paths);
  const path = join(dir, basename(datei));
  if (!(await realDirsExist([agentsDataRoot(paths), dir]))) throw new VoiceAgentError(`Wissensdatei von ${recipe.kennung} fehlt: ${path}`);
  const content = await readRegularFile(path);
  if (content === null) throw new VoiceAgentError(`Wissensdatei von ${recipe.kennung} fehlt: ${path}`);
  return createHash("sha256").update(content).digest("hex");
}

/** true: Das aktive Rezept und seine Wissensdatei sind genau in der freigeschalteten Fassung. */
export async function isUnlocked(kennung: string, paths: VoiceAgentPaths = {}): Promise<boolean> {
  try {
    const [recipe, unlock] = await Promise.all([loadRecipe(kennung, paths), readUnlock(kennung, paths)]);
    if (!recipe || !unlock || unlock.hash !== recipeHash(recipe)) return false;
    return (await knowledgeHash(recipe, paths)) === unlock.wissenHash;
  } catch {
    return false;
  }
}

export type UnlockOutcome = { status: "freigeschaltet"; unlock: Unlock } | { status: "veraltet" } | { status: "weg" };

/**
 * Schaltet frei, wenn das aktive Rezept noch den geprüften Hash hat und seine
 * Wissensdatei noch den geprüften Inhalt (wissenHash, null: keine). Sonst
 * „veraltet“: Inzwischen gilt eine andere Fassung oder anderes Wissen, oder die
 * Wissensdatei fehlt oder ist unlesbar, und das ist nicht geprüft.
 */
export async function writeUnlock(
  kennung: string,
  expected: { hash: string; version: number; wissenHash: string | null; grund: Unlock["grund"]; testlauf?: string },
  paths: VoiceAgentPaths = {},
  now: () => number = Date.now,
): Promise<UnlockOutcome> {
  return withAgentLock(kennung, paths, async () => {
    const recipe = await loadRecipe(kennung, paths);
    if (!recipe) return { status: "weg" } as const;
    if (recipeHash(recipe) !== expected.hash) return { status: "veraltet" } as const;
    let current: string | null;
    try {
      current = await knowledgeHash(recipe, paths);
    } catch {
      return { status: "veraltet" } as const;
    }
    if (current !== expected.wissenHash) return { status: "veraltet" } as const;
    const unlock: Unlock = {
      hash: expected.hash,
      version: expected.version,
      wissenHash: expected.wissenHash,
      grund: expected.grund,
      am: new Date(now()).toISOString(),
      ...(expected.testlauf ? { testlauf: expected.testlauf } : {}),
    };
    const path = unlockFile(kennung, paths);
    await ensureRealDirs([agentsDataRoot(paths), agentDataDir(kennung, paths)]);
    await assertFileOrMissing(path);
    await atomicWriteFile(path, JSON.stringify(unlock, null, 2) + "\n");
    return { status: "freigeschaltet", unlock } as const;
  });
}
