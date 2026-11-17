/**
 * Issue #370: Routinen unter Linux als systemd-Timer, ohne systemd als
 * cron-Zeilen (src/lib/services/systemd.ts, src/setup/services/linux.ts).
 * systemctl, loginctl, crontab, which und das Dateisystem sind Attrappen;
 * kein Test richtet einen echten Dienst ein.
 */

import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { serviceDefinition } from "../src/lib/services/catalog";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { cronLines, cronMarker, cronTimes, isOwnCronLine, legacyCronMarker, onCalendar, pm2CronExpression, serviceUnit, timerTimeZone, timerUnit, UnitError, type LinuxMachine } from "../src/lib/services/systemd";
import { readCrontab, readUserTimeZone, setUpTimer, timerFailureMessage, userUnitDir, type LinuxDeps } from "../src/setup/services/linux";
import { EMPTY_ROUTINES_CONFIG } from "../src/lib/routines/config";
import { routineIdAllowed } from "../src/lib/routines/runs";
import type { SetupSchedule } from "../src/lib/proactive/setup-schedule";

const ROOT = "/home/alex/tybo";
const HOME = "/home/alex";
const UNITS = "/home/alex/.config/systemd/user";
const RUN_DIR = "/run/systemd/system";
const MACHINE: LinuxMachine = { bun: "/home/alex/.bun/bin/bun", claudeDir: "/home/alex/.local/bin", home: HOME, projectRoot: ROOT };
const CHECKIN = serviceDefinition("smart-checkin");
const BRIEFING = serviceDefinition("morning-briefing");
const SCHEDULE: SetupSchedule = { morning_briefing: { hour: 7, minute: 15, enabled: true }, check_in_intervals: [{ hour: 10, minute: 30 }, { hour: 14, minute: 0 }] };

const FOREIGN_CRON = "5 4 * * * /usr/bin/backup.sh";
const OLD_CHECKIN_CRON = `30 10 * * * cd ${ROOT} && bun run ${ROOT}/src/routines/checkin.ts >> ${ROOT}/logs/smart-checkin.log 2>&1 ${legacyCronMarker("smart-checkin")}`;
const OLD_BRIEFING_CRON = `0 9 * * * cd ${ROOT} && bun run ${ROOT}/src/routines/briefing.ts >> ${ROOT}/logs/morning-briefing.log 2>&1 ${legacyCronMarker("morning-briefing")}`;

