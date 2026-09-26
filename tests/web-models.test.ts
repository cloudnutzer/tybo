/**
 * Issue #36, Checkbox 4: Modell-Listen. Netz immer als Attrappe, Uhr
 * injiziert; kein Zugriff auf openrouter.ai oder ein lokales Ollama.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLAUDE_MODELS,
  createModelCatalog,
  MODELS_CACHE_MS,
  OLLAMA_TAGS_URL,
  OPENROUTER_MODELS_URL,
  type ModelCatalogOptions,
} from "../src/web/models";
import type { WebServer } from "../src/web/server";
import { topicServer } from "./topic-fixture";

type Handler = (url: string, signal: AbortSignal) => Promise<Response>;

const OPENROUTER_BODY = {
  data: [
    { id: "vendor/a", name: "Modell A", pricing: { prompt: "1" }, description: "lang" },
    { id: "vendor/b" },
    { id: "vendor/a", name: "doppelt" },
    { id: 5, name: "kaputt" },
    { name: "ohne id" },
  ],
};
const OLLAMA_BODY = { models: [{ name: "qwen3:8b", size: 1 }, { name: "llama9:latest" }, { model: "ohne name" }] };

/** Netz-Attrappe: zählt Aufrufe pro Adresse, Antwort pro Adresse austauschbar */
function fakeNet(handlers: Partial<Record<string, Handler>> = {}) {
  const calls: string[] = [];
  const routes: Record<string, Handler> = {
    [OPENROUTER_MODELS_URL]: async () => Response.json(OPENROUTER_BODY),
    [OLLAMA_TAGS_URL]: async () => Response.json(OLLAMA_BODY),
    ...handlers,
  };
  const fetch: NonNullable<ModelCatalogOptions["fetch"]> = (url, init) => {
    calls.push(url);
    const h = routes[url];
    if (!h) return Promise.reject(new Error(`unerwartete Adresse ${url}`));
    return h(url, init.signal);
  };
  return { fetch, calls, routes };
}

function count(calls: string[], url: string): number {
  return calls.filter(c => c === url).length;
}

