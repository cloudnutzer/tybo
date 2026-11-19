/**
 * Issue #126, Checkbox 1: Motor in der WebUI. GET /api/engines (Standard,
 * Verfügbarkeit, abweichende Gespräche mit Namen), POST /api/engines/reset
 * („Auf Standard"), Motor je Gespräch in GET /api/conversations und das
 * SSE-Ereignis engine im Sammelstrom. Die Einstellungsdatei ist temporär
 * (setSettingsPath), der Motor-Port echt (createBotEngines), die Prüfung der
 * Motoren eine Attrappe: nie ein echtes claude oder codex.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineId, EngineStatus } from "../src/lib/engines";
import { apiModel, API_KEY_MISSING } from "../src/lib/engines/api";
import { CLAUDE_API_KEY_MISSING } from "../src/lib/engines/claude-auth";
import { CLAUDE_LOGIN_UNKNOWN, CLAUDE_NOT_INSTALLED, CLAUDE_NOT_LOGGED_IN, CODEX_NOT_INSTALLED, CODEX_NOT_LOGGED_IN, ENGINE_CHECK_TIMEOUT_MS, claudeStartFailedMessage } from "../src/lib/engines/check";
import { OPENCODE_NOT_INSTALLED, OPENCODE_NOT_LOGGED_IN, OPENCODE_VERSION_UNKNOWN, openCodeUnsupported } from "../src/lib/engines/opencode";
import { engineModelAndEffort, generalOrder, SELECTABLE_ENGINES, setTopicEngine } from "../src/lib/engine-choice";
import { getSettings, setSettingsPath, engineAuto } from "../src/lib/settings";
import { syncEngineAuto } from "../src/lib/engine-auto-sync";
import { applyMeasurement, pickStage, stageId, type SwitchBlock, type SwitchState, type SwitchUsage } from "../src/lib/engine-switch";
import { createBotEngines, ENGINE_WATCH_MS, type BotEnginesDeps } from "../src/web/bot-engines";
import { botSettings } from "../src/web/bot-settings";
import { conversationSessionKey } from "../src/web/bot-turn";
import { conversationEngines, ENGINE_TEXT, type EnginePort } from "../src/web/engines";
import type { WebServer } from "../src/web/server";
import { createOpenRouterKey, type OpenRouterKeyPort } from "../src/web/openrouter-key";
import { createConversationSessionReset, type SessionResetResult } from "../src/web/session-reset";
import type { TelegramConversation, TelegramSource } from "../src/web/telegram";
import { topicServer } from "./topic-fixture";
import { getSessionsForKey, recordSessionTurn, resetSessionOrThrow, setSessionsFileForTests, takeHandover } from "../src/lib/session-manager";
import { handoverProbe } from "./handover-fixture";
import { readSwitchHint, rememberSwitchHint, setSwitchStateFileForTests, settleSwitchStateForTests } from "../src/lib/engine-switch-state";

const GROUP = "-1001234567890";
const USER = "4242";
const DM_KEY = `dm:${USER}`;
const TOPIC_KEY = `topic:${GROUP}:443`;
const GONE_KEY = `topic:${GROUP}:999`;

const root = await mkdtemp(join(tmpdir(), "web-engines-api-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const servers: WebServer[] = [];
const cleanups: (() => void)[] = [];
let file: string;
let counter = 0;
const savedEnv = process.env.TYBO_ENGINE;
let switchState: SwitchState;
let usage: SwitchUsage;
let now: number;
let stateWrites: number;
const runtime = {
  readState: () => structuredClone(switchState),
  updateState: async (mutate: (state: SwitchState) => SwitchState) => {
    stateWrites++;
    switchState = mutate(switchState);
    return { state: structuredClone(switchState), persisted: true };
  },
  readUsage: async (at: number = now): Promise<SwitchUsage> => Object.fromEntries(Object.entries(usage).map(([engine, windows]) => [engine,
    windows.map(window => {
      if (window.state === "known" && window.resetsAt && Date.parse(window.resetsAt) <= at) {
        const { percent: _percent, ...expired } = window;
        return { ...expired, state: "expired", resetsAt: window.resetsAt };
      }
      return structuredClone(window);
    }),
  ])) as unknown as SwitchUsage,
  now: () => now,
};

beforeEach(() => {
  now = Date.now();
  stateWrites = 0;
  switchState = { version: 1, blocks: [], counters: [] };
  usage = { claude: [], codex: [], opencode: [], api: [] };
  delete process.env.TYBO_ENGINE;
  file = join(root, `settings-${++counter}.json`);
  setSettingsPath(file);
  setSessionsFileForTests(join(root, `sessions-${counter}`, "sessions.json"));
  setSwitchStateFileForTests(join(root, `switch-${counter}.json`));
});
afterEach(async () => {
  for (const c of cleanups.splice(0)) c();
  for (const s of servers.splice(0)) await s.stop({ graceMs: 50 });
  await settleSwitchStateForTests();
  setSwitchStateFileForTests(null);
  setSettingsPath();
  setSessionsFileForTests(null);
  if (savedEnv === undefined) delete process.env.TYBO_ENGINE;
  else process.env.TYBO_ENGINE = savedEnv;
});

async function readJson(): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, "utf-8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
}

async function waitUntil(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Bedingung nicht erreicht");
    await new Promise(r => setTimeout(r, 10));
  }
}

const conv = (id: string, title: string): TelegramConversation => ({ id, title, agent: "general", lastActivity: null });

/** Direktchat und zwei Topics, wie der Bot sie liefert */
const telegram: TelegramSource = {
  listConversations: async () => ({ dm: conv("dm", "Direktchat"), topics: [conv("topic-443", "Recherche"), conv("topic-1", "General")] }),
  groupChatId: () => GROUP,
  getConversation: async () => null,
  history: async () => null,
};

/** Prüf-Attrappe: Codex installiert, aber nicht angemeldet, OpenCode nicht installiert; Konto-Angaben dürfen nie ankommen */
const inspect = async (id: EngineId): Promise<EngineStatus> =>
  id === "claude"
    ? { engine: "claude", checked: true, installed: true, loggedIn: true, version: "2.1.281" }
    : id === "opencode"
      ? { engine: "opencode", checked: true, installed: false, loggedIn: false, message: "OpenCode ist nicht installiert" }
      : id === "api"
        ? { engine: "api", checked: true, installed: true, loggedIn: true }
        : {
        engine: "codex",
        checked: true,
        installed: true,
        loggedIn: false,
        version: "0.155.1",
        message: "Codex ist nicht angemeldet: im Terminal `codex login` ausführen",
      };

function port(overrides: { interval?: (fn: () => void) => void } = {}): EnginePort {
  return createBotEngines({ ...runtime,
    userId: USER,
    groupId: () => GROUP,
    agentForTopic: () => "research",
    inspect,
    ...(overrides.interval
      ? {
          setInterval: fn => {
            overrides.interval!(fn);
            return 1;
          },
          clearInterval: () => {},
        }
      : {}),
  });
}

interface ResetCall {
  id: string;
}

async function server(
  options: { engines?: EnginePort; openrouterKey?: OpenRouterKeyPort; reset?: (id: string, options?: import("../src/web/session-reset").ConversationSessionResetOptions) => Promise<SessionResetResult>; noReset?: boolean; telegram?: TelegramSource } = {}
) {
  const calls: ResetCall[] = [];
  const reset =
    options.reset ??
    (async (id: string, options?: import("../src/web/session-reset").ConversationSessionResetOptions): Promise<SessionResetResult> => {
      calls.push({ id });
      await options?.beforeReset?.();
      await options?.whileBlocked?.();
      return { status: "done", reset: 1, sessionMode: true };
    });
  const ctx = await topicServer(root, servers, null, {
    telegram: options.telegram ?? telegram,
    engines: options.engines ?? port(),
    openrouterKey: options.openrouterKey,
    ...(options.noReset ? {} : { resetConversation: reset }),
    settings: botSettings,
    onSettingsSaved: () => syncEngineAuto(runtime),
  });
  return { ...ctx, calls };
}

