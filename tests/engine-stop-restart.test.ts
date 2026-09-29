/**
 * Issue #121: /stop, Neustart und Shutdown laufen über die allgemeinen
 * Motor-Funktionen (abortEngineCalls, activeEngineCallCount,
 * abortAllEngineCalls). Der Claude-Prozess ist eine Attrappe, die hängt, bis
 * sie beendet wird (setSpawnForTests); die Prozessbeendigung ebenfalls
 * (setRuntimeForTests), die Attrappe hat pid 0. src/bot.ts wird nie
 * importiert: Befehls-Schicht und createRestartControl sind so verdrahtet wie
 * dort.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { callClaude, setRuntimeForTests, setSpawnForTests } from "../src/lib/claude";
import { abortAllEngineCalls, abortEngineCalls, activeEngineCallCount } from "../src/lib/engines";
import { activeExecutionCount, closeIntake, isIntakeClosed, runExecution } from "../src/lib/execution-context";
import { runningGoalLoopCount } from "../src/lib/goal-engine";
import { createRestartControl } from "../src/lib/restart-control";
import type { Supervisor } from "../src/lib/restart-request";
import { commandRegistry } from "../src/lib/commands/builtin";
import { runTelegramCommand } from "../src/lib/commands/telegram";
import type { CommandServices } from "../src/lib/commands/types";
import { ABORT_REPLY, resolveStreamingLimits, runStreamingTurn, type ChatTurnDeps } from "../src/lib/chat-turn";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";

let terminated = 0;
const closers = new Map<object, () => void>();

/** Prozessattrappe: meldet ihre Session und hängt, bis terminate den stdout schließt */
function hangingSpawn() {
  const enc = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  controller.enqueue(enc.encode(JSON.stringify({ type: "system", subtype: "init", session_id: "s-lauf" }) + "\n"));
  let closed = false;
  const proc = {
    pid: 0,
    stdin: { write() {}, end() {} },
    stdout,
    stderr: new ReadableStream({ start: (c) => c.close() }),
    exited: Promise.resolve(0),
    kill() {},
  };
  closers.set(proc, () => {
    if (closed) return;
    closed = true;
    controller.close();
  });
  return proc;
}

beforeAll(() => setMcpReaderForTests(() => new Set()));
afterAll(() => setMcpReaderForTests(null));
beforeEach(() => {
  terminated = 0;
  closers.clear();
  setSpawnForTests(hangingSpawn as any);
  setRuntimeForTests({
    terminate: (proc) => {
      terminated++;
      closers.get(proc)?.();
    },
  });
});
afterEach(() => {
  abortAllEngineCalls();
  setSpawnForTests(null);
  setRuntimeForTests(null);
});

async function until(cond: () => boolean): Promise<void> {
  const end = Date.now() + 2000;
  while (!cond()) {
    if (Date.now() > end) throw new Error("Bedingung nicht erreicht");
    await new Promise((r) => setTimeout(r, 1));
  }
}

const CHAT = "-1001";
const TOPIC = 4;
const KEY = `topic:${CHAT}:${TOPIC}`;

