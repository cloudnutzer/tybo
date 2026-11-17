/**
 * Migrationen für Supabase auf diesem Rechner (Issue #560).
 *
 * Ein Update bringt neue Dateien in db/migrations/, aber keine neuen
 * Tabellen. `tybo datenbank start` (auch der Dienst ai.tybo.supabase bzw.
 * tybo-supabase) spielt darum nach dem Start und der Schutzprüfung ein, was
 * fehlt, und verbucht es in supabase_migrations.schema_migrations (dieselbe
 * Tabelle wie in der Cloud und bei der Supabase CLI, Name wie
 * migrationName()).
 *
 * - Reihenfolge wie SCHEMA_FILES; die erste gescheiterte Datei beendet den
 *   Lauf. Der nächste Start setzt anhand der Historie fort; bei einer Lücke
 *   kann er dafür bereits eingespielte Dateien wiederholen (siehe unten).
 * - Jede Datei in einer Transaktion, neue Dateien am Ende zusammen mit ihrer
 *   Verbuchung: Scheitert das Verbuchen (etwa weil die Zeitmarke schon
 *   vergeben ist), gilt auch diese Datei als nicht eingespielt. Spätere Dateien
 *   laufen dann nicht. Sonst stünde eine ältere Datei ohne Eintrag zwischen
 *   verbuchten neueren, und der nächste Start spielte sie allein ein: Sie
 *   ersetzte Funktionen, die eine neuere Datei geändert hat (etwa
 *   embedding_fact_vectors ohne den Archivfilter aus
 *   20261031_memory_archive.sql).
 * - Ab der ersten unverbuchten Datei läuft jede spätere erneut, auch eine
 *   schon verbuchte (verbucht wird nur, was fehlt). Eine Lücke in der
 *   Historie (etwa eine neue Datei mit älterem Datum) spielt so nie eine
 *   ältere Datei hinter neueren ein. Alle Dateien sind wiederholbar.
 * - Die fehlenden Einträge eines solchen Nachlaufs verbucht erst die
 *   Transaktion der letzten schon verbuchten Datei. Scheitert eine Datei
 *   vorher, bleibt die Lücke, und der nächste Lauf wiederholt den ganzen
 *   Nachlauf. Sonst wirkte die Historie vollständig, während eine erneut
 *   gelaufene ältere Datei Funktionen auf ihren Stand zurückgesetzt hat.
 * - Denselben Weg nimmt `tybo setup datenbank` (lokal): Ein erneutes Setup
 *   spielt nicht alles noch einmal ein, und ein Teilfehler hinterlässt eine
 *   Historie, die zum Stand der Datenbank passt.
 * - db/schema.sql nur bei einer leeren Datenbank (keine Tabelle messages).
 *   Isoliert erneut eingespielt setzte es Suchfunktionen und Policies auf die
 *   Grundfassung zurück, die spätere Migrationen ersetzt haben.
 * - Bestand ohne Historie (eingerichtet, bevor `tybo setup` verbuchte): Die
 *   Historie ist leer, also laufen alle Migrationen einmal in Reihenfolge
 *   durch und werden verbucht; danach ist der Stand wie nach einer frischen
 *   Einrichtung. Beim zweiten Start gibt es nichts mehr zu tun.
 * - Nach mindestens einer Datei lädt PostgREST das Schema neu.
 * - Ein Lauf je Datenbank: Setup und Datenbankstart können sich überlappen
 *   (etwa der Dienst startet, während jemand `tybo setup datenbank`
 *   ausführt). Jeder Lauf nimmt darum vor dem Lesen der Historie eine
 *   Sperre in Postgres (pg_try_advisory_lock, gilt für die Verbindung) und
 *   gibt sie erst nach dem letzten Einspielen frei; endet die Verbindung,
 *   gibt Postgres sie selbst frei. Ein zweiter Lauf wartet, bis der erste
 *   fertig ist, und plant dann mit der Historie, die dieser hinterlassen
 *   hat. Sonst spielte er nach einem fertigen Lauf ältere Dateien aus seinem
 *   veralteten Plan ein (etwa embedding_fact_vectors ohne Archivfilter), und
 *   die Historie wirkte trotzdem vollständig. Jede Transaktion prüft vor
 *   dem Festschreiben, dass ihre Verbindung die Sperre noch hält; nach einer
 *   neu aufgebauten Verbindung scheitert sie, statt ungesperrt
 *   einzuspielen.
 * - Vorbedingungen gehören in denselben gesperrten Ablauf, nach dem Lesen
 *   der Historie und vor der ersten Datei. Das gilt auch für Wiederholungen:
 *   20260909_security_knowledge.sql stellt den festen Ordner tybo-assets
 *   privat. Ist er öffentlich oder nicht prüfbar, läuft keine Datei. Ein
 *   eigener Bilder-Ordner der Einrichtung wird hier ebenfalls geprüft.
 *
 * Fehlertexte von Postgres gehen nie weiter (sie könnten Teile der
 * Verbindung nennen), genannt wird nur der Dateiname.
 */

