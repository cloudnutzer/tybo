/**
 * Issue #227, Prüfer-Runde 1: gemeinsamer Meldeweg für bot-interne Meldungen
 * (src/lib/user-notify.ts). Neustart, Credit-Guard, Erinnerungen an
 * liegengebliebene Aufgaben und Goal-Status gehen über die echte Outbox
 * (sendAndRecord) mit Attrappen für fetch und Nachrichtenspeicher: mit
 * Telegram genau ein Versand und genau ein Eintrag, ohne Telegram nur der
 * Eintrag für die WebUI und nie ein Aufruf an api.telegram.org; scheitert
 * das Festhalten, gilt die Meldung als nicht zugestellt. Geprüft wird die
 * Verdrahtung, die src/bot.ts benutzt (createBotNotices aus
 * src/lib/bot-notices.ts, seit Issue #322); src/bot.ts wird nie geladen.
 */
import { describe, expect, test } from "bun:test";
import type { AsyncTask } from "../src/lib/store/types";
import { createBotNotices } from "../src/lib/bot-notices";
import { GOAL_NOTICE_SOURCE } from "../src/lib/goal-actions";
import type { GoalTarget } from "../src/lib/goal-engine";
import { sendAndRecord, type OutboxDeps } from "../src/lib/outbox";
import { createRestartControl, RESTART_TEXT } from "../src/lib/restart-control";
import type { Message } from "../src/lib/store/types";
import { createTaskReminders, TASK_REMINDER_TEXT } from "../src/lib/task-reminders";
import { createUserDelivery, createUserNotifier, SYSTEM_NOTICE_SOURCE, TelegramRejectedError } from "../src/lib/user-notify";

const USER = "4711";
const GROUP = "-1001234567890";

function harness(options: { telegram: boolean; recordOk?: boolean }) {
  const calls: { method: string; body: Record<string, any> }[] = [];
  const recorded: Message[] = [];
  const direct: unknown[][] = [];
  let id = 0;
  const deps: OutboxDeps = {
    botToken: options.telegram ? "123:t" : "",
    userId: options.telegram ? USER : "",
    groupId: GROUP,
    outboxDir: "/nicht/benutzt",
    fetch: async (url, init) => {
      calls.push({ method: url.split("/").pop()!, body: JSON.parse(String(init.body)) });
      return Response.json({ ok: true, result: { message_id: ++id } });
    },
    record: async m => {
      if (options.recordOk === false) return false;
      recorded.push(m);
      return true;
    },
    log: () => {},
    newId: () => crypto.randomUUID(),
  };
  let sends = 0;
  const notices = createBotNotices({
    telegram: () => options.telegram,
    send: input => (sends++, sendAndRecord(input, deps)),
    sendStatusMessage: async (...args) => void direct.push(args),
    dmChatId: () => USER,
    log: () => {},
  });
  return { notices, notify: notices.notifyUser, calls, recorded, direct, sends: () => sends };
}

function restart(send: (text: string, chatId?: string, topicId?: number) => Promise<void>) {
  return createRestartControl({
    readRequest: async () => "WebUI",
    clearRequest: async () => {},
    busyCount: () => 0,
    detectSupervisor: async () => "launchd",
    closeIntake: () => () => {},
    send,
    shutdown: async () => {},
    isShuttingDown: () => false,
    log: () => {},
  });
}

describe("Neustart", () => {
  test("mit Telegram: einmal an Telegram, einmal festgehalten", async () => {
    const h = harness({ telegram: true });
    expect(await restart(h.notices.restart).maybeRestart("test")).toBe("restarting");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].method).toBe("sendMessage");
    expect(h.calls[0].body.chat_id).toBe(USER);
    expect(h.calls[0].body.parse_mode).toBe("HTML");
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ chat_id: USER, content: RESTART_TEXT.restarting("WebUI"), metadata: { source: SYSTEM_NOTICE_SOURCE } });
  });

  test("aus einem Topic: an das Topic der Forum-Gruppe, festgehalten mit topicId", async () => {
    const h = harness({ telegram: true });
    await restart(h.notices.restart).maybeRestart("test", GROUP, 7);
    expect(h.calls[0].body).toMatchObject({ chat_id: GROUP, message_thread_id: 7 });
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ chat_id: GROUP, metadata: { topicId: 7 } });
  });

  test("ohne Telegram: nur im Web-Direktchat, kein Aufruf an api.telegram.org", async () => {
    const h = harness({ telegram: false });
    await restart(h.notices.restart).maybeRestart("test", GROUP, 7);
    expect(h.calls).toEqual([]);
    expect(h.direct).toEqual([]);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ chat_id: "web", content: RESTART_TEXT.restarting("WebUI"), metadata: { source: SYSTEM_NOTICE_SOURCE } });
  });
});

