import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ABORT_REPLY,
  FALLBACK_FAILED_REPLY,
  SHUTDOWN_ABORT_REPLY,
  LONG_RUN_NOTICE_TEXT,
  type TurnOptions,
  type TurnSink,
} from "../src/lib/chat-turn";
import {
  abortAllExecutions,
  abortExecutions,
  activeExecutionCount,
  currentExecution,
  runExecution,
} from "../src/lib/execution-context";
import { ABORTED_TEXT, ChatHub, type RunTurnOptions } from "../src/web/chat";
import type { WebConfig } from "../src/web/config";
import { createApprovalTurns, createBotChat, createWebSink, webChatId, type BotChatDeps, type WebSavedMessage } from "../src/web/bot-turn";
import { callBuiltinTool, registerBuiltinTool, setToolApprovalHandler } from "../src/lib/tools/registry";
import { decideChoice, getChoice, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { createChoiceToolApproval, type ChoiceToolApproval } from "../src/lib/tool-approval";
import type { ChoicePort } from "../src/web/choices";
import { testChoices } from "./choices-fixture";
import { createWebServer, type WebServer, type WebServerDeps } from "../src/web/server";
import { reachableUrls, startWebUi } from "../src/web/startup";
import { ConversationStore } from "../src/web/store";

const PASSWORD = "test-passwort-lang";
const root = await mkdtemp(join(tmpdir(), "tybo-web-turn-"));
let counter = 0;
afterAll(() => rm(root, { recursive: true, force: true }));

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

/** Fake-Chat-Kern: der Test bestimmt, was runStreamingTurn tut. */
function setup(core: (o: TurnOptions) => Promise<string> = async () => "Antwort") {
  const state = {
    saved: [] as WebSavedMessage[],
    intents: [] as string[],
    restarts: [] as string[],
    aborts: [] as string[],
    logs: [] as string[],
    coreCalls: [] as TurnOptions[],
    shuttingDown: false,
    saveResult: true,
    /** hält saveMessage an, z. B. beim Speichern der Antwort */
    beforeSave: undefined as ((m: WebSavedMessage) => Promise<void>) | undefined,
    core,
  };
  const deps: BotChatDeps = {
    runStreamingTurn: o => {
      state.coreCalls.push(o);
      return state.core(o);
    },
    saveMessage: async m => {
      await state.beforeSave?.(m);
      state.saved.push(m);
      return state.saveResult;
    },
    processIntents: async t => {
      state.intents.push(t);
    },
    // wie abortEngineCalls in src/lib/engines: bricht die Ausführungen unter dem Schlüssel ab
    abortEngineCalls: key => {
      state.aborts.push(key);
      return abortExecutions(key);
    },
    isShuttingDown: () => state.shuttingDown,
    scheduleRestartCheck: t => {
      state.restarts.push(t);
    },
    log: m => state.logs.push(m),
  };
  return { state, deps, chat: createBotChat(deps) };
}

/** Gültige Gesprächs-ID (UUID) für Freigaben: web:<id> braucht sie */
const WEB_UUID = "0c1a2b3c-0000-4000-8000-000000000000";

const nullSink: TurnSink = { progress() {}, notice() {} };

function turn(id: string, text = "Hallo", sink: TurnSink = nullSink): RunTurnOptions {
  return { conversationId: id, agent: "general", text, sink };
}

/** Wartet im Chat-Kern auf den Abbruch der eigenen Ausführung. */
function untilAborted(): Promise<void> {
  const signal = currentExecution()!.controller.signal;
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

afterEach(() => abortAllExecutions());

describe("createBotChat", () => {
  test("Chat-ID web:<id>, Nutzer- und Antwortnachricht mit channel web, Intents mit der Antwort", async () => {
    const reply = "Hier die Antwort.\n[REMEMBER: Alex mag kurze Antworten]";
    const { state, chat } = setup(async () => reply);
    const result = await chat.runTurn(turn("abc", "Was weißt du über mich?"));

    expect(result).toEqual({ text: reply, info: { agent: "general" } });
    expect(webChatId("abc")).toBe("web:abc");
    expect(state.coreCalls[0]).toMatchObject({ userMessage: "Was weißt du über mich?", chatId: "web:abc", agentName: "general" });
    expect(state.saved).toEqual([
      { chat_id: "web:abc", role: "user", content: "Was weißt du über mich?", metadata: { channel: "web" } },
      { chat_id: "web:abc", role: "assistant", content: reply, metadata: { agent: "general", channel: "web" } },
    ]);
    // unverändert, mit Tag
    expect(state.intents).toEqual([reply]);
    expect(state.restarts).toHaveLength(1);
  });

  test("läuft unter runCancelable und runExecution mit Schlüssel web:<id>; Neustart-Zählung sieht den Turn", async () => {
    let seen: { count: number; key?: string; agent?: string } | undefined;
    const { state, chat } = setup(async () => {
      const ctx = currentExecution();
      seen = { count: activeExecutionCount(), key: ctx?.key, agent: ctx?.agent };
      return "ok";
    });
    const before = activeExecutionCount();
    await chat.runTurn({ ...turn("xyz"), agent: "research" });
    expect(seen).toEqual({ count: before + 2, key: "web:xyz", agent: "research" });
    expect(activeExecutionCount()).toBe(before);
    expect(state.restarts).toHaveLength(1);
  });

  test("stop(id) bricht Claude-Aufrufe unter web:<id> ab", () => {
    const { state, chat } = setup();
    chat.stop("abc");
    expect(state.aborts).toEqual(["web:abc"]);
  });

  test("ABORT_REPLY wird als aborted gemeldet, ohne Antwort im Gedächtnis und ohne Intents", async () => {
    const { state, chat } = setup(async () => ABORT_REPLY);
    const result = await chat.runTurn(turn("abc"));
    expect(result).toEqual({ text: "", aborted: true });
    expect(state.saved.map(m => m.role)).toEqual(["user"]);
    expect(state.intents).toEqual([]);
    expect(state.restarts).toHaveLength(1);
  });

  test("Abbruch durch shutdown(): Text wie in Telegram", async () => {
    const { state, chat } = setup(async () => {
      state.shuttingDown = true;
      return ABORT_REPLY;
    });
    expect(await chat.runTurn(turn("abc"))).toEqual({ text: SHUTDOWN_ABORT_REPLY, aborted: true });
  });

  test("abgebrochener Fallback: Text des Kerns wird verworfen, keine Antwort, keine Intents", async () => {
    const { state, chat } = setup(async () => {
      await untilAborted();
      // chat-turn.ts macht aus dem Abbruch im Fallback FALLBACK_FAILED_REPLY
      return FALLBACK_FAILED_REPLY;
    });
    const running = chat.runTurn(turn("fb"));
    await waitUntil(() => state.coreCalls.length === 1);
    chat.stop("fb");
    expect(await running).toEqual({ text: "", aborted: true });
    expect(state.saved.map(m => m.role)).toEqual(["user"]);
    expect(state.intents).toEqual([]);
  });

  test("Abbruch in der Warteschlange: Kern läuft nie, keine Antwort, keine Intents", async () => {
    const { state, chat } = setup();
    // Ein anderer Turn hält die Sperre für web:q/general
    let release!: () => void;
    const blocker = runExecution("web:q", "general", () => new Promise<void>(r => (release = r))).catch(() => {});
    await waitUntil(() => typeof release === "function");

    const waiting = chat.runTurn(turn("q"));
    await Bun.sleep(20);
    expect(state.coreCalls).toHaveLength(0);
    chat.stop("q");
    release();
    await blocker;

    expect(await waiting).toEqual({ text: "", aborted: true });
    expect(state.coreCalls).toHaveLength(0);
    expect(state.saved.map(m => m.role)).toEqual(["user"]);
    expect(state.intents).toEqual([]);
    expect(state.restarts).toHaveLength(1);
  });

  test("Fehler im Kern: Turn scheitert, Neustart-Prüfung läuft trotzdem", async () => {
    const { state, chat } = setup(async () => {
      throw new Error("kaputt");
    });
    await expect(chat.runTurn(turn("err"))).rejects.toThrow("kaputt");
    expect(state.intents).toEqual([]);
    expect(state.restarts).toHaveLength(1);
  });

  test("saveMessage false: Log ohne Inhalt, die Antwort kommt trotzdem", async () => {
    const { state, chat } = setup(async () => "geheime Antwort");
    state.saveResult = false;
    expect(await chat.runTurn(turn("nosave", "geheime Frage"))).toEqual({ text: "geheime Antwort", info: { agent: "general" } });
    expect(state.logs.length).toBe(2);
    expect(state.logs.join("\n")).not.toContain("geheim");
  });

  test("Stopp während die Antwort gespeichert wird: abgelehnt, Antwort und Intents vollständig", async () => {
    const reply = "Fertig.\n[REMEMBER: Web-Test]";
    const { state, chat } = setup(async () => reply);
    let release!: () => void;
    state.beforeSave = m => (m.role === "assistant" ? new Promise<void>(r => (release = r)) : Promise.resolve());
    const running = chat.runTurn(turn("commit"));
    await waitUntil(() => typeof release === "function");

    expect(chat.stop("commit")).toBe(false);
    expect(state.aborts).toEqual([]);
    release();
    expect(await running).toEqual({ text: reply, info: { agent: "general" } });
    expect(state.saved.map(m => m.role)).toEqual(["user", "assistant"]);
    expect(state.intents).toEqual([reply]);
  });

  test("leere Antwort wird nicht gespeichert", async () => {
    const { state, chat } = setup(async () => "   ");
    expect(await chat.runTurn(turn("leer"))).toEqual({ text: "" });
    expect(state.saved.map(m => m.role)).toEqual(["user"]);
    expect(state.intents).toEqual([]);
  });
});

describe("createWebSink", () => {
  test("reicht Fortschritt und Hinweise weiter, nach finish() nur noch Hinweise", async () => {
    const events: string[] = [];
    const sink = createWebSink({
      progress: p => void events.push(`progress:${p.kind}:${p.text}`),
      notice: t => void events.push(`notice:${t}`),
    });
    await sink.start?.();
    await sink.progress({ kind: "tool", text: "Read" });
    await sink.notice("Hinweis");
    await sink.finish?.();
    await sink.progress({ kind: "tool", text: "zu spät" });
    await sink.notice(LONG_RUN_NOTICE_TEXT);
    expect(events).toEqual(["progress:tool:Read", "notice:Hinweis", `notice:${LONG_RUN_NOTICE_TEXT}`]);
  });

  test("Fehler des Ziels erreichen den Turn nicht", async () => {
    const sink = createWebSink({
      progress: () => {
        throw new Error("weg");
      },
      notice: async () => {
        throw new Error("weg");
      },
      finish: () => {
        throw new Error("weg");
      },
    });
    await sink.progress({ kind: "tool", text: "Read" });
    await sink.notice("x");
    await sink.finish?.();
  });
});

// ---------------------------------------------------------------------------
// Zusammen mit Web-Server und ChatHub
// ---------------------------------------------------------------------------

const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 100 });
});

