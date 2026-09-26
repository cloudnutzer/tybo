// Nachrichten aus Telegram live in der WebUI (Issue #20): gespeichert wird
// über saveMessageWith (echte msgId-Vergabe und echter onMessageSaved-Hook)
// in einen Speicher-Ersatz, der wie Supabase eigene Zeilen-IDs und
// created_at vergibt. Echter Web-Server, echte Telegram-Quelle und echte
// Zuordnung; nur Supabase ist eine Attrappe. src/bot.ts wird nie importiert.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onMessageSaved, saveMessageWith, type Message, type MessageSavedListener } from "../src/lib/convex";
import type { HistoryRow } from "../src/lib/supabase";
import {
  createTelegramLiveFeed,
  createTelegramSource,
  liveConversationId,
} from "../src/web/bot-telegram";
import { createWebServer, TELEGRAM_ACTIVITY_PATH, type WebServer } from "../src/web/server";
import type { TelegramLiveEvent } from "../src/web/telegram";

const PASSWORD = "test-passwort-lang";
const GROUP = "-1001234567890";
const OTHER_GROUP = "-1009999999999";
const USER = "4711";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const root = await mkdtemp(join(tmpdir(), "tybo-web-tg-live-"));
let counter = 0;
afterAll(() => rm(root, { recursive: true, force: true }));

const servers: WebServer[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  while (cleanups.length) cleanups.pop()!();
});

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

describe("liveConversationId", () => {
  const ev = (chatId: string, topicId?: unknown) => ({ chatId, metadata: topicId === undefined ? {} : { topicId } });

  test("Direktchat, Gruppe ohne Topic, Topic 1 und Topic n", () => {
    expect(liveConversationId(ev(USER), USER, GROUP)).toBe("dm");
    expect(liveConversationId(ev(USER, null), USER, GROUP)).toBe("dm");
    expect(liveConversationId(ev(GROUP), USER, GROUP)).toBe("topic-1");
    expect(liveConversationId(ev(GROUP, null), USER, GROUP)).toBe("topic-1");
    expect(liveConversationId(ev(GROUP, 1), USER, GROUP)).toBe("topic-1");
    expect(liveConversationId(ev(GROUP, 443), USER, GROUP)).toBe("topic-443");
  });

  test("fremde Chat-ID mit gleicher Topic-ID: keine Zuordnung", () => {
    expect(liveConversationId(ev(OTHER_GROUP, 443), USER, GROUP)).toBeNull();
    expect(liveConversationId(ev("999", undefined), USER, GROUP)).toBeNull();
  });

  test("ohne Gruppe nur Direktchat; unerwartete topicId-Werte ergeben nichts", () => {
    expect(liveConversationId(ev(GROUP, 443), USER, null)).toBeNull();
    expect(liveConversationId(ev(USER), null, GROUP)).toBeNull();
    expect(liveConversationId(ev(USER, 5), USER, GROUP)).toBeNull();
    expect(liveConversationId(ev(GROUP, "443"), USER, GROUP)).toBeNull();
    expect(liveConversationId(ev(GROUP, 0), USER, GROUP)).toBeNull();
    expect(liveConversationId(ev(GROUP, 1.5), USER, GROUP)).toBeNull();
    expect(liveConversationId(ev(GROUP, 12345678901), USER, GROUP)).toBeNull();
  });
});

