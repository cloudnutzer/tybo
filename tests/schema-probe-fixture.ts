// Issue #560: Attrappe der REST-Schnittstelle (PostgREST) für die Schemaprobe.
// Kennt die Merkmale aus SCHEMA_MARKERS; ohne Netz, ohne echte Datenbank.
import { SCHEMA_MARKERS, type ProbeFetch, type SchemaFileName } from "../src/lib/schema-probe";
import { SCHEMA_FILES } from "../src/setup/supabase-schema";

export interface FakeDb {
  tables: Map<string, Set<string>>;
  functions: Set<string>;
  /** Tabellen ohne Leserecht für den Schlüssel */
  denied: Set<string>;
  /** Vorhandene Funktionen ohne EXECUTE-Recht: fehlen im Verzeichnis wie bei PostgREST (follow-privileges) */
  noExecute: Set<string>;
  /** Parameternamen je Funktion; ein Aufruf mit anderen Namen findet sie nicht (PGRST202) */
  params: Map<string, string[]>;
}

/** Datenbank mit allen Merkmalen, ohne die Merkmale der Dateien in without */
export function fakeDb(without: SchemaFileName[] = []): FakeDb {
  const db: FakeDb = { tables: new Map(), functions: new Set(), denied: new Set(), noExecute: new Set(), params: new Map() };
  for (const file of SCHEMA_FILES) {
    for (const m of SCHEMA_MARKERS[file]) {
      if (m.kind === "columns") {
        const cols = db.tables.get(m.table) ?? new Set<string>();
        for (const c of m.columns) cols.add(c);
        db.tables.set(m.table, cols);
      } else if (m.kind === "function") {
        db.functions.add(m.name);
        db.params.set(m.name, Object.keys(m.args));
      } else for (const t of m.tables) if (!db.tables.has(t)) db.tables.set(t, new Set(["id"]));
    }
  }
  for (const file of without) {
    for (const m of SCHEMA_MARKERS[file]) {
      if (m.kind === "columns") for (const c of m.columns) db.tables.get(m.table)?.delete(c);
      else if (m.kind === "function") db.functions.delete(m.name);
      else for (const t of m.tables) db.denied.add(t);
    }
  }
  return db;
}

export const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function fakeFetch(db: FakeDb, calls: { url: string; headers: Record<string, string> }[] = []): ProbeFetch {
  return async (url, init) => {
    calls.push({ url, headers: init.headers });
    const u = new globalThis.URL(url);
    const path = u.pathname.replace(/^\/rest\/v1/, "");
    if (path === "/") {
      const paths: Record<string, unknown> = { "/": {} };
      for (const t of db.tables.keys()) paths[`/${t}`] = {};
      for (const f of db.functions) if (!db.noExecute.has(f)) paths[`/rpc/${f}`] = {};
      return json(200, { swagger: "2.0", paths });
    }
    if (path.startsWith("/rpc/")) {
      const name = decodeURIComponent(path.slice("/rpc/".length));
      const given = [...u.searchParams.keys()].sort().join(",");
      if (!db.functions.has(name) || [...(db.params.get(name) ?? [])].sort().join(",") !== given) {
        return json(404, { code: "PGRST202", message: `Could not find the function public.${name}(${given}) in the schema cache`, hint: null });
      }
      if (db.noExecute.has(name)) return json(401, { code: "42501", message: `permission denied for function ${name}` });
      return json(400, { code: "22P02", message: "invalid input syntax for type vector" });
    }
    const table = decodeURIComponent(path.slice(1));
    const cols = db.tables.get(table);
    if (!cols || cols.size === 0) return json(404, { code: "PGRST205", message: `Could not find the table 'public.${table}' in the schema cache` });
    if (db.denied.has(table)) return json(401, { code: "42501", message: `permission denied for table ${table}` });
    for (const c of (u.searchParams.get("select") ?? "").split(",")) {
      if (!cols.has(c)) return json(400, { code: "42703", message: `column ${table}.${c} does not exist` });
    }
    if (u.searchParams.get("limit") !== "0") return json(400, { code: "TEST", message: "Schemaprobe ohne limit=0" });
    return json(200, []);
  };
}

