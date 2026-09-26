/**
 * Issue #50, Checkbox 4: Agentenlisten der übrigen Routen kommen aus dem
 * Katalog. startWebUi reicht agentCatalog weiter, src/bot.ts übergibt
 * botAgentCatalog (nur als Text geprüft, nie importiert oder gestartet).
 * Katalog, Einstellungen und Topics nur in temporären Dateien.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setAgentCatalogPaths } from "../src/agents/catalog";
import { setSettingsPath } from "../src/lib/settings";
import { botAgentCatalog } from "../src/web/bot-agents";
import { botInstructions, botSettings } from "../src/web/bot-settings";
import { botSetMapping } from "../src/web/bot-topics";
import type { WebServer, WebServerDeps } from "../src/web/server";
import { startWebUi } from "../src/web/startup";
import { setAgentOverridesPath } from "../src/lib/agent-overrides";
import { GROUP, readMapping, topicEnv, topicServer } from "./topic-fixture";

const repo = resolve(import.meta.dir, "..");
const root = await mkdtemp(join(tmpdir(), "bot-agents-wiring-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
let counter = 0;

beforeEach(() => {
  const dir = join(root, `case-${++counter}`);
  mkdirSync(dir, { recursive: true });
  setAgentCatalogPaths({ file: join(dir, "agents.json"), backupDir: join(dir, "backups"), topicsFile: join(dir, "topics.json") });
  setSettingsPath(join(dir, "settings.json"));
  setAgentOverridesPath(join(dir, "agent-overrides.json"));
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
  setAgentCatalogPaths();
  setSettingsPath();
  setAgentOverridesPath();
});

const planer = { name: "projekt-planer", description: "Plant Projekte", systemPrompt: "Du planst Projekte." };

describe("Agentenlisten aus dem Katalog", () => {
  test("ohne eigene Liste: neues Gespräch, Einstellungen und Anweisungen folgen Anlegen und Löschen sofort", async () => {
    const created: string[] = [];
    const ctx = await topicServer(root, servers, null, {
      agentCatalog: botAgentCatalog,
      settings: botSettings,
      instructions: botInstructions,
      topics: {
        create: async (agent: string) => {
          created.push(agent);
          return { status: 201, body: { ok: true } };
        },
      } as any,
    });
    expect((await ctx.api("/api/conversations", "POST", { agent: "projekt-planer" })).status).toBe(400);
    expect((await ctx.api("/api/agents", "POST", planer)).status).toBe(201);
    expect((await ctx.api("/api/conversations", "POST", { agent: "projekt-planer" })).status).toBe(201);
    expect(created).toEqual(["projekt-planer"]);
    expect((await (await ctx.api("/api/settings")).json()).agents).toContain("projekt-planer");
    expect((await ctx.api("/api/agents/projekt-planer/instructions")).status).toBe(200);

    expect((await ctx.api("/api/agents/finance", "DELETE", { confirm: "finance" })).status).toBe(200);
    expect((await ctx.api("/api/conversations", "POST", { agent: "finance" })).status).toBe(400);
    expect((await (await ctx.api("/api/settings")).json()).agents).not.toContain("finance");
    expect((await ctx.api("/api/agents/finance/instructions")).status).toBe(404);
    expect((await ctx.api("/api/settings", "PATCH", { agents: { finance: { effort: "low" } } })).status).toBe(400);

    expect((await ctx.api("/api/agents/finance/restore", "POST")).status).toBe(200);
    expect((await ctx.api("/api/conversations", "POST", { agent: "finance" })).status).toBe(201);
  });

  test("Topic-Zuordnung: eigener Agent wählbar, gelöschter nicht", async () => {
    const env = await topicEnv(root);
    env.deps.setMapping = (chatId, topicId, agent) => botSetMapping(chatId, topicId, agent, env.mappingFile);
    await env.names.saveTopicName(7, "Sieben");
    await botSetMapping(GROUP, 7, "research", env.mappingFile);
    const ctx = await topicServer(root, servers, env, { agentCatalog: botAgentCatalog, settings: botSettings });
    expect((await ctx.api("/api/conversations/topic-7", "PATCH", { agent: "projekt-planer" })).status).toBe(400);
    await ctx.api("/api/agents", "POST", planer);
    expect((await ctx.api("/api/conversations/topic-7", "PATCH", { agent: "projekt-planer" })).status).toBe(200);
    expect((await readMapping(env))[GROUP]["7"]).toBe("projekt-planer");
    await ctx.api("/api/agents/content", "DELETE", { confirm: "content" });
    expect((await ctx.api("/api/conversations/topic-7", "PATCH", { agent: "content" })).status).toBe(400);
    expect((await readMapping(env))[GROUP]["7"]).toBe("projekt-planer");
  });

  test("eigene Liste (agents) hat weiter Vorrang vor dem Katalog", async () => {
    const ctx = await topicServer(root, servers, null, { agentCatalog: botAgentCatalog, agents: [{ name: "general" }] });
    expect((await ctx.api("/api/conversations", "POST", { agent: "research" })).status).toBe(400);
  });
});

describe("Verdrahtung", () => {
  test("startWebUi reicht agentCatalog an createServer weiter", async () => {
    let received: WebServerDeps | null = null;
    const server = await startWebUi({
      env: { WEB_ENABLED: "true", WEB_PASSWORD: "test-passwort-lang" },
      chat: { runTurn: async () => ({ text: "" }), stop() {} },
      agentCatalog: botAgentCatalog,
      createServer: async (_config, deps) => {
        received = deps;
        return { url: "http://127.0.0.1:3100", eventStreamCount: () => 0, stop: async () => {} } as WebServer;
      },
      log: () => {},
      lanAddresses: () => [],
    });
    expect(server).not.toBeNull();
    expect(received!.agentCatalog).toBe(botAgentCatalog);
  });

  test("src/bot.ts übergibt botAgentCatalog und keine eigene Agentenliste (nur als Text)", async () => {
    const bot = await Bun.file(join(repo, "src", "bot.ts")).text();
    expect(bot).toContain('import { botAgentCatalog } from "./web/bot-agents";');
    const call = bot.slice(bot.indexOf("webServer = await startWebUi({"));
    const args = call.slice(0, call.indexOf("});"));
    expect(args).toContain("agentCatalog: botAgentCatalog,");
    expect(args).not.toMatch(/^\s*agents:/m);
  });

  test("Topic-Zuordnung in bot.ts prüft den Agenten in der Schreibkette (botSetMapping)", async () => {
    const topics = await Bun.file(join(repo, "src", "web", "bot-topics.ts")).text();
    expect(topics).toContain("setMapping: (chatId, topicId, agent) => botSetMapping(chatId, topicId, agent),");
    expect(topics).toContain("setTopicMapping(chatId, topicId, agent, file, isActiveAgent)");
  });

  test("agent-catalog.ts importiert nichts aus src/lib, src/agents oder src/bot", async () => {
    const src = await Bun.file(join(repo, "src", "web", "agent-catalog.ts")).text();
    const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map(m => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const path of imports) expect(/\.\.\/(lib|agents|bot)/.test(path)).toBe(false);
  });
});
