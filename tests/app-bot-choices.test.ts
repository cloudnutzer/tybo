// Issue #344: Rückfragen des laufenden Bots als Verhalten von wireBotChoices
// (ersetzt die Quelltext-Prüfungen der Handler und Zustellwege in bot.ts).
// Prozessweite Anmeldungen sind Attrappen, damit im Testprozess nichts hängen bleibt.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createChoicePostWeb, wireBotChoices, type BotChoicesDeps, type ChoiceInstallers } from "../src/app/bot-choices";
import { createBotCommandServices } from "../src/app/command-services";
import { createBotNotices } from "../src/lib/bot-notices";
import { decideChoice, getChoice, onChoiceDecided, setChoicesFileForTests, type Choice, type ChoiceConversation, type ChoiceHandler, type ChoiceKind } from "../src/lib/choices";
import { commandRegistry } from "../src/lib/commands/builtin";
import { CORE_COMMAND_TEXT } from "../src/lib/commands/core";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { ReviewDecision } from "../src/lib/intent-gate";
import { coreDraftFile, coreForPrompt } from "../src/lib/memory/core";
import { CORE_ADOPT, CORE_CHOICE_TEXT, CORE_SOURCE } from "../src/lib/memory/core-choices";
import { REVIEW_MEMORY_OPTIONS, REVIEW_ROUTINE_OPTIONS, REVIEW_SOURCE, WEB_COPY_PREFIX } from "../src/lib/review-choices";
import type { BotSession } from "../src/lib/session-manager";
import type { PendingReview, ReviewNotifier } from "../src/lib/session-distill";
import { getStore, resetStore } from "../src/lib/store";
import { createTelegramRuntime } from "../src/lib/telegram-runtime";
import { THREAD_CHOICE_TEXT, THREAD_SOURCE } from "../src/lib/thread-choices";
import { createBotCommands } from "../src/web/bot-commands";
import { VOICE_AGENT_COMMAND_TEXT } from "../src/lib/commands/voice-agents";
import { VOICE_AGENT_SOURCE } from "../src/lib/voice-agents/manage";
import { baseRecipe } from "./voice-agents-elevenlabs-fixture";
import { FakeJobs } from "./voice-agents-drafts-fixture";

function setup(env: Record<string, string> = {}, parts: BotChoicesDeps["parts"] = {}, root = "/srv/tybo") {
  const kinds: ChoiceKind[] = [];
  const handlers = new Map<ChoiceKind, ChoiceHandler>();
  const installed: string[] = [];
  const note = (name: string) => () => void installed.push(name);
  let reviewNotifier: ReviewNotifier | null = null;
  const installers: ChoiceInstallers = {
    onChoiceDecided: ((kind, handler) => (kinds.push(kind), handlers.set(kind, handler), () => {})) as ChoiceInstallers["onChoiceDecided"],
    onGoalChange: (() => (installed.push("goalChange"), () => {})) as never,
    onTopicMappingSet: (() => (installed.push("topicMapping"), () => {})) as never,
    installThreadChoiceExpiry: (() => (installed.push("threadExpiry"), () => {})) as never,
    setPhoneCallService: note("phoneService") as never,
    setToolApprovalHandler: note("toolApproval") as never,
    expireOrphanedToolChoices: async () => (installed.push("expireTools"), 0),
    setReviewNotifier: (fn => (installed.push("reviewNotifier"), (reviewNotifier = fn))) as ChoiceInstallers["setReviewNotifier"],
    setMemoryAsker: note("memoryAsker") as never,
    setMemoryFailureNotice: note("memoryFailureNotice") as never,
    installAskOffer: note("askOffer") as never,
    resumeCalls: note("resumeCalls"),
    resumeAftercall: note("resumeAftercall"),
    resumeVoiceDrafts: () => (installed.push("resumeVoiceDrafts"), () => {}),
  };
  const telegramSends: unknown[][] = [];
  const sentChoices: Choice[] = [];
  const base = createTelegramRuntime({ env: {}, log: () => {} });
  const runtime = {
    ...base,
    sendMessage: async (...args: unknown[]) => void telegramSends.push(args),
    choices: { ...base.choices, sendChoice: async (choice: Choice) => (sentChoices.push(choice), { sent: true, recorded: true, messages: [] }) },
  };
  const services = createBotCommandServices({ routineMenu: async () => false });
  const posted: string[] = [];
  const webPosts: { id: string; post: Record<string, unknown> }[] = [];
  const web = {
    postToConversation: async (id: string, post: { text: string }) => (posted.push(`stored ${id} ${post.text}`), webPosts.push({ id, post }), true),
    postLive: async (id: string, post: { text: string }) => (posted.push(`live ${id} ${post.text}`), true),
  };
  const choices = wireBotChoices({
    root,
    env,
    runtime,
    web: () => web as never,
    notices: createBotNotices({ telegram: () => false, send: async () => ({ ok: true }) as never, sendStatusMessage: async () => {}, dmChatId: () => "" }),
    phoneTask: {} as never,
    services,
    installers,
    parts,
  });
  return { choices, kinds, handlers, installed, services, posted, webPosts, telegramSends, sentChoices, reviewNotifier: () => reviewNotifier };
}

