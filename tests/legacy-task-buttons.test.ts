/**
 * Issue #337, Checkbox 4: alte Knöpfe atask:<taskId>:<auswahl> im
 * Bot-Prozess (src/lib/legacy-task-buttons.ts). Belegt: fortsetzen,
 * abbrechen, unbekannt, erledigt, laufend, Auftrag des Registers, nicht
 * lesbar, fremdes Gespräch, ungültige Auswahl und Kennung, Doppelklick (zwei
 * gleichzeitige Klicks, ein Motoraufruf), Speicherfehler beim Beanspruchen
 * (auch bei „Abbrechen"), Folgefrage im Mac-Zweig als Rückfrage des
 * Registers an einem neuen Auftrag, Motorfehler und Zeitlimit ohne Antwort,
 * Zustellung über den echten Versand (sendResponse über replyWithReceipt)
 * mit Telegram-Attrappe: ohne angekommene Antwort keine Folgefrage.
 * Echte Sperre und echtes resumeMacTask mit Motor-Attrappe, echtes Register
 * (Datei im Temp-Verzeichnis); Auftragsspeicher als Attrappe. src/bot.ts
 * wird nie geladen.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Context, GrammyError } from "grammy";
import { sendResponse } from "../src/channels/telegram/send";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { ASK_TEXT, createAskOffer, parseAskRef, type AskOffer } from "../src/lib/ask-choices";
import { listChoices, setChoicesFileForTests, type ChoiceConversation } from "../src/lib/choices";
import type { EngineId, EngineRequest, EngineResult } from "../src/lib/engines";
import { runExecution } from "../src/lib/execution-context";
import {
  claimLegacyTaskButton,
  LEGACY_TASK_TEXT,
  parseLegacyTaskButton,
  replyWithReceipt,
  resumeLegacyMacTask,
  type LegacyMacResumeDeps,
  type LegacyTaskClaim,
} from "../src/lib/legacy-task-buttons";
import type { TaskStore } from "../src/lib/store/ports";
import type { AsyncTask, TaskChanges } from "../src/lib/store/types";
import { resumeMacTask, type TaskResumeDeps } from "../src/lib/task-resume";
import { useChoiceFile } from "./choices-fixture";

const OWNER = "4711";
const GROUP = "-1001234567890";
const dir = mkdtempSync(join(tmpdir(), "tybo-legacy-task-"));
let n = 0;

/** Auftragsspeicher im Speicher, mit Fehlerschaltern wie TaskStore (null bzw. false) */
function memoryTasks() {
  const rows = new Map<string, AsyncTask>();
  const sw = { byId: true as boolean | "throw", update: (_c: TaskChanges) => true as boolean | "throw", beforeUpdate: async () => {} };
  let next = 0;
  const store = {
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
      await sw.beforeUpdate();
      const row = rows.get(taskId);
      const ok = sw.update(changes);
      if (ok === "throw") throw new Error("Speicher weg");
      if (!row || !ok) return false;
      for (const [k, v] of Object.entries(changes)) if (v !== undefined) (row as any)[k] = structuredClone(v);
      return true;
    },
    async byId(taskId: string) {
      if (sw.byId === "throw") throw new Error("Speicher weg");
      if (!sw.byId) return null;
      const row = rows.get(taskId);
      return row ? structuredClone(row) : null;
    },
  } as unknown as TaskStore;
  return { store, rows, sw };
}

let tasks: ReturnType<typeof memoryTasks>;
let runs: (EngineRequest & { engine: EngineId })[];
let engineReply: (req: EngineRequest, engine: EngineId) => Promise<EngineResult>;
let logSpy: ReturnType<typeof spyOn>;

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
  resolveModel: () => "modell-von-heute",
  resolveEffort: () => undefined,
  allowedTools: () => undefined,
  cwd: dir,
};

