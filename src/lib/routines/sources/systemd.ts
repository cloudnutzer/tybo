/**
 * Routinen aus systemd (Issue #568): Timer und Dienste tybo-* aus dem Ordner
 * der Benutzereinheiten (~/.config/systemd/user), wie `tybo dienste` und
 * `tybo setup autostart` sie schreiben.
 *
 * - tybo-<dienst>.timer: zeitgesteuerte Routine. Zeitplan aus den
 *   OnCalendar-Zeilen (mit Zeitzone), Befehl und Protokolldateien aus der
 *   zugehörigen tybo-<dienst>.service. Ruft der Dienst den Wrapper
 *   src/routine-run.ts, steht der Verlauf unter ai.tybo.<dienst> in
 *   data/routines/ (dieselbe Kennung wie unter launchd), die Übersicht ordnet
 *   ihn darüber zu (runsIdOf in ../catalog.ts).
 * - tybo-<dienst>.service ohne Timer (etwa der Bot aus `tybo setup
 *   autostart`): Dauerdienst, läuft oder läuft nicht.
 *
 * Zustand über `systemctl --user show` (nur lesend): Timer aktiv heißt
 * „aktiv“, abgeschaltet (UnitFileState disabled) „pausiert“, sonst „nicht
 * geladen“. Antwortet systemctl nicht, ist der Zustand unbekannt, mit einem
 * Hinweis unter der Liste. Unter Linux gibt es keine Knöpfe zum Pausieren
 * oder Testen (Aktionen nur unter launchd, src/lib/routines/actions.ts).
 */

import { join } from "node:path";
import { PM2_PREFIX } from "../../service-names";
import { describeSchedule, scheduleFromTimer } from "../schedule";
import type { Routine, RoutineState, RunCommand } from "../types";

export interface SystemdSourceDeps {
  /** Ordner der Benutzereinheiten */
  unitDir: string;
  /** Dateinamen im Ordner; wirft, wenn er fehlt oder nicht lesbar ist */
  listDir(path: string): string[];
  /** Dateiinhalt; null, wenn die Datei fehlt */
  readFile(path: string): string | null;
  run: RunCommand;
}

export const SYSTEMD_TEXT = {
  unreachable: "systemctl --user antwortet nicht; der Zustand der systemd-Timer ist unbekannt.",
  unreadable: "Der Ordner der systemd-Benutzereinheiten ist nicht lesbar.",
} as const;

const UNIT = /^tybo-([A-Za-z0-9][A-Za-z0-9._-]{0,80})\.(timer|service)$/;

/** Werte einer Einheit: je Schlüssel alle Zeilen „Schlüssel=Wert“ in Reihenfolge */
export function unitValues(text: string, key: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq > 0 && line.slice(0, eq).trim() === key) out.push(line.slice(eq + 1).trim());
  }
  return out;
}

/** Pfad aus StandardOutput=append:… bzw. file:…; sonst null */
function logPathOf(value: string | undefined): string | null {
  const m = /^(?:append|file|truncate):(\/.+)$/.exec(value ?? "");
  return m ? m[1] : null;
}

function showProps(stdout: string): Record<string, string> {
  const props: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) props[line.slice(0, eq)] = line.slice(eq + 1).trim();
  }
  return props;
}

async function show(unit: string, props: string[], deps: SystemdSourceDeps): Promise<Record<string, string> | null> {
  const r = await deps.run(["systemctl", "--user", "show", unit, `--property=${props.join(",")}`]).catch(() => ({ ok: false, stdout: "", stderr: "" }));
  if (!r.ok) return null;
  const parsed = showProps(r.stdout);
  return parsed.LoadState ? parsed : null;
}

function timerState(p: Record<string, string> | null): RoutineState {
  if (!p) return "unknown";
  if (p.ActiveState === "active") return "active";
  if (p.LoadState === "loaded" && p.UnitFileState === "disabled") return "paused";
  return "not-loaded";
}

/** Exit-Code des letzten Laufs eines Diensts; null, wenn er noch nie lief oder unbekannt */
function lastExitOf(p: Record<string, string> | null): number | null {
  if (!p || !p.ExecMainStartTimestamp) return null;
  const code = Number(p.ExecMainStatus);
  return Number.isInteger(code) ? code : null;
}

function pidOf(p: Record<string, string> | null): number | null {
  const pid = Number(p?.MainPID);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

const SERVICE_PROPS = ["LoadState", "ActiveState", "MainPID", "ExecMainStatus", "ExecMainStartTimestamp"];

export async function readSystemdRoutines(deps: SystemdSourceDeps): Promise<{ routines: Routine[]; notes: string[] }> {
  let files: string[];
  try {
    files = deps.listDir(deps.unitDir);
  } catch (e) {
    // Kein Ordner: keine Einheiten, kein Hinweis
    return (e as NodeJS.ErrnoException)?.code === "ENOENT" ? { routines: [], notes: [] } : { routines: [], notes: [SYSTEMD_TEXT.unreadable] };
  }
  const timers = new Set<string>();
  const services = new Set<string>();
  for (const file of files) {
    const m = UNIT.exec(file);
    if (!m) continue;
    (m[2] === "timer" ? timers : services).add(m[1]);
  }
  const routines: Routine[] = [];
  let unreachable = false;
  for (const name of [...new Set([...timers, ...services])].sort()) {
    const id = `${PM2_PREFIX}${name}`;
    const serviceText = deps.readFile(join(deps.unitDir, `${id}.service`)) ?? "";
    const execStart = unitValues(serviceText, "ExecStart").join(" ");
    const logPath = logPathOf(unitValues(serviceText, "StandardOutput").pop());
    const errorLogPath = logPathOf(unitValues(serviceText, "StandardError").pop());
    const serviceProps = services.has(name) ? await show(`${id}.service`, SERVICE_PROPS, deps) : null;
    if (services.has(name) && !serviceProps) unreachable = true;
    const base = { id, name, logPath, errorLogPath, source: "systemd" as const, own: true, lastRun: null, nextRun: null, pid: pidOf(serviceProps) };

    if (timers.has(name)) {
      const timerText = deps.readFile(join(deps.unitDir, `${id}.timer`)) ?? "";
      const schedule = scheduleFromTimer(unitValues(timerText, "OnCalendar"));
      const timerProps = await show(`${id}.timer`, ["LoadState", "ActiveState", "UnitFileState"], deps);
      if (!timerProps) unreachable = true;
      routines.push({
        ...base,
        kind: "scheduled",
        schedule,
        scheduleText: describeSchedule(schedule),
        state: timerState(timerProps),
        lastExit: lastExitOf(serviceProps),
        wrapped: execStart.includes("src/routine-run.ts"),
      });
    } else {
      const state: RoutineState = !serviceProps ? "unknown" : serviceProps.ActiveState === "active" || serviceProps.ActiveState === "activating" ? "running" : "stopped";
      routines.push({
        ...base,
        kind: "daemon",
        schedule: null,
        scheduleText: "Dauerdienst",
        state,
        lastExit: lastExitOf(serviceProps),
        wrapped: false,
      });
    }
  }
  return { routines, notes: unreachable ? [SYSTEMD_TEXT.unreachable] : [] };
}
