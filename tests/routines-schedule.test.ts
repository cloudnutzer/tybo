/**
 * Issue #284, Checkbox 1: Zeitplan in Klartext (src/lib/routines/schedule.ts).
 */

import { describe, expect, test } from "bun:test";
import {
  classifySchedule,
  describeCalendar,
  describeCron,
  describeInterval,
  describeSchedule,
  scheduleFromPlist,
} from "../src/lib/routines/schedule";

describe("StartCalendarInterval", () => {
  test("Beispiele aus dem Issue", () => {
    expect(describeCalendar({ Hour: 6, Minute: 30 })).toBe("täglich 06:30");
    expect(describeCalendar({ Weekday: 1, Hour: 9, Minute: 0 })).toBe("montags 09:00");
    expect(describeCalendar({ Minute: 15 })).toBe("stündlich zur Minute 15");
    expect(describeCalendar([{ Hour: 3, Minute: 30 }])).toBe("täglich 03:30");
  });

  test("Liste mit fünf Werktagen heißt werktags", () => {
    const list = [1, 2, 3, 4, 5].map(Weekday => ({ Weekday, Hour: 8, Minute: 0 }));
    expect(describeCalendar(list)).toBe("werktags 08:00");
    expect(describeCalendar([...list].reverse())).toBe("werktags 08:00");
  });

  test("Weekday 0 und 7 sind Sonntag", () => {
    expect(describeCalendar({ Weekday: 0, Hour: 10, Minute: 5 })).toBe("sonntags 10:05");
    expect(describeCalendar({ Weekday: 7, Hour: 10, Minute: 5 })).toBe("sonntags 10:05");
    expect(describeCalendar([{ Weekday: 6, Hour: 10, Minute: 0 }, { Weekday: 7, Hour: 10, Minute: 0 }])).toBe("samstags und sonntags 10:00");
    expect(describeCalendar([{ Weekday: 1, Hour: 9, Minute: 0 }, { Weekday: 3, Hour: 9, Minute: 0 }])).toBe("montags und mittwochs 09:00");
  });

  test("mehrere Uhrzeiten täglich, Tag im Monat, Tag im Jahr", () => {
    expect(describeCalendar([{ Hour: 17, Minute: 0 }, { Hour: 9, Minute: 0 }, { Hour: 13, Minute: 0 }])).toBe("täglich 09:00, 13:00 und 17:00");
    expect(describeCalendar({ Day: 1, Hour: 9, Minute: 0 })).toBe("monatlich am 1. um 09:00");
    expect(describeCalendar({ Month: 3, Day: 15, Hour: 9, Minute: 0 })).toBe("jährlich am 15.3. um 09:00");
  });

  test("unbekannte Schlüssel, ungültige Werte und Unklares ergeben eigener Zeitplan", () => {
    expect(describeCalendar({ Hour: 6, Minute: 30, Second: 1 })).toBe('eigener Zeitplan ({"Hour":6,"Minute":30,"Second":1})');
    expect(describeCalendar({ Hour: 25, Minute: 0 })).toStartWith("eigener Zeitplan (");
    expect(describeCalendar({ Hour: 6 })).toBe('eigener Zeitplan ({"Hour":6})');
    expect(describeCalendar([])).toBe("eigener Zeitplan ([])");
    expect(describeCalendar("täglich")).toBe("eigener Zeitplan (täglich)");
  });
});

describe("StartInterval", () => {
  test("Minuten, Stunden, Sekunden", () => {
    expect(describeInterval(600)).toBe("alle 10 Minuten");
    expect(describeInterval(60)).toBe("jede Minute");
    expect(describeInterval(3600)).toBe("stündlich");
    expect(describeInterval(7200)).toBe("alle 2 Stunden");
    expect(describeInterval(90)).toBe("alle 90 Sekunden");
    expect(describeInterval(-5)).toBe("eigener Zeitplan (-5)");
  });
});

