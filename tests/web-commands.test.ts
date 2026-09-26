/**
 * Slash-Befehle aus Browser und Terminal (Issue #74): echter Web-Server,
 * echter Befehls-Port (createBotCommands) mit dem echten Register, echter
 * Telegram-Turn, echte Telegram-Quelle und echter Nachrichten-Feed
 * (createTelegramLiveFeed). Nur Claude, Telegram, der Nachrichtenspeicher
 * und die Dienste hinter den Befehlen sind Attrappen; src/bot.ts wird nie
 * geladen.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addAgentOverride, getAgentOverrides, setAgentOverridesPath } from "../src/lib/agent-overrides";
import { commandRegistry, HELP_TEXT } from "../src/lib/commands/builtin";
import { createCommandRegistry } from "../src/lib/commands/registry";
import type { CommandServices, RoutineSession, SynthesizedAudio } from "../src/lib/commands/types";
import type { MessageSavedListener } from "../src/lib/convex";
import { authorizeTool, setToolApprovalHandler, type BuiltinTool } from "../src/lib/tools/registry";
import { ABORT_REPLY } from "../src/lib/chat-turn";
import { declareCredential } from "../src/lib/credentials";
import { learnFromSource } from "../src/lib/learn";
import { resetSupabaseClient } from "../src/lib/supabase";
import { abortAllExecutions, abortExecutions, blockExecutions, currentExecution, isExecutionActive } from "../src/lib/execution-context";
import type { SendAndRecordInput } from "../src/lib/outbox";
import type { HistoryRow } from "../src/lib/supabase";
import { ABORTED_TEXT, type RunTurnOptions, type TurnResult, type WebChat } from "../src/web/chat";
import { createBotCommands } from "../src/web/bot-commands";
import { createTelegramLiveFeed, createTelegramSource } from "../src/web/bot-telegram";
import {
  conversationSessionKey,
  createApprovalTurns,
  createBotChat,
  createTelegramChat,
  MIRROR_FAILED_TEXT,
  type ApprovalTurns,
  type BotChat,
  type WebSavedMessage,
} from "../src/web/bot-turn";
import { getChoice, onChoiceChange, setChoicesFileForTests } from "../src/lib/choices";
import { createTelegramChoices } from "../src/lib/telegram-choices";
import { createChoiceToolApproval, type ChoiceToolApproval } from "../src/lib/tool-approval";
import { createWebServer, type WebServer } from "../src/web/server";
import { createConversationSessionReset, type SessionResetResult } from "../src/web/session-reset";
import { ConversationStore } from "../src/web/store";
import { ApiClient } from "../src/terminal/api";
import { runChatApp } from "../src/terminal/app";
import { FakeStdin, FakeStdout } from "./terminal-fixture";
import { htmlFixture, mp3FrameFixture, mp3Id3Fixture, oggOpusFixture, svgFixture, wavFixture } from "./audio-fixture";
import { createVoiceSynthesis } from "../src/lib/voice-message";

const PASSWORD = "test-passwort-lang";
const GROUP = "-1001234567890";
const USER = "4711";
const root = await mkdtemp(join(tmpdir(), "tybo-web-commands-"));
let counter = 0;
afterAll(() => rm(root, { recursive: true, force: true }));

const servers: WebServer[] = [];
afterEach(async () => {
  abortAllExecutions();
  setAgentOverridesPath();
  for (const s of servers.splice(0)) await s.stop();
});

/** Claude, das bis zum Abbruch arbeitet und dann wie der Chat-Kern ABORT_REPLY liefert */
function untilAborted(): Promise<string> {
  const signal = currentExecution()!.controller.signal;
  return new Promise(resolve => signal.addEventListener("abort", () => resolve(ABORT_REPLY), { once: true }));
}

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

/** Web-Chat für ältere Web-Gespräche: jeder Turn wartet, bis der Test ihn beendet */
class FakeWebChat implements WebChat {
  calls: RunTurnOptions[] = [];
  private pending = new Map<string, (r: TurnResult) => void>();
  runTurn(opts: RunTurnOptions): Promise<TurnResult> {
    this.calls.push(opts);
    return new Promise(resolve => this.pending.set(opts.conversationId, resolve));
  }
  stop(id: string) {
    this.pending.get(id)?.({ text: "", aborted: true });
    this.pending.delete(id);
  }
  finish(id: string, text: string) {
    this.pending.get(id)?.({ text });
    this.pending.delete(id);
  }
}

interface Ctx {
  origin: string;
  cookie: string;
  bearer: string;
  server: WebServer;
  saved: WebSavedMessage[];
  rows: HistoryRow[];
  plain: { chatId: string; text: string; threadId?: number }[];
  records: SendAndRecordInput[];
  agentSends: { agent: string; chatId: string; text: string; threadId?: number }[];
  prompts: { agent: string; text: string; chatId: string; topicId?: number }[];
  resets: string[];
  paused: string[];
  aborts: string[];
  webChat: FakeWebChat;
  store: ConversationStore;
  webId: string;
  /** Was Claude in einem Telegram-Turn tut; Standard: sofort antworten */
  core: () => Promise<string>;
  claudeStarted: number;
  mirrorFails: boolean;
  goalActive: boolean;
  resetResult: SessionResetResult;
  /** Vor jedem Spiegel-Teil abgewartet (Standard: sofort) */
  mirrorGate: () => Promise<void>;
  /** Vor jedem Speichern im Nachrichtenspeicher abgewartet (Standard: sofort) */
  saveGate: () => Promise<void>;
  /** Vor jedem Reset der Attrappe abgewartet (Standard: sofort) */
  resetGate: () => Promise<void>;
  learn: (input: string, onWriteStart?: () => void) => Promise<{ message: string }>;
  sessions: RoutineSession[];
  createRoutine: () => Promise<{ isError?: boolean; text?: string }>;
  /** Nur mit realWebChat: echter Web-Chat samt Freigabeablauf */
  botChat: BotChat;
  /** Laufende Turns für Werkzeug-Freigaben (Issue #116) */
  approvals: ApprovalTurns;
  /** Nur mit gatedOverrides: Anweisungen je Agent und Halt zwischen Schreibbeginn und Lesen/Schreiben */
  overrides: Record<string, string[]>;
  overrideGate: () => Promise<void>;
  /** /voice (Issue #78): Stimme eingerichtet, Synthese, gesendete Sprachnachrichten */
  voiceEnabled: boolean;
  synthesize: (text: string) => Promise<SynthesizedAudio | null>;
  synthCalls: string[];
  voiceSends: { chatId: string; fileName: string; threadId?: number; size: number }[];
  sendVoice: () => Promise<void>;
  /** Antworttexte, deren Merk-Tags verarbeitet wurden */
  intents: string[];
}

