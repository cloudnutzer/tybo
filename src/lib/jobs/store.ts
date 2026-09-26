/**
 * Hintergrund-Jobs (Issue #103, Entscheidung 0016): Ablage und Status.
 *
 * Jeder Job hat einen Ordner data/jobs/<id>/ mit brief.md (Auftrag),
 * job.log (Ausgabe von Claude), watcher.log (Ausgabe des Wächters),
 * status.json und am Ende report.md (schreibt der Job selbst).
 *
 * Status-Übergänge: starting → running → ended, oder direkt starting →
 * ended (Start gescheitert, vor dem Start gestoppt). ended ist endgültig:
 * Wer einen Job beendet (Wächter, stop, Zeitüberschreitung, Aufräumen beim
 * Bot-Start), muss den Übergang nach ended selbst gewinnen (claimOutcome).
 * Genau dieser Gewinner meldet sich, alle anderen schweigen. So gibt es
 * pro Job einen einzigen logischen Abschluss, auch wenn stop,
 * Zeitüberschreitung und Prozessende gleichzeitig kommen.
 *
 * Wer mit stop, Zeitüberschreitung oder Abbruch gewinnt, muss danach noch
 * Claudes Prozessgruppe beenden. Das steht als termination "pending" im
 * Status, bevor irgendetwas beendet wird; stirbt der Gewinner vorher,
 * setzt recoverJobs die Beendigung fort und meldet erst danach.
 *
 * Jede Änderung läuft unter einer Datei-Sperre (src/lib/file-lock.ts), weil
 * Starter, Wächter, `job stop` und der Bot verschiedene Prozesse sind.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { atomicWriteFile } from "../atomic-file";
import { acquireFileLock, releaseFileLock, type FileLockOptions } from "../file-lock";
import type { TerminateResult } from "./process";

/** 20260925-143012-a1b2c3: Startzeit (UTC) und Zufall */
export const JOB_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

export type JobPhase = "starting" | "running" | "ended";

export type JobOutcome =
  /** Exit 0 und report.md vorhanden */
  | "success"
  /** Exit-Code ungleich 0 oder durch ein Signal beendet */
  | "failed"
  /** Exit 0, aber kein Bericht */
  | "no_report"
  | "timeout"
  | "stopped"
  /** Wächter lief nicht mehr (Absturz, Neustart des Rechners) */
  | "aborted"
  /** Wächter oder Claude ließ sich nicht starten */
  | "start_failed";

/** Prozess mit Startzeit (ps lstart), damit eine wiederverwendete PID nicht als derselbe Prozess gilt */
export interface ProcRef {
  pid: number;
  /** null: Startzeit war nicht ermittelbar, dann zählt nur die PID */
  identity: string | null;
}

/** Rückmeldeziel, beim Start geprüft und festgehalten (nie erst im Wächter aus der Umgebung) */
export interface JobTarget {
  chatId?: string;
  topicId?: number;
}

export interface JobNotice {
  /** pending: noch zu senden; sending: Versuch läuft; sent/failed: erledigt */
  state: "pending" | "sending" | "sent" | "failed";
  attempts: number;
  /** Wer die Meldung schickt; stirbt er, übernimmt das Aufräumen beim Bot-Start */
  owner?: ProcRef & { token: string };
  /** Nur bei sent: auch für die WebUI festgehalten */
  recorded?: boolean;
  /** Letzter Fehler, ohne Inhalt */
  error?: string;
  at?: string;
}

/** Beenden von Claudes Prozessgruppe nach stop, Zeitüberschreitung oder Abbruch */
export interface JobTermination {
  /** pending: steht noch aus (auch wenn der Gewinner inzwischen tot ist); done: erledigt */
  state: "pending" | "done";
  result?: TerminateResult;
}

export interface JobStatus {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  phase: JobPhase;
  outcome?: JobOutcome;
  exitCode?: number | null;
  signal?: string | null;
  /** Kurze Begründung (Startfehler, Zeitüberschreitung), ohne Geheimnisse */
  detail?: string;
  maxHours: number;
  model: string;
  effort?: string;
  /** --full-access: bypassPermissions, sonst acceptEdits */
  fullAccess: boolean;
  target: JobTarget;
  watcher?: ProcRef;
  claude?: ProcRef;
  termination?: JobTermination;
  notice?: JobNotice;
}

export function isValidJobId(id: string): boolean {
  return JOB_ID_PATTERN.test(id);
}

export function newJobId(now: Date = new Date(), random: () => string = () => randomBytes(3).toString("hex")): string {
  const iso = now.toISOString();
  const stamp = `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 19).replace(/:/g, "")}`;
  return `${stamp}-${random()}`;
}

export function jobsDir(root: string): string {
  return join(root, "data", "jobs");
}

