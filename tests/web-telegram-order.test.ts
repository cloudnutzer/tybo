// Issue #69: Reihenfolge eines Web-Turns in einem Telegram-Topic. Echter
// Web-Server, echter Telegram-Turn, echte Live-Quelle und die echten
// Speicherwege (saveMessage, saveDisplayOnlyMessage, getConversationHistory
// aus src/lib); nur Supabase ist eine Attrappe, die wie die Datenbank
// created_at selbst vergibt, wenn keins mitkommt, und nach created_at
// sortiert. Die Edge-Function-Attrappe baut ihre Zeile mit der echten
// messageRow. src/bot.ts wird nie importiert.
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { messageRow } from "../supabase/functions/store-telegram-message/row";
import { onMessageSaved, saveDisplayOnlyMessage, saveMessage } from "../src/lib/convex";
import { abortAllExecutions, abortExecutions, currentExecution } from "../src/lib/execution-context";
import { ABORT_REPLY } from "../src/lib/chat-turn";
import { getConversationHistory, resetSupabaseClient } from "../src/lib/supabase";
import { createTelegramLiveFeed, createTelegramSource } from "../src/web/bot-telegram";
import { createTelegramChat } from "../src/web/bot-turn";
import { createWebServer, type WebServer } from "../src/web/server";

const PASSWORD = "test-passwort-lang";
const GROUP = "-1001234567890";
const USER = "4711";
const TOPIC = 2871;
const SUPABASE = "http://supabase.test";
const root = await mkdtemp(join(tmpdir(), "tybo-web-tg-order-"));
let counter = 0;
afterAll(() => rm(root, { recursive: true, force: true }));

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  abortAllExecutions();
  while (cleanups.length) await cleanups.pop()!();
});

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

type Row = Record<string, any>;

/**
 * messages-Tabelle im Speicher hinter globalThis.fetch: POST legt Zeilen an
 * (created_at-Default = Zeitpunkt des Inserts), GET filtert eq.-Spalten,
 * sortiert nach order und begrenzt auf limit, wie PostgREST.
 */
function fakeSupabaseTable() {
  const rows: Row[] = [];
  let id = 0;
  const insert = (row: Row) => {
    rows.push({ id: String(++id), ...row, created_at: row.created_at ?? new Date().toISOString() });
  };
  const saved = {
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    CONVEX_URL: process.env.CONVEX_URL,
  };
  process.env.SUPABASE_URL = SUPABASE;
  process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
  delete process.env.CONVEX_URL;
  resetSupabaseClient();
  // Web-Server und Login laufen über das echte fetch, nur Supabase nicht
  const realFetch = globalThis.fetch;
  const spy = spyOn(globalThis, "fetch");
  spy.mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== SUPABASE) return realFetch(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (url.pathname === "/functions/v1/store-telegram-message") {
      insert(messageRow(body, null));
      return Response.json({ ok: true });
    }
    if (url.pathname !== "/rest/v1/messages") return Response.json([]);
    if (method === "POST") {
      for (const row of Array.isArray(body) ? body : [body]) insert(row);
      return new Response(null, { status: 201 });
    }
    let result = rows.filter(r => {
      for (const [key, value] of url.searchParams) {
        if (["select", "order", "limit"].includes(key)) continue;
        if (value.startsWith("eq.") && String(r[key]) !== value.slice(3)) return false;
      }
      return true;
    });
    const order = url.searchParams.get("order");
    if (order?.startsWith("created_at.")) {
      const dir = order.endsWith(".desc") ? -1 : 1;
      result = [...result].sort((a, b) => dir * (Date.parse(a.created_at) - Date.parse(b.created_at)));
    }
    const limit = Number(url.searchParams.get("limit"));
    if (limit > 0) result = result.slice(0, limit);
    return Response.json(result);
  }) as typeof fetch);
  cleanups.push(() => {
    spy.mockRestore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSupabaseClient();
  });
  return rows;
}

