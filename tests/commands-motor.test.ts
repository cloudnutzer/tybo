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
import type { CommandChannel, CommandContext, CommandServices, EngineCommandServices, SessionResetOutcome } from "../src/lib/commands/types";
import { createEngineCommandServices, resetEngineChoiceForTests, resolveEngine } from "../src/lib/engine-choice";
import type { EnginePreview, EnginePreviewStage } from "../src/lib/engine-choice";
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
  resetSessionOrThrow,
  sessionEpoch,
  setSessionsFileForTests,
  takeExpiredSession,
  takeHandover,
} from "../src/lib/session-manager";
import { createConversationSessionReset } from "../src/web/session-reset";
import { handoverProbe } from "./handover-fixture";
import { isolateAgentCatalog } from "./catalog-fixture";
isolateAgentCatalog();
import { topicEnv } from "./topic-fixture";
import { sessionKeyFor } from "../src/lib/store/message-rules";

import { TOOL_GAP_IDS, TOOL_GAP_TEXT, type EngineTools } from "../src/web/tool-parity-types";
import { MCP_GAP_REASONS, SKILL_GAP_REASONS, TOOL_HINT_REASONS } from "../src/web/tool-parity-types";

import { createEngineChecker, type EngineCheckNowDeps } from "../src/lib/engine-check-now";
import { readSwitchState, setSwitchStateFileForTests, updateSwitchState } from "../src/lib/engine-switch-state";
import { applyFailure, applyMeasurement, syncAuto, type SwitchUsage } from "../src/lib/engine-switch";
import { engineAuto } from "../src/lib/settings";

