/**
 * Issue #437: ausdrückliche Rechte auf Tabellen und Sequenzen gegen echtes
 * PostgreSQL mit pgvector (tests/pg-harness.ts).
 *
 * Supabase vergibt in public keine Rechte mehr von selbst (neue Projekte seit
 * 30.05.2026, bestehende ab 30.10.2026). Der Harness stellt das mit
 * defaultGrants "keine" nach; "alt" ist die frühere Voreinstellung, in der
 * auch anon und authenticated alles bekamen. In beiden Fällen gilt nach
 * db/schema.sql und allen Migrationen: service_role darf auf jeder Tabelle
 * lesen und schreiben und jede Sequenz nutzen, anon und authenticated nichts.
 * Geschrieben wird als service_role, nicht als Superuser.
 *
 * Braucht TEST_PG_URL oder TEST_PG_BIN; ohne beide übersprungen, in der CI
 * ein Fehler (wie tests/schema-basis-pg.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import type { SQL } from "bun";
import { stripOuterTransaction } from "../src/setup/supabase-schema";
import { pgAvailable, startPg, type PgServer } from "./pg-harness";

const available = pgAvailable();
const REPO = resolve(import.meta.dir, "..");
const MIGRATION = "db/migrations/20261021_base_grants.sql";

if (!available.ok && process.env.CI) {
  test("PostgreSQL für die Rechte-Tests ist in der CI eingerichtet", () => {
    throw new Error(`${available.reason}: der Dienst pgvector in .github/workflows/check.yml fehlt`);
  });
}

const BASE_TABLES = ["messages", "memory", "logs", "call_transcripts", "async_tasks", "node_heartbeat", "assets"];
const BASE_SEQUENCES = ["messages_id_seq", "memory_id_seq", "logs_id_seq", "call_transcripts_id_seq"];
const TABLE_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
const SEQUENCE_PRIVILEGES = ["USAGE", "SELECT", "UPDATE"];
const OUTSIDERS = ["anon", "authenticated", "public"];

/** Je Grundtabelle eine gültige Zeile, ein Schlüssel zum Wiederfinden */
const ROWS: Record<string, { insert: string; key: string }> = {
  messages: { insert: "INSERT INTO public.messages (chat_id, role, content) VALUES ('rechte', 'user', 'hallo')", key: "chat_id = 'rechte'" },
  memory: { insert: "INSERT INTO public.memory (type, content) VALUES ('fact', 'rechte')", key: "content = 'rechte'" },
  logs: { insert: "INSERT INTO public.logs (level, event) VALUES ('info', 'rechte')", key: "event = 'rechte'" },
  call_transcripts: { insert: "INSERT INTO public.call_transcripts (conversation_id) VALUES ('rechte')", key: "conversation_id = 'rechte'" },
  async_tasks: { insert: "INSERT INTO public.async_tasks (chat_id, original_prompt) VALUES ('rechte', 'p')", key: "chat_id = 'rechte'" },
  node_heartbeat: { insert: "INSERT INTO public.node_heartbeat (node_id) VALUES ('rechte')", key: "node_id = 'rechte'" },
  assets: { insert: "INSERT INTO public.assets (storage_path, file_type, description) VALUES ('rechte/a.png', 'image', 'd')", key: "storage_path = 'rechte/a.png'" },
};

/** Fehlercode einer Anweisung, null ohne Fehler; awaited direkt (wie schema-basis-pg) */
async function errorCode(conn: SQL, sql: string): Promise<string | null> {
  try {
    await conn.unsafe(sql);
    return null;
  } catch (e) {
    return String((e as { errno?: unknown }).errno ?? "unbekannt");
  }
}

/** Eine Datei aus db/ einspielen wie applySchema: eine Transaktion, ohne eigenes BEGIN/COMMIT */
async function applyFile(pg: PgServer, file: string): Promise<void> {
  const sql = stripOuterTransaction(await Bun.file(join(REPO, file)).text());
  await pg.admin.begin(async tx => {
    await tx.unsafe(sql);
  });
}

async function relations(pg: PgServer, kinds: string): Promise<string[]> {
  const rows = await pg.admin.unsafe(
    `SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = ANY(string_to_array($1, ',')::"char"[]) ORDER BY 1`,
    [kinds],
  );
  return rows.map((r: { relname: string }) => r.relname);
}

/** Alle Rechte je Rolle und Objekt, als Liste "rolle objekt recht" der vorhandenen */
async function granted(pg: PgServer, roles: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const table of await relations(pg, "r,p")) {
    for (const role of roles) {
      for (const p of TABLE_PRIVILEGES) {
        const [r] = await pg.admin.unsafe(`SELECT has_table_privilege($1, $2, $3) AS ok`, [role, `public.${table}`, p]);
        if (r.ok) out.push(`${role} ${table} ${p}`);
      }
    }
  }
  for (const seq of await relations(pg, "S")) {
    for (const role of roles) {
      for (const p of SEQUENCE_PRIVILEGES) {
        const [r] = await pg.admin.unsafe(`SELECT has_sequence_privilege($1, $2, $3) AS ok`, [role, `public.${seq}`, p]);
        if (r.ok) out.push(`${role} ${seq} ${p}`);
      }
    }
  }
  return out;
}

