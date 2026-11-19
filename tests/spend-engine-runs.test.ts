/**
 * Kosten aller Motoren (Issue #346): jeder Motorlauf landet genau einmal in
 * engine_runs (src/lib/spend/engine-runs.ts), gebucht direkt nach dem Lauf
 * in chat-turn, Routine, Knopf-Antwort, Destillat, Aux-Modell und
 * Fallback-Kette. Nur Claude-Läufe zählen in den Abo-Zähler, und nur bei
 * aktiver Messung; das Tagesbudget bleibt unberührt.
 *
 * Codex und OpenCode laufen als echte Motoren mit den Prozess-Attrappen der
 * Vertragstests (tests/codex-fixture.ts, tests/opencode-fixture.ts), Claude
 * mit einer Spawn-Attrappe wie in tests/engine-contract-claude.test.ts.
 * Kein echtes claude, codex oder opencode, keine Netzaufrufe.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callAux } from "../src/lib/aux-model";
import { callClaude, callClaudeStreaming, setRuntimeForTests, setSpawnForTests } from "../src/lib/claude";
import { resolveStreamingLimits, runJsonTurn, runStreamingTurn, type ChatTurnDeps } from "../src/lib/chat-turn";
import { remainingBudget } from "../src/lib/daily-budget";
import { createClaudeEngine, createCodexEngine, createOpenCodeEngine, type Engine, type EngineId, type EngineResult } from "../src/lib/engines";
import { abortAllEngineCalls } from "../src/lib/engines/calls";
import { runFallbackChain } from "../src/lib/fallback/chain";
import { createRoutineFromSession } from "../src/lib/session-routine";
import { distillSession } from "../src/lib/session-distill";
import {
  getResumableSession,
  getSessionsForKey,
  recordSessionTurn,
  resetSession,
  sessionEpoch,
  setSessionsFileForTests,
  takeExpiredSession,
  type BotSession,
} from "../src/lib/session-manager";
import { setSettingsPath } from "../src/lib/settings";
import { bookEngineRun } from "../src/lib/spend/credit";
import { addCycleSpend, readCycle, resetSubscriptionStateForTests } from "../src/lib/spend/subscription";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { sessionKeyFor } from "../src/lib/store/message-rules";
import { resumeMacTask } from "../src/lib/task-resume";
import { runExecution } from "../src/lib/execution-context";
import { ev, installCodexFake, until, type CodexFake } from "./codex-fixture";
import { installOpenCodeFake, oc } from "./opencode-fixture";

const KEYS = [
  "ANTHROPIC_API_KEY",
  "CLAUDE_AUTH",
  "BUDGET_DB_PATH",
  "CREDIT_CEILING_USD",
  "CREDIT_GUARD",
  "CREDIT_RESET_DAY",
  "CREDIT_WARN_PCT",
  "DAILY_API_BUDGET",
  "GO_PROJECT_ROOT",
  "OPENROUTER_API_KEY",
  "FALLBACK_OFFLINE_ONLY",
] as const;
let saved: Record<string, string | undefined> = {};
let dir = "";
let spies: ReturnType<typeof spyOn>[] = [];
const fakes: { restore(): void }[] = [];

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
  for (const key of KEYS) delete process.env[key];
  dir = mkdtempSync(join(tmpdir(), "tybo-346-"));
  process.env.BUDGET_DB_PATH = join(dir, "data", "api-budget.sqlite");
  process.env.GO_PROJECT_ROOT = dir;
  process.env.DAILY_API_BUDGET = "5";
  resetSubscriptionStateForTests();
  setSettingsPath(join(dir, "settings.json"));
  setSessionsFileForTests(join(dir, "sessions.json"));
  setMcpReaderForTests(() => new Set());
  spies = [
    spyOn(console, "log").mockImplementation(() => {}),
    spyOn(console, "error").mockImplementation(() => {}),
    spyOn(console, "warn").mockImplementation(() => {}),
  ];
});

afterEach(() => {
  for (const fake of fakes.splice(0)) fake.restore();
  setSpawnForTests(null);
  setRuntimeForTests(null);
  setMcpReaderForTests(null);
  setSettingsPath();
  setSessionsFileForTests(null);
  for (const spy of spies) spy.mockRestore();
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

interface RunRow {
  engine: string;
  model: string;
  origin: string;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
}

/** Gebuchte Läufe in Reihenfolge; ohne Tabelle keine */
function runs(): RunRow[] {
  if (!existsSync(process.env.BUDGET_DB_PATH!)) return [];
  const file = new Database(process.env.BUDGET_DB_PATH!);
  try {
    const table = file.query("SELECT 1 FROM sqlite_master WHERE name = 'engine_runs'").get();
    if (!table) return [];
    return file
      .query("SELECT engine, model, origin, input_tokens, output_tokens, cost_usd FROM engine_runs ORDER BY id")
      .all() as RunRow[];
  } finally {
    file.close();
  }
}

