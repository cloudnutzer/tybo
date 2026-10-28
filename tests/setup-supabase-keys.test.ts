/**
 * Issue #162, Schritt 3: Einrichtung mit neuen Supabase-Schlüsseln. Ein
 * sb_publishable_… im Feld für den schreibenden Schlüssel wird abgelehnt
 * (Meldung ohne Wert), ein sb_secret_… angenommen. supabaseQuery() und
 * tybo pruefen (Issue #372) senden neue Schlüssel nur als apikey, auch den
 * sb_publishable_ aus SUPABASE_ANON_KEY. Lesen, Insert und Cleanup der
 * Schreibprobe prüft tests/setup-database-write-probe.test.ts (Issue #305).
 * Netz ist eine Attrappe, die echte .env wird nie gelesen.
 */
import { afterAll, describe, expect, test } from "bun:test";
import type { HttpFetch, HttpRequest } from "../src/setup/context";
import { collectReport } from "../src/setup/checks/report";
import { databaseCheck } from "../src/setup/checks/specials";
import { createProviders } from "../src/setup/providers";
import { databaseStep, DATABASE_FIELDS } from "../src/setup/steps/database";
import { validateValues } from "../src/setup/model";
import { cleanup, FAKE, fakeRun, makeCtx } from "./setup-fixture";

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
      // Erst lesen, dann die Schreibprobe (Issue #305)
      expect(ctx.providers.calls).toEqual([
        { method: "supabaseQuery", args: [FAKE.supabaseUrl, key] },
        { method: "supabaseWriteProbe", args: [FAKE.supabaseUrl, key] },
      ]);
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

describe("tybo pruefen: Datenbank", () => {
  const providers = (fetch: HttpFetch) => createProviders({ fetch, run: fakeRun(), subprocessEnv: () => ({}) });
  for (const [name, line, key, bearer] of [
    ["sb_secret_", `SUPABASE_SERVICE_ROLE_KEY=${SECRET}`, SECRET, false],
    ["JWT", `SUPABASE_SERVICE_ROLE_KEY=${JWT}`, JWT, true],
    ["sb_publishable_ als SUPABASE_ANON_KEY", `SUPABASE_ANON_KEY=${PUBLISHABLE}`, PUBLISHABLE, false],
  ] as const) {
    test(`databaseCheck mit ${name}`, async () => {
      const seen: { url: string; headers: Headers }[] = [];
      const fetch: HttpFetch = async (url, init?: HttpRequest) => {
        // Nur die Attrappen-Adresse, nie ein echter Netzzugriff
        if (!url.startsWith(`${FAKE.supabaseUrl}/`)) throw new Error(`unerwarteter Aufruf: ${url}`);
        if ((init?.method ?? "GET") !== "GET") throw new Error("Prüfbericht schreibt nie");
        seen.push({ url, headers: new Headers(init?.headers) });
        return new Response("[]", { status: 200 });
      };
      const ctx = await makeCtx({ env: `SUPABASE_URL=${FAKE.supabaseUrl}\n${line}\n`, overrides: { fetch } });
      await collectReport({ ctx: { ...ctx, providers: providers(fetch) }, steps: [], specials: [databaseCheck] });
      expect(seen.map(s => new URL(s.url).pathname)).toEqual(["/rest/v1/messages", "/rest/v1/memory"]);
      for (const { headers } of seen) {
        expect(headers.get("apikey")).toBe(key);
        expect(headers.get("authorization")).toBe(bearer ? `Bearer ${key}` : null);
      }
    });
  }
});