async function start(options: { realReset?: boolean; realWebChat?: boolean; gatedOverrides?: boolean } = {}): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  setAgentOverridesPath(join(dir, "agent-overrides.json"));
  const ctx = {
    approvals: createApprovalTurns(),
    saved: [],
    rows: [],
    plain: [],
    records: [],
    agentSends: [],
    prompts: [],
    resets: [],
    paused: [],
    aborts: [],
    claudeStarted: 0,
    mirrorFails: false,
    goalActive: false,
    resetResult: { status: "done", reset: 1, sessionMode: true },
  } as unknown as Ctx;
  ctx.core = async () => "Antwort";
  ctx.mirrorGate = async () => {};
  ctx.saveGate = async () => {};
  ctx.resetGate = async () => {};
  ctx.learn = async input => ({ message: `Gelernt: ${input}` });
  ctx.sessions = [];
  ctx.createRoutine = async () => ({ text: "" });
  ctx.overrides = {};
  ctx.overrideGate = async () => {};
  ctx.voiceEnabled = true;
  ctx.synthesize = async () => ({ audio: mp3Id3Fixture(), mime: "audio/mpeg", fileName: "antwort.mp3" });
  ctx.synthCalls = [];
  ctx.voiceSends = [];
  ctx.sendVoice = async () => {};
  ctx.intents = [];
  let rowCounter = 0;
  // Wie onMessageSaved in src/lib/convex.ts: jede gespeicherte Zeile geht an den echten Feed
  let savedHook: MessageSavedListener | null = null;
  const emitSaved = (row: HistoryRow) =>
    savedHook?.({ chatId: (row as any).chat_id, role: row.role as "user" | "assistant", content: row.content, metadata: row.metadata as Record<string, unknown>, createdAt: row.created_at });

  /** Wie Supabase: eigene Zeilen-ID, created_at in Speicherreihenfolge */
  function storeRow(chatId: string, role: "user" | "assistant", content: string, metadata: Record<string, unknown>, createdAt?: string): HistoryRow {
    const row = {
      id: `row-${++rowCounter}`,
      created_at: createdAt ?? new Date(Date.now() + rowCounter).toISOString(),
      role,
      content,
      metadata,
      chat_id: chatId,
    } as unknown as HistoryRow;
    ctx.rows.push(row);
    return row;
  }

  const saveMessage = async (m: WebSavedMessage) => {
    await ctx.saveGate();
    ctx.saved.push(m);
    await emitSaved(storeRow(m.chat_id, m.role, m.content, m.metadata ?? {}, m.created_at));
    return true;
  };
  const turnDeps = {
    runStreamingTurn: async (opts: { userMessage: string; agentName: string; chatId: string; topicId?: number }) => {
      ctx.claudeStarted++;
      ctx.prompts.push({ agent: opts.agentName, text: opts.userMessage, chatId: opts.chatId, topicId: opts.topicId });
      return ctx.core();
    },
    saveMessage,
    processIntents: async (text: string) => void ctx.intents.push(text),
    abortClaudeCalls: (key: string) => {
      ctx.aborts.push(key);
      return abortExecutions(key);
    },
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
  };
  const telegramDeps = {
    userId: USER,
    groupId: () => GROUP,
    agentForTopic: (topicId: number) => (topicId === 443 ? "finance" : undefined),
    sendPlain: async (chatId: string, text: string, threadId?: number) => {
      await ctx.mirrorGate();
      if (ctx.mirrorFails) throw new Error("Telegram weg");
      ctx.plain.push({ chatId, text, threadId });
    },
    sendAsAgent: async (agent: string, chatId: string, text: string, threadId?: number) => {
      ctx.agentSends.push({ agent, chatId, text, threadId });
    },
  };
  // Dieselben Freigabe-Turns wie Befehle und Web-Chat, wie in src/bot.ts
  const telegramChat = createTelegramChat({ ...turnDeps, ...telegramDeps, approvals: ctx.approvals });

  const known = ["general", "research", "finance", "critic"];
  // Wie die Schreibkette in src/lib/agent-overrides.ts: der Schreibbeginn läuft vor dem
  // Lesen, Lesen und Schreiben am Stück; ctx.overrideGate hält sie dazwischen an
  let overrideChain: Promise<unknown> = Promise.resolve();
  function inOverrideChain<T>(onWriteStart: (() => void) | undefined, fn: (list: string[]) => T, agent: string): Promise<T> {
    const run = overrideChain
      .catch(() => {})
      .then(async () => {
        onWriteStart?.();
        await ctx.overrideGate();
        const list = [...(ctx.overrides[agent] ?? [])];
        const result = fn(list);
        ctx.overrides[agent] = list;
        return result;
      });
    overrideChain = run;
    return run;
  }
  const gated: Partial<CommandServices> = options.gatedOverrides
    ? {
        getAgentOverrides: agent => ctx.overrides[agent] ?? [],
        addAgentOverride: (agent, text, start) => inOverrideChain(start, list => list.push(text), agent),
        removeLastAgentOverride: (agent, start) => inOverrideChain(start, list => list.pop(), agent),
        clearAgentOverrides: (agent, start) => inOverrideChain(start, list => list.splice(0).length, agent),
      }
    : {};
  const services: CommandServices = {
    isSessionModeEnabled: () => true,
    getGoal: async () => (ctx.goalActive ? { status: "active" } : undefined),
    pauseGoal: async key => void ctx.paused.push(key),
    abortClaudeCalls: key => turnDeps.abortClaudeCalls(key),
    listAllOverrides: () => ({}),
    listAgentNames: () => known,
    resolveAgentName: raw => (known.includes(raw.toLowerCase()) ? raw.toLowerCase() : undefined),
    getAgentOverrides,
    clearAgentOverrides: async () => 0,
    removeLastAgentOverride: async () => undefined,
    addAgentOverride,
    topicMapping: () => ({ "443": "finance" }),
    topicNames: async () => ({ "443": "Finanzen" }),
    listGoals: async () => "- Buch fertig",
    learn: (input, onWriteStart) => ctx.learn(input, onWriteStart),
    formatPlan: async () => "Plan",
    sessionsForKey: async () => ctx.sessions,
    createRoutine: () => ctx.createRoutine(),
    ...gated,
  };
  if (options.realWebChat) ctx.botChat = createBotChat({ ...turnDeps, approvals: ctx.approvals });
  const commands = createBotCommands({
    ...turnDeps,
    ...telegramDeps,
    registry: commandRegistry,
    services,
    ...(options.realWebChat ? { withApprovals: ctx.botChat.withApprovals } : {}),
    approvals: ctx.approvals,
    voice: {
      enabled: () => ctx.voiceEnabled,
      synthesize: text => (ctx.synthCalls.push(text), ctx.synthesize(text)),
    },
    sendVoice: async (chatId, audio, fileName, threadId) => {
      await ctx.sendVoice();
      ctx.voiceSends.push({ chatId, fileName, threadId, size: audio.length });
    },
    // wie src/lib/outbox.ts: senden, dann als Meldung festhalten (Nachrichten-Feed meldet sie live)
    sendAndRecord: async input => {
      ctx.records.push(input);
      const topicId = input.topicId;
      const chatId = topicId === undefined ? USER : GROUP;
      const metadata: Record<string, unknown> = { display_only: true, source: input.source, msgId: crypto.randomUUID() };
      if (topicId !== undefined && topicId !== 1) metadata.topicId = topicId;
      await emitSaved(storeRow(chatId, "assistant", input.text!, metadata));
      return { sent: true, recorded: true };
    },
    resetConversation: options.realReset
      ? // Echter Reset-Baustein mit echter Ausführungssperre; ctx.resets bekommt die Schlüssel
        createConversationSessionReset({
          sessionKey: id => conversationSessionKey(id, telegramDeps),
          isActive: isExecutionActive,
          block: blockExecutions,
          sessionsForKey: async () => [],
          shouldDistill: () => false,
          distill: async () => {},
          reset: async key => (ctx.resets.push(key), 1),
          sessionModeEnabled: () => true,
        })
      : async id => {
          await ctx.resetGate();
          ctx.resets.push(id);
          return ctx.resetResult;
        },
  });
  const telegram = createTelegramSource({
    userId: USER,
    groupId: () => GROUP,
    topicNames: async () => ({ "443": "Finanzen" }),
    topicMapping: () => ({ "443": "finance" }),
    history: async (chatId, topicId) =>
      ctx.rows.filter(r => (r as any).chat_id === chatId && ((r.metadata as any)?.topicId ?? null) === topicId),
    activity: async () => [],
    log: () => {},
  });
  ctx.store = new ConversationStore({ dir: join(dir, "web") });
  await ctx.store.load();
  ctx.webId = (await ctx.store.createConversation("research")).id;
  ctx.webChat = new FakeWebChat();
  const tokenFile = join(dir, "cli-token");
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "web-sessions.json"),
      conversationStore: ctx.store,
      cliTokenFile: tokenFile,
      chat: options.realWebChat ? ctx.botChat : ctx.webChat,
      telegram,
      telegramChat,
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
  const res = await fetch(`${ctx.origin}/api/login`, {
    method: "POST",
    headers: { origin: ctx.origin },
    body: JSON.stringify({ password: PASSWORD }),
  });
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

function post(ctx: Ctx, id: string, text: string, terminal = false) {
  return api(ctx, `/api/conversations/${id}/messages`, { method: "POST", body: { text }, terminal });
}

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
    /** Wartet auf das Ende des Befehls: status running false nach dem ersten Ereignis */
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

describe("Unbekannte Befehle gehen als Text an Claude", () => {
  test("/k3 x und /foo im Topic: normaler Turn mit dem Text, kein Befehl", async () => {
    const ctx = await start();
    for (const text of ["/k3 x", "/foo", "/newspaper lesen"]) {
      const sse = await listen(ctx, "topic-443");
      const res = await post(ctx, "topic-443", text);
      expect(res.status).toBe(202);
      expect((await res.json()).command).toBeUndefined();
      await sse.settled();
      await sse.close();
    }
    expect(ctx.prompts.map(p => [p.agent, p.text])).toEqual([
      ["finance", "/k3 x"],
      ["finance", "/foo"],
      ["finance", "/newspaper lesen"],
    ]);
    expect(ctx.records).toEqual([]);
    expect(ctx.resets).toEqual([]);
  });

  test("/foo im älteren Web-Gespräch und aus dem Terminal: an den Chat", async () => {
    const ctx = await start();
    expect((await post(ctx, ctx.webId, "/foo")).status).toBe(202);
    await waitUntil(() => ctx.webChat.calls.length === 1);
    expect(ctx.webChat.calls[0].text).toBe("/foo");
    ctx.webChat.finish(ctx.webId, "ok");
    expect((await post(ctx, "dm", "/k3 x", true)).status).toBe(202);
    await waitUntil(() => ctx.prompts.length === 1);
    expect(ctx.prompts[0]).toMatchObject({ agent: "general", text: "/k3 x" });
    expect(ctx.plain.at(-1)).toEqual({ chatId: USER, text: "Du (Terminal): /k3 x", threadId: undefined });
  });
});

describe("/new aus dem Browser", () => {
  test("setzt die Session des Gesprächs zurück, erscheint in Telegram, Antwort als Meldung (live und nach Neuladen genau einmal)", async () => {
    const ctx = await start();
    const sse = await listen(ctx, "topic-443");
    const res = await post(ctx, "topic-443", "/new");
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({ command: "new", running: true, message: { role: "user", text: "/new" } });
    await sse.settled();
    await sse.close();

    // Wirkung: Session-Reset genau dieses Gesprächs, kein Claude-Turn
    expect(ctx.resets).toEqual(["topic-443"]);
    expect(ctx.claudeStarted).toBe(0);
    // Telegram: Spiegelung vom Haupt-Bot, dann die Antwort als Meldung im selben Topic
    expect(ctx.plain).toEqual([{ chatId: GROUP, text: "Du (Web): /new", threadId: 443 }]);
    expect(ctx.records).toEqual([
      { text: "Session zurueckgesetzt. Die naechste Nachricht startet mit frischem Kontext.", topicId: 443, source: "befehl", format: "plain" },
    ]);
    // Nutzernachricht wie ein Befehl aus Telegram gespeichert, mit der ID aus dem POST
    expect(ctx.saved).toEqual([
      {
        chat_id: GROUP,
        role: "user",
        content: "/new",
        metadata: { channel: "web", topicId: 443, msgId: body.message.id },
        created_at: body.message.createdAt,
      },
    ]);

    // Live: Nutzernachricht und Meldung, kein Fehler, keine Agenten-Antwort
    const live = sse.events.filter(e => e.event === "message" || e.event === "error").map(e => e.data);
    expect(live.map((m: any) => [m.role, m.kind ?? null])).toEqual([
      ["user", null],
      ["assistant", "notice"],
    ]);
    expect(live[1]).toMatchObject({ source: "befehl", text: "Session zurueckgesetzt. Die naechste Nachricht startet mit frischem Kontext." });
    expect(sse.events.some(e => e.event === "error")).toBe(false);

    // Nach dem Neuladen: dieselben zwei Einträge, jeweils einmal
    const history = await (await api(ctx, "/api/conversations/topic-443/messages")).json();
    expect(history.messages.map((m: any) => [m.id, m.role, m.kind ?? null])).toEqual([
      [body.message.id, "user", null],
      [live[1].id, "assistant", "notice"],
    ]);
    expect(history.running).toBe(false);
  });

  test("im Direktchat: Spiegelung und Meldung im Direktchat", async () => {
    const ctx = await start();
    const sse = await listen(ctx, "dm");
    await post(ctx, "dm", "/reset");
    await sse.settled();
    await sse.close();
    expect(ctx.resets).toEqual(["dm"]);
    expect(ctx.plain).toEqual([{ chatId: USER, text: "Du (Web): /reset", threadId: undefined }]);
    expect(ctx.records[0]).toMatchObject({ source: "befehl" });
    expect(ctx.records[0].topicId).toBeUndefined();
  });

  test("während einer laufenden Antwort: 409, nichts gespiegelt, nichts zurückgesetzt", async () => {
    const ctx = await start();
    let release!: () => void;
    ctx.core = () => new Promise(resolve => (release = () => resolve("fertig")));
    await post(ctx, "topic-443", "Lange Frage");
    await waitUntil(() => ctx.claudeStarted === 1);
    const res = await post(ctx, "topic-443", "/new");
    expect(res.status).toBe(409);
    expect(ctx.resets).toEqual([]);
    expect(ctx.plain.map(p => p.text)).toEqual(["Du (Web): Lange Frage"]);
    release();
  });

  test("Spiegeln scheitert: keine Wirkung, Fehler im Verlauf", async () => {
    const ctx = await start();
    ctx.mirrorFails = true;
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "/new");
    await sse.settled();
    await sse.close();
    expect(ctx.resets).toEqual([]);
    expect(ctx.records).toEqual([]);
    expect(ctx.saved).toEqual([]);
    expect(sse.events.find(e => e.event === "error")?.data.text).toBe(MIRROR_FAILED_TEXT);
  });

  test("Session gerade belegt: Hinweis statt Reset-Meldung", async () => {
    const ctx = await start();
    ctx.resetResult = { status: "busy" };
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "/new");
    await sse.settled();
    await sse.close();
    expect(ctx.records.map(r => r.text)).toEqual(["In diesem Gespräch läuft gerade eine Antwort. Erst /stop, dann /new."]);
  });
});

