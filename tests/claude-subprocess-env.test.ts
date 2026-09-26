/**
 * Issue #46, Aufgabe 5: Claude-Subprozesse bekommen das Gespräch des
 * laufenden Aufrufs als TYBO_CHAT_ID/TYBO_TOPIC_ID (seit Issue #141 nur unter
 * diesen Namen). Geprüft wird die
 * Umgebung, die tatsächlich an den Prozessstart geht; der Start ist eine
 * Attrappe (setSpawnForTests), es läuft kein echtes claude.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { callClaude, callClaudeStreaming, conversationEnv, runClaudeWithTimeout, setSpawnForTests } from "../src/lib/claude";
import { runExecution } from "../src/lib/execution-context";
import { CONVERSATION_VARS, setMcpReaderForTests } from "../src/lib/subprocess-env";

type Env = Record<string, string | undefined>;
const spawned: { cmd: string[]; env: Env }[] = [];

function stream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

const RESULT_LINE = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "fertig", session_id: "s1" }) + "\n";

function fakeSpawn(options: { cmd: string[]; env: Env }) {
  spawned.push({ cmd: options.cmd, env: { ...options.env } });
  const streaming = options.cmd.includes("stream-json");
  return {
    pid: 0,
    stdin: { write() {}, end() {} },
    stdout: stream(streaming ? RESULT_LINE : "fertig"),
    stderr: stream(""),
    exited: Promise.resolve(0),
    kill() {},
  };
}

const saved: Env = {};
beforeAll(() => {
  // Nie die echte ~/.claude.json lesen (Issue #54)
  setMcpReaderForTests(() => new Set());
  setSpawnForTests(fakeSpawn as any);
  for (const k of CONVERSATION_VARS) saved[k] = process.env[k];
});
afterEach(() => {
  spawned.length = 0;
  for (const k of CONVERSATION_VARS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
afterAll(() => {
  setSpawnForTests(null);
  setMcpReaderForTests(null);
});

const CALLS: [string, () => Promise<unknown>][] = [
  ["callClaude", () => callClaude({ prompt: "hallo" })],
  ["callClaudeStreaming", () => callClaudeStreaming({ prompt: "hallo" })],
  ["runClaudeWithTimeout", () => runClaudeWithTimeout("hallo", 10_000)],
];

/** Führt den Aufruf im Kontext des Schlüssels aus (ohne Schlüssel: kein Kontext) und liefert die Umgebung */
async function envFor(key: string | null, call: () => Promise<unknown>): Promise<Env> {
  if (key === null) await call();
  else await runExecution(key, "general", call);
  expect(spawned).toHaveLength(1);
  const env = spawned[0].env;
  spawned.length = 0;
  return env;
}

const CASES: [string, string | null, Env][] = [
  ["Direktchat", "dm:4711", { TYBO_CHAT_ID: "4711", TYBO_TOPIC_ID: undefined }],
  ["Topic", "topic:-1001234567890:443", { TYBO_CHAT_ID: "-1001234567890", TYBO_TOPIC_ID: "443" }],
  ["General", "group:-1001234567890", { TYBO_CHAT_ID: "-1001234567890", TYBO_TOPIC_ID: undefined }],
  ["web:", "web:3f2a", { TYBO_CHAT_ID: undefined, TYBO_TOPIC_ID: undefined }],
  ["background", "background", { TYBO_CHAT_ID: undefined, TYBO_TOPIC_ID: undefined }],
  ["unbekanntes Format", "whatsapp:4711", { TYBO_CHAT_ID: undefined, TYBO_TOPIC_ID: undefined }],
  ["ohne Kontext", null, { TYBO_CHAT_ID: undefined, TYBO_TOPIC_ID: undefined }],
];

for (const [name, call] of CALLS) {
  describe(name, () => {
    for (const [label, key, expected] of CASES) {
      test(`${label}: tatsächliche Subprozess-Umgebung`, async () => {
        const env = await envFor(key, call);
        expect(env.TYBO_CHAT_ID).toBe(expected.TYBO_CHAT_ID);
        expect(env.TYBO_TOPIC_ID).toBe(expected.TYBO_TOPIC_ID);
        expect(env.TYBO_SUBPROCESS).toBe("1");
      });
    }

    test("vererbte Werte werden entfernt oder ersetzt, process.env bleibt unverändert", async () => {
      process.env.TYBO_CHAT_ID = "-100888";
      process.env.TYBO_TOPIC_ID = "66";
      const none = await envFor(null, call);
      const web = await envFor("web:abc", call);
      for (const name of CONVERSATION_VARS) {
        expect(none[name]).toBeUndefined();
        expect(web[name]).toBeUndefined();
      }
      const dm = await envFor("dm:4711", call);
      expect(dm.TYBO_CHAT_ID).toBe("4711");
      expect(dm.TYBO_TOPIC_ID).toBeUndefined();
      expect(process.env.TYBO_CHAT_ID).toBe("-100888");
      expect(process.env.TYBO_TOPIC_ID).toBe("66");
    });
  });
}

test("parallele Gespräche bekommen jeweils ihr eigenes Ziel", async () => {
  await Promise.all([
    runExecution("dm:4711", "general", () => callClaude({ prompt: "a" })),
    runExecution("topic:-1001:5", "research", () => callClaude({ prompt: "b" })),
  ]);
  const current = spawned.map(s => `${s.env.TYBO_CHAT_ID}/${s.env.TYBO_TOPIC_ID}`).sort();
  expect(current).toEqual(["-1001/5", "4711/undefined"]);
});

test("Argumente des Aufrufs bleiben unverändert", async () => {
  await runExecution("dm:4711", "general", () => callClaude({ prompt: "x", model: "claude-test", effort: "low" }));
  const cmd = spawned[0].cmd;
  expect(cmd.slice(cmd.indexOf("-p"))).toEqual(["-p", "--output-format", "text", "--model", "claude-test", "--effort", "low"]);
});

describe("conversationEnv", () => {
  test("Formate", () => {
    expect(conversationEnv("dm:4711")).toEqual({ TYBO_CHAT_ID: "4711" });
    expect(conversationEnv("group:-100123")).toEqual({ TYBO_CHAT_ID: "-100123" });
    expect(conversationEnv("topic:-100123:9")).toEqual({
      TYBO_CHAT_ID: "-100123", TYBO_TOPIC_ID: "9",
    });
    for (const key of [undefined, "", "web:1", "background", "dm:abc", "group:123", "topic:-1:0", "topic:-1:x", "dm:1:2"]) {
      expect(conversationEnv(key)).toEqual({});
    }
  });
});
