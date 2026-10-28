/**
 * Issue #350, Checkbox 1: Webhook-Modus der Telegram-Laufzeit. Ein echter
 * grammY-Bot (Bot-Info vorgegeben, Api-Aufrufe über einen Transformer
 * abgefangen, kein Netz) mit dem echten Telegram-Kanal; nur das Modell und
 * die Ablage sind Attrappen. Gefälschte Updates gehen per HTTP an den
 * Listener. src/bot.ts wird nie importiert.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Bot, type Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import type { BotTurns } from "../src/app/bot-turns";
import { wireTelegramChannel } from "../src/app/bot-telegram-channel";
import { createBotCommandServices } from "../src/app/command-services";
import { setChoicesFileForTests } from "../src/lib/choices";
import { createTelegramRuntime, type TelegramRuntime, type TelegramWebhookConfig } from "../src/lib/telegram-runtime";
import { isolateAgentCatalog } from "./catalog-fixture";

isolateAgentCatalog();

const TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn";
const OWNER = "4242";
const SECRET = "webhook-secret-fuer-tests_0123456789";
const me = { id: 123456789, is_bot: true, first_name: "tybo", username: "tybo_bot" } as UserFromGetMe;
const ENV = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_USER_ID: OWNER };

const base = mkdtempSync(join(tmpdir(), "telegram-webhook-"));
let counter = 0;
const open: TelegramRuntime[] = [];

beforeEach(() => setChoicesFileForTests(join(base, `choices-${++counter}.json`)));
afterEach(() => {
  for (const runtime of open.splice(0)) runtime.stop();
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

function freePort(): number {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

async function waitFor(check: () => boolean): Promise<void> {
  const end = Date.now() + 3000;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

function textUpdate(updateId: number, fromId = Number(OWNER), text = "Wie wird das Wetter?"): Update {
  const from = { id: fromId, is_bot: false, first_name: "Alex" };
  return { update_id: updateId, message: { message_id: updateId, date: 0, chat: { id: fromId, type: "private", first_name: "Alex" }, from, text } } as Update;
}

interface Setup {
  runtime: TelegramRuntime;
  api: { method: string; payload: Record<string, unknown> }[];
  turns: string[];
  events: string[];
  logs: string[];
  ready: () => number;
  post(update: unknown, secret?: string | null, path?: string): Promise<Response>;
}

async function setup(
  options: { publicUrl?: string | null; wire?: boolean; extra?: (bot: Bot) => void; handlerTimeoutMs?: number } = {},
): Promise<Setup> {
  const api: Setup["api"] = [];
  const turns: string[] = [];
  const events: string[] = [];
  const logs: string[] = [];
  const webhook: TelegramWebhookConfig = {
    hostname: "127.0.0.1",
    port: freePort(),
    path: "/telegram",
    secret: SECRET,
    publicUrl: options.publicUrl ?? null,
    ...(options.handlerTimeoutMs === undefined ? {} : { handlerTimeoutMs: options.handlerTimeoutMs }),
  };
  const runtime = createTelegramRuntime({
    env: ENV,
    intake: { mode: "webhook", webhook },
    createBot: token => {
      const bot = new Bot(token, { botInfo: me });
      // Kein Netz: jeder Api-Aufruf wird aufgezeichnet und beantwortet
      bot.api.config.use(async (_prev, method, payload) => {
        api.push({ method, payload: payload as Record<string, unknown> });
        const result = method === "sendMessage" ? { message_id: 99, date: 0, chat: { id: Number(OWNER), type: "private" } } : true;
        return { ok: true, result } as never;
      });
      return bot;
    },
    log: line => logs.push(line),
  });
  open.push(runtime);

  if (options.wire !== false) {
    const fakeTurns: BotTurns<Context> = {
      ask: async () => "nicht erwartet",
      askWithProgress: async (_ctx, prompt, chatId) => {
        turns.push(`${chatId}:${prompt}`);
        return "Sonnig.";
      },
      trackSession: () => async () => {},
    };
    const { channel } = wireTelegramChannel({
      env: ENV,
      runtime,
      turns: fakeTurns,
      choices: { topicChoices: {} as never, proactiveChoices: {} as never, reviewResults: {} as never },
      services: createBotCommandServices({ routineMenu: async () => false }),
      isShuttingDown: () => false,
      afterTurn: chatId => void events.push(`afterTurn:${chatId}`),
      invokeBudget: 3,
      parts: {
        saveMessage: async () => true,
        processIntents: async () => undefined as never,
        onGoalTurn: () => {},
        noteThreads: () => {},
        threadHint: async () => undefined,
        captureTopicName: async () => {},
      },
    });
    options.extra?.(runtime.bot!);
    runtime.bot!.use(channel.handlers);
  } else {
    options.extra?.(runtime.bot!);
  }

  let ready = 0;
  await runtime.start(() => {
    ready++;
  });
  const post = (update: unknown, secret: string | null = SECRET, path = "/telegram") =>
    fetch(`http://127.0.0.1:${runtime.webhookPort()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(secret === null ? {} : { "X-Telegram-Bot-Api-Secret-Token": secret }) },
      body: JSON.stringify(update),
    });
  return { runtime, api, turns, events, logs, ready: () => ready, post };
}

describe("Webhook-Modus", () => {
  test("Secret richtig, Besitzer schreibt: HTTP 200 und genau ein Turn über den echten Kanal", async () => {
    const s = await setup();
    const response = await s.post(textUpdate(1));
    expect(response.status).toBe(200);
    // Der Kanal startet den Turn im Hintergrund: 200 heißt noch nicht fertig
    await waitFor(() => s.events.length > 0);
    await Bun.sleep(30);
    expect(s.turns).toEqual([`${OWNER}:Wie wird das Wetter?`]);
    expect(s.events).toEqual([`afterTurn:${OWNER}`]);
    // Antwort ging über die Bot-API an den Besitzer
    expect(s.api.some(c => c.method === "sendMessage" && String(c.payload.chat_id) === OWNER && c.payload.text === "Sonnig.")).toBe(true);
  });

  test("falsches oder fehlendes Secret: 401 und kein Turn", async () => {
    const s = await setup();
    expect((await s.post(textUpdate(2), "falsches-secret")).status).toBe(401);
    expect((await s.post(textUpdate(3), null)).status).toBe(401);
    await Bun.sleep(50);
    expect(s.turns).toEqual([]);
    expect(s.api.filter(c => c.method !== "setWebhook")).toEqual([]);
  });

  test("fremder Absender: 200, aber kein Turn", async () => {
    const s = await setup();
    expect((await s.post(textUpdate(4, 999, "Hallo"))).status).toBe(200);
    await Bun.sleep(50);
    expect(s.turns).toEqual([]);
  });

  test("dasselbe Update zweimal zugestellt: nur ein Turn", async () => {
    const s = await setup();
    expect((await s.post(textUpdate(5))).status).toBe(200);
    expect((await s.post(textUpdate(5))).status).toBe(200);
    await waitFor(() => s.events.length > 0);
    await Bun.sleep(50);
    expect(s.turns).toHaveLength(1);
    expect(s.logs).toContain("[telegram] Update 5 erneut zugestellt, übersprungen");
  });

  test("anderer Pfad 404, GET 405", async () => {
    const s = await setup();
    expect((await s.post(textUpdate(6), SECRET, "/process")).status).toBe(404);
    const get = await fetch(`http://127.0.0.1:${s.runtime.webhookPort()}/telegram`);
    expect(get.status).toBe(405);
    expect(s.turns).toEqual([]);
  });

  test("Start: nie Polling, onReady genau einmal, erst wenn der Listener offen ist", async () => {
    const s = await setup();
    expect(s.ready()).toBe(1);
    expect(s.runtime.webhookPort()).toBeGreaterThan(0);
    expect(s.api.map(c => c.method)).not.toContain("getUpdates");
    expect(s.api.map(c => c.method)).not.toContain("deleteWebhook");
    // grammY sperrt bot.start, sobald der Webhook-Weg steht
    expect(() => s.runtime.bot!.start()).toThrow();
  });

  test("mit öffentlicher Adresse: setWebhook mit Secret; ohne: kein Eintrag, Hinweis im Log", async () => {
    const withUrl = await setup({ publicUrl: "https://tybo.example.org/telegram" });
    expect(withUrl.api.filter(c => c.method === "setWebhook").map(c => c.payload)).toEqual([
      { url: "https://tybo.example.org/telegram", secret_token: SECRET },
    ]);
    const without = await setup();
    expect(without.api.filter(c => c.method === "setWebhook")).toEqual([]);
    expect(without.logs.some(line => line.includes("ohne TELEGRAM_WEBHOOK_URL"))).toBe(true);
  });

  test("Fehler im Handler: Logzeile, trotzdem 200 (keine erneute Zustellung)", async () => {
    const errors: string[] = [];
    const original = console.error;
    console.error = (line: unknown) => void errors.push(String(line));
    try {
      const s = await setup({
        wire: false,
        extra: bot =>
          bot.use(() => {
            throw new Error("kaputt");
          }),
      });
      expect((await s.post(textUpdate(7))).status).toBe(200);
      expect(errors).toEqual(["Telegram-Handler fehlgeschlagen (Update 7): kaputt"]);
    } finally {
      console.error = original;
    }
  });

  test("Handler scheitert erst nach der Frist: 200, eine bereinigte Zeile, keine unbehandelte Ablehnung", async () => {
    const output: string[] = [];
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => void rejections.push(reason);
    const originals = { error: console.error, warn: console.warn, log: console.log };
    const capture = (...parts: unknown[]) => void output.push(parts.map(part => (part instanceof Error ? `${part.message}\n${part.stack}` : String(part))).join(" "));
    console.error = capture;
    console.warn = capture;
    console.log = capture;
    process.on("unhandledRejection", onRejection);
    try {
      let failed = false;
      const s = await setup({
        wire: false,
        handlerTimeoutMs: 30,
        extra: bot =>
          bot.use(async () => {
            await Bun.sleep(120);
            failed = true;
            throw new Error("spät kaputt");
          }),
      });
      const response = await s.post(textUpdate(8, Number(OWNER), "geheimer Nachrichtentext"));
      expect(response.status).toBe(200);
      expect(failed).toBe(false);
      await waitFor(() => failed);
      await Bun.sleep(50);
      expect(rejections).toEqual([]);
      expect(output).toEqual(["Telegram-Handler fehlgeschlagen (Update 8): spät kaputt"]);
      const all = [...output, ...s.logs].join("\n");
      expect(all).not.toContain(TOKEN);
      expect(all).not.toContain("geheimer Nachrichtentext");
    } finally {
      process.off("unhandledRejection", onRejection);
      Object.assign(console, originals);
    }
  });

  test("stop schließt den Listener", async () => {
    const s = await setup();
    const port = s.runtime.webhookPort()!;
    s.runtime.stop();
    expect(s.runtime.webhookPort()).toBeNull();
    await Bun.sleep(20);
    await expect(fetch(`http://127.0.0.1:${port}/telegram`, { method: "POST", body: "{}" })).rejects.toThrow();
  });
});

describe("Polling bleibt Standard", () => {
  test("ohne intake: kein Listener, bot.start statt Webhook", async () => {
    let started = 0;
    const runtime = createTelegramRuntime({
      env: ENV,
      createBot: token => {
        const bot = new Bot(token, { botInfo: me });
        bot.start = async () => void started++;
        return bot;
      },
      log: () => {},
    });
    await runtime.start(() => {});
    expect(started).toBe(1);
    expect(runtime.webhookPort()).toBeNull();
  });
});