describe("GET /api/engines", () => {
  test("OpenRouter-Anzeige verändert weder Motorantwort samt Revision noch Sperren und Messwerte", async () => {
    await switchingSettings();
    switchState = { ...switchState, blocks: [block()] };
    usage = { ...usage, claude: [{ state: "known", id: "weekly_all", percent: 96,
      measuredAt: new Date(now).toISOString(), resetsAt: new Date(now + 60_000).toISOString(), source: "stream" }] };
    for (const status of [200, 401, 500]) {
      const ctx = await server({ engines: switchingPort(), openrouterKey: createOpenRouterKey({
        key: () => "TESTWERT-674-MOTOR",
        fetch: async () => Response.json({ data: { limit: 50, limit_remaining: 0, limit_reset: null, usage: 50, usage_monthly: 50 } }, { status }),
      }) });
      const before = await (await ctx.api("/api/engines")).json();
      const saved = structuredClone({ switchState, usage, stateWrites });
      expect((await ctx.api("/api/engines/openrouter")).status).toBe(200);
      expect(await (await ctx.api("/api/engines")).json()).toEqual(before);
      expect({ switchState, usage, stateWrites }).toEqual(saved);
      expect(before).not.toHaveProperty("openrouter");
    }
  });

  test("aufgelöste Modelle entsprechen je Motor General, einschließlich API-Kurzform und eigener Konfiguration", async () => {
    const ctx = await server();
    for (const engine of SELECTABLE_ENGINES) {
      for (const configured of [false, true]) {
        const settings = { agents: { general: { model: "opus" } }, defaults: { model: "claude-sonnet-5" },
          engine: { default: engine, ...(configured ? { codex: { model: "gpt-5.6-sol" }, opencode: { model: "openrouter/test/model" } } : {}) } };
        await writeFile(file, JSON.stringify(settings));
        const body = await (await ctx.api("/api/engines")).json();
        const expected = Object.fromEntries(SELECTABLE_ENGINES.map(id => [id, engineModelAndEffort(id, "general").model ?? null]));
        expect(body.resolvedModels).toEqual(expected);
        expect(body.resolvedModels.api).toBe(apiModel("opus"));
        expect(body.order[0].model).toBe(body.resolvedModels[engine]);
        expect(body.timeZone).toBe(process.env.USER_TIMEZONE || "UTC");
      }
    }
  });

  test("Zeitzone kommt vom Bot, ohne USER_TIMEZONE UTC", () => {
    const deps = { ...runtime, userId: USER, groupId: () => GROUP, agentForTopic: () => "general", inspect };
    expect(createBotEngines({ ...deps, choice: { env: () => ({ USER_TIMEZONE: "Pacific/Honolulu" }) } }).timeZone()).toBe("Pacific/Honolulu");
    expect(createBotEngines({ ...deps, choice: { env: () => ({}) } }).timeZone()).toBe("UTC");
  });

  test("Demo löst API-Kurzformen wie apiModel auf, eigene Konfiguration bleibt null", async () => {
    const { createDemoEngines, createDemoSettings } = await import("../src/web/demo");
    const settings = createDemoSettings({ agents: { general: { model: "opus" } }, engine: { default: "api" } });
    const engines = createDemoEngines(settings);
    expect(engines.resolvedModels()).toEqual({ claude: "opus", api: apiModel("opus"), codex: null, opencode: null });
    expect((await engines.switchStatus(await engines.availability())).order[0]!.model).toBe(apiModel("opus"));
    expect(engines.timeZone()).toBe("Europe/Berlin");
  });

  test("Auf Standard: echte Codex-Session gelöscht, Übergabenotiz bleibt ohne Session-ID", async () => {
    await setTopicEngine(TOPIC_KEY, "codex");
    await recordSessionTurn(TOPIC_KEY, "research", "codex-modell", "codex", "private-codex-id");
    const previous = (await getSessionsForKey(TOPIC_KEY))[0]!;
    const reset = createConversationSessionReset({
      sessionKey: () => TOPIC_KEY, isActive: () => false, block: () => () => {},
      sessionsForKey: async key => {
        // beforeReset hat schon geschrieben, die alte Session existiert noch.
        expect(await takeHandover(key, "research", { preserveUntilRecorded: true })).toMatchObject({ since: previous.startedAt });
        expect(await getSessionsForKey(key)).toHaveLength(1);
        return getSessionsForKey(key);
      },
      shouldDistill: () => false, distill: async () => {}, reset: resetSessionOrThrow,
      sessionModeEnabled: () => true,
    });
    const ctx = await server({ reset });
    const response = await ctx.api("/api/engines/reset", "POST", { key: TOPIC_KEY });
    expect(response.status).toBe(200);
    expect(await getSessionsForKey(TOPIC_KEY)).toEqual([]);
    const stored = await readFile(join(root, `sessions-${counter}`, "session-handover.json"), "utf8");
    expect(JSON.parse(stored)[`${TOPIC_KEY}:research`]).toMatchObject({ engine: "codex", model: "codex-modell", reason: "user", since: previous.startedAt });
    expect(stored).not.toContain("private-codex-id");
    const calls = await handoverProbe({ chatId: GROUP, topicId: 443, agentName: "research", engine: "claude", since: previous.startedAt });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.resumeSessionId).toBeUndefined();
    expect(calls[0]!.prompt).toContain("Du übernimmst dieses Gespräch von Codex mit codex-modell.");
    expect(calls[0]!.prompt).toContain("Grund (Wahl des Nutzers)");
    expect(calls[0]!.prompt).toContain("Erste Frage mit der Zahl 7319");
    expect(JSON.parse(await readFile(join(root, `sessions-${counter}`, "session-handover.json"), "utf8"))).toEqual({});
  });

  test("Standard, Motoren, Verfügbarkeit aus der Attrappe, Ausnahmen mit Namen; nicht zuzuordnende am Ende", async () => {
    await writeFile(file, JSON.stringify({ engine: { topics: { [TOPIC_KEY]: "codex", [GONE_KEY]: "codex", [DM_KEY]: "claude" } } }));
    const ctx = await server();
    const res = await ctx.api("/api/engines");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.default).toEqual({ engine: "claude", source: "code" });
    expect(body.engines).toEqual([
      { id: "claude", label: "Claude Code" },
      { id: "codex", label: "Codex" },
      { id: "opencode", label: "OpenCode" },
      { id: "api", label: "Anthropic API" },
    ]);
    expect(body.availability).toEqual([
      { engine: "claude", label: "Claude Code", installed: true, loggedIn: true, version: "2.1.281" },
      {
        engine: "codex",
        label: "Codex",
        installed: true,
        loggedIn: false,
        version: "0.155.1",
        message: "Codex ist nicht angemeldet: im Terminal `codex login` ausführen",
      },
      { engine: "opencode", label: "OpenCode", installed: false, loggedIn: false, message: "OpenCode ist nicht installiert" },
      { engine: "api", label: "Anthropic API", installed: true, loggedIn: true },
    ]);
    expect(body.overrides).toEqual([
      { key: DM_KEY, engine: "claude", label: "Claude Code", conversationId: "dm", title: "Direktchat" },
      { key: TOPIC_KEY, engine: "codex", label: "Codex", conversationId: "topic-443", title: "Recherche" },
      { key: GONE_KEY, engine: "codex", label: "Codex", conversationId: null, title: null },
    ]);
  });

  test("Standard aus TYBO_ENGINE mit Quelle env; Verfügbarkeit nicht ermittelbar ergibt null", async () => {
    process.env.TYBO_ENGINE = "codex";
    const failing: EnginePort = { ...port(), availability: async () => Promise.reject(new Error("kaputt")) };
    const ctx = await server({ engines: failing });
    const body = await (await ctx.api("/api/engines")).json();
    expect(body.default).toEqual({ engine: "codex", source: "env" });
    expect(body.availability).toBeNull();
    expect(ctx.logs.some(l => l.includes("Verfügbarkeit nicht ermittelbar"))).toBe(true);
  });

  test.each([
    ["claude", CLAUDE_NOT_INSTALLED, false, false],
    ["codex", CODEX_NOT_INSTALLED, false, false],
    ["opencode", OPENCODE_NOT_INSTALLED, false, false],
    ["api", API_KEY_MISSING, true, false],
    ["claude", CLAUDE_API_KEY_MISSING, true, false],
    ["claude", CLAUDE_LOGIN_UNKNOWN, true, true],
    ["opencode", OPENCODE_VERSION_UNKNOWN, false, false],
    ["claude", CLAUDE_NOT_LOGGED_IN, true, false],
    ["codex", CODEX_NOT_LOGGED_IN, true, false],
    ["opencode", OPENCODE_NOT_LOGGED_IN, true, false],
    ["opencode", openCodeUnsupported({ major: 2, version: "2.0.0" }), false, false],
    ["claude", claudeStartFailedMessage("EAGAIN"), false, false],
    ["claude", claudeStartFailedMessage(undefined), false, false],
    ["codex", `Codex-Anmeldung nicht prüfbar: codex login status brauchte länger als ${ENGINE_CHECK_TIMEOUT_MS / 1000} s`, true, false],
    ["codex", "Codex-Anmeldung nicht prüfbar: codex login status ließ sich nicht starten", true, false],
    ["opencode", `OpenCode-Anmeldung nicht prüfbar: opencode auth list brauchte länger als ${ENGINE_CHECK_TIMEOUT_MS / 1000} s`, true, true],
    ["opencode", "OpenCode-Anmeldung nicht prüfbar: opencode auth list ließ sich nicht starten", true, true],
    ["opencode", "OpenCode-Anmeldung nicht prüfbar: Ausgabe von opencode auth list nicht erkennbar", true, true],
    ["opencode", "OpenCode-Anmeldung nicht prüfbar: opencode auth list endete mit Exit-Code 1", true, true],
    ["opencode", "OpenCode-Anmeldung nicht prüfbar: opencode auth list endete mit Exit-Code null", true, true],
  ] as const)("echte Bereitschaftsmeldung bleibt unverändert (%s: %s)", async (engine, message, installed, loginUnknown) => {
    const ctx = await server({ engines: switchingPort({ inspect: async id => id === engine
      ? { engine, checked: true, installed, loggedIn: false, message, ...(loginUnknown ? { loginUnknown: true } : {}) }
      : allReady(id),
    }) });
    const response = await ctx.api("/api/engines");
    expect(response.status).toBe(200);
    expect((await response.json()).availability.find((entry: { engine: string }) => entry.engine === engine)).toMatchObject({
      installed, loggedIn: loginUnknown ? null : false, message,
    });
  });

  test.each([
    ["claude", "Claude Code"], ["codex", "Codex"], ["opencode", "OpenCode"],
  ] as const)("Zeitlimit und Exit-Code der Versionsprüfung bleiben unverändert (%s)", async (engine, label) => {
    let message = `${label} antwortet nicht: ${engine} --version brauchte länger als ${ENGINE_CHECK_TIMEOUT_MS / 1000} s`;
    const ctx = await server({ engines: switchingPort({ inspect: async id => id === engine
      ? { engine, checked: true, installed: false, loggedIn: false, message }
      : allReady(id),
    }) });
    for (const text of [message, ...[1, -1, null].map(code => `${label} startet nicht: ${engine} --version endete mit Exit-Code ${code}`)]) {
      message = text;
      const response = await ctx.api("/api/engines");
      expect(response.status).toBe(200);
      expect((await response.json()).availability.find((entry: { engine: string }) => entry.engine === engine).message).toBe(message);
    }
  });

  test("Schutz: ohne Anmeldung 401, falsche Methode 405, ohne Port 503", async () => {
    const ctx = await server();
    expect((await fetch(`${ctx.origin}/api/engines`, { headers: { origin: ctx.origin } })).status).toBe(401);
    expect((await ctx.api("/api/engines", "POST", {})).status).toBe(405);
    expect((await ctx.api("/api/engines/reset")).status).toBe(405);
    const bare = await topicServer(root, servers, null, {});
    expect((await bare.api("/api/engines")).status).toBe(503);
    expect((await bare.api("/api/engines/reset", "POST", { key: DM_KEY })).status).toBe(503);
  });
});

