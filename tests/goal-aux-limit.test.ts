import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configureGoalStore, getGoal, GOAL_JUDGE_DISABLED_TEXT, initGoalEngine, setGoal, startGoalWork,
  updateGoal, type GoalStatusMessage,
} from "../src/lib/goal-engine";
import * as claudeModule from "../src/lib/claude";
import { setClaudeAvailability } from "../src/lib/claude-availability";
import { setSwitchStateFileForTests, updateSwitchState } from "../src/lib/engine-switch-state";
import { setSettingsPath } from "../src/lib/settings";

// Echter Richter über callAux; Arbeit und beide Modellwege sind Attrappen.
const KEY = "topic:-100:669";
const UNTIL = "2099-01-02T23:15:00.000Z";
const envNames = ["AUX_MODEL_JUDGE", "OPENROUTER_API_KEY", "FALLBACK_OFFLINE_ONLY", "USER_TIMEZONE"];
const savedEnv = new Map<string, string | undefined>();
const realFetch = globalThis.fetch;
let dir: string;
let claude: ReturnType<typeof spyOn>;
let log: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
let http: ReturnType<typeof mock>;
let turns: number;
let statuses: GoalStatusMessage[];

beforeEach(async () => {
  for (const name of envNames) {
    savedEnv.set(name, process.env[name]);
    delete process.env[name];
  }
  process.env.USER_TIMEZONE = "Asia/Tokyo";
  dir = mkdtempSync(join(tmpdir(), "tybo-goal-limit-"));
  const settings = join(dir, "settings.json");
  writeFileSync(settings, JSON.stringify({ engine: { backups: [{ engine: "codex" }] }, fallback: { openrouterModel: "test/richter" } }));
  setSettingsPath(settings);
  setSwitchStateFileForTests(join(dir, "switch.json"));
  await updateSwitchState(state => ({ ...state, blocks: [{
    engine: "claude", cause: "limit", window: "weekly_all", resetKnown: true,
    since: new Date().toISOString(), until: UNTIL,
  }] }));
  configureGoalStore({ file: join(dir, "goals.json") });
  turns = 0;
  statuses = [];
  initGoalEngine({
    callAgent: async () => {
      expect((await getGoal(KEY))?.status).toBe("active");
      turns++;
      return { text: "Ein Teil des Berichts ist fertig.", aborted: false };
    },
    sendAsAgent: async () => {},
    sendStatus: async (_target, message) => { statuses.push(message); },
    saveMessage: async () => true,
  });
  claude = spyOn(claudeModule, "callClaude").mockImplementation(async () => { throw new Error("Claude darf nicht laufen"); });
  log = spyOn(console, "log").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
  http = mock(async () => Response.json({ choices: [{ message: { content: JSON.stringify({
    verdict: turns < 2 ? "continue" : "done", reason: "Nächsten Abschnitt ergänzen",
  }) } }] }));
  globalThis.fetch = http as unknown as typeof fetch;
  await setGoal({ sessionKey: KEY, chatId: "-100", topicId: 669, agentName: "research", goal: "Bericht fertigstellen" });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [name, value] of savedEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  for (const spy of [claude, log, error]) spy.mockRestore();
  setSettingsPath();
  setSwitchStateFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

test.each(["ohne Schlüssel", "nur offline"])("Sperre %s: eine Pause pro Versuch mit Profilzeit, keine Judge-Fehler", async mode => {
  if (mode === "nur offline") {
    process.env.OPENROUTER_API_KEY = "test-nicht-echt";
    process.env.FALLBACK_OFFLINE_ONLY = "true";
  }
  for (let attempt = 1; attempt <= 2; attempt++) {
    await updateGoal(KEY, { status: "active" });
    await startGoalWork(KEY);
    // Erneuter Start eines schon pausierten Ziels meldet nichts und arbeitet nicht.
    await startGoalWork(KEY);
    expect(turns).toBe(attempt);
    const pauses = statuses.filter(message => message.kind === "judge-failed");
    expect(pauses).toHaveLength(attempt);
    expect(pauses[attempt - 1].text).toBe(
      "⚠️ Ziel pausiert: Der Richter von /goal läuft über Claude Code, und Claude Code ist bis Sa, 03.01., 08:15 am Limit. Abhilfe: ein anderes Nebenmodell für den Richter einstellen (WebUI, Modelle) oder nach dem Reset /goal weiter.",
    );
    expect(await getGoal(KEY)).toMatchObject({ status: "paused", judgeFailures: 0,
      lastNote: "Richter abgeschaltet (Claude Code am Limit bis Sa, 03.01., 08:15)" });
  }
  expect(claude).not.toHaveBeenCalled();
  expect(http).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});

test("mit Schlüssel urteilt OpenRouter und das Ziel arbeitet ohne Pause bis zum Abschluss", async () => {
  process.env.OPENROUTER_API_KEY = "test-nicht-echt";
  await startGoalWork(KEY);
  expect(turns).toBe(2);
  expect(http).toHaveBeenCalledTimes(2);
  for (const [url, init] of http.mock.calls) {
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(JSON.parse(init.body).model).toBe("test/richter");
  }
  expect(claude).not.toHaveBeenCalled();
  expect(statuses.filter(message => message.kind !== "turn").map(message => message.kind)).toEqual(["done"]);
  expect(await getGoal(KEY)).toBeUndefined();
  expect(error).not.toHaveBeenCalled();
});

test("fehlendes Claude behält trotz Sperre und Schlüssel den alten Pausentext", async () => {
  process.env.OPENROUTER_API_KEY = "test-nicht-echt";
  setClaudeAvailability({ state: "missing", reason: "nicht installiert" });
  await startGoalWork(KEY);
  expect(statuses.filter(message => message.kind === "judge-failed")).toEqual([{ kind: "judge-failed", text: GOAL_JUDGE_DISABLED_TEXT }]);
  expect(await getGoal(KEY)).toMatchObject({ status: "paused", judgeFailures: 0, lastNote: "Judge abgeschaltet (Claude fehlt)" });
  expect(turns).toBe(1);
  expect(http).not.toHaveBeenCalled();
  expect(claude).not.toHaveBeenCalled();
});

test("OpenRouter 402 zählt als Fehler und pausiert wie bisher erst nach zwei Versuchen", async () => {
  process.env.OPENROUTER_API_KEY = "test-nicht-echt";
  http.mockImplementation(async () => new Response("", { status: 402 }));
  await startGoalWork(KEY);
  expect(turns).toBe(2);
  expect(http).toHaveBeenCalledTimes(2);
  expect(claude).not.toHaveBeenCalled();
  expect(await getGoal(KEY)).toMatchObject({ status: "paused", judgeFailures: 2, lastNote: "Judge mehrfach nicht erreichbar" });
  expect(statuses.filter(message => message.kind === "judge-failed")).toEqual([{
    kind: "judge-failed", text: "⚠️ Ziel pausiert: Der Judge war 2x nicht erreichbar. Mit /goal weiter geht es weiter.",
  }]);
});

test("eine Sperre erhöht einen vorhandenen Judge-Fehler nicht", async () => {
  await updateGoal(KEY, { judgeFailures: 1 });
  await startGoalWork(KEY);
  expect(await getGoal(KEY)).toMatchObject({ status: "paused", judgeFailures: 1 });
  expect(turns).toBe(1);
});
