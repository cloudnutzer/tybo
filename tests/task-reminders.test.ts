/**
 * Issue #337, Checkbox 2 und 3: Erinnerungen an wartende Aufträge
 * (src/lib/task-reminders.ts). Rückfragen des Registers: fällig nach
 * 2 Stunden, nie bei entschiedener, abgelaufener oder überholter Frage,
 * dieselbe choiceId ohne neuen Eintrag, Zustellung in Telegram (Topic,
 * Direktchat), reinem Web-Gespräch samt Kopie und Web-Direktchat ohne
 * Telegram, höchstens einmal auch über einen Neustart, Wiederholung nur nach
 * sicherem Zustellfehler (nicht, wenn von einer langen Erinnerung schon ein
 * Stück ankam; echte Outbox mit Fetch-Attrappe), Ruhezeit, Entscheiden über Erinnerung oder Frage
 * zieht beide Nachrichten nach. Alte Aufträge: einmal mit atask-Knöpfen,
 * deutscher Text. Echtes Register (Datei im Temp-Verzeichnis), echte Sperre,
 * echte Telegram-Seite mit Api- und Sende-Attrappe; Auftragsspeicher als
 * Attrappe. src/bot.ts wird nie geladen.
 */
import { afterAll, afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Composer, Context } from "grammy";
import { askRef, createAskOffer, parseAskRef, withTaskLock, type AskOffer } from "../src/lib/ask-choices";
import { expireChoice, getChoice, listChoices, setChoicesFileForTests, type Choice, type ChoiceConversation } from "../src/lib/choices";
import { sendAndRecord, type SendAndRecordInput, type SendAndRecordResult } from "../src/lib/outbox";
import type { WebPost } from "../src/lib/review-choices";
import type { TaskStore } from "../src/lib/store/ports";
import type { AsyncTask, TaskChanges } from "../src/lib/store/types";
import {
  createAskReminderShow,
  createTaskReminders,
  TASK_REMINDER_AFTER_MS,
  TASK_REMINDER_TEXT,
  type AskReminderShow,
  type LegacyTaskNotify,
  type ReminderDelivery,
  type TaskReminderDeps,
} from "../src/lib/task-reminders";
import { createTelegramChoices, installTelegramChoices, refreshChoiceMessages } from "../src/lib/telegram-choices";
import { testChoices, type TestChoices } from "./choices-fixture";

const OWNER = "4711";
const GROUP = "-1001234567890";
const WEB = "0b8f2a3c-1d2e-4f50-8a6b-7c8d9e0f1a2b";
const START = Date.parse("2026-10-20T08:00:00.000Z"); // 10 Uhr in Berlin
const MIN = 60_000;
const dir = mkdtempSync(join(tmpdir(), "tybo-task-reminders-"));

// ---------------------------------------------------------------------------
// Attrappen
// ---------------------------------------------------------------------------

/** Auftragsspeicher im Speicher; rows ist der dauerhafte Stand, store ein frischer Zugriff darauf */
function memoryTasks() {
  const rows = new Map<string, AsyncTask>();
  const sw = { update: (_c: TaskChanges) => true as boolean | "throw" };
  let next = 0;
  const open = () =>
    ({
      async create(chatId: string, originalPrompt: string, threadId?: number) {
        const at = new Date().toISOString();
        const task: AsyncTask = {
          id: `task-${++next}`,
          created_at: at,
          updated_at: at,
          chat_id: chatId,
          original_prompt: originalPrompt,
          status: "running",
          ...(threadId !== undefined ? { thread_id: threadId } : {}),
          metadata: {},
        };
        rows.set(task.id, task);
        return structuredClone(task);
      },
      async update(taskId: string, changes: TaskChanges) {
        const row = rows.get(taskId);
        const ok = sw.update(changes);
        if (ok === "throw") throw new Error("Speicher weg");
        if (!row || !ok) return false;
        for (const [k, v] of Object.entries(changes)) if (v !== undefined) (row as any)[k] = structuredClone(v);
        return true;
      },
      async byId(taskId: string) {
        const row = rows.get(taskId);
        return row ? structuredClone(row) : null;
      },
      // Wie Supabase stale(): wartend, ohne Erinnerung, älter als die Grenze
      async stale(olderThanMs: number) {
        return [...rows.values()]
          .filter(t => t.status === "needs_input" && !t.reminder_sent && Date.parse(t.created_at) < Date.now() - olderThanMs)
          .map(t => structuredClone(t));
      },
    }) as unknown as TaskStore;
  return { open, rows, sw };
}

