/**
 * Issue #162, Schritt 3: Einrichtung mit neuen Supabase-Schlüsseln. Ein
 * sb_publishable_… im Feld für den schreibenden Schlüssel wird abgelehnt
 * (Meldung ohne Wert), ein sb_secret_… angenommen. supabaseQuery(),
 * setup/test-supabase.ts (Lesen, Insert, Cleanup) und setup/verify.ts senden
 * neue Schlüssel nur als apikey, auch den sb_publishable_ aus SUPABASE_ANON_KEY.
 * Netz ist eine Attrappe, die echte .env wird nie gelesen.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { HttpFetch, HttpRequest } from "../src/setup/context";
import { createProviders } from "../src/setup/providers";
import { databaseStep, DATABASE_FIELDS } from "../src/setup/steps/database";
import { validateValues } from "../src/setup/model";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanup, FAKE, fakeRun, makeCtx, root } from "./setup-fixture";

afterAll(cleanup);

// Erfundene Werte in der Form der echten Schlüssel
const SECRET = "sb_secret_attrappe123geheim";
const PUBLISHABLE = "sb_publishable_attrappe456geheim";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.attrappe";

describe("Prüfregel schreibender Schlüssel", () => {
  const supabase = { DB_BACKEND: "supabase", SUPABASE_URL: FAKE.supabaseUrl };

  test("sb_publishable_ wird abgelehnt, Meldung erklärt und nennt den Wert nicht", async () => {
    const ctx = await makeCtx();
    const result = await databaseStep.test!({ ...supabase, SUPABASE_SERVICE_ROLE_KEY: PUBLISHABLE }, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Publishable");
    expect(result.message).toContain("sb_secret_");
    expect(result.message).not.toContain(PUBLISHABLE);
    expect(ctx.providers.calls).toEqual([]);
    // Auch mit Leerzeichen drumherum
    const errors = validateValues(DATABASE_FIELDS, { ...supabase, SUPABASE_SERVICE_ROLE_KEY: ` ${PUBLISHABLE} ` }, {});
    expect(errors.SUPABASE_SERVICE_ROLE_KEY).toBeDefined();
    expect(errors.SUPABASE_SERVICE_ROLE_KEY).not.toContain(PUBLISHABLE);
  });

  test("sb_publishable_ wird nicht geschrieben", async () => {
    const ctx = await makeCtx();
    const result = await databaseStep.apply!({ ...supabase, SUPABASE_SERVICE_ROLE_KEY: PUBLISHABLE }, ctx);
    expect(result.ok).toBe(false);
    expect(result.changed).toEqual([]);
  });

  test("sb_secret_ und alter service_role werden angenommen und getestet", async () => {
    for (const key of [SECRET, JWT, FAKE.serviceKey]) {
      const ctx = await makeCtx();
      const result = await databaseStep.test!({ ...supabase, SUPABASE_SERVICE_ROLE_KEY: key }, ctx);
      expect(result.ok).toBe(true);
      expect(ctx.providers.calls).toEqual([{ method: "supabaseQuery", args: [FAKE.supabaseUrl, key] }]);
    }
  });

  test("sb_publishable_ im optionalen anon-Feld ist erlaubt", () => {
    const errors = validateValues(
      DATABASE_FIELDS,
      { ...supabase, SUPABASE_SERVICE_ROLE_KEY: SECRET, SUPABASE_ANON_KEY: PUBLISHABLE },
      {},
    );
    expect(errors).toEqual({});
  });

  test("Hilfetexte nennen beide Schlüsselarten", () => {
    const field = (name: string) => DATABASE_FIELDS.find(f => f.name === name)!;
    expect(field("SUPABASE_SERVICE_ROLE_KEY").help).toContain("sb_secret_");
    expect(field("SUPABASE_SERVICE_ROLE_KEY").help).toContain("service_role");
    expect(field("SUPABASE_ANON_KEY").help).toContain("sb_publishable_");
    expect(field("SUPABASE_ANON_KEY").help).toContain("anon");
  });
});

describe("supabaseQuery", () => {
  function recordingFetch() {
    const hits: HttpRequest[] = [];
    const f: HttpFetch = async (_url, request) => {
      hits.push(request ?? {});
      return new Response("[]", { status: 200 });
    };
    return { f, hits };
  }
  const providers = (fetch: HttpFetch) => createProviders({ fetch, run: fakeRun(), subprocessEnv: () => ({}) });

  test("sb_secret_ nur als apikey", async () => {
    const { f, hits } = recordingFetch();
    expect((await providers(f).supabaseQuery(FAKE.supabaseUrl, SECRET)).ok).toBe(true);
    expect(hits[0].headers).toEqual({ apikey: SECRET });
  });

  test("JWT-Schlüssel wie bisher als apikey und Bearer", async () => {
    const { f, hits } = recordingFetch();
    await providers(f).supabaseQuery(FAKE.supabaseUrl, JWT);
    expect(hits[0].headers).toEqual({ apikey: JWT, Authorization: `Bearer ${JWT}` });
  });

  test("abgelehnter Schlüssel: Meldung nennt beide Arten", async () => {
    const f: HttpFetch = async () => new Response("", { status: 401 });
    const r = await providers(f).supabaseQuery(FAKE.supabaseUrl, SECRET);
    expect(r.message).toContain("sb_secret_");
    expect(r.message).toContain("service_role");
    expect(r.message).not.toContain(SECRET);
  });
});

describe("setup/test-supabase.ts und setup/verify.ts", () => {
  const VARS = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "CONVEX_URL"];
  let saved: Record<string, string | undefined>;
  let seen: { url: string; method: string; headers: Headers }[];
  let spy: ReturnType<typeof spyOn>;
  let log: ReturnType<typeof spyOn>;

  beforeEach(() => {
    saved = Object.fromEntries(VARS.map(k => [k, process.env[k]]));
    for (const k of VARS) delete process.env[k];
    seen = [];
    spy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      // Nur die Attrappen-Adresse, nie ein echter Netzzugriff
      if (!url.startsWith(`${FAKE.supabaseUrl}/`)) throw new Error(`unerwarteter Aufruf: ${url}`);
      const method = init?.method ?? "GET";
      seen.push({ url, method, headers: new Headers(init?.headers) });
      if (method === "POST") return new Response(JSON.stringify([{ id: "testzeile-1" }]), { status: 201 });
      return new Response("[]", { status: 200, headers: { "content-range": "0-0/7" } });
    }) as typeof fetch);
    log = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    spy.mockRestore();
    log.mockRestore();
    for (const k of VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("test-supabase: Import tut nichts", async () => {
    await import("../setup/test-supabase");
    expect(seen).toEqual([]);
  });

  /** Leere .env im Testordner, die echte .env im Projekt wird nie gelesen */
  async function emptyEnvFile(): Promise<string> {
    const path = join(root, `leer-${crypto.randomUUID()}.env`);
    await writeFile(path, "");
    return path;
  }

  for (const [name, vars, key, bearer] of [
    ["sb_secret_", { SUPABASE_SERVICE_ROLE_KEY: SECRET }, SECRET, false],
    ["Legacy-JWT", { SUPABASE_SERVICE_ROLE_KEY: JWT }, JWT, true],
    ["sb_publishable_ als SUPABASE_ANON_KEY", { SUPABASE_ANON_KEY: PUBLISHABLE }, PUBLISHABLE, false],
  ] as const) {
    test(`test-supabase: Lesen, Insert und Cleanup mit ${name}`, async () => {
      const { main } = await import("../setup/test-supabase");
      process.env.SUPABASE_URL = FAKE.supabaseUrl;
      Object.assign(process.env, vars);
      await main(await emptyEnvFile());

      expect(seen.map(s => `${s.method} ${new URL(s.url).pathname}${new URL(s.url).search}`)).toEqual([
        "GET /rest/v1/messages?select=id&limit=1&order=created_at.desc",
        "GET /rest/v1/messages?select=id",
        "GET /rest/v1/memory?select=id&limit=1",
        "POST /rest/v1/memory",
        "DELETE /rest/v1/memory?id=eq.testzeile-1",
      ]);
      for (const { headers } of seen) {
        expect(headers.get("apikey")).toBe(key);
        expect(headers.get("authorization")).toBe(bearer ? `Bearer ${key}` : null);
      }
      // Keine Ausgabe nennt den Schlüssel
      expect(log.mock.calls.flat().join("\n")).not.toContain(key);
    });
  }

  for (const [name, vars, key, bearer] of [
    ["sb_secret_", { SUPABASE_SERVICE_ROLE_KEY: SECRET }, SECRET, false],
    ["JWT", { SUPABASE_SERVICE_ROLE_KEY: JWT }, JWT, true],
    ["sb_publishable_ als SUPABASE_ANON_KEY", { SUPABASE_ANON_KEY: PUBLISHABLE }, PUBLISHABLE, false],
  ] as const) {
    test(`verify: checkDatabase mit ${name}`, async () => {
      const { checkDatabase } = await import("../setup/verify");
      process.env.SUPABASE_URL = FAKE.supabaseUrl;
      Object.assign(process.env, vars);
      await checkDatabase();
      expect(seen.map(s => new URL(s.url).pathname)).toEqual(["/rest/v1/messages", "/rest/v1/memory"]);
      for (const { headers } of seen) {
        expect(headers.get("apikey")).toBe(key);
        expect(headers.get("authorization")).toBe(bearer ? `Bearer ${key}` : null);
      }
    });
  }
});
