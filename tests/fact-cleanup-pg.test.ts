/**
 * Issue #520: Archiv für Fakten und einmalige Bereinigung per Knopf. Speicher
 * und Befehl laufen gegen das echte Schema samt Migration (tests/pg-harness.ts),
 * mit echtem Rückfragen-Register und echtem Handler. Ersetzt sind nur Telegram,
 * der Embedding-Anbieter und der Ablageort. Alle Daten sind erfunden.
 *
 * Braucht TEST_PG_URL oder TEST_PG_BIN; ohne beide übersprungen, in der CI ein
 * Fehler. Was keine Datenbank braucht, läuft immer.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQL } from "bun";
import { clearRegistryCache } from "../supabase/functions/_shared/embedding";
import { createChoice, decideChoice, expireChoice, getChoice, listChoices, onChoiceDecided, setChoicesFileForTests, type Choice, type CreateChoiceInput } from "../src/lib/choices";
import { getMemoryContext } from "../src/lib/memory";
import { memoryContext, memoryDelta } from "../src/lib/memory/context";
import {
  CLEANUP_KEYS,
  CLEANUP_TEXT,
  createCleanupChoices,
  factCleanupFile,
  parseCleanupList,
  prepareCleanup,
  readLedger,
  REWRITE_GROUP_MAX,
  textHash,
  type CleanupChoicesDeps,
  type CleanupEntry,
} from "../src/lib/memory/fact-cleanup";
import type { SendAndRecordInput, SendAndRecordResult } from "../src/lib/outbox";
import { getStore, resetStore } from "../src/lib/store";
import { fileMemory } from "../src/lib/store/file/memory";
import { resetSupabaseClient } from "../src/lib/supabase";
import { textChunks } from "../src/lib/outbox";
import { createVoiceContext } from "../src/lib/voice-brain/context";
import { createBotChoices } from "../src/web/bot-choices";
import { runTybo } from "../scripts/tybo";
import { pad } from "./memory-fixture";
import { pgAvailable, respondViaPg, startPg, type PgServer } from "./pg-harness";
import { FAKE_SUPABASE_URL, useFakeSupabase } from "./supabase-fixture";

const available = pgAvailable();

if (!available.ok && process.env.CI) {
  test("PostgreSQL für das Archiv der Fakten ist in der CI eingerichtet", () => {
    throw new Error(`${available.reason}: der Dienst pgvector in .github/workflows/check.yml fehlt`);
  });
}

const entry = (over: Record<string, unknown> = {}) => ({ kennung: 7, einstufung: "doppelt", begruendung: "steht schon anders da", originaltext: "Alex trinkt Tee", ...over });

describe("Liste prüfen", () => {
  const problems = (value: unknown) => {
    const parsed = parseCleanupList(JSON.stringify(value));
    return "problems" in parsed ? parsed.problems.join("\n") : "";
  };

  test("gültige Liste: Zahl als Kennung, Hash statt Text, Umschreibung mit neuem Text", () => {
    const hash = textHash("Mia spielt Cello");
    const parsed = parseCleanupList(
      JSON.stringify([
        entry(),
        { kennung: "x8", einstufung: "ueberholt", begruendung: "alt", originalhash: hash },
        { kennung: 9, einstufung: "umschreiben", begruendung: "teils alt", originaltext: "Alt", neuer_text: "Neu" },
      ]),
    );
    expect(parsed).toEqual({
      entries: [
        { id: "7", klass: "doppelt", reason: "steht schon anders da", original: "Alex trinkt Tee" },
        { id: "x8", klass: "ueberholt", reason: "alt", originalHash: hash },
        { id: "9", klass: "umschreiben", reason: "teils alt", original: "Alt", proposed: "Neu" },
      ],
    });
  });

  test("Pflichtfelder und feste Einstufungen", () => {
    expect(problems([entry({ einstufung: "vielleicht" })])).toContain("einstufung");
    expect(problems([entry({ kennung: undefined })])).toContain("kennung fehlt");
    expect(problems([entry({ begruendung: " " })])).toContain("begruendung fehlt");
    expect(problems([entry({ originaltext: undefined })])).toContain("originaltext oder originalhash");
    expect(problems([entry({ originaltext: undefined, originalhash: "abc" })])).toContain("SHA-256");
    expect(problems([entry(), entry()])).toContain("doppelt in der Liste");
  });

  test("neuer Text: Pflicht bei umschreiben, sonst verboten, nie gleich dem alten", () => {
    expect(problems([entry({ einstufung: "umschreiben" })])).toContain("Pflicht");
    expect(problems([entry({ einstufung: "umschreiben", neuer_text: "Alex trinkt Tee" })])).toContain("gleicht");
    expect(problems([entry({ neuer_text: "Neu" })])).toContain("nur bei umschreiben");
  });

  test("kaputte Datei, kein Feld; Meldungen nennen keine Inhalte", () => {
    expect(parseCleanupList("{kaputt")).toEqual({ problems: ["Die Datei ist kein gültiges JSON."] });
    expect(problems({ a: 1 })).toContain("JSON-Feld");
    expect(problems([entry({ einstufung: "geheimwort", originaltext: "Geheimer Inhalt" })])).not.toMatch(/geheim/i);
  });
});

describe("Datei-Adapter: Archiv", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tybo-archiv-datei-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("archiviert fehlt überall, Konflikt ändert nichts, Zurückholen und Umschreiben zählen im Delta", async () => {
    const memory = fileMemory(() => join(dir, "memory.json"));
    await memory.addFact("Alex trinkt Tee");
    await memory.addFact("Mia spielt Cello");
    const [tea, cello] = await memory.facts();
    const since = new Date(Date.now() + 5);
    expect(await memory.archiveFact(tea.id!, "anderer Text")).toBe("conflict");
    expect(await memory.archiveFact(tea.id!, "Alex trinkt Tee")).toBe("changed");
    expect(await memory.archiveFact(tea.id!, "Alex trinkt Tee")).toBe("conflict");
    expect((await memory.facts()).map(f => f.content)).toEqual(["Mia spielt Cello"]);
    expect(await memory.matchingFacts("tee", 5)).toEqual([]);
    expect(await memory.deleteFact("tee")).toBe(false);
    expect(await memory.deleteFactById(tea.id!)).toBe(false);
    expect(await memory.rewriteFact(tea.id!, "Alex trinkt Tee", "x")).toBe("conflict");
    expect((await memory.archivedFacts()).map(f => f.content)).toEqual(["Alex trinkt Tee"]);
    expect((await memory.changedSince(new Date(0))).map(f => f.content)).toEqual(["Mia spielt Cello"]);

    await Bun.sleep(10);
    expect(await memory.restoreFact(tea.id!)).toBe("changed");
    expect(await memory.restoreFact(tea.id!)).toBe("conflict");
    expect(await memory.rewriteFact(cello.id!, "Mia spielt Cello", "Mia spielt Bratsche")).toBe("changed");
    expect((await memory.changedSince(since)).map(f => f.content).sort()).toEqual(["Alex trinkt Tee", "Mia spielt Bratsche"]);
    expect(await memory.archivedFacts()).toEqual([]);
  });

  test("Bereinigung ohne Datenbank: über den Befehl vorgelegt, per Knopf archiviert, zurückgeholt", async () => {
    const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, path: process.env.MEMORY_FILE_PATH };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.MEMORY_FILE_PATH = join(dir, "memory.json");
    resetStore();
    setChoicesFileForTests(join(dir, "data", "choices.json"));
    const silent = spyOn(console, "log").mockImplementation(() => {});
    try {
      await getStore().memory.addFact("Alex trinkt Tee");
      const [fact] = await getStore().memory.facts();
      const list = join(dir, "liste.json");
      writeFileSync(list, JSON.stringify([entry({ kennung: fact.id })]));
      const out: string[] = [];
      const send = async (_input: SendAndRecordInput) => ({ sent: true, recorded: true }) as SendAndRecordResult;
      const env = { ...process.env };
      const run = (...args: string[]) => runTybo({ args: ["gedaechtnis", ...args], env, root: dir, out: line => void out.push(line), err: line => void out.push(line), factCleanup: { send } });
      expect(await run("bereinigen", "--datei", list)).toBe(0);
      expect((await getStore().memory.facts()).length).toBe(1);
      const off = onChoiceDecided("cleanup", createCleanupChoices(cleanupDeps(dir, [])).handler);
      const [choice] = await listChoices();
      await decideChoice(choice.id, CLEANUP_KEYS.apply, "web");
      off();
      expect(await getStore().memory.facts()).toEqual([]);
      expect(await run("archiv")).toBe(0);
      expect(out.at(-1)).toContain("Alex trinkt Tee");
      expect(await run("zurueckholen", fact.id!)).toBe(0);
      expect((await getStore().memory.facts()).map(f => f.content)).toEqual(["Alex trinkt Tee"]);
    } finally {
      silent.mockRestore();
      setChoicesFileForTests(null);
      for (const [name, value] of [["SUPABASE_URL", saved.url], ["SUPABASE_SERVICE_ROLE_KEY", saved.key], ["MEMORY_FILE_PATH", saved.path]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      resetStore();
    }
  });
});

function cleanupDeps(root: string, notices: string[], overrides: Partial<CleanupChoicesDeps> = {}): CleanupChoicesDeps {
  return {
    file: factCleanupFile(root),
    memory: () => getStore().memory,
    sendChoice: async () => ({ sent: true }),
    notify: async (_conversation, text) => void notices.push(text),
    log: () => {},
    ...overrides,
  };
}

describe.skipIf(!available.ok)("Archiv und Bereinigung gegen das echte Schema", () => {
  let pg: PgServer;
  let service: SQL;
  let fake: ReturnType<typeof useFakeSupabase>;
  let root: string;
  let notices: string[];
  let out: string[];
  let errs: string[];
  let embedFails: boolean;
  let holdNext: Promise<void> | null;
  let savedProjectRoot: string | undefined;
  const undo: (() => void)[] = [];
  const DM = { type: "telegram", chatId: "web" } as const;
  const MODEL = "openai:text-embedding-3-small";

  /** Vektor aus dem Text: so lässt sich prüfen, zu welchem Stand ein Vektor gehört */
  const vectorOf = (text: string) => pad([text.length / 1000, 1]);
  const stored = (text: string) => `[${vectorOf(text).join(",")}]`;

  beforeAll(async () => {
    pg = await startPg();
    await pg.applySchema();
    service = await pg.connect("service_role");
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  beforeEach(async () => {
    await pg.admin.unsafe("TRUNCATE public.memory, public.messages RESTART IDENTITY CASCADE");
    root = mkdtempSync(join(tmpdir(), "tybo-bereinigung-"));
    savedProjectRoot = process.env.GO_PROJECT_ROOT;
    process.env.GO_PROJECT_ROOT = root;
    setChoicesFileForTests(join(root, "data", "choices.json"));
    embedFails = false;
    holdNext = null;
    const viaPg = respondViaPg(service, FAKE_SUPABASE_URL);
    fake = useFakeSupabase({
      respond(request) {
        if (request.url.origin !== "https://api.openai.com") return viaPg(request);
        if (embedFails) return new Response("kaputt", { status: 500 });
        const answer = () => new Response(JSON.stringify({ data: [{ embedding: vectorOf(String(JSON.parse(request.body).input)) }] }));
        const hold = holdNext;
        holdNext = null;
        return hold ? hold.then(answer) : answer();
      },
    });
    process.env.OPENAI_API_KEY = "sk-test-archiv";
    clearRegistryCache();
    notices = [];
    out = [];
    errs = [];
    for (const method of ["log", "warn", "error"] as const) {
      const spy = spyOn(console, method).mockImplementation(() => {});
      undo.push(() => spy.mockRestore());
    }
    undo.push(onChoiceDecided("cleanup", createCleanupChoices(cleanupDeps(root, notices)).handler));
  });

  afterEach(async () => {
    while (undo.length) undo.pop()!();
    setChoicesFileForTests(null);
    if (savedProjectRoot === undefined) delete process.env.GO_PROJECT_ROOT;
    else process.env.GO_PROJECT_ROOT = savedProjectRoot;
    fake.restore();
    clearRegistryCache();
    resetStore();
    resetSupabaseClient();
    rmSync(root, { recursive: true, force: true });
    await pg.admin.unsafe("DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'memory' AND column_name = 'weg') THEN ALTER TABLE public.memory RENAME COLUMN weg TO archived_at; END IF; END $$");
    await pg.admin.unsafe("DO $$ BEGIN IF to_regprocedure('public.fact_vectors_weg(text, text)') IS NOT NULL THEN ALTER FUNCTION public.fact_vectors_weg(text, text) RENAME TO embedding_fact_vectors; END IF; END $$");
  });

  const memory = () => getStore().memory;
  const seed = async (content: string, embedded = false): Promise<string> => {
    const rows = await pg.admin.unsafe(
      "INSERT INTO public.memory (type, content, embedding, embedding_model) VALUES ('fact', $1, $2::vector, $3) RETURNING id",
      [content, embedded ? stored(content) : null, embedded ? MODEL : null],
    );
    return String(rows[0].id);
  };
  const row = async (id: string) =>
    (await pg.admin.unsafe("SELECT content, archived_at, embedding::text AS embedding, embedding_model FROM public.memory WHERE id = $1::bigint", [id]))[0] as {
      content: string;
      archived_at: Date | null;
      embedding: string | null;
      embedding_model: string | null;
    };
  const contents = async () => (await memory().facts()).map(f => f.content).sort();
  const open = async (): Promise<Choice[]> => (await listChoices()).filter(c => c.kind === "cleanup" && c.state === "open");
  const current = async (): Promise<Choice> => {
    const list = await open();
    expect(list).toHaveLength(1);
    return list[0];
  };
  const click = async (key: string) => decideChoice((await current()).id, key, "web");
  const clear = (id: string, text: string, over: Partial<CleanupEntry> = {}): CleanupEntry => ({ id, klass: "doppelt", reason: `Grund zu ${id}`, original: text, ...over });
  const rewrite = (id: string, text: string, proposed: string): CleanupEntry => ({ id, klass: "umschreiben", reason: `Grund zu ${id}`, original: text, proposed });
  const prepare = (entries: CleanupEntry[], overrides: Partial<CleanupChoicesDeps> = {}) => prepareCleanup(entries, DM, cleanupDeps(root, notices, overrides));
  const tybo = (...args: string[]) => runTybo({ args: ["gedaechtnis", ...args], env: process.env, root, out: line => void out.push(line), err: line => void errs.push(line) });
  const writeList = (value: unknown) => {
    const path = join(root, "liste.json");
    writeFileSync(path, JSON.stringify(value));
    return path;
  };

  describe("Speicher", () => {
    test("archiviert fehlt in facts, matchingFacts, changedSince, Vektoren, Prompt und Löschen", async () => {
      const gone = await seed("Alex wohnt in Hamburg", true);
      await seed("Mia spielt Cello", true);
      expect(await memory().archiveFact(gone, "Alex wohnt in Hamburg")).toBe("changed");

      expect(await contents()).toEqual(["Mia spielt Cello"]);
      expect(await memory().matchingFacts("hamburg", 5)).toEqual([]);
      expect((await memory().changedSince(new Date(0))).map(f => f.content)).toEqual(["Mia spielt Cello"]);
      const context = await memoryContext(memory());
      expect(context).toContain("Mia spielt Cello");
      expect(context).not.toContain("Hamburg");
      expect(await memory().deleteFact("hamburg")).toBe(false);
      expect(await memory().deleteFactById(gone)).toBe(false);
      expect((await row(gone)).content).toBe("Alex wohnt in Hamburg");
    });

    test("RPC der Vektoren und der Rückfall ohne RPC lassen Archiviertes aus", async () => {
      // Anbieter festhalten, sonst liefert die RPC gar nichts
      await memory().rewriteFact(await seed("Vorlage"), "Vorlage", "Mia spielt Cello");
      const gone = await seed("Alex wohnt in Hamburg", true);
      const stay = await seed("Reifen sind gewechselt", true);
      await memory().archiveFact(gone, "Alex wohnt in Hamburg");
      const query = { vector: vectorOf("x"), config: { provider: "openai" as const, model: "text-embedding-3-small" } };
      const viaRpc = await memory().factVectors(query);
      expect([...viaRpc!.keys()]).toContain(stay);
      expect([...viaRpc!.keys()]).not.toContain(gone);

      await pg.admin.unsafe("ALTER FUNCTION public.embedding_fact_vectors(text, text) RENAME TO fact_vectors_weg");
      clearRegistryCache();
      const raw = await memory().factVectors(query);
      expect([...raw!.keys()]).toContain(stay);
      expect([...raw!.keys()]).not.toContain(gone);
    });

    test("Zurückholen: wieder überall da, samt altem Vektor, und im Delta", async () => {
      const id = await seed("Alex wohnt in Hamburg", true);
      await memory().archiveFact(id, "Alex wohnt in Hamburg");
      expect((await memory().archivedFacts()).map(f => [String(f.id), f.content])).toEqual([[id, "Alex wohnt in Hamburg"]]);
      const since = new Date(Date.now() - 1);
      expect(await memory().changedSince(since)).toEqual([]);
      expect(await memory().restoreFact(id)).toBe("changed");
      expect(await memory().restoreFact(id)).toBe("conflict");
      expect(await memory().archivedFacts()).toEqual([]);
      expect(await contents()).toEqual(["Alex wohnt in Hamburg"]);
      expect(await row(id)).toMatchObject({ archived_at: null, embedding_model: MODEL });
      expect(memoryDelta(await memory().changedSince(since))).toContain("Alex wohnt in Hamburg");
    });

    test("Konflikt: anderer Text, Ziel statt Fakt, schon archiviert; nichts wird geschrieben", async () => {
      const id = await seed("Alex wohnt in Hamburg");
      expect(await memory().archiveFact(id, "Alex wohnt in Bremen")).toBe("conflict");
      expect(await memory().rewriteFact(id, "Alex wohnt in Bremen", "Neu")).toBe("conflict");
      expect(await row(id)).toMatchObject({ content: "Alex wohnt in Hamburg", archived_at: null });
      const goal = (await pg.admin.unsafe("INSERT INTO public.memory (type, content) VALUES ('goal', 'Ein Ziel') RETURNING id"))[0].id;
      expect(await memory().archiveFact(String(goal), "Ein Ziel")).toBe("conflict");
      await memory().archiveFact(id, "Alex wohnt in Hamburg");
      expect(await memory().rewriteFact(id, "Alex wohnt in Hamburg", "Neu")).toBe("conflict");
      expect((await row(id)).content).toBe("Alex wohnt in Hamburg");
    });

    test("Umschreiben ersetzt Text und Vektor samt Kennung in einem Schritt und zählt im Delta", async () => {
      const id = await seed("Alex wohnt in Hamburg", true);
      const since = new Date(Date.now() - 1);
      expect(await memory().rewriteFact(id, "Alex wohnt in Hamburg", "Alex wohnt seit Mai in Bremen")).toBe("changed");
      const after = await row(id);
      expect(after.content).toBe("Alex wohnt seit Mai in Bremen");
      expect(after.embedding_model).toBe(MODEL);
      expect(after.embedding?.replace(/\s/g, "").startsWith(`[${"Alex wohnt seit Mai in Bremen".length / 1000},1,`)).toBe(true);
      expect((await memory().changedSince(since)).map(f => f.content)).toEqual(["Alex wohnt seit Mai in Bremen"]);
    });

    test("Umschreiben ohne Vektor: Text gilt, alter Vektor und Kennung sind weg, Ergebnis sagt es", async () => {
      const id = await seed("Alex wohnt in Hamburg", true);
      embedFails = true;
      expect(await memory().rewriteFact(id, "Alex wohnt in Hamburg", "Alex wohnt in Bremen")).toBe("changed_without_vector");
      expect(await row(id)).toMatchObject({ content: "Alex wohnt in Bremen", embedding: null, embedding_model: null });
    });

    test("verspäteter Vektor des alten Texts landet nicht am umgeschriebenen Fakt", async () => {
      let release!: () => void;
      holdNext = new Promise<void>(resolve => (release = resolve));
      expect(await memory().addFact("Mia spielt Cello")).toBe(true);
      for (let i = 0; i < 100 && !fake.requests.some(r => r.url.origin === "https://api.openai.com"); i++) await Bun.sleep(10);
      const [{ id }] = await memory().facts();
      expect(await memory().rewriteFact(String(id), "Mia spielt Cello", "Mia spielt jetzt Bratsche")).toBe("changed");
      release();
      await Bun.sleep(150);
      const after = await row(String(id));
      expect(after.content).toBe("Mia spielt jetzt Bratsche");
      expect(after.embedding?.replace(/\s/g, "").startsWith(`[${"Mia spielt jetzt Bratsche".length / 1000},1,`)).toBe(true);
    });

    test("Spalte fehlt noch (Code vor Migration): Fakten stehen weiter im Prompt, Archivieren scheitert ohne Schaden", async () => {
      const id = await seed("Alex wohnt in Hamburg");
      await pg.admin.unsafe("ALTER TABLE public.memory RENAME COLUMN archived_at TO weg");
      expect(await contents()).toEqual(["Alex wohnt in Hamburg"]);
      expect(await memory().matchingFacts("hamburg", 5)).toHaveLength(1);
      expect(await memory().archiveFact(id, "Alex wohnt in Hamburg")).toBe("failed");
      await expect(memory().archivedFacts()).rejects.toThrow();
      await expect(memory().facts({ strict: true })).resolves.toHaveLength(1);
      expect(await memory().deleteFactById(id)).toBe(true);
    });

    test("strict: Lesefehler wirft, ohne strict bleibt es bei der leeren Liste", async () => {
      await pg.admin.unsafe("ALTER TABLE public.memory RENAME TO memory_weg");
      try {
        expect(await memory().facts()).toEqual([]);
        await expect(memory().facts({ strict: true })).rejects.toThrow("Fakten lesen");
      } finally {
        await pg.admin.unsafe("ALTER TABLE public.memory_weg RENAME TO memory");
      }
    });

  });

  describe("Paket", () => {
    test("ohne Bestätigung bleibt alles unverändert, Aufklappen und Ausnahmen entscheiden nichts", async () => {
      const a = await seed("Alex trinkt Tee");
      const b = await seed("Mia spielt Cello");
      await prepare([clear(a, "Alex trinkt Tee"), clear(b, "Mia spielt Cello", { klass: "ueberholt" })]);
      const first = await current();
      expect(first.text).toContain("2 Fakten");
      // Die Übersicht nennt noch keine Texte, die stehen in der aufgeklappten Liste
      expect(first.text).not.toContain("Alex trinkt Tee");
      expect(first.options.map(o => o.label)).toEqual(["Alle 2 archivieren", "Liste zeigen", "Ausnahme wählen", "Verwerfen"]);

      await click(CLEANUP_KEYS.list);
      const list = await current();
      expect(list.id).not.toBe(first.id);
      expect(list.text).toContain(`[Kennung ${a}] Alex trinkt Tee`);
      expect(list.text).toContain(`Grund zu ${b}`);
      expect(list.options.map(o => o.key)).toEqual([CLEANUP_KEYS.apply, CLEANUP_KEYS.exceptions, CLEANUP_KEYS.discard]);

      await click(CLEANUP_KEYS.exceptions);
      expect(await contents()).toEqual(["Alex trinkt Tee", "Mia spielt Cello"]);
      expect((await current()).options.map(o => o.label)).toEqual(["1 behalten", "2 behalten", "Fertig"]);
    });

    test("Ausnahme bleibt aktiv, zurücknehmen geht; das Paket archiviert nur die übrigen", async () => {
      const a = await seed("Alex trinkt Tee");
      const b = await seed("Mia spielt Cello");
      const c = await seed("Reifen sind gewechselt");
      await prepare([clear(a, "Alex trinkt Tee"), clear(b, "Mia spielt Cello"), clear(c, "Reifen sind gewechselt")]);
      await click(CLEANUP_KEYS.exceptions);
      await click("x0");
      await click("x1");
      let picker = await current();
      expect(picker.text).toContain("bleiben: 1, 2");
      expect(picker.options.map(o => o.label).slice(0, 2)).toEqual(["1 ✓ bleibt", "2 ✓ bleibt"]);
      await click("x1");
      picker = await current();
      expect(picker.options[1].label).toBe("2 behalten");
      await click(CLEANUP_KEYS.done);
      const summary = await current();
      expect(summary.text).toContain("bleiben: 1.");
      expect(summary.options[0].label).toBe("Alle 2 archivieren");
      await click(CLEANUP_KEYS.apply);
      expect(await contents()).toEqual(["Alex trinkt Tee"]);
      expect(notices.join("\n")).toContain("✅ 2 archiviert");
      expect(notices.join("\n")).toContain("1 bleiben unverändert");
      expect(notices.join("\n")).toContain(CLEANUP_TEXT.undo);
      expect(await open()).toEqual([]);
    });

    test("Doppelklick und gleichzeitige Klicks wirken einmal", async () => {
      const a = await seed("Alex trinkt Tee");
      await prepare([clear(a, "Alex trinkt Tee")]);
      const { id } = await current();
      const results = await Promise.all([1, 2, 3].map(() => decideChoice(id, CLEANUP_KEYS.apply, "web")));
      expect(results.filter(r => r.status === "decided")).toHaveLength(1);
      expect((await decideChoice(id, CLEANUP_KEYS.apply, "telegram")).status).toBe("already");
      expect(notices.filter(n => n.includes("archiviert"))).toHaveLength(1);
      expect(await contents()).toEqual([]);
    });

    test("Textkonflikt beim Bestätigen schreibt nichts, die übrigen gelten (Teilerfolg)", async () => {
      const a = await seed("Alex trinkt Tee");
      const b = await seed("Mia spielt Cello");
      await prepare([clear(a, "Alex trinkt Tee"), clear(b, "Mia spielt Cello")]);
      await pg.admin.unsafe("UPDATE public.memory SET content = 'Alex trinkt Kaffee' WHERE id = $1::bigint", [a]);
      await click(CLEANUP_KEYS.apply);
      expect(await row(a)).toMatchObject({ content: "Alex trinkt Kaffee", archived_at: null });
      expect((await row(b)).archived_at).not.toBeNull();
      expect(notices.join("\n")).toContain("1 übersprungen");
      expect(Object.values((await readLedger(factCleanupFile(root))).items).map(i => i.state).sort()).toEqual(["erledigt", "konflikt"]);
    });

    test("gescheiterter Eintrag: Stand stimmt, nur er kommt beim nächsten Aufruf wieder", async () => {
      const a = await seed("Alex trinkt Tee");
      const b = await seed("Mia spielt Cello");
      undo.pop()!();
      const realMemory = memory();
      const flaky = { ...realMemory, archiveFact: async (id: string, text: string) => (id === a ? "failed" as const : realMemory.archiveFact(id, text)) };
      undo.push(onChoiceDecided("cleanup", createCleanupChoices(cleanupDeps(root, notices, { memory: () => flaky })).handler));
      const entries = [clear(a, "Alex trinkt Tee"), clear(b, "Mia spielt Cello")];
      await prepare(entries);
      await click(CLEANUP_KEYS.apply);
      expect(notices.join("\n")).toContain("1 gescheitert");
      expect(await contents()).toEqual(["Alex trinkt Tee"]);
      const report = await prepare(entries);
      expect(report).toMatchObject({ added: 1, missing: 1, known: 0, present: "vorgelegt" });
      expect((await current()).options[0].label).toBe("Alle 1 archivieren");
    });

    test("Verwerfen ändert nichts und fragt nicht noch einmal", async () => {
      const a = await seed("Alex trinkt Tee");
      const entries = [clear(a, "Alex trinkt Tee")];
      await prepare(entries);
      await click(CLEANUP_KEYS.discard);
      expect(notices).toEqual([CLEANUP_TEXT.discarded]);
      expect(await contents()).toEqual(["Alex trinkt Tee"]);
      expect(await prepare(entries)).toMatchObject({ added: 0, known: 1, present: "nichts" });
      expect(await open()).toEqual([]);
    });

    test("wiederholter Aufruf fragt nichts doppelt; nach Ablauf kommt die Gruppe wieder, samt Ausnahmen", async () => {
      const a = await seed("Alex trinkt Tee");
      const b = await seed("Mia spielt Cello");
      const entries = [clear(a, "Alex trinkt Tee"), clear(b, "Mia spielt Cello")];
      expect(await prepare(entries)).toMatchObject({ added: 2, present: "vorgelegt" });
      await click(CLEANUP_KEYS.exceptions);
      await click("x0");
      expect(await prepare(entries)).toMatchObject({ added: 0, known: 2, present: "besetzt" });
      const asked = await current();
      await expireChoice(asked.id);
      expect(await open()).toEqual([]);
      expect(await prepare(entries)).toMatchObject({ added: 0, known: 2, present: "vorgelegt" });
      expect((await current()).text).toContain("bleiben: 1.");
    });

    test("nicht zugestellt: Frage läuft ab, nichts geändert, der nächste Aufruf klappt", async () => {
      const a = await seed("Alex trinkt Tee");
      const entries = [clear(a, "Alex trinkt Tee")];
      expect(await prepare(entries, { sendChoice: async () => ({ sent: false }) })).toMatchObject({ present: "nicht_zugestellt" });
      expect(await open()).toEqual([]);
      expect(await contents()).toEqual(["Alex trinkt Tee"]);
      expect(await prepare(entries)).toMatchObject({ known: 1, present: "vorgelegt" });
    });

    test("Vorlage prüft: Fakt weg oder Text anders kommt gar nicht erst in die Frage; Prüfsumme genügt", async () => {
      const a = await seed("Alex trinkt Tee");
      const b = await seed("Mia spielt Cello");
      const goal = String((await pg.admin.unsafe("INSERT INTO public.memory (type, content) VALUES ('goal', 'Ein Ziel') RETURNING id"))[0].id);
      const report = await prepare([
        clear(a, "Alex trinkt Kaffee"),
        { id: b, klass: "ueberholt", reason: "alt", originalHash: textHash("Mia spielt Cello") },
        clear(goal, "Ein Ziel"),
        clear("99999", "Gibt es nicht"),
      ]);
      expect(report).toMatchObject({ entries: 4, added: 1, changed: 1, missing: 2 });
      expect((await current()).text).toContain("1 Fakten");
      await click(CLEANUP_KEYS.apply);
      expect(await contents()).toEqual(["Alex trinkt Tee"]);
    });
  });

  describe("Umschreiben", () => {
    test("Gruppen von höchstens zehn, nacheinander; das Paket kommt zuerst", async () => {
      const a = await seed("Alex trinkt Tee");
      const rewrites: CleanupEntry[] = [];
      for (let i = 1; i <= 23; i++) rewrites.push(rewrite(await seed(`Fakt ${i}`), `Fakt ${i}`, `Fakt ${i} neu`));
      expect(REWRITE_GROUP_MAX).toBe(10);
      await prepare([clear(a, "Alex trinkt Tee"), ...rewrites]);
      expect((await current()).text).toContain("doppelt oder überholt");
      await click(CLEANUP_KEYS.apply);

      const sizes: number[] = [];
      for (let group = 1; group <= 3; group++) {
        const asked = await current();
        expect(asked.text).toContain(`Gruppe ${group} von 3`);
        const size = (asked.text.match(/\[Kennung /g) ?? []).length;
        expect(asked.options[0].label).toBe(`Alle ${size} übernehmen`);
        sizes.push(size);
        await click(CLEANUP_KEYS.apply);
      }
      expect(sizes).toEqual([10, 10, 3]);
      expect(await open()).toEqual([]);
      expect((await contents()).filter(c => c.endsWith(" neu"))).toHaveLength(23);
    });

    test("Frage zeigt alt, neu und Grund vollständig; Ausnahme behält den Text; übernommen hat neuen Vektor", async () => {
      const a = await seed("Alex wohnt in Hamburg", true);
      const b = await seed("Mia spielt Cello", true);
      await prepare([rewrite(a, "Alex wohnt in Hamburg", "Alex wohnt in Bremen"), rewrite(b, "Mia spielt Cello", "Mia spielt Bratsche")]);
      const asked = await current();
      for (const part of ["Bisher: Alex wohnt in Hamburg", "Neu: Alex wohnt in Bremen", `Warum: Grund zu ${a}`]) expect(asked.text).toContain(part);
      expect(asked.options.map(o => o.key)).toEqual([CLEANUP_KEYS.apply, CLEANUP_KEYS.exceptions, CLEANUP_KEYS.discard]);
      await click(CLEANUP_KEYS.exceptions);
      await click("x1");
      await click(CLEANUP_KEYS.done);
      await click(CLEANUP_KEYS.apply);
      expect(await row(b)).toMatchObject({ content: "Mia spielt Cello", embedding_model: MODEL });
      expect(await row(a)).toMatchObject({ content: "Alex wohnt in Bremen", embedding_model: MODEL });
      expect((await row(a)).embedding?.replace(/\s/g, "").startsWith(`[${"Alex wohnt in Bremen".length / 1000},1,`)).toBe(true);
    });

    test("ohne Vektor: Ergebnis nennt es", async () => {
      const a = await seed("Alex wohnt in Hamburg", true);
      await prepare([rewrite(a, "Alex wohnt in Hamburg", "Alex wohnt in Bremen")]);
      embedFails = true;
      await click(CLEANUP_KEYS.apply);
      expect(notices.join("\n")).toContain("1 ohne Suchvektor");
      expect(await row(a)).toMatchObject({ content: "Alex wohnt in Bremen", embedding: null });
    });
  });

  describe("Sprachkontext", () => {
    /** Wie die Brücke: ein Kontext mit Cache, alles andere läuft in anderen Abläufen */
    const voiceBridge = () => {
      const counts = { profile: 0 };
      const voice = createVoiceContext({
        agent: { systemPrompt: "Am Telefon." },
        deps: {
          getUserProfile: async () => (counts.profile++, ""),
          getMemoryContext: () => getMemoryContext(),
          getRecentMessages: async () => [],
        },
      });
      return { counts, request: () => voice.load("1") };
    };

    test("Kontext laden, Fakt archivieren: die nächste Anfrage enthält ihn nicht, der Rest bleibt im Cache", async () => {
      const a = await seed("Alex wohnt in Hamburg");
      await seed("Mia spielt Cello");
      const bridge = voiceBridge();
      const before = await bridge.request();
      expect(before).toContain("Alex wohnt in Hamburg");

      await prepare([clear(a, "Alex wohnt in Hamburg")]);
      expect(await bridge.request()).toBe(before);
      await click(CLEANUP_KEYS.apply);

      const after = await bridge.request();
      expect(after).not.toContain("Alex wohnt in Hamburg");
      expect(after).toContain("Mia spielt Cello");
      expect(bridge.counts.profile).toBe(1);
    });

    test("ohne jedes Änderungssignal: Kontext laden, archivieren, die nächste Anfrage enthält den Fakt nicht", async () => {
      const a = await seed("Alex wohnt in Hamburg");
      const bridge = voiceBridge();
      expect(await bridge.request()).toContain("Alex wohnt in Hamburg");
      // Direkt am Speicher wie aus einem anderen Prozess: Kein Handler meldet etwas, und unter data/ entsteht nichts
      expect(await memory().archiveFact(a, "Alex wohnt in Hamburg")).toBe("changed");
      expect(await bridge.request()).not.toContain("Alex wohnt in Hamburg");
      expect(bridge.counts.profile).toBe(1);
    });

    test("Zurückholen und Umschreiben gelten ebenfalls schon für die nächste Anfrage", async () => {
      const a = await seed("Alex wohnt in Hamburg");
      const b = await seed("Mia spielt Cello");
      await prepare([clear(a, "Alex wohnt in Hamburg")]);
      await click(CLEANUP_KEYS.apply);
      const bridge = voiceBridge();
      expect(await bridge.request()).not.toContain("Alex wohnt in Hamburg");
      expect(await tybo("zurueckholen", a)).toBe(0);
      expect(await bridge.request()).toContain("Alex wohnt in Hamburg");

      await prepare([rewrite(b, "Mia spielt Cello", "Mia spielt Bratsche")]);
      await click(CLEANUP_KEYS.apply);
      const rewritten = await bridge.request();
      expect(rewritten).toContain("Mia spielt Bratsche");
      expect(rewritten).not.toContain("Mia spielt Cello");
    });
  });

  describe("Gleichzeitige Aufrufe", () => {
    const useHandler = (overrides: Partial<CleanupChoicesDeps>) => {
      undo.pop()!();
      undo.push(onChoiceDecided("cleanup", createCleanupChoices(cleanupDeps(root, notices, overrides)).handler));
    };
    const slowCreate = async (input: CreateChoiceInput) => {
      await Bun.sleep(30);
      return createChoice(input);
    };
    const groups = async () => (await readLedger(factCleanupFile(root))).groups;
    /** Genau eine offene Frage, und sie ist die der einzigen offenen Gruppe */
    const oneCurrent = async () => {
      const asked = await current();
      expect((await groups()).filter(g => g.state === "offen").map(g => g.choiceId)).toEqual([asked.id]);
      return asked;
    };
    const opened = async (action: string) => {
      for (let i = 0; i < 200 && !(await open()).some(c => c.action === action); i++) await Bun.sleep(5);
    };
    /** Versand, der erst auf Zuruf scheitert */
    const heldSend = () => {
      let fail!: () => void;
      const held = new Promise<{ sent: boolean }>(resolve => (fail = () => resolve({ sent: false })));
      return { held, fail };
    };

    test("zwei Befehle über dieselbe Liste: eine Gruppe, eine Frage", async () => {
      const a = await seed("Alex trinkt Tee");
      const list = writeList([{ kennung: Number(a), einstufung: "doppelt", begruendung: "Grund", originaltext: "Alex trinkt Tee" }]);
      expect(await Promise.all([tybo("bereinigen", "--datei", list), tybo("bereinigen", "--datei", list)])).toEqual([0, 0]);
      expect(errs).toEqual([]);
      await oneCurrent();
      expect(await groups()).toHaveLength(1);
    });

    test("zwei Vorlagen, die beide die wartende Gruppe sehen: nur eine reserviert sie", async () => {
      const a = await seed("Alex trinkt Tee");
      const entries = [clear(a, "Alex trinkt Tee")];
      const reports = await Promise.all([prepare(entries, { createChoice: slowCreate }), prepare(entries, { createChoice: slowCreate })]);
      expect(reports.map(r => r.present).sort()).toEqual(["besetzt", "vorgelegt"]);
      await oneCurrent();
    });

    test("Frage abgelaufen, zwei Befehle: der spätere setzt die neue Frage nicht zurück", async () => {
      const a = await seed("Alex trinkt Tee");
      const entries = [clear(a, "Alex trinkt Tee")];
      await prepare(entries);
      await expireChoice((await current()).id);
      const first = prepare(entries);
      // Der zweite hat die alte Frage als abgelaufen gesehen, bevor der erste fertig ist
      const second = prepare(entries, {
        getChoice: async id => {
          const seen = await getChoice(id);
          await first;
          return seen;
        },
      });
      expect((await Promise.all([first, second])).map(r => r.present)).toEqual(["vorgelegt", "besetzt"]);
      await oneCurrent();
    });

    test("Befehl, während der Handler zur nächsten Gruppe weiterschaltet: genau eine Frage", async () => {
      const a = await seed("Alex trinkt Tee");
      const b = await seed("Mia spielt Cello");
      const entries = [clear(a, "Alex trinkt Tee"), rewrite(b, "Mia spielt Cello", "Mia spielt Bratsche")];
      await prepare(entries);
      let release!: () => void;
      const gate = new Promise<void>(resolve => (release = resolve));
      let arrived!: () => void;
      const atGate = new Promise<void>(resolve => (arrived = resolve));
      // Der Handler steht vor dem Weiterschalten, bis der Befehl gerade seine Frage anlegt
      useHandler({
        notify: async () => {
          arrived();
          await gate;
        },
      });
      const clicked = click(CLEANUP_KEYS.apply);
      await atGate;
      const report = prepare(entries, {
        createChoice: async input => {
          release();
          return slowCreate(input);
        },
      });
      await Promise.all([clicked, report]);
      expect((await oneCurrent()).text).toContain("umschreiben");
    });

    test("Befehl, während der Handler den nächsten Schritt derselben Gruppe vorlegt: genau eine Frage", async () => {
      const a = await seed("Alex trinkt Tee");
      const entries = [clear(a, "Alex trinkt Tee")];
      await prepare(entries);
      useHandler({ createChoice: slowCreate });
      const [, report] = await Promise.all([click(CLEANUP_KEYS.list), prepare(entries, { createChoice: slowCreate })]);
      expect(report.present).toBe("besetzt");
      expect((await oneCurrent()).action).toBe("liste");
    });

    test("verspäteter Versandfehler, die Frage ist schon beantwortet: Gruppe bleibt beim neuen Schritt", async () => {
      const a = await seed("Alex trinkt Tee");
      await prepare([clear(a, "Alex trinkt Tee")]);
      const { held, fail } = heldSend();
      let sends = 0;
      useHandler({ sendChoice: async () => (++sends === 1 ? held : { sent: true }) });
      const slowClick = click(CLEANUP_KEYS.list);
      await opened("liste");
      await click(CLEANUP_KEYS.exceptions);
      const asked = await oneCurrent();
      expect(asked.action).toBe("ausnahmen");
      fail();
      await slowClick;
      expect((await oneCurrent()).id).toBe(asked.id);
      expect(notices).not.toContain(CLEANUP_TEXT.nextFailed);
    });

    test("verspäteter Versandfehler, die Gruppe ist abgeschlossen und die nächste offen: nichts wird überschrieben", async () => {
      const a = await seed("Alex trinkt Tee");
      const b = await seed("Mia spielt Cello");
      await prepare([clear(a, "Alex trinkt Tee"), rewrite(b, "Mia spielt Cello", "Mia spielt Bratsche")]);
      const { held, fail } = heldSend();
      let sends = 0;
      useHandler({ sendChoice: async () => (++sends === 1 ? held : { sent: true }) });
      const slowClick = click(CLEANUP_KEYS.list);
      await opened("liste");
      await click(CLEANUP_KEYS.apply);
      const asked = await oneCurrent();
      fail();
      await slowClick;
      expect((await oneCurrent()).id).toBe(asked.id);
      expect((await groups()).map(g => g.state)).toEqual(["fertig", "offen"]);
      expect(notices).not.toContain(CLEANUP_TEXT.nextFailed);
    });

    test("verspäteter Versandfehler, die Frage ist abgelaufen und ersetzt: die neue bleibt", async () => {
      const a = await seed("Alex trinkt Tee");
      const entries = [clear(a, "Alex trinkt Tee")];
      const { held, fail } = heldSend();
      const slow = prepare(entries, { sendChoice: () => held });
      await opened("uebersicht");
      await expireChoice((await current()).id);
      expect(await prepare(entries)).toMatchObject({ present: "vorgelegt" });
      const asked = await oneCurrent();
      fail();
      expect(await slow).toMatchObject({ present: "besetzt" });
      expect((await oneCurrent()).id).toBe(asked.id);
    });
  });

  describe("Handler und Frist", () => {
    const ELEVEN_MINUTES = 11 * 60_000;
    const later = () => Date.now() + ELEVEN_MINUTES;
    const useHandler = (overrides: Partial<CleanupChoicesDeps>) => {
      undo.pop()!();
      undo.push(onChoiceDecided("cleanup", createCleanupChoices(cleanupDeps(root, notices, overrides)).handler));
    };
    const groups = async () => (await readLedger(factCleanupFile(root))).groups;
    /** Speicher, dessen erstes archiveFact bis zum Zuruf steht, mit Mitschrift der Aufrufe */
    const heldMemory = () => {
      let resume!: () => void;
      const gate = new Promise<void>(resolve => (resume = resolve));
      let arrived!: () => void;
      const atGate = new Promise<void>(resolve => (arrived = resolve));
      const archived: string[] = [];
      const wrapped = () => {
        const real = memory();
        return {
          facts: (options?: { strict?: boolean }) => real.facts(options),
          archivedFacts: () => real.archivedFacts(),
          restoreFact: (id: string) => real.restoreFact(id),
          rewriteFact: (id: string, expected: string, content: string) => real.rewriteFact(id, expected, content),
          archiveFact: async (id: string, expected: string) => {
            archived.push(id);
            if (archived.length === 1) {
              arrived();
              await gate;
            }
            return real.archiveFact(id, expected);
          },
        };
      };
      return { wrapped, atGate, resume, archived };
    };

    test("Speicher hängt, Uhr über zehn Minuten, Befehl läuft: keine Ersatzfrage, der Handler macht zu Ende", async () => {
      const a = await seed("Alex trinkt Tee");
      const b = await seed("Mia spielt Cello");
      const list = writeList([a, b].map((kennung, i) => ({ kennung: Number(kennung), einstufung: "doppelt", begruendung: "Grund", originaltext: ["Alex trinkt Tee", "Mia spielt Cello"][i] })));
      expect(await tybo("bereinigen", "--datei", list)).toBe(0);
      const asked = await current();
      const held = heldMemory();
      useHandler({ memory: held.wrapped });
      const clicked = decideChoice(asked.id, CLEANUP_KEYS.apply, "web");
      await held.atGate;

      const realNow = Date.now.bind(Date);
      const clock = spyOn(Date, "now").mockImplementation(() => realNow() + ELEVEN_MINUTES);
      try {
        expect(await tybo("bereinigen", "--datei", list)).toBe(0);
      } finally {
        clock.mockRestore();
      }
      expect(await open()).toEqual([]);
      const [group] = await groups();
      expect(group).toMatchObject({ state: "offen", choiceId: asked.id });
      expect(group.handler?.pid).toBe(process.pid);

      held.resume();
      await clicked;
      expect(await open()).toEqual([]);
      expect(await contents()).toEqual([]);
      expect((await groups()).map(g => g.state)).toEqual(["fertig"]);
      expect((await groups())[0].handler).toBeUndefined();
      expect(notices.join("\n")).toContain("✅ 2 archiviert");
    });

    test("Prozess des Handlers gilt als tot: Ersatzfrage, der alte Handler ändert danach weder Einträge noch Entscheidung", async () => {
      const a = await seed("Alex trinkt Tee");
      const b = await seed("Mia spielt Cello");
      const entries = [clear(a, "Alex trinkt Tee"), clear(b, "Mia spielt Cello")];
      await prepare(entries);
      const asked = await current();
      const held = heldMemory();
      useHandler({ memory: held.wrapped });
      const clicked = decideChoice(asked.id, CLEANUP_KEYS.apply, "web");
      await held.atGate;

      expect(await prepare(entries, { isAlive: () => false })).toMatchObject({ present: "vorgelegt" });
      const replacement = await current();
      expect(replacement.id).not.toBe(asked.id);
      await decideChoice(replacement.id, CLEANUP_KEYS.discard, "web");

      held.resume();
      await clicked;
      expect(held.archived).toEqual([a]);
      // Die laufende Änderung war nicht mehr aufzuhalten und steht im Vermerk; der zweite Fakt bleibt
      expect(await contents()).toEqual(["Mia spielt Cello"]);
      const ledger = await readLedger(factCleanupFile(root));
      expect(Object.values(ledger.items).map(item => [item.id, item.state]).sort()).toEqual([[a, "erledigt"], [b, "verworfen"]].sort());
      expect(ledger.groups.map(g => [g.state, g.choiceId])).toEqual([["fertig", replacement.id]]);
      expect(await open()).toEqual([]);
    });

    test("Frist ohne Anspruch: Handler kam nie an, erst nach zehn Minuten kommt die Gruppe wieder; ein verspäteter Handler ändert nichts", async () => {
      const a = await seed("Alex trinkt Tee");
      const entries = [clear(a, "Alex trinkt Tee")];
      await prepare(entries);
      const asked = await current();
      undo.pop()!();
      undo.push(() => {});
      const { choice } = (await decideChoice(asked.id, CLEANUP_KEYS.apply, "web")) as { choice: Choice };

      expect(await prepare(entries)).toMatchObject({ present: "besetzt" });
      expect(await open()).toEqual([]);
      expect(await prepare(entries, { now: later })).toMatchObject({ present: "vorgelegt" });
      const replacement = await current();

      await createCleanupChoices(cleanupDeps(root, notices)).handler(choice);
      expect(notices).toContain(CLEANUP_TEXT.stale);
      expect(await contents()).toEqual(["Alex trinkt Tee"]);
      expect((await current()).id).toBe(replacement.id);
      expect((await groups())[0]).toMatchObject({ state: "offen", choiceId: replacement.id });
    });

    test("Handler scheitert, sein Prozess lebt weiter: Der Anspruch ist weg, nach der Frist kommt die Gruppe wieder", async () => {
      const a = await seed("Alex trinkt Tee");
      const entries = [clear(a, "Alex trinkt Tee")];
      await prepare(entries);
      useHandler({
        createChoice: async () => {
          throw new Error("kaputt");
        },
      });
      await click(CLEANUP_KEYS.list);
      expect((await groups())[0].handler).toBeUndefined();
      expect(await prepare(entries)).toMatchObject({ present: "besetzt" });
      expect(await prepare(entries, { now: later })).toMatchObject({ present: "vorgelegt" });
      expect((await current()).action).toBe("uebersicht");
    });
  });

  describe("Oberflächen", () => {
    test("Telegram-Attrappe: lange Liste bleibt vollständig, jedes Stück passt, Knöpfe unter dem letzten", async () => {
      const entries: CleanupEntry[] = [];
      for (let i = 1; i <= 40; i++) {
        const text = `Fakt ${i} ${"mit langem Text ".repeat(20)}`.trim();
        entries.push(clear(await seed(text), text));
      }
      const sent: SendAndRecordInput[] = [];
      const send = async (input: SendAndRecordInput) => (sent.push(input), { sent: true, recorded: true, messages: [{ chatId: "4711", messageId: sent.length, buttons: true }] }) as unknown as SendAndRecordResult;
      const { createTelegramChoices } = await import("../src/lib/telegram-choices");
      const choices = createTelegramChoices({ send, telegram: () => true });
      undo.pop()!();
      undo.push(onChoiceDecided("cleanup", createCleanupChoices(cleanupDeps(root, notices, { sendChoice: c => choices.sendChoice(c) })).handler));
      await prepare(entries, { sendChoice: c => choices.sendChoice(c) });
      await click(CLEANUP_KEYS.list);
      const shown = sent.at(-1)!;
      expect(shown.text.length).toBeGreaterThan(4096);
      expect(shown.buttons?.flat().map(b => b.text)).toEqual(["Alle 40 archivieren", "Ausnahme wählen", "Verwerfen"]);
      const pieces = textChunks(shown.text, "plain");
      expect(pieces.length).toBeGreaterThan(1);
      expect(pieces.every(piece => piece.length <= 4096)).toBe(true);
      for (let i = 1; i <= 40; i++) expect(pieces.join("\n")).toContain(`Fakt ${i} mit langem`);
      await click(CLEANUP_KEYS.exceptions);
      expect(sent.at(-1)!.buttons?.flat()).toHaveLength(41);
      expect(await contents()).toHaveLength(40);
    });

    test("WebUI: Knöpfe im Direktchat, ein Klick dort wirkt einmal", async () => {
      const a = await seed("Alex trinkt Tee");
      await prepare([clear(a, "Alex trinkt Tee")]);
      const port = createBotChoices({});
      const { id } = await current();
      expect((await port.view(id, "dm")).options.map(o => o.label)).toEqual(["Alle 1 archivieren", "Liste zeigen", "Ausnahme wählen", "Verwerfen"]);
      expect((await port.decide("dm", id, CLEANUP_KEYS.list, "web")).status).toBe("decided");
      expect((await port.decide("dm", id, CLEANUP_KEYS.list, "web")).status).toBe("already");
      expect(await open()).toHaveLength(1);
      const expanded = await current();
      expect(expanded.text).toContain("Alex trinkt Tee");
      expect((await port.decide("dm", expanded.id, CLEANUP_KEYS.apply, "web")).status).toBe("decided");
      expect(await contents()).toEqual([]);
    });
  });

  describe("Befehl", () => {
    test("bereinigen: ohne Telegram im Web-Direktchat, Ausgabe ohne Texte, nichts geändert", async () => {
      const a = await seed("Streng geheimer Fakt");
      expect(await tybo("bereinigen", "--datei", writeList([{ kennung: Number(a), einstufung: "doppelt", begruendung: "Grund", originaltext: "Streng geheimer Fakt" }]))).toBe(0);
      expect(out[0]).toContain("neu aufgenommen: 1");
      expect(out.join("\n")).not.toContain("geheim");
      expect(await contents()).toEqual(["Streng geheimer Fakt"]);
      const asked = await current();
      expect(asked.conversation).toEqual({ type: "telegram", chatId: "web" });
      const notice = await pg.admin.unsafe("SELECT chat_id, metadata FROM public.messages WHERE metadata->>'choiceId' = $1", [asked.id]);
      expect(notice[0]).toMatchObject({ chat_id: "web", metadata: { display_only: true, source: "gedaechtnis" } });
    });

    test("kaputte Liste: Exit-Code 2, nichts vorgelegt, kein Vermerk; fehlende Datei: Exit-Code 1", async () => {
      await seed("Alex trinkt Tee");
      expect(await tybo("bereinigen", "--datei", writeList([{ kennung: 1, einstufung: "vielleicht" }]))).toBe(2);
      expect(errs.join("\n")).toContain("nicht angenommen");
      expect(await open()).toEqual([]);
      expect(await tybo("bereinigen", "--datei", join(root, "gibtsnicht.json"))).toBe(1);
      expect(await tybo("bereinigen")).toBe(2);
      expect(() => readFileSync(factCleanupFile(root))).toThrow();
    });

    test("ohne Migration: klare Meldung, nichts vorgelegt", async () => {
      const a = await seed("Alex trinkt Tee");
      await pg.admin.unsafe("ALTER TABLE public.memory RENAME COLUMN archived_at TO weg");
      expect(await tybo("bereinigen", "--datei", writeList([{ kennung: Number(a), einstufung: "doppelt", begruendung: "Grund", originaltext: "Alex trinkt Tee" }]))).toBe(1);
      expect(errs.join("\n")).toContain("20261031_memory_archive.sql");
      expect(await open()).toEqual([]);
    });

    test("archiv und zurueckholen: einzelne Kennung, alter Text bei Umschreibungen, --alle", async () => {
      const a = await seed("Alex trinkt Tee");
      const b = await seed("Mia spielt Cello");
      const c = await seed("Alex wohnt in Hamburg");
      await prepare([clear(a, "Alex trinkt Tee"), clear(b, "Mia spielt Cello"), rewrite(c, "Alex wohnt in Hamburg", "Alex wohnt in Bremen")]);
      await click(CLEANUP_KEYS.apply);
      await click(CLEANUP_KEYS.apply);

      expect(await tybo("archiv")).toBe(0);
      expect(out.join("\n")).toContain("Alex trinkt Tee");
      expect(await tybo("zurueckholen", a)).toBe(0);
      expect(out.at(-1)).toContain("aus dem Archiv");
      expect(await tybo("zurueckholen", a)).toBe(1);
      expect(out.at(-1)).toContain("nichts geändert");

      expect(await tybo("zurueckholen", c)).toBe(0);
      expect(out.at(-1)).toContain("alter Text");
      expect(await row(c)).toMatchObject({ content: "Alex wohnt in Hamburg", embedding_model: MODEL });

      expect(await tybo("zurueckholen", "--alle")).toBe(0);
      expect(await contents()).toEqual(["Alex trinkt Tee", "Alex wohnt in Hamburg", "Mia spielt Cello"]);
      expect(await tybo("zurueckholen")).toBe(2);
      // Zurückgeholtes wird nicht erneut vorgeschlagen
      expect(await prepare([clear(a, "Alex trinkt Tee")])).toMatchObject({ added: 0, known: 1, present: "nichts" });
    });

    test("umgeschrieben und danach von Hand geändert: nichts überschrieben", async () => {
      const c = await seed("Alex wohnt in Hamburg");
      await prepare([rewrite(c, "Alex wohnt in Hamburg", "Alex wohnt in Bremen")]);
      await click(CLEANUP_KEYS.apply);
      await pg.admin.unsafe("UPDATE public.memory SET content = 'Alex wohnt in Kiel' WHERE id = $1::bigint", [c]);
      expect(await tybo("zurueckholen", c)).toBe(1);
      expect((await row(c)).content).toBe("Alex wohnt in Kiel");
    });

    const states = async () => Object.values((await readLedger(factCleanupFile(root))).items).map(item => [item.klass, item.state]);

    test("Umschreiben, Archivieren, Zurückholen: erst aus dem Archiv, dann der alte Text, dann nichts mehr", async () => {
      const c = await seed("Alex wohnt in Hamburg");
      await prepare([rewrite(c, "Alex wohnt in Hamburg", "Alex wohnt in Bremen")]);
      await click(CLEANUP_KEYS.apply);
      await prepare([clear(c, "Alex wohnt in Bremen")]);
      await click(CLEANUP_KEYS.apply);
      expect((await row(c)).archived_at).not.toBeNull();

      expect(await tybo("zurueckholen", c)).toBe(0);
      expect(out.at(-1)).toContain("aus dem Archiv");
      expect(await row(c)).toMatchObject({ content: "Alex wohnt in Bremen", archived_at: null });
      expect(await states()).toEqual([["umschreiben", "erledigt"], ["doppelt", "zurueckgeholt"]]);

      expect(await tybo("zurueckholen", c)).toBe(0);
      expect(out.at(-1)).toContain("alter Text");
      expect(await row(c)).toMatchObject({ content: "Alex wohnt in Hamburg", archived_at: null, embedding_model: MODEL });
      expect(await states()).toEqual([["umschreiben", "zurueckgeholt"], ["doppelt", "zurueckgeholt"]]);

      expect(await tybo("zurueckholen", c)).toBe(1);
      expect((await row(c)).content).toBe("Alex wohnt in Hamburg");
    });

    test("A, B, C, Zurückholen: Schritt für Schritt über B nach A, nur die jeweilige Änderung ist vermerkt", async () => {
      const c = await seed("Text A");
      await prepare([rewrite(c, "Text A", "Text B")]);
      await click(CLEANUP_KEYS.apply);
      await prepare([rewrite(c, "Text B", "Text C")]);
      await click(CLEANUP_KEYS.apply);
      expect((await row(c)).content).toBe("Text C");

      expect(await tybo("zurueckholen", c)).toBe(0);
      expect((await row(c)).content).toBe("Text B");
      expect((await states()).map(([, state]) => state)).toEqual(["erledigt", "zurueckgeholt"]);

      expect(await tybo("zurueckholen", c)).toBe(0);
      expect((await row(c)).content).toBe("Text A");
      expect((await states()).map(([, state]) => state)).toEqual(["zurueckgeholt", "zurueckgeholt"]);

      expect(await tybo("zurueckholen", c)).toBe(1);
      expect((await row(c)).content).toBe("Text A");
    });

    test("A, B, C, archiviert: Zurückholen geht denselben Weg rückwärts", async () => {
      const c = await seed("Text A");
      await prepare([rewrite(c, "Text A", "Text B")]);
      await click(CLEANUP_KEYS.apply);
      await prepare([rewrite(c, "Text B", "Text C")]);
      await click(CLEANUP_KEYS.apply);
      await prepare([clear(c, "Text C")]);
      await click(CLEANUP_KEYS.apply);
      const seen: string[] = [];
      for (let i = 0; i < 3; i++) {
        expect(await tybo("zurueckholen", c)).toBe(0);
        seen.push((await row(c)).content);
      }
      expect(seen).toEqual(["Text C", "Text B", "Text A"]);
    });

    test("A, B, C, dann von Hand geändert: nichts überschrieben, die letzte Änderung bleibt offen", async () => {
      const c = await seed("Text A");
      await prepare([rewrite(c, "Text A", "Text B")]);
      await click(CLEANUP_KEYS.apply);
      await prepare([rewrite(c, "Text B", "Text C")]);
      await click(CLEANUP_KEYS.apply);
      await pg.admin.unsafe("UPDATE public.memory SET content = 'Text D' WHERE id = $1::bigint", [c]);
      expect(await tybo("zurueckholen", c)).toBe(1);
      expect((await row(c)).content).toBe("Text D");
      expect((await states()).map(([, state]) => state)).toEqual(["erledigt", "erledigt"]);
    });

    test("Hilfe nennt alle Befehle, falscher Aufruf Exit-Code 2", async () => {
      expect(await tybo("help")).toBe(0);
      for (const name of ["ziele-nachholen", "bereinigen", "archiv", "zurueckholen"]) expect(out.join("\n")).toContain(name);
      expect(await tybo("archiv", "zuviel")).toBe(2);
    });
  });
});
