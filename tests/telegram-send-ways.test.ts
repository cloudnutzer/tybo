/**
 * Issue #328, Aufgabe 1: Die Verträge der sieben Telegram-Sendewege und des
 * Tipp-Indikators, festgehalten, bevor sie auf sendRendered umziehen.
 *
 * Je Weg: Teilen, Link-Vorschau an jedem Stück, Thread-ID nur wenn gesetzt,
 * wann auf Klartext zurückgefallen wird (bei jedem Fehler oder nur bei 400),
 * was nach einem gescheiterten Stück passiert, wo die Knöpfe hängen. Die
 * gewollten Änderungen (Weg 2 hängt Knöpfe nur einmal an, Wege 4 und 6 teilen
 * lange Texte) stehen in eigenen Tests.
 *
 * Seit Aufgabe 3 laufen alle Wege über sendRendered
 * (src/channels/telegram/send.ts), die gewollten Änderungen sind grün.
 *
 * Bot-API, Context und fetch sind Attrappen, es gibt kein Netz. src/bot.ts
 * wird nie importiert.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Api, Bot, Context, GrammyError, InlineKeyboard } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { AgentIdentities } from "../src/channels/telegram/identities";
import { sendAndRecord, type OutboxDeps } from "../src/lib/outbox";
import { createTypingIndicator, sendResponse, sendTelegramMessage } from "../src/channels/telegram/send";
import { createTelegramRuntime } from "../src/lib/telegram-runtime";
import type { Message } from "../src/lib/store/types";
import { isolateAgentCatalog } from "./catalog-fixture";

// Die Agenten-Identitäten lesen den Katalog (Issue #330): nie die echte config/agents.json
isolateAgentCatalog();

const ME = { id: 42, is_bot: true, first_name: "Test", username: "haupt_bot" } as UserFromGetMe;
const AGENT_ME = { id: 43, is_bot: true, first_name: "Recherche", username: "recherche_bot" } as UserFromGetMe;
const TOKEN = "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn";
const AGENT_TOKEN = "987654321:AAFakeAgentTokenForTests_zyxwvutsrqpon";
const USER = "424242";
const NO_PREVIEW = { is_disabled: true };

/** Drei gleiche Absätze: über 4.096 Zeichen, drei gleiche Stücke (das letzte gleicht den früheren) */
const PARA = "Gleicher Absatz " + "wort ".repeat(480).trim();
const SAME = [PARA, PARA, PARA].join("\n\n");
/** Kurzer Text, der als HTML anders aussieht als im Klartext */
const SHORT = "**fett** und a < b";
const SHORT_HTML = "<b>fett</b> und a &lt; b";
const SHORT_PLAIN = "fett und a < b";
const BUTTONS = [[{ text: "Ja", callback_data: "ja" }]];

// ------------------------------------------------------------
// Attrappen
// ------------------------------------------------------------

interface Call {
  method: string;
  payload: Record<string, any>;
  /** Hat die Attrappe die Nachricht angenommen? */
  accepted: boolean;
}

/** Antwort der Attrappe auf ein sendMessage: annehmen, HTTP-Status als GrammyError, oder ein Fehler (Netz) */
type Reply = "ok" | number | Error;
type Policy = (payload: Record<string, any>, index: number) => Reply;

/** Wie Telegram: zu lange Texte mit 400 ablehnen */
const telegramLike: Policy = p => (String(p.text ?? "").length > 4096 ? 400 : "ok");
/** Jedes HTML-Stück mit 400 ablehnen (Klartext-Rückfall erzwingen) */
const rejectHtml: Policy = p => (p.parse_mode === "HTML" ? 400 : telegramLike(p, 0));

/**
 * Bot-API-Attrappe als innerster grammY-Transformer: hält jeden Aufruf mit der
 * Nutzlast fest, die nach dem Output-Guard ankommt, und antwortet selbst.
 */
function recordApi(api: Api, policy: Policy = telegramLike, me: UserFromGetMe = ME): Call[] {
  const calls: Call[] = [];
  let nextId = 100;
  api.config.use(async (_prev, method, payload) => {
    const call: Call = { method, payload: { ...(payload as Record<string, any>) }, accepted: true };
    calls.push(call);
    if (method === "getMe") return { ok: true, result: me } as any;
    if (method === "sendMessage") {
      const reply = policy(call.payload, calls.filter(c => c.method === "sendMessage").length - 1);
      if (reply !== "ok") {
        call.accepted = false;
        if (reply instanceof Error) throw reply;
        throw new GrammyError(`Call to 'sendMessage' failed! (${reply}: Bad Request)`, { ok: false, error_code: reply, description: "Bad Request" }, method, payload as any);
      }
    }
    return { ok: true, result: { message_id: ++nextId, date: 0, chat: { id: 1, type: "private" }, text: call.payload.text } } as any;
  });
  return calls;
}

