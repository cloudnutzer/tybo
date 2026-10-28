/**
 * Routinen aus PM2 (Issue #284): die Prozessliste, die auch `pm2 jlist`
 * zeigt, nur Prozesse tybo-*.
 *
 * Nur lesend: Die PM2-CLI startet bei jedem Aufruf einen Daemon, wenn keiner
 * antwortet. Diese Quelle ruft sie darum nie auf, sondern fragt den
 * laufenden Daemon direkt (query, echt: queryPm2Daemon in ./pm2-rpc.ts).
 */

import { PM2_PREFIX } from "../../service-names";
import { classifySchedule, describeSchedule, type CronSchedule } from "../schedule";
import type { Routine, RoutineState } from "../types";
import type { Pm2Query } from "./pm2-rpc";

export interface Pm2SourceDeps {
  /** Prozessliste vom laufenden Daemon; startet nie einen */
  query(): Promise<Pm2Query>;
}

export const PM2_TEXT = {
  notRunning: "PM2 läuft nicht. tybo startet PM2 für die Übersicht nicht selbst.",
  listFailed: "PM2 hat keine lesbare Prozessliste geliefert.",
} as const;

interface Pm2Process {
  name?: unknown;
  pid?: unknown;
  pm2_env?: Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * cron_restart als Zeitplan; "0" (wie die Zahl 0) schaltet den Cron-Neustart
 * in PM2 ab und heißt darum: kein Zeitplan, Dauerdienst
 */
function cronOf(value: unknown): string | null {
  const cron = str(value);
  return cron === null || cron.trim() === "0" ? null : cron;
}

function stateFor(kind: Routine["kind"], status: string | null): RoutineState {
  if (!status) return "unknown";
  if (kind === "daemon") return status === "online" ? "running" : "stopped";
  // Zeitgesteuert: PM2 startet den Prozess per cron_restart neu, auch wenn er
  // zwischen den Läufen „stopped" ist (stopProcessId löscht den Cron nicht)
  return "active";
}

export async function readPm2Routines(deps: Pm2SourceDeps): Promise<{ routines: Routine[]; notes: string[] }> {
  const result = await deps.query().catch((): Pm2Query => ({ status: "failed" }));
  if (result.status === "not-running") return { routines: [], notes: [PM2_TEXT.notRunning] };
  if (result.status === "failed") return { routines: [], notes: [PM2_TEXT.listFailed] };
  const routines: Routine[] = [];
  for (const proc of result.processes as Pm2Process[]) {
    if (typeof proc !== "object" || proc === null) continue;
    const id = str(proc.name);
    if (!id?.startsWith(PM2_PREFIX)) continue;
    const env = proc.pm2_env ?? {};
    const schedule: CronSchedule = { type: "cron", cron: cronOf(env.cron_restart) };
    const kind = classifySchedule(schedule);
    routines.push({
      id,
      name: id.slice(PM2_PREFIX.length),
      kind,
      schedule,
      scheduleText: describeSchedule(schedule),
      state: stateFor(kind, str(env.status)),
      lastExit: typeof env.exit_code === "number" && Number.isInteger(env.exit_code) ? env.exit_code : null,
      logPath: str(env.pm_out_log_path),
      errorLogPath: str(env.pm_err_log_path),
      source: "pm2",
      own: true,
      // Unter PM2 kein Wrapper und kein Verlauf (Issue #285, Nicht-Ziel)
      wrapped: false,
      lastRun: null,
      nextRun: null,
    });
  }
  return { routines, notes: [] };
}
