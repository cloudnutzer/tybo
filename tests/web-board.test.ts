/**
 * /board aus Browser und Terminal (Issue #75): echter Web-Server, echter
 * Befehls-Port (createBotCommands) mit dem echten Register und dem echten
 * Board-Kern, echter Telegram-Turn, echte Telegram-Quelle und echter
 * Nachrichten-Feed. Nur Claude, Telegram, der Nachrichtenspeicher und die
 * Board-Daten sind Attrappen; src/bot.ts wird nie geladen.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boardAgentNames, createAgent, setBoard } from "../src/agents/catalog";
import { BOARD_TEXT, createTelegramBoardOutput, isBoardRunning, requestBoardStop, runBoardMeeting } from "../src/lib/board-meeting";
import { ABORT_REPLY, type TurnInfo } from "../src/lib/chat-turn";
import { commandRegistry } from "../src/lib/commands/builtin";
import type { CommandServices } from "../src/lib/commands/types";
import type { MessageSavedListener } from "../src/lib/convex";
import { stripInvocationTags } from "../src/lib/cross-agent";
import { abortAllExecutions, abortExecutions, currentExecution } from "../src/lib/execution-context";
import type { SendAndRecordInput } from "../src/lib/outbox";
import type { HistoryRow } from "../src/lib/supabase";
import { ABORTED_TEXT, type RunTurnOptions, type TurnResult, type WebChat } from "../src/web/chat";
import { createBotCommands } from "../src/web/bot-commands";
import { createTelegramLiveFeed, createTelegramSource } from "../src/web/bot-telegram";
import { createApprovalTurns, createTelegramChat, type ApprovalTurns, type WebSavedMessage } from "../src/web/bot-turn";
import { getChoice, setChoicesFileForTests } from "../src/lib/choices";
import { createChoiceToolApproval, type ChoiceToolApproval } from "../src/lib/tool-approval";
import { authorizeTool, setToolApprovalHandler, type BuiltinTool } from "../src/lib/tools/registry";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { ApiClient } from "../src/terminal/api";
import { runChatApp } from "../src/terminal/app";
import { isolateAgentCatalog } from "./catalog-fixture";
import { FakeStdin, FakeStdout } from "./terminal-fixture";

isolateAgentCatalog();

const PASSWORD = "test-passwort-lang";
const GROUP = "-1001234567890";
const USER = "4711";
const TOPIC_KEY = `topic:${GROUP}:443`;
const root = await mkdtemp(join(tmpdir(), "tybo-web-board-"));
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

/** Offener Beitrag, den der Test beendet */
interface Pending {
  agent: string;
  finish(text?: string): void;
}

interface Ctx {
  server: WebServer;
  origin: string;
  cookie: string;
  bearer: string;
  saved: WebSavedMessage[];
  rows: HistoryRow[];
  /** Telegram in Reihenfolge: Spiegelung, Agenten-Bots, Tippt-Anzeige */
  telegram: string[];
  records: SendAndRecordInput[];
  prompts: { agent: string; chatId: string; topicId?: number }[];
  agents: () => string[];
  /** true: jeder Beitrag wartet, bis der Test ihn beendet (pending) */
  manual: boolean;
  pending: Pending[];
  store: ConversationStore;
  webId: string;
  saveMessage(m: WebSavedMessage): Promise<boolean>;
  /** Laufende Turns für Werkzeug-Freigaben (Issue #116), geteilt wie in src/bot.ts */
  approvals: ApprovalTurns;
  /** Vor jedem Beitrag: liefert einen Text, ersetzt er den Beitrag (Werkzeug-Freigabe im Beitrag) */
  beforeTurn?: (agent: string) => Promise<string | undefined>;
}