const messages = (calls: Call[]) => calls.filter(c => c.method === "sendMessage");
const acceptedMessages = (calls: Call[]) => messages(calls).filter(c => c.accepted);

/** Context für eine Nachricht im Direktchat oder (thread gesetzt) in einem Forum-Topic */
function contextFor(api: Api, thread?: number): Context {
  const message = thread
    ? { message_id: 7, date: 0, chat: { id: -100, type: "supergroup", title: "G" }, text: "hi", is_topic_message: true, message_thread_id: thread }
    : { message_id: 7, date: 0, chat: { id: 1, type: "private", first_name: "A" }, text: "hi" };
  return new Context({ update_id: 1, message } as Update, api, ME);
}

/** Telegram-Laufzeit mit Attrappen-Bot; liefert die Aufrufe des Haupt-Bots */
function runtimeWith(policy: Policy = telegramLike) {
  let calls: Call[] = [];
  const runtime = createTelegramRuntime({
    env: { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_USER_ID: USER },
    createBot: token => {
      const bot = new Bot(token, { botInfo: ME });
      calls = recordApi(bot.api, policy);
      return bot;
    },
    createAgentBots: bot => new AgentIdentities(bot, { env: {} }),
    log: () => {},
  });
  return { runtime, calls: () => calls };
}

/** Agenten-Identitäten mit Haupt-Bot und einem Agenten-Bot (research) */
async function registryWith(policy: Policy = telegramLike) {
  const primary = new Bot(TOKEN, { botInfo: ME });
  const primaryCalls = recordApi(primary.api, policy);
  let agentCalls: Call[] = [];
  const registry = new AgentIdentities(primary, {
    env: { TELEGRAM_BOT_TOKEN_RESEARCH: AGENT_TOKEN },
    createBot: token => {
      const bot = new Bot(token);
      agentCalls = recordApi(bot.api, policy, AGENT_ME);
      return bot;
    },
  });
  await registry.initialize();
  return { registry, primaryCalls, agentCalls: () => agentCalls };
}

/** fetch-Attrappe für Weg 2: reply je Aufruf, Antwort wie die Bot-API */
interface FetchCall {
  url: string;
  body: Record<string, any>;
  accepted: boolean;
}
function fakeGlobalFetch(reply: Policy = telegramLike): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    const call: FetchCall = { url: String(url), body, accepted: false };
    calls.push(call);
    const r = reply(body, calls.length - 1);
    if (r instanceof Error) throw r;
    if (r !== "ok") return new Response(JSON.stringify({ ok: false, error_code: r, description: "Bad Request" }), { status: r });
    call.accepted = true;
    return new Response(JSON.stringify({ ok: true, result: { message_id: 500 + calls.length } }), { status: 200 });
  }) as typeof fetch;
  return calls;
}

/** Outbox-Abhängigkeiten mit fetch-Attrappe (Weg 7) */
function outboxWith(reply: (body: Record<string, any>, index: number) => Reply | { status: number; body: string }) {
  const dir = mkdtempSync(join(tmpdir(), "send-ways-"));
  dirs.push(dir);
  const calls: FetchCall[] = [];
  const recorded: Message[] = [];
  const logs: string[] = [];
  const deps: OutboxDeps = {
    botToken: "123:test",
    userId: USER,
    groupId: "-1001234567890",
    outboxDir: join(dir, "outbox"),
    fetch: async (url, init) => {
      const body = JSON.parse(String(init.body)) as Record<string, any>;
      const call: FetchCall = { url, body, accepted: false };
      calls.push(call);
      const r = reply(body, calls.length - 1);
      if (r instanceof Error) throw r;
      if (typeof r === "object") return new Response(r.body, { status: r.status });
      if (r !== "ok") return new Response(JSON.stringify({ ok: false, error_code: r, description: "Bad Request" }), { status: r });
      call.accepted = true;
      return new Response(JSON.stringify({ ok: true, result: { message_id: 700 + calls.length } }), { status: 200 });
    },
    record: async m => {
      recorded.push(m);
      return true;
    },
    log: line => logs.push(line),
    newId: () => crypto.randomUUID(),
  };
  return { deps, calls, recorded, logs };
}

