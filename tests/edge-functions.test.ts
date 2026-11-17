/**
 * Issue #320: Verträge der drei Edge Functions (embed-knowledge,
 * search-memory, store-telegram-message), festgehalten vor dem Neuschreiben.
 * Statuscodes, Antwortfelder, Pflichtfelder, ungültiges JSON, Fehlerfälle
 * und die Aufrufe an die Datenbank. Die Functions laufen in Bun mit
 * nachgebildetem Deno (env, serve), einer createClient-Attrappe statt esm.sh
 * und einer fetch-Attrappe für OpenAI und die Anbieterkennung. Kein Netz.
 *
 * Einzige gewollte Änderung (#320): OPTIONS beantwortet den Preflight vor
 * der Prüfung des Schlüssels, mit CORS-Köpfen und ohne Aufruf nach draußen.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { join } from "path";
import { clearRegistryCache } from "../supabase/functions/_shared/embedding";
import { containsPattern } from "../supabase/functions/_shared/like-pattern";
import { EXCERPT_CHARS, splitIntoChunks } from "../supabase/functions/_shared/chunks";
import { NOT_DISPLAY_ONLY_FILTER } from "../src/lib/store/supabase/messages";

const SECRET = "sb_secret_attrappe123";
const SUPABASE_URL = "https://attrappe.supabase.co";
const FUNCTIONS_DIR = join(import.meta.dir, "..", "supabase", "functions");
const NAMES = ["embed-knowledge", "search-memory", "store-telegram-message"] as const;
type Name = (typeof NAMES)[number];

// --- Datenbank-Attrappe ------------------------------------------------------

interface Call {
  method: string;
  args: unknown[];
}
/** Eine Abfragekette (from(...).insert(...) bzw. rpc(...)), Aufruf für Aufruf */
type Chain = Call[];
type Answer = { data: unknown; error: { code?: string; message: string } | null };

const clients: { url: string; key: string }[] = [];
const chains: Chain[] = [];
/** Antwort der Datenbank je Kette; Standard: keine Daten, kein Fehler */
let answer: (chain: Chain) => Answer;

function chainFrom(first: Call): unknown {
  const chain: Chain = [first];
  chains.push(chain);
  const builder: unknown = new Proxy(() => {}, {
    get: (_, prop) =>
      prop === "then"
        ? (resolve: (v: unknown) => void) => resolve(answer(chain))
        : (...args: unknown[]) => {
            chain.push({ method: String(prop), args });
            return builder;
          },
  });
  return builder;
}

mock.module("https://esm.sh/@supabase/supabase-js@2.116.0", () => ({
  createClient: (url: string, key: string) => {
    clients.push({ url, key });
    return {
      from: (...args: unknown[]) => chainFrom({ method: "from", args }),
      rpc: (...args: unknown[]) => chainFrom({ method: "rpc", args }),
    };
  },
}));

const methodOf = (chain: Chain, method: string) => chain.find(c => c.method === method);
const chainsWith = (method: string, first?: unknown) => chains.filter(c => c[0].method === method && (first === undefined || c[0].args[0] === first));

// --- Deno- und fetch-Attrappe ------------------------------------------------

const g = globalThis as { Deno?: unknown };
let savedDeno: unknown;
let env: Record<string, string>;
const handlers = {} as Record<Name, (req: Request) => Promise<Response>>;

/** Was nach draußen ging (OpenAI, Anbieterkennung) */
let outbound: { url: string; body: any }[];
let fetchSpy: ReturnType<typeof spyOn>;
let vector: number[];
/** Antwort von OpenAI; Standard der Vektor oben */
let openai: () => Response;

beforeAll(async () => {
  savedDeno = g.Deno;
  let current: Name | null = null;
  g.Deno = {
    env: { get: (name: string) => env[name] },
    serve: (h: (req: Request) => Promise<Response>) => {
      handlers[current!] = h;
    },
  };
  // Eigene Instanzen über die Abfrage im Pfad, unabhängig davon, ob ein anderer Test die Functions schon geladen hat
  for (const name of NAMES) {
    current = name;
    await import(`${join(FUNCTIONS_DIR, name, "index.ts")}?edge-functions-test`);
  }
});

afterAll(() => {
  if (savedDeno === undefined) delete g.Deno;
  else g.Deno = savedDeno;
});

