/**
 * Issue #53, Schritt 1: Werkzeugliste pro Turn. Der Claude-Prozess ist eine
 * Attrappe (setSpawnForTests); callClaude, callClaudeStreaming und der
 * Chat-Kern laufen echt.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { callClaude, callClaudeStreaming, setSpawnForTests } from "../src/lib/claude";
import { runJsonTurn, runStreamingTurn, type ChatTurnDeps } from "../src/lib/chat-turn";
import type { TurnTools } from "../src/lib/turn-tools";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";

/** Liefert die Ausgabe in den angegebenen Stücken (geteilte Zeilen möglich) */
function stream(chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
      controller.close();
    },
  });
}

let currentChunks: string[] = [];
let lastCmd: string[] = [];
beforeAll(() => {
  // Nie die echte ~/.claude.json lesen (Issue #54)
  setMcpReaderForTests(() => new Set());
  setSpawnForTests(((opts: { cmd: string[] }) => {
    lastCmd = opts.cmd;
    return {
      pid: 0,
      stdin: { write() {}, end() {} },
      stdout: stream(currentChunks),
      stderr: stream([]),
      exited: Promise.resolve(0),
      kill() {},
    };
  }) as any);
});
afterAll(() => {
  setSpawnForTests(null);
  setMcpReaderForTests(null);
});

const INIT = { type: "system", subtype: "init", session_id: "s1", cwd: "/projekt" };
const RESULT = { type: "result", subtype: "success", is_error: false, result: "fertig [REMEMBER: x]", session_id: "s1" };
function assistant(id: string, content: unknown[]) {
  return { type: "assistant", message: { id, content } };
}
const TOOL_EVENTS = [
  assistant("m1", [
    { type: "text", text: "Ich schaue nach." },
    { type: "tool_use", id: "t1", name: "WebFetch", input: { url: "https://example.com" } },
    { type: "tool_use", id: "t2", name: "Read", input: { file_path: "/etc/hosts" } },
  ]),
  { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] } },
  assistant("m2", [{ type: "tool_use", id: "t3", name: "Bash", input: { command: "curl https://x.y" } }]),
  assistant("m3", [{ type: "tool_use", id: "t4", name: "mcp__gmail__search", input: {} }]),
];

describe("callClaudeStreaming: Werkzeugliste", () => {
  test("mehrere schnelle Werkzeugaufrufe kommen alle an, obwohl onToolStart gedrosselt ist", async () => {
    currentChunks = [[INIT, ...TOOL_EVENTS, RESULT].map(e => JSON.stringify(e) + "\n").join("")];
    const shown: string[] = [];
    const r = await callClaudeStreaming({ prompt: "p", cwd: "/projekt", onToolStart: n => shown.push(n) });
    expect(shown.length).toBe(1);
    expect(r.tools?.uses.map(u => u.name)).toEqual(["WebFetch", "Read", "Bash", "mcp__gmail__search"]);
    expect(r.tools?.uses[1].path).toBe("/etc/hosts");
    expect(r.tools?.uses[2].command).toBe("curl https://x.y");
    expect(r.tools?.cwd).toBe("/projekt");
  });

  test("geteilte Stücke und letzte Zeile ohne Zeilenumbruch", async () => {
    const all = [INIT, ...TOOL_EVENTS, RESULT].map(e => JSON.stringify(e)).join("\n");
    // Stücke mitten in Zeilen, am Ende kein \n
    currentChunks = [];
    for (let i = 0; i < all.length; i += 37) currentChunks.push(all.slice(i, i + 37));
    const r = await callClaudeStreaming({ prompt: "p" });
    expect(r.tools?.uses.length).toBe(4);
    expect(r.text).toBe("fertig [REMEMBER: x]");
    expect(r.isError).toBe(false);
  });

  test("ohne Werkzeuge: bekannte leere Liste", async () => {
    currentChunks = [[INIT, assistant("m1", [{ type: "text", text: "Hallo" }]), RESULT].map(e => JSON.stringify(e) + "\n").join("")];
    const r = await callClaudeStreaming({ prompt: "p" });
    expect(r.tools).toEqual({ uses: [], cwd: process.cwd() });
  });
});

