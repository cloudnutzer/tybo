/**
 * [INVOKE:] im Browser (Issue #76): echter Web-Server, echter Telegram-Turn
 * (createTelegramChat) mit echter Rückfrage-Logik (Budget, canInvokeAgent,
 * keine verschachtelten Rückfragen), echte Telegram-Quelle und echter
 * Nachrichten-Feed. Nur Claude, Telegram und der Nachrichtenspeicher sind
 * Attrappen; src/bot.ts wird nie geladen.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BotRegistry } from "../src/lib/bot-registry";
import { ABORT_REPLY, type TurnInfo } from "../src/lib/chat-turn";
import { commandRegistry } from "../src/lib/commands/builtin";
import type { CommandServices } from "../src/lib/commands/types";
import type { MessageSavedListener } from "../src/lib/convex";
import { capInvocations, executeVisibleInvocation } from "../src/lib/cross-agent";
import { abortAllExecutions, abortExecutions, currentExecution } from "../src/lib/execution-context";
import type { HistoryRow } from "../src/lib/supabase";
import { type RunTurnOptions, type TurnResult, type WebChat } from "../src/web/chat";
import { createBotCommands } from "../src/web/bot-commands";
import { createTelegramLiveFeed, createTelegramSource } from "../src/web/bot-telegram";
import { createTelegramChat, type WebSavedMessage } from "../src/web/bot-turn";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { isolateAgentCatalog } from "./catalog-fixture";

isolateAgentCatalog();

const PASSWORD = "test-passwort-lang";
const GROUP = "-1001234567890";
const USER = "4711";
const root = await mkdtemp(join(tmpdir(), "tybo-web-invoke-"));
let counter = 0;
afterAll(() => rm(root, { recursive: true, force: true }));

const servers: WebServer[] = [];
afterEach(async () => {
  abortAllExecutions();
  for (const s of servers.splice(0)) await s.stop();
});

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

interface Options {
  /** Antwort je Agent */
  replies: Record<string, string>;
  budget?: number;
  /** Rückfragen warten, bis der Test sie freigibt */
  holdInvocations?: boolean;
}

interface Ctx {
  origin: string;
  cookie: string;
  saved: WebSavedMessage[];
  rows: HistoryRow[];
  telegram: string[];
  calls: { agent: string; prompt: string; topicId?: number }[];
  goalChecks: string[];
  release: (() => void)[];
}

