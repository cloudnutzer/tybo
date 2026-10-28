// Issue #344: WebUI des laufenden Bots als Verhalten von startBotWeb. Ersetzt
// die Quelltext-Prüfungen der Übergabe an startWebUi in src/bot.ts; die
// WebUI startet hier nicht, startWebUi ist eine Attrappe, die die
// Optionen festhält. bot.ts wird nie importiert.
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentByTopicId } from "../src/agents";
import { startBotWeb, type BotWebDeps } from "../src/app/bot-web";
import { createBotCommandServices } from "../src/app/command-services";
import type { TurnOptions, TurnSink } from "../src/lib/chat-turn";
import type { ChoiceConversation } from "../src/lib/choices";
import { commandRegistry } from "../src/lib/commands/builtin";
import { abortAllExecutions } from "../src/lib/execution-context";
import { getSessionsForKey, recordSessionTurn, sessionEpoch, setSessionsFileForTests } from "../src/lib/session-manager";
import { sessionKeyFor } from "../src/lib/store/message-rules";
import { createTelegramRuntime } from "../src/lib/telegram-runtime";
import type { NoteTurnInput } from "../src/lib/threads/detect";
import { botAgentCatalog } from "../src/web/bot-agents";
import { botInstructions, botSettings, botVoice } from "../src/web/bot-settings";
import type { BotCallPort } from "../src/web/bot-call";
import { createApprovalTurns, mirrorChunks, webMediaDir } from "../src/web/bot-turn";
import { generateVapidKeys } from "../src/web/push";
import type { StartWebUiOptions } from "../src/web/startup";
import { webSessionKey } from "../src/web/store";
import type { TelegramTopicApi } from "../src/web/topics";
import { UploadStore } from "../src/web/uploads";
import { PDF } from "./media-fixture";

async function wire(env: Record<string, string | undefined> = {}, overrides: Partial<BotWebDeps> = {}) {
  let options: StartWebUiOptions | undefined;
  const call = { marker: "telefonhoerer" } as unknown as BotCallPort;
  const restarts: string[] = [];
  const result = await startBotWeb({
    root: "/srv/tybo",
    env,
    runtime: createTelegramRuntime({ env: {}, log: () => {} }),
    choices: { approvalTurns: createApprovalTurns(), routineChoices: {} as never, goalChoices: { decideFromCard: async () => "none" } as never },
    commands: { registry: commandRegistry, services: createBotCommandServices({ routineMenu: async () => false }) },
    call,
    isShuttingDown: () => false,
    scheduleRestartCheck: trigger => void restarts.push(trigger),
    invokeBudget: 3,
    start: async o => ((options = o), null),
    ...overrides,
  });
  return { options: options!, result, call, restarts };
}

