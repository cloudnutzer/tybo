/**
 * Issue #566, Aufgabe 3: fehlt Claude Code (Server nur mit Codex), sind die
 * Nebenaufgaben auf Claude abgeschaltet statt bei jeder Antwort zu
 * scheitern, beim Start steht genau eine Logzeile, und die Job-Regel fehlt im
 * Prompt. Nebenaufgaben auf OpenRouter oder Ollama laufen weiter.
 *
 * Alles gegen Attrappen: die Prüfung beim Start bekommt ein festes
 * Ergebnis, OpenRouter ist eine Fetch-Attrappe, CLAUDE_PATH zeigt auf einen
 * Pfad, den es nicht gibt (ein Aufruf von Claude endete dort ohne disabled).
 * Kein Test startet Claude, Codex oder den Bot.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentConfig } from "../src/agents/base";
import { createAgent, setAgentCatalogPaths } from "../src/agents/catalog";
import { JOB_RULES, NO_JOBS_RULE, withoutJobRule } from "../src/agents/prompt-parts";
import { checkClaudeBeforeWork, startBackground, type BackgroundServices } from "../src/app/bot-start";
import { setSpawnForTests } from "../src/lib/claude";
import { auxDisabled, callAux } from "../src/lib/aux-model";
import { AUX_PURPOSES, auxEnvName } from "../src/lib/aux-targets";
import {
  auxPlan,
  availabilityFromStatus,
  checkClaudeAtStart,
  CLAUDE_NOT_INSTALLED,
  claudeAvailability,
  claudeMissing,
  claudeMissingLogLine,
  resetClaudeAvailabilityForTests,
  setClaudeAvailability,
} from "../src/lib/claude-availability";
import { createBotNotices } from "../src/lib/bot-notices";
import type { EngineStatus } from "../src/lib/engines/check";
import {
  configureGoalStore,
  getGoal,
  GOAL_JUDGE_DISABLED_TEXT,
  initGoalEngine,
  setGoal,
  startGoalWork,
  type GoalStatusMessage,
} from "../src/lib/goal-engine";
import { setSettingsPath } from "../src/lib/settings";
import { detectThread } from "../src/lib/threads/detect";
import { resolveThreads } from "../src/lib/threads/resolve";

const dir = mkdtempSync(join(tmpdir(), "tybo-claude-missing-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const MISSING: EngineStatus = { engine: "claude", checked: true, installed: false, loggedIn: false, message: CLAUDE_NOT_INSTALLED };
/** installed=false ohne gesicherte Abwesenheit: Zeitlimit, Exit-Code, gescheiterte Prüfung */
const UNCLEAR: EngineStatus[] = [
  { engine: "claude", checked: true, installed: false, loggedIn: false, message: "Claude Code antwortet nicht: claude --version brauchte länger als 5 s" },
  { engine: "claude", checked: true, installed: false, loggedIn: false, message: "Claude Code startet nicht: claude --version endete mit Exit-Code 1" },
  { engine: "claude", checked: true, installed: false, loggedIn: false, message: "Claude Code ließ sich nicht prüfen" },
];
const LOGGED_OUT: EngineStatus = { engine: "claude", checked: true, installed: true, loggedIn: false, message: "nicht angemeldet" };
const UNKNOWN: EngineStatus = { engine: "claude", checked: true, installed: true, loggedIn: false, loginUnknown: true };
const READY: EngineStatus = { engine: "claude", checked: true, installed: true, loggedIn: true };

const SAVED_ENV = new Map<string, string | undefined>();
const ENV_NAMES = [...AUX_PURPOSES.map(auxEnvName), "OPENROUTER_API_KEY", "CLAUDE_PATH"];
const realFetch = globalThis.fetch;
let settingsNo = 0;

function useSettings(content: object = {}) {
  const file = join(dir, `settings-${++settingsNo}.json`);
  writeFileSync(file, JSON.stringify(content));
  setSettingsPath(file);
}