async function startServer(chat: ReturnType<typeof setup>["chat"], choices?: ChoicePort) {
  const dir = join(root, `case-${++counter}`);
  const dataDir = join(dir, "web");
  // Älteres Web-Gespräch vorab anlegen: seit Issue #29 legt die API keine mehr an
  const seed = new ConversationStore({ dir: dataDir });
  await seed.load();
  const id = (await seed.createConversation("general")).id;
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    { sessionFile: join(dir, "sessions.json"), dataDir, chat, log: () => {}, ...(choices ? { choices } : {}) }
  );
  servers.push(server);
  const origin = server.url;
  const login = await fetch(`${origin}/api/login`, { method: "POST", headers: { origin }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0];
  const api = (path: string, method = "GET", body?: unknown) =>
    fetch(`${origin}${path}`, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { server, api, id, dataDir, origin, cookie };
}

/** Liest SSE-Ereignisse eines Gesprächs mit. */
async function listen(origin: string, cookie: string, id: string) {
  const events: { event: string; data: any }[] = [];
  let closed = false;
  const abort = new AbortController();
  const res = await fetch(`${origin}/api/conversations/${id}/events`, { headers: { cookie }, signal: abort.signal });
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of res.body!) {
        buffer += decoder.decode(chunk, { stream: true });
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev) events.push({ event: ev, data: data ? JSON.parse(data) : undefined });
        }
      }
    } catch {
      // abgebrochen
    }
    closed = true;
  })();
  return { events, isClosed: () => closed, close: () => abort.abort() };
}

