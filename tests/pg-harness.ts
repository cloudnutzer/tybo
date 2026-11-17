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
 * Standardrechte, abschaltbar über PgOptions), dann die Dateien aus SCHEMA_FILES wie beim
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

export const SUPABASE_SHIMS = `
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

/**
 * Supabase-Voreinstellung seit 2026 (neue Projekte ab 30.05., bestehende ab
 * 30.10., Issue #437): neue Tabellen und Sequenzen in public bekommen keine
 * Rechte mehr von selbst. Läuft nach SUPABASE_SHIMS und vor dem Schema.
 */
export const SUPABASE_NO_DEFAULT_GRANTS = `
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon, authenticated, service_role;
`;

export interface PgOptions {
  /**
   * Standardrechte auf neue Tabellen und Sequenzen in public: "alt" wie
   * Supabase bis 2026 (alle Rollen alles, Standard), "keine" wie danach
   */
  defaultGrants?: "alt" | "keine";
}

function run(cmd: string, args: string[], env: Record<string, string> = {}): void {
  const r = spawnSync(cmd, args, { env: { ...process.env, LC_ALL: "C", LANG: "C", ...env }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} scheiterte: ${r.stderr || r.stdout}`);
}

export async function startPg(options: PgOptions = {}): Promise<PgServer> {
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
  if (options.defaultGrants === "keine") await admin.unsafe(SUPABASE_NO_DEFAULT_GRANTS);
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
// Anbieterkennung, factVectorsFor und der Gedächtnis-Adapter (Issue #518)
// unverändert gegen die echte Datenbank
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
  p_message_id: "bigint",
  p_chunks: "jsonb",
  p_after_id: "bigint",
  p_limit: "int",
  p_terms: "text[]",
  p_per_category: "int",
  p_per_term: "int",
  p_matches: "int",
  p_exclude_ids: "text[]",
};

/** Funktionen, die eine Tabelle liefern (PostgREST: Feld von Zeilen) */
const SET_RETURNING = new Set(["match_messages_checked", "embedding_fact_vectors", "match_messages", "match_messages_chunked_checked", "message_chunks_pending", "knowledge_context", "match_knowledge_checked", "match_facts_checked"]);

/** JS-Feld als Array-Literal für ::text[] (Bun gäbe es sonst als leeren Text weiter) */
const textArrayLiteral = (items: unknown[]) => `{${items.map(item => `"${String(item).replace(/["\\]/g, c => `\\${c}`)}"`).join(",")}}`;

const json =(data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

function ident(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`ungültiger Name ${name}`);
  return name;
}

