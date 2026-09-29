import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  getResumableSession,
  getSessionsForKey,
  recordSessionTurn,
  setSessionsFileForTests,
  type BotSession,
} from "../src/lib/session-manager";
import {
  distillSession,
  setPendingReviewsFileForTests,
  setReviewNotifier,
  stagePendingReview,
  takePendingReview,
} from "../src/lib/session-distill";
import { createRoutineFromSession } from "../src/lib/session-routine";
import { resumeMacTask, taskEngine, type TaskResumeDeps } from "../src/lib/task-resume";
import { runExecution } from "../src/lib/execution-context";
import { setEngineForTests, type Engine, type EngineId, type EngineRequest, type EngineResult } from "../src/lib/engines";
import { turnInfoCollector } from "../src/lib/turn-collector";
import { runJsonTurn, type ChatTurnDeps } from "../src/lib/chat-turn";
import { sessionKeyFor } from "../src/lib/supabase";
import type { ProcessedIntents } from "../src/lib/memory";

// Issue #122: Destillat, /routine und die Fortsetzung nach einem
// Rückfrage-Knopf laufen über den Motor der Session. Motoren sind Attrappen
// (setEngineForTests), die Session-Ablage ist echt (Temp-Datei).

const CHAT = "-100123";
const EMPTY: ProcessedIntents = { factsAdded: [], goalsAdded: [], goalsCompleted: [], goalsCancelled: [], factsForgotten: [] } as unknown as ProcessedIntents;

interface Call extends EngineRequest {
  engine: EngineId;
}

let dir: string;
let calls: Call[];

/** Attrappe eines Motors; reply liefert Text und neue Session-ID */
function fakeEngine(id: EngineId, reply: (req: EngineRequest) => Partial<EngineResult> = () => ({})): Engine {
  return {
    id,
    describe: () => `Attrappe ${id}`,
    async run(req) {
      calls.push({ ...req, engine: id });
      return { engine: id, text: "antwort", isError: false, ...reply(req) };
    },
  };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tybo-122-resume-"));
  setSessionsFileForTests(join(dir, "sessions.json"));
  setPendingReviewsFileForTests(join(dir, "pending-reviews.json"));
  setReviewNotifier(null);
  calls = [];
  // Kein echter Motor: Claude und Codex sind Attrappen, OpenCode gilt als nicht verfügbar
  setEngineForTests();
  setEngineForTests("claude", fakeEngine("claude"));
  setEngineForTests("codex", fakeEngine("codex"));
  setEngineForTests("opencode", "unavailable");
});

afterEach(async () => {
  setEngineForTests();
  setSessionsFileForTests(null);
  setPendingReviewsFileForTests(null);
  delete process.env.DISTILL_AUTO_APPLY;
  await rm(dir, { recursive: true, force: true });
});

function session(engine: EngineId, id: string, extra: Partial<BotSession> = {}): BotSession {
  return {
    key: `dm:${CHAT}:general`,
    agentName: "general",
    engine,
    engineSessionId: id,
    model: `${engine}-modell`,
    startedAt: 1,
    lastActivity: Date.now(),
    messageCount: 9,
    ...extra,
  };
}

