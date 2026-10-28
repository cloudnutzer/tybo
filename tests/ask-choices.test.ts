/**
 * Rückfragen des Modells als Art "ask" im Rückfragen-Register (Issue #335):
 * Auftrag zuerst gespeichert, dann entscheidbar; ein Klick in Telegram, im
 * Browser oder im Terminal setzt genau einmal fort, über Session, Motor und
 * Modell der Frage. Echtes Register (Datei im Temp-Verzeichnis), echte
 * Telegram-Seite mit Api- und Sende-Attrappe, echter Rückfrage-Port der
 * WebUI, echtes resumeMacTask mit echter Sperre; Auftragsspeicher und Motor
 * sind Attrappen. Wie in src/bot.ts verdrahtet, src/bot.ts wird nie geladen.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Bot, Composer, Context, GrammyError } from "grammy";
import { createChoice, getChoice, listChoices, onChoiceDecided, setChoicesFileForTests, type Choice, type ChoiceConversation } from "../src/lib/choices";
import {
  ASK_CANCEL,
  ASK_TEXT,
  askRef,
  claimLegacyTaskCallback,
  clickChannel,
  createAskChoices,
  createAskDeliver,
  createAskOffer,
  installAskOffer,
  isRegisterAskCallback,
  offerAsk,
  parseAskRef,
  type AskChoicesDeps,
  type AskOffer,
  type AskOfferOutcome,
} from "../src/lib/ask-choices";
import { formatChannelRules } from "../src/agents/prompt-parts";
import type { EngineId, EngineRequest, EngineResult } from "../src/lib/engines";
import { isWebChatId, WEB_DM_CHAT_ID } from "../src/lib/channels";
import { runExecution } from "../src/lib/execution-context";
import type { SendAndRecordInput } from "../src/lib/outbox";
import type { WebPost } from "../src/lib/review-choices";
import { getStore } from "../src/lib/store";
import type { TaskStore } from "../src/lib/store/ports";
import type { AsyncTask, TaskChanges } from "../src/lib/store/types";
import { resumeMacTask, type TaskResumeDeps, taskResumePrompt } from "../src/lib/task-resume";
import { createTaskReminders } from "../src/lib/task-reminders";
import { TELEGRAM_FORMAT_RULES } from "../src/lib/telegram";
import { claimLegacyTaskButton, LEGACY_TASK_TEXT } from "../src/lib/legacy-task-buttons";
import { createTelegramChoices, installTelegramChoices } from "../src/lib/telegram-choices";
import { createTelegramRuntime, type AgentBots } from "../src/lib/telegram-runtime";
import { testChoices, type TestChoices } from "./choices-fixture";
import { FAKE_SUPABASE_URL, useFakeSupabase } from "./supabase-fixture";

const OWNER = "4711";
const GROUP = "-1001234567890";
const WEB = "0b8f2a3c-1d2e-4f50-8a6b-7c8d9e0f1a2b";
const dir = mkdtempSync(join(tmpdir(), "tybo-ask-choices-"));

// ---------------------------------------------------------------------------
// Attrappen
// ---------------------------------------------------------------------------

/** Auftragsspeicher im Speicher, mit Fehlerschaltern wie TaskStore (null bzw. false) */
function memoryTasks() {
  const rows = new Map<string, AsyncTask>();
  const sw = { create: true, update: (_c: TaskChanges) => true };
  let next = 0;
  const store = {
    async create(chatId: string, originalPrompt: string, threadId?: number) {
      if (!sw.create) return null;
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
      if (!row || !sw.update(changes)) return false;
      // Wie Supabase: undefined löscht kein Feld
      for (const [k, v] of Object.entries(changes)) if (v !== undefined) (row as any)[k] = structuredClone(v);
      return true;
    },
    async byId(taskId: string) {
      const row = rows.get(taskId);
      return row ? structuredClone(row) : null;
    },
  } as unknown as TaskStore;
  return { store, rows, sw };
}

let tasks: ReturnType<typeof memoryTasks>;
let runs: (EngineRequest & { engine: EngineId })[];
let engineReply: (req: EngineRequest, engine: EngineId) => Promise<EngineResult>;
let sends: SendAndRecordInput[];
let notices: { conversation: ChoiceConversation; text: string }[];
let delivered: { conversation: ChoiceConversation; text: string }[];
let saved: any[];
let intents: { text: string; target: unknown }[];
let webPosts: { conversationId: string; post: WebPost }[];
let calls: { method: string; args: unknown[] }[];
let messageId = 100;
let telegramOn = true;
/** Fehlerschalter beim Abschluss: Speichern, Zeigen, Meldeweg */
let saveResult: boolean | "throw";
let deliverResult: boolean | "throw";
let notifyOk: boolean;
/** Statt der Attrappe der echte Zustellweg (createAskDeliver) */
let realDeliver: AskChoicesDeps["deliver"] | null;
let composer: Composer<Context>;
let port: TestChoices;
let offer: (o: AskOffer) => Promise<AskOfferOutcome>;
let cleanup: (() => void)[] = [];
let logSpy: ReturnType<typeof spyOn>;
let n = 0;

const fakeApi = {
  answerCallbackQuery: async (...args: unknown[]) => void calls.push({ method: "answerCallbackQuery", args }),
  editMessageText: async (...args: unknown[]) => void calls.push({ method: "editMessageText", args }),
  editMessageReplyMarkup: async (...args: unknown[]) => void calls.push({ method: "editMessageReplyMarkup", args }),
};

/** Echtes resumeMacTask mit echter Sperre; Motor und Session-Speicher als Attrappe */
const resumeDeps: Partial<TaskResumeDeps> = {
  runExecution,
  isSessionModeEnabled: () => false,
  getResumableSession: async () => undefined,
  sessionEpoch: () => 0,
  finalizeClaudeSession: async () => true,
  getEngine: ((id: EngineId) => ({
    id,
    describe: () => id,
    run: async (req: EngineRequest) => {
      runs.push({ ...req, engine: id });
      return engineReply(req, id);
    },
  })) as unknown as TaskResumeDeps["getEngine"],
  // Modell, das der Agent heute hätte: darf eine gespeicherte Angabe nie ersetzen
  resolveModel: () => "modell-von-heute",
  resolveEffort: () => undefined,
  allowedTools: () => undefined,
  cwd: dir,
};

beforeEach(() => {
  port = testChoices(join(dir, `choices-${++n}.json`), { userId: OWNER, groupId: GROUP });
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  tasks = memoryTasks();
  runs = [];
  sends = [];
  notices = [];
  delivered = [];
  saved = [];
  intents = [];
  webPosts = [];
  calls = [];
  cleanup = [];
  telegramOn = true;
  saveResult = true;
  deliverResult = true;
  notifyOk = true;
  realDeliver = null;
  engineReply = async (req, engine) => ({ engine, text: "Erledigt, Bericht liegt bereit.", sessionId: req.resumeSessionId, isError: false });

  const telegram = createTelegramChoices({
    api: fakeApi,
    owner: OWNER,
    telegram: () => telegramOn,
    send: async input => {
      sends.push(input);
      return { sent: true, recorded: true, messages: [{ chatId: input.chatId ?? OWNER, messageId: ++messageId, part: "text", buttons: true }] } as any;
    },
    log: () => {},
  });
  composer = new Composer<Context>();
  cleanup.push(installTelegramChoices(composer, telegram));

  // Wie in src/bot.ts: Zustellweg eingerichtet, Aufrufer nutzen offerAsk
  cleanup.push(
    installAskOffer(
      createAskOffer({
        sendChoice: choice => (telegramOn ? telegram.sendChoice(choice) : Promise.resolve({ sent: false })),
        postWeb: async (conversationId, post) => (webPosts.push({ conversationId, post }), true),
        tasks: () => tasks.store,
        log: () => {},
      })
    )
  );
  offer = offerAsk;
  const ask = createAskChoices({
    notify: async (conversation, text) => {
      if (!notifyOk) throw new Error("nicht zugestellt");
      notices.push({ conversation, text });
    },
    // Wie src/bot.ts: Web-Direktchat ohne Telegram zeigt nur den gespeicherten Verlauf
    deliver: async (conversation, text, wasSaved) => {
      if (realDeliver) return realDeliver(conversation, text, wasSaved);
      if (deliverResult === "throw") throw new Error("Telegram nicht erreichbar");
      if (conversation.type === "telegram" && isWebChatId(conversation.chatId)) return wasSaved;
      if (deliverResult) delivered.push({ conversation, text });
      return deliverResult;
    },
    saveMessage: async message => {
      if (saveResult === "throw") throw new Error("Speicher weg");
      if (saveResult) saved.push(message);
      return saveResult;
    },
    processIntents: async (text, _tools, target) => void intents.push({ text, target }),
    tasks: () => tasks.store,
    resume: (task, chatId, answer, channel) => resumeMacTask(task, chatId, answer, resumeDeps, channel),
    log: () => {},
  });
  cleanup.push(onChoiceDecided("ask", ask.handler));
});
afterEach(() => {
  for (const off of cleanup) off();
  logSpy.mockRestore();
});
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