describe("Motor je Gespräch in GET /api/conversations", () => {
  test("Ausnahme sonst Standard, dazu der Standard; ohne Port keine Angaben", async () => {
    await writeFile(file, JSON.stringify({ engine: { default: "codex", topics: { [DM_KEY]: "claude" } } }));
    const ctx = await server();
    const web = await ctx.store.createConversation("research");
    const body = await (await ctx.api("/api/conversations")).json();
    expect(body.engine).toEqual({ default: "codex", timeZone: process.env.USER_TIMEZONE || "UTC" });
    expect(body.telegram.dm.engine).toBe("claude");
    expect(body.telegram.topics.map((t: any) => [t.id, t.engine])).toEqual([
      ["topic-443", "codex"],
      ["topic-1", "codex"],
    ]);
    expect(body.conversations.find((c: any) => c.id === web.id).engine).toBe("codex");

    const bare = await topicServer(root, servers, null, { telegram });
    const plain = await (await bare.api("/api/conversations")).json();
    expect(plain.engine).toBeUndefined();
    expect(plain.telegram.dm.engine).toBeUndefined();
  });

  test("conversationEngines: Schlüssel wie beim Schreiben, unbekannte IDs bekommen den Standard", () => {
    const fake = {
      standard: () => ({ engine: "claude", source: "code" as const }),
      overrides: () => ({ [TOPIC_KEY]: "codex" }),
      agentEngines: () => ({}),
      sessionKey: (id: string) => (id === "topic-443" ? TOPIC_KEY : id === "kaputt" ? (() => { throw new Error("x"); })() : null),
    };
    expect(conversationEngines(fake, ["topic-443", "dm", "kaputt"].map(id => ({ id, agent: "general" })))).toEqual({ "topic-443": "codex", dm: "claude", kaputt: "claude" });
  });
});

