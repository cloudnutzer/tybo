/**
 * Issue #563 (R1-08), Checkbox 1: /stop bei aktivem Ziel beendet nur die
 * Ziel-Schleife. Nachgestellt mit der echten Warteschlange (ein Platz), dem
 * echten /stop aus dem Befehls-Register und abortEngineCalls: das Ziel bleibt
 * pausiert, die Schleifen-Markierung verschwindet, keine unbehandelte
 * Ablehnung, Befund und Judge-Fehlschläge bleiben unverändert. Aufrufe unter
 * anderen Session-Schlüsseln laufen weiter. Andere Fehler der Schleife landen
 * im Log und als Meldung im Gespräch des Ziels.
 *
 * Eigener Zustand im Temp-Verzeichnis, Agent und Meldungen als Attrappen,
 * der Judge über eine Fetch-Attrappe; src/bot.ts wird nie geladen.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  clearGoal,
  configureGoalStore,
  getGoal,
  GOAL_FAILED_TEXT,
  initGoalEngine,
  isGoalLoopRunning,
  onAgentTurnForGoal,
  pauseGoal,
  runningGoalLoopCount,
  setGoal,
  startGoalWork,
  updateGoal,
  type GoalEngineDeps,
  type GoalStatusMessage,
  type GoalTarget,
} from "../src/lib/goal-engine";
import { activeExecutionCount, checkAborted, currentExecution, isExecutionActive, runExecution } from "../src/lib/execution-context";
import { abortEngineCalls } from "../src/lib/engines";
import { commandRegistry } from "../src/lib/commands/builtin";
import type { CommandContext } from "../src/lib/commands/types";
import { useAgentCapacity } from "./agent-capacity-fixture";

// Genau ein Platz, wie im nachgestellten Ablauf des Prüfers (MAX_AGENT_PROCESSES=1)
useAgentCapacity(1);

const dir = mkdtempSync(join(tmpdir(), "tybo-goal-stop-"));
let fileNo = 0;

const KEY = "topic:-100:1";
const OTHER = "topic:-100:99";
const AGENT = "research";

let statuses: { target: GoalTarget; message: GoalStatusMessage }[] = [];
let prompts: string[] = [];
let shuttingDown = false;
let errors: string[] = [];
let rejections: unknown[] = [];
const onRejection = (reason: unknown) => void rejections.push(reason);
const realError = console.error;

/** Judge über eine Fetch-Attrappe (OpenRouter-Ziel), hängt bis zum Abbruch */
const env = { judge: process.env.AUX_MODEL_JUDGE, key: process.env.OPENROUTER_API_KEY };
const realFetch = globalThis.fetch;
let judgeCalls = 0;

beforeAll(() => {
  process.on("unhandledRejection", onRejection);
  process.env.AUX_MODEL_JUDGE = "openrouter:test/judge";
  process.env.OPENROUTER_API_KEY = "test";
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    if (!String(url).includes("openrouter.ai")) return Response.json({ ok: true, result: {} });
    judgeCalls++;
    const signal = init?.signal;
    await new Promise<void>((_, reject) => {
      if (signal?.aborted) reject(new DOMException("Abgebrochen", "AbortError"));
      signal?.addEventListener("abort", () => reject(new DOMException("Abgebrochen", "AbortError")), { once: true });
    });
    return new Response("nie", { status: 500 });
  }) as typeof fetch;
});
afterAll(() => {
  process.off("unhandledRejection", onRejection);
  globalThis.fetch = realFetch;
  if (env.judge === undefined) delete process.env.AUX_MODEL_JUDGE;
  else process.env.AUX_MODEL_JUDGE = env.judge;
  if (env.key === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = env.key;
  rmSync(dir, { recursive: true, force: true });
});

async function waitUntil(check: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(2);
  }
}

function held() {
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  return { gate, release };
}

/** Engine mit eigenem Zustand; callAgent und sendStatus je Test ersetzbar */
function engine(overrides: Partial<GoalEngineDeps> = {}): string {
  const file = join(dir, `goals-${++fileNo}.json`);
  configureGoalStore({ file });
  initGoalEngine({
    isShuttingDown: () => shuttingDown,
    callAgent: async prompt => {
      prompts.push(prompt);
      return { text: "", aborted: true };
    },
    sendAsAgent: async () => {},
    sendStatus: async (target, message) => void statuses.push({ target, message }),
    saveMessage: async () => true,
    ...overrides,
  });
  return file;
}

