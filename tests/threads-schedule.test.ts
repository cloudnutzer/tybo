import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import {
  applyQuietHours,
  isQuietTime,
  laterReminderTime,
  nextReminderTime,
  remindDays,
  reminderTimeZone,
} from "../src/lib/threads/schedule";
import { resetThreadsConfigLogForTests } from "../src/lib/threads/config";

// Zeitpunkt der Erinnerung (Issue #292): Standard, Dezimaltage, Frist, Ruhezeit, Sommerzeit, Zeitzone.

const at = (iso: string) => Date.parse(iso);
const iso = (ts: number) => new Date(ts).toISOString();
const BERLIN = { USER_TIMEZONE: "Europe/Berlin" };

let logSpy: ReturnType<typeof spyOn>;
beforeEach(() => {
  // Andere Testdateien im selben Prozess (CI: alle) haben ungültige Werte womöglich schon geloggt
  resetThreadsConfigLogForTests();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => logSpy.mockRestore());

describe("nextReminderTime", () => {
  test("Standard: 3 Tage später, ohne Zeitzone in UTC", () => {
    expect(iso(nextReminderTime(at("2026-10-15T10:00:00Z"), undefined, {}))).toBe("2026-10-18T10:00:00.000Z");
  });

  test("THREADS_REMIND_DAYS=0.5: zwölf Stunden", () => {
    expect(iso(nextReminderTime(at("2026-10-15T08:00:00Z"), undefined, { THREADS_REMIND_DAYS: "0.5" }))).toBe("2026-10-15T20:00:00.000Z");
    expect(remindDays({ THREADS_REMIND_DAYS: "0.5" })).toBe(0.5);
  });

  test("THREADS_REMIND_DAYS ungültig: 3 Tage, einmal ins Log", () => {
    for (const bad of ["abc", "0", "-1", "1e3", "2 Tage"]) {
      expect(nextReminderTime(at("2026-10-15T10:00:00Z"), undefined, { THREADS_REMIND_DAYS: bad })).toBe(at("2026-10-18T10:00:00Z"));
    }
    nextReminderTime(at("2026-10-15T10:00:00Z"), undefined, { THREADS_REMIND_DAYS: "abc" });
    const lines = logSpy.mock.calls.map(c => String(c[0])).filter(l => l.includes("THREADS_REMIND_DAYS"));
    expect(lines.length).toBe(5);
    expect(remindDays({})).toBe(3);
    expect(remindDays({ THREADS_REMIND_DAYS: " " })).toBe(3);
  });

  test("Frist in 5 Tagen: bei 7 Tagen gilt der Frist-Termin (09:00 am Vortag), bei 3 Tagen der Standard", () => {
    const base = at("2026-10-15T10:00:00Z");
    expect(iso(nextReminderTime(base, "2026-10-20", { THREADS_REMIND_DAYS: "7" }))).toBe("2026-10-19T09:00:00.000Z");
    expect(iso(nextReminderTime(base, "2026-10-20", {}))).toBe("2026-10-18T10:00:00.000Z");
  });

  test("Frist morgen: 12 Stunden Mindestabstand", () => {
    expect(iso(nextReminderTime(at("2026-10-15T07:00:00Z"), "2026-10-16", {}))).toBe("2026-10-15T19:00:00.000Z");
  });

  test("Frist heute: ebenfalls 12 Stunden, danach Ruhezeit", () => {
    // 10:00 + 12 h = 22:00, Ruhezeit schiebt auf 09:00 am nächsten Tag
    expect(iso(nextReminderTime(at("2026-10-15T10:00:00Z"), "2026-10-15", {}))).toBe("2026-10-16T09:00:00.000Z");
  });

  test("Frist vorbei: Standard", () => {
    expect(iso(nextReminderTime(at("2026-10-15T10:00:00Z"), "2026-10-10", {}))).toBe("2026-10-18T10:00:00.000Z");
  });

  test("Ruhezeit vor 08:00: 09:00 desselben Tages", () => {
    expect(iso(nextReminderTime(at("2026-10-15T19:00:00Z"), undefined, { THREADS_REMIND_DAYS: "0.5" }))).toBe("2026-10-16T09:00:00.000Z");
    expect(iso(applyQuietHours(at("2026-10-16T07:59:00Z"), "UTC"))).toBe("2026-10-16T09:00:00.000Z");
  });

  test("Ruhezeit ab 21:00: 09:00 am nächsten Tag; 20:59 bleibt", () => {
    expect(iso(nextReminderTime(at("2026-10-15T10:00:00Z"), undefined, { THREADS_REMIND_DAYS: "0.5" }))).toBe("2026-10-16T09:00:00.000Z");
    expect(iso(applyQuietHours(at("2026-10-15T21:00:00Z"), "UTC"))).toBe("2026-10-16T09:00:00.000Z");
    expect(iso(applyQuietHours(at("2026-10-15T20:59:00Z"), "UTC"))).toBe("2026-10-15T20:59:00.000Z");
    expect(isQuietTime(at("2026-10-15T20:59:59Z"), "UTC")).toBe(false);
    expect(isQuietTime(at("2026-10-15T21:00:00Z"), "UTC")).toBe(true);
    expect(isQuietTime(at("2026-10-15T07:59:59Z"), "UTC")).toBe(true);
    expect(isQuietTime(at("2026-10-15T08:00:00Z"), "UTC")).toBe(false);
  });

  test("Europe/Berlin über den Wechsel auf Sommerzeit: gleiche Ortszeit, Ruhezeit nach Ortszeit", () => {
    // Freitag 27.3. 10:00 MEZ (09:00Z) + 3 Tage = Montag 30.3. 10:00 MESZ (08:00Z)
    expect(iso(nextReminderTime(at("2026-03-27T09:00:00Z"), undefined, BERLIN))).toBe("2026-03-30T08:00:00.000Z");
    // 28.3. 12:00 MEZ + 12 h = 29.3. 00:00 MEZ, also 09:00 MESZ (07:00Z)
    expect(iso(nextReminderTime(at("2026-03-28T11:00:00Z"), undefined, { ...BERLIN, THREADS_REMIND_DAYS: "0.5" }))).toBe("2026-03-29T07:00:00.000Z");
    // Frist am 30.3.: 09:00 MESZ am 29.3.
    expect(iso(nextReminderTime(at("2026-03-26T09:00:00Z"), "2026-03-30", { ...BERLIN, THREADS_REMIND_DAYS: "7" }))).toBe("2026-03-29T07:00:00.000Z");
  });

  test("Europe/Berlin über den Wechsel auf Winterzeit", () => {
    // Freitag 23.10. 10:00 MESZ (08:00Z) + 3 Tage = Montag 26.10. 10:00 MEZ (09:00Z)
    expect(iso(nextReminderTime(at("2026-10-23T08:00:00Z"), undefined, BERLIN))).toBe("2026-10-26T09:00:00.000Z");
    // 24.10. 12:00 MESZ + 12 h = 25.10. 00:00 MESZ, also 09:00 MEZ (08:00Z)
    expect(iso(nextReminderTime(at("2026-10-24T10:00:00Z"), undefined, { ...BERLIN, THREADS_REMIND_DAYS: "0.5" }))).toBe("2026-10-25T08:00:00.000Z");
    // 20:30 Ortszeit ist erlaubt, 21:00 Ortszeit nicht (19:00Z im Sommer, 20:00Z im Winter)
    expect(isQuietTime(at("2026-10-24T18:30:00Z"), "Europe/Berlin")).toBe(false);
    expect(isQuietTime(at("2026-10-24T19:00:00Z"), "Europe/Berlin")).toBe(true);
    expect(isQuietTime(at("2026-10-26T19:30:00Z"), "Europe/Berlin")).toBe(false);
    expect(isQuietTime(at("2026-10-26T20:00:00Z"), "Europe/Berlin")).toBe(true);
  });

  test("Zeitzone fehlt: UTC; ungültig: UTC, einmal ins Log", () => {
    expect(reminderTimeZone({})).toBe("UTC");
    expect(reminderTimeZone({ USER_TIMEZONE: "Mars/Olympus" })).toBe("UTC");
    expect(reminderTimeZone({ USER_TIMEZONE: "Mars/Olympus" })).toBe("UTC");
    expect(nextReminderTime(at("2026-10-15T10:00:00Z"), undefined, { USER_TIMEZONE: "Mars/Olympus" })).toBe(at("2026-10-18T10:00:00Z"));
    const lines = logSpy.mock.calls.map(c => String(c[0])).filter(l => l.includes("USER_TIMEZONE"));
    expect(lines.length).toBe(1);
  });

  test("Später: 3 Tage unabhängig von THREADS_REMIND_DAYS, mit Ruhezeit", () => {
    expect(iso(laterReminderTime(at("2026-10-15T10:00:00Z"), { THREADS_REMIND_DAYS: "0.01" }))).toBe("2026-10-18T10:00:00.000Z");
    expect(iso(laterReminderTime(at("2026-10-15T20:30:00Z"), { USER_TIMEZONE: "Europe/Berlin" }))).toBe("2026-10-19T07:00:00.000Z");
  });
});
