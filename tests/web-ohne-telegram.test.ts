/**
 * Issue #227, Schritt 2: WebUI ohne Telegram. Direktchat "dm" unter der
 * Chat-ID "web" ohne Spiegeln, neues Gespräch ohne Gruppe als Web-Gespräch,
 * Live-Feed für "web" und Meldungen für Web-Gespräche (web:<uuid>) mit
 * Nachholen, Entdopplung, Datei und Rückfrage. Claude, Speicher und Telegram
 * sind Attrappen, src/bot.ts wird nie importiert.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortAllExecutions, abortExecutions } from "../src/lib/execution-context";
import type { MessageSavedListener } from "../src/lib/convex";
import type { HistoryOptions, HistoryRow } from "../src/lib/supabase";
import { createTelegramLiveFeed, createTelegramSource, liveConversationId } from "../src/web/bot-telegram";
import { createFileSource } from "../src/web/bot-files";
import { conversationSessionKey, createTelegramChat, mirrorsToTelegram, resolveTelegramTarget, type WebSavedMessage } from "../src/web/bot-turn";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import type { TelegramLiveEvent } from "../src/web/telegram";
import { startWebNoticeImport, toWebNotice, type WebNoticeEvent, type WebNoticeRow } from "../src/web/web-notices";

const PASSWORD = "test-passwort-lang";
const root = await mkdtemp(join(tmpdir(), "tybo-ohne-telegram-"));
let counter = 0;
const servers: WebServer[] = [];
afterEach(async () => {
  abortAllExecutions();
  for (const s of servers.splice(0)) await s.stop();
});
afterAll(() => rm(root, { recursive: true, force: true }));

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

const FILE_ID = "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a4b";

function webChat(state: { plain: unknown[]; agent: unknown[]; saved: WebSavedMessage[]; turns: { chatId: string; topicId?: number }[] }) {
  return createTelegramChat({
    userId: "web",
    groupId: () => null,
    agentForTopic: () => undefined,
    runStreamingTurn: async opts => {
      state.turns.push({ chatId: opts.chatId, topicId: opts.topicId });
      return "Antwort";
    },
    saveMessage: async m => {
      state.saved.push(m);
      return true;
    },
    processIntents: async () => {},
    abortEngineCalls: key => abortExecutions(key),
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    sendPlain: async (...args) => {
      state.plain.push(args);
    },
    sendAsAgent: async (...args) => {
      state.agent.push(args);
    },
    log: () => {},
  });
}

function webSource(rows: HistoryRow[] = [], reads: { chatId: string; topicId: number | null }[] = []) {
  return createTelegramSource({
    userId: "web",
    groupId: () => null,
    topicNames: async () => ({}),
    topicMapping: () => ({}),
    history: async (chatId: string, topicId: number | null, _o: HistoryOptions) => {
      reads.push({ chatId, topicId });
      return rows;
    },
    activity: async () => [],
    log: () => {},
  });
}

describe("Direktchat ohne Telegram", () => {
  test("Liste enthält dm, keine Topics; Verlauf aus der Chat-ID web", async () => {
    const reads: { chatId: string; topicId: number | null }[] = [];
    const source = webSource([{ id: "1", created_at: "2026-09-29T08:00:00.000Z", role: "user", content: "Hallo", metadata: { msgId: "web-a" } }], reads);
    expect(await source.listConversations()).toEqual({ dm: { id: "dm", title: "Direktchat", agent: "general", lastActivity: null }, topics: [] });
    const history = await source.history("dm");
    expect(history?.messages.map(m => m.text)).toEqual(["Hallo"]);
    expect(reads).toEqual([{ chatId: "web", topicId: null }]);
  });

  test("Ziel und Session: Chat web, Schlüssel dm:web, Agent general; Topics gibt es nicht", () => {
    const deps = { userId: "web", groupId: () => null, agentForTopic: () => undefined };
    expect(resolveTelegramTarget("dm", deps)).toEqual({ chatId: "web", sessionKey: "dm:web", agent: "general" });
    expect(resolveTelegramTarget("topic-443", deps)).toBeNull();
    expect(conversationSessionKey("dm", deps)).toBe("dm:web");
    expect(mirrorsToTelegram("web")).toBe(false);
    expect(mirrorsToTelegram("4711")).toBe(true);
  });

  test("Turn: kein Spiegel-Aufruf, keine Antwort nach Telegram, gespeichert unter web", async () => {
    const state = { plain: [], agent: [], saved: [], turns: [] } as Parameters<typeof webChat>[0];
    const chat = webChat(state);
    const result = await chat.runTurn({ conversationId: "dm", agent: "general", text: "Wie spät ist es?", sink: { progress() {}, notice() {} } });
    expect(result.text).toBe("Antwort");
    expect(state.plain).toEqual([]);
    expect(state.agent).toEqual([]);
    expect(state.turns).toEqual([{ chatId: "web", topicId: undefined }]);
    expect(state.saved.map(m => [m.chat_id, m.role, m.content])).toEqual([
      ["web", "user", "Wie spät ist es?"],
      ["web", "assistant", "Antwort"],
    ]);
  });

  test("Live-Feed: Einträge unter web gehören zu dm, die Abfrage fragt web mit ab", async () => {
    expect(liveConversationId({ chatId: "web", metadata: {} }, "web", null)).toBe("dm");
    expect(liveConversationId({ chatId: "web", metadata: { topicId: 5 } }, "web", null)).toBeNull();
    let hook: MessageSavedListener | null = null;
    const asked: string[][] = [];
    const live = createTelegramLiveFeed({
      userId: "web",
      groupId: () => null,
      onMessageSaved: l => {
        hook = l;
        return () => {};
      },
      displayOnly: {
        latestAt: async ids => {
          asked.push(ids);
          return null;
        },
        page: async ids => {
          asked.push(ids);
          return [];
        },
        every: () => () => {},
      },
      log: () => {},
    });
    const events: TelegramLiveEvent[] = [];
    const off = live.subscribe(e => events.push(e));
    const at = "2026-09-29T09:00:00.000Z";
    hook!({ chatId: "web", role: "assistant", content: "Briefing", metadata: { msgId: "11111111-2222-4333-8444-555555555555", display_only: true, source: "briefing" }, createdAt: at });
    await waitUntil(() => asked.length >= 2);
    off();
    expect(asked[0]).toEqual(["web"]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ conversationId: "dm", at, message: { kind: "notice", source: "briefing", text: "Briefing" } });
  });
});

describe("HTTP ohne Telegram", () => {
  async function start(extra: Parameters<typeof createWebServer>[1] = {}) {
    const dir = join(root, `case-${++counter}`);
    const state = { plain: [], agent: [], saved: [], turns: [] } as Parameters<typeof webChat>[0];
    const store = new ConversationStore({ dir: join(dir, "web") });
    await store.load();
    const server = await createWebServer(
      { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
      {
        sessionFile: join(dir, "web-sessions.json"),
        dataDir: join(dir, "web"),
        conversationStore: store,
        telegram: webSource(),
        telegramChat: webChat(state),
        cliTokenFile: join(dir, "cli-token"),
        log: () => {},
        ...extra,
      }
    );
    servers.push(server);
    const url = `http://127.0.0.1:${new URL(server.url).port}`;
    const login = await fetch(`${url}/api/login`, { method: "POST", headers: { origin: url }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const api = (path: string, method = "GET", body?: unknown) =>
      fetch(`${url}${path}`, {
        method,
        headers: { cookie, origin: url, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    return { state, store, api, dir };
  }

  test("GET /api/conversations enthält dm, POST ohne Gruppe liefert 201 mit Web-Gespräch", async () => {
    const { api, store } = await start();
    const list = await (await api("/api/conversations")).json();
    expect(list.telegram.dm).toMatchObject({ id: "dm", title: "Direktchat", agent: "general" });
    expect(list.telegram.topics).toEqual([]);
    expect(list.telegram.chatId).toBeUndefined();
    const res = await api("/api/conversations", "POST", { agent: "general" });
    expect(res.status).toBe(201);
    const { conversation } = await res.json();
    expect(conversation.agent).toBe("general");
    expect((await store.listConversations()).map(c => c.id)).toEqual([conversation.id]);
  });

  test("Nachricht im Direktchat: 202, kein Spiegel-Aufruf", async () => {
    const { api, state } = await start();
    expect((await api("/api/conversations/dm/messages", "POST", { text: "Hallo" })).status).toBe(202);
    await waitUntil(() => state.saved.length === 2);
    expect(state.plain).toEqual([]);
    expect(state.agent).toEqual([]);
  });

  test("Meldung für ein Web-Gespräch: übernommen mit Datei und Rückfrage, nachgeholt, nie doppelt", async () => {
    const rows: WebNoticeRow[] = [];
    let listener: ((e: WebNoticeEvent) => void | Promise<void>) | null = null;
    let tick: (() => Promise<void>) | null = null;
    const webNotices = {
      page: async (chatIds: string[]) => rows.filter(r => chatIds.includes(r.chat_id)),
      onMessageSaved: (l: (e: WebNoticeEvent) => void | Promise<void>) => {
        listener = l;
        return () => {};
      },
      every: (_ms: number, fn: () => Promise<void>) => {
        tick = fn;
        return () => {};
      },
    };
    const { api, store, dir } = await start({ webNotices });
    const { conversation } = await (await api("/api/conversations", "POST", { agent: "research" })).json();
    const chatId = `web:${conversation.id}`;
    rows.push(
      { id: 1, created_at: "2026-09-29T10:00:00.000Z", chat_id: chatId, role: "assistant", content: "Job fertig", metadata: { display_only: true, source: "job", msgId: "aaaaaaaa-1111-4111-8111-111111111111" } },
      {
        id: 2,
        created_at: "2026-09-29T10:00:01.000Z",
        chat_id: chatId,
        role: "assistant",
        content: "Bericht",
        metadata: { display_only: true, source: "datei", msgId: "aaaaaaaa-2222-4222-8222-222222222222", file: { id: FILE_ID, name: "bericht.pdf", size: 12, mime: "application/pdf" } },
      },
      { id: 3, created_at: "2026-09-29T10:00:02.000Z", chat_id: "web:ffffffff-ffff-4fff-8fff-ffffffffffff", role: "assistant", content: "fremd", metadata: { display_only: true, msgId: "aaaaaaaa-3333-4333-8333-333333333333" } },
      { id: 4, created_at: "2026-09-29T10:00:03.000Z", chat_id: chatId, role: "assistant", content: "kein Anzeige-Eintrag", metadata: { msgId: "aaaaaaaa-4444-4444-8444-444444444444" } }
    );
    await tick!();
    let messages = (await (await api(`/api/conversations/${conversation.id}/messages`)).json()).messages;
    expect(messages.map((m: any) => [m.id, m.kind, m.source, m.text])).toEqual([
      ["aaaaaaaa-1111-4111-8111-111111111111", "notice", "job", "Job fertig"],
      ["aaaaaaaa-2222-4222-8222-222222222222", "notice", "datei", "Bericht"],
    ]);
    expect(messages[1].file).toEqual({ id: FILE_ID, name: "bericht.pdf", size: 12, mime: "application/pdf" });
    const cursor = JSON.parse(await readFile(join(dir, "web", "notice-cursor.json"), "utf8"));
    expect(cursor.at).toBe("2026-09-29T10:00:03.000Z");

    // Hook dieses Prozesses (Rückfrage mit choiceId) und dieselbe Meldung noch einmal über die Abfrage
    const choiceRow = {
      id: 5,
      created_at: "2026-09-29T10:00:04.000Z",
      chat_id: chatId,
      role: "assistant",
      content: "Weiter?",
      metadata: { display_only: true, source: "goal", choiceId: "Ab12", msgId: "aaaaaaaa-5555-4555-8555-555555555555" },
    };
    await listener!({ chatId, role: "assistant", content: "Weiter?", metadata: choiceRow.metadata, createdAt: choiceRow.created_at });
    rows.push(choiceRow);
    await tick!();
    await tick!();
    messages = (await store.getMessages(conversation.id));
    expect(messages.map(m => m.id)).toEqual([
      "aaaaaaaa-1111-4111-8111-111111111111",
      "aaaaaaaa-2222-4222-8222-222222222222",
      "aaaaaaaa-5555-4555-8555-555555555555",
    ]);
    expect(messages[2].choiceId).toBe("Ab12");
  });

  test("Neustart: Meldungen aus der Ausfallzeit nachgeholt, bekannte nicht doppelt", async () => {
    const dir = join(root, `restart-${++counter}`);
    const store = new ConversationStore({ dir });
    await store.load();
    const conversation = await store.createConversation("general");
    const chatId = `web:${conversation.id}`;
    const rows: WebNoticeRow[] = [
      { id: 1, created_at: "2026-09-29T10:00:00.000Z", chat_id: chatId, role: "assistant", content: "vorher", metadata: { display_only: true, msgId: "bbbbbbbb-1111-4111-8111-111111111111" } },
    ];
    let cursorValue: string | null = null;
    const run = async () => {
      let tick: (() => Promise<void>) | null = null;
      const stop = startWebNoticeImport({
        conversationIds: async () => (await store.listConversations()).map(c => c.id),
        page: async (ids, o) => rows.filter(r => ids.includes(r.chat_id) && (!o.since || r.created_at >= o.since)),
        post: async (id, notice) => {
          await store.appendNoticeOnce(id, { role: "assistant", text: notice.text, kind: "notice" }, notice.id);
        },
        cursor: { read: async () => cursorValue, write: async at => void (cursorValue = at) },
        every: (_ms, fn) => {
          tick = fn;
          return () => {};
        },
        log: () => {},
      });
      await tick!();
      stop();
    };
    await run();
    // Bot aus; in der Zwischenzeit kommt eine Meldung
    rows.push({ id: 2, created_at: "2026-09-29T11:00:00.000Z", chat_id: chatId, role: "assistant", content: "während Ausfall", metadata: { display_only: true, msgId: "bbbbbbbb-2222-4222-8222-222222222222" } });
    await run();
    await run();
    expect((await store.getMessages(conversation.id)).map(m => m.text)).toEqual(["vorher", "während Ausfall"]);
    expect(cursorValue).toBe("2026-09-29T11:00:00.000Z");
  });

  test("Gelöschtes Gespräch: Meldungen fallen weg, Schreibfehler halten den Zeitpunkt an", async () => {
    const writes: string[] = [];
    let fail = true;
    let tick: (() => Promise<void>) | null = null;
    const conv = "cccccccc-1111-4111-8111-111111111111";
    const logs: string[] = [];
    startWebNoticeImport({
      conversationIds: async () => [conv],
      page: async () => [{ id: 1, created_at: "2026-09-29T10:00:00.000Z", chat_id: `web:${conv}`, role: "assistant", content: "x", metadata: { display_only: true, msgId: "cccccccc-2222-4222-8222-222222222222" } }],
      post: async () => {
        if (fail) throw new Error("EACCES");
      },
      cursor: { read: async () => null, write: async at => void writes.push(at) },
      every: (_ms, fn) => {
        tick = fn;
        return () => {};
      },
      log: m => logs.push(m),
    });
    await tick!();
    expect(writes).toEqual([]);
    expect(logs.join("\n")).toContain("nicht übernehmbar");
    fail = false;
    await tick!();
    expect(writes).toEqual(["2026-09-29T10:00:00.000Z"]);
  });

  test("toWebNotice: nur Nur-Anzeige-Einträge, geprüfte Felder", () => {
    expect(toWebNotice({ id: 7, role: "assistant", content: "x", metadata: { display_only: true } })).toEqual({ id: "db-7", text: "x" });
    expect(toWebNotice({ id: 7, role: "user", content: "x", metadata: { display_only: true } })).toBeNull();
    expect(toWebNotice({ id: 7, role: "assistant", content: "x", metadata: { display_only: "true" } })).toBeNull();
    expect(
      toWebNotice({ id: 7, role: "assistant", content: "x", metadata: { display_only: true, source: "Böse Quelle", choiceId: "../x", file: { id: "kaputt" }, path: "/etc/passwd" } })
    ).toEqual({ id: "db-7", text: "x" });
  });

  test("Datei-Download: Web-Gespräch nur, solange es das Gespräch gibt", async () => {
    const conv = "dddddddd-1111-4111-8111-111111111111";
    const asked: string[][] = [];
    const source = createFileSource({
      userId: "web",
      groupId: () => null,
      find: async (_id, chatIds) => {
        asked.push(chatIds);
        return chatIds.includes(`web:${conv}`)
          ? { id: "1", created_at: "2026-09-29T10:00:00.000Z", chat_id: `web:${conv}`, role: "assistant", content: "Bericht", metadata: { display_only: true, file: { id: FILE_ID, name: "bericht.pdf", size: 12, mime: "application/pdf" } } }
          : null;
      },
    });
    expect(await source.find(FILE_ID, [conv])).toMatchObject({ id: FILE_ID, name: "bericht.pdf" });
    expect(asked[0]).toEqual(["web", `web:${conv}`]);
    // Gespräch gelöscht: nicht mehr in der Liste, keine Datei
    expect(await source.find(FILE_ID, [])).toBeNull();
  });
});

describe("Befehle im Direktchat ohne Telegram", () => {
  test("/help: kein Spiegeln, Antwort über die Outbox an web, zugestellt auch ohne Telegram-Versand", async () => {
    const { createBotCommands } = await import("../src/web/bot-commands");
    const { commandRegistry } = await import("../src/lib/commands/builtin");
    const unused = () => {
      throw new Error("nicht erwartet");
    };
    const records: { chatId?: string; topicId?: number; buttons?: unknown }[] = [];
    const saved: WebSavedMessage[] = [];
    const commands = createBotCommands({
      registry: commandRegistry,
      services: {} as never,
      userId: "web",
      groupId: () => null,
      agentForTopic: () => undefined,
      sendPlain: unused,
      sendAndRecord: async input => {
        records.push({ chatId: input.chatId, topicId: input.topicId, buttons: input.buttons });
        return { sent: false, recorded: true };
      },
      saveMessage: async m => (saved.push(m), true),
      resetConversation: unused,
      runStreamingTurn: unused,
      processIntents: unused,
      sendAsAgent: unused,
      log: () => {},
    });
    const notices: string[] = [];
    const outcome = await commands.run({
      conversationId: "dm",
      agent: "general",
      text: "/help",
      source: "web",
      messageId: "m1",
      receivedAt: new Date().toISOString(),
      signal: new AbortController().signal,
      sink: {} as never,
      notice: async text => void notices.push(text),
      answer: async () => {},
      ask: async () => {},
      endAsk: () => {},
      commit: () => {},
    });
    expect(outcome.failed).toBeUndefined();
    expect(records).toEqual([{ chatId: "web", topicId: undefined, buttons: undefined }]);
    // Nicht über den Feed gemeldet wäre es nur live; festgehalten: kein zusätzlicher Hinweis
    expect(notices).toEqual([]);
    expect(saved.map(m => [m.chat_id, m.role])).toEqual([["web", "user"]]);
  });
});

describe("bun run notify bis ins Web-Gespräch", () => {
  test("mit TYBO_CONVERSATION_ID ohne Telegram: Meldung erscheint im Web-Gespräch, nie api.telegram.org", async () => {
    const { runNotify } = await import("../scripts/notify");
    const dir = join(root, `notify-${++counter}`);
    const rows: WebNoticeRow[] = [];
    const hooks = new Set<(e: WebNoticeEvent) => void | Promise<void>>();
    const fetched: string[] = [];
    let n = 0;
    const deps = {
      botToken: "",
      userId: "",
      groupId: null,
      outboxDir: join(dir, "outbox"),
      fetch: async (url: string) => {
        fetched.push(url);
        return new Response("{}");
      },
      record: async (m: { chat_id: string; role: string; content: string; metadata?: Record<string, unknown> }) => {
        const metadata = { ...(m.metadata ?? {}), msgId: crypto.randomUUID() };
        const created_at = new Date(Date.now() + ++n).toISOString();
        rows.push({ id: n, created_at, chat_id: m.chat_id, role: m.role, content: m.content, metadata });
        for (const h of hooks) await h({ chatId: m.chat_id, role: m.role, content: m.content, metadata, createdAt: created_at });
        return true;
      },
      log: () => {},
      newId: () => crypto.randomUUID(),
    };
    const store = new ConversationStore({ dir: join(dir, "web") });
    await store.load();
    const server = await createWebServer(
      { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
      {
        sessionFile: join(dir, "web-sessions.json"),
        dataDir: join(dir, "web"),
        conversationStore: store,
        telegram: webSource(),
        cliTokenFile: join(dir, "cli-token"),
        webNotices: {
          page: async ids => rows.filter(r => ids.includes(r.chat_id)),
          onMessageSaved: l => {
            hooks.add(l);
            return () => void hooks.delete(l);
          },
          every: () => () => {},
        },
        log: () => {},
      }
    );
    servers.push(server);
    const conversation = await store.createConversation("research");
    const out: string[] = [];
    const code = await runNotify(["--source", "job", "--text", "Job fertig"], () => deps as never, { out: l => void out.push(l), err: l => void out.push(l) }, {
      TYBO_CONVERSATION_ID: conversation.id,
    });
    expect(code).toBe(0);
    await waitUntil(async () => (await store.getMessages(conversation.id)).length === 1);
    const [message] = await store.getMessages(conversation.id);
    expect(message).toMatchObject({ kind: "notice", source: "job", text: "Job fertig" });
    expect(rows.map(r => r.chat_id)).toEqual([`web:${conversation.id}`]);
    expect(fetched).toEqual([]);
  });
});
