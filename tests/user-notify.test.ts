/**
 * Issue #227, Prüfer-Runde 1: gemeinsamer Meldeweg für bot-interne Meldungen
 * (src/lib/user-notify.ts). Neustart, Credit-Guard, Erinnerungen an
 * liegengebliebene Aufgaben und Goal-Status gehen über die echte Outbox
 * (sendAndRecord) mit Attrappen für fetch und Nachrichtenspeicher: mit
 * Telegram genau ein Versand und genau ein Eintrag, ohne Telegram nur der
 * Eintrag für die WebUI und nie ein Aufruf an api.telegram.org; scheitert
 * das Festhalten, gilt die Meldung als nicht zugestellt. src/bot.ts wird nie
 * geladen, nur als Text auf die Verdrahtung geprüft.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import type { AsyncTask } from "../src/lib/convex";
import { createTelegramGoalStatus, GOAL_NOTICE_SOURCE } from "../src/lib/goal-actions";
import type { GoalTarget } from "../src/lib/goal-engine";
import { sendAndRecord, type OutboxDeps } from "../src/lib/outbox";
import { createRestartControl, RESTART_TEXT } from "../src/lib/restart-control";
import type { Message } from "../src/lib/supabase";
import { checkStaleTasks } from "../src/lib/task-queue";
import { createUserNotifier, SYSTEM_NOTICE_SOURCE } from "../src/lib/user-notify";

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
  const notify = createUserNotifier({
    telegram: () => options.telegram,
    send: input => sendAndRecord(input, deps),
    sendTelegram: async (...args) => void direct.push(args),
    dmChatId: () => USER,
    log: () => {},
  });
  return { notify, calls, recorded, direct };
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
    expect(await restart(async (text, chatId, topicId) => void (await h.notify(text, { chatId, topicId }))).maybeRestart("test")).toBe("restarting");
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].method).toBe("sendMessage");
    expect(h.calls[0].body.chat_id).toBe(USER);
    expect(h.calls[0].body.parse_mode).toBe("HTML");
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ chat_id: USER, content: RESTART_TEXT.restarting("WebUI"), metadata: { source: SYSTEM_NOTICE_SOURCE } });
  });

  test("aus einem Topic: an das Topic der Forum-Gruppe, festgehalten mit topicId", async () => {
    const h = harness({ telegram: true });
    await restart(async (text, chatId, topicId) => void (await h.notify(text, { chatId, topicId }))).maybeRestart("test", GROUP, 7);
    expect(h.calls[0].body).toMatchObject({ chat_id: GROUP, message_thread_id: 7 });
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ chat_id: GROUP, metadata: { topicId: 7 } });
  });

  test("ohne Telegram: nur im Web-Direktchat, kein Aufruf an api.telegram.org", async () => {
    const h = harness({ telegram: false });
    await restart(async (text, chatId, topicId) => void (await h.notify(text, { chatId, topicId }))).maybeRestart("test", GROUP, 7);
    expect(h.calls).toEqual([]);
    expect(h.direct).toEqual([]);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ chat_id: "web", content: RESTART_TEXT.restarting("WebUI"), metadata: { source: SYSTEM_NOTICE_SOURCE } });
  });
});

describe("Credit-Guard", () => {
  test("mit Telegram: Klartext ohne parse_mode wie bisher, einmal festgehalten", async () => {
    const h = harness({ telegram: true });
    expect(await h.notify("80 % verbraucht <Plan>", { format: "plain" })).toBe(true);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].body.parse_mode).toBeUndefined();
    expect(h.calls[0].body.text).toBe("80 % verbraucht <Plan>");
    expect(h.recorded.map(m => m.content)).toEqual(["80 % verbraucht <Plan>"]);
  });

  test("ohne Telegram: nur festgehalten", async () => {
    const h = harness({ telegram: false });
    expect(await h.notify("80 % verbraucht", { format: "plain" })).toBe(true);
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
  function store(tasks: AsyncTask[]) {
    const updated: string[] = [];
    return {
      updated,
      store: {
        getStaleTasks: async () => tasks,
        updateTask: async (taskId: string) => {
          updated.push(taskId);
          return true;
        },
      } as any,
    };
  }

  test("mit Telegram: Knöpfe in Telegram wie bisher, Text einmal festgehalten, fremde Chats übersprungen", async () => {
    const h = harness({ telegram: true });
    const s = store([task(USER), task("999")]);
    expect(await checkStaleTasks("123:t", [USER], undefined, { notify: h.notify, store: s.store })).toBe(1);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0].body.chat_id).toBe(USER);
    expect(h.calls[0].body.reply_markup.inline_keyboard).toEqual([
      [{ text: "A", callback_data: `atask:t-${USER}:a` }],
      [{ text: "Cancel task", callback_data: `atask:t-${USER}:cancel` }],
    ]);
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0].content).toContain("Welche Variante?");
    expect(s.updated).toEqual([`t-${USER}`]);
  });

  test("ohne Telegram: im Web-Direktchat, auch für übrig gebliebene Aufgaben der alten Nutzer-ID", async () => {
    const h = harness({ telegram: false });
    const s = store([task(USER), task("web")]);
    expect(await checkStaleTasks("", [USER, "web"], undefined, { notify: h.notify, store: s.store })).toBe(2);
    expect(h.calls).toEqual([]);
    expect(h.recorded.map(m => m.chat_id)).toEqual(["web", "web"]);
    expect(s.updated).toEqual([`t-${USER}`, "t-web"]);
  });

  test("Speicherfehler ohne Telegram: nicht als erinnert markiert, nächster Durchlauf versucht es wieder", async () => {
    const h = harness({ telegram: false, recordOk: false });
    const s = store([task("web")]);
    expect(await checkStaleTasks("", ["web"], undefined, { notify: h.notify, store: s.store })).toBe(0);
    expect(s.updated).toEqual([]);
  });
});

describe("Goal-Status", () => {
  const target: GoalTarget = { sessionKey: `topic:${GROUP}:7`, chatId: GROUP, topicId: 7, agentName: "general", goal: "Katzen", createdAt: "2026-09-29T08:00:00.000Z" };

  test("mit Telegram: Pause einmal gesendet und genau einmal festgehalten, Zwischenstand nur in Telegram", async () => {
    const h = harness({ telegram: true });
    const status = createTelegramGoalStatus({ notify: h.notify });
    await status(target, { kind: "paused", text: "⏸️ Ziel pausiert" } as any);
    await status(target, { kind: "turn", text: "🎯 Ziel-Turn 1/5" });
    expect(h.calls.map(c => c.body.text)).toEqual(["⏸️ Ziel pausiert", "🎯 Ziel-Turn 1/5"]);
    expect(h.calls[0].body).toMatchObject({ chat_id: GROUP, message_thread_id: 7 });
    expect(h.recorded).toHaveLength(1);
    expect(h.recorded[0]).toMatchObject({ chat_id: GROUP, content: "⏸️ Ziel pausiert", metadata: { source: GOAL_NOTICE_SOURCE, topicId: 7 } });
  });

  test("mit Telegram: Knöpfe am Telegram-Text", async () => {
    const h = harness({ telegram: true });
    const status = createTelegramGoalStatus({ notify: h.notify });
    await status(target, { kind: "waiting", text: "Wartet", buttons: [[{ label: "Weiter", action: "goalkb|more|x" }]] } as any);
    expect(h.calls[0].body.reply_markup).toEqual({ inline_keyboard: [[{ text: "Weiter", callback_data: "goalkb|more|x" }]] });
    expect(h.recorded).toHaveLength(1);
  });

  test("ohne Telegram: nur im Web-Direktchat, Zwischenstand gar nicht", async () => {
    const h = harness({ telegram: false });
    const web: GoalTarget = { ...target, sessionKey: "dm:web", chatId: "web", topicId: undefined };
    const status = createTelegramGoalStatus({ notify: h.notify });
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

describe("Verdrahtung in src/bot.ts (nur als Text)", () => {
  const bot = readFileSync(join(import.meta.dir, "..", "src", "bot.ts"), "utf-8");

  test("Neustart, Credit-Guard, Aufgaben-Erinnerung und Goal-Status nutzen notifyUser", () => {
    expect(bot).toMatch(/const notifyUser = createUserNotifier\(\{[\s\S]*?send: \(input\) => sendAndRecord\(input\)/);
    expect(bot).toMatch(/creditGuard\.setNotifier\(\(msg\) => void notifyUser\(msg, \{ format: "plain" \}\)\)/);
    expect(bot).toMatch(/const restartControl = createRestartControl\(\{[\s\S]*?await notifyUser\(text, \{ chatId, topicId \}\)/);
    expect(bot).toMatch(/checkStaleTasks\([^)]*\{\s*notify: \(text, target\) => notifyUser\(text, target\)/);
    expect(bot).toMatch(/sendStatus: createTelegramGoalStatus\(\{[\s\S]*?notify: notifyUser,/);
    // Kein zweites Festhalten neben dem gemeinsamen Weg
    expect(bot).not.toMatch(/sendStatus: createTelegramGoalStatus\(\{[^}]*record:/);
    expect(bot).not.toContain("bot.api.sendMessage(process.env.TELEGRAM_USER_ID");
  });
});
