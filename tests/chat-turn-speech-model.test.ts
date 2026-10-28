/**
 * Issue #249, Nachtrag „Modell für gesprochene Fragen": speech.model und
 * speech.effort gelten nur für Sprech-Turns. Beim Motor Claude läuft der
 * Turn mit diesem Modell (Effort Standard medium), auch in einer
 * fortgesetzten Session; getippte Turns im selben Gespräch bleiben beim
 * Modell des Gesprächs. Bei Codex und OpenCode gilt der Wert als Modellname
 * des Motors; passt er nicht, wird er ignoriert und einmal gemeldet.
 *
 * Motoren und Verfügbarkeitsprüfung sind Attrappen; Session-Ablage und
 * Einstellungsdatei sind echt (Temp-Dateien). Kein echtes Modell.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveStreamingLimits, runStreamingTurn, type ChatTurnDeps, type TurnInfo, type TurnOptions, type TurnSessionMeta, type TurnSink } from "../src/lib/chat-turn";
import { modelFitsEngine, modelMisfitNotice, resetEngineChoiceForTests, resolveEngine, type EngineChoiceDeps } from "../src/lib/engine-choice";
import type { Engine, EngineId, EngineRequest, EngineResult, EngineStatus } from "../src/lib/engines";
import { abortExecutions } from "../src/lib/execution-context";
import {
  getResumableSession,
  getSessionsForKey,
  recordSessionTurn,
  resetSession,
  sessionEpoch,
  setSessionsFileForTests,
  takeExpiredSession,
} from "../src/lib/session-manager";
import { getSettings, setSettingsPath, settingsSchema, type Settings } from "../src/lib/settings";
import { SPEECH_TURN_HINT, speechTurnOptions } from "../src/lib/speech/spoken-turn";
import { createBotChat, type WebSavedMessage } from "../src/web/bot-turn";
import { isolateShellEnv } from "./shell-env";

// Effort steht in der Befehlszeile: ein CLAUDE_EFFORT aus der Shell darf sie nicht ändern
isolateShellEnv({ CLAUDE_EFFORT: undefined });

const WEB_ID = "0b3c6a2e-1f00-4c1a-9d0e-2a4b6c8d0e1f";
const CHAT = `web:${WEB_ID}`;
const AGENT_MODEL = "claude-agent-modell";
const SPEECH_MODEL = "claude-haiku-5-5";
const READY: EngineStatus = { engine: "codex", checked: true, installed: true, loggedIn: true };

interface Call extends EngineRequest {
  engine: EngineId;
}

let dir: string;
let settingsFile: string;
let calls: Call[];
let replies: Partial<Record<EngineId, Partial<EngineResult>[]>>;
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let tick = 9_000;

function fakeEngine(id: EngineId): Engine {
  let n = 0;
  return {
    id,
    describe: () => `Attrappe ${id}`,
    async run(req) {
      calls.push({ ...req, engine: id });
      n++;
      return { engine: id, text: `antwort-${id}`, sessionId: `${id}-s${n}`, isError: false, ...replies[id]?.shift() };
    },
  };
}

async function putSettings(content: Settings): Promise<void> {
  await writeFile(settingsFile, JSON.stringify(content));
  tick += 10;
  await utimes(settingsFile, tick, tick);
}

function setup() {
  const engines: Record<EngineId, Engine> = { claude: fakeEngine("claude"), codex: fakeEngine("codex"), opencode: fakeEngine("opencode") };
  const notices: string[] = [];
  const infos: TurnInfo[] = [];
  const metas: TurnSessionMeta[] = [];
  const sink: TurnSink = { progress: () => {}, notice: t => void notices.push(t) };
  const deps: Partial<ChatTurnDeps> = {
    getEngine: id => engines[id],
    resolveEngine: (key, d?: Partial<EngineChoiceDeps>) =>
      resolveEngine(key, { ...d, env: () => ({}), checkEngine: async id => ({ ...READY, engine: id }), log: () => {} }),
    forgetEngineCheck: () => {},
    runFallbackChain: async () => ({ text: "ersatz-antwort", source: "openrouter", model: "ersatz-modell" }),
    buildPromptContext: async o => ({ fullPrompt: `voll: ${o.userMessage}`, fallbackContext: "kontext" }),
    buildResumePrompt: async o => `fortgesetzt: ${o.userMessage}`,
    isSessionModeEnabled: () => true,
    getResumableSession,
    takeExpiredSession,
    recordSessionTurn,
    getSessionsForKey,
    sessionEpoch,
    resetSession,
    shouldDistill: () => false,
    distillSession: async () => {},
    log: async () => {},
    getAgentConfig: () => ({ model: AGENT_MODEL, effort: "high" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
    getSettings,
    resolveStreamingLimits: () => resolveStreamingLimits({}),
    reportSecrets: () => [],
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => 0,
  };
  /** Turn wie ihn die Chat-Wege starten: gesprochen mit speechTurnOptions(), getippt ohne */
  const turn = (kind: "gesprochen" | "getippt", extra: Partial<TurnOptions> = {}) =>
    runStreamingTurn({
      userMessage: kind,
      chatId: CHAT,
      agentName: "general",
      sink,
      onInfo: i => infos.push(i),
      onSessionMeta: m => metas.push(m),
      deps,
      ...(kind === "gesprochen" ? speechTurnOptions() : {}),
      ...extra,
    });
  return { deps, turn, notices, infos, metas, sink };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tybo-249-model-"));
  settingsFile = join(dir, "settings.json");
  setSettingsPath(settingsFile);
  setSessionsFileForTests(join(dir, "sessions.json"));
  resetEngineChoiceForTests();
  calls = [];
  replies = {};
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  setSettingsPath();
  setSessionsFileForTests(null);
  await rm(dir, { recursive: true, force: true });
});

