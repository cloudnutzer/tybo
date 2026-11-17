/**
 * Issue #568: Die Routinen-Übersicht liest unter Linux die systemd-Timer und
 * -Dienste tybo-* (src/lib/routines/sources/systemd.ts) zusammen mit den
 * PM2-Prozessen. Die Einheiten kommen aus dem echten Generator
 * (src/lib/services/systemd.ts, wie `tybo dienste` sie schreibt);
 * systemctl, der PM2-Daemon und das Dateisystem sind Attrappen. Kein Test
 * ruft systemctl oder pm2 wirklich auf.
 */

import { describe, expect, test } from "bun:test";
import { listRoutines, routineHistory, runsIdOf, type RoutinesDeps } from "../src/lib/routines/catalog";
import { formatRoutineList } from "../src/lib/routines/format";
import { summarizePunctuality } from "../src/lib/routines/punctual";
import { describeSchedule, nextRun, parseOnCalendar, scheduleFromTimer } from "../src/lib/routines/schedule";
import { readSystemdRoutines, SYSTEMD_TEXT, unitValues } from "../src/lib/routines/sources/systemd";
import { menuActions } from "../src/lib/routines/actions";
import { serviceDefinition } from "../src/lib/services/catalog";
import { serviceUnit, timerUnit, type LinuxMachine } from "../src/lib/services/systemd";
import type { SetupSchedule } from "../src/lib/proactive/setup-schedule";
import { evaluatePunctuality } from "../src/health-check";
import { routinesApiBody, type RoutineInput } from "../src/web/routines";
import { fakeRoutinesDeps, runFile } from "./routines-fixture";

const HOME = "/home/alex";
const ROOT = "/home/alex/tybo";
const UNITS = `${HOME}/.config/systemd/user`;
const MACHINE: LinuxMachine = { bun: "/home/alex/.bun/bin/bun", claudeDir: "/home/alex/.local/bin", home: HOME, projectRoot: ROOT };
const SCHEDULE: SetupSchedule = { morning_briefing: { hour: 7, minute: 15, enabled: true }, check_in_intervals: [{ hour: 10, minute: 30 }, { hour: 14, minute: 0 }] };
/** Freitag, 13.11.2026, 04:00 in Berlin (03:00 UTC) */
const NOW = Date.parse("2026-11-13T03:00:00.000Z");

/** Einheiten aus dem echten Generator, Nachtcheck und Check-in in Berliner Zeit */
function units(timeZone: string | null = "Europe/Berlin"): Record<string, string> {
  const files: Record<string, string> = {};
  for (const name of ["health-check", "smart-checkin"] as const) {
    const def = serviceDefinition(name);
    files[`tybo-${name}.service`] = serviceUnit(def, MACHINE);
    files[`tybo-${name}.timer`] = timerUnit(def, SCHEDULE, timeZone);
  }
  // Bot aus tybo setup autostart: Dienst ohne Timer
  files["tybo-telegram-relay.service"] = `[Service]\nExecStart=/home/alex/.bun/bin/bun run src/bot.ts\nRestart=always\nStandardOutput=append:${ROOT}/logs/telegram-relay.log\nStandardError=append:${ROOT}/logs/telegram-relay.error.log\n`;
  // Fremde Einheiten zählen nicht
  files["backup.timer"] = "[Timer]\nOnCalendar=daily\n";
  files["go-smart-checkin.timer"] = "[Timer]\nOnCalendar=*-*-* 09:00:00\n";
  return files;
}

type Show = Record<string, string> | "fail";

interface SystemdFake {
  files?: Record<string, string>;
  /** Einheit → Ausgabe von systemctl show; fehlt: passender Standard */
  show?: Record<string, Show>;
  unreachable?: boolean;
  systemd?: boolean;
  pm2Path?: string | null;
  runFiles?: Record<string, string>;
}