const dirs: string[] = [];
const realFetch = globalThis.fetch;
let quiet: ReturnType<typeof spyOn>[] = [];
beforeEach(() => {
  quiet = [
    spyOn(console, "error").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
    spyOn(console, "log").mockImplementation(() => {}),
  ];
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const s of quiet) s.mockRestore();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Jedes Stück: Vorschau aus; bei HTML parse_mode HTML, sonst keiner */
function expectPreviewOff(payloads: Record<string, any>[]) {
  expect(payloads.length).toBeGreaterThan(0);
  for (const p of payloads) expect(p.link_preview_options).toEqual(NO_PREVIEW);
}

/** Knöpfe genau einmal unter den angenommenen Nachrichten, am letzten; abgelehnte Versuche nur am letzten Stück */
function expectKeyboardOnceAtEnd(all: { payload: Record<string, any>; accepted: boolean }[], keyboard: unknown) {
  const accepted = all.filter(c => c.accepted);
  expect(accepted.length).toBeGreaterThan(1);
  expect(accepted.map(c => c.payload.reply_markup !== undefined)).toEqual(accepted.map((_, i) => i === accepted.length - 1));
  expect(accepted.at(-1)!.payload.reply_markup).toEqual(keyboard);
  // Ein abgelehnter HTML-Versuch trägt die Knöpfe nur, wenn er das letzte Stück ist
  const lastText = accepted.at(-1)!.payload.text;
  for (const [i, c] of all.entries()) {
    if (c.accepted || c.payload.reply_markup === undefined) continue;
    expect(all.slice(i + 1).every(n => n.payload.text === lastText || n.payload.reply_markup === undefined)).toBe(true);
    expect(all.slice(i + 1).filter(n => n.accepted)).toHaveLength(1);
  }
}

// ------------------------------------------------------------
// Weg 1: sendResponse(ctx, …)
// ------------------------------------------------------------

describe("Weg 1: sendResponse", () => {
  test("teilt, jedes Stück HTML mit Vorschau aus, ohne Thread-ID im Direktchat", async () => {
    const api = new Api("123:test");
    const calls = recordApi(api);
    await sendResponse(contextFor(api), SAME);
    const sent = messages(calls);
    expect(sent).toHaveLength(3);
    for (const c of sent) {
      expect(c.payload.parse_mode).toBe("HTML");
      expect(c.payload.chat_id).toBe(1);
      expect("message_thread_id" in c.payload).toBe(false);
    }
    expectPreviewOff(sent.map(c => c.payload));
  });

  test("im Forum-Topic: Thread-ID an jedem Stück, auch im Rückfall", async () => {
    const api = new Api("123:test");
    const calls = recordApi(api, rejectHtml);
    await sendResponse(contextFor(api, 77), SHORT);
    const sent = messages(calls);
    expect(sent).toHaveLength(2);
    for (const c of sent) expect(c.payload.message_thread_id).toBe(77);
  });

  test("Rückfall bei jedem Fehler (auch ohne Status) als Klartext mit Vorschau aus", async () => {
    const api = new Api("123:test");
    const calls = recordApi(api, (p, i) => (i === 0 ? new Error("Netz weg") : "ok"));
    await sendResponse(contextFor(api), SHORT);
    const sent = messages(calls);
    expect(sent.map(c => c.payload.text)).toEqual([SHORT_HTML, SHORT_PLAIN]);
    expect(sent[1].payload.parse_mode).toBeUndefined();
    expectPreviewOff(sent.map(c => c.payload));
  });

  test("gescheitertes Stück: loggen, weiter mit dem nächsten, wirft nicht", async () => {
    const api = new Api("123:test");
    const calls = recordApi(api, (_p, i) => (i < 2 ? new Error("weg") : "ok"));
    await sendResponse(contextFor(api), SAME);
    const sent = messages(calls);
    // Stück 1: HTML und Klartext scheitern; Stücke 2 und 3 kommen an
    expect(sent).toHaveLength(4);
    expect(acceptedMessages(calls)).toHaveLength(2);
    expect(quiet[0]).toHaveBeenCalled();
  });

  test("Sprachzweig: mit Audio nur replyWithVoice, ohne Audio Text", async () => {
    const api = new Api("123:test");
    const calls = recordApi(api);
    const spoken: string[] = [];
    await sendResponse(contextFor(api), "Hallo", true, async t => {
      spoken.push(t);
      return Buffer.from("RIFF");
    });
    expect(spoken).toEqual(["Hallo"]);
    expect(calls.map(c => c.method)).toEqual(["sendVoice"]);

    // Ohne Audio: Text
    const api2 = new Api("123:test");
    const recorded = recordApi(api2);
    await sendResponse(contextFor(api2), "Hallo", true, async () => null);
    expect(recorded.map(c => c.method)).toEqual(["sendMessage"]);
    // Ohne wantsVoice wird die Sprachfunktion nicht gerufen
    let asked = 0;
    await sendResponse(contextFor(api2), "Hallo", false, async () => {
      asked++;
      return Buffer.from("x");
    });
    expect(asked).toBe(0);
  });

  test("Bildzweig: Foto mit bereinigter Caption, Rest als Text; Fehler beim Foto still", async () => {
    const api = new Api("123:test");
    const calls = recordApi(api);
    await sendResponse(contextFor(api), "Vorher [IMAGE:/tmp/gibt-es-nicht.png|Bild\u200B mit Text] nachher");
    expect(calls.map(c => c.method)).toEqual(["sendPhoto", "sendMessage"]);
    expect(calls[0].payload.caption).toBe("Bild mit Text");
    expect(calls[1].payload.text).toBe("Vorher  nachher");

    const api2 = new Api("123:test");
    const calls2: Call[] = [];
    api2.config.use(async (_prev, method, payload) => {
      calls2.push({ method, payload: payload as any, accepted: method !== "sendPhoto" });
      if (method === "sendPhoto") throw new Error("Foto kaputt");
      return { ok: true, result: { message_id: 1, date: 0, chat: { id: 1, type: "private" } } } as any;
    });
    await sendResponse(contextFor(api2), "[IMAGE:/tmp/x.png] Text danach");
    expect(calls2.map(c => c.method)).toEqual(["sendPhoto", "sendMessage"]);
    expect(calls2[1].payload.text).toBe("Text danach");

    // Nur ein Bild ohne Text: keine Textnachricht
    const api3 = new Api("123:test");
    const calls3 = recordApi(api3);
    await sendResponse(contextFor(api3), "[IMAGE:/tmp/x.png|Titel]");
    expect(calls3.map(c => c.method)).toEqual(["sendPhoto"]);
  });
});

// ------------------------------------------------------------
// Weg 2: sendTelegramMessage (direkter fetch)
// ------------------------------------------------------------

describe("Weg 2: sendTelegramMessage", () => {
  test("mit parseMode: HTML-Stücke an sendMessage des Tokens, Vorschau aus, keine Thread-ID", async () => {
    const calls = fakeGlobalFetch();
    expect(await sendTelegramMessage("123:test", "55", SAME, { parseMode: "HTML" })).toBe(true);
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.url).toBe("https://api.telegram.org/bot123:test/sendMessage");
      expect(c.body.chat_id).toBe("55");
      expect(c.body.parse_mode).toBe("HTML");
      expect("message_thread_id" in c.body).toBe(false);
    }
    expectPreviewOff(calls.map(c => c.body));
  });

  test("Rückfall nur bei 400: Klartext ohne parse_mode, Vorschau aus", async () => {
    const calls = fakeGlobalFetch((_b, i) => (i === 0 ? 400 : "ok"));
    expect(await sendTelegramMessage("123:test", "55", SHORT, { parseMode: "HTML" })).toBe(true);
    expect(calls.map(c => c.body.text)).toEqual([SHORT_HTML, SHORT_PLAIN]);
    expect(calls[1].body.parse_mode).toBeUndefined();
    expectPreviewOff(calls.map(c => c.body));
  });

  test("bei 500, 403 oder Netzfehler kein Rückfall; Rückgabe false, die übrigen Stücke werden trotzdem versucht", async () => {
    for (const failure of [500, 403, new Error("Netz weg")] as Reply[]) {
      const calls = fakeGlobalFetch((_b, i) => (i === 0 ? failure : "ok"));
      expect(await sendTelegramMessage("123:test", "55", SAME, { parseMode: "HTML" })).toBe(false);
      expect(calls).toHaveLength(3);
      expect(calls.every(c => c.body.parse_mode === "HTML")).toBe(true);
    }
  });

  test("Rückfall scheitert auch: false, nächstes Stück wird versucht", async () => {
    const calls = fakeGlobalFetch((_b, i) => (i < 2 ? 400 : "ok"));
    expect(await sendTelegramMessage("123:test", "55", SAME, { parseMode: "HTML" })).toBe(false);
    expect(calls).toHaveLength(4);
    expect(calls.filter(c => c.accepted)).toHaveLength(2);
  });

  test("ohne parseMode: Klartext ohne parse_mode, bereinigt, kein Rückfall bei 400", async () => {
    const calls = fakeGlobalFetch(() => 400);
    expect(await sendTelegramMessage("123:test", "55", "a < b ![x](https://a.b/geheim)​")).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.text).toBe("a < b x");
    expect(calls[0].body.parse_mode).toBeUndefined();
    expectPreviewOff(calls.map(c => c.body));
  });

  test("ohne parseMode: lange Texte in Stücken", async () => {
    const calls = fakeGlobalFetch();
    expect(await sendTelegramMessage("123:test", "55", SAME)).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls.every(c => c.body.parse_mode === undefined)).toBe(true);
  });

  test("Knöpfe an der Nachricht, auch im Klartext-Rückfall", async () => {
    const calls = fakeGlobalFetch(rejectHtml);
    expect(await sendTelegramMessage("123:test", "55", SHORT, { parseMode: "HTML", buttons: BUTTONS })).toBe(true);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.body.reply_markup).toEqual({ inline_keyboard: BUTTONS });
  });

  test("gleiche Stücke: Tastatur genau einmal, nur am letzten (gewollte Änderung)", async () => {
    for (const policy of [telegramLike, rejectHtml]) {
      const calls = fakeGlobalFetch(policy);
      expect(await sendTelegramMessage("123:test", "55", SAME, { parseMode: "HTML", buttons: BUTTONS })).toBe(true);
      expectKeyboardOnceAtEnd(calls.map(c => ({ payload: c.body, accepted: c.accepted })), { inline_keyboard: BUTTONS });
    }
    const plain = fakeGlobalFetch();
    expect(await sendTelegramMessage("123:test", "55", SAME, { buttons: BUTTONS })).toBe(true);
    expectKeyboardOnceAtEnd(plain.map(c => ({ payload: c.body, accepted: c.accepted })), { inline_keyboard: BUTTONS });
  });
});