import { join } from "node:path";
import type { SqlSession } from "./local-supabase";
import { bucketStateSql, LIST_MIGRATIONS_SQL, MIGRATIONS_TABLE_SQL, migrationName, migrationVersion, RELOAD_SCHEMA_SQL, recordMigrationSql, SCHEMA_FILES } from "./supabase-schema";

const BASE_SCHEMA = "db/schema.sql";
const SECURITY_MIGRATION = "db/migrations/20260909_security_knowledge.sql";

/** Prüft ohne Wirkung, ob die Datenbank leer ist (Grundtabelle messages fehlt) */
export const EMPTY_DATABASE_SQL = "select to_regclass('public.messages') is null as empty;";

/**
 * Schlüssel der Sperre (pg_advisory_lock mit zwei int4): „tybo“ als Zahl und
 * die Nummer des Issues. Fest, damit Setup und Datenbankstart dieselbe nehmen.
 */
const LOCK_KEY = "1954112111, 560";

/** Sperre versuchen, ohne zu warten; locked true, wenn diese Verbindung sie hält */
export const MIGRATION_LOCK_SQL = `select pg_try_advisory_lock(${LOCK_KEY}) as locked;`;
export const MIGRATION_UNLOCK_SQL = `select pg_advisory_unlock(${LOCK_KEY});`;
/**
 * Läuft in jeder Transaktion mit: scheitert, wenn die Verbindung die Sperre
 * nicht mehr hält (etwa nach einem Neuaufbau), damit nichts ungesperrt
 * festgeschrieben wird
 */
export const MIGRATION_LOCK_HELD_SQL =
  "do $$ begin if not exists (select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid() and classid = 1954112111 and objid = 560 and objsubid = 2 and granted) then raise exception 'tybo: Migrationssperre nicht gehalten'; end if; end $$;";

/** Wie lange ein Lauf auf einen anderen wartet, und in welchen Abständen er nachsieht */
export const MIGRATION_LOCK_WAIT_MS = 10 * 60 * 1000;
export const MIGRATION_LOCK_POLL_MS = 1000;

/** Eine unerfüllte Vorbedingung verhindert den gesamten Nachlauf, ohne eine Datei einzuspielen */
export interface LocalMigrationBlock {
  reason: "public-bucket" | "bucket-unreadable";
  bucket: string;
}

export type LocalMigrationResult =
  | { ok: true; applied: string[] }
  /**
   * failed: Datei, die scheiterte; fehlt, wenn schon das Lesen der Historie
   * scheiterte. busy: ein anderer Lauf hielt die Sperre länger als
   * MIGRATION_LOCK_WAIT_MS, nichts ist eingespielt
   */
  | { ok: false; applied: string[]; failed?: string; aborted?: true; busy?: true; blocked?: LocalMigrationBlock };

/** Die Anweisungen einzeln, damit jede Sitzung sie ohne Mehrfach-Anweisung ausführt */
function statements(sql: string): string[] {
  return sql
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
}

export interface MigrationHistory {
  /** Verbuchte Namen wie migrationName() */
  names: Set<string>;
  /** Vergebene Zeitmarken (Primärschlüssel der Tabelle) */
  versions: Set<string>;
}