describe("Einheiten aus dem Katalog", () => {
  test("Dienst-Einheit: oneshot, Wrapper mit zugelassener Kennung, PATH, Protokoll", () => {
    const unit = serviceUnit(CHECKIN, MACHINE);
    expect(unit).toContain("Type=oneshot");
    expect(unit).toContain(`WorkingDirectory=${ROOT}`);
    expect(unit).toContain(
      `ExecStart=${MACHINE.bun} --no-env-file src/routine-run.ts --id ai.tybo.smart-checkin -- ${MACHINE.bun} run src/routines/checkin.ts`,
    );
    expect(unit).toContain(`Environment=PATH=/home/alex/.bun/bin:/home/alex/.local/bin:/usr/local/bin:/usr/bin:/bin`);
    expect(unit).toContain(`Environment=GO_PROJECT_ROOT=${ROOT}`);
    expect(unit).toContain(`StandardOutput=append:${ROOT}/logs/smart-checkin.log`);
    expect(unit).toContain(`StandardError=append:${ROOT}/logs/smart-checkin.error.log`);
    expect(routineIdAllowed("ai.tybo.smart-checkin", EMPTY_ROUTINES_CONFIG)).toBe(true);
    expect(routineIdAllowed("ai.tybo.morning-briefing", EMPTY_ROUTINES_CONFIG)).toBe(true);
  });

  test("Timer: ein OnCalendar je Termin, Persistent, Verweis auf den Dienst", () => {
    const timer = timerUnit(CHECKIN, SCHEDULE);
    expect(timer.split("\n").filter(l => l.startsWith("OnCalendar="))).toEqual(["OnCalendar=*-*-* 10:30:00", "OnCalendar=*-*-* 14:00:00"]);
    expect(timer).toContain("Persistent=true");
    expect(timer).toContain("Unit=tybo-smart-checkin.service");
    expect(timer).toContain("WantedBy=timers.target");
    expect(timerUnit(BRIEFING, SCHEDULE)).toContain("OnCalendar=*-*-* 07:15:00");
  });

  test("Platzhalter aus dem Katalog (volle Reihen) werden *", () => {
    const everyHour = Array.from({ length: 24 }, (_, hour) => ({ hour, minute: 30 }));
    const timer = timerUnit(CHECKIN, { ...SCHEDULE, check_in_intervals: everyHour });
    expect(timer.split("\n").filter(l => l.startsWith("OnCalendar="))).toEqual(["OnCalendar=*-*-* *:30:00"]);
    expect(onCalendar({ hour: 9 })).toBe("*-*-* 09:*:00");
    expect(onCalendar({})).toBe("*-*-* *:*:00");
    expect(cronLines(CHECKIN, MACHINE, { ...SCHEDULE, check_in_intervals: everyHour })[0].startsWith("30 * * * * ")).toBe(true);
  });

  test("cron: überlappende Termine starten je Zeitpunkt genau einmal", () => {
    const everyHourAt30 = Array.from({ length: 24 }, (_, hour) => ({ hour, minute: 30 }));
    const everyMinuteOf10 = Array.from({ length: 60 }, (_, minute) => ({ hour: 10, minute }));
    const schedule = { ...SCHEDULE, check_in_intervals: [...everyHourAt30, ...everyMinuteOf10, { hour: 15, minute: 5 }] };
    const lines = cronLines(CHECKIN, MACHINE, schedule).map(l => l.split(" ").slice(0, 2).join(" "));
    // Auslösungen je Minute des Tages, ohne Duplikate zu verschlucken
    const fires = new Map<number, number>();
    const values = (field: string, size: number) =>
      field === "*"
        ? Array.from({ length: size }, (_, i) => i)
        : field.split(",").flatMap(part => {
            const [a, b = a] = part.split("-").map(Number);
            return Array.from({ length: b - a + 1 }, (_, i) => a + i);
          });
    for (const line of lines) {
      const [m, h] = line.split(" ");
      for (const hour of values(h, 24)) for (const minute of values(m, 60)) fires.set(hour * 60 + minute, (fires.get(hour * 60 + minute) ?? 0) + 1);
    }
    expect(fires.get(10 * 60 + 30)).toBe(1);
    expect([...fires.values()].every(n => n === 1)).toBe(true);
    expect(fires.size).toBe(24 + 60 - 1 + 1);
    expect(cronTimes([{ minute: 30 }, { hour: 10 }])).toEqual(["30 *", "0-29,31-59 10"]);
    expect(cronTimes([{ hour: 10 }, { minute: 30 }, { hour: 10, minute: 30 }])).toEqual(["* 10", "30 0-9,11-23"]);
    expect(cronTimes([{ minute: 30 }, {}])).toEqual(["30 *", "0-29,31-59 *"]);
  });

  test("ohne Termine kein Timer (systemd lehnt ihn ab)", () => {
    expect(() => timerUnit(CHECKIN, { ...SCHEDULE, check_in_intervals: [] })).toThrow(UnitError);
    expect(cronLines(CHECKIN, MACHINE, { ...SCHEDULE, check_in_intervals: [] })).toEqual([]);
  });

  test("Pfade mit Leerzeichen, %, $ oder Anführungszeichen werden abgelehnt", () => {
    for (const projectRoot of ["/home/a b/tybo", "/home/a%b", "/home/$x", `/home/"x"`]) {
      expect(() => serviceUnit(CHECKIN, { ...MACHINE, projectRoot })).toThrow(UnitError);
      expect(() => cronLines(CHECKIN, { ...MACHINE, projectRoot }, SCHEDULE)).toThrow(UnitError);
    }
    expect(() => serviceUnit(CHECKIN, { ...MACHINE, claudeDir: "/opt/a:b" })).toThrow(UnitError);
  });

  test("nur Routinen: Bot und Supabase bekommen keinen Timer", () => {
    expect(() => serviceUnit(serviceDefinition("telegram-relay"), MACHINE)).toThrow(UnitError);
    expect(() => timerUnit(serviceDefinition("supabase"), SCHEDULE)).toThrow(UnitError);
  });

  test("Wartung (Issue #485): sonntags 03:15 als Timer und cron-Zeile, nicht täglich", () => {
    const wartung = serviceDefinition("wartung");
    expect(onCalendar({ weekday: 0, hour: 3, minute: 15 })).toBe("Sun *-*-* 03:15:00");
    const timer = timerUnit(wartung, SCHEDULE);
    expect(timer).toContain("OnCalendar=Sun *-*-* 03:15:00\n");
    expect(timer).not.toContain("OnCalendar=*-*-*");
    const lines = cronLines(wartung, MACHINE, SCHEDULE);
    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith("15 3 * * 0 cd ")).toBe(true);
    expect(lines[0]).toContain("--id ai.tybo.wartung -- /home/alex/.bun/bin/bun run src/maintenance.ts");
    expect(lines[0].endsWith("# tybo-wartung")).toBe(true);
    expect(serviceUnit(wartung, MACHINE)).toContain("src/routine-run.ts --id ai.tybo.wartung");
    expect(routineIdAllowed("ai.tybo.wartung", EMPTY_ROUTINES_CONFIG)).toBe(true);
  });

  test("cron: Termine mit und ohne Wochentag in getrennten Zeilen", () => {
    const def = { ...CHECKIN, calendar: () => ({ form: "list" as const, slots: [{ hour: 3, minute: 15, weekday: 0 }, { hour: 3, minute: 15 }, { hour: 4, minute: 0, weekday: 6 }] }) };
    expect(cronLines(def, MACHINE, SCHEDULE).map(l => l.split(" ").slice(0, 5).join(" "))).toEqual(["15 3 * * 0", "15 3 * * *", "0 4 * * 6"]);
  });

  test("cron-Zeile: Wrapper, Umgebung, Protokoll, Markierung am Ende", () => {
    const [line] = cronLines(BRIEFING, MACHINE, SCHEDULE);
    expect(line).toBe(
      `15 7 * * * cd ${ROOT} && PATH=/home/alex/.bun/bin:/home/alex/.local/bin:/usr/local/bin:/usr/bin:/bin GO_PROJECT_ROOT=${ROOT} ` +
        `${MACHINE.bun} --no-env-file src/routine-run.ts --id ai.tybo.morning-briefing -- ${MACHINE.bun} run src/routines/briefing.ts ` +
        `>> ${ROOT}/logs/morning-briefing.log 2>> ${ROOT}/logs/morning-briefing.error.log # tybo-morning-briefing`,
    );
  });

  test("Markierungen: eigene und frühere, nie ein ähnlicher Name", () => {
    expect(cronMarker("smart-checkin")).toBe("# tybo-smart-checkin");
    expect(isOwnCronLine(OLD_CHECKIN_CRON, "smart-checkin")).toBe(true);
    expect(isOwnCronLine(`x ${cronMarker("smart-checkin")}  `, "smart-checkin")).toBe(true);
    expect(isOwnCronLine(OLD_CHECKIN_CRON, "morning-briefing")).toBe(false);
    expect(isOwnCronLine("x # go-smart-checkin-alt", "smart-checkin")).toBe(false);
    expect(isOwnCronLine(FOREIGN_CRON, "smart-checkin")).toBe(false);
  });

  test("XDG-Ordner der Benutzereinheiten", () => {
    expect(userUnitDir({}, HOME)).toBe(UNITS);
    expect(userUnitDir({ XDG_CONFIG_HOME: "/cfg" }, HOME)).toBe("/cfg/systemd/user");
  });
});