const topicConv = (topicId = 443): ChoiceConversation => ({ type: "telegram", chatId: GROUP, topicId });
const webConv: ChoiceConversation = { type: "web", conversationId: WEB };

function input(patch: Partial<AskOffer> = {}): AskOffer {
  return {
    conversation: topicConv(),
    question: "Soll ich den Bericht jetzt verschicken?",
    options: ["Ja, verschicken", "Nein, erst zeigen"],
    originalPrompt: "Schreib den Wochenbericht",
    agent: "research",
    engine: "claude",
    model: "claude-modell-der-frage",
    sessionId: "sess-frage",
    ...patch,
  };
}

async function offered(patch: Partial<AskOffer> = {}): Promise<{ choice: Choice; taskId: string }> {
  const outcome = await offer(input(patch));
  if (outcome.status !== "offered") throw new Error(`nicht angeboten: ${outcome.status}`);
  return outcome;
}

/** Klick auf einen ch|-Knopf in Telegram, wie ihn grammy zustellt */
async function click(data: string, chatId = GROUP, msg = messageId) {
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

const state = async (id: string) => (await getChoice(id))?.state;
const task = (id: string) => tasks.rows.get(id)!;

// ---------------------------------------------------------------------------
// Anbieten
// ---------------------------------------------------------------------------

describe("offerAsk: erst gespeichert, dann entscheidbar", () => {
  test("Auftrag mit Gespräch, Session, Agent, Motor und Modell steht, bevor die Rückfrage im Register ist", async () => {
    let atCreate: AsyncTask | undefined;
    const offerSpy = createAskOffer({
      sendChoice: async () => ({ sent: true }),
      tasks: () => tasks.store,
      createChoice: async (i, o) => {
        atCreate = structuredClone(task(parseAskRef(i.ref)!.taskId));
        return createChoice(i, o);
      },
      log: () => {},
    });
    const outcome = await offerSpy(input());
    expect(outcome.status).toBe("offered");
    expect(atCreate).toMatchObject({
      chat_id: GROUP,
      thread_id: 443,
      original_prompt: "Schreib den Wochenbericht",
      status: "needs_input",
      session_id: "sess-frage",
      pending_question: "Soll ich den Bericht jetzt verschicken?",
      pending_options: [
        { label: "Ja, verschicken", value: "o0" },
        { label: "Nein, erst zeigen", value: "o1" },
      ],
      metadata: { agent_name: "research", engine: "claude", model: "claude-modell-der-frage" },
    });
    expect(atCreate!.metadata!.ask_id).toMatch(/^[a-f0-9]{12}$/);
  });

  test("Rückfrage kind ask mit Bezug auf Auftrag und Frage, in Telegram mit ch|-Knöpfen und choiceId", async () => {
    const { choice, taskId } = await offered();
    expect(choice).toMatchObject({
      kind: "ask",
      conversation: topicConv(),
      text: "Soll ich den Bericht jetzt verschicken?",
      ref: askRef(taskId, task(taskId).metadata!.ask_id as string),
      options: [
        { key: "o0", label: "Ja, verschicken" },
        { key: "o1", label: "Nein, erst zeigen" },
        { key: ASK_CANCEL, label: "Abbrechen" },
      ],
      state: "open",
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ chatId: GROUP, topicId: 443, source: "rueckfrage", choiceId: choice.id });
    expect(sends[0].buttons!.flat().map(b => b.callback_data)).toEqual([`ch|${choice.id}|o0`, `ch|${choice.id}|o1`, `ch|${choice.id}|cancel`]);
    expect((await getChoice(choice.id))!.telegram).toEqual([{ chatId: GROUP, messageId }]);
  });

  test("Speicherfehler beim Anlegen: keine Rückfrage, nichts gesendet", async () => {
    tasks.sw.create = false;
    expect(await offer(input())).toEqual({ status: "not-saved" });
    expect(await listChoices()).toEqual([]);
    expect(sends).toEqual([]);
  });

  test("Speicherfehler beim Festhalten von Frage und Motor: keine Rückfrage", async () => {
    tasks.sw.update = () => false;
    expect(await offer(input())).toEqual({ status: "not-saved" });
    expect(await listChoices()).toEqual([]);
    expect(sends).toEqual([]);
  });

  test("ungültige Eingabe: leere Frage, keine Optionen", async () => {
    expect(await offer(input({ question: " " }))).toEqual({ status: "invalid" });
    expect(await offer(input({ options: [" "] }))).toEqual({ status: "invalid" });
    expect(tasks.rows.size).toBe(0);
  });

  test("nirgends gezeigt: Rückfrage läuft ab, Auftrag gescheitert", async () => {
    telegramOn = false;
    const outcome = await offer(input());
    expect(outcome).toEqual({ status: "not-shown" });
    const [c] = await listChoices();
    expect(c.state).toBe("expired");
    expect(task("task-1").status).toBe("failed");
  });
});

// ---------------------------------------------------------------------------
// Entscheiden in jedem Kanal, genau einmal
// ---------------------------------------------------------------------------

describe("ein Klick setzt genau einmal fort", () => {
  test("Telegram: Session der Frage über ihren Motor mit ihrem Modell, Antwort gespeichert, Merk-Tags fürs Topic, gezeigt, Auftrag erledigt", async () => {
    const { choice, taskId } = await offered();
    await click(`ch|${choice.id}|o0`);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ engine: "claude", resumeSessionId: "sess-frage", model: "claude-modell-der-frage", prompt: taskResumePrompt("Ja, verschicken") });
    expect(saved).toEqual([
      {
        chat_id: GROUP,
        role: "assistant",
        content: "Erledigt, Bericht liegt bereit.",
        metadata: { type: "task_resume", taskId, agent: "research", topicId: 443 },
      },
    ]);
    expect(intents).toEqual([{ text: "Erledigt, Bericht liegt bereit.", target: { chatId: GROUP, topicId: 443, origin: "Telegram (Rückfrage)" } }]);
    expect(delivered).toEqual([{ conversation: topicConv(), text: "Erledigt, Bericht liegt bereit." }]);
    expect(task(taskId)).toMatchObject({ status: "completed", user_response: "Ja, verschicken", result: "Erledigt, Bericht liegt bereit.", session_id: "sess-frage" });
    expect(await state(choice.id)).toBe("done");

    // Zweiter Klick: schon entschieden, kein zweiter Lauf
    await click(`ch|${choice.id}|o1`);
    expect(runs).toHaveLength(1);
    expect(delivered).toHaveLength(1);
  });

  test("WebUI: Entscheidung über den Port im eigenen Gespräch", async () => {
    const { choice, taskId } = await offered();
    const result = await port.port.decide("topic-443", choice.id, "o1", "web");
    expect(result.status).toBe("decided");
    expect(runs).toHaveLength(1);
    expect(runs[0].prompt).toBe(taskResumePrompt("Nein, erst zeigen", "web"));
    expect(task(taskId).status).toBe("completed");
    expect((await getChoice(choice.id))!.result).toMatchObject({ key: "o1", via: "web" });
  });

  test("Terminal: Entscheidung über denselben Port, via terminal", async () => {
    const { choice } = await offered({ conversation: { type: "telegram", chatId: OWNER } });
    expect((await port.port.decide("dm", choice.id, "o0", "terminal")).status).toBe("decided");
    expect(runs).toHaveLength(1);
    expect(delivered[0].conversation).toEqual({ type: "telegram", chatId: OWNER });
    expect((await port.port.decide("dm", choice.id, "o1", "terminal")).status).toBe("already");
    expect(runs).toHaveLength(1);
  });

  test("gleichzeitig aus Telegram, Browser und Terminal: genau ein Motoraufruf, genau eine Antwort", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    engineReply = async (req, engine) => {
      await gate;
      return { engine, text: "fertig", sessionId: req.resumeSessionId, isError: false };
    };
    const { choice, taskId } = await offered();
    const all = Promise.all([
      click(`ch|${choice.id}|o0`),
      port.port.decide("topic-443", choice.id, "o1", "web"),
      port.port.decide("topic-443", choice.id, "o0", "terminal"),
    ]);
    await Bun.sleep(20);
    release();
    const [, web, terminal] = await all;
    expect(runs).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(task(taskId).status).toBe("completed");
    // Höchstens einer der beiden Port-Aufrufe gewinnt, der Rest bekommt "already"
    expect([web.status, terminal.status].filter(s => s === "decided").length).toBeLessThanOrEqual(1);
    expect([web.status, terminal.status].every(s => s === "decided" || s === "already")).toBe(true);
  });

  test("falsches Gespräch: der Port entscheidet nicht, die Frage bleibt offen", async () => {
    const { choice } = await offered();
    expect((await port.port.decide("dm", choice.id, "o0", "web")).status).toBe("not_found");
    expect((await port.port.decide("topic-444", choice.id, "o0", "terminal")).status).toBe("not_found");
    expect(runs).toEqual([]);
    expect(await state(choice.id)).toBe("open");
  });

  test("ungültige Auswahl: abgelehnt, Frage bleibt offen", async () => {
    const { choice } = await offered();
    expect((await port.port.decide("topic-443", choice.id, "o7", "web")).status).toBe("invalid_option");
    expect(runs).toEqual([]);
    expect(await state(choice.id)).toBe("open");
  });

  test("Folgefrage am selben Auftrag: der alte Knopf ist abgelaufen und setzt nichts fort", async () => {
    const first = await offered();
    const second = await offered({ taskId: first.taskId, question: "Und an wen?", options: ["Team", "Chef"] });
    expect(second.taskId).toBe(first.taskId);
    expect(await state(first.choice.id)).toBe("expired");
    expect((await port.port.decide("topic-443", first.choice.id, "o0", "web")).status).toBe("expired");
    expect(runs).toEqual([]);
    expect((await port.port.decide("topic-443", second.choice.id, "o1", "web")).status).toBe("decided");
    expect(runs).toHaveLength(1);
    expect(runs[0].prompt).toBe(taskResumePrompt("Chef", "web"));
  });

  test("veraltete Frage (askId passt nicht mehr): kein Motoraufruf, Meldung, Handlerfehler", async () => {
    const { taskId } = await offered();
    const old = await createChoice({ kind: "ask", conversation: topicConv(), text: "alt", options: [{ key: "o0", label: "Ja" }], ref: askRef(taskId, "aaaaaaaaaaaa") });
    const result = await port.port.decide("topic-443", old.id, "o0", "web");
    expect(result.status).toBe("decided");
    expect(runs).toEqual([]);
    expect(notices).toEqual([{ conversation: topicConv(), text: ASK_TEXT.stale }]);
    expect((await getChoice(old.id))!.handlerError).toBeDefined();
    expect(task(taskId).status).toBe("needs_input");
  });

  test("Frage aus einem anderen Gespräch als der Auftrag: kein Motoraufruf", async () => {
    const { taskId } = await offered();
    const ask = task(taskId).metadata!.ask_id as string;
    const foreign = await createChoice({ kind: "ask", conversation: topicConv(444), text: "x", options: [{ key: "o0", label: "Ja" }], ref: askRef(taskId, ask) });
    await port.port.decide("topic-444", foreign.id, "o0", "web");
    expect(runs).toEqual([]);
    expect(notices[0].text).toBe(ASK_TEXT.stale);
  });

  test("Speicherfehler beim Beanspruchen: kein Motoraufruf, Meldung", async () => {
    const { choice, taskId } = await offered();
    tasks.sw.update = c => c.status !== "running";
    await port.port.decide("topic-443", choice.id, "o0", "web");
    expect(runs).toEqual([]);
    expect(notices).toEqual([{ conversation: topicConv(), text: ASK_TEXT.notSaved }]);
    expect(task(taskId).status).toBe("needs_input");
    expect((await getChoice(choice.id))!.handlerError).toBeDefined();
  });

  test("Auftrag verschwunden: Meldung, kein Motoraufruf", async () => {
    const { choice, taskId } = await offered();
    tasks.rows.delete(taskId);
    await port.port.decide("topic-443", choice.id, "o0", "web");
    expect(runs).toEqual([]);
    expect(notices[0].text).toBe(ASK_TEXT.gone);
  });
});

