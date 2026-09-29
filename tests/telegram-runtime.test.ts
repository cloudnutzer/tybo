/**
 * Issue #228, Checkbox 2: Startverdrahtung als testbarer Baustein
 * (src/lib/telegram-runtime.ts). Ohne Telegram keine Bot-Fabrik, keine
 * Agenten-Bots, kein Aufruf an api.telegram.org, onReady genau einmal. Mit
 * Telegram bleibt der Start wie bisher: Fabrik einmal mit dem Token,
 * bot.start einmal, Ziele erst aus onStart. Bot und Netz sind Spione;
 * src/bot.ts wird nie importiert.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Bot } from "grammy";
import { attachChoiceTelegram, createChoice, getChoice, onChoiceChange, setChoicesFileForTests } from "../src/lib/choices";
import { createTelegramChoices } from "../src/lib/telegram-choices";
import { createTelegramRuntime, startAfterFirstSweep, TelegramUnavailableError, type AgentBots } from "../src/lib/telegram-runtime";

const TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn";
const AGENT_TOKEN = "987654321:AAFakeAgentTokenForTests_zyxwvutsrqpon";
const USER = "424242";
const WEB_ONLY = { WEB_ENABLED: "true", WEB_PASSWORD: "sehr-geheimes-passwort-1" };

const base = mkdtempSync(join(tmpdir(), "telegram-runtime-"));
let counter = 0;
let fetchCalls: string[] = [];
let fetchSpy: ReturnType<typeof spyOn>;
let logs: string[] = [];

beforeEach(() => {
  setChoicesFileForTests(join(base, `choices-${++counter}.json`));
  fetchCalls = [];
  logs = [];
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: any) => {
    fetchCalls.push(String(input instanceof Request ? input.url : input));
    throw new Error("Netz im Test verboten");
  }) as any);
});
afterEach(() => fetchSpy.mockRestore());
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

const telegramCalls = () => fetchCalls.filter(url => url.includes("api.telegram.org"));

/** Attrappe eines grammY-Bots: zeichnet Aufrufe auf, kein Netz */
function fakeBot(token: string) {
  const calls: { method: string; args: unknown[] }[] = [];
  let startOptions: { onStart?: (info: { username: string }) => void } | undefined;
  const api = {
    config: { use: () => {} },
    sendMessage: async (...args: unknown[]) => { calls.push({ method: "sendMessage", args }); return {}; },
    sendChatAction: async (...args: unknown[]) => { calls.push({ method: "sendChatAction", args }); return true; },
  };
  const bot = {
    token,
    api,
    botInfo: { username: token === TOKEN ? "haupt_bot" : "agent_bot" },
    calls,
    catch: () => {},
    init: async () => { calls.push({ method: "init", args: [] }); },
    start: (options: typeof startOptions) => {
      calls.push({ method: "start", args: [] });
      startOptions = options;
      return new Promise<void>(() => {});
    },
    stop: async () => { calls.push({ method: "stop", args: [] }); },
    /** Wie grammY nach dem ersten erfolgreichen getMe */
    fireOnStart: () => startOptions?.onStart?.({ username: "haupt_bot" }),
  };
  return bot;
}

