/**
 * Issue #167: gemeinsamer Embedding-Baustein (supabase/functions/_shared/embedding.ts).
 * Drei Anbieter mit fetch-Attrappe, Auffüllen auf 1536 Werte, feste
 * Fehlermeldungen ohne Schlüssel. Kein Netz.
 */
import { describe, expect, test } from "bun:test";
import {
  cosineSimilarity,
  createEmbedding,
  DEFAULT_EMBEDDING_MODELS,
  EMBEDDING_DIMENSIONS,
  embeddingConfig,
  fitDimensions,
  hasCredentials,
  isLegacyDefault,
  type EmbeddingConfig,
  type EnvReader,
  type FetchLike,
} from "../supabase/functions/_shared/embedding";

// Erfundene Werte, keine echten Schlüssel
const OPENAI_KEY = "sk-test-embedding-geheim-4711";
const GEMINI_KEY = "AIza-test-embedding-geheim-0815";

const reader = (values: Record<string, string>): EnvReader => name => values[name];

interface Call {
  url: string;
  method?: string;
  headers: Record<string, string>;
  body: any;
}

function fakeFetch(reply: (call: Call) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    const call: Call = { url, method: init.method, headers: { ...(init.headers as Record<string, string>) }, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return reply(call);
  };
  return { fetch, calls };
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
const vec = (n: number, f = (i: number) => Math.sin(i + 1)) => Array.from({ length: n }, (_, i) => f(i));

function config(env: Record<string, string>): EmbeddingConfig {
  const r = embeddingConfig(reader(env));
  if (!r.ok) throw new Error(r.message);
  return r.config;
}

describe("Konfiguration", () => {
  test("ohne Variablen: OpenAI mit text-embedding-3-small, also das Verhalten vor #167", () => {
    const c = config({});
    expect(c).toEqual({ provider: "openai", model: "text-embedding-3-small" });
    expect(isLegacyDefault(c)).toBe(true);
  });

  test("Anbieter und Modell aus EMBEDDING_PROVIDER und EMBEDDING_MODEL, Standardmodell je Anbieter", () => {
    expect(config({ EMBEDDING_PROVIDER: "gemini" })).toEqual({ provider: "gemini", model: DEFAULT_EMBEDDING_MODELS.gemini });
    expect(config({ EMBEDDING_PROVIDER: " Ollama " })).toEqual({ provider: "ollama", model: "bge-m3" });
    expect(config({ EMBEDDING_PROVIDER: "ollama", EMBEDDING_MODEL: "nomic-embed-text:latest" })).toEqual({ provider: "ollama", model: "nomic-embed-text:latest" });
    expect(isLegacyDefault(config({ EMBEDDING_PROVIDER: "openai", EMBEDDING_MODEL: "text-embedding-3-large" }))).toBe(false);
  });

  test("unbekannter Anbieter oder seltsamer Modellname: Fehler statt stiller Rückfall", () => {
    expect(embeddingConfig(reader({ EMBEDDING_PROVIDER: "cohere" })).ok).toBe(false);
    expect(embeddingConfig(reader({ EMBEDDING_MODEL: "a b" })).ok).toBe(false);
    expect(embeddingConfig(reader({ EMBEDDING_MODEL: "x".repeat(201) })).ok).toBe(false);
  });

  test("Zugang: Schlüssel je Anbieter, Ollama braucht nur eine gültige Adresse", () => {
    expect(hasCredentials(config({}), reader({}))).toBe(false);
    expect(hasCredentials(config({}), reader({ OPENAI_API_KEY: OPENAI_KEY }))).toBe(true);
    expect(hasCredentials(config({ EMBEDDING_PROVIDER: "gemini" }), reader({ OPENAI_API_KEY: OPENAI_KEY }))).toBe(false);
    expect(hasCredentials(config({ EMBEDDING_PROVIDER: "ollama" }), reader({}))).toBe(true);
    expect(hasCredentials(config({ EMBEDDING_PROVIDER: "ollama" }), reader({ OLLAMA_URL: "ftp://x" }))).toBe(false);
  });
});

describe("OpenAI", () => {
  test("ohne neue Variablen genau die Anfrage von vorher: Adresse, Köpfe, Rumpf nur model und input", async () => {
    const { fetch, calls } = fakeFetch(() => json({ data: [{ embedding: vec(1536) }] }));
    const env = { OPENAI_API_KEY: OPENAI_KEY };
    const r = await createEmbedding("Hallo Welt", config(env), reader(env), fetch);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0].method).toBe("POST");
    expect(calls[0].headers).toEqual({ Authorization: `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" });
    expect(calls[0].body).toEqual({ model: "text-embedding-3-small", input: "Hallo Welt" });
    expect(Object.keys(calls[0].body)).toEqual(["model", "input"]);
  });

  test("anderes text-embedding-3-Modell verlangt 1536 Werte (dimensions)", async () => {
    const { fetch, calls } = fakeFetch(() => json({ data: [{ embedding: vec(1536) }] }));
    const env = { OPENAI_API_KEY: OPENAI_KEY, EMBEDDING_MODEL: "text-embedding-3-large" };
    await createEmbedding("x", config(env), reader(env), fetch);
    expect(calls[0].body).toEqual({ model: "text-embedding-3-large", input: "x", dimensions: 1536 });
  });

  test("ohne Schlüssel keine Anfrage", async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const r = await createEmbedding("x", config({}), reader({}), fetch);
    expect(r).toMatchObject({ ok: false, reason: "kein-zugang" });
    expect(calls).toHaveLength(0);
  });

  test("abgelehnter Schlüssel: feste Meldung, der Antworttext (mit Schlüsselteilen) geht nicht weiter", async () => {
    const { fetch } = fakeFetch(() => json({ error: { message: `Incorrect API key provided: ${OPENAI_KEY}` } }, 401));
    const env = { OPENAI_API_KEY: OPENAI_KEY };
    const r = await createEmbedding("x", config(env), reader(env), fetch);
    expect(r).toMatchObject({ ok: false, reason: "abgelehnt" });
    expect(JSON.stringify(r)).not.toContain(OPENAI_KEY);
    expect(JSON.stringify(r)).not.toContain("Incorrect");
  });

  test("Netzfehler mit Schlüssel in der Fehlermeldung: feste Meldung", async () => {
    const fetch: FetchLike = async () => {
      throw new Error(`connect failed for ${OPENAI_KEY}`);
    };
    const env = { OPENAI_API_KEY: OPENAI_KEY };
    const r = await createEmbedding("x", config(env), reader(env), fetch);
    expect(r).toMatchObject({ ok: false, reason: "nicht-erreichbar" });
    expect(JSON.stringify(r)).not.toContain(OPENAI_KEY);
  });
});

describe("Gemini", () => {
  test("verlangt 1536 Werte (outputDimensionality), Schlüssel nur im Kopf, nie in der Adresse", async () => {
    const { fetch, calls } = fakeFetch(() => json({ embedding: { values: vec(1536) } }));
    const env = { EMBEDDING_PROVIDER: "gemini", GEMINI_API_KEY: GEMINI_KEY };
    const r = await createEmbedding("Hallo", config(env), reader(env), fetch);
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:embedContent");
    expect(calls[0].url).not.toContain(GEMINI_KEY);
    expect(calls[0].headers["x-goog-api-key"]).toBe(GEMINI_KEY);
    expect(calls[0].body).toEqual({ model: "models/gemini-embedding-2", content: { parts: [{ text: "Hallo" }] }, outputDimensionality: 1536 });
    if (r.ok) expect(r.vector).toHaveLength(EMBEDDING_DIMENSIONS);
  });

  test("ohne GEMINI_API_KEY keine Anfrage, auch wenn OPENAI_API_KEY gesetzt ist", async () => {
    const { fetch, calls } = fakeFetch(() => json({}));
    const env = { EMBEDDING_PROVIDER: "gemini", OPENAI_API_KEY: OPENAI_KEY };
    expect(await createEmbedding("x", config(env), reader(env), fetch)).toMatchObject({ ok: false, reason: "kein-zugang" });
    expect(calls).toHaveLength(0);
  });

  test("Fehler 429: feste Meldung ohne Schlüssel", async () => {
    const { fetch } = fakeFetch(() => json({ error: { message: `quota ${GEMINI_KEY}` } }, 429));
    const env = { EMBEDDING_PROVIDER: "gemini", GEMINI_API_KEY: GEMINI_KEY };
    const r = await createEmbedding("x", config(env), reader(env), fetch);
    expect(r).toMatchObject({ ok: false, reason: "abgelehnt" });
    expect(JSON.stringify(r)).not.toContain(GEMINI_KEY);
  });
});

describe("Ollama", () => {
  test("Standardadresse localhost:11434, /api/embed mit model und input", async () => {
    const { fetch, calls } = fakeFetch(() => json({ model: "bge-m3", embeddings: [vec(1024)] }));
    const env = { EMBEDDING_PROVIDER: "ollama" };
    const r = await createEmbedding("Hallo", config(env), reader(env), fetch);
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe("http://localhost:11434/api/embed");
    expect(calls[0].body).toEqual({ model: "bge-m3", input: "Hallo" });
  });

  test("OLLAMA_URL, etwa die aus Docker erreichbare Adresse", async () => {
    const { fetch, calls } = fakeFetch(() => json({ embeddings: [vec(768)] }));
    const env = { EMBEDDING_PROVIDER: "ollama", OLLAMA_URL: "http://host.docker.internal:11434/" };
    await createEmbedding("x", config(env), reader(env), fetch);
    expect(calls[0].url).toBe("http://host.docker.internal:11434/api/embed");
  });

  test("768 Werte werden auf 1536 aufgefüllt; die Kosinus-Ähnlichkeit zweier Vektoren bleibt gleich", async () => {
    const a = vec(768, i => Math.sin(i * 0.7) + 0.1);
    const b = vec(768, i => 0.6 * (Math.sin(i * 0.7) + 0.1) + Math.cos(i * 0.3));
    const replies = [a, b];
    const { fetch } = fakeFetch(() => json({ embeddings: [replies.shift()] }));
    const env = { EMBEDDING_PROVIDER: "ollama" };
    const ra = await createEmbedding("a", config(env), reader(env), fetch);
    const rb = await createEmbedding("b", config(env), reader(env), fetch);
    if (!ra.ok || !rb.ok) throw new Error("kein Vektor");
    expect(ra.vector).toHaveLength(1536);
    expect(ra.vector.slice(0, 768)).toEqual(a);
    expect(ra.vector.slice(768).every(v => v === 0)).toBe(true);
    const before = cosineSimilarity(a, b);
    const after = cosineSimilarity(ra.vector, rb.vector);
    expect(Math.abs(before)).toBeGreaterThan(0.01);
    expect(after).toBeCloseTo(before, 12);
  });

  test("mehr als 1536 Werte: klare Fehlermeldung mit der Zahl, nichts gekürzt", async () => {
    const { fetch } = fakeFetch(() => json({ embeddings: [vec(3072)] }));
    const env = { EMBEDDING_PROVIDER: "ollama", EMBEDDING_MODEL: "grosses-modell" };
    const r = await createEmbedding("x", config(env), reader(env), fetch);
    expect(r).toMatchObject({ ok: false, reason: "zu-viele-werte" });
    if (!r.ok) expect(r.message).toContain("3072");
  });

  test("Ollama läuft nicht: nicht erreichbar", async () => {
    const fetch: FetchLike = async () => {
      throw new TypeError("Unable to connect");
    };
    const env = { EMBEDDING_PROVIDER: "ollama" };
    expect(await createEmbedding("x", config(env), reader(env), fetch)).toMatchObject({ ok: false, reason: "nicht-erreichbar" });
  });
});

describe("Ungültige Vektoren", () => {
  test("fehlend, leer, keine Zahlen, NaN, nur Nullen: abgelehnt", () => {
    for (const bad of [undefined, null, [], ["0.1"], [0.1, Number.NaN], [0.1, Number.POSITIVE_INFINITY], [0, 0, 0], { 0: 1 }]) {
      expect(fitDimensions(bad)).toMatchObject({ ok: false, reason: "ungueltig" });
    }
  });

  test("genau 1536 bleibt unverändert, 1537 ist zu viel", () => {
    const exact = vec(1536);
    expect(fitDimensions(exact)).toEqual({ ok: true, vector: exact });
    expect(fitDimensions(vec(1537))).toMatchObject({ ok: false, reason: "zu-viele-werte" });
  });

  test("kaputte Antwort des Anbieters (kein JSON, falsche Form): ungültig, ohne Antworttext", async () => {
    const env = { OPENAI_API_KEY: OPENAI_KEY };
    const broken = fakeFetch(() => new Response("<html>oops</html>", { status: 200 }));
    expect(await createEmbedding("x", config(env), reader(env), broken.fetch)).toMatchObject({ ok: false, reason: "ungueltig" });
    const wrong = fakeFetch(() => json({ data: [] }));
    expect(await createEmbedding("x", config(env), reader(env), wrong.fetch)).toMatchObject({ ok: false, reason: "ungueltig" });
  });
});