describe("Credit-Guard", () => {
  test("mit Telegram: Klartext ohne parse_mode wie bisher, einmal festgehalten", async () => {
    const h = harness({ telegram: true });
    h.notices.plain("80 % verbraucht <Plan>");
    await Bun.sleep(20);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].body.parse_mode).toBeUndefined();
    expect(h.calls[0].body.text).toBe("80 % verbraucht <Plan>");
    expect(h.recorded.map(m => m.content)).toEqual(["80 % verbraucht <Plan>"]);
  });

  test("ohne Telegram: nur festgehalten", async () => {
    const h = harness({ telegram: false });
    h.notices.plain("80 % verbraucht");
    await Bun.sleep(20);
    expect(h.calls).toEqual([]);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0].chat_id).toBe("web");
  });

  test("Speicherfehler ohne Telegram: nicht zugestellt", async () => {
    const h = harness({ telegram: false, recordOk: false });
    expect(await h.notify("80 % verbraucht", { format: "plain" })).toBe(false);
    expect(h.calls).toEqual([]);
  });

  test("Speicherfehler mit Telegram: Telegram hat sie, also zugestellt", async () => {
    const h = harness({ telegram: true, recordOk: false });
    expect(await h.notify("80 % verbraucht")).toBe(true);
    expect(h.calls).toHaveLength(1);
  });
});

describe("Erinnerung an liegengebliebene Aufgaben", () => {
  const task = (chat_id: string): AsyncTask => ({
    id: `t-${chat_id}`,
    created_at: "",
    updated_at: "",
    chat_id,
    original_prompt: "Bericht",
    status: "needs_input",
    pending_question: "Welche Variante?",
    pending_options: [{ label: "A", value: "a" }],
  });
  /** Erinnerungen alter Aufträge (task-reminders.ts) über den Meldeweg aus createBotNotices, wie src/bot.ts */
  function reminders(h: ReturnType<typeof harness>, tasks: AsyncTask[], direct: string[]) {
    const updated: string[] = [];
    const run = createTaskReminders({
      ...h.notices.taskReminders({ refresh: async () => [] }),
      directChatIds: () => direct,
      tasks: () =>
        ({
          stale: async () => tasks,
          update: async (taskId: string) => (updated.push(taskId), true),
          byId: async () => null,
        }) as any,
      isQuiet: () => false,
      log: () => {},
    });
    return { updated, remind: () => run.remindLegacy() };
  }

  test("mit Telegram: Knöpfe in Telegram wie bisher, Text einmal festgehalten, fremde Chats übersprungen", async () => {
    const h = harness({ telegram: true });
    const r = reminders(h, [task(USER), task("999")], [USER]);
    expect(await r.remind()).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].body.chat_id).toBe(USER);
    expect(h.calls[0].body.reply_markup.inline_keyboard).toEqual([
      [{ text: "A", callback_data: `atask:t-${USER}:a` }],
      [{ text: TASK_REMINDER_TEXT.cancelLabel, callback_data: `atask:t-${USER}:cancel` }],
    ]);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0].content).toBe(TASK_REMINDER_TEXT.legacy("Welche Variante?"));
    expect(r.updated).toEqual([`t-${USER}`]);
  });

  test("ohne Telegram: im Web-Direktchat, auch für übrig gebliebene Aufgaben der alten Nutzer-ID", async () => {
    const h = harness({ telegram: false });
    const r = reminders(h, [task(USER), task("web")], [USER, "web"]);
    expect(await r.remind()).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.recorded.map(m => m.chat_id)).toEqual(["web", "web"]);
    expect(r.updated).toEqual([`t-${USER}`, "t-web"]);
  });

  test("Speicherfehler ohne Telegram: nicht als erinnert markiert, nächster Durchlauf versucht es wieder", async () => {
    const h = harness({ telegram: false, recordOk: false });
    const r = reminders(h, [task("web")], ["web"]);
    expect(await r.remind()).toBe(0);
    expect(r.updated).toEqual([]);
  });
});