const motorNow = Date.parse("2026-11-17T12:00:00Z");
const motorAt = (minutes: number) => new Date(motorNow + minutes * 60_000).toISOString();
let usage: SwitchUsage;
let measurements: EngineCheckNowDeps["measurements"];
let workingCalls: number;
let workingStops: number;
let engineServiceOverride: EngineCommandServices | undefined;
let toolsReader: ((engine: EngineId) => EngineTools) | undefined;
let replyFormats: unknown[];

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
let claudeStatus: EngineStatus;
let env: Record<string, string | undefined>;
let errorSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-motor-"));
  file = join(dir, "settings.json");
  setSettingsPath(file);
  setSessionsFileForTests(join(dir, "sessions.json"));
  resetEngineChoiceForTests();
  setSwitchStateFileForTests(join(dir, "switch.json"));
  usage = { claude: [], codex: [], opencode: [], api: [] };
  measurements = {};
  workingCalls = workingStops = 0;
  toolsReader = undefined;
  engineServiceOverride = undefined;
  replyFormats = [];
  status = READY;
  claudeStatus = { engine: "claude", checked: true, installed: true, loggedIn: true };
  env = {};
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  setSwitchStateFileForTests(null);
  setSettingsPath();
  setSessionsFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function services(): CommandServices {
  if (engineServiceOverride) return { engines: engineServiceOverride } as CommandServices;
  const checkEngine = async (id: EngineId) => (id === "claude" ? claudeStatus : { ...status, engine: id });
  return {
    engines: createEngineCommandServices({
      checkEngine, now: () => motorNow, readSwitchState, updateSwitchState, readUsage: async () => usage,
      checkNow: createEngineChecker({ checkEngine, now: () => motorNow, readState: readSwitchState, updateState: updateSwitchState,
        readSettings: getSettings, readUsage: async () => usage, measurements, forgetCheck: () => {},
        claudeSubscription: () => env.CLAUDE_AUTH !== "apiKey" }),
      env: () => env,
      ...(toolsReader ? { toolSnapshot: () => ({ inventory: (id: EngineId) => toolsReader!(id).inventory, gaps: (id: EngineId) => toolsReader!(id).gaps }) } : {}),
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
    reply: async (t, options) => { replyFormats.push(options); out.replies.push(t); },
    notice: async (t) => void out.replies.push(t),
    buttons: async (t) => void out.replies.push(t),
    working: () => { workingCalls++; return () => { workingStops++; }; },
    resetSession: async (options) => {
      out.resets++;
      if (reset.status === "done") {
        await options?.beforeReset?.();
        await options?.whileBlocked?.();
      }
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
    chat: { reply: async (t, options) => { replyFormats.push(options); out.replies.push(t); } },
    chatId: "-1001",
    topicId,
    sessionKey: topicId ? `topic:-1001:${topicId}` : "group:-1001",
    agent: "general",
    text,
    match,
    services: services(),
    working: () => { workingCalls++; return () => { workingStops++; }; },
    resetSession: async (options) => {
      out.resets++;
      if (reset.status === "done") {
        await options?.beforeReset?.();
        await options?.whileBlocked?.();
      }
      return reset;
    },
    agentTurn: async () => {},
    boardMeeting: async () => {},
  });
  return out;
}

const topics = () => getSettings().engine?.topics ?? {};

function toolData(): EngineTools {
  return {
    inventory: { mcp: [{ name: "server_eigen", origin: "engine" }, { name: "von_tybo", origin: "tybo" }], skills: [{ name: "skill_eigen", origin: "engine" }, { name: "skill_tybo", origin: "tybo" }], notes: "passed", state: "ok" },
    gaps: { mcp: [{ name: "oauth_server", reason: "auth_unknown" }], skills: [{ name: "skill_fehlt", reason: "link_missing" }],
      hints: [{ name: "nur_tybo", reason: "user_skip" }, { name: "unzulaessig-12345678", reason: "invalid_name" }],
      notes: true, plugins: null, fixed: [...TOOL_GAP_IDS] },
  };
}

describe("Werkzeuganzeige (Issue #666)", () => {
  for (const channel of ["telegram", "web", "terminal"] as const) {
    const run = (text: string) => channel === "telegram" ? runTelegram(text, 7, { status: "busy" }) : runIn(channel, text, "web:666", { status: "busy" });
    test(`${channel}: Kurzfassung, vollständige Gründe, Klartext und während einer Antwort`, async () => {
      toolsReader = () => toolData();
      const short = await run("/motor");
      expect(short.replies[0]).toContain("Codex: 2 MCP-Server, 2 Skills, Notizen. Fehlt: 1 MCP-Server, 1 Skills");
      expect(short.replies[0]).toContain("Mehr mit /motor werkzeuge");
      expect(short.replies[0]).not.toContain("Claude Code: 2 MCP");
      const result = await run("/motor werkzeuge");
      const text = result.replies[0]!;
      expect(text).toContain("server_eigen (im Motor)");
      expect(text).toContain("von_tybo (von tybo)");
      expect(text).toContain("skill_eigen (im Motor)");
      expect(text).toContain("skill_tybo (von tybo)");
      expect(text).toContain(`Fehlende MCP-Server (oauth_server): ${TOOL_GAP_TEXT.auth_unknown}`);
      expect(text).toContain(`Fehlende Skills (skill_fehlt): ${TOOL_GAP_TEXT.link_missing}`);
      expect(text).toContain(`Hinweise (nur_tybo): ${TOOL_GAP_TEXT.user_skip}`);
      expect(text).toContain(`Hinweise (unzulaessig-12345678): ${TOOL_GAP_TEXT.invalid_name}`);
      for (const id of TOOL_GAP_IDS) expect(text).toContain(TOOL_GAP_TEXT[id]);
      expect(text).toContain(MOTOR_TEXT.pluginsUnknown);
      expect(text).toContain(MOTOR_TEXT.notesMissing);
      const claude = text.split("\n\n")[0]!;
      expect(claude).toContain(MOTOR_TEXT.baseline);
      expect(claude).not.toContain("Fehlende");
      expect(result.resets + short.resets).toBe(0);
      expect(topics()).toEqual({});
      expect(replyFormats.every(format => format === undefined)).toBe(true);
      expect(commandRegistry.match("/motor werkzeuge", channel)?.command.unscoped?.("werkzeuge")).toBe(true);
    });
    test(`${channel}: ohne Lücken unverändert; nicht bereite Motoren werden nicht gelesen`, async () => {
      const before = (await run("/motor")).replies;
      toolsReader = () => ({ ...toolData(), gaps: { mcp: [], skills: [], hints: [], fixed: [], notes: false, plugins: 0 } });
      expect((await run("/motor")).replies).toEqual(before);
      status = NOT_LOGGED_IN;
      toolsReader = id => { expect(id).toBe("claude"); return toolData(); };
      expect((await run("/motor")).replies[0]).not.toContain("Fehlt:");
      expect((await run("/motor werkzeuge")).replies[0]).not.toContain("Codex");
    });
    test(`${channel}: gescheiterter Dienst ohne Fehlertext; unbekannter Bestand sichtbar`, async () => {
      toolsReader = () => { throw new Error("ERFUNDENES_GEHEIMNIS -c mcp_servers TYBO_MCP_PRIVATE_TOKEN"); };
      for (const cmd of ["/motor", "/motor werkzeuge"]) {
        const text = (await run(cmd)).replies[0]!;
        expect(text).toContain(MOTOR_TEXT.toolsUnknown);
        expect(text).not.toContain("ERFUNDENES"); expect(text).not.toContain("TYBO_MCP_"); expect(text).not.toContain("-c mcp_servers");
      }
      toolsReader = () => { const data = toolData(); data.inventory.state = "unknown"; return data; };
      expect((await run("/motor werkzeuge")).replies[0]).toContain(MOTOR_TEXT.inventoryUnknown);
      expect(errorSpy).not.toHaveBeenCalled();
    });
    test(`${channel}: lange Skill-Bestände und Lücken werden gezählt, harte Grenze bei vielen Gründen`, async () => {
      const data = toolData();
      data.inventory.skills = Array.from({ length: 500 }, (_, i) => ({ name: `skill_${i}`, origin: "tybo" }));
      data.gaps.skills = data.inventory.skills.map(item => ({ name: item.name, reason: "skills_off" }));
      toolsReader = () => data;
      const text = (await run("/motor werkzeuge")).replies[0]!;
      expect(text.length).toBeLessThanOrEqual(4_000);
      expect(text).toContain("Skills: 500 von tybo, 0 im Motor");
      expect(text).toContain(`Fehlende Skills (500): ${TOOL_GAP_TEXT.skills_off}`);
      expect(text).not.toContain("skill_499");
      data.gaps.mcp = MCP_GAP_REASONS.map(reason => ({ name: "beispiel", reason }));
      data.gaps.skills = SKILL_GAP_REASONS.map(reason => ({ name: "beispiel", reason }));
      data.gaps.hints = TOOL_HINT_REASONS.map(reason => ({ name: "beispiel", reason }));
      const hard = (await run("/motor werkzeuge")).replies[0]!;
      expect(hard.length).toBeLessThanOrEqual(4_000);
      for (const label of ["Claude Code", "Codex", "OpenCode", "Anthropic API"]) expect(hard).toContain(label);
      expect(hard).toContain(MOTOR_TEXT.shortened);
    });
  }
});

describe("/motor mit echten Löschfunktionen (Issue #658)", () => {
  const key = "topic:-100658:5";
  const notes = () => JSON.parse(readFileSync(join(dir, "session-handover.json"), "utf8"));
  function context(channel: CommandChannel, text: string, busy = false, agent = "general"): CommandContext {
    const match = commandRegistry.match(text, channel)!;
    const deps = {
      sessionKey: () => key, isActive: () => busy, block: () => () => {},
      sessionsForKey: async (key: string) => {
        const sessions = await getSessionsForKey(key);
        if (text.startsWith("/motor") && sessions.length) {
          expect(notes()[`${key}:${agent}`]).toMatchObject({ since: sessions[0]!.startedAt });
        }
        return sessions;
      }, shouldDistill: () => false, distill: async () => {},
      sessionModeEnabled: () => true,
    };
    const webReset = createConversationSessionReset({ ...deps, reset: resetSessionOrThrow });
    return {
      channel, chatId: "-100658", topicId: 5, sessionKey: key, agent,
      name: match.command.name, args: match.args, text,
      reply: async () => {}, notice: async () => {}, buttons: async () => {}, working: () => { workingCalls++; return () => { workingStops++; }; },
      resetSession: channel === "telegram"
        ? createTelegramSessionReset(key, { ...deps, reset: (key, options) => resetSession(key, undefined, options) })
        : options => webReset("topic-5", options),
      agentTurn: async () => undefined, boardMeeting: async () => {}, services: services(),
    };
  }
  async function command(channel: CommandChannel, text: string, busy = false) {
    const ctx = context(channel, text, busy);
    await commandRegistry.match(text, channel)!.command.run(ctx);
  }
  for (const channel of ["telegram", "web", "terminal"] as const) {
    for (const direction of ["zum Gespräch", "zum Agenten", "gleich"] as const) test(`${channel}: Agentenmotor, ${direction}, Reset und Übergabe`, async () => {
      const topic = direction === "zum Agenten" ? "claude" : direction === "gleich" ? "codex" : undefined;
      const from = direction === "zum Agenten" ? "claude" : "codex";
      const to = direction === "zum Gespräch" ? "claude" : "codex";
      writeFileSync(file, JSON.stringify({ agents: { research: { engine: "codex" } },
        engine: { ...(topic ? { topics: { [key]: topic } } : {}) } }));
      await recordSessionTurn(key, "research", from === "claude" ? "claude-modell" : "", from, "alte-session");
      const old = (await getSessionsForKey(key))[0]!;
      const text = direction === "zum Gespräch" ? "/motor claude" : "/motor standard";
      const ctx = context(channel, text, false, "research");
      const original = ctx.resetSession;
      const resets: unknown[] = [];
      const replies: string[] = [];
      ctx.reply = async text => { replies.push(text); };
      ctx.resetSession = async options => { resets.push(options); return original(options); };
      await commandRegistry.match(text, channel)!.command.run(ctx);
      expect(resets).toHaveLength(direction === "gleich" ? 0 : 1);
      expect(getSettings().agents?.research?.engine).toBe("codex");
      if (direction !== "zum Gespräch") expect(replies[0]).toStartWith("Ausnahme entfernt: dieses Gespräch nimmt wieder den Motor des Agenten, Codex.");
      if (direction === "gleich") {
        expect(await getSessionsForKey(key)).toEqual([old]);
      } else {
        expect(resets[0]).toMatchObject({ preserveHandover: true });
        expect(await getSessionsForKey(key)).toEqual([]);
        const calls = await handoverProbe({ chatId: "-100658", topicId: 5, agentName: "research", engine: to, since: old.startedAt, configured: true });
        expect(calls[0]!.resumeSessionId).toBeUndefined();
        expect(calls[0]!.prompt).toContain("Erste Frage mit der Zahl 7319");
        expect(calls[0]!.prompt).toContain("Grund (Wahl des Nutzers)");
      }
    });
    for (const backups of [false, true]) test(`${channel}: Quelle Agent, Ersatzstufen=${backups}`, async () => {
      writeFileSync(file, JSON.stringify({ agents: { research: { engine: "codex" } },
        engine: { ...(backups ? { backups: [{ engine: "opencode" }] } : {}) } }));
      const ctx = context(channel, "/motor", false, "research");
      const replies: string[] = [];
      ctx.reply = async text => { replies.push(text); };
      await commandRegistry.match("/motor", channel)!.command.run(ctx);
      expect(replies[0]).toContain("Codex (für diesen Agenten eingestellt)");
    });

    test.each(["Wechsel", "zweiter Wechsel", "/new", "Topic löschen"] as const)(`${channel}: nächster Turn nach %s`, async scenario => {
      await recordSessionTurn(key, "general", "claude-modell", "claude", "private-session-id");
      const old = (await getSessionsForKey(key))[0]!;
      await command(channel, "/motor codex");
      if (scenario === "zweiter Wechsel") await command(channel, "/motor standard");
      if (scenario === "/new") await command(channel, "/new");
      if (scenario === "Topic löschen") {
        const topics = await topicEnv(dir, { groupId: () => "-100658", resetSession: resetSessionOrThrow });
        expect((await topics.manager.delete(5, async () => true)).body).toEqual({ deleted: true });
      }
      const handover = scenario === "Wechsel" || scenario === "zweiter Wechsel";
      if (!handover) expect(notes()).toEqual({});
      const calls = await handoverProbe({ chatId: "-100658", topicId: 5, engine: scenario === "zweiter Wechsel" ? "claude" : "codex", since: old.startedAt });
      expect(calls).toHaveLength(1);
      expect(calls[0]!.resumeSessionId).toBeUndefined();
      expect(calls[0]!.prompt.includes("Erste Frage mit der Zahl 7319")).toBe(handover);
      expect(calls[0]!.prompt.includes("Grund (Wahl des Nutzers)")).toBe(handover);
      expect(notes()).toEqual({});
    });

    test.each(["/motor", "/motor auto aus", "/motor pruefen", "/motor werkzeuge"])(`${channel}: %s erhält Session und schreibt keine Übergabe`, async text => {
      await recordSessionTurn(key, "general", "claude-modell", "claude", "alte-session");
      const before = await getSessionsForKey(key);
      const ctx = context(channel, text, true);
      ctx.resetSession = async () => { throw new Error("Anzeige/Prüfung darf nicht zurücksetzen"); };
      await commandRegistry.match(text, channel)!.command.run(ctx);
      expect(await getSessionsForKey(key)).toEqual(before);
      expect(await takeHandover(key, "general")).toBeUndefined();
    });

    test(`${channel}: Motor der alten Session ist bereits Codex, bewusster Reset übergibt trotzdem`, async () => {
      await recordSessionTurn(key, "general", "", "codex", "automatische-codex-session");
      const old = (await getSessionsForKey(key))[0]!;
      await command(channel, "/motor codex");
      const calls = await handoverProbe({ chatId: "-100658", topicId: 5, engine: "codex", since: old.startedAt });
      expect(calls[0]!.prompt).toContain("Du übernimmst dieses Gespräch von Codex.");
      expect(calls[0]!.prompt).toContain("Grund (Wahl des Nutzers)");
      expect(calls[0]!.prompt).toContain("Erste Frage mit der Zahl 7319");
      expect(calls[0]!.resumeSessionId).toBeUndefined();
    });

    test(`${channel}: Notiz übersteht den echten Reset, zweite Wahl erhält ursprünglichen Beginn, /new entfernt sie`, async () => {
      await recordSessionTurn(key, "general", "claude-modell", "claude", "private-session-id");
      const old = (await getSessionsForKey(key))[0]!;
      await command(channel, "/motor codex");
      expect(await getSessionsForKey(key)).toEqual([]);
      const first = notes();
      expect(first[`${key}:general`]).toMatchObject({ engine: "claude", model: "claude-modell", since: old.startedAt, reason: "user" });
      expect(JSON.stringify(first)).not.toContain("private-session-id");
      await command(channel, "/motor standard");
      expect(notes()).toEqual(first);
      await command(channel, "/new");
      expect(notes()).toEqual({});
      expect(await takeHandover(key, "general")).toBeUndefined();
    });

    test(`${channel}: busy schreibt keine Notiz und löscht keine Session`, async () => {
      await recordSessionTurn(key, "general", "claude-modell", "claude", "alte-session");
      await command(channel, "/motor codex", true);
      expect(await getSessionsForKey(key)).toHaveLength(1);
      expect(await takeHandover(key, "general")).toBeUndefined();
      expect(topics()).toEqual({});
    });
  }
});

describe("Register", () => {
  test("/motor und /engine in allen Kanälen, mit und ohne Argument", () => {
    for (const channel of ["telegram", "web", "terminal"] as const) {
      expect(commandRegistry.match("/motor", channel)?.command.name).toBe("motor");
      expect(commandRegistry.match("/engine codex", channel)).toMatchObject({ command: { name: "motor" }, invoked: "engine", args: "codex" });
      expect(commandRegistry.match("/motor standard", channel)?.args).toBe("standard");
    }
    const info = commandRegistry.list("web").find((c) => c.name === "motor")!;
    expect(info).toMatchObject({ aliases: ["engine"], args: "optional", argsHint: "[werkzeuge|claude|codex|opencode|api|standard|auto an|auto aus|pruefen]" });
  });
});

describe("Telegram", () => {
  test("ohne Argument: Motor dieses Gesprächs, Standard und verfügbare Motoren", async () => {
    const r = await runTelegram("/motor", 7);
    expect(r.replies).toEqual([
      [
        "Motor dieses Gesprächs: Claude Code (eingebauter Standard)",
        "Standard: Claude Code (eingebauter Standard)",
        "Verfügbar: Claude Code ✓, Codex ✓, OpenCode ✓, Anthropic API ✓",
        MOTOR_TEXT.noBackups,
        MOTOR_TEXT.usage,
      ].join("\n"),
    ]);
    expect(r.resets).toBe(0);
  });

  test("/motor codex setzt die Ausnahme nur für dieses Topic und beginnt eine neue Session", async () => {
    const r = await runTelegram("/motor codex", 7);
    expect(r.replies).toEqual(["Dieses Gespräch läuft jetzt mit Codex. Das beginnt eine neue Session; die letzten Nachrichten gehen mit."]);
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
    expect((await resolveEngine("topic:-1001:1", d, { agentName: "general" })).engine).toBe("claude");
    expect((await resolveEngine("topic:-1001:2", d, { agentName: "general" })).engine).toBe("codex");
  });

  test("/motor standard entfernt die Ausnahme, neue Session nur bei echtem Wechsel", async () => {
    await runTelegram("/motor codex", 7);
    const back = await runTelegram("/motor standard", 7);
    expect(back.replies).toEqual(["Ausnahme entfernt: dieses Gespräch nimmt wieder den Standard, Claude Code. Das beginnt eine neue Session; die letzten Nachrichten gehen mit. Es gilt wieder die Reihenfolge aus den Einstellungen."]);
    expect(back.resets).toBe(1);
    expect(getSettings().engine).toBeUndefined();
    const again = await runTelegram("/motor standard", 7);
    expect(again.replies).toEqual(["Dieses Gespräch nimmt schon den Standard, Claude Code. Es gilt wieder die Reihenfolge aus den Einstellungen."]);
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
    expect(back.replies[0]).toBe("Ausnahme entfernt: dieses Gespräch nimmt wieder den Standard, Codex. Es gilt wieder die Reihenfolge aus den Einstellungen.");
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
      "Dieses Gespräch läuft jetzt mit Codex. Das beginnt eine neue Session; die letzten Nachrichten gehen mit.\n" +
        "Codex ist gerade nicht bereit (Codex ist nicht angemeldet: im Terminal `codex login` ausführen), bis dahin antwortet Claude Code."
    );
    expect(topics()).toEqual({ "topic:-1001:7": "codex" });
  });

  test("unbekannter Motor wird abgelehnt, nichts geändert", async () => {
    for (const arg of ["gpt", "opencode2"]) {
      const r = await runTelegram(`/motor ${arg}`, 7);
      expect(r.replies).toEqual([`Unbekannter Motor „${arg}". Möglich: claude, codex, opencode, api, standard.`]);
      expect(r.resets).toBe(0);
    }
    expect(getSettings()).toEqual({});
  });

  test("/motor opencode setzt die Ausnahme nur für dieses Topic, die anderen bleiben (Issue #129)", async () => {
    writeFileSync(file, JSON.stringify({ engine: { topics: { "topic:-1001:9": "codex" } } }));
    const r = await runTelegram("/motor opencode", 7);
    expect(r.replies).toEqual(["Dieses Gespräch läuft jetzt mit OpenCode. Das beginnt eine neue Session; die letzten Nachrichten gehen mit."]);
    expect(r.resets).toBe(1);
    expect(topics()).toEqual({ "topic:-1001:7": "opencode", "topic:-1001:9": "codex" });
    const d = { checkEngine: async (id: EngineId) => ({ ...READY, engine: id }), env: () => env, log: () => {} };
    expect((await resolveEngine("topic:-1001:7", d, { agentName: "general" })).engine).toBe("opencode");
    expect((await resolveEngine("topic:-1001:8", d, { agentName: "general" })).engine).toBe("claude");
    expect((await resolveEngine("topic:-1001:9", d, { agentName: "general" })).engine).toBe("codex");
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
      working: () => { workingCalls++; return () => { workingStops++; }; },
      resetSession: async () => ({ status: "done", reset: 0, sessionMode: true }),
      agentTurn: async () => {},
      boardMeeting: async () => {},
    });
    expect(replies).toEqual([MOTOR_TEXT.unavailable]);
  });
});