describe("POST /api/engines/reset („Auf Standard\")", () => {
  test("Akzeptanz: entfernt genau einen Eintrag, über den Session-Reset des Gesprächs wie /motor standard", async () => {
    await writeFile(
      file,
      JSON.stringify({ engine: { default: "claude", codex: { sandbox: "read-only" }, topics: { [TOPIC_KEY]: "codex", [DM_KEY]: "codex", [GONE_KEY]: "claude" } } })
    );
    const ctx = await server();
    const res = await ctx.api("/api/engines/reset", "POST", { key: TOPIC_KEY });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(await readJson()).toEqual({
      engine: { default: "claude", codex: { sandbox: "read-only" }, topics: { [DM_KEY]: "codex", [GONE_KEY]: "claude" } },
    });
    expect(ctx.calls).toEqual([{ id: "topic-443" }]);
    expect(body.overrides.map((o: any) => o.key)).toEqual([DM_KEY, GONE_KEY]);
    // Log ohne Schlüssel
    expect(ctx.logs.join("\n")).not.toContain(TOPIC_KEY);
  });

  test("Ausnahme einer anderen Gruppe: kann kein Gespräch der WebUI sein, direkt entfernt, ohne Session-Reset", async () => {
    const foreign = "topic:-1009999999999:5";
    await writeFile(file, JSON.stringify({ engine: { topics: { [foreign]: "codex" } } }));
    const ctx = await server();
    const res = await ctx.api("/api/engines/reset", "POST", { key: foreign });
    expect(res.status).toBe(200);
    expect(await readJson()).toEqual({});
    expect(ctx.calls).toEqual([]);
  });

  test("Topic der eigenen Gruppe, das nicht in der Liste steht: trotzdem über den Session-Reset", async () => {
    await writeFile(file, JSON.stringify({ engine: { topics: { [GONE_KEY]: "codex" } } }));
    const ctx = await server();
    const res = await ctx.api("/api/engines/reset", "POST", { key: GONE_KEY });
    expect(res.status).toBe(200);
    expect(await readJson()).toEqual({});
    expect(ctx.calls).toEqual([{ id: "topic-999" }]);
  });

  test("laufende Antwort im Gespräch: 409, nichts geändert", async () => {
    const before = JSON.stringify({ engine: { topics: { [DM_KEY]: "codex" } } });
    await writeFile(file, before);
    const ctx = await server({ reset: async () => ({ status: "busy" }) });
    const res = await ctx.api("/api/engines/reset", "POST", { key: DM_KEY });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("läuft gerade eine Antwort");
    expect(await readFile(file, "utf-8")).toBe(before);
  });

  test("Gesprächsliste nicht lesbar oder unvollständig: Session-Schutz bleibt, laufende Antwort ergibt 409", async () => {
    const failing: TelegramSource = { ...telegram, listConversations: async () => Promise.reject(new Error("offline")) };
    const partial: TelegramSource = { ...telegram, listConversations: async () => ({ dm: null, topics: [] }) };
    for (const source of [failing, partial]) {
      for (const key of [DM_KEY, TOPIC_KEY, `group:${GROUP}`]) {
        const before = JSON.stringify({ engine: { topics: { [key]: "codex" } } });
        await writeFile(file, before);
        const ids: string[] = [];
        const ctx = await server({
          telegram: source,
          reset: async id => {
            ids.push(id);
            return { status: "busy" };
          },
        });
        const res = await ctx.api("/api/engines/reset", "POST", { key });
        expect(res.status).toBe(409);
        expect(await readFile(file, "utf-8")).toBe(before);
        expect(ids).toEqual([key === DM_KEY ? "dm" : key === TOPIC_KEY ? "topic-443" : "topic-1"]);
      }
    }
  });

  test("Web-Gespräch, das nicht in der Liste steht: Session-Reset über den Schlüssel web:<id>", async () => {
    const key = "web:abc-123";
    await writeFile(file, JSON.stringify({ engine: { topics: { [key]: "codex" } } }));
    const ctx = await server();
    expect((await ctx.api("/api/engines/reset", "POST", { key })).status).toBe(200);
    expect(ctx.calls).toEqual([{ id: "abc-123" }]);
    expect(await readJson()).toEqual({});
  });

  test("Zuordnung nicht feststellbar (Schlüssel nicht bildbar): 503, nichts geändert", async () => {
    const before = JSON.stringify({ engine: { topics: { [DM_KEY]: "codex" } } });
    await writeFile(file, before);
    const broken: EnginePort = {
      ...port(),
      sessionKey: () => {
        throw new Error("kaputt");
      },
    };
    const ctx = await server({ engines: broken });
    const res = await ctx.api("/api/engines/reset", "POST", { key: DM_KEY });
    expect(res.status).toBe(503);
    expect(await readFile(file, "utf-8")).toBe(before);
    expect(ctx.calls).toEqual([]);
  });

  /**
   * Echte Kette wie in src/bot.ts: createBotEngines und der Session-Reset
   * bilden den Schlüssel über conversationSessionKey/resolveTelegramTarget;
   * im Gespräch läuft eine Antwort (isActive).
   */
  function realChain(keyDeps: { userId?: string; groupId: () => string | null; resetGroupId?: () => string | null }) {
    const touched: string[] = [];
    const engines = createBotEngines({ ...runtime, userId: keyDeps.userId, groupId: keyDeps.groupId, agentForTopic: () => "research", inspect });
    const reset = createConversationSessionReset<never>({
      sessionKey: id => conversationSessionKey(id, { userId: keyDeps.userId, groupId: keyDeps.resetGroupId ?? keyDeps.groupId, agentForTopic: () => "research" }),
      isActive: () => true,
      block: key => {
        touched.push(`block ${key}`);
        return () => {};
      },
      sessionsForKey: async () => [],
      shouldDistill: () => false,
      distill: async () => {},
      reset: async key => {
        touched.push(`reset ${key}`);
        return 0;
      },
      sessionModeEnabled: () => true,
      log: () => {},
    });
    return { engines, reset, touched };
  }

  test("Gruppenzuordnung null oder fehlschlagend (echte Schlüssel-Kette): 503, Datei bytegleich, laufende Antwort nicht umgangen", async () => {
    const failing = [
      { name: "null", groupId: () => null },
      {
        name: "wirft",
        groupId: (): string | null => {
          throw new Error("config/topics.json nicht lesbar");
        },
      },
    ];
    for (const { groupId } of failing) {
      for (const key of [TOPIC_KEY, `group:${GROUP}`]) {
        const before = JSON.stringify({ engine: { topics: { [key]: "codex", [DM_KEY]: "claude" } } });
        await writeFile(file, before);
        const chain = realChain({ userId: USER, groupId });
        const ctx = await server({ engines: chain.engines, reset: chain.reset });
        const res = await ctx.api("/api/engines/reset", "POST", { key });
        expect(res.status).toBe(503);
        expect((await res.json()).error).toBe(ENGINE_TEXT.unassignable);
        expect(await readFile(file, "utf-8")).toBe(before);
        expect(chain.touched).toEqual([]);
        expect(ctx.logs.join("\n")).not.toContain(key);
      }
    }
    // Direktchat ohne TELEGRAM_USER_ID: ebenso nicht zuzuordnen
    const before = JSON.stringify({ engine: { topics: { [DM_KEY]: "codex" } } });
    await writeFile(file, before);
    const chain = realChain({ userId: undefined, groupId: () => GROUP });
    const ctx = await server({ engines: chain.engines, reset: chain.reset });
    expect((await ctx.api("/api/engines/reset", "POST", { key: DM_KEY })).status).toBe(503);
    expect(await readFile(file, "utf-8")).toBe(before);
  });

  test("Session-Reset meldet unavailable (Gruppe fällt zwischendurch weg): 503, nichts geschrieben, laufende Antwort nicht umgangen", async () => {
    const before = JSON.stringify({ engine: { topics: { [TOPIC_KEY]: "codex" } } });
    await writeFile(file, before);
    // Zuordnung gelingt noch, beim Session-Reset ist die Gruppe nicht mehr lesbar
    const chain = realChain({ userId: USER, groupId: () => GROUP, resetGroupId: () => null });
    const ctx = await server({ engines: chain.engines, reset: chain.reset });
    const res = await ctx.api("/api/engines/reset", "POST", { key: TOPIC_KEY });
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe(ENGINE_TEXT.unassignable);
    expect(await readFile(file, "utf-8")).toBe(before);
    expect(chain.touched).toEqual([]);

    // Attrappe: unavailable ergibt nie ein Schreiben, auch wenn write mitgegeben wird
    await writeFile(file, before);
    let writeCalled = false;
    const ctx2 = await server({
      reset: async () => ({ status: "unavailable" }),
      engines: { ...port(), removeOverride: async () => ((writeCalled = true), true) },
    });
    expect((await ctx2.api("/api/engines/reset", "POST", { key: TOPIC_KEY })).status).toBe(503);
    expect(writeCalled).toBe(false);
    expect(await readFile(file, "utf-8")).toBe(before);
  });

  test("unbekannter Schlüssel 404 mit aktuellem Stand, ungültige Anfrage 400, ungültige Datei 409", async () => {
    await writeFile(file, JSON.stringify({ engine: { topics: { [DM_KEY]: "codex" } } }));
    const ctx = await server();
    let res = await ctx.api("/api/engines/reset", "POST", { key: TOPIC_KEY });
    expect(res.status).toBe(404);
    expect((await res.json()).overrides).toHaveLength(1);
    for (const body of ["{", JSON.stringify({ key: "x; rm -rf" }), JSON.stringify({ key: 7 }), JSON.stringify([])]) {
      expect((await ctx.api("/api/engines/reset", "POST", body)).status).toBe(400);
    }
    // Ausnahme gelesen, dann die Datei kaputt: nichts überschrieben
    const engines = port();
    const ctx2 = await server({ engines, noReset: true });
    expect(engines.overrides()).toEqual({ [DM_KEY]: "codex" });
    await writeFile(file, "{ kaputt");
    res = await ctx2.api("/api/engines/reset", "POST", { key: DM_KEY });
    expect(res.status).toBe(409);
    expect(await readFile(file, "utf-8")).toBe("{ kaputt");
  });

  test("gleichzeitig mit /motor: kein Eintrag geht verloren", async () => {
    await writeFile(file, JSON.stringify({ engine: { topics: { [GONE_KEY]: "codex" } } }));
    const ctx = await server();
    await Promise.all([ctx.api("/api/engines/reset", "POST", { key: GONE_KEY }), setTopicEngine(DM_KEY, "codex"), setTopicEngine(TOPIC_KEY, "claude")]);
    expect(await readJson()).toEqual({ engine: { topics: { [DM_KEY]: "codex", [TOPIC_KEY]: "claude" } } });
  });
});

