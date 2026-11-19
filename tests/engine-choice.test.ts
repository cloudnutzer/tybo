import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  configuredEngine,
  agentEngineSetting,
  previewEngine,
  defaultEngineSetting,
  generalOrder,
  engineModelAndEffort,
  resolveEngine,
  resetEngineChoiceForTests,
  sessionModel,
  setTopicEngine,
  unavailableNotice,
} from "../src/lib/engine-choice";
import { getSettings, setSettingsPath, SELECTABLE_ENGINES, type Settings } from "../src/lib/settings";
import type { EngineStatus } from "../src/lib/engines";
import { isolateShellEnv } from "./shell-env";
import { turnOrder, type SwitchBlock } from "../src/lib/engine-switch";
import { readSwitchState, setSwitchStateFileForTests, updateSwitchState } from "../src/lib/engine-switch-state";
import { recordUsage, setUsageFileForTests } from "../src/lib/engines/usage";

// Effort steht in der Befehlszeile: ein CLAUDE_EFFORT aus der Shell darf sie nicht ändern
isolateShellEnv({ CLAUDE_EFFORT: undefined });

// Motor-Auswahl (Issue #125) mit Einstellungs-Attrappen und Prüf-Attrappe; kein echter codex-Aufruf.

const READY: EngineStatus = { engine: "codex", checked: true, installed: true, loggedIn: true };
const NOT_LOGGED_IN: EngineStatus = {
  engine: "codex",
  checked: true,
  installed: true,
  loggedIn: false,
  message: "Codex ist nicht angemeldet: im Terminal `codex login` ausführen",
};
const NOT_INSTALLED: EngineStatus = { engine: "codex", checked: true, installed: false, loggedIn: false, message: "Codex ist nicht installiert" };

function deps(settings: Settings, env: Record<string, string> = {}, status: EngineStatus = READY) {
  const logs: string[] = [];
  const checks: string[] = [];
  return {
    logs,
    checks,
    d: {
      getSettings: () => settings,
      env: () => env,
      checkEngine: async (id: string) => {
        checks.push(id);
        return status;
      },
      log: (line: string) => logs.push(line),
    },
  };
}

import { isolateAgentCatalog } from "./catalog-fixture";
isolateAgentCatalog();
beforeEach(() => resetEngineChoiceForTests());

describe("Allgemeine Reihenfolge (M14-05)", () => {
  test("Einstellung vor Umgebung vor Claude Code, danach die Ersatzstufen", () => {
    expect(generalOrder(deps({}).d)).toEqual([{ engine: "claude" }]);
    expect(generalOrder(deps({}, { TYBO_ENGINE: "codex" }).d)).toEqual([{ engine: "codex" }]);
    expect(generalOrder(deps({ engine: { default: "opencode", backups: [{ engine: "claude", model: "opus", effort: "high" }, { engine: "codex" }] } }, { TYBO_ENGINE: "codex" }).d))
      .toEqual([{ engine: "opencode" }, { engine: "claude", model: "opus", effort: "high" }, { engine: "codex" }]);
  });

  test("api als Standard vor Codex, niemals als spätere Stufe", () => {
    const order = generalOrder(deps({ engine: { default: "api", backups: [{ engine: "codex" }] } }).d);
    expect(order).toEqual([{ engine: "api" }, { engine: "codex" }]);
    for (const engine of ["claude", "codex", "opencode", "api"] as const) {
      const turns = turnOrder({ engine }, order[0], order.slice(1));
      expect(turns.slice(1).some(stage => stage.engine === "api")).toBe(false);
    }
  });

  test("Claude ohne Modell hinter Standard Claude wird verworfen; ein anderes Modell bleibt", () => {
    expect(generalOrder(deps({ engine: { backups: [{ engine: "claude" }, { engine: "claude", model: "opus" }] } }).d))
      .toEqual([{ engine: "claude" }, { engine: "claude", model: "opus" }]);
  });
});

