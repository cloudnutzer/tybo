/**
 * Attrappen für die semantische Suche (Issue #166): ein fetch, das nach Host
 * verteilt. api.supabase.com geht an die Attrappe der Management-API
 * (supabase-api-fixture.ts, ergänzt um Functions und Geheimnisse),
 * api.openai.com an eine Embedding-Attrappe, die Projektadresse (Cloud oder
 * 127.0.0.1:54421) an nachgebaute Edge Functions und die REST-API der
 * Tabelle messages. Nichts geht ins Netz.
 */

import { readFile } from "node:fs/promises";
import type { HttpFetch, HttpRequest } from "../src/setup/context";
import { fakeSupabaseApi, SB, type FakeApi, type FakeState } from "./supabase-api-fixture";

/** Testwerte, keine echten Schlüssel */
export const OPENAI = {
  good: "sk-test-openai-schluessel-geheim-4242",
  other: "sk-test-anderer-openai-schluessel-geheim-1313",
  bad: "sk-test-abgelehnt-geheim-0000",
};

/** Issue #167: Gemini-Testschlüssel und die aus Docker erreichbare Ollama-Adresse */
export const GEMINI = {
  good: "AIza-test-gemini-schluessel-geheim-5151",
  bad: "AIza-test-gemini-abgelehnt-geheim-0000",
};
export const OLLAMA_DOCKER_URL = "http://host.docker.internal:11434";

/** Ollama auf diesem Rechner (localhost:11434) */
export interface FakeOllama {
  running: boolean;
  models: string[];
  /** Werte je Embedding */
  dims: number;
  /** Heruntergeladene Modelle (api/pull) */
  pulls: string[];
  /** Erreichen die Functions in Docker Ollama? */
  reachableFromDocker: boolean;
}

export interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Text, bei multipart die Formularfelder */
  body: string | Array<{ name: string; filename?: string; text: string }> | undefined;
}

export interface MessageRow {
  chat_id: string;
  role: string;
  content: string;
  embedded: boolean;
}

export interface FakeProjectState {
  /** Welche Schlüssel die Functions annehmen (apikey bzw. Authorization Bearer) */
  serviceKeys: string[];
  /** Ausgelieferte Functions (Cloud); lokal: alle, solange die Edge Runtime läuft */
  deployed: Set<string>;
  /** OpenAI-Schlüssel der Functions (Cloud: Geheimnis; lokal: Datei, beim Start gelesen) */
  runtimeKey: () => string | undefined;
  rows: MessageRow[];
  /** Löschen scheitert (HTTP 500) */
  failDelete: boolean;
  /** store-telegram-message antwortet 200 mit ok:false */
  storeNotOk: boolean;
  /** Anfragen an Functions hängen, bis signal auslöst */
  hangFunctions: boolean;
  /** Wird vor der Antwort von search-memory aufgerufen (etwa um abzubrechen) */
  onSearch?: () => void;
  /**
   * store-telegram-message antwortet nie (bis zum Abbruch der Anfrage) und
   * speichert die Probe erst nach so vielen Löschaufrufen für genau diese
   * Probe (wie eine Function, die noch auf OpenAI wartet)
   */
  storeAfterDeletes?: number;
  /**
   * Mit storeAfterDeletes: statt zu hängen antwortet das Gateway sofort mit
   * diesem Status (etwa 504), die Function läuft weiter und speichert später
   */
  storeGatewayStatus?: number;
  /** Löschaufrufe für einzelne Proben (chat_id=eq.) */
  eqDeletes: number;
  /**
   * Weitere Umgebung der Functions (Issue #167: EMBEDDING_PROVIDER,
   * EMBEDDING_MODEL, GEMINI_API_KEY, OLLAMA_URL); in der Cloud zusätzlich
   * die gesetzten Geheimnisse
   */
  runtimeEnv?: () => Record<string, string | undefined>;
  /** Anbieterkennung der Datenbank (embedding_settings): null = leer */
  registry: null | { provider: string; model: string } | "altbestand";
  /** Migration fehlt: die RPC-Funktionen antworten 404 */
  registryMissing: boolean;
  /** false: store-telegram-message meldet Anbieter und Modell nicht (Functions von vor der Prüfung zu #167) */
  reportsProvider?: boolean;
  /** Issue #168: laufende Umstellung (embedding_reindex) auf dieses Ziel; null: keine. leased: gehalten von holder */
  reindex?: null | { provider: string; model: string; leased?: boolean; holder?: string };
  /** Issue #168: Ausliefern der Functions scheitert (HTTP 500) */
  failDeploy?: boolean;
  /** Issue #168: Antwort von embedding_reindex_estimate */
  counts?: Record<string, { rows: number; chars: number }>;
  /** Issue #168: Migration 20260928 fehlt (die Reindex-RPCs antworten 404) */
  reindexMissing?: boolean;
}