describe("startBotWeb", () => {
  test("Agenten über den Katalog, keine eigene Liste; Einstellungen, Anweisungen, Stimme", async () => {
    const { options, result } = await wire();
    expect(result).toBeNull();
    expect(options.agentCatalog).toBe(botAgentCatalog);
    expect("agents" in options).toBe(false);
    expect(options.settings).toBe(botSettings);
    expect(options.instructions).toBe(botInstructions);
    expect(options.voice).toBe(botVoice);
  });

  test("Telefonhörer: derselbe Port wie für den Neustart", async () => {
    const { options, call } = await wire();
    expect(options.call).toBe(call);
  });

  test("Anhänge: eine Ablage unter data/uploads, die die Arbeitskopien der Web-Gespräche kennt", async () => {
    const { options } = await wire();
    expect(options.uploads).toBeInstanceOf(UploadStore);
    expect(options.uploads!.dir).toBe(join("/srv/tybo", "data", "uploads"));
    expect(options.uploads!.mediaDir).toBe(webMediaDir());
  });

  test("Telegram-Quellen, Telegram-Chat, Befehle, Status, Routinen, Motoren, Schlüssel, Ziele und Rückfragen", async () => {
    const { options } = await wire();
    for (const key of ["telegram", "telegramChat", "telegramLive", "commands", "status", "routines", "engines", "keys", "goals", "choices", "speech", "callMemory", "threads", "reminders", "files", "webNotices"] as const) {
      expect(options[key]).toBeDefined();
    }
    // resetSession als Verhalten: „resetSession: löscht beim Löschen eines Web-Gesprächs …“
    expect(options.resetConversation).toBeFunction();
  });

  test("Topics nur mit Telegram (Issue #228)", async () => {
    expect((await wire()).options.topics).toBeUndefined();
    const webOnly = createTelegramRuntime({ env: {}, log: () => {} });
    const topicApi = {} as TelegramTopicApi;
    const runtime = new Proxy(webOnly, { get: (target, key) => (key === "topicApi" ? topicApi : Reflect.get(target, key)) });
    expect((await wire({}, { runtime })).options.topics).toBeDefined();
  });

  test("Push: ohne WebUI keiner; mit WebUI und gültigen Schlüsseln aus der .env", async () => {
    expect((await wire()).options.push).toBeUndefined();
    const keys = await generateVapidKeys();
    const { options } = await wire({ WEB_ENABLED: "true", WEB_PUSH_PUBLIC_KEY: keys.publicKey, WEB_PUSH_PRIVATE_KEY: keys.privateKey });
    expect(options.push?.keys).toEqual(keys);
  });
});

