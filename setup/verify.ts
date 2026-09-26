/**
 * Go Telegram Bot - Full Health Check
 *
 * Verifies environment variables, API connectivity,
 * launchd services, and optional integrations.
 *
 * Usage: bun run setup/verify.ts
 */

import { join, dirname } from "path";
import { loadEnv } from "../src/lib/env";
import { supabaseHeaders } from "../src/lib/supabase-keys";
import { findLaunchctlLine, pm2Name } from "../src/lib/service-names";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = dirname(import.meta.dir);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const PASS = green("\u2713");
const FAIL = red("\u2717");
const WARN = yellow("~");
const SKIP = dim("-");

interface CheckResult {
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  message: string;
}

const results: CheckResult[] = [];

function record(name: string, status: CheckResult["status"], message: string) {
  results.push({ name, status, message });
  const icon =
    status === "pass" ? PASS : status === "fail" ? FAIL : status === "warn" ? WARN : SKIP;
  console.log(`  ${icon} ${name}: ${message}`);
}

async function runCommand(
  cmd: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: PROJECT_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch {
    return { ok: false, stdout: "", stderr: "Command not found" };
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

function checkRequiredEnv() {
  console.log(`\n${cyan("  [1/6] Required Environment Variables")}`);

  const required: [string, string][] = [
    ["TELEGRAM_BOT_TOKEN", "Telegram bot token"],
    ["TELEGRAM_USER_ID", "Telegram user ID"],
  ];

  for (const [key, label] of required) {
    const value = process.env[key];
    if (!value || value.includes("your_") || value.includes("_here")) {
      record(label, "fail", `${key} is not set or still has placeholder value`);
    } else {
      // Mask sensitive values
      const masked = value.length > 8 ? value.slice(0, 4) + "..." + value.slice(-4) : "***";
      record(label, "pass", `${key} = ${masked}`);
    }
  }

  // Database backend check (Convex or Supabase)
  const convexUrl = process.env.CONVEX_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const hasConvex = convexUrl && !convexUrl.includes("your_");
  const hasSupabase = supabaseUrl && !supabaseUrl.includes("your_");

  if (hasConvex) {
    const masked = convexUrl!.length > 8 ? convexUrl!.slice(0, 4) + "..." + convexUrl!.slice(-4) : "***";
    record("Database backend", "pass", `Convex: ${masked}`);
  } else if (hasSupabase) {
    const masked = supabaseUrl!.length > 8 ? supabaseUrl!.slice(0, 4) + "..." + supabaseUrl!.slice(-4) : "***";
    record("Database backend", "pass", `Supabase: ${masked}`);
  } else {
    record("Database backend", "fail", "No database configured (set CONVEX_URL or SUPABASE_URL in .env)");
  }
}

async function checkTelegram() {
  console.log(`\n${cyan("  [2/6] Telegram Connectivity")}`);

  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || token.includes("your_")) {
    record("Telegram API", "skip", "No valid token configured");
    return;
  }

  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await response.json()) as { ok: boolean; result?: { username: string; id: number } };

    if (data.ok && data.result) {
      record(
        "Telegram API",
        "pass",
        `Bot: @${data.result.username} (ID: ${data.result.id})`
      );
    } else {
      record("Telegram API", "fail", "getMe returned ok=false - check token");
    }
  } catch (err: any) {
    record("Telegram API", "fail", `Connection error: ${err.message}`);
  }
}

