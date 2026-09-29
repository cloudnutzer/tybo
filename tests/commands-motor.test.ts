/**
 * /motor und /engine (Issue #125) über die gemeinsame Befehls-Schicht in
 * Telegram, Browser und Terminal. Die Einstellungsdatei ist echt (Temp),
 * die Verfügbarkeitsprüfung ist eine Attrappe (kein codex-Prozess), der
 * Session-Reset ebenso. src/bot.ts wird nie geladen.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { COMMAND_TEXT, commandRegistry, MOTOR_TEXT } from "../src/lib/commands/builtin";
import type { CommandChannel, CommandContext, CommandServices, SessionResetOutcome } from "../src/lib/commands/types";
import { createEngineCommandServices, resetEngineChoiceForTests, resolveEngine } from "../src/lib/engine-choice";
import type { EngineStatus } from "../src/lib/engines";
import { getSettings, setSettingsPath } from "../src/lib/settings";
import { createTelegramSessionReset, runTelegramCommand } from "../src/lib/commands/telegram";
import { blockExecutions, isAbortError, isExecutionActive, runExecution } from "../src/lib/execution-context";
import { runJsonTurn, type ChatTurnDeps } from "../src/lib/chat-turn";
import type { Engine, EngineId } from "../src/lib/engines";
import {
  getResumableSession,
  getSessionsForKey,
  recordSessionTurn,
  resetSession,
  sessionEpoch,
  setSessionsFileForTests,
  takeExpiredSession,
} from "../src/lib/session-manager";
import { sessionKeyFor } from "../src/lib/supabase";

const READY: EngineStatus = { engine: "codex", checked: true, installed: true, loggedIn: true };
const NOT_LOGGED_IN: EngineStatus = {
  engine: "codex",
  checked: true,
  installed: true,
  loggedIn: false,
  message: "Codex ist nicht angemeldet: im Terminal `codex login` ausführen",
};

let dir: string;
let file: string;
let status: EngineStatus;
let env: Record<string, string | undefined>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-motor-"));
  file = join(dir, "settings.json");
  setSettingsPath(file);
  resetEngineChoiceForTests();
  status = READY;
  env = {};
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  setSettingsPath();
  rmSync(dir, { recursive: true, force: true });
});

function services(): CommandServices {
  return {
    engines: createEngineCommandServices({
      checkEngine: async (id) => (id === "claude" ? { engine: "claude", checked: false, installed: true, loggedIn: true } : { ...status, engine: id }),
      env: () => env,
    }),
  } as unknown as CommandServices;
}

interface Run {
  replies: string[];
  resets: number;
}

/** Browser und Terminal: Kontext wie in src/web/bot-commands.ts, nur mit dem Nötigen */
async function runIn(channel: Exclude<CommandChannel, "telegram">, text: string, sessionKey: string, reset: SessionResetOutcome = { status: "done", reset: 1, sessionMode: true }): Promise<Run> {
  const match = commandRegistry.match(text, channel);
  if (!match) throw new Error(`kein Befehl: ${text}`);
  const out: Run = { replies: [], resets: 0 };
  const ctx: CommandContext = {
    channel,
    chatId: sessionKey,
    sessionKey,
    agent: "general",
    name: match.command.name,
    args: match.args,
    text,
    reply: async (t) => void out.replies.push(t),
    notice: async (t) => void out.replies.push(t),
    buttons: async (t) => void out.replies.push(t),
    working: () => () => {},
    resetSession: async (options) => {
      out.resets++;
      if (reset.status === "done") await options?.whileBlocked?.();
      return reset;
    },
    agentTurn: async () => undefined,
    boardMeeting: async () => {},
    services: services(),
  };
  await match.command.run(ctx);
  return out;
}

async function runTelegram(text: string, topicId?: number, reset: SessionResetOutcome = { status: "done", reset: 1, sessionMode: true }): Promise<Run> {
  const match = commandRegistry.match(text, "telegram");
  if (!match) throw new Error(`kein Befehl: ${text}`);
  const out: Run = { replies: [], resets: 0 };
  await runTelegramCommand({
    chat: { reply: async (t) => void out.replies.push(t) },
    chatId: "-1001",
    topicId,
    sessionKey: topicId ? `topic:-1001:${topicId}` : "group:-1001",
    agent: "general",
    text,
    match,
    services: services(),
    working: () => () => {},
    resetSession: async (options) => {
      out.resets++;
      if (reset.status === "done") await options?.whileBlocked?.();
      return reset;
    },
    agentTurn: async () => {},
    boardMeeting: async () => {},
  });
  return out;
}

