/**
 * Issue #54, Aufgabe 2: Jeder Starter eines Claude-Subprozesses gibt nur die
 * gefilterte Umgebung weiter. Der Start ist jeweils eine Attrappe
 * (setSpawnForTests für die CLI), es läuft kein echtes claude. Das Agent SDK
 * gibt es seit Issue #352 nicht mehr. Die MCP-Konfiguration liegt in einem
 * temporären HOME bzw. Projekt, nie in der echten ~/.claude.json.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { callClaude, callClaudeStreaming, runClaudeWithTimeout, setSpawnForTests } from "../src/lib/claude";
import { mcpReferencedVars, setMcpReaderForTests } from "../src/lib/subprocess-env";
import { runExecution } from "../src/lib/execution-context";
import { useFakeSupabase } from "./supabase-fixture";
import { snapshotEnv } from "./env-snapshot";

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
/** Stellt die Umgebung von vor dieser Datei wieder her (#332: spätere Dateien sehen sonst alles) */
let restoreEnv: () => void = () => {};

beforeAll(() => {
  // MCP-Referenz im temporären Projekt; gelesen über den echten Leser, aber
  // mit festem HOME/cwd aus dem Temp-Verzeichnis
  Bun.spawnSync(["mkdir", "-p", project]);
  writeFileSync(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { notion: { env: { T: "${MCP_NOTION_TOKEN}" } } } }));
  setMcpReaderForTests(() => mcpReferencedVars(project, tmp));
  restoreEnv = snapshotEnv();
  // Freigabelisten aus der lokalen .env oder dem Bot-Prozess dürfen nicht mitspielen
  for (const k of AMBIENT_ALLOW) delete process.env[k];
  Object.assign(process.env, SECRETS);
  process.env.BUDGET_DB_PATH = join(tmp, "budget.sqlite");
  process.env.DAILY_API_BUDGET = "5";
});
afterAll(() => {
  setMcpReaderForTests(null);
  setSpawnForTests(null);
  restoreEnv();
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
    const restore = snapshotEnv();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";
    try {
      await callClaude({ prompt: "x", cwd: project });
      await callClaudeStreaming({ prompt: "x", cwd: project });
      expect(spawned.map(e => e.ANTHROPIC_API_KEY)).toEqual(["sk-ant-test", "sk-ant-test"]);
    } finally {
      restore();
    }
  });
});
