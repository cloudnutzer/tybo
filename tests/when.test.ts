/**
 * Issue #308: Zeitangaben auf Deutsch und Englisch (src/lib/when.ts).
 * Feste Uhr, Zeitzone als Parameter; die Sollwerte stehen im Issue.
 */
import { describe, expect, test } from "bun:test";
import { effectiveTimeZone, parseWhen, relativeTime } from "../src/lib/when";

const BERLIN = "Europe/Berlin";
/** Freitag, 16.10.2026, 17:00 MESZ */
const NOW = new Date("2026-10-16T15:00:00Z");

function at(input: string, now = NOW, timeZone = BERLIN): string | undefined {
  return parseWhen(input, { now, timeZone })?.toISOString();
}

function iso(utc: string): string {
  return new Date(utc).toISOString();
}

/** Setzt USER_TIMEZONE für die Dauer von fn und stellt den alten Wert wieder her */
function withUserTimeZone<T>(value: string | undefined, fn: () => T): T {
  const saved = process.env.USER_TIMEZONE;
  try {
    if (value === undefined) delete process.env.USER_TIMEZONE;
    else process.env.USER_TIMEZONE = value;
    return fn();
  } finally {
    if (saved === undefined) delete process.env.USER_TIMEZONE;
    else process.env.USER_TIMEZONE = saved;
  }
}

describe("parseWhen: Sollwerte aus dem Issue (Europe/Berlin, jetzt Fr 17:00 MESZ)", () => {
  const table: [string[], string][] = [
    [["heute", "today"], "2026-10-16T21:59:59Z"],
    [["morgen", "tomorrow"], "2026-10-17T21:59:59Z"],
    [["übermorgen", "the day after tomorrow"], "2026-10-18T21:59:59Z"],
    [["in 3 Tagen", "in 3 days"], "2026-10-19T21:59:59Z"],
    [["in 2 Stunden", "in 2 hours"], "2026-10-16T17:00:00Z"],
    [["18 Uhr", "6pm"], "2026-10-16T16:00:00Z"],
    [["17 Uhr", "5pm"], "2026-10-17T15:00:00Z"],
    [["9 Uhr"], "2026-10-17T07:00:00Z"],
    [["Montag", "monday"], "2026-10-19T21:59:59Z"],
    [["Freitag", "friday"], "2026-10-23T21:59:59Z"],
    [["2026-11-01"], "2026-11-01T22:59:59Z"],
    [["2026-11-01T09:00"], "2026-11-01T08:00:00Z"],
    [["2026-11-01T09:00+05:00"], "2026-11-01T04:00:00Z"],
    [["2026-11-01T09:00Z"], "2026-11-01T09:00:00Z"],
  ];
  for (const [inputs, expected] of table) {
    for (const input of inputs) {
      test(`${input} → ${expected}`, () => {
        expect(at(input)).toBe(iso(expected));
      });
    }
  }
});