export function postgrestFetch(conn: SQL, base = "https://projekt.supabase.co"): (url: string, init?: RequestInit) => Promise<Response> {
  const answer = async (url: string, init: RequestInit = {}): Promise<Response> => {
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
          if (ARG_TYPES[n] === "text[]") return Array.isArray(v) ? textArrayLiteral(v) : v;
          return v;
        });
        // jsonb über text: Bun würde einen String sonst noch einmal als JSON kodieren
        const cast = (n: string) => (ARG_TYPES[n] === "jsonb" ? "::text::jsonb" : ARG_TYPES[n] ? `::${ARG_TYPES[n]}` : "::text");
        const list = names.map((n, i) => `${n} => $${i + 1}${cast(n)}`).join(", ");
        if (SET_RETURNING.has(fn)) return json([...(await conn.unsafe(`SELECT * FROM public.${fn}(${list})`, params))]);
        const rows = await conn.unsafe(`SELECT public.${fn}(${list}) AS r`, params);
        return json(rows[0].r);
      }
      const method = (init.method ?? "GET").toUpperCase();
      const table = ident(path);
      const headers = new Headers(init.headers);
      const select = (u.searchParams.get("select") ?? "*").split(",").map(c => c.trim()).map(c => (c === "*" ? "*" : ident(c))).join(", ");
      const where: string[] = [];
      const params: unknown[] = [];
      let order = "";
      let limit = "";
      let offset = "";
      let columns: string[] = [];
      let onConflict: string[] = [];
      if (method === "POST" || method === "PATCH") {
        const body = JSON.parse(String(init.body ?? "{}")) as Record<string, unknown>;
        columns = Object.keys(body).map(ident);
        // Wie PostgREST: eine unbekannte Spalte im Body scheitert, statt still zu entfallen
        const known = await conn.unsafe("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1", [table]);
        const missing = columns.find(c => !known.some((k: { column_name: string }) => k.column_name === c));
        if (missing) return json({ code: "PGRST204", message: `Could not find the '${missing}' column of '${table}' in the schema cache` }, 400);
        params.push(JSON.stringify(body));
      }
      const condition = (col: string, op: string, value: string): string => {
        if (op === "eq" || op === "neq") {
          params.push(value);
          return `${col}::text ${op === "eq" ? "=" : "<>"} $${params.length}`;
        }
        if (op === "ilike") {
          params.push(value.replaceAll("*", "%"));
          return `${col} ILIKE $${params.length}`;
        }
        if (op === "gt") {
          params.push(value);
          // PostgREST vergleicht im Typ der Spalte
          return `${col} > $${params.length}::${table === "messages" || table === "memory" ? "bigint" : "uuid"}`;
        }
        if (op === "gte" && col === "created_at") {
          params.push(value);
          return `${col} >= $${params.length}::timestamptz`;
        }
        if (op === "cs") {
          params.push(value);
          return `${col} @> $${params.length}::text[]`;
        }
        if (op === "is") return `${col} IS ${value === "true" ? "TRUE" : value === "false" ? "FALSE" : "NULL"}`;
        if (op === "not" && value === "is.null") return `${col} IS NOT NULL`;
        if (op === "in") {
          const items = value.replace(/^\(|\)$/g, "").split(",").map(x => x.replace(/^"|"$/g, ""));
          params.push(items.join(","));
          return `${col}::text = ANY(string_to_array($${params.length}::text, ','))`;
        }
        throw new Error(`Filter ${op} nicht nachgebildet`);
      };
      for (const [k, v] of u.searchParams) {
        if (k === "select") continue;
        if (k === "on_conflict") {
          onConflict = v.split(",").map(c => ident(c.trim()));
          continue;
        }
        if (k === "order") {
          const columnsInOrder = v.split(",").map(part => {
            const [col, dir] = part.split(".");
            return `${ident(col)} ${dir === "desc" ? "DESC" : "ASC"}`;
          });
          order = ` ORDER BY ${columnsInOrder.join(", ")}`;
          continue;
        }
        if (k === "limit") {
          limit = ` LIMIT ${Number(v)}`;
          continue;
        }
        if (k === "offset") {
          offset = ` OFFSET ${Number(v)}`;
          continue;
        }
        if (k === "or") {
          // Nur die Form (spalte->>feld.op.wert,...), etwa NOT_DISPLAY_ONLY_FILTER
          const parts = v.replace(/^\(|\)$/g, "").split(",").map(part => {
            const [col, op, ...rest] = part.split(".");
            const json = /^([a-z_]+)->>([a-z_]+)$/.exec(col);
            return condition(json ? `${ident(json[1])}->>'${ident(json[2])}'` : ident(col), op, rest.join("."));
          });
          where.push(`(${parts.join(" OR ")})`);
          continue;
        }
        const [op, ...rest] = v.split(".");
        where.push(condition(ident(k), op, rest.join(".")));
      }
      const filter = where.length ? ` WHERE ${where.join(" AND ")}` : "";
      // PostgREST liefert bigint als Zahl
      const shaped = (rows: Iterable<Record<string, unknown>>) =>
        [...rows].map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, k === "id" && (table === "messages" || table === "memory") ? Number(v) : v])));
      if (method === "GET") {
        return json(shaped(await conn.unsafe(`SELECT ${select} FROM public.${table}${filter}${order}${limit}${offset}`, params)));
      }
      // Wie PostgREST bei Prefer: count=exact: die Zahl steht hinter dem Schrägstrich in Content-Range
      if (method === "HEAD") {
        const [row] = await conn.unsafe(`SELECT count(*)::int AS total FROM public.${table}${filter}`, params);
        return new Response(null, { status: 200, headers: { "Content-Range": `*/${row.total}` } });
      }
      const fromBody = "json_populate_record(null::public." + table + ", $1::text::json)";
      const list = columns.join(", ");
      // Upsert wie PostgREST mit on_conflict und Prefer: resolution=merge-duplicates
      const merge = onConflict.length > 0 && (headers.get("prefer") ?? "").includes("resolution=merge-duplicates");
      const upsert = merge ? ` ON CONFLICT (${onConflict.join(", ")}) DO UPDATE SET ${columns.map(c => `${c} = EXCLUDED.${c}`).join(", ")}` : "";
      const statement =
        method === "POST"
          ? `INSERT INTO public.${table} (${list}) SELECT ${list} FROM ${fromBody}${upsert}`
          : method === "PATCH"
            ? `UPDATE public.${table} SET ${columns.map(c => `${c} = (SELECT ${c} FROM ${fromBody})`).join(", ")}${filter}`
            : method === "DELETE"
              ? `DELETE FROM public.${table}${filter}`
              : null;
      if (!statement) throw new Error(`Methode ${method} nicht nachgebildet: ${url}`);
      const rows = shaped(await conn.unsafe(`${statement} RETURNING ${select}`, params));
      const success = method === "POST" ? 201 : 200;
      if (!(headers.get("prefer") ?? "").includes("return=representation")) return new Response(null, { status: method === "POST" ? 201 : 204 });
      if (!(headers.get("accept") ?? "").includes("vnd.pgrst.object")) return json(rows, success);
      return rows.length === 1 ? json(rows[0], success) : json({ code: "PGRST116", message: "Keine eindeutige Zeile" }, 406);
    } catch (e) {
      const code = String((e as { errno?: unknown }).errno ?? "");
      if (process.env.TEST_PG_DEBUG) console.error(url, e);
      if ((init.method ?? "GET").toUpperCase() === "HEAD") return new Response(null, { status: code === "42501" ? 403 : 400 });
      return json({ code, message: "Fehler" }, code === "42501" ? 403 : 400);
    }
  };
  // Eine Anfrage nach der anderen: conn ist eine einzige Verbindung, und Bun 1.3.10
  // (CI) verliert über TCP ab und zu die Antwort auf gleichzeitig geschickte Abfragen.
  // PostgreSQL steht dann auf „idle“, und der Test hängt bis zum Zeitlimit
  let turn: Promise<unknown> = Promise.resolve();
  return (url, init) => {
    const result = turn.then(() => answer(url, init));
    turn = result.catch(() => {});
    return result;
  };
}

/**
 * Antwortgeber für useFakeSupabase (supabase-fixture.ts): REST-Anfragen des
 * echten supabase-js-Clients gegen echtes SQL, alles andere wie ohne Vorgabe
 */
export function respondViaPg(conn: SQL, base: string) {
  const forward = postgrestFetch(conn, base);
  return (request: { method: string; url: URL; body: string; headers: Headers }): Promise<Response> | undefined =>
    request.url.pathname.startsWith("/rest/v1/")
      ? forward(request.url.toString(), { method: request.method, headers: request.headers, ...(request.body ? { body: request.body } : {}) })
      : undefined;
}