const SHOW_DEFAULT: Record<string, Record<string, string>> = {
  "tybo-health-check.timer": { LoadState: "loaded", ActiveState: "active", UnitFileState: "enabled" },
  "tybo-health-check.service": { LoadState: "loaded", ActiveState: "inactive", MainPID: "0", ExecMainStatus: "0", ExecMainStartTimestamp: "Fri 2026-11-13 03:30:00 CET" },
  "tybo-smart-checkin.timer": { LoadState: "loaded", ActiveState: "inactive", UnitFileState: "disabled" },
  "tybo-smart-checkin.service": { LoadState: "loaded", ActiveState: "inactive", MainPID: "0", ExecMainStatus: "1", ExecMainStartTimestamp: "Thu 2026-11-12 14:00:00 CET" },
  "tybo-telegram-relay.service": { LoadState: "loaded", ActiveState: "active", MainPID: "777", ExecMainStatus: "0", ExecMainStartTimestamp: "Thu 2026-11-12 08:00:00 CET" },
};

function systemdDeps(o: SystemdFake = {}): RoutinesDeps & { calls: string[][] } {
  const files = o.files ?? units();
  const base = fakeRoutinesDeps({ platform: "linux", pm2Path: o.pm2Path === undefined ? null : o.pm2Path, runFiles: o.runFiles, now: NOW, timeZone: "UTC" });
  return {
    ...base,
    home: HOME,
    projectRoot: ROOT,
    systemdBooted: () => o.systemd ?? true,
    systemdUnitDir: UNITS,
    listDir(path) {
      if (path !== UNITS) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Object.keys(files);
    },
    readFile(path) {
      if (path.startsWith(`${UNITS}/`)) return files[path.slice(UNITS.length + 1)] ?? null;
      const run = /^.*\/data\/routines\/(.+)\.json$/.exec(path);
      if (run && path.startsWith(`${ROOT}/data/routines/`)) return o.runFiles?.[run[1]] ?? null;
      return null;
    },
    async run(cmd) {
      base.calls.push(cmd);
      if (cmd[0] !== "systemctl" || cmd[1] !== "--user" || cmd[2] !== "show") throw new Error(`unerwarteter Befehl: ${cmd.join(" ")}`);
      if (o.unreachable) return { ok: false, stdout: "", stderr: "Failed to connect to bus" };
      const answer = o.show?.[cmd[3]] ?? SHOW_DEFAULT[cmd[3]] ?? { LoadState: "not-found", ActiveState: "inactive" };
      if (answer === "fail") return { ok: false, stdout: "", stderr: "x" };
      return { ok: true, stdout: Object.entries(answer).map(([k, v]) => `${k}=${v}`).join("\n"), stderr: "" };
    },
  };
}