describe("speechTurnOptions", () => {
  test("ohne speech.model nur der Hinweis; mit Modell dazu das Modell, Effort Standard medium", async () => {
    expect(speechTurnOptions({})).toEqual({ turnHint: SPEECH_TURN_HINT });
    // Effort allein bewirkt nichts: leer heißt wie das Gespräch
    expect(speechTurnOptions({ speech: { effort: "low" } })).toEqual({ turnHint: SPEECH_TURN_HINT });
    expect(speechTurnOptions({ speech: { model: SPEECH_MODEL } })).toEqual({ turnHint: SPEECH_TURN_HINT, turnModel: { model: SPEECH_MODEL, effort: "medium" } });
    expect(speechTurnOptions({ speech: { model: SPEECH_MODEL, effort: "low" } }).turnModel).toEqual({ model: SPEECH_MODEL, effort: "low" });
    await putSettings({ speech: { model: "claude-sonnet-5", effort: "xhigh" } });
    expect(speechTurnOptions().turnModel).toEqual({ model: "claude-sonnet-5", effort: "xhigh" });
  });

  test("Schema: speech.model und speech.effort sind optional und geprüft", () => {
    for (const model of [SPEECH_MODEL, "claude-opus-5-5[1m]", "gpt-5.6-sol", "openrouter/anthropic/claude-opus-5.5", "qwen3:8b"]) {
      expect(settingsSchema.safeParse({ speech: { model } }).success).toBe(true);
    }
    for (const model of ["", "  ", "-rf", "zwei worte", "a;b", "x".repeat(101)]) {
      expect(settingsSchema.safeParse({ speech: { model } }).success).toBe(false);
    }
    expect(settingsSchema.safeParse({ speech: { effort: "medium" } }).success).toBe(true);
    expect(settingsSchema.safeParse({ speech: { effort: "max" } }).success).toBe(false);
    expect(settingsSchema.safeParse({ speech: {} }).success).toBe(true);
  });
});

