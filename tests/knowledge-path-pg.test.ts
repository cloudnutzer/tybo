/**
 * Issue #521: der ganze Weg eines [KNOWLEDGE:]-Tags gegen das echte Schema,
 * über echten Parser, intent-gate, Gedächtnis-Dienst und Store bis zum
 * registrierten Werkzeug history_search. Der supabase-js-Client läuft über
 * postgrestFetch (tests/pg-harness.ts) gegen echtes PostgreSQL; applySchema
 * spielt Basisschema und Migrationen ein (die Tabelle knowledge steht nur in
 * einer Migration). Alle Daten sind erfunden.
 *
 * Ohne Embedding-Schlüssel findet die Textsuche den Eintrag, die
 * Bedeutungssuche prüft tests/knowledge-context-pg.test.ts.
 *
 * Braucht TEST_PG_URL oder TEST_PG_BIN; ohne beide übersprungen, in der CI
 * ein Fehler (wie tests/schema-basis-pg.test.ts).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SQL } from "bun";
import { resetCredentialCacheForTests } from "../src/lib/credentials";
import { decideReview, gateTurnIntents } from "../src/lib/intent-gate";
import { setPendingReviewsFileForTests, setReviewNotifier, type ReviewProposal } from "../src/lib/session-distill";
import { callBuiltinTool } from "../src/lib/tools/registry";
import "../src/lib/tools/history-search";
import { pgAvailable, respondViaPg, startPg, type PgServer } from "./pg-harness";
import { FAKE_SUPABASE_URL, useFakeSupabase } from "./supabase-fixture";

const available = pgAvailable();

if (!available.ok && process.env.CI) {
  test("PostgreSQL für den Wissenspfad ist in der CI eingerichtet", () => {
    throw new Error(`${available.reason}: der Dienst pgvector in .github/workflows/check.yml fehlt`);
  });
}

const TITLE = "Kaffeemühlen im Vergleich";
const CONTENT = "Scheibenmahlwerke mahlen gleichmäßiger als Kegelmahlwerke";
const TAG = `[KNOWLEDGE: reference | ${TITLE} | ${CONTENT}]`;
const REPLY = `Hier ist das Ergebnis der Recherche. ${TAG}`;
const QUERY = "Scheibenmahlwerke";
const PROJECT = "/projekt";
const FOREIGN = { uses: [{ name: "WebFetch" }], cwd: PROJECT };
const TARGET = { chatId: "111", origin: "Telegram" };

describe.skipIf(!available.ok)("Weg vom Tag bis zur Suche gegen das echte Schema", () => {
  let pg: PgServer;
  let service: SQL;
  let fake: ReturnType<typeof useFakeSupabase>;
  let dir: string;
  let proposals: ReviewProposal[];
  const spies: { mockRestore(): void }[] = [];

  beforeAll(async () => {
    pg = await startPg();
    await pg.applySchema();
    // Wie der Bot: mit dem Service-Role-Key, also dieser Rolle
    service = await pg.connect("service_role");
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  beforeEach(async () => {
    await pg.admin.unsafe("TRUNCATE public.knowledge, public.memory RESTART IDENTITY CASCADE");
    dir = mkdtempSync(join(tmpdir(), "tybo-wissen-"));
    setPendingReviewsFileForTests(join(dir, "pending-reviews.json"));
    proposals = [];
    setReviewNotifier(async proposal => {
      proposals.push(proposal);
    });
    fake = useFakeSupabase({ respond: respondViaPg(service, FAKE_SUPABASE_URL) });
    // history_search ist nur mit SUPABASE_URL verfügbar. Das Ergebnis bleibt im
    // Prozess gespeichert, eine frühere Testdatei ohne die Variable sperrte es sonst
    resetCredentialCacheForTests();
    spies.push(spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {}));
  });

  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore();
    setReviewNotifier(null);
    setPendingReviewsFileForTests(null);
    fake.restore();
    resetCredentialCacheForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  const count = async (table: "knowledge" | "memory") => {
    const [row] = await pg.admin.unsafe(`SELECT count(*)::int AS n FROM public.${table}`);
    return row.n as number;
  };

  /** Das registrierte Werkzeug, wie es Modell und Sprach-Brücke aufrufen */
  async function search(query: string): Promise<{ knowledge_base?: string; hint?: string }> {
    const result = await callBuiltinTool("history_search", { query });
    expect(result.isError).toBeFalsy();
    return JSON.parse(result.content);
  }

  const gate = (text: string, tools: Parameters<typeof gateTurnIntents>[1]) => gateTurnIntents(text, tools, TARGET, { projectRoot: PROJECT, log: () => {} });

  test("nach fremden Inhalten: vor der Zustimmung nichts, danach auffindbar und kein zusätzlicher Fakt", async () => {
    const result = await gate(REPLY, FOREIGN);
    expect(result.outcome).toBe("staged");
    expect(proposals).toHaveLength(1);
    expect(await count("knowledge")).toBe(0);
    expect((await search(QUERY)).knowledge_base).toBeUndefined();

    const decision = await decideReview("ok", proposals[0].reviewId);
    expect(decision).toMatchObject({ kind: "applied" });
    expect(await count("knowledge")).toBe(1);
    expect(await count("memory")).toBe(0);
    expect((await search(QUERY)).knowledge_base).toBe(`**Knowledge Base:**\n- [reference] ${TITLE}: ${CONTENT}`);
    // Über die Datenbankfunktion, nicht über den Rückfall mit Einzelabfragen
    expect(fake.requests.some(r => r.url.pathname === "/rest/v1/rpc/knowledge_context")).toBe(true);
  });

  test("nach Ablehnung: nichts gespeichert, nichts auffindbar", async () => {
    await gate(REPLY, FOREIGN);
    expect(await decideReview("no", proposals[0].reviewId)).toMatchObject({ kind: "discarded" });
    expect(await count("knowledge")).toBe(0);
    expect(await count("memory")).toBe(0);
    const found = await search(QUERY);
    expect(found.knowledge_base).toBeUndefined();
    expect(found.hint).toBeDefined();
  });

  test("ohne fremde Inhalte direkt gespeichert, kein Vorschlag, kein Fakt", async () => {
    const result = await gate(REPLY, { uses: [], cwd: PROJECT });
    expect(result.outcome).toBe("applied");
    expect(result.processed?.knowledgeAdded).toEqual([TITLE]);
    expect(proposals).toEqual([]);
    expect(await count("memory")).toBe(0);
    expect((await search("Kaffeemühlen")).knowledge_base).toContain(TITLE);
  });

  test("gleiche Kategorie und gleicher Titel ersetzen den alten Stand", async () => {
    await gate(REPLY, { uses: [], cwd: PROJECT });
    await gate(`[KNOWLEDGE: reference | ${TITLE} | Hohlkegel mahlen leiser]`, { uses: [], cwd: PROJECT });
    expect(await count("knowledge")).toBe(1);
    const found = (await search("Hohlkegel")).knowledge_base;
    expect(found).toContain("Hohlkegel mahlen leiser");
    expect(found).not.toContain("Scheibenmahlwerke");
  });

  test("unbekannte Kategorie: kein Eintrag und kein Fakt", async () => {
    await gate(`[KNOWLEDGE: rezept | ${TITLE} | ${CONTENT}]`, { uses: [], cwd: PROJECT });
    expect(await count("knowledge")).toBe(0);
    expect(await count("memory")).toBe(0);
  });

  test("lange Recherche: voll gespeichert, die Suche zeigt nur den Anfang", async () => {
    const start = "Scheibenmahlwerke gewinnen den Vergleich.";
    const long = `${start} ${"Weitere Einzelheiten zum Mahlgrad. ".repeat(30)}Schlusssatz`;
    await gate(`[KNOWLEDGE: learning | Mahlwerke ausführlich | ${long}]`, { uses: [], cwd: PROJECT });
    const [row] = await pg.admin.unsafe("SELECT content FROM public.knowledge");
    expect(row.content).toBe(long);
    const found = (await search(QUERY)).knowledge_base ?? "";
    expect(found).toContain(start);
    expect(found).not.toContain("Schlusssatz");
  });
});