describe("mit Web-Server", () => {
  test("Fortschritt und Hinweis (auch nach finish) kommen per SSE, danach die Antwort", async () => {
    const { chat } = setup(async o => {
      await o.sink.start?.();
      await o.sink.progress({ kind: "tool", text: "WebSearch" });
      await o.sink.progress({ kind: "snippet", text: "Ich schaue nach, was es Neues gibt" });
      await o.sink.finish?.();
      await o.sink.notice(LONG_RUN_NOTICE_TEXT);
      return "**fertig**";
    });
    const ctx = await startServer(chat);
    const sse = await listen(ctx.origin, ctx.cookie, ctx.id);
    await waitUntil(() => sse.events.length >= 1);
    expect((await ctx.api(`/api/conversations/${ctx.id}/messages`, "POST", { text: "Recherche" })).status).toBe(202);
    await waitUntil(() => sse.events.some(e => e.event === "message"));
    sse.close();

    const kinds = sse.events.map(e => e.event);
    expect(kinds).toEqual(["status", "status", "progress", "progress", "notice", "message", "status"]);
    expect(sse.events[2].data).toEqual({ kind: "tool", text: "WebSearch" });
    expect(sse.events[4].data).toEqual({ text: LONG_RUN_NOTICE_TEXT });
    expect(sse.events[5].data.html).toContain("<strong>fertig</strong>");
  });

  test("Stopp-Knopf: Abbruch landet als Abgebrochen. im Verlauf, nicht im Gedächtnis", async () => {
    const { state, chat } = setup(async () => {
      await untilAborted();
      return ABORT_REPLY;
    });
    const ctx = await startServer(chat);
    await ctx.api(`/api/conversations/${ctx.id}/messages`, "POST", { text: "lange Recherche" });
    await waitUntil(() => state.coreCalls.length === 1);
    expect((await (await ctx.api(`/api/conversations/${ctx.id}/stop`, "POST")).json()).stopping).toBe(true);
    let list: any[] = [];
    await waitUntil(async () => (list = (await (await ctx.api(`/api/conversations/${ctx.id}/messages`)).json()).messages).length === 2);
    expect(list[1]).toMatchObject({ role: "error", text: ABORTED_TEXT });
    expect(state.aborts).toEqual([`web:${ctx.id}`]);
    expect(state.saved.map(m => m.role)).toEqual(["user"]);
  });

  test("Stopp während die Antwort ins Gedächtnis geht: stopping false, Verlauf zeigt die Antwort, Intents laufen", async () => {
    const reply = "Fertig.\n[REMEMBER: Web-Test]";
    const { state, chat } = setup(async () => reply);
    let release!: () => void;
    state.beforeSave = m => (m.role === "assistant" ? new Promise<void>(r => (release = r)) : Promise.resolve());
    const ctx = await startServer(chat);
    await ctx.api(`/api/conversations/${ctx.id}/messages`, "POST", { text: "Frage" });
    await waitUntil(() => typeof release === "function");

    expect((await (await ctx.api(`/api/conversations/${ctx.id}/stop`, "POST")).json()).stopping).toBe(false);
    release();
    let list: any[] = [];
    await waitUntil(async () => (list = (await (await ctx.api(`/api/conversations/${ctx.id}/messages`)).json()).messages).length === 2);
    expect(list[1]).toMatchObject({ role: "assistant", text: reply });
    expect(list.some(m => m.text === ABORTED_TEXT)).toBe(false);
    expect(state.saved.map(m => m.role)).toEqual(["user", "assistant"]);
    expect(state.intents).toEqual([reply]);
    expect(state.aborts).toEqual([]);
  });

  test("Beenden des Bots: SHUTDOWN_ABORT_REPLY bleibt bis Verlauf und SSE erhalten, danach ist der Server zu", async () => {
    const { state, chat } = setup(async () => {
      await untilAborted();
      return ABORT_REPLY;
    });
    const ctx = await startServer(chat);
    const sse = await listen(ctx.origin, ctx.cookie, ctx.id);
    await ctx.api(`/api/conversations/${ctx.id}/messages`, "POST", { text: "lange Recherche" });
    await waitUntil(() => state.coreCalls.length === 1);

    // Reihenfolge wie in shutdown(): Flag, alle Aufrufe abbrechen, dann WebUI stoppen
    state.shuttingDown = true;
    abortAllExecutions();
    servers.splice(servers.indexOf(ctx.server), 1);
    await ctx.server.stop({ graceMs: 2000, abortText: SHUTDOWN_ABORT_REPLY });

    // Erst wenn die Verbindung zu ist, hat der Client alles gelesen
    await waitUntil(() => sse.isClosed());
    expect(sse.events.find(e => e.event === "error")?.data.text).toBe(SHUTDOWN_ABORT_REPLY);
    const store = new ConversationStore({ dir: ctx.dataDir });
    await store.load();
    const stored = await store.getMessages(ctx.id);
    expect(stored.map(m => [m.role, m.text])).toEqual([
      ["user", "lange Recherche"],
      ["error", SHUTDOWN_ABORT_REPLY],
    ]);
    expect(state.saved.map(m => m.role)).toEqual(["user"]);
    await expect(fetch(`${ctx.origin}/api/me`)).rejects.toThrow();
  });
});