describe("wireBotChoices", () => {
  test("jede Art des Registers außer tool bekommt genau einen Handler", () => {
    const { kinds } = setup();
    expect([...kinds].sort()).toEqual(["ask", "call", "cleanup", "core", "goal", "job", "memory", "proactive", "reminder", "review", "routine", "secret", "sprachagent", "thread", "topicmap"]);
  });

  test("Ablauf der Faden-Rückfragen, Ziel- und Topic-Änderungen, Freigaben und Anrufe angemeldet", () => {
    const { installed, services } = setup();
    expect(installed).toEqual(["goalChange", "topicMapping", "threadExpiry", "resumeCalls", "phoneService", "resumeVoiceDrafts", "resumeAftercall", "toolApproval", "expireTools"]);
    // /anruf und phone_call: derselbe Zugang
    expect(services.phone).toBeDefined();
    expect(services.voiceAgents).toBeDefined();
    expect(services.voiceDrafts).toBeDefined();
  });

  test("Zustellwege der Vorschläge erst mit installNotifiers", () => {
    const s = setup();
    expect(s.installed).not.toContain("reviewNotifier");
    s.choices.installNotifiers();
    expect(s.installed.slice(-4)).toEqual(["reviewNotifier", "memoryAsker", "memoryFailureNotice", "askOffer"]);
  });

  test("postWeb: Web-Gespräch abgelegt über die WebUI", async () => {
    const s = setup();
    const id = "11111111-2222-4333-8444-555555555555";
    expect(await s.choices.postWeb(id, { text: "Vorschlag", kind: "notice" } as never)).toBe(true);
    expect(s.posted).toEqual([`stored ${id} Vorschlag`]);
  });
});

describe("createChoicePostWeb", () => {
  const telegramConversation = "topic-7";

  test("Telegram-Gespräch: dauerhaft als Meldung mit Quelle und choiceId, live nur ohne Ablage", async () => {
    const recorded: unknown[] = [];
    const live: string[] = [];
    const web = { postToConversation: async () => false, postLive: async (id: string) => (live.push(id), true) };
    const kept = createChoicePostWeb({ web: () => web, recordNotice: async (_id, post) => (recorded.push(post), true) });
    expect(await kept(telegramConversation, { text: "Merken?", source: "review", choiceId: "abc" } as never)).toBe(true);
    expect(recorded).toEqual([{ text: "Merken?", source: "review", choiceId: "abc" }]);
    expect(live).toEqual([]);

    const notKept = createChoicePostWeb({ web: () => web, recordNotice: async () => false });
    expect(await notKept(telegramConversation, { text: "Merken?" } as never)).toBe(true);
    expect(live).toEqual([telegramConversation]);
  });

  test("ohne WebUI: Web-Gespräch nicht zustellbar", async () => {
    const post = createChoicePostWeb({ web: () => null, recordNotice: async () => false });
    expect(await post("11111111-2222-4333-8444-555555555555", { text: "x" } as never)).toBe(false);
    expect(await post(telegramConversation, { text: "x" } as never)).toBe(false);
  });
});

