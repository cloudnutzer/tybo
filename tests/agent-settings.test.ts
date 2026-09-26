import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getAgentConfig, resolveAgentModel, resolveAgentEffort, type AgentConfig } from "../src/agents/base";
import { AGENT_NAMES, canonicalAgentName } from "../src/agents/names";
import { MODEL_IDS } from "../src/lib/model-router";
import { setSettingsPath, getSettings, type Settings } from "../src/lib/settings";
import { finalizeClaudeSession, runJsonTurn, runStreamingTurn, type ChatTurnDeps, type TurnInfo } from "../src/lib/chat-turn";
import { sessionKeyFor } from "../src/lib/convex";
import type { ClaudeResult, ClaudeStreamOptions } from "../src/lib/claude";
import type { BotSession } from "../src/lib/session-manager";
import { isolateAgentCatalog } from "./catalog-fixture";

// Vorrang: config/settings.json (Agent, dann Standard) vor .env vor Agenten-Datei.
// Einstellungen kommen hier aus temporären Dateien oder Fakes, Claude ist gefälscht.

const savedEffort = process.env.CLAUDE_EFFORT;
let dir: string;
let file: string;
let tick = 5_000;
isolateAgentCatalog();

function putSettings(s: Settings | string) {
  writeFileSync(file, typeof s === "string" ? s : JSON.stringify(s));
  tick += 10;
  utimesSync(file, tick, tick);
}

beforeEach(() => {
  delete process.env.CLAUDE_EFFORT;
  dir = mkdtempSync(join(tmpdir(), "tybo-agent-settings-"));
  file = join(dir, "settings.json");
  setSettingsPath(file);
});

afterEach(() => {
  if (savedEffort === undefined) delete process.env.CLAUDE_EFFORT;
  else process.env.CLAUDE_EFFORT = savedEffort;
  setSettingsPath();
  rmSync(dir, { recursive: true, force: true });
});

const fileAgent = (model: string, effort?: string) => () =>
  ({ name: "Test", systemPrompt: "", model, ...(effort ? { effort } : {}) }) as AgentConfig;

describe("Agenten-Namen", () => {
  test("canonicalAgentName löst Aliasse wie getAgentConfig auf", () => {
    const aliases = [
      "researcher", "cmo", "cfo", "ceo", "devils-advocate", "dev", "development",
      "ops", "operations", "orchestrator", "CFO", "Research",
    ];
    for (const name of [...AGENT_NAMES, ...aliases]) {
      expect(getAgentConfig(name)).toBe(getAgentConfig(canonicalAgentName(name)));
    }
    expect(canonicalAgentName("cfo")).toBe("finance");
    expect(canonicalAgentName("unbekannt")).toBe("general");
    // Seit Issue #49: unbekannte Agenten ergeben undefined statt General
    expect(getAgentConfig("unbekannt")).toBeUndefined();
  });
});