describe("Destillat über den Motor der Session", () => {
  test("Codex-Session: Codex-Motor mit deren Session-ID und Modell, kein Aux-Aufruf", async () => {
    setEngineForTests("codex", fakeEngine("codex", () => ({ text: "[REMEMBER: Codex merkt sich das]" })));
    process.env.DISTILL_AUTO_APPLY = "true";
    const aux: unknown[] = [];
    const written: string[] = [];
    await distillSession(session("codex", "C-1"), {
      callAux: async (...args) => (aux.push(args), { text: "", isError: true }),
      processIntents: async (t) => (written.push(t), EMPTY),
    });
    expect(aux).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ engine: "codex", resumeSessionId: "C-1", model: "codex-modell", streaming: false, timeoutMs: 300_000 });
    expect(calls[0]!.prompt).toContain("[REMEMBER:");
    expect(written).toEqual(["[REMEMBER: Codex merkt sich das]"]);
  });

  test("Claude-Session: wie bisher über das Aux-Modell distill mit Resume, kein anderer Motor", async () => {
    process.env.DISTILL_AUTO_APPLY = "true";
    const aux: unknown[][] = [];
    await distillSession(session("claude", "S-1"), {
      callAux: async (...args) => (aux.push(args), { text: "NONE", isError: false }),
      processIntents: async () => EMPTY,
    });
    expect(calls).toEqual([]);
    expect(aux).toHaveLength(1);
    expect(aux[0]![0]).toBe("distill");
    expect(aux[0]![2]).toEqual({ resumeSessionId: "S-1", timeoutMs: 300_000 });
  });

  test("Motor nicht verfügbar: kein Destillat, nie an Claude, kein Fehler nach außen", async () => {
    process.env.DISTILL_AUTO_APPLY = "true";
    const aux: unknown[] = [];
    const written: string[] = [];
    await distillSession(session("opencode", "O-1"), {
      callAux: async (...args) => (aux.push(args), { text: "[REMEMBER: falsch]", isError: false }),
      processIntents: async (t) => (written.push(t), EMPTY),
    });
    expect(aux).toEqual([]);
    expect(calls).toEqual([]);
    expect(written).toEqual([]);
  });
});