// ---------------------------------------------------------------------------
// Kanalregeln der Fortsetzung (Issue #358)
// ---------------------------------------------------------------------------

describe("Kanalregeln der Fortsetzung: der Kanal des Klicks gilt", () => {
  test("Frage aus einem Telegram-Turn, Klick im Browser: WebUI-Regeln an den Motor, Antwort weiter ins Topic", async () => {
    const { choice, taskId } = await offered();
    expect(sends).toHaveLength(1);
    expect((await port.port.decide("topic-443", choice.id, "o0", "web")).status).toBe("decided");
    expect(runs).toHaveLength(1);
    expect(runs[0].prompt).toBe(taskResumePrompt("Ja, verschicken", "web"));
    expect(runs[0].prompt).toContain(formatChannelRules("web"));
    expect(runs[0].prompt).not.toContain(TELEGRAM_FORMAT_RULES);
    expect(runs[0].prompt.endsWith("User responded: Ja, verschicken")).toBe(true);
    // Zustellung unverändert: das Gespräch der Frage bestimmt den Weg, nicht der Klick
    expect(delivered).toEqual([{ conversation: topicConv(), text: "Erledigt, Bericht liegt bereit." }]);
    expect(task(taskId).status).toBe("completed");
  });

  test("Frage aus einem Browser-Turn im gespiegelten Topic, Klick in Telegram: Telegram-Regeln an den Motor", async () => {
    // Ein Browser-Turn im gespiegelten Topic legt die Frage im Gespräch des Topics an (bot-turn.ts)
    const { choice, taskId } = await offered();
    await click(`ch|${choice.id}|o1`);
    expect(runs).toHaveLength(1);
    expect(runs[0].prompt).toBe(taskResumePrompt("Nein, erst zeigen", "telegram"));
    expect(runs[0].prompt).toContain(TELEGRAM_FORMAT_RULES);
    expect(runs[0].prompt).not.toContain(formatChannelRules("web"));
    expect(delivered).toEqual([{ conversation: topicConv(), text: "Erledigt, Bericht liegt bereit." }]);
    expect(task(taskId).status).toBe("completed");
    expect((await getChoice(choice.id))!.result).toMatchObject({ key: "o1", via: "telegram" });
  });

  test("Web-Direktchat ohne Telegram: WebUI-Regeln, Antwort nur im gespeicherten Verlauf wie bisher", async () => {
    port = testChoices(join(dir, `choices-${++n}.json`), { userId: WEB_DM_CHAT_ID });
    const { choice } = await offered({ conversation: { type: "telegram", chatId: WEB_DM_CHAT_ID } });
    expect((await port.port.decide("dm", choice.id, "o0", "web")).status).toBe("decided");
    expect(runs[0].prompt).toBe(taskResumePrompt("Ja, verschicken", "web"));
    expect(saved).toHaveLength(1);
    expect(delivered).toEqual([]);
  });

  test("Kanal des Klicks: Telegram nur aus Telegram, Browser und Terminal zeigen die WebUI", () => {
    expect(clickChannel("telegram")).toBe("telegram");
    expect(clickChannel("web")).toBe("web");
    expect(clickChannel("terminal")).toBe("web");
    // Ohne Angabe (alte atask-Knöpfe, nur Telegram) bleibt es bei Telegram
    expect(taskResumePrompt("Ja")).toBe(taskResumePrompt("Ja", "telegram"));
  });
});

// ---------------------------------------------------------------------------
// Motor, Modell und Abschluss
// ---------------------------------------------------------------------------

describe("Motor und Modell der Frage bleiben", () => {
  test("Motorwechsel: Frage aus Codex mit Modell \"\" geht an Codex ohne Modell, nie an Claude oder das heutige Modell", async () => {
    const { choice, taskId } = await offered({ engine: "codex", model: "", sessionId: "codex-thread-1" });
    await port.port.decide("topic-443", choice.id, "o0", "web");
    expect(runs).toHaveLength(1);
    expect(runs[0].engine).toBe("codex");
    expect(runs[0].resumeSessionId).toBe("codex-thread-1");
    expect("model" in runs[0]).toBe(false);
    expect(task(taskId).metadata).toMatchObject({ engine: "codex", model: "" });
  });

  test("Modell der Frage gilt, auch wenn der Agent heute ein anderes hätte", async () => {
    const { choice } = await offered({ engine: "claude", model: "claude-alt" });
    await port.port.decide("topic-443", choice.id, "o0", "web");
    expect(runs[0]).toMatchObject({ engine: "claude", model: "claude-alt" });
  });
});

