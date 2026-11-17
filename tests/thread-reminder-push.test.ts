/**
 * Push bei Erinnerungen an offene Fäden (Issue #292, Nachbesserung): durch die
 * bestehenden Web-Komponenten (echtes Rückfragen-Register mit ChoicePort,
 * echter Web-Server mit Benachrichtiger und Versand-Attrappe, Übernahme der
 * Meldungen in Web-Gespräche) und den echten Zeitgeber mit echter Outbox.
 *
 * Erinnerungen pushen nur über den Meldungsweg, also erst wenn sie
 * zugestellt bzw. festgehalten sind, und nur mit eingeschalteter
 * Meldungskategorie. Das Anlegen der Rückfrage pusht nie, damit auch
 * verwaiste, konkurrierende und sicher abgelehnte Versuche nicht.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChoice, listChoices, setChoicesFileForTests, type ChoiceConversation, type CreateChoiceInput, type CreateChoiceOptions } from "../src/lib/choices";
import { sendAndRecord, type OutboxDeps } from "../src/lib/outbox";
import { THREAD_OPTIONS } from "../src/lib/thread-choices";
import { createThreadReminders } from "../src/lib/threads/remind";
import { createThread, setThreadsFileForTests, updateThreads } from "../src/lib/threads/store";
import { generateVapidKeys } from "../src/web/push";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import type { WebNoticeEvent } from "../src/web/web-notices";
import { testChoices, type TestChoices } from "./choices-fixture";
import { decryptPush, receiverSubscription } from "./push-fixture";

const PASSWORD = "test-passwort-lang";
const GROUP = "-1001234567890";
const ENV = { USER_TIMEZONE: "UTC" };
const T10 = Date.parse("2026-10-15T10:00:00Z");
const PUSH_WAIT_MS = 10_000;
const keys = await generateVapidKeys();
const root = await mkdtemp(join(tmpdir(), "tybo-thread-push-"));
const servers: WebServer[] = [];
let counter = 0;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  logSpy.mockRestore();
  setChoicesFileForTests(null);
  setThreadsFileForTests(null);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Antwort der Telegram-Attrappe in der Outbox */
type TelegramReply = () => Response;
const accepted: TelegramReply = () => new Response(JSON.stringify({ ok: true, result: { message_id: ++counter } }), { status: 200 });
const rejected: TelegramReply = () => new Response(JSON.stringify({ ok: false, description: "Bad Request: message thread not found" }), { status: 400 });

