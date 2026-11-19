/**
 * engine-switch-state: Ablage der Wechselregel (M14-04, Entscheidung 0027).
 * Lesen ist synchron; Änderungen laufen in einer Kette und unter Dateisperre.
 * Fehler dürfen nie eine fertige Antwort verwerfen. mutate muss rein sein und
 * darf mehrfach laufen, beim Nachholen auch auf einem fremd geänderten Stand.
 * Nach einem Sperrfehler gibt es 30 Sekunden lang nur Versuche ohne Warten.
 * Höchstens 128 offene Funktionen: beim Überlauf ersetzt ein Speicherstand
 * die Liste und beim nächsten Schreiben die Datei, auch fremde Änderungen.
 * Spätere Änderungen werden wieder der Reihe nach auf diesen Stand angewandt.
 * Offene Änderungen gehen beim Neustart verloren; kein Schreiben beim Beenden.
 */
import { readFileSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { atomicWriteFile } from "./atomic-file";
import type { FailureCounter, StageId, SwitchBlock, SwitchHint, SwitchNotices, SwitchState } from "./engine-switch";
import { ENGINE_IDS, type EngineId } from "./engines/types";
import { isUsageWindowId, type UsageWindowId } from "./engines/usage";
import { acquireFileLock, releaseFileLock, tryAcquireFileLock } from "./file-lock";

const LOCK_WAIT_MS = 2_000;
const LOCK_COOLDOWN_MS = 30_000;
const MAX_PENDING = 128;
const LOG_GAP_MS = 60_000;
const engine = z.custom<EngineId>(value => ENGINE_IDS.includes(value as EngineId));
const timestamp = z.string().datetime({ offset: true }).refine(value => Number.isFinite(Date.parse(value)));
const nonempty = z.string().refine(value => value.trim().length > 0);
const blockSchema = z.object({
  engine,
  cause: z.enum(["threshold", "limit", "outage"]),
  since: timestamp,
  until: timestamp,
  resetKnown: z.boolean(),
  percent: z.number().finite().min(0).max(100).optional(),
  window: z.custom<UsageWindowId>(isUsageWindowId).optional(),
  family: z.enum(["fable", "opus", "sonnet", "haiku"]).optional(),
  model: nonempty.optional(),
}).refine(block => [block.window, block.family, block.model].filter(value => value !== undefined).length <= 1);
const counterSchema = z.object({
  engine,
  kind: z.enum(["limit", "outage"]),
  scope: nonempty,
  count: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  lastAt: timestamp,
});
const releasedSchema = z.record(engine, timestamp);
const autoSchema = z.object({
  enabled: z.boolean(), threshold: z.number().finite(), returnBelow: z.number().finite(),
}).refine(auto => auto.returnBelow < auto.threshold);
const stage = z.custom<StageId>(value => typeof value === "string"
  && (ENGINE_IDS.includes(value as EngineId) || /^claude:\S.*$/.test(value)));
const pendingSchema = z.object({
  id: nonempty, text: nonempty, createdAt: timestamp,
  attempts: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), nextAt: timestamp,
  claimedAt: timestamp.optional(),
});
const hintSchema = z.object({ stage, at: timestamp, agent: nonempty.optional() });

