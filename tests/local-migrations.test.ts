// Issue #560: fehlende Migrationen für Supabase auf diesem Rechner, gegen eine
// Attrappe von Postgres (keine echte Datenbank, kein Docker).
import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyMissingMigrations, EMPTY_DATABASE_SQL, MIGRATION_LOCK_HELD_SQL, MIGRATION_LOCK_SQL, MIGRATION_UNLOCK_SQL } from "../src/setup/local-migrations";
import { EXIT_ABORTED, LOCAL_SUPABASE_URL, runDatabaseCommand, runSupabaseLocal, type SqlSession } from "../src/setup/local-supabase";
import { LIST_MIGRATIONS_SQL, migrationName, migrationVersion, RELOAD_SCHEMA_SQL, SCHEMA_FILES } from "../src/setup/supabase-schema";
import { fakeLocal, LOCAL, LOCAL_SECRETS, shortName, type FakeLocal } from "./local-supabase-fixture";
import { cleanup, FAKE, makeCtx } from "./setup-fixture";

afterAll(cleanup);

const ROOT = "/srv/tybo";
const MIGRATIONS = SCHEMA_FILES.filter(f => f !== "db/schema.sql");
const SECURITY = "db/migrations/20260909_security_knowledge.sql";
const BUCKET_QUERY = "select public from storage.buckets where id = 'tybo-assets';";

const REPO = join(import.meta.dir, "..");

/** Funktionen, die eine Datei anlegt oder ersetzt, mit ihrem Text (aus der echten Datei im Repo) */
function functionsOf(path: string): Map<string, string> {
  const file = SCHEMA_FILES.find(f => path.endsWith(f));
  const out = new Map<string, string>();
  if (!file) return out;
  const sql = readFileSync(join(REPO, file), "utf8");
  const heads = [...sql.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/gi)];
  heads.forEach((m, i) => out.set(m[1], sql.slice(m.index, heads[i + 1]?.index ?? sql.length)));
  return out;
}

/** Auch die Umstellung bestehender Bilder-Ordner kommt aus dem echten Migrationstext */
function privatizedBucketsOf(path: string): string[] {
  const file = SCHEMA_FILES.find(f => path.endsWith(f));
  if (!file) return [];
  const sql = readFileSync(join(REPO, file), "utf8");
  return [...sql.matchAll(/INSERT INTO storage\.buckets\s*\(id,\s*name,\s*public\)\s*VALUES\s*\('([^']+)',\s*'[^']+',\s*false\)\s*ON CONFLICT\s*\(id\)\s*DO UPDATE SET public\s*=\s*false/gi)].map(m => m[1]);
}

/**
 * Postgres-Attrappe mit Historie (Zeitmarke ist Primärschlüssel wie in
 * supabase_migrations.schema_migrations) und den Funktionen, die die
 * eingespielten Dateien angelegt haben. Eine Transaktion gilt ganz oder gar
 * nicht. failOn: Datei, deren Einspielen scheitert; failRecordOn: Datei,
 * deren Verbuchen scheitert (einmal); taken: schon vergebene Zeitmarken;
 * racing: Zeitmarken, die ein gleichzeitiger Lauf erst nach dem Lesen der
 * Historie vergibt (die Liste zeigt sie nicht). Die Sperre gilt wie
 * pg_advisory_lock je Verbindung: sessionFor(id) öffnet eine weitere,
 * drop(id) beendet sie (Postgres gibt ihre Sperre frei).
 */
interface FakeDbOptions {
  recorded?: string[];
  empty?: boolean;
  failOn?: string;
  failRecordOn?: string;
  taken?: string[];
  racing?: string[];
  buckets?: Record<string, boolean>;
}

