import { Database } from "bun:sqlite";
import { readFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

/** Imports legacy JSON once; subsequent read/modify/write operations are atomic across processes. */
export function updateJsonState<T, R>(legacyPath: string, initial: () => T, update: (value: T) => R): R {
  mkdirSync(dirname(legacyPath), { recursive: true });
  const databasePath = `${legacyPath}.sqlite`;
  const db = new Database(databasePath, { create: true });
  chmodSync(databasePath, 0o600);
  try {
    db.exec("PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)");
    return db.transaction(() => {
      const row = db.query("SELECT value FROM state WHERE id=1").get() as { value: string } | null;
      let value: T;
      if (row) value = JSON.parse(row.value);
      else {
        try { value = JSON.parse(readFileSync(legacyPath, "utf8")); }
        catch (error: any) { if (error.code !== "ENOENT") throw error; value = initial(); }
      }
      const result = update(value);
      db.query("INSERT INTO state VALUES (1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(JSON.stringify(value));
      return result;
    }).immediate();
  } finally { db.close(); }
}