// ------------------------------------------------------------
// Wege 3 und 4: Telegram-Laufzeit
// ------------------------------------------------------------

describe("Weg 3: TelegramRuntime.sendMessage", () => {
  test("teilt, HTML, Vorschau aus, Thread-ID nur wenn gesetzt", async () => {
    const { runtime, calls } = runtimeWith();
    await runtime.sendMessage(USER, SAME, 9);
    await runtime.sendMessage(USER, SHORT);
    const sent = messages(calls());
    expect(sent).toHaveLength(4);
    expect(sent.slice(0, 3).every(c => c.payload.message_thread_id === 9 && c.payload.parse_mode === "HTML")).toBe(true);
    expect("message_thread_id" in sent[3].payload).toBe(false);
    expect(sent[3].payload.text).toBe(SHORT_HTML);
    expectPreviewOff(sent.map(c => c.payload));
  });

  test("Rückfall bei jedem Fehler, Thread-ID und Vorschau auch dort", async () => {
    const { runtime, calls } = runtimeWith((_p, i) => (i === 0 ? new Error("weg") : "ok"));
    await runtime.sendMessage(USER, SHORT, 9);
    const sent = messages(calls());
    expect(sent.map(c => c.payload.text)).toEqual([SHORT_HTML, SHORT_PLAIN]);
    expect(sent[1].payload.parse_mode).toBeUndefined();
    expect(sent[1].payload.message_thread_id).toBe(9);
    expectPreviewOff(sent.map(c => c.payload));
  });

  test("gescheitertes Stück: loggen, weiter, wirft nicht", async () => {
    const { runtime, calls } = runtimeWith((_p, i) => (i < 2 ? 400 : "ok"));
    await runtime.sendMessage(USER, SAME);
    expect(messages(calls())).toHaveLength(4);
    expect(acceptedMessages(calls())).toHaveLength(2);
    expect(quiet[0]).toHaveBeenCalled();
  });
});

