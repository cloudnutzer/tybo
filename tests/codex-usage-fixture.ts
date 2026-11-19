/** Ausschließlich nachgebaute Sitzungsdateien im übergebenen Testordner. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexSessionDay } from "../src/lib/engines/codex-usage";

export const THREAD_ID = "00000000-0000-4000-8000-000000000001";
export const READ_TIME = Date.parse("2026-11-16T12:00:00.000Z");
export const MEASURED_AT = "2026-11-15T17:04:31.207Z";
export const ROLLOUT = readFileSync(join(import.meta.dir, "fixtures/codex-rollout.jsonl"), "utf8");

export function tokenCount(primary: unknown = { used_percent: 48, window_minutes: 10080, resets_at: 1794988050 }, secondary: unknown = null, timestamp: unknown = MEASURED_AT): string {
  return JSON.stringify({ timestamp, type: "event_msg", payload: { type: "token_count", rate_limits: { primary, secondary } } }) + "\n";
}

export function writeRollout(home: string, text = ROLLOUT, options: { now?: number; daysAgo?: number; id?: string } = {}): string {
  const dir = join(home, "sessions", codexSessionDay(options.now ?? READ_TIME, options.daysAgo ?? 0));
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `rollout-2026-11-15T17-04-20-${options.id ?? THREAD_ID}.jsonl`);
  writeFileSync(path, text);
  return path;
}
