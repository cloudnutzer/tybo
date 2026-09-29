/**
 * Goal-Engine kanal-neutral (Issue #76): Statusmeldungen mit Art und
 * Knöpfen, Telegram-Ausgabe wie bisher, Änderungs-Ereignisse für die
 * Status-Karte, gemeinsame Aktionen für Knöpfe und Befehle.
 * Eigener Zustand in einem Temp-Verzeichnis, Judge per OpenRouter-Attrappe;
 * src/bot.ts wird nie geladen.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { InlineKeyboard } from "grammy";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  clearGoal,
  configureGoalStore,
  getGoal,
  initGoalEngine,
  isGoalLoopRunning,
  onGoalChange,
  pauseGoal,
  resumeGoalWork,
  setGoal,
  startGoalWork,
  updateGoal,
  type GoalChange,
  type GoalStatusMessage,
  type GoalTarget,
} from "../src/lib/goal-engine";
import { atomicWriteFile } from "../src/lib/atomic-file";
import { createTelegramGoalStatus, GOAL_CALLBACK_TEXT, goalKeyboard, handleGoalCallback, runGoalAction } from "../src/lib/goal-actions";

const dir = mkdtempSync(join(tmpdir(), "tybo-goal-channels-"));
const file = join(dir, "goals.json");
const env = { judge: process.env.AUX_MODEL_JUDGE, key: process.env.OPENROUTER_API_KEY };
const realFetch = globalThis.fetch;
let verdict = "continue";
/** Solange gesetzt, wartet der Judge darauf */
let judgeGate: Promise<void> | null = null;
let judgeCalls = 0;
/** Solange gesetzt, wartet die Meldung der Art statusGateKind darauf (Standard: Zwischenstand vor einem Turn) */
let statusGate: Promise<void> | null = null;
let statusGateKind: GoalStatusMessage["kind"] = "turn";
/** Solange gesetzt, wartet das nächste Speichern darauf (nur dieses eine) */
let writeGate: Promise<void> | null = null;
let writeHeld = false;

/** Offener Arbeits-Turn, den der Test beendet */
let pendingTurn: ((r: { text: string; aborted: boolean }) => void) | null = null;
let turns = 0;
const prompts: string[] = [];
const statuses: { target: GoalTarget; message: GoalStatusMessage }[] = [];
const agentPosts: string[] = [];
const changes: GoalChange[] = [];
let aborts: string[] = [];

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(2);
  }
}

beforeAll(() => {
  configureGoalStore({
    file,
    write: async (f, data) => {
      const gate = writeGate;
      if (gate) {
        writeGate = null;
        writeHeld = true;
        await gate;
      }
      await atomicWriteFile(f, data);
    },
  });
  process.env.AUX_MODEL_JUDGE = "openrouter:test/judge";
  process.env.OPENROUTER_API_KEY = "test";
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes("openrouter.ai")) {
      judgeCalls++;
      if (judgeGate) await judgeGate;
      return Response.json({ choices: [{ message: { content: JSON.stringify({ verdict, reason: "Befund" }) } }] });
    }
    return Response.json({ ok: true, result: {} });
  }) as typeof fetch;
  initGoalEngine({
    callAgent: prompt => {
      turns++;
      prompts.push(prompt);
      return new Promise(resolve => {
        pendingTurn = resolve;
      });
    },
    sendAsAgent: async (_agent, _chatId, text) => {
      agentPosts.push(text);
    },
    sendStatus: async (target, message) => {
      statuses.push({ target, message });
      if (message.kind === statusGateKind && statusGate) await statusGate;
    },
  });
  onGoalChange(c => changes.push(c));
});

afterAll(() => {
  globalThis.fetch = realFetch;
  if (env.judge === undefined) delete process.env.AUX_MODEL_JUDGE;
  else process.env.AUX_MODEL_JUDGE = env.judge;
  if (env.key === undefined) delete process.env.OPENROUTER_API_KEY;
  else process.env.OPENROUTER_API_KEY = env.key;
  rmSync(dir, { recursive: true, force: true });
});