describe("Goal-Status", () => {
  const target: GoalTarget = { sessionKey: `topic:${GROUP}:7`, chatId: GROUP, topicId: 7, agentName: "general", goal: "Katzen", createdAt: "2026-09-29T08:00:00.000Z" };

  test("mit Telegram: Pause einmal gesendet und genau einmal festgehalten, Zwischenstand nur in Telegram", async () => {
    const h = harness({ telegram: true });
    const status = h.notices.goalStatus({});
    await status(target, { kind: "paused", text: "⏸️ Ziel pausiert" } as any);
    await status(target, { kind: "turn", text: "🎯 Ziel-Turn 1/5" });
    expect(h.calls.map(c => c.body.text)).toEqual(["⏸️ Ziel pausiert", "🎯 Ziel-Turn 1/5"]);
    expect(h.calls[0].body).toMatchObject({ chat_id: GROUP, message_thread_id: 7 });
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ chat_id: GROUP, content: "⏸️ Ziel pausiert", metadata: { source: GOAL_NOTICE_SOURCE, topicId: 7 } });
  });

  test("mit Telegram: Knöpfe am Telegram-Text", async () => {
    const h = harness({ telegram: true });
    const status = h.notices.goalStatus({});
    await status(target, { kind: "waiting", text: "Wartet", buttons: [[{ label: "Weiter", action: "goalkb|more|x" }]] } as any);
    expect(h.calls[0].body.reply_markup).toEqual({ inline_keyboard: [[{ text: "Weiter", callback_data: "goalkb|more|x" }]] });
    expect(h.recorded).toHaveLength(1);
  });

  test("ohne Telegram: nur im Web-Direktchat, Zwischenstand gar nicht", async () => {
    const h = harness({ telegram: false });
    const web: GoalTarget = { ...target, sessionKey: "dm:web", chatId: "web", topicId: undefined };
    const status = h.notices.goalStatus({});
    await status(web, { kind: "done", text: "✅ Ziel erreicht" } as any);
    await status(web, { kind: "turn", text: "🎯 Ziel-Turn 1/5" });
    expect(h.calls).toEqual([]);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ chat_id: "web", content: "✅ Ziel erreicht", metadata: { source: GOAL_NOTICE_SOURCE } });
  });
});

describe("Rückfall und Grenzen", () => {
  test("mit Telegram: Ziel, das die Outbox ablehnt, geht wie bisher direkt über den Haupt-Bot", async () => {
    const h = harness({ telegram: true });
    expect(await h.notify("Neustart", { chatId: "-100999" })).toBe(true);
    expect(h.calls).toEqual([]);
    expect(h.recorded).toEqual([]);
    expect(h.direct).toEqual([["-100999", "Neustart", undefined, undefined]]);
  });

  test("Web-Ziele auch mit Telegram nur in der WebUI", async () => {
    const h = harness({ telegram: true });
    const web = "web:0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a4b";
    expect(await h.notify("Web", { chatId: web })).toBe(true);
    expect(h.calls).toEqual([]);
    expect(h.recorded[0].chat_id).toBe(web);
  });

  test("Fehler werden nicht geworfen", async () => {
    const notify = createUserNotifier({
      telegram: () => false,
      send: async () => {
        throw new Error("kaputt");
      },
      log: () => {},
    });
    expect(await notify("x")).toBe(false);
  });
});

