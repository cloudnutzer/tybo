/**
 * Issue #349: Anmeldung des Motors claude über CLAUDE_AUTH. Der Auflöser
 * (src/lib/engines/claude-auth.ts), der Umgebungsfilter für Claude
 * (subprocessEnv) und die drei Aufrufwege in src/lib/claude.ts mit einer
 * Spawn-Attrappe (setSpawnForTests): es läuft nie ein echtes claude. Jeder
 * Fall prüft, dass process.env danach unverändert ist.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { callClaude, callClaudeStreaming, runClaudeWithTimeout, setRuntimeForTests, setSpawnForTests } from "../src/lib/claude";
import { resolveStreamingLimits, runStreamingTurn, type ChatTurnDeps } from "../src/lib/chat-turn";
import {
  CLAUDE_API_KEY_MISSING,
  claudeAuthCacheKey,
  claudeAuthProblem,
  claudeUsesSubscription,
  resolveClaudeAuth,
  setClaudeAuthWarnForTests,
  withClaudeAuth,
} from "../src/lib/engines/claude-auth";
import { runExecution } from "../src/lib/execution-context";
import { filterSubprocessEnv, setMcpReaderForTests, setSubprocessEnvLoggerForTests, subprocessEnv } from "../src/lib/subprocess-env";
import { snapshotEnv } from "./env-snapshot";

const KEY = "sk-ant-test-nur-attrappe-0349";
const OTHER = "sk-ant-anderer-wert-0349";

let warnings: string[] = [];
let logs: string[] = [];
let mcpVars = new Set<string>();
let restoreEnv: () => void = () => {};
let before: Record<string, string | undefined> = {};

beforeAll(() => setMcpReaderForTests(() => mcpVars));
afterAll(() => {
  setMcpReaderForTests(null);
  setSpawnForTests(null);
  setRuntimeForTests(null);
});
beforeEach(() => {
  restoreEnv = snapshotEnv();
  for (const name of ["CLAUDE_AUTH", "ANTHROPIC_API_KEY", "TYBO_SUBPROCESS_ENV_ALLOW"]) delete process.env[name];
  warnings = [];
  logs = [];
  mcpVars = new Set();
  setClaudeAuthWarnForTests(line => warnings.push(line));
  setSubprocessEnvLoggerForTests(line => logs.push(line));
});
afterEach(() => {
  setClaudeAuthWarnForTests(null);
  setSubprocessEnvLoggerForTests(null);
  restoreEnv();
});

/** Setzt die Umgebung des Falls und merkt sie sich für den Vergleich danach */
function useEnv(values: Record<string, string>): void {
  Object.assign(process.env, values);
  before = { ...process.env };
}

function expectEnvUnchanged(): void {
  expect({ ...process.env }).toEqual(before);
}

// ---------------------------------------------------------------------------
// Auflöser
// ---------------------------------------------------------------------------

