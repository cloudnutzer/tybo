/**
 * OpenCode-Motor, Rechte und Projekt-Kontext (Issue #128): jeder Lauf, neu
 * und fortgesetzt, trägt die Rechte der Einstellung engine.opencode.permission
 * (Standard auto = `--auto`, ask-deny ohne `--auto`). Für den Projekt-Kontext
 * setzt tybo nichts: kein Argument, keine OPENCODE_DISABLE_CLAUDE_CODE*,
 * kein OPENCODE_PERMISSION. Ob OpenCode die CLAUDE.md wirklich liest, zeigt
 * die Attrappe nicht; das steht als manueller Test im Pull Request.
 * Prozessstart ist eine Attrappe (tests/opencode-fixture.ts), die
 * Einstellungsdatei liegt in einem Temp-Verzeichnis.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  createOpenCodeEngine,
  opencodeArgs,
  opencodeEnv,
  opencodePermission,
  opencodePermissionArgs,
  resetOpenCodePermissionLogForTests,
} from "../src/lib/engines/opencode";
import {
  DEFAULT_OPENCODE_PERMISSION,
  getSettings,
  OPENCODE_PERMISSION_LEVELS,
  setSettingsPath,
  settingsSchema,
  type OpenCodePermission,
} from "../src/lib/settings";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { installOpenCodeFake, oc, type OpenCodeFake } from "./opencode-fixture";

const CWD = "/tmp/tybo-projekt";
const S = "ses_8d2e3f4a5b6cAsDfGh";

let dir: string;
let settingsFile: string;
let fake: OpenCodeFake;
let logs: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;
const savedEnv: Record<string, string | undefined> = {};
const CONTEXT_VARS = ["OPENCODE_DISABLE_CLAUDE_CODE", "OPENCODE_DISABLE_CLAUDE_CODE_PROMPT", "OPENCODE_DISABLE_CLAUDE_CODE_SKILLS", "OPENCODE_PERMISSION"];

/** Einstellungsdatei schreiben; die Änderungszeit wird vorgestellt, damit getSettings neu liest */
let stamp = 0;
function writeSettingsFile(content: unknown): void {
  writeFileSync(settingsFile, typeof content === "string" ? content : JSON.stringify(content));
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
  // Die Umgebung des Testlaufs darf das Ergebnis nicht verfälschen
  for (const k of CONTEXT_VARS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), "tybo-opencode-rechte-"));
  settingsFile = join(dir, "settings.json");
  setSettingsPath(settingsFile);
  resetOpenCodePermissionLogForTests();
  fake = installOpenCodeFake();
  logs = [];
  logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  fake.restore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
  for (const k of CONTEXT_VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

const run = (extra: { resumeSessionId?: string } = {}) =>
  createOpenCodeEngine().run({ prompt: "Hallo", streaming: false, timeoutMs: 60_000, cwd: CWD, ...extra });

describe("Rechte je Einstellung", () => {
  test("Standard ist auto", () => {
    expect(DEFAULT_OPENCODE_PERMISSION).toBe("auto");
    expect([...OPENCODE_PERMISSION_LEVELS]).toEqual(["ask-deny", "auto"]);
    expect(opencodePermission()).toBe("auto");
  });

  test("Akzeptanz: ohne Einstellungsdatei enthält der Aufruf --auto, neu und beim Fortsetzen", async () => {
    fake.next({ events: oc.reply(S, "Eins") });
    await run();
    expect(fake.runCommand()).toEqual(["opencode", "run", "--format", "json", "--auto", "--dir", CWD]);
    fake.next({ events: oc.reply(S, "Zwei") });
    await run({ resumeSessionId: S });
    expect(fake.runCommand()).toEqual(["opencode", "run", "--format", "json", "--auto", "--dir", CWD, "--session", S]);
  });

  test("Akzeptanz: mit ask-deny kein --auto, neu und beim Fortsetzen", async () => {
    writeSettingsFile({ engine: { opencode: { permission: "ask-deny" } } });
    expect(opencodePermission()).toBe("ask-deny");
    fake.next({ events: oc.reply(S, "Eins") });
    await run();
    expect(fake.runCommand()).toEqual(["opencode", "run", "--format", "json", "--dir", CWD]);
    fake.next({ events: oc.reply(S, "Zwei") });
    await run({ resumeSessionId: S });
    expect(fake.runCommand()).toEqual(["opencode", "run", "--format", "json", "--dir", CWD, "--session", S]);
    expect(fake.runCommands().flat()).not.toContain("--auto");
  });

  test("auto ausdrücklich gesetzt und Datei ohne engine-Abschnitt: --auto", async () => {
    writeSettingsFile({ engine: { opencode: { permission: "auto" } } });
    fake.next({ events: oc.reply(S, "ok") });
    await run();
    expect(fake.runCommand()).toContain("--auto");
    writeSettingsFile({ defaults: { effort: "high" } });
    expect(opencodePermission()).toBe("auto");
  });

  test("opencodeArgs: ohne Angabe auto, mit Modell und Variante vor --dir, unbekannte Stufe wirft", () => {
    expect(opencodeArgs({ cwd: CWD })).toEqual(["run", "--format", "json", "--auto", "--dir", CWD]);
    expect(opencodeArgs({ cwd: CWD, permission: "ask-deny", model: "openrouter/openai/gpt-5.5", effort: "high" })).toEqual([
      "run", "--format", "json", "--model", "openrouter/openai/gpt-5.5", "--variant=high", "--dir", CWD,
    ]);
    expect(opencodePermissionArgs("auto")).toEqual(["--auto"]);
    expect(opencodePermissionArgs("ask-deny")).toEqual([]);
    expect(() => opencodePermissionArgs("alles" as OpenCodePermission)).toThrow("Ungültige OpenCode-Rechte-Stufe");
  });

  test("Schema: nur ask-deny und auto, andere Werte und Felder werden abgelehnt", () => {
    for (const permission of OPENCODE_PERMISSION_LEVELS) {
      expect(settingsSchema.safeParse({ engine: { opencode: { permission } } }).success).toBe(true);
    }
    for (const permission of ["allow", "deny", "ask", "", "AUTO", 1, true]) {
      expect(settingsSchema.safeParse({ engine: { opencode: { permission } } }).success).toBe(false);
    }
    expect(settingsSchema.safeParse({ engine: { opencode: {} } }).success).toBe(true);
  });
});

describe("Einstellung wird bei jedem Lauf gelesen", () => {
  test("Änderung zwischen neuem Lauf und Fortsetzen greift beim Fortsetzen, auch zurück", async () => {
    fake.next({ events: oc.reply(S, "Eins") });
    await run();
    expect(fake.runCommand()).toContain("--auto");

    writeSettingsFile({ engine: { opencode: { permission: "ask-deny" } } });
    fake.next({ events: oc.reply(S, "Zwei") });
    await run({ resumeSessionId: S });
    expect(fake.runCommand()).not.toContain("--auto");

    writeSettingsFile({ engine: { opencode: { permission: "auto" } } });
    fake.next({ events: oc.reply(S, "Drei") });
    await run({ resumeSessionId: S });
    expect(fake.runCommand()).toContain("--auto");
  });

  test("ungültiger Wert: Datei abgelehnt, letzte gültige Einstellung bleibt", async () => {
    writeSettingsFile({ engine: { opencode: { permission: "ask-deny" } } });
    expect(opencodePermission()).toBe("ask-deny");
    writeSettingsFile({ engine: { opencode: { permission: "allow" } } });
    expect(getSettings().engine?.opencode?.permission).toBe("ask-deny");
    fake.next({ events: oc.reply(S, "ok") });
    await run();
    expect(fake.runCommand()).not.toContain("--auto");
  });
});

describe("Log der Rechte", () => {
  const lines = () => logs.filter((l) => l.startsWith("[OpenCode] Rechte"));

  test("beim ersten Lauf genau eine Zeile, bei Änderung wieder", async () => {
    for (let i = 0; i < 3; i++) {
      fake.next({ events: oc.reply(S, "ok") });
      await run();
    }
    expect(lines()).toEqual([
      "[OpenCode] Rechte: auto (Fragen automatisch bestätigen (--auto), deny aus der OpenCode-Konfiguration gilt), Einstellung engine.opencode.permission",
    ]);
    writeSettingsFile({ engine: { opencode: { permission: "ask-deny" } } });
    fake.next({ events: oc.reply(S, "ok") });
    await run({ resumeSessionId: S });
    expect(lines()).toHaveLength(2);
    expect(lines()[1]).toContain("ask-deny (Fragen ablehnen)");
  });
});

describe("Projekt-Kontext", () => {
  test("tybo setzt für den Kontext nichts: kein Argument, keine OPENCODE_DISABLE_CLAUDE_CODE*, kein OPENCODE_PERMISSION", async () => {
    for (const permission of OPENCODE_PERMISSION_LEVELS) {
      writeSettingsFile({ engine: { opencode: { permission } } });
      for (const resumeSessionId of [undefined, S]) {
        fake.next({ events: oc.reply(S, "ok") });
        await run({ resumeSessionId });
        const call = fake.spawns.at(-1)!;
        const env = call.env ?? {};
        expect(Object.keys(env).filter((k) => k.startsWith("OPENCODE_DISABLE_CLAUDE_CODE"))).toEqual([]);
        expect(env.OPENCODE_PERMISSION).toBeUndefined();
        expect(env.OPENCODE_CONFIG_CONTENT).toBeUndefined();
        // Kein Verweis auf eine Kontextdatei auf der Kommandozeile: OpenCode findet sie selbst
        expect(call.cmd.some((a) => /CLAUDE\.md|AGENTS\.md/.test(a))).toBe(false);
        expect(call.cwd).toBe(CWD);
        expect(env.PWD).toBe(CWD);
      }
    }
    // Auch die Versionsprüfung setzt nichts davon
    const version = fake.spawns.find((s) => s.cmd.at(-1) === "--version")!;
    expect(Object.keys(version.env ?? {}).filter((k) => k.startsWith("OPENCODE_DISABLE_CLAUDE_CODE"))).toEqual([]);
  });

  test("opencodeEnv setzt keine Kontext-Schalter; eine vom Nutzer gesetzte Variable bleibt seine Entscheidung", () => {
    expect(Object.keys(opencodeEnv(CWD)).filter((k) => CONTEXT_VARS.includes(k))).toEqual([]);
    process.env.OPENCODE_DISABLE_CLAUDE_CODE_PROMPT = "1";
    expect(opencodeEnv(CWD).OPENCODE_DISABLE_CLAUDE_CODE_PROMPT).toBe("1");
  });
});
