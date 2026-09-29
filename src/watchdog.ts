#!/usr/bin/env bun
/**
 * Go - Watchdog
 *
 * Monitors if smart-checkin has run recently and alerts via Telegram if not.
 * Run via launchd every hour.
 */

import { existsSync, statSync, readFileSync } from "fs";
import { join } from "path";
import { parseEnvContent } from "./lib/env-file";
import { outboxDelivered, sendViaOutbox, type OutboxSender } from "./lib/outbox";

const DEFAULT_SCHEDULE = {
  quiet_hours: { start: 21, end: 8 },
  check_in_hours: { start: 10, end: 19 },
  check_in_intervals: [{ hour: 10, minute: 30 }],
  minimum_gap_minutes: 90,
};

// Erst in init() gesetzt (.env und Zeitplan lesen); der Import allein tut nichts
let PROJECT_ROOT = process.cwd();
let LOG_FILE = "";
let WATCHDOG_LOG = "";
let schedule = DEFAULT_SCHEDULE;
let MAX_AGE_MINUTES = 90;

function init(): void {
  // Load .env
  PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();
  const envPath = join(PROJECT_ROOT, ".env");
  if (existsSync(envPath)) {
    // Gleicher Parser wie loadEnv (Anführungszeichen, Issue #62)
    Object.assign(process.env, parseEnvContent(readFileSync(envPath, "utf-8")));
  }

  LOG_FILE = join(PROJECT_ROOT, "logs", "smart-checkin.log");
  WATCHDOG_LOG = join(PROJECT_ROOT, "logs", "watchdog.log");

  // Load schedule config (user-personalized quiet hours, check-in times)
  const SCHEDULE_PATH = join(PROJECT_ROOT, "config", "schedule.json");
  try {
    if (existsSync(SCHEDULE_PATH)) {
      schedule = { ...DEFAULT_SCHEDULE, ...JSON.parse(readFileSync(SCHEDULE_PATH, "utf-8")) };
    }
  } catch {}

  MAX_AGE_MINUTES = schedule.minimum_gap_minutes || 90;
}

function log(message: string) {
  const timestamp = new Date().toLocaleString("en-US", {
    timeZone: process.env.USER_TIMEZONE || "UTC",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  const line = `[${timestamp}] ${message}\n`;
  console.log(line.trim());
  try {
    Bun.write(WATCHDOG_LOG, line, { append: true } as any);
  } catch {}
}

/**
 * Senden und festhalten (Entscheidung 0006): Direktchat, Quelle watchdog;
 * Markdown als HTML, bei 400 einmal als Klartext wie bisher. Ohne Telegram
 * (Issue #227) hält die Outbox die Warnung nur für die WebUI fest.
 */
export const defaultSend: OutboxSender = sendViaOutbox;

export interface AlertDeps {
  send: OutboxSender;
  log(message: string): void;
  /**
   * Veraltet seit Issue #227: die Warnung geht auch ohne Telegram über die
   * Outbox (dann nur in die WebUI); die Angabe ändert nichts mehr
   */
  hasCredentials?: boolean;
}

export function defaultAlertDeps(): AlertDeps {
  return { send: defaultSend, log };
}

/** Schickt eine Warnung an den Direktchat; true, wenn zugestellt (Telegram oder, ohne Telegram, WebUI). */
export async function sendAlert(message: string, deps: AlertDeps = defaultAlertDeps()): Promise<boolean> {
  try {
    const result = await deps.send({ text: message, source: "watchdog" });
    const delivered = outboxDelivered(result);
    if (delivered) {
      deps.log(result.sent ? "✅ Alert sent" : "✅ Alert für die WebUI festgehalten");
    } else {
      deps.log("❌ Alert failed");
    }
    return delivered;
  } catch (error) {
    deps.log(`❌ Alert error: ${error}`);
    return false;
  }
}

/**
 * Check if current time falls in the quiet window — quiet hours themselves
 * plus a buffer after quiet hours end, giving the first scheduled check-in
 * time to actually run before the watchdog starts caring.
 */
function isInQuietWindow(): boolean {
  const tz = process.env.USER_TIMEZONE || process.env.USER_TIMEZONE || "UTC";
  const now = new Date();
  const currentHour = parseInt(
    now.toLocaleString("en-US", { timeZone: tz, hour: "2-digit", hour12: false })
  );
  const currentMinute = parseInt(
    now.toLocaleString("en-US", { timeZone: tz, minute: "2-digit" })
  );
  const currentTime = currentHour * 60 + currentMinute;

  const quietStart = (schedule.quiet_hours?.start ?? 21) * 60;
  const quietEnd = (schedule.quiet_hours?.end ?? 8) * 60;

  // During quiet hours (handles overnight wrap, e.g. 21:00 - 08:00)
  if (quietStart > quietEnd) {
    // Overnight: quiet from 21:00 to 08:00
    if (currentTime >= quietStart || currentTime < quietEnd) return true;
  } else {
    if (currentTime >= quietStart && currentTime < quietEnd) return true;
  }

  // Buffer after quiet hours: suppress until first scheduled check-in + 60 min
  const intervals = schedule.check_in_intervals || [];
  if (intervals.length > 0) {
    const firstCheckin = intervals[0].hour * 60 + intervals[0].minute;
    const bufferEnd = firstCheckin + 60;
    if (currentTime >= quietEnd && currentTime < bufferEnd) return true;
  }

  return false;
}

async function check() {
  log("🔍 Watchdog checking smart-checkin health...");

  if (isInQuietWindow()) {
    log("😴 In quiet window (quiet hours or pre-first-checkin buffer) — skipping alert");
    return;
  }

  if (!existsSync(LOG_FILE)) {
    log("❌ Log file doesn't exist!");
    await sendAlert(
      "🚨 *Smart Check-in Alert*\n\nLog file doesn't exist! Service may have never run.\n\nRun: `bun run setup:launchd -- --service smart-checkin`"
    );
    return;
  }

  const stats = statSync(LOG_FILE);
  const ageMinutes =
    (Date.now() - stats.mtime.getTime()) / 1000 / 60;

  log(
    `📊 Log last modified: ${stats.mtime.toLocaleString()} (${Math.round(ageMinutes)} min ago)`
  );

  if (ageMinutes > MAX_AGE_MINUTES) {
    log(`❌ Smart-checkin hasn't run in ${Math.round(ageMinutes)} minutes!`);
    await sendAlert(
      `🚨 *Smart Check-in Alert*\n\nService hasn't run in *${Math.round(ageMinutes)} minutes*!\n\nLast activity: ${stats.mtime.toLocaleString()}\n\nCheck logs in: ${LOG_FILE}`
    );
  } else {
    log(
      `✅ Healthy (last run ${Math.round(ageMinutes)} min ago)`
    );
  }
}

if (import.meta.main) {
  init();
  check().catch((error) => log(`❌ Watchdog error: ${error}`));
}