const cycleSpend = () => readCycle(1)?.cycleSpendUsd ?? 0;
const round = (value: number | null) => (value === null ? null : Math.round(value * 1e6) / 1e6);
const costs = () => runs().map((row) => round(row.cost_usd));

interface ClaudeScript {
  lines: object[];
  /** stdout bleibt offen, bis der Prozess beendet wird */
  hang?: boolean;
  /** stdout bricht nach den Zeilen mit diesem Fehler ab */
  stdoutError?: string;
  /** Übergabe des Prompts scheitert (stdin.end lehnt kurz nach dem Start ab), stdout bleibt bis zum Beenden offen */
  stdinError?: string;
}

/** Spawn-Attrappe der Claude-CLI: stream-json zeilenweise, json als Liste */
function useClaudeFake(scripts: ClaudeScript[]): { spawned: () => number } {
  let spawned = 0;
  const closers = new Map<object, () => void>();
  setSpawnForTests(((options: { cmd: string[] }) => {
    const script = scripts.shift();
    if (!script) throw new Error("unerwarteter Prozessstart");
    spawned++;
    const streaming = options.cmd.includes("stream-json");
    const enc = new TextEncoder();
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let closed = false;
    // Bei stdinError läuft der Prozess bis zum Beenden (sonst wäre der Schreibfehler folgenlos)
    let exit: ((code: number) => void) | undefined;
    const exited = script.stdinError ? new Promise<number>((resolve) => (exit = resolve)) : Promise.resolve(0);
    // Der Lesefehler kommt erst, wenn die Zeilen gelesen sind (error() verwürfe sie sonst)
    const stdout = new ReadableStream<Uint8Array>({
      start: (c) => void (controller = c),
      pull: (c) => {
        if (script.stdoutError) c.error(new Error(script.stdoutError));
      },
    });
    const close = () => {
      if (closed) return;
      closed = true;
      controller.close();
      exit?.(143);
    };
    if (streaming) for (const line of script.lines) controller.enqueue(enc.encode(JSON.stringify(line) + "\n"));
    else controller.enqueue(enc.encode(JSON.stringify(script.lines)));
    if (!script.hang && !script.stdoutError && !script.stdinError) close();
    const stdinError = script.stdinError;
    const proc = {
      pid: 0,
      stdin: {
        write() {},
        end: () => (stdinError ? Bun.sleep(10).then(() => Promise.reject(new Error(stdinError))) : undefined),
      },
      stdout,
      stderr: new ReadableStream({ start: (c) => c.close() }),
      exited,
      kill() {},
    };
    closers.set(proc, close);
    return proc;
  }) as any);
  setRuntimeForTests({ terminate: (proc) => closers.get(proc)?.() });
  return { spawned: () => spawned };
}

const init = (sessionId = "s-1") => ({ type: "system", subtype: "init", session_id: sessionId });
const said = (id: string, text: string) => ({ type: "assistant", message: { id, content: [{ type: "text", text }] } });
const result = (text: string, cost?: number, extra: object = {}) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  result: text,
  session_id: "s-1",
  ...(cost !== undefined ? { total_cost_usd: cost } : {}),
  ...extra,
});