describe("/new mit dem echten Reset-Baustein", () => {
  test("scheitert nicht an der eigenen Sperre: Topic, General, Direktchat und älteres Web-Gespräch", async () => {
    const ctx = await start({ realReset: true });
    for (const id of ["topic-443", "topic-1", "dm", ctx.webId]) {
      const sse = await listen(ctx, id);
      expect((await post(ctx, id, "/new")).status).toBe(202);
      await sse.settled();
      await sse.close();
    }
    expect(ctx.resets).toEqual([`topic:${GROUP}:443`, `group:${GROUP}`, `dm:${USER}`, `web:${ctx.webId}`]);
    expect(ctx.records.map(r => r.text)).toEqual(Array(3).fill("Session zurueckgesetzt. Die naechste Nachricht startet mit frischem Kontext."));
    const web = await (await api(ctx, `/api/conversations/${ctx.webId}/messages`)).json();
    expect(web.messages.at(-1)).toMatchObject({ kind: "notice", text: "Session zurueckgesetzt. Die naechste Nachricht startet mit frischem Kontext." });
  });
});

describe("/agent aus Browser und Terminal", () => {
  test("/agent research: kürzer fügt die Anweisung hinzu", async () => {
    const ctx = await start();
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "/agent research: kürzer");
    await sse.settled();
    await sse.close();
    expect(getAgentOverrides("research")).toEqual(["kürzer"]);
    expect(ctx.records.map(r => r.text)).toEqual([
      'Gespeichert. Der research-Agent haelt sich ab jetzt an: "kürzer" (1 Anweisung aktiv).\n\nGilt ab der naechsten frischen Session, /new im betroffenen Topic erzwingt es sofort.',
    ]);
    expect(ctx.claudeStarted).toBe(0);
  });

  test("aus dem Terminal: gespiegelt als „Du (Terminal):“, Nachricht mit via terminal", async () => {
    const ctx = await start();
    const sse = await listen(ctx, "topic-443");
    const res = await post(ctx, "topic-443", "/agent finance: rechne in Euro", true);
    expect(res.status).toBe(202);
    await sse.settled();
    await sse.close();
    expect(getAgentOverrides("finance")).toEqual(["rechne in Euro"]);
    expect(ctx.plain).toEqual([{ chatId: GROUP, text: "Du (Terminal): /agent finance: rechne in Euro", threadId: 443 }]);
    expect(ctx.saved[0].metadata).toMatchObject({ channel: "web", via: "terminal" });
  });
});

describe("/stop bei laufender Arbeit", () => {
  test("geht sofort trotz laufender Antwort: bricht ab, pausiert das Ziel, Meldung", async () => {
    const ctx = await start();
    ctx.goalActive = true;
    ctx.core = untilAborted;
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "Lange Frage");
    await waitUntil(() => ctx.claudeStarted === 1);

    const res = await post(ctx, "topic-443", "/stop");
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.command).toBe("stop");
    // Beim Zurückkommen ist /stop schon ausgeführt
    expect(ctx.paused).toEqual([`topic:${GROUP}:443`]);
    expect(ctx.aborts).toContain(`topic:${GROUP}:443`);
    expect(ctx.plain.map(p => p.text)).toEqual(["Du (Web): Lange Frage", "Du (Web): /stop"]);
    expect(ctx.records.map(r => r.text)).toEqual(["⏹️ 1 laufende Verarbeitung abgebrochen, Ziel pausiert (/goal weiter setzt fort)."]);

    // Der abgebrochene Turn endet mit „Abgebrochen.“, danach läuft nichts mehr
    await waitUntil(() => sse.events.some(e => e.event === "error" && e.data.text === ABORTED_TEXT));
    await waitUntil(() => sse.events.at(-1)?.event === "status" && sse.events.at(-1)?.data.running === false);
    await sse.close();
    expect(ctx.agentSends).toEqual([]);
  });

  test("läuft nichts: Hinweis, running false in der Antwort", async () => {
    const ctx = await start();
    const res = await post(ctx, "topic-443", "/abbruch");
    const body = await res.json();
    expect(body).toMatchObject({ command: "stop", running: false });
    expect(ctx.records.map(r => r.text)).toEqual(["Hier laeuft gerade nichts, das ich abbrechen koennte."]);
  });

  test("im älteren Web-Gespräch: bricht den Turn ab (Schlüssel web:<id>)", async () => {
    const ctx = await start();
    await post(ctx, ctx.webId, "Frage");
    await waitUntil(() => ctx.webChat.calls.length === 1);
    const res = await post(ctx, ctx.webId, "/stop");
    expect(res.status).toBe(202);
    expect(ctx.aborts).toEqual([`web:${ctx.webId}`]);
    ctx.webChat.stop(ctx.webId);
  });
});

describe("Ältere Web-Gespräche: Meldungen im eigenen Verlauf, nichts gespiegelt", () => {
  test("/help: Meldung gespeichert, live und nach Neuladen genau einmal, keine Antwort, kein Fehler", async () => {
    const ctx = await start();
    const sse = await listen(ctx, ctx.webId);
    const res = await post(ctx, ctx.webId, "/help");
    expect(res.status).toBe(202);
    await sse.settled();
    await sse.close();
    const live = sse.events.filter(e => e.event === "message" || e.event === "error");
    expect(live).toHaveLength(1);
    expect(live[0].data).toMatchObject({ role: "assistant", kind: "notice", source: "befehl" });
    expect(live[0].data.text).toContain("tybo Spickzettel");
    expect(live[0].data.html).toContain("<strong>tybo Spickzettel</strong>");

    const history = await (await api(ctx, `/api/conversations/${ctx.webId}/messages`)).json();
    expect(history.messages.map((m: any) => [m.role, m.kind ?? null])).toEqual([
      ["user", null],
      ["assistant", "notice"],
    ]);
    expect(history.messages[1].id).toBe(live[0].data.id);
    expect(ctx.plain).toEqual([]);
    expect(ctx.records).toEqual([]);
    expect(ctx.webChat.calls).toEqual([]);
  });
});

describe("/critic: modellgestützt, aber kein normaler Nachrichten-Turn", () => {
  test("im Topic: Prompt an den Critic, Antwort gespeichert und vom Critic-Bot gesendet", async () => {
    const ctx = await start();
    ctx.core = async () => "Drei Risiken";
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "/critic Newsletter starten");
    await sse.settled();
    await sse.close();
    expect(ctx.prompts).toEqual([{ agent: "critic", text: "Newsletter starten", chatId: GROUP, topicId: 443 }]);
    expect(ctx.plain).toEqual([{ chatId: GROUP, text: "Du (Web): /critic Newsletter starten", threadId: 443 }]);
    expect(ctx.agentSends).toEqual([{ agent: "critic", chatId: GROUP, text: "Drei Risiken", threadId: 443 }]);
    expect(ctx.saved.map(m => [m.role, m.content, (m.metadata as any).agent ?? null])).toEqual([
      ["user", "/critic Newsletter starten", null],
      ["assistant", "Drei Risiken", "critic"],
    ]);
    expect(sse.events.some(e => e.event === "error")).toBe(false);
  });

  test("Stopp-Knopf bricht den Critic ab: „Abgebrochen.“", async () => {
    const ctx = await start();
    ctx.core = untilAborted;
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "/critic Idee");
    await waitUntil(() => ctx.claudeStarted === 1);
    const stop = await api(ctx, "/api/conversations/topic-443/stop", { method: "POST" });
    expect((await stop.json()).stopping).toBe(true);
    await sse.settled();
    await sse.close();
    expect(sse.events.find(e => e.event === "error")?.data.text).toBe(ABORTED_TEXT);
    expect(ctx.agentSends).toEqual([]);
  });
});

describe("/critic: Antwort live und nach Neuladen genau einmal (echter Feed)", () => {
  for (const id of ["topic-443", "dm"]) {
    test(`${id}: dieselbe ID live und im Verlauf`, async () => {
      const ctx = await start();
      ctx.core = async () => "Drei Risiken";
      const sse = await listen(ctx, id);
      const res = await post(ctx, id, "/critic Newsletter starten");
      const body = await res.json();
      await sse.settled();
      await sse.close();
      const live = sse.events.filter(e => e.event === "message" || e.event === "error").map(e => e.data);
      expect(live.map((m: any) => [m.role, m.text])).toEqual([
        ["user", "/critic Newsletter starten"],
        ["assistant", "Drei Risiken"],
      ]);
      expect(live[1]).toMatchObject({ agent: "critic", copyText: "Drei Risiken" });
      // Die ID der Live-Antwort ist die msgId im Nachrichtenspeicher
      const replyId = (ctx.saved.find(m => m.role === "assistant")!.metadata as any).msgId;
      expect(live[1].id).toBe(replyId);

      const history = await (await api(ctx, `/api/conversations/${id}/messages`)).json();
      expect(history.messages.map((m: any) => [m.id, m.role, m.text])).toEqual([
        [body.message.id, "user", "/critic Newsletter starten"],
        [replyId, "assistant", "Drei Risiken"],
      ]);
    });
  }
});