let tasks: ReturnType<typeof memoryTasks>;
let port: TestChoices;
let sends: SendAndRecordInput[];
let sendResult: (input: SendAndRecordInput) => SendAndRecordResult | "throw";
let webPosts: { conversationId: string; post: WebPost }[];
let webOk: boolean;
let telegramOn: boolean;
let edits: { chatId: unknown; messageId: unknown; text: unknown }[];
let messageId = 100;
let composer: Composer<Context>;
let cleanup: (() => void)[] = [];
let n = 0;
let logSpy: ReturnType<typeof spyOn>;

const fakeApi = {
  answerCallbackQuery: async () => {},
  editMessageText: async (chatId: unknown, messageId: unknown, text: unknown) => void edits.push({ chatId, messageId, text }),
  editMessageReplyMarkup: async () => {},
};

/** Sendet wie die Outbox: mit Telegram gesendet samt message_id, ohne Telegram nur festgehalten */
async function send(input: SendAndRecordInput): Promise<SendAndRecordResult> {
  sends.push(input);
  const result = sendResult(input);
  if (result === "throw") throw new Error("Netz weg");
  return result;
}
const sentOk = (input: SendAndRecordInput): SendAndRecordResult =>
  telegramOn
    ? ({ sent: true, recorded: true, messages: [{ chatId: input.chatId ?? OWNER, messageId: ++messageId, part: "text", buttons: Boolean(input.buttons) }] } as any)
    : { sent: false, recorded: true };

/** Echter Zustellweg wie in src/bot.ts (bot-notices.ts taskReminders) */
const realShow = (): AskReminderShow =>
  createAskReminderShow({
    telegram: () => telegramOn,
    send,
    refresh: (choice, refs) => refreshChoiceMessages(choice, fakeApi, () => {}, refs),
    postWeb: async (conversationId, post) => (webPosts.push({ conversationId, post }), webOk),
    log: () => {},
  });

function reminders(patch: Partial<TaskReminderDeps> = {}) {
  return createTaskReminders({
    showAsk: realShow(),
    notifyLegacy: async () => true,
    directChatIds: () => [OWNER, "web"],
    tasks: () => tasks.open(),
    isQuiet: () => false,
    log: () => {},
    ...patch,
  });
}

