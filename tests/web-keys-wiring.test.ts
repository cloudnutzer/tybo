/**
 * Issue #62, Checkbox 3: Verdrahtung der Schlüssel-API. startWebUi reicht
 * keys an createServer weiter; src/bot.ts übergibt createBotKeys (nur als
 * Text geprüft, nie importiert oder gestartet) und lädt dieselbe .env, die
 * geschrieben wird; web:dev und Demo nutzen die Attrappe im Speicher.
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

describe("src/bot.ts (nur als Text)", () => {
  test("übergibt createBotKeys(process.env) und lädt .env aus process.cwd() wie createBotKeys", async () => {
    const bot = await Bun.file(join(repo, "src", "bot.ts")).text();
    expect(bot).toContain('import { createBotKeys } from "./web/bot-keys";');
    const call = bot.slice(bot.indexOf("webServer = await startWebUi({"));
    const args = call.slice(0, call.indexOf("\n});"));
    expect(args).toContain("keys: createBotKeys(process.env),");
    // Schreibpfad = Ladepfad
    expect(bot).toContain('await loadEnv(join(process.cwd(), ".env"));');
    expect(defaultEnvPath()).toBe(join(process.cwd(), ".env"));
  });
});

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
