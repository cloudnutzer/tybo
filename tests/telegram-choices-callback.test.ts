/**
 * Issue #114, Schritt 2: "ch|"-Callback-Handler. Die Middleware-Kette ist wie
 * in src/bot.ts aufgebaut (Besitzerprüfung, Werkzeug-Freigabe, Rückfragen,
 * allgemeiner Handler), aber mit einem grammy-Composer und einer Api-Attrappe;
 * src/bot.ts wird nur als Quelltext gelesen, nie importiert.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Composer, Context } from "grammy";
import {
  attachChoiceTelegram,
  createChoice,
  decideChoice,
  expireChoice,
  getChoice,
  onChoiceDecided,
  setChoicesFileForTests,
  type Choice,
  type CreateChoiceInput,
} from "../src/lib/choices";
import { createTelegramChoices, installTelegramChoices, type TelegramChoices } from "../src/lib/telegram-choices";

const OWNER = "4711";
const STRANGER = "666";
const CHAT = OWNER;

const base = mkdtempSync(join(tmpdir(), "telegram-choices-callback-"));
let counter = 0;
let logSpy: ReturnType<typeof spyOn>;
let cleanup: (() => void)[] = [];

interface ApiCall {
  method: string;
  args: unknown[];
}

let calls: ApiCall[] = [];
// Prüft die Telegram-Längen wie die echte API: zu lange Texte scheitern
const fakeApi = {
  answerCallbackQuery: async (...args: unknown[]) => {
    const text = (args[1] as { text?: string } | undefined)?.text ?? "";
    if (text.length > 200) throw new Error("Bad Request: MESSAGE_TOO_LONG");
    calls.push({ method: "answerCallbackQuery", args });
    return true;
  },
  editMessageText: async (...args: unknown[]) => {
    if (String(args[2]).length > 4096) throw new Error("Bad Request: MESSAGE_TOO_LONG");
    calls.push({ method: "editMessageText", args });
    return true;
  },
  editMessageReplyMarkup: async (...args: unknown[]) => { calls.push({ method: "editMessageReplyMarkup", args }); return true; },
};

let choices: TelegramChoices;
let composer: Composer<Context>;
let reached: { handler: string; data: string }[] = [];

beforeEach(() => {
  setChoicesFileForTests(join(base, `choices-${++counter}.json`));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  cleanup = [];
  calls = [];
  reached = [];
  choices = createTelegramChoices({ api: fakeApi, owner: OWNER, log: () => {} });
  composer = new Composer<Context>();
  // Wie in src/bot.ts: Besitzerprüfung
  composer.use(async (ctx, next) => {
    if (String(ctx.from?.id || "") !== OWNER) return;
    await next();
  });
  // Stellvertreter für legacyToolApprovalMiddleware (eigenes Präfix, sonst next)
  composer.on("callback_query:data", async (ctx, next) => {
    if (!/^toolapproval:/.test(ctx.callbackQuery.data)) return next();
    reached.push({ handler: "toolapproval", data: ctx.callbackQuery.data });
  });
  cleanup.push(installTelegramChoices(composer, choices));
  // Allgemeiner Handler (handleCallbackQuery)
  composer.on("callback_query:data", ctx => {
    reached.push({ handler: "general", data: ctx.callbackQuery.data });
  });
});
afterEach(() => {
  logSpy.mockRestore();
  for (const off of cleanup) off();
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

const input = (over: Partial<CreateChoiceInput> = {}): CreateChoiceInput => ({
  kind: "tool",
  conversation: { type: "telegram", chatId: CHAT },
  text: "Tool-Freigabe: notion_write",
  options: [{ key: "y", label: "Erlauben" }, { key: "n", label: "Ablehnen" }],
  ...over,
});

/** Frage anlegen und wie nach sendChoice mit Nachricht messageId merken */
async function sentChoice(over: Partial<CreateChoiceInput> = {}, messageId = 100): Promise<Choice> {
  const c = await createChoice(input(over));
  await attachChoiceTelegram(c.id, [{ chatId: CHAT, messageId }]);
  return c;
}

async function click(data: string, options: { from?: string; messageId?: number; chatId?: string } = {}) {
  const update = {
    update_id: 1,
    callback_query: {
      id: "q1",
      from: { id: Number(options.from ?? OWNER), is_bot: false, first_name: "E" },
      chat_instance: "ci",
      data,
      message: { message_id: options.messageId ?? 100, date: 0, chat: { id: Number(options.chatId ?? CHAT), type: "private", first_name: "E" } },
    },
  };
  const ctx = new Context(update as any, fakeApi as any, { id: 1, is_bot: true, first_name: "Bot", username: "bot" } as any);
  await composer.middleware()(ctx, async () => {});
}

