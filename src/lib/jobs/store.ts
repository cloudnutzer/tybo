/**
 * Hintergrund-Jobs (Issue #103, Entscheidung 0016): Ablage und Status.
 *
 * Jeder Job hat einen Ordner data/jobs/<id>/ mit brief.md (Auftrag),
 * job.log (Ausgabe von Claude), watcher.log (Ausgabe des Wächters),
 * status.json und am Ende report.md (schreibt der Job selbst).
 *
 * Status-Übergänge: starting → running → ended, oder direkt starting →
 * ended (Start gescheitert, vor dem Start gestoppt). ended gilt je Lauf:
 * Wer einen Job beendet (Wächter, stop, Zeitüberschreitung, Aufräumen beim
 * Bot-Start), muss den Übergang nach ended selbst gewinnen (claimOutcome).
 * Genau dieser Gewinner meldet sich, alle anderen schweigen. So gibt es
 * pro Lauf einen einzigen logischen Abschluss, auch wenn stop,
 * Zeitüberschreitung und Prozessende gleichzeitig kommen.
 * claimResume eröffnet unter derselben Sperre einen neuen Lauf, nur nach
 * sicherer Beendigung und abgeschlossenem Versand. Alte Wächter schreiben
 * ausschließlich in ihren eigenen Lauf (expectedRun).
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
import { mkdir, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { atomicWriteFile } from "../atomic-file";
import { acquireFileLock, releaseFileLock, type FileLockOptions } from "../file-lock";
import type { TerminateResult } from "./process";
import type { JobQuestion } from "./question-file";

/** 20260925-143012-a1b2c3: Startzeit (UTC) und Zufall */
export const JOB_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{6}$/;

export type JobPhase = "starting" | "running" | "waiting" | "ended";

export type JobOutcome =
  /** Exit 0 und report.md vorhanden */
  | "success"
  /** Exit-Code ungleich 0 oder durch ein Signal beendet */
  | "failed"
  /** Exit 0, aber kein Bericht */
  | "no_report"
  | "timeout"
  | "stopped"
  /** Wächter lief nicht mehr (Absturz, Neustart des Rechners oder des Bots) */
  | "aborted"
  /** Wächter oder Claude ließ sich nicht starten */
  | "start_failed"
  | "unanswered"
  | "question_limit"
  | "question_failed";

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

export type JobEngine = "claude" | "codex";

export interface JobReturn {
  run: number;
  state: "pending" | "claimed" | "done" | "discarded";
  owner?: ProcRef & { token: string };
}

export interface JobWaiting {
  number: number;
  question: JobQuestion;
  askedAt: string;
  deadlineAt: string;
  choiceId?: string;
  /** Telegram-Reply vor dem Laufwechsel dauerhaft sichern. */
  reply?: { text: string; at: number };
  delivery: JobNotice;
}

export interface JobStatus {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  /** Ohne Feld: erster Lauf eines älteren Jobs. */
  run?: number;
  /** Anlagezeit des aktuellen Laufs, für die Schonfrist vor dem Wächter-Eintrag. */
  runCreatedAt?: string;
  resumeReason?: "aborted" | "timeout" | "unanswered" | "answer";
  /** Anzahl der bereits gestellten Fragen, über alle Läufe hinweg. */
  questionCount?: number;
  waiting?: JobWaiting;
  /** Ausschließlich die maskierte Antwort, nie der Modelltext der Frage als Anweisung. */
  answer?: { text: string; questionNumber: number };
  /** Abgeschlossene Arbeitszeit aller Läufe, ohne Wartezeit. */
  activeMs?: number;
  /** Verbrauch seit dem letzten ausdrücklich erneuerten Zeitbudget. Antworten erneuern es nicht. */
  budgetUsedMs?: number;
  startedAt?: string;
  endedAt?: string;
  phase: JobPhase;
  outcome?: JobOutcome;
  exitCode?: number | null;
  signal?: string | null;
  /** Kurze Begründung (Startfehler, Zeitüberschreitung), ohne Geheimnisse */
  detail?: string;
  maxHours: number;
  /** Ohne Feld: älterer Job mit Claude */
  engine?: JobEngine;
  /** Feste Claude-Session; fehlt bei alten Jobs und bei Codex. Nie nach außen ausgeben. */
  sessionId?: string;
  /** Bei Codex ohne Angabe gilt dessen Konfiguration */
  model?: string;
  effort?: string;
  /** Volle Rechte ohne Rückfragen, sonst die eingeschränkte Stufe des Motors */
  fullAccess: boolean;
  /** Bericht zusätzlich als Eingabe ins Zielgespräch, bleibt beim Fortsetzen erhalten. */
  returnToChat?: boolean;
  /** Anzahl der --zurueck-Jobs in dieser Kette, erster Job = 1. */
  jobChain?: number;
  /** Persistente Rückgabe je Lauf, unter status.lock; keine zweite Warteschlange. */
  returnDelivery?: JobReturn;
  /** Zusätzlich erlaubte Werkzeuge (Recherche ohne --full-access, Issue #493) */
  allowedTools?: string[];
  /** Zusätzlich gesperrte Werkzeuge und Schreibregeln (Issue #493) */
  deniedTools?: string[];
  /** Eigener Arbeitsordner, Claude läuft dort eingeschränkt (Issue #493) */
  workDir?: string;
  target: JobTarget;
  watcher?: ProcRef;
  claude?: ProcRef;
  termination?: JobTermination;
  notice?: JobNotice;
  /** Prozesse aus dem Job, die nach Claudes Ende noch liefen (nicht beendet), Befehl maskiert */
  leftovers?: JobLeftover[];
}

