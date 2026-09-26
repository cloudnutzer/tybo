#!/usr/bin/env bun
/**
 * tybo Feedback Loop CLI
 *
 * Usage:
 *   bun run feedback              — score today's interactions
 *   bun run feedback --backfill=5 — score last 5 days
 *   bun run feedback --analyze    — generate weekly patterns
 *   bun run feedback --force      — re-score even if already done
 */

import { BRAND } from "./brand";
import "./lib/env";
import { scoreDay, analyze, getWeeklySummaryMessage } from "./lib/feedback-loop";
import { guardTelegramPayload } from "./lib/telegram";

const args = process.argv.slice(2);
const FORCE = args.includes("--force");
const ANALYZE = args.includes("--analyze");
const BACKFILL = parseInt(args.find(a => a.startsWith("--backfill="))?.split("=")[1] || "0");

function getDateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

async function main() {
  console.log(`[feedback] ${BRAND.name} Feedback Loop starting...`);
  console.log(`[feedback] Setup: ${process.env.CONVEX_URL ? "Convex" : process.env.SUPABASE_URL ? "Supabase" : "local"}`);

  if (ANALYZE) {
    await analyze();
    const summary = await getWeeklySummaryMessage();
    if (summary) {
      console.log(`\n${summary}`);

      // Send to Telegram if configured
      const token = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_USER_ID;
      if (token && chatId) {
        try {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            // Issue #52: Zusammenfassung enthält Modelltext
            body: JSON.stringify(guardTelegramPayload("sendMessage", { chat_id: chatId, text: summary })),
          });
          console.log("[feedback] Weekly summary sent to Telegram");
        } catch { /* non-fatal */ }
      }
    }
    return;
  }

  // Score dates
  const dates: string[] = [];
  if (BACKFILL > 0) {
    for (let i = BACKFILL; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      dates.push(getDateStr(d));
    }
  } else {
    dates.push(getDateStr(new Date()));
  }

  let totalScored = 0;
  for (const dateStr of dates) {
    console.log(`\n--- ${dateStr} ---`);
    const scores = await scoreDay(dateStr, FORCE);
    totalScored += scores.length;
    for (const s of scores) {
      console.log(`  [${s.channel}] ${s.sessionId}: ${s.score} (${s.label}) — ${s.messageCount} msgs, ${s.correctionCount} corrections`);
    }
  }

  console.log(`\n[feedback] Done. ${totalScored} interactions scored.`);
}

main().catch(err => {
  console.error(`[feedback] FATAL: ${err}`);
  process.exit(1);
});