export async function checkDatabase() {
  console.log(`\n${cyan("  [3/6] Database Connectivity")}`);

  const convexUrl = process.env.CONVEX_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const hasConvex = convexUrl && !convexUrl.includes("your_");
  const hasSupabase = supabaseUrl && !supabaseUrl.includes("your_");

  // Convex path
  if (hasConvex) {
    try {
      const { testConnection } = await import("../src/lib/convex");
      const result = await testConnection();
      if (result.includes("OK")) {
        record("Convex connection", "pass", result);
      } else {
        record("Convex connection", "fail", result);
      }
    } catch (err: any) {
      record("Convex connection", "fail", `Import/connection error: ${err.message}`);
    }
    return;
  }

  // Supabase path
  if (hasSupabase) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!key || key.includes("your_")) {
      record("Supabase connection", "fail", "SUPABASE_URL set but no valid key configured");
      return;
    }

    // Test messages table
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/messages?select=id&limit=1`, {
        headers: supabaseHeaders(key),
      });

      if (response.ok) {
        record("Supabase messages table", "pass", "Connected and accessible");
      } else if (response.status === 404) {
        record("Supabase messages table", "fail", "Table not found - run db/schema.sql");
      } else {
        const body = await response.text();
        record("Supabase messages table", "fail", `HTTP ${response.status}: ${body.slice(0, 100)}`);
      }
    } catch (err: any) {
      record("Supabase messages table", "fail", `Connection error: ${err.message}`);
    }

    // Test memory table
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/memory?select=id&limit=1`, {
        headers: supabaseHeaders(key),
      });

      if (response.ok) {
        record("Supabase memory table", "pass", "Connected and accessible");
      } else if (response.status === 404) {
        record("Supabase memory table", "warn", "Table not found - memory features unavailable");
      } else {
        record("Supabase memory table", "warn", `HTTP ${response.status}`);
      }
    } catch (err: any) {
      record("Supabase memory table", "fail", `Connection error: ${err.message}`);
    }
    return;
  }

  // Neither configured
  record("Database connection", "skip", "No database configured (set up in Phase 2)");
}

async function checkServices() {
  const services = ["telegram-relay", "smart-checkin", "morning-briefing", "watchdog"];

  if (process.platform === "darwin") {
    console.log(`\n${cyan("  [4/6] launchd Services")}`);

    await checkLaunchdServices(services);
  } else {
    console.log(`\n${cyan("  [4/6] Background Services")}`);

    await checkPm2Services(services);
  }
}

/**
 * launchd-Dienste unter ai.tybo.<dienst> (Issue #101). Dienste anderer Namen
 * zählen nicht (Issue #142). `run` und `rec` sind in Tests Attrappen.
 */
export async function checkLaunchdServices(
  services: string[],
  run: typeof runCommand = runCommand,
  rec: typeof record = record
): Promise<void> {
  const result = await run(["launchctl", "list"]);
  if (!result.ok) {
    rec("launchctl", "fail", "Could not query launchctl");
    return;
  }

  for (const service of services) {
    const line = findLaunchctlLine(result.stdout, service);

    if (line) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[0];
      const exitCode = parts[1];

      if (pid !== "-") {
        rec(service, "pass", `Running (PID: ${pid})`);
      } else if (exitCode === "0") {
        rec(service, "pass", `Loaded, last exit: 0 ${dim("(waiting for schedule)")}`);
      } else {
        rec(service, "warn", `Loaded but last exit code: ${exitCode}`);
      }
    } else {
      rec(service, "skip", "Not installed");
    }
  }
}

/**
 * PM2-Dienste unter tybo-<dienst> (Issue #101). Prozesse anderer Namen zählen
 * nicht (Issue #142). `run` und `rec` sind in Tests Attrappen.
 */
export async function checkPm2Services(
  services: string[],
  run: typeof runCommand = runCommand,
  rec: typeof record = record
): Promise<void> {
  const pm2Result = await run(["npx", "pm2", "jlist"]);
  if (!pm2Result.ok) {
    rec("PM2", "skip", "PM2 not installed (npm install -g pm2)");
    for (const service of services) {
      rec(service, "skip", "No service manager detected");
    }
    return;
  }
  let pm2List: Array<{ name: string; pm2_env?: { status?: string }; pid?: number }>;
  try {
    pm2List = JSON.parse(pm2Result.stdout);
    if (!Array.isArray(pm2List)) throw new Error("not an array");
  } catch {
    rec("PM2", "warn", "Could not parse PM2 output");
    return;
  }
  for (const service of services) {
    const proc = pm2List.find(p => p?.name === pm2Name(service));
    if (!proc) {
      rec(service, "skip", "Not registered in PM2");
      continue;
    }
    const status = proc.pm2_env?.status || "unknown";
    if (status === "online") {
      rec(service, "pass", `Running via PM2 (PID: ${proc.pid})`);
    } else {
      rec(service, "warn", `PM2 status: ${status}`);
    }
  }
}

