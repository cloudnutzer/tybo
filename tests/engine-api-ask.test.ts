/**
 * Issue #348, Checkbox 4: ask_user des Motors "api" über das
 * Rückfragen-Register. Echter Chat-Kern (runJsonTurn unter runExecution wie
 * in den Kanälen) mit dem echten Motor und API-Attrappe, echtes Register
 * (eigene Datei), echtes createAskOffer, createAskChoices und
 * settleTypedAnswer, echtes resumeMacTask mit echter Sperre;
 * Auftragsspeicher im Arbeitsspeicher, Session-Zeiger in einer Temp-Datei,
 * Claude Code als Attrappe. Kein Bot-Import.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ASK_ANSWERED_BY_TEXT, ASK_TEXT, createAskChoices, createAskOffer, settleTypedAnswer, type AskOffer, type AskOfferOutcome } from "../src/lib/ask-choices";
import { decideChoice, getChoice, onChoiceDecided, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { finalizeClaudeSession, resolveStreamingLimits, runJsonTurn, sessionLostNotice, type ChatTurnDeps, type TurnQuestion } from "../src/lib/chat-turn";
import { createApiEngine, type Engine, type EngineRequest } from "../src/lib/engines";
import { API_TEXT } from "../src/lib/engines/api";
import { fileApiSessionStore, parseSessionRef } from "../src/lib/engines/api-sessions";
import type { ApiToolHost } from "../src/lib/engines/api-tools";
import { runExecution } from "../src/lib/execution-context";
import { getResumableSession, getSessionsForKey, recordSessionTurn, resetSession, sessionEpoch, setSessionsFileForTests, takeExpiredSession } from "../src/lib/session-manager";
import type { TaskStore } from "../src/lib/store/ports";
import type { AsyncTask, TaskChanges } from "../src/lib/store/types";
import { sessionKeyFor } from "../src/lib/store/message-rules";
import { resumeMacTask, type TaskResumeDeps, taskResumePrompt } from "../src/lib/task-resume";
import { installApiFake, textReply, toolReply, until, type ApiFake } from "./api-fixture";

const GROUP = "-1001234567890";
const TOPIC = 443;
const KEY = sessionKeyFor(GROUP, TOPIC);
const base = mkdtempSync(join(tmpdir(), "tybo-348-ask-"));
let n = 0;

/** Auftragsspeicher im Arbeitsspeicher wie TaskStore */
function memoryTasks() {
  const rows = new Map<string, AsyncTask>();
  let next = 0;
  const store = {
    async create(chatId: string, originalPrompt: string, threadId?: number) {
      const at = new Date().toISOString();
      const task = { id: `task-${++next}`, created_at: at, updated_at: at, chat_id: chatId, original_prompt: originalPrompt, status: "running", metadata: {}, ...(threadId !== undefined ? { thread_id: threadId } : {}) } as AsyncTask;
      rows.set(task.id, task);
      return structuredClone(task);
    },
    async update(taskId: string, changes: TaskChanges) {
      const row = rows.get(taskId);
      if (!row) return false;
      for (const [k, v] of Object.entries(changes)) if (v !== undefined) (row as any)[k] = structuredClone(v);
      return true;
    },
    async byId(taskId: string) {
      const row = rows.get(taskId);
      return row ? structuredClone(row) : null;
    },
  } as unknown as TaskStore;
  return { store, rows };
}

let fake: ApiFake;
let tasks: ReturnType<typeof memoryTasks>;
let shown: Choice[];
let notices: string[];
let delivered: string[];
let reads: number;
let claudeRuns: EngineRequest[];
let turnNotices: string[];
let offer: (o: AskOffer) => Promise<AskOfferOutcome>;
let cleanup: (() => void)[];
let spies: { mockRestore(): void }[];

const readHost: ApiToolHost = {
  offered: () => [{ name: "t_lesen", description: "lesen", input_schema: { type: "object", properties: {} } }],
  call: async () => {
    reads++;
    return { content: "Wetter: sonnig", isError: false };
  },
  serverOf: () => undefined,
};