describe("ohne Telegram (nur WebUI)", () => {
  test("keine Bot-Fabrik, keine Agenten-Bots, kein Netz; Topic-API und Voice-Sender fehlen", async () => {
    const created: string[] = [];
    const agentFactory: unknown[] = [];
    const runtime = createTelegramRuntime({
      // Übrig gebliebene Agenten-Tokens ändern nichts
      env: { ...WEB_ONLY, TELEGRAM_BOT_TOKEN_RESEARCH: AGENT_TOKEN },
      createBot: token => { created.push(token); return fakeBot(token) as unknown as Bot; },
      createAgentBots: (...args) => { agentFactory.push(args); return {} as AgentBots; },
      log: line => logs.push(line),
    });
    expect(runtime.telegram).toBe(false);
    expect(runtime.bot).toBeNull();
    expect(runtime.topicApi).toBeUndefined();
    expect(runtime.voiceSender).toBeUndefined();
    await runtime.initialize();
    expect(runtime.agents.agentForMention("@agent_bot hallo")).toBeNull();
    expect(created).toEqual([]);
    expect(agentFactory).toEqual([]);
    expect(logs).toContain("Telegram nicht eingerichtet: nur WebUI");
    expect(telegramCalls()).toEqual([]);
  });

  test("übrig gebliebene Agenten-Tokens mit dem Standard-Registry-Weg: trotzdem kein Netz", async () => {
    const runtime = createTelegramRuntime({ env: { ...WEB_ONLY, TELEGRAM_BOT_TOKEN_RESEARCH: AGENT_TOKEN }, log: line => logs.push(line) });
    await runtime.initialize();
    let ready = 0;
    await runtime.start(() => { ready++; });
    expect(ready).toBe(1);
    expect(fetchCalls).toEqual([]);
  });

  test("start ruft onReady genau einmal, auch bei zweitem Aufruf; stop ohne Fehler", async () => {
    const runtime = createTelegramRuntime({ env: WEB_ONLY, log: line => logs.push(line) });
    let ready = 0;
    await runtime.start(() => { ready++; });
    await runtime.start(() => { ready++; });
    expect(ready).toBe(1);
    expect(() => runtime.stop()).not.toThrow();
    expect(telegramCalls()).toEqual([]);
  });

  test("Senden an eine Telegram-Chat-ID: ohne Netz abgelehnt und geloggt; Web-Ziele tun nichts", async () => {
    const runtime = createTelegramRuntime({ env: WEB_ONLY, log: line => logs.push(line) });
    await expect(runtime.sendMessage(USER, "Hallo")).rejects.toBeInstanceOf(TelegramUnavailableError);
    await expect(runtime.sendPlain(USER, "Hallo")).rejects.toBeInstanceOf(TelegramUnavailableError);
    await expect(runtime.sendStatus(USER, "Hallo")).rejects.toBeInstanceOf(TelegramUnavailableError);
    await expect(runtime.sendFile(USER, { bytes: new Uint8Array([1]), name: "a.txt" }, { as: "document", caption: "" })).rejects.toBeInstanceOf(TelegramUnavailableError);
    await expect(runtime.agents.sendAsAgent("research", USER, "Hallo")).rejects.toBeInstanceOf(TelegramUnavailableError);
    expect(logs.filter(l => l.includes(`an Chat ${USER} abgelehnt`))).toHaveLength(5);
    await runtime.sendPlain("web", "Hallo");
    await runtime.agents.sendAsAgent("research", "web:0f0e0d0c-0b0a-4908-8706-050403020100", "Hallo");
    await runtime.typing(USER);
    expect(fetchCalls).toEqual([]);
  });

  test("Rückfragen ohne api: Ablauf wird gespeichert, keine Telegram-Nachricht nachgezogen", async () => {
    const runtime = createTelegramRuntime({ env: WEB_ONLY, log: line => logs.push(line) });
    const off = onChoiceChange(runtime.choices.listener);
    try {
      const c = await createChoice({
        kind: "review",
        conversation: { type: "telegram", chatId: USER },
        text: "Merken?",
        options: [{ key: "ok", label: "Übernehmen" }],
        expiresAt: Date.now() - 1,
      });
      // Gespeicherte Telegram-Nachricht aus einem früheren Lauf mit Telegram
      await attachChoiceTelegram(c.id, [{ chatId: USER, messageId: 10 }]);
      expect((await runtime.choices.sweep()).map(x => x.id)).toEqual([c.id]);
      expect((await getChoice(c.id))?.state).toBe("expired");
      expect(fetchCalls).toEqual([]);
    } finally {
      off();
    }
  });
});

