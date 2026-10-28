/**
 * Issue #348: per [INVOKE:] befragter Agent auf dem Motor "api", im
 * Folgeauftrag eines Denkauftrags (noTelegram) und als gewöhnliche
 * Konsultation (WebUI und Telegram). Echter Aufrufpfad: WebUI-Turn
 * im Telegram-Topic (createTelegramChat), gemeinsamer Abschluss, followUp mit
 * webConsultRunner, echter Chat-Kern, echter Motor mit API-Attrappe. Echtes
 * Rückfragen-Register (eigene Datei) mit createAskOffer, createAskChoices und
 * resumeMacTask, Planungswerkzeuge gegen einen Datei-ScheduleStore im
 * Temp-Ordner. Auftragsspeicher im Arbeitsspeicher, Telegram als Attrappe.
 * Telegram-Weg über
 * consultViaAgentBots und createBotTurns, Telefon-Weg über createCallTaskTurn
 * mit callClaude wie in src/bot.ts. Dazu die Klasse: jeder Turn ohne
 * Rückfragen-Weg (kein onQuestion) beantwortet keine offene Rückfrage und
 * bekommt kein ask_user. Kein Bot-Import.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBotTurns } from "../src/app/bot-turns";
import { consultViaAgentBots } from "../src/lib/agent-consult";
import { createAskChoices, createAskOffer, settleTypedAnswer, type AskOffer, type AskOfferOutcome } from "../src/lib/ask-choices";
import { decideChoice, getChoice, onChoiceDecided, setChoicesFileForTests, type Choice } from "../src/lib/choices";
import { finalizeClaudeSession, resolveStreamingLimits, runJsonTurn, runStreamingTurn, type ChatTurnDeps, type TurnOptions, type TurnQuestion } from "../src/lib/chat-turn";
import { createApiEngine } from "../src/lib/engines";
import { API_TEXT } from "../src/lib/engines/api";
import { parseSessionRef } from "../src/lib/engines/api-sessions";
import { LIST_SCHEDULED, CANCEL_SCHEDULED, realScheduleToolDeps, SCHEDULE_TASK, type ApiToolHost } from "../src/lib/engines/api-tools";
import { abortExecutions, isAbortError, runExecution } from "../src/lib/execution-context";
import { createCallTaskTurn } from "../src/lib/phone/task-turn";
import { createReminderSender } from "../src/lib/reminder-choices";
import type { ScheduleStore } from "../src/lib/schedule/contract";
import { fileScheduleStore } from "../src/lib/schedule/file";
import { reminderRef } from "../src/lib/schedule/overview";
import { getResumableSession, getSessionsForKey, recordSessionTurn, resetSession, sessionEpoch, setSessionsFileForTests, takeExpiredSession } from "../src/lib/session-manager";
import type { TaskStore } from "../src/lib/store/ports";
import type { AsyncTask, TaskChanges } from "../src/lib/store/types";
import { sessionKeyFor } from "../src/lib/store/message-rules";
import { resumeMacTask, type TaskResumeDeps, taskResumePrompt } from "../src/lib/task-resume";
import { setToolApprovalHandler, type BuiltinTool } from "../src/lib/tools/registry";
import { createTelegramChat } from "../src/web/bot-turn";
import type { FollowUpOutput } from "../src/web/chat";
import { installApiFake, textReply, toolReply, type ApiFake } from "./api-fixture";

const GROUP = "-1001234567890";
const TOPIC = 5;
const CONVERSATION = `topic-${TOPIC}`;
const KEY = sessionKeyFor(GROUP, TOPIC);
const NOW = Date.parse("2026-10-21T10:00:00Z");
const base = mkdtempSync(join(tmpdir(), "tybo-348-consult-"));
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
let schedule: ScheduleStore;
let shown: Choice[];
let delivered: string[];
let telegramSent: string[];
let approvals: string[];
let offer: (o: AskOffer) => Promise<AskOfferOutcome>;
let cleanup: (() => void)[];
let spies: { mockRestore(): void }[];

const readHost: ApiToolHost = {
  offered: () => [{ name: "t_lesen", description: "lesen", input_schema: { type: "object", properties: {} } }],
  call: async () => ({ content: "Wetter: sonnig", isError: false }),
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
  const schedulePath = join(base, `reminders-${n}.json`);
  schedule = fileScheduleStore(() => schedulePath);
  spies = [spyOn(console, "log").mockImplementation(() => {}), spyOn(console, "warn").mockImplementation(() => {}), spyOn(console, "error").mockImplementation(() => {})];
  fake = installApiFake({ tools: readHost });
  // Echte Gesprächsbestimmung und echte Freigabe, nur Ablage, Uhr und Zeitzone fest
  fake.use({ schedule: { ...realScheduleToolDeps, store: () => schedule, now: () => NOW, timeZone: () => "Europe/Berlin" } });
  approvals = [];
  setToolApprovalHandler(async (tool: BuiltinTool) => (approvals.push(tool.name), true));
  tasks = memoryTasks();
  shown = [];
  delivered = [];
  telegramSent = [];
  cleanup = [];
  offer = createAskOffer({ sendChoice: async (choice) => (shown.push(choice), { sent: true }), tasks: () => tasks.store, log: () => {} });
  const ask = createAskChoices({
    notify: async () => {},
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
  setToolApprovalHandler(null);
  setChoicesFileForTests(null);
  setSessionsFileForTests(null);
  for (const s of spies) s.mockRestore();
});

afterAll(() => rmSync(base, { recursive: true, force: true }));

function turnDeps(): Partial<ChatTurnDeps> {
  return {
    getEngine: (() => createApiEngine()) as unknown as ChatTurnDeps["getEngine"],
    resolveEngine: (async () => ({ engine: "api", requested: "api", source: "code" })) as unknown as ChatTurnDeps["resolveEngine"],
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
    now: () => NOW,
    offerAsk: (o) => offer(o),
    questionConversation: async (chatId, topicId) => ({ type: "telegram", chatId, ...(topicId !== undefined ? { topicId } : {}) }),
    settleTypedAnswer: (a) => settleTypedAnswer(a, { tasks: () => tasks.store, log: () => {} }),
  } as Partial<ChatTurnDeps>;
}

/** Echte Verdrahtung der WebUI im Telegram-Topic mit [INVOKE:]-Budget; Telegram als Attrappe */
function telegramChat() {
  const deps = turnDeps();
  return createTelegramChat({
    runStreamingTurn: (o: TurnOptions) => runStreamingTurn({ ...o, deps }),
    saveMessage: async () => true,
    processIntents: async () => {},
    abortEngineCalls: (key: string) => abortExecutions(key),
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
    invokeBudget: 3,
    recentMessages: async () => [],
    userId: "4711",
    groupId: () => GROUP,
    agentForTopic: () => "general",
    sendPlain: async (_chat, text) => void telegramSent.push(text),
    sendAsAgent: async (_agent, _chat, text) => void telegramSent.push(text),
    sendTypingAsAgent: async () => void telegramSent.push("tippt"),
  });
}

