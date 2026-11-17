/**
 * Issue #566, Prüfung des Prüfers: installed=false heißt bei
 * inspectEngine("claude") nicht immer „nicht installiert“. Abgeschaltet wird
 * nur, wenn die Prüfung es sicher sagt (Befehl nicht startbar, Exit 127,
 * ausdrücklich nicht angemeldet). Zeitlimit, Exit 1 der Versionsprüfung und
 * ein abgefangener Prüffehler bleiben unklar und schalten nichts ab. Ebenso
 * Startfehler, die vorübergehend sein können (EAGAIN, EMFILE, ENOMEM) oder
 * nichts Sicheres sagen (EACCES, kein Fehlercode); nur ENOENT und ENOTDIR
 * heißen „Befehl gibt es nicht“.
 *
 * Geprüft wird mit dem echten Prüfadapter (inspectEngine("claude") in
 * src/lib/engines/check.ts) gegen Prozessattrappen (tests/codex-fixture.ts):
 * kein echtes claude, keine echten Signale, Zeitgeber von Hand.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  checkClaudeAtStart,
  claudeAvailability,
  claudeMissing,
  CLAUDE_NOT_INSTALLED,
  resetClaudeAvailabilityForTests,
} from "../src/lib/claude-availability";
import {
  CLAUDE_NOT_INSTALLED as CHECK_NOT_INSTALLED,
  claudeStartFailedMessage,
  ENGINE_CHECK_TIMEOUT_MS,
  inspectEngine,
  resetEngineCheckCacheForTests,
} from "../src/lib/engines/check";
import { setCodexRuntimeForTests } from "../src/lib/engines/codex";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { installCodexFake, until, type CodexFake } from "./codex-fixture";

let fake: CodexFake;
const KEYS = ["CLAUDE_PATH", "CLAUDE_AUTH", "ANTHROPIC_API_KEY", "TYBO_SUBPROCESS_ENV_ALLOW"] as const;
const saved: Partial<Record<(typeof KEYS)[number], string | undefined>> = {};
const AUTH = (loggedIn: boolean) => JSON.stringify({ loggedIn });
const CLAUDE_VERSION = { stdout: "2.1.281 (Claude Code)\n", exitCode: 0 };

beforeAll(() => setMcpReaderForTests(() => new Set()));
afterAll(() => setMcpReaderForTests(null));
beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  for (const k of KEYS) delete process.env[k];
  process.env.CLAUDE_AUTH = "subscription";
  resetEngineCheckCacheForTests();
  resetClaudeAvailabilityForTests();
  fake = installCodexFake();
});
afterEach(() => {
  fake.restore();
  resetEngineCheckCacheForTests();
  resetClaudeAvailabilityForTests();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Startprüfung mit dem echten Adapter; Logzeilen gesammelt */
async function startCheck(): Promise<{ state: string; lines: string[] }> {
  const lines: string[] = [];
  const result = await checkClaudeAtStart({ inspect: () => inspectEngine("claude"), getSettings: () => ({}), env: () => ({}), log: l => lines.push(l) });
  return { state: result.state, lines };
}