describe("createTelegramChoices ohne api", () => {
  test("sweep speichert den Ablauf, der Zuhörer ruft nichts auf, fremde Knöpfe werden nicht angenommen", async () => {
    const choices = createTelegramChoices({ telegram: () => false, log: line => logs.push(line) });
    const off = onChoiceChange(choices.listener);
    try {
      const c = await createChoice({
        kind: "review",
        conversation: { type: "telegram", chatId: USER },
        text: "Merken?",
        options: [{ key: "ok", label: "Übernehmen" }],
        expiresAt: Date.now() - 1,
      });
      await attachChoiceTelegram(c.id, [{ chatId: USER, messageId: 11 }, { chatId: "-1001234567890", messageId: 12 }]);
      await choices.sweep();
      expect((await getChoice(c.id))?.state).toBe("expired");
      expect(logs.filter(l => l.includes("nicht nachgezogen"))).toEqual([]);
      let nexted = false;
      const answered: unknown[] = [];
      await choices.middleware(
        { callbackQuery: { data: `ch|${c.id}|ok` }, from: { id: Number(USER) }, answerCallbackQuery: async (a: unknown) => { answered.push(a); } } as any,
        async () => { nexted = true; }
      );
      expect(nexted).toBe(false);
      expect(answered).toEqual([]);
      expect(fetchCalls).toEqual([]);
    } finally {
      off();
    }
  });
});

describe("mit Telegram (wie bisher)", () => {
  function withTelegram(extraEnv: Record<string, string> = {}, agents?: AgentBots) {
    const bots: ReturnType<typeof fakeBot>[] = [];
    const runtime = createTelegramRuntime({
      env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_USER_ID: USER, ...extraEnv },
      createBot: token => {
        const b = fakeBot(token);
        bots.push(b);
        return b as unknown as Bot;
      },
      ...(agents ? { createAgentBots: () => agents } : {}),
      log: line => logs.push(line),
    });
    return { runtime, bots };
  }

  test("Fabrik genau einmal mit dem Token, bot.start einmal, Ziele erst aus onStart und genau einmal", async () => {
    const { runtime, bots } = withTelegram();
    expect(runtime.telegram).toBe(true);
    expect(bots.map(b => b.token)).toEqual([TOKEN]);
    expect(runtime.bot).toBe(bots[0] as unknown as Bot);
    expect(runtime.topicApi).toBeDefined();
    expect(runtime.voiceSender).toBeDefined();
    let ready = 0;
    void runtime.start(() => { ready++; });
    expect(bots[0].calls.filter(c => c.method === "start")).toHaveLength(1);
    // Vor onStart noch keine Ziele
    expect(ready).toBe(0);
    bots[0].fireOnStart();
    expect(ready).toBe(1);
    // grammY ruft onStart nach einem Neustart des Pollings erneut: Ziele nicht doppelt
    bots[0].fireOnStart();
    expect(ready).toBe(1);
    expect(logs).toContain("Bot online as @haupt_bot");
    runtime.stop();
    expect(bots[0].calls.filter(c => c.method === "stop")).toHaveLength(1);
    expect(telegramCalls()).toEqual([]);
  });

  test("Agenten-Bots: Registry wird vor dem Start initialisiert, über dieselbe Fabrik und die übergebene env", async () => {
    const { runtime, bots } = withTelegram({ TELEGRAM_BOT_TOKEN_RESEARCH: AGENT_TOKEN });
    // Erst initialize baut Agenten-Bots
    expect(bots.map(b => b.token)).toEqual([TOKEN]);
    await runtime.initialize();
    await runtime.initialize();
    expect(bots.map(b => b.token)).toEqual([TOKEN, AGENT_TOKEN]);
    expect(bots[1].calls.filter(c => c.method === "init")).toHaveLength(1);
    expect(runtime.agents.agentForMention("@agent_bot hallo")?.agent).toBe("research");
    expect(telegramCalls()).toEqual([]);
  });

  test("Sende-Helfer laufen über den Bot; Agenten-Nachrichten über die Registry", async () => {
    const sent: unknown[] = [];
    const agents: AgentBots = {
      initialize: async () => {},
      agentForMention: () => null,
      sendAsAgent: async (...args) => { sent.push(args); },
      sendTypingAsAgent: async () => {},
      sendWithKeyboardAsAgent: async () => {},
    };
    const { runtime, bots } = withTelegram({}, agents);
    await runtime.sendPlain(USER, "Hallo", 7);
    await runtime.sendMessage(USER, "**fett**");
    await runtime.typing(USER);
    await runtime.agents.sendAsAgent("research", USER, "Hi", { threadId: 3 });
    expect(bots[0].calls.map(c => c.method)).toEqual(["sendMessage", "sendMessage", "sendChatAction"]);
    expect(bots[0].calls[0].args).toEqual([USER, "Hallo", { message_thread_id: 7 }]);
    expect(sent).toEqual([["research", USER, "Hi", { threadId: 3 }]]);
  });

  test("Nutzer-ID keine Zahl: gilt als nicht eingerichtet (kommt über chooseStartMode nie hierher)", () => {
    const created: string[] = [];
    const runtime = createTelegramRuntime({
      env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_USER_ID: "alex" },
      createBot: token => { created.push(token); return fakeBot(token) as unknown as Bot; },
      log: line => logs.push(line),
    });
    expect(runtime.telegram).toBe(false);
    expect(created).toEqual([]);
  });
});

