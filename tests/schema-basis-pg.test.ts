/**
 * Issue #319: Verhalten von db/schema.sql allein (ohne Migrationen) gegen echtes
 * PostgreSQL mit pgvector (tests/pg-harness.ts). Hält fest, was die
 * Neufassung nicht ändern darf: Prüfungen und Vorgaben der Tabellen, RLS mit
 * der Policy für service_role, und die Suche von match_messages und
 * match_assets (Ähnlichkeit 1 - Kosinusabstand, strikt über der Schwelle,
 * ohne Vektor nie, absteigend sortiert, höchstens match_count, Filter nach
 * Chat). Die Migration 20260928 ersetzt beide Funktionen später; ein
 * Dump-Vergleich der Schema-Fassungen blendet ihren Text darum aus, ihr
 * Verhalten belegt dieser Test.
 *
 * Braucht TEST_PG_URL oder TEST_PG_BIN; ohne beide übersprungen, in der CI
 * ein Fehler (wie tests/embedding-reindex-pg.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { pgAvailable, startPg, vec, type PgServer } from "./pg-harness";

const available = pgAvailable();

if (!available.ok && process.env.CI) {
  test("PostgreSQL für die Tests von db/schema.sql ist in der CI eingerichtet", () => {
    throw new Error(`${available.reason}: der Dienst pgvector in .github/workflows/check.yml fehlt`);
  });
}

const TABLES = ["messages", "memory", "logs", "call_transcripts", "async_tasks", "node_heartbeat", "assets"];
/** Abschnitte langer Nachrichten (Issue #479): RLS wie die übrigen, aber ohne eigene Policy, wie in der Migration 20261015 */
const CHUNK_TABLE = "message_chunks";

/** Einheitsvektor in Richtung der Achse i */
const axis = (i: number) => vec(Array.from({ length: i + 1 }, (_, j) => (j === i ? 1 : 0)));
/** Vektor mit Kosinus-Ähnlichkeit cos zur Achse 0 (nur ungefähr: float32) */
const toward0 = (cos: number) => vec([cos, Math.sqrt(1 - cos * cos)]);
/**
 * Vektoren genau auf einer Schwelle: ganze Zahlen, deren Summen und Wurzel in
 * float32 exakt sind, damit pgvector die Ähnlichkeit ohne Rundung trifft
 * (toward0(0.8) lag in der CI knapp über 0.8)
 */
const exact08 = vec([4, 3]); // 4 / 5
const exact05 = vec([1, 1, 1, 1]); // 1 / 2
const exact095 = vec([19, 6, 1, 1, 1]); // 19 / 20