let n = 0;
let key = "";
beforeEach(() => {
  key = `topic:-100:${++n}`;
  statuses.length = 0;
  agentPosts.length = 0;
  changes.length = 0;
  aborts = [];
  turns = 0;
  prompts.length = 0;
  pendingTurn = null;
  verdict = "continue";
  judgeGate = null;
  judgeCalls = 0;
  statusGate = null;
  statusGateKind = "turn";
  writeGate = null;
  writeHeld = false;
});
afterEach(async () => {
  // Offene Turns beenden, damit keine Schleife weiterläuft
  await clearGoal(key);
  pendingTurn?.({ text: "", aborted: true });
  await waitUntil(() => !isGoalLoopRunning(key));
});

const abort = (k: string) => {
  aborts.push(k);
  return 0;
};

async function newGoal(extra: Parameters<typeof updateGoal>[1] = {}) {
  await setGoal({ sessionKey: key, chatId: "-100", topicId: n, agentName: "research", goal: "Bericht schreiben" });
  if (Object.keys(extra).length) await updateGoal(key, extra);
  changes.length = 0;
}

describe("Statusmeldungen kanal-neutral", () => {
  test("Budget erreicht: Meldung mit Art und Ziel-Angaben samt Kennung, Knöpfe kommen aus der Rückfrage (Issue #118)", async () => {
    await newGoal({ turnsUsed: 3, maxTurns: 3 });
    const goalId = (await getGoal(key))!.createdAt;
    await startGoalWork(key);
    expect(statuses).toHaveLength(1);
    const { target, message } = statuses[0];
    expect(message).toEqual({ kind: "budget", text: '⏸️ Turn-Budget erreicht (3/3) fuer das Ziel:\n"Bericht schreiben"\n\nWeitermachen?' });
    expect(target).toMatchObject({ sessionKey: key, chatId: "-100", topicId: n, agentName: "research", createdAt: goalId });
    expect((await getGoal(key))?.status).toBe("paused");
  });

  test("Telegram: Knöpfe einer Meldung als dasselbe Inline-Keyboard wie mit grammY", () => {
    const rows = [[{ label: "A", action: "x|1" }, { label: "B", action: "x|2" }]];
    expect(JSON.stringify(goalKeyboard(rows))).toBe(JSON.stringify(new InlineKeyboard().text("A", "x|1").text("B", "x|2")));
  });

  test("Telegram-Ausgabe: Haupt-Bot wie bisher, festgehalten wird alles außer dem Zwischenstand; Budget-Frage über ask", async () => {
    const sent: unknown[][] = [];
    const recorded: string[] = [];
    const asked: [GoalTarget, string][] = [];
    const out = createTelegramGoalStatus({
      send: async (...args) => {
        sent.push(args);
      },
      record: async (_t, m) => {
        recorded.push(m.kind);
      },
      ask: async (t, text) => {
        asked.push([t, text]);
        return true;
      },
      noButtonsHint: "Hinweis",
    });
    const target: GoalTarget = { sessionKey: key, chatId: "-100", topicId: 7, agentName: "general", goal: "x", createdAt: 5 };
    await out(target, { kind: "turn", text: "🎯 Ziel-Turn 1/10: arbeite weiter..." });
    await out(target, { kind: "budget", text: "Budget" });
    await out({ ...target, topicId: undefined }, { kind: "done", text: "✅ fertig" });
    // Budget: weder send noch record, sendChoice hält die Frage selbst fest (sonst doppelt im Verlauf)
    expect(asked).toEqual([[target, "Budget"]]);
    expect(sent).toEqual([
      ["-100", "🎯 Ziel-Turn 1/10: arbeite weiter...", 7, undefined],
      ["-100", "✅ fertig", undefined, undefined],
    ]);
    expect(recorded).toEqual(["done"]);
  });

  for (const failure of ["false", "wirft", "fehlt"] as const) {
    test(`Budget-Frage nicht im Register (ask ${failure}): Meldung ohne Knöpfe mit Befehls-Hinweis, festgehalten`, async () => {
      const sent: unknown[][] = [];
      const recorded: string[] = [];
      const out = createTelegramGoalStatus({
        send: async (...args) => {
          sent.push(args);
        },
        record: async (_t, m) => {
          recorded.push(m.text);
        },
        ...(failure === "fehlt"
          ? {}
          : {
              ask: async () => {
                if (failure === "wirft") throw new Error("Register weg");
                return false;
              },
            }),
        noButtonsHint: "Hinweis",
      });
      const errors = spyOn(console, "error").mockImplementation(() => {});
      try {
        await out({ sessionKey: key, chatId: "-100", agentName: "general", goal: "x", createdAt: 5 }, { kind: "budget", text: "Budget" });
      } finally {
        errors.mockRestore();
      }
      expect(sent).toEqual([["-100", "Budget\n\nHinweis", undefined, undefined]]);
      expect(recorded).toEqual(["Budget\n\nHinweis"]);
    });
  }

  test("Festhalten scheitert: Telegram bleibt unberührt, kein Fehler nach außen", async () => {
    const sent: string[] = [];
    const out = createTelegramGoalStatus({
      send: async (_c, text) => {
        sent.push(text);
      },
      record: async () => {
        throw new Error("DB weg");
      },
    });
    await out({ sessionKey: key, chatId: "1", agentName: "general", goal: "x", createdAt: 1 }, { kind: "waiting", text: "wartet" });
    expect(sent).toEqual(["wartet"]);
  });

  test("Arbeits-Turn: Zwischenstand vor dem Turn, Antwort über den Agenten, Judge fertig: done-Meldung", async () => {
    await newGoal();
    verdict = "done";
    const run = startGoalWork(key);
    await waitUntil(() => !!pendingTurn);
    expect(statuses.map(s => s.message)).toEqual([{ kind: "turn", text: "🎯 Ziel-Turn 1/10: arbeite weiter..." }]);
    pendingTurn!({ text: "Bericht liegt vor", aborted: false });
    await run;
    expect(agentPosts).toEqual(["Bericht liegt vor"]);
    expect(statuses.map(s => s.message.kind)).toEqual(["turn", "done"]);
    expect(await getGoal(key)).toBeUndefined();
    expect(changes.find(c => c.ended)).toMatchObject({ sessionKey: key, goal: null, ended: "done" });
    expect(changes.at(-1)).toMatchObject({ goal: null, running: false });
  });
});

