/** M14-18: dieselbe Wahl wie ein Turn, ohne Schreib- oder Meldewirkung. */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { previewEngine, resolveEngine, resetEngineChoiceForTests, shouldNotifyUnavailable, type EngineChoiceDeps } from "../src/lib/engine-choice";
import { readSwitchState, setSwitchStateFileForTests, updateSwitchState } from "../src/lib/engine-switch-state";
import { type SwitchBlock, type SwitchUsage } from "../src/lib/engine-switch";
import type { Settings } from "../src/lib/settings";
import type { EngineStatus } from "../src/lib/engines";

const now = Date.parse("2026-11-17T12:00:00Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
let dir: string;
let settings: Settings;
let usage: SwitchUsage;
let checks: string[];
let status: Partial<Record<string, Partial<EngineStatus>>>;
let writes: number;
let notices: number;
let logs: string[];
const block = (changes: Partial<SwitchBlock> = {}): SwitchBlock => ({ engine: "claude", cause: "threshold", window: "weekly_all", since: at(-5), until: at(60), resetKnown: true, percent: 96, ...changes }) as SwitchBlock;
const deps = (): Partial<EngineChoiceDeps> => ({
  getSettings: () => settings, env: () => ({}), now: () => now, readUsage: async () => usage,
  readSwitchState, updateSwitchState: async mutate => { writes++; return updateSwitchState(mutate); },
  checkSwitch: () => { notices++; }, log: line => logs.push(line),
  getAgentConfig: () => ({ model: "claude-fable-5-2", effort: "high" }) as ReturnType<EngineChoiceDeps["getAgentConfig"]>,
  checkEngine: async engine => { checks.push(engine); return { engine, checked: true, installed: true, loggedIn: true, ...status[engine] }; },
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-preview-"));
  setSwitchStateFileForTests(join(dir, "switch.json"));
  resetEngineChoiceForTests();
  settings = { engine: { backups: [{ engine: "claude", model: "claude-opus-5-5" }, { engine: "codex" }, { engine: "opencode" }], codex: { model: "gpt-6-astra" } } };
  usage = { claude: [], codex: [], opencode: [], api: [] };
  checks = []; status = {}; writes = notices = 0; logs = [];
});
afterEach(() => { setSwitchStateFileForTests(null); rmSync(dir, { recursive: true, force: true }); });

describe("Vorschau mit Ersatzstufen", () => {
  for (const scenario of ["frei", "threshold-reset", "threshold-pause", "limit-reset", "limit-pause", "outage", "not_ready", "not_ready-ohne", "loginUnknown", "abgelaufen", "Messung", "auto-aus", "manuell", "keiner"] as const) {
    test(`${scenario}: gleiche Wahl, unveränderte Datei, keine Meldung`, async () => {
      let blocks: SwitchBlock[] = [];
      if (scenario.includes("threshold")) blocks = [block({ resetKnown: scenario.endsWith("reset") })];
      if (scenario.includes("limit")) blocks = [block({ cause: "limit", resetKnown: scenario.endsWith("reset") })];
      if (scenario === "outage") blocks = [block({ cause: "outage", resetKnown: false })];
      if (scenario.startsWith("not_ready")) status.claude = { loggedIn: false, ...(scenario === "not_ready" ? { message: "Bitte anmelden" } : {}) };
      if (scenario === "loginUnknown") status.claude = { loggedIn: false, loginUnknown: true };
      if (scenario === "abgelaufen") blocks = [block({ until: at(-1) })];
      if (scenario === "Messung") usage = { ...usage, claude: [{ id: "weekly_scoped:fable", state: "known", percent: 96, measuredAt: at(-1), source: "extern" }] };
      if (scenario === "auto-aus") { blocks = [block()]; settings.engine!.auto = { enabled: false }; }
      if (scenario === "manuell") settings.engine!.topics = { "dm:668": "api" };
      if (scenario === "keiner") blocks = [block(), block({ engine: "codex", until: at(20) }), block({ engine: "opencode", window: undefined, cause: "outage", until: at(10), resetKnown: false })];
      await updateSwitchState(s => ({ ...s, blocks, auto: { enabled: true, threshold: 95, returnBelow: 80 } }));
      const before = readFileSync(join(dir, "switch.json"), "utf8");
      const result = await previewEngine("dm:668", "general", deps());
      expect(readFileSync(join(dir, "switch.json"), "utf8")).toBe(before);
      expect(writes).toBe(0); expect(notices).toBe(0); expect(logs).toEqual([]);
      expect(new Set(checks).size).toBe(checks.length);
      if (scenario.includes("reset") || scenario.includes("pause")) {
        expect(result.reason!.resetKnown).toBe(scenario.endsWith("reset"));
        expect(result.stages[0].resetKnown).toBe(scenario.endsWith("reset"));
      }
      if (scenario.startsWith("not_ready")) {
        if (scenario === "not_ready") {
          expect(result.reason!.message).toBe("Bitte anmelden"); expect(result.stages[0].message).toBe("Bitte anmelden");
        } else { expect(result.reason).not.toHaveProperty("message"); expect(result.stages[0]).not.toHaveProperty("message"); }
        expect(shouldNotifyUnavailable("dm:668", "claude")).toBe(true);
      }
      if (scenario === "keiner") { expect(result.role).toBe("none"); expect(result.earliestFree).toBe(at(10)); }
      if (scenario === "manuell") expect(result.role).toBe("manual");
      const resolved = await resolveEngine("dm:668", deps(), { agentName: "general" });
      expect(result.answering?.id ?? null).toBe(resolved.kind === "stage" ? resolved.stageId : null);
    });
  }
  test("Agentenmodell, Messfenster und fehlendes eigenes Modell bleiben erhalten", async () => {
    settings.agents = { research: { model: "claude-opus-5-5" } };
    usage = { ...usage, claude: [{ id: "weekly_all", state: "known", percent: 42, measuredAt: at(-3), resetsAt: at(60), source: "report" }] };
    const result = await previewEngine("dm:668", "research", deps());
    expect(result.stages[0]).toMatchObject({ model: "claude-opus-5-5", windows: usage.claude });
    expect(result.stages.find(s => s.engine === "opencode")).not.toHaveProperty("model");
  });
  test("positive Prüfung löscht keinen schon gemerkten Hinweis", async () => {
    expect(shouldNotifyUnavailable("dm:668", "codex")).toBe(true);
    await previewEngine("dm:668", "general", deps());
    expect(shouldNotifyUnavailable("dm:668", "codex")).toBe(false);
  });
});

describe("Vorschau ohne Ersatzstufen", () => {
  for (const engine of ["claude", "codex", "opencode", "api"] as const) for (const ready of [false, true]) {
    test(`${engine}, bereit=${ready}: alter Pfad ohne Datei und Claude-Prüfung`, async () => {
      settings = { engine: { default: engine } };
      status[engine] = { loggedIn: ready };
      const d = { ...deps(), readUsage: async (): Promise<SwitchUsage> => { throw new Error("Messdatei gelesen"); }, readSwitchState: (): ReturnType<typeof readSwitchState> => { throw new Error("Zustand gelesen"); } };
      const result = await previewEngine("dm:668", "general", d);
      expect(checks).toEqual(engine === "claude" ? [] : [engine]);
      expect(logs).toEqual([]); expect(writes).toBe(0);
      expect(result.answering!.engine).toBe(ready || engine === "claude" ? engine : "claude");
      expect(shouldNotifyUnavailable("dm:668", engine)).toBe(true);
      expect(result.answering!.engine).toBe((await resolveEngine("dm:668", d, { agentName: "general" })).engine);
    });
  }
  test("ungültige Umgebung bleibt ohne Log und verbraucht keine Warnung", async () => {
    settings = {};
    const d = { ...deps(), env: () => ({ TYBO_ENGINE: "unbekannt" }) };
    await previewEngine("dm:668", "general", d);
    expect(logs).toEqual([]);
    await resolveEngine("dm:668", d, { agentName: "general" });
    expect(logs).toHaveLength(1);
  });
});
