/**
 * Issue #523 gegen das echte Schema: Fakten bei Folgenachrichten und beim
 * Nachschlagen. Der ganze Weg läuft: echter Prompt-Builder und Store, echte
 * Function search-memory (_shared/memory-search.ts) im Prozess, echter
 * supabase-js-Client über postgrestFetch gegen PostgreSQL mit Schema und
 * Migrationen. Attrappe ist nur der Embedding-Anbieter, er zählt jeden Aufruf.
 * Alle Daten sind erfunden.
 *
 * Braucht TEST_PG_URL oder TEST_PG_BIN; ohne beide übersprungen, in der CI ein
 * Fehler (wie tests/schema-basis-pg.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createClient } from "@supabase/supabase-js";
import type { SQL } from "bun";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetCredentialCacheForTests } from "../src/lib/credentials";
import { buildPromptContext, buildResumePrompt, type PromptSources } from "../src/lib/prompt-builder";
import { getStore } from "../src/lib/store";
import { clearRegistryCache } from "../supabase/functions/_shared/embedding";
import { getBuiltinTool } from "../src/lib/tools/registry";
import "../src/lib/tools/history-search";
import { pgAvailable, respondViaPg, startPg, vec, type PgServer } from "./pg-harness";
import { FAKE_SUPABASE_URL, useFakeSupabase } from "./supabase-fixture";

const available = pgAvailable();

if (!available.ok && process.env.CI) {
  test("PostgreSQL für die Fakten im Gespräch ist in der CI eingerichtet", () => {
    throw new Error(`${available.reason}: der Dienst pgvector in .github/workflows/check.yml fehlt`);
  });
}

const CHAT = "111";
const MODEL = "openai:text-embedding-3-small";
const axis = (i: number) => {
  const v = new Array<number>(1536).fill(0);
  v[i] = 1;
  return v;
};
/** Thema der Nachricht: dieselbe Richtung wie die passenden Fakten */
const TOPICS: Record<string, number> = { Boote: 0, Imkerei: 1, Wetter: 2 };
const topicOf = (text: string) => Object.keys(TOPICS).find(topic => text.includes(topic));

/** Quellen, die mit dem Thema nichts zu tun haben; memorySince und followUp bleiben echt */
const QUIET: Partial<PromptSources> = {
  now: () => new Date("2026-10-31T09:00:00.000Z"),
  timeZone: () => "Europe/Berlin",
};

const FRESH_QUIET: Partial<PromptSources> = {
  ...QUIET,
  agent: () => undefined,
  overrides: () => "",
  consultation: () => "",
  profile: async () => "",
  core: async () => "",
  knowledge: async () => "",
  recent: async () => [],
  similar: async () => [],
};