describe("Stopp wirkt auf den ganzen Befehlsablauf", () => {
  /** Dienst, der wie Aux-Arbeit bis zum Abbruch seines Ausführungskontexts läuft */
  function untilStopped(keys: string[], result: () => any) {
    return async () => {
      const execution = currentExecution();
      keys.push(execution?.key ?? "ohne Kontext");
      if (!execution) return result();
      await new Promise(resolve => execution.controller.signal.addEventListener("abort", resolve, { once: true }));
      return result();
    };
  }

  test("/learn: Stopp-Knopf bricht die Aux-Arbeit unter dem Topic-Schlüssel ab, keine Antwort danach", async () => {
    const ctx = await start();
    const keys: string[] = [];
    ctx.learn = untilStopped(keys, () => ({ message: "Gelernt" }));
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "/learn https://example.org");
    await waitUntil(() => keys.length === 1);
    expect(keys).toEqual([`topic:${GROUP}:443`]);
    const stop = await api(ctx, "/api/conversations/topic-443/stop", { method: "POST" });
    expect((await stop.json()).stopping).toBe(true);
    await sse.settled();
    await sse.close();
    expect(sse.events.find(e => e.event === "error")?.data.text).toBe(ABORTED_TEXT);
    // Nur der Zwischenstand vor dem Stopp, kein „Gelernt"
    expect(ctx.records.map(r => r.text)).toEqual(["📚 Ich lese die Quelle und destilliere sie in die Knowledge Base..."]);
  });

  test("/learn: /stop aus einem zweiten Aufruf erreicht die Aux-Arbeit", async () => {
    const ctx = await start();
    const keys: string[] = [];
    ctx.learn = untilStopped(keys, () => ({ message: "Gelernt" }));
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "/learn https://example.org");
    await waitUntil(() => keys.length === 1);
    const res = await post(ctx, "topic-443", "/stop", true);
    expect((await res.json()).command).toBe("stop");
    await waitUntil(() => sse.events.some(e => e.event === "error" && e.data.text === ABORTED_TEXT));
    await waitUntil(() => sse.events.at(-1)?.event === "status" && sse.events.at(-1)?.data.running === false);
    await sse.close();
    expect(ctx.records.map(r => r.text)).toEqual([
      "📚 Ich lese die Quelle und destilliere sie in die Knowledge Base...",
      "⏹️ 1 laufende Verarbeitung abgebrochen.",
    ]);
  });

  test("/routine: Strg+C im Terminal (Stopp mit lokalem Schlüssel) bricht die Destillation ab, keine Antwort danach", async () => {
    const ctx = await start();
    const keys: string[] = [];
    ctx.sessions = [{ claudeSessionId: "sitzung-1", lastActivity: 1 }];
    ctx.createRoutine = untilStopped(keys, () => ({ text: "Routine fertig" }));
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "/routine täglich", true);
    await waitUntil(() => keys.length === 1);
    expect(keys).toEqual([`topic:${GROUP}:443`]);
    const stop = await api(ctx, "/api/conversations/topic-443/stop", { method: "POST", terminal: true });
    expect((await stop.json()).stopping).toBe(true);
    await sse.settled();
    await sse.close();
    expect(sse.events.find(e => e.event === "error")?.data.text).toBe(ABORTED_TEXT);
    expect(ctx.records.map(r => r.text)).toEqual(["Ich friere den Ablauf dieser Session als Routine ein. Das kann ein paar Minuten dauern..."]);
  });

  test("/learn im älteren Web-Gespräch: Stopp-Knopf trifft den Schlüssel web:<id>", async () => {
    const ctx = await start();
    const keys: string[] = [];
    ctx.learn = untilStopped(keys, () => ({ message: "Gelernt" }));
    const sse = await listen(ctx, ctx.webId);
    await post(ctx, ctx.webId, "/learn https://example.org");
    await waitUntil(() => keys.length === 1);
    expect(keys).toEqual([`web:${ctx.webId}`]);
    await api(ctx, `/api/conversations/${ctx.webId}/stop`, { method: "POST" });
    await sse.settled();
    await sse.close();
    const history = await (await api(ctx, `/api/conversations/${ctx.webId}/messages`)).json();
    expect(history.messages.map((m: any) => m.text)).toEqual([
      "/learn https://example.org",
      "📚 Ich lese die Quelle und destilliere sie in die Knowledge Base...",
      ABORTED_TEXT,
    ]);
  });

  for (const text of ["/critic Idee", "/agent research: kürzer"]) {
    test(`Stopp während verzögerter Spiegelung (${text}): keine Wirkung, nichts gespeichert, kein Modellstart`, async () => {
      const ctx = await start();
      let release!: () => void;
      let mirroring = false;
      ctx.mirrorGate = () =>
        new Promise(resolve => {
          mirroring = true;
          release = resolve;
        });
      const sse = await listen(ctx, "topic-443");
      await post(ctx, "topic-443", text);
      await waitUntil(() => mirroring);
      const stop = await api(ctx, "/api/conversations/topic-443/stop", { method: "POST" });
      expect((await stop.json()).stopping).toBe(true);
      release();
      await sse.settled();
      await sse.close();
      expect(sse.events.find(e => e.event === "error")?.data.text).toBe(ABORTED_TEXT);
      expect(ctx.claudeStarted).toBe(0);
      expect(ctx.saved).toEqual([]);
      expect(ctx.records).toEqual([]);
      expect(ctx.agentSends).toEqual([]);
      expect(getAgentOverrides("research")).toEqual([]);
    });
  }
});

describe("Stopp vor der Wirkung: Spiegelung und Speichern", () => {
  for (const text of ["/critic Idee", "/agent research: kürzer"]) {
    test(`/stop aus einem zweiten Aufruf während der ersten Spiegelung (${text}): kein Modellstart, keine Anweisung`, async () => {
      const ctx = await start();
      let release!: () => void;
      let held = false;
      // Nur die erste Spiegelung anhalten; die von /stop geht sofort durch
      ctx.mirrorGate = () =>
        held
          ? Promise.resolve()
          : new Promise(resolve => {
              held = true;
              release = resolve;
            });
      const sse = await listen(ctx, "topic-443");
      await post(ctx, "topic-443", text);
      await waitUntil(() => held);
      const res = await post(ctx, "topic-443", "/stop");
      expect((await res.json()).command).toBe("stop");
      // /stop ist beim Zurückkommen vollständig ausgeführt und hat den Befehl erreicht
      expect(ctx.aborts).toEqual([`topic:${GROUP}:443`]);
      expect(ctx.records.map(r => r.text)).toEqual(["⏹️ 1 laufende Verarbeitung abgebrochen."]);
      release();
      await waitUntil(() => sse.events.some(e => e.event === "error" && e.data.text === ABORTED_TEXT));
      await waitUntil(() => sse.events.at(-1)?.event === "status" && sse.events.at(-1)?.data.running === false);
      await sse.close();
      expect(ctx.claudeStarted).toBe(0);
      expect(ctx.agentSends).toEqual([]);
      expect(getAgentOverrides("research")).toEqual([]);
      // Gespeichert ist nur die /stop-Nachricht, nicht der abgebrochene Befehl
      expect(ctx.saved.map(m => m.content)).toEqual(["/stop"]);
      expect(ctx.records.map(r => r.text)).toEqual(["⏹️ 1 laufende Verarbeitung abgebrochen."]);
    });
  }

  test("/new: Stopp-Knopf während der Speicherung der Nutzernachricht, danach kein Reset", async () => {
    const ctx = await start();
    let release!: () => void;
    let saving = false;
    ctx.saveGate = () =>
      new Promise(resolve => {
        saving = true;
        release = resolve;
      });
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "/new");
    await waitUntil(() => saving);
    const stop = await api(ctx, "/api/conversations/topic-443/stop", { method: "POST" });
    expect((await stop.json()).stopping).toBe(true);
    release();
    await sse.settled();
    await sse.close();
    expect(sse.events.find(e => e.event === "error")?.data.text).toBe(ABORTED_TEXT);
    expect(ctx.resets).toEqual([]);
    expect(ctx.records).toEqual([]);
  });

  test("/new: nach Beginn des Resets greift der Stopp-Knopf nicht mehr, Meldung statt „Abgebrochen.“", async () => {
    const ctx = await start();
    let release!: () => void;
    let resetting = false;
    ctx.resetGate = () =>
      new Promise(resolve => {
        resetting = true;
        release = resolve;
      });
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "/new");
    await waitUntil(() => resetting);
    const stop = await api(ctx, "/api/conversations/topic-443/stop", { method: "POST" });
    expect((await stop.json()).stopping).toBe(false);
    release();
    await sse.settled();
    await sse.close();
    expect(ctx.resets).toEqual(["topic-443"]);
    expect(sse.events.some(e => e.event === "error")).toBe(false);
    expect(ctx.records.map(r => r.text)).toEqual(["Session zurueckgesetzt. Die naechste Nachricht startet mit frischem Kontext."]);
  });
});

describe("/agent: Stopp und Schreibbeginn in der Schreibkette", () => {
  /** Hält die Schreibkette nach dem Schreibbeginn an, bis release() */
  function holdWrites(ctx: Ctx) {
    const state = { held: false, release: () => {} };
    ctx.overrideGate = () =>
      new Promise<void>(resolve => {
        state.held = true;
        state.release = resolve;
      });
    return state;
  }

  const cases = [
    { text: "/agent research: kürzer", before: [], after: ["kürzer"], reply: 'Gespeichert. Der research-Agent haelt sich ab jetzt an: "kürzer"' },
    { text: "/agent research undo", before: ["a", "b"], after: ["a"], reply: 'Entfernt: "b"' },
    { text: "/agent research reset", before: ["a", "b"], after: [], reply: "Alle 2 Anpassungen fuer research geloescht." },
  ];

  for (const c of cases) {
    test(`${c.text}: Stopp-Knopf nach Schreibbeginn greift nicht, Ergebnis sichtbar statt „Abgebrochen.“`, async () => {
      const ctx = await start({ gatedOverrides: true });
      ctx.overrides.research = [...c.before];
      const gate = holdWrites(ctx);
      const sse = await listen(ctx, "topic-443");
      await post(ctx, "topic-443", c.text);
      await waitUntil(() => gate.held);
      const stop = await api(ctx, "/api/conversations/topic-443/stop", { method: "POST" });
      expect((await stop.json()).stopping).toBe(false);
      gate.release();
      await sse.settled();
      await sse.close();
      expect(ctx.overrides.research).toEqual(c.after);
      expect(sse.events.some(e => e.event === "error")).toBe(false);
      expect(ctx.records).toHaveLength(1);
      expect(ctx.records[0].text).toStartWith(c.reply);
    });

    test(`${c.text}: /stop aus einem zweiten Aufruf nach Schreibbeginn, Ergebnis sichtbar statt „Abgebrochen.“`, async () => {
      const ctx = await start({ gatedOverrides: true });
      ctx.overrides.research = [...c.before];
      const gate = holdWrites(ctx);
      const sse = await listen(ctx, "topic-443");
      await post(ctx, "topic-443", c.text);
      await waitUntil(() => gate.held);
      const res = await post(ctx, "topic-443", "/stop");
      expect((await res.json()).command).toBe("stop");
      expect(ctx.aborts).toEqual([`topic:${GROUP}:443`]);
      gate.release();
      await waitUntil(() => ctx.records.length === 2);
      await waitUntil(() => sse.events.at(-1)?.event === "status" && sse.events.at(-1)?.data.running === false);
      await sse.close();
      expect(ctx.overrides.research).toEqual(c.after);
      expect(sse.events.some(e => e.event === "error" && e.data.text === ABORTED_TEXT)).toBe(false);
      expect(ctx.records[0].text).toBe("⏹️ 1 laufende Verarbeitung abgebrochen.");
      expect(ctx.records[1].text).toStartWith(c.reply);
    });
  }

  for (const via of ["Stopp-Knopf", "/stop"]) {
    test(`${via} vor dem Schreibbeginn (wartet in der Schreibkette): nichts geschrieben, „Abgebrochen.“`, async () => {
      const ctx = await start({ gatedOverrides: true });
      ctx.overrides.research = ["a"];
      const gate = holdWrites(ctx);
      // Der Direktchat belegt die Schreibkette, das Topic wartet dahinter
      await post(ctx, "dm", "/agent finance: in Euro");
      await waitUntil(() => gate.held);
      const firstRelease = gate.release;
      const sse = await listen(ctx, "topic-443");
      await post(ctx, "topic-443", "/agent research reset");
      await waitUntil(() => ctx.saved.some(m => m.content === "/agent research reset"));
      if (via === "/stop") {
        await post(ctx, "topic-443", "/stop");
        expect(ctx.aborts).toEqual([`topic:${GROUP}:443`]);
      } else {
        const stop = await api(ctx, "/api/conversations/topic-443/stop", { method: "POST" });
        expect((await stop.json()).stopping).toBe(true);
      }
      ctx.overrideGate = async () => {};
      firstRelease();
      await waitUntil(() => sse.events.some(e => e.event === "error" && e.data.text === ABORTED_TEXT));
      await waitUntil(() => sse.events.at(-1)?.event === "status" && sse.events.at(-1)?.data.running === false);
      await sse.close();
      expect(ctx.overrides.research).toEqual(["a"]);
      expect(ctx.overrides.finance).toEqual(["in Euro"]);
      expect(ctx.records.some(r => r.text.includes("research"))).toBe(false);
    });
  }
});

