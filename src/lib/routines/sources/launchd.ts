/**
 * Routinen aus launchd (Issue #284): Plists aus ~/Library/LaunchAgents mit
 * Label ai.tybo.* und allem, was config/routines.json nennt. Nur lesend:
 * `plutil -convert json` je Plist, einmal `launchctl list` und einmal
 * `launchctl print-disabled gui/<uid>`.
 *
 * Fehler bleiben so klein wie möglich: Ein unlesbarer Plist macht nur seine
 * Zeile unbekannt. Scheitert ein launchctl-Befehl, bleiben alle Zeilen
 * stehen; unbekannt wird jeder Zustand, den nur dieser Befehl belegen kann
 * (Tabelle in launchdState), bekannte Exit-Codes bleiben erhalten.
 */

import { join } from "node:path";
import { LAUNCHD_PREFIX } from "../../service-names";
import { matchesRoutine, type RoutinesConfig } from "../config";
import { classifySchedule, describeSchedule, scheduleFromPlist } from "../schedule";
import type { Routine, RoutineFacts, RoutineState, RunCommand } from "../types";

export interface LaunchdSourceDeps {
  launchAgentsDir: string;
  uid: number;
  run: RunCommand;
  /** Dateinamen im Ordner; wirft, wenn er nicht lesbar ist */
  listDir(path: string): string[];
}

export const LAUNCHD_TEXT = {
  unreadablePlist: "unbekannt (Plist nicht lesbar)",
  listFailed: "launchctl list ist gescheitert: ob die Dienste geladen sind und wie ihr letzter Lauf endete, ist unbekannt.",
  disabledFailed: "launchctl print-disabled ist gescheitert: ob zeitgesteuerte Dienste aktiv oder pausiert sind, ist unbekannt.",
  dirUnreadable: "Der Ordner LaunchAgents ist nicht lesbar.",
} as const;

export interface LaunchctlEntry {
  pid: number | null;
  lastExit: number | null;
}

/** Ausgabe von `launchctl list` (PID, Status, Label je Zeile) als Tabelle nach Label */
export function parseLaunchctlList(stdout: string): Map<string, LaunchctlEntry> {
  const out = new Map<string, LaunchctlEntry>();
  for (const line of stdout.split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const [pid, status] = cols;
    const label = cols.slice(2).join(" ");
    if (!/^(-|\d+)$/.test(pid) || !/^(-|-?\d+)$/.test(status)) continue;
    out.set(label, { pid: pid === "-" ? null : Number(pid), lastExit: status === "-" ? null : Number(status) });
  }
  return out;
}

/**
 * Ausgabe von `launchctl print-disabled gui/<uid>` als Tabelle nach Label:
 * true heißt deaktiviert. Ältere macOS schreiben true/false statt
 * disabled/enabled.
 */
export function parsePrintDisabled(stdout: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const match of stdout.matchAll(/"([^"]+)"\s*=>\s*(disabled|enabled|true|false)/g)) {
    out.set(match[1], match[2] === "disabled" || match[2] === "true");
  }
  return out;
}

function routineName(label: string): string {
  return label.startsWith(LAUNCHD_PREFIX) ? label.slice(LAUNCHD_PREFIX.length) : label;
}

/**
 * Ruft der Plist den Wrapper src/routine-run.ts mit seinem eigenen Label als
 * --id (Issue #285)? Eine andere id schriebe in ein fremdes Protokoll und
 * zählt nicht als eingebunden.
 */
