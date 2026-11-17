/**
 * Routinen-Zentrale (Issue #284, Entscheidung 0025): alle zeitgesteuerten
 * Dienste und Dauerdienste, nur lesend.
 *
 * Plattform: launchd nur unter macOS. Unter Linux (Issue #568) die
 * systemd-Timer und -Dienste tybo-* (wenn der Rechner mit systemd läuft)
 * zusammen mit den PM2-Prozessen tybo-* (wenn `pm2` im PATH ist); sonst
 * available: false. systemd-Routinen mit Wrapper bekommen ihren Verlauf aus
 * data/routines/ai.tybo.<dienst>.json wie unter launchd. Alles Äußere steckt in RoutinesDeps (Muster
 * LaunchdDeps in src/setup/services/launchd.ts), Tests reichen Attrappen herein
 * und rufen nie echtes launchctl, plutil oder pm2 auf. Die PM2-CLI ruft auch
 * der echte Betrieb nie auf (siehe sources/pm2-rpc.ts).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { maskSecrets, projectSecretsOrThrow, type SecretValue } from "../jobs/mask";
import { parseRoutinesConfig, ROUTINES_CONFIG_FILE } from "./config";
import { parseRuns, runsFile, safeRoutineId, type RoutineRun } from "./runs";
import { nextRun } from "./schedule";
import { readLaunchdRoutines } from "./sources/launchd";
import { readPm2Routines } from "./sources/pm2";
import { readSystemdRoutines } from "./sources/systemd";
import { launchdLabel } from "../service-names";
import { pm2RpcSocketPath, queryPm2Daemon, type Pm2Query } from "./sources/pm2-rpc";
import type { Routine, RoutineHistory, RoutineList, RoutineSource, RunResult } from "./types";

export type { Routine, RoutineHistory, RoutineList, RoutineState, RoutineSource } from "./types";

export interface RoutinesDeps {
  platform: NodeJS.Platform;
  home: string;
  projectRoot: string;
  uid: number;
  run(cmd: string[]): Promise<RunResult>;
  listDir(path: string): string[];
  /** Dateiinhalt; null, wenn die Datei fehlt */
  readFile(path: string): string | null;
  /** Pfad eines Befehls im PATH, sonst null */
  which(cmd: string): string | null;
  /** Prozessliste vom laufenden PM2-Daemon, ohne PM2-CLI; startet nie einen Daemon */
  pm2Query(): Promise<Pm2Query>;
  /** Linux: läuft der Rechner mit systemd (/run/systemd/system)? Fehlt: nein (Issue #568) */
  systemdBooted?(): boolean;
  /** Ordner der systemd-Benutzereinheiten; fehlt: ~/.config/systemd/user */
  systemdUnitDir?: string;
  /** Jetzt in ms (nächster Lauf, Issue #285) */
  now(): number;
  /** Zeitzone für Kalender-Zeitpläne; fehlt: die des Systems */
  timeZone?: string;
  /**
   * Werte, die im Verlauf maskiert werden (zusätzlich zur Maskierung beim
   * Schreiben); fehlt: keine. Wirft, wenn sie nicht vollständig lesbar sind
   * (projectSecretsOrThrow), dann zeigt der Verlauf keine Ausgabe.
   */
  secrets?(): readonly SecretValue[];
}

/** Steht im Verlauf statt der Ausgabe, wenn die .env nicht lesbar ist (Masken unvollständig) */
export const TAIL_HIDDEN = "Ausgabe ausgeblendet: .env nicht lesbar, Masken unvollständig.";

/** Zuerst zeitgesteuerte Routinen, dann Dauerdienste, je nach Name */
export function sortRoutines(routines: Routine[]): Routine[] {
  return [...routines].sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "de") : a.kind === "scheduled" ? -1 : 1));
}

/**
 * Kennung des Verlaufs in data/routines/: launchd das Label; systemd
 * (Issue #568) ai.tybo.<dienst>, denn der Wrapper läuft dort mit derselben
 * Kennung wie unter launchd; PM2 hat keinen Verlauf.
 */
export function runsIdOf(r: Pick<Routine, "id" | "name" | "source">): string {
  return r.source === "systemd" ? launchdLabel(r.name) : r.id;
}

/** Alle Läufe einer Routine aus data/routines/<id>.json, älteste zuerst; [] ohne Protokoll */
export function readRoutineRuns(deps: Pick<RoutinesDeps, "projectRoot" | "readFile">, id: string): RoutineRun[] {
  if (!safeRoutineId(id)) return [];
  return parseRuns(deps.readFile(runsFile(deps.projectRoot, id)));
}

/**
 * Letzter Lauf und nächster Lauf einer launchd-Routine (Issue #285). Der
 * nächste Lauf steht nur bei aktiven zeitgesteuerten Routinen: pausiert,
 * nicht geladen oder unbekannt heißt null, die Anzeige sagt warum.
 */
