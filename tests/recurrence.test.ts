/**
 * Issue #321: Wiederholungen (src/lib/recurrence.ts) in der Zeitzone des
 * Nutzers, über beide Zeitumstellungen. Europe/Berlin 2026: die Uhr springt
 * am 29.3. um 2 Uhr auf 3 Uhr vor und wird am 25.10. um 3 Uhr auf 2 Uhr
 * zurückgestellt.
 *
 * Regeln: täglich, werktags und wöchentlich halten dieselbe Ortszeit
 * (über eine Umstellung also 23 bzw. 25 echte Stunden); alle n Stunden sind
 * echte Dauer. Werktage sind Montag bis Freitag in der Zeitzone des Nutzers,
 * Feiertage zählen mit. Eine Ortszeit in der Lücke rückt um die Lücke nach
 * vorn, eine doppelte Ortszeit gilt beim ersten Mal (wie parseWhen in
 * src/lib/when.ts); am nächsten Tag gilt wieder die ursprüngliche Uhrzeit.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { anchorRecurrence, formatRecurrence, nextDue, parseRecurrence } from "../src/lib/recurrence";

const BERLIN = { timeZone: "Europe/Berlin" };
const d = (iso: string) => new Date(iso);
/** Nächster Termin als ISO, Uhr steht auf dem vorigen Termin */
const next = (rule: string, previous: string, options: { now?: string; timeZone?: string } = BERLIN) => {
  const parsed = parseRecurrence(rule);
  if (!parsed) throw new Error(`Regel ${rule} ungültig`);
  const result = nextDue(parsed, d(previous), { timeZone: options.timeZone ?? BERLIN.timeZone, now: d(options.now ?? previous) });
  return result?.toISOString();
};

describe("parseRecurrence und formatRecurrence", () => {
  test("die vier Formen, auch mit anderer Schreibweise", () => {
    expect(parseRecurrence("daily 08:00")).toEqual({ every: "day", hour: 8, minute: 0 });
    expect(parseRecurrence("  Daily   8:05 ")).toEqual({ every: "day", hour: 8, minute: 5 });
    expect(parseRecurrence("weekdays 07:30")).toEqual({ every: "weekday", hour: 7, minute: 30 });
    expect(parseRecurrence("weekly sun 09:00")).toEqual({ every: "week", weekday: 0, hour: 9, minute: 0 });
    expect(parseRecurrence("weekly FRI 23:59")).toEqual({ every: "week", weekday: 5, hour: 23, minute: 59 });
    expect(parseRecurrence("every 2h")).toEqual({ every: "hours", hours: 2 });
    expect(parseRecurrence("every 168h")).toEqual({ every: "hours", hours: 168 });
    expect(parseRecurrence("every 169h")).toEqual({ every: "hours", hours: 169 });
    expect(parseRecurrence("every 240h")).toEqual({ every: "hours", hours: 240 });
    expect(parseRecurrence("every 8760h")).toEqual({ every: "hours", hours: 8760 });
  });

  test("Ausgabe ist die kanonische Form und lässt sich wieder lesen", () => {
    for (const text of ["daily 08:00", "weekdays 07:30", "weekly sun 09:00", "every 2h"]) {
      expect(formatRecurrence(parseRecurrence(text)!)).toBe(text);
    }
    expect(formatRecurrence(parseRecurrence("daily 8:05")!)).toBe("daily 08:05");
  });

  test("ungültig: null", () => {
    for (const text of [
      "",
      "manchmal",
      "daily",
      "daily 24:00",
      "daily 08:60",
      "daily 8",
      "weekly 09:00",
      "weekly xyz 09:00",
      "every 0h",
      "every -1h",
      "every 1.5h",
      "every 99999999999999999999h",
      "every h",
      "every 2m",
      "every 2 h extra",
      "constructor",
    ]) {
      expect(parseRecurrence(text)).toBeNull();
    }
    expect(parseRecurrence(undefined as unknown as string)).toBeNull();
  });
});

