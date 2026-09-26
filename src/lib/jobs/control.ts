/**
 * Hintergrund-Jobs auflisten, stoppen, Log lesen und beim Bot-Start
 * aufräumen (Issue #103).
 */

import { readFile } from "node:fs/promises";
import { maskSecrets } from "./mask";
import { jobDuration, logSafe, safeValues, settleAndDeliver, takeOverNotice, type NoticeDeps } from "./notice";
import { ownProcessRef, processGone, type TerminateResult } from "./process";
import { STARTING_GRACE_MS } from "./runner";
import { claimOutcome, jobFile, readAllStatuses, readStatus, type JobOutcome, type JobStatus } from "./store";

export type ControlDeps = NoticeDeps;

export const RECENT_ENDED = 20;

const OUTCOME_LABEL: Record<JobOutcome, string> = {
  success: "fertig",
  failed: "fehlgeschlagen",
  no_report: "ohne Bericht",
  timeout: "Zeit überschritten",
  stopped: "gestoppt",
  aborted: "abgebrochen",
  start_failed: "nicht gestartet",
};

export function statusLabel(status: JobStatus): string {
  if (status.phase === "starting") return "startet";
  if (status.phase === "running") return "läuft";
  const label = status.outcome ? OUTCOME_LABEL[status.outcome] : "beendet";
  return status.notice?.state === "failed" ? `${label}, Meldung nicht zugestellt` : label;
}

/** Laufende Jobs (alle) und die letzten 20 beendeten, jeweils neueste zuerst */
export function selectJobs(statuses: JobStatus[]): { active: JobStatus[]; ended: JobStatus[] } {
  const newest = (a: JobStatus, b: JobStatus) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
  const active = statuses.filter(s => s.phase !== "ended").sort(newest);
  const ended = statuses
    .filter(s => s.phase === "ended")
    .sort((a, b) => (b.endedAt ?? "").localeCompare(a.endedAt ?? "") || newest(a, b))
    .slice(0, RECENT_ENDED);
  return { active, ended };
}

/**
 * Übersicht für job list und /jobs. Die WebUI zeigt sie als Markdown (ohne
 * Steuer-Tags), deshalb gehen die Titel durch safeValues: maskiert, und ganz
 * verborgen, wenn eine Darstellung trotzdem einen Wert aus .env zeigen würde.
 */
export async function formatJobList(deps: Pick<ControlDeps, "root" | "now" | "secrets">): Promise<string> {
  const { active, ended } = selectJobs(await readAllStatuses(deps.root));
  if (!active.length && !ended.length) return "Keine Hintergrund-Jobs.";
  const now = deps.now();
  const jobs = [...active, ...ended];
  const render = (titles: readonly string[]) => {
    const line = (s: JobStatus, i: number) => `- ${s.id} · ${titles[i]} · ${statusLabel(s)} · ${jobDuration(s, now)}`;
    const lines = jobs.map(line);
    const parts: string[] = [];
    parts.push(active.length ? `Laufend (${active.length}):\n${lines.slice(0, active.length).join("\n")}` : "Laufend: keine");
    if (ended.length) parts.push(`Zuletzt beendet:\n${lines.slice(active.length).join("\n")}`);
    return parts.join("\n\n");
  };
  return render(safeValues(jobs.map(s => s.title), render, deps.secrets()));
}

/** Log des Jobs, Werte aus .env verborgen; null, wenn es den Job nicht gibt */
export async function jobLog(id: string, deps: Pick<ControlDeps, "root" | "secrets">): Promise<string | null> {
  if (!(await readStatus(deps.root, id))) return null;
  const log = await readFile(jobFile(deps.root, id, "log"), "utf8").catch(() => "");
  return log ? maskSecrets(log, deps.secrets()) : "(Log ist leer)";
}

export interface StopResult {
  ok: boolean;
  message: string;
  tree?: TerminateResult;
}

/**
 * Beendet einen laufenden Job: Übergang nach „gestoppt" gewinnen (mit
 * ausstehender Beendigung im Status), Claudes Prozessgruppe beenden
 * (Startzeit geprüft, SIGTERM, dann SIGKILL) und melden. Stirbt stop
 * dazwischen, setzt recoverJobs die Beendigung fort. Hat der Wächter Claude
 * noch nicht freigegeben, sieht er den Stopp und startet es nicht.
 */
