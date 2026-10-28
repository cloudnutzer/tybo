/**
 * Startzeiten der Einrichtung ohne config/schedule.example.json (Issue #361):
 * neun Check-ins 10:30 bis 18:30 und Briefing 09:00 als Standard, Vorrang
 * von config/schedule.json und dem Block proactive, und was launchd und
 * unter Linux die systemd-Timer bzw. cron daraus machen (Issue #370; die
 * Windows-Aufgabenplanung gibt es nicht mehr).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { basename, join } from "path";
import { plistFile, setUpService, type LaunchdDeps } from "../src/setup/services/launchd";
import { serviceDefinition, type ServiceName } from "../src/lib/services/catalog";
import { cronLines, timerSlots, timerUnit } from "../src/lib/services/systemd";
import { importLegacyProactive, type LegacyPaths } from "../src/lib/proactive/migrate";
import { setupSchedule, type LegacyReading, type SetupScheduleIo } from "../src/lib/proactive/setup-schedule";

const REPO = join(import.meta.dir, "..");
const NINE = [10, 11, 12, 13, 14, 15, 16, 17, 18].map(hour => ({ hour, minute: 30 }));
/*
 * Ersatztermine der bisherigen Einrichtung, wenn schedule.json kein
 * check_in_intervals hatte, abgeschrieben aus cloudnutzer/webui:
 * src/setup/services/launchd.ts (setUpService, smart-checkin) und
 * setup/configure-services.ts (cron unter Linux), jeweils
 * `schedule.check_in_intervals || [...]`.
 */
const OLD_LAUNCHD = [10, 12, 14, 16, 18].map(hour => ({ hour, minute: 30 }));
const OLD_LINUX = [10, 14, 18].map(hour => ({ hour, minute: 30 }));

/** Zeitplan, wie die Linux-Einrichtung ihn liest (src/setup/services/linux.ts: Lesart „zero“) */
function loadSchedule(dir: string) {
  return setupSchedule(dir, { exists: existsSync, readFile: p => readFileSync(p, "utf8"), log: () => {} }, "zero");
}

const linuxMachine = (dir: string) => ({ bun: "/opt/bin/bun", claudeDir: "/opt/bin", home: "/home/test", projectRoot: dir });

/** cron-Zeilen der Ausweichlösung ohne systemd */
function cronEntries(service: ServiceName, schedule: ReturnType<typeof loadSchedule>, dir: string): string[] {
  return cronLines(serviceDefinition(service), linuxMachine(dir), schedule);
}

/** OnCalendar-Zeilen des systemd-Timers als „M H“ wie in cron (ohne Termine kein Timer) */
function timerEntries(service: ServiceName, schedule: ReturnType<typeof loadSchedule>): string[] {
  const def = serviceDefinition(service);
  if (timerSlots(def, schedule).length === 0) return [];
  return timerUnit(def, schedule)
    .split("\n")
    .filter(line => line.startsWith("OnCalendar="))
    .map(line => {
      const [h, m] = line.split(" ")[1].split(":");
      const field = (v: string) => (v === "*" ? "*" : String(Number(v)));
      return `${field(m)} ${field(h)}`;
    });
}

function memoryIo(files: Record<string, string>, root = "/projekt"): SetupScheduleIo & { lines: string[] } {
  const map = new Map(Object.entries(files).map(([k, v]) => [join(root, k), v]));
  const lines: string[] = [];
  return {
    lines,
    exists: path => map.has(path),
    readFile: path => {
      const content = map.get(path);
      if (content === undefined) throw new Error(`ENOENT ${path}`);
      return content;
    },
    log: line => void lines.push(line),
  };
}

test("die Vorlage config/schedule.example.json gibt es nicht mehr", () => {
  expect(existsSync(join(REPO, "config", "schedule.example.json"))).toBe(false);
});

