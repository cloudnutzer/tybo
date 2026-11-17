/**
 * Issue #524: Fakten aus dem Altbestand mit Geheimnis erreichen keinen Prompt und
 * keine Ausgabe im Klartext. Reine Bausteine; der ganze Weg über Speicher und
 * Prompt-Builder läuft in memory-secrets-pg.test.ts. Alle Werte sind erfunden.
 */
import { describe, expect, test } from "bun:test";
import { TABLE_SPECS } from "../src/lib/embedding-reindex";
import { composeMemoryContext, factLine, fitMemoryContext, goalLine, memoryDelta } from "../src/lib/memory/context";
import { buildCoreDraftPrompt } from "../src/lib/memory/core-choices";
import { cleanupQuestion, type Ledger } from "../src/lib/memory/fact-cleanup";
import { memoryChoiceInput } from "../src/lib/memory/choices";
import { factsList, goalsList } from "../src/lib/memory/format";
import { SECRET_MASK } from "../src/lib/memory/secrets";
import type { MemoryItem } from "../src/lib/store/types";
import { createHistorySearchHandler } from "../src/lib/tools/history-search";
import { HARMLESS_FACTS, LABELED_SECRETS } from "./memory-secrets-cases";

const PASSWORD = "Waldgeheim42";
const KEY_BODY = "Ab3dE6gH9k".repeat(6);
const PEM = `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n${KEY_BODY}\n-----END PRIVATE KEY-----`;
const created_at = "2026-03-15T12:00:00Z";
const fact = (content: string, id = "1"): MemoryItem => ({ id, type: "fact", content, created_at });
const goal = (content: string): MemoryItem => ({ id: "9", type: "goal", content, created_at });

const expectClean = (text: string) => {
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(KEY_BODY);
  expect(text).not.toContain("BEGIN PRIVATE KEY");
};

describe("Prompt", () => {
  test("Zeile eines Fakts: maskiert und genau eine Zeile, auch beim mehrzeiligen Schlüssel", () => {
    const line = factLine(fact(`Vorher\n${PEM}\nNachher`));
    expectClean(line);
    expect(line).toContain(`Vorher ${SECRET_MASK} Nachher`);
    expect(line.split("\n")).toHaveLength(1);
  });

  test("Kontext zum Session-Start und Delta, Fakten wie Ziele", () => {
    const facts = [fact(`Passwort: ${PASSWORD}`), fact(PEM, "2")];
    const goals = [goal(`Passwort: ${PASSWORD} ändern`)];
    for (const text of [composeMemoryContext(facts, goals), memoryDelta([...facts, ...goals])]) {
      expectClean(text);
      expect(text).toContain(`Passwort: ${SECRET_MASK}`);
    }
  });

  test("Kürzen danach (Telefon) findet nur noch die Maske", () => {
    const text = fitMemoryContext(composeMemoryContext([fact(PEM), fact("Alex trinkt morgens Tee", "2")], []), 200);
    expectClean(text);
  });

  test("Unauffällige Fakten bleiben Zeichen für Zeichen, wie sie sind", () => {
    const content = "Commit 0123456789abcdef0123456789abcdef01234567, Pfad /Users/alex/.ssh/id_rsa, 1234567890";
    expect(factLine(fact(content))).toEndWith(content);
    expect(factsList([fact(content)])).toBe(`- ${content}`);
  });

  test("Kern-Entwurf: Das Aux-Modell sieht den Wert nicht", () => {
    expectClean(buildCoreDraftPrompt([fact(`Passwort: ${PASSWORD}`), fact(PEM, "2")]));
  });

  test("Nachschlagen: maskiert, bevor auf die Länge gekürzt wird", async () => {
    const search = createHistorySearchHandler({
      chatIds: () => [],
      searchMessages: async () => [],
      knowledgeContext: async () => "",
      searchImages: async () => [],
      searchFacts: async () => [fact(`${"Vorspann ".repeat(40)}\n${PEM}`)],
    });
    const raw = await search({ query: "Vorspann" });
    expectClean(raw);
    expect(raw).toContain("Vorspann");
    expect(raw).not.toContain(KEY_BODY.slice(0, 12));
  });

  test("Neuberechnung der Vektoren: Der Anbieter bekommt den Fakt nur maskiert", () => {
    const text = TABLE_SPECS.memory.text({ id: "1", type: "fact", content: `Vorher ${PEM}` });
    expect(text).toBe(`Vorher ${SECRET_MASK}`);
  });
});

