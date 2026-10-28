/**
 * Codex-Motor, Projekt-Kontext und Rechte (Issue #124): jeder exec-Aufruf,
 * neu und fortgesetzt, liest die CLAUDE.md über project_doc_* und trägt die
 * Rechte-Argumente der Einstellung engine.codex.sandbox (Standard full).
 * Prozessstart ist eine Attrappe (tests/codex-fixture.ts), die
 * Einstellungsdatei liegt in einem Temp-Verzeichnis.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  CODEX_PROJECT_DOC_ARGS,
  codexArgs,
  codexSandbox,
  codexSandboxArgs,
  createCodexEngine,
  resetCodexSandboxLogForTests,
} from "../src/lib/engines/codex";
import { CODEX_SANDBOX_LEVELS, getSettings, setSettingsPath, type CodexSandbox } from "../src/lib/settings";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { ev, installCodexFake, type CodexFake } from "./codex-fixture";

const CWD = "/tmp/tybo-projekt";
const DOC = ["-c", 'project_doc_fallback_filenames=["CLAUDE.md"]', "-c", "project_doc_max_bytes=65536"];
const NEVER = ["-c", 'approval_policy="never"'];
const NET = ["-c", "sandbox_workspace_write.network_access=true"];

/** Erwartete Rechte-Argumente je Stufe */
const EXPECTED: Record<CodexSandbox, { fresh: string[]; resume: string[] }> = {
  "read-only": {
    fresh: ["--sandbox", "read-only", ...NEVER],
    resume: ["-c", 'sandbox_mode="read-only"', ...NEVER],
  },
  "workspace-write": {
    fresh: ["--sandbox", "workspace-write", ...NET, ...NEVER],
    resume: ["-c", 'sandbox_mode="workspace-write"', ...NET, ...NEVER],
  },
  full: {
    fresh: ["--dangerously-bypass-approvals-and-sandbox", ...NEVER],
    resume: ["-c", 'sandbox_mode="danger-full-access"', ...NEVER],
  },
};

let dir: string;
let settingsFile: string;
let fake: CodexFake;
let logs: string[];
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

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
  dir = mkdtempSync(join(tmpdir(), "tybo-codex-sandbox-"));
  settingsFile = join(dir, "settings.json");
  setSettingsPath(settingsFile);
  resetCodexSandboxLogForTests();
  fake = installCodexFake();
  logs = [];
  logSpy = spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  fake.restore();
  logSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

const run = (extra: { resumeSessionId?: string } = {}) =>
  createCodexEngine().run({ prompt: "Hallo", streaming: false, timeoutMs: 60_000, cwd: CWD, ...extra });

/** Teilfolge an beliebiger Stelle */
function containsSeq(cmd: string[], seq: string[]): boolean {
  for (let i = 0; i + seq.length <= cmd.length; i++) if (seq.every((s, j) => cmd[i + j] === s)) return true;
  return false;
}