describe("createTelegramLiveFeed", () => {
  function feed(groupId: () => string | null = () => GROUP) {
    let hook: MessageSavedListener | null = null;
    let unsubscribed = 0;
    const live = createTelegramLiveFeed({
      userId: USER,
      groupId,
      onMessageSaved: l => {
        hook = l;
        return () => {
          unsubscribed++;
        };
      },
      log: () => {},
    });
    const events: TelegramLiveEvent[] = [];
    const off = live.subscribe(e => events.push(e));
    return { events, off, fire: (e: Parameters<MessageSavedListener>[0]) => hook!(e), unsubscribed: () => unsubscribed };
  }
  const at = "2026-09-23T20:00:00.000Z";
  const id = "0b7c2f7e-5a52-4c38-9d11-2f5e0c7b9a10";

  test("Antwort aus Telegram: nur erlaubte Felder, HTML serverseitig ohne Steuer-Tags", () => {
    const f = feed();
    f.fire({
      chatId: GROUP,
      role: "assistant",
      content: "**Fertig** [REMEMBER: geheim]",
      metadata: { msgId: id, topicId: 443, agent: "finance", filePath: "/Users/x/uploads/a.jpg", type: "photo_reply" },
      createdAt: at,
    });
    expect(f.events).toHaveLength(1);
    const [e] = f.events;
    expect(e.conversationId).toBe("topic-443");
    expect(e.at).toBe(at);
    expect(Object.keys(e.message!).sort()).toEqual(["agent", "copyText", "createdAt", "html", "id", "role", "text"]);
    expect(e.message!.id).toBe(id);
    expect(e.message!.html).toContain("<strong>Fertig</strong>");
    expect(e.message!.html).not.toContain("REMEMBER");
    expect(JSON.stringify(e)).not.toContain("uploads");
  });

  test("im Web geschrieben (channel web): nur Aktivität, kein Inhalt", () => {
    const f = feed();
    f.fire({ chatId: GROUP, role: "user", content: "aus dem Browser", metadata: { msgId: "web-x", topicId: 443, channel: "web" }, createdAt: at });
    expect(f.events).toEqual([{ conversationId: "topic-443", at }]);
  });

  test("Web-Gespräche (chat_id web:<id>) und fremde Chats: nichts", () => {
    const f = feed();
    f.fire({ chatId: "web:abc", role: "user", content: "x", metadata: { msgId: id, channel: "web" }, createdAt: at });
    f.fire({ chatId: OTHER_GROUP, role: "user", content: "x", metadata: { msgId: id, topicId: 443 }, createdAt: at });
    expect(f.events).toEqual([]);
  });

  test("Gruppe nicht ermittelbar: Direktchat geht trotzdem", () => {
    const f = feed(() => {
      throw new Error("topics.json kaputt");
    });
    f.fire({ chatId: USER, role: "user", content: "hi", metadata: { msgId: id }, createdAt: at });
    f.fire({ chatId: GROUP, role: "user", content: "hi", metadata: { msgId: id, topicId: 443 }, createdAt: at });
    expect(f.events.map(e => e.conversationId)).toEqual(["dm"]);
  });

  test("Abmeldung reicht bis zum Hook durch", () => {
    const f = feed();
    f.off();
    expect(f.unsubscribed()).toBe(1);
  });
});

// --- Mit echtem Server ------------------------------------------------------

interface Ctx {
  origin: string;
  cookie: string;
  rows: HistoryRow[];
  save(message: Message): Promise<boolean>;
}

async function start(options: { onMessageSaved?: (l: MessageSavedListener) => () => void } = {}): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  const rows: HistoryRow[] = [];
  let rowCounter = 0;
  // Wie Supabase: eigene Zeilen-ID, created_at mit Mikrosekunden, etwas früher als das Ereignis
  const persist = async (m: Message) => {
    rows.push({
      id: `row-${++rowCounter}`,
      created_at: new Date(Date.now() - 2).toISOString().replace("Z", "123+00:00"),
      role: m.role,
      content: m.content,
      metadata: m.metadata ?? null,
      chat_id: m.chat_id,
    } as HistoryRow);
    return true;
  };
  const telegram = createTelegramSource({
    userId: USER,
    groupId: () => GROUP,
    topicNames: async () => ({ "443": "Projekt-Topics", "8": "Finanzen" }),
    topicMapping: () => ({ "443": "general", "8": "finance" }),
    history: async (chatId, topicId) =>
      rows.filter(r => (r as any).chat_id === chatId && ((r.metadata as any)?.topicId ?? null) === topicId),
    activity: async () => [],
    log: () => {},
  });
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "web-sessions.json"),
      dataDir: join(dir, "web"),
      telegram,
      telegramLive: createTelegramLiveFeed({
        userId: USER,
        groupId: () => GROUP,
        onMessageSaved: options.onMessageSaved ?? onMessageSaved,
        log: () => {},
      }),
      log: () => {},
    }
  );
  servers.push(server);
  const res = await fetch(`${server.url}/api/login`, {
    method: "POST",
    headers: { origin: server.url },
    body: JSON.stringify({ password: PASSWORD }),
  });
  return {
    origin: server.url,
    cookie: res.headers.get("set-cookie")!.split(";")[0],
    rows,
    save: m => saveMessageWith(m, persist),
  };
}