export function isWrapped(programArguments: unknown, label: string): boolean {
  if (!Array.isArray(programArguments)) return false;
  const at = programArguments.findIndex(a => typeof a === "string" && /(^|\/)src\/routine-run\.ts$/.test(a));
  if (at < 0) return false;
  const rest = programArguments.slice(at + 1);
  return rest[0] === "--id" && rest[1] === label && rest[2] === "--";
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** Eine Angabe aus launchctl: true, false oder null (Befehl gescheitert, unbekannt) */
export type Fact = boolean | null;

/** Wie RoutineFacts in ../types */
export type LaunchdFacts = RoutineFacts;

/**
 * Zustand als Tabelle: Jeder Zustand nennt die Angaben, die ihn belegen.
 * Fehlt eine davon (null), ist der Zustand unknown, nie eine Annahme.
 *
 * - paused: disabled true (das ist „pausiert", Entscheidung 0025)
 * - active: disabled false und loaded true
 * - not-loaded: disabled false und loaded false
 * - running: loaded true und running true (disabled sagt über einen
 *   laufenden Prozess nichts)
 * - stopped: loaded false, oder loaded true und running false
 */
export function launchdState(kind: Routine["kind"], f: LaunchdFacts): RoutineState {
  if (kind === "daemon") {
    if (f.loaded === false) return "stopped";
    if (f.loaded === true && f.running !== null) return f.running ? "running" : "stopped";
    return "unknown";
  }
  if (f.disabled === true) return "paused";
  if (f.disabled === false && f.loaded !== null) return f.loaded ? "active" : "not-loaded";
  return "unknown";
}

/** Angaben zu einem Label aus den beiden Befehlen; null-Tabelle heißt: Befehl gescheitert */
export function launchdFacts(label: string, loaded: Map<string, LaunchctlEntry> | null, disabled: Map<string, boolean> | null): LaunchdFacts {
  const entry = loaded ? (loaded.get(label) ?? null) : undefined;
  return {
    loaded: entry === undefined ? null : entry !== null,
    running: entry === undefined ? null : entry !== null && entry.pid !== null,
    // print-disabled nennt nur abweichende Dienste; fehlt das Label, ist er aktiviert
    disabled: disabled ? (disabled.get(label) ?? false) : null,
  };
}

export interface PlistRead {
  file: string;
  label: string;
  plist: Record<string, unknown> | null;
}

export async function readPlist(deps: LaunchdSourceDeps, file: string): Promise<PlistRead> {
  const stem = file.slice(0, -".plist".length);
  const result = await deps.run(["plutil", "-convert", "json", "-o", "-", join(deps.launchAgentsDir, file)]).catch(() => null);
  if (!result?.ok) return { file, label: stem, plist: null };
  try {
    const data = JSON.parse(result.stdout);
    if (typeof data !== "object" || data === null || Array.isArray(data)) return { file, label: stem, plist: null };
    const plist = data as Record<string, unknown>;
    return { file, label: str(plist.Label) ?? stem, plist };
  } catch {
    return { file, label: stem, plist: null };
  }
}

export async function readLaunchdRoutines(deps: LaunchdSourceDeps, config: RoutinesConfig): Promise<{ routines: Routine[]; notes: string[] }> {
  let files: string[];
  try {
    files = deps.listDir(deps.launchAgentsDir).filter(f => f.endsWith(".plist")).sort();
  } catch {
    return { routines: [], notes: [LAUNCHD_TEXT.dirUnreadable] };
  }
  const [plists, list, disabled] = await Promise.all([
    Promise.all(files.map(f => readPlist(deps, f))),
    deps.run(["launchctl", "list"]).catch(() => null),
    deps.run(["launchctl", "print-disabled", `gui/${deps.uid}`]).catch(() => null),
  ]);
  const notes: string[] = [];
  const loaded = list?.ok ? parseLaunchctlList(list.stdout) : null;
  if (!loaded) notes.push(LAUNCHD_TEXT.listFailed);
  const disabledMap = disabled?.ok ? parsePrintDisabled(disabled.stdout) : null;
  if (!disabledMap) notes.push(LAUNCHD_TEXT.disabledFailed);

  const routines: Routine[] = [];
  const seen = new Set<string>();
  for (const read of plists) {
    // Unlesbarer Plist: Label unbekannt, entschieden wird nach dem Dateinamen
    if (!matchesRoutine(read.label, LAUNCHD_PREFIX, config) || seen.has(read.label)) continue;
    seen.add(read.label);
    const base = { id: read.label, name: routineName(read.label), source: "launchd" as const, own: read.label.startsWith(LAUNCHD_PREFIX) };
    if (!read.plist) {
      routines.push({ ...base, kind: "scheduled", schedule: null, scheduleText: LAUNCHD_TEXT.unreadablePlist, state: "unknown", lastExit: null, logPath: null, errorLogPath: null, wrapped: false, lastRun: null, nextRun: null, plistPath: null, pid: null });
      continue;
    }
    const schedule = scheduleFromPlist(read.plist);
    const kind = classifySchedule(schedule);
    const entry = loaded?.get(read.label) ?? null;
    const facts = launchdFacts(read.label, loaded, disabledMap);
    routines.push({
      ...base,
      kind,
      schedule,
      scheduleText: describeSchedule(schedule),
      state: launchdState(kind, facts),
      lastExit: entry?.lastExit ?? null,
      logPath: str(read.plist.StandardOutPath),
      errorLogPath: str(read.plist.StandardErrorPath),
      wrapped: isWrapped(read.plist.ProgramArguments, read.label),
      // Verlauf und nächster Lauf kommen im Katalog dazu (catalog.ts)
      lastRun: null,
      nextRun: null,
      // Für die Aktionen (Issue #288): die Datei, in der das Label steht, nicht <label>.plist
      plistPath: join(deps.launchAgentsDir, read.file),
      pid: entry?.pid ?? null,
      facts,
    });
  }
  const missing = config.labels.filter(l => !seen.has(l));
  if (missing.length) notes.push(`Aus config/routines.json nicht gefunden: ${missing.join(", ")}`);
  return { routines, notes };
}
