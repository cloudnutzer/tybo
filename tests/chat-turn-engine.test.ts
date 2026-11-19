/**
 * Issue #125: der Chat-Kern wählt den Motor pro Gespräch (engine.topics,
 * engine.default, TYBO_ENGINE, Claude), überspringt einen nicht bereiten
 * Motor mit genau einer Meldung, fällt bei Motor-Fehlern wie bisher auf
 * neuen Versuch und Fallback-Kette zurück und meldet den Motor in TurnInfo.
 *
 * Motoren und Verfügbarkeitsprüfung sind Attrappen; die Session-Ablage und
 * die Einstellungsdatei sind echt (Temp-Dateien). Kein echtes claude/codex.
 */
import { test, expect, describe, beforeEach, afterEach, afterAll, beforeAll, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, writeFile, readFile, utimes } from "node:fs/promises";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import {
  runStreamingTurn,
  runJsonTurn,
  ABORT_REPLY,
  FALLBACK_FAILED_REPLY,
  engineFailedNotice,
  resolveStreamingLimits,
  type ChatTurnDeps,
  type TurnInfo,
  type TurnProgress,
  type TurnSessionMeta,
  type TurnSink,
  type PriorAttempt,
} from "../src/lib/chat-turn";
import { resolveEngine, resetEngineChoiceForTests, setTopicEngine, type EngineChoiceDeps } from "../src/lib/engine-choice";
import { getSettings, setSettingsPath, type Settings } from "../src/lib/settings";
import {
  getResumableSession,
  getSessionsForKey,
  recordSessionTurn,
  resetSession,
  sessionEpoch,
  setSessionsFileForTests,
  takeExpiredSession,
  type BotSession,
  noteHandover,
  takeHandover,
  retainHandover,
  SESSION_IDLE_MS,
} from "../src/lib/session-manager";
import { buildPromptContext, buildResumePrompt } from "../src/lib/prompt-builder";
import { handoverSources } from "./handover-fixture";
import { notesFixture } from "./claude-notes-fixture";
import { createCodexEngine } from "../src/lib/engines/codex";
import { ev, installCodexFake } from "./codex-fixture";
import { setRuntimeForTests, setSpawnForTests } from "../src/lib/claude";
import { CLAUDE_NOT_INSTALLED_NOTICE } from "../src/lib/claude/start-failure";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { getEngine, type Engine, type EngineErrorKind, type EngineId, type EngineRequest, type EngineResult, type EngineStatus } from "../src/lib/engines";
import { sessionKeyFor } from "../src/lib/store/message-rules";
import { isolateShellEnv } from "./shell-env";
import { readSwitchState, setSwitchStateFileForTests, setSwitchStateWriterForTests, updateSwitchState } from "../src/lib/engine-switch-state";
import { recordUsage, setUsageFileForTests, type UsageWindowId } from "../src/lib/engines/usage";
import { noteStageRun } from "../src/lib/engine-switch-run";
import { formatSwitchTime, type SwitchBlock } from "../src/lib/engine-switch";
import { abortError, abortExecutions, runCancelable } from "../src/lib/execution-context";
import { NO_BACKEND_REPLY, runFallbackChain, type FallbackRequest } from "../src/lib/fallback/chain";
import { createBotTurns, goalAgentCall } from "../src/app/bot-turns";
import { turnInfoCollector } from "../src/lib/turn-collector";
import { checkSwitchNotices, resetSwitchNotifyForTests, setSwitchNotifier, settleSwitchNoticesForTests } from "../src/lib/engine-switch-notify";

// Effort steht in der Befehlszeile: ein CLAUDE_EFFORT aus der Shell darf sie nicht ändern
isolateShellEnv({ CLAUDE_EFFORT: undefined });

const CHAT = "-100777";
const TOPIC_A = 11;
const TOPIC_B = 12;
const KEY_A = sessionKeyFor(CHAT, TOPIC_A);
const KEY_B = sessionKeyFor(CHAT, TOPIC_B);
const DM = "4711";
const WEB = "web:0b3c6a2e-1f00-4c1a-9d0e-2a4b6c8d0e1f";
const AGENT_MODEL = "claude-agent-modell";

const READY: EngineStatus = { engine: "codex", checked: true, installed: true, loggedIn: true };
const NOT_LOGGED_IN: EngineStatus = {
  engine: "codex",
  checked: true,
  installed: true,
  loggedIn: false,
  message: "Codex ist nicht angemeldet: im Terminal `codex login` ausführen",
};

interface Call extends EngineRequest {
  engine: EngineId;
}

let dir: string;
let settingsFile: string;
let calls: Call[];
let replies: Record<string, Partial<EngineResult>[]>;
let status: EngineStatus;
let checks: number;
let forgets: number;
let env: Record<string, string | undefined>;
let errorSpy: ReturnType<typeof spyOn>;
let warnSpy: ReturnType<typeof spyOn>;
let stageWrites: Promise<void>[];

/** Motor-Attrappe: nimmt die nächste vorbereitete Antwort des Motors, sonst Text mit neuer Session-ID */
function fakeEngine(id: EngineId): Engine {
  let n = 0;
  return {
    id,
    describe: () => `Attrappe ${id}`,
    async run(req) {
      calls.push({ ...req, engine: id });
      n++;
      const next = replies[id]?.shift();
      return { engine: id, text: `antwort-${id}`, sessionId: `${id}-s${n}`, isError: false, ...next };
    },
  };
}

let tick = 1_000;
async function putSettings(content: Settings | string): Promise<void> {
  await writeFile(settingsFile, typeof content === "string" ? content : JSON.stringify(content));
  tick += 10;
  await utimes(settingsFile, tick, tick);
}