/** Motor-Attrappe mit vorbereiteten Ergebnissen */
function scriptedEngine(id: EngineId, replies: Partial<EngineResult>[]): Engine {
  let n = 0;
  return {
    id,
    describe: () => `Attrappe ${id}`,
    async run() {
      n++;
      return { engine: id, text: `antwort-${id}-${n}`, sessionId: `${id}-s${n}`, isError: false, ...replies.shift() };
    },
  };
}

function turnDeps(engines: Partial<Record<EngineId, Engine>>, extra: Partial<ChatTurnDeps> = {}): Partial<ChatTurnDeps> {
  return {
    getEngine: (id) => {
      const engine = engines[id];
      if (!engine) throw new Error(`kein Motor ${id}`);
      return engine;
    },
    forgetEngineCheck: () => {},
    runFallbackChain: async () => ({ text: "ersatz", source: "openrouter", model: "ersatz-modell" }),
    buildPromptContext: async () => ({ fullPrompt: "voller-prompt", fallbackContext: "kontext" }),
    buildResumePrompt: async () => "resume-prompt",
    isSessionModeEnabled: () => false,
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
    resolveStreamingLimits: () => resolveStreamingLimits({}),
    reportSecrets: () => [],
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => 0,
    ...extra,
  };
}

const sink = { progress: () => {}, notice: () => {} };
const DM = "4711";

function jsonTurn(engine: EngineId, deps: Partial<ChatTurnDeps>) {
  return runJsonTurn({ userMessage: "Frage?", chatId: DM, agentName: "general", engine, sink, deps });
}

function streamingTurn(engine: EngineId, deps: Partial<ChatTurnDeps>) {
  return runStreamingTurn({ userMessage: "Frage?", chatId: DM, agentName: "general", engine, sink, deps });
}

function useCodex(): CodexFake {
  const fake = installCodexFake({ realTimers: true });
  fakes.push(fake);
  return fake;
}

// ---------------------------------------------------------------------------
// Motoren mit echten Ergebnissen
// ---------------------------------------------------------------------------

describe("Erfassung je Motor (echte Motor-Ergebnisse)", () => {
  test("Codex: Tokens gebucht, Kosten nicht gemeldet (NULL), weder Abo-Zähler noch Tagesbudget", async () => {
    const fake = useCodex();
    fake.next({ events: [ev.started("t-1"), ev.message("m-1", "Hallo von Codex"), ev.completed()] });
    await putSettings({ engine: { codex: { model: "gpt-5.6-sol" } } });
    const reply = await jsonTurn("codex", turnDeps({ codex: createCodexEngine() }));
    expect(reply).toBe("Hallo von Codex");
    expect(runs()).toEqual([
      { engine: "codex", model: "gpt-5.6-sol", origin: "chat", input_tokens: 10, output_tokens: 3, cost_usd: null },
    ]);
    expect(cycleSpend()).toBe(0);
    expect(remainingBudget()).toBe(5);
  });

  test("OpenCode: gemeldete Dollar und Tokens, weder Abo-Zähler noch Tagesbudget", async () => {
    const fake = installOpenCodeFake({ realTimers: true });
    fakes.push(fake);
    fake.next({ events: oc.reply("ses_1", "Hallo von OpenCode") });
    const reply = await jsonTurn("opencode", turnDeps({ opencode: createOpenCodeEngine() }));
    expect(reply).toBe("Hallo von OpenCode");
    const [row] = runs();
    expect(runs()).toHaveLength(1);
    expect(row).toMatchObject({ engine: "opencode", model: "", origin: "chat", output_tokens: 3 });
    expect(row.cost_usd).toBeCloseTo(0.001, 10);
    expect(row.input_tokens).toBeGreaterThan(0);
    expect(cycleSpend()).toBe(0);
    expect(remainingBudget()).toBe(5);
  });

  test("Claude JSON: ein Lauf mit gemeldeten Kosten, zählt in den Abo-Zähler, nicht ins Tagesbudget", async () => {
    useClaudeFake([{ lines: [init(), said("m1", "Antwort"), result("Antwort", 0.25)] }]);
    expect(await jsonTurn("claude", turnDeps({ claude: createClaudeEngine() }))).toBe("Antwort");
    expect(runs()).toEqual([
      { engine: "claude", model: "claude-agent-modell", origin: "chat", input_tokens: null, output_tokens: null, cost_usd: 0.25 },
    ]);
    expect(cycleSpend()).toBe(0.25);
    expect(remainingBudget()).toBe(5);
  });

  test("Claude-Strom mit zwei result-Ereignissen (Hook-Folgeturn): Summe, genau eine Buchung", async () => {
    useClaudeFake([
      { lines: [init(), said("m1", "Erster Turn"), result("Erster Turn", 0.1), said("m2", "Zweiter Turn"), result("Zweiter Turn", 0.2)] },
    ]);
    await streamingTurn("claude", turnDeps({ claude: createClaudeEngine() }));
    expect(costs()).toEqual([0.3]);
    expect(round(cycleSpend())).toBe(0.3);
  });
});

