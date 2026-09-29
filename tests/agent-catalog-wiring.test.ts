import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, utimesSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  BASE_CONTEXT,
  LONG_TASK_RULES,
  canInvokeAgent,
  getAgentConfig,
  getAgentConfigOrGeneral,
  resolveAgentEffort,
  resolveAgentModel,
} from "../src/agents/base";
import {
  boardAgentNames,
  createAgent,
  deleteAgent,
  isActiveAgent,
  listAgentNames,
  resetPrompt,
  restoreBuiltin,
  setAgentCatalogPaths,
  setBoard,
  setPrompt,
} from "../src/agents/catalog";
import { AGENT_NAMES } from "../src/agents/names";
import { executeVisibleInvocation, parseInvocationTags, stripInvocationTags } from "../src/lib/cross-agent";
import type { BotRegistry } from "../src/lib/bot-registry";
import { getSettings, setSettingsPath } from "../src/lib/settings";
import { runJsonTurn, type ChatTurnDeps } from "../src/lib/chat-turn";
import type { ClaudeResult, ClaudeStreamOptions } from "../src/lib/claude";
import { effectiveSettings, botSettings, validateSettings } from "../src/web/bot-settings";
import { applySettingsPatch } from "../src/web/settings";
import { createWebServer, type WebServer } from "../src/web/server";
import { agentList } from "../src/web/agents";
import { stripControlTags } from "../src/web/markdown";
import { addAgentOverride, listAllOverrides, setAgentOverridesPath } from "../src/lib/agent-overrides";
import { createClaudeEngine } from "../src/lib/engines";

// Katalog, Einstellungen und Topics nur in temporären Dateien.

let dir: string;
let settingsFile: string;
let tick = 20_000;
const savedEffort = process.env.CLAUDE_EFFORT;

function putSettings(value: unknown) {
  writeFileSync(settingsFile, JSON.stringify(value));
  tick += 10;
  utimesSync(settingsFile, tick, tick);
}

beforeEach(() => {
  delete process.env.CLAUDE_EFFORT;
  dir = mkdtempSync(join(tmpdir(), "tybo-catalog-wiring-"));
  settingsFile = join(dir, "settings.json");
  setAgentCatalogPaths({ file: join(dir, "agents.json"), backupDir: join(dir, "backups"), topicsFile: join(dir, "topics.json") });
  setSettingsPath(settingsFile);
});

afterEach(() => {
  if (savedEffort === undefined) delete process.env.CLAUDE_EFFORT;
  else process.env.CLAUDE_EFFORT = savedEffort;
  setAgentCatalogPaths();
  setSettingsPath();
  rmSync(dir, { recursive: true, force: true });
});

const planer = { name: "projekt-planer", description: "Plant Projekte in Meilensteinen", systemPrompt: "Du planst Projekte." };