beforeEach(() => {
  setSystemTime(new Date(START));
  port = testChoices(join(dir, `choices-${++n}.json`), { userId: OWNER, groupId: GROUP });
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  tasks = memoryTasks();
  sends = [];
  webPosts = [];
  edits = [];
  webOk = true;
  telegramOn = true;
  sendResult = sentOk;
  cleanup = [];
  const telegram = createTelegramChoices({ api: fakeApi, owner: OWNER, telegram: () => telegramOn, send, log: () => {} });
  composer = new Composer<Context>();
  cleanup.push(installTelegramChoices(composer, telegram));
});
afterEach(() => {
  for (const off of cleanup) off();
  logSpy.mockRestore();
  setSystemTime();
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

const topicConv: ChoiceConversation = { type: "telegram", chatId: GROUP, topicId: 443 };
const dmConv: ChoiceConversation = { type: "telegram", chatId: OWNER };
const webConv: ChoiceConversation = { type: "web", conversationId: WEB };
const webDmConv: ChoiceConversation = { type: "telegram", chatId: "web" };

/** Rückfrage wie aus einem Turn, über den echten offerAsk-Weg (gleiche Sende-Attrappe) */
async function asked(conversation: ChoiceConversation = topicConv, question = "Soll ich den Bericht jetzt verschicken?"): Promise<{ choice: Choice; taskId: string; askId: string }> {
  const telegram = createTelegramChoices({ api: fakeApi, owner: OWNER, telegram: () => telegramOn, send, log: () => {} });
  const offer = createAskOffer({
    sendChoice: choice => telegram.sendChoice(choice),
    postWeb: async (conversationId, post) => (webPosts.push({ conversationId, post }), true),
    tasks: () => tasks.open(),
    log: () => {},
  });
  const input: AskOffer = {
    conversation,
    question,
    options: ["Ja, verschicken", "Nein, erst zeigen"],
    originalPrompt: "Schreib den Wochenbericht",
    agent: "research",
    engine: "claude",
    model: "",
    sessionId: "sess-frage",
  };
  const outcome = await offer(input);
  if (outcome.status !== "offered") throw new Error(`nicht angeboten: ${outcome.status}`);
  sends = [];
  webPosts = [];
  return { choice: outcome.choice, taskId: outcome.taskId, askId: parseAskRef(outcome.choice.ref)!.askId };
}

const later = (ms: number) => setSystemTime(new Date(Date.now() + ms));
const row = (id: string) => tasks.rows.get(id)!;

/** Klick auf einen ch|-Knopf in Telegram, wie ihn grammy zustellt */
async function click(data: string, chatId: string, msg: number) {
  const update = {
    update_id: 1,
    callback_query: {
      id: "q1",
      from: { id: Number(OWNER), is_bot: false, first_name: "Alex" },
      chat_instance: "ci",
      data,
      message: { message_id: msg, date: 0, chat: { id: Number(chatId), type: chatId.startsWith("-") ? "supergroup" : "private", title: "G" } },
    },
  };
  const ctx = new Context(update as any, fakeApi as any, { id: 1, is_bot: true, first_name: "Bot", username: "bot" } as any);
  await composer.middleware()(ctx, async () => {});
}

// ---------------------------------------------------------------------------
// Rückfragen des Registers
// ---------------------------------------------------------------------------

describe("Rückfrage des Registers: wann erinnert wird", () => {
  test("fällig nach 2 Stunden, nicht vorher", async () => {
    const { choice } = await asked();
    later(TASK_REMINDER_AFTER_MS - MIN);
    expect(await reminders().remindAsks()).toBe(0);
    expect(sends).toEqual([]);
    later(MIN);
    expect(await reminders().remindAsks()).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0].choiceId).toBe(choice.id);
  });

  test("entschiedene Frage: keine Erinnerung", async () => {
    const { choice } = await asked();
    expect((await port.port.decide("topic-443", choice.id, "o0", "web")).status).toBe("decided");
    later(TASK_REMINDER_AFTER_MS);
    expect(await reminders().remindAsks()).toBe(0);
    expect(sends).toEqual([]);
  });

  test("abgelaufene Frage: keine Erinnerung", async () => {
    const { choice } = await asked();
    await expireChoice(choice.id);
    later(TASK_REMINDER_AFTER_MS);
    expect(await reminders().remindAsks()).toBe(0);
    expect(sends).toEqual([]);
  });

  test("überholt: andere askId am Auftrag oder Auftrag nicht mehr wartend, keine Erinnerung und kein Merker", async () => {
    const a = await asked();
    const b = await asked();
    row(a.taskId).metadata = { ...row(a.taskId).metadata, ask_id: "0123456789ab" };
    row(b.taskId).status = "running";
    later(TASK_REMINDER_AFTER_MS);
    expect(await reminders().remindAsks()).toBe(0);
    expect(sends).toEqual([]);
    expect(row(a.taskId).metadata?.ask_reminded).toBeUndefined();
    expect(row(b.taskId).metadata?.ask_reminded).toBeUndefined();
  });

  test("Auftrag fehlt oder liegt in einem anderen Gespräch: keine Erinnerung", async () => {
    const a = await asked();
    const b = await asked();
    tasks.rows.delete(a.taskId);
    row(b.taskId).thread_id = 500;
    later(TASK_REMINDER_AFTER_MS);
    expect(await reminders().remindAsks()).toBe(0);
    expect(sends).toEqual([]);
  });

  test("Ruhezeit: nachts nichts, danach in der ersten Runde", async () => {
    await asked();
    later(TASK_REMINDER_AFTER_MS);
    expect(await reminders({ isQuiet: () => true }).remindAsks()).toBe(0);
    expect(sends).toEqual([]);
    expect(await reminders({ isQuiet: () => false }).remindAsks()).toBe(1);
  });

  test("Ruhezeit der offenen Fäden als Standard (21 bis 8 Uhr in USER_TIMEZONE)", async () => {
    const saved = process.env.USER_TIMEZONE;
    process.env.USER_TIMEZONE = "Europe/Berlin";
    try {
      await asked();
      setSystemTime(new Date("2026-10-20T21:30:00.000Z")); // 23:30 in Berlin
      expect(await reminders({ isQuiet: undefined }).remindAsks()).toBe(0);
      setSystemTime(new Date("2026-10-21T06:30:00.000Z")); // 8:30 in Berlin
      expect(await reminders({ isQuiet: undefined }).remindAsks()).toBe(1);
    } finally {
      if (saved === undefined) delete process.env.USER_TIMEZONE;
      else process.env.USER_TIMEZONE = saved;
    }
  });
});