function setup(opts: { sessionMode?: boolean; mode?: "streaming" | "json" } = {}) {
  const engines: Partial<Record<EngineId, Engine>> = { claude: fakeEngine("claude"), codex: fakeEngine("codex"), opencode: fakeEngine("opencode") };
  const notices: string[] = [];
  const progress: TurnProgress[] = [];
  const infos: TurnInfo[] = [];
  const metas: TurnSessionMeta[] = [];
  const fallbackCalls: string[] = [];
  const fallbackContexts: string[] = [];
  const distilled: BotSession[] = [];
  const logs: unknown[][] = [];
  const sink: TurnSink = {
    progress: p => { progress.push(p); },
    notice: (t) => {
      notices.push(t);
    },
  };
  const deps: Partial<ChatTurnDeps> = {
    getEngine: (id) => {
      const e = engines[id];
      if (!e) throw new Error(`kein Motor ${id}`);
      return e;
    },
    resolveEngine: (key, d?: Partial<EngineChoiceDeps>, turn) =>
      resolveEngine(key, {
        ...d,
        env: () => env,
        checkEngine: async (id) => {
          checks++;
          return { ...status, engine: id };
        },
        log: () => {},
      }, turn),
    noteStageRun: (...args) => {
      const write = noteStageRun(...args);
      stageWrites.push(write);
      return write;
    },
    forgetEngineCheck: () => {
      forgets++;
    },
    runFallbackChain: async ({ question, context }) => {
      fallbackCalls.push(question);
      fallbackContexts.push(context ?? "");
      return { text: "ersatz-antwort", source: "openrouter", model: "ersatz-modell" };
    },
    buildPromptContext: async () => ({ fullPrompt: "voller-prompt", fallbackContext: "kontext" }),
    buildResumePrompt: async () => "resume-prompt",
    isSessionModeEnabled: () => opts.sessionMode ?? true,
    getResumableSession,
    takeExpiredSession,
    recordSessionTurn,
    getSessionsForKey,
    sessionEpoch,
    resetSession,
    shouldDistill: () => true,
    distillSession: async (s) => {
      distilled.push(s);
    },
    log: async (...args) => {
      logs.push(args);
    },
    getAgentConfig: () =>
      ({ model: AGENT_MODEL, effort: "high", allowedTools: ["WebSearch"] }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
    // Echte Einstellungsdatei (Temp) mit Hot-Reload
    getSettings,
    resolveStreamingLimits: () => resolveStreamingLimits({}),
    reportSecrets: () => [],
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => 0,
  };
  const turn = (chatId: string, topicId?: number, extra: Record<string, unknown> = {}) =>
    (opts.mode === "json" ? runJsonTurn : runStreamingTurn)({
      userMessage: "Frage?",
      chatId,
      agentName: "general",
      ...(topicId !== undefined ? { topicId } : {}),
      sink,
      onInfo: (i) => infos.push(i),
      onSessionMeta: (m) => metas.push(m),
      deps,
      ...extra,
    });
  return { deps, turn, notices, progress, infos, metas, fallbackCalls, fallbackContexts, distilled, logs, engines };
}

beforeEach(async () => {
  resetSwitchNotifyForTests();
  dir = await mkdtemp(join(tmpdir(), "tybo-125-"));
  settingsFile = join(dir, "settings.json");
  setSettingsPath(settingsFile);
  setSessionsFileForTests(join(dir, "sessions.json"));
  setSwitchStateFileForTests(join(dir, "switch.json"), 20);
  setUsageFileForTests(join(dir, "usage.json"));
  stageWrites = [];
  resetEngineChoiceForTests();
  calls = [];
  replies = {};
  status = READY;
  checks = 0;
  forgets = 0;
  env = {};
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(async () => {
  await Promise.all(stageWrites);
  await settleSwitchNoticesForTests();
  resetSwitchNotifyForTests();
  setSwitchStateFileForTests(null);
  setUsageFileForTests(null);
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  setSettingsPath();
  setSessionsFileForTests(null);
  await rm(dir, { recursive: true, force: true });
});

describe("Claude-Notizen im Chat-Kern (Issue #664)", () => {
  function withNotes(s: ReturnType<typeof setup>) {
    const notes = notesFixture(dir);
    const sources = { ...handoverSources(DM, Date.now()), claudeNotes: async () => notes.section };
    s.deps.buildPromptContext = options => buildPromptContext(options, sources);
    s.deps.buildResumePrompt = options => buildResumePrompt(options, sources);
    return notes;
  }
  for (const sessionMode of [false, true]) {
    for (const from of ["claude", "codex"] as const) {
      test(`frischer Turn: ${from} fällt aus, Session-Modus ${sessionMode}`, async () => {
        const to = from === "claude" ? "codex" : "claude";
        await putSettings({ engine: { default: from, backups: [{ engine: to }] } });
        const s = setup({ sessionMode });
        const notes = withNotes(s);
        replies[from] = [{ isError: true, text: "", errorKind: from === "claude" ? "usage_limit" : "auth" }];
        await s.turn(DM);
        expect(calls.map(c => c.engine)).toEqual([from, to]);
        for (const call of calls) {
          expect(call.resumeSessionId).toBeUndefined();
          expect(call.prompt.includes(notes.section)).toBe(call.engine === "codex");
        }
      });
    }
    test(`Codex-Ausfall ohne Ersatzstufen: Claude-Prompt ohne Notizen, Session-Modus ${sessionMode}`, async () => {
      await putSettings({ engine: { default: "codex" } });
      const s = setup({ sessionMode });
      const notes = withNotes(s);
      replies.codex = [{ isError: true, text: "", errorKind: "auth" }];
      await s.turn(DM);
      expect(calls.map(c => c.engine)).toEqual(["codex", "claude"]);
      expect(calls[0].prompt).toContain(notes.section);
      expect(calls[1].prompt).not.toContain(notes.section);
    });
  }
  test("Codex: Start mit Notizen, Folgenachricht ohne, gescheiterte Fortsetzung neu mit Notizen", async () => {
    await putSettings({ engine: { default: "codex" } });
    const s = setup();
    const notes = withNotes(s);
    await s.turn(DM);
    replies.codex = [{ isError: true, text: "" }];
    await s.turn(DM);
    expect(calls.map(c => !!c.resumeSessionId)).toEqual([false, true, false]);
    expect(calls.map(c => c.prompt.includes(notes.section))).toEqual([true, false, true]);
  });
  test("Motorwechsel beginnt neue Session mit Notizen; Ersatzmodell bekommt sie nie", async () => {
    const s = setup();
    const notes = withNotes(s);
    await s.turn(DM);
    await s.turn(DM, undefined, { engine: "codex" });
    expect(calls[1].resumeSessionId).toBeUndefined();
    expect(calls[1].prompt).toContain(notes.section);
    replies.codex = [{ isError: true, text: "", errorKind: "usage_limit" }];
    await s.turn(DM, undefined, { engine: "codex" });
    expect(s.fallbackContexts).toHaveLength(1);
    expect(s.fallbackContexts[0]).toContain("Gedächtnis");
    expect(s.fallbackContexts[0]).not.toContain(notes.index);
  });
  test("Notizmarker geht beim echten Codex-Aufruf nur über stdin, nie über cmd", async () => {
    const s = setup();
    const notes = withNotes(s);
    const fake = installCodexFake();
    try {
      s.engines.codex = createCodexEngine();
      fake.next({ events: [ev.started("notizen-session"), ev.message("m", "Antwort"), ev.completed()] });
      await s.turn(DM, undefined, { engine: "codex" });
      expect(fake.spawns).toHaveLength(1);
      expect(fake.spawns[0].stdin).toContain(notes.section);
      for (const arg of fake.spawns[0].cmd) {
        expect(arg).not.toContain(notes.index);
        expect(arg).not.toContain("CLAUDE CODE NOTES");
      }
    } finally { fake.restore(); }
  });
});

describe("Übergabe im Chat-Kern (Issue #658)", () => {
  const key = sessionKeyFor(DM);
  const FABLE = "claude-fable-5-2";
  const OPUS = "claude-opus-5-5";
  async function seed(engine: EngineId = "claude", model = AGENT_MODEL) {
    await recordSessionTurn(key, "general", model, engine, "ursprüngliche-session");
    return (await getSessionsForKey(key))[0]!;
  }
  function realPrompt(s: ReturnType<typeof setup>, since: number) {
    const sources = handoverSources(DM, since);
    s.deps.buildPromptContext = options => buildPromptContext(options, sources);
    s.deps.buildResumePrompt = options => buildResumePrompt(options, sources);
    s.deps.now = () => Date.now();
    return sources;
  }
  function block(engine: EngineId, cause: SwitchBlock["cause"], extra: Partial<SwitchBlock> = {}): SwitchBlock {
    return { engine, cause, since: new Date(Date.now() - 1000).toISOString(), until: new Date(Date.now() + 600_000).toISOString(), resetKnown: true, ...extra } as SwitchBlock;
  }

  test.each(["threshold", "limit", "outage"] as const)("Automatik: Grund aus der Sperre %s", async cause => {
    await putSettings({ engine: { backups: [{ engine: "codex" }] } });
    const old = await seed();
    if (cause === "threshold") await recordUsage("claude", { windows: [{ id: "weekly_all", percent: 96, measuredAt: new Date().toISOString(), resetsAt: new Date(Date.now() + 600_000).toISOString(), source: "stream" }] });
    await updateSwitchState(state => ({ ...state, blocks: [block("claude", cause, cause === "threshold" ? { window: "weekly_all", percent: 96 } : {})] }));
    const s = setup(); realPrompt(s, old.startedAt);
    await s.turn(DM);
    expect(calls).toHaveLength(1);
    expect(calls[0].engine).toBe("codex");
    expect(calls[0].resumeSessionId).toBeUndefined();
    expect(calls[0].prompt).toContain(`Du übernimmst dieses Gespräch von Claude Code mit ${AGENT_MODEL}.`);
    expect(calls[0].prompt).toContain(cause === "outage" ? "Grund (Ausfall)" : "Grund (Limit erreicht)");
    expect(calls[0].prompt).toContain("Erste Frage mit der Zahl 7319");
    expect(await takeHandover(key, "general")).toBeUndefined();
  });

  test("mehrere übersprungene Stufen: Ursache der alten Session, nicht der ersten Stufe", async () => {
    await putSettings({ defaults: { model: FABLE }, engine: { backups: [{ engine: "claude", model: OPUS }, { engine: "codex" }, { engine: "opencode" }] } });
    const old = await seed("codex", "");
    await updateSwitchState(state => ({ ...state, blocks: [block("claude", "limit"), block("codex", "outage")] }));
    const s = setup(); realPrompt(s, old.startedAt);
    await s.turn(DM);
    expect(calls[0].engine).toBe("opencode");
    expect(calls[0].prompt).toContain("von Codex.");
    expect(calls[0].prompt).toContain("Grund (Ausfall)");
  });

  test("Modellwechsel auf demselben Motor: nur die passende Modellstufe bestimmt den Grund", async () => {
    await putSettings({ defaults: { model: FABLE }, engine: { backups: [{ engine: "claude", model: OPUS }, { engine: "codex" }] } });
    const old = await seed("claude", OPUS);
    await updateSwitchState(state => ({ ...state, blocks: [block("claude", "limit", { family: "fable" }), block("claude", "outage", { family: "opus" })] }));
    const s = setup(); realPrompt(s, old.startedAt);
    await s.turn(DM);
    expect(calls[0].prompt).toContain(`von Claude Code mit ${OPUS}.`);
    expect(calls[0].prompt).toContain("Grund (Ausfall)");
  });

  test("nicht bereite alte Stufe ergibt Ausfall", async () => {
    await putSettings({ engine: { backups: [{ engine: "codex" }] } });
    const old = await seed();
    const s = setup(); realPrompt(s, old.startedAt);
    s.deps.resolveEngine = (key, d, turn) => resolveEngine(key, { ...d, env: () => ({}), checkEngine: async id => ({ ...READY, engine: id, loggedIn: id !== "claude" }), log: () => {} }, turn);
    await s.turn(DM);
    expect(calls[0].prompt).toContain("Grund (Ausfall)");
  });

  test("Rückwechsel und ausdrücklicher Motor: Einstellung oder Verfügbarkeit geändert", async () => {
    const old = await seed("codex", "");
    const s = setup(); realPrompt(s, old.startedAt);
    await s.turn(DM);
    expect(calls[0].prompt).toContain("von Codex.");
    expect(calls[0].prompt).toContain("Grund (Einstellung oder Verfügbarkeit geändert)");
    const newSince = (await getSessionsForKey(key))[0]!.startedAt;
    realPrompt(s, newSince);
    await s.turn(DM, undefined, { engine: "codex" });
    expect(calls[1].prompt).toContain("Grund (Einstellung oder Verfügbarkeit geändert)");
  });

  for (const mode of ["streaming", "json"] as const) {
    for (const kind of ["quota", "auth"] as const) {
      test(`${mode}: Einspringen nach ${kind} übernimmt die fortgesetzte Session`, async () => {
        await putSettings({ engine: { backups: [{ engine: "codex" }] } });
        const old = await seed();
        const s = setup({ mode }); realPrompt(s, old.startedAt);
        replies.claude = [{ isError: true, text: "", errorKind: kind }];
        await s.turn(DM);
        expect(calls.map(call => call.engine)).toEqual(["claude", "codex"]);
        expect(calls[0].resumeSessionId).toBe("ursprüngliche-session");
        expect(calls[0].prompt).not.toContain("Du übernimmst");
        expect(calls[1].resumeSessionId).toBeUndefined();
        expect(calls[1].prompt).toContain("Erste Frage mit der Zahl 7319");
        expect(calls[1].prompt).toContain(kind === "quota" ? "Grund (Limit erreicht)" : "Grund (Ausfall)");
        expect(calls[1].prompt.indexOf("## USER MESSAGE")).toBeLessThan(calls[1].prompt.indexOf("Der vorige Versuch"));
      });
    }
  }

  test("Resume scheitert, frischer voller Prompt scheitert: für Ersatzstufe erneut mit Übergabe bauen", async () => {
    await putSettings({ engine: { backups: [{ engine: "codex" }] } });
    const old = await seed();
    const s = setup(); realPrompt(s, old.startedAt);
    replies.claude = [{ isError: true, text: "", errorKind: "context" }, { isError: true, text: "", errorKind: "quota" }];
    await s.turn(DM);
    expect(calls.map(call => call.engine)).toEqual(["claude", "claude", "codex"]);
    expect(calls[1].prompt).not.toContain("Du übernimmst");
    expect(calls[2].prompt).toContain("Erste Frage mit der Zahl 7319");
    expect(calls[2].prompt).toContain("Grund (Limit erreicht)");
  });

  test("ohne Ersatzstufen: Codex fällt aus, Claude Code übernimmt mit Ausfall", async () => {
    await putSettings({ engine: { default: "codex" } });
    const old = await seed("codex", "");
    const s = setup(); realPrompt(s, old.startedAt);
    replies.codex = [{ isError: true, text: "", errorKind: "auth" }];
    await s.turn(DM);
    expect(calls.map(call => call.engine)).toEqual(["codex", "claude"]);
    expect(calls[1].prompt).toContain("Grund (Ausfall)");
    expect(calls[1].prompt).toContain("Erste Frage mit der Zahl 7319");
  });

  test("gescheiterter Lauf begann selbst mit Übergabe: nächste Stufe behält den ursprünglichen Beginn", async () => {
    await putSettings({ engine: { default: "codex", backups: [{ engine: "opencode" }] } });
    const old = await seed();
    await noteHandover(key, "user");
    await resetSession(key, undefined, { preserveHandover: true });
    const s = setup(); realPrompt(s, old.startedAt);
    replies.codex = [{ isError: true, text: "", errorKind: "quota" }];
    await s.turn(DM);
    expect(calls.map(call => call.engine)).toEqual(["codex", "opencode"]);
    expect(calls[0].prompt).toContain("Grund (Wahl des Nutzers)");
    expect(calls[1].prompt).toContain("Grund (Limit erreicht)");
    for (const call of calls) expect(call.prompt).toContain("Erste Frage mit der Zahl 7319");
    expect(await takeHandover(key, "general")).toBeUndefined();
  });

  test.each([false, true])("Einspringen ohne alte Session (Session-Modus %s) hat keine Übergabe", async sessionMode => {
    await putSettings({ engine: { backups: [{ engine: "codex" }] } });
    const s = setup({ sessionMode }); realPrompt(s, Date.now());
    replies.claude = [{ isError: true, text: "", errorKind: "quota" }];
    await s.turn(DM);
    expect(calls.map(call => call.engine)).toEqual(["claude", "codex"]);
    for (const call of calls) {
      expect(call.prompt).not.toContain("Du übernimmst");
      expect(call.prompt).not.toContain("Erste Frage mit der Zahl 7319");
    }
  });

  test.each(["abgebrochen", "Ersatzmodell"] as const)("erster Übergabe-Turn endet mit %s: Notiz bleibt bis zur gespeicherten Session", async end => {
    const old = await seed();
    const s = setup(); realPrompt(s, old.startedAt);
    replies.codex = [end === "abgebrochen" ? { isError: true, text: "", aborted: true } : { isError: true, text: "", errorKind: "other" }];
    await s.turn(DM, undefined, { engine: "codex" });
    expect(await getSessionsForKey(key)).toEqual([]);
    expect(await takeHandover(key, "general", { preserveUntilRecorded: true })).toMatchObject({ since: old.startedAt });
    await s.turn(DM, undefined, { engine: "codex" });
    expect(calls[1].prompt).toContain("Erste Frage mit der Zahl 7319");
    expect(calls[1].prompt).toContain("Du übernimmst");
    expect(await takeHandover(key, "general")).toBeUndefined();
  });

  test("/stop im ersten Turn nach /motor: manuelle Notiz bleibt über einen Neustart erhalten", async () => {
    const old = await seed();
    await noteHandover(key, "user");
    await resetSession(key, undefined, { preserveHandover: true });
    const s = setup(); realPrompt(s, old.startedAt);
    replies.codex = [{ isError: true, text: "", aborted: true }];
    await s.turn(DM, undefined, { engine: "codex" });
    setSessionsFileForTests(join(dir, "sessions.json"));
    expect(await takeHandover(key, "general", { preserveUntilRecorded: true })).toMatchObject({ since: old.startedAt, reason: "user" });
    await s.turn(DM, undefined, { engine: "codex" });
    expect(calls[1].prompt).toContain("Grund (Wahl des Nutzers)");
    expect(calls[1].prompt).toContain("Erste Frage mit der Zahl 7319");
    expect(await takeHandover(key, "general")).toBeUndefined();
  });

  test("alle Stufen scheitern nach Resume: Beginn bleibt für nächsten Turn, Fallback bekommt nur zehn", async () => {
    await putSettings({ engine: { backups: [{ engine: "codex" }] } });
    const old = await seed();
    const s = setup(); realPrompt(s, old.startedAt);
    replies.claude = [{ isError: true, text: "", errorKind: "quota" }];
    replies.codex = [{ isError: true, text: "", errorKind: "quota" }];
    await s.turn(DM);
    expect(await getSessionsForKey(key)).toEqual([]);
    expect(await takeHandover(key, "general", { preserveUntilRecorded: true })).toMatchObject({ since: old.startedAt });
    expect(s.fallbackContexts[0]).not.toContain("Erste Frage mit der Zahl 7319");
    expect(s.fallbackContexts[0]).not.toContain("Du übernimmst");
    expect(s.fallbackContexts[0]).toContain("Der vorige Versuch");
    await updateSwitchState(() => ({ version: 1, blocks: [], counters: [] }));
    await s.turn(DM);
    expect(calls[2].prompt).toContain("Erste Frage mit der Zahl 7319");
    expect(await takeHandover(key, "general")).toBeUndefined();
  });

  test.each(["/new", "Ruhezeit", "alte Notiz", "ohne Session-Modus", "keine alte Session"] as const)("keine Übergabe: %s", async scenario => {
    const old = await seed();
    if (scenario === "/new") { await noteHandover(key, "user"); await resetSession(key); }
    if (scenario === "Ruhezeit") {
      const file = join(dir, "sessions.json");
      await writeFile(file, JSON.stringify({ [old.key]: { ...old, lastActivity: Date.now() - SESSION_IDLE_MS - 1 } }));
      setSessionsFileForTests(file);
    }
    if (scenario === "alte Notiz") {
      await resetSession(key);
      await retainHandover(key, { agentName: "general", engine: "claude", model: AGENT_MODEL, since: old.startedAt, notedAt: Date.now() - SESSION_IDLE_MS - 1, reason: "user" });
    }
    if (scenario === "keine alte Session") await resetSession(key);
    const s = setup({ sessionMode: scenario !== "ohne Session-Modus" });
    const sources = realPrompt(s, old.startedAt);
    await s.turn(DM, undefined, { engine: "codex" });
    const expected = await buildPromptContext({ userMessage: "Frage?", chatId: DM, agentName: "general" }, sources);
    expect(calls[0].prompt).toBe(expected.fullPrompt);
  });
});

describe("Standard bleibt Claude", () => {
  test("ohne Einstellung und ohne TYBO_ENGINE: Claude mit Agenten-Modell, keine Prüfung, keine Meldung", async () => {
    const s = setup();
    expect(await s.turn(DM)).toBe("antwort-claude");
    expect(calls.map((c) => c.engine)).toEqual(["claude"]);
    expect(calls[0].model).toBe(AGENT_MODEL);
    expect(calls[0].effort).toBe("high");
    expect(checks).toBe(0);
    expect(s.notices).toEqual([]);
    expect(s.infos).toEqual([{ agent: "general", model: AGENT_MODEL, engine: "claude", durationMs: 0 }]);
  });
});

describe("Motor pro Gespräch", () => {
  test("engine.default = codex schickt Turns an Codex, mit Modell und Effort aus engine.codex", async () => {
    await putSettings({ engine: { default: "codex", codex: { model: "gpt-5.6-sol", effort: "max" } } });
    const s = setup();
    expect(await s.turn(DM)).toBe("antwort-codex");
    expect(calls).toHaveLength(1);
    expect(calls[0].engine).toBe("codex");
    expect(calls[0].model).toBe("gpt-5.6-sol");
    expect(calls[0].effort).toBe("max");
    expect(s.infos[0]).toMatchObject({ engine: "codex", model: "gpt-5.6-sol" });
    expect(s.metas).toEqual([{ engine: "codex", model: "gpt-5.6-sol" }]);
  });

  test("Codex ohne Angaben: weder Modell noch Effort, nie das Claude-Modell des Agenten", async () => {
    await putSettings({ engine: { default: "codex" }, defaults: { model: "claude-opus-5-5", effort: "low" } });
    const s = setup();
    await s.turn(DM);
    expect(calls[0].engine).toBe("codex");
    expect("model" in calls[0]).toBe(false);
    expect("effort" in calls[0]).toBe(false);
    // Keine Modellangabe erfunden; die Session steht unter "" (Standard des Motors)
    expect(s.infos[0].engine).toBe("codex");
    expect(s.infos[0].model).toBeUndefined();
    // "" am Rückfrage-Task: bewusst Standard, ein später gesetztes engine.codex.model gilt nicht rückwirkend
    expect(s.metas).toEqual([{ engine: "codex", model: "" }]);
    const [stored] = await getSessionsForKey(sessionKeyFor(DM));
    expect(stored).toMatchObject({ engine: "codex", model: "", engineSessionId: "codex-s1" });
  });

  test("engine.default = opencode schickt Turns an OpenCode, mit Modell und Variante aus engine.opencode (Issue #129)", async () => {
    await putSettings({ engine: { default: "opencode", opencode: { model: "openai/gpt-5.5", variant: "high" } } });
    const s = setup();
    expect(await s.turn(DM)).toBe("antwort-opencode");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ engine: "opencode", model: "openai/gpt-5.5", effort: "high" });
    expect(s.notices).toEqual([]);
    expect(s.infos[0]).toMatchObject({ engine: "opencode", model: "openai/gpt-5.5" });
    expect(s.metas).toEqual([{ engine: "opencode", model: "openai/gpt-5.5" }]);
    // Folgeturn setzt die OpenCode-Session fort
    await s.turn(DM);
    expect(calls[1]).toMatchObject({ engine: "opencode", resumeSessionId: "opencode-s1" });
  });

  test("OpenCode ohne Modell: kein Modell im Auftrag, Session unter \"\" (Standard von OpenCode) (Issue #129)", async () => {
    await putSettings({ engine: { default: "opencode" }, defaults: { model: "claude-opus-5-5", effort: "low" } });
    const s = setup();
    await s.turn(DM);
    expect(calls[0].engine).toBe("opencode");
    expect("model" in calls[0]).toBe(false);
    expect("effort" in calls[0]).toBe(false);
    expect(s.infos[0].model).toBeUndefined();
    expect(s.metas).toEqual([{ engine: "opencode", model: "" }]);
  });

  test("/motor opencode in Topic A lässt Topic B beim Standard Codex (Issue #129)", async () => {
    await putSettings({ engine: { default: "codex" } });
    await setTopicEngine(KEY_A, "opencode");
    const s = setup();
    await s.turn(CHAT, TOPIC_A);
    await s.turn(CHAT, TOPIC_B);
    await s.turn(DM);
    expect(calls.map((c) => [c.engine, c.abortKey])).toEqual([
      ["opencode", KEY_A],
      ["codex", KEY_B],
      ["codex", sessionKeyFor(DM)],
    ]);
    expect(getSettings().engine?.topics).toEqual({ [KEY_A]: "opencode" });
  });

  test("TYBO_ENGINE=opencode ohne Einstellungsdatei (Issue #129)", async () => {
    env = { TYBO_ENGINE: "opencode" };
    const s = setup();
    await s.turn(DM);
    expect(calls[0].engine).toBe("opencode");
  });

  test("TYBO_ENGINE=codex ohne Einstellungsdatei", async () => {
    env = { TYBO_ENGINE: "codex" };
    const s = setup();
    await s.turn(DM);
    expect(calls[0].engine).toBe("codex");
  });

  test("/motor claude in Topic A lässt Topic B bei Codex", async () => {
    await putSettings({ engine: { default: "codex" } });
    await setTopicEngine(KEY_A, "claude");
    const s = setup();
    await s.turn(CHAT, TOPIC_A);
    await s.turn(CHAT, TOPIC_B);
    expect(calls.map((c) => [c.engine, c.abortKey])).toEqual([
      ["claude", KEY_A],
      ["codex", KEY_B],
    ]);
  });

  test("Direktchat und Web-Gespräch nehmen ihre eigene Ausnahme", async () => {
    await setTopicEngine(sessionKeyFor(DM), "codex");
    await setTopicEngine(WEB, "codex");
    const s = setup();
    await s.turn(DM);
    await s.turn(WEB);
    await s.turn("99");
    expect(calls.map((c) => c.engine)).toEqual(["codex", "codex", "claude"]);
  });

  test("Hot-Reload: geänderte Datei gilt ab dem nächsten Turn, eine ungültige lässt die letzte gültige Fassung aktiv", async () => {
    const s = setup();
    await s.turn(DM);
    await putSettings({ engine: { default: "codex" } });
    await s.turn(DM);
    await putSettings({ engine: { default: "gemini" } } as unknown as Settings);
    await s.turn(DM);
    await putSettings("{ kaputt");
    await s.turn(DM);
    await putSettings({ engine: { default: "claude" } });
    await s.turn(DM);
    expect(calls.map((c) => c.engine)).toEqual(["claude", "codex", "codex", "codex", "claude"]);
  });

  test("ausdrückliches TurnOptions.engine schlägt die Einstellung", async () => {
    await putSettings({ engine: { default: "codex" } });
    const s = setup();
    await s.turn(DM, undefined, { engine: "claude" });
    expect(calls.map((c) => c.engine)).toEqual(["claude"]);
    expect(checks).toBe(0);
  });
});

describe("Motorwechsel und Sessions", () => {
  test("ein Wechsel des Standards startet eine neue Session, die alte wird über ihren Motor destilliert", async () => {
    const s = setup();
    await s.turn(DM);
    await s.turn(DM);
    expect(calls.map((c) => [c.engine, c.resumeSessionId])).toEqual([
      ["claude", undefined],
      ["claude", "claude-s1"],
    ]);
    await putSettings({ engine: { default: "codex" } });
    await s.turn(DM);
    expect(calls[2].engine).toBe("codex");
    expect(calls[2].resumeSessionId).toBeUndefined();
    expect(calls[2].prompt).toBe("voller-prompt");
    expect(s.distilled.map((x) => x.engine)).toEqual(["claude"]);
    await s.turn(DM);
    expect(calls[3]).toMatchObject({ engine: "codex", resumeSessionId: "codex-s1" });
  });

  test("nach /motor standard zurück auf Claude: frische Session, die Codex-Session wird destilliert", async () => {
    await setTopicEngine(KEY_A, "codex");
    const s = setup();
    await s.turn(CHAT, TOPIC_A);
    await setTopicEngine(KEY_A, null);
    await s.turn(CHAT, TOPIC_A);
    expect(calls.map((c) => [c.engine, c.resumeSessionId])).toEqual([
      ["codex", undefined],
      ["claude", undefined],
    ]);
    expect(s.distilled.map((x) => x.engine)).toEqual(["codex"]);
  });

  test("ein geändertes Codex-Modell startet ebenfalls frisch", async () => {
    await putSettings({ engine: { default: "codex", codex: { model: "m1" } } });
    const s = setup();
    await s.turn(DM);
    await putSettings({ engine: { default: "codex", codex: { model: "m2" } } });
    await s.turn(DM);
    expect(calls.map((c) => [c.model, c.resumeSessionId])).toEqual([
      ["m1", undefined],
      ["m2", undefined],
    ]);
  });
});

describe("Verfügbarkeit", () => {
  test("nicht angemeldetes Codex: Claude antwortet, genau eine Meldung über mehrere Turns", async () => {
    await putSettings({ engine: { default: "codex" } });
    status = NOT_LOGGED_IN;
    const s = setup();
    expect(await s.turn(DM)).toBe("antwort-claude");
    expect(await s.turn(DM)).toBe("antwort-claude");
    expect(calls.map((c) => c.engine)).toEqual(["claude", "claude"]);
    expect(calls[0].model).toBe(AGENT_MODEL);
    expect(s.notices).toEqual([
      "Codex ist nicht verfügbar, ich antworte mit Claude Code. Codex ist nicht angemeldet: im Terminal `codex login` ausführen",
    ]);
    expect(s.infos.map((i) => i.engine)).toEqual(["claude", "claude"]);
  });

  test("nicht installiertes OpenCode: Claude antwortet, genau eine Meldung je Gespräch über mehrere Turns (Issue #129)", async () => {
    await putSettings({ engine: { default: "opencode", opencode: { model: "openai/gpt-5.5" } } });
    status = { engine: "opencode", checked: true, installed: false, loggedIn: false, message: "OpenCode ist nicht installiert" };
    const s = setup();
    expect(await s.turn(DM)).toBe("antwort-claude");
    expect(await s.turn(DM)).toBe("antwort-claude");
    expect(await s.turn(DM)).toBe("antwort-claude");
    expect(calls.map((c) => c.engine)).toEqual(["claude", "claude", "claude"]);
    // Claude bekommt sein Agenten-Modell, nie das OpenCode-Modell
    expect(calls.map((c) => c.model)).toEqual([AGENT_MODEL, AGENT_MODEL, AGENT_MODEL]);
    expect(s.notices).toEqual(["OpenCode ist nicht verfügbar, ich antworte mit Claude Code. OpenCode ist nicht installiert"]);
    expect(s.infos.map((i) => i.engine)).toEqual(["claude", "claude", "claude"]);
    // Ein anderes Gespräch bekommt seine eigene, einzige Meldung
    await s.turn(WEB);
    await s.turn(WEB);
    expect(s.notices).toHaveLength(2);
    // Nach der Ausfallphase (installiert, Lauf gelingt) meldet ein neuer Ausfall wieder
    status = READY;
    expect(await s.turn(DM)).toBe("antwort-opencode");
    status = { engine: "opencode", checked: true, installed: false, loggedIn: false, message: "OpenCode ist nicht installiert" };
    await s.turn(DM);
    await s.turn(DM);
    expect(s.notices).toHaveLength(3);
  });

  test("nicht installiertes Codex: ebenso Claude mit Meldung", async () => {
    await putSettings({ engine: { default: "codex" } });
    status = { engine: "codex", checked: true, installed: false, loggedIn: false, message: "Codex ist nicht installiert" };
    const s = setup();
    await s.turn(DM);
    expect(calls.map((c) => c.engine)).toEqual(["claude"]);
    expect(s.notices).toHaveLength(1);
    expect(s.notices[0]).toStartWith("Codex ist nicht verfügbar, ich antworte mit Claude Code.");
  });

  test("Anmeldefehler erst beim Lauf: sofort Claude frisch, eine Meldung, Prüfergebnis verworfen, keine Fallback-Kette", async () => {
    await putSettings({ engine: { default: "codex" } });
    replies.codex = [{ isError: true, text: "401", errorKind: "auth", sessionId: undefined }];
    const s = setup();
    expect(await s.turn(DM)).toBe("antwort-claude");
    expect(calls.map((c) => [c.engine, c.prompt, c.model])).toEqual([
      ["codex", "voller-prompt", undefined],
      ["claude", "voller-prompt", AGENT_MODEL],
    ]);
    expect(forgets).toBe(1);
    expect(s.fallbackCalls).toEqual([]);
    expect(s.notices).toEqual(["Codex ist nicht verfügbar, ich antworte mit Claude Code. Codex ist nicht angemeldet."]);
    expect(s.infos[0]).toMatchObject({ engine: "claude", model: AGENT_MODEL });
    const [stored] = await getSessionsForKey(sessionKeyFor(DM));
    expect(stored).toMatchObject({ engine: "claude", engineSessionId: "claude-s1", model: AGENT_MODEL });
  });

  test("Vorprüfung bereit, Lauf meldet auth, zwei Turns: beide über Claude, genau ein Hinweis; nach gelungenem Codex-Lauf wird ein neuer Ausfall wieder gemeldet", async () => {
    await putSettings({ engine: { default: "codex" } });
    const auth = { isError: true, text: "401", errorKind: "auth" as const, sessionId: undefined };
    replies.codex = [auth, auth];
    const s = setup();
    expect(await s.turn(DM)).toBe("antwort-claude");
    expect(await s.turn(DM)).toBe("antwort-claude");
    // Jeder Turn hat vorher geprüft (Attrappe: bereit) und Codex versucht
    expect(checks).toBe(2);
    expect(calls.map((c) => c.engine)).toEqual(["codex", "claude", "codex", "claude"]);
    expect(s.infos.map((i) => i.engine)).toEqual(["claude", "claude"]);
    expect(s.notices).toEqual(["Codex ist nicht verfügbar, ich antworte mit Claude Code. Codex ist nicht angemeldet."]);

    // Wiederherstellung nachgewiesen: Codex antwortet selbst, ohne Hinweis
    expect(await s.turn(DM)).toBe("antwort-codex");
    expect(s.notices).toHaveLength(1);

    // Späterer Ausfall: wieder gemeldet
    replies.codex = [auth];
    expect(await s.turn(DM)).toBe("antwort-claude");
    expect(s.notices).toEqual([
      "Codex ist nicht verfügbar, ich antworte mit Claude Code. Codex ist nicht angemeldet.",
      "Codex ist nicht verfügbar, ich antworte mit Claude Code. Codex ist nicht angemeldet.",
    ]);
  });

  test("Vorprüfung meldet nicht bereit, dann Lauf-Ausfall trotz bereiter Prüfung: kein zweiter Hinweis", async () => {
    await putSettings({ engine: { default: "codex" } });
    status = NOT_LOGGED_IN;
    const s = setup();
    await s.turn(DM);
    status = READY;
    replies.codex = [{ isError: true, text: "401", errorKind: "auth", sessionId: undefined }];
    await s.turn(DM);
    // Die positive Prüfung hob die Sperre der Vorprüfung auf, der Lauf-Ausfall meldet einmal
    expect(s.notices).toHaveLength(2);
    replies.codex = [{ isError: true, text: "401", errorKind: "auth", sessionId: undefined }];
    await s.turn(DM);
    expect(s.notices).toHaveLength(2);
  });

  test("Anmeldefehler beim Fortsetzen: Claude bekommt den vollen Prompt, nicht den schlanken", async () => {
    await putSettings({ engine: { default: "codex" } });
    const s = setup();
    await s.turn(DM);
    replies.codex = [{ isError: true, text: "401", errorKind: "auth", sessionId: undefined }];
    await s.turn(DM);
    expect(calls.map((c) => [c.engine, c.prompt, c.resumeSessionId])).toEqual([
      ["codex", "voller-prompt", undefined],
      ["codex", "resume-prompt", "codex-s1"],
      ["claude", "voller-prompt", undefined],
    ]);
  });
});

describe("Ausfall des Motors", () => {
  test("Codex-Fehler führt zur Fallback-Kette, der Hinweis nennt den Motor, TurnInfo nennt das Ersatzmodell ohne Motor", async () => {
    await putSettings({ engine: { default: "codex" } });
    replies.codex = [{ isError: true, text: "kaputt", errorKind: "usage_limit", sessionId: undefined }];
    const s = setup();
    const reply = await s.turn(DM);
    expect(reply).toContain("ersatz-antwort");
    expect(s.fallbackCalls).toEqual(["Frage?"]);
    expect(calls.map((c) => c.engine)).toEqual(["codex"]);
    expect(s.notices).toEqual([engineFailedNotice("codex", "usage_limit")]);
    expect(s.notices[0]).toBe("Codex hat keine Antwort geliefert (Nutzungsgrenze erreicht), es antwortet das Ersatzmodell.");
    expect(s.infos).toEqual([{ agent: "general", model: "ersatz-modell", durationMs: 0 }]);
    expect(String(s.logs[0][2])).toContain("Codex");
    expect(s.logs[0][3]).toMatchObject({ engine: "codex", errorKind: "usage_limit" });
  });

  test("leere Codex-Antwort ebenso", async () => {
    await putSettings({ engine: { default: "codex" } });
    replies.codex = [{ text: "" }];
    const s = setup();
    expect(await s.turn(DM)).toContain("ersatz-antwort");
    expect(s.notices).toEqual(["Codex hat keine Antwort geliefert, es antwortet das Ersatzmodell."]);
  });

  test("fehlgeschlagenes Fortsetzen: erst neuer Codex-Versuch ohne Resume, dann Fallback-Kette", async () => {
    await putSettings({ engine: { default: "codex" } });
    const s = setup();
    await s.turn(DM);
    replies.codex = [
      { isError: true, text: "session weg", errorKind: "other", sessionId: undefined },
      { isError: true, text: "immer noch", errorKind: "other", sessionId: undefined },
    ];
    expect(await s.turn(DM)).toContain("ersatz-antwort");
    expect(calls.map((c) => [c.engine, c.resumeSessionId])).toEqual([
      ["codex", undefined],
      ["codex", "codex-s1"],
      ["codex", undefined],
    ]);
    expect(s.fallbackCalls).toHaveLength(1);
  });

  test("Abbruch: kein neuer Versuch, kein Fallback, kein Wechsel", async () => {
    await putSettings({ engine: { default: "codex" } });
    replies.codex = [{ isError: true, text: "", aborted: true, sessionId: undefined }];
    const s = setup();
    expect(await s.turn(DM)).toBe(ABORT_REPLY);
    expect(calls).toHaveLength(1);
    expect(s.fallbackCalls).toEqual([]);
    expect(s.infos).toEqual([]);
  });

  test("Zeitlimit: Stand-Bericht nennt Codex, kein Fallback, kein Wechsel", async () => {
    await putSettings({ engine: { default: "codex" } });
    replies.codex = [{ isError: true, text: "", timedOut: true, timeoutKind: "idle", steps: [], sessionId: undefined, errorKind: "auth" }];
    const s = setup();
    const reply = await s.turn(DM);
    expect(reply).toContain("Codex wurde");
    expect(reply).not.toContain("Claude");
    expect(calls).toHaveLength(1);
    expect(s.fallbackCalls).toEqual([]);
  });
});

describe("Claude Code fehlt (Issue #565)", () => {
  const MISSING = {
    isError: true,
    text: "Claude Code konnte nicht gestartet werden (claude nicht im PATH des Dienstes, code=ENOENT).",
    errorKind: "not_installed" as const,
    sessionId: undefined,
  };

  test("Fallback-Kette antwortet, der Hinweis kommt einmal über mehrere Turns", async () => {
    replies.claude = [MISSING, MISSING, MISSING];
    const s = setup();
    for (let i = 0; i < 3; i++) expect(await s.turn(DM)).toContain("ersatz-antwort");
    // Kein neuer Versuch: je Turn genau ein Claude-Lauf, danach die Kette
    expect(calls.map((c) => c.engine)).toEqual(["claude", "claude", "claude"]);
    expect(s.fallbackCalls).toEqual(["Frage?", "Frage?", "Frage?"]);
    expect(s.notices).toEqual([CLAUDE_NOT_INSTALLED_NOTICE]);
    expect(s.infos.map((i) => i.model)).toEqual(["ersatz-modell", "ersatz-modell", "ersatz-modell"]);
    // Die Diagnose steht im Log, nur aus kontrollierten Feldern
    expect(s.logs[0][3]).toMatchObject({ engine: "claude", errorKind: "not_installed", error: MISSING.text });
  });

  test("getrennte Gespräche bekommen den Hinweis je einmal", async () => {
    replies.claude = [MISSING, MISSING, MISSING, MISSING];
    const s = setup();
    await s.turn(CHAT, TOPIC_A);
    await s.turn(CHAT, TOPIC_B);
    await s.turn(WEB);
    await s.turn(CHAT, TOPIC_A);
    expect(s.notices).toEqual([CLAUDE_NOT_INSTALLED_NOTICE, CLAUDE_NOT_INSTALLED_NOTICE, CLAUDE_NOT_INSTALLED_NOTICE]);
    expect(s.fallbackCalls).toHaveLength(4);
  });

  test("beim Fortsetzen: kein frischer Neuversuch, Session bleibt, das Ersatzmodell bekommt den vollen Kontext", async () => {
    const s = setup();
    expect(await s.turn(DM)).toBe("antwort-claude");
    replies.claude = [MISSING];
    expect(await s.turn(DM)).toContain("ersatz-antwort");
    expect(calls.map((c) => [c.engine, c.prompt, c.resumeSessionId])).toEqual([
      ["claude", "voller-prompt", undefined],
      ["claude", "resume-prompt", "claude-s1"],
    ]);
    expect(s.fallbackContexts).toEqual(["kontext"]);
    const [stored] = await getSessionsForKey(sessionKeyFor(DM));
    expect(stored).toMatchObject({ engine: "claude", engineSessionId: "claude-s1" });
    expect(s.notices).toEqual([CLAUDE_NOT_INSTALLED_NOTICE]);
  });

  test("Codex nicht bereit, Claude fehlt: Ersatzkette, beide Hinweise je einmal", async () => {
    await putSettings({ engine: { default: "codex" } });
    status = { engine: "codex", checked: true, installed: false, loggedIn: false, message: "Codex ist nicht installiert" };
    replies.claude = [MISSING, MISSING];
    const s = setup();
    expect(await s.turn(DM)).toContain("ersatz-antwort");
    expect(await s.turn(DM)).toContain("ersatz-antwort");
    expect(calls.map((c) => c.engine)).toEqual(["claude", "claude"]);
    expect(s.notices).toEqual(["Codex ist nicht verfügbar, ich antworte mit Claude Code. Codex ist nicht installiert", CLAUDE_NOT_INSTALLED_NOTICE]);
    expect(s.fallbackContexts).toEqual(["kontext", "kontext"]);
  });

  test("Codex scheitert beim Lauf, Claude fehlt: Ersatzkette statt Wurf", async () => {
    await putSettings({ engine: { default: "codex" } });
    replies.codex = [{ isError: true, text: "codex fehlt", errorKind: "not_installed", sessionId: undefined }];
    replies.claude = [MISSING];
    const s = setup();
    expect(await s.turn(DM)).toContain("ersatz-antwort");
    expect(calls.map((c) => [c.engine, c.prompt])).toEqual([
      ["codex", "voller-prompt"],
      ["claude", "voller-prompt"],
    ]);
    expect(s.notices).toEqual(["Codex ist nicht verfügbar, ich antworte mit Claude Code. Codex ist nicht installiert.", CLAUDE_NOT_INSTALLED_NOTICE]);
    expect(s.fallbackCalls).toHaveLength(1);
  });

  test("nach einem gelungenen Claude-Lauf wird ein neuer Ausfall wieder gemeldet", async () => {
    replies.claude = [MISSING, { text: "wieder da" }, MISSING];
    const s = setup();
    await s.turn(DM);
    expect(await s.turn(DM)).toBe("wieder da");
    await s.turn(DM);
    expect(s.notices).toEqual([CLAUDE_NOT_INSTALLED_NOTICE, CLAUDE_NOT_INSTALLED_NOTICE]);
  });

  test("ein anderer Claude-Fehler bleibt still wie bisher", async () => {
    replies.claude = [{ isError: true, text: "kaputt", sessionId: undefined }];
    const s = setup({ sessionMode: false });
    expect(await s.turn(DM)).toContain("ersatz-antwort");
    expect(s.notices).toEqual([]);
  });

  test("Abbruch bleibt ohne Ersatzkette und ohne Hinweis", async () => {
    replies.claude = [{ ...MISSING, aborted: true }];
    const s = setup();
    expect(await s.turn(DM)).toBe(ABORT_REPLY);
    expect(s.fallbackCalls).toEqual([]);
    expect(s.notices).toEqual([]);
  });

  describe.each(["linux", "darwin"] as const)("echter Claude-Motor auf %s, Start ohne Programm", (os) => {
    beforeAll(() => {
      setMcpReaderForTests(() => new Set());
      setRuntimeForTests({ os, terminate: () => {} });
      // Linux wirft beim Start, macOS startet caffeinate, das mit 127 endet
      setSpawnForTests(((o: { cmd: string[] }) => {
        if (o.cmd[0] !== "/usr/bin/caffeinate") throw Object.assign(new Error('Executable not found in $PATH: "claude"'), { code: "ENOENT" });
        const empty = new ReadableStream<Uint8Array>({ start: (c) => c.close() });
        return { pid: 0, stdin: { write() {}, end() {} }, stdout: empty, stderr: new ReadableStream({ start: (c) => c.close() }), exited: Promise.resolve(127), kill() {} };
      }) as any);
    });
    afterAll(() => {
      setSpawnForTests(null);
      setRuntimeForTests(null);
      setMcpReaderForTests(null);
    });

    for (const [name, run] of [
      ["streaming", runStreamingTurn],
      ["json", runJsonTurn],
    ] as const) {
      test(`${name}: kein Wurf bis zum Kanal, Ersatzkette und Hinweis`, async () => {
        const s = setup({ sessionMode: false });
        const notices: string[] = [];
        const reply = await run({ userMessage: "x", chatId: DM, agentName: "general", sink: { progress() {}, notice: (t) => void notices.push(t) }, deps: { ...s.deps, getEngine } });
        expect(reply).toContain("ersatz-antwort");
        expect(notices).toEqual([CLAUDE_NOT_INSTALLED_NOTICE]);
        expect(s.fallbackCalls).toEqual(["x"]);
      });
    }
  });

  test("JSON-Turn verhält sich gleich", async () => {
    replies.claude = [MISSING];
    const s = setup();
    const reply = await runJsonTurn({ userMessage: "Frage?", chatId: DM, agentName: "general", sink: { progress: () => {}, notice: (t) => void s.notices.push(t) }, deps: s.deps });
    expect(reply).toContain("ersatz-antwort");
    expect(s.notices).toEqual([CLAUDE_NOT_INSTALLED_NOTICE]);
  });
});

describe("JSON-Turn", () => {
  test("wählt den Motor genauso", async () => {
    await putSettings({ engine: { default: "codex" } });
    const s = setup();
    await runJsonTurn({ userMessage: "x", chatId: DM, agentName: "general", sink: { progress() {}, notice() {} }, deps: s.deps });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ engine: "codex", streaming: false });
  });
});