describe("getAgentConfig über den Katalog", () => {
  test("ohne config/agents.json: unverändert die Dateien aus src/agents", () => {
    for (const name of AGENT_NAMES) {
      expect(getAgentConfig(name)).toBe(require(`../src/agents/${name}`).default);
    }
    expect(getAgentConfig("cfo")).toBe(getAgentConfig("finance"));
    expect(getAgentConfig("unbekannt")).toBeUndefined();
    expect(getAgentConfigOrGeneral("unbekannt")).toBe(getAgentConfig("general"));
  });

  test("geänderter Prompt gilt, Zurücksetzen stellt den Code-Prompt her", async () => {
    const code = getAgentConfig("research")!;
    await setPrompt("research", "Neuer Prompt für Research");
    const changed = getAgentConfig("researcher")!;
    // Gespeicherter Text bleibt, der Block LONG TASKS kommt dazu (Issue #180)
    expect(changed.systemPrompt).toBe(`Neuer Prompt für Research\n\n${LONG_TASK_RULES}\n`);
    expect(changed.model).toBe(code.model);
    expect(changed.name).toBe(code.name);
    await resetPrompt("research");
    expect(getAgentConfig("research")).toBe(code);
  });

  test("eigener Agent ist erreichbar: BASE_CONTEXT plus eigener Prompt, darf critic und research fragen", async () => {
    await createAgent(planer);
    const config = getAgentConfig("projekt-planer")!;
    expect(config.name).toBe("projekt-planer");
    expect(config.systemPrompt.startsWith(BASE_CONTEXT)).toBe(true);
    expect(config.systemPrompt).toContain("Du planst Projekte.");
    expect(config.systemPrompt).toContain("Available: critic, research");
    expect(config.model).toBe(getAgentConfig("general")!.model);
    // General kennt ihn als Ziel für [INVOKE:]
    const general = getAgentConfig("general")!;
    expect(general.systemPrompt).toContain("**projekt-planer** — Plant Projekte in Meilensteinen");
  });

  test("eigener Agent nutzt Modell und Effort aus config/settings.json", async () => {
    await createAgent(planer);
    putSettings({ agents: { "projekt-planer": { model: "planer-modell", effort: "low" } } });
    expect(resolveAgentModel("projekt-planer")).toBe("planer-modell");
    expect(resolveAgentEffort("projekt-planer")).toBe("low");
    putSettings({ defaults: { model: "standard-modell", effort: "medium" } });
    expect(resolveAgentModel("projekt-planer")).toBe("standard-modell");
    expect(resolveAgentEffort("projekt-planer")).toBe("medium");
    putSettings({});
    expect(resolveAgentModel("projekt-planer")).toBe(getAgentConfig("general")!.model);
  });

  test("gelöschter mitgelieferter Agent: nicht mehr gelistet, kein Config, Einstellungen dazu ignoriert", async () => {
    putSettings({ agents: { cto: { model: "cto-modell" }, general: { model: "general-modell" } } });
    expect(resolveAgentModel("cto")).toBe("cto-modell");
    await deleteAgent("cto");
    expect(listAgentNames()).not.toContain("cto");
    expect(getAgentConfig("cto")).toBeUndefined();
    expect(getAgentConfig("dev")).toBeUndefined();
    // Laufende Gespräche mit dem gelöschten Agenten antworten wie bisher bei unbekannten Namen mit General
    expect(getAgentConfigOrGeneral("cto")).toBe(getAgentConfig("general"));
    expect(resolveAgentModel("cto")).toBe("general-modell");
    await restoreBuiltin("cto");
    expect(resolveAgentModel("cto")).toBe("cto-modell");
  });
});

// ---------------------------------------------------------------------------
// Chat-Kern mit echtem Katalog und echter Einstellungsdatei, Claude gefälscht
// ---------------------------------------------------------------------------

function fakeTurn() {
  const calls: ClaudeStreamOptions[] = [];
  const fakeCall = async (o: ClaudeStreamOptions): Promise<ClaudeResult> => {
    calls.push(o);
    return { text: "antwort", sessionId: `sid-${calls.length}`, isError: false };
  };
  const deps: Partial<ChatTurnDeps> = {
    getEngine: () => createClaudeEngine({ callClaude: fakeCall, callClaudeStreaming: fakeCall }),
    callFallbackLLMWithSource: async () => ({ text: "fallback", source: "none" }),
    buildPromptContext: async () => ({ fullPrompt: "voll", fallbackContext: "" }),
    buildResumePrompt: async () => "resume",
    isSessionModeEnabled: () => false,
    getResumableSession: async () => undefined,
    takeExpiredSession: async () => undefined,
    recordSessionTurn: async () => {},
    getSessionsForKey: async () => [],
    resetSession: async () => 0,
    shouldDistill: () => false,
    distillSession: async () => {},
    log: async () => {},
    setTimer: () => 0,
    clearTimer: () => {},
    now: () => 0,
  };
  return { calls, deps };
}