describe("callClaude json: Werkzeugliste", () => {
  test("json mit --verbose: Liste der Ereignisse, Werkzeuge aus den assistant-Ereignissen", async () => {
    currentChunks = [JSON.stringify([INIT, ...TOOL_EVENTS, RESULT])];
    const r = await callClaude({ prompt: "p", outputFormat: "json", cwd: "/projekt" });
    expect(lastCmd).toContain("--verbose");
    expect(r.text).toBe("fertig [REMEMBER: x]");
    expect(r.sessionId).toBe("s1");
    expect(r.isError).toBe(false);
    expect(r.tools?.uses.map(u => u.name)).toEqual(["WebFetch", "Read", "Bash", "mcp__gmail__search"]);
  });

  test("altes json-Format (ein Objekt): Werkzeuge unbekannt", async () => {
    currentChunks = [JSON.stringify(RESULT)];
    const r = await callClaude({ prompt: "p", outputFormat: "json" });
    expect(r.text).toBe("fertig [REMEMBER: x]");
    expect(r.tools).toBeUndefined();
  });

  test("leeres Ergebnis im Listenformat: kein Ereignis-Text als Antwort", async () => {
    currentChunks = [JSON.stringify([INIT, ...TOOL_EVENTS, { ...RESULT, result: "" }])];
    const r = await callClaude({ prompt: "p", outputFormat: "json" });
    expect(r.text).toBe("");
  });

  test("Liste ohne result-Ereignis gilt als Fehler", async () => {
    currentChunks = [JSON.stringify([INIT, ...TOOL_EVENTS])];
    const r = await callClaude({ prompt: "p", outputFormat: "json" });
    expect(r.isError).toBe(true);
  });

  test("Textformat: kein --verbose, Werkzeuge unbekannt", async () => {
    currentChunks = ["hallo"];
    const r = await callClaude({ prompt: "p", outputFormat: "text" });
    expect(lastCmd).not.toContain("--verbose");
    expect(r.tools).toBeUndefined();
  });
});

const DEPS: Partial<ChatTurnDeps> = {
  callClaudeStreaming,
  callClaude,
  callFallbackLLMWithSource: async () => ({ text: "fallback", source: "openrouter", model: "m" }),
  buildPromptContext: async () => ({ fullPrompt: "prompt", fallbackContext: "" }),
  buildResumePrompt: async () => "resume",
  isSessionModeEnabled: () => false,
  getResumableSession: async () => undefined,
  takeExpiredSession: async () => undefined,
  recordSessionTurn: async () => {},
  resetSession: async () => 0,
  shouldDistill: () => false,
  distillSession: async () => {},
  log: async () => {},
  getAgentConfig: () => ({ model: "test-model" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
  getSettings: () => ({}),
  setTimer: () => 0,
  clearTimer: () => {},
  now: () => 0,
};
const SINK = { progress() {}, notice() {} };

describe("Chat-Kern: onTools", () => {
  test("Streaming-Turn meldet die Werkzeuge", async () => {
    currentChunks = [[INIT, ...TOOL_EVENTS, RESULT].map(e => JSON.stringify(e) + "\n").join("")];
    let tools: TurnTools | undefined | "nie" = "nie";
    const text = await runStreamingTurn({
      userMessage: "u", chatId: "1", agentName: "general", sink: SINK, deps: DEPS,
      onTools: t => { tools = t; },
    });
    expect(text).toBe("fertig [REMEMBER: x]");
    expect((tools as unknown as TurnTools).uses.map(u => u.name)).toContain("WebFetch");
  });

  test("JSON-Turn meldet die Werkzeuge", async () => {
    currentChunks = [JSON.stringify([INIT, ...TOOL_EVENTS, RESULT])];
    let tools: TurnTools | undefined;
    await runJsonTurn({
      userMessage: "u", chatId: "1", agentName: "general", sink: SINK, deps: DEPS,
      onTools: t => { tools = t; },
    });
    expect(tools?.uses.length).toBe(4);
  });

  test("Fallback: Werkzeuge ausdrücklich unbekannt", async () => {
    currentChunks = [JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, result: "" })];
    let called = false;
    let tools: TurnTools | undefined = { uses: [] };
    const text = await runJsonTurn({
      userMessage: "u", chatId: "1", agentName: "general", sink: SINK, deps: DEPS,
      onTools: t => { called = true; tools = t; },
    });
    expect(text).toContain("fallback");
    expect(called).toBe(true);
    expect(tools).toBeUndefined();
  });
});
