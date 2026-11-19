/** Issue #674: echter lokaler Web-Server, OpenRouter ausschließlich als Attrappe. */
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDemoServer } from "../src/web/demo";
import { createOpenRouterKey, OPENROUTER_KEY_TEXT, type OpenRouterKeyOptions } from "../src/web/openrouter-key";
import type { WebServer } from "../src/web/server";
import { PASSWORD, topicServer } from "./topic-fixture";

const root = await mkdtemp(join(tmpdir(), "web-openrouter-api-"));
const servers: WebServer[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await server.stop({ graceMs: 50 }); });
afterAll(() => rm(root, { recursive: true, force: true }));
const MARKER = "TESTWERT-674-API";
const DATA = { limit: 50, limit_remaining: 12.4, limit_reset: "monthly", usage: 37.6, usage_monthly: 3.2, label: MARKER };

describe("GET /api/engines/openrouter", () => {
  test("ohne Login 401, POST 405, angemeldet 200 mit ausschließlich erlaubten Feldern", async () => {
    let calls = 0;
    const logs: string[] = [];
    const ctx = await topicServer(root, servers, null, { openrouterKey: createOpenRouterKey({
      key: () => MARKER, now: () => 0, log: m => logs.push(m),
      fetch: async () => { calls++; return Response.json({ data: DATA, key: MARKER }); },
    }) });
    expect((await fetch(`${ctx.origin}/api/engines/openrouter`)).status).toBe(401);
    const post = await ctx.api("/api/engines/openrouter", "POST", {});
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
    expect(calls).toBe(0);
    const response = await ctx.api("/api/engines/openrouter");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ configured: true, limit: 50, remaining: 12.4, limitReset: "monthly",
      usage: 37.6, usageMonthly: 3.2, fetchedAt: "1970-01-01T00:00:00.000Z" });
    expect(JSON.stringify([body, logs, ctx.logs])).not.toContain(MARKER);
    expect(await (await ctx.api("/api/engines/openrouter")).json()).toEqual(body);
    expect(calls).toBe(1);
  });

  test("ohne Port selbst mit Umgebungswert kein externer Abruf; ohne Schlüssel kein Abruf des Ports", async () => {
    let calls = 0;
    const bare = await topicServer(root, servers, null);
    const empty = await topicServer(root, servers, null, { openrouterKey: createOpenRouterKey({
      key: () => " ", fetch: async () => { calls++; return Response.json({ data: DATA }); },
    }) });
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.OPENROUTER_API_KEY;
    process.env.OPENROUTER_API_KEY = MARKER;
    const external: string[] = [];
    const guard = spyOn(globalThis, "fetch").mockImplementation(((input, init) => {
      const url = String(input);
      if (url.startsWith(bare.origin + "/") || url.startsWith(empty.origin + "/")) return originalFetch(input, init);
      external.push(url);
      return Promise.reject(new Error("Unerlaubtes Netz im Test"));
    }) as typeof fetch);
    try {
      for (const ctx of [bare, empty]) {
        const response = await ctx.api("/api/engines/openrouter");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ configured: false });
      }
      expect(calls).toBe(0);
      expect(external).toEqual([]);
    } finally {
      guard.mockRestore();
      if (originalKey === undefined) delete process.env.OPENROUTER_API_KEY;
      else process.env.OPENROUTER_API_KEY = originalKey;
    }
  });

  const cases: [string, NonNullable<OpenRouterKeyOptions["fetch"]>, string][] = [
    ["401", async () => new Response(MARKER, { status: 401 }), OPENROUTER_KEY_TEXT.rejected],
    ["403", async () => new Response(MARKER, { status: 403 }), OPENROUTER_KEY_TEXT.rejected],
    ["Zeitlimit", async () => new Promise(() => {}), OPENROUTER_KEY_TEXT.timeout],
    ["Netzfehler", async () => { throw new Error(MARKER); }, OPENROUTER_KEY_TEXT.unavailable],
    ["JSON", async () => new Response(`{${MARKER}`), OPENROUTER_KEY_TEXT.unavailable],
  ];
  for (const [label, fetch, error] of cases) test(`${label}: Zustand mit 200, fester Text und kein Geheimnis`, async () => {
    const logs: string[] = [];
    const ctx = await topicServer(root, servers, null, { openrouterKey: createOpenRouterKey({
      key: () => MARKER, fetch, timeoutMs: 15, log: m => logs.push(m),
    }) });
    const response = await ctx.api("/api/engines/openrouter");
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ configured: true, error });
    expect(JSON.stringify([body, logs, ctx.logs])).not.toContain(MARKER);
  });

  test("unerwarteter Portfehler gibt ebenfalls nur festen Zustand zurück", async () => {
    const ctx = await topicServer(root, servers, null, { openrouterKey: { read: async () => { throw new Error(MARKER); } } });
    const response = await ctx.api("/api/engines/openrouter");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: true, error: OPENROUTER_KEY_TEXT.unavailable });
    expect(ctx.logs.join("\n")).not.toContain(MARKER);
  });

  test("Demo liefert fertige Beispieldaten mit Limit und relativem Alter", async () => {
    const before = Date.now();
    const demo = await startDemoServer({ host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] });
    try {
      const login = await fetch(`${demo.server.url}/api/login`, { method: "POST", headers: { origin: demo.server.url }, body: JSON.stringify({ password: PASSWORD }) });
      const cookie = login.headers.get("set-cookie")!.split(";")[0];
      const response = await fetch(`${demo.server.url}/api/engines/openrouter`, { headers: { cookie } });
      expect(response.status).toBe(200);
      const { fetchedAt, ...body } = await response.json();
      expect(body).toEqual({ configured: true, limit: 50, remaining: 12.4, limitReset: "monthly", usage: 37.6, usageMonthly: 3.2 });
      expect(Date.parse(fetchedAt)).toBeGreaterThanOrEqual(before - 180_000);
      expect(Date.parse(fetchedAt)).toBeLessThanOrEqual(Date.now() - 180_000);
    } finally { await demo.stop(); }
  });
});