describe("wireBotChoices: Handler der Art review ausgelöst", () => {
  const WEB_CONVERSATION = "11111111-2222-4333-8444-555555555555";
  const review = (chatId: string, topicId?: number) => ({ id: "r1", type: "routine", chatId, ...(topicId ? { topicId } : {}), routineDescription: "Wetter am Morgen" }) as PendingReview;
  const session = { key: "dm:general", agentName: "general" } as BotSession;
  const decided = (conversation: ChoiceConversation, key: string): Choice =>
    ({ id: "c1", kind: "review", conversation, text: "Routine anlegen?", options: [], state: "done", result: { key, label: key, via: "web", at: 0 }, createdAt: 0, ref: "r1" }) as Choice;

  async function waitFor(check: () => boolean): Promise<void> {
    const end = Date.now() + 2000;
    while (!check()) {
      if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
      await Bun.sleep(5);
    }
  }

  function withReview(decision: ReviewDecision, env: Record<string, string> = {}) {
    const calls: string[] = [];
    const outbox: { chatId: string; text: string }[] = [];
    const saved: { chat_id: string; content: string; metadata?: Record<string, unknown> }[] = [];
    const s = setup(env, {
      decideReview: async (action, reviewId) => (calls.push(`${action}:${reviewId}`), decision),
      createRoutine: async () => ({ text: "Routine angelegt", isError: false }) as never,
      sendAndRecord: async input => (outbox.push({ chatId: input.chatId, text: input.text }), { sent: true }) as never,
      saveMessage: async message => (saved.push(message as never), true),
    });
    return { ...s, calls, outbox, saved, handler: s.handlers.get("review")! };
  }

  test("Routine im Web-Direktchat ohne Telegram: Bericht in den Verlauf, nichts an Telegram", async () => {
    const r = withReview({ kind: "routine", review: review("web"), session });
    await r.handler(decided({ type: "telegram", chatId: "web" }, "routine"));
    await waitFor(() => r.saved.length > 0);
    expect(r.calls).toEqual(["routine:r1"]);
    expect(r.telegramSends).toEqual([]);
    expect(r.saved).toEqual([{ chat_id: "web", role: "assistant", content: "Routine angelegt", metadata: { type: "routine_report" } } as never]);
  });

  test("Routine in einem Telegram-Topic: Bericht über die Laufzeit an Chat und Topic", async () => {
    const r = withReview({ kind: "routine", review: review("-100", 9), session });
    await r.handler(decided({ type: "telegram", chatId: "-100", topicId: 9 }, "routine"));
    await waitFor(() => r.saved.length > 0);
    expect(r.telegramSends).toEqual([["-100", "Routine angelegt", 9]]);
    expect(r.saved[0].chat_id).toBe("-100");
  });

  test("Web-Gespräch: Ergebnis über die WebUI, Kopie im Direktchat nur mit Telegram", async () => {
    const discarded = { kind: "discarded", review: review(`web:${WEB_CONVERSATION}`) } as ReviewDecision;
    const webOnly = withReview(discarded);
    await webOnly.handler(decided({ type: "web", conversationId: WEB_CONVERSATION }, "discard"));
    expect(webOnly.posted).toHaveLength(1);
    expect(webOnly.posted[0]).toStartWith(`stored ${WEB_CONVERSATION} `);
    expect(webOnly.outbox).toEqual([]);

    const withTelegram = withReview(discarded, { TELEGRAM_BOT_TOKEN: "123:test", TELEGRAM_USER_ID: "4242" });
    await withTelegram.handler(decided({ type: "web", conversationId: WEB_CONVERSATION }, "discard"));
    expect(withTelegram.outbox).toHaveLength(1);
    expect(withTelegram.outbox[0].chatId).toBe("4242");
    expect(withTelegram.outbox[0].text).toStartWith(WEB_COPY_PREFIX);
    expect(withTelegram.telegramSends).toEqual([]);
  });
});

