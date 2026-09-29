/**
 * Issue #190, Checkbox 2: Ziel-Schleifen und Neustart. Eine laufende Schleife
 * zählt als beschäftigt, auch zwischen ihren Turns; nach dem Start laufen
 * aktive Ziele genau einmal mit Meldung weiter, pausierte und erledigte
 * bleiben stehen. Eigener Zustand im Temp-Verzeichnis, Agent und Meldungen
 * als Attrappen; src/bot.ts wird nie geladen.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  clearGoal,
  configureGoalStore,
  getGoal,
  goalResumedText,
  goalResumeOnStart,
  initGoalEngine,
  isGoalLoopRunning,
  resetGoalResumeForTests,
  resumeActiveGoalsAfterStart,
  runningGoalLoopCount,
  startGoalWork,
  type ActiveGoal,
  type GoalStatusMessage,
  type GoalTarget,
} from "../src/lib/goal-engine";
import { activeExecutionCount, closeIntake, isIntakeClosed } from "../src/lib/execution-context";
import { createRestartControl } from "../src/lib/restart-control";

const dir = mkdtempSync(join(tmpdir(), "tybo-goal-restart-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let statuses: { target: GoalTarget; message: GoalStatusMessage }[] = [];
let prompts: { prompt: string; chatId: string; topicId?: number }[] = [];
let pending: Array<(r: { text: string; aborted: boolean }) => void> = [];
/** Solange gesetzt, wartet der Zwischenstand vor einem Turn darauf */
let turnGate: Promise<void> | null = null;
let fileNo = 0;

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(2);
  }
}

function goal(sessionKey: string, extra: Partial<ActiveGoal>): ActiveGoal {
  return {
    sessionKey,
    chatId: "-100",
    agentName: "research",
    goal: `Ziel ${sessionKey}`,
    gates: [],
    maxTurns: 10,
    turnsUsed: 0,
    status: "active",
    createdAt: 1000,
    updatedAt: 1000,
    judgeFailures: 0,
    ...extra,
  };
}

/** Gilt für die Engine-Attrappe: der Prozess fährt herunter */
let shuttingDown = false;

/** Wie nach einem Neustart: Datei schreiben, Cache verwerfen, Engine neu verdrahten */
function freshProcess(goals: ActiveGoal[]): string {
  const file = join(dir, `goals-${++fileNo}.json`);
  writeFileSync(file, JSON.stringify(Object.fromEntries(goals.map(g => [g.sessionKey, g]))));
  reopenStore(file);
  return file;
}

/** Zustand aus einer vorhandenen Datei laden, wie ein neuer Prozess */
function reopenStore(file: string): void {
  configureGoalStore({ file });
  resetGoalResumeForTests();
  shuttingDown = false;
  initGoalEngine({
    isShuttingDown: () => shuttingDown,
    callAgent: (prompt, chatId, _agent, topicId) => {
      prompts.push({ prompt, chatId, topicId });
      return new Promise(resolve => pending.push(resolve));
    },
    sendAsAgent: async () => {},
    sendStatus: async (target, message) => {
      statuses.push({ target, message });
      if (message.kind === "turn" && turnGate) await turnGate;
    },
    saveMessage: async () => true,
  });
}

const keys = ["topic:-100:1", "topic:-100:2", "topic:-100:3", "topic:-100:4"];

beforeEach(() => {
  shuttingDown = false;
  statuses = [];
  prompts = [];
  pending = [];
  turnGate = null;
});
afterEach(async () => {
  for (const k of keys) await clearGoal(k);
  for (const resolve of pending) resolve({ text: "", aborted: true });
  await waitUntil(() => runningGoalLoopCount() === 0);
});

