/**
 * Issue #322: Knöpfe an Erinnerungen (src/lib/reminder-choices.ts) mit dem
 * echten Rückfragen-Register, der echten Outbox (Attrappen für fetch und
 * Nachrichtenspeicher) und beiden Adaptern der Ablage. Belegt: Zustellung
 * genau einer Meldung mit choiceId, in Telegram mit den drei Knöpfen und
 * am Register gemerkter Nachricht, ohne Telegram nur im Web-Direktchat
 * (Rückfrage dort entscheidbar), Web-Gespräche nur im Gespräch; abgelehnt
 * lässt die Rückfrage ablaufen, eine neue Zustellung ersetzt ältere offene
 * Rückfragen. Knöpfe: „in 1 Stunde“ und „morgen 9 Uhr“ verschieben due_at
 * (auch über die Zeitumstellung), „Erledigt“ ändert nichts, alte Knöpfe
 * ändern keinen späteren Termin, Serien bekommen eine Kopie, doppelte Klicks
 * aus zwei Kanälen wirken einmal, ein Klick im Browser, während der Planer
 * den Versand noch abschließt, wirkt genau einmal und wird nicht
 * überschrieben. Erinnerungen aus Turns ohne Telegram (Direktchat, Topic)
 * kommen nur ins WebUI-Gespräch, ihre Rückfrage und die Antwort auf den
 * Knopf ebenso. Dazu ein Durchlauf Planer, Klick, Planer. Lehnt die Outbox
 * ein Telegram-Ziel ab (alte Gruppe), geht die Erinnerung über den Rückfall
 * des Haupt-Bots; dessen Nachricht wird am Register gemerkt, und ein Klick in
 * Telegram (Callback-Middleware) verschiebt due_at.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { Composer, Context, GrammyError, HttpError } from "grammy";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createChoice,
  decideChoice,
  getChoice,
  listChoices,
  onChoiceDecided,
  setChoicesFileForTests,
  type Choice,
  type ChoiceConversation,
} from "../src/lib/choices";
import { createBotNotices } from "../src/lib/bot-notices";
import { sendAndRecord, type OutboxDeps } from "../src/lib/outbox";
import { createTelegramChoices, installTelegramChoices } from "../src/lib/telegram-choices";
import {
  createReminderChoices,
  createReminderSender,
  occurrenceAction,
  occurrenceOf,
  REMINDER_CHOICE_TEXT,
  REMINDER_OPTIONS,
  REMINDER_SOURCE,
  reminderTarget,
  tomorrowAtNine,
} from "../src/lib/reminder-choices";
import { fileScheduleStore } from "../src/lib/schedule/file";
import { createReminderPlanner, MAX_SEND_ATTEMPTS, PLANNER_ERRORS } from "../src/lib/schedule/planner";
import { webOnlyChatId } from "../src/lib/schedule/remind";
import type { PostWeb, WebPost } from "../src/lib/review-choices";
import type { ScheduledTask, ScheduleStore } from "../src/lib/schedule/store";
import { supabaseScheduleStore } from "../src/lib/schedule/supabase";
import type { Message } from "../src/lib/store/types";
import { getSupabase } from "../src/lib/supabase";
import { createUserDelivery } from "../src/lib/user-notify";
import { useTaskTables } from "./tasks-fixture";

const ZONE = "Europe/Berlin";
const USER = "4711";
const GROUP = "-1001234567890";
const WEB_ID = "3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b";
// 18.10.2026 12:00 in Berlin
const NOW = Date.parse("2026-10-18T10:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

let clock = NOW;
let dir: string;
let quiet: typeof console.error;
let unregister: (() => void) | null = null;

beforeEach(() => {
  clock = NOW;
  setSystemTime(new Date(NOW));
  dir = mkdtempSync(join(tmpdir(), "tybo-reminder-choices-"));
  setChoicesFileForTests(join(dir, "choices.json"));
  quiet = console.error;
  console.error = () => {};
});
afterEach(() => {
  unregister?.();
  unregister = null;
  setChoicesFileForTests(null);
  setSystemTime();
  console.error = quiet;
  rmSync(dir, { recursive: true, force: true });
});

function advance(ms: number) {
  clock += ms;
  setSystemTime(new Date(clock));
}

/** Outbox mit Attrappen; telegramReply steuert die Antwort von Telegram */
function outbox(options: { telegram: boolean; recordOk?: boolean; telegramReply?: () => Response }) {
  const calls: { method: string; body: Record<string, any> }[] = [];
  const recorded: Message[] = [];
  let id = 100;
  const deps: OutboxDeps = {
    botToken: options.telegram ? "123:t" : "",
    userId: options.telegram ? USER : "",
    groupId: GROUP,
    outboxDir: join(dir, "outbox"),
    fetch: async (url, init) => {
      calls.push({ method: url.split("/").pop()!, body: JSON.parse(String(init.body)) });
      return options.telegramReply?.() ?? Response.json({ ok: true, result: { message_id: ++id } });
    },
    record: async m => {
      if (options.recordOk === false) return false;
      recorded.push(m);
      return true;
    },
    log: () => {},
    newId: () => crypto.randomUUID(),
  };
  const deliver = createUserDelivery({
    telegram: () => options.telegram,
    send: input => sendAndRecord(input, deps),
    dmChatId: () => USER,
    log: () => {},
  });
  return { deliver, calls, recorded, deps };
}