/**
 * Turn im Topic: General antwortet mit [INVOKE:research|...], dann läuft der
 * Folgeauftrag. Standard ist ein Denkauftrag; noTelegram false ist ein
 * gewöhnlicher getippter Turn in der WebUI.
 */
async function thinkWithConsult(consultReplies: string[], noTelegram = true): Promise<{ text: string; answers: string[] }> {
  fake.respond(textReply("Ich frage Research. [INVOKE:research|Welche Farbe passt?]"));
  for (const reply of consultReplies) fake.respond(reply);
  const result = await telegramChat().runTurn({
    conversationId: CONVERSATION,
    agent: "general",
    text: "Denkauftrag aus dem Telefongespräch: Streichen",
    sink: { progress: () => {}, notice: () => {} },
    noTelegram,
  });
  expect(result.followUp).toBeDefined();
  const answers: string[] = [];
  const output: FollowUpOutput = { signal: new AbortController().signal, answer: async (text) => void answers.push(text), notice: async () => {} };
  await result.followUp!(output);
  return { text: result.text, answers };
}

/** Research (oder agent) fragt im Topic nach (getippter Turn): offene Rückfrage im Register */
async function researchAsks(agent = "research"): Promise<{ choice: Choice; asked: string }> {
  fake.respond(
    toolReply([
      { id: "q1", name: "ask_user", input: { question: "Welche Farbe?", options: [{ label: "Rot" }, { label: "Blau" }] } },
      { id: "l1", name: "t_lesen" },
    ])
  );
  let question: TurnQuestion | undefined;
  await runExecution(KEY, agent, () =>
    runJsonTurn({ userMessage: "Streich das Zimmer", chatId: GROUP, topicId: TOPIC, agentName: agent, engine: "api", sink: { progress: () => {}, notice: () => {} }, deps: turnDeps(), onQuestion: (q) => (question = q) })
  );
  await question!.offer();
  expect(shown).toHaveLength(1);
  return { choice: shown[0], asked: [...tasks.rows.values()][0].session_id! };
}