describe("Ziele nach dem Start fortsetzen", () => {
  test("nur aktive Ziele, genau einmal, mit Meldung im richtigen Gespräch; Budget und Zähler bleiben", async () => {
    freshProcess([
      goal(keys[0], { topicId: 1, turnsUsed: 3, maxTurns: 12, judgeFailures: 1 }),
      goal(keys[1], { topicId: 2, status: "paused" }),
      goal(keys[2], { topicId: 3, status: "paused", budgetPaused: true, turnsUsed: 10 }),
      goal(keys[3], { topicId: 4, status: "done" }),
    ]);

    expect(await resumeActiveGoalsAfterStart()).toEqual([keys[0]]);
    // Ein zweiter Aufruf (etwa doppelt verdrahtet) setzt nichts noch einmal fort
    expect(await resumeActiveGoalsAfterStart()).toEqual([]);

    await waitUntil(() => prompts.length === 1);
    const resumed = statuses.filter(s => s.message.kind === "resumed");
    expect(resumed).toHaveLength(1);
    expect(resumed[0].target).toMatchObject({ sessionKey: keys[0], chatId: "-100", topicId: 1 });
    expect(resumed[0].message.text).toBe(goalResumedText((await getGoal(keys[0]))!));
    expect(resumed[0].message.text).toContain("Turn 3/12");
    // Meldung vor dem ersten Turn, der im selben Topic weitermacht
    expect(statuses.map(s => s.message.kind)).toEqual(["resumed", "turn"]);
    expect(prompts[0]).toMatchObject({ chatId: "-100", topicId: 1 });
    expect(prompts[0].prompt).toContain("Turn 4/12");

    const g = (await getGoal(keys[0]))!;
    expect(g).toMatchObject({ status: "active", turnsUsed: 3, maxTurns: 12, judgeFailures: 1 });
    expect(isGoalLoopRunning(keys[0])).toBe(true);
    for (const k of keys.slice(1)) expect(isGoalLoopRunning(k)).toBe(false);
    expect((await getGoal(keys[1]))?.status).toBe("paused");
    expect(await getGoal(keys[2])).toMatchObject({ status: "paused", budgetPaused: true, turnsUsed: 10 });
    expect((await getGoal(keys[3]))?.status).toBe("done");
  });

  test("während der Meldung gestoppt: keine Fortsetzung", async () => {
    freshProcess([goal(keys[0], { topicId: 1 })]);
    initGoalEngine({
      callAgent: prompt => {
        prompts.push({ prompt, chatId: "-100" });
        return new Promise(resolve => pending.push(resolve));
      },
      sendAsAgent: async () => {},
      sendStatus: async (target, message) => {
        statuses.push({ target, message });
        if (message.kind === "resumed") await clearGoal(target.sessionKey);
      },
      saveMessage: async () => true,
    });
    expect(await resumeActiveGoalsAfterStart()).toEqual([]);
    expect(prompts).toEqual([]);
  });
});

describe("Ziel-Schleife und Neustart-Prüfung", () => {
  test("laufende Schleife blockiert den Neustart auch zwischen ihren Turns", async () => {
    freshProcess([goal(keys[0], { topicId: 1 })]);
    let release!: () => void;
    turnGate = new Promise<void>(r => (release = r));
    void startGoalWork(keys[0]);
    // Zwischenstand vor dem Turn: kein Agentenaufruf, keine Ausführung aktiv
    await waitUntil(() => statuses.some(s => s.message.kind === "turn"));
    expect(activeExecutionCount()).toBe(0);
    expect(runningGoalLoopCount()).toBe(1);

    let marker: string | null = "neuer Code";
    const shutdowns: string[] = [];
    const control = createRestartControl({
      readRequest: async () => marker,
      clearRequest: async () => void (marker = null),
      busyCount: () => activeExecutionCount() + runningGoalLoopCount(),
      detectSupervisor: async () => "launchd",
      closeIntake,
      send: async () => {},
      shutdown: async r => void shutdowns.push(r),
      isShuttingDown: () => false,
      log: () => {},
    });
    expect(await control.maybeRestart("idle")).toBe("busy");
    expect(marker).toBe("neuer Code");
    expect(shutdowns).toEqual([]);
    expect(isIntakeClosed()).toBe(false);
    release();
    await waitUntil(() => prompts.length === 1);
  });

  test("gesperrte Annahme: keine neue Schleife, das Ziel bleibt aktiv", async () => {
    freshProcess([goal(keys[0], { topicId: 1 })]);
    const reopen = closeIntake();
    try {
      await startGoalWork(keys[0]);
      expect(isGoalLoopRunning(keys[0])).toBe(false);
      expect(statuses).toEqual([]);
      expect((await getGoal(keys[0]))?.status).toBe("active");
    } finally {
      reopen();
    }
  });
});