const task = (over: Partial<ScheduledTask> = {}): ScheduledTask => ({
  id: "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  chatId: USER,
  topicId: null,
  kind: "reminder",
  text: "Zahnarzt anrufen",
  dueAt: new Date(NOW - MIN).toISOString(),
  recurrence: null,
  status: "running",
  attempts: 1,
  lastError: null,
  leaseOwner: "a",
  leaseUntil: null,
  sendStartedAt: null,
  createdAt: new Date(NOW - HOUR).toISOString(),
  updatedAt: new Date(NOW - HOUR).toISOString(),
  ...over,
});

describe("Ziel und Termin", () => {
  test("Telegram-Chat mit Topic, ohne Telegram der Web-Direktchat, Web-Gespräch, unbekannt", () => {
    expect(reminderTarget({ chatId: GROUP, topicId: 7 }, true)).toEqual({ chatId: GROUP, topicId: 7, conversation: { type: "telegram", chatId: GROUP, topicId: 7 } });
    expect(reminderTarget({ chatId: USER, topicId: null }, true)).toEqual({ chatId: USER, conversation: { type: "telegram", chatId: USER } });
    expect(reminderTarget({ chatId: GROUP, topicId: 7 }, false)).toEqual({ chatId: "web", conversation: { type: "telegram", chatId: "web" } });
    expect(reminderTarget({ chatId: `web:${WEB_ID}`, topicId: null }, true)).toEqual({ chatId: `web:${WEB_ID}`, conversation: { type: "web", conversationId: WEB_ID } });
    expect(reminderTarget({ chatId: "web", topicId: null }, true)).toEqual({ chatId: "web", conversation: { type: "telegram", chatId: "web" } });
    expect(reminderTarget({ chatId: "irgendwas", topicId: null }, true)).toBeNull();
  });

  test("Turn ohne Telegram: Direktchat und Topic nur im WebUI-Gespräch, ohne Telegram der Web-Direktchat", () => {
    expect(reminderTarget({ chatId: webOnlyChatId(USER), topicId: null }, true)).toEqual({ chatId: USER, conversation: { type: "telegram", chatId: USER }, webOnly: "dm" });
    expect(reminderTarget({ chatId: webOnlyChatId(GROUP), topicId: 9 }, true)).toEqual({ chatId: GROUP, topicId: 9, conversation: { type: "telegram", chatId: GROUP, topicId: 9 }, webOnly: "topic-9" });
    expect(reminderTarget({ chatId: webOnlyChatId(GROUP), topicId: null }, true)?.webOnly).toBe("topic-1");
    expect(reminderTarget({ chatId: webOnlyChatId(USER), topicId: null }, false)).toEqual({ chatId: "web", conversation: { type: "telegram", chatId: "web" } });
    expect(reminderTarget({ chatId: webOnlyChatId("web"), topicId: null }, true)).toEqual({ chatId: "web", conversation: { type: "telegram", chatId: "web" } });
    expect(reminderTarget({ chatId: "webui:", topicId: null }, true)).toBeNull();
    expect(reminderTarget({ chatId: "webui:kaputt", topicId: null }, true)).toBeNull();
  });

  test("Termin an der Rückfrage hin und zurück", () => {
    const action = occurrenceAction("2026-10-18T09:59:00.000Z");
    expect(action).toMatch(/^due-[0-9a-z]+$/);
    expect(occurrenceOf(action)).toBe(Date.parse("2026-10-18T09:59:00.000Z"));
    expect(occurrenceOf(undefined)).toBeNull();
    expect(occurrenceOf("menu")).toBeNull();
  });

  test("morgen 9 Uhr in USER_TIMEZONE, auch über das Ende der Sommerzeit", () => {
    expect(tomorrowAtNine(NOW, ZONE).toISOString()).toBe("2026-10-19T07:00:00.000Z");
    // Samstag 24.10. 22:00 Sommerzeit, Sonntag 25.10. stellt die Uhr zurück: 9 Uhr ist dann UTC+1
    expect(tomorrowAtNine(Date.parse("2026-10-24T20:00:00.000Z"), ZONE).toISOString()).toBe("2026-10-25T08:00:00.000Z");
    // Kurz nach Mitternacht Ortszeit ist „morgen“ schon der nächste Tag
    expect(tomorrowAtNine(Date.parse("2026-10-18T22:30:00.000Z"), ZONE).toISOString()).toBe("2026-10-20T07:00:00.000Z");
    expect(tomorrowAtNine(NOW, "UTC").toISOString()).toBe("2026-10-19T09:00:00.000Z");
  });
});

