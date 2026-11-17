/**
 * Web-Freigabe für die Sprach-Brücke (Issue #491): Ein Gespräch im Browser hat
 * keine Rufnummer. Es gilt nur als der Nutzer, wenn tybo genau diese
 * Gesprächs-ID für genau dieses Rezept freigegeben hat.
 *
 * Die WebUI läuft im Bot, die Brücke ist ein eigener Prozess. Sie teilen sich
 * die Ablage data/voice-agents/<kennung>/web-calls/<hash der Gesprächs-ID>.json.
 * Die Gesprächs-ID kommt bei der Brücke aus system__conversation_id, das nur
 * der Anbieter setzt. Die Prüfsumme (HMAC mit einem Schlüssel aus
 * VOICE_BRIDGE_TOKEN) bindet Rezept, Gesprächs-ID und Ablauf aneinander; wer
 * eine Datei ändert, kopiert oder umbenennt, macht sie ungültig. Ausgestellt
 * wird beim Start eines Web-Gesprächs hinter dem Login
 * (src/web/bot-voice-agent-session.ts, Issue #494), zurückgenommen beim Auflegen.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { lstat, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../atomic-file";
import {
  agentDataDir,
  agentsDataRoot,
  ensureRealDirs,
  isValidKennung,
  readRegularFile,
  realDirsExist,
  VoiceAgentError,
  type VoiceAgentPaths,
} from "./base";
import { MAX_MINUTES_PER_CALL } from "./recipe";
import { WEB_SESSION_SLACK_MS, WEB_SESSION_TOKEN_MAX_MS } from "./web-sessions";

/**
 * Längste harte Grenze eines Web-Gesprächs (web-sessions.ts): Tokenablauf plus
 * längstes Gespräch plus Zuschlag. Die Brücke prüft die Freigabe bei jedem Turn;
 * nach dem bestätigten Ende wird sie gelöscht.
 */
export const WEB_CALL_MAX_TTL_MS = WEB_SESSION_TOKEN_MAX_MS + MAX_MINUTES_PER_CALL * 60_000 + WEB_SESSION_SLACK_MS;

const CONVERSATION_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const ENTRY_FILE = /^[0-9a-f]{64}\.json$/;
const MAC_LABEL = "tybo-voice-web-call";
const FORMAT = 1;

export interface WebCallOptions extends VoiceAgentPaths {
  /** VOICE_BRIDGE_TOKEN */
  token: string;
  now?: () => number;
}

export interface WebCallRef {
  conversationId: string;
  /** Kennung des Rezepts */
  kennung: string;
}

/** Fehlend oder nicht aufgelöst ({{system__conversation_id}}) zählt nicht als Gesprächs-ID. */
export function isValidConversationId(value: unknown): value is string {
  return typeof value === "string" && CONVERSATION_ID.test(value) && !value.includes("system__");
}

function usable({ conversationId, kennung }: WebCallRef): boolean {
  return isValidConversationId(conversationId) && isValidKennung(kennung);
}

function callsDir(kennung: string, paths: VoiceAgentPaths): string {
  return join(agentDataDir(kennung, paths), "web-calls");
}

function callsDirs(kennung: string, paths: VoiceAgentPaths): string[] {
  return [agentsDataRoot(paths), agentDataDir(kennung, paths), callsDir(kennung, paths)];
}

function entryPath({ conversationId, kennung }: WebCallRef, paths: VoiceAgentPaths): string {
  const name = createHash("sha256").update(conversationId).digest("hex");
  return join(callsDir(kennung, paths), `${name}.json`);
}

function mac({ conversationId, kennung }: WebCallRef, ablauf: number, token: string): Buffer {
  const key = createHmac("sha256", token).update(MAC_LABEL).digest();
  return createHmac("sha256", key).update(JSON.stringify([FORMAT, kennung, conversationId, ablauf])).digest();
}