describe("ChatHub beim Beenden", () => {
  test("nimmt keine neuen Turns an und wartet nur begrenzt", async () => {
    const store = new ConversationStore({ dir: join(root, `hub-${++counter}`) });
    await store.load();
    let calls = 0;
    const hub = new ChatHub({
      store,
      chat: {
        // hängt für immer, auch nach stop()
        runTurn: () => {
          calls++;
          return new Promise(() => {});
        },
        stop() {},
      },
    });
    const conv = await store.createConversation("general");
    expect((await hub.send(conv, "eins")).status).toBe("started");
    const t0 = Date.now();
    await hub.shutdown({ graceMs: 50 });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect((await hub.send(await store.createConversation("general"), "zwei")).status).toBe("closing");
    expect(calls).toBe(1);
  });
});

describe("ChatHub: Nachricht angenommen, noch nicht gespeichert", () => {
  test("shutdown wartet: Abschlussmeldung wird gespeichert und vor dem Schließen per SSE geliefert", async () => {
    let release!: () => void;
    let hold = true;
    class SlowStore extends ConversationStore {
      override async appendMessage(...args: Parameters<ConversationStore["appendMessage"]>) {
        if (hold && args[1].role === "user") await new Promise<void>(r => (release = r));
        return super.appendMessage(...args);
      }
    }
    const store = new SlowStore({ dir: join(root, `hub-${++counter}`) });
    await store.load();
    let calls = 0;
    const hub = new ChatHub({
      store,
      chat: {
        runTurn: async () => {
          calls++;
          return { text: "nie" };
        },
        stop() {},
      },
    });
    const conv = await store.createConversation("general");

    // SSE mitlesen; was nach close() kommt, erreicht den Zuhörer nicht mehr
    const res = hub.subscribe(conv.id, new AbortController().signal);
    const reader = res.body!.getReader();
    let received = "";
    void (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += decoder.decode(value, { stream: true });
      }
    })();

    const sending = hub.send(conv, "eins");
    await waitUntil(() => typeof release === "function");
    let stopped = false;
    const stopping = hub.shutdown({ graceMs: 1500, abortText: SHUTDOWN_ABORT_REPLY }).then(() => (stopped = true));
    await Bun.sleep(30);
    expect(stopped).toBe(false);
    hold = false;
    release();
    await stopping;

    expect((await sending).status).toBe("started");
    expect(calls).toBe(0);
    const stored = await store.getMessages(conv.id);
    expect(stored.map(m => [m.role, m.text])).toEqual([
      ["user", "eins"],
      ["error", SHUTDOWN_ABORT_REPLY],
    ]);
    expect(received).toContain("event: error");
    expect(received).toContain(JSON.stringify(SHUTDOWN_ABORT_REPLY));
    expect(hub.subscriberCount()).toBe(0);
    void reader.cancel().catch(() => {});
  });
});