describe("Weg 4: TelegramRuntime.sendStatus", () => {
  test("kurz: eine HTML-Nachricht mit Knöpfen (dasselbe Objekt), Vorschau aus, Thread-ID nur wenn gesetzt", async () => {
    const { runtime, calls } = runtimeWith();
    const keyboard = new InlineKeyboard().text("Ja", "y");
    await runtime.sendStatus(USER, SHORT, 4, keyboard);
    await runtime.sendStatus(USER, SHORT);
    const sent = messages(calls());
    expect(sent).toHaveLength(2);
    expect(sent[0].payload).toMatchObject({ text: SHORT_HTML, parse_mode: "HTML", message_thread_id: 4 });
    expect(sent[0].payload.reply_markup).toBe(keyboard);
    expect("message_thread_id" in sent[1].payload).toBe(false);
    expect(sent[1].payload.reply_markup).toBeUndefined();
    expectPreviewOff(sent.map(c => c.payload));
  });

  test("Rückfall bei jedem Fehler mit Knöpfen; scheitert auch der, wirft es nicht", async () => {
    const keyboard = new InlineKeyboard().text("Ja", "y");
    const first = runtimeWith((_p, i) => (i === 0 ? new Error("weg") : "ok"));
    await first.runtime.sendStatus(USER, SHORT, 4, keyboard);
    const sent = messages(first.calls());
    expect(sent.map(c => c.payload.text)).toEqual([SHORT_HTML, SHORT_PLAIN]);
    expect(sent[1].payload.reply_markup).toBe(keyboard);
    expect(sent[1].payload.message_thread_id).toBe(4);
    expectPreviewOff(sent.map(c => c.payload));

    const both = runtimeWith(() => 400);
    await expect(both.runtime.sendStatus(USER, SHORT, undefined, keyboard)).resolves.toBeUndefined();
    expect(messages(both.calls())).toHaveLength(2);
  });

  test("Fehler im Rückfall wird geloggt (gewollte Änderung)", async () => {
    const { runtime } = runtimeWith(() => 400);
    await runtime.sendStatus(USER, SHORT);
    expect(quiet[0]).toHaveBeenCalled();
  });

  test("über 4.096 Zeichen: vollständig in mehreren Stücken, Knöpfe genau einmal am letzten (gewollte Änderung)", async () => {
    for (const policy of [telegramLike, rejectHtml]) {
      const { runtime, calls } = runtimeWith(policy);
      const keyboard = new InlineKeyboard().text("Ja", "y");
      await runtime.sendStatus(USER, SAME, 4, keyboard);
      const accepted = acceptedMessages(calls());
      expect(accepted).toHaveLength(3);
      // Vollständiger Inhalt: genau die drei Absätze, nichts fehlt, nichts doppelt
      expect(accepted.map(c => c.payload.text)).toEqual([PARA, PARA, PARA]);
      expect(accepted.every(c => c.payload.message_thread_id === 4)).toBe(true);
      expectKeyboardOnceAtEnd(messages(calls()), keyboard);
    }
  });
});

