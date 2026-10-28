/**
 * Issue #320: gemeinsamer Rahmen der Edge Functions
 * (supabase/functions/_shared/handler.ts). Läuft direkt in Bun: Umgebung,
 * Client und fetch sind Attrappen, kein Deno, kein Netz.
 */
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import { CORS_HEADERS, edgeHandler, edgeRuntimeWaitUntil, jsonResponse, writeRowWithModelLabel, writeWithModelLabel, type EdgeFunction, type EdgeRequest } from "../supabase/functions/_shared/handler";
import { clearRegistryCache, type FetchLike } from "../supabase/functions/_shared/embedding";

const SECRET = "sb_secret_attrappe123";
const LEGACY = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.attrappe";
const URL_ = "https://attrappe.supabase.co";

let env: Record<string, string>;
let connects: { url: string; key: string }[];
let fetched: string[];
let seen: EdgeRequest<{ id: number }>[];
let fetchFn: FetchLike;

const vector = Array.from({ length: 1536 }, (_, i) => (i + 1) / 1536);

beforeEach(() => {
  clearRegistryCache();
  env = { SUPABASE_URL: URL_, SUPABASE_SECRET_KEYS: JSON.stringify({ default: SECRET }) };
  connects = [];
  fetched = [];
  seen = [];
  fetchFn = async (input, init) => {
    fetched.push(input);
    if (input.endsWith("/rpc/embedding_provider_status")) return new Response(JSON.stringify({ state: "leer", vectors: false }));
    if (input.endsWith("/rpc/claim_embedding_provider")) {
      const b = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ state: "festgehalten", provider: b.p_provider, model: b.p_model }));
    }
    return new Response(JSON.stringify({ data: [{ embedding: vector }] }));
  };
});

function make(run?: (r: EdgeRequest<{ id: number }>) => Promise<Response>, overrides: Partial<EdgeFunction<{ id: number }>> = {}) {
  return edgeHandler<{ id: number }>(
    {
      required: ["a", "b"],
      missingMessage: "Pflicht fehlt",
      failure: message => ({ ok: false, error: message }),
      run: run ?? (async r => {
        seen.push(r);
        return jsonResponse({ ok: true });
      }),
      ...overrides,
    },
    {
      env: name => env[name],
      connect: (url, key) => {
        connects.push({ url, key });
        return { id: connects.length };
      },
      fetch: (input, init) => fetchFn(input, init),
    },
  );
}