export async function stopJob(id: string, deps: ControlDeps): Promise<StopResult> {
  const before = await readStatus(deps.root, id);
  if (!before) return { ok: false, message: `Job ${id} gibt es nicht` };
  if (before.phase === "ended") return { ok: false, message: `Job ${id} ist schon beendet (${statusLabel(before)})` };
  const claim = await claimOutcome(deps.root, id, "stopped", ownProcessRef(deps.proc), { terminate: true }, deps.now);
  if (!claim.claimed) {
    const now = await readStatus(deps.root, id);
    return { ok: false, message: `Job ${id} ist inzwischen beendet (${now ? statusLabel(now) : "unbekannt"})` };
  }
  const claude = claim.status?.claude;
  const tree: TerminateResult = (await settleAndDeliver(id, claim.token!, deps)).tree ?? "gone";
  const message =
    tree === "gone"
      ? `Job ${id} gestoppt.`
      : tree === "foreign"
        ? `Job ${id} als gestoppt vermerkt; der Claude-Prozess lief schon nicht mehr.`
        : tree === "unverified"
          ? `Job ${id} als gestoppt vermerkt, aber der Claude-Prozess (PID ${claude?.pid}) ließ sich nicht sicher zuordnen; kein Signal gesendet.`
          : `Job ${id} als gestoppt vermerkt, aber ein Prozess lebt noch (PID-Gruppe ${claude?.pid}).`;
  return { ok: tree === "gone" || tree === "foreign", message, tree };
}

export interface RecoverSummary {
  /** Als abgebrochen gemeldet */
  aborted: string[];
  /** Liegengebliebene Meldungen erneut gesendet */
  resent: string[];
  /** Noch in der Schonfrist ohne Wächter-Eintrag, später erneut prüfen */
  deferred: string[];
}

/**
 * Beim Bot-Start: Jobs, die als laufend eingetragen sind, deren Wächter
 * sicher nicht mehr lebt, als abgebrochen melden (und einen noch lebenden
 * Claude beenden). Ist nur die Startzeit des Wächters gerade nicht prüfbar,
 * bleibt der Job stehen. Abschlüsse, deren Gewinner starb, übernehmen: erst
 * eine noch ausstehende Beendigung der Prozessgruppe, dann die Meldung.
 * Jobs ohne Wächter-Eintrag innerhalb der Schonfrist stehen in deferred.
 */
export async function recoverJobs(deps: ControlDeps): Promise<RecoverSummary> {
  const summary: RecoverSummary = { aborted: [], resent: [], deferred: [] };
  const me = ownProcessRef(deps.proc);
  for (const status of await readAllStatuses(deps.root)) {
    try {
      if (status.phase !== "ended") {
        if (status.watcher && !processGone(status.watcher, deps.proc)) continue;
        // Ohne Wächter-Eintrag ist der Starter vielleicht noch dabei
        if (!status.watcher && deps.now().getTime() - Date.parse(status.createdAt) < STARTING_GRACE_MS) {
          summary.deferred.push(status.id);
          continue;
        }
        const detail =
          status.phase === "starting"
            ? "Der Job kam nicht in Gang, sein Wächter lief nicht mehr."
            : "Der Wächter lief nicht mehr (Absturz oder Neustart des Rechners), der Job wurde abgebrochen.";
        const claim = await claimOutcome(deps.root, status.id, "aborted", me, { detail, terminate: true }, deps.now);
        if (!claim.claimed) continue;
        await settleAndDeliver(status.id, claim.token!, deps);
        summary.aborted.push(status.id);
        continue;
      }
      const token = await takeOverNotice(status.id, me, deps);
      if (token && (await settleAndDeliver(status.id, token, deps)).delivered === "sent") summary.resent.push(status.id);
    } catch (e) {
      logSafe(deps, `[job] ${status.id}: Aufräumen gescheitert (${e instanceof Error ? e.message : "Fehler"})`);
    }
  }
  return summary;
}

/** Zusätzliche Wartezeit nach Ablauf der Schonfrist, bevor erneut geprüft wird */
const RECHECK_MARGIN_MS = 5_000;

/**
 * Für den Bot-Start: recoverJobs, und solange Jobs in der Schonfrist
 * zurückgestellt wurden, nach deren Ablauf noch einmal. So wird auch ein
 * Start gemeldet, dessen Starter und Wächter kurz vor dem Bot-Start starben,
 * ohne dass der Bot erneut starten muss.
 */
export async function recoverJobsUntilSettled(deps: ControlDeps): Promise<Omit<RecoverSummary, "deferred">> {
  const total = { aborted: [] as string[], resent: [] as string[] };
  for (;;) {
    const r = await recoverJobs(deps);
    total.aborted.push(...r.aborted);
    total.resent.push(...r.resent);
    if (!r.deferred.length) return total;
    const statuses = await Promise.all(r.deferred.map(id => readStatus(deps.root, id)));
    const youngest = Math.max(...statuses.map(s => (s ? Date.parse(s.createdAt) : 0)));
    const wait = youngest + STARTING_GRACE_MS + RECHECK_MARGIN_MS - deps.now().getTime();
    await deps.sleep(Math.max(RECHECK_MARGIN_MS, wait));
  }
}