describe("Claude Code mit echtem Stand (Issue #567)", () => {
  const CLAUDE_LOGGED_OUT: EngineStatus = {
    engine: "claude",
    checked: true,
    installed: true,
    loggedIn: false,
    message: "Claude Code ist nicht angemeldet: im Terminal `claude` starten und /login ausführen",
  };

  test("/motor zeigt Claude Code als nicht bereit, mit Grund, ohne „bis dahin antwortet Claude Code“", async () => {
    claudeStatus = CLAUDE_LOGGED_OUT;
    const r = await runIn("web", "/motor", "web:1");
    const text = r.replies.join("\n");
    expect(text).toContain("Claude Code (Claude Code ist nicht angemeldet: im Terminal `claude` starten und /login ausführen)");
    expect(text).toContain(`Claude Code ist gerade nicht bereit (${CLAUDE_LOGGED_OUT.message}). ${MOTOR_TEXT.claudeNotReady}`);
    expect(text).not.toContain("bis dahin antwortet Claude Code");
  });

  test("/motor claude bei abgemeldetem Claude: gespeichert, Hinweis ohne Rückfall auf sich selbst", async () => {
    claudeStatus = CLAUDE_LOGGED_OUT;
    const r = await runTelegram("/motor claude", 5);
    expect(r.replies[0]).toContain("Dieses Gespräch läuft schon mit Claude Code.");
    expect(r.replies[0]).toContain(MOTOR_TEXT.claudeNotReady);
  });

  test("Claude bereit: Häkchen, kein Hinweis", async () => {
    const r = await runIn("web", "/motor", "web:2");
    expect(r.replies.join("\n")).toContain("Claude Code ✓");
    expect(r.replies.join("\n")).not.toContain("nicht bereit");
  });

  test("Motor-Wahl fragt Claude Code nie ab: bleibt Rückfallmotor, auch wenn abgemeldet", async () => {
    let asked = 0;
    const d = { env: () => env, checkEngine: async (id: EngineId) => (asked++, id === "claude" ? CLAUDE_LOGGED_OUT : { ...NOT_LOGGED_IN, engine: id }), log: () => {} };
    expect((await resolveEngine("web:3", d, { agentName: "general" })).engine).toBe("claude");
    expect(asked).toBe(0);
    env.TYBO_ENGINE = "codex";
    expect((await resolveEngine("web:3", d, { agentName: "general" })).engine).toBe("claude");
    expect(asked).toBe(1);
  });
});

