/** Ausdrückliche Fortsetzung, mit derselben Startsperre wie ein neuer Auftrag. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireFileLock, releaseFileLock } from "../file-lock";
import { processGone } from "./process";
import { logSafe } from "./notice";
import { ANSWER_MAX_CHARS, safeAnswer } from "./question-file";
import { claimAnswer, type JobAnswer } from "./question-state";
import { findDuplicate, launchWatcher, STARTING_GRACE_MS, type JobDeps, type StartResult } from "./runner";
import { jobSessionPresent } from "./session";
import { claimResume, isValidJobId, jobFile, jobsDir, readStatus, resumeBlockReason, type JobStatus } from "./store";

export async function resumeJob(id: string, deps: JobDeps, expectedRun?: number): Promise<StartResult> {
  if (!isValidJobId(id)) return { ok: false, error: "Ungültige Job-ID." };
  const path = join(jobsDir(deps.root), "start.lock");
  let lock;
  let next: JobStatus;
  try {
    lock = await acquireFileLock(path, { waitMs: 15_000 });
    const status = await readStatus(deps.root, id);
    if (!status) return { ok: false, error: `Job ${id} gibt es nicht.` };
    if (expectedRun !== undefined && (status.run ?? 1) !== expectedRun) {
      return { ok: false, error: status.phase !== "ended" ? `Job ${id} läuft schon.` : "Dieser Knopf gehört zu einem älteren Lauf. Bitte die neueste Frage oder job resume verwenden." };
    }
    const grace = !status.watcher && deps.now().getTime() - Date.parse(status.runCreatedAt ?? status.createdAt) < STARTING_GRACE_MS;
    if (status.phase !== "ended" && status.phase !== "waiting" && !grace && processGone(status.watcher, deps.proc)) {
      return { ok: false, error: `Job ${id} ist noch als laufend eingetragen. Der Wächter fehlt; zuerst muss die Wiederherstellung (recoverJobs) den Abbruch sicher abschließen.` };
    }
    const reason = resumeBlockReason(status);
    if (reason) return { ok: false, error: reason };
    if (!(await jobSessionPresent(deps.root, status, deps.claudeEnv(status)))) {
      return { ok: false, error: "Die gespeicherte Claude-Session fehlt oder ist nicht lesbar. Kein frischer Lauf gestartet." };
    }
    const brief = await readFile(jobFile(deps.root, id, "brief"), "utf8");
    const twin = await findDuplicate(deps.root, status.title, brief, id);
    if (twin) return { ok: false, duplicateOf: twin.id, error: `Job ${twin.id} mit demselben Titel oder Auftrag läuft schon. Erst diesen Job abschließen.` };
    const claim = await claimResume(deps.root, id, status.run ?? 1, deps.now);
    if (!claim.changed || !claim.status) return { ok: false, error: claim.error };
    next = claim.status;
    try { await deps.expireResumeChoices?.(id); }
    catch { logSafe(deps, `[job] ${id}: Alte Fortsetzen-Frage nicht abgelaufen; ihr Lauf ist bereits ungültig`); }
  } catch {
    // Keine Dateipfade oder Session-IDs aus Fehlern weiterreichen.
    return { ok: false, error: "Fortsetzen konnte nicht sicher vorbereitet werden (Sperre oder Job-Dateien nicht verfügbar)." };
  } finally {
    if (lock) await releaseFileLock(path, lock);
  }
  return launchWatcher(next, deps);
}

export function resumeMessage(result: StartResult): string {
  if (!result.ok) return result.error;
  const state = result.status.phase === "ended" ? "beendet" : result.status.phase === "waiting" ? "wartet auf dich" : result.confirmed ? "läuft" : "startet";
  const budget = result.status.resumeReason === "answer" || result.status.resumeReason === "unanswered"
    ? "Das verbleibende Zeitbudget gilt weiter." : `Zeitlimit erneut ${result.status.maxHours} Std.`;
  return `Job ${result.id}: Lauf ${result.status.run ?? 1} ${state}. ${budget} Rückmeldung im bisherigen Gespräch.`;
}

/** Eigener Übergang für Fragen, ohne die Abbruch-Vorbedingungen von claimResume. */
export async function answerJob(id: string, answer: JobAnswer, deps: JobDeps): Promise<StartResult> {
  if (!isValidJobId(id) || !answer.text.trim() || answer.text.length > ANSWER_MAX_CHARS || !Number.isFinite(answer.at)) {
    return { ok: false, error: `Die Antwort muss 1 bis ${ANSWER_MAX_CHARS} Zeichen enthalten.` };
  }
  const path = join(jobsDir(deps.root), "start.lock");
  const lock = await acquireFileLock(path, { waitMs: 15_000 });
  let next: JobStatus;
  try {
    const status = await readStatus(deps.root, id);
    if (!status) return { ok: false, error: "Der Job existiert nicht mehr." };
    if (!(await jobSessionPresent(deps.root, status, deps.claudeEnv(status)))) {
      return { ok: false, error: "Die gespeicherte Claude-Session fehlt oder ist nicht lesbar. Kein frischer Lauf gestartet." };
    }
    const text = safeAnswer(answer.text, [...deps.secrets(), ...(status.sessionId ? [status.sessionId] : [])]);
    const claim = await claimAnswer(deps.root, id, { ...answer, text }, deps.now);
    if (!claim.changed || !claim.status) return { ok: false, error: "Diese Frage ist nicht mehr offen oder ihr Zeitbudget ist aufgebraucht. Bitte /jobs prüfen." };
    next = claim.status;
    try { await deps.expireResumeChoices?.(id); }
    catch { logSafe(deps, `[job] ${id}: Alte Frage nicht abgelaufen; ihr Lauf ist bereits ungültig`); }
  } finally {
    await releaseFileLock(path, lock);
  }
  return launchWatcher(next, deps);
}