async function start(options: Options): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  const ctx: Ctx = { origin: "", cookie: "", saved: [], rows: [], telegram: [], calls: [], goalChecks: [], release: [] };
  let rowCounter = 0;
  let savedHook: MessageSavedListener | null = null;
  const saveMessage = async (m: WebSavedMessage) => {
    const metadata = { ...(m.metadata ?? {}) };
    if (!metadata.msgId) metadata.msgId = crypto.randomUUID();
    ctx.saved.push({ ...m, metadata });
    const row = { id: `row-${++rowCounter}`, created_at: new Date(Date.now() + rowCounter).toISOString(), role: m.role, content: m.content, metadata, chat_id: m.chat_id } as unknown as HistoryRow;
    ctx.rows.push(row);
    await savedHook?.({ chatId: m.chat_id, role: m.role, content: m.content, metadata, createdAt: row.created_at });
    return true;
  };
  const turnDeps = {
    runStreamingTurn: async (opts: { userMessage: string; agentName: string; topicId?: number; onInfo?: (i: TurnInfo) => void }) => {
      const agent = opts.agentName;
      ctx.calls.push({ agent, prompt: opts.userMessage, topicId: opts.topicId });
      opts.onInfo?.({ agent, model: "claude-test", durationMs: 1500 });
      const isInvocation = opts.userMessage.includes("CROSS-AGENT CONSULTATION");
      if (isInvocation && options.holdInvocations) {
        const signal = currentExecution()?.controller.signal;
        await new Promise<void>(resolve => {
          ctx.release.push(resolve);
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        if (signal?.aborted) return ABORT_REPLY;
      }
      return options.replies[agent] ?? `Antwort ${agent}`;
    },
    saveMessage,
    processIntents: async () => {},
    abortEngineCalls: (key: string) => abortExecutions(key),
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
  };
  const telegramDeps = {
    userId: USER,
    groupId: () => GROUP,
    agentForTopic: (topicId: number) => (topicId === 12 ? "research" : undefined),
    sendPlain: async (chatId: string, text: string, threadId?: number) => void ctx.telegram.push(`plain ${chatId} ${threadId} ${text}`),
    sendAsAgent: async (agent: string, chatId: string, text: string, threadId?: number) => void ctx.telegram.push(`send ${agent} ${chatId} ${threadId} ${text}`),
  };
  const commands = createBotCommands({
    ...turnDeps,
    ...telegramDeps,
    registry: commandRegistry,
    services: { abortEngineCalls: (key: string) => abortExecutions(key), getGoal: async () => undefined, pauseGoal: async () => {} } as unknown as CommandServices,
    sendAndRecord: async () => ({ sent: true, recorded: true }),
    resetConversation: async () => ({ status: "unavailable" }),
  });
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const unusedChat: WebChat = { runTurn: async (_o: RunTurnOptions): Promise<TurnResult> => ({ text: "nie" }), stop: () => {} };
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "web-sessions.json"),
      conversationStore: store,
      cliTokenFile: join(dir, "cli-token"),
      chat: unusedChat,
      telegram: createTelegramSource({
        userId: USER,
        groupId: () => GROUP,
        topicNames: async () => ({ "12": "Recherche", "30": "Allgemein" }),
        topicMapping: () => ({ "12": "research" }),
        history: async (chatId, topicId) => ctx.rows.filter(r => (r as any).chat_id === chatId && ((r.metadata as any)?.topicId ?? null) === topicId),
        activity: async () => [],
        log: () => {},
      }),
      telegramChat: createTelegramChat({
        ...turnDeps,
        ...telegramDeps,
        ...(options.budget !== undefined ? { invokeBudget: options.budget } : {}),
        sendTypingAsAgent: async (agent, chatId, threadId) => void ctx.telegram.push(`typing ${agent} ${chatId} ${threadId}`),
        onAgentTurn: (key, agent) => void ctx.goalChecks.push(`${key} ${agent}`),
      }),
      telegramLive: createTelegramLiveFeed({
        userId: USER,
        groupId: () => GROUP,
        onMessageSaved: listener => {
          savedHook = listener;
          return () => {
            savedHook = null;
          };
        },
        log: () => {},
      }),
      commands,
      log: () => {},
    }
  );
  servers.push(server);
  ctx.origin = server.url;
  const res = await fetch(`${ctx.origin}/api/login`, { method: "POST", headers: { origin: ctx.origin }, body: JSON.stringify({ password: PASSWORD }) });
  ctx.cookie = res.headers.get("set-cookie")!.split(";")[0];
  return ctx;
}

