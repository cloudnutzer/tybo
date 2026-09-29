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
import { mkdtemp, rm, writeFile, readFile, utimes } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runStreamingTurn,
  runJsonTurn,
  ABORT_REPLY,
  engineFailedNotice,
  resolveStreamingLimits,
  type ChatTurnDeps,
  type TurnInfo,
  type TurnSessionMeta,
  type TurnSink,
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
} from "../src/lib/session-manager";
import { setSpawnForTests } from "../src/lib/claude";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { getEngine, type Engine, type EngineId, type EngineRequest, type EngineResult, type EngineStatus } from "../src/lib/engines";
import { sessionKeyFor } from "../src/lib/supabase";

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

function setup(opts: { sessionMode?: boolean } = {}) {
  const engines: Partial<Record<EngineId, Engine>> = { claude: fakeEngine("claude"), codex: fakeEngine("codex"), opencode: fakeEngine("opencode") };
  const notices: string[] = [];
  const infos: TurnInfo[] = [];
  const metas: TurnSessionMeta[] = [];
  const fallbackCalls: string[] = [];
  const distilled: BotSession[] = [];
  const logs: unknown[][] = [];
  const sink: TurnSink = {
    progress: () => {},
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
    resolveEngine: (key, d?: Partial<EngineChoiceDeps>) =>
      resolveEngine(key, {
        ...d,
        env: () => env,
        checkEngine: async (id) => {
          checks++;
          return { ...status, engine: id };
        },
        log: () => {},
      }),
    forgetEngineCheck: () => {
      forgets++;
    },
    callFallbackLLMWithSource: async (msg) => {
      fallbackCalls.push(msg);
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
    runStreamingTurn({
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
  return { deps, turn, notices, infos, metas, fallbackCalls, distilled, logs, engines };
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tybo-125-"));
  settingsFile = join(dir, "settings.json");
  setSettingsPath(settingsFile);
  setSessionsFileForTests(join(dir, "sessions.json"));
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
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  setSettingsPath();
  setSessionsFileForTests(null);
  await rm(dir, { recursive: true, force: true });
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

  test("kein Aufruf von runStreamingTurn/runJsonTurn in src gibt engine vor", () => {
    const root = join(import.meta.dir, "..", "src");
    let seen = 0;
    for (const file of sourceFiles(root)) {
      const source = readFileSync(file, "utf8");
      for (const name of ["runStreamingTurn", "runJsonTurn"]) {
        for (const args of callArgs(source, name)) {
          seen++;
          // Nur Schlüssel auf oberster Ebene zählen nicht; jede engine-Angabe wäre verdächtig
          expect({ file, args: /\bengine\s*:/.test(args) }).toEqual({ file, args: false });
        }
      }
    }
    // bot.ts (Telegram, Goal-Engine, /board), Web-Chat, [INVOKE:], Web-Befehle
    expect(seen).toBeGreaterThanOrEqual(6);
  });
});
