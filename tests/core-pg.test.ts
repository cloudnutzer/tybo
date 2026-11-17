/**
 * Issue #522: der Kern gegen das echte db/schema.sql. Der echte supabase-js-Client
 * und der echte Gedächtnis-Dienst laufen über postgrestFetch (tests/pg-harness.ts)
 * gegen echtes PostgreSQL. Geprüft wird der Prompt-Inhalt, nie eine Modellantwort.
 * Alle Daten sind erfunden.
 *
 * Braucht TEST_PG_URL oder TEST_PG_BIN; ohne beide übersprungen, in der CI ein
 * Fehler (wie tests/memory-fact-dates-pg.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { SQL } from "bun";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideChoice, listChoices, onChoiceDecided, setChoicesFileForTests, type Choice, type ChoiceConversation } from "../src/lib/choices";
import { fallbackContextFor } from "../src/lib/fallback/context";
import { getMemoryContext } from "../src/lib/memory";
import { coreDraftFile, coreFile, setCore } from "../src/lib/memory/core";
import { CORE_ADOPT, CORE_DISCARD, createCoreChoices, type CoreChoicesDeps } from "../src/lib/memory/core-choices";
import { buildPromptContext, buildResumePrompt, type PromptSources } from "../src/lib/prompt-builder";
import { getStore, resetStore } from "../src/lib/store";
import { resetSupabaseClient } from "../src/lib/supabase";
import { createVoiceContext } from "../src/lib/voice-brain/context";
import { pgAvailable, respondViaPg, startPg, type PgServer } from "./pg-harness";
import { FAKE_SUPABASE_URL, useFakeSupabase } from "./supabase-fixture";

const available = pgAvailable();

if (!available.ok && process.env.CI) {
  test("PostgreSQL für die Kern-Tests ist in der CI eingerichtet", () => {
    throw new Error(`${available.reason}: der Dienst pgvector in .github/workflows/check.yml fehlt`);
  });
}

/** Alles außer Gedächtnis und Kern ist leer: geprüft wird, was über die echten Quellen kommt */
const QUIET_SOURCES: Partial<PromptSources> = {
  agent: () => undefined,
  overrides: () => "",
  consultation: () => "",
  profile: async () => "Name: Alex",
  knowledge: async () => "",
  recent: async () => [],
  similar: async () => [],
  followUp: async () => ({ messages: [], facts: [] }),
  now: () => new Date("2026-10-31T09:00:00.000Z"),
  timeZone: () => "Europe/Berlin",
};

const OPTIONS = { userMessage: "Was mag Alex?", chatId: "1", agentName: "general" };
const DM: ChoiceConversation = { type: "telegram", chatId: "1" };
const CORE_HEADING = "## USER CORE";
const DRAFT = "## Wer ich bin\n- Alex, Imkerin in Görlitz";

