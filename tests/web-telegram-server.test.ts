import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryRow } from "../src/lib/supabase";
import type { RunTurnOptions, WebChat } from "../src/web/chat";
import { createTelegramSource, type BotTelegramDeps } from "../src/web/bot-telegram";
import { createWebServer, type WebServer, type WebServerDeps } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import type { TelegramSource } from "../src/web/telegram";

const PASSWORD = "test-passwort-lang";
const SECRET = "sk-ant-api03-GEHEIM";
const GROUP = "-1001234567890";
const root = await mkdtemp(join(tmpdir(), "tybo-web-telegram-"));
let counter = 0;
afterAll(() => rm(root, { recursive: true, force: true }));

const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
});

/** Chat-Attrappe: merkt sich, ob ein Turn oder Stopp ankommt (darf bei Telegram-IDs nie passieren) */
class RecordingChat implements WebChat {
  turns: RunTurnOptions[] = [];
  stops: string[] = [];
  async runTurn(opts: RunTurnOptions) {
    this.turns.push(opts);
    return { text: "ok" };
  }
  stop(id: string) {
    this.stops.push(id);
  }
}

interface Ctx {
  origin: string;
  cookie: string;
  chat: RecordingChat;
  logs: string[];
  historyCalls: [string, number | null, { limit: number; before?: string }][];
  store: ConversationStore;
}

function rows(): HistoryRow[] {
  return [
    { id: "a1", created_at: "2026-09-23T10:00:00+00:00", role: "user", content: "Wie steht das Budget?", metadata: { topicId: 443, msgId: 812 } },
    {
      id: "a2",
      created_at: "2026-09-23T10:01:00+00:00",
      role: "assistant",
      content: "**Gut.** [REMEMBER: Budget ok] Details folgen",
      metadata: { agent: "finance", topicId: 443 },
      // Sollte die Abfrage je mehr liefern: nie in die Antwort
      embedding: [0.1, 0.2],
      chat_id: GROUP,
    } as HistoryRow,
  ];
}

function realSource(ctx: Pick<Ctx, "historyCalls">, overrides: Partial<BotTelegramDeps> = {}): TelegramSource {
  return createTelegramSource({
    userId: "4711",
    groupId: () => GROUP,
    topicNames: async () => ({ "1": "General", "443": "Finanzen" }),
    topicMapping: () => ({ "443": "finance" }),
    history: async (chatId, topicId, options) => {
      ctx.historyCalls.push([chatId, topicId, options]);
      return topicId === 443 ? rows() : [];
    },
    activity: async chatId => (chatId === GROUP ? [{ sessionKey: `topic:${GROUP}:443`, lastActivity: "2026-09-23T10:01:00+00:00" }] : []),
    log: () => {},
    ...overrides,
  });
}

async function start(telegram: ((ctx: Ctx) => TelegramSource | undefined) | null, deps: Partial<WebServerDeps> = {}): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  const ctx = { chat: new RecordingChat(), logs: [] as string[], historyCalls: [] as Ctx["historyCalls"] } as Ctx;
  // Seit Issue #29 legt die API keine Web-Gespräche mehr an: ältere direkt im Speicher
  ctx.store = new ConversationStore({ dir: join(dir, "web") });
  await ctx.store.load();
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "web-sessions.json"),
      dataDir: join(dir, "web"),
      conversationStore: ctx.store,
      chat: ctx.chat,
      telegram: telegram ? telegram(ctx) : undefined,
      log: m => ctx.logs.push(m),
      ...deps,
    }
  );
  servers.push(server);
  ctx.origin = server.url;
  const res = await fetch(`${ctx.origin}/api/login`, {
    method: "POST",
    headers: { origin: ctx.origin },
    body: JSON.stringify({ password: PASSWORD }),
  });
  ctx.cookie = res.headers.get("set-cookie")!.split(";")[0];
  return ctx;
}

