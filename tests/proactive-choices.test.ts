/**
 * Knöpfe unter proaktiven Meldungen (Issue #362): Art "proactive" im
 * Rückfragen-Register. Echtes Register und echter Kern-Zustand in
 * Temp-Dateien, Uhr, Versand und Anruf als Attrappen, Telegram-Klicks über
 * die echte Callback-Middleware mit einer Api-Attrappe. src/bot.ts wird
 * weder gestartet noch importiert.
 *
 * Geprüft: Versand mit choiceId und Knöpfen (genau einmal, auch ohne
 * Telegram), Klick bis zum nächsten Versand (30 Minuten Ruhe, danach nur bei
 * erfüllten übrigen Regeln), Erledigt, Anrufen mit success false,
 * gescheiterter Snooze-Schreibzugriff, einmal entscheiden über Kanäle,
 * Nachziehen der Telegram-Knöpfe und die alten Knöpfe snooze, dismiss,
 * call_yes und call_no.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Composer, Context } from "grammy";
import {
  attachChoiceTelegram,
  decideChoice,
  expireChoice,
  getChoice,
  listChoices,
  onChoiceChange,
  onChoiceDecided,
  setChoicesFileForTests,
  type Choice,
  type ChoiceConversation,
  type ChoiceTelegramRef,
} from "../src/lib/choices";
import type { SendAndRecordInput } from "../src/lib/outbox";
import {
  botApiEditor,
  createProactiveChoices,
  openProactiveChoice,
  PROACTIVE_CHOICE_TEXT,
  proactiveOptions,
  type CallResult,
  type ProactiveChoicesDeps,
} from "../src/lib/proactive/choices";
import { runProactive, type ProactiveChoiceRegister, type ProactiveDeps } from "../src/lib/proactive/deliver";
import { readProactiveState, snoozeKind } from "../src/lib/proactive/state";
import { createTelegramChoices, installTelegramChoices, refreshChoiceMessages } from "../src/lib/telegram-choices";

const USER = "4711";
const ENV = { USER_TIMEZONE: "Europe/Berlin", TELEGRAM_BOT_TOKEN: "123:abc", TELEGRAM_USER_ID: USER };
// 12:00 UTC = 14:00 in Berlin: im Zeitfenster des Check-ins, außerhalb der Ruhezeit
const NOON = Date.parse("2026-10-19T12:00:00.000Z");
const MIN = 60_000;

const base = mkdtempSync(join(tmpdir(), "tybo-proactive-choices-"));
let counter = 0;
let dir = "";
let statePath = "";
let clock = NOON;
let cleanup: (() => void)[] = [];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = join(base, `case-${++counter}`);
  statePath = join(dir, "data", "proactive-state.json");
  setChoicesFileForTests(join(dir, "data", "choices.json"));
  clock = NOON;
  cleanup = [];
  refreshed.length = 0;
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  for (const off of cleanup.splice(0)) off();
  logSpy.mockRestore();
  errSpy.mockRestore();
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(base, { recursive: true, force: true });
});

/** Echtes Register wie defaultChoices in deliver.ts, Anrufe eingerichtet; Nachziehen per Standard nur gezählt */
const refreshed: { choice: Choice; refs: ChoiceTelegramRef[] }[] = [];
const registerFor = (env: Record<string, string>, refresh?: ProactiveChoiceRegister["refresh"]): ProactiveChoiceRegister => ({
  create: (kind, text) => openProactiveChoice(kind, text, { env, callAvailable: true }),
  attach: attachChoiceTelegram,
  expire: expireChoice,
  refresh: refresh ?? (async (choice, refs) => { refreshed.push({ choice, refs }); }),
});
const register = registerFor(ENV);

let nextMessageId = 500;
/** Versand-Attrappe wie die Outbox: mit Telegram eine angenommene Nachricht mit Knöpfen */
function outbox(mode: "telegram" | "web" | "fail" = "telegram") {
  const sent: SendAndRecordInput[] = [];
  const send = async (input: SendAndRecordInput) => {
    sent.push(input);
    if (mode === "fail") return { sent: false, recorded: false, error: { kind: "send" as const, message: "weg", rejected: true as const } };
    if (mode === "web") return { sent: false, recorded: true };
    return { sent: true, recorded: true, messages: [{ chatId: USER, messageId: ++nextMessageId, part: "text" as const, buttons: true }] };
  };
  return { sent, send };
}

