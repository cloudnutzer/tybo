/**
 * Issue #337, Checkbox 1: /tasks in der gemeinsamen Befehls-Schicht, in
 * Telegram, Browser und Terminal. Belegt: Leerzustand, nur laufende, nur
 * wartende (alter Auftrag und Rückfrage des Registers), gemischt;
 * Gesprächsbezug für Direktchat (Telegram-Nutzer-ID und "web" als ein
 * Gespräch), Topic, General und reines Web-Gespräch, Aufträge anderer
 * Gespräche erscheinen nicht; „tasks" ohne Schrägstrich nur in Telegram;
 * kein Auftragstext im Log. Auftragsspeicher als Attrappe, feste Uhr.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { commandRegistry, HELP_TEXT } from "../src/lib/commands/builtin";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import { formatTaskList, TASKS_TEXT } from "../src/lib/commands/tasks";
import type { CommandServices } from "../src/lib/commands/types";
import type { AsyncTask, TaskStatus } from "../src/lib/store/types";
import { directChatIds, samePlace } from "../src/lib/task-place";
import { createBotCommands } from "../src/web/bot-commands";

const NOW = Date.parse("2026-10-20T10:00:00.000Z");
const MIN = 60_000;
const USER = "4711";
const GROUP = "-1001234567890";
const WEB_ID = "0c1a2b3c-0000-4000-8000-000000000000";

let rows: AsyncTask[];
let n = 0;
function add(chat_id: string, status: TaskStatus, patch: Partial<AsyncTask> = {}): AsyncTask {
  const task: AsyncTask = {
    id: `task-${++n}`,
    created_at: new Date(NOW - 30 * MIN).toISOString(),
    updated_at: new Date(NOW).toISOString(),
    chat_id,
    original_prompt: `Auftrag ${n}`,
    status,
    ...patch,
  };
  rows.push(task);
  return task;
}

/** Wie TaskStore: nur nach chat_id gefiltert, ohne Topic */
const services = (): Partial<CommandServices> => ({
  tasks: () => ({
    pending: async chatId => rows.filter(t => t.chat_id === chatId && t.status === "needs_input"),
    running: async chatId => rows.filter(t => t.chat_id === chatId && t.status === "running"),
  }),
  directChatIds: () => [USER, "web"],
});

async function telegram(text: string, where: { chatId: string; topicId?: number } = { chatId: USER }, svc = services()): Promise<string[] | null> {
  const match = commandRegistry.match(text, "telegram");
  if (!match) return null;
  const sent: string[] = [];
  await runTelegramCommand({
    chat: { reply: async t => void sent.push(t) },
    chatId: where.chatId,
    ...(where.topicId !== undefined ? { topicId: where.topicId } : {}),
    sessionKey: "egal",
    agent: "general",
    text,
    match,
    services: svc as CommandServices,
    working: () => () => {},
    resetSession: async () => ({ status: "unavailable" }),
    agentTurn: async () => {},
    boardMeeting: async () => {},
  });
  return sent;
}

/** Browser bzw. Terminal; userId wie in src/bot.ts der Direktchat (mit Telegram die Nutzer-ID) */
async function webOrTerminal(source: "web" | "terminal", text: string, conversationId: string, userId = USER): Promise<string[]> {
  const unused = () => {
    throw new Error("nicht erwartet");
  };
  const notices: string[] = [];
  const commands = createBotCommands({
    registry: commandRegistry,
    services: services() as CommandServices,
    userId,
    groupId: () => GROUP,
    agentForTopic: () => "research",
    sendPlain: async () => {},
    // In mit Telegram gespiegelten Gesprächen geht die Antwort über die Outbox
    sendAndRecord: async input => (notices.push(input.text ?? ""), { sent: true, recorded: true }) as any,
    saveMessage: async () => true,
    resetConversation: unused,
    runStreamingTurn: unused,
    processIntents: unused,
    sendAsAgent: async () => {},
    log: () => {},
  });
  await commands.run({
    conversationId,
    agent: "general",
    text,
    source,
    messageId: "m1",
    receivedAt: new Date().toISOString(),
    signal: new AbortController().signal,
    sink: {} as any,
    notice: async t => void notices.push(t),
    answer: async () => {},
    ask: async () => {},
    endAsk: () => {},
    commit: () => {},
  });
  return notices;
}

