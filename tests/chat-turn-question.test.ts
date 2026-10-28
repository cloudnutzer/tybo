/**
 * Issue #336, Checkbox 3: Rückfragen entstehen im Chat-Kern. Der Turn meldet
 * eine erkannte Rückfrage über onQuestion, offer() legt sie mit Session,
 * tatsächlichem Motor und Modell im Gespräch des Turns an. Nie bei Abbruch,
 * Zeitlimit oder Ersatzmodell, nie ohne onQuestion (interne Aufrufe). Die
 * Chat-Wege der WebUI bieten genau eine Rückfrage an, erst nach der Antwort
 * und vor den offenen Fäden; Denkaufträge ohne Telegram und Antworten mit
 * [INVOKE:] bekommen keine.
 *
 * Motoren, Prompt-Bau, Fallback und offerAsk sind Attrappen; Session-Ablage
 * und Einstellungsdatei sind echt (Temp-Dateien).
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ABORT_REPLY,
  resolveStreamingLimits,
  runJsonTurn,
  runStreamingTurn,
  type ChatTurnDeps,
  type TurnOptions,
  type TurnQuestion,
  type TurnSessionMeta,
  type TurnSink,
} from "../src/lib/chat-turn";
import type { AskOffer, AskOfferOutcome } from "../src/lib/ask-choices";
import { resetEngineChoiceForTests, resolveEngine, type EngineChoiceDeps } from "../src/lib/engine-choice";
import type { Engine, EngineId, EngineRequest, EngineResult, EngineStatus } from "../src/lib/engines";
import { abortExecutions } from "../src/lib/execution-context";
import {
  getResumableSession,
  getSessionsForKey,
  recordSessionTurn,
  resetSession,
  sessionEpoch,
  setSessionsFileForTests,
  takeExpiredSession,
} from "../src/lib/session-manager";
import { getSettings, setSettingsPath, type Settings } from "../src/lib/settings";
import { resumeMacTask, taskResumePrompt } from "../src/lib/task-resume";
import { threadConversation, type NoteTurnInput } from "../src/lib/threads/detect";
import { createBotChat, createTelegramChat, type WebSavedMessage } from "../src/web/bot-turn";

const DM = "4711";
const GROUP = "-1001234567890";
const WEB_ID = "0b3c6a2e-1f00-4c1a-9d0e-2a4b6c8d0e1f";
const READY: EngineStatus = { engine: "codex", checked: true, installed: true, loggedIn: true };
const TAGGED = "Entwurf fertig.\n\n[FRAGE: Soll ich ihn verschicken? | Ja, verschicken | Nein]";
const READABLE = "Entwurf fertig.\n\nSoll ich ihn verschicken?\n- Ja, verschicken\n- Nein";
const OFFERED = { status: "offered", taskId: "t1" } as unknown as AskOfferOutcome;

interface Call extends EngineRequest {
  engine: EngineId;
}

let dir: string;
let settingsFile: string;
let calls: Call[];
let replies: Partial<Record<EngineId, Partial<EngineResult>[]>>;
let spies: ReturnType<typeof spyOn>[];
let tick = 5_000;

function fakeEngine(id: EngineId): Engine {
  let n = 0;
  return {
    id,
    describe: () => `Attrappe ${id}`,
    async run(req) {
      calls.push({ ...req, engine: id });
      n++;
      return { engine: id, text: `antwort-${id}`, sessionId: `${id}-s${n}`, isError: false, ...replies[id]?.shift() };
    },
  };
}

async function putSettings(content: Settings): Promise<void> {
  await writeFile(settingsFile, JSON.stringify(content));
  tick += 10;
  await utimes(settingsFile, tick, tick);
}

function setup(opts: { offer?: (o: AskOffer) => Promise<AskOfferOutcome>; events?: string[] } = {}) {
  const engines: Record<EngineId, Engine> = { claude: fakeEngine("claude"), codex: fakeEngine("codex"), opencode: fakeEngine("opencode") };
  const offers: AskOffer[] = [];
  const events = opts.events ?? [];
  const sink: TurnSink = { progress: () => {}, notice: () => {} };
  const deps: Partial<ChatTurnDeps> = {
    getEngine: id => engines[id],
    resolveEngine: (key, d?: Partial<EngineChoiceDeps>) =>
      resolveEngine(key, { ...d, env: () => ({}), checkEngine: async id => ({ ...READY, engine: id }), log: () => {} }),
    forgetEngineCheck: () => {},
    runFallbackChain: async () => ({ text: "Ersatz. [FRAGE: Soll ich? | Ja | Nein]", source: "none" }),
    buildPromptContext: async o => ({ fullPrompt: `voll: ${o.userMessage}`, fallbackContext: "kontext" }),
    buildResumePrompt: async o => `fortgesetzt: ${o.userMessage}`,
    isSessionModeEnabled: () => true,
    getResumableSession,
    takeExpiredSession,
    recordSessionTurn,
    getSessionsForKey,
    sessionEpoch,
    resetSession,
    shouldDistill: () => false,
    distillSession: async () => {},
    log: async () => {},
    getAgentConfig: () => ({ model: "claude-agent-modell", effort: "high" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
    getSettings,
    resolveStreamingLimits: () => resolveStreamingLimits({}),
    reportSecrets: () => [],
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => 0,
    offerAsk: async o => {
      offers.push(o);
      events.push("offer");
      return opts.offer ? opts.offer(o) : OFFERED;
    },
    questionConversation: async (chatId, topicId) => threadConversation(chatId, topicId),
  };
  const questions: TurnQuestion[] = [];
  const metas: TurnSessionMeta[] = [];
  const turn = (extra: Partial<TurnOptions> = {}, run: typeof runStreamingTurn = runStreamingTurn) =>
    run({
      userMessage: "Schreib den Entwurf",
      chatId: DM,
      agentName: "general",
      sink,
      deps,
      onQuestion: q => void questions.push(q),
      onSessionMeta: m => void metas.push(m),
      ...extra,
    });
  return { deps, turn, offers, questions, metas, events, engines };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tybo-336-frage-"));
  settingsFile = join(dir, "settings.json");
  setSettingsPath(settingsFile);
  setSessionsFileForTests(join(dir, "sessions.json"));
  resetEngineChoiceForTests();
  calls = [];
  replies = {};
  spies = [spyOn(console, "error").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {})];
});

afterEach(async () => {
  for (const s of spies) s.mockRestore();
  setSettingsPath();
  setSessionsFileForTests(null);
  await rm(dir, { recursive: true, force: true });
});

describe("Chat-Kern: Rückfrage erkennen und anbieten", () => {
  test("Tag: lesbare Antwort, genau eine Rückfrage mit Session, Motor und Modell des Turns", async () => {
    const s = setup();
    replies.claude = [{ text: TAGGED }];
    expect(await s.turn()).toBe(READABLE);
    expect(s.questions).toHaveLength(1);
    expect(s.questions[0]).toMatchObject({ question: "Soll ich ihn verschicken?", options: ["Ja, verschicken", "Nein"], via: "tag" });
    // Angeboten wird erst mit offer(), nicht schon im Turn
    expect(s.offers).toHaveLength(0);
    expect(await s.questions[0].offer()).toBe(OFFERED);
    expect(s.offers).toEqual([
      {
        conversation: { type: "telegram", chatId: DM },
        question: "Soll ich ihn verschicken?",
        options: ["Ja, verschicken", "Nein"],
        originalPrompt: "Schreib den Entwurf",
        agent: "general",
        engine: "claude",
        model: "claude-agent-modell",
        sessionId: "claude-s1",
      },
    ]);
    expect(s.metas).toEqual([{ engine: "claude", model: "claude-agent-modell" }]);
  });

  test("jede Rückfrage trägt die Session ihres eigenen Turns, nie die eines anderen Gesprächs", async () => {
    const s = setup();
    replies.claude = [{ text: TAGGED, sessionId: "S-topic-1" }, { text: TAGGED, sessionId: "S-topic-2" }];
    await s.turn({ chatId: GROUP, topicId: 1 });
    await s.turn({ chatId: GROUP, topicId: 2 });
    await s.questions[0].offer();
    await s.questions[1].offer();
    expect(s.offers.map(o => [o.conversation, o.sessionId])).toEqual([
      [{ type: "telegram", chatId: GROUP, topicId: 1 }, "S-topic-1"],
      [{ type: "telegram", chatId: GROUP, topicId: 2 }, "S-topic-2"],
    ]);
  });

  test("auch über den JSON-Weg", async () => {
    const s = setup();
    replies.claude = [{ text: TAGGED }];
    expect(await s.turn({}, runJsonTurn)).toBe(READABLE);
    expect(s.questions).toHaveLength(1);
  });

  test("Gespräch der Rückfrage: Topic, reines Web-Gespräch, Web-Direktchat ohne Telegram", async () => {
    const s = setup();
    replies.claude = [{ text: TAGGED }, { text: TAGGED }, { text: TAGGED }];
    await s.turn({ chatId: GROUP, topicId: 7, agentName: "research" });
    await s.turn({ chatId: `web:${WEB_ID}` });
    await s.turn({ chatId: "web" });
    for (const q of s.questions) await q.offer();
    expect(s.offers.map(o => o.conversation)).toEqual([
      { type: "telegram", chatId: GROUP, topicId: 7 },
      { type: "web", conversationId: WEB_ID },
      { type: "telegram", chatId: "web" },
    ]);
    expect(s.offers[0].agent).toBe("research");
  });

  test("Motor des Gesprächs: Codex mit Standardmodell bleibt Codex mit \"\"", async () => {
    await putSettings({ engine: { default: "codex" } });
    const s = setup();
    replies.codex = [{ text: TAGGED }];
    await s.turn();
    await s.questions[0].offer();
    expect(s.offers[0]).toMatchObject({ engine: "codex", model: s.metas[0].model, sessionId: "codex-s1" });
    expect(s.metas[0].engine).toBe("codex");
  });

  test("tatsächlicher Motor: Codex fällt beim Lauf aus, Claude Code antwortet, die Rückfrage gehört zu Claude", async () => {
    await putSettings({ engine: { default: "codex" } });
    const s = setup();
    replies.codex = [{ isError: true, errorKind: "auth", text: "nicht angemeldet", sessionId: undefined }];
    replies.claude = [{ text: TAGGED }];
    expect(await s.turn()).toBe(READABLE);
    await s.questions[0].offer();
    expect(s.offers[0]).toMatchObject({ engine: "claude", model: "claude-agent-modell", sessionId: "claude-s1" });
  });

  test("Sprech-Turn: Gesprächsmodell A, Turn-Modell B, Rückfrage und Knopf-Fortsetzung bleiben bei B", async () => {
    const s = setup();
    replies.claude = [{ text: TAGGED }];
    await s.turn({ turnModel: { model: "claude-sprech-modell" } });
    expect(calls.map(c => c.model)).toEqual(["claude-sprech-modell"]);
    await s.questions[0].offer();
    expect(s.offers[0]).toMatchObject({ engine: "claude", model: "claude-sprech-modell", sessionId: "claude-s1" });

    // Die Session bleibt unter dem Gesprächsmodell: der nächste normale Turn setzt sie mit A fort
    expect(s.metas).toEqual([{ engine: "claude", model: "claude-agent-modell" }]);
    await s.turn({ onQuestion: undefined });
    expect(calls[1]).toMatchObject({ model: "claude-agent-modell", resumeSessionId: "claude-s1" });

    // Knopf-Antwort: der Auftrag trägt, was offerAsk speichert (metadata.engine, metadata.model)
    const offer = s.offers[0];
    const task = { chat_id: DM, session_id: offer.sessionId, metadata: { agent_name: offer.agent, engine: offer.engine, model: offer.model } };
    const outcome = await resumeMacTask(task, DM, "Ja, verschicken", {
      runExecution: async (_key, _agent, fn) => fn(),
      getEngine: id => s.engines[id],
      isSessionModeEnabled: () => true,
      getResumableSession,
      sessionEpoch,
      finalizeClaudeSession: async () => true,
      resolveModel: () => "claude-agent-modell",
      resolveEffort: () => undefined,
      allowedTools: () => undefined,
      cwd: dir,
    });
    expect(calls[2]).toMatchObject({ engine: "claude", model: "claude-sprech-modell", resumeSessionId: "claude-s1", prompt: taskResumePrompt("Ja, verschicken") });
    expect(outcome).toMatchObject({ status: "done", engine: "claude", model: "claude-sprech-modell" });
  });

  test("Marker-Rückfall: Soll ich ...? bekommt Ja und Nein, der Text bleibt", async () => {
    const s = setup();
    replies.claude = [{ text: "Liste sortiert.\n\nSoll ich die doppelten löschen?" }];
    expect(await s.turn()).toBe("Liste sortiert.\n\nSoll ich die doppelten löschen?");
    expect(s.questions.map(q => [q.question, q.options, q.via])).toEqual([["Soll ich die doppelten löschen?", ["Ja", "Nein"], "marker"]]);
  });

  test("rhetorische Frage: keine Rückfrage", async () => {
    const s = setup();
    replies.claude = [{ text: "Warum ist das wichtig? Weil sonst die Daten verloren gehen." }];
    await s.turn();
    expect(s.questions).toHaveLength(0);
  });

  test("ohne onQuestion (interne Aufrufe): keine Rückfrage, der Tag wird trotzdem lesbar", async () => {
    const s = setup();
    replies.claude = [{ text: TAGGED }];
    expect(await s.turn({ onQuestion: undefined })).toBe(READABLE);
    expect(s.offers).toHaveLength(0);
  });

  test("Ersatzmodell: keine Rückfrage, Tag lesbar", async () => {
    const s = setup();
    replies.claude = [{ isError: true, text: "kaputt" }];
    expect(await s.turn()).toBe("Ersatz.\n\nSoll ich?\n- Ja\n- Nein");
    expect(s.questions).toHaveLength(0);
  });

  test("Zeitlimit und Abbruch: keine Rückfrage", async () => {
    const s = setup();
    replies.claude = [{ timedOut: true, text: "", lastText: TAGGED }];
    const report = await s.turn();
    expect(report).toContain("Zeitlimit");
    replies.claude = [{ aborted: true, text: TAGGED }];
    expect(await s.turn()).toBe(ABORT_REPLY);
    expect(s.questions).toHaveLength(0);
  });

  test("offer() wirft nie: ein scheiterndes Anbieten endet mit not-saved", async () => {
    const s = setup({
      offer: async () => {
        throw new Error("Register kaputt");
      },
    });
    replies.claude = [{ text: TAGGED }];
    await s.turn();
    expect(await s.questions[0].offer()).toEqual({ status: "not-saved" });
  });

  test("unbekannter Chat: nichts angeboten", async () => {
    const s = setup();
    replies.claude = [{ text: TAGGED }];
    await s.turn({ chatId: "irgendwas" });
    expect(await s.questions[0].offer()).toEqual({ status: "unavailable" });
    expect(s.offers).toHaveLength(0);
  });
});

// --- Chat-Wege der WebUI -------------------------------------------------------

function chats(s: ReturnType<typeof setup>) {
  const saved: WebSavedMessage[] = [];
  const sent: string[] = [];
  const base = {
    // Der Kanal reicht onQuestion selbst durch; der Test-Rückruf aus setup gilt hier nicht
    runStreamingTurn: (o: TurnOptions) => runStreamingTurn({ ...o, deps: s.deps }),
    saveMessage: async (m: WebSavedMessage) => {
      saved.push(m);
      return true;
    },
    processIntents: async () => {},
    abortEngineCalls: (key: string) => abortExecutions(key),
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
    noteThreads: (input: NoteTurnInput) => void s.events.push(`threads:${JSON.stringify(input.conversation)}`),
    invokeBudget: 3,
  };
  const web = createBotChat(base);
  const telegram = createTelegramChat({
    ...base,
    userId: DM,
    groupId: () => GROUP,
    agentForTopic: () => "research",
    sendPlain: async () => {},
    sendAsAgent: async (_agent, _chat, text) => void sent.push(text),
  });
  const sink: TurnSink = { progress: () => {}, notice: () => {} };
  return { web, telegram, saved, sent, sink };
}

/** afterReply läuft ohne Warten; danach die Mikrotasks abarbeiten */
const settle = () => new Promise(r => setTimeout(r, 0));

