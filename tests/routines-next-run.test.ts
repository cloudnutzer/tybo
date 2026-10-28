/**
 * Issue #285, Checkbox 3: nextRun in src/lib/routines/schedule.ts. Alle
 * Fälle mit fester Zeitzone Europe/Berlin, damit das Ergebnis nicht von der
 * Zeitzone des Rechners abhängt.
 */

import { describe, expect, test } from "bun:test";
import { nextRun, scheduleFromPlist, zonedTime, type LaunchdSchedule } from "../src/lib/routines/schedule";

const TZ = "Europe/Berlin";
/** Wanduhrzeit in Berlin als ms */
const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => zonedTime(y, mo, d, h, mi, TZ) + s * 1000;
const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

function cal(value: unknown, extra: Record<string, unknown> = {}): LaunchdSchedule {
  return scheduleFromPlist({ StartCalendarInterval: value, ...extra });
}

function next(s: LaunchdSchedule | null, now: number, lastStart: number | null = null) {
  return iso(nextRun(s, { now, lastStart, timeZone: TZ }));
}

describe("nextRun: StartCalendarInterval", () => {
  // Donnerstag, 15.10.2026, Sommerzeit (UTC+2)
  const THU_10 = at(2026, 10, 15, 10, 0);

  test("feste Uhrzeit: heute, wenn noch nicht vorbei, sonst morgen; genau zur Uhrzeit zählt der nächste Tag", () => {
    const s = cal({ Hour: 3, Minute: 30 });
    expect(next(s, THU_10)).toBe("2026-10-16T01:30:00.000Z");
    expect(next(s, at(2026, 10, 15, 2, 0))).toBe("2026-10-15T01:30:00.000Z");
    expect(next(s, at(2026, 10, 15, 3, 30))).toBe("2026-10-16T01:30:00.000Z");
    expect(next(s, at(2026, 10, 15, 3, 29, 59))).toBe("2026-10-15T01:30:00.000Z");
  });

  test("über Mitternacht", () => {
    expect(next(cal({ Hour: 0, Minute: 15 }), at(2026, 10, 15, 23, 50))).toBe("2026-10-15T22:15:00.000Z");
    // Monatswechsel
    expect(next(cal({ Hour: 0, Minute: 15 }), at(2026, 10, 31, 23, 50))).toBe("2026-10-31T23:15:00.000Z");
  });

  test("Wochentag: Montag 08:00 ab Donnerstag, Sonntag als 0 und 7", () => {
    expect(next(cal({ Weekday: 1, Hour: 8, Minute: 0 }), THU_10)).toBe("2026-10-19T06:00:00.000Z");
    expect(next(cal({ Weekday: 0, Hour: 8, Minute: 0 }), THU_10)).toBe("2026-10-18T06:00:00.000Z");
    expect(next(cal({ Weekday: 7, Hour: 8, Minute: 0 }), THU_10)).toBe("2026-10-18T06:00:00.000Z");
    // Heute ist Donnerstag, 08:00 ist vorbei: nächste Woche
    expect(next(cal({ Weekday: 4, Hour: 8, Minute: 0 }), THU_10)).toBe("2026-10-22T06:00:00.000Z");
  });

  test("watchdog: nur Minute 0 heißt jede volle Stunde, auch über Mitternacht", () => {
    const watchdog = cal([{ Minute: 0 }]);
    expect(next(watchdog, at(2026, 10, 15, 10, 20))).toBe("2026-10-15T09:00:00.000Z");
    expect(next(watchdog, at(2026, 10, 15, 23, 30))).toBe("2026-10-15T22:00:00.000Z");
  });

  test("smart-checkin: Kalenderliste, frühester Termin aller Einträge, auch unsortiert", () => {
    const checkin = cal([
      { Hour: 18, Minute: 30 },
      { Hour: 10, Minute: 30 },
      { Hour: 14, Minute: 30 },
      { Hour: 12, Minute: 30 },
    ]);
    expect(next(checkin, at(2026, 10, 15, 11, 0))).toBe("2026-10-15T10:30:00.000Z");
    expect(next(checkin, at(2026, 10, 15, 19, 0))).toBe("2026-10-16T08:30:00.000Z");
  });

  test("fehlende Kalenderfelder heißen jeder Wert", () => {
    // Nur Stunde: jede Minute dieser Stunde
    expect(next(cal({ Hour: 5 }), at(2026, 10, 15, 4, 0))).toBe("2026-10-15T03:00:00.000Z");
    expect(next(cal({ Hour: 5 }), at(2026, 10, 15, 5, 10, 30))).toBe("2026-10-15T03:11:00.000Z");
    // Gar nichts: jede Minute
    expect(next(cal({}), at(2026, 10, 15, 5, 10, 30))).toBe("2026-10-15T03:11:00.000Z");
    // Nur Tag des Monats
    expect(next(cal({ Day: 1, Hour: 6, Minute: 0 }), THU_10)).toBe("2026-11-01T05:00:00.000Z");
  });

  test("seltene Termine: 29. Februar im nächsten Schaltjahr", () => {
    expect(next(cal({ Month: 2, Day: 29, Hour: 12, Minute: 0 }), THU_10)).toBe("2028-02-29T11:00:00.000Z");
    expect(next(cal({ Month: 2, Day: 30, Hour: 12, Minute: 0 }), THU_10)).toBeNull();
  });

  test("Zeitumstellung: Winterzeit am 25.10.2026, Sommerzeit am 29.03.2026", () => {
    // Nach der Umstellung gilt UTC+1: 03:30 Ortszeit ist 02:30 UTC
    expect(next(cal({ Hour: 3, Minute: 30 }), at(2026, 10, 24, 12, 0))).toBe("2026-10-25T02:30:00.000Z");
    // 02:30 gibt es am 25.10. zweimal: das erste Mal (noch Sommerzeit)
    expect(next(cal({ Hour: 2, Minute: 30 }), at(2026, 10, 24, 12, 0))).toBe("2026-10-25T00:30:00.000Z");
    // 02:30 gibt es am 29.03. nicht: um die Lücke später, 03:30 Sommerzeit
    expect(next(cal({ Hour: 2, Minute: 30 }), at(2026, 3, 28, 12, 0))).toBe("2026-03-29T01:30:00.000Z");
    // Danach wieder normal
    expect(next(cal({ Hour: 3, Minute: 30 }), at(2026, 3, 29, 12, 0))).toBe("2026-03-30T01:30:00.000Z");
  });

  test("uneindeutig oder ungültig: null", () => {
    expect(next(cal({ Day: 1, Weekday: 1, Hour: 8, Minute: 0 }), THU_10)).toBeNull();
    expect(next(cal({ Hour: 25, Minute: 0 }), THU_10)).toBeNull();
    expect(next(cal([{ Hour: 8, Minute: 0 }, "kaputt"]), THU_10)).toBeNull();
    expect(next(cal([]), THU_10)).toBeNull();
  });
});

