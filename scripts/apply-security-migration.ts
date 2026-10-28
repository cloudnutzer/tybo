import { readFile, writeFile, mkdir } from "node:fs/promises";

const ref = new URL(process.env.SUPABASE_URL || "").hostname.split(".")[0];
const linked = (await readFile("supabase/.temp/project-ref", "utf8")).trim();
if (ref !== linked) throw new Error("Runtime and linked Supabase project differ");
if (!process.env.SUPABASE_ACCESS_TOKEN) throw new Error("SUPABASE_ACCESS_TOKEN required");
const apply = process.argv.includes("--apply");
let query = await readFile("db/migrations/20260909_security_knowledge.sql", "utf8");
query = query.replace("BEGIN;", "BEGIN; SET LOCAL lock_timeout='3s'; SET LOCAL statement_timeout='30s';");
if (!apply) query = query.replace("COMMIT;", "ROLLBACK;");
const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
  method: "POST", headers: { authorization: `Bearer ${process.env.SUPABASE_ACCESS_TOKEN}`, "content-type": "application/json" },
  body: JSON.stringify({ query }), signal: AbortSignal.timeout(40_000),
});
const result = await response.text();
await mkdir("data/security-review", { recursive: true });
await writeFile(`data/security-review/migration-${apply ? "applied" : "dry-run"}.json`, result, { mode: 0o600 });
if (!response.ok) throw new Error(`Migration failed (${response.status}); private details in data/security-review`);
console.log(apply ? "Security migration applied" : "Security migration validated and rolled back");