describe("ChatHub: Antwort fertig, lokaler Verlauf wird noch geschrieben", () => {
  test("Stopp wird abgelehnt: kein Abbruch, Antwort und Intents vollständig", async () => {
    const reply = "Fertig.\n[REMEMBER: Web-Test]";
    let release!: () => void;
    class SlowStore extends ConversationStore {
      override async appendMessage(...args: Parameters<ConversationStore["appendMessage"]>) {
        if (args[1].role === "assistant") await new Promise<void>(r => (release = r));
        return super.appendMessage(...args);
      }
    }
    const store = new SlowStore({ dir: join(root, `hub-${++counter}`) });
    await store.load();
    const { state, chat } = setup(async () => reply);
    const hub = new ChatHub({ store, chat });
    const conv = await store.createConversation("general");

    expect((await hub.send(conv, "Frage")).status).toBe("started");
    // runTurn ist durch, Gedächtnis und Intents erledigt, der Verlauf hängt
    await waitUntil(() => typeof release === "function");
    expect(state.intents).toEqual([reply]);

    expect(hub.stop(conv.id)).toBe(false);
    expect(state.aborts).toEqual([]);
    release();
    await hub.idle();
    const stored = await store.getMessages(conv.id);
    expect(stored.map(m => [m.role, m.text])).toEqual([
      ["user", "Frage"],
      ["assistant", reply],
    ]);
    expect(state.saved.map(m => m.role)).toEqual(["user", "assistant"]);
  });
});

// ---------------------------------------------------------------------------
// Werkzeug-Freigaben (Issue #116): Rückfrage im Register, Knöpfe im Browser,
// Kopie im Direktchat, „ja“ als Text über das Register
// ---------------------------------------------------------------------------