// ---------------------------------------------------------------------------
// Einrichtung gegen Attrappen
// ---------------------------------------------------------------------------

interface FakeOptions {
  systemd?: boolean;
  unreachable?: boolean;
  crontab?: string[] | "missing" | "broken";
  failCrontabWrite?: boolean;
  failEnable?: boolean;
  /** Prüfer-Hinweis zu #568: enable gelingt, restart scheitert */
  failRestart?: boolean;
  failDisable?: boolean;
  failWrite?: boolean;
  linger?: "yes" | "no";
  scheduleJson?: unknown;
  settingsJson?: unknown;
}

function fakeLinux(options: FakeOptions = {}) {
  const files = new Map<string, string>();
  if (options.scheduleJson !== undefined) files.set(join(ROOT, "config", "schedule.json"), JSON.stringify(options.scheduleJson));
  if (options.settingsJson !== undefined) files.set(join(ROOT, "config", "settings.json"), JSON.stringify(options.settingsJson));
  let crontab: string[] | null = Array.isArray(options.crontab) ? [...options.crontab] : null;
  const timers = new Map<string, { active: boolean; enabled: boolean }>();
  const calls: string[] = [];
  const lines: string[] = [];
  const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
  const fail = (stderr = "Fehler") => ({ ok: false, stdout: "", stderr });
  const deps: LinuxDeps = {
    projectRoot: ROOT,
    home: HOME,
    unitDir: UNITS,
    runDir: RUN_DIR,
    user: "alex",
    async run(cmd, opts) {
      const text = cmd.join(" ");
      if (cmd[0] === "which") return ok(cmd[1] === "bun" ? MACHINE.bun : `${MACHINE.claudeDir}/claude`);
      if (cmd[0] === "loginctl") return ok(options.linger ?? "yes");
      if (cmd[0] === "crontab") {
        if (options.crontab === "missing") return { ok: false, stdout: "", stderr: "Befehl nicht gefunden", missing: true };
        if (cmd[1] === "-l") {
          if (options.crontab === "broken") return fail("crontab: Zugriff verweigert");
          return crontab === null ? fail("no crontab for alex") : ok(crontab.join("\n"));
        }
        calls.push("crontab -");
        if (options.failCrontabWrite) return fail();
        const input = opts?.stdin ?? "";
        crontab = input === "" ? [] : input.replace(/\n$/, "").split("\n");
        return ok();
      }
      if (cmd[0] !== "systemctl" || cmd[1] !== "--user") throw new Error(`unerwarteter Befehl: ${text}`);
      if (options.unreachable) return fail("Failed to connect to bus");
      const unit = cmd[cmd.length - 1];
      if (cmd[2] === "show") {
        const name = cmd[3];
        const loaded = files.has(join(UNITS, name));
        const t = timers.get(name) ?? { active: false, enabled: false };
        return ok(`LoadState=${loaded ? "loaded" : "not-found"}\nActiveState=${t.active ? "active" : "inactive"}\nUnitFileState=${t.enabled ? "enabled" : loaded ? "disabled" : ""}`);
      }
      calls.push(cmd.slice(2).join(" "));
      if (cmd[2] === "daemon-reload") return ok();
      if (cmd[2] === "enable") {
        if (options.failEnable) return fail();
        timers.set(unit, { ...(timers.get(unit) ?? { active: false }), enabled: true });
        return ok();
      }
      if (cmd[2] === "restart") {
        if (options.failRestart) return fail();
        timers.set(unit, { ...(timers.get(unit) ?? { enabled: false }), active: true });
        return ok();
      }
      if (cmd[2] === "disable") {
        if (options.failDisable) return fail();
        timers.set(unit, { active: false, enabled: false });
        return ok();
      }
      throw new Error(`unerwarteter Befehl: ${text}`);
    },
    exists: p => (p === RUN_DIR ? options.systemd !== false : files.has(p)),
    readFile: p => {
      const c = files.get(p);
      if (c === undefined) throw new Error(`ENOENT ${p}`);
      return c;
    },
    writeFile: (p, c) => {
      if (options.failWrite) throw new Error("EACCES");
      files.set(p, c);
    },
    remove: p => void files.delete(p),
    mkdir: () => {},
    log: l => lines.push(l),
  };
  return { deps, files, timers, calls, lines, crontab: () => crontab, setOptions: (o: FakeOptions) => Object.assign(options, o) };
}