describe("Motor je Agent: Vorrang (M14-28)", () => {
  test("alle Gesprächs- und Agentenwahlen vor jedem Standard aus Einstellung, Umgebung oder Code", async () => {
    const choices = [undefined, ...SELECTABLE_ENGINES];
    const standards = [
      { engine: "claude" as const, source: "code" },
      ...SELECTABLE_ENGINES.flatMap(engine => [{ engine, source: "settings" }, { engine, source: "env" }]),
    ];
    for (const standard of standards) for (const agent of choices) for (const topic of choices) {
      const settings: Settings = { engine: {
        ...(standard.source === "settings" ? { default: standard.engine } : {}),
        ...(topic ? { topics: { "dm:1": topic } } : {}),
      }, agents: { research: { ...(agent ? { engine: agent } : {}) } } };
      const { d } = deps(settings, standard.source !== "code" ? { TYBO_ENGINE: standard.source === "settings" ? "api" : standard.engine } : {});
      const expected = { engine: topic ?? agent ?? standard.engine, source: topic ? "topic" : agent ? "agent" : standard.source };
      expect(configuredEngine("dm:1", "research", d)).toEqual(expected);
      expect(agentEngineSetting("research", d)).toEqual({ engine: agent ?? standard.engine, source: agent ? "agent" : standard.source });
      expect(await resolveEngine("dm:1", d, { agentName: "research" })).toMatchObject({ ...expected, requested: expected.engine });
      const preview = await previewEngine("dm:1", "research", d);
      expect(preview.configured).toEqual(expected);
      expect(preview.answering?.engine).toBe(expected.engine);
      expect(preview.role).toBe(topic ? "manual" : "first");
    }
  });

  test("Aliasse und unbekannte Agenten nutzen denselben Schlüssel wie Modell und Effort", async () => {
    const { d } = deps({ agents: { finance: { engine: "codex" }, general: { engine: "opencode" } } });
    for (const name of ["cfo", "CFO", "finance"]) {
      expect(configuredEngine("dm:1", name, d)).toEqual({ engine: "codex", source: "agent" });
      expect((await previewEngine("dm:1", name, d)).answering?.engine).toBe("codex");
      expect((await resolveEngine("dm:1", d, { agentName: name })).engine).toBe("codex");
    }
    expect(configuredEngine("dm:1", "unbekannt", d)).toEqual({ engine: "opencode", source: "agent" });
  });
});

describe("Vorrangfolge", () => {
  test("ohne Einstellung und ohne TYBO_ENGINE: Claude Code, ohne Prüfung", async () => {
    const { d, checks } = deps({});
    expect(configuredEngine("dm:1", "general", d)).toEqual({ engine: "claude", source: "code" });
    expect(await resolveEngine("dm:1", d, { agentName: "general" })).toEqual({ kind: "stage", engine: "claude", requested: "claude", source: "code", stage: { engine: "claude" }, stageId: "claude", order: [{ engine: "claude" }], skipped: [] });
    expect(checks).toEqual([]);
  });

  test("TYBO_ENGINE gilt, wenn die Einstellungsdatei keinen Standard setzt", async () => {
    const { d } = deps({}, { TYBO_ENGINE: " Codex " });
    expect(defaultEngineSetting(d)).toEqual({ engine: "codex", source: "env" });
    expect((await resolveEngine("dm:1", d, { agentName: "general" })).engine).toBe("codex");
  });

  test("engine.default schlägt TYBO_ENGINE", () => {
    const { d } = deps({ engine: { default: "claude" } }, { TYBO_ENGINE: "codex" });
    expect(configuredEngine("dm:1", "general", d)).toEqual({ engine: "claude", source: "settings" });
    const { d: d2 } = deps({ engine: { default: "codex" } }, { TYBO_ENGINE: "claude" });
    expect(configuredEngine("dm:1", "general", d2)).toEqual({ engine: "codex", source: "settings" });
  });

  test("Ausnahme des Gesprächs schlägt den Standard, andere Gespräche behalten ihn", () => {
    const { d } = deps({ engine: { default: "codex", topics: { "topic:-100:5": "claude" } } });
    expect(configuredEngine("topic:-100:5", "general", d)).toEqual({ engine: "claude", source: "topic" });
    expect(configuredEngine("topic:-100:6", "general", d)).toEqual({ engine: "codex", source: "settings" });
    expect(configuredEngine("dm:9", "general", d).engine).toBe("codex");
    expect(configuredEngine("web:abc-1", "general", d).engine).toBe("codex");
  });

  test("unbekannter TYBO_ENGINE-Wert: Claude Code und genau eine Log-Zeile", () => {
    const { d, logs } = deps({}, { TYBO_ENGINE: "gpt" });
    expect(configuredEngine("dm:1", "general", d).engine).toBe("claude");
    expect(configuredEngine("dm:1", "general", d).engine).toBe("claude");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("TYBO_ENGINE");
  });
});