describe("Änderungs-Ereignisse für die Status-Karte", () => {
  test("setzen, Schleife läuft, Runde gezählt, Schleife endet", async () => {
    await setGoal({ sessionKey: key, chatId: "1", agentName: "general", goal: "Ziel A" });
    expect(changes.at(-1)).toMatchObject({ sessionKey: key, running: false, goal: { goal: "Ziel A", status: "active", turnsUsed: 0 } });
    const run = startGoalWork(key);
    await waitUntil(() => !!pendingTurn);
    expect(changes.some(c => c.running && c.goal?.goal === "Ziel A")).toBe(true);
    await pauseGoal(key, "Vom User pausiert");
    pendingTurn!({ text: "Zwischenstand", aborted: false });
    await run;
    expect(changes.some(c => c.goal?.turnsUsed === 1)).toBe(true);
    expect(changes.at(-1)).toMatchObject({ running: false, goal: { status: "paused" } });
  });

  test("Stopp: Ereignis ohne Ziel mit ended stopped; Ereignis ist eine Kopie", async () => {
    await newGoal();
    const seen = changes.length;
    await clearGoal(key);
    expect(changes.slice(seen)).toEqual([{ sessionKey: key, goal: null, running: false, ended: "stopped" }]);
    await newGoal();
    await updateGoal(key, { lastNote: "a" });
    const copy = changes.at(-1)!.goal!;
    copy.lastNote = "verändert";
    expect((await getGoal(key))?.lastNote).toBe("a");
  });

  test("Zustand landet in der eingestellten Datei, nicht in data/goals.json", async () => {
    await newGoal();
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk[key]?.goal).toBe("Bericht schreiben");
  });
});