describe("täglich: gleiche Ortszeit", () => {
  test("über den Frühjahrswechsel: 23 echte Stunden", () => {
    // 28.3. 08:00 MEZ (07:00Z) -> 29.3. 08:00 MESZ (06:00Z)
    expect(next("daily 08:00", "2026-03-28T07:00:00.000Z")).toBe("2026-03-29T06:00:00.000Z");
  });

  test("über den Herbstwechsel: 25 echte Stunden", () => {
    // 24.10. 08:00 MESZ (06:00Z) -> 25.10. 08:00 MEZ (07:00Z)
    expect(next("daily 08:00", "2026-10-24T06:00:00.000Z")).toBe("2026-10-25T07:00:00.000Z");
  });

  test("Ortszeit in der Lücke: rückt vor, am Tag danach wieder die ursprüngliche Uhrzeit", () => {
    // 28.3. 02:30 MEZ (01:30Z) -> 29.3. 02:30 gibt es nicht, also 03:30 MESZ (01:30Z)
    const gapDay = next("daily 02:30", "2026-03-28T01:30:00.000Z");
    expect(gapDay).toBe("2026-03-29T01:30:00.000Z");
    // 30.3. wieder 02:30, jetzt MESZ (00:30Z), nicht 03:30
    expect(next("daily 02:30", gapDay!)).toBe("2026-03-30T00:30:00.000Z");
  });

  test("doppelte Ortszeit: das erste Mal zählt, kein zweiter Termin am selben Tag", () => {
    // 24.10. 02:30 MESZ (00:30Z) -> 25.10. 02:30 MESZ, das erste Mal (00:30Z)
    const doubled = next("daily 02:30", "2026-10-24T00:30:00.000Z");
    expect(doubled).toBe("2026-10-25T00:30:00.000Z");
    // Danach nicht die zweite 02:30 (01:30Z), sondern der 26.10. 02:30 MEZ
    expect(next("daily 02:30", doubled!)).toBe("2026-10-26T01:30:00.000Z");
  });

  test("verpasste Tage werden nicht nachgeholt: der nächste nach jetzt", () => {
    expect(next("daily 08:00", "2026-10-10T06:00:00.000Z", { now: "2026-10-17T12:00:00.000Z" })).toBe("2026-10-18T06:00:00.000Z");
    // jetzt vor der heutigen Uhrzeit: heute
    expect(next("daily 08:00", "2026-10-10T06:00:00.000Z", { now: "2026-10-17T05:00:00.000Z" })).toBe("2026-10-17T06:00:00.000Z");
  });

  test("genau zum Termin: der nächste Tag, nie derselbe Zeitpunkt", () => {
    expect(next("daily 08:00", "2026-10-17T06:00:00.000Z")).toBe("2026-10-18T06:00:00.000Z");
  });
});

describe("werktags: Montag bis Freitag in der Zeitzone des Nutzers", () => {
  test("Freitag zu Montag über den Herbstwechsel", () => {
    // Fr 23.10. 07:00 MESZ (05:00Z) -> Mo 26.10. 07:00 MEZ (06:00Z)
    expect(next("weekdays 07:00", "2026-10-23T05:00:00.000Z")).toBe("2026-10-26T06:00:00.000Z");
  });

  test("Freitag zu Montag über den Frühjahrswechsel", () => {
    // Fr 27.3. 07:00 MEZ (06:00Z) -> Mo 30.3. 07:00 MESZ (05:00Z)
    expect(next("weekdays 07:00", "2026-03-27T06:00:00.000Z")).toBe("2026-03-30T05:00:00.000Z");
  });

  test("Montag bis Donnerstag: der nächste Tag", () => {
    expect(next("weekdays 07:00", "2026-10-19T05:00:00.000Z")).toBe("2026-10-20T05:00:00.000Z");
    expect(next("weekdays 07:00", "2026-10-22T05:00:00.000Z")).toBe("2026-10-23T05:00:00.000Z");
  });

  test("der Werktag hängt an der Zeitzone, nicht an UTC", () => {
    // Fr 23.10. 09:00 NZDT (22.10. 20:00Z) -> Mo 26.10. 09:00 NZDT (25.10. 20:00Z, in UTC ein Sonntag).
    // Sa 24.10. 09:00 NZDT wäre in UTC Freitag (23.10. 20:00Z) und fällt trotzdem aus.
    expect(next("weekdays 09:00", "2026-10-22T20:00:00.000Z", { timeZone: "Pacific/Auckland" })).toBe("2026-10-25T20:00:00.000Z");
  });

  test("vom Wochenende aus: Montag", () => {
    expect(next("weekdays 07:00", "2026-10-23T05:00:00.000Z", { now: "2026-10-24T10:00:00.000Z" })).toBe("2026-10-26T06:00:00.000Z");
  });
});