async function start(core: () => Promise<string>) {
  const dir = join(root, `case-${++counter}`);
  const rows = fakeSupabaseTable();
  const telegramChat = createTelegramChat({
    userId: USER,
    groupId: () => GROUP,
    agentForTopic: () => "general",
    runStreamingTurn: core,
    // wie webTurnDeps in src/bot.ts: das echte saveMessage aus src/lib/convex.ts
    saveMessage,
    processIntents: async () => {},
    abortEngineCalls: key => abortExecutions(key),
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    sendPlain: async () => {},
    sendAsAgent: async () => {},
    log: () => {},
  });
  const telegram = createTelegramSource({
    userId: USER,
    groupId: () => GROUP,
    topicNames: async () => ({ [String(TOPIC)]: "foldable iphone" }),
    topicMapping: () => ({ [String(TOPIC)]: "general" }),
    history: (chatId, topicId, options) => getConversationHistory(chatId, topicId, options),
    activity: async () => [],
    log: () => {},
  });
  const server: WebServer = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "web-sessions.json"),
      dataDir: join(dir, "web"),
      telegram,
      telegramChat,
      telegramLive: createTelegramLiveFeed({ userId: USER, groupId: () => GROUP, onMessageSaved, log: () => {} }),
      log: () => {},
    }
  );
  cleanups.push(() => server.stop());
  const origin = server.url;
  const login = await fetch(`${origin}/api/login`, {
    method: "POST",
    headers: { origin },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const api = (path: string, init: { method?: string; body?: unknown } = {}) =>
    fetch(`${origin}${path}`, {
      method: init.method ?? "GET",
      headers: { origin, "content-type": "application/json", cookie },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  /** SSE des Topics mitlesen */
  async function listen() {
    const controller = new AbortController();
    const res = await fetch(`${origin}/api/conversations/topic-${TOPIC}/events`, {
      headers: { cookie, origin },
      signal: controller.signal,
    });
    const events: { event: string; data: any }[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    void (async () => {
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
    await waitUntil(() => events.length > 0);
    return { messages: () => events.filter(e => e.event === "message").map(e => e.data), events };
  }

  return { rows, api, listen };
}

/** Wie bun run notify während des Turns: Datei-Meldung sofort gespeichert */
async function noticeDuringTurn(): Promise<void> {
  await Bun.sleep(15);
  const ok = await saveDisplayOnlyMessage({
    chat_id: GROUP,
    role: "assistant",
    content: "drei-zeilen.txt",
    metadata: { display_only: true, source: "datei", topicId: TOPIC },
  });
  expect(ok).toBe(true);
  await Bun.sleep(15);
}

describe("Web-Turn in einem Topic: Nutzernachricht vor Meldung vor Antwort", () => {
  test("Neuladen (getConversationHistory) und Live-Ansicht zeigen dieselbe Reihenfolge", async () => {
    const ctx = await start(async () => {
      await noticeDuringTurn();
      return "Hier ist die Datei.";
    });
    const live = await ctx.listen();

    const res = await ctx.api(`/api/conversations/topic-${TOPIC}/messages`, {
      method: "POST",
      body: { text: "Erstelle eine kleine Textdatei mit drei Zeilen und schick sie mir." },
    });
    expect(res.status).toBe(202);
    const { message } = await res.json();
    await waitUntil(() => live.messages().length === 3 && ctx.rows.length === 3);

    // Speicher: die Nutzernachricht trägt ihren Eingangszeitpunkt aus dem ChatHub
    const userRow = ctx.rows.find(r => r.role === "user")!;
    expect(userRow.metadata.channel).toBe("web");
    expect(userRow.created_at).toBe(message.createdAt);
    // gespeichert wurde sie erst am Turn-Ende, also nach der Meldung
    expect(ctx.rows.map(r => r.role)).toEqual(["assistant", "user", "assistant"]);
    expect(ctx.rows[0].metadata.display_only).toBe(true);

    // Neuladen: Verlauf über die echte getConversationHistory
    const history = await (await ctx.api(`/api/conversations/topic-${TOPIC}/messages`)).json();
    const reloaded = history.messages.map((m: any) => ({ id: m.id, kind: m.kind ?? m.role, at: m.createdAt }));
    expect(reloaded.map((m: any) => m.kind)).toEqual(["user", "notice", "assistant"]);
    expect(reloaded[0].id).toBe(message.id);

    // Live: dieselben Einträge in derselben Reihenfolge, nach Eingang wie nach Zeitpunkt
    const liveMessages = live.messages().map((m: any) => ({ id: m.id, kind: m.kind ?? m.role, at: m.createdAt }));
    expect(liveMessages.map((m: any) => m.id)).toEqual(reloaded.map((m: any) => m.id));
    const byTime = [...liveMessages].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    expect(byTime.map(m => m.id)).toEqual(reloaded.map((m: any) => m.id));
    // Nutzernachricht live mit genau dem übergebenen Zeitpunkt aus dem Speicher
    expect(liveMessages[0].at).toBe(reloaded[0].at);
    // die Meldung bekommt ihren Zeitpunkt ohne created_at getrennt beim Insert und
    // beim Senden, dort zählen nur Platz und ID, nicht die exakte Millisekunde
    expect(liveMessages[1].kind).toBe("notice");
    expect(liveMessages[1].id).toBe(reloaded[1].id);
  });

  test("Stopp: Nutzernachricht und Antwort nicht gespeichert, die schon gespeicherte Meldung bleibt", async () => {
    const ctx = await start(async () => {
      await noticeDuringTurn();
      const signal = currentExecution()!.controller.signal;
      await new Promise<void>(r => (signal.aborted ? r() : signal.addEventListener("abort", () => r(), { once: true })));
      return ABORT_REPLY;
    });
    const res = await ctx.api(`/api/conversations/topic-${TOPIC}/messages`, { method: "POST", body: { text: "Frage" } });
    expect(res.status).toBe(202);
    await waitUntil(() => ctx.rows.length === 1);
    expect((await ctx.api(`/api/conversations/topic-${TOPIC}/stop`, { method: "POST" })).status).toBeLessThan(300);
    let history: any;
    for (const end = Date.now() + 3000; ; ) {
      history = await (await ctx.api(`/api/conversations/topic-${TOPIC}/messages`)).json();
      if (!history.running || Date.now() > end) break;
      await Bun.sleep(10);
    }
    expect(history.running).toBe(false);
    expect(ctx.rows.map(r => r.metadata.display_only === true)).toEqual([true]);
    expect(history.messages.map((m: any) => m.kind)).toEqual(["notice"]);
  });
});