async function activeGoal(gates: string[] = []) {
  await setGoal({ sessionKey: KEY, chatId: "-100", topicId: 1, agentName: AGENT, goal: "Bericht fertig" });
  const g = (await updateGoal(KEY, { gates, lastNote: "alter Befund" }))!;
  return g;
}

/** /stop wie aus Telegram: echtes Register, echtes pauseGoal und abortEngineCalls */
async function stop(sessionKey = KEY): Promise<string[]> {
  const replies: string[] = [];
  const ctx = {
    channel: "telegram",
    chatId: "-100",
    topicId: 1,
    sessionKey,
    agent: AGENT,
    name: "stop",
    args: "",
    text: "/stop",
    reply: async (t: string) => void replies.push(t),
    services: {
      getGoal,
      pauseGoal: (key: string, reason: string) => pauseGoal(key, reason),
      abortEngineCalls,
      requestBoardStop: () => "none",
    },
  } as unknown as CommandContext;
  await commandRegistry.get("stop")!.run(ctx);
  return replies;
}

/**
 * Belegt den einzigen Platz unter einem anderen Session-Schlüssel. Hält das
 * echte Signal seiner Ausführung fest und prüft es nach dem Warten mit
 * checkAborted: wird er mit abgebrochen, lehnt done mit AbortError ab.
 */
function otherCall() {
  const h = held();
  let started = false;
  let signal: AbortSignal | undefined;
  const done = runExecution(OTHER, "general", async () => {
    started = true;
    signal = currentExecution()?.controller.signal;
    await h.gate;
    checkAborted();
    return "andere Antwort";
  });
  return {
    done,
    release: h.release,
    started: () => started,
    aborted: () => {
      if (!signal) throw new Error("Aufruf unter OTHER lief nie");
      return signal.aborted;
    },
  };
}

const settle = (p: Promise<unknown>) => p.then(v => ({ ok: true as const, v }), (e: unknown) => ({ ok: false as const, e }));

beforeEach(() => {
  statuses = [];
  prompts = [];
  shuttingDown = false;
  judgeCalls = 0;
  errors = [];
  rejections = [];
  // Nur Zeilen der Goal-Engine; der abgebrochene Judge schreibt eigene ([AuxModel])
  console.error = (...args: unknown[]) => {
    const line = args.map(String).join(" ");
    if (line.startsWith("[GoalEngine]")) errors.push(line);
  };
});
afterEach(async () => {
  console.error = realError;
  await clearGoal(KEY);
  await waitUntil(() => runningGoalLoopCount() === 0 && activeExecutionCount() === 0);
});

/** Was nach jedem /stop gelten muss: pausiert, Befund und Zähler unverändert, keine Ablehnung */
async function expectStoppedCleanly(turnsUsed = 0) {
  // Eine unbehandelte Ablehnung käme erst im nächsten Durchlauf der Ereignisschleife an
  await Bun.sleep(20);
  expect(rejections).toEqual([]);
  expect(isGoalLoopRunning(KEY)).toBe(false);
  expect(await getGoal(KEY)).toMatchObject({
    status: "paused",
    lastNote: "Vom User gestoppt (/stop)",
    judgeFailures: 0,
    turnsUsed,
  });
  expect(statuses.filter(s => s.message.kind !== "turn")).toEqual([]);
  expect(errors).toEqual([]);
}