const TIMER_FILE = join(UNITS, "tybo-smart-checkin.timer");
const SERVICE_FILE = join(UNITS, "tybo-smart-checkin.service");

describe("setUpTimer mit systemd", () => {
  test("erstmals: beide Einheiten, daemon-reload, enable, restart; Standardtermine aus den Einstellungen", async () => {
    const fk = fakeLinux({ settingsJson: { proactive: { checkin: { times: ["11:00", "15:45"] } } } });
    const r = await setUpTimer("smart-checkin", fk.deps);
    expect(r).toEqual({ ok: true, service: "smart-checkin", via: "systemd", action: "written", cronLinesRemoved: 0 });
    expect(fk.calls).toEqual(["daemon-reload", "enable tybo-smart-checkin.timer", "restart tybo-smart-checkin.timer"]);
    expect(fk.files.get(TIMER_FILE)).toContain("OnCalendar=*-*-* 11:00:00\nOnCalendar=*-*-* 15:45:00\n");
    expect(fk.files.get(SERVICE_FILE)).toContain("--id ai.tybo.smart-checkin");
    // keine crontab vorhanden: nichts geschrieben
    expect(fk.crontab()).toBeNull();
  });

  test("Wiederholung: nichts geschrieben, kein systemctl außer show", async () => {
    const fk = fakeLinux();
    await setUpTimer("smart-checkin", fk.deps);
    fk.calls.length = 0;
    const r = await setUpTimer("smart-checkin", fk.deps);
    expect(r.ok && r.action).toBe("unchanged");
    expect(fk.calls).toEqual([]);
  });

  test("geänderter Zeitplan: neu geschrieben und Timer neu gestartet", async () => {
    const fk = fakeLinux({ scheduleJson: { check_in_intervals: [{ hour: 9, minute: 0 }] } });
    await setUpTimer("smart-checkin", fk.deps);
    fk.files.set(join(ROOT, "config", "schedule.json"), JSON.stringify({ check_in_intervals: [{ hour: 12, minute: 5 }] }));
    fk.calls.length = 0;
    const r = await setUpTimer("smart-checkin", fk.deps);
    expect(r.ok && r.action).toBe("written");
    expect(fk.calls).toEqual(["daemon-reload", "enable tybo-smart-checkin.timer", "restart tybo-smart-checkin.timer"]);
    expect(fk.files.get(TIMER_FILE)).toContain("OnCalendar=*-*-* 12:05:00");
    expect(fk.files.get(TIMER_FILE)).not.toContain("09:00");
  });

  test("Lesart „zero“: fehlende Minute in schedule.json ist 0, wie bisher unter cron", async () => {
    const fk = fakeLinux({ scheduleJson: { check_in_intervals: [{ hour: 10 }], morning_briefing: { hour: 8 } } });
    await setUpTimer("smart-checkin", fk.deps);
    await setUpTimer("morning-briefing", fk.deps);
    expect(fk.files.get(TIMER_FILE)!.split("\n").filter(l => l.startsWith("OnCalendar="))).toEqual(["OnCalendar=*-*-* 10:00:00"]);
    expect(fk.files.get(join(UNITS, "tybo-morning-briefing.timer"))).toContain("OnCalendar=*-*-* 08:00:00");
  });

  test("leerer Zeitplan: vorhandener Timer abgeschaltet und gelöscht; ohne Timer nichts", async () => {
    const fk = fakeLinux({ scheduleJson: { check_in_intervals: [{ hour: 9, minute: 0 }] } });
    await setUpTimer("smart-checkin", fk.deps);
    fk.files.set(join(ROOT, "config", "schedule.json"), JSON.stringify({ check_in_intervals: [] }));
    fk.calls.length = 0;
    const r = await setUpTimer("smart-checkin", fk.deps);
    expect(r.ok && r.action).toBe("removed");
    expect(fk.calls).toEqual(["disable --now tybo-smart-checkin.timer", "daemon-reload"]);
    expect(fk.files.has(TIMER_FILE) || fk.files.has(SERVICE_FILE)).toBe(false);
    fk.calls.length = 0;
    const again = await setUpTimer("smart-checkin", fk.deps);
    expect(again.ok && again.action).toBe("none");
    expect(fk.calls).toEqual([]);
  });

  test("leerer Zeitplan: aktiver Timer ohne Dateien wird trotzdem abgeschaltet", async () => {
    const fk = fakeLinux({ scheduleJson: { check_in_intervals: [] } });
    fk.timers.set("tybo-smart-checkin.timer", { active: true, enabled: true });
    const r = await setUpTimer("smart-checkin", fk.deps);
    expect(r).toEqual({ ok: true, service: "smart-checkin", via: "systemd", action: "removed", cronLinesRemoved: 0 });
    expect(fk.calls).toEqual(["disable --now tybo-smart-checkin.timer", "daemon-reload"]);
    expect(fk.timers.get("tybo-smart-checkin.timer")).toEqual({ active: false, enabled: false });
    expect(fk.lines.join("\n")).not.toContain("kein Timer eingerichtet");
    // nur aktiviert, nicht aktiv: ebenso
    const enabledOnly = fakeLinux({ scheduleJson: { check_in_intervals: [] } });
    enabledOnly.timers.set("tybo-smart-checkin.timer", { active: false, enabled: true });
    expect((await setUpTimer("smart-checkin", enabledOnly.deps)).ok && enabledOnly.calls[0]).toBe("disable --now tybo-smart-checkin.timer");
  });

  test("leerer Zeitplan: Stopp scheitert, kein Erfolg gemeldet", async () => {
    const fk = fakeLinux({ scheduleJson: { check_in_intervals: [] }, failDisable: true, crontab: [OLD_CHECKIN_CRON] });
    fk.timers.set("tybo-smart-checkin.timer", { active: true, enabled: true });
    const r = await setUpTimer("smart-checkin", fk.deps);
    expect(r).toEqual({ ok: false, service: "smart-checkin", failure: "disable" });
    expect(fk.crontab()).toEqual([OLD_CHECKIN_CRON]);
    expect(fk.lines.join("\n")).not.toContain("✓");
  });

  test("Benutzer-Manager nicht erreichbar: Abbruch, keine Datei, crontab unberührt", async () => {
    const fk = fakeLinux({ unreachable: true, crontab: [OLD_CHECKIN_CRON, FOREIGN_CRON] });
    const r = await setUpTimer("smart-checkin", fk.deps);
    expect(r).toEqual({ ok: false, service: "smart-checkin", failure: "user-manager" });
    expect(fk.files.size).toBe(0);
    expect(fk.crontab()).toEqual([OLD_CHECKIN_CRON, FOREIGN_CRON]);
    expect(fk.lines.join("\n")).toContain(timerFailureMessage("user-manager", "smart-checkin"));
  });

  test("Umstieg: eigene # go-Zeilen des Diensts verschwinden erst nach dem Timer, fremde und andere Dienste bleiben", async () => {
    const fk = fakeLinux({ crontab: [FOREIGN_CRON, OLD_CHECKIN_CRON, OLD_BRIEFING_CRON, OLD_CHECKIN_CRON.replace("30 10", "30 14")] });
    const r = await setUpTimer("smart-checkin", fk.deps);
    expect(r).toEqual({ ok: true, service: "smart-checkin", via: "systemd", action: "written", cronLinesRemoved: 2 });
    expect(fk.crontab()).toEqual([FOREIGN_CRON, OLD_BRIEFING_CRON]);
    expect(fk.calls.indexOf("crontab -")).toBeGreaterThan(fk.calls.indexOf("restart tybo-smart-checkin.timer"));
    // Wiederholung: nichts mehr zu entfernen, keine Doppelplanung
    fk.calls.length = 0;
    const again = await setUpTimer("smart-checkin", fk.deps);
    expect(again.ok && again.cronLinesRemoved).toBe(0);
    expect(fk.calls).toEqual([]);
  });

  test("Timer scheitert: alte cron-Zeilen bleiben (kein Verlust des Zeitplans)", async () => {
    const fk = fakeLinux({ failEnable: true, crontab: [OLD_CHECKIN_CRON] });
    const r = await setUpTimer("smart-checkin", fk.deps);
    expect(r.ok ? null : r.failure).toBe("enable");
    expect(fk.crontab()).toEqual([OLD_CHECKIN_CRON]);
    expect(fk.calls).not.toContain("crontab -");
  });

  test("Timer scheitert: auch nach gelungenem enable wieder abgeschaltet, weder aktiviert noch aktiv, cron bleibt", async () => {
    for (const failure of [{ failEnable: true }, { failRestart: true }]) {
      const fk = fakeLinux({ ...failure, crontab: [OLD_CHECKIN_CRON] });
      const r = await setUpTimer("smart-checkin", fk.deps);
      expect(r).toEqual({ ok: false, service: "smart-checkin", failure: "enable" });
      expect(fk.calls.at(-1)).toBe("disable --now tybo-smart-checkin.timer");
      const state = fk.timers.get("tybo-smart-checkin.timer") ?? { active: false, enabled: false };
      expect(state.enabled).toBe(false);
      expect(state.active).toBe(false);
      expect(fk.crontab()).toEqual([OLD_CHECKIN_CRON]);
      expect(fk.lines.join("\n")).toContain(timerFailureMessage("enable", "smart-checkin"));
    }
  });

  test("restart scheitert und Abschalten auch: gemeldet als möglicher Doppellauf mit Befehl", async () => {
    const fk = fakeLinux({ failRestart: true, failDisable: true, crontab: [OLD_CHECKIN_CRON] });
    const r = await setUpTimer("smart-checkin", fk.deps);
    expect(r.ok ? null : r.failure).toBe("enable-double");
    expect(fk.lines.join("\n")).toContain("doppelt");
    expect(fk.lines.join("\n")).toContain("systemctl --user disable --now tybo-smart-checkin.timer");
    expect(fk.crontab()).toEqual([OLD_CHECKIN_CRON]);
  });

  test("Schreiben der Einheiten scheitert: Fehler write, crontab unberührt", async () => {
    const fk = fakeLinux({ failWrite: true, crontab: [OLD_CHECKIN_CRON] });
    const r = await setUpTimer("smart-checkin", fk.deps);
    expect(r.ok ? null : r.failure).toBe("write");
    expect(fk.crontab()).toEqual([OLD_CHECKIN_CRON]);
  });

  test("Aufräumen der crontab scheitert: Timer wieder abgeschaltet, nur cron gilt, gemeldet", async () => {
    const fk = fakeLinux({ failCrontabWrite: true, crontab: [OLD_CHECKIN_CRON] });
    const r = await setUpTimer("smart-checkin", fk.deps);
    expect(r.ok ? null : r.failure).toBe("cron-cleanup");
    expect(fk.calls.slice(-2)).toEqual(["crontab -", "disable --now tybo-smart-checkin.timer"]);
    expect(fk.timers.get("tybo-smart-checkin.timer")).toEqual({ active: false, enabled: false });
    expect(fk.crontab()).toEqual([OLD_CHECKIN_CRON]);
    expect(fk.lines.join("\n")).toContain(timerFailureMessage("cron-cleanup", "smart-checkin"));
  });

  test("Aufräumen der crontab und Abschalten scheitern: gemeldet als Doppellauf mit Befehl, nicht still", async () => {
    const fk = fakeLinux({ failCrontabWrite: true, failDisable: true, crontab: [OLD_CHECKIN_CRON] });
    const r = await setUpTimer("smart-checkin", fk.deps);
    expect(r.ok ? null : r.failure).toBe("cron-cleanup-double");
    expect(fk.lines.join("\n")).toContain("startet doppelt");
    expect(fk.lines.join("\n")).toContain("systemctl --user disable --now tybo-smart-checkin.timer");
  });

  test("crontab nicht lesbar: nichts geändert; nicht installiert zählt als leer", async () => {
    const broken = fakeLinux({ crontab: "broken" });
    const r = await setUpTimer("smart-checkin", broken.deps);
    expect(r.ok ? null : r.failure).toBe("crontab-unreadable");
    expect(broken.files.size).toBe(0);
    expect(broken.calls).toEqual([]);
    const missing = fakeLinux({ crontab: "missing" });
    expect(await readCrontab(missing.deps)).toEqual([]);
    expect((await setUpTimer("smart-checkin", missing.deps)).ok).toBe(true);
  });

  test("Linger fehlt: Hinweis mit Befehl, keine Änderung daran", async () => {
    const fk = fakeLinux({ linger: "no" });
    await setUpTimer("smart-checkin", fk.deps);
    expect(fk.lines.join("\n")).toContain("sudo loginctl enable-linger alex");
    expect(fk.calls.some(c => c.includes("linger"))).toBe(false);
  });

  test("kein Zeitplan-Dienst: abgelehnt, nichts geändert", async () => {
    const fk = fakeLinux();
    for (const s of ["telegram-relay", "software-update", "cloudflare-tunnel"] as const) {
      const r = await setUpTimer(s, fk.deps);
      expect(r.ok ? null : r.failure).toBe("not-a-timer");
    }
    expect(fk.files.size).toBe(0);
  });

  test("unsicherer Projektordner: abgelehnt, nichts geändert", async () => {
    const fk = fakeLinux();
    const r = await setUpTimer("smart-checkin", { ...fk.deps, projectRoot: "/home/alex/mein tybo" });
    expect(r.ok ? null : r.failure).toBe("unsafe-path");
    expect(fk.calls).toEqual([]);
  });
});