describe("resolveAgentModel", () => {
  const deps = (settings: Settings, model = "datei-modell") => ({
    getSettings: () => settings,
    getAgentConfig: fileAgent(model),
  });

  test("Agent-Eintrag vor Standard vor Agenten-Datei", () => {
    const full: Settings = { defaults: { model: "standard" }, agents: { research: { model: "agent" } } };
    expect(resolveAgentModel("research", deps(full))).toBe("agent");
    expect(resolveAgentModel("finance", deps(full))).toBe("standard");
    expect(resolveAgentModel("finance", deps({}))).toBe("datei-modell");
    expect(resolveAgentModel("finance", { getSettings: () => ({}), getAgentConfig: () => undefined })).toBe(
      MODEL_IDS.opus
    );
  });

  test("Aliasse nutzen den Eintrag des kanonischen Agenten", () => {
    const s: Settings = { agents: { finance: { model: "finanz" } } };
    expect(resolveAgentModel("cfo", deps(s))).toBe("finanz");
    expect(resolveAgentModel("CFO", deps(s))).toBe("finanz");
  });

  test("ohne Einstellungsdatei gilt das Modell aus src/agents/<name>.ts, das Objekt bleibt unverändert", () => {
    const before = { ...getAgentConfig("research")! };
    expect(resolveAgentModel("research")).toBe(before.model);
    putSettings({ agents: { research: { model: "ueberlagert" } } });
    expect(resolveAgentModel("research")).toBe("ueberlagert");
    expect(getAgentConfig("research")).toEqual(before);
  });

  test("Dateiänderung wirkt beim nächsten Aufruf, ungültige Datei ändert nichts", () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    try {
      putSettings({ defaults: { model: "eins" } });
      expect(resolveAgentModel("general")).toBe("eins");
      putSettings({ defaults: { model: "zwei" } });
      expect(resolveAgentModel("general")).toBe("zwei");
      putSettings({ defaults: { model: "" } });
      expect(resolveAgentModel("general")).toBe("zwei");
      rmSync(file);
      expect(resolveAgentModel("general")).toBe(getAgentConfig("general")!.model);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

describe("resolveAgentEffort", () => {
  const deps = (settings: Settings, effort?: string) => ({
    getSettings: () => settings,
    getAgentConfig: fileAgent("m", effort),
  });

  test("Agent-Eintrag vor Standard vor CLAUDE_EFFORT vor Agenten-Datei", () => {
    process.env.CLAUDE_EFFORT = "medium";
    const full: Settings = { defaults: { effort: "low" }, agents: { critic: { effort: "xhigh" } } };
    expect(resolveAgentEffort("critic", deps(full, "high"))).toBe("xhigh");
    expect(resolveAgentEffort("finance", deps(full, "high"))).toBe("low");
    // Konfliktfall .env gegen Agenten-Datei: .env gewinnt
    expect(resolveAgentEffort("finance", deps({}, "high"))).toBe("medium");
    delete process.env.CLAUDE_EFFORT;
    expect(resolveAgentEffort("finance", deps({}, "high"))).toBe("high");
  });

  test("nichts gesetzt: undefined, dann entscheidet defaultEffort in claude.ts", () => {
    expect(resolveAgentEffort("finance", deps({}))).toBeUndefined();
    process.env.CLAUDE_EFFORT = "";
    expect(resolveAgentEffort("finance", deps({}))).toBeUndefined();
  });

  test("Aliasse und Dateiänderung ohne Neustart", () => {
    putSettings({ agents: { strategy: { effort: "low" } } });
    expect(resolveAgentEffort("ceo")).toBe("low");
    putSettings({ agents: { strategy: { effort: "high" } } });
    expect(resolveAgentEffort("ceo")).toBe("high");
  });
});

// ---------------------------------------------------------------------------
// Chat-Kern: Dateiwechsel zwischen zwei Turns
// ---------------------------------------------------------------------------

const CHAT = "777";
const KEY = sessionKeyFor(CHAT, null);

/** Session-Speicher mit denselben Modellregeln wie session-manager.ts, nur im Speicher. */
function fakeTurnDeps(results: ClaudeResult[]) {
  const store = new Map<string, BotSession>();
  const calls: ClaudeStreamOptions[] = [];
  const recorded: { model: string; sid: string }[] = [];
  const queue = [...results];
  const fakeCall = async (o: ClaudeStreamOptions): Promise<ClaudeResult> => {
    calls.push(o);
    const next = queue.shift();
    if (!next) throw new Error("unerwarteter Claude-Aufruf");
    return next;
  };
  const deps: Partial<ChatTurnDeps> = {
    callClaude: fakeCall,
    callClaudeStreaming: fakeCall,
    callFallbackLLMWithSource: async () => ({ text: "fallback", source: "none" }),
    buildPromptContext: async () => ({ fullPrompt: "voll", fallbackContext: "" }),
    buildResumePrompt: async () => "resume",
    isSessionModeEnabled: () => true,
    getResumableSession: async (key, agent, model) => {
      const s = store.get(`${key}|${agent}`);
      return s && s.model === model ? s : undefined;
    },
    takeExpiredSession: async (key, agent, model) => {
      const s = store.get(`${key}|${agent}`);
      if (!s || s.model === model) return undefined;
      store.delete(`${key}|${agent}`);
      return s;
    },
    recordSessionTurn: async (key, agent, model, sid) => {
      recorded.push({ model, sid });
      store.set(`${key}|${agent}`, {
        key: `${key}|${agent}`,
        agentName: agent,
        claudeSessionId: sid,
        model,
        startedAt: 1,
        lastActivity: 1,
        messageCount: 1,
      } as BotSession);
    },
    getSessionsForKey: async (key) => [...store.values()].filter((s) => s.key.startsWith(`${key}|`)),
    resetSession: async () => 1,
    shouldDistill: () => false,
    distillSession: async () => {},
    log: async () => {},
    getAgentConfig: fileAgent("datei-modell"),
    // getSettings bleibt echt: liest die temporäre Datei
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => 0,
  };
  return { deps, calls, recorded, store };
}

const ok = (text: string, sessionId: string): ClaudeResult => ({ text, sessionId, isError: false });

for (const [label, run] of [
  ["runJsonTurn", runJsonTurn],
  ["runStreamingTurn", runStreamingTurn],
] as const) {
  describe(`${label}: Einstellungen im Chat-Kern`, () => {
    test("Modellwechsel in der Datei gilt ab dem nächsten Turn, ohne altes Resume", async () => {
      const t = fakeTurnDeps([ok("a1", "sid-a"), ok("a2", "sid-a"), ok("b1", "sid-b")]);
      const infos: TurnInfo[] = [];
      const turn = () =>
        run({
          userMessage: "Frage",
          chatId: CHAT,
          agentName: "cfo",
          sink: { progress() {}, notice() {} },
          onInfo: (i) => infos.push(i),
          deps: t.deps,
        });

      putSettings({ agents: { finance: { model: "modell-a", effort: "low" } } });
      expect(await turn()).toBe("a1");
      expect(await turn()).toBe("a2");
      // zweiter Turn mit demselben Modell setzt die Session fort
      expect(t.calls[1]!.resumeSessionId).toBe("sid-a");

      putSettings({ agents: { finance: { model: "modell-b" } }, defaults: { effort: "xhigh" } });
      expect(await turn()).toBe("b1");

      const third = t.calls[2]!;
      expect(third.model).toBe("modell-b");
      expect(third.effort).toBe("xhigh");
      expect(third.resumeSessionId).toBeUndefined();
      expect(third.prompt).toBe("voll");
      expect(t.calls.map((c) => c.model)).toEqual(["modell-a", "modell-a", "modell-b"]);
      expect(t.calls[0]!.effort).toBe("low");
      expect(t.recorded.map((r) => r.model)).toEqual(["modell-a", "modell-a", "modell-b"]);
      expect(infos.map((i) => i.model)).toEqual(["modell-a", "modell-a", "modell-b"]);
    });

    test("ohne Datei: Modell der Agenten-Datei, kein effort-Flag", async () => {
      const t = fakeTurnDeps([ok("x", "sid-x")]);
      await run({ userMessage: "F", chatId: CHAT, agentName: "general", sink: { progress() {}, notice() {} }, deps: t.deps });
      expect(t.calls[0]!.model).toBe("datei-modell");
      expect(t.calls[0]!.effort).toBeUndefined();
      expect(getSettings()).toEqual({});
    });

    test("Resume-Retry nutzt dasselbe aufgelöste Modell", async () => {
      const t = fakeTurnDeps([
        ok("a", "sid-a"),
        { text: "", isError: true, sessionId: "sid-a" },
        ok("neu", "sid-neu"),
      ]);
      const turn = () =>
        run({ userMessage: "F", chatId: CHAT, agentName: "research", sink: { progress() {}, notice() {} }, deps: t.deps });
      putSettings({ defaults: { model: "modell-r" } });
      await turn();
      expect(await turn()).toBe("neu");
      expect(t.calls[1]!.resumeSessionId).toBe("sid-a");
      expect(t.calls[2]!.resumeSessionId).toBeUndefined();
      expect(t.calls.map((c) => c.model)).toEqual(["modell-r", "modell-r", "modell-r"]);
      expect(t.recorded.at(-1)).toEqual({ model: "modell-r", sid: "sid-neu" });
    });
  });
}

describe("Telegram-Button-Antwort nach Modellwechsel", () => {
  test("alte Session bleibt beim tatsächlichen Modell und wird unter B nicht fortgesetzt", async () => {
    const t = fakeTurnDeps([ok("a1", "sid-a"), ok("b1", "sid-b")]);
    const turn = () =>
      runStreamingTurn({ userMessage: "F", chatId: CHAT, agentName: "general", sink: { progress() {}, notice() {} }, deps: t.deps });

    // Session mit MODEL_IDS.opus, Claude stellt eine Frage mit Buttons
    putSettings({ defaults: { model: MODEL_IDS.opus } });
    await turn();
    expect(t.recorded).toEqual([{ model: MODEL_IDS.opus, sid: "sid-a" }]);

    // Waehrend die Button-Antwort offen ist: Einstellungen auf Modell B
    putSettings({ defaults: { model: "modell-b" } });

    // Button-Antwort wie in src/bot.ts: Session mit MODEL_IDS.opus gefunden,
    // Resume ohne Modell, finalizeClaudeSession ohne Modell
    const topicSession = await t.deps.getResumableSession!(KEY, "general", MODEL_IDS.opus);
    expect(topicSession?.claudeSessionId).toBe("sid-a");
    await finalizeClaudeSession(KEY, "general", ok("antwort", "sid-a"), undefined, undefined, t.deps);
    expect(t.recorded.at(-1)).toEqual({ model: MODEL_IDS.opus, sid: "sid-a" });
    expect(t.store.get(`${KEY}|general`)!.model).toBe(MODEL_IDS.opus);

    // Naechster normaler Turn: frische Session unter B, kein Resume von sid-a
    expect(await turn()).toBe("b1");
    const next = t.calls.at(-1)!;
    expect(next.model).toBe("modell-b");
    expect(next.resumeSessionId).toBeUndefined();
    expect(next.prompt).toBe("voll");
    expect(t.recorded.filter((r) => r.model === "modell-b")).toEqual([{ model: "modell-b", sid: "sid-b" }]);
  });
});

describe("Telegram-Button-Antwort überlappt mit neuem Turn", () => {
  test("alte Button-Antwort überschreibt die Nachfolgesession nicht und übernimmt nicht deren Modell", async () => {
    const t = fakeTurnDeps([ok("a1", "sid-a"), ok("b1", "sid-b")]);
    const turn = () =>
      runStreamingTurn({ userMessage: "F", chatId: CHAT, agentName: "general", sink: { progress() {}, notice() {} }, deps: t.deps });

    // Session sid-a unter MODEL_IDS.opus, Claude stellt eine Frage mit Buttons
    putSettings({ defaults: { model: MODEL_IDS.opus } });
    await turn();

    // Button-Antwort beginnt wie in src/bot.ts: Session sid-a gefunden, Resume läuft
    const topicSession = await t.deps.getResumableSession!(KEY, "general", MODEL_IDS.opus);
    expect(topicSession?.claudeSessionId).toBe("sid-a");

    // Währenddessen: Einstellungen auf B, ein Chat-Turn schließt als sid-b/B ab
    putSettings({ defaults: { model: "modell-b" } });
    expect(await turn()).toBe("b1");
    expect(t.store.get(`${KEY}|general`)).toMatchObject({ claudeSessionId: "sid-b", model: "modell-b" });

    // Jetzt erst wird die alte Button-Antwort finalisiert
    const before = t.recorded.length;
    await finalizeClaudeSession(KEY, "general", ok("antwort", "sid-a"), undefined, undefined, t.deps);

    // sid-b/B bleibt, sid-a wird nirgends unter B gespeichert
    expect(t.recorded.length).toBe(before);
    expect(t.store.get(`${KEY}|general`)).toMatchObject({ claudeSessionId: "sid-b", model: "modell-b" });
    expect(t.recorded).not.toContainEqual({ model: "modell-b", sid: "sid-a" });
    expect(await t.deps.getResumableSession!(KEY, "general", "modell-b")).toMatchObject({ claudeSessionId: "sid-b" });
  });
});