describe("wireBotChoices: Handler der Art thread ausgelöst", () => {
  const WEB_CONVERSATION = "11111111-2222-4333-8444-555555555555";
  const TELEGRAM_ENV = { TELEGRAM_BOT_TOKEN: "123:test", TELEGRAM_USER_ID: "4242" };
  const decided = (conversation: ChoiceConversation, key: string): Choice =>
    ({ id: "c7", kind: "thread", conversation, text: "Offen seit gestern", options: [], state: "done", result: { key, label: key, via: "telegram", at: 0 }, createdAt: 0, ref: "T1" }) as Choice;

  function withThread(env: Record<string, string> = TELEGRAM_ENV) {
    const applied: string[] = [];
    const outbox: Record<string, unknown>[] = [];
    const s = setup(env, {
      applyThreadButton: async (id, button) => (applied.push(`${id}:${button}`), { status: "closed", thread: {} as never }),
      sendAndRecord: async input => (outbox.push({ ...input }), { sent: true }) as never,
    });
    return { ...s, applied, outbox, handler: s.handlers.get("thread")! };
  }

  test("Telegram-Topic: Antwort an Chat und Topic der Rückfrage, keine Kopie im Direktchat", async () => {
    const t = withThread();
    await t.handler(decided({ type: "telegram", chatId: "-100", topicId: 9 }, "done"));
    expect(t.applied).toEqual(["T1:done"]);
    expect(t.outbox).toEqual([{ chatId: "-100", topicId: 9, text: THREAD_CHOICE_TEXT.done, source: THREAD_SOURCE, format: "plain" }]);
    expect(t.telegramSends).toEqual([]);
    expect(t.posted).toEqual([]);
  });

  test("Web-Gespräch: Antwort nur im Gespräch selbst, auch mit Telegram keine Kopie im Direktchat", async () => {
    const t = withThread();
    await t.handler(decided({ type: "web", conversationId: WEB_CONVERSATION }, "drop"));
    expect(t.applied).toEqual(["T1:drop"]);
    expect(t.outbox).toEqual([{ chatId: `web:${WEB_CONVERSATION}`, text: THREAD_CHOICE_TEXT.dropped, source: THREAD_SOURCE, format: "plain" }]);
    expect(t.telegramSends).toEqual([]);
  });
});

describe("wireBotChoices: Zustellweg der Vorschläge aus installNotifiers ausgelöst", () => {
  const GROUP = "-1001234567890";
  const WEB_CONVERSATION = "11111111-2222-4333-8444-555555555555";
  // createChoice legt die Rückfrage im Register ab: Register in einer Temp-Datei
  const dir = mkdtempSync(join(tmpdir(), "app-bot-choices-"));
  beforeAll(() => setChoicesFileForTests(join(dir, "choices.json")));
  afterAll(() => {
    setChoicesFileForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });

  function installed() {
    const s = setup();
    s.choices.installNotifiers();
    const notifier = s.reviewNotifier();
    if (!notifier) throw new Error("kein Zustellweg angemeldet");
    return { ...s, notifier };
  }

  test("Merk-Vorschlag im Telegram-Topic: Rückfrage über sendChoice, nichts in die WebUI", async () => {
    const s = installed();
    await s.notifier({ reviewId: "r-tg", type: "memory", chatId: GROUP, topicId: 42, text: "🧠 Merk-Vorschlag", createdAt: Date.now() });
    expect(s.sentChoices).toHaveLength(1);
    expect(s.sentChoices[0]).toMatchObject({
      kind: "review",
      ref: "r-tg",
      conversation: { type: "telegram", chatId: GROUP, topicId: 42 },
      text: "🧠 Merk-Vorschlag",
      options: REVIEW_MEMORY_OPTIONS,
    });
    expect((await getChoice(s.sentChoices[0].id))?.state).toBe("open");
    expect(s.webPosts).toEqual([]);
  });

  test("Routine-Angebot aus einem Web-Gespräch: abgelegt im Gespräch mit choiceId, dazu sendChoice", async () => {
    const s = installed();
    await s.notifier({ reviewId: "r-web", type: "routine", chatId: `web:${WEB_CONVERSATION}`, text: "Als Routine speichern?", createdAt: Date.now() });
    expect(s.sentChoices).toHaveLength(1);
    const choice = s.sentChoices[0];
    expect(choice).toMatchObject({ kind: "review", ref: "r-web", conversation: { type: "web", conversationId: WEB_CONVERSATION }, options: REVIEW_ROUTINE_OPTIONS });
    expect(s.webPosts).toEqual([{ id: WEB_CONVERSATION, post: { text: "Als Routine speichern?", kind: "notice", source: REVIEW_SOURCE, choiceId: choice.id } }]);
  });
});