describe("parseWhen: weitere zugesagte Formen", () => {
  test("Wochen", () => {
    expect(at("in 2 Wochen")).toBe(iso("2026-10-30T22:59:59Z"));
    expect(at("in 1 week")).toBe(iso("2026-10-23T21:59:59Z"));
    expect(at("in 2 weeks")).toBe(at("in 2 Wochen"));
  });

  test("Minuten", () => {
    expect(at("in 45 Minuten")).toBe(iso("2026-10-16T15:45:00Z"));
    expect(at("in 1 minute")).toBe(iso("2026-10-16T15:01:00Z"));
    expect(at("in 90 minutes")).toBe(iso("2026-10-16T16:30:00Z"));
  });

  test("Wochentags-Kurzformen", () => {
    expect(at("Mo")).toBe(iso("2026-10-19T21:59:59Z"));
    expect(at("mon")).toBe(iso("2026-10-19T21:59:59Z"));
    expect(at("Di")).toBe(iso("2026-10-20T21:59:59Z"));
    expect(at("thu")).toBe(iso("2026-10-22T21:59:59Z"));
    expect(at("Sa")).toBe(iso("2026-10-17T21:59:59Z"));
    expect(at("sun")).toBe(iso("2026-10-18T21:59:59Z"));
    expect(at("fr")).toBe(iso("2026-10-23T21:59:59Z"));
  });

  test("17.30 Uhr, 17:30 und 5:30 pm", () => {
    expect(at("17.30 Uhr")).toBe(iso("2026-10-16T15:30:00Z"));
    expect(at("17:30 Uhr")).toBe(iso("2026-10-16T15:30:00Z"));
    expect(at("17:30")).toBe(iso("2026-10-16T15:30:00Z"));
    expect(at("5:30 pm")).toBe(iso("2026-10-16T15:30:00Z"));
    expect(at("5:30pm")).toBe(iso("2026-10-16T15:30:00Z"));
  });

  test("12am ist Mitternacht, 12pm ist Mittag", () => {
    expect(at("12am")).toBe(iso("2026-10-16T22:00:00Z"));
    expect(at("12pm")).toBe(iso("2026-10-17T10:00:00Z"));
    expect(at("12:15 am")).toBe(iso("2026-10-16T22:15:00Z"));
  });

  test("Groß- und Kleinschreibung und Leerraum egal", () => {
    expect(at("  MORGEN ")).toBe(iso("2026-10-17T21:59:59Z"));
    expect(at("In  3  TAGEN")).toBe(iso("2026-10-19T21:59:59Z"));
    expect(at("6PM")).toBe(iso("2026-10-16T16:00:00Z"));
    expect(at("2026-11-01t09:00z")).toBe(iso("2026-11-01T09:00:00Z"));
  });

  test("Uhrzeit eine Minute vor jetzt ist vergangen, eine Minute danach noch heute", () => {
    expect(at("16:59")).toBe(iso("2026-10-17T14:59:00Z"));
    expect(at("17:01")).toBe(iso("2026-10-16T15:01:00Z"));
  });

  test("Sekunden im aktuellen Zeitpunkt: gleiche Minute zählt als vergangen", () => {
    expect(at("17 Uhr", new Date("2026-10-16T15:00:30Z"))).toBe(iso("2026-10-17T15:00:00Z"));
  });

  test("ISO mit Sekunden und negativem Offset", () => {
    expect(at("2026-11-01T09:00:30")).toBe(iso("2026-11-01T08:00:30Z"));
    expect(at("2026-11-01T09:00-03:30")).toBe(iso("2026-11-01T12:30:00Z"));
  });

  test("ISO-Sekundenbruchteile bleiben erhalten (Z, Offset, Ortszeit)", () => {
    expect(at("2026-11-01T09:00:30.123Z")).toBe("2026-11-01T09:00:30.123Z");
    expect(at("2026-11-01T09:00:30.123+02:00")).toBe("2026-11-01T07:00:30.123Z");
    expect(at("2026-11-01T09:00:30.123")).toBe("2026-11-01T08:00:30.123Z");
    expect(at("2026-11-01T09:00:30.5Z")).toBe("2026-11-01T09:00:30.500Z");
  });
});

describe("parseWhen: Sommerzeit-Grenzen 2026", () => {
  test("morgen am Tag mit 23 Stunden endet in MESZ", () => {
    expect(at("morgen", new Date("2026-03-28T12:00:00Z"))).toBe(iso("2026-03-29T21:59:59Z"));
  });

  test("morgen am Tag mit 25 Stunden endet in MEZ", () => {
    expect(at("morgen", new Date("2026-10-24T12:00:00Z"))).toBe(iso("2026-10-25T22:59:59Z"));
  });

  test("nicht existierende Ortszeit wird um die Lücke nach vorn geschoben", () => {
    expect(at("2:30 Uhr", new Date("2026-03-28T23:00:00Z"))).toBe(iso("2026-03-29T01:30:00Z"));
  });

  test("doppelt vorkommende Ortszeit nimmt das frühere Vorkommen", () => {
    expect(at("2:30 Uhr", new Date("2026-10-24T23:00:00Z"))).toBe(iso("2026-10-25T00:30:00Z"));
  });

  test("Dauer ist echte Zeit, nicht Ortszeit", () => {
    expect(at("in 24 Stunden", new Date("2026-03-28T12:00:00Z"))).toBe(iso("2026-03-29T12:00:00Z"));
  });

  test("Kalendertage über den Wechsel hinweg bleiben Ortstage", () => {
    expect(at("in 2 Tagen", new Date("2026-03-28T12:00:00Z"))).toBe(iso("2026-03-30T21:59:59Z"));
    expect(at("in 1 Tag", new Date("2026-10-24T12:00:00Z"))).toBe(iso("2026-10-25T22:59:59Z"));
  });

  test("ISO-Ortszeit in der Lücke und im doppelten Bereich", () => {
    expect(at("2026-03-29T02:30")).toBe(iso("2026-03-29T01:30:00Z"));
    expect(at("2026-10-25T02:30")).toBe(iso("2026-10-25T00:30:00Z"));
  });

  test("Pacific/Auckland: Lücke nach vorn, doppelte Zeit früheres Vorkommen", () => {
    const auckland = "Pacific/Auckland";
    expect(at("2026-09-27T02:30", NOW, auckland)).toBe(iso("2026-09-26T14:30:00Z"));
    expect(at("2026-04-05T02:30", NOW, auckland)).toBe(iso("2026-04-04T13:30:00Z"));
  });
});