describe("setupSchedule", () => {
  test("ohne Dateien: neun Check-ins 10:30 bis 18:30, Briefing 09:00", () => {
    expect(setupSchedule("/projekt", memoryIo({}), "wildcard")).toEqual({
      morning_briefing: { hour: 9, minute: 0, enabled: true },
      check_in_intervals: NINE,
    });
  });

  test("Block proactive in config/settings.json gilt", () => {
    const io = memoryIo({
      "config/settings.json": JSON.stringify({ proactive: { briefing: { enabled: false, window: { from: "07:15", to: "10:00" } }, checkin: { times: ["09:00", "13:45"] } } }),
    });
    expect(setupSchedule("/projekt", io, "zero")).toEqual({
      morning_briefing: { hour: 7, minute: 15, enabled: false },
      check_in_intervals: [{ hour: 9, minute: 0 }, { hour: 13, minute: 45 }],
    });
  });

  test("config/schedule.json einer bestehenden Installation hat Vorrang, Feld für Feld", () => {
    const io = memoryIo({
      "config/settings.json": JSON.stringify({ proactive: { briefing: { window: { from: "07:00", to: "10:00" } } } }),
      "config/schedule.json": JSON.stringify({ check_in_intervals: [{ hour: 11 }, { hour: 15, minute: 5 }] }),
    });
    // Linux (früher cron und Windows): fehlende Minute 0
    expect(setupSchedule("/projekt", io, "zero")).toEqual({
      morning_briefing: { hour: 7, minute: 0, enabled: true },
      check_in_intervals: [{ hour: 11, minute: 0 }, { hour: 15, minute: 5 }],
    });
    // launchd: fehlende Minute jeder Wert, als feste Termine
    const launchd = setupSchedule("/projekt", io, "wildcard").check_in_intervals;
    expect(launchd).toHaveLength(61);
    expect(launchd.at(0)).toEqual({ hour: 11, minute: 0 });
    expect(launchd.at(-1)).toEqual({ hour: 15, minute: 5 });
    // Ohne check_in_intervals: die bisherigen Ersatztermine der Plattform, nicht die neun Standardtermine
    const briefingOnly = memoryIo({ "config/schedule.json": JSON.stringify({ morning_briefing: { hour: 8, minute: 30, enabled: true } }) });
    expect(setupSchedule("/projekt", briefingOnly, "zero")).toEqual({
      morning_briefing: { hour: 8, minute: 30, enabled: true },
      check_in_intervals: OLD_LINUX,
    });
    expect(setupSchedule("/projekt", briefingOnly, "wildcard").check_in_intervals).toEqual(OLD_LAUNCHD);
  });

  test("fehlendes check_in_intervals: ausdrücklich gesetzte checkin.times gehen vor", () => {
    const io = memoryIo({
      "config/settings.json": JSON.stringify({ proactive: { checkin: { times: ["09:15"] } } }),
      "config/schedule.json": JSON.stringify({ morning_briefing: { hour: 8, minute: 0, enabled: true } }),
    });
    expect(setupSchedule("/projekt", io, "zero").check_in_intervals).toEqual([{ hour: 9, minute: 15 }]);
    expect(setupSchedule("/projekt", io, "wildcard").check_in_intervals).toEqual([{ hour: 9, minute: 15 }]);
  });

  test("ausdrücklich leere check_in_intervals bleiben leer", () => {
    const io = memoryIo({ "config/schedule.json": JSON.stringify({ check_in_intervals: [], morning_briefing: { hour: 8, minute: 0, enabled: true } }) });
    expect(setupSchedule("/projekt", io, "zero")).toEqual({ morning_briefing: { hour: 8, minute: 0, enabled: true }, check_in_intervals: [] });
    expect(setupSchedule("/projekt", io, "wildcard").check_in_intervals).toEqual([]);
    // Nur lauter ungültige Einträge fallen auf den Standard zurück
    const invalid = memoryIo({ "config/schedule.json": JSON.stringify({ check_in_intervals: [{ hour: "zehn" }] }) });
    expect(setupSchedule("/projekt", invalid, "zero").check_in_intervals).toEqual(NINE);
  });

  test("fehlende Stunde oder Minute in schedule.json: Lesart der Plattform, immer feste Termine", () => {
    const io = memoryIo({ "config/schedule.json": JSON.stringify({ check_in_intervals: [{ minute: 30 }, { hour: 10 }] }) });
    // cron und Windows lasen ein fehlendes Feld schon immer als 0, die Timer übernehmen das
    expect(setupSchedule("/projekt", io, "zero").check_in_intervals).toEqual([{ hour: 0, minute: 30 }, { hour: 10, minute: 0 }]);
    // launchd: jeder Wert, 24 + 60 Startzeiten, 10:30 nur einmal
    const launchd = setupSchedule("/projekt", io, "wildcard").check_in_intervals;
    expect(launchd).toHaveLength(83);
    expect(launchd.every(s => Number.isInteger(s.hour) && Number.isInteger(s.minute))).toBe(true);
  });

  test("checkin.times: [] in den Einstellungen: keine Check-in-Termine", () => {
    const io = memoryIo({ "config/settings.json": JSON.stringify({ proactive: { checkin: { times: [] } } }) });
    expect(setupSchedule("/projekt", io, "wildcard").check_in_intervals).toEqual([]);
    expect(io.lines).toEqual([]);
  });

  test("kaputte oder ungültige Dateien: Standard, Hinweis im Log", () => {
    const io = memoryIo({ "config/schedule.json": "{kaputt", "config/settings.json": JSON.stringify({ proactive: { checkin: { times: ["25:00"] } } }) });
    expect(setupSchedule("/projekt", io, "zero").check_in_intervals).toEqual(NINE);
    expect(io.lines.join("\n")).toContain("config/schedule.json nicht lesbar");
    expect(io.lines.join("\n")).toContain("config/settings.json ungültig");
  });
});

