/**
 * Supabase ohne Netz: echter supabase-js-Client gegen eine Attrappe von
 * globalThis.fetch. Merkt sich jede Anfrage (Methode, URL, Body) und
 * beantwortet REST-Abfragen auf messages mit festen Zeilen. Edge-Functions
 * antworten ohne eigene Vorgabe mit 503, damit die Text- bzw. Insert-Pfade laufen.
 */
import { spyOn } from "bun:test";
import { resetSupabaseClient } from "../src/lib/supabase";

export const FAKE_SUPABASE_URL = "http://supabase.test";

export interface FakeRequest {
  method: string;
  url: URL;
  body: string;
}

export interface FakeSupabaseOptions {
  /** Zeilen für GET /rest/v1/messages (ohne Filter, die Abfrage prüft der Test) */
  rows?: () => unknown[];
  /** Antwort einer Edge-Function; undefined heißt 503 */
  edge?: (name: string) => unknown[] | undefined;
}

export function useFakeSupabase(options: FakeSupabaseOptions = {}) {
  const rows = options.rows ?? (() => []);
  const saved = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    CONVEX_URL: process.env.CONVEX_URL,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  };
  process.env.SUPABASE_URL = FAKE_SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  delete process.env.CONVEX_URL;
  delete process.env.OPENAI_API_KEY;
  resetSupabaseClient();

  const requests: FakeRequest[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ method, url, body });
    if (url.origin !== FAKE_SUPABASE_URL) return new Response("kein Netz im Test", { status: 599 });
    if (url.pathname.startsWith("/functions/v1/")) {
      const result = options.edge?.(url.pathname.slice("/functions/v1/".length));
      if (result === undefined) return new Response("aus", { status: 503 });
      return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (method === "GET" && url.pathname === "/rest/v1/messages") {
      return new Response(JSON.stringify(rows()), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (method === "POST") return new Response(null, { status: 201 });
    return new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch);

  return {
    requests,
    restore() {
      spy.mockRestore();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetSupabaseClient();
    },
  };
}
