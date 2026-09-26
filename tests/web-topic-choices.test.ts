/**
 * Topic-Zuordnung „Welcher Agent?" im Browser (Issue #119): echter Web-Server,
 * echte Telegram-Quelle und echter Live-Feed mit Attrappen für den
 * Nachrichtenspeicher, echtes Rückfragen-Register, echter Katalog und eine
 * Kopie von config/topics.json im Temp-Verzeichnis, verdrahtet wie in
 * src/bot.ts (Zuhörer auf onTopicMappingSet, Topic-Änderung an den Live-Feed).
 * Geprüft: Frage mit allen Agenten im Topic, Klick schreibt die Zuordnung
 * genau einmal, Sammelstrom meldet das Topic, die Liste zeigt den neuen
 * Agenten, fremdes Gespräch wird abgewiesen, Einstellungen lassen die Frage
 * ablaufen. src/bot.ts wird nie geladen.
 */
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgent, getAgentCatalogPaths, listAgents } from "../src/agents/catalog";
import { getChoice, onChoiceDecided, setChoicesFileForTests } from "../src/lib/choices";
import type { MessageSavedListener } from "../src/lib/convex";
import type { HistoryRow } from "../src/lib/supabase";
import { createTopicChoices, type TopicChoices } from "../src/lib/topic-choices";
import { onTopicMappingSet } from "../src/lib/topic-setup";
import type { RunTurnOptions, WebChat } from "../src/web/chat";
import { createTelegramLiveFeed, createTelegramSource } from "../src/web/bot-telegram";
import { botSetMapping } from "../src/web/bot-topics";
import { createWebServer, TELEGRAM_ACTIVITY_PATH, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { createTopicChangeHub } from "../src/web/topic-changes";
import { isolateAgentCatalog } from "./catalog-fixture";
import { testChoices, type TestChoices } from "./choices-fixture";

const PASSWORD = "test-passwort-lang";
const USER = "4711";
const GROUP = "-1001234567890";
const TOPIC = 77;
const LONG_ID = "a" + "b".repeat(28) + "c";

isolateAgentCatalog();
const root = await mkdtemp(join(tmpdir(), "tybo-web-topic-choices-"));
let counter = 0;
const servers: WebServer[] = [];
const cleanups: (() => void)[] = [];

afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  for (const s of servers.splice(0)) await s.stop();
});
afterAll(async () => {
  setChoicesFileForTests(null);
  await rm(root, { recursive: true, force: true });
});

class QuietChat implements WebChat {
  async runTurn(_opts: RunTurnOptions) {
    return { text: "Antwort" };
  }
  stop() {}
}

function topicsFile(): string {
  return getAgentCatalogPaths().topicsFile!;
}

function topicsOnDisk(): Record<string, Record<string, string>> {
  return existsSync(topicsFile()) ? JSON.parse(readFileSync(topicsFile(), "utf8")) : {};
}

interface Ctx {
  url: string;
  cookie: string;
  choices: TestChoices;
  topics: TopicChoices;
  mappingEvents: { agent: string }[];
  notices: string[];
}