/** empty und failOn gelten zum Zeitpunkt des Aufrufs, lassen sich also zwischen zwei Läufen ändern */
function fakeDb(options: FakeDbOptions = {}) {
  const versions = new Map<string, string>();
  options.recorded?.forEach((file, i) => versions.set(String(i), migrationName(file)));
  for (const v of options.taken ?? []) versions.set(v, "fremde_migration");
  const racing = new Set(options.racing ?? []);
  const history = { has: (name: string) => [...versions.values()].includes(name), names: () => [...versions.values()] };
  const functions = new Map<string, string>();
  const buckets = new Map(Object.entries(options.buckets ?? {}));
  let failRecordOn = options.failRecordOn;
  const ops: string[] = [];
  /** Verbuchen wie Postgres: vergebene Zeitmarke ist ein Fehler (unique_violation) */
  const record = (text: string, into: Map<string, string>) => {
    const m = /^insert into supabase_migrations\.schema_migrations \(version, name\) values \('(\d+)', '([a-z0-9_]+)'\)(.*)$/.exec(text);
    if (!m) return false;
    if (failRecordOn && m[2] === migrationName(failRecordOn)) {
      failRecordOn = undefined;
      throw new Error("Verbuchen gescheitert");
    }
    if (into.has(m[1])) {
      if (m[3].includes("on conflict")) return true;
      throw new Error('duplicate key value violates unique constraint "schema_migrations_pkey"');
    }
    into.set(m[1], m[2]);
    return true;
  };
  const lock = { owner: null as string | null, depth: 0 };
  const handleQuery = (text: string, id = "main"): Array<Record<string, unknown>> => {
    ops.push(`query:${text}`);
    if (text === MIGRATION_LOCK_SQL) {
      if (lock.owner !== null && lock.owner !== id) return [{ locked: false }];
      lock.owner = id;
      lock.depth++;
      return [{ locked: true }];
    }
    if (text === MIGRATION_UNLOCK_SQL) {
      const held = lock.owner === id;
      if (held && --lock.depth === 0) lock.owner = null;
      return [{ pg_advisory_unlock: held }];
    }
    if (text === LIST_MIGRATIONS_SQL) {
      const rows = [...versions].map(([version, name]) => ({ version, name }));
      for (const v of racing) versions.set(v, "gleichzeitiger_lauf");
      racing.clear();
      return rows;
    }
    if (text === EMPTY_DATABASE_SQL) return [{ empty: options.empty === true }];
    const bucket = /^select public from storage\.buckets where id = '([^']+)';$/.exec(text)?.[1];
    if (bucket) return buckets.has(bucket) ? [{ public: buckets.get(bucket) }] : [];
    record(text, versions);
    return [];
  };
  const handleFile = (path: string) => {
    ops.push(`file:${path}`);
    if (options.failOn && path.endsWith(options.failOn)) throw new Error("syntax error at or near postgresql://postgres:geheim@");
  };
  /** Datei und Verbuchung: erst alles auf einer Kopie, übernommen wird nur ohne Fehler */
  const handleTransaction = (path: string, after: string[], id = "main") => {
    handleFile(path);
    const staged = new Map(versions);
    for (const text of after) {
      ops.push(`query:${text}`);
      if (text === MIGRATION_LOCK_HELD_SQL) {
        if (lock.owner !== id) throw new Error("tybo: Migrationssperre nicht gehalten");
        continue;
      }
      if (!record(text, staged)) throw new Error("unerwartete Anweisung in der Transaktion");
    }
    for (const [k, v] of staged) versions.set(k, v);
    for (const [name, body] of functionsOf(path)) functions.set(name, body);
    for (const bucket of privatizedBucketsOf(path)) buckets.set(bucket, false);
  };
  const drop = (id: string) => {
    if (lock.owner === id) Object.assign(lock, { owner: null, depth: 0 });
  };
  const sessionFor = (id: string): SqlSession => ({
    file: async path => handleFile(path),
    fileInTransaction: async (path, after) => handleTransaction(path, after, id),
    query: async text => handleQuery(text, id),
    close: async () => drop(id),
  });
  const session = sessionFor("main");
  return { session, sessionFor, drop, lock, history, functions, buckets, ops, handleQuery, handleFile, handleTransaction, files: () => ops.filter(o => o.startsWith("file:")).map(o => o.slice(5)) };
}

const now = () => new Date("2026-11-10T12:00:00Z");

/** Funktionen wie nach allen Dateien in Reihenfolge (Bestand, ohne dass die Attrappe etwas aufzeichnet) */
function fullyMigrated(db: ReturnType<typeof fakeDb>) {
  for (const file of SCHEMA_FILES) for (const [name, body] of functionsOf(file)) db.functions.set(name, body);
  expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
}

