#!/usr/bin/env bun
/**
 * Convex Connection Test
 *
 * Verifies that Convex is properly configured and all tables are accessible.
 * Usage: bun run setup/test-convex.ts
 */

import { BRAND } from "../src/brand";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readFile } from "fs/promises";
import { join, dirname } from "path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = dirname(import.meta.dir);

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");
const WARN = yellow("~");

async function loadEnv(): Promise<void> {
  const content = await readFile(join(PROJECT_ROOT, ".env"), "utf-8").catch(() => "");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Test definitions
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  status: "pass" | "fail" | "warn";
  detail?: string;
}

async function testConnection(convex: ConvexHttpClient): Promise<TestResult> {
  try {
    await convex.query(anyApi.messages.getRecent, { chatId: "__test__", limit: 1 });
    return { name: "Connection", status: "pass", detail: "Convex is reachable" };
  } catch (err: any) {
    return { name: "Connection", status: "fail", detail: err.message?.slice(0, 200) };
  }
}

async function testMessages(convex: ConvexHttpClient): Promise<TestResult> {
  const testChatId = `__test_${Date.now()}`;
  try {
    const insertedId = await convex.mutation(anyApi.messages.insert, {
      chatId: testChatId,
      role: "user",
      content: "Test message from setup/test-convex.ts",
      createdAt: Date.now(),
    });

    const messages = await convex.query(anyApi.messages.getRecent, {
      chatId: testChatId,
      limit: 1,
    });

    if (!messages || messages.length === 0) {
      return { name: "Messages", status: "fail", detail: "Insert succeeded but read returned empty" };
    }

    return { name: "Messages", status: "pass", detail: `Insert + Read OK (id: ${insertedId})` };
  } catch (err: any) {
    return { name: "Messages", status: "fail", detail: err.message?.slice(0, 200) };
  }
}

async function testMemory(convex: ConvexHttpClient): Promise<TestResult> {
  try {
    await convex.mutation(anyApi.memory.addFact, {
      content: `__test_fact_${Date.now()}`,
    });

    const facts = await convex.query(anyApi.memory.getFacts, {});
    if (!facts || facts.length === 0) {
      return { name: "Memory", status: "warn", detail: "Insert OK but getFacts returned empty" };
    }

    await convex.mutation(anyApi.memory.deleteFact, {
      searchText: "__test_fact_",
    });

    return { name: "Memory", status: "pass", detail: "addFact + getFacts + deleteFact OK" };
  } catch (err: any) {
    return { name: "Memory", status: "fail", detail: err.message?.slice(0, 200) };
  }
}

async function testLogs(convex: ConvexHttpClient): Promise<TestResult> {
  try {
    await convex.mutation(anyApi.logs.insert, {
      level: "info",
      event: "__test__",
      message: "Test log from setup/test-convex.ts",
    });
    return { name: "Logs", status: "pass", detail: "Insert OK" };
  } catch (err: any) {
    if (err.message?.includes("Could not find")) {
      return { name: "Logs", status: "warn", detail: "logs.insert not deployed yet" };
    }
    return { name: "Logs", status: "fail", detail: err.message?.slice(0, 200) };
  }
}

async function testCallTranscripts(convex: ConvexHttpClient): Promise<TestResult> {
  try {
    await convex.mutation(anyApi.callTranscripts.insert, {
      conversationId: `__test_${Date.now()}`,
    });
    return { name: "Call Transcripts", status: "pass", detail: "Insert OK" };
  } catch (err: any) {
    if (err.message?.includes("Could not find")) {
      return { name: "Call Transcripts", status: "warn", detail: "callTranscripts.insert not deployed yet" };
    }
    return { name: "Call Transcripts", status: "fail", detail: err.message?.slice(0, 200) };
  }
}

async function testAsyncTasks(convex: ConvexHttpClient): Promise<TestResult> {
  try {
    const id = await convex.mutation(anyApi.asyncTasks.create, {
      chatId: "__test__",
      originalPrompt: "Test task from setup/test-convex.ts",
    });

    const task = await convex.query(anyApi.asyncTasks.getById, { id });
    if (!task) {
      return { name: "Async Tasks", status: "warn", detail: "Create OK but getById returned null" };
    }

    return { name: "Async Tasks", status: "pass", detail: `Create + Read OK (id: ${id})` };
  } catch (err: any) {
    if (err.message?.includes("Could not find")) {
      return { name: "Async Tasks", status: "warn", detail: "asyncTasks.create not deployed yet" };
    }
    return { name: "Async Tasks", status: "fail", detail: err.message?.slice(0, 200) };
  }
}