describe("Teilkosten bei Abbruch, Zeitlimit und Lesefehler", () => {
  test("Abbruch (/stop) nach einem result: die gemeldeten Kosten werden einmal gebucht", async () => {
    const fake = useClaudeFake([{ lines: [init(), said("m1", "Teil eins"), result("Teil eins", 0.05)], hang: true }]);
    const turn = streamingTurn("claude", turnDeps({ claude: createClaudeEngine() }));
    await until(() => fake.spawned() === 1);
    await Bun.sleep(20);
    abortAllEngineCalls();
    await turn;
    expect(costs()).toEqual([0.05]);
    expect(cycleSpend()).toBe(0.05);
  });

  test("Zeitlimit (Leerlauf) nach einem result: Teilkosten gebucht, kein zweiter Lauf", async () => {
    const fake = useClaudeFake([{ lines: [init(), said("m1", "Teil eins"), result("Teil eins", 0.07)], hang: true }]);
    await streamingTurn("claude", turnDeps({ claude: createClaudeEngine() }, { resolveStreamingLimits: () => ({ idleMs: 40, maxMs: 5_000 }) }));
    expect(fake.spawned()).toBe(1);
    expect(costs()).toEqual([0.07]);
  });

  test("Lesefehler nach einem result: callClaudeStreaming gibt die gemeldeten Kosten zurück", async () => {
    useClaudeFake([{ lines: [init(), said("m1", "Teil"), result("Teil", 0.04)], stdoutError: "Lesefehler" }]);
    const r = await callClaudeStreaming({ prompt: "x", timeoutMs: 5_000 });
    expect(r).toMatchObject({ isError: true, costUsd: 0.04 });
  });

  test("Prompt-Übergabe scheitert (inputError) nach einem result: Teilkosten zurückgegeben und einmal gebucht", async () => {
    useClaudeFake([{ lines: [init(), said("m1", "Teil"), result("Teil", 0.06)], stdinError: "EPIPE" }]);
    const r = await callClaudeStreaming({ prompt: "x", timeoutMs: 5_000 });
    expect(r).toMatchObject({ isError: true, costUsd: 0.06 });

    useClaudeFake([{ lines: [init(), said("m1", "Teil"), result("Teil", 0.06)], stdinError: "EPIPE" }]);
    await streamingTurn("claude", turnDeps({ claude: createClaudeEngine() }));
    expect(costs()).toEqual([0.06]);
    expect(round(cycleSpend())).toBe(0.06);
  });

  test("Abbruch ohne gemeldete Kosten: kein costUsd, Lauf mit Kosten „nicht gemeldet“", async () => {
    const fake = useClaudeFake([{ lines: [init(), said("m1", "Teil eins")], hang: true }]);
    const turn = streamingTurn("claude", turnDeps({ claude: createClaudeEngine() }));
    await until(() => fake.spawned() === 1);
    await Bun.sleep(20);
    abortAllEngineCalls();
    await turn;
    expect(costs()).toEqual([null]);
    expect(cycleSpend()).toBe(0);
  });
});