const consultBody = () => fake.bodies().find((b) => JSON.stringify(b.messages).includes("Welche Farbe passt?"));
const realAnswersToQ1 = () =>
  fake.bodies().filter((b) => {
    const last = b.messages.at(-1);
    return Array.isArray(last.content) && last.content.some((c: any) => c.tool_use_id === "q1" && c.content !== API_TEXT.questionOpen);
  });

describe("Folgeauftrag eines Denkauftrags ([INVOKE:]) auf dem Motor api", () => {
  test("offene Rückfrage des befragten Agenten bleibt offen und ist danach genau einmal beantwortbar", async () => {
    const { choice, asked } = await researchAsks();
    const sessionFile = join(fake.sessionDir, `${parseSessionRef(asked)!.id}.json`);
    const before = readFileSync(sessionFile, "utf8");

    const { answers } = await thinkWithConsult([textReply("Research meint: Grün.")]);
    expect(answers).toEqual(["Research meint: Grün."]);
    // Der befragte Agent sieht die Frage als offen, beantwortet sie nicht und bekommt kein ask_user
    const body = consultBody();
    expect(body.messages.at(-1).content).toEqual([
      { type: "tool_result", tool_use_id: "l1", content: "Wetter: sonnig" },
      { type: "tool_result", tool_use_id: "q1", content: API_TEXT.questionOpen },
      { type: "text", text: expect.stringContaining("Welche Farbe passt?") },
    ]);
    expect(body.tools.map((t: any) => t.name)).not.toContain("ask_user");
    expect((await getChoice(choice.id))?.state).toBe("open");
    expect([...tasks.rows.values()][0]).toMatchObject({ status: "needs_input", session_id: asked });
    expect(readFileSync(sessionFile, "utf8")).toBe(before);
    expect((await getSessionsForKey(KEY)).find((s) => s.agentName === "research")?.engineSessionId).toBe(asked);
    expect(realAnswersToQ1()).toHaveLength(0);
    expect(telegramSent).toEqual([]);

    // Danach genau einmal per Knopf beantwortbar
    fake.respond(textReply("Dann Blau."));
    expect((await decideChoice(choice.id, "o1", "telegram")).status).toBe("decided");
    expect(fake.lastBody().messages.at(-1).content).toEqual([
      { type: "tool_result", tool_use_id: "l1", content: "Wetter: sonnig" },
      { type: "tool_result", tool_use_id: "q1", content: taskResumePrompt("Blau") },
    ]);
    expect(delivered).toEqual(["Dann Blau."]);
    expect((await decideChoice(choice.id, "o0", "web")).status).toBe("already");
    expect(realAnswersToQ1()).toHaveLength(1);
    expect([...tasks.rows.values()][0]).toMatchObject({ status: "completed", result: "Dann Blau." });
  });

  test("ask_user im Folgeauftrag: nicht angeboten, ein Aufruf trotzdem ergibt Fehlerergebnis, keine Pause und keine Rückfrage", async () => {
    const { answers } = await thinkWithConsult([
      toolReply([{ id: "q9", name: "ask_user", input: { question: "Welche Farbe?" } }]),
      textReply("Ohne Rückfrage: Grün."),
    ]);
    expect(answers).toEqual(["Ohne Rückfrage: Grün."]);
    const body = consultBody();
    expect(body.tools.map((t: any) => t.name)).not.toContain("ask_user");
    expect(fake.lastBody().messages.at(-1).content).toEqual([
      { type: "tool_result", tool_use_id: "q9", content: expect.stringContaining("keine Rückfragen"), is_error: true },
    ]);
    expect(shown).toEqual([]);
    expect(tasks.rows.size).toBe(0);
    const stored = (await getSessionsForKey(KEY)).find((s) => s.agentName === "research");
    expect(stored).toBeDefined();
    expect(parseSessionRef(stored!.engineSessionId)?.mark).toBeUndefined();
    expect(telegramSent).toEqual([]);
  });

  test("Planungswerkzeuge im Folgeauftrag: nur das WebUI-Ziel, keine Zustellung nach Telegram", async () => {
    const twin = await schedule.add({ chatId: GROUP, topicId: TOPIC, text: "Über Telegram", dueAt: new Date(NOW + 3_600_000) });
    const { answers } = await thinkWithConsult([
      toolReply([{ id: "s1", name: SCHEDULE_TASK, input: { text: "Pflanzen gießen", when: "morgen 9 Uhr" } }]),
      toolReply([{ id: "s2", name: LIST_SCHEDULED, input: {} }]),
      toolReply([{ id: "s3", name: CANCEL_SCHEDULED, input: { id: reminderRef(twin.id) } }]),
      textReply("Ist notiert."),
    ]);
    expect(answers).toEqual(["Ist notiert."]);
    const task = (await schedule.listAll())!.find((t) => t.id !== twin.id)!;
    expect(task).toMatchObject({ chatId: `webui:${GROUP}`, topicId: TOPIC, text: "Pflanzen gießen" });
    // Auflisten und Absagen sehen nur das WebUI-Ziel: der Telegram-Eintrag fehlt und bleibt unberührt
    const results = fake.bodies().flatMap((b) => {
      const last = b.messages.at(-1);
      return Array.isArray(last.content) ? last.content.filter((c: any) => c.type === "tool_result") : [];
    });
    const listed = results.find((r: any) => r.tool_use_id === "s2");
    expect(listed.content).toContain(reminderRef(task.id));
    expect(listed.content).not.toContain("Über Telegram");
    expect(results.find((r: any) => r.tool_use_id === "s3")).toMatchObject({ is_error: true });
    expect((await schedule.byId(twin.id))!.status).toBe("pending");
    expect(approvals).toEqual([SCHEDULE_TASK]);

    // Zustellung durch den echten Versand bei eingerichtetem Telegram: nur ins WebUI-Gespräch
    const deliver: unknown[] = [];
    const web: string[] = [];
    const send = createReminderSender({
      telegram: () => true,
      deliver: (async (_text: string, target: any) => (deliver.push(target), { delivered: true, outcome: "delivered", telegram: [] })) as any,
      postWeb: async (conversationId) => (web.push(conversationId), true),
      createChoice: (async (input: any) => ({ ...input, id: "c1", state: "open", createdAt: NOW })) as any,
      attach: async () => undefined,
      expire: async () => ({ status: "unknown" }) as any,
      log: () => {},
    });
    expect(await send(task, "Erinnerung")).toBe("delivered");
    expect(web).toEqual([CONVERSATION]);
    expect(deliver).toEqual([]);
    expect(telegramSent).toEqual([]);
  });
});