describe("applyMissingMigrations", () => {
  test("Bestand ohne Historie: alle Migrationen einmal in Reihenfolge, db/schema.sql nicht, alles verbucht, Schema neu geladen", async () => {
    const db = fakeDb();
    const r = await applyMissingMigrations({ session: db.session, root: ROOT, now });
    expect(r).toEqual({ ok: true, applied: MIGRATIONS });
    expect(db.files()).toEqual(MIGRATIONS.map(f => join(ROOT, f)));
    expect(db.history.names().sort()).toEqual(MIGRATIONS.map(migrationName).sort());
    // Neu geladen noch unter der Sperre, danach frei
    expect(db.ops.slice(-2)).toEqual([`query:${RELOAD_SCHEMA_SQL}`, `query:${MIGRATION_UNLOCK_SQL}`]);
    expect(db.lock.owner).toBeNull();
  });

  test("zweiter Lauf: nichts eingespielt, kein Neuladen", async () => {
    const db = fakeDb();
    await applyMissingMigrations({ session: db.session, root: ROOT, now });
    db.ops.length = 0;
    expect(await applyMissingMigrations({ session: db.session, root: ROOT, now })).toEqual({ ok: true, applied: [] });
    expect(db.files()).toEqual([]);
    expect(db.ops).not.toContain(`query:${RELOAD_SCHEMA_SQL}`);
  });

  test("Update: nur die neuen Dateien (Historie aus tybo setup)", async () => {
    const neu = ["db/migrations/20261031_memory_archive.sql", "db/migrations/20261031_memory_facts_search.sql"];
    const db = fakeDb({ recorded: SCHEMA_FILES.filter(f => !neu.includes(f)) });
    expect(await applyMissingMigrations({ session: db.session, root: ROOT, now })).toEqual({ ok: true, applied: neu });
  });

  test("leere Datenbank: db/schema.sql zuerst", async () => {
    const db = fakeDb({ empty: true });
    const r = await applyMissingMigrations({ session: db.session, root: ROOT, now });
    expect(r.applied).toEqual([...SCHEMA_FILES]);
  });

  test("Teilfehler: bricht bei der gescheiterten Datei ab, Früheres bleibt verbucht, der nächste Lauf macht dort weiter", async () => {
    const bad = "db/migrations/20261018_scheduled_tasks_lease.sql";
    const db = fakeDb({ failOn: bad });
    const r = await applyMissingMigrations({ session: db.session, root: ROOT, now });
    const before = MIGRATIONS.slice(0, MIGRATIONS.indexOf(bad as never));
    expect(r).toEqual({ ok: false, applied: before, failed: bad });
    expect(db.history.has(migrationName(bad))).toBe(false);
    expect(db.files().at(-1)).toBe(join(ROOT, bad));
    // Danach repariert: genau der Rest
    const again = fakeDb({ recorded: ["db/schema.sql", ...before] });
    expect((await applyMissingMigrations({ session: again.session, root: ROOT, now })).applied).toEqual(MIGRATIONS.slice(before.length));
  });

  test("Verbuchen scheitert: Datei gilt als nicht eingespielt, Abbruch dort, spätere Dateien laufen nicht", async () => {
    const bad = "db/migrations/20260928_embedding_reindex.sql";
    const db = fakeDb({ failRecordOn: bad });
    const r = await applyMissingMigrations({ session: db.session, root: ROOT, now });
    const before = MIGRATIONS.slice(0, MIGRATIONS.indexOf(bad as never));
    expect(r).toEqual({ ok: false, applied: before, failed: bad });
    expect(db.history.has(migrationName(bad))).toBe(false);
    expect(db.files().at(-1)).toBe(join(ROOT, bad));
    expect(db.ops).not.toContain(`query:${RELOAD_SCHEMA_SQL}`);
  });

  test("vergebene Zeitmarke aus der Historie: übergangen, die Datei bekommt die nächste freie", async () => {
    const file = "db/migrations/20261031_memory_facts_search.sql";
    const db = fakeDb({ recorded: SCHEMA_FILES.filter(f => f !== file), taken: [migrationVersion(now(), 0)] });
    expect(await applyMissingMigrations({ session: db.session, root: ROOT, now })).toEqual({ ok: true, applied: [file] });
    expect(db.ops).toContain(`query:insert into supabase_migrations.schema_migrations (version, name) values ('${migrationVersion(now(), 1)}', '${migrationName(file)}');`);
  });

  test("Zeitmarke gleichzeitig vergeben: Fehler statt stillem Übergehen, die Datei ist nicht eingespielt", async () => {
    const file = "db/migrations/20261031_memory_facts_search.sql";
    const db = fakeDb({ recorded: SCHEMA_FILES.filter(f => f !== file), racing: [migrationVersion(now(), 0)] });
    const r = await applyMissingMigrations({ session: db.session, root: ROOT, now });
    expect(r).toEqual({ ok: false, applied: [], failed: file });
    expect(db.history.has(migrationName(file))).toBe(false);
  });

  test("Einspielen und Verbuchen in einer Transaktion, Verbuchen ohne „on conflict“", async () => {
    const db = fakeDb({ recorded: SCHEMA_FILES.filter(f => f !== "db/migrations/20261031_memory_facts_search.sql") });
    await applyMissingMigrations({ session: db.session, root: ROOT, now });
    const recordOps = db.ops.filter(o => o.includes("insert into supabase_migrations"));
    expect(recordOps).toEqual([`query:insert into supabase_migrations.schema_migrations (version, name) values ('${migrationVersion(now(), 0)}', 'tybo_20261031_memory_facts_search');`]);
  });

  test("Lücke in der Historie: ab der ersten unverbuchten Datei laufen alle späteren mit, verbucht wird nur die fehlende, der Archivfilter bleibt", async () => {
    const reindex = "db/migrations/20260928_embedding_reindex.sql";
    const db = fakeDb({ recorded: SCHEMA_FILES.filter(f => f !== reindex) });
    fullyMigrated(db);
    const r = await applyMissingMigrations({ session: db.session, root: ROOT, now });
    const rest = MIGRATIONS.slice(MIGRATIONS.indexOf(reindex as never));
    expect(r).toEqual({ ok: true, applied: rest });
    expect(db.files()).toEqual(rest.map(f => join(ROOT, f)));
    expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
    expect(db.ops.filter(o => o.includes("insert into supabase_migrations"))).toHaveLength(1);
    expect(db.history.names().sort()).toEqual(SCHEMA_FILES.map(migrationName).sort());
  });

  // Prüferpunkt zu #560: Lief 20260928_embedding_reindex.sql erneut und wurde
  // sofort verbucht, scheiterte danach die schon verbuchte
  // 20261015_message_chunks.sql, wirkte die Historie vollständig, und der
  // nächste Lauf meldete ok ohne Archivfilter.
  test("Lücke in der Historie plus Folgefehler: Lücke bleibt, der nächste Lauf wiederholt den Nachlauf und stellt den Archivfilter wieder her", async () => {
    const reindex = "db/migrations/20260928_embedding_reindex.sql";
    const chunks = "db/migrations/20261015_message_chunks.sql";
    const options: FakeDbOptions = { recorded: SCHEMA_FILES.filter(f => f !== reindex), failOn: chunks };
    const db = fakeDb(options);
    fullyMigrated(db);

    const first = await applyMissingMigrations({ session: db.session, root: ROOT, now });
    const fromGap = MIGRATIONS.slice(MIGRATIONS.indexOf(reindex as never));
    expect(first).toEqual({ ok: false, applied: fromGap.slice(0, fromGap.indexOf(chunks as never)), failed: chunks });
    expect(db.functions.get("embedding_fact_vectors")).not.toContain("archived_at IS NULL");
    expect(db.history.has(migrationName(reindex))).toBe(false);
    expect(db.ops.filter(o => o.includes("insert into supabase_migrations"))).toEqual([]);

    // Neustart mit behobenem Fehler: der ganze Nachlauf ab der Lücke
    options.failOn = undefined;
    db.ops.length = 0;
    const second = await applyMissingMigrations({ session: db.session, root: ROOT, now });
    expect(second).toEqual({ ok: true, applied: fromGap });
    expect(db.files()).toEqual(fromGap.map(f => join(ROOT, f)));
    expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
    const inserts = db.ops.filter(o => o.includes("insert into supabase_migrations"));
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain(`'${migrationName(reindex)}'`);
    // Verbucht erst mit der letzten Datei des Nachlaufs
    expect(db.ops.indexOf(inserts[0])).toBeGreaterThan(db.ops.indexOf(`file:${join(ROOT, fromGap[fromGap.length - 1])}`));
    expect(db.history.names().sort()).toEqual(SCHEMA_FILES.map(migrationName).sort());

    // Danach nichts mehr zu tun, der Filter bleibt
    db.ops.length = 0;
    expect(await applyMissingMigrations({ session: db.session, root: ROOT, now })).toEqual({ ok: true, applied: [] });
    expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
  });

  test("Lücke vor schon verbuchten und neue Datei am Ende: die neue wird mit ihrer eigenen Transaktion verbucht", async () => {
    const reindex = "db/migrations/20260928_embedding_reindex.sql";
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    const db = fakeDb({ recorded: SCHEMA_FILES.filter(f => f !== reindex && f !== last) });
    const r = await applyMissingMigrations({ session: db.session, root: ROOT, now });
    expect(r.ok).toBe(true);
    const inserts = db.ops.filter(o => o.includes("insert into supabase_migrations"));
    expect(inserts).toHaveLength(2);
    // Lücke mit der vorletzten Datei, die neue mit sich selbst
    expect(db.ops.indexOf(inserts[0])).toBeLessThan(db.ops.indexOf(`file:${join(ROOT, last)}`));
    expect(db.ops.indexOf(inserts[1])).toBeGreaterThan(db.ops.indexOf(`file:${join(ROOT, last)}`));
    expect(db.history.names().sort()).toEqual(SCHEMA_FILES.map(migrationName).sort());
  });

  // Prüferpunkt zu #560 (Runde 4): Lauf A (etwa tybo setup datenbank) und
  // Lauf B (etwa tybo datenbank start) überlappten. A hatte seinen Plan schon,
  // B spielte alles ein und verbuchte es, danach setzte A fort, ersetzte
  // embedding_fact_vectors ohne Archivfilter und brach ab. Die Historie wirkte
  // vollständig, der nächste Lauf meldete ok ohne Archivfilter.
  describe("überlappende Läufe", () => {
    const reindex = "db/migrations/20260928_embedding_reindex.sql";

    /**
     * A hält vor reindex an, B startet und wartet auf die Sperre; erst dann
     * läuft A weiter und endet nach reindex mit endA (Abbruch oder Fehler
     * der nächsten Datei)
     */
    async function overlap(endA: "abort" | "fail") {
      const next = MIGRATIONS[MIGRATIONS.indexOf(reindex as never) + 1];
      const options: FakeDbOptions = endA === "fail" ? { failOn: next } : {};
      const db = fakeDb(options);
      fullyMigrated(db);
      const a = db.sessionFor("A");
      const b = db.sessionFor("B");
      const abortA = new AbortController();
      let reachedGate!: () => void;
      const atGate = new Promise<void>(r => (reachedGate = r));
      let openGate!: () => void;
      const gate = new Promise<void>(r => (openGate = r));
      const sessionA: SqlSession = {
        ...a,
        fileInTransaction: async (path, after) => {
          if (path.endsWith(reindex)) {
            reachedGate();
            await gate;
          }
          await a.fileInTransaction(path, after);
          if (path.endsWith(reindex) && endA === "abort") abortA.abort();
        },
      };
      let aFinished = false;
      const runA = applyMissingMigrations({ session: sessionA, root: ROOT, now, signal: abortA.signal }).finally(() => (aFinished = true));
      await atGate;
      // Was B liest oder einspielt, solange A noch läuft
      const earlyB: string[] = [];
      const sessionB: SqlSession = {
        ...b,
        query: async text => {
          if (!aFinished && text !== MIGRATION_LOCK_SQL) earlyB.push(text);
          return b.query(text);
        },
        fileInTransaction: async (path, after) => {
          if (!aFinished) earlyB.push(path);
          await b.fileInTransaction(path, after);
        },
      };
      let waits = 0;
      let waited = 0;
      const runB = applyMissingMigrations({
        session: sessionB,
        root: ROOT,
        now,
        onWait: () => waits++,
        // Wartet B, darf A weiterlaufen; B sieht erst nach, wenn A fertig ist
        sleep: async () => {
          waited++;
          openGate();
          await runA;
        },
      });
      // Ohne Sperre liefe B durch, ohne zu warten; dann setzt A erst danach fort
      void runB.finally(openGate);
      const resultA = await runA;
      if (endA === "fail") options.failOn = undefined;
      const resultB = await runB;
      return { db, resultA, resultB, waits, waited, earlyB, next };
    }

    for (const endA of ["abort", "fail"] as const) {
      test(`A ${endA === "abort" ? "bricht nach reindex ab" : "scheitert nach reindex"}: B wartet auf die Sperre, plant danach neu und stellt den Archivfilter wieder her; der nächste Lauf hat nichts zu tun`, async () => {
        const { db, resultA, resultB, waits, waited, earlyB, next } = await overlap(endA);
        const upToReindex = MIGRATIONS.slice(0, MIGRATIONS.indexOf(reindex as never) + 1);
        expect(resultA).toEqual(endA === "abort" ? { ok: false, applied: upToReindex, aborted: true } : { ok: false, applied: upToReindex, failed: next });
        // B hat gewartet und vor dem Ende von A weder die Historie gelesen noch etwas eingespielt
        expect(waits).toBe(1);
        expect(waited).toBeGreaterThan(0);
        expect(earlyB).toEqual([]);
        // B macht hinter reindex weiter, nicht mit seinem eigenen alten Plan
        const rest = MIGRATIONS.slice(upToReindex.length);
        expect(resultB).toEqual({ ok: true, applied: rest });
        expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
        expect(db.history.names().sort()).toEqual(MIGRATIONS.map(migrationName).sort());
        expect(db.lock.owner).toBeNull();

        // Neustart: nichts mehr zu tun, Archivfilter und Historie bleiben
        db.ops.length = 0;
        expect(await applyMissingMigrations({ session: db.sessionFor("C"), root: ROOT, now })).toEqual({ ok: true, applied: [] });
        expect(db.files()).toEqual([]);
        expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
        expect(db.history.names().sort()).toEqual(MIGRATIONS.map(migrationName).sort());
      });
    }

    test("Sperre belegt: wartet höchstens lockWaitMs, liest keine Historie, spielt nichts ein, meldet busy", async () => {
      const db = fakeDb();
      expect(await db.sessionFor("X").query(MIGRATION_LOCK_SQL)).toEqual([{ locked: true }]);
      let waits = 0;
      const sleeps: number[] = [];
      const r = await applyMissingMigrations({ session: db.session, root: ROOT, now, lockWaitMs: 3000, onWait: () => waits++, sleep: async ms => void sleeps.push(ms) });
      expect(r).toEqual({ ok: false, applied: [], busy: true });
      expect(waits).toBe(1);
      expect(sleeps).toEqual([1000, 1000, 1000]);
      expect(db.ops).not.toContain(`query:${LIST_MIGRATIONS_SQL}`);
      expect(db.files()).toEqual([]);
      expect(db.lock.owner).toBe("X");
    });

    test("Abbruch beim Warten auf die Sperre: aborted, nichts eingespielt", async () => {
      const db = fakeDb();
      await db.sessionFor("X").query(MIGRATION_LOCK_SQL);
      const controller = new AbortController();
      const r = await applyMissingMigrations({ session: db.session, root: ROOT, now, signal: controller.signal, sleep: async () => controller.abort() });
      expect(r).toEqual({ ok: false, applied: [], aborted: true });
      expect(db.files()).toEqual([]);
    });

    test("Sperre unterwegs verloren (Verbindung neu aufgebaut, ein anderer Lauf hält sie): die Transaktion scheitert, nichts davon ist festgeschrieben", async () => {
      const reindexFile = join(ROOT, reindex);
      const db = fakeDb();
      fullyMigrated(db);
      const main = db.session;
      const session: SqlSession = {
        ...main,
        fileInTransaction: async (path, after) => {
          if (path === reindexFile) {
            // Verbindung weg, Postgres gibt die Sperre frei; ein anderer Lauf nimmt sie
            db.drop("main");
            await db.sessionFor("B").query(MIGRATION_LOCK_SQL);
          }
          await main.fileInTransaction(path, after);
        },
      };
      const r = await applyMissingMigrations({ session, root: ROOT, now });
      expect(r).toEqual({ ok: false, applied: MIGRATIONS.slice(0, MIGRATIONS.indexOf(reindex as never)), failed: reindex });
      expect(db.history.has(migrationName(reindex))).toBe(false);
      expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
      expect(db.lock.owner).toBe("B");
    });
  });

  test("Historie nicht lesbar: nichts eingespielt", async () => {
    const session: SqlSession = { file: async () => {}, fileInTransaction: async () => {}, query: async () => Promise.reject(new Error("weg")), close: async () => {} };
    expect(await applyMissingMigrations({ session, root: ROOT, now })).toEqual({ ok: false, applied: [] });
  });

  test("unklare Antwort auf „leer?“ schützt db/schema.sql", async () => {
    const db = fakeDb();
    const session: SqlSession = { ...db.session, query: async text => (text === EMPTY_DATABASE_SQL ? [] : db.handleQuery(text)) };
    expect((await applyMissingMigrations({ session, root: ROOT, now })).applied).not.toContain("db/schema.sql");
  });
});

