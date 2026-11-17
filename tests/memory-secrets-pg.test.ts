/**
 * Issue #524 gegen das echte Schema samt Migrationen: Der ganze Weg läuft über
 * echten Prompt-Builder, Speicher, Rückfragen-Register und Befehl, mit supabase-js
 * über postgrestFetch gegen PostgreSQL. Attrappen sind nur der Embedding-Anbieter
 * (zählt jeden Aufruf) und der Versand. Alle Werte sind erfunden.
 *
 * Braucht TEST_PG_URL oder TEST_PG_BIN; ohne beide übersprungen, in der CI ein
 * Fehler (wie tests/schema-basis-pg.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { SQL } from "bun";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTybo } from "../scripts/tybo";
import { decideChoice, listChoices, onChoiceDecided, setChoicesFileForTests } from "../src/lib/choices";
import { commandRegistry } from "../src/lib/commands/builtin";
import type { CommandContext, CommandServices } from "../src/lib/commands/types";
import { resetCredentialCacheForTests } from "../src/lib/credentials";
import { TABLE_SPECS } from "../src/lib/embedding-reindex";
import { decideReview, gateTurnIntents } from "../src/lib/intent-gate";
import { getMemoryContext, listFacts, processIntents } from "../src/lib/memory";
import { memoryContext } from "../src/lib/memory/context";
import { coreForPrompt } from "../src/lib/memory/core";
import { createSecretChoices, SECRET_KEYS, secretDecisionsFile } from "../src/lib/memory/secret-review";
import { SECRET_MASK, secretRefusedText } from "../src/lib/memory/secrets";
import type { SendAndRecordInput, SendAndRecordResult } from "../src/lib/outbox";
import { buildPromptContext, buildResumePrompt, type PromptSources } from "../src/lib/prompt-builder";
import { setPendingReviewsFileForTests, setReviewNotifier, takePendingReview } from "../src/lib/session-distill";
import { getStore, resetStore } from "../src/lib/store";
import { resetSupabaseClient } from "../src/lib/supabase";
import { createHistorySearchHandler } from "../src/lib/tools/history-search";
import { createVoiceContext } from "../src/lib/voice-brain/context";
import { clearRegistryCache } from "../supabase/functions/_shared/embedding";
import { pad } from "./memory-fixture";
import { HARMLESS_FACTS, LABELED_SECRETS } from "./memory-secrets-cases";
import { pgAvailable, respondViaPg, startPg, type PgServer } from "./pg-harness";
import { FAKE_SUPABASE_URL, useFakeSupabase } from "./supabase-fixture";

const available = pgAvailable();

if (!available.ok && process.env.CI) {
  test("PostgreSQL für die Geheimnisse in Fakten ist in der CI eingerichtet", () => {
    throw new Error(`${available.reason}: der Dienst pgvector in .github/workflows/check.yml fehlt`);
  });
}

const OWNER = "4711";
const PASSWORD = "Waldgeheim42";
const KEY = `ghp_${"Ab3dE6gH9k".repeat(4)}`;
const KEY_BODY = "Zy8xW5vU2t".repeat(6);
const PEM = `-----BEGIN PRIVATE KEY-----\n${KEY_BODY}\n${KEY_BODY}\n-----END PRIVATE KEY-----`;
const PASSWORD_FACT = `Imkerei: Seite imker.example, Passwort: ${PASSWORD}`;
const KEY_FACT = `Imkerei: Zugang zum Lager ist ${KEY}`;
const PEM_FACT = `Imkerei: Schlüssel fürs Tor\n${PEM}\nbitte aufheben`;
const HARMLESS = "Imkerei: Commit 0123456789abcdef0123456789abcdef01234567, Pfad /Users/alex/.ssh/id_rsa, Kundennummer 1234567890";

const QUIET: Partial<PromptSources> = {
  agent: () => undefined,
  overrides: () => "",
  consultation: () => "",
  profile: async () => "",
  core: async () => "",
  knowledge: async () => "",
  recent: async () => [],
  similar: async () => [],
  now: () => new Date("2026-10-31T09:00:00.000Z"),
  timeZone: () => "Europe/Berlin",
};

/**
 * Die Textfelder aus data/choices.json, die ein Mensch zu sehen bekommt: Fragetext,
 * Knöpfe, Ergebnis und Fehlermeldung. Zeitstempel und Kennungen bleiben außen vor,
 * sonst träfe ein kurzer Wertrest wie "456" zufällig eine Ziffernfolge in expiresAt.
 */