/** Telegram-Weg: consultViaAgentBots mit ask der Bot-Turns (wie bot-telegram-channel.ts), echter Chat-Kern */
function botTurns(deps: Partial<ChatTurnDeps>) {
  return createBotTurns<unknown>({
    runJson: (o) => runJsonTurn({ ...o, deps }),
    runStreaming: (o) => runStreamingTurn({ ...o, deps }),
    runExecution,
    isAbort: isAbortError,
    allowedTools: () => undefined,
    rememberSession: async () => {},
    sendAsAgent: async (_agent, _chat, text) => void telegramSent.push(text),
    progressSink: () => ({ progress: () => {}, notice: async () => {} }),
  });
}

async function telegramConsult(): Promise<string | null> {
  const turns = botTurns(turnDeps());
  return consultViaAgentBots({
    bots: { sendTypingAsAgent: async () => void telegramSent.push("tippt"), sendAsAgent: async (_agent, _chat, text) => void telegramSent.push(text) },
    fromAgent: "general",
    request: { targetAgent: "research", question: "Welche Farbe passt?" },
    chatId: GROUP,
    threadId: TOPIC,
    ask: turns.ask,
    deps: { recent: async () => [] },
  });
}

/**
 * Die offene Rückfrage von agent ist unberührt und danach genau einmal per
 * Knopf beantwortbar. marker erkennt die Anfrage des Laufs, der sie nicht
 * beantworten darf.
 */