/** Ordner eines Jobs; wirft bei ungültiger ID oder einem Pfad außerhalb von data/jobs */
export function jobDir(root: string, id: string): string {
  if (!isValidJobId(id)) throw new Error("ungültige Job-ID");
  const base = resolve(jobsDir(root));
  const dir = resolve(base, id);
  if (!dir.startsWith(base + sep)) throw new Error("Job-ID verlässt data/jobs");
  return dir;
}

export const JOB_FILES = {
  brief: "brief.md",
  log: "job.log",
  watcherLog: "watcher.log",
  status: "status.json",
  report: "report.md",
  lock: "status.lock",
} as const;

export function jobFile(root: string, id: string, name: keyof typeof JOB_FILES): string {
  return join(jobDir(root, id), JOB_FILES[name]);
}

function parseStatus(raw: string, id: string): JobStatus | null {
  try {
    const status = JSON.parse(raw);
    if (status?.version !== 1 || status.id !== id || typeof status.title !== "string") return null;
    if (!["starting", "running", "ended"].includes(status.phase)) return null;
    return status as JobStatus;
  } catch {
    return null;
  }
}

export async function readStatus(root: string, id: string): Promise<JobStatus | null> {
  const raw = await readFile(jobFile(root, id, "status"), "utf8").catch(() => null);
  return raw === null ? null : parseStatus(raw, id);
}

export async function writeStatus(root: string, status: JobStatus): Promise<void> {
  await atomicWriteFile(jobFile(root, status.id, "status"), `${JSON.stringify(status, null, 2)}\n`);
}

/** Sperre länger als die 5 s von file-lock: ein Versand hält sie nie, nur kurze Lese-/Schreibvorgänge */
const LOCK_OPTIONS: FileLockOptions = { waitMs: 15_000 };

/**
 * Liest, ändert und schreibt den Status unter der Sperre. change bekommt
 * eine Kopie und gibt den neuen Status zurück oder null für „nichts ändern".
 * Ergebnis: der Status danach (bzw. unverändert) und ob geschrieben wurde.
 */
export async function updateStatus(
  root: string,
  id: string,
  change: (status: JobStatus) => JobStatus | null,
): Promise<{ status: JobStatus | null; changed: boolean }> {
  const lockPath = jobFile(root, id, "lock");
  const me = await acquireFileLock(lockPath, LOCK_OPTIONS);
  try {
    const current = await readStatus(root, id);
    if (!current) return { status: null, changed: false };
    const next = change(structuredClone(current));
    if (!next) return { status: current, changed: false };
    await writeStatus(root, next);
    return { status: next, changed: true };
  } finally {
    await releaseFileLock(lockPath, me);
  }
}

export interface ClaimExtra {
  exitCode?: number | null;
  signal?: string | null;
  detail?: string;
  /** Claudes Prozessgruppe muss noch beendet werden (stop, Zeitüberschreitung, Abbruch) */
  terminate?: boolean;
}

/**
 * Übergang nach ended. Nur der erste Aufrufer gewinnt (claimed true) und
 * bekommt die Meldung zugeteilt (notice pending, Besitzer owner); alle
 * späteren sehen ended und bekommen claimed false.
 */
export async function claimOutcome(
  root: string,
  id: string,
  outcome: JobOutcome,
  owner: ProcRef,
  extra: ClaimExtra = {},
  now: () => Date = () => new Date(),
): Promise<{ claimed: boolean; status: JobStatus | null; token?: string }> {
  const token = randomUUID();
  const result = await updateStatus(root, id, status => {
    if (status.phase === "ended") return null;
    status.phase = "ended";
    status.outcome = outcome;
    status.endedAt = now().toISOString();
    if (extra.exitCode !== undefined) status.exitCode = extra.exitCode;
    if (extra.signal !== undefined) status.signal = extra.signal;
    if (extra.detail !== undefined) status.detail = extra.detail;
    if (extra.terminate && status.claude) status.termination = { state: "pending" };
    status.notice = { state: "pending", attempts: 0, owner: { ...owner, token } };
    return status;
  });
  return result.changed ? { claimed: true, status: result.status, token } : { claimed: false, status: result.status };
}

/** Hält das Ergebnis der Beendigung fest, wenn token noch Besitzer der Meldung ist */
export async function recordTermination(root: string, id: string, token: string, result: TerminateResult): Promise<boolean> {
  const done = await updateStatus(root, id, status => {
    if (status.notice?.owner?.token !== token || status.termination?.state !== "pending") return null;
    status.termination = { state: "done", result };
    return status;
  });
  return done.changed;
}

/** Alle Job-IDs unter data/jobs (nur gültige Namen) */
export async function listJobIds(root: string): Promise<string[]> {
  const entries = await readdir(jobsDir(root), { withFileTypes: true }).catch(() => []);
  return entries.filter(e => e.isDirectory() && isValidJobId(e.name)).map(e => e.name).sort();
}

export async function readAllStatuses(root: string): Promise<JobStatus[]> {
  const ids = await listJobIds(root);
  const statuses = await Promise.all(ids.map(id => readStatus(root, id)));
  return statuses.filter((s): s is JobStatus => s !== null);
}