describe("kein Rest des Werts", () => {
  const cases = LABELED_SECRETS.map(({ text, rest }) => [text, rest] as const);
  const expectNoRest = (shown: string, rest: readonly string[]) => {
    for (const part of rest) expect(shown).not.toContain(part);
    expect(shown).toContain(SECRET_MASK);
  };

  test.each(cases)("Prompt, Delta und Kern-Entwurf: %s", (text, rest) => {
    const facts = [fact(text)];
    expectNoRest(factLine(facts[0]), rest);
    expectNoRest(composeMemoryContext(facts, [goal(text)]), rest);
    expectNoRest(memoryDelta([...facts, goal(text)]), rest);
    expectNoRest(buildCoreDraftPrompt(facts), rest);
  });

  test.each(cases)("Ausgaben: %s", (text, rest) => {
    expectNoRest(factsList([fact(text)]), rest);
    expectNoRest(goalsList([goal(text)]), rest);
  });

  test.each(cases)("Nachschlagen: %s", async (text, rest) => {
    const search = createHistorySearchHandler({
      chatIds: () => [],
      searchMessages: async () => [],
      knowledgeContext: async () => "",
      searchImages: async () => [],
      searchFacts: async () => [fact(text)],
    });
    expectNoRest(await search({ query: "Passwort" }), rest);
  });

  test.each(cases)("neu berechneter Vektor: %s", (text, rest) => {
    expectNoRest(TABLE_SPECS.memory.text({ id: "1", type: "fact", content: text }), rest);
  });

  test.each(cases)("Rückfrage bei mehreren Treffern: %s", (text, rest) => {
    const input = memoryChoiceInput({
      action: "forget",
      query: text,
      matches: [fact(text), fact(`${text} alt`, "2")],
      more: false,
      where: { conversation: { type: "telegram", chatId: "1" } },
    });
    expectNoRest(JSON.stringify(input), rest);
  });

  test.each(cases)("Bereinigung: %s", (text, rest) => {
    const ledger: Ledger = {
      version: 1,
      items: { a: { id: "1", klass: "doppelt", reason: `steht als ${text} schon da`, original: text, state: "offen" } },
      groups: [],
    };
    const group = { id: "g", type: "paket" as const, conversation: { type: "telegram" as const, chatId: "1" }, items: ["a"], state: "offen" as const };
    expectNoRest(cleanupQuestion({ ...ledger, groups: [group] }, group, "liste", 0).text, rest);
  });

  test.each(HARMLESS_FACTS)("Harmloses bleibt unverändert (Pfad, Hash, Verweis, Maske): %s", text => {
    // Im Prompt steht ein Fakt auf einer Zeile; am Wortlaut ändert sich nichts
    expect(factLine(fact(text))).toEndWith(text.replace(/\s+/g, " ").trim());
    expect(factsList([fact(text)])).toBe(`- ${text}`);
    expect(TABLE_SPECS.memory.text({ id: "1", type: "fact", content: text })).toBe(text);
  });
});

describe("Ausgaben", () => {
  test("/memory und /goals", () => {
    expectClean(factsList([fact(`Passwort: ${PASSWORD}`), fact(PEM, "2")]));
    expectClean(goalsList([goal(`Passwort: ${PASSWORD} ändern`)]));
    expectClean(goalLine(goal(PEM), 1));
  });

  test("Rückfrage bei mehreren Treffern: Text und Knöpfe", () => {
    const input = memoryChoiceInput({
      action: "forget",
      query: `Passwort: ${PASSWORD}`,
      matches: [fact(`Passwort: ${PASSWORD}`), fact(`Passwort: ${PASSWORD} alt`, "2")],
      more: false,
      where: { conversation: { type: "telegram", chatId: "1" } },
    });
    expectClean(JSON.stringify(input));
    expect(input.text).toContain(SECRET_MASK);
  });

  test("Bereinigung: Fragetext maskiert, der Vermerk behält den Originaltext", () => {
    const ledger: Ledger = {
      version: 1,
      items: {
        a: { id: "1", klass: "doppelt", reason: `steht als Passwort: ${PASSWORD} schon da`, original: `Passwort: ${PASSWORD}`, state: "offen" },
        b: { id: "2", klass: "umschreiben", reason: "kürzer", original: `Passwort: ${PASSWORD}`, proposed: `Passwort: ${SECRET_MASK}`, state: "offen" },
      },
      groups: [],
    };
    for (const [items, type] of [[["a"], "paket"], [["b"], "umschreiben"]] as const) {
      const group = { id: "g", type, conversation: { type: "telegram" as const, chatId: "1" }, items: [...items], state: "offen" as const };
      const { text } = cleanupQuestion({ ...ledger, groups: [group] }, group, "liste", 0);
      expectClean(text);
      expect(text).toContain(SECRET_MASK);
    }
    expect(ledger.items.a.original).toContain(PASSWORD);
  });

});
