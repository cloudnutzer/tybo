/**
 * Issue #317: db/migrations/20261017_knowledge_context.sql gegen echtes
 * PostgreSQL mit pgvector (tests/pg-harness.ts). Belegt: „Größe“ findet den
 * Eintrag per Text, Vorrang je Kategorie, Bedeutungssuche nur mit Anbieter
 * und Modell, die die Datenbank festhält (sonst Textrückfall), Platzhalter
 * wörtlich, ohne Suchwort keine Texttreffer, und archivierte, ersetzte oder
 * abgelaufene Einträge bleiben draußen.
 *
 * Braucht TEST_PG_URL oder TEST_PG_BIN; ohne beide übersprungen, in der CI
 * ein Fehler (wie tests/embedding-reindex-pg.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { pgAvailable, startPg, vec, type PgServer } from "./pg-harness";

const available = pgAvailable();

if (!available.ok && process.env.CI) {
  test("PostgreSQL für die Tests der Wissensbasis ist in der CI eingerichtet", () => {
    throw new Error(`${available.reason}: der Dienst pgvector in .github/workflows/check.yml fehlt`);
  });
}

/** Textfeld als Array-Literal für ::text[] (Bun gibt JS-Felder sonst als leeren Text weiter) */
const textArray = (items: string[]) => `{${items.map(item => `"${item.replace(/["\\]/g, c => `\\${c}`)}"`).join(",")}}`;

/** Einheitsvektor in Richtung der Achse i */
const axis = (i: number) => vec(Array.from({ length: i + 1 }, (_, j) => (j === i ? 1 : 0)));

