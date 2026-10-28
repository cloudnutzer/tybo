/**
 * Issue #37, Checkbox 4: Verdrahtung. startWebUi reicht den Status an
 * createServer weiter; createBotStatus übergibt startBotWeb
 * (tests/app-bot-web.test.ts); web:dev und Demo nutzen die
 * Attrappe, die nie den echten Neustart-Marker schreibt.
 */

import { describe, expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createDemoStatus, startDemoServer } from "../src/web/demo";
import type { WebServer, WebServerDeps } from "../src/web/server";
import { startWebUi } from "../src/web/startup";

const repo = resolve(import.meta.dir, "..");

describe("startWebUi", () => {
  test("reicht status an createServer weiter", async () => {
    const status = createDemoStatus();
    let received: WebServerDeps | null = null;
    const server = await startWebUi({
      env: { WEB_ENABLED: "true", WEB_PASSWORD: "test-passwort-lang" },
      chat: { runTurn: async () => ({ text: "" }), stop() {} },
      status,
      createServer: async (_config, deps) => {
        received = deps;
        return { url: "http://127.0.0.1:3100", eventStreamCount: () => 0, stop: async () => {} } as WebServer;
      },
      log: () => {},
      lanAddresses: () => [],
    });
    expect(server).not.toBeNull();
    expect(received!.status).toBe(status);
  });
});

// Übergabe an startWebUi: Verhalten in tests/app-bot-web.test.ts (Issue #344)


describe("web:dev und Demo", () => {
  test("scripts/web-dev.ts nutzt die Status-Attrappe, nie bot-status", async () => {
    const src = await Bun.file(join(repo, "scripts", "web-dev.ts")).text();
    expect(src).toContain("status: createDemoStatus(),");
    expect(src).not.toContain("bot-status");
    expect(src).not.toContain("restart-request");
  });

  test("demo.ts importiert weder restart-request noch bot-status", async () => {
    const src = await Bun.file(join(repo, "src", "web", "demo.ts")).text();
    const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map(m => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const path of imports) expect(/restart-request|bot-status/.test(path)).toBe(false);
  });

  test("Demo: Status abrufbar, Neustart nur im Speicher, kein Marker unter data/", async () => {
    const marker = join(repo, "data", "restart-requested");
    const before = await stat(marker).then(s => s.mtimeMs, () => null);
    const status = createDemoStatus();
    const demo = await startDemoServer({ host: "127.0.0.1", port: 0, password: "test-passwort-lang", allowedHosts: [] }, { status, log: () => {} });
    const origin = demo.server.url;
    try {
      const body = await (await fetch(`${origin}/api/status`)).json();
      expect(body.version).toEqual({ app: "0.0.0-demo", commit: "demo000" });
      expect(body.restartRequested).toBe(false);
      expect(JSON.stringify(body)).not.toContain('"demo"');
      const res = await fetch(`${origin}/api/restart`, { method: "POST", headers: { origin } });
      expect(res.status).toBe(202);
      expect(status.restartNotes).toEqual(["WebUI"]);
      expect((await (await fetch(`${origin}/api/status`)).json()).restartRequested).toBe(true);
    } finally {
      await demo.stop();
    }
    expect(await stat(marker).then(s => s.mtimeMs, () => null)).toBe(before);
  });

  test("Demo ohne Supervisor: 409", async () => {
    const demo = await startDemoServer(
      { host: "127.0.0.1", port: 0, password: "test-passwort-lang", allowedHosts: [] },
      { status: createDemoStatus({ supervisor: null }), log: () => {} }
    );
    const origin = demo.server.url;
    try {
      expect((await fetch(`${origin}/api/restart`, { method: "POST", headers: { origin } })).status).toBe(409);
    } finally {
      await demo.stop();
    }
  });
});

describe("Server und Status-API importieren src/lib nicht", () => {
  test("status.ts ohne Importe aus src/lib, src/agents oder src/bot", async () => {
    const src = await Bun.file(join(repo, "src", "web", "status.ts")).text();
    const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map(m => m[1]);
    for (const path of imports) expect(/\.\.\/(lib|agents|bot)/.test(path)).toBe(false);
  });
});
