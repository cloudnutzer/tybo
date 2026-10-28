/**
 * Issue #365, Checkbox 1: Prüfung „Routinen pünktlich“ im Nachtcheck
 * (src/lib/routines/punctual.ts, evaluatePunctuality in src/health-check.ts).
 * Feste Uhr, Routinen als Objekte, Log-Zeiten als Attrappe. Kein launchctl,
 * kein Versand, kein Import von src/bot.ts.
 */

import { describe, expect, test } from "bun:test";
import { evaluatePunctuality, formatReport } from "../src/health-check";
import { listRoutines } from "../src/lib/routines/catalog";
import { judgeRoutine, lastCalendarSlot, summarizePunctuality, type PunctualDeps } from "../src/lib/routines/punctual";
import type { RoutineRun } from "../src/lib/routines/runs";
import type { LaunchdSchedule } from "../src/lib/routines/schedule";
import type { Routine, RoutineList } from "../src/lib/routines/types";
import { fakeRoutinesDeps, launchctlListOutput, ROOT, scheduledPlist } from "./routines-fixture";

const TZ = "Europe/Berlin";
const MIN = 60_000;
const HOUR = 60 * MIN;
/** Wanduhrzeit in Berlin (Oktober: UTC+2) */
const at = (s: string) => Date.parse(`${s}+02:00`);
/** Nachtcheck am 20.10. um 03:30 */
const NIGHT = at("2026-10-20T03:30:00");

const DAILY_9 = { StartCalendarInterval: { Hour: 9, Minute: 0 } };
const CHECKIN = { StartCalendarInterval: [10, 11, 12, 13, 14, 15, 16, 17, 18].map(Hour => ({ Hour, Minute: 30 })) };

function routine(name: string, schedule: Partial<LaunchdSchedule> | null, extra: Partial<Routine> = {}): Routine {
  return {
    id: `ai.tybo.${name}`,
    name,
    kind: "scheduled",
    schedule: schedule === null ? null : { type: "launchd", otherTriggers: [], ...schedule },
    scheduleText: "x",
    state: "active",
    lastExit: 0,
    logPath: `/Users/alex/tybo/logs/${name}.log`,
    errorLogPath: `/Users/alex/tybo/logs/${name}.error.log`,
    source: "launchd",
    own: true,
    wrapped: true,
    lastRun: null,
    nextRun: null,
    pid: null,
    ...extra,
  };
}

function ran(startedAt: number, extra: Partial<RoutineRun> = {}): RoutineRun {
  return { startedAt: new Date(startedAt).toISOString(), endedAt: new Date(startedAt + 1000).toISOString(), durationMs: 1000, exitCode: 0, tail: [], ...extra };
}

function deps(now: number, logs: Record<string, number> = {}, timeZone = TZ): PunctualDeps {
  return { now, timeZone, mtime: p => logs[p] ?? null };
}

const list = (routines: Routine[], source: RoutineList["source"] = "launchd"): RoutineList => ({ available: source !== null, source, routines, notes: [] });

