/**
 * Schema einer neuen Supabase-Datenbank (Issue #163, gemeinsam mit #164).
 *
 * SCHEMA_FILES nennt die SQL-Dateien in der Reihenfolge, in der eine leere
 * Datenbank sie braucht. Alle sind wiederholbar (IF NOT EXISTS, CREATE OR
 * REPLACE, ON CONFLICT). Ein Test hält die Liste im Gleichlauf mit
 * db/schema.sql und db/migrations/*.sql.
 *
 * Eigene BEGIN/COMMIT-Zeilen einer Datei nimmt stripOuterTransaction()
 * heraus: Die Transaktion und das Verbuchen der Migration gehören dem, der
 * die Datei einspielt (Management-API oder der Rückfall mit eigener
 * Verbuchung), sonst läge das Verbuchen außerhalb der Transaktion der Datei.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";

export const SCHEMA_FILES = [
  "db/schema.sql",
  "db/migrations/2026-07-02-fable-topics-memory.sql",
  "db/migrations/20260909_security_knowledge.sql",
  "db/migrations/20260927_embedding_provider.sql",
  "db/migrations/20260928_embedding_reindex.sql",
] as const;

/** Name der Migration beim Anbieter: tybo_<dateiname ohne .sql>, nur a-z, 0-9 und _ */
export function migrationName(file: string): string {
  const base = basename(file).replace(/\.sql$/i, "");
  return `tybo_${base.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;
}

/**
 * Entfernt BEGIN;/COMMIT; auf eigener Zeile (die äußere Transaktion der
 * Datei). BEGIN ohne Semikolon in DO-Blöcken und Funktionen bleibt.
 */
export function stripOuterTransaction(sql: string): string {
  return sql
    .split("\n")
    .filter(line => !/^\s*(BEGIN|COMMIT|START TRANSACTION)\s*;\s*$/i.test(line))
    .join("\n")
    .trim();
}

export interface SchemaFile {
  file: string;
  name: string;
  /** SQL ohne äußere Transaktion */
  sql: string;
  /** Kurzer Hash des SQL, für stabile Idempotency-Keys */
  hash: string;
}

/** Die Schema-Dateien aus dem Projektordner, in Reihenfolge */
export async function loadSchemaFiles(root: string): Promise<SchemaFile[]> {
  const out: SchemaFile[] = [];
  for (const file of SCHEMA_FILES) {
    const sql = stripOuterTransaction(await readFile(join(root, file), "utf8"));
    out.push({ file, name: migrationName(file), sql, hash: createHash("sha256").update(sql).digest("hex").slice(0, 16) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Bilder-Ordner
// ---------------------------------------------------------------------------

/** Erlaubte Namen für den Bilder-Ordner; ohne Anführungszeichen, darum sicher im SQL */
export const BUCKET_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{2,62}$/;

export function isValidBucketName(name: string): boolean {
  return BUCKET_NAME_PATTERN.test(name);
}

/**
 * Legt den Bilder-Ordner privat an, falls er fehlt, und liefert in einer
 * Zeile, ob er öffentlich ist (Spalte public). Ein vorhandener Ordner wird
 * nicht verändert: ist er öffentlich, entscheidet der Aufrufer (Abbruch mit
 * Hinweis), statt ihn still umzustellen. Wirft bei ungültigem Namen.
 */
export function bucketSql(name: string): string {
  if (!isValidBucketName(name)) throw new Error("Ungültiger Name für den Bilder-Ordner");
  return [
    "with created as (",
    `  insert into storage.buckets (id, name, public) values ('${name}', '${name}', false)`,
    "  on conflict (id) do nothing",
    "  returning public",
    ")",
    `select coalesce((select public from created), (select public from storage.buckets where id = '${name}')) as public;`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Rückfall ohne Migrations-Endpunkt: Einspielen und Verbuchen in einem
// ---------------------------------------------------------------------------

/** Tabelle, in der auch die Management-API und die Supabase CLI Migrationen verbuchen */
export const MIGRATIONS_TABLE_SQL = [
  "create schema if not exists supabase_migrations;",
  "create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text);",
].join("\n");

export const LIST_MIGRATIONS_SQL = "select version, name from supabase_migrations.schema_migrations order by version;";

/**
 * Datei und Verbuchung in einer Transaktion: bricht die Verbindung mittendrin
 * ab, ist entweder beides geschehen oder nichts. version ist eine
 * Zeitmarke wie bei der Supabase CLI (nur Ziffern), name wie migrationName().
 */
export function recordedMigrationSql(sql: string, version: string, name: string): string {
  if (!/^\d{1,32}$/.test(version) || !/^[a-z0-9_]{1,80}$/.test(name)) throw new Error("Ungültige Migration");
  return [
    "begin;",
    sql,
    ";",
    MIGRATIONS_TABLE_SQL,
    `insert into supabase_migrations.schema_migrations (version, name) values ('${version}', '${name}') on conflict (version) do nothing;`,
    "commit;",
  ].join("\n");
}

/** Zeitmarke JJJJMMTTHHMMSS (UTC), um offset Sekunden verschoben */
export function migrationVersion(now: Date, offsetSeconds = 0): string {
  const d = new Date(now.getTime() + offsetSeconds * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/** PostgREST lädt das Schema neu, damit neue Tabellen sofort erreichbar sind */
export const RELOAD_SCHEMA_SQL = "notify pgrst, 'reload schema';";