function deliverDeps(extra: Partial<ProactiveDeps> = {}): ProactiveDeps {
  return { now: () => new Date(clock), env: ENV, settings: {}, statePath, legacy: null, renewMs: 0, choices: register, ...extra };
}

interface Said { conversation: ChoiceConversation; text: string; kind: string }

function install(extra: Partial<ProactiveChoicesDeps> = {}) {
  const said: Said[] = [];
  const calls: string[] = [];
  const snoozes: { kind: string; until: string }[] = [];
  const choices = createProactiveChoices({
    statePath,
    env: ENV,
    now: () => new Date(clock),
    notify: async (conversation, text, kind) => { said.push({ conversation, text, kind }); },
    call: async context => { calls.push(context); return { success: true, message: "ok" }; },
    snooze: async (path, kind, until) => { snoozes.push({ kind, until: until.toISOString() }); await snoozeKind(path, kind, until); },
    log: () => {},
    ...extra,
  });
  cleanup.push(onChoiceDecided("proactive", choices.handler));
  return { choices, said, calls, snoozes };
}

/** Meldung mit Knöpfen über runProactive; gibt die angelegte Rückfrage zurück */
async function sendCheckin(mode: "telegram" | "web" | "fail" = "telegram", extra: Partial<ProactiveDeps> = {}) {
  const box = outbox(mode);
  const outcome = await runProactive("checkin", async () => ({ text: "Wie läuft es mit dem Bericht?", ask: true }), deliverDeps({ send: box.send, ...extra }));
  const all = await listChoices();
  return { outcome, box, choice: all.find(c => c.id === box.sent[0]?.choiceId) };
}

describe("Art proactive", () => {
  test("Optionen: Erledigt, 30 Minuten später, Anrufen; ohne Anrufe nur die ersten beiden", () => {
    expect(proactiveOptions(true)).toEqual([
      { key: "done", label: "Erledigt" },
      { key: "snooze", label: "30 Minuten später" },
      { key: "call", label: "Anrufen" },
    ]);
    expect(proactiveOptions(false).map(o => o.key)).toEqual(["done", "snooze"]);
  });

  test("Frage im Direktchat, ohne Telegram im Web-Direktchat; ref ist die Art", async () => {
    const tg = await openProactiveChoice("briefing", "Guten Morgen", { env: ENV });
    expect(tg).toMatchObject({ kind: "proactive", ref: "briefing", state: "open", conversation: { type: "telegram", chatId: USER } });
    const web = await openProactiveChoice("checkin", "Hallo", { env: { USER_TIMEZONE: "UTC" } });
    expect(web.conversation).toEqual({ type: "telegram", chatId: "web" });
  });
});

