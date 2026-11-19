/**
 * Issue #249, Checkbox 2: TurnOptions.turnHint hängt an jedem Prompt des
 * Turns (voll, fortgesetzt, neuer Versuch, Wechsel auf Claude Code,
 * Fallback-Kette), bei Claude Code, Codex und OpenCode, und steht nie in der
 * gespeicherten Nachricht. Normale Turns bleiben unverändert.
 *
 * Motoren, Verfügbarkeitsprüfung, Prompt-Bau und Fallback sind Attrappen;
 * Session-Ablage und Einstellungsdatei sind echt (Temp-Dateien). Kein echtes
 * claude, codex oder opencode.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveStreamingLimits,
  runJsonTurn,
  runStreamingTurn,
  TURN_HINT_HEADING,
  withTurnHint,
  type ChatTurnDeps,
  type TurnOptions,
  type TurnSink,
} from "../src/lib/chat-turn";
import { resetEngineChoiceForTests, resolveEngine, type EngineChoiceDeps } from "../src/lib/engine-choice";
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
import { getSettings, setSettingsPath, type Settings } from "../src/lib/settings";
import { SPEECH_TURN_HINT } from "../src/lib/speech/spoken-turn";
import { createBotChat, createTelegramChat, type WebSavedMessage } from "../src/web/bot-turn";
import { subprocessEnv } from "../src/lib/subprocess-env";
import { codexEnv } from "../src/lib/engines/codex";
import { opencodeEnv } from "../src/lib/engines/opencode";

const DM = "4711";
const GROUP = "-1001234567890";
const WEB_ID = "0b3c6a2e-1f00-4c1a-9d0e-2a4b6c8d0e1f";
const HINT = "Bitte nur zum Test: antworte in einem Satz.";
const SUFFIX = `\n\n---\n\n${TURN_HINT_HEADING}\n${HINT}`;
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
let tick = 5_000;

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

function setup(opts: { sessionMode?: boolean } = {}) {
  const engines: Record<EngineId, Engine> = { claude: fakeEngine("claude"), codex: fakeEngine("codex"), opencode: fakeEngine("opencode") };
  const notices: string[] = [];
  const fallbackCalls: { prompt: string; context?: string }[] = [];
  const built: { kind: "full" | "resume"; userMessage: string }[] = [];
  const sink: TurnSink = { progress: () => {}, notice: t => void notices.push(t) };
  const deps: Partial<ChatTurnDeps> = {
    getEngine: id => engines[id],
    resolveEngine: (key, d: Partial<EngineChoiceDeps> | undefined, turn) =>
      resolveEngine(key, { ...d, env: () => ({}), checkEngine: async id => ({ ...READY, engine: id }), log: () => {} }, turn),
    forgetEngineCheck: () => {},
    runFallbackChain: async ({ question: prompt, context }) => {
      fallbackCalls.push({ prompt, context });
      return { text: "ersatz-antwort", source: "openrouter", model: "ersatz-modell" };
    },
    buildPromptContext: async o => {
      built.push({ kind: "full", userMessage: o.userMessage });
      return { fullPrompt: `voll: ${o.userMessage}`, fallbackContext: "kontext" };
    },
    buildResumePrompt: async o => {
      built.push({ kind: "resume", userMessage: o.userMessage });
      return `fortgesetzt: ${o.userMessage}`;
    },
    isSessionModeEnabled: () => opts.sessionMode ?? true,
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
    getSettings,
    resolveStreamingLimits: () => resolveStreamingLimits({}),
    reportSecrets: () => [],
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => 0,
  };
  const turn = (extra: Partial<TurnOptions> = {}, run: typeof runStreamingTurn = runStreamingTurn) =>
    run({ userMessage: "Frage?", chatId: DM, agentName: "general", sink, deps, ...extra });
  return { deps, turn, notices, fallbackCalls, built };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tybo-249-hint-"));
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

describe("withTurnHint", () => {
  test.each(["claude", "codex", "opencode"] as const)("Job-Kette im echten Chat-Kern bis zur %s-Umgebung, nächste Nachricht wieder ohne", async engine => {
    const s = setup({ sessionMode: false });
    const seen: (string | undefined)[] = [];
    const env = () => engine === "codex" ? codexEnv(dir, "dm:4711", { home: dir, env: { TYBO_JOB_CHAIN: "99" }, quiet: true })
      : engine === "opencode" ? opencodeEnv(dir, "dm:4711")
      : subprocessEnv({ cwd: dir, home: dir, env: { TYBO_JOB_CHAIN: "99" }, conversationKey: "dm:4711" });
    const base = fakeEngine(engine);
    s.deps.getEngine = () => ({ ...base, async run(req) { seen.push(env().TYBO_JOB_CHAIN); return base.run(req); } });
    await s.turn({ engine, jobChain: 3 });
    await s.turn({ engine });
    expect(seen).toEqual(["3", undefined]);
  });
  test("hängt den Hinweis unter eigener Überschrift an, ohne Hinweis bleibt der Prompt gleich", () => {
    expect(withTurnHint("Prompt", HINT)).toBe(`Prompt${SUFFIX}`);
    expect(withTurnHint("Prompt", undefined)).toBe("Prompt");
    expect(withTurnHint("Prompt", "   ")).toBe("Prompt");
  });
});

describe("Hinweis erreicht jeden Motor", () => {
  for (const engine of ["claude", "codex", "opencode"] as const) {
    test(`${engine}: im vollen und im fortgesetzten Prompt, der Prompt-Bau sieht nur die Nachricht`, async () => {
      if (engine !== "claude") await putSettings({ engine: { default: engine } });
      const s = setup();
      expect(await s.turn({ turnHint: HINT })).toBe(`antwort-${engine}`);
      expect(await s.turn({ turnHint: HINT, userMessage: "Und dann?" })).toBe(`antwort-${engine}`);
      expect(calls.map(c => c.engine)).toEqual([engine, engine]);
      expect(calls[0].prompt).toBe(`voll: Frage?${SUFFIX}`);
      expect(calls[0].resumeSessionId).toBeUndefined();
      expect(calls[1].prompt).toBe(`fortgesetzt: Und dann?${SUFFIX}`);
      expect(calls[1].resumeSessionId).toBe(`${engine}-s1`);
      // Kontext und Suche arbeiten mit der Nachricht ohne Hinweis
      expect(s.built).toEqual([
        { kind: "full", userMessage: "Frage?" },
        { kind: "resume", userMessage: "Und dann?" },
      ]);
    });
  }

  test("auch ohne Streaming (runJsonTurn)", async () => {
    const s = setup();
    await s.turn({ turnHint: HINT }, runJsonTurn);
    expect(calls[0].streaming).toBe(false);
    expect(calls[0].prompt).toBe(`voll: Frage?${SUFFIX}`);
  });

  test("der Sprech-Hinweis selbst: kurz, ohne Markdown, Angebot für den Chat", async () => {
    const s = setup();
    await s.turn({ turnHint: SPEECH_TURN_HINT });
    expect(calls[0].prompt.endsWith(`${TURN_HINT_HEADING}\n${SPEECH_TURN_HINT}`)).toBe(true);
    expect(SPEECH_TURN_HINT).toContain("hört deine Antwort vorgelesen");
    expect(SPEECH_TURN_HINT).toContain("ohne Markdown, Tabellen, Aufzählungszeichen, Code oder Links");
    expect(SPEECH_TURN_HINT).toContain("in den Chat zu schreiben");
  });
});

describe("Hinweis bleibt über Umwege erhalten", () => {
  test("fortgesetzte Session scheitert: der neue Versuch mit vollem Prompt trägt den Hinweis", async () => {
    const s = setup();
    await s.turn();
    replies.claude = [{ isError: true, text: "session weg" }];
    expect(await s.turn({ turnHint: HINT })).toBe("antwort-claude");
    expect(calls).toHaveLength(3);
    expect(calls[1].prompt).toBe(`fortgesetzt: Frage?${SUFFIX}`);
    expect(calls[2].prompt).toBe(`voll: Frage?${SUFFIX}`);
    expect(calls[2].resumeSessionId).toBeUndefined();
  });

  test("Codex meldet beim Lauf „nicht angemeldet\": Claude Code bekommt den Hinweis", async () => {
    await putSettings({ engine: { default: "codex" } });
    const s = setup();
    replies.codex = [{ isError: true, text: "", errorKind: "auth" }];
    expect(await s.turn({ turnHint: HINT })).toBe("antwort-claude");
    expect(calls.map(c => c.engine)).toEqual(["codex", "claude"]);
    expect(calls[0].prompt).toBe(`voll: Frage?${SUFFIX}`);
    expect(calls[1].prompt).toBe(`voll: Frage?${SUFFIX}`);
  });

  test("fortgesetzte OpenCode-Session, dann Wechsel auf Claude Code: voller Prompt mit Hinweis", async () => {
    await putSettings({ engine: { default: "opencode" } });
    const s = setup();
    await s.turn();
    replies.opencode = [{ isError: true, text: "", errorKind: "not_installed" }];
    expect(await s.turn({ turnHint: HINT })).toBe("antwort-claude");
    expect(calls.map(c => c.engine)).toEqual(["opencode", "opencode", "claude"]);
    expect(calls[1].prompt).toBe(`fortgesetzt: Frage?${SUFFIX}`);
    expect(calls[2].prompt).toBe(`voll: Frage?${SUFFIX}`);
  });

  for (const engine of ["claude", "codex", "opencode"] as const) {
    test(`${engine} fällt aus: die Fallback-Kette bekommt die Frage mit Hinweis, der Kontext bleibt getrennt`, async () => {
      if (engine !== "claude") await putSettings({ engine: { default: engine } });
      const s = setup({ sessionMode: false });
      replies[engine] = [{ isError: true, text: "kaputt" }];
      expect(await s.turn({ turnHint: HINT })).toContain("ersatz-antwort");
      expect(s.fallbackCalls).toEqual([{ prompt: `Frage?${SUFFIX}`, context: "kontext" }]);
    });
  }

  test("Fallback nach gescheitertem Fortsetzen: Frage mit Hinweis, frischer Kontext", async () => {
    const s = setup();
    await s.turn();
    replies.claude = [{ isError: true, text: "session weg" }, { isError: true, text: "immer noch" }];
    await s.turn({ turnHint: HINT });
    expect(s.fallbackCalls).toEqual([{ prompt: `Frage?${SUFFIX}`, context: "kontext" }]);
  });
});

describe("normale Turns", () => {
  test("ohne turnHint: Prompt und Fallback-Frage unverändert", async () => {
    const s = setup();
    await s.turn();
    await s.turn();
    replies.claude = [{ isError: true, text: "weg" }, { isError: true, text: "weg" }];
    await s.turn();
    expect(calls.map(c => c.prompt)).toEqual(["voll: Frage?", "fortgesetzt: Frage?", "fortgesetzt: Frage?", "voll: Frage?"]);
    expect(s.fallbackCalls).toEqual([{ prompt: "Frage?", context: "kontext" }]);
    for (const c of calls) expect(c.prompt).not.toContain(TURN_HINT_HEADING);
  });
});

// --- Chat-Wege der WebUI: Hinweis nur bei Sprech-Turns, nie im Verlauf -----------

function chats(s: ReturnType<typeof setup>) {
  const saved: WebSavedMessage[] = [];
  const mirrored: string[] = [];
  const sent: string[] = [];
  const base = {
    runStreamingTurn: (o: TurnOptions) => runStreamingTurn({ ...o, deps: s.deps }),
    saveMessage: async (m: WebSavedMessage) => {
      saved.push(m);
      return true;
    },
    processIntents: async () => {},
    abortEngineCalls: (key: string) => abortExecutions(key),
    isShuttingDown: () => false,
    scheduleRestartCheck: () => {},
    log: () => {},
  };
  const web = createBotChat(base);
  const telegram = createTelegramChat({
    ...base,
    userId: DM,
    groupId: () => GROUP,
    agentForTopic: () => "research",
    sendPlain: async (_chat, text) => void mirrored.push(text),
    sendAsAgent: async (_agent, _chat, text) => void sent.push(text),
  });
  const sink: TurnSink = { progress: () => {}, notice: () => {} };
  return { web, telegram, saved, mirrored, sent, sink };
}

describe("Sprech-Turn über die Chat-Wege", () => {
  for (const engine of ["claude", "codex", "opencode"] as const) {
    test(`Web-Gespräch mit ${engine}: der Motor sieht den Sprech-Hinweis, der Verlauf nicht`, async () => {
      if (engine !== "claude") await putSettings({ engine: { default: engine } });
      const s = setup();
      const c = chats(s);
      const result = await c.web.runTurn({ conversationId: WEB_ID, agent: "general", text: "Wie spät ist es?", sink: c.sink, speech: true });
      expect(result.text).toBe(`antwort-${engine}`);
      expect(calls).toHaveLength(1);
      expect(calls[0].engine).toBe(engine);
      expect(calls[0].prompt).toBe(`voll: Wie spät ist es?\n\n---\n\n${TURN_HINT_HEADING}\n${SPEECH_TURN_HINT}`);
      expect(c.saved.map(m => m.content)).toEqual(["Wie spät ist es?", `antwort-${engine}`]);
      for (const m of c.saved) {
        expect(m.content).not.toContain("vorgelesen");
        expect(JSON.stringify(m.metadata)).not.toContain("vorgelesen");
      }
    });
  }

  test("Topic: gespiegelte Nachricht, gespeicherte Nachricht und Antwort in Telegram ohne Hinweis", async () => {
    const s = setup();
    const c = chats(s);
    await c.telegram.runTurn({ conversationId: "topic-7", agent: "research", text: "Wie spät ist es?", sink: c.sink, speech: true });
    expect(calls[0].prompt.endsWith(SPEECH_TURN_HINT)).toBe(true);
    expect(c.mirrored).toEqual(["Du (Web): Wie spät ist es?"]);
    expect(c.saved.map(m => m.content)).toEqual(["Wie spät ist es?", "antwort-claude"]);
    expect(c.sent).toEqual(["antwort-claude"]);
  });

  test("getippter Turn im selben Gespräch danach: kein Hinweis, auch nicht in der fortgesetzten Session", async () => {
    const s = setup();
    const c = chats(s);
    await c.web.runTurn({ conversationId: WEB_ID, agent: "general", text: "Gesprochen", sink: c.sink, speech: true });
    await c.web.runTurn({ conversationId: WEB_ID, agent: "general", text: "Getippt", sink: c.sink });
    await c.telegram.runTurn({ conversationId: "dm", agent: "general", text: "Getippt im Direktchat", sink: c.sink });
    expect(calls).toHaveLength(3);
    expect(calls[0].prompt).toContain(SPEECH_TURN_HINT);
    expect(calls[1].prompt).toBe("fortgesetzt: Getippt");
    expect(calls[2].prompt).toBe("voll: Getippt im Direktchat");
  });
});
