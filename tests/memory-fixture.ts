/**
 * Tabelle memory ohne Netz (Issue #311): eine kleine PostgREST-Nachbildung
 * hinter der Fetch-Attrappe aus supabase-fixture.ts. Sie versteht, was die
 * Gedächtnis-Wege heute schicken: select, eq, ilike (mit `\`-Escape und
 * den Platzhaltern `%`, `_`, `*`), order, limit, Insert mit Rückgabe, Update und
 * Delete je id (auf Wunsch mit den getroffenen Zeilen). Dazu die RPCs der Anbieterkennung und embedding_fact_vectors
 * sowie OpenAI-Embeddings (auf Wunsch zurückgehalten), alles zählbar über `requests`.
 */
import { clearRegistryCache } from "../supabase/functions/_shared/embedding";
import { FAKE_SUPABASE_URL, useFakeSupabase, type FakeRequest } from "./supabase-fixture";

export type Row = Record<string, unknown>;

/** Vektor mit den Werten vorn, mit Nullen auf 1536 Stellen aufgefüllt (Länge der Spalte) */
export function pad(values: number[]): number[] {
  return [...values, ...Array.from({ length: 1536 - values.length }, () => 0)];
}

export interface MemoryTableOptions {
  /** Startzeilen; id und created_at bekommen sie, wenn sie fehlen */
  rows?: Row[];
  /** Antwort der RPC embedding_fact_vectors; undefined heißt leere Liste */
  factVectors?: () => Response;
  /** Vektor, den die OpenAI-Attrappe für einen Text liefert */
  embed?: (text: string) => number[];
  /** Hält die Antwort der OpenAI-Attrappe zurück, bis das Versprechen erfüllt ist */
  holdEmbedding?: Promise<void>;
  /** Jede Anfrage an die Tabelle scheitert mit 500 */
  failTable?: boolean;
  /** Update mit embedding_model scheitert wie ohne Migration (PGRST204) */
  missingModelColumn?: boolean;
}