describe("Abschluss in jedem Fall", () => {
  test("Abbrechen: kein Motoraufruf, Auftrag gescheitert, Meldung", async () => {
    const { choice, taskId } = await offered();
    await click(`ch|${choice.id}|${ASK_CANCEL}`);
    expect(runs).toEqual([]);
    expect(task(taskId)).toMatchObject({ status: "failed", result: "Vom Nutzer abgebrochen" });
    expect(notices).toEqual([{ conversation: topicConv(), text: ASK_TEXT.cancelled }]);
  });

  test("/stop während des Fortsetzens: Auftrag gescheitert, Meldung, keine Antwort", async () => {
    engineReply = async (_req, engine) => ({ engine, text: "", isError: false, aborted: true });
    const { choice, taskId } = await offered();
    await port.port.decide("topic-443", choice.id, "o0", "web");
    expect(task(taskId)).toMatchObject({ status: "failed", result: "Abgebrochen" });
    expect(notices.map(x => x.text)).toEqual([ASK_TEXT.aborted]);
    expect(saved).toEqual([]);
    expect(delivered).toEqual([]);
  });

  test("ohne Session: nur bestätigt, Auftrag erledigt", async () => {
    const { choice, taskId } = await offered({ sessionId: undefined });
    await port.port.decide("topic-443", choice.id, "o0", "web");
    expect(runs).toEqual([]);
    expect(task(taskId).status).toBe("completed");
    expect(notices.map(x => x.text)).toEqual([ASK_TEXT.noted("Ja, verschicken")]);
  });

  test("Motor wirft: Auftrag gescheitert, Meldung, Handlerfehler, kein zweiter Versuch", async () => {
    engineReply = async () => {
      throw new Error("kaputt");
    };
    const { choice, taskId } = await offered();
    await port.port.decide("topic-443", choice.id, "o0", "web");
    expect(runs).toHaveLength(1);
    expect(task(taskId).status).toBe("failed");
    expect(notices.map(x => x.text)).toEqual([ASK_TEXT.failed]);
    expect((await getChoice(choice.id))!.handlerError?.message).toBe("kaputt");
    await click(`ch|${choice.id}|o0`);
    expect(runs).toHaveLength(1);
  });
});

describe("Motorfehler sind keine Antwort", () => {
  test("Zeitlimit mit leerem Text: Auftrag gescheitert, Meldung, nichts gespeichert, keine Merk-Tags, kein „Erledigt.“", async () => {
    engineReply = async (_req, engine) => ({ engine, text: "", isError: true, timedOut: true });
    const { choice, taskId } = await offered();
    await port.port.decide("topic-443", choice.id, "o0", "web");
    expect(runs).toHaveLength(1);
    expect(task(taskId)).toMatchObject({ status: "failed", result: "Fortsetzen gescheitert (Zeitlimit)" });
    expect(notices.map(x => x.text)).toEqual([ASK_TEXT.timedOut]);
    expect(saved).toEqual([]);
    expect(intents).toEqual([]);
    expect(delivered).toEqual([]);
    expect((await getChoice(choice.id))!.handlerError?.message).toBe("Fortsetzen gescheitert (Zeitlimit)");
  });

  test("gemeldeter Fehler mit Text: nicht gezeigt, Merk-Tags nicht ausgewertet, Auftrag gescheitert", async () => {
    engineReply = async (_req, engine) => ({ engine, text: "API Error: 500 [REMEMBER: falsch]", isError: true });
    const { choice, taskId } = await offered();
    await port.port.decide("topic-443", choice.id, "o0", "web");
    expect(task(taskId)).toMatchObject({ status: "failed", result: "Fortsetzen gescheitert (Motorfehler)" });
    expect(notices.map(x => x.text)).toEqual([ASK_TEXT.failed]);
    expect(saved).toEqual([]);
    expect(intents).toEqual([]);
    expect(delivered).toEqual([]);
    expect((await getChoice(choice.id))!.handlerError).toBeDefined();
  });
});

describe("Session und Motor bei Folgefragen", () => {
  test("Motorwechsel ohne Session: die Claude-Session wird entfernt und geht nie an Codex", async () => {
    const first = await offered();
    const second = await offered({ taskId: first.taskId, engine: "codex", model: "", sessionId: undefined, question: "Und an wen?", options: ["Team", "Chef"] });
    expect(task(first.taskId).session_id).toBe("");
    expect(task(first.taskId).metadata).toMatchObject({ engine: "codex", model: "" });
    await port.port.decide("topic-443", second.choice.id, "o0", "web");
    expect(runs).toEqual([]);
    expect(notices.map(x => x.text)).toEqual([ASK_TEXT.noted("Team")]);
  });

  test("Motorwechsel mit leerer Session: ebenso entfernt", async () => {
    const first = await offered();
    await offered({ taskId: first.taskId, engine: "codex", model: "", sessionId: "  ", question: "Und an wen?", options: ["Team", "Chef"] });
    expect(task(first.taskId).session_id).toBe("");
    expect(task(first.taskId).metadata!.engine).toBe("codex");
  });

  test("gleicher Motor ohne Session: die Session des Auftrags wird geerbt", async () => {
    const first = await offered();
    const second = await offered({ taskId: first.taskId, sessionId: "", question: "Und an wen?", options: ["Team", "Chef"] });
    expect(task(first.taskId).session_id).toBe("sess-frage");
    await port.port.decide("topic-443", second.choice.id, "o1", "web");
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ engine: "claude", resumeSessionId: "sess-frage" });
  });

  test("Motorwechsel mit eigener Session: die neue gilt", async () => {
    const first = await offered();
    const second = await offered({ taskId: first.taskId, engine: "codex", model: "", sessionId: "codex-thread-9", question: "Und an wen?", options: ["Team", "Chef"] });
    await port.port.decide("topic-443", second.choice.id, "o0", "web");
    expect(runs[0]).toMatchObject({ engine: "codex", resumeSessionId: "codex-thread-9" });
  });
});

describe("lange Antworten bleiben vollständig", () => {
  const stem = "Den Zugriff des neuen Dienstkontos auf alle Ordner im gemeinsamen Laufwerk dauerhaft";
  const allow = `${stem} erlauben`;
  const deny = `${stem} verbieten`;

  test("erst am Ende verschieden: unterscheidbare Knöpfe, voller Text am Auftrag und an den Motor", async () => {
    const { choice, taskId } = await offered({ options: [allow, deny] });
    const [o0, o1] = choice.options;
    expect(o0.label).not.toBe(o1.label);
    expect(o0.label.length).toBeLessThanOrEqual(60);
    expect(o0.label.endsWith("erlauben")).toBe(true);
    expect(o1.label.endsWith("verbieten")).toBe(true);
    expect(task(taskId).pending_options).toEqual([
      { label: allow, value: "o0" },
      { label: deny, value: "o1" },
    ]);
    await port.port.decide("topic-443", choice.id, "o1", "web");
    expect(runs).toHaveLength(1);
    expect(runs[0].prompt).toBe(taskResumePrompt(deny, "web"));
    expect(task(taskId).user_response).toBe(deny);
  });

  test("ununterscheidbare Knöpfe oder doppelte Antworten: abgelehnt, nichts gespeichert", async () => {
    const middle = (word: string) => `${stem.slice(0, 45)} ${word} und danach noch ein langes gleiches Ende`;
    expect(await offer(input({ options: [middle("lesen"), middle("schreiben")] }))).toEqual({ status: "invalid" });
    expect(await offer(input({ options: ["Ja", "Ja "] }))).toEqual({ status: "invalid" });
    expect(tasks.rows.size).toBe(0);
    expect(await listChoices()).toEqual([]);
  });
});