describe("Verfügbarkeit", () => {
  test("nicht angemeldetes Codex: Claude Code, genau eine Meldung, jedes Mal eine Log-Zeile", async () => {
    const { d, logs } = deps({ engine: { default: "codex" } }, {}, NOT_LOGGED_IN);
    const first = await resolveEngine("topic:-100:5", d, { agentName: "general" });
    expect(first.engine).toBe("claude");
    expect(first.requested).toBe("codex");
    expect(first.notice).toBe(
      "Codex ist nicht verfügbar, ich antworte mit Claude Code. Codex ist nicht angemeldet: im Terminal `codex login` ausführen"
    );
    const second = await resolveEngine("topic:-100:5", d, { agentName: "general" });
    expect(second.engine).toBe("claude");
    expect(second.notice).toBeUndefined();
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.includes("Codex") && l.includes("Claude Code"))).toBe(true);
  });

  test("nicht installiertes Codex: Claude Code mit Meldung", async () => {
    const { d } = deps({ engine: { default: "codex" } }, {}, NOT_INSTALLED);
    const r = await resolveEngine("dm:1", d, { agentName: "general" });
    expect(r.engine).toBe("claude");
    expect(r.notice).toStartWith("Codex ist nicht verfügbar, ich antworte mit Claude Code.");
  });

  test("die Meldung kommt je Gespräch einmal", async () => {
    const { d } = deps({ engine: { default: "codex" } }, {}, NOT_LOGGED_IN);
    expect((await resolveEngine("topic:-100:5", d, { agentName: "general" })).notice).toBeDefined();
    expect((await resolveEngine("topic:-100:6", d, { agentName: "general" })).notice).toBeDefined();
    expect((await resolveEngine("web:x-1", d, { agentName: "general" })).notice).toBeDefined();
    expect((await resolveEngine("topic:-100:5", d, { agentName: "general" })).notice).toBeUndefined();
  });

  test("wieder verfügbar setzt die Sperre zurück: der nächste Ausfall wird wieder gemeldet", async () => {
    let status = NOT_LOGGED_IN;
    const d = { ...deps({ engine: { default: "codex" } }).d, checkEngine: async () => status };
    expect((await resolveEngine("dm:1", d, { agentName: "general" })).notice).toBeDefined();
    expect((await resolveEngine("dm:1", d, { agentName: "general" })).notice).toBeUndefined();
    status = READY;
    expect(await resolveEngine("dm:1", d, { agentName: "general" })).toEqual({ kind: "stage", engine: "codex", requested: "codex", source: "settings", stage: { engine: "codex" }, stageId: "codex", order: [{ engine: "codex" }], skipped: [] });
    status = NOT_LOGGED_IN;
    expect((await resolveEngine("dm:1", d, { agentName: "general" })).notice).toBeDefined();
  });

  test("eine werfende Prüfung zählt als nicht bereit", async () => {
    const d = {
      ...deps({ engine: { default: "codex" } }).d,
      checkEngine: async () => {
        throw new Error("kaputt");
      },
    };
    const r = await resolveEngine("dm:1", d, { agentName: "general" });
    expect(r.engine).toBe("claude");
    expect(r.notice).toBe(unavailableNotice("codex"));
  });
});

describe("Modell und Effort je Motor", () => {
  const settings: Settings = {
    defaults: { model: "claude-opus-5-5", effort: "high" },
    agents: { research: { model: "claude-sonnet-5" } },
    engine: { codex: { model: "gpt-5.6-sol", effort: "max" } },
  };

  test("Claude: pro Agent wie bisher", () => {
    expect(engineModelAndEffort("claude", "research", { getSettings: () => settings })).toEqual({ model: "claude-sonnet-5", effort: "high" });
    expect(engineModelAndEffort("claude", "general", { getSettings: () => settings })).toEqual({ model: "claude-opus-5-5", effort: "high" });
  });

  test("Codex: aus engine.codex, Agenten-Modelle gelten nicht", () => {
    expect(engineModelAndEffort("codex", "research", { getSettings: () => settings })).toEqual({ model: "gpt-5.6-sol", effort: "max" });
  });

  test("Codex ohne Angaben: kein Modell und kein Effort (Codex-Konfiguration), nie ein Claude-Modell", () => {
    const r = engineModelAndEffort("codex", "research", { getSettings: () => ({ defaults: { model: "claude-opus-5-5", effort: "low" } }) });
    expect(r).toEqual({});
    expect(sessionModel(r.model)).toBe("");
  });
});