describe("Cron aus PM2", () => {
  test("einfache Ausdrücke", () => {
    expect(describeCron("30 6 * * *")).toBe("täglich 06:30");
    expect(describeCron("*/10 * * * *")).toBe("alle 10 Minuten");
    expect(describeCron("15 * * * *")).toBe("stündlich zur Minute 15");
    expect(describeCron("0 9 * * 1")).toBe("montags 09:00");
    expect(describeCron("0 8 * * 1-5")).toBe("werktags 08:00");
    expect(describeCron("0 8 * * 0")).toBe("sonntags 08:00");
    expect(describeCron("0 8 * * 7")).toBe("sonntags 08:00");
    expect(describeCron("0 9 1 * *")).toBe("monatlich am 1. um 09:00");
  });

  test("Unbekanntes bleibt Rohwert", () => {
    expect(describeCron("0 */2 * * *")).toBe("eigener Zeitplan (0 */2 * * *)");
    expect(describeCron("0 0 9 * * *")).toBe("eigener Zeitplan (0 0 9 * * *)");
    expect(describeCron("@daily")).toBe("eigener Zeitplan (@daily)");
  });

  // Regression aus der Prüfung, Runde 1: „*\/45" hieß „alle 45 Minuten",
  // läuft aber zu Minute 0 und 45 (Abstände 45 und 15).
  test("*/45 und */7 sind keine gleichmäßigen Abstände", () => {
    expect(describeCron("*/45 * * * *")).toBe("eigener Zeitplan (*/45 * * * *)");
    expect(describeCron("*/7 * * * *")).toBe("eigener Zeitplan (*/7 * * * *)");
  });

  // Die Klasse dahinter: Beschrieben wird die Menge der Minuten, nicht die
  // Schreibweise. Für jeden Schritt 1 bis 59 und jede Startminute steht
  // „alle N Minuten" genau dann da, wenn alle Abstände (auch über die volle
  // Stunde) N sind.
  test("alle N Minuten genau bei gleichen Abständen, für jede Schreibweise", () => {
    for (let step = 1; step <= 59; step++) {
      for (const start of [0, 5]) {
        const minutes: number[] = [];
        for (let m = start; m < 60; m += step) minutes.push(m);
        const gaps = minutes.map((m, i) => (i + 1 < minutes.length ? minutes[i + 1] : minutes[0] + 60) - m);
        const uniform = gaps.every(g => g === gaps[0]);
        const expected = minutes.length === 1 ? `stündlich zur Minute ${start}` : minutes.length === 60 ? "jede Minute" : uniform ? `alle ${step} Minuten` : null;
        for (const field of [start === 0 ? `*/${step}` : `${start}/${step}`, `${start}-59/${step}`, minutes.join(",")]) {
          const text = describeCron(`${field} * * * *`);
          expect({ field, text }).toEqual({ field, text: expected ?? `eigener Zeitplan (${field} * * * *)` });
        }
      }
    }
  });

  test("Schreibweisen derselben Zeiten ergeben denselben Text", () => {
    expect(describeCron("0,30 * * * *")).toBe("alle 30 Minuten");
    expect(describeCron("0 8 * * 1,2,3,4,5")).toBe("werktags 08:00");
    expect(describeCron("0 8 * * 0-7")).toBe("täglich 08:00");
    expect(describeCron("0 8 1-31 * *")).toBe("täglich 08:00");
    expect(describeCron("0 8 * 1-12 *")).toBe("täglich 08:00");
    expect(describeCron("0 8 * 1-6 *")).toBe("eigener Zeitplan (0 8 * 1-6 *)");
    expect(describeCron("0 8 1 * 1")).toBe("eigener Zeitplan (0 8 1 * 1)");
  });
});

describe("Plist-Zeitplan und Einordnung", () => {
  test("RunAtLoad ohne Zeitplan heißt beim Anmelden, zeitgesteuert", () => {
    const s = scheduleFromPlist({ Label: "ai.tybo.x", RunAtLoad: true });
    expect(describeSchedule(s)).toBe("beim Anmelden");
    expect(classifySchedule(s)).toBe("scheduled");
  });

  test("KeepAlive true ist Dauerdienst", () => {
    const s = scheduleFromPlist({ KeepAlive: true, RunAtLoad: true });
    expect(describeSchedule(s)).toBe("Dauerdienst");
    expect(classifySchedule(s)).toBe("daemon");
  });

  test("Kalenderplan hat Vorrang vor bedingtem KeepAlive (wie ai.tybo.smart-checkin)", () => {
    const s = scheduleFromPlist({
      StartCalendarInterval: [{ Hour: 9, Minute: 0 }, { Hour: 14, Minute: 0 }],
      RunAtLoad: true,
      KeepAlive: { SuccessfulExit: false },
    });
    expect(classifySchedule(s)).toBe("scheduled");
    expect(describeSchedule(s)).toBe("täglich 09:00 und 14:00, auch beim Anmelden");
  });

  test("bedingtes KeepAlive ohne Zeitplan ist Dauerdienst, KeepAlive false nicht", () => {
    expect(classifySchedule(scheduleFromPlist({ KeepAlive: { NetworkState: true } }))).toBe("daemon");
    const off = scheduleFromPlist({ KeepAlive: false });
    expect(classifySchedule(off)).toBe("scheduled");
    expect(describeSchedule(off)).toBe("kein Zeitplan");
  });

  test("fehlender Zeitplan und andere Auslöser", () => {
    expect(describeSchedule(scheduleFromPlist({ Label: "x" }))).toBe("kein Zeitplan");
    expect(describeSchedule(scheduleFromPlist({ WatchPaths: ["/tmp/a"] }))).toBe("eigener Zeitplan (WatchPaths)");
    expect(describeSchedule(scheduleFromPlist({ StartInterval: 600 }))).toBe("alle 10 Minuten");
  });

  test("Cron-Zeitplan: mit Ausdruck zeitgesteuert, ohne Dauerdienst", () => {
    expect(classifySchedule({ type: "cron", cron: "0 8 * * *" })).toBe("scheduled");
    expect(classifySchedule({ type: "cron", cron: null })).toBe("daemon");
    expect(describeSchedule({ type: "cron", cron: null })).toBe("Dauerdienst");
  });
});