describe("überlappende Angebote am selben Auftrag", () => {
  test("A hält fest, B wartet, dann A legt an, dann B: genau eine offene Frage, deren Kennung am Auftrag steht", async () => {
    const first = await offered();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let aInside!: () => void;
    const aReached = new Promise<void>(r => (aInside = r));
    const racing = createAskOffer({
      sendChoice: async () => ({ sent: true }),
      tasks: () => tasks.store,
      createChoice: async (i, o) => {
        if (i.text === "A?") {
          aInside();
          await gate;
        }
        return createChoice(i, o);
      },
      log: () => {},
    });
    const a = racing(input({ taskId: first.taskId, question: "A?", options: ["a"] }));
    await aReached;
    const b = racing(input({ taskId: first.taskId, question: "B?", options: ["b"] }));
    await Bun.sleep(60);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.status).toBe("offered");
    expect(rb.status).toBe("offered");

    const open = (await listChoices()).filter(c => c.state === "open");
    expect(open).toHaveLength(1);
    expect(parseAskRef(open[0].ref)!.askId).toBe(task(first.taskId).metadata!.ask_id as string);
    expect(open[0].text).toBe("B?");
    expect((await port.port.decide("topic-443", open[0].id, "o0", "web")).status).toBe("decided");
    expect(runs).toHaveLength(1);
    expect(runs[0].prompt).toBe(taskResumePrompt("b", "web"));
    expect(task(first.taskId).status).toBe("completed");
  });

  test("Folgefrage während der Entscheidung: der Abschluss überschreibt die neuere Frage nicht", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    engineReply = async (req, engine) => {
      await gate;
      return { engine, text: "Und an wen?", sessionId: req.resumeSessionId, isError: false };
    };
    const first = await offered();
    const deciding = port.port.decide("topic-443", first.choice.id, "o0", "web");
    while (runs.length === 0) await Bun.sleep(5);
    const follow = await offered({ taskId: first.taskId, question: "Und an wen?", options: ["Team", "Chef"] });
    release();
    await deciding;

    expect(delivered.map(d => d.text)).toEqual(["Und an wen?"]);
    expect(task(first.taskId).status).toBe("needs_input");
    expect(task(first.taskId).metadata!.ask_id).toBe(parseAskRef(follow.choice.ref)!.askId);
    expect(await state(follow.choice.id)).toBe("open");
    // Eine neuere Frage ist kein Fehler beim Abschluss
    expect((await getChoice(first.choice.id))?.handlerError).toBeUndefined();
    expect(notices.map(x => x.text)).not.toContain(ASK_TEXT.statusNotSaved);

    engineReply = async (req, engine) => ({ engine, text: "Geht an das Team.", sessionId: req.resumeSessionId, isError: false });
    expect((await port.port.decide("topic-443", follow.choice.id, "o0", "web")).status).toBe("decided");
    expect(runs).toHaveLength(2);
    expect(task(first.taskId)).toMatchObject({ status: "completed", result: "Geht an das Team." });
  });

  test("Folgefrage, während der Motor scheitert: der Fehlerabschluss lässt die neuere Frage stehen", async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    engineReply = async (_req, engine) => {
      await gate;
      return { engine, text: "", isError: true };
    };
    const first = await offered();
    const deciding = port.port.decide("topic-443", first.choice.id, "o0", "web");
    while (runs.length === 0) await Bun.sleep(5);
    const follow = await offered({ taskId: first.taskId, question: "Und an wen?", options: ["Team", "Chef"] });
    release();
    await deciding;
    expect(task(first.taskId).status).toBe("needs_input");
    expect(task(first.taskId).metadata!.ask_id).toBe(parseAskRef(follow.choice.ref)!.askId);
  });
});