describe("setTopicEngine", () => {
  let dir: string;
  let file: string;
  let errorSpy: ReturnType<typeof spyOn>;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engine-choice-"));
    file = join(dir, "settings.json");
    setSettingsPath(file);
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    errorSpy.mockRestore();
    setSettingsPath();
    rmSync(dir, { recursive: true, force: true });
  });

  test("setzt und entfernt Ausnahmen, andere Werte bleiben", async () => {
    writeFileSync(file, JSON.stringify({ defaults: { model: "m" }, engine: { default: "codex", codex: { sandbox: "full" } } }));
    await setTopicEngine("topic:-100:5", "claude");
    await setTopicEngine("dm:7", "codex");
    expect(getSettings().engine).toEqual({ default: "codex", codex: { sandbox: "full" }, topics: { "topic:-100:5": "claude", "dm:7": "codex" } });
    await setTopicEngine("topic:-100:5", null);
    await setTopicEngine("dm:7", null);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ defaults: { model: "m" }, engine: { default: "codex", codex: { sandbox: "full" } } });
  });

  test("leere Abschnitte werden aufgeräumt", async () => {
    await setTopicEngine("dm:7", "codex");
    await setTopicEngine("dm:7", null);
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({});
  });

  test("setzen setzt die Meldungs-Sperre des Gesprächs zurück", async () => {
    const { d } = deps({ engine: { default: "codex" } }, {}, NOT_LOGGED_IN);
    expect((await resolveEngine("dm:7", d, { agentName: "general" })).notice).toBeDefined();
    expect((await resolveEngine("dm:7", d, { agentName: "general" })).notice).toBeUndefined();
    await setTopicEngine("dm:7", "codex");
    expect((await resolveEngine("dm:7", d, { agentName: "general" })).notice).toBeDefined();
  });
});