describe("startBotWeb: Telegram-Gespräche aus dem Browser", () => {
  const USER = "4242";
  const GROUP = "-1001234567890";
  const env = { TELEGRAM_BOT_TOKEN: "123:test", TELEGRAM_USER_ID: USER, TELEGRAM_GROUP_ID: GROUP };
  const nullSink: TurnSink = { progress() {}, notice() {} };

  afterEach(() => abortAllExecutions());

  /** Hinweis eines offenen Fadens, am Turn erkennbar */
  const HINT = "Offener Faden: Reiseziel noch nicht entschieden";

  /**
   * Laufzeit ohne Netz: Klartext, Markdown-Versand und Agenten-Bots zeichnen
   * nur auf. Fäden-Anschlüsse beobachtet: threadHint liefert HINT und merkt
   * sich das Gespräch, noteThreads zeichnet nach afterReply auf.
   */
  async function runChat(kind: "telegramChat" | "chat", conversationId: string) {
    const plain: { chatId: string; text: string; threadId?: number }[] = [];
    const markdown: unknown[] = [];
    const agentSends: { agent: string; chatId: string; text: string; options: unknown }[] = [];
    const core: TurnOptions[] = [];
    const goals: string[] = [];
    const hints: ChoiceConversation[] = [];
    const notes: NoteTurnInput[] = [];
    const base = createTelegramRuntime({ env: {}, log: () => {} });
    const runtime = {
      ...base,
      sendPlain: async (chatId: string, text: string, threadId?: number) => void plain.push({ chatId, text, threadId }),
      sendMessage: async (...args: unknown[]) => void markdown.push(args),
      agents: { ...base.agents, sendAsAgent: async (agent: string, chatId: string, text: string, options?: unknown) => void agentSends.push({ agent, chatId, text, options }) },
    };
    const { options } = await wire(env, {
      runtime,
      parts: {
        runStreamingTurn: async o => (core.push(o), "Antwort"),
        saveMessage: async () => true,
        processIntents: async () => {},
        noteThreads: input => void notes.push(input),
        threadHint: async conversation => (hints.push(conversation), HINT),
        onAgentTurn: (key, agent) => void goals.push(`${key}:${agent}`),
      },
    });
    const result = await options[kind]!.runTurn({ conversationId, agent: "general", text: "Frage", sink: nullSink });
    // Nacharbeit nach dem Veröffentlichen, wie der ChatHub sie anstößt
    result.afterReply?.();
    await waitFor(() => notes.length > 0);
    return { result, plain, markdown, agentSends, core, goals, hints, notes };
  }
  const telegramTurn = (conversationId: string) => runChat("telegramChat", conversationId);

  async function waitFor(check: () => boolean): Promise<void> {
    const end = Date.now() + 2000;
    while (!check()) {
      if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
      await Bun.sleep(5);
    }
  }

  test("Topic: Nachricht als Klartext in die Gruppe gespiegelt, Antwort vom Agenten des Topics im selben Thread", async () => {
    const agent = getAgentByTopicId(77, GROUP) || "general";
    const t = await telegramTurn("topic-77");
    expect(t.result.text).toBe("Antwort");
    // Klartext über sendPlain, nie der Markdown-Versand
    expect(t.plain).toEqual(mirrorChunks("Frage").map(text => ({ chatId: GROUP, text, threadId: 77 })));
    expect(t.markdown).toEqual([]);
    expect(t.core.map(o => ({ chatId: o.chatId, topicId: o.topicId, agentName: o.agentName }))).toEqual([{ chatId: GROUP, topicId: 77, agentName: agent }]);
    expect(t.agentSends).toEqual([{ agent, chatId: GROUP, text: "Antwort", options: { threadId: 77 } }]);
    expect(t.goals).toEqual([`${sessionKeyFor(GROUP, 77)}:${agent}`]);
  });

  test("Topic: Faden-Hinweis für Chat und Topic geholt und am Turn, Erkennung danach im selben Topic", async () => {
    const t = await telegramTurn("topic-77");
    const conversation = { type: "telegram", chatId: GROUP, topicId: 77 };
    expect(t.hints).toEqual([conversation]);
    expect(t.core).toHaveLength(1);
    expect(t.core[0].turnHint).toContain(HINT);
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0]).toMatchObject({ conversation, userText: "Frage", reply: "Antwort" });
  });

  test("Direktchat: Ziel ist die Nutzer-ID, ohne Thread, Antwort von general", async () => {
    const t = await telegramTurn("dm");
    expect(t.plain).toEqual(mirrorChunks("Frage").map(text => ({ chatId: USER, text, threadId: undefined })));
    expect(t.markdown).toEqual([]);
    expect(t.core.map(o => ({ chatId: o.chatId, topicId: o.topicId, agentName: o.agentName }))).toEqual([{ chatId: USER, topicId: undefined, agentName: "general" }]);
    expect(t.agentSends).toEqual([{ agent: "general", chatId: USER, text: "Antwort", options: { threadId: undefined } }]);
    // Offene Fäden im Direktchat: Gespräch ohne Topic
    expect(t.hints).toEqual([{ type: "telegram", chatId: USER }]);
    expect(t.core[0].turnHint).toContain(HINT);
    expect(t.notes[0]).toMatchObject({ conversation: { type: "telegram", chatId: USER }, userText: "Frage", reply: "Antwort" });
  });

  test("reines Web-Gespräch: Faden-Hinweis und Erkennung für das Web-Gespräch, nichts nach Telegram", async () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const t = await runChat("chat", id);
    expect(t.result.text).toBe("Antwort");
    const conversation = { type: "web", conversationId: id };
    expect(t.hints).toEqual([conversation]);
    expect(t.core.map(o => o.chatId)).toEqual([`web:${id}`]);
    expect(t.core[0].turnHint).toContain(HINT);
    expect(t.notes).toHaveLength(1);
    expect(t.notes[0]).toMatchObject({ conversation, userText: "Frage", reply: "Antwort" });
    expect(t.plain).toEqual([]);
    expect(t.markdown).toEqual([]);
    expect(t.agentSends).toEqual([]);
  });
});