describe("Gemeinsame Aktionen (Weiter-Semantik als Regressionstest)", () => {
  test("Weiter-Knopf am Budgetlimit: +5 Turns und die Arbeit läuft wieder", async () => {
    await newGoal({ turnsUsed: 10, maxTurns: 10, status: "paused" });
    const result = await runGoalAction(key, "more", { abort });
    expect(result.status).toBe("ok");
    const g = await getGoal(key);
    expect(g).toMatchObject({ status: "active", maxTurns: 15 });
    await waitUntil(() => !!pendingTurn);
    expect(turns).toBe(1);
  });

  test("Doppelklick auf Weiter: Budget nur einmal erhöht, nur eine Schleife", async () => {
    await newGoal({ turnsUsed: 10, maxTurns: 10, status: "paused" });
    const [a, b] = await Promise.all([runGoalAction(key, "more", { abort }), runGoalAction(key, "more", { abort })]);
    expect([a.status, b.status].sort()).toEqual(["active", "ok"]);
    expect((await getGoal(key))?.maxTurns).toBe(15);
    await waitUntil(() => !!pendingTurn);
    await Bun.sleep(20);
    expect(turns).toBe(1);
  });

  test("/goal weiter (resume) erhöht das Budget nicht", async () => {
    await newGoal({ turnsUsed: 2, maxTurns: 10, status: "paused" });
    expect((await runGoalAction(key, "resume", { abort })).status).toBe("ok");
    expect(await getGoal(key)).toMatchObject({ status: "active", maxTurns: 10 });
    await waitUntil(() => !!pendingTurn);
  });

  test("Pause lässt den laufenden Turn auslaufen, danach keine weitere Runde", async () => {
    await newGoal();
    const run = startGoalWork(key);
    await waitUntil(() => !!pendingTurn);
    expect((await runGoalAction(key, "pause", { abort })).status).toBe("ok");
    expect(aborts).toEqual([]);
    pendingTurn!({ text: "Turn fertig", aborted: false });
    await run;
    expect(agentPosts).toEqual(["Turn fertig"]);
    expect(turns).toBe(1);
    expect(await getGoal(key)).toMatchObject({ status: "paused", turnsUsed: 1, lastNote: "Befund" });
  });

  test("Stopp während eines Turns: Ziel gelöscht, Abbruch angefordert, verspätetes Ergebnis ändert nichts", async () => {
    await newGoal();
    const run = startGoalWork(key);
    await waitUntil(() => !!pendingTurn);
    const result = await runGoalAction(key, "stop", { abort });
    expect(result).toMatchObject({ status: "ok", goal: { goal: "Bericht schreiben" } });
    expect(aborts).toEqual([key]);
    pendingTurn!({ text: "", aborted: true });
    await run;
    expect(await getGoal(key)).toBeUndefined();
    expect(agentPosts).toEqual([]);
  });

  test("Stopp, danach kommt doch noch eine normale Antwort: verworfen, ohne TypeError", async () => {
    await newGoal();
    const run = startGoalWork(key);
    await waitUntil(() => !!pendingTurn);
    expect((await runGoalAction(key, "stop", { abort })).status).toBe("ok");
    pendingTurn!({ text: "Späte Antwort", aborted: false });
    // Früher: updateGoal lieferte undefined, danach TypeError beim Senden
    await run;
    expect(agentPosts).toEqual([]);
    expect(judgeCalls).toBe(0);
    expect(await getGoal(key)).toBeUndefined();
    expect(statuses.map(s => s.message.kind)).toEqual(["turn"]);
  });

  test("Ziel ersetzt, während der Agent arbeitet: alte Antwort verworfen, der Nachfolger bekommt eine eigene Runde", async () => {
    await newGoal();
    const oldId = (await getGoal(key))!.createdAt;
    const run = startGoalWork(key);
    await waitUntil(() => !!pendingTurn);
    const first = pendingTurn!;
    pendingTurn = null;
    await setGoal({ sessionKey: key, chatId: "-100", topicId: n, agentName: "research", goal: "Neues Ziel" });
    const newId = (await getGoal(key))!.createdAt;
    expect(newId).not.toBe(oldId);
    first({ text: "Alte Antwort", aborted: false });
    await waitUntil(() => !!pendingTurn);
    expect(agentPosts).toEqual([]);
    expect(judgeCalls).toBe(0);
    expect(await getGoal(key)).toMatchObject({ createdAt: newId, goal: "Neues Ziel", status: "active", turnsUsed: 0 });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Aktives Ziel: Neues Ziel");
    pendingTurn!({ text: "", aborted: true });
    await run;
  });

  test("Stopp, Nachfolger während des Speicherns der Löschung: der Abbruch trifft nur die alte Arbeit", async () => {
    // Abbruch wie abortEngineCalls: beendet den Agentenaufruf, der gerade läuft
    const liveAbort = (k: string) => {
      aborts.push(k);
      const running = pendingTurn;
      pendingTurn = null;
      running?.({ text: "", aborted: true });
      return running ? 1 : 0;
    };
    await newGoal();
    const oldId = (await getGoal(key))!.createdAt;
    const run = startGoalWork(key);
    await waitUntil(() => !!pendingTurn);
    const lateA = pendingTurn!;
    let releaseWrite!: () => void;
    writeGate = new Promise(resolve => (releaseWrite = resolve));
    const stopping = runGoalAction(key, "stop", { abort: liveAbort, goalId: oldId });
    await waitUntil(() => writeHeld);
    // Nachfolger wie /goal <text>: setzen, Arbeit anstoßen
    await setGoal({ sessionKey: key, chatId: "-100", topicId: n, agentName: "research", goal: "Neues Ziel" });
    const newId = (await getGoal(key))!.createdAt;
    void startGoalWork(key);
    lateA({ text: "Alte Antwort", aborted: false });
    await waitUntil(() => prompts.some(p => p.includes("Aktives Ziel: Neues Ziel")) && !!pendingTurn);
    releaseWrite();
    expect((await stopping).status).toBe("ok");
    await Bun.sleep(20);
    expect(aborts).toEqual([key]);
    expect(await getGoal(key)).toMatchObject({ createdAt: newId, goal: "Neues Ziel", status: "active" });
    expect(pendingTurn).not.toBeNull();
    expect(isGoalLoopRunning(key)).toBe(true);
    expect(agentPosts).toEqual([]);
    pendingTurn!({ text: "", aborted: true });
    await run;
  });

  describe("Änderung, während der Zwischenstand vor dem Turn gesendet wird", () => {
    /** Startet die Arbeit und hält sie im Versand des Zwischenstands fest */
    async function holdInStatus() {
      let release!: () => void;
      statusGate = new Promise(resolve => (release = resolve));
      await newGoal();
      const oldId = (await getGoal(key))!.createdAt;
      const run = startGoalWork(key);
      await waitUntil(() => statuses.some(s => s.message.kind === "turn"));
      return { run, oldId, release };
    }

    test("Stopp: kein Agentenaufruf mehr für das alte Ziel", async () => {
      const { run, release } = await holdInStatus();
      expect((await runGoalAction(key, "stop", { abort })).status).toBe("ok");
      release();
      await run;
      expect(turns).toBe(0);
      expect(await getGoal(key)).toBeUndefined();
      expect(agentPosts).toEqual([]);
    });

    test("Pause: kein Agentenaufruf, das Ziel bleibt pausiert", async () => {
      const { run, release } = await holdInStatus();
      expect((await runGoalAction(key, "pause", { abort })).status).toBe("ok");
      release();
      await run;
      expect(turns).toBe(0);
      expect(await getGoal(key)).toMatchObject({ status: "paused", turnsUsed: 0 });
    });

    test("Zielwechsel: die alte Arbeit startet nicht, nur der Nachfolger bekommt eine Runde", async () => {
      const { run, oldId, release } = await holdInStatus();
      await setGoal({ sessionKey: key, chatId: "-100", topicId: n, agentName: "research", goal: "Neues Ziel" });
      const newId = (await getGoal(key))!.createdAt;
      expect(newId).not.toBe(oldId);
      statusGate = null;
      release();
      await waitUntil(() => !!pendingTurn);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain("Aktives Ziel: Neues Ziel");
      pendingTurn!({ text: "", aborted: true });
      await run;
    });
  });

  describe("Fortsetzen, während die Pausen-Meldung noch gesendet wird", () => {
    /** Hält die Schleife im Versand der Meldung kind fest */
    function holdStatus(kind: GoalStatusMessage["kind"]) {
      let release!: () => void;
      statusGate = new Promise(resolve => (release = resolve));
      statusGateKind = kind;
      return () => release();
    }

    test("Budget-Meldung, Weiter (+5): genau eine weitere Runde, Budget genau einmal erhöht", async () => {
      await newGoal({ turnsUsed: 10, maxTurns: 10 });
      const release = holdStatus("budget");
      const run = startGoalWork(key);
      await waitUntil(() => statuses.some(s => s.message.kind === "budget"));
      expect((await getGoal(key))?.status).toBe("paused");
      expect((await runGoalAction(key, "more", { abort })).status).toBe("ok");
      release();
      await waitUntil(() => !!pendingTurn);
      await Bun.sleep(20);
      expect(turns).toBe(1);
      expect(await getGoal(key)).toMatchObject({ status: "active", maxTurns: 15, turnsUsed: 10 });
      expect(isGoalLoopRunning(key)).toBe(true);
      pendingTurn!({ text: "", aborted: true });
      await run;
      expect(turns).toBe(1);
      expect((await getGoal(key))?.maxTurns).toBe(15);
    });

    for (const action of ["resume", "more"] as const) {
      test(`Warte-Meldung, ${action === "resume" ? "/goal weiter" : "Weiter (+5)"}: genau eine weitere Runde`, async () => {
        verdict = "wait";
        await newGoal({ maxTurns: 10 });
        const release = holdStatus("waiting");
        const run = startGoalWork(key);
        await waitUntil(() => !!pendingTurn);
        const first = pendingTurn!;
        pendingTurn = null;
        first({ text: "Brauche Freigabe", aborted: false });
        await waitUntil(() => statuses.some(s => s.message.kind === "waiting"));
        expect((await getGoal(key))?.status).toBe("paused");
        expect((await runGoalAction(key, action, { abort })).status).toBe("ok");
        release();
        await waitUntil(() => !!pendingTurn);
        await Bun.sleep(20);
        expect(turns).toBe(2);
        expect(await getGoal(key)).toMatchObject({ status: "active", turnsUsed: 1, maxTurns: action === "more" ? 15 : 10 });
        pendingTurn!({ text: "", aborted: true });
        await run;
        expect(turns).toBe(2);
      });
    }
  });

  for (const judged of ["done", "wait", "continue"]) {
    test(`Ziel ersetzt, während der Judge urteilt (${judged}): das Urteil trifft den Nachfolger nicht`, async () => {
      verdict = judged;
      let releaseJudge!: () => void;
      judgeGate = new Promise(resolve => (releaseJudge = resolve));
      await newGoal();
      const run = startGoalWork(key);
      await waitUntil(() => !!pendingTurn);
      const first = pendingTurn!;
      pendingTurn = null;
      first({ text: "Fertig", aborted: false });
      await waitUntil(() => judgeCalls === 1);
      await setGoal({ sessionKey: key, chatId: "-100", topicId: n, agentName: "research", goal: "Neues Ziel" });
      const newId = (await getGoal(key))!.createdAt;
      releaseJudge();
      // Der Nachfolger wird danach ganz normal bearbeitet
      await waitUntil(() => !!pendingTurn);
      expect(await getGoal(key)).toMatchObject({ createdAt: newId, goal: "Neues Ziel", status: "active", turnsUsed: 0, judgeFailures: 0 });
      expect((await getGoal(key))!.lastNote).toBeUndefined();
      expect(statuses.some(s => s.message.kind === "done" || s.message.kind === "waiting")).toBe(false);
      expect(agentPosts).toEqual(["Fertig"]);
      pendingTurn!({ text: "", aborted: true });
      await run;
    });
  }

  for (const action of ["pause", "stop"] as const) {
    test(`Ziel zwischen Knopfprüfung und Änderung ersetzt (${action}): der Nachfolger bleibt unberührt`, async () => {
      const outcomes = new Set<string>();
      // Jeder Versatz ist deterministisch; zusammen decken sie das Fenster zwischen Prüfung und Änderung ab
      for (let ticks = 0; ticks < 12; ticks++) {
        await newGoal();
        const oldId = (await getGoal(key))!.createdAt;
        const pending = runGoalAction(key, action, { abort, goalId: oldId });
        for (let i = 0; i < ticks; i++) await Promise.resolve();
        const successor = setGoal({ sessionKey: key, chatId: "-100", topicId: n, agentName: "research", goal: `Nachfolger ${ticks}` });
        const result = await pending;
        const newId = (await successor).createdAt;
        outcomes.add(result.status);
        if (result.status === "ok") expect(result.goal.createdAt).toBe(oldId);
        const g = await getGoal(key);
        expect(g).toMatchObject({ createdAt: newId, goal: `Nachfolger ${ticks}`, status: "active" });
        expect(g!.lastNote).toBeUndefined();
      }
      // Beide Fälle kamen vor: Änderung vor dem Austausch und Austausch nach der Prüfung
      expect([...outcomes].sort()).toEqual(["missing", "ok"]);
      expect(turns).toBe(0);
    });
  }

  test("Fortsetzen nur für das Ziel des Knopfes: ein pausierter Nachfolger bleibt pausiert", async () => {
    await newGoal({ status: "paused" });
    const oldId = (await getGoal(key))!.createdAt;
    await setGoal({ sessionKey: key, chatId: "-100", topicId: n, agentName: "research", goal: "Nachfolger" });
    await updateGoal(key, { status: "paused" });
    expect(await resumeGoalWork(key, 0, oldId)).toBe(false);
    expect((await runGoalAction(key, "resume", { abort, goalId: oldId })).status).toBe("missing");
    expect(await getGoal(key)).toMatchObject({ goal: "Nachfolger", status: "paused" });
    await Bun.sleep(10);
    expect(turns).toBe(0);
  });

  test("Knopf eines früheren Ziels (andere goalId) bewirkt nichts", async () => {
    await newGoal({ status: "paused" });
    const old = (await getGoal(key))!.createdAt - 1;
    expect((await runGoalAction(key, "pause", { abort, goalId: old })).status).toBe("missing");
    expect((await runGoalAction(key, "stop", { abort, goalId: old })).status).toBe("missing");
    expect(await getGoal(key)).toBeDefined();
  });
});