async function start(): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const choices = testChoices(join(dir, "choices.json"), { userId: USER, groupId: GROUP });
  const rows: (HistoryRow & { chat_id: string })[] = [];
  let hook: MessageSavedListener | null = null;
  let n = 0;
  const save = async (chatId: string, content: string, metadata: Record<string, unknown>) => {
    const row = { id: `row-${++n}`, chat_id: chatId, created_at: new Date(Date.now() + n).toISOString(), role: "assistant", content, metadata } as any;
    rows.push(row);
    await hook?.({ chatId, role: "assistant", content, metadata, createdAt: row.created_at });
  };
  const hub = createTopicChangeHub(() => {});
  const telegram = createTelegramSource({
    userId: USER,
    groupId: () => GROUP,
    topicNames: async () => ({ [String(TOPIC)]: "Neues Projekt", "8": "Finanzen" }),
    topicMapping: chatId => topicsOnDisk()[chatId] ?? {},
    history: async (chatId, topicId) =>
      rows.filter(r => r.chat_id === chatId && ((r.metadata as any)?.topicId ?? null) === topicId),
    activity: async () => [],
    log: () => {},
  });
  const telegramLive = createTelegramLiveFeed({
    userId: USER,
    groupId: () => GROUP,
    onMessageSaved: listener => {
      hook = listener;
      return () => {
        hook = null;
      };
    },
    onTopicChanged: hub.on,
    log: () => {},
  });
  const mappingEvents: { agent: string }[] = [];
  const notices: string[] = [];
  // Wie bot.ts: sendChoice hält die Frage mit choiceId im Topic fest
  const topics = createTopicChoices({
    sendChoice: async c => {
      await save(GROUP, c.text, { display_only: true, source: "topic", choiceId: c.id, msgId: crypto.randomUUID(), topicId: TOPIC });
      return { sent: true };
    },
    notify: async input => {
      notices.push(input.text!);
      await save(GROUP, input.text!, { display_only: true, source: "topic", msgId: crypto.randomUUID(), topicId: input.topicId });
      return { sent: true, recorded: true };
    },
    topicChanged: change => hub.emit(change),
    topicsFile: topicsFile(),
    log: () => {},
  });
  cleanups.push(
    onChoiceDecided("topicmap", topics.handler),
    onTopicMappingSet(topics.listener),
    onTopicMappingSet(change => mappingEvents.push({ agent: change.agent }))
  );
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "sessions.json"),
      conversationStore: store,
      chat: new QuietChat(),
      telegram,
      telegramChat: new QuietChat(),
      telegramLive,
      choices: choices.port,
      cliTokenFile: join(dir, "cli-token"),
      keepaliveMs: 60_000,
      log: () => {},
    }
  );
  servers.push(server);
  const res = await fetch(`${server.url}/api/login`, { method: "POST", headers: { origin: server.url }, body: JSON.stringify({ password: PASSWORD }) });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0];
  await choices.tick();
  return { url: server.url, cookie, choices, topics, mappingEvents, notices };
}

