// Agent, Modell und Dauer unter jeder Antwort (Issue #22): Messung im
// Chat-Kern steht in chat-turn.test.ts; hier Speicherung in Web-Gesprächen
// (StoredMessage), in Telegram-Gesprächen (metadata) und in src/bot.ts
// (statisch, bot.ts wird nur als Text gelesen, nie importiert).
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ABORT_REPLY, type TurnOptions } from "../src/lib/chat-turn";
import type { MessageSavedListener } from "../src/lib/convex";
import type { HistoryRow } from "../src/lib/supabase";
import { abortAllExecutions, abortExecutions } from "../src/lib/execution-context";
import type { RunTurnOptions } from "../src/web/chat";
import {
  createBotChat,
  createTelegramChat,
  replyInfoFrom,
  type BotChatDeps,
  type WebSavedMessage,
} from "../src/web/bot-turn";
import { createTelegramLiveFeed, createTelegramSource } from "../src/web/bot-telegram";
import { createWebServer, type WebServer, type WebServerDeps } from "../src/web/server";
import { ConversationStore, pickReplyInfo } from "../src/web/store";
import { createTelegramMessageLog } from "../src/web/telegram";

const root = await mkdtemp(join(tmpdir(), "tybo-reply-info-"));
let counter = 0;
afterAll(() => rm(root, { recursive: true, force: true }));
afterEach(() => abortAllExecutions());

const GROUP = "-1001234567890";
const USER = "4711";
const INFO = { agent: "research", model: "claude-opus-5-5", durationMs: 42_000 };

function deps(core: (o: TurnOptions) => Promise<string>, saved: WebSavedMessage[]): BotChatDeps {
  return {
    runStreamingTurn: core,
    saveMessage: async m => {
      saved.push(m);
      return true;
    },
    processIntents: async () => {},
    abortClaudeCalls: key => abortExecutions(key),
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
  };
}

function turn(conversationId: string, agent = "research"): RunTurnOptions {
  return { conversationId, agent, text: "Frage", sink: { progress() {}, notice() {} } };
}

describe("pickReplyInfo", () => {
  test("übernimmt nur gültige Angaben", () => {
    expect(pickReplyInfo(INFO)).toEqual(INFO);
    expect(pickReplyInfo({ agent: "<script>", model: "a\nb", durationMs: -1 })).toEqual({});
    expect(pickReplyInfo({ model: "x".repeat(101), durationMs: Number.NaN })).toEqual({});
    expect(pickReplyInfo({ durationMs: 1234.6 })).toEqual({ durationMs: 1235 });
    expect(pickReplyInfo({ durationMs: 86_400_001 })).toEqual({});
    expect(pickReplyInfo({ model: "  qwen3:8b  " })).toEqual({ model: "qwen3:8b" });
    // HTML-artige Modellnamen bleiben Text; entschärft wird bei der Anzeige (textContent)
    expect(pickReplyInfo({ model: "<img src=x>" })).toEqual({ model: "<img src=x>" });
    expect(pickReplyInfo(null)).toEqual({});
    expect(pickReplyInfo("x")).toEqual({});
  });

  test("replyInfoFrom: ohne Meldung nur der Agent, nie ein Modell", () => {
    expect(replyInfoFrom("general", undefined)).toEqual({ agent: "general" });
    expect(replyInfoFrom("general", { agent: "general", durationMs: 10 })).toEqual({ agent: "general", durationMs: 10 });
    expect(replyInfoFrom("general", INFO)).toEqual(INFO);
  });
});