describe("alter atask-Weg", () => {
  /** Erinnerung alter Aufträge (task-reminders.ts); stale() wie Supabase: nur wartende Aufträge ohne Erinnerung */
  const legacyReminders = (reminders: { buttons: { callback_data: string }[][] }[]) =>
    createTaskReminders({
      showAsk: async () => "failed",
      notifyLegacy: async (_text, target) => (reminders.push({ buttons: target.buttons }), true),
      directChatIds: () => [OWNER, WEB_DM_CHAT_ID],
      tasks: () => ({
        byId: id => tasks.store.byId(id),
        update: (id, changes) => tasks.store.update(id, changes),
        stale: async () => [...tasks.rows.values()].filter(t => t.status === "needs_input" && !t.reminder_sent).map(t => structuredClone(t)),
      }),
      isQuiet: () => false,
      log: () => {},
    }).remindLegacy();
  const registerAsk = (data: string) => isRegisterAskCallback(data, () => tasks.store);

  test("Erinnerung, Entscheidung im Register, danach Erinnerungsknopf: genau ein Motoraufruf, Auftrag bleibt erledigt", async () => {
    const { choice, taskId } = await offered({ conversation: { type: "telegram", chatId: OWNER } });
    expect(task(taskId).reminder_sent).toBe(true);
    const reminders: { buttons: { callback_data: string }[][] }[] = [];
    const reminded = await legacyReminders(reminders);
    expect(reminded).toBe(0);
    expect(reminders).toEqual([]);

    expect((await port.port.decide("dm", choice.id, "o0", "web")).status).toBe("decided");
    expect(runs).toHaveLength(1);
    expect(task(taskId).status).toBe("completed");
    expect(task(taskId).reminder_sent).toBe(true);

    // Ein atask-Knopf zu diesem Auftrag wird in src/bot.ts nie beansprucht (legacy-task-buttons.ts)
    expect(await registerAsk(`atask:${taskId}:o0`)).toBe(true);
    expect(await registerAsk(`atask:${taskId}:cancel`)).toBe(true);
    expect(task(taskId).status).toBe("completed");
    expect(runs).toHaveLength(1);
  });

  test("Folgefrage an einem alten Auftrag: abgelehnt, er bleibt unverändert beim alten Weg", async () => {
    const old = (await tasks.store.create(GROUP, "Plane die Woche", 443))!;
    await tasks.store.update(old.id, { status: "needs_input", reminder_sent: false });
    const before = structuredClone(task(old.id));
    expect(await offer(input({ taskId: old.id }))).toEqual({ status: "invalid" });
    expect(task(old.id)).toEqual(before);
    expect(await listChoices()).toEqual([]);
    expect(await registerAsk(`atask:${old.id}:1`)).toBe(false);
  });

  test("atask-Knopf vor der Entscheidung: abgewiesen, die Rückfrage bleibt offen und entscheidbar", async () => {
    const { choice, taskId } = await offered();
    expect(await registerAsk(`atask:${taskId}:o0`)).toBe(true);
    expect(task(taskId).status).toBe("needs_input");
    expect(await state(choice.id)).toBe("open");
    await port.port.decide("topic-443", choice.id, "o0", "web");
    expect(runs).toHaveLength(1);
  });

  test("alte Aufträge ohne Register-Kennung: Erinnerung mit atask-Knöpfen, der Knopf geht an den alten Weg", async () => {
    const old = (await tasks.store.create(OWNER, "Plane die Woche"))!;
    await tasks.store.update(old.id, { status: "needs_input", pending_question: "Welcher Tag?", pending_options: [{ label: "1. Montag", value: "1" }] });
    const reminders: { buttons: { callback_data: string }[][] }[] = [];
    expect(await legacyReminders(reminders)).toBe(1);
    expect(reminders[0].buttons.flat().map(b => b.callback_data)).toEqual([`atask:${old.id}:1`, `atask:${old.id}:cancel`]);
    expect(await registerAsk(`atask:${old.id}:1`)).toBe(false);
    // Fehlender Auftrag (null, wie ein Lesefehler im Supabase-Speicher): gesperrt
    expect(await registerAsk("atask:fehlt:1")).toBe(true);
    expect(await registerAsk("other:x:1")).toBe(false);
  });

  test("Auftrag nicht lesbar: der Knopf gilt vorsichtshalber als Register-Knopf", async () => {
    const broken = { byId: async () => { throw new Error("weg"); } } as unknown as TaskStore;
    expect(await isRegisterAskCallback("atask:task-1:1", () => broken)).toBe(true);
    const empty = { byId: async () => null } as unknown as TaskStore;
    expect(await isRegisterAskCallback("atask:task-1:1", () => empty)).toBe(true);
  });

  test("echter Supabase-Speicher: erste Abfrage scheitert (null), zweite gelingt, kein Alt-Handlerlauf, kein Motoraufruf", async () => {
    // Abgeschlossener ask-Auftrag, wie ihn das Register nach der Entscheidung hinterlässt
    const { choice, taskId } = await offered();
    await port.port.decide("topic-443", choice.id, "o0", "web");
    expect(runs).toHaveLength(1);
    const row = task(taskId);
    expect(row.status).toBe("completed");

    let reads = 0;
    const db = useFakeSupabase({
      respond: request => {
        if (request.url.pathname !== "/rest/v1/async_tasks" || request.method !== "GET") return undefined;
        // Erste Abfrage: Lesefehler, den der Speicher als null meldet; danach der Auftrag
        if (++reads === 1) return new Response(JSON.stringify({ message: "Datenbank weg" }), { status: 500, headers: { "Content-Type": "application/json" } });
        return new Response(JSON.stringify([row]), { status: 200, headers: { "Content-Type": "application/json" } });
      },
    });
    try {
      // Ablauf in src/bot.ts: claimLegacyTaskButton prüft zuerst das Register, beansprucht erst danach
      const claim = await claimLegacyTaskButton(`atask:${taskId}:o0`, { chatId: GROUP, threadId: 443 }, { directChatIds: () => [OWNER, WEB_DM_CHAT_ID] });
      expect(reads).toBe(1);
      expect(claim).toEqual({ status: "rejected", text: ASK_TEXT.stale, keepButtons: false });
      // Die zweite Abfrage hätte den Auftrag geliefert, der Alt-Handler hätte ihn fortgesetzt
      expect(await getStore().tasks.byId(taskId)).toMatchObject({ id: taskId, status: "completed" });
      expect(db.requests.filter(r => r.url.origin === FAKE_SUPABASE_URL && r.method !== "GET")).toEqual([]);
      expect(runs).toHaveLength(1);
      expect(task(taskId).status).toBe("completed");
    } finally {
      db.restore();
    }
  });

  /** Vereinfachter alter Weg (liest, beansprucht), auf dem Auftragsspeicher der Attrappe; beforeRead hält vor dem Lesen an */
  const legacyClaim = (beforeRead?: () => Promise<void>) => async (data: string) => {
    const [, taskId, value] = data.split(":");
    await beforeRead?.();
    const t = await tasks.store.byId(taskId);
    if (!t) return null;
    const choice = t.pending_options?.find(o => o.value === value)?.label ?? value;
    await tasks.store.update(taskId, { status: "running", user_response: choice });
    return { taskId, choice, task: t, cancelled: false };
  };
  async function oldTask() {
    const old = (await tasks.store.create(GROUP, "Plane die Woche", 443))!;
    await tasks.store.update(old.id, {
      status: "needs_input",
      session_id: "sess-alt",
      pending_question: "Welcher Tag?",
      pending_options: [{ label: "1. Montag", value: "1" }],
    });
    return old;
  }

  test("Altprüfung passiert, Alt-Abfrage wartet: die Übernahme ist sofort abgelehnt, ohne auf den alten Knopf zu warten", async () => {
    const old = await oldTask();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    let atSecondRead!: () => void;
    const secondRead = new Promise<void>(r => (atSecondRead = r));
    const legacyRun = claimLegacyTaskCallback(
      `atask:${old.id}:1`,
      legacyClaim(async () => {
        atSecondRead();
        await gate;
      }),
      () => tasks.store
    );
    await secondRead;
    // Der alte Knopf hängt noch: die Übernahme entscheidet trotzdem sofort
    expect(await offer(input({ taskId: old.id }))).toEqual({ status: "invalid" });
    expect(task(old.id).metadata?.ask_id).toBeUndefined();
    release();

    const legacy = await legacyRun;
    if (legacy.register || !legacy.result) throw new Error("alter Knopf nicht zugelassen");
    expect(task(old.id)).toMatchObject({ status: "running", user_response: "1. Montag" });
    // Der zugelassene Alt-Handler setzt fort, wie die atask-Zweige in src/bot.ts
    await resumeMacTask(legacy.result.task, GROUP, legacy.result.choice, resumeDeps);
    expect(runs).toHaveLength(1);
    expect(await listChoices()).toEqual([]);
  });

  test("Altknopf, Beanspruchen nicht gespeichert, danach Übernahme: abgelehnt, kein Motoraufruf", async () => {
    const old = await oldTask();
    // Supabase-Attrappe auf den Zeilen der Speicher-Attrappe; das erste Schreiben scheitert
    let patches = 0;
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
    const db = useFakeSupabase({
      respond: request => {
        if (request.url.pathname !== "/rest/v1/async_tasks") return undefined;
        const id = request.url.searchParams.get("id")?.replace(/^eq\./, "") ?? "";
        const row = tasks.rows.get(id);
        if (request.method === "GET") return json(row ? [row] : []);
        if (request.method !== "PATCH") return undefined;
        if (++patches === 1) return json({ message: "Datenbank weg" }, 500);
        if (row) for (const [k, v] of Object.entries(JSON.parse(request.body))) (row as any)[k] = v;
        return new Response(null, { status: 204 });
      },
    });
    try {
      const claim = await claimLegacyTaskButton(`atask:${old.id}:1`, { chatId: GROUP, threadId: 443 }, { directChatIds: () => [OWNER, WEB_DM_CHAT_ID] });
      expect(patches).toBe(1);
      // Das gescheiterte Schreiben hält den Motor an, die Knöpfe bleiben, der Auftrag wartet weiter
      expect(claim).toEqual({ status: "rejected", text: LEGACY_TASK_TEXT.notSaved, keepButtons: true });
      expect(task(old.id).status).toBe("needs_input");
      expect(runs).toEqual([]);
    } finally {
      db.restore();
    }

    // Der Speicher hat sich erholt: das Register übernimmt den Auftrag trotzdem nicht
    const before = structuredClone(task(old.id));
    expect(await offer(input({ taskId: old.id }))).toEqual({ status: "invalid" });
    expect(task(old.id)).toEqual(before);
    expect(await listChoices()).toEqual([]);
    expect(runs).toEqual([]);
  });

  test("alter Auftrag in jedem Zustand des alten Wegs: nie übernommen, nichts geschrieben", async () => {
    for (const status of ["needs_input", "running", "completed", "failed"] as const) {
      const old = await oldTask();
      await tasks.store.update(old.id, { status });
      const before = structuredClone(task(old.id));
      expect(await offer(input({ taskId: old.id }))).toEqual({ status: "invalid" });
      expect(task(old.id)).toEqual(before);
      expect(await registerAsk(`atask:${old.id}:1`)).toBe(false);
    }
    expect(await listChoices()).toEqual([]);
    expect(runs).toEqual([]);
  });

  test("Auftrag des Registers bleibt einer: Folgefrage und Abschluss behalten die askId, der atask-Knopf bleibt abgewiesen", async () => {
    const first = await offered();
    const follow = await offered({ taskId: first.taskId, question: "Und an wen?", options: ["Team", "Chef"] });
    await port.port.decide("topic-443", follow.choice.id, "o0", "web");
    expect(task(first.taskId).status).toBe("completed");
    expect(task(first.taskId).metadata!.ask_id).toBe(parseAskRef(follow.choice.ref)!.askId);
    let legacyRuns = 0;
    expect(await claimLegacyTaskCallback(`atask:${first.taskId}:o0`, async () => void legacyRuns++, () => tasks.store)).toEqual({ register: true });
    expect(legacyRuns).toBe(0);
    expect(runs).toHaveLength(1);
  });

  test("alter Auftrag ohne Register-Kennung: der Knopf läuft durch", async () => {
    const old = await oldTask();
    const legacy = await claimLegacyTaskCallback(`atask:${old.id}:1`, legacyClaim(), () => tasks.store);
    expect(legacy.register).toBe(false);
    expect(task(old.id).status).toBe("running");
    // Andere Daten gehen ungeprüft an den alten Weg (der lehnt sie selbst ab)
    expect(await claimLegacyTaskCallback("atask:../x:1", async () => "alt", () => tasks.store)).toEqual({ register: false, result: "alt" });
  });
});

