import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  configuredEngine,
  defaultEngineSetting,
  engineModelAndEffort,
  resolveEngine,
  resetEngineChoiceForTests,
  sessionModel,
  setTopicEngine,
  unavailableNotice,
} from "../src/lib/engine-choice";
import { getSettings, setSettingsPath, type Settings } from "../src/lib/settings";
import type { EngineStatus } from "../src/lib/engines";

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

beforeEach(() => resetEngineChoiceForTests());

describe("Vorrangfolge", () => {
  test("ohne Einstellung und ohne TYBO_ENGINE: Claude Code, ohne Prüfung", async () => {
    const { d, checks } = deps({});
    expect(configuredEngine("dm:1", d)).toEqual({ engine: "claude", source: "code" });
    expect(await resolveEngine("dm:1", d)).toEqual({ engine: "claude", requested: "claude", source: "code" });
    expect(checks).toEqual([]);
  });

  test("TYBO_ENGINE gilt, wenn die Einstellungsdatei keinen Standard setzt", async () => {
    const { d } = deps({}, { TYBO_ENGINE: " Codex " });
    expect(defaultEngineSetting(d)).toEqual({ engine: "codex", source: "env" });
    expect((await resolveEngine("dm:1", d)).engine).toBe("codex");
  });

  test("engine.default schlägt TYBO_ENGINE", () => {
    const { d } = deps({ engine: { default: "claude" } }, { TYBO_ENGINE: "codex" });
    expect(configuredEngine("dm:1", d)).toEqual({ engine: "claude", source: "settings" });
    const { d: d2 } = deps({ engine: { default: "codex" } }, { TYBO_ENGINE: "claude" });
    expect(configuredEngine("dm:1", d2)).toEqual({ engine: "codex", source: "settings" });
  });

  test("Ausnahme des Gesprächs schlägt den Standard, andere Gespräche behalten ihn", () => {
    const { d } = deps({ engine: { default: "codex", topics: { "topic:-100:5": "claude" } } });
    expect(configuredEngine("topic:-100:5", d)).toEqual({ engine: "claude", source: "topic" });
    expect(configuredEngine("topic:-100:6", d)).toEqual({ engine: "codex", source: "settings" });
    expect(configuredEngine("dm:9", d).engine).toBe("codex");
    expect(configuredEngine("web:abc-1", d).engine).toBe("codex");
  });

  test("unbekannter TYBO_ENGINE-Wert: Claude Code und genau eine Log-Zeile", () => {
    const { d, logs } = deps({}, { TYBO_ENGINE: "gpt" });
    expect(configuredEngine("dm:1", d).engine).toBe("claude");
    expect(configuredEngine("dm:1", d).engine).toBe("claude");
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("TYBO_ENGINE");
  });
});

describe("Verfügbarkeit", () => {
  test("nicht angemeldetes Codex: Claude Code, genau eine Meldung, jedes Mal eine Log-Zeile", async () => {
    const { d, logs } = deps({ engine: { default: "codex" } }, {}, NOT_LOGGED_IN);
    const first = await resolveEngine("topic:-100:5", d);
    expect(first.engine).toBe("claude");
    expect(first.requested).toBe("codex");
    expect(first.notice).toBe(
      "Codex ist nicht verfügbar, ich antworte mit Claude Code. Codex ist nicht angemeldet: im Terminal `codex login` ausführen"
    );
    const second = await resolveEngine("topic:-100:5", d);
    expect(second.engine).toBe("claude");
    expect(second.notice).toBeUndefined();
    expect(logs).toHaveLength(2);
    expect(logs.every((l) => l.includes("Codex") && l.includes("Claude Code"))).toBe(true);
  });

  test("nicht installiertes Codex: Claude Code mit Meldung", async () => {
    const { d } = deps({ engine: { default: "codex" } }, {}, NOT_INSTALLED);
    const r = await resolveEngine("dm:1", d);
    expect(r.engine).toBe("claude");
    expect(r.notice).toStartWith("Codex ist nicht verfügbar, ich antworte mit Claude Code.");
  });

  test("die Meldung kommt je Gespräch einmal", async () => {
    const { d } = deps({ engine: { default: "codex" } }, {}, NOT_LOGGED_IN);
    expect((await resolveEngine("topic:-100:5", d)).notice).toBeDefined();
    expect((await resolveEngine("topic:-100:6", d)).notice).toBeDefined();
    expect((await resolveEngine("web:x-1", d)).notice).toBeDefined();
    expect((await resolveEngine("topic:-100:5", d)).notice).toBeUndefined();
  });

  test("wieder verfügbar setzt die Sperre zurück: der nächste Ausfall wird wieder gemeldet", async () => {
    let status = NOT_LOGGED_IN;
    const d = { ...deps({ engine: { default: "codex" } }).d, checkEngine: async () => status };
    expect((await resolveEngine("dm:1", d)).notice).toBeDefined();
    expect((await resolveEngine("dm:1", d)).notice).toBeUndefined();
    status = READY;
    expect(await resolveEngine("dm:1", d)).toEqual({ engine: "codex", requested: "codex", source: "settings" });
    status = NOT_LOGGED_IN;
    expect((await resolveEngine("dm:1", d)).notice).toBeDefined();
  });

  test("eine werfende Prüfung zählt als nicht bereit", async () => {
    const d = {
      ...deps({ engine: { default: "codex" } }).d,
      checkEngine: async () => {
        throw new Error("kaputt");
      },
    };
    const r = await resolveEngine("dm:1", d);
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
    expect((await resolveEngine("dm:7", d)).notice).toBeDefined();
    expect((await resolveEngine("dm:7", d)).notice).toBeUndefined();
    await setTopicEngine("dm:7", "codex");
    expect((await resolveEngine("dm:7", d)).notice).toBeDefined();
  });
});
