/**
 * Knöpfe proaktiver Meldungen in der Oberfläche (Issue #362): das echte
 * app.js mit DOM-Attrappen wie in web-app-choices.test.ts, aber jeder fetch
 * geht an einen echten Web-Server mit echter Telegram-Quelle, echtem
 * Rückfragen-Register und echtem Handler der Art proactive. Die Meldung kommt
 * wie aus runProactive (Outbox-Attrappe hält sie im Direktchat fest).
 *
 * Geprüft: Beschriftungen „Erledigt", „30 Minuten später" und mit
 * eingerichteten Anrufen „Anrufen"; Klick auf „30 Minuten später" zeigt die
 * Erledigt-Zeile und schreibt den Snooze in den Kern-Zustand; ohne Telegram
 * dasselbe im Web-Direktchat (ohne „Anrufen").
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { attachChoiceTelegram, expireChoice, onChoiceDecided, setChoicesFileForTests } from "../src/lib/choices";
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
import { TYBO_BRAND } from "./brand-fixture";
import { testChoices } from "./choices-fixture";

const source = await readFile(resolve(import.meta.dir, "..", "src", "web", "public", "app.js"), "utf8");
const PASSWORD = "test-passwort-lang";
const USER = "4711";
const GROUP = "-1001234567890";
const TELEGRAM_ENV = { USER_TIMEZONE: "Europe/Berlin", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_USER_ID: USER };
const WEB_ENV = { USER_TIMEZONE: "Europe/Berlin" };
// 12:00 UTC = 14:00 in Berlin; Klick um 12:01 UTC, Ruhe bis 12:31 UTC
const NOON = Date.parse("2026-10-19T12:00:00.000Z");
const root = await mkdtemp(join(tmpdir(), "tybo-web-app-proactive-"));
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

interface Node {
  children: Node[];
  attributes: Record<string, string>;
  [key: string]: any;
}

function node(): Node {
  const n: Node = {
    children: [],
    attributes: {},
    style: {},
    className: "",
    textContent: "",
    hidden: false,
    disabled: false,
    value: "",
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    set innerHTML(_v: string) {},
    appendChild(child: Node) { this.children.push(child); return child; },
    replaceChildren(...list: Node[]) {
      this.children = list.flatMap(c => (c.fragment ? c.children : [c]));
    },
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    getAttribute(name: string) { return this.attributes[name]; },
    listeners: {} as Record<string, ((e: any) => void)[]>,
    addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); },
    dispatch(type: string, event: any = {}) { for (const fn of this.listeners[type] ?? []) fn(event); },
    focus() {},
  };
  return n;
}

class FakeEventSource {
  listeners: Record<string, ((e: any) => void)[]> = {};
  constructor(public url: string) {}
  addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); }
  close() {}
}

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(2);
  }
}

/** Echter Server, Meldung wie aus der Routine, echtes app.js im Direktchat */
async function start(mode: "telegram" | "web") {
  const env = mode === "telegram" ? TELEGRAM_ENV : WEB_ENV;
  const dm = mode === "telegram" ? USER : "web";
  const dir = join(root, `case-${++counter}`);
  const store = new ConversationStore({ dir: join(dir, "web") });
  await store.load();
  const choices = testChoices(join(dir, "choices.json"), mode === "telegram" ? { userId: USER, groupId: GROUP } : { userId: "web" });
  const rows: (HistoryRow & { chat_id: string })[] = [];
  const telegram = createTelegramSource({
    userId: dm,
    groupId: () => (mode === "telegram" ? GROUP : null),
    topicNames: async () => ({}),
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
  const login = await fetch(`${server.url}/api/login`, { method: "POST", headers: { origin: server.url }, body: JSON.stringify({ password: PASSWORD }) });
  expect(login.status).toBe(200);
  const cookie = login.headers.get("set-cookie")!.split(";")[0];

  const statePath = join(dir, "data", "proactive-state.json");
  const proactive = createProactiveChoices({ statePath, env, now: () => new Date(NOON + 60_000), notify: async () => {}, log: () => {} });
  cleanups.push(onChoiceDecided("proactive", proactive.handler));

  // Meldung wie aus runProactive; Anrufe nur mit Telegram eingerichtet
  const register: ProactiveChoiceRegister = {
    create: (kind, text) => openProactiveChoice(kind, text, { env, callAvailable: mode === "telegram" }),
    attach: attachChoiceTelegram,
    expire: expireChoice,
    refresh: async () => {},
  };
  let choiceId = "";
  const send = async (input: SendAndRecordInput) => {
    choiceId = input.choiceId!;
    rows.push({ id: `row-${rows.length + 1}`, chat_id: dm, created_at: new Date(NOON).toISOString(), role: "assistant", content: input.text!, metadata: { display_only: true, source: input.source, choiceId: input.choiceId, msgId: crypto.randomUUID() } } as any);
    return mode === "telegram"
      ? { sent: true, recorded: true, messages: [{ chatId: USER, messageId: 77, part: "text" as const, buttons: true }] }
      : { sent: false, recorded: true };
  };
  const outcome = await runProactive("checkin", async () => ({ text: "Wie läuft es mit dem Bericht?", ask: true }), {
    now: () => new Date(NOON), env, settings: {}, statePath, legacy: null, renewMs: 0, choices: register, send,
  });
  expect(outcome).toEqual({ status: "sent" });

  // app.js mit DOM-Attrappen; fetch geht an den echten Server
  const elements: Record<string, Node> = {};
  const document = {
    getElementById(id: string) { return (elements[id] ??= node()); },
    createElement() { return node(); },
    createDocumentFragment() { const f = node(); f.fragment = true; return f; },
  };
  const local: Record<string, string> = { "tybo-last-conversation": "dm" };
  const window: Record<string, any> = {
    TYBO_BRAND,
    localStorage: {
      getItem: (key: string) => local[key] ?? null,
      setItem: (key: string, value: string) => { local[key] = value; },
    },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ lineHeight: "22", paddingTop: "0", paddingBottom: "0", borderTopWidth: "0", borderBottomWidth: "0" }),
    addEventListener() {},
    location: { href: "/" },
  };
  const posts: string[] = [];
  const appFetch = (path: string, init: RequestInit = {}) => {
    if ((init.method ?? "GET") === "POST" && /\/choices\//.test(path)) posts.push(path);
    return fetch(`${server.url}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), cookie, origin: server.url } });
  };
  const noTimer = () => 0;
  elements["chat-log"] = node();
  new Function("document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout", "setInterval", "clearInterval", source)(
    document, window, appFetch, FakeEventSource, noTimer, () => {}, noTimer, () => {}
  );

  const all = (n: Node, out: Node[] = []): Node[] => {
    for (const c of n.children) {
      out.push(c);
      all(c, out);
    }
    return out;
  };
  const box = () => all(elements["messages"]).find(n => n.attributes["data-choice"] === choiceId);
  const buttons = () => (box() ? all(box()!).filter(n => String(n.className).includes("choice-button") && n.attributes["data-key"]) : []);
  const status = () => (box() ? all(box()!).find(n => n.className === "choice-status")?.textContent : undefined);
  return { choiceId, statePath, buttons, status, posts };
}

describe("Oberfläche: Knöpfe unter dem Check-in", () => {
  test("mit Telegram: Direktchat zeigt Erledigt, 30 Minuten später, Anrufen; Klick auf Snooze schreibt die Ruhe", async () => {
    const app = await start("telegram");
    await waitUntil(() => app.buttons().length > 0);
    expect(app.buttons().map(b => [b.textContent, b.attributes["data-key"], b.disabled])).toEqual([
      ["Erledigt", "done", false],
      ["30 Minuten später", "snooze", false],
      ["Anrufen", "call", false],
    ]);
    expect(app.status()).toBeUndefined();

    app.buttons().find(b => b.attributes["data-key"] === "snooze")!.dispatch("click");
    await waitUntil(() => app.status() !== undefined);
    expect(app.posts).toEqual([`/api/conversations/dm/choices/${app.choiceId}`]);
    expect(app.buttons()).toEqual([]);
    expect(app.status()).toStartWith("Erledigt: 30 Minuten später · im Browser · ");
    expect((await readProactiveState(app.statePath)).checkin.snoozedUntil).toBe("2026-10-19T12:31:00.000Z");
  });

  test("ohne Telegram: Web-Direktchat zeigt Erledigt und 30 Minuten später (ohne Anrufen); Klick schreibt die Ruhe", async () => {
    const app = await start("web");
    await waitUntil(() => app.buttons().length > 0);
    expect(app.buttons().map(b => [b.textContent, b.attributes["data-key"]])).toEqual([
      ["Erledigt", "done"],
      ["30 Minuten später", "snooze"],
    ]);

    app.buttons().find(b => b.attributes["data-key"] === "snooze")!.dispatch("click");
    await waitUntil(() => app.status() !== undefined);
    expect(app.posts).toEqual([`/api/conversations/dm/choices/${app.choiceId}`]);
    expect(app.buttons()).toEqual([]);
    expect(app.status()).toStartWith("Erledigt: 30 Minuten später · im Browser · ");
    expect((await readProactiveState(app.statePath)).checkin.snoozedUntil).toBe("2026-10-19T12:31:00.000Z");
  });
});
