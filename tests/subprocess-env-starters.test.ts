/**
 * Issue #54, Aufgabe 2: Jeder Starter eines Claude-Subprozesses gibt nur die
 * gefilterte Umgebung weiter. Der Start ist jeweils eine Attrappe
 * (setSpawnForTests für die CLI, setQueryForTests für das Agent SDK), es
 * läuft kein echtes claude. Für den SDK-Start mit Bun läuft über das echte
 * SDK ein harmloses Ersatzskript statt claude. Die MCP-Konfiguration liegt in
 * einem temporären HOME bzw. Projekt, nie in der echten ~/.claude.json.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { callClaude, callClaudeStreaming, runClaudeWithTimeout, setSpawnForTests } from "../src/lib/claude";
import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import { processWithAgentSDK, sdkEnv, sdkProcessOptions, setQueryForTests } from "../src/lib/agent-session";
import { mcpReferencedVars, setMcpReaderForTests } from "../src/lib/subprocess-env";
import { runExecution } from "../src/lib/execution-context";
import { useFakeSupabase } from "./supabase-fixture";

type Env = Record<string, string | undefined>;

const SECRETS: Env = {
  TELEGRAM_BOT_TOKEN: "123:geheim-telegram",
  SUPABASE_SERVICE_ROLE_KEY: "geheim-supabase",
  WEB_PASSWORD: "geheim-web",
  OPENROUTER_API_KEY: "geheim-openrouter",
  MCP_NOTION_TOKEN: "notion-wert",
  ALLOWED_API_KEY: "freigegeben-wert",
  TYBO_SUBPROCESS_ENV_ALLOW: "ALLOWED_API_KEY",
  CLAUDECODE: "1",
};

/** Freigabelisten, die Bun aus der lokalen .env lädt oder der Bot vererbt */
const AMBIENT_ALLOW = ["TYBO_SUBPROCESS_ENV_ALLOW"];

const tmp = mkdtempSync(join(tmpdir(), "tybo-subenv-starters-"));
const project = join(tmp, "projekt");
const saved: Env = {};

beforeAll(() => {
  // MCP-Referenz im temporären Projekt; gelesen über den echten Leser, aber
  // mit festem HOME/cwd aus dem Temp-Verzeichnis
  Bun.spawnSync(["mkdir", "-p", project]);
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { notion: { env: { T: "${MCP_NOTION_TOKEN}" } } } }));
  setMcpReaderForTests(() => mcpReferencedVars(project, tmp));
  for (const k of [...Object.keys(SECRETS), ...AMBIENT_ALLOW, "ANTHROPIC_API_KEY", "BUDGET_DB_PATH", "DAILY_API_BUDGET", "HOME"]) saved[k] = process.env[k];
  // Freigabelisten aus der lokalen .env oder dem Bot-Prozess dürfen nicht mitspielen
  for (const k of AMBIENT_ALLOW) delete process.env[k];
  Object.assign(process.env, SECRETS);
  process.env.BUDGET_DB_PATH = join(tmp, "budget.sqlite");
  process.env.DAILY_API_BUDGET = "5";
});
afterAll(() => {
  setMcpReaderForTests(null);
  setSpawnForTests(null);
  setQueryForTests(null);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function expectFiltered(env: Env): void {
  expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
  expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
  expect(env.WEB_PASSWORD).toBeUndefined();
  expect(env.OPENROUTER_API_KEY).toBeUndefined();
  expect(env.CLAUDECODE).toBeUndefined();
  expect(env.PATH).toBeTruthy();
  expect(env.HOME).toBeTruthy();
  expect(env.TYBO_SUBPROCESS).toBe("1");
  expect(env.MCP_NOTION_TOKEN).toBe("notion-wert");
  expect(env.ALLOWED_API_KEY).toBe("freigegeben-wert");
  expect(Object.values(env).some(v => v?.startsWith("geheim-"))).toBe(false);
}

// ---------------------------------------------------------------------------
// CLI-Starter
// ---------------------------------------------------------------------------

describe("CLI-Starter", () => {
  const spawned: Env[] = [];
  function stream(text: string): ReadableStream<Uint8Array> {
    return new ReadableStream({ start(c) { if (text) c.enqueue(new TextEncoder().encode(text)); c.close(); } });
  }
  const RESULT = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "fertig", session_id: "s1" }) + "\n";
  beforeEach(() => {
    spawned.length = 0;
    setSpawnForTests(((o: { cmd: string[]; env: Env }) => {
      spawned.push({ ...o.env });
      return {
        pid: 0, stdin: { write() {}, end() {} },
        stdout: stream(o.cmd.includes("stream-json") ? RESULT : "fertig"),
        stderr: stream(""), exited: Promise.resolve(0), kill() {},
      };
    }) as any);
  });
  afterEach(() => setSpawnForTests(null));

  const CALLS: [string, () => Promise<unknown>][] = [
    ["callClaude", () => callClaude({ prompt: "hallo", cwd: project })],
    ["callClaudeStreaming", () => callClaudeStreaming({ prompt: "hallo", cwd: project })],
    ["runClaudeWithTimeout", () => runClaudeWithTimeout("hallo", 10_000, { cwd: project })],
  ];
  for (const [name, call] of CALLS) {
    test(`${name}: gefilterte Umgebung, Gesprächsziel gesetzt`, async () => {
      await runExecution("topic:-1001:5", "general", call);
      expect(spawned).toHaveLength(1);
      expectFiltered(spawned[0]);
      expect(spawned[0].TYBO_CHAT_ID).toBe("-1001");
      expect(spawned[0].TYBO_TOPIC_ID).toBe("5");
    });
  }

  test("ANTHROPIC_API_KEY bleibt für callClaude und callClaudeStreaming", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    try {
      await callClaude({ prompt: "x", cwd: project });
      await callClaudeStreaming({ prompt: "x", cwd: project });
      expect(spawned.map(e => e.ANTHROPIC_API_KEY)).toEqual(["sk-ant-test", "sk-ant-test"]);
    } finally {
      if (saved.ANTHROPIC_API_KEY === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = saved.ANTHROPIC_API_KEY;
    }
  });
});