describe.skipIf(!available.ok)("Kern gegen das echte Schema", () => {
  const cwd = process.cwd();
  let pg: PgServer;
  let service: SQL;
  let fake: ReturnType<typeof useFakeSupabase>;
  let root = "";
  let silent: ReturnType<typeof spyOn>;
  let prompts: string[];
  let sent: Choice[];
  let stopHandler: () => void;
  const saved = { budget: process.env.MEMORY_CONTEXT_CHARS };

  const seedFact = (content: string, archived = false) =>
    pg.admin.unsafe("INSERT INTO public.memory (type, content, created_at, archived_at) VALUES ('fact', $1, '2026-03-15T12:00:00Z', $2::timestamptz)", [content, archived ? "2026-10-01T12:00:00Z" : null]);

  /** Wie in src/app/bot-choices.ts: strenges Lesen über den echten Speicher */
  const coreDeps = (over: Partial<CoreChoicesDeps> = {}): CoreChoicesDeps => ({
    facts: () => getStore().memory.facts({ strict: true }),
    sendChoice: async choice => (sent.push(choice), { sent: true }),
    notify: async () => {},
    callAux: async (_purpose, prompt) => (prompts.push(prompt), { text: DRAFT, isError: false }),
    ...over,
  });

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
    root = realpathSync(mkdtempSync(join(tmpdir(), "tybo-kern-pg-")));
    process.chdir(root);
    setChoicesFileForTests(join(root, "data", "choices.json"));
    silent = spyOn(console, "log").mockImplementation(() => {});
    prompts = [];
    sent = [];
    stopHandler = () => {};
    delete process.env.MEMORY_CONTEXT_CHARS;
  });

  afterEach(() => {
    stopHandler();
    silent.mockRestore();
    setChoicesFileForTests(null);
    fake.restore();
    resetStore();
    resetSupabaseClient();
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
    if (saved.budget === undefined) delete process.env.MEMORY_CONTEXT_CHARS;
    else process.env.MEMORY_CONTEXT_CHARS = saved.budget;
  });

  test("Entwurf kommt nur aus aktiven Fakten, Archiviertes erreicht das Modell nicht", async () => {
    await seedFact("Alex mag Tee");
    await seedFact("Alex wohnte in Ulm", true);
    const core = createCoreChoices(coreDeps());
    expect(await core.offerDraft(DM)).toBe("offered");
    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("Alex mag Tee");
    expect(prompts[0]).not.toContain("Alex wohnte in Ulm");
  });

  test("Lesefehler der Tabelle ergibt keinen Entwurf und lässt den Kern, wie er ist", async () => {
    await seedFact("Alex mag Tee");
    await setCore("Stand A");
    await pg.admin.unsafe("ALTER TABLE public.memory RENAME TO memory_weg");
    try {
      const core = createCoreChoices(coreDeps());
      expect(await core.offerDraft(DM)).toBe("facts_unreadable");
    } finally {
      await pg.admin.unsafe("ALTER TABLE public.memory_weg RENAME TO memory");
    }
    expect(prompts).toEqual([]);
    expect(await listChoices()).toEqual([]);
    expect(existsSync(coreDraftFile())).toBe(false);
    const { fullPrompt } = await buildPromptContext(OPTIONS, QUIET_SOURCES);
    expect(fullPrompt).toContain(`${CORE_HEADING}`);
    expect(fullPrompt).toContain("Stand A");
  });

  test("leere Tabelle: kein Modellaufruf, kein Entwurf", async () => {
    const core = createCoreChoices(coreDeps());
    expect(await core.offerDraft(DM)).toBe("no_facts");
    expect(prompts).toEqual([]);
  });

  test("ganzer Weg: Entwurf unwirksam, nach dem Knopf in Vollprompt und Fallback, nicht im Delta", async () => {
    await seedFact("Alex mag Tee");
    const core = createCoreChoices(coreDeps());
    stopHandler = onChoiceDecided("core", core.handler);
    await core.offerDraft(DM);

    const before = await buildPromptContext(OPTIONS, QUIET_SOURCES);
    for (const text of [before.fullPrompt, before.fallbackContext]) {
      expect(text).not.toContain(CORE_HEADING);
      expect(text).not.toContain("Imkerin");
    }

    await decideChoice(sent[0].id, CORE_ADOPT, "telegram");

    const after = await buildPromptContext(OPTIONS, QUIET_SOURCES);
    for (const text of [after.fullPrompt, after.fallbackContext]) {
      expect(text).toContain(`${CORE_HEADING}`);
      expect(text).toContain(DRAFT);
      expect(text).toContain("Name: Alex");
      expect(text).toContain("Alex mag Tee");
    }
    const fallback = await fallbackContextFor({ chatId: "1", message: "Was mag Alex?" }, options => buildPromptContext(options, QUIET_SOURCES));
    expect(fallback).toContain(DRAFT);

    // Die laufende Session behält ihren Stand: Folgenachrichten tragen den Kern nicht
    const resume = await buildResumePrompt({ userMessage: "Hallo", chatId: "1", sinceMs: Date.parse("2026-01-01") }, QUIET_SOURCES);
    expect(resume).not.toContain(CORE_HEADING);
    expect(resume).not.toContain("Imkerin");
  });

  test("Ablehnen über den Knopf: nichts im Prompt", async () => {
    await seedFact("Alex mag Tee");
    const core = createCoreChoices(coreDeps());
    stopHandler = onChoiceDecided("core", core.handler);
    await core.offerDraft(DM);
    await decideChoice(sent[0].id, CORE_DISCARD, "web");
    expect((await buildPromptContext(OPTIONS, QUIET_SOURCES)).fullPrompt).not.toContain(CORE_HEADING);
    expect(existsSync(coreFile())).toBe(false);
  });

  test("Suchbudget unverändert: dieselben Fakten mit und ohne Kern, auch knapp eingestellt", async () => {
    for (let i = 0; i < 40; i++) await seedFact(`Fakt ${String(i).padStart(2, "0")} ${"x".repeat(90)}`);
    process.env.MEMORY_CONTEXT_CHARS = "1000";
    const memoryBefore = await getMemoryContext(OPTIONS.userMessage);
    const without = await buildPromptContext(OPTIONS, QUIET_SOURCES);

    await setCore("k".repeat(1500));

    const memoryAfter = await getMemoryContext(OPTIONS.userMessage);
    const withCore = await buildPromptContext(OPTIONS, QUIET_SOURCES);
    expect(memoryAfter).toBe(memoryBefore);
    expect(memoryBefore).toContain("facts shown");
    expect(withCore.fullPrompt).toContain(`## MEMORY\n${memoryBefore}`);
    expect(without.fullPrompt).toContain(`## MEMORY\n${memoryBefore}`);
    expect(withCore.fullPrompt.length).toBeGreaterThan(without.fullPrompt.length + 1500);
    // Bis auf den Abschnitt selbst ist der Prompt derselbe
    expect(withCore.fullPrompt.replace(/## USER CORE[^\n]*\nk+\n\n---\n\n/, "")).toBe(without.fullPrompt);
  });

  test("ohne Kern und ohne Datei: kein Abschnitt, Prompt wie mit leerer Quelle", async () => {
    await seedFact("Alex mag Tee");
    const real = await buildPromptContext(OPTIONS, QUIET_SOURCES);
    const empty = await buildPromptContext(OPTIONS, { ...QUIET_SOURCES, core: async () => "" });
    expect(real).toEqual(empty);
    expect(real.fullPrompt).not.toContain(CORE_HEADING);
    expect(real.fallbackContext).not.toContain(CORE_HEADING);
    expect(existsSync(coreFile())).toBe(false);
  });

  test("Sprachgespräche bekommen den Kern nicht", async () => {
    await seedFact("Alex mag Tee");
    await setCore("Geheimer Kern");
    const voice = createVoiceContext({
      agent: { systemPrompt: "Du bist am Telefon." },
      deps: { getUserProfile: async () => "", getMemoryContext: () => getMemoryContext(), getRecentMessages: async () => [] },
    });
    const text = await voice.load("1");
    expect(text).toContain("Alex mag Tee");
    expect(text).not.toContain("Geheimer Kern");
  });
});

