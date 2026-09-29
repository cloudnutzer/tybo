/**
 * Issue #167: Anbieterkennung je Datenbank (Abschnitt Anbieterkennung in
 * supabase/functions/_shared/embedding.ts, db/migrations/20260927_embedding_provider.sql).
 * Die Datenbank ist eine Attrappe der beiden RPC-Funktionen mit derselben
 * Logik wie das SQL (eine Zeile, erstes Festhalten gewinnt). Geprüft wird:
 * Abweichung sperrt Schreiben und Suchen, Modellabweichung, fehlende Kennung,
 * Altbestand, paralleles erstes Festhalten, Meldungen ohne Schlüssel und die
 * Startprüfung als eigene Funktion (ohne src/bot.ts).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkProviderSetup,
  clearRegistryCache,
  compareProvider,
  embedForDatabase,
  REGISTRY_TTL_MS,
  UNREADABLE_TTL_MS,
  checkProvider,
  type EnvReader,
  type FetchLike,
} from "../supabase/functions/_shared/embedding";
import { checkEmbeddingAtStartup, drainEmbeddingQueue } from "../src/lib/embedding";
import { SCHEMA_FILES } from "../src/setup/supabase-schema";

const URL_ = "https://projekt.supabase.co";
const SERVICE = "sb_secret_attrappe_registry";
const OPENAI_KEY = "sk-test-registry-geheim-9999";
const GEMINI_KEY = "AIza-test-registry-geheim-8888";
const target = { url: URL_, key: SERVICE };
const reader = (values: Record<string, string>): EnvReader => name => values[name];

interface Db {
  row: null | { state: "festgehalten"; provider: string; model: string } | { state: "altbestand" };
  /** Vektoren ohne Kennung vorhanden */
  vectors: boolean;
  /** Migration fehlt: RPC antwortet 404 */
  missing: boolean;
  /** Kennung nicht lesbar: Status (Standard 500), gilt für Lesen und Festhalten */
  broken: boolean;
  brokenStatus: number;
  /**
   * Nur das Festhalten scheitert, das Lesen klappt: Status, Netz, ungültige
   * Antwort, Funktion unbekannt (404 PGRST202) oder eine Antwort, die nur
   * der Status geben darf (leer, mit und ohne vectors)
   */
  claimBroken: number | "netz" | "ungueltig" | "fehlt" | "leer" | "leer-ohne-vectors" | null;
  /** Antwort der RPC verzögern (für parallele Aufrufe) */
  delayMs: number;
}

interface Call {
  url: string;
  headers: Record<string, string>;
  body: any;
}

function fakeWorld(db: Partial<Db> = {}) {
  const state: Db = { row: null, vectors: false, missing: false, broken: false, brokenStatus: 500, claimBroken: null, delayMs: 0, ...db };
  const calls: Call[] = [];
  const vector = Array.from({ length: 1536 }, (_, i) => (i % 7) + 1);
  const fetch: FetchLike = async (url, init = {}) => {
    const call = { url, headers: { ...(init.headers as Record<string, string>) }, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    if (url.startsWith(`${URL_}/rest/v1/rpc/`)) {
      if (call.headers.apikey !== SERVICE) return new Response("unauthorized", { status: 401 });
      if (state.delayMs) await new Promise(r => setTimeout(r, state.delayMs));
      if (state.missing) return new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 });
      if (state.broken) return new Response("boom", { status: state.brokenStatus });
      const fn = url.slice(`${URL_}/rest/v1/rpc/`.length);
      if (fn === "claim_embedding_provider" && state.claimBroken !== null) {
        if (state.claimBroken === "netz") throw new TypeError("Unable to connect");
        if (state.claimBroken === "ungueltig") return new Response(JSON.stringify({ state: "irgendwas" }));
        if (state.claimBroken === "fehlt") return new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 });
        if (state.claimBroken === "leer") return new Response(JSON.stringify({ state: "leer", vectors: false }));
        if (state.claimBroken === "leer-ohne-vectors") return new Response(JSON.stringify({ state: "leer" }));
        return new Response("boom", { status: state.claimBroken });
      }
      if (fn === "claim_embedding_provider" && !state.row) {
        // Wie das SQL: unter Sperre, erster gewinnt
        state.row = state.vectors ? { state: "altbestand" } : { state: "festgehalten", provider: call.body.p_provider, model: call.body.p_model };
      }
      if (!state.row) return new Response(JSON.stringify({ state: "leer", vectors: state.vectors }));
      return new Response(JSON.stringify(state.row.state === "festgehalten" ? state.row : { state: "altbestand", provider: null, model: null }));
    }
    if (url.startsWith("https://api.openai.com/")) return new Response(JSON.stringify({ data: [{ embedding: vector }] }));
    if (url.startsWith("https://generativelanguage.googleapis.com/")) return new Response(JSON.stringify({ embedding: { values: vector } }));
    if (url.endsWith("/api/embed")) return new Response(JSON.stringify({ embeddings: [vector.slice(0, 1024)] }));
    return new Response("unerwartet", { status: 599 });
  };
  const rpc = () => calls.filter(c => c.url.includes("/rest/v1/rpc/"));
  const providers = () => calls.filter(c => !c.url.includes("/rest/v1/rpc/"));
  return { state, calls, fetch, rpc, providers };
}