describe("Versand mit Knöpfen", () => {
  test("genau ein Versand mit choiceId und ch|-Knöpfen, Telegram-Nachricht an der Rückfrage gemerkt", async () => {
    const { outcome, box, choice } = await sendCheckin();
    expect(outcome).toEqual({ status: "sent" });
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0]).toMatchObject({ source: "checkin", text: "Wie läuft es mit dem Bericht?" });
    expect(choice).toBeDefined();
    expect(box.sent[0].buttons).toEqual([[
      { text: "Erledigt", callback_data: `ch|${choice!.id}|done` },
      { text: "30 Minuten später", callback_data: `ch|${choice!.id}|snooze` },
      { text: "Anrufen", callback_data: `ch|${choice!.id}|call` },
    ]]);
    expect(choice).toMatchObject({ state: "open", ref: "checkin", text: "Wie läuft es mit dem Bericht?", telegram: [{ chatId: USER, messageId: nextMessageId }] });
    expect(await listChoices()).toHaveLength(1);
    // Offen beim Merken: nichts nachzuziehen
    expect(refreshed).toEqual([]);
  });

  test("ohne Telegram: festgehalten mit choiceId, Rückfrage offen ohne Telegram-Bezug", async () => {
    const { outcome, box, choice } = await sendCheckin("web", { env: { USER_TIMEZONE: "Europe/Berlin" }, choices: registerFor({ USER_TIMEZONE: "Europe/Berlin" }) });
    expect(outcome).toEqual({ status: "sent" });
    expect(box.sent).toHaveLength(1);
    expect(choice).toMatchObject({ state: "open", conversation: { type: "telegram", chatId: "web" } });
    expect(choice!.telegram).toBeUndefined();
  });

  test("nicht zugestellt: Rückfrage läuft ab, keine Versandzeit", async () => {
    const { outcome, box } = await sendCheckin("fail");
    expect(outcome).toEqual({ status: "failed", reason: "undelivered" });
    expect((await getChoice(box.sent[0].choiceId!))?.state).toBe("expired");
    expect((await readProactiveState(statePath)).checkin.lastSentAt).toBeUndefined();
  });

  test("Register nicht nutzbar: Meldung geht ohne Knöpfe und ohne choiceId raus", async () => {
    const box = outbox();
    const broken: ProactiveChoiceRegister = { ...register, create: async () => { throw new Error("Platte voll"); } };
    const outcome = await runProactive("checkin", async () => ({ text: "Hallo", ask: true }), deliverDeps({ send: box.send, choices: broken }));
    expect(outcome).toEqual({ status: "sent" });
    expect(box.sent).toHaveLength(1);
    expect(box.sent[0].choiceId).toBeUndefined();
    expect(box.sent[0].buttons).toBeUndefined();
  });

  test("ohne ask: keine Rückfrage, Knöpfe der Meldung unverändert", async () => {
    const box = outbox();
    const buttons = [[{ text: "A", callback_data: "a" }]];
    await runProactive("checkin", async () => ({ text: "Hallo", buttons }), deliverDeps({ send: box.send }));
    expect(box.sent[0].buttons).toEqual(buttons);
    expect(box.sent[0].choiceId).toBeUndefined();
    expect(await listChoices()).toEqual([]);
  });
});

describe("Vom Klick bis zum nächsten Versand", () => {
  test("Snooze: Zustand neu geladen, vor Klick + 30 Minuten kein Versand, danach nach den übrigen Regeln", async () => {
    const { said, snoozes } = install();
    const { choice } = await sendCheckin();
    clock = NOON + 5 * MIN;
    const outcome = await decideChoice(choice!.id, "snooze", "telegram");
    expect(outcome.status).toBe("decided");
    expect(snoozes).toEqual([{ kind: "checkin", until: new Date(NOON + 35 * MIN).toISOString() }]);
    // 12:35 UTC = 14:35 in Berlin
    expect(said).toEqual([{ conversation: { type: "telegram", chatId: USER }, text: PROACTIVE_CHOICE_TEXT.snoozed("14:35"), kind: "checkin" }]);
    expect((await readProactiveState(statePath)).checkin.snoozedUntil).toBe(new Date(NOON + 35 * MIN).toISOString());

    // Ohne Mindestabstand, damit nur der Snooze sperrt
    const free = { settings: { proactive: { checkin: { minGapMinutes: 0 } } } };
    const box = outbox();
    clock = NOON + 35 * MIN - 1;
    expect(await runProactive("checkin", async () => ({ text: "Noch einmal" }), deliverDeps({ send: box.send, ...free }))).toEqual({ status: "skipped", reason: "snoozed" });
    clock = NOON + 35 * MIN;
    expect(await runProactive("checkin", async () => ({ text: "Noch einmal" }), deliverDeps({ send: box.send, ...free }))).toEqual({ status: "sent" });
    expect(box.sent).toHaveLength(1);
  });

  test("Snooze vorbei, Mindestabstand sperrt länger: weiter kein Versand (gap)", async () => {
    install();
    const { choice } = await sendCheckin();
    clock = NOON + 5 * MIN;
    await decideChoice(choice!.id, "snooze", "web");
    const box = outbox();
    clock = NOON + 35 * MIN;
    // Standard 90 Minuten seit dem Versand um 12:00 UTC
    expect(await runProactive("checkin", async () => ({ text: "x" }), deliverDeps({ send: box.send }))).toEqual({ status: "skipped", reason: "gap" });
    clock = NOON + 90 * MIN;
    expect(await runProactive("checkin", async () => ({ text: "x" }), deliverDeps({ send: box.send }))).toEqual({ status: "sent" });
  });

  test("Snooze gilt je Art: das Briefing bleibt frei", async () => {
    install();
    const { choice } = await sendCheckin();
    await decideChoice(choice!.id, "snooze", "telegram");
    const state = await readProactiveState(statePath);
    expect(state.checkin.snoozedUntil).toBeDefined();
    expect(state.briefing.snoozedUntil).toBeUndefined();
  });

  test("Snooze-Schreibzugriff scheitert: Frage bleibt entschieden, handlerError, Antwort ohne vorgetäuschte Ruhe", async () => {
    const { said } = install({ snooze: async () => { throw new Error("Platte voll"); } });
    const { choice } = await sendCheckin();
    const outcome = await decideChoice(choice!.id, "snooze", "telegram");
    expect(outcome.status).toBe("decided");
    if (outcome.status !== "decided") return;
    expect(outcome.choice.state).toBe("done");
    expect(outcome.choice.handlerError?.message).toBe("Platte voll");
    expect(said.map(s => s.text)).toEqual([PROACTIVE_CHOICE_TEXT.snoozeFailed]);
    expect((await readProactiveState(statePath)).checkin.snoozedUntil).toBeUndefined();
  });
});