describe("setUpTimer ohne systemd (cron)", () => {
  test("eigene Zeilen ersetzt, alte # go-Zeilen weg, fremde bleiben; Wiederholung schreibt nichts", async () => {
    const fk = fakeLinux({ systemd: false, scheduleJson: { check_in_intervals: [{ hour: 10, minute: 30 }, { hour: 18, minute: 30 }] }, crontab: [FOREIGN_CRON, OLD_CHECKIN_CRON, OLD_BRIEFING_CRON] });
    const r = await setUpTimer("smart-checkin", fk.deps);
    expect(r).toEqual({ ok: true, service: "smart-checkin", via: "cron", action: "written", cronLinesRemoved: 1 });
    const tab = fk.crontab()!;
    expect(tab.slice(0, 2)).toEqual([FOREIGN_CRON, OLD_BRIEFING_CRON]);
    expect(tab.slice(2).map(l => l.split(" ").slice(0, 2).join(" "))).toEqual(["30 10", "30 18"]);
    expect(tab.slice(2).every(l => l.endsWith("# tybo-smart-checkin"))).toBe(true);
    expect(fk.files.size).toBe(1); // nur schedule.json, keine Einheit
    fk.calls.length = 0;
    const again = await setUpTimer("smart-checkin", fk.deps);
    expect(again.ok && again.action).toBe("unchanged");
    expect(fk.calls).toEqual([]);
  });

  test("leerer Zeitplan entfernt nur die eigenen Zeilen", async () => {
    const fk = fakeLinux({ systemd: false, scheduleJson: { check_in_intervals: [] }, crontab: [FOREIGN_CRON, OLD_CHECKIN_CRON] });
    const r = await setUpTimer("smart-checkin", fk.deps);
    expect(r.ok && r.action).toBe("removed");
    expect(fk.crontab()).toEqual([FOREIGN_CRON]);
  });

  test("crontab nicht schreibbar: Fehler, bisherige Zeilen bleiben", async () => {
    const fk = fakeLinux({ systemd: false, failCrontabWrite: true, crontab: [FOREIGN_CRON, OLD_CHECKIN_CRON] });
    const r = await setUpTimer("smart-checkin", fk.deps);
    expect(r.ok ? null : r.failure).toBe("crontab-write");
    expect(fk.crontab()).toEqual([FOREIGN_CRON, OLD_CHECKIN_CRON]);
  });

  test("logs/ nicht anlegbar: Fehler, keine neue crontab, kein Erfolg gemeldet", async () => {
    const fk = fakeLinux({ systemd: false, crontab: [FOREIGN_CRON, OLD_CHECKIN_CRON] });
    const r = await setUpTimer("smart-checkin", {
      ...fk.deps,
      mkdir: () => {
        throw new Error("EACCES");
      },
    });
    expect(r.ok ? null : r.failure).toBe("logs-dir");
    expect(fk.calls).not.toContain("crontab -");
    expect(fk.crontab()).toEqual([FOREIGN_CRON, OLD_CHECKIN_CRON]);
    const log = fk.lines.join("\n");
    expect(log).toContain(timerFailureMessage("logs-dir", "smart-checkin"));
    expect(log).not.toContain("✓");
  });

  test("leere crontab („no crontab“): neue Zeilen eingetragen", async () => {
    const fk = fakeLinux({ systemd: false });
    const r = await setUpTimer("morning-briefing", fk.deps);
    expect(r.ok && r.action).toBe("written");
    expect(fk.crontab()!.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Issue #568: Nachtcheck als Timer, Zeitzone aus USER_TIMEZONE
// ---------------------------------------------------------------------------

describe("Zeitzone der Timer (Issue #568)", () => {
  const HEALTH = serviceDefinition("health-check");

  test("timerTimeZone: gültig, fehlend, ungültig, andere Schreibweise", () => {
    expect(timerTimeZone("Europe/Berlin")).toEqual({ zone: "Europe/Berlin", warning: null });
    expect(timerTimeZone(" UTC ")).toEqual({ zone: "UTC", warning: null });
    expect(timerTimeZone("europe/berlin")).toEqual({ zone: "Europe/Berlin", warning: null });
    expect(timerTimeZone(undefined)).toEqual({ zone: null, warning: null });
    expect(timerTimeZone("")).toEqual({ zone: null, warning: null });
    for (const bad of ["Mars/Olympus", "+01:00", "Europe/Berlin; rm -rf", "Europe/../etc", "Europe Berlin"]) {
      const r = timerTimeZone(bad);
      expect(r.zone).toBeNull();
      expect(r.warning).toContain("keine gültige Zeitzone");
    }
  });

  test("Nachtcheck im Katalog: Linux-Timer täglich 03:30, unter PM2 als Zeitplan", () => {
    expect(HEALTH.linux).toBe("timer");
    expect(HEALTH.pm2Schedule).toBe(true);
    expect(serviceDefinition("smart-checkin").pm2Schedule).toBeUndefined();
    expect(serviceDefinition("software-update").linux).toBeUndefined();
    const unit = serviceUnit(HEALTH, MACHINE);
    expect(unit).toContain(`ExecStart=${MACHINE.bun} --no-env-file src/routine-run.ts --id ai.tybo.health-check -- ${MACHINE.bun} run src/health-check.ts`);
    expect(unit).toContain(`StandardError=append:${ROOT}/logs/health-check.error.log`);
    expect(routineIdAllowed("ai.tybo.health-check", EMPTY_ROUTINES_CONFIG)).toBe(true);
  });

  test("Timer-Datei trägt die Zeitzone in jedem OnCalendar, ohne Zeitzone ein Kommentar zur Systemzeit", () => {
    const berlin = timerUnit(HEALTH, SCHEDULE, "Europe/Berlin");
    expect(berlin.split("\n").filter(l => l.startsWith("OnCalendar="))).toEqual(["OnCalendar=*-*-* 03:30:00 Europe/Berlin"]);
    expect(berlin).toContain("# Zeitzone aus USER_TIMEZONE");
    const checkin = timerUnit(CHECKIN, SCHEDULE, "America/New_York");
    expect(checkin.split("\n").filter(l => l.startsWith("OnCalendar="))).toEqual(["OnCalendar=*-*-* 10:30:00 America/New_York", "OnCalendar=*-*-* 14:00:00 America/New_York"]);
    expect(timerUnit(serviceDefinition("wartung"), SCHEDULE, "Europe/Berlin")).toContain("OnCalendar=Sun *-*-* 03:15:00 Europe/Berlin");
    const system = timerUnit(HEALTH, SCHEDULE);
    expect(system).toContain("OnCalendar=*-*-* 03:30:00\n");
    expect(system).toContain("# Zeitzone des Systems (USER_TIMEZONE fehlt oder ist ungültig)");
    expect(() => timerUnit(HEALTH, SCHEDULE, "Europe/Berlin\nExecStart=x")).toThrow(UnitError);
  });

  test("setUpTimer: Zeitzone aus USER_TIMEZONE, unabhängig von der Zeitzone des Systems", async () => {
    const savedTz = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      const fk = fakeLinux();
      const r = await setUpTimer("health-check", { ...fk.deps, userTimeZone: () => "Europe/Berlin" });
      expect(r.ok && r.action).toBe("written");
      expect(fk.files.get(join(UNITS, "tybo-health-check.timer"))).toContain("OnCalendar=*-*-* 03:30:00 Europe/Berlin\n");
      expect(fk.lines.join("\n")).toContain("Zeitzone: Europe/Berlin");
      expect(fk.calls).toEqual(["daemon-reload", "enable tybo-health-check.timer", "restart tybo-health-check.timer"]);
    } finally {
      if (savedTz === undefined) delete process.env.TZ;
      else process.env.TZ = savedTz;
    }
  });

  test("setUpTimer: fehlende USER_TIMEZONE heißt Systemzeit ohne Warnung, ungültige warnt", async () => {
    const missing = fakeLinux();
    await setUpTimer("health-check", { ...missing.deps, userTimeZone: () => undefined });
    expect(missing.files.get(join(UNITS, "tybo-health-check.timer"))).toContain("OnCalendar=*-*-* 03:30:00\n");
    expect(missing.lines.join("\n")).toContain("Zeitzone: die des Systems");
    expect(missing.lines.join("\n")).not.toContain("keine gültige Zeitzone");

    const invalid = fakeLinux();
    const r = await setUpTimer("health-check", { ...invalid.deps, userTimeZone: () => "Mitteleuropa" });
    expect(r.ok).toBe(true);
    expect(invalid.files.get(join(UNITS, "tybo-health-check.timer"))).toContain("OnCalendar=*-*-* 03:30:00\n");
    expect(invalid.lines.join("\n")).toContain("USER_TIMEZONE „Mitteleuropa“ ist keine gültige Zeitzone");
  });

  test("geänderte Zeitzone schreibt den Timer neu", async () => {
    const fk = fakeLinux();
    await setUpTimer("health-check", { ...fk.deps, userTimeZone: () => "UTC" });
    fk.calls.length = 0;
    const r = await setUpTimer("health-check", { ...fk.deps, userTimeZone: () => "Europe/Berlin" });
    expect(r.ok && r.action).toBe("written");
    expect(fk.files.get(join(UNITS, "tybo-health-check.timer"))).toContain("03:30:00 Europe/Berlin");
  });

  test("cron (ohne systemd) bleibt in der Zeitzone des Systems", async () => {
    const fk = fakeLinux({ systemd: false });
    await setUpTimer("health-check", { ...fk.deps, userTimeZone: () => "Europe/Berlin" });
    expect(fk.crontab()!).toHaveLength(1);
    expect(fk.crontab()![0].startsWith("30 3 * * * ")).toBe(true);
    expect(fk.crontab()![0]).not.toContain("Europe/Berlin");
  });

  test("readUserTimeZone liest USER_TIMEZONE aus der .env des Projekts", () => {
    const dir = mkdtempSync(join(tmpdir(), "tybo-tz-"));
    try {
      expect(readUserTimeZone(dir)).toBeUndefined();
      writeFileSync(join(dir, ".env"), "USER_NAME=Alex\nUSER_TIMEZONE=\"Europe/Berlin\"\n");
      expect(readUserTimeZone(dir)).toBe("Europe/Berlin");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("PM2-Zeitplan: genau ein cron-Ausdruck, sonst UnitError", () => {
    expect(pm2CronExpression(HEALTH, SCHEDULE)).toBe("30 3 * * *");
    expect(pm2CronExpression(serviceDefinition("wartung"), SCHEDULE)).toBe("15 3 * * 0");
    expect(() => pm2CronExpression(CHECKIN, SCHEDULE)).toThrow(UnitError);
  });
});