// ------------------------------------------------------------
// Wege 5 und 6: Agenten-Identitäten (Issue #330)
// ------------------------------------------------------------

describe("Weg 5: AgentIdentities.sendAsAgent", () => {
  test("über den Agenten-Bot, teilt, HTML, Vorschau aus, Thread-ID nur wenn gesetzt", async () => {
    const { registry, primaryCalls, agentCalls } = await registryWith();
    await registry.sendAsAgent("research", 1, SAME, { threadId: 443 });
    await registry.sendAsAgent("research", 1, SHORT);
    const sent = messages(agentCalls());
    expect(sent).toHaveLength(4);
    expect(messages(primaryCalls)).toHaveLength(0);
    expect(sent.slice(0, 3).every(c => c.payload.message_thread_id === 443 && c.payload.parse_mode === "HTML")).toBe(true);
    expect("message_thread_id" in sent[3].payload).toBe(false);
    expectPreviewOff(sent.map(c => c.payload));
  });

  test("Agent ohne eigenen Bot: über den Haupt-Bot", async () => {
    const { registry, primaryCalls, agentCalls } = await registryWith();
    await registry.sendAsAgent("finance", 1, SHORT);
    expect(messages(primaryCalls)).toHaveLength(1);
    expect(messages(agentCalls())).toHaveLength(0);
  });

  test("Rückfall bei jedem Fehler; gescheitertes Stück loggen und weiter", async () => {
    const { registry, agentCalls } = await registryWith((_p, i) => (i < 2 ? new Error("weg") : "ok"));
    await registry.sendAsAgent("research", 1, SAME, { threadId: 5 });
    const sent = messages(agentCalls());
    expect(sent).toHaveLength(4);
    expect(sent[1].payload.parse_mode).toBeUndefined();
    expect(sent[1].payload.message_thread_id).toBe(5);
    expect(acceptedMessages(agentCalls())).toHaveLength(2);
    expectPreviewOff(sent.map(c => c.payload));
    expect(quiet[0]).toHaveBeenCalled();
  });
});