describe("modelFitsEngine", () => {
  test("Claude-Namen zu Claude Code, <anbieter>/<modell> zu OpenCode, andere Namen zu Codex", () => {
    for (const model of ["claude-opus-5-5", "claude-haiku-5-5", "claude-opus-5-5[1m]", "sonnet", "opus", "haiku", "fable"]) {
      expect(modelFitsEngine("claude", model)).toBe(true);
      expect(modelFitsEngine("codex", model)).toBe(false);
      expect(modelFitsEngine("opencode", model)).toBe(false);
    }
    for (const model of ["openrouter/anthropic/claude-opus-5.5", "anthropic/claude-sonnet-5", "ollama/qwen3:8b"]) {
      expect(modelFitsEngine("opencode", model)).toBe(true);
      expect(modelFitsEngine("claude", model)).toBe(false);
      expect(modelFitsEngine("codex", model)).toBe(false);
    }
    for (const model of ["gpt-5.6-sol", "gpt-6-astra", "o5-mini"]) {
      expect(modelFitsEngine("codex", model)).toBe(true);
      expect(modelFitsEngine("claude", model)).toBe(false);
      expect(modelFitsEngine("opencode", model)).toBe(false);
    }
  });
});

describe("Motor Claude", () => {
  test("bestehende Session → Sprechmodell → getippter Turn: das Sprechmodell nur im Sprech-Turn, die Session läuft durch", async () => {
    await putSettings({ speech: { model: SPEECH_MODEL } });
    const s = setup();
    expect(await s.turn("getippt")).toBe("antwort-claude");
    expect(await s.turn("gesprochen")).toBe("antwort-claude");
    expect(await s.turn("getippt")).toBe("antwort-claude");
    expect(calls).toHaveLength(3);

    // 1. Getippt: Modell und Effort des Gesprächs, frische Session
    expect(calls[0]).toMatchObject({ engine: "claude", model: AGENT_MODEL, effort: "high", prompt: "voll: getippt" });
    expect(calls[0].resumeSessionId).toBeUndefined();

    // 2. Gesprochen: eingestelltes Modell mit Effort medium, in der fortgesetzten Session
    expect(calls[1]).toMatchObject({ engine: "claude", model: SPEECH_MODEL, effort: "medium", resumeSessionId: "claude-s1" });
    expect(calls[1].prompt.startsWith("fortgesetzt: gesprochen")).toBe(true);
    expect(calls[1].prompt).toContain(SPEECH_TURN_HINT);

    // 3. Getippt danach: wieder das Modell des Gesprächs, dieselbe Session geht weiter
    expect(calls[2]).toMatchObject({ engine: "claude", model: AGENT_MODEL, effort: "high", resumeSessionId: "claude-s2", prompt: "fortgesetzt: getippt" });

    // Die Session bleibt unter dem Modell des Gesprächs gespeichert
    const sessions = await getSessionsForKey(CHAT);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ engine: "claude", model: AGENT_MODEL, engineSessionId: "claude-s3", messageCount: 1 });

    // Unter der Antwort steht das Modell, das geantwortet hat; Rückfragen setzen mit dem Modell des Gesprächs fort
    expect(s.infos.map(i => i.model)).toEqual([AGENT_MODEL, SPEECH_MODEL, AGENT_MODEL]);
    expect(s.metas.map(m => m.model)).toEqual([AGENT_MODEL, AGENT_MODEL, AGENT_MODEL]);
    expect(s.notices).toEqual([]);
  });

  test("leer = unverändert: ein Sprech-Turn ohne speech.model läuft mit Modell und Effort des Gesprächs", async () => {
    await putSettings({ speech: { stt: "auto", effort: "low" } });
    const s = setup();
    await s.turn("gesprochen");
    await s.turn("gesprochen");
    expect(calls.map(c => [c.model, c.effort, c.resumeSessionId])).toEqual([
      [AGENT_MODEL, "high", undefined],
      [AGENT_MODEL, "high", "claude-s1"],
    ]);
    expect(s.infos.map(i => i.model)).toEqual([AGENT_MODEL, AGENT_MODEL]);
  });

  test("speech.effort gilt zusammen mit dem Modell", async () => {
    await putSettings({ speech: { model: "claude-sonnet-5", effort: "low" } });
    const s = setup();
    await s.turn("gesprochen");
    expect(calls[0]).toMatchObject({ model: "claude-sonnet-5", effort: "low" });
  });

  test("erster Turn des Gesprächs gesprochen: die neue Session gehört trotzdem zum Modell des Gesprächs", async () => {
    await putSettings({ speech: { model: SPEECH_MODEL } });
    const s = setup();
    await s.turn("gesprochen");
    await s.turn("getippt");
    expect(calls[0]).toMatchObject({ model: SPEECH_MODEL, effort: "medium" });
    expect(calls[0].resumeSessionId).toBeUndefined();
    expect(calls[1]).toMatchObject({ model: AGENT_MODEL, effort: "high", resumeSessionId: "claude-s1" });
  });

  test("Modell passt nicht zu Claude Code (OpenCode- oder Codex-Name): ignoriert, einmal gemeldet, nie ein Fehler", async () => {
    await putSettings({ speech: { model: "openrouter/anthropic/claude-opus-5.5" } });
    const s = setup();
    expect(await s.turn("gesprochen")).toBe("antwort-claude");
    expect(await s.turn("gesprochen")).toBe("antwort-claude");
    expect(calls.map(c => [c.model, c.effort])).toEqual([
      [AGENT_MODEL, "high"],
      [AGENT_MODEL, "high"],
    ]);
    expect(s.notices).toEqual([modelMisfitNotice("claude", "openrouter/anthropic/claude-opus-5.5")]);
    expect(s.notices[0]).toBe(
      "Das Modell für gesprochene Fragen (openrouter/anthropic/claude-opus-5.5) passt nicht zu Claude Code, ich antworte mit dem Modell des Gesprächs."
    );
    // Ein anderes unpassendes Modell wird wieder einmal gemeldet
    await putSettings({ speech: { model: "gpt-5.6-sol" } });
    await s.turn("gesprochen");
    await s.turn("gesprochen");
    expect(s.notices).toHaveLength(2);
    expect(calls.every(c => c.model === AGENT_MODEL)).toBe(true);
  });
});