describe("Kommandozeile je Rechte-Stufe", () => {
  test("Projekt-Kontext: fester Satz mit CLAUDE.md und 64 KiB", () => {
    expect([...CODEX_PROJECT_DOC_ARGS]).toEqual(DOC);
  });

  for (const level of CODEX_SANDBOX_LEVELS) {
    test(`${level}: neuer Lauf und Fortsetzen`, async () => {
      writeSettingsFile({ engine: { codex: { sandbox: level } } });
      expect(codexSandbox()).toBe(level);

      fake.next({ events: [ev.started("t-1"), ev.message("m", "Eins"), ev.completed()] });
      await run();
      expect(fake.command(0)).toEqual(["codex", "exec", "--json", ...DOC, ...EXPECTED[level].fresh, "-C", CWD, "--skip-git-repo-check", "-"]);

      fake.next({ events: [ev.started("t-1"), ev.message("m", "Zwei"), ev.completed()] });
      await run({ resumeSessionId: "t-1" });
      expect(fake.command(1)).toEqual([
        "codex", "exec", "resume", "--json", ...DOC, ...EXPECTED[level].resume, "--skip-git-repo-check", "t-1", "-",
      ]);
    });
  }

  test("nur workspace-write gibt Netz frei, full umgeht die Sandbox nur beim neuen Lauf per Schalter", () => {
    for (const level of CODEX_SANDBOX_LEVELS) {
      for (const resume of [false, true]) {
        const args = codexSandboxArgs(level, resume);
        expect(containsSeq(args, NET)).toBe(level === "workspace-write");
        expect(containsSeq(args, NEVER)).toBe(true);
        expect(args.includes("--dangerously-bypass-approvals-and-sandbox")).toBe(level === "full" && !resume);
      }
    }
  });

  test("ohne Einstellungsdatei und ohne engine-Abschnitt gilt full", async () => {
    expect(codexSandbox()).toBe("full");
    writeSettingsFile({ defaults: { effort: "high" } });
    expect(codexSandbox()).toBe("full");
    fake.next({ events: [ev.completed()] });
    await run();
    expect(containsSeq(fake.command(), EXPECTED.full.fresh)).toBe(true);
  });

  test("codexArgs ohne Stufe nimmt full, eine unbekannte Stufe wirft", () => {
    expect(containsSeq(codexArgs({ cwd: CWD }), [...DOC, ...EXPECTED.full.fresh])).toBe(true);
    expect(() => codexArgs({ cwd: CWD, sandbox: "alles" as CodexSandbox })).toThrow("Ungültige Codex-Rechte-Stufe");
  });

  test("jeder exec-Aufruf trägt die project_doc-Einstellungen, auch mit Modell und Effort", () => {
    for (const level of CODEX_SANDBOX_LEVELS) {
      for (const resumeSessionId of [undefined, "t-9"]) {
        const args = codexArgs({ cwd: CWD, sandbox: level, model: "gpt-5.5-codex", effort: "high", resumeSessionId });
        expect(containsSeq(args, DOC)).toBe(true);
        expect(containsSeq(args, resumeSessionId ? EXPECTED[level].resume : EXPECTED[level].fresh)).toBe(true);
      }
    }
  });
});

describe("Einstellung wird bei jedem Lauf gelesen", () => {
  test("Änderung zwischen neuem Lauf und Fortsetzen greift beim Fortsetzen", async () => {
    writeSettingsFile({ engine: { codex: { sandbox: "full" } } });
    fake.next({ events: [ev.started("t-2"), ev.completed()] });
    await run();
    expect(containsSeq(fake.command(0), EXPECTED.full.fresh)).toBe(true);

    writeSettingsFile({ engine: { codex: { sandbox: "read-only" } } });
    fake.next({ events: [ev.started("t-2"), ev.completed()] });
    await run({ resumeSessionId: "t-2" });
    expect(containsSeq(fake.command(1), EXPECTED["read-only"].resume)).toBe(true);
    expect(fake.command(1)).not.toContain("--dangerously-bypass-approvals-and-sandbox");
  });

  test("ungültiger Wert: Datei abgelehnt, letzte gültige Stufe bleibt", async () => {
    writeSettingsFile({ engine: { codex: { sandbox: "workspace-write" } } });
    expect(codexSandbox()).toBe("workspace-write");
    writeSettingsFile({ engine: { codex: { sandbox: "danger-full-access" } } });
    expect(getSettings().engine?.codex?.sandbox).toBe("workspace-write");
    fake.next({ events: [ev.completed()] });
    await run();
    expect(containsSeq(fake.command(), EXPECTED["workspace-write"].fresh)).toBe(true);
  });
});

describe("Log der Rechte-Stufe", () => {
  const sandboxLines = () => logs.filter((l) => l.startsWith("[Codex] Rechte-Stufe"));

  test("beim ersten Aufruf genau eine Zeile, bei Änderung wieder", async () => {
    for (let i = 0; i < 3; i++) {
      fake.next({ events: [ev.completed()] });
      await run();
    }
    expect(sandboxLines()).toEqual(["[Codex] Rechte-Stufe: full (Voller Zugriff, ohne Sandbox), Einstellung engine.codex.sandbox"]);

    writeSettingsFile({ engine: { codex: { sandbox: "read-only" } } });
    fake.next({ events: [ev.completed()] });
    await run({ resumeSessionId: "t-3" });
    expect(sandboxLines()).toHaveLength(2);
    expect(sandboxLines()[1]).toContain("read-only (Nur lesen)");
  });

  test("auch bei Fortsetzen als erstem Aufruf", async () => {
    writeSettingsFile({ engine: { codex: { sandbox: "workspace-write" } } });
    fake.next({ events: [ev.completed()] });
    await run({ resumeSessionId: "t-4" });
    expect(sandboxLines()).toEqual([
      "[Codex] Rechte-Stufe: workspace-write (Projekt schreiben, mit Netz), Einstellung engine.codex.sandbox",
    ]);
  });
});
