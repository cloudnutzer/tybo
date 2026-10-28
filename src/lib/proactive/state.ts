/**
 * Zustand der proaktiven Meldungen (Issue #361): data/proactive-state.json.
 *
 * Mehrere Prozesse teilen die Datei (Bot mit den Knöpfen, die Routinen für
 * Briefing und Check-in, auch zwei gleichzeitig gestartete Läufe). Jede
 * Änderung liest sie deshalb frisch unter einer Sperre mit Besitzer
 * (file-lock.ts, <datei>.lock) und ersetzt sie atomar (atomic-file.ts).
 * Lesen geht ohne Sperre. Ändert eine Änderung nichts, bleibt die Datei,
 * wie sie ist.
 *
 * Versand in zwei Schritten, damit nie doppelt gesendet wird und keiner die
 * Änderung des anderen überschreibt:
 * 1. reserveSend prüft unter der Sperre die Regeln (rules.ts) und hält eine
 *    Reservierung (claim) für die Art fest. Liegt schon eine lebende
 *    Reservierung vor, heißt das "busy".
 * 2. Während der Text entsteht, erneuert der Besitzer die Reservierung
 *    regelmäßig (renewClaim). Ein Lauf, der weiterarbeitet, verliert sie
 *    also nie durch Zeitablauf. Übernehmen darf ein anderer Lauf nur, wenn
 *    der Prozess des Besitzers nicht mehr lebt oder die letzte Erneuerung
 *    CLAIM_MAX_MS zurückliegt (Besitzer hängt).
 * 3. Unmittelbar vor dem Senden bestätigt der Besitzer unter der Sperre, dass
 *    die Reservierung noch seine ist und die Regeln mit der aktuellen Uhr
 *    und dem frisch gelesenen Zustand weiter erlauben (confirmSend), und
 *    markiert sie als "sending". Wurde sie inzwischen übernommen, hat das
 *    Zeitfenster geschlossen oder läuft inzwischen ein Snooze, sendet er
 *    nicht; im zweiten Fall gibt er die Reservierung frei. Eine
 *    Reservierung im Zustand sending verfällt nie durch Zeitablauf, nur mit
 *    dem Tod ihres Prozesses. So sendet höchstens einer.
 * 4. Nach dem Senden setzt finishSend die eigene Reservierung zurück (eine
 *    fremde bleibt stehen) und trägt, nur bei bestätigter Zustellung,
 *    lastSentAt und das Ortsdatum lastDate ein, ohne einen späteren Versand
 *    eines anderen Laufs zurückzudrehen. Alles andere (Snooze, die andere
 *    Art) liest es frisch und lässt es stehen.
 *
 * Eine kaputte Datei (kein JSON, kein Objekt) wird nie überschrieben: Ändern
 * wirft ProactiveStateBrokenError, der Lauf endet dann als Fehler.
 */

import { mkdir, readFile } from "fs/promises";
import { dirname, join } from "path";
import { atomicWriteFile } from "../atomic-file";
import { acquireFileLock, pidAlive, releaseFileLock } from "../file-lock";
import { randomUUID } from "crypto";
import { localMoment } from "./clock";
import { PROACTIVE_KINDS, type ProactiveKind } from "./config";
import type { KindRecord, SkipReason } from "./rules";

/**
 * Ohne Erneuerung in dieser Zeit gilt eine Reservierung als liegen
 * geblieben, auch wenn ihr Prozess noch lebt (nicht im Zustand sending)
 */
export const CLAIM_MAX_MS = 15 * 60_000;
/** So oft erneuert ein Besitzer seine Reservierung */
export const CLAIM_RENEW_MS = CLAIM_MAX_MS / 3;

export interface SendClaim {
  token: string;
  pid: number;
  /** Beginn der Reservierung (ISO) */
  since: string;
  /** Letzte Erneuerung (ISO); fehlt: since */
  renewedAt?: string;
  /** Bestätigt, der Versand läuft: verfällt nur mit dem Prozess */
  sending?: true;
}

export type KindState = KindRecord & { claim?: SendClaim };

export interface ProactiveState {
  briefing: KindState;
  checkin: KindState & { pendingItems: string[] };
  /** Wann die alten Dateien übernommen wurden (migrate.ts) */
  imported: { schedule?: string; checkinState?: string };
}

export class ProactiveStateBrokenError extends Error {
  constructor(path: string) {
    super(`${path} ist kaputt und wird nicht überschrieben`);
    this.name = "ProactiveStateBrokenError";
  }
}

export function proactiveStatePath(root: string = process.env.GO_PROJECT_ROOT || process.cwd()): string {
  return join(root, "data", "proactive-state.json");
}