describe("Werkzeug-Freigaben aus Web-Turns", () => {
  let toolEnabled = false;
  const toolCalls: Record<string, unknown>[] = [];
  registerBuiltinTool({
    name: "web_test_write",
    description: "Schreibt eine Testdatei",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
    requiresApproval: true,
    isAvailable: () => toolEnabled,
    handler: async args => {
      toolCalls.push(args);
      return "geschrieben";
    },
  });
  let approval: ChoiceToolApproval | undefined;
  /** Kopien nach Telegram (sendChoice-Attrappe) */
  let telegramSent: Choice[] = [];
  let timers: (() => void)[] = [];

  afterEach(() => {
    toolEnabled = false;
    toolCalls.length = 0;
    approval?.dispose();
    approval = undefined;
    setToolApprovalHandler(null);
    setChoicesFileForTests(null);
  });

  /** Gemeinsamer Handler wie in src/bot.ts, mit steuerbarer Frist */
  function approvalSetup(core: (o: TurnOptions) => Promise<string>) {
    toolEnabled = true;
    telegramSent = [];
    timers = [];
    const choices = testChoices(join(root, `choices-${++counter}.json`), { userId: "4242", groupId: null });
    const approvals = createApprovalTurns();
    approval = createChoiceToolApproval({
      sendChoice: async choice => {
        telegramSent.push(choice);
        return { sent: true };
      },
      presenter: key => approvals.presenter(key),
      schedule: fn => {
        timers.push(fn);
        return () => {};
      },
      log: () => {},
    });
    setToolApprovalHandler(approval.handler);
    const made = setup(core);
    return { ...made, choices, chat: createBotChat({ ...made.deps, approvals }) };
  }

  /** Fake-Fallback: ruft das Werkzeug wie mcp-client.ts über die Registry auf */
  const fallbackCore = async () => {
    const r = await callBuiltinTool("web_test_write", { path: "notiz.txt", api_key: "geheim" });
    return r.isError ? "Werkzeug abgelehnt." : `Erledigt: ${r.content}`;
  };

  async function started(core = fallbackCore) {
    const { chat, choices } = approvalSetup(core);
    const ctx = await startServer(chat, choices.port);
    const sse = await listen(ctx.origin, ctx.cookie, ctx.id);
    await waitUntil(() => sse.events.length >= 1);
    expect((await ctx.api(`/api/conversations/${ctx.id}/messages`, "POST", { text: "Schreib die Notiz" })).status).toBe(202);
    await waitUntil(() => sse.events.some(e => e.event === "status" && e.data.awaiting === true));
    const approvalId = sse.events.find(e => e.event === "status" && e.data.awaiting)!.data.approvalId as string;
    return { ctx, sse, approvalId, choices };
  }

  async function history(ctx: Awaited<ReturnType<typeof startServer>>, count: number) {
    let list: any[] = [];
    await waitUntil(async () => (list = (await (await ctx.api(`/api/conversations/${ctx.id}/messages`)).json()).messages).length === count);
    return list;
  }

  test("Frage mit Knöpfen im Browser, Kopie mit Titel im Direktchat, Status zeigt die Register-ID", async () => {
    const { ctx, sse, approvalId } = await started();
    const choice = (await getChoice(approvalId))!;
    expect(choice).toMatchObject({ kind: "tool", state: "open", conversation: { type: "web", conversationId: ctx.id } });
    const question = sse.events.find(e => e.event === "message")!.data;
    expect(question.role).toBe("assistant");
    expect(question.text).toContain("Freigabe nötig: Werkzeug web_test_write");
    expect(question.text).toContain("[redacted]");
    expect(question.text).not.toContain("geheim");
    expect(question.text).toContain("„ja“");
    expect(question.choice).toMatchObject({ id: approvalId, state: "open", options: [{ key: "allow", label: "Erlauben" }, { key: "deny", label: "Ablehnen" }] });
    // Kopie im Direktchat: dieselbe Frage, mit Hinweis auf das Web-Gespräch
    expect(telegramSent.map(c => c.id)).toEqual([approvalId]);
    expect(telegramSent[0].text).toMatch(/^\(Web-Gespräch „[^“]+“\)\nFreigabe nötig/);
    expect(await (await ctx.api(`/api/conversations/${ctx.id}`)).json()).toMatchObject({ running: true, awaiting: true, approvalId });
    // Neue Verbindung während der offenen Frage: erster status meldet sie samt Kennung
    const again = await listen(ctx.origin, ctx.cookie, ctx.id);
    await waitUntil(() => again.events.length >= 1);
    expect(again.events[0]).toEqual({ event: "status", data: { running: true, awaiting: true, approvalId } });
    again.close();
    expect(toolCalls).toHaveLength(0);
    await decideChoice(approvalId, "deny", "telegram");
    await history(ctx, 3);
    sse.close();
  });

  test("Klick im Browser gibt frei: Werkzeug einmal, Status ohne awaiting", async () => {
    const { ctx, sse, approvalId } = await started();
    const click = (option: string) =>
      ctx.api(`/api/conversations/${ctx.id}/choices/${approvalId}`, "POST", { option });
    const [first, second] = await Promise.all([click("allow"), click("allow")]);
    expect([first.status, second.status].sort()).toEqual([200, 409]);
    const list = await history(ctx, 3);
    expect(list.map(m => m.text)).toEqual(["Schreib die Notiz", expect.stringContaining("Freigabe nötig"), "Erledigt: geschrieben"]);
    expect(list[1].choice).toMatchObject({ state: "done", result: { key: "allow", via: "web" } });
    expect(toolCalls).toEqual([{ path: "notiz.txt", api_key: "geheim" }]);
    const statuses = sse.events.filter(e => e.event === "status").map(e => e.data);
    const awaitingAt = statuses.findIndex(s => s.awaiting);
    expect(statuses.slice(awaitingAt + 1)[0]).toEqual({ running: true, awaiting: false });
    sse.close();
  });

  test("Klick in Telegram: Browser sieht „Erledigt: Erlauben · in Telegram“, Werkzeug läuft", async () => {
    const { ctx, sse, approvalId } = await started();
    expect((await decideChoice(approvalId, "allow", "telegram")).status).toBe("decided");
    await waitUntil(() => sse.events.some(e => e.event === "choice"));
    const change = sse.events.find(e => e.event === "choice")!.data;
    expect(change.choice).toMatchObject({ id: approvalId, state: "done", result: { label: "Erlauben", via: "telegram" } });
    const list = await history(ctx, 3);
    expect(list[2].text).toBe("Erledigt: geschrieben");
    expect(toolCalls).toHaveLength(1);
    sse.close();
  });

  test("„ja“ als Text: über das Register entschieden (Quelle web), Antwort im Verlauf", async () => {
    const { ctx, sse, approvalId } = await started();
    // Ohne Kennung ist es keine Antwort auf die Frage
    expect((await ctx.api(`/api/conversations/${ctx.id}/messages`, "POST", { text: "ja" })).status).toBe(409);
    expect((await ctx.api(`/api/conversations/${ctx.id}/messages`, "POST", { text: "ja", approvalId })).status).toBe(202);
    const list = await history(ctx, 4);
    expect(list.map(m => [m.role, m.text.startsWith("Freigabe") ? "Frage" : m.text])).toEqual([
      ["user", "Schreib die Notiz"],
      ["assistant", "Frage"],
      ["user", "ja"],
      ["assistant", "Erledigt: geschrieben"],
    ]);
    expect((await getChoice(approvalId))!.result).toMatchObject({ key: "allow", via: "web" });
    expect(toolCalls).toHaveLength(1);
    sse.close();
  });

  test("jede andere Antwort lehnt ab", async () => {
    const { ctx, sse, approvalId } = await started();
    expect((await ctx.api(`/api/conversations/${ctx.id}/messages`, "POST", { text: "lieber nicht", approvalId })).status).toBe(202);
    const list = await history(ctx, 4);
    expect(list[3].text).toBe("Werkzeug abgelehnt.");
    expect((await getChoice(approvalId))!.result).toMatchObject({ key: "deny", via: "web" });
    expect(toolCalls).toHaveLength(0);
    sse.close();
  });

  test("Text-Antwort nach Klick in Telegram: veraltet (409), nicht im Verlauf, Werkzeug einmal", async () => {
    const { ctx, sse, approvalId } = await started();
    await decideChoice(approvalId, "allow", "telegram");
    const late = await ctx.api(`/api/conversations/${ctx.id}/messages`, "POST", { text: "nein", approvalId });
    expect(late.status).toBe(409);
    const list = await history(ctx, 3);
    expect(list.some(m => m.role === "user" && m.text === "nein")).toBe(false);
    expect(toolCalls).toHaveLength(1);
    sse.close();
  });

  test("fremde Kennung: 409, Frage bleibt offen", async () => {
    const { ctx, sse, approvalId } = await started();
    const other = await ctx.api(`/api/conversations/${ctx.id}/messages`, "POST", { text: "ja", approvalId: "AAAAAAAAAA" });
    expect(other.status).toBe(409);
    expect((await getChoice(approvalId))!.state).toBe("open");
    expect(await (await ctx.api(`/api/conversations/${ctx.id}`)).json()).toMatchObject({ awaiting: true, approvalId });
    await decideChoice(approvalId, "deny", "web");
    await history(ctx, 3);
    sse.close();
  });

  test("ohne Antwort nach Ablauf der Frist abgelehnt, Frage abgelaufen", async () => {
    const { ctx, sse, approvalId } = await started();
    expect(timers).toHaveLength(1);
    timers[0]();
    const list = await history(ctx, 3);
    expect(list[2].text).toBe("Werkzeug abgelehnt.");
    expect((await getChoice(approvalId))!.state).toBe("expired");
    expect(toolCalls).toHaveLength(0);
    // Nach dem Turn: eine Antwort mit Kennung startet keinen neuen Turn
    expect((await ctx.api(`/api/conversations/${ctx.id}/messages`, "POST", { text: "ja", approvalId })).status).toBe(409);
    sse.close();
  });

  test("Stopp während der Frage: abgelehnt, Frage abgelaufen, als Abbruch gemeldet", async () => {
    const { chat } = approvalSetup(async () => {
      const r = await callBuiltinTool("web_test_write", { path: "x" });
      return r.isError ? "Werkzeug abgelehnt." : "Erledigt";
    });
    const asked: string[] = [];
    const running = chat.runTurn({ ...turn(WEB_UUID), ask: async (_q, id) => void asked.push(id), endAsk: () => {} });
    await waitUntil(() => asked.length === 1);
    expect(chat.stop(WEB_UUID)).toBe(true);
    expect(await running).toEqual({ text: "", aborted: true });
    await waitUntil(async () => (await getChoice(asked[0]))!.state === "expired");
    expect(toolCalls).toHaveLength(0);
  });

  test("/critic in älteren Web-Gesprächen (withApprovals): Frage im Gespräch, Antwort über das Register", async () => {
    const { chat } = approvalSetup(fallbackCore);
    const asked: { id: string; record?: boolean }[] = [];
    const done = chat.withApprovals(WEB_UUID, { ask: async (_q, id, o) => void asked.push({ id, record: o?.record }), endAsk: () => {} }, () =>
      runExecution(`web:${WEB_UUID}`, "critic", () => fallbackCore())
    );
    await waitUntil(() => asked.length === 1);
    expect(asked[0].record).toBe(true);
    expect(await chat.answer!(WEB_UUID, "ja", asked[0].id, "terminal")).toBe(true);
    expect(await done).toBe("Erledigt: geschrieben");
    expect((await getChoice(asked[0].id))!.result).toMatchObject({ via: "terminal" });
  });

  /** Fake-Fallback mit zwei Werkzeuganfragen nacheinander (A, dann B) */
  const twoToolsCore = async () => {
    const a = await callBuiltinTool("web_test_write", { path: "a.txt" });
    const b = await callBuiltinTool("web_test_write", { path: "b.txt" });
    return `A ${a.isError ? "abgelehnt" : "erlaubt"}, B ${b.isError ? "abgelehnt" : "erlaubt"}`;
  };

  test("verspätete Zustimmung zu einer abgelaufenen Frage erlaubt nicht die nächste", async () => {
    const { chat } = approvalSetup(twoToolsCore);
    const ids: string[] = [];
    const running = chat.runTurn({ ...turn(WEB_UUID), ask: async (_q, id) => void ids.push(id), endAsk: () => {} });
    await waitUntil(() => ids.length === 1);
    timers[0]();
    // A läuft ab, B ist offen; dann trifft das Ja zu A ein
    await waitUntil(() => ids.length === 2);
    expect(ids[0]).not.toBe(ids[1]);
    expect(await chat.answer!(WEB_UUID, "ja", ids[0], "web")).toBe(false);
    expect((await getChoice(ids[1]))!.state).toBe("open");
    timers[1]();
    expect(await running).toEqual({ text: "A abgelehnt, B abgelehnt", info: { agent: "general" } });
    expect(toolCalls).toHaveLength(0);
  });
});