describe("verpasster Lauf", () => {
  test("um 03:30 bleibt ein gestern verpasster Tageslauf erkennbar", () => {
    const r = routine("morning-briefing", DAILY_9, { lastRun: ran(at("2026-10-18T09:00:01")) });
    expect(judgeRoutine(r, deps(NIGHT))).toEqual({ kind: "missed", due: at("2026-10-19T09:00:00"), evidence: "protocol" });
    const ok = routine("morning-briefing", DAILY_9, { lastRun: ran(at("2026-10-19T09:00:02")) });
    expect(judgeRoutine(ok, deps(NIGHT))).toEqual({ kind: "on-time", evidence: "protocol" });
  });

  test("Toleranz zwei Stunden: erst danach gilt ein Termin als ausgeblieben", () => {
    // Letzter Lauf 10:30, Termin 11:30 nicht wahrgenommen
    const r = routine("smart-checkin", CHECKIN, { lastRun: ran(at("2026-10-19T10:30:00")) });
    expect(judgeRoutine(r, deps(at("2026-10-19T13:29:00"))).kind).toBe("on-time");
    expect(judgeRoutine(r, deps(at("2026-10-19T13:31:00")))).toEqual({ kind: "missed", due: at("2026-10-19T11:30:00"), evidence: "protocol" });
  });

  test("nach dem Ruhezustand nachgeholt zählt als wahrgenommen", () => {
    const r = routine("morning-briefing", DAILY_9, { lastRun: ran(at("2026-10-19T11:42:00")) });
    expect(judgeRoutine(r, deps(NIGHT)).kind).toBe("on-time");
  });

  test("StartInterval: ausgeblieben nach dreimal dem Intervall plus 10 Minuten", () => {
    const r = routine("watcher", { StartInterval: 600 }, { lastRun: ran(at("2026-10-19T12:00:00")) });
    expect(judgeRoutine(r, deps(at("2026-10-19T12:39:00"))).kind).toBe("on-time");
    expect(judgeRoutine(r, deps(at("2026-10-19T12:41:00")))).toEqual({ kind: "missed", due: at("2026-10-19T12:10:00"), evidence: "protocol" });
  });

  test("Report: ⚠️ mit Name und fälligem Termin", () => {
    const s = summarizePunctuality(list([routine("morning-briefing", DAILY_9, { lastRun: ran(at("2026-10-18T09:00:00")) })]), deps(NIGHT));
    const line = formatReport([evaluatePunctuality(s, NIGHT, TZ)], new Date(NIGHT), TZ).split("\n")[1];
    expect(line).toBe("⚠️ Routinen pünktlich: ausgeblieben: morning-briefing (fällig gestern 09:00). /routinen <name> zeigt Zeitplan und Verlauf");
  });
});

describe("Kalender und Intervall zugleich", () => {
  const both = { StartCalendarInterval: { Hour: 9, Minute: 0 }, StartInterval: 600 };

  test("täglich 09:00 plus alle 10 Minuten: letzter Lauf 09:00, um 13:00 ist die Intervallfrist verfehlt", () => {
    const r = routine("sync", both, { lastRun: ran(at("2026-10-20T09:00:00")) });
    expect(judgeRoutine(r, deps(at("2026-10-20T13:00:00")))).toEqual({ kind: "missed", due: at("2026-10-20T09:10:00"), evidence: "protocol" });
  });

  test("beide Fristen gehalten: pünktlich; Kalendertermin verfehlt: ausgeblieben, auch wenn das Intervall passt", () => {
    const fresh = routine("sync", both, { lastRun: ran(at("2026-10-20T12:55:00")) });
    expect(judgeRoutine(fresh, deps(at("2026-10-20T13:00:00")))).toEqual({ kind: "on-time", evidence: "protocol" });
    // Kalender allein gälte als pünktlich (Termin 09:00 wahrgenommen), das Intervall nicht
    const calendarOnly = routine("sync", { StartCalendarInterval: both.StartCalendarInterval }, { lastRun: ran(at("2026-10-20T09:00:00")) });
    expect(judgeRoutine(calendarOnly, deps(at("2026-10-20T13:00:00"))).kind).toBe("on-time");
    // Intervall ungültig: nicht prüfbar statt pünktlich
    const broken = routine("sync", { ...both, StartInterval: "oft" }, { lastRun: ran(at("2026-10-20T09:00:00")) });
    expect(judgeRoutine(broken, deps(at("2026-10-20T10:00:00")))).toEqual({ kind: "unchecked", reason: "Zeitplan nicht auswertbar" });
  });

  test("Report: ⚠️ mit dem Termin der verfehlten Intervallfrist", () => {
    const s = summarizePunctuality(list([routine("sync", both, { lastRun: ran(at("2026-10-20T09:00:00")) })]), deps(at("2026-10-20T13:00:00")));
    expect(evaluatePunctuality(s, at("2026-10-20T13:00:00"), TZ)).toMatchObject({ status: "warn", detail: "ausgeblieben: sync (fällig heute 09:10)" });
  });
});

