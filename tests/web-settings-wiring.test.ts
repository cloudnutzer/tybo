/**
 * Issue #36, Checkbox 5: Verdrahtung. startWebUi reicht Einstellungen,
 * Anweisungen und Modell-Listen an createServer weiter; src/bot.ts übergibt
 * die echten Ports (nur als Text geprüft, nie importiert oder gestartet).
 */

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { botInstructions, botSettings } from "../src/web/bot-settings";
import { createModelCatalog } from "../src/web/models";
import type { WebServer, WebServerDeps } from "../src/web/server";
import { startWebUi } from "../src/web/startup";

const repo = resolve(import.meta.dir, "..");

describe("startWebUi", () => {
  test("reicht settings, instructions und models an createServer weiter", async () => {
    const models = createModelCatalog({ fetch: async () => Response.json({}) });
    let received: WebServerDeps | null = null;
    const server = await startWebUi({
      env: { WEB_ENABLED: "true", WEB_PASSWORD: "test-passwort-lang" },
      chat: { runTurn: async () => ({ text: "" }), stop() {} },
      settings: botSettings,
      instructions: botInstructions,
      models,
      createServer: async (_config, deps) => {
        received = deps;
        return { url: "http://127.0.0.1:3100", eventStreamCount: () => 0, stop: async () => {} } as WebServer;
      },
      log: () => {},
      lanAddresses: () => [],
    });
    expect(server).not.toBeNull();
    expect(received!.settings).toBe(botSettings);
    expect(received!.instructions).toBe(botInstructions);
    expect(received!.models).toBe(models);
  });
});

describe("src/bot.ts (nur als Text)", () => {
  test("übergibt botSettings und botInstructions an startWebUi", async () => {
    const bot = await Bun.file(join(repo, "src", "bot.ts")).text();
    expect(bot).toContain('import { botInstructions, botSettings } from "./web/bot-settings";');
    const call = bot.slice(bot.indexOf("webServer = await startWebUi({"));
    const args = call.slice(0, call.indexOf("});"));
    expect(args).toContain("settings: botSettings,");
    expect(args).toContain("instructions: botInstructions,");
  });
});

describe("Server importiert src/lib nicht", () => {
  test("settings.ts, instructions.ts und models.ts ohne Importe aus src/lib, src/agents oder src/bot", async () => {
    for (const name of ["settings.ts", "instructions.ts", "models.ts", "server.ts"]) {
      const src = await Bun.file(join(repo, "src", "web", name)).text();
      const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map(m => m[1]);
      for (const path of imports) {
        expect({ name, path, bad: /\.\.\/(lib|agents|bot)/.test(path) }).toEqual({ name, path, bad: false });
      }
    }
  });
});