/** Motor, Modell und Effort für Startausgabe, Liste und Log */
export function jobModelLabel(status: Pick<JobStatus, "engine" | "model" | "effort">): string {
  return [status.engine ?? "claude", status.model, status.effort].filter(Boolean).join(", ");
}

/** Prozess, den Claude gestartet hat und der Claude überlebt hat */
export interface JobLeftover {
  pid: number;
  command: string;
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
  question: "frage.json",
  lock: "status.lock",
} as const;

export function jobFile(root: string, id: string, name: keyof typeof JOB_FILES): string {
  return join(jobDir(root, id), JOB_FILES[name]);
}

function parseStatus(raw: string, id: string): JobStatus | null {
  try {
    const status = JSON.parse(raw);
    if (status?.version !== 1 || status.id !== id || typeof status.title !== "string") return null;
    if (!["starting", "running", "waiting", "ended"].includes(status.phase)) return null;
    if (status.phase === "waiting" && (!status.waiting || !Number.isSafeInteger(status.waiting.number) ||
      status.waiting.number < 1 || !Number.isFinite(Date.parse(status.waiting.deadlineAt)))) return null;
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
  change: (status: JobStatus) => JobStatus | null | Promise<JobStatus | null>,
): Promise<{ status: JobStatus | null; changed: boolean }> {
  const lockPath = jobFile(root, id, "lock");
  const me = await acquireFileLock(lockPath, LOCK_OPTIONS);
  try {
    const current = await readStatus(root, id);
    if (!current) return { status: null, changed: false };
    const next = await change(structuredClone(current));
    if (!next) return { status: current, changed: false };
    await writeStatus(root, next);
    return { status: next, changed: true };
  } finally {
    await releaseFileLock(lockPath, me);
  }
}

export interface ClaimExtra {
  /** Ein verspäteter Abschluss eines alten Laufs darf keinen neuen beenden. */
  expectedRun?: number;
  expectedPhase?: JobPhase;
  expectedQuestion?: number;
  exitCode?: number | null;
  signal?: string | null;
  detail?: string;
  /** Claudes Prozessgruppe muss noch beendet werden (stop, Zeitüberschreitung, Abbruch) */
  terminate?: boolean;
  leftovers?: JobLeftover[];
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
  const result = await updateStatus(root, id, async status => {
    if (status.phase === "ended" || (extra.expectedRun !== undefined && (status.run ?? 1) !== extra.expectedRun)) return null;
    if (extra.expectedPhase !== undefined && status.phase !== extra.expectedPhase) return null;
    if (extra.expectedQuestion !== undefined && status.waiting?.number !== extra.expectedQuestion) return null;
    accountWork(status, now());
    if (status.phase === "waiting") await archiveQuestion(root, status);
    status.phase = "ended";
    status.outcome = outcome;
    status.endedAt = now().toISOString();
    if (extra.exitCode !== undefined) status.exitCode = extra.exitCode;
    if (extra.signal !== undefined) status.signal = extra.signal;
    if (extra.detail !== undefined) status.detail = extra.detail;
    if (extra.leftovers?.length) status.leftovers = extra.leftovers;
    if (extra.terminate && status.claude && !status.waiting) status.termination = { state: "pending" };
    status.notice = { state: "pending", attempts: 0, owner: { ...owner, token } };
    if (status.returnToChat) status.returnDelivery = { run: status.run ?? 1, state: outcome === "success" ? "pending" : "discarded" };
    return status;
  });
  return result.changed ? { claimed: true, status: result.status, token } : { claimed: false, status: result.status };
}

/** Fachliche Vorbedingungen für Befehl, Knopf und den gesperrten Laufwechsel. */
export function resumeBlockReason(status: JobStatus): string | null {
  if (status.engine === "codex") return "Codex-Jobs lassen sich noch nicht fortsetzen.";
  if (status.workDir !== undefined) return "Jobs mit eigenem Arbeitsordner lassen sich noch nicht fortsetzen.";
  if (!status.sessionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(status.sessionId)) {
    return "Dieser ältere Job hat keine gespeicherte gültige Claude-Session.";
  }
  if (status.phase === "waiting") return `Job ${status.id} wartet auf dich. Bitte die Frage per Knopf oder Telegram-Reply beantworten.`;
  if (status.phase !== "ended") return `Job ${status.id} läuft schon oder startet gerade.`;
  if (status.outcome !== "aborted" && status.outcome !== "timeout" && status.outcome !== "unanswered") {
    return "Nur abgebrochene Jobs, Jobs mit überschrittener Zeit oder unbeantworteter Frage lassen sich fortsetzen; gestoppte oder sonst beendete Jobs nicht.";
  }
  if (!status.claude || !status.startedAt) return "Claude wurde für diesen Job noch nicht gestartet.";
  if (status.outcome !== "unanswered" && (status.termination?.state !== "done" || !["gone", "foreign"].includes(status.termination.result ?? ""))) {
    return "Die alte Prozessgruppe ist noch nicht sicher beendet. Fortsetzen ist deshalb gesperrt.";
  }
  if (status.notice?.state !== "sent" && status.notice?.state !== "failed") {
    return "Die Meldung des vorigen Laufs ist noch nicht abgeschlossen. Bitte später fortsetzen.";
  }
  return null;
}

/**
 * Einziger Übergang ended → starting. Der Aufrufer hält außerdem start.lock
 * gegen doppelte Aufträge. Erst der Gewinner darf einen Wächter starten.
 * Bericht und Log bleiben je altem Lauf erhalten, zählen aber nicht erneut.
 */
export async function claimResume(root: string, id: string, expectedRun: number, now: () => Date = () => new Date()) {
  let error = "Der Job wurde inzwischen verändert. Bitte den aktuellen Zustand prüfen.";
  const result = await updateStatus(root, id, async status => {
    const reason = resumeBlockReason(status);
    if (reason) { error = reason; return null; }
    if ((status.run ?? 1) !== expectedRun) return null;
    await archiveRunFiles(root, status);
    const reasonBefore = status.outcome as "aborted" | "timeout" | "unanswered";
    nextRun(status, now());
    status.resumeReason = reasonBefore;
    // Nur eine ausdrückliche Fortsetzung nach Abbruch/Timeout gewährt erneut Zeit.
    if (reasonBefore !== "unanswered") status.budgetUsedMs = 0;
    return status;
  });
  return { ...result, error: result.status ? error : `Job ${id} gibt es nicht.` };
}

/** Nur laufende Arbeit buchen; waiting und starting verbrauchen kein Budget. */
export function accountWork(status: JobStatus, now: Date): void {
  if (status.phase !== "running" || !status.startedAt) return;
  const ms = Math.max(0, now.getTime() - Date.parse(status.startedAt));
  status.activeMs = (status.activeMs ?? 0) + ms;
  status.budgetUsedMs = (status.budgetUsedMs ?? 0) + ms;
}

export function remainingWorkMs(status: JobStatus): number {
  return Math.max(0, status.maxHours * 3_600_000 - (status.budgetUsedMs ?? 0));
}

/** Aufrufer hält status.lock. Archiv enthält die geprüften und maskierten Daten. */
export async function archiveQuestion(root: string, status: JobStatus): Promise<void> {
  if (!status.waiting) return;
  const dir = join(jobDir(root, status.id), "fragen");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await atomicWriteFile(join(dir, `${status.waiting.number}.json`), JSON.stringify(status.waiting.question, null, 2) + "\n");
  await unlink(jobFile(root, status.id, "question")).catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
}

export async function archiveRunFiles(root: string, status: JobStatus): Promise<void> {
  for (const [name, prefix, ext] of [["report", "report", "md"], ["log", "job", "log"], ["question", "frage", "json"]] as const) {
    await rename(jobFile(root, status.id, name), join(jobDir(root, status.id), `${prefix}-run-${status.run ?? 1}.${ext}`))
      .catch((e: NodeJS.ErrnoException) => { if (e.code !== "ENOENT") throw e; });
  }
}

export function nextRun(status: JobStatus, now: Date): void {
  for (const field of ["watcher", "claude", "termination", "notice", "outcome", "startedAt", "endedAt", "exitCode", "signal", "detail", "leftovers", "waiting", "answer", "returnDelivery"] as const) delete status[field];
  status.phase = "starting";
  status.run = (status.run ?? 1) + 1;
  status.runCreatedAt = now.toISOString();
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