describe("Web-Gespräch (createBotChat)", () => {
  test("Antwort trägt agent, model, durationMs im Ergebnis und im Gedächtnis", async () => {
    const saved: WebSavedMessage[] = [];
    const chat = createBotChat(
      deps(async o => {
        o.onInfo?.({ ...INFO, agent: o.agentName });
        return "Antwort";
      }, saved)
    );
    const result = await chat.runTurn(turn("w1"));
    expect(result).toEqual({ text: "Antwort", info: INFO });
    expect(saved[1]).toEqual({
      chat_id: "web:w1",
      role: "assistant",
      content: "Antwort",
      metadata: { agent: "research", model: "claude-opus-5-5", durationMs: 42_000, channel: "web" },
    });
    // Die Nutzernachricht bekommt nichts davon
    expect(saved[0]!.metadata).toEqual({ channel: "web" });
  });

  test("Fallback: das Fallback-Modell wird gespeichert", async () => {
    const saved: WebSavedMessage[] = [];
    const chat = createBotChat(
      deps(async o => {
        o.onInfo?.({ agent: o.agentName, model: "minimax/minimax-m2.7", durationMs: 9_000 });
        return "Ersatz\n\n_(responded via openrouter)_";
      }, saved)
    );
    const result = await chat.runTurn(turn("w2"));
    expect(result.info?.model).toBe("minimax/minimax-m2.7");
    expect(saved[1]!.metadata).toMatchObject({ model: "minimax/minimax-m2.7" });
  });

  test("Abbruch: keine Angaben, nichts gespeichert", async () => {
    const saved: WebSavedMessage[] = [];
    const chat = createBotChat(deps(async () => ABORT_REPLY, saved));
    const result = await chat.runTurn(turn("w3"));
    expect(result).toEqual({ text: "", aborted: true });
    expect(saved.map(m => m.role)).toEqual(["user"]);
  });
});

describe("Telegram-Gespräch (createTelegramChat)", () => {
  function telegramChat(core: (o: TurnOptions) => Promise<string>, saved: WebSavedMessage[]) {
    return createTelegramChat({
      ...deps(core, saved),
      userId: USER,
      groupId: () => GROUP,
      agentForTopic: () => "finance",
      sendPlain: async () => {},
      sendAsAgent: async () => {},
    });
  }

  test("metadata der Antwort mit agent, model, durationMs; Ergebnis ebenso", async () => {
    const saved: WebSavedMessage[] = [];
    const chat = telegramChat(async o => {
      o.onInfo?.({ agent: o.agentName, model: "claude-opus-5-5", durationMs: 1_234 });
      return "**Budget ok**";
    }, saved);
    const result = await chat.runTurn({ ...turn("topic-443"), messageId: undefined });
    expect(result.info).toEqual({ agent: "finance", model: "claude-opus-5-5", durationMs: 1_234 });
    const reply = saved.find(m => m.role === "assistant")!;
    expect(reply.metadata).toMatchObject({ topicId: 443, agent: "finance", model: "claude-opus-5-5", durationMs: 1_234, channel: "web" });
    expect(saved.find(m => m.role === "user")!.metadata).not.toHaveProperty("model");
  });
});

describe("Ablage", () => {
  test("ConversationStore speichert die Angaben mit der Antwort, nicht bei Nutzernachrichten, und liest sie wieder", async () => {
    const dir = join(root, `store-${++counter}`);
    const store = new ConversationStore({ dir });
    const c = await store.createConversation("research");
    await store.appendMessage(c.id, { role: "user", text: "Frage", ...INFO });
    const stored = await store.appendMessage(c.id, { role: "assistant", text: "Antwort", ...INFO });
    expect(stored).toMatchObject(INFO);
    // ungültige Werte fallen weg
    await store.appendMessage(c.id, { role: "assistant", text: "alt", model: "a\u0007b", durationMs: -5 });

    const reloaded = await new ConversationStore({ dir }).getMessages(c.id);
    expect(reloaded[0]).not.toHaveProperty("model");
    expect(reloaded[1]).toMatchObject(INFO);
    expect(reloaded[2]).not.toHaveProperty("model");
    expect(reloaded[2]).not.toHaveProperty("durationMs");
    const raw = await readFile(join(dir, `${c.id}.jsonl`), "utf8");
    expect(raw.split("\n")[1]).toContain('"durationMs":42000');
  });

  test("Protokoll der Telegram-Gespräche reicht die Angaben der Antwort durch", async () => {
    const log = createTelegramMessageLog(() => 0);
    const reply = await log.appendMessage("topic-443", { role: "assistant", text: "x", ...INFO });
    expect(reply).toMatchObject(INFO);
    const user = await log.appendMessage("topic-443", { role: "user", text: "x", ...INFO });
    expect(user).not.toHaveProperty("agent");
  });
});