const topics = () => getSettings().engine?.topics ?? {};

describe("Register", () => {
  test("/motor und /engine in allen Kanälen, mit und ohne Argument", () => {
    for (const channel of ["telegram", "web", "terminal"] as const) {
      expect(commandRegistry.match("/motor", channel)?.command.name).toBe("motor");
      expect(commandRegistry.match("/engine codex", channel)).toMatchObject({ command: { name: "motor" }, invoked: "engine", args: "codex" });
      expect(commandRegistry.match("/motor standard", channel)?.args).toBe("standard");
    }
    const info = commandRegistry.list("web").find((c) => c.name === "motor")!;
    expect(info).toMatchObject({ aliases: ["engine"], args: "optional", argsHint: "[claude|codex|opencode|standard]" });
  });
});

describe("Telegram", () => {
  test("ohne Argument: Motor dieses Gesprächs, Standard und verfügbare Motoren", async () => {
    const r = await runTelegram("/motor", 7);
    expect(r.replies).toEqual([
      [
        "Motor dieses Gesprächs: Claude Code (eingebauter Standard)",
        "Standard: Claude Code (eingebauter Standard)",
        "Verfügbar: Claude Code ✓, Codex ✓, OpenCode ✓",
        MOTOR_TEXT.usage,
      ].join("\n"),
    ]);
    expect(r.resets).toBe(0);
  });

  test("/motor codex setzt die Ausnahme nur für dieses Topic und beginnt eine neue Session", async () => {
    const r = await runTelegram("/motor codex", 7);
    expect(r.replies).toEqual(["Dieses Gespräch läuft jetzt mit Codex. Das beginnt eine neue Session, das Gedächtnis bleibt."]);
    expect(r.resets).toBe(1);
    expect(topics()).toEqual({ "topic:-1001:7": "codex" });
    // Topic 8 bleibt beim Standard
    expect((await runTelegram("/motor", 8)).replies[0]).toStartWith("Motor dieses Gesprächs: Claude Code (eingebauter Standard)");
    expect((await runTelegram("/motor", 7)).replies[0]).toStartWith("Motor dieses Gesprächs: Codex (mit /motor für dieses Gespräch gesetzt)");
  });

  test("/motor claude in Topic A bei Standard Codex: B bleibt bei Codex", async () => {
    writeFileSync(file, JSON.stringify({ engine: { default: "codex" } }));
    await runTelegram("/motor claude", 1);
    expect(topics()).toEqual({ "topic:-1001:1": "claude" });
    const d = { checkEngine: async () => READY, env: () => env, log: () => {} };
    expect((await resolveEngine("topic:-1001:1", d)).engine).toBe("claude");
    expect((await resolveEngine("topic:-1001:2", d)).engine).toBe("codex");
  });

  test("/motor standard entfernt die Ausnahme, neue Session nur bei echtem Wechsel", async () => {
    await runTelegram("/motor codex", 7);
    const back = await runTelegram("/motor standard", 7);
    expect(back.replies).toEqual(["Ausnahme entfernt: dieses Gespräch nimmt wieder den Standard, Claude Code. Das beginnt eine neue Session, das Gedächtnis bleibt."]);
    expect(back.resets).toBe(1);
    expect(getSettings().engine).toBeUndefined();
    const again = await runTelegram("/motor standard", 7);
    expect(again.replies).toEqual(["Dieses Gespräch nimmt schon den Standard, Claude Code."]);
    expect(again.resets).toBe(0);
  });

  test("Ausnahme gleich dem Standard: kein Wechsel, keine neue Session", async () => {
    writeFileSync(file, JSON.stringify({ engine: { default: "codex" } }));
    const r = await runTelegram("/motor codex", 7);
    expect(r.replies).toEqual(["Dieses Gespräch läuft schon mit Codex."]);
    expect(r.resets).toBe(0);
    expect(topics()).toEqual({ "topic:-1001:7": "codex" });
    const back = await runTelegram("/motor standard", 7);
    expect(back.resets).toBe(0);
    expect(back.replies[0]).toBe("Ausnahme entfernt: dieses Gespräch nimmt wieder den Standard, Codex.");
  });

  test("Standard aus TYBO_ENGINE wird genannt", async () => {
    env = { TYBO_ENGINE: "codex" };
    const r = await runTelegram("/motor");
    expect(r.replies[0]).toContain("Standard: Codex (Standard aus TYBO_ENGINE in .env)");
  });

  test("nicht angemeldetes Codex: Hinweis beim Anzeigen und beim Setzen, gesetzt wird trotzdem", async () => {
    status = NOT_LOGGED_IN;
    const show = await runTelegram("/motor", 7);
    expect(show.replies[0]).toContain("Codex (Codex ist nicht angemeldet: im Terminal `codex login` ausführen)");
    const set = await runTelegram("/motor codex", 7);
    expect(set.replies[0]).toBe(
      "Dieses Gespräch läuft jetzt mit Codex. Das beginnt eine neue Session, das Gedächtnis bleibt.\n" +
        "Codex ist gerade nicht bereit (Codex ist nicht angemeldet: im Terminal `codex login` ausführen), bis dahin antwortet Claude Code."
    );
    expect(topics()).toEqual({ "topic:-1001:7": "codex" });
  });

  test("unbekannter Motor wird abgelehnt, nichts geändert", async () => {
    for (const arg of ["gpt", "opencode2"]) {
      const r = await runTelegram(`/motor ${arg}`, 7);
      expect(r.replies).toEqual([`Unbekannter Motor „${arg}". Möglich: claude, codex, opencode, standard.`]);
      expect(r.resets).toBe(0);
    }
    expect(getSettings()).toEqual({});
  });

  test("/motor opencode setzt die Ausnahme nur für dieses Topic, die anderen bleiben (Issue #129)", async () => {
    writeFileSync(file, JSON.stringify({ engine: { topics: { "topic:-1001:9": "codex" } } }));
    const r = await runTelegram("/motor opencode", 7);
    expect(r.replies).toEqual(["Dieses Gespräch läuft jetzt mit OpenCode. Das beginnt eine neue Session, das Gedächtnis bleibt."]);
    expect(r.resets).toBe(1);
    expect(topics()).toEqual({ "topic:-1001:7": "opencode", "topic:-1001:9": "codex" });
    const d = { checkEngine: async (id: EngineId) => ({ ...READY, engine: id }), env: () => env, log: () => {} };
    expect((await resolveEngine("topic:-1001:7", d)).engine).toBe("opencode");
    expect((await resolveEngine("topic:-1001:8", d)).engine).toBe("claude");
    expect((await resolveEngine("topic:-1001:9", d)).engine).toBe("codex");
    expect((await runTelegram("/motor", 7)).replies[0]).toStartWith("Motor dieses Gesprächs: OpenCode (mit /motor für dieses Gespräch gesetzt)");
    expect((await runTelegram("/motor", 8)).replies[0]).toStartWith("Motor dieses Gesprächs: Claude Code (eingebauter Standard)");
  });

  test("TYBO_ENGINE=opencode ist ein gültiger Standard (Issue #129)", async () => {
    env = { TYBO_ENGINE: "opencode" };
    const r = await runTelegram("/motor");
    expect(r.replies[0]).toContain("Standard: OpenCode (Standard aus TYBO_ENGINE in .env)");
  });

  test("ungültige Einstellungsdatei: Hinweis, Datei bleibt unverändert", async () => {
    writeFileSync(file, "{ kaputt");
    const r = await runTelegram("/motor codex", 7);
    expect(r.replies).toEqual([MOTOR_TEXT.fileInvalid]);
    expect(readFileSync(file, "utf8")).toBe("{ kaputt");
  });

  test("ohne Session-Modus: Wechsel ohne Satz über die Session", async () => {
    const r = await runTelegram("/motor codex", 7, { status: "done", reset: 0, sessionMode: false });
    expect(r.replies).toEqual(["Dieses Gespräch läuft jetzt mit Codex."]);
  });

  test("ohne Motor-Dienst: Hinweis", async () => {
    const match = commandRegistry.match("/motor", "telegram")!;
    const replies: string[] = [];
    await runTelegramCommand({
      chat: { reply: async (t) => void replies.push(t) },
      chatId: "-1001",
      sessionKey: "group:-1001",
      agent: "general",
      text: "/motor",
      match,
      services: {} as CommandServices,
      working: () => () => {},
      resetSession: async () => ({ status: "done", reset: 0, sessionMode: true }),
      agentTurn: async () => {},
      boardMeeting: async () => {},
    });
    expect(replies).toEqual([MOTOR_TEXT.unavailable]);
  });
});