describe("Rückfrage des Registers: dieselbe Frage, überall", () => {
  test("Telegram-Topic: dieselbe choiceId mit Knöpfen, neue Nachricht am Eintrag gemerkt, kein neuer Eintrag, kein neuer Auftrag", async () => {
    const { choice, taskId } = await asked(topicConv);
    const before = await listChoices();
    const tasksBefore = tasks.rows.size;
    later(TASK_REMINDER_AFTER_MS);
    expect(await reminders().remindAsks()).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ chatId: GROUP, topicId: 443, choiceId: choice.id, text: TASK_REMINDER_TEXT.ask(choice.text) });
    expect(sends[0].buttons!.flat().map(b => b.callback_data)).toEqual([`ch|${choice.id}|o0`, `ch|${choice.id}|o1`, `ch|${choice.id}|cancel`]);
    const after = await listChoices();
    expect(after.map(c => c.id)).toEqual(before.map(c => c.id));
    expect((await getChoice(choice.id))!.telegram).toHaveLength(2);
    // Der Text der Frage im Register bleibt die Frage selbst
    expect((await getChoice(choice.id))!.text).toBe(choice.text);
    expect(tasks.rows.size).toBe(tasksBefore);
    expect(row(taskId).metadata?.ask_reminded).toBe(parseAskRef(choice.ref)!.askId);
    expect(webPosts).toEqual([]);
  });

  test("Telegram-Direktchat", async () => {
    const { choice } = await asked(dmConv);
    later(TASK_REMINDER_AFTER_MS);
    expect(await reminders().remindAsks()).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ chatId: OWNER, choiceId: choice.id });
    expect(sends[0].topicId).toBeUndefined();
  });

  test("reines Web-Gespräch: Meldung mit choiceId im Gespräch und Kopie im Direktchat", async () => {
    const { choice } = await asked(webConv);
    later(TASK_REMINDER_AFTER_MS);
    expect(await reminders().remindAsks()).toBe(1);
    expect(webPosts).toEqual([{ conversationId: WEB, post: { text: TASK_REMINDER_TEXT.ask(choice.text), kind: "notice", source: "rueckfrage", choiceId: choice.id } }]);
    expect(sends).toHaveLength(1);
    // Kopie ohne Chat-Angabe: die Outbox nimmt den Direktchat
    expect(sends[0].chatId).toBeUndefined();
    expect(sends[0].choiceId).toBe(choice.id);
  });

  test("Web-Direktchat ohne Telegram: über die WebUI festgehalten, mit choiceId", async () => {
    telegramOn = false;
    const { choice } = await asked(webDmConv);
    later(TASK_REMINDER_AFTER_MS);
    expect(await reminders().remindAsks()).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ chatId: "web", choiceId: choice.id, text: TASK_REMINDER_TEXT.ask(choice.text) });
    expect(sends[0].buttons).toBeUndefined();
  });

  test("Entscheiden über den Knopf der Erinnerung zieht auch die ursprüngliche Nachricht nach; zweites Entscheiden abgewiesen", async () => {
    const { choice } = await asked(topicConv);
    const original = (await getChoice(choice.id))!.telegram![0];
    later(TASK_REMINDER_AFTER_MS);
    await reminders().remindAsks();
    const reminder = (await getChoice(choice.id))!.telegram![1];
    expect(reminder.messageId).not.toBe(original.messageId);
    await click(`ch|${choice.id}|o1`, GROUP, reminder.messageId);
    expect((await getChoice(choice.id))!.state).toBe("done");
    expect(edits.map(e => e.messageId).sort()).toEqual([original.messageId, reminder.messageId].sort());
    // Zweites Entscheiden, in Telegram an der ursprünglichen Nachricht und im Browser
    edits = [];
    await click(`ch|${choice.id}|o0`, GROUP, original.messageId);
    expect((await getChoice(choice.id))!.result!.key).toBe("o1");
    expect((await port.port.decide("topic-443", choice.id, "o0", "web")).status).not.toBe("decided");
  });

  test("umgekehrt: Entscheiden im Browser zieht Frage und Erinnerung in Telegram nach", async () => {
    const { choice } = await asked(dmConv);
    later(TASK_REMINDER_AFTER_MS);
    await reminders().remindAsks();
    const refs = (await getChoice(choice.id))!.telegram!;
    expect(refs).toHaveLength(2);
    expect((await port.port.decide("dm", choice.id, "o0", "web")).status).toBe("decided");
    expect(edits.map(e => e.messageId).sort()).toEqual(refs.map(r => r.messageId).sort());
    expect((await port.port.decide("dm", choice.id, "o1", "web")).status).not.toBe("decided");
  });
});

