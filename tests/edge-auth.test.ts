/**
 * Issue #162: Edge Functions mit alten und neuen Supabase-Schlüsseln.
 * authorizeServer() läuft in Bun mit nachgebildetem Deno.env, adminKey()
 * wählt den Schlüssel für den Client, supabase/config.toml schaltet
 * verify_jwt für jede Function ab. Die drei Handler laufen mit nachgebildetem
 * Deno.serve/Deno.env und einer createClient-Attrappe. Kein echtes Supabase,
 * kein Netz.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { authorizeServer } from "../supabase/functions/_shared/auth";
import { adminKey, secretKeys, type EnvReader } from "../supabase/functions/_shared/admin-key";
import { clearRegistryCache } from "../supabase/functions/_shared/embedding";

// Erfundene Werte in der Form der echten Schlüssel
const SECRET = "sb_secret_attrappe123";
const SECRET_2 = "sb_secret_attrappe789";
const PUBLISHABLE = "sb_publishable_attrappe456";
const LEGACY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.attrappe";
const ANON = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.attrappe";

const FUNCTIONS_DIR = join(import.meta.dir, "../supabase/functions");

let env: Record<string, string>;
const g = globalThis as { Deno?: unknown };
let savedDeno: unknown;

beforeEach(() => {
  env = {};
  savedDeno = g.Deno;
  g.Deno = { env: { get: (name: string) => env[name] } };
});

afterEach(() => {
  if (savedDeno === undefined) delete g.Deno;
  else g.Deno = savedDeno;
});

function post(headers: Record<string, string> = {}, method = "POST"): Request {
  return new Request("http://edge.test/functions/v1/search-memory", { method, headers });
}

const status = (req: Request) => authorizeServer(req)?.status ?? 200;

describe("authorizeServer", () => {
  test("passender apikey aus SUPABASE_SECRET_KEYS ist erlaubt, ohne Authorization", () => {
    env.SUPABASE_SECRET_KEYS = JSON.stringify({ default: SECRET });
    expect(status(post({ apikey: SECRET }))).toBe(200);
  });

  test("jeder benannte Secret-Schlüssel ist erlaubt", () => {
    env.SUPABASE_SECRET_KEYS = JSON.stringify({ default: SECRET, backup: SECRET_2 });
    expect(status(post({ apikey: SECRET }))).toBe(200);
    expect(status(post({ apikey: SECRET_2 }))).toBe(200);
  });

  test("passender alter Bearer ist erlaubt", () => {
    env.SUPABASE_SERVICE_ROLE_KEY = LEGACY;
    expect(status(post({ authorization: `Bearer ${LEGACY}` }))).toBe(200);
    expect(status(post({ apikey: LEGACY, authorization: `Bearer ${LEGACY}` }))).toBe(200);
  });

  test("beide Schlüsselarten gleichzeitig in der Umgebung: beide Wege erlaubt", () => {
    env.SUPABASE_SECRET_KEYS = JSON.stringify({ default: SECRET });
    env.SUPABASE_SERVICE_ROLE_KEY = LEGACY;
    expect(status(post({ apikey: SECRET }))).toBe(200);
    expect(status(post({ authorization: `Bearer ${LEGACY}` }))).toBe(200);
  });

  test("alles andere ist 401", () => {
    env.SUPABASE_SECRET_KEYS = JSON.stringify({ default: SECRET });
    env.SUPABASE_SERVICE_ROLE_KEY = LEGACY;
    for (const headers of [
      {},
      { apikey: PUBLISHABLE },
      { apikey: ANON, authorization: `Bearer ${ANON}` },
      { authorization: `Bearer ${PUBLISHABLE}` },
      { authorization: `Bearer ${SECRET}` }, // neuer Schlüssel gilt nur als apikey
      { apikey: LEGACY }, // alter nur als Bearer
      { apikey: SECRET.slice(0, -1) },
      { apikey: `${SECRET}x` },
      { authorization: LEGACY },
    ]) {
      expect(status(post(headers))).toBe(401);
    }
  });

  test("andere Methoden bleiben 405", () => {
    env.SUPABASE_SECRET_KEYS = JSON.stringify({ default: SECRET });
    expect(status(post({ apikey: SECRET }, "GET"))).toBe(405);
    expect(status(post({}, "OPTIONS"))).toBe(405);
  });

  test("ohne beide Umgebungswerte 503", () => {
    expect(status(post({ apikey: SECRET }))).toBe(503);
    expect(status(post({ authorization: "Bearer " }))).toBe(503);
  });

  test("ungültige oder leere Werte geben nie frei", () => {
    for (const raw of ["kein json", "[]", "null", '"sb_secret_x"', JSON.stringify({ default: "" }), JSON.stringify({ default: 42, other: null })]) {
      env = { SUPABASE_SECRET_KEYS: raw };
      expect(status(post({ apikey: "" }))).toBe(503);
      expect(status(post({ apikey: SECRET }))).toBe(503);
    }
    env = { SUPABASE_SERVICE_ROLE_KEY: "" };
    expect(status(post({ authorization: "Bearer " }))).toBe(503);
    env = { SUPABASE_SECRET_KEYS: JSON.stringify({ default: "" }), SUPABASE_SERVICE_ROLE_KEY: LEGACY };
    expect(status(post({ apikey: "" }))).toBe(401);
  });
});

describe("adminKey", () => {
  const reader = (values: Record<string, string>): EnvReader => (name) => values[name];

  test("SUPABASE_SECRET_KEYS.default vor dem alten Schlüssel", () => {
    expect(adminKey(reader({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }), SUPABASE_SERVICE_ROLE_KEY: LEGACY }))).toBe(SECRET);
  });

  test("ohne default der alte Schlüssel", () => {
    expect(adminKey(reader({ SUPABASE_SERVICE_ROLE_KEY: LEGACY }))).toBe(LEGACY);
    expect(adminKey(reader({ SUPABASE_SECRET_KEYS: JSON.stringify({ backup: SECRET_2 }), SUPABASE_SERVICE_ROLE_KEY: LEGACY }))).toBe(LEGACY);
    expect(adminKey(reader({ SUPABASE_SECRET_KEYS: "kaputt", SUPABASE_SERVICE_ROLE_KEY: LEGACY }))).toBe(LEGACY);
  });

  test("fehlendes default ohne alten Schlüssel, ungültige und leere Werte: null", () => {
    expect(adminKey(reader({}))).toBeNull();
    expect(adminKey(reader({ SUPABASE_SECRET_KEYS: JSON.stringify({ backup: SECRET_2 }) }))).toBeNull();
    expect(adminKey(reader({ SUPABASE_SECRET_KEYS: "{" }))).toBeNull();
    expect(adminKey(reader({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: "  " }), SUPABASE_SERVICE_ROLE_KEY: "" }))).toBeNull();
    expect(adminKey(reader({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: 1 }) }))).toBeNull();
  });

  test("secretKeys nimmt nur nicht-leere Zeichenketten", () => {
    expect(secretKeys(reader({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET, leer: "", zahl: 3, obj: {} }) }))).toEqual({ default: SECRET });
  });
});

/** Alle Functions außer _shared */
function functionNames(): string[] {
  return readdirSync(FUNCTIONS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && d.name !== "_shared")
    .map(d => d.name)
    .sort();
}