describe("OnCalendar lesen", () => {
  test("Form von tybo: täglich, Wochentag, jede Stunde, mit und ohne Zeitzone", () => {
    expect(parseOnCalendar("*-*-* 03:30:00 Europe/Berlin")).toEqual({ entry: { Hour: 3, Minute: 30 }, timeZone: "Europe/Berlin" });
    expect(parseOnCalendar("Sun *-*-* 03:15:00")).toEqual({ entry: { Weekday: 0, Hour: 3, Minute: 15 }, timeZone: null });
    expect(parseOnCalendar("*-*-* *:30:00")).toEqual({ entry: { Minute: 30 }, timeZone: null });
    for (const other of ["daily", "Mon..Fri *-*-* 08:00", "*-*-* 25:00:00", "2026-11-14 03:30:00"]) expect(parseOnCalendar(other)).toBeNull();
  });

  test("Klartext mit Zeitzone; fremde Form ehrlich als eigener Zeitplan", () => {
    expect(describeSchedule(scheduleFromTimer(["*-*-* 03:30:00 Europe/Berlin"]))).toBe("täglich 03:30 (Europe/Berlin)");
    expect(describeSchedule(scheduleFromTimer(["*-*-* 10:30:00", "*-*-* 14:00:00"]))).toBe("täglich 10:30 und 14:00");
    expect(describeSchedule(scheduleFromTimer(["Sun *-*-* 03:15:00 UTC"]))).toBe("sonntags 03:15 (UTC)");
    expect(describeSchedule(scheduleFromTimer(["daily"]))).toBe("eigener Zeitplan (daily)");
    // Verschiedene Zeitzonen oder eine unbekannte: nicht rechnen
    expect(scheduleFromTimer(["*-*-* 03:30:00 Europe/Berlin", "*-*-* 04:30:00 UTC"]).calendar).toBeNull();
    expect(scheduleFromTimer(["*-*-* 03:30:00 Mars/Olympus"]).calendar).toBeNull();
    expect(describeSchedule(scheduleFromTimer([]))).toBe("kein Zeitplan");
  });

  test("nächster Lauf in der Zeitzone des Timers, nicht in der des Systems", () => {
    const berlin = scheduleFromTimer(["*-*-* 03:30:00 Europe/Berlin"]);
    // 13.11. 04:00 Berlin: der nächste ist der 14.11. 03:30 Berlin = 02:30 UTC
    expect(new Date(nextRun(berlin, { now: NOW, lastStart: null, timeZone: "UTC" })!).toISOString()).toBe("2026-11-14T02:30:00.000Z");
    const system = scheduleFromTimer(["*-*-* 03:30:00"]);
    expect(new Date(nextRun(system, { now: NOW, lastStart: null, timeZone: "UTC" })!).toISOString()).toBe("2026-11-13T03:30:00.000Z");
    expect(nextRun(scheduleFromTimer(["daily"]), { now: NOW, lastStart: null })).toBeNull();
  });

  test("unitValues: Kommentare zählen nicht", () => {
    expect(unitValues("# OnCalendar=x\nOnCalendar=a\n; OnCalendar=y\n OnCalendar = b", "OnCalendar")).toEqual(["a", "b"]);
  });
});

describe("Quelle systemd", () => {
  test("Timer als Routinen, Bot als Dauerdienst, fremde Einheiten nicht", async () => {
    const deps = systemdDeps();
    const { routines, notes } = await readSystemdRoutines({ unitDir: UNITS, listDir: deps.listDir, readFile: deps.readFile, run: deps.run });
    expect(notes).toEqual([]);
    expect(routines.map(r => [r.id, r.kind, r.state, r.wrapped, r.lastExit])).toEqual([
      ["tybo-health-check", "scheduled", "active", true, 0],
      ["tybo-smart-checkin", "scheduled", "paused", true, 1],
      ["tybo-telegram-relay", "daemon", "running", false, 0],
    ]);
    const health = routines[0];
    expect(health.source).toBe("systemd");
    expect(health.name).toBe("health-check");
    expect(health.scheduleText).toBe("täglich 03:30 (Europe/Berlin)");
    expect(health.logPath).toBe(`${ROOT}/logs/health-check.log`);
    expect(health.errorLogPath).toBe(`${ROOT}/logs/health-check.error.log`);
    expect(routines[2].pid).toBe(777);
    // Nur lesend: nichts außer systemctl show
    expect(deps.calls.every(c => c.slice(0, 3).join(" ") === "systemctl --user show")).toBe(true);
  });

  test("systemctl antwortet nicht: Zustand unbekannt, Hinweis unter der Liste", async () => {
    const deps = systemdDeps({ unreachable: true });
    const { routines, notes } = await readSystemdRoutines({ unitDir: UNITS, listDir: deps.listDir, readFile: deps.readFile, run: deps.run });
    expect(routines.map(r => r.state)).toEqual(["unknown", "unknown", "unknown"]);
    expect(notes).toEqual([SYSTEMD_TEXT.unreachable]);
  });

  test("Timer ohne laufenden Manager-Eintrag: nicht geladen; Ordner fehlt: leer ohne Hinweis", async () => {
    const deps = systemdDeps({ show: { "tybo-health-check.timer": { LoadState: "not-found", ActiveState: "inactive", UnitFileState: "" } } });
    const { routines } = await readSystemdRoutines({ unitDir: UNITS, listDir: deps.listDir, readFile: deps.readFile, run: deps.run });
    expect(routines[0].state).toBe("not-loaded");
    const empty = await readSystemdRoutines({ unitDir: "/nirgends", listDir: deps.listDir, readFile: deps.readFile, run: deps.run });
    expect(empty).toEqual({ routines: [], notes: [] });
  });
});

