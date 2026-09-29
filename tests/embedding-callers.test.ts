/**
 * Issue #167: Aufrufer des Embedding-Bausteins im Bot. Ohne neue Variablen
 * bleibt der OpenAI-Aufruf von src/lib/supabase.ts wie vorher (mit Kürzung
 * auf 8000 Zeichen); Convex nutzt weiter OpenAI, auch wenn EMBEDDING_PROVIDER
 * gesetzt ist. Kein Netz: fetch ist eine Attrappe.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { getFunctionName } from "convex/server";
import * as facade from "../src/lib/convex";
import { generateEmbedding, generateOpenAiEmbedding, verifiedFactVectors } from "../src/lib/supabase";
import { clearRegistryCache } from "../supabase/functions/_shared/embedding";

const NAMES = ["OPENAI_API_KEY", "GEMINI_API_KEY", "EMBEDDING_PROVIDER", "EMBEDDING_MODEL", "OLLAMA_URL", "CONVEX_URL", "CONVEX_AUTH_TOKEN", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"];
const OPENAI_KEY = "sk-test-aufrufer-geheim-2468";
const GEMINI_KEY = "AIza-test-aufrufer-geheim-1357";

interface Outbound {
  url: string;
  headers: Record<string, string>;
  body: any;
}

let saved: Record<string, string | undefined>;
let sent: Outbound[];
let fetchSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
const cleanups: Array<() => void> = [];
const vector = Array.from({ length: 1536 }, (_, i) => Math.cos(i) + 1.5);

beforeEach(() => {
  saved = Object.fromEntries(NAMES.map(n => [n, process.env[n]]));
  for (const n of NAMES) delete process.env[n];
  clearRegistryCache();
  // Supabase mit leerer Anbieterkennung: das erste Embedding hält fest
  process.env.SUPABASE_URL = "https://projekt.supabase.co";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_attrappe";
  sent = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    sent.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url === "https://projekt.supabase.co/rest/v1/rpc/embedding_provider_status") return new Response(JSON.stringify({ state: "leer", vectors: false }));
    if (url === "https://projekt.supabase.co/rest/v1/rpc/claim_embedding_provider") {
      const body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ state: "festgehalten", provider: body.p_provider, model: body.p_model }));
    }
    if (url.startsWith("https://api.openai.com/")) return new Response(JSON.stringify({ data: [{ embedding: vector }] }));
    if (url.startsWith("https://generativelanguage.googleapis.com/")) return new Response(JSON.stringify({ embedding: { values: vector } }));
    if (url.endsWith("/api/embed")) return new Response(JSON.stringify({ embeddings: [vector.slice(0, 1024)] }));
    return new Response("nicht erwartet", { status: 404 });
  }) as typeof fetch);
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  fetchSpy.mockRestore();
  warnSpy.mockRestore();
  while (cleanups.length) cleanups.pop()!();
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  facade.resetConvexClient();
});

const external = () => sent.filter(s => !s.url.startsWith("https://projekt.supabase.co/"));

describe("src/lib/supabase.ts generateEmbedding", () => {
  test("ohne EMBEDDING_PROVIDER: derselbe OpenAI-Aufruf wie vorher, gekürzt auf 8000 Zeichen", async () => {
    process.env.OPENAI_API_KEY = OPENAI_KEY;
    const text = "ä".repeat(9000);
    const result = await generateEmbedding(text);
    expect(result).toEqual(vector);
    expect(external()).toEqual([
      {
        url: "https://api.openai.com/v1/embeddings",
        headers: { Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
        body: { model: "text-embedding-3-small", input: "ä".repeat(8000) },
      },
    ]);
  });

  test("ohne Schlüssel: null, kein Aufruf, keine Warnung (Normalfall ohne semantische Suche)", async () => {
    expect(await generateEmbedding("Hallo")).toBeNull();
    expect(sent).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  test("EMBEDDING_PROVIDER=ollama: 1024 Werte werden auf 1536 aufgefüllt", async () => {
    process.env.EMBEDDING_PROVIDER = "ollama";
    const result = await generateEmbedding("Hallo");
    expect(external().map(s => s.url)).toEqual(["http://localhost:11434/api/embed"]);
    expect(result).toHaveLength(1536);
    expect(result!.slice(1024).every(v => v === 0)).toBe(true);
  });

  test("Fehler des Anbieters: null und eine Warnung ohne Schlüssel und ohne Antworttext", async () => {
    process.env.EMBEDDING_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = GEMINI_KEY;
    const passThrough = fetchSpy.getMockImplementation()!;
    fetchSpy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("https://generativelanguage.googleapis.com/")) {
        sent.push({ url: String(input), headers: {}, body: undefined });
        return new Response(`bad key ${GEMINI_KEY}`, { status: 403 });
      }
      return passThrough(input, init);
    }) as typeof fetch);
    expect(await generateEmbedding("Hallo")).toBeNull();
    expect(await generateEmbedding("Nochmal")).toBeNull();
    // Beide Male bei Google angefragt (die Kennung passte), nur einmal gewarnt
    expect(external().filter(s => s.url.startsWith("https://generativelanguage.googleapis.com/"))).toHaveLength(2);
    const logged = warnSpy.mock.calls.map((c: unknown[]) => c.join(" ")).join("\n");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(logged).not.toContain(GEMINI_KEY);
    expect(logged).not.toContain("bad key");
  });

  test("Anbieterkennung nicht lesbar (503) bzw. Festhalten gescheitert: auch ohne neue Variablen kein Vektor für Fakten und Suche", async () => {
    process.env.OPENAI_API_KEY = OPENAI_KEY;
    const passThrough = fetchSpy.getMockImplementation()!;
    for (const failing of ["/rest/v1/rpc/embedding_provider_status", "/rest/v1/rpc/claim_embedding_provider"]) {
      clearRegistryCache();
      sent.length = 0;
      fetchSpy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith(failing)) {
          sent.push({ url: String(input), headers: {}, body: undefined });
          return new Response("boom", { status: 503 });
        }
        return passThrough(input, init);
      }) as typeof fetch);
      // generateEmbedding liefert den Vektor für memory.embedding und für die Suche nach Fakten
      expect(await generateEmbedding("Hallo")).toBeNull();
      // Status gescheitert: OpenAI gar nicht gefragt; Festhalten gescheitert: gefragt, Vektor verworfen
      expect(external()).toHaveLength(failing.endsWith("status") ? 0 : 1);
    }
  });

  test("ungültiger EMBEDDING_PROVIDER: kein Aufruf, eine Warnung", async () => {
    process.env.EMBEDDING_PROVIDER = "cohere";
    process.env.OPENAI_API_KEY = OPENAI_KEY;
    expect(await generateEmbedding("Hallo")).toBeNull();
    expect(external()).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});

describe("Convex bleibt unverändert", () => {
  test("generateOpenAiEmbedding fragt OpenAI mit text-embedding-3-small, auch mit EMBEDDING_PROVIDER=gemini", async () => {
    process.env.OPENAI_API_KEY = OPENAI_KEY;
    process.env.EMBEDDING_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = GEMINI_KEY;
    expect(await generateOpenAiEmbedding("Frage")).toEqual(vector);
    expect(sent.map(s => [s.url, s.body])).toEqual([["https://api.openai.com/v1/embeddings", { model: "text-embedding-3-small", input: "Frage" }]]);
  });

  test("searchMessages mit Convex: Suchvektor von OpenAI, kein Gemini, kein Supabase", async () => {
    process.env.CONVEX_URL = "https://example.convex.cloud";
    process.env.CONVEX_AUTH_TOKEN = "test-convex-token";
    process.env.OPENAI_API_KEY = OPENAI_KEY;
    process.env.EMBEDDING_PROVIDER = "gemini";
    process.env.GEMINI_API_KEY = GEMINI_KEY;
    process.env.SUPABASE_URL = "https://projekt.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "sb_secret_attrappe";
    facade.resetConvexClient();
    let searchVector: number[] | undefined;
    const query = spyOn(ConvexHttpClient.prototype, "query").mockImplementation((async (ref: any) => {
      const name = getFunctionName(ref);
      if (name === "messages:textSearch") return [];
      throw new Error(`unerwartete Abfrage ${name}`);
    }) as any);
    const action = spyOn(ConvexHttpClient.prototype, "action").mockImplementation((async (ref: any, args: any) => {
      if (getFunctionName(ref) === "messages:semanticSearch") {
        searchVector = args.vector;
        return [];
      }
      throw new Error("unerwartete Aktion");
    }) as any);
    cleanups.push(() => {
      query.mockRestore();
      action.mockRestore();
    });
    await facade.searchMessages("123", "Urlaub", 5);
    expect(sent.map(s => [s.url, s.body])).toEqual([["https://api.openai.com/v1/embeddings", { model: "text-embedding-3-small", input: "Urlaub" }]]);
    expect(searchVector).toEqual(vector);
  });
});

describe("Ranking der Fakten (Issue #168)", () => {
  const target = { url: "https://projekt.supabase.co", key: "sb_secret_attrappe" };
  const facts = [
    { id: "1", type: "fact" as const, content: "Mia mag Tee", embedding: "[9,9]" },
    { id: "2", type: "fact" as const, content: "Alex wohnt in Hamburg", embedding: "[9,9]" },
  ];
  const query = { vector: [1, 0], config: { provider: "gemini" as const, model: "gemini-embedding-2" } };
  function rpc(answer: () => Response) {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchFn = async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return answer();
    };
    return { calls, fetchFn };
  }

  test("verglichen werden nur die Vektoren, die die Datenbank für Anbieter und Modell des Suchvektors herausgibt, nie die aus getFacts", async () => {
    const r = rpc(() => new Response(JSON.stringify([{ id: 2, embedding: "[0.5,0.5]" }])));
    const out = await verifiedFactVectors(facts as any, query, { target, fetch: r.fetchFn });
    expect(r.calls).toEqual([{ url: "https://projekt.supabase.co/rest/v1/rpc/embedding_fact_vectors", body: { p_provider: "gemini", p_model: "gemini-embedding-2" } }]);
    expect(out.queryEmbedding).toEqual([1, 0]);
    expect(out.facts.map(f => (f as any).embedding)).toEqual([null, [0.5, 0.5]]);
  });

  test("Umstellung oder anderer Anbieter (die Datenbank gibt nichts heraus) bzw. nicht lesbar: kein Ranking nach Vektoren", async () => {
    for (const answer of [() => new Response("[]"), () => new Response("boom", { status: 503 })]) {
      const r = rpc(answer);
      const out = await verifiedFactVectors(facts as any, query, { target, fetch: r.fetchFn });
      expect(out.queryEmbedding).toBeNull();
      expect(out.facts.every(f => (f as any).embedding === null)).toBe(true);
    }
  });

  test("Datenbank ohne Migration 20260928 (keine Umstellung möglich): Ranking wie vorher", async () => {
    const r = rpc(() => new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 }));
    const out = await verifiedFactVectors(facts as any, query, { target, fetch: r.fetchFn });
    expect(out.queryEmbedding).toEqual([1, 0]);
    expect(out.facts).toEqual(facts as any);
  });
});

describe("Bilder (asset-store)", () => {
  test("kein eigener Anbieterweg mehr: Embeddings über den Datenbank-Anbieter", () => {
    const source = readFileSync(join(import.meta.dir, "../src/lib/asset-store.ts"), "utf8");
    expect(source).toContain("embedWithConfig");
    expect(source).not.toContain("generativelanguage.googleapis.com");
    expect(source).not.toContain("api.openai.com");
  });
});
