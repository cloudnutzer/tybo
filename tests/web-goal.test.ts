/**
 * /goal im Browser und im Terminal (Issue #76): echter Web-Server, echter
 * Befehls-Port mit dem echten Register, echte Goal-Engine (Zustand in einer
 * Test-Kopie im Temp-Verzeichnis), echte gemeinsame Aktionen, echter
 * Ziel-Port (createBotGoals), echter Telegram-Turn und echter
 * Nachrichten-Feed. Nur Claude, Telegram, der Nachrichtenspeicher und der
 * Judge sind Attrappen; src/bot.ts wird nie geladen.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commandRegistry } from "../src/lib/commands/builtin";
import type { CommandServices } from "../src/lib/commands/types";
import type { MessageSavedListener } from "../src/lib/convex";
import { ABORT_REPLY } from "../src/lib/chat-turn";
import { abortAllExecutions, abortExecutions, currentExecution } from "../src/lib/execution-context";
import { createTelegramGoalStatus, GOAL_NOTICE_SOURCE, handleGoalCallback, runGoalAction } from "../src/lib/goal-actions";
import {
  clearGoal,
  configureGoalStore,
  formatGoalStatus,
  getGoal,
  initGoalEngine,
  isGoalLoopRunning,
  onGoalChange,
  setGoal,
  startGoalWork,
  updateGoal,
} from "../src/lib/goal-engine";
import type { SendAndRecordInput } from "../src/lib/outbox";
import type { HistoryRow } from "../src/lib/supabase";
import { type RunTurnOptions, type TurnResult, type WebChat } from "../src/web/chat";
import { createBotCommands } from "../src/web/bot-commands";
import { createBotGoals } from "../src/web/bot-goals";
import { createTelegramLiveFeed, createTelegramSource } from "../src/web/bot-telegram";
import { createTelegramChat, type WebSavedMessage } from "../src/web/bot-turn";
import { GOAL_CARD_TEXT } from "../src/web/goals";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { isolateAgentCatalog } from "./catalog-fixture";
import { Composer, Context } from "grammy";
import { decideChoice, getChoice, listChoices, onChoiceDecided, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { createGoalChoices, GOAL_NO_BUTTONS_HINT, type GoalChoices } from "../src/lib/goal-choices";
import { createTelegramChoices, installTelegramChoices } from "../src/lib/telegram-choices";
import { testChoices } from "./choices-fixture";

isolateAgentCatalog();

const PASSWORD = "test-passwort-lang";
const GROUP = "-1001234567890";
const USER = "4711";
const TOPIC = 443;
const KEY = `topic:${GROUP}:${TOPIC}`;
const root = await mkdtemp(join(tmpdir(), "tybo-web-goal-"));
const goalsFile = join(root, "goals.json");
let counter = 0;
const env = { judge: process.env.AUX_MODEL_JUDGE, key: process.env.OPENROUTER_API_KEY };
const realFetch = globalThis.fetch;
let verdict = "continue";

beforeAll(() => {
  configureGoalStore({ file: goalsFile });
  // Judge per OpenRouter-Attrappe; alles andere geht an den echten Test-Server
  process.env.AUX_MODEL_JUDGE = "openrouter:test/judge";
  process.env.OPENROUTER_API_KEY = "test";
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).includes("openrouter.ai")) {
      return Response.json({ choices: [{ message: { content: JSON.stringify({ verdict, reason: "Nächster Schritt: Quellen prüfen" }) } }] });
    }
    return realFetch(url as any, init);
  }) as typeof fetch;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  if (env.judge === undefined) delete process.env.AUX_MODEL_JUDGE;
  else process.env.AUX_MODEL_JUDGE = env.judge;
  if (env.key === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = env.key;
  setChoicesFileForTests(null);
  await rm(root, { recursive: true, force: true });
});

const servers: WebServer[] = [];
let unsubscribers: (() => void)[] = [];
let active: Ctx | null = null;
afterEach(async () => {
  for (const key of [KEY, `dm:${USER}`, `group:${GROUP}`]) await clearGoal(key);
  await active?.goalChoices?.settled();
  abortAllExecutions();
  // Offenen Ziel-Turn beenden, damit die Schleife endet
  active?.pendingGoalTurn?.({ text: "", aborted: true });
  active = null;
  await waitUntil(() => !isGoalLoopRunning(KEY));
  for (const s of servers.splice(0)) await s.stop();
  for (const u of unsubscribers.splice(0)) u();
  verdict = "continue";
});

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

interface Ctx {
  server: WebServer;
  origin: string;
  cookie: string;
  bearer: string;
  saved: WebSavedMessage[];
  rows: HistoryRow[];
  telegram: string[];
  records: SendAndRecordInput[];
  aborts: string[];
  /** Offener Arbeits-Turn des Ziels, den der Test beendet */
  pendingGoalTurn: ((r: { text: string; aborted: boolean }) => void) | null;
  goalTurns: number;
  webId: string;
  /** Angehaltene Antworten bzw. Rückfragen (StartOptions.hold), der Test gibt sie frei */
  release: (() => void)[];
  /** Agenten der normalen Antworten und Rückfragen, in Reihenfolge */
  calls: string[];
  /** Nur mit StartOptions.budgetChoices (Issue #118) */
  goalChoices?: GoalChoices;
  /** Telegram-Knopf "ch|" drücken (Middleware wie in src/bot.ts) */
  click?(data: string, messageId: number): Promise<void>;
  /** Api-Aufrufe der Telegram-Seite der Rückfragen (answerCallbackQuery, editMessageText) */
  tgCalls: { method: string; args: unknown[] }[];
  /** message_id der zuletzt gesendeten Rückfrage */
  lastMessageId: number;
  /** Solange gesetzt, wartet editMessageText darauf (Telegram zieht gerade nach) */
  editGate: Promise<void> | null;
  /** Wie viele editMessageText gerade am editGate warten */
  editsHeld: number;
  /** Solange gesetzt, wartet die Entscheidung der Karte im Register darauf (decideFromCard hat die offene Frage schon gefunden) */
  decideGate: Promise<void> | null;
  /** Wie viele Entscheidungen der Karte gerade am decideGate warten */
  decidesHeld: number;
  /** Einmalig: die nächste Registersuche der Budget-Fragen wartet darauf, bevor sie liest */
  listGate: Promise<void> | null;
  /** Wie viele Registersuchen gerade am listGate warten */
  listsHeld: number;
}

interface StartOptions {
  /** Normale Antwort ("turn") oder [INVOKE:]-Rückfrage ("invoke") hält an, bis der Test sie freigibt */
  hold?: "turn" | "invoke";
  /** Antwort von Research; Standard „Antwort" */
  reply?: string;
  /** Budget-Frage über das Rückfragen-Register, verdrahtet wie in src/bot.ts (Issue #118) */
  budgetChoices?: boolean;
}

