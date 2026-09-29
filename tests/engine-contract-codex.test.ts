/**
 * Motor-Vertrag (tests/engine-contract.ts) für Codex (Issue #123). Prozess
 * und Signale sind Attrappen (tests/codex-fixture.ts, pid 0, Signale nur
 * gezählt); die Timer sind echt, weil der Vertrag mit kurzen echten
 * Zeitgrenzen arbeitet. Beenden heißt hier: SIGINT schließt stdout, Exit 1.
 */
import { afterAll, beforeAll } from "bun:test";
import { createCodexEngine } from "../src/lib/engines";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { ev, installCodexFake, type CodexFake } from "./codex-fixture";
import { runEngineContract } from "./engine-contract";

let fake: CodexFake | null = null;

beforeAll(() => setMcpReaderForTests(() => new Set()));
afterAll(() => setMcpReaderForTests(null));

function toolEvent(tool: string): object {
  if (tool === "WebSearch") return ev.webSearch("tool-1", "tybo");
  throw new Error(`Werkzeug ${tool} hat in der Codex-Attrappe keine Entsprechung`);
}

runEngineContract({
  id: "codex",
  engine: () => createCodexEngine(),
  setup() {
    fake = installCodexFake({ realTimers: true });
  },
  teardown() {
    fake?.restore();
    fake = null;
  },
  reply: ({ text, sessionId, tool }) =>
    fake!.next({ events: [ev.started(sessionId), ...(tool ? [toolEvent(tool)] : []), ev.message("msg-1", text), ev.completed()] }),
  fail: ({ sessionId }) => fake!.next({ events: [ev.started(sessionId), ev.failed("Quota exceeded. Check your plan and billing details.")], exitCode: 1 }),
  hang: (o) => fake!.next({ events: o?.sessionId ? [ev.started(o.sessionId)] : [], hang: true }),
  lastResumeSessionId() {
    const cmd = fake!.command();
    return cmd[2] === "resume" ? cmd.at(-2) : undefined;
  },
  terminations: () => fake!.signals.filter((s) => s === "SIGINT").length,
});