describe.skipIf(!available.ok)("Fakten im laufenden Gespräch gegen das echte Schema", () => {
  let pg: PgServer;
  let service: SQL;
  let fake: ReturnType<typeof useFakeSupabase>;
  let edge: (req: Request) => Promise<Response>;
  /** Aufrufe beim Anbieter */
  let embeddings: string[];
  let providerDown: boolean;
  let functionDown: boolean;
  let dir: string;
  const spies: { mockRestore(): void }[] = [];
  const savedBudget = process.env.MEMORY_CONTEXT_CHARS;

  const seedFact = async (content: string, topic: number | null, extra: { archived?: boolean; created?: string } = {}) => {
    const rows = await pg.admin.unsafe(
      "INSERT INTO public.memory (type, content, created_at, archived_at, embedding, embedding_model) VALUES ('fact', $1, $2::timestamptz, $3::timestamptz, $4::vector, $5) RETURNING id",
      [content, extra.created ?? "2026-03-15T12:00:00Z", extra.archived ? "2026-10-01T12:00:00Z" : null, topic === null ? null : vec(axis(topic)), topic === null ? null : MODEL],
    );
    return String(rows[0].id);
  };

  /** Folgenachricht: Prompt und was danach als gezeigt gilt */
  const followUp = async (userMessage: string, shownFactIds: string[] = [], sinceMs?: number) => {
    let shown: string[] | undefined;
    const prompt = await buildResumePrompt({ userMessage, chatId: CHAT, shownFactIds, sinceMs, onFactsShown: ids => (shown = ids) }, QUIET);
    return { prompt, shown };
  };

  beforeAll(async () => {
    pg = await startPg();
    await pg.applySchema();
    service = await pg.connect("service_role");
    const { edgeHandler } = await import(`${"../supabase/functions/_shared/handler.ts"}`);
    const { searchMemory } = await import(`${"../supabase/functions/_shared/memory-search.ts"}`);
    const env: Record<string, string> = {
      SUPABASE_URL: FAKE_SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
      OPENAI_API_KEY: "sk-test-nur-in-der-function",
    };
    edge = edgeHandler(searchMemory, { env: (name: string) => env[name], connect: (url: string, key: string) => createClient(url, key) });
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  beforeEach(async () => {
    await pg.admin.unsafe("TRUNCATE public.memory, public.messages, public.embedding_settings RESTART IDENTITY CASCADE");
    await pg.admin.unsafe(`INSERT INTO public.embedding_settings (id, state, provider, model) VALUES (true, 'festgehalten', 'openai', 'text-embedding-3-small')`);
    embeddings = [];
    providerDown = false;
    functionDown = false;
    clearRegistryCache();
    dir = mkdtempSync(join(tmpdir(), "tybo-fakten-"));
    process.env.MEMORY_CONTEXT_CHARS = "6000";
    const rest = respondViaPg(service, FAKE_SUPABASE_URL);
    fake = useFakeSupabase({
      respond: request => {
        if (request.url.hostname === "api.openai.com") {
          const text = JSON.parse(request.body).input as string;
          embeddings.push(text);
          if (providerDown) return new Response("kaputt", { status: 500 });
          const topic = topicOf(text);
          // Eine Nachricht ohne Thema zeigt in eine eigene Richtung, die zu keinem Fakt passt
          return Response.json({ data: [{ embedding: axis(topic === undefined ? 9 : TOPICS[topic]) }] });
        }
        if (request.url.pathname === "/functions/v1/search-memory") {
          if (functionDown) return new Response("aus", { status: 503 });
          return edge(new Request(request.url, { method: "POST", headers: request.headers, body: request.body }));
        }
        return rest(request);
      },
    });
    resetCredentialCacheForTests();
    spies.push(spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {}));
  });

  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
    fake.restore();
    rmSync(dir, { recursive: true, force: true });
    if (savedBudget === undefined) delete process.env.MEMORY_CONTEXT_CHARS;
    else process.env.MEMORY_CONTEXT_CHARS = savedBudget;
  });

  test("Folgenachricht zu einem anderen Thema bringt den passenden Fakt, mit Datum und Vorbehalt", async () => {
    await seedFact("Alex baut Boote aus Lärchenholz", TOPICS.Boote);
    const bees = await seedFact("Mia hat zwölf Bienenvölker", TOPICS.Imkerei);

    const { prompt, shown } = await followUp("Was war noch mal mit der Imkerei?");

    expect(prompt).toContain("## RELEVANT FACTS");
    expect(prompt).toContain("- [2026-03-15] Mia hat zwölf Bienenvölker");
    expect(prompt).toContain("Anlagedatum");
    expect(prompt).not.toContain("Lärchenholz");
    expect(shown).toEqual([bees]);
  });

  test("Anbieter-Aufrufe: genau einer je Folgenachricht, im Bot keiner", async () => {
    await seedFact("Mia hat zwölf Bienenvölker", TOPICS.Imkerei);
    await followUp("Was war noch mal mit der Imkerei?");
    expect(embeddings).toEqual(["Was war noch mal mit der Imkerei?"]);
  });

  test("Anbieter-Aufrufe: auch ohne passenden Fakt und im Rückfall auf Text kein zweiter", async () => {
    await seedFact("Mia hat zwölf Bienenvölker", TOPICS.Imkerei);
    await followUp("Etwas ganz anderes ohne Treffer");
    expect(embeddings).toHaveLength(1);
  });

  test("Wiederholung: Was die Session kennt, kommt nicht noch einmal", async () => {
    const bees = await seedFact("Mia hat zwölf Bienenvölker", TOPICS.Imkerei);
    const honey = await seedFact("Der Honig von Mia ist Waldhonig", TOPICS.Imkerei);

    const first = await followUp("Was war mit der Imkerei?", [bees]);
    expect(first.prompt).not.toContain("zwölf Bienenvölker");
    expect(first.prompt).toContain("Waldhonig");
    expect(first.shown).toEqual([bees, honey]);

    const second = await followUp("Was war mit der Imkerei?", first.shown);
    expect(second.prompt).not.toContain("## RELEVANT FACTS");
    expect(second.shown).toEqual([bees, honey]);
  });

  test("Höchstmenge: bei vielen passenden Fakten fünf, bei wenigen entsprechend weniger", async () => {
    for (let i = 0; i < 8; i++) await seedFact(`Imkerei-Fakt Nummer ${i}`, TOPICS.Imkerei);
    const many = await followUp("Was war mit der Imkerei?");
    expect(many.prompt.match(/Imkerei-Fakt Nummer/g)).toHaveLength(5);
    expect(many.shown).toHaveLength(5);
    await seedFact("Bootsfakt allein", TOPICS.Boote);
    const few = await followUp("Was war mit dem Boote-Thema?");
    expect(few.prompt.match(/^- \[/gm)).toHaveLength(1);
  });

  test("Nulltreffer: kein Abschnitt, nichts wird als gezeigt verbucht", async () => {
    await seedFact("Mia hat zwölf Bienenvölker", TOPICS.Imkerei);
    const { prompt, shown } = await followUp("Etwas ganz anderes ohne Treffer", ["99"]);
    expect(prompt).not.toContain("## RELEVANT FACTS");
    expect(shown).toEqual(["99"]);
  });

  test("Archiv: ein archivierter Fakt kommt in keine automatische Auswahl, auch nicht über die Textsuche", async () => {
    await seedFact("Archivierte Imkerei von früher", TOPICS.Imkerei, { archived: true });
    expect((await followUp("Wie lief die Imkerei von früher?")).prompt).not.toContain("Archivierte");
    providerDown = true;
    expect((await followUp("Wie lief die Imkerei von früher?")).prompt).not.toContain("Archivierte");
  });

  test("Ohne Vektor: Textsuche findet den Fakt, ohne Anbieter im Bot, einzelne Allerweltswörter reichen nicht", async () => {
    await seedFact("Mia verkauft Waldhonig beim Wochenmarkt", null);
    await seedFact("Das Auto steht beim Wochenmarkt", null);
    providerDown = true;

    const { prompt } = await followUp("Wo verkauft Mia ihren Waldhonig?");

    expect(prompt).toContain("Mia verkauft Waldhonig");
    expect(prompt).not.toContain("Das Auto");
  });

  test("Ältere Function oder keine Function: Rückfall auf Text ohne Anbieter-Aufruf im Bot", async () => {
    await seedFact("Mia verkauft Waldhonig beim Wochenmarkt", null);
    functionDown = true;
    const { prompt } = await followUp("Wo verkauft Mia ihren Waldhonig?");
    expect(prompt).toContain("Mia verkauft Waldhonig");
    expect(embeddings).toEqual([]);
  });

  test("Frischer Prompt nennt die gezeigten Fakten, die Auswahl über dem Budget nur die ausgewählten", async () => {
    process.env.MEMORY_CONTEXT_CHARS = "10";
    const texts = new Map<string, string>();
    for (let i = 0; i < 12; i++) {
      const text = `Fakt Nummer ${String(i).padStart(2, "0")} zum Boote-Thema`;
      texts.set(await seedFact(text, TOPICS.Boote), text);
    }
    const fresh = await buildPromptContext({ userMessage: "Boote", chatId: CHAT, agentName: "general" }, FRESH_QUIET);
    expect(fresh.shownFactIds).toHaveLength(10);
    for (const id of fresh.shownFactIds!) expect(fresh.fullPrompt).toContain(texts.get(id)!);
    const follow = await followUp("Was war mit dem Boote-Thema?", fresh.shownFactIds);
    expect(follow.prompt.match(/Fakt Nummer/g)).toHaveLength(2);
    for (const id of fresh.shownFactIds!) expect(follow.prompt).not.toContain(texts.get(id)!);
  });

  test("MEMORY UPDATES zählen als gezeigt und stehen nicht doppelt da", async () => {
    const id = await seedFact("Neu: die Imkerei zieht um", TOPICS.Imkerei, { created: "2026-10-30T12:00:00Z" });
    const { prompt, shown } = await followUp("Was war mit der Imkerei?", [], Date.parse("2026-10-01T00:00:00Z"));
    expect(prompt).toContain("## MEMORY UPDATES");
    expect(prompt).not.toContain("## RELEVANT FACTS");
    expect(prompt.match(/zieht um/g)).toHaveLength(1);
    expect(shown).toEqual([id]);
  });

  test("history_search findet den Fakt, das Archiv nicht, und unterscheidet Fehler von Nulltreffern", async () => {
    await seedFact("Mia hat zwölf Bienenvölker", TOPICS.Imkerei);
    await seedFact("Alte Imkerei im Archiv", TOPICS.Imkerei, { archived: true });
    process.env.OPENAI_API_KEY = "sk-test-im-bot";
    const tool = getBuiltinTool("history_search")!;

    const found = JSON.parse(await tool.handler({ query: "Imkerei" }));
    expect(found.facts).toEqual([{ date: "2026-03-15", text: "Mia hat zwölf Bienenvölker" }]);
    expect(found.unavailable).toBeUndefined();

    const none = JSON.parse(await tool.handler({ query: "Etwas Unbekanntes" }));
    expect(none.facts).toBeUndefined();
    expect(none.unavailable).toBeUndefined();
    expect(none.hint).toContain("Keine Treffer");

    await pg.admin.unsafe("ALTER TABLE public.memory RENAME TO memory_weg");
    try {
      const broken = JSON.parse(await tool.handler({ query: "Imkerei" }));
      expect(broken.unavailable).toEqual(["facts"]);
      expect(broken.hint).toContain("gescheitert");
    } finally {
      await pg.admin.unsafe("ALTER TABLE public.memory_weg RENAME TO memory");
      delete process.env.OPENAI_API_KEY;
    }
  });

  /** Ergebnis von history_search, während die Tabelle in der Datenbank fehlt */
  const searchWithout = async (table: string, query: string) => {
    await pg.admin.unsafe(`ALTER TABLE public.${table} RENAME TO ${table}_weg`);
    try {
      return JSON.parse(await getBuiltinTool("history_search")!.handler({ query }));
    } finally {
      await pg.admin.unsafe(`ALTER TABLE public.${table}_weg RENAME TO ${table}`);
    }
  };

  test.each([
    ["messages", "messages"],
    ["knowledge", "knowledge_base"],
    ["assets", "images"],
  ])("history_search: fehlt die Tabelle %s, ist die Quelle %s unavailable und kein Nulltreffer", async (table, source) => {
    const before = JSON.parse(await getBuiltinTool("history_search")!.handler({ query: "Etwas Unbekanntes" }));
    expect(before.unavailable).toBeUndefined();
    expect(before.hint).toContain("Keine Treffer");

    const broken = await searchWithout(table, "Etwas Unbekanntes");
    expect(broken.unavailable).toEqual([source]);
    expect(broken.hint).toContain("gescheitert");
    expect(broken.hint).not.toContain("Keine Treffer");
  });

  test("history_search: Nachrichten ausgefallen, der gefundene Fakt kommt trotzdem, die Quelle bleibt genannt", async () => {
    await seedFact("Mia verkauft Waldhonig beim Wochenmarkt", null);
    const partial = await searchWithout("messages", "Waldhonig");
    expect(partial.facts.map((f: { text: string }) => f.text)).toEqual(["Mia verkauft Waldhonig beim Wochenmarkt"]);
    expect(partial.unavailable).toEqual(["messages"]);
    expect(partial.hint).toBeUndefined();
  });

  test("history_search: Function kaputt, aber Nachrichten lesbar: die Textsuche findet, nichts gilt als ausgefallen", async () => {
    await pg.admin.unsafe("INSERT INTO public.messages (chat_id, role, content) VALUES ($1, 'user', 'Waldhonig vom Wochenmarkt')", [CHAT]);
    functionDown = true;
    process.env.TELEGRAM_USER_ID = CHAT;
    resetCredentialCacheForTests();
    try {
      const found = JSON.parse(await getBuiltinTool("history_search")!.handler({ query: "Waldhonig" }));
      expect(found.messages.map((m: { text: string }) => m.text)).toEqual(["Waldhonig vom Wochenmarkt"]);
      expect(found.unavailable).toBeUndefined();
    } finally {
      delete process.env.TELEGRAM_USER_ID;
      resetCredentialCacheForTests();
    }
  });

  /** So viele neuere Treffer, wie die Textsuche früher überhaupt angesehen hat, und mehr */
  const seedNewerFacts = async (content: string, count = 250) => {
    const rows = await pg.admin.unsafe(
      `INSERT INTO public.memory (type, content, created_at)
       SELECT 'fact', $1 || ' ' || n, '2026-10-01T12:00:00Z'::timestamptz + n * interval '1 minute' FROM generate_series(1, $2::int) AS n
       RETURNING id`,
      [content, count],
    );
    return [...rows].map((row: { id: unknown }) => String(row.id));
  };

  test("Textsuche: Viele neue schwache Treffer verdrängen den älteren passenden Fakt nicht", async () => {
    await seedFact("Mia verkauft Waldhonig beim Wochenmarkt", null, { created: "2024-01-01T12:00:00Z" });
    // Ein gemeinsames Wort („verkauft“), die Folgenachricht verlangt zwei
    await seedNewerFacts("Das Auto wird verkauft");
    providerDown = true;

    const { prompt } = await followUp("Wo verkauft Mia ihren Waldhonig?");
    expect(prompt).toContain("Mia verkauft Waldhonig");
    expect(prompt).not.toContain("Das Auto");
  });

  test("Textsuche: Viele neue bekannte Fakten verdrängen den älteren passenden Fakt nicht", async () => {
    const older = await seedFact("Mia verkauft Waldhonig beim Wochenmarkt", null, { created: "2024-01-01T12:00:00Z" });
    const known = await seedNewerFacts("Mia verkauft Waldhonig auf dem Wochenmarkt, Stand");
    const memory = getStore().memory;

    const found = await memory.searchFacts("Waldhonig Wochenmarkt", 5, { excludeIds: known, minTerms: 2 });
    expect(found.map(f => String(f.id))).toEqual([older]);
  });

  test("Textsuche: Ohne Ausschluss kommen die Treffer mit den meisten Wörtern, jeder einmal", async () => {
    const older = await seedFact("Mia verkauft Waldhonig beim Wochenmarkt", null, { created: "2024-01-01T12:00:00Z" });
    await seedNewerFacts("Das Auto steht beim Wochenmarkt");
    const found = await getStore().memory.searchFacts("Waldhonig Wochenmarkt", 500);
    expect(String(found[0].id)).toBe(older);
    expect(found).toHaveLength(251);
    expect(new Set(found.map(f => f.id)).size).toBe(251);
  });

  test("Suche nach Fakten im Store: Bedeutung und Text, ohne Archiv, Fehler wirft", async () => {
    await seedFact("Mia hat zwölf Bienenvölker", TOPICS.Imkerei);
    await seedFact("Alte Imkerei im Archiv", TOPICS.Imkerei, { archived: true });
    const memory = getStore().memory;
    // Das Nachschlagen rechnet seinen Vektor im Bot, dafür braucht er hier den Schlüssel
    process.env.OPENAI_API_KEY = "sk-test-im-bot";
    expect((await memory.searchFacts("Imkerei", 5, { meaning: true })).map(f => f.content)).toEqual(["Mia hat zwölf Bienenvölker"]);
    expect(await memory.searchFacts("Völlig Unbekanntes", 5, { meaning: true })).toEqual([]);
    delete process.env.OPENAI_API_KEY;
    expect((await memory.searchFacts("zwölf Bienenvölker", 5)).map(f => f.content)).toEqual(["Mia hat zwölf Bienenvölker"]);
    await pg.admin.unsafe("ALTER TABLE public.memory RENAME TO memory_weg");
    try {
      await expect(memory.searchFacts("Bienenvölker", 5)).rejects.toThrow("Fakten suchen gescheitert");
    } finally {
      await pg.admin.unsafe("ALTER TABLE public.memory_weg RENAME TO memory");
    }
  });
});