let logSpy: ReturnType<typeof spyOn>;
let logged: string[];
beforeEach(() => {
  setSystemTime(new Date(NOW));
  rows = [];
  logged = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => void logged.push(args.join(" ")));
});
afterEach(() => {
  setSystemTime();
  logSpy.mockRestore();
});

describe("/tasks im Register", () => {
  test("alle drei Kanäle, ohne Argumente; auch während einer Antwort", () => {
    for (const channel of ["telegram", "web", "terminal"] as const) {
      expect(commandRegistry.match("/tasks", channel)?.command.name).toBe("tasks");
      expect(commandRegistry.match("/TASKS", channel)?.command.name).toBe("tasks");
      // Mit Text dahinter kein Befehl: geht wie bisher als Text an das Modell
      expect(commandRegistry.match("/tasks bitte", channel)).toBeNull();
    }
    expect(commandRegistry.get("tasks")?.whileBusy).toBe(true);
  });

  test("„tasks“ ohne Schrägstrich nur in Telegram", () => {
    expect(commandRegistry.match("tasks", "telegram")?.command.name).toBe("tasks");
    expect(commandRegistry.match("Tasks", "telegram")?.command.name).toBe("tasks");
    expect(commandRegistry.match("tasks", "web")).toBeNull();
    expect(commandRegistry.match("tasks", "terminal")).toBeNull();
  });

  test("/help nennt /tasks", () => {
    expect(HELP_TEXT).toContain("/tasks");
  });
});

describe("Liste", () => {
  test("Leerzustand: ein deutscher Satz", async () => {
    expect(await telegram("/tasks")).toEqual([TASKS_TEXT.empty]);
  });

  test("nur laufende: Anfang des Auftrags mit Alter in Minuten", async () => {
    add(USER, "running", { original_prompt: "Schreib den Wochenbericht", created_at: new Date(NOW - 12 * MIN).toISOString() });
    expect(await telegram("/tasks")).toEqual([`${TASKS_TEXT.running}\n- Schreib den Wochenbericht (seit 12 Min.)`]);
  });

  test("nur wartende: alter Auftrag mit Fragetext, ohne Frage der Anfang, Register-Rückfrage mit Hinweis auf die Knöpfe", async () => {
    add(USER, "needs_input", { pending_question: "Welcher Tag?" });
    add(USER, "needs_input", { original_prompt: "Plane die Woche" });
    add(USER, "needs_input", { pending_question: "Soll ich verschicken?", metadata: { ask_id: "a1b2c3d4e5f6" } });
    expect(await telegram("/tasks")).toEqual([
      `${TASKS_TEXT.waiting}\n- Welcher Tag?\n- Plane die Woche\n- Soll ich verschicken? (${TASKS_TEXT.buttonsAtQuestion})`,
    ]);
  });

  test("gemischt: erst laufende, dann wartende; lange Texte gekürzt, auf eine Zeile", async () => {
    add(USER, "needs_input", { pending_question: "Welcher\nTag?" });
    add(USER, "running", { original_prompt: `${"x".repeat(100)}`, created_at: new Date(NOW - 61 * MIN).toISOString() });
    const [text] = (await telegram("/tasks"))!;
    expect(text).toBe(`${TASKS_TEXT.running}\n- ${"x".repeat(79)}… (seit 61 Min.)\n\n${TASKS_TEXT.waiting}\n- Welcher Tag?`);
  });

  test("erledigte und gescheiterte Aufträge erscheinen nicht", () => {
    expect(formatTaskList([], [], NOW)).toBe(TASKS_TEXT.empty);
  });

  test("Speicher nicht lesbar: Hinweis statt Liste, kein Auftragstext im Log", async () => {
    add(USER, "running", { original_prompt: "Geheimer Auftrag" });
    const broken: Partial<CommandServices> = {
      ...services(),
      tasks: () => ({
        pending: async () => {
          throw new Error("Geheimer Auftrag");
        },
        running: async () => [],
      }),
    };
    expect(await telegram("/tasks", { chatId: USER }, broken)).toEqual([TASKS_TEXT.unreadable]);
    expect(logged.join("\n")).not.toContain("Geheimer");
  });

  test("kein Auftragstext im Log", async () => {
    add(USER, "running", { original_prompt: "Geheimer Auftrag" });
    await telegram("/tasks");
    await webOrTerminal("web", "/tasks", "dm");
    expect(logged.join("\n")).not.toContain("Geheimer");
  });
});