describe("Fehler beim Antwortabschluss", () => {
  /**
   * Zustellung wie in src/bot.ts: createAskDeliver über sendMessageChecked
   * einer echten Telegram-Laufzeit mit echtem grammY-Bot; die Bot-API ist ein
   * Transformer, der jedes sendMessage annimmt, mit dem Status ablehnt oder wirft
   */
  function useTelegramRuntime(reply: "ok" | number | Error) {
    const telegramCalls: Record<string, any>[] = [];
    const runtime = createTelegramRuntime({
      env: { TELEGRAM_BOT_TOKEN: "123456789:AAFakeTokenForTestsOnly_abcdefghijklmn", TELEGRAM_USER_ID: OWNER },
      createBot: token => {
        const bot = new Bot(token, { botInfo: { id: 1, is_bot: true, first_name: "Bot", username: "bot" } as any });
        bot.api.config.use(async (_prev, method, payload) => {
          if (method !== "sendMessage") throw new Error(`unerwartet: ${method}`);
          telegramCalls.push({ ...(payload as Record<string, any>) });
          if (reply instanceof Error) throw reply;
          if (reply !== "ok") throw new GrammyError(`Call to 'sendMessage' failed! (${reply})`, { ok: false, error_code: reply, description: "Forbidden" }, method, payload as any);
          return { ok: true, result: { message_id: ++messageId, date: 0, chat: { id: Number(GROUP), type: "supergroup" } } } as any;
        });
        return bot;
      },
      createAgentBots: () => ({}) as AgentBots,
      log: () => {},
    });
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    cleanup.push(() => errorSpy.mockRestore());
    realDeliver = createAskDeliver({
      postWeb: async () => false,
      sendTelegram: (chatId, text, threadId) => runtime.sendMessageChecked(chatId, text, threadId),
    });
    return { telegramCalls };
  }

  // Ohne Telegram ist der Direktchat "web" (dmChatId), der Port gehört diesem Nutzer
  async function offeredInWebDm() {
    port = testChoices(join(dir, `choices-${++n}.json`), { userId: WEB_DM_CHAT_ID });
    return offered({ conversation: { type: "telegram", chatId: WEB_DM_CHAT_ID } });
  }

  test("Web-Direktchat ohne Telegram, Speichern scheitert: Antwort über den Meldeweg, Hinweis, Handlerfehler, ein Motoraufruf", async () => {
    const { choice, taskId } = await offeredInWebDm();
    saveResult = false;
    await port.port.decide("dm", choice.id, "o0", "web");
    expect(runs).toHaveLength(1);
    expect(saved).toEqual([]);
    expect(notices.map(n => n.text)).toEqual(["Erledigt, Bericht liegt bereit.", ASK_TEXT.notStored]);
    expect(task(taskId)).toMatchObject({ status: "completed", result: "Erledigt, Bericht liegt bereit." });
    expect((await getChoice(choice.id))?.handlerError?.message).toContain("Antwort nicht gespeichert");
  });

  test("Web-Direktchat, Speichern und Meldeweg scheitern: Auftrag gescheitert, Antwort im Ergebnis, Handlerfehler", async () => {
    const { choice, taskId } = await offeredInWebDm();
    saveResult = "throw";
    notifyOk = false;
    await port.port.decide("dm", choice.id, "o0", "web");
    expect(runs).toHaveLength(1);
    expect(task(taskId).status).toBe("failed");
    expect(task(taskId).result).toBe("Antwort nicht zugestellt: Erledigt, Bericht liegt bereit.");
    expect((await getChoice(choice.id))?.handlerError?.message).toBe("Antwort nicht gespeichert, Antwort nicht zugestellt");
  });

  test("Telegram-Zustellung wirft: Antwort über den Meldeweg, erledigt, Handlerfehler, kein zweiter Lauf", async () => {
    const { choice, taskId } = await offered();
    deliverResult = "throw";
    await click(`ch|${choice.id}|o0`);
    expect(runs).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(notices.map(n => n.text)).toEqual(["Erledigt, Bericht liegt bereit."]);
    expect(task(taskId).status).toBe("completed");
    expect((await getChoice(choice.id))?.handlerError?.message).toBe("Antwort nicht zugestellt");
    await click(`ch|${choice.id}|o0`);
    expect(runs).toHaveLength(1);
  });

  test("echter Sendeweg, Telegram lehnt ab: Antwort über den Meldeweg, erledigt, Handlerfehler, kein zweiter Lauf", async () => {
    const { telegramCalls } = useTelegramRuntime(403);
    const { choice, taskId } = await offered();
    await click(`ch|${choice.id}|o0`);
    expect(runs).toHaveLength(1);
    // Telegram wurde wirklich gefragt (HTML, dann Klartext-Rückfall) und hat abgelehnt
    expect(telegramCalls.length).toBeGreaterThan(0);
    expect(telegramCalls.every(c => c.chat_id === GROUP && c.message_thread_id === 443)).toBe(true);
    expect(notices.map(n => n.text)).toEqual(["Erledigt, Bericht liegt bereit."]);
    expect(task(taskId).status).toBe("completed");
    expect((await getChoice(choice.id))?.handlerError?.message).toBe("Antwort nicht zugestellt");
    await click(`ch|${choice.id}|o0`);
    expect(runs).toHaveLength(1);
  });

  test("echter Sendeweg, Netzfehler und Meldeweg scheitert: Auftrag gescheitert statt still erledigt", async () => {
    useTelegramRuntime(new Error("Netz weg"));
    notifyOk = false;
    const { choice, taskId } = await offered();
    await click(`ch|${choice.id}|o0`);
    expect(runs).toHaveLength(1);
    expect(task(taskId).status).toBe("failed");
    expect(task(taskId).result).toBe("Antwort nicht zugestellt: Erledigt, Bericht liegt bereit.");
    expect((await getChoice(choice.id))?.handlerError?.message).toBe("Antwort nicht zugestellt");
  });

  test("echter Sendeweg, Telegram nimmt an: gezeigt, kein Meldeweg, kein Handlerfehler", async () => {
    const { telegramCalls } = useTelegramRuntime("ok");
    const { choice, taskId } = await offered();
    await click(`ch|${choice.id}|o0`);
    expect(telegramCalls).toHaveLength(1);
    expect(notices).toEqual([]);
    expect(task(taskId).status).toBe("completed");
    expect((await getChoice(choice.id))?.handlerError).toBeUndefined();
  });

  test("reines Web-Gespräch, postWeb liefert false: Antwort über den Meldeweg, Handlerfehler", async () => {
    const { choice, taskId } = await offered({ conversation: webConv });
    deliverResult = false;
    await port.port.decide(WEB, choice.id, "o0", "web");
    expect(runs).toHaveLength(1);
    expect(notices).toEqual([{ conversation: webConv, text: "Erledigt, Bericht liegt bereit." }]);
    expect(task(taskId).status).toBe("completed");
    expect((await getChoice(choice.id))?.handlerError?.message).toBe("Antwort nicht zugestellt");
  });

  test("Zustellung und Meldeweg scheitern: Auftrag gescheitert statt still erledigt", async () => {
    const { choice, taskId } = await offered();
    deliverResult = false;
    notifyOk = false;
    await click(`ch|${choice.id}|o0`);
    expect(runs).toHaveLength(1);
    expect(saved).toHaveLength(1);
    expect(task(taskId).status).toBe("failed");
    expect((await getChoice(choice.id))?.handlerError?.message).toBe("Antwort nicht zugestellt");
  });

  test("Telegram gezeigt, Speichern liefert false: erledigt, Hinweis im Gespräch, Handlerfehler", async () => {
    const { choice, taskId } = await offered();
    saveResult = false;
    await click(`ch|${choice.id}|o0`);
    expect(runs).toHaveLength(1);
    expect(delivered).toHaveLength(1);
    expect(notices.map(n => n.text)).toEqual([ASK_TEXT.notStored]);
    expect(task(taskId).status).toBe("completed");
    expect((await getChoice(choice.id))?.handlerError?.message).toBe("Antwort nicht gespeichert");
  });

  test("Erfolg, Status speichern liefert false: Antwort gezeigt, Hinweis, Handlerfehler, kein zweiter Lauf", async () => {
    const { choice, taskId } = await offered();
    tasks.sw.update = c => c.status !== "completed";
    await click(`ch|${choice.id}|o0`);
    expect(runs).toHaveLength(1);
    expect(delivered.map(d => d.text)).toEqual(["Erledigt, Bericht liegt bereit."]);
    expect(notices.map(n => n.text)).toEqual([ASK_TEXT.statusNotSaved]);
    expect(task(taskId).status).toBe("running");
    expect((await getChoice(choice.id))?.handlerError?.message).toBe("Status des Auftrags nicht gespeichert");
    await click(`ch|${choice.id}|o0`);
    expect(runs).toHaveLength(1);
  });

  test("Erfolg, Status speichern wirft: Hinweis, Handlerfehler, kein zweiter Lauf", async () => {
    const { choice, taskId } = await offered();
    tasks.sw.update = c => {
      if (c.status === "completed") throw new Error("Datenbank weg");
      return true;
    };
    await port.port.decide("topic-443", choice.id, "o0", "web");
    expect(runs).toHaveLength(1);
    expect(notices.map(n => n.text)).toEqual([ASK_TEXT.statusNotSaved]);
    expect(task(taskId).status).toBe("running");
    expect((await getChoice(choice.id))?.handlerError?.message).toBe("Status des Auftrags nicht gespeichert");
  });

  test("Erfolg, Auftrag beim Abschluss nicht lesbar: Hinweis, Handlerfehler, kein zweiter Lauf", async () => {
    const { choice } = await offered();
    const reply = engineReply;
    engineReply = async (req, engine) => {
      // Lesefehler wie im Supabase-Speicher (null)
      (tasks.store as any).byId = async () => null;
      return reply(req, engine);
    };
    await port.port.decide("topic-443", choice.id, "o0", "web");
    expect(runs).toHaveLength(1);
    expect(notices.map(n => n.text)).toEqual([ASK_TEXT.statusNotSaved]);
    expect((await getChoice(choice.id))?.handlerError?.message).toBe("Status des Auftrags nicht gespeichert");
  });

  test("Abbrechen, Status speichern liefert false: Meldung, Hinweis, Handlerfehler, kein Motoraufruf", async () => {
    const { choice, taskId } = await offered();
    tasks.sw.update = c => c.status !== "failed";
    await click(`ch|${choice.id}|${ASK_CANCEL}`);
    expect(runs).toEqual([]);
    expect(notices.map(n => n.text)).toEqual([ASK_TEXT.cancelled, ASK_TEXT.statusNotSaved]);
    expect(task(taskId).status).toBe("needs_input");
    expect((await getChoice(choice.id))?.handlerError?.message).toBe("Status des Auftrags nicht gespeichert");
    await click(`ch|${choice.id}|o0`);
    expect(runs).toEqual([]);
  });

  test("Abbrechen, Status speichern wirft: Hinweis, Handlerfehler, kein Motoraufruf", async () => {
    const { choice } = await offered();
    tasks.sw.update = c => {
      if (c.status === "failed") throw new Error("Datenbank weg");
      return true;
    };
    await port.port.decide("topic-443", choice.id, ASK_CANCEL, "web");
    expect(runs).toEqual([]);
    expect(notices.map(n => n.text)).toEqual([ASK_TEXT.cancelled, ASK_TEXT.statusNotSaved]);
    expect((await getChoice(choice.id))?.handlerError?.message).toBe("Status des Auftrags nicht gespeichert");
  });

  test("/stop, Status speichern wirft: Meldung, Hinweis, Handlerfehler, kein zweiter Lauf", async () => {
    engineReply = async (_req, engine) => ({ engine, text: "", isError: false, aborted: true });
    const { choice } = await offered();
    tasks.sw.update = c => {
      if (c.status === "failed") throw new Error("Datenbank weg");
      return true;
    };
    await port.port.decide("topic-443", choice.id, "o0", "web");
    expect(runs).toHaveLength(1);
    expect(notices.map(n => n.text)).toEqual([ASK_TEXT.statusNotSaved, ASK_TEXT.aborted]);
    expect((await getChoice(choice.id))?.handlerError?.message).toBe("Status des Auftrags nicht gespeichert");
  });
});