export function emptyProactiveState(): ProactiveState {
  return { briefing: {}, checkin: { pendingItems: [] }, imported: {} };
}

const isText = (v: unknown): v is string => typeof v === "string" && v !== "";

function cleanClaim(raw: any): SendClaim | undefined {
  if (raw && isText(raw.token) && Number.isInteger(raw.pid) && isText(raw.since)) {
    const claim: SendClaim = { token: raw.token, pid: raw.pid, since: raw.since };
    if (isText(raw.renewedAt)) claim.renewedAt = raw.renewedAt;
    if (raw.sending === true) claim.sending = true;
    return claim;
  }
  return undefined;
}

function cleanKind(raw: any): KindState {
  const out: KindState = {};
  if (!raw || typeof raw !== "object") return out;
  if (isText(raw.lastSentAt)) out.lastSentAt = raw.lastSentAt;
  if (isText(raw.lastDate)) out.lastDate = raw.lastDate;
  if (isText(raw.snoozedUntil)) out.snoozedUntil = raw.snoozedUntil;
  const claim = cleanClaim(raw.claim);
  if (claim) out.claim = claim;
  return out;
}

/** Bringt gelesenes JSON in Form; unbekannte oder falsch getippte Felder fallen weg */
export function normalizeProactiveState(raw: unknown): ProactiveState {
  const r = (raw && typeof raw === "object" ? raw : {}) as any;
  const items = Array.isArray(r.checkin?.pendingItems) ? r.checkin.pendingItems.filter(isText) : [];
  const imported: ProactiveState["imported"] = {};
  if (isText(r.imported?.schedule)) imported.schedule = r.imported.schedule;
  if (isText(r.imported?.checkinState)) imported.checkinState = r.imported.checkinState;
  return { briefing: cleanKind(r.briefing), checkin: { ...cleanKind(r.checkin), pendingItems: items }, imported };
}

/** Was in der Datei wirklich stand, im Unterschied zu den Ersatzwerten von normalizeProactiveState */
export interface StoredFields {
  /** checkin.pendingItems stand als Liste in der Datei (auch leer) */
  pendingItems: boolean;
}

