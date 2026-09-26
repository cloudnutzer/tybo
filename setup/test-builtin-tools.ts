/**
 * Built-in Tools Test (Tool-Gateway Phase 2)
 *
 * 1. Listet alle registrierten Built-ins mit Verfuegbarkeit + Flags.
 * 2. Bootet den MCPManager und zeigt die Fusion (aktiv vs. von MCP
 *    ueberdeckt) plus beide Format-Adapter.
 * 3. Read-only-Smoke-Tests mit echten API-Calls:
 *    - firecrawl_scrape direkt ueber den Built-in-Handler (Backup-Pfad,
 *      umgeht die MCP-Ueberdeckung)
 *    - cloudflare_deployments ueber mcpManager.callTool (voller Pfad)
 *
 * Kostenpflichtige/sendende Tools nur per Flag:
 *   --apify  fuehrt einen Mini-Actor-Run aus (kostet Apify-Credits)
 *   --send   schickt eine Testdatei per telegram_send_document
 *
 * Run: bun run setup/test-builtin-tools.ts
 */

import { BRAND } from "../src/brand";
import { loadEnv } from "../src/lib/env";
import { mcpManager } from "../src/lib/mcp-client";
import {
  getAllBuiltinTools,
  getAvailableBuiltinTools,
  getBuiltinTool,
} from "../src/lib/tools";

const RUN_APIFY = process.argv.includes("--apify");
const RUN_SEND = process.argv.includes("--send");

async function main() {
  await loadEnv();

  console.log("=== 1. Registrierte Built-in-Tools ===");
  for (const t of getAllBuiltinTools()) {
    const avail = t.isAvailable() ? "✅ verfuegbar" : "❌ Credential fehlt";
    const flags = t.requiresApproval ? " [requiresApproval]" : "";
    console.log(`  ${t.name}: ${avail}${flags}`);
  }
  const available = getAvailableBuiltinTools();
  if (available.length === 0) {
    console.error("Keine Built-ins verfuegbar — .env pruefen.");
    process.exit(1);
  }

  console.log("\n=== 2. MCPManager-Fusion ===");
  await mcpManager.init();
  console.log(`  Status: ${mcpManager.getStatus()}`);
  const openai = mcpManager.getOpenAITools();
  const anthropic = mcpManager.getAnthropicTools();
  console.log(`  OpenAI-Format: ${openai.length} Tools`);
  console.log(`  Anthropic-Format: ${anthropic.length} Tools`);
  if (openai.length !== anthropic.length) {
    console.error("  ❌ Format-Adapter liefern unterschiedliche Tool-Zahlen!");
    process.exit(1);
  }
  const names = openai.map((t) => t.function.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length > 0) {
    console.error(`  ❌ Doppelte Tool-Namen nach Fusion: ${dupes.join(", ")}`);
    process.exit(1);
  }
  console.log("  ✅ Keine Namenskollisionen im gemergten Set");

  let failures = 0;

  console.log("\n=== 3a. firecrawl_scrape (Built-in-Handler direkt, Backup-Pfad) ===");
  const fc = getBuiltinTool("firecrawl_scrape");
  if (fc?.isAvailable()) {
    try {
      const out = await fc.handler({ url: "https://example.com" });
      const ok = out.toLowerCase().includes("example domain");
      console.log(ok ? "  ✅ Scrape ok" : `  ❌ Unerwarteter Inhalt: ${out.substring(0, 120)}`);
      if (!ok) failures++;
    } catch (err: any) {
      console.error(`  ❌ ${err.message}`);
      failures++;
    }
  } else {
    console.log("  ⏭️ uebersprungen (kein FIRECRAWL_API_KEY)");
  }

  console.log("\n=== 3b. cloudflare_deployments (via mcpManager.callTool) ===");
  if (getBuiltinTool("cloudflare_deployments")?.isAvailable()) {
    const result = await mcpManager.callTool("cloudflare_deployments", {});
    if (result.isError) {
      console.error(`  ❌ ${result.content.substring(0, 200)}`);
      failures++;
    } else {
      const projects = JSON.parse(result.content);
      console.log(`  ✅ ${projects.length} Pages-Projekte:`);
      for (const p of projects.slice(0, 5)) {
        console.log(`     ${p.name} — ${p.latest_deployment?.status ?? "kein Deployment"}`);
      }
    }
  } else {
    console.log("  ⏭️ uebersprungen (kein CLOUDFLARE_API_TOKEN/ACCOUNT_ID)");
  }

  if (RUN_APIFY) {
    console.log("\n=== 3c. apify_run_actor (--apify) ===");
    const result = await mcpManager.callTool("apify_run_actor", {
      actor: "apify/website-content-crawler",
      input: { startUrls: [{ url: "https://example.com" }], maxCrawlPages: 1 },
      maxWaitSeconds: 180,
      maxItems: 1,
    });
    console.log(
      result.isError
        ? `  ❌ ${result.content.substring(0, 300)}`
        : `  ✅ ${result.content.substring(0, 300)}`
    );
    if (result.isError) failures++;
  }

  if (RUN_SEND) {
    console.log("\n=== 3d. telegram_send_document (--send) ===");
    const tmp = `/tmp/tybo-tooltest-${Date.now()}.txt`;
    await Bun.write(tmp, `${BRAND.name} Built-in-Tool-Test ${new Date().toISOString()}\n`);
    const result = await mcpManager.callTool("telegram_send_document", {
      file_path: tmp,
      caption: "Built-in-Tool-Test: telegram_send_document",
    });
    console.log(result.isError ? `  ❌ ${result.content}` : `  ✅ ${result.content}`);
    if (result.isError) failures++;
  }

  console.log(
    failures === 0
      ? "\n✅ Alle Tests bestanden"
      : `\n❌ ${failures} Test(s) fehlgeschlagen`
  );
  mcpManager.shutdown();
  process.exit(failures === 0 ? 0 : 1);
}

main();