describe("Genau eine Buchung je Lauf im Chat-Kern", () => {
  test("Resume schlägt fehl, neuer Versuch: zwei Läufe, je einmal gebucht", async () => {
    const key = sessionKeyFor(DM);
    await recordSessionTurn(key, "general", "claude-agent-modell", "claude", "alt-session");
    const claude = scriptedEngine("claude", [
      { isError: true, text: "No conversation found", costUsd: 0.01 },
      { text: "frisch", costUsd: 0.02 },
    ]);
    const reply = await jsonTurn("claude", turnDeps({ claude }, { isSessionModeEnabled: () => true }));
    expect(reply).toBe("frisch");
    expect(costs()).toEqual([0.01, 0.02]);
    expect(round(cycleSpend())).toBe(0.03);
  });

  test("Motorwechsel (Codex nicht angemeldet → Claude): beide Läufe je einmal, nur Claude im Abo-Zähler", async () => {
    const codex = scriptedEngine("codex", [{ isError: true, errorKind: "auth", text: "", usage: { inputTokens: 5 } }]);
    const claude = scriptedEngine("claude", [{ text: "von claude", costUsd: 0.4 }]);
    expect(await jsonTurn("codex", turnDeps({ codex, claude }))).toBe("von claude");
    expect(runs().map((r) => [r.engine, r.input_tokens, round(r.cost_usd)])).toEqual([
      ["codex", 5, null],
      ["claude", null, 0.4],
    ]);
    expect(cycleSpend()).toBe(0.4);
  });

  test("claude.ts bucht nicht selbst: callClaude allein hinterlässt keinen Lauf und keinen Abo-Stand", async () => {
    useClaudeFake([{ lines: [init(), result("ok", 0.3)] }]);
    const r = await callClaude({ prompt: "x", outputFormat: "json" });
    expect(r.costUsd).toBe(0.3);
    expect(runs()).toEqual([]);
    expect(cycleSpend()).toBe(0);
  });
});

