/**
 * Motor-Vertrag (tests/engine-contract.ts) für Claude Code. Der CLI-Prozess
 * ist eine Attrappe (setSpawnForTests), die Prozessbeendigung ebenfalls
 * (setRuntimeForTests): die Attrappe hat pid 0, ein echtes Signal an die
 * Prozessgruppe wäre gefährlich. Beenden schließt nur ihren stdout.
 */
import { setRuntimeForTests, setSpawnForTests } from "../src/lib/claude";
import { createClaudeEngine } from "../src/lib/engines";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { runEngineContract } from "./engine-contract";

type Script =
  | { kind: "reply"; text: string; sessionId: string; tool?: string }
  | { kind: "fail"; sessionId: string }
  | { kind: "hang"; sessionId?: string };

let next: Script | null = null;
let lastResume: string | undefined;
let terminated = 0;
const closers = new Map<object, () => void>();

function events(s: Script): object[] {
  if (s.kind === "hang") return s.sessionId ? [{ type: "system", subtype: "init", session_id: s.sessionId }] : [];
  const init = { type: "system", subtype: "init", session_id: s.sessionId };
  if (s.kind === "fail") {
    return [init, { type: "result", subtype: "error_during_execution", is_error: true, result: "", session_id: s.sessionId }];
  }
  const content: object[] = [];
  if (s.tool) content.push({ type: "tool_use", id: "toolu_1", name: s.tool, input: { query: "tybo" } });
  content.push({ type: "text", text: s.text });
  return [
    init,
    { type: "assistant", message: { id: "m1", content } },
    { type: "result", subtype: "success", is_error: false, result: s.text, session_id: s.sessionId, total_cost_usd: 0 },
  ];
}

function fakeSpawn(options: { cmd: string[] }) {
  const script = next;
  next = null;
  if (!script) throw new Error("unerwarteter Prozessstart");
  const cmd = options.cmd;
  const i = cmd.indexOf("--resume");
  lastResume = i >= 0 ? cmd[i + 1] : undefined;
  const streaming = cmd.includes("stream-json");
  const enc = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  const close = () => {
    if (closed) return;
    closed = true;
    controller.close();
  };
  const list = events(script);
  if (streaming) {
    for (const e of list) controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
  } else if (script.kind !== "hang") {
    // json mit --verbose: alle Ereignisse als Liste
    controller.enqueue(enc.encode(JSON.stringify(list)));
  }
  if (script.kind !== "hang") close();
  const proc = {
    pid: 0,
    stdin: { write() {}, end() {} },
    stdout,
    stderr: new ReadableStream({ start: (c) => c.close() }),
    exited: Promise.resolve(0),
    kill() {},
  };
  closers.set(proc, close);
  return proc;
}

runEngineContract({
  id: "claude",
  engine: () => createClaudeEngine(),
  setup() {
    next = null;
    lastResume = undefined;
    terminated = 0;
    closers.clear();
    setMcpReaderForTests(() => new Set());
    setSpawnForTests(fakeSpawn as any);
    setRuntimeForTests({
      terminate: (proc) => {
        terminated++;
        closers.get(proc)?.();
      },
    });
  },
  teardown() {
    setSpawnForTests(null);
    setRuntimeForTests(null);
    setMcpReaderForTests(null);
  },
  reply: (o) => void (next = { kind: "reply", ...o }),
  fail: (o) => void (next = { kind: "fail", ...o }),
  hang: (o) => void (next = { kind: "hang", ...o }),
  lastResumeSessionId: () => lastResume,
  terminations: () => terminated,
});
