import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";

/** Durable claim prevents concurrent deliveries and replay across restarts. */
export function claimWebhookEvent(provider: string, id: string): boolean {
  mkdirSync("data", { recursive: true });
  const db = new Database(join("data", "webhook-events.sqlite"), { create: true });
  chmodSync(join("data", "webhook-events.sqlite"), 0o600);
  try {
    db.exec("CREATE TABLE IF NOT EXISTS events (provider TEXT, id TEXT, created INTEGER, PRIMARY KEY(provider,id))");
    return db.query("INSERT OR IGNORE INTO events VALUES (?, ?, ?)").run(provider, id, Date.now()).changes === 1;
  } finally { db.close(); }
}