/** Fehlerhafte Teile fallen einzeln weg, gültige wartende Meldungen bleiben erhalten. */
function parseNotices(value: unknown): SwitchNotices | undefined {
  const object = z.record(z.unknown()).safeParse(value);
  if (!object.success) return undefined;
  const raw = object.data;
  const entries = <T>(value: unknown, key: z.ZodTypeAny, schema: z.ZodType<T, z.ZodTypeDef, unknown>) => {
    const object = z.record(z.unknown()).safeParse(value);
    return object.success ? Object.fromEntries(Object.entries(object.data).flatMap(([name, entry]) => {
      const parsed = schema.safeParse(entry);
      return key.safeParse(name).success && parsed.success ? [[name, parsed.data]] : [];
    })) : undefined;
  };
  const announced = z.union([stage, z.literal("none")]).safeParse(raw.announced);
  const left = entries(raw.left, stage, z.enum(["threshold", "limit", "outage"]));
  const outageNoticeAt = entries(raw.outageNoticeAt, engine, timestamp);
  const hinted = entries(raw.hinted, nonempty, hintSchema);
  const pending = Array.isArray(raw.pending) ? parseEntries(raw.pending, pendingSchema) : undefined;
  return {
    ...(announced.success ? { announced: announced.data } : {}),
    ...(left ? { left } : {}), ...(outageNoticeAt ? { outageNoticeAt } : {}),
    ...(pending ? { pending: pending.filter((item, i) => pending.findIndex(other => other.id === item.id) === i) } : {}),
    ...(hinted ? { hinted: Object.fromEntries(Object.entries(hinted)
      .sort((a, b) => Date.parse(b[1].at) - Date.parse(a[1].at)).slice(0, 500)) } : {}),
  };
}

type Mutation = (state: SwitchState) => SwitchState;
export interface SwitchStateResult {
  state: SwitchState;
  persisted: boolean;
}
interface Cache {
  file: string;
  state: SwitchState;
  /** undefined: noch nicht gelesen; null: Datei fehlt. */
  stamp?: string | null;
  pending: Mutation[];
  replacement?: SwitchState;
  retryWaitAfter: number;
}
let testFile: string | undefined;
let lockWaitMs = LOCK_WAIT_MS;
let cache: Cache | undefined;
let lockChain: Promise<unknown> = Promise.resolve();
let lastWarning: number | undefined;
let writeFile = atomicWriteFile;
const listeners = new Set<() => void | Promise<void>>();
const hintWrites = new Map<string, { hint: SwitchHint | undefined }>();

/** Ein noch schreibender Merker gilt sofort, auch wenn die Dateisperre belegt ist. */
export function readSwitchHint(sessionKey: string): SwitchHint | undefined {
  return hintWrites.has(sessionKey) ? hintWrites.get(sessionKey)!.hint : readSwitchState().notices?.hinted?.[sessionKey];
}

export function rememberSwitchHint(sessionKey: string, hint: SwitchHint | undefined): void {
  if (readSwitchHint(sessionKey)?.stage === hint?.stage) return;
  const write = { hint };
  hintWrites.set(sessionKey, write);
  void updateSwitchState(state => {
    const hinted = { ...state.notices?.hinted };
    if (hint) hinted[sessionKey] = hint;
    else delete hinted[sessionKey];
    return { ...state, notices: { ...state.notices, hinted } };
  }).then(() => { if (hintWrites.get(sessionKey) === write) hintWrites.delete(sessionKey); });
}

export async function settleSwitchStateForTests(): Promise<void> { await lockChain; }

/** Erst der Bot meldet sich an. Schreiber in anderen Prozessen haben keine Nebenwirkung. */
export function onSwitchStateChanged(listener: () => void | Promise<void>): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

const emptyState = (): SwitchState => ({ version: 1, blocks: [], counters: [] });

/** Nur nach abgeschlossenen Aufrufen verwenden; stellt einen Neustart nach. */
export function resetSwitchStateForTests(): void {
  cache = undefined;
  lockChain = Promise.resolve();
  lastWarning = undefined;
  writeFile = atomicWriteFile;
  listeners.clear();
  hintWrites.clear();
}

/** Nur für Tests: Schreibfehler nach erfolgreichem Erwerb der Sperre auslösen. */
export function setSwitchStateWriterForTests(writer: typeof atomicWriteFile | null): void {
  writeFile = writer ?? atomicWriteFile;
}

/** null stellt den dynamischen Standardpfad wieder her; höchstens zwei Sekunden. */
export function setSwitchStateFileForTests(file: string | null, waitMs = LOCK_WAIT_MS): void {
  testFile = file ?? undefined;
  lockWaitMs = Number.isFinite(waitMs) ? Math.max(0, Math.min(LOCK_WAIT_MS, waitMs)) : LOCK_WAIT_MS;
  resetSwitchStateForTests();
}