describe("parseWhen: Zeitzone", () => {
  test("ohne USER_TIMEZONE gilt UTC", () => {
    withUserTimeZone(undefined, () => {
      expect(parseWhen("heute", { now: NOW })?.toISOString()).toBe(iso("2026-10-16T23:59:59Z"));
      expect(effectiveTimeZone()).toBe("UTC");
    });
  });

  test("ungültige USER_TIMEZONE ergibt UTC ohne Ausnahme", () => {
    withUserTimeZone("Mars/Olympus", () => {
      expect(() => parseWhen("heute", { now: NOW })).not.toThrow();
      expect(parseWhen("heute", { now: NOW })?.toISOString()).toBe(iso("2026-10-16T23:59:59Z"));
    });
  });

  test("leere USER_TIMEZONE ergibt UTC", () => {
    withUserTimeZone("", () => {
      expect(parseWhen("heute", { now: NOW })?.toISOString()).toBe(iso("2026-10-16T23:59:59Z"));
    });
  });

  test("USER_TIMEZONE wird benutzt, wenn kein Parameter kommt", () => {
    withUserTimeZone(BERLIN, () => {
      expect(parseWhen("heute", { now: NOW })?.toISOString()).toBe(iso("2026-10-16T21:59:59Z"));
    });
  });

  test("Parameter hat Vorrang vor USER_TIMEZONE", () => {
    withUserTimeZone("America/New_York", () => {
      expect(parseWhen("heute", { now: NOW, timeZone: BERLIN })?.toISOString()).toBe(iso("2026-10-16T21:59:59Z"));
      expect(parseWhen("heute", { now: NOW })?.toISOString()).toBe(iso("2026-10-17T03:59:59Z"));
    });
  });

  test("ungültiger Parameter ergibt UTC", () => {
    withUserTimeZone(BERLIN, () => {
      expect(parseWhen("heute", { now: NOW, timeZone: "Mars/Olympus" })?.toISOString()).toBe(
        iso("2026-10-16T23:59:59Z")
      );
    });
  });

  test("ohne now gilt die aktuelle Uhr", () => {
    const before = Date.now();
    const result = parseWhen("in 1 Stunde", { timeZone: BERLIN })!.getTime();
    expect(result).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(result).toBeLessThanOrEqual(Date.now() + 3_600_000);
  });
});

describe("parseWhen: ISO-Jahre 0000 bis 0099 bleiben, wie sie sind", () => {
  // Date.UTC würde 0050 als 1950 lesen
  const cases: [string, string, string][] = [
    ["0050-06-15", "UTC", "0050-06-15T23:59:59.000Z"],
    ["0000-02-29", "UTC", "0000-02-29T23:59:59.000Z"],
    ["0099-12-31", "UTC", "0099-12-31T23:59:59.000Z"],
    ["0050-06-15T10:30", "UTC", "0050-06-15T10:30:00.000Z"],
    ["0050-06-15T12:00", BERLIN, "0050-06-15T11:06:32.000Z"],
    ["0000-01-01T00:00:01", "UTC", "0000-01-01T00:00:01.000Z"],
    ["0050-06-15T10:30Z", BERLIN, "0050-06-15T10:30:00.000Z"],
    ["0050-06-15T10:30:15.5Z", BERLIN, "0050-06-15T10:30:15.500Z"],
    ["0050-06-15T10:30+02:00", BERLIN, "0050-06-15T08:30:00.000Z"],
    ["0099-01-01T00:30-0100", BERLIN, "0099-01-01T01:30:00.000Z"],
  ];
  for (const [input, zone, expected] of cases) {
    test(`${input} (${zone})`, () => {
      expect(parseWhen(input, { now: NOW, timeZone: zone })?.toISOString()).toBe(expected);
    });
  }

  test("0099-02-29 gibt es nicht", () => {
    expect(parseWhen("0099-02-29", { now: NOW, timeZone: "UTC" })).toBeUndefined();
  });
});