describe("nextRun: StartInterval und Sonstiges", () => {
  const NOW = Date.parse("2026-10-15T10:00:00.000Z");

  test("Intervall: letzter Beginn plus Intervall; ohne letzten Lauf null", () => {
    const s = scheduleFromPlist({ StartInterval: 600 });
    expect(iso(nextRun(s, { now: NOW, lastStart: NOW - 60_000, timeZone: TZ }))).toBe("2026-10-15T10:09:00.000Z");
    expect(nextRun(s, { now: NOW, lastStart: null, timeZone: TZ })).toBeNull();
  });

  test("Intervall schon vergangen: der vergangene Zeitpunkt (fällig), nie geraten", () => {
    const s = scheduleFromPlist({ StartInterval: 600 });
    expect(iso(nextRun(s, { now: NOW, lastStart: NOW - 3_600_000, timeZone: TZ }))).toBe("2026-10-15T09:10:00.000Z");
  });

  test("Kalender und Intervall: der frühere Zeitpunkt", () => {
    const s = scheduleFromPlist({ StartInterval: 7200, StartCalendarInterval: { Minute: 30 } });
    expect(iso(nextRun(s, { now: NOW, lastStart: NOW, timeZone: TZ }))).toBe("2026-10-15T10:30:00.000Z");
    expect(iso(nextRun(s, { now: NOW, lastStart: NOW - 7_000_000, timeZone: TZ }))).toBe(new Date(NOW - 7_000_000 + 7_200_000).toISOString());
  });

  test("ohne Zeitplan, nur RunAtLoad, Dauerdienst, PM2-Cron: null", () => {
    expect(nextRun(null, { now: NOW, lastStart: null })).toBeNull();
    expect(nextRun(scheduleFromPlist({ RunAtLoad: true }), { now: NOW, lastStart: NOW })).toBeNull();
    expect(nextRun(scheduleFromPlist({ KeepAlive: true }), { now: NOW, lastStart: NOW })).toBeNull();
    expect(nextRun({ type: "cron", cron: "0 3 * * *" }, { now: NOW, lastStart: NOW })).toBeNull();
  });
});