describe("Weg 6: AgentIdentities.sendWithKeyboardAsAgent", () => {
  test("kurz: eine HTML-Nachricht mit Knöpfen über den Agenten-Bot", async () => {
    const { registry, agentCalls } = await registryWith();
    const keyboard = new InlineKeyboard().text("Ja", "y");
    await registry.sendWithKeyboardAsAgent("research", 1, SHORT, keyboard, { threadId: 5 });
    await registry.sendWithKeyboardAsAgent("research", 1, SHORT, keyboard);
    const sent = messages(agentCalls());
    expect(sent).toHaveLength(2);
    expect(sent[0].payload).toMatchObject({ text: SHORT_HTML, parse_mode: "HTML", message_thread_id: 5 });
    expect(sent[0].payload.reply_markup).toBe(keyboard);
    expect("message_thread_id" in sent[1].payload).toBe(false);
    expectPreviewOff(sent.map(c => c.payload));
  });

  test("Rückfall bei jedem Fehler mit Knöpfen; scheitert auch der, wirft es nicht", async () => {
    const keyboard = new InlineKeyboard().text("Ja", "y");
    const { registry, agentCalls } = await registryWith((_p, i) => (i === 0 ? new Error("weg") : "ok"));
    await registry.sendWithKeyboardAsAgent("research", 1, SHORT, keyboard, { threadId: 5 });
    const sent = messages(agentCalls());
    expect(sent.map(c => c.payload.text)).toEqual([SHORT_HTML, SHORT_PLAIN]);
    expect(sent[1].payload.parse_mode).toBeUndefined();
    expect(sent[1].payload.reply_markup).toBe(keyboard);
    expect(sent[1].payload.message_thread_id).toBe(5);

    const failing = await registryWith(() => 400);
    await expect(failing.registry.sendWithKeyboardAsAgent("research", 1, SHORT, keyboard)).resolves.toBeUndefined();
    expect(quiet[0]).toHaveBeenCalled();
  });

  test("über 4.096 Zeichen: vollständig in mehreren Stücken, Knöpfe genau einmal am letzten (gewollte Änderung)", async () => {
    for (const policy of [telegramLike, rejectHtml]) {
      const { registry, agentCalls } = await registryWith(policy);
      const keyboard = new InlineKeyboard().text("Ja", "y");
      await registry.sendWithKeyboardAsAgent("research", 1, SAME, keyboard, { threadId: 5 });
      const accepted = acceptedMessages(agentCalls());
      expect(accepted).toHaveLength(3);
      // Vollständiger Inhalt: genau die drei Absätze, nichts fehlt, nichts doppelt
      expect(accepted.map(c => c.payload.text)).toEqual([PARA, PARA, PARA]);
      expect(accepted.every(c => c.payload.message_thread_id === 5)).toBe(true);
      expectKeyboardOnceAtEnd(messages(agentCalls()), keyboard);
    }
  });
});

// ------------------------------------------------------------
// Weg 7: sendAndRecord (Outbox)
// ------------------------------------------------------------

describe("Weg 7: Outbox", () => {
  test("gleiche Stücke: Knöpfe genau einmal am letzten, auch im Klartext-Rückfall; buttons nur dort", async () => {
    for (const policy of [telegramLike, rejectHtml]) {
      const o = outboxWith(policy);
      const r = await sendAndRecord({ text: SAME, source: "pipeline", buttons: BUTTONS }, o.deps);
      expect(r.sent).toBe(true);
      expectKeyboardOnceAtEnd(o.calls.map(c => ({ payload: c.body, accepted: c.accepted })), { inline_keyboard: BUTTONS });
      expect(r.messages!.map(m => m.buttons)).toEqual([false, false, true]);
      expectPreviewOff(o.calls.map(c => c.body));
    }
  });

  test("Netzfehler im zweiten Stück: genau ein Aufruf dafür, kein Rückfall, kein drittes Stück, rejected false", async () => {
    const o = outboxWith((_b, i) => (i === 1 ? new Error("Netz weg") : "ok"));
    const r = await sendAndRecord({ text: SAME, source: "pipeline", buttons: BUTTONS }, o.deps);
    expect(o.calls).toHaveLength(2);
    expect(r.sent).toBe(false);
    expect(r.error).toEqual({ kind: "send", message: "Telegram hat den Text nicht angenommen" });
    expect(r.messages).toEqual([{ chatId: USER, messageId: 701, part: "text", buttons: false }]);
    expect(o.recorded).toHaveLength(0);
    expect(o.logs).toEqual(["[outbox] Text-Stück 2/3 nicht gesendet (Error)"]);
  });

  test("403 mit ok: false im zweiten Stück: kein Rückfall, Abbruch, rejected true", async () => {
    const o = outboxWith((_b, i) => (i === 1 ? 403 : "ok"));
    const r = await sendAndRecord({ text: SAME, source: "pipeline" }, o.deps);
    expect(o.calls).toHaveLength(2);
    expect(r.error).toEqual({ kind: "send", message: "Telegram hat den Text nicht angenommen", rejected: true });
    expect(o.logs).toEqual(["[outbox] Text-Stück 2/3 nicht gesendet (HTTP 403)"]);
  });

  test("5xx und 4xx ohne lesbare Antwort: kein Rückfall, Abbruch, rejected false", async () => {
    for (const reply of [502, { status: 403, body: "kaputt" }] as const) {
      const o = outboxWith((_b, i) => (i === 0 ? reply : "ok"));
      const r = await sendAndRecord({ text: SAME, source: "pipeline" }, o.deps);
      expect(o.calls).toHaveLength(1);
      expect(r.error?.rejected).toBeUndefined();
      expect(r.messages).toBeUndefined();
    }
  });

  test("400 bei Markdown löst den Rückfall aus, auch mit unlesbarer Antwort; Rückfall-ID zählt", async () => {
    const o = outboxWith((_b, i) => (i === 0 ? { status: 400, body: "kein json" } : "ok"));
    const r = await sendAndRecord({ text: SHORT, source: "pipeline", buttons: BUTTONS, topicId: 7 }, o.deps);
    expect(o.calls.map(c => c.body.text)).toEqual([SHORT_HTML, SHORT_PLAIN]);
    expect(o.calls[1].body).toMatchObject({ message_thread_id: 7, reply_markup: { inline_keyboard: BUTTONS }, link_preview_options: NO_PREVIEW });
    expect(o.calls[1].body.parse_mode).toBeUndefined();
    expect(r.messages).toEqual([{ chatId: "-1001234567890", messageId: 702, part: "text", buttons: true }]);
  });

  test("Rückfall scheitert mit 400: Abbruch, rejected true; mit 502: rejected false", async () => {
    const rejected = outboxWith(() => 400);
    const r1 = await sendAndRecord({ text: SAME, source: "pipeline" }, rejected.deps);
    expect(rejected.calls).toHaveLength(2);
    expect(r1.error?.rejected).toBe(true);
    const unclear = outboxWith((_b, i) => (i === 0 ? 400 : 502));
    const r2 = await sendAndRecord({ text: SAME, source: "pipeline" }, unclear.deps);
    expect(unclear.calls).toHaveLength(2);
    expect(r2.error?.rejected).toBeUndefined();
  });

  test("2xx mit unlesbarer Antwort: angenommen, nur ohne messages", async () => {
    const o = outboxWith(() => ({ status: 200, body: "kein json" }));
    const r = await sendAndRecord({ text: SAME, source: "pipeline" }, o.deps);
    expect(o.calls).toHaveLength(3);
    expect(r).toEqual({ sent: true, recorded: true });
  });

  test("format plain: kein parse_mode, kein Rückfall bei 400; Thread-ID nur mit Topic", async () => {
    const o = outboxWith(() => 400);
    const r = await sendAndRecord({ text: "a < b", source: "pipeline", format: "plain" }, o.deps);
    expect(o.calls).toHaveLength(1);
    expect(o.calls[0].body.text).toBe("a < b");
    expect(o.calls[0].body.parse_mode).toBeUndefined();
    expect("message_thread_id" in o.calls[0].body).toBe(false);
    expect(r.error?.rejected).toBe(true);
  });
});

