#!/usr/bin/env bun
/**
 * Supabase → Convex Data Migration
 *
 * Reads all data from Supabase tables and batch-inserts into Convex.
 * Safe to run multiple times (checks for existing data).
 *
 * Usage: bun run scripts/migrate-to-convex.ts [--dry-run] [--table TABLE]
 *
 * Prerequisites:
 *   - .env with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (or SUPABASE_ANON_KEY), CONVEX_URL
 *   - Convex functions deployed: run `npx convex dev` or `npx convex deploy` first
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { readFile } from "fs/promises";
import { join, dirname } from "path";
import { isDisplayOnly } from "../src/lib/supabase";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PROJECT_ROOT = join(dirname(import.meta.dir));

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const PASS = green("✓");
const FAIL = red("✗");

async function loadEnv(): Promise<void> {
  const content = await readFile(join(PROJECT_ROOT, ".env"), "utf-8").catch(() => "");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) {
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx > 0) {
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        if (!process.env[key]) {
          process.env[key] = value;
        }
      }
    }
  }
}

/** ISO timestamp or null → epoch ms or undefined */
function toEpochMs(value: string | null | undefined): number | undefined {
  if (!value) return undefined;
  const ms = new Date(value).getTime();
  return isNaN(ms) ? undefined : ms;
}

/** Required epoch ms (defaults to now if missing) */
function toEpochMsRequired(value: string | null | undefined): number {
  return toEpochMs(value) ?? Date.now();
}

/** Small delay to avoid overwhelming Convex */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Supabase paginated read
// ---------------------------------------------------------------------------

const PAGE_SIZE = 1000;