describe("Rückfrage des Registers: höchstens einmal", () => {
  test("Neustart: zweiter Lauf mit frischem Modul und frisch geladenem Speicher sendet nichts", async () => {
    await asked();
    later(TASK_REMINDER_AFTER_MS);
    expect(await reminders().remindAsks()).toBe(1);
    later(30 * MIN);
    expect(await reminders().remindAsks()).toBe(0);
    expect(sends).toHaveLength(1);
  });

  test("zwei gleichzeitige Läufe: eine Erinnerung", async () => {
    await asked();
    later(TASK_REMINDER_AFTER_MS);
    const [a, b] = await Promise.all([reminders().remindAsks(), reminders().remindAsks()]);
    expect(a + b).toBe(1);
    expect(sends).toHaveLength(1);
  });

  test("Zustellung sicher gescheitert: Merker wieder weg, die nächste Runde versucht es erneut", async () => {
    const { taskId } = await asked();
    later(TASK_REMINDER_AFTER_MS);
    sendResult = () => ({ sent: false, recorded: false, error: { kind: "send", message: "abgelehnt", rejected: true } });
    expect(await reminders().remindAsks()).toBe(0);
    expect(sends).toHaveLength(1);
    expect(row(taskId).metadata?.ask_reminded).toBeUndefined();
    sendResult = sentOk;
    expect(await reminders().remindAsks()).toBe(1);
    expect(sends).toHaveLength(2);
  });

  test("Ausgang unklar (Netzfehler, keine sichere Ablehnung): Merker bleibt, keine zweite Erinnerung", async () => {
    for (const failure of ["throw", "unclear"] as const) {
      const { taskId } = await asked();
      later(TASK_REMINDER_AFTER_MS);
      sends = [];
      sendResult = () => (failure === "throw" ? "throw" : { sent: false, recorded: false, error: { kind: "send", message: "Zeitüberschreitung" } });
      expect(await reminders().remindAsks()).toBe(0);
      expect(row(taskId).metadata?.ask_reminded).toBeDefined();
      sendResult = sentOk;
      expect(await reminders().remindAsks()).toBe(0);
      expect(sends).toHaveLength(1);
      await expireChoice((await listChoices()).find(c => c.state === "open")!.id);
    }
  });

  test("lange Erinnerung, erstes Stück angekommen, zweites abgelehnt: Merker bleibt, keine zweite Erinnerung", async () => {
    // Echte Outbox mit Telegram-Attrappe: Stück 1 angenommen, danach 400 mit ok: false
    const calls: { text: string; threadId?: number }[] = [];
    const fakeFetch = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      calls.push({ text: body.text, threadId: body.message_thread_id });
      return calls.length === 1
        ? new Response(JSON.stringify({ ok: true, result: { message_id: 501 } }), { status: 200 })
        : new Response(JSON.stringify({ ok: false, description: "Bad Request: zu viel" }), { status: 400 });
    };
    const outbox = (input: SendAndRecordInput) =>
      sendAndRecord(input, {
        botToken: "test-token",
        userId: OWNER,
        groupId: GROUP,
        outboxDir: join(dir, "outbox"),
        fetch: fakeFetch,
        record: async () => true,
        log: () => {},
        newId: () => "ablage-1",
      });
    const outcomes: ReminderDelivery[] = [];
    const show = createAskReminderShow({ telegram: () => true, send: outbox, refresh: async () => [], log: () => {} });
    const showAsk: AskReminderShow = async (choice, text) => {
      const outcome = await show(choice, text);
      outcomes.push(outcome);
      return outcome;
    };
    const { taskId, askId } = await asked(topicConv, "Welche Fassung soll raus? " + "Lange Begründung. ".repeat(400));
    later(TASK_REMINDER_AFTER_MS);
    expect(await reminders({ showAsk }).remindAsks()).toBe(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatchObject({ threadId: 443 });
    expect(calls[0].text.startsWith("Erinnerung: Ich warte noch auf deine Antwort.")).toBe(true);
    expect(outcomes).toEqual(["shown"]);
    expect(row(taskId).metadata?.ask_reminded).toBe(askId);
    // Nächste Runde: dieselbe Erinnerung kommt nicht noch einmal
    later(15 * MIN);
    expect(await reminders({ showAsk }).remindAsks()).toBe(0);
    expect(calls).toHaveLength(2);
    expect(outcomes).toEqual(["shown"]);
  });

  test("Teilerfolg im Web-Gespräch: im Gespräch angekommen, Kopie gescheitert, gilt als erinnert", async () => {
    await asked(webConv);
    later(TASK_REMINDER_AFTER_MS);
    sendResult = () => ({ sent: false, recorded: false, error: { kind: "send", message: "abgelehnt", rejected: true } });
    expect(await reminders().remindAsks()).toBe(1);
    expect(await reminders().remindAsks()).toBe(0);
    expect(webPosts).toHaveLength(1);
    expect(sends).toHaveLength(1);
  });

  test("Web-Gespräch nirgends angekommen: nächste Runde erneut", async () => {
    const { taskId } = await asked(webConv);
    later(TASK_REMINDER_AFTER_MS);
    webOk = false;
    sendResult = () => ({ sent: false, recorded: false, error: { kind: "send", message: "abgelehnt", rejected: true } });
    expect(await reminders().remindAsks()).toBe(0);
    expect(row(taskId).metadata?.ask_reminded).toBeUndefined();
    webOk = true;
    expect(await reminders().remindAsks()).toBe(1);
  });

  test("Merker nicht speicherbar (false oder Ausnahme): nichts gesendet", async () => {
    const { taskId } = await asked();
    later(TASK_REMINDER_AFTER_MS);
    for (const result of [false, "throw"] as const) {
      tasks.sw.update = changes => ("metadata" in changes ? result : true);
      let shown = 0;
      expect(await reminders({ showAsk: async () => (shown++, "shown") }).remindAsks()).toBe(0);
      expect(shown).toBe(0);
      expect(row(taskId).metadata?.ask_reminded).toBeUndefined();
    }
  });

  test("Senden außerhalb der Sperre: eine Entscheidung während des Versands wartet nicht auf ihn", async () => {
    const { choice, taskId } = await asked();
    later(TASK_REMINDER_AFTER_MS);
    let lockedMeanwhile = false;
    const show: AskReminderShow = async () => {
      // Sperre des Auftrags während des Sendens frei: ask-choices könnte jetzt beanspruchen
      lockedMeanwhile = await withTaskLock(taskId, async () => true);
      await port.port.decide("topic-443", choice.id, "o0", "web");
      return "shown" as ReminderDelivery;
    };
    expect(await reminders({ showAsk: show }).remindAsks()).toBe(1);
    expect(lockedMeanwhile).toBe(true);
    expect((await getChoice(choice.id))!.state).toBe("done");
  });

  test("Frage zwischen Merker und Senden entschieden: nichts gesendet", async () => {
    const { choice } = await asked();
    later(TASK_REMINDER_AFTER_MS);
    let shown = 0;
    const r = reminders({
      showAsk: async () => (shown++, "shown"),
      lock: async (id, fn) => {
        const result = await withTaskLock(id, fn);
        await port.port.decide("topic-443", choice.id, "o0", "web");
        return result;
      },
    });
    expect(await r.remindAsks()).toBe(0);
    expect(shown).toBe(0);
  });

  test("Bezug: askRef und parseAskRef bleiben die Schnittstelle", () => {
    expect(parseAskRef(askRef("task-1", "a1b2c3d4e5f6"))).toEqual({ taskId: "task-1", askId: "a1b2c3d4e5f6" });
  });
});