/** Streaming-Turn im Topic über den echten Motor (getEngine bleibt echt) */
function startTurn(): Promise<string> {
  const deps: Partial<ChatTurnDeps> = {
    callFallbackLLMWithSource: async () => {
      throw new Error("Fallback unerwartet");
    },
    buildPromptContext: async () => ({ fullPrompt: "prompt", fallbackContext: "" }),
    buildResumePrompt: async () => "resume",
    isSessionModeEnabled: () => false,
    shouldDistill: () => false,
    distillSession: async () => {},
    log: async () => {},
    getAgentConfig: () => ({ model: "claude-test" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
    getSettings: () => ({}),
    resolveStreamingLimits: () => resolveStreamingLimits({}),
    reportSecrets: () => [],
  };
  return runExecution(KEY, "general", () =>
    runStreamingTurn({ userMessage: "Plane", chatId: CHAT, topicId: TOPIC, agentName: "general", sink: { progress() {}, notice() {} }, deps })
  );
}

/** /stop über die Befehls-Schicht, abortEngineCalls echt wie in src/bot.ts */
async function stop(): Promise<string[]> {
  const sent: string[] = [];
  const match = commandRegistry.match("/stop", "telegram");
  if (!match) throw new Error("kein Befehl");
  const services = {
    getGoal: async () => undefined,
    pauseGoal: async () => {},
    abortEngineCalls,
  } as Partial<CommandServices> as CommandServices;
  await runTelegramCommand({
    chat: { async reply(t) { sent.push(t); } },
    chatId: CHAT,
    topicId: TOPIC,
    sessionKey: KEY,
    agent: "general",
    text: "/stop",
    match,
    services,
    working: () => () => {},
    resetSession: async () => ({ status: "done", reset: 0, sessionMode: false }),
    agentTurn: async () => {},
    boardMeeting: async () => {},
  });
  return sent;
}

describe("/stop über abortEngineCalls", () => {
  test("beendet den laufenden Motor-Aufruf des Topics, Antwort Abgebrochen", async () => {
    const reply = startTurn();
    await until(() => activeEngineCallCount() === 1);
    expect(await stop()).toEqual(["⏹️ 1 laufende Verarbeitung abgebrochen."]);
    expect(await reply).toBe(ABORT_REPLY);
    // Beendet wird über das Abbruch-Signal der Ausführung und über das
    // Register (wie vorher bei abortClaudeCalls), gezählt wird einmal
    expect(terminated).toBeGreaterThanOrEqual(1);
    expect(activeEngineCallCount()).toBe(0);
  });

  test("anderes Topic bleibt unberührt", async () => {
    const other = callClaude({ prompt: "x", abortKey: "topic:-1001:9" });
    await until(() => activeEngineCallCount() === 1);
    expect(await stop()).toEqual(["Hier laeuft gerade nichts, das ich abbrechen koennte."]);
    expect(activeEngineCallCount()).toBe(1);
    expect(abortEngineCalls("topic:-1001:9")).toBe(1);
    expect(await other).toMatchObject({ aborted: true });
  });
});

describe("Neustart wartet auf activeEngineCallCount() === 0", () => {
  const reopen: (() => void)[] = [];
  afterEach(() => {
    for (const r of reopen.splice(0)) r();
    expect(isIntakeClosed()).toBe(false);
  });

  /** Wie in src/bot.ts: Motor-Aufrufe, Ausführungen und Ziel-Schleifen */
  function control(events: string[]) {
    let marker: string | null = "neuer Code";
    return createRestartControl({
      readRequest: async () => marker,
      clearRequest: async () => void (marker = null),
      busyCount: () => activeEngineCallCount() + activeExecutionCount() + runningGoalLoopCount(),
      detectSupervisor: async () => "launchd" as Supervisor,
      closeIntake: () => {
        const r = closeIntake();
        reopen.push(r);
        return r;
      },
      send: async () => {},
      shutdown: async (reason) => void events.push(`shutdown ${reason}`),
      isShuttingDown: () => false,
      log: () => {},
    });
  }

  test("direkter Claude-Aufruf ohne Ausführung (Nebenaufgabe) hält den Neustart auf", async () => {
    const events: string[] = [];
    const rc = control(events);
    const side = callClaude({ prompt: "Nebenaufgabe" });
    await until(() => activeEngineCallCount() === 1);
    expect(activeExecutionCount()).toBe(0);
    expect(await rc.maybeRestart("test")).toBe("busy");
    expect(abortEngineCalls("background")).toBe(1);
    await side;
    expect(activeEngineCallCount()).toBe(0);
    expect(await rc.maybeRestart("test")).toBe("restarting");
    expect(events).toEqual(["shutdown restart-requested"]);
  });

  test("Chat-Turn: erst nach dem Ende des Motor-Aufrufs", async () => {
    const events: string[] = [];
    const rc = control(events);
    const reply = startTurn();
    await until(() => activeEngineCallCount() === 1);
    expect(await rc.maybeRestart("test")).toBe("busy");
    abortEngineCalls(KEY);
    await reply;
    await until(() => activeExecutionCount() === 0);
    expect(await rc.maybeRestart("test")).toBe("restarting");
  });
});

describe("Shutdown über abortAllEngineCalls", () => {
  test("beendet alle Motor-Aufrufe, auch ohne Schlüssel, ohne Doppelzählung", async () => {
    const a = callClaude({ prompt: "a", abortKey: "dm:1" });
    const b = callClaude({ prompt: "b" });
    const turn = startTurn();
    await until(() => activeEngineCallCount() === 3);
    abortAllEngineCalls();
    expect(await a).toMatchObject({ aborted: true });
    expect(await b).toMatchObject({ aborted: true });
    expect(await turn).toBe(ABORT_REPLY);
    expect(activeEngineCallCount()).toBe(0);
    // Ausführung und Prozess werden je einmal beendet, nicht rekursiv mehrfach
    expect(terminated).toBeGreaterThanOrEqual(3);
    expect(terminated).toBeLessThanOrEqual(4);
  });
});
