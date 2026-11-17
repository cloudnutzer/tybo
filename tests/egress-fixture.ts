/**
 * Tabelle messages als kleine PostgREST-Attrappe (Issue #684): beantwortet
 * die Lese-Abfragen der WebUI wie Supabase (Filter, Reihenfolge, Limit,
 * Spaltenauswahl) aus Zeilen im Speicher und merkt sich zu jeder Abfrage
 * Spalten, Filter, Zeilenzahl und Größe der Antwort. So lässt sich zählen,
 * was die WebUI im Ruhezustand wirklich abruft. Eingehängt über respond von
 * useFakeSupabase; ein Filter, den die Attrappe nicht kennt, ergibt 400,
 * damit kein Test still an einer ungefilterten Antwort vorbeiprüft.
 */
import { normalizeIsoTimestamp } from "../src/web/telegram";
import { FAKE_SUPABASE_URL, useFakeSupabase, type FakeRequest } from "./supabase-fixture";

export interface TableRow {
  id: number;
  created_at: string;
  chat_id: string;
  session_key: string | null;
  role: string;
  content: string;
  metadata: Record<string, unknown> | null;
}

export interface TableRead {
  /** Spalten der Abfrage, ohne Leerzeichen, z. B. "id,created_at" */
  select: string;
  params: URLSearchParams;
  /** Zeilen in der Antwort */
  rows: number;
  /** Größe der Antwort in Bytes, unkomprimiert */
  bytes: number;
  failed: boolean;
}

const TABLE_PATH = "/rest/v1/messages";
const KNOWN_PARAMS = new Set(["select", "chat_id", "session_key", "created_at", "metadata->>display_only", "or", "id", "order", "limit"]);

/** Vergleichsschlüssel mit sechs Nachkommastellen wie in Postgres */
export function sortKey(ts: string): string {
  const iso = normalizeIsoTimestamp(ts);
  if (!iso) throw new Error(`kein Zeitpunkt: ${ts}`);
  return iso.replace(/\.(\d{3})Z$/, ".$1000Z");
}

/** Zeitpunkt, wie ihn Postgres liefert: Mikrosekunden und +00:00 */
export function pgStamp(micros: number): string {
  const ms = Math.floor(micros / 1000);
  const frac = String(micros % 1_000_000).padStart(6, "0");
  return `${new Date(ms).toISOString().slice(0, 19)}.${frac}+00:00`;
}

function listOf(value: string): string[] {
  const match = /^in\.\((.*)\)$/.exec(value);
  if (!match) throw new Error(`kein in-Filter: ${value}`);
  return match[1].split(",").map(v => v.replace(/^"|"$/g, ""));
}