describe("/stop bei aktivem Ziel, ein Platz (Issue #563)", () => {
  test("onAgentTurnForGoal: Gate-Lauf wartet auf den Platz, /stop beendet nur die Schleife", async () => {
    engine();
    await activeGoal();
    const other = otherCall();
    await waitUntil(other.started);

    const loop = settle(onAgentTurnForGoal(KEY, AGENT, "Antwort des Agenten"));
    await waitUntil(() => isGoalLoopRunning(KEY) && isExecutionActive(KEY));

    expect(await stop()).toEqual(["⏹️ 1 laufende Verarbeitung abgebrochen, Ziel pausiert (/goal weiter setzt fort)."]);
    expect(await loop).toEqual({ ok: true, v: undefined });
    await expectStoppedCleanly();
    expect(judgeCalls).toBe(0);

    // Der Aufruf unter dem anderen Schlüssel lief die ganze Zeit weiter
    expect(other.aborted()).toBe(false);
    expect(isExecutionActive(OTHER)).toBe(true);
    other.release();
    expect(await other.done).toBe("andere Antwort");
    expect(prompts).toEqual([]);
  });

  test("onAgentTurnForGoal: Judge wartet auf den Platz, /stop zählt keinen Judge-Fehlschlag", async () => {
    engine();
    const flag = join(dir, `gate-frei-${fileNo}`);
    // Das Gate hält den Platz, bis der andere Aufruf wartet; danach wartet der Judge hinter ihm
    await activeGoal([`while [ ! -f '${flag}' ]; do sleep 0.01; done`]);

    const loop = settle(onAgentTurnForGoal(KEY, AGENT, "Antwort des Agenten"));
    await waitUntil(() => isExecutionActive(KEY));
    const other = otherCall();
    await Bun.sleep(20);
    expect(other.started()).toBe(false);
    writeFileSync(flag, "");
    await waitUntil(other.started);
    // Gate bestanden, der Judge steht jetzt in der Warteschlange
    await waitUntil(() => isExecutionActive(KEY));
    expect(judgeCalls).toBe(0);

    await stop();
    expect(await loop).toEqual({ ok: true, v: undefined });
    await expectStoppedCleanly();
    expect(judgeCalls).toBe(0);
    expect(other.aborted()).toBe(false);
    expect(isExecutionActive(OTHER)).toBe(true);
    other.release();
    expect(await other.done).toBe("andere Antwort");
  });

  test("laufendes Gate: /stop setzt keinen Gate-Befund als lastNote", async () => {
    engine();
    await activeGoal(["sleep 30"]);

    const loop = settle(onAgentTurnForGoal(KEY, AGENT, "Antwort des Agenten"));
    await waitUntil(() => isExecutionActive(KEY));
    await Bun.sleep(30);
    await stop();
    expect(await loop).toEqual({ ok: true, v: undefined });
    await expectStoppedCleanly();
  });

  test("laufender Judge: /stop erhöht judgeFailures nicht und meldet keinen Judge-Ausfall", async () => {
    engine();
    await activeGoal();

    const loop = settle(onAgentTurnForGoal(KEY, AGENT, "Antwort des Agenten"));
    await waitUntil(() => judgeCalls === 1);
    await stop();
    expect(await loop).toEqual({ ok: true, v: undefined });
    await expectStoppedCleanly();
  });

  test("startGoalWork: Arbeits-Turn wartet auf den Platz und wirft AbortError, /stop beendet nur die Schleife", async () => {
    // Agent-Turn über die echte Warteschlange; ein Abbruch dort wirft AbortError
    engine({
      callAgent: (_prompt, target) =>
        runExecution(target.sessionKey, target.agentName, async () => {
          prompts.push("lief");
          return { text: "nie", aborted: false };
        }),
    });
    await activeGoal();
    const other = otherCall();
    await waitUntil(other.started);

    const loop = settle(startGoalWork(KEY));
    await waitUntil(() => isGoalLoopRunning(KEY) && isExecutionActive(KEY));

    await stop();
    expect(await loop).toEqual({ ok: true, v: undefined });
    await expectStoppedCleanly();
    expect(statuses.map(s => s.message.kind)).toEqual(["turn"]);
    expect(other.aborted()).toBe(false);

    other.release();
    expect(await other.done).toBe("andere Antwort");
    // Der abgebrochene Turn bekommt auch nach der Freigabe keinen Platz mehr
    await Bun.sleep(20);
    expect(prompts).toEqual([]);
  });

  test("Shutdown-Abbruch: Ziel bleibt aktiv für die Fortsetzung, kein Log, keine Meldung", async () => {
    engine({
      callAgent: (_prompt, target) => runExecution(target.sessionKey, target.agentName, async () => ({ text: "nie", aborted: false })),
    });
    await activeGoal();
    const other = otherCall();
    await waitUntil(other.started);

    const loop = settle(startGoalWork(KEY));
    await waitUntil(() => isExecutionActive(KEY));
    shuttingDown = true;
    abortEngineCalls(KEY);
    expect(await loop).toEqual({ ok: true, v: undefined });
    await Bun.sleep(20);
    expect(rejections).toEqual([]);
    expect(await getGoal(KEY)).toMatchObject({ status: "active", lastNote: "alter Befund", judgeFailures: 0 });
    expect(statuses.map(s => s.message.kind)).toEqual(["turn"]);
    expect(errors).toEqual([]);
    expect(other.aborted()).toBe(false);
    other.release();
    expect(await other.done).toBe("andere Antwort");
  });
});