describe("startBotWeb: Motor-Anzeige, Session-Reset und Anhänge", () => {
  const USER = "4242";
  const GROUP = "-1001234567890";
  const TELEGRAM_ENV = { TELEGRAM_BOT_TOKEN: "123:test", TELEGRAM_USER_ID: USER, TELEGRAM_GROUP_ID: GROUP };
  const WEB_ID = "11111111-2222-4333-8444-555555555555";
  const nullSink: TurnSink = { progress() {}, notice() {} };

  afterEach(() => abortAllExecutions());

  test("Motor-Port: Session-Schlüssel von Direktchat, Topic und Web-Gespräch wie beim Schreiben", async () => {
    const engines = (await wire(TELEGRAM_ENV)).options.engines!;
    expect(engines.sessionKey("dm")).toBe(sessionKeyFor(USER));
    expect(engines.sessionKey("topic-77")).toBe(sessionKeyFor(GROUP, 77));
    expect(engines.sessionKey(WEB_ID)).toBe(sessionKeyFor(`web:${WEB_ID}`));
  });

  test("Motor-Port ohne Telegram: Direktchat unter web (Issue #227), Topics ohne Schlüssel", async () => {
    const engines = (await wire()).options.engines!;
    expect(engines.sessionKey("dm")).toBe(sessionKeyFor("web"));
    expect(engines.sessionKey("topic-77")).toBeNull();
    expect(engines.sessionKey(WEB_ID)).toBe(sessionKeyFor(`web:${WEB_ID}`));
  });

  test("resetSession: löscht beim Löschen eines Web-Gesprächs alle Sessions seines Schlüssels und nur diese", async () => {
    const dir = await mkdtemp(join(tmpdir(), "app-bot-web-sessions-"));
    setSessionsFileForTests(join(dir, "sessions.json"));
    try {
      const { options } = await wire();
      // Derselbe Schlüssel, den der Server beim Löschen übergibt und unter dem der Web-Turn schreibt
      const key = webSessionKey(WEB_ID);
      expect(key).toBe(options.engines!.sessionKey(WEB_ID)!);
      const other = webSessionKey("66666666-7777-4888-8999-000000000000");
      expect(await recordSessionTurn(key, "general", "m", "claude", "s1")).toBe(true);
      expect(await recordSessionTurn(key, "research", "m", "claude", "s2")).toBe(true);
      expect(await recordSessionTurn(other, "general", "m", "claude", "s3")).toBe(true);
      const epoch = sessionEpoch(key);

      expect(await options.resetSession!(key)).toBe(2);
      expect(await getSessionsForKey(key)).toEqual([]);
      expect((await getSessionsForKey(other)).map(s => s.engineSessionId)).toEqual(["s3"]);
      // Ein laufender Turn des Gesprächs speichert seine Session danach nicht mehr
      expect(sessionEpoch(key)).toBeGreaterThan(epoch);
    } finally {
      setSessionsFileForTests(null);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("Web-Turn mit Anhang aus der übergebenen Ablage; Löschen des Gesprächs räumt die Arbeitskopie weg", async () => {
    const root = await mkdtemp(join(tmpdir(), "app-bot-web-uploads-"));
    const id = crypto.randomUUID();
    const working = join(webMediaDir(), id);
    const prompts: string[] = [];
    try {
      const { options } = await wire({}, {
        root,
        parts: {
          runStreamingTurn: async o => (prompts.push(o.userMessage), "Gelesen"),
          saveMessage: async () => true,
          processIntents: async () => {},
          noteThreads: () => {},
          threadHint: async () => undefined,
          onAgentTurn: () => {},
        },
      });
      const uploads = options.uploads!;
      const saved = await uploads.save(id, PDF, "Bericht.pdf");
      if (!saved.ok) throw new Error(saved.error);

      const result = await options.chat.runTurn({ conversationId: id, agent: "general", text: "Fass das zusammen", sink: nullSink, attachments: [saved.attachment] });
      expect(result.text).toBe("Gelesen");
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(`[User sent a document saved at: ${working}/`);
      expect(prompts[0]).toContain("filename: Bericht.pdf");
      expect(await readdir(working)).toHaveLength(1);

      // Die Ablage kennt den Ordner der Arbeitskopien des Web-Turns
      await uploads.removeConversation(id);
      expect(await stat(working).catch(() => null)).toBeNull();
    } finally {
      await rm(working, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
