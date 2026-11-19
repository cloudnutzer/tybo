/** Stand der Codex-Limits aus dem Ende der Sitzungsdatei (M14-20). Nur lesend. */
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { codexHomeDir } from "../subprocess-env";
import { homeDirectory } from "./platform";
import type { UsageWindow, UsageWindowId } from "./usage";

const TAIL_BYTES = 256 * 1024;
const MAX_PATHS = 200;
const THREAD_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const defaultSource = {
  codexHome: () => codexHomeDir(process.env, homeDirectory()),
  now: () => Date.now(),
};
let source = defaultSource;
let paths = new Map<string, string>();
let loggedMissing = false;

/** Nur für Tests: kein Zugriff auf den echten Codex-Ordner; null stellt zurück. */
export function setCodexUsageSourceForTests(value: Partial<typeof defaultSource> | null): void {
  source = value ? { ...defaultSource, ...value } : defaultSource;
  paths = new Map();
  resetCodexUsageLogForTests();
}

export function resetCodexUsageLogForTests(): void {
  loggedMissing = false;
}

/** Auch beim Zeitlimit nur diese feste Zeile, nie Fehlertexte oder Quelldaten. */
export function logCodexUsageMissing(): void {
  if (loggedMissing) return;
  loggedMissing = true;
  console.warn("[CodexUsage] Kein Stand aus der Sitzungsdatei verfügbar; Messung bleibt unverändert.");
}

/** Tagesordner nach Ortszeit; setDate berücksichtigt auch Zeitumstellungen. */
export function codexSessionDay(now: number, daysAgo = 0): string {
  const date = new Date(now);
  date.setDate(date.getDate() - daysAgo);
  return join(String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0"));
}

function remember(cache: Map<string, string>, key: string, path: string): string {
  cache.delete(key);
  cache.set(key, path);
  if (cache.size > MAX_PATHS) cache.delete(cache.keys().next().value!);
  return path;
}

async function findSessionFile(home: string, threadId: string, now: number, cache: Map<string, string>, signal?: AbortSignal): Promise<string | undefined> {
  const key = join(home, threadId);
  const cached = cache.get(key);
  if (cached) {
    try {
      if ((await stat(cached)).isFile() && !signal?.aborted) return remember(cache, key, cached);
    } catch { /* Verschwundene Datei erneut suchen. */ }
    cache.delete(key);
  }
  for (let daysAgo = 0; daysAgo <= 7 && !signal?.aborted; daysAgo++) {
    const dir = join(home, "sessions", codexSessionDay(now, daysAgo));
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      if (signal?.aborted) return;
      const name = entries.filter(entry => entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(`-${threadId}.jsonl`))
        .map(entry => entry.name).sort().at(-1);
      if (name) return remember(cache, key, join(dir, name));
    } catch { /* Fehlende oder unlesbare Tagesordner sind keine Messung. */ }
  }
}

/** Nie mehr als 256 KiB, auch bei sehr großen oder weiter wachsenden Dateien. */
async function readTail(path: string, signal?: AbortSignal): Promise<string> {
  const file = await open(path, "r");
  try {
    if (signal?.aborted) return "";
    const info = await file.stat();
    if (!info.isFile() || signal?.aborted) return "";
    const length = Math.min(info.size, TAIL_BYTES);
    const start = info.size - length;
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length && !signal?.aborted) {
      const { bytesRead } = await file.read(buffer, offset, length - offset, start + offset);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (signal?.aborted) return "";
    const text = buffer.subarray(0, offset).toString("utf8");
    // Bei einem Ausschnitt ist die erste Zeile möglicherweise angeschnitten.
    if (start === 0) return text;
    const newline = text.indexOf("\n");
    return newline < 0 ? "" : text.slice(newline + 1);
  } finally {
    await file.close();
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Nur normalisierte Zeiten, die auch der gemeinsame Messvertrag annimmt. */
function isoTime(value: string | number): string | undefined {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() < 0 || date.getUTCFullYear() > 9999) return;
  return date.toISOString();
}

function usageWindow(value: unknown, measuredAt: string): UsageWindow | undefined {
  if (!object(value)) return;
  const minutes = value.window_minutes;
  const percent = value.used_percent;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes <= 0 || minutes > 525_600
    || typeof percent !== "number" || !Number.isFinite(percent)) return;
  const id: UsageWindowId = minutes === 10080 ? "weekly_all" : minutes === 300 ? "session" : `window_${minutes}`;
  const resetsAt = typeof value.resets_at === "number" ? isoTime(value.resets_at * 1000) : undefined;
  return { id, percent: Math.max(0, Math.min(100, percent)), ...(resetsAt ? { resetsAt } : {}), measuredAt, source: "session-file" };
}

function lastWindows(text: string, now: number): UsageWindow[] {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes("token_count")) continue;
    let line: unknown;
    try { line = JSON.parse(lines[i]); } catch { continue; }
    if (!object(line) || line.type !== "event_msg" || !object(line.payload) || line.payload.type !== "token_count"
      || !object(line.payload.rate_limits)) continue;
    const measuredAt = (typeof line.timestamp === "string" ? isoTime(line.timestamp) : undefined) ?? isoTime(now);
    if (!measuredAt) return [];
    const windows = new Map<UsageWindowId, UsageWindow>();
    for (const value of [line.payload.rate_limits.primary, line.payload.rate_limits.secondary]) {
      const window = usageWindow(value, measuredAt);
      if (!window) continue;
      const previous = windows.get(window.id);
      // Bei gleicher Dauer vorsichtig den höheren Stand nehmen; bei Gleichstand primary.
      if (!previous || window.percent > previous.percent) windows.set(window.id, window);
    }
    if (windows.size) return [...windows.values()];
  }
  return [];
}

/**
 * Keine Ablage hier: der Motor begrenzt das Warten auf zwei Sekunden und
 * verwirft späte Ergebnisse. Das Signal beendet weitere Lese-Schritte.
 */
export async function readCodexUsage(threadId: string, signal?: AbortSignal): Promise<UsageWindow[]> {
  const input = source;
  const cache = paths;
  try {
    if (signal?.aborted) return [];
    if (typeof threadId === "string" && THREAD_ID.test(threadId)) {
      const home = input.codexHome();
      const now = input.now();
      if (home && Number.isFinite(now)) {
        const path = await findSessionFile(home, threadId, now, cache, signal);
        if (path && !signal?.aborted) {
          const windows = lastWindows(await readTail(path, signal), input.now());
          if (!signal?.aborted && windows.length) return windows;
        }
      }
    }
  } catch { /* Format- und Dateifehler dürfen keine Antwort kosten. */ }
  if (!signal?.aborted) logCodexUsageMissing();
  return [];
}