function withRuns(r: Routine, deps: RoutinesDeps): Routine {
  const runs = readRoutineRuns(deps, runsIdOf(r));
  const lastRun = runs.length ? runs[runs.length - 1] : null;
  const lastStart = lastRun ? Date.parse(lastRun.startedAt) : NaN;
  const next =
    r.kind === "scheduled" && r.state === "active"
      ? nextRun(r.schedule, { now: deps.now(), lastStart: Number.isFinite(lastStart) ? lastStart : null, timeZone: deps.timeZone })
      : null;
  return { ...r, lastRun, nextRun: next === null ? null : new Date(next).toISOString() };
}

export async function listRoutines(deps: RoutinesDeps): Promise<RoutineList> {
  if (deps.platform === "darwin") {
    const { config, note } = parseRoutinesConfig(deps.readFile(join(deps.projectRoot, ROUTINES_CONFIG_FILE)));
    const result = await readLaunchdRoutines(
      { launchAgentsDir: join(deps.home, "Library", "LaunchAgents"), uid: deps.uid, run: deps.run, listDir: deps.listDir },
      config
    );
    const routines = result.routines.map(r => withRuns(r, deps));
    return { available: true, source: "launchd", routines: sortRoutines(routines), notes: note ? [note, ...result.notes] : result.notes };
  }
  const systemd = deps.platform === "linux" && deps.systemdBooted?.() === true;
  const pm2 = !!deps.which("pm2");
  if (!systemd && !pm2) return { available: false, source: null, routines: [], notes: [] };
  const routines: Routine[] = [];
  const notes: string[] = [];
  const sources: RoutineSource[] = [];
  if (systemd) {
    const result = await readSystemdRoutines({ unitDir: deps.systemdUnitDir ?? join(deps.home, ".config", "systemd", "user"), listDir: deps.listDir, readFile: deps.readFile, run: deps.run });
    routines.push(...result.routines.map(r => withRuns(r, deps)));
    notes.push(...result.notes);
    sources.push("systemd");
  }
  if (pm2) {
    const result = await readPm2Routines({ query: deps.pm2Query });
    routines.push(...result.routines);
    notes.push(...result.notes);
    sources.push("pm2");
  }
  return { available: true, source: sources[0], sources, routines: sortRoutines(routines), notes };
}

/**
 * Verlauf einer Routine (Issue #285): die Routine und ihre bis zu 20 Läufe,
 * neueste zuerst. Gesucht wird nach Label und, mit by "any", auch nach dem
 * Namen (/routinen health-check). Fehlt der Log-Pfad im Lauf, gilt der
 * Fehler-Log aus dem Plist, sonst der normale. null: keine solche Routine.
 * Ist die .env nicht lesbar, steht statt der Ausgabe nur TAIL_HIDDEN.
 */
export async function routineHistory(deps: RoutinesDeps, query: string, by: "id" | "any" = "any"): Promise<RoutineHistory | null> {
  const q = query.trim();
  if (!q) return null;
  const list = await listRoutines(deps);
  const routine = list.routines.find(r => r.id === q) ?? (by === "any" ? list.routines.find(r => r.name === q) : undefined);
  if (!routine) return null;
  let secrets: readonly SecretValue[] | null;
  try {
    secrets = deps.secrets?.() ?? [];
  } catch {
    secrets = null;
  }
  const mask = (tail: string[]): string[] => (secrets ? tail.map(line => maskSecrets(line, secrets)) : tail.length ? [TAIL_HIDDEN] : []);
  const fallbackLog = routine.errorLogPath ?? routine.logPath ?? undefined;
  const runs = (routine.source !== "pm2" ? readRoutineRuns(deps, runsIdOf(routine)) : [])
    .reverse()
    .map(run => ({ ...run, tail: mask(run.tail), ...(run.logPath ?? fallbackLog ? { logPath: run.logPath ?? fallbackLog } : {}) }));
  return { routine, runs, home: deps.home };
}

/** Zeitgrenze je Befehl: ein hängendes launchctl oder plutil hält die Übersicht nicht auf */
const RUN_TIMEOUT_MS = 10_000;

async function runCommand(cmd: string[]): Promise<RunResult> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => proc.kill(), RUN_TIMEOUT_MS);
    const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    clearTimeout(timer);
    return { ok: code === 0, stdout, stderr };
  } catch (e) {
    return { ok: false, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
}

function readOrNull(path: string): string | null {
  try {
    return existsSync(path) ? readFileSync(path, "utf-8") : null;
  } catch {
    return null;
  }
}

export function defaultRoutinesDeps(projectRoot: string, env: Record<string, string | undefined> = process.env): RoutinesDeps {
  const home = env.HOME || homedir();
  return {
    platform: process.platform,
    home,
    projectRoot,
    uid: process.getuid?.() ?? 0,
    run: runCommand,
    listDir: path => readdirSync(path),
    readFile: readOrNull,
    which: cmd => Bun.which(cmd),
    pm2Query: () => queryPm2Daemon(pm2RpcSocketPath(process.platform, env.PM2_HOME || join(home, ".pm2"))),
    systemdBooted: () => existsSync("/run/systemd/system"),
    systemdUnitDir: join(env.XDG_CONFIG_HOME || join(home, ".config"), "systemd", "user"),
    now: () => Date.now(),
    secrets: () => projectSecretsOrThrow(projectRoot, env),
  };
}