const answers = () => calls.filter(c => c.method === "answerCallbackQuery").map(c => (c.args[1] as { text?: string } | undefined)?.text);
const edits = (method: string) => calls.filter(c => c.method === method);

describe("ch|-Knopf entscheidet", () => {
  test("Klick: Handler der Art einmal, Nachricht mit Ergebniszeile, Knöpfe weg", async () => {
    const handled: Choice[] = [];
    cleanup.push(onChoiceDecided("tool", c => { handled.push(c); }));
    const c = await sentChoice();
    await click(`ch|${c.id}|y`);
    expect(handled).toHaveLength(1);
    expect(handled[0].result).toMatchObject({ key: "y", label: "Erlauben", via: "telegram" });
    expect(edits("editMessageText")).toEqual([{
      method: "editMessageText",
      args: [CHAT, 100, "Tool-Freigabe: notion_write\n\n✓ Erlauben (in Telegram)", { link_preview_options: { is_disabled: true } }],
    }]);
    expect(edits("editMessageReplyMarkup")).toHaveLength(0);
    expect(answers()).toEqual(["✓ Erlauben"]);
    expect(reached).toEqual([]);
  });

  test("zwei Klicks: Handler genau einmal, zweiter meldet schon erledigt, kein zweites Bearbeiten", async () => {
    let runs = 0;
    cleanup.push(onChoiceDecided("tool", () => { runs++; }));
    const c = await sentChoice();
    await click(`ch|${c.id}|y`);
    await click(`ch|${c.id}|n`);
    expect(runs).toBe(1);
    expect(answers()).toEqual(["✓ Erlauben", "Schon erledigt: Erlauben in Telegram"]);
    expect(edits("editMessageText")).toHaveLength(1);
    expect(edits("editMessageReplyMarkup")).toHaveLength(0);
  });

  test("zwei gleichzeitige Klicks: Handler genau einmal", async () => {
    let runs = 0;
    cleanup.push(onChoiceDecided("tool", () => { runs++; }));
    const c = await sentChoice();
    await Promise.all([click(`ch|${c.id}|y`), click(`ch|${c.id}|y`)]);
    expect(runs).toBe(1);
    expect(edits("editMessageText")).toHaveLength(1);
  });

  test("Telegram und Browser gleichzeitig: genau ein Gewinner, genau ein Bearbeiten", async () => {
    let runs = 0;
    cleanup.push(onChoiceDecided("tool", () => { runs++; }));
    const c = await sentChoice();
    await Promise.all([click(`ch|${c.id}|y`), decideChoice(c.id, "n", "web")]);
    expect(runs).toBe(1);
    expect(edits("editMessageText")).toHaveLength(1);
    const stored = await getChoice(c.id);
    const via = stored?.result?.via === "web" ? "im Browser" : "in Telegram";
    expect(String(edits("editMessageText")[0].args[2])).toEndWith(`(${via})`);
  });
});

describe("lange Beschriftungen", () => {
  const long = "Erlauben und danach ausführlich protokollieren ".repeat(80);

  test("Klick: Antwort höchstens 200 Zeichen, Nachricht höchstens 4096 mit Kanalhinweis", async () => {
    const c = await sentChoice({ text: "T".repeat(4090), options: [{ key: "y", label: long }, { key: "n", label: "Ablehnen" }] });
    await click(`ch|${c.id}|y`);
    const [answer] = answers();
    expect(answer!.length).toBeLessThanOrEqual(200);
    expect(answer).toStartWith("✓ Erlauben");
    expect(answer).toEndWith("…");
    const [edit] = edits("editMessageText");
    expect(String(edit.args[2]).length).toBeLessThanOrEqual(4096);
    expect(String(edit.args[2])).toEndWith("… (in Telegram)");
  });

  test("schon erledigt: Antwort höchstens 200 Zeichen, Kanalhinweis bleibt", async () => {
    const c = await sentChoice({ options: [{ key: "y", label: long }, { key: "n", label: "Ablehnen" }] });
    await decideChoice(c.id, "y", "terminal");
    await click(`ch|${c.id}|n`);
    const [answer] = answers();
    expect(answer!.length).toBeLessThanOrEqual(200);
    expect(answer).toStartWith("Schon erledigt: Erlauben");
    expect(answer).toEndWith("… im Terminal");
  });
});