describe("Shutdown-Abbruch ist kein /stop", () => {
  test("laufendes Ziel, Shutdown bricht den Turn ab: Ziel bleibt aktiv und läuft nach dem Start weiter", async () => {
    const file = freshProcess([goal(keys[0], { topicId: 1, turnsUsed: 2 })]);
    void startGoalWork(keys[0]);
    await waitUntil(() => pending.length === 1);

    // shutdown(): isShuttingDown zuerst, dann abortAllClaudeCalls -> ABORT_REPLY
    shuttingDown = true;
    pending.shift()!({ text: "", aborted: true });
    await waitUntil(() => runningGoalLoopCount() === 0);
    // Keine weiteren Turns während des Herunterfahrens
    expect(prompts).toHaveLength(1);

    const saved = JSON.parse(await Bun.file(file).text())[keys[0]] as ActiveGoal;
    expect(saved).toMatchObject({ status: "active", turnsUsed: 2 });
    expect(saved.lastNote).toBeUndefined();

    // Neuer Prozess mit derselben Datei
    reopenStore(file);
    expect(await resumeActiveGoalsAfterStart()).toEqual([keys[0]]);
    await waitUntil(() => prompts.length === 2);
    expect(statuses.filter(s => s.message.kind === "resumed")).toHaveLength(1);
  });

  test("Shutdown während der Statusmeldung: kein Agentenaufruf, Ziel bleibt aktiv", async () => {
    const file = freshProcess([goal(keys[0], { topicId: 1, turnsUsed: 2 })]);
    let release!: () => void;
    turnGate = new Promise<void>(r => (release = r));
    void startGoalWork(keys[0]);
    await waitUntil(() => statuses.some(s => s.message.kind === "turn"));

    // shutdown() läuft durch, während die Meldung noch hängt; danach erst frei
    shuttingDown = true;
    release();
    await waitUntil(() => runningGoalLoopCount() === 0);
    expect(prompts).toEqual([]);
    expect(pending).toEqual([]);

    const saved = JSON.parse(await Bun.file(file).text())[keys[0]] as ActiveGoal;
    expect(saved).toMatchObject({ status: "active", turnsUsed: 2 });
  });

  test("echter /stop (kein Shutdown): Ziel wird pausiert und nach dem Start nicht fortgesetzt", async () => {
    const file = freshProcess([goal(keys[0], { topicId: 1 })]);
    void startGoalWork(keys[0]);
    await waitUntil(() => pending.length === 1);
    pending.shift()!({ text: "", aborted: true });
    await waitUntil(() => runningGoalLoopCount() === 0);

    const saved = JSON.parse(await Bun.file(file).text())[keys[0]] as ActiveGoal;
    expect(saved).toMatchObject({ status: "paused", lastNote: "Vom User gestoppt (/stop)" });

    reopenStore(file);
    expect(await resumeActiveGoalsAfterStart()).toEqual([]);
    expect(prompts).toHaveLength(1);
  });
});