async function start(): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  const ctx = { saved: [], rows: [], telegram: [], records: [], prompts: [], pending: [], manual: false, approvals: createApprovalTurns() } as unknown as Ctx;
  ctx.agents = () => ["research", "finance", "critic"];
  let rowCounter = 0;
  let savedHook: MessageSavedListener | null = null;
  const emitSaved = (row: HistoryRow) =>
    savedHook?.({ chatId: (row as any).chat_id, role: row.role as "user" | "assistant", content: row.content, metadata: row.metadata as Record<string, unknown>, createdAt: row.created_at });
  function storeRow(chatId: string, role: "user" | "assistant", content: string, metadata: Record<string, unknown>, createdAt?: string): HistoryRow {
    const row = { id: `row-${++rowCounter}`, created_at: createdAt ?? new Date(Date.now() + rowCounter).toISOString(), role, content, metadata, chat_id: chatId } as unknown as HistoryRow;
    ctx.rows.push(row);
    return row;
  }
  // Wie saveMessage in src/lib/convex.ts: msgId vergeben, falls keine da ist, dann an den Feed
  ctx.saveMessage = async (m: WebSavedMessage) => {
    const metadata = { ...(m.metadata ?? {}) };
    if (!metadata.msgId) metadata.msgId = crypto.randomUUID();
    ctx.saved.push({ ...m, metadata });
    await emitSaved(storeRow(m.chat_id, m.role, m.content, metadata, m.created_at));
    return true;
  };
  const turnDeps = {
    runStreamingTurn: async (opts: { userMessage: string; agentName: string; chatId: string; topicId?: number; onInfo?: (i: TurnInfo) => void }) => {
      const agent = opts.agentName;
      ctx.prompts.push({ agent, chatId: opts.chatId, topicId: opts.topicId });
      opts.onInfo?.({ agent, model: "claude-test", durationMs: 4200 });
      const signal = currentExecution()?.controller.signal;
      const replaced = await ctx.beforeTurn?.(agent);
      if (replaced !== undefined) return replaced;
      if (!ctx.manual) return `Beitrag ${agent}`;
      return new Promise<string>(resolve => {
        signal?.addEventListener("abort", () => resolve(ABORT_REPLY), { once: true });
        ctx.pending.push({ agent, finish: text => resolve(text ?? `Beitrag ${agent}`) });
      });
    },
    saveMessage: (m: WebSavedMessage) => ctx.saveMessage(m),
    processIntents: async () => {},
    abortEngineCalls: (key: string) => abortExecutions(key),
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
  };
  const telegramDeps = {
    userId: USER,
    groupId: () => GROUP,
    agentForTopic: (topicId: number) => (topicId === 443 ? "finance" : undefined),
    sendPlain: async (chatId: string, text: string, threadId?: number) => void ctx.telegram.push(`plain ${chatId} ${threadId} ${text}`),
    sendAsAgent: async (agent: string, chatId: string, text: string, threadId?: number) => void ctx.telegram.push(`send ${agent} ${chatId} ${threadId} ${text}`),
  };
  const services = {
    isSessionModeEnabled: () => true,
    getGoal: async () => undefined,
    pauseGoal: async () => {},
    abortEngineCalls: (key: string) => abortExecutions(key),
    requestBoardStop,
    listAgentNames: () => ["general", "research", "finance", "critic"],
  } as unknown as CommandServices;
  const commands = createBotCommands({
    ...turnDeps,
    ...telegramDeps,
    sendTypingAsAgent: async (agent, chatId, threadId) => void ctx.telegram.push(`typing ${agent} ${chatId} ${threadId}`),
    board: {
      agents: () => ctx.agents(),
      gatherData: async () => ({ agentData: {}, sharedSummary: "", fetchDurationMs: 0, errors: [] }),
      stripInvocationTags,
      pauseMs: 0,
    },
    registry: commandRegistry,
    services,
    approvals: ctx.approvals,
    sendAndRecord: async input => {
      ctx.records.push(input);
      const topicId = input.topicId;
      const metadata: Record<string, unknown> = { display_only: true, source: input.source, msgId: crypto.randomUUID() };
      if (topicId !== undefined && topicId !== 1) metadata.topicId = topicId;
      await emitSaved(storeRow(topicId === undefined ? USER : GROUP, "assistant", input.text!, metadata));
      return { sent: true, recorded: true };
    },
    resetConversation: async () => ({ status: "unavailable" }),
  });
  const telegram = createTelegramSource({
    userId: USER,
    groupId: () => GROUP,
    topicNames: async () => ({ "443": "Finanzen" }),
    topicMapping: () => ({ "443": "finance" }),
    history: async (chatId, topicId) => ctx.rows.filter(r => (r as any).chat_id === chatId && ((r.metadata as any)?.topicId ?? null) === topicId),
    activity: async () => [],
    log: () => {},
  });
  ctx.store = new ConversationStore({ dir: join(dir, "web") });
  await ctx.store.load();
  ctx.webId = (await ctx.store.createConversation("research")).id;
  const unusedChat: WebChat = {
    runTurn: async (_opts: RunTurnOptions): Promise<TurnResult> => ({ text: "nie" }),
    stop: () => {},
  };
  const tokenFile = join(dir, "cli-token");
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "web-sessions.json"),
      conversationStore: ctx.store,
      cliTokenFile: tokenFile,
      chat: unusedChat,
      telegram,
      telegramChat: createTelegramChat({ ...turnDeps, ...telegramDeps, approvals: ctx.approvals }),
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
  ctx.server = server;
  ctx.origin = server.url;
  const res = await fetch(`${ctx.origin}/api/login`, { method: "POST", headers: { origin: ctx.origin }, body: JSON.stringify({ password: PASSWORD }) });
  ctx.cookie = res.headers.get("set-cookie")!.split(";")[0];
  ctx.bearer = (await readFile(tokenFile, "utf8")).trim();
  return ctx;
}