describe.skipIf(!available.ok)("db/schema.sql allein gegen echtes PostgreSQL", () => {
  let pg: PgServer;

  beforeAll(async () => {
    pg = await startPg();
    expect(await pg.applySchema("db/schema.sql")).toEqual(["db/schema.sql"]);
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  /** Ob die Anweisung scheitert; awaited direkt, expect().rejects hält Bun SQL hier an */
  async function fails(sql: string): Promise<boolean> {
    try {
      await pg.admin.unsafe(sql);
      return false;
    } catch {
      return true;
    }
  }

  beforeEach(async () => {
    await pg.admin.unsafe(`TRUNCATE ${[CHUNK_TABLE, ...TABLES].map(t => `public.${t}`).join(", ")} RESTART IDENTITY`);
  });

  test("zweites Einspielen geht ohne Fehler und lässt Zeilen stehen", async () => {
    await pg.admin.unsafe("INSERT INTO public.memory (type, content) VALUES ('fact', 'bleibt')");
    await pg.admin.begin(async tx => {
      await tx.unsafe(await Bun.file(`${import.meta.dir}/../db/schema.sql`).text());
    });
    const rows = await pg.admin.unsafe("SELECT content FROM public.memory");
    expect(rows.map((r: { content: string }) => r.content)).toEqual(["bleibt"]);
  });

  test("Prüfungen auf role, type, level und status", async () => {
    const bad = [
      "INSERT INTO public.messages (chat_id, role, content) VALUES ('1', 'system', 'x')",
      "INSERT INTO public.memory (type, content) VALUES ('notiz', 'x')",
      "INSERT INTO public.logs (level, event) VALUES ('fatal', 'x')",
      "INSERT INTO public.async_tasks (chat_id, original_prompt, status) VALUES ('1', 'x', 'wartet')",
      "INSERT INTO public.messages (chat_id, role) VALUES ('1', 'user')",
    ];
    for (const sql of bad) expect(await fails(sql)).toBe(true);
    for (const role of ["user", "assistant"]) await pg.admin.unsafe(`INSERT INTO public.messages (chat_id, role, content) VALUES ('1', '${role}', 'x')`);
    for (const type of ["fact", "goal", "completed_goal", "preference"]) await pg.admin.unsafe(`INSERT INTO public.memory (type, content) VALUES ('${type}', 'x')`);
    for (const level of ["debug", "info", "warn", "error"]) await pg.admin.unsafe(`INSERT INTO public.logs (level, event) VALUES ('${level}', 'x')`);
    for (const status of ["pending", "running", "needs_input", "completed", "failed"]) {
      await pg.admin.unsafe(`INSERT INTO public.async_tasks (chat_id, original_prompt, status) VALUES ('1', 'x', '${status}')`);
    }
    await pg.admin.unsafe("INSERT INTO public.call_transcripts (conversation_id) VALUES ('a')");
    expect(await fails("INSERT INTO public.call_transcripts (conversation_id) VALUES ('a')")).toBe(true);
  });

  test("Vorgaben der Spalten", async () => {
    const [m] = await pg.admin.unsafe("INSERT INTO public.memory (type, content) VALUES ('fact', 'x') RETURNING id, priority, metadata, created_at, updated_at");
    expect(Number(m.id)).toBe(1);
    expect(m.priority).toBe(0);
    expect(m.metadata).toEqual({});
    expect(m.created_at).toBeInstanceOf(Date);
    expect(m.updated_at).toBeInstanceOf(Date);
    const [t] = await pg.admin.unsafe("INSERT INTO public.async_tasks (chat_id, original_prompt) VALUES ('1', 'x') RETURNING id, status, reminder_sent, metadata");
    expect(t.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(t.status).toBe("pending");
    expect(t.reminder_sent).toBe(false);
    expect(t.metadata).toEqual({});
    const [a] = await pg.admin.unsafe("INSERT INTO public.assets (storage_path, file_type, description) VALUES ('p', 'image', 'd') RETURNING tags, channel, metadata");
    expect(a.channel).toBe("telegram");
    expect(a.metadata).toEqual({});
    expect([...a.tags]).toEqual([]);
    const [c] = await pg.admin.unsafe("INSERT INTO public.call_transcripts (conversation_id) VALUES ('b') RETURNING action_items, metadata");
    expect([...c.action_items]).toEqual([]);
    const [h] = await pg.admin.unsafe("INSERT INTO public.node_heartbeat (node_id) VALUES ('n') RETURNING last_heartbeat, metadata");
    expect(h.last_heartbeat).toBeInstanceOf(Date);
    expect(h.metadata).toEqual({});
  });

  test("RLS an allen acht Tabellen, je eine Policy für service_role außer an message_chunks", async () => {
    const rls = await pg.admin.unsafe(
      "SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r' AND relrowsecurity ORDER BY relname",
    );
    expect(rls.map((r: { relname: string }) => r.relname)).toEqual([...TABLES, CHUNK_TABLE].sort());
    const policies = await pg.admin.unsafe("SELECT tablename, policyname, cmd, qual FROM pg_policies WHERE schemaname = 'public' ORDER BY tablename");
    expect(policies.map((p: { tablename: string }) => p.tablename)).toEqual([...TABLES].sort());
    for (const p of policies) {
      expect(p.policyname).toBe("Service role full access");
      expect(p.cmd).toBe("ALL");
      expect(p.qual).toBe("(auth.role() = 'service_role'::text)");
    }
  });

  test("match_messages: Schwelle strikt, ohne Vektor nie, sortiert, Anzahl und Chat-Filter", async () => {
    const rows: [string, string, string, string | null][] = [
      ["1", "user", "genau", toward0(1)],
      ["1", "assistant", "nah", toward0(0.9)],
      ["2", "user", "anderer Chat", exact08],
      ["1", "user", "auf der Schwelle", exact05],
      ["1", "user", "fern", axis(1)],
      ["1", "user", "ohne Vektor", null],
    ];
    for (const [chat, role, content, emb] of rows) {
      await pg.admin.unsafe("INSERT INTO public.messages (chat_id, role, content, embedding) VALUES ($1, $2, $3, $4::vector)", [chat, role, content, emb]);
    }
    const q = axis(0);
    const all = await pg.admin.unsafe("SELECT * FROM public.match_messages($1::vector, NULL, 0.5, 10)", [q]);
    expect(all.map((r: { content: string }) => r.content)).toEqual(["genau", "nah", "anderer Chat"]);
    expect(Object.keys(all[0])).toEqual(["id", "content", "role", "chat_id", "created_at", "similarity"]);
    expect(all[0].similarity).toBeCloseTo(1, 6);
    expect(all[1].role).toBe("assistant");
    expect(all[1].similarity).toBeCloseTo(0.9, 6);

    const chat1 = await pg.admin.unsafe("SELECT content FROM public.match_messages($1::vector, '1', 0.5, 10)", [q]);
    expect(chat1.map((r: { content: string }) => r.content)).toEqual(["genau", "nah"]);
    const one = await pg.admin.unsafe("SELECT content FROM public.match_messages($1::vector, NULL, 0.5, 1)", [q]);
    expect(one.map((r: { content: string }) => r.content)).toEqual(["genau"]);
    // Vorgaben: kein Chat-Filter, Schwelle 0.7, höchstens 5
    const defaults = await pg.admin.unsafe("SELECT content FROM public.match_messages($1::vector)", [q]);
    expect(defaults.map((r: { content: string }) => r.content)).toEqual(["genau", "nah", "anderer Chat"]);
    const strict = await pg.admin.unsafe("SELECT content FROM public.match_messages($1::vector, NULL, 0.8, 10)", [q]);
    expect(strict.map((r: { content: string }) => r.content)).not.toContain("anderer Chat");
  });

  test("match_assets: gleiche Regeln, Spalten der Bildsuche", async () => {
    const rows: [string, string | null][] = [
      ["Strand", exact095],
      ["Berg", toward0(0.75)],
      ["Stadt", toward0(0.6)],
      ["ohne Vektor", null],
    ];
    for (const [description, emb] of rows) {
      await pg.admin.unsafe("INSERT INTO public.assets (storage_path, file_type, description, tags, public_url, embedding) VALUES ('p', 'image', $1, '{urlaub}', 'u', $2::vector)", [description, emb]);
    }
    const q = axis(0);
    const found = await pg.admin.unsafe("SELECT * FROM public.match_assets($1::vector)", [q]);
    expect(found.map((r: { description: string }) => r.description)).toEqual(["Strand", "Berg"]);
    expect(Object.keys(found[0])).toEqual(["id", "description", "tags", "file_type", "public_url", "created_at", "similarity"]);
    expect([...found[0].tags]).toEqual(["urlaub"]);
    expect(found[0].similarity).toBeCloseTo(0.95, 6);
    const low = await pg.admin.unsafe("SELECT description FROM public.match_assets($1::vector, 0.5, 2)", [q]);
    expect(low.map((r: { description: string }) => r.description)).toEqual(["Strand", "Berg"]);
    const none = await pg.admin.unsafe("SELECT description FROM public.match_assets($1::vector, 0.95, 5)", [q]);
    expect(none).toHaveLength(0);
  });

  test("Indizes der Tabellen", async () => {
    const idx = await pg.admin.unsafe("SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND indexname LIKE 'idx_%' ORDER BY indexname");
    expect(idx.map((r: { indexname: string }) => r.indexname)).toEqual([
      "idx_assets_created_at",
      "idx_assets_file_type",
      "idx_async_tasks_chat_id",
      "idx_async_tasks_status",
      "idx_async_tasks_updated_at",
      "idx_logs_created_at",
      "idx_logs_event",
      "idx_logs_level",
      "idx_memory_created_at",
      "idx_memory_type",
      "idx_message_chunks_chat_id",
      "idx_messages_chat_id",
      "idx_messages_created_at",
      "idx_messages_role",
    ]);
  });
});
