/**
 * Issue #162: neue Supabase-Schlüssel (sb_secret_…, sb_publishable_…) gehen
 * bei direkten Aufrufen nur in den Kopf apikey, alte JWT-Schlüssel wie bisher
 * zusätzlich als Authorization: Bearer. Geprüft am Helfer und an den echten
 * Aufrufstellen; fetch ist eine Attrappe, kein echtes Supabase.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isNewSupabaseKey, isPublishableSupabaseKey, supabaseHeaders } from "../src/lib/supabase-keys";
import { resetSupabaseClient, saveMessage, searchMessages } from "../src/lib/supabase";
import { addKnowledge } from "../src/lib/knowledge-base";
import { gatherBoardData } from "../src/lib/board-data";
import { getAllSources } from "../src/lib/data-sources/registry";
import "../src/lib/data-sources/sources/goals";

// Erfundene Werte in der Form der echten Schlüssel
const SECRET = "sb_secret_attrappe123";
const PUBLISHABLE = "sb_publishable_attrappe456";
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.attrappe";
const JWT_ANON = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.attrappe";
const URL_BASE = "http://supabase.test";

const VARS = [
  "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY", "CONVEX_URL", "OPENAI_API_KEY",
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "NOTION_TOKEN", "NOTION_DATABASE_ID",
  "NOTION_CONTENT_PIPELINE_DB", "NOTION_TRANSACTIONS_DB", "XAI_API_KEY", "METRICS_SHEET_ID", "GITHUB_TOKEN",
  "GO_PROJECT_ROOT",
];

interface Seen { url: URL; headers: Headers }
let seen: Seen[];
let savedEnv: Record<string, string | undefined>;
let realFetch: typeof fetch;

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

beforeEach(() => {
  savedEnv = Object.fromEntries(VARS.map(k => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  // Kein memory.json aus dem Arbeitsordner als Rückfall
  process.env.GO_PROJECT_ROOT = "/nicht/vorhanden";
  process.env.SUPABASE_URL = URL_BASE;
  resetSupabaseClient();
  seen = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = new URL(request ? request.url : String(input));
    const headers = new Headers(request?.headers);
    new Headers(init?.headers).forEach((value, key) => headers.set(key, value));
    seen.push({ url, headers });
    if (url.origin !== URL_BASE) return new Response("kein Netz im Test", { status: 599 });
    if (url.pathname === "/rest/v1/knowledge") return json({ id: "k1" });
    return json([]);
  }, { preconnect: realFetch.preconnect }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetSupabaseClient();
});

/** Köpfe der Aufrufe an einen Pfad, eine Erwartung je Aufruf */
function headersFor(path: string): Headers[] {
  return seen.filter(s => s.url.pathname === path).map(s => s.headers);
}

function expectNewKeyHeaders(list: Headers[], key: string) {
  expect(list.length).toBeGreaterThan(0);
  for (const h of list) {
    expect(h.get("apikey")).toBe(key);
    expect(h.has("authorization")).toBe(false);
  }
}

function expectJwtHeaders(list: Headers[], key: string) {
  expect(list.length).toBeGreaterThan(0);
  for (const h of list) {
    expect(h.get("apikey")).toBe(key);
    expect(h.get("authorization")).toBe(`Bearer ${key}`);
  }
}

async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await Bun.sleep(1);
}

describe("supabaseHeaders", () => {
  test("neue Schlüssel nur als apikey", () => {
    expect(supabaseHeaders(SECRET)).toEqual({ apikey: SECRET });
    expect(supabaseHeaders(PUBLISHABLE)).toEqual({ apikey: PUBLISHABLE });
  });

  test("JWT-Schlüssel als apikey und Bearer wie bisher", () => {
    expect(supabaseHeaders(JWT)).toEqual({ apikey: JWT, Authorization: `Bearer ${JWT}` });
  });

  test("Erkennung der Schlüsselart", () => {
    expect(isNewSupabaseKey(SECRET)).toBe(true);
    expect(isNewSupabaseKey(PUBLISHABLE)).toBe(true);
    expect(isNewSupabaseKey(JWT)).toBe(false);
    expect(isPublishableSupabaseKey(PUBLISHABLE)).toBe(true);
    expect(isPublishableSupabaseKey(SECRET)).toBe(false);
    expect(isPublishableSupabaseKey(JWT_ANON)).toBe(false);
  });
});

describe("Edge Functions mit dem schreibenden Schlüssel", () => {
  for (const [name, key, expectHeaders] of [
    ["sb_secret_", SECRET, expectNewKeyHeaders],
    ["JWT service_role", JWT, expectJwtHeaders],
  ] as const) {
    test(`${name}: store-telegram-message, search-memory, embed-knowledge`, async () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = key;
      await saveMessage({ chat_id: "4711", role: "user", content: "Hallo" });
      await searchMessages("4711", "Hallo");
      const result = await addKnowledge({ category: "learning", title: "Test", content: "Inhalt" });
      expect(result.ok).toBe(true);
      await until(() => headersFor("/functions/v1/embed-knowledge").length > 0);
      expectHeaders(headersFor("/functions/v1/store-telegram-message"), key);
      expectHeaders(headersFor("/functions/v1/search-memory"), key);
      expectHeaders(headersFor("/functions/v1/embed-knowledge"), key);
    });
  }
});

describe("Lesende Aufrufe mit SUPABASE_ANON_KEY", () => {
  for (const [name, key, expectHeaders] of [
    ["sb_publishable_", PUBLISHABLE, expectNewKeyHeaders],
    ["JWT anon", JWT_ANON, expectJwtHeaders],
  ] as const) {
    test(`${name}: Check-in, Datenquelle Ziele, Board`, async () => {
      process.env.SUPABASE_ANON_KEY = key;

      const checkin = await import("../src/smart-checkin");
      checkin.initConfig();
      await checkin.loadMemory();
      await checkin.getRecentConversations();
      expectHeaders(headersFor("/rest/v1/memory"), key);
      expectHeaders(headersFor("/rest/v1/messages"), key);

      seen = [];
      const goals = getAllSources().find(s => s.id === "goals");
      expect(goals).toBeDefined();
      await goals!.fetch();
      expectHeaders(headersFor("/rest/v1/memory"), key);

      seen = [];
      await gatherBoardData();
      expectHeaders(headersFor("/rest/v1/memory"), key);
    });
  }
});