function parseEntry(content: string): { ablauf: number; mac: Buffer } | null {
  try {
    const raw = JSON.parse(content);
    if (!Number.isSafeInteger(raw?.ablauf) || typeof raw?.mac !== "string") return null;
    return { ablauf: raw.ablauf, mac: Buffer.from(raw.mac, "hex") };
  } catch {
    return null;
  }
}

/** Stellt die Freigabe aus. ttlMs: so lange wie das Gespräch dauern darf, gedeckelt. Räumt dabei Abgelaufenes weg. */
export async function issueWebCall(ref: WebCallRef, ttlMs: number, options: WebCallOptions): Promise<{ ablauf: number }> {
  if (!options.token) throw new VoiceAgentError("VOICE_BRIDGE_TOKEN fehlt, ohne ihn gibt es keine Web-Freigabe.");
  if (!usable(ref)) throw new VoiceAgentError("Keine Web-Freigabe ohne gültige Gesprächs-ID und Kennung.");
  if (!(ttlMs > 0)) throw new VoiceAgentError("Eine Web-Freigabe braucht eine Laufzeit.");
  const now = options.now ?? Date.now;
  const ablauf = Math.floor(now() + Math.min(ttlMs, WEB_CALL_MAX_TTL_MS));
  await ensureRealDirs(callsDirs(ref.kennung, options));
  // Aufräumen darf das Ausstellen nicht verhindern
  await cleanupWebCalls(ref.kennung, options).catch(() => 0);
  const entry = { rezept: ref.kennung, gespraech: ref.conversationId, ablauf, mac: mac(ref, ablauf, options.token).toString("hex") };
  await atomicWriteFile(entryPath(ref, options), JSON.stringify(entry) + "\n");
  return { ablauf };
}

/** true nur für genau diese Gesprächs-ID, dieses Rezept und vor dem Ablauf. Jeder Fehler heißt: keine Freigabe. */
export async function verifyWebCall(ref: WebCallRef, options: WebCallOptions): Promise<boolean> {
  if (!options.token || !usable(ref)) return false;
  try {
    if (!(await realDirsExist(callsDirs(ref.kennung, options)))) return false;
    const content = await readRegularFile(entryPath(ref, options));
    const entry = content === null ? null : parseEntry(content);
    if (!entry) return false;
    const expected = mac(ref, entry.ablauf, options.token);
    if (entry.mac.length !== expected.length || !timingSafeEqual(entry.mac, expected)) return false;
    return (options.now ?? Date.now)() < entry.ablauf;
  } catch {
    return false;
  }
}

/** Nimmt die Freigabe eines beendeten Gesprächs zurück (Issue #494); fehlt sie, ist nichts zu tun. */
export async function revokeWebCall(ref: WebCallRef, paths: VoiceAgentPaths = {}): Promise<boolean> {
  if (!usable(ref) || !(await realDirsExist(callsDirs(ref.kennung, paths)))) return false;
  const path = entryPath(ref, paths);
  try {
    // unlink trifft auch einen Link selbst, nie sein Ziel
    await unlink(path);
    return true;
  } catch (error: any) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

/** Entfernt abgelaufene und unlesbare Freigaben eines Rezepts, liefert ihre Zahl. */
export async function cleanupWebCalls(kennung: string, options: VoiceAgentPaths & { now?: () => number }): Promise<number> {
  const dirs = callsDirs(kennung, options);
  if (!(await realDirsExist(dirs))) return 0;
  const dir = callsDir(kennung, options);
  const now = (options.now ?? Date.now)();
  let removed = 0;
  for (const name of await readdir(dir)) {
    if (!ENTRY_FILE.test(name)) continue;
    const path = join(dir, name);
    // unlink trifft auch einen Link selbst, nie sein Ziel
    const entry = (await lstat(path)).isFile() ? parseEntry((await readRegularFile(path)) ?? "") : null;
    if (entry && now < entry.ablauf) continue;
    await unlink(path);
    removed++;
  }
  return removed;
}