/** Spalten von memory in db/schema.sql; wer andere schreibt oder filtert, scheitert wie am echten Schema (Issue #518) */
const COLUMNS = new Set(["id", "created_at", "updated_at", "type", "content", "deadline", "completed_at", "priority", "metadata", "embedding", "embedding_model", "archived_at", "revised_at"]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** ilike-Muster als regulärer Ausdruck, wie Postgres und PostgREST es lesen */
function likeToRegExp(pattern: string): RegExp {
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "\\" && i + 1 < pattern.length) {
      source += pattern[++i].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (char === "%" || char === "*") {
      source += "[\\s\\S]*";
    } else if (char === "_") {
      source += "[\\s\\S]";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`, "i");
}

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [column, filter] of params) {
    if (["select", "order", "limit"].includes(column)) continue;
    const dot = filter.indexOf(".");
    const op = filter.slice(0, dot);
    const value = filter.slice(dot + 1);
    const cell = row[column];
    if (op === "eq" && String(cell) !== value) return false;
    if (op === "ilike" && !likeToRegExp(value).test(String(cell ?? ""))) return false;
    if (op === "is" && value === "null" && cell !== null && cell !== undefined) return false;
    if (filter === "not.is.null" && (cell === null || cell === undefined)) return false;
  }
  return true;
}

function ordered(rows: Row[], order: string | null): Row[] {
  if (!order) return rows;
  const [column, direction] = order.split(".");
  const sign = direction === "desc" ? -1 : 1;
  return [...rows].sort((a, b) => sign * String(a[column]).localeCompare(String(b[column])));
}

function picked(row: Row, select: string | null): Row {
  if (!select || select === "*") return { ...row };
  return Object.fromEntries(select.split(",").map(c => [c.trim(), row[c.trim()]]));
}

export function useMemoryTable(options: MemoryTableOptions = {}) {
  clearRegistryCache();
  let nextId = 1;
  let clock = Date.parse("2026-10-01T08:00:00.000Z");
  const stamp = () => new Date((clock += 1000)).toISOString();
  const table: Row[] = (options.rows ?? []).map(r => ({ id: String(nextId++), created_at: stamp(), ...r }));
  const embed = options.embed ?? (() => pad([1]));

  /** Antwort auf Update oder Delete: mit select (return=representation) die getroffenen Zeilen */
  function changed(request: FakeRequest, hit: Row[]): Response {
    if (!(request.headers.get("prefer") ?? "").includes("return=representation")) return new Response(null, { status: 204 });
    return json(hit.map(r => picked(r, request.url.searchParams.get("select"))));
  }

  function answerTable(request: FakeRequest): Response {
    if (options.failTable) return json({ message: "kaputt" }, 500);
    const params = request.url.searchParams;
    for (const [column] of params) {
      if (!["select", "order", "limit"].includes(column) && !COLUMNS.has(column)) return json({ code: "42703", message: `column memory.${column} does not exist` }, 400);
    }
    if (request.method === "POST" || request.method === "PATCH") {
      const unknown = Object.keys(JSON.parse(request.body)).find(column => !COLUMNS.has(column));
      if (unknown) return json({ code: "PGRST204", message: `Could not find the '${unknown}' column` }, 400);
    }
    const single = (request.headers.get("accept") ?? "").includes("vnd.pgrst.object");
    if (request.method === "GET") {
      const limit = params.get("limit");
      const all = ordered(table.filter(r => matches(r, params)), params.get("order")).map(r => picked(r, params.get("select")));
      const rows = limit === null ? all : all.slice(0, Number(limit));
      return json(single ? rows[0] ?? null : rows);
    }
    if (request.method === "POST") {
      const body = JSON.parse(request.body);
      const row = { id: String(nextId++), created_at: stamp(), ...body };
      table.push(row);
      const out = picked(row, params.get("select"));
      return (request.headers.get("prefer") ?? "").includes("return=representation") ? json(single ? out : [out], 201) : new Response(null, { status: 201 });
    }
    if (request.method === "PATCH") {
      const body = JSON.parse(request.body);
      if (options.missingModelColumn && "embedding_model" in body) {
        return json({ code: "PGRST204", message: "Could not find the 'embedding_model' column" }, 400);
      }
      const hit = table.filter(r => matches(r, params));
      for (const row of hit) Object.assign(row, body);
      return changed(request, hit);
    }
    if (request.method === "DELETE") {
      const hit = table.filter(r => matches(r, params));
      for (const row of hit) table.splice(table.indexOf(row), 1);
      return changed(request, hit);
    }
    return json({ message: "unerwartet" }, 405);
  }

  const fake = useFakeSupabase({
    respond(request) {
      const { pathname } = request.url;
      if (request.url.origin === "https://api.openai.com") {
        const input = String(JSON.parse(request.body).input);
        const answer = () => json({ data: [{ embedding: embed(input) }] });
        return options.holdEmbedding ? options.holdEmbedding.then(answer) : answer();
      }
      if (request.url.origin !== FAKE_SUPABASE_URL) return undefined;
      if (pathname === "/rest/v1/memory") return answerTable(request);
      if (pathname === "/rest/v1/rpc/embedding_provider_status") return json({ state: "leer", vectors: false });
      if (pathname === "/rest/v1/rpc/claim_embedding_provider") {
        const body = JSON.parse(request.body);
        return json({ state: "festgehalten", provider: body.p_provider, model: body.p_model });
      }
      if (pathname === "/rest/v1/rpc/embedding_fact_vectors") return options.factVectors?.() ?? json([]);
      return undefined;
    },
  });

  const ofPath = (path: string) => fake.requests.filter(r => r.url.pathname === path);
  return {
    table,
    requests: fake.requests,
    /** Anfragen an die Tabelle memory */
    tableRequests: () => ofPath("/rest/v1/memory"),
    /** Anfragen an einen Embedding-Anbieter */
    embeddingRequests: () => fake.requests.filter(r => r.url.origin === "https://api.openai.com"),
    factVectorRequests: () => ofPath("/rest/v1/rpc/embedding_fact_vectors"),
    /** Wartet, bis cond() wahr ist (asynchrones Embedding), höchstens eine Sekunde */
    async until(cond: () => boolean): Promise<void> {
      for (let i = 0; i < 100 && !cond(); i++) await Bun.sleep(10);
      if (!cond()) throw new Error("Bedingung nicht erreicht");
    },
    restore() {
      fake.restore();
      clearRegistryCache();
    },
  };
}