// ---------------------------------------------------------------------------
// Gleiche Kommandozeile wie vorher: der echte Claude-Motor mit einer
// Start-Attrappe. Ohne Einstellung und ohne TYBO_ENGINE entsteht dieselbe
// Kommandozeile wie mit ausdrücklich gewähltem Claude (der Weg vor #125).
// ---------------------------------------------------------------------------
describe("Kommandozeile unverändert", () => {
  const spawned: string[][] = [];
  const stream = (text: string) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode(text));
        c.close();
      },
    });
  const RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "fertig", session_id: "s1" }) + "\n";
  beforeAll(() => {
    setMcpReaderForTests(() => new Set());
    setSpawnForTests(((o: { cmd: string[] }) => {
      spawned.push(o.cmd);
      return {
        pid: 0,
        stdin: { write() {}, end() {} },
        stdout: stream(o.cmd.includes("stream-json") ? RESULT : JSON.stringify({ result: "fertig", session_id: "s1" })),
        stderr: stream(""),
        exited: Promise.resolve(0),
        kill() {},
      };
    }) as any);
  });
  afterAll(() => {
    setSpawnForTests(null);
    setMcpReaderForTests(null);
  });

  for (const [name, run] of [
    ["streaming", runStreamingTurn],
    ["json", runJsonTurn],
  ] as const) {
    test(`${name}: gleiche Argumente wie mit ausdrücklichem Claude, ohne Prüfung`, async () => {
      const s = setup({ sessionMode: false });
      const deps = { ...s.deps, getEngine };
      const base = { userMessage: "x", chatId: DM, agentName: "general", sink: { progress() {}, notice() {} }, deps };
      spawned.length = 0;
      await run(base);
      await run({ ...base, engine: "claude" });
      expect(spawned).toHaveLength(2);
      expect(spawned[0]).toEqual(spawned[1]);
      expect(spawned[0]).toContain(AGENT_MODEL);
      expect(checks).toBe(0);
    });
  }
});

