/**
 * Motor-Vertrag (tests/engine-contract.ts) für OpenCode (Issue #127). Prozess
 * und Signale sind Attrappen (tests/opencode-fixture.ts, pid 0, Signale nur
 * gezählt, `opencode --version` antwortet mit 1.18.33); die Timer sind echt,
 * weil der Vertrag mit kurzen echten Zeitgrenzen arbeitet. Beenden heißt hier:
 * SIGINT schließt stdout, Exit 1.
 */
import { afterAll, beforeAll } from "bun:test";
import { createOpenCodeEngine } from "../src/lib/engines";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { runEngineContract } from "./engine-contract";
import { installOpenCodeFake, oc, type OpenCodeFake } from "./opencode-fixture";

let fake: OpenCodeFake | null = null;

beforeAll(() => setMcpReaderForTests(() => new Set()));
afterAll(() => setMcpReaderForTests(null));

/** Werkzeug des Vertrags (Claude-Name) als OpenCode-Werkzeug */
function toolEvent(sessionId: string, tool: string): object {
  if (tool === "WebSearch") return oc.tool(sessionId, "call-1", "websearch", { query: "tybo" });
  throw new Error(`Werkzeug ${tool} hat in der OpenCode-Attrappe keine Entsprechung`);
}

runEngineContract({
  id: "opencode",
  engine: () => createOpenCodeEngine(),
  setup() {
    fake = installOpenCodeFake({ realTimers: true });
  },
  teardown() {
    fake?.restore();
    fake = null;
  },
  reply: ({ text, sessionId, tool }) =>
    fake!.next({
      events: [
        ...(tool ? [oc.stepStart(sessionId), toolEvent(sessionId, tool), oc.stepFinish(sessionId)] : []),
        ...oc.reply(sessionId, text),
      ],
    }),
  fail: ({ sessionId }) =>
    fake!.next({
      events: [oc.stepStart(sessionId), oc.error(sessionId, "APIError", { message: "Too Many Requests", statusCode: 429, isRetryable: true })],
      exitCode: 1,
    }),
  hang: (o) => fake!.next({ events: o?.sessionId ? [oc.stepStart(o.sessionId)] : [], hang: true }),
  lastResumeSessionId() {
    const cmd = fake!.runCommand();
    const i = cmd.indexOf("--session");
    return i >= 0 ? cmd[i + 1] : undefined;
  },
  terminations: () => fake!.signals.filter((s) => s === "SIGINT").length,
});
