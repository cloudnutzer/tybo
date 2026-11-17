/**
 * Issue #524: Schreibschutz auf der Datei (Preload setzt MEMORY_FILE_PATH), mit dem
 * echten Dienst und dem echten Befehl. Supabase läuft in memory-secrets-pg.test.ts.
 * Alle Werte sind erfunden.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { rmSync } from "node:fs";
import { commandRegistry } from "../src/lib/commands/builtin";
import type { CommandContext, CommandServices } from "../src/lib/commands/types";
import { decideReview, describeApplied } from "../src/lib/intent-gate";
import { memoryFailureText, processIntents } from "../src/lib/memory";
import { parseCleanupList } from "../src/lib/memory/fact-cleanup";
import { SECRET_MASK, secretRefusedText } from "../src/lib/memory/secrets";
import { getStore, resetStore } from "../src/lib/store";
import { HARMLESS_FACTS, LABELED_SECRETS } from "./memory-secrets-cases";

const FILE = process.env.MEMORY_FILE_PATH!;
const KEY = `ghp_${"Ab3dE6gH9k".repeat(4)}`;
const SECRET_FACTS = [`Der Zugang ist ${KEY}`, "Passwort: Waldgeheim42", `-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----`];

const restores: (() => void)[] = [];
beforeEach(() => {
  rmSync(`${FILE}.sqlite`, { force: true });
  rmSync(FILE, { force: true });
  resetStore();
  const log = spyOn(console, "log").mockImplementation(() => {});
  restores.push(() => log.mockRestore());
});
afterEach(() => {
  while (restores.length) restores.pop()!();
  resetStore();
});

const memory = () => getStore().memory;
const secretCases = LABELED_SECRETS.map(({ text, rest }) => [text, rest] as const);

describe("Speicher", () => {
  test.each(secretCases)("addFact und rewriteFact lehnen ab: %s", async (text, rest) => {
    expect(await memory().addFact(text)).toBe(false);
    expect(await memory().facts()).toEqual([]);
    await memory().addFact("Alex trinkt morgens Tee");
    const [fact] = await memory().facts();
    expect(await memory().rewriteFact(String(fact.id), fact.content, text)).toBe("secret");
    const stored = JSON.stringify(await memory().facts());
    for (const part of rest) expect(stored).not.toContain(part);
  });

  test.each(HARMLESS_FACTS)("Harmloses bleibt möglich (Pfad, Hash, Verweis, Maske): %s", async text => {
    expect(await memory().addFact(text)).toBe(true);
    expect((await memory().facts()).map(fact => fact.content)).toEqual([text]);
  });

  test.each(SECRET_FACTS)("addFact speichert nicht: %s", async text => {
    expect(await memory().addFact(text)).toBe(false);
    expect(await memory().facts()).toEqual([]);
  });

  test("normale Fakten bleiben möglich", async () => {
    expect(await memory().addFact("Alex trinkt morgens Tee")).toBe(true);
    expect((await memory().facts()).map(fact => fact.content)).toEqual(["Alex trinkt morgens Tee"]);
  });

  test("rewriteFact lehnt einen neuen Text mit Geheimnis ab und lässt den alten stehen", async () => {
    await memory().addFact("Alex trinkt morgens Tee");
    const [fact] = await memory().facts();
    expect(await memory().rewriteFact(String(fact.id), fact.content, "Passwort: Waldgeheim42")).toBe("secret");
    expect((await memory().facts())[0].content).toBe("Alex trinkt morgens Tee");
  });
});

describe("Merk-Tags", () => {
  test("REMEMBER mit Geheimnis wird gezählt, nicht gespeichert; der Hinweis nennt die .env und nie den Wert", async () => {
    const result = await processIntents(`[REMEMBER: Der Zugang ist ${KEY}] [REMEMBER: Alex trinkt Tee]`);
    expect(result.factsAdded).toEqual(["Alex trinkt Tee"]);
    expect(result.factsRefused).toBe(1);
    expect((await memory().facts()).map(fact => fact.content)).toEqual(["Alex trinkt Tee"]);
    const text = memoryFailureText(result)!;
    expect(text).toContain(".env");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("Speichern ist gescheitert");
  });

  test.each(secretCases)("REMEMBER lehnt ab und nennt die .env: %s", async (text, rest) => {
    const result = await processIntents(`[REMEMBER: ${text}]`);
    expect(result.factsAdded).toEqual([]);
    expect(result.factsRefused).toBe(1);
    expect(await memory().facts()).toEqual([]);
    const hint = memoryFailureText(result)!;
    expect(hint).toContain(".env");
    for (const part of rest) expect(hint).not.toContain(part);
  });

  test.each(secretCases)("bestätigter Vorschlag speichert nicht und nennt die .env: %s", async (text, rest) => {
    const decision = await decideReview("ok", "r1", {
      takePendingReview: async () => ({ id: "r1", type: "memory", chatId: "1", tags: `[REMEMBER: ${text}]`, createdAt: 0 }),
      processIntents,
    });
    const reply = decision.kind === "applied" ? decision.text : "";
    expect(reply).toBe(secretRefusedText());
    expect(reply).toContain(".env");
    for (const part of rest) expect(reply).not.toContain(part);
    expect(await memory().facts()).toEqual([]);
  });

  test("ohne Geheimnis keine Meldung", async () => {
    const result = await processIntents("[REMEMBER: Alex trinkt Tee]");
    expect(result.factsRefused).toBeUndefined();
    expect(memoryFailureText(result)).toBeNull();
  });

  test("ein bestätigter Merkvorschlag speichert kein Geheimnis und sagt warum", async () => {
    const decision = await decideReview("ok", "r1", {
      takePendingReview: async () => ({ id: "r1", type: "memory", chatId: "1", tags: "[REMEMBER: Passwort: Waldgeheim42]", createdAt: 0 }),
      processIntents,
    });
    expect(decision.kind).toBe("applied");
    expect(decision.kind === "applied" ? decision.text : "").toBe(secretRefusedText());
    expect(await memory().facts()).toEqual([]);
  });

  test("gemischter Vorschlag nennt Übernommenes und den Hinweis", async () => {
    const text = describeApplied(await processIntents("[REMEMBER: Alex trinkt Tee] [REMEMBER: Passwort: Waldgeheim42]"));
    expect(text).toContain("Teilweise übernommen: 1 Fakt(en)");
    expect(text).toContain(".env");
    expect(text).not.toContain("Waldgeheim42");
  });
});

describe("/remember", () => {
  const remember = async (args: string, addFact = (text: string) => memory().addFact(text)) => {
    const replies: string[] = [];
    const command = commandRegistry.get("remember")!;
    await command.run({
      name: "remember",
      args,
      channel: "web",
      chatId: "1",
      services: { memory: { addFact } } as unknown as CommandServices,
      reply: async (text: string) => void replies.push(text),
    } as unknown as CommandContext);
    return replies;
  };

  test("eigener Hinweis statt „Gemerkt“ oder Fehlertext, ohne den Speicher zu fragen", async () => {
    let asked = 0;
    const replies = await remember(`Der Zugang ist ${KEY}`, async () => (asked++, true));
    expect(replies).toEqual([secretRefusedText()]);
    expect(replies[0]).toContain(".env");
    expect(asked).toBe(0);
  });

  test.each(secretCases)("Hinweis auf die .env, der Speicher wird nicht gefragt: %s", async text => {
    let asked = 0;
    const replies = await remember(text, async () => (asked++, true));
    expect(replies).toEqual([secretRefusedText()]);
    expect(replies[0]).toContain(".env");
    expect(asked).toBe(0);
  });

  test("normaler Fakt wie bisher", async () => {
    expect(await remember("Alex trinkt morgens Tee")).toEqual(["Gemerkt."]);
  });
});

describe("Bereinigung", () => {
  const entry = { kennung: 7, einstufung: "umschreiben", begruendung: "kürzer", originaltext: "Alex trinkt Tee" };

  test("eine Liste mit Geheimnis im neuen Text wird abgelehnt und nennt den Wert nicht", () => {
    const parsed = parseCleanupList(JSON.stringify([{ ...entry, neuer_text: "Passwort: Waldgeheim42" }]));
    expect("problems" in parsed && parsed.problems.join()).toContain(".env");
    expect(JSON.stringify(parsed)).not.toContain("Waldgeheim42");
  });

  test("ein neuer Text mit Maske ist erlaubt: So verschwindet ein Geheimnis aus einem Altbestand", () => {
    expect("entries" in parseCleanupList(JSON.stringify([{ ...entry, neuer_text: `Passwort: ${SECRET_MASK}` }]))).toBe(true);
  });
});