function currentCache(): Cache {
  const file = testFile ?? (process.env.ENGINE_SWITCH_FILE_PATH || join(process.cwd(), "data", "engine-switch.json"));
  if (cache?.file !== file) cache = { file, state: emptyState(), pending: [], retryWaitAfter: 0 };
  return cache;
}

/** Ein Takt für alle Fehlerarten; weder Zustand noch fremde Fehlertexte loggen. */
function warn(message: string): void {
  const now = Date.now();
  if (lastWarning !== undefined && now >= lastWarning && now - lastWarning < LOG_GAP_MS) return;
  lastWarning = now;
  try { console.warn(`[EngineSwitchState] ${message}`); } catch { /* Auch das Log darf keinen Turn beenden. */ }
}

function parseEntries<T>(value: unknown, schema: z.ZodType<T, z.ZodTypeDef, unknown>): T[] {
  if (!Array.isArray(value)) {
    warn("Ungültige Zustandsfelder gelten als leer.");
    return [];
  }
  return value.flatMap(entry => {
    const parsed = schema.safeParse(entry);
    if (parsed.success) return [parsed.data];
    warn("Ungültige Zustandseinträge werden ausgelassen.");
    return [];
  });
}

/** Nur eine falsche Wurzel oder Version verwirft auch unbekannte Zusatzfelder. */
function parseState(value: unknown): SwitchState {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || !("version" in value) || value.version !== 1) {
    warn("Ungültiger Zustand gilt als leer.");
    return emptyState();
  }
  const raw = value as Record<string, unknown>;
  const state: SwitchState = {
    ...raw, version: 1,
    blocks: parseEntries(raw.blocks, blockSchema) as SwitchBlock[],
    counters: parseEntries(raw.counters, counterSchema) as FailureCounter[],
  };
  // Ungültige optionale Felder vollständig entfernen, nicht als undefined behalten.
  const { released: _released, auto: _auto, notices: _notices, ...rest } = state;
  const released = releasedSchema.safeParse(raw.released);
  const auto = autoSchema.safeParse(raw.auto);
  if ((raw.released !== undefined && !released.success) || (raw.auto !== undefined && !auto.success)) {
    warn("Ungültige optionale Zustandsfelder werden ausgelassen.");
  }
  const notices = parseNotices(raw.notices);
  return { ...rest, ...(released.success ? { released: released.data } : {}), ...(auto.success ? { auto: auto.data } : {}),
    ...(notices ? { notices } : {}) };
}