describe("/learn: Stopp beendet den URL-Abruf", () => {
  const realFetch = globalThis.fetch;
  const auxBefore = process.env.AUX_MODEL_REVIEW;
  const keyBefore = process.env.FIRECRAWL_API_KEY;
  const firecrawlSpec = {
    name: "FIRECRAWL_API_KEY",
    usedBy: ["firecrawl_scrape", "firecrawl_search"],
    sources: [{ type: "env" as const }, { type: "claudeJsonMcpEnv" as const, server: "firecrawl" }],
  };
  afterEach(() => {
    globalThis.fetch = realFetch;
    if (auxBefore === undefined) delete process.env.AUX_MODEL_REVIEW;
    else process.env.AUX_MODEL_REVIEW = auxBefore;
    if (keyBefore === undefined) delete process.env.FIRECRAWL_API_KEY;
    else process.env.FIRECRAWL_API_KEY = keyBefore;
    declareCredential(firecrawlSpec);
  });

  /**
   * Alle Abrufe nach außen gehen an eine Attrappe: Firecrawl antwortet wie
   * angegeben, alles andere (direkter Abruf, Aux-Modell, Speichern) hängt bis
   * zum Abbruch seines Signals. Der Web-Server des Tests bleibt echt.
   */
  function fakeHttp(ctx: Ctx, firecrawl: "hang" | "fail") {
    const calls: string[] = [];
    // Aux-Arbeit über HTTP (Ollama) statt Claude-CLI: würde sie starten, stünde sie in calls
    process.env.AUX_MODEL_REVIEW = "ollama:test-modell";
    process.env.FIRECRAWL_API_KEY = "test-schluessel";
    declareCredential(firecrawlSpec);
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(ctx.origin)) return realFetch(input, init);
      calls.push(url);
      if (firecrawl === "fail" && url.startsWith("https://api.firecrawl.dev/")) return Promise.resolve(new Response("kaputt", { status: 500 }));
      return new Promise<Response>((_, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }) as typeof fetch;
    ctx.learn = (input, onWriteStart) => learnFromSource(input, onWriteStart);
    return calls;
  }

  for (const [firecrawl, expected] of [
    ["hang", ["https://api.firecrawl.dev/v2/scrape"]],
    ["fail", ["https://api.firecrawl.dev/v2/scrape", "https://example.org/artikel"]],
  ] as const) {
    test(`${firecrawl === "hang" ? "Firecrawl hängt" : "Firecrawl scheitert, direkter Abruf hängt"}: Stopp beendet ihn, Gespräch frei, nichts danach`, async () => {
      const ctx = await start();
      const calls = fakeHttp(ctx, firecrawl);
      const sse = await listen(ctx, "topic-443");
      await post(ctx, "topic-443", "/learn https://example.org/artikel");
      await waitUntil(() => calls.length === expected.length);
      const stop = await api(ctx, "/api/conversations/topic-443/stop", { method: "POST" });
      expect((await stop.json()).stopping).toBe(true);
      // Zeitnah: weit unter den Fristen von 30 und 60 Sekunden
      await waitUntil(() => sse.events.some((e, i) => i > 0 && e.event === "status" && e.data.running === false), 1000);
      expect(sse.events.find(e => e.event === "error")?.data.text).toBe(ABORTED_TEXT);
      await Bun.sleep(50);
      await sse.close();
      // Kein Fallback, keine Aux-Arbeit, kein Speichern
      expect(calls).toEqual([...expected]);
      expect(ctx.records.map(r => r.text)).toEqual(["📚 Ich lese die Quelle und destilliere sie in die Knowledge Base..."]);
      // Das Gespräch ist wieder frei
      globalThis.fetch = realFetch;
      expect((await post(ctx, "topic-443", "Nächste Frage")).status).toBe(202);
    });
  }
});

describe("/learn: Stopp und Schreibbeginn beim Speichern in der Knowledge Base", () => {
  const realFetch = globalThis.fetch;
  const envBefore = {
    AUX_MODEL_REVIEW: process.env.AUX_MODEL_REVIEW,
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    CONVEX_URL: process.env.CONVEX_URL,
  };
  afterEach(() => {
    globalThis.fetch = realFetch;
    for (const [key, value] of Object.entries(envBefore)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSupabaseClient();
  });

  const TEXT = "/learn " + "Die Knowledge Base speichert destillierte Quellen als kompakte Einträge für alle Agenten. ".repeat(2);
  const REPLY = "📚 Gelernt und gespeichert (reference):\n**Testeintrag**";

  /**
   * Echter learnFromSource mit eingefügtem Text: das Aux-Modell (Ollama) und
   * Supabase (echter Client) sind Attrappen hinter globalThis.fetch. Das
   * Aux-Modell antwortet erst nach aux.release(), die Datenbank erst nach
   * db.release(); stored zählt die Schreibanfragen an die Knowledge Base.
   */
  function fakeBackends(ctx: Ctx) {
    process.env.AUX_MODEL_REVIEW = "ollama:test-modell";
    process.env.SUPABASE_URL = "http://supabase.test";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "test-service-key";
    delete process.env.CONVEX_URL;
    resetSupabaseClient();
    const hold = () => {
      const state = { held: false, release: () => {}, wait: () => Promise.resolve() };
      state.wait = () =>
        new Promise<void>(resolve => {
          state.held = true;
          state.release = resolve;
        });
      return state;
    };
    const state = { aux: hold(), db: hold(), stored: 0 };
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.startsWith(ctx.origin)) return realFetch(input, init);
      if (url.startsWith("http://localhost:11434/")) {
        // Hält auch nach einem Stopp an: erst die Freigabe entscheidet
        await state.aux.wait();
        const content = JSON.stringify({ title: "Testeintrag", category: "reference", content: "Kern der Quelle.", tags: ["test"] });
        return Response.json({ choices: [{ message: { content } }] });
      }
      if (url.startsWith("http://supabase.test/rest/v1/knowledge")) {
        state.stored++;
        await state.db.wait();
        return Response.json({ id: "k-1" }, { status: 201 });
      }
      return new Response("aus", { status: 503 });
    }) as typeof fetch;
    ctx.learn = (input, onWriteStart) => learnFromSource(input, onWriteStart);
    return state;
  }

  async function stopVia(ctx: Ctx, via: string): Promise<void> {
    if (via === "/stop") {
      const res = await post(ctx, "topic-443", "/stop");
      expect((await res.json()).command).toBe("stop");
      expect(ctx.aborts).toEqual([`topic:${GROUP}:443`]);
    } else {
      const stop = await api(ctx, "/api/conversations/topic-443/stop", { method: "POST" });
      // Nach dem Schreibbeginn nimmt der Server den Stopp nicht mehr an
      expect((await stop.json()).stopping).toBe(false);
    }
  }

  for (const via of ["Stopp-Knopf", "/stop"]) {
    test(`${via} bei angehaltener Datenbankantwort: gespeichert, Ergebnis sichtbar statt „Abgebrochen.“`, async () => {
      const ctx = await start();
      const backends = fakeBackends(ctx);
      // Aux-Modell antwortet sofort
      backends.aux.wait = () => Promise.resolve();
      const sse = await listen(ctx, "topic-443");
      await post(ctx, "topic-443", TEXT);
      await waitUntil(() => backends.db.held);
      await stopVia(ctx, via);
      backends.db.release();
      await waitUntil(() => ctx.records.some(r => r.text.startsWith(REPLY)));
      await waitUntil(() => sse.events.at(-1)?.event === "status" && sse.events.at(-1)?.data.running === false);
      await sse.close();
      expect(backends.stored).toBe(1);
      expect(sse.events.some(e => e.event === "error")).toBe(false);
      expect(ctx.records.map(r => r.text.split("\n")[0])).toEqual([
        "📚 Ich lese die Quelle und destilliere sie in die Knowledge Base...",
        ...(via === "/stop" ? ["⏹️ 1 laufende Verarbeitung abgebrochen."] : []),
        "📚 Gelernt und gespeichert (reference):",
      ]);
    });

    test(`${via} vor dem Schreibbeginn (Aux-Antwort angehalten): kein Eintrag, „Abgebrochen.“`, async () => {
      const ctx = await start();
      const backends = fakeBackends(ctx);
      const sse = await listen(ctx, "topic-443");
      await post(ctx, "topic-443", TEXT);
      await waitUntil(() => backends.aux.held);
      if (via === "/stop") {
        await post(ctx, "topic-443", "/stop");
        expect(ctx.aborts).toEqual([`topic:${GROUP}:443`]);
      } else {
        const stop = await api(ctx, "/api/conversations/topic-443/stop", { method: "POST" });
        expect((await stop.json()).stopping).toBe(true);
      }
      backends.aux.release();
      await waitUntil(() => sse.events.some(e => e.event === "error" && e.data.text === ABORTED_TEXT));
      await waitUntil(() => sse.events.at(-1)?.event === "status" && sse.events.at(-1)?.data.running === false);
      await Bun.sleep(50);
      await sse.close();
      expect(backends.stored).toBe(0);
      expect(ctx.records.some(r => r.text.startsWith("📚 Gelernt"))).toBe(false);
    });
  }
});