describe("Einrichtung der Dienste", () => {
  const ROOT = "/projekt";
  const AGENTS = "/home/test/Library/LaunchAgents";

  function fakeMac(extra: Record<string, string> = {}) {
    const files = new Map<string, string>();
    for (const [k, v] of Object.entries(extra)) files.set(join(ROOT, k), v);
    const loaded = new Set<string>();
    const ok = (stdout = "") => ({ ok: true, stdout, stderr: "" });
    const deps: LaunchdDeps = {
      projectRoot: ROOT,
      launchAgentsDir: AGENTS,
      home: "/home/test",
      async run(cmd) {
        if (cmd[0] === "which") return ok(`/opt/bin/${cmd[1]}`);
        if (cmd[1] === "list") return ok([...loaded].map(l => `-\t0\t${l}`).join("\n"));
        if (cmd[1] === "load") loaded.add(basename(cmd[2], ".plist"));
        return ok();
      },
      exists: path => files.has(path) || path === AGENTS,
      readFile: path => {
        const content = files.get(path);
        if (content === undefined) throw new Error(`ENOENT ${path}`);
        return content;
      },
      writeFile: (path, content) => void files.set(path, content),
      mkdir: () => {},
      log: () => {},
    };
    return { deps, files };
  }

  function calendarIntervals(plist: string): { hour: number; minute: number }[] {
    return [...plist.matchAll(/<key>Hour<\/key>\s*<integer>(\d+)<\/integer>\s*<key>Minute<\/key>\s*<integer>(\d+)<\/integer>/g)].map(m => ({
      hour: Number(m[1]),
      minute: Number(m[2]),
    }));
  }

  test("launchd: neun Check-in-Termine und Briefing um 09:00 ohne Vorlage", async () => {
    const mac = fakeMac();
    expect((await setUpService("smart-checkin", mac.deps)).ok).toBe(true);
    expect(calendarIntervals(mac.files.get(plistFile("smart-checkin", AGENTS))!)).toEqual(NINE);
    expect((await setUpService("morning-briefing", mac.deps)).ok).toBe(true);
    expect(calendarIntervals(mac.files.get(plistFile("morning-briefing", AGENTS))!)).toEqual([{ hour: 9, minute: 0 }]);
  });

  test("launchd: bestehende config/schedule.json bleibt maßgeblich", async () => {
    const mac = fakeMac({ "config/schedule.json": JSON.stringify({ check_in_intervals: [{ hour: 12, minute: 0 }] }) });
    expect((await setUpService("smart-checkin", mac.deps)).ok).toBe(true);
    expect(calendarIntervals(mac.files.get(plistFile("smart-checkin", AGENTS))!)).toEqual([{ hour: 12, minute: 0 }]);
  });

  test("launchd: leere check_in_intervals ergeben keinen Check-in-Termin", async () => {
    const mac = fakeMac({ "config/schedule.json": JSON.stringify({ check_in_intervals: [] }) });
    expect((await setUpService("smart-checkin", mac.deps)).ok).toBe(true);
    const plist = mac.files.get(plistFile("smart-checkin", AGENTS))!;
    expect(calendarIntervals(plist)).toEqual([]);
    expect(plist).not.toContain("<key>Hour</key>");
  });

  test("launchd: {minute:30} und {hour:10} bleiben Platzhalter, nichts wird mit 0 ersetzt", async () => {
    const mac = fakeMac({ "config/schedule.json": JSON.stringify({ check_in_intervals: [{ minute: 30 }, { hour: 10 }] }) });
    expect((await setUpService("smart-checkin", mac.deps)).ok).toBe(true);
    const plist = mac.files.get(plistFile("smart-checkin", AGENTS))!;
    const dicts = [...plist.matchAll(/<dict>\s*((?:<key>(?:Hour|Minute)<\/key>\s*<integer>\d+<\/integer>\s*)+)<\/dict>/g)].map(m =>
      Object.fromEntries([...m[1].matchAll(/<key>(\w+)<\/key>\s*<integer>(\d+)<\/integer>/g)].map(f => [f[1], Number(f[2])])),
    );
    expect(dicts).toEqual([{ Minute: 30 }, { Hour: 10 }]);
    expect(plist).not.toContain("<integer>0</integer>");
  });

  test("launchd: checkin.times: [] aus den Einstellungen ergibt keinen Check-in-Termin", async () => {
    const mac = fakeMac({ "config/settings.json": JSON.stringify({ proactive: { checkin: { times: [] } } }) });
    expect((await setUpService("smart-checkin", mac.deps)).ok).toBe(true);
    expect(mac.files.get(plistFile("smart-checkin", AGENTS))!).not.toContain("<key>Minute</key>");
  });

  /*
   * Startzeiten auf allen drei Plattformen, aus den tatsächlich erzeugten
   * Zeitplänen zurückgelesen (Plist, cron-Zeilen, Uhrzeiten der
   * Aufgabenplanung). Die Auswertung hier ist unabhängig vom Code unter src/:
   * launchd liest ein fehlendes Feld als jeden Wert, cron einen Stern.
   */
  const pad = (n: number) => String(n).padStart(2, "0");
  const clock = (t: number) => `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
  const sorted = (times: Iterable<string>) => [...new Set(times)].sort();

  function launchdTimes(plist: string): string[] {
    const array = plist.match(/<key>StartCalendarInterval<\/key>\s*<array>([\s\S]*?)<\/array>/)?.[1] ?? "";
    return sorted(
      [...array.matchAll(/<dict>([\s\S]*?)<\/dict>/g)].flatMap(d => {
        const field = (key: string) => d[1].match(new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`))?.[1];
        const h = field("Hour");
        const m = field("Minute");
        const hours = h === undefined ? Array.from({ length: 24 }, (_, i) => i) : [Number(h)];
        const minutes = m === undefined ? Array.from({ length: 60 }, (_, i) => i) : [Number(m)];
        return hours.flatMap(hh => minutes.map(mm => clock(hh * 60 + mm)));
      }),
    );
  }

  /** Werte eines cron-Felds: *, Einzelwerte und Bereiche a-b, durch Kommas getrennt */
  function cronValues(field: string, size: number): number[] {
    if (field === "*") return Array.from({ length: size }, (_, i) => i);
    return field.split(",").flatMap(part => {
      const [a, b = a] = part.split("-").map(Number);
      return Array.from({ length: b - a + 1 }, (_, i) => a + i);
    });
  }

  /** Startzeiten aus „M H …“-Zeilen; ein Zeitpunkt aus zwei Zeilen steht zweimal da (cron startet zweimal) */
  function cronTimes(lines: string[]): string[] {
    return lines
      .flatMap(line => {
        const [m, h] = line.split(" ");
        return cronValues(h, 24).flatMap(hh => cronValues(m, 60).map(mm => clock(hh * 60 + mm)));
      })
      .sort();
  }

  describe("Startzeiten bleiben auf allen Plattformen erhalten", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "tybo-setup-times-"));
      mkdirSync(join(dir, "config"));
      mkdirSync(join(dir, "data"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    const file = (rel: string) => join(dir, rel);
    const paths = (): LegacyPaths => ({
      schedule: file("config/schedule.json"),
      checkinState: file("checkin-state.json"),
      settings: file("config/settings.json"),
      state: file("data/proactive-state.json"),
    });

    /** Was launchd, cron und die Aufgabenplanung aus dem Projektordner erzeugen */
    async function platforms() {
      const extra: Record<string, string> = {};
      for (const rel of ["config/settings.json", "config/schedule.json"]) {
        if (existsSync(file(rel))) extra[rel] = readFileSync(file(rel), "utf8");
      }
      const mac = fakeMac(extra);
      expect((await setUpService("smart-checkin", mac.deps)).ok).toBe(true);
      const schedule = loadSchedule(dir);
      return {
        launchd: launchdTimes(mac.files.get(plistFile("smart-checkin", AGENTS))!),
        cron: cronTimes(cronEntries("smart-checkin", schedule, dir)),
        systemd: sorted(cronTimes(timerEntries("smart-checkin", schedule))),
      };
    }

    const everyHourAt30 = Array.from({ length: 24 }, (_, h) => `${pad(h)}:30`);
    const everyMinuteOf10 = Array.from({ length: 60 }, (_, m) => `10:${pad(m)}`);

    for (const [name, times] of [
      ["24 Stundenzeiten", everyHourAt30],
      ["60 Minutenzeiten einer Stunde", everyMinuteOf10],
      ["24 und 60 gemischt mit einem festen Termin", sorted([...everyHourAt30, ...everyMinuteOf10, "15:05"])],
    ] as const) {
      test(`${name} in checkin.times`, async () => {
        writeFileSync(file("config/settings.json"), JSON.stringify({ proactive: { checkin: { times } } }));
        const expected = sorted(times);
        expect(await platforms()).toEqual({ launchd: expected, cron: expected, systemd: expected });
      });
    }

    type Platform = "launchd" | "cron" | "systemd";
    const PLATFORMS: [Platform, LegacyReading][] = [["launchd", "wildcard"], ["cron", "zero"], ["systemd", "zero"]];

    /** Startzeiten von Check-in und Briefing, die eine Plattform aus dem Projektordner tatsächlich erzeugt */
    async function platformTimes(platform: Platform): Promise<{ checkin: string[]; briefing: string[] }> {
      if (platform === "launchd") {
        const extra: Record<string, string> = {};
        for (const rel of ["config/settings.json", "config/schedule.json"]) {
          if (existsSync(file(rel))) extra[rel] = readFileSync(file(rel), "utf8");
        }
        const mac = fakeMac(extra);
        expect((await setUpService("smart-checkin", mac.deps)).ok).toBe(true);
        expect((await setUpService("morning-briefing", mac.deps)).ok).toBe(true);
        const briefing = mac.files.get(plistFile("morning-briefing", AGENTS))!;
        const field = (key: string) => Number(briefing.match(new RegExp(`<key>${key}</key>\\s*<integer>(\\d+)</integer>`))![1]);
        return {
          checkin: launchdTimes(mac.files.get(plistFile("smart-checkin", AGENTS))!),
          briefing: [clock(field("Hour") * 60 + field("Minute"))],
        };
      }
      const schedule = loadSchedule(dir);
      if (platform === "cron") {
        return {
          checkin: cronTimes(cronEntries("smart-checkin", schedule, dir)),
          briefing: cronTimes(cronEntries("morning-briefing", schedule, dir)),
        };
      }
      return { checkin: sorted(cronTimes(timerEntries("smart-checkin", schedule))), briefing: sorted(cronTimes(timerEntries("morning-briefing", schedule))) };
    }

    /*
     * Die Übernahme darf auf keiner Plattform eine Startzeit hinzufügen oder
     * wegnehmen: Was die Einrichtung mit der alten schedule.json erzeugt hat,
     * erzeugt sie nach Übernahme und Wiederholung auch ohne sie. Die
     * Übernahme läuft dabei in der Lesart der jeweiligen Plattform (wie auf
     * einem Rechner mit diesem System).
     */
    const LEGACY_CASES: [string, unknown][] = [
      ["Platzhalter {minute:30}", { check_in_intervals: [{ minute: 30 }] }],
      ["Platzhalter {hour:10}", { check_in_intervals: [{ hour: 10 }] }],
      ["leerer Eintrag {}", { check_in_intervals: [{}] }],
      ["Platzhalter gemischt mit festem Termin", { check_in_intervals: [{ minute: 30 }, { hour: 10 }, { hour: 15, minute: 5 }] }],
      ["doppelte Startzeit", { check_in_intervals: [{ hour: 10 }, { hour: 10, minute: 0 }] }],
      ["ungültige neben gültigen Einträgen", { check_in_intervals: [{ hour: 25 }, { minute: 75 }, { hour: 9, minute: 15 }] }],
      ["lauter ungültige Einträge", { check_in_intervals: [{ hour: "x" }] }],
      ["leere Liste", { check_in_intervals: [] }],
      ["24 ausdrücklich angegebene Stundenzeiten", { check_in_intervals: everyHourAt30.map(t => ({ hour: Number(t.slice(0, 2)), minute: 30 })) }],
      ["60 ausdrücklich angegebene Minutenzeiten", { check_in_intervals: everyMinuteOf10.map(t => ({ hour: 10, minute: Number(t.slice(3)) })) }],
      ["Briefing ohne Minute", { morning_briefing: { hour: 8, enabled: true } }],
      ["Briefing mit Minute", { morning_briefing: { hour: 7, minute: 45, enabled: true } }],
      ["Briefing mit ungültiger Minute", { morning_briefing: { hour: 8, minute: "x", enabled: true } }],
      ["Briefing mit ungültiger Stunde", { morning_briefing: { hour: 30, minute: 0, enabled: true } }],
    ];

    for (const [name, legacy] of LEGACY_CASES) {
      for (const [platform, reading] of PLATFORMS) {
        test(`schedule.json mit ${name} unter ${platform}: dieselben Startzeiten vor und nach der Übernahme`, async () => {
          writeFileSync(file("config/schedule.json"), JSON.stringify(legacy));
          const before = await platformTimes(platform);

          expect((await importLegacyProactive(paths(), new Date(), {}, reading)).schedule).toBe("imported");
          const settings = existsSync(file("config/settings.json")) ? readFileSync(file("config/settings.json"), "utf8") : null;
          expect((await importLegacyProactive(paths(), new Date(), {}, reading)).schedule).toBe("done-before");
          expect(existsSync(file("config/settings.json")) ? readFileSync(file("config/settings.json"), "utf8") : null).toBe(settings);

          rmSync(file("config/schedule.json"));
          expect(await platformTimes(platform)).toEqual(before);
        });
      }
    }

    test("Platzhalter vor der Übernahme: launchd jeder Wert, unter Linux 0, wie bisher", async () => {
      writeFileSync(file("config/schedule.json"), JSON.stringify({ check_in_intervals: [{ minute: 30 }, { hour: 10 }] }));
      expect((await platformTimes("launchd")).checkin).toEqual(sorted([...everyHourAt30, ...everyMinuteOf10]));
      expect((await platformTimes("cron")).checkin).toEqual(["00:30", "10:00"]);
      expect((await platformTimes("systemd")).checkin).toEqual(["00:30", "10:00"]);
    });

    /*
     * Bestehende schedule.json ohne check_in_intervals (Befund Runde 7):
     * Feste Sollwerte der bisherigen Einrichtung statt Vergleich vorher und
     * nachher, für Einrichtung, Übernahme, Wiederholung und Entfernen der
     * Altdatei.
     */
    const clocks = (slots: { hour: number; minute: number }[]) => slots.map(t => clock(t.hour * 60 + t.minute));
    const OLD_TIMES: Record<Platform, string[]> = {
      launchd: clocks(OLD_LAUNCHD),
      cron: clocks(OLD_LINUX),
      systemd: clocks(OLD_LINUX),
    };
    const MISSING_CASES: [string, unknown][] = [
      ["nur morning_briefing 08:00", { morning_briefing: { hour: 8, minute: 0, enabled: true } }],
      ["check_in_intervals: null", { check_in_intervals: null, morning_briefing: { hour: 8, minute: 0, enabled: true } }],
    ];
    for (const [name, legacy] of MISSING_CASES) {
      for (const [platform, reading] of PLATFORMS) {
        test(`schedule.json mit ${name} unter ${platform}: bisherige Check-in-Termine in jedem Schritt`, async () => {
          writeFileSync(file("config/schedule.json"), JSON.stringify(legacy));
          const want = { checkin: OLD_TIMES[platform], briefing: ["08:00"] };
          expect(await platformTimes(platform)).toEqual(want);

          expect((await importLegacyProactive(paths(), new Date(), {}, reading)).schedule).toBe("imported");
          const settings = readFileSync(file("config/settings.json"), "utf8");
          expect(JSON.parse(settings).proactive.checkin.times).toEqual(OLD_TIMES[platform]);
          expect(await platformTimes(platform)).toEqual(want);

          expect((await importLegacyProactive(paths(), new Date(), {}, reading)).schedule).toBe("done-before");
          expect(readFileSync(file("config/settings.json"), "utf8")).toBe(settings);
          expect(await platformTimes(platform)).toEqual(want);

          rmSync(file("config/schedule.json"));
          expect(await platformTimes(platform)).toEqual(want);
        });
      }
    }

    test("fehlendes check_in_intervals mit gesetzten checkin.times: diese Termine in jedem Schritt", async () => {
      for (const [platform, reading] of PLATFORMS) {
        rmSync(file("data/proactive-state.json"), { force: true });
        writeFileSync(file("config/settings.json"), JSON.stringify({ proactive: { checkin: { times: ["09:15", "17:00"] } } }));
        writeFileSync(file("config/schedule.json"), JSON.stringify({ morning_briefing: { hour: 8, minute: 0, enabled: true } }));
        expect((await platformTimes(platform)).checkin).toEqual(["09:15", "17:00"]);
        expect((await importLegacyProactive(paths(), new Date(), {}, reading)).schedule).toBe("imported");
        expect(JSON.parse(readFileSync(file("config/settings.json"), "utf8")).proactive.checkin.times).toEqual(["09:15", "17:00"]);
        expect((await importLegacyProactive(paths(), new Date(), {}, reading)).schedule).toBe("done-before");
        rmSync(file("config/schedule.json"));
        expect((await platformTimes(platform)).checkin).toEqual(["09:15", "17:00"]);
      }
    });

    test("Neuinstallation bleibt getrennt: ohne schedule.json neun Termine, mit leerer Liste keiner", async () => {
      for (const platform of ["launchd", "cron", "systemd"] as const) {
        rmSync(file("config/schedule.json"), { force: true });
        expect((await platformTimes(platform)).checkin).toEqual(clocks(NINE));
        writeFileSync(file("config/schedule.json"), JSON.stringify({ check_in_intervals: [] }));
        expect((await platformTimes(platform)).checkin).toEqual([]);
      }
    });

    test("ohne Dateien: die neun Standardtermine überall", async () => {
      const nine = NINE.map(t => `${pad(t.hour)}:${pad(t.minute)}`);
      expect(await platforms()).toEqual({ launchd: nine, cron: nine, systemd: nine });
    });
  });

  describe("Linux: systemd-Timer und cron (src/lib/services/systemd.ts)", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "tybo-setup-schedule-"));
      mkdirSync(join(dir, "config"));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    test("ohne Dateien: neun Check-in-Termine, Briefing 09:00", () => {
      expect(loadSchedule(dir)).toEqual({ morning_briefing: { hour: 9, minute: 0, enabled: true }, check_in_intervals: NINE });
    });

    test("leere check_in_intervals in schedule.json: kein Check-in-Termin, weder Timer noch cron", () => {
      writeFileSync(join(dir, "config", "schedule.json"), JSON.stringify({ check_in_intervals: [] }));
      const schedule = loadSchedule(dir);
      expect(schedule.check_in_intervals).toEqual([]);
      expect(cronEntries("smart-checkin", schedule, dir)).toEqual([]);
      expect(timerEntries("smart-checkin", schedule)).toEqual([]);
      // Das Briefing bleibt eingerichtet
      expect(cronEntries("morning-briefing", schedule, dir)).toHaveLength(1);
      expect(timerEntries("morning-briefing", schedule)).toEqual(["0 9"]);
    });

    test("Issue #363: das Briefing ruft die Routine src/routines/briefing.ts über den Wrapper", () => {
      const [line] = cronEntries("morning-briefing", loadSchedule(dir), dir);
      expect(line.startsWith(`0 9 * * * cd ${dir} && `)).toBe(true);
      expect(line).toContain("--id ai.tybo.morning-briefing -- /opt/bin/bun run src/routines/briefing.ts");
      expect(line.endsWith("# tybo-morning-briefing")).toBe(true);
    });

    test("Issue #364: der Check-in ruft die Routine src/routines/checkin.ts über den Wrapper", () => {
      const [line] = cronEntries("smart-checkin", loadSchedule(dir), dir);
      expect(line.startsWith(`30 10 * * * cd ${dir} && `)).toBe(true);
      expect(line).toContain("--id ai.tybo.smart-checkin -- /opt/bin/bun run src/routines/checkin.ts");
    });

    test("ohne schedule.json: neun Check-in-Termine in cron und im Timer", () => {
      const schedule = loadSchedule(dir);
      const lines = cronEntries("smart-checkin", schedule, dir);
      expect(lines.map(l => l.split(" ").slice(0, 2).join(" "))).toEqual(NINE.map(t => `${t.minute} ${t.hour}`));
      expect(lines.every(l => l.endsWith("# tybo-smart-checkin"))).toBe(true);
      expect(timerEntries("smart-checkin", schedule)).toEqual(NINE.map(t => `${t.minute} ${t.hour}`));
    });

    test("Block proactive aus config/settings.json", () => {
      writeFileSync(join(dir, "config", "settings.json"), JSON.stringify({ proactive: { checkin: { times: ["10:00"] } } }));
      expect(loadSchedule(dir).check_in_intervals).toEqual([{ hour: 10, minute: 0 }]);
    });
  });
});