/** Liest SSE-Ereignisse mit; path ist der ganze API-Pfad */
async function listen(ctx: Ctx, path: string) {
  const controller = new AbortController();
  const res = await fetch(`${ctx.origin}${path}`, {
    headers: { cookie: ctx.cookie, origin: ctx.origin },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const events: { event: string; data: any }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const done = (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      buffer += decoder.decode(value);
      let i: number;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const event = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })();
  cleanups.push(() => controller.abort());
  return {
    events,
    of: (name: string) => events.filter(e => e.event === name).map(e => e.data),
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
      await done;
    },
  };
}

describe("Server: Telegram-Nachricht live an offene Browser", () => {
  test("Topic 443 erreicht Zuhörer von topic-443, nicht topic-8; Seitenleiste sieht nur ID und Zeit", async () => {
    const ctx = await start();
    const t443 = await listen(ctx, "/api/conversations/topic-443/events");
    const t8 = await listen(ctx, "/api/conversations/topic-8/events");
    const activity = await listen(ctx, TELEGRAM_ACTIVITY_PATH);
    await waitUntil(() => t443.events.length > 0 && t8.events.length > 0);

    // wie handleTextMessage: topicId und Telegram-Nachrichten-ID, keine msgId
    expect(await ctx.save({ chat_id: GROUP, role: "user", content: "Hallo aus Telegram", metadata: { topicId: 443, messageId: 99 } })).toBe(true);
    // wie callClaudeAndReply
    await ctx.save({ chat_id: GROUP, role: "assistant", content: "**Antwort**", metadata: { agent: "general", topicId: 443 } });

    await waitUntil(() => t443.of("message").length === 2 && activity.of("activity").length === 2);
    const [user, reply] = t443.of("message");
    expect(user).toEqual({ id: expect.stringMatching(UUID), role: "user", text: "Hallo aus Telegram", createdAt: expect.any(String) });
    expect(reply.role).toBe("assistant");
    expect(reply.agent).toBe("general");
    expect(reply.html).toContain("<strong>Antwort</strong>");
    expect(t8.of("message")).toEqual([]);
    // Nur status zum Start, sonst nichts
    expect(t8.events.map(e => e.event)).toEqual(["status"]);
    expect(activity.of("activity")).toEqual([
      { id: "topic-443", lastActivity: user.createdAt },
      { id: "topic-443", lastActivity: reply.createdAt },
    ]);
    // Sammelstrom: kein status und kein Inhalt
    expect(activity.events.map(e => e.event)).toEqual(["activity", "activity"]);
    expect(JSON.stringify(activity.events)).not.toContain("Hallo");
  });

  test("msgId bleibt beim Nachladen stabil: Verlauf trägt dieselben IDs wie SSE", async () => {
    const ctx = await start();
    const t443 = await listen(ctx, "/api/conversations/topic-443/events");
    await waitUntil(() => t443.events.length > 0);
    await ctx.save({ chat_id: GROUP, role: "user", content: "eins", metadata: { topicId: 443, messageId: 1 } });
    await ctx.save({ chat_id: GROUP, role: "assistant", content: "zwei", metadata: { agent: "general", topicId: 443 } });
    await waitUntil(() => t443.of("message").length === 2);
    const live = t443.of("message").map(m => m.id);

    const history = await (
      await fetch(`${ctx.origin}/api/conversations/topic-443/messages`, { headers: { cookie: ctx.cookie } })
    ).json();
    expect(history.messages.map((m: { id: string }) => m.id)).toEqual(live);
    // Browser mischt nach ID: Vereinigung beider Quellen hat keine Doppelung
    const merged = new Set([...live, ...history.messages.map((m: { id: string }) => m.id)]);
    expect(merged.size).toBe(2);
    // gespeichert wurde genau diese msgId, die Telegram-ID steht weiter daneben
    expect((ctx.rows[0].metadata as any).msgId).toBe(live[0]);
    expect((ctx.rows[0].metadata as any).messageId).toBe(1);
  });

  test("Web-Nachrichten (channel web) gehen nicht doppelt raus, nur die Aktivität", async () => {
    const ctx = await start();
    const t443 = await listen(ctx, "/api/conversations/topic-443/events");
    const activity = await listen(ctx, TELEGRAM_ACTIVITY_PATH);
    await waitUntil(() => t443.events.length > 0);
    await ctx.save({
      chat_id: GROUP,
      role: "user",
      content: "aus dem Browser",
      metadata: { topicId: 443, channel: "web", msgId: "web-1b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed" },
    });
    await waitUntil(() => activity.of("activity").length === 1);
    await Bun.sleep(20);
    expect(t443.of("message")).toEqual([]);
    expect(activity.of("activity")[0].id).toBe("topic-443");
  });

  test("Direktchat und General (Gruppe ohne Topic)", async () => {
    const ctx = await start();
    const dm = await listen(ctx, "/api/conversations/dm/events");
    const general = await listen(ctx, "/api/conversations/topic-1/events");
    await waitUntil(() => dm.events.length > 0 && general.events.length > 0);
    await ctx.save({ chat_id: USER, role: "user", content: "privat", metadata: { messageId: 5 } });
    await ctx.save({ chat_id: GROUP, role: "user", content: "allgemein", metadata: { messageId: 6 } });
    await ctx.save({ chat_id: OTHER_GROUP, role: "user", content: "fremd", metadata: { topicId: 443 } });
    await waitUntil(() => dm.of("message").length === 1 && general.of("message").length === 1);
    await Bun.sleep(20);
    expect(dm.of("message").map(m => m.text)).toEqual(["privat"]);
    expect(general.of("message").map(m => m.text)).toEqual(["allgemein"]);
  });

  test("ein werfender Zuhörer verhindert weder das Speichern noch die Live-Nachricht", async () => {
    const ctx = await start();
    cleanups.push(
      onMessageSaved(() => {
        throw new Error("kaputter Zuhörer");
      })
    );
    const t443 = await listen(ctx, "/api/conversations/topic-443/events");
    await waitUntil(() => t443.events.length > 0);
    expect(await ctx.save({ chat_id: GROUP, role: "user", content: "trotzdem", metadata: { topicId: 443 } })).toBe(true);
    expect(ctx.rows).toHaveLength(1);
    await waitUntil(() => t443.of("message").length === 1);
  });

  test("Server-Stopp meldet den Zuhörer ab", async () => {
    let subscribed = 0;
    let unsubscribed = 0;
    await start({
      onMessageSaved: () => {
        subscribed++;
        return () => {
          unsubscribed++;
        };
      },
    });
    expect(subscribed).toBe(1);
    for (const s of servers.splice(0)) await s.stop();
    expect(unsubscribed).toBe(1);
  });

  test("Sammelstrom nur angemeldet und nur GET", async () => {
    const ctx = await start();
    expect((await fetch(`${ctx.origin}${TELEGRAM_ACTIVITY_PATH}`)).status).toBe(401);
    const post = await fetch(`${ctx.origin}${TELEGRAM_ACTIVITY_PATH}`, {
      method: "POST",
      headers: { cookie: ctx.cookie, origin: ctx.origin },
    });
    expect(post.status).toBe(405);
  });
});

describe("Verdrahtung", () => {
  test("src/bot.ts reicht die Live-Quelle an startWebUi weiter, startWebUi an den Server (ohne bot.ts zu importieren)", async () => {
    const bot = await Bun.file(join(import.meta.dir, "..", "src", "bot.ts")).text();
    const call = bot.slice(bot.indexOf("webServer = await startWebUi({"));
    expect(call.slice(0, call.indexOf("});"))).toContain("telegramLive: createBotTelegramLive(process.env)");
    const startup = await Bun.file(join(import.meta.dir, "..", "src", "web", "startup.ts")).text();
    expect(startup).toContain("telegramLive: options.telegramLive,");
  });
});