describe("/routine über den Motor der Session", () => {
  test("Codex-Session: Codex mit gespeichertem Modell, neue Session bleibt beim Codex-Motor", async () => {
    setEngineForTests("codex", fakeEngine("codex", () => ({ text: "Routine erstellt", sessionId: "C-2" })));
    const key = sessionKeyFor(CHAT, 31);
    await recordSessionTurn(key, "general", "codex-modell", "codex", "C-1");
    const s = (await getSessionsForKey(key))[0]!;
    const result = await createRoutineFromSession(s, "jeden Montag", { log: async () => {} });
    expect(result).toMatchObject({ text: "Routine erstellt", sessionId: "C-2", isError: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ engine: "codex", resumeSessionId: "C-1", model: "codex-modell", streaming: false });
    expect(calls[0]!.prompt).toContain("jeden Montag");
    expect(await getResumableSession(key, "general", "codex-modell", "codex")).toMatchObject({ engine: "codex", engineSessionId: "C-2" });
    expect(await getResumableSession(key, "general", "codex-modell", "claude")).toBeUndefined();
  });

  test("Snapshot im alten Format (claudeSessionId) läuft über Claude mit dem Modell der Session", async () => {
    const key = sessionKeyFor(CHAT, 32);
    const legacy = { key: `${key}:general`, agentName: "general", claudeSessionId: "S-alt", model: "claude-modell", startedAt: 1, lastActivity: 1, messageCount: 9 };
    await createRoutineFromSession(legacy as never, "", { log: async () => {} });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ engine: "claude", resumeSessionId: "S-alt", model: "claude-modell" });
  });

  test("Motor nicht verfügbar: Fehler statt Claude", async () => {
    const result = await createRoutineFromSession(session("opencode", "O-1"), "", { log: async () => {} });
    expect(result.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("Session-Snapshots in pending-reviews.json", () => {
  test("alter Routine-Vorschlag mit claudeSessionId kommt als Claude-Session heraus", async () => {
    const file = join(dir, "pending-reviews.json");
    await writeFile(
      file,
      JSON.stringify({
        r1: {
          id: "r1",
          type: "routine",
          chatId: CHAT,
          routineDescription: "Wochenbericht",
          session: { key: `dm:${CHAT}:general`, agentName: "general", claudeSessionId: "S-snap", model: "m", startedAt: 1, lastActivity: 1, messageCount: 9 },
          createdAt: Date.now(),
        },
      })
    );
    const review = await takePendingReview("r1");
    expect(review?.session).toMatchObject({ engine: "claude", engineSessionId: "S-snap" });
    expect(review?.session).not.toHaveProperty("claudeSessionId");
  });

  test("neuer Vorschlag speichert den Motor der Session mit", async () => {
    await stagePendingReview({ id: "r2", type: "routine", chatId: CHAT, routineDescription: "x", session: session("codex", "C-5"), createdAt: Date.now() });
    const onDisk = JSON.parse(await readFile(join(dir, "pending-reviews.json"), "utf8"));
    expect(onDisk.r2.session).toMatchObject({ engine: "codex", engineSessionId: "C-5" });
    expect((await takePendingReview("r2"))?.session).toMatchObject({ engine: "codex", engineSessionId: "C-5" });
  });
});

describe("Rückfrage-Knopf über den Motor der Rückfrage", () => {
  const finalized: unknown[][] = [];
  const deps = (): Partial<TaskResumeDeps> => ({
    runExecution,
    isSessionModeEnabled: () => true,
    finalizeClaudeSession: async (...args) => (finalized.push(args), true),
    resolveModel: () => "claude-modell",
    resolveEffort: () => undefined,
    allowedTools: () => undefined,
    cwd: "/tmp/projekt",
  });
  beforeEach(() => {
    finalized.length = 0;
  });

  test("Codex-Rückfrage mit gespeichertem Modell: Codex setzt ihre Session fort", async () => {
    setEngineForTests("codex", fakeEngine("codex", (req) => ({ text: "erledigt", sessionId: req.resumeSessionId })));
    const task = { chat_id: CHAT, thread_id: 41, session_id: "C-frage", metadata: { agent_name: "general", engine: "codex", model: "codex-modell" } };
    const outcome = await resumeMacTask(task, CHAT, "Ja", deps());
    expect(outcome).toMatchObject({ status: "done", resumeId: "C-frage", engine: "codex", model: "codex-modell" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ engine: "codex", resumeSessionId: "C-frage", model: "codex-modell", prompt: "User responded: Ja", streaming: false });
  });

  test("nach einem Motorwechsel im Topic: Rückfrage bleibt bei Codex, Topic-Session (Claude) unberührt", async () => {
    const key = sessionKeyFor(CHAT, 42);
    // Das Topic läuft inzwischen mit Claude, gleicher Agent und gleiches Modell
    await recordSessionTurn(key, "general", "codex-modell", "claude", "S-topic");
    const task = { chat_id: CHAT, thread_id: 42, session_id: "C-frage", metadata: { agent_name: "general", engine: "codex", model: "codex-modell" } };
    const outcome = await resumeMacTask(task, CHAT, "B", deps());
    expect(outcome).toMatchObject({ status: "done", engine: "codex" });
    expect(calls.map((c) => [c.engine, c.resumeSessionId])).toEqual([["codex", "C-frage"]]);
    // Kein Turn der Claude-Session, deren Zeiger bleibt
    expect(finalized).toEqual([]);
    expect(await getResumableSession(key, "general", "codex-modell", "claude")).toMatchObject({ engineSessionId: "S-topic", messageCount: 1 });
  });

  test("Codex-Rückfrage ohne eigene ID nimmt die Codex-Topic-Session und zählt sie als Turn", async () => {
    const key = sessionKeyFor(CHAT, 43);
    await recordSessionTurn(key, "general", "codex-modell", "codex", "C-topic");
    const task = { chat_id: CHAT, thread_id: 43, metadata: { agent_name: "general", engine: "codex", model: "codex-modell" } };
    const outcome = await resumeMacTask(task, CHAT, "Ja", deps());
    expect(outcome).toMatchObject({ status: "done", resumeId: "C-topic", engine: "codex" });
    expect(finalized).toHaveLength(1);
    expect(finalized[0]![0]).toBe(key);
    expect(finalized[0]![2]).toMatchObject({ engine: "codex" });
    expect(finalized[0]![4]).toBe("codex-modell");
  });

  test("Topic hat nur eine Claude-Session: Codex-Rückfrage ohne ID bekommt keine fremde ID", async () => {
    const key = sessionKeyFor(CHAT, 44);
    await recordSessionTurn(key, "general", "codex-modell", "claude", "S-topic");
    const task = { chat_id: CHAT, thread_id: 44, metadata: { agent_name: "general", engine: "codex", model: "codex-modell" } };
    expect(await resumeMacTask(task, CHAT, "Ja", deps())).toEqual({ status: "no-session" });
    expect(calls).toEqual([]);
  });

  test("alte Rückfrage ohne Motor: Claude mit dem Modell des Agenten", async () => {
    const task = { chat_id: CHAT, thread_id: 45, session_id: "S-alt", metadata: { agent_name: "general" } };
    const outcome = await resumeMacTask(task, CHAT, "Ja", deps());
    expect(outcome).toMatchObject({ status: "done", engine: "claude", model: "claude-modell" });
    expect(calls[0]).toMatchObject({ engine: "claude", resumeSessionId: "S-alt", model: "claude-modell" });
  });

  test("Codex-Rückfrage ohne gespeichertes Modell: kein Claude-Modell, Standard der Codex-Konfiguration (Issue #125)", async () => {
    const key = sessionKeyFor(CHAT, 47);
    // Codex-Session unter "" (Standard des Motors)
    await recordSessionTurn(key, "general", "", "codex", "C-std");
    const task = { chat_id: CHAT, thread_id: 47, metadata: { agent_name: "general", engine: "codex" } };
    const outcome = await resumeMacTask(task, CHAT, "Ja", {
      ...deps(),
      resolveModel: (_agent, engine) => (engine === "claude" ? "claude-modell" : undefined),
      resolveEffort: (_agent, engine) => (engine === "claude" ? "high" : undefined),
    });
    // "" wird am Folge-Task gespeichert: bewusst Standard, nicht fehlend
    expect(outcome).toMatchObject({ status: "done", resumeId: "C-std", engine: "codex", model: "" });
    expect("model" in calls[0]!).toBe(false);
    expect("effort" in calls[0]!).toBe(false);
    expect(finalized[0]![4]).toBe("");
  });

  // Codex-Modell inzwischen gesetzt; der Task entstand ohne Modell (model: "")
  const codexModelSetLater = (): Partial<TaskResumeDeps> => ({
    ...deps(),
    resolveModel: (_agent, engine) => (engine === "codex" ? "codex-neu" : "claude-modell"),
  });

  test("modelllose Codex-Rückfrage mit eigener Session-ID bekommt ein später gesetztes engine.codex.model nicht", async () => {
    setEngineForTests("codex", fakeEngine("codex", (req) => ({ text: "erledigt", sessionId: req.resumeSessionId })));
    const task = { chat_id: CHAT, thread_id: 48, session_id: "C-frage", metadata: { agent_name: "general", engine: "codex", model: "" } };
    const outcome = await resumeMacTask(task, CHAT, "Ja", codexModelSetLater());
    expect(outcome).toMatchObject({ status: "done", resumeId: "C-frage", engine: "codex", model: "" });
    expect(calls.map((c) => [c.engine, c.resumeSessionId])).toEqual([["codex", "C-frage"]]);
    expect("model" in calls[0]!).toBe(false);
  });

  test("modelllose Codex-Rückfrage ohne Session-ID nimmt die Codex-Session unter \"\", nicht die unter dem neuen Modell", async () => {
    const key = sessionKeyFor(CHAT, 49);
    await recordSessionTurn(key, "general", "", "codex", "C-std");
    const task = { chat_id: CHAT, thread_id: 49, metadata: { agent_name: "general", engine: "codex", model: "" } };
    const outcome = await resumeMacTask(task, CHAT, "Ja", codexModelSetLater());
    expect(outcome).toMatchObject({ status: "done", resumeId: "C-std", engine: "codex", model: "" });
    expect("model" in calls[0]!).toBe(false);
    expect(finalized).toHaveLength(1);
    expect(finalized[0]![4]).toBe("");
  });

  test("alte Codex-Rückfrage ganz ohne Modellangabe nimmt das jetzige engine.codex.model", async () => {
    setEngineForTests("codex", fakeEngine("codex", (req) => ({ text: "erledigt", sessionId: req.resumeSessionId })));
    const task = { chat_id: CHAT, thread_id: 50, session_id: "C-alt", metadata: { agent_name: "general", engine: "codex" } };
    const outcome = await resumeMacTask(task, CHAT, "Ja", codexModelSetLater());
    expect(outcome).toMatchObject({ status: "done", engine: "codex", model: "codex-neu" });
    expect(calls[0]).toMatchObject({ engine: "codex", model: "codex-neu" });
  });

  test("Motor der Rückfrage nicht verfügbar: Fehler, nie an Claude", async () => {
    const task = { chat_id: CHAT, thread_id: 46, session_id: "O-1", metadata: { agent_name: "general", engine: "opencode", model: "m" } };
    await expect(resumeMacTask(task, CHAT, "Ja", deps())).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  test("taskEngine: ohne Angabe Claude, sonst gespeicherter Motor und Modell", () => {
    expect(taskEngine({})).toEqual({ engine: "claude" });
    expect(taskEngine({ metadata: { agent_name: "x" } })).toEqual({ engine: "claude" });
    expect(taskEngine({ metadata: { engine: "codex", model: "gpt" } })).toEqual({ engine: "codex", model: "gpt" });
    // "" ist bewusst Standard des Motors, fehlend ist etwas anderes
    expect(taskEngine({ metadata: { engine: "codex", model: "" } })).toEqual({ engine: "codex", model: "" });
    expect(taskEngine({ metadata: { engine: "codex" } })).toEqual({ engine: "codex" });
  });
});

describe("Motor und Modell am Rückfrage-Task", () => {
  test("turnInfoCollector merkt sich Motor und Modell zur Session-ID", () => {
    const t = turnInfoCollector();
    expect(t.sessionMeta()).toBeUndefined();
    t.onSessionId("C-1", { engine: "codex", model: "gpt" });
    expect(t.sessionId()).toBe("C-1");
    expect(t.sessionMeta()).toEqual({ engine: "codex", model: "gpt" });
  });

  test("src/bot.ts speichert Motor und Modell am Task, auch bei Folgefragen (als Text geprüft)", async () => {
    const bot = await readFile(resolve("src/bot.ts"), "utf8");
    expect(bot).toContain("metadata: turn.taskMetadata(agentName),");
    expect(bot).toContain("turn.onSessionId, turn.onSessionMeta)");
    expect(bot).toContain("metadata: { ...(task.metadata ?? {}), engine: outcome.engine, model: outcome.model },");
    // Die letzte Session merkt sich auch den Motor (nur Anzeige)
    expect(bot).toContain("await rememberLastSessionId(id, meta.engine);");
    expect(bot).not.toContain("MODEL_IDS.opus, resumeSessionId");
  });
});

describe("Rückfrage ohne Session-ID: vom Turn bis zur Knopf-Antwort", () => {
  test("Codex-Topic-Session fortgesetzt, Attrappe liefert keine sessionId: Task trägt Codex, Knopf setzt die Codex-Session fort", async () => {
    const key = sessionKeyFor(CHAT, 51);
    // Das Topic hat eine laufende Codex-Session
    await recordSessionTurn(key, "general", "codex-modell", "codex", "C-topic");
    // Rückfrage mit Knöpfen, aber ohne Session-ID
    setEngineForTests("codex", fakeEngine("codex", () => ({ text: "Welche Option? [A] [B]", sessionId: undefined })));

    const turn = turnInfoCollector();
    const turnDeps: Partial<ChatTurnDeps> = {
      isSessionModeEnabled: () => true,
      buildPromptContext: async () => ({ fullPrompt: "voll", fallbackContext: "" }),
      buildResumePrompt: async () => "weiter",
      callFallbackLLMWithSource: async () => {
        throw new Error("Fallback aufgerufen");
      },
      shouldDistill: () => false,
      distillSession: async () => {},
      log: async () => {},
      // Seit Issue #125 gilt das Agenten-Modell nur für Claude; Codex nimmt engine.codex.model
      getAgentConfig: () => ({ model: "claude-agent-modell" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
      getSettings: () => ({ engine: { codex: { model: "codex-modell" } } }) as ReturnType<ChatTurnDeps["getSettings"]>,
      reportSecrets: () => [],
    };
    const reply = await runJsonTurn({
      userMessage: "Was jetzt?",
      chatId: CHAT,
      agentName: "general",
      topicId: 51,
      engine: "codex",
      sink: { progress() {}, notice() {}, start() {}, finish() {} },
      onSessionId: turn.onSessionId,
      onSessionMeta: turn.onSessionMeta,
      onInfo: turn.onInfo,
      onTools: turn.onTools,
      deps: turnDeps,
    });
    expect(reply).toContain("Welche Option?");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ engine: "codex", resumeSessionId: "C-topic" });

    // Task wie in src/bot.ts: Session-ID des Turns (keine) und dessen Metadaten
    expect(turn.sessionId()).toBeUndefined();
    const task = { chat_id: CHAT, thread_id: 51, session_id: turn.sessionId(), metadata: turn.taskMetadata("general") };
    expect(task.metadata).toEqual({ agent_name: "general", engine: "codex", model: "codex-modell" });

    setEngineForTests("codex", fakeEngine("codex", (req) => ({ text: "erledigt", sessionId: req.resumeSessionId })));
    const finalized: unknown[][] = [];
    const outcome = await resumeMacTask(task, CHAT, "A", {
      runExecution,
      isSessionModeEnabled: () => true,
      finalizeClaudeSession: async (...args) => (finalized.push(args), true),
      // Das jetzige Modell des Agenten wäre ein anderes: es zählt das des Tasks
      resolveModel: () => "claude-modell",
      resolveEffort: () => undefined,
      allowedTools: () => undefined,
      cwd: "/tmp/projekt",
    });
    expect(outcome).toMatchObject({ status: "done", resumeId: "C-topic", engine: "codex", model: "codex-modell" });
    expect(calls.map((c) => [c.engine, c.resumeSessionId])).toEqual([
      ["codex", "C-topic"],
      ["codex", "C-topic"],
    ]);
    expect(finalized).toHaveLength(1);
    expect(finalized[0]![2]).toMatchObject({ engine: "codex" });
  });

  test("abgebrochener Turn meldet weder Session noch Motor", async () => {
    setEngineForTests("codex", fakeEngine("codex", () => ({ text: "", aborted: true })));
    const turn = turnInfoCollector();
    await runJsonTurn({
      userMessage: "x",
      chatId: CHAT,
      agentName: "general",
      topicId: 52,
      engine: "codex",
      sink: { progress() {}, notice() {}, start() {}, finish() {} },
      onSessionMeta: turn.onSessionMeta,
      deps: {
        isSessionModeEnabled: () => false,
        buildPromptContext: async () => ({ fullPrompt: "voll", fallbackContext: "" }),
        log: async () => {},
        getAgentConfig: () => ({ model: "codex-modell" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
        getSettings: () => ({}) as ReturnType<ChatTurnDeps["getSettings"]>,
      },
    });
    expect(turn.sessionMeta()).toBeUndefined();
    expect(turn.taskMetadata("general")).toEqual({ agent_name: "general" });
  });
});
