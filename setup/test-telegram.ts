/**
 * Go Telegram Bot - Telegram Connectivity Test
 *
 * Isolated test that verifies the bot token works,
 * fetches bot info, and sends a test message.
 *
 * Usage: bun run setup/test-telegram.ts
 */

import { join, dirname } from "path";
import { loadEnv } from "../src/lib/env";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = dirname(import.meta.dir);

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const PASS = green("\u2713");
const FAIL = red("\u2717");

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log(bold("  Go Telegram Bot - Telegram Test"));
  console.log(dim("  ================================"));

  // Load environment
  await loadEnv(join(PROJECT_ROOT, ".env"));

  const token = process.env.TELEGRAM_BOT_TOKEN;
  const userId = process.env.TELEGRAM_USER_ID;

  // Check token
  if (!token || token.includes("your_") || token.includes("_here")) {
    console.log(`\n  ${FAIL} TELEGRAM_BOT_TOKEN is not set in .env`);
    console.log(`    Get a token from @BotFather on Telegram`);
    process.exit(1);
  }
  console.log(`\n  ${PASS} Token found: ${token.slice(0, 6)}...${token.slice(-4)}`);

  // Test getMe
  console.log(`\n${cyan("  Testing getMe API...")}`);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await response.json()) as {
      ok: boolean;
      result?: {
        id: number;
        is_bot: boolean;
        first_name: string;
        username: string;
        can_join_groups: boolean;
        can_read_all_group_messages: boolean;
        supports_inline_queries: boolean;
      };
      description?: string;
    };

    if (!data.ok || !data.result) {
      console.log(`  ${FAIL} getMe failed: ${data.description || "unknown error"}`);
      console.log(`    Check that your TELEGRAM_BOT_TOKEN is correct`);
      process.exit(1);
    }

    const bot = data.result;
    console.log(`  ${PASS} Bot info:`);
    console.log(`    Username:  @${bot.username}`);
    console.log(`    Bot ID:    ${bot.id}`);
    console.log(`    Name:      ${bot.first_name}`);
    console.log(`    Groups:    ${bot.can_join_groups ? "yes" : "no"}`);
    console.log(`    Inline:    ${bot.supports_inline_queries ? "yes" : "no"}`);
  } catch (err: any) {
    console.log(`  ${FAIL} Network error: ${err.message}`);
    console.log(`    Check your internet connection`);
    process.exit(1);
  }

  // Send test message
  if (!userId || userId.includes("your_")) {
    console.log(`\n  ${dim("-")} TELEGRAM_USER_ID not set - skipping test message`);
    console.log(`    To send test messages, set TELEGRAM_USER_ID in .env`);
    console.log("");
    return;
  }

  console.log(`\n${cyan("  Sending test message...")}`);
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: userId,
        text: "\u{1F916} Go bot is connected!",
      }),
    });

    const data = (await response.json()) as {
      ok: boolean;
      result?: { message_id: number };
      description?: string;
    };

    if (data.ok && data.result) {
      console.log(`  ${PASS} Test message sent! (message_id: ${data.result.message_id})`);
      console.log(`    Check your Telegram for the message.`);
    } else {
      console.log(`  ${FAIL} Send failed: ${data.description || "unknown error"}`);
      if (data.description?.includes("chat not found")) {
        console.log(`    Start a conversation with the bot first, then try again.`);
      } else if (data.description?.includes("Forbidden")) {
        console.log(`    The bot was blocked or the user ID is wrong.`);
      }
    }
  } catch (err: any) {
    console.log(`  ${FAIL} Network error: ${err.message}`);
  }

  console.log("");
}

main().catch((err) => {
  console.error(`\n  ${red("Fatal error:")} ${err.message}`);
  process.exit(1);
});