describe("startWebUi", () => {
  const fakeServer = (url: string): WebServer => ({ url, eventStreamCount: () => 0, stop: async () => {} });
  const noChat = { runTurn: async () => ({ text: "" }), stop() {} };

  test("deaktiviert: nur eine Log-Zeile, kein Server", async () => {
    const logs: string[] = [];
    let created = 0;
    const server = await startWebUi({
      env: {},
      chat: noChat,
      createServer: async () => (created++, fakeServer("http://127.0.0.1:3100")),
      log: m => logs.push(m),
    });
    expect(server).toBeNull();
    expect(created).toBe(0);
    expect(logs).toHaveLength(1);
  });

  test("ungültig (ohne Passwort): Log mit Grund, kein Server", async () => {
    const logs: string[] = [];
    let created = 0;
    const server = await startWebUi({
      env: { WEB_ENABLED: "true" },
      chat: noChat,
      createServer: async () => (created++, fakeServer("http://127.0.0.1:3100")),
      log: m => logs.push(m),
    });
    expect(server).toBeNull();
    expect(created).toBe(0);
    expect(logs[0]).toContain("WEB_PASSWORD fehlt");
  });

  test("Startfehler (Port belegt): Log ohne Passwort, kein Wurf", async () => {
    const logs: string[] = [];
    const server = await startWebUi({
      env: { WEB_ENABLED: "true", WEB_PASSWORD: PASSWORD, WEB_PORT: "3100" },
      chat: noChat,
      createServer: async () => {
        throw new Error(`Failed to start server. Is port 3100 in use? (${PASSWORD})`);
      },
      log: m => logs.push(m),
    });
    expect(server).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("port 3100 in use");
    expect(logs[0]).not.toContain(PASSWORD);
  });

  test("echter Startfehler: zweiter Server auf belegtem Port", async () => {
    const first = await createWebServer(
      { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
      { sessionFile: join(root, `busy-${++counter}.json`), dataDir: join(root, `busy-${counter}`), log: () => {} }
    );
    const logs: string[] = [];
    try {
      const port = new URL(first.url).port;
      const second = await startWebUi({
        env: { WEB_ENABLED: "true", WEB_PASSWORD: PASSWORD, WEB_PORT: port },
        chat: noChat,
        createServer: (config: WebConfig, deps) =>
          createWebServer(config, {
            ...deps,
            sessionFile: join(root, `busy2-${counter}.json`),
            dataDir: join(root, `busy2-${counter}`),
            cliTokenFile: join(root, `busy2-${counter}`, "cli-token"),
          }),
        log: m => logs.push(m),
      });
      expect(second).toBeNull();
      expect(logs.join("\n")).toContain("Bot läuft ohne WebUI weiter");
      expect(logs.join("\n")).not.toContain(PASSWORD);
    } finally {
      await first.stop();
    }
  });

  test("aktiviert auf 0.0.0.0: Log mit localhost und LAN-IPs, ohne Passwort; Chat wird übergeben", async () => {
    const logs: string[] = [];
    let passedChat: unknown;
    const chat = { runTurn: async () => ({ text: "" }), stop() {} };
    const server = await startWebUi({
      env: { WEB_ENABLED: "true", WEB_PASSWORD: PASSWORD, WEB_HOST: "0.0.0.0" },
      chat,
      createServer: async (_config, deps) => {
        passedChat = deps.chat;
        return fakeServer("http://0.0.0.0:3100");
      },
      lanAddresses: () => ["192.168.1.20"],
      log: m => logs.push(m),
    });
    expect(server).not.toBeNull();
    expect(passedChat).toBe(chat);
    expect(logs.at(-1)).toContain("http://localhost:3100, http://192.168.1.20:3100");
    expect(logs.join("\n")).not.toContain(PASSWORD);
  });

  test("Telegram-Quelle wird an den Server weitergereicht", async () => {
    let passed: WebServerDeps | undefined;
    const telegram = {
      listConversations: async () => ({ dm: null, topics: [] }),
      getConversation: async () => null,
      history: async () => null,
    };
    await startWebUi({
      env: { WEB_ENABLED: "true", WEB_PASSWORD: PASSWORD },
      chat: noChat,
      telegram,
      createServer: async (_config, deps) => {
        passed = deps;
        return fakeServer("http://127.0.0.1:3100");
      },
      log: () => {},
    });
    expect(passed?.telegram).toBe(telegram);
    expect(passed?.chat).toBe(noChat);
  });

  test("reachableUrls: fester Host bleibt, IPv6 in Klammern", () => {
    expect(reachableUrls("127.0.0.1", 3100, ["10.0.0.2"])).toEqual(["http://127.0.0.1:3100"]);
    expect(reachableUrls("192.168.1.20", 3100, [])).toEqual(["http://192.168.1.20:3100"]);
    expect(reachableUrls("::1", 3100, [])).toEqual(["http://[::1]:3100"]);
    expect(reachableUrls("::", 3100, ["10.0.0.2"])).toEqual(["http://localhost:3100", "http://10.0.0.2:3100"]);
  });
});