// Issue #522: /kern entwurf über den Dienst, den wireBotChoices bereitstellt.
// Ersetzt sind nur das Modell und der Versand der Outbox; Fakten kommen aus dem
// echten Speicher (Datei), die Entscheidung aus dem echten Register.
describe("wireBotChoices: /kern entwurf über services.core", () => {
  const USER = "4711";
  const WEB_CONVERSATION = "11111111-2222-4333-8444-555555555555";
  const DRAFT = "## Wer ich bin\n- Alex, Imkerin in Görlitz";
  const ENV_NAMES = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "MEMORY_FILE_PATH"] as const;
  const cwd = process.cwd();
  let root = "";
  let savedEnv: Record<string, string | undefined> = {};
  let silent: ReturnType<typeof spyOn>;
  let stopHandler = () => {};

  beforeEach(async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "app-bot-choices-kern-")));
    process.chdir(root);
    setChoicesFileForTests(join(root, "data", "choices.json"));
    savedEnv = Object.fromEntries(ENV_NAMES.map(name => [name, process.env[name]]));
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    process.env.MEMORY_FILE_PATH = join(root, "memory.json");
    resetStore();
    await getStore().memory.addFact("Alex ist Imkerin");
    silent = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    stopHandler();
    stopHandler = () => {};
    silent.mockRestore();
    for (const name of ENV_NAMES) {
      if (savedEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedEnv[name];
    }
    resetStore();
    setChoicesFileForTests(null);
    process.chdir(cwd);
    rmSync(root, { recursive: true, force: true });
  });

  /** Verdrahtung wie im Bot; der angemeldete Handler kommt ins echte Register, damit ein Klick ihn auslöst */
  function wired() {
    const aux: { purpose: string; prompt: string }[] = [];
    const outbox: Record<string, unknown>[] = [];
    const s = setup({}, {
      callAux: (async (purpose: string, prompt: string) => (aux.push({ purpose, prompt }), { text: DRAFT, isError: false })) as never,
      sendAndRecord: async input => (outbox.push({ ...input }), { sent: true }) as never,
    });
    stopHandler = onChoiceDecided("core", s.handlers.get("core")!);
    return { ...s, aux, outbox };
  }

  async function telegram(services: ReturnType<typeof wired>["services"]): Promise<string[]> {
    const sent: string[] = [];
    const text = "/kern entwurf";
    await runTelegramCommand({
      chat: { reply: async t => void sent.push(t) },
      chatId: USER,
      sessionKey: `dm:${USER}`,
      agent: "general",
      text,
      match: commandRegistry.match(text, "telegram")!,
      services,
      working: () => () => {},
      resetSession: async () => ({ status: "unavailable" }),
      agentTurn: async () => {},
      boardMeeting: async () => {},
    });
    return sent;
  }

  async function browser(services: ReturnType<typeof wired>["services"]): Promise<string[]> {
    const unused = () => {
      throw new Error("nicht erwartet");
    };
    const commands = createBotCommands({
      registry: commandRegistry,
      services,
      userId: "web",
      groupId: () => null,
      agentForTopic: () => undefined,
      sendPlain: unused,
      sendAndRecord: unused,
      saveMessage: async () => true,
      resetConversation: unused,
      runStreamingTurn: unused,
      processIntents: unused,
      sendAsAgent: unused,
      log: () => {},
    });
    const notices: string[] = [];
    await commands.run({
      conversationId: WEB_CONVERSATION,
      agent: "general",
      text: "/kern entwurf",
      source: "web",
      messageId: "m1",
      receivedAt: new Date().toISOString(),
      signal: new AbortController().signal,
      sink: {} as never,
      notice: async t => void notices.push(t),
      answer: async () => {},
      ask: async () => {},
      endAsk: () => {},
      commit: () => {},
    });
    return notices;
  }

  test("Telegram: Frage über sendChoice, Fakten aus dem Speicher, Übernehmen wirkt über den angemeldeten Handler", async () => {
    const s = wired();
    expect(s.services.core).toBeDefined();
    expect(await telegram(s.services)).toEqual([CORE_COMMAND_TEXT.working, CORE_COMMAND_TEXT.draft.offered]);

    expect(s.aux).toHaveLength(1);
    expect(s.aux[0].purpose).toBe("distill");
    expect(s.aux[0].prompt).toContain("Alex ist Imkerin");
    expect(s.sentChoices).toHaveLength(1);
    const [choice] = s.sentChoices;
    expect(choice).toMatchObject({ kind: "core", conversation: { type: "telegram", chatId: USER } });
    expect(choice.text).toContain(DRAFT);
    expect(s.webPosts).toEqual([]);
    expect(await coreForPrompt()).toBe("");

    const outcome = await decideChoice(choice.id, CORE_ADOPT, "telegram");
    expect(outcome.status).toBe("decided");
    expect(outcome.status === "decided" ? outcome.choice.handlerError : "kein Ergebnis").toBeUndefined();
    expect(await coreForPrompt()).toBe(DRAFT);
    expect(existsSync(coreDraftFile())).toBe(false);
    expect(s.outbox).toEqual([{ chatId: USER, text: CORE_CHOICE_TEXT.adopted(DRAFT.length), source: CORE_SOURCE, format: "plain" }]);
  });

  test("Browser: Frage im Web-Gespräch mit choiceId, das Ergebnis geht ins selbe Gespräch", async () => {
    const s = wired();
    expect(await browser(s.services)).toEqual([CORE_COMMAND_TEXT.working, CORE_COMMAND_TEXT.draft.offered]);

    expect(s.sentChoices).toHaveLength(1);
    const [choice] = s.sentChoices;
    expect(choice).toMatchObject({ kind: "core", conversation: { type: "web", conversationId: WEB_CONVERSATION } });
    expect(s.webPosts).toEqual([{ id: WEB_CONVERSATION, post: { text: choice.text, kind: "notice", source: CORE_SOURCE, choiceId: choice.id } }]);

    expect((await decideChoice(choice.id, CORE_ADOPT, "web")).status).toBe("decided");
    expect(await coreForPrompt()).toBe(DRAFT);
    expect(s.outbox).toEqual([{ chatId: `web:${WEB_CONVERSATION}`, text: CORE_CHOICE_TEXT.adopted(DRAFT.length), source: CORE_SOURCE, format: "plain" }]);
  });
});

