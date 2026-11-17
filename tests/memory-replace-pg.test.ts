/**
 * Issue #521: Regeln fürs Merken. Die Beispiele aus dem Prompt laufen durch
 * den echten Parser; ein neuer Stand ersetzt den alten über den echten Dienst
 * gegen das echte Schema (tests/pg-harness.ts). Der Dienst wendet REMEMBER vor
 * FORGET an, ein Suchtext wirkt also auch auf den neuen Fakt derselben
 * Antwort. Alle Daten sind erfunden.
 *
 * Die PostgreSQL-Teile brauchen TEST_PG_URL oder TEST_PG_BIN; ohne beide
 * übersprungen, in der CI ein Fehler (wie tests/schema-basis-pg.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { SQL } from "bun";
import { MEMORY_RULES, MEMORY_TAGS_SECTION } from "../src/agents/prompt-parts";
import { KNOWLEDGE_CATEGORIES } from "../src/lib/knowledge-categories";
import { processIntents, setMemoryAsker, type AmbiguousMatch } from "../src/lib/memory";
import { parseMemoryIntents } from "../src/lib/memory/intents";
import { DISTILL_PROMPT, describeTags } from "../src/lib/session-distill";
import { passesPrefilter } from "../src/lib/threads/detect";
import { pgAvailable, respondViaPg, startPg, type PgServer } from "./pg-harness";
import { FAKE_SUPABASE_URL, useFakeSupabase } from "./supabase-fixture";

const available = pgAvailable();

if (!available.ok && process.env.CI) {
  test("PostgreSQL für die Merk-Regeln ist in der CI eingerichtet", () => {
    throw new Error(`${available.reason}: der Dienst pgvector in .github/workflows/check.yml fehlt`);
  });
}

describe("Regeln im Prompt", () => {
  test("die Beispiele sind vom Parser lesbar, das FORGET-Beispiel trifft nur den alten Stand", () => {
    const intents = parseMemoryIntents(MEMORY_RULES);
    const fact = intents.find(i => i.type === "fact" && i.text.includes("as of 2026-10-31"));
    const forget = intents.find(i => i.type === "forget" && i.query.startsWith("as of"));
    expect(fact).toEqual({ type: "fact", text: "Bike repair as of 2026-10-31: parts ordered" });
    expect(forget).toEqual({ type: "forget", query: "as of 2026-10-20" });
    expect(fact?.type === "fact" && forget?.type === "forget" && fact.text.includes(forget.query)).toBe(false);
  });

  test("KNOWLEDGE ist samt allen gültigen Kategorien erklärt und vom Parser lesbar", () => {
    for (const category of KNOWLEDGE_CATEGORIES) expect(MEMORY_RULES).toContain(category);
    expect(MEMORY_TAGS_SECTION).toContain("[KNOWLEDGE: category | title | content | project]");
    expect(parseMemoryIntents("[KNOWLEDGE: learning | Teekannen | Gusseisen hält die Wärme | Haushalt]")).toEqual([
      { type: "knowledge", category: "learning", title: "Teekannen", content: "Gusseisen hält die Wärme", project: "Haushalt" },
    ]);
  });

  test("die alte, weiche Formulierung ist weg, die neue Regel steht da", () => {
    expect(MEMORY_TAGS_SECTION).not.toContain("worth keeping");
    expect(MEMORY_RULES).toContain("only if a later session would act differently");
    expect(MEMORY_RULES).toContain("Having nothing to remember is a good outcome");
    expect(MEMORY_RULES).not.toContain("—");
  });

  test("Datum in eckigen Klammern zerreißt den Tag: darum verbietet der Prompt sie", () => {
    expect(parseMemoryIntents("[REMEMBER: Stand [2026-10-31] Teile bestellt]")).toEqual([{ type: "fact", text: "Stand [2026-10-31" }]);
    expect(MEMORY_RULES).toContain("Never use square brackets inside a tag");
  });

  test("ein | im Inhalt verschiebt die Stellen von KNOWLEDGE: darum verbietet der Prompt es", () => {
    expect(parseMemoryIntents("[KNOWLEDGE: reference | Tee | Grün | Schwarz]")).toEqual([{ type: "knowledge", category: "reference", title: "Tee", content: "Grün", project: "Schwarz" }]);
    expect(MEMORY_RULES).toContain("Never use | or square brackets inside the parts");
  });
});

describe("Session-Rückblick", () => {
  test("trennt Recherche von Fakten, verlangt die neue Regel und alle Beispiele sind lesbar", () => {
    expect(DISTILL_PROMPT).toContain("durch die eine spaetere Session anders handelt");
    expect(DISTILL_PROMPT).toContain("Recherche-Ergebnisse nie als REMEMBER, sondern als KNOWLEDGE");
    expect(parseMemoryIntents(DISTILL_PROMPT).map(i => i.type).sort()).toEqual(["fact", "forget", "goal", "knowledge"]);
    expect(describeTags("[KNOWLEDGE: reference | Tee | Grün]")).toContain("Wissen speichern");
  });
});

describe("Offene Fäden", () => {
  test("eine Frage nur im KNOWLEDGE-Tag gilt nicht als offene Frage an den Nutzer", () => {
    expect(passesPrefilter("Fertig. [KNOWLEDGE: reference | Tee | Welche Option ist besser?]")).toBe(false);
  });
});

describe.skipIf(!available.ok)("Ersetzen gegen das echte Schema", () => {
  const OLD = "Radreparatur Stand 2026-10-20: wartet auf Teile";
  const NEW = "Radreparatur Stand 2026-10-31: Teile bestellt";
  const where = { conversation: { kind: "web" } } as unknown as Parameters<typeof processIntents>[1];
  let pg: PgServer;
  let service: SQL;
  let fake: ReturnType<typeof useFakeSupabase>;
  const spies: { mockRestore(): void }[] = [];

  beforeAll(async () => {
    pg = await startPg();
    await pg.applySchema();
    service = await pg.connect("service_role");
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  beforeEach(async () => {
    await pg.admin.unsafe("TRUNCATE public.memory RESTART IDENTITY");
    await pg.admin.unsafe("INSERT INTO public.memory (type, content) VALUES ('fact', $1)", [OLD]);
    fake = useFakeSupabase({ respond: respondViaPg(service, FAKE_SUPABASE_URL) });
    spies.push(spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {}));
  });

  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
    setMemoryAsker(null);
    fake.restore();
  });

  const facts = async () => [...(await pg.admin.unsafe("SELECT content FROM public.memory WHERE type = 'fact' ORDER BY id"))].map(r => r.content as string);

  test("Suchtext nur aus dem alten Stand: alt weg, neu da, auch wenn FORGET im Text zuerst steht", async () => {
    const result = await processIntents(`[FORGET: Stand 2026-10-20] [REMEMBER: ${NEW}]`);
    expect(result.factsAdded).toEqual([NEW]);
    expect(result.factsRemoved).toEqual(["Stand 2026-10-20"]);
    expect(await facts()).toEqual([NEW]);
  });

  test("breiter Suchtext trifft alt und neu: nichts gelöscht, Rückfrage nennt beide", async () => {
    const questions: AmbiguousMatch[] = [];
    setMemoryAsker(async question => {
      questions.push(question);
      return true;
    });
    const result = await processIntents(`[REMEMBER: ${NEW}] [FORGET: Radreparatur]`, where);
    expect(result.factsRemoved).toEqual([]);
    expect(result.asked).toEqual([{ action: "forget", query: "Radreparatur" }]);
    expect(questions[0].matches.map(m => m.content)).toEqual([OLD, NEW]);
    expect(await facts()).toEqual([OLD, NEW]);
  });

  test("breiter Suchtext ohne Gespräch: nichts gelöscht", async () => {
    const result = await processIntents(`[REMEMBER: ${NEW}] [FORGET: Radreparatur]`);
    expect(result.factsRemoved).toEqual([]);
    expect(await facts()).toEqual([OLD, NEW]);
  });

  test("Suchtext, der nur den neuen Stand trifft, löscht ihn: darum verlangt der Prompt Wörter aus dem alten", async () => {
    const result = await processIntents(`[REMEMBER: ${NEW}] [FORGET: Teile bestellt]`);
    expect(result.factsAdded).toEqual([NEW]);
    expect(result.factsRemoved).toEqual(["Teile bestellt"]);
    expect(await facts()).toEqual([OLD]);
    expect(MEMORY_RULES).toContain("words that occur only in the old fact");
  });
});
