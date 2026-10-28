/**
 * Tabellen async_tasks, node_heartbeat, logs und messages ohne Netz (Issue
 * #312), hinter der Fetch-Attrappe aus supabase-fixture.ts. Die Nachbildung
 * hält sich an db/schema.sql: unbekannte Spalten scheitern wie bei PostgREST
 * (PGRST204), NOT NULL ohne Wert wie bei Postgres (23502), Vorgaben der
 * Spalten (status, reminder_sent, metadata, Zeitpunkte) setzt sie selbst.
 * Sie versteht select, eq, lt, gt, order, limit, offset, Einzelzeile, Insert mit
 * Rückgabe, Upsert über den Primärschlüssel und Update je Filter. Wie
 * PostgREST mit supabase/config.toml liefert ein GET höchstens maxRows
 * Zeilen (Standard 1000). afterRead ändert den Bestand zwischen zwei
 * Lesevorgängen, wie es der Planer nebenher tut.
 * Zeitpunkte kommen aus Date.now(), Tests stellen die Uhr mit setSystemTime.
 * Ausnahmen prüfen die Tests mit throwingClient statt mit werfendem fetch,
 * weil supabase-js Netzfehler mit Wartezeit wiederholt.
 */
import { FAKE_SUPABASE_URL, useFakeSupabase, type FakeRequest } from "./supabase-fixture";

export type Row = Record<string, unknown>;

interface TableShape {
  key: string;
  columns: string[];
  required: string[];
  /** Vorgaben der Datenbank beim Insert */
  defaults: () => Row;
}

const now = () => new Date(Date.now()).toISOString();

const SHAPES: Record<string, TableShape> = {
  async_tasks: {
    key: "id",
    columns: [
      "id",
      "created_at",
      "updated_at",
      "chat_id",
      "original_prompt",
      "status",
      "result",
      "session_id",
      "current_step",
      "pending_question",
      "pending_options",
      "user_response",
      "thread_id",
      "processed_by",
      "reminder_sent",
      "metadata",
    ],
    required: ["chat_id", "original_prompt", "status"],
    defaults: () => ({ id: crypto.randomUUID(), created_at: now(), updated_at: now(), status: "pending", reminder_sent: false, metadata: {} }),
  },
  node_heartbeat: {
    key: "node_id",
    columns: ["node_id", "last_heartbeat", "metadata"],
    required: ["node_id"],
    defaults: () => ({ last_heartbeat: now(), metadata: {} }),
  },
  logs: {
    key: "id",
    columns: ["id", "created_at", "level", "event", "message", "metadata", "session_id", "duration_ms"],
    required: ["level", "event"],
    defaults: () => ({ id: String(Math.floor(Math.random() * 1e9)), created_at: now(), metadata: {} }),
  },
  // Issue #321, wie db/migrations/20261017_scheduled_tasks.sql, Lease aus 20261018_scheduled_tasks_lease.sql (#322)
  scheduled_tasks: {
    key: "id",
    columns: ["id", "chat_id", "topic_id", "kind", "text", "due_at", "recurrence", "status", "attempts", "last_error", "lease_owner", "lease_until", "send_started_at", "created_at", "updated_at"],
    required: ["chat_id", "text", "due_at"],
    defaults: () => ({
      id: crypto.randomUUID(),
      topic_id: null,
      kind: "reminder",
      recurrence: null,
      status: "pending",
      attempts: 0,
      last_error: null,
      lease_owner: null,
      lease_until: null,
      send_started_at: null,
      created_at: now(),
      updated_at: now(),
    }),
  },
  messages: {
    key: "id",
    columns: ["id", "created_at", "chat_id", "role", "content", "metadata"],
    required: ["chat_id", "role", "content"],
    defaults: () => ({ id: crypto.randomUUID(), created_at: now(), metadata: {} }),
  },
};

export interface TaskTablesOptions {
  /** Startzeilen je Tabelle; Vorgaben ergänzen fehlende Spalten */
  rows?: Partial<Record<keyof typeof SHAPES, Row[]>>;
  /** Jede Anfrage an diese Tabellen scheitert mit 500 */
  fail?: string[];
  /** Höchstens so viele Zeilen je GET (max_rows); Standard 1000 wie supabase/config.toml */
  maxRows?: number;
  /** Läuft nach jedem beantworteten GET auf diese Tabelle, mit laufender Nummer ab 1 und den Zeilen der Tabelle */
  afterRead?: (table: string, n: number, rows: Row[]) => void;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Zeitpunkte als Zeit, IDs (uuid) und anderes als Text */
function compare(column: string, cell: unknown, value: string): number {
  if (column === "id") return String(cell) < value ? -1 : String(cell) > value ? 1 : 0;
  return Date.parse(String(cell)) - Date.parse(value);
}

function matches(row: Row, params: URLSearchParams): boolean {
  for (const [column, filter] of params) {
    if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(column)) continue;
    const dot = filter.indexOf(".");
    const op = filter.slice(0, dot);
    const value = filter.slice(dot + 1);
    const cell = row[column];
    if (op === "eq" && String(cell) !== value) return false;
    if (op === "lt" && !(compare(column, cell, value) < 0)) return false;
    if (op === "gt" && !(compare(column, cell, value) > 0)) return false;
    if (op === "lte" && !(compare(column, cell, value) <= 0)) return false;
    if (op === "gte" && !(compare(column, cell, value) >= 0)) return false;
    if (op === "is" && !(value === "null" ? cell === null || cell === undefined : String(cell) === value)) return false;
    if (op === "not" && value === "is.null" && (cell === null || cell === undefined)) return false;
    if (op === "in" && !value.replace(/^\(|\)$/g, "").split(",").map(v => v.replace(/^"|"$/g, "")).includes(String(cell))) return false;
  }
  return true;
}

