// Schreiben in Telegram-Gespräche über die API (Issue #19): echter Web-Server,
// echter Telegram-Turn (createTelegramChat) und echte Telegram-Quelle, nur
// Claude, Supabase und Telegram sind Attrappen. Der Verlauf liest, was der
// Turn gespeichert hat: so zeigt der Test, dass POST, SSE und Nachladen
// dieselben IDs tragen.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ABORT_REPLY } from "../src/lib/chat-turn";
import { abortAllExecutions, abortExecutions, currentExecution } from "../src/lib/execution-context";
import type { HistoryRow } from "../src/lib/supabase";
import { ABORTED_TEXT, MAX_MESSAGE_CHARS } from "../src/web/chat";
import { createTelegramSource } from "../src/web/bot-telegram";
import { createTelegramChat, type WebSavedMessage } from "../src/web/bot-turn";
import { createWebServer, type WebServer } from "../src/web/server";
import { isWebMessageId } from "../src/web/telegram";

const PASSWORD = "test-passwort-lang";
const GROUP = "-1001234567890";
const USER = "4711";
const root = await mkdtemp(join(tmpdir(), "tybo-web-tg-write-"));
let counter = 0;
afterAll(() => rm(root, { recursive: true, force: true }));

const servers: WebServer[] = [];
afterEach(async () => {
  abortAllExecutions();
  for (const s of servers.splice(0)) await s.stop();
});

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

interface Ctx {
  origin: string;
  cookie: string;
  server: WebServer;
  saved: WebSavedMessage[];
  plain: { chatId: string; text: string; threadId?: number }[];
  agentSends: { agent: string; chatId: string; text: string; threadId?: number }[];
  intents: string[];
  /** Was Claude tut; Standard: sofort antworten */
  core: () => Promise<string>;
  claudeStarted: number;
}

async function start(): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  const ctx = { saved: [], plain: [], agentSends: [], intents: [], claudeStarted: 0 } as unknown as Ctx;
  ctx.core = async () => "**Antwort** aus dem Topic";
  let rowCounter = 0;
  const rows: HistoryRow[] = [];
  const telegramChat = createTelegramChat({
    userId: USER,
    groupId: () => GROUP,
    agentForTopic: topicId => (topicId === 443 ? "finance" : undefined),
    runStreamingTurn: async () => {
      ctx.claudeStarted++;
      return ctx.core();
    },
    saveMessage: async m => {
      ctx.saved.push(m);
      // wie Supabase: eigene Zeilen-ID, created_at mit Mikrosekunden
      rows.push({
        id: `row-${++rowCounter}`,
        created_at: new Date(Date.now() + rowCounter).toISOString().replace("Z", "123+00:00"),
        role: m.role,
        content: m.content,
        metadata: m.metadata ?? null,
        chat_id: m.chat_id,
      } as HistoryRow);
      return true;
    },
    processIntents: async t => {
      ctx.intents.push(t);
    },
    abortClaudeCalls: key => abortExecutions(key),
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    sendPlain: async (chatId, text, threadId) => {
      ctx.plain.push({ chatId, text, threadId });
    },
    sendAsAgent: async (agent, chatId, text, threadId) => {
      ctx.agentSends.push({ agent, chatId, text, threadId });
    },
    log: () => {},
  });
  const telegram = createTelegramSource({
    userId: USER,
    groupId: () => GROUP,
    topicNames: async () => ({ "443": "Finanzen" }),
    topicMapping: () => ({ "443": "finance" }),
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
      telegramChat,
      log: () => {},
    }
  );
  servers.push(server);
  ctx.server = server;
  ctx.origin = server.url;
  const res = await fetch(`${ctx.origin}/api/login`, {
    method: "POST",
    headers: { origin: ctx.origin },
    body: JSON.stringify({ password: PASSWORD }),
  });
  ctx.cookie = res.headers.get("set-cookie")!.split(";")[0];
  return ctx;
}