describe("Migrationsschutz vor dem Einspielen", () => {
  async function run(entry: "start" | "setup", db: ReturnType<typeof fakeDb>, options: { bucket?: string; sleep?: () => Promise<void> } = {}) {
    const f = fakeLocal();
    f.sql = () => db.sessionFor(entry);
    const ctx = await makeCtx({
      env: options.bucket ? "SUPABASE_ASSETS_BUCKET=" + options.bucket + "\n" : "",
      overrides: { run: f.run, localSupabase: f.deps, sleep: options.sleep ?? (async () => {}) },
    });
    const messages: string[] = [];
    if (entry === "setup") {
      const result = await runSupabaseLocal({ DB_BACKEND: "supabase-lokal" }, ctx, () => {}, new AbortController().signal);
      return { code: result.ok ? 0 : 1, message: result.message };
    }
    const code = await runDatabaseCommand(["start"], {
      ctx,
      env: { SUPABASE_URL: LOCAL_SUPABASE_URL },
      out: line => messages.push(line),
      err: line => messages.push(line),
    });
    return { code, message: messages.join("\n") };
  }

  test("Regression Runde 5: Datenbankstart mit öffentlichem tybo-assets ohne Historie bricht ab, ohne Ordner, Funktionen oder Historie zu ändern", async () => {
    expect(privatizedBucketsOf(SECURITY)).toEqual(["tybo-assets"]);
    const db = fakeDb({ buckets: { "tybo-assets": true } });
    fullyMigrated(db);
    const result = await run("start", db);
    expect(result.code).toBe(1);
    expect(result.message).toContain("tybo-assets");
    expect(result.message).toContain("öffentlich");
    expect(result.message).toContain("Bildlinks");
    expect(db.buckets.get("tybo-assets")).toBe(true);
    expect(db.files()).toEqual([]);
    expect(db.history.has(migrationName(SECURITY))).toBe(false);
    expect(db.history.names()).toEqual([]);
    expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
    expect(db.lock.owner).toBeNull();
  });

  test("Historienlücke vor der Sicherheitsmigration: auch schon verbuchte Wiederholungen werden vorab geprüft", async () => {
    const recorded = SCHEMA_FILES.filter(file => file !== MIGRATIONS[0]);
    const db = fakeDb({ recorded, buckets: { "tybo-assets": true } });
    fullyMigrated(db);
    const result = await applyMissingMigrations({ session: db.session, root: ROOT, now });
    expect(result.ok).toBe(false);
    expect(db.files()).toEqual([]);
    expect(db.buckets.get("tybo-assets")).toBe(true);
    expect(db.history.names()).toEqual(recorded.map(migrationName));
    expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
    expect(db.lock.owner).toBeNull();
  });

  test("Setup mit eigenem privatem Ordner schützt auch den festen Ordner aus der SQL-Datei", async () => {
    const db = fakeDb({ buckets: { "meine-bilder": false, "tybo-assets": true } });
    const result = await run("setup", db, { bucket: "meine-bilder" });
    expect(result.code).toBe(1);
    expect(result.message).toContain("tybo-assets");
    expect(result.message).toContain("öffentlich");
    expect([...db.buckets]).toEqual([["meine-bilder", false], ["tybo-assets", true]]);
    expect(db.files()).toEqual([]);
    expect(db.history.names()).toEqual([]);
  });

  for (const entry of ["start", "setup"] as const) {
    test(entry + ": Schutzprüfung wartet auf den anderen Lauf und liest danach neu; Ablehnung und Neustart lassen alles unverändert", async () => {
      const db = fakeDb({ buckets: { "tybo-assets": false } });
      fullyMigrated(db);
      const other = db.sessionFor("anderer-lauf");
      await other.query(MIGRATION_LOCK_SQL);
      let earlyChecks: string[] = [];
      let waits = 0;
      const result = await run(entry, db, {
        sleep: async () => {
          waits++;
          earlyChecks = db.ops.filter(op => op.includes("select public from storage.buckets"));
          // Der beim Aufruf noch private Ordner ist inzwischen öffentlich.
          // Maßgeblich ist erst der Stand nach Übernahme der Sperre.
          db.buckets.set("tybo-assets", true);
          await other.close();
        },
      });
      expect(waits).toBe(1);
      expect(earlyChecks).toEqual([]);
      expect(result.code).toBe(1);
      expect(result.message).toContain("öffentlich");
      expect(db.ops).toContain("query:" + BUCKET_QUERY);
      expect(db.files()).toEqual([]);
      expect(db.history.names()).toEqual([]);
      expect(db.buckets.get("tybo-assets")).toBe(true);
      expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
      expect(db.lock.owner).toBeNull();

      db.ops.length = 0;
      expect((await run("start", db)).code).toBe(1);
      expect(db.files()).toEqual([]);
      expect(db.history.names()).toEqual([]);
      expect(db.buckets.get("tybo-assets")).toBe(true);

      // Erst die bewusste Umstellung durch den Nutzer erlaubt den Nachlauf.
      db.buckets.set("tybo-assets", false);
      expect((await run("start", db)).code).toBe(0);
      expect(db.history.names().sort()).toEqual(MIGRATIONS.map(migrationName).sort());
      expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
      db.ops.length = 0;
      expect((await run("start", db)).code).toBe(0);
      expect(db.files()).toEqual([]);
      expect(db.buckets.get("tybo-assets")).toBe(false);
    });
  }

  for (const answer of ["Fehler", "Spalte fehlt", "ungültiger Wert"] as const) {
    test("Bilder-Ordner nicht prüfbar (" + answer + "): keine Datei läuft, feste Fehlermeldung ohne Verbindungsdaten", async () => {
      const db = fakeDb();
      const original = db.sessionFor;
      db.sessionFor = id => {
        const session = original(id);
        return {
          ...session,
          query: async text => {
            if (text !== BUCKET_QUERY) return session.query(text);
            if (answer === "Fehler") throw new Error("nicht erreichbar: " + LOCAL.dbUrl);
            return answer === "Spalte fehlt" ? [{}] : [{ public: "false" }];
          },
        };
      };
      const result = await run("start", db);
      expect(result.code).toBe(1);
      expect(result.message).toContain("Bilder-Ordner");
      expect(result.message).toContain("nicht prüfen");
      for (const secret of LOCAL_SECRETS) expect(result.message).not.toContain(secret);
      expect(db.files()).toEqual([]);
      expect(db.history.names()).toEqual([]);
      expect(db.lock.owner).toBeNull();
    });
  }

  test("Automatischer Start ohne erneute Sicherheitsmigration lässt einen öffentlichen Ordner unberührt", async () => {
    const last = MIGRATIONS[MIGRATIONS.length - 1];
    const db = fakeDb({ recorded: SCHEMA_FILES.filter(file => file !== last), buckets: { "tybo-assets": true } });
    expect((await run("start", db)).code).toBe(0);
    expect(db.files().map(file => file.slice(file.indexOf("db/migrations/")))).toEqual([last]);
    expect(db.buckets.get("tybo-assets")).toBe(true);
    expect(db.ops).not.toContain("query:" + BUCKET_QUERY);
  });
});

