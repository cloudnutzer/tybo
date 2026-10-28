/**
 * Issue #62, Checkbox 3: Verdrahtung der Schlüssel-API. startWebUi reicht
 * keys an createServer weiter; createBotKeys übergibt startBotWeb, und der
 * Bot lädt dieselbe .env, die geschrieben wird (tests/app-bot-web.test.ts,
 * tests/app-bot-boot.test.ts); web:dev und Demo nutzen die Attrappe im Speicher.
 */

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { createDemoKeys, startDemoServer } from "../src/web/demo";
import { defaultEnvPath } from "../src/web/bot-keys";
import type { WebServer, WebServerDeps } from "../src/web/server";
import { startWebUi } from "../src/web/startup";

const repo = resolve(import.meta.dir, "..");

describe("startWebUi", () => {
  test("reicht keys an createServer weiter", async () => {
    const keys = createDemoKeys();
    let received: WebServerDeps | null = null;
    const server = await startWebUi({
      env: { WEB_ENABLED: "true", WEB_PASSWORD: "test-passwort-lang" },
      chat: { runTurn: async () => ({ text: "" }), stop() {} },
      keys,
      createServer: async (_config, deps) => {
        received = deps;
        return { url: "http://127.0.0.1:3100", eventStreamCount: () => 0, stop: async () => {} } as WebServer;
      },
      log: () => {},
      lanAddresses: () => [],
    });
    expect(server).not.toBeNull();
    expect(received!.keys).toBe(keys);
  });
});

// Übergabe an startWebUi und Ladepfad der .env: tests/app-bot-web.test.ts und
// tests/app-bot-boot.test.ts (Issue #344)

describe("web:dev und Demo", () => {
  test("scripts/web-dev.ts nutzt die Attrappe, nie bot-keys oder env-file", async () => {
    const src = await Bun.file(join(repo, "scripts", "web-dev.ts")).text();
    expect(src).toContain("keys: createDemoKeys(),");
    expect(src).not.toContain("bot-keys");
    expect(src).not.toContain("env-file");
  });

  test("demo.ts importiert weder bot-keys noch env-file", async () => {
    const src = await Bun.file(join(repo, "src", "web", "demo.ts")).text();
    const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map(m => m[1]);
    for (const path of imports) expect(/bot-keys|env-file/.test(path)).toBe(false);
  });

  test("Demo-Server: Setzen wirkt nur im Speicher", async () => {
    const keys = createDemoKeys();
    const demo = await startDemoServer({ host: "127.0.0.1", port: 0, password: "test-passwort-lang", allowedHosts: [] }, { keys, log: () => {} });
    try {
      const origin = demo.server.url;
      const res = await fetch(`${origin}/api/keys/OPENAI_API_KEY`, {
        method: "PUT",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ value: "demo-neu-wert-1234" }),
      });
      expect(res.status).toBe(200);
      expect(keys.values.get("OPENAI_API_KEY")).toBe("demo-neu-wert-1234");
      const list = await (await fetch(`${origin}/api/keys`)).json();
      expect(list.keys.find((k: any) => k.name === "OPENAI_API_KEY")).toMatchObject({ set: true, last4: "1234", restartPending: true });
    } finally {
      await demo.stop();
    }
  });
});