describe("Web-Direktchat ohne Telegram: Schlüssel dm:web (Issue #227)", () => {
  const WEB_DM_KEY = "dm:web";
  const webPort = () => createBotEngines({ ...runtime, userId: "web", groupId: () => null, agentForTopic: () => "general", inspect });
  const webOnly: TelegramSource = {
    listConversations: async () => ({ dm: conv("dm", "Direktchat"), topics: [] }),
    groupChatId: () => null,
    getConversation: async () => null,
    history: async () => null,
  };

  test("Motor setzen, Einstellung neu laden, in der Übersicht dem Direktchat zugeordnet, Auf Standard entfernt ihn", async () => {
    const engines = webPort();
    expect(engines.sessionKey("dm")).toBe(WEB_DM_KEY);
    await setTopicEngine(WEB_DM_KEY, "codex");
    expect(await readJson()).toEqual({ engine: { topics: { [WEB_DM_KEY]: "codex" } } });
    // Neu laden: dieselbe Datei frisch eingelesen, der Schlüssel wird nicht verworfen
    setSettingsPath();
    setSettingsPath(file);
    expect(getSettings().engine?.topics).toEqual({ [WEB_DM_KEY]: "codex" });

    const ctx = await server({ engines, telegram: webOnly });
    const body = await (await ctx.api("/api/engines")).json();
    expect(body.overrides).toEqual([{ key: WEB_DM_KEY, engine: "codex", label: "Codex", conversationId: "dm", title: "Direktchat" }]);

    const res = await ctx.api("/api/engines/reset", "POST", { key: WEB_DM_KEY });
    expect(res.status).toBe(200);
    expect(ctx.calls).toEqual([{ id: "dm" }]);
    expect(await readJson()).toEqual({});
  });
});

