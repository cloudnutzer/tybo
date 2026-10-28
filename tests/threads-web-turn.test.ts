// Offene Fäden im Web-Weg (Issue #290): die Erkennung startet erst, wenn
// chat.ts die Antwort gespeichert und veröffentlicht hat, und blockiert nichts.
// Attrappen statt Claude, Aux-Modell und Telegram; src/bot.ts wird nicht geladen.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TurnOptions, TurnSink } from "../src/lib/chat-turn";
import { abortAllExecutions } from "../src/lib/execution-context";
import { ChatHub, type RunTurnOptions } from "../src/web/chat";
import { createBotChat, createTelegramChat, type BotChatDeps, type TelegramChatDeps } from "../src/web/bot-turn";
import { ConversationStore, type NewMessage } from "../src/web/store";
import { noteTurnForThreads, threadConversation, type NoteTurnInput, type ThreadDetectDeps } from "../src/lib/threads/detect";
import { listOpenThreads, setThreadsFileForTests } from "../src/lib/threads/store";
import { THREADS_USER_CHARS } from "../src/lib/threads/detect";
import { webMediaDir } from "../src/web/bot-turn";
import type { WebServer } from "../src/web/server";
import { GROUP as FIXTURE_GROUP, TOPIC, fakeTelegramChat, startAttachmentServer, type AttachmentCtx } from "./attachments-fixture";
import { OGG_OPUS } from "./media-fixture";

const GROUP = "-1001234567890";
const USER = "4242";
const REPLY = "Hamburg hat den Hafen, München die Berge. Wohin soll es gehen, Hamburg oder München?";
const OPEN = JSON.stringify({ open: true, topic: "Reiseziel", context: "Hamburg oder München.", question: "Hamburg oder München?", deadline: null });

const root = await mkdtemp(join(tmpdir(), "tybo-threads-web-"));
let counter = 0;
let logSpy: ReturnType<typeof spyOn>;
afterAll(() => rm(root, { recursive: true, force: true }));
beforeEach(() => {
  setThreadsFileForTests(join(root, `threads-${++counter}.json`));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  abortAllExecutions();
  setThreadsFileForTests(null);
  logSpy.mockRestore();
});

