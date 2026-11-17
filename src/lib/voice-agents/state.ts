/**
 * Laufzeitzustand eines Sprachagenten, getrennt vom Rezept:
 * data/voice-agents/<kennung>/state.json (Anbieter, Agent-Kennung, letzter
 * Abgleich, Zeitpunkte) und versionen/<n>.json (Kopie des Rezepts je Änderung).
 * Keinem symbolischen Link wird gefolgt (base.ts).
 *
 * Bewusst nicht src/lib/json-state.ts: Das schreibt nach <pfad>.sqlite, die
 * JSON-Datei bliebe veraltet.
 */
import { randomUUID } from "node:crypto";
import { link, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "../atomic-file";
import { acquireFileLock, releaseFileLock } from "../file-lock";
import {
  agentDataDir,
  agentsDataRoot,
  assertFileOrMissing,
  ensureRealDirs,
  readRegularFile,
  realDirsExist,
  recipeHash,
  VoiceAgentError,
  type VoiceAgentPaths,
} from "./base";

const stateSchema = z
  .object({
    anbieter: z.string().optional(),
    agentId: z.string().optional(),
    /** Hash des Rezepts beim letzten Abgleich mit dem Anbieter */
    letzterHash: z.string().optional(),
    abgeglichenAm: z.string().optional(),
    /**
     * Jede Agent-Kennung, die das Rezept je hatte (Issue #496). Ein Abgleich mit
     * neuem Agenten oder das Entfernen ändert agentId; ein verspätetes Protokoll
     * des alten Agenten findet sein Rezept trotzdem.
     */
    bekannteAgentIds: z.array(z.string()).optional(),
    erstelltAm: z.string(),
    geaendertAm: z.string(),
  })
  // Spätere Issues legen hier weitere Kennungen ab (etwa die der Tests)
  .passthrough();

export type VoiceAgentState = z.infer<typeof stateSchema>;

function stateFile(kennung: string, paths: VoiceAgentPaths): string {
  return join(agentDataDir(kennung, paths), "state.json");
}

function versionsDir(kennung: string, paths: VoiceAgentPaths): string {
  return join(agentDataDir(kennung, paths), "versionen");
}

/** Der Weg zum Agentenordner, von oben nach unten */
function agentDirs(kennung: string, paths: VoiceAgentPaths): string[] {
  return [agentsDataRoot(paths), agentDataDir(kennung, paths)];
}

function versionDirs(kennung: string, paths: VoiceAgentPaths): string[] {
  return [...agentDirs(kennung, paths), versionsDir(kennung, paths)];
}

/** Inhalt der Datei; undefined, wenn es sie nicht gibt. Ein JSON-null bleibt null und ist etwas anderes. */
async function readJson(dirs: string[], path: string, what: string): Promise<unknown> {
  if (!(await realDirsExist(dirs))) return undefined;
  const content = await readRegularFile(path);
  if (content === null) return undefined;
  try {
    return JSON.parse(content);
  } catch {
    throw new VoiceAgentError(`${what} ist beschädigt (kein gültiges JSON): ${path}`);
  }
}

/** Zustand des Agenten; null, solange es keinen gibt. Eine beschädigte Datei ist ein Fehler. */
export async function readState(kennung: string, paths: VoiceAgentPaths = {}): Promise<VoiceAgentState | null> {
  const path = stateFile(kennung, paths);
  const raw = await readJson(agentDirs(kennung, paths), path, `Zustand von ${kennung}`);
  if (raw === undefined) return null;
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) throw new VoiceAgentError(`Zustand von ${kennung} ist beschädigt: ${path}`);
  return parsed.data;
}

/** Ändert einzelne Felder und schreibt atomar; setzt die Zeitpunkte selbst. */
export async function updateState(
  kennung: string,
  patch: Partial<Omit<VoiceAgentState, "erstelltAm" | "geaendertAm">>,
  options: VoiceAgentPaths & { now?: Date } = {},
): Promise<VoiceAgentState> {
  const now = (options.now ?? new Date()).toISOString();
  const current = await readState(kennung, options);
  const next: VoiceAgentState = { ...current, ...patch, erstelltAm: current?.erstelltAm ?? now, geaendertAm: now };
  // Auch die ersetzte Kennung: Zustände von vor #496 tragen sie nur dort, und der Nachlauf beim Anbieter entfernt sie
  const ids: unknown[] = [current?.agentId, current?.ersetzterAgentId, next.agentId, next.ersetzterAgentId];
  const known = new Set([...(current?.bekannteAgentIds ?? []), ...ids.filter((id): id is string => typeof id === "string" && id !== "")]);
  if (known.size > 0) next.bekannteAgentIds = [...known];
  await ensureRealDirs(agentDirs(kennung, options));
  await atomicWriteFile(stateFile(kennung, options), JSON.stringify(next, null, 2) + "\n");
  return next;
}