async function expectStillOpenThenAnswerOnce(choice: Choice, asked: string, sessionFile: string, before: string, marker = "Welche Farbe passt?", agent = "research") {
  const body = fake.bodies().find((b) => JSON.stringify(b.messages).includes(marker));
  expect(body).toBeDefined();
  expect(body.messages.at(-1).content).toEqual([
    { type: "tool_result", tool_use_id: "l1", content: "Wetter: sonnig" },
    { type: "tool_result", tool_use_id: "q1", content: API_TEXT.questionOpen },
    { type: "text", text: expect.stringContaining(marker) },
  ]);
  expect(body.tools.map((t: any) => t.name)).not.toContain("ask_user");
  expect((await getChoice(choice.id))?.state).toBe("open");
  expect([...tasks.rows.values()][0]).toMatchObject({ status: "needs_input", session_id: asked });
  expect(readFileSync(sessionFile, "utf8")).toBe(before);
  expect((await getSessionsForKey(KEY)).find((s) => s.agentName === agent)?.engineSessionId).toBe(asked);
  expect(realAnswersToQ1()).toHaveLength(0);

  fake.respond(textReply("Dann Blau."));
  expect((await decideChoice(choice.id, "o1", "telegram")).status).toBe("decided");
  expect(fake.lastBody().messages.at(-1).content).toEqual([
    { type: "tool_result", tool_use_id: "l1", content: "Wetter: sonnig" },
    { type: "tool_result", tool_use_id: "q1", content: taskResumePrompt("Blau") },
  ]);
  expect(delivered).toEqual(["Dann Blau."]);
  expect((await decideChoice(choice.id, "o0", "web")).status).toBe("already");
  expect(realAnswersToQ1()).toHaveLength(1);
  expect([...tasks.rows.values()][0]).toMatchObject({ status: "completed", result: "Dann Blau." });
}