/** has_*_privilege kennt PUBLIC nicht als Rolle: über eine Rolle ohne eigene Rechte prüfen */
async function withProbeRole(pg: PgServer): Promise<void> {
  await pg.admin.unsafe(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'public_probe') THEN CREATE ROLE public_probe NOLOGIN; END IF; END $$`);
}
const outsiderRoles = () => OUTSIDERS.map(r => (r === "public" ? "public_probe" : r));

/** Prüft die Regel: service_role hat alles Nötige, Außenstehende nichts */
async function expectRule(pg: PgServer): Promise<void> {
  await withProbeRole(pg);
  const tables = await relations(pg, "r,p");
  const sequences = await relations(pg, "S");
  expect(tables).toEqual(expect.arrayContaining(BASE_TABLES));
  expect(sequences).toEqual(expect.arrayContaining(BASE_SEQUENCES));
  const service = await granted(pg, ["service_role"]);
  for (const t of tables) for (const p of ["SELECT", "INSERT", "UPDATE", "DELETE"]) expect(service).toContain(`service_role ${t} ${p}`);
  for (const s of sequences) for (const p of ["USAGE", "SELECT"]) expect(service).toContain(`service_role ${s} ${p}`);
  expect(await granted(pg, outsiderRoles())).toEqual([]);
}

/** Als service_role: anlegen, lesen, ändern, löschen in jeder Grundtabelle */
async function writeAsServiceRole(pg: PgServer): Promise<void> {
  const conn = await pg.connect("service_role");
  for (const [table, row] of Object.entries(ROWS)) {
    await conn.unsafe(row.insert);
    expect((await conn.unsafe(`SELECT 1 FROM public.${table} WHERE ${row.key}`)).length).toBe(1);
    await conn.unsafe(`UPDATE public.${table} SET metadata = '{"geprueft": true}'::jsonb WHERE ${row.key}`);
    await conn.unsafe(`DELETE FROM public.${table} WHERE ${row.key}`);
    expect((await conn.unsafe(`SELECT 1 FROM public.${table} WHERE ${row.key}`)).length).toBe(0);
  }
  await conn.close();
}

describe.skipIf(!available.ok)("Rechte nach Schema und Migrationen, Supabase ohne Standardrechte", () => {
  let pg: PgServer;

  beforeAll(async () => {
    pg = await startPg({ defaultGrants: "keine" });
    await pg.applySchema();
  }, 120_000);

  afterAll(async () => {
    await pg?.close();
  });

  test("die Nachstellung greift: eine Tabelle ohne GRANT ist für service_role gesperrt", async () => {
    await pg.admin.unsafe("CREATE TABLE public.ohne_recht (id bigserial PRIMARY KEY, x text)");
    const conn = await pg.connect("service_role");
    expect(await errorCode(conn, "INSERT INTO public.ohne_recht (x) VALUES ('a')")).toBe("42501");
    expect(await errorCode(conn, "SELECT * FROM public.ohne_recht")).toBe("42501");
    await conn.close();
    // Nur Tabellenrecht, keins auf der Sequenz: neue Zeilen scheitern trotzdem
    await pg.admin.unsafe("GRANT ALL ON public.ohne_recht TO service_role");
    const again = await pg.connect("service_role");
    expect(await errorCode(again, "INSERT INTO public.ohne_recht (x) VALUES ('a')")).toBe("42501");
    await again.close();
    await pg.admin.unsafe("DROP TABLE public.ohne_recht");
  });

  test("service_role darf auf jeder Tabelle lesen und schreiben und jede Sequenz nutzen; anon, authenticated und PUBLIC nichts", async () => {
    await expectRule(pg);
  });

  test("als service_role: anlegen, lesen, ändern und löschen in allen Grundtabellen", async () => {
    await writeAsServiceRole(pg);
  });

  test("anon und authenticated lesen und schreiben nichts", async () => {
    for (const role of ["anon", "authenticated"]) {
      const conn = await pg.connect(role);
      for (const [table, row] of Object.entries(ROWS)) {
        expect(await errorCode(conn, `SELECT 1 FROM public.${table}`)).toBe("42501");
        expect(await errorCode(conn, row.insert)).toBe("42501");
      }
      expect(await errorCode(conn, "SELECT nextval('public.memory_id_seq')")).toBe("42501");
      await conn.close();
    }
  });

  test("Schema und alle Migrationen zweimal: keine Fehler, Zeilen bleiben, Rechte gleich", async () => {
    const conn = await pg.connect("service_role");
    for (const row of Object.values(ROWS)) await conn.unsafe(row.insert);
    await conn.close();
    const before = await granted(pg, ["service_role", ...outsiderRoles()]);
    await pg.applySchema();
    await applyFile(pg, MIGRATION);
    for (const [table, row] of Object.entries(ROWS)) {
      expect((await pg.admin.unsafe(`SELECT 1 FROM public.${table} WHERE ${row.key}`)).length).toBe(1);
      await pg.admin.unsafe(`DELETE FROM public.${table} WHERE ${row.key}`);
    }
    expect(await granted(pg, ["service_role", ...outsiderRoles()])).toEqual(before);
    await expectRule(pg);
    await writeAsServiceRole(pg);
  }, 120_000);
});

describe.skipIf(!available.ok)("Rechte nach Schema und Migrationen, frühere Supabase-Voreinstellung", () => {
  let pg: PgServer;

  beforeAll(async () => {
    pg = await startPg({ defaultGrants: "alt" });
    await pg.applySchema();
  }, 120_000);

  afterAll(async () => {
    await pg?.close();
  });

  test("auch hier: service_role alles Nötige, anon und authenticated nichts (auch nicht auf den Sequenzen)", async () => {
    await expectRule(pg);
    await writeAsServiceRole(pg);
  });
});

describe.skipIf(!available.ok)("db/schema.sql allein, Supabase ohne Standardrechte", () => {
  let pg: PgServer;

  beforeAll(async () => {
    pg = await startPg({ defaultGrants: "keine" });
    expect(await pg.applySchema("db/schema.sql")).toEqual(["db/schema.sql"]);
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  test("vergibt die Rechte selbst, ohne Migrationen", async () => {
    await expectRule(pg);
    await writeAsServiceRole(pg);
  });
});

describe.skipIf(!available.ok)("Migration 20261021_base_grants repariert eine bestehende Installation", () => {
  let pg: PgServer;

  beforeAll(async () => {
    pg = await startPg({ defaultGrants: "keine" });
    await pg.applySchema();
  }, 120_000);

  afterAll(async () => {
    await pg?.close();
  });

  test("fehlende Rechte von service_role und alte Rechte von anon und authenticated: danach wieder nach der Regel, Zeilen bleiben", async () => {
    await pg.admin.unsafe("INSERT INTO public.memory (type, content) VALUES ('fact', 'bleibt')");
    // Stand einer Einrichtung vor #437 ohne Standardrechte: Tabellen frei, Sequenzen nicht
    await pg.admin.unsafe(`REVOKE ALL ON SEQUENCE ${BASE_SEQUENCES.map(s => `public.${s}`).join(", ")} FROM service_role`);
    // Altlast der früheren Voreinstellung
    await pg.admin.unsafe(`GRANT ALL ON SEQUENCE ${BASE_SEQUENCES.map(s => `public.${s}`).join(", ")} TO anon, authenticated`);
    await pg.admin.unsafe(`GRANT ALL ON TABLE ${BASE_TABLES.map(t => `public.${t}`).join(", ")} TO anon, authenticated`);
    await pg.admin.unsafe("REVOKE ALL ON TABLE public.logs FROM service_role");
    const broken = await pg.connect("service_role");
    expect(await errorCode(broken, ROWS.memory.insert)).toBe("42501");
    expect(await errorCode(broken, "SELECT 1 FROM public.logs")).toBe("42501");
    await broken.close();

    await applyFile(pg, MIGRATION);
    await expectRule(pg);
    await writeAsServiceRole(pg);
    // Zweites Einspielen: gleiche Rechte, Zeile noch da
    const once = await granted(pg, ["service_role", ...outsiderRoles()]);
    await applyFile(pg, MIGRATION);
    expect(await granted(pg, ["service_role", ...outsiderRoles()])).toEqual(once);
    const rows = await pg.admin.unsafe("SELECT content FROM public.memory");
    expect(rows.map((r: { content: string }) => r.content)).toEqual(["bleibt"]);
  });

  test("fehlt eine Grundtabelle, läuft die Migration trotzdem durch", async () => {
    await pg.admin.unsafe("ALTER TABLE public.call_transcripts RENAME TO call_transcripts_weg");
    await pg.admin.unsafe("ALTER SEQUENCE public.call_transcripts_id_seq RENAME TO call_transcripts_weg_id_seq");
    await applyFile(pg, MIGRATION);
    await pg.admin.unsafe("ALTER TABLE public.call_transcripts_weg RENAME TO call_transcripts");
    await pg.admin.unsafe("ALTER SEQUENCE public.call_transcripts_weg_id_seq RENAME TO call_transcripts_id_seq");
  });
});