describe("/critic im älteren Web-Gespräch: Werkzeug-Freigaben wie bei einem Web-Turn", () => {
  const tool: BuiltinTool = {
    name: "notiz_schreiben",
    description: "Schreibt eine Notiz",
    inputSchema: { type: "object", properties: {} },
    requiresApproval: true,
    isAvailable: () => true,
    handler: async () => "",
  };

  // Gemeinsamer Freigabe-Handler über das Register (Issue #116), wie in src/bot.ts
  let approval: ChoiceToolApproval | undefined;
  afterEach(() => {
    approval?.dispose();
    approval = undefined;
    setToolApprovalHandler(null);
    setChoicesFileForTests(null);
  });

  async function askedCritic() {
    setChoicesFileForTests(join(root, `critic-choices-${Date.now()}-${Math.random()}.json`));
    const ctx = await start({ realWebChat: true });
    approval = createChoiceToolApproval({ sendChoice: async () => ({ sent: true }), presenter: key => ctx.approvals.presenter(key), log: () => {} });
    setToolApprovalHandler(approval.handler);
    ctx.core = async () => ((await authorizeTool(tool, { text: "x" })) ? "abgelehnt" : "erlaubt");
    const sse = await listen(ctx, ctx.webId);
    await post(ctx, ctx.webId, "/critic Idee");
    await waitUntil(() => sse.events.some(e => e.event === "status" && e.data.awaiting === true));
    const question = sse.events.find(e => e.event === "message" && e.data.role === "assistant")!.data;
    expect(question.text).toContain("Freigabe nötig: Werkzeug notiz_schreiben");
    const approvalId = sse.events.find(e => e.event === "status" && e.data.awaiting)!.data.approvalId as string;
    expect((await getChoice(approvalId))?.kind).toBe("tool");
    return { ctx, sse, approvalId };
  }

  async function answer(ctx: Ctx, text: string, approvalId: string) {
    const res = await api(ctx, `/api/conversations/${ctx.webId}/messages`, { method: "POST", body: { text, approvalId } });
    expect(res.status).toBe(202);
  }

  test("Zustimmung: das Werkzeug läuft, Antwort des Critic", async () => {
    const { ctx, sse, approvalId } = await askedCritic();
    await answer(ctx, "ja", approvalId);
    await sse.settled();
    await sse.close();
    const last = sse.events.filter(e => e.event === "message").at(-1)!.data;
    expect(last).toMatchObject({ role: "assistant", text: "erlaubt", agent: "critic" });
    expect(sse.events.some(e => e.event === "error")).toBe(false);
  });

  test("Ablehnung: das Werkzeug läuft nicht", async () => {
    const { ctx, sse, approvalId } = await askedCritic();
    await answer(ctx, "nein", approvalId);
    await sse.settled();
    await sse.close();
    expect(sse.events.filter(e => e.event === "message").at(-1)!.data).toMatchObject({ text: "abgelehnt" });
  });

  test("„ja“ als Text im Terminal: über das Register mit Quelle terminal entschieden, Werkzeug frei", async () => {
    const { ctx, sse, approvalId } = await askedCritic();
    const client = new ApiClient({ base: ctx.origin.replace(/\/$/, ""), getToken: async () => ctx.bearer });
    const result = await client.send(ctx.webId, "ja", approvalId);
    expect(result.status).toBe("accepted");
    await sse.settled();
    await sse.close();
    expect(sse.events.filter(e => e.event === "message").at(-1)!.data).toMatchObject({ text: "erlaubt", agent: "critic" });
    expect((await getChoice(approvalId))!.result).toMatchObject({ key: "allow", via: "terminal" });
    // Dieselbe Antwort noch einmal: die Frage ist entschieden, nichts passiert
    expect((await client.send(ctx.webId, "ja", approvalId)).status).not.toBe("accepted");
  });

  test("Abbruch während der Rückfrage: abgelehnt, „Abgebrochen.“, keine Antwort", async () => {
    const { ctx, sse } = await askedCritic();
    const stop = await api(ctx, `/api/conversations/${ctx.webId}/stop`, { method: "POST" });
    expect((await stop.json()).stopping).toBe(true);
    await sse.settled();
    await sse.close();
    expect(sse.events.find(e => e.event === "error")?.data.text).toBe(ABORTED_TEXT);
    expect(sse.events.some(e => e.event === "message" && e.data.text === "abgelehnt")).toBe(false);
    expect(ctx.saved.some(m => m.role === "assistant")).toBe(false);
  });
});

describe("/critic im Telegram-Gespräch: Freigabe über die gemeinsamen Turns (PR #147)", () => {
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
    { id: "topic-443", key: `topic:${GROUP}:443`, conversation: { type: "telegram", chatId: GROUP, topicId: 443 } },
  ] as const;

  async function askedCritic(id: string) {
    setChoicesFileForTests(join(root, `critic-tg-choices-${Date.now()}-${Math.random()}.json`));
    const ctx = await start();
    const sentChoices: string[] = [];
    // Frage in Telegram (sendChoice), wie in src/bot.ts; im Browser nur der Status
    approval = createChoiceToolApproval({
      sendChoice: async choice => (sentChoices.push(choice.id), { sent: true }),
      presenter: key => ctx.approvals.presenter(key),
      log: () => {},
    });
    setToolApprovalHandler(approval.handler);
    const keys: (string | undefined)[] = [];
    ctx.core = async () => {
      keys.push(currentExecution()?.key);
      return (await authorizeTool(tool, { text: "x" })) ? "abgelehnt" : "erlaubt";
    };
    const sse = await listen(ctx, id);
    const res = await post(ctx, id, "/critic Idee");
    expect(res.status).toBe(202);
    await waitUntil(() => sse.events.some(e => e.event === "status" && e.data.awaiting === true));
    const awaiting = sse.events.find(e => e.event === "status" && e.data.awaiting)!;
    const approvalId = awaiting.data.approvalId as string;
    // Register-ID, im Gespräch des Befehls, nach Telegram gesendet; im Verlauf keine eigene Kopie
    expect(sentChoices).toEqual([approvalId]);
    expect(sse.events.some(e => e.event === "message" && e.data.role === "assistant")).toBe(false);
    return { ctx, sse, approvalId, keys };
  }

  for (const c of cases) {
    for (const via of ["web", "terminal"] as const) {
      test(`${c.id}, ${via}: awaiting mit Register-ID, „ja“ gibt frei, Quelle ${via}, Status danach zurückgesetzt`, async () => {
        const { ctx, sse, approvalId, keys } = await askedCritic(c.id);
        expect(keys).toEqual([c.key]);
        const choice = (await getChoice(approvalId))!;
        expect(choice).toMatchObject({ kind: "tool", state: "open", conversation: c.conversation });
        const res = await api(ctx, `/api/conversations/${c.id}/messages`, { method: "POST", body: { text: "ja", approvalId }, terminal: via === "terminal" });
        expect(res.status).toBe(202);
        expect((await getChoice(approvalId))!.result).toMatchObject({ key: "allow", via });
        await sse.settled();
        await sse.close();
        const at = sse.events.findIndex(e => e.event === "status" && e.data.awaiting === true);
        // Nach der Entscheidung wartet nichts mehr, der Befehl läuft zu Ende
        expect(sse.events.slice(at + 1).some(e => e.event === "status" && e.data.running === true && !e.data.awaiting)).toBe(true);
        expect(sse.events.slice(at + 1).some(e => e.event === "status" && e.data.awaiting)).toBe(false);
        expect(ctx.agentSends.at(-1)).toMatchObject({ agent: "critic", text: "erlaubt" });
        // Dieselbe Antwort noch einmal: nichts mehr offen
        const again = await api(ctx, `/api/conversations/${c.id}/messages`, { method: "POST", body: { text: "ja", approvalId }, terminal: via === "terminal" });
        expect(again.status).toBe(409);
      });

      test(`${c.id}, ${via}: „nein“ lehnt über das Register ab, das Werkzeug läuft nicht`, async () => {
        const { ctx, sse, approvalId } = await askedCritic(c.id);
        const res = await api(ctx, `/api/conversations/${c.id}/messages`, { method: "POST", body: { text: "nein", approvalId }, terminal: via === "terminal" });
        expect(res.status).toBe(202);
        expect((await getChoice(approvalId))!.result).toMatchObject({ key: "deny", via });
        await sse.settled();
        await sse.close();
        expect(ctx.agentSends.at(-1)).toMatchObject({ agent: "critic", text: "abgelehnt" });
        expect(sse.events.filter(e => e.event === "status").at(-1)!.data).toMatchObject({ running: false });
      });
    }
  }

  test("Terminal über ApiClient: „ja“ mit der Kennung aus dem Status", async () => {
    const { ctx, sse, approvalId } = await askedCritic("topic-443");
    const client = new ApiClient({ base: ctx.origin.replace(/\/$/, ""), getToken: async () => ctx.bearer });
    const page = await client.messages("topic-443");
    expect(page).toMatchObject({ running: true, awaiting: true, approvalId });
    expect((await client.send("topic-443", "ja", approvalId)).status).toBe("accepted");
    await sse.settled();
    await sse.close();
    expect((await getChoice(approvalId))!.result).toMatchObject({ key: "allow", via: "terminal" });
    expect((await client.messages("topic-443")).awaiting).toBeUndefined();
  });
});