function post(ctx: Ctx, conversationId: string, choiceId: string, option: string) {
  return fetch(`${ctx.url}/api/conversations/${conversationId}/choices/${choiceId}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ctx.url, cookie: ctx.cookie },
    body: JSON.stringify({ option }),
  });
}

async function messages(ctx: Ctx, conversationId: string): Promise<any[]> {
  const res = await fetch(`${ctx.url}/api/conversations/${conversationId}/messages`, { headers: { cookie: ctx.cookie } });
  expect(res.status).toBe(200);
  return (await res.json()).messages;
}

async function topicAgent(ctx: Ctx, id: string): Promise<string | undefined> {
  const res = await fetch(`${ctx.url}/api/conversations`, { headers: { cookie: ctx.cookie } });
  const body = await res.json();
  return body.telegram.topics.find((t: any) => t.id === id)?.agent;
}

async function listen(ctx: Ctx, path: string) {
  const controller = new AbortController();
  const res = await fetch(`${ctx.url}${path}`, { headers: { cookie: ctx.cookie }, signal: controller.signal });
  expect(res.status).toBe(200);
  const events: { event: string; data: any }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let opened = false;
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      opened = true;
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
  await waitUntil(() => opened);
  return { of: (name: string) => events.filter(e => e.event === name).map(e => e.data) };
}

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

async function ask(ctx: Ctx): Promise<string> {
  expect(await ctx.topics.ask(GROUP, TOPIC)).toBe(true);
  const [m] = await messages(ctx, `topic-${TOPIC}`);
  return m.choice.id;
}

describe("Frage im Browser", () => {
  test("im Topic mit einem Knopf je Agent, auch mehr als 8 und eine 30-stellige Kennung", async () => {
    await createAgent({ name: LONG_ID, description: "Lang", systemPrompt: "Du bist lang." });
    await createAgent({ name: "planer", description: "Plant", systemPrompt: "Du planst." });
    const ctx = await start();
    await ask(ctx);
    const [m] = await messages(ctx, `topic-${TOPIC}`);
    expect(m.source).toBe("topic");
    expect(m.choice.state).toBe("open");
    expect(m.choice.options).toEqual(listAgents().map(a => ({ key: a.name, label: a.displayName })));
    expect(m.choice.options.length).toBeGreaterThanOrEqual(10);
    // Klick auf die lange Kennung geht durch die Route
    const res = await post(ctx, `topic-${TOPIC}`, m.choice.id, LONG_ID);
    expect(res.status).toBe(200);
    await waitUntil(() => ctx.mappingEvents.length === 1);
    expect(topicsOnDisk()[GROUP][String(TOPIC)]).toBe(LONG_ID);
  });

  test("Klick auf Research: Zuordnung genau einmal, Sammelstrom meldet das Topic, Liste zeigt research", async () => {
    const ctx = await start();
    const id = await ask(ctx);
    expect(await topicAgent(ctx, `topic-${TOPIC}`)).toBe("general");
    const activity = await listen(ctx, TELEGRAM_ACTIVITY_PATH);
    const res = await post(ctx, `topic-${TOPIC}`, id, "research");
    expect(res.status).toBe(200);
    expect((await res.json()).choice).toMatchObject({
      state: "done",
      result: { key: "research", label: "Research Agent (Deep Research)", via: "web" },
    });
    expect(topicsOnDisk()).toEqual({ [GROUP]: { [String(TOPIC)]: "research" } });
    await waitUntil(() => activity.of("topic").length > 0);
    expect(activity.of("topic")).toEqual([{ id: `topic-${TOPIC}` }]);
    expect(await topicAgent(ctx, `topic-${TOPIC}`)).toBe("research");
    // Zweiter Klick: 409, nichts neu geschrieben
    expect((await post(ctx, `topic-${TOPIC}`, id, "finance")).status).toBe(409);
    expect(ctx.mappingEvents).toEqual([{ agent: "research" }]);
    expect(ctx.notices).toEqual([]);
  });

  test("fremdes Gespräch: 404, Frage bleibt offen, nichts geschrieben", async () => {
    const ctx = await start();
    const id = await ask(ctx);
    expect((await post(ctx, "topic-8", id, "research")).status).toBe(404);
    expect((await post(ctx, "dm", id, "research")).status).toBe(404);
    expect((await getChoice(id))!.state).toBe("open");
    expect(topicsOnDisk()).toEqual({});
  });

  test("Zuordnung über die Einstellungen: Frage im Verlauf abgelaufen, später Klick 409", async () => {
    const ctx = await start();
    const id = await ask(ctx);
    await botSetMapping(GROUP, TOPIC, "finance", topicsFile());
    await ctx.topics.settled();
    expect((await messages(ctx, `topic-${TOPIC}`))[0].choice.state).toBe("expired");
    expect((await post(ctx, `topic-${TOPIC}`, id, "research")).status).toBe(409);
    expect(topicsOnDisk()[GROUP][String(TOPIC)]).toBe("finance");
  });

  test("gelöschter Agent: Meldung im Topic auch im Browser, nichts zugeordnet", async () => {
    await createAgent({ name: "planer", description: "Plant", systemPrompt: "Du planst." });
    const ctx = await start();
    const id = await ask(ctx);
    const { deleteAgent } = await import("../src/agents/catalog");
    await deleteAgent("planer");
    expect((await post(ctx, `topic-${TOPIC}`, id, "planer")).status).toBe(200);
    const list = await messages(ctx, `topic-${TOPIC}`);
    expect(list.map(m => m.text ?? m.content).at(-1)).toContain("gibt es nicht mehr");
    expect(topicsOnDisk()[GROUP]?.[String(TOPIC)]).toBeUndefined();
  });
});
