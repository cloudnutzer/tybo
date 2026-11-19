/**
 * Messwerte der Abo-Limits (M14-01), getrennt vom Token-Verbrauch EngineUsage.
 * Je Motor und Fenster gilt die jüngste Messung, unabhängig von ihrer Quelle.
 * Fehler der Ablage dürfen nie eine Antwort kosten. Keine Schreibkette: jeder
 * Aufruf wartet selbst höchstens zwei Sekunden auf die gemeinsame Dateisperre.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { atomicWriteFile } from "../atomic-file";
import { acquireFileLock, releaseFileLock } from "../file-lock";
import { ENGINE_IDS, type EngineId } from "./types";

export type UsageWindowId = "weekly_all" | "session" | `weekly_scoped:${string}` | `window_${number}`;
export type UsageSource = "stream" | "report" | "session-file" | "extern";

export interface UsageWindow {
  id: UsageWindowId;
  percent: number;
  resetsAt?: string;
  measuredAt: string;
  source: UsageSource;
}

export type UsageReading =
  | ({ state: "known" } & UsageWindow)
  | ({ state: "expired"; resetsAt: string } & Omit<UsageWindow, "percent" | "resetsAt">);

export interface RecordUsageResult {
  accepted: UsageWindowId[];
  rejected: { id: string | undefined; reason: "invalid" | "older" | "unsaved" }[];
}

export function isUsageWindowId(text: unknown): text is UsageWindowId {
  if (typeof text !== "string") return false;
  if (text === "weekly_all" || text === "session") return true;
  if (text.startsWith("weekly_scoped:")) {
    const name = text.slice("weekly_scoped:".length);
    return /^[a-z0-9 ._-]{1,40}$/.test(name) && name === name.trim();
  }
  return text === text.trim() && /^window_[1-9][0-9]{0,5}$/.test(text) && Number(text.slice(7)) <= 525_600;
}

/** Nur belegte Arten zuordnen; Zusatzguthaben ist kein Abo-Fenster. */
export function rateLimitWindowId(rateLimitType: unknown): UsageWindowId | undefined {
  switch (rateLimitType) {
    case "seven_day": return "weekly_all";
    case "five_hour": return "session";
    case "seven_day_opus": return "weekly_scoped:opus";
    case "seven_day_sonnet": return "weekly_scoped:sonnet";
    default: return undefined;
  }
}

export const FUTURE_TOLERANCE_MS = 60_000;
const LOCK_WAIT_MS = 2_000;
const LOG_GAP_MS = 60_000;
const timestamp = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));
const windowSchema = z.object({
  id: z.custom<UsageWindowId>(isUsageWindowId),
  percent: z.number().finite().min(0).max(100),
  resetsAt: timestamp.optional(),
  measuredAt: timestamp,
  source: z.enum(["stream", "report", "session-file", "extern"]),
});

type WindowsByEngine = Record<EngineId, UsageWindow[]>;
let testFile: string | undefined;
let lockWaitMs = LOCK_WAIT_MS;
const lastWarnings = new Map<"read" | "write", number>();

/** Nur für Tests; null stellt den Pfad aus der Umgebung und die Wartezeit zurück. */
export function setUsageFileForTests(file: string | null, waitMs = LOCK_WAIT_MS): void {
  testFile = file ?? undefined;
  lockWaitMs = Number.isFinite(waitMs) ? Math.max(0, Math.min(LOCK_WAIT_MS, waitMs)) : LOCK_WAIT_MS;
  lastWarnings.clear();
}

function usageFile(): string {
  return testFile ?? process.env.ENGINE_USAGE_FILE_PATH ?? join(process.cwd(), "data", "engine-usage.json");
}

function warn(kind: "read" | "write"): void {
  const now = Date.now();
  const previous = lastWarnings.get(kind);
  if (previous !== undefined && now >= previous && now - previous < LOG_GAP_MS) return;
  lastWarnings.set(kind, now);
  console.warn(kind === "read"
    ? "[EngineUsage] Datei fehlt oder Messwerte sind ungültig; betroffene Einträge gelten als leer."
    : "[EngineUsage] Messwerte nicht gespeichert (Dateisperre oder Schreibfehler).");
}