describe("Browser und Terminal", () => {
  const WEB = "web:0b3c6a2e-1f00-4c1a-9d0e-2a4b6c8d0e1f";

  test("Browser, Web-Gespräch: /motor codex setzt die Ausnahme unter web:<id>", async () => {
    const r = await runIn("web", "/motor codex", WEB);
    expect(r.replies).toEqual(["Dieses Gespräch läuft jetzt mit Codex. Das beginnt eine neue Session; die letzten Nachrichten gehen mit."]);
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
    resolveEngine: (key, d) => resolveEngine(key, { ...d, env: () => env, checkEngine: async () => READY, log: () => {} }, { agentName: "general" }),
    forgetEngineCheck: () => {},
    runFallbackChain: async () => {
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
      working: () => { workingCalls++; return () => { workingStops++; }; },
      resetSession: createTelegramSessionReset(KEY, {
        isActive: isExecutionActive,
        block: blockExecutions,
        sessionsForKey: getSessionsForKey,
        shouldDistill: () => false,
        distill: async () => {},
        reset: (key, options) => resetSession(key, undefined, options),
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
      working: () => { workingCalls++; return () => { workingStops++; }; },
      resetSession: createTelegramSessionReset(KEY, {
        isActive: isExecutionActive,
        block: blockExecutions,
        sessionsForKey: getSessionsForKey,
        shouldDistill: () => false,
        distill: async () => {},
        reset: (key, options) => resetSession(key, undefined, options),
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

describe("Automatik und Prüfen mit echtem Kern (Issue #668)", () => {
  const configure = () => writeFileSync(file, JSON.stringify({ engine: { backups: [{ engine: "codex" }, { engine: "opencode" }], auto: { enabled: true } } }));
  const measured = (percent: number, minutes = -1) => ({ state: "known" as const, id: "weekly_all" as const, percent, measuredAt: motorAt(minutes), resetsAt: motorAt(60), source: "extern" as const });
  async function threshold() {
    usage = { ...usage, claude: [measured(96)] };
    await updateSwitchState(state => applyMeasurement(syncAuto(state, engineAuto(), usage, motorNow), usage, motorNow, engineAuto()));
  }
  test("auto aus speichert, hebt nur Schwellen auf, spätere Messungen sperren nicht", async () => {
    configure(); await threshold();
    await updateSwitchState(state => applyFailure(applyFailure(state, { stage: { engine: "codex" }, kind: "limit" }, motorNow), { stage: { engine: "opencode" }, kind: "outage" }, motorNow));
    const result = await runTelegram("/motor auto aus", 7);
    expect(result.replies[0]).toStartWith(MOTOR_TEXT.autoOff);
    expect(result.replies[0]).toContain("Automatik: aus");
    expect(getSettings().engine?.auto?.enabled).toBe(false);
    expect(readSwitchState().blocks.map(b => b.cause).sort()).toEqual(["limit", "outage"]);
    usage = { ...usage, claude: [measured(99, 1)] };
    await updateSwitchState(state => applyMeasurement(state, usage, motorNow + 60_000, engineAuto()));
    expect(readSwitchState().blocks.some(b => b.cause === "threshold")).toBe(false);
    expect(result.resets).toBe(0);
  });
  test("auto an bewertet den gespeicherten Stand sofort und zeigt die Sperre", async () => {
    configure(); await threshold();
    await runTelegram("/motor auto aus", 7);
    const result = await runTelegram("/motor auto an", 7);
    expect(getSettings().engine?.auto?.enabled).toBe(true);
    expect(readSwitchState().blocks).toMatchObject([{ cause: "threshold", percent: 96 }]);
    expect(result.replies[0]).toStartWith("Automatik an: Wechsel ab 95 %, zurück unter 80 %.");
    expect(result.replies[0]).toContain("gesperrt bis");
    expect(result.replies[0]).toContain("Codex (springt ein)");
    expect(result.resets).toBe(0);
  });
  test("auto an ohne Ersatzstufen speichert wahr, nennt Schwellen und fehlende Stufen", async () => {
    const result = await runTelegram("/motor auto an", 7);
    expect(getSettings().engine?.auto?.enabled).toBe(true);
    expect(engineAuto().enabled).toBe(false);
    expect(result.replies[0]).toStartWith("Automatik an: Wechsel ab 95 %, zurück unter 80 %.");
    expect(result.replies[0]).toContain(MOTOR_TEXT.backupsMissing);
    expect(result.resets).toBe(0);
  });
  test("auto: ungültiges Wort und ungültige Datei ändern nichts", async () => {
    for (const command of ["/motor auto", "/motor auto vielleicht", "/motor auto an aus"]) {
      expect((await runTelegram(command, 7)).replies).toEqual([MOTOR_TEXT.autoUsage]);
      expect(getSettings()).toEqual({});
    }
    writeFileSync(file, "{ kaputt");
    expect((await runTelegram("/motor auto aus", 7)).replies).toEqual([MOTOR_TEXT.fileInvalid]);
    expect(readFileSync(file, "utf8")).toBe("{ kaputt");
  });
  for (const percent of [79, 80, 85]) test(`pruefen: frische ${percent} % gegen Rückkehrschwelle`, async () => {
    configure(); await threshold();
    measurements = { claude: [{ timeoutMs: 1000, measure: async () => { usage = { ...usage, claude: [measured(percent, 0)] }; } }] };
    const result = await runTelegram("/motor pruefen", 7);
    const remains = percent >= 80;
    expect(result.replies[0]).toStartWith(`Geprüft: ${remains ? 0 : 1} Sperren aufgehoben, ${remains ? 1 : 0} bleiben.`);
    expect(readSwitchState().blocks.length).toBe(remains ? 1 : 0);
    expect(result.replies[0]).not.toContain(MOTOR_TEXT.nextRun);
    expect(result.replies[0]).toContain("Nicht neu messbar: Codex.");
    expect(workingCalls).toBe(1); expect(workingStops).toBe(1); expect(result.resets).toBe(0);
  });
  test("prüfen ohne frische Messung löst threshold und Limit-Pause, erhält Fehlerzähler", async () => {
    configure(); await threshold();
    await updateSwitchState(state => applyFailure(state, { stage: { engine: "codex" }, kind: "limit" }, motorNow));
    const counters = readSwitchState().counters;
    const result = await runTelegram("/engine PRU\u0308FEN", 7);
    expect(result.replies[0]).toStartWith("Geprüft: 2 Sperren aufgehoben, 0 bleiben.");
    expect(result.replies[0]).toContain(MOTOR_TEXT.nextRun);
    expect(result.replies[0]).toContain("Nicht neu messbar: Claude Code, Codex. Der Stand kommt mit dem nächsten Lauf.");
    expect(readSwitchState().blocks).toEqual([]);
    expect(readSwitchState().counters).toEqual(counters);
    expect(result.replies[0]).not.toContain("gesperrt bis");
    expect(result.resets).toBe(0);
  });
  test("pruefen: erfolgreicher Bericht trotz altem Teil-Limit nicht unter Nicht neu messbar", async () => {
    configure(); await threshold();
    usage.claude.push({ ...measured(12, -60), id: "weekly_scoped:opus", source: "extern" });
    measurements = { claude: [{ timeoutMs: 1000, measure: async () => {
      usage.claude = [...usage.claude.filter(w => w.id !== "weekly_all"), measured(7, 0)];
      return { status: "measured" };
    } }] };
    const text = (await runTelegram("/motor pruefen", 7)).replies[0];
    expect(text).toStartWith("Geprüft: 1 Sperren aufgehoben, 0 bleiben.");
    expect(text).toContain("Nicht neu messbar: Codex.");
    expect(text).not.toContain("Messung ohne Ergebnis");
  });
  test("pruefen: gescheiterte Messung nennt alten Messwert, Sperre wird trotzdem frei", async () => {
    configure(); await threshold();
    const old = structuredClone(usage);
    measurements = { claude: [{ timeoutMs: 1000, measure: async () => ({ status: "failed" }) }] };
    const text = (await runTelegram("/motor pruefen", 7)).replies[0];
    expect(text).toStartWith("Geprüft: 1 Sperren aufgehoben, 0 bleiben.");
    expect(text).toContain("Claude Code: Messung ohne Ergebnis, der alte Stand bleibt.");
    expect(text).toContain("Das gilt für die Messwerte; Sperren wurden neu geprüft.");
    expect(text).toContain("Nicht neu messbar: Codex.");
    expect(usage).toEqual(old);
  });
  test("pruefen im API-Modus: Claude weder nicht messbar noch fehlgeschlagen, kein Messaufruf", async () => {
    configure(); env.CLAUDE_AUTH = "apiKey";
    let calls = 0;
    measurements = { claude: [{ timeoutMs: 1000, measure: async () => { calls++; return { status: "failed" }; } }] };
    const text = (await runTelegram("/motor pruefen", 7)).replies[0];
    expect(text).toContain("Nicht neu messbar: Codex.");
    expect(text).not.toContain("Claude Code: Messung ohne Ergebnis"); expect(calls).toBe(0);
  });
  for (const ready of [false, true]) test(`pruefen: outage, Motor bereit=${ready}`, async () => {
    configure();
    await updateSwitchState(state => applyFailure(state, { stage: { engine: "claude" }, kind: "outage" }, motorNow));
    claudeStatus = { ...claudeStatus, loggedIn: ready };
    const result = await runTelegram("/motor pruefen", 7);
    expect(result.replies[0]).toStartWith(`Geprüft: ${ready ? 1 : 0} Sperren aufgehoben, ${ready ? 0 : 1} bleiben.`);
    expect(readSwitchState().blocks.length).toBe(ready ? 0 : 1);
    expect(result.replies[0]).not.toContain(MOTOR_TEXT.nextRun);
  });
  test("pruefen: abgelaufene Sperre zählt wie keine Sperre", async () => {
    configure();
    await updateSwitchState(state => applyFailure(state, { stage: { engine: "claude" }, kind: "outage" }, motorNow - 60 * 60_000));
    claudeStatus = { ...claudeStatus, loggedIn: false };
    const result = await runTelegram("/motor pruefen", 7);
    expect(result.replies[0]).toStartWith("Geprüft: Es gab keine Sperre.");
    expect(readSwitchState().blocks).toEqual([]);
  });
});

describe("Wechsel von Hand nach der Wechselregel (Issue #668)", () => {
  for (const engine of ["claude", "codex", "opencode", "api"] as const) {
    test(`${engine}: Satz nur mit eingestellten Ersatzstufen`, async () => {
      const without = await runTelegram(`/motor ${engine}`, 7);
      expect(without.replies[0]).not.toContain("springt die nächste Stufe ein");
      writeFileSync(file, JSON.stringify({ engine: { backups: [{ engine: "codex" }] } }));
      const withBackups = await runTelegram(`/motor ${engine}`, 7);
      expect(withBackups.replies[0]).toContain(engine === "api"
        ? "Fällt die Anthropic API aus, springt die nächste Stufe ein."
        : `Ist ${engine === "claude" ? "Claude Code" : engine === "codex" ? "Codex" : "OpenCode"} am Limit oder fällt aus, springt die nächste Stufe ein.`);
    });
  }
  for (const resetKnown of [false, true]) test(`gesperrter Wunschmotor, Reset bekannt=${resetKnown}`, async () => {
    writeFileSync(file, JSON.stringify({ engine: { backups: [{ engine: "codex" }] } }));
    await updateSwitchState(state => ({ ...state, blocks: [{ engine: "codex", cause: "limit", since: motorAt(-1), until: motorAt(60), resetKnown }] }));
    const result = await runTelegram("/motor codex", 7);
    expect(result.replies[0]).toContain(`Codex ist ${resetKnown ? "gesperrt" : "pausiert"} bis`);
    expect(result.replies[0]).toContain("bis dahin antwortet Claude Code");
    expect(result.resets).toBe(1);
    const standard = await runTelegram("/motor standard", 7);
    expect(standard.replies[0]).toEndWith(MOTOR_TEXT.standardOrder);
  });
});

describe("Befehlsanzeige mit Dienst-Attrappen (Issue #668)", () => {
  function fixture(first: Partial<EnginePreviewStage> = {}): EnginePreview {
    const claude = { id: "claude", engine: "claude", label: "Claude Code", model: "claude-fable-5-2", windows: [], state: "answering", ...first } as EnginePreviewStage;
    const codex: EnginePreviewStage = { id: "codex", engine: "codex", label: "Codex", model: "gpt-6-astra", windows: [], state: claude.state === "answering" ? "free" : "answering" };
    return { answering: claude.state === "answering" ? claude : codex, role: claude.state === "answering" ? "first" : "backup",
      ...(claude.state !== "answering" ? { reason: claude } : {}), stages: [claude, codex], auto: { enabled: true, threshold: 95, returnBelow: 80 }, hasBackups: true,
      configured: { engine: "claude", source: "settings" }, standard: { engine: "claude", source: "settings" },
      available: [{ engine: "claude", label: "Claude Code", ready: true }, { engine: "codex", label: "Codex", ready: true }, { engine: "opencode", label: "OpenCode", ready: true }, { engine: "api", label: "Anthropic API", ready: true }],
    };
  }
  const render = async (preview: EnginePreview) => {
    const base = services().engines!;
    engineServiceOverride = { ...base, preview: async () => preview,
      available: async () => { throw new Error("Zweite Bereitschaftsprüfung"); },
    };
    const result = await runTelegram("/motor", 7);
    expect(result.resets).toBe(0);
    expect(result.replies).toHaveLength(1);
    expect(result.replies[0]).not.toContain("ohne Werkzeuge");
    return result.replies[0]!;
  };
  for (const cause of ["threshold", "limit", "outage"] as const) for (const resetKnown of [false, true]) {
    test(`${cause}, Reset bekannt=${resetKnown}: Text und Grund stammen aus der Vorschau`, async () => {
      const text = await render(fixture({ state: "blocked", cause, resetKnown, blockedUntil: motorAt(60), ...(cause === "threshold" ? { window: "weekly_all", percent: 96 } : {}) }));
      expect(text).toContain("Codex (springt ein)");
      expect(text).toContain(`Claude Code ist ${resetKnown && cause !== "outage" ? "gesperrt" : "pausiert"} bis`);
      if (cause === "threshold") expect(text).toContain("Woche, alle Modelle: 96 %");
      if (cause === "limit") expect(text).toContain("Limit erreicht");
      if (cause === "outage") expect(text).toContain("(Ausfall)");
      expect(text.includes("Reset unbekannt")).toBe(!resetKnown && cause !== "outage");
    });
  }
  for (const message of [undefined, "Bitte anmelden"]) test(`nicht bereit, Meldung=${message ?? "fehlt"}`, async () => {
    const text = await render(fixture({ state: "not_ready", ...(message ? { message } : {}) }));
    expect(text).toContain(`Grund: Claude Code ist nicht bereit${message ? ` (${message})` : "\n"}`);
    expect(text).not.toContain("undefined");
  });
  test("alles frei, manuell gewählt und keine freie Stufe", async () => {
    const p = fixture();
    expect(await render(p)).toContain("Claude Code (antwortet)");
    p.role = "manual";
    expect(await render(p)).toContain("Claude Code (von Hand gewählt)");
    p.answering = null; p.role = "none";
    expect(await render(p)).toContain("Motor in diesem Gespräch: keiner frei");
  });
  test("vier Ersatzstufen, zwei Motoren mit Lücken: eine Telegram-Nachricht, unveränderte Werkzeugtexte, keine Umgebungswerte", async () => {
    env = { TYBO_ENGINE: "UNGUELTIGER_UMGEBUNGSWERT_668", ANTHROPIC_API_KEY: "erfundener-testschluessel-668" };
    toolsReader = engine => engine === "codex" || engine === "opencode" ? toolData() : {
      ...toolData(), gaps: { mcp: [], skills: [], hints: [], notes: false, plugins: 0, fixed: [] },
    };
    const p = fixture();
    p.stages.splice(1, 0, { ...p.stages[0], id: "claude:claude-opus-5-5", model: "claude-opus-5-5", state: "free" },
      { ...p.stages[0], id: "claude:claude-sonnet-5-5", model: "claude-sonnet-5-5", state: "free" });
    p.stages.push({ id: "opencode", engine: "opencode", label: "OpenCode", model: "openrouter/anthropic/claude-opus-5.5", state: "free", windows: [] });
    const text = await render(p);
    expect(p.stages).toHaveLength(5);
    expect(text.length).toBeLessThanOrEqual(4000);
    expect(text).not.toContain("Weitere Angaben gekürzt");
    for (const value of Object.values(env)) expect(text).not.toContain(value!);
    for (const label of ["Codex", "OpenCode"]) expect(text).toContain(`${label}: 2 MCP-Server, 2 Skills, Notizen. Fehlt: 1 MCP-Server, 1 Skills, Notizen, Konnektoren des Claude-Kontos`);
    expect(text).toContain("Automatik: an"); expect(text).toContain("/motor pruefen");
    expect(text).toContain("5. OpenCode"); expect(text).toContain("Außerdem wählbar: Anthropic API ✓");
  });
  test("Schreibfehler wird ohne interne Fehlerdaten gemeldet", async () => {
    engineServiceOverride = { ...services().engines!, setAuto: async () => { throw new Error("erfundener-testschluessel-668"); } };
    expect((await runTelegram("/motor auto aus", 7)).replies).toEqual([MOTOR_TEXT.notSaved]);
  });
  test("working endet auch bei einem fehlgeschlagenen Prüfdienst", async () => {
    engineServiceOverride = { ...services().engines!, check: async () => { throw new Error("Prüfung fehlgeschlagen"); } };
    await expect(runTelegram("/motor pruefen", 7)).rejects.toThrow("Prüfung fehlgeschlagen");
    expect(workingCalls).toBe(1); expect(workingStops).toBe(1);
  });
});
