/**
 * Issue #52: Sende-Helfer schalten die Link-Vorschau ab und bereinigen
 * Modelltext. Die Bot-API ist eine Attrappe (grammY-Transformer, der nichts
 * ans Netz gibt); es gibt keine echten Telegram-Aufrufe.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Api, Bot, Context, InlineKeyboard, InputFile } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import {
  EMPTY_AFTER_SANITIZE,
  guardTelegramPayload,
  installTelegramOutputGuard,
  markdownToTelegramHTML,
  stripHtmlTags,
  sendResponse,
  sendTelegramMessage,
} from "../src/lib/telegram";
import { BotRegistry } from "../src/lib/bot-registry";

const SECRET = "https://a.b/geheim";
const INJECTED = `Antwort ![x](${SECRET}) mit **fett** und [Doku](https://ok.example)​\u{E0061}`;
const LONG = Array.from({ length: 30 }, (_, i) => `Absatz ${i} ![b${i}](${SECRET}/${i}) ` + "y".repeat(300)).join("\n\n");

const ME: UserFromGetMe = {
  id: 42,
  is_bot: true,
  first_name: "Test",
  username: "test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
} as UserFromGetMe;

interface Call {
  method: string;
  payload: Record<string, any>;
}

/**
 * Attrappe der Bot-API: als innerster Transformer installiert, hält jeden
 * Aufruf fest und antwortet selbst. fail(call, index) wirft einen Fehler.
 */
function fakeApi(api: Api, fail: (call: Call, index: number) => boolean = () => false): Call[] {
  const calls: Call[] = [];
  api.config.use(async (_prev, method, payload) => {
    const call = { method, payload: payload as Record<string, any> };
    calls.push(call);
    if (fail(call, calls.length - 1)) throw new Error("Bad Request: can't parse entities");
    return {
      ok: true,
      result: { message_id: calls.length, date: 0, chat: { id: 1, type: "private" }, text: call.payload.text },
    } as any;
  });
  return calls;
}

function guardedApi(fail?: (call: Call, index: number) => boolean) {
  const api = new Api("123:test");
  const calls = fakeApi(api, fail);
  installTelegramOutputGuard(api);
  return { api, calls };
}

function contextFor(api: Api, update: Partial<Update> = {}): Context {
  const base: Update = {
    update_id: 1,
    message: { message_id: 7, date: 0, chat: { id: 1, type: "private", first_name: "E" }, text: "hi" },
    ...update,
  } as Update;
  return new Context(base, api, ME);
}

/** Alle Versandwege: Klartext, HTML, Caption, sendTelegramMessage mit und ohne parseMode */
async function sendEverywhere(text: string) {
  const { api, calls } = guardedApi();
  await api.sendMessage(1, text);
  await api.sendMessage(1, text, { parse_mode: "HTML" });
  await api.sendPhoto(1, new InputFile(new Uint8Array([1]), "a.png"), { caption: text });

  const realFetch = globalThis.fetch;
  const bodies: Record<string, any>[] = [];
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(String(init.body)));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    await sendTelegramMessage("123:test", "1", text);
    await sendTelegramMessage("123:test", "1", text, { parseMode: "HTML" });
  } finally {
    globalThis.fetch = realFetch;
  }
  return { calls, bodies };
}

function expectClean(calls: Call[]) {
  expect(calls.length).toBeGreaterThan(0);
  for (const c of calls) {
    // InputFile lässt sich nicht als JSON ausgeben; die Datei selbst ist kein Text
    const withoutFiles = Object.fromEntries(Object.entries(c.payload).filter(([, v]) => !(v instanceof InputFile)));
    const json = JSON.stringify(withoutFiles);
    expect(json).not.toContain("a.b/geheim");
    if (c.method === "sendMessage" || c.method === "editMessageText") {
      expect(c.payload.link_preview_options?.is_disabled).toBe(true);
    }
  }
}