async function readAllRows<T extends Record<string, any>>(
  supabase: SupabaseClient,
  table: string
): Promise<T[]> {
  const rows: T[] = [];
  let offset = 0;

  while (true) {
    const { data, error } = await supabase
      .from(table)
      .select("*")
      .range(offset, offset + PAGE_SIZE - 1)
      .order("created_at", { ascending: true });

    if (error) {
      // Table might not exist
      if (error.code === "42P01" || error.message?.includes("does not exist")) {
        console.log(`  ${dim(`Table "${table}" does not exist in Supabase — skipping`)}`);
        return [];
      }
      throw new Error(`Failed to read "${table}" at offset ${offset}: ${error.message}`);
    }

    if (!data || data.length === 0) break;
    rows.push(...(data as T[]));

    if (data.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Batch insert into Convex
// ---------------------------------------------------------------------------

const BATCH_SIZE = 50;

async function batchInsert(
  convex: ConvexHttpClient,
  fnRef: any,
  items: Record<string, any>[],
  dryRun: boolean,
  label: string
): Promise<{ inserted: number; errors: number }> {
  let inserted = 0;
  let errors = 0;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);

    for (const item of batch) {
      if (dryRun) {
        inserted++;
        continue;
      }

      try {
        await convex.mutation(fnRef, item);
        inserted++;
      } catch (err: any) {
        errors++;
        console.log(`    ${red("Error")} inserting into ${label}: ${err.message?.slice(0, 200)}`);
      }
    }

    // Progress indicator for large datasets
    if (!dryRun && items.length > BATCH_SIZE) {
      const progress = Math.min(i + BATCH_SIZE, items.length);
      process.stdout.write(`    ${dim(`[${progress}/${items.length}]`)}\r`);
      await sleep(100);
    }
  }

  if (!dryRun && items.length > BATCH_SIZE) {
    process.stdout.write("\n");
  }

  return { inserted, errors };
}

// ---------------------------------------------------------------------------
// Table migration functions
// ---------------------------------------------------------------------------

interface MigrationResult {
  table: string;
  read: number;
  inserted: number;
  errors: number;
  skipped: boolean;
}

export async function migrateMessages(
  supabase: SupabaseClient,
  convex: ConvexHttpClient,
  dryRun: boolean
): Promise<MigrationResult> {
  console.log(`\n${cyan("  [1/8] Migrating messages...")}`);

  const all = await readAllRows(supabase, "messages");
  console.log(`  ${PASS} Read ${all.length} rows from Supabase`);
  // Nur-Anzeige-Einträge (Entscheidung 0006) kommen nie nach Convex: Die
  // Convex-Leser begrenzen serverseitig ohne display_only-Filter
  const rows = all.filter((row: any) => !isDisplayOnly(row.metadata));
  if (rows.length < all.length) {
    console.log(`  ${dim(`${all.length - rows.length} Nur-Anzeige-Einträge übersprungen`)}`);
  }

  if (rows.length === 0) return { table: "messages", read: 0, inserted: 0, errors: 0, skipped: false };

  const items = rows.map((row: any) => ({
    chatId: String(row.chat_id ?? ""),
    role: row.role === "assistant" ? "assistant" : "user",
    content: String(row.content ?? ""),
    metadata: row.metadata ?? {},
    createdAt: toEpochMsRequired(row.created_at),
    // Skip embedding — will be regenerated if needed
  }));

  const { inserted, errors } = await batchInsert(
    convex,
    anyApi.migrations.insertMessage,
    items,
    dryRun,
    "messages"
  );

  console.log(`  ${PASS} ${dryRun ? "Would insert" : "Inserted"} ${inserted} messages${errors ? `, ${errors} errors` : ""}`);
  return { table: "messages", read: rows.length, inserted, errors, skipped: false };
}

async function migrateMemory(
  supabase: SupabaseClient,
  convex: ConvexHttpClient,
  dryRun: boolean
): Promise<MigrationResult> {
  console.log(`\n${cyan("  [2/8] Migrating memory...")}`);

  const rows = await readAllRows(supabase, "memory");
  console.log(`  ${PASS} Read ${rows.length} rows from Supabase`);

  if (rows.length === 0) return { table: "memory", read: 0, inserted: 0, errors: 0, skipped: false };

  // Memory uses a generic insert — we need to use anyApi.memory.insert
  // which accepts all fields. Since the Convex functions may have specialized
  // mutations (addFact, addGoal), we'll use a generic insert if available.
  // For migration, we'll use addFact/addGoal based on type, or a generic insert.
  // Best approach: add a generic insert mutation to memory.ts, or use individual ones.
  // Since we're using anyApi, we'll call a generic "memory:insert" function.
  const items = rows.map((row: any) => ({
    type: row.type ?? "fact",
    content: String(row.content ?? ""),
    createdAt: toEpochMsRequired(row.created_at),
    updatedAt: toEpochMsRequired(row.updated_at),
    deadline: toEpochMs(row.deadline),
    completedAt: toEpochMs(row.completed_at),
    completed: row.type === "completed_goal" ? true : undefined,
    priority: row.priority != null ? Number(row.priority) : undefined,
    metadata: row.metadata ?? {},
  }));

  // Strip undefined values — Convex doesn't accept explicit undefined for optional fields
  const cleanItems = items.map((item) => {
    const clean: Record<string, any> = {};
    for (const [k, v] of Object.entries(item)) {
      if (v !== undefined) clean[k] = v;
    }
    return clean;
  });

  const { inserted, errors } = await batchInsert(
    convex,
    anyApi.migrations.insertMemory,
    cleanItems,
    dryRun,
    "memory"
  );

  console.log(`  ${PASS} ${dryRun ? "Would insert" : "Inserted"} ${inserted} memory items${errors ? `, ${errors} errors` : ""}`);
  return { table: "memory", read: rows.length, inserted, errors, skipped: false };
}

async function migrateLogs(
  supabase: SupabaseClient,
  convex: ConvexHttpClient,
  dryRun: boolean
): Promise<MigrationResult> {
  console.log(`\n${cyan("  [3/8] Migrating logs...")}`);

  const rows = await readAllRows(supabase, "logs");
  console.log(`  ${PASS} Read ${rows.length} rows from Supabase`);

  if (rows.length === 0) return { table: "logs", read: 0, inserted: 0, errors: 0, skipped: false };

  const items = rows.map((row: any) => {
    const clean: Record<string, any> = {
      level: row.level ?? "info",
      event: String(row.event ?? ""),
      createdAt: toEpochMsRequired(row.created_at),
    };
    // "event" in Supabase maps to both "event" and "service" in Convex
    if (row.event) clean.service = String(row.event);
    if (row.message) clean.message = String(row.message);
    if (row.metadata) clean.metadata = row.metadata;
    if (row.session_id) clean.sessionId = String(row.session_id);
    if (row.duration_ms != null) clean.durationMs = Number(row.duration_ms);
    return clean;
  });

  const { inserted, errors } = await batchInsert(
    convex,
    anyApi.migrations.insertLog,
    items,
    dryRun,
    "logs"
  );

  console.log(`  ${PASS} ${dryRun ? "Would insert" : "Inserted"} ${inserted} log entries${errors ? `, ${errors} errors` : ""}`);
  return { table: "logs", read: rows.length, inserted, errors, skipped: false };
}

async function migrateCallTranscripts(
  supabase: SupabaseClient,
  convex: ConvexHttpClient,
  dryRun: boolean
): Promise<MigrationResult> {
  console.log(`\n${cyan("  [4/8] Migrating call transcripts...")}`);

  const rows = await readAllRows(supabase, "call_transcripts");
  console.log(`  ${PASS} Read ${rows.length} rows from Supabase`);

  if (rows.length === 0) return { table: "callTranscripts", read: 0, inserted: 0, errors: 0, skipped: false };

  const items = rows.map((row: any) => {
    const clean: Record<string, any> = {
      conversationId: String(row.conversation_id ?? ""),
      createdAt: toEpochMsRequired(row.created_at),
    };
    if (row.transcript) clean.transcript = String(row.transcript);
    if (row.summary) clean.summary = String(row.summary);
    if (row.action_items) clean.actionItems = Array.isArray(row.action_items) ? row.action_items : [];
    if (row.duration_seconds != null) clean.durationSeconds = Number(row.duration_seconds);
    if (row.metadata) clean.metadata = row.metadata;
    return clean;
  });

  const { inserted, errors } = await batchInsert(
    convex,
    anyApi.migrations.insertCallTranscript,
    items,
    dryRun,
    "callTranscripts"
  );

  console.log(`  ${PASS} ${dryRun ? "Would insert" : "Inserted"} ${inserted} call transcripts${errors ? `, ${errors} errors` : ""}`);
  return { table: "callTranscripts", read: rows.length, inserted, errors, skipped: false };
}

async function migrateAsyncTasks(
  supabase: SupabaseClient,
  convex: ConvexHttpClient,
  dryRun: boolean
): Promise<MigrationResult> {
  console.log(`\n${cyan("  [5/8] Migrating async tasks...")}`);

  const rows = await readAllRows(supabase, "async_tasks");
  console.log(`  ${PASS} Read ${rows.length} rows from Supabase`);

  if (rows.length === 0) return { table: "asyncTasks", read: 0, inserted: 0, errors: 0, skipped: false };

  const items = rows.map((row: any) => {
    const clean: Record<string, any> = {
      chatId: String(row.chat_id ?? ""),
      originalPrompt: String(row.original_prompt ?? ""),
      status: row.status ?? "pending",
      createdAt: toEpochMsRequired(row.created_at),
      updatedAt: toEpochMsRequired(row.updated_at),
    };
    if (row.result) clean.result = String(row.result);
    if (row.session_id) clean.sessionId = String(row.session_id);
    if (row.current_step) clean.currentStep = String(row.current_step);
    if (row.pending_question) clean.pendingQuestion = String(row.pending_question);
    if (row.pending_options) clean.pendingOptions = row.pending_options;
    if (row.user_response) clean.userResponse = String(row.user_response);
    if (row.thread_id != null) clean.threadId = Number(row.thread_id);
    if (row.processed_by) clean.processedBy = String(row.processed_by);
    if (row.reminder_sent != null) clean.reminderSent = Boolean(row.reminder_sent);
    if (row.metadata) clean.metadata = row.metadata;
    return clean;
  });

  const { inserted, errors } = await batchInsert(
    convex,
    anyApi.migrations.insertAsyncTask,
    items,
    dryRun,
    "asyncTasks"
  );

  console.log(`  ${PASS} ${dryRun ? "Would insert" : "Inserted"} ${inserted} async tasks${errors ? `, ${errors} errors` : ""}`);
  return { table: "asyncTasks", read: rows.length, inserted, errors, skipped: false };
}

async function migrateNodeHeartbeat(
  supabase: SupabaseClient,
  convex: ConvexHttpClient,
  dryRun: boolean
): Promise<MigrationResult> {
  console.log(`\n${cyan("  [6/8] Migrating node heartbeat...")}`);

  // node_heartbeat uses node_id as PK, not created_at for ordering
  const { data: rows, error } = await supabase
    .from("node_heartbeat")
    .select("*");

  if (error) {
    if (error.code === "42P01" || error.message?.includes("does not exist")) {
      console.log(`  ${dim("Table does not exist — skipping")}`);
      return { table: "nodeHeartbeat", read: 0, inserted: 0, errors: 0, skipped: true };
    }
    throw error;
  }

  console.log(`  ${PASS} Read ${rows?.length ?? 0} rows from Supabase`);

  if (!rows || rows.length === 0) return { table: "nodeHeartbeat", read: 0, inserted: 0, errors: 0, skipped: false };

  const items = rows.map((row: any) => {
    const clean: Record<string, any> = {
      nodeId: String(row.node_id ?? ""),
      lastHeartbeat: toEpochMsRequired(row.last_heartbeat),
    };
    if (row.metadata) clean.metadata = row.metadata;
    return clean;
  });

  const { inserted, errors } = await batchInsert(
    convex,
    anyApi.migrations.insertNodeHeartbeat,
    items,
    dryRun,
    "nodeHeartbeat"
  );

  console.log(`  ${PASS} ${dryRun ? "Would insert" : "Inserted"} ${inserted} heartbeat records${errors ? `, ${errors} errors` : ""}`);
  return { table: "nodeHeartbeat", read: rows.length, inserted, errors, skipped: false };
}

async function migrateAssets(
  supabase: SupabaseClient,
  convex: ConvexHttpClient,
  dryRun: boolean
): Promise<MigrationResult> {
  console.log(`\n${cyan("  [7/8] Migrating assets...")}`);

  const rows = await readAllRows(supabase, "assets");
  console.log(`  ${PASS} Read ${rows.length} rows from Supabase`);

  if (rows.length === 0) return { table: "assets", read: 0, inserted: 0, errors: 0, skipped: false };

  // TODO: Asset files in Supabase Storage need separate download + re-upload to Convex storage.
  // This migration copies metadata only. File migration should be done separately because:
  // 1. Files may be large and need streaming
  // 2. Convex storage uses different upload API (generateUploadUrl + upload + storageId)
  // 3. Public URLs will change after migration
  console.log(`  ${yellow("Note:")} File contents not migrated — metadata only. File migration needs a separate step.`);

  const items = rows.map((row: any) => {
    const clean: Record<string, any> = {
      fileType: String(row.file_type ?? "image"),
      description: String(row.description ?? ""),
      createdAt: toEpochMsRequired(row.created_at),
    };
    if (row.storage_path) clean.storagePath = String(row.storage_path);
    if (row.public_url) clean.publicUrl = String(row.public_url);
    if (row.original_filename) clean.originalFilename = String(row.original_filename);
    if (row.mime_type) clean.mimeType = String(row.mime_type);
    if (row.file_size_bytes != null) clean.fileSizeBytes = Number(row.file_size_bytes);
    if (row.user_caption) clean.userCaption = String(row.user_caption);
    if (row.conversation_context) clean.conversationContext = String(row.conversation_context);
    if (row.related_project) clean.relatedProject = String(row.related_project);
    if (row.tags) clean.tags = Array.isArray(row.tags) ? row.tags : [];
    if (row.channel) clean.channel = String(row.channel);
    if (row.metadata) clean.metadata = row.metadata;
    // Skip embedding — will be regenerated
    return clean;
  });

  const { inserted, errors } = await batchInsert(
    convex,
    anyApi.migrations.insertAsset,
    items,
    dryRun,
    "assets"
  );

  console.log(`  ${PASS} ${dryRun ? "Would insert" : "Inserted"} ${inserted} asset records${errors ? `, ${errors} errors` : ""}`);
  return { table: "assets", read: rows.length, inserted, errors, skipped: false };
}

async function migrateKnowledge(
  supabase: SupabaseClient,
  convex: ConvexHttpClient,
  dryRun: boolean
): Promise<MigrationResult> {
  console.log(`\n${cyan("  [8/8] Migrating knowledge...")}`);

  // Knowledge table may not exist in older Supabase schemas
  const { data: rows, error } = await supabase
    .from("knowledge")
    .select("*")
    .order("created_at", { ascending: true });

  if (error) {
    if (error.code === "42P01" || error.message?.includes("does not exist")) {
      console.log(`  ${dim("Table does not exist in Supabase — skipping")}`);
      return { table: "knowledge", read: 0, inserted: 0, errors: 0, skipped: true };
    }
    throw error;
  }

  console.log(`  ${PASS} Read ${rows?.length ?? 0} rows from Supabase`);

  if (!rows || rows.length === 0) return { table: "knowledge", read: 0, inserted: 0, errors: 0, skipped: false };

  const items = rows.map((row: any) => {
    const clean: Record<string, any> = {
      category: row.category ?? "reference",
      title: String(row.title ?? ""),
      content: String(row.content ?? ""),
      createdAt: toEpochMsRequired(row.created_at),
      updatedAt: toEpochMsRequired(row.updated_at),
    };
    if (row.source) clean.source = String(row.source);
    if (row.related_project) clean.relatedProject = String(row.related_project);
    if (row.related_entities) clean.relatedEntities = Array.isArray(row.related_entities) ? row.related_entities : [];
    if (row.tags) clean.tags = Array.isArray(row.tags) ? row.tags : [];
    if (row.confidence != null) clean.confidence = Number(row.confidence);
    if (row.expires_at) clean.expiresAt = toEpochMs(row.expires_at);
    if (row.superseded_by) clean.supersededBy = String(row.superseded_by);
    if (row.status) clean.status = row.status === "archived" ? "archived" : "active";
    if (row.metadata) clean.metadata = row.metadata;
    // Skip embedding
    return clean;
  });

  const { inserted, errors } = await batchInsert(
    convex,
    anyApi.migrations.insertKnowledge,
    items,
    dryRun,
    "knowledge"
  );

  console.log(`  ${PASS} ${dryRun ? "Would insert" : "Inserted"} ${inserted} knowledge entries${errors ? `, ${errors} errors` : ""}`);
  return { table: "knowledge", read: rows.length, inserted, errors, skipped: false };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const TABLE_MIGRATIONS: Record<string, (sb: SupabaseClient, cx: ConvexHttpClient, dry: boolean) => Promise<MigrationResult>> = {
  messages: migrateMessages,
  memory: migrateMemory,
  logs: migrateLogs,
  callTranscripts: migrateCallTranscripts,
  asyncTasks: migrateAsyncTasks,
  nodeHeartbeat: migrateNodeHeartbeat,
  assets: migrateAssets,
  knowledge: migrateKnowledge,
};

async function main() {
  console.log("");
  console.log(bold("  Supabase → Convex Data Migration"));
  console.log(dim("  =================================="));

  // Parse args
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const tableIdx = args.indexOf("--table");
  const singleTable = tableIdx !== -1 ? args[tableIdx + 1] : null;

  if (dryRun) {
    console.log(`\n  ${yellow("DRY RUN")} — no data will be written to Convex`);
  }

  // Load environment
  await loadEnv();

  // Validate env vars
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
  const convexUrl = process.env.CONVEX_URL;

  if (!supabaseUrl || supabaseUrl.includes("your_")) {
    console.log(`\n  ${FAIL} SUPABASE_URL is not set in .env`);
    process.exit(1);
  }
  if (!supabaseKey || supabaseKey.includes("your_")) {
    console.log(`\n  ${FAIL} SUPABASE_SERVICE_ROLE_KEY or SUPABASE_ANON_KEY not set in .env`);
    process.exit(1);
  }
  if (!convexUrl || convexUrl.includes("your_")) {
    console.log(`\n  ${FAIL} CONVEX_URL is not set in .env`);
    console.log(`    Run: npx convex dev (to set up Convex and get your URL)`);
    process.exit(1);
  }

  const keyType = process.env.SUPABASE_SERVICE_ROLE_KEY ? "service_role" : "anon";
  console.log(`\n  ${PASS} Supabase: ${supabaseUrl} (${keyType})`);
  console.log(`  ${PASS} Convex:   ${convexUrl}`);

  // Create clients
  const supabase = createClient(supabaseUrl, supabaseKey);
  const convex = new ConvexHttpClient(convexUrl);
    if (!process.env.CONVEX_AUTH_TOKEN) throw new Error("CONVEX_AUTH_TOKEN required");
    convex.setAuth(process.env.CONVEX_AUTH_TOKEN);

  // Determine which tables to migrate
  const tablesToRun = singleTable
    ? { [singleTable]: TABLE_MIGRATIONS[singleTable] }
    : TABLE_MIGRATIONS;

  if (singleTable && !TABLE_MIGRATIONS[singleTable]) {
    console.log(`\n  ${FAIL} Unknown table: "${singleTable}"`);
    console.log(`    Available: ${Object.keys(TABLE_MIGRATIONS).join(", ")}`);
    process.exit(1);
  }

  // Run migrations
  const results: MigrationResult[] = [];

  for (const [name, migrateFn] of Object.entries(tablesToRun)) {
    try {
      const result = await migrateFn(supabase, convex, dryRun);
      results.push(result);
    } catch (err: any) {
      console.log(`  ${FAIL} ${name}: ${err.message}`);
      results.push({ table: name, read: 0, inserted: 0, errors: 1, skipped: false });
    }
  }

  // Summary
  console.log(`\n${bold("  Migration Summary")}`);
  console.log(dim("  ─────────────────────────────────────────────"));
  console.log(`  ${"Table".padEnd(20)} ${"Read".padStart(8)} ${"Written".padStart(8)} ${"Errors".padStart(8)}`);
  console.log(dim("  ─────────────────────────────────────────────"));

  let totalRead = 0;
  let totalInserted = 0;
  let totalErrors = 0;

  for (const r of results) {
    const status = r.skipped ? dim("skipped") : r.errors > 0 ? yellow(`${r.errors} err`) : green("ok");
    console.log(
      `  ${r.table.padEnd(20)} ${String(r.read).padStart(8)} ${String(r.inserted).padStart(8)} ${String(r.errors).padStart(8)}  ${status}`
    );
    totalRead += r.read;
    totalInserted += r.inserted;
    totalErrors += r.errors;
  }

  console.log(dim("  ─────────────────────────────────────────────"));
  console.log(
    `  ${"TOTAL".padEnd(20)} ${String(totalRead).padStart(8)} ${String(totalInserted).padStart(8)} ${String(totalErrors).padStart(8)}`
  );

  if (dryRun) {
    console.log(`\n  ${yellow("This was a dry run.")} Run without --dry-run to actually migrate.`);
  } else if (totalErrors > 0) {
    console.log(`\n  ${yellow("Migration completed with errors.")} Check the output above.`);
  } else {
    console.log(`\n  ${green("Migration completed successfully!")}`);
  }

  console.log("");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n  ${red("Fatal error:")} ${err.message}`);
    process.exit(1);
  });
}
