/**
 * Issue #364: Zeitpunkt der jüngsten Nutzernachricht für den Check-in über
 * getStore().messages.lastUserMessageAt(). Geprüft wird die Abfrage
 * (alle Gespräche, nur Nutzer, ohne Meldungen, neueste zuerst, eine Zeile),
 * dass Abruffehler werfen statt „keine Nachricht" zu melden, und der Weg
 * ohne Datenbank. Kein Netz, supabase-js gegen die Fetch-Attrappe.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStore, resetStore, StoreNotReadyError } from "../src/lib/store";
import { newestUserMessageAt, NOT_DISPLAY_ONLY_FILTER } from "../src/lib/store/supabase/messages";
import { resetSupabaseClient } from "../src/lib/supabase";
import { useFakeSupabase, type FakeSupabaseOptions } from "./supabase-fixture";

const MICRO = "2026-10-19T17:45:12.123456+00:00";
const cleanups: (() => void)[] = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fake(options: FakeSupabaseOptions) {
  const f = useFakeSupabase(options);
  cleanups.push(() => f.restore());
  const warn = spyOn(console, "warn").mockImplementation(() => {});
  cleanups.push(() => warn.mockRestore());
  return f;
}

function store() {
  resetStore();
  const s = getStore();
  expect(s.backend).toBe("supabase");
  return s.messages;
}

describe("lastUserMessageAt über Supabase", () => {
  test("eine Abfrage über alle Chats: nur role user, ohne Meldungen, neueste zuerst, eine Zeile, Service-Schlüssel", async () => {
    const f = fake({ rows: () => [{ created_at: MICRO }] });
    expect(await store().lastUserMessageAt()).toBe(MICRO);
    expect(f.requests).toHaveLength(1);
    const [request] = f.requests;
    expect(request.method).toBe("GET");
    expect(request.url.pathname).toBe("/rest/v1/messages");
    const params = request.url.searchParams;
    expect(params.get("select")).toBe("created_at");
    expect(params.get("role")).toBe("eq.user");
    expect(params.get("or")).toBe(`(${NOT_DISPLAY_ONLY_FILTER})`);
    expect(params.get("order")).toBe("created_at.desc");
    expect(params.get("limit")).toBe("1");
    // Telegram und Browser liegen in derselben Tabelle: kein Filter auf ein Gespräch
    expect(params.has("chat_id")).toBe(false);
    expect(params.has("session_key")).toBe(false);
    expect(request.headers.get("apikey")).toBe("test-service-key");
  });

  test("keine Nutzernachricht: null", async () => {
    fake({ rows: () => [] });
    expect(await store().lastUserMessageAt()).toBeNull();
  });

  test("Lesefehler der Datenbank wirft, statt null zu liefern", async () => {
    fake({ respond: r => (r.method === "GET" ? Response.json({ message: "weg" }, { status: 500 }) : undefined) });
    await expect(store().lastUserMessageAt()).rejects.toThrow("Letzte Nutzernachricht lesen fehlgeschlagen");
  });

  test("Zeile ohne Zeit-Text wirft", async () => {
    fake({ rows: () => [{ created_at: null }] });
    await expect(store().lastUserMessageAt()).rejects.toThrow("ohne Zeitpunkt");
  });

  test("werfender Client: Fehler ohne Details des Clients", async () => {
    const throwing = {
      from() {
        throw new Error("Client kaputt mit Geheimnis");
      },
    } as unknown as SupabaseClient;
    await expect(newestUserMessageAt(throwing)).rejects.toThrow("Letzte Nutzernachricht lesen fehlgeschlagen");
  });
});

describe("lastUserMessageAt ohne Datenbank", () => {
  test("Platzhalter wirft StoreNotReadyError, kein Netz", async () => {
    const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    resetSupabaseClient();
    resetStore();
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const messages = getStore().messages;
      expect(() => messages.lastUserMessageAt()).toThrow(StoreNotReadyError);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      if (saved.url !== undefined) process.env.SUPABASE_URL = saved.url;
      if (saved.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
      resetSupabaseClient();
      resetStore();
    }
  });
});