describe("Kern ohne Datenbank", () => {
  const cwd = process.cwd();
  const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, path: process.env.MEMORY_FILE_PATH };
  let root = "";
  let silent: ReturnType<typeof spyOn>;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "tybo-kern-datei-")));
    process.chdir(root);
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.MEMORY_FILE_PATH = join(root, "memory.json");
    resetStore();
    setChoicesFileForTests(join(root, "data", "choices.json"));
    silent = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    silent.mockRestore();
    setChoicesFileForTests(null);
    for (const [name, value] of [["SUPABASE_URL", saved.url], ["SUPABASE_SERVICE_ROLE_KEY", saved.key], ["MEMORY_FILE_PATH", saved.path]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    resetStore();
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  const sources: Partial<PromptSources> = { ...QUIET_SOURCES };

  test("ohne Kern bisheriges Verhalten: alle Fakten im Kontext, kein Abschnitt", async () => {
    await getStore().memory.addFact("Alex mag Tee");
    const { fullPrompt } = await buildPromptContext(OPTIONS, sources);
    expect(fullPrompt).toContain("Alex mag Tee");
    expect(fullPrompt).not.toContain(CORE_HEADING);
  });

  test("Entwurf aus der lokalen Ablage, übernommen steht er im Prompt", async () => {
    await getStore().memory.addFact("Alex mag Tee");
    const prompts: string[] = [];
    const sent: Choice[] = [];
    const core = createCoreChoices({
      facts: () => getStore().memory.facts({ strict: true }),
      sendChoice: async choice => (sent.push(choice), { sent: true }),
      notify: async () => {},
      callAux: async (_purpose, prompt) => (prompts.push(prompt), { text: DRAFT, isError: false }),
    });
    const off = onChoiceDecided("core", core.handler);
    try {
      expect(await core.offerDraft(DM)).toBe("offered");
      expect(prompts[0]).toContain("Alex mag Tee");
      await decideChoice(sent[0].id, CORE_ADOPT, "web");
    } finally {
      off();
    }
    const { fullPrompt } = await buildPromptContext(OPTIONS, sources);
    expect(fullPrompt).toContain(DRAFT);
  });
});
