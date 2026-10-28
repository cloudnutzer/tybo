/**
 * Issue #162: neue Supabase-Schlüssel (sb_secret_…, sb_publishable_…) gehen
 * bei direkten Aufrufen nur in den Kopf apikey, alte JWT-Schlüssel wie bisher
 * zusätzlich als Authorization: Bearer. Geprüft am Helfer und an den echten
 * Aufrufstellen; fetch ist eine Attrappe, kein echtes Supabase.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { isNewSupabaseKey, isPublishableSupabaseKey, supabaseHeaders } from "../src/lib/supabase-keys";
import { resetSupabaseClient } from "../src/lib/supabase";
import { reads, saveDirect as saveMessage } from "./supabase-direct";

const searchMessages = (chatId: string, query: string) => reads().search(chatId, query, 10);
import { addKnowledge } from "../src/lib/knowledge-base";
import { getStore } from "../src/lib/store";

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

/**
 * CI-Lauf zu #332: Die Wahl des Speichers gilt für den ganzen Prozess. Wählte
 * eine früher laufende Datei ohne SUPABASE_URL, bekamen die Tests unten den
 * Platzhalter und addKnowledge meldete ok: false. Der Vorlauf stellt das in
 * fester Reihenfolge nach; tests/preload-env.ts lässt jeden Test neu wählen.
 */
describe("Speicherwahl eines früheren Tests", () => {
  test("Vorlauf: ohne SUPABASE_URL fällt die Wahl auf die Datei", () => {
    delete process.env.SUPABASE_URL;
    expect(getStore().backend).not.toBe("supabase");
  });

  test("der nächste Test wählt mit seiner eigenen Umgebung", () => {
    process.env.SUPABASE_SERVICE_ROLE_KEY = SECRET;
    expect(getStore().backend).toBe("supabase");
  });

  test("Vorlauf vor den Edge-Function-Tests: wieder ohne SUPABASE_URL gewählt", () => {
    delete process.env.SUPABASE_URL;
    expect(getStore().backend).not.toBe("supabase");
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

describe("Check-in liest über den Store mit dem schreibenden Schlüssel", () => {
  // Die Quelle Ziele liest seit #354 über den Store (tests/sources-goals.test.ts), das Board seit #357
  // (tests/board-data.test.ts); der Check-in liest seit #364 nicht mehr selbst mit SUPABASE_ANON_KEY,
  // sondern die letzte Nutzernachricht über getStore().messages
  // Köpfe setzt hier supabase-js selbst; geprüft wird, welcher Schlüssel geht
  for (const [name, key] of [
    ["sb_secret_", SECRET],
    ["JWT service_role", JWT],
  ] as const) {
    test(`${name}: letzte Nutzernachricht`, async () => {
      process.env.SUPABASE_SERVICE_ROLE_KEY = key;
      process.env.SUPABASE_ANON_KEY = PUBLISHABLE;
      expect(await getStore().messages.lastUserMessageAt()).toBeNull();
      const sent = headersFor("/rest/v1/messages");
      expect(sent).toHaveLength(1);
      expect(sent[0].get("apikey")).toBe(key);
      expect(JSON.stringify([...sent[0].entries()])).not.toContain(PUBLISHABLE);
    });
  }
});