describe("wöchentlich: gleicher Wochentag, gleiche Ortszeit", () => {
  test("über den Herbstwechsel", () => {
    // So 18.10. 09:00 MESZ (07:00Z) -> So 25.10. 09:00 MEZ (08:00Z)
    expect(next("weekly sun 09:00", "2026-10-18T07:00:00.000Z")).toBe("2026-10-25T08:00:00.000Z");
  });

  test("über den Frühjahrswechsel, Termin in der Lücke", () => {
    // So 22.3. 02:30 MEZ (01:30Z) -> So 29.3. 02:30 fehlt, also 03:30 MESZ (01:30Z) -> So 5.4. 02:30 MESZ (00:30Z)
    const gap = next("weekly sun 02:30", "2026-03-22T01:30:00.000Z");
    expect(gap).toBe("2026-03-29T01:30:00.000Z");
    expect(next("weekly sun 02:30", gap!)).toBe("2026-04-05T00:30:00.000Z");
  });

  test("erster Termin an einem anderen Wochentag: der nächste passende", () => {
    // Mi 21.10. -> Mo 26.10.
    expect(next("weekly mon 10:00", "2026-10-21T08:00:00.000Z")).toBe("2026-10-26T09:00:00.000Z");
  });
});

describe("alle n Stunden: echte Dauer", () => {
  test("alle 2 Stunden über den Herbstwechsel", () => {
    // 02:00 MESZ (00:00Z) -> 03:00 MEZ (02:00Z): auf der Uhr 1 Stunde, echt 2
    expect(next("every 2h", "2026-10-25T00:00:00.000Z")).toBe("2026-10-25T02:00:00.000Z");
    // 01:00 MESZ (23:00Z) -> 02:00 MEZ, die zweite 02:00 (01:00Z)
    expect(next("every 2h", "2026-10-24T23:00:00.000Z")).toBe("2026-10-25T01:00:00.000Z");
  });

  test("alle 2 Stunden über den Frühjahrswechsel", () => {
    // 01:00 MEZ (00:00Z) -> 04:00 MESZ (02:00Z): auf der Uhr 3 Stunden, echt 2
    expect(next("every 2h", "2026-03-29T00:00:00.000Z")).toBe("2026-03-29T02:00:00.000Z");
  });

  test("verpasste Termine: der nächste im Raster nach jetzt", () => {
    expect(next("every 2h", "2026-10-17T10:00:00.000Z", { now: "2026-10-17T15:30:00.000Z" })).toBe("2026-10-17T16:00:00.000Z");
    expect(next("every 2h", "2026-10-17T10:00:00.000Z", { now: "2026-10-17T16:00:00.000Z" })).toBe("2026-10-17T18:00:00.000Z");
  });

  test("alle 240 Stunden (über eine Woche): echte Dauer über beide Wechsel", () => {
    // Di 20.10. 12:00 MESZ (10:00Z) -> Fr 30.10. 11:00 MEZ (10:00Z): auf der Uhr 239 Stunden, echt 240
    const autumn = next("every 240h", "2026-10-20T10:00:00.000Z");
    expect(autumn).toBe("2026-10-30T10:00:00.000Z");
    expect(Date.parse(autumn!) - Date.parse("2026-10-20T10:00:00.000Z")).toBe(240 * 3_600_000);
    // Mi 25.3. 12:00 MEZ (11:00Z) -> Sa 4.4. 13:00 MESZ (11:00Z): auf der Uhr 241 Stunden, echt 240
    expect(next("every 240h", "2026-03-25T11:00:00.000Z")).toBe("2026-04-04T11:00:00.000Z");
    // verpasst: der nächste im Raster nach jetzt
    expect(next("every 240h", "2026-10-01T10:00:00.000Z", { now: "2026-10-20T00:00:00.000Z" })).toBe("2026-10-21T10:00:00.000Z");
    expect(formatRecurrence(parseRecurrence("every 240h")!)).toBe("every 240h");
  });

  test("Termin jenseits des Date-Bereichs: undefined statt ungültigem Datum", () => {
    expect(next("every 2400000000h", "2026-10-20T10:00:00.000Z")).toBeUndefined();
  });

  test("hängt nicht an der Zeitzone", () => {
    expect(next("every 3h", "2026-10-25T00:00:00.000Z", { timeZone: "America/New_York" })).toBe("2026-10-25T03:00:00.000Z");
  });
});