describe("/critic im benannten Web-Gespräch: Telegram-Kopie mit Titel (PR #147)", () => {
  const tool: BuiltinTool = {
    name: "notiz_schreiben",
    description: "Schreibt eine Notiz",
    inputSchema: { type: "object", properties: {} },
    requiresApproval: true,
    isAvailable: () => true,
    handler: async () => "",
  };
  let approval: ChoiceToolApproval | undefined;
  let offListener: (() => void) | undefined;
  afterEach(() => {
    approval?.dispose();
    approval = undefined;
    offListener?.();
    offListener = undefined;
    setToolApprovalHandler(null);
    setChoicesFileForTests(null);
  });

  test("Kopie im Direktchat mit „(Web-Gespräch „<Titel>“)“, nach der Entscheidung im Browser bearbeitet", async () => {
    setChoicesFileForTests(join(root, `critic-title-${Date.now()}.json`));
    const ctx = await start({ realWebChat: true });
    await ctx.store.renameConversation(ctx.webId, "Reise planen");
    const sends: SendAndRecordInput[] = [];
    const edits: unknown[][] = [];
    // Echter Telegram-Weg der Rückfragen (senden und nachziehen), nur die Api ist eine Attrappe
    const telegram = createTelegramChoices({
      api: {
        answerCallbackQuery: async () => true,
        editMessageText: async (...args: unknown[]) => (edits.push(args), true),
        editMessageReplyMarkup: async () => true,
      } as any,
      owner: USER,
      log: () => {},
      send: async input => (sends.push(input), { sent: true, recorded: true, messages: [{ chatId: USER, messageId: 77, buttons: true }] }) as any,
    });
    offListener = onChoiceChange(telegram.listener);
    approval = createChoiceToolApproval({ sendChoice: choice => telegram.sendChoice(choice), presenter: key => ctx.approvals.presenter(key), log: () => {} });
    setToolApprovalHandler(approval.handler);
    ctx.core = async () => ((await authorizeTool(tool, { text: "x" })) ? "abgelehnt" : "erlaubt");
    const sse = await listen(ctx, ctx.webId);
    await post(ctx, ctx.webId, "/critic Idee");
    await waitUntil(() => sse.events.some(e => e.event === "status" && e.data.awaiting === true));
    const approvalId = sse.events.find(e => e.event === "status" && e.data.awaiting)!.data.approvalId as string;
    await waitUntil(() => sends.length > 0);
    expect(sends).toHaveLength(1);
    expect(sends[0].chatId).toBeUndefined();
    expect(sends[0].choiceId).toBe(approvalId);
    expect(sends[0].text!.startsWith("(Web-Gespräch „Reise planen“)\n")).toBe(true);
    // Im Browser nur die Frage ohne Hinweis
    const question = sse.events.find(e => e.event === "message" && e.data.role === "assistant")!.data;
    expect(question.text).not.toContain("Web-Gespräch");

    const res = await api(ctx, `/api/conversations/${ctx.webId}/messages`, { method: "POST", body: { text: "ja", approvalId } });
    expect(res.status).toBe(202);
    await sse.settled();
    await sse.close();
    expect(sse.events.filter(e => e.event === "message").at(-1)!.data).toMatchObject({ text: "erlaubt", agent: "critic" });
    await waitUntil(() => edits.length > 0);
    expect(edits[0][0]).toBe(USER);
    expect(edits[0][1]).toBe(77);
    expect(String(edits[0][2])).toContain("(Web-Gespräch „Reise planen“)");
    expect(String(edits[0][2])).toContain("✓ Erlauben (im Browser)");
  });
});

describe("/help im Terminal (tybo) über die gemeinsame Schicht", () => {
  test("gespiegelt nach Telegram, Spickzettel als Meldung im Gespräch, nach Neuladen genau einmal", async () => {
    const ctx = await start();
    const client = new ApiClient({ base: ctx.origin.replace(/\/$/, ""), getToken: async () => ctx.bearer });
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
    await waitUntil(() => ctx.server.eventStreamCount() >= 1, 3000);
    stdin.type("/help\r");
    await waitUntil(() => stdout.text.includes("tybo Spickzettel"), 3000);
    expect(ctx.plain).toEqual([{ chatId: GROUP, text: "Du (Terminal): /help", threadId: 443 }]);
    expect(ctx.records).toEqual([{ text: HELP_TEXT, topicId: 443, source: "befehl", format: "markdown" }]);
    expect(ctx.saved[0]).toMatchObject({ role: "user", content: "/help", metadata: { via: "terminal" } });
    expect(stdout.text).not.toContain("Tasten im Chat:");
    stdin.type("\u0004");
    await exit;
    const history = await (await api(ctx, "/api/conversations/topic-443/messages")).json();
    expect(history.messages.map((m: any) => [m.role, m.kind ?? null])).toEqual([
      ["user", null],
      ["assistant", "notice"],
    ]);
  });
});

