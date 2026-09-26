/**
 * Issue #101 und #141: Starter außerhalb von claude.ts setzen Marker, Gespräch
 * und Job-ID nur unter TYBO_*. Hintergrund-Jobs bekommen nur ihr eigenes Ziel,
 * nie ein vererbtes. MCP-Leser ist eine Attrappe.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { jobClaudeEnv } from "../src/lib/jobs/default-deps";
import type { JobStatus } from "../src/lib/jobs/store";
import { SUBPROCESS_MARKER, setMcpReaderForTests } from "../src/lib/subprocess-env";

beforeAll(() => setMcpReaderForTests(() => new Set()));
afterAll(() => setMcpReaderForTests(null));

const root = join(import.meta.dir, "..");

function status(target: JobStatus["target"], id = "j-20260925-abc"): JobStatus {
  return {
    version: 1, id, title: "t", createdAt: "2026-09-25T00:00:00Z", phase: "running",
    maxHours: 1, model: "m", fullAccess: false, target,
  } as JobStatus;
}

const INHERITED = {
  PATH: "/usr/bin", HOME: "/tmp/kein-home",
  TYBO_CHAT_ID: "-100888", TYBO_TOPIC_ID: "66", TYBO_JOB_ID: "alt-neu",
};

/** Alle gesetzten Variablen mit Präfix TYBO_ */
function tyboVars(env: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith("TYBO_")));
}

describe("Hintergrund-Job", () => {
  test("Topic-Ziel, Job-ID und Marker, sonst keine TYBO_*-Variable", () => {
    const env = jobClaudeEnv(root, INHERITED, status({ chatId: "-1001", topicId: 5 }));
    expect(tyboVars(env)).toEqual({
      TYBO_SUBPROCESS: "1", TYBO_CHAT_ID: "-1001", TYBO_TOPIC_ID: "5", TYBO_JOB_ID: "j-20260925-abc",
    });
  });

  test("Direktchat-Ziel: kein vererbtes Gespräch", () => {
    const env = jobClaudeEnv(root, INHERITED, status({}));
    expect(env.TYBO_CHAT_ID).toBeUndefined();
    expect(env.TYBO_TOPIC_ID).toBeUndefined();
  });

  test("parallele Jobs behalten jeweils ihr Ziel", () => {
    const a = jobClaudeEnv(root, INHERITED, status({ topicId: 3 }, "j-a"));
    const b = jobClaudeEnv(root, INHERITED, status({ chatId: "4711" }, "j-b"));
    expect([a.TYBO_TOPIC_ID, a.TYBO_CHAT_ID, a.TYBO_JOB_ID]).toEqual(["3", undefined, "j-a"]);
    expect([b.TYBO_TOPIC_ID, b.TYBO_CHAT_ID, b.TYBO_JOB_ID]).toEqual([undefined, "4711", "j-b"]);
  });
});

test("Marker ist genau TYBO_SUBPROCESS=1", () => {
  expect(SUBPROCESS_MARKER).toEqual({ TYBO_SUBPROCESS: "1" });
});
