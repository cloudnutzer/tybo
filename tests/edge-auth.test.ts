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

// createClient-Attrappe statt esm.sh: merkt sich URL und Schlüssel, jede Abfrage liefert leere Daten
const clients: { url: string; key: string }[] = [];
function fakeQuery(): unknown {
  const query: unknown = new Proxy(() => {}, {
    get: (_, prop) => (prop === "then" ? (resolve: (v: unknown) => void) => resolve({ data: [], error: null }) : () => query),
  });
  return query;
}
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
    outbound = [];
    // Nur OpenAI ist als Ziel denkbar; beantwortet von der Attrappe, jeder Aufruf gezählt
    fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
      outbound.push(String(input));
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
        expect(outbound.every(u => u.startsWith("https://api.openai.com/"))).toBe(true);
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

describe("Doku", () => {
  test("docs/troubleshooting.md nennt den Deploy mit --no-verify-jwt für jede Function", () => {
    const doc = readFileSync(join(import.meta.dir, "../docs/troubleshooting.md"), "utf8");
    expect(doc).toContain("### Semantische Suche fällt still auf Textsuche zurück");
    for (const name of functionNames()) expect(doc).toContain(`supabase functions deploy ${name} --no-verify-jwt`);
  });
});
