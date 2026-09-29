import { atomicWriteFile } from "./atomic-file";
/**
 * Session Manager — per-topic Claude CLI session continuity (docs/topic-sessions.md F-1).
 *
 * When SESSION_MODE=resume is set, each Telegram topic/DM keeps a live
 * `claude -p` session: follow-up messages are sent with --resume <sessionId>
 * and a slim prompt (time + semantic hits + message) instead of rebuilding
 * the full context. The Claude CLI then owns history and auto-compaction.
 *
 * Sessions are keyed by (session key, agent) so cross-agent invocations in
 * the same topic don't hijack the topic's primary session.
 *
 * State lives in a local JSON file (data/sessions.json): Claude CLI session
 * files exist only on this machine, so the state is node-local by nature.
 *
 * Fail-open: any error here must degrade to "no resume" (fresh session),
 * never block a message.
 */

import { dirname, join } from "path";
import { mkdir, readFile } from "fs/promises";
import type { EngineId } from "./engines/types";

export interface BotSession {
  key: string; // "{sessionKey}:{agentName}"
  agentName: string;
  /**
   * Motor der Session (Entscheidung 0018, Issue #122). Eine Session gehört
   * zu genau einem Motor; fehlt das Feld in alten Einträgen, gilt Claude.
   */
  engine: EngineId;
  /** Session-ID des Motors (vorher claudeSessionId, alte Einträge werden beim Lesen übernommen) */
  engineSessionId?: string;
  model: string;
  memoryWatermark?: number;
  startedAt: number; // epoch ms
  lastActivity: number; // epoch ms
  messageCount: number;
}

/** Eintrag, wie er in Dateien vor Issue #122 stehen kann */
export type LegacyBotSession = Omit<BotSession, "engine"> & { engine?: EngineId; claudeSessionId?: string };

const DEFAULT_SESSIONS_FILE = join(process.cwd(), "data", "sessions.json");
let sessionsFile = DEFAULT_SESSIONS_FILE;
const IDLE_HOURS = parseFloat(process.env.SESSION_IDLE_HOURS || "18");
/** Idle window after which a session is no longer resumed (SESSION_IDLE_HOURS). */
export const SESSION_IDLE_MS = IDLE_HOURS * 3_600_000;

let cache: Record<string, BotSession> | null = null;

/**
 * Epoche je Session-Schlüssel (Issue #189): jedes Zurücksetzen aller Agenten
 * eines Schlüssels (/new, Topic löschen) zählt sie hoch. Ein Turn merkt sich
 * die Epoche vor dem Start und speichert seine Session nur, wenn sie noch
 * gilt; sonst schriebe ein Turn, der beim /new schon lief, die alte Session
 * zurück. Nur im Speicher: nach einem Neustart läuft kein alter Turn mehr.
 */
const epochs = new Map<string, number>();

export function sessionEpoch(sessionKey: string): number {
  return epochs.get(sessionKey) ?? 0;
}

/**
 * Epochen aller Schlüssel zum jetzigen Zeitpunkt, für Wege, die den
 * Schlüssel erst nach einem await kennen (Review-Entscheidung, Issue #189)
 */
export function sessionEpochSnapshot(): (sessionKey: string) => number {
  const copy = new Map(epochs);
  return (sessionKey) => copy.get(sessionKey) ?? 0;
}

function bumpEpoch(sessionKey: string): void {
  epochs.set(sessionKey, sessionEpoch(sessionKey) + 1);
}

export function isSessionModeEnabled(): boolean {
  return (process.env.SESSION_MODE || "").toLowerCase() === "resume";
}

function storageKey(sessionKey: string, agentName: string): string {
  return `${sessionKey}:${agentName}`;
}

/**
 * Eintrag aus sessions.json oder einem Session-Snapshot (pending-reviews.json)
 * in die jetzige Form bringen (Issue #122): ohne engine gilt Claude, eine alte
 * claudeSessionId wird zu engineSessionId, aber nur bei einer Claude-Session.
 * Geschrieben wird danach nur noch engineSessionId.
 */
