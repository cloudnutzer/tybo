/**
 * Echtes PostgreSQL mit pgvector für Tests des SQL (Issue #168). Isoliert:
 * je Testdatei eine eigene, danach gelöschte Datenbank.
 *
 * Woher der Server kommt:
 * - TEST_PG_URL: ein laufender Server (Superuser), etwa in der CI der
 *   Dienst pgvector/pgvector (.github/workflows/check.yml).
 * - TEST_PG_BIN: Ordner mit initdb und pg_ctl (pgvector installiert);
 *   dann legt der Harness einen Wegwerf-Cluster in einem temporären Ordner an,
 *   nur über einen Unix-Socket erreichbar, und räumt ihn danach weg.
 * - Keins von beiden: die Tests werden übersprungen, in der CI (CI=true)
 *   schlagen sie fehl.
 *
 * Die Datenbank bekommt, was Supabase mitbringt und das Schema voraussetzt
 * (Rollen anon, authenticated, service_role; auth.role(); storage.buckets;
 * Standardrechte für service_role), dann die Dateien aus SCHEMA_FILES wie beim
 * Einspielen: je Datei eine Transaktion, ohne eigenes BEGIN/COMMIT.
 */

import { SQL } from "bun";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadSchemaFiles } from "../src/setup/supabase-schema";

const REPO = resolve(import.meta.dir, "..");

export interface PgServer {
  /** Neue Verbindung (höchstens eine Sitzung) zur Testdatenbank; role: SET ROLE danach */
  connect(role?: string): Promise<SQL>;
  /** Verbindung als Superuser zur Testdatenbank */
  admin: SQL;
  /** Schema einspielen, bis einschließlich der Datei, deren Name so endet */
  applySchema(until?: string): Promise<string[]>;
  close(): Promise<void>;
}

/** Ob ein Server bereitsteht; sonst Grund */
export function pgAvailable(): { ok: true } | { ok: false; reason: string } {
  if (process.env.TEST_PG_URL || process.env.TEST_PG_BIN) return { ok: true };
  return { ok: false, reason: "Weder TEST_PG_URL noch TEST_PG_BIN gesetzt" };
}

const SUPABASE_SHIMS = `
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT current_setting('request.jwt.claim.role', true) $f$;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE TABLE IF NOT EXISTS storage.buckets (id text PRIMARY KEY, name text, public boolean);
GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon, authenticated, service_role;
`;