// ---------------------------------------------------------------------------
// Goal-Engine, [INVOKE:], /board und agentTurn laufen über runStreamingTurn
// bzw. runJsonTurn. Keiner dieser Aufrufe darf einen Motor fest vorgeben,
// sonst nähme er nicht den Motor des Gesprächs.
// ---------------------------------------------------------------------------
describe("Anbindung aller Turn-Wege", () => {
  function sourceFiles(root: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const p = join(root, entry.name);
      if (entry.isDirectory()) out.push(...sourceFiles(p));
      else if (entry.name.endsWith(".ts")) out.push(p);
    }
    return out;
  }

  /** Argument-Objekt eines Aufrufs name({ ... }) per Klammerzählung */
  function callArgs(source: string, name: string): string[] {
    const found: string[] = [];
    let at = source.indexOf(`${name}({`);
    while (at >= 0) {
      let depth = 0;
      let i = at + name.length + 1;
      const start = i;
      for (; i < source.length; i++) {
        if (source[i] === "{") depth++;
        else if (source[i] === "}" && --depth === 0) break;
      }
      found.push(source.slice(start, i + 1));
      at = source.indexOf(`${name}({`, i);
    }
    return found;
  }

  // Entscheidung 0018: WhatsApp bleibt bei Claude. Der Besitzer-Turn dort
  // (Issue #345) gibt deshalb ausdrücklich Claude vor, sonst niemand.
  const FIXED_CLAUDE = new Set([join("channels", "whatsapp", "owner-turn.ts")]);

  test("kein Aufruf von runStreamingTurn/runJsonTurn in src gibt engine vor (außer WhatsApp: Claude)", () => {
    const root = join(import.meta.dir, "..", "src");
    let seen = 0;
    let fixed = 0;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      const allowed = FIXED_CLAUDE.has(relative(root, file));
      for (const name of ["runStreamingTurn", "runJsonTurn"]) {
        for (const args of callArgs(source, name)) {
          seen++;
          if (allowed) {
            // Genau Claude, nichts anderes
            expect({ file, engines: args.match(/\bengine\s*:[^,\n}]*/g) }).toEqual({ file, engines: ['engine: "claude"'] });
            fixed++;
            continue;
          }
          // Nur Schlüssel auf oberster Ebene zählen nicht; jede engine-Angabe wäre verdächtig
          expect({ file, args: /\bengine\s*:/.test(args) }).toEqual({ file, args: false });
        }
      }
    }
    expect(fixed).toBe(1);
    // bot.ts (Telegram, Goal-Engine, /board), Web-Chat, [INVOKE:], Web-Befehle
    expect(seen).toBeGreaterThanOrEqual(6);
  });
});