describe("Erledigt und Anrufen", () => {
  test("Erledigt: Antwort, kein Snooze, kein Anruf", async () => {
    const { said, calls, snoozes } = install();
    const { choice } = await sendCheckin();
    await decideChoice(choice!.id, "done", "web");
    expect(said.map(s => s.text)).toEqual([PROACTIVE_CHOICE_TEXT.done]);
    expect(calls).toEqual([]);
    expect(snoozes).toEqual([]);
    expect((await readProactiveState(statePath)).checkin.snoozedUntil).toBeUndefined();
  });

  test("Anrufen: Anruf mit dem Text der Meldung als Anlass", async () => {
    const { said, calls } = install();
    const { choice } = await sendCheckin();
    await decideChoice(choice!.id, "call", "telegram");
    expect(calls).toEqual(["Wie läuft es mit dem Bericht?"]);
    expect(said.map(s => s.text)).toEqual([PROACTIVE_CHOICE_TEXT.calling]);
  });

  test("Anruf mit success false: sichtbare Antwort und handlerError", async () => {
    const { said } = install({ call: async (): Promise<CallResult> => ({ success: false, message: "Telefonnummer fehlt" }) });
    const { choice } = await sendCheckin();
    const outcome = await decideChoice(choice!.id, "call", "telegram");
    expect(said.map(s => s.text)).toEqual([PROACTIVE_CHOICE_TEXT.callFailed("Telefonnummer fehlt")]);
    expect(outcome.status === "decided" && outcome.choice.handlerError?.message).toBe("Anruf gescheitert");
  });

  test("ohne Anrufweg: Hinweis und handlerError", async () => {
    const { said } = install({ call: undefined });
    const { choice } = await sendCheckin();
    await decideChoice(choice!.id, "call", "telegram");
    expect(said.map(s => s.text)).toEqual([PROACTIVE_CHOICE_TEXT.callUnavailable]);
    expect((await getChoice(choice!.id))?.handlerError).toBeDefined();
  });
});

