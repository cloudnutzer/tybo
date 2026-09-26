/**
 * Test MCPManager — Verify MCP servers start and tools are discovered.
 *
 * Run: bun run setup/test-mcp-client.ts
 */

import { BRAND } from "../src/brand";
import { mcpManager } from "../src/lib/mcp-client";

async function main() {
  console.log("Testing MCPManager...\n");

  // Init
  const start = Date.now();
  await mcpManager.init();
  const elapsed = Date.now() - start;
  console.log(`\nInit took ${elapsed}ms`);

  // Status
  console.log(`\nStatus: ${mcpManager.getStatus()}`);
  console.log(`Tool count: ${mcpManager.toolCount}`);
  console.log(`Ready: ${mcpManager.isReady}`);

  if (mcpManager.toolCount === 0) {
    console.log(
      "\n⚠️ No MCP tools found. This means either:"
    );
    console.log("  1. No bun-based MCP servers in ~/.claude.json");
    console.log("  2. No config/mcp-servers.json file");
    console.log("  3. MCP servers failed to start");
    console.log(`\nThis is OK — MCPManager is optional. ${BRAND.name} works without it.`);
    mcpManager.shutdown();
    process.exit(0);
  }

  // List tools in both formats
  const anthropicTools = mcpManager.getAnthropicTools();
  const openaiTools = mcpManager.getOpenAITools();

  console.log(`\n--- Anthropic Format (${anthropicTools.length} tools) ---`);
  for (const t of anthropicTools.slice(0, 10)) {
    console.log(`  ${t.name}: ${(t.description || "").substring(0, 80)}`);
  }
  if (anthropicTools.length > 10) {
    console.log(`  ... and ${anthropicTools.length - 10} more`);
  }

  console.log(`\n--- OpenAI Format (${openaiTools.length} tools) ---`);
  for (const t of openaiTools.slice(0, 10)) {
    console.log(
      `  ${t.function.name}: ${(t.function.description || "").substring(0, 80)}`
    );
  }
  if (openaiTools.length > 10) {
    console.log(`  ... and ${openaiTools.length - 10} more`);
  }

  // Test a tool call if any server has tools
  const firstTool = anthropicTools[0];
  if (firstTool) {
    console.log(`\n--- Testing tool: ${firstTool.name} ---`);
    console.log("  (calling with empty args to verify routing works)");
    const result = await mcpManager.callTool(firstTool.name, {});
    console.log(
      `  Result (${result.isError ? "ERROR" : "OK"}): ${result.content.substring(0, 200)}`
    );
  }

  // Shutdown
  mcpManager.shutdown();
  console.log("\n✅ MCPManager test complete");
  process.exit(0);
}

main().catch((err) => {
  console.error("Test failed:", err);
  mcpManager.shutdown();
  process.exit(1);
});