/** Vorhandene Versionsnummern, aufsteigend */
export async function listVersions(kennung: string, paths: VoiceAgentPaths = {}): Promise<number[]> {
  if (!(await realDirsExist(versionDirs(kennung, paths)))) return [];
  const files = await readdir(versionsDir(kennung, paths));
  return files
    .filter((name) => /^[1-9][0-9]*\.json$/.test(name))
    .map((name) => Number.parseInt(name, 10))
    .sort((a, b) => a - b);
}

/** Rezeptkopie einer Version; null, wenn es sie nicht gibt. Alles außer einem JSON-Objekt ist beschädigt. */
export async function readVersion(kennung: string, version: number, paths: VoiceAgentPaths = {}): Promise<unknown | null> {
  const path = join(versionsDir(kennung, paths), `${version}.json`);
  const what = `Version ${version} von ${kennung}`;
  const raw = await readJson(versionDirs(kennung, paths), path, what);
  if (raw === undefined) return null;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new VoiceAgentError(`${what} ist beschädigt (kein Rezept): ${path}`);
  return raw;
}

/** Schreibt vollständig und legt die Datei nur an, wenn es sie noch nicht gibt. false: Nummer schon vergeben. */
async function createExclusive(path: string, content: string): Promise<boolean> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { mode: 0o600, flag: "wx" });
    await link(temp, path);
    return true;
  } catch (error: any) {
    if (error.code === "EEXIST") return false;
    throw error;
  } finally {
    await unlink(temp).catch(() => {});
  }
}

const MAX_VERSION_ATTEMPTS = 20;

/**
 * Neue Version nur, wenn der Hash von dem der letzten Version abweicht. Liest
 * jedes Mal von der Platte, gilt also auch nach einem Neustart. Laufen zwei
 * Speichervorgänge zugleich, bekommt jeder eine eigene Nummer.
 */
export async function recordVersion(kennung: string, recipe: unknown, paths: VoiceAgentPaths = {}): Promise<{ version: number; neu: boolean }> {
  const dir = versionsDir(kennung, paths);
  const hash = recipeHash(recipe);
  await ensureRealDirs(versionDirs(kennung, paths));
  for (let attempt = 0; attempt < MAX_VERSION_ATTEMPTS; attempt++) {
    const latest = (await listVersions(kennung, paths)).at(-1) ?? 0;
    if (latest > 0 && recipeHash(await readVersion(kennung, latest, paths)) === hash) return { version: latest, neu: false };
    const version = latest + 1;
    if (await createExclusive(join(dir, `${version}.json`), JSON.stringify(recipe, null, 2) + "\n")) return { version, neu: true };
  }
  throw new VoiceAgentError(`Keine freie Versionsnummer für ${kennung} gefunden.`);
}

/** Nimmt eine gerade angelegte Version zurück, wenn das Rezept dazu nicht geschrieben werden konnte. */
export async function discardVersion(kennung: string, version: number, paths: VoiceAgentPaths = {}): Promise<void> {
  await unlink(join(versionsDir(kennung, paths), `${version}.json`));
}

/** Lange genug für eine Warteschlange von Speichervorgängen unter Rechnerlast */
const SAVE_LOCK_WAIT_MS = 30_000;

/**
 * Führt fn unter der Sperre data/voice-agents/<kennung>/speichern.lock aus
 * (file-lock.ts, gilt auch über Prozesse; die eines toten Prozesses wird
 * aufgebrochen). Bleibt sie belegt, scheitert der Aufruf, ohne dass fn läuft.
 */
export async function withAgentLock<T>(kennung: string, paths: VoiceAgentPaths, fn: () => Promise<T>): Promise<T> {
  await ensureRealDirs(agentDirs(kennung, paths));
  const lockFile = join(agentDataDir(kennung, paths), "speichern.lock");
  // file-lock.ts liest die Sperre mit readFile und folgte einem Link dort
  await assertFileOrMissing(lockFile);
  const lock = await acquireFileLock(lockFile, { waitMs: SAVE_LOCK_WAIT_MS });
  try {
    return await fn();
  } finally {
    await releaseFileLock(lockFile, lock);
  }
}