async function checkAgentBots() {
  console.log(`\n${cyan("  [5/6] Multi-Bot Agent Identities (Optional)")}`);

  const agentTokens: [string, string][] = [
    ["TELEGRAM_BOT_TOKEN_RESEARCH", "Research agent bot"],
    ["TELEGRAM_BOT_TOKEN_CONTENT", "Content agent bot"],
    ["TELEGRAM_BOT_TOKEN_FINANCE", "Finance agent bot"],
    ["TELEGRAM_BOT_TOKEN_STRATEGY", "Strategy agent bot"],
    ["TELEGRAM_BOT_TOKEN_CRITIC", "Critic agent bot"],
  ];

  let configured = 0;
  for (const [key, label] of agentTokens) {
    const value = process.env[key];
    if (!value || value.includes("your_")) {
      record(label, "skip", "Not configured (will use main bot)");
      continue;
    }

    configured++;
    try {
      const response = await fetch(`https://api.telegram.org/bot${value}/getMe`);
      const data = (await response.json()) as { ok: boolean; result?: { username: string; id: number } };
      if (data.ok && data.result) {
        record(label, "pass", `@${data.result.username} (ID: ${data.result.id})`);
      } else {
        record(label, "fail", `${key} token invalid — getMe returned ok=false`);
      }
    } catch (err: any) {
      record(label, "fail", `${key} connection error: ${err.message}`);
    }
  }

  if (configured === 0) {
    console.log(dim(`        No agent bot tokens configured — all agents will use the main bot.`));
    console.log(dim(`        To enable multi-bot identities, see CLAUDE.md Phase 4.`));
  } else {
    console.log(dim(`        ${configured}/5 agent bots configured. Missing ones fall back to main bot.`));
  }
}

function checkOptionalIntegrations() {
  console.log(`\n${cyan("  [6/6] Optional Integrations")}`);

  const optional: [string, string][] = [
    ["ELEVENLABS_API_KEY", "ElevenLabs (voice)"],
    ["GEMINI_API_KEY", "Gemini (transcription)"],
    ["OPENROUTER_API_KEY", "OpenRouter (fallback LLM)"],
  ];

  for (const [key, label] of optional) {
    const value = process.env[key];
    if (value && !value.includes("your_")) {
      record(label, "pass", "Configured");
    } else {
      record(label, "skip", "Not configured");
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log(bold("  Go Telegram Bot - Health Check"));
  console.log(dim("  =============================="));

  // Load environment
  await loadEnv(join(PROJECT_ROOT, ".env"));

  // Run all checks
  checkRequiredEnv();
  await checkTelegram();
  await checkDatabase();
  await checkServices();
  await checkAgentBots();
  checkOptionalIntegrations();

  // Summary
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  const skipped = results.filter((r) => r.status === "skip").length;

  console.log(`\n${bold("  Results:")}`);
  console.log(`  ${PASS} ${passed} passed`);
  if (failed > 0) console.log(`  ${FAIL} ${failed} failed`);
  if (warned > 0) console.log(`  ${WARN} ${warned} warnings`);
  if (skipped > 0) console.log(`  ${SKIP} ${skipped} skipped`);

  if (failed > 0) {
    console.log(`\n  ${red("Some checks failed. Review the errors above and fix before running the bot.")}`);
    process.exit(1);
  } else if (warned > 0) {
    console.log(`\n  ${yellow("All critical checks passed, but some warnings to review.")}`);
  } else {
    console.log(`\n  ${green("All checks passed! Ready to run.")}`);
  }

  console.log("");
}

if (import.meta.main) main().catch((err) => {
  console.error(`\n  ${red("Fatal error:")} ${err.message}`);
  process.exit(1);
});