describe("Übersicht unter Linux: systemd und PM2 zusammen", () => {
  const PM2 = { status: "ok" as const, processes: [{ name: "tybo-supabase", pid: 55, pm2_env: { status: "online" } }] };

  test("beide Quellen in einer Liste; Verlauf unter ai.tybo.<dienst> zugeordnet; nächster Lauf", async () => {
    const runFiles = { "ai.tybo.health-check": runFile("ai.tybo.health-check", [{ startedAt: "2026-11-13T02:30:01.000Z", exitCode: 0 }]) };
    const deps = { ...systemdDeps({ pm2Path: "/usr/bin/pm2", runFiles }), pm2Query: async () => PM2 };
    const list = await listRoutines(deps);
    expect(list.available).toBe(true);
    expect(list.source).toBe("systemd");
    expect(list.sources).toEqual(["systemd", "pm2"]);
    expect(list.routines.map(r => `${r.source}:${r.name}`)).toEqual(["systemd:health-check", "systemd:smart-checkin", "pm2:supabase", "systemd:telegram-relay"]);
    const health = list.routines[0];
    expect(runsIdOf(health)).toBe("ai.tybo.health-check");
    expect(health.lastRun?.startedAt).toBe("2026-11-13T02:30:01.000Z");
    expect(health.nextRun).toBe("2026-11-14T02:30:00.000Z");
    // pausiert: kein nächster Lauf
    expect(list.routines[1].nextRun).toBeNull();
  });

  test("ohne systemd nur PM2 wie bisher; ohne beides nicht verfügbar", async () => {
    const onlyPm2 = await listRoutines({ ...systemdDeps({ systemd: false, pm2Path: "/usr/bin/pm2" }), pm2Query: async () => PM2 });
    expect(onlyPm2.source).toBe("pm2");
    expect(onlyPm2.routines.map(r => r.id)).toEqual(["tybo-supabase"]);
    const none = await listRoutines(systemdDeps({ systemd: false }));
    expect(none.available).toBe(false);
  });

  test("/routinen: Kopfzeile nennt beide Quellen, Timer mit Zeitplan, Status und letztem Lauf", async () => {
    const runFiles = { "ai.tybo.health-check": runFile("ai.tybo.health-check", [{ startedAt: "2026-11-13T02:30:01.000Z", exitCode: 0, durationMs: 12_000 }]) };
    const list = await listRoutines({ ...systemdDeps({ pm2Path: "/usr/bin/pm2", runFiles }), pm2Query: async () => PM2 });
    const text = formatRoutineList(list, { now: NOW, timeZone: "Europe/Berlin" });
    expect(text).toContain("Routinen (systemd und PM2, 4):");
    expect(text).toContain("- health-check: täglich 03:30 (Europe/Berlin) · aktiv · letzter Lauf: heute 03:30, 12 s, ok · nächster Lauf: morgen 03:30");
    expect(text).toContain("- smart-checkin: täglich 10:30 und 14:00 (Europe/Berlin) · pausiert · letzter Lauf: noch keiner · nächster Lauf: keiner (pausiert)");
    expect(text).toContain("- telegram-relay: läuft · letzter Exit: ok");
  });

  test("/routinen <name>: Verlauf einer systemd-Routine aus data/routines/ai.tybo.<dienst>.json", async () => {
    const runFiles = { "ai.tybo.health-check": runFile("ai.tybo.health-check", [{ startedAt: "2026-11-12T02:30:00.000Z", exitCode: 1, tail: ["Fehler X"] }, { startedAt: "2026-11-13T02:30:00.000Z", exitCode: 0 }]) };
    const history = await routineHistory({ ...systemdDeps({ runFiles }), secrets: () => [] }, "health-check");
    expect(history?.routine.id).toBe("tybo-health-check");
    expect(history?.runs.map(r => r.exitCode)).toEqual([0, 1]);
  });

  test("unter Linux nur lesend: keine Knöpfe", async () => {
    const list = await listRoutines(systemdDeps());
    for (const r of list.routines) expect(menuActions(r)).toEqual([]);
  });

  test("API: Quelle systemd bleibt systemd, unbekannte Quelle wird null statt launchd", async () => {
    const list = await listRoutines(systemdDeps());
    const body = routinesApiBody(list as unknown as Parameters<typeof routinesApiBody>[0], HOME);
    expect(body.source).toBe("systemd");
    expect(body.routines.map(r => r.source)).toEqual(["systemd", "systemd", "systemd"]);
    expect(body.routines[0].logPath).toBe("~/tybo/logs/health-check.log");
    const odd = routinesApiBody({ available: true, source: "launchd", routines: [{ ...(list.routines[0] as unknown as RoutineInput), source: "cron" as never }], notes: [] }, HOME);
    expect(odd.routines[0].source).toBeNull();
  });
});