describe("Start erst nach der ersten Ablauf-Prüfung", () => {
  /** Verzögerte Sweep-Attrappe: hält die Prüfung fest, bis der Test sie freigibt */
  function delayedSweep(fail = false) {
    let release!: () => void;
    const done = new Promise<void>((resolve, reject) => { release = () => (fail ? reject(new Error("Prüfung gescheitert")) : resolve()); });
    return { done, release };
  }
  const flush = () => new Promise(r => setTimeout(r, 0));

  test("ohne Telegram: onReady nicht vor der Prüfung, danach genau einmal", async () => {
    const runtime = createTelegramRuntime({ env: WEB_ONLY, log: line => logs.push(line) });
    const sweep = delayedSweep();
    let ready = 0;
    const started = startAfterFirstSweep(runtime, sweep.done, () => { ready++; });
    await flush();
    expect(ready).toBe(0);
    sweep.release();
    await started;
    expect(ready).toBe(1);
    await runtime.start(() => { ready++; });
    expect(ready).toBe(1);
    expect(telegramCalls()).toEqual([]);
  });

  test("mit Telegram: bot.start erst nach der Prüfung, Ziele genau einmal aus onStart", async () => {
    const bots: ReturnType<typeof fakeBot>[] = [];
    const runtime = createTelegramRuntime({
      env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_USER_ID: USER },
      createBot: token => { const b = fakeBot(token); bots.push(b); return b as unknown as Bot; },
      log: line => logs.push(line),
    });
    const sweep = delayedSweep();
    let ready = 0;
    void startAfterFirstSweep(runtime, sweep.done, () => { ready++; });
    await flush();
    expect(bots[0].calls.filter(c => c.method === "start")).toHaveLength(0);
    expect(ready).toBe(0);
    sweep.release();
    await flush();
    expect(bots[0].calls.filter(c => c.method === "start")).toHaveLength(1);
    bots[0].fireOnStart();
    bots[0].fireOnStart();
    expect(ready).toBe(1);
  });

  test("gescheiterte Prüfung hält den Start nicht auf: onReady danach genau einmal", async () => {
    const runtime = createTelegramRuntime({ env: WEB_ONLY, log: line => logs.push(line) });
    const sweep = delayedSweep(true);
    let ready = 0;
    const started = startAfterFirstSweep(runtime, sweep.done, () => { ready++; });
    await flush();
    expect(ready).toBe(0);
    sweep.release();
    await started;
    expect(ready).toBe(1);
  });
});