function run(cmd: string, args: string[], env: Record<string, string> = {}): void {
  const r = spawnSync(cmd, args, { env: { ...process.env, LC_ALL: "C", LANG: "C", ...env }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} scheiterte: ${r.stderr || r.stdout}`);
}

export async function startPg(): Promise<PgServer> {
  let base: { url: string; path?: string };
  let cleanup: () => Promise<void> = async () => {};
  if (process.env.TEST_PG_URL) {
    base = { url: process.env.TEST_PG_URL };
  } else if (process.env.TEST_PG_BIN) {
    const bin = process.env.TEST_PG_BIN;
    const dir = await mkdtemp(join(tmpdir(), "tybo-pg-"));
    const port = 40000 + Math.floor(Math.random() * 20000);
    run(join(bin, "initdb"), ["-D", join(dir, "data"), "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"]);
    run(join(bin, "pg_ctl"), ["-D", join(dir, "data"), "-o", `-p ${port} -k ${dir} -c listen_addresses=''`, "-l", join(dir, "log"), "-w", "start"]);
    base = { url: `postgres://postgres@localhost:${port}/postgres`, path: join(dir, `.s.PGSQL.${port}`) };
    cleanup = async () => {
      spawnSync(join(bin, "pg_ctl"), ["-D", join(dir, "data"), "-m", "immediate", "-w", "stop"], { env: { ...process.env, LC_ALL: "C" } });
      await rm(dir, { recursive: true, force: true });
    };
  } else {
    throw new Error("Kein PostgreSQL für Tests: TEST_PG_URL oder TEST_PG_BIN setzen.");
  }
  const server = new SQL({ ...base, max: 1 });
  const name = `tybo_test_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  await server.unsafe(`CREATE DATABASE ${name}`);
  const dbUrl = base.url.replace(/\/[^/?]*(\?|$)/, `/${name}$1`);
  const open: SQL[] = [];
  const connect = async (role?: string) => {
    const conn = new SQL({ ...base, url: dbUrl, max: 1 });
    open.push(conn);
    if (role) await conn.unsafe(`SET ROLE ${role}`);
    return conn;
  };
  const admin = await connect();
  await admin.unsafe("CREATE EXTENSION IF NOT EXISTS vector");
  await admin.unsafe(SUPABASE_SHIMS);
  return {
    admin,
    connect,
    async applySchema(until?: string) {
      const applied: string[] = [];
      for (const file of await loadSchemaFiles(REPO)) {
        await admin.begin(async tx => {
          await tx.unsafe(file.sql);
        });
        applied.push(file.file);
        if (until && file.file.endsWith(until)) break;
      }
      return applied;
    },
    async close() {
      for (const c of open) await c.close().catch(() => {});
      await server.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => {});
      await server.close().catch(() => {});
      await cleanup();
    },
  };
}

/** Vektor mit 1536 Werten als Text für pgvector */
export function vec(values: number[]): string {
  const v = values.slice();
  while (v.length < 1536) v.push(0);
  return `[${v.join(",")}]`;
}

// ---------------------------------------------------------------------------
// PostgREST-Attrappe über echtes SQL: so laufen restReindexStore, die
// Anbieterkennung und factVectorsFor unverändert gegen die echte Datenbank
// ---------------------------------------------------------------------------

/** Typen der Argumente, wie PostgREST sie aus der Signatur kennt */
const ARG_TYPES: Record<string, string> = {
  p_run: "uuid",
  p_rows: "jsonb",
  p_seconds: "int",
  p_done: "int",
  p_finished: "boolean",
  query_embedding: "vector",
  match_threshold: "float8",
  match_count: "int",
};

/** Funktionen, die eine Tabelle liefern (PostgREST: Feld von Zeilen) */
const SET_RETURNING = new Set(["match_messages_checked", "embedding_fact_vectors", "match_messages"]);

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`ungültiger Name ${name}`);
  return name;
}

export function postgrestFetch(conn: SQL, base = "https://projekt.supabase.co"): (url: string, init?: RequestInit) => Promise<Response> {
  return async (url, init = {}) => {
    if (!url.startsWith(`${base}/rest/v1/`)) throw new Error(`Unerwartete Adresse: ${url}`);
    const u = new URL(url);
    const path = u.pathname.replace(/^\/rest\/v1\//, "");
    try {
      if (path.startsWith("rpc/")) {
        const fn = ident(path.slice(4));
        const exists = await conn.unsafe("SELECT 1 FROM pg_proc WHERE proname = $1 AND pronamespace = 'public'::regnamespace", [fn]);
        if (!exists.length) return json({ code: "PGRST202", message: "function not found" }, 404);
        const args = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        const names = Object.keys(args).map(ident);
        const params = names.map(n => {
          const v = args[n];
          if (ARG_TYPES[n] === "jsonb") return v === null ? null : JSON.stringify(v);
          if (ARG_TYPES[n] === "vector") return Array.isArray(v) ? `[${v.join(",")}]` : v;
          return v;
        });
        // jsonb über text: Bun würde einen String sonst noch einmal als JSON kodieren
        const cast = (n: string) => (ARG_TYPES[n] === "jsonb" ? "::text::jsonb" : ARG_TYPES[n] ? `::${ARG_TYPES[n]}` : "::text");
        const list = names.map((n, i) => `${n} => $${i + 1}${cast(n)}`).join(", ");
        if (SET_RETURNING.has(fn)) return json([...(await conn.unsafe(`SELECT * FROM public.${fn}(${list})`, params))]);
        const rows = await conn.unsafe(`SELECT public.${fn}(${list}) AS r`, params);
        return json(rows[0].r);
      }
      if ((init.method ?? "GET") !== "GET") throw new Error(`Nur GET auf Tabellen: ${url}`);
      const table = ident(path);
      const select = (u.searchParams.get("select") ?? "*").split(",").map(c => (c === "*" ? "*" : ident(c))).join(", ");
      const where: string[] = [];
      const params: unknown[] = [];
      let order = "";
      let limit = "";
      for (const [k, v] of u.searchParams) {
        if (k === "select") continue;
        if (k === "order") {
          const [col, dir] = v.split(".");
          order = ` ORDER BY ${ident(col)} ${dir === "desc" ? "DESC" : "ASC"}`;
          continue;
        }
        if (k === "limit") {
          limit = ` LIMIT ${Number(v)}`;
          continue;
        }
        const [op, ...rest] = v.split(".");
        const value = rest.join(".");
        const col = ident(k);
        if (op === "eq") {
          params.push(value);
          where.push(`${col}::text = $${params.length}`);
        } else if (op === "gt") {
          params.push(value);
          // PostgREST vergleicht im Typ der Spalte
          where.push(`${col} > $${params.length}::${table === "messages" || table === "memory" ? "bigint" : "uuid"}`);
        } else if (op === "is") {
          where.push(`${col} IS ${value === "true" ? "TRUE" : value === "false" ? "FALSE" : "NULL"}`);
        } else if (op === "in") {
          const items = value.replace(/^\(|\)$/g, "").split(",").map(x => x.replace(/^"|"$/g, ""));
          params.push(items.join(","));
          where.push(`${col}::text = ANY(string_to_array($${params.length}::text, ','))`);
        } else throw new Error(`Filter ${op} nicht nachgebildet`);
      }
      const rows = await conn.unsafe(`SELECT ${select} FROM public.${table}${where.length ? ` WHERE ${where.join(" AND ")}` : ""}${order}${limit}`, params);
      // PostgREST liefert bigint als Zahl
      return json([...rows].map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === "id" && (table === "messages" || table === "memory") ? Number(v) : v]))));
    } catch (e) {
      const code = String((e as { errno?: unknown }).errno ?? "");
      if (process.env.TEST_PG_DEBUG) console.error(url, e);
      return json({ code, message: "Fehler" }, code === "42501" ? 403 : 400);
    }
  };
}
