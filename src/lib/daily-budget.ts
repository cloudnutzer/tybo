import { Database } from "bun:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

function ledger() {
  const path = process.env.BUDGET_DB_PATH || "data/api-budget.sqlite";
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  chmodSync(path, 0o600);
  db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS costs (id TEXT PRIMARY KEY, day TEXT, provider TEXT, reserved REAL, spent REAL)");
  return db;
}
const today = () => new Date().toISOString().slice(0, 10);
const limit = () => {
  const value = Number(process.env.DAILY_API_BUDGET || "5");
  if (!Number.isFinite(value) || value < 0) throw new Error("Invalid DAILY_API_BUDGET");
  return value;
};
function used(db: Database): number {
  return (db.query("SELECT COALESCE(SUM(reserved+spent),0) AS amount FROM costs WHERE day=?").get(today()) as { amount: number }).amount;
}
export function remainingBudget(): number {
  const db = ledger();
  try { return Math.max(0, limit() - used(db)); } finally { db.close(); }
}
/** Durable reservation is conservative after crashes or unknown provider charges. */
export function reserveBudget(provider: string, amount: number): string {
  if (!Number.isFinite(amount) || amount <= 0) throw new Error("Invalid cost reservation");
  const db = ledger();
  try {
    return db.transaction(() => {
      if (used(db) + amount > limit()) throw new Error("Daily API budget reached");
      const id = randomUUID();
      db.query("INSERT INTO costs VALUES (?,?,?,?,0)").run(id, today(), provider, amount);
      return id;
    }).immediate();
  } finally { db.close(); }
}
export function settleBudget(id: string, actual?: number): void {
  const db = ledger();
  try {
    if (actual !== undefined && Number.isFinite(actual) && actual >= 0)
      db.query("UPDATE costs SET reserved=0,spent=? WHERE id=? AND reserved>0").run(actual, id);
    else db.query("UPDATE costs SET spent=reserved,reserved=0 WHERE id=? AND reserved>0").run(id);
  } finally { db.close(); }
}
