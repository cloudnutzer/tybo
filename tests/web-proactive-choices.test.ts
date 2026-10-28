/**
 * Knöpfe proaktiver Meldungen in der WebUI (Issue #362): echter Web-Server
 * mit echter Telegram-Quelle, echtem Rückfragen-Register und echtem
 * ChoicePort, Nachrichtenspeicher als Attrappe. Die Meldung kommt wie aus
 * runProactive (Outbox-Attrappe hält sie im Direktchat mit choiceId fest).
 * Geprüft: Knöpfe Erledigt, 30 Minuten später, Anrufen im Verlauf des
 * Direktchats, Klick im Browser schreibt den Snooze, fremdes Gespräch 404,
 * ohne Telegram im Web-Direktchat.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachChoiceTelegram, expireChoice, getChoice, onChoiceDecided, setChoicesFileForTests } from "../src/lib/choices";
import type { SendAndRecordInput } from "../src/lib/outbox";
import { createProactiveChoices, openProactiveChoice } from "../src/lib/proactive/choices";
import { runProactive, type ProactiveChoiceRegister } from "../src/lib/proactive/deliver";
import { readProactiveState } from "../src/lib/proactive/state";
import type { HistoryRow } from "../src/lib/store/types";
import type { RunTurnOptions, WebChat } from "../src/web/chat";
import { createTelegramSource } from "../src/web/bot-telegram";
import { createWebServer, type WebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { ACCESS, FakeCerts } from "./access-fixture";
import { testChoices } from "./choices-fixture";

const PASSWORD = "test-passwort-lang";
const USER = "4711";
const GROUP = "-1001234567890";
const ENV = { USER_TIMEZONE: "Europe/Berlin", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_USER_ID: USER };
const NOON = Date.parse("2026-10-19T12:00:00.000Z");
const root = await mkdtemp(join(tmpdir(), "tybo-web-proactive-"));
let counter = 0;
const servers: WebServer[] = [];
const cleanups: (() => void)[] = [];
let logSpy: ReturnType<typeof spyOn>;

beforeEach(() => { logSpy = spyOn(console, "log").mockImplementation(() => {}); });
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  for (const s of servers.splice(0)) await s.stop();
  logSpy.mockRestore();
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

async function start() {
  const dir = join(root, `case-${++counter}`);
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const choices = testChoices(join(dir, "choices.json"), { userId: USER, groupId: GROUP });
  const rows: (HistoryRow & { chat_id: string })[] = [];
  const telegram = createTelegramSource({
    userId: USER,
    groupId: () => GROUP,
    topicNames: async () => ({ "443": "Recherche" }),
    topicMapping: () => ({}),
    history: async (chatId, topicId) => rows.filter(r => r.chat_id === chatId && ((r.metadata as any)?.topicId ?? null) === topicId),
    activity: async () => [],
    log: () => {},
  });
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [], publicOrigin: "https://app.tybo.ai", access: ACCESS },
    {
      sessionFile: join(dir, "sessions.json"),
      conversationStore: store,
      chat: new QuietChat(),
      telegram,
      telegramChat: new QuietChat(),
      choices: choices.port,
      cliTokenFile: join(dir, "cli-token"),
      accessCerts: new FakeCerts().fetch,
      keepaliveMs: 60_000,
      log: () => {},
    }
  );
  servers.push(server);
  const res = await fetch(`${server.url}/api/login`, { method: "POST", headers: { origin: server.url }, body: JSON.stringify({ password: PASSWORD }) });
  expect(res.status).toBe(200);
  const cookie = res.headers.get("set-cookie")!.split(";")[0];

  const statePath = join(dir, "data", "proactive-state.json");
  const proactive = createProactiveChoices({ statePath, env: ENV, now: () => new Date(NOON + 60_000), notify: async () => {}, log: () => {} });
  cleanups.push(onChoiceDecided("proactive", proactive.handler));

  /** Check-in wie aus der Routine: Outbox-Attrappe legt die Zeile im Direktchat ab */
  async function sendCheckin(): Promise<string> {
    const register: ProactiveChoiceRegister = {
      create: (kind, text) => openProactiveChoice(kind, text, { env: ENV, callAvailable: true }),
      attach: attachChoiceTelegram,
      expire: expireChoice,
      refresh: async () => {},
    };
    let choiceId = "";
    const send = async (input: SendAndRecordInput) => {
      choiceId = input.choiceId!;
      rows.push({ id: `row-${rows.length + 1}`, chat_id: USER, created_at: new Date(NOON).toISOString(), role: "assistant", content: input.text!, metadata: { display_only: true, source: input.source, choiceId: input.choiceId, msgId: crypto.randomUUID() } } as any);
      return { sent: true, recorded: true, messages: [{ chatId: USER, messageId: 77, part: "text" as const, buttons: true }] };
    };
    const outcome = await runProactive("checkin", async () => ({ text: "Wie läuft es mit dem Bericht?", ask: true }), {
      now: () => new Date(NOON), env: ENV, settings: {}, statePath, legacy: null, renewMs: 0, choices: register, send,
    });
    expect(outcome).toEqual({ status: "sent" });
    return choiceId;
  }

  async function messages(conversationId: string): Promise<any[]> {
    const r = await fetch(`${server.url}/api/conversations/${conversationId}/messages`, { headers: { cookie } });
    expect(r.status).toBe(200);
    return (await r.json()).messages;
  }

  function post(conversationId: string, choiceId: string, option: string) {
    return fetch(`${server.url}/api/conversations/${conversationId}/choices/${choiceId}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: server.url, cookie },
      body: JSON.stringify({ option }),
    });
  }

  return { sendCheckin, messages, post, statePath, choices };
}

describe("WebUI: Knöpfe unter dem Check-in", () => {
  test("Direktchat zeigt die Meldung mit den drei Knöpfen", async () => {
    const ctx = await start();
    const id = await ctx.sendCheckin();
    const [m] = await ctx.messages("dm");
    expect(m.kind).toBe("notice");
    expect(m.source).toBe("checkin");
    expect(m.text).toBe("Wie läuft es mit dem Bericht?");
    expect(m.choice).toEqual({
      id,
      options: [
        { key: "done", label: "Erledigt" },
        { key: "snooze", label: "30 Minuten später" },
        { key: "call", label: "Anrufen" },
      ],
      state: "open",
    });
  });

  test("Klick auf „30 Minuten später“ im Browser: Snooze im Kern-Zustand, Verlauf zeigt erledigt", async () => {
    const ctx = await start();
    const id = await ctx.sendCheckin();
    const res = await ctx.post("dm", id, "snooze");
    expect(res.status).toBe(200);
    expect((await res.json()).choice).toMatchObject({ state: "done", result: { key: "snooze", label: "30 Minuten später", via: "web" } });
    // Klick um 12:01 UTC, Ruhe bis 12:31 UTC
    expect((await readProactiveState(ctx.statePath)).checkin.snoozedUntil).toBe("2026-10-19T12:31:00.000Z");
    expect((await ctx.messages("dm"))[0].choice.state).toBe("done");
    expect((await ctx.post("dm", id, "done")).status).toBe(409);
  });

  test("aus einem fremden Gespräch nicht entscheidbar: 404, Frage bleibt offen, kein Snooze", async () => {
    const ctx = await start();
    const id = await ctx.sendCheckin();
    expect((await ctx.post("topic-443", id, "snooze")).status).toBe(404);
    expect((await getChoice(id))?.state).toBe("open");
    expect((await readProactiveState(ctx.statePath)).checkin.snoozedUntil).toBeUndefined();
  });
});

test("ohne Telegram: Frage gehört zum Web-Direktchat (dm) mit den Knöpfen", async () => {
  const dir = join(root, `case-${++counter}`);
  const choices = testChoices(join(dir, "choices.json"), { userId: "web" });
  const c = await openProactiveChoice("briefing", "Guten Morgen", { env: { USER_TIMEZONE: "UTC" } });
  const open = await choices.port.pending!("dm", "proactive");
  expect(open.map(o => o.id)).toEqual([c.id]);
  expect(open[0].options.map(o => o.label)).toEqual(["Erledigt", "30 Minuten später"]);
});
