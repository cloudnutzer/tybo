/**
 * Issue #382: der gemeinsame Supabase-Client (src/lib/supabase.ts). Ohne
 * URL oder Service-Key null und beim nächsten Aufruf ein neuer Versuch;
 * einmal angelegt immer derselbe Client, bis resetSupabaseClient.
 */
import { afterEach, expect, test } from "bun:test";
import { getSupabase, resetSupabaseClient } from "../src/lib/supabase";

const ACCESS = { SUPABASE_URL: "https://projekt.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_attrappe" };
afterEach(() => resetSupabaseClient());

test("ohne URL oder ohne Schlüssel: null, nichts gemerkt", () => {
  expect(getSupabase({})).toBeNull();
  expect(getSupabase({ SUPABASE_URL: ACCESS.SUPABASE_URL })).toBeNull();
  expect(getSupabase({ SUPABASE_SERVICE_ROLE_KEY: ACCESS.SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL: "" })).toBeNull();
  expect(getSupabase(ACCESS)).not.toBeNull();
});

test("einmal angelegt: derselbe Client, auch wenn die Umgebung danach fehlt", () => {
  const first = getSupabase(ACCESS);
  expect(getSupabase({})).toBe(first);
});

test("resetSupabaseClient: die Umgebung wird neu gelesen", () => {
  const first = getSupabase(ACCESS);
  resetSupabaseClient();
  expect(getSupabase({})).toBeNull();
  expect(getSupabase(ACCESS)).not.toBe(first);
});