describe("Telegram: Klick, einmal entscheiden, Nachziehen", () => {
  const edits: { chatId: string; messageId: number; text: string }[] = [];
  const answers: (string | undefined)[] = [];
  const api = {
    answerCallbackQuery: async (_id: string, other?: { text?: string }) => { answers.push(other?.text); return true; },
    editMessageText: async (chatId: string, messageId: number, text: string) => { edits.push({ chatId: String(chatId), messageId, text }); return true; },
    editMessageReplyMarkup: async () => true,
  };

  function telegram() {
    edits.length = 0;
    answers.length = 0;
    const tc = createTelegramChoices({ api, owner: USER, log: () => {} });
    const composer = new Composer<Context>();
    cleanup.push(installTelegramChoices(composer, tc));
    return async (data: string, messageId: number, chatId = USER) => {
      const update = {
        update_id: 1,
        callback_query: {
          id: "q1",
          from: { id: Number(USER), is_bot: false, first_name: "A" },
          chat_instance: "ci",
          data,
          message: { message_id: messageId, date: 0, chat: { id: Number(chatId), type: "private", first_name: "A" } },
        },
      };
      const ctx = new Context(update as any, api as any, { id: 1, is_bot: true, first_name: "Bot", username: "bot" } as any);
      await composer.middleware()(ctx, async () => {});
    };
  }

  test("Klick in Telegram schreibt den Snooze, die Nachricht verliert die Knöpfe; zweiter Klick und Browser ändern nichts", async () => {
    const { snoozes } = install();
    const click = telegram();
    const { choice } = await sendCheckin();
    const messageId = choice!.telegram![0].messageId;
    await click(`ch|${choice!.id}|snooze`, messageId);
    expect(snoozes).toHaveLength(1);
    expect(edits).toEqual([{ chatId: USER, messageId, text: "Wie läuft es mit dem Bericht?\n\n✓ 30 Minuten später (in Telegram)" }]);
    await click(`ch|${choice!.id}|done`, messageId);
    expect((await decideChoice(choice!.id, "call", "web")).status).toBe("already");
    expect(snoozes).toHaveLength(1);
    expect((await getChoice(choice!.id))?.result).toMatchObject({ key: "snooze", via: "telegram" });
  });

  test("im Browser entschieden: Telegram-Nachricht wird live nachgezogen", async () => {
    install();
    telegram();
    const { choice } = await sendCheckin();
    await decideChoice(choice!.id, "done", "web");
    expect(edits).toEqual([{ chatId: USER, messageId: choice!.telegram![0].messageId, text: "Wie läuft es mit dem Bericht?\n\n✓ Erledigt (im Browser)" }]);
  });

  test("im Browser entschieden, während der Versand noch läuft: Routine zieht die Knöpfe nach, genau eine Ausführung", async () => {
    const { snoozes, said } = install();
    const click = telegram();
    // Bot-API der Routine als fetch-Attrappe (echter botApiEditor und refreshChoiceMessages)
    const requests: { url: string; body: any }[] = [];
    const editor = botApiEditor(ENV.TELEGRAM_BOT_TOKEN, async (url, init) => {
      requests.push({ url, body: JSON.parse(String(init.body)) });
      return Response.json({ ok: true, result: true });
    });
    const choices = registerFor(ENV, (choice, refs) => refreshChoiceMessages(choice, editor, () => {}, refs));

    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started!: (id: string) => void;
    const sending = new Promise<string>(resolve => { started = resolve; });
    const messageId = 4242;
    const send = async (input: SendAndRecordInput) => {
      started(input.choiceId!);
      await gate;
      return { sent: true, recorded: true, messages: [{ chatId: USER, messageId, part: "text" as const, buttons: true }] };
    };
    const run = runProactive("checkin", async () => ({ text: "Wie läuft es mit dem Bericht?", ask: true }), deliverDeps({ send, choices }));

    const id = await sending;
    clock = NOON + 2 * MIN;
    expect((await decideChoice(id, "snooze", "web")).status).toBe("decided");
    // Der Bot hatte beim Entscheiden noch keine Telegram-Nachricht zum Nachziehen
    expect(edits).toEqual([]);
    expect(requests).toEqual([]);

    release();
    expect(await run).toEqual({ status: "sent" });
    expect(requests).toEqual([{
      url: `https://api.telegram.org/bot${ENV.TELEGRAM_BOT_TOKEN}/editMessageText`,
      body: { chat_id: USER, message_id: messageId, text: "Wie läuft es mit dem Bericht?\n\n✓ 30 Minuten später (im Browser)", link_preview_options: { is_disabled: true } },
    }]);
    // Ohne reply_markup: die Knöpfe sind weg
    expect(requests[0].body.reply_markup).toBeUndefined();
    expect((await getChoice(id))?.telegram).toEqual([{ chatId: USER, messageId }]);

    // Ein später Klick auf die (alte) Nachricht führt nichts mehr aus
    await click(`ch|${id}|done`, messageId);
    expect(snoozes).toEqual([{ kind: "checkin", until: new Date(NOON + 32 * MIN).toISOString() }]);
    expect(said.map(s => s.text)).toEqual([PROACTIVE_CHOICE_TEXT.snoozed("14:32")]);
    expect((await getChoice(id))?.result).toMatchObject({ key: "snooze", via: "web" });
    expect((await readProactiveState(statePath)).checkin.snoozedUntil).toBe(new Date(NOON + 32 * MIN).toISOString());
  });

  test("Bot-API lehnt das Nachziehen ab: Versand bleibt sent, kein Wurf", async () => {
    install();
    const editor = botApiEditor(ENV.TELEGRAM_BOT_TOKEN, async () => Response.json({ ok: false, description: "Bad Request" }, { status: 400 }));
    const choices = registerFor(ENV, (choice, refs) => refreshChoiceMessages(choice, editor, () => {}, refs));
    let id = "";
    const send = async (input: SendAndRecordInput) => {
      id = input.choiceId!;
      await decideChoice(id, "done", "web");
      return { sent: true, recorded: true, messages: [{ chatId: USER, messageId: 77, part: "text" as const, buttons: true }] };
    };
    expect(await runProactive("checkin", async () => ({ text: "Hallo", ask: true }), deliverDeps({ send, choices }))).toEqual({ status: "sent" });
    expect((await getChoice(id))?.state).toBe("done");
  });

  test("Knopf an einer fremden Nachricht entscheidet nicht", async () => {
    const { snoozes } = install();
    const click = telegram();
    const { choice } = await sendCheckin();
    await click(`ch|${choice!.id}|snooze`, 9999);
    expect(snoozes).toEqual([]);
    expect((await getChoice(choice!.id))?.state).toBe("open");
  });
});