describe("src/bot.ts: direkt in Telegram ausgelöste Antworten", async () => {
  const bot = await Bun.file(join(import.meta.dir, "..", "src", "bot.ts")).text();
  const body = (name: string) => {
    const start = bot.indexOf(`async function ${name}(`);
    expect(start).toBeGreaterThan(0);
    const next = bot.indexOf("\nasync function ", start + 10);
    return bot.slice(start, next < 0 ? undefined : next);
  };

  test("JSON- und Streaming-Turn bekommen onInfo durchgereicht", () => {
    expect(body("callClaudeUnlocked")).toMatch(/runJsonTurn\(\{[\s\S]*onInfo,\n/);
    expect(body("callClaudeWithProgressUnlocked")).toMatch(/runStreamingTurn\(\{[\s\S]*onInfo,\n/);
    expect(body("callClaude")).toContain("callClaudeUnlocked(userMessage, chatId, agentName, topicId, onInfo, onTools)");
    expect(body("callClaudeWithProgress")).toContain("callClaudeWithProgressUnlocked(ctx, userMessage, chatId, agentName, topicId, onInfo, onTools)");
  });

  test("Textantworten speichern Modell und Dauer in metadata", () => {
    const src = body("callClaudeAndReply");
    expect(src).toContain("const turn = turnInfoCollector();");
    expect(src).toContain("callClaudeWithProgress(ctx, userMessage, chatId, agentName, topicId, turn.onInfo, turn.onTools)");
    expect(src).toContain("callClaude(userMessage, chatId, agentName, topicId, turn.onInfo, turn.onTools)");
    expect(src).toContain("metadata: { agent: agentName, topicId, ...turn.metadata() }");
  });
});

// ---------------------------------------------------------------------------
// API: Verlauf, SSE und erneutes Laden (Schritt 2)
// ---------------------------------------------------------------------------

const PASSWORD = "test-passwort-lang";
const servers: WebServer[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop({ graceMs: 100 });
});

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

async function serve(dir: string, extra: Partial<WebServerDeps>) {
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    { sessionFile: join(dir, "sessions.json"), dataDir: join(dir, "web"), log: () => {}, ...extra }
  );
  servers.push(server);
  const origin = server.url;
  const login = await fetch(`${origin}/api/login`, { method: "POST", headers: { origin }, body: JSON.stringify({ password: PASSWORD }) });
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const api = (path: string, method = "GET", body?: unknown) =>
    fetch(`${origin}${path}`, {
      method,
      headers: { cookie, origin, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  /** SSE eines Gesprächs mitlesen */
  const listen = async (id: string) => {
    const events: { event: string; data: any }[] = [];
    const controller = new AbortController();
    const res = await fetch(`${origin}/api/conversations/${id}/events`, { headers: { cookie }, signal: controller.signal });
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
    })();
    await waitUntil(() => events.length > 0);
    return { events, close: () => controller.abort() };
  };
  return { server, api, listen };
}

const TAGGED =
  "**Plan** steht.\n[REMEMBER: Alex mag kurze Antworten]\n[GOAL: Budget klären]\nWeiter [DONE: alt] mit [CANCEL: x] und [FORGET: y].\n" +
  "[INVOKE:research|Zahlen?]\n[ASSET_DESC: Foto vom Tisch]\n\n```ts\nconst a = 1;\n```";
const TAGGED_COPY = "**Plan** steht.\nWeiter mit und.\n\n```ts\nconst a = 1;\n```";

describe("API: Web-Gespräch", () => {
  test("SSE, Verlauf und Neustart liefern agent, model, durationMs und copyText; Rohtext für die Merk-Tags", async () => {
    const dir = join(root, `api-${++counter}`);
    const saved: WebSavedMessage[] = [];
    const intents: string[] = [];
    const chat = createBotChat({
      ...deps(async o => {
        o.onInfo?.({ agent: o.agentName, model: "claude-opus-5-5", durationMs: 42_000 });
        return TAGGED;
      }, saved),
      processIntents: async t => {
        intents.push(t);
      },
    });
    // Älteres Web-Gespräch vorab anlegen: seit Issue #29 legt die API keine mehr an
    const seed = new ConversationStore({ dir: join(dir, "web") });
    await seed.load();
    const id = (await seed.createConversation("research")).id;
    const first = await serve(dir, { chat });
    const sse = await first.listen(id);
    expect((await first.api(`/api/conversations/${id}/messages`, "POST", { text: "Plan?" })).status).toBe(202);
    await waitUntil(() => sse.events.some(e => e.event === "message"));
    sse.close();

    const live = sse.events.find(e => e.event === "message")!.data;
    expect(live).toMatchObject({ role: "assistant", agent: "research", model: "claude-opus-5-5", durationMs: 42_000 });
    expect(live.copyText).toBe(TAGGED_COPY);
    // text bleibt roh (unverändert gespeichert), processIntents bekam ihn ebenso
    expect(live.text).toBe(TAGGED);
    expect(intents).toEqual([TAGGED]);

    const history = (await (await first.api(`/api/conversations/${id}/messages`)).json()).messages;
    expect(history[1]).toEqual(live);
    expect(history[0]).not.toHaveProperty("model");
    expect(history[0]).not.toHaveProperty("copyText");

    // Neustart: neuer Server auf denselben Daten
    await first.server.stop({ graceMs: 100 });
    const second = await serve(dir, { chat });
    const reloaded = (await (await second.api(`/api/conversations/${id}/messages`)).json()).messages;
    expect(reloaded[1]).toEqual(live);
  });

  test("alte Nachrichten ohne Felder: nur was da ist, nichts erfunden; kaputte Werte fallen weg", async () => {
    const dir = join(root, `api-${++counter}`);
    const store = new ConversationStore({ dir: join(dir, "web") });
    const c = await store.createConversation("general");
    await store.appendMessage(c.id, { role: "user", text: "Frage" });
    // von Hand geschrieben wie vor Issue #22, dazu eine Zeile mit untergeschobenen Werten
    await writeFile(
      join(dir, "web", `${c.id}.jsonl`),
      [
        { id: "u1", role: "user", text: "Frage", createdAt: "2026-09-23T10:00:00.000Z" },
        { id: "a1", role: "assistant", text: "alt", createdAt: "2026-09-23T10:01:00.000Z" },
        { id: "a2", role: "assistant", text: "komisch", createdAt: "2026-09-23T10:02:00.000Z", model: 5, durationMs: "7", agent: "<b>" },
      ]
        .map(m => JSON.stringify(m))
        .join("\n") + "\n"
    );
    const { api } = await serve(dir, {});
    const messages = (await (await api(`/api/conversations/${c.id}/messages`)).json()).messages;
    expect(messages[1]).toEqual({ id: "a1", role: "assistant", text: "alt", createdAt: "2026-09-23T10:01:00.000Z", html: "<p>alt</p>\n", copyText: "alt" });
    expect(Object.keys(messages[2]).sort()).toEqual(["copyText", "createdAt", "html", "id", "role", "text"]);
  });
});

describe("API: Telegram-Gespräch", () => {
  function setupTelegram() {
    const rows: HistoryRow[] = [];
    let rowCounter = 0;
    const saved: WebSavedMessage[] = [];
    const listeners = new Set<MessageSavedListener>();
    const save = (m: WebSavedMessage) => {
      saved.push(m);
      const row = {
        id: `row-${++rowCounter}`,
        created_at: new Date(Date.UTC(2026, 8, 23, 10, 0, rowCounter)).toISOString(),
        role: m.role,
        content: m.content,
        metadata: m.metadata ?? null,
        chat_id: m.chat_id,
      } as HistoryRow;
      rows.push(row);
      for (const l of listeners) l({ chatId: m.chat_id, role: m.role, content: m.content, metadata: m.metadata ?? {}, createdAt: row.created_at } as any);
      return true;
    };
    const telegramChat = createTelegramChat({
      ...deps(async o => {
        o.onInfo?.({ agent: o.agentName, model: "minimax/minimax-m2.7", durationMs: 7_500 });
        return "Budget **ok** [REMEMBER: Budget ok]";
      }, []),
      saveMessage: async m => save(m),
      userId: USER,
      groupId: () => GROUP,
      agentForTopic: () => "finance",
      sendPlain: async () => {},
      sendAsAgent: async () => {},
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
    const telegramLive = createTelegramLiveFeed({
      userId: USER,
      groupId: () => GROUP,
      onMessageSaved: l => {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      log: () => {},
    });
    return { telegramChat, telegram, telegramLive, save, saved };
  }

  test("im Web geschrieben: SSE und Verlauf tragen das Fallback-Modell", async () => {
    const t = setupTelegram();
    const { api, listen } = await serve(join(root, `api-${++counter}`), { telegram: t.telegram, telegramChat: t.telegramChat, telegramLive: t.telegramLive });
    const sse = await listen("topic-443");
    expect((await api("/api/conversations/topic-443/messages", "POST", { text: "Budget?" })).status).toBe(202);
    await waitUntil(() => sse.events.some(e => e.event === "message" && e.data.role === "assistant"));
    sse.close();
    const live = sse.events.find(e => e.event === "message" && e.data.role === "assistant")!.data;
    expect(live).toMatchObject({ agent: "finance", model: "minimax/minimax-m2.7", durationMs: 7_500, copyText: "Budget **ok**" });

    const history = (await (await api("/api/conversations/topic-443/messages")).json()).messages;
    const reply = history.find((m: any) => m.role === "assistant");
    expect(reply).toMatchObject({ id: live.id, agent: "finance", model: "minimax/minimax-m2.7", durationMs: 7_500, copyText: "Budget **ok**" });
  });

  test("direkt in Telegram geschrieben: Live-Nachricht und Verlauf mit den Angaben aus metadata", async () => {
    const t = setupTelegram();
    const { api, listen } = await serve(join(root, `api-${++counter}`), { telegram: t.telegram, telegramChat: t.telegramChat, telegramLive: t.telegramLive });
    const sse = await listen("topic-443");
    // wie callClaudeAndReply in src/bot.ts: agent, topicId und turn.metadata()
    t.save({
      chat_id: GROUP,
      role: "assistant",
      content: "Aus Telegram",
      metadata: { agent: "finance", topicId: 443, msgId: "0b7c2f7e-5a52-4c38-9d11-2f5e0c7b9a10", model: "claude-opus-5-5", durationMs: 3_000 },
    });
    // alte Antwort ohne Angaben
    t.save({ chat_id: GROUP, role: "assistant", content: "Alt", metadata: { topicId: 443, msgId: "1c2d3e4f-5a52-4c38-9d11-2f5e0c7b9a10" } });
    await waitUntil(() => sse.events.filter(e => e.event === "message").length >= 2);
    sse.close();
    const [fresh, old] = sse.events.filter(e => e.event === "message").map(e => e.data);
    expect(fresh).toMatchObject({ agent: "finance", model: "claude-opus-5-5", durationMs: 3_000 });
    expect(old).not.toHaveProperty("model");
    expect(old).not.toHaveProperty("durationMs");

    const history = (await (await api("/api/conversations/topic-443/messages")).json()).messages;
    expect(history[0]).toMatchObject({ agent: "finance", model: "claude-opus-5-5", durationMs: 3_000 });
    expect(history[1]).not.toHaveProperty("model");
  });
});