// M14-06: echte Zustands-/Sessiondateien im Temp-Ordner, ausschließlich Motorattrappen.
describe("Stufe je Turn nach der Wechselregel", () => {
  const FABLE = "claude-fable-5-2";
  const OPUS = "claude-opus-5-5";
  let now: number;
  const config = (): Settings => ({ defaults: { model: FABLE, effort: "high" }, engine: { backups: [{ engine: "codex" }] } });
  const block = (engine: EngineId, extra: Partial<SwitchBlock> = {}): SwitchBlock => ({
    engine, cause: "limit", since: new Date(now - 1000).toISOString(), until: new Date(now + 600_000).toISOString(), resetKnown: true, ...extra,
  } as SwitchBlock);
  const measurement = (id: UsageWindowId = "weekly_all") => ({ windows: [{
    id, percent: 96, source: "stream" as const, measuredAt: new Date(now).toISOString(), resetsAt: new Date(now + 600_000).toISOString(),
  }] });
  const readyTurn = (sessionMode = true, mode: "streaming" | "json" = "streaming") => {
    const s = setup({ sessionMode, mode });
    s.deps.now = () => now;
    return s;
  };
  const blockAll = async () => { await updateSwitchState(state => ({ ...state, blocks: [block("claude"), block("codex")] })); };

  beforeEach(async () => {
    now = Date.now();
    await putSettings(config());
  });

  for (const sessionMode of [false, true]) {
    test(`Hinweis je Gespräch und Rückwechsel je einmal, Session-Modus ${sessionMode}`, async () => {
      const s = readyTurn(sessionMode);
      if (sessionMode) for (const key of [KEY_A, KEY_B]) await recordSessionTurn(key, "general", FABLE, "claude", `alt-${key}`);
      await updateSwitchState(state => ({ ...state, blocks: [block("claude")] }));
      const sent: string[] = [];
      setSwitchNotifier(async text => { sent.push(text); return { outcome: "delivered", delivered: true, telegram: [] }; }, { getSettings, now: () => now });
      await Promise.all([s.turn(CHAT, TOPIC_A), s.turn(CHAT, TOPIC_B)]);
      await settleSwitchNoticesForTests();
      const suffix = sessionMode ? " Der Verlauf ist übergeben." : "";
      expect(s.notices).toEqual(Array(2).fill(`Hier antwortet jetzt Codex statt Claude Code (Limit erreicht).${suffix}`));
      expect(sent).toHaveLength(1);
      await s.turn(CHAT, TOPIC_A); await s.turn(CHAT, TOPIC_B);
      expect(s.notices).toHaveLength(2);
      await updateSwitchState(state => ({ ...state, blocks: [] }));
      await s.turn(CHAT, TOPIC_A); await s.turn(CHAT, TOPIC_B);
      await s.turn(CHAT, TOPIC_A);
      await settleSwitchNoticesForTests();
      expect(s.notices.slice(2)).toEqual(Array(2).fill(`Hier antwortet wieder Claude Code.${suffix}`));
      expect(readSwitchState().notices?.hinted).toEqual({});
      expect(sent).toHaveLength(2);
    });
  }

  test("ohne Meldeweg: Hinweis, wartende Meldung ohne Anspruch, Neustart wiederholt den Hinweis nicht", async () => {
    const s = readyTurn(false);
    await updateSwitchState(state => ({ ...state, blocks: [block("claude")] }));
    await s.turn(CHAT, TOPIC_A);
    await settleSwitchNoticesForTests();
    expect(s.notices).toEqual(["Hier antwortet jetzt Codex statt Claude Code (Limit erreicht)."]);
    expect(readSwitchState().notices?.pending).toHaveLength(1);
    expect(readSwitchState().notices?.pending?.[0].claimedAt).toBeUndefined();
    resetSwitchNotifyForTests();
    setSwitchStateFileForTests(join(dir, "switch.json"), 20);
    await s.turn(CHAT, TOPIC_A);
    expect(s.notices).toHaveLength(1);
  });

  test("Vorprüfung ohne Session-Modus: genau der neue Ausfallhinweis", async () => {
    const s = readyTurn(false);
    s.deps.resolveEngine = (key, d, turn) => resolveEngine(key, { ...d,
      checkEngine: async engine => ({ engine, checked: true, installed: engine !== "claude", loggedIn: engine !== "claude" }),
    }, turn);
    expect(await s.turn(DM)).toBe("antwort-codex");
    expect(s.notices).toEqual(["Hier antwortet jetzt Codex statt Claude Code (Ausfall)."]);
  });

  test("ohne Ersatzstufen keine neue Meldung, kein Hinweis und keine Zustandsdatei", async () => {
    await putSettings({});
    const s = readyTurn(false);
    const sent: string[] = [];
    setSwitchNotifier(async text => { sent.push(text); return { outcome: "delivered", delivered: true, telegram: [] }; }, { getSettings });
    expect(await s.turn(DM)).toBe("antwort-claude");
    await settleSwitchNoticesForTests();
    expect(s.notices).toEqual([]);
    expect(sent).toEqual([]);
    expect(existsSync(join(dir, "switch.json"))).toBe(false);
  });

  test("/motor codex entfernt den Merker sofort, die nächste Codex-Antwort erhält keinen Hinweis", async () => {
    const s = readyTurn(false);
    await updateSwitchState(state => ({ ...state, blocks: [block("claude")] }));
    await s.turn(CHAT, TOPIC_A); await settleSwitchNoticesForTests();
    expect(readSwitchState().notices?.hinted?.[KEY_A]?.stage).toBe("codex");
    await setTopicEngine(KEY_A, "codex");
    await s.turn(CHAT, TOPIC_A); await settleSwitchNoticesForTests();
    expect(readSwitchState().notices?.hinted?.[KEY_A]).toBeUndefined();
    expect(s.notices).toHaveLength(1);
  });

  test("Einspringen im selben Turn: Hinweis vor neuer Antwort, keine alte Ausfallmeldung", async () => {
    const s = readyTurn(false);
    replies.claude = [{ text: "Fehler", isError: true, errorKind: "auth" }];
    const events: string[] = [];
    s.engines.codex = { ...fakeEngine("codex"), run: async () => { events.push("Antwort"); return { engine: "codex", text: "fertig", isError: false }; } };
    expect(await s.turn(DM, undefined, { sink: { progress() {}, notice: (text: string) => { events.push(text); } } })).toBe("fertig");
    expect(events).toEqual(["Hier antwortet jetzt Codex statt Claude Code (Ausfall).", "Antwort"]);
  });

  test("eine nie endende Zustellung lässt den Turn trotzdem zurückkommen", async () => {
    const s = readyTurn(false);
    await updateSwitchState(state => ({ ...state, blocks: [block("claude")] }));
    await checkSwitchNotices({ claude: { ...READY, engine: "claude" }, codex: READY }, { getSettings, now: () => now });
    await settleSwitchNoticesForTests();
    let sending = false;
    setSwitchNotifier(async () => { sending = true; return new Promise(() => {}); }, { getSettings, now: () => now });
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([s.turn(DM), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error("Turn wartet auf Zustellung")), 1000); })]);
      expect(reply).toBe("antwort-codex");
      expect(sending).toBe(true);
    } finally {
      clearTimeout(timeout);
      resetSwitchNotifyForTests();
    }
  });

  test("Schreibfehler kostet weder Antwort noch Hinweis und wiederholt ihn nicht", async () => {
    const s = readyTurn(false);
    await updateSwitchState(state => ({ ...state, blocks: [block("claude")] }));
    setSwitchStateWriterForTests(async () => { throw new Error("Datei nicht schreibbar"); });
    expect(await s.turn(DM)).toBe("antwort-codex");
    expect(await s.turn(DM)).toBe("antwort-codex");
    await settleSwitchNoticesForTests();
    expect(s.notices).toEqual(["Hier antwortet jetzt Codex statt Claude Code (Limit erreicht)."]);
    expect(readSwitchState().notices?.hinted?.[sessionKeyFor(DM)]?.stage).toBe("codex");
  });

  test("96 % erst nach Turn 1: Claude, dann Codex, nach Reset wieder Claude, jeweils neue Session", async () => {
    const s = readyTurn();
    replies.claude = [{ rateLimit: measurement() }];
    expect(await s.turn(DM)).toBe("antwort-claude");
    expect(calls).toHaveLength(1);
    expect(calls[0].streaming).toBe(true);
    expect(s.infos[0]).toMatchObject({ engine: "claude", stage: "claude", model: FABLE });
    expect(await s.turn(DM)).toBe("antwort-codex");
    expect(s.infos[1]).toMatchObject({ engine: "codex", stage: "codex" });
    expect(s.infos[1].reason).toContain("threshold (weekly_all)");
    now += 600_001;
    expect(await s.turn(DM)).toBe("antwort-claude");
    expect(calls.map(c => c.engine)).toEqual(["claude", "codex", "claude"]);
    expect(calls.every(c => !c.resumeSessionId && c.prompt === "voller-prompt")).toBe(true);
    expect(s.metas).toEqual([{ engine: "claude", model: FABLE }, { engine: "codex", model: "" }, { engine: "claude", model: FABLE }]);
    expect((await getSessionsForKey(sessionKeyFor(DM)))[0]).toMatchObject({ engine: "claude", model: FABLE, engineSessionId: "claude-s2", messageCount: 1 });
  });

  for (const speech of [false, true]) {
    test(`Teil-Limit Fable: tatsächliches Modell und Effort der Opus-Ersatzstufe${speech ? ", trotz gesprochenem Fable-Turn" : ""}`, async () => {
      await putSettings({ defaults: { model: FABLE, effort: "high" }, engine: { backups: [{ engine: "claude", model: OPUS, effort: "medium" }, { engine: "codex" }] } });
      const s = readyTurn();
      replies.claude = [{ rateLimit: measurement("weekly_scoped:fable") }];
      await s.turn(DM);
      await s.turn(DM, undefined, speech ? { turnModel: { model: FABLE, effort: "low" } } : {});
      expect(calls.map(c => [c.engine, c.model, c.effort])).toEqual([["claude", FABLE, "high"], ["claude", OPUS, "medium"]]);
      expect(calls[1].resumeSessionId).toBeUndefined();
      expect(s.infos[1]).toMatchObject({ engine: "claude", stage: `claude:${OPUS}`, model: OPUS });
      expect((await getSessionsForKey(sessionKeyFor(DM)))[0]).toMatchObject({ model: OPUS, engineSessionId: "claude-s2", messageCount: 1 });
      expect(s.notices).toEqual([`Hier antwortet jetzt Claude Code mit ${OPUS} statt Claude Code (Limit erreicht). Der Verlauf ist übergeben.`]);
    });
  }

  test("gewünschte Opus-Stufe frei, aber gesprochenes Fable-Modell gesperrt: bleibt Opus", async () => {
    await putSettings({ ...config(), defaults: { model: OPUS, effort: "high" } });
    await updateSwitchState(state => ({ ...state, blocks: [block("claude", { family: "fable" })] }));
    const s = readyTurn();
    await s.turn(DM, undefined, { turnModel: { model: FABLE, effort: "low" } });
    expect(calls[0]).toMatchObject({ engine: "claude", model: OPUS, effort: "high" });
    expect(s.notices).toEqual([]);
  });

  test("/motor codex gesperrt: Claude antwortet, Quelle auto", async () => {
    await putSettings({ ...config(), engine: { default: "claude", topics: { [sessionKeyFor(DM)]: "codex" }, backups: [{ engine: "opencode" }] } });
    await updateSwitchState(state => ({ ...state, blocks: [block("codex")] }));
    const s = readyTurn();
    let source: string | undefined;
    const original = s.deps.resolveEngine!;
    s.deps.resolveEngine = async (...args) => { const result = await original(...args); source = result.source; return result; };
    expect(await s.turn(DM)).toBe("antwort-claude");
    expect(source).toBe("auto");
    expect(calls[0]).toMatchObject({ engine: "claude", model: FABLE });
  });

  test("Automatik aus: Messung 96 % ändert die nächste Stufe nicht", async () => {
    await putSettings({ ...config(), engine: { backups: [{ engine: "codex" }], auto: { enabled: false } } });
    const s = readyTurn();
    replies.claude = [{ rateLimit: measurement() }];
    await s.turn(DM);
    await s.turn(DM);
    expect(calls.map(c => c.engine)).toEqual(["claude", "claude"]);
    expect(calls[1].resumeSessionId).toBe("claude-s1");
    await Promise.all(stageWrites);
    expect(readSwitchState().blocks).toEqual([]);
  });

  test("kein Session-Modus: Wechsel wirkt ebenfalls erst auf den nächsten Turn", async () => {
    const s = readyTurn(false);
    replies.claude = [{ rateLimit: measurement() }];
    await s.turn(DM);
    await s.turn(DM);
    expect(calls.map(c => c.engine)).toEqual(["claude", "codex"]);
    expect(await getSessionsForKey(sessionKeyFor(DM))).toEqual([]);
  });

  test("keine Stufe frei: voller Kontext, Turn-Hinweis, Freigabezeit, Kette und unveränderte Session", async () => {
    await blockAll();
    await recordSessionTurn(sessionKeyFor(DM), "general", FABLE, "claude", "bestehende-session");
    const before = await readFile(join(dir, "sessions.json"), "utf8");
    const s = readyTurn();
    const events: string[] = [];
    let request!: FallbackRequest;
    const context = "Profil: Beispiel. Gedächtnis: Fakt. Verlauf: vorherige Frage. Suchtreffer: Wissen.";
    const forbidden = () => { throw new Error("Session/Motor darf nicht angefasst werden"); };
    Object.assign(s.deps, { getEngine: forbidden, getResumableSession: forbidden, takeExpiredSession: forbidden,
      recordSessionTurn: forbidden, resetSession: forbidden, distillSession: forbidden });
    s.deps.buildPromptContext = async input => { expect(input.userMessage).toBe("Frage?"); return { fullPrompt: "voll", fallbackContext: context }; };
    s.deps.runFallbackChain = async req => { request = req; return { text: "Ersatz", source: "openrouter", model: "ersatz-modell" }; };
    const answer = await s.turn(DM, undefined, { turnHint: "kurz antworten", onTools: value => { expect(value).toBeUndefined(); events.push("tools"); },
      sink: { start: () => events.push("start"), finish: () => events.push("finish"), progress() {}, notice: text => s.notices.push(text) } });
    expect(answer).toBe("Ersatz\n\n_(Antwort über openrouter)_");
    expect(request.context).toBe(context);
    expect(request.question).toContain("kurz antworten");
    expect(request.allowClaudeCli?.("claude-opus-5[1m]")).toBe(false);
    expect(calls).toHaveLength(0);
    expect(s.metas).toEqual([]);
    expect(events).toEqual(["start", "finish", "tools"]);
    expect(s.infos).toEqual([{ agent: "general", model: "ersatz-modell", durationMs: 0 }]);
    expect(s.notices).toEqual(["Gerade ist kein Motor frei (Limit erreicht oder nicht bereit). Es antwortet ein Ersatzmodell mit eingeschränktem Werkzeugumfang. Frühestens wieder frei: "
      + formatSwitchTime(block("claude").until, process.env.USER_TIMEZONE || "UTC") + " Uhr."]);
    expect(await readFile(join(dir, "sessions.json"), "utf8")).toBe(before);
  });

  test("alle nicht bereit: Ersatzantwort und Hinweis ohne Freigabezeit", async () => {
    status = { ...READY, installed: false, loggedIn: false };
    const s = readyTurn();
    let allowed = true;
    const fallback = s.deps.runFallbackChain!;
    s.deps.runFallbackChain = req => { allowed = req.allowClaudeCli!(OPUS); return fallback(req); };
    expect(await s.turn(DM)).toContain("ersatz-antwort");
    expect(allowed).toBe(false);
    expect(calls).toHaveLength(0);
    expect(s.fallbackContexts).toEqual(["kontext"]);
    expect(s.notices[0]).toContain("Gerade ist kein Motor frei");
    expect(s.notices[0]).not.toContain("Frühestens");
    expect(s.metas).toEqual([]);
  });

  for (const withTime of [true, false]) {
    for (const throws of [false, true]) {
      test(`Kette ${throws ? "wirft" : "antwortet nicht"}: feste Antwort ${withTime ? "mit" : "ohne"} Freigabezeit`, async () => {
        if (withTime) await blockAll();
        else status = { ...READY, installed: false, loggedIn: false };
        const s = readyTurn();
        s.deps.runFallbackChain = async request => {
          expect(request.context).toBe("kontext");
          expect(request.allowClaudeCli!(OPUS)).toBe(false);
          if (throws) throw new Error("Kette fehlgeschlagen");
          return { text: "dieser Text darf nicht erscheinen", source: "none" };
        };
        const answer = await s.turn(DM);
        const end = withTime ? ` Frühestens wieder frei: ${formatSwitchTime(block("claude").until, process.env.USER_TIMEZONE || "UTC")} Uhr. Bitte versuch es dann noch einmal.`
          : " Bitte versuch es in ein paar Minuten noch einmal.";
        expect(answer).toBe("Gerade ist kein Motor frei, und auch die Ersatzmodelle haben nicht geantwortet." + end);
        expect(calls).toHaveLength(0);
        expect(s.infos).toEqual([{ agent: "general", durationMs: 0 }]);
      });
    }
  }

  test("/stop während der Kette: ABORT_REPLY, kein Motor und kein Session-Ereignis", async () => {
    await blockAll();
    const s = readyTurn();
    s.deps.runFallbackChain = async () => { throw abortError(); };
    expect(await s.turn(DM)).toBe(ABORT_REPLY);
    expect(calls).toEqual([]);
    expect(s.metas).toEqual([]);
  });

  test("Hinweis nur einmal je Gespräch, erst nach einer Stufenantwort erneut", async () => {
    await blockAll();
    const s = readyTurn();
    await s.turn(DM);
    await s.turn(DM);
    expect(s.notices).toHaveLength(1);
    await s.turn(WEB);
    expect(s.notices).toHaveLength(2);
    await updateSwitchState(state => ({ ...state, blocks: [] }));
    await s.turn(DM);
    await blockAll();
    await s.turn(DM);
    expect(s.notices).toHaveLength(3);
  });

  for (const afterRun of [false, true]) {
    test(`Zustandsdatei gesperrt ${afterRun ? "nach dem Lauf" : "vor dem Turn"}: Antwort unverändert und neue Sperre im Speicher`, async () => {
      const lock = join(dir, "switch.json.lock");
      const s = readyTurn();
      replies.claude = [{ rateLimit: measurement() }];
      if (afterRun) {
        const run = s.engines.claude!.run;
        s.engines.claude!.run = async req => { const result = await run(req); await writeFile(lock, "belegt"); return result; };
      } else await writeFile(lock, "belegt");
      expect(await s.turn(DM)).toBe("antwort-claude");
      await Promise.all(stageWrites);
      expect(readSwitchState().blocks).toMatchObject([{ engine: "claude", cause: "threshold", percent: 96 }]);
      expect(await s.turn(DM)).toBe("antwort-codex");
    });
  }

  test("Schreibfehler nach Erfolg kostet keine Antwort; Auswertung wird nicht abgewartet", async () => {
    const s = readyTurn();
    let finish!: () => void;
    const held = new Promise<void>(resolve => { finish = resolve; });
    const run = s.engines.claude!.run;
    s.engines.claude!.run = async req => {
      setSwitchStateWriterForTests(async () => { await held; throw new Error("Schreibfehler"); });
      return run(req);
    };
    replies.claude = [{ rateLimit: measurement() }];
    try {
      expect(await s.turn(DM)).toBe("antwort-claude");
    } finally { finish(); }
    await Promise.all(stageWrites);
    expect(readSwitchState().blocks).toMatchObject([{ cause: "threshold" }]);
  });

  test("neue Messung im Fehlerpfad sperrt Claude-CLI vor der Fallback-Kette", async () => {
    const s = readyTurn();
    replies.claude = [{ text: "", isError: true, rateLimit: measurement() }];
    replies.codex = [{ text: "", isError: true }];
    let allowed = true;
    s.deps.runFallbackChain = async req => { allowed = req.allowClaudeCli!(OPUS); return { text: "Ersatz", source: "ollama" }; };
    expect(await s.turn(DM)).toContain("Ersatz");
    expect(allowed).toBe(false);
  });

  test("Claude außerhalb der Reihenfolge: Fallback erlaubt nur bereites und freies Claude-Modell", async () => {
    await putSettings({ engine: { default: "codex", backups: [{ engine: "opencode" }] } });
    await updateSwitchState(state => ({ ...state, blocks: [block("codex"), block("opencode"), block("claude", { family: "fable" })] }));
    const s = readyTurn();
    s.deps.runFallbackChain = async req => {
      expect(req.allowClaudeCli!(OPUS)).toBe(true);
      expect(req.allowClaudeCli!(FABLE)).toBe(false);
      return { text: "Ersatz", source: "ollama" };
    };
    await s.turn(DM);
    expect(checks).toBe(3);
    expect(calls).toHaveLength(0);
  });

  test("TurnOptions.engine umgeht Regel, Sperren und Zustandsauswertung", async () => {
    await blockAll();
    const s = readyTurn();
    s.deps.readSwitchState = () => { throw new Error("Regel umgangen"); };
    s.deps.noteStageRun = async () => { throw new Error("Regel umgangen"); };
    expect(await s.turn(DM, undefined, { engine: "claude", turnModel: { model: FABLE, effort: "low" } })).toBe("antwort-claude");
    expect(checks).toBe(0);
    expect(calls[0]).toMatchObject({ model: FABLE, effort: "low" });
  });

  test("Einstellungen während des Turns gelten erst beim nächsten Turn; resolveEngine genau einmal", async () => {
    const s = readyTurn();
    let resolutions = 0;
    const resolve = s.deps.resolveEngine!;
    s.deps.resolveEngine = (...args) => { resolutions++; return resolve(...args); };
    s.deps.buildPromptContext = async () => {
      await putSettings({ defaults: { model: OPUS, effort: "low" }, engine: { default: "codex", backups: [{ engine: "opencode" }] } });
      return { fullPrompt: "voller-prompt", fallbackContext: "kontext" };
    };
    await s.turn(DM);
    expect(calls[0]).toMatchObject({ engine: "claude", model: FABLE, effort: "high" });
    await s.turn(DM);
    expect(calls[1].engine).toBe("codex");
    expect(resolutions).toBe(2);
  });

  test("/goal-Folgeturn über goalAgentCall und JSON-Turn folgt gespeicherten Messwerten", async () => {
    await recordUsage("claude", measurement().windows);
    const s = readyTurn();
    const turns = createBotTurns({
      runJson: opts => runJsonTurn({ ...opts, deps: s.deps }), runStreaming: async () => { throw new Error("falscher Weg"); },
      runExecution: async (_key, _agent, run) => run(), isAbort: () => false, allowedTools: () => undefined,
      rememberSession: async () => {}, sendAsAgent: async () => {}, progressSink: () => ({ progress() {}, notice() {} }),
    });
    const followup = goalAgentCall(turns, turnInfoCollector);
    expect(await followup("Weiter am Ziel arbeiten", { chatId: DM, agentName: "general" })).toMatchObject({ text: "antwort-codex", aborted: false });
    expect(calls[0]).toMatchObject({ engine: "codex", streaming: false });
  });

  test("Automatik während eines Laufs ausgeschaltet: sein späterer Messwert sperrt nicht wieder", async () => {
    const s = readyTurn();
    const run = s.engines.claude!.run;
    s.engines.claude!.run = async req => {
      const result = await run(req);
      await putSettings({ ...config(), engine: { backups: [{ engine: "codex" }], auto: { enabled: false } } });
      // Wie syncEngineAuto nach einer Änderung der Einstellungen.
      await updateSwitchState(state => ({ ...state, auto: { enabled: false, threshold: 95, returnBelow: 80 }, blocks: [] }));
      return { ...result, rateLimit: measurement() };
    };
    await s.turn(DM);
    await s.turn(DM);
    expect(calls.map(c => c.engine)).toEqual(["claude", "claude"]);
    await Promise.all(stageWrites);
    expect(readSwitchState().blocks).toEqual([]);
  });

  test("/new während der Motorprüfung: spätes Ergebnis legt die Session nicht wieder an", async () => {
    const s = readyTurn();
    const resolve = s.deps.resolveEngine!;
    s.deps.resolveEngine = async (...args) => {
      await resetSession(sessionKeyFor(DM));
      return resolve(...args);
    };
    expect(await s.turn(DM)).toBe("antwort-claude");
    expect(await getSessionsForKey(sessionKeyFor(DM))).toEqual([]);
  });

  test("usage_limit: Codex antwortet sofort und beginnt auch den nächsten Turn", async () => {
    const s = readyTurn();
    const run = s.engines.codex!.run;
    s.engines.codex!.run = req => {
      expect(readSwitchState().blocks).toMatchObject([{ engine: "claude", cause: "limit", family: "fable" }]);
      return run(req);
    };
    replies.claude = [{ isError: true, text: "Limit", errorKind: "usage_limit" }];
    expect(await s.turn(DM)).toBe("antwort-codex");
    expect(readSwitchState().blocks).toMatchObject([{ engine: "claude", cause: "limit", family: "fable" }]);
    expect(await s.turn(DM)).toBe("antwort-codex");
    expect(calls.map(c => c.engine)).toEqual(["claude", "codex", "codex"]);
    expect(calls[1].resumeSessionId).toBeUndefined();
    expect(calls[2].resumeSessionId).toBe("codex-s1");
    expect(s.progress).toEqual([{ kind: "tool", text: "Claude Code ist am Limit, Codex übernimmt." }]);
    expect(s.infos[0]).toMatchObject({ engine: "codex", stage: "codex", reason: "Claude Code: limit" });
  });

  for (const percent of [undefined, 48]) {
    test(`quota Fable: Opus übernimmt mit eigenem Modell/Effort und eigener Session, Wochenstand ${percent ?? "unbekannt"}`, async () => {
      await putSettings({ ...config(), engine: { backups: [{ engine: "claude", model: OPUS, effort: "medium" }, { engine: "codex" }] } });
      if (percent !== undefined) await recordUsage("claude", [{ ...measurement().windows[0], percent,
        resetsAt: new Date(now + 7 * 86_400_000).toISOString() }]);
      const s = readyTurn();
      replies.claude = [{ isError: true, text: "Quota", errorKind: "quota" }];
      expect(await s.turn(DM, undefined, { turnModel: { model: FABLE, effort: "low" } })).toBe("antwort-claude");
      expect(calls.map(c => [c.engine, c.model, c.effort])).toEqual([["claude", FABLE, "low"], ["claude", OPUS, "medium"]]);
      expect(calls[1].resumeSessionId).toBeUndefined();
      expect(readSwitchState().blocks).toEqual([{ engine: "claude", cause: "limit", family: "fable", resetKnown: false,
        since: new Date(now).toISOString(), until: new Date(now + 3_600_000).toISOString() }]);
      expect(s.infos[0]).toMatchObject({ engine: "claude", model: OPUS, stage: `claude:${OPUS}` });
      expect((await getSessionsForKey(sessionKeyFor(DM)))[0]).toMatchObject({ model: OPUS, engineSessionId: "claude-s2" });
      expect(await s.turn(DM)).toBe("antwort-claude");
      expect(calls[2]).toMatchObject({ model: OPUS, effort: "medium", resumeSessionId: "claude-s2" });
    });
  }

  test("rejected seven_day: belegter Wochen-Reset sperrt auch Opus, Codex übernimmt", async () => {
    await putSettings({ ...config(), engine: { backups: [{ engine: "claude", model: OPUS }, { engine: "codex" }] } });
    const s = readyTurn();
    const resetsAt = new Date(now + 7 * 86_400_000).toISOString();
    replies.claude = [{ isError: true, text: "Limit", errorKind: "usage_limit",
      rateLimit: { status: "rejected", rateLimitType: "seven_day", resetsAt } }];
    expect(await s.turn(DM)).toBe("antwort-codex");
    expect(calls.map(c => c.engine)).toEqual(["claude", "codex"]);
    expect(readSwitchState().blocks).toEqual([{ engine: "claude", cause: "limit", window: "weekly_all", resetKnown: true,
      since: new Date(now).toISOString(), until: resetsAt }]);
  });

  test("Sprech-Modell sperrt seine tatsächliche Familie; tried verhindert denselben Stufenversuch nochmals", async () => {
    await putSettings({ ...config(), engine: { backups: [{ engine: "claude", model: OPUS }, { engine: "codex" }] } });
    const s = readyTurn();
    replies.claude = [{ isError: true, text: "Limit", errorKind: "quota" }];
    expect(await s.turn(DM, undefined, { turnModel: { model: OPUS, effort: "low" } })).toBe("antwort-codex");
    expect(calls.map(c => [c.engine, c.model])).toEqual([["claude", OPUS], ["codex", undefined]]);
    expect(readSwitchState().blocks).toMatchObject([{ family: "opus", cause: "limit" }]);
    expect(await s.turn(DM)).toBe("antwort-claude");
    expect(calls[2]).toMatchObject({ model: FABLE, effort: "high" });
  });

  test("Codex während des Claude-Laufs entfernt: dieser Turn nutzt noch Codex, der nächste die neue Reihenfolge", async () => {
    const s = readyTurn();
    const run = s.engines.claude!.run;
    s.engines.claude!.run = async req => {
      await putSettings({ ...config(), engine: { backups: [{ engine: "opencode" }] } });
      return run(req);
    };
    replies.claude = [{ isError: true, text: "Limit", errorKind: "usage_limit" }];
    expect(await s.turn(DM)).toBe("antwort-codex");
    expect(await s.turn(DM)).toBe("antwort-opencode");
    expect(calls.map(c => c.engine)).toEqual(["claude", "codex", "opencode"]);
  });

  test("Ausfall von Fable sperrt motorweit auch Opus, nicht nur die Modellfamilie", async () => {
    await putSettings({ ...config(), engine: { backups: [{ engine: "claude", model: OPUS }, { engine: "codex" }] } });
    const s = readyTurn();
    replies.claude = [{ isError: true, text: "Fehler" }];
    expect(await s.turn(DM)).toBe("antwort-codex");
    expect(calls.map(c => c.engine)).toEqual(["claude", "codex"]);
  });

  for (const lock of [true, false]) {
    test(`Limit-Sperre bleibt bei ${lock ? "belegter Dateisperre" : "Schreibfehler"} im Speicher, auch im nächsten Turn`, async () => {
      const s = readyTurn();
      const run = s.engines.claude!.run;
      s.engines.claude!.run = async req => {
        if (lock) await writeFile(join(dir, "switch.json.lock"), "belegt");
        else setSwitchStateWriterForTests(async () => { throw new Error("Schreibfehler"); });
        return run(req);
      };
      replies.claude = [{ isError: true, text: "Limit", errorKind: "usage_limit" }];
      expect(await s.turn(DM)).toBe("antwort-codex");
      expect(readSwitchState().blocks).toMatchObject([{ cause: "limit", family: "fable" }]);
      expect(await s.turn(DM)).toBe("antwort-codex");
      expect(calls.map(c => c.engine)).toEqual(["claude", "codex", "codex"]);
    });
  }

  for (const backups of [true, false]) {
    for (const [kind, retry] of [
      ["usage_limit", false], ["quota", false], ["auth", false], ["not_installed", false], ["capacity", false],
      ["other", true], ["context", true], ["rate_limit", true], [undefined, true], ["empty", true],
    ] as const) {
      test(`Resume ${kind ?? "ohne Fehlerart"} ${backups ? "mit" : "ohne"} Ersatzstufen: ${retry ? "ein frischer Retry" : "kein Retry"}`, async () => {
        if (!backups) await putSettings({ defaults: { model: FABLE } });
        await recordSessionTurn(sessionKeyFor(DM), "general", FABLE, "claude", "alte-session");
        const s = readyTurn();
        replies.claude = [{ text: "", isError: kind !== "empty", ...(kind === "empty" ? {} : { errorKind: kind }) }];
        await s.turn(DM);
        expect(calls.filter(c => c.engine === "claude")).toHaveLength(retry ? 2 : 1);
        expect(calls[0].resumeSessionId).toBe("alte-session");
        if (retry) {
          expect(calls[1].resumeSessionId).toBeUndefined();
          await Promise.all(stageWrites);
          expect(readSwitchState().blocks).toEqual([]);
          expect(await s.turn(DM)).toBe("antwort-claude");
          expect(calls.at(-1)!.resumeSessionId).toBe("claude-s2");
        } else if (backups) {
          expect(calls.map(c => c.engine)).toEqual(["claude", "codex"]);
          expect(s.fallbackCalls).toEqual([]);
        } else {
          expect(s.fallbackCalls).toHaveLength(1);
          expect(s.fallbackContexts).toEqual(["kontext"]);
        }
      });
    }
  }

  test("Resume und frischer Retry ohne Fehlerart scheitern: nur eine Ausfallsperre, dann Codex", async () => {
    await recordSessionTurn(sessionKeyFor(DM), "general", FABLE, "claude", "alte-session");
    const s = readyTurn();
    replies.claude = [{ text: "Fehler", isError: true }, { text: "Fehler", isError: true }];
    expect(await s.turn(DM)).toBe("antwort-codex");
    expect(calls.map(c => c.engine)).toEqual(["claude", "claude", "codex"]);
    expect(readSwitchState().counters).toMatchObject([{ engine: "claude", kind: "outage", count: 1 }]);
    expect(readSwitchState().blocks).toMatchObject([{ until: new Date(now + 600_000).toISOString() }]);
  });

  for (const unreadable of [false, true]) {
    test(`Werkzeugliste im vollen Folgeprompt: Geheimnisquelle ${unreadable ? "unlesbar" : "maskiert"}`, async () => {
      await recordSessionTurn(sessionKeyFor(DM), "general", FABLE, "claude", "alte-session");
      const s = readyTurn();
      const secret = "nur-erfundener-testwert";
      s.deps.reportSecrets = () => {
        if (unreadable) throw new Error("nicht lesbar");
        return [secret];
      };
      replies.claude = [{ text: "Limit", isError: true, errorKind: "usage_limit", tools: { uses: [
        { name: "Bash", command: `notify --text=${secret}` }, { name: "Write", path: `/tmp/${secret}.txt` },
      ] } }];
      expect(await s.turn(DM, undefined, { turnHint: "kurz antworten" })).toBe("antwort-codex");
      expect(calls[0].prompt).toContain("resume-prompt");
      expect(calls[1].prompt).toStartWith("voller-prompt\n\nDer vorige Versuch mit Claude Code mit " + FABLE);
      expect(calls[1].prompt).toContain("(Nutzungsgrenze erreicht)");
      expect(calls[1].prompt).toContain("kurz antworten");
      expect(calls[1].prompt).not.toContain(secret);
      expect(calls[1].prompt).toContain(unreadable ? "Werkzeuge benutzt: Bash; Write." : "notify --text=[verborgen]; Write: /tmp/[verborgen].txt");
    });
  }

  test("capacity: Codex übernimmt und der ausgefallene Motor pausiert zehn Minuten", async () => {
    const s = readyTurn();
    replies.claude = [{ isError: true, text: "überlastet", errorKind: "capacity" }];
    expect(await s.turn(DM)).toBe("antwort-codex");
    expect(readSwitchState().blocks).toMatchObject([{ engine: "claude", cause: "outage", resetKnown: false,
      until: new Date(now + 600_000).toISOString() }]);
    expect(readSwitchState().blocks[0].family).toBeUndefined();
    expect(s.progress).toEqual([{ kind: "tool", text: "Claude Code antwortet nicht, Codex übernimmt." }]);
    expect(s.infos[0]).toMatchObject({ engine: "codex", stage: "codex", reason: "Claude Code: outage" });
  });

  for (const mode of ["streaming", "json"] as const) {
    test(`${mode}: jeder Lauf einschließlich Resume-Retry wird gebucht; TurnInfo und Session gehören Codex`, async () => {
      await putSettings({ ...config(), engine: { backups: [{ engine: "codex" }], codex: { model: "gpt-5.6-sol", effort: "high" } } });
      await recordSessionTurn(sessionKeyFor(DM), "general", FABLE, "claude", "alte-session");
      const s = readyTurn(true, mode);
      const oldFile = process.env.BUDGET_DB_PATH;
      process.env.BUDGET_DB_PATH = join(dir, "buchungen.sqlite");
      try {
        replies.claude = [
          { text: "Fehler", isError: true, costUsd: 0.1, usage: { inputTokens: 10 } },
          { text: "Limit", isError: true, errorKind: "usage_limit", costUsd: 0.2, usage: { inputTokens: 20 } },
        ];
        replies.codex = [{ usage: { inputTokens: 30 } }];
        expect(await s.turn(DM)).toBe("antwort-codex");
        const db = new Database(process.env.BUDGET_DB_PATH, { readonly: true });
        try {
          expect(db.query("SELECT engine, model, origin, input_tokens, cost_usd FROM engine_runs ORDER BY id").all()).toEqual([
            { engine: "claude", model: FABLE, origin: "chat", input_tokens: 10, cost_usd: 0.1 },
            { engine: "claude", model: FABLE, origin: "chat", input_tokens: 20, cost_usd: 0.2 },
            { engine: "codex", model: "gpt-5.6-sol", origin: "chat", input_tokens: 30, cost_usd: null },
          ]);
        } finally { db.close(); }
        expect(s.infos).toEqual([{ agent: "general", engine: "codex", model: "gpt-5.6-sol", stage: "codex", reason: "Claude Code: limit", durationMs: 0 }]);
        expect(s.metas).toEqual([{ engine: "codex", model: "gpt-5.6-sol" }]);
        expect((await getSessionsForKey(sessionKeyFor(DM)))[0]).toMatchObject({ engine: "codex", model: "gpt-5.6-sol", engineSessionId: "codex-s1" });
        expect(s.distilled).toEqual([]);
        expect(calls[2]).toMatchObject({ engine: "codex", model: "gpt-5.6-sol", effort: "high", streaming: mode === "streaming" });
      } finally {
        if (oldFile === undefined) delete process.env.BUDGET_DB_PATH;
        else process.env.BUDGET_DB_PATH = oldFile;
      }
    });
  }

  for (const empty of [false, true]) {
    test(`versuchte Opus-Familie bleibt in der Kette aus, auch ohne Sperre (${empty ? "leer" : "rate_limit"})`, async () => {
      await putSettings({ ...config(), defaults: { model: OPUS } });
      const s = readyTurn();
      replies.claude = [{ text: "", isError: !empty, ...(empty ? {} : { errorKind: "rate_limit" }) }];
      s.deps.runFallbackChain = async req => {
        expect(readSwitchState().blocks).toEqual([]);
        expect(req.allowClaudeCli!("claude-opus-5[1m]")).toBe(false);
        expect(req.allowClaudeCli!(FABLE)).toBe(true);
        return { text: "Ersatz", source: "ollama" };
      };
      expect(await s.turn(DM)).toContain("Ersatz");
      expect(calls).toHaveLength(1);
    });
  }

  test("höchstens drei Stufen: Fable, Opus, Codex scheitern, OpenCode läuft nicht", async () => {
    await putSettings({ ...config(), engine: { backups: [
      { engine: "claude", model: OPUS, effort: "medium" }, { engine: "codex" }, { engine: "opencode" },
    ] } });
    const s = readyTurn();
    replies.claude = [
      { isError: true, text: "Limit", errorKind: "usage_limit" },
      { isError: true, text: "Limit", errorKind: "quota" },
    ];
    replies.codex = [{ isError: true, text: "Ausfall", errorKind: "other" }];
    expect(await s.turn(DM)).toContain("ersatz-antwort");
    expect(calls.map(c => [c.engine, c.model])).toEqual([["claude", FABLE], ["claude", OPUS], ["codex", undefined]]);
    expect(s.fallbackCalls).toHaveLength(1);
    expect(calls[2].prompt.match(/Der vorige Versuch/g)).toHaveLength(2);
    expect(s.fallbackContexts[0].match(/Der vorige Versuch/g)).toHaveLength(3);
    expect(s.notices.at(-1)).toBe(engineFailedNotice("codex", "other"));
  });

  test("Resume-Retry zählt nicht als vierte Stufe; nach drei gescheiterten Stufen keine Freigabezeit der freien vierten", async () => {
    await putSettings({ ...config(), engine: { backups: [
      { engine: "claude", model: OPUS }, { engine: "codex" }, { engine: "opencode" },
    ] } });
    await recordSessionTurn(sessionKeyFor(DM), "general", FABLE, "claude", "alte-session");
    const s = readyTurn();
    replies.claude = [
      { isError: true, text: "Sitzungsfehler" },
      { isError: true, text: "Limit", errorKind: "quota" },
      { isError: true, text: "Limit", errorKind: "quota" },
    ];
    replies.codex = [{ isError: true, text: "Ausfall", errorKind: "capacity" }];
    s.deps.runFallbackChain = async () => ({ source: "none", text: NO_BACKEND_REPLY });
    expect(await s.turn(DM)).toBe("Gerade ist kein Motor frei, und auch die Ersatzmodelle haben nicht geantwortet. Bitte versuch es in ein paar Minuten noch einmal.");
    expect(calls.map(c => [c.engine, c.model])).toEqual([["claude", FABLE], ["claude", FABLE], ["claude", OPUS], ["codex", undefined]]);
  });

  describe("gescheiterte Stufen vor der echten Fallback-Kette mit Attrappen", () => {
    isolateShellEnv({ OPENROUTER_API_KEY: "erfundener-testschluessel", FALLBACK_K3: "true", FALLBACK_CLAUDE_MODEL: OPUS,
      FALLBACK_OFFLINE_ONLY: "false" });
    for (const kind of ["quota", "rate_limit", "empty"] as const) {
      for (const emptyChain of [false, true]) {
        test(`${kind}: CLI startet nicht, Kette ${emptyChain ? "bleibt leer" : "antwortet"}`, async () => {
          const limit = kind === "quota";
          await putSettings({ defaults: { model: limit ? FABLE : OPUS }, engine: {
            backups: limit ? [{ engine: "claude", model: OPUS }] : [{ engine: "codex" }],
          } });
          const s = readyTurn();
          const failed = { text: "", isError: kind !== "empty", ...(kind === "empty" ? {} : { errorKind: kind }) };
          replies.claude = limit ? [failed, failed] : [failed];
          let cliCalls = 0;
          let httpCalls = 0;
          s.deps.runFallbackChain = req => {
            expect(req.allowClaudeCli!(OPUS)).toBe(false);
            expect(req.context).toStartWith("kontext\n\nDer vorige Versuch");
            return runFallbackChain(req, {
              callClaude: async () => { cliCalls++; return { isError: true, text: "" }; },
              tools: () => undefined,
              loop: {
                fetch: (async () => {
                  httpCalls++;
                  return emptyChain || httpCalls === 1 ? new Response("Ausfall", { status: 500 })
                    : Response.json({ choices: [{ message: { role: "assistant", content: "Ersatz" } }] });
                }) as typeof fetch,
                callTool: async () => { throw new Error("kein Werkzeug erwartet"); },
                reserve: () => "reserviert", settle: () => {},
              },
            });
          };
          const answer = await s.turn(DM);
          expect(cliCalls).toBe(0);
          expect(httpCalls).toBe(emptyChain ? 3 : 2);
          expect(calls).toHaveLength(limit ? 2 : 1);
          if (!emptyChain) expect(answer).toBe("Ersatz\n\n_(Antwort über openrouter)_");
          else {
            expect(answer).toStartWith("Gerade ist kein Motor frei, und auch die Ersatzmodelle haben nicht geantwortet.");
            if (limit) expect(answer).toContain(formatSwitchTime(new Date(now + 3_600_000).toISOString(), process.env.USER_TIMEZONE || "UTC"));
            else expect(answer).not.toContain("Frühestens");
          }
        });
      }
    }
  });

  for (const second of [false, true]) {
    for (const outcome of ["timeout", "abort", "rate_limit", "context", "empty"] as const) {
      test(`${outcome} auf Stufe ${second ? 2 : 1}: kein weiterer Motor`, async () => {
        await putSettings({ ...config(), engine: { backups: [{ engine: "codex" }, { engine: "opencode" }] } });
        const s = readyTurn();
        if (second) replies.claude = [{ text: "Limit", isError: true, errorKind: "quota" }];
        replies[second ? "codex" : "claude"] = [{ text: "", isError: outcome !== "empty",
          ...(outcome === "timeout" ? { timedOut: true, timeoutKind: "idle", steps: [] }
            : outcome === "abort" ? { aborted: true }
            : outcome === "empty" ? {} : { errorKind: outcome }) }];
        const answer = await s.turn(DM);
        expect(calls.map(c => c.engine)).toEqual(second ? ["claude", "codex"] : ["claude"]);
        if (outcome === "abort") {
          expect(answer).toBe(ABORT_REPLY);
          expect(s.infos).toEqual([]);
        } else if (outcome === "timeout") {
          expect(answer).toContain("Zeitlimit:");
          expect(answer).toContain(second ? "Codex" : "Claude");
        } else expect(answer).toContain("ersatz-antwort");
        expect(s.fallbackCalls).toHaveLength(outcome === "timeout" || outcome === "abort" ? 0 : 1);
        await Promise.all(stageWrites);
        expect(readSwitchState().blocks.every(b => second && b.engine === "claude")).toBe(true);
      });
    }
  }

  test("/stop während der Fehlerablage: kein nächster Motor und keine Ersatzkette", async () => {
    const s = readyTurn();
    replies.claude = [{ isError: true, text: "Limit", errorKind: "quota" }];
    const note = s.deps.noteStageRun!;
    s.deps.noteStageRun = async (...args) => {
      await note(...args);
      abortExecutions(sessionKeyFor(DM));
    };
    expect(await runCancelable(sessionKeyFor(DM), () => s.turn(DM))).toBe(ABORT_REPLY);
    expect(calls.map(c => c.engine)).toEqual(["claude"]);
    expect(s.fallbackCalls).toEqual([]);
  });

  test("weitere Versuche folgen ausschließlich order von resolveEngine, Bereitschaft eingeschlossen", async () => {
    const s = readyTurn();
    let resolutions = 0;
    const resolve = s.deps.resolveEngine!;
    s.deps.resolveEngine = async (...args) => {
      resolutions++;
      const chosen = await resolve(...args);
      return { ...chosen, order: [{ engine: "claude" }, { engine: "opencode" }, { engine: "codex" }],
        ready: { claude: { ready: true }, opencode: { ready: true }, codex: { ready: true }, api: { ready: false } } };
    };
    replies.claude = [{ isError: true, text: "Limit", errorKind: "usage_limit" }];
    expect(await s.turn(DM)).toBe("antwort-opencode");
    expect(calls.map(c => c.engine)).toEqual(["claude", "opencode"]);
    expect(resolutions).toBe(1);
  });

  test("Bereitschaft hinter der ersten Stufe: nicht bereites Codex wird auch beim Einspringen übersprungen", async () => {
    await putSettings({ ...config(), engine: { backups: [{ engine: "codex" }, { engine: "opencode" }] } });
    const s = readyTurn();
    s.deps.resolveEngine = (key, d, turn) => resolveEngine(key, { ...d, env: () => ({}),
      checkEngine: async engine => ({ ...READY, engine, loggedIn: engine !== "codex" }), log: () => {},
    }, turn);
    replies.claude = [{ isError: true, text: "Limit", errorKind: "quota" }];
    expect(await s.turn(DM)).toBe("antwort-opencode");
    expect(calls.map(c => c.engine)).toEqual(["claude", "opencode"]);
  });

  test("erst während des Laufs gespeicherter 100-%-Messwert belegt das Fenster", async () => {
    await putSettings({ ...config(), engine: { backups: [{ engine: "claude", model: OPUS }, { engine: "codex" }] } });
    const s = readyTurn();
    const run = s.engines.claude!.run;
    s.engines.claude!.run = async req => {
      await recordUsage("claude", [{ ...measurement().windows[0], percent: 100 }]);
      return run(req);
    };
    replies.claude = [{ isError: true, text: "Limit", errorKind: "quota" }];
    expect(await s.turn(DM)).toBe("antwort-codex");
    expect(calls.map(c => c.engine)).toEqual(["claude", "codex"]);
    expect(readSwitchState().blocks).toMatchObject([{ cause: "limit", window: "weekly_all", resetKnown: true,
      until: new Date(now + 600_000).toISOString() }]);
  });

  test("auth: freie Opus-Ersatzstufe statt gesperrtem Agenten-/Turn-Modell; jeder Lauf wird ausgewertet", async () => {
    await putSettings({ ...config(), engine: { default: "codex", backups: [{ engine: "claude", model: OPUS, effort: "medium" }] } });
    await updateSwitchState(state => ({ ...state, blocks: [block("claude", { family: "fable" })] }));
    const s = readyTurn();
    replies.codex = [{ text: "nicht angemeldet", isError: true, errorKind: "auth" }];
    expect(await s.turn(DM, undefined, { turnModel: { model: FABLE, effort: "low" } })).toBe("antwort-claude");
    expect(calls.map(c => c.engine)).toEqual(["codex", "claude"]);
    expect(calls[1]).toMatchObject({ model: OPUS, effort: "medium" });
    expect(s.infos[0]).toMatchObject({ stage: `claude:${OPUS}`, model: OPUS });
    expect(stageWrites).toHaveLength(2);
    expect(forgets).toBe(1);
  });

  for (const explicit of [false, true]) {
    for (const errorKind of ["auth", "not_installed", "usage_limit", "quota", "capacity", "other"] as EngineErrorKind[]) {
      test(`${explicit ? "TurnOptions.engine" : "ohne Ersatzstufen"}: ${errorKind} greift nie auf die Wechselregel zu`, async () => {
        await putSettings({ defaults: { model: FABLE }, engine: { default: "codex", ...(explicit ? { backups: [{ engine: "opencode" }] } : {}) } });
        const s = readyTurn();
        const forbidden = () => { throw new Error("Wechselregel darf nicht laufen"); };
        s.deps.noteStageRun = forbidden;
        s.deps.readSwitchState = forbidden;
        replies.codex = [{ text: "Fehler", isError: true, errorKind }];
        await s.turn(DM, undefined, explicit ? { engine: "codex" } : {});
        const claude = errorKind === "auth" || errorKind === "not_installed";
        expect(calls.map(c => c.engine)).toEqual(claude ? ["codex", "claude"] : ["codex"]);
        expect(forgets).toBe(claude ? 1 : 0);
        expect(s.fallbackCalls).toHaveLength(claude ? 0 : 1);
        expect(await Bun.file(join(dir, "switch.json")).exists()).toBe(false);
      });
    }
  }

  for (const throws of [false, true]) {
    test(`ohne Ersatzstufen bleibt die feste Antwort der ${throws ? "werfenden" : "leeren"} Kette`, async () => {
      await putSettings({ defaults: { model: FABLE } });
      const s = readyTurn();
      replies.claude = [{ text: "", isError: true }];
      s.deps.runFallbackChain = async req => {
        expect(req.allowClaudeCli).toBeUndefined();
        if (throws) throw new Error("Kette fehlgeschlagen");
        return { text: NO_BACKEND_REPLY, source: "none" };
      };
      expect(await s.turn(DM)).toBe(throws ? FALLBACK_FAILED_REPLY : NO_BACKEND_REPLY);
    });
  }

  for (const backups of [false, true]) {
    test(`verlorene API-Session ${backups ? "mit" : "ohne"} Ersatzstufen: neue Stufe und keine Sperre`, async () => {
      await putSettings({ defaults: { model: FABLE }, engine: { default: "api", ...(backups ? { backups: [{ engine: "opencode" }] } : {}) } });
      await recordSessionTurn(sessionKeyFor(DM), "general", FABLE, "api", "verlorene-session");
      const s = readyTurn();
      s.engines.api = fakeEngine("api");
      replies.api = [{ text: "Sitzung fehlt", isError: true, errorKind: "context" }];
      const next = backups ? "opencode" : "claude";
      expect(await s.turn(DM)).toBe(`antwort-${next}`);
      expect(calls.map(c => c.engine)).toEqual(["api", next]);
      expect(calls[1].resumeSessionId).toBeUndefined();
      expect(calls[1].prompt).toStartWith("voller-prompt");
      expect(s.notices).toEqual([`Die Sitzung von Anthropic API ist nicht mehr vorhanden, ich antworte mit ${backups ? "OpenCode" : "Claude Code"}.`,
        ...(backups ? ["Hier antwortet jetzt OpenCode statt Anthropic API (Ausfall). Der Verlauf ist übergeben."] : [])]);
      await Promise.all(stageWrites);
      expect(readSwitchState().blocks).toEqual([]);
      expect((await getSessionsForKey(sessionKeyFor(DM)))[0].engine).toBe(next);
    });
  }

  test("Resume-Retry ohne Fehlerart bleibt auf derselben Stufe trotz neuer Messung", async () => {
    const s = readyTurn();
    await s.turn(DM);
    replies.claude = [{ text: "Fehler", isError: true, rateLimit: measurement() }];
    expect(await s.turn(DM)).toBe("antwort-claude");
    expect(calls.map(c => c.engine)).toEqual(["claude", "claude", "claude"]);
    expect(calls[1].resumeSessionId).toBe("claude-s1");
    expect(calls[2].resumeSessionId).toBeUndefined();
    expect(stageWrites).toHaveLength(3);
    expect(await s.turn(DM)).toBe("antwort-codex");
  });

});