describe.skipIf(!available.ok)("Migration 20261017 gegen echtes PostgreSQL", () => {
  let pg: PgServer;
  let svc: SQL;

  beforeAll(async () => {
    pg = await startPg();
    await pg.applySchema();
    svc = await pg.connect("service_role");
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  beforeEach(async () => {
    await pg.admin.unsafe("SET session_replication_role = replica");
    await pg.admin.unsafe("TRUNCATE public.knowledge, public.embedding_settings, public.embedding_reindex, public.embedding_reindex_queue CASCADE");
    await pg.admin.unsafe("SET session_replication_role = DEFAULT");
    await pg.admin.unsafe(`INSERT INTO public.embedding_settings (id, state, provider, model) VALUES (true, 'festgehalten', 'openai', 'text-embedding-3-small')`);
  });

  /** Eintrag direkt als Superuser (ohne Trigger), optional mit Vektor */
  async function seed(row: { title: string; content: string; category?: string; status?: string; expires?: string; tags?: string[]; at?: string; embedding?: string; model?: string }) {
    await pg.admin.unsafe("SET session_replication_role = replica");
    const [inserted] = await pg.admin.unsafe(
      `INSERT INTO public.knowledge (category, title, content, status, expires_at, tags, updated_at, embedding, embedding_model)
       VALUES ($1, $2, $3, $4, $5::timestamptz, $6::text[], $7::timestamptz, $8::vector, $9) RETURNING id`,
      [row.category ?? "reference", row.title, row.content, row.status ?? "active", row.expires ?? null, textArray(row.tags ?? []), row.at ?? "2026-10-01T10:00:00Z", row.embedding ?? null, row.model ?? (row.embedding ? "openai:text-embedding-3-small" : null)],
    );
    await pg.admin.unsafe("SET session_replication_role = DEFAULT");
    return String(inserted.id);
  }

  type Ctx = { terms?: string[]; provider?: string | null; model?: string | null; embedding?: string | null; perCategory?: number };
  async function context(c: Ctx = {}) {
    const rows = await svc.unsafe(
      `SELECT * FROM public.knowledge_context($1::text[], $2, $3, $4::vector, $5, 3, 5, 0.7)`,
      [textArray(c.terms ?? []), c.provider ?? null, c.model ?? null, c.embedding ?? null, c.perCategory ?? 3],
    );
    return [...rows].map(r => ({ title: r.title as string, reason: r.reason as string }));
  }

  test("„Größe“ findet den Eintrag per Text, auch über ein Schlagwort", async () => {
    await seed({ title: "Rahmen", content: "Die Größe des Rahmens ist 56 cm.", at: "2026-10-02T10:00:00Z" });
    await seed({ title: "Reifen", content: "28 Zoll", tags: ["Größe"] });
    await seed({ title: "Kaffee", content: "Espresso" });
    expect(await context({ terms: ["Größe"] })).toEqual([
      { title: "Rahmen", reason: "text" },
      { title: "Reifen", reason: "text" },
    ]);
  });

  test("Vorrang: je Kategorie die neuesten, Reihenfolge project, decision, preference", async () => {
    for (let i = 0; i < 4; i++) await seed({ category: "project", title: `P${i}`, content: "x", at: `2026-10-0${i + 1}T10:00:00Z` });
    await seed({ category: "preference", title: "Ton", content: "kurz" });
    await seed({ category: "decision", title: "Wahl", content: "A" });
    expect(await context()).toEqual([
      { title: "P3", reason: "priority" },
      { title: "P2", reason: "priority" },
      { title: "P1", reason: "priority" },
      { title: "Wahl", reason: "priority" },
      { title: "Ton", reason: "priority" },
    ]);
  });

  test("archiviert, ersetzt und abgelaufen bleiben draußen", async () => {
    await seed({ title: "Alt archiviert", content: "Größe", status: "archived" });
    await seed({ title: "Abgelaufen", content: "Größe", expires: "2020-01-01T00:00:00Z" });
    const newer = await seed({ title: "Neu", content: "Größe" });
    const old = await seed({ title: "Ersetzt", content: "Größe" });
    await pg.admin.unsafe("UPDATE public.knowledge SET superseded_by = $1::uuid WHERE id = $2::uuid", [newer, old]);
    expect(await context({ terms: ["Größe"] })).toEqual([{ title: "Neu", reason: "text" }]);
  });

  test("Bedeutung mit festgehaltenem Anbieter: Treffer, dann kein Textrückfall", async () => {
    await seed({ title: "Kaffee", content: "Espresso", embedding: axis(0) });
    await seed({ title: "Rahmen", content: "Größe", embedding: axis(1) });
    const hits = await context({ terms: ["Größe"], provider: "openai", model: "text-embedding-3-small", embedding: axis(0) });
    expect(hits).toEqual([{ title: "Kaffee", reason: "semantic" }]);
  });

  test("Anbieterwechsel, fremdes embedding_model oder fehlende Vektoren: Textrückfall", async () => {
    await seed({ title: "Kaffee", content: "Espresso", embedding: axis(0) });
    await seed({ title: "Rahmen", content: "Größe" });
    // Die Datenbank hält OpenAI fest, der Suchvektor kommt von Gemini
    expect(await context({ terms: ["Größe"], provider: "gemini", model: "gemini-embedding-2", embedding: axis(0) })).toEqual([{ title: "Rahmen", reason: "text" }]);
    // Zeile mit fremder Kennung zählt nicht
    await pg.admin.unsafe("UPDATE public.embedding_settings SET provider = 'gemini', model = 'gemini-embedding-2'");
    expect(await context({ terms: ["Größe"], provider: "gemini", model: "gemini-embedding-2", embedding: axis(0) })).toEqual([{ title: "Rahmen", reason: "text" }]);
    // Ohne Vektor
    expect(await context({ terms: ["Größe"] })).toEqual([{ title: "Rahmen", reason: "text" }]);
  });

  test("match_knowledge_checked: nur mit festgehaltenem Anbieter und passender Kategorie", async () => {
    await seed({ title: "Kaffee", content: "Espresso", category: "learning", embedding: axis(0) });
    const run = (provider: string, category: string | null) =>
      svc.unsafe(`SELECT title FROM public.match_knowledge_checked($1, 'text-embedding-3-small', $2::vector, 0.7, 5, $3)`, [provider, axis(0), category]);
    expect([...(await run("openai", null))].map(r => r.title)).toEqual(["Kaffee"]);
    expect([...(await run("openai", "learning"))].map(r => r.title)).toEqual(["Kaffee"]);
    expect([...(await run("openai", "tool"))]).toEqual([]);
    expect([...(await run("gemini", null))]).toEqual([]);
  });

  test("Platzhalter wörtlich, leere Wörter und kein Wort ergeben keine Texttreffer", async () => {
    await seed({ title: "Rabatt", content: "50 Prozent" });
    await seed({ title: "Zins", content: "5% im Jahr" });
    expect(await context({ terms: ["%"] })).toEqual([{ title: "Zins", reason: "text" }]);
    expect(await context({ terms: ["_"] })).toEqual([]);
    expect(await context({ terms: ["", "  "] })).toEqual([]);
    expect(await context({ terms: [] })).toEqual([]);
  });

  test("nur service_role darf die Funktionen aufrufen", async () => {
    for (const fn of ["public.knowledge_context(text[], text, text, vector, int, int, int, float)", "public.match_knowledge_checked(text, text, vector, float, int, text)"]) {
      const [row] = await pg.admin.unsafe(
        `SELECT has_function_privilege('anon', '${fn}', 'EXECUTE') AS anon, has_function_privilege('authenticated', '${fn}', 'EXECUTE') AS auth, has_function_privilege('service_role', '${fn}', 'EXECUTE') AS svc`,
      );
      expect(row).toEqual({ anon: false, auth: false, svc: true });
    }
  });
});