describe("Chat-Turn mit eigenem Agenten", () => {
  test("Modell und Effort aus config/settings.json gehen an den Claude-Aufruf", async () => {
    await createAgent(planer);
    putSettings({ agents: { "projekt-planer": { model: "planer-modell", effort: "high" } } });
    const t = fakeTurn();
    const infos: any[] = [];
    const text = await runJsonTurn({
      userMessage: "Plane das",
      chatId: "123",
      agentName: "projekt-planer",
      sink: { progress() {}, notice() {} },
      onInfo: i => infos.push(i),
      deps: t.deps,
    });
    expect(text).toBe("antwort");
    expect(t.calls[0]!.model).toBe("planer-modell");
    expect(t.calls[0]!.effort).toBe("high");
    expect(infos[0]).toMatchObject({ agent: "projekt-planer", model: "planer-modell" });
  });
});

// ---------------------------------------------------------------------------
// Einladungen und Board
// ---------------------------------------------------------------------------

describe("[INVOKE:] mit dem Katalog", () => {
  test("Rechte: General fragt eigene, eigene fragen critic und research, gelöschte sind nie Ziel", async () => {
    // mitgelieferte unverändert
    expect(canInvokeAgent("general", "cto")).toBe(true);
    expect(canInvokeAgent("research", "critic")).toBe(true);
    expect(canInvokeAgent("critic", "research")).toBe(false);
    await createAgent(planer);
    expect(canInvokeAgent("general", "projekt-planer")).toBe(true);
    expect(canInvokeAgent("research", "projekt-planer")).toBe(false);
    expect(canInvokeAgent("projekt-planer", "critic")).toBe(true);
    expect(canInvokeAgent("projekt-planer", "research")).toBe(true);
    expect(canInvokeAgent("projekt-planer", "finance")).toBe(false);
    await deleteAgent("critic");
    expect(canInvokeAgent("general", "critic")).toBe(false);
    expect(canInvokeAgent("research", "critic")).toBe(false);
    expect(canInvokeAgent("projekt-planer", "critic")).toBe(false);
    await deleteAgent("projekt-planer");
    expect(canInvokeAgent("general", "projekt-planer")).toBe(false);
  });

  function fakeRegistry() {
    const sent: { agent: string; text: string }[] = [];
    const registry = {
      sendTypingAsAgent: async () => {},
      sendAsAgent: async (agent: string, _chat: unknown, text: string) => {
        sent.push({ agent, text });
      },
    } as unknown as BotRegistry;
    return { registry, sent };
  }

  test("vollständig: General ruft projekt-planer, Antwort kommt als dieser Agent", async () => {
    await createAgent(planer);
    const reply = "Zuerst die Meilensteine. [INVOKE:projekt-planer|Welche Meilensteine brauchen wir?]";
    const invocations = parseInvocationTags(reply);
    expect(invocations).toEqual([{ targetAgent: "projekt-planer", question: "Welche Meilensteine brauchen wir?" }]);
    expect(stripInvocationTags(reply)).toBe("Zuerst die Meilensteine.");
    expect(stripControlTags(reply)).toBe("Zuerst die Meilensteine.");

    const { registry, sent } = fakeRegistry();
    const claudeCalls: { agent: string; prompt: string }[] = [];
    const result = await executeVisibleInvocation(registry, "general", invocations[0], "-100", 7, async (prompt, _chat, agent) => {
      claudeCalls.push({ agent, prompt });
      return "M1, M2, M3 [INVOKE:critic|verschachtelt]";
    });
    expect(claudeCalls.map(c => c.agent)).toEqual(["projekt-planer"]);
    expect(claudeCalls[0].prompt).toContain("Welche Meilensteine brauchen wir?");
    expect(result).toBe("M1, M2, M3");
    expect(sent).toEqual([{ agent: "projekt-planer", text: "M1, M2, M3" }]);
  });

  test("gelöschter Agent ist kein Ziel: kein Claude-Aufruf, nichts gesendet", async () => {
    await deleteAgent("finance");
    const { registry, sent } = fakeRegistry();
    let called = false;
    const result = await executeVisibleInvocation(registry, "general", { targetAgent: "finance", question: "Zahlen?" }, "-100", undefined, async () => {
      called = true;
      return "x";
    });
    expect(result).toBeNull();
    expect(called).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("/board-Teilnehmer", () => {
  const OLD_BOARD = ["research", "content", "finance", "strategy", "cto", "coo", "critic"];

  test("ohne config/agents.json wie bisher", () => {
    expect(boardAgentNames()).toEqual(OLD_BOARD);
  });

  test("eigene nur mit Schalter, board:false schließt auch mitgelieferte aus, gelöschte fehlen", async () => {
    await createAgent(planer);
    expect(boardAgentNames()).toEqual(OLD_BOARD);
    await setBoard("projekt-planer", true);
    expect(boardAgentNames()).toEqual(["research", "content", "finance", "strategy", "cto", "coo", "projekt-planer", "critic"]);
    await setBoard("content", false);
    expect(boardAgentNames()).not.toContain("content");
    await deleteAgent("coo");
    expect(boardAgentNames()).toEqual(["research", "finance", "strategy", "cto", "projekt-planer", "critic"]);
    await createAgent({ ...planer, name: "mit-board", board: true });
    expect(boardAgentNames()).toContain("mit-board");
  });
});

// ---------------------------------------------------------------------------
// Einstellungen und WebUI sehen Katalogänderungen ohne Neustart
// ---------------------------------------------------------------------------

describe("Einstellungen mit dem Katalog", () => {
  test("Einstellungs-Port und wirksame Werte folgen dem Katalog", async () => {
    expect([...botSettings.agents]).toEqual([...AGENT_NAMES]);
    await createAgent(planer);
    expect(botSettings.agents).toContain("projekt-planer");
    expect(effectiveSettings({}).agents["projekt-planer"].model.value).toBe(getAgentConfig("general")!.model);
    await deleteAgent("strategy");
    expect(botSettings.agents).not.toContain("strategy");
    expect(effectiveSettings({}).agents.strategy).toBeUndefined();
  });

  test("Ändern: aktive Agenten erlaubt, gelöschte und unbekannte abgelehnt", async () => {
    await createAgent(planer);
    await deleteAgent("coo");
    expect(applySettingsPatch({}, { agents: { "projekt-planer": { model: "m" } } }, botSettings.agents).ok).toBe(true);
    expect(applySettingsPatch({}, { agents: { coo: { model: "m" } } }, botSettings.agents).ok).toBe(false);
    expect(applySettingsPatch({}, { agents: { gibtsnicht: { model: "m" } } }, botSettings.agents).ok).toBe(false);
  });

  test("Werte zu gelöschten Agenten sind kein Fehler; Einstellungsdatei bleibt bei Katalogänderungen unverändert", async () => {
    const content = JSON.stringify({ agents: { coo: { model: "coo-modell" }, research: { effort: "low" } } });
    writeFileSync(settingsFile, content);
    const before = getSettings();
    await deleteAgent("coo");
    await createAgent(planer);
    await setPrompt("research", "neu");
    expect(validateSettings(JSON.parse(content)).ok).toBe(true);
    expect(getSettings()).toEqual(before);
    expect(readFileSync(settingsFile, "utf-8")).toBe(content);
    // Ändern eines anderen Agenten lässt den Eintrag zum gelöschten stehen
    const patched = applySettingsPatch(getSettings() as any, { agents: { research: { model: "r" } } }, botSettings.agents);
    expect(patched.ok && (patched.value as any).agents.coo).toEqual({ model: "coo-modell" });
    expect(resolveAgentEffort("research")).toBe("low");
  });
});

describe("WebUI-Server sieht Katalogänderungen ohne Neustart", () => {
  let server: WebServer | null = null;
  afterEach(async () => {
    await server?.stop({ graceMs: 50 });
    server = null;
  });

  test("/api/agents, neues Gespräch und Anweisungen nutzen die aktuelle Liste", async () => {
    const PASSWORD = "test-passwort-123";
    const instructions: Record<string, string[]> = {};
    const created: string[] = [];
    server = await createWebServer(
      { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
      {
        sessionFile: join(dir, "web-sessions.json"),
        dataDir: join(dir, "web"),
        log: () => {},
        agents: () => agentList(listAgentNames()),
        instructions: {
          list: agent => instructions[agent] ?? [],
          add: async (agent, text) => {
            (instructions[agent] ??= []).push(text);
            return instructions[agent];
          },
          clear: async () => 0,
          removeLast: async () => undefined,
        } as any,
        topics: {
          create: async (agent: string) => {
            created.push(agent);
            return { status: 201, body: { ok: true } };
          },
        } as any,
      }
    );
    const origin = server.url;
    const login = await fetch(`${origin}/api/login`, { method: "POST", headers: { origin }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const api = (path: string, method = "GET", body?: unknown) =>
      fetch(`${origin}${path}`, {
        method,
        headers: { cookie, origin, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    const names = async () => ((await (await api("/api/agents")).json()) as any).agents.map((a: any) => a.name);

    expect(await names()).toEqual([...AGENT_NAMES]);
    expect((await api("/api/conversations", "POST", { agent: "projekt-planer" })).status).toBe(400);
    expect((await api("/api/agents/projekt-planer/instructions")).status).toBe(404);

    await createAgent(planer);
    expect(await names()).toContain("projekt-planer");
    // Ohne Forum-Gruppe ein Web-Gespräch mit dem neuen Agenten (Issue #227), kein Topic
    const res = await api("/api/conversations", "POST", { agent: "projekt-planer" });
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).conversation.agent).toBe("projekt-planer");
    expect(created).toEqual([]);
    expect((await api("/api/agents/projekt-planer/instructions")).status).toBe(200);

    await deleteAgent("finance");
    expect(await names()).not.toContain("finance");
    expect((await api("/api/conversations", "POST", { agent: "finance" })).status).toBe(400);
    expect((await api("/api/agents/finance/instructions")).status).toBe(404);
  });
});

describe("/agent-Übersicht: Aktive Anpassungen", () => {
  afterEach(() => setAgentOverridesPath());

  test("gelöschter Agent mit Zusatzanweisungen erscheint nicht mehr", async () => {
    setAgentOverridesPath(join(dir, "agent-overrides.json"));
    await createAgent(planer);
    await addAgentOverride("projekt-planer", "antworte kürzer");
    await addAgentOverride("finance", "rechne in Euro");
    expect(Object.keys(listAllOverrides(isActiveAgent)).sort()).toEqual(["finance", "projekt-planer"]);

    await deleteAgent("projekt-planer");
    await deleteAgent("finance");
    expect(listAllOverrides(isActiveAgent)).toEqual({});
    // Die Anweisungen bleiben gespeichert, nur die Übersicht blendet sie aus
    expect(Object.keys(listAllOverrides()).sort()).toEqual(["finance", "projekt-planer"]);

    await restoreBuiltin("finance");
    expect(listAllOverrides(isActiveAgent)).toEqual({ finance: ["rechne in Euro"] });
  });

  test("src/bot.ts filtert die Übersicht auf aktive Agenten (nur statisch gelesen, nie importiert)", () => {
    const source = readFileSync(join(import.meta.dir, "..", "src", "bot.ts"), "utf-8");
    // Seit Issue #74 über die Befehls-Schicht (src/lib/commands)
    expect(source).toContain("listAllOverrides: () => listAllOverrides(isActiveAgent),");
    expect(source).not.toMatch(/listAllOverrides\(\s*\)/);
  });
});