describe("Live: SSE-Ereignis engine im Sammelstrom", () => {
  async function listen(ctx: { origin: string; cookie: string }) {
    const controller = new AbortController();
    const res = await fetch(`${ctx.origin}/api/telegram/events`, { headers: { cookie: ctx.cookie, origin: ctx.origin }, signal: controller.signal });
    expect(res.status).toBe(200);
    const events: { event: string; data: any }[] = [];
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let connected = false;
    void (async () => {
      for (;;) {
        const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
        if (done) break;
        connected = true;
        buffer += decoder.decode(value);
        let i: number;
        while ((i = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const event = /^event: (.+)$/m.exec(chunk)?.[1];
          const data = /^data: (.+)$/m.exec(chunk)?.[1];
          if (event && data) events.push({ event, data: JSON.parse(data) });
        }
      }
    })();
    cleanups.push(() => controller.abort());
    await waitUntil(() => connected);
    return events;
  }

  for (const via of ["PATCH", "Datei"] as const) test(`${via}: Agentenmotor setzt, ändert und entfernt genau ein Ereignis samt Revision und Gespräch`, async () => {
    let tick!: () => void;
    let calls = 0;
    const engines = createBotEngines({ ...runtime, userId: USER, groupId: () => GROUP, agentForTopic: () => "research",
      inspect: async engine => ({ engine, checked: true, installed: true, loggedIn: true }),
      setInterval: (fn, ms) => { expect(ms).toBe(ENGINE_WATCH_MS); tick = fn; return 1; }, clearInterval() {},
    });
    const ctx = await server({ engines });
    cleanups.push(engines.subscribe!(() => { calls++; }));
    const events = await listen(ctx);
    await tick();
    const view = async () => (await (await ctx.api("/api/engines")).json());
    let previous = await view();
    let mtime = 2_000;
    const change = async (entry: Record<string, unknown>) => {
      if (via === "PATCH") expect((await ctx.api("/api/settings", "PATCH", { agents: { research: entry } })).status).toBe(200);
      else {
        await writeFile(file, JSON.stringify({ ...getSettings(), agents: { research: Object.fromEntries(Object.entries(entry).filter(([, value]) => value !== null)) } }));
        mtime += 10;
        await utimes(file, mtime, mtime);
      }
    };
    for (const engine of ["codex", "api", null]) {
      await change({ engine, model: "claude-opus-5-5", effort: "high" });
      const count = calls;
      await tick();
      expect(calls).toBe(count + 1);
      await waitUntil(() => events.filter(e => e.event === "engine").length === calls);
      const after = await view();
      expect(after.revision.seq).toBeGreaterThan(previous.revision.seq);
      expect(after.agentEngines).toEqual(engine ? { research: engine } : {});
      const conversations = await (await ctx.api("/api/conversations")).json();
      expect(conversations.telegram.topics.find((c: any) => c.id === "topic-443")).toMatchObject({ engine: engine ?? "claude",
        engineStage: { engine: engine ?? "claude", role: "first" } });
      await tick();
      expect(calls).toBe(count + 1);
      expect((await view()).revision).toEqual(after.revision);
      previous = after;
    }
    for (const entry of [{ model: "claude-sonnet-5-5", effort: "high" }, { model: "claude-sonnet-5-5", effort: "low" }]) {
      const count = calls;
      await change(entry);
      await tick();
      expect(calls).toBe(count);
      expect((await view()).revision).toEqual(previous.revision);
      expect(events.filter(e => e.event === "engine")).toHaveLength(count);
    }
  });

  test("/motor aus jedem Kanal, Standard aus der Einstellungsseite und „Auf Standard\" melden engine ohne Inhalt", async () => {
    let tick: (() => void) | null = null;
    const ctx = await server({ engines: port({ interval: fn => (tick = fn) }) });
    const events = await listen(ctx);
    expect(tick).not.toBeNull();
    const engineEvents = () => events.filter(e => e.event === "engine");

    tick!();
    expect(engineEvents()).toHaveLength(0);
    // /motor codex (Telegram, Browser oder Terminal schreiben alle über setTopicEngine)
    await setTopicEngine(DM_KEY, "codex");
    tick!();
    await waitUntil(() => engineEvents().length === 1);
    expect(engineEvents()[0].data).toEqual({});
    // Standard auf der Einstellungsseite
    expect((await ctx.api("/api/settings", "PATCH", { engine: { default: "codex" } })).status).toBe(200);
    tick!();
    await waitUntil(() => engineEvents().length === 2);
    // „Auf Standard"
    await ctx.api("/api/engines/reset", "POST", { key: DM_KEY });
    tick!();
    await waitUntil(() => engineEvents().length === 3);
    // Ohne Änderung kein Ereignis
    tick!();
    await new Promise(r => setTimeout(r, 50));
    expect(engineEvents()).toHaveLength(3);
  });

  test("Messwert, Reset, Sperre und Ablauf melden engine; Messzeit und Rundungsrest bleiben still", async () => {
    await switchingSettings();
    let tick: (() => void) | undefined;
    usage = { ...usage, claude: [{ id: "weekly_all", state: "known", percent: 50.1,
      measuredAt: new Date(now - 10_000).toISOString(), resetsAt: new Date(now + 60_000).toISOString(), source: "stream" }] };
    const engines = switchingPort({ setInterval: fn => { tick = fn; return 1; }, clearInterval() {} });
    const ctx = await server({ engines });
    const events = await listen(ctx);
    const count = () => events.filter(event => event.event === "engine").length;
    await tick!();
    expect(count()).toBe(0);
    usage = { ...usage, claude: usage.claude.map(window => ({ ...window, measuredAt: new Date(now - 5000).toISOString(), percent: 50.4 })) };
    await tick!();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(count()).toBe(0);
    usage = { ...usage, claude: usage.claude.map(window => ({ ...window, percent: 50.6 })) };
    await tick!();
    await waitUntil(() => count() === 1);
    usage = { ...usage, claude: usage.claude.map(window => ({ ...window, resetsAt: new Date(now + 120_000).toISOString() })) };
    await tick!();
    await waitUntil(() => count() === 2);
    switchState = { ...switchState, blocks: [block("threshold", { until: new Date(now + 1000).toISOString() })] };
    await tick!();
    await waitUntil(() => count() === 3);
    expect((await (await ctx.api("/api/engines")).json()).order[1].state).toBe("answering");
    now += 1000;
    await tick!();
    await waitUntil(() => count() === 4);
    let body = await (await ctx.api("/api/engines")).json();
    expect(body.order[0].state).toBe("answering");
    expect(body.blocks).toEqual([]);
    // Nur die Auswertungsuhr läuft vor, nicht die Messzeit.
    now += 120_000;
    await tick!();
    await waitUntil(() => count() === 5);
    body = await (await ctx.api("/api/engines")).json();
    expect(body.usage.claude[0].state).toBe("expired");
    expect(body.usage.claude[0]).not.toHaveProperty("percent");
    await tick!();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(count()).toBe(5);
  });

  test("Bereitschaft allein meldet kein Ereignis; GET zeigt ihren aktuellen Stand", async () => {
    let ready = true;
    let tick: (() => void) | undefined;
    const engines = switchingPort({ inspect: async id => ({ ...await allReady(id), loggedIn: ready }),
      setInterval: fn => { tick = fn; return 1; }, clearInterval() {} });
    const ctx = await server({ engines });
    const events = await listen(ctx);
    await tick!();
    ready = false;
    await tick!();
    expect((await (await ctx.api("/api/engines")).json()).order[0].state).toBe("not_ready");
    expect(events.filter(event => event.event === "engine")).toEqual([]);
  });

  test("createBotEngines: Abgleich nur mit Zuhörern, Abmelden stoppt ihn", async () => {
    let started = 0;
    let stopped = 0;
    const engines = createBotEngines({ ...runtime,
      userId: USER,
      groupId: () => GROUP,
      agentForTopic: () => "general",
      inspect,
      setInterval: () => {
        started++;
        return 7;
      },
      clearInterval: h => {
        expect(h).toBe(7);
        stopped++;
      },
    });
    const off1 = engines.subscribe!(() => {});
    const off2 = engines.subscribe!(() => {});
    expect(started).toBe(1);
    await waitUntil(() => stateWrites === 1);
    off1();
    expect(stopped).toBe(0);
    off2();
    expect(stopped).toBe(1);
  });
});

describe("Verdrahtung (nur als Text bzw. mit Attrappen)", () => {
  const repo = join(import.meta.dir, "..");

  test("startWebUi reicht engines an createServer weiter", async () => {
    const { startWebUi } = await import("../src/web/startup");
    const engines = port();
    let received: any = null;
    await startWebUi({
      env: { WEB_ENABLED: "true", WEB_PASSWORD: "test-passwort-lang" },
      chat: { runTurn: async () => ({ text: "" }), stop() {} },
      engines,
      createServer: async (_config, deps) => {
        received = deps;
        return { url: "http://127.0.0.1:3100", eventStreamCount: () => 0, stop: async () => {} } as unknown as WebServer;
      },
      log: () => {},
      lanAddresses: () => [],
    });
    expect(received.engines).toBe(engines);
  });

  // Übergabe an startWebUi: Verhalten in tests/app-bot-web.test.ts (Issue #344)

  test("web:dev und Demo nutzen die Motor-Attrappe, nie bot-engines oder die echte Prüfung", async () => {
    const dev = await Bun.file(join(repo, "scripts", "web-dev.ts")).text();
    expect(dev).toContain("engines: createDemoEngines(demoAgents.settings),");
    const demo = await Bun.file(join(repo, "src", "web", "demo.ts")).text();
    for (const src of [dev, demo]) {
      const imports = [...src.matchAll(/^import[^;]*from\s+"([^"]+)"/gm)].map(m => m[1]);
      for (const path of imports) expect(/bot-engines|lib\/engines/.test(path)).toBe(false);
    }
  });
});

describe("Abgleich der Automatik (M14-05)", () => {
  async function prepare() {
    await writeFile(file, JSON.stringify({ engine: { backups: [{ engine: "codex" }], auto: { threshold: 60 } } }));
    const since = new Date(now - 1000).toISOString();
    const until = new Date(now + 60_000).toISOString();
    switchState = { ...switchState, auto: engineAuto(), blocks: [
      { engine: "claude", cause: "threshold", window: "weekly_all", resetKnown: true, since, until, percent: 70 },
      { engine: "codex", cause: "limit", resetKnown: false, since, until },
      { engine: "opencode", cause: "outage", resetKnown: false, since, until },
    ] };
    usage = { ...usage, claude: [{ id: "weekly_all", state: "known", percent: 70, measuredAt: since, resetsAt: until, source: "extern" }] };
  }

  test("PATCH aus löst nur threshold; Einschalten sperrt erst bei nächster Messbewertung", async () => {
    await prepare();
    const ctx = await server();
    expect((await ctx.api("/api/settings", "PATCH", { engine: { auto: { enabled: false } } })).status).toBe(200);
    expect(switchState.blocks.map(block => block.cause)).toEqual(["limit", "outage"]);
    expect((await ctx.api("/api/settings", "PATCH", { engine: { auto: { enabled: true } } })).status).toBe(200);
    expect(switchState.blocks.map(block => block.cause)).toEqual(["limit", "outage"]);
    expect(applyMeasurement(switchState, usage, now, engineAuto()).blocks.some(block => block.cause === "threshold")).toBe(true);
  });

  test("PATCH der Schwelle oder nur der Rückkehrschwelle bewertet die letzte Messung sofort", async () => {
    for (const auto of [{ threshold: 95 }, { returnBelow: 75, threshold: 90 }]) {
      await prepare();
      const ctx = await server();
      expect((await ctx.api("/api/settings", "PATCH", { engine: { auto } })).status).toBe(200);
      expect(switchState.blocks.map(block => block.cause)).toEqual(["limit", "outage"]);
    }
    await prepare();
    await writeFile(file, JSON.stringify({ engine: { backups: [{ engine: "codex" }], auto: { threshold: 90, returnBelow: 65 } } }));
    switchState = { ...switchState, auto: engineAuto() };
    const ctx = await server();
    expect((await ctx.api("/api/settings", "PATCH", { engine: { auto: { returnBelow: 75 } } })).status).toBe(200);
    expect(switchState.blocks.map(block => block.cause)).toEqual(["limit", "outage"]);
  });

  test("Handänderung greift beim nächsten Abgleich; Erstlauf schreibt einmal, gleiche Werte nie", async () => {
    let tick: (() => void) | undefined;
    const engines = port({ interval: fn => { tick = fn; } });
    const off = engines.subscribe!(() => {});
    cleanups.push(off);
    await tick!();
    expect(stateWrites).toBe(1);
    expect(switchState.auto).toEqual({ enabled: false, threshold: 95, returnBelow: 80 });
    await tick!();
    expect(stateWrites).toBe(1);
    await prepare();
    await writeFile(file, JSON.stringify({ engine: { backups: [{ engine: "codex" }], auto: { enabled: false, threshold: 60 } } }));
    await tick!();
    expect(stateWrites).toBe(2);
    expect(switchState.blocks.map(block => block.cause)).toEqual(["limit", "outage"]);
    await tick!();
    expect(stateWrites).toBe(2);
  });

  test("entfernte Ersatzstufe behält ihre Sperre, wenn andere Ersatzstufen bleiben", async () => {
    await prepare();
    const before = structuredClone(switchState.blocks);
    const ctx = await server();
    expect((await ctx.api("/api/settings", "PATCH", { engine: { backups: [{ engine: "opencode" }] } })).status).toBe(200);
    expect(switchState.blocks).toEqual(before);
    expect(stateWrites).toBe(0);
  });

  test("überlappende Takte teilen einen Lauf", async () => {
    let tick: (() => void) | undefined;
    let release!: () => void;
    let reads = 0;
    const engines = createBotEngines({ ...runtime, userId: USER, groupId: () => GROUP, agentForTopic: () => "general", inspect,
      readUsage: async () => { reads++; await new Promise<void>(resolve => { release = resolve; }); return usage; },
      setInterval: fn => { tick = fn; return 1; }, clearInterval() {},
    });
    cleanups.push(engines.subscribe!(() => {}));
    const first = tick!();
    const second = tick!();
    expect(reads).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(stateWrites).toBe(1);
  });
});

const allReady = async (engine: EngineId): Promise<EngineStatus> => ({ engine, checked: true, installed: true, loggedIn: true });
function switchingPort(deps: Partial<BotEnginesDeps> = {}) {
  return createBotEngines({ ...runtime, userId: USER, groupId: () => GROUP, agentForTopic: () => "general", inspect: allReady, ...deps });
}
function block(cause: SwitchBlock["cause"] = "threshold", changes: Partial<SwitchBlock> = {}): SwitchBlock {
  return { engine: "claude", cause, since: new Date(now - 5000).toISOString(), until: new Date(now + 60_000).toISOString(),
    resetKnown: cause === "threshold", ...(cause === "threshold" ? { window: "weekly_all" } : {}), ...changes } as SwitchBlock;
}
async function switchingSettings() {
  await writeFile(file, JSON.stringify({ agents: { general: { model: "claude-fable-5-2" } },
    engine: { backups: [{ engine: "codex" }, { engine: "opencode" }] } }));
  switchState = { ...switchState, auto: engineAuto() };
}

describe("Reihenfolge, Stand und Sperren (M14-05)", () => {
  test.each([
    ["alles frei", undefined, true, ["answering", "free", "free"]],
    ["Schwelle", "threshold", true, ["blocked", "answering", "free"]],
    ["Limit-Pause", "limit", true, ["blocked", "answering", "free"]],
    ["Ausfall", "outage", true, ["blocked", "answering", "free"]],
    ["nicht bereit", undefined, false, ["not_ready", "answering", "free"]],
    ["Bereitschaft vor Sperre", "threshold", false, ["not_ready", "answering", "free"]],
  ] as const)("order: %s, identisch mit pickStage", async (_name, cause, ready, states) => {
    await switchingSettings();
    if (cause) switchState = { ...switchState, blocks: [block(cause)] };
    const inspect = async (id: EngineId) => ({ ...await allReady(id), loggedIn: id === "claude" ? ready : true });
    const ctx = await server({ engines: switchingPort({ inspect }) });
    const body = await (await ctx.api("/api/engines")).json();
    expect(body.order.map((entry: any) => entry.state)).toEqual(states);
    expect(body.order[0]).toMatchObject({ id: "claude", engine: "claude", label: "Claude Code", model: "claude-fable-5-2" });
    expect(body.order.filter((entry: any) => entry.state === "answering")).toHaveLength(1);
    const picked = pickStage(generalOrder(), () => "claude-fable-5-2", switchState,
      { claude: { ready }, codex: { ready: true }, opencode: { ready: true }, api: { ready: true } }, now);
    expect(picked.kind).toBe("stage");
    if (picked.kind === "stage") expect(body.order.find((entry: any) => entry.state === "answering").id).toBe(stageId(picked.stage));
    for (const entry of body.order) {
      if (entry.state === "blocked") {
        expect(entry).toMatchObject({ blockedUntil: switchState.blocks[0].until, cause, resetKnown: cause === "threshold" });
        if (cause === "threshold") expect(entry.window).toBe("weekly_all");
        else expect(entry).not.toHaveProperty("window");
      } else for (const field of ["blockedUntil", "cause", "window", "resetKnown"]) expect(entry).not.toHaveProperty(field);
    }
  });

  test("keine freie Stufe: niemand antwortet; auch hinter der antwortenden zählen Sperre und Bereitschaft", async () => {
    await switchingSettings();
    switchState = { ...switchState, blocks: [block(), block("limit", { engine: "codex" })] };
    const ctx = await server({ engines: switchingPort({ inspect: async id => {
      if (id === "opencode") throw new Error("Prüfbefehl fehlgeschlagen");
      return allReady(id);
    } }) });
    let body = await (await ctx.api("/api/engines")).json();
    expect(body.order.map((entry: any) => entry.state)).toEqual(["blocked", "blocked", "not_ready"]);
    switchState = { ...switchState, blocks: switchState.blocks.slice(1) };
    body = await (await ctx.api("/api/engines")).json();
    expect(body.order.map((entry: any) => entry.state)).toEqual(["answering", "blocked", "not_ready"]);
  });

  test("Teil-Limit des allgemeinen Agenten trifft Fable, eine Claude-Stufe mit Opus antwortet", async () => {
    await switchingSettings();
    await writeFile(file, JSON.stringify({ agents: { general: { model: "claude-fable-5-2" } },
      engine: { backups: [{ engine: "claude", model: "claude-opus-5-5" }, { engine: "codex" }] } }));
    switchState = { ...switchState, blocks: [block("threshold", { window: "weekly_scoped:fable" })] };
    const ctx = await server({ engines: switchingPort() });
    const body = await (await ctx.api("/api/engines")).json();
    expect(body.order.map((entry: any) => entry.state)).toEqual(["blocked", "answering", "free"]);
    expect(body.order[1]).toMatchObject({ id: "claude:claude-opus-5-5", model: "claude-opus-5-5" });
  });

  test("api ist ebenfalls geprüft; Werte enthalten bekannte und abgelaufene Fenster ohne Prozentwert", async () => {
    await writeFile(file, JSON.stringify({ engine: { default: "api", backups: [{ engine: "codex" }], auto: { threshold: 90 } } }));
    const measuredAt = new Date(now - 10_000).toISOString();
    usage = { ...usage, claude: [
      { id: "weekly_all", state: "known", percent: 96.4, measuredAt, resetsAt: new Date(now + 60_000).toISOString(), source: "stream" },
      { id: "session", state: "expired", measuredAt, resetsAt: new Date(now - 1).toISOString(), source: "report" },
    ] };
    switchState = { ...switchState, blocks: [block(), block("limit", { engine: "codex", until: new Date(now).toISOString() })] };
    const seen: EngineId[] = [];
    const ctx = await server({ engines: switchingPort({ inspect: async id => { seen.push(id); return allReady(id); } }) });
    const body = await (await ctx.api("/api/engines")).json();
    expect(seen.sort()).toEqual(["api", "claude", "codex", "opencode"]);
    expect(body.order.map((entry: any) => [entry.engine, entry.state])).toEqual([["api", "answering"], ["codex", "free"]]);
    expect(body.auto).toEqual({ enabled: true, threshold: 90, returnBelow: 75 });
    expect(body.usage).toEqual(usage);
    expect(body.usage.claude[1]).not.toHaveProperty("percent");
    expect(body.blocks).toEqual([switchState.blocks[0]]);
  });

  test("Revision umfasst auch Messzeit und Sperren", async () => {
    const ctx = await server({ engines: switchingPort() });
    const read = async () => (await (await ctx.api("/api/engines")).json()).revision;
    const initial = await read();
    expect(await read()).toEqual(initial);
    usage = { ...usage, claude: [{ state: "known", id: "weekly_all", percent: 50, measuredAt: new Date(now - 10_000).toISOString(), source: "stream" }] };
    const measured = await read();
    expect(measured.seq).toBeGreaterThan(initial.seq);
    usage = { ...usage, claude: usage.claude.map(window => ({ ...window, measuredAt: new Date(now - 5000).toISOString() })) };
    const newer = await read();
    expect(newer.seq).toBeGreaterThan(measured.seq);
    switchState = { ...switchState, blocks: [block()] };
    expect((await read()).seq).toBeGreaterThan(newer.seq);
  });
});

describe("POST /api/engines/check (M14-05)", () => {
  test("Ergebnis je Motor: erfolgreicher Bericht zählt auch mit Altfenster, API-Modus wird übergangen", async () => {
    for (const subscription of [true, false]) {
      let calls = 0;
      usage = { ...usage, claude: [{ state: "known", id: "weekly_scoped:opus", percent: 12,
        measuredAt: new Date(now - 5000).toISOString(), source: "extern" }] };
      const ctx = await server({ engines: switchingPort({ claudeSubscription: () => subscription,
        measurements: { claude: [{ timeoutMs: 1000, measure: async () => {
          calls++;
          usage.claude.push({ state: "known", id: "weekly_scoped:fable", percent: 7,
            measuredAt: new Date(now).toISOString(), source: "report" });
          return { status: "measured" };
        } }] },
      }) });
      const body = await (await ctx.api("/api/engines/check", "POST", {})).json();
      expect(body.notMeasured).toEqual(["codex"]);
      expect(body.measurementResults.claude).toBe(subscription ? "measured" : "not-measurable");
      expect(calls).toBe(subscription ? 1 : 0);
    }
  });
  test("Login und passende Origin sind Pflicht, falsche Methode und fehlender Port werden abgelehnt", async () => {
    let checks = 0;
    const engines = { ...switchingPort(), check: async () => { checks++; return { notMeasured: [] }; } };
    const ctx = await server({ engines });
    expect((await fetch(`${ctx.origin}/api/engines/check`, { method: "POST", headers: { origin: ctx.origin } })).status).toBe(401);
    expect((await fetch(`${ctx.origin}/api/engines/check`, { method: "POST", headers: { cookie: ctx.cookie, origin: "http://fremd.test" } })).status).toBe(403);
    expect((await ctx.api("/api/engines/check")).status).toBe(405);
    expect(checks).toBe(0);
    expect((await ctx.api("/api/engines/check", "POST", {})).status).toBe(200);
    expect(checks).toBe(1);
    const bare = await topicServer(root, servers, null, {});
    expect((await bare.api("/api/engines/check", "POST", {})).status).toBe(503);
  });

  test.each([
    ["threshold", 79], ["threshold", 80], ["threshold", 85], ["limit", 79], ["limit", 80], ["limit", 85],
  ] as const)("%s: frisch gemessene %i Prozent gegen Rückkehrschwelle 80", async (cause, percent) => {
    await switchingSettings();
    switchState = { ...switchState, blocks: [block(cause, { window: "weekly_all", resetKnown: true })] };
    const ctx = await server({ engines: switchingPort({ measurements: { claude: [{ timeoutMs: 100, measure: async () => {
      usage = { ...usage, claude: [{ state: "known", id: "weekly_all", percent, measuredAt: new Date(now).toISOString(), resetsAt: new Date(now + 60_000).toISOString(), source: "report" }] };
    } }] } }) });
    const response = await ctx.api("/api/engines/check", "POST", {});
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.blocks).toHaveLength(percent < 80 ? 0 : 1);
    expect(body.notMeasured).toEqual(["codex"]);
    expect(body.measurementResults.claude).toBe("measured");
    expect(body.order[0].state).toBe(percent < 80 ? "answering" : "blocked");
    const get = await (await ctx.api("/api/engines")).json();
    const { notMeasured, measurementResults, ...checked } = body;
    expect(checked).toEqual(get);
  });

  test("ohne Messquelle werden threshold und limit frei, Zähler bleiben und notMeasured nennt beide Motoren", async () => {
    await switchingSettings();
    const counters = [{ engine: "codex" as const, kind: "limit" as const, scope: "codex", count: 2, lastAt: new Date(now - 5000).toISOString() }];
    switchState = { ...switchState, counters, blocks: [block(), block("limit", { engine: "codex" })] };
    usage = { ...usage, claude: [{ state: "known", id: "weekly_all", percent: 96, measuredAt: new Date(now - 5000).toISOString(), resetsAt: new Date(now + 60_000).toISOString(), source: "stream" }] };
    const ctx = await server({ engines: switchingPort() });
    const body = await (await ctx.api("/api/engines/check", "POST", {})).json();
    expect(body.notMeasured).toEqual(["claude", "codex"]);
    expect(body.blocks).toEqual([]);
    expect(body.order[0].state).toBe("answering");
    expect(switchState.counters).toEqual(counters);
    expect(applyMeasurement(switchState, usage, now, engineAuto()).blocks).toEqual([]);
  });

  test.each([true, false, "throw"])("outage wird frisch geprüft, bereit = %s", async ready => {
    await switchingSettings();
    switchState = { ...switchState, blocks: [block("outage")] };
    const calls: string[] = [];
    const ctx = await server({ engines: switchingPort({
      forgetCheck: id => { calls.push(`forget:${id}`); },
      inspect: async id => { calls.push(`check:${id}`); if (ready === "throw") throw new Error("Fehler"); return { ...await allReady(id), loggedIn: ready }; },
    }) });
    const body = await (await ctx.api("/api/engines/check", "POST", {})).json();
    expect(calls.slice(0, 2)).toEqual(["forget:claude", "check:claude"]);
    expect(body.blocks).toHaveLength(ready === true ? 0 : 1);
  });

  test("werfende und hängende Messquellen halten weder Antwort noch andere Quellen auf", async () => {
    await switchingSettings();
    switchState = { ...switchState, blocks: [block(), block("limit", { engine: "codex" })] };
    let aborted = false;
    let measured = false;
    const ctx = await server({ engines: switchingPort({ measurements: {
      claude: [{ timeoutMs: 10, measure: async signal => {
        signal.addEventListener("abort", () => { aborted = true; });
        await new Promise<void>(() => {});
      } }],
      codex: [{ timeoutMs: 100, measure: async () => { throw new Error("Messquelle fehlgeschlagen"); } }],
      opencode: [{ timeoutMs: 100, measure: async () => { measured = true; } }],
    } }) });
    const response = await ctx.api("/api/engines/check", "POST", {});
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.notMeasured).toEqual([]);
    expect(body.measurementResults).toMatchObject({ claude: "failed", codex: "failed" });
    expect(aborted).toBe(true);
    expect(measured).toBe(true);
  });

  test("gleichzeitige POST teilen einen Durchgang, auch wenn eine Quelle langsam ist", async () => {
    await switchingSettings();
    let calls = 0;
    let release!: () => void;
    const ctx = await server({ engines: switchingPort({ measurements: { claude: [{ timeoutMs: 1000, measure: async () => {
      calls++;
      await new Promise<void>(resolve => { release = resolve; });
    } }] } }) });
    const first = ctx.api("/api/engines/check", "POST", {});
    const second = ctx.api("/api/engines/check", "POST", {});
    await waitUntil(() => calls > 0);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toBe(1);
    release();
    expect((await first).status).toBe(200);
    expect((await second).status).toBe(200);
    expect(stateWrites).toBe(1);
  });

  test("GET und Prüfen geben weder Geheimnis noch Anmeldedatenpfad aus einer Bereitschaftsmeldung weiter", async () => {
    const marker = "GEHEIM-MARKIERUNG-655";
    const ctx = await server({ engines: switchingPort({ inspect: async id => ({ ...await allReady(id), loggedIn: false,
      message: `Fehler ${marker} in /tmp/privat/.claude/credentials.json`, version: `/tmp/${marker}`,
    }) }) });
    for (const [route, method] of [["/api/engines", "GET"], ["/api/engines/check", "POST"]]) {
      const response = await ctx.api(route, method, method === "POST" ? {} : undefined);
      expect(response.status).toBe(200);
      const text = await response.text();
      expect(text).not.toContain(marker);
      expect(text).not.toContain("/tmp/privat");
      expect(text).not.toContain("credentials.json");
    }
  });
});