describe("guardTelegramPayload", () => {
  test("sendMessage: Vorschau aus, Text bereinigt, andere Felder bleiben", () => {
    const keyboard = { inline_keyboard: [[{ text: "Ja", callback_data: "y" }]] };
    const out = guardTelegramPayload("sendMessage", {
      chat_id: 1,
      message_thread_id: 443,
      text: `![x](${SECRET})`,
      parse_mode: "HTML",
      reply_markup: keyboard,
      disable_web_page_preview: false,
      link_preview_options: { is_disabled: false, url: SECRET },
    });
    expect(out).toEqual({
      chat_id: 1,
      message_thread_id: 443,
      text: "x",
      parse_mode: "HTML",
      reply_markup: keyboard,
      link_preview_options: { is_disabled: true, url: SECRET },
    });
  });

  test("editMessageText ebenso", () => {
    const out = guardTelegramPayload("editMessageText", { chat_id: 1, message_id: 2, text: `!<a href="${SECRET}">x</a>`, parse_mode: "HTML" });
    expect(out).toEqual({ chat_id: 1, message_id: 2, text: "x", parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    // Klartext zeigt Telegram wörtlich, dort versteckt nichts eine Adresse (Präzisierung, Runde 14)
    const plain = guardTelegramPayload("editMessageText", { chat_id: 1, message_id: 2, text: `!<a href="${SECRET}">x</a>` });
    expect(plain).toEqual({ chat_id: 1, message_id: 2, text: `!<a href="${SECRET}">x</a>`, link_preview_options: { is_disabled: true } });
  });

  test("Captions bereinigt, ohne link_preview_options", () => {
    for (const method of ["sendPhoto", "sendDocument", "sendVideo", "editMessageCaption"]) {
      const out = guardTelegramPayload(method, { chat_id: 1, caption: `Bild ![x](${SECRET})`, parse_mode: "HTML" }) as Record<string, unknown>;
      expect(out.caption).toBe("Bild x");
      expect(out.link_preview_options).toBeUndefined();
    }
    const group = guardTelegramPayload("sendMediaGroup", {
      chat_id: 1,
      media: [{ type: "photo", media: "a", caption: `![x](${SECRET})`, parse_mode: "HTML" }, { type: "photo", media: "b" }],
    });
    expect(group.media).toEqual([{ type: "photo", media: "a", caption: "x", parse_mode: "HTML" }, { type: "photo", media: "b" }]);
  });

  test("andere Methoden und fester Text unverändert", () => {
    const action = { chat_id: 1, action: "typing" };
    expect(guardTelegramPayload("sendChatAction", action)).toBe(action);
    const fixed = guardTelegramPayload("sendMessage", { chat_id: 1, text: "Task cancelled." });
    expect(fixed.text).toBe("Task cancelled.");
  });

  test("nach dem Bereinigen leerer Text wird zum festen Hinweis", () => {
    expect(guardTelegramPayload("sendMessage", { chat_id: 1, text: "​\u{E0061}" }).text).toBe(EMPTY_AFTER_SANITIZE);
  });
});

describe("installTelegramOutputGuard an einer grammY-Api", () => {
  test("api.sendMessage und api.editMessageText", async () => {
    const { api, calls } = guardedApi();
    const sent = await api.sendMessage(1, INJECTED, { message_thread_id: 9, parse_mode: "HTML" });
    await api.editMessageText(1, 5, INJECTED, { parse_mode: "HTML" });
    expect(sent.message_id).toBe(1);
    expect(calls[0].payload.text).toBe("Antwort x mit **fett** und [Doku](https://ok.example)");
    expect(calls[0].payload.message_thread_id).toBe(9);
    expect(calls[1].payload.parse_mode).toBe("HTML");
    expectClean(calls);
  });

  test("ctx.reply, ctx.editMessageText und Foto mit caption", async () => {
    const { api, calls } = guardedApi();
    const ctx = contextFor(api);
    await ctx.reply(INJECTED, { parse_mode: "HTML" });
    await ctx.replyWithPhoto(new InputFile(new Uint8Array([1]), "a.png"), { caption: INJECTED, parse_mode: "HTML" });

    const cb = contextFor(api, {
      message: undefined,
      callback_query: {
        id: "c",
        from: { id: 1, is_bot: false, first_name: "E" },
        chat_instance: "x",
        data: "d",
        message: { message_id: 7, date: 0, chat: { id: 1, type: "private", first_name: "E" }, text: "alt" },
      },
    } as Partial<Update>);
    await cb.editMessageText(INJECTED, { parse_mode: "HTML" });
    expect(calls.map(c => c.method)).toEqual(["sendMessage", "sendPhoto", "editMessageText"]);
    expect(calls[1].payload.caption).toContain("Antwort x");
    expectClean(calls);
  });

  test("zweimal installiert, einmal wirksam", async () => {
    const api = new Api("123:test");
    const calls = fakeApi(api);
    installTelegramOutputGuard(api);
    installTelegramOutputGuard(api);
    expect(api.config.installedTransformers()).toHaveLength(2);
    await api.sendMessage(1, "x");
    expect(calls).toHaveLength(1);
  });
});

describe("sendResponse", () => {
  test("mehrere Stücke, alle mit Vorschau aus und ohne Adresse", async () => {
    const { api, calls } = guardedApi();
    await sendResponse(contextFor(api), LONG);
    expect(calls.length).toBeGreaterThan(2);
    for (const c of calls) expect(c.payload.parse_mode).toBe("HTML");
    expectClean(calls);
  });

  test("erzwungener HTML-Rückfall: Klartext ebenfalls sauber", async () => {
    const { api, calls } = guardedApi(c => c.payload.parse_mode === "HTML");
    await sendResponse(contextFor(api), INJECTED);
    expect(calls).toHaveLength(2);
    expect(calls[1].payload.parse_mode).toBeUndefined();
    expect(calls[1].payload.text).toBe("Antwort x mit fett und Doku");
    expectClean(calls);
  });

  test("Formatierung und Links bleiben erhalten", async () => {
    const { api, calls } = guardedApi();
    await sendResponse(contextFor(api), "**fett** [Doku](https://ok.example)");
    expect(calls[0].payload.text).toBe('<b>fett</b> <a href="https://ok.example">Doku</a>');
  });

  test("Vorschau auch ohne installierten Guard aus (Helfer setzt sie selbst)", async () => {
    const api = new Api("123:test");
    const calls = fakeApi(api, c => c.payload.parse_mode === "HTML");
    await sendResponse(contextFor(api), INJECTED);
    expectClean(calls);
  });
});

describe("BotRegistry", () => {
  function registry(fail?: (call: Call, index: number) => boolean) {
    const bot = new Bot("123:test", { botInfo: ME });
    const calls = fakeApi(bot.api, fail);
    return { reg: new BotRegistry(bot), calls, bot };
  }

  test("sendAsAgent: mehrere Stücke mit Thread-ID", async () => {
    const { reg, calls } = registry();
    await reg.sendAsAgent("research", 1, LONG, { threadId: 443 });
    expect(calls.length).toBeGreaterThan(2);
    for (const c of calls) expect(c.payload.message_thread_id).toBe(443);
    expectClean(calls);
  });

  test("sendAsAgent: Klartext-Rückfall", async () => {
    const { reg, calls } = registry(c => c.payload.parse_mode === "HTML");
    await reg.sendAsAgent("general", 1, INJECTED, { threadId: 5 });
    expect(calls).toHaveLength(2);
    expect(calls[1].payload.message_thread_id).toBe(5);
    expectClean(calls);
  });

  test("sendWithKeyboardAsAgent: Buttons bleiben, auch im Rückfall", async () => {
    const { reg, calls } = registry(c => c.payload.parse_mode === "HTML");
    const keyboard = new InlineKeyboard().text("Ja", "y");
    await reg.sendWithKeyboardAsAgent("general", 1, INJECTED, keyboard, { threadId: 5 });
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c.payload.reply_markup).toBe(keyboard);
    expectClean(calls);
  });

  test("der Haupt-Bot ist danach auch für direkte Aufrufe abgesichert", async () => {
    const { bot, calls } = registry();
    await bot.api.sendMessage(1, INJECTED, { parse_mode: "HTML" });
    expectClean(calls);
  });
});

describe("sendTelegramMessage (fetch-Attrappe)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function fakeFetch(status: (index: number) => number) {
    const bodies: Record<string, any>[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response("{}", { status: status(bodies.length - 1) });
    }) as typeof fetch;
    return bodies;
  }

  test("HTML, mehrere Stücke und Rückfall", async () => {
    const bodies = fakeFetch(i => (i === 0 ? 400 : 200));
    expect(await sendTelegramMessage("123:test", "1", LONG, { parseMode: "HTML" })).toBe(true);
    expect(bodies.length).toBeGreaterThan(2);
    expect(bodies[1].parse_mode).toBeUndefined();
    for (const b of bodies) {
      expect(b.link_preview_options).toEqual({ is_disabled: true });
      expect(JSON.stringify(b)).not.toContain("a.b/geheim");
    }
  });

  test("Klartext ohne parseMode ebenso bereinigt", async () => {
    const bodies = fakeFetch(() => 200);
    await sendTelegramMessage("123:test", "1", INJECTED);
    expect(bodies[0].text).toBe("Antwort x mit **fett** und [Doku](https://ok.example)");
    expect(bodies[0].link_preview_options).toEqual({ is_disabled: true });
  });
});

