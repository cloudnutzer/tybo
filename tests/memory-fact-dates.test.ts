/**
 * Issue #519: Anlagedatum und Vorbehalt an Fakten im Prompt, ohne Datenbank:
 * Format, fehlende Daten, Budget, Delta und das Kürzen für den Anruf. Die Wege
 * über das echte Schema prüft tests/memory-fact-dates-pg.test.ts. Alle Daten
 * sind erfunden.
 */
import { describe, expect, test } from "bun:test";
import {
  composeMemoryContext,
  factDate,
  FACT_DATE_NOTE,
  fitMemoryContext,
  memoryDelta,
  UNKNOWN_FACT_DATE,
} from "../src/lib/memory/context";
import { goalsList } from "../src/lib/memory/format";
import { callVariables, MEMORY_MAX_CHARS } from "../src/lib/phone/context";
import type { MemoryItem } from "../src/lib/store/types";

const CREATED = "2026-03-14T12:00:00.000Z";
const fact = (content: string, created_at?: string | null): MemoryItem =>
  ({ type: "fact", content, ...(created_at === undefined ? {} : { created_at }) }) as MemoryItem;
const goal = (content: string): MemoryItem => ({ type: "goal", content });
const TELEGRAM_CALL = { reason: "", userName: "Alex", conversation: { type: "telegram", chatId: "1" } } as Parameters<typeof callVariables>[0];

describe("Anlagedatum eines Fakts", () => {
  test("kurz als YYYY-MM-DD in der angegebenen Zeitzone", () => {
    expect(factDate(CREATED, "Europe/Berlin")).toBe("2026-03-14");
    expect(factDate("2026-03-14T23:30:00.000Z", "UTC")).toBe("2026-03-14");
    expect(factDate("2026-03-14T23:30:00.000Z", "Europe/Berlin")).toBe("2026-03-15");
    expect(factDate("2026-03-14T23:30:00+00:00", "Europe/Berlin")).toBe("2026-03-15");
  });

  test("ohne Angabe die Zone aus USER_TIMEZONE, beim Aufruf gelesen", () => {
    const saved = process.env.USER_TIMEZONE;
    try {
      process.env.USER_TIMEZONE = "Asia/Tokyo";
      expect(factDate("2026-03-14T20:00:00.000Z")).toBe("2026-03-15");
      process.env.USER_TIMEZONE = "America/New_York";
      expect(factDate("2026-03-14T02:00:00.000Z")).toBe("2026-03-13");
    } finally {
      if (saved === undefined) delete process.env.USER_TIMEZONE;
      else process.env.USER_TIMEZONE = saved;
    }
  });

  test("ungültige Zone: UTC, kein Absturz", () => {
    expect(factDate("2026-03-14T23:30:00.000Z", "Mond/Krater")).toBe("2026-03-14");
  });

  for (const value of [undefined, null, "", "kein-datum", "Fakt 12", "12", "2026-13-45T00:00:00.000Z", "infinity"]) {
    test(`fehlend oder ungültig (${JSON.stringify(value)}): gekennzeichnet, nie heute`, () => {
      expect(factDate(value, "UTC")).toBe(UNKNOWN_FACT_DATE);
    });
  }

  for (const day of ["2026-02-29", "2026-02-30", "2026-04-31"]) {
    test(`Kalendertag ${day} gibt es nicht: gekennzeichnet, nicht auf den Folgemonat verschoben`, () => {
      expect(factDate(day, "UTC")).toBe(UNKNOWN_FACT_DATE);
      expect(factDate(`${day}T12:00:00.000Z`, "UTC")).toBe(UNKNOWN_FACT_DATE);
      expect(factDate(`${day} 12:00:00+00`, "UTC")).toBe(UNKNOWN_FACT_DATE);
    });
  }

  test("gültiger Schalttag bleibt erhalten", () => {
    expect(factDate("2028-02-29T12:00:00.000Z", "UTC")).toBe("2028-02-29");
    expect(factDate("2028-02-29T12:00:00.000Z", "Europe/Berlin")).toBe("2028-02-29");
  });
});

