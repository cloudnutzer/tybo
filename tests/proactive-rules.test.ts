/**
 * Kern der proaktiven Meldungen (Issue #361): Zeitfenster, Ruhezeit,
 * Mindestabstand, Snooze, einmal je Tag. Uhr-Attrappe: jede Prüfung bekommt
 * ihren Zeitpunkt, nichts liest die echte Uhr.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { clockMinutes, formatClock, localMoment, proactiveTimeZone, withinSpan } from "../src/lib/proactive/clock";
import { PROACTIVE_DEFAULTS, proactiveConfig, type KindConfig } from "../src/lib/proactive/config";
import { judgeKind, type KindRecord } from "../src/lib/proactive/rules";
import { settingsSchema } from "../src/lib/settings";

const DEFAULTS = proactiveConfig({});

function judge(at: string, kind: KindConfig, record: KindRecord = {}, zone = "UTC", quietHours = DEFAULTS.quietHours) {
  return judgeKind({ now: new Date(at), zone, quietHours, kind, record });
}
const reason = (v: ReturnType<typeof judge>) => (v.send ? "send" : v.reason);

describe("Uhrzeit", () => {
  test("HH:MM wird gelesen und geschrieben", () => {
    expect(clockMinutes("00:00")).toBe(0);
    expect(clockMinutes("23:59")).toBe(1439);
    expect(clockMinutes("24:00")).toBeNull();
    expect(clockMinutes("9:00")).toBeNull();
    expect(formatClock(570)).toBe("09:30");
    expect(formatClock(1440 + 90)).toBe("01:30");
    expect(formatClock(-30)).toBe("23:30");
  });

  test("Zeitraum mit Grenzen: von einschließlich, bis ausschließlich", () => {
    const span = { from: "10:00", to: "19:00" };
    expect(withinSpan(599, span)).toBe(false);
    expect(withinSpan(600, span)).toBe(true);
    expect(withinSpan(1139, span)).toBe(true);
    expect(withinSpan(1140, span)).toBe(false);
  });

  test("Zeitraum über Mitternacht", () => {
    const span = { from: "21:00", to: "08:00" };
    expect(withinSpan(clockMinutes("20:59")!, span)).toBe(false);
    expect(withinSpan(clockMinutes("21:00")!, span)).toBe(true);
    expect(withinSpan(clockMinutes("00:00")!, span)).toBe(true);
    expect(withinSpan(clockMinutes("07:59")!, span)).toBe(true);
    expect(withinSpan(clockMinutes("08:00")!, span)).toBe(false);
  });

  test("leerer oder kaputter Zeitraum enthält nichts", () => {
    expect(withinSpan(600, { from: "10:00", to: "10:00" })).toBe(false);
    expect(withinSpan(600, { from: "kaputt", to: "11:00" })).toBe(false);
  });

  test("Ortszeit in verschiedenen Zonen für denselben Zeitpunkt", () => {
    const at = new Date("2026-10-19T22:30:00Z");
    expect(localMoment(at, "UTC")).toEqual({ date: "2026-10-19", minutes: 22 * 60 + 30 });
    expect(localMoment(at, "Europe/Berlin")).toEqual({ date: "2026-10-20", minutes: 30 });
    expect(localMoment(at, "America/New_York")).toEqual({ date: "2026-10-19", minutes: 18 * 60 + 30 });
  });

  describe("Zeitzone aus USER_TIMEZONE", () => {
    let log: ReturnType<typeof spyOn> | undefined;
    afterEach(() => log?.mockRestore());

    test("ohne Angabe UTC, gültige Zone bleibt", () => {
      expect(proactiveTimeZone({})).toBe("UTC");
      expect(proactiveTimeZone({ USER_TIMEZONE: " Europe/Berlin " })).toBe("Europe/Berlin");
    });

    test("ungültige Zone: UTC und nur einmal ins Log", () => {
      log = spyOn(console, "log").mockImplementation(() => {});
      expect(proactiveTimeZone({ USER_TIMEZONE: "Mars/Olympus" })).toBe("UTC");
      expect(proactiveTimeZone({ USER_TIMEZONE: "Mars/Olympus" })).toBe("UTC");
      const lines = log.mock.calls.map(c => String(c[0])).filter(l => l.includes("Mars/Olympus"));
      expect(lines).toHaveLength(1);
    });
  });
});

describe("Regeln", () => {
  const checkin = DEFAULTS.checkin;
  const briefing = DEFAULTS.briefing;

  test("Check-in: exakte Grenzen des Zeitfensters 10:00 bis 19:00", () => {
    expect(reason(judge("2026-10-19T09:59:00Z", checkin))).toBe("window");
    expect(reason(judge("2026-10-19T10:00:00Z", checkin))).toBe("send");
    expect(reason(judge("2026-10-19T18:59:00Z", checkin))).toBe("send");
    expect(reason(judge("2026-10-19T19:00:00Z", checkin))).toBe("window");
  });

  test("Briefing und Check-in haben getrennte Zeitfenster", () => {
    // 09:30: nur das Briefing, 15:00: nur der Check-in
    expect(reason(judge("2026-10-19T09:30:00Z", briefing))).toBe("send");
    expect(reason(judge("2026-10-19T09:30:00Z", checkin))).toBe("window");
    expect(reason(judge("2026-10-19T15:00:00Z", briefing))).toBe("window");
    expect(reason(judge("2026-10-19T15:00:00Z", checkin))).toBe("send");
  });

  test("Ruhezeit über Mitternacht geht vor jedem Zeitfenster", () => {
    const allDay = { ...checkin, window: { from: "00:00", to: "23:59" } };
    expect(reason(judge("2026-10-19T20:59:00Z", allDay))).toBe("send");
    expect(reason(judge("2026-10-19T21:00:00Z", allDay))).toBe("quiet");
    expect(reason(judge("2026-10-20T00:00:00Z", allDay))).toBe("quiet");
    expect(reason(judge("2026-10-20T07:59:00Z", allDay))).toBe("quiet");
    expect(reason(judge("2026-10-20T08:00:00Z", allDay))).toBe("send");
  });

  test("Zeitfenster über Mitternacht", () => {
    const night = { ...checkin, window: { from: "22:00", to: "02:00" } };
    const quiet = { from: "03:00", to: "06:00" };
    expect(reason(judge("2026-10-19T21:59:00Z", night, {}, "UTC", quiet))).toBe("window");
    expect(reason(judge("2026-10-19T23:00:00Z", night, {}, "UTC", quiet))).toBe("send");
    expect(reason(judge("2026-10-20T01:59:00Z", night, {}, "UTC", quiet))).toBe("send");
    expect(reason(judge("2026-10-20T02:00:00Z", night, {}, "UTC", quiet))).toBe("window");
  });

  test("Zeitzone: dasselbe Zeitfenster nach Ortszeit", () => {
    // 08:30Z ist in Berlin (Sommerzeit) 10:30, in New York 04:30
    expect(reason(judge("2026-07-01T08:30:00Z", checkin, {}, "UTC"))).toBe("window");
    expect(reason(judge("2026-07-01T08:30:00Z", checkin, {}, "Europe/Berlin"))).toBe("send");
    expect(reason(judge("2026-07-01T08:30:00Z", checkin, {}, "America/New_York"))).toBe("quiet");
  });

  test("Briefing einmal je Ortsdatum, neuer Tag nach Mitternacht", () => {
    const late = { ...briefing, window: { from: "23:00", to: "01:00" } };
    const quiet = { from: "03:00", to: "04:00" };
    const sent: KindRecord = { lastSentAt: "2026-10-19T23:10:00Z", lastDate: "2026-10-19" };
    expect(reason(judge("2026-10-19T23:50:00Z", late, sent, "UTC", quiet))).toBe("done-today");
    expect(reason(judge("2026-10-20T00:10:00Z", late, sent, "UTC", quiet))).toBe("send");
  });

  test("Briefing: Tag nach Ortszeit, nicht nach UTC", () => {
    // 2026-10-19T23:30Z ist in Berlin schon der 20.
    const record: KindRecord = { lastDate: "2026-10-19" };
    const allDay = { ...briefing, window: { from: "00:00", to: "23:59" } };
    const quiet = { from: "03:00", to: "04:00" };
    expect(reason(judge("2026-10-19T23:30:00Z", allDay, record, "UTC", quiet))).toBe("done-today");
    expect(reason(judge("2026-10-19T23:30:00Z", allDay, record, "Europe/Berlin", quiet))).toBe("send");
  });

  test("Mindestabstand: genau der Abstand reicht", () => {
    const record: KindRecord = { lastSentAt: "2026-10-19T12:00:00.000Z" };
    expect(reason(judge("2026-10-19T13:29:59.999Z", checkin, record))).toBe("gap");
    expect(reason(judge("2026-10-19T13:30:00.000Z", checkin, record))).toBe("send");
  });

  test("Mindestabstand über Mitternacht", () => {
    const night = { ...checkin, window: { from: "22:00", to: "02:00" } };
    const quiet = { from: "03:00", to: "06:00" };
    const record: KindRecord = { lastSentAt: "2026-10-19T23:30:00Z", lastDate: "2026-10-19" };
    expect(reason(judge("2026-10-20T00:30:00Z", night, record, "UTC", quiet))).toBe("gap");
    expect(reason(judge("2026-10-20T01:00:00Z", night, record, "UTC", quiet))).toBe("send");
  });

  test("Sommerzeit-Ende: Mindestabstand ist echte Dauer, nicht Wanduhr", () => {
    // Berlin 25.10.2026: 03:00 Sommerzeit wird 02:00 Winterzeit
    const night = { ...checkin, window: { from: "00:00", to: "06:00" } };
    const quiet = { from: "12:00", to: "13:00" };
    const record: KindRecord = { lastSentAt: "2026-10-25T00:30:00Z" }; // 02:30 Sommerzeit
    // 01:45Z = 02:45 Winterzeit: Wanduhr nur 15 Minuten weiter, echt 75 Minuten
    expect(reason(judge("2026-10-25T01:45:00Z", night, record, "Europe/Berlin", quiet))).toBe("gap");
    // 02:00Z = 03:00 Winterzeit: echt 90 Minuten
    expect(reason(judge("2026-10-25T02:00:00Z", night, record, "Europe/Berlin", quiet))).toBe("send");
  });

  test("Sommerzeit: Zeitfenster folgt der Wanduhr vor und nach der Umstellung", () => {
    // 09:00 Ortszeit ist am 24.10. 07:00Z, am 25.10. 08:00Z
    expect(reason(judge("2026-10-24T07:00:00Z", briefing, {}, "Europe/Berlin"))).toBe("send");
    expect(reason(judge("2026-10-25T07:00:00Z", briefing, {}, "Europe/Berlin"))).toBe("window");
    expect(reason(judge("2026-10-25T08:00:00Z", briefing, {}, "Europe/Berlin"))).toBe("send");
    // Sommerzeit-Beginn 29.03.2026: 09:00 Ortszeit ist 07:00Z, am Vortag 08:00Z
    expect(reason(judge("2026-03-28T07:30:00Z", briefing, {}, "Europe/Berlin"))).toBe("window");
    expect(reason(judge("2026-03-29T07:00:00Z", briefing, {}, "Europe/Berlin"))).toBe("send");
  });

  test("Snooze bis ausschließlich", () => {
    const record: KindRecord = { snoozedUntil: "2026-10-19T12:30:00.000Z" };
    expect(reason(judge("2026-10-19T12:29:59.999Z", checkin, record))).toBe("snoozed");
    expect(reason(judge("2026-10-19T12:30:00.000Z", checkin, record))).toBe("send");
  });

  test("Snooze und Abstand gelten nur für ihre Art", () => {
    // Der Datensatz des Check-ins trifft das Briefing nicht: jede Art hat ihren eigenen
    const checkinRecord: KindRecord = { snoozedUntil: "2026-10-19T11:00:00Z", lastSentAt: "2026-10-19T09:15:00Z" };
    expect(reason(judge("2026-10-19T09:30:00Z", { ...checkin, window: { from: "09:00", to: "19:00" } }, checkinRecord))).toBe("snoozed");
    expect(reason(judge("2026-10-19T09:30:00Z", briefing, {}))).toBe("send");
    // Briefing hat keinen Mindestabstand, nur einmal je Tag
    expect(reason(judge("2026-10-19T09:30:00Z", briefing, { lastSentAt: "2026-10-18T09:29:00Z", lastDate: "2026-10-18" }))).toBe("send");
  });

  test("abgeschaltet geht vor allem", () => {
    expect(reason(judge("2026-10-19T12:00:00Z", { ...checkin, enabled: false }))).toBe("disabled");
  });

  test("kaputte Zeitangaben im Zustand blockieren nicht", () => {
    expect(reason(judge("2026-10-19T12:00:00Z", checkin, { lastSentAt: "gestern", snoozedUntil: "bald" }))).toBe("send");
  });
});

describe("Einstellungen", () => {
  test("Standards: neun Check-in-Termine, 90 Minuten, Ruhezeit 21 bis 8", () => {
    expect(DEFAULTS.checkin.times).toHaveLength(9);
    expect(DEFAULTS.checkin.minGapMinutes).toBe(90);
    expect(DEFAULTS.quietHours).toEqual({ from: "21:00", to: "08:00" });
    expect(DEFAULTS.briefing.window).toEqual({ from: "09:00", to: "12:00" });
  });

  test("Datei vor Standard, Feld für Feld", () => {
    const config = proactiveConfig({ proactive: { checkin: { minGapMinutes: 30 }, briefing: { enabled: false } } });
    expect(config.checkin.minGapMinutes).toBe(30);
    expect(config.checkin.window).toEqual(PROACTIVE_DEFAULTS.checkin.window);
    expect(config.briefing.enabled).toBe(false);
    expect(config.briefing.window).toEqual(PROACTIVE_DEFAULTS.briefing.window);
  });

  test("Standards lassen sich nicht über das Ergebnis verändern", () => {
    proactiveConfig({}).checkin.times.push("20:00");
    proactiveConfig({}).quietHours.from = "00:00";
    expect(proactiveConfig({}).checkin.times).toHaveLength(9);
    expect(proactiveConfig({}).quietHours.from).toBe("21:00");
  });

  test("Schema prüft Uhrzeiten, Grenzen und Startzeiten", () => {
    const ok = (proactive: unknown) => settingsSchema.safeParse({ proactive }).success;
    expect(ok({ quietHours: { from: "22:00", to: "07:00" } })).toBe(true);
    expect(ok({ quietHours: { from: "22:00", to: "22:00" } })).toBe(false);
    expect(ok({ briefing: { window: { from: "9:00", to: "12:00" } } })).toBe(false);
    expect(ok({ checkin: { times: ["10:30", "10:30"] } })).toBe(false);
    // [] heißt ausdrücklich keine Termine
    expect(ok({ checkin: { times: [] } })).toBe(true);
    expect(ok({ checkin: { minGapMinutes: 1441 } })).toBe(false);
    expect(ok({ checkin: { minGapMinutes: 1.5 } })).toBe(false);
  });
});