// ------------------------------------------------------------
// Tipp-Indikator
// ------------------------------------------------------------

describe("Tipp-Indikator", () => {
  /** Uhr-Attrappe für setInterval/clearInterval */
  function fakeClock() {
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const timers = new Map<number, { fn: () => void; ms: number }>();
    let nextId = 1;
    globalThis.setInterval = ((fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { fn, ms });
      return id;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = ((id: number) => {
      timers.delete(id);
    }) as unknown as typeof clearInterval;
    return {
      /** Zeit vorrücken: jeder laufende Zeitgeber feuert so oft, wie seine Periode passt */
      advance(ms: number) {
        for (const t of [...timers.values()]) for (let i = 0; i < Math.floor(ms / t.ms); i++) t.fn();
      },
      active: () => timers.size,
      restore() {
        globalThis.setInterval = realSet;
        globalThis.clearInterval = realClear;
      },
    };
  }

  test("sendet beim Start und alle 4 s typing, nach stop() nichts mehr, nie sendMessage", async () => {
    const clock = fakeClock();
    try {
      const api = new Api("123:test");
      const calls = recordApi(api);
      const typing = createTypingIndicator(contextFor(api, 31));
      typing.start();
      await Bun.sleep(0);
      expect(calls).toHaveLength(1);
      clock.advance(3999);
      await Bun.sleep(0);
      expect(calls).toHaveLength(1);
      clock.advance(4000);
      await Bun.sleep(0);
      expect(calls).toHaveLength(2);
      typing.stop();
      expect(clock.active()).toBe(0);
      clock.advance(40_000);
      await Bun.sleep(0);
      expect(calls).toHaveLength(2);
      for (const c of calls) {
        expect(c.method).toBe("sendChatAction");
        expect(c.payload).toMatchObject({ action: "typing", message_thread_id: 31 });
      }
      // stop() ein zweites Mal schadet nicht
      expect(() => typing.stop()).not.toThrow();
    } finally {
      clock.restore();
    }
  });

  test("Fehler beim Senden werden geschluckt", async () => {
    const clock = fakeClock();
    try {
      const api = new Api("123:test");
      api.config.use(async () => {
        throw new Error("Netz weg");
      });
      const typing = createTypingIndicator(contextFor(api));
      expect(() => typing.start()).not.toThrow();
      clock.advance(4000);
      await Bun.sleep(5);
      typing.stop();
    } finally {
      clock.restore();
    }
  });
});
