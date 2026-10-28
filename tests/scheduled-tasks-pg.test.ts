/**
 * Issue #321: db/migrations/20261017_scheduled_tasks.sql gegen echtes
 * PostgreSQL (tests/pg-harness.ts). Belegt: die Tabelle scheduled_tasks mit
 * ihren Vorgaben und Prüfungen, der Index auf status und due_at, ein zweiter
 * und dritter Lauf des ganzen Schemas lässt die Zeilen stehen, und nur
 * service_role kommt an die Tabelle (anon und authenticated weder lesend
 * noch schreibend).
 *
 * Braucht TEST_PG_URL oder TEST_PG_BIN; ohne beide übersprungen, in der CI
 * ein Fehler (wie tests/embedding-reindex-pg.test.ts). Ein lokal
 * übersprungener Lauf ist kein Nachweis.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { SCHEMA_FILES } from "../src/setup/supabase-schema";
import { pgAvailable, startPg, type PgServer } from "./pg-harness";

const MIGRATION = "db/migrations/20261017_scheduled_tasks.sql";
const LEASE_MIGRATION = "db/migrations/20261018_scheduled_tasks_lease.sql";
const available = pgAvailable();

if (!available.ok && process.env.CI) {
  test("PostgreSQL für die Tests der Erinnerungen ist in der CI eingerichtet", () => {
    throw new Error(`${available.reason}: der Dienst pgvector in .github/workflows/check.yml fehlt`);
  });
}

test("die Migration steht in SCHEMA_FILES, nach dem Grundschema", () => {
  const files = [...SCHEMA_FILES] as string[];
  expect(files).toContain(MIGRATION);
  expect(files.indexOf(MIGRATION)).toBeGreaterThan(files.indexOf("db/schema.sql"));
  // Issue #322: die Spalten der Übernahme kommen nach der Tabelle
  expect(files.indexOf(LEASE_MIGRATION)).toBeGreaterThan(files.indexOf(MIGRATION));
});

describe.skipIf(!available.ok)("Migration 20261017_scheduled_tasks gegen echtes PostgreSQL", () => {
  let pg: PgServer;
  let svc: SQL;

  beforeAll(async () => {
    pg = await startPg();
    expect(await pg.applySchema()).toContain(MIGRATION);
    svc = await pg.connect("service_role");
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  beforeEach(async () => {
    await pg.admin.unsafe("TRUNCATE public.scheduled_tasks");
  });

  /** Ob die Anweisung scheitert, und mit welchem Code; awaited direkt (expect().rejects hält Bun SQL an) */
  async function failure(conn: SQL, sql: string, params: unknown[] = []): Promise<string | null> {
    try {
      await conn.unsafe(sql, params);
      return null;
    } catch (e) {
      return String((e as { errno?: unknown }).errno ?? "fehler");
    }
  }

  /** Zeile mit (chat_id, topic_id, text, due_at), der Rest aus den Vorgaben */
  const insert = (conn: SQL, values: string) =>
    conn.unsafe(`INSERT INTO public.scheduled_tasks (chat_id, topic_id, text, due_at) VALUES ${values} RETURNING *`);

  test("Vorgaben: uuid, reminder, pending, 0 Versuche, Zeitstempel", async () => {
    const [row] = await insert(svc, "('123', NULL, 'Zahnarzt', '2026-10-20T08:00:00Z')");
    expect(String(row.id)).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.kind).toBe("reminder");
    expect(row.status).toBe("pending");
    expect(row.attempts).toBe(0);
    expect(row.recurrence).toBeNull();
    expect(row.last_error).toBeNull();
    expect(row.topic_id).toBeNull();
    expect(row.created_at).toBeInstanceOf(Date);
    expect(row.updated_at).toBeInstanceOf(Date);
    expect((row.due_at as Date).toISOString()).toBe("2026-10-20T08:00:00.000Z");
  });

  test("chat_id nimmt auch Kennungen der WebUI, topic_id große Telegram-Zahlen", async () => {
    const [row] = await insert(svc, "('web:3f2a9c', 9007199254740, 'x', now())");
    expect(row.chat_id).toBe("web:3f2a9c");
    expect(Number(row.topic_id)).toBe(9007199254740);
  });

  test("Prüfungen: kind, status, leerer Text, leere chat_id, negative Versuche, fehlende Fälligkeit", async () => {
    const base = "INSERT INTO public.scheduled_tasks (chat_id, text, due_at, kind, status, attempts) VALUES ($1, $2, $3::timestamptz, $4, $5, $6)";
    expect(await failure(svc, base, ["1", "Text", "2026-10-20T08:00:00Z", "reminder", "pending", 0])).toBeNull();
    expect(await failure(svc, base, ["1", "Text", "2026-10-20T08:00:00Z", "action", "pending", 0])).toBeNull();
    for (const status of ["running", "done", "failed", "cancelled"]) {
      expect(await failure(svc, base, ["1", "Text", "2026-10-20T08:00:00Z", "reminder", status, 0])).toBeNull();
    }
    expect(await failure(svc, base, ["1", "Text", "2026-10-20T08:00:00Z", "recurring", "pending", 0])).toBe("23514");
    expect(await failure(svc, base, ["1", "Text", "2026-10-20T08:00:00Z", "reminder", "sent", 0])).toBe("23514");
    expect(await failure(svc, base, ["1", "   ", "2026-10-20T08:00:00Z", "reminder", "pending", 0])).toBe("23514");
    expect(await failure(svc, base, [" ", "Text", "2026-10-20T08:00:00Z", "reminder", "pending", 0])).toBe("23514");
    expect(await failure(svc, base, ["1", "Text", "2026-10-20T08:00:00Z", "reminder", "pending", -1])).toBe("23514");
    expect(await failure(svc, base, ["1", "Text", null, "reminder", "pending", 0])).toBe("23502");
  });

  test("Index auf status und due_at, RLS an, keine Policy", async () => {
    const [index] = await pg.admin.unsafe(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = 'scheduled_tasks' AND indexname = 'scheduled_tasks_status_due_at'",
    );
    expect(index.indexdef).toContain("(status, due_at)");
    const [table] = await pg.admin.unsafe("SELECT relrowsecurity FROM pg_class WHERE oid = 'public.scheduled_tasks'::regclass");
    expect(table.relrowsecurity).toBe(true);
    const policies = await pg.admin.unsafe("SELECT policyname FROM pg_policies WHERE schemaname = 'public' AND tablename = 'scheduled_tasks'");
    expect(policies.length).toBe(0);
  });

  test("zweimal und dreimal eingespielt: Zeilen und Werte bleiben", async () => {
    await insert(svc, "('123', 7, 'Blumen gießen', '2026-10-21T06:00:00Z')");
    await svc.unsafe("UPDATE public.scheduled_tasks SET recurrence = 'daily 08:00', status = 'failed', attempts = 2, last_error = 'Netz weg'");
    const before = [...(await pg.admin.unsafe("SELECT * FROM public.scheduled_tasks"))];
    // Ganzes Schema noch zweimal, wie ein erneutes `tybo setup datenbank`
    await pg.applySchema();
    await pg.applySchema();
    const after = [...(await pg.admin.unsafe("SELECT * FROM public.scheduled_tasks"))];
    expect(after).toEqual(before);
    expect(after[0].text).toBe("Blumen gießen");
    expect(after[0].attempts).toBe(2);
  });

  test("service_role liest, schreibt, ändert und löscht", async () => {
    const [row] = await insert(svc, "('123', NULL, 'a', now())");
    expect((await svc.unsafe("SELECT id FROM public.scheduled_tasks")).length).toBe(1);
    await svc.unsafe("UPDATE public.scheduled_tasks SET status = 'done' WHERE id = $1", [row.id]);
    await svc.unsafe("DELETE FROM public.scheduled_tasks WHERE id = $1", [row.id]);
    expect((await svc.unsafe("SELECT id FROM public.scheduled_tasks")).length).toBe(0);
  });

  test("Issue #322: lease_owner, lease_until und send_started_at, leer als Vorgabe", async () => {
    const [row] = await insert(svc, "('1', NULL, 'x', now())");
    expect(row.lease_owner).toBeNull();
    expect(row.lease_until).toBeNull();
    expect(row.send_started_at).toBeNull();
  });

  test("Issue #322: zwei gleichzeitige bedingte Übernahmen, genau eine trifft", async () => {
    const [row] = await insert(svc, "('1', NULL, 'x', now() - interval '1 minute')");
    const other = await pg.connect("service_role");
    const claim = (conn: SQL, owner: string) =>
      conn.unsafe(
        "UPDATE public.scheduled_tasks SET status = 'running', lease_owner = $2, lease_until = now() + interval '2 minutes' WHERE id = $1 AND status = 'pending' AND due_at <= now() RETURNING lease_owner",
        [row.id, owner],
      );
    const results = await Promise.all([claim(svc, "a"), claim(other, "b"), claim(svc, "c"), claim(other, "d")]);
    expect(results.map(r => r.length).reduce((a, b) => a + b, 0)).toBe(1);
    const [stored] = await svc.unsafe("SELECT status, lease_owner FROM public.scheduled_tasks WHERE id = $1", [row.id]);
    expect(stored.status).toBe("running");
    expect(results.flat().map(r => r.lease_owner)).toEqual([stored.lease_owner]);
  });

  for (const role of ["anon", "authenticated"]) {
    test(`${role} kommt weder lesend noch schreibend an die Tabelle`, async () => {
      await insert(svc, "('123', NULL, 'geheim', now())");
      const conn = await pg.connect(role);
      // Auch mit dem passenden JWT-Anspruch nicht: es fehlt schon das Recht
      await conn.unsafe(`SELECT set_config('request.jwt.claim.role', '${role}', false)`);
      expect(await failure(conn, "SELECT * FROM public.scheduled_tasks")).toBe("42501");
      expect(await failure(conn, "INSERT INTO public.scheduled_tasks (chat_id, text, due_at) VALUES ('1', 'x', now())")).toBe("42501");
      expect(await failure(conn, "UPDATE public.scheduled_tasks SET text = 'y'")).toBe("42501");
      expect(await failure(conn, "DELETE FROM public.scheduled_tasks")).toBe("42501");
      expect((await svc.unsafe("SELECT text FROM public.scheduled_tasks"))[0].text).toBe("geheim");
    });
  }
});