function emptyWindows(): WindowsByEngine {
  return { claude: [], codex: [], opencode: [], api: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseWindow(value: unknown, now: number): UsageWindow | undefined {
  const parsed = windowSchema.safeParse(value);
  if (!parsed.success || Date.parse(parsed.data.measuredAt) > now + FUTURE_TOLERANCE_MS) return undefined;
  return parsed.data;
}

/** Auch unbekannte Dateiversionen gelten als leer und werden beim Schreiben ersetzt. */
async function loadWindows(file: string, quietMissing = false): Promise<WindowsByEngine> {
  const windows = emptyWindows();
  try {
    const data: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!isRecord(data) || data.version !== 1 || !isRecord(data.engines)) {
      warn("read");
      return windows;
    }
    const now = Date.now();
    for (const engine of ENGINE_IDS) {
      const entry = data.engines[engine];
      if (entry === undefined) continue;
      if (!isRecord(entry) || !Array.isArray(entry.windows)) {
        warn("read");
        continue;
      }
      const byId = new Map<UsageWindowId, UsageWindow>();
      for (const value of entry.windows) {
        const window = parseWindow(value, now);
        if (!window) {
          warn("read");
          continue;
        }
        const previous = byId.get(window.id);
        if (!previous || Date.parse(window.measuredAt) >= Date.parse(previous.measuredAt)) byId.set(window.id, window);
      }
      windows[engine] = [...byId.values()];
    }
  } catch (error) {
    if (!(quietMissing && (error as NodeJS.ErrnoException)?.code === "ENOENT")) warn("read");
  }
  return windows;
}

/** Asynchron, immer alle vier Motoren. now ist Unix-Zeit in Millisekunden. */
export async function readUsage(now: number = Date.now(), options: { quietMissing?: boolean } = {}): Promise<Record<EngineId, UsageReading[]>> {
  const readings: Record<EngineId, UsageReading[]> = { claude: [], codex: [], opencode: [], api: [] };
  try {
    const windows = await loadWindows(usageFile(), options.quietMissing);
    for (const engine of ENGINE_IDS) {
      readings[engine] = windows[engine].map(window => {
        if (window.resetsAt !== undefined && Date.parse(window.resetsAt) <= now) {
          const { percent: _, ...expired } = window;
          return { ...expired, state: "expired", resetsAt: window.resetsAt };
        }
        return { ...window, state: "known" };
      });
    }
  } catch {
    warn("read");
  }
  return readings;
}

/**
 * Übernahme erst nach erfolgreichem atomarem Schreiben. Ungültige und ältere
 * Messungen behalten ihren Grund; nicht geschriebene gültige heißen unsaved.
 * Die Prüfung kopiert die Eingabe vor dem ersten Warten.
 */
export async function recordUsage(engine: EngineId, windows: readonly UsageWindow[], options: { signal?: AbortSignal } = {}): Promise<RecordUsageResult> {
  const result: RecordUsageResult = { accepted: [], rejected: [] };
  const valid: UsageWindow[] = [];
  try {
    options.signal?.throwIfAborted();
    const now = Date.now();
    for (const value of windows) {
      const window = ENGINE_IDS.includes(engine) ? parseWindow(value, now) : undefined;
      if (window) valid.push(window);
      else result.rejected.push({ id: typeof value?.id === "string" ? value.id : undefined, reason: "invalid" });
    }
    if (!valid.length) return result;
    const file = usageFile();
    const lockPath = `${file}.lock`;
    await mkdir(dirname(file), { recursive: true });
    const owner = await acquireFileLock(lockPath, { waitMs: lockWaitMs, pollMs: 10 });
    try {
      options.signal?.throwIfAborted();
      const stored = await loadWindows(file);
      const byId = new Map(stored[engine].map(window => [window.id, window]));
      for (const window of valid) {
        const previous = byId.get(window.id);
        if (previous && Date.parse(window.measuredAt) < Date.parse(previous.measuredAt)) {
          result.rejected.push({ id: window.id, reason: "older" });
        } else {
          byId.set(window.id, window);
          result.accepted.push(window.id);
        }
      }
      if (result.accepted.length) {
        stored[engine] = [...byId.values()];
        const engines = Object.fromEntries(ENGINE_IDS.map(id => [id, { windows: stored[id] }]));
        await atomicWriteFile(file, JSON.stringify({ version: 1, engines }, null, 2) + "\n", options);
      }
    } finally {
      await releaseFileLock(lockPath, owner);
    }
  } catch {
    if (!options.signal?.aborted) warn("write");
    // Vor dem Lesen unter der Sperre ist noch keine Auswahl getroffen.
    const unsaved = result.accepted.length ? result.accepted : valid.map(window => window.id);
    result.rejected.push(...unsaved.map(id => ({ id, reason: "unsaved" as const })));
    result.accepted = [];
  }
  return result;
}
