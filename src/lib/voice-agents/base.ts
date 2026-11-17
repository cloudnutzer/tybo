/**
 * Sprachagenten (Entscheidung 0026): was Rezept und Laufzeitzustand teilen,
 * also Kennung, Ablageorte und Hash. Eigenes Modul, damit state.ts nicht von
 * recipe.ts abhängt und umgekehrt.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { join } from "node:path";

export const KENNUNG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const KENNUNG_MAX = 64;

/** data/voice-agents/entwuerfe/ gehört den Entwürfen, kein Agent darf dort landen */
const RESERVED_KENNUNGEN = new Set(["entwuerfe"]);

export function isValidKennung(value: unknown): value is string {
  return typeof value === "string" && value.length <= KENNUNG_MAX && KENNUNG_PATTERN.test(value) && !RESERVED_KENNUNGEN.has(value);
}

/** Fehler in Klartext: eine ungültige Eingabe oder eine beschädigte Datei */
export class VoiceAgentError extends Error {
  constructor(message: string, readonly fehler: readonly string[] = [message]) {
    super(message);
    this.name = "VoiceAgentError";
  }
}

export interface VoiceAgentPaths {
  /** Ordner der Rezepte, Standard config/voice-agents */
  configDir?: string;
  /** Ordner der Laufzeitdaten, Standard data/voice-agents */
  dataDir?: string;
}

function checkedKennung(kennung: string): string {
  // Die Prüfung hält auch Pfade wie ../x oder a/b aus den Ordnern heraus
  if (!isValidKennung(kennung)) throw new VoiceAgentError(`Ungültige Kennung: ${JSON.stringify(kennung)}. Erlaubt sind Kleinbuchstaben, Ziffern und einzelne Bindestriche.`);
  return kennung;
}

export function recipesDir(paths: VoiceAgentPaths = {}): string {
  return paths.configDir ?? join(process.cwd(), "config", "voice-agents");
}

export function recipePath(kennung: string, paths: VoiceAgentPaths = {}): string {
  return join(recipesDir(paths), `${checkedKennung(kennung)}.json`);
}

export function agentsDataRoot(paths: VoiceAgentPaths = {}): string {
  return paths.dataDir ?? join(process.cwd(), "data", "voice-agents");
}

export function agentDataDir(kennung: string, paths: VoiceAgentPaths = {}): string {
  return join(agentsDataRoot(paths), checkedKennung(kennung));
}

/*
 * Symbolische Links: Die beiden Ablageordner, die Agentenordner, versionen und
 * jede Datei darin müssen echt sein, ein Link führt sonst aus der Ablage heraus.
 * Geprüft wird ab den Ablageordnern; was darüber liegt (etwa ein verlinktes
 * Projektverzeichnis), gehört dem Nutzer.
 */

function noRealEntry(path: string): VoiceAgentError {
  return new VoiceAgentError(`Keine normale Datei und kein echter Ordner (etwa ein symbolischer Link): ${path}`);
}

async function lstatOrNull(path: string) {
  try {
    return await lstat(path);
  } catch (error: any) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/** true: lauter echte Ordner. false: einer fehlt, darunter kann nichts liegen. Ein Link oder eine Datei ist ein Fehler. */
export async function realDirsExist(dirs: readonly string[]): Promise<boolean> {
  for (const dir of dirs) {
    const entry = await lstatOrNull(dir);
    if (!entry) return false;
    if (!entry.isDirectory()) throw noRealEntry(dir);
  }
  return true;
}

/** Legt fehlende Ordner an und verlangt von den vorhandenen, echt zu sein. Die Liste beginnt oben. */
export async function ensureRealDirs(dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) {
    if (await realDirsExist([dir])) continue;
    await mkdir(dir, { recursive: true });
    if (!(await realDirsExist([dir]))) throw noRealEntry(dir);
  }
}

/** Wirft, wenn am Pfad etwas anderes als eine normale Datei liegt. Fehlt die Datei, ist das in Ordnung. */
export async function assertFileOrMissing(path: string): Promise<void> {
  const entry = await lstatOrNull(path);
  if (entry && !entry.isFile()) throw noRealEntry(path);
}

/** Inhalt einer normalen Datei, ohne einem Link zu folgen; null, wenn es sie nicht gibt. */
export async function readRegularFile(path: string): Promise<string | null> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error: any) {
    if (error.code === "ENOENT") return null;
    if (error.code === "ELOOP") throw noRealEntry(path);
    throw error;
  }
  try {
    if (!(await handle.stat()).isFile()) throw noRealEntry(path);
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item === undefined ? null : item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hash über die sortierte JSON-Fassung: Schlüsselreihenfolge zählt nicht, die Reihenfolge in Listen schon. */
export function recipeHash(recipe: unknown): string {
  return createHash("sha256").update(stableJson(recipe)).digest("hex");
}