describe("Browser und Terminal", () => {
  const WEB = "web:0b3c6a2e-1f00-4c1a-9d0e-2a4b6c8d0e1f";

  test("Browser, Web-Gespräch: /motor codex setzt die Ausnahme unter web:<id>", async () => {
    const r = await runIn("web", "/motor codex", WEB);
    expect(r.replies).toEqual(["Dieses Gespräch läuft jetzt mit Codex. Das beginnt eine neue Session, das Gedächtnis bleibt."]);
    expect(topics()).toEqual({ [WEB]: "codex" });
  });

  test("Terminal, Direktchat: /engine codex, dann /engine standard", async () => {
    await runIn("terminal", "/engine codex", "dm:4711");
    expect(topics()).toEqual({ "dm:4711": "codex" });
    const r = await runIn("terminal", "/engine standard", "dm:4711");
    expect(r.replies[0]).toStartWith("Ausnahme entfernt");
    expect(getSettings()).toEqual({});
  });

  test("während einer laufenden Antwort: nichts geändert", async () => {
    const r = await runIn("web", "/motor codex", WEB, { status: "busy" });
    expect(r.replies).toEqual([MOTOR_TEXT.busy]);
    expect(getSettings()).toEqual({});
  });

  test("zwei Gespräche gleichzeitig: beide Ausnahmen bleiben erhalten", async () => {
    await Promise.all([runIn("web", "/motor codex", WEB), runIn("terminal", "/motor codex", "dm:4711"), runTelegram("/motor codex", 9)]);
    expect(topics()).toEqual({ [WEB]: "codex", "dm:4711": "codex", "topic:-1001:9": "codex" });
  });
});

