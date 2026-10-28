/**
 * Issue #349: Was außer den Chat-Aufrufen der Anmeldung des Motors claude
 * folgt (CLAUDE_AUTH): Motor-Anzeige, Telefonhörer-CLI und deren
 * Abrechnungsanzeige, Hintergrund-Jobs und die Einrichtung (Bericht und
 * echte Probe). Alle Prozesse sind Attrappen, es läuft nie ein echtes claude.
 * Die Abo-Messung prüft tests/spend-credit-report.test.ts.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { CLAUDE_API_KEY_MISSING, setClaudeAuthWarnForTests } from "../src/lib/engines/claude-auth";
import { inspectEngine, resetEngineCheckCacheForTests } from "../src/lib/engines/check";
import { jobClaudeEnv } from "../src/lib/jobs/default-deps";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { claudeCliEnv, createClaudeCliBackend, CLI_REQUIRED_FLAGS, type CliRuntime } from "../src/lib/voice-brain/backends/claude-cli";
import { callWays, resolveCallModel, type CallModelDeps } from "../src/lib/voice-brain/call-model";
import { runVoiceTurn, type VoiceTurnEvent } from "../src/lib/voice-brain/turn";
import { claudeRunContext, projectClaudeAuth } from "../src/setup/checks/report";
import { createProviders } from "../src/setup/providers";
import { prerequisitesStep } from "../src/setup/steps/prerequisites";
import { installCodexFake, type CodexFake } from "./codex-fixture";
import { snapshotEnv } from "./env-snapshot";
import { fakeRun, makeCtx } from "./setup-fixture";

const KEY = "sk-ant-test-nur-attrappe-0349";
const SHELL_KEY = "sk-ant-shell-attrappe-0349";

let restoreEnv: () => void = () => {};
let before: Record<string, string | undefined> = {};

beforeAll(() => setMcpReaderForTests(() => new Set()));
afterAll(() => setMcpReaderForTests(null));
beforeEach(() => {
  restoreEnv = snapshotEnv();
  for (const name of ["CLAUDE_AUTH", "ANTHROPIC_API_KEY", "CLAUDE_PATH", "TYBO_SUBPROCESS_ENV_ALLOW"]) delete process.env[name];
  setClaudeAuthWarnForTests(() => {});
});
afterEach(() => {
  setClaudeAuthWarnForTests(null);
  restoreEnv();
});

function useEnv(values: Record<string, string>): void {
  Object.assign(process.env, values);
  before = { ...process.env };
}

const expectEnvUnchanged = () => expect({ ...process.env }).toEqual(before);

// ---------------------------------------------------------------------------
// Motor-Anzeige
// ---------------------------------------------------------------------------

describe("inspectEngine(\"claude\")", () => {
  let fake: CodexFake;
  beforeEach(() => {
    resetEngineCheckCacheForTests();
    fake = installCodexFake();
  });
  afterEach(() => {
    fake.restore();
    resetEngineCheckCacheForTests();
  });

  const VERSION = { stdout: "2.1.281 (Claude Code)\n", exitCode: 0 };
  const LOGGED_IN = { stdout: JSON.stringify({ loggedIn: true }), exitCode: 0 };

  test("apiKey ohne Schlüssel: „nicht angemeldet“ mit Meldung, ohne die Anmeldung der CLI zu fragen", async () => {
    useEnv({ CLAUDE_AUTH: "apiKey" });
    fake.next(VERSION);
    const status = await inspectEngine("claude");
    expect(status).toEqual({ engine: "claude", checked: true, installed: true, loggedIn: false, version: "2.1.281", message: CLAUDE_API_KEY_MISSING });
    expect(fake.spawns.map(s => s.cmd)).toEqual([["claude", "--version"]]);
    expectEnvUnchanged();
  });

  test("Prüfbefehle bekommen den Schlüssel nach CLAUDE_AUTH; Zwischenspeicher trennt die Anmeldung", async () => {
    useEnv({ CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: KEY });
    fake.next(VERSION);
    fake.next(LOGGED_IN);
    expect((await inspectEngine("claude")).loggedIn).toBe(true);
    expect(fake.spawns.every(s => s.env?.ANTHROPIC_API_KEY === undefined)).toBe(true);

    // Andere Anmeldung: neue Prüfung statt des gespeicherten Ergebnisses
    process.env.CLAUDE_AUTH = "apiKey";
    before = { ...process.env };
    fake.next(VERSION);
    fake.next(LOGGED_IN);
    expect((await inspectEngine("claude")).loggedIn).toBe(true);
    expect(fake.spawns).toHaveLength(4);
    expect(fake.spawns[2]!.env?.ANTHROPIC_API_KEY).toBe(KEY);
    expect(fake.spawns[3]!.env?.ANTHROPIC_API_KEY).toBe(KEY);

    delete process.env.ANTHROPIC_API_KEY;
    before = { ...process.env };
    fake.next(VERSION);
    expect((await inspectEngine("claude")).message).toBe(CLAUDE_API_KEY_MISSING);
    expectEnvUnchanged();
  });
});

// ---------------------------------------------------------------------------
// Telefonhörer
// ---------------------------------------------------------------------------

describe("Telefonhörer über Claude Code", () => {
  const base = { PATH: "/bin", LANG: "de_DE.UTF-8", ANTHROPIC_API_KEY: KEY };

  test("claudeCliEnv: Schlüssel nur bei apiKey, nie bei subscription", () => {
    expect(claudeCliEnv("claude-sonnet-5-5", base, { CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: KEY }).ANTHROPIC_API_KEY).toBeUndefined();
    expect(claudeCliEnv("claude-sonnet-5-5", base, { CLAUDE_AUTH: "apiKey", ANTHROPIC_API_KEY: KEY }).ANTHROPIC_API_KEY).toBe(KEY);
    expect(claudeCliEnv("claude-sonnet-5-5", base, { CLAUDE_AUTH: "apiKey" }).ANTHROPIC_API_KEY).toBeUndefined();
    // Ohne Option wie bisher
    expect(claudeCliEnv("claude-sonnet-5-5", base, { ANTHROPIC_API_KEY: KEY }).ANTHROPIC_API_KEY).toBe(KEY);
    expect(claudeCliEnv("claude-sonnet-5-5", base, {}).ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("apiKey ohne Schlüssel: keine Sitzung, der Turn nennt den Grund", async () => {
    useEnv({ CLAUDE_AUTH: "apiKey" });
    const spawned: string[][] = [];
    const runtime: CliRuntime = {
      spawn: o => {
        spawned.push(o.cmd);
        throw new Error("darf nicht starten");
      },
      terminate: () => {},
      help: async () => CLI_REQUIRED_FLAGS.map(f => `  ${f} <x>`).join("\n"),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: h => clearTimeout(h as ReturnType<typeof setTimeout>),
    };
    const backend = createClaudeCliBackend({ model: "claude-sonnet-5-5", effort: "low", runtime });
    const events: VoiceTurnEvent[] = [];
    for await (const e of runVoiceTurn({ backend, system: "S", history: [], userText: "Hallo" })) events.push(e);
    expect(spawned).toHaveLength(0);
    expect(events[events.length - 1]).toMatchObject({ type: "error", reason: "setup", message: CLAUDE_API_KEY_MISSING });
    expectEnvUnchanged();
  });

  const ready = (env: Record<string, string>): CallModelDeps => ({
    settings: { speech: { call: { model: "claude:claude-sonnet-5-5", claudeVia: "cli" } } },
    env,
    inspectClaude: async () => ({ engine: "claude", checked: true, installed: true, loggedIn: true }),
    cliFlags: async () => ({ missing: [] }),
  });

  test("Abrechnungsanzeige folgt CLAUDE_AUTH", async () => {
    expect((await resolveCallModel(ready({ CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: KEY }))).billing).toBe("subscription");
    expect((await resolveCallModel(ready({ CLAUDE_AUTH: "apiKey", ANTHROPIC_API_KEY: KEY }))).billing).toBe("anthropic-api");
    expect((await resolveCallModel(ready({ ANTHROPIC_API_KEY: KEY }))).billing).toBe("anthropic-api");
    expect((await resolveCallModel(ready({}))).billing).toBe("subscription");
    const ways = await callWays(ready({ CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: KEY }));
    expect(ways.find(w => w.id === "cli")!.label).toContain("über dein Claude-Abo");
  });
});

// ---------------------------------------------------------------------------
// Hintergrund-Jobs
// ---------------------------------------------------------------------------

describe("Hintergrund-Jobs", () => {
  const status = { id: "20261022-070000-000349", target: { chatId: "-1001" } } as never;
  const root = "/tmp/tybo-349-job";

  test("Umgebung nach CLAUDE_AUTH aus der Umgebung des Jobs", () => {
    expect(jobClaudeEnv(root, { PATH: "/bin", HOME: root, CLAUDE_AUTH: "apiKey", ANTHROPIC_API_KEY: KEY }, status).ANTHROPIC_API_KEY).toBe(KEY);
    const sub = jobClaudeEnv(root, { PATH: "/bin", HOME: root, CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: KEY, TYBO_SUBPROCESS_ENV_ALLOW: "ANTHROPIC_API_KEY" }, status);
    expect(sub.ANTHROPIC_API_KEY).toBeUndefined();
  });

  test("apiKey ohne Schlüssel: kein Start, der Grund geht an den Wächter (start_failed)", () => {
    expect(() => jobClaudeEnv(root, { PATH: "/bin", HOME: root, CLAUDE_AUTH: "apiKey" }, status)).toThrow(CLAUDE_API_KEY_MISSING);
  });
});

// ---------------------------------------------------------------------------
// Einrichtung
// ---------------------------------------------------------------------------

describe("Einrichtung: Anmeldung allein aus der .env des Projekts", () => {
  const ctx = { root: "/tmp/tybo-349-projekt", home: "/tmp/tybo-349-home" } as never;

  test("claudeRunContext: Shell und Projekt widersprechen sich, das Projekt gilt", () => {
    // Shell: apiKey mit Schlüssel; Projekt: subscription mit eigenem Schlüssel
    useEnv({ CLAUDE_AUTH: "apiKey", ANTHROPIC_API_KEY: SHELL_KEY });
    const sub = claudeRunContext(ctx, { CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: KEY });
    expect(sub.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sub.env.CLAUDE_AUTH).toBe("subscription");
    // Projekt ohne Option, aber mit Schlüssel: apiKey mit dem Projektschlüssel, nie dem der Shell
    const derived = claudeRunContext(ctx, { ANTHROPIC_API_KEY: KEY });
    expect(derived.env.ANTHROPIC_API_KEY).toBe(KEY);
    // Shell subscription, Projekt apiKey ohne Schlüssel: kein Schlüssel aus der Shell, Modus apiKey
    process.env.CLAUDE_AUTH = "subscription";
    before = { ...process.env };
    const missing = claudeRunContext(ctx, { CLAUDE_AUTH: "apiKey" });
    expect(missing.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(missing.env.CLAUDE_AUTH).toBe("apiKey");
    // Platzhalter zählt nicht als Schlüssel
    expect(projectClaudeAuth({ ANTHROPIC_API_KEY: "sk-ant-api03-your_key_here" }).ANTHROPIC_API_KEY).toBeUndefined();
    expectEnvUnchanged();
  });

  test("claudeProbe: apiKey ohne Schlüssel startet nichts; sonst mit Umgebung und Ordner des Kontexts", async () => {
    const run = fakeRun({ "claude -p": { stdout: JSON.stringify({ is_error: false, result: "OK" }) } });
    const envs: (Record<string, string> | undefined)[] = [];
    const wrapped = (async (cmd: string[], options?: { env?: Record<string, string>; cwd?: string }) => {
      envs.push(options?.env);
      return run(cmd);
    }) as typeof run;
    const providers = createProviders({ fetch: async () => new Response(""), run: wrapped });
    const blocked = await providers.claudeProbe("claude", claudeRunContext(ctx, { CLAUDE_AUTH: "apiKey" }));
    expect(blocked).toEqual({ ok: false, message: CLAUDE_API_KEY_MISSING });
    expect(run.calls).toHaveLength(0);

    const ok = await providers.claudeProbe("claude", claudeRunContext(ctx, { CLAUDE_AUTH: "apiKey", ANTHROPIC_API_KEY: KEY }));
    expect(ok.ok).toBe(true);
    expect(envs[0]!.ANTHROPIC_API_KEY).toBe(KEY);

    // Ohne Kontext: Umgebung dieses Prozesses, auch dort keine Abo-Probe bei apiKey ohne Schlüssel
    useEnv({ CLAUDE_AUTH: "apiKey" });
    expect(await providers.claudeProbe("claude")).toEqual({ ok: false, message: CLAUDE_API_KEY_MISSING });
    expect(run.calls).toHaveLength(1);
    expectEnvUnchanged();
  });

  test("Schritt Voraussetzungen: die Probe bekommt die Anmeldung der .env, nicht der Shell", async () => {
    useEnv({ CLAUDE_AUTH: "apiKey", ANTHROPIC_API_KEY: SHELL_KEY });
    const setup = await makeCtx({ env: `CLAUDE_AUTH=subscription\nANTHROPIC_API_KEY=${KEY}\n` });
    await prerequisitesStep.test!({}, setup);
    const probe = setup.providers.calls.find(c => c.method === "claudeProbe");
    expect(probe).toBeDefined();
    const context = probe!.args[1] as { cwd: string; env: Record<string, string> };
    expect(context.cwd).toBe(setup.root);
    expect(context.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(context.env.CLAUDE_AUTH).toBe("subscription");
    expect(JSON.stringify(context.env)).not.toContain(SHELL_KEY);
    expectEnvUnchanged();
  });

  test("claudeVersion ohne Kontext: gefilterte Umgebung, nie die ungefilterte dieses Prozesses", async () => {
    useEnv({ CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: SHELL_KEY });
    const envs: (Record<string, string> | undefined)[] = [];
    const run = (async (cmd: string[], options?: { env?: Record<string, string> }) => {
      envs.push(options?.env);
      return { code: 0, stdout: "2.1.300 (Claude Code)\n", stderr: "" };
    }) as never;
    const providers = createProviders({ fetch: async () => new Response(""), run });
    expect((await providers.claudeVersion("claude")).ok).toBe(true);
    expect(envs).toHaveLength(1);
    expect(envs[0]).toBeDefined();
    expect(envs[0]!.ANTHROPIC_API_KEY).toBeUndefined();
    expect(envs[0]!.TYBO_SUBPROCESS).toBe("1");
    expectEnvUnchanged();
  });

  describe("Schritt Voraussetzungen: jeder Claude-Aufruf mit der Anmeldung der .env (Shell apiKey, Projekt subscription)", () => {
    type Seen = { cmd: string[]; cwd?: string; env?: Record<string, string> };

    /** Echte Anbieter, Befehle als Attrappe; erfasst werden alle Aufrufe von claude, auch über ctx.run */
    async function setupWith(answer: (cmd: string[]) => { code: number; stdout: string; stderr: string; spawnError?: string }) {
      useEnv({ CLAUDE_AUTH: "apiKey", ANTHROPIC_API_KEY: SHELL_KEY });
      const setup = await makeCtx({ env: `CLAUDE_AUTH=subscription\nANTHROPIC_API_KEY=${KEY}\n` });
      const seen: Seen[] = [];
      const record = (fallback: (cmd: string[]) => Promise<unknown>) =>
        (async (cmd: string[], options?: { cwd?: string; env?: Record<string, string> }) => {
          if (/(^|\/)claude$/.test(cmd[0]!)) {
            seen.push({ cmd, cwd: options?.cwd, env: options?.env });
            return answer(cmd);
          }
          return fallback(cmd);
        }) as never;
      const ctxRun = setup.run;
      const setupRun = record(cmd => ctxRun(cmd));
      Object.assign(setup, { run: setupRun, providers: createProviders({ fetch: async () => new Response(""), run: record(async () => ({ code: -1, stdout: "", stderr: "", spawnError: "ENOENT" })) }) });
      return { setup, seen };
    }

    function expectProjectAuth(seen: Seen[], root: string) {
      for (const call of seen) {
        expect(call.cwd).toBe(root);
        expect(call.env).toBeDefined();
        expect(call.env!.ANTHROPIC_API_KEY).toBeUndefined();
        expect(call.env!.CLAUDE_AUTH).toBe("subscription");
        expect(JSON.stringify(call.env)).not.toContain(SHELL_KEY);
        expect(JSON.stringify(call.env)).not.toContain(KEY);
      }
    }

    test("claude im PATH: Version (status und test) und Probe", async () => {
      const { setup, seen } = await setupWith(cmd =>
        cmd[1] === "--version"
          ? { code: 0, stdout: "2.1.300 (Claude Code)\n", stderr: "" }
          : { code: 0, stdout: JSON.stringify({ is_error: false, result: "OK" }), stderr: "" },
      );
      await prerequisitesStep.status(setup);
      await prerequisitesStep.test!({}, setup);
      expect(seen.map(s => s.cmd.slice(0, 2))).toEqual([
        ["claude", "--version"],
        ["claude", "--version"],
        ["claude", "-p"],
      ]);
      expectProjectAuth(seen, setup.root);
      expectEnvUnchanged();
    });

    test("alternativer Pfad ~/.local/bin/claude: auch dessen Versionsprüfung", async () => {
      const { mkdir, writeFile } = await import("node:fs/promises");
      const { dirname, join } = await import("node:path");
      const { setup, seen } = await setupWith(cmd =>
        cmd[0] === "claude"
          ? { code: -1, stdout: "", stderr: "", spawnError: "ENOENT" }
          : { code: 0, stdout: "2.1.300 (Claude Code)\n", stderr: "" },
      );
      const local = join(setup.home, ".local", "bin", "claude");
      await mkdir(dirname(local), { recursive: true });
      await writeFile(local, "#!/bin/sh\n", { mode: 0o755 });
      await prerequisitesStep.status(setup);
      await prerequisitesStep.test!({}, setup);
      expect(seen.map(s => s.cmd)).toEqual([
        ["claude", "--version"],
        [local, "--version"],
        ["claude", "--version"],
        [local, "--version"],
      ]);
      expectProjectAuth(seen, setup.root);
      expectEnvUnchanged();
    });
  });
});

// ---------------------------------------------------------------------------
// Bot-Prozess ohne SDK
// ---------------------------------------------------------------------------

describe("Bot-Prozess ohne Agent SDK", () => {
  test("Issue #352: agent-session und sdk-security sind entfernt, nichts unter src/ importiert das Agent SDK", async () => {
    const { existsSync, readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const rootDir = join(import.meta.dir, "..");
    expect(existsSync(join(rootDir, "src/lib/agent-session.ts"))).toBe(false);
    expect(existsSync(join(rootDir, "src/lib/sdk-security.ts"))).toBe(false);
    const hits: string[] = [];
    const files = readdirSync(join(rootDir, "src"), { recursive: true }) as string[];
    for (const file of files.filter(f => /\.(ts|js)$/.test(f))) {
      const text = readFileSync(join(rootDir, "src", file), "utf8");
      if (/["']@anthropic-ai\/claude-agent-sdk["']|\/(agent-session|sdk-security)["']/.test(text)) hits.push(file);
    }
    expect(hits).toEqual([]);
  });
});