/** Historie lesen; legt die Tabelle an, wenn sie fehlt */
export async function migrationHistory(session: SqlSession): Promise<MigrationHistory> {
  for (const s of statements(MIGRATIONS_TABLE_SQL)) await session.query(s);
  const rows = await session.query(LIST_MIGRATIONS_SQL);
  const texts = (key: string) => new Set(rows.map(r => r[key]).filter((n): n is string => typeof n === "string"));
  return { names: texts("name"), versions: texts("version") };
}

/**
 * Freie Zeitmarken ab now, je Aufruf eine Sekunde weiter; übergeht, was die
 * Historie schon vergeben hat (etwa ein zweiter Start in derselben Minute).
 * Vergibt jemand gleichzeitig dieselbe Zeitmarke, scheitert das Verbuchen
 * (recordMigrationSql ohne „on conflict“).
 */
export function versionAllocator(taken: Set<string>, now: Date): () => string {
  const used = new Set(taken);
  let offset = 0;
  return () => {
    let version = migrationVersion(now, offset++);
    while (used.has(version)) version = migrationVersion(now, offset++);
    used.add(version);
    return version;
  };
}

/** Eine eingespielte Datei verbuchen; wirft, auch wenn die Zeitmarke schon vergeben ist */
export async function recordMigration(session: SqlSession, file: string, version: string): Promise<void> {
  await session.query(recordMigrationSql(version, migrationName(file)));
}

export interface ApplyMissingOptions {
  session: SqlSession;
  root: string;
  now: () => Date;
  signal?: AbortSignal;
  /** Bilder-Ordner der Einrichtung: auch ohne offene Migration prüfen */
  bucket?: string;
  /** Fortschritt je Datei */
  onFile?: (file: string) => void;
  /** Schema nach eingespielten Dateien neu laden; Standard true (tybo setup lädt selbst neu) */
  reload?: boolean;
  /** Warten auf die Sperre; Standard setTimeout, endet früher bei signal */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Einmal, wenn ein anderer Lauf die Sperre hält und dieser wartet */
  onWait?: () => void;
  /** Höchstens so lange warten; Standard MIGRATION_LOCK_WAIT_MS */
  lockWaitMs?: number;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>(resolve => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });

/** Sperre nehmen, bei Bedarf warten; "busy" nach Ablauf der Wartezeit, wirft bei Fehlern */
async function acquireLock(o: ApplyMissingOptions): Promise<"locked" | "busy" | "aborted"> {
  const sleep = o.sleep ?? defaultSleep;
  const attempts = Math.max(1, Math.ceil((o.lockWaitMs ?? MIGRATION_LOCK_WAIT_MS) / MIGRATION_LOCK_POLL_MS));
  for (let i = 0; i <= attempts; i++) {
    if (o.signal?.aborted) return "aborted";
    if ((await o.session.query(MIGRATION_LOCK_SQL))[0]?.locked === true) return "locked";
    if (i === 0) o.onWait?.();
    if (i < attempts) await sleep(MIGRATION_LOCK_POLL_MS, o.signal);
  }
  return "busy";
}

/**
 * Was einzuspielen ist: ab der ersten unverbuchten Datei (Reihenfolge wie
 * SCHEMA_FILES) alle späteren, db/schema.sql nur bei einer leeren Datenbank.
 * record: ob die Datei noch verbucht werden muss
 */
export function pendingMigrations(names: Set<string>, empty: boolean): Array<{ file: string; record: boolean }> {
  const files = SCHEMA_FILES.filter(file => file !== BASE_SCHEMA || empty);
  const first = files.findIndex(file => !names.has(migrationName(file)));
  if (first < 0) return [];
  return files.slice(first).map(file => ({ file, record: !names.has(migrationName(file)) }));
}