describe("Faktenzeilen im Kontext", () => {
  test("Datum vor jedem Fakt, Vorbehalt unter der Überschrift, Ziele ohne Datum", () => {
    const context = composeMemoryContext([fact("Alex mag Tee", CREATED), fact("Mia spielt Cello")], [goal("Mehr lesen")], undefined, 6000);
    expect(context).toBe(
      [
        "**Known Facts:**",
        FACT_DATE_NOTE,
        "- [2026-03-14] Alex mag Tee",
        `- [${UNKNOWN_FACT_DATE}] Mia spielt Cello`,
        "",
        "**Active Goals:**",
        "1. Mehr lesen",
      ].join("\n"),
    );
  });

  test("Vorbehalt nennt das Anlagedatum nicht als Bestätigung und sagt, was zu prüfen ist", () => {
    expect(FACT_DATE_NOTE).toContain("keine Bestätigung der Aktualität");
    expect(FACT_DATE_NOTE).toContain("Ältere Stände können überholt sein, bei Zahlen, Status und Versionen im Zweifel prüfen");
  });

  test("leeres Gedächtnis: leerer Text, kein Vorbehalt; nur Ziele: kein Vorbehalt", () => {
    expect(composeMemoryContext([], [], undefined, 6000)).toBe("");
    expect(composeMemoryContext([], [goal("Mehr lesen")], undefined, 6000)).toBe("**Active Goals:**\n1. Mehr lesen");
  });

  test("ein Fakt und ein Ziel mit Zeilenumbruch bleiben je eine Zeile", () => {
    const context = composeMemoryContext([fact("Erste Zeile\n\n  zweite Zeile", CREATED)], [goal("Ziel\r\nmit Umbruch")], undefined, 6000);
    expect(context).toContain("- [2026-03-14] Erste Zeile zweite Zeile");
    expect(context).toContain("1. Ziel mit Umbruch");
  });

  test("mehrzeiliges Ziel: im Prompt eine Zeile, in der Liste von /goals wie gespeichert", () => {
    const multiline = goal("Ziel\nmit\r\n  Umbruch");
    expect(composeMemoryContext([], [multiline], undefined, 6000)).toBe("**Active Goals:**\n1. Ziel mit Umbruch");
    expect(goalsList([goal("Mehr lesen"), multiline])).toBe("1. Mehr lesen\n2. Ziel\nmit\r\n  Umbruch");
  });
});

describe("Budget zählt das Datum mit", () => {
  const body = (i: number) => `Fakt ${String(i).padStart(2, "0")} ${"x".repeat(92)}`;
  /** Zwölf Fakten mit je 100 Zeichen Text; mit Datum belegt jede Zeile 116 Zeichen */
  const dated = (count: number) => Array.from({ length: count }, (_, i) => fact(body(i), CREATED));
  const LINE = 116;
  const shownFacts = (context: string) => context.split("\n").filter(line => line.startsWith("- ")).length;

  test("Grenze genau auf der Zeilenlänge samt Datum", () => {
    expect(dated(1)[0].content).toHaveLength(100);
    expect("- [2026-03-14] ".length + 100 + 1).toBe(LINE);
    const exact = composeMemoryContext(dated(11), [], undefined, LINE * 11);
    expect(shownFacts(exact)).toBe(11);
    expect(exact).not.toContain("facts shown");
    const below = composeMemoryContext(dated(11), [], undefined, LINE * 11 - 1);
    expect(shownFacts(below)).toBe(10);
    expect(below).toContain("(10 of 11 facts shown");
  });

  test("ohne Datum im Budget passten alle zwölf hinein, mit Datum nicht", () => {
    const budget = 103 * 12;
    const context = composeMemoryContext(dated(12), [], undefined, budget);
    expect(shownFacts(context)).toBe(10);
    expect(context).toContain("(10 of 12 facts shown");
  });

  test("die Kennzeichnung eines unbekannten Datums kostet ebenfalls", () => {
    const unknown = Array.from({ length: 11 }, (_, i) => fact(body(i)));
    const cost = `- [${UNKNOWN_FACT_DATE}] `.length + 100 + 1;
    expect(shownFacts(composeMemoryContext(unknown, [], undefined, cost * 11))).toBe(11);
    expect(shownFacts(composeMemoryContext(unknown, [], undefined, cost * 11 - 1))).toBe(10);
  });

  test("mindestens zehn Fakten, auch wenn das Budget kaum reicht", () => {
    const context = composeMemoryContext(dated(11), [], undefined, 1);
    expect(shownFacts(context)).toBe(10);
    expect(context).toContain("(10 of 11 facts shown");
  });

  test("Infinity wie im Datei-Weg und ein unlesbares Budget: nie gekürzt", () => {
    expect(shownFacts(composeMemoryContext(dated(12), [], undefined, Infinity))).toBe(12);
    expect(shownFacts(composeMemoryContext(dated(12), [], undefined, NaN))).toBe(12);
  });
});

describe("Delta für fortgesetzte Sessions", () => {
  test("Fakten mit Datum und Vorbehalt, Ziele mit Frist wie gespeichert", () => {
    const delta = memoryDelta([fact("Alex mag Tee", CREATED), fact("Mia spielt Cello"), { type: "goal", content: "Mehr lesen", deadline: "2026-12-24T18:00:00.000Z" }]);
    expect(delta).toBe(
      [
        FACT_DATE_NOTE,
        "- [fact] [2026-03-14] Alex mag Tee",
        `- [fact] [${UNKNOWN_FACT_DATE}] Mia spielt Cello`,
        "- [goal] Mehr lesen (due: 2026-12-24T18:00:00.000Z)",
      ].join("\n"),
    );
  });

  test("nur Ziele: kein Vorbehalt; nichts: leerer Text", () => {
    expect(memoryDelta([goal("Mehr lesen")])).toBe("- [goal] Mehr lesen");
    expect(memoryDelta([])).toBe("");
  });
});