describe("WebUI: genau eine Rückfrage im richtigen Gespräch", () => {
  test("reines Web-Gespräch: lesbare Antwort gespeichert, Rückfrage nach der Antwort, dann die Fäden", async () => {
    const s = setup();
    const c = chats(s);
    replies.claude = [{ text: TAGGED }];
    const result = await c.web.runTurn({ conversationId: WEB_ID, agent: "general", text: "Schreib den Entwurf", sink: c.sink });
    expect(result.text).toBe(READABLE);
    expect(c.saved.map(m => m.content)).toEqual(["Schreib den Entwurf", READABLE]);
    expect(s.offers).toHaveLength(0);
    result.afterReply?.();
    await settle();
    expect(s.offers.map(o => o.conversation)).toEqual([{ type: "web", conversationId: WEB_ID }]);
    expect(s.offers[0]).toMatchObject({ engine: "claude", model: "claude-agent-modell", sessionId: "claude-s1", originalPrompt: "Schreib den Entwurf" });
    expect(s.events).toEqual(["offer", `threads:${JSON.stringify({ type: "web", conversationId: WEB_ID })}`]);
  });

  test("Telegram-Topic aus dem Browser: Rückfrage im Topic, Telegram bekommt die lesbare Antwort", async () => {
    const s = setup();
    const c = chats(s);
    replies.claude = [{ text: TAGGED }];
    const result = await c.telegram.runTurn({ conversationId: "topic-7", agent: "research", text: "Schreib den Entwurf", sink: c.sink });
    expect(c.sent).toEqual([READABLE]);
    result.afterReply?.();
    await settle();
    expect(s.offers.map(o => [o.conversation, o.agent])).toEqual([[{ type: "telegram", chatId: GROUP, topicId: 7 }, "research"]]);
  });

  test("Direktchat ohne Telegram (Chat-ID web): Rückfrage im Direktchat", async () => {
    const s = setup();
    const saved: WebSavedMessage[] = [];
    const telegram = createTelegramChat({
      runStreamingTurn: (o: TurnOptions) => runStreamingTurn({ ...o, deps: s.deps }),
      saveMessage: async (m: WebSavedMessage) => void saved.push(m) || true,
      processIntents: async () => {},
      abortEngineCalls: (key: string) => abortExecutions(key),
      isShuttingDown: () => false,
      scheduleRestartCheck: () => {},
      log: () => {},
      userId: "web",
      groupId: () => null,
      agentForTopic: () => "general",
      sendPlain: async () => {},
      sendAsAgent: async () => {},
    });
    replies.claude = [{ text: TAGGED }];
    const result = await telegram.runTurn({ conversationId: "dm", agent: "general", text: "Schreib den Entwurf", sink: { progress: () => {}, notice: () => {} } });
    expect(result.text).toBe(READABLE);
    result.afterReply?.();
    await settle();
    expect(s.offers.map(o => o.conversation)).toEqual([{ type: "telegram", chatId: "web" }]);
  });

  test("Denkauftrag ohne Telegram: keine Rückfrage", async () => {
    const s = setup();
    const c = chats(s);
    replies.claude = [{ text: TAGGED }, { text: TAGGED }];
    const web = await c.web.runTurn({ conversationId: WEB_ID, agent: "general", text: "x", sink: c.sink, noTelegram: true });
    const topic = await c.telegram.runTurn({ conversationId: "topic-7", agent: "research", text: "x", sink: c.sink, noTelegram: true });
    web.afterReply?.();
    topic.afterReply?.();
    await settle();
    expect(s.offers).toHaveLength(0);
    expect(web.text).toBe(READABLE);
  });

  test("Antwort mit [INVOKE:]: keine Rückfrage, erst antworten die befragten Agenten", async () => {
    const s = setup();
    const c = chats(s);
    const invoking = `${TAGGED}\n[INVOKE:finance|Was kostet das?]`;
    replies.claude = [{ text: invoking }, { text: invoking }];
    const topic = await c.telegram.runTurn({ conversationId: "topic-7", agent: "research", text: "x", sink: c.sink });
    const web = await c.web.runTurn({ conversationId: WEB_ID, agent: "general", text: "x", sink: c.sink });
    topic.afterReply?.();
    web.afterReply?.();
    await settle();
    expect(s.offers).toHaveLength(0);
    // Die Fäden laufen im reinen Web-Gespräch trotzdem
    expect(s.events).toContain(`threads:${JSON.stringify({ type: "web", conversationId: WEB_ID })}`);
  });

  test("scheiterndes Anbieten: Antwort bleibt, die Fäden laufen trotzdem", async () => {
    const s = setup({ offer: async () => ({ status: "not-shown" }) });
    const c = chats(s);
    replies.claude = [{ text: TAGGED }];
    const result = await c.web.runTurn({ conversationId: WEB_ID, agent: "general", text: "x", sink: c.sink });
    result.afterReply?.();
    await settle();
    expect(result.text).toBe(READABLE);
    expect(s.events).toEqual(["offer", `threads:${JSON.stringify({ type: "web", conversationId: WEB_ID })}`]);
  });
});