// ---------------------------------------------------------------------------
// Alte Aufträge ohne askId
// ---------------------------------------------------------------------------

describe("alte Aufträge: einmal mit atask-Knöpfen", () => {
  async function oldTask(chatId = OWNER, patch: Partial<AsyncTask> = {}): Promise<AsyncTask> {
    const t = (await tasks.open().create(chatId, "Plane die Woche"))!;
    Object.assign(row(t.id), {
      status: "needs_input",
      pending_question: "Welcher Tag?",
      pending_options: [
        { label: "1. Montag", value: "1" },
        { label: "2. Dienstag", value: "2" },
      ],
      ...patch,
    });
    return row(t.id);
  }
  function capture() {
    const notified: { text: string; chatId: string; buttons: { text: string; callback_data: string }[][] }[] = [];
    const notify: LegacyTaskNotify = async (text, target) => (notified.push({ text, ...target }), true);
    return { notified, notify };
  }

  test("nach 2 Stunden einmal, deutscher Text, Knöpfe je Antwort und „Abbrechen“, danach reminder_sent", async () => {
    const old = await oldTask();
    const { notified, notify } = capture();
    later(TASK_REMINDER_AFTER_MS - MIN);
    expect(await reminders({ notifyLegacy: notify }).remindLegacy()).toBe(0);
    later(2 * MIN);
    expect(await reminders({ notifyLegacy: notify }).remindLegacy()).toBe(1);
    expect(notified).toEqual([
      {
        text: TASK_REMINDER_TEXT.legacy("Welcher Tag?"),
        chatId: OWNER,
        buttons: [
          [{ text: "1. Montag", callback_data: `atask:${old.id}:1` }],
          [{ text: "2. Dienstag", callback_data: `atask:${old.id}:2` }],
          [{ text: "Abbrechen", callback_data: `atask:${old.id}:cancel` }],
        ],
      },
    ]);
    expect(TASK_REMINDER_TEXT.legacy("x")).toStartWith("Erinnerung: ");
    expect(row(old.id).reminder_sent).toBe(true);
    // Neustart: nichts mehr
    expect(await reminders({ notifyLegacy: notify }).remindLegacy()).toBe(0);
    expect(notified).toHaveLength(1);
  });

  test("ohne Frage der Anfang des Auftrags; ohne Antworten nur „Abbrechen“", async () => {
    const old = await oldTask("web", { pending_question: undefined, pending_options: undefined, original_prompt: "x".repeat(300) });
    const { notified, notify } = capture();
    later(TASK_REMINDER_AFTER_MS + MIN);
    expect(await reminders({ notifyLegacy: notify }).remindLegacy()).toBe(1);
    expect(notified[0].text).toBe(TASK_REMINDER_TEXT.legacy("x".repeat(200)));
    expect(notified[0].chatId).toBe("web");
    expect(notified[0].buttons).toEqual([[{ text: "Abbrechen", callback_data: `atask:${old.id}:cancel` }]]);
  });

  test("Aufträge mit askId bekommen nie atask-Knöpfe, auch ohne reminder_sent", async () => {
    const { taskId } = await asked(dmConv);
    row(taskId).reminder_sent = false;
    const { notified, notify } = capture();
    later(TASK_REMINDER_AFTER_MS + MIN);
    expect(await reminders({ notifyLegacy: notify, showAsk: async () => "failed" }).remindLegacy()).toBe(0);
    expect(notified).toEqual([]);
  });

  test("nur der Direktchat: Topic, General, reines Web-Gespräch und fremde Chats bleiben", async () => {
    await oldTask(GROUP, { thread_id: 443 });
    await oldTask(GROUP);
    await oldTask(`web:${WEB}`);
    await oldTask("999");
    await oldTask(OWNER, { thread_id: 9 });
    const { notified, notify } = capture();
    later(TASK_REMINDER_AFTER_MS + MIN);
    expect(await reminders({ notifyLegacy: notify }).remindLegacy()).toBe(0);
    expect(notified).toEqual([]);
  });

  test("nicht zugestellt (false oder Ausnahme): nicht vermerkt, nächste Runde erneut", async () => {
    const old = await oldTask();
    later(TASK_REMINDER_AFTER_MS + MIN);
    expect(await reminders({ notifyLegacy: async () => false }).remindLegacy()).toBe(0);
    expect(
      await reminders({
        notifyLegacy: async () => {
          throw new Error("weg");
        },
      }).remindLegacy()
    ).toBe(0);
    expect(row(old.id).reminder_sent).toBeFalsy();
    const { notified, notify } = capture();
    expect(await reminders({ notifyLegacy: notify }).remindLegacy()).toBe(1);
    expect(notified).toHaveLength(1);
  });

  test("ein Lauf erledigt beide Arten", async () => {
    await oldTask();
    await asked(topicConv);
    later(TASK_REMINDER_AFTER_MS + MIN);
    const { notify } = capture();
    expect(await reminders({ notifyLegacy: notify }).run()).toEqual({ asks: 1, legacy: 1 });
  });
});