describe("Zeitzone und ungültige Eingaben", () => {
  const saved = process.env.USER_TIMEZONE;
  afterEach(() => {
    if (saved === undefined) delete process.env.USER_TIMEZONE;
    else process.env.USER_TIMEZONE = saved;
  });

  test("ohne Angabe USER_TIMEZONE, unbekannte Zone ergibt UTC", () => {
    process.env.USER_TIMEZONE = "Europe/Berlin";
    const rule = parseRecurrence("daily 08:00")!;
    expect(nextDue(rule, d("2026-10-24T06:00:00.000Z"), { now: d("2026-10-24T06:00:00.000Z") })?.toISOString()).toBe("2026-10-25T07:00:00.000Z");
    process.env.USER_TIMEZONE = "Mond/Krater";
    expect(nextDue(rule, d("2026-10-24T08:00:00.000Z"), { now: d("2026-10-24T08:00:00.000Z") })?.toISOString()).toBe("2026-10-25T08:00:00.000Z");
  });

  test("ohne now gilt die Uhr", () => {
    const result = nextDue({ every: "hours", hours: 1 }, new Date(Date.now() - 90 * 60_000));
    expect(result!.getTime()).toBeGreaterThan(Date.now());
    expect(result!.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000);
  });

  test("ungültiger Zeitpunkt oder ungültige Regel: undefined", () => {
    expect(nextDue({ every: "day", hour: 8, minute: 0 }, new Date(NaN), BERLIN)).toBeUndefined();
    expect(nextDue({ every: "day", hour: 8, minute: 0 }, d("2026-10-17T06:00:00Z"), { ...BERLIN, now: new Date(NaN) })).toBeUndefined();
    expect(nextDue({ every: "hours", hours: 0 }, d("2026-10-17T06:00:00Z"), BERLIN)).toBeUndefined();
    expect(nextDue({ every: "day", hour: 25, minute: 0 }, d("2026-10-17T06:00:00Z"), BERLIN)).toBeUndefined();
  });
});

describe("anchorRecurrence: kurze Formen am ersten Termin festmachen", () => {
  // Di 20.10.2026 08:15 MESZ
  const first = d("2026-10-20T06:15:00.000Z");

  test("Uhrzeit und Wochentag kommen aus dem ersten Termin, in der Zeitzone", () => {
    expect(anchorRecurrence("daily", first, BERLIN)).toBe("daily 08:15");
    expect(anchorRecurrence("weekdays", first, BERLIN)).toBe("weekdays 08:15");
    expect(anchorRecurrence("weekly", first, BERLIN)).toBe("weekly tue 08:15");
    expect(anchorRecurrence("weekly", first, { timeZone: "Pacific/Auckland" })).toBe("weekly tue 19:15");
  });

  test("vollständige Formen bleiben, wie sie sind (kanonisch)", () => {
    expect(anchorRecurrence("Daily 7:00", first, BERLIN)).toBe("daily 07:00");
    expect(anchorRecurrence("every 2h", first, BERLIN)).toBe("every 2h");
  });

  test("ungültig: null", () => {
    expect(anchorRecurrence("monthly", first, BERLIN)).toBeNull();
    expect(anchorRecurrence("every 0h", first, BERLIN)).toBeNull();
    expect(anchorRecurrence("daily", new Date(NaN), BERLIN)).toBeNull();
  });
});