export function normalizeSession(raw: LegacyBotSession): BotSession {
  const { claudeSessionId, ...rest } = raw;
  const engine: EngineId = rest.engine ?? "claude";
  const engineSessionId = rest.engineSessionId ?? (engine === "claude" ? claudeSessionId : undefined);
  const session: BotSession = { ...rest, engine };
  if (engineSessionId) session.engineSessionId = engineSessionId;
  else delete session.engineSessionId;
  return session;
}

/**
 * Nur für Tests: Ablage der Sessions umlenken, null stellt zurück. Leert den
 * Speicher-Cache und das laufende erste Laden, damit nichts aus der alten
 * Datei weiterlebt; Epochen bleiben (sie hängen am Prozess, nicht an der Datei).
 */
export function setSessionsFileForTests(path: string | null): void {
  sessionsFile = path ?? DEFAULT_SESSIONS_FILE;
  cache = null;
  initialLoad = undefined;
}

let initialLoad: ReturnType<typeof loadUncached> | undefined;
async function loadUncached(): Promise<Record<string, BotSession>> {
  if (cache) return cache;
  const file = sessionsFile;
  let loaded: Record<string, BotSession>;
  try {
    const raw = JSON.parse(await readFile(file, "utf-8")) as Record<string, LegacyBotSession>;
    loaded = {};
    for (const [k, v] of Object.entries(raw)) loaded[k] = normalizeSession(v);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    loaded = {};
  }
  // Ablage inzwischen umgelenkt (nur Tests): nichts aus der alten Datei übernehmen
  if (file !== sessionsFile) return loadUncached();
  cache = loaded;
  return cache;
}

/** true, wenn die Ablage geschrieben wurde */
async function persist(): Promise<boolean> {
  if (!cache) return false;
  try {
    await mkdir(dirname(sessionsFile), { recursive: true });
    await atomicWriteFile(sessionsFile, JSON.stringify(cache, null, 2));
    return true;
  } catch (err) {
    console.error("[SessionManager] persist failed:", err);
    return false;
  }
}

/**
 * Return the resumable session for a key, or undefined when a fresh session
 * is needed (no session, idle past SESSION_IDLE_HOURS, model changed, or the
 * session belongs to another engine: Issue #122, eine Session gehört zu genau
 * einem Motor und wird nie an einen anderen übergeben).
 */
export async function getResumableSession(
  sessionKey: string,
  agentName: string,
  model: string,
  engine: EngineId
): Promise<BotSession | undefined> {
  try {
    const sessions = await load();
    const s = sessions[storageKey(sessionKey, agentName)];
    if (!s?.engineSessionId) return undefined;
    if (s.engine !== engine) return undefined;
    if (s.model !== model) return undefined;
    if (Date.now() - s.lastActivity > IDLE_HOURS * 3_600_000) return undefined;
    return s;
  } catch {
    return undefined;
  }
}

/** Convenience wrapper: just the engine session ID to resume. */
export async function getResumableSessionId(
  sessionKey: string,
  agentName: string,
  model: string,
  engine: EngineId
): Promise<string | undefined> {
  return (await getResumableSession(sessionKey, agentName, model, engine))
    ?.engineSessionId;
}

/**
 * Take (return + remove) a session that exists but is no longer resumable
 * (idle past the window, model or engine changed): the caller can distill
 * it once, über den Motor der Session.
 * Returns undefined when there is no session or it is still resumable.
 */
export async function takeExpiredSession(
  sessionKey: string,
  agentName: string,
  model: string,
  engine: EngineId
): Promise<BotSession | undefined> {
  try {
    const sessions = await load();
    const key = storageKey(sessionKey, agentName);
    const s = sessions[key];
    if (!s?.engineSessionId) return undefined;
    const stillValid =
      s.engine === engine &&
      s.model === model &&
      Date.now() - s.lastActivity <= IDLE_HOURS * 3_600_000;
    if (stillValid) return undefined;
    delete sessions[key];
    await persist();
    return s;
  } catch {
    return undefined;
  }
}