describe("Weitere Buchungsstellen", () => {
  test("Aux-Modell (Claude, JSON): Herkunft aux mit gemeldeten Kosten", async () => {
    useClaudeFake([{ lines: [init(), result("{\"ok\":true}", 0.012)] }]);
    const r = await callAux("distill", "prompt");
    expect(r.isError).toBe(false);
    expect(runs()).toMatchObject([{ engine: "claude", origin: "aux", cost_usd: 0.012 }]);
    expect(runs()[0].model).not.toBe("");
  });

  test("Fallback-Kette, Claude-CLI im Textformat: Lauf mit Kosten „nicht gemeldet“", async () => {
    const reply = await runFallbackChain(
      { question: "Frage", context: "" },
      { callClaude: async () => ({ text: "ersatz-antwort", isError: false }), tools: () => undefined },
    );
    expect(reply.text).toBe("ersatz-antwort");
    expect(runs()).toMatchObject([{ engine: "claude", origin: "fallback", cost_usd: null }]);
    expect(runs()[0].model).not.toBe("");
    expect(cycleSpend()).toBe(0);
  });

  test("Fallback-Kette mit echtem callClaude: Textformat ohne Kostenmeldung, genau ein Lauf", async () => {
    useClaudeFake([{ lines: [] }]);
    // Textformat: die Attrappe liefert die Liste als Text; entscheidend ist, dass kein Dollar gebucht wird
    await runFallbackChain({ question: "Frage", context: "" }, { tools: () => undefined });
    expect(runs().filter((r) => r.origin === "fallback")).toMatchObject([{ engine: "claude", cost_usd: null }]);
  });

  test("Routine (/routine): Herkunft routine, Motor und Modell der Session", async () => {
    const session: BotSession = {
      key: `${sessionKeyFor(DM)}:general`,
      agentName: "general",
      engine: "codex",
      engineSessionId: "codex-alt",
      model: "gpt-5.6-sol",
      startedAt: 1,
      lastActivity: 1,
      messageCount: 3,
    } as BotSession;
    const codex = scriptedEngine("codex", [{ text: "Routine angelegt", usage: { inputTokens: 7, outputTokens: 2 } }]);
    await createRoutineFromSession(session, "", { getEngine: () => codex, log: async () => {} });
    expect(runs()).toEqual([
      { engine: "codex", model: "gpt-5.6-sol", origin: "routine", input_tokens: 7, output_tokens: 2, cost_usd: null },
    ]);
  });

  test("Knopf-Antwort (task-resume): Herkunft task-resume, auch bei Abbruch genau einmal", async () => {
    const claude = scriptedEngine("claude", [{ text: "weiter", costUsd: 0.03 }, { aborted: true, isError: true, text: "" }]);
    const deps = {
      runExecution,
      isSessionModeEnabled: () => false,
      sessionEpoch: () => 1,
      finalizeClaudeSession: async () => true,
      getEngine: () => claude,
      resolveModel: () => "claude-sonnet-test",
      resolveEffort: () => "high",
      allowedTools: () => undefined,
      cwd: dir,
    };
    const task = { id: "t-1", chat_id: DM, session_id: "s-frage", metadata: {} } as any;
    expect((await resumeMacTask(task, DM, "Ja", deps)).status).toBe("done");
    expect((await resumeMacTask(task, DM, "Ja", deps)).status).toBe("aborted");
    expect(runs().map((r) => [r.origin, r.model, round(r.cost_usd)])).toEqual([
      ["task-resume", "claude-sonnet-test", 0.03],
      ["task-resume", "claude-sonnet-test", null],
    ]);
  });

  test("Destillat: andere Motoren mit Herkunft aux gebucht, Claude-Destillat nicht doppelt", async () => {
    const base = { agentName: "general", startedAt: 1, lastActivity: 1, messageCount: 4 };
    const codex = scriptedEngine("codex", [{ text: "NONE", usage: { inputTokens: 3, outputTokens: 1 } }]);
    await distillSession(
      { ...base, key: "a:general", engine: "codex", engineSessionId: "c-1", model: "" } as BotSession,
      { callAux: async () => ({ text: "NONE", isError: false }), processIntents: async () => ({}) as any, getEngine: () => codex },
    );
    // Claude-Session: callAux bucht selbst (hier eine Attrappe ohne Buchung), resumeForDistill bucht nichts dazu
    await distillSession(
      { ...base, key: "b:general", engine: "claude", engineSessionId: "k-1", model: "claude-x" } as BotSession,
      { callAux: async () => ({ text: "NONE", isError: false }), processIntents: async () => ({}) as any },
    );
    expect(runs()).toEqual([{ engine: "codex", model: "", origin: "aux", input_tokens: 3, output_tokens: 1, cost_usd: null }]);
  });
});

describe("Abo-Zähler nur für Claude bei aktiver Messung", () => {
  test("CREDIT_GUARD=off: engine_runs gefüllt, Abo-Zähler unverändert", async () => {
    process.env.CREDIT_GUARD = "off";
    await bookEngineRun({ engine: "claude", origin: "chat", costUsd: 1.5, isError: false, text: "ok" });
    expect(costs()).toEqual([1.5]);
    expect(cycleSpend()).toBe(0);
  });

  test("Eigener API-Schlüssel: engine_runs gefüllt, Abo-Zähler unverändert", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-test-nur-attrappe";
    await bookEngineRun({ engine: "claude", origin: "chat", costUsd: 2, isError: false, text: "ok" });
    expect(costs()).toEqual([2]);
    expect(cycleSpend()).toBe(0);
  });

  test("Codex, OpenCode und OpenRouter zählen nie in den Abo-Zähler", async () => {
    await bookEngineRun({ engine: "codex", origin: "chat", usage: { inputTokens: 1 } });
    await bookEngineRun({ engine: "opencode", origin: "chat", costUsd: 0.5 });
    await bookEngineRun({ engine: "openrouter", origin: "agent-sdk", costUsd: 0.7 });
    expect(costs()).toEqual([null, 0.5, 0.7]);
    expect(cycleSpend()).toBe(0);
    expect(remainingBudget()).toBe(5);
  });

  test("Speicherfehler: keine Ausnahme, nichts gebucht", async () => {
    const blocker = join(dir, "blocker");
    await Bun.write(blocker, "keine Ablage");
    process.env.BUDGET_DB_PATH = join(blocker, "api-budget.sqlite");
    await bookEngineRun({ engine: "claude", origin: "chat", costUsd: 1, isError: false, text: "ok" });
    expect(readCycle(1)).toBeNull();
  });
});

