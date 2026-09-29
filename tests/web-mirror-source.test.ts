/**
 * Issue #59, Schritt 3: Nachrichten tragen eine Quelle (web oder terminal),
 * der Spiegeltext in Telegram sagt, woher sie kam. Durchgängig vom
 * HTTP-Aufruf (Cookie oder lokaler Schlüssel) bis zum Text an Telegram;
 * Claude, Supabase und Telegram sind Attrappen, src/bot.ts wird nie importiert.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortAllExecutions, abortExecutions } from "../src/lib/execution-context";
import type { MessageSavedListener } from "../src/lib/convex";
import type { HistoryRow } from "../src/lib/supabase";
import { readCliToken } from "../src/web/cli-token";
import { createTelegramLiveFeed, createTelegramSource } from "../src/web/bot-telegram";
import { createTelegramChat, MIRROR_PREFIX, MIRROR_PREFIXES, mirrorChunks, type WebSavedMessage } from "../src/web/bot-turn";
import { createWebServer, type WebServer } from "../src/web/server";
import type { TelegramLiveEvent } from "../src/web/telegram";

const PASSWORD = "test-passwort-lang";
const GROUP = "-1001234567890";
const USER = "4711";
const root = await mkdtemp(join(tmpdir(), "tybo-mirror-source-"));
let counter = 0;
const servers: WebServer[] = [];

afterEach(async () => {
  abortAllExecutions();
  for (const s of servers.splice(0)) await s.stop();
});
afterAll(() => rm(root, { recursive: true, force: true }));

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

function telegramChat(state: { plain: { chatId: string; text: string; threadId?: number }[]; saved: WebSavedMessage[] }) {
  return createTelegramChat({
    userId: USER,
    groupId: () => GROUP,
    agentForTopic: topicId => (topicId === 443 ? "finance" : undefined),
    runStreamingTurn: async () => "Antwort",
    saveMessage: async m => {
      state.saved.push(m);
      return true;
    },
    processIntents: async () => {},
    abortEngineCalls: key => abortExecutions(key),
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    sendPlain: async (chatId, text, threadId) => {
      state.plain.push({ chatId, text, threadId });
    },
    sendAsAgent: async () => {},
    log: () => {},
  });
}

describe("Spiegeltext je Quelle", () => {
  test("Vorsätze: Web und Terminal", () => {
    expect(MIRROR_PREFIXES).toEqual({ web: "Du (Web): ", terminal: "Du (Terminal): " });
    expect(MIRROR_PREFIX).toBe("Du (Web): ");
    expect(mirrorChunks("Hallo")).toEqual(["Du (Web): Hallo"]);
    expect(mirrorChunks("Hallo", "web")).toEqual(["Du (Web): Hallo"]);
    expect(mirrorChunks("Hallo", "terminal")).toEqual(["Du (Terminal): Hallo"]);
  });

  test("Turn mit Quelle terminal: Spiegel „Du (Terminal): …“, channel web plus via terminal", async () => {
    const state = { plain: [], saved: [] } as { plain: any[]; saved: WebSavedMessage[] };
    const chat = telegramChat(state);
    const sink = { progress() {}, notice() {} };
    await chat.runTurn({ conversationId: "topic-443", agent: "general", text: "Stand?", source: "terminal", sink });
    await chat.runTurn({ conversationId: "topic-443", agent: "general", text: "Und jetzt?", sink });
    expect(state.plain.map(p => p.text)).toEqual(["Du (Terminal): Stand?", "Du (Web): Und jetzt?"]);
    expect(state.saved.map(m => [m.role, m.metadata?.channel, m.metadata?.via])).toEqual([
      ["user", "web", "terminal"],
      ["assistant", "web", "terminal"],
      ["user", "web", undefined],
      ["assistant", "web", undefined],
    ]);
  });

  test("Live-Filter: Terminal-Nachrichten (channel web) liefern nur die Aktivität, kein Inhalt doppelt", () => {
    let hook: MessageSavedListener | null = null;
    const live = createTelegramLiveFeed({
      userId: USER,
      groupId: () => GROUP,
      onMessageSaved: l => {
        hook = l;
        return () => {};
      },
      log: () => {},
    });
    const events: TelegramLiveEvent[] = [];
    const off = live.subscribe(e => events.push(e));
    const at = "2026-09-24T18:00:00.000Z";
    hook!({ chatId: GROUP, role: "user", content: "aus dem Terminal", metadata: { msgId: "web-x", topicId: 443, channel: "web", via: "terminal" }, createdAt: at });
    off();
    expect(events).toEqual([{ conversationId: "topic-443", at }]);
  });
});

describe("Durchgängig: HTTP-Aufruf bis Spiegeltext", () => {
  async function start() {
    const dir = join(root, `case-${++counter}`);
    const state = { plain: [], saved: [] } as { plain: { chatId: string; text: string; threadId?: number }[]; saved: WebSavedMessage[] };
    const telegram = createTelegramSource({
      userId: USER,
      groupId: () => GROUP,
      topicNames: async () => ({ "443": "Finanzen" }),
      topicMapping: () => ({ "443": "finance" }),
      history: async () => [] as HistoryRow[],
      activity: async () => [],
      log: () => {},
    });
    const tokenFile = join(dir, "cli-token");
    const server = await createWebServer(
      { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
      {
        sessionFile: join(dir, "web-sessions.json"),
        dataDir: join(dir, "web"),
        telegram,
        telegramChat: telegramChat(state),
        cliTokenFile: tokenFile,
        log: () => {},
      }
    );
    servers.push(server);
    const url = `http://127.0.0.1:${new URL(server.url).port}`;
    return { state, url, token: (await readCliToken(tokenFile))! };
  }

  function post(url: string, id: string, text: string, headers: Record<string, string>) {
    return fetch(`${url}/api/conversations/${id}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ text }),
    });
  }

  test("mit lokalem Schlüssel: „Du (Terminal): …“ im richtigen Topic", async () => {
    const { state, url, token } = await start();
    expect((await post(url, "topic-443", "Hallo aus dem Terminal", { authorization: `Bearer ${token}` })).status).toBe(202);
    await waitUntil(() => state.saved.length === 2);
    expect(state.plain).toEqual([{ chatId: GROUP, text: "Du (Terminal): Hallo aus dem Terminal", threadId: 443 }]);
  });

  test("mit Cookie aus dem Browser: „Du (Web): …“ wie bisher", async () => {
    const { state, url } = await start();
    const login = await fetch(`${url}/api/login`, { method: "POST", headers: { origin: url }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    expect((await post(url, "dm", "Hallo aus dem Browser", { cookie, origin: url })).status).toBe(202);
    await waitUntil(() => state.saved.length === 2);
    expect(state.plain).toEqual([{ chatId: USER, text: "Du (Web): Hallo aus dem Browser", threadId: undefined }]);
  });
});