describe("Zustellung mit Knöpfen", () => {
  test("Telegram: eine Nachricht mit drei Knöpfen, ein Eintrag mit choiceId, Nachricht am Register gemerkt", async () => {
    const o = outbox({ telegram: true });
    const send = createReminderSender({ deliver: o.deliver, telegram: () => true, log: () => {} });
    expect(await send(task({ chatId: GROUP, topicId: 7 }), "⏰ Erinnerung: Zahnarzt anrufen")).toBe("delivered");
    expect(o.calls).toHaveLength(1);
    expect(o.calls[0].body).toMatchObject({ chat_id: GROUP, message_thread_id: 7, text: "⏰ Erinnerung: Zahnarzt anrufen" });
    expect(o.calls[0].body.parse_mode).toBeUndefined();
    const [choice] = await listChoices();
    const keys = o.calls[0].body.reply_markup.inline_keyboard.flat().map((b: { text: string; callback_data: string }) => [b.text, b.callback_data]);
    expect(keys).toEqual(REMINDER_OPTIONS.map(opt => [opt.label, `ch|${choice.id}|${opt.key}`]));
    expect(o.recorded).toHaveLength(1);
    expect(o.recorded[0]).toMatchObject({ chat_id: GROUP, metadata: { source: REMINDER_SOURCE, choiceId: choice.id, topicId: 7 } });
    expect(choice).toMatchObject({
      kind: "reminder",
      state: "open",
      ref: task().id,
      action: occurrenceAction(task().dueAt),
      conversation: { type: "telegram", chatId: GROUP, topicId: 7 },
      telegram: [{ chatId: GROUP, messageId: 101 }],
    });
  });

  test("ohne Telegram: nur im Web-Direktchat, Rückfrage gehört dorthin, kein Aufruf an Telegram", async () => {
    const o = outbox({ telegram: false });
    const send = createReminderSender({ deliver: o.deliver, telegram: () => false, log: () => {} });
    expect(await send(task({ chatId: USER }), "⏰ Erinnerung: x")).toBe("delivered");
    expect(o.calls).toEqual([]);
    const [choice] = await listChoices();
    expect(o.recorded).toHaveLength(1);
    expect(o.recorded[0]).toMatchObject({ chat_id: "web", metadata: { choiceId: choice.id, source: REMINDER_SOURCE } });
    expect(choice.conversation).toEqual({ type: "telegram", chatId: "web" });
    expect(choice.telegram).toBeUndefined();
  });

  test("Web-Gespräch: nur dort festgehalten, auch mit Telegram", async () => {
    const o = outbox({ telegram: true });
    const send = createReminderSender({ deliver: o.deliver, telegram: () => true, log: () => {} });
    await send(task({ chatId: `web:${WEB_ID}` }), "⏰ Erinnerung: x");
    expect(o.calls).toEqual([]);
    const [choice] = await listChoices();
    expect(o.recorded.map(m => [m.chat_id, m.metadata?.choiceId])).toEqual([[`web:${WEB_ID}`, choice.id]]);
    expect(choice.conversation).toEqual({ type: "web", conversationId: WEB_ID });
  });

  test("Telegram lehnt sicher ab: abgelehnt, die Rückfrage läuft ab", async () => {
    const o = outbox({ telegram: true, telegramReply: () => Response.json({ ok: false, description: "Bad Request: chat not found" }, { status: 400 }) });
    const send = createReminderSender({ deliver: o.deliver, telegram: () => true, log: () => {} });
    expect(await send(task(), "⏰ Erinnerung: x")).toBe("rejected");
    expect((await listChoices())[0].state).toBe("expired");
  });

  test("Teilerfolg: Telegram angekommen, Festhalten gescheitert, gilt als zugestellt", async () => {
    const o = outbox({ telegram: true, recordOk: false });
    const send = createReminderSender({ deliver: o.deliver, telegram: () => true, log: () => {} });
    expect(await send(task(), "⏰ Erinnerung: x")).toBe("delivered");
    expect((await listChoices())[0]).toMatchObject({ state: "open", telegram: [{ chatId: USER, messageId: 101 }] });
  });

  test("ohne Telegram und Festhalten gescheitert: unklar, Rückfrage bleibt", async () => {
    const o = outbox({ telegram: false, recordOk: false });
    const send = createReminderSender({ deliver: o.deliver, telegram: () => false, log: () => {} });
    expect(await send(task(), "x")).toBe("unclear");
    expect((await listChoices())[0].state).toBe("open");
  });

  test("neue Zustellung desselben Eintrags ersetzt die ältere offene Rückfrage, andere bleiben", async () => {
    const o = outbox({ telegram: false });
    const send = createReminderSender({ deliver: o.deliver, telegram: () => false, log: () => {} });
    await send(task(), "x");
    await send(task({ id: "anderer" }), "y");
    await send(task({ dueAt: new Date(NOW).toISOString() }), "x");
    const choices = await listChoices();
    expect(choices.filter(c => c.ref === task().id).map(c => c.state).sort()).toEqual(["expired", "open"]);
    expect(choices.find(c => c.ref === "anderer")?.state).toBe("open");
  });

  test("Rückfrage nicht anlegbar: Erinnerung kommt ohne Knöpfe", async () => {
    const o = outbox({ telegram: true });
    const logs: string[] = [];
    const send = createReminderSender({
      deliver: o.deliver,
      telegram: () => true,
      createChoice: async () => {
        throw new Error("Register kaputt");
      },
      log: line => logs.push(line),
    });
    expect(await send(task(), "x")).toBe("delivered");
    expect(o.calls[0].body.reply_markup).toBeUndefined();
    expect(o.recorded[0].metadata?.choiceId).toBeUndefined();
    expect(logs.some(l => l.includes("ohne Knöpfe"))).toBe(true);
  });

  test("Turn ohne Telegram im Direktchat und im Topic: nur ins WebUI-Gespräch, Rückfrage mit noTelegram", async () => {
    const o = outbox({ telegram: true });
    const posts: [string, WebPost][] = [];
    const postWeb: PostWeb = async (conversationId, post) => (posts.push([conversationId, post]), true);
    const send = createReminderSender({ deliver: o.deliver, postWeb, telegram: () => true, log: () => {} });
    expect(await send(task({ chatId: webOnlyChatId(USER) }), "⏰ Erinnerung: a")).toBe("delivered");
    expect(await send(task({ id: "zwei", chatId: webOnlyChatId(GROUP), topicId: 9 }), "⏰ Erinnerung: b")).toBe("delivered");
    expect(o.calls).toEqual([]);
    expect(o.recorded).toEqual([]);
    const choices = await listChoices();
    const dm = choices.find(c => c.ref === task().id)!;
    const topic = choices.find(c => c.ref === "zwei")!;
    expect(dm).toMatchObject({ conversation: { type: "telegram", chatId: USER }, noTelegram: { conversationId: "dm" }, state: "open" });
    expect(topic).toMatchObject({ conversation: { type: "telegram", chatId: GROUP, topicId: 9 }, noTelegram: { conversationId: "topic-9" } });
    expect(posts).toEqual([
      ["dm", { text: "⏰ Erinnerung: a", kind: "notice", source: REMINDER_SOURCE, choiceId: dm.id }],
      ["topic-9", { text: "⏰ Erinnerung: b", kind: "notice", source: REMINDER_SOURCE, choiceId: topic.id }],
    ]);
  });

  test("Turn ohne Telegram, WebUI-Gespräch nicht erreichbar: abgelehnt, Rückfrage läuft ab; Ausnahme: unklar", async () => {
    const o = outbox({ telegram: true });
    const refused = createReminderSender({ deliver: o.deliver, postWeb: async () => false, telegram: () => true, log: () => {} });
    expect(await refused(task({ chatId: webOnlyChatId(USER) }), "x")).toBe("rejected");
    expect((await listChoices())[0].state).toBe("expired");
    const missing = createReminderSender({ deliver: o.deliver, telegram: () => true, log: () => {} });
    expect(await missing(task({ id: "b", chatId: webOnlyChatId(USER) }), "x")).toBe("rejected");
    const throwing = createReminderSender({
      deliver: o.deliver,
      postWeb: async () => {
        throw new Error("weg");
      },
      telegram: () => true,
      log: () => {},
    });
    expect(await throwing(task({ id: "c", chatId: webOnlyChatId(USER) }), "x")).toBe("unclear");
    expect((await listChoices()).find(c => c.ref === "c")?.state).toBe("open");
    expect(o.calls).toEqual([]);
  });

  test("unbekanntes Gespräch: abgelehnt, nichts gesendet", async () => {
    const o = outbox({ telegram: true });
    const send = createReminderSender({ deliver: o.deliver, telegram: () => true, log: () => {} });
    expect(await send(task({ chatId: "kaputt" }), "x")).toBe("rejected");
    expect(o.calls).toEqual([]);
    expect(await listChoices()).toEqual([]);
  });
});