beforeEach(() => {
  for (const n of ENV_NAMES) {
    SAVED_ENV.set(n, process.env[n]);
    delete process.env[n];
  }
  // Ein Aufruf der Claude CLI landete hier und scheiterte ohne disabled
  process.env.CLAUDE_PATH = join(dir, "gibt-es-nicht", "claude");
  useSettings();
});
afterEach(() => {
  for (const [n, v] of SAVED_ENV) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
  globalThis.fetch = realFetch;
  setSettingsPath();
  resetClaudeAvailabilityForTests();
});

describe("Prüfung beim Start", () => {
  test("nicht installiert oder ausdrücklich nicht angemeldet heißt fehlt; unbekannte Anmeldung nicht", () => {
    expect(availabilityFromStatus(MISSING).state).toBe("missing");
    for (const status of UNCLEAR) expect(availabilityFromStatus(status).state).toBe("unclear");
    expect(availabilityFromStatus(LOGGED_OUT).state).toBe("missing");
    expect(availabilityFromStatus(UNKNOWN).state).toBe("ready");
    expect(availabilityFromStatus(READY).state).toBe("ready");
  });

  test("Claude fehlt, nichts anderes eingestellt: genau eine Logzeile, alle acht Nebenaufgaben abgeschaltet", async () => {
    const lines: string[] = [];
    await checkClaudeAtStart({ inspect: async () => MISSING, getSettings: () => ({}), env: () => ({}), log: l => lines.push(l) });
    expect(claudeMissing()).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("[Claude] Claude CLI nicht installiert: Hintergrund-Jobs sind abgeschaltet.");
    expect(lines[0]).toContain(
      "Abgeschaltet, weil sie über Claude liefen: Richter von /goal, Destillat, Review, offene Fäden, Anruf-Zusammenfassung, Check-in, Auswertung von Übungsgesprächen, Wizard für Sprachagenten.",
    );
    expect(lines[0]).not.toContain("Laufen weiter");
  });

  test("Claude bereit oder Prüfung scheitert: keine Zeile, nichts abgeschaltet", async () => {
    const lines: string[] = [];
    await checkClaudeAtStart({ inspect: async () => READY, getSettings: () => ({}), env: () => ({}), log: l => lines.push(l) });
    expect(claudeAvailability().state).toBe("ready");
    setClaudeAvailability({ state: "unknown" });
    await checkClaudeAtStart({ inspect: async () => Promise.reject(new Error("kaputt")), getSettings: () => ({}), env: () => ({}), log: l => lines.push(l) });
    expect(claudeAvailability().state).toBe("unknown");
    expect(lines).toEqual([]);
  });

  test("je tatsächlich aufgelöstem Ziel: Einstellungen vor AUX_MODEL_*, ungültig zählt wie keiner, fehlender Schlüssel wird genannt", () => {
    const plan = auxPlan(
      { aux: { judge: "ollama:qwen3:8b" } },
      { AUX_MODEL_JUDGE: "openrouter:a/b", AUX_MODEL_REVIEW: "openrouter:a/b", AUX_MODEL_THREADS: "kaputt", OPENROUTER_API_KEY: "" },
    );
    expect(plan.elsewhere.map(e => [e.purpose, e.target.kind, !!e.missingKey])).toEqual([
      ["judge", "ollama", false],
      ["review", "openrouter", true],
    ]);
    expect(plan.onClaude).toContain("threads");
    const line = claudeMissingLogLine("Claude nicht angemeldet", plan);
    expect(line).toContain("Laufen weiter: Richter von /goal (Ollama).");
    expect(line).toContain("Auf OpenRouter eingestellt, aber OPENROUTER_API_KEY fehlt: Review.");
    expect(line).not.toMatch(/Abgeschaltet[^.]*Richter/);
  });

  test("startBackground prüft nicht mehr selbst; checkClaudeBeforeWork prüft genau einmal und schreibt die Zeile als Warnung", async () => {
    const lines: string[] = [];
    let inspected = 0;
    const services: Partial<BackgroundServices> = {
      inspectClaude: async () => (inspected++, MISSING),
      getSettings: () => ({}),
      probeSchema: async () => null,
      checkEmbedding: async () => null as never,
      drainEmbeddings: async () => null as never,
      syncChunks: async () => null,
      rotateLogs: async () => {},
      recoverJobs: async () => ({ aborted: [], resent: [] }) as never,
      watchDeps: (() => ({ send: async () => ({ sent: true, recorded: true }) })) as never,
      startRoutineWatch: (() => ({})) as never,
      startThreadReminders: (() => ({})) as never,
      startReminderPlanner: (() => ({})) as never,
      every: () => {},
      log: l => void lines.push(l),
      warn: l => void lines.push(`WARN ${l}`),
      error: l => void lines.push(`ERROR ${l}`),
    };
    const bg = startBackground({
      root: dir,
      env: {},
      notices: createBotNotices({ telegram: () => false, send: async () => ({ ok: true }) as never, sendStatusMessage: async () => {}, dmChatId: () => "" }),
      choices: { sweep: async () => [] } as never,
      routineChoices: { offerMenu: async () => ({ status: "none" }) } as never,
      postWeb: async () => false,
      refresh: async () => [],
      services,
    });
    await bg.firstSweep;
    await Bun.sleep(5);
    expect(inspected).toBe(0);
    expect((await checkClaudeBeforeWork({}, services)).state).toBe("missing");
    expect(inspected).toBe(1);
    expect(lines.filter(l => l.startsWith("WARN [Claude]"))).toHaveLength(1);
    expect(claudeMissing()).toBe(true);
  });

  test("checkClaudeBeforeWork wirft nie: scheitert die Prüfung, bleibt der Zustand", async () => {
    expect((await checkClaudeBeforeWork({}, { inspectClaude: async () => Promise.reject(new Error("kaputt")), getSettings: () => ({}), warn: () => {} })).state).toBe("unknown");
    expect(claudeMissing()).toBe(false);
  });
});