describe("Wechselregel je Turn (M14-06)", () => {
  let dir: string;
  let now: number;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engine-choice-switch-"));
    setSwitchStateFileForTests(join(dir, "switch.json"));
    setUsageFileForTests(join(dir, "usage.json"));
    now = Date.now();
  });
  afterEach(() => {
    setSwitchStateFileForTests(null);
    setUsageFileForTests(null);
    rmSync(dir, { recursive: true, force: true });
  });
  const block = (engine: "claude" | "codex" | "opencode", minutes = 10): SwitchBlock => ({
    engine, cause: "limit", since: new Date(now - 1000).toISOString(),
    until: new Date(now + minutes * 60_000).toISOString(), resetKnown: true,
  });
  const settings = (): Settings => ({
    defaults: { model: "claude-fable-5-2", effort: "high" },
    engine: { backups: [{ engine: "codex" }, { engine: "opencode" }] },
  });
  const resolve = (s = settings(), extra = {}) => resolveEngine("dm:1", { ...deps(s).d, now: () => now, ...extra }, { agentName: "general" });

  test("gesperrter Agentenmotor folgt der allgemeinen Reihe, Claude nimmt wieder Agentenmodell und Effort", async () => {
    await updateSwitchState(state => ({ ...state, blocks: [block("codex")] }));
    const settings: Settings = { agents: { research: { engine: "codex", model: "claude-opus-5-5", effort: "low" } },
      engine: { default: "claude", backups: [{ engine: "opencode" }], codex: { model: "codex-modell", effort: "high" } } };
    const d = { ...deps(settings).d, now: () => now };
    expect(await resolveEngine("dm:1", d, { agentName: "research" })).toMatchObject({ requested: "codex", source: "auto", engine: "claude", model: "claude-opus-5-5", effort: "low" });
    expect((await previewEngine("dm:1", "research", d)).answering).toMatchObject({ engine: "claude", model: "claude-opus-5-5" });
  });

  test("Standard API wird hinter gesperrtem Agentenmotor niemals Ersatz", async () => {
    await updateSwitchState(state => ({ ...state, blocks: [block("codex")] }));
    const d = { ...deps({ agents: { research: { engine: "codex" } }, engine: { default: "api", backups: [{ engine: "opencode" }] } }).d, now: () => now };
    const result = await resolveEngine("dm:1", d, { agentName: "research" });
    expect(result.engine).toBe("opencode");
    expect(result.order).toEqual([{ engine: "codex" }, { engine: "opencode" }]);
    expect((await previewEngine("dm:1", "research", d)).answering?.engine).toBe("opencode");
  });

  for (const backups of [false, true]) test(`Agentenmotor nicht bereit, Ersatzstufen=${backups}: Auflösung und Vorschau`, async () => {
    const d = { ...deps({ agents: { research: { engine: "codex" } }, engine: { default: "claude", ...(backups ? { backups: [{ engine: "opencode" as const }] } : {}) } }).d,
      now: () => now, checkEngine: async (engine: string) => ({ ...(engine === "codex" ? NOT_LOGGED_IN : READY), engine }) };
    const result = await resolveEngine("dm:1", d, { agentName: "research" });
    expect(result.engine).toBe("claude");
    const preview = await previewEngine("dm:1", "research", d);
    expect(preview.role).toBe("backup");
    expect(preview.reason?.message).toBe(NOT_LOGGED_IN.message);
    if (backups) expect(result.skipped).toMatchObject([{ reason: "not_ready", stage: { engine: "codex" } }]);
    else expect(result.notice).toContain("Codex ist nicht verfügbar, ich antworte mit Claude Code.");
  });

  test("gewählte zweite Stufe: ganze order samt übersprungener erster und späterer Stufe", async () => {
    await updateSwitchState(state => ({ ...state, blocks: [block("claude")] }));
    const s = settings();
    const result = await resolve(s);
    expect(result).toMatchObject({ kind: "stage", engine: "codex", stageId: "codex", requested: "claude", source: "auto", claudeReady: true });
    expect(result.order).toEqual(turnOrder({ engine: "claude" }, { engine: "claude" }, s.engine!.backups!));
    expect(result.skipped).toMatchObject([{ index: 0, reason: "blocked", stage: { engine: "claude" } }]);
    expect(result.reason).toContain("limit");
  });

  test("alle gesperrt: none ohne engine, früheste Freigabe und vollständige order", async () => {
    await updateSwitchState(state => ({ ...state, blocks: [block("claude", 20), block("codex", 5), block("opencode", 10)] }));
    const s = settings();
    const result = await resolve(s);
    expect(result).toMatchObject({ kind: "none", freeAt: block("codex", 5).until, claudeReady: true });
    expect("engine" in result).toBe(false);
    expect(result.order).toEqual(turnOrder({ engine: "claude" }, { engine: "claude" }, s.engine!.backups!));
    expect(result.skipped).toHaveLength(3);
  });

  test("alle nicht bereit: none ohne Freigabezeit, auch eine werfende Prüfung", async () => {
    const result = await resolve(settings(), { checkEngine: async (engine: string) => {
      if (engine === "codex") throw new Error("Prüfung fehlgeschlagen");
      return { ...NOT_INSTALLED, engine };
    } });
    expect(result).toMatchObject({ kind: "none", claudeReady: false });
    expect("engine" in result).toBe(false);
    expect("freeAt" in result).toBe(false);
    expect(result.skipped.every(s => s.reason === "not_ready")).toBe(true);
  });

  test("Standard api und /motor codex: api wird nie Ersatz", async () => {
    const result = await resolve({ engine: { default: "api", topics: { "dm:1": "codex" }, backups: [{ engine: "opencode" }] } });
    expect(result.order).toEqual([{ engine: "codex" }, { engine: "opencode" }]);
  });

  test("Claude wird zusätzlich und alle Prüfungen parallel gestartet, auch für none", async () => {
    for (const installed of [true, false]) {
      const checks: string[] = [];
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const result = resolve({ engine: { default: "codex", backups: [{ engine: "opencode" }] } }, {
        checkEngine: async (engine: string) => {
          checks.push(engine);
          if (checks.length === 3) release();
          await gate;
          return { ...READY, engine, installed };
        },
      });
      expect((await result).claudeReady).toBe(installed);
      expect(checks.sort()).toEqual(["claude", "codex", "opencode"]);
    }
  });

  test("Claude loginUnknown bleibt bereit, sicher abgemeldet oder nicht installiert nicht", async () => {
    for (const status of [
      { installed: true, loggedIn: false, loginUnknown: true },
      { installed: true, loggedIn: false },
      { installed: false, loggedIn: false, loginUnknown: true },
    ]) {
      const result = await resolve(settings(), { checkEngine: async (engine: string) => ({ ...READY, engine, ...(engine === "claude" ? status : {}) }) });
      expect(result.engine).toBe(status.installed && status.loginUnknown ? "claude" : "codex");
    }
  });

  for (const source of ["report", "session-file", "extern"] as const) {
    test(`gespeicherte Messung aus ${source} zählt beim Start`, async () => {
      await recordUsage("claude", [{ id: "weekly_all", percent: 96, measuredAt: new Date(now).toISOString(), resetsAt: block("claude").until, source }]);
      expect((await resolve()).engine).toBe("codex");
      expect(readSwitchState().blocks).toMatchObject([{ engine: "claude", cause: "threshold", window: "weekly_all" }]);
    });
  }

  test("Zustand aus update-Rückgabe entscheidet, abgelaufene Sperre wird entfernt", async () => {
    const result = await resolve(settings(), { updateSwitchState: async (mutate: any) => ({
      state: mutate({ version: 1, blocks: [{ ...block("claude"), until: new Date(now - 1).toISOString() }, block("codex")], counters: [] }), persisted: false,
    }) });
    expect(result.engine).toBe("claude");
    const blocked = await resolve(settings(), { updateSwitchState: async (mutate: any) => ({
      state: mutate({ version: 1, blocks: [block("claude")], counters: [] }), persisted: false,
    }) });
    expect(readSwitchState().blocks).toEqual([]);
    expect(blocked.engine).toBe("codex");
  });

  test("Modellfamilie des angegebenen Agenten zählt für seine Wunschstufe", async () => {
    await updateSwitchState(state => ({ ...state, blocks: [{ ...block("claude"), family: "fable" }] }));
    const s: Settings = { ...settings(), agents: { research: { model: "claude-opus-5-5" } } };
    expect((await resolve(s)).engine).toBe("codex");
    const result = await resolveEngine("dm:1", { ...deps(s).d, now: () => now }, { agentName: "research" });
    expect(result).toMatchObject({ kind: "stage", engine: "claude", model: "claude-opus-5-5" });
  });

  test("mit Ersatzstufen übernimmt der Chat-Kern den Hinweis, keine alte Doppelmeldung", async () => {
    const result = await resolve({ engine: { default: "codex", backups: [{ engine: "claude", model: "opus" }] } }, {
      checkEngine: async (engine: string) => ({ ...(engine === "codex" ? NOT_INSTALLED : READY), engine }),
    });
    expect(result.notice).toBeUndefined();
    expect(result.stage).toEqual({ engine: "claude", model: "opus" });
  });

  test("ohne Ersatzstufen: kein Zugriff auf Zustand, Messwerte oder Claude-Prüfung; order trotzdem vollständig", async () => {
    const forbidden = () => { throw new Error("Unzulässiger Zugriff"); };
    const result = await resolve({ engine: { default: "codex", topics: { "dm:1": "claude" } } }, {
      readUsage: forbidden, updateSwitchState: forbidden, checkEngine: forbidden,
    });
    expect(result.order).toEqual([{ engine: "claude" }, { engine: "codex" }]);
    expect(result).toMatchObject({ kind: "stage", engine: "claude", source: "topic" });
    expect(result.claudeReady).toBeUndefined();
  });
});