describe("Gesprächsbezug", () => {
  function seed() {
    add(USER, "running", { original_prompt: "DM über Telegram" });
    add("web", "needs_input", { pending_question: "DM über Web?" });
    add(USER, "running", { original_prompt: "Nutzer-ID mit Thread", thread_id: 9 });
    add(GROUP, "running", { original_prompt: "Topic 443", thread_id: 443 });
    add(GROUP, "running", { original_prompt: "Topic 500", thread_id: 500 });
    add(GROUP, "running", { original_prompt: "General" });
    add(`web:${WEB_ID}`, "needs_input", { pending_question: "Web-Gespräch?" });
    add("999", "running", { original_prompt: "Fremder Chat" });
  }
  const lines = (texts: string[] | null) => (texts ?? []).join("\n").split("\n").filter(l => l.startsWith("- ")).map(l => l.replace(/ \(.*\)$/, ""));

  test("Direktchat: Telegram-Nutzer-ID und \"web\" sind ein Gespräch, in allen Kanälen", async () => {
    seed();
    const expected = ["- DM über Telegram", "- DM über Web?"];
    expect(lines(await telegram("/tasks", { chatId: USER }))).toEqual(expected);
    expect(lines(await webOrTerminal("web", "/tasks", "dm"))).toEqual(expected);
    expect(lines(await webOrTerminal("terminal", "/tasks", "dm"))).toEqual(expected);
    // Ohne Telegram ist der Direktchat "web": dieselben Aufträge, auch die unter der alten Nutzer-ID
    expect(lines(await webOrTerminal("web", "/tasks", "dm", "web"))).toEqual(expected);
  });

  test("Topic: nur Aufträge mit dieser thread_id, in allen Kanälen", async () => {
    seed();
    expect(lines(await telegram("/tasks", { chatId: GROUP, topicId: 443 }))).toEqual(["- Topic 443"]);
    expect(lines(await webOrTerminal("web", "/tasks", "topic-443"))).toEqual(["- Topic 443"]);
    expect(lines(await webOrTerminal("terminal", "/tasks", "topic-500"))).toEqual(["- Topic 500"]);
  });

  test("General: Aufträge der Gruppe ohne thread_id", async () => {
    seed();
    expect(lines(await telegram("/tasks", { chatId: GROUP }))).toEqual(["- General"]);
    expect(lines(await webOrTerminal("web", "/tasks", "topic-1"))).toEqual(["- General"]);
  });

  test("reines Web-Gespräch: nur web:<id>", async () => {
    seed();
    expect(lines(await webOrTerminal("web", "/tasks", WEB_ID))).toEqual(["- Web-Gespräch?"]);
    expect(lines(await webOrTerminal("terminal", "/tasks", WEB_ID))).toEqual(["- Web-Gespräch?"]);
  });

  test("Bausteine: Direktchat-Kennungen aus der Umgebung, Topic des Direktchats ist kein Direktchat", () => {
    expect(directChatIds({ TELEGRAM_USER_ID: " 4711 " })).toEqual([USER, "web"]);
    expect(directChatIds({ TELEGRAM_USER_ID: "abc" })).toEqual(["web"]);
    expect(directChatIds({})).toEqual(["web"]);
    const dm = [USER, "web"];
    expect(samePlace({ chatId: USER }, { chatId: "web" }, dm)).toBe(true);
    expect(samePlace({ chatId: USER, threadId: 9 }, { chatId: "web" }, dm)).toBe(false);
    expect(samePlace({ chatId: GROUP }, { chatId: GROUP, threadId: 1 }, dm)).toBe(false);
    expect(samePlace({ chatId: `web:${WEB_ID}` }, { chatId: "web" }, dm)).toBe(false);
  });
});
