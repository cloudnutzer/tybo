/**
 * Test Fallback LLM with MCP Tools — End-to-End
 *
 * Simulates what happens when Claude is rate-limited:
 * 1. MCPManager boots MCP servers
 * 2. Fallback LLM (OpenRouter/Ollama) gets called with MCP tools
 * 3. Model calls a tool → MCPManager executes → result fed back
 * 4. Model returns final response with real data
 *
 * Requires: OPENROUTER_API_KEY or Ollama running locally.
 *
 * Run: bun run setup/test-fallback-with-tools.ts
 */

import { join } from "path";
import { readFile } from "fs/promises";
import { parseEnvContent } from "../src/lib/env-file";

// Load .env
const envPath = join(import.meta.dir, "..", ".env");
const envContent = await readFile(envPath, "utf-8").catch(() => "");
// Gleicher Parser wie loadEnv (Anführungszeichen, Issue #62)
Object.assign(process.env, parseEnvContent(envContent));

import { mcpManager } from "../src/lib/mcp-client";
import { callFallbackLLMWithSource } from "../src/lib/fallback-llm";

async function main() {
  console.log("=== Fallback + MCP Tools End-to-End Test ===\n");

  // Check prerequisites
  if (!process.env.OPENROUTER_API_KEY) {
    console.log(
      "⚠️ OPENROUTER_API_KEY not set. Will try Ollama as fallback.\n"
    );
  }

  // Step 1: Boot MCP servers
  console.log("Step 1: Booting MCP servers...");
  await mcpManager.init();
  console.log(`  ${mcpManager.getStatus()}\n`);

  if (mcpManager.toolCount === 0) {
    console.log(
      "⚠️ No MCP tools available. Fallback will work but without tool access."
    );
    console.log(
      "  To test with tools, configure bun-based MCP servers in ~/.claude.json"
    );
    console.log("  or create config/mcp-servers.json\n");
  }

  // Step 2: Test prompts
  const testCases = [
    {
      name: "Simple question (no tools needed)",
      prompt: "What is 2 + 2? Answer in one word.",
    },
    ...(mcpManager.toolCount > 0
      ? [
          {
            name: "Tool-requiring request",
            prompt:
              "List the tools you have access to. Just name the first 5.",
          },
        ]
      : []),
  ];

  for (const test of testCases) {
    console.log(`\nTest: "${test.name}"`);
    console.log(`  Prompt: "${test.prompt}"`);
    const start = Date.now();

    try {
      const result = await callFallbackLLMWithSource(test.prompt);
      const elapsed = Date.now() - start;

      console.log(`  Source: ${result.source}`);
      console.log(`  Time: ${elapsed}ms`);
      console.log(
        `  Response:\n    ${result.text.substring(0, 500).replace(/\n/g, "\n    ")}`
      );

      if (result.source === "none") {
        console.log(
          "  ⚠️ No backend responded. Set OPENROUTER_API_KEY or start Ollama."
        );
      } else {
        console.log("  ✅ Pass");
      }
    } catch (err: any) {
      console.error(`  ❌ Error: ${err.message}`);
    }
  }

  // Cleanup
  console.log("\n\nCleaning up...");
  mcpManager.shutdown();
  console.log("\n=== Test complete ===");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  mcpManager.shutdown();
  process.exit(1);
});