describe("Kürzen ohne zerschnittene Einträge", () => {
  const facts = Array.from({ length: 30 }, (_, i) => fact(`Fakt ${String(i).padStart(2, "0")} ${"y".repeat(70)}`, CREATED));
  const composed = composeMemoryContext(facts, [goal("Mehr lesen")], undefined, 6000);

  test("unter dem Limit bleibt der Text, wie er ist", () => {
    expect(fitMemoryContext(composed, composed.length)).toBe(composed);
  });

  test("über dem Limit: Überschrift und Vorbehalt bleiben, nur ganze Einträge, Länge eingehalten", () => {
    const fitted = fitMemoryContext(composed, 500);
    expect(fitted.length).toBeLessThanOrEqual(500);
    const lines = fitted.split("\n");
    expect(lines.slice(0, 2)).toEqual(["**Known Facts:**", FACT_DATE_NOTE]);
    const original = new Set(composed.split("\n"));
    for (const line of lines) expect(original.has(line)).toBe(true);
    expect(lines.filter(line => line.startsWith("- [2026-03-14] Fakt ")).length).toBeGreaterThan(0);
  });

  test("Länge bis aufs Zeichen genau ausgenutzt, Grenzfall je Limit", () => {
    for (let max = 0; max <= 700; max += 7) expect(fitMemoryContext(composed, max).length).toBeLessThanOrEqual(max);
    const twoFacts = composeMemoryContext([fact("Alex mag Tee", CREATED), fact("Mia spielt Cello", CREATED)], [], undefined, 6000);
    const oneFact = composeMemoryContext([fact("Alex mag Tee", CREATED)], [], undefined, 6000);
    expect(fitMemoryContext(twoFacts, oneFact.length)).toBe(oneFact);
    expect(fitMemoryContext(twoFacts, oneFact.length - 1)).toBe("");
  });

  test("ein zu langer Fakt fällt ganz weg, kürzere dahinter bleiben", () => {
    const context = composeMemoryContext([fact("z".repeat(2000), CREATED), fact("Alex mag Tee", CREATED)], [], undefined, 6000);
    expect(fitMemoryContext(context, 500)).toBe(`**Known Facts:**\n${FACT_DATE_NOTE}\n- [2026-03-14] Alex mag Tee`);
  });

  test("die Hinweiszeile fällt weg, ihre Zahlen stimmten nicht mehr", () => {
    const trimmed = composeMemoryContext(facts, [], undefined, 500);
    expect(trimmed).toContain("facts shown");
    expect(fitMemoryContext(trimmed, 500)).not.toContain("facts shown");
  });

  test("passen keine Fakten, aber das Ziel: nur der Zielabschnitt, ohne leere Überschrift", () => {
    const context = composeMemoryContext([fact("z".repeat(2000), CREATED)], [goal("Mehr lesen")], undefined, 6000);
    expect(fitMemoryContext(context, 100)).toBe("**Active Goals:**\n1. Mehr lesen");
  });
});

describe("Anruf: Variable memory", () => {
  const recent = async () => [];

  test("langer Kontext: höchstens 1.000 Zeichen, mit Vorbehalt, nur ganze datierte Fakten", async () => {
    const facts = Array.from({ length: 40 }, (_, i) => fact(`Fakt ${String(i).padStart(2, "0")} ${"y".repeat(70)}`, i % 2 ? CREATED : null));
    const composed = composeMemoryContext(facts, [goal("Mehr lesen")], undefined, 6000);
    expect(composed.length).toBeGreaterThan(MEMORY_MAX_CHARS);
    const { memory } = await callVariables(TELEGRAM_CALL, { memory: async () => composed, recent });
    expect(memory.length).toBeLessThanOrEqual(MEMORY_MAX_CHARS);
    expect(memory).toContain(FACT_DATE_NOTE);
    const whole = new Set(composed.split("\n"));
    const lines = memory.split("\n");
    for (const line of lines) expect(whole.has(line)).toBe(true);
    const factLines = lines.filter(line => line.startsWith("- "));
    expect(factLines.length).toBeGreaterThan(0);
    for (const line of factLines) expect(line).toMatch(/^- \[(\d{4}-\d{2}-\d{2}|Anlagedatum unbekannt)\] Fakt \d\d y{70}$/);
  });

  test("leeres Gedächtnis: Platzhalter wie bisher, kein Vorbehalt", async () => {
    const { memory } = await callVariables(TELEGRAM_CALL, { memory: async () => "", recent });
    expect(memory).toBe("No stored memory available. Start fresh.");
  });
});