function api(ctx: Ctx, path: string, init: { method?: string; body?: unknown; cookie?: string | null } = {}) {
  const headers: Record<string, string> = { origin: ctx.origin, "content-type": "application/json" };
  const cookie = init.cookie === undefined ? ctx.cookie : init.cookie;
  if (cookie) headers.cookie = cookie;
  return fetch(`${ctx.origin}${path}`, {
    method: init.method ?? "GET",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

describe("GET /api/conversations mit Telegram", () => {
  test("liefert telegram.dm und telegram.topics, Web-Gespräche unverändert", async () => {
    const ctx = await start(c => realSource(c));
    const created = { conversation: await ctx.store.createConversation("research") };
    const res = await api(ctx, "/api/conversations");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["conversations", "telegram"]);
    expect(body.conversations).toEqual([created.conversation]);
    expect(body.telegram.dm).toEqual({ id: "dm", title: "Direktchat", agent: "general", lastActivity: null });
    expect(body.telegram.topics).toEqual([
      { id: "topic-443", title: "Finanzen", agent: "finance", lastActivity: "2026-09-23T10:01:00.000Z" },
      { id: "topic-1", title: "General", agent: "general", lastActivity: null },
    ]);
  });

  test("Chat-ID der Forum-Gruppe steht bei telegram.chatId; ohne ermittelbare Gruppe fehlt sie (Issue #51)", async () => {
    const ctx = await start(c => realSource(c));
    expect((await (await api(ctx, "/api/conversations")).json()).telegram.chatId).toBe(GROUP);
    const none = await start(c => realSource(c, { groupId: () => null }));
    expect("chatId" in (await (await api(none, "/api/conversations")).json()).telegram).toBe(false);
    const throws = await start(c => realSource(c, { groupId: () => { throw new Error("kaputt"); } }));
    const res = await api(throws, "/api/conversations");
    expect(res.status).toBe(200);
    expect("chatId" in (await res.json()).telegram).toBe(false);
  });

  test("ohne Telegram-Quelle: leere Telegram-Liste", async () => {
    const ctx = await start(null);
    const body = await (await api(ctx, "/api/conversations")).json();
    expect(body).toEqual({ conversations: [], telegram: { dm: null, topics: [] } });
  });

  test("Quelle wirft: leere Telegram-Liste, Log-Zeile ohne Details, kein 500", async () => {
    const ctx = await start(() => ({
      listConversations: async () => {
        throw new Error(`Verbindung mit ${SECRET} fehlgeschlagen`);
      },
      getConversation: async () => null,
      history: async () => null,
    }));
    const res = await api(ctx, "/api/conversations");
    expect(res.status).toBe(200);
    expect((await res.json()).telegram).toEqual({ dm: null, topics: [] });
    expect(ctx.logs.join("\n")).toContain("Telegram-Gespräche nicht lesbar");
    expect(ctx.logs.join("\n")).not.toContain(SECRET);
  });

  test("ohne Anmeldung: 401", async () => {
    const ctx = await start(c => realSource(c));
    expect((await api(ctx, "/api/conversations", { cookie: null })).status).toBe(401);
    expect((await api(ctx, "/api/conversations/topic-443/messages", { cookie: null })).status).toBe(401);
    expect((await api(ctx, "/api/conversations/dm", { cookie: null })).status).toBe(401);
    expect(ctx.historyCalls).toEqual([]);
  });
});

describe("GET /api/conversations/<telegram-id>/messages", () => {
  test("Verlauf im Format der Web-Gespräche, chronologisch, html ohne Steuer-Tags, ohne Embedding", async () => {
    const ctx = await start(c => realSource(c));
    const res = await api(ctx, "/api/conversations/topic-443/messages");
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain("embedding");
    expect(raw).not.toContain("chat_id");
    expect(raw).not.toContain("topicId");
    const body = JSON.parse(raw);
    expect(body.running).toBe(false);
    expect(body.hasMore).toBe(false);
    expect(body.messages).toEqual([
      { id: "812", role: "user", text: "Wie steht das Budget?", createdAt: "2026-09-23T10:00:00.000Z" },
      {
        id: "db-a2",
        role: "assistant",
        text: "**Gut.** [REMEMBER: Budget ok] Details folgen",
        createdAt: "2026-09-23T10:01:00.000Z",
        html: expect.any(String),
        copyText: "**Gut.** Details folgen",
        agent: "finance",
      },
    ]);
    expect(body.messages[1].html).toContain("<strong>Gut.</strong>");
    expect(body.messages[1].html).not.toContain("REMEMBER");
    expect(ctx.historyCalls).toEqual([[GROUP, 443, { limit: 51, before: undefined }]]);
  });

  test("topic-1 liest General (group:<chatId>), dm den Direktchat", async () => {
    const ctx = await start(c => realSource(c));
    expect((await api(ctx, "/api/conversations/topic-1/messages")).status).toBe(200);
    expect((await api(ctx, "/api/conversations/dm/messages")).status).toBe(200);
    expect(ctx.historyCalls.map(c => c.slice(0, 2))).toEqual([
      [GROUP, null],
      ["4711", null],
    ]);
  });

  test("?before= wird geprüft und durchgereicht", async () => {
    const ctx = await start(c => realSource(c));
    const ok = await api(ctx, "/api/conversations/topic-443/messages?before=2026-09-23T12%3A00%3A00%2B02%3A00");
    expect(ok.status).toBe(200);
    expect(ctx.historyCalls[0][2]).toEqual({ limit: 51, before: "2026-09-23T10:00:00.000Z" });
    for (const bad of ["", "gestern", "2026-09-23", "1695463200000", "2026-09-23T10:00:00Z%27"]) {
      const res = await api(ctx, `/api/conversations/topic-443/messages?before=${bad}`);
      expect(res.status).toBe(400);
    }
    expect(ctx.historyCalls).toHaveLength(1);
  });

  test("leere Historie: leere Liste", async () => {
    const ctx = await start(c => realSource(c));
    const body = await (await api(ctx, "/api/conversations/topic-1/messages")).json();
    expect(body).toEqual({ messages: [], hasMore: false, running: false });
  });

  test("Lesefehler der Quelle: 503 statt scheinbar leerem Verlauf (PR #83, Runde 4)", async () => {
    // Echte Quelle (createTelegramSource), deren Datenbankzugriff wirft wie getConversationHistory
    const ctx = await start(c =>
      realSource(c, {
        history: async () => {
          throw new Error("Verlauf lesen fehlgeschlagen");
        },
      })
    );
    const res = await api(ctx, "/api/conversations/topic-443/messages");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.messages).toBeUndefined();
    expect(typeof body.error).toBe("string");
    expect(ctx.logs.some(l => l.startsWith("Telegram-Verlauf nicht lesbar"))).toBe(true);
  });

  test("unbekannte und ungültige IDs: 404", async () => {
    const ctx = await start(c => realSource(c));
    for (const id of ["topic-999", "topic-abc", "topic-", "topic-0", "topic-01", "..%2Fx"]) {
      expect((await api(ctx, `/api/conversations/${id}/messages`)).status).toBe(404);
      expect((await api(ctx, `/api/conversations/${id}`)).status).toBe(404);
    }
    // ohne Gruppe bzw. ohne Benutzer-ID
    const noGroup = await start(c => realSource(c, { groupId: () => null, userId: undefined }));
    expect((await api(noGroup, "/api/conversations/topic-1/messages")).status).toBe(404);
    expect((await api(noGroup, "/api/conversations/dm/messages")).status).toBe(404);
    // ohne Telegram-Quelle
    const none = await start(null);
    expect((await api(none, "/api/conversations/dm/messages")).status).toBe(404);
    expect(ctx.historyCalls).toEqual([]);
  });
});

describe("Telegram-IDs: getrennt vom Web-Chat", () => {
  test("GET auf das Gespräch liefert den Eintrag", async () => {
    const ctx = await start(c => realSource(c));
    const body = await (await api(ctx, "/api/conversations/topic-443")).json();
    expect(body).toEqual({
      conversation: { id: "topic-443", title: "Finanzen", agent: "finance", lastActivity: "2026-09-23T10:01:00.000Z" },
      running: false,
    });
  });

  test("ohne Telegram-Turn: POST 503, Stopp ohne Wirkung; der Web-Chat bekommt nichts", async () => {
    const ctx = await start(c => realSource(c));
    const send = await api(ctx, "/api/conversations/topic-443/messages", { method: "POST", body: { text: "Hallo" } });
    expect(send.status).toBe(503);
    const stop = await api(ctx, "/api/conversations/dm/stop", { method: "POST" });
    expect(stop.status).toBe(200);
    expect(await stop.json()).toEqual({ stopping: false });
    expect((await api(ctx, "/api/conversations/topic-1", { method: "DELETE" })).status).toBe(405);
    expect((await api(ctx, "/api/conversations/dm/stop")).status).toBe(405);
    expect((await api(ctx, "/api/conversations/topic-443/messages", { method: "PUT", body: {} })).status).toBe(405);
    expect(ctx.chat.turns).toEqual([]);
    expect(ctx.chat.stops).toEqual([]);
  });

  test("POST auf unbekannte Telegram-ID: 404", async () => {
    const ctx = await start(c => realSource(c));
    const res = await api(ctx, "/api/conversations/topic-999/messages", { method: "POST", body: { text: "Hallo" } });
    expect(res.status).toBe(404);
    expect(ctx.chat.turns).toEqual([]);
  });

  test("events: SSE-Strom mit status, POST darauf 405; unbekannte ID 404", async () => {
    const ctx = await start(c => realSource(c));
    const controller = new AbortController();
    const res = await fetch(`${ctx.origin}/api/conversations/topic-443/events`, {
      headers: { cookie: ctx.cookie, origin: ctx.origin },
      signal: controller.signal,
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toContain("event: status");
    expect(first).toContain('{"running":false}');
    controller.abort();
    await reader.cancel().catch(() => {});
    expect((await api(ctx, "/api/conversations/topic-443/events", { method: "POST" })).status).toBe(405);
    expect((await api(ctx, "/api/conversations/topic-999/events")).status).toBe(404);
  });

  test("Web-Gespräche funktionieren daneben unverändert", async () => {
    const ctx = await start(c => realSource(c));
    const conversation = await ctx.store.createConversation("general");
    const sent = await api(ctx, `/api/conversations/${conversation.id}/messages`, { method: "POST", body: { text: "Hallo" } });
    expect(sent.status).toBe(202);
    expect(ctx.chat.turns.map(t => t.conversationId)).toEqual([conversation.id]);
    expect((await api(ctx, "/api/conversations/0e8f6f7a-5b1e-4c2a-9d3f-1a2b3c4d5e6f/messages")).status).toBe(404);
  });
});

describe("Verdrahtung", () => {
  test("src/bot.ts reicht die Telegram-Quelle an startWebUi weiter (ohne bot.ts zu importieren)", async () => {
    const bot = await Bun.file(join(import.meta.dir, "..", "src", "bot.ts")).text();
    expect(bot).toContain('import { createBotTelegram, createBotTelegramLive, botGroupId } from "./web/bot-telegram";');
    const call = bot.slice(bot.indexOf("webServer = await startWebUi({"));
    expect(call.slice(0, call.indexOf("});"))).toContain("telegram: createBotTelegram(process.env)");
  });

  test("src/bot.ts: Telegram-Turn mit Klartext-Spiegel (ohne parse_mode) und sendAsAgent mit Thread", async () => {
    const bot = await Bun.file(join(import.meta.dir, "..", "src", "bot.ts")).text();
    expect(bot).toContain('import { createApprovalTurns, createBotChat, createTelegramChat, webMediaDir } from "./web/bot-turn";');
    const block = bot.slice(bot.indexOf("const telegramWebChat = createTelegramChat({"));
    const wiring = block.slice(0, block.indexOf("\n});"));
    expect(wiring).toContain("groupId: () => botGroupId(process.env)");
    expect(wiring).toContain("agentForTopic: (topicId, chatId) => getAgentByTopicId(topicId, chatId)");
    expect(wiring).toContain("sendPlain: (chatId, text, threadId) => telegramRuntime.sendPlain(chatId, text, threadId),");
    const runtime = await Bun.file(join(import.meta.dir, "..", "src", "lib", "telegram-runtime.ts")).text();
    expect(runtime).toContain("await bot.api.sendMessage(chatId, text, threadId ? { message_thread_id: threadId } : {});");
    expect(wiring).not.toContain("parse_mode");
    expect(wiring).toContain("botRegistry.sendAsAgent(agent, chatId, text, { threadId })");
    const call = bot.slice(bot.indexOf("webServer = await startWebUi({"));
    expect(call.slice(0, call.indexOf("});"))).toContain("telegramChat: telegramWebChat");
  });

  test("server.ts lädt nichts aus src/lib", async () => {
    const server = await Bun.file(join(import.meta.dir, "..", "src", "web", "server.ts")).text();
    const telegram = await Bun.file(join(import.meta.dir, "..", "src", "web", "telegram.ts")).text();
    for (const source of [server, telegram]) expect(source).not.toMatch(/from "\.\.\/lib\//);
  });
});
