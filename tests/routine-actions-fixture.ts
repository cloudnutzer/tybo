/**
 * Attrappe für die Routinen-Aktionen (Issue #288): ein launchd im Speicher,
 * dessen Zustand sich durch disable, enable, bootout, bootstrap und
 * kickstart ändert. Kein Test ruft echtes launchctl auf; calls hält jeden
 * Aufruf fest, fail lässt einzelne Befehle scheitern.
 */

import type { RoutinesDeps } from "../src/lib/routines/catalog";
import { runsFile } from "../src/lib/routines/runs";
import type { RoutineRun, RunResult } from "../src/lib/routines/types";
import { AGENTS, daemonPlist, FIXTURE_NOW, HOME, ROOT, scheduledPlist } from "./routines-fixture";

export interface FakeService {
  /** Dateiname im Ordner LaunchAgents (muss nicht <label>.plist heißen) */
  file: string;
  plist: Record<string, unknown>;
  disabled: boolean;
  loaded: boolean;
  pid: number | null;
}

export interface FakeLaunchd {
  deps: RoutinesDeps;
  services: Map<string, FakeService>;
  calls: string[][];
  /** Nur Befehle, die etwas ändern (disable, enable, bootout, bootstrap, kickstart) */
  mutations(): string[];
  /** Befehle (z. B. "bootout", "list") scheitern lassen */
  fail: Set<string>;
  /**
   * Wird bei jedem kickstart eines geladenen Diensts aufgerufen, nach dem
   * Start (pid 4711) bzw. ohne Start, wenn kickstart in fail steht: z. B.
   * kurzer Lauf schon fertig (pid null, addRun) oder Nachlesen scheitert.
   */
  onKickstart: ((s: FakeService, label: string) => void) | null;
  /** Lauf im Verlauf festhalten, wie der Wrapper (data/routines/<id>.json) */
  addRun(label: string, run: RoutineRun): void;
}

const MUTATING = new Set(["disable", "enable", "bootout", "bootstrap", "kickstart", "kill", "unload", "load", "stop", "start"]);

export function fakeLaunchd(
  init: Array<{ label: string; file?: string; daemon?: boolean; disabled?: boolean; loaded?: boolean; pid?: number | null; plist?: Record<string, unknown> }>,
  options: { platform?: NodeJS.Platform; config?: string; uid?: number } = {}
): FakeLaunchd {
  const services = new Map<string, FakeService>();
  for (const s of init) {
    services.set(s.label, {
      file: s.file ?? `${s.label}.plist`,
      plist: s.plist ?? (s.daemon ? daemonPlist(s.label) : scheduledPlist(s.label)),
      disabled: s.disabled ?? false,
      loaded: s.loaded ?? true,
      pid: s.pid ?? null,
    });
  }
  const calls: string[][] = [];
  const fail = new Set<string>();
  const runs = new Map<string, RoutineRun[]>();
  const fake = { onKickstart: null as FakeLaunchd["onKickstart"] };
  const uid = options.uid ?? 501;
  const ok = (stdout = ""): RunResult => ({ ok: true, stdout, stderr: "" });
  const bad: RunResult = { ok: false, stdout: "", stderr: "Fehler" };
  const byTarget = (target: string) => {
    const prefix = `gui/${uid}/`;
    return target.startsWith(prefix) ? services.get(target.slice(prefix.length)) : undefined;
  };

  const deps: RoutinesDeps = {
    platform: options.platform ?? "darwin",
    home: HOME,
    projectRoot: ROOT,
    uid,
    async run(cmd) {
      calls.push(cmd);
      if (cmd[0] === "plutil") {
        const file = cmd[cmd.length - 1].slice(AGENTS.length + 1);
        const s = [...services.values()].find(x => x.file === file);
        return s ? ok(JSON.stringify(s.plist)) : bad;
      }
      if (cmd[0] !== "launchctl") throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
      const verb = cmd[1];
      if (fail.has(verb) && verb !== "kickstart") return bad;
      switch (verb) {
        case "list": {
          const rows = [...services.entries()].filter(([, s]) => s.loaded).map(([l, s]) => `${s.pid ?? "-"}\t0\t${l}`);
          return ok(["PID\tStatus\tLabel", ...rows].join("\n"));
        }
        case "print-disabled": {
          const lines = [...services.entries()].map(([l, s]) => `\t"${l}" => ${s.disabled ? "disabled" : "enabled"}`);
          return ok(["disabled services = {", ...lines, "}"].join("\n"));
        }
        case "disable":
        case "enable": {
          const s = byTarget(cmd[2]);
          if (!s) return bad;
          s.disabled = verb === "disable";
          return ok();
        }
        case "bootout": {
          const s = byTarget(cmd[2]);
          if (!s || !s.loaded) return bad;
          s.loaded = false;
          s.pid = null;
          return ok();
        }
        case "bootstrap": {
          if (cmd[2] !== `gui/${uid}`) return bad;
          const s = [...services.values()].find(x => `${AGENTS}/${x.file}` === cmd[3]);
          if (!s || s.disabled || s.loaded) return bad;
          s.loaded = true;
          return ok();
        }
        case "kickstart": {
          if (cmd.includes("-k")) throw new Error("kickstart -k ist verboten");
          const target = cmd[cmd.length - 1];
          const s = byTarget(target);
          if (!s || !s.loaded) return bad;
          const failed = fail.has("kickstart");
          if (!failed) s.pid = 4711;
          fake.onKickstart?.(s, target.slice(`gui/${uid}/`.length));
          return failed ? bad : ok();
        }
        default:
          throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
      }
    },
    listDir(path) {
      if (path !== AGENTS) throw new Error("ENOENT");
      return [...services.values()].map(s => s.file);
    },
    readFile(path) {
      if (path === `${ROOT}/config/routines.json`) return options.config ?? null;
      for (const [label, list] of runs) if (path === runsFile(ROOT, label)) return JSON.stringify({ runs: list });
      return null;
    },
    which: () => null,
    async pm2Query() {
      calls.push(["<pm2-daemon>", "getMonitorData"]);
      return { status: "ok", processes: [] };
    },
    now: () => FIXTURE_NOW,
    timeZone: "Europe/Berlin",
  };
  return {
    deps,
    services,
    calls,
    fail,
    get onKickstart() {
      return fake.onKickstart;
    },
    set onKickstart(fn) {
      fake.onKickstart = fn;
    },
    addRun(label, run) {
      runs.set(label, [...(runs.get(label) ?? []), run]);
    },
    mutations: () => calls.filter(c => c[0] === "launchctl" && MUTATING.has(c[1])).map(c => c.slice(1).join(" ")),
  };
}

/** Übliche Ausstattung: health-check aktiv, Bot als Dauerdienst, ein weiterer Dauerdienst */
export function standardLaunchd(overrides: { health?: Partial<{ disabled: boolean; loaded: boolean; pid: number | null; file: string }> } = {}) {
  return fakeLaunchd([
    { label: "ai.tybo.health-check", ...overrides.health },
    { label: "ai.tybo.telegram-relay", daemon: true, pid: 4242 },
    { label: "ai.tybo.web-proxy", daemon: true, pid: 4343 },
  ]);
}
