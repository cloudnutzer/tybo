/**
 * Zustand und Übernahme der proaktiven Meldungen (Issue #361): Sperre,
 * Reservierung, Snooze, Neustart, gleichzeitige Zugriffe, einmalige
 * Übernahme von config/schedule.json und checkin-state.json.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { proactiveConfig } from "../src/lib/proactive/config";
import { importLegacyProactive, scheduleToProactive, type LegacyPaths } from "../src/lib/proactive/migrate";
import { judgeKind } from "../src/lib/proactive/rules";
import { compactForLaunchd, legacyBriefingStart, legacyCheckinMinutes, legacyReadingFor, legacyStartMinutes, setupSchedule, type SetupScheduleIo } from "../src/lib/proactive/setup-schedule";
import { settingsSchema } from "../src/lib/settings";
import {
  CLAIM_MAX_MS,
  ProactiveStateBrokenError,
  confirmSend,
  finishSend,
  renewClaim,
  readProactiveState,
  reserveSend,
  snoozeKind,
  updateProactiveState,
} from "../src/lib/proactive/state";

let dir: string;
let paths: LegacyPaths;
let log: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-proactive-"));
  mkdirSync(join(dir, "config"));
  paths = {
    schedule: join(dir, "config", "schedule.json"),
    checkinState: join(dir, "checkin-state.json"),
    settings: join(dir, "config", "settings.json"),
    state: join(dir, "data", "proactive-state.json"),
  };
  log = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  log.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

const config = proactiveConfig({});
const judgeCheckin = (now: Date) => (record: any) =>
  judgeKind({ now, zone: "UTC", quietHours: config.quietHours, kind: config.checkin, record });

describe("Zustand", () => {
  test("fehlende Datei: leerer Zustand, Schreiben legt sie an", async () => {
    expect(await readProactiveState(paths.state)).toEqual({ briefing: {}, checkin: { pendingItems: [] }, imported: {} });
    await snoozeKind(paths.state, "checkin", new Date("2026-10-19T12:30:00Z"));
    expect(existsSync(paths.state)).toBe(true);
    expect(existsSync(`${paths.state}.lock`)).toBe(false);
  });

  test("kaputte Datei wird nie überschrieben", async () => {
    mkdirSync(join(dir, "data"));
    writeFileSync(paths.state, "{kaputt");
    await expect(snoozeKind(paths.state, "checkin", new Date())).rejects.toBeInstanceOf(ProactiveStateBrokenError);
    expect(readFileSync(paths.state, "utf-8")).toBe("{kaputt");
  });

  test("Reservierung, Zustellung, dann gilt der Mindestabstand", async () => {
    const t0 = new Date("2026-10-19T12:00:00Z");
    const r = await reserveSend(paths.state, "checkin", t0, judgeCheckin(t0));
    expect(r.ok).toBe(true);
    await finishSend(paths.state, "checkin", (r as any).token, true, t0, "UTC");
    const state = await readProactiveState(paths.state);
    expect(state.checkin.lastSentAt).toBe(t0.toISOString());
    expect(state.checkin.lastDate).toBe("2026-10-19");
    expect(state.checkin.claim).toBeUndefined();

    const t1 = new Date("2026-10-19T13:00:00Z");
    expect(await reserveSend(paths.state, "checkin", t1, judgeCheckin(t1))).toEqual({ ok: false, reason: "gap" });
  });

  test("gescheiterte Zustellung setzt weder Versandzeit noch Tagesmarke", async () => {
    const t0 = new Date("2026-10-19T12:00:00Z");
    const r = await reserveSend(paths.state, "checkin", t0, judgeCheckin(t0));
    await finishSend(paths.state, "checkin", (r as any).token, false, t0, "UTC");
    const state = await readProactiveState(paths.state);
    expect(state.checkin.lastSentAt).toBeUndefined();
    expect(state.checkin.lastDate).toBeUndefined();
    expect(state.checkin.claim).toBeUndefined();
    // Der nächste Lauf darf gleich wieder
    expect((await reserveSend(paths.state, "checkin", t0, judgeCheckin(t0))).ok).toBe(true);
  });

  test("lebende Reservierung: zweiter Lauf ist busy, liegen gebliebene wird übernommen", async () => {
    const t0 = new Date("2026-10-19T12:00:00Z");
    expect((await reserveSend(paths.state, "checkin", t0, judgeCheckin(t0))).ok).toBe(true);
    expect(await reserveSend(paths.state, "checkin", t0, judgeCheckin(t0))).toEqual({ ok: false, reason: "busy" });
    // Prozess tot
    expect((await reserveSend(paths.state, "checkin", t0, judgeCheckin(t0), () => false)).ok).toBe(true);
    // Prozess lebt, hat aber seit CLAIM_MAX_MS nicht erneuert (hängt)
    const late = new Date(t0.getTime() + CLAIM_MAX_MS);
    expect((await reserveSend(paths.state, "checkin", late, judgeCheckin(late))).ok).toBe(true);
  });

  test("erneuerte Reservierung verfällt nicht durch Zeitablauf", async () => {
    const t0 = new Date("2026-10-19T12:00:00Z");
    const r = (await reserveSend(paths.state, "checkin", t0, judgeCheckin(t0))) as { ok: true; token: string };
    for (let minute = 5; minute <= 30; minute += 5) {
      const at = new Date(t0.getTime() + minute * 60_000);
      expect(await renewClaim(paths.state, "checkin", r.token, at)).toBe(true);
      expect(await reserveSend(paths.state, "checkin", at, judgeCheckin(at))).toEqual({ ok: false, reason: "busy" });
    }
  });

  test("bestätigte Reservierung (Versand läuft) verfällt nur mit dem Prozess", async () => {
    const t0 = new Date("2026-10-19T12:00:00Z");
    const r = (await reserveSend(paths.state, "checkin", t0, judgeCheckin(t0))) as { ok: true; token: string };
    expect(await confirmSend(paths.state, "checkin", r.token, t0, judgeCheckin(t0))).toEqual({ ok: true });
    const muchLater = new Date(t0.getTime() + 10 * CLAIM_MAX_MS);
    expect(await reserveSend(paths.state, "checkin", muchLater, judgeCheckin(muchLater))).toEqual({ ok: false, reason: "busy" });
    expect((await reserveSend(paths.state, "checkin", muchLater, judgeCheckin(muchLater), () => false)).ok).toBe(true);
  });

  test("übernommene Reservierung: Bestätigen und Erneuern scheitern, finishSend lässt die fremde stehen", async () => {
    const t0 = new Date("2026-10-19T12:00:00Z");
    const a = (await reserveSend(paths.state, "checkin", t0, judgeCheckin(t0))) as { ok: true; token: string };
    const late = new Date(t0.getTime() + CLAIM_MAX_MS + 60_000);
    const b = (await reserveSend(paths.state, "checkin", late, judgeCheckin(late))) as { ok: true; token: string };
    expect(b.ok).toBe(true);
    expect(await renewClaim(paths.state, "checkin", a.token, late)).toBe(false);
    expect(await confirmSend(paths.state, "checkin", a.token, late, judgeCheckin(late))).toEqual({ ok: false, reason: "overtaken" });
    expect(await finishSend(paths.state, "checkin", a.token, false, late, "UTC")).toBe(false);
    expect((await readProactiveState(paths.state)).checkin.claim?.token).toBe(b.token);
    expect(await confirmSend(paths.state, "checkin", b.token, late, judgeCheckin(late))).toEqual({ ok: true });
  });

  test("Bestätigen prüft die Regeln frisch: Snooze oder Fensterende verhindern den Versand", async () => {
    const t0 = new Date("2026-10-19T12:00:00Z");
    const r = (await reserveSend(paths.state, "checkin", t0, judgeCheckin(t0))) as { ok: true; token: string };
    // Snooze kam nach der Reservierung
    await snoozeKind(paths.state, "checkin", new Date("2026-10-19T13:00:00Z"));
    expect(await confirmSend(paths.state, "checkin", r.token, t0, judgeCheckin(t0))).toEqual({ ok: false, reason: "snoozed" });
    let state = await readProactiveState(paths.state);
    expect(state.checkin.claim).toBeUndefined();
    expect(state.checkin.lastSentAt).toBeUndefined();

    // Reservierung um 18:50, Bestätigen erst nach dem Fensterende 19:00
    const late = new Date("2026-10-19T18:50:00Z");
    const r2 = (await reserveSend(paths.state, "checkin", late, judgeCheckin(late))) as { ok: true; token: string };
    expect(r2.ok).toBe(true);
    const after = new Date("2026-10-19T19:01:00Z");
    expect(await confirmSend(paths.state, "checkin", r2.token, after, judgeCheckin(after))).toEqual({ ok: false, reason: "window" });
    state = await readProactiveState(paths.state);
    expect(state.checkin.claim).toBeUndefined();
    expect(state.checkin.lastSentAt).toBeUndefined();
  });

  test("finishSend dreht einen späteren Versand nicht zurück", async () => {
    const t0 = new Date("2026-10-19T12:00:00Z");
    const later = new Date("2026-10-19T12:20:00Z");
    await updateProactiveState(paths.state, s => { s.checkin.lastSentAt = later.toISOString(); s.checkin.lastDate = "2026-10-19"; });
    expect(await finishSend(paths.state, "checkin", "fremd", true, t0, "UTC")).toBe(false);
    expect((await readProactiveState(paths.state)).checkin.lastSentAt).toBe(later.toISOString());
  });

  test("gleichzeitige Läufe: genau eine Reservierung", async () => {
    const t0 = new Date("2026-10-19T12:00:00Z");
    const results = await Promise.all(Array.from({ length: 8 }, () => reserveSend(paths.state, "checkin", t0, judgeCheckin(t0))));
    expect(results.filter(r => r.ok)).toHaveLength(1);
    expect(results.filter(r => !r.ok && r.reason === "busy")).toHaveLength(7);
  });

  test("Snooze während eines Versands bleibt stehen", async () => {
    const t0 = new Date("2026-10-19T12:00:00Z");
    const r = await reserveSend(paths.state, "checkin", t0, judgeCheckin(t0));
    await snoozeKind(paths.state, "checkin", new Date("2026-10-19T12:30:00Z"));
    await finishSend(paths.state, "checkin", (r as any).token, true, t0, "UTC");
    expect((await readProactiveState(paths.state)).checkin.snoozedUntil).toBe("2026-10-19T12:30:00.000Z");
  });

  test("Snooze verkürzt nie und trifft nur seine Art", async () => {
    await snoozeKind(paths.state, "checkin", new Date("2026-10-19T13:00:00Z"));
    await snoozeKind(paths.state, "checkin", new Date("2026-10-19T12:30:00Z"));
    const state = await readProactiveState(paths.state);
    expect(state.checkin.snoozedUntil).toBe("2026-10-19T13:00:00.000Z");
    expect(state.briefing.snoozedUntil).toBeUndefined();
  });

  test("gleichzeitige Änderungen gehen nicht verloren", async () => {
    await Promise.all([
      snoozeKind(paths.state, "checkin", new Date("2026-10-19T13:00:00Z")),
      snoozeKind(paths.state, "briefing", new Date("2026-10-19T10:00:00Z")),
      updateProactiveState(paths.state, s => { s.checkin.pendingItems.push("A"); }),
      updateProactiveState(paths.state, s => { s.checkin.pendingItems.push("B"); }),
    ]);
    const state = await readProactiveState(paths.state);
    expect(state.checkin.snoozedUntil).toBe("2026-10-19T13:00:00.000Z");
    expect(state.briefing.snoozedUntil).toBe("2026-10-19T10:00:00.000Z");
    expect(state.checkin.pendingItems.sort()).toEqual(["A", "B"]);
  });

  test("Neustart: ein frischer Prozess sieht Snooze und Versandzeit", async () => {
    await snoozeKind(paths.state, "checkin", new Date("2026-10-19T13:00:00Z"));
    const t0 = new Date("2026-10-19T09:30:00Z");
    const r = await reserveSend(paths.state, "briefing", t0, () => ({ send: true }));
    await finishSend(paths.state, "briefing", (r as any).token, true, t0, "Europe/Berlin");
    const script = `
      import { readProactiveState } from ${JSON.stringify(join(import.meta.dir, "..", "src", "lib", "proactive", "state.ts"))};
      console.log(JSON.stringify(await readProactiveState(${JSON.stringify(paths.state)})));
    `;
    const proc = Bun.spawnSync(["bun", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const seen = JSON.parse(proc.stdout.toString().trim().split("\n").pop()!);
    expect(seen.checkin.snoozedUntil).toBe("2026-10-19T13:00:00.000Z");
    expect(seen.briefing).toEqual({ lastSentAt: t0.toISOString(), lastDate: "2026-10-19" });
  });
});

describe("Übernahme", () => {
  const SCHEDULE = {
    timezone: "UTC",
    check_in_hours: { start: 9, end: 18 },
    morning_briefing: { hour: 7, minute: 15, enabled: false },
    check_in_intervals: [{ hour: 15, minute: 0 }, { hour: 9, minute: 30 }, { hour: 9, minute: 30 }, { hour: 25 }],
    quiet_hours: { start: 22, end: 7 },
    minimum_gap_minutes: 120,
  };
  const OLD_STATE = {
    lastMessageTime: "2026-04-01T10:00:00.000Z",
    lastCheckinTime: "2026-10-18T14:30:00.000Z",
    pendingItems: ["PENDING_CALL: Zahnarzt"],
    lastBriefingDate: "2026-10-18",
  };
  const settings = () => JSON.parse(readFileSync(paths.settings, "utf-8"));

  test("Abbildung des Zeitplans", () => {
    expect(scheduleToProactive(SCHEDULE, "wildcard")).toEqual({
      quietHours: { from: "22:00", to: "07:00" },
      checkin: { window: { from: "09:00", to: "18:00" }, times: ["09:30", "15:00"], minGapMinutes: 120 },
      briefing: { enabled: false, window: { from: "07:15", to: "10:15" } },
    });
    // Ende 24 ist Mitternacht, Briefing spät abends läuft über Mitternacht
    // Fehlt check_in_intervals, die bisherigen Ersatztermine der Plattform
    expect(scheduleToProactive({ check_in_hours: { start: 8, end: 24 }, morning_briefing: { hour: 22, minute: 30 } }, "zero")).toEqual({
      checkin: { window: { from: "08:00", to: "00:00" }, times: ["10:30", "14:30", "18:30"] },
      briefing: { window: { from: "22:30", to: "01:30" } },
    });
    // Ungültige Felder fallen weg
    expect(scheduleToProactive({ quiet_hours: { start: 8, end: 8 }, minimum_gap_minutes: -5, check_in_intervals: [{ hour: "x" }] }, "wildcard")).toEqual({});
    // Ausdrücklich keine Termine bleibt erhalten
    expect(scheduleToProactive({ check_in_intervals: [] }, "wildcard")).toEqual({ checkin: { times: [] } });
    expect(scheduleToProactive({ check_in_intervals: [] }, "zero")).toEqual({ checkin: { times: [] } });
  });

  test("leere alte Terminliste: Übernahme, Wiederholung und Zeitplan ohne Check-in-Termin", async () => {
    writeFileSync(paths.schedule, JSON.stringify({ check_in_intervals: [] }));
    expect((await importLegacyProactive(paths)).schedule).toBe("imported");
    expect(settings().proactive).toEqual({ checkin: { times: [] } });
    expect(proactiveConfig(settingsSchema.parse(settings())).checkin.times).toEqual([]);

    const before = readFileSync(paths.settings, "utf-8");
    expect((await importLegacyProactive(paths)).schedule).toBe("done-before");
    expect(readFileSync(paths.settings, "utf-8")).toBe(before);

    // Zeitplan der Einrichtung aus den übernommenen Einstellungen, ohne die alte Datei
    const io: SetupScheduleIo = {
      exists: p => p === join("/projekt", "config", "settings.json"),
      readFile: () => before,
      log: () => {},
    };
    expect(setupSchedule("/projekt", io, "wildcard").check_in_intervals).toEqual([]);
    expect(setupSchedule("/projekt", io, "zero").check_in_intervals).toEqual([]);
  });

  const pad = (n: number) => String(n).padStart(2, "0");
  const clockOf = (s: { hour: number; minute: number }) => `${pad(s.hour)}:${pad(s.minute)}`;
  const everyHourAt30 = Array.from({ length: 24 }, (_, h) => `${pad(h)}:30`);
  const everyMinuteOf10 = Array.from({ length: 60 }, (_, m) => `10:${pad(m)}`);

  test("Lesart je Plattform: launchd fehlendes Feld = jeder Wert, cron und Windows = 0", () => {
    expect(legacyReadingFor("darwin")).toBe("wildcard");
    expect(legacyReadingFor("linux")).toBe("zero");
    expect(legacyReadingFor("win32")).toBe("zero");
    expect(legacyStartMinutes({ minute: 30 }, "wildcard")).toHaveLength(24);
    expect(legacyStartMinutes({ minute: 30 }, "zero")).toEqual([30]);
    expect(legacyStartMinutes({ hour: 10 }, "wildcard")).toHaveLength(60);
    expect(legacyStartMinutes({ hour: 10 }, "zero")).toEqual([600]);
    expect(legacyStartMinutes({}, "wildcard")).toHaveLength(1440);
    expect(legacyStartMinutes({}, "zero")).toEqual([0]);
    expect(legacyStartMinutes({ hour: 24 }, "zero")).toBeNull();
    // Liste: [] bleibt leer, lauter ungültige ergeben nichts, Doppelte fallen weg
    expect(legacyCheckinMinutes([], "zero")).toEqual([]);
    // Fehlende Liste: bisherige Ersatztermine, launchd fünf, cron und Windows drei
    expect(legacyCheckinMinutes(undefined, "wildcard")).toEqual([630, 750, 870, 990, 1110]);
    expect(legacyCheckinMinutes(null, "zero")).toEqual([630, 870, 1110]);
    expect(legacyCheckinMinutes("zehn", "zero")).toBeNull();
    expect(legacyCheckinMinutes([{ hour: "x" }], "zero")).toBeNull();
    expect(legacyCheckinMinutes([{ hour: 10 }, { hour: 10, minute: 0 }, { minute: 75 }], "zero")).toEqual([600]);
    // Briefing: fehlende Minute 0, ungültige Zeit zählt nicht
    expect(legacyBriefingStart({ hour: 8 })).toBe(480);
    expect(legacyBriefingStart({ hour: 8, minute: "x" })).toBeNull();
    expect(legacyBriefingStart({ hour: 30 })).toBeNull();
  });

  for (const [name, interval, reading, times] of [
    ["{minute:30} unter launchd: jede Stunde zur Minute 30", { minute: 30 }, "wildcard", everyHourAt30],
    ["{hour:10} unter launchd: jede Minute der Stunde 10", { hour: 10 }, "wildcard", everyMinuteOf10],
    ["{minute:30} unter cron und Windows: 00:30", { minute: 30 }, "zero", ["00:30"]],
    ["{hour:10} unter cron und Windows: 10:00", { hour: 10 }, "zero", ["10:00"]],
  ] as const) {
    test(`Platzhalter ${name}: Übernahme, Wiederholung und Zeitplan ohne die alte Datei`, async () => {
      writeFileSync(paths.schedule, JSON.stringify({ check_in_intervals: [interval] }));
      expect((await importLegacyProactive(paths, new Date(), {}, reading)).schedule).toBe("imported");
      expect(settings().proactive.checkin.times).toEqual([...times]);
      expect(proactiveConfig(settingsSchema.parse(settings())).checkin.times).toEqual([...times]);

      const before = readFileSync(paths.settings, "utf-8");
      expect((await importLegacyProactive(paths, new Date(), {}, reading)).schedule).toBe("done-before");
      expect(readFileSync(paths.settings, "utf-8")).toBe(before);

      // Zeitplan der Einrichtung ohne die alte Datei gleicht dem mit der alten Datei
      const withoutLegacy: SetupScheduleIo = {
        exists: p => p === join("/projekt", "config", "settings.json"),
        readFile: () => before,
        log: () => {},
      };
      const withLegacy: SetupScheduleIo = {
        exists: () => true,
        readFile: p => (p.endsWith("schedule.json") ? JSON.stringify({ check_in_intervals: [interval] }) : before),
        log: () => {},
      };
      const fromSettings = setupSchedule("/projekt", withoutLegacy, reading).check_in_intervals;
      expect(fromSettings.map(clockOf)).toEqual([...times]);
      expect(setupSchedule("/projekt", withLegacy, reading).check_in_intervals).toEqual(fromSettings);
      // launchd fasst die aufgefächerten Startzeiten wieder zum Platzhalter
      if (reading === "wildcard") expect(compactForLaunchd(fromSettings)).toEqual([interval]);
    });
  }

  test("Platzhalter gemischt mit festen Terminen: keine Standardtermine", () => {
    const intervals = [{ minute: 30 }, { hour: 10 }, { hour: 15, minute: 5 }];
    const launchd = scheduleToProactive({ check_in_intervals: intervals }, "wildcard").checkin!.times!;
    // 24 + 60 Termine, 10:30 nur einmal, dazu 15:05; nichts auf 0 gesetzt
    expect(launchd).toHaveLength(24 + 60 - 1 + 1);
    expect(launchd).not.toContain("15:00");
    const slots = (times: readonly string[]) => times.map(t => ({ hour: Number(t.slice(0, 2)), minute: Number(t.slice(3)) }));
    expect(compactForLaunchd(slots(launchd))).toEqual(intervals);
    expect(compactForLaunchd(slots(scheduleToProactive({ check_in_intervals: [{}] }, "wildcard").checkin!.times!))).toEqual([{}]);
    // cron und Windows: fehlende Felder 0, wie bisher
    expect(scheduleToProactive({ check_in_intervals: intervals }, "zero").checkin!.times).toEqual(["00:30", "10:00", "15:05"]);
    expect(scheduleToProactive({ check_in_intervals: [{}] }, "zero").checkin!.times).toEqual(["00:00"]);
  });

  test("bewusst geleerte pendingItems bleiben leer, auch bei alten Einträgen", async () => {
    await updateProactiveState(paths.state, s => {
      s.checkin.pendingItems.push("erledigt");
    });
    await updateProactiveState(paths.state, s => {
      s.checkin.pendingItems = [];
    });
    writeFileSync(paths.checkinState, JSON.stringify(OLD_STATE));
    expect((await importLegacyProactive(paths)).checkinState).toBe("imported");
    const state = await readProactiveState(paths.state);
    expect(state.checkin.pendingItems).toEqual([]);
    // Übrige Felder kommen weiterhin
    expect(state.checkin.lastSentAt).toBe("2026-10-18T14:30:00.000Z");
  });

  test("vorhandener Zustand ohne pendingItems (etwa nach Snooze): erstmalige Übernahme der Einträge", async () => {
    await snoozeKind(paths.state, "checkin", new Date("2026-10-19T13:00:00Z"));
    expect(JSON.parse(readFileSync(paths.state, "utf-8")).checkin.pendingItems).toBeUndefined();
    writeFileSync(paths.checkinState, JSON.stringify(OLD_STATE));
    expect((await importLegacyProactive(paths)).checkinState).toBe("imported");
    expect((await readProactiveState(paths.state)).checkin.pendingItems).toEqual(["PENDING_CALL: Zahnarzt"]);
  });

  test("beide Dateien übernehmen, alte bleiben liegen", async () => {
    writeFileSync(paths.schedule, JSON.stringify(SCHEDULE));
    writeFileSync(paths.checkinState, JSON.stringify(OLD_STATE));
    const report = await importLegacyProactive(paths, new Date("2026-10-19T08:00:00Z"));
    expect(report).toEqual({ schedule: "imported", checkinState: "imported" });

    expect(settings().proactive.checkin).toEqual({ window: { from: "09:00", to: "18:00" }, times: ["09:30", "15:00"], minGapMinutes: 120 });
    const state = await readProactiveState(paths.state);
    expect(state.checkin.lastSentAt).toBe("2026-10-18T14:30:00.000Z");
    expect(state.checkin.pendingItems).toEqual(["PENDING_CALL: Zahnarzt"]);
    expect(state.briefing.lastDate).toBe("2026-10-18");
    expect(JSON.stringify(state)).not.toContain("2026-04-01");
    expect(state.imported).toEqual({ schedule: "2026-10-19T08:00:00.000Z", checkinState: "2026-10-19T08:00:00.000Z" });
    expect(existsSync(paths.schedule)).toBe(true);
    expect(existsSync(paths.checkinState)).toBe(true);
  });

  test("vorhandene neue Einstellungen haben Vorrang, andere Blöcke bleiben", async () => {
    writeFileSync(paths.settings, JSON.stringify({ threads: { enabled: false }, proactive: { checkin: { minGapMinutes: 45 }, quietHours: { from: "23:00", to: "06:00" } } }));
    writeFileSync(paths.schedule, JSON.stringify(SCHEDULE));
    await importLegacyProactive(paths);
    const s = settings();
    expect(s.threads).toEqual({ enabled: false });
    expect(s.proactive.quietHours).toEqual({ from: "23:00", to: "06:00" });
    expect(s.proactive.checkin.minGapMinutes).toBe(45);
    expect(s.proactive.checkin.times).toEqual(["09:30", "15:00"]);
  });

  test("vorhandener neuer Zustand hat Vorrang", async () => {
    await updateProactiveState(paths.state, s => {
      s.checkin.lastSentAt = "2026-10-19T07:00:00.000Z";
      s.briefing.lastDate = "2026-10-19";
    });
    writeFileSync(paths.checkinState, JSON.stringify(OLD_STATE));
    await importLegacyProactive(paths);
    const state = await readProactiveState(paths.state);
    expect(state.checkin.lastSentAt).toBe("2026-10-19T07:00:00.000Z");
    expect(state.briefing.lastDate).toBe("2026-10-19");
    expect(state.checkin.pendingItems).toEqual(["PENDING_CALL: Zahnarzt"]);
  });

  test("zweiter Lauf ändert nichts, auch nach Änderung der alten Dateien", async () => {
    writeFileSync(paths.schedule, JSON.stringify(SCHEDULE));
    writeFileSync(paths.checkinState, JSON.stringify(OLD_STATE));
    await importLegacyProactive(paths, new Date("2026-10-19T08:00:00Z"));
    // Der Nutzer entfernt eine Angabe (will den Standard), die alte Datei ändert sich
    const s = settings();
    delete s.proactive.checkin.minGapMinutes;
    writeFileSync(paths.settings, JSON.stringify(s));
    writeFileSync(paths.schedule, JSON.stringify({ ...SCHEDULE, minimum_gap_minutes: 10 }));
    writeFileSync(paths.checkinState, JSON.stringify({ ...OLD_STATE, lastBriefingDate: "2026-10-19" }));
    const settingsBefore = readFileSync(paths.settings, "utf-8");
    const stateBefore = readFileSync(paths.state, "utf-8");

    const report = await importLegacyProactive(paths, new Date("2026-10-20T08:00:00Z"));
    expect(report).toEqual({ schedule: "done-before", checkinState: "done-before" });
    expect(readFileSync(paths.settings, "utf-8")).toBe(settingsBefore);
    expect(readFileSync(paths.state, "utf-8")).toBe(stateBefore);
  });

  test("fehlende Dateien: nichts angelegt, später nachgeholt", async () => {
    expect(await importLegacyProactive(paths)).toEqual({ schedule: "missing", checkinState: "missing" });
    expect(existsSync(paths.settings)).toBe(false);
    expect((await readProactiveState(paths.state)).imported).toEqual({});

    writeFileSync(paths.checkinState, JSON.stringify(OLD_STATE));
    expect((await importLegacyProactive(paths)).checkinState).toBe("imported");
  });

  test("kaputte Dateien: keine Marke, kein Schaden, Log ohne Inhalt", async () => {
    writeFileSync(paths.schedule, "{nicht json");
    writeFileSync(paths.checkinState, "[1,2]");
    expect(await importLegacyProactive(paths)).toEqual({ schedule: "broken", checkinState: "broken" });
    expect(existsSync(paths.settings)).toBe(false);
    expect((await readProactiveState(paths.state)).imported).toEqual({});
    expect(log.mock.calls.map(c => String(c[0])).join("\n")).not.toContain("nicht json");
  });

  test("ungültige Einstellungsdatei: nicht überschrieben, keine Marke", async () => {
    writeFileSync(paths.settings, "{kaputt");
    writeFileSync(paths.schedule, JSON.stringify(SCHEDULE));
    expect((await importLegacyProactive(paths)).schedule).toBe("settings-unwritable");
    expect(readFileSync(paths.settings, "utf-8")).toBe("{kaputt");
    expect((await readProactiveState(paths.state)).imported.schedule).toBeUndefined();
  });

  test("nichts zu ergänzen: Einstellungsdatei bleibt unberührt, Marke gesetzt", async () => {
    writeFileSync(paths.schedule, JSON.stringify({ timezone: "UTC", check_in_intervals: [{ hour: "x" }] }));
    expect((await importLegacyProactive(paths)).schedule).toBe("imported");
    expect(existsSync(paths.settings)).toBe(false);
  });

  test("gleichzeitige Übernahme: einmal übernommen, Ergebnis wie bei einem Lauf", async () => {
    writeFileSync(paths.schedule, JSON.stringify(SCHEDULE));
    writeFileSync(paths.checkinState, JSON.stringify(OLD_STATE));
    const reports = await Promise.all([importLegacyProactive(paths), importLegacyProactive(paths), importLegacyProactive(paths)]);
    expect(reports.filter(r => r.checkinState === "imported")).toHaveLength(1);
    expect(reports.filter(r => r.schedule === "imported")).toHaveLength(1);
    const state = await readProactiveState(paths.state);
    expect(state.checkin.pendingItems).toEqual(["PENDING_CALL: Zahnarzt"]);
    expect(settings().proactive.checkin.minGapMinutes).toBe(120);
  });

  describe("Einstellungen über Prozesse", () => {
  const FIXTURE = join(import.meta.dir, "fixtures", "proactive", "settings-race.ts");
  const spawnRace = (mode: "migrate" | "migrate-late" | "write" | "remove-gap", tag = "") =>
    Bun.spawn(["bun", FIXTURE], {
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", RACE_DIR: dir, RACE_MODE: mode, RACE_TAG: tag },
      stdout: "pipe",
      stderr: "pipe",
    });
  async function waitFor(check: () => boolean, ms: number): Promise<boolean> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (check()) return true;
      await Bun.sleep(10);
    }
    return check();
  }

  test("Änderung des Bots mitten in der Übernahme der Routine geht nicht verloren", async () => {
    writeFileSync(paths.settings, JSON.stringify({ defaults: { model: "eigenes-modell" } }));
    writeFileSync(paths.schedule, JSON.stringify(SCHEDULE));

    // Die Routine hat die Einstellungen gelesen und hält vor dem Schreiben an
    const migrate = spawnRace("migrate");
    expect(await waitFor(() => existsSync(join(dir, "inside")), 15_000)).toBe(true);

    // Der Bot speichert jetzt eine neue Einstellung: er muss warten
    const writer = spawnRace("write");
    let writerDone = false;
    void writer.exited.then(() => { writerDone = true; });
    expect(await waitFor(() => writerDone, 600)).toBe(false);

    // Die Routine schreibt ihren Stand plus Übernahme, danach der Bot
    writeFileSync(join(dir, "go"), "");
    expect(await migrate.exited).toBe(0);
    expect(await writer.exited).toBe(0);

    const saved = settings();
    expect(saved.defaults).toEqual({ model: "eigenes-modell", effort: "low" });
    expect(saved.proactive.checkin.minGapMinutes).toBe(120);
    expect(existsSync(`${paths.settings}.lock`)).toBe(false);
  }, 30_000);

  test("zweite Übernahme nach der ersten ergänzt ein danach entferntes Feld nicht wieder", async () => {
    writeFileSync(paths.settings, JSON.stringify({ defaults: { model: "eigenes-modell" } }));
    writeFileSync(paths.schedule, JSON.stringify(SCHEDULE));
    const signal = (name: string) => existsSync(join(dir, name));

    // A übernimmt und hält mitten im Schreiben der Einstellungen an
    const a = spawnRace("migrate", "a-");
    expect(await waitFor(() => signal("a-inside"), 15_000)).toBe(true);
    // B startet, solange die Marke noch fehlt
    const b = spawnRace("migrate-late", "b-");
    expect(await waitFor(() => signal("b-start"), 15_000)).toBe(true);

    // A schreibt fertig und setzt die Marke
    writeFileSync(join(dir, "a-go"), "");
    expect(await a.exited).toBe(0);
    expect(settings().proactive.checkin.minGapMinutes).toBe(120);

    // B liest die Marken erst jetzt, unter der Sperre, und sieht die von A
    expect(await waitFor(() => signal("b-saw"), 15_000)).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "b-saw"), "utf-8")).schedule).toBe("2026-10-19T12:00:00.000Z");

    // Der Nutzer entfernt den Mindestabstand (Standard soll gelten), während B wartet
    const remove = spawnRace("remove-gap");
    expect(await remove.exited).toBe(0);
    expect(settings().proactive.checkin.minGapMinutes).toBeUndefined();

    // B macht weiter: nichts mehr zu übernehmen
    writeFileSync(join(dir, "b-go"), "");
    expect(await b.exited).toBe(0);
    expect(JSON.parse(readFileSync(join(dir, "b-report"), "utf-8")).schedule).toBe("done-before");
    const saved = settings();
    expect(saved.proactive.checkin.minGapMinutes).toBeUndefined();
    expect(saved.proactive.checkin.window).toEqual({ from: "09:00", to: "18:00" });
    expect(saved.defaults).toEqual({ model: "eigenes-modell" });
  }, 60_000);
});
});