describe("tybo datenbank start spielt fehlende Migrationen ein", () => {
  async function start(f: FakeLocal, db: ReturnType<typeof fakeDb>, signal?: AbortSignal) {
    f.onQuery = text => db.handleQuery(text);
    f.onFile = path => db.handleFile(path);
    f.onTransaction = (path, after) => db.handleTransaction(path, after);
    const ctx = await makeCtx({ overrides: { run: f.run, localSupabase: f.deps, sleep: async () => {} } });
    const out: string[] = [];
    const err: string[] = [];
    const code = await runDatabaseCommand(["start"], { ctx, env: { SUPABASE_URL: LOCAL_SUPABASE_URL }, out: l => out.push(l), err: l => err.push(l), deps: f.deps as any, ...(signal ? { signal } : {}) });
    return { code, out, err, ctx };
  }

  test("Nachzug: nach Start und Schutzprüfung, an DB_URL aus supabase status, Exit 0; zweiter Start spielt nichts mehr ein", async () => {
    const f = fakeLocal();
    const db = fakeDb({ recorded: SCHEMA_FILES.filter(x => x !== "db/migrations/20261031_memory_facts_search.sql") });
    const first = await start(f, db);
    expect(first.code).toBe(0);
    expect(db.files()).toEqual([join(first.ctx.root, "db/migrations/20261031_memory_facts_search.sql")]);
    expect(first.out).toContain("Spiele Migration ein: 20261031_memory_facts_search.sql");
    expect(first.out).toContain("1 Migration eingespielt.");
    expect(first.out.at(-1)).toContain("Supabase läuft auf diesem Rechner");
    // Reihenfolge: erst start, dann die Schutzprüfung (docker ps), dann status
    const trail = f.trail();
    const started = trail.indexOf("supabase start");
    const guard = trail.indexOf("docker ps", started);
    expect(guard).toBeGreaterThan(started);
    expect(guard).toBeLessThan(trail.indexOf("supabase status"));
    expect(f.sessions.at(-1)?.dbUrl).toBe(LOCAL.dbUrl);
    expect(f.sessions.at(-1)?.closed).toBe(true);

    db.ops.length = 0;
    const second = await start(f, db);
    expect(second.code).toBe(0);
    expect(db.files()).toEqual([]);
    expect(second.out.some(l => l.includes("eingespielt"))).toBe(false);
  });

  test("SQL-Fehler: Exit 1, nennt die Datei und den Befehl, keine Meldung von Postgres und keine Schlüssel", async () => {
    const f = fakeLocal();
    const db = fakeDb({ recorded: ["db/schema.sql"], failOn: "20261017_scheduled_tasks.sql" });
    const r = await start(f, db);
    expect(r.code).toBe(1);
    const text = [...r.out, ...r.err].join("\n");
    expect(r.err.join("\n")).toContain("die Migration 20261017_scheduled_tasks.sql ließ sich nicht einspielen");
    expect(r.err.join("\n")).toContain("tybo datenbank start");
    expect(text).not.toContain("syntax error");
    expect(text).not.toContain("postgresql://");
    for (const secret of LOCAL_SECRETS) expect(text.includes(secret)).toBe(false);
    expect(f.sessions.at(-1)?.closed).toBe(true);
  });

  test("Regression: scheitert nur das Verbuchen von 20260928_embedding_reindex.sql, Exit 1; der nächste Start behält den Archivfilter", async () => {
    const reindex = "db/migrations/20260928_embedding_reindex.sql";
    const archive = "db/migrations/20261031_memory_archive.sql";
    // Ohne Ordnung ginge der Filter verloren: die ältere Datei definiert die Funktion ohne ihn
    expect(functionsOf(reindex).get("embedding_fact_vectors")).not.toContain("archived_at IS NULL");
    expect(functionsOf(archive).get("embedding_fact_vectors")).toContain("archived_at IS NULL");

    const f = fakeLocal();
    const db = fakeDb({ recorded: ["db/schema.sql"], failRecordOn: reindex });
    const first = await start(f, db);
    expect(first.code).toBe(1);
    expect(first.err.join("\n")).toContain("die Migration 20260928_embedding_reindex.sql ließ sich nicht einspielen und verbuchen");
    expect(first.out.some(l => l.includes("20261031_memory_archive.sql"))).toBe(false);
    expect(db.history.has(migrationName(reindex))).toBe(false);
    expect(db.history.has(migrationName(archive))).toBe(false);

    db.ops.length = 0;
    const second = await start(f, db);
    expect(second.code).toBe(0);
    const rest = MIGRATIONS.slice(MIGRATIONS.indexOf(reindex as never));
    expect(db.files()).toEqual(rest.map(file => join(second.ctx.root, file)));
    expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
    expect(db.history.names().sort()).toEqual(SCHEMA_FILES.map(migrationName).sort());

    // Ein dritter Start spielt nichts mehr ein, der Filter bleibt
    db.ops.length = 0;
    expect((await start(f, db)).code).toBe(0);
    expect(db.files()).toEqual([]);
    expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
  });

  test("ein anderer Lauf hält die Sperre zu lange: Exit 1 mit Hinweis, nichts eingespielt, Sitzung geschlossen", async () => {
    const f = fakeLocal();
    const db = fakeDb({ recorded: ["db/schema.sql"] });
    await db.sessionFor("setup").query(MIGRATION_LOCK_SQL);
    const r = await start(f, db);
    expect(r.code).toBe(1);
    expect(r.out).toContain("Warte, bis ein anderer Lauf (tybo setup datenbank oder tybo datenbank start) seine Migrationen eingespielt hat.");
    expect(r.err.join("\n")).toContain("spielt seit über zehn Minuten Migrationen ein");
    expect(r.err.join("\n")).toContain("tybo datenbank start");
    expect(db.files()).toEqual([]);
    expect(f.sessions.at(-1)?.closed).toBe(true);
  });

  test("Schutzprüfung schlägt an: keine Migration, keine Sitzung", async () => {
    const f = fakeLocal();
    f.lan = [54421];
    const db = fakeDb();
    const r = await start(f, db);
    expect(r.code).toBe(1);
    expect(f.trail()).not.toContain("supabase status");
    expect(f.sessions).toEqual([]);
  });

  test("supabase status unlesbar: Exit 1, nichts eingespielt", async () => {
    const f = fakeLocal({ "supabase status": { stdout: "kein json" } });
    const db = fakeDb();
    const r = await start(f, db);
    expect(r.code).toBe(1);
    expect(r.err.join("\n")).toContain("fehlende Migrationen sind nicht geprüft");
    expect(f.sessions).toEqual([]);
  });

  test("Strg+C während des Einspielens: Exit 130", async () => {
    const f = fakeLocal();
    const controller = new AbortController();
    const db = fakeDb();
    const orig = db.handleFile;
    const r = await (async () => {
      f.onQuery = text => db.handleQuery(text);
      f.onFile = path => (orig(path), controller.abort());
      const ctx = await makeCtx({ overrides: { run: f.run, localSupabase: f.deps, sleep: async () => {} } });
      const err: string[] = [];
      const code = await runDatabaseCommand(["start"], { ctx, env: { SUPABASE_URL: LOCAL_SUPABASE_URL }, out: () => {}, err: l => err.push(l), deps: f.deps as any, signal: controller.signal });
      return { code, err };
    })();
    expect(r.code).toBe(EXIT_ABORTED);
    expect(db.files()).toHaveLength(1);
    expect(f.run.calls.some(c => shortName(c.cmd) === "supabase stop")).toBe(false);
  });
});

