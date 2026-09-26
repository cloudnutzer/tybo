/**
 * Go Telegram Bot - Convex Setup for Scheduled Tasks
 *
 * Sets up Convex for durable scheduled tasks & reminders.
 * Reuses existing TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID from .env.
 *
 * Usage: bun run setup:convex
 */

import { BRAND } from "../src/brand";
import { existsSync, readFileSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { loadEnv } from "../src/lib/env";

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
const WARN = yellow("!");

async function runCommand(
  cmd: string[],
  opts?: { cwd?: string }
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts?.cwd || PROJECT_ROOT,
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
// Steps
// ---------------------------------------------------------------------------

async function checkPrerequisites(): Promise<boolean> {
  // Check .env exists
  const envPath = join(PROJECT_ROOT, ".env");
  if (!existsSync(envPath)) {
    console.log(`  ${FAIL} .env not found. Run ${cyan("bun run setup")} first.`);
    return false;
  }

  // Load existing env
  await loadEnv(envPath);

  // Check Telegram creds exist (we'll reuse them)
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const userId = process.env.TELEGRAM_USER_ID;

  if (!botToken || botToken.includes("your_")) {
    console.log(`  ${FAIL} TELEGRAM_BOT_TOKEN not set in .env`);
    console.log(`      ${dim("Complete Phase 1 (Telegram) first.")}`);
    return false;
  }

  if (!userId || userId.includes("your_")) {
    console.log(`  ${FAIL} TELEGRAM_USER_ID not set in .env`);
    console.log(`      ${dim("Complete Phase 1 (Telegram) first.")}`);
    return false;
  }

  console.log(`  ${PASS} Telegram credentials found in .env`);
  return true;
}

async function checkConvexAlreadyConfigured(): Promise<boolean> {
  const convexUrl = process.env.CONVEX_URL;
  if (convexUrl && !convexUrl.includes("your_")) {
    console.log(`  ${PASS} CONVEX_URL already set: ${convexUrl}`);
    return true;
  }
  return false;
}

async function initConvex(): Promise<string | null> {
  console.log(`\n  Initializing Convex deployment...`);
  console.log(`  ${dim("This creates a free cloud database for scheduled tasks.")}\n`);

  // Check if convex is available
  const check = await runCommand(["npx", "convex", "--version"]);
  if (!check.ok) {
    console.log(`  ${FAIL} Convex CLI not available.`);
    console.log(`      ${dim("Try: bun install (convex is in package.json)")}`);
    return null;
  }
  console.log(`  ${PASS} Convex CLI: ${check.stdout}`);

  // Run convex init — this is interactive and needs a browser for auth
  // We use --once to do a single push, --configure=new to create a new deployment
  const result = await runCommand(["npx", "convex", "dev", "--once", "--configure=new"]);

  if (!result.ok) {
    // Check if it's already configured
    if (result.stderr.includes("already") || result.stdout.includes("ready")) {
      console.log(`  ${PASS} Convex deployment already exists`);
    } else {
      console.log(`  ${FAIL} Convex initialization failed:`);
      console.log(`      ${result.stderr.slice(0, 200)}`);
      console.log(`\n      ${dim("You may need to run this manually:")}`);
      console.log(`      ${cyan("npx convex dev --once --configure=new")}`);
      return null;
    }
  } else {
    console.log(`  ${PASS} Convex deployment created`);
  }

  // Read the CONVEX_URL from .env.local (convex writes it there)
  const envLocalPath = join(PROJECT_ROOT, ".env.local");
  if (existsSync(envLocalPath)) {
    const content = readFileSync(envLocalPath, "utf-8");
    const match = content.match(/CONVEX_URL=(.+)/);
    if (match) {
      return match[1].trim();
    }
  }

  // Also check CONVEX_DEPLOYMENT env var
  const deploymentEnv = join(PROJECT_ROOT, ".env.local");
  if (existsSync(deploymentEnv)) {
    const content = readFileSync(deploymentEnv, "utf-8");
    const match = content.match(/CONVEX_DEPLOYMENT=(.+)/);
    if (match) {
      // Convert deployment name to URL
      const name = match[1].trim();
      return `https://${name}.convex.cloud`;
    }
  }

  console.log(`  ${WARN} Could not auto-detect CONVEX_URL`);
  console.log(`      ${dim("Check .env.local or Convex dashboard for your deployment URL")}`);
  return null;
}

function saveConvexUrl(convexUrl: string): void {
  const envPath = join(PROJECT_ROOT, ".env");
  const content = readFileSync(envPath, "utf-8");

  if (content.includes("CONVEX_URL=") && !content.includes("# CONVEX_URL=")) {
    // Already uncommented — replace
    const updated = content.replace(/CONVEX_URL=.+/, `CONVEX_URL=${convexUrl}`);
    Bun.write(envPath, updated);
  } else if (content.includes("# CONVEX_URL=")) {
    // Uncomment and set
    const updated = content.replace(/# CONVEX_URL=.+/, `CONVEX_URL=${convexUrl}`);
    Bun.write(envPath, updated);
  } else {
    // Append
    appendFileSync(envPath, `\nCONVEX_URL=${convexUrl}\n`);
  }

  console.log(`  ${PASS} CONVEX_URL saved to .env`);
}

async function setConvexEnvVars(): Promise<boolean> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN!;
  const chatId = process.env.TELEGRAM_USER_ID!;

  console.log(`\n  Setting Telegram credentials in Convex environment...`);
  console.log(`  ${dim("(Convex needs these to send you Telegram notifications)")}`);

  // Set TELEGRAM_BOT_TOKEN
  const tokenResult = await runCommand([
    "npx", "convex", "env", "set", "TELEGRAM_BOT_TOKEN", botToken,
  ]);
  if (tokenResult.ok) {
    console.log(`  ${PASS} TELEGRAM_BOT_TOKEN set in Convex`);
  } else {
    console.log(`  ${FAIL} Failed to set TELEGRAM_BOT_TOKEN in Convex`);
    console.log(`      ${dim("Run manually: npx convex env set TELEGRAM_BOT_TOKEN <token>")}`);
    return false;
  }

  // Set TELEGRAM_CHAT_ID
  const chatResult = await runCommand([
    "npx", "convex", "env", "set", "TELEGRAM_CHAT_ID", chatId,
  ]);
  if (chatResult.ok) {
    console.log(`  ${PASS} TELEGRAM_CHAT_ID set in Convex`);
  } else {
    console.log(`  ${FAIL} Failed to set TELEGRAM_CHAT_ID in Convex`);
    console.log(`      ${dim("Run manually: npx convex env set TELEGRAM_CHAT_ID <id>")}`);
    return false;
  }

  return true;
}

async function testScheduling(): Promise<boolean> {
  console.log(`\n  Testing scheduled task creation...`);

  try {
    const { ConvexHttpClient } = await import("convex/browser");
    const { anyApi } = await import("convex/server");

    const convexUrl = process.env.CONVEX_URL;
    if (!convexUrl) {
      console.log(`  ${FAIL} CONVEX_URL not set`);
      return false;
    }

    const client = new ConvexHttpClient(convexUrl);
    if (!process.env.CONVEX_AUTH_TOKEN) throw new Error("CONVEX_AUTH_TOKEN required");
    client.setAuth(process.env.CONVEX_AUTH_TOKEN);
    const chatId = process.env.TELEGRAM_USER_ID!;

    // Create a test task 2 minutes from now
    const scheduledAt = Date.now() + 2 * 60 * 1000;
    const taskId = await client.mutation(anyApi.scheduledTasks.create, {
      chatId,
      type: "reminder" as const,
      prompt: `${BRAND.name} scheduling is set up! This is your test reminder.`,
      scheduledAt,
    });

    const fireTime = new Date(scheduledAt).toLocaleString("en-US", {
      timeZone: process.env.USER_TIMEZONE || "UTC",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });

    console.log(`  ${PASS} Test reminder created (fires at ${fireTime})`);
    console.log(`      ${dim("Check your Telegram in ~2 minutes for the test message.")}`);
    return true;
  } catch (err: any) {
    console.log(`  ${FAIL} Test failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log(bold("  Go Telegram Bot - Scheduled Tasks Setup"));
  console.log(dim("  ========================================"));

  // 1. Prerequisites
  console.log(`\n${cyan("  [1/4] Checking prerequisites...")}`);
  const prereqOk = await checkPrerequisites();
  if (!prereqOk) {
    process.exit(1);
  }

  // 2. Check if already configured
  console.log(`\n${cyan("  [2/4] Convex deployment...")}`);
  const alreadyConfigured = await checkConvexAlreadyConfigured();

  let convexUrl: string | null = process.env.CONVEX_URL || null;

  if (!alreadyConfigured) {
    convexUrl = await initConvex();
    if (convexUrl) {
      saveConvexUrl(convexUrl);
      // Reload so subsequent steps see it
      process.env.CONVEX_URL = convexUrl;
    } else {
      console.log(`\n  ${WARN} Convex URL not auto-detected.`);
      console.log(`      ${dim("If the deployment was created, find your URL at:")}`);
      console.log(`      ${cyan("https://dashboard.convex.dev")}`);
      console.log(`      ${dim("Then add CONVEX_URL=<url> to your .env and re-run this script.")}`);
      process.exit(1);
    }
  }

  // 3. Set Telegram creds in Convex (reusing from .env)
  console.log(`\n${cyan("  [3/4] Configuring Convex environment...")}`);
  const envOk = await setConvexEnvVars();

  // 4. Test
  console.log(`\n${cyan("  [4/4] Testing...")}`);
  const testOk = await testScheduling();

  // Summary
  console.log(`\n${bold("  Setup Complete!")}`);
  console.log(dim("  ---------------"));

  if (testOk) {
    console.log(`  ${PASS} Scheduled tasks are ready.`);
    console.log(`\n  ${bold("Try it out:")}`);
    console.log(`  Send your bot: "Remind me in 5 minutes to stretch"`);
  } else {
    console.log(`  ${WARN} Setup completed with warnings. Check errors above.`);
  }

  console.log(`\n  ${bold("Docs:")} ${cyan("docs/scheduling.md")}`);
  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Fatal error:")} ${err.message}`);
  process.exit(1);
});