describe("andere Ausgänge", () => {
  test("im Browser entschieden, danach Klick: schon erledigt im Browser, Knöpfe waren schon weg", async () => {
    const c = await sentChoice();
    await decideChoice(c.id, "y", "web");
    expect(edits("editMessageText")).toHaveLength(1);
    await click(`ch|${c.id}|n`);
    expect(answers()).toEqual(["Schon erledigt: Erlauben im Browser"]);
    expect(edits("editMessageText")).toHaveLength(1);
    expect(edits("editMessageReplyMarkup")).toHaveLength(0);
  });

  test("in einem anderen Prozess entschieden (kein Ereignis hier): Klick entfernt die Knöpfe", async () => {
    const c = await sentChoice();
    for (const off of cleanup) off();
    cleanup = [];
    await decideChoice(c.id, "y", "terminal");
    await click(`ch|${c.id}|y`);
    expect(answers()).toEqual(["Schon erledigt: Erlauben im Terminal"]);
    expect(edits("editMessageReplyMarkup")).toEqual([{
      method: "editMessageReplyMarkup",
      args: [CHAT, 100, { reply_markup: { inline_keyboard: [] } }],
    }]);
  });

  test("Frist überschritten: Klick meldet abgelaufen, Handler läuft nicht, Nachricht einmal nachgezogen", async () => {
    let runs = 0;
    cleanup.push(onChoiceDecided("tool", () => { runs++; }));
    const c = await sentChoice({ expiresAt: Date.now() + 20 });
    await new Promise(r => setTimeout(r, 30));
    await click(`ch|${c.id}|y`);
    expect(runs).toBe(0);
    expect(answers()).toEqual(["Abgelaufen"]);
    expect(edits("editMessageText").map(e => e.args[2])).toEqual(["Tool-Freigabe: notion_write\n\nAbgelaufen, nichts geändert"]);
    expect(edits("editMessageReplyMarkup")).toHaveLength(0);
  });

  test("schon gespeichert abgelaufen, in anderem Prozess: Klick entfernt die Knöpfe", async () => {
    const c = await sentChoice();
    for (const off of cleanup) off();
    cleanup = [];
    await expireChoice(c.id);
    await click(`ch|${c.id}|y`);
    expect(answers()).toEqual(["Abgelaufen"]);
    expect(edits("editMessageText")).toHaveLength(0);
    expect(edits("editMessageReplyMarkup")).toHaveLength(1);
  });

  test("unbekannte Frage: abgelaufen, Knöpfe weg", async () => {
    await click("ch|Unbekannt12|y");
    expect(answers()).toEqual(["Abgelaufen"]);
    expect(edits("editMessageReplyMarkup")).toHaveLength(1);
    expect(reached).toEqual([]);
  });

  test("unbekannter Schlüssel: Frage bleibt offen, Knöpfe bleiben", async () => {
    const c = await sentChoice();
    await click(`ch|${c.id}|zz`);
    expect(answers()).toEqual(["Diese Auswahl gibt es nicht"]);
    expect(edits("editMessageText")).toHaveLength(0);
    expect(edits("editMessageReplyMarkup")).toHaveLength(0);
    expect((await getChoice(c.id))?.state).toBe("open");
  });

  test("fehlerhafte ch|-Daten: ungültig, nichts bearbeitet, nichts weitergereicht", async () => {
    const c = await sentChoice();
    for (const data of ["ch|", "ch|a b|y", `ch|${c.id}`, `ch|${c.id}|y|x`, `ch|${c.id}|${"k".repeat(33)}`, "ch||y"]) {
      await click(data);
    }
    expect(answers()).toEqual(Array(6).fill("Ungültiger Knopf"));
    expect(edits("editMessageText")).toHaveLength(0);
    expect(edits("editMessageReplyMarkup")).toHaveLength(0);
    expect(reached).toEqual([]);
    expect((await getChoice(c.id))?.state).toBe("open");
  });

  test("Knopf an einer fremden Nachricht: nicht entschieden, nichts bearbeitet", async () => {
    let runs = 0;
    cleanup.push(onChoiceDecided("tool", () => { runs++; }));
    const c = await sentChoice();
    await click(`ch|${c.id}|y`, { messageId: 101 });
    await click(`ch|${c.id}|y`, { chatId: "-100999" });
    expect(runs).toBe(0);
    expect(answers()).toEqual(["Dieser Knopf gehört nicht zu dieser Frage", "Dieser Knopf gehört nicht zu dieser Frage"]);
    expect(edits("editMessageText")).toHaveLength(0);
    expect((await getChoice(c.id))?.state).toBe("open");
  });

  test("Frage ohne gemerkte Nachricht: nicht entscheidbar über Telegram", async () => {
    const c = await createChoice(input());
    await click(`ch|${c.id}|y`);
    expect(answers()).toEqual(["Noch nicht bereit, bitte gleich nochmal tippen"]);
    expect(edits("editMessageReplyMarkup")).toHaveLength(0);
    expect((await getChoice(c.id))?.state).toBe("open");
  });

  test("fremder Absender kommt nicht durch (Kette und Middleware allein)", async () => {
    let runs = 0;
    cleanup.push(onChoiceDecided("tool", () => { runs++; }));
    const c = await sentChoice();
    await click(`ch|${c.id}|y`, { from: STRANGER });
    // Middleware ohne vorgeschaltete Besitzerprüfung
    const alone = new Composer<Context>();
    alone.on("callback_query:data", choices.middleware);
    const update = {
      update_id: 2,
      callback_query: {
        id: "q2", from: { id: Number(STRANGER), is_bot: false, first_name: "X" }, chat_instance: "ci", data: `ch|${c.id}|y`,
        message: { message_id: 100, date: 0, chat: { id: Number(CHAT), type: "private", first_name: "E" } },
      },
    };
    let passed = false;
    await alone.middleware()(new Context(update as any, fakeApi as any, {} as any), async () => { passed = true; });
    expect(passed).toBe(false);
    expect(runs).toBe(0);
    expect(calls).toEqual([]);
    expect((await getChoice(c.id))?.state).toBe("open");
  });

  test("Bearbeitungsfehler wird geloggt, nicht geworfen; die Entscheidung gilt", async () => {
    const logs: string[] = [];
    const failing = { ...fakeApi, editMessageText: async () => { throw new Error("message to edit not found"); } };
    for (const off of cleanup) off();
    cleanup = [];
    const own = createTelegramChoices({ api: failing, owner: OWNER, log: l => logs.push(l) });
    composer = new Composer<Context>();
    cleanup.push(installTelegramChoices(composer, own));
    const c = await sentChoice();
    await click(`ch|${c.id}|y`);
    expect((await getChoice(c.id))?.state).toBe("done");
    expect(logs.some(l => l.includes("nicht nachgezogen") && l.includes(c.id))).toBe(true);
    expect(logs.join("\n")).not.toContain("notion_write");
  });
});

