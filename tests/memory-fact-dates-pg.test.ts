/**
 * Issue #519: Datum und Vorbehalt auf allen Wegen, die Fakten in einen Prompt
 * geben, gegen das echte db/schema.sql: Vollprompt, Resume-Delta,
 * Fallback-Kontext, Sprachgespräch und Anruf. Der echte supabase-js-Client und
 * der echte Gedächtnis-Dienst laufen über postgrestFetch (tests/pg-harness.ts)
 * gegen echtes PostgreSQL. Alle Daten sind erfunden.
 *
 * Braucht TEST_PG_URL oder TEST_PG_BIN; ohne beide übersprungen, in der CI
 * ein Fehler (wie tests/memory-goals-pg.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { fallbackContextFor } from "../src/lib/fallback/context";
import { getMemoryContext } from "../src/lib/memory";
import { FACT_DATE_NOTE, memoryContext } from "../src/lib/memory/context";
import { callVariables, MEMORY_MAX_CHARS } from "../src/lib/phone/context";
import { buildPromptContext, buildResumePrompt, type PromptSources } from "../src/lib/prompt-builder";
import { getStore, resetStore, storeOr } from "../src/lib/store";
import { resetSupabaseClient } from "../src/lib/supabase";
import { createVoiceContext } from "../src/lib/voice-brain/context";
import { pgAvailable, respondViaPg, startPg, type PgServer } from "./pg-harness";
import { FAKE_SUPABASE_URL, useFakeSupabase } from "./supabase-fixture";

const available = pgAvailable();

if (!available.ok && process.env.CI) {
  test("PostgreSQL für die Datums-Tests ist in der CI eingerichtet", () => {
    throw new Error(`${available.reason}: der Dienst pgvector in .github/workflows/check.yml fehlt`);
  });
}

/** Alles außer dem Gedächtnis ist leer: geprüft wird nur, was über die echte Tabelle kommt */
const QUIET_SOURCES: Partial<PromptSources> = {
  agent: () => undefined,
  overrides: () => "",
  consultation: () => "",
  profile: async () => "",
  knowledge: async () => "",
  recent: async () => [],
  similar: async () => [],
  followUp: async () => ({ messages: [], facts: [] }),
  now: () => new Date("2026-10-31T09:00:00.000Z"),
  timeZone: () => "Europe/Berlin",
};

const DATED = "- [2026-03-15] Alex mag Tee";
const UNDATED = "- [Anlagedatum unbekannt] Mia spielt Cello";