describe("Gelerntes Limit enthält den Limit-Lauf", () => {
  const limitText = "Claude AI usage limit reached|1790000000";

  test("10 $ Stand plus Limit-Lauf mit 0,50 $ ergibt 10,50 $; ein zweiter Limit-Lauf ändert nichts", async () => {
    addCycleSpend(10, 1);
    await bookEngineRun({ engine: "claude", origin: "chat", costUsd: 0.5, isError: true, text: limitText });
    expect(readCycle(1)?.observedCeilingUsd).toBe(10.5);
    await bookEngineRun({ engine: "claude", origin: "chat", costUsd: 0.25, isError: true, text: limitText });
    expect(readCycle(1)?.observedCeilingUsd).toBe(10.5);
    expect(readCycle(1)?.cycleSpendUsd).toBe(10.75);
  });

  test("Limit-Lauf ohne Kostenmeldung oder mit 0 $: der vorhandene Stand wird gelernt", async () => {
    addCycleSpend(4, 1);
    await bookEngineRun({ engine: "claude", origin: "chat", costUsd: 0, isError: true, text: limitText });
    expect(readCycle(1)?.observedCeilingUsd).toBe(4);
    expect(costs()).toEqual([0]);
  });

  test("Limit-Lauf ohne jede Kostenmeldung lernt ebenfalls", async () => {
    addCycleSpend(6, 1);
    await bookEngineRun({ engine: "claude", origin: "voice", isError: true, text: limitText });
    expect(readCycle(1)?.observedCeilingUsd).toBe(6);
    expect(costs()).toEqual([null]);
  });

  test("Kein Lernen ohne Limit-Fehler, bei anderen Motoren oder ohne aktive Messung", async () => {
    addCycleSpend(3, 1);
    await bookEngineRun({ engine: "claude", origin: "chat", costUsd: 0.1, isError: true, text: "anderer Fehler" });
    await bookEngineRun({ engine: "codex", origin: "chat", isError: true, text: limitText });
    process.env.CREDIT_GUARD = "off";
    await bookEngineRun({ engine: "claude", origin: "chat", isError: true, text: limitText });
    expect(readCycle(1)?.observedCeilingUsd).toBeNull();
  });

  for (const streaming of [false, true]) {
    for (const [text, errorKind, ceiling] of [
      ["You've hit your weekly limit · resets Nov 22, 4pm", "usage_limit", null],
      ["You've reached your weekly limit", "usage_limit", null],
      ["You're out of usage credits.", "quota", null],
      // Der alte Marker trifft weiterhin: neu als Fehler erkannt, lernt er
      // auch weiterhin aus genau diesem Text eine Obergrenze (Prüferhinweis).
      ["You've hit your limit · resets Nov 22, 4pm", "usage_limit", 3.2],
    ] as const) {
      test(`${streaming ? "Strom" : "JSON"}: Abo-Zähler nach ${text}`, async () => {
        process.env.CLAUDE_AUTH = "subscription";
        addCycleSpend(3, 1);
        useClaudeFake([{ lines: [
          { type: "rate_limit_event", rate_limit_info: { status: "rejected" } },
          result(text, 0.2),
        ] }]);
        const run = await (streaming
          ? callClaudeStreaming({ prompt: "Probe" })
          : callClaude({ prompt: "Probe", outputFormat: "json" }));
        expect(run).toMatchObject({ text, isError: true, errorKind });
        await bookEngineRun({ ...run, engine: "claude", origin: "chat" });
        expect(readCycle(1)?.observedCeilingUsd).toBe(ceiling);
        expect(readCycle(1)?.cycleSpendUsd).toBeCloseTo(3.2, 8);
        expect(costs()).toEqual([0.2]);
      });
    }
  }
});

async function putSettings(content: object): Promise<void> {
  await Bun.write(join(dir, "settings.json"), JSON.stringify(content));
}