export function fakeMessagesTable(start = "2026-11-16T10:00:00.000Z") {
  const rows: TableRow[] = [];
  const reads: TableRead[] = [];
  let nextId = 1000;
  /** Datenbank-Zeit in Mikrosekunden seit Epoch */
  let dbMicros = Date.parse(start) * 1000 + 123;
  let failing = 0;
  let failWhen: ((read: URLSearchParams) => boolean) | null = null;

  function answer(params: URLSearchParams): TableRow[] {
    for (const name of params.keys()) if (!KNOWN_PARAMS.has(name)) throw new Error(`unbekannter Filter: ${name}`);
    let list = [...rows];
    const chat = params.get("chat_id");
    if (chat?.startsWith("eq.")) list = list.filter(r => r.chat_id === chat.slice(3));
    else if (chat) {
      const ids = listOf(chat);
      list = list.filter(r => ids.includes(r.chat_id));
    }
    const session = params.get("session_key");
    if (session) {
      if (!session.startsWith("eq.")) throw new Error(`unbekannter Filter: ${session}`);
      list = list.filter(r => r.session_key === session.slice(3));
    }
    const notice = params.get("metadata->>display_only");
    if (notice) {
      if (notice !== "eq.true") throw new Error(`unbekannter Filter: ${notice}`);
      list = list.filter(r => r.metadata?.display_only === true);
    }
    for (const time of params.getAll("created_at")) {
      const [op, ...rest] = time.split(".");
      const bound = sortKey(rest.join("."));
      if (op === "gte") list = list.filter(r => sortKey(r.created_at) >= bound);
      else if (op === "lt") list = list.filter(r => sortKey(r.created_at) < bound);
      else throw new Error(`unbekannter Filter: ${time}`);
    }
    const cursor = params.get("or");
    if (cursor) {
      const match = /^\(created_at\.gt\."([^"]+)",and\(created_at\.eq\."([^"]+)",id\.gt\.(\d+)\)\)$/.exec(cursor);
      if (!match || match[1] !== match[2]) throw new Error(`unbekannter Cursor: ${cursor}`);
      const at = sortKey(match[1]);
      const id = Number(match[3]);
      list = list.filter(r => sortKey(r.created_at) > at || (sortKey(r.created_at) === at && r.id > id));
    }
    const ids = params.get("id");
    if (ids) {
      const wanted = listOf(ids).map(Number);
      list = list.filter(r => wanted.includes(r.id));
    }
    const order = (params.get("order") ?? "").split(",").filter(Boolean);
    list.sort((a, b) => {
      for (const part of order) {
        const [column, direction] = part.split(".");
        const sign = direction === "desc" ? -1 : 1;
        if (column === "created_at") {
          const ka = sortKey(a.created_at);
          const kb = sortKey(b.created_at);
          if (ka !== kb) return ka < kb ? -sign : sign;
        } else if (column === "id") {
          if (a.id !== b.id) return (a.id - b.id) * sign;
        } else throw new Error(`unbekannte Sortierung: ${part}`);
      }
      return 0;
    });
    const limit = params.get("limit");
    return limit ? list.slice(0, Number(limit)) : list;
  }

  // useFakeSupabase ersetzt fetch für alles; Anfragen an einen Testserver auf diesem Rechner gehen echt hinaus
  const realFetch = globalThis.fetch;

  function respond(request: FakeRequest): Response | Promise<Response> | undefined {
    if (request.url.hostname === "127.0.0.1") {
      return realFetch(request.url, { method: request.method, headers: request.headers, ...(request.body ? { body: request.body } : {}) });
    }
    if (request.url.origin !== FAKE_SUPABASE_URL || request.method !== "GET" || request.url.pathname !== TABLE_PATH) return undefined;
    const params = request.url.searchParams;
    const select = (params.get("select") ?? "*").replace(/\s+/g, "");
    if (failing > 0 || failWhen?.(params)) {
      if (failing > 0) failing--;
      reads.push({ select, params, rows: 0, bytes: 0, failed: true });
      return Response.json({ code: "57014", message: "Attrappe: Abfrage scheitert" }, { status: 500 });
    }
    let found: TableRow[];
    try {
      found = answer(params);
    } catch (e) {
      return Response.json({ code: "PGRST100", message: e instanceof Error ? e.message : "?" }, { status: 400 });
    }
    const columns = select === "*" ? null : select.split(",");
    const body = JSON.stringify(found.map(row => (columns ? Object.fromEntries(columns.map(c => [c, (row as unknown as Record<string, unknown>)[c]])) : row)));
    reads.push({ select, params, rows: found.length, bytes: new TextEncoder().encode(body).length, failed: false });
    return new Response(body, { status: 200, headers: { "Content-Type": "application/json" } });
  }

  const supabase = useFakeSupabase({ respond });

  return {
    rows,
    reads,
    /** Alle Anfragen an die Attrappe, auch die an andere Tabellen */
    requests: supabase.requests,
    restore: () => supabase.restore(),
    /** Datenbank-Uhr als Zeitpunkt in Postgres-Schreibweise */
    dbNow: () => pgStamp(dbMicros),
    /** Datenbank-Uhr in Millisekunden */
    dbNowMs: () => Math.floor(dbMicros / 1000),
    tickDb(ms: number) {
      dbMicros += ms * 1000;
    },
    /** Die nächsten n Lese-Abfragen scheitern */
    failNext(n = 1) {
      failing = n;
    },
    /** Jede Lese-Abfrage, auf die die Bedingung passt, scheitert; null hebt das auf */
    failIf(condition: ((params: URLSearchParams) => boolean) | null) {
      failWhen = condition;
    },
    insert(row: Partial<TableRow> & Pick<TableRow, "chat_id">, options: { at?: string } = {}): TableRow {
      const full: TableRow = {
        id: nextId++,
        created_at: options.at ?? pgStamp(dbMicros),
        session_key: null,
        role: "assistant",
        content: "",
        metadata: {},
        ...row,
      };
      dbMicros += 7;
      rows.push(full);
      return full;
    },
    remove(id: number) {
      const index = rows.findIndex(r => r.id === id);
      if (index >= 0) rows.splice(index, 1);
    },
    /** Abfragen seit dem Aufruf von mark(), siehe since() */
    mark: () => reads.length,
    since: (mark: number) => reads.slice(mark),
  };
}

export type FakeMessagesTable = ReturnType<typeof fakeMessagesTable>;

/** Summe der Antwortgrößen in Bytes */
export function totalBytes(reads: TableRead[]): number {
  return reads.reduce((sum, read) => sum + read.bytes, 0);
}