const api = (ctx: Ctx, path: string, body?: unknown) =>
  fetch(`${ctx.origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", origin: ctx.origin, cookie: ctx.cookie },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function listen(ctx: Ctx, id: string) {
  const controller = new AbortController();
  const res = await fetch(`${ctx.origin}/api/conversations/${id}/events`, { headers: { cookie: ctx.cookie, origin: ctx.origin }, signal: controller.signal });
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
  await waitUntil(() => events.length > 0);
  return {
    events,
    messages: () => events.filter(e => e.event === "message").map(e => e.data),
    async settled() {
      await waitUntil(() => events.some((e, i) => i > 0 && e.event === "status" && e.data.running === false));
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
      await done;
    },
  };
}

describe("[INVOKE:critic|…] aus einer Antwort im Browser", () => {
  test("erscheint als eigene Nachricht von Critic, live und nach dem Neuladen; Telegram vom Critic-Bot", async () => {
    const ctx = await start({
      budget: 3,
      replies: { general: "Gute Idee, ich hole eine Gegenstimme. [INVOKE:critic|Was spricht gegen einen Newsletter?]", critic: "Drei Risiken: Aufwand, Reichweite, Pflege." },
    });
    const sse = await listen(ctx, "topic-30");
    expect((await api(ctx, "/api/conversations/topic-30/messages", { text: "Newsletter starten?" })).status).toBe(202);
    await sse.settled();
    await sse.close();

    const live = sse.messages();
    expect(live.map((m: any) => [m.role, m.agent ?? null, m.copyText ?? m.text])).toEqual([
      ["user", null, "Newsletter starten?"],
      ["assistant", "general", "Gute Idee, ich hole eine Gegenstimme."],
      ["assistant", "critic", "Drei Risiken: Aufwand, Reichweite, Pflege."],
    ]);
    const critic = live[2];
    expect(critic).toMatchObject({ model: "claude-test", durationMs: 1500 });
    // Fortschritt nennt den gefragten Agenten
    expect(sse.events.some(e => e.event === "notice" && e.data.text === "Critic denkt nach …")).toBe(true);

    // Gespeichert mit Agent, eigener msgId (dieselbe wie live) und Herkunft; der Feed doppelt nichts
    const stored = ctx.saved.find(m => (m.metadata as any).agent === "critic")!;
    expect(stored.metadata).toMatchObject({ channel: "web", msgId: critic.id, invokedBy: "general", topicId: 30 });
    expect(live.filter((m: any) => m.id === critic.id)).toHaveLength(1);

    // Neuladen: der Verlauf zeigt Critic als Sprecher, mit derselben ID
    const history = await (await api(ctx, "/api/conversations/topic-30/messages")).json();
    const reloaded = history.messages.find((m: any) => m.id === critic.id);
    expect(reloaded).toMatchObject({ role: "assistant", agent: "critic", text: "Drei Risiken: Aufwand, Reichweite, Pflege." });

    // Telegram: Spiegelung, Antwort von General ohne Tag, Tippt-Anzeige und Antwort vom Critic-Bot
    expect(ctx.telegram).toEqual([
      `plain ${GROUP} 30 Du (Web): Newsletter starten?`,
      `send general ${GROUP} 30 Gute Idee, ich hole eine Gegenstimme.`,
      `typing critic ${GROUP} 30`,
      `send critic ${GROUP} 30 Drei Risiken: Aufwand, Reichweite, Pflege.`,
    ]);
    // Rückfrage mit dem Kontext wie in Telegram, im selben Topic
    expect(ctx.calls.map(c => [c.agent, c.topicId])).toEqual([["general", 30], ["critic", 30]]);
    expect(ctx.calls[1].prompt).toContain("Was spricht gegen einen Newsletter?");
  });

  test("verschachtelte Rückfragen laufen nicht, der Tag verschwindet aus der Antwort", async () => {
    const ctx = await start({
      budget: 3,
      replies: { general: "[INVOKE:strategy|Wie weiter?]", strategy: "Erst messen. [INVOKE:finance|Kosten?]" },
    });
    const sse = await listen(ctx, "dm");
    await api(ctx, "/api/conversations/dm/messages", { text: "Plan?" });
    await sse.settled();
    await sse.close();
    expect(ctx.calls.map(c => c.agent)).toEqual(["general", "strategy"]);
    expect(sse.messages().at(-1)).toMatchObject({ agent: "strategy", text: "Erst messen." });
    expect(ctx.telegram.at(-1)).toBe(`send strategy ${USER} undefined Erst messen.`);
  });

  test("Budget: höchstens AGENT_INVOKE_BUDGET Rückfragen je Antwort", async () => {
    const ctx = await start({
      budget: 2,
      replies: { general: "[INVOKE:critic|a] [INVOKE:research|b] [INVOKE:finance|c]" },
    });
    const sse = await listen(ctx, "dm");
    await api(ctx, "/api/conversations/dm/messages", { text: "los" });
    await sse.settled();
    await sse.close();
    expect(ctx.calls.map(c => c.agent)).toEqual(["general", "critic", "research"]);
    expect(sse.messages().map((m: any) => m.agent ?? null)).toEqual([null, "general", "critic", "research"]);
  });

  test("Rechte: Research darf Finance nicht fragen, Critic schon", async () => {
    const ctx = await start({ budget: 3, replies: { research: "[INVOKE:finance|Zahlen?] [INVOKE:critic|Prüfen?]" } });
    const sse = await listen(ctx, "topic-12");
    await api(ctx, "/api/conversations/topic-12/messages", { text: "Markt?" });
    await sse.settled();
    await sse.close();
    expect(ctx.calls.map(c => c.agent)).toEqual(["research", "critic"]);
  });

  test("ohne Budget (wie vor M5) werden Rückfragen nicht ausgeführt", async () => {
    const ctx = await start({ replies: { general: "Text [INVOKE:critic|x]" } });
    const sse = await listen(ctx, "dm");
    await api(ctx, "/api/conversations/dm/messages", { text: "hallo" });
    await sse.settled();
    await sse.close();
    expect(ctx.calls.map(c => c.agent)).toEqual(["general"]);
  });

  test("/stop während der Rückfrage: nichts gespeichert, nichts von Critic gesendet", async () => {
    const ctx = await start({ budget: 3, holdInvocations: true, replies: { general: "[INVOKE:critic|Risiko?]" } });
    const sse = await listen(ctx, "dm");
    await api(ctx, "/api/conversations/dm/messages", { text: "los" });
    await waitUntil(() => ctx.release.length === 1);
    expect((await api(ctx, "/api/conversations/dm/messages", { text: "/stop" })).status).toBe(202);
    await sse.settled();
    await sse.close();
    expect(ctx.saved.some(m => (m.metadata as any).agent === "critic")).toBe(false);
    expect(ctx.telegram.some(t => t.startsWith("send critic"))).toBe(false);
  });

  test("Stopp-Knopf (POST /stop) während der Rückfrage: abgebrochen, keine weitere, Hauptantwort bleibt", async () => {
    const ctx = await start({ budget: 3, holdInvocations: true, replies: { general: "Hauptantwort [INVOKE:critic|a] [INVOKE:research|b]" } });
    const sse = await listen(ctx, "dm");
    await api(ctx, "/api/conversations/dm/messages", { text: "los" });
    await waitUntil(() => ctx.release.length === 1);
    // Die Hauptantwort ist schon gespeichert und gesendet
    expect(ctx.saved.some(m => m.role === "assistant" && m.content.startsWith("Hauptantwort"))).toBe(true);
    const res = await api(ctx, "/api/conversations/dm/stop", {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ stopping: true });
    await sse.settled();
    await sse.close();
    // Laufende Rückfrage abgebrochen, die zweite nie gestartet
    expect(ctx.calls.map(c => c.agent)).toEqual(["general", "critic"]);
    expect(ctx.saved.some(m => ["critic", "research"].includes((m.metadata as any).agent))).toBe(false);
    expect(ctx.telegram.some(t => t.startsWith("send critic") || t.startsWith("send research") || t.startsWith("typing research"))).toBe(false);
    // Live: Hauptantwort, dann die Abbruchmeldung
    expect(sse.messages().map((m: any) => [m.role, m.agent ?? null])).toEqual([
      ["user", null],
      ["assistant", "general"],
    ]);
    expect(sse.events.filter(e => e.event === "error").map(e => e.data.text)).toEqual(["Abgebrochen."]);
    // Nach dem Neuladen steht die Hauptantwort noch im Verlauf
    const history = await (await api(ctx, "/api/conversations/dm/messages")).json();
    expect(history.messages.some((m: any) => m.role === "assistant" && m.agent === "general" && String(m.text).startsWith("Hauptantwort"))).toBe(true);
    // Danach ist nichts mehr abzubrechen
    expect(await (await api(ctx, "/api/conversations/dm/stop", {})).json()).toEqual({ stopping: false });
  });

  test("nach jeder Antwort im Browser prüft das Gespräch sein /goal (onAgentTurnForGoal)", async () => {
    const ctx = await start({ replies: { research: "Ergebnis" } });
    const sse = await listen(ctx, "topic-12");
    await api(ctx, "/api/conversations/topic-12/messages", { text: "weiter" });
    await sse.settled();
    await sse.close();
    expect(ctx.goalChecks).toEqual([`topic:${GROUP}:12 research`]);
  });
});

describe("Telegram-Weg (src/bot.ts) über dieselbe Ausführung", () => {
  test("executeVisibleInvocation: Antwort vom Agenten-Bot, danach onDelivered (Speichern für die WebUI)", async () => {
    const order: string[] = [];
    const registry = {
      sendTypingAsAgent: async (agent: string) => void order.push(`typing ${agent}`),
      sendAsAgent: async (agent: string, _chat: unknown, text: string) => void order.push(`send ${agent} ${text}`),
    } as unknown as BotRegistry;
    const result = await executeVisibleInvocation(registry, "general", { targetAgent: "critic", question: "Risiko?" }, "-100", 7, async () => "Hoch [INVOKE:research|x]", async (agent, text) => {
      order.push(`gespeichert ${agent} ${text}`);
    });
    expect(result).toBe("Hoch");
    expect(order).toEqual(["typing critic", "send critic Hoch", "gespeichert critic Hoch"]);
  });

  test("capInvocations kürzt auf das Budget", () => {
    const list = ["a", "b", "c", "d"].map(q => ({ targetAgent: "critic", question: q }));
    expect(capInvocations(list, 3).map(i => i.question)).toEqual(["a", "b", "c"]);
    expect(capInvocations(list.slice(0, 2), 3)).toHaveLength(2);
  });
});