export interface SearchFake {
  fetch: HttpFetch;
  sent: Sent[];
  api: FakeApi;
  project: FakeProjectState;
  /** Deploy-Aufrufe: slug, Metadaten, Dateinamen */
  deploys: Array<{ ref: string; slug: string; metadata: any; files: string[] }>;
  /** Geheimnisse der Cloud-Functions je Projekt */
  secrets: Record<string, Record<string, string>>;
  ollama: FakeOllama;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

async function recordBody(body: HttpRequest["body"]): Promise<Sent["body"]> {
  if (body === undefined || typeof body === "string") return body;
  const out: Array<{ name: string; filename?: string; text: string }> = [];
  for (const [name, value] of body.entries()) {
    if (typeof value === "string") out.push({ name, text: value });
    else out.push({ name, filename: (value as File).name, text: await (value as File).text() });
  }
  return out;
}

function authorized(headers: Record<string, string>, keys: string[]): boolean {
  const apikey = headers.apikey ?? "";
  const bearer = (headers.Authorization ?? "").replace(/^Bearer /, "");
  return keys.some(k => (k.startsWith("sb_") ? apikey === k : bearer === k && apikey === k));
}

export function searchFake(
  options: { state?: Partial<FakeState>; project?: Partial<FakeProjectState>; functionsEnvPath?: string; ollama?: Partial<FakeOllama> } = {},
): SearchFake {
  const api = fakeSupabaseApi({
    projects: [{ ref: SB.ref, name: "tybo", organization_slug: "org-alpha", status: "ACTIVE_HEALTHY" }],
    ...options.state,
  });
  const secrets: Record<string, Record<string, string>> = {};
  const deploys: SearchFake["deploys"] = [];
  const project: FakeProjectState = {
    serviceKeys: [SB.secret],
    deployed: new Set(),
    runtimeKey: () => secrets[SB.ref]?.OPENAI_API_KEY,
    rows: [],
    failDelete: false,
    storeNotOk: false,
    hangFunctions: false,
    eqDeletes: 0,
    registry: null,
    registryMissing: false,
    ...options.project,
  };
  const ollama: FakeOllama = { running: true, models: ["bge-m3:latest"], dims: 1024, pulls: [], reachableFromDocker: true, ...options.ollama };

  /**
   * Embedding der Functions wie in _shared/embedding.ts: Anbieter aus ihrer
   * Umgebung, Anbieterkennung prüfen und beim ersten Mal festhalten.
   * Ergebnis: embedded, der Kurzgrund embedding_status und, wenn ein Vektor
   * entstand, Anbieter und Modell (wie die echte Function).
   */
  function functionEmbedding(): { embedded: boolean; status: string; provider?: string; model?: string } {
    const env: Record<string, string | undefined> = { ...(secrets[SB.ref] ?? {}), ...(project.runtimeEnv?.() ?? {}), OPENAI_API_KEY: project.runtimeKey() };
    const provider = env.EMBEDDING_PROVIDER || "openai";
    const model = env.EMBEDDING_MODEL || { openai: "text-embedding-3-small", gemini: "gemini-embedding-2", ollama: "bge-m3" }[provider] || "";
    const key = provider === "openai" ? env.OPENAI_API_KEY : provider === "gemini" ? env.GEMINI_API_KEY : "ollama";
    if (!key) return { embedded: false, status: "kein-zugang" };
    const legacy = provider === "openai" && model === "text-embedding-3-small";
    // Erst lesen: festgehalten oder fehlende Migration entscheidet vor dem Embedding
    const r = project.registry;
    if (project.reindex) return { embedded: false, status: "gesperrt" };
    if (project.registryMissing ? !legacy : r !== null && (r === "altbestand" ? !legacy : r.provider !== provider || r.model !== model)) return { embedded: false, status: "gesperrt" };
    const result =
      provider === "openai"
        ? key === OPENAI.good || key === OPENAI.other ? { embedded: true, status: "ok" } : { embedded: false, status: "abgelehnt" }
        : provider === "gemini"
          ? key === GEMINI.good ? { embedded: true, status: "ok" } : { embedded: false, status: "abgelehnt" }
          : env.OLLAMA_URL === OLLAMA_DOCKER_URL && ollama.running && ollama.reachableFromDocker
            ? { embedded: true, status: "ok" }
            : { embedded: false, status: "nicht-erreichbar" };
    // Festgehalten wird erst nach einem gelungenen Embedding
    if (result.embedded && !project.registryMissing && project.registry === null) project.registry = project.rows.some(x => x.embedded) ? "altbestand" : { provider, model };
    return result.embedded ? { ...result, provider, model } : result;
  }
  const sent: Sent[] = [];
  /** Probe, die store-telegram-message noch speichern wird (storeAfterDeletes) */
  let late: MessageRow | undefined;

  // Management-API: Functions und Geheimnisse (vor den Standardrouten)
  api.hooks.push(async rec => {
    if (rec.headers.Authorization !== `Bearer ${SB.token}`) return undefined;
    const m = /^\/v1\/projects\/([a-z]{20})\/(functions\/deploy|secrets)(\?.*)?$/.exec(rec.path);
    if (!m) return undefined;
    const ref = m[1];
    if (!api.state.projects.some(p => p.ref === ref)) return json({ message: "not found" }, 404);
    if (m[2] === "functions/deploy" && rec.method === "POST") {
      if (project.failDeploy) return json({ message: "boom" }, 500);
      const slug = new URLSearchParams(m[3]?.slice(1) ?? "").get("slug") ?? "";
      const parts = await recordBody(rec.body as any);
      const fields = Array.isArray(parts) ? parts : [];
      const metadata = JSON.parse(fields.find(p => p.name === "metadata")?.text ?? "{}");
      deploys.push({ ref, slug, metadata, files: fields.filter(p => p.name === "file").map(p => p.filename ?? "") });
      project.deployed.add(slug);
      return json({ id: slug, slug, name: slug, status: "ACTIVE", version: 1, verify_jwt: metadata.verify_jwt }, 201);
    }
    if (m[2] === "secrets" && rec.method === "GET") return json(Object.keys(secrets[ref] ?? {}).map(name => ({ name, value: "digest" })));
    if (m[2] === "secrets" && rec.method === "POST") {
      secrets[ref] ??= {};
      for (const s of rec.body as Array<{ name: string; value: string }>) secrets[ref][s.name] = s.value;
      return json({}, 201);
    }
    return undefined;
  });

  async function projectRoute(u: URL, request: HttpRequest, headers: Record<string, string>): Promise<Response> {
    const path = u.pathname;
    const fn = /^\/functions\/v1\/([a-z-]+)$/.exec(path);
    if (fn) {
      if (project.hangFunctions) {
        await new Promise<void>((_, reject) => request.signal?.addEventListener("abort", () => reject(new DOMException("Abgebrochen", "AbortError")), { once: true }));
      }
      if (!project.deployed.has(fn[1])) return new Response("Function not found", { status: 404 });
      if (!authorized(headers, project.serviceKeys)) return new Response("Unauthorized", { status: 401 });
      const body = JSON.parse(String(request.body));
      const computed = functionEmbedding();
      const embedding = computed.embedded;
      if (fn[1] === "store-telegram-message") {
        if (project.storeAfterDeletes !== undefined) {
          // Die Anfrage gibt auf, die Function läuft weiter und speichert später
          late = { chat_id: body.chat_id, role: body.role, content: body.content, embedded: embedding };
          if (project.storeGatewayStatus !== undefined) return new Response("Gateway Timeout", { status: project.storeGatewayStatus });
          await new Promise<void>((_, reject) => request.signal?.addEventListener("abort", () => reject(new DOMException("Abgebrochen", "AbortError")), { once: true }));
        }
        if (project.storeNotOk) return json({ ok: false, error: "insert failed" });
        project.rows.push({ chat_id: body.chat_id, role: body.role, content: body.content, embedded: embedding });
        const used = project.reportsProvider === false ? {} : { embedding_provider: computed.provider, embedding_model: computed.model };
        return json({ ok: true, embedded: embedding, embedding_status: computed.status, ...used });
      }
      if (fn[1] === "search-memory") {
        project.onSearch?.();
        if (request.signal?.aborted) throw new DOMException("Abgebrochen", "AbortError");
        const mine = project.rows.filter(r => r.chat_id === body.chat_id);
        if (embedding) {
          const hits = mine.filter(r => r.embedded).map((r, i) => ({ id: i + 1, content: r.content, role: r.role, chat_id: r.chat_id, created_at: "", similarity: 0.97 }));
          if (hits.length) return json(hits);
        }
        return json(mine.filter(r => r.content.includes(body.query)).map((r, i) => ({ id: i + 1, ...r, metadata: {} })));
      }
      return json({ ok: true });
    }
    const reindexRpc = /^\/rest\/v1\/rpc\/(embedding_reindex_estimate|embedding_reindex_start|embedding_reindex_lease)$/.exec(path);
    if (reindexRpc && request.method === "POST") {
      if (!authorized(headers, project.serviceKeys)) return new Response("Unauthorized", { status: 401 });
      if (project.registryMissing || project.reindexMissing) return json({ code: "PGRST202" }, 404);
      const body = JSON.parse(String(request.body ?? "{}"));
      if (reindexRpc[1] === "embedding_reindex_estimate") {
        const zero = { rows: 0, chars: 0 };
        const c = project.counts ?? {};
        return json({ messages: c.messages ?? zero, memory: c.memory ?? zero, knowledge: c.knowledge ?? zero, assets: c.assets ?? zero });
      }
      const cur = project.reindex;
      if (reindexRpc[1] === "embedding_reindex_lease") {
        // Nur das Freigeben (p_seconds 0) durch den Inhaber braucht die Einrichtung
        if (!cur) return json({ state: "kein-lauf" });
        if (cur.leased && cur.holder !== body.p_holder) return json({ state: "belegt", provider: cur.provider, model: cur.model });
        project.reindex = body.p_seconds > 0 ? { ...cur, leased: true, holder: body.p_holder } : { provider: cur.provider, model: cur.model };
        return json({ state: "umstellung", run_id: "00000000-0000-4000-8000-000000000001", provider: cur.provider, model: cur.model, wait_ms: 0, progress: {}, queued: 0 });
      }
      // Wie embedding_reindex_start im SQL
      const lease = (target: { provider: string; model: string }) => (body.p_seconds > 0 ? { ...target, leased: true, holder: body.p_holder } : { ...target });
      if (cur) {
        const busy = !!cur.leased && cur.holder !== body.p_holder;
        if (cur.provider === body.p_provider && cur.model === body.p_model) {
          if (busy) return json({ state: "umstellung", run_id: "00000000-0000-4000-8000-000000000001", provider: cur.provider, model: cur.model, fresh: false, active: true });
          project.reindex = lease(cur);
          return json({ state: "umstellung", run_id: "00000000-0000-4000-8000-000000000001", provider: cur.provider, model: cur.model, fresh: false, active: false });
        }
        if (busy) return json({ state: "belegt", provider: cur.provider, model: cur.model });
      } else {
        const r = project.registry;
        if (r && r !== "altbestand" && r.provider === body.p_provider && r.model === body.p_model) return json({ state: "festgehalten", ...r });
      }
      project.reindex = lease({ provider: body.p_provider, model: body.p_model });
      return json({ state: "umstellung", run_id: "00000000-0000-4000-8000-000000000002", provider: body.p_provider, model: body.p_model, fresh: true, active: false });
    }
    const rpc = /^\/rest\/v1\/rpc\/(embedding_provider_status|claim_embedding_provider)$/.exec(path);
    if (rpc && request.method === "POST") {
      if (!authorized(headers, project.serviceKeys)) return new Response("Unauthorized", { status: 401 });
      if (project.registryMissing) return json({ code: "PGRST202" }, 404);
      const body = JSON.parse(String(request.body ?? "{}"));
      if (project.reindex) return json({ state: "umstellung", provider: project.reindex.provider, model: project.reindex.model });
      const vectors = project.rows.some(r => r.embedded);
      if (rpc[1] === "claim_embedding_provider" && project.registry === null) {
        project.registry = vectors ? "altbestand" : { provider: body.p_provider, model: body.p_model };
      }
      const r = project.registry;
      if (r === null) return json({ state: "leer", vectors });
      return json(r === "altbestand" ? { state: "altbestand", provider: null, model: null } : { state: "festgehalten", ...r });
    }
    if (path === "/rest/v1/messages" && request.method === "DELETE") {
      if (!authorized(headers, project.serviceKeys)) return new Response("Unauthorized", { status: 401 });
      if (project.failDelete) return new Response("boom", { status: 500 });
      const filter = u.searchParams.get("chat_id") ?? "";
      const before = project.rows;
      if (filter.startsWith("eq.")) project.rows = project.rows.filter(r => r.chat_id !== filter.slice(3));
      else if (filter.startsWith("like.") && filter.endsWith("*")) {
        const prefix = filter.slice(5, -1);
        project.rows = project.rows.filter(r => !r.chat_id.startsWith(prefix));
      }
      const removed = before.filter(r => !project.rows.includes(r));
      if (filter.startsWith("eq.")) {
        project.eqDeletes++;
        // Verspätetes Speichern: nach diesem Löschen
        if (late && project.eqDeletes >= (project.storeAfterDeletes ?? 0)) {
          project.rows.push(late);
          late = undefined;
        }
      }
      if ((headers.Prefer ?? "").includes("return=representation")) return json(removed.map(r => ({ chat_id: r.chat_id })));
      return new Response(null, { status: 204 });
    }
    return new Response("not found", { status: 404 });
  }

  const fetch: HttpFetch = async (url, request = {}) => {
    const u = new URL(url);
    const headers = { ...(request.headers ?? {}) };
    sent.push({ method: request.method ?? "GET", url, headers, body: await recordBody(request.body) });
    if (request.signal?.aborted) throw new DOMException("Abgebrochen", "AbortError");
    if (u.host === "api.supabase.com") return api.fetch(url, request);
    if (u.host === "api.openai.com") {
      const key = (headers.Authorization ?? "").replace(/^Bearer /, "");
      if (key === OPENAI.good || key === OPENAI.other) return json({ data: [{ embedding: [0.1, 0.2] }] });
      return json({ error: { message: `Incorrect API key provided: ${key}` } }, 401);
    }
    if (u.host === "generativelanguage.googleapis.com") {
      const key = headers["x-goog-api-key"] ?? "";
      if (u.search.includes("key=")) throw new Error("Schlüssel in der Adresse");
      if (key !== GEMINI.good) return json({ error: { message: `API key not valid: ${key}` } }, 400);
      const body = JSON.parse(String(request.body));
      return json({ embedding: { values: Array.from({ length: body.outputDimensionality ?? 3072 }, (_, i) => (i % 5) + 1) } });
    }
    if (u.host === "localhost:11434" || u.host === "127.0.0.1:11434") {
      if (!ollama.running) throw new TypeError("Unable to connect");
      const has = (m: string) => ollama.models.includes(m) || ollama.models.includes(`${m}:latest`);
      if (u.pathname === "/api/tags") return json({ models: ollama.models.map(name => ({ name, model: name })) });
      if (u.pathname === "/api/pull") {
        const body = JSON.parse(String(request.body));
        ollama.pulls.push(body.model);
        ollama.models.push(body.model.includes(":") ? body.model : `${body.model}:latest`);
        return json({ status: "success" });
      }
      if (u.pathname === "/api/embed") {
        const body = JSON.parse(String(request.body));
        if (!has(body.model)) return json({ error: `model "${body.model}" not found` }, 404);
        return json({ model: body.model, embeddings: [Array.from({ length: ollama.dims }, (_, i) => (i % 3) + 1)] });
      }
      return json({}, 404);
    }
    if (u.host === `${SB.ref}.supabase.co` || u.host === "127.0.0.1:54421" || u.host === "db.example.org") return projectRoute(u, request, headers);
    throw new Error(`Unerwartete Adresse in Tests: ${u.host}`);
  };

  return { fetch, sent, api, project, deploys, secrets, ollama };
}

/** OpenAI-Schlüssel der lokalen Edge Runtime: gelesen aus supabase/functions/.env beim letzten Start */
export function localRuntime(functionsEnvPath: string) {
  let loaded: Record<string, string> = {};
  return {
    key: () => loaded.OPENAI_API_KEY,
    /** Alle Werte beim letzten Start (Issue #167: Anbieter, Modell, Ollama-Adresse) */
    env: () => ({ ...loaded }),
    async start() {
      const text = await readFile(functionsEnvPath, "utf8").catch(() => "");
      loaded = {};
      for (const line of text.split("\n")) {
        const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
        if (m) loaded[m[1]] = m[2];
      }
    },
  };
}