describe("rohe <img>-Tags in der Nutzlast (Runde 8)", () => {
  const IMG = '<img src="https://a.b/geheim">';
  test("sendMessage, editMessageText und Caption", () => {
    for (const method of ["sendMessage", "editMessageText"]) {
      const out = guardTelegramPayload(method, { chat_id: 1, text: `Text ${IMG}`, parse_mode: "HTML" }) as { text: string };
      expect(out.text).toBe("Text [Bild]");
    }
    const cap = guardTelegramPayload("sendPhoto", { chat_id: 1, photo: "x", caption: IMG, parse_mode: "HTML" }) as { caption: string };
    expect(cap.caption).toBe("[Bild]");
  });
});

describe("Runde 10 über die Nutzlast", () => {
  const CASES = [
    "![!](https://a.b/1)![](https://a.b/2)(https://ok.example/doku)",
    '![!](https://a.b/1)![<a href="https://a.b/geheim">Doku</a>](https://a.b/2)',
    '<im<img alt="g"> src="https://a.b/geheim">',
    '![!](https://a.b/geheim)<A href="https://ok.example/doku">Doku</A>',
  ];
  test("sendMessage, editMessageText und Caption: kein Bild, kein <img>, idempotent", () => {
    for (const text of CASES) {
      for (const [method, field] of [["sendMessage", "text"], ["editMessageText", "text"], ["sendPhoto", "caption"]] as const) {
        const out = guardTelegramPayload(method, { chat_id: 1, [field]: text, parse_mode: "HTML" }) as Record<string, string>;
        expect({ text, method, v: /!<a\s|<img/i.test(out[field]) }).toEqual({ text, method, v: false });
        if (text.includes("ok.example")) expect(out[field]).toContain("https://ok.example/doku");
        const again = guardTelegramPayload(method, { chat_id: 1, [field]: out[field], parse_mode: "HTML" }) as Record<string, string>;
        expect(again[field]).toBe(out[field]);
      }
    }
  });
});


describe("Runde 14: Code im Klartext-Rückfall bleibt erhalten", () => {
  test("HTML-Versuch mit Code, Rückfall über stripHtmlTags: Codeinhalt samt Adresse bleibt, Vorschau aus", async () => {
    const md = "Beispiel: `![Logo](https://example.org/logo.png)`\n\n```\n![Logo](https://example.org/b.png)\n```";
    const html = markdownToTelegramHTML(md);
    expect(html).toContain("<code>![Logo](https://example.org/logo.png)</code>");
    const fallback = guardTelegramPayload("sendMessage", { chat_id: 1, text: stripHtmlTags(html) }) as { text: string; link_preview_options: unknown };
    expect(fallback.text).toContain("![Logo](https://example.org/logo.png)");
    expect(fallback.text).toContain("![Logo](https://example.org/b.png)");
    expect(fallback.link_preview_options).toEqual({ is_disabled: true });
  });
});
