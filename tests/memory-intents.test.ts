/**
 * Issue #316, Aufgabe 1: der reine Tag-Parser (src/lib/memory/intents.ts).
 * Kein Speicher, keine Uhr; das Verhalten beim Anwenden prüft
 * memory-intents-behavior.test.ts.
 */
import { describe, expect, test } from "bun:test";
import {
  isVague,
  MEMORY_TAG_NAMES,
  MIN_GOAL_QUERY_LENGTH,
  parseMemoryIntents,
  readTags,
  tagParts,
} from "../src/lib/memory/intents";

describe("readTags", () => {
  test("Inhalt getrimmt, Stelle im Text, Name ohne Rücksicht auf Groß- und Kleinschreibung", () => {
    const text = "a [REMEMBER:  eins ] b [remember:zwei]";
    expect(readTags(text, "REMEMBER")).toEqual([
      { name: "REMEMBER", body: "eins", index: 2 },
      { name: "REMEMBER", body: "zwei", index: 23 },
    ]);
  });

  test("Inhalt bis zur ersten schließenden Klammer, auch über Zeilen", () => {
    expect(readTags("[REMEMBER: Alex\nwohnt [in] Hamburg]", "REMEMBER").map(t => t.body)).toEqual(["Alex\nwohnt [in"]);
  });

  test("leere Inhalte zählen nicht", () => {
    expect(readTags("[REMEMBER:] [REMEMBER:   ]", "REMEMBER")).toEqual([]);
  });

  test("ohne Doppelpunkt oder Klammer kein Tag", () => {
    expect(readTags("[REMEMBER Alex] REMEMBER: Mia [REMEMBER: offen", "REMEMBER")).toEqual([]);
  });

  test("REMIND und KNOWLEDGE sind lesbar", () => {
    expect(readTags("[REMIND: morgen 9 Uhr | Arzt anrufen]", "REMIND").map(t => t.body)).toEqual(["morgen 9 Uhr | Arzt anrufen"]);
    expect(readTags("[KNOWLEDGE: Router-Passwort steht im Keller]", "KNOWLEDGE").map(t => t.body)).toEqual(["Router-Passwort steht im Keller"]);
  });
});

describe("tagParts", () => {
  test("ohne Pipe nur der Text", () => {
    expect(tagParts("Mehr lesen")).toEqual({ head: "Mehr lesen", field: null, malformed: false });
  });

  test("Feldname groß, Wert darf selbst eine Pipe enthalten", () => {
    expect(tagParts("Steuer | deadline: in 3 Tagen | spätestens")).toEqual({
      head: "Steuer",
      field: { name: "DEADLINE", value: "in 3 Tagen | spätestens" },
      malformed: false,
    });
  });

  test("nach der Pipe keine Angabe FELD: Wert", () => {
    expect(tagParts("Urlaub | bald")).toEqual({ head: "Urlaub", field: null, malformed: true });
  });
});

describe("parseMemoryIntents", () => {
  test("ohne Tags leer", () => {
    expect(parseMemoryIntents("Keine Tags, nur [eckige] Klammern.")).toEqual([]);
  });

  test("alle fünf Arten, in der Reihenfolge des Anwendens", () => {
    const text = [
      "[CANCEL: Marathon laufen]",
      "[FORGET: Kaffee]",
      "[REMEMBER: Alex mag Tee]",
      "[DONE: Bericht schreiben]",
      "[GOAL: Mehr lesen]",
      "[GOAL: Steuer | DEADLINE: morgen]",
    ].join(" ");
    expect(parseMemoryIntents(text)).toEqual([
      { type: "goal", text: "Steuer", deadline: "morgen" },
      { type: "goal", text: "Mehr lesen" },
      { type: "done", query: "Bericht schreiben" },
      { type: "fact", text: "Alex mag Tee" },
      { type: "forget", query: "Kaffee" },
      { type: "cancel", query: "Marathon laufen" },
    ]);
  });

  test("Ziele mit Frist vor denen ohne, sonst Textreihenfolge", () => {
    const intents = parseMemoryIntents("[GOAL: a] [GOAL: b | DEADLINE: heute] [GOAL: c] [GOAL: d | Deadline: in 2 Wochen]");
    expect(intents.map(i => (i.type === "goal" ? i.text : ""))).toEqual(["b", "d", "a", "c"]);
  });

  test("GOAL mit anderer Angabe nach der Pipe oder ohne Text: kein Ziel", () => {
    expect(parseMemoryIntents("[GOAL: Urlaub | bald] [GOAL: Urlaub | WHEN: morgen] [GOAL: | DEADLINE: morgen]")).toEqual([]);
  });

  test("GOAL mit leerer Frist: Ziel ohne Frist", () => {
    expect(parseMemoryIntents("[GOAL: Urlaub | DEADLINE: ]")).toEqual([{ type: "goal", text: "Urlaub" }]);
  });

  test("REMIND nur mit Zeit und Text (#322), KNOWLEDGE ohne Stellen nicht (#317)", () => {
    expect(MEMORY_TAG_NAMES).toEqual(["REMEMBER", "GOAL", "DONE", "CANCEL", "FORGET", "KNOWLEDGE", "REMIND"]);
    expect(parseMemoryIntents("[REMIND: Arzt] [REMIND: | Arzt] [REMIND: morgen | ] [KNOWLEDGE: x]")).toEqual([]);
    expect(parseMemoryIntents("[REMIND: in 2 Minuten | Test | mit Strich] [REMEMBER: a]")).toEqual([
      { type: "fact", text: "a" },
      { type: "remind", when: "in 2 Minuten", text: "Test | mit Strich" },
    ]);
  });
});

describe("isVague", () => {
  test(`DONE und CANCEL unter ${MIN_GOAL_QUERY_LENGTH} Zeichen, FORGET nie`, () => {
    expect(isVague({ type: "done", query: "Rad" })).toBe(true);
    expect(isVague({ type: "cancel", query: "abcd" })).toBe(true);
    expect(isVague({ type: "done", query: "abcde" })).toBe(false);
    expect(isVague({ type: "forget", query: "Tee" })).toBe(false);
    expect(isVague({ type: "fact", text: "x" })).toBe(false);
  });
});