async function waitUntil(check: () => boolean | Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

const nullSink: TurnSink = { progress() {}, notice() {} };

function baseDeps(reply: string, steps: string[]): BotChatDeps {
  return {
    runStreamingTurn: async (_o: TurnOptions) => reply,
    saveMessage: async () => true,
    processIntents: async () => {
      steps.push("intents");
    },
    abortEngineCalls: () => 0,
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
  };
}

/** Aux-Attrappe, die hängt, bis der Test sie freigibt */
function blockedAux() {
  const calls: string[] = [];
  let release!: (text: string) => void;
  const gate = new Promise<string>(r => (release = r));
  const deps: Partial<ThreadDetectDeps> = {
    callAux: async (_purpose, prompt) => {
      calls.push(prompt);
      return { text: await gate, isError: false };
    },
    listChoices: async () => [],
    pendingAskUser: async () => [],
    env: {},
    log: () => {},
  };
  return { calls, release, deps };
}

describe("reines Web-Gespräch über ChatHub", () => {
  test("Antwort ist gespeichert und veröffentlicht, bevor die Erkennung startet; blockierte Erkennung hält nichts auf", async () => {
    const steps: string[] = [];
    class TracingStore extends ConversationStore {
      override async appendMessage(id: string, msg: NewMessage) {
        const stored = await super.appendMessage(id, msg);
        steps.push(`append:${msg.role}`);
        return stored;
      }
    }
    const store = new TracingStore({ dir: join(root, `hub-${++counter}`) });
    await store.load();
    const aux = blockedAux();
    const notes: NoteTurnInput[] = [];
    const chat = createBotChat({
      ...baseDeps(REPLY, steps),
      noteThreads: input => {
        steps.push("threads");
        notes.push(input);
        noteTurnForThreads(input, aux.deps);
      },
    });
    const hub = new ChatHub({ store, chat });
    const conv = await store.createConversation("general");

    expect((await hub.send(conv, "Ich überlege, wohin ich fahre. Hilf mir.")).status).toBe("started");
    // Der Turn ist fertig und das Gespräch frei, obwohl das Aux-Modell noch hängt
    await waitUntil(() => !hub.isRunning(conv.id));
    // Die Erkennung startet nach dem Turn und läuft unabhängig weiter: unter
    // Last kommt ihr Aufruf erst kurz nach dem Ende des Turns an
    await waitUntil(() => aux.calls.length === 1);
    const messages = await store.getMessages(conv.id);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", text: REPLY });
    expect(steps).toEqual(["append:user", "intents", "append:assistant", "threads"]);
    expect(notes[0]).toMatchObject({ conversation: { type: "web", conversationId: conv.id }, userText: "Ich überlege, wohin ich fahre. Hilf mir.", reply: REPLY });
    expect(await listOpenThreads()).toEqual([]);

    // Ein weiterer Turn im selben Gespräch läuft, während die erste Erkennung noch hängt
    expect((await hub.send(conv, "Noch was")).status).toBe("started");
    await waitUntil(() => !hub.isRunning(conv.id));
    expect((await store.getMessages(conv.id)).filter(m => m.role === "assistant").length).toBe(2);

    aux.release(OPEN);
    await waitUntil(async () => (await listOpenThreads()).length === 1);
    expect((await listOpenThreads())[0].conversation).toEqual({ type: "web", conversationId: conv.id });
  });

  test("ohne noteThreads und bei Denkaufträgen ohne Telegram kein afterReply", async () => {
    const plain = createBotChat(baseDeps(REPLY, []));
    const turn = (noTelegram = false): RunTurnOptions => ({ conversationId: "0c1a2b3c-0000-4000-8000-000000000000", agent: "general", text: "x", sink: nullSink, ...(noTelegram ? { noTelegram } : {}) });
    expect((await plain.runTurn(turn())).afterReply).toBeUndefined();
    const notes: NoteTurnInput[] = [];
    const withThreads = createBotChat({ ...baseDeps(REPLY, []), noteThreads: i => notes.push(i) });
    expect((await withThreads.runTurn(turn(true))).afterReply).toBeUndefined();
    const result = await withThreads.runTurn(turn());
    expect(typeof result.afterReply).toBe("function");
    expect(notes).toEqual([]);
    result.afterReply!();
    expect(notes[0].conversation).toEqual({ type: "web", conversationId: "0c1a2b3c-0000-4000-8000-000000000000" });
    expect(notes[0].turnStartedAt).toBeLessThanOrEqual(Date.now());
  });

  test("ein werfendes afterReply beendet den Turn trotzdem sauber", async () => {
    const store = new ConversationStore({ dir: join(root, `hub-${++counter}`) });
    await store.load();
    const logs: string[] = [];
    const chat = createBotChat({ ...baseDeps(REPLY, []), noteThreads: () => { throw new Error(REPLY); } });
    const hub = new ChatHub({ store, chat, log: m => logs.push(m) });
    const conv = await store.createConversation("general");
    await hub.send(conv, "Frage");
    await waitUntil(() => !hub.isRunning(conv.id));
    expect((await store.getMessages(conv.id)).at(-1)).toMatchObject({ role: "assistant", text: REPLY });
    expect(logs).toEqual([`Nacharbeit nach der Antwort in Gespräch ${conv.id} fehlgeschlagen (Error)`]);
  });
});

describe("Telegram-Gespräche im Browser: dieselbe Gesprächskennung wie in Telegram", () => {
  function telegramChat(reply: string, notes: NoteTurnInput[], extra: Partial<TelegramChatDeps> = {}) {
    return createTelegramChat({
      ...baseDeps(reply, []),
      userId: USER,
      groupId: () => GROUP,
      agentForTopic: topicId => (topicId === 443 ? "cto" : undefined),
      sendPlain: async () => {},
      sendAsAgent: async () => {},
      noteThreads: i => notes.push(i),
      ...extra,
    });
  }
  const turn = (conversationId: string, noTelegram = false): RunTurnOptions => ({ conversationId, agent: "general", text: "Frage", sink: nullSink, ...(noTelegram ? { noTelegram } : {}) });

  test("Topic, General, Direktchat und Direktchat ohne Telegram", async () => {
    const notes: NoteTurnInput[] = [];
    const chat = telegramChat(REPLY, notes);
    for (const id of ["topic-443", "topic-1", "dm"]) (await chat.runTurn(turn(id))).afterReply!();
    expect(notes.map(n => n.conversation)).toEqual([
      { type: "telegram", chatId: GROUP, topicId: 443 },
      { type: "telegram", chatId: GROUP },
      { type: "telegram", chatId: USER },
    ]);
    // gleiche Kennung wie der Telegram-Weg in src/bot.ts (threadConversation mit message_thread_id)
    expect(notes[0].conversation).toEqual(threadConversation(GROUP, 443)!);
    expect(notes[1].conversation).toEqual(threadConversation(GROUP, undefined)!);
    expect(notes[2].conversation).toEqual(threadConversation(USER)!);

    const webOnly: NoteTurnInput[] = [];
    (await telegramChat(REPLY, webOnly, { userId: "web" }).runTurn(turn("dm"))).afterReply!();
    expect(webOnly[0].conversation).toEqual({ type: "telegram", chatId: "web" });
  });

  test("Denkauftrag ohne Telegram: kein Faden", async () => {
    const notes: NoteTurnInput[] = [];
    expect((await telegramChat(REPLY, notes).runTurn(turn("topic-443", true))).afterReply).toBeUndefined();
  });

  test("[INVOKE:] bleibt Nacharbeit, afterReply kommt zusätzlich", async () => {
    const notes: NoteTurnInput[] = [];
    const reply = `${REPLY}\n[INVOKE:critic|Passt das?]`;
    const result = await telegramChat(reply, notes, { invokeBudget: 3 }).runTurn(turn("topic-443"));
    expect(typeof result.followUp).toBe("function");
    expect(typeof result.afterReply).toBe("function");
  });
});

describe("Sprachaufnahme aus dem Browser: Transkript als Nutzertext", () => {
  const servers: WebServer[] = [];
  afterEach(async () => {
    for (const s of servers.splice(0)) await s.stop();
  });
  // Anfang, der beim Kürzen auf THREADS_USER_CHARS wegfällt; das Ende nennt die Frist
  const TRANSCRIPT = `ANFANG ${"Vorgeschichte zum Bescheid. ".repeat(30)}Der Widerspruch muss bis Freitag raus.`;
  const QUESTION_ONLY = "Soll ich den Widerspruch vorbereiten?";
  const DEADLINE = JSON.stringify({ open: true, topic: "Widerspruch", context: "Widerspruch gegen den Bescheid.", question: QUESTION_ONLY, deadline: "2026-10-16" });

  function aux() {
    const prompts: string[] = [];
    const deps: Partial<ThreadDetectDeps> = {
      callAux: async (_purpose, prompt) => {
        prompts.push(prompt);
        return { text: DEADLINE, isError: false };
      },
      listChoices: async () => [],
      pendingAskUser: async () => [],
      env: {},
      log: () => {},
    };
    return { prompts, deps };
  }

  async function sendVoice(ctx: AttachmentCtx, conversationId: string): Promise<void> {
    const res = await ctx.upload(conversationId, OGG_OPUS, { "x-file-name": "aufnahme.ogg" });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    expect((await ctx.api(`/api/conversations/${conversationId}/messages`, { method: "POST", body: { text: "", attachments: [id] } })).status).toBe(202);
  }

  function expectPrompt(prompt: string): void {
    const user = prompt.slice(prompt.indexOf("Nutzer-Nachricht (Ende):"), prompt.indexOf("Antwort des Assistenten (Ende):"));
    expect(user).toContain("Der Widerspruch muss bis Freitag raus.");
    expect(user).not.toContain("ANFANG");
    expect(user.length).toBeLessThan(THREADS_USER_CHARS + 100);
  }

  test("reines Web-Gespräch", async () => {
    const dir = join(root, `voice-${++counter}`);
    const mediaRoot = join(dir, "uploads-media");
    const a = aux();
    const ctx = await startAttachmentServer({
      dir,
      servers,
      mediaDir: webMediaDir(mediaRoot),
      webChat: uploads =>
        createBotChat({
          ...baseDeps(QUESTION_ONLY, []),
          uploads,
          media: {
            uploadsDir: mediaRoot,
            unlink: async () => {},
            uploadAssetQuick: async () => ({ id: "asset-1" }) as any,
            updateAssetDescription: async () => true,
            transcribeAudio: async () => TRANSCRIPT,
            logError: () => {},
          },
          noteThreads: input => noteTurnForThreads(input, a.deps),
        }),
    });
    await sendVoice(ctx, ctx.webConversationId);
    await waitUntil(async () => (await listOpenThreads()).length === 1);
    expect(a.prompts.length).toBe(1);
    expectPrompt(a.prompts[0]);
    expect((await listOpenThreads())[0]).toMatchObject({ conversation: { type: "web", conversationId: ctx.webConversationId }, deadline: "2026-10-16" });
  });

  test("Telegram-Topic im Browser", async () => {
    const dir = join(root, `voice-${++counter}`);
    const a = aux();
    const { rec, factory } = fakeTelegramChat(join(dir, "media"), { noteThreads: input => noteTurnForThreads(input, a.deps) });
    rec.core = async () => QUESTION_ONLY;
    rec.transcribe = async () => TRANSCRIPT;
    const ctx = await startAttachmentServer({ dir, servers, telegramChat: factory });
    await sendVoice(ctx, TOPIC);
    await waitUntil(async () => (await listOpenThreads()).length === 1);
    expect(a.prompts.length).toBe(1);
    expectPrompt(a.prompts[0]);
    expect((await listOpenThreads())[0]).toMatchObject({ conversation: { type: "telegram", chatId: FIXTURE_GROUP, topicId: 443 }, deadline: "2026-10-16" });
  });
});

// Anschluss im Bot (Issue #344), als Verhalten: Text und Erwähnung mit Fäden in
// tests/telegram-text-inbox.test.ts (threads: true), der Agenten-Turn der Befehle ohne in
// tests/telegram-commands.test.ts, Medien über den gemeinsamen Abschluss in
// tests/bot-media-topic.test.ts, Anruf-Aufgaben in tests/phone-task-turn.test.ts, die Knopf-Weiche
// in tests/telegram-callbacks.test.ts, Ziel-Turns über goalAgentCall in tests/app-bot-turns.test.ts