beforeEach(() => {
  clients.length = 0;
  chains.length = 0;
  answer = () => ({ data: [], error: null });
  clearRegistryCache();
  env = { SUPABASE_URL, SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }), OPENAI_API_KEY: "sk-attrappe" };
  outbound = [];
  vector = Array.from({ length: 1536 }, (_, i) => (i + 1) / 1536);
  openai = () => new Response(JSON.stringify({ data: [{ embedding: vector }] }));
  fetchSpy?.mockRestore();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    outbound.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === `${SUPABASE_URL}/rest/v1/rpc/embedding_provider_status`) return new Response(JSON.stringify({ state: "leer", vectors: false }));
    if (url === `${SUPABASE_URL}/rest/v1/rpc/claim_embedding_provider`) {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ state: "festgehalten", provider: body.p_provider, model: body.p_model }));
    }
    if (url === "https://api.openai.com/v1/embeddings") return openai();
    return new Response("unerwartet", { status: 500 });
  }) as typeof fetch);
});

afterAll(() => fetchSpy?.mockRestore());

function request(name: Name, init: { method?: string; headers?: Record<string, string>; body?: string | null } = {}): Request {
  const method = init.method ?? "POST";
  return new Request(`http://edge.test/functions/v1/${name}`, {
    method,
    headers: init.headers ?? { "content-type": "application/json", apikey: SECRET },
    ...(method === "GET" || method === "OPTIONS" || init.body === null ? {} : { body: init.body ?? "{}" }),
  });
}

const call = (name: Name, body: unknown) => handlers[name](request(name, { body: JSON.stringify(body) }));
const external = () => outbound.filter(o => !o.url.startsWith(`${SUPABASE_URL}/`));

const VALID: Record<Name, Record<string, unknown>> = {
  "embed-knowledge": { knowledge_id: "k1", text: "Notiz" },
  "search-memory": { chat_id: "c1", query: "Notiz" },
  "store-telegram-message": { chat_id: "c1", role: "user", content: "Hallo" },
};
const MISSING: Record<Name, unknown> = {
  "embed-knowledge": { ok: false, error: "Missing knowledge_id or text" },
  "search-memory": { error: "Missing required fields" },
  "store-telegram-message": { ok: false, error: "Missing required fields" },
};

// --- Für alle drei -----------------------------------------------------------