const sessionDeps = {
  isSessionModeEnabled: () => true,
  getResumableSession,
  takeExpiredSession,
  recordSessionTurn,
  getSessionsForKey,
  sessionEpoch,
  resetSession,
};

/** Echtes resumeMacTask: echter Motor api, echte Sperre, echter Session-Zeiger */
const resumeDeps: Partial<TaskResumeDeps> = {
  runExecution,
  getEngine: (() => createApiEngine()) as unknown as TaskResumeDeps["getEngine"],
  isSessionModeEnabled: () => true,
  getResumableSession,
  sessionEpoch,
  finalizeClaudeSession: (key, agent, result, mark, model, _deps, epoch) => finalizeClaudeSession(key, agent, result, mark, model, sessionDeps, epoch),
  resolveModel: () => "claude-opus-5-5",
  resolveEffort: () => undefined,
  allowedTools: () => undefined,
  cwd: base,
};

beforeEach(() => {
  setChoicesFileForTests(join(base, `choices-${++n}.json`));
  setSessionsFileForTests(join(base, `sessions-${n}.json`));
  spies = [spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {})];
  fake = installApiFake({ tools: readHost });
  tasks = memoryTasks();
  shown = [];
  notices = [];
  delivered = [];
  reads = 0;
  claudeRuns = [];
  turnNotices = [];
  cleanup = [];
  offer = createAskOffer({ sendChoice: async (choice) => (shown.push(choice), { sent: true }), tasks: () => tasks.store, log: () => {} });
  const ask = createAskChoices({
    notify: async (_c, text) => void notices.push(text),
    deliver: async (_c, text) => (delivered.push(text), true),
    saveMessage: async () => true,
    processIntents: async () => {},
    tasks: () => tasks.store,
    resume: (task, chatId, answer, channel) => resumeMacTask(task, chatId, answer, resumeDeps, channel),
    log: () => {},
  });
  cleanup.push(onChoiceDecided("ask", ask.handler));
});

