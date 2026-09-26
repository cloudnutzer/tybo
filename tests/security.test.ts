import { afterEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { createProcessHandler } from "../src/lib/process-handler";
import { verifyElevenLabs } from "../src/lib/http-security";
import { shellSecurityHook } from "../src/lib/sdk-security";
import { registerBuiltinTool, setToolApprovalHandler, callBuiltinTool } from "../src/lib/tools/registry";
import { requireOwner } from "../convex/auth";
import { addFact } from "../convex/memory";
import { computeNextFireTime, fire } from "../convex/scheduledTasks";
import { runExecution, abortExecutions, checkAborted } from "../src/lib/execution-context";

describe("gateway boundary", () => {
  test("fails closed; validates chat, body, and bounded admission", async () => {
    let secret = "";
    let calls = 0;
    let release!: () => void;
    const wait = new Promise<void>(r => { release = r; });
    const handler = createProcessHandler({ secret: () => secret, allowChat: id => id === "7", capacity: 1,
      process: async () => { calls++; await wait; } });
    const request = (body: unknown, auth = "Bearer test") => new Request("http://localhost/process", {
      method: "POST", headers: { authorization: auth }, body: JSON.stringify(body),
    });
    const message = { text: "hello", chatId: "7" };
    expect((await handler(request(message))).status).toBe(503);
    secret = "test";
    expect((await handler(request(message, ""))).status).toBe(401);
    expect((await handler(request({ ...message, chatId: "8" }))).status).toBe(403);
    expect((await handler(request({ ...message, threadId: -1 }))).status).toBe(400);
    expect((await handler(request({ ...message, text: "x".repeat(70_000) }))).status).toBe(413);
    expect(calls).toBe(0);
    expect((await handler(request(message))).status).toBe(202);
    expect((await handler(request(message))).status).toBe(429);
    expect(calls).toBe(1);
    release();
  });
  test("signature binds raw body and timestamp", () => {
    const now = 1_800_000_000_000;
    const body = '{"conversation_id":"test"}';
    const t = String(now / 1000);
    const h = createHmac("sha256", "secret").update(`${t}.${body}`).digest("hex");
    expect(verifyElevenLabs(body, `t=${t},v0=${h}`, "secret", now)).toBe(true);
    expect(verifyElevenLabs(body + " ", `t=${t},v0=${h}`, "secret", now)).toBe(false);
    expect(verifyElevenLabs(body, `t=${t},v0=${h}`, "secret", now + 301_000)).toBe(false);
    expect(verifyElevenLabs(body, null, "", now)).toBe(false);
  });
});

test("public Convex mutation rejects before touching the database", async () => {
  let writes = 0;
  const ctx = { auth: { getUserIdentity: async () => null }, db: { insert: async () => { writes++; } } };
  await expect((addFact as any)._handler(ctx, { content: "private" })).rejects.toThrow("Unauthorized");
  expect(writes).toBe(0);
  const previous = process.env.CONVEX_OWNER_TOKEN_IDENTIFIER;
  process.env.CONVEX_OWNER_TOKEN_IDENTIFIER = "issuer|owner";
  try {
    await requireOwner({ auth: { getUserIdentity: async () => ({ tokenIdentifier: "issuer|owner" }) } } as any);
    await expect(requireOwner({ auth: { getUserIdentity: async () => ({ tokenIdentifier: "issuer|guest" }) } } as any)).rejects.toThrow();
  } finally {
    if (previous === undefined) delete process.env.CONVEX_OWNER_TOKEN_IDENTIFIER;
    else process.env.CONVEX_OWNER_TOKEN_IDENTIFIER = previous;
  }
});

test("SDK shell hook reads the actual SDK event", async () => {
  const event = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "mkfs /dev/dummy" },
    session_id: "test", transcript_path: "/tmp/test", cwd: "/tmp", tool_use_id: "test" } as const;
  const result = await shellSecurityHook(event, "test", { signal: new AbortController().signal });
  expect((result as any).hookSpecificOutput.permissionDecision).toBe("deny");
});

test("write approval denial prevents the handler even with old bypass flag", async () => {
  let calls = 0;
  const previous = process.env.FALLBACK_ALLOW_WRITE_TOOLS;
  process.env.FALLBACK_ALLOW_WRITE_TOOLS = "true";
  registerBuiltinTool({ name: "security_test_write", description: "test", inputSchema: { type: "object", properties: {} },
    requiresApproval: true, isAvailable: () => true, handler: async () => { calls++; return "unexpected"; } });
  setToolApprovalHandler(async () => false);
  try {
    expect((await callBuiltinTool("security_test_write", {})).isError).toBe(true);
    expect(calls).toBe(0);
  } finally {
    if (previous === undefined) delete process.env.FALLBACK_ALLOW_WRITE_TOOLS;
    else process.env.FALLBACK_ALLOW_WRITE_TOOLS = previous;
  }
});

test("same session is FIFO and stop cancels active and queued work", async () => {
  const order: string[] = [];
  let release!: () => void;
  let entered!: () => void;
  const started = new Promise<void>(r => { entered = r; });
  const first = runExecution("test-stop", "general", async () => {
    order.push("first"); entered();
    await new Promise<void>(r => { release = r; });
    checkAborted(); order.push("external write");
  });
  const second = runExecution("test-stop", "general", async () => { order.push("second"); });
  // Attach handlers before aborting to avoid unhandled rejections.
  const done = Promise.allSettled([first, second]);
  await started;
  expect(abortExecutions("test-stop")).toBe(2);
  release();
  expect((await done).map(x => x.status)).toEqual(["rejected", "rejected"]);
  expect(order).toEqual(["first"]);
});

test("recurrence validation terminates and skips missed intervals arithmetically", () => {
  expect(computeNextFireTime(0, "every 0h", 1000)).toBeNull();
  expect(computeNextFireTime(0, "every 0m", 1000)).toBeNull();
  expect(computeNextFireTime(0, "garbage every 1h", 1000)).toBeNull();
  expect(computeNextFireTime(0, "every 1m", 1_800_000_000_000)).toBe(1_800_000_060_000);
});

test("failed reminder delivery schedules retry without marking fired", async () => {
  const originalFetch = globalThis.fetch;
  const token = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = "synthetic";
  globalThis.fetch = Object.assign(async () => Response.json({ ok: false }, { status: 503 }), { preconnect: originalFetch.preconnect }) as typeof fetch;
  const mutations: any[] = [];
  try {
    await (fire as any)._handler({ runMutation: async (ref: unknown, args: any) => {
      mutations.push(args);
      if (mutations.length === 1) return { chatId: "7", prompt: "test", type: "reminder", attempts: 1 };
    } }, { taskId: "synthetic-task" });
    expect(mutations).toHaveLength(2);
    expect(mutations[1].error).toContain("503");
  } finally {
    globalThis.fetch = originalFetch;
    if (token === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = token;
  }
});