beforeEach(() => {
  useChoiceFile(join(dir, `choices-${++n}.json`));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  tasks = memoryTasks();
  runs = [];
  engineReply = async (req, engine) => ({ engine, text: "Erledigt, Bericht liegt bereit.", sessionId: req.resumeSessionId, isError: false });
});
afterEach(() => logSpy.mockRestore());
afterAll(() => {
  setChoicesFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

const topic = { chatId: GROUP, threadId: 443 };
const dm = { chatId: OWNER };

async function oldTask(place: { chatId: string; threadId?: number } = topic, patch: Partial<AsyncTask> = {}): Promise<AsyncTask> {
  const t = (await tasks.store.create(place.chatId, "Plane die Woche", place.threadId))!;
  Object.assign(tasks.rows.get(t.id)!, {
    status: "needs_input",
    session_id: "sess-alt",
    pending_question: "Welcher Tag?",
    pending_options: [
      { label: "1. Montag", value: "1" },
      { label: "2. Dienstag", value: "2" },
    ],
    metadata: { agent_name: "research", engine: "claude", model: "claude-modell-der-frage" },
    ...patch,
  });
  return structuredClone(tasks.rows.get(t.id)!);
}

const claim = (data: string, place: { chatId: string; threadId?: number } = topic) =>
  claimLegacyTaskButton(data, place, { directChatIds: () => [OWNER, "web"], tasks: () => tasks.store, log: () => {} });
const row = (id: string) => tasks.rows.get(id)!;

/** Wie src/bot.ts: beanspruchen, dann der Mac-Zweig */
function macDeps(conversation: ChoiceConversation, patch: Partial<LegacyMacResumeDeps> = {}) {
  const replies: string[] = [];
  const notices: string[] = [];
  const saved: any[] = [];
  const intents: { text: string; target: unknown }[] = [];
  const offers: AskOffer[] = [];
  const deps: LegacyMacResumeDeps = {
    conversation,
    reply: async text => (replies.push(text), true),
    notice: async text => void notices.push(text),
    saveMessage: async message => void saved.push(message),
    abortedText: () => "Abgebrochen.",
    tasks: () => tasks.store,
    resume: (task, chatId, answer, channel) => resumeMacTask(task, chatId, answer, resumeDeps, channel),
    processIntents: async (text, _tools, target) => void intents.push({ text, target }),
    offer: async o => (offers.push(o), { status: "unavailable" }),
    log: () => {},
    ...patch,
  };
  return { deps, replies, notices, saved, intents, offers };
}

describe("Beanspruchen", () => {
  test("gültige Auswahl: running mit der Beschriftung, Nachricht zeigt Frage und Wahl", async () => {
    const old = await oldTask();
    const result = await claim(`atask:${old.id}:2`);
    expect(result).toMatchObject({ status: "claimed", answer: "2. Dienstag", text: LEGACY_TASK_TEXT.chosen("Welcher Tag?", "2. Dienstag") });
    expect(row(old.id)).toMatchObject({ status: "running", user_response: "2. Dienstag" });
  });

  test("abbrechen: failed mit deutschem Ergebnis, Nachricht zeigt „Abgebrochen.“, kein Motor", async () => {
    const old = await oldTask();
    expect(await claim(`atask:${old.id}:cancel`)).toEqual({ status: "cancelled", text: LEGACY_TASK_TEXT.cancelled("Welcher Tag?") });
    expect(row(old.id)).toMatchObject({ status: "failed", result: "Vom Nutzer abgebrochen", user_response: "Abbrechen" });
    expect(runs).toEqual([]);
  });

  test("unbekannter und nicht lesbarer Auftrag: „gilt nicht mehr“ (für den Speicher dasselbe), nichts geschrieben", async () => {
    expect(await claim("atask:task-99:1")).toEqual({ status: "rejected", text: ASK_TEXT.stale, keepButtons: false });
    const old = await oldTask();
    for (const read of [false, "throw"] as const) {
      tasks.sw.byId = read;
      expect(await claim(`atask:${old.id}:1`)).toEqual({ status: "rejected", text: ASK_TEXT.stale, keepButtons: false });
    }
    tasks.sw.byId = true;
    expect(row(old.id).status).toBe("needs_input");
  });

  test("ungültige Kennung: nie als Sperrdatei benutzt, abgewiesen", async () => {
    for (const data of ["atask:../x:1", "atask::1", "atask:a/b:1", "atask:task-1", "atask:" + "a".repeat(65) + ":1"]) {
      expect(parseLegacyTaskButton(data)).toBeNull();
      expect(await claim(data)).toEqual({ status: "rejected", text: ASK_TEXT.stale, keepButtons: false });
    }
    expect(parseLegacyTaskButton("atask:task-1:a:b")).toEqual({ taskId: "task-1", choice: "a:b" });
  });

  test("laufend: „bereits beantwortet“; erledigt und gescheitert: „bereits erledigt“; nichts geändert", async () => {
    const cases = [
      ["running", LEGACY_TASK_TEXT.answered],
      ["completed", LEGACY_TASK_TEXT.done],
      ["failed", LEGACY_TASK_TEXT.done],
    ] as const;
    for (const [status, text] of cases) {
      const old = await oldTask(topic, { status });
      const before = structuredClone(row(old.id));
      expect(await claim(`atask:${old.id}:1`)).toEqual({ status: "rejected", text, keepButtons: false });
      expect(await claim(`atask:${old.id}:cancel`)).toEqual({ status: "rejected", text, keepButtons: false });
      expect(row(old.id)).toEqual(before);
    }
  });

  test("Auftrag des Registers: abgewiesen wie bisher, Rückfrage bleibt offen", async () => {
    const offer = createAskOffer({ sendChoice: async () => ({ sent: true }), tasks: () => tasks.store, log: () => {} });
    const outcome = await offer({
      conversation: { type: "telegram", chatId: GROUP, topicId: 443 },
      question: "Soll ich?",
      options: ["Ja", "Nein"],
      originalPrompt: "x",
      agent: "general",
      engine: "claude",
      model: "",
    });
    if (outcome.status !== "offered") throw new Error(outcome.status);
    const before = structuredClone(row(outcome.taskId));
    expect(await claim(`atask:${outcome.taskId}:o0`)).toEqual({ status: "rejected", text: ASK_TEXT.stale, keepButtons: false });
    expect(await claim(`atask:${outcome.taskId}:cancel`)).toEqual({ status: "rejected", text: ASK_TEXT.stale, keepButtons: false });
    expect(row(outcome.taskId)).toEqual(before);
    expect((await listChoices())[0].state).toBe("open");
  });

  test("fremdes Gespräch: anderes Topic, General, Direktchat für einen Topic-Auftrag; Auftrag unverändert", async () => {
    const old = await oldTask(topic);
    const before = structuredClone(row(old.id));
    for (const place of [{ chatId: GROUP, threadId: 500 }, { chatId: GROUP }, dm, { chatId: "-100999", threadId: 443 }]) {
      expect(await claim(`atask:${old.id}:1`, place)).toEqual({ status: "rejected", text: LEGACY_TASK_TEXT.foreign, keepButtons: false });
      expect(await claim(`atask:${old.id}:cancel`, place)).toEqual({ status: "rejected", text: LEGACY_TASK_TEXT.foreign, keepButtons: false });
    }
    expect(row(old.id)).toEqual(before);
  });

  test("Direktchat: Auftrag unter \"web\" ist aus dem Telegram-Direktchat entscheidbar, General gilt als Gruppe ohne Topic", async () => {
    const web = await oldTask({ chatId: "web" });
    expect((await claim(`atask:${web.id}:1`, dm)).status).toBe("claimed");
    const general = await oldTask({ chatId: GROUP });
    expect((await claim(`atask:${general.id}:1`, { chatId: GROUP })).status).toBe("claimed");
  });

  test("Auswahl nicht unter den Antworten: abgewiesen, Knöpfe bleiben, Auftrag wartet weiter", async () => {
    const old = await oldTask();
    expect(await claim(`atask:${old.id}:7`)).toEqual({ status: "rejected", text: LEGACY_TASK_TEXT.unknownOption, keepButtons: true });
    const bare = await oldTask(topic, { pending_options: undefined });
    expect(await claim(`atask:${bare.id}:1`)).toEqual({ status: "rejected", text: LEGACY_TASK_TEXT.unknownOption, keepButtons: true });
    expect(row(old.id).status).toBe("needs_input");
  });

  test("Doppelklick, auch gleichzeitig: genau einer beansprucht, der Motor läuft genau einmal", async () => {
    const old = await oldTask();
    // Das Schreiben dauert: der zweite Klick wartet an der Sperre und findet danach running
    tasks.sw.beforeUpdate = () => Bun.sleep(30);
    const results = await Promise.all([claim(`atask:${old.id}:1`), claim(`atask:${old.id}:2`), claim(`atask:${old.id}:1`)]);
    const claimed = results.filter((r): r is Extract<LegacyTaskClaim, { status: "claimed" }> => r.status === "claimed");
    expect(claimed).toHaveLength(1);
    expect(results.filter(r => r.status === "rejected").map(r => (r as any).text)).toEqual([LEGACY_TASK_TEXT.answered, LEGACY_TASK_TEXT.answered]);
    // Auch „Abbrechen“ danach ändert nichts mehr
    expect(await claim(`atask:${old.id}:cancel`)).toEqual({ status: "rejected", text: LEGACY_TASK_TEXT.answered, keepButtons: false });
    const m = macDeps({ type: "telegram", chatId: GROUP, topicId: 443 });
    await resumeLegacyMacTask(claimed[0].task, claimed[0].answer, topic, m.deps);
    expect(runs).toHaveLength(1);
    expect(row(old.id).status).toBe("completed");
  });

  test("gleichzeitig „Abbrechen“ und eine Antwort: genau einer gewinnt, kein zweiter Zustand", async () => {
    for (let i = 0; i < 3; i++) {
      const old = await oldTask();
      tasks.sw.beforeUpdate = () => Bun.sleep(10);
      const results = await Promise.all([claim(`atask:${old.id}:cancel`), claim(`atask:${old.id}:1`)]);
      expect(results.filter(r => r.status !== "rejected")).toHaveLength(1);
      expect(["failed", "running"]).toContain(row(old.id).status);
    }
  });

  test("Speicherfehler beim Beanspruchen (false, Ausnahme, Sperre): kein Motor, Knöpfe bleiben, Auftrag entscheidbar; ebenso bei „Abbrechen“", async () => {
    const old = await oldTask();
    for (const value of ["1", "cancel"]) {
      for (const result of [false, "throw"] as const) {
        tasks.sw.update = () => result;
        expect(await claim(`atask:${old.id}:${value}`)).toEqual({ status: "rejected", text: LEGACY_TASK_TEXT.notSaved, keepButtons: true });
        expect(row(old.id).status).toBe("needs_input");
      }
    }
    tasks.sw.update = () => true;
    const locked = await claimLegacyTaskButton(`atask:${old.id}:1`, topic, {
      directChatIds: () => [OWNER],
      tasks: () => tasks.store,
      lock: async () => {
        throw new Error("gesperrt");
      },
      log: () => {},
    });
    expect(locked).toEqual({ status: "rejected", text: LEGACY_TASK_TEXT.notSaved, keepButtons: true });
    expect(runs).toEqual([]);
    // Danach wieder entscheidbar
    expect((await claim(`atask:${old.id}:1`)).status).toBe("claimed");
  });
});

describe("Fortsetzen im Mac-Zweig", () => {
  async function claimed(data: (id: string) => string = id => `atask:${id}:1`) {
    const old = await oldTask();
    const result = await claim(data(old.id));
    if (result.status !== "claimed") throw new Error(result.status);
    return result;
  }
  const conv: ChoiceConversation = { type: "telegram", chatId: GROUP, topicId: 443 };

  test("über resumeMacTask mit Session, Motor und Modell der Frage; Antwort gespeichert (mit Topic), gezeigt, Auftrag completed", async () => {
    const c = await claimed();
    const m = macDeps(conv);
    expect(await resumeLegacyMacTask(c.task, c.answer, topic, m.deps)).toEqual({ status: "replied", response: "Erledigt, Bericht liegt bereit." });
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ engine: "claude", resumeSessionId: "sess-alt", model: "claude-modell-der-frage" });
    expect(runs[0].prompt).toContain("1. Montag");
    expect(m.saved).toEqual([
      { chat_id: GROUP, role: "assistant", content: "Erledigt, Bericht liegt bereit.", metadata: { type: "task_resume", taskId: c.task.id, agent: "research", topicId: 443 } },
    ]);
    expect(m.intents).toEqual([{ text: "Erledigt, Bericht liegt bereit.", target: { chatId: GROUP, topicId: 443, origin: "Telegram" } }]);
    expect(m.replies).toEqual(["Erledigt, Bericht liegt bereit."]);
    expect(row(c.task.id)).toMatchObject({ status: "completed", result: "Erledigt, Bericht liegt bereit.", session_id: "sess-alt" });
    expect(m.offers).toEqual([]);
  });

  test("Folgefrage: Register-Rückfrage an einem neuen Auftrag mit Session, Motor und Modell der Fortsetzung; alter Auftrag completed, keine atask-Knöpfe", async () => {
    const c = await claimed();
    engineReply = async (req, engine) => ({
      engine,
      text: "Montag passt. [FRAGE: Soll ich den Termin eintragen? | Ja | Nein]",
      sessionId: "sess-neu",
      isError: false,
    });
    // Echter offerAsk-Weg: neuer Auftrag im Speicher, Frage im Register
    const offer = createAskOffer({ sendChoice: async () => ({ sent: true }), tasks: () => tasks.store, log: () => {} });
    const m = macDeps(conv, { offer });
    const out = await resumeLegacyMacTask(c.task, c.answer, topic, m.deps);
    expect(out.status).toBe("replied");
    // Tag lesbar gemacht, bevor gespeichert und gezeigt
    expect(m.replies[0]).not.toContain("[FRAGE:");
    expect(m.saved[0].content).toBe(m.replies[0]);
    expect(row(c.task.id)).toMatchObject({ status: "completed", session_id: "sess-neu" });
    const choices = await listChoices();
    expect(choices).toHaveLength(1);
    expect(choices[0]).toMatchObject({ kind: "ask", text: "Soll ich den Termin eintragen?", conversation: conv });
    const ref = parseAskRef(choices[0].ref)!;
    expect(ref.taskId).not.toBe(c.task.id);
    expect(row(ref.taskId)).toMatchObject({
      status: "needs_input",
      chat_id: GROUP,
      thread_id: 443,
      session_id: "sess-neu",
      original_prompt: "Plane die Woche",
      metadata: { agent_name: "research", engine: "claude", model: "claude-modell-der-frage", ask_id: ref.askId },
    });
    expect(JSON.stringify(m.replies)).not.toContain("atask:");
  });

  test("Motorfehler und Zeitlimit: keine Antwort, keine Merk-Tags, keine Folgefrage, Auftrag failed", async () => {
    for (const failure of ["isError", "timedOut"] as const) {
      const c = await claimed();
      engineReply = async (_req, engine) => ({ engine, text: "Fehler. [FRAGE: Nochmal? | Ja | Nein]", isError: failure === "isError", ...(failure === "timedOut" ? { timedOut: true } : {}) }) as EngineResult;
      const m = macDeps(conv);
      expect(await resumeLegacyMacTask(c.task, c.answer, topic, m.deps)).toEqual({ status: "ended" });
      expect(m.replies).toEqual([]);
      expect(m.saved).toEqual([]);
      expect(m.intents).toEqual([]);
      expect(m.offers).toEqual([]);
      expect(m.notices).toEqual([failure === "timedOut" ? ASK_TEXT.timedOut : ASK_TEXT.failed]);
      expect(row(c.task.id).status).toBe("failed");
    }
  });

  test("ohne Session: bestätigt, completed, kein Motor", async () => {
    const old = await oldTask(topic, { session_id: undefined });
    const c = await claim(`atask:${old.id}:1`);
    if (c.status !== "claimed") throw new Error(c.status);
    const m = macDeps(conv);
    expect(await resumeLegacyMacTask(c.task, c.answer, topic, m.deps)).toEqual({ status: "ended" });
    expect(runs).toEqual([]);
    expect(m.notices).toEqual([ASK_TEXT.noted("1. Montag")]);
    expect(row(old.id)).toMatchObject({ status: "completed", result: "Ohne Sitzung bestätigt" });
  });

  test("abgebrochen (/stop) und Ausnahme beim Fortsetzen: Meldung, failed", async () => {
    const a = await claimed();
    const m1 = macDeps(conv, { resume: async () => ({ status: "aborted" }) });
    expect(await resumeLegacyMacTask(a.task, a.answer, topic, m1.deps)).toEqual({ status: "ended" });
    expect(m1.notices).toEqual(["Abgebrochen."]);
    expect(row(a.task.id)).toMatchObject({ status: "failed", result: "Abgebrochen" });
    const b = await claimed();
    const m2 = macDeps(conv, {
      resume: async () => {
        throw new Error("weg");
      },
    });
    expect(await resumeLegacyMacTask(b.task, b.answer, topic, m2.deps)).toEqual({ status: "ended" });
    expect(m2.notices).toEqual([ASK_TEXT.failed]);
    expect(row(b.task.id).status).toBe("failed");
  });

  /** Klick-Context im Topic mit Telegram-Attrappe; sendMessage antwortet nach answer */
  function telegramCtx(answer: (n: number) => "ok" | "rejected" | "network") {
    const calls: { text: string; other: Record<string, any> }[] = [];
    const api = {
      sendMessage: async (_chatId: unknown, text: string, other: Record<string, any> = {}) => {
        calls.push({ text, other });
        const how = answer(calls.length);
        if (how === "rejected") {
          throw new GrammyError("Call to 'sendMessage' failed!", { ok: false, error_code: 400, description: "Bad Request: kaputt" }, "sendMessage", {});
        }
        if (how === "network") throw new Error("Netz weg");
        return { message_id: 700 + calls.length, date: 0, chat: { id: Number(GROUP), type: "supergroup" }, text };
      },
    };
    const update = {
      update_id: 1,
      callback_query: {
        id: "q1",
        from: { id: Number(OWNER), is_bot: false, first_name: "Alex" },
        chat_instance: "ci",
        data: "atask:x:1",
        message: { message_id: 10, date: 0, chat: { id: Number(GROUP), type: "supergroup", title: "G", is_forum: true }, message_thread_id: 443, is_topic_message: true, text: "Frage" },
      },
    };
    const ctx = new Context(update as any, api as any, { id: 1, is_bot: true, first_name: "Bot", username: "bot" } as any);
    return { ctx, calls };
  }

  test("echter Versand (sendResponse über replyWithReceipt): beide Sendeversuche gescheitert, keine Zustellung, keine Folgefrage", async () => {
    for (const failure of ["rejected", "network"] as const) {
      const c = await claimed();
      engineReply = async (_req, engine) => ({ engine, text: "Gut. [FRAGE: Weiter? | Ja | Nein]", sessionId: "s2", isError: false });
      const tg = telegramCtx(() => failure);
      const errors = spyOn(console, "error").mockImplementation(() => {});
      const lines: string[] = [];
      const m = macDeps(conv, { reply: text => replyWithReceipt(tg.ctx, text, sendResponse), log: line => void lines.push(line) });
      try {
        expect(await resumeLegacyMacTask(c.task, c.answer, topic, m.deps)).toEqual({ status: "ended" });
      } finally {
        errors.mockRestore();
      }
      // HTML und Klartext-Rückfall, beide ins Topic, beide gescheitert
      expect(tg.calls).toHaveLength(2);
      expect(tg.calls.map(call => call.other.message_thread_id)).toEqual([443, 443]);
      expect(m.offers).toEqual([]);
      expect(lines).toContain(`[atask] Antwort zu Auftrag ${c.task.id} nicht zugestellt`);
      expect(m.saved).toHaveLength(1);
      expect(row(c.task.id).status).toBe("completed");
    }
  });

  test("echter Versand (sendResponse über replyWithReceipt): angekommen, dann Antwort gezeigt und Folgefrage angeboten", async () => {
    const c = await claimed();
    engineReply = async (_req, engine) => ({ engine, text: "Gut. [FRAGE: Weiter? | Ja | Nein]", sessionId: "s2", isError: false });
    const tg = telegramCtx(() => "ok");
    const m = macDeps(conv, { reply: text => replyWithReceipt(tg.ctx, text, sendResponse) });
    const out = await resumeLegacyMacTask(c.task, c.answer, topic, m.deps);
    expect(out.status).toBe("replied");
    expect(tg.calls).toHaveLength(1);
    expect(tg.calls[0].text).toContain("Gut.");
    expect(tg.calls[0].other.message_thread_id).toBe(443);
    expect(m.offers.map(o => o.question)).toEqual(["Weiter?"]);
  });

  test("Antwort nicht zustellbar: gespeichert, completed, aber keine Folgefrage", async () => {
    const c = await claimed();
    engineReply = async (_req, engine) => ({ engine, text: "Gut. [FRAGE: Weiter? | Ja | Nein]", sessionId: "s2", isError: false });
    const m = macDeps(conv, {
      reply: async () => {
        throw new Error("Telegram weg");
      },
    });
    expect(await resumeLegacyMacTask(c.task, c.answer, topic, m.deps)).toEqual({ status: "ended" });
    expect(m.saved).toHaveLength(1);
    expect(m.offers).toEqual([]);
    expect(row(c.task.id).status).toBe("completed");
  });
});