async function start(options: StartOptions = {}): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  const ctx = { saved: [], rows: [], telegram: [], records: [], aborts: [], pendingGoalTurn: null, goalTurns: 0, release: [], calls: [], tgCalls: [], lastMessageId: 900, editGate: null, editsHeld: 0, decideGate: null, decidesHeld: 0, listGate: null, listsHeld: 0 } as unknown as Ctx;
  active = ctx;
  let rowCounter = 0;
  let savedHook: MessageSavedListener | null = null;
  const emitSaved = (row: HistoryRow) =>
    savedHook?.({ chatId: (row as any).chat_id, role: row.role as "user" | "assistant", content: row.content, metadata: row.metadata as Record<string, unknown>, createdAt: row.created_at });
  function storeRow(chatId: string, role: "user" | "assistant", content: string, metadata: Record<string, unknown>): HistoryRow {
    const row = { id: `row-${++rowCounter}`, created_at: new Date(Date.now() + rowCounter).toISOString(), role, content, metadata, chat_id: chatId } as unknown as HistoryRow;
    ctx.rows.push(row);
    return row;
  }
  const saveMessage = async (m: WebSavedMessage) => {
    const metadata = { ...(m.metadata ?? {}) };
    if (!metadata.msgId) metadata.msgId = crypto.randomUUID();
    ctx.saved.push({ ...m, metadata });
    await emitSaved(storeRow(m.chat_id, m.role, m.content, metadata));
    return true;
  };
  const abort = (key: string) => {
    ctx.aborts.push(key);
    return abortExecutions(key);
  };

  // Rückfragen-Register wie in src/bot.ts (Issue #118): Telegram-Seite mit Api- und Sende-Attrappe,
  // die Frage landet mit choiceId im Verlauf des Topics
  let choicePort: ReturnType<typeof testChoices>["port"] | undefined;
  if (options.budgetChoices) {
    const fixture = testChoices(join(dir, "choices.json"), { userId: USER, groupId: GROUP });
    choicePort = fixture.port;
    const api = {
      answerCallbackQuery: async (...args: unknown[]) => void ctx.tgCalls.push({ method: "answerCallbackQuery", args }),
      editMessageText: async (...args: unknown[]) => {
        if (ctx.editGate) {
          ctx.editsHeld++;
          await ctx.editGate;
          ctx.editsHeld--;
        }
        ctx.tgCalls.push({ method: "editMessageText", args });
      },
      editMessageReplyMarkup: async (...args: unknown[]) => void ctx.tgCalls.push({ method: "editMessageReplyMarkup", args }),
    };
    const tgChoices = createTelegramChoices({
      api,
      owner: USER,
      send: async input => {
        ctx.records.push(input);
        const metadata: Record<string, unknown> = { display_only: true, source: input.source, msgId: crypto.randomUUID(), choiceId: input.choiceId };
        if (input.topicId !== undefined && input.topicId !== 1) metadata.topicId = input.topicId;
        const chatId = input.topicId === undefined ? USER : GROUP;
        await emitSaved(storeRow(chatId, "assistant", input.text!, metadata));
        const messageId = ++ctx.lastMessageId;
        return { sent: true, recorded: true, messages: [{ chatId, messageId, part: "text" as const, buttons: true }] };
      },
      log: () => {},
    });
    const composer = new Composer<Context>();
    unsubscribers.push(installTelegramChoices(composer, tgChoices));
    ctx.goalChoices = createGoalChoices({
      getGoal,
      abort,
      sendChoice: c => tgChoices.sendChoice(c),
      listChoices: async () => {
        const gate = ctx.listGate;
        if (gate) {
          // Nur diese eine Suche hält an, spätere (etwa der Zuhörer) laufen durch
          ctx.listGate = null;
          ctx.listsHeld++;
          await gate;
          ctx.listsHeld--;
        }
        return listChoices();
      },
      decideChoice: async (id, key, via) => {
        if (ctx.decideGate) {
          ctx.decidesHeld++;
          await ctx.decideGate;
          ctx.decidesHeld--;
        }
        return decideChoice(id, key, via);
      },
      log: () => {},
    });
    unsubscribers.push(onChoiceDecided("goal", ctx.goalChoices.handler));
    unsubscribers.push(onGoalChange(ctx.goalChoices.listener));
    ctx.click = async (data, messageId) => {
      const update = {
        update_id: 1,
        callback_query: {
          id: "q1",
          from: { id: Number(USER), is_bot: false, first_name: "E" },
          chat_instance: "ci",
          data,
          message: { message_id: messageId, date: 0, chat: { id: Number(GROUP), type: "supergroup", title: "G" } },
        },
      };
      const c = new Context(update as any, api as any, { id: 1, is_bot: true, first_name: "Bot", username: "bot" } as any);
      await composer.middleware()(c, async () => {});
    };
  }

  // Goal-Engine wie in src/bot.ts verdrahtet, nur mit Attrappen für Claude und Telegram
  initGoalEngine({
    callAgent: () => {
      ctx.goalTurns++;
      return new Promise(resolve => {
        ctx.pendingGoalTurn = resolve;
      });
    },
    sendAsAgent: async (agent, chatId, text, topicId) => void ctx.telegram.push(`send ${agent} ${chatId} ${topicId} ${text}`),
    sendStatus: createTelegramGoalStatus({
      send: async (chatId, text, threadId, keyboard) => void ctx.telegram.push(`status ${chatId} ${threadId} ${text}${keyboard ? " [Knöpfe]" : ""}`),
      record: (target, message) =>
        saveMessage({
          chat_id: target.chatId,
          role: "assistant",
          content: message.text,
          metadata: { display_only: true, source: GOAL_NOTICE_SOURCE, ...(target.topicId ? { topicId: target.topicId } : {}) },
        }),
      ...(ctx.goalChoices ? { ask: ctx.goalChoices.ask, noButtonsHint: GOAL_NO_BUTTONS_HINT } : {}),
    }),
    saveMessage: m => saveMessage(m as WebSavedMessage),
  });

  const turnDeps = {
    runStreamingTurn: async (opts: { userMessage: string; agentName: string }) => {
      ctx.calls.push(opts.agentName);
      const invocation = opts.userMessage.includes("CROSS-AGENT CONSULTATION");
      if (options.hold === (invocation ? "invoke" : "turn")) {
        const signal = currentExecution()?.controller.signal;
        await new Promise<void>(resolve => {
          ctx.release.push(resolve);
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        if (signal?.aborted) return ABORT_REPLY;
      }
      return invocation ? "Kritik" : (options.reply ?? "Antwort");
    },
    saveMessage,
    processIntents: async () => {},
    abortEngineCalls: abort,
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
  };
  const telegramDeps = {
    userId: USER,
    groupId: () => GROUP,
    agentForTopic: (topicId: number) => (topicId === TOPIC ? "research" : undefined),
    sendPlain: async (chatId: string, text: string, threadId?: number) => void ctx.telegram.push(`plain ${chatId} ${threadId} ${text}`),
    sendAsAgent: async (agent: string, chatId: string, text: string, threadId?: number) => void ctx.telegram.push(`send ${agent} ${chatId} ${threadId} ${text}`),
  };
  const services = {
    isSessionModeEnabled: () => true,
    getGoal,
    pauseGoal: async () => {},
    abortEngineCalls: abort,
    goals: {
      get: getGoal,
      set: setGoal,
      update: updateGoal,
      action: (key: string, action: any) => runGoalAction(key, action, { abort }),
      start: (key: string) => void startGoalWork(key),
      formatStatus: formatGoalStatus,
    },
  } as unknown as CommandServices;
  const commands = createBotCommands({
    ...turnDeps,
    ...telegramDeps,
    registry: commandRegistry,
    services,
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
  const goals = createBotGoals({
    ...telegramDeps,
    get: getGoal,
    isRunning: isGoalLoopRunning,
    action: (key, action, goalId, onlyIf) => runGoalAction(key, action, { goalId, abort, onlyIf }),
    ...(ctx.goalChoices ? { decideBudget: ctx.goalChoices.decideFromCard } : {}),
    onChange: listener => {
      const off = onGoalChange(listener);
      unsubscribers.push(off);
      return off;
    },
    log: () => {},
  });
  const telegram = createTelegramSource({
    userId: USER,
    groupId: () => GROUP,
    topicNames: async () => ({ [String(TOPIC)]: "Recherche" }),
    topicMapping: () => ({ [String(TOPIC)]: "research" }),
    history: async (chatId, topicId) => ctx.rows.filter(r => (r as any).chat_id === chatId && ((r.metadata as any)?.topicId ?? null) === topicId),
    activity: async () => [],
    log: () => {},
  });
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  ctx.webId = (await store.createConversation("research")).id;
  const unusedChat: WebChat = { runTurn: async (_o: RunTurnOptions): Promise<TurnResult> => ({ text: "nie" }), stop: () => {} };
  const tokenFile = join(dir, "cli-token");
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "web-sessions.json"),
      conversationStore: store,
      cliTokenFile: tokenFile,
      chat: unusedChat,
      telegram,
      telegramChat: createTelegramChat({
        ...turnDeps,
        ...telegramDeps,
        invokeBudget: 3,
        sendTypingAsAgent: async () => {},
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
      goals,
      ...(choicePort ? { choices: choicePort } : {}),
      log: () => {},
    }
  );
  servers.push(server);
  ctx.server = server;
  ctx.origin = server.url;
  const res = await realFetch(`${ctx.origin}/api/login`, { method: "POST", headers: { origin: ctx.origin }, body: JSON.stringify({ password: PASSWORD }) });
  ctx.cookie = res.headers.get("set-cookie")!.split(";")[0];
  ctx.bearer = (await readFile(tokenFile, "utf8")).trim();
  return ctx;
}

function api(ctx: Ctx, path: string, init: { method?: string; body?: unknown; terminal?: boolean; headers?: Record<string, string> } = {}) {
  const auth = init.terminal ? { authorization: `Bearer ${ctx.bearer}` } : { origin: ctx.origin, cookie: ctx.cookie };
  return realFetch(`${ctx.origin}${path}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", ...auth, ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const post = (ctx: Ctx, id: string, text: string, terminal = false) => api(ctx, `/api/conversations/${id}/messages`, { method: "POST", body: { text }, terminal });
const press = (ctx: Ctx, id: string, action: string, goalId: unknown, terminal = false) =>
  api(ctx, `/api/conversations/${id}/goal`, { method: "POST", body: { action, goalId }, terminal });
const card = async (ctx: Ctx, id = `topic-${TOPIC}`) => (await (await api(ctx, `/api/conversations/${id}/goal`)).json()).card;

async function listen(ctx: Ctx, id: string) {
  const controller = new AbortController();
  const res = await realFetch(`${ctx.origin}/api/conversations/${id}/events`, { headers: { cookie: ctx.cookie, origin: ctx.origin }, signal: controller.signal });
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
    cards: () => events.filter(e => e.event === "goal").map(e => e.data.card),
    messages: () => events.filter(e => e.event === "message").map(e => e.data),
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
      await done;
    },
  };
}

/** Bis im Gespräch kein Befehl mehr läuft (die Sperre des Hubs ist frei) */
async function idle(ctx: Ctx, id = `topic-${TOPIC}`): Promise<void> {
  const end = Date.now() + 3000;
  while ((await (await api(ctx, `/api/conversations/${id}`)).json()).running) {
    if (Date.now() > end) throw new Error("Gespräch wird nicht frei");
    await Bun.sleep(5);
  }
}

async function goalsOnDisk(): Promise<Record<string, any>> {
  return JSON.parse(await readFile(goalsFile, "utf8"));
}

describe("/goal X aus dem Browser", () => {
  test("startet das Ziel, zeigt die Karte live und nach dem Neuladen; Telegram bekommt Spiegelung und Antwort", async () => {
    const ctx = await start();
    const sse = await listen(ctx, `topic-${TOPIC}`);
    const res = await post(ctx, `topic-${TOPIC}`, "/goal Marktbericht schreiben");
    expect(res.status).toBe(202);
    expect((await res.json()).command).toBe("goal");
    await waitUntil(() => !!ctx.pendingGoalTurn);

    // Ziel im Zustand der Test-Kopie
    const onDisk = (await goalsOnDisk())[KEY];
    expect(onDisk).toMatchObject({ chatId: GROUP, topicId: TOPIC, agentName: "research", goal: "Marktbericht schreiben", status: "active" });

    // Karte live: aktiv, arbeitet, Runde 0 von 10, Knöpfe Pause und Stopp
    await waitUntil(() => sse.cards().some(c => c?.running));
    expect(sse.cards().at(-1)).toMatchObject({
      goalId: onDisk.createdAt,
      goal: "Marktbericht schreiben",
      agent: "research",
      status: "active",
      running: true,
      turnsUsed: 0,
      maxTurns: 10,
      actions: ["pause", "stop"],
    });
    // Neuladen: dieselbe Karte per GET
    expect(await card(ctx)).toMatchObject({ goalId: onDisk.createdAt, status: "active", running: true });

    // Telegram: Spiegelung, Antwort des Befehls (Haupt-Bot, festgehalten), Zwischenstand vor dem Turn
    expect(ctx.telegram[0]).toBe(`plain ${GROUP} ${TOPIC} Du (Web): /goal Marktbericht schreiben`);
    expect(ctx.records[0].text).toStartWith("🎯 Ziel gesetzt (Agent: research, Budget: 10 Turns)");
    expect(ctx.telegram).toContain(`status ${GROUP} ${TOPIC} 🎯 Ziel-Turn 1/10: arbeite weiter...`);
    // Die Befehlsantwort erscheint im Browser als Meldung
    await waitUntil(() => sse.messages().some(m => m.kind === "notice" && m.text.startsWith("🎯 Ziel gesetzt")));

    // Der Ziel-Turn kommt im Browser als Nachricht des Agenten an
    ctx.pendingGoalTurn!({ text: "Erster Entwurf steht", aborted: false });
    await waitUntil(() => sse.messages().some(m => m.text === "Erster Entwurf steht"));
    expect(sse.messages().find(m => m.text === "Erster Entwurf steht")).toMatchObject({ role: "assistant", agent: "research" });
    // Nach dem Judge: Runde 1 von 10 und der Befund auf der Karte
    await waitUntil(() => sse.cards().some(c => c?.turnsUsed === 1 && c?.note === "Nächster Schritt: Quellen prüfen"));
    await sse.close();
  });

  test("im Terminal: /goal setzt, /goal status und /goal pause antworten wie in Telegram", async () => {
    const ctx = await start();
    expect((await post(ctx, `topic-${TOPIC}`, "/goal Inbox leeren", true)).status).toBe(202);
    await waitUntil(() => !!ctx.pendingGoalTurn);
    expect(ctx.telegram[0]).toBe(`plain ${GROUP} ${TOPIC} Du (Terminal): /goal Inbox leeren`);
    await idle(ctx);
    expect((await post(ctx, `topic-${TOPIC}`, "/goal status", true)).status).toBe(202);
    await waitUntil(() => ctx.records.length >= 2);
    await idle(ctx);
    expect(ctx.records[1]).toMatchObject({ format: "markdown", source: "befehl" });
    expect(ctx.records[1].text).toContain("**Ziel:** Inbox leeren");
    // Pause läuft ohne Bereich; der laufende Turn läuft aus
    expect((await post(ctx, `topic-${TOPIC}`, "/goal pause", true)).status).toBe(202);
    await waitUntil(() => ctx.records.length >= 3);
    expect(ctx.records[2].text).toBe("⏸️ Ziel pausiert. /goal weiter setzt fort.");
    expect((await goalsOnDisk())[KEY].status).toBe("paused");
    expect(ctx.aborts).toEqual([]);
  });

  test("gate add, gate list, gate clear und max gehen im Browser über das Register", async () => {
    const ctx = await start();
    await setGoal({ sessionKey: KEY, chatId: GROUP, topicId: TOPIC, agentName: "research", goal: "Tests grün" });
    await updateGoal(KEY, { status: "paused" });
    for (const [i, text] of ["/goal gate add bun test", "/goal gate list", "/goal max 4", "/goal gate clear"].entries()) {
      expect((await post(ctx, `topic-${TOPIC}`, text)).status).toBe(202);
      await waitUntil(() => ctx.records.length > i);
      await idle(ctx);
    }
    expect(ctx.records.map(r => r.text)).toEqual([
      'Gate hinzugefuegt: `bun test`\nEs muss mit Exit 0 durchlaufen, bevor der Judge "fertig" sagen darf.',
      "Gates:\n1. bun test",
      "Turn-Budget: 4.",
      "Alle Gates entfernt.",
    ]);
    expect((await goalsOnDisk())[KEY]).toMatchObject({ gates: [], maxTurns: 4 });
  });
});

describe("Knöpfe der Karte", () => {
  test("Pause im Browser pausiert (auch in der Datei), die Karte zeigt Weiter und Stopp", async () => {
    const ctx = await start();
    await post(ctx, `topic-${TOPIC}`, "/goal Bericht");
    await waitUntil(() => !!ctx.pendingGoalTurn);
    const sse = await listen(ctx, `topic-${TOPIC}`);
    const before = await card(ctx);
    const res = await press(ctx, `topic-${TOPIC}`, "pause", before.goalId);
    expect(res.status).toBe(200);
    expect((await res.json()).card).toMatchObject({ status: "paused", actions: ["resume", "stop"] });
    expect((await goalsOnDisk())[KEY]).toMatchObject({ status: "paused", lastNote: "Vom User pausiert" });
    await waitUntil(() => sse.cards().some(c => c?.status === "paused"));
    // Der laufende Turn läuft aus, danach keine weitere Runde
    ctx.pendingGoalTurn!({ text: "fertig mit dem Turn", aborted: false });
    await waitUntil(() => !isGoalLoopRunning(KEY));
    expect(ctx.goalTurns).toBe(1);
    expect(ctx.aborts).toEqual([]);
    await sse.close();
  });

  test("Telegram-Knopfdruck aktualisiert die Karte live", async () => {
    const ctx = await start();
    await setGoal({ sessionKey: KEY, chatId: GROUP, topicId: TOPIC, agentName: "research", goal: "Budget-Test" });
    await updateGoal(KEY, { turnsUsed: 2, maxTurns: 2 });
    // Schleife am Budget: pausiert, Meldung in Telegram (hier ohne Rückfragen-Register, also ohne Knöpfe) und im Browser
    await startGoalWork(KEY);
    expect(ctx.telegram).toContain(`status ${GROUP} ${TOPIC} ⏸️ Turn-Budget erreicht (2/2) fuer das Ziel:\n"Budget-Test"\n\nWeitermachen?`);
    const sse = await listen(ctx, `topic-${TOPIC}`);
    expect(await card(ctx)).toMatchObject({ status: "paused", actions: ["more", "stop"] });

    // Druck auf einen alten Knopf „Weiter (+5)" (goalkb|, von vor Issue #118) in Telegram, über den Adapter wie in src/bot.ts
    expect(await handleGoalCallback(`goalkb|more|${KEY}`, { abort: k => abortExecutions(k) })).toBe("▶️ Weiter (+5 Turns).");
    await waitUntil(() => sse.cards().some(c => c?.status === "active" && c?.maxTurns === 7));
    await waitUntil(() => !!ctx.pendingGoalTurn);

    // Beenden in Telegram: die Karte verschwindet
    expect(await handleGoalCallback(`goalkb|stop|${KEY}`, { abort: k => abortExecutions(k) })).toBe('🛑 Ziel beendet: "Budget-Test"');
    await waitUntil(() => sse.cards().at(-1) === null);
    expect(await card(ctx)).toBeNull();
    await sse.close();
  });

  test("Budget-Meldung steht nach dem Neuladen als Meldung „Ziel“ im Verlauf", async () => {
    const ctx = await start();
    await setGoal({ sessionKey: KEY, chatId: GROUP, topicId: TOPIC, agentName: "research", goal: "Verlauf" });
    await updateGoal(KEY, { turnsUsed: 1, maxTurns: 1 });
    await startGoalWork(KEY);
    const history = await (await api(ctx, `/api/conversations/topic-${TOPIC}/messages`)).json();
    const notice = history.messages.find((m: any) => m.kind === "notice" && m.source === GOAL_NOTICE_SOURCE);
    expect(notice.text).toStartWith("⏸️ Turn-Budget erreicht (1/1)");
    // Der Zwischenstand vor jedem Turn wird nicht festgehalten
    expect(ctx.saved.some(m => m.content.startsWith("🎯 Ziel-Turn"))).toBe(false);
  });

  test("Weiter am Budgetlimit: +5; Doppelklick: der zweite ist veraltet, Budget nur einmal erhöht", async () => {
    const ctx = await start();
    await setGoal({ sessionKey: KEY, chatId: GROUP, topicId: TOPIC, agentName: "research", goal: "Weiter" });
    await updateGoal(KEY, { turnsUsed: 10, maxTurns: 10, status: "paused" });
    const { goalId } = await card(ctx);
    const [a, b] = await Promise.all([press(ctx, `topic-${TOPIC}`, "more", goalId), press(ctx, `topic-${TOPIC}`, "more", goalId)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const stale = [a, b].find(r => r.status === 409)!;
    expect(await stale.json()).toMatchObject({ stale: true, error: GOAL_CARD_TEXT.stale, card: { status: "active" } });
    expect((await goalsOnDisk())[KEY].maxTurns).toBe(15);
    await waitUntil(() => !!ctx.pendingGoalTurn);
    await Bun.sleep(20);
    expect(ctx.goalTurns).toBe(1);
  });

  test("Weiter ohne Budgetgrenze (/goal weiter) gibt keine zusätzlichen Turns", async () => {
    const ctx = await start();
    await setGoal({ sessionKey: KEY, chatId: GROUP, topicId: TOPIC, agentName: "research", goal: "Weiter" });
    await updateGoal(KEY, { turnsUsed: 3, maxTurns: 10, status: "paused" });
    const c = await card(ctx);
    expect(c.actions).toEqual(["resume", "stop"]);
    // „more" gilt in diesem Zustand nicht
    expect((await press(ctx, `topic-${TOPIC}`, "more", c.goalId)).status).toBe(409);
    expect((await press(ctx, `topic-${TOPIC}`, "resume", c.goalId)).status).toBe(200);
    expect((await goalsOnDisk())[KEY]).toMatchObject({ status: "active", maxTurns: 10 });
    await waitUntil(() => !!ctx.pendingGoalTurn);
  });

  test("Stopp während eines Turns: Ziel gelöscht, Abbruch des Gesprächs, Karte weg", async () => {
    const ctx = await start();
    await post(ctx, `topic-${TOPIC}`, "/goal Lang");
    await waitUntil(() => !!ctx.pendingGoalTurn);
    const sse = await listen(ctx, `topic-${TOPIC}`);
    const { goalId } = await card(ctx);
    const res = await press(ctx, `topic-${TOPIC}`, "stop", goalId);
    expect(res.status).toBe(200);
    expect((await res.json()).card).toBeNull();
    expect(ctx.aborts).toContain(KEY);
    expect((await goalsOnDisk())[KEY]).toBeUndefined();
    await waitUntil(() => sse.cards().at(-1) === null);
    // Das verspätete Ergebnis des Turns ändert nichts mehr
    ctx.pendingGoalTurn!({ text: "", aborted: true });
    await waitUntil(() => !isGoalLoopRunning(KEY));
    expect(await card(ctx)).toBeNull();
    await sse.close();
  });

  test("/goal stop aus dem Terminal während eines Turns: gleiche Wirkung, läuft ohne Bereich", async () => {
    const ctx = await start();
    await post(ctx, `topic-${TOPIC}`, "/goal Lang");
    await waitUntil(() => !!ctx.pendingGoalTurn);
    expect((await post(ctx, `topic-${TOPIC}`, "/goal stop", true)).status).toBe(202);
    await waitUntil(() => ctx.records.some(r => r.text === '🛑 Ziel beendet: "Lang"'));
    expect(ctx.aborts).toContain(KEY);
    expect(await card(ctx)).toBeNull();
  });

  test("Knopf eines früheren Ziels ist veraltet", async () => {
    const ctx = await start();
    await setGoal({ sessionKey: KEY, chatId: GROUP, topicId: TOPIC, agentName: "research", goal: "Neu" });
    await updateGoal(KEY, { status: "paused" });
    const { goalId } = await card(ctx);
    const res = await press(ctx, `topic-${TOPIC}`, "stop", goalId - 1);
    expect(res.status).toBe(409);
    expect((await res.json()).card).toMatchObject({ goalId, goal: "Neu" });
    expect(await getGoal(KEY)).toBeDefined();
  });

  test("Gesprächswechsel: die Karte gehört nur zu ihrem Gespräch", async () => {
    const ctx = await start();
    await setGoal({ sessionKey: KEY, chatId: GROUP, topicId: TOPIC, agentName: "research", goal: "Nur hier" });
    await updateGoal(KEY, { status: "paused" });
    const dm = await listen(ctx, "dm");
    expect(await card(ctx, "dm")).toBeNull();
    expect(await card(ctx, "topic-1")).toBeNull();
    expect(await card(ctx, ctx.webId)).toBeNull();
    await updateGoal(KEY, { maxTurns: 3 });
    await Bun.sleep(20);
    expect(dm.cards()).toEqual([]);
    await dm.close();
    // Ziel im Direktchat: eigene Karte dort
    await setGoal({ sessionKey: `dm:${USER}`, chatId: USER, agentName: "general", goal: "Direkt" });
    expect(await card(ctx, "dm")).toMatchObject({ goal: "Direkt", agent: "general" });
  });
});

describe("Budget-Frage und Karte verbunden (Issue #118)", () => {
  const BUDGET_TEXT = '⏸️ Turn-Budget erreicht (2/2) fuer das Ziel:\n"Budget-Test"\n\nWeitermachen?';

  /** Ziel am Budget: Budget-Frage offen im Register, in Telegram und im Verlauf des Topics */
  async function budget(ctx: Ctx, goal = "Budget-Test") {
    await setGoal({ sessionKey: KEY, chatId: GROUP, topicId: TOPIC, agentName: "research", goal });
    await updateGoal(KEY, { turnsUsed: 2, maxTurns: 2 });
    await startGoalWork(KEY);
    await ctx.goalChoices!.settled();
    const open = (await listChoices()).filter(c => c.kind === "goal" && c.state === "open");
    expect(open).toHaveLength(1);
    const goalId = (await getGoal(KEY))!.createdAt;
    return { goalId, choice: open[0], messageId: open[0].telegram![0].messageId };
  }
  const history = async (ctx: Ctx) => (await (await api(ctx, `/api/conversations/topic-${TOPIC}/messages`)).json()).messages as any[];
  const pick = (ctx: Ctx, choiceId: string, option: string) =>
    api(ctx, `/api/conversations/topic-${TOPIC}/choices/${choiceId}`, { method: "POST", body: { option } });
  const edits = (ctx: Ctx) => ctx.tgCalls.filter(c => c.method === "editMessageText").map(c => String(c.args[2]));
  const answers = (ctx: Ctx) => ctx.tgCalls.filter(c => c.method === "answerCallbackQuery").map(c => (c.args[1] as { text?: string } | undefined)?.text);

  test("Budget erreicht: Frage mit Knöpfen im Verlauf neben der Karte, genau einmal, keine Meldung ohne Knöpfe", async () => {
    const ctx = await start({ budgetChoices: true });
    const { goalId, choice } = await budget(ctx);
    expect(await card(ctx)).toMatchObject({ goalId, status: "paused", actions: ["more", "stop"] });
    const notices = (await history(ctx)).filter(m => m.text?.startsWith("⏸️ Turn-Budget erreicht"));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toMatchObject({
      kind: "notice",
      source: GOAL_NOTICE_SOURCE,
      choice: { id: choice.id, state: "open", options: [{ key: "more", label: "Weiter (+5)" }, { key: "stop", label: "Beenden" }] },
    });
    // Nicht zusätzlich als Statusmeldung ohne Knöpfe
    expect(ctx.telegram.some(t => t.includes("Turn-Budget erreicht"))).toBe(false);
    expect(ctx.saved.some(m => m.content.startsWith("⏸️ Turn-Budget erreicht"))).toBe(false);
  });

  test("Weiter in der Karte: genau 5 Turns, Frage erledigt „im Browser“, Telegram zieht nach, zweiter Telegram-Klick meldet „Schon erledigt“", async () => {
    const ctx = await start({ budgetChoices: true });
    const { goalId, choice, messageId } = await budget(ctx);
    const sse = await listen(ctx, `topic-${TOPIC}`);
    const res = await press(ctx, `topic-${TOPIC}`, "more", goalId);
    expect(res.status).toBe(200);
    expect((await res.json()).card).toMatchObject({ goalId, status: "active", maxTurns: 7, turnsUsed: 2 });
    expect((await goalsOnDisk())[KEY]).toMatchObject({ status: "active", maxTurns: 7 });
    expect(await getChoice(choice.id)).toMatchObject({ state: "done", result: { key: "more", via: "web" } });
    expect(edits(ctx)).toEqual([`${BUDGET_TEXT}\n\n✓ Weiter (+5) (im Browser)`]);
    // Der Verlauf im Browser zieht ohne Neuladen nach
    await waitUntil(() => sse.events.some(e => e.event === "choice" && e.data.choice?.id === choice.id && e.data.choice?.state === "done"));
    await waitUntil(() => !!ctx.pendingGoalTurn);

    await ctx.click!(`ch|${choice.id}|more`, messageId);
    await ctx.click!(`ch|${choice.id}|stop`, messageId);
    expect(answers(ctx)).toEqual(["Schon erledigt: Weiter (+5) im Browser", "Schon erledigt: Weiter (+5) im Browser"]);
    expect((await goalsOnDisk())[KEY]).toMatchObject({ status: "active", maxTurns: 7 });
    expect(ctx.goalTurns).toBe(1);
    await sse.close();
  });

  test("Weiter im Verlauf (Knopf der Frage): genau 5 Turns, die Karte zieht live nach, ein alter Kartenknopf ist danach veraltet", async () => {
    const ctx = await start({ budgetChoices: true });
    const { goalId, choice } = await budget(ctx);
    const sse = await listen(ctx, `topic-${TOPIC}`);
    const res = await pick(ctx, choice.id, "more");
    expect(res.status).toBe(200);
    expect((await res.json()).choice).toMatchObject({ state: "done", result: { label: "Weiter (+5)", via: "web" } });
    await waitUntil(() => sse.cards().some(c => c?.status === "active" && c?.maxTurns === 7));
    expect(edits(ctx)).toEqual([`${BUDGET_TEXT}\n\n✓ Weiter (+5) (im Browser)`]);
    // Karte mit dem Stand vor dem Klick: veraltet, nichts doppelt
    const stale = await press(ctx, `topic-${TOPIC}`, "more", goalId);
    expect(stale.status).toBe(409);
    expect((await goalsOnDisk())[KEY].maxTurns).toBe(7);
    await waitUntil(() => !!ctx.pendingGoalTurn);
    expect(ctx.goalTurns).toBe(1);
    await sse.close();
  });

  test("Stopp in der Karte: Ziel weg, Abbruch, Frage „Beenden“ im Browser erledigt, Telegram zieht nach", async () => {
    const ctx = await start({ budgetChoices: true });
    const { goalId, choice } = await budget(ctx);
    const res = await press(ctx, `topic-${TOPIC}`, "stop", goalId);
    expect(res.status).toBe(200);
    expect((await res.json()).card).toBeNull();
    expect((await goalsOnDisk())[KEY]).toBeUndefined();
    expect(ctx.aborts).toContain(KEY);
    expect(await getChoice(choice.id)).toMatchObject({ state: "done", result: { key: "stop", label: "Beenden", via: "web" } });
    expect(edits(ctx)).toEqual([`${BUDGET_TEXT}\n\n✓ Beenden (im Browser)`]);
  });

  test("Weiter in Telegram: die Karte zieht live nach, die Frage im Browser steht als erledigt „in Telegram“", async () => {
    const ctx = await start({ budgetChoices: true });
    const { choice, messageId } = await budget(ctx);
    const sse = await listen(ctx, `topic-${TOPIC}`);
    await ctx.click!(`ch|${choice.id}|more`, messageId);
    expect(answers(ctx)).toEqual(["✓ Weiter (+5)"]);
    await waitUntil(() => sse.cards().some(c => c?.status === "active" && c?.maxTurns === 7));
    await waitUntil(() => sse.events.some(e => e.event === "choice" && e.data.choice?.result?.via === "telegram"));
    const notice = (await history(ctx)).find(m => m.choice?.id === choice.id);
    expect(notice.choice).toMatchObject({ state: "done", result: { key: "more", via: "telegram" } });
    await sse.close();
  });

  test("gleichzeitig Stopp in der Karte und Weiter in Telegram: genau ein Gewinner, Karte, Ziel und Frage passen zusammen", async () => {
    for (let round = 0; round < 3; round++) {
      const ctx = await start({ budgetChoices: true });
      const { goalId, choice, messageId } = await budget(ctx, `Runde ${round}`);
      const [res] = await Promise.all([press(ctx, `topic-${TOPIC}`, "stop", goalId), ctx.click!(`ch|${choice.id}|more`, messageId)]);
      const decided = await getChoice(choice.id);
      expect(decided?.state).toBe("done");
      if (decided!.result!.key === "stop") {
        expect(res.status).toBe(200);
        expect((await goalsOnDisk())[KEY]).toBeUndefined();
        expect(answers(ctx)).toEqual(["Schon erledigt: Beenden im Browser"]);
      } else {
        expect(res.status).toBe(409);
        expect((await goalsOnDisk())[KEY]).toMatchObject({ status: "active", maxTurns: 7 });
      }
      expect(edits(ctx)).toHaveLength(1);
      await clearGoal(KEY);
      ctx.pendingGoalTurn?.({ text: "", aborted: true });
      await waitUntil(() => !isGoalLoopRunning(KEY));
      await ctx.goalChoices!.settled();
      for (const srv of servers.splice(0)) await srv.stop();
      for (const u of unsubscribers.splice(0)) u();
    }
  });

  test("Karten-Stopp, während Telegram „Weiter“ schon gespeichert hat und gerade nachzieht: 409, nur der Gewinner wirkt", async () => {
    const ctx = await start({ budgetChoices: true });
    const { goalId, choice, messageId } = await budget(ctx);
    // Telegram entscheidet „Weiter“: done ist gespeichert, editMessageText hängt, der Handler wartet dahinter
    let release!: () => void;
    ctx.editGate = new Promise<void>(r => (release = r));
    const clicked = ctx.click!(`ch|${choice.id}|more`, messageId);
    await waitUntil(() => ctx.editsHeld === 1);
    expect(await getChoice(choice.id)).toMatchObject({ state: "done", result: { key: "more", via: "telegram" } });
    expect((await goalsOnDisk())[KEY]).toMatchObject({ status: "paused", maxTurns: 2 });

    // Die Karte zeigt noch „pausiert“ mit Stopp: der Klick darf nicht am Register vorbei löschen
    const res = await press(ctx, `topic-${TOPIC}`, "stop", goalId);
    expect(res.status).toBe(409);
    expect((await goalsOnDisk())[KEY]).toMatchObject({ status: "paused", maxTurns: 2 });
    expect(ctx.aborts).toEqual([]);

    ctx.editGate = null;
    release();
    await clicked;
    // Nur der Handler des Gewinners hat gewirkt: Ziel mit +5 aktiv, Frage ohne Handlerfehler
    expect((await goalsOnDisk())[KEY]).toMatchObject({ goal: "Budget-Test", status: "active", maxTurns: 7 });
    const decided = await getChoice(choice.id);
    expect(decided).toMatchObject({ state: "done", result: { key: "more", via: "telegram" } });
    expect(decided?.handlerError).toBeUndefined();
    expect(edits(ctx)).toEqual([`${BUDGET_TEXT}\n\n✓ Weiter (+5) (in Telegram)`]);
    expect(ctx.aborts).toEqual([]);
    await waitUntil(() => !!ctx.pendingGoalTurn);
    expect(ctx.goalTurns).toBe(1);
    expect(await card(ctx)).toMatchObject({ goalId, status: "active", maxTurns: 7 });
  });

  test("Karten-Weiter, während /goal pause die gefundene Frage ablaufen lässt: 409, Pause bleibt, kein Budget, keine Arbeit", async () => {
    const ctx = await start({ budgetChoices: true });
    const { goalId, choice } = await budget(ctx);
    // Die Karte hat die offene Frage gefunden, ihre Entscheidung im Register hält an
    let release!: () => void;
    ctx.decideGate = new Promise<void>(r => (release = r));
    const pressed = press(ctx, `topic-${TOPIC}`, "more", goalId);
    await waitUntil(() => ctx.decidesHeld === 1);

    // Dazwischen /goal pause, vollständig: Pause gespeichert, Frage abgelaufen
    expect((await post(ctx, `topic-${TOPIC}`, "/goal pause")).status).toBe(202);
    await waitUntil(() => ctx.records.some(r => r.text === "⏸️ Ziel pausiert. /goal weiter setzt fort."));
    await ctx.goalChoices!.settled();
    expect((await goalsOnDisk())[KEY]).toMatchObject({ status: "paused", budgetPaused: false, maxTurns: 2 });
    expect(await getChoice(choice.id)).toMatchObject({ state: "expired" });

    ctx.decideGate = null;
    release();
    const res = await pressed;
    expect(res.status).toBe(409);
    expect((await goalsOnDisk())[KEY]).toMatchObject({ status: "paused", budgetPaused: false, turnsUsed: 2, maxTurns: 2 });
    expect(await getChoice(choice.id)).toMatchObject({ state: "expired" });
    await Bun.sleep(20);
    expect(isGoalLoopRunning(KEY)).toBe(false);
    expect(ctx.goalTurns).toBe(0);
    expect(ctx.aborts).toEqual([]);
  });

  test("Karten-Weiter, während /goal pause die Frage noch vor der Registersuche ablaufen lässt: 409, Pause bleibt, kein Budget, keine Arbeit", async () => {
    const ctx = await start({ budgetChoices: true });
    const { goalId, choice } = await budget(ctx);
    // Die Karte hat den Zustand geprüft, ihre Registersuche hält vor dem Lesen an
    let release!: () => void;
    ctx.listGate = new Promise<void>(r => (release = r));
    const pressed = press(ctx, `topic-${TOPIC}`, "more", goalId);
    await waitUntil(() => ctx.listsHeld === 1);

    // Dazwischen /goal pause, vollständig: Pause gespeichert, Frage abgelaufen
    expect((await post(ctx, `topic-${TOPIC}`, "/goal pause")).status).toBe(202);
    await waitUntil(() => ctx.records.some(r => r.text === "⏸️ Ziel pausiert. /goal weiter setzt fort."));
    await ctx.goalChoices!.settled();
    expect((await goalsOnDisk())[KEY]).toMatchObject({ status: "paused", budgetPaused: false, maxTurns: 2 });
    expect(await getChoice(choice.id)).toMatchObject({ state: "expired" });

    // Die Suche findet nur noch die abgelaufene Frage: die Karte handelt selbst, aber nur im gezeigten Zustand
    release();
    const res = await pressed;
    expect(res.status).toBe(409);
    expect((await goalsOnDisk())[KEY]).toMatchObject({ status: "paused", budgetPaused: false, turnsUsed: 2, maxTurns: 2 });
    expect(await getChoice(choice.id)).toMatchObject({ state: "expired" });
    await Bun.sleep(20);
    expect(isGoalLoopRunning(KEY)).toBe(false);
    expect(ctx.goalTurns).toBe(0);
    expect(ctx.aborts).toEqual([]);
  });

  test("gleichzeitig Weiter in der Karte und im Verlauf: Budget genau einmal +5", async () => {
    const ctx = await start({ budgetChoices: true });
    const { goalId, choice } = await budget(ctx);
    const [a, b] = await Promise.all([press(ctx, `topic-${TOPIC}`, "more", goalId), pick(ctx, choice.id, "more")]);
    expect([a.status, b.status].filter(s => s === 200)).toHaveLength(1);
    expect((await goalsOnDisk())[KEY].maxTurns).toBe(7);
    await waitUntil(() => !!ctx.pendingGoalTurn);
    await Bun.sleep(20);
    expect(ctx.goalTurns).toBe(1);
  });

  test("Zielwechsel per /goal im Browser: die alte Frage läuft ab (Verlauf und Telegram), ihr Knopf wirkt nicht auf das neue Ziel", async () => {
    const ctx = await start({ budgetChoices: true });
    const { choice, messageId } = await budget(ctx, "Ziel A");
    const sse = await listen(ctx, `topic-${TOPIC}`);
    expect((await post(ctx, `topic-${TOPIC}`, "/goal Ziel B")).status).toBe(202);
    await waitUntil(() => !!ctx.pendingGoalTurn);
    await ctx.goalChoices!.settled();
    expect(await getChoice(choice.id)).toMatchObject({ state: "expired" });
    await waitUntil(() => sse.events.some(e => e.event === "choice" && e.data.choice?.id === choice.id && e.data.choice?.state === "expired"));
    expect(edits(ctx)).toEqual([`${BUDGET_TEXT.replace("Budget-Test", "Ziel A")}\n\nAbgelaufen, nichts geändert`]);
    // Später Klick auf den Knopf von A: nichts passiert mit B
    const res = await pick(ctx, choice.id, "stop");
    expect(res.status).toBe(409);
    await ctx.click!(`ch|${choice.id}|stop`, messageId);
    expect(answers(ctx)).toEqual(["Abgelaufen"]);
    expect((await goalsOnDisk())[KEY]).toMatchObject({ goal: "Ziel B", status: "active" });
    expect(ctx.aborts).toEqual([]);
    await sse.close();
  });

  test("/goal stop im Browser: die offene Budget-Frage läuft ab", async () => {
    const ctx = await start({ budgetChoices: true });
    const { choice } = await budget(ctx);
    expect((await post(ctx, `topic-${TOPIC}`, "/goal stop")).status).toBe(202);
    await waitUntil(() => ctx.records.some(r => r.text === '🛑 Ziel beendet: "Budget-Test"'));
    await ctx.goalChoices!.settled();
    expect(await getChoice(choice.id)).toMatchObject({ state: "expired" });
    expect((await history(ctx)).find(m => m.choice?.id === choice.id).choice.state).toBe("expired");
  });

  test("/goal weiter (ohne neue Turns): die Frage läuft ab, beim erneuten Budget-Ende steht genau eine neue offen", async () => {
    const ctx = await start({ budgetChoices: true });
    const { goalId, choice } = await budget(ctx);
    expect((await post(ctx, `topic-${TOPIC}`, "/goal weiter")).status).toBe(202);
    await waitUntil(() => ctx.records.filter(r => r.choiceId).length === 2);
    await waitUntil(() => !isGoalLoopRunning(KEY));
    await ctx.goalChoices!.settled();
    const all: Choice[] = (await listChoices()).filter(c => c.kind === "goal");
    expect(all.find(c => c.id === choice.id)?.state).toBe("expired");
    expect(all.filter(c => c.state === "open").map(c => c.ref)).toEqual([String(goalId)]);
    expect(await card(ctx)).toMatchObject({ goalId, actions: ["more", "stop"] });
  });

  test("/goal pause am Budget: die Frage läuft ab (Register, Verlauf, Telegram ohne Knöpfe), spätere Klicks wirken nicht; die nächste Budget-Pause fragt wieder", async () => {
    const ctx = await start({ budgetChoices: true });
    const { goalId, choice, messageId } = await budget(ctx);
    const sse = await listen(ctx, `topic-${TOPIC}`);
    expect((await post(ctx, `topic-${TOPIC}`, "/goal pause")).status).toBe(202);
    await waitUntil(() => ctx.records.some(r => r.text === "⏸️ Ziel pausiert. /goal weiter setzt fort."));
    await ctx.goalChoices!.settled();
    expect((await goalsOnDisk())[KEY]).toMatchObject({ status: "paused", budgetPaused: false, maxTurns: 2 });
    expect(await getChoice(choice.id)).toMatchObject({ state: "expired" });
    expect((await history(ctx)).find(m => m.choice?.id === choice.id).choice.state).toBe("expired");
    await waitUntil(() => sse.events.some(e => e.event === "choice" && e.data.choice?.id === choice.id && e.data.choice?.state === "expired"));
    // Telegram: Knöpfe weg, Text „Abgelaufen“
    const edit = ctx.tgCalls.find(c => c.method === "editMessageText")!;
    expect(String(edit.args[2])).toBe(`${BUDGET_TEXT}\n\nAbgelaufen, nichts geändert`);
    expect(JSON.stringify(edit.args[3] ?? {})).not.toContain("ch|");

    // Späte Klicks auf die Frage: nichts passiert
    expect((await pick(ctx, choice.id, "more")).status).toBe(409);
    await ctx.click!(`ch|${choice.id}|more`, messageId);
    await ctx.click!(`ch|${choice.id}|stop`, messageId);
    expect(answers(ctx)).toEqual(["Abgelaufen", "Abgelaufen"]);
    expect((await goalsOnDisk())[KEY]).toMatchObject({ status: "paused", maxTurns: 2 });
    expect(ctx.aborts).toEqual([]);
    expect(ctx.goalTurns).toBe(0);

    // /goal weiter: Budget weiter aufgebraucht, die automatische Pause stellt eine neue Frage, die offen bleibt
    expect((await post(ctx, `topic-${TOPIC}`, "/goal weiter")).status).toBe(202);
    await waitUntil(() => ctx.records.filter(r => r.choiceId).length === 2);
    await waitUntil(() => !isGoalLoopRunning(KEY));
    await ctx.goalChoices!.settled();
    expect((await goalsOnDisk())[KEY]).toMatchObject({ status: "paused", budgetPaused: true });
    const open = (await listChoices()).filter(c => c.kind === "goal" && c.state === "open");
    expect(open.map(c => c.ref)).toEqual([String(goalId)]);
    expect(open[0].id).not.toBe(choice.id);
    await sse.close();
  });
});

describe("/goal pause und /goal stop während laufender Arbeit im Gespräch", () => {
  /** Ziel setzen, ohne dass die Ziel-Schleife läuft; dann eine normale Nachricht, die anhält */
  async function busy(options: StartOptions, terminal: boolean) {
    const ctx = await start(options);
    await setGoal({ sessionKey: KEY, chatId: GROUP, topicId: TOPIC, agentName: "research", goal: "Bericht" });
    expect((await post(ctx, `topic-${TOPIC}`, "Recherchiere bitte", terminal)).status).toBe(202);
    await waitUntil(() => ctx.release.length === 1);
    return ctx;
  }
  const running = async (ctx: Ctx) => (await (await api(ctx, `/api/conversations/topic-${TOPIC}`)).json()).running;

  for (const terminal of [false, true]) {
    const where = terminal ? "Terminal" : "Browser";

    test(`${where}: /goal pause während einer normalen Antwort wird angenommen, pausiert, die Antwort läuft zu Ende`, async () => {
      const ctx = await busy({ hold: "turn", reply: "Fertige Antwort" }, terminal);
      const res = await post(ctx, `topic-${TOPIC}`, "/goal pause", terminal);
      expect(res.status).toBe(202);
      expect((await res.json()).command).toBe("goal");
      expect((await goalsOnDisk())[KEY]).toMatchObject({ status: "paused", lastNote: "Vom User pausiert" });
      expect(ctx.records.map(r => r.text)).toContain("⏸️ Ziel pausiert. /goal weiter setzt fort.");
      expect(ctx.aborts).toEqual([]);
      expect(await running(ctx)).toBe(true);
      ctx.release.shift()!();
      await idle(ctx);
      expect(ctx.saved.some(m => m.role === "assistant" && m.content === "Fertige Antwort")).toBe(true);
      expect(await getGoal(KEY)).toMatchObject({ status: "paused" });
    });

    for (const word of ["stop", "abbrechen"]) {
      test(`${where}: /goal ${word} während einer normalen Antwort löscht das Ziel und bricht die Antwort ab`, async () => {
        const ctx = await busy({ hold: "turn", reply: "Fertige Antwort" }, terminal);
        const res = await post(ctx, `topic-${TOPIC}`, `/goal ${word}`, terminal);
        expect(res.status).toBe(202);
        expect(ctx.aborts).toEqual([KEY]);
        expect((await goalsOnDisk())[KEY]).toBeUndefined();
        expect(ctx.records.map(r => r.text)).toContain('🛑 Ziel beendet: "Bericht"');
        await idle(ctx);
        expect(ctx.saved.some(m => m.role === "assistant" && m.content === "Fertige Antwort")).toBe(false);
        expect(await card(ctx)).toBeNull();
      });
    }

    test(`${where}: /goal pause während einer [INVOKE:]-Rückfrage wird angenommen, die Rückfrage läuft zu Ende`, async () => {
      const ctx = await busy({ hold: "invoke", reply: "[INVOKE:critic|Risiko?]" }, terminal);
      expect(ctx.calls).toEqual(["research", "critic"]);
      expect((await post(ctx, `topic-${TOPIC}`, "/goal pause", terminal)).status).toBe(202);
      expect(await getGoal(KEY)).toMatchObject({ status: "paused" });
      expect(ctx.aborts).toEqual([]);
      ctx.release.shift()!();
      await idle(ctx);
      expect(ctx.saved.some(m => (m.metadata as any).agent === "critic" && m.content === "Kritik")).toBe(true);
    });

    test(`${where}: /goal cancel während einer [INVOKE:]-Rückfrage löscht das Ziel und bricht die Rückfrage ab`, async () => {
      const ctx = await busy({ hold: "invoke", reply: "[INVOKE:critic|Risiko?]" }, terminal);
      expect((await post(ctx, `topic-${TOPIC}`, "/goal cancel", terminal)).status).toBe(202);
      expect(ctx.aborts).toEqual([KEY]);
      expect(await getGoal(KEY)).toBeUndefined();
      await idle(ctx);
      expect(ctx.saved.some(m => (m.metadata as any).agent === "critic")).toBe(false);
      expect(ctx.telegram.some(t => t.startsWith("send critic"))).toBe(false);
    });

    test(`${where}: andere /goal-Befehle bleiben während einer Antwort gesperrt`, async () => {
      const ctx = await busy({ hold: "turn" }, terminal);
      for (const text of ["/goal", "/goal status", "/goal weiter", "/goal max 3", "/goal gate list", "/goal Neues Ziel"]) {
        const res = await post(ctx, `topic-${TOPIC}`, text, terminal);
        expect(res.status).toBe(409);
      }
      expect(await getGoal(KEY)).toMatchObject({ goal: "Bericht", status: "active" });
      expect((await getGoal(KEY))!.maxTurns).not.toBe(3);
      ctx.release.shift()!();
      await idle(ctx);
    });
  }
});

describe("Knopf-Route: Anmeldung, Origin, Gespräch, Anfrage", () => {
  test("ohne Anmeldung 401, fremder Origin 403, unbekanntes Gespräch 404, kaputte Anfrage 400", async () => {
    const ctx = await start();
    await setGoal({ sessionKey: KEY, chatId: GROUP, topicId: TOPIC, agentName: "research", goal: "Route" });
    await updateGoal(KEY, { status: "paused" });
    const { goalId } = await card(ctx);
    const path = `${ctx.origin}/api/conversations/topic-${TOPIC}/goal`;
    const body = JSON.stringify({ action: "stop", goalId });

    expect((await realFetch(path)).status).toBe(401);
    expect((await realFetch(path, { method: "POST", headers: { origin: ctx.origin }, body })).status).toBe(401);
    expect((await realFetch(path, { method: "POST", headers: { cookie: ctx.cookie, origin: "http://evil.example" }, body })).status).toBe(403);
    expect((await realFetch(path, { method: "POST", headers: { cookie: ctx.cookie }, body })).status).toBe(403);
    expect((await press(ctx, "topic-999999", "stop", goalId)).status).toBe(404);
    expect((await press(ctx, `topic-${TOPIC}`, "loeschen", goalId)).status).toBe(400);
    expect((await press(ctx, `topic-${TOPIC}`, "stop", "1")).status).toBe(400);
    expect((await press(ctx, `topic-${TOPIC}`, "stop", -1)).status).toBe(400);
    expect((await api(ctx, `/api/conversations/topic-${TOPIC}/goal`, { method: "PUT", body: {} })).status).toBe(405);
    // Nichts davon hat das Ziel berührt
    expect(await getGoal(KEY)).toBeDefined();
    // Terminal mit Schlüssel darf ohne Origin
    expect((await press(ctx, `topic-${TOPIC}`, "stop", goalId, true)).status).toBe(200);
    expect(await getGoal(KEY)).toBeUndefined();
  });

  test("ältere Web-Gespräche: keine Karte, Knöpfe veraltet", async () => {
    const ctx = await start();
    expect(await card(ctx, ctx.webId)).toBeNull();
    const res = await press(ctx, ctx.webId, "stop", 1);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ stale: true, card: null });
    // /goal im älteren Web-Gespräch: Hinweis, kein Ziel
    expect((await post(ctx, ctx.webId, "/goal X")).status).toBe(202);
  });
});