function api(ctx: Ctx, path: string, init: { method?: string; body?: unknown; terminal?: boolean } = {}) {
  const auth = init.terminal ? { authorization: `Bearer ${ctx.bearer}` } : { origin: ctx.origin, cookie: ctx.cookie };
  return fetch(`${ctx.origin}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...auth },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const post = (ctx: Ctx, id: string, text: string, terminal = false) => api(ctx, `/api/conversations/${id}/messages`, { method: "POST", body: { text }, terminal });
const stop = (ctx: Ctx, id: string, terminal = false) => api(ctx, `/api/conversations/${id}/stop`, { method: "POST", terminal });

async function listen(ctx: Ctx, id: string) {
  const controller = new AbortController();
  const res = await fetch(`${ctx.origin}/api/conversations/${id}/events`, { headers: { cookie: ctx.cookie, origin: ctx.origin }, signal: controller.signal });
  expect(res.status).toBe(200);
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

describe("/board X aus dem Browser im Topic", () => {
  test("je Board-Agent eine Nachricht mit Sprecher, am Ende die Zusammenfassung; Telegram bekommt dieselben Beiträge", async () => {
    const ctx = await start();
    const sse = await listen(ctx, "topic-443");
    const res = await post(ctx, "topic-443", "/board Newsletter starten?");
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.command).toBe("board");
    await sse.settled();
    await sse.close();

    // Live: Nutzernachricht, dann je Agent ein Beitrag mit Sprecher, Modell und Dauer, dann General
    const live = sse.messages();
    expect(live.map((m: any) => [m.role, m.agent ?? null, m.text])).toEqual([
      ["user", null, "/board Newsletter starten?"],
      ["assistant", "research", "Beitrag research"],
      ["assistant", "finance", "Beitrag finance"],
      ["assistant", "critic", "Beitrag critic"],
      ["assistant", "general", "Beitrag general"],
    ]);
    for (const m of live.slice(1)) expect(m).toMatchObject({ model: "claude-test", durationMs: 4200 });
    expect(live.some((m: any) => m.kind === "notice")).toBe(false);
    expect(sse.events.some(e => e.event === "error")).toBe(false);

    // Fortschritt nennt den Agenten, jeweils vor seinem Beitrag
    const flow = sse.events
      .filter(e => e.event === "notice" || (e.event === "message" && e.data.role === "assistant"))
      .map(e => (e.event === "notice" ? e.data.text : `Beitrag von ${e.data.agent}`));
    expect(flow).toEqual([
      BOARD_TEXT.starting,
      "Research denkt nach …",
      "Beitrag von research",
      "Finance denkt nach …",
      "Beitrag von finance",
      "Critic denkt nach …",
      "Beitrag von critic",
      "General denkt nach …",
      "Beitrag von general",
    ]);

    // Telegram: Spiegelung, Ankündigung von General, je Agent Tippt-Anzeige und Beitrag vom eigenen Bot
    expect(ctx.telegram).toEqual([
      `plain ${GROUP} 443 Du (Web): /board Newsletter starten?`,
      `send general ${GROUP} 443 *Board Meeting Starting*\n\nGathering perspectives from all agents...\n\nAdditional context: Newsletter starten?`,
      `typing research ${GROUP} 443`,
      `send research ${GROUP} 443 Beitrag research`,
      `typing finance ${GROUP} 443`,
      `send finance ${GROUP} 443 Beitrag finance`,
      `typing critic ${GROUP} 443`,
      `send critic ${GROUP} 443 Beitrag critic`,
      `typing general ${GROUP} 443`,
      `send general ${GROUP} 443 Beitrag general`,
    ]);
    expect(ctx.prompts.map(p => [p.agent, p.chatId, p.topicId])).toEqual([
      ["research", GROUP, 443],
      ["finance", GROUP, 443],
      ["critic", GROUP, 443],
      ["general", GROUP, 443],
    ]);
    // Keine Befehlsmeldungen (display_only) für Beiträge
    expect(ctx.records).toEqual([]);

    // Gespeichert: Nutzernachricht, dann jeder Beitrag einzeln mit channel web und der Live-ID
    expect(ctx.saved.map(m => [m.role, (m.metadata as any).agent ?? null, (m.metadata as any).board ?? null])).toEqual([
      ["user", null, null],
      ["assistant", "research", "agent"],
      ["assistant", "finance", "agent"],
      ["assistant", "critic", "agent"],
      ["assistant", "general", "synthesis"],
    ]);
    for (const [i, m] of ctx.saved.slice(1).entries()) {
      expect(m.metadata).toMatchObject({ channel: "web", type: "board_meeting", topicId: 443, durationMs: 4200, model: "claude-test", msgId: live[i + 1].id });
    }

    // Nach dem Neuladen: dieselben Einträge mit denselben IDs, jeweils einmal, ohne Sammeltext
    const history = await (await api(ctx, "/api/conversations/topic-443/messages")).json();
    expect(history.messages.map((m: any) => [m.id, m.agent ?? null, m.text])).toEqual(live.map((m: any) => [m.id, m.agent ?? null, m.text]));
    expect(history.messages.some((m: any) => m.text.includes("[Board Meeting]"))).toBe(false);
  });

  test("der erste Beitrag erscheint, bevor der nächste fertig ist", async () => {
    const ctx = await start();
    ctx.manual = true;
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "/board");
    await waitUntil(() => ctx.pending.length === 1);
    ctx.pending[0].finish();
    await waitUntil(() => ctx.pending.length === 2);
    // Finance arbeitet noch, der Research-Beitrag ist schon da
    await waitUntil(() => sse.messages().some((m: any) => m.agent === "research"));
    expect(sse.messages().some((m: any) => m.agent === "finance")).toBe(false);
    expect(ctx.telegram).toContain(`send research ${GROUP} 443 Beitrag research`);
    expect(sse.events.filter(e => e.event === "notice").at(-1)!.data.text).toBe("Finance denkt nach …");
    for (let i = 1; i < 4; i++) {
      await waitUntil(() => ctx.pending.length === i + 1);
      ctx.pending[i].finish();
    }
    await sse.settled();
    await sse.close();
  });

  test("Teilnehmer und Reihenfolge aus dem Katalog", async () => {
    const ctx = await start();
    await createAgent({ name: "projekt-planer", description: "Plant Projekte", systemPrompt: "Du planst.", board: true });
    await setBoard("strategy", false);
    ctx.agents = boardAgentNames;
    const sse = await listen(ctx, "dm");
    await post(ctx, "dm", "/board");
    await sse.settled();
    await sse.close();
    expect(sse.messages().slice(1).map((m: any) => m.agent)).toEqual(["research", "content", "finance", "cto", "coo", "projekt-planer", "critic", "general"]);
    // Direktchat: Telegram-Ziel ist der Direktchat ohne Topic
    expect(ctx.telegram[1]).toStartWith(`send general ${USER} undefined *Board Meeting Starting*`);
    expect(ctx.saved.at(-1)!.metadata).toMatchObject({ topicId: null, channel: "web" });
  });

  test("leeres Board: Hinweis als Meldung, kein Modellaufruf", async () => {
    const ctx = await start();
    ctx.agents = () => [];
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "/board");
    await sse.settled();
    await sse.close();
    expect(ctx.prompts).toEqual([]);
    expect(ctx.records.map(r => r.text)).toEqual([BOARD_TEXT.empty]);
    expect(sse.events.some(e => e.event === "error")).toBe(false);
  });

  test("Agentenfehler: Hinweis im Fortschritt, die übrigen laufen weiter", async () => {
    const ctx = await start();
    ctx.manual = true;
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "/board");
    await waitUntil(() => ctx.pending.length === 1);
    ctx.pending[0].finish("   ");
    for (let i = 1; i < 4; i++) {
      await waitUntil(() => ctx.pending.length === i + 1);
      ctx.pending[i].finish();
    }
    await sse.settled();
    await sse.close();
    expect(sse.events.some(e => e.event === "notice" && e.data.text === "Research hat keinen Beitrag geliefert.")).toBe(true);
    expect(sse.messages().slice(1).map((m: any) => m.agent)).toEqual(["finance", "critic", "general"]);
  });
});

describe("Stopp beendet die Sitzung nach dem laufenden Beitrag", () => {
  async function stoppedDuringFinance(how: (ctx: Ctx) => Promise<void>) {
    const ctx = await start();
    ctx.manual = true;
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "/board Preis");
    await waitUntil(() => ctx.pending.length === 1);
    ctx.pending[0].finish();
    await waitUntil(() => ctx.pending.length === 2);
    await how(ctx);
    // Der laufende Beitrag (Finance) wird fertig
    ctx.pending[1].finish();
    await sse.settled();
    await sse.close();
    return { ctx, sse };
  }

  function expectStoppedAfterFinance({ ctx, sse }: { ctx: Ctx; sse: Awaited<ReturnType<typeof listen>> }) {
    expect(ctx.prompts.map(p => p.agent)).toEqual(["research", "finance"]);
    const replies = sse.messages().filter((m: any) => m.role === "assistant" && m.kind !== "notice");
    expect(replies.map((m: any) => m.agent)).toEqual(["research", "finance"]);
    expect(ctx.telegram.filter(t => t.startsWith("send finance"))).toEqual([`send finance ${GROUP} 443 Beitrag finance`]);
    expect(ctx.telegram.some(t => t.startsWith("send critic") || t.startsWith("typing critic"))).toBe(false);
    expect(ctx.saved.filter(m => m.role === "assistant").map(m => (m.metadata as any).agent)).toEqual(["research", "finance"]);
    // Ende als Meldung (Telegram und Verlauf), kein „Abgebrochen."
    expect(ctx.records.map(r => r.text).at(-1)).toBe(BOARD_TEXT.stopped(2));
    expect(sse.events.some(e => e.event === "error")).toBe(false);
    expect(isBoardRunning(TOPIC_KEY)).toBe(false);
  }

  test("Stopp-Knopf im Browser", async () => {
    const run = await stoppedDuringFinance(async ctx => {
      expect((await (await stop(ctx, "topic-443")).json()).stopping).toBe(true);
    });
    expectStoppedAfterFinance(run);
    // Nach dem Neuladen bleiben die fertigen Beiträge erhalten
    const history = await (await api(run.ctx, "/api/conversations/topic-443/messages")).json();
    expect(history.messages.filter((m: any) => m.role === "assistant" && m.kind !== "notice").map((m: any) => m.agent)).toEqual(["research", "finance"]);
  });

  test("Strg+C im Terminal (Stopp mit lokalem Schlüssel)", async () => {
    expectStoppedAfterFinance(
      await stoppedDuringFinance(async ctx => {
        expect((await (await stop(ctx, "topic-443", true)).json()).stopping).toBe(true);
      })
    );
  });

  test("/stop aus dem Terminal: Hinweis, kein harter Abbruch", async () => {
    const run = await stoppedDuringFinance(async ctx => {
      const res = await post(ctx, "topic-443", "/stop", true);
      expect((await res.json()).command).toBe("stop");
    });
    expectStoppedAfterFinance(run);
    expect(run.ctx.records.map(r => r.text)).toEqual([BOARD_TEXT.stopRequested, BOARD_TEXT.stopped(2)]);
  });

  test("zweites /stop bricht hart ab: der laufende Beitrag entfällt, „Abgebrochen.“", async () => {
    const ctx = await start();
    ctx.manual = true;
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "/board");
    await waitUntil(() => ctx.pending.length === 1);
    ctx.pending[0].finish();
    await waitUntil(() => ctx.pending.length === 2);
    await post(ctx, "topic-443", "/stop");
    await post(ctx, "topic-443", "/stop");
    await sse.settled();
    await sse.close();
    expect(sse.events.find(e => e.event === "error")?.data.text).toBe(ABORTED_TEXT);
    expect(ctx.saved.filter(m => m.role === "assistant").map(m => (m.metadata as any).agent)).toEqual(["research"]);
    expect(ctx.telegram.some(t => t.startsWith("send finance"))).toBe(false);
    expect(sse.messages().some((m: any) => m.text === ABORT_REPLY)).toBe(false);
  });
});

describe("Ältere Web-Gespräche und Telegram-Sitzungen", () => {
  test("älteres Web-Gespräch: Beiträge mit Sprecher im eigenen Verlauf, nichts nach Telegram", async () => {
    const ctx = await start();
    const sse = await listen(ctx, ctx.webId);
    await post(ctx, ctx.webId, "/board");
    await sse.settled();
    await sse.close();
    expect(ctx.telegram).toEqual([]);
    const history = await (await api(ctx, `/api/conversations/${ctx.webId}/messages`)).json();
    expect(history.messages.map((m: any) => [m.role, m.agent ?? null])).toEqual([
      ["user", null],
      ["assistant", "research"],
      ["assistant", "finance"],
      ["assistant", "critic"],
      ["assistant", "general"],
    ]);
    expect(ctx.saved.at(-1)).toMatchObject({ chat_id: `web:${ctx.webId}`, metadata: { agent: "general", board: "synthesis" } });
  });

  test("Sitzung aus Telegram: Beiträge erscheinen im offenen Browser live mit Sprecher und nach dem Neuladen", async () => {
    const ctx = await start();
    const sse = await listen(ctx, "topic-443");
    const sent: string[] = [];
    // Wie runBoardMeeting in src/bot.ts: Telegram-Ausgabe, Speichern im Nachrichtenspeicher
    await runBoardMeeting(
      {
        agents: () => ["research", "critic"],
        gatherData: async () => ({ agentData: {}, sharedSummary: "", fetchDurationMs: 0, errors: [] }),
        callAgent: async (_prompt, agent) => ({ text: `Beitrag ${agent}`, durationMs: 900 }),
        stripInvocationTags,
        save: m => ctx.saveMessage({ chat_id: GROUP, ...m }),
        newMessageId: () => crypto.randomUUID(),
        pauseMs: 0,
        log: () => {},
      },
      { sessionKey: TOPIC_KEY, topicId: 443 },
      createTelegramBoardOutput(
        { sendAsAgent: async (agent, _c, text) => void sent.push(`${agent}: ${text}`), sendTypingAsAgent: async () => {}, notice: async () => {} },
        GROUP,
        443
      )
    );
    await waitUntil(() => sse.messages().length === 3);
    await sse.close();
    expect(sent).toEqual([
      "general: *Board Meeting Starting*\n\nGathering perspectives from all agents...",
      "research: Beitrag research",
      "critic: Beitrag critic",
      "general: Beitrag general",
    ]);
    expect(sse.messages().map((m: any) => [m.agent, m.text, m.durationMs])).toEqual([
      ["research", "Beitrag research", 900],
      ["critic", "Beitrag critic", 900],
      ["general", "Beitrag general", 900],
    ]);
    const history = await (await api(ctx, "/api/conversations/topic-443/messages")).json();
    expect(history.messages.map((m: any) => m.id)).toEqual(sse.messages().map((m: any) => m.id));
  });
});

describe("/board im Telegram-Gespräch: Werkzeug-Freigabe über die gemeinsamen Turns (PR #147)", () => {
  const tool: BuiltinTool = {
    name: "notiz_schreiben",
    description: "Schreibt eine Notiz",
    inputSchema: { type: "object", properties: {} },
    requiresApproval: true,
    isAvailable: () => true,
    handler: async () => "",
  };
  let approval: ChoiceToolApproval | undefined;
  afterEach(() => {
    approval?.dispose();
    approval = undefined;
    setToolApprovalHandler(null);
    setChoicesFileForTests(null);
  });

  const cases = [
    { id: "dm", key: `dm:${USER}`, conversation: { type: "telegram", chatId: USER } },
    { id: "topic-443", key: TOPIC_KEY, conversation: { type: "telegram", chatId: GROUP, topicId: 443 } },
  ] as const;

  for (const c of cases) {
    for (const [via, text, key, result] of [
      ["web", "ja", "allow", "Werkzeug erlaubt"],
      ["terminal", "nein", "deny", "Werkzeug abgelehnt"],
    ] as const) {
      test(`${c.id}, ${via}: Beitrag wartet mit Register-ID, „${text}“ entscheidet, Status danach zurückgesetzt`, async () => {
        setChoicesFileForTests(join(root, `board-choices-${Date.now()}-${Math.random()}.json`));
        const ctx = await start();
        const sent: string[] = [];
        approval = createChoiceToolApproval({
          sendChoice: async choice => (sent.push(choice.id), { sent: true }),
          presenter: k => ctx.approvals.presenter(k),
          log: () => {},
        });
        setToolApprovalHandler(approval.handler);
        const keys: (string | undefined)[] = [];
        ctx.beforeTurn = async agent => {
          if (agent !== "finance") return undefined;
          keys.push(currentExecution()?.key);
          return (await authorizeTool(tool, { text: "x" })) ? "Werkzeug abgelehnt" : "Werkzeug erlaubt";
        };
        const sse = await listen(ctx, c.id);
        expect((await post(ctx, c.id, "/board Budget?")).status).toBe(202);
        await waitUntil(() => sse.events.some(e => e.event === "status" && e.data.awaiting === true));
        const approvalId = sse.events.find(e => e.event === "status" && e.data.awaiting)!.data.approvalId as string;
        expect(keys).toEqual([c.key]);
        expect(sent).toEqual([approvalId]);
        expect(await getChoice(approvalId)).toMatchObject({ kind: "tool", state: "open", conversation: c.conversation });

        const res = await api(ctx, `/api/conversations/${c.id}/messages`, { method: "POST", body: { text, approvalId }, terminal: via === "terminal" });
        expect(res.status).toBe(202);
        expect((await getChoice(approvalId))!.result).toMatchObject({ key, via });
        await sse.settled();
        await sse.close();
        const at = sse.events.findIndex(e => e.event === "status" && e.data.awaiting === true);
        expect(sse.events.slice(at + 1).some(e => e.event === "status" && e.data.running === true && !e.data.awaiting)).toBe(true);
        expect(sse.events.slice(at + 1).some(e => e.event === "status" && e.data.awaiting)).toBe(false);
        // Die Sitzung läuft danach weiter: Beitrag von Finance mit dem Ergebnis, dann die übrigen
        expect(sse.messages().filter((m: any) => m.role === "assistant").map((m: any) => [m.agent, m.text])).toEqual([
          ["research", "Beitrag research"],
          ["finance", result],
          ["critic", "Beitrag critic"],
          ["general", "Beitrag general"],
        ]);
      });
    }
  }
});

describe("Terminal (tybo)", () => {
  /**
   * slowMs: langsame Leitung wie in der CI. Nach dem Senden kommen die
   * POST-Antwort und die Live-Ereignisse erst nach slowMs beim Terminal an,
   * der Server rechnet aber schon (ctx.pending)
   */
  async function openTybo(ctx: Ctx, stops: string[] = [], slowMs = 0) {
    let holdUntil = 0;
    const hold = async () => {
      const wait = holdUntil - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    };
    // Stopp-Anfragen mitschreiben, sobald der Server sie beantwortet hat
    const recording = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      if (slowMs && init?.method === "POST" && url.endsWith("/messages")) holdUntil = Date.now() + slowMs;
      const res = await fetch(input, init);
      if (url.endsWith("/stop")) stops.push(url);
      if (!slowMs) return res;
      await hold();
      if (!res.body || !(res.headers.get("content-type") ?? "").includes("text/event-stream")) return res;
      const delayed = res.body.pipeThrough(
        new TransformStream<Uint8Array, Uint8Array>({
          async transform(chunk, controller) {
            await hold();
            controller.enqueue(chunk);
          },
        })
      );
      return new Response(delayed, { status: res.status, headers: res.headers });
    }) as typeof fetch;
    const client = new ApiClient({ base: ctx.origin.replace(/\/$/, ""), getToken: async () => ctx.bearer, fetch: recording });
    const conversation = (await client.listConversations()).find(c => c.id === "topic-443")!;
    const stdin = new FakeStdin();
    const stdout = new FakeStdout();
    const exit = runChatApp({
      client,
      conversation,
      stdin,
      stdout,
      env: {},
      onSignal: () => () => {},
      live: { retryMinMs: 100, retryMaxMs: 200 },
      tickMs: 50,
      onSwitch: () => {},
    });
    await waitUntil(() => ctx.server.eventStreamCount() >= 1);
    return { stdin, stdout, exit };
  }

  test("/board zeigt jeden Beitrag mit Sprecher-Zeile (Agent, Modell, Dauer), Fortschritt nennt den Agenten", async () => {
    const ctx = await start();
    const { stdin, stdout, exit } = await openTybo(ctx);
    stdin.type("/board Preis\r");
    await waitUntil(() => stdout.text.includes("Beitrag general"));
    stdin.type("\u0004");
    await exit;
    const text = stdout.text;
    expect(ctx.telegram[0]).toBe(`plain ${GROUP} 443 Du (Terminal): /board Preis`);
    for (const agent of ["Research", "Finance", "Critic", "General"]) {
      expect(text).toMatch(new RegExp(`${agent} · \\d\\d:\\d\\d · claude-test · 4,2 s\\n+Beitrag ${agent.toLowerCase()}`));
      expect(text).toContain(`${agent} denkt nach …`);
    }
    // Reihenfolge: Research vor Finance vor Critic vor General
    const at = (s: string) => text.indexOf(`Beitrag ${s}`);
    expect(at("research") < at("finance") && at("finance") < at("critic") && at("critic") < at("general")).toBe(true);
    expect(ctx.saved[0]).toMatchObject({ role: "user", content: "/board Preis", metadata: { via: "terminal" } });
    expect(ctx.saved[1].metadata).toMatchObject({ via: "terminal", channel: "web", agent: "research" });
  });

  test("Strg+C während eines Beitrags: der Beitrag kommt noch, danach Schluss", async () => {
    const ctx = await start();
    ctx.manual = true;
    const stops: string[] = [];
    // Langsame Leitung (CI-Befund in PR #200): der Server rechnet schon, das
    // Terminal weiß es noch nicht. Strg+C erst, wenn es den Lauf anzeigt,
    // sonst zählt es als erster Druck zum Beenden
    const { stdin, stdout, exit } = await openTybo(ctx, stops, 300);
    stdin.type("/board\r");
    await waitUntil(() => ctx.pending.length === 1);
    await waitUntil(() => stdout.text.includes("Denkt nach …"));
    stdin.type("\u0003");
    await waitUntil(() => stops.length === 1);
    expect(stops[0]).toEndWith("/api/conversations/topic-443/stop");
    ctx.pending[0].finish();
    await waitUntil(() => stdout.text.includes(BOARD_TEXT.stopped(1)));
    stdin.type("\u0004");
    await exit;
    expect(stdout.text).toContain("Beitrag research");
    expect(ctx.prompts.map(p => p.agent)).toEqual(["research"]);
  });
});