const ADAPTERS = [
  {
    name: "Datei",
    setup() {
      const path = join(dir, "data", "reminders.json");
      return { store: fileScheduleStore(() => path), cleanup: () => {} };
    },
  },
  {
    name: "Supabase",
    setup() {
      const tables = useTaskTables();
      return { store: supabaseScheduleStore(getSupabase), cleanup: () => tables.restore() };
    },
  },
];

for (const adapter of ADAPTERS) {
  describe(`Knöpfe (${adapter.name})`, () => {
    let store: ScheduleStore;
    let cleanup: () => void;
    let said: { conversation: ChoiceConversation; text: string }[];
    let posted: [string, WebPost][];
    beforeEach(() => {
      ({ store, cleanup } = adapter.setup());
      said = [];
      posted = [];
      const choices = createReminderChoices({
        store: () => store,
        now: () => clock,
        timeZone: () => ZONE,
        notify: async (conversation, text) => void said.push({ conversation, text }),
        postWeb: async (conversationId, post) => (posted.push([conversationId, post]), true),
        log: () => {},
      });
      unregister = onChoiceDecided("reminder", choices.handler);
    });
    afterEach(() => cleanup());

    /** Zugestellte einmalige Erinnerung samt offener Rückfrage */
    async function delivered(over: Partial<Parameters<ScheduleStore["add"]>[0]> = {}): Promise<{ task: ScheduledTask; choice: Choice }> {
      const added = (await store.add({ chatId: USER, text: "Zahnarzt anrufen", dueAt: new Date(NOW - MIN), ...over }))!;
      const t = over.recurrence ? added : (await store.update(added.id, { status: "done", attempts: 1 }))!;
      const choice = await createChoice({
        kind: "reminder",
        conversation: { type: "telegram", chatId: USER },
        text: "⏰ Erinnerung: Zahnarzt anrufen",
        options: REMINDER_OPTIONS,
        ref: t.id,
        action: occurrenceAction(added.dueAt),
      });
      return { task: t, choice };
    }

    test("„in 1 Stunde“ verschiebt due_at, die Erinnerung wartet wieder", async () => {
      const { task: t, choice } = await delivered();
      expect((await decideChoice(choice.id, "hour", "telegram")).status).toBe("decided");
      expect(await store.byId(t.id)).toMatchObject({ status: "pending", dueAt: "2026-10-18T11:00:00.000Z", attempts: 0, lastError: null });
      expect(said).toEqual([{ conversation: { type: "telegram", chatId: USER }, text: REMINDER_CHOICE_TEXT.moved("18.10. 13:00") }]);
    });

    test("„morgen 9 Uhr“ verschiebt auf 9 Uhr Ortszeit am nächsten Tag", async () => {
      const { task: t, choice } = await delivered();
      await decideChoice(choice.id, "tomorrow", "web");
      expect(await store.byId(t.id)).toMatchObject({ status: "pending", dueAt: "2026-10-19T07:00:00.000Z" });
      expect(said[0].text).toBe(REMINDER_CHOICE_TEXT.moved("19.10. 09:00"));
    });

    test("„morgen 9 Uhr“ am Abend vor der Zeitumstellung", async () => {
      advance(Date.parse("2026-10-24T20:00:00.000Z") - NOW);
      const { task: t, choice } = await delivered({ dueAt: new Date(clock - MIN) });
      await decideChoice(choice.id, "tomorrow", "telegram");
      expect((await store.byId(t.id))?.dueAt).toBe("2026-10-25T08:00:00.000Z");
    });

    test("„Erledigt“ ändert nichts", async () => {
      const { task: t, choice } = await delivered();
      await decideChoice(choice.id, "done", "terminal");
      expect(await store.byId(t.id)).toEqual(t);
      expect(said.map(s => s.text)).toEqual([REMINDER_CHOICE_TEXT.done]);
    });

    test("doppelte Klicks aus Telegram und Browser: wirkt einmal", async () => {
      const { task: t, choice } = await delivered();
      expect((await decideChoice(choice.id, "hour", "telegram")).status).toBe("decided");
      advance(10 * MIN);
      expect((await decideChoice(choice.id, "tomorrow", "web")).status).toBe("already");
      expect((await store.byId(t.id))?.dueAt).toBe("2026-10-18T11:00:00.000Z");
      expect(said).toHaveLength(1);
    });

    test("alter Knopf ändert keinen späteren Termin", async () => {
      const { task: t, choice } = await delivered();
      // Inzwischen auf anderem Weg verschoben und wieder wartend
      await store.update(t.id, { status: "pending", dueAt: new Date(NOW + 3 * HOUR) });
      await decideChoice(choice.id, "hour", "web");
      expect(await store.byId(t.id)).toMatchObject({ status: "pending", dueAt: "2026-10-18T13:00:00.000Z" });
      expect(said[0].text).toBe(REMINDER_CHOICE_TEXT.changed);
    });

    test("Serie: Serie bleibt, eine einmalige Kopie zum neuen Termin", async () => {
      const { task: series, choice } = await delivered({ recurrence: "daily 08:00" });
      // Planer hat die Serie schon auf den nächsten Termin gesetzt
      await store.update(series.id, { dueAt: new Date("2026-10-19T06:00:00.000Z") });
      await decideChoice(choice.id, "hour", "telegram");
      const all = await store.list();
      expect(all).toHaveLength(2);
      expect(all.find(t => t.id === series.id)).toMatchObject({ status: "pending", dueAt: "2026-10-19T06:00:00.000Z", recurrence: "daily 08:00" });
      expect(all.find(t => t.id !== series.id)).toMatchObject({ status: "pending", dueAt: "2026-10-18T11:00:00.000Z", recurrence: null, text: "Zahnarzt anrufen", chatId: USER, kind: "reminder" });
      expect(said[0].text).toBe(REMINDER_CHOICE_TEXT.copied("18.10. 13:00"));
    });

    test("Eintrag weg oder abgebrochen: nichts verschoben", async () => {
      const { task: t, choice } = await delivered();
      await store.update(t.id, { status: "cancelled" });
      await decideChoice(choice.id, "hour", "telegram");
      expect((await store.byId(t.id))?.status).toBe("cancelled");
      const orphan = await createChoice({ kind: "reminder", conversation: { type: "telegram", chatId: USER }, text: "x", options: REMINDER_OPTIONS, ref: "fehlt", action: occurrenceAction(new Date(NOW).toISOString()) });
      await decideChoice(orphan.id, "hour", "telegram");
      expect(said.map(s => s.text)).toEqual([REMINDER_CHOICE_TEXT.gone, REMINDER_CHOICE_TEXT.gone]);
    });

    test("Rückfrage ohne Termin: Fehler am Register, nichts geändert", async () => {
      const { task: t } = await delivered();
      const broken = await createChoice({ kind: "reminder", conversation: { type: "telegram", chatId: USER }, text: "x", options: REMINDER_OPTIONS, ref: t.id });
      await decideChoice(broken.id, "hour", "telegram");
      expect((await getChoice(broken.id))?.handlerError).toBeDefined();
      expect(await store.byId(t.id)).toEqual(t);
    });

    test("ganzer Weg: Planer stellt zu, Klick „in 1 Stunde“, eine Stunde später wieder genau eine Zustellung", async () => {
      const o = outbox({ telegram: true });
      const make = (owner: string) =>
        createReminderPlanner({
          store: () => store,
          now: () => clock,
          owner,
          timeZone: () => ZONE,
          send: createReminderSender({ deliver: o.deliver, telegram: () => true, log: () => {} }),
          log: () => {},
        });
      // Zwei laufende Planer (etwa zwei Prozesse), beide seit NOW gestartet
      const a = make("bot-a");
      const b = make("bot-b");
      let turn = 0;
      const planner = () => (turn++ % 2 ? b : a);
      const added = (await store.add({ chatId: USER, text: "Test", dueAt: new Date(NOW + 2 * MIN) }))!;
      await planner().tick();
      expect(o.calls).toHaveLength(0);
      advance(2 * MIN + 30_000);
      await Promise.all([planner().tick(), planner().tick()]);
      expect(o.calls).toHaveLength(1);
      const first = (await listChoices()).find(c => c.state === "open")!;
      await decideChoice(first.id, "hour", "telegram");
      expect((await store.byId(added.id))?.status).toBe("pending");
      advance(30 * MIN);
      await planner().tick();
      expect(o.calls).toHaveLength(1);
      advance(31 * MIN);
      await planner().tick();
      await planner().tick();
      expect(o.calls).toHaveLength(2);
      expect(o.calls[1].body.text).toBe("⏰ Erinnerung: Test");
      const states = (await listChoices()).map(c => c.state).sort();
      expect(states).toEqual(["done", "open"]);
      expect((await store.byId(added.id))?.status).toBe("done");
    });

    test("Klick im Browser, während der Planer den Versand noch abschließt: wirkt genau einmal, nicht überschrieben", async () => {
      const o = outbox({ telegram: true });
      let release: () => void = () => {};
      const gate = new Promise<void>(r => (release = r));
      const deliver: typeof o.deliver = async (text, target) => {
        const result = await o.deliver(text, target);
        // Telegram hat die Nachricht schon, der Abschluss verzögert sich
        await gate;
        return result;
      };
      const logs: string[] = [];
      const planner = createReminderPlanner({
        store: () => store,
        now: () => clock,
        owner: "bot",
        timeZone: () => ZONE,
        send: createReminderSender({ deliver, telegram: () => true, log: () => {} }),
        log: line => logs.push(line),
      });
      const added = (await store.add({ chatId: USER, text: "Test", dueAt: new Date(NOW) }))!;
      const ticking = planner.tick();
      let choice: Choice | undefined;
      for (let i = 0; i < 50 && !choice; i++) {
        await Bun.sleep(5);
        choice = (await listChoices()).find(c => c.state === "open");
      }
      expect(choice).toBeDefined();
      expect((await store.byId(added.id))?.status).toBe("running");
      expect((await decideChoice(choice!.id, "hour", "web")).status).toBe("decided");
      expect(await store.byId(added.id)).toMatchObject({ status: "pending", dueAt: "2026-10-18T11:00:00.000Z", leaseOwner: null, sendStartedAt: null, attempts: 0 });
      release();
      expect(await ticking).toMatchObject({ sent: 1 });
      // Der Abschluss des Planers hat die Entscheidung nicht überschrieben
      expect(await store.byId(added.id)).toMatchObject({ status: "pending", dueAt: "2026-10-18T11:00:00.000Z" });
      expect(logs.some(l => l.includes("nichts überschrieben"))).toBe(true);
      expect(said.map(x => x.text)).toEqual([REMINDER_CHOICE_TEXT.moved("18.10. 13:00")]);
      expect((await decideChoice(choice!.id, "tomorrow", "telegram")).status).toBe("already");
      expect((await store.byId(added.id))?.dueAt).toBe("2026-10-18T11:00:00.000Z");
      expect(o.calls).toHaveLength(1);
      // Eine Stunde später genau eine neue Zustellung
      advance(HOUR);
      await planner.tick();
      await planner.tick();
      expect(o.calls).toHaveLength(2);
      expect((await store.byId(added.id))?.status).toBe("done");
    });

    test("Telegram-Rückfall (alte Gruppe, die die Outbox ablehnt): Nachricht gemerkt, Klick in Telegram verschiebt due_at", async () => {
      const OLD_GROUP = "-1009876543210";
      const o = outbox({ telegram: true });
      const direct: { chatId: string; text: string; options: Record<string, any> }[] = [];
      const status: string[] = [];
      const notices = createBotNotices({
        telegram: () => true,
        send: input => sendAndRecord(input, o.deps),
        sendStatusMessage: async chatId => void status.push(chatId),
        sendMessage: async (chatId, text, options) => (direct.push({ chatId, text, options }), { message_id: 555 }),
        dmChatId: () => USER,
        log: () => {},
      });
      const planner = createReminderPlanner({
        store: () => store,
        now: () => clock,
        owner: "bot",
        timeZone: () => ZONE,
        send: createReminderSender({ deliver: notices.deliverToUser, telegram: () => true, log: () => {} }),
        log: () => {},
      });
      const added = (await store.add({ chatId: OLD_GROUP, topicId: 3, text: "Test", dueAt: new Date(NOW) }))!;
      expect(await planner.tick()).toMatchObject({ sent: 1 });
      // Die Outbox hat abgelehnt (kein Aufruf), der Haupt-Bot hat mit Knöpfen gesendet
      expect(o.calls).toEqual([]);
      expect(direct).toHaveLength(1);
      expect(direct[0]).toMatchObject({ chatId: OLD_GROUP, options: { message_thread_id: 3 } });
      const choice = (await listChoices()).find(c => c.state === "open")!;
      expect(direct[0].options.reply_markup.inline_keyboard.flat().map((b: { callback_data: string }) => b.callback_data)).toEqual(
        REMINDER_OPTIONS.map(opt => `ch|${choice.id}|${opt.key}`),
      );
      expect(choice.telegram).toEqual([{ chatId: OLD_GROUP, messageId: 555 }]);
      expect((await store.byId(added.id))?.status).toBe("done");

      // Klick in Telegram über die echte Callback-Middleware
      const answers: (string | undefined)[] = [];
      const api = {
        answerCallbackQuery: async (_id: string, options?: { text?: string }) => (answers.push(options?.text), true),
        editMessageText: async () => true,
        editMessageReplyMarkup: async () => true,
      };
      const composer = new Composer<Context>();
      const off = installTelegramChoices(composer, createTelegramChoices({ api, owner: USER, log: () => {} }));
      try {
        const update = {
          update_id: 1,
          callback_query: {
            id: "q1",
            from: { id: Number(USER), is_bot: false, first_name: "Alex" },
            chat_instance: "ci",
            data: `ch|${choice.id}|hour`,
            message: { message_id: 555, date: 0, chat: { id: Number(OLD_GROUP), type: "supergroup", title: "Alt" } },
          },
        };
        const ctx = new Context(update as any, api as any, { id: 1, is_bot: true, first_name: "Bot", username: "bot" } as any);
        await composer.middleware()(ctx, async () => {});
      } finally {
        off();
      }
      expect(answers).toHaveLength(1);
      expect(answers[0]).not.toContain("Noch nicht bereit");
      expect(await store.byId(added.id)).toMatchObject({ status: "pending", dueAt: "2026-10-18T11:00:00.000Z", attempts: 0 });
      expect(said.map(x => x.text)).toEqual([REMINDER_CHOICE_TEXT.moved("18.10. 13:00")]);

      // notifyUser behält seinen Rückfall über sendStatusMessage
      expect(await notices.notifyUser("Hinweis", { chatId: OLD_GROUP })).toBe(true);
      expect(status).toEqual([OLD_GROUP]);
      expect(direct).toHaveLength(1);
    });

    /** Rückfall über den Haupt-Bot; reply steuert, was sendMessage beim n-ten Aufruf tut */
    function fallbackPlanner(reply: (call: number) => { message_id: number }) {
      const o = outbox({ telegram: true });
      const direct: { text: string; options: Record<string, any> }[] = [];
      const status: string[] = [];
      const notices = createBotNotices({
        telegram: () => true,
        send: input => sendAndRecord(input, o.deps),
        sendStatusMessage: async chatId => void status.push(chatId),
        sendMessage: async (_chatId, text, options) => (direct.push({ text, options }), reply(direct.length)),
        dmChatId: () => USER,
        log: () => {},
      });
      const planner = createReminderPlanner({
        store: () => store,
        now: () => clock,
        owner: "bot",
        timeZone: () => ZONE,
        send: createReminderSender({ deliver: notices.deliverToUser, telegram: () => true, log: () => {} }),
        log: () => {},
      });
      return { o, direct, status, notices, planner };
    }
    const OLD_GROUP = "-1009876543210";
    const rejection = (code: number) => new GrammyError("abgelehnt", { ok: false, error_code: code, description: "Bad Request" }, "sendMessage", {});

    test("Telegram-Rückfall: Nachricht angenommen, Antwort verloren: genau ein Versand, unklar, kein neuer Versand", async () => {
      const f = fallbackPlanner(() => {
        throw new HttpError("Network request for 'sendMessage' failed!", new Error("socket hang up"));
      });
      const added = (await store.add({ chatId: OLD_GROUP, topicId: 3, text: "Test", dueAt: new Date(NOW) }))!;
      expect(await f.notices.deliverToUser("x", { chatId: OLD_GROUP })).toMatchObject({ delivered: false, outcome: "unclear" });
      expect(f.direct).toHaveLength(1);
      f.direct.length = 0;
      // Der Planer zählt unklar als zugestellt (nicht wiederholt)
      expect(await f.planner.tick()).toMatchObject({ sent: 1, retry: 0, failed: 0 });
      expect(f.direct).toHaveLength(1);
      expect(f.direct[0].options.parse_mode).toBe("HTML");
      expect(await store.byId(added.id)).toMatchObject({ status: "done", lastError: PLANNER_ERRORS.unclear });
      advance(5 * MIN);
      await f.planner.tick();
      expect(f.direct).toHaveLength(1);
      expect(f.o.calls).toEqual([]);
    });

    test("Telegram-Rückfall: HTML mit 400 abgelehnt, ohne Auszeichnung Netzfehler: unklar, kein dritter Versand", async () => {
      const f = fallbackPlanner(call => {
        throw call === 1 ? rejection(400) : new HttpError("Network request for 'sendMessage' failed!", new Error("timeout"));
      });
      const added = (await store.add({ chatId: OLD_GROUP, text: "Test", dueAt: new Date(NOW) }))!;
      await f.planner.tick();
      advance(5 * MIN);
      await f.planner.tick();
      expect(f.direct.map(d => d.options.parse_mode)).toEqual(["HTML", undefined]);
      expect(await store.byId(added.id)).toMatchObject({ status: "done", lastError: PLANNER_ERRORS.unclear });
    });

    test("Telegram-Rückfall sicher abgelehnt: begrenzt wiederholt, danach failed statt done", async () => {
      // 403: kein Versuch ohne Auszeichnung; 400: genau einer je Durchlauf
      for (const [code, perAttempt] of [[403, 1], [400, 2]] as const) {
        const f = fallbackPlanner(() => {
          throw rejection(code);
        });
        const added = (await store.add({ chatId: OLD_GROUP, topicId: 3, text: `Test ${code}`, dueAt: new Date(NOW) }))!;
        const ticks = [];
        for (let i = 0; i < MAX_SEND_ATTEMPTS + 1; i++) ticks.push(await f.planner.tick());
        expect(ticks.map(t => [t.retry, t.failed])).toEqual([[1, 0], [1, 0], [0, 1], [0, 0]]);
        expect(f.direct).toHaveLength(MAX_SEND_ATTEMPTS * perAttempt);
        expect(await store.byId(added.id)).toMatchObject({ status: "failed", attempts: MAX_SEND_ATTEMPTS, lastError: PLANNER_ERRORS.rejected });
        // Die Rückfrage ist abgelaufen, notifyUser behält seinen Rückfall über sendStatusMessage
        expect((await listChoices()).filter(c => c.ref === added.id && c.state === "open")).toEqual([]);
        expect(await f.notices.notifyUser("Hinweis", { chatId: OLD_GROUP })).toBe(true);
        expect(f.status).toEqual([OLD_GROUP]);
        expect(f.o.calls).toEqual([]);
      }
    });

    test("Rückfrage aus einem Turn ohne Telegram: Antwort nur ins WebUI-Gespräch", async () => {
      const added = (await store.add({ chatId: webOnlyChatId(GROUP), topicId: 9, text: "x", dueAt: new Date(NOW - MIN) }))!;
      await store.update(added.id, { status: "done", attempts: 1 });
      const choice = await createChoice({
        kind: "reminder",
        conversation: { type: "telegram", chatId: GROUP, topicId: 9 },
        noTelegram: { conversationId: "topic-9" },
        text: "⏰ Erinnerung: x",
        options: REMINDER_OPTIONS,
        ref: added.id,
        action: occurrenceAction(added.dueAt),
      });
      await decideChoice(choice.id, "hour", "web");
      expect(said).toEqual([]);
      expect(posted).toEqual([["topic-9", { text: REMINDER_CHOICE_TEXT.moved("18.10. 13:00"), kind: "notice", source: REMINDER_SOURCE }]]);
      expect(await store.byId(added.id)).toMatchObject({ status: "pending", chatId: webOnlyChatId(GROUP), topicId: 9 });
    });
  });
}