describe("Vorgeschichte eines Übergabe-Turns (Issue #659)", () => {
  const FABLE = "claude-fable-5-2";
  const OPUS = "claude-opus-5-5";
  const emptyUsage = async () => ({ claude: [], codex: [], opencode: [], api: [] });
  const prior = (model = FABLE, tools?: EngineResult["tools"], engine: EngineId = "claude"): PriorAttempt => ({
    stage: { engine, model }, result: { engine, text: "Limit", isError: true, errorKind: "usage_limit" as const, tools },
  });
  beforeEach(async () => {
    await putSettings({ defaults: { model: FABLE }, engine: { backups: [
      { engine: "claude", model: OPUS }, { engine: "codex" }, { engine: "opencode" },
    ] } });
  });
  function readyTurn() {
    const s = setup({ mode: "json" });
    s.deps.now = Date.now;
    s.deps.resolveEngine = (key, d, turn) => resolveEngine(key, {
      ...d, env: () => ({}), checkEngine: async engine => ({ ...READY, engine }), readUsage: emptyUsage, log: () => {},
    }, turn);
    s.deps.noteStageRun = (stage, model, result, auto, now, update, options) => {
      const p = noteStageRun(stage, model, result, auto, now, update, { ...options, readUsage: emptyUsage });
      stageWrites.push(p);
      return p;
    };
    return s;
  }

  test("Resume zählt mit: Opus und Codex scheitern, OpenCode läuft nicht", async () => {
    const s = readyTurn();
    replies.claude = [{ isError: true, text: "Limit", errorKind: "usage_limit", tools: { uses: [{ name: "Read", path: "/tmp/opus" }] } }];
    replies.codex = [{ isError: true, text: "Limit", errorKind: "quota" }];
    expect(await s.turn(DM, undefined, { priorAttempts: [prior(FABLE, { uses: [{ name: "Write", path: "/tmp/fable" }] })] })).toContain("ersatz-antwort");
    expect(calls.map(c => [c.engine, c.model])).toEqual([["claude", OPUS], ["codex", undefined]]);
    expect(s.fallbackCalls).toHaveLength(1);
    expect(calls[1].prompt.match(/Der vorige Versuch/g)).toHaveLength(2);
    expect(calls[1].prompt.indexOf("/tmp/fable")).toBeLessThan(calls[1].prompt.indexOf("/tmp/opus"));
    expect(s.fallbackContexts[0].match(/Der vorige Versuch/g)).toHaveLength(3);
  });

  test("ohne Sperre ist der erste Versuch schon ausgeschlossen; Opus antwortet einmal", async () => {
    const s = readyTurn();
    expect(readSwitchState().blocks).toEqual([]);
    expect(await s.turn(DM, undefined, { priorAttempts: [prior()] })).toBe("antwort-claude");
    expect(calls.map(c => [c.engine, c.model])).toEqual([["claude", OPUS]]);
    expect(s.infos[0].reason).toContain("bereits versucht");
    expect(s.infos[0].reason).not.toContain("nicht bereit");
  });

  for (const resumed of [false, true]) {
    for (const variant of ["tools", "unknown", "empty", "unreadable"] as const) {
      test(`erster Prompt ${resumed ? "schlank" : "voll"}: Werkzeuge ${variant}`, async () => {
        const s = readyTurn();
        if (resumed) await recordSessionTurn(sessionKeyFor(DM), "general", OPUS, "claude", "opus-bestehend");
        const secret = "erfundener-geheimwert";
        s.deps.reportSecrets = () => { if (variant === "unreadable") throw new Error("nicht lesbar"); return [secret]; };
        const tools = variant === "unknown" ? undefined : { uses: variant === "empty" ? [] : [{ name: "Bash", command: `notify ${secret}` }] };
        await s.turn(DM, undefined, { priorAttempts: [prior(FABLE, tools)] });
        expect(calls).toHaveLength(1);
        expect(calls[0].prompt).toStartWith(resumed ? "resume-prompt" : "voller-prompt");
        expect(calls[0].prompt).not.toContain(secret);
        expect(calls[0].prompt).toContain(variant === "unknown" ? "Welche Werkzeuge er benutzt hat, ist nicht bekannt."
          : variant === "empty" ? "Er hat noch kein Werkzeug benutzt."
          : variant === "unreadable" ? "Werkzeuge benutzt: Bash." : "Bash: notify [verborgen]");
      });
    }
  }

  test("Opus-Versuch und keine freie Stufe: CLI derselben Familie bleibt aus, auch ohne Sperre", async () => {
    await putSettings({ defaults: { model: OPUS }, engine: { backups: [{ engine: "claude", model: OPUS }] } });
    const s = readyTurn();
    s.deps.runFallbackChain = async req => {
      expect(req.allowClaudeCli?.("claude-opus-5[1m]")).toBe(false);
      expect(req.allowClaudeCli?.(FABLE)).toBe(true);
      expect(req.context).toContain("Der vorige Versuch");
      return { source: "ollama", text: "Ersatz" };
    };
    expect(await s.turn(DM, undefined, { priorAttempts: [prior(OPUS)] })).toContain("Ersatz");
    expect(calls).toHaveLength(0);
    expect(readSwitchState().blocks).toEqual([]);
  });

  test("nicht passendes Modell schließt nichts aus, verbraucht aber einen Versuch", async () => {
    const s = readyTurn();
    replies.claude = [0, 1].map(() => ({ isError: true, text: "Limit", errorKind: "usage_limit" }));
    expect(await s.turn(DM, undefined, { priorAttempts: [prior("claude-sonnet-alt")] })).toContain("ersatz-antwort");
    expect(calls.map(c => [c.engine, c.model])).toEqual([["claude", FABLE], ["claude", OPUS]]);
    expect(calls[0].prompt).toContain("claude-sonnet-alt");
    expect(s.fallbackCalls).toHaveLength(1);
  });

  test.each([3, 4])("%s frühere Versuche: keine Session berühren, sofort die Kette", async count => {
    const s = readyTurn();
    await recordSessionTurn(sessionKeyFor(DM), "general", FABLE, "claude", "unberührt");
    const before = await getSessionsForKey(sessionKeyFor(DM));
    s.deps.getResumableSession = async () => { throw new Error("keine Session anfassen"); };
    expect(await s.turn(DM, undefined, { priorAttempts: Array.from({ length: count }, () => prior("claude-altes-modell")) })).toContain("ersatz-antwort");
    expect(calls).toHaveLength(0);
    expect(s.fallbackContexts[0].match(/Der vorige Versuch/g)).toHaveLength(count);
    expect(await getSessionsForKey(sessionKeyFor(DM))).toEqual(before);
  });

  test.each([{ priorAttempts: undefined }, { priorAttempts: [] }])("ohne Vorgeschichte (%j) bleibt der Prompt unverändert", async ({ priorAttempts }) => {
    const s = readyTurn();
    expect(await s.turn(DM, undefined, { priorAttempts })).toBe("antwort-claude");
    expect(calls.map(c => [c.engine, c.model, c.prompt])).toEqual([["claude", FABLE, "voller-prompt"]]);
  });

  test.each(["codex", "opencode"] as const)("%s: ein früheres Modell schließt den Motor aus", async engine => {
    await putSettings({ engine: { default: engine, backups: [{ engine: "claude", model: OPUS }] } });
    const s = readyTurn();
    await s.turn(DM, undefined, { priorAttempts: [prior("altes-modell", undefined, engine)] });
    expect(calls.map(c => c.engine)).toEqual(["claude"]);
  });

  test.each(["usage_limit", "capacity"] as const)("Übergabe-Verlauf nennt Grund des letzten Versuchs: %s", async errorKind => {
    const s = readyTurn();
    await recordSessionTurn(sessionKeyFor(DM), "general", FABLE, "claude", "fable-alt");
    const session = (await getSessionsForKey(sessionKeyFor(DM)))[0];
    const sources = handoverSources(DM, session.startedAt);
    s.deps.buildPromptContext = opts => buildPromptContext(opts, sources);
    s.deps.buildResumePrompt = opts => buildResumePrompt(opts, sources);
    const attempt = prior();
    attempt.result.errorKind = errorKind;
    await s.turn(DM, undefined, { priorAttempts: [attempt] });
    expect(calls[0].resumeSessionId).toBeUndefined();
    expect(calls[0].prompt).toContain(errorKind === "usage_limit" ? "Limit erreicht" : "Ausfall");
    expect(calls[0].prompt).toContain("7319");
    expect(calls[0].prompt.indexOf("Der vorige Versuch")).toBeGreaterThan(calls[0].prompt.indexOf(errorKind === "usage_limit" ? "Limit erreicht" : "Ausfall"));
  });
});

