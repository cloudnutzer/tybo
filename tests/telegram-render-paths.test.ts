/**
 * Issue #327, Aufgabe 3: Die fünf Sendewege, die lange Antworten teilen,
 * nutzen renderTelegram. Ein Codeblock über 4.000 Zeichen kommt je Weg in
 * mehreren HTML-Stücken an, jedes höchstens 4.000 Zeichen lang und für sich
 * gültig, der Klartext-Ersatz wird nie ausgelöst.
 *
 * Die Attrappen prüfen wie Telegram: Ein HTML-Stück über 4.096 Zeichen oder
 * mit kaputtem HTML (offene Tags, rohes <) wird mit "can't parse entities"
 * bzw. HTTP 400 abgelehnt. Mit dem früheren Teilen nach der Umwandlung lösten
 * genau diese Ablehnungen den Klartext-Ersatz aus. Kein Netz, src/bot.ts wird
 * nie importiert.
 */
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Api, Bot, Context } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { AgentIdentities } from "../src/channels/telegram/identities";
import { setChoicesFileForTests } from "../src/lib/choices";
import { sendAndRecord, type OutboxDeps } from "../src/lib/outbox";
import { sendResponse, sendTelegramMessage } from "../src/channels/telegram/send";
import { createTelegramRuntime } from "../src/lib/telegram-runtime";
import { htmlText, telegramHtmlError } from "./telegram-html-check";

const ME = { id: 42, is_bot: true, first_name: "Test", username: "test_bot" } as UserFromGetMe;

// 160 Zeilen mit Einrückung, <, > und &: als HTML deutlich über 4.000 Zeichen
const CODE = Array.from({ length: 160 }, (_, i) => `${" ".repeat(i % 6)}if (a_${i} < b && c > d) { log("Zeile ${i} & mehr"); }`).join("\n");
const MD = `Der Code:\n\n\`\`\`ts\n${CODE}\n\`\`\`\n\nFertig.`;
const PRE = /^<pre><code class="language-ts">([\s\S]*)<\/code><\/pre>$/;

/** Fehler, mit dem Telegram ein HTML-Stück ablehnen würde, sonst null */
function telegramRejects(payload: Record<string, any>): string | null {
  if (payload.parse_mode !== "HTML") return null;
  const text = String(payload.text ?? "");
  if (text.length > 4096) return "message is too long";
  return telegramHtmlError(text);
}

interface Sent {
  text: string;
  parseMode?: string;
}

/** Wertet die gesendeten Stücke aus: alle HTML, gültig, kurz genug, Code zeichengenau */
function expectHtmlPieces(sent: Sent[]) {
  expect(sent.length).toBeGreaterThan(2);
  for (const s of sent) {
    expect(s.parseMode).toBe("HTML");
    expect(s.text.length).toBeLessThanOrEqual(4000);
    expect(telegramHtmlError(s.text)).toBeNull();
  }
  expect(sent[0].text).toBe("Der Code:");
  expect(sent.at(-1)!.text).toBe("Fertig.");
  const code = sent.slice(1, -1).map(s => htmlText(PRE.exec(s.text)![1])).join("");
  expect(code).toBe(CODE);
}

/** grammY-Api-Attrappe als innerster Transformer: lehnt wie Telegram ab, kein Netz */
function fakeTelegramApi(api: Api): Sent[] {
  const sent: Sent[] = [];
  api.config.use(async (_prev, method, payload) => {
    const p = payload as Record<string, any>;
    if (method === "sendMessage") {
      if (telegramRejects(p)) throw new Error("Bad Request: can't parse entities");
      sent.push({ text: p.text, parseMode: p.parse_mode });
    }
    return { ok: true, result: { message_id: sent.length, date: 0, chat: { id: 1, type: "private" } } } as any;
  });
  return sent;
}

/** fetch-Attrappe für die Wege ohne grammY: HTTP 400 bei abgelehntem HTML */
function fakeTelegramFetch() {
  const sent: Sent[] = [];
  const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>;
    if (telegramRejects(body)) return new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }), { status: 400 });
    sent.push({ text: body.text, parseMode: body.parse_mode });
    return new Response(JSON.stringify({ ok: true, result: { message_id: sent.length } }), { status: 200 });
  };
  return { sent, fetch };
}

const base = mkdtempSync(join(tmpdir(), "telegram-render-paths-"));
const realFetch = globalThis.fetch;
beforeEach(() => setChoicesFileForTests(join(base, `choices-${Date.now()}-${Math.random()}.json`)));
afterEach(() => {
  globalThis.fetch = realFetch;
  setChoicesFileForTests(null);
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe("Codeblock über 4.000 Zeichen je Sendeweg", () => {
  test("die Attrappe lehnt kaputtes HTML ab (sonst bewiese der Test nichts)", () => {
    expect(telegramRejects({ parse_mode: "HTML", text: "<pre><code>offen" })).not.toBeNull();
    expect(telegramRejects({ parse_mode: "HTML", text: "x".repeat(4097) })).not.toBeNull();
    expect(telegramRejects({ parse_mode: "HTML", text: "<b>ok</b>" })).toBeNull();
  });

  test("sendTelegramMessage mit parseMode HTML", async () => {
    const { sent, fetch } = fakeTelegramFetch();
    globalThis.fetch = fetch as typeof globalThis.fetch;
    expect(await sendTelegramMessage("123:test", "1", MD, { parseMode: "HTML" })).toBe(true);
    expectHtmlPieces(sent);
  });

  test("sendResponse", async () => {
    const api = new Api("123:test");
    const sent = fakeTelegramApi(api);
    const update = { update_id: 1, message: { message_id: 7, date: 0, chat: { id: 1, type: "private", first_name: "A" }, text: "hi" } } as Update;
    await sendResponse(new Context(update, api, ME), MD);
    expectHtmlPieces(sent);
  });

  test("sendMessage der Telegram-Laufzeit", async () => {
    let sent: Sent[] = [];
    const runtime = createTelegramRuntime({
      env: { TELEGRAM_BOT_TOKEN: "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn", TELEGRAM_USER_ID: "424242" },
      createBot: token => {
        const bot = new Bot(token, { botInfo: ME });
        sent = fakeTelegramApi(bot.api);
        return bot;
      },
      createAgentBots: bot => new AgentIdentities(bot, { env: {} }),
      log: () => {},
    });
    await runtime.sendMessage("424242", MD, 5);
    expectHtmlPieces(sent);
  });

  test("AgentIdentities.sendAsAgent", async () => {
    const bot = new Bot("123:test", { botInfo: ME });
    const sent = fakeTelegramApi(bot.api);
    await new AgentIdentities(bot, { env: {} }).sendAsAgent("research", 1, MD, { threadId: 443 });
    expectHtmlPieces(sent);
  });

  test("Outbox (sendAndRecord mit Format markdown, Stücke aus textChunks)", async () => {
    const { sent, fetch } = fakeTelegramFetch();
    const deps: OutboxDeps = {
      botToken: "123:test",
      userId: "4711",
      groupId: null,
      outboxDir: join(base, "outbox"),
      fetch,
      record: async () => true,
      log: () => {},
      newId: () => crypto.randomUUID(),
    };
    const result = await sendAndRecord({ source: "test", text: MD }, deps);
    expect(result.sent).toBe(true);
    expectHtmlPieces(sent);
  });
});