describe("minütliche und häufige Kalenderpläne", () => {
  test("StartCalendarInterval {} (jede Minute): letzter Termin ist die laufende Minute, schnell berechnet", () => {
    const until = at("2026-10-20T13:37:30");
    const started = performance.now();
    expect(lastCalendarSlot({}, until, TZ)).toBe(at("2026-10-20T13:37:00"));
    expect(lastCalendarSlot([{}], until, TZ)).toBe(at("2026-10-20T13:37:00"));
    expect(lastCalendarSlot({ Hour: 13 }, at("2026-10-20T15:00:00"), TZ)).toBe(at("2026-10-20T13:59:00"));
    expect(lastCalendarSlot({ Minute: 15 }, until, TZ)).toBe(at("2026-10-20T13:15:00"));
    // Kurz nach Mitternacht: die letzte Minute des Vortags
    expect(lastCalendarSlot({}, at("2026-10-20T00:00:00") - 1, TZ)).toBe(at("2026-10-19T23:59:00"));
    // Früher lief hier eine Vorwärtssuche je Minute des Tages (weit über 25 s)
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("Nachtcheck mit einer minütlichen Routine bleibt schnell und erkennt den Ausfall", () => {
    const started = performance.now();
    const r = routine("jede-minute", { StartCalendarInterval: {} }, { lastRun: ran(at("2026-10-19T22:00:00")) });
    expect(judgeRoutine(r, deps(NIGHT))).toEqual({ kind: "missed", due: at("2026-10-20T01:30:00"), evidence: "protocol" });
    const fresh = routine("jede-minute", { StartCalendarInterval: {} }, { lastRun: ran(NIGHT - MIN) });
    expect(judgeRoutine(fresh, deps(NIGHT)).kind).toBe("on-time");
    expect(performance.now() - started).toBeLessThan(2000);
  });

  test("Zeitumstellung: doppelte Stunde zählt beim ersten Mal, fehlende Stunde wie launchd eine Stunde später", () => {
    // 25.10.2026: 03:00 Sommerzeit wird 02:00 Winterzeit, 02:30 gibt es zweimal
    expect(lastCalendarSlot({ Hour: 2, Minute: 30 }, Date.parse("2026-10-25T01:40:00Z"), TZ)).toBe(Date.parse("2026-10-25T00:30:00Z"));
    // 29.3.2026: 02:00 Winterzeit wird 03:00 Sommerzeit, 02:30 fällt auf 03:30
    expect(lastCalendarSlot({ Hour: 2, Minute: 30 }, Date.parse("2026-03-29T01:20:00Z"), TZ)).toBe(Date.parse("2026-03-28T01:30:00Z"));
    expect(lastCalendarSlot({ Hour: 2, Minute: 30 }, Date.parse("2026-03-29T01:40:00Z"), TZ)).toBe(Date.parse("2026-03-29T01:30:00Z"));
  });

  test("jährliche Termine im Suchfenster, nie eintretende sind nicht auswertbar", () => {
    expect(lastCalendarSlot({ Month: 11, Day: 1, Hour: 6, Minute: 0 }, NIGHT, TZ)).toBe(Date.parse("2025-11-01T05:00:00Z"));
    expect(lastCalendarSlot({ Month: 2, Day: 30, Hour: 6, Minute: 0 }, NIGHT, TZ)).toBe("invalid");
    expect(lastCalendarSlot([], NIGHT, TZ)).toBe("invalid");
  });

  test("Liste mit einem nicht auswertbaren Eintrag: nicht auswertbar, der gültige Eintrag daneben verdeckt das nicht", () => {
    const mixed = [{ Hour: 9, Minute: 0 }, { Day: 1, Weekday: 1, Hour: 6, Minute: 0 }];
    expect(lastCalendarSlot(mixed, NIGHT, TZ)).toBe("invalid");
    expect(lastCalendarSlot([{ Hour: 9, Minute: 0 }, { Month: 2, Day: 30, Hour: 6, Minute: 0 }], NIGHT, TZ)).toBe("invalid");
    // Mit passendem Laufprotokoll für den 09:00-Termin trotzdem ⚠️ statt pünktlich
    const r = routine("gemischt", { StartCalendarInterval: mixed }, { lastRun: ran(at("2026-10-19T09:00:01")) });
    expect(judgeRoutine(r, deps(NIGHT))).toEqual({ kind: "unchecked", reason: "Zeitplan nicht auswertbar" });
    const result = evaluatePunctuality(summarizePunctuality(list([r]), deps(NIGHT)), NIGHT, TZ);
    expect(result).toMatchObject({ status: "warn", detail: "nicht prüfbar: gemischt (Zeitplan nicht auswertbar)" });
  });

  test("29.2.: der letzte Termin vor über einem Jahr wird gefunden, ein alter Lauf davor ist kein Nachweis", () => {
    const leap = { StartCalendarInterval: { Month: 2, Day: 29, Hour: 9, Minute: 0 } };
    const now = at("2026-10-20T03:30:00");
    expect(lastCalendarSlot(leap.StartCalendarInterval, now, TZ)).toBe(Date.parse("2024-02-29T08:00:00Z"));
    const r = routine("schalttag", leap, { lastRun: ran(Date.parse("2024-02-28T08:00:00Z")) });
    expect(judgeRoutine(r, deps(now))).toEqual({ kind: "missed", due: Date.parse("2024-02-29T08:00:00Z"), evidence: "protocol" });
    const line = formatReport([evaluatePunctuality(summarizePunctuality(list([r]), deps(now)), now, TZ)], new Date(now), TZ).split("\n")[1];
    expect(line).toBe("⚠️ Routinen pünktlich: ausgeblieben: schalttag (fällig Do 29.2.2024 09:00). /routinen <name> zeigt Zeitplan und Verlauf");
    const ok = routine("schalttag", leap, { lastRun: ran(Date.parse("2024-02-29T08:00:05Z")) });
    expect(judgeRoutine(ok, deps(now)).kind).toBe("on-time");
  });

  test("letzter Termin älter als das Suchfenster: nicht prüfbar, nie pünktlich", () => {
    // Zwischen 2096 und 2104 fällt der 29.2. aus (2100 ist kein Schaltjahr)
    const leap = { StartCalendarInterval: { Month: 2, Day: 29, Hour: 9, Minute: 0 } };
    const now = Date.parse("2103-10-20T01:30:00Z");
    expect(lastCalendarSlot(leap.StartCalendarInterval, now, TZ)).toBeNull();
    const r = routine("schalttag", leap, { lastRun: ran(Date.parse("2090-01-01T08:00:00Z")) });
    expect(judgeRoutine(r, deps(now))).toEqual({ kind: "unchecked", reason: "letzter Termin außerhalb des Suchfensters" });
    const result = evaluatePunctuality(summarizePunctuality(list([r]), deps(now)), now, TZ);
    expect(result).toMatchObject({ status: "warn", detail: "nicht prüfbar: schalttag (letzter Termin außerhalb des Suchfensters)" });
  });
});

describe("Ruhezeit und Zeitzone", () => {
  test("Termine in der Ruhezeit des Nutzers zählen: launchd startet trotzdem, der stille Lauf steht im Protokoll", () => {
    const late = { StartCalendarInterval: { Hour: 23, Minute: 0 } };
    const silent = routine("nightly", late, { lastRun: ran(at("2026-10-19T23:00:00"), { tail: ["Ruhezeit, keine Meldung"] }) });
    expect(judgeRoutine(silent, deps(at("2026-10-20T03:30:00"))).kind).toBe("on-time");
    const missing = routine("nightly", late, { lastRun: ran(at("2026-10-18T23:00:00")) });
    expect(judgeRoutine(missing, deps(at("2026-10-20T03:30:00")))).toEqual({ kind: "missed", due: at("2026-10-19T23:00:00"), evidence: "protocol" });
  });

  test("Check-in nur tagsüber: in der Nacht wird kein Lauf erwartet", () => {
    const r = routine("smart-checkin", CHECKIN, { lastRun: ran(at("2026-10-19T18:30:00")) });
    expect(judgeRoutine(r, deps(NIGHT)).kind).toBe("on-time");
  });

  test("Termine gelten in der Zeitzone des Systems, nicht in USER_TIMEZONE", () => {
    const saved = process.env.USER_TIMEZONE;
    process.env.USER_TIMEZONE = "Asia/Tokyo";
    try {
      const until = Date.parse("2026-10-20T12:00:00Z");
      expect(lastCalendarSlot(DAILY_9.StartCalendarInterval, until, "Europe/Berlin")).toBe(Date.parse("2026-10-20T07:00:00Z"));
      expect(lastCalendarSlot(DAILY_9.StartCalendarInterval, until, "America/New_York")).toBe(Date.parse("2026-10-19T13:00:00Z"));
    } finally {
      if (saved === undefined) delete process.env.USER_TIMEZONE;
      else process.env.USER_TIMEZONE = saved;
    }
  });

  test("monatliche Termine findet das größere Suchfenster", () => {
    expect(lastCalendarSlot({ Day: 1, Hour: 6, Minute: 0 }, NIGHT, TZ)).toBe(at("2026-10-01T06:00:00"));
    expect(lastCalendarSlot({ Day: 1, Weekday: 1, Hour: 6, Minute: 0 }, NIGHT, TZ)).toBe("invalid");
  });
});

describe("pausierte und laufende Routinen", () => {
  test("pausiert oder nicht geladen: kein Ausfall, im Report nur gezählt", () => {
    const old = ran(at("2026-09-01T09:00:00"));
    const paused = routine("morning-briefing", DAILY_9, { state: "paused", lastRun: old });
    const unloaded = routine("smart-checkin", CHECKIN, { state: "not-loaded", lastRun: old });
    expect(judgeRoutine(paused, deps(NIGHT))).toEqual({ kind: "exempt", paused: true });
    const s = summarizePunctuality(list([paused, unloaded, routine("health-check", { StartCalendarInterval: { Hour: 3, Minute: 30 } }, { lastRun: ran(at("2026-10-19T03:30:00")) })]), deps(NIGHT));
    expect(s.missed).toEqual([]);
    expect(s.paused).toEqual(["morning-briefing", "smart-checkin"]);
    expect(evaluatePunctuality(s, NIGHT, TZ)).toEqual({ name: "Routinen pünktlich", status: "ok", detail: "1 pünktlich, 2 pausiert oder nicht geladen" });
  });

  test("nur pausierte: –", () => {
    const s = summarizePunctuality(list([routine("morning-briefing", DAILY_9, { state: "paused" })]), deps(NIGHT));
    expect(evaluatePunctuality(s, NIGHT, TZ)).toEqual({ name: "Routinen pünktlich", status: "na", detail: "keine aktive zeitgesteuerte Routine, 1 pausiert oder nicht geladen" });
  });

  test("läuft gerade (PID laut launchctl): nie ausgeblieben, wie alt der letzte Lauf auch ist", () => {
    const r = routine("morning-briefing", DAILY_9, { pid: 4242, lastRun: ran(at("2026-10-10T09:00:00")) });
    expect(judgeRoutine(r, deps(NIGHT))).toEqual({ kind: "running" });
    const s = summarizePunctuality(list([r]), deps(NIGHT));
    expect(evaluatePunctuality(s, NIGHT, TZ).detail).toBe("0 pünktlich, 1 läuft gerade");
  });

  test("Dauerdienste und Routinen ohne Zeitplan zählen nicht", () => {
    const daemon = routine("telegram-relay", { KeepAlive: true }, { kind: "daemon", state: "running" });
    const atLoad = routine("einmal", { RunAtLoad: true });
    const s = summarizePunctuality(list([daemon, atLoad]), deps(NIGHT));
    expect(s.checked).toBe(0);
    expect(s.paused).toEqual([]);
  });
});

describe("Log-Rückfall und fehlende Daten", () => {
  const log = "/Users/alex/tybo/logs/morning-briefing.log";
  const errLog = "/Users/alex/tybo/logs/morning-briefing.error.log";

  test("ohne Protokoll zählt die jüngste Änderung der Logs", () => {
    const r = routine("morning-briefing", DAILY_9, { wrapped: false });
    expect(judgeRoutine(r, deps(NIGHT, { [log]: at("2026-10-18T09:00:03"), [errLog]: at("2026-10-19T09:00:04") }))).toEqual({ kind: "on-time", evidence: "log" });
    expect(judgeRoutine(r, deps(NIGHT, { [log]: at("2026-10-18T09:00:03") }))).toEqual({ kind: "missed", due: at("2026-10-19T09:00:00"), evidence: "log" });
    const s = summarizePunctuality(list([r]), deps(NIGHT, { [log]: at("2026-10-18T09:00:03") }));
    expect(evaluatePunctuality(s, NIGHT, TZ)).toMatchObject({
      detail: "ausgeblieben: morning-briefing (fällig gestern 09:00, laut Log)",
      hint: "ohne Verlauf zählt nur das Log; genauer nach tybo routinen einbinden <label>",
    });
  });

  test("Protokoll hat Vorrang vor einem frischen Log", () => {
    const r = routine("morning-briefing", DAILY_9, { lastRun: ran(at("2026-10-18T09:00:00")) });
    expect(judgeRoutine(r, deps(NIGHT, { [log]: at("2026-10-20T01:00:00") }))).toEqual({ kind: "missed", due: at("2026-10-19T09:00:00"), evidence: "protocol" });
  });

  test("eingebunden, aber noch kein Protokoll: Log zählt", () => {
    const r = routine("morning-briefing", DAILY_9);
    expect(judgeRoutine(r, deps(NIGHT, { [log]: at("2026-10-19T09:00:03") }))).toEqual({ kind: "on-time", evidence: "log" });
  });

  test("keine Spur, unlesbarer oder ungültiger Zeitplan, unbekannter Zustand: nicht prüfbar, nie pünktlich", () => {
    const routines = [
      routine("ohne-spur", DAILY_9),
      routine("ohne-plist", null),
      routine("doppelt", { StartCalendarInterval: { Day: 1, Weekday: 1, Hour: 6, Minute: 0 } }, { lastRun: ran(NIGHT - HOUR) }),
      routine("intervall-kaputt", { StartInterval: "oft" }, { lastRun: ran(NIGHT - HOUR) }),
      routine("unklar", DAILY_9, { state: "unknown", lastRun: ran(NIGHT - HOUR) }),
    ];
    const s = summarizePunctuality(list(routines), deps(NIGHT));
    expect(s.unchecked).toEqual([
      { name: "ohne-spur", reason: "kein Lauf belegt" },
      { name: "ohne-plist", reason: "Zeitplan nicht lesbar" },
      { name: "doppelt", reason: "Zeitplan nicht auswertbar" },
      { name: "intervall-kaputt", reason: "Zeitplan nicht auswertbar" },
      { name: "unklar", reason: "Zustand unbekannt" },
    ]);
    const result = evaluatePunctuality(s, NIGHT, TZ);
    expect(result.status).toBe("warn");
    expect(result.detail).toStartWith("nicht prüfbar: ohne-spur (kein Lauf belegt), ohne-plist (Zeitplan nicht lesbar)");
  });

  test("Hinweise der Übersicht: LaunchAgents unlesbar heißt nicht prüfbar, nicht „keine Routine“", async () => {
    const l = await listRoutines(fakeRoutinesDeps({ listDirThrows: true, now: NIGHT, timeZone: TZ }));
    expect(l).toMatchObject({ available: true, source: "launchd", routines: [] });
    const s = summarizePunctuality(l, deps(NIGHT));
    expect(s.notes).toEqual(["Der Ordner LaunchAgents ist nicht lesbar."]);
    expect(evaluatePunctuality(s, NIGHT, TZ)).toEqual({
      name: "Routinen pünktlich",
      status: "warn",
      detail: "nicht prüfbar: Der Ordner LaunchAgents ist nicht lesbar",
      hint: "tybo routinen zeigt die Übersicht mit allen Hinweisen",
    });
  });

  describe("Teilergebnis grün, Übersicht unvollständig: ⚠️ statt ✅", () => {
    const plists = { "ai.tybo.health-check.plist": scheduledPlist("ai.tybo.health-check") };
    const launchctlList = launchctlListOutput([["-", "0", "ai.tybo.health-check"]]);
    // Letzter Termin 19.10. 03:30 laut Log wahrgenommen
    const logs = { [`${ROOT}/logs/ai.tybo.health-check.log`]: at("2026-10-19T03:30:05") };
    const judge = async (extra: Parameters<typeof fakeRoutinesDeps>[0]) =>
      evaluatePunctuality(summarizePunctuality(await listRoutines(fakeRoutinesDeps({ plists, launchctlList, now: NIGHT, timeZone: TZ, ...extra })), deps(NIGHT, logs)), NIGHT, TZ);

    test("vollständig: grün", async () => {
      expect(await judge({})).toEqual({ name: "Routinen pünktlich", status: "ok", detail: "1 pünktlich" });
    });

    test("konfigurierter Dienst fehlt", async () => {
      expect(await judge({ config: JSON.stringify({ labels: ["com.example.backup"] }) })).toMatchObject({
        status: "warn",
        detail: "1 pünktlich; unvollständig: Aus config/routines.json nicht gefunden: com.example.backup",
      });
    });

    test("ungültige Konfiguration", async () => {
      const result = await judge({ config: "{ kaputt" });
      expect(result.status).toBe("warn");
      expect(result.detail).toBe("1 pünktlich; unvollständig: config/routines.json ist kein gültiges JSON und wird ignoriert");
    });

    test("launchctl gescheitert, dazu ein Ausfall: beides in der Zeile", async () => {
      const result = await judge({ printDisabled: null });
      expect(result.status).toBe("warn");
      expect(result.detail).toContain("unvollständig: launchctl print-disabled ist gescheitert");
      const late = { [`${ROOT}/logs/ai.tybo.health-check.log`]: at("2026-10-18T03:30:05") };
      const l = await listRoutines(fakeRoutinesDeps({ plists, launchctlList, config: "{ kaputt", now: NIGHT, timeZone: TZ }));
      const both = evaluatePunctuality(summarizePunctuality(l, deps(NIGHT, late)), NIGHT, TZ);
      expect(both.detail).toBe("ausgeblieben: health-check (fällig gestern 03:30, laut Log); unvollständig: config/routines.json ist kein gültiges JSON und wird ignoriert");
    });
  });

  test("ohne launchd (PM2, keine Übersicht): –", () => {
    expect(evaluatePunctuality(summarizePunctuality(list([], "pm2"), deps(NIGHT)), NIGHT, TZ)).toEqual({ name: "Routinen pünktlich", status: "na", detail: "nur mit launchd (macOS)" });
    expect(evaluatePunctuality(summarizePunctuality(list([], null), deps(NIGHT)), NIGHT, TZ).status).toBe("na");
  });
});

describe("Watchdog entfernt", () => {
  test("Skript, Vorlage und package.json-Eintrag sind weg; der Absender bleibt für alte Meldungen", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const root = join(import.meta.dir, "..");
    expect(existsSync(join(root, "src", "watchdog.ts"))).toBe(false);
    expect(existsSync(join(root, "launchd", "ai.tybo.watchdog.plist.template"))).toBe(false);
    expect(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts.watchdog).toBeUndefined();
    const { SERVICE_NAMES: launchdServices } = await import("../src/lib/services/catalog");
    const { PM2_SERVICES } = await import("../src/setup/services/pm2");
    expect([...launchdServices, ...PM2_SERVICES]).not.toContain("watchdog");
    expect(readFileSync(join(root, "src", "web", "push-triggers.ts"), "utf8")).toContain('watchdog: "Watchdog"');
  });
});
