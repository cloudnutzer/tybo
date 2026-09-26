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

import { join } from "path";
import { mkdir, readFile, writeFile } from "fs/promises";

export interface BotSession {
  key: string; // "{sessionKey}:{agentName}"
  agentName: string;
  claudeSessionId?: string;
  model: string;
  memoryWatermark?: number;
  startedAt: number; // epoch ms
  lastActivity: number; // epoch ms
  messageCount: number;
}

const SESSIONS_FILE = join(process.cwd(), "data", "sessions.json");
const IDLE_HOURS = parseFloat(process.env.SESSION_IDLE_HOURS || "18");
/** Idle window after which a session is no longer resumed (SESSION_IDLE_HOURS). */
export const SESSION_IDLE_MS = IDLE_HOURS * 3_600_000;

let cache: Record<string, BotSession> | null = null;

export function isSessionModeEnabled(): boolean {
  return (process.env.SESSION_MODE || "").toLowerCase() === "resume";
}

function storageKey(sessionKey: string, agentName: string): string {
  return `${sessionKey}:${agentName}`;
}

let initialLoad: ReturnType<typeof loadUncached> | undefined;
async function loadUncached(): Promise<Record<string, BotSession>> {
  if (cache) return cache;
  try {
    cache = JSON.parse(await readFile(SESSIONS_FILE, "utf-8"));
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
    cache = {};
  }
  return cache!;
}

async function persist(): Promise<void> {
  if (!cache) return;
  try {
    await mkdir(join(process.cwd(), "data"), { recursive: true });
    await atomicWriteFile(SESSIONS_FILE, JSON.stringify(cache, null, 2));
  } catch (err) {
    console.error("[SessionManager] persist failed:", err);
  }
}

/**
 * Return the resumable session for a key, or undefined when a fresh session
 * is needed (no session, idle past SESSION_IDLE_HOURS, or model changed).
 */
export async function getResumableSession(
  sessionKey: string,
  agentName: string,
  model: string
): Promise<BotSession | undefined> {
  try {
    const sessions = await load();
    const s = sessions[storageKey(sessionKey, agentName)];
    if (!s?.claudeSessionId) return undefined;
    if (s.model !== model) return undefined;
    if (Date.now() - s.lastActivity > IDLE_HOURS * 3_600_000) return undefined;
    return s;
  } catch {
    return undefined;
  }
}

/** Convenience wrapper: just the Claude session ID to --resume. */
export async function getResumableSessionId(
  sessionKey: string,
  agentName: string,
  model: string
): Promise<string | undefined> {
  return (await getResumableSession(sessionKey, agentName, model))
    ?.claudeSessionId;
}

/**
 * Take (return + remove) a session that exists but is no longer resumable
 * (idle past the window or model changed) — the caller can distill it once.
 * Returns undefined when there is no session or it is still resumable.
 */
export async function takeExpiredSession(
  sessionKey: string,
  agentName: string,
  model: string
): Promise<BotSession | undefined> {
  try {
    const sessions = await load();
    const key = storageKey(sessionKey, agentName);
    const s = sessions[key];
    if (!s?.claudeSessionId) return undefined;
    const stillValid =
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
 * Record a successful turn: bind the (possibly new) Claude session ID to the
 * session key and bump activity.
 */
export async function recordSessionTurn(
  sessionKey: string,
  agentName: string,
  model: string,
  claudeSessionId: string,
  memoryWatermark = Date.now()
): Promise<void> {
  try {
    const sessions = await load();
    const key = storageKey(sessionKey, agentName);
    const existing = sessions[key];
    const now = Date.now();
    const sameSession = existing?.claudeSessionId === claudeSessionId;
    sessions[key] = {
      key,
      agentName,
      claudeSessionId,
      model,
      memoryWatermark,
      startedAt: sameSession ? existing.startedAt : now,
      lastActivity: now,
      messageCount: sameSession ? existing.messageCount + 1 : 1,
    };
    await persist();
  } catch (err) {
    console.error("[SessionManager] recordSessionTurn failed:", err);
  }
}

/**
 * Reset sessions for a session key (manual /new, resume failure).
 * Without agentName, all agents' sessions under that key are reset.
 */
export async function resetSession(
  sessionKey: string,
  agentName?: string
): Promise<number> {
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
  const sessions = await load();
  const keys = Object.keys(sessions).filter((k) => k.startsWith(`${sessionKey}:`));
  if (!keys.length) return 0;
  const removed = keys.map((k) => [k, sessions[k]] as const);
  for (const k of keys) delete sessions[k];
  try {
    await mkdir(join(process.cwd(), "data"), { recursive: true });
    await atomicWriteFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
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