describe("Claude-Ersatzstufen: Modell und Effort", () => {
  const d = { getSettings: (): Settings => ({ defaults: { model: "claude-fable-5-2", effort: "max" } }) };
  test("eigenes Modell und Effort; ohne eigenen Effort gilt der Agent, auch max bei Opus 5.5", () => {
    const logs: string[] = [];
    expect(engineModelAndEffort("claude", "general", d, { engine: "claude", model: "claude-opus-5-5", effort: "medium" }, line => logs.push(line)))
      .toEqual({ model: "claude-opus-5-5", effort: "medium" });
    expect(engineModelAndEffort("claude", "general", d, { engine: "claude", model: "claude-opus-5-5[1m]" }, line => logs.push(line)))
      .toEqual({ model: "claude-opus-5-5[1m]", effort: "max" });
    expect(logs).toEqual([]);
  });
  test("unbestätigter hoher Effort fällt auf high, mit genau einer Logzeile", () => {
    for (const model of ["claude-opus-4-6", "claude-sonnet-4-6", "claude-unbekannt"]) {
      const logs: string[] = [];
      expect(engineModelAndEffort("claude", "general", d, { engine: "claude", model, effort: "xhigh" }, line => logs.push(line)))
        .toEqual({ model, effort: "high" });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain("verwende high");
    }
  });
  test("Codex und OpenCode nutzen weiterhin die Motorwerte", () => {
    expect(engineModelAndEffort("codex", "general", d, { engine: "codex", model: "falsch", effort: "low" })).toEqual({});
    expect(engineModelAndEffort("opencode", "general", d, { engine: "opencode", model: "falsch", effort: "low" })).toEqual({});
  });
});
