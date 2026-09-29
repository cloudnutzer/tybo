/**
 * OpenCode wählbar (Issue #129): Modell, Variante und Rechte aus
 * engine.opencode gehen über engineModelAndEffort bis in die Kommandozeile
 * des OpenCode-Motors. Leeres Modell heißt kein --model (Standard der
 * OpenCode-Konfiguration); Varianten prüfen Schema und Motor gleich.
 * Prozessstart ist eine Attrappe (tests/opencode-fixture.ts), die
 * Einstellungsdatei liegt in einem Temp-Verzeichnis.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { engineModelAndEffort } from "../src/lib/engine-choice";
import { createOpenCodeEngine, opencodeArgs, resetOpenCodePermissionLogForTests } from "../src/lib/engines/opencode";
import { getSettings, OPENCODE_VARIANT_PATTERN, setSettingsPath, settingsSchema } from "../src/lib/settings";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { installOpenCodeFake, oc, type OpenCodeFake } from "./opencode-fixture";

const CWD = "/tmp/tybo-projekt";
const S = "ses_9e3f4a5b6c7dZxCvBn";

let dir: string;
let settingsFile: string;
let fake: OpenCodeFake;
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

let stamp = 0;
function writeSettingsFile(content: unknown): void {
  writeFileSync(settingsFile, JSON.stringify(content));
  stamp++;
  const t = new Date(Date.now() + stamp * 1000);
  utimesSync(settingsFile, t, t);
}

beforeAll(() => setMcpReaderForTests(() => new Set()));
afterAll(() => {
  setMcpReaderForTests(null);
  setSettingsPath();
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-opencode-wahl-"));
  settingsFile = join(dir, "settings.json");
  setSettingsPath(settingsFile);
  resetOpenCodePermissionLogForTests();
  fake = installOpenCodeFake();
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  fake.restore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

/** Ein Lauf mit Modell und Effort, wie der Chat-Kern sie für OpenCode auflöst */
async function runAsChatTurn(): Promise<string[]> {
  const chosen = engineModelAndEffort("opencode", "general", { getSettings });
  fake.next({ events: oc.reply(S, "ok") });
  const r = await createOpenCodeEngine().run({ prompt: "Hallo", streaming: false, timeoutMs: 60_000, cwd: CWD, ...chosen });
  expect(r).toMatchObject({ engine: "opencode", isError: false });
  return fake.runCommand();
}

describe("engine.opencode bis zum Prozess", () => {
  test("Modell, Variante und Rechte aus den Einstellungen", async () => {
    writeSettingsFile({ engine: { default: "opencode", opencode: { model: "openrouter/anthropic/claude-opus-5.5", variant: "high", permission: "ask-deny" } } });
    expect(engineModelAndEffort("opencode", "general", { getSettings })).toEqual({ model: "openrouter/anthropic/claude-opus-5.5", effort: "high" });
    expect(await runAsChatTurn()).toEqual([
      "opencode", "run", "--format", "json", "--model", "openrouter/anthropic/claude-opus-5.5", "--variant=high", "--dir", CWD,
    ]);
  });

  test("leeres Modell: kein --model, OpenCode nimmt seine Konfiguration; Rechte Standard --auto", async () => {
    writeSettingsFile({ engine: { default: "opencode", opencode: { variant: "thinking-8k" } } });
    expect(engineModelAndEffort("opencode", "general", { getSettings })).toEqual({ effort: "thinking-8k" });
    const cmd = await runAsChatTurn();
    expect(cmd).not.toContain("--model");
    expect(cmd).toEqual(["opencode", "run", "--format", "json", "--variant=thinking-8k", "--auto", "--dir", CWD]);
  });

  test("ohne Abschnitt: weder Modell noch Variante, nie das Claude-Modell des Agenten", async () => {
    writeSettingsFile({ defaults: { model: "claude-opus-5-5", effort: "low" }, engine: { default: "opencode" } });
    expect(engineModelAndEffort("opencode", "general", { getSettings })).toEqual({});
    expect(await runAsChatTurn()).toEqual(["opencode", "run", "--format", "json", "--auto", "--dir", CWD]);
  });

  test("Codex-Angaben gelten nie für OpenCode", () => {
    writeSettingsFile({ engine: { codex: { model: "gpt-5.6-sol", effort: "max" } } });
    expect(engineModelAndEffort("opencode", "general", { getSettings })).toEqual({});
  });
});