describe.skipIf(!available.ok)("Datum und Vorbehalt gegen das echte Schema", () => {
  let pg: PgServer;
  let service: SQL;
  let fake: ReturnType<typeof useFakeSupabase>;
  const saved = { zone: process.env.USER_TIMEZONE, budget: process.env.MEMORY_CONTEXT_CHARS };

  const restore = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  const seedFact = (content: string, createdAt: string | null) =>
    pg.admin.unsafe("INSERT INTO public.memory (type, content, created_at) VALUES ('fact', $1, $2::timestamptz)", [content, createdAt]);
  const seedGoal = (content: string) => pg.admin.unsafe("INSERT INTO public.memory (type, content) VALUES ('goal', $1)", [content]);

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
    fake = useFakeSupabase({ respond: respondViaPg(service, FAKE_SUPABASE_URL) });
    resetStore();
    resetSupabaseClient();
    // In Berlin ist 23:30 UTC schon der nächste Tag: zeigt, dass die Zone zählt
    process.env.USER_TIMEZONE = "Europe/Berlin";
    delete process.env.MEMORY_CONTEXT_CHARS;
  });

  afterEach(() => {
    fake.restore();
    resetStore();
    resetSupabaseClient();
    restore("USER_TIMEZONE", saved.zone);
    restore("MEMORY_CONTEXT_CHARS", saved.budget);
  });

  async function seedBoth() {
    await seedFact("Alex mag Tee", "2026-03-14T23:30:00Z");
    await seedFact("Mia spielt Cello", null);
    await seedGoal("Mehr lesen");
  }

  test("created_at ist im Schema nullable, ein Fakt ohne Zeitpunkt lässt sich anlegen", async () => {
    await seedBoth();
    const rows = (await pg.admin.unsafe("SELECT content, created_at FROM public.memory WHERE type = 'fact' ORDER BY id")) as { content: string; created_at: Date | null }[];
    expect(rows[1].created_at).toBeNull();
    expect(rows[0].created_at).toBeInstanceOf(Date);
  });

  test("Dienst: festes Datum in der Zone des Nutzers, unbekanntes Datum gekennzeichnet", async () => {
    await seedBoth();
    const context = await getMemoryContext();
    expect(context).toContain(DATED);
    expect(context).toContain(UNDATED);
    expect(context).toContain(`**Known Facts:**\n${FACT_DATE_NOTE}\n`);
    expect(context).toContain("**Active Goals:**\n1. Mehr lesen");
  });

  test("Vollprompt und fallbackContext tragen Datum und Vorbehalt", async () => {
    await seedBoth();
    const { fullPrompt, fallbackContext } = await buildPromptContext({ userMessage: "Was mag Alex?", chatId: "1", agentName: "general" }, QUIET_SOURCES);
    for (const text of [fullPrompt, fallbackContext]) {
      expect(text).toContain(FACT_DATE_NOTE);
      expect(text).toContain(DATED);
      expect(text).toContain(UNDATED);
    }
  });

  test("Ersatzmodell mit eigener Unterhaltung: derselbe fallbackContext", async () => {
    await seedBoth();
    const context = await fallbackContextFor(
      { chatId: "1", message: "Was mag Alex?" },
      options => buildPromptContext(options, QUIET_SOURCES),
    );
    expect(context).toContain(FACT_DATE_NOTE);
    expect(context).toContain(DATED);
  });

  test("Resume-Delta: neue Fakten mit Datum und Vorbehalt, ältere und solche ohne Zeitpunkt nicht", async () => {
    await seedBoth();
    await seedFact("Alex lernt Geige", "2026-10-30T23:30:00Z");
    const since = new Date("2026-10-01T00:00:00.000Z");
    const prompt = await buildResumePrompt({ userMessage: "Hallo", chatId: "1", sinceMs: since.getTime() }, QUIET_SOURCES);
    expect(prompt).toContain(`${FACT_DATE_NOTE}\n- [fact] [2026-10-31] Alex lernt Geige`);
    expect(prompt).not.toContain("Alex mag Tee");
    expect(prompt).not.toContain("Mia spielt Cello");
  });

  test("Sprachgespräch: createVoiceContext mit dem Dienst", async () => {
    await seedBoth();
    const voice = createVoiceContext({
      agent: { systemPrompt: "Du bist am Telefon." },
      deps: { getUserProfile: async () => "", getMemoryContext: () => getMemoryContext(), getRecentMessages: async () => [] },
    });
    const text = await voice.load("1");
    expect(text).toContain(`## MEMORY\n**Known Facts:**\n${FACT_DATE_NOTE}\n`);
    expect(text).toContain(DATED);
    expect(text).toContain(UNDATED);
  });

  test("Anruf wie in src/lib/phone/index.ts: viele Fakten, gekürzt auf ganze datierte Einträge", async () => {
    for (let i = 0; i < 30; i++) await seedFact(`Fakt ${String(i).padStart(2, "0")} ${"y".repeat(70)}`, `2026-03-${String(i % 28 + 1).padStart(2, "0")}T12:00:00Z`);
    const { memory } = await callVariables(
      { reason: "", userName: "Alex", conversation: { type: "telegram", chatId: "1", topicId: null } } as unknown as Parameters<typeof callVariables>[0],
      { memory: () => storeOr("", store => memoryContext(store.memory)), recent: async () => [] },
    );
    expect(memory.length).toBeLessThanOrEqual(MEMORY_MAX_CHARS);
    expect(memory.startsWith(`**Known Facts:**\n${FACT_DATE_NOTE}\n- [2026-03-`)).toBe(true);
    const lines = memory.split("\n").slice(2);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/^- \[2026-03-\d\d\] Fakt \d\d y{70}$/);
  });

  test("Budgetgrenze mit elf Fakten über MEMORY_CONTEXT_CHARS: das Datum zählt", async () => {
    const content = (i: number) => `Fakt ${String(i).padStart(2, "0")} ${"x".repeat(92)}`;
    for (let i = 0; i < 11; i++) await seedFact(content(i), "2026-03-14T12:00:00Z");
    const LINE = "- [2026-03-14] ".length + 100 + 1;
    const facts = (text: string) => text.split("\n").filter(line => line.startsWith("- ")).length;

    process.env.MEMORY_CONTEXT_CHARS = String(LINE * 11);
    const exact = await getMemoryContext();
    expect(facts(exact)).toBe(11);
    expect(exact).not.toContain("facts shown");

    process.env.MEMORY_CONTEXT_CHARS = String(LINE * 11 - 1);
    const below = await getMemoryContext();
    expect(facts(below)).toBe(10);
    expect(below).toContain("(10 of 11 facts shown");
  });

  test("leeres Gedächtnis: kein Vorbehalt in Vollprompt, Delta und Anruf", async () => {
    expect(await getMemoryContext()).toBe("");
    const { fullPrompt, fallbackContext } = await buildPromptContext({ userMessage: "Hallo", chatId: "1", agentName: "general" }, QUIET_SOURCES);
    const resume = await buildResumePrompt({ userMessage: "Hallo", chatId: "1", sinceMs: 1 }, QUIET_SOURCES);
    for (const text of [fullPrompt, fallbackContext, resume]) expect(text).not.toContain(FACT_DATE_NOTE);
    expect(await getStore().memory.facts()).toEqual([]);
  });
});