describe("Zustellung mit Ergebnis (Issue #322)", () => {
  function delivery(reply: () => Response, telegram = true, recordOk = true) {
    const calls: Record<string, any>[] = [];
    const recorded: Message[] = [];
    const deps: OutboxDeps = {
      botToken: telegram ? "123:t" : "",
      userId: telegram ? USER : "",
      groupId: GROUP,
      outboxDir: "/nicht/benutzt",
      fetch: async (_url, init) => (calls.push(JSON.parse(String(init.body))), reply()),
      record: async m => (recordOk ? (recorded.push(m), true) : false),
      log: () => {},
      newId: () => crypto.randomUUID(),
    };
    const deliver = createUserDelivery({ telegram: () => telegram, send: input => sendAndRecord(input, deps), log: () => {} });
    return { deliver, calls, recorded };
  }
  const ok = () => Response.json({ ok: true, result: { message_id: 9 } });
  const buttons = [[{ text: "Erledigt", callback_data: "ch|abc|done" }]];

  test("mit Telegram: Knöpfe an der Nachricht, choiceId im Eintrag, Nachricht zurück", async () => {
    const d = delivery(ok);
    expect(await d.deliver("x", { chatId: GROUP, topicId: 3, choiceId: "abc", buttons })).toEqual({ delivered: true, outcome: "delivered", telegram: [{ chatId: GROUP, messageId: 9 }] });
    expect(d.calls[0].reply_markup).toEqual({ inline_keyboard: buttons });
    expect(d.recorded[0].metadata).toMatchObject({ choiceId: "abc", topicId: 3 });
  });

  test("ohne Telegram: choiceId im Web-Direktchat, keine Knöpfe an Telegram", async () => {
    const d = delivery(ok, false);
    expect(await d.deliver("x", { chatId: USER, choiceId: "abc", buttons })).toEqual({ delivered: true, outcome: "delivered", telegram: [] });
    expect(d.calls).toEqual([]);
    expect(d.recorded[0]).toMatchObject({ chat_id: "web", metadata: { choiceId: "abc" } });
  });

  test("abgelehnt, unklar, Teilerfolg", async () => {
    expect((await delivery(() => Response.json({ ok: false, description: "Bad Request" }, { status: 400 })).deliver("x")).outcome).toBe("rejected");
    expect((await delivery(() => Response.json({ ok: false }, { status: 502 })).deliver("x")).outcome).toBe("unclear");
    expect(await delivery(ok, true, false).deliver("x")).toMatchObject({ delivered: true, outcome: "delivered" });
    expect(await delivery(ok, false, false).deliver("x")).toEqual({ delivered: false, outcome: "unclear", telegram: [] });
    const throwing = createUserDelivery({ telegram: () => true, send: async () => { throw new Error("weg"); }, log: () => {} });
    expect(await throwing("x")).toEqual({ delivered: false, outcome: "unclear", telegram: [] });
  });

  test("Rückfall: sicher abgelehnt bleibt rejected, jeder andere Fehler unclear; notifyUser liefert false", async () => {
    const invalid = async () => ({ sent: false, recorded: false, error: { kind: "invalid", message: "unbekanntes Ziel" } }) as any;
    for (const [error, outcome] of [[new TelegramRejectedError("403"), "rejected"], [new Error("Netz"), "unclear"]] as const) {
      const deps = {
        telegram: () => true,
        send: invalid,
        sendTelegram: async () => {
          throw error;
        },
        log: () => {},
      };
      expect(await createUserDelivery(deps)("x", { chatId: "-100999" })).toEqual({ delivered: false, outcome, telegram: [] });
      expect(await createUserNotifier(deps)("x", { chatId: "-100999" })).toBe(false);
    }
  });
});

describe("Verdrahtung für src/bot.ts (createBotNotices)", () => {
  test("Meldung, Zustellung mit Ergebnis, Neustart, Aufgaben und Goal-Status nehmen denselben Weg über die Outbox", async () => {
    const h = harness({ telegram: true });
    expect(await h.notices.notifyUser("a")).toBe(true);
    expect(await h.notices.deliverToUser("b", { chatId: GROUP, topicId: 3 })).toEqual({ delivered: true, outcome: "delivered", telegram: [] });
    await h.notices.restart("c", GROUP, 7);
    h.notices.plain("d");
    await Bun.sleep(20);
    expect(await h.notices.taskReminders({ refresh: async () => [] }).notifyLegacy("e", { chatId: USER, buttons: [] })).toBe(true);
    await h.notices.goalStatus({})({ sessionKey: "dm:4711", chatId: USER, agentName: "general", goal: "x", createdAt: "2026-09-29T08:00:00.000Z" }, { kind: "done", text: "f" } as any);
    expect(h.sends()).toBe(6);
    expect(h.calls.map(c => c.body.text)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(h.recorded.map(m => m.content)).toEqual(["a", "b", "c", "d", "e", "f"]);
    expect(h.direct).toEqual([]);
  });

  test("Rückfall über den Haupt-Bot: Knöpfe als inline_keyboard, auch für die Zustellung mit Ergebnis", async () => {
    const h = harness({ telegram: true });
    const buttons = [[{ text: "Erledigt", callback_data: "ch|abc|done" }]];
    expect(await h.notices.deliverToUser("x", { chatId: "-100999", topicId: 4, buttons })).toMatchObject({ delivered: true, outcome: "delivered" });
    expect(h.direct).toEqual([["-100999", "x", 4, { inline_keyboard: buttons }]]);
    expect(h.calls).toEqual([]);
  });

  test("ohne Telegram: kein Weg erreicht api.telegram.org", async () => {
    const h = harness({ telegram: false });
    await h.notices.notifyUser("a", { chatId: USER });
    await h.notices.deliverToUser("b", { chatId: GROUP, topicId: 2 });
    await h.notices.restart("c", GROUP, 7);
    h.notices.plain("d");
    await Bun.sleep(20);
    await h.notices.goalStatus({})({ sessionKey: "dm:web", chatId: "web", agentName: "general", goal: "x", createdAt: "2026-09-29T08:00:00.000Z" }, { kind: "turn", text: "nur Telegram" } as any);
    expect(h.calls).toEqual([]);
    expect(h.direct).toEqual([]);
    expect(h.recorded.map(m => [m.chat_id, m.content])).toEqual([["web", "a"], ["web", "b"], ["web", "c"], ["web", "d"]]);
  });
});