async function start(o: { telegramReply?: TelegramReply } = {}) {
  const dir = join(root, `case-${++counter}`);
  setThreadsFileForTests(join(dir, "threads.json"));
  const choices: TestChoices = testChoices(join(dir, "choices.json"), { userId: "4711", groupId: GROUP });
  const pushes: Promise<any>[] = [];
  const fakeFetch = (async (_url: string, init: RequestInit) => {
    pushes.push(decryptPush(init.body as Uint8Array).then(t => JSON.parse(t)));
    return new Response(null, { status: 201 });
  }) as unknown as typeof fetch;
  const hooks = new Set<(e: WebNoticeEvent) => void | Promise<void>>();
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [], publicOrigin: null, access: null },
    {
      sessionFile: join(dir, "sessions.json"),
      dataDir: join(dir, "web"),
      cliTokenFile: join(dir, "cli-token"),
      conversationStore: store,
      choices: choices.port,
      webNotices: {
        page: async () => [],
        onMessageSaved: l => {
          hooks.add(l);
          return () => void hooks.delete(l);
        },
        every: () => () => {},
      },
      // Ohne Telegram: Meldungen sind standardmäßig an
      push: { keys, subject: "https://tybo.example", fetch: fakeFetch, telegram: false },
      log: () => {},
    }
  );
  servers.push(server);
  const res = await fetch(`${server.url}/api/login`, { method: "POST", headers: { origin: server.url }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  const call = (method: string, path: string, body?: unknown) =>
    fetch(`${server.url}${path}`, { method, headers: { origin: server.url, cookie, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const subscribed = await call("POST", "/api/push/subscriptions", { subscription: receiverSubscription(1) });
  expect(subscribed.status).toBe(201);
  const device = (await subscribed.json()).device;

  // Echte Outbox: Telegram-Attrappe und Nachrichtenspeicher, der wie onMessageSaved meldet
  const telegramCalls: string[] = [];
  let n = 0;
  const outbox: OutboxDeps = {
    botToken: "123:test",
    userId: "4711",
    groupId: GROUP,
    outboxDir: join(dir, "outbox"),
    fetch: async url => {
      telegramCalls.push(url);
      return (o.telegramReply ?? accepted)();
    },
    record: async m => {
      const metadata = { ...(m.metadata ?? {}), msgId: crypto.randomUUID() };
      const createdAt = new Date(Date.now() + ++n).toISOString();
      for (const h of hooks) await h({ chatId: m.chat_id, role: m.role, content: m.content, metadata, createdAt });
      return true;
    },
    log: () => {},
    newId: () => crypto.randomUUID(),
  };
  const outboxSends: string[] = [];
  const reminders = (extra: { createChoice?: (input: CreateChoiceInput, options?: CreateChoiceOptions) => Promise<any> } = {}) =>
    createThreadReminders({
      now: () => T10,
      env: () => ENV,
      telegram: () => true,
      send: input => {
        outboxSends.push(String(input.chatId));
        return sendAndRecord(input, outbox);
      },
      conversationGone: async () => false,
      log: () => {},
      ...extra,
    });

  const webConversation = async () => (await store.createConversation("general")).id;
  const dueThread = async (conversation: ChoiceConversation) => {
    const r = await createThread({ conversation, topic: "Reiseziel", context: "Wohin geht die Reise im Dezember?", question: "Hamburg oder München?" });
    if (r.status !== "created") throw new Error("nicht angelegt");
    await updateThreads(threads => {
      threads[r.thread.id].nextReminderAt = T10 - 1;
      return { result: null, changed: true };
    });
    return r.thread.id;
  };
  /**
   * Push-Verteilung abwarten, auch den 15-Sekunden-Abgleich des Ports. Der
   * Server verschickt ohne Warten (Titel lesen, verschlüsseln), unter Last also
   * beliebig spät: Erwartete Pushes bekommen eine Frist, die letzte Pause lässt
   * einem überzähligen Push noch Zeit, aufzufallen.
   */
  const settle = async (expectedPushes = 0) => {
    await Bun.sleep(30);
    await choices.tick();
    const deadline = Date.now() + PUSH_WAIT_MS;
    while (pushes.length < expectedPushes && Date.now() < deadline) await Bun.sleep(5);
    await Bun.sleep(30);
  };
  const setNotices = (on: boolean) => call("PATCH", `/api/push/subscriptions/${device.id}`, { settings: { notices: on } });
  return { server, store, choices, pushes, telegramCalls, outboxSends, reminders, webConversation, dueThread, settle, setNotices };
}

describe("Push bei Erinnerungen an offene Fäden", () => {
  test("Anlegen einer thread-Rückfrage pusht nicht, auch nicht dreimal, mit Meldungen an oder aus", async () => {
    const ctx = await start();
    const id = await ctx.webConversation();
    const conversation: ChoiceConversation = { type: "web", conversationId: id };
    for (const on of [true, false]) {
      await ctx.setNotices(on);
      for (let i = 0; i < 3; i++) {
        await createChoice({ kind: "thread", conversation, text: "🧵 Offen seit gestern", options: THREAD_OPTIONS, ref: `Faden${i}xxxxx` });
      }
      await ctx.settle();
    }
    expect(ctx.outboxSends).toEqual([]);
    expect(ctx.pushes).toHaveLength(0);
    // Gegenprobe: eine andere Art pusht beim Anlegen weiterhin
    await ctx.choices.create({ conversation });
    await ctx.settle(1);
    expect(ctx.pushes).toHaveLength(1);
    expect(await ctx.pushes[0]).toMatchObject({ category: "choice" });
  });

  test("zugestellte Erinnerung im Web-Gespräch: genau ein Push über den Meldungsweg", async () => {
    const ctx = await start();
    const id = await ctx.webConversation();
    const thread = await ctx.dueThread({ type: "web", conversationId: id });
    const r = await ctx.reminders().tick();
    await ctx.settle(1);
    expect(r.sent).toBe(1);
    expect(ctx.outboxSends).toEqual([`web:${id}`]);
    expect(ctx.pushes).toHaveLength(1);
    const payload = await ctx.pushes[0];
    expect(payload).toMatchObject({ category: "notice", conversationId: id, title: "Fäden", body: "Neue Meldung" });
    expect(JSON.stringify(payload)).not.toContain("Hamburg");
    // Im Gespräch steht die Erinnerung mit Rückfrage
    const messages = await ctx.store.getMessages(id);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ kind: "notice", source: "faeden" });
    expect(messages[0].choiceId).toBe((await listChoices()).find(c => c.ref === thread)!.id);
  });

  test("Meldungskategorie aus: zugestellte Erinnerung pusht nicht", async () => {
    const ctx = await start();
    await ctx.setNotices(false);
    const id = await ctx.webConversation();
    await ctx.dueThread({ type: "web", conversationId: id });
    expect((await ctx.reminders().tick()).sent).toBe(1);
    await ctx.settle();
    expect(ctx.outboxSends).toHaveLength(1);
    expect(ctx.pushes).toHaveLength(0);
  });

  test("sicher abgelehnt (Telegram 400), drei Versuche: kein Push", async () => {
    const ctx = await start({ telegramReply: rejected });
    await ctx.dueThread({ type: "telegram", chatId: GROUP, topicId: 7 });
    for (let i = 0; i < 3; i++) await ctx.reminders().tick();
    await ctx.settle();
    expect(ctx.outboxSends).toHaveLength(3);
    expect(ctx.telegramCalls.length).toBeGreaterThanOrEqual(3);
    expect(ctx.pushes).toHaveLength(0);
  });

  test("verwaiste Rückfrage (Abbruch nach dem Anlegen) und zwei gleichzeitige Durchgänge: ein Push", async () => {
    const ctx = await start();
    const id = await ctx.webConversation();
    const thread = await ctx.dueThread({ type: "web", conversationId: id });
    // Erster Versuch: Rückfrage angelegt, danach bricht der Durchgang ab
    const orphan = ctx.reminders({
      createChoice: async (input, options) => {
        await createChoice(input, options);
        throw new Error("Absturz nach dem Anlegen");
      },
    });
    expect((await orphan.tick()).sent).toBe(0);
    // Zwei Zeitgeber gleichzeitig
    const results = await Promise.all([ctx.reminders().tick(), ctx.reminders().tick()]);
    await ctx.settle(1);
    expect(results.reduce((s, r) => s + r.sent, 0)).toBe(1);
    expect(ctx.outboxSends).toHaveLength(1);
    expect(ctx.pushes).toHaveLength(1);
    expect(await ctx.pushes[0]).toMatchObject({ category: "notice", title: "Fäden" });
    const open = (await listChoices()).filter(c => c.ref === thread && c.state === "open");
    expect(open).toHaveLength(1);
  });
});