afterEach(() => {
  for (const off of cleanup) off();
  fake.restore();
  setChoicesFileForTests(null);
  setSessionsFileForTests(null);
  for (const s of spies) s.mockRestore();
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

/** Claude Code als Attrappe: merkt sich jede Anfrage */
const claude: Engine = {
  id: "claude",
  describe: () => "Claude Code",
  run: async (req) => (claudeRuns.push(req), { engine: "claude", text: "von Claude", isError: false, sessionId: "claude-1" }),
};

function turnDeps(): Partial<ChatTurnDeps> {
  return {
    getEngine: ((id: string) => (id === "claude" ? claude : createApiEngine())) as ChatTurnDeps["getEngine"],
    forgetEngineCheck: () => {},
    runFallbackChain: async () => ({ text: "ersatz", source: "openrouter", model: "m" }),
    buildPromptContext: async ({ userMessage }) => ({ fullPrompt: `voll: ${userMessage}`, fallbackContext: "" }),
    buildResumePrompt: async ({ userMessage }) => `weiter: ${userMessage}`,
    ...sessionDeps,
    shouldDistill: () => false,
    distillSession: async () => {},
    log: async () => {},
    getAgentConfig: () => ({ model: "claude-opus-5-5" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
    resolveStreamingLimits: () => resolveStreamingLimits({}),
    reportSecrets: () => [],
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => Date.now(),
    offerAsk: (o) => offer(o),
    questionConversation: async (chatId, topicId) => ({ type: "telegram", chatId, ...(topicId !== undefined ? { topicId } : {}) }),
    settleTypedAnswer: (a) => settleTypedAnswer(a, { tasks: () => tasks.store, log: () => {} }),
  } as Partial<ChatTurnDeps>;
}

const sink = { progress: () => {}, notice: (text: string) => void turnNotices.push(text) };

/** Ein Turn im Topic mit Motor api, unter der Sperre des Gesprächs wie in den Kanälen; die Rückfrage geht ins Register */
async function turn(text: string): Promise<{ reply: string; question?: TurnQuestion }> {
  let question: TurnQuestion | undefined;
  const reply = await runExecution(KEY, "general", () =>
    runJsonTurn({ userMessage: text, chatId: GROUP, topicId: TOPIC, agentName: "general", engine: "api", sink, deps: turnDeps(), onQuestion: (q) => (question = q) })
  );
  if (question) await question.offer();
  return { reply, question };
}

/** Denkauftrag aus dem Telefonhörer: ohne Telegram, ohne onQuestion (wie bot-turn.ts) */
async function thinkTurn(text: string): Promise<string> {
  return runExecution(KEY, "general", () =>
    runJsonTurn({ userMessage: text, chatId: GROUP, topicId: TOPIC, agentName: "general", engine: "api", sink, deps: turnDeps(), noTelegram: { conversationId: "web-denk" } })
  );
}

const taskRow = () => [...tasks.rows.values()][0];

/** Modell liest erst, dann fragt es nach: Pause im Register */
async function pausedTurn() {
  fake.respond(
    toolReply([
      { id: "q1", name: "ask_user", input: { question: "Welche Farbe?", options: [{ label: "Rot" }, { label: "Blau" }] } },
      { id: "l1", name: "t_lesen" },
    ])
  );
  const t = await turn("Streich das Zimmer");
  expect(shown).toHaveLength(1);
  return { ...t, choice: shown[0] };
}

/** Anfragen, die das tool_result der Rückfrage q1 tragen */
const answersToQ1 = () => fake.bodies().filter((b) => JSON.stringify(b.messages.at(-1)).includes('"tool_use_id":"q1"'));

describe("ask_user pausiert über das Register", () => {
  test("Pause nach den übrigen Werkzeugen, Ergebnis mit [FRAGE] und sessionId, Rückfrage mit Motor api", async () => {
    const { reply, question, choice } = await pausedTurn();
    expect(fake.calls()).toBe(1);
    expect(reads).toBe(1);
    expect(question).toMatchObject({ question: "Welche Farbe?", options: ["Rot", "Blau"], via: "tag" });
    expect(reply).toContain("Welche Farbe?");
    expect(reply).not.toContain("[FRAGE:");
    expect(choice).toMatchObject({ kind: "ask", conversation: { type: "telegram", chatId: GROUP, topicId: TOPIC } });
    expect(choice.options.map((o) => o.label)).toEqual(["Rot", "Blau", "Abbrechen"]);
    const task = [...tasks.rows.values()][0];
    expect(task).toMatchObject({ status: "needs_input", chat_id: GROUP, thread_id: TOPIC, metadata: { engine: "api", model: "claude-opus-5-5" } });
    expect(parseSessionRef(task.session_id!)?.mark).toMatch(/^[0-9a-f]{12}$/);
  });

  test("Knopf: tool_result trägt die Antwort, die frühere Runde läuft nicht noch einmal, zweite Entscheidung abgewiesen", async () => {
    const { choice } = await pausedTurn();
    fake.respond(textReply("Dann Blau, bei sonnigem Wetter."));
    expect((await decideChoice(choice.id, "o1", "telegram")).status).toBe("decided");
    expect(fake.calls()).toBe(2);
    expect(reads).toBe(1);
    expect(fake.lastBody().messages.at(-1)).toEqual({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "l1", content: "Wetter: sonnig" },
        { type: "tool_result", tool_use_id: "q1", content: taskResumePrompt("Blau") },
      ],
    });
    expect(delivered).toEqual(["Dann Blau, bei sonnigem Wetter."]);
    // Zweite Entscheidung derselben Rückfrage: abgewiesen, der Motor läuft genau einmal
    expect((await decideChoice(choice.id, "o0", "web")).status).toBe("already");
    expect(fake.calls()).toBe(2);
    expect(answersToQ1()).toHaveLength(1);
    // Danach normaler Folgeturn ohne Pause: die Pause ist gelöscht
    fake.respond(textReply("Gern."));
    expect((await turn("Danke")).reply).toBe("Gern.");
    expect(fake.lastBody().messages.at(-1)).toEqual({ role: "user", content: "weiter: Danke" });
  });

  test("getippte Antwort statt Knopf: wird zum tool_result, Rückfrage abgelaufen, Auftrag completed; der alte Knopf setzt nichts fort", async () => {
    const { choice } = await pausedTurn();
    fake.respond(textReply("Blau also."));
    expect((await turn("Blau")).reply).toBe("Blau also.");
    expect(fake.lastBody().messages.at(-1).content).toEqual([
      { type: "tool_result", tool_use_id: "l1", content: "Wetter: sonnig" },
      { type: "tool_result", tool_use_id: "q1", content: "weiter: Blau" },
    ]);
    expect(reads).toBe(1);
    // Beantwortet heißt: nicht mehr offen, der Auftrag erledigt
    expect((await getChoice(choice.id))?.state).toBe("expired");
    expect(taskRow()).toMatchObject({ status: "completed", result: ASK_ANSWERED_BY_TEXT, user_response: "Blau", metadata: { answered_by: "text" } });
    // Der alte Knopf: abgewiesen, kein Abruf, der Auftrag bleibt completed
    expect((await decideChoice(choice.id, "o0", "telegram")).status).toBe("expired");
    expect(fake.calls()).toBe(2);
    expect(answersToQ1()).toHaveLength(1);
    expect(delivered).toEqual([]);
    expect(notices).toEqual([]);
    expect(taskRow().status).toBe("completed");
  });

  test("Text und Klick gleichzeitig, Text zuerst: eine Fortsetzung (der Text), der wartende Klick setzt nichts fort, Auftrag bleibt completed", async () => {
    const { choice } = await pausedTurn();
    const releaseText = fake.respondGated(textReply("Rot also."));
    const typed = turn("Rot");
    // Der Text-Turn hält die Sperre des Gesprächs, sein Abruf hängt
    await until(() => fake.calls() === 2);
    const clicked = decideChoice(choice.id, "o1", "telegram");
    // Der Klick hat den Auftrag beansprucht und wartet auf die Sperre
    await until(() => taskRow().status === "running");
    releaseText();
    const [t, c] = await Promise.all([typed, clicked]);
    expect(t.reply).toBe("Rot also.");
    expect(c.status).toBe("decided");
    // Motor: Pause, Text; der Klick ruft die API nicht mehr
    expect(fake.calls()).toBe(2);
    expect(fake.pending()).toBe(0);
    expect(answersToQ1()).toHaveLength(1);
    expect(answersToQ1()[0].messages.at(-1).content.at(-1)).toEqual({ type: "tool_result", tool_use_id: "q1", content: "weiter: Rot" });
    expect(reads).toBe(1);
    // Nebenwirkungen: keine Antwort aus dem Klick, eine Meldung, Auftrag completed, kein Handlerfehler
    expect(delivered).toEqual([]);
    expect(notices).toEqual([ASK_TEXT.answeredByText]);
    expect(taskRow()).toMatchObject({ status: "completed", result: ASK_ANSWERED_BY_TEXT, user_response: "Rot" });
    expect((await getChoice(choice.id))?.handlerError).toBeUndefined();
    expect(claudeRuns).toEqual([]);
  });

  test("Text und Klick gleichzeitig, Klick zuerst: der Klick beantwortet, der Text ist ein normaler Folgeturn", async () => {
    const { choice } = await pausedTurn();
    const releaseClick = fake.respondGated(textReply("Dann Blau."));
    const clicked = decideChoice(choice.id, "o1", "telegram");
    // Die Fortsetzung des Klicks hält die Sperre des Gesprächs, ihr Abruf hängt
    await until(() => fake.calls() === 2);
    fake.respond(textReply("Rot geht auch."));
    const typed = turn("Rot");
    releaseClick();
    const [c, t] = await Promise.all([clicked, typed]);
    expect(c.status).toBe("decided");
    expect(t.reply).toBe("Rot geht auch.");
    // Motor: Pause, Klick, Folgeturn; die Frage genau einmal beantwortet
    expect(fake.calls()).toBe(3);
    expect(answersToQ1()).toHaveLength(1);
    expect(fake.bodies()[1].messages.at(-1).content.at(-1)).toEqual({ type: "tool_result", tool_use_id: "q1", content: taskResumePrompt("Blau") });
    // Der Text hängt als neue Nachricht an derselben Sitzung, kein frischer Lauf
    expect(fake.lastBody().messages[0]).toEqual({ role: "user", content: "voll: Streich das Zimmer" });
    expect(fake.lastBody().messages.at(-1)).toEqual({ role: "user", content: "weiter: Rot" });
    expect(reads).toBe(1);
    expect(delivered).toEqual(["Dann Blau."]);
    expect(notices).toEqual([]);
    expect(taskRow()).toMatchObject({ status: "completed", result: "Dann Blau." });
    expect(taskRow().metadata?.answered_by).toBeUndefined();
    expect(claudeRuns).toEqual([]);
  });

  test("veralteter Pausenbezug im Chat-Kern: normaler Folgeturn derselben Sitzung, kein frischer Ersatzlauf", async () => {
    const { choice } = await pausedTurn();
    const asked = taskRow().session_id!;
    fake.respond(textReply("Blau, gut."));
    await decideChoice(choice.id, "o1", "telegram");
    // Zeiger der Topic-Session zeigt noch auf die beantwortete Frage
    expect(await recordSessionTurn(KEY, "general", "claude-opus-5-5", "api", asked)).toBe(true);
    fake.respond(textReply("Noch etwas Weiß?"));
    expect((await turn("Und die Decke?")).reply).toBe("Noch etwas Weiß?");
    expect(fake.calls()).toBe(3);
    expect(fake.lastBody().messages[0]).toEqual({ role: "user", content: "voll: Streich das Zimmer" });
    expect(fake.lastBody().messages.at(-1)).toEqual({ role: "user", content: "weiter: Und die Decke?" });
    expect(claudeRuns).toEqual([]);
    expect(turnNotices).toEqual([]);
  });

  test("Fortsetzen nach neuem Aufbau von Speicher und Motor", async () => {
    const { choice } = await pausedTurn();
    fake.use({ sessions: fileApiSessionStore(() => fake.sessionDir) });
    fake.respond(textReply("Rot, gut."));
    await decideChoice(choice.id, "o0", "telegram");
    expect(fake.lastBody().messages.at(-1).content.at(-1)).toEqual({ type: "tool_result", tool_use_id: "q1", content: taskResumePrompt("Rot") });
    expect(delivered).toEqual(["Rot, gut."]);
  });
});

describe("Denkauftrag (noTelegram) und Rückfragen", () => {
  /** Anfragen, deren tool_result zu q1 eine echte Antwort trägt (nicht den Hinweis des Denkauftrags) */
  const realAnswersToQ1 = () =>
    answersToQ1().filter((b) => b.messages.at(-1).content.some((c: any) => c.tool_use_id === "q1" && c.content !== API_TEXT.questionOpen));

  async function thinkWhilePaused() {
    const paused = await pausedTurn();
    const asked = taskRow().session_id!;
    const sessionFile = join(fake.sessionDir, `${parseSessionRef(asked)!.id}.json`);
    const before = readFileSync(sessionFile, "utf8");
    fake.respond(textReply("Gedanke fertig."));
    expect(await thinkTurn("Denk über Farben nach")).toBe("Gedanke fertig.");
    // Der Denkauftrag sieht die Frage als offen, beantwortet sie nicht und bekommt kein ask_user
    const body = fake.lastBody();
    expect(body.messages.at(-1).content).toEqual([
      { type: "tool_result", tool_use_id: "l1", content: "Wetter: sonnig" },
      { type: "tool_result", tool_use_id: "q1", content: API_TEXT.questionOpen },
      { type: "text", text: "weiter: Denk über Farben nach" },
    ]);
    expect(body.tools.map((t: any) => t.name)).not.toContain("ask_user");
    // Rückfrage, Auftrag, Sitzung und Zeiger unverändert
    expect((await getChoice(paused.choice.id))?.state).toBe("open");
    expect(taskRow()).toMatchObject({ status: "needs_input", session_id: asked });
    expect(readFileSync(sessionFile, "utf8")).toBe(before);
    expect((await getSessionsForKey(KEY))[0].engineSessionId).toBe(asked);
    expect(realAnswersToQ1()).toHaveLength(0);
    return paused;
  }

  test("bei offener Rückfrage: bleibt offen, danach genau einmal per Knopf beantwortbar", async () => {
    const { choice } = await thinkWhilePaused();
    fake.respond(textReply("Dann Blau."));
    expect((await decideChoice(choice.id, "o1", "telegram")).status).toBe("decided");
    expect(fake.lastBody().messages.at(-1).content).toEqual([
      { type: "tool_result", tool_use_id: "l1", content: "Wetter: sonnig" },
      { type: "tool_result", tool_use_id: "q1", content: taskResumePrompt("Blau") },
    ]);
    expect(JSON.stringify(fake.lastBody().messages)).not.toContain("Denk über Farben nach");
    expect(delivered).toEqual(["Dann Blau."]);
    expect((await decideChoice(choice.id, "o0", "web")).status).toBe("already");
    expect(realAnswersToQ1()).toHaveLength(1);
    expect(taskRow()).toMatchObject({ status: "completed", result: "Dann Blau." });
    expect(reads).toBe(1);
  });

  test("bei offener Rückfrage: danach genau einmal getippt beantwortbar, der Knopf setzt nichts mehr fort", async () => {
    const { choice } = await thinkWhilePaused();
    fake.respond(textReply("Blau also."));
    expect((await turn("Blau")).reply).toBe("Blau also.");
    expect(fake.lastBody().messages.at(-1).content.at(-1)).toEqual({ type: "tool_result", tool_use_id: "q1", content: "weiter: Blau" });
    expect((await getChoice(choice.id))?.state).toBe("expired");
    expect(taskRow()).toMatchObject({ status: "completed", result: ASK_ANSWERED_BY_TEXT, user_response: "Blau" });
    const calls = fake.calls();
    expect((await decideChoice(choice.id, "o0", "telegram")).status).toBe("expired");
    expect(fake.calls()).toBe(calls);
    expect(realAnswersToQ1()).toHaveLength(1);
  });

  test("ask_user im Denkauftrag: nicht angeboten, ein Aufruf trotzdem ergibt Fehlerergebnis, keine Pause und keine Rückfrage", async () => {
    fake.respond(toolReply([{ id: "q1", name: "ask_user", input: { question: "Welche Farbe?" } }]));
    fake.respond(textReply("Ohne Rückfrage: Blau."));
    expect(await thinkTurn("Denk über Farben nach")).toBe("Ohne Rückfrage: Blau.");
    expect(fake.bodies()[0].tools.map((t: any) => t.name)).not.toContain("ask_user");
    expect(fake.bodies()[1].messages.at(-1).content).toEqual([
      { type: "tool_result", tool_use_id: "q1", content: expect.stringContaining("keine Rückfragen"), is_error: true },
    ]);
    expect(shown).toEqual([]);
    expect(tasks.rows.size).toBe(0);
    // Gespeichert ohne Pause: der nächste getippte Turn ist ein normaler Folgeturn
    const [stored] = await getSessionsForKey(KEY);
    expect(parseSessionRef(stored.engineSessionId)?.mark).toBeUndefined();
    fake.respond(textReply("Gern."));
    expect((await turn("Danke")).reply).toBe("Gern.");
    expect(fake.lastBody().messages.at(-1)).toEqual({ role: "user", content: "weiter: Danke" });
    expect(fake.lastBody().messages[0]).toEqual({ role: "user", content: "voll: Denk über Farben nach" });
  });
});

describe("ask_user im Motor", () => {
  const run = (extra: Partial<EngineRequest> = {}) =>
    // Wie ein Turn mit Rückfragen-Register (Chat-Kern mit onQuestion)
    createApiEngine().run({ prompt: "Los", streaming: false, timeoutMs: 60_000, cwd: base, questions: true, ...extra });

  test("ungültige Rückfrage (mit |) und zweite Rückfrage je Runde: Fehlerergebnis, nur eine Pause", async () => {
    fake.respond(
      toolReply([
        { id: "bad", name: "ask_user", input: { question: "A | B?" } },
        { id: "q1", name: "ask_user", input: { question: "Wirklich?" } },
        { id: "q2", name: "ask_user", input: { question: "Und das?" } },
      ])
    );
    const r = await run();
    expect(r.text).toBe("[FRAGE: Wirklich? | Ja | Nein]");
    expect(fake.calls()).toBe(1);
    fake.respond(textReply("ok"));
    await run({ prompt: "User responded: Ja", resumeSessionId: r.sessionId });
    const content = fake.lastBody().messages.at(-1).content;
    expect(content.map((b: any) => [b.tool_use_id, b.is_error === true])).toEqual([
      ["bad", true],
      ["q2", true],
      ["q1", false],
    ]);
  });

  test("doppelte Beschriftungen: Fehlerergebnis, keine Pause, die Schleife läuft weiter", async () => {
    fake.respond(toolReply([{ id: "d1", name: "ask_user", input: { question: "Welche?", options: [{ label: "A" }, { label: "a" }] } }]));
    fake.respond(textReply("Dann frage ich anders."));
    const r = await run();
    expect(r.text).toBe("Dann frage ich anders.");
    expect(fake.bodies()[1].messages.at(-1).content[0]).toMatchObject({ tool_use_id: "d1", is_error: true });
  });

  test("fremde Inhalte vor der Pause gelten auch für die Fortsetzung", async () => {
    fake.respond(toolReply([{ id: "l1", name: "t_lesen" }, { id: "q1", name: "ask_user", input: { question: "Speichern?" } }]));
    const paused = await run();
    expect(paused.tools?.uses).toContainEqual({ name: "t_lesen", external: true });
    fake.respond(textReply("[REMEMBER: sonnig]"));
    const resumed = await run({ prompt: "User responded: Ja", resumeSessionId: paused.sessionId });
    expect(resumed.tools?.uses).toContainEqual({ name: "t_lesen", external: true });
  });

  test("Knopf mit Marke nach beantworteter Pause: context, kein Abruf; getippt mit derselben Marke: normaler Folgeturn", async () => {
    fake.respond(toolReply([{ id: "q1", name: "ask_user", input: { question: "Weiter?" } }]));
    const paused = await run();
    fake.respond(textReply("ok"));
    const answered = await run({ prompt: "User responded: Ja", resumeSessionId: paused.sessionId, answersQuestion: true });
    expect(answered.sessionId).toBe(parseSessionRef(paused.sessionId!)!.id);
    expect(answered.answeredQuestion).toBe(paused.sessionId);
    const again = await run({ prompt: "User responded: Nein", resumeSessionId: paused.sessionId, answersQuestion: true });
    expect(again).toMatchObject({ isError: true, errorKind: "context" });
    expect(fake.calls()).toBe(2);
    fake.respond(textReply("weiter gehts"));
    const typed = await run({ prompt: "Noch was", resumeSessionId: paused.sessionId });
    expect(typed).toMatchObject({ isError: false, text: "weiter gehts" });
    expect(typed.answeredQuestion).toBeUndefined();
    expect(fake.lastBody().messages.at(-1)).toEqual({ role: "user", content: "Noch was" });
  });

  test("Knopf einer älteren Frage, während eine neuere offen ist: context, kein Abruf", async () => {
    fake.respond(toolReply([{ id: "q1", name: "ask_user", input: { question: "Erste?" } }]));
    const first = await run();
    fake.respond(toolReply([{ id: "q2", name: "ask_user", input: { question: "Zweite?" } }]));
    const second = await run({ prompt: "Ja", resumeSessionId: first.sessionId });
    expect(second.sessionId).not.toBe(first.sessionId);
    const old = await run({ prompt: "User responded: Nein", resumeSessionId: first.sessionId, answersQuestion: true });
    expect(old).toMatchObject({ isError: true, errorKind: "context" });
    expect(fake.calls()).toBe(2);
  });
});

describe("Sitzung fehlt, ungültig oder beschädigt: Claude Code antwortet", () => {
  const damage: [string, (file: string) => void][] = [
    ["fehlt", (file) => rmSync(file)],
    ["beschädigt (kein JSON)", (file) => writeFileSync(file, "{kaputt")],
    [
      "ungültig (tool_use ohne ID, Name und Eingabe)",
      (file) => {
        const s = JSON.parse(readFileSync(file, "utf8"));
        s.messages[1].content = [{ type: "tool_use" }];
        writeFileSync(file, JSON.stringify(s));
      },
    ],
  ];
  for (const [label, harm] of damage) {
    test(`Sitzung ${label}: kein frischer API-Lauf, Claude Code mit vollem Prompt, Datei unverändert`, async () => {
      fake.respond(textReply("erste"));
      await turn("Hallo");
      const [stored] = await getSessionsForKey(KEY);
      const file = join(fake.sessionDir, `${parseSessionRef(stored.engineSessionId)!.id}.json`);
      harm(file);
      const before = label === "fehlt" ? null : readFileSync(file, "utf8");
      expect((await turn("Noch da?")).reply).toBe("von Claude");
      // Nur der erste Turn rief die API; der Kontextfehler kam ohne Abruf
      expect(fake.calls()).toBe(1);
      expect(claudeRuns).toHaveLength(1);
      expect(claudeRuns[0].prompt).toBe("voll: Noch da?");
      expect(claudeRuns[0].resumeSessionId).toBeUndefined();
      expect(turnNotices).toEqual([sessionLostNotice("api")]);
      if (before !== null) expect(readFileSync(file, "utf8")).toBe(before);
      // Der Folgeturn setzt die Session von Claude Code fort, nicht die kaputte
      const [now] = await getSessionsForKey(KEY);
      expect(now).toMatchObject({ engine: "claude", engineSessionId: "claude-1" });
    });
  }
});

describe("Ausgabe einer Pause wird als Ganzes geprüft (Chat-Kern)", () => {
  const ask = { id: "q1", name: "ask_user", input: { question: "Welche Farbe?", options: [{ label: "Rot" }, { label: "Blau" }] } };
  const cases: [string, string, string][] = [
    ["eigener FRAGE-Tag im Text", "Vorher: [FRAGE: Grün? | Ja | Nein]", "Grün?"],
    ["angefangener FRAGE-Tag ohne Klammer", "Siehe [FRAGE: offen", "offen"],
    ["offener Codeblock", "Plan:\n```\nschritt 1", "schritt 1"],
    ["offener Codeblock mit Tilden", "Plan:\n~~~\nschritt 2", "schritt 2"],
  ];
  for (const [label, text, kept] of cases) {
    test(`${label}: genau diese Rückfrage im Register, Text des Modells bleibt lesbar`, async () => {
      fake.respond(toolReply([ask], { text }));
      const { reply, question } = await turn("Streich das Zimmer");
      expect(question).toMatchObject({ question: "Welche Farbe?", options: ["Rot", "Blau"], via: "tag" });
      expect(shown).toHaveLength(1);
      expect(shown[0].text).toBe("Welche Farbe?");
      expect(shown[0].options.map((o) => o.label)).toEqual(["Rot", "Blau", "Abbrechen"]);
      expect(taskRow()).toMatchObject({ status: "needs_input", pending_question: "Welche Farbe?" });
      expect(reply).toContain(kept);
      expect(reply).toContain("Welche Farbe?");
      expect(reply).not.toContain("[FRAGE:");
      expect(fake.calls()).toBe(1);
    });
  }
});