describe("GET /api/commands", () => {
  test("Browser: Liste mit Name, Aliassen, Beschreibung und Argumenten, mit /voice (Issue #78)", async () => {
    const ctx = await start();
    const res = await api(ctx, "/api/commands");
    expect(res.status).toBe(200);
    const { commands } = await res.json();
    expect(commands.map((c: any) => c.name)).toEqual(["help", "stop", "new", "topics", "agent", "goal", "goals", "learn", "plan", "critic", "board", "routine", "jobs", "voice"]);
    expect(commands.find((c: any) => c.name === "critic")).toEqual({
      name: "critic",
      aliases: [],
      description: "Stress-Test einer Idee durch den Critic",
      args: "required",
      argsHint: "<idee>",
    });
    expect(commands.find((c: any) => c.name === "new").aliases).toEqual(["reset"]);
    expect(commands.find((c: any) => c.name === "stop").aliases).toEqual(["abbruch"]);
    // keine internen Felder wie whileBusy oder bareWords
    const allowed = ["name", "aliases", "description", "args", "argsHint"];
    for (const c of commands) expect(Object.keys(c).filter(k => !allowed.includes(k))).toEqual([]);
  });

  test("Kanal aus der Anmeldung: Terminal mit lokalem Schlüssel bekommt die Terminal-Liste", async () => {
    const ctx = await start();
    const res = await api(ctx, "/api/commands", { terminal: true });
    expect(res.status).toBe(200);
    const names = (await res.json()).commands.map((c: any) => c.name);
    expect(names).toEqual(commandRegistry.list("terminal").map(c => c.name));
    expect(names).toContain("voice");
  });

  test("Liste nach Kanal gefiltert: ein nur für Telegram registrierter Befehl fehlt in Browser und Terminal", () => {
    const registry = createCommandRegistry([
      { name: "nurtg", aliases: [], description: "x", args: "none", channels: ["telegram"], run: async () => {} },
      { name: "alle", aliases: [], description: "x", args: "none", channels: ["telegram", "web", "terminal"], run: async () => {} },
    ]);
    expect(registry.list("telegram").map(c => c.name)).toEqual(["nurtg", "alle"]);
    expect(registry.list("web").map(c => c.name)).toEqual(["alle"]);
    expect(registry.list("terminal").map(c => c.name)).toEqual(["alle"]);
    expect(registry.match("/nurtg", "web")).toBeNull();
  });

  test("nur angemeldet, nur GET", async () => {
    const ctx = await start();
    expect((await fetch(`${ctx.origin}/api/commands`)).status).toBe(401);
    const post = await api(ctx, "/api/commands", { method: "POST", body: {} });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET");
  });

  test("ohne Befehls-Port: 503, Nachrichten gehen wie bisher an den Chat", async () => {
    const dir = join(root, `case-${++counter}`);
    const store = new ConversationStore({ dir: join(dir, "web") });
    await store.load();
    const conversation = await store.createConversation("general");
    const chat = new FakeWebChat();
    const server = await createWebServer(
      { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
      { sessionFile: join(dir, "s.json"), conversationStore: store, chat, log: () => {} }
    );
    servers.push(server);
    const login = await fetch(`${server.url}/api/login`, { method: "POST", headers: { origin: server.url }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const headers = { origin: server.url, cookie, "content-type": "application/json" };
    const res = await fetch(`${server.url}/api/commands`, { headers });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe("Befehle sind nicht eingerichtet");
    const sent = await fetch(`${server.url}/api/conversations/${conversation.id}/messages`, { method: "POST", headers, body: JSON.stringify({ text: "/new" }) });
    expect(sent.status).toBe(202);
    await waitUntil(() => chat.calls.length === 1);
    expect(chat.calls[0].text).toBe("/new");
    chat.finish(conversation.id, "ok");
  });
});

describe("/voice aus Browser und Terminal (Issue #78): Text hier, Sprachnachricht in Telegram", () => {
  const SENT = "Sprachnachricht in Telegram gesendet.";
  const FAILED = "Sprachnachricht konnte nicht erzeugt werden, die Antwort steht oben als Text.";
  const ABORTED_VOICE = "Sprachnachricht abgebrochen.";
  const NOT_CONFIGURED = "Sprachausgabe ist nicht eingerichtet (lokales TTS, ElevenLabs oder Gemini).";
  const MIRRORED_ONLY = "Sprachnachrichten gibt es nur in Gesprächen, die mit Telegram gespiegelt sind.";
  // Echte Synthese (createVoiceSynthesis) mit textToSpeech-Attrappe; WAV wird zu Ogg/Opus
  const fixtures = [
    { name: "MP3 mit ID3", audio: mp3Id3Fixture, sent: mp3Id3Fixture, fileName: "antwort.mp3" },
    { name: "MP3 ohne ID3", audio: mp3FrameFixture, sent: mp3FrameFixture, fileName: "antwort.mp3" },
    { name: "WAV, nach Ogg/Opus gewandelt", audio: wavFixture, sent: oggOpusFixture, fileName: "antwort.ogg" },
    { name: "Ogg/Opus", audio: oggOpusFixture, sent: oggOpusFixture, fileName: "antwort.ogg" },
  ];
  const realSynthesis = (audio: Buffer, convertWav: (wav: Buffer) => Promise<Buffer | null> = async () => oggOpusFixture()) =>
    createVoiceSynthesis({ enabled: () => true, textToSpeech: async () => audio, convertWav }).synthesize;

  for (const terminal of [false, true]) {
    for (const f of fixtures) {
      test(`${terminal ? "Terminal" : "Browser"}, ${f.name}: ein Turn, Text live und im Verlauf, Telegram bekommt Text und Sprachnachricht`, async () => {
        const ctx = await start();
        ctx.core = async () => "Drei Punkte [REMEMBER: Alex hört gern zu]";
        ctx.synthesize = realSynthesis(f.audio());
        const sse = await listen(ctx, "topic-443");
        const res = await post(ctx, "topic-443", "/voice Fasse zusammen", terminal);
        expect((await res.json()).command).toBe("voice");
        await sse.settled();
        await sse.close();
        // Genau ein Turn mit dem Agenten des Topics
        expect(ctx.prompts).toEqual([{ agent: "finance", text: "Fasse zusammen", chatId: GROUP, topicId: 443 }]);
        expect(ctx.plain).toEqual([{ chatId: GROUP, text: `Du (${terminal ? "Terminal" : "Web"}): /voice Fasse zusammen`, threadId: 443 }]);
        // Antwort einmal gespeichert, mit type voice_reply
        const replies = ctx.saved.filter(m => m.role === "assistant");
        expect(replies).toHaveLength(1);
        expect(replies[0]).toMatchObject({ content: "Drei Punkte [REMEMBER: Alex hört gern zu]", metadata: { type: "voice_reply", agent: "finance" } });
        // Telegram: Text vom Agenten-Bot, dann genau eine Sprachnachricht, Endung aus den Bytes
        expect(ctx.agentSends).toEqual([{ agent: "finance", chatId: GROUP, text: "Drei Punkte", threadId: 443 }]);
        expect(ctx.synthCalls).toEqual(["Drei Punkte"]);
        expect(ctx.voiceSends).toEqual([{ chatId: GROUP, fileName: f.fileName, threadId: 443, size: f.sent().length }]);
        expect(ctx.intents).toEqual(["Drei Punkte [REMEMBER: Alex hört gern zu]"]);
        expect(ctx.records.map(r => r.text)).toEqual([SENT]);
        expect(sse.events.some(e => e.event === "error")).toBe(false);
        const live = sse.events.filter(e => e.event === "message").map(e => e.data);
        expect(live.map((m: any) => [m.role, m.kind ?? null, m.text])).toEqual([
          ["user", null, "/voice Fasse zusammen"],
          ["assistant", null, "Drei Punkte [REMEMBER: Alex hört gern zu]"],
          ["assistant", "notice", SENT],
        ]);
        // Nach dem Neuladen genau einmal
        const history = await (await api(ctx, "/api/conversations/topic-443/messages")).json();
        expect(history.messages.map((m: any) => [m.role, m.kind ?? null, m.text])).toEqual([
          ["user", null, "/voice Fasse zusammen"],
          ["assistant", null, "Drei Punkte [REMEMBER: Alex hört gern zu]"],
          ["assistant", "notice", SENT],
        ]);
        expect(history.messages[1].id).toBe((replies[0].metadata as any).msgId);
      });
    }
  }

  test("Direktchat: Sprachnachricht in den Direktchat, ohne Thread", async () => {
    const ctx = await start();
    const sse = await listen(ctx, "dm");
    await post(ctx, "dm", "/voice Hallo");
    await sse.settled();
    await sse.close();
    expect(ctx.prompts).toEqual([{ agent: "general", text: "Hallo", chatId: USER, topicId: undefined }]);
    expect(ctx.agentSends).toEqual([{ agent: "general", chatId: USER, text: "Antwort", threadId: undefined }]);
    expect(ctx.voiceSends).toEqual([{ chatId: USER, fileName: "antwort.mp3", threadId: undefined, size: mp3Id3Fixture().length }]);
    expect(ctx.records.map(r => [r.text, r.topicId])).toEqual([[SENT, undefined]]);
  });

  for (const terminal of [false, true]) {
    test(`${terminal ? "Terminal" : "Browser"} ohne Stimme: nur der Hinweis, kein Turn`, async () => {
      const ctx = await start();
      ctx.voiceEnabled = false;
      const sse = await listen(ctx, "topic-443");
      await post(ctx, "topic-443", "/voice Hallo", terminal);
      await sse.settled();
      await sse.close();
      expect(ctx.claudeStarted).toBe(0);
      expect(ctx.synthCalls).toEqual([]);
      expect(ctx.voiceSends).toEqual([]);
      expect(ctx.records.map(r => r.text)).toEqual([NOT_CONFIGURED]);
      expect(ctx.saved.map(m => m.role)).toEqual(["user"]);
    });
  }

  const failures: { name: string; setup: (ctx: Ctx) => void }[] = [
    { name: "Synthese liefert null", setup: ctx => (ctx.synthesize = async () => null) },
    { name: "Synthese wirft", setup: ctx => (ctx.synthesize = async () => Promise.reject(new Error("TTS weg"))) },
    { name: "Synthese liefert HTML mit Audio-Namen", setup: ctx => (ctx.synthesize = async () => ({ audio: htmlFixture(), mime: "audio/mpeg", fileName: "antwort.mp3" })) },
    { name: "Synthese liefert SVG mit Audio-Namen", setup: ctx => (ctx.synthesize = async () => ({ audio: svgFixture(), mime: "audio/ogg", fileName: "antwort.ogg" })) },
    { name: "WAV, Wandlung scheitert (ffmpeg fehlt)", setup: ctx => (ctx.synthesize = realSynthesis(wavFixture(), async () => null)) },
    { name: "Synthese liefert WAV direkt", setup: ctx => (ctx.synthesize = async () => ({ audio: wavFixture(), mime: "audio/wav", fileName: "antwort.wav" })) },
    { name: "Versand wirft", setup: ctx => (ctx.sendVoice = async () => Promise.reject(new Error("Telegram weg"))) },
  ];
  for (const f of failures) {
    test(`${f.name}: Text bleibt, Hinweis, nichts doppelt gespeichert oder gesendet`, async () => {
      const ctx = await start();
      f.setup(ctx);
      const sse = await listen(ctx, "topic-443");
      await post(ctx, "topic-443", "/voice Hallo");
      await sse.settled();
      await sse.close();
      expect(ctx.claudeStarted).toBe(1);
      expect(ctx.saved.map(m => [m.role, m.content])).toEqual([
        ["user", "/voice Hallo"],
        ["assistant", "Antwort"],
      ]);
      expect(ctx.agentSends).toHaveLength(1);
      expect(ctx.voiceSends).toEqual([]);
      expect(ctx.intents).toHaveLength(1);
      expect(ctx.records.map(r => r.text)).toEqual([FAILED]);
      expect(sse.events.some(e => e.event === "error")).toBe(false);
    });
  }

  for (const terminal of [false, true]) {
    test(`${terminal ? "Terminal" : "Browser"}, älteres Web-Gespräch: nur der Hinweis, kein Turn`, async () => {
      const ctx = await start();
      const sse = await listen(ctx, ctx.webId);
      await post(ctx, ctx.webId, "/voice Hallo", terminal);
      await sse.settled();
      await sse.close();
      expect(ctx.claudeStarted).toBe(0);
      expect(ctx.webChat.calls).toEqual([]);
      expect(ctx.synthCalls).toEqual([]);
      expect(ctx.plain).toEqual([]);
      const notices = sse.events.filter(e => e.event === "message" && e.data.kind === "notice").map(e => e.data.text);
      expect(notices).toEqual([MIRRORED_ONLY]);
    });
  }

  test("Stopp-Knopf während des Turns: „Abgebrochen.“, keine Synthese, keine Sprachnachricht", async () => {
    const ctx = await start();
    ctx.core = untilAborted;
    const sse = await listen(ctx, "topic-443");
    await post(ctx, "topic-443", "/voice Hallo");
    await waitUntil(() => ctx.claudeStarted === 1);
    const stop = await api(ctx, "/api/conversations/topic-443/stop", { method: "POST" });
    expect((await stop.json()).stopping).toBe(true);
    await sse.settled();
    await sse.close();
    expect(sse.events.find(e => e.event === "error")?.data.text).toBe(ABORTED_TEXT);
    expect(ctx.synthCalls).toEqual([]);
    expect(ctx.voiceSends).toEqual([]);
    expect(ctx.agentSends).toEqual([]);
    expect(ctx.saved.map(m => m.role)).toEqual(["user"]);
  });

  for (const via of ["Stopp-Knopf", "/stop"]) {
    test(`${via} während der Synthese: Text bleibt, keine Sprachnachricht, „Sprachnachricht abgebrochen.“`, async () => {
      const ctx = await start();
      let release = () => {};
      ctx.synthesize = () =>
        new Promise(resolve => {
          release = () => resolve({ audio: mp3Id3Fixture(), mime: "audio/mpeg", fileName: "antwort.mp3" });
        });
      const sse = await listen(ctx, "topic-443");
      await post(ctx, "topic-443", "/voice Hallo");
      await waitUntil(() => ctx.synthCalls.length === 1);
      if (via === "/stop") {
        const res = await post(ctx, "topic-443", "/stop");
        expect((await res.json()).command).toBe("stop");
      } else {
        const stop = await api(ctx, "/api/conversations/topic-443/stop", { method: "POST" });
        // Nach der gespeicherten Antwort nimmt der Server den Stopp für die Synthese wieder an
        expect((await stop.json()).stopping).toBe(true);
      }
      await waitUntil(() => ctx.records.some(r => r.text === ABORTED_VOICE));
      // Ein spätes Ergebnis der Synthese wird verworfen
      release();
      await waitUntil(() => sse.events.at(-1)?.event === "status" && sse.events.at(-1)?.data.running === false);
      await Bun.sleep(30);
      await sse.close();
      expect(ctx.voiceSends).toEqual([]);
      expect(ctx.saved.filter(m => m.role === "assistant").map(m => m.content)).toEqual(["Antwort"]);
      expect(ctx.agentSends).toHaveLength(1);
      expect(sse.events.some(e => e.event === "error")).toBe(false);
      expect(ctx.records.map(r => r.text).filter(t => t !== "⏹️ 1 laufende Verarbeitung abgebrochen.")).toEqual([ABORTED_VOICE]);
      // Danach ist das Gespräch wieder frei
      expect((await (await api(ctx, "/api/conversations/topic-443/stop", { method: "POST" })).json()).stopping).toBe(false);
    });
  }
});

describe("/voice im Terminal (tybo): Textantwort plus Meldung", () => {
  test("Antwort und „Sprachnachricht in Telegram gesendet.“ erscheinen im Terminal", async () => {
    const ctx = await start();
    ctx.core = async () => "Gesprochene Antwort";
    const client = new ApiClient({ base: ctx.origin.replace(/\/$/, ""), getToken: async () => ctx.bearer });
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
    await waitUntil(() => ctx.server.eventStreamCount() >= 1, 3000);
    stdin.type("/voice Sag was\r");
    await waitUntil(() => stdout.text.includes("Sprachnachricht in Telegram gesendet."), 3000);
    expect(stdout.text).toContain("Gesprochene Antwort");
    expect(stdout.text.indexOf("Gesprochene Antwort")).toBeLessThan(stdout.text.indexOf("Sprachnachricht in Telegram gesendet."));
    expect(ctx.plain).toEqual([{ chatId: GROUP, text: "Du (Terminal): /voice Sag was", threadId: 443 }]);
    expect(ctx.voiceSends).toHaveLength(1);
    expect(ctx.saved[0]).toMatchObject({ role: "user", content: "/voice Sag was", metadata: { via: "terminal" } });
    stdin.type("\u0004");
    await exit;
  });
});