/**
 * Motorwechsel gegen laufende und neue Turns abgesichert (Prüfung PR #214):
 * echter Telegram-Reset (createTelegramSessionReset) mit echter Sperre aus
 * execution-context und echter Session-Ablage (Temp-Datei), echter Chat-Kern
 * in runExecution wie in src/bot.ts. Nur die Motoren sind Attrappen.
 */
describe("Telegram mit echten Ausführungs- und Reset-Bausteinen", () => {
  const CHAT = "-1001";
  const TOPIC = 21;
  const KEY = sessionKeyFor(CHAT, TOPIC);
  let engineCalls: EngineId[];
  let gates: Partial<Record<EngineId, Promise<void>>>;

  function fake(id: EngineId): Engine {
    let n = 0;
    return {
      id,
      describe: () => `Attrappe ${id}`,
      async run() {
        engineCalls.push(id);
        await gates[id];
        n++;
        return { engine: id, text: `antwort-${id}`, sessionId: `${id}-${n}`, isError: false };
      },
    };
  }

  const engines: Partial<Record<EngineId, Engine>> = {};
  const turnDeps = (): Partial<ChatTurnDeps> => ({
    getEngine: (id) => engines[id]!,
    resolveEngine: (key, d) => resolveEngine(key, { ...d, env: () => env, checkEngine: async () => READY, log: () => {} }),
    forgetEngineCheck: () => {},
    callFallbackLLMWithSource: async () => {
      throw new Error("Fallback aufgerufen");
    },
    buildPromptContext: async () => ({ fullPrompt: "voll", fallbackContext: "" }),
    buildResumePrompt: async () => "weiter",
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
    getAgentConfig: () => ({ model: "claude-modell" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
    getSettings,
    reportSecrets: () => [],
  });

  /** Telegram-Turn wie in src/bot.ts: Chat-Kern in runExecution unter dem Session-Schlüssel */
  const turn = (agent = "general") =>
    runExecution(KEY, agent, () =>
      runJsonTurn({ userMessage: "Frage?", chatId: CHAT, topicId: TOPIC, agentName: agent, sink: { progress() {}, notice() {} }, deps: turnDeps() })
    );

  /** /motor in Telegram mit dem echten Reset; setTopic wartet auf writeGate */
  async function motor(text: string, writeGate?: Promise<void>, onWrite?: () => void): Promise<string[]> {
    const match = commandRegistry.match(text, "telegram")!;
    const real = createEngineCommandServices({ checkEngine: async () => READY, env: () => env });
    const replies: string[] = [];
    await runTelegramCommand({
      chat: { reply: async (t) => void replies.push(t) },
      chatId: CHAT,
      topicId: TOPIC,
      sessionKey: KEY,
      agent: "general",
      text,
      match,
      services: {
        engines: {
          ...real,
          async setTopic(key, engine) {
            onWrite?.();
            await writeGate;
            await real.setTopic(key, engine);
          },
        },
      } as unknown as CommandServices,
      working: () => () => {},
      resetSession: createTelegramSessionReset(KEY, {
        isActive: isExecutionActive,
        block: blockExecutions,
        sessionsForKey: getSessionsForKey,
        shouldDistill: () => false,
        distill: async () => {},
        reset: (key) => resetSession(key),
        sessionModeEnabled: () => true,
      }),
      agentTurn: async () => {},
      boardMeeting: async () => {},
    });
    return replies;
  }

  let warnSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    setSessionsFileForTests(join(dir, "sessions.json"));
    engineCalls = [];
    gates = {};
    engines.claude = fake("claude");
    engines.codex = fake("codex");
    warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    setSessionsFileForTests(null);
  });

  test("/new bleibt ohne Sperre: laufender Turn, trotzdem zurückgesetzt, der Turn speichert danach nichts", async () => {
    let open!: () => void;
    gates.claude = new Promise<void>((r) => (open = r));
    const running = turn();
    while (!engineCalls.length) await Bun.sleep(1);
    const replies: string[] = [];
    await runTelegramCommand({
      chat: { reply: async (t) => void replies.push(t) },
      chatId: CHAT,
      topicId: TOPIC,
      sessionKey: KEY,
      agent: "general",
      text: "/new",
      match: commandRegistry.match("/new", "telegram")!,
      services: {} as CommandServices,
      working: () => () => {},
      resetSession: createTelegramSessionReset(KEY, {
        isActive: isExecutionActive,
        block: blockExecutions,
        sessionsForKey: getSessionsForKey,
        shouldDistill: () => false,
        distill: async () => {},
        reset: (key) => resetSession(key),
        sessionModeEnabled: () => true,
      }),
      agentTurn: async () => {},
      boardMeeting: async () => {},
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]).not.toBe(COMMAND_TEXT.resetBusy);
    open();
    await running;
    expect(await getSessionsForKey(KEY)).toEqual([]);
  });

  test("laufender Telegram-Turn: /motor meldet busy, nichts geändert, der Turn behält seine Session", async () => {
    let open!: () => void;
    gates.claude = new Promise<void>((r) => (open = r));
    const running = turn();
    while (!engineCalls.length) await Bun.sleep(1);
    expect(await motor("/motor codex")).toEqual([MOTOR_TEXT.busy]);
    expect(getSettings()).toEqual({});
    open();
    expect(await running).toBe("antwort-claude");
    expect(await getSessionsForKey(KEY)).toMatchObject([{ engine: "claude", engineSessionId: "claude-1" }]);
  });

  test("/motor beendet die Sessions aller Agenten des Gesprächs", async () => {
    await recordSessionTurn(KEY, "general", "claude-modell", "claude", "S-general");
    await recordSessionTurn(KEY, "research", "claude-modell", "claude", "S-research");
    await recordSessionTurn(sessionKeyFor(CHAT, 22), "general", "claude-modell", "claude", "S-anderes-topic");
    const replies = await motor("/motor codex");
    expect(replies[0]).toStartWith("Dieses Gespräch läuft jetzt mit Codex.");
    expect(await getSessionsForKey(KEY)).toEqual([]);
    // Anderes Topic unberührt
    expect(await getSessionsForKey(sessionKeyFor(CHAT, 22))).toHaveLength(1);
    expect(topics()).toEqual({ [KEY]: "codex" });
  });

  test("neuer Turn zwischen Reset und verzögertem Schreiben: startet nicht, kein alter Motor schreibt seine Session zurück", async () => {
    await recordSessionTurn(KEY, "general", "claude-modell", "claude", "S-alt");
    let openWrite!: () => void;
    const writeGate = new Promise<void>((r) => (openWrite = r));
    let writing = false;
    const pending = motor("/motor codex", writeGate, () => (writing = true));
    while (!writing) await Bun.sleep(1);
    // Reset ist durch, die Einstellung noch nicht geschrieben
    expect(await getSessionsForKey(KEY)).toEqual([]);
    expect(getSettings()).toEqual({});

    // Neue Turns (auch anderer Agenten) enden sofort wie nach /stop, ohne Motor-Aufruf
    const late = await Promise.allSettled([turn(), turn("research")]);
    for (const r of late) {
      expect(r.status).toBe("rejected");
      expect(isAbortError((r as PromiseRejectedResult).reason)).toBe(true);
    }
    expect(engineCalls).toEqual([]);

    openWrite();
    expect((await pending)[0]).toStartWith("Dieses Gespräch läuft jetzt mit Codex.");
    expect(await getSessionsForKey(KEY)).toEqual([]);

    // Danach läuft das Gespräch mit Codex, eine Claude-Session entsteht nicht mehr
    expect(await turn()).toBe("antwort-codex");
    expect(engineCalls).toEqual(["codex"]);
    const stored = await getSessionsForKey(KEY);
    expect(stored.map((s) => s.engine)).toEqual(["codex"]);
  });
});