describe("unklare Prüfprobleme schalten nichts ab", () => {
  test("Zeitlimit von claude --version: unklar, keine Logzeile, nichts abgeschaltet", async () => {
    fake.next({ hang: true });
    const pending = startCheck();
    await until(() => fake.spawns.length === 1);
    fake.advance(ENGINE_CHECK_TIMEOUT_MS);
    const { state, lines } = await pending;
    expect(state).toBe("unclear");
    expect(claudeMissing()).toBe(false);
    expect(lines).toEqual([]);
    expect(fake.spawns.map(s => s.cmd)).toEqual([["claude", "--version"]]);
  });

  test("Exit 1 von claude --version: unklar, nichts abgeschaltet", async () => {
    fake.next({ stdout: "", exitCode: 1 });
    const { state, lines } = await startCheck();
    expect(state).toBe("unclear");
    expect(claudeMissing()).toBe(false);
    expect(lines).toEqual([]);
  });

  test("abgefangener Prüffehler (Zeitgeber wirft): „ließ sich nicht prüfen“ ist unklar, nichts abgeschaltet", async () => {
    fake.restore();
    fake = installCodexFake({
      install: r =>
        setCodexRuntimeForTests(
          r && {
            ...r,
            setTimeout: () => {
              throw new Error("Zeitgeber kaputt");
            },
          },
        ),
    });
    fake.next(CLAUDE_VERSION);
    const status = await inspectEngine("claude");
    expect(status.installed).toBe(false);
    expect(status.message).toBe("Claude Code ließ sich nicht prüfen");
    resetEngineCheckCacheForTests();
    fake.next(CLAUDE_VERSION);
    const { state, lines } = await startCheck();
    expect(state).toBe("unclear");
    expect(claudeMissing()).toBe(false);
    expect(lines).toEqual([]);
  });

  for (const code of ["EAGAIN", "EMFILE", "ENOMEM", "EACCES"]) {
    test(`Startfehler ${code} von claude --version: unklar, keine Logzeile, eigene Meldung`, async () => {
      fake.next({ throws: `${code}: posix_spawn 'claude'`, throwsCode: code });
      const status = await inspectEngine("claude");
      expect(status).toEqual({ engine: "claude", checked: true, installed: false, loggedIn: false, message: claudeStartFailedMessage(code) });
      expect(status.message).not.toBe(CLAUDE_NOT_INSTALLED);
      resetEngineCheckCacheForTests();
      fake.next({ throws: `${code}: posix_spawn 'claude'`, throwsCode: code });
      const { state, lines } = await startCheck();
      expect(state).toBe("unclear");
      expect(claudeMissing()).toBe(false);
      expect(lines).toEqual([]);
    });
  }

  test("Startfehler ohne Fehlercode: unklar, nichts abgeschaltet", async () => {
    fake.next({ throws: "ENOENT" });
    const { state, lines } = await startCheck();
    expect(state).toBe("unclear");
    expect(claudeMissing()).toBe(false);
    expect(lines).toEqual([]);
    expect(claudeStartFailedMessage(undefined)).toContain("unbekannter Fehler");
  });

  test("nach dem Engpass (EAGAIN, dann wieder startbar): die nächste Prüfung findet Claude bereit, nichts war abgeschaltet", async () => {
    fake.next({ throws: "EAGAIN: posix_spawn 'claude'", throwsCode: "EAGAIN" });
    expect((await startCheck()).state).toBe("unclear");
    expect(claudeMissing()).toBe(false);
    resetEngineCheckCacheForTests();
    fake.next(CLAUDE_VERSION);
    fake.next({ stdout: AUTH(true), exitCode: 0 });
    expect((await startCheck()).state).toBe("ready");
    expect(fake.spawns.map(s => s.cmd)).toEqual([
      ["claude", "--version"],
      ["claude", "auth", "status", "--json"],
    ]);
  });

  test("Anmeldung nicht feststellbar (Exit 1 ohne JSON): bereit, nichts abgeschaltet", async () => {
    fake.next(CLAUDE_VERSION);
    fake.next({ stdout: "error: unknown command 'auth'\n", exitCode: 1 });
    expect((await startCheck()).state).toBe("ready");
    expect(claudeMissing()).toBe(false);
  });
});

describe("gesicherte Abwesenheit schaltet ab", () => {
  test("Befehl nicht startbar (ENOENT): fehlt, genau eine Logzeile", async () => {
    fake.next({ throws: "ENOENT: no such file or directory, posix_spawn 'claude'", throwsCode: "ENOENT" });
    const { state, lines } = await startCheck();
    expect(state).toBe("missing");
    expect(claudeAvailability()).toEqual({ state: "missing", reason: "Claude CLI nicht installiert" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toStartWith("[Claude] Claude CLI nicht installiert:");
  });

  test("nicht im PATH (wie Bun: „Executable not found“, Code ENOENT): fehlt", async () => {
    fake.next({ throws: 'Executable not found in $PATH: "claude"', throwsCode: "ENOENT" });
    expect((await startCheck()).state).toBe("missing");
    expect(claudeMissing()).toBe(true);
  });

  test("Teil des Pfads ist kein Ordner (ENOTDIR): fehlt", async () => {
    process.env.CLAUDE_PATH = "/etc/hosts/claude";
    fake.next({ throws: "ENOTDIR: not a directory, posix_spawn '/etc/hosts/claude'", throwsCode: "ENOTDIR" });
    expect((await startCheck()).state).toBe("missing");
    expect(fake.spawns).toEqual([]);
  });

  test("Exit 127 von claude --version: fehlt", async () => {
    fake.next({ stdout: "", exitCode: 127 });
    expect((await startCheck()).state).toBe("missing");
  });

  test("ausdrücklich nicht angemeldet: fehlt", async () => {
    fake.next(CLAUDE_VERSION);
    fake.next({ stdout: AUTH(false), exitCode: 1 });
    const { state, lines } = await startCheck();
    expect(state).toBe("missing");
    expect(lines[0]).toStartWith("[Claude] Claude nicht angemeldet:");
  });

  test("angemeldet: bereit", async () => {
    fake.next(CLAUDE_VERSION);
    fake.next({ stdout: AUTH(true), exitCode: 0 });
    expect((await startCheck()).state).toBe("ready");
  });

  test("die Meldung für „nicht installiert“ ist in beiden Modulen dieselbe", () => {
    expect(CHECK_NOT_INSTALLED).toBe(CLAUDE_NOT_INSTALLED);
  });
});
