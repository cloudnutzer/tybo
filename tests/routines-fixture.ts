/**
 * Attrappen für die Routinen-Zentrale (Issue #284): Dateien in
 * LaunchAgents, plutil, launchctl und der PM2-Daemon nur im Speicher. Kein
 * Test ruft einen echten Befehl auf; calls hält jeden Aufruf fest (auch
 * einen verbotenen der PM2-CLI, den run dann ablehnt).
 */

import type { RoutinesDeps } from "../src/lib/routines/catalog";
import type { Pm2Query } from "../src/lib/routines/sources/pm2-rpc";
import type { RunResult } from "../src/lib/routines/types";

export const HOME = "/Users/alex";
export const ROOT = "/Users/alex/tybo";
export const AGENTS = `${HOME}/Library/LaunchAgents`;

export interface FakeRoutinesOptions {
  platform?: NodeJS.Platform;
  /** Dateiname → Plist als Objekt; null: plutil scheitert (kaputter Plist) */
  plists?: Record<string, Record<string, unknown> | null>;
  /** Ausgabe von launchctl list; null: Befehl scheitert */
  launchctlList?: string | null;
  /** Ausgabe von launchctl print-disabled; null: Befehl scheitert */
  printDisabled?: string | null;
  /** Inhalt von config/routines.json; fehlt: Datei fehlt */
  config?: string;
  /** Pfad von pm2; null: nicht im PATH */
  pm2Path?: string | null;
  /** Antwort des PM2-Daemons; Standard: läuft, keine Prozesse */
  pm2?: Pm2Query;
  listDirThrows?: boolean;
  /** Protokolle data/routines/<id>.json: id → Inhalt (Issue #285) */
  runFiles?: Record<string, string>;
  /** Jetzt in ms; Standard: 15.10.2026 10:00 Berlin */
  now?: number;
  timeZone?: string;
  /**
   * Linux (Issue #568): läuft der Rechner mit systemd? Standard nein, nie
   * der echte Rechner (sonst hinge das Ergebnis davon ab, wo der Test läuft)
   */
  systemd?: boolean;
  /** Einheiten im Ordner SYSTEMD_UNITS: Dateiname → Inhalt; fehlt: Ordner fehlt */
  units?: Record<string, string>;
}

/** Ordner der systemd-Benutzereinheiten in der Attrappe */
export const SYSTEMD_UNITS = `${HOME}/.config/systemd/user`;

/** Standard-Jetzt der Attrappe: Donnerstag, 15.10.2026, 10:00 in Berlin */
export const FIXTURE_NOW = Date.parse("2026-10-15T08:00:00.000Z");

export function launchctlListOutput(rows: Array<[string, string, string]>): string {
  return ["PID\tStatus\tLabel", ...rows.map(r => r.join("\t"))].join("\n");
}

export function printDisabledOutput(entries: Record<string, boolean>): string {
  const lines = Object.entries(entries).map(([label, off]) => `\t"${label}" => ${off ? "disabled" : "enabled"}`);
  return ["disabled services = {", ...lines, "}"].join("\n");
}

export function fakeRoutinesDeps(options: FakeRoutinesOptions = {}): RoutinesDeps & { calls: string[][] } {
  const calls: string[][] = [];
  const plists = options.plists ?? {};
  const ok = (stdout: string): RunResult => ({ ok: true, stdout, stderr: "" });
  const fail: RunResult = { ok: false, stdout: "", stderr: "Fehler" };
  return {
    calls,
    platform: options.platform ?? "darwin",
    home: HOME,
    projectRoot: ROOT,
    uid: 501,
    async run(cmd) {
      calls.push(cmd);
      // systemctl --user show: jede Einheit aus units geladen und aktiv, nie gelaufen
      if (cmd[0] === "systemctl" && cmd[1] === "--user" && cmd[2] === "show") {
        return options.units?.[cmd[3]] !== undefined ? ok("LoadState=loaded\nActiveState=active\nUnitFileState=enabled") : ok("LoadState=not-found\nActiveState=inactive");
      }
      if (cmd[0] === "plutil") {
        const file = cmd[cmd.length - 1].slice(AGENTS.length + 1);
        const plist = plists[file];
        return plist ? ok(JSON.stringify(plist)) : fail;
      }
      if (cmd[0] === "launchctl" && cmd[1] === "list") {
        const out = options.launchctlList === undefined ? launchctlListOutput([]) : options.launchctlList;
        return out === null ? fail : ok(out);
      }
      if (cmd[0] === "launchctl" && cmd[1] === "print-disabled") {
        const out = options.printDisabled === undefined ? printDisabledOutput({}) : options.printDisabled;
        return out === null ? fail : ok(out);
      }
      throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
    },
    listDir(path) {
      if (path === SYSTEMD_UNITS) {
        if (!options.units) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return Object.keys(options.units);
      }
      if (options.listDirThrows || path !== AGENTS) throw new Error("ENOENT");
      return Object.keys(plists);
    },
    readFile(path) {
      if (path.startsWith(`${SYSTEMD_UNITS}/`)) return options.units?.[path.slice(SYSTEMD_UNITS.length + 1)] ?? null;
      if (path === `${ROOT}/config/routines.json`) return options.config !== undefined ? options.config : null;
      const run = /^.*\/data\/routines\/(.+)\.json$/.exec(path);
      if (run && path.startsWith(`${ROOT}/data/routines/`)) return options.runFiles?.[run[1]] ?? null;
      return null;
    },
    which(cmd) {
      return cmd === "pm2" ? (options.pm2Path === undefined ? null : options.pm2Path) : null;
    },
    async pm2Query() {
      calls.push(["<pm2-daemon>", "getMonitorData"]);
      return options.pm2 ?? { status: "ok", processes: [] };
    },
    systemdBooted: () => options.systemd ?? false,
    systemdUnitDir: SYSTEMD_UNITS,
    now: () => options.now ?? FIXTURE_NOW,
    timeZone: options.timeZone ?? "Europe/Berlin",
  };
}

/** Plist eines zeitgesteuerten Diensts wie aus setup:launchd */
export function scheduledPlist(label: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Label: label,
    ProgramArguments: ["/bin/true"],
    StartCalendarInterval: { Hour: 3, Minute: 30 },
    StandardOutPath: `${ROOT}/logs/${label}.log`,
    StandardErrorPath: `${ROOT}/logs/${label}.error.log`,
    ...extra,
  };
}

/** Wie scheduledPlist, aber über den Wrapper (Issue #285) */
export function wrappedPlist(label: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return scheduledPlist(label, { ProgramArguments: ["/opt/bin/bun", "--no-env-file", "src/routine-run.ts", "--id", label, "--", "/opt/bin/bun", "run", "src/x.ts"], ...extra });
}

/** Inhalt eines Protokolls data/routines/<id>.json */
export function runFile(id: string, runs: Array<Partial<import("../src/lib/routines/runs").RoutineRun> & { startedAt: string }>): string {
  return JSON.stringify({
    id,
    runs: runs.map(r => ({ endedAt: r.startedAt, durationMs: 0, exitCode: 0, tail: [], ...r })),
  });
}

export function daemonPlist(label: string): Record<string, unknown> {
  return { Label: label, ProgramArguments: ["/bin/true"], KeepAlive: true, RunAtLoad: true, StandardOutPath: `${ROOT}/logs/relay.log` };
}