describe("resolveClaudeAuth", () => {
  test("ohne Option: apiKey mit Schlüssel, sonst subscription (Verhalten vor CLAUDE_AUTH)", () => {
    expect(resolveClaudeAuth({ ANTHROPIC_API_KEY: KEY })).toEqual({ mode: "apiKey", source: "derived", apiKey: KEY });
    expect(resolveClaudeAuth({ ANTHROPIC_API_KEY: "  " })).toEqual({ mode: "subscription", source: "derived" });
    expect(resolveClaudeAuth({})).toEqual({ mode: "subscription", source: "derived" });
    expect(resolveClaudeAuth({ CLAUDE_AUTH: "", ANTHROPIC_API_KEY: KEY }).mode).toBe("apiKey");
    expect(warnings).toEqual([]);
  });

  test("subscription gilt auch mit gesetztem Schlüssel; apiKey mit und ohne Schlüssel", () => {
    expect(resolveClaudeAuth({ CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: KEY })).toEqual({ mode: "subscription", source: "setting" });
    expect(resolveClaudeAuth({ CLAUDE_AUTH: "apiKey", ANTHROPIC_API_KEY: ` ${KEY} ` })).toEqual({ mode: "apiKey", source: "setting", apiKey: KEY });
    expect(resolveClaudeAuth({ CLAUDE_AUTH: "apiKey" })).toEqual({ mode: "apiKey", source: "setting" });
    // Groß-/Kleinschreibung und Leerraum egal
    expect(resolveClaudeAuth({ CLAUDE_AUTH: " APIKEY " }).mode).toBe("apiKey");
    expect(resolveClaudeAuth({ CLAUDE_AUTH: "Subscription", ANTHROPIC_API_KEY: KEY }).mode).toBe("subscription");
  });

  test("ungültiger Wert: wie ohne Option, eine Warnung ohne den Wert, nur einmal", () => {
    expect(resolveClaudeAuth({ CLAUDE_AUTH: OTHER, ANTHROPIC_API_KEY: KEY })).toEqual({ mode: "apiKey", source: "derived", apiKey: KEY });
    expect(resolveClaudeAuth({ CLAUDE_AUTH: OTHER })).toEqual({ mode: "subscription", source: "derived" });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("CLAUDE_AUTH");
    expect(warnings[0]).not.toContain(OTHER);
    expect(warnings[0]).not.toContain(KEY);
  });

  test("Hilfen: Problem, Abo, Umgebung setzen, Zwischenspeicher-Kennung ohne Wert", () => {
    expect(claudeAuthProblem({ CLAUDE_AUTH: "apiKey" })).toBe(CLAUDE_API_KEY_MISSING);
    expect(claudeAuthProblem({ CLAUDE_AUTH: "apiKey", ANTHROPIC_API_KEY: KEY })).toBeNull();
    expect(claudeAuthProblem({})).toBeNull();
    expect(claudeUsesSubscription({ CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: KEY })).toBe(true);
    expect(claudeUsesSubscription({ CLAUDE_AUTH: "apiKey" })).toBe(false);
    const target = { PATH: "/bin", ANTHROPIC_API_KEY: OTHER };
    expect(withClaudeAuth(target, { CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: KEY })).toEqual({ PATH: "/bin" });
    expect(withClaudeAuth(target, { ANTHROPIC_API_KEY: KEY })).toEqual({ PATH: "/bin", ANTHROPIC_API_KEY: KEY });
    expect(target.ANTHROPIC_API_KEY).toBe(OTHER);
    expect(claudeAuthCacheKey({ CLAUDE_AUTH: "apiKey", ANTHROPIC_API_KEY: KEY })).toBe("apiKey:key");
    expect(claudeAuthCacheKey({ CLAUDE_AUTH: "apiKey" })).toBe("apiKey:nokey");
  });

  test("CLAUDE_AUTH steht in .env.example mit Standard und Wirkung", async () => {
    const example = await Bun.file(new URL("../.env.example", import.meta.url)).text();
    expect(example).toMatch(/^# ?CLAUDE_AUTH=/m);
    expect(example).toContain("subscription");
    expect(example).toContain("apiKey");
  });
});

// ---------------------------------------------------------------------------
// Umgebungsfilter für Claude
// ---------------------------------------------------------------------------

describe("subprocessEnv für Claude", () => {
  const base = { PATH: "/bin", HOME: "/tmp/kein-home" };

  test("subscription: kein Schlüssel, auch nicht über Freigabeliste oder MCP-Verweis; einmal im Log", () => {
    useEnv({ CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: KEY, TYBO_SUBPROCESS_ENV_ALLOW: "ANTHROPIC_API_KEY" });
    mcpVars = new Set(["ANTHROPIC_API_KEY"]);
    const first = subprocessEnv({ cwd: "/tmp", home: "/tmp/kein-home" });
    const second = subprocessEnv({ cwd: "/tmp", home: "/tmp/kein-home" });
    expect(first.ANTHROPIC_API_KEY).toBeUndefined();
    expect(second.ANTHROPIC_API_KEY).toBeUndefined();
    const withheld = logs.filter(l => l.includes("CLAUDE_AUTH=subscription"));
    expect(withheld).toHaveLength(1);
    expect(logs.join("\n")).not.toContain(KEY);
    expectEnvUnchanged();
  });

  test("apiKey: Schlüssel bleibt; ohne Option wie bisher", () => {
    expect(filterSubprocessEnv({ env: { ...base, CLAUDE_AUTH: "apiKey", ANTHROPIC_API_KEY: KEY } }).env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(filterSubprocessEnv({ env: { ...base, ANTHROPIC_API_KEY: KEY } }).env.ANTHROPIC_API_KEY).toBe(KEY);
    expect(filterSubprocessEnv({ env: { ...base, CLAUDE_AUTH: "apiKey", ANTHROPIC_API_KEY: "" } }).env.ANTHROPIC_API_KEY).toBeUndefined();
    const sub = filterSubprocessEnv({ env: { ...base, CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: KEY } });
    expect(sub.env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sub.removed).toContain("ANTHROPIC_API_KEY");
    // Ohne Freigabe oder MCP-Verweis gibt es nichts zu vermerken
    expect(sub.keyWithheld).toBeUndefined();
  });

  test("Codex und OpenCode bleiben unberührt: ANTHROPIC_API_KEY nur über ihre eigenen Regeln", () => {
    const env = { ...base, CLAUDE_AUTH: "apiKey", ANTHROPIC_API_KEY: KEY };
    expect(filterSubprocessEnv({ env, engine: "codex" }).env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(filterSubprocessEnv({ env, engine: "opencode" }).env.ANTHROPIC_API_KEY).toBeUndefined();
    const allowed = { ...env, CLAUDE_AUTH: "subscription", TYBO_SUBPROCESS_ENV_ALLOW: "ANTHROPIC_API_KEY" };
    expect(filterSubprocessEnv({ env: allowed, engine: "codex" }).env.ANTHROPIC_API_KEY).toBe(KEY);
  });
});

// ---------------------------------------------------------------------------
// Spawn-Attrappen: JSON, Streaming, Text
// ---------------------------------------------------------------------------

const RESULT = { type: "result", subtype: "success", is_error: false, result: "fertig", session_id: "s1" };

let spawned: Record<string, string>[] = [];

/** Prozess-Attrappe, die sofort die Ausgabe liefert und endet */
function fakeProcess(output: string) {
  const enc = new TextEncoder();
  return {
    pid: 0,
    stdin: { write() {}, end() {} },
    stdout: new ReadableStream<Uint8Array>({
      start: c => {
        c.enqueue(enc.encode(output));
        c.close();
      },
    }),
    stderr: new ReadableStream<Uint8Array>({ start: c => c.close() }),
    exited: Promise.resolve(0),
    kill() {},
  };
}

function installSpawn(): void {
  spawned = [];
  setSpawnForTests(((o: { cmd: string[]; env: Record<string, string> }) => {
    spawned.push(o.env);
    const streaming = o.cmd.includes("stream-json");
    const text = o.cmd[o.cmd.indexOf("--output-format") + 1] === "text";
    return fakeProcess(streaming ? JSON.stringify(RESULT) + "\n" : text ? "fertig" : JSON.stringify(RESULT));
  }) as any);
  setRuntimeForTests({ terminate: () => {} });
}

const WAYS: [string, () => Promise<unknown>][] = [
  ["JSON", () => callClaude({ prompt: "p", outputFormat: "json", cwd: "/tmp" })],
  ["Streaming", () => callClaudeStreaming({ prompt: "p", cwd: "/tmp" })],
];

describe("Spawn-Attrappen", () => {
  beforeEach(installSpawn);
  afterEach(() => {
    setSpawnForTests(null);
    setRuntimeForTests(null);
  });

  for (const [way, call] of WAYS) {
    test(`${way}: apiKey mit Schlüssel, Schlüssel im Kind`, async () => {
      useEnv({ CLAUDE_AUTH: "apiKey", ANTHROPIC_API_KEY: KEY });
      const r = (await call()) as { isError: boolean };
      expect(r.isError).toBe(false);
      expect(spawned).toHaveLength(1);
      expect(spawned[0]!.ANTHROPIC_API_KEY).toBe(KEY);
      expectEnvUnchanged();
    });

    test(`${way}: subscription trotz Schlüssel, auch mit Freigabeliste und MCP-Verweis, kein Schlüssel im Kind`, async () => {
      for (const extra of [{}, { TYBO_SUBPROCESS_ENV_ALLOW: "ANTHROPIC_API_KEY" }]) {
        for (const mcp of [new Set<string>(), new Set(["ANTHROPIC_API_KEY"])]) {
          spawned = [];
          mcpVars = mcp;
          useEnv({ CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: KEY, ...extra });
          await call();
          expect(spawned).toHaveLength(1);
          expect("ANTHROPIC_API_KEY" in spawned[0]!).toBe(false);
          expect(Object.values(spawned[0]!)).not.toContain(KEY);
          expectEnvUnchanged();
        }
      }
    });

    test(`${way}: apiKey ohne Schlüssel, kein Spawn, Fehlermeldung`, async () => {
      useEnv({ CLAUDE_AUTH: "apiKey" });
      const r = await call();
      expect(spawned).toHaveLength(0);
      expect(r).toEqual({ text: CLAUDE_API_KEY_MISSING, isError: true });
      expectEnvUnchanged();
    });

    test(`${way}: ohne Option mit Schlüssel (Schlüssel im Kind) und ohne (keiner)`, async () => {
      useEnv({ ANTHROPIC_API_KEY: KEY });
      await call();
      expect(spawned[0]!.ANTHROPIC_API_KEY).toBe(KEY);
      expectEnvUnchanged();
      delete process.env.ANTHROPIC_API_KEY;
      useEnv({});
      await call();
      expect("ANTHROPIC_API_KEY" in spawned[1]!).toBe(false);
      expectEnvUnchanged();
    });
  }

  test("runClaudeWithTimeout folgt derselben Anmeldung; apiKey ohne Schlüssel wirft ohne Spawn", async () => {
    useEnv({ CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: KEY });
    await runClaudeWithTimeout("p", 5_000, { cwd: "/tmp" });
    expect("ANTHROPIC_API_KEY" in spawned[0]!).toBe(false);
    process.env.CLAUDE_AUTH = "apiKey";
    before = { ...process.env };
    await runClaudeWithTimeout("p", 5_000, { cwd: "/tmp" });
    expect(spawned[1]!.ANTHROPIC_API_KEY).toBe(KEY);
    delete process.env.ANTHROPIC_API_KEY;
    before = { ...process.env };
    await expect(runClaudeWithTimeout("p", 5_000, { cwd: "/tmp" })).rejects.toThrow(CLAUDE_API_KEY_MISSING);
    expect(spawned).toHaveLength(2);
    expectEnvUnchanged();
  });

  test("Chat-Kern: fehlender Schlüssel ist ein reguläres Fehlerergebnis, der Fallback antwortet", async () => {
    useEnv({ CLAUDE_AUTH: "apiKey" });
    let fallbacks = 0;
    const deps: Partial<ChatTurnDeps> = {
      runFallbackChain: async () => {
        fallbacks++;
        return { text: "Antwort vom Ersatzmodell", source: "openrouter" } as any;
      },
      buildPromptContext: async () => ({ fullPrompt: "prompt", fallbackContext: "" }),
      buildResumePrompt: async () => "resume",
      isSessionModeEnabled: () => false,
      getResumableSession: async () => undefined,
      takeExpiredSession: async () => undefined,
      recordSessionTurn: async () => true,
      resetSession: async () => 0,
      shouldDistill: () => false,
      distillSession: async () => {},
      log: async () => {},
      getAgentConfig: () => ({ model: "m" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
      getSettings: () => ({}),
      resolveStreamingLimits: () => resolveStreamingLimits({}),
      reportSecrets: () => [],
    };
    const reply = await runExecution("dm:349", "general", () =>
      runStreamingTurn({ userMessage: "x", chatId: "349", agentName: "general", sink: { progress() {}, notice() {} }, deps })
    );
    expect(spawned).toHaveLength(0);
    expect(fallbacks).toBe(1);
    expect(JSON.stringify(reply)).toContain("Antwort vom Ersatzmodell");
    expectEnvUnchanged();
  });
});