describe("Gewöhnliche Konsultation ([INVOKE:]) ohne noTelegram auf dem Motor api", () => {

  test("WebUI: offene Rückfrage des befragten Agenten bleibt offen, die Antwort geht trotzdem nach Telegram", async () => {
    const { choice, asked } = await researchAsks();
    const sessionFile = join(fake.sessionDir, `${parseSessionRef(asked)!.id}.json`);
    const before = readFileSync(sessionFile, "utf8");

    const { answers } = await thinkWithConsult([textReply("Research meint: Grün.")], false);
    expect(answers).toEqual(["Research meint: Grün."]);
    expect(telegramSent).toContain("Research meint: Grün.");
    await expectStillOpenThenAnswerOnce(choice, asked, sessionFile, before);
  });

  test("Telegram: offene Rückfrage des befragten Agenten bleibt offen und ist danach genau einmal beantwortbar", async () => {
    const { choice, asked } = await researchAsks();
    const sessionFile = join(fake.sessionDir, `${parseSessionRef(asked)!.id}.json`);
    const before = readFileSync(sessionFile, "utf8");

    fake.respond(textReply("Research meint: Grün."));
    expect(await telegramConsult()).toBe("Research meint: Grün.");
    expect(telegramSent).toContain("Research meint: Grün.");
    await expectStillOpenThenAnswerOnce(choice, asked, sessionFile, before);
  });

  test("WebUI: ask_user nicht angeboten, ein Aufruf trotzdem hinterlässt keine Pause ohne Rückfrage im Register", async () => {
    const { answers } = await thinkWithConsult(
      [toolReply([{ id: "q9", name: "ask_user", input: { question: "Welche Farbe?" } }]), textReply("Ohne Rückfrage: Grün.")],
      false
    );
    expect(answers).toEqual(["Ohne Rückfrage: Grün."]);
    expect(consultBody().tools.map((t: any) => t.name)).not.toContain("ask_user");
    expect(fake.lastBody().messages.at(-1).content).toEqual([
      { type: "tool_result", tool_use_id: "q9", content: expect.stringContaining("keine Rückfragen"), is_error: true },
    ]);
    expect(shown).toEqual([]);
    expect(tasks.rows.size).toBe(0);
    const stored = (await getSessionsForKey(KEY)).find((s) => s.agentName === "research");
    expect(stored).toBeDefined();
    expect(parseSessionRef(stored!.engineSessionId)?.mark).toBeUndefined();
    expect(telegramSent).toContain("Ohne Rückfrage: Grün.");
  });

  test("Telegram: ask_user nicht angeboten, ein Aufruf trotzdem hinterlässt keine Pause ohne Rückfrage im Register", async () => {
    fake.respond(toolReply([{ id: "q9", name: "ask_user", input: { question: "Welche Farbe?" } }]));
    fake.respond(textReply("Ohne Rückfrage: Grün."));
    expect(await telegramConsult()).toBe("Ohne Rückfrage: Grün.");
    expect(consultBody().tools.map((t: any) => t.name)).not.toContain("ask_user");
    expect(fake.lastBody().messages.at(-1).content).toEqual([
      { type: "tool_result", tool_use_id: "q9", content: expect.stringContaining("keine Rückfragen"), is_error: true },
    ]);
    expect(shown).toEqual([]);
    expect(tasks.rows.size).toBe(0);
    const stored = (await getSessionsForKey(KEY)).find((s) => s.agentName === "research");
    expect(stored).toBeDefined();
    expect(parseSessionRef(stored!.engineSessionId)?.mark).toBeUndefined();
  });
});

/** Auftrag aus einem Anruf (createCallTaskTurn), callClaude wie in src/bot.ts: turns.ask mit vier Angaben, ohne Zusatz */
async function phoneTask(task: string): Promise<void> {
  const deps = turnDeps();
  const turns = botTurns(deps);
  const run = createCallTaskTurn({
    runStreamingTurn: (o) => runStreamingTurn({ ...o, deps }),
    callClaude: (prompt, chatId, agent, topicId) => turns.ask(prompt, chatId, agent, topicId),
    saveMessage: async () => true,
    processIntents: async () => {},
    onAgentTurn: () => {},
    registry: {
      sendAsAgent: async (_agent, _chat, text) => void telegramSent.push(text),
      sendTypingAsAgent: async () => {},
      sendWithKeyboardAsAgent: async (_agent, _chat, text) => void telegramSent.push(text),
    },
    createTask: async () => null,
    updateTask: async () => true,
    notice: async (_chat, text) => void telegramSent.push(text),
    isShuttingDown: () => false,
    invokeBudget: 3,
    recentMessages: async () => [],
    log: () => {},
  });
  await run(GROUP, task, TOPIC);
}