describe("Motor Codex", () => {
  test("Codex-Modell gilt für den Sprech-Turn, der Effort bleibt der des Motors; getippt danach unverändert", async () => {
    await putSettings({ engine: { default: "codex", codex: { model: "gpt-5.6-sol", effort: "max" } }, speech: { model: "gpt-5.6-sol-mini", effort: "low" } });
    const s = setup();
    await s.turn("getippt");
    await s.turn("gesprochen");
    await s.turn("getippt");
    expect(calls.map(c => [c.engine, c.model, c.effort, c.resumeSessionId])).toEqual([
      ["codex", "gpt-5.6-sol", "max", undefined],
      ["codex", "gpt-5.6-sol-mini", "max", "codex-s1"],
      ["codex", "gpt-5.6-sol", "max", "codex-s2"],
    ]);
    expect(s.infos.map(i => i.model)).toEqual(["gpt-5.6-sol", "gpt-5.6-sol-mini", "gpt-5.6-sol"]);
    expect(s.notices).toEqual([]);
  });

  test("Codex ohne eigenes Modell: Sprech-Turn mit Modell, getippter Turn danach wieder ohne Modell und in derselben Session", async () => {
    await putSettings({ engine: { default: "codex" }, speech: { model: "gpt-5.6-sol-mini" } });
    const s = setup();
    await s.turn("gesprochen");
    await s.turn("getippt");
    expect(calls[0].model).toBe("gpt-5.6-sol-mini");
    expect(calls[0].effort).toBeUndefined();
    expect(calls[1].model).toBeUndefined();
    expect(calls[1].resumeSessionId).toBe("codex-s1");
  });

  test("Claude-Modell passt nicht zu Codex: ignoriert und genau einmal gemeldet", async () => {
    await putSettings({ engine: { default: "codex", codex: { model: "gpt-5.6-sol" } }, speech: { model: SPEECH_MODEL } });
    const s = setup();
    expect(await s.turn("gesprochen")).toBe("antwort-codex");
    expect(await s.turn("gesprochen")).toBe("antwort-codex");
    expect(await s.turn("getippt")).toBe("antwort-codex");
    expect(calls.map(c => c.model)).toEqual(["gpt-5.6-sol", "gpt-5.6-sol", "gpt-5.6-sol"]);
    expect(s.notices).toEqual([`Das Modell für gesprochene Fragen (${SPEECH_MODEL}) passt nicht zu Codex, ich antworte mit dem Modell des Gesprächs.`]);
  });

  test("Codex fällt beim Lauf aus: Claude Code antwortet mit dem Sprechmodell, das zu ihm passt", async () => {
    await putSettings({ engine: { default: "codex" }, speech: { model: SPEECH_MODEL } });
    const s = setup();
    replies.codex = [{ isError: true, text: "", errorKind: "auth" }];
    expect(await s.turn("gesprochen")).toBe("antwort-claude");
    expect(calls.map(c => [c.engine, c.model, c.effort])).toEqual([
      ["codex", undefined, undefined],
      ["claude", SPEECH_MODEL, "medium"],
    ]);
    expect(s.infos[0]).toMatchObject({ engine: "claude", model: SPEECH_MODEL });
  });
});