describe("Startreihenfolge (Prüfung des Prüfers): verzögerte Prüfung", () => {
  beforeEach(() => {
    const catalogDir = mkdtempSync(join(dir, "katalog-start-"));
    setAgentCatalogPaths({ file: join(catalogDir, "agents.json"), backupDir: join(catalogDir, "backups"), topicsFile: join(catalogDir, "topics.json") });
  });
  afterEach(() => setAgentCatalogPaths());

  test("schon die erste Arbeit ohne Claude: kein Modellaufruf, keine Job-Empfehlung", async () => {
    let finish!: (s: EngineStatus) => void;
    const delayed = new Promise<EngineStatus>(resolve => (finish = resolve));
    const spawns: unknown[] = [];
    setSpawnForTests(((...args: unknown[]) => {
      spawns.push(args);
      throw new Error("kein echter Claude-Aufruf im Test");
    }) as never);
    try {
      const warnings: string[] = [];
      // Wie src/bot.ts: Prüfung starten; sie hängt, bis die Attrappe antwortet
      const check = checkClaudeBeforeWork({}, { inspectClaude: () => delayed, getSettings: () => ({}), warn: l => void warnings.push(l) });
      // Eine Nebenaufgabe, die während der Prüfung startet (etwa ein Fäden-Turn), wartet auf das Ergebnis
      let auxDone = false;
      const aux = callAux("threads", "Frage?", { quiet: true }).then(r => ((auxDone = true), r));
      await Bun.sleep(20);
      expect(auxDone).toBe(false);
      expect(spawns).toEqual([]);
      finish(MISSING);
      expect(await aux).toEqual({ text: "", isError: true, disabled: true });
      expect((await check).state).toBe("missing");
      // Erste Antwort danach: keine Job-Empfehlung im Prompt
      const prompt = getAgentConfig("general").systemPrompt;
      expect(prompt).not.toContain("bun run job start --title");
      expect(prompt).toContain(NO_JOBS_RULE);
      expect(spawns).toEqual([]);
      expect(warnings.filter(l => l.startsWith("[Claude]"))).toHaveLength(1);
    } finally {
      setSpawnForTests(null);
    }
  });

  test("src/bot.ts wartet auf die Prüfung, bevor Anrufe, Übungsgespräche, Health-Port, WebUI, Ziele, Hintergrunddienste und Polling anlaufen", () => {
    // Nur gelesen, nie importiert (würde mit dem Telegram-Token pollen)
    const source = readFileSync(join(import.meta.dir, "..", "src", "bot.ts"), "utf8");
    const at = (needle: string) => {
      const index = source.indexOf(needle);
      expect(index).toBeGreaterThan(-1);
      return index;
    };
    const check = at("await checkClaudeBeforeWork(env);");
    for (const later of ["wireBotChoices({", "startHealthServer({", "await startBotWeb({", "initGoalEngine({", "startBackground({", "goalResumeOnStart()", "startAfterFirstSweep("]) {
      expect(at(later)).toBeGreaterThan(check);
    }
    // Die Wiederaufnahme von Anrufen und Übungsgesprächen hängt an wireBotChoices
    const choicesSource = readFileSync(join(import.meta.dir, "..", "src", "app", "bot-choices.ts"), "utf8");
    expect(choicesSource).toContain("install.resumeCalls(phone)");
    expect(choicesSource).toContain("install.resumeAftercall(aftercall)");
    expect(source).not.toContain("void checkClaudeBeforeWork");
  });
});