const OPENAI_ENV = { OPENAI_API_KEY: OPENAI_KEY };
const GEMINI_ENV = { EMBEDDING_PROVIDER: "gemini", GEMINI_API_KEY: GEMINI_KEY, OPENAI_API_KEY: OPENAI_KEY };
const OLLAMA_ENV = { EMBEDDING_PROVIDER: "ollama" };

beforeEach(() => clearRegistryCache());

describe("Festhalten beim ersten Embedding", () => {
  test("leere Datenbank: die Einstellung wird festgehalten, danach passt sie", async () => {
    const w = fakeWorld();
    const r = await embedForDatabase("Hallo", reader(GEMINI_ENV), w.fetch, target);
    expect(r.ok).toBe(true);
    expect(w.state.row).toEqual({ state: "festgehalten", provider: "gemini", model: "gemini-embedding-2" });
    // Erst lesen, dann beim Anbieter anfragen, dann festhalten
    expect(w.calls.map(c => c.url.replace(URL_, ""))).toEqual([
      "/rest/v1/rpc/embedding_provider_status",
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent",
      "/rest/v1/rpc/claim_embedding_provider",
    ]);
    expect(w.rpc()[1].body).toEqual({ p_provider: "gemini", p_model: "gemini-embedding-2" });
    // Server-Schlüssel der neuen Art nur im Kopf apikey
    expect(w.rpc()[1].headers.Authorization).toBeUndefined();
  });

  test("Embedding scheitert: nichts festgehalten, danach ist ein anderer Anbieter möglich", async () => {
    const w = fakeWorld();
    const down: FetchLike = async (url, init) => (url.endsWith("/api/embed") ? Promise.reject(new TypeError("Unable to connect")) : w.fetch(url, init));
    expect(await embedForDatabase("x", reader(OLLAMA_ENV), down, target)).toMatchObject({ ok: false, reason: "nicht-erreichbar" });
    expect(w.state.row).toBeNull();
    expect(w.rpc().map(c => c.url)).toEqual([`${URL_}/rest/v1/rpc/embedding_provider_status`]);
    expect((await embedForDatabase("x", reader(OPENAI_ENV), w.fetch, target)).ok).toBe(true);
    expect(w.state.row).toEqual({ state: "festgehalten", provider: "openai", model: "text-embedding-3-small" });
  });

  test("ohne Schlüssel keine Anfrage, auch nicht an die Datenbank (wie vor #167)", async () => {
    const w = fakeWorld();
    expect(await embedForDatabase("Hallo", reader({}), w.fetch, target)).toMatchObject({ ok: false, reason: "kein-zugang" });
    expect(w.calls).toEqual([]);
    expect(w.state.row).toBeNull();
  });

  test("Zwischenspeicher: nach dem Festhalten innerhalb der Frist keine weitere Anfrage an die Kennung", async () => {
    const w = fakeWorld();
    await embedForDatabase("a", reader(OPENAI_ENV), w.fetch, target);
    await embedForDatabase("b", reader(OPENAI_ENV), w.fetch, target);
    // Lesen und Festhalten beim ersten Mal, danach nichts mehr
    expect(w.rpc()).toHaveLength(2);
    expect(w.providers()).toHaveLength(2);
  });

  test("abgelaufene Frist: die Kennung wird neu gelesen (eine geänderte Kennung greift)", async () => {
    const w = fakeWorld({ row: { state: "festgehalten", provider: "openai", model: "text-embedding-3-small" } });
    const config = { provider: "openai" as const, model: "text-embedding-3-small" };
    expect((await checkProvider(config, target, w.fetch, 1_000)).ok).toBe(true);
    w.state.row = { state: "festgehalten", provider: "gemini", model: "gemini-embedding-2" };
    expect((await checkProvider(config, target, w.fetch, 1_000 + REGISTRY_TTL_MS - 1)).ok).toBe(true);
    expect((await checkProvider(config, target, w.fetch, 1_000 + REGISTRY_TTL_MS + 1)).ok).toBe(false);
  });

  test("parallele Erstinitialisierung mit verschiedenen Einstellungen: genau eine gewinnt, die andere ist gesperrt", async () => {
    const w = fakeWorld({ delayMs: 5 });
    const [a, b] = await Promise.all([
      embedForDatabase("a", reader(GEMINI_ENV), w.fetch, target),
      embedForDatabase("b", reader(OLLAMA_ENV), w.fetch, target),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
    const loser = a.ok ? b : a;
    // Der Vektor des Verlierers wird verworfen, nichts davon landet in der Datenbank
    expect(loser).toMatchObject({ ok: false, reason: "gesperrt" });
    expect(w.rpc().filter(c => c.url.endsWith("/claim_embedding_provider"))).toHaveLength(2);
    // Danach ist der Verlierer gesperrt, ohne beim Anbieter anzufragen
    const before = w.providers().length;
    const again = await embedForDatabase("c", reader(a.ok ? OLLAMA_ENV : GEMINI_ENV), w.fetch, target);
    expect(again).toMatchObject({ ok: false, reason: "gesperrt" });
    expect(w.providers()).toHaveLength(before);
  });

  test("SQL: Festhalten unter Sperre mit ON CONFLICT DO NOTHING, eine Zeile, nur service_role", () => {
    const sql = readFileSync(join(import.meta.dir, "../db/migrations/20260927_embedding_provider.sql"), "utf8");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("ON CONFLICT (id) DO NOTHING");
    expect(sql).toContain("id boolean PRIMARY KEY DEFAULT true CHECK (id)");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toContain("REVOKE ALL ON public.embedding_settings FROM PUBLIC, anon, authenticated");
    for (const fn of ["embedding_vectors_exist()", "embedding_provider_status()", "claim_embedding_provider(text, text)"]) {
      expect(sql).toContain(`REVOKE ALL ON FUNCTION public.${fn} FROM PUBLIC, anon, authenticated`);
      expect(sql).toContain(`GRANT EXECUTE ON FUNCTION public.${fn} TO service_role`);
    }
    // Alle Tabellen mit Vektoren, auch die aus Migrationen (memory, knowledge)
    expect(sql).toContain("ARRAY['messages','memory','knowledge','assets']");
    expect(SCHEMA_FILES).toContain("db/migrations/20260927_embedding_provider.sql");
  });
});

describe("Abweichung sperrt Schreiben und Suchen", () => {
  test("anderer Anbieter: gesperrt, kein Aufruf beim Anbieter, Meldung nennt beide Seiten", async () => {
    const w = fakeWorld({ row: { state: "festgehalten", provider: "gemini", model: "gemini-embedding-2" } });
    const r = await embedForDatabase("Hallo", reader(OPENAI_ENV), w.fetch, target);
    expect(r).toMatchObject({ ok: false, reason: "gesperrt" });
    expect(w.providers()).toEqual([]);
    if (!r.ok) {
      expect(r.message).toContain("Google Gemini (gemini-embedding-2)");
      expect(r.message).toContain("OpenAI (text-embedding-3-small)");
      expect(r.message).not.toContain(OPENAI_KEY);
    }
  });

  test("gleicher Anbieter, anderes Modell: ebenfalls gesperrt", async () => {
    const w = fakeWorld({ row: { state: "festgehalten", provider: "gemini", model: "gemini-embedding-2" } });
    const r = await embedForDatabase("x", reader({ ...GEMINI_ENV, EMBEDDING_MODEL: "gemini-embedding-001" }), w.fetch, target);
    expect(r).toMatchObject({ ok: false, reason: "gesperrt" });
    expect(w.providers()).toEqual([]);
  });

  test("Migration fehlt: das Verhalten vor #167 läuft weiter, jeder andere Anbieter ist gesperrt", async () => {
    const w = fakeWorld({ missing: true });
    expect((await embedForDatabase("x", reader(OPENAI_ENV), w.fetch, target)).ok).toBe(true);
    const r = await embedForDatabase("x", reader(OLLAMA_ENV), w.fetch, target);
    expect(r).toMatchObject({ ok: false, reason: "gesperrt" });
    if (!r.ok) expect(r.message).toContain("embedding_settings");
    expect(w.providers().map(c => c.url)).toEqual(["https://api.openai.com/v1/embeddings"]);
  });

  test("Altbestand (Vektoren ohne Kennung): nicht umgedeutet, nur das alte Verhalten erlaubt", async () => {
    const w = fakeWorld({ vectors: true });
    expect((await embedForDatabase("x", reader(OPENAI_ENV), w.fetch, target)).ok).toBe(true);
    // Festgehalten wird kein Anbieter, nur „altbestand“
    expect(w.state.row).toEqual({ state: "altbestand" });
    expect(await embedForDatabase("x", reader(GEMINI_ENV), w.fetch, target)).toMatchObject({ ok: false, reason: "gesperrt" });
    // Auch OpenAI mit anderem Modell gilt nicht als altes Verhalten
    expect(await embedForDatabase("x", reader({ ...OPENAI_ENV, EMBEDDING_MODEL: "text-embedding-3-large" }), w.fetch, target)).toMatchObject({ ok: false, reason: "gesperrt" });
  });

  test("Kennung nicht lesbar: alles gesperrt, auch OpenAI; nur eine Minute gemerkt", async () => {
    const w = fakeWorld({ broken: true });
    expect(await embedForDatabase("x", reader(OPENAI_ENV), w.fetch, target, 0)).toMatchObject({ ok: false, reason: "gesperrt" });
    expect(await embedForDatabase("x", reader(GEMINI_ENV), w.fetch, target, 0)).toMatchObject({ ok: false, reason: "gesperrt" });
    // Kein Vektor ist entstanden, weder für Schreiben noch für Suchen
    expect(w.providers()).toEqual([]);
    // Innerhalb der Minute keine neue Anfrage an die hängende Datenbank, weiter gesperrt
    const asked = w.rpc().length;
    expect(await embedForDatabase("x", reader(OPENAI_ENV), w.fetch, target, 30_000)).toMatchObject({ ok: false, reason: "gesperrt" });
    expect(w.rpc()).toHaveLength(asked);
    w.state.broken = false;
    expect((await embedForDatabase("x", reader(GEMINI_ENV), w.fetch, target, UNREADABLE_TTL_MS + 1)).ok).toBe(true);
  });

  describe("Gemini-Datenbank, Status vorübergehend nicht lesbar: kein OpenAI-Vektor", () => {
    const GEMINI_ROW = { state: "festgehalten" as const, provider: "gemini", model: "gemini-embedding-2" };
    const failures: Array<[string, number]> = [
      ["HTTP 503", 503],
      ["HTTP 500", 500],
      ["HTTP 401 (Rechte)", 401],
      ["HTTP 403 (Rechte)", 403],
      ["404 ohne Kennung der fehlenden Funktion (etwa Proxy)", 404],
    ];
    for (const [name, brokenStatus] of failures) {
      test(name, async () => {
        const w = fakeWorld({ row: GEMINI_ROW, broken: true, brokenStatus });
        const r = await embedForDatabase("x", reader(OPENAI_ENV), w.fetch, target, 0);
        expect(r).toMatchObject({ ok: false, reason: "gesperrt" });
        // Weder Schreib- noch Suchvektor: OpenAI wird gar nicht gefragt
        expect(w.providers()).toEqual([]);
        // Auch nach Ende der Störung nicht die Erlaubnis gemerkt: jetzt greift die Gemini-Kennung
        w.state.broken = false;
        expect(await embedForDatabase("x", reader(OPENAI_ENV), w.fetch, target, UNREADABLE_TTL_MS + 1)).toMatchObject({ ok: false, reason: "gesperrt" });
        expect(w.providers()).toEqual([]);
      });
    }

    test("Netzfehler und ungültige Antwort", async () => {
      for (const make of [
        (w: ReturnType<typeof fakeWorld>): FetchLike => async (url, init) => (url.includes("/rest/v1/rpc/") ? Promise.reject(new TypeError("Unable to connect")) : w.fetch(url, init)),
        (w: ReturnType<typeof fakeWorld>): FetchLike => async (url, init) => (url.includes("/rest/v1/rpc/") ? new Response("<html>kein JSON</html>") : w.fetch(url, init)),
        (w: ReturnType<typeof fakeWorld>): FetchLike => async (url, init) => (url.includes("/rest/v1/rpc/") ? new Response(JSON.stringify({ state: "festgehalten", provider: "cohere", model: "x" })) : w.fetch(url, init)),
        // leer ohne vectors ist keine gültige Statusantwort (kein stilles false)
        (w: ReturnType<typeof fakeWorld>): FetchLike => async (url, init) => (url.includes("/rest/v1/rpc/") ? new Response(JSON.stringify({ state: "leer" })) : w.fetch(url, init)),
        (w: ReturnType<typeof fakeWorld>): FetchLike => async (url, init) => (url.includes("/rest/v1/rpc/") ? new Response(JSON.stringify({ state: "leer", vectors: "nein" })) : w.fetch(url, init)),
      ]) {
        clearRegistryCache();
        const w = fakeWorld({ row: GEMINI_ROW });
        expect(await embedForDatabase("x", reader(OPENAI_ENV), make(w), target, 0)).toMatchObject({ ok: false, reason: "gesperrt" });
        expect(w.providers()).toEqual([]);
      }
    });
  });

  describe("Festhalten scheitert: der Vektor wird verworfen", () => {
    for (const claimBroken of [503, 500, 401, "netz", "ungueltig", "fehlt", "leer", "leer-ohne-vectors"] as const) {
      test(`Festhalten: ${claimBroken}`, async () => {
        const w = fakeWorld({ claimBroken });
        const r = await embedForDatabase("x", reader(OPENAI_ENV), w.fetch, target, 0);
        expect(r).toMatchObject({ ok: false, reason: "gesperrt" });
        expect(w.state.row).toBeNull();
        // Genau ein Embedding angefragt, der Vektor geht nicht zurück; danach eine Minute gesperrt ohne neue Anfrage
        expect(w.providers()).toHaveLength(1);
        expect(await embedForDatabase("y", reader(OPENAI_ENV), w.fetch, target, 30_000)).toMatchObject({ ok: false, reason: "gesperrt" });
        expect(w.providers()).toHaveLength(1);
        // Klappt das Festhalten wieder, geht es weiter
        w.state.claimBroken = null;
        expect((await embedForDatabase("z", reader(OPENAI_ENV), w.fetch, target, UNREADABLE_TTL_MS + 1)).ok).toBe(true);
        expect(w.state.row).toEqual({ state: "festgehalten", provider: "openai", model: "text-embedding-3-small" });
      });
    }
  });

  test("Migration fehlt, danach eingespielt und auf Gemini festgelegt: dieselbe Instanz liefert keinen OpenAI-Vektor mehr", async () => {
    const w = fakeWorld({ missing: true });
    // Suche ohne Migration: altes Verhalten erlaubt, nichts gespeichert
    expect((await embedForDatabase("Suche", reader(OPENAI_ENV), w.fetch, target, 0)).ok).toBe(true);
    expect(w.providers()).toHaveLength(1);
    // Migration eingespielt, Gemini hält fest (die leere Datenbank lässt das zu)
    w.state.missing = false;
    w.state.row = { state: "festgehalten", provider: "gemini", model: "gemini-embedding-2" };
    const asked = w.rpc().length;
    // Innerhalb der früheren Frist: die Kennung wird neu gelesen, OpenAI gesperrt
    const r = await embedForDatabase("Nochmal", reader(OPENAI_ENV), w.fetch, target, 1_000);
    expect(r).toMatchObject({ ok: false, reason: "gesperrt" });
    expect(w.rpc()).toHaveLength(asked + 1);
    expect(w.providers()).toHaveLength(1);
    expect((await checkProvider({ provider: "openai", model: "text-embedding-3-small" }, target, w.fetch, 2_000)).ok).toBe(false);
  });

  describe("laufende Anfrage: Migration fehlt beim Lesen, wird eingespielt, während der Anbieter rechnet", () => {
    /** OpenAI antwortet erst, nachdem during() die Datenbank umgestellt hat */
    function delayedOpenAI(w: ReturnType<typeof fakeWorld>, during: () => void): FetchLike {
      return async (url, init) => {
        if (url.startsWith("https://api.openai.com/")) {
          await new Promise(r => setTimeout(r, 5));
          during();
        }
        return w.fetch(url, init);
      };
    }

    test("inzwischen auf Gemini festgelegt: der OpenAI-Vektor wird verworfen", async () => {
      const w = fakeWorld({ missing: true });
      const fetch = delayedOpenAI(w, () => {
        w.state.missing = false;
        w.state.row = { state: "festgehalten", provider: "gemini", model: "gemini-embedding-2" };
      });
      const r = await embedForDatabase("Suche", reader(OPENAI_ENV), fetch, target, 0);
      expect(r).toMatchObject({ ok: false, reason: "gesperrt" });
      expect(w.providers()).toHaveLength(1);
      expect(w.rpc().map(c => c.url.split("/").pop())).toEqual(["embedding_provider_status", "embedding_provider_status"]);
      // Gemini bleibt festgehalten, die nächste Anfrage ist ebenfalls gesperrt
      expect(w.state.row).toEqual({ state: "festgehalten", provider: "gemini", model: "gemini-embedding-2" });
      expect(await embedForDatabase("x", reader(OPENAI_ENV), w.fetch, target, 1)).toMatchObject({ ok: false, reason: "gesperrt" });
    });

    test("inzwischen nicht lesbar: der Vektor wird verworfen", async () => {
      const w = fakeWorld({ missing: true });
      const fetch = delayedOpenAI(w, () => {
        w.state.missing = false;
        w.state.broken = true;
      });
      expect(await embedForDatabase("Suche", reader(OPENAI_ENV), fetch, target, 0)).toMatchObject({ ok: false, reason: "gesperrt" });
    });

    test("inzwischen eingespielt, noch nichts festgehalten: OpenAI wird festgehalten und bestätigt", async () => {
      const w = fakeWorld({ missing: true });
      const fetch = delayedOpenAI(w, () => {
        w.state.missing = false;
      });
      expect(await embedForDatabase("Suche", reader(OPENAI_ENV), fetch, target, 0)).toMatchObject({ ok: true });
      expect(w.state.row).toEqual({ state: "festgehalten", provider: "openai", model: "text-embedding-3-small" });
    });

    test("inzwischen eingespielt mit Altbestand oder auf OpenAI festgelegt: der Vektor gilt", async () => {
      for (const row of [{ state: "altbestand" } as const, { state: "festgehalten", provider: "openai", model: "text-embedding-3-small" } as const]) {
        clearRegistryCache();
        const w = fakeWorld({ missing: true });
        const fetch = delayedOpenAI(w, () => {
          w.state.missing = false;
          w.state.row = row;
        });
        expect(await embedForDatabase("Suche", reader(OPENAI_ENV), fetch, target, 0)).toMatchObject({ ok: true });
      }
    });

    test("Migration fehlt weiterhin: das alte Verhalten bleibt", async () => {
      const w = fakeWorld({ missing: true });
      expect(await embedForDatabase("Suche", reader(OPENAI_ENV), delayedOpenAI(w, () => {}), target, 0)).toMatchObject({ ok: true });
      expect(w.state.row).toBeNull();
    });
  });

  test("bestätigter Altfall (PostgREST kennt die Funktion nicht) bleibt vom nicht lesbaren Fall getrennt", async () => {
    const w = fakeWorld({ missing: true });
    const confirmed = await embedForDatabase("x", reader(OPENAI_ENV), w.fetch, target, 0);
    expect(confirmed.ok).toBe(true);
    clearRegistryCache();
    const unconfirmed = fakeWorld({ broken: true, brokenStatus: 404 });
    expect(await embedForDatabase("x", reader(OPENAI_ENV), unconfirmed.fetch, target, 0)).toMatchObject({ ok: false, reason: "gesperrt" });
    expect(unconfirmed.providers()).toEqual([]);
  });

  test("Bot und Functions melden Anbieter und Modell nur bei einem Vektor", async () => {
    const w = fakeWorld();
    const r = await embedForDatabase("x", reader(GEMINI_ENV), w.fetch, target, 0);
    expect(r).toMatchObject({ ok: true, config: { provider: "gemini", model: "gemini-embedding-2" } });
  });

  test("ohne Supabase-Ziel (keine Adresse, keine Datenbank): nur das alte Verhalten", async () => {
    const w = fakeWorld();
    expect((await embedForDatabase("x", reader(OPENAI_ENV), w.fetch, null)).ok).toBe(true);
    expect(await embedForDatabase("x", reader(GEMINI_ENV), w.fetch, null)).toMatchObject({ ok: false, reason: "gesperrt" });
  });

  test("compareProvider: leer ohne Vektoren passt immer, leer mit Vektoren wie Altbestand", () => {
    const gemini = { provider: "gemini" as const, model: "gemini-embedding-2" };
    expect(compareProvider({ state: "leer", vectors: false }, gemini).ok).toBe(true);
    expect(compareProvider({ state: "leer", vectors: true }, gemini).ok).toBe(false);
    expect(compareProvider({ state: "leer", vectors: true }, { provider: "openai", model: "text-embedding-3-small" }).ok).toBe(true);
  });
});

describe("Prüfung beim Start und in der Gesamtprüfung", () => {
  test("checkProviderSetup liest nur (hält nichts fest) und meldet die Abweichung, auch ohne Schlüssel", async () => {
    const w = fakeWorld({ row: { state: "festgehalten", provider: "ollama", model: "bge-m3" } });
    const r = await checkProviderSetup(reader({}), target, w.fetch);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Ollama (bge-m3)");
    expect(w.rpc().map(c => c.url)).toEqual([`${URL_}/rest/v1/rpc/embedding_provider_status`]);
    const empty = fakeWorld();
    expect((await checkProviderSetup(reader(GEMINI_ENV), target, empty.fetch)).ok).toBe(true);
    expect(empty.state.row).toBeNull();
  });

  test("checkProviderSetup: passend, fehlende Migration, Altbestand, ungültige Einstellung", async () => {
    expect((await checkProviderSetup(reader(OPENAI_ENV), target, fakeWorld({ row: { state: "festgehalten", provider: "openai", model: "text-embedding-3-small" } }).fetch)).ok).toBe(true);
    expect((await checkProviderSetup(reader(OPENAI_ENV), target, fakeWorld({ missing: true }).fetch)).ok).toBe(true);
    expect((await checkProviderSetup(reader(GEMINI_ENV), target, fakeWorld({ missing: true }).fetch)).ok).toBe(false);
    expect((await checkProviderSetup(reader(GEMINI_ENV), target, fakeWorld({ vectors: true }).fetch)).ok).toBe(false);
    expect((await checkProviderSetup(reader({ EMBEDDING_PROVIDER: "cohere" }), target, fakeWorld().fetch)).ok).toBe(false);
  });

  test("checkProviderSetup: nicht lesbar ist auch für OpenAI kein ok", async () => {
    const r = await checkProviderSetup(reader(OPENAI_ENV), target, fakeWorld({ broken: true, brokenStatus: 503 }).fetch);
    expect(r).toMatchObject({ ok: false, unreadable: true });
    expect(r.message).toContain("nicht lesbar");
  });

  describe("checkEmbeddingAtStartup (ohne src/bot.ts)", () => {
    test("ohne Supabase oder mit Convex: keine Prüfung", async () => {
      const w = fakeWorld();
      expect(await checkEmbeddingAtStartup(reader({}), w.fetch)).toBeNull();
      expect(await checkEmbeddingAtStartup(reader({ CONVEX_URL: "https://x.convex.cloud", SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: SERVICE }), w.fetch)).toBeNull();
      expect(w.calls).toEqual([]);
    });

    test("Abweichung: ok false mit Meldung ohne Schlüssel", async () => {
      const w = fakeWorld({ row: { state: "festgehalten", provider: "gemini", model: "gemini-embedding-2" } });
      const r = await checkEmbeddingAtStartup(reader({ SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: SERVICE, ...OPENAI_ENV }), w.fetch);
      expect(r?.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(OPENAI_KEY);
      expect(JSON.stringify(r)).not.toContain(SERVICE);
    });

    test("Fehler beim Lesen wirft nie", async () => {
      const throwing: FetchLike = async () => {
        throw new Error(`kaputt ${SERVICE}`);
      };
      const r = await checkEmbeddingAtStartup(reader({ SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: SERVICE, ...GEMINI_ENV }), throwing);
      expect(r?.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(SERVICE);
    });

    test("src/bot.ts ruft die Prüfung beim Start auf und meldet eine Abweichung als Warnung", () => {
      const source = readFileSync(join(import.meta.dir, "../src/bot.ts"), "utf8");
      expect(source).toContain('import { checkEmbeddingAtStartup } from "./lib/embedding";');
      expect(source).toContain("void checkEmbeddingAtStartup().then(");
    });

    test("src/bot.ts zieht vorgemerkte Einträge beim Start und danach regelmäßig nach (Issue #168)", () => {
      const source = readFileSync(join(import.meta.dir, "../src/bot.ts"), "utf8");
      expect(source).toContain("void drainEmbeddings();");
      expect(source).toContain("setInterval(() => { void drainEmbeddings(); }, DRAIN_INTERVAL_MS).unref();");
    });

    test("drainEmbeddingQueue: ohne Supabase, mit Convex oder ohne Zugang zum Anbieter nichts", async () => {
      const calls: string[] = [];
      const fetchFn = async (url: string) => {
        calls.push(url);
        return new Response("[]");
      };
      const base = { SUPABASE_URL: "https://projekt.supabase.co", SUPABASE_SERVICE_ROLE_KEY: SERVICE, OPENAI_API_KEY: "sk-test-nachzug" };
      const env = (vars: Record<string, string>) => (name: string) => vars[name];
      expect(await drainEmbeddingQueue(env({ OPENAI_API_KEY: "sk-test-nachzug" }), fetchFn)).toBeNull();
      expect(await drainEmbeddingQueue(env({ ...base, CONVEX_URL: "https://x.convex.cloud" }), fetchFn)).toBeNull();
      expect(await drainEmbeddingQueue(env({ ...base, OPENAI_API_KEY: "" }), fetchFn)).toBeNull();
      expect(calls).toEqual([]);
      // Leere Warteschlange: fertig ohne Anfrage beim Anbieter
      expect(await drainEmbeddingQueue(env(base), fetchFn)).toEqual({ state: "fertig", written: 0, rejected: 0 });
      expect(calls.every(u => u.startsWith("https://projekt.supabase.co/rest/v1/embedding_reindex_queue?"))).toBe(true);
    });
  });
});

describe("Bot: Sperrmeldung einmal im Log, ohne Schlüssel", () => {
  let warn: ReturnType<typeof spyOn>;
  const saved: Record<string, string | undefined> = {};
  const NAMES = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "EMBEDDING_PROVIDER", "GEMINI_API_KEY", "OPENAI_API_KEY", "EMBEDDING_MODEL"];

  beforeEach(() => {
    for (const n of NAMES) saved[n] = process.env[n];
    warn = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    for (const n of NAMES) {
      if (saved[n] === undefined) delete process.env[n];
      else process.env[n] = saved[n];
    }
  });

  test("embedForDatabase des Bots nutzt SUPABASE_URL und den Server-Schlüssel", async () => {
    const { embedForDatabase: botEmbed } = await import("../src/lib/embedding");
    const w = fakeWorld({ row: { state: "festgehalten", provider: "openai", model: "text-embedding-3-small" } });
    const env = reader({ SUPABASE_URL: URL_, SUPABASE_SERVICE_ROLE_KEY: SERVICE, ...GEMINI_ENV });
    expect(await botEmbed("a", env, w.fetch)).toBeNull();
    expect(await botEmbed("b", env, w.fetch)).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = warn.mock.calls.flat().join(" ");
    expect(logged).not.toContain(GEMINI_KEY);
    expect(logged).not.toContain(SERVICE);
    expect(w.providers()).toEqual([]);
  });
});

describe("Zeitlimit", () => {
  test("die Anfrage an die Kennung hat immer ein Abbruchsignal (hängende Datenbank hält nichts auf)", async () => {
    let seen: AbortSignal | undefined | null;
    const fetch: FetchLike = async (_url, init = {}) => {
      seen = init.signal;
      return new Response(JSON.stringify({ state: "leer", vectors: false }));
    };
    await checkProvider({ provider: "gemini", model: "gemini-embedding-2" }, target, fetch);
    expect(seen).toBeInstanceOf(AbortSignal);
  });
});