describe("Variante: Schema und Motor prüfen gleich", () => {
  // Wie im Issue: [a-z0-9-]{1,20}, also auch mit Bindestrich vorn und an beiden Längengrenzen
  const good = ["x", "0", "-", "-x", "--auto", "--", "-a-b", "low", "max", "thinking-8k", "a-b-c", "a".repeat(20), "-".repeat(20)];
  const bad = ["High", "a b", "a_b", "a".repeat(21), "-".repeat(21), "hoch;rm", "ä", "-x=1", "--dir/x"];

  test("gültige Varianten gehen durch Schema und Kommandozeile", () => {
    for (const variant of good) {
      expect(OPENCODE_VARIANT_PATTERN.test(variant)).toBe(true);
      expect(settingsSchema.safeParse({ engine: { opencode: { variant } } }).success).toBe(true);
      expect(opencodeArgs({ cwd: CWD, effort: variant })).toContain(`--variant=${variant}`);
    }
  });

  test("Variante wirkt nie als eigene CLI-Option: genau ein Argument --variant=<wert>, übrige Argumente unverändert", () => {
    const base = opencodeArgs({ cwd: CWD, permission: "ask-deny" });
    for (const variant of ["-x", "--auto", "--", "-", "--session", "--dir", "-m"]) {
      const args = opencodeArgs({ cwd: CWD, effort: variant, permission: "ask-deny" });
      // Nur ein zusätzliches Argument, der Wert steht nie allein
      expect(args.length).toBe(base.length + 1);
      expect(args.filter(a => a.startsWith("--variant"))).toEqual([`--variant=${variant}`]);
      expect(args).not.toContain("--auto");
      expect(args.filter(a => a !== `--variant=${variant}`)).toEqual(base);
    }
  });

  test("Längengrenzen: 1 und 20 Zeichen gültig, 0 und 21 ungültig", () => {
    for (const variant of ["a", "-", "a".repeat(20), "-".repeat(20)]) {
      expect(settingsSchema.safeParse({ engine: { opencode: { variant } } }).success).toBe(true);
    }
    for (const variant of ["", "a".repeat(21), "-".repeat(21)]) {
      expect(settingsSchema.safeParse({ engine: { opencode: { variant } } }).success).toBe(false);
    }
    expect(() => opencodeArgs({ cwd: CWD, effort: "a".repeat(21) })).toThrow("Ungültige Effort-Stufe");
    expect(opencodeArgs({ cwd: CWD, effort: "" })).not.toContain("--variant=");
  });

  test("Chat-Turn mit --auto als Variante: Rechte ask-deny bleiben ohne --auto", async () => {
    writeSettingsFile({ engine: { default: "opencode", opencode: { variant: "--auto", permission: "ask-deny" } } });
    expect(await runAsChatTurn()).toEqual(["opencode", "run", "--format", "json", "--variant=--auto", "--dir", CWD]);
  });

  test("ungültige Varianten lehnen beide ab", () => {
    for (const variant of bad) {
      expect(settingsSchema.safeParse({ engine: { opencode: { variant } } }).success).toBe(false);
      expect(() => opencodeArgs({ cwd: CWD, effort: variant })).toThrow("Ungültige Effort-Stufe");
    }
    expect(settingsSchema.safeParse({ engine: { opencode: { variant: "" } } }).success).toBe(false);
  });

  test("Modellkennungen mit mehreren Schrägstrichen bleiben unverändert", () => {
    for (const model of ["openai/gpt-5.5", "openrouter/anthropic/claude-opus-5.5", "ollama/qwen3:8b"]) {
      expect(settingsSchema.parse({ engine: { opencode: { model } } }).engine?.opencode?.model).toBe(model);
      expect(opencodeArgs({ cwd: CWD, model })).toEqual(expect.arrayContaining(["--model", model]));
    }
    for (const model of ["-x", "--auto", "a b", " "]) {
      expect(settingsSchema.safeParse({ engine: { opencode: { model } } }).success).toBe(false);
    }
  });
});
