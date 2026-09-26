/**
 * Go Telegram Bot - Supabase Connectivity Test
 *
 * Isolated test that verifies Supabase connection,
 * table existence, and read/write access.
 *
 * Usage: bun run setup/test-supabase.ts
 */

import { join, dirname } from "path";
import { loadEnv } from "../src/lib/env";
import { isNewSupabaseKey, supabaseHeaders } from "../src/lib/supabase-keys";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = dirname(import.meta.dir);

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const PASS = green("\u2713");
const FAIL = red("\u2717");
const WARN = yellow("~");

/** Köpfe für REST-Aufrufe; neue Schlüssel (sb_…) nur als apikey (Issue #162) */
export function getHeaders(key: string): Record<string, string> {
  return {
    ...supabaseHeaders(key),
    "Content-Type": "application/json",
    Prefer: "return=representation",
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** envPath nur für Tests: sonst die .env im Projektordner */
export async function main(envPath = join(PROJECT_ROOT, ".env")) {
  console.log("");
  console.log(bold("  Go Telegram Bot - Supabase Test"));
  console.log(dim("  ================================"));

  // Load environment
  await loadEnv(envPath);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  const keyType = process.env.SUPABASE_SERVICE_ROLE_KEY
    ? isNewSupabaseKey(key || "") ? "secret (sb_secret_)" : "service_role"
    : isNewSupabaseKey(key || "") ? "publishable (sb_publishable_)" : "anon";

  // Check credentials
  if (!url || url.includes("your_")) {
    console.log(`\n  ${FAIL} SUPABASE_URL is not set in .env`);
    process.exit(1);
  }
  if (!key || key.includes("your_")) {
    console.log(`\n  ${FAIL} SUPABASE_ANON_KEY (or SUPABASE_SERVICE_ROLE_KEY) is not set in .env`);
    process.exit(1);
  }

  console.log(`\n  ${PASS} URL: ${url}`);
  console.log(`  ${PASS} Key type: ${keyType}`);

  const headers = getHeaders(key);

  // ---------------------------------------------------------------------------
  // Test 1: Connection + messages table
  // ---------------------------------------------------------------------------
  console.log(`\n${cyan("  [1/3] Testing messages table...")}`);

  try {
    const response = await fetch(
      `${url}/rest/v1/messages?select=id&limit=1&order=created_at.desc`,
      { headers }
    );

    if (response.ok) {
      // Get count
      const countResponse = await fetch(
        `${url}/rest/v1/messages?select=id`,
        {
          headers: {
            ...headers,
            Prefer: "count=exact",
            "Range-Unit": "items",
            Range: "0-0",
          },
        }
      );
      const contentRange = countResponse.headers.get("content-range");
      const total = contentRange ? contentRange.split("/")[1] : "unknown";
      console.log(`  ${PASS} messages table: accessible (${total} rows)`);
    } else if (response.status === 404 || response.status === 406) {
      console.log(`  ${FAIL} messages table: not found`);
      console.log(`    Run the Supabase migrations to create required tables.`);
    } else {
      const body = await response.text();
      console.log(`  ${FAIL} messages table: HTTP ${response.status}`);
      console.log(`    ${body.slice(0, 200)}`);
    }
  } catch (err: any) {
    console.log(`  ${FAIL} Connection error: ${err.message}`);
    console.log(`    Check that SUPABASE_URL is correct and the project is running.`);
    process.exit(1);
  }

  // ---------------------------------------------------------------------------
  // Test 2: memory table
  // ---------------------------------------------------------------------------
  console.log(`\n${cyan("  [2/3] Testing memory table...")}`);

  try {
    const response = await fetch(
      `${url}/rest/v1/memory?select=id&limit=1`,
      { headers }
    );

    if (response.ok) {
      console.log(`  ${PASS} memory table: accessible`);
    } else {
      console.log(`  ${WARN} memory table: HTTP ${response.status} ${dim("(memory features may not work)")}`);
    }
  } catch (err: any) {
    console.log(`  ${WARN} memory table: ${err.message}`);
  }

  // ---------------------------------------------------------------------------
  // Test 3: Write access (insert + delete test row in memory)
  // ---------------------------------------------------------------------------
  console.log(`\n${cyan("  [3/3] Testing write access...")}`);

  const testContent = `__setup_test_${Date.now()}`;
  let insertedId: string | null = null;

  // Insert
  try {
    const response = await fetch(`${url}/rest/v1/memory`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        type: "fact",
        content: testContent,
      }),
    });

    if (response.ok) {
      const rows = (await response.json()) as Array<{ id: string }>;
      if (rows && rows.length > 0) {
        insertedId = rows[0].id;
        console.log(`  ${PASS} Insert: OK ${dim(`(test row id: ${insertedId})`)}`);
      } else {
        console.log(`  ${PASS} Insert: OK ${dim("(no id returned)")}`);
      }
    } else {
      const body = await response.text();
      console.log(`  ${FAIL} Insert: HTTP ${response.status}`);
      console.log(`    ${body.slice(0, 200)}`);
      if (response.status === 403) {
        console.log(`    ${yellow("Tip: Put the secret key (sb_secret_) or service_role into SUPABASE_SERVICE_ROLE_KEY for full access (bypasses RLS)")}`);
      }
    }
  } catch (err: any) {
    console.log(`  ${FAIL} Insert error: ${err.message}`);
  }

  // Delete test row
  if (insertedId) {
    try {
      const response = await fetch(
        `${url}/rest/v1/memory?id=eq.${insertedId}`,
        {
          method: "DELETE",
          headers,
        }
      );

      if (response.ok) {
        console.log(`  ${PASS} Delete: OK ${dim("(test row cleaned up)")}`);
      } else {
        console.log(`  ${WARN} Delete: HTTP ${response.status} ${dim("(test row may remain)")}`);
      }
    } catch (err: any) {
      console.log(`  ${WARN} Delete error: ${err.message} ${dim("(test row may remain)")}`);
    }
  } else {
    // Try to clean up by content match in case insert worked but id wasn't returned
    try {
      await fetch(
        `${url}/rest/v1/memory?content=eq.${encodeURIComponent(testContent)}`,
        {
          method: "DELETE",
          headers,
        }
      );
    } catch {
      // Best effort cleanup
    }
  }

  // Summary
  console.log(`\n${bold("  Connection Status:")} ${green("Supabase is reachable")}`);
  console.log("");
}

// Nur als Skript: der Import (Tests) liest keine .env und schreibt keine Testzeile
if (import.meta.main) main().catch((err) => {
  console.error(`\n  ${red("Fatal error:")} ${err.message}`);
  process.exit(1);
});