describe("andere Fehler der Ziel-Schleife (Issue #563)", () => {
  test("Fehler im Arbeits-Turn: Logzeile, Ziel pausiert, Meldung im Gespräch des Ziels", async () => {
    engine({
      callAgent: async () => {
        throw new Error("Motor kaputt mit geheimem Inhalt");
      },
    });
    await activeGoal();

    expect(await settle(startGoalWork(KEY))).toEqual({ ok: true, v: undefined });
    await Bun.sleep(20);
    expect(rejections).toEqual([]);
    expect(errors).toEqual(["[GoalEngine] Ziel-Schleife gescheitert (Error)"]);
    expect(await getGoal(KEY)).toMatchObject({ status: "paused", lastNote: "Fehler in der Ziel-Schleife" });
    expect(isGoalLoopRunning(KEY)).toBe(false);
    const failed = statuses.filter(s => s.message.kind === "failed");
    expect(failed).toHaveLength(1);
    expect(failed[0].message.text).toBe(GOAL_FAILED_TEXT);
    expect(failed[0].target).toMatchObject({ sessionKey: KEY, chatId: "-100", topicId: 1, agentName: AGENT });
  });

  test("Fehler beim Zwischenstand aus onAgentTurnForGoal: ebenso gemeldet, kein Wiederanlauf", async () => {
    let turnNotices = 0;
    engine({
      sendStatus: async (target, message) => {
        if (message.kind === "turn") {
          turnNotices++;
          throw new Error("Telegram 400");
        }
        statuses.push({ target, message });
      },
    });
    // Ein scheiterndes Gate geht ohne Judge in den nächsten Arbeits-Turn
    await activeGoal(["false"]);
    expect(await settle(onAgentTurnForGoal(KEY, AGENT, "Antwort"))).toEqual({ ok: true, v: undefined });
    await Bun.sleep(30);
    expect(rejections).toEqual([]);
    expect(turnNotices).toBe(1);
    expect(errors).toEqual(["[GoalEngine] Ziel-Schleife gescheitert (Error)"]);
    expect(statuses.map(s => s.message.kind)).toEqual(["failed"]);
    expect(await getGoal(KEY)).toMatchObject({ status: "paused", lastNote: "Fehler in der Ziel-Schleife" });
    expect(isGoalLoopRunning(KEY)).toBe(false);
  });

  test("auch die Fehlermeldung scheitert: keine neue unbehandelte Ablehnung", async () => {
    engine({
      callAgent: async () => {
        throw new TypeError("kaputt");
      },
      // Der Zwischenstand geht noch raus, erst die Fehlermeldung scheitert
      sendStatus: async (_target, message) => {
        if (message.kind !== "turn") throw new Error("Netz weg");
      },
    });
    await activeGoal();

    expect(await settle(startGoalWork(KEY))).toEqual({ ok: true, v: undefined });
    await Bun.sleep(20);
    expect(rejections).toEqual([]);
    expect(errors).toEqual([
      "[GoalEngine] Ziel-Schleife gescheitert (TypeError)",
      "[GoalEngine] Fehler der Ziel-Schleife nicht gemeldet (Error)",
    ]);
    expect(await getGoal(KEY)).toMatchObject({ status: "paused", lastNote: "Fehler in der Ziel-Schleife" });
  });

  test("Ziel inzwischen ersetzt: der Nachfolger bleibt unverändert, keine Meldung", async () => {
    const turn = held();
    engine({
      callAgent: async () => {
        await turn.gate;
        throw new Error("spät gescheitert");
      },
    });
    await activeGoal();
    const loop = settle(startGoalWork(KEY));
    await waitUntil(() => statuses.length === 1);
    const successor = await setGoal({ sessionKey: KEY, chatId: "-100", topicId: 1, agentName: AGENT, goal: "Neues Ziel" });
    turn.release();
    expect(await loop).toEqual({ ok: true, v: undefined });
    await Bun.sleep(20);
    expect(rejections).toEqual([]);
    expect(await getGoal(KEY)).toMatchObject({ goal: "Neues Ziel", status: "active", createdAt: successor.createdAt });
    expect((await getGoal(KEY))?.lastNote).toBeUndefined();
    expect(statuses.filter(s => s.message.kind === "failed")).toEqual([]);
  });

  test("Zustand nicht lesbar: onAgentTurnForGoal endet mit Logzeile statt Ablehnung", async () => {
    const file = join(dir, `kaputt-${++fileNo}.json`);
    writeFileSync(file, "{ kein json");
    configureGoalStore({ file });
    expect(existsSync(file)).toBe(true);
    expect(await settle(onAgentTurnForGoal(KEY, AGENT, "Antwort"))).toEqual({ ok: true, v: undefined });
    await Bun.sleep(20);
    expect(rejections).toEqual([]);
    expect(errors).toEqual(["[GoalEngine] Ziel-Schleife gescheitert (SyntaxError)"]);
    expect(isGoalLoopRunning(KEY)).toBe(false);
    // Aufräumen in afterEach braucht einen lesbaren Zustand
    engine();
  });
});