describe("ohne Telegram", () => {
  test("reines Web-Gespräch: Frage im Gespräch mit choiceId, Entscheidung im Browser, Antwort dort, gespeichert unter web:<id>", async () => {
    telegramOn = false;
    const { choice, taskId } = await offered({ conversation: webConv });
    expect(sends).toEqual([]);
    expect(webPosts).toEqual([{ conversationId: WEB, post: { text: choice.text, kind: "notice", source: "rueckfrage", choiceId: choice.id } }]);
    expect(task(taskId)).toMatchObject({ chat_id: `web:${WEB}`, status: "needs_input" });
    expect(task(taskId).thread_id).toBeUndefined();

    expect((await port.port.decide(WEB, choice.id, "o0", "web")).status).toBe("decided");
    expect(runs).toHaveLength(1);
    expect(saved[0]).toMatchObject({ chat_id: `web:${WEB}`, content: "Erledigt, Bericht liegt bereit." });
    expect(intents[0].target).toEqual({ chatId: `web:${WEB}`, origin: "Web-Gespraech (Rückfrage)" });
    expect(delivered).toEqual([{ conversation: webConv, text: "Erledigt, Bericht liegt bereit." }]);
    expect(task(taskId).status).toBe("completed");
  });
});

describe("offerAsk ohne Zustellweg", () => {
  test("ohne installAskOffer: nichts gespeichert, keine Rückfrage", async () => {
    for (const off of cleanup.splice(0)) off();
    expect(await offerAsk(input())).toEqual({ status: "unavailable" });
    expect(tasks.rows.size).toBe(0);
    expect(await listChoices()).toEqual([]);
  });
});

describe("Bezug", () => {
  test("parseAskRef nimmt nur, was offerAsk baut", () => {
    expect(parseAskRef(askRef("task-1", "0123456789ab"))).toEqual({ taskId: "task-1", askId: "0123456789ab" });
    expect(parseAskRef("1234")).toBeNull();
    expect(parseAskRef("task-1:xyz")).toBeNull();
    expect(parseAskRef(undefined)).toBeNull();
  });
});

describe("Rückfrage in der fortgesetzten Antwort (Issue #336)", () => {
  const FOLLOW = "Bericht verschickt.\n\n[FRAGE: Soll ich auch das Team informieren? | Ja | Nein]";
  const FOLLOW_TEXT = "Bericht verschickt.\n\nSoll ich auch das Team informieren?\n- Ja\n- Nein";

  test("lesbar gespeichert und gezeigt, Auftrag erledigt, Folgefrage an neuem Auftrag mit Session und Motor der Fortsetzung", async () => {
    engineReply = async (_req, engine) => ({ engine, text: FOLLOW, sessionId: "sess-weiter", isError: false });
    const { choice, taskId } = await offered();
    await click(`ch|${choice.id}|o0`);
    expect(saved.map(m => m.content)).toEqual([FOLLOW_TEXT]);
    expect(delivered.map(d => d.text)).toEqual([FOLLOW_TEXT]);
    expect(intents.map(i => i.text)).toEqual([FOLLOW_TEXT]);
    expect(task(taskId)).toMatchObject({ status: "completed", result: FOLLOW_TEXT });

    const open = (await listChoices()).filter(c => c.kind === "ask" && c.state === "open");
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ conversation: topicConv(), text: "Soll ich auch das Team informieren?" });
    const next = parseAskRef(open[0].ref)!;
    expect(next.taskId).not.toBe(taskId);
    expect(task(next.taskId)).toMatchObject({
      status: "needs_input",
      session_id: "sess-weiter",
      original_prompt: "Schreib den Wochenbericht",
    });
    expect(task(next.taskId).metadata).toMatchObject({ agent_name: "research", engine: "claude", model: "claude-modell-der-frage", ask_id: next.askId });

    // Die Folgefrage setzt die Session der Fortsetzung fort
    engineReply = async (req, engine) => ({ engine, text: "Team informiert.", sessionId: req.resumeSessionId, isError: false });
    expect((await port.port.decide("topic-443", open[0].id, "o0", "web")).status).toBe("decided");
    expect(runs.at(-1)).toMatchObject({ resumeSessionId: "sess-weiter", prompt: taskResumePrompt("Ja", "web") });
    expect(task(next.taskId).status).toBe("completed");
  });

  test("Antwort nirgends gezeigt: keine Folgefrage", async () => {
    engineReply = async (_req, engine) => ({ engine, text: FOLLOW, sessionId: "sess-weiter", isError: false });
    deliverResult = false;
    notifyOk = false;
    const { choice } = await offered();
    await click(`ch|${choice.id}|o0`);
    expect((await listChoices()).filter(c => c.kind === "ask" && c.state === "open")).toHaveLength(0);
  });

  for (const c of [
    {
      lang: "de",
      text: "Zwei Wege:\n\n1. Mit `npm` installieren\n2. **Manuell** installieren\n\nWelche Variante soll ich nehmen?",
      options: ["Mit `npm` installieren", "Manuell installieren"],
    },
    {
      lang: "en",
      text: "Two ways:\n\n1. Run `bun install`\n2. Edit `__init__.py` by hand\n\nWhich one should I use?",
      options: ["Run `bun install`", "Edit `__init__.py` by hand"],
    },
  ]) {
    test(`${c.lang}: Inline-Code in den Antworten bleibt in Knopf, Auftrag und Motor-Antwort unverfälscht`, async () => {
      engineReply = async (_req, engine) => ({ engine, text: c.text, sessionId: "sess-weiter", isError: false });
      const { choice } = await offered();
      await click(`ch|${choice.id}|o0`);
      const [open] = (await listChoices()).filter(x => x.kind === "ask" && x.state === "open");
      expect(open.options.map(o => o.label)).toEqual([...c.options, "Abbrechen"]);
      expect(sends.at(-1)!.buttons!.flat().map(b => b.text)).toEqual([...c.options, "Abbrechen"]);
      const next = parseAskRef(open.ref)!;
      expect(task(next.taskId).pending_options).toEqual(c.options.map((label, i) => ({ label, value: `o${i}` })));

      engineReply = async (req, engine) => ({ engine, text: "Erledigt.", sessionId: req.resumeSessionId, isError: false });
      expect((await port.port.decide("topic-443", open.id, "o0", "web")).status).toBe("decided");
      expect(runs.at(-1)).toMatchObject({ resumeSessionId: "sess-weiter", prompt: taskResumePrompt(c.options[0], "web") });
      expect(task(next.taskId).user_response).toBe(c.options[0]);
      for (const s of [...open.options.map(o => o.label), runs.at(-1)!.prompt]) expect(s).not.toContain("\u0001");
    });
  }

  test("rhetorische Frage in der Fortsetzung: keine Folgefrage", async () => {
    engineReply = async (_req, engine) => ({ engine, text: "Erledigt. Warum so spät? Weil der Server hing.", sessionId: "s", isError: false });
    const { choice } = await offered();
    await click(`ch|${choice.id}|o0`);
    expect((await listChoices()).filter(c => c.kind === "ask" && c.state === "open")).toHaveLength(0);
  });
});