describe("Modell-Listen", () => {
  test("Claude fest, OpenRouter nur id und name, Ollama nur Namen", async () => {
    const net = fakeNet();
    const lists = await createModelCatalog({ fetch: net.fetch }).list();
    expect(lists).toEqual({
      claude: { models: [...CLAUDE_MODELS], custom: true },
      openrouter: { models: [{ id: "vendor/a", name: "Modell A" }, { id: "vendor/b", name: "vendor/b" }] },
      ollama: { models: ["qwen3:8b", "llama9:latest"] },
    });
    expect(CLAUDE_MODELS).toEqual(["claude-opus-5-5", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5-20251001"]);
  });

  test("OpenRouter aus dem Zwischenspeicher bis 10 Minuten, danach neu; Ollama jedes Mal", async () => {
    const net = fakeNet();
    let t = 1_000_000;
    const catalog = createModelCatalog({ fetch: net.fetch, now: () => t });
    await catalog.list();
    t += MODELS_CACHE_MS - 1;
    const cached = await catalog.list();
    expect(cached.openrouter.models).toHaveLength(2);
    expect(count(net.calls, OPENROUTER_MODELS_URL)).toBe(1);
    expect(count(net.calls, OLLAMA_TAGS_URL)).toBe(2);
    t += 1;
    await catalog.list();
    expect(count(net.calls, OPENROUTER_MODELS_URL)).toBe(2);
  });

  test("gleichzeitige Aufrufe teilen sich eine OpenRouter-Abfrage", async () => {
    const net = fakeNet();
    const catalog = createModelCatalog({ fetch: net.fetch });
    const results = await Promise.all([catalog.list(), catalog.list(), catalog.list()]);
    expect(results.every(r => r.openrouter.models.length === 2)).toBe(true);
    expect(count(net.calls, OPENROUTER_MODELS_URL)).toBe(1);
  });

  test("OpenRouter-Fehler: leere Liste mit Fehlertext, nicht zwischengespeichert, Ollama unberührt", async () => {
    const cases: [Handler, string][] = [
      [async () => new Response("kaputt", { status: 500 }), "OpenRouter antwortet mit HTTP 500"],
      [async () => new Response("<html>", { status: 200 }), "OpenRouter liefert keine gültige Modellliste"],
      [async () => Response.json({ data: "nein" }), "OpenRouter liefert keine gültige Modellliste"],
      [async () => Response.json(null), "OpenRouter liefert keine gültige Modellliste"],
      [async () => Promise.reject(new Error("getaddrinfo ENOTFOUND geheim.intern")), "OpenRouter ist nicht erreichbar"],
    ];
    for (const [handler, error] of cases) {
      const logs: string[] = [];
      const net = fakeNet({ [OPENROUTER_MODELS_URL]: handler });
      const catalog = createModelCatalog({ fetch: net.fetch, log: m => logs.push(m) });
      const lists = await catalog.list();
      expect(lists.openrouter).toEqual({ models: [], error });
      expect(lists.ollama.models).toHaveLength(2);
      expect(logs.join("\n")).not.toContain("geheim.intern");
      // Fehler nicht gemerkt: nach Behebung sofort wieder da
      net.routes[OPENROUTER_MODELS_URL] = async () => Response.json(OPENROUTER_BODY);
      expect((await catalog.list()).openrouter.models).toHaveLength(2);
      expect(count(net.calls, OPENROUTER_MODELS_URL)).toBe(2);
    }
  });

  test("Fehler nach erfolgreichem Abruf lässt den Zwischenspeicher bis zum Ablauf gelten", async () => {
    const net = fakeNet();
    let t = 0;
    const catalog = createModelCatalog({ fetch: net.fetch, now: () => t });
    await catalog.list();
    net.routes[OPENROUTER_MODELS_URL] = async () => new Response("", { status: 503 });
    t += 60_000;
    expect((await catalog.list()).openrouter.models).toHaveLength(2);
    t += MODELS_CACHE_MS;
    expect((await catalog.list()).openrouter).toEqual({ models: [], error: "OpenRouter antwortet mit HTTP 503" });
  });

  test("Ollama: nicht erreichbar, HTTP-Fehler, ungültiges JSON, falsche Form", async () => {
    const cases: [Handler, string][] = [
      [async () => Promise.reject(new TypeError("fetch failed ECONNREFUSED 127.0.0.1:11434")), "Ollama ist nicht erreichbar"],
      [async () => new Response("", { status: 404 }), "Ollama antwortet mit HTTP 404"],
      [async () => new Response("{nicht json", { status: 200 }), "Ollama liefert keine gültige Modellliste"],
      [async () => Response.json({ models: {} }), "Ollama liefert keine gültige Modellliste"],
    ];
    for (const [handler, error] of cases) {
      const net = fakeNet({ [OLLAMA_TAGS_URL]: handler });
      const lists = await createModelCatalog({ fetch: net.fetch }).list();
      expect(lists.ollama).toEqual({ models: [], error });
      expect(lists.openrouter.models).toHaveLength(2);
    }
  });

  test("Zeitüberschreitung: hängendes Ollama blockiert nicht, Abfrage wird abgebrochen", async () => {
    let aborted = false;
    const net = fakeNet({
      // Beachtet das Signal, antwortet sonst nie
      [OLLAMA_TAGS_URL]: (_url, signal) =>
        new Promise((_, reject) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("abgebrochen"));
          });
        }),
      // Ignoriert das Signal und hängt im Body
      [OPENROUTER_MODELS_URL]: async () =>
        new Response(new ReadableStream({ start() {} }), { status: 200 }),
    });
    const started = Date.now();
    const lists = await createModelCatalog({ fetch: net.fetch, timeoutMs: 50 }).list();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(lists.ollama).toEqual({ models: [], error: "Ollama antwortet nicht (Zeitüberschreitung)" });
    expect(lists.openrouter).toEqual({ models: [], error: "OpenRouter antwortet nicht (Zeitüberschreitung)" });
    expect(aborted).toBe(true);
  });
});

const root = await mkdtemp(join(tmpdir(), "tybo-models-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
});

describe("GET /api/models", () => {

  test("angemeldet 200 mit allen drei Listen, sonst 401; nur GET", async () => {
    const net = fakeNet({ [OLLAMA_TAGS_URL]: async () => Promise.reject(new Error("aus")) });
    const ctx = await topicServer(root, servers, null, { models: createModelCatalog({ fetch: net.fetch }) });
    const res = await ctx.api("/api/models");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.claude.custom).toBe(true);
    expect(body.openrouter.models).toHaveLength(2);
    expect(body.ollama).toEqual({ models: [], error: "Ollama ist nicht erreichbar" });
    expect((await fetch(`${ctx.origin}/api/models`)).status).toBe(401);
    expect((await ctx.api("/api/models", "POST", {})).status).toBe(405);
  });
});