function ordered(rows: Row[], order: string | null): Row[] {
  if (!order) return rows;
  // Mehrere Spalten kommen als order=a.asc,b.desc
  const keys = order.split(",").map(part => {
    const [column, direction] = part.split(".");
    return { column, sign: direction === "desc" ? -1 : 1 };
  });
  return [...rows].sort((a, b) => {
    for (const { column, sign } of keys) {
      const diff = String(a[column]).localeCompare(String(b[column]));
      if (diff) return sign * diff;
    }
    return 0;
  });
}

function picked(row: Row, select: string | null): Row {
  if (!select || select === "*") return structuredClone(row);
  return Object.fromEntries(select.split(",").map(c => [c.trim(), structuredClone(row[c.trim()])]));
}

/** Fehler wie PostgREST bzw. Postgres, wenn die Zeile nicht ins Schema passt; sonst null */
function schemaError(shape: TableShape, body: Row, inserting: boolean): Response | null {
  const unknown = Object.keys(body).find(c => !shape.columns.includes(c));
  if (unknown) return json({ code: "PGRST204", message: `Could not find the '${unknown}' column in the schema cache` }, 400);
  if (inserting) {
    const missing = shape.required.find(c => body[c] === undefined || body[c] === null);
    if (missing) return json({ code: "23502", message: `null value in column "${missing}" violates not-null constraint` }, 400);
  }
  return null;
}

export function useTaskTables(options: TaskTablesOptions = {}) {
  const tables: Record<string, Row[]> = {};
  for (const [name, shape] of Object.entries(SHAPES)) {
    tables[name] = (options.rows?.[name as keyof typeof SHAPES] ?? []).map(r => ({ ...shape.defaults(), ...r }));
  }

  const reads: Record<string, number> = {};

  function answer(name: string, request: FakeRequest): Response {
    if (options.fail?.includes(name)) return json({ message: "kaputt" }, 500);
    const shape = SHAPES[name];
    const table = tables[name];
    const params = request.url.searchParams;
    const single = (request.headers.get("accept") ?? "").includes("vnd.pgrst.object");
    const prefer = request.headers.get("prefer") ?? "";
    const respondRows = (rows: Row[], status: number) => {
      const out = rows.map(r => picked(r, params.get("select")));
      if (single) {
        if (out.length !== 1) return json({ code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" }, 406);
        return json(out[0], status);
      }
      return json(out, status);
    };
    if (request.method === "GET") {
      let rows = ordered(table.filter(r => matches(r, params)), params.get("order"));
      const offset = Number(params.get("offset") ?? 0);
      const limit = params.get("limit");
      rows = rows.slice(offset, limit ? offset + Number(limit) : undefined).slice(0, options.maxRows ?? 1000);
      const response = respondRows(rows, 200);
      reads[name] = (reads[name] ?? 0) + 1;
      options.afterRead?.(name, reads[name], table);
      return response;
    }
    if (request.method === "POST") {
      const body = JSON.parse(request.body) as Row;
      const broken = schemaError(shape, body, true);
      if (broken) return broken;
      const existing = table.find(r => body[shape.key] !== undefined && r[shape.key] === body[shape.key]);
      let row: Row;
      if (existing && prefer.includes("resolution=merge-duplicates")) {
        row = Object.assign(existing, body);
      } else if (existing && prefer.includes("resolution=ignore-duplicates")) {
        // ON CONFLICT DO NOTHING (Issue #323): keine Zeile zurück
        return prefer.includes("return=representation") ? respondRows([], 201) : new Response(null, { status: 201 });
      } else if (existing) {
        return json({ code: "23505", message: "duplicate key value violates unique constraint" }, 409);
      } else {
        row = { ...shape.defaults(), ...body };
        table.push(row);
      }
      return prefer.includes("return=representation") ? respondRows([row], 201) : new Response(null, { status: 201 });
    }
    if (request.method === "PATCH") {
      const body = JSON.parse(request.body) as Row;
      const broken = schemaError(shape, body, false);
      if (broken) return broken;
      const hit = table.filter(r => matches(r, params));
      for (const row of hit) Object.assign(row, body);
      return prefer.includes("return=representation") ? respondRows(hit, 200) : new Response(null, { status: 204 });
    }
    return json({ message: "unerwartet" }, 405);
  }

  const fake = useFakeSupabase({
    respond(request) {
      if (request.url.origin !== FAKE_SUPABASE_URL) return undefined;
      const name = request.url.pathname.replace(/^\/rest\/v1\//, "");
      if (!(name in SHAPES)) return undefined;
      return answer(name, request);
    },
  });

  return {
    tables,
    requests: fake.requests,
    /** Anfragen an eine der Tabellen */
    requestsTo: (name: string) => fake.requests.filter(r => r.url.pathname === `/rest/v1/${name}`),
    restore: () => fake.restore(),
  };
}

/** Client, dessen from() wirft: Ausnahme mitten in der Abfrage */
export const throwingClient = () =>
  ({
    from() {
      throw new TypeError("Netz weg");
    },
  }) as never;