describe("callAux ohne Claude", () => {
  test("Claude-Ziel: abgeschaltet, ohne Aufruf; unbekannter Zustand ruft wie bisher", async () => {
    setClaudeAvailability({ state: "missing", reason: "Claude CLI nicht installiert" });
    const started = Date.now();
    expect(await callAux("threads", "Frage?", { quiet: true })).toEqual({ text: "", isError: true, disabled: true });
    expect(Date.now() - started).toBeLessThan(500);
    expect(auxDisabled("threads")).toBe(true);
    // Resume geht immer über Claude: auch mit OpenRouter für distill abgeschaltet
    process.env.AUX_MODEL_DISTILL = "openrouter:a/b";
    expect(auxDisabled("distill")).toBe(false);
    expect(auxDisabled("distill", true)).toBe(true);
    expect((await callAux("distill", "x", { resumeSessionId: "s1", quiet: true })).disabled).toBe(true);
  });

  test("OpenRouter-Ziel läuft weiter, auch wenn Claude fehlt", async () => {
    setClaudeAvailability({ state: "missing", reason: "Claude nicht angemeldet" });
    process.env.AUX_MODEL_REVIEW = "openrouter:anbieter/modell";
    process.env.OPENROUTER_API_KEY = "test-schluessel";
    const urls: string[] = [];
    globalThis.fetch = (async (url: string | URL) => {
      urls.push(String(url));
      return Response.json({ choices: [{ message: { content: "Antwort vom Nebenmodell" } }] });
    }) as unknown as typeof fetch;
    expect(await callAux("review", "Prüfe das", { quiet: true })).toEqual({ text: "Antwort vom Nebenmodell", isError: false });
    expect(urls).toEqual(["https://openrouter.ai/api/v1/chat/completions"]);
    expect(auxDisabled("review")).toBe(false);
  });

  test("settings.json hat Vorrang: aux.checkin auf Ollama läuft, AUX_MODEL_CHECKIN=claude wäre abgeschaltet", async () => {
    setClaudeAvailability({ state: "missing", reason: "Claude nicht angemeldet" });
    process.env.AUX_MODEL_CHECKIN = "claude:claude-haiku-5-5";
    useSettings({ aux: { checkin: "ollama:qwen3:8b" } });
    expect(auxDisabled("checkin")).toBe(false);
    useSettings({});
    expect(auxDisabled("checkin")).toBe(true);
  });
});