describe("Functions", () => {
  test("es gibt die bekannten Functions (sonst prüfen die Tests unten nichts)", () => {
    expect(functionNames()).toEqual(expect.arrayContaining(["embed-knowledge", "search-memory", "store-telegram-message"]));
  });

  test("supabase/config.toml setzt verify_jwt = false für jede Function", () => {
    const config = Bun.TOML.parse(readFileSync(join(FUNCTIONS_DIR, "../config.toml"), "utf8")) as {
      functions?: Record<string, { verify_jwt?: unknown }>;
    };
    for (const name of functionNames()) expect(config.functions?.[name]?.verify_jwt).toBe(false);
  });

  test("jede Function prüft mit authorizeServer, baut ihren Client mit adminKey und nennt --no-verify-jwt", () => {
    for (const name of functionNames()) {
      const source = readFileSync(join(FUNCTIONS_DIR, name, "index.ts"), "utf8");
      expect(source).toContain("authorizeServer(req)");
      expect(source).toContain("adminKey(");
      expect(source).toContain("createClient(Deno.env.get(\"SUPABASE_URL\")!, serviceKey)");
      expect(source).not.toContain('Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")');
      expect(source).toContain(`supabase functions deploy ${name} --no-verify-jwt`);
    }
  });
});

// createClient-Attrappe statt esm.sh: merkt sich URL und Schlüssel, jede Abfrage liefert leere Daten.
// queries: jeder Aufruf mit Argumenten (insert, update, rpc …), um Vektoren in Schreib- und Suchaufrufen zu finden
const clients: { url: string; key: string }[] = [];
const queries: Array<{ method: string; args: unknown[] }> = [];
function fakeQuery(): unknown {
  const query: unknown = new Proxy(() => {}, {
    get: (_, prop) =>
      prop === "then"
        ? (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
        : (...args: unknown[]) => {
            queries.push({ method: String(prop), args });
            return query;
          },
  });
  return query;
}
/** Enthält ein Aufruf an die Datenbank einen Vektor (embedding bzw. query_embedding mit Werten)? */
const vectorQueries = () =>
  queries.filter(q => q.args.some(a => a !== null && typeof a === "object" && ["embedding", "query_embedding"].some(k => Array.isArray((a as Record<string, unknown>)[k]))));
mock.module("https://esm.sh/@supabase/supabase-js@2.116.0", () => ({
  createClient: (url: string, key: string) => {
    clients.push({ url, key });
    return fakeQuery();
  },
}));

const HANDLER_BODIES: Record<string, unknown> = {
  "embed-knowledge": { knowledge_id: "k1", text: "Notiz" },
  "search-memory": { chat_id: "c1", query: "Notiz" },
  "store-telegram-message": { chat_id: "c1", role: "user", content: "Hallo" },
};
const handlers: Record<string, (req: Request) => Promise<Response>> = {};

/** Lädt die Function einmal; Deno.serve der Attrappe merkt sich den Handler */
async function handler(name: string): Promise<(req: Request) => Promise<Response>> {
  if (!handlers[name]) {
    (g.Deno as Record<string, unknown>).serve = (h: (req: Request) => Promise<Response>) => {
      handlers[name] = h;
    };
    await import(join(FUNCTIONS_DIR, name, "index.ts"));
  }
  return handlers[name];
}

describe("Function-Handler", () => {
  let outbound: string[];
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    clients.length = 0;
    clearRegistryCache();
    outbound = [];
    // Nur OpenAI ist als Ziel denkbar; beantwortet von der Attrappe, jeder Aufruf gezählt.
    // Die Anbieterkennung der Datenbank ist leer (Issue #167)
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      outbound.push(String(input));
      if (String(input).endsWith("/rpc/claim_embedding_provider")) {
        const body = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ state: "festgehalten", provider: body.p_provider, model: body.p_model }), { status: 200 });
      }
      if (String(input).includes("/rest/v1/rpc/")) return new Response(JSON.stringify({ state: "leer", vectors: false }), { status: 200 });
      return new Response(JSON.stringify({ data: [{ embedding: [0.1, 0.2] }] }), { status: 200 });
    }) as typeof fetch);
  });

  afterEach(() => fetchSpy.mockRestore());

  const call = async (name: string, headers: Record<string, string>) =>
    (await handler(name))(
      new Request(`http://edge.test/functions/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(HANDLER_BODIES[name]),
      }),
    );

  test("es gibt für jede Function einen Testaufruf", () => {
    expect(Object.keys(HANDLER_BODIES).sort()).toEqual(functionNames());
  });

  for (const name of Object.keys(HANDLER_BODIES)) {
    describe(name, () => {
      test("SUPABASE_SECRET_KEYS.default geht an createClient, auch wenn der alte Schlüssel da ist", async () => {
        env = {
          SUPABASE_URL: "https://attrappe.supabase.co",
          SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }),
          SUPABASE_SERVICE_ROLE_KEY: LEGACY,
          OPENAI_API_KEY: "sk-attrappe",
        };
        const res = await call(name, { apikey: SECRET });
        expect(res.status).toBe(200);
        expect(clients).toEqual([{ url: "https://attrappe.supabase.co", key: SECRET }]);
        // Außer der Anbieterkennung der eigenen Datenbank (#167) nur OpenAI
        expect(outbound.filter(u => !u.startsWith("https://attrappe.supabase.co/")).every(u => u.startsWith("https://api.openai.com/"))).toBe(true);
      });

      test("nur alter Schlüssel: der geht an createClient", async () => {
        env = { SUPABASE_URL: "https://attrappe.supabase.co", SUPABASE_SERVICE_ROLE_KEY: LEGACY, OPENAI_API_KEY: "sk-attrappe" };
        const res = await call(name, { authorization: `Bearer ${LEGACY}` });
        expect(res.status).toBe(200);
        expect(clients).toEqual([{ url: "https://attrappe.supabase.co", key: LEGACY }]);
      });

      test("nur benannte Secrets ohne default und ohne Legacy: 503, kein Client, kein externer Aufruf", async () => {
        env = {
          SUPABASE_URL: "https://attrappe.supabase.co",
          SUPABASE_SECRET_KEYS: JSON.stringify({ backup: SECRET_2 }),
          OPENAI_API_KEY: "sk-attrappe",
        };
        const res = await call(name, { apikey: SECRET_2 });
        expect(res.status).toBe(503);
        expect(clients).toEqual([]);
        expect(outbound).toEqual([]);
      });

      test("falscher Schlüssel: 401, kein Client, kein externer Aufruf", async () => {
        env = { SUPABASE_URL: "https://attrappe.supabase.co", SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }), OPENAI_API_KEY: "sk-attrappe" };
        const res = await call(name, { apikey: PUBLISHABLE });
        expect(res.status).toBe(401);
        expect(clients).toEqual([]);
        expect(outbound).toEqual([]);
      });
    });
  }
});

// Issue #167: die Functions holen ihr Embedding über _shared/embedding.ts
describe("Embeddings in den Functions (#167)", () => {
  interface Outbound {
    url: string;
    headers: Record<string, string>;
    body: any;
  }
  let sent: Outbound[];
  let fetchSpy: ReturnType<typeof spyOn>;
  let vector: number[];

  /** Anbieterkennung der Datenbank: null = leer (das erste Embedding hält fest) */
  let stored: null | { provider: string; model: string };

  beforeEach(() => {
    clients.length = 0;
    queries.length = 0;
    clearRegistryCache();
    stored = null;
    sent = [];
    vector = Array.from({ length: 1536 }, (_, i) => (i + 1) / 1536);
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url === "https://attrappe.supabase.co/rest/v1/rpc/embedding_provider_status") {
        return new Response(JSON.stringify(stored ? { state: "festgehalten", ...stored } : { state: "leer", vectors: false }), { status: 200 });
      }
      if (url === "https://attrappe.supabase.co/rest/v1/rpc/claim_embedding_provider") {
        const body = JSON.parse(String(init?.body));
        stored ??= { provider: body.p_provider, model: body.p_model };
        return new Response(JSON.stringify({ state: "festgehalten", ...stored }), { status: 200 });
      }
      if (url.startsWith("https://api.openai.com/")) return new Response(JSON.stringify({ data: [{ embedding: vector }] }), { status: 200 });
      if (url.startsWith("https://generativelanguage.googleapis.com/")) return new Response(JSON.stringify({ embedding: { values: vector } }), { status: 200 });
      if (url.includes("/api/embed")) return new Response(JSON.stringify({ embeddings: [vector.slice(0, 768)] }), { status: 200 });
      return new Response("unerwartet", { status: 500 });
    }) as typeof fetch);
  });

  afterEach(() => fetchSpy.mockRestore());

  const base = { SUPABASE_URL: "https://attrappe.supabase.co", SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }) };
  const INPUT: Record<string, string> = { "embed-knowledge": "Notiz", "search-memory": "Notiz", "store-telegram-message": "Hallo" };
  const run = async (name: string) =>
    (await handler(name))(
      new Request(`http://edge.test/functions/v1/${name}`, {
        method: "POST",
        headers: { "content-type": "application/json", apikey: SECRET },
        body: JSON.stringify(HANDLER_BODIES[name]),
      }),
    );
  const external = () => sent.filter(s => !s.url.startsWith("https://attrappe.supabase.co/"));

  for (const name of Object.keys(HANDLER_BODIES)) {
    describe(name, () => {
      test("ohne EMBEDDING_PROVIDER genau der OpenAI-Aufruf von vorher", async () => {
        env = { ...base, OPENAI_API_KEY: "sk-attrappe-openai" };
        expect((await run(name)).status).toBe(200);
        expect(external()).toEqual([
          {
            url: "https://api.openai.com/v1/embeddings",
            headers: { Authorization: "Bearer sk-attrappe-openai", "Content-Type": "application/json" },
            body: { model: "text-embedding-3-small", input: INPUT[name] },
          },
        ]);
      });

      test("ohne Schlüssel kein externer Aufruf (wie vorher)", async () => {
        env = { ...base };
        expect((await run(name)).status).toBe(200);
        expect(external()).toEqual([]);
      });

      test("EMBEDDING_PROVIDER=gemini: Google mit 1536 Werten, kein OpenAI", async () => {
        env = { ...base, EMBEDDING_PROVIDER: "gemini", GEMINI_API_KEY: "AIza-attrappe", OPENAI_API_KEY: "sk-attrappe-openai" };
        expect((await run(name)).status).toBe(200);
        expect(external().map(s => s.url)).toEqual(["https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent"]);
        expect(external()[0].body.outputDimensionality).toBe(1536);
      });

      test("EMBEDDING_PROVIDER=ollama: OLLAMA_URL aus der Umgebung der Function", async () => {
        env = { ...base, EMBEDDING_PROVIDER: "ollama", OLLAMA_URL: "http://host.docker.internal:11434" };
        expect((await run(name)).status).toBe(200);
        expect(external().map(s => s.url)).toEqual(["http://host.docker.internal:11434/api/embed"]);
      });
    });
  }

  test("Kennung: erst lesen, nach dem gelungenen Embedding festhalten, an der eigenen Datenbank mit dem Server-Schlüssel", async () => {
    env = { ...base, EMBEDDING_PROVIDER: "gemini", GEMINI_API_KEY: "AIza-attrappe" };
    await run("store-telegram-message");
    expect(sent.map(s => s.url)).toEqual([
      "https://attrappe.supabase.co/rest/v1/rpc/embedding_provider_status",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
      "https://attrappe.supabase.co/rest/v1/rpc/claim_embedding_provider",
    ]);
    const claim = sent[2];
    expect(claim.headers.apikey).toBe(SECRET);
    expect(claim.body).toEqual({ p_provider: "gemini", p_model: "gemini-embedding-2" });
    expect(stored).toEqual({ provider: "gemini", model: "gemini-embedding-2" });
  });

  test("Embedding scheitert (Ollama nicht erreichbar): nichts festgehalten, ein anderer Anbieter bleibt möglich", async () => {
    fetchSpy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push({ url, headers: {}, body: undefined });
      if (url.endsWith("/rpc/embedding_provider_status")) return new Response(JSON.stringify({ state: "leer", vectors: false }));
      throw new TypeError("Unable to connect");
    }) as typeof fetch);
    env = { ...base, EMBEDDING_PROVIDER: "ollama", OLLAMA_URL: "http://host.docker.internal:11434" };
    expect(await (await run("store-telegram-message")).json()).toMatchObject({ ok: true, embedded: false, embedding_status: "nicht-erreichbar" });
    expect(sent.some(s => s.url.endsWith("/rpc/claim_embedding_provider"))).toBe(false);
    expect(stored).toBeNull();
  });

  for (const name of Object.keys(HANDLER_BODIES)) {
    test(`${name}: Anbieter passt nicht zur Datenbank, kein Embedding, kein Aufruf beim Anbieter, einmal gewarnt`, async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        stored = { provider: "gemini", model: "gemini-embedding-2" };
        env = { ...base, OPENAI_API_KEY: "sk-attrappe-openai" };
        const res = await run(name);
        expect(res.status).toBe(200);
        expect(external()).toEqual([]);
        await run(name);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls.flat().join(" ")).not.toContain("sk-attrappe-openai");
      } finally {
        warn.mockRestore();
      }
    });
  }

  // Anbieterkennung nicht lesbar bzw. Festhalten gescheitert: auch OpenAI (Verhalten vor #167) bekommt keinen Vektor
  const registryDown = (status: number | "netz", only?: "claim") =>
    fetchSpy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      sent.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const hit = only === "claim" ? url.endsWith("/rpc/claim_embedding_provider") : url.includes("/rest/v1/rpc/");
      if (hit) {
        if (status === "netz") throw new TypeError("Unable to connect");
        return new Response("boom", { status });
      }
      if (url.endsWith("/rpc/embedding_provider_status")) return new Response(JSON.stringify({ state: "leer", vectors: false }));
      if (url.startsWith("https://api.openai.com/")) return new Response(JSON.stringify({ data: [{ embedding: vector }] }));
      return new Response("unerwartet", { status: 500 });
    }) as typeof fetch);

  for (const name of Object.keys(HANDLER_BODIES)) {
    for (const status of [503, 401, "netz"] as const) {
      test(`${name}: Kennung nicht lesbar (${status}): kein Vektor geschrieben oder gesucht, OpenAI nicht gefragt`, async () => {
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        try {
          registryDown(status);
          env = { ...base, OPENAI_API_KEY: "sk-attrappe-openai" };
          const res = await run(name);
          expect(res.status).toBe(200);
          expect(external()).toEqual([]);
          expect(vectorQueries()).toEqual([]);
          if (name === "store-telegram-message") expect(await res.json()).toMatchObject({ ok: true, embedded: false, embedding_status: "gesperrt" });
        } finally {
          warn.mockRestore();
        }
      });
    }

    test(`${name}: Festhalten scheitert (503): der Vektor wird verworfen, nichts geschrieben oder gesucht`, async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        registryDown(503, "claim");
        env = { ...base, OPENAI_API_KEY: "sk-attrappe-openai" };
        const res = await run(name);
        expect(res.status).toBe(200);
        // Das Embedding wurde gerechnet, aber nicht verwendet
        expect(external().map(s => s.url)).toEqual(["https://api.openai.com/v1/embeddings"]);
        expect(vectorQueries()).toEqual([]);
        if (name === "store-telegram-message") expect(await res.json()).toMatchObject({ ok: true, embedded: false, embedding_status: "gesperrt" });
      } finally {
        warn.mockRestore();
      }
    });
  }

  // Festhalten antwortet nicht mit einer bestätigten Festlegung: der Vektor wird verworfen
  const claimAnswers: Array<[string, () => Response]> = [
    ["Funktion unbekannt (404 PGRST202)", () => new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 })],
    ["leer", () => new Response(JSON.stringify({ state: "leer", vectors: false }))],
    ["leer ohne vectors", () => new Response(JSON.stringify({ state: "leer" }))],
  ];
  for (const name of Object.keys(HANDLER_BODIES)) {
    for (const [label, answer] of claimAnswers) {
      test(`${name}: Festhalten ${label}: nichts geschrieben oder gesucht`, async () => {
        const warn = spyOn(console, "warn").mockImplementation(() => {});
        try {
          fetchSpy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            sent.push({ url, headers: {}, body: undefined });
            if (url.endsWith("/rpc/claim_embedding_provider")) return answer();
            if (url.endsWith("/rpc/embedding_provider_status")) return new Response(JSON.stringify({ state: "leer", vectors: false }));
            if (url.startsWith("https://api.openai.com/")) return new Response(JSON.stringify({ data: [{ embedding: vector }] }));
            return new Response("unerwartet", { status: 500 });
          }) as typeof fetch);
          env = { ...base, OPENAI_API_KEY: "sk-attrappe-openai" };
          const res = await run(name);
          expect(res.status).toBe(200);
          expect(vectorQueries()).toEqual([]);
          if (name === "store-telegram-message") expect(await res.json()).toMatchObject({ ok: true, embedded: false, embedding_status: "gesperrt" });
          // Auch der nächste Aufruf bekommt keinen Vektor
          await run(name);
          expect(vectorQueries()).toEqual([]);
        } finally {
          warn.mockRestore();
        }
      });
    }
  }

  test("Migration fehlt, danach eingespielt und auf Gemini festgelegt: keine OpenAI-Vektoren mehr beim Schreiben und Suchen", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      let missing = true;
      const registry = fetchSpy.getMockImplementation()!;
      fetchSpy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
        if (missing && String(input).includes("/rest/v1/rpc/")) {
          sent.push({ url: String(input), headers: {}, body: undefined });
          return new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 });
        }
        return registry(input, init);
      }) as typeof fetch);
      env = { ...base, OPENAI_API_KEY: "sk-attrappe-openai" };
      // Suche ohne Migration: altes Verhalten, Suchvektor von OpenAI
      await run("search-memory");
      expect(vectorQueries()).toHaveLength(1);
      expect(external()).toHaveLength(1);
      missing = false;
      stored = { provider: "gemini", model: "gemini-embedding-2" };
      queries.length = 0;
      for (const name of Object.keys(HANDLER_BODIES)) await run(name);
      expect(vectorQueries()).toEqual([]);
      expect(external()).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  for (const name of Object.keys(HANDLER_BODIES)) {
    test(`${name}: laufende OpenAI-Anfrage, währenddessen Migration eingespielt und Gemini festgelegt: kein OpenAI-Vektor in insert, update oder match_messages`, async () => {
      const warn = spyOn(console, "warn").mockImplementation(() => {});
      try {
        let missing = true;
        const registry = fetchSpy.getMockImplementation()!;
        fetchSpy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (missing && url.includes("/rest/v1/rpc/")) {
            sent.push({ url, headers: {}, body: undefined });
            return new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 });
          }
          if (url.startsWith("https://api.openai.com/")) {
            // Die Anbieterantwort gezielt verzögern; inzwischen Migration und Gemini-Festlegung
            await new Promise(r => setTimeout(r, 5));
            missing = false;
            stored = { provider: "gemini", model: "gemini-embedding-2" };
          }
          return registry(input, init);
        }) as typeof fetch);
        env = { ...base, OPENAI_API_KEY: "sk-attrappe-openai" };
        const res = await run(name);
        expect(res.status).toBe(200);
        expect(external().map(s => s.url)).toEqual(["https://api.openai.com/v1/embeddings"]);
        expect(vectorQueries()).toEqual([]);
        expect(stored).toEqual({ provider: "gemini", model: "gemini-embedding-2" });
        if (name === "store-telegram-message") expect(await res.json()).toMatchObject({ ok: true, embedded: false, embedding_status: "gesperrt" });
      } finally {
        warn.mockRestore();
      }
    });
  }

  test("Gegenprobe: mit lesbarer Kennung landet der Vektor im Schreib- bzw. Suchaufruf", async () => {
    env = { ...base, OPENAI_API_KEY: "sk-attrappe-openai" };
    for (const name of Object.keys(HANDLER_BODIES)) {
      queries.length = 0;
      await run(name);
      expect(vectorQueries().length).toBe(1);
    }
  });

  test("store-telegram-message meldet Anbieter und Modell des Vektors, ohne Vektor keine", async () => {
    env = { ...base, EMBEDDING_PROVIDER: "gemini", GEMINI_API_KEY: "AIza-attrappe" };
    expect(await (await run("store-telegram-message")).json()).toMatchObject({ embedded: true, embedding_provider: "gemini", embedding_model: "gemini-embedding-2" });
    env = { ...base };
    const none = await (await run("store-telegram-message")).json();
    expect(none.embedding_provider).toBeUndefined();
    expect(none.embedding_model).toBeUndefined();
  });

  test("store-telegram-message: gesperrt wird als Kurzgrund gemeldet", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    stored = { provider: "ollama", model: "bge-m3" };
    env = { ...base, OPENAI_API_KEY: "sk-attrappe-openai" };
    expect(await (await run("store-telegram-message")).json()).toMatchObject({ ok: true, embedded: false, embedding_status: "gesperrt" });
    warn.mockRestore();
  });

  test("store-telegram-message meldet embedded und einen festen Kurzgrund, ohne Schlüssel", async () => {
    env = { ...base, OPENAI_API_KEY: "sk-attrappe-openai" };
    expect(await (await run("store-telegram-message")).json()).toMatchObject({ ok: true, embedded: true, embedding_status: "ok" });
    env = { ...base };
    expect(await (await run("store-telegram-message")).json()).toMatchObject({ ok: true, embedded: false, embedding_status: "kein-zugang" });
  });

  test("embed-knowledge: Anbieter lehnt ab, die Antwort nennt weder Schlüssel noch Antworttext", async () => {
    const registry = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).startsWith("https://api.openai.com/")
        ? new Response(JSON.stringify({ error: { message: "Incorrect API key provided: sk-attrappe-openai" } }), { status: 401 })
        : registry(input, init)) as typeof fetch);
    env = { ...base, OPENAI_API_KEY: "sk-attrappe-openai" };
    const res = await run("embed-knowledge");
    expect(res.status).toBe(502);
    const text = await res.text();
    expect(text).not.toContain("sk-attrappe-openai");
    expect(text).not.toContain("Incorrect");
  });
});

describe("Doku", () => {
  test("docs/troubleshooting.md nennt den Deploy mit --no-verify-jwt für jede Function", () => {
    const doc = readFileSync(join(import.meta.dir, "../docs/troubleshooting.md"), "utf8");
    expect(doc).toContain("### Semantische Suche fällt still auf Textsuche zurück");
    for (const name of functionNames()) expect(doc).toContain(`supabase functions deploy ${name} --no-verify-jwt`);
  });
});
