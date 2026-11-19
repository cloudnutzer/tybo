/**
 * Issue #347: Verfügbarkeit und Auswahl des Motors "api". Schlüssel kommt
 * aus der Attrappe (setApiRuntimeForTests), kein Netz, kein Prozess.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DEFAULT_CLAUDE_MODEL } from "../src/lib/default-model";
import { createEngineCommandServices, engineLabel, engineModelAndEffort, isSelectableEngine, modelFitsEngine } from "../src/lib/engine-choice";
import { checkEngine, inspectEngine } from "../src/lib/engines";
import { API_KEY_MISSING, setApiRuntimeForTests } from "../src/lib/engines/api";
import { settingsSchema, type Settings } from "../src/lib/settings";
import { isolateShellEnv } from "./shell-env";

// Effort kommt sonst aus CLAUDE_EFFORT der Shell
isolateShellEnv({ CLAUDE_EFFORT: undefined });

let key: string | undefined;
beforeEach(() => {
  key = "sk-test-attrappe";
  setApiRuntimeForTests({ apiKey: () => key, fetch: async () => { throw new Error("kein Abruf in diesem Test"); } });
});
afterEach(() => setApiRuntimeForTests(null));

describe("checkEngine(api)", () => {
  test("mit Schlüssel bereit, ohne Abruf", async () => {
    expect(await checkEngine("api")).toEqual({ engine: "api", checked: true, installed: true, loggedIn: true });
    expect(await inspectEngine("api")).toEqual({ engine: "api", checked: true, installed: true, loggedIn: true });
  });

  test("ohne oder mit leerem Schlüssel nicht bereit, mit Hinweis auf ANTHROPIC_API_KEY", async () => {
    for (const k of [undefined, "", "   "]) {
      key = k;
      expect(await checkEngine("api")).toEqual({ engine: "api", checked: true, installed: true, loggedIn: false, message: API_KEY_MISSING });
    }
  });
});

describe("Auswahl", () => {
  test("wählbar in Einstellungen und /motor, mit Anzeigename", () => {
    expect(isSelectableEngine("api")).toBe(true);
    expect(engineLabel("api")).toBe("Anthropic API");
    expect(settingsSchema.safeParse({ engine: { default: "api", topics: { "dm:4711": "api" } } }).success).toBe(true);
  });

  test("/motor listet api mit Bereitschaft", async () => {
    const services = createEngineCommandServices({
      // Nur die API-Bereitschaft ist Gegenstand dieser Probe; keine echten CLI-Prüfungen.
      checkEngine: id => id === "api" ? checkEngine(id) : Promise.resolve({ engine: id, checked: true, installed: false, loggedIn: false }),
      getSettings: () => ({}), env: () => ({}),
    });
    let list = await services.available();
    expect(list.find((e) => e.engine === "api")).toEqual({ engine: "api", label: "Anthropic API", ready: true });
    key = undefined;
    list = await services.available();
    expect(list.find((e) => e.engine === "api")).toEqual({ engine: "api", label: "Anthropic API", ready: false, message: API_KEY_MISSING });
  });

  test("Modell und Effort: vom Agenten, Kurzformen werden zum Standardmodell, unbekannter Effort fällt weg", () => {
    const deps = (s: Settings, agent: { model?: string; effort?: string } = {}) => ({
      getSettings: () => s,
      getAgentConfig: () => agent as any,
    });
    expect(engineModelAndEffort("api", "general", deps({ defaults: { model: "claude-sonnet-5-5", effort: "low" } }))).toEqual({ model: "claude-sonnet-5-5", effort: "low" });
    expect(engineModelAndEffort("api", "general", deps({}, { model: "sonnet", effort: "xhigh" }))).toEqual({ model: DEFAULT_CLAUDE_MODEL, effort: "xhigh" });
    expect(engineModelAndEffort("api", "general", deps({}, { model: "claude-opus-5-5[1m]", effort: "turbo" }))).toEqual({ model: DEFAULT_CLAUDE_MODEL });
  });

  test("modelFitsEngine: nur volle claude-Namen passen zur API", () => {
    expect(modelFitsEngine("api", "claude-sonnet-5-5")).toBe(true);
    expect(modelFitsEngine("api", "sonnet")).toBe(false);
    expect(modelFitsEngine("api", "claude-opus-5-5[1m]")).toBe(false);
    expect(modelFitsEngine("api", "gpt-5.6-sol")).toBe(false);
    expect(modelFitsEngine("api", "openrouter/anthropic/claude-opus-5.5")).toBe(false);
  });
});