/** All stored sessions under a session key (any agent). */
export async function getSessionsForKey(
  sessionKey: string
): Promise<BotSession[]> {
  try {
    const sessions = await load();
    return Object.entries(sessions)
      .filter(([k]) => k.startsWith(`${sessionKey}:`))
      .map(([, s]) => s);
  } catch {
    return [];
  }
}

/**
 * All stored sessions (WebUI status, Issue #37). Unlike the other readers
 * this throws on an unreadable file, so the status can say "unknown"
 * instead of "0".
 */
export async function listStoredSessions(): Promise<BotSession[]> {
  return Object.values(await load());
}

/**
 * Record a successful turn: bind the (possibly new) engine session ID to the
 * session key and bump activity. Returns true only when the pointer was
 * stored (file read and written); callers may promise a resume only then.
 * Mit epoch: nichts speichern, wenn der Schlüssel seitdem zurückgesetzt wurde.
 * Dieselbe Session heißt: gleicher Motor und gleiche Session-ID.
 */
export async function recordSessionTurn(
  sessionKey: string,
  agentName: string,
  model: string,
  engine: EngineId,
  engineSessionId: string,
  memoryWatermark = Date.now(),
  epoch?: number
): Promise<boolean> {
  try {
    const sessions = await load();
    // Nach dem Laden ohne weiteres await prüfen und schreiben: ein /new
    // dazwischen zählt die Epoche vorher hoch oder löscht danach
    if (epoch !== undefined && sessionEpoch(sessionKey) !== epoch) return false;
    const key = storageKey(sessionKey, agentName);
    const existing = sessions[key];
    const now = Date.now();
    const sameSession = existing?.engine === engine && existing?.engineSessionId === engineSessionId;
    sessions[key] = {
      key,
      agentName,
      engine,
      engineSessionId,
      model,
      memoryWatermark,
      startedAt: sameSession ? existing.startedAt : now,
      lastActivity: now,
      messageCount: sameSession ? existing.messageCount + 1 : 1,
    };
    return await persist();
  } catch (err) {
    console.error("[SessionManager] recordSessionTurn failed:", err);
    return false;
  }
}

/**
 * Reset sessions for a session key (manual /new, resume failure), gleich
 * welcher Motor. Without agentName, all agents' sessions under that key are reset and
 * running turns of that key no longer store their session (Epoche).
 */
export async function resetSession(
  sessionKey: string,
  agentName?: string
): Promise<number> {
  // Vor dem ersten await, auch ohne gespeicherte Session: ein laufender
  // erster Turn des Schlüssels darf danach nichts mehr speichern
  if (!agentName) bumpEpoch(sessionKey);
  try {
    const sessions = await load();
    const keys = agentName
      ? [storageKey(sessionKey, agentName)]
      : Object.keys(sessions).filter((k) => k.startsWith(`${sessionKey}:`));
    let reset = 0;
    for (const k of keys) {
      if (sessions[k]) {
        delete sessions[k];
        reset++;
      }
    }
    if (reset > 0) await persist();
    return reset;
  } catch {
    return 0;
  }
}

/**
 * Wie resetSession ohne Agent, wirft aber Lese- und Schreibfehler (WebUI,
 * Issue #29: Löschen eines Topics meldet ein unvollständiges Aufräumen).
 */
export async function resetSessionOrThrow(sessionKey: string): Promise<number> {
  bumpEpoch(sessionKey);
  const sessions = await load();
  const keys = Object.keys(sessions).filter((k) => k.startsWith(`${sessionKey}:`));
  if (!keys.length) return 0;
  const removed = keys.map((k) => [k, sessions[k]] as const);
  for (const k of keys) delete sessions[k];
  try {
    await mkdir(dirname(sessionsFile), { recursive: true });
    await atomicWriteFile(sessionsFile, JSON.stringify(sessions, null, 2));
  } catch (error) {
    for (const [k, v] of removed) if (!(k in sessions)) sessions[k] = v;
    throw error;
  }
  return keys.length;
}

async function load() {
  if (cache) return cache;
  initialLoad ||= loadUncached().catch(error => { initialLoad = undefined; throw error; });
  return initialLoad;
}