/** Unter der Migrationssperre: betroffene Ordner prüfen, bevor irgendeine Datei läuft */
async function checkBuckets(o: ApplyMissingOptions, pending: Array<{ file: string }>): Promise<LocalMigrationBlock | undefined> {
  const buckets = new Set(o.bucket ? [o.bucket] : []);
  // Die SQL-Datei verwendet den festen Namen, unabhängig von SUPABASE_ASSETS_BUCKET.
  if (pending.some(p => p.file === SECURITY_MIGRATION)) buckets.add("tybo-assets");
  for (const bucket of buckets) {
    if (o.signal?.aborted) return;
    try {
      const rows = await o.session.query(bucketStateSql(bucket));
      if (rows.some(row => row.public === true)) return { reason: "public-bucket", bucket };
      if (rows.length > 1 || (rows.length === 1 && rows[0].public !== false)) return { reason: "bucket-unreadable", bucket };
    } catch {
      return { reason: "bucket-unreadable", bucket };
    }
  }
}

/**
 * Fehlende Dateien einspielen und verbuchen, unter der Sperre (Lesen der
 * Historie bis zur letzten Datei); wirft nie
 */
export async function applyMissingMigrations(o: ApplyMissingOptions): Promise<LocalMigrationResult> {
  let lock: "locked" | "busy" | "aborted";
  try {
    lock = await acquireLock(o);
  } catch {
    return o.signal?.aborted ? { ok: false, applied: [], aborted: true } : { ok: false, applied: [] };
  }
  if (lock === "aborted") return { ok: false, applied: [], aborted: true };
  if (lock === "busy") return { ok: false, applied: [], busy: true };
  try {
    return await applyLocked(o);
  } finally {
    try {
      await o.session.query(MIGRATION_UNLOCK_SQL);
    } catch {
      // Endet die Verbindung, gibt Postgres die Sperre selbst frei
    }
  }
}

async function applyLocked(o: ApplyMissingOptions): Promise<LocalMigrationResult> {
  const applied: string[] = [];
  let history: MigrationHistory;
  let empty: boolean;
  try {
    history = await migrationHistory(o.session);
    // Nur ein ausdrückliches true heißt leer; alles andere schützt db/schema.sql
    empty = (await o.session.query(EMPTY_DATABASE_SQL))[0]?.empty === true;
  } catch {
    return o.signal?.aborted ? { ok: false, applied, aborted: true } : { ok: false, applied };
  }
  const nextVersion = versionAllocator(history.versions, o.now());
  const pending = pendingMigrations(history.names, empty);
  const blocked = await checkBuckets(o, pending);
  if (o.signal?.aborted) return { ok: false, applied, aborted: true };
  if (blocked) return { ok: false, applied, blocked };
  // Nachlauf nach einer Lücke: Bis zur letzten schon verbuchten Datei bleibt
  // das Verbuchen aufgeschoben und geschieht erst mit ihr. Scheitert eine
  // Datei davor, bleibt die Lücke in der Historie und der nächste Lauf
  // wiederholt den ganzen Nachlauf (sonst wirkte die Historie vollständig,
  // während etwa der Archivfilter fehlt)
  const lastReplay = pending.map(p => p.record).lastIndexOf(false);
  let deferred: string[] = [];
  for (const [i, { file, record }] of pending.entries()) {
    if (o.signal?.aborted) return { ok: false, applied, aborted: true };
    o.onFile?.(file);
    if (record) deferred.push(file);
    const recordNow = i >= lastReplay ? deferred : [];
    try {
      // Einspielen und Verbuchen gemeinsam: scheitert eins, gilt keins; ohne
      // gehaltene Sperre scheitert die ganze Transaktion
      await o.session.fileInTransaction(join(o.root, file), [
        MIGRATION_LOCK_HELD_SQL,
        ...recordNow.map(f => recordMigrationSql(nextVersion(), migrationName(f))),
      ]);
      if (recordNow.length) deferred = [];
    } catch {
      return o.signal?.aborted ? { ok: false, applied, failed: file, aborted: true } : { ok: false, applied, failed: file };
    }
    applied.push(file);
  }
  if (applied.length && o.reload !== false) {
    try {
      await o.session.query(RELOAD_SCHEMA_SQL);
    } catch {
      // PostgREST lädt das Schema spätestens beim nächsten Neustart; die Probe des Bots meldet sonst die Lücke
    }
  }
  return { ok: true, applied };
}