// ---------------------------------------------------------------------------
// Agent SDK
// ---------------------------------------------------------------------------

describe("Agent SDK", () => {
  test("sdkEnv ohne OpenRouter: gefiltert, ANTHROPIC_API_KEY explizit", () => {
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    try {
      const env = sdkEnv(false, project);
      expectFiltered(env);
      expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
      expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  test("sdkEnv mit OpenRouter-Fallback: Schlüssel nur als ANTHROPIC_AUTH_TOKEN", () => {
    const env = sdkEnv(true, project);
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("geheim-openrouter");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://openrouter.ai/api");
    expect(env.ANTHROPIC_API_KEY).toBe("");
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.TYBO_SUBPROCESS).toBe("1");
  });

  test("processWithAgentSDK übergibt die gefilterte Umgebung an query()", async () => {
    const supabase = useFakeSupabase();
    const seen: Env[] = [];
    setQueryForTests(((args: { options: { env: Env } }) => {
      seen.push({ ...args.options.env });
      return (async function* () {})();
    }) as any);
    try {
      const ctx = { chat: { id: 4711 }, msg: { message_thread_id: undefined }, message: {}, reply: async () => ({}) } as any;
      await processWithAgentSDK("hallo", "4711", ctx);
    } finally {
      setQueryForTests(null);
      supabase.restore();
    }
    expect(seen).toHaveLength(1);
    const env = seen[0];
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.WEB_PASSWORD).toBeUndefined();
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(env.TYBO_SUBPROCESS).toBe("1");
    expect(env.TYBO_CHAT_ID).toBe("4711");
    expect(env.PATH).toBeTruthy();
    expect(env.HOME).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Agent SDK: echter Start mit Bun, .env im Projekt
// ---------------------------------------------------------------------------

describe("Agent SDK: Bun lädt die .env nicht nach", () => {
  const home = join(tmp, "home");
  const fake = join(tmp, "fake-claude.ts");
  const dump = join(tmp, "env-dump.json");

  beforeAll(() => {
    // Synthetische .env im Projekt mit den vier gesperrten Variablen
    writeFileSync(join(project, ".env"), [
      "TELEGRAM_BOT_TOKEN=aus-dotenv-telegram",
      "SUPABASE_SERVICE_ROLE_KEY=aus-dotenv-supabase",
      "WEB_PASSWORD=aus-dotenv-web",
      "OPENROUTER_API_KEY=aus-dotenv-openrouter",
      "",
    ].join("\n"));
    // Ersatz für claude: schreibt nur seine Umgebung weg und endet
    writeFileSync(fake, `require("fs").writeFileSync(${JSON.stringify(dump)}, JSON.stringify(process.env)); process.exit(0);\n`);
    // Temporäres HOME; sdkEnv setzt PATH auf <HOME>/.bun/bin, dort liegt das laufende bun
    mkdirSync(join(home, ".bun", "bin"), { recursive: true });
    symlinkSync(process.execPath, join(home, ".bun", "bin", "bun"));
  });

  async function startSdk(override?: { executableArgs: string[] }): Promise<Env> {
    rmSync(dump, { force: true });
    const before = process.env.HOME;
    process.env.HOME = home;
    try {
      const options = { ...sdkProcessOptions(false, project), ...override };
      const q = sdkQuery({ prompt: "hallo", options: { ...options, pathToClaudeCodeExecutable: fake, stderr: () => {} } });
      try {
        for await (const _ of q) { /* Ersatzprozess liefert nichts */ }
      } catch {
        // Ersatzprozess endet ohne Protokoll, das SDK meldet einen Fehler
      }
    } finally {
      process.env.HOME = before;
    }
    expect(existsSync(dump)).toBe(true);
    return JSON.parse(readFileSync(dump, "utf-8"));
  }

  test("sdkProcessOptions startet bun mit --no-env-file", () => {
    const o = sdkProcessOptions(false, project);
    expect(o.executable).toBe("bun");
    expect(o.executableArgs).toContain("--no-env-file");
    expect(o.cwd).toBe(project);
  });

  test("im gestarteten Prozess fehlen die gesperrten Variablen, Freigaben bleiben", async () => {
    const env = await startSdk();
    expect(env.TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(env.SUPABASE_SERVICE_ROLE_KEY).toBeUndefined();
    expect(env.WEB_PASSWORD).toBeUndefined();
    expect(env.OPENROUTER_API_KEY).toBeUndefined();
    expect(Object.values(env).some(v => v?.startsWith("aus-dotenv-") || v?.startsWith("geheim-"))).toBe(false);
    expect(env.MCP_NOTION_TOKEN).toBe("notion-wert");
    expect(env.ALLOWED_API_KEY).toBe("freigegeben-wert");
    expect(env.TYBO_SUBPROCESS).toBe("1");
  }, 30_000);

  test("Gegenprobe: ohne --no-env-file holt Bun die Werte aus der .env", async () => {
    const env = await startSdk({ executableArgs: [] });
    expect(env.TELEGRAM_BOT_TOKEN).toBe("aus-dotenv-telegram");
  }, 30_000);
});