describe("wireBotChoices: /sprachagent über services.voiceAgents (Issue #492)", () => {
  const WEB_CONVERSATION = "11111111-2222-4333-8444-555555555555";
  let root = "";
  let silent: ReturnType<typeof spyOn>;
  let stopHandler = () => {};

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "app-bot-choices-sprachagent-")));
    setChoicesFileForTests(join(root, "data", "choices.json"));
    silent = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    stopHandler();
    stopHandler = () => {};
    silent.mockRestore();
    setChoicesFileForTests(null);
    rmSync(root, { recursive: true, force: true });
  });

  function wired(env: Record<string, string> = {}) {
    const outbox: Record<string, unknown>[] = [];
    const s = setup(env, { sendAndRecord: async input => (outbox.push({ ...input }), { sent: true }) as never }, root);
    stopHandler = onChoiceDecided("sprachagent", s.handlers.get("sprachagent")!);
    return { ...s, outbox };
  }

  async function browser(services: ReturnType<typeof wired>["services"], text: string): Promise<string[]> {
    const unused = () => {
      throw new Error("nicht erwartet");
    };
    const commands = createBotCommands({
      registry: commandRegistry,
      services,
      userId: "web",
      groupId: () => null,
      agentForTopic: () => undefined,
      sendPlain: unused,
      sendAndRecord: unused,
      saveMessage: async () => true,
      resetConversation: unused,
      runStreamingTurn: unused,
      processIntents: unused,
      sendAsAgent: unused,
      log: () => {},
    });
    const notices: string[] = [];
    await commands.run({
      conversationId: WEB_CONVERSATION,
      agent: "general",
      text,
      source: "web",
      messageId: "m1",
      receivedAt: new Date().toISOString(),
      signal: new AbortController().signal,
      sink: {} as never,
      notice: async t => void notices.push(t),
      answer: async () => {},
      ask: async () => {},
      endAsk: () => {},
      commit: () => {},
    });
    return notices;
  }

  function writeRecipe(kennung: string) {
    const raw = baseRecipe();
    raw.kennung = kennung;
    mkdirSync(join(root, "config", "voice-agents"), { recursive: true });
    writeFileSync(join(root, "config", "voice-agents", `${kennung}.json`), JSON.stringify(raw));
  }

  test("Browser ohne Telegram: Liste aus config/voice-agents im Projektordner, Löschen mit Rückfrage im Gespräch, Ergebnis ebendort", async () => {
    writeRecipe("beispiel");
    const s = wired();
    const list = await browser(s.services, "/sprachagenten");
    expect(list.join("\n")).toContain("Beispiel (beispiel)");
    expect(list.join("\n")).toContain("Verbrauch unbekannt, Limit 300");

    expect(await browser(s.services, "/sprachagent loeschen beispiel")).toEqual([VOICE_AGENT_COMMAND_TEXT.deleteAsked("Beispiel")]);
    const [choice] = s.sentChoices;
    expect(choice).toMatchObject({ kind: "sprachagent", ref: "beispiel", action: "loeschen", conversation: { type: "web", conversationId: WEB_CONVERSATION } });
    expect(s.webPosts).toEqual([{ id: WEB_CONVERSATION, post: { text: choice.text, kind: "notice", source: VOICE_AGENT_SOURCE, choiceId: choice.id } }]);

    expect((await decideChoice(choice.id, "ja", "web")).status).toBe("decided");
    expect(existsSync(join(root, "config", "voice-agents", "beispiel.json"))).toBe(false);
    expect(readdirSync(join(root, "data", "voice-agents", "beispiel", "geloescht"))).toHaveLength(1);
    expect(s.outbox).toHaveLength(1);
    expect(s.outbox[0]).toMatchObject({ chatId: `web:${WEB_CONVERSATION}`, source: VOICE_AGENT_SOURCE, format: "plain" });
    expect(String(s.outbox[0].text)).toContain("data/voice-agents/beispiel/geloescht/");
  });

  test("ohne ELEVENLABS_API_KEY: testen meldet den fehlenden Anbieter, link die fehlende Freischaltung", async () => {
    writeRecipe("beispiel");
    const s = wired();
    expect(await browser(s.services, "/sprachagent testen beispiel")).toEqual([VOICE_AGENT_COMMAND_TEXT.noProvider]);
    expect(await browser(s.services, "/sprachagent link beispiel")).toEqual([VOICE_AGENT_COMMAND_TEXT.linkLocked("Beispiel")]);
    expect(await browser(s.services, "/sprachagent testen gibtsnicht")).toEqual([VOICE_AGENT_COMMAND_TEXT.unknown("gibtsnicht")]);
  });

  test("/sprachagent neu im Browser ohne Telegram (Issue #493): Job mit Ziel des Gesprächs, Freigabe ebendort, Verwerfen über denselben Handler wie Löschen", async () => {
    const jobs = new FakeJobs();
    const outbox: Record<string, unknown>[] = [];
    const s = setup({}, { sendAndRecord: async input => (outbox.push({ ...input }), { sent: true }) as never, createDraftJobs: () => jobs }, root);
    stopHandler = onChoiceDecided("sprachagent", s.handlers.get("sprachagent")!);
    expect(await browser(s.services, "/sprachagent neu Eine Kochhilfe,\ndie Rezepte langsam vorliest")).toEqual([VOICE_AGENT_COMMAND_TEXT.draftStarted("neu")]);
    expect(jobs.starts).toHaveLength(1);
    expect(jobs.last().target).toEqual({ chatId: `web:${WEB_CONVERSATION}` });
    expect(jobs.last().brief).toContain("Eine Kochhilfe,\ndie Rezepte langsam vorliest");
    const [id] = readdirSync(join(root, "data", "voice-agents", "entwuerfe", ".steuerung"));
    // Der Job arbeitet in seinem eigenen Ordner
    expect(jobs.last().workDir).toBe(join(root, "data", "voice-agents", "entwuerfe", ".arbeit", id));
    const raw = baseRecipe();
    raw.kennung = "kochhilfe";
    delete raw.stimme.voiceId;
    raw.gedaechtnis = "keins";
    writeFileSync(join(root, "data", "voice-agents", "entwuerfe", ".arbeit", id, "rezept.json"), JSON.stringify(raw));
    jobs.finish(jobs.last().id);
    await s.choices.voiceDrafts.tick();
    const choice = s.sentChoices.at(-1)!;
    expect(choice).toMatchObject({ kind: "sprachagent", action: "freigabe", ref: id, conversation: { type: "web", conversationId: WEB_CONVERSATION } });
    expect(s.webPosts.at(-1)).toEqual({ id: WEB_CONVERSATION, post: { text: choice.text, kind: "notice", source: VOICE_AGENT_SOURCE, choiceId: choice.id } });
    expect((await decideChoice(choice.id, "verwerfen", "web")).status).toBe("decided");
    expect((await getChoice(choice.id))?.handlerError).toBeUndefined();
    expect(existsSync(join(root, "config", "voice-agents", "kochhilfe.json"))).toBe(false);
    expect(outbox.at(-1)).toMatchObject({ chatId: `web:${WEB_CONVERSATION}`, source: VOICE_AGENT_SOURCE, text: "Entwurf verworfen, nichts angelegt." });
  });

  test("mit ELEVENLABS_API_KEY, Agent nicht angelegt: kein Aufruf, klare Meldung", async () => {
    writeRecipe("beispiel");
    const s = wired({ ELEVENLABS_API_KEY: "xi-test-schluessel-1234567890" });
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      expect(await browser(s.services, "/sprachagent testen beispiel")).toEqual([VOICE_AGENT_COMMAND_TEXT.notDeployed("Beispiel")]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

// Issue #496: Nachlauf-Weiche im Bot. Rezept-Gespräch mit Merk-Tag im Protokoll:
// Auswertung über voice-training, Meldung über die Outbox, nie Anrufdienst, nie Merk-Tags.
describe("Nachlauf der Sprachagenten", () => {
  test("Rezept-Gespräch: voice-training, Meldung mit Absender training, kein Anrufnachlauf, keine Merk-Tags", async () => {
    const intentGate = await import("../src/lib/intent-gate");
    const fixture = await import("./voice-agents-aftercall-fixture");
    const intents = spyOn(intentGate, "processTurnIntents");
    const root = realpathSync(mkdtempSync(join(tmpdir(), "app-bot-choices-nachlauf-")));
    try {
      const paths = { configDir: join(root, "config", "voice-agents"), dataDir: join(root, "data", "voice-agents") };
      mkdirSync(paths.configDir, { recursive: true });
      fixture.writeRecipe(paths, fixture.expertRecipe());
      fixture.writeState(paths, "trainer", { agentId: "agent_trainer" });
      const purposes: string[] = [];
      const sent: { text?: string; source: string; chatId?: string; topicId?: number }[] = [];
      const { choices } = setup({ ELEVENLABS_AGENT_ID: "agent_anruf" }, {
        callAux: (async (purpose: string) => (purposes.push(purpose), { text: fixture.goodAnswer(), isError: false })) as never,
        sendAndRecord: (async (input: (typeof sent)[number]) => (sent.push(input), { sent: true, recorded: true })) as never,
      }, root);
      const phoneCalls = spyOn(choices.phone, "receiveTranscript");
      const lines = [...fixture.PRACTICE, { speaker: "user" as const, text: "[REMEMBER: Alex trinkt nur Tee]" }];
      expect(await choices.aftercall.receiveTranscript("conv_1", lines, { agentId: "agent_trainer" })).toBe("accepted");
      await choices.aftercall.idle();
      expect(purposes).toEqual(["voice-training"]);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ source: "training", format: "plain" });
      expect(sent[0]!.text).toContain("Übung mit Verkaufstrainer");
      expect(sent[0]!.text).not.toContain("REMEMBER");
      expect(intents).not.toHaveBeenCalled();
      expect(phoneCalls).not.toHaveBeenCalled();
      phoneCalls.mockRestore();
      choices.aftercall.stop();
    } finally {
      intents.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