describe("Telegram-Knöpfe über dieselben Aktionen (injizierbarer Adapter)", () => {
  test("goalkb|more: Text wie bisher, Budget +5", async () => {
    await newGoal({ turnsUsed: 10, maxTurns: 10, status: "paused" });
    expect(await handleGoalCallback(`goalkb|more|${key}`, { abort })).toBe("▶️ Weiter (+5 Turns).");
    expect((await getGoal(key))?.maxTurns).toBe(15);
    await waitUntil(() => !!pendingTurn);
    // Zweiter Druck auf den alten Knopf: keine zweite Erhöhung
    expect(await handleGoalCallback(`goalkb|more|${key}`, { abort })).toBe(GOAL_CALLBACK_TEXT.alreadyActive);
    expect((await getGoal(key))?.maxTurns).toBe(15);
  });

  test("goalkb|stop: Text wie bisher, Ziel weg; ohne Ziel „Kein Ziel mehr aktiv.“", async () => {
    await newGoal({ status: "paused" });
    expect(await handleGoalCallback(`goalkb|stop|${key}`, { abort })).toBe('🛑 Ziel beendet: "Bericht schreiben"');
    expect(await getGoal(key)).toBeUndefined();
    expect(await handleGoalCallback(`goalkb|stop|${key}`, { abort })).toBe("Kein Ziel mehr aktiv.");
    expect(await handleGoalCallback(`goalkb|more|${key}`, { abort })).toBe("Kein Ziel mehr aktiv.");
  });

  test("andere Knöpfe gehören nicht der Goal-Engine", async () => {
    expect(await handleGoalCallback("rev|yes|1", { abort })).toBeNull();
  });
});