describe("Motor je Agent im Chat-Turn (M14-28)", () => {
  for (const mode of ["json", "streaming"] as const) for (const backups of [false, true]) test(`${mode}, Ersatzstufen=${backups}: zweiter Agent ohne falschen Wechselhinweis`, async () => {
    await putSettings({ agents: { research: { engine: "codex" }, critic: { engine: "opencode" } },
      engine: { ...(backups ? { backups: [{ engine: "codex" }, { engine: "opencode" }] } : {}) } });
    const s = setup({ mode });
    expect(await s.turn(DM, undefined, { agentName: "research" })).toBe("antwort-codex");
    expect(await s.turn(DM, undefined, { agentName: "critic" })).toBe("antwort-opencode");
    expect(await s.turn(DM, undefined, { agentName: "research" })).toBe("antwort-codex");
    expect(calls.map(c => c.engine)).toEqual(["codex", "opencode", "codex"]);
    expect(s.infos.map(i => i.engine)).toEqual(["codex", "opencode", "codex"]);
    expect(s.notices).toEqual([]);
    expect(calls[2].resumeSessionId).toBeDefined();
  });

  for (const backups of [false, true]) test(`nicht bereiter Agentenmotor im Turn, Ersatzstufen=${backups}: vorhandener Hinweis einmal`, async () => {
    await putSettings({ agents: { research: { engine: "codex" } }, engine: { ...(backups ? { backups: [{ engine: "opencode" }] } : {}) } });
    const s = setup({ mode: "json" });
    s.deps.resolveEngine = (key, d, turn) => resolveEngine(key, { ...d, env: () => ({}), log: () => {},
      checkEngine: async engine => ({ ...(engine === "codex" ? NOT_LOGGED_IN : READY), engine }) }, turn);
    expect(await s.turn(DM, undefined, { agentName: "research" })).toBe("antwort-claude");
    const first = s.notices.length;
    expect(s.notices.join(" ")).toContain(backups ? "Hier antwortet jetzt Claude Code statt Codex (Ausfall)." : "Codex ist nicht verfügbar, ich antworte mit Claude Code.");
    await s.turn(DM, undefined, { agentName: "research" });
    expect(s.notices).toHaveLength(first);
  });

  test("nach Ausfall des ersten Agenten löst der zweite keinen falschen Rückwechsel aus", async () => {
    await putSettings({ agents: { research: { engine: "codex" }, critic: { engine: "opencode" } },
      engine: { backups: [{ engine: "opencode" }] } });
    const s = setup({ mode: "json" });
    let codexReady = false;
    s.deps.resolveEngine = (key, d, turn) => resolveEngine(key, { ...d, env: () => ({}), log: () => {},
      checkEngine: async engine => ({ ...(engine === "codex" && !codexReady ? NOT_LOGGED_IN : READY), engine }) }, turn);
    expect(await s.turn(DM, undefined, { agentName: "research" })).toBe("antwort-claude");
    const notices = [...s.notices];
    expect(notices.join(" ")).toContain("Hier antwortet jetzt Claude Code statt Codex");
    expect(await s.turn(DM, undefined, { agentName: "critic" })).toBe("antwort-opencode");
    expect(s.notices).toEqual(notices);
    codexReady = true;
    expect(await s.turn(DM, undefined, { agentName: "research" })).toBe("antwort-codex");
    expect(s.notices.at(-1)).toContain("Hier antwortet wieder Codex.");
  });

  test("Agentenmotor ändern lässt die Session stehen; nächster Turn beginnt frisch mit Verlauf", async () => {
    const s = setup({ mode: "json" });
    await putSettings({ agents: { research: { engine: "claude" } } });
    await s.turn(DM, undefined, { agentName: "research" });
    const old = (await getSessionsForKey(sessionKeyFor(DM)))[0];
    await putSettings({ agents: { research: { engine: "codex" } } });
    expect((await getSessionsForKey(sessionKeyFor(DM)))[0]).toEqual(old);
    expect(await takeHandover(sessionKeyFor(DM), "research")).toBeUndefined();
    const sources = handoverSources(DM, old.startedAt);
    s.deps.buildPromptContext = options => buildPromptContext(options, sources);
    s.deps.buildResumePrompt = options => buildResumePrompt(options, sources);
    s.deps.resetSession = async () => { throw new Error("Kein Reset durch Agenteneinstellung"); };
    await s.turn(DM, undefined, { agentName: "research" });
    expect(calls[1].engine).toBe("codex");
    expect(calls[1].resumeSessionId).toBeUndefined();
    expect(calls[1].prompt).toContain("Erste Frage mit der Zahl 7319");
    expect(calls[1].prompt).toContain("Du übernimmst dieses Gespräch von Claude Code mit claude-agent-modell.");
  });
});
