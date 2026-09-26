/**
 * Issue #29, Checkbox 8: Verdrahtung. startWebUi reicht die Topic-Verwaltung
 * durch, src/bot.ts baut den Adapter um grammY bot.api (nur als Text
 * geprüft, nie importiert oder gestartet), Demo und web:dev verwalten Topics
 * gegen eine Attrappe.
 */

import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { createDemoTopics, DEMO_GROUP_ID, startDemoServer } from "../src/web/demo";
import { createFakeChat } from "../src/web/fake-chat";
import type { WebServer, WebServerDeps } from "../src/web/server";
import { startWebUi } from "../src/web/startup";

const PASSWORD = "test-passwort-lang";
const repo = resolve(import.meta.dir, "..");

describe("startWebUi", () => {
  test("reicht topics an createServer weiter", async () => {
    const { topics } = createDemoTopics();
    let received: WebServerDeps | null = null;
    const server = await startWebUi({
      env: { WEB_ENABLED: "true", WEB_PASSWORD: PASSWORD },
      chat: { runTurn: async () => ({ text: "" }), stop() {} },
      topics,
      createServer: async (_config, deps) => {
        received = deps;
        return { url: "http://127.0.0.1:3100", eventStreamCount: () => 0, stop: async () => {} } as WebServer;
      },
      log: () => {},
      lanAddresses: () => [],
    });
    expect(server).not.toBeNull();
    expect(received!.topics).toBe(topics);
  });
});

describe("src/bot.ts (nur als Text)", () => {
  test("Adapter um bot.api und Übergabe an startWebUi", async () => {
    const bot = await Bun.file(join(repo, "src", "bot.ts")).text();
    expect(bot).toContain('import { createBotTopics } from "./web/bot-topics";');
    expect(bot).toContain("const telegramTopicApi: TelegramTopicApi = {");
    expect(bot).toContain("(await bot.api.createForumTopic(chatId, name)).message_thread_id");
    // grammY erwartet den Namen als Objekt
    expect(bot).toContain("await bot.api.editForumTopic(chatId, topicId, { name });");
    expect(bot).toContain("await bot.api.closeForumTopic(chatId, topicId);");
    expect(bot).toContain("await bot.api.reopenForumTopic(chatId, topicId);");
    expect(bot).toContain("await bot.api.deleteForumTopic(chatId, topicId);");
    // Rechte des Haupt-Bots über getChatMember mit der eigenen ID
    expect(bot).toContain("mainBotId ??= (await bot.api.getMe()).id;");
    expect(bot).toContain("return rightsFromChatMember(await bot.api.getChatMember(chatId, mainBotId));");
    const call = bot.slice(bot.indexOf("webServer = await startWebUi({"));
    expect(call.slice(0, call.indexOf("});"))).toContain("topics: createBotTopics(process.env, telegramTopicApi)");
  });

  test("Quelle und Live-Feed nutzen denselben Topic-Zustand wie die Verwaltung", async () => {
    const src = await Bun.file(join(repo, "src", "web", "bot-telegram.ts")).text();
    expect(src.match(/topicState: chatId => botTopicState\.forChat\(chatId\)/g)).toHaveLength(2);
    const topics = await Bun.file(join(repo, "src", "web", "bot-topics.ts")).text();
    expect(topics).toContain("state: botTopicState,");
    expect(topics).toContain("resetSession: resetSessionOrThrow,");
  });
});

describe("Demo: Topics verwalten gegen die Attrappe", () => {
  test("anlegen, umbenennen, schließen, öffnen, löschen", async () => {
    const demo = await startDemoServer({ host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] }, {
      chat: createFakeChat(),
      telegramChat: createFakeChat(),
      log: () => {},
    });
    try {
      const origin = demo.server.url;
      const api = (path: string, method = "GET", body?: unknown) =>
        fetch(`${origin}${path}`, { method, headers: { origin, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      expect(await (await api("/api/telegram/rights")).json()).toEqual({ manageTopics: true, deleteMessages: true, group: true });
      const created = await api("/api/conversations", "POST", { agent: "research" });
      expect(created.status).toBe(201);
      expect((await created.json()).conversation).toEqual({ id: "topic-900", title: "Neues Gespräch", agent: "research", lastActivity: null });
      const topicIds = async () => (await (await api("/api/conversations")).json()).telegram.topics.map((t: any) => t.id);
      expect(await topicIds()).toContain("topic-900");
      expect((await api("/api/conversations/topic-900", "PATCH", { title: "Urlaub" })).status).toBe(200);
      expect((await (await api("/api/conversations/topic-900")).json()).conversation.title).toBe("Urlaub");
      expect((await (await api("/api/conversations/topic-900/close", "POST")).json()).conversation.closed).toBe(true);
      expect((await api("/api/conversations/topic-900/messages", "POST", { text: "x" })).status).toBe(409);
      expect((await api("/api/conversations/topic-900/reopen", "POST")).status).toBe(200);
      expect((await api("/api/conversations/topic-900", "DELETE", { confirm: "urlaub" })).status).toBe(400);
      expect(await (await api("/api/conversations/topic-900", "DELETE", { confirm: "Urlaub" })).json()).toEqual({ deleted: true });
      expect(await topicIds()).not.toContain("topic-900");
      // Beispiel-Topics bleiben
      expect(await topicIds()).toContain("topic-443");
    } finally {
      await demo.stop();
    }
  });

  test("normales web:dev: ohne Beispieldaten nur General, eigene Gruppen-ID", async () => {
    const { telegram } = createDemoTopics({ seed: false });
    const list = await telegram.listConversations();
    expect(list.dm).toBeNull();
    expect(list.topics.map(t => t.id)).toEqual(["topic-1"]);
    expect(DEMO_GROUP_ID).toMatch(/^-\d+$/);
  });
});