describe("Shutdown-Abbruch des Judge ist kein Judge-Fehler", () => {
  const env = { judge: process.env.AUX_MODEL_JUDGE, key: process.env.OPENROUTER_API_KEY };
  const realFetch = globalThis.fetch;
  let judgeCalls = 0;
  let judgeRelease: (() => void) | null = null;
  /** true: der Judge-Aufruf endet wie nach abortAllClaudeCalls mit einem AbortError */
  let judgeAborts = false;

  beforeAll(() => {
    process.env.AUX_MODEL_JUDGE = "openrouter:test/judge";
    process.env.OPENROUTER_API_KEY = "test";
    globalThis.fetch = (async (url: string | URL) => {
      if (!String(url).includes("openrouter.ai")) return Response.json({ ok: true, result: {} });
      judgeCalls++;
      await new Promise<void>(r => (judgeRelease = r));
      if (judgeAborts) throw new DOMException("Abgebrochen", "AbortError");
      return new Response("Fehler", { status: 500 });
    }) as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
    if (env.judge === undefined) delete process.env.AUX_MODEL_JUDGE;
    else process.env.AUX_MODEL_JUDGE = env.judge;
    if (env.key === undefined) delete process.env.OPENROUTER_API_KEY;
    else process.env.OPENROUTER_API_KEY = env.key;
  });
  beforeEach(() => {
    judgeCalls = 0;
    judgeRelease = null;
    judgeAborts = false;
  });

  /** Turn liefert eine Antwort, der Judge hängt danach bis zur Freigabe */
  async function runUntilJudge(file: string): Promise<void> {
    void startGoalWork(keys[0]);
    await waitUntil(() => pending.length === 1);
    pending.shift()!({ text: "Zwischenstand", aborted: false });
    await waitUntil(() => judgeCalls === 1 && judgeRelease !== null);
    expect(JSON.parse(await Bun.file(file).text())[keys[0]]).toMatchObject({ turnsUsed: 3, judgeFailures: 1 });
  }

  test("laufender Judge, Shutdown bricht ab: Ziel bleibt aktiv, Zähler unverändert, Fortsetzung nach dem Start", async () => {
    const file = freshProcess([goal(keys[0], { topicId: 1, turnsUsed: 2, judgeFailures: 1 })]);
    await runUntilJudge(file);

    shuttingDown = true;
    judgeAborts = true;
    judgeRelease!();
    await waitUntil(() => runningGoalLoopCount() === 0);
    expect(prompts).toHaveLength(1);
    expect(statuses.some(s => s.message.kind === "judge-failed")).toBe(false);

    const saved = JSON.parse(await Bun.file(file).text())[keys[0]] as ActiveGoal;
    expect(saved).toMatchObject({ status: "active", turnsUsed: 3, judgeFailures: 1 });
    expect(saved.lastNote).toBeUndefined();

    reopenStore(file);
    expect(await resumeActiveGoalsAfterStart()).toEqual([keys[0]]);
    await waitUntil(() => prompts.length === 2);
    expect(prompts[1].prompt).toContain("Turn 4/10");
  });

  test("echter Judge-Fehler ohne Shutdown: zweiter Fehlschlag pausiert das Ziel wie bisher", async () => {
    const file = freshProcess([goal(keys[0], { topicId: 1, turnsUsed: 2, judgeFailures: 1 })]);
    await runUntilJudge(file);

    judgeRelease!();
    await waitUntil(() => runningGoalLoopCount() === 0);
    expect(statuses.some(s => s.message.kind === "judge-failed")).toBe(true);
    const saved = JSON.parse(await Bun.file(file).text())[keys[0]] as ActiveGoal;
    expect(saved).toMatchObject({ status: "paused", judgeFailures: 2, lastNote: "Judge mehrfach nicht erreichbar" });

    reopenStore(file);
    expect(await resumeActiveGoalsAfterStart()).toEqual([]);
  });
});

describe("Fortsetzen erst nach der Startbereitschaft", () => {
  test("verzögertes onStart: vorher keine Wiederaufnahme, danach genau eine", async () => {
    freshProcess([goal(keys[0], { topicId: 1 })]);
    const ready = Promise.withResolvers<void>();
    // Wie grammY: bot.start initialisiert asynchron (getMe, deleteWebhook) und ruft dann onStart
    const fakeStart = (opts: { onStart: () => void }) => void ready.promise.then(() => { opts.onStart(); opts.onStart(); });
    const resume = goalResumeOnStart();
    let resumeRuns: Promise<void>[] = [];
    fakeStart({ onStart: () => void resumeRuns.push(resume()) });

    await Bun.sleep(20);
    expect(statuses).toEqual([]);
    expect(prompts).toEqual([]);

    ready.resolve();
    await waitUntil(() => resumeRuns.length === 2);
    await Promise.all(resumeRuns);
    await waitUntil(() => prompts.length === 1);
    await Bun.sleep(20);
    expect(statuses.filter(s => s.message.kind === "resumed")).toHaveLength(1);
    expect(prompts).toHaveLength(1);
  });
});