async function testNodeHeartbeat(convex: ConvexHttpClient): Promise<TestResult> {
  try {
    await convex.mutation(anyApi.nodeHeartbeat.upsert, {
      nodeId: `__test_${Date.now()}`,
    });
    return { name: "Node Heartbeat", status: "pass", detail: "Upsert OK" };
  } catch (err: any) {
    if (err.message?.includes("Could not find")) {
      return { name: "Node Heartbeat", status: "warn", detail: "nodeHeartbeat.upsert not deployed yet" };
    }
    return { name: "Node Heartbeat", status: "fail", detail: err.message?.slice(0, 200) };
  }
}

async function testAssets(convex: ConvexHttpClient): Promise<TestResult> {
  try {
    // Test the getRecent query (can't test full upload without a file)
    const assets = await convex.query(anyApi.assets.getRecent, { limit: 1 });
    return { name: "Assets", status: "pass", detail: `Query OK (${assets.length} assets)` };
  } catch (err: any) {
    if (err.message?.includes("Could not find")) {
      return { name: "Assets", status: "warn", detail: "assets.getRecent not deployed yet" };
    }
    return { name: "Assets", status: "fail", detail: err.message?.slice(0, 200) };
  }
}

async function testKnowledge(convex: ConvexHttpClient): Promise<TestResult> {
  try {
    const id = await convex.mutation(anyApi.knowledge.add, {
      category: "reference",
      title: "__test__",
      content: "Test knowledge entry from setup/test-convex.ts",
      source: "test",
    });

    const results = await convex.query(anyApi.knowledge.search, {
      query: "__test__",
      limit: 1,
    });

    if (results && results.length > 0) {
      await convex.mutation(anyApi.knowledge.archive, { id });
    }

    return { name: "Knowledge", status: "pass", detail: `Add + Search + Archive OK (id: ${id})` };
  } catch (err: any) {
    if (err.message?.includes("Could not find")) {
      return { name: "Knowledge", status: "warn", detail: "knowledge.add not deployed yet" };
    }
    return { name: "Knowledge", status: "fail", detail: err.message?.slice(0, 200) };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log(bold(`  ${BRAND.name} - Convex Connection Test`));
  console.log(dim("  ================================"));

  await loadEnv();

  const convexUrl = process.env.CONVEX_URL;

  if (!convexUrl || convexUrl.includes("your_")) {
    console.log(`\n  ${FAIL} CONVEX_URL is not set in .env`);
    console.log(`    Run: npx convex dev`);
    process.exit(1);
  }

  console.log(`\n  ${PASS} URL: ${convexUrl}`);

  const convex = new ConvexHttpClient(convexUrl);
    if (!process.env.CONVEX_AUTH_TOKEN) throw new Error("CONVEX_AUTH_TOKEN required");
    convex.setAuth(process.env.CONVEX_AUTH_TOKEN);

  const tests = [
    testConnection,
    testMessages,
    testMemory,
    testLogs,
    testCallTranscripts,
    testAsyncTasks,
    testNodeHeartbeat,
    testAssets,
    testKnowledge,
  ];

  const results: TestResult[] = [];
  let testNum = 0;

  for (const testFn of tests) {
    testNum++;
    console.log(`\n${cyan(`  [${testNum}/${tests.length}] ${testFn.name.replace("test", "")}...`)}`);

    const result = await testFn(convex);
    results.push(result);

    const icon = result.status === "pass" ? PASS : result.status === "fail" ? FAIL : WARN;
    console.log(`  ${icon} ${result.name}: ${result.detail ?? ""}`);
  }

  const passed = results.filter((r) => r.status === "pass").length;
  const warned = results.filter((r) => r.status === "warn").length;
  const failed = results.filter((r) => r.status === "fail").length;

  console.log(`\n${bold("  Results:")}`);
  console.log(`  ${green(`${passed} passed`)}${warned ? `, ${yellow(`${warned} warnings`)}` : ""}${failed ? `, ${red(`${failed} failed`)}` : ""}`);

  if (failed > 0) {
    console.log(`\n  ${red("Some tests failed.")} Check that Convex functions are deployed:`);
    console.log(`    npx convex dev    ${dim("(development)")}`);
    console.log(`    npx convex deploy ${dim("(production)")}`);
  } else if (warned > 0) {
    console.log(`\n  ${yellow("Some functions not deployed yet.")} This is expected if you haven't run:`);
    console.log(`    npx convex dev`);
  } else {
    console.log(`\n  ${green("All tests passed!")} Convex is fully operational.`);
  }

  console.log("");
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(`\n  ${red("Fatal error:")} ${err.message}`);
  process.exit(1);
});