for (const name of NAMES) {
  describe(`${name}: gemeinsamer Rahmen`, () => {
    test("OPTIONS: Preflight mit CORS-Köpfen, ohne Schlüssel, ohne Client und ohne Aufruf nach draußen", async () => {
      const res = await handlers[name](
        request(name, { method: "OPTIONS", headers: { origin: "https://irgendwo.test", "access-control-request-method": "POST", "access-control-request-headers": "apikey, content-type" } }),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("ok");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(res.headers.get("access-control-allow-headers")).toBe("authorization, x-client-info, apikey, content-type");
      expect(clients).toEqual([]);
      expect(outbound).toEqual([]);
    });

    test("OPTIONS auch ohne Schlüssel in der Umgebung: Preflight statt 503", async () => {
      env = {};
      const res = await handlers[name](request(name, { method: "OPTIONS", headers: {} }));
      expect(res.status).toBe(200);
      expect(outbound).toEqual([]);
    });

    test("GET: 405 als Text, ohne Client", async () => {
      const res = await handlers[name](request(name, { method: "GET" }));
      expect(res.status).toBe(405);
      expect(await res.text()).toBe("Method not allowed");
      expect(clients).toEqual([]);
    });

    test("falscher bzw. fehlender Schlüssel: 401 als Text, nichts nach draußen", async () => {
      for (const headers of [{}, { apikey: "sb_publishable_attrappe" }, { authorization: `Bearer ${SECRET}` }]) {
        const res = await handlers[name](request(name, { headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(VALID[name]) }));
        expect(res.status).toBe(401);
        expect(await res.text()).toBe("Unauthorized");
      }
      expect(clients).toEqual([]);
      expect(outbound).toEqual([]);
    });

    test("kein Schlüssel in der Umgebung: 503 als Text", async () => {
      env = { SUPABASE_URL };
      const res = await call(name, VALID[name]);
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("Not configured");
    });

    test("nur benannter Secret ohne default: 503, obwohl der apikey passt", async () => {
      env = { SUPABASE_URL, SUPABASE_SECRET_KEYS: JSON.stringify({ backup: SECRET }) };
      const res = await call(name, VALID[name]);
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("Not configured");
      expect(clients).toEqual([]);
      expect(outbound).toEqual([]);
    });

    test("ungültiges JSON: 500 als JSON mit Fehlertext, CORS-Kopf, ohne Client", async () => {
      const res = await handlers[name](request(name, { body: "{kein json" }));
      expect(res.status).toBe(500);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      const data = await res.json();
      expect(typeof data.error).toBe("string");
      expect(data.error.length).toBeGreaterThan(0);
      if (name === "search-memory") expect(Object.keys(data)).toEqual(["error"]);
      else expect(data.ok).toBe(false);
      expect(clients).toEqual([]);
      expect(outbound).toEqual([]);
    });

    test("leerer Rumpf: 500 wie ungültiges JSON", async () => {
      const res = await handlers[name](request(name, { body: "" }));
      expect(res.status).toBe(500);
    });

    test("jedes Pflichtfeld fehlend oder leer: 400 mit festem Satz, ohne Client und ohne Aufruf nach draußen", async () => {
      for (const field of Object.keys(VALID[name])) {
        for (const value of [undefined, "", null, 0]) {
          const body = { ...VALID[name], [field]: value };
          const res = await call(name, body);
          expect(res.status).toBe(400);
          expect(res.headers.get("content-type")).toBe("application/json");
          expect(res.headers.get("access-control-allow-origin")).toBe("*");
          expect(await res.json()).toEqual(MISSING[name]);
        }
      }
      expect(clients).toEqual([]);
      expect(outbound).toEqual([]);
    });

    test("Erfolg: 200, JSON, CORS-Kopf, Client mit SUPABASE_URL und SUPABASE_SECRET_KEYS.default", async () => {
      env.SUPABASE_SERVICE_ROLE_KEY = "eyJ.alter.schluessel";
      const res = await call(name, VALID[name]);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/json");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      expect(clients).toEqual([{ url: SUPABASE_URL, key: SECRET }]);
    });
  });
}

// --- embed-knowledge ---------------------------------------------------------

describe("embed-knowledge", () => {
  test("Erfolg: Vektor mit Modellangabe in knowledge, nur die eine Zeile", async () => {
    const res = await call("embed-knowledge", { knowledge_id: "k1", text: "Notiz" });
    expect(await res.json()).toEqual({ ok: true, embedded: true });
    const updates = chainsWith("from", "knowledge");
    expect(updates).toHaveLength(1);
    expect(methodOf(updates[0], "update")!.args).toEqual([{ embedding: vector, embedding_model: "openai:text-embedding-3-small" }]);
    expect(methodOf(updates[0], "eq")!.args).toEqual(["id", "k1"]);
  });

  test("Text geht ungekürzt an den Anbieter", async () => {
    const text = "x".repeat(9000);
    await call("embed-knowledge", { knowledge_id: "k1", text });
    expect(external()[0].body).toEqual({ model: "text-embedding-3-small", input: text });
  });

  test("Spalte embedding_model fehlt (PGRST204): zweiter Versuch nur mit dem Vektor", async () => {
    answer = chain => (methodOf(chain, "update")!.args[0] as Record<string, unknown>).embedding_model ? { data: null, error: { code: "PGRST204", message: "fehlt" } } : { data: null, error: null };
    const res = await call("embed-knowledge", { knowledge_id: "k1", text: "Notiz" });
    expect(await res.json()).toEqual({ ok: true, embedded: true });
    const updates = chainsWith("from", "knowledge");
    expect(updates.map(c => methodOf(c, "update")!.args[0])).toEqual([{ embedding: vector, embedding_model: "openai:text-embedding-3-small" }, { embedding: vector }]);
    expect(updates.map(c => methodOf(c, "eq")!.args)).toEqual([["id", "k1"], ["id", "k1"]]);
  });

  test("anderer Fehler beim Schreiben: 500 mit Supabase update error", async () => {
    answer = () => ({ data: null, error: { code: "42501", message: "keine Rechte" } });
    const res = await call("embed-knowledge", { knowledge_id: "k1", text: "Notiz" });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, error: "Supabase update error: keine Rechte" });
    expect(chainsWith("from", "knowledge")).toHaveLength(1);
  });

  test("ohne Schlüssel: 200 ok ohne Embedding, mit Grund, nichts geschrieben", async () => {
    delete env.OPENAI_API_KEY;
    const res = await call("embed-knowledge", { knowledge_id: "k1", text: "Notiz" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, embedded: false, reason: "OPENAI_API_KEY ist nicht gesetzt." });
    expect(chains).toEqual([]);
    expect(external()).toEqual([]);
  });

  test("Anbieter passt nicht zur Datenbank (gesperrt): 200 ok ohne Embedding, mit Grund", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      env.EMBEDDING_PROVIDER = "gemini";
      env.GEMINI_API_KEY = "AIza-attrappe";
      fetchSpy.mockImplementation((async () => new Response(JSON.stringify({ state: "festgehalten", provider: "openai", model: "text-embedding-3-small" }))) as unknown as typeof fetch);
      const res = await call("embed-knowledge", { knowledge_id: "k1", text: "Notiz" });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data).toMatchObject({ ok: true, embedded: false });
      expect(data.reason).toContain("festgelegt");
      expect(chains).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  test("Anbieter lehnt ab: 502 mit festem Satz", async () => {
    openai = () => new Response(JSON.stringify({ error: { message: "Incorrect API key provided: sk-attrappe" } }), { status: 401 });
    const res = await call("embed-knowledge", { knowledge_id: "k1", text: "Notiz" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "Embedding fehlgeschlagen: OpenAI (text-embedding-3-small) lehnt den Schlüssel ab (HTTP 401)." });
    expect(chains).toEqual([]);
  });

  test("ungültige Einstellung: 502 mit dem Satz zur Einstellung", async () => {
    env.EMBEDDING_PROVIDER = "unbekannt";
    const res = await call("embed-knowledge", { knowledge_id: "k1", text: "Notiz" });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ ok: false, error: "Embedding fehlgeschlagen: EMBEDDING_PROVIDER kennt nur openai, gemini oder ollama." });
  });
});

