// Issue #562: Lehnt Telegram den Token ab (401), bleibt der Direktchat im
// Browser nutzbar. Eine Browser-Anfrage läuft durch den echten Web-Server und
// den echten Telegram-Turn; Telegram ist der echte grammY-Bot, dessen API ein
// Transformer abfängt und jeden Aufruf mit 401 beantwortet. Nichts geht ins
// Netz, src/bot.ts wird nicht importiert.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { Bot } from "grammy";
import { abortAllExecutions } from "../src/lib/execution-context";
import { createTelegramRuntime, type AgentBots } from "../src/lib/telegram-runtime";
import { TELEGRAM_REJECTED_TEXT } from "../src/web/bot-turn";
import type { WebServer } from "../src/web/server";
import { USER, fakeTelegramChat, listen, makeRoot, startAttachmentServer, type AttachmentCtx } from "./attachments-fixture";
import { isolateAgentCatalog } from "./catalog-fixture";

isolateAgentCatalog();

const TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn";

const root = await makeRoot("tybo-web-401-");
afterAll(() => root.cleanup());
const servers: WebServer[] = [];
afterEach(async () => {
  abortAllExecutions();
  for (const s of servers.splice(0)) await s.stop();
});

const fakeAgents: AgentBots = {
  initialize: async () => {},
  agentForMention: () => null,
  sendAsAgent: async () => {},
  sendTypingAsAgent: async () => {},
  sendWithKeyboardAsAgent: async () => {},
};

/** Echter Bot, jeder API-Aufruf endet mit 401 an der untersten Ebene */
function rejectedTelegram() {
  const methods: string[] = [];
  const runtime = createTelegramRuntime({
    env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_USER_ID: USER, TYBO_PROFILE: "local" },
    intake: { mode: "polling" },
    createBot: token => {
      const bot = new Bot(token);
      bot.api.config.use((async (_prev: unknown, method: string) => {
        methods.push(method);
        return { ok: false, error_code: 401, description: "Unauthorized" };
      }) as any);
      return bot;
    },
    createAgentBots: () => fakeAgents,
    log: () => {},
  });
  return { runtime, methods };
}

async function start(core: () => Promise<string> = async () => "Antwort aus dem Browser") {
  const telegram = rejectedTelegram();
  const logs: string[] = [];
  const agentCalls: string[] = [];
  const { rec, factory } = fakeTelegramChat(join(root.next(), "media"), {
    // Wie in src/app/bot-web.ts: Spiegeln und Antwort über den Haupt-Bot
    sendPlain: (chatId, text, threadId) => telegram.runtime.sendPlain(chatId, text, threadId),
    sendAsAgent: async (agent, chatId, text, threadId) => {
      agentCalls.push(agent);
      await telegram.runtime.sendPlain(chatId, text, threadId);
    },
    log: line => logs.push(line),
  });
  rec.core = core;
  const ctx = await startAttachmentServer({ dir: root.next(), servers, telegramChat: factory });
  return { ctx, rec, telegram, logs, agentCalls };
}

async function idle(ctx: AttachmentCtx, conversationId: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (!(await (await ctx.api(`/api/conversations/${conversationId}`)).json()).running) return;
    await Bun.sleep(5);
  }
  throw new Error("Turn läuft noch");
}

describe("Direktchat im Browser bei abgelehntem Token (401)", () => {
  test("Browser-Anfrage wird verarbeitet, die Antwort steht im Verlauf, Hinweis live, nur ein Versuch bei Telegram", async () => {
    const { ctx, rec, telegram, logs, agentCalls } = await start();
    const stream = await listen(ctx, "dm");
    const res = await ctx.api("/api/conversations/dm/messages", { method: "POST", body: { text: "Wie wird das Wetter?" } });
    expect(res.status).toBe(202);
    await idle(ctx, "dm");

    // Der Motor lief, die Weiterleitungen (Erinnerungen, Freigaben) gehen in die WebUI
    expect(rec.turns.length).toBe(1);
    expect(rec.turns[0]).toMatchObject({ userMessage: "Wie wird das Wetter?", chatId: USER, noTelegram: { conversationId: "dm" } });
    expect(rec.saved.map(m => [m.role, m.content])).toEqual([
      ["user", "Wie wird das Wetter?"],
      ["assistant", "Antwort aus dem Browser"],
    ]);

    // Antwort im Verlauf des Direktchats, wie nach dem Neuladen
    const history = await (await ctx.api("/api/conversations/dm/messages")).json();
    const contents = history.messages.map((m: any) => [m.role, m.text]);
    expect(contents).toContainEqual(["user", "Wie wird das Wetter?"]);
    expect(contents).toContainEqual(["assistant", "Antwort aus dem Browser"]);

    // Live im offenen Browser: Antwort und Hinweis auf Telegram
    const live = JSON.stringify(stream.events);
    expect(live).toContain("Antwort aus dem Browser");
    expect(live).toContain(TELEGRAM_REJECTED_TEXT);
    await stream.close();

    // Telegram: genau der gescheiterte Spiegel-Versuch, danach nichts mehr
    expect(telegram.methods).toEqual(["sendMessage"]);
    expect(agentCalls).toEqual([]);
    expect(logs.some(l => l.includes("Telegram lehnt den Token ab (401)"))).toBe(true);
    for (const line of [...logs, live]) expect(line).not.toContain(TOKEN);
  });

  test("zweite Anfrage im selben Gespräch läuft ebenso durch", async () => {
    let n = 0;
    const { ctx, rec, telegram } = await start(async () => `Antwort ${++n}`);
    for (const text of ["Erste Frage", "Zweite Frage"]) {
      expect((await ctx.api("/api/conversations/dm/messages", { method: "POST", body: { text } })).status).toBe(202);
      await idle(ctx, "dm");
    }
    expect(rec.saved.map(m => m.content)).toEqual(["Erste Frage", "Antwort 1", "Zweite Frage", "Antwort 2"]);
    expect(telegram.methods).toEqual(["sendMessage", "sendMessage"]);
  });
});