describe("alte Knöpfe", () => {
  const message = (messageId: number, text = "Kurze Frage about:\n\nBericht fertig?") => ({ chatId: USER, messageId, text });

  test("snooze schreibt den Snooze des Check-ins, je Nachricht genau einmal", async () => {
    const { choices, snoozes } = install();
    clock = NOON + 10 * MIN;
    expect(await choices.legacyCallback("snooze", message(41))).toBe(PROACTIVE_CHOICE_TEXT.snoozed("14:40"));
    expect((await readProactiveState(statePath)).checkin.snoozedUntil).toBe(new Date(NOON + 40 * MIN).toISOString());
    expect(await choices.legacyCallback("snooze", message(41))).toBe(PROACTIVE_CHOICE_TEXT.already);
    expect(snoozes).toHaveLength(1);
    // Andere Nachricht: eigener Klick
    expect(await choices.legacyCallback("dismiss", message(42))).toBe(PROACTIVE_CHOICE_TEXT.done);
  });

  test("dismiss und call_no: erledigt ohne Wirkung auf den Zustand", async () => {
    const { choices, calls, snoozes } = install();
    expect(await choices.legacyCallback("dismiss", message(50))).toBe(PROACTIVE_CHOICE_TEXT.done);
    expect(await choices.legacyCallback("call_no", message(51))).toBe(PROACTIVE_CHOICE_TEXT.done);
    expect(calls).toEqual([]);
    expect(snoozes).toEqual([]);
  });

  test("call_yes: Anruf mit dem Text nach „about:“, einmal; Fehlschlag sichtbar", async () => {
    const { choices, calls } = install();
    expect(await choices.legacyCallback("call_yes", message(60))).toBe(PROACTIVE_CHOICE_TEXT.calling);
    expect(await choices.legacyCallback("call_yes", message(60))).toBe(PROACTIVE_CHOICE_TEXT.already);
    expect(calls).toEqual(["Bericht fertig?"]);
    cleanup.splice(0).forEach(off => off());
    const failing = install({ call: async () => ({ success: false, message: "Kein Agent" }) });
    expect(await failing.choices.legacyCallback("call_yes", message(61))).toBe(PROACTIVE_CHOICE_TEXT.callFailed("Kein Agent"));
  });

  test("andere Daten gehen weiter (null)", async () => {
    const { choices } = install();
    for (const data of ["topicmap:5:research", "rev|ok|abc", "ch|abc|done", "snoozed", "toString"]) {
      expect(await choices.legacyCallback(data, message(70))).toBeNull();
    }
  });
});

test("Zuhörer sehen created und decided der Art proactive", async () => {
  install();
  const seen: string[] = [];
  cleanup.push(onChoiceChange(({ type, choice }: { type: string; choice: Choice }) => { if (choice.kind === "proactive") seen.push(type); }));
  const { choice } = await sendCheckin();
  await decideChoice(choice!.id, "done", "terminal");
  expect(seen).toEqual(["created", "decided"]);
});