// Prüferpunkt zu #560: Ein erneutes `tybo setup datenbank` (lokal) spielte alle
// Dateien noch einmal ein. Scheiterte es dabei an 20261015_message_chunks.sql,
// hatte 20260928_embedding_reindex.sql den Archivfilter schon entfernt, die
// Historie nannte 20261031_memory_archive.sql aber weiter als eingespielt, und
// der nächste Datenbankstart übersprang alles mit Exit 0.
describe("tybo setup datenbank (lokal) nimmt denselben Weg wie der Datenbankstart", () => {
  const reindex = "db/migrations/20260928_embedding_reindex.sql";
  const chunks = "db/migrations/20261015_message_chunks.sql";
  const archive = "db/migrations/20261031_memory_archive.sql";
  const BASE_ENV = `TELEGRAM_BOT_TOKEN=${FAKE.token}\nTELEGRAM_USER_ID=${FAKE.userId}\n`;

  function wire(f: FakeLocal, db: ReturnType<typeof fakeDb>) {
    // Bilder-Ordner wie die Attrappe (privat), alles andere an die Postgres-Attrappe
    f.onQuery = text => (text.startsWith("select public from storage.buckets") ? [] : text.includes("insert into storage.buckets") ? [{ public: false }] : db.handleQuery(text));
    f.onFile = path => db.handleFile(path);
    f.onTransaction = (path, after) => db.handleTransaction(path, after);
  }

  async function setupRun(f: FakeLocal, db: ReturnType<typeof fakeDb>) {
    wire(f, db);
    const ctx = await makeCtx({ env: BASE_ENV, overrides: { run: f.run, localSupabase: f.deps, sleep: async () => {} } });
    return runSupabaseLocal({ DB_BACKEND: "supabase-lokal" }, ctx, () => {}, new AbortController().signal);
  }

  async function start(f: FakeLocal, db: ReturnType<typeof fakeDb>) {
    wire(f, db);
    const ctx = await makeCtx({ overrides: { run: f.run, localSupabase: f.deps, sleep: async () => {} } });
    const err: string[] = [];
    const code = await runDatabaseCommand(["start"], { ctx, env: { SUPABASE_URL: LOCAL_SUPABASE_URL }, out: () => {}, err: l => err.push(l), deps: f.deps as any });
    return { code, err, root: ctx.root };
  }

  test("vollständig eingespielt und verbucht: erneutes Setup spielt nichts ein, Archivfilter und Historie bleiben, der Datenbankstart danach auch", async () => {
    const options: FakeDbOptions = { empty: true };
    const db = fakeDb(options);
    expect((await applyMissingMigrations({ session: db.session, root: ROOT, now })).ok).toBe(true);
    expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
    options.empty = false;
    // Die Datei aus dem Befund scheitert, wenn sie läuft; sie darf gar nicht laufen
    options.failOn = chunks;
    db.ops.length = 0;

    const f = fakeLocal();
    const r = await setupRun(f, db);
    expect(r.ok).toBe(true);
    expect(db.files()).toEqual([]);
    expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
    expect(db.history.names().sort()).toEqual(SCHEMA_FILES.map(migrationName).sort());
    expect(f.sessions.at(-1)?.closed).toBe(true);

    const s = await start(f, db);
    expect(s.code).toBe(0);
    expect(db.files()).toEqual([]);
    expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
  });

  test("Setup scheitert bei 20261015_message_chunks.sql: Historie passt zum Stand, der nächste Datenbankstart stellt den Archivfilter wieder her", async () => {
    // Bestand ohne Historie (eingerichtet, bevor tybo setup verbuchte), alles eingespielt
    const options: FakeDbOptions = { failOn: chunks };
    const db = fakeDb(options);
    fullyMigrated(db);

    const f = fakeLocal();
    const r = await setupRun(f, db);
    expect(r.ok).toBe(false);
    expect(r.message).toContain("Die Tabellen ließen sich nicht einspielen.");
    expect(r.message).toContain("20261015_message_chunks.sql");
    expect(r.message).not.toContain("syntax error");
    expect(r.message).not.toContain("postgresql://");
    // Die ältere Datei ist gelaufen und verbucht, die gescheiterte und alle späteren nicht
    expect(db.history.has(migrationName(reindex))).toBe(true);
    expect(db.history.has(migrationName(chunks))).toBe(false);
    expect(db.history.has(migrationName(archive))).toBe(false);
    expect(db.functions.get("embedding_fact_vectors")).not.toContain("archived_at IS NULL");
    expect(f.sessions.at(-1)?.closed).toBe(true);

    // Nächster Datenbankstart (Fehler behoben): macht bei der gescheiterten Datei weiter
    options.failOn = undefined;
    db.ops.length = 0;
    const s = await start(f, db);
    expect(s.code).toBe(0);
    const rest = MIGRATIONS.slice(MIGRATIONS.indexOf(chunks as never));
    expect(db.files()).toEqual(rest.map(file => join(s.root, file)));
    expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
    expect(db.history.names().sort()).toEqual(MIGRATIONS.map(migrationName).sort());

    // Danach nichts mehr zu tun, der Filter bleibt
    db.ops.length = 0;
    expect((await start(f, db)).code).toBe(0);
    expect(db.files()).toEqual([]);
    expect(db.functions.get("embedding_fact_vectors")).toContain("archived_at IS NULL");
  });
});