// --- search-memory -----------------------------------------------------------

describe("search-memory", () => {
  const HIT = [{ id: 1, content: "Treffer", similarity: 0.9 }];

  /** Argumente der geprüften Suchen; vector entsteht erst in beforeEach */
  const CHECKED = () => ({ p_provider: "openai", p_model: "text-embedding-3-small", query_embedding: vector, filter_chat_id: "c1", match_threshold: 0.5, match_count: 10 });

  test("semantischer Treffer: match_messages_chunked_checked mit Anbieter, Modell, Vektor und Standardlimit 10", async () => {
    answer = chain => (chain[0].method === "rpc" ? { data: HIT, error: null } : { data: [], error: null });
    const res = await call("search-memory", { chat_id: "c1", query: "Notiz" });
    expect(await res.json()).toEqual(HIT);
    const rpcs = chainsWith("rpc");
    expect(rpcs.map(c => c[0].args)).toEqual([["match_messages_chunked_checked", CHECKED()]]);
    expect(chainsWith("from")).toEqual([]);
  });

  test("Datenbank ohne Abschnitte (PGRST202 für match_messages_chunked_checked): match_messages_checked mit denselben Argumenten", async () => {
    answer = chain =>
      chain[0].args[0] === "match_messages_chunked_checked" ? { data: null, error: { code: "PGRST202", message: "fehlt" } } : chain[0].method === "rpc" ? { data: HIT, error: null } : { data: [], error: null };
    const res = await call("search-memory", { chat_id: "c1", query: "Notiz" });
    expect(await res.json()).toEqual(HIT);
    expect(chainsWith("rpc").map(c => c[0].args)).toEqual([
      ["match_messages_chunked_checked", CHECKED()],
      ["match_messages_checked", CHECKED()],
    ]);
  });

  test("mit facts: ein Embedding für Nachrichten und Fakten, Antwort mit beiden, Kennungen gehen an die Datenbank", async () => {
    answer = chain =>
      chain[0].args[0] === "match_facts_checked" ? { data: [{ id: 7, content: "Fakt" }], error: null } : chain[0].method === "rpc" ? { data: HIT, error: null } : { data: [], error: null };
    const res = await call("search-memory", { chat_id: "c1", query: "Notiz", facts: { limit: 3, exclude_ids: [1, "2"] } });
    expect(await res.json()).toEqual({ messages: HIT, facts: [{ id: 7, content: "Fakt" }] });
    expect(outbound.filter(o => o.url.includes("api.openai.com"))).toHaveLength(1);
    const factCall = chainsWith("rpc", "match_facts_checked")[0][0].args[1] as Record<string, unknown>;
    expect(factCall).toEqual({ p_provider: "openai", p_model: "text-embedding-3-small", query_embedding: vector, match_threshold: 0.4, match_count: 3, p_exclude_ids: ["1", "2"] });
  });

  test("mit facts, aber ohne die Migration: facts null, die Nachrichten bleiben", async () => {
    answer = chain =>
      chain[0].args[0] === "match_facts_checked" ? { data: null, error: { code: "PGRST202", message: "fehlt" } } : chain[0].method === "rpc" ? { data: HIT, error: null } : { data: [], error: null };
    const res = await call("search-memory", { chat_id: "c1", query: "Notiz", facts: { limit: 3 } });
    expect(await res.json()).toEqual({ messages: HIT, facts: null });
  });

  test("mit facts, aber ohne Vektor: keine Faktensuche, Textsuche für die Nachrichten", async () => {
    delete env.OPENAI_API_KEY;
    const res = await call("search-memory", { chat_id: "c1", query: "Notiz", facts: { limit: 3 } });
    expect(await res.json()).toEqual({ messages: [], facts: null });
    expect(chainsWith("rpc", "match_facts_checked")).toEqual([]);
  });

  test("ohne facts bleibt die Antwort die Liste und match_facts_checked ungefragt", async () => {
    answer = chain => (chain[0].method === "rpc" ? { data: HIT, error: null } : { data: [], error: null });
    const res = await call("search-memory", { chat_id: "c1", query: "Notiz" });
    expect(await res.json()).toEqual(HIT);
    expect(chainsWith("rpc", "match_facts_checked")).toEqual([]);
  });

  test("limit aus dem Rumpf geht an match_count", async () => {
    answer = chain => (chain[0].method === "rpc" ? { data: HIT, error: null } : { data: [], error: null });
    await call("search-memory", { chat_id: "c1", query: "Notiz", limit: 3 });
    expect((chainsWith("rpc")[0][0].args[1] as Record<string, unknown>).match_count).toBe(3);
  });

  test("Datenbank ohne match_messages_checked (PGRST202): match_messages wie vorher", async () => {
    answer = chain =>
      chain[0].args[0] === "match_messages_checked" || chain[0].args[0] === "match_messages_chunked_checked"
        ? { data: null, error: { code: "PGRST202", message: "fehlt" } }
        : chain[0].method === "rpc"
          ? { data: HIT, error: null }
          : { data: [], error: null };
    const res = await call("search-memory", { chat_id: "c1", query: "Notiz" });
    expect(await res.json()).toEqual(HIT);
    expect(chainsWith("rpc").map(c => c[0].args)).toEqual([
      ["match_messages_chunked_checked", CHECKED()],
      ["match_messages_checked", CHECKED()],
      ["match_messages", { query_embedding: vector, filter_chat_id: "c1", match_threshold: 0.5, match_count: 10 }],
    ]);
  });

  test("anderer Fehler der Vektorsuche: Textsuche statt Fehler", async () => {
    const rows = [{ id: 7, content: "Notiz von gestern" }];
    answer = chain => (chain[0].method === "rpc" ? { data: null, error: { code: "XX000", message: "kaputt" } } : { data: rows, error: null });
    const res = await call("search-memory", { chat_id: "c1", query: "Notiz" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(rows);
    expect(chainsWith("rpc")).toHaveLength(1);
  });

  test("kein semantischer Treffer: Textsuche mit Maske, Filter vor dem Limit, neueste zuerst", async () => {
    const rows = [{ id: 7, content: "50%_Rabatt" }];
    answer = chain => (chain[0].method === "rpc" ? { data: [], error: null } : { data: rows, error: null });
    const res = await call("search-memory", { chat_id: "c1", query: "50%_Rabatt", limit: 4 });
    expect(await res.json()).toEqual(rows);
    const [text] = chainsWith("from");
    expect(text).toEqual([
      { method: "from", args: ["messages"] },
      { method: "select", args: ["*"] },
      { method: "eq", args: ["chat_id", "c1"] },
      { method: "ilike", args: ["content", containsPattern("50%_Rabatt")] },
      { method: "or", args: [NOT_DISPLAY_ONLY_FILTER] },
      { method: "order", args: ["created_at", { ascending: false }] },
      { method: "limit", args: [4] },
    ]);
  });

  test("Textsuche ohne Daten (null): leere Liste", async () => {
    delete env.OPENAI_API_KEY;
    answer = () => ({ data: null, error: { message: "egal" } });
    const res = await call("search-memory", { chat_id: "c1", query: "Notiz" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("ohne Schlüssel: keine Vektorsuche, gleich die Textsuche", async () => {
    delete env.OPENAI_API_KEY;
    await call("search-memory", { chat_id: "c1", query: "Notiz" });
    expect(chainsWith("rpc")).toEqual([]);
    expect(chainsWith("from", "messages")).toHaveLength(1);
    expect(external()).toEqual([]);
  });

  test("Suchtext für das Embedding auf 8000 Zeichen gekürzt, Textsuche mit dem ganzen Text", async () => {
    const query = "q".repeat(8500);
    await call("search-memory", { chat_id: "c1", query });
    expect(external()[0].body.input).toBe("q".repeat(8000));
    expect(methodOf(chainsWith("from")[0], "ilike")!.args).toEqual(["content", containsPattern(query)]);
  });

  test("Anbieter nicht erreichbar: Textsuche", async () => {
    openai = () => {
      throw new TypeError("Unable to connect");
    };
    const rows = [{ id: 2 }];
    answer = () => ({ data: rows, error: null });
    const res = await call("search-memory", { chat_id: "c1", query: "Notiz" });
    expect(await res.json()).toEqual(rows);
    expect(chainsWith("rpc")).toEqual([]);
  });
});

// --- search-memory: Ausschnitte langer Nachrichten (Issue #479) --------------

describe("search-memory: Ausschnitte", () => {
  /** Rund 20.000 Zeichen, das Codewort weit hinten */
  const LONG = `${"Boote auf der Elbe. ".repeat(800)}Das Codewort heißt Zitronenfalter. ${"Boote auf der Elbe. ".repeat(200)}`;

  test("Abschnitt-Treffer und lange Nachricht: Ausschnitt um den Begriff mit excerpt, kurze unverändert", async () => {
    const hits = [
      { id: 2, content: LONG.slice(14_000, 20_000), chunk_index: 2, content_length: LONG.length, similarity: 0.6 },
      { id: 1, content: "kurz", chunk_index: null, content_length: 4, similarity: 0.55 },
    ];
    answer = chain => (chain[0].method === "rpc" ? { data: hits, error: null } : { data: [], error: null });
    const body = (await (await call("search-memory", { chat_id: "c1", query: "Zitronenfalter" })).json()) as Array<Record<string, unknown>>;
    expect(body[0].excerpt).toBe(true);
    expect(String(body[0].content)).toContain("Zitronenfalter");
    expect(String(body[0].content).length).toBeLessThanOrEqual(EXCERPT_CHARS + 2);
    expect(body[1]).toEqual(hits[1]);
  });

  test("Textsuche: lange Nachricht als Ausschnitt, nie der ganze Text", async () => {
    answer = chain => (chain[0].method === "rpc" ? { data: [], error: null } : { data: [{ id: 7, content: LONG }], error: null });
    const body = (await (await call("search-memory", { chat_id: "c1", query: "Zitronenfalter" })).json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0].excerpt).toBe(true);
    expect(String(body[0].content)).toContain("Zitronenfalter");
    expect(String(body[0].content).length).toBeLessThanOrEqual(EXCERPT_CHARS + 2);
  });
});

// --- store-telegram-message --------------------------------------------------

describe("store-telegram-message", () => {
  const rowOf = (chain: Chain) => methodOf(chain, "insert")!.args[0] as Record<string, unknown>;

  test("Erfolg: Antwortfelder vollständig, Zeile mit Vektor und Modellangabe", async () => {
    const res = await call("store-telegram-message", { chat_id: "c1", role: "user", content: "Hallo" });
    expect(await res.json()).toEqual({ ok: true, embedded: true, embedding_status: "ok", embedding_provider: "openai", embedding_model: "text-embedding-3-small" });
    const inserts = chainsWith("from", "messages");
    expect(inserts).toHaveLength(1);
    expect(rowOf(inserts[0])).toEqual({
      chat_id: "c1",
      role: "user",
      content: "Hallo",
      metadata: {},
      topic_id: null,
      session_key: "dm:c1",
      embedding: vector,
      embedding_model: "openai:text-embedding-3-small",
    });
  });

  test("Topic, Sitzung und Eingangszeit aus dem Rumpf", async () => {
    await call("store-telegram-message", {
      chat_id: "-100",
      role: "assistant",
      content: "Hallo",
      metadata: { topicId: 12, agent: "research" },
      created_at: "2026-09-24T11:50:02.500Z",
    });
    expect(rowOf(chainsWith("from", "messages")[0])).toMatchObject({
      chat_id: "-100",
      metadata: { topicId: 12, agent: "research" },
      topic_id: 12,
      session_key: "topic:-100:12",
      created_at: "2026-09-24T11:50:02.500Z",
    });
  });

  test("ohne Schlüssel: gespeichert ohne Vektor, kein-zugang, keine Anbieterangaben", async () => {
    delete env.OPENAI_API_KEY;
    const res = await call("store-telegram-message", { chat_id: "c1", role: "user", content: "Hallo" });
    expect(await res.json()).toEqual({ ok: true, embedded: false, embedding_status: "kein-zugang" });
    const row = rowOf(chainsWith("from", "messages")[0]);
    expect(row.embedding).toBeUndefined();
    expect(row.embedding_model).toBeUndefined();
  });

  test("Anbieter nicht erreichbar: gespeichert ohne Vektor, nicht-erreichbar", async () => {
    openai = () => {
      throw new TypeError("Unable to connect");
    };
    const res = await call("store-telegram-message", { chat_id: "c1", role: "user", content: "Hallo" });
    expect(await res.json()).toEqual({ ok: true, embedded: false, embedding_status: "nicht-erreichbar" });
    expect(chainsWith("from", "messages")).toHaveLength(1);
  });

  test("Fehler beim Einfügen: trotzdem HTTP 200, ok false mit Fehlertext, embedded false", async () => {
    answer = () => ({ data: null, error: { code: "23502", message: "null value" } });
    const res = await call("store-telegram-message", { chat_id: "c1", role: "user", content: "Hallo" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: false,
      error: "null value",
      embedded: false,
      embedding_status: "ok",
      embedding_provider: "openai",
      embedding_model: "text-embedding-3-small",
    });
    expect(chainsWith("from", "messages")).toHaveLength(1);
  });

  test("Spalte embedding_model fehlt (42703): zweiter Versuch mit Vektor, ohne Modellangabe", async () => {
    answer = chain => (rowOf(chain).embedding_model ? { data: null, error: { code: "42703", message: "fehlt" } } : { data: null, error: null });
    const res = await call("store-telegram-message", { chat_id: "c1", role: "user", content: "Hallo" });
    expect(await res.json()).toMatchObject({ ok: true, embedded: true });
    const rows = chainsWith("from", "messages").map(rowOf);
    expect(rows).toHaveLength(2);
    expect(rows[0].embedding_model).toBe("openai:text-embedding-3-small");
    expect(rows[1].embedding).toEqual(vector);
    expect("embedding_model" in rows[1]).toBe(false);
  });

  test("Inhalt fürs Embedding auf 8000 Zeichen gekürzt, gespeichert wird der ganze", async () => {
    const content = "c".repeat(8200);
    await call("store-telegram-message", { chat_id: "c1", role: "user", content });
    expect(external()[0].body.input).toBe("c".repeat(8000));
    expect(rowOf(chainsWith("from", "messages")[0]).content).toBe(content);
  });
});

// --- store-telegram-message: Abschnitte langer Nachrichten (Issue #479) -------

describe("store-telegram-message: Abschnitte", () => {
  /** Rund 13.000 Zeichen mit Wortgrenzen: mehrere Abschnitte */
  const LONG = Array.from({ length: 2600 }, (_, i) => `w${i % 10}xy`).join(" ");
  const PARTS = splitIntoChunks(LONG);
  const rowOf = (chain: Chain) => methodOf(chain, "insert")!.args[0] as Record<string, unknown>;
  const writes = () => chainsWith("rpc", "message_chunks_write");
  const runtime = globalThis as { EdgeRuntime?: unknown };
  /** Antworten: Einfügen liefert die ID 42, message_chunks_write das Ergebnis write */
  function database(write: () => Answer = () => ({ data: { ok: true, chunks: 3 }, error: null })) {
    answer = chain => {
      if (chain[0].method === "rpc" && chain[0].args[0] === "message_chunks_write") return write();
      if (chain[0].method === "from") return { data: { id: 42 }, error: null };
      return { data: [], error: null };
    };
  }

  test("kurze Nachricht: keine Abschnitte, kein Feld chunks, Einfügen mit select(id).single()", async () => {
    database();
    const res = await call("store-telegram-message", { chat_id: "c1", role: "user", content: "Hallo" });
    expect(await res.json()).not.toHaveProperty("chunks");
    expect(writes()).toHaveLength(0);
    const insert = chainsWith("from", "messages")[0];
    expect(methodOf(insert, "select")!.args).toEqual(["id"]);
    expect(methodOf(insert, "single")).toBeDefined();
  });

  test("ohne Laufzeit-API: Abschnitte vor der Antwort, je Abschnitt ein Embedding, ein message_chunks_write", async () => {
    database();
    const res = await call("store-telegram-message", { chat_id: "c1", role: "user", content: LONG });
    expect(await res.json()).toMatchObject({ ok: true, embedded: true, chunks: "ok" });
    expect(chainsWith("from", "messages")).toHaveLength(1);
    const [write] = writes();
    const args = write[0].args[1] as Record<string, any>;
    expect(args.p_message_id).toBe(42);
    expect(args.p_provider).toBe("openai");
    expect(args.p_model).toBe("text-embedding-3-small");
    expect(args.p_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(PARTS.length).toBeGreaterThan(1);
    expect(args.p_chunks.map((c: { chunk_index: number }) => c.chunk_index)).toEqual(PARTS.map((_, i) => i));
    expect(args.p_chunks.map((c: { content: string }) => c.content)).toEqual(PARTS);
    expect(args.p_chunks[0].embedding).toBe(JSON.stringify(vector));
    // Nachricht (gekürzt) und je Abschnitt ein Embedding
    const inputs = external().map(o => o.body.input as string);
    expect(inputs).toHaveLength(1 + PARTS.length);
    expect(inputs[0]).toBe(LONG.substring(0, 8000));
    expect(inputs.slice(1).sort()).toEqual(args.p_chunks.map((c: { content: string }) => c.content).sort());
  });

  test("mit EdgeRuntime.waitUntil: Antwort sofort mit chunks laeuft, Abschnitte danach", async () => {
    database();
    const taken: Promise<unknown>[] = [];
    runtime.EdgeRuntime = { waitUntil: (p: Promise<unknown>) => void taken.push(p) };
    try {
      const res = await call("store-telegram-message", { chat_id: "c1", role: "user", content: LONG });
      expect(await res.json()).toMatchObject({ ok: true, chunks: "laeuft" });
      expect(taken).toHaveLength(1);
      expect(await taken[0]).toBe("ok");
      expect(writes()).toHaveLength(1);
    } finally {
      delete runtime.EdgeRuntime;
    }
  });

  test("Migration 20261015 fehlt (PGRST202): Nachricht gespeichert, ok true, chunks fehlt", async () => {
    database(() => ({ data: null, error: { code: "PGRST202", message: "function not found" } }));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await call("store-telegram-message", { chat_id: "c1", role: "user", content: LONG });
      expect(await res.json()).toMatchObject({ ok: true, embedded: true, chunks: "fehlt" });
      expect(chainsWith("from", "messages")).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("Abschnitt ohne Embedding nach erfolgreichem Einfügen: ok true ohne error, kein zweites Einfügen, kein Schreiben", async () => {
    database();
    let n = 0;
    openai = () => (n++ === 0 ? new Response(JSON.stringify({ data: [{ embedding: vector }] })) : new Response("weg", { status: 400 }));
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await call("store-telegram-message", { chat_id: "c1", role: "user", content: LONG });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body).toMatchObject({ ok: true, embedded: true, chunks: "kein-embedding" });
      expect(body).not.toHaveProperty("error");
      expect(chainsWith("from", "messages")).toHaveLength(1);
      expect(writes()).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("Schreiben der Abschnitte wirft: ok true, chunks fehler, keine 500", async () => {
    database(() => {
      throw new Error("Verbindung weg");
    });
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const res = await call("store-telegram-message", { chat_id: "c1", role: "user", content: LONG });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, chunks: "fehler" });
      expect(chainsWith("from", "messages")).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  test("Nachricht ohne Embedding (kein Schlüssel) oder Einfügen gescheitert: keine Abschnitte", async () => {
    database();
    delete env.OPENAI_API_KEY;
    expect(await (await call("store-telegram-message", { chat_id: "c1", role: "user", content: LONG })).json()).not.toHaveProperty("chunks");
    env.OPENAI_API_KEY = "sk-attrappe";
    answer = () => ({ data: null, error: { code: "23502", message: "null value" } });
    expect(await (await call("store-telegram-message", { chat_id: "c1", role: "user", content: LONG })).json()).toMatchObject({ ok: false, error: "null value" });
    expect(writes()).toHaveLength(0);
    expect(rowOf(chainsWith("from", "messages")[0]).content).toBe(LONG);
  });
});