describe("Aufrufer behandeln „abgeschaltet“ ohne Fehler und ohne Wiederholung", () => {
  test("offene Fäden: Erkennung und Auflösung melden disabled, keine Logzeile", async () => {
    const logs: string[] = [];
    let calls = 0;
    const off = async () => (calls++, { text: "", isError: true, disabled: true as const });
    const conversation = { type: "web" as const, conversationId: "0f1e2d3c-4b5a-4c6d-8e7f-001122334455" };
    const detect = await detectThread(
      { conversation, userText: "Hallo", reply: "Willst du nach Hamburg oder nach München fahren?", turnStartedAt: 0 },
      { callAux: off, listChoices: async () => [], pendingAskUser: async () => [], now: () => new Date(), timeZone: () => "Europe/Berlin", env: {}, log: m => logs.push(m) },
    );
    expect(detect).toEqual({ status: "disabled" });
    const resolved = await resolveThreads(
      { conversation, userText: "München", reply: "Gut." },
      {
        callAux: off,
        listOpenThreads: async () => [{ id: "f1", nr: 1, topic: "Reise", question: "Hamburg oder München?", context: "", createdAt: new Date().toISOString() }] as never,
        env: {},
        log: m => logs.push(m),
      },
    );
    expect(resolved).toEqual({ status: "disabled" });
    expect(calls).toBe(2);
    expect(logs).toEqual([]);
  });

  test("/goal: Richter abgeschaltet pausiert das Ziel sofort mit Grund, kein zweiter Richter-Aufruf", async () => {
    setClaudeAvailability({ state: "missing", reason: "Claude CLI nicht installiert" });
    configureGoalStore({ file: join(dir, "goals.json") });
    const statuses: GoalStatusMessage[] = [];
    let turns = 0;
    initGoalEngine({
      callAgent: async () => (turns++, { text: "Ich habe den ersten Teil des Berichts geschrieben." }),
      sendAsAgent: async () => {},
      sendStatus: async (_t, m) => void statuses.push(m),
      saveMessage: async () => true,
    });
    const key = "topic:-100:566";
    await setGoal({ sessionKey: key, chatId: "-100", topicId: 566, agentName: "research", goal: "Bericht fertig" });
    await startGoalWork(key);
    expect(turns).toBe(1);
    expect(statuses.map(s => s.text)).toContain(GOAL_JUDGE_DISABLED_TEXT);
    expect(statuses.filter(s => s.kind === "judge-failed")).toHaveLength(1);
    const g = await getGoal(key);
    expect(g?.status).toBe("paused");
    expect(g?.judgeFailures).toBe(0);
  });
});

describe("Job-Regel im Prompt", () => {
  let catalogDir: string;
  beforeEach(() => {
    catalogDir = mkdtempSync(join(dir, "katalog-"));
    setAgentCatalogPaths({ file: join(catalogDir, "agents.json"), backupDir: join(catalogDir, "backups"), topicsFile: join(catalogDir, "topics.json") });
  });
  afterEach(() => setAgentCatalogPaths());

  test("withoutJobRule ersetzt genau die Job-Regel", () => {
    const prompt = `Anfang\n${JOB_RULES}\nEnde`;
    expect(withoutJobRule(prompt)).toBe(`Anfang\n${NO_JOBS_RULE}\nEnde`);
    expect(withoutJobRule("ohne Regel")).toBe("ohne Regel");
    expect(NO_JOBS_RULE).toContain("never run `bun run job start`");
  });

  test("Claude fehlt: mitgelieferte und eigene Agenten ohne Job-Befehl; mit Claude wie bisher", async () => {
    expect(getAgentConfig("general").systemPrompt).toContain(JOB_RULES);
    await createAgent({ name: "notizen", description: "Notizen", systemPrompt: "Du machst Notizen." });
    expect(getAgentConfig("notizen").systemPrompt).toContain(JOB_RULES);

    setClaudeAvailability({ state: "missing", reason: "Claude nicht angemeldet" });
    for (const name of ["general", "research", "notizen"]) {
      const prompt = getAgentConfig(name).systemPrompt;
      expect(prompt).not.toContain("bun run job start --title");
      expect(prompt).toContain(NO_JOBS_RULE);
    }
  });
});