describe("bestehende Präfixe unverändert", () => {
  test("gehen an ihren bisherigen Handler, ohne Antwort oder Bearbeitung durch die Rückfragen", async () => {
    const legacy = [
      "topicmap:5:research", "call_yes", "call_no", "snooze", "dismiss",
      "goalkb|more|123:4", "rev|ok|abc", "rev|no|abc", "rev|routine|abc", "atask:yes:abc",
      "ch", "chx|a|b", "CH|a|b",
    ];
    for (const data of legacy) await click(data);
    await click("toolapproval:y:0f0e0d0c-0b0a-0908-0706-050403020100");
    expect(reached).toEqual([
      ...legacy.map(data => ({ handler: "general", data })),
      { handler: "toolapproval", data: "toolapproval:y:0f0e0d0c-0b0a-0908-0706-050403020100" },
    ]);
    expect(calls).toEqual([]);
  });

  test("src/bot.ts: Rückfragen nach Besitzerprüfung und alten Freigabe-Knöpfen, vor dem allgemeinen Handler", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "bot.ts"), "utf8");
    const owner = source.indexOf("if (userId !== ALLOWED_USER_ID)");
    const tool = source.indexOf('bot.on("callback_query:data", legacyToolApprovalMiddleware(ALLOWED_USER_ID));');
    const ours = source.indexOf("installTelegramChoices(bot, telegramChoices);");
    const general = source.indexOf('bot.on("callback_query:data", (ctx) =>');
    expect(owner).toBeGreaterThan(-1);
    expect(tool).toBeGreaterThan(owner);
    expect(ours).toBeGreaterThan(tool);
    expect(general).toBeGreaterThan(ours);
    expect(source).toContain("createTelegramChoices({ api: bot.api, owner: ALLOWED_USER_ID })");
  });
});