describe("Motor OpenCode", () => {
  test("OpenCode-Modell gilt für den Sprech-Turn, die Variante bleibt; Claude-Modell wird ignoriert und einmal gemeldet", async () => {
    await putSettings({
      engine: { default: "opencode", opencode: { model: "openrouter/anthropic/claude-opus-5.5", variant: "high" } },
      speech: { model: "openrouter/anthropic/claude-haiku-4.5", effort: "low" },
    });
    const s = setup();
    await s.turn("gesprochen");
    await s.turn("getippt");
    expect(calls.map(c => [c.engine, c.model, c.effort, c.resumeSessionId])).toEqual([
      ["opencode", "openrouter/anthropic/claude-haiku-4.5", "high", undefined],
      ["opencode", "openrouter/anthropic/claude-opus-5.5", "high", "opencode-s1"],
    ]);
    expect(s.notices).toEqual([]);

    await putSettings({ engine: { default: "opencode", opencode: { model: "openrouter/anthropic/claude-opus-5.5" } }, speech: { model: SPEECH_MODEL } });
    await s.turn("gesprochen");
    await s.turn("gesprochen");
    expect(calls.slice(2).map(c => c.model)).toEqual(["openrouter/anthropic/claude-opus-5.5", "openrouter/anthropic/claude-opus-5.5"]);
    expect(s.notices).toEqual([`Das Modell für gesprochene Fragen (${SPEECH_MODEL}) passt nicht zu OpenCode, ich antworte mit dem Modell des Gesprächs.`]);
  });
});

describe("über den Chat-Weg der WebUI", () => {
  test("Sprech-Turn nutzt das eingestellte Modell, der getippte Turn danach nicht; der Hinweis zum unpassenden Modell erscheint im Gespräch", async () => {
    await putSettings({ speech: { model: SPEECH_MODEL } });
    const s = setup();
    const saved: WebSavedMessage[] = [];
    const chat = createBotChat({
      runStreamingTurn: o => runStreamingTurn({ ...o, deps: s.deps }),
      saveMessage: async m => {
        saved.push(m);
        return true;
      },
      processIntents: async () => {},
      abortEngineCalls: key => abortExecutions(key),
      isShuttingDown: () => false,
      scheduleRestartCheck: () => {},
      log: () => {},
    });
    const first = await chat.runTurn({ conversationId: WEB_ID, agent: "general", text: "Wie spät?", sink: s.sink, speech: true });
    const second = await chat.runTurn({ conversationId: WEB_ID, agent: "general", text: "Und getippt?", sink: s.sink });
    expect(calls.map(c => [c.model, c.effort])).toEqual([
      [SPEECH_MODEL, "medium"],
      [AGENT_MODEL, "high"],
    ]);
    // Zeile unter der Antwort und Speicher nennen das Modell, das geantwortet hat
    expect(first.info?.model).toBe(SPEECH_MODEL);
    expect(second.info?.model).toBe(AGENT_MODEL);
    expect(saved.filter(m => m.role === "assistant").map(m => m.metadata?.model)).toEqual([SPEECH_MODEL, AGENT_MODEL]);

    await putSettings({ speech: { model: "gpt-5.6-sol" } });
    await chat.runTurn({ conversationId: WEB_ID, agent: "general", text: "Noch eine", sink: s.sink, speech: true });
    expect(calls[2].model).toBe(AGENT_MODEL);
    expect(s.notices).toEqual(["Das Modell für gesprochene Fragen (gpt-5.6-sol) passt nicht zu Claude Code, ich antworte mit dem Modell des Gesprächs."]);
  });
});