function api(ctx: Ctx, path: string, init: { method?: string; body?: unknown } = {}) {
  return fetch(`${ctx.origin}${path}`, {
    method: init.method ?? "GET",
    headers: { origin: ctx.origin, "content-type": "application/json", cookie: ctx.cookie },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

/** Liest SSE-Ereignisse einer Telegram-Unterhaltung mit */
async function listen(ctx: Ctx, id: string) {
  const controller = new AbortController();
  const res = await fetch(`${ctx.origin}/api/conversations/${id}/events`, {
    headers: { cookie: ctx.cookie, origin: ctx.origin },
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  const events: { event: string; data: any }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let ended = false;
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
    ended = true;
  })();
  await waitUntil(() => events.length > 0);
  return {
    events,
    ended: () => ended,
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
      await done;
    },
  };
}

describe("POST in ein Topic", () => {
  test("202 mit web-ID, SSE liefert die Antwort, Nachladen zeigt dieselben IDs ohne Doppelungen", async () => {
    const ctx = await start();
    const sse = await listen(ctx, "topic-443");
    expect(sse.events[0]).toEqual({ event: "status", data: { running: false } });

    const res = await api(ctx, "/api/conversations/topic-443/messages", { method: "POST", body: { text: "Wie steht das Budget?" } });
    expect(res.status).toBe(202);
    const { message } = await res.json();
    expect(isWebMessageId(message.id)).toBe(true);
    expect(message).toMatchObject({ role: "user", text: "Wie steht das Budget?" });

    await waitUntil(() => sse.events.some(e => e.event === "status" && e.data.running === false && sse.events.indexOf(e) > 0));
    await sse.close();
    // Der schon verbundene Empfänger bekommt Nutzer- und Agentennachricht, mit den IDs aus POST und Verlauf
    const published = sse.events.filter(e => e.event === "message").map(e => e.data);
    expect(published.map((m: any) => m.role)).toEqual(["user", "assistant"]);
    expect(published[0]).toEqual(message);
    const reply = published[1];
    expect(reply.role).toBe("assistant");
    expect(isWebMessageId(reply.id)).toBe(true);
    expect(reply.html).toContain("<strong>Antwort</strong>");

    // Telegram: erst die Spiegelung als Klartext, dann die Antwort vom Agenten-Bot im Topic
    expect(ctx.plain).toEqual([{ chatId: GROUP, text: "Du (Web): Wie steht das Budget?", threadId: 443 }]);
    expect(ctx.agentSends).toEqual([{ agent: "finance", chatId: GROUP, text: "**Antwort** aus dem Topic", threadId: 443 }]);

    const history = await (await api(ctx, "/api/conversations/topic-443/messages")).json();
    expect(history.running).toBe(false);
    expect(history.messages.map((m: any) => m.id)).toEqual([message.id, reply.id]);
    expect(history.messages.map((m: any) => m.id)).toEqual(published.map((m: any) => m.id));
    expect(history.messages[1]).toMatchObject({ role: "assistant", agent: "finance" });
    expect(ctx.saved.map(m => m.metadata)).toEqual([
      { topicId: 443, channel: "web", msgId: message.id },
      { topicId: 443, channel: "web", msgId: reply.id, agent: "finance" },
    ]);
  });

  test("läuft: GET zeigt running, zweite Nachricht 409; Stopp über die API: keine Antwort nach Telegram", async () => {
    const ctx = await start();
    ctx.core = () =>
      new Promise(resolve => {
        const signal = currentExecution()!.controller.signal;
        signal.addEventListener("abort", () => resolve(ABORT_REPLY), { once: true });
      });
    const sse = await listen(ctx, "dm");
    const sent = await api(ctx, "/api/conversations/dm/messages", { method: "POST", body: { text: "Lang" } });
    expect(sent.status).toBe(202);
    await waitUntil(() => ctx.claudeStarted === 1);

    expect((await (await api(ctx, "/api/conversations/dm")).json()).running).toBe(true);
    expect((await (await api(ctx, "/api/conversations/dm/messages")).json()).running).toBe(true);
    expect((await api(ctx, "/api/conversations/dm/messages", { method: "POST", body: { text: "noch was" } })).status).toBe(409);

    const stop = await api(ctx, "/api/conversations/dm/stop", { method: "POST" });
    expect(await stop.json()).toEqual({ stopping: true });
    await waitUntil(() => sse.events.some(e => e.event === "error"));
    await waitUntil(() => sse.events.at(-1)?.event === "status");
    await sse.close();
    expect(sse.events.find(e => e.event === "error")!.data.text).toBe(ABORTED_TEXT);
    expect(sse.events.at(-1)).toEqual({ event: "status", data: { running: false } });
    expect(ctx.agentSends).toEqual([]);
    expect(ctx.intents).toEqual([]);
    expect(ctx.saved).toEqual([]);
    // Nach dem Neuladen steht nichts von diesem Turn im Verlauf
    expect((await (await api(ctx, "/api/conversations/dm/messages")).json()).messages).toEqual([]);
    expect(ctx.plain.map(p => p.text)).toEqual(["Du (Web): Lang"]);
  });

  test("Prüfung wie bei Web-Gesprächen: leer, zu lang, kein JSON, unbekanntes Topic", async () => {
    const ctx = await start();
    const post = (id: string, body: unknown) => api(ctx, `/api/conversations/${id}/messages`, { method: "POST", body });
    expect((await post("topic-443", { text: "   " })).status).toBe(400);
    expect((await post("topic-443", { text: "x".repeat(MAX_MESSAGE_CHARS + 1) })).status).toBe(400);
    expect((await post("topic-443", {})).status).toBe(400);
    expect((await post("topic-999", { text: "Hallo" })).status).toBe(404);
    // Freigabe-Antworten gibt es in Telegram-Gesprächen nicht (die Knöpfe sind in Telegram)
    const stale = await post("topic-443", { text: "ja", approvalId: "abc" });
    expect(stale.status).toBe(409);
    expect(ctx.plain).toEqual([]);
    expect(ctx.saved).toEqual([]);
  });

  test("Abmelden beendet die SSE-Verbindung eines Topics", async () => {
    const ctx = await start();
    const sse = await listen(ctx, "topic-443");
    expect(ctx.server.eventStreamCount()).toBe(1);
    expect((await api(ctx, "/api/logout", { method: "POST" })).status).toBe(200);
    await waitUntil(() => sse.ended());
    expect(ctx.server.eventStreamCount()).toBe(0);
    await sse.close();
  });
});