describe("parseWhen: ungültige Eingaben", () => {
  const invalid = [
    "",
    "   ",
    "irgendwann",
    "someday",
    "25 Uhr",
    "13pm",
    "0am",
    "17:60",
    "2026-13-01",
    "2026-02-30",
    "2026-11-01T24:00",
    "in -1 Tagen",
    "in Tagen",
    "in 3 Jahren",
    "Montag 9 Uhr",
    "16.10.",
    "next week",
    "constructor",
    "__proto__",
    "toString",
    "hasOwnProperty",
    "in 3 constructor",
    "in 3 __proto__",
    "2026-11-01T09:00+05:60",
    "2026-11-01T09:00-0099",
    "in 999999999999 Stunden",
    "in 99999999999999999999 minutes",
    "in 999999999999 Tagen",
    "in 99999999999999999999 weeks",
  ];
  for (const input of invalid) {
    test(JSON.stringify(input), () => {
      expect(() => parseWhen(input, { now: NOW, timeZone: BERLIN })).not.toThrow();
      expect(parseWhen(input, { now: NOW, timeZone: BERLIN })).toBeUndefined();
    });
  }
});

describe("relativeTime", () => {
  const cases: [number, string, string][] = [
    [-30_000, "gerade eben", "just now"],
    [-60_000, "vor 1 Minute", "1 minute ago"],
    [-5 * 60_000, "vor 5 Minuten", "5 minutes ago"],
    [-3_600_000, "vor 1 Stunde", "1 hour ago"],
    [-3 * 3_600_000, "vor 3 Stunden", "3 hours ago"],
    [-86_400_000, "vor 1 Tag", "1 day ago"],
    [-2 * 86_400_000, "vor 2 Tagen", "2 days ago"],
    [-29 * 86_400_000, "vor 29 Tagen", "29 days ago"],
    [-30 * 86_400_000, "16.09.2026", "2026-09-16"],
    [5 * 60_000, "gerade eben", "just now"],
  ];
  for (const [offset, de, en] of cases) {
    test(`${offset} ms → ${de} / ${en}`, () => {
      const date = new Date(NOW.getTime() + offset);
      expect(relativeTime(date, { now: NOW, locale: "de", timeZone: BERLIN })).toBe(de);
      expect(relativeTime(date, { now: NOW, locale: "en", timeZone: BERLIN })).toBe(en);
    });
  }

  test("Standard ist englisch", () => {
    expect(relativeTime(new Date(NOW.getTime() - 3 * 3_600_000), { now: NOW })).toBe("3 hours ago");
  });

  test("Abstand wird abgerundet", () => {
    const date = new Date(NOW.getTime() - (2 * 3_600_000 - 1));
    expect(relativeTime(date, { now: NOW, locale: "de" })).toBe("vor 1 Stunde");
    expect(relativeTime(new Date(NOW.getTime() - 119_000), { now: NOW })).toBe("1 minute ago");
  });

  test("Datum nahe Mitternacht folgt der Zeitzone", () => {
    // 22:30 UTC am 15.9. ist in Berlin schon der 16.9.
    const date = new Date("2026-09-15T22:30:00Z");
    expect(relativeTime(date, { now: NOW, locale: "de", timeZone: BERLIN })).toBe("16.09.2026");
    expect(relativeTime(date, { now: NOW, locale: "de", timeZone: "UTC" })).toBe("15.09.2026");
    expect(relativeTime(date, { now: NOW, locale: "en", timeZone: BERLIN })).toBe("2026-09-16");
    expect(relativeTime(date, { now: NOW, locale: "en", timeZone: "UTC" })).toBe("2026-09-15");
  });

  test("Datum über USER_TIMEZONE, ungültige ergibt UTC", () => {
    const date = new Date("2026-09-15T22:30:00Z");
    withUserTimeZone(BERLIN, () => {
      expect(relativeTime(date, { now: NOW, locale: "de" })).toBe("16.09.2026");
    });
    withUserTimeZone("Mars/Olympus", () => {
      expect(relativeTime(date, { now: NOW, locale: "de" })).toBe("15.09.2026");
    });
  });
});