test("letzte Ersatzstufe entfernt: wirksam aus geht vor, limit und outage bleiben gespeichert", async () => {
  await writeFile(file, JSON.stringify({ engine: { backups: [{ engine: "codex" }], auto: { enabled: true } } }));
  switchState = { ...switchState, auto: engineAuto(), blocks: [block(), block("limit", { engine: "codex" }), block("outage", { engine: "opencode" })] };
  const ctx = await server({ engines: switchingPort() });
  expect((await ctx.api("/api/settings", "PATCH", { engine: { backups: [] } })).status).toBe(200);
  const body = await (await ctx.api("/api/engines")).json();
  expect(body.order).toHaveLength(1);
  expect(body.order[0].state).toBe("answering");
  expect(body.auto.enabled).toBe(false);
  expect(body.blocks.map((entry: any) => entry.cause)).toEqual(["limit", "outage"]);
});

test("WebUI: Ausnahme entfernen löscht auch den Motorwechsel-Hinweis", async () => {
  await setTopicEngine(DM_KEY, "codex");
  rememberSwitchHint(DM_KEY, { stage: "claude", at: new Date(now).toISOString() });
  await settleSwitchStateForTests();
  expect(readSwitchHint(DM_KEY)?.stage).toBe("claude");
  const engines = port();
  expect(await engines.removeOverride!(DM_KEY)).toBe(true);
  expect(readSwitchHint(DM_KEY)).toBeUndefined();
  await settleSwitchStateForTests();
  expect(readSwitchHint(DM_KEY)).toBeUndefined();
});