async function readRaw(path: string): Promise<{ state: ProactiveState; broken: boolean; stored: StoredFields }> {
  let text: string;
  try {
    text = await readFile(path, "utf-8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return { state: emptyProactiveState(), broken: false, stored: { pendingItems: false } };
    throw error;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("kein Objekt");
    const stored = { pendingItems: Array.isArray(parsed.checkin?.pendingItems) };
    return { state: normalizeProactiveState(parsed), broken: false, stored };
  } catch {
    return { state: emptyProactiveState(), broken: true, stored: { pendingItems: false } };
  }
}

/**
 * Für die Datei: eine leere pendingItems-Liste, die nie in der Datei stand,
 * bleibt weg. So unterscheidet die Übernahme (migrate.ts) einen fehlenden
 * Wert von einer bewusst geleerten Liste, auch wenn vorher etwas anderes
 * (etwa Snooze) den Zustand geschrieben hat.
 */
function forFile(state: ProactiveState, stored: StoredFields): unknown {
  if (stored.pendingItems || state.checkin.pendingItems.length > 0) return state;
  const { pendingItems: _, ...checkin } = state.checkin;
  return { ...state, checkin };
}

/** Zustand lesen ohne Sperre; fehlt oder ist kaputt: leerer Zustand */
export async function readProactiveState(path: string = proactiveStatePath()): Promise<ProactiveState> {
  return (await readRaw(path)).state;
}

/**
 * Liest frisch unter der Sperre, wendet mutate an und schreibt atomar zurück.
 * mutate darf asynchron sein (Übernahme in migrate.ts), die Sperre gilt bis
 * zu seinem Ende. stored sagt, welche Felder tatsächlich in der Datei standen.
 */
export async function updateProactiveState<T>(
  path: string,
  mutate: (state: ProactiveState, stored: StoredFields) => T | Promise<T>,
): Promise<T> {
  const lockPath = `${path}.lock`;
  await mkdir(dirname(path), { recursive: true });
  const owner = await acquireFileLock(lockPath, { waitMs: 10_000 });
  try {
    const { state, broken, stored } = await readRaw(path);
    if (broken) throw new ProactiveStateBrokenError(path);
    const before = JSON.stringify(state);
    const result = await mutate(state, { ...stored });
    // Unverändert: nicht neu schreiben
    if (JSON.stringify(state) !== before) await atomicWriteFile(path, JSON.stringify(forFile(state, stored), null, 2) + "\n");
    return result;
  } finally {
    await releaseFileLock(lockPath, owner);
  }
}

function claimActive(claim: SendClaim | undefined, now: Date, alive: (pid: number) => boolean): boolean {
  if (!claim || !alive(claim.pid)) return false;
  if (claim.sending) return true;
  const last = Date.parse(claim.renewedAt ?? claim.since);
  return Number.isFinite(last) && now.getTime() - last < CLAIM_MAX_MS;
}

export type Reservation = { ok: true; token: string } | { ok: false; reason: SkipReason | "busy" };

/** Regelprüfung auf dem frischen Datensatz einer Art (rules.ts judgeKind) */
export type Judge = (record: KindRecord) => { send: true } | { send: false; reason: SkipReason };

/**
 * Prüft und reserviert unter der Sperre. judge bekommt den frischen
 * Datensatz der Art (siehe rules.ts judgeKind).
 */
export function reserveSend(
  path: string,
  kind: ProactiveKind,
  now: Date,
  judge: Judge,
  isAlive: (pid: number) => boolean = pidAlive,
): Promise<Reservation> {
  return updateProactiveState(path, state => {
    const record = state[kind];
    if (claimActive(record.claim, now, isAlive)) return { ok: false, reason: "busy" } as const;
    const verdict = judge(record);
    if (!verdict.send) {
      // Eine liegen gebliebene Reservierung räumt jeder Lauf auf
      delete record.claim;
      return { ok: false, reason: verdict.reason } as const;
    }
    const token = randomUUID();
    record.claim = { token, pid: process.pid, since: now.toISOString() };
    return { ok: true, token } as const;
  });
}

/** Erneuert die eigene Reservierung; false: sie gehört nicht mehr diesem Lauf */
export function renewClaim(path: string, kind: ProactiveKind, token: string, now: Date): Promise<boolean> {
  return updateProactiveState(path, state => {
    const claim = state[kind].claim;
    if (claim?.token !== token) return false;
    if (!claim.sending) claim.renewedAt = now.toISOString();
    return true;
  });
}

export type Confirmation = { ok: true } | { ok: false; reason: SkipReason | "overtaken" };

/**
 * Letzter Schritt vor dem Senden, unter der Sperre: Ist die Reservierung
 * noch die eigene und erlaubt judge auf dem frisch gelesenen Datensatz mit
 * der unter der Sperre abgelesenen Uhr (now, als Funktion erst dort
 * aufgerufen) weiter den Versand, wird sie als sending
 * markiert (ok). Sonst nicht senden: "overtaken", wenn ein anderer Lauf sie
 * übernommen hat (sie bleibt dann seine), oder der Grund der Regel; dann ist
 * die eigene Reservierung freigegeben und keine Versandzeit gesetzt.
 */
export function confirmSend(
  path: string,
  kind: ProactiveKind,
  token: string,
  now: Date | (() => Date),
  judge: (record: KindRecord, at: Date) => ReturnType<Judge>,
): Promise<Confirmation> {
  return updateProactiveState(path, state => {
    const record = state[kind];
    const claim = record.claim;
    if (claim?.token !== token) return { ok: false, reason: "overtaken" } as const;
    // Uhr erst hier lesen: das Warten auf die Sperre zählt mit
    const at = typeof now === "function" ? now() : now;
    const verdict = judge(record, at);
    if (!verdict.send) {
      delete record.claim;
      return { ok: false, reason: verdict.reason } as const;
    }
    claim.renewedAt = at.toISOString();
    claim.sending = true;
    return { ok: true } as const;
  });
}

/**
 * Schließt den Versand ab: Reservierung weg (nur die eigene; eine fremde
 * bleibt stehen), bei Zustellung lastSentAt und lastDate (Ortsdatum in
 * zone) setzen, außer ein anderer Lauf hat schon später gesendet.
 * Ergebnis: Gehörte die Reservierung noch diesem Lauf?
 */
export function finishSend(path: string, kind: ProactiveKind, token: string, delivered: boolean, now: Date, zone: string): Promise<boolean> {
  return updateProactiveState(path, state => {
    const record = state[kind];
    const own = record.claim?.token === token;
    if (own) delete record.claim;
    const previous = Date.parse(record.lastSentAt ?? "");
    if (delivered && !(previous > now.getTime())) {
      record.lastSentAt = now.toISOString();
      record.lastDate = localMoment(now, zone).date;
    }
    return own;
  });
}

/** Snooze einer Art bis until; ein schon längerer Snooze bleibt */
export function snoozeKind(path: string, kind: ProactiveKind, until: Date): Promise<void> {
  if (!PROACTIVE_KINDS.includes(kind)) throw new Error(`unbekannte Art ${kind}`);
  return updateProactiveState(path, state => {
    const current = Date.parse(state[kind].snoozedUntil ?? "");
    if (!Number.isFinite(current) || current < until.getTime()) state[kind].snoozedUntil = until.toISOString();
  });
}