describe("Auftrag aus einem Anruf auf dem Motor api (Prüfung Runde 5)", () => {
  test("Konsultation ([INVOKE:]) aus dem Anruf: offene Rückfrage des befragten Agenten bleibt offen, danach genau einmal beantwortbar", async () => {
    const { choice, asked } = await researchAsks();
    const sessionFile = join(fake.sessionDir, `${parseSessionRef(asked)!.id}.json`);
    const before = readFileSync(sessionFile, "utf8");

    fake.respond(textReply("Ich frage Research. [INVOKE:research|Welche Farbe passt?]"));
    fake.respond(textReply("Research meint: Grün."));
    await phoneTask("Anruf: Streichen planen");
    // Zustellung nach Telegram bleibt
    expect(telegramSent).toContain("Research meint: Grün.");
    await expectStillOpenThenAnswerOnce(choice, asked, sessionFile, before);
  });

  test("Konsultation aus dem Anruf: ask_user nicht angeboten, ein Aufruf trotzdem hinterlässt keine Pause ohne Rückfrage", async () => {
    fake.respond(textReply("Ich frage Research. [INVOKE:research|Welche Farbe passt?]"));
    fake.respond(toolReply([{ id: "q9", name: "ask_user", input: { question: "Welche Farbe?" } }]));
    fake.respond(textReply("Ohne Rückfrage: Grün."));
    await phoneTask("Anruf: Streichen planen");
    expect(consultBody().tools.map((t: any) => t.name)).not.toContain("ask_user");
    expect(fake.lastBody().messages.at(-1).content).toEqual([
      { type: "tool_result", tool_use_id: "q9", content: expect.stringContaining("keine Rückfragen"), is_error: true },
    ]);
    expect(telegramSent).toContain("Ohne Rückfrage: Grün.");
    expect(shown).toEqual([]);
    expect(tasks.rows.size).toBe(0);
    const stored = (await getSessionsForKey(KEY)).find((s) => s.agentName === "research");
    expect(parseSessionRef(stored!.engineSessionId)?.mark).toBeUndefined();
  });

  test("der Anruf-Auftrag selbst beantwortet keine offene Rückfrage seines Agenten und bekommt kein ask_user", async () => {
    const { choice, asked } = await researchAsks("general");
    const sessionFile = join(fake.sessionDir, `${parseSessionRef(asked)!.id}.json`);
    const before = readFileSync(sessionFile, "utf8");

    fake.respond(textReply("Erledigt."));
    await phoneTask("Anruf: Fenster putzen");
    expect(telegramSent).toContain("Erledigt.");
    await expectStillOpenThenAnswerOnce(choice, asked, sessionFile, before, "Anruf: Fenster putzen", "general");
  });
});

describe("Klasse: Turn ohne Rückfragen-Weg (kein onQuestion) auf dem Motor api", () => {
  /** Turn des Chat-Kerns wie ein Befehl oder der WhatsApp-Besitzer: ohne onQuestion, ohne noTelegram */
  const plainTurn = (text: string) =>
    runExecution(KEY, "research", () =>
      runJsonTurn({ userMessage: text, chatId: GROUP, topicId: TOPIC, agentName: "research", engine: "api", sink: { progress: () => {}, notice: () => {} }, deps: turnDeps() })
    );

  test("offene Rückfrage bleibt offen und ist danach genau einmal beantwortbar", async () => {
    const { choice, asked } = await researchAsks();
    const sessionFile = join(fake.sessionDir, `${parseSessionRef(asked)!.id}.json`);
    const before = readFileSync(sessionFile, "utf8");

    fake.respond(textReply("Zusammenfassung: Zimmer streichen."));
    expect(await plainTurn("Fasse das Gespräch zusammen")).toBe("Zusammenfassung: Zimmer streichen.");
    await expectStillOpenThenAnswerOnce(choice, asked, sessionFile, before, "Fasse das Gespräch zusammen");
  });

  test("ask_user nicht angeboten, ein Aufruf trotzdem ergibt ein Fehlerergebnis ohne Pause", async () => {
    fake.respond(toolReply([{ id: "q9", name: "ask_user", input: { question: "Welche Farbe?" } }]));
    fake.respond(textReply("Grün."));
    expect(await plainTurn("Welche Farbe?")).toBe("Grün.");
    expect(fake.bodies()[0].tools.map((t: any) => t.name)).not.toContain("ask_user");
    expect(fake.lastBody().messages.at(-1).content).toEqual([
      { type: "tool_result", tool_use_id: "q9", content: expect.stringContaining("keine Rückfragen"), is_error: true },
    ]);
    expect(shown).toEqual([]);
    const stored = (await getSessionsForKey(KEY)).find((s) => s.agentName === "research");
    expect(parseSessionRef(stored!.engineSessionId)?.mark).toBeUndefined();
  });
});