const choiceTexts = (file: string): string[] => {
  const stored = JSON.parse(readFileSync(file, "utf8")) as {
    choices: Record<string, { text: string; options: { label: string }[]; result?: { label: string }; handlerError?: { message: string } }>;
  };
  return Object.values(stored.choices).flatMap(choice => [
    choice.text,
    ...choice.options.map(option => option.label),
    ...(choice.result ? [choice.result.label] : []),
    ...(choice.handlerError ? [choice.handlerError.message] : []),
  ]);
};

const expectClean = (text: string) => {
  expect(text).not.toContain(PASSWORD);
  expect(text).not.toContain(KEY);
  expect(text).not.toContain(KEY_BODY);
  expect(text).not.toContain("BEGIN PRIVATE KEY");
};

describe.skipIf(!available.ok)("Geheimnisse in Fakten gegen das echte Schema", () => {
  const cwd = process.cwd();
  let pg: PgServer;
  let service: SQL;
  let fake: ReturnType<typeof useFakeSupabase>;
  let root = "";
  /** Texte, die beim Anbieter ankamen */
  let embeddings: string[];
  let notices: string[];
  let out: string[];
  let logs: string[];
  let stopHandler: () => void;
  const spies: { mockRestore(): void }[] = [];
  const savedBudget = process.env.MEMORY_CONTEXT_CHARS;

  /** Altbestand direkt in die Tabelle: Der Speicher nimmt solche Texte nicht mehr an */
  const seedFact = async (content: string, created = "2026-03-15T12:00:00Z") => {
    const rows = await pg.admin.unsafe("INSERT INTO public.memory (type, content, created_at) VALUES ('fact', $1, $2::timestamptz) RETURNING id", [content, created]);
    return String(rows[0].id);
  };
  const rows = () => pg.admin.unsafe("SELECT id, content, embedding, archived_at FROM public.memory ORDER BY id") as Promise<{ id: unknown; content: string; embedding: unknown; archived_at: unknown }[]>;
  const memory = () => getStore().memory;
  /** Der Vektor wird im Hintergrund nachgetragen */
  const settled = () => new Promise(resolve => setTimeout(resolve, 300));

  const tybo = (...args: string[]) =>
    runTybo({
      args: ["gedaechtnis", ...args],
      env: { ...process.env, TELEGRAM_BOT_TOKEN: "1:token", TELEGRAM_USER_ID: OWNER },
      root,
      out: line => void out.push(line),
      err: line => void out.push(line),
      secretReview: {
        createApi: () => ({ editMessageText: async () => true, editMessageReplyMarkup: async () => true }) as never,
        send: async (_input: SendAndRecordInput) => ({ sent: true, recorded: true }) as unknown as SendAndRecordResult,
      },
    });

  const remember = async (args: string) => {
    const replies: string[] = [];
    await commandRegistry.get("remember")!.run({
      name: "remember",
      args,
      channel: "web",
      chatId: OWNER,
      services: { memory: { addFact: (text: string) => memory().addFact(text) } } as unknown as CommandServices,
      reply: async (text: string) => void replies.push(text),
    } as unknown as CommandContext);
    return replies;
  };

  beforeAll(async () => {
    pg = await startPg();
    await pg.applySchema();
    service = await pg.connect("service_role");
  }, 60_000);

  // Das Löschen der Datenbank wartet auf laufende Checkpoints und Autovacuum, nach sieben Minuten Laufzeit auch länger als die 5 s von bun
  afterAll(async () => {
    await pg?.close();
  }, 60_000);

  beforeEach(async () => {
    await pg.admin.unsafe("TRUNCATE public.memory, public.messages, public.embedding_settings RESTART IDENTITY CASCADE");
    await pg.admin.unsafe(`INSERT INTO public.embedding_settings (id, state, provider, model) VALUES (true, 'festgehalten', 'openai', 'text-embedding-3-small')`);
    embeddings = [];
    notices = [];
    out = [];
    logs = [];
    clearRegistryCache();
    root = realpathSync(mkdtempSync(join(tmpdir(), "tybo-geheimnisse-pg-")));
    process.chdir(root);
    process.env.MEMORY_CONTEXT_CHARS = "6000";
    setChoicesFileForTests(join(root, "data", "choices.json"));
    setPendingReviewsFileForTests(join(root, "data", "pending-reviews.json"));
    const rest = respondViaPg(service, FAKE_SUPABASE_URL);
    fake = useFakeSupabase({
      respond: request => {
        if (request.url.hostname === "api.openai.com") {
          embeddings.push(JSON.parse(request.body).input as string);
          return Response.json({ data: [{ embedding: pad([1]) }] });
        }
        return rest(request);
      },
    });
    // Nach useFakeSupabase, das den Schlüssel leert: Mit ihm fragt der Speicher den Anbieter wirklich, sonst bewiese „kein Aufruf“ nichts
    process.env.OPENAI_API_KEY = "sk-test-im-bot";
    resetStore();
    resetSupabaseClient();
    resetCredentialCacheForTests();
    expect(getStore().backend).toBe("supabase");
    const note = (...args: unknown[]) => void logs.push(args.join(" "));
    spies.push(spyOn(console, "log").mockImplementation(note), spyOn(console, "warn").mockImplementation(note), spyOn(console, "error").mockImplementation(note));
    stopHandler = onChoiceDecided(
      "secret",
      createSecretChoices({ file: secretDecisionsFile(root), memory, notify: async (_c, text) => void notices.push(text), log: note }).handler,
    );
  }, 60_000);

  afterEach(() => {
    stopHandler();
    setReviewNotifier(null);
    while (spies.length) spies.pop()!.mockRestore();
    setChoicesFileForTests(null);
    setPendingReviewsFileForTests(null);
    fake.restore();
    resetStore();
    resetSupabaseClient();
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
    if (savedBudget === undefined) delete process.env.MEMORY_CONTEXT_CHARS;
    else process.env.MEMORY_CONTEXT_CHARS = savedBudget;
  });

  describe("abgelehnte Werte", () => {
    test.each([KEY_FACT, PASSWORD_FACT, PEM_FACT])("addFact: weder gespeichert noch beim Anbieter: %s", async text => {
      expect(await memory().addFact(text)).toBe(false);
      await settled();
      expect(await rows()).toEqual([]);
      expect(embeddings).toEqual([]);
    });

    test.each(LABELED_SECRETS.map(({ text, rest }) => [text, rest] as const))("jede Schreibweise, alle Wege: nichts gespeichert, nichts beim Anbieter, Hinweis auf die .env: %s", async (text, rest) => {
      expect(await memory().addFact(text)).toBe(false);
      const replies = await remember(text);
      expect(replies).toEqual([secretRefusedText()]);
      expect(replies[0]).toContain(".env");
      const result = await processIntents(`[REMEMBER: ${text}]`);
      expect(result.factsRefused).toBe(1);
      await settled();
      expect(await rows()).toEqual([]);
      expect(embeddings).toEqual([]);
      const id = await seedFact("Alex trinkt morgens Tee");
      expect(await memory().rewriteFact(id, "Alex trinkt morgens Tee", text)).toBe("secret");
      await settled();
      expect((await rows()).map(row => row.content)).toEqual(["Alex trinkt morgens Tee"]);
      expect(embeddings).toEqual([]);
      const logged = logs.join("\n");
      for (const part of rest) expect(logged).not.toContain(part);
    });

    test.each(LABELED_SECRETS.map(({ text, rest }) => [text, rest] as const))("bestätigter Vorschlag: Vorschau maskiert, nichts gespeichert, nichts beim Anbieter, Hinweis auf die .env: %s", async (text, rest) => {
      const previews: string[] = [];
      setReviewNotifier(async proposal => void previews.push(proposal.text));
      const { outcome } = await gateTurnIntents(`[REMEMBER: ${text}]`, { uses: [] }, { chatId: OWNER, origin: "Test", foreignInput: "Datei" });
      expect(outcome).toBe("staged");
      expect(previews).toHaveLength(1);
      expect(previews[0]).toContain(SECRET_MASK);
      const stored = JSON.parse(readFileSync(join(root, "data", "pending-reviews.json"), "utf8"));
      const decision = await decideReview("ok", Object.keys(stored.reviews ?? stored)[0], { takePendingReview, processIntents });
      const reply = decision.kind === "applied" ? decision.text : decision.kind;
      expect(reply).toBe(secretRefusedText());
      expect(reply).toContain(".env");
      await settled();
      expect(await rows()).toEqual([]);
      expect(embeddings).toEqual([]);
      for (const part of rest) for (const shown of [previews[0], reply, logs.join("\n")]) expect(shown).not.toContain(part);
    });

    test.each(HARMLESS_FACTS)("Harmloses wird gespeichert und erreicht den Anbieter (Pfad, Hash, Verweis, Maske): %s", async text => {
      expect(await memory().addFact(text)).toBe(true);
      await settled();
      expect((await rows()).map(row => row.content)).toEqual([text]);
      expect(embeddings).toEqual([text]);
    });

    test("/remember: Hinweis auf die .env, nichts gespeichert, nichts beim Anbieter", async () => {
      expect(await remember(KEY_FACT)).toEqual([secretRefusedText()]);
      await settled();
      expect(await rows()).toEqual([]);
      expect(embeddings).toEqual([]);
    });

    test("REMEMBER-Tag: gezählt, nicht gespeichert, nichts beim Anbieter; daneben ein normaler Fakt geht durch", async () => {
      const result = await processIntents(`[REMEMBER: ${KEY_FACT}] [REMEMBER: Alex trinkt morgens Tee]`);
      expect(result.factsRefused).toBe(1);
      await settled();
      expect((await rows()).map(row => row.content)).toEqual(["Alex trinkt morgens Tee"]);
      expect(embeddings).toEqual(["Alex trinkt morgens Tee"]);
    });

    test("rewriteFact: alter Text und alter Vektor bleiben, nichts beim Anbieter", async () => {
      const id = await seedFact("Alex trinkt morgens Tee");
      expect(await memory().rewriteFact(id, "Alex trinkt morgens Tee", PASSWORD_FACT)).toBe("secret");
      expect((await rows())[0].content).toBe("Alex trinkt morgens Tee");
      expect(embeddings).toEqual([]);
    });

    test("Vorschlag aus einem Turn mit fremden Inhalten: Vorschau maskiert, Bestätigen speichert nichts und sagt warum", async () => {
      const previews: string[] = [];
      setReviewNotifier(async proposal => void previews.push(proposal.text));
      const { outcome } = await gateTurnIntents(`[REMEMBER: ${PASSWORD_FACT}]`, { uses: [] }, { chatId: OWNER, origin: "Test", foreignInput: "Datei" });
      expect(outcome).toBe("staged");
      expect(previews).toHaveLength(1);
      expectClean(previews[0]);
      expect(previews[0]).toContain(SECRET_MASK);

      const stored = JSON.parse(readFileSync(join(root, "data", "pending-reviews.json"), "utf8"));
      const reviewId = Object.keys(stored.reviews ?? stored)[0];
      const decision = await decideReview("ok", reviewId, { takePendingReview, processIntents });
      expect(decision.kind === "applied" ? decision.text : decision.kind).toBe(secretRefusedText());
      await settled();
      expect(await rows()).toEqual([]);
      expect(embeddings).toEqual([]);
    });

    test("kein Log nennt den Wert", async () => {
      await remember(KEY_FACT);
      await processIntents(`[REMEMBER: ${PASSWORD_FACT}]`);
      await memory().addFact(PEM_FACT);
      expectClean(logs.join("\n"));
    });
  });

  describe("Altbestand im Prompt", () => {
    beforeEach(async () => {
      await seedFact(PASSWORD_FACT);
      await seedFact(KEY_FACT);
      await seedFact(PEM_FACT);
      await seedFact(HARMLESS);
    });

    const expectMasked = (prompt: string) => {
      expectClean(prompt);
      expect(prompt).toContain(`Passwort: ${SECRET_MASK}`);
      expect(prompt).toContain(`Lager ist ${SECRET_MASK}`);
      expect(prompt).toContain(`Tor ${SECRET_MASK} bitte aufheben`);
      expect(prompt).toContain(HARMLESS);
    };

    test("der Probeaufruf zählt: Ein normaler Fakt erreicht den Anbieter", async () => {
      expect(await memory().addFact("Alex trinkt morgens Tee")).toBe(true);
      await settled();
      expect(embeddings).toEqual(["Alex trinkt morgens Tee"]);
    });

    test("Session-Start und Fallback-Kontext", async () => {
      const context = await buildPromptContext({ userMessage: "Was war mit der Imkerei?", chatId: OWNER, agentName: "general" }, QUIET);
      expectMasked(context.fullPrompt);
      expect(context.shownFactIds).toHaveLength(4);
    });

    test("auch bei der Auswahl über dem Budget", async () => {
      process.env.MEMORY_CONTEXT_CHARS = "10";
      const context = await buildPromptContext({ userMessage: "Was war mit der Imkerei?", chatId: OWNER, agentName: "general" }, QUIET);
      expectMasked(context.fullPrompt);
    });

    test("Kern von Hand mit Geheimnis: im Prompt nur maskiert, auch ein Schlüssel am Ende der erlaubten Länge", async () => {
      mkdirSync(join(root, "config"), { recursive: true });
      writeFileSync(join(root, "config", "kern.md"), `## Wer ich bin\n- Alex\n- Passwort: ${PASSWORD}\n- ${"x".repeat(1900)}\n${PEM}\n`);
      const context = await buildPromptContext({ userMessage: "Was war mit der Imkerei?", chatId: OWNER, agentName: "general" }, { ...QUIET, core: () => coreForPrompt() });
      expect(context.fullPrompt).toContain("- Alex");
      expect(context.fullPrompt).toContain(`- Passwort: ${SECRET_MASK}`);
      expectClean(context.fullPrompt);
    });

    test("Delta einer laufenden Session", async () => {
      const prompt = await buildResumePrompt(
        { userMessage: "Weiter", chatId: OWNER, shownFactIds: [], sinceMs: Date.parse("2026-01-01T00:00:00Z") },
        { ...QUIET, followUp: async () => ({ messages: [], facts: [] }) },
      );
      expect(prompt).toContain("## MEMORY UPDATES");
      expectMasked(prompt);
    });

    test("Nachladen zur Folgenachricht", async () => {
      const prompt = await buildResumePrompt({ userMessage: "Was war mit der Imkerei und dem Commit oder Lager?", chatId: OWNER, shownFactIds: [] }, QUIET);
      expect(prompt).toContain("## RELEVANT FACTS");
      expectClean(prompt);
    });

    test("Sprachkontext", async () => {
      const voice = createVoiceContext({
        agent: { systemPrompt: "Am Telefon." },
        deps: { getUserProfile: async () => "", getMemoryContext: () => getMemoryContext(), getRecentMessages: async () => [] },
      });
      const loaded = await voice.load(OWNER);
      expectMasked(JSON.stringify(loaded).replaceAll("\\n", "\n"));
    });

    test("Telefon", async () => {
      expectMasked(await memoryContext(memory()));
    });

    test("Nachschlagen", async () => {
      const raw = await createHistorySearchHandler({
        chatIds: () => [],
        searchMessages: async () => [],
        knowledgeContext: async () => "",
        searchImages: async () => [],
        searchFacts: (query, limit) => memory().searchFacts(query, limit),
      })({ query: "Imkerei", limit: 15 });
      expectClean(raw);
      expect(raw).toContain(SECRET_MASK);
      expect(raw).toContain("0123456789abcdef0123456789abcdef01234567");
    });

    test("/memory", async () => {
      const list = await listFacts();
      expectClean(list);
      expect(list).toContain(`Passwort: ${SECRET_MASK}`);
      expect(list).toContain(`Tor\n${SECRET_MASK}\nbitte aufheben`);
      expect(list).toContain(HARMLESS);
    });

    test("der Speicher behält den Originaltext: Archivieren gegen den erwarteten Stand gelingt", async () => {
      const before = await rows();
      await buildPromptContext({ userMessage: "Imkerei", chatId: OWNER, agentName: "general" }, QUIET);
      expect(await rows()).toEqual(before);
      const fact = (await memory().facts()).find(item => item.content === PEM_FACT)!;
      expect(fact.content).toContain(KEY_BODY);
      expect(await memory().archiveFact(String(fact.id), PEM_FACT)).toBe("changed");
    });
  });

  describe("Altbestand in jeder Schreibweise", () => {
    test("Prompt, Delta, /memory, Nachschlagen und Neuberechnung zeigen keinen Rest des Werts; der Speicher behält das Original", async () => {
      for (const { text } of LABELED_SECRETS) await seedFact(`Imkerei: ${text}`);
      const before = await rows();
      const context = await buildPromptContext({ userMessage: "Was war mit der Imkerei?", chatId: OWNER, agentName: "general" }, QUIET);
      const delta = await buildResumePrompt(
        { userMessage: "Weiter", chatId: OWNER, shownFactIds: [], sinceMs: Date.parse("2026-01-01T00:00:00Z") },
        { ...QUIET, followUp: async () => ({ messages: [], facts: [] }) },
      );
      const list = await listFacts();
      const raw = await createHistorySearchHandler({
        chatIds: () => [],
        searchMessages: async () => [],
        knowledgeContext: async () => "",
        searchImages: async () => [],
        searchFacts: (query, limit) => memory().searchFacts(query, limit),
      })({ query: "Imkerei", limit: 15 });
      const reindexed = before.map(row => TABLE_SPECS.memory.text({ id: String(row.id), type: "fact", content: row.content })).join("\n");
      for (const shown of [context.fullPrompt, delta, list, raw, reindexed]) {
        expect(shown).toContain(SECRET_MASK);
        for (const { rest } of LABELED_SECRETS) for (const part of rest) expect(shown).not.toContain(part);
      }
      expect(await rows()).toEqual(before);
      expect(before.map(row => row.content)).toEqual(LABELED_SECRETS.map(({ text }) => `Imkerei: ${text}`));
    }, 30_000);

    test.each(LABELED_SECRETS.map(({ text, masked, rest }) => [text, masked, rest] as const))("Prüfliste, Archiv und Prompt zeigen nur die Maske: %s", async (text, masked, rest) => {
      const id = await seedFact(`Imkerei: ${text}`);
      // Listen und Prompt zeigen je Fakt eine Zeile; die Maskierung läuft davor
      const line = `Imkerei: ${masked.replace(/\s*\n\s*/g, " ")}`;
      expect(await tybo("geheimnisse")).toBe(0);
      expect(out.join("\n")).toContain(`${id}  ${line}`);
      expect(readFileSync(join(root, "data", "choices.json"), "utf8")).toContain(SECRET_MASK);
      const context = await buildPromptContext({ userMessage: "Was war mit der Imkerei?", chatId: OWNER, agentName: "general" }, QUIET);
      expect(context.fullPrompt).toContain(line);
      const [choice] = (await listChoices()).filter(item => item.kind === "secret");
      await decideChoice(choice.id, SECRET_KEYS.archive, "web");
      expect((await rows())[0].archived_at).not.toBeNull();
      expect((await rows())[0].content).toBe(`Imkerei: ${text}`);
      expect(await tybo("archiv")).toBe(0);
      const texts = choiceTexts(join(root, "data", "choices.json"));
      expect(texts.join("\n")).toContain(SECRET_MASK);
      // Kennungen der Rückfragen sind zufällig; endet eine auf „47“, träfe sie den Rest „47 “ der PIN, ohne dass etwas durchsickert
      const ids = (await listChoices()).map(item => item.id);
      const withoutIds = (item: string) => ids.reduce((acc, choiceId) => acc.split(choiceId).join("<kennung>"), item);
      const shown = [out.join("\n"), ...texts, context.fullPrompt, notices.join("\n"), logs.join("\n")].map(withoutIds);
      for (const part of rest) for (const item of shown) expect(item).not.toContain(part);
      expect(embeddings).toEqual([]);
    });
  });

  describe("tybo gedaechtnis geheimnisse", () => {
    const secretChoices = async () => (await listChoices()).filter(choice => choice.kind === "secret");

    test("Liste mit Kennung und Maske, Behalten und Archivieren wirken auf genau den einen Fakt", async () => {
      const kept = await seedFact(PASSWORD_FACT);
      const gone = await seedFact(KEY_FACT);
      await seedFact(HARMLESS);
      expect(await tybo("geheimnisse")).toBe(0);
      const text = out.join("\n");
      expect(text).toContain(`${kept}  Imkerei: Seite imker.example, Passwort: ${SECRET_MASK}`);
      expect(text).toContain(`${gone}  Imkerei: Zugang zum Lager ist ${SECRET_MASK}`);
      expect(text).toContain("Fakten mit Geheimnis: 2");
      expectClean(text);

      const choices = await secretChoices();
      expect(choices).toHaveLength(2);
      expectClean(readFileSync(join(root, "data", "choices.json"), "utf8"));
      const of = (id: string) => choices.find(choice => choice.ref?.startsWith(`${id}:`))!;
      await decideChoice(of(kept).id, SECRET_KEYS.keep, "web");
      await decideChoice(of(gone).id, SECRET_KEYS.archive, "telegram");

      const after = await rows();
      expect(after.find(row => String(row.id) === kept)).toMatchObject({ content: PASSWORD_FACT, archived_at: null });
      expect(after.find(row => String(row.id) === gone)?.archived_at).not.toBeNull();
      expect(after).toHaveLength(3);

      const prompt = await getMemoryContext();
      expectClean(prompt);
      expect(prompt).toContain(`Passwort: ${SECRET_MASK}`);
      expect(prompt).not.toContain("Lager");
      expectClean(notices.join("\n"));

      out.length = 0;
      expect(await tybo("archiv")).toBe(0);
      expect(out.join("\n")).toContain(`Lager ist ${SECRET_MASK}`);
      expectClean(out.join("\n"));

      expect(await tybo("zurueckholen", gone)).toBe(0);
      expect((await rows()).find(row => String(row.id) === gone)?.archived_at).toBeNull();
    });

    test("eine neue Fassung des Texts stellt die Frage neu, die alte Antwort wirkt nicht", async () => {
      const id = await seedFact(PASSWORD_FACT);
      await tybo("geheimnisse");
      const [first] = await secretChoices();
      await pg.admin.unsafe("UPDATE public.memory SET content = $1 WHERE id = $2", ["Imkerei: Passwort: Sommerwiese77", id]);
      await decideChoice(first.id, SECRET_KEYS.archive, "web");
      expect((await rows())[0].archived_at).toBeNull();
      await tybo("geheimnisse");
      expect((await secretChoices()).filter(choice => choice.state === "open")).toHaveLength(1);
    });
  });
});