function req(init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Request {
  const method = init.method ?? "POST";
  return new Request("http://edge.test/functions/v1/x", {
    method,
    headers: init.headers ?? { apikey: SECRET },
    ...(method === "POST" ? { body: init.body ?? JSON.stringify({ a: 1, b: "x" }) } : {}),
  });
}

describe("Preflight", () => {
  test("OPTIONS: 200 ok mit CORS-Köpfen, vor der Schlüsselprüfung", async () => {
    env = {};
    const res = await make()(req({ method: "OPTIONS", headers: {} }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-headers")).toBe("authorization, x-client-info, apikey, content-type");
    expect(connects).toEqual([]);
    expect(fetched).toEqual([]);
    expect(seen).toEqual([]);
  });

  test("OPTIONS mit falschem Schlüssel: trotzdem Preflight", async () => {
    const res = await make()(req({ method: "OPTIONS", headers: { apikey: "falsch" } }));
    expect(res.status).toBe(200);
  });
});

describe("Schlüssel", () => {
  test("andere Methoden 405, falscher Schlüssel 401, ohne Schlüssel in der Umgebung 503", async () => {
    expect((await make()(req({ method: "GET" }))).status).toBe(405);
    expect((await make()(req({ headers: { apikey: "falsch" } }))).status).toBe(401);
    env = { SUPABASE_URL: URL_ };
    expect((await make()(req())).status).toBe(503);
    expect(seen).toEqual([]);
  });

  test("benannter Secret ohne default: Prüfung bestanden, aber kein Server-Schlüssel, 503 als Text", async () => {
    env = { SUPABASE_URL: URL_, SUPABASE_SECRET_KEYS: JSON.stringify({ backup: SECRET }) };
    const res = await make()(req());
    expect(res.status).toBe(503);
    expect(await res.text()).toBe("Not configured");
    expect(connects).toEqual([]);
  });

  test("Client mit SUPABASE_URL und default vor dem alten Schlüssel, erst beim ersten db(), danach derselbe", async () => {
    env.SUPABASE_SERVICE_ROLE_KEY = LEGACY;
    const res = await make(async r => {
      expect(connects).toEqual([]);
      const a = r.db();
      const b = r.db();
      expect(a).toBe(b);
      return jsonResponse({ ok: true });
    })(req());
    expect(res.status).toBe(200);
    expect(connects).toEqual([{ url: URL_, key: SECRET }]);
  });

  test("nur alter Schlüssel, per Bearer: der geht an den Client", async () => {
    env = { SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: LEGACY };
    await make(async r => {
      r.db();
      return jsonResponse({});
    })(req({ headers: { authorization: `Bearer ${LEGACY}` } }));
    expect(connects).toEqual([{ url: URL_, key: LEGACY }]);
  });
});

describe("Rumpf und Fehler", () => {
  test("Pflichtfelder fehlend oder leer: 400 in der Form der Function", async () => {
    for (const body of [{}, { a: 1 }, { a: "", b: "x" }, { a: 0, b: "x" }, { a: 1, b: null }, "text", 5, []]) {
      const res = await make()(req({ body: JSON.stringify(body) }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ ok: false, error: "Pflicht fehlt" });
    }
    expect(seen).toEqual([]);
  });

  test("ungültiges JSON und null-Rumpf: 500 mit dem Fehlertext", async () => {
    for (const body of ["{", "", "null"]) {
      const res = await make()(req({ body }));
      expect(res.status).toBe(500);
      const data = await res.json();
      expect(data.ok).toBe(false);
      expect(data.error.length).toBeGreaterThan(0);
    }
  });

  test("wirft die Function: 500 mit String(err), andere Fehlerform möglich", async () => {
    const res = await make(
      async () => {
        throw new Error("kaputt");
      },
      { failure: message => ({ error: message }) },
    )(req());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "Error: kaputt" });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  test("Rumpf kommt vollständig bei der Function an", async () => {
    await make()(req({ body: JSON.stringify({ a: 1, b: "x", c: { d: true } }) }));
    expect(seen[0].body).toEqual({ a: 1, b: "x", c: { d: true } });
  });
});

describe("embed", () => {
  test("Embedding über die Kennung der eigenen Datenbank mit dem Server-Schlüssel", async () => {
    env.OPENAI_API_KEY = "sk-attrappe";
    let result: unknown;
    await make(async r => {
      result = await r.embed("Hallo");
      return jsonResponse({});
    })(req());
    expect(result).toMatchObject({ ok: true, config: { provider: "openai", model: "text-embedding-3-small" } });
    expect(fetched).toEqual([`${URL_}/rest/v1/rpc/embedding_provider_status`, "https://api.openai.com/v1/embeddings", `${URL_}/rest/v1/rpc/claim_embedding_provider`]);
  });

  test("gesperrt: einmal gewarnt, beim zweiten Aufruf nicht wieder", async () => {
    env.OPENAI_API_KEY = "sk-attrappe";
    fetchFn = async input => {
      fetched.push(input);
      return new Response(JSON.stringify({ state: "festgehalten", provider: "gemini", model: "gemini-embedding-2" }));
    };
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const handler = make(async r => {
        const e = await r.embed("Hallo");
        return jsonResponse(e.ok ? {} : { reason: e.reason });
      });
      expect(await (await handler(req())).json()).toEqual({ reason: "gesperrt" });
      await handler(req());
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain("sk-attrappe");
    } finally {
      warn.mockRestore();
    }
  });
});

describe("background (Issue #479)", () => {
  /** Handler, dessen Function eine Aufgabe an background gibt und das Ergebnis meldet */
  function withBackground(waitUntil?: (task: Promise<unknown>) => boolean) {
    return edgeHandler<{ id: number }>(
      {
        required: [],
        missingMessage: "x",
        failure: message => ({ error: message }),
        run: async r => jsonResponse({ taken: r.background(Promise.resolve("fertig")) }),
      },
      { env: name => env[name], connect: () => ({ id: 1 }), fetch: (input, init) => fetchFn(input, init), ...(waitUntil ? { waitUntil } : {}) },
    );
  }

  test("ohne waitUntil der Laufzeit: false, der Aufrufer wartet selbst", async () => {
    expect(await (await withBackground()(req({ body: "{}" }))).json()).toEqual({ taken: false });
  });

  test("mit waitUntil: die Aufgabe geht an die Laufzeit, true", async () => {
    const tasks: Promise<unknown>[] = [];
    const res = await withBackground(task => (tasks.push(task), true))(req({ body: "{}" }));
    expect(await res.json()).toEqual({ taken: true });
    expect(tasks).toHaveLength(1);
    expect(await tasks[0]).toBe("fertig");
  });

  test("edgeRuntimeWaitUntil liest EdgeRuntime zur Zeit des Aufrufs", async () => {
    const g = globalThis as { EdgeRuntime?: unknown };
    const saved = g.EdgeRuntime;
    try {
      delete g.EdgeRuntime;
      expect(edgeRuntimeWaitUntil(Promise.resolve())).toBe(false);
      const taken: Promise<unknown>[] = [];
      g.EdgeRuntime = { waitUntil: (p: Promise<unknown>) => void taken.push(p) };
      expect(edgeRuntimeWaitUntil(Promise.resolve(1))).toBe(true);
      expect(taken).toHaveLength(1);
    } finally {
      if (saved === undefined) delete g.EdgeRuntime;
      else g.EdgeRuntime = saved;
    }
  });
});

describe("jsonResponse", () => {
  test("JSON mit Content-Type und CORS-Köpfen", async () => {
    const res = jsonResponse({ x: 1 }, 418);
    expect(res.status).toBe(418);
    expect(res.headers.get("content-type")).toBe("application/json");
    for (const [name, value] of Object.entries(CORS_HEADERS)) expect(res.headers.get(name)).toBe(value);
    expect(await res.json()).toEqual({ x: 1 });
  });
});

describe("writeWithModelLabel", () => {
  const ok = { data: null, error: null };
  test("ohne Fehler ein Versuch mit Angabe", async () => {
    const labels: (string | undefined)[] = [];
    expect(await writeWithModelLabel("openai:m", async l => (labels.push(l), ok))).toBeNull();
    expect(labels).toEqual(["openai:m"]);
  });

  test("Spalte fehlt: zweiter Versuch ohne Angabe, dessen Fehler zählt", async () => {
    for (const code of ["PGRST204", "42703"]) {
      const labels: (string | undefined)[] = [];
      const error = await writeWithModelLabel("openai:m", async l => {
        labels.push(l);
        return l ? { data: null, error: { code, message: "fehlt" } } : { data: null, error: { message: "zweiter" } };
      });
      expect(labels).toEqual(["openai:m", undefined]);
      expect(error).toEqual({ message: "zweiter" });
    }
  });

  test("anderer Fehler oder keine Angabe: kein zweiter Versuch", async () => {
    let calls = 0;
    expect(await writeWithModelLabel("openai:m", async () => (calls++, { data: null, error: { code: "42501", message: "rechte" } }))).toEqual({ code: "42501", message: "rechte" });
    expect(await writeWithModelLabel(undefined, async () => (calls++, { data: null, error: { code: "PGRST204", message: "fehlt" } }))).toEqual({ code: "PGRST204", message: "fehlt" });
    expect(calls).toBe(2);
  });
});

describe("writeRowWithModelLabel (Issue #479)", () => {
  test("liefert Daten und Fehler des zählenden Versuchs", async () => {
    expect(await writeRowWithModelLabel<{ id: number }>("openai:m", async () => ({ data: { id: 7 }, error: null }))).toEqual({ data: { id: 7 }, error: null });
    const labels: (string | undefined)[] = [];
    const second = await writeRowWithModelLabel<{ id: number }>("openai:m", async l => {
      labels.push(l);
      return l ? { data: null, error: { code: "PGRST204", message: "fehlt" } } : { data: { id: 8 }, error: null };
    });
    expect(labels).toEqual(["openai:m", undefined]);
    expect(second).toEqual({ data: { id: 8 }, error: null });
  });
});