describe("Routinen pünktlich mit systemd-Timern", () => {
  const deps = (now: number) => ({ now, timeZone: "UTC", mtime: () => null });

  test("Termin in der Zeitzone des Timers wahrgenommen: pünktlich; ausgeblieben: gemeldet", async () => {
    const onTime = { "ai.tybo.health-check": runFile("ai.tybo.health-check", [{ startedAt: "2026-11-13T02:30:05.000Z" }]) };
    const list = await listRoutines(systemdDeps({ runFiles: onTime }));
    // 13.11. 06:00 Berlin: der Termin 03:30 Berlin (02:30 UTC) liegt länger als die Frist von 2 Stunden zurück
    const LATER = Date.parse("2026-11-13T05:00:00.000Z");
    const ok = summarizePunctuality(list, deps(LATER));
    expect(ok.available).toBe(true);
    expect(ok.missed).toEqual([]);
    expect(ok.paused).toEqual(["smart-checkin"]);

    const late = { "ai.tybo.health-check": runFile("ai.tybo.health-check", [{ startedAt: "2026-11-12T02:30:05.000Z" }]) };
    const missed = summarizePunctuality(await listRoutines(systemdDeps({ runFiles: late })), deps(LATER));
    expect(missed.missed.map(m => [m.name, new Date(m.due).toISOString()])).toEqual([["health-check", "2026-11-13T02:30:00.000Z"]]);
    const line = evaluatePunctuality(missed, LATER, "Europe/Berlin");
    expect(line.status).toBe("warn");
    expect(line.detail).toContain("ausgeblieben: health-check (fällig heute 03:30)");
  });

  test("Timer ohne Zeitzone rechnet in der Zeitzone des Systems", async () => {
    const files = units(null);
    const run = { "ai.tybo.health-check": runFile("ai.tybo.health-check", [{ startedAt: "2026-11-13T02:30:05.000Z" }]) };
    // System UTC: Termin 03:30 UTC am 13.11. zählt ab 05:30 UTC, der Lauf um 02:30 UTC war davor
    const s = summarizePunctuality(await listRoutines(systemdDeps({ files, runFiles: run })), deps(Date.parse("2026-11-13T06:00:00.000Z")));
    expect(s.missed.map(m => m.name)).toEqual(["health-check"]);
  });

  test("nur PM2: weiter nicht prüfbar", async () => {
    const s = summarizePunctuality(await listRoutines({ ...systemdDeps({ systemd: false, pm2Path: "/usr/bin/pm2" }), pm2Query: async () => ({ status: "ok", processes: [] }) }), deps(NOW));
    expect(s.available).toBe(false);
  });
});
