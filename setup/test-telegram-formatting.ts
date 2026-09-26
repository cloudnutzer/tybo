/**
 * Test Telegram HTML formatting + chunking — sends real messages to your bot.
 *
 * Run: bun run setup/test-telegram-formatting.ts
 *
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_USER_ID in .env
 */


import { resolve } from "path";
// Bun loads the project environment.

import {
  markdownToTelegramHTML,
  chunkForTelegram,
  stripHtmlTags,
  sendTelegramMessage,
} from "../src/lib/telegram";

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID = process.env.TELEGRAM_USER_ID || process.env.TELEGRAM_CHAT_ID;

if (!BOT_TOKEN || !CHAT_ID) {
  console.error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_USER_ID in .env");
  process.exit(1);
}

// ============================================================
// Test cases — each one sends a real Telegram message
// ============================================================

const tests: { name: string; markdown: string }[] = [
  {
    name: "1. Bold + italic + code",
    markdown:
      "**Bold text** and *italic text* and `inline_code` — all three should render correctly.",
  },
  {
    name: "2. BUG FIX: underscores in identifiers",
    markdown:
      "Variables like user_id, file_path, and some_long_function_name should display as plain text without italic errors.",
  },
  {
    name: "3. Code block with special chars",
    markdown: `Here's a code block:

\`\`\`typescript
interface User {
  user_id: string;
  display_name: string;
  is_active: boolean;
}

const result = await fetch("https://api.example.com/users");
console.log("<div>", result, "</div>");
\`\`\`

The code above should be in a monospace block with HTML properly escaped.`,
  },
  {
    name: "4. Headers + blockquotes + strikethrough",
    markdown: `# Main Header

## Sub Header

> This is a blockquote
> spanning multiple lines

~~This text is struck through~~

Regular paragraph after all the formatting.`,
  },
  {
    name: "5. Links (including with underscores)",
    markdown:
      'Check out [this link](https://example.com) and [this_api_endpoint](https://api.example.com/user_profile) — both should be clickable.',
  },
  {
    name: "6. Mixed real-world Claude output",
    markdown: `**Analysis Results**

I found 3 issues in your \`config_parser.ts\` file:

1. The \`parse_config_file\` function doesn't handle empty input
2. Variable \`max_retry_count\` is never used
3. The API call to \`https://api.internal.com/data_source\` has no timeout

\`\`\`typescript
// Fix for issue 1:
function parse_config_file(input: string): Config {
  if (!input) throw new Error("Empty config");
  return JSON.parse(input);
}
\`\`\`

> **Note:** These are non-blocking issues. Your build will still pass.

See the [style_guide](https://docs.example.com/style_guide) for more details.`,
  },
  {
    name: "7. BUG FIX: long message chunking (>4000 chars)",
    markdown:
      "This is a long message test.\n\n" +
      Array.from({ length: 50 }, (_, i) =>
        `**Paragraph ${i + 1}:** ${"Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(3)}`
      ).join("\n\n"),
  },
];

// ============================================================
// Run tests
// ============================================================

async function run() {
  console.log(`\nSending ${tests.length} test messages to Telegram...\n`);

  for (const test of tests) {
    const html = markdownToTelegramHTML(test.markdown);
    const chunks = chunkForTelegram(html);

    process.stdout.write(`${test.name} (${chunks.length} chunk(s), ${html.length} chars)... `);

    const ok = await sendTelegramMessage(BOT_TOKEN!, CHAT_ID!, `--- ${test.name} ---\n\n${test.markdown}`, {
      parseMode: "HTML",
    });

    console.log(ok ? "✅" : "❌ FAILED");

    // Small delay between messages to avoid rate limiting
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log("\nDone! Check your Telegram for the messages.");
}

run().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