function fileStamp(file: string): string | null {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}:${stat.ino}`;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Echte Lesefehler gehen an den Rückfall im Aufrufer, kaputter Inhalt nicht. */
function loadState(file: string, stamp = fileStamp(file)): { state: SwitchState; stamp: string | null } {
  if (stamp === null) return { state: emptyState(), stamp };
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: emptyState(), stamp: null };
    throw error;
  }
  try {
    return { state: parseState(JSON.parse(raw)), stamp };
  } catch {
    warn("Ungültige Zustandsdatei gilt als leer.");
    return { state: emptyState(), stamp };
  }
}

/** Liest ohne Datei oder Ordner anzulegen und gibt keine veränderbare Cache-Referenz heraus. */
export function readSwitchState(): SwitchState {
  try {
    const current = currentCache();
    if (hasPending(current)) return structuredClone(current.state);
    const stamp = fileStamp(current.file);
    if (stamp !== current.stamp) Object.assign(current, loadState(current.file, stamp));
    return structuredClone(current.state);
  } catch {
    warn("Zustand nicht lesbar; der letzte Stand im Arbeitsspeicher gilt weiter.");
    return structuredClone(cache?.state ?? emptyState());
  }
}

function hasPending(current: Cache): boolean {
  return current.pending.length > 0 || current.replacement !== undefined;
}

/** Eine werfende oder nicht als JSON ablegbare Änderung entfällt vollständig. */
function applyMutation(state: SwitchState, mutate: Mutation): SwitchState | undefined {
  try {
    return parseState(JSON.parse(JSON.stringify(mutate(structuredClone(state)))));
  } catch {
    warn("Änderung fehlgeschlagen; der bisherige Zustand bleibt erhalten.");
    return undefined;
  }
}

async function acquireStateLock(current: Cache) {
  try {
    await mkdir(dirname(current.file), { recursive: true });
    const lockPath = `${current.file}.lock`;
    const owner = Date.now() < current.retryWaitAfter || lockWaitMs === 0
      ? await tryAcquireFileLock(lockPath)
      : await acquireFileLock(lockPath, { waitMs: lockWaitMs, pollMs: 10 });
    if (!owner) throw new Error("Dateisperre belegt");
    return owner;
  } catch (error) {
    if (Date.now() >= current.retryWaitAfter) current.retryWaitAfter = Date.now() + LOCK_COOLDOWN_MS;
    throw error;
  }
}

function rememberMutation(current: Cache, mutate: Mutation): void {
  const state = applyMutation(current.state, mutate);
  if (!state) return;
  current.state = state;
  if (current.pending.length < MAX_PENDING) {
    // Auch ein lokaler Leerlauf kann auf einem fremden Stand eine Wirkung haben.
    current.pending.push(mutate);
  } else {
    current.replacement = state;
    current.pending = [];
    warn("Zu viele offene Änderungen; beim nächsten Schreiben ersetzt der Speicherstand die Datei.");
  }
}

async function updateUnderLock(current: Cache, mutate: Mutation): Promise<SwitchStateResult> {
  let mutationFailed = false;
  try {
    const owner = await acquireStateLock(current);
    try {
      const stored = loadState(current.file);
      if (!hasPending(current)) Object.assign(current, stored);
      let state = current.replacement ?? stored.state;
      for (const pending of current.pending) state = applyMutation(state, pending) ?? state;
      const changed = applyMutation(state, mutate);
      mutationFailed = changed === undefined;
      state = changed ?? state;
      // Gegen die Datei vergleichen, damit auch ein neuer Leerlauf Altes nachholt.
      if (!isDeepStrictEqual(state, stored.state)) {
        await writeFile(current.file, JSON.stringify(state, null, 2) + "\n");
        // Noch unter der Sperre, damit Inhalt und Kennwerte zusammengehören.
        current.stamp = undefined;
        try { current.stamp = fileStamp(current.file); } catch { warn("Kennwerte der Zustandsdatei nicht lesbar."); }
      } else {
        current.stamp = stored.stamp;
      }
      current.state = state;
      current.pending = [];
      current.replacement = undefined;
      return { state: structuredClone(state), persisted: true };
    } finally {
      await releaseFileLock(`${current.file}.lock`, owner).catch(() => { warn("Dateisperre konnte nicht freigegeben werden."); });
    }
  } catch {
    if (!mutationFailed) rememberMutation(current, mutate);
    warn("Zustand nicht gespeichert (Lesen, Dateisperre oder Schreiben).");
    return { state: structuredClone(current.state), persisted: false };
  }
}

/**
 * Kein Aufrufer muss einen Fehler behandeln; auch eine gescheiterte Änderung
 * löst die Kette. persisted ist auch ohne Schreiben wahr, wenn der Zustand der
 * gelesenen Datei entspricht (fehlend gilt als leer) und nichts mehr offen ist.
 */
export async function updateSwitchState(mutate: Mutation): Promise<SwitchStateResult> {
  try {
    const current = currentCache();
    const run = lockChain.catch(() => {}).then(async () => {
      const before = readSwitchState().blocks;
      const result = await updateUnderLock(current, mutate);
      if (!isDeepStrictEqual(before, result.state.blocks)) {
        for (const listener of listeners) {
          void Promise.resolve().then(listener).catch(() => warn("Zuhörer für Sperränderungen fehlgeschlagen."));
        }
      }
      return result;
    });
    lockChain = run;
    return await run;
  } catch {
    warn("Zustandsänderung fehlgeschlagen; der letzte Stand im Arbeitsspeicher gilt weiter.");
    return { state: structuredClone(cache?.state ?? emptyState()), persisted: false };
  }
}
