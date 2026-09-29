/**
 * Issue #168: db/migrations/20260928_embedding_reindex.sql gegen echtes
 * PostgreSQL mit pgvector (tests/pg-harness.ts, eigene Datenbank je Lauf).
 * Belegt, was die Attrappe nur nachbildet: Trigger beim Schreiben (während
 * und außerhalb einer Umstellung), geprüfte Suche, Rollback eines Stapels,
 * atomarer Fortschritt, Sperren gegenüber konkurrierenden Schreibern,
 * Übernahme der Frist, Reservierung beim Beginn, abgelehnte Texte und der
 * Abschluss. Dazu eine ganze Neuberechnung (runReindex über die echte
 * restReindexStore) mit Suchvektoren und Schreibvorgängen, die vor dem Beginn
 * entstanden und erst nach Beginn, Wartezeit und Abschluss ankommen.
 *
 * Braucht TEST_PG_URL oder TEST_PG_BIN (siehe tests/pg-harness.ts);
 * ohne beide übersprungen, in der CI ein Fehler.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import { clearRegistryCache, embedForDatabase, type EmbeddingConfig, type EnvReader, type FetchLike } from "../supabase/functions/_shared/embedding";
import { drainQueue, REINDEX_LEASE_SECONDS, restReindexStore, runReindex, type ReindexStore } from "../src/lib/embedding-reindex";
import { factVectorsFor } from "../src/lib/embedding";
import { fakeProvider, fakeVector, tagOf } from "./reindex-fixture";
import { pgAvailable, postgrestFetch, startPg, vec, type PgServer } from "./pg-harness";

const available = pgAvailable();
const BASE = "https://projekt.supabase.co";
const target = { url: BASE, key: "sb_secret_attrappe_pg" };
const OPENAI: EmbeddingConfig = { provider: "openai", model: "text-embedding-3-small" };
const GEMINI: EmbeddingConfig = { provider: "gemini", model: "gemini-embedding-2" };
const OPENAI_KEY = "openai:text-embedding-3-small";
const GEMINI_KEY = "gemini:gemini-embedding-2";
const KEYS = { OPENAI_API_KEY: "sk-test-pg-geheim-5151", GEMINI_API_KEY: "AIza-test-pg-geheim-5252" };
const oldEnv: EnvReader = name => ({ ...KEYS })[name as keyof typeof KEYS];
const newEnv: EnvReader = name => ({ ...KEYS, EMBEDDING_PROVIDER: "gemini", EMBEDDING_MODEL: "gemini-embedding-2" })[name as keyof typeof KEYS];

if (!available.ok && process.env.CI) {
  test("PostgreSQL für die Tests der Migration ist in der CI eingerichtet", () => {
    throw new Error(`${available.reason}: der Dienst pgvector in .github/workflows/check.yml fehlt`);
  });
}

describe.skipIf(!available.ok)("Migration 20260928 gegen echtes PostgreSQL", () => {
  let pg: PgServer;
  /** Server-Sitzung (service_role) wie PostgREST */
  let svc: SQL;

  beforeAll(async () => {
    pg = await startPg();
    // Stand vor der Migration: Vektoren ohne Angabe, OpenAI festgehalten
    await pg.applySchema("20260927_embedding_provider.sql");
    await pg.admin.unsafe(`INSERT INTO public.embedding_settings (id, state, provider, model) VALUES (true, 'festgehalten', 'openai', 'text-embedding-3-small')`);
    await pg.admin.unsafe(`INSERT INTO public.messages (id, chat_id, role, content, embedding) VALUES (1, 'c', 'user', 'Alt eins', $1::vector), (2, 'c', 'user', 'Alt zwei', $2::vector)`, [
      vec(fakeVector("openai", "Alt eins")),
      vec(fakeVector("openai", "Alt zwei")),
    ]);
    // Die Migration auf die bestehende Datenbank
    await pg.applySchema();
    svc = await pg.connect("service_role");
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  /** Zurück auf: OpenAI festgehalten, keine Umstellung, leere Tabellen */
  async function reset(settings: EmbeddingConfig | null = OPENAI) {
    await pg.admin.unsafe("SET session_replication_role = replica");
    await pg.admin.unsafe("TRUNCATE public.messages, public.memory, public.knowledge, public.assets, public.embedding_reindex, public.embedding_reindex_progress, public.embedding_reindex_queue, public.embedding_settings");
    await pg.admin.unsafe("SET session_replication_role = origin");
    if (settings) await pg.admin.unsafe("INSERT INTO public.embedding_settings (id, state, provider, model) VALUES (true, 'festgehalten', $1, $2)", [settings.provider, settings.model]);
  }

  async function row(table: string, id: number | string) {
    const rows = await pg.admin.unsafe(`SELECT embedding::text AS embedding, embedding_model FROM public.${table} WHERE id::text = $1`, [String(id)]);
    return rows[0] as { embedding: string | null; embedding_model: string | null };
  }
  const tagOfText = (v: string | null) => (v ? tagOf(JSON.parse(v)) : null);

  async function insertMessage(conn: SQL, id: number, content: string, vector: number[] | null, model?: string | null) {
    await conn.unsafe(`INSERT INTO public.messages (id, chat_id, role, content, embedding, embedding_model) VALUES ($1, 'c', 'user', $2, $3::vector, $4)`, [id, content, vector ? vec(vector) : null, model ?? null]);
  }

  async function search(conn: SQL, config: EmbeddingConfig, query: number[]) {
    return [...(await conn.unsafe(`SELECT id, similarity FROM public.match_messages_checked($1, $2, $3::vector, NULL, -1, 50)`, [config.provider, config.model, vec(query)]))];
  }

  async function begin(config: EmbeddingConfig, holder: string | null = null, seconds = 0) {
    return (await svc.unsafe(`SELECT public.embedding_reindex_start($1, $2, $3, $4) AS r`, [config.provider, config.model, holder, seconds]))[0].r;
  }

  /** Wartezeit (write_after) als verstrichen setzen */
  const skipWait = () => pg.admin.unsafe("UPDATE public.embedding_reindex SET write_after = now() - interval '1 second'");

  test("eingespielt auf eine bestehende Datenbank: vorhandene Vektoren tragen den festgehaltenen Anbieter; ein zweites Einspielen ändert nichts", async () => {
    expect(await row("messages", 1)).toMatchObject({ embedding_model: OPENAI_KEY });
    await pg.applySchema();
    expect(await row("messages", 2)).toMatchObject({ embedding_model: OPENAI_KEY });
    const triggers = await pg.admin.unsafe(`SELECT tgrelid::regclass::text AS t FROM pg_trigger WHERE tgname = 'embedding_reindex_guard' ORDER BY 1`);
    expect([...triggers].map(r => r.t)).toEqual(["assets", "knowledge", "memory", "messages"]);
  });

  test("Rechte: anon und authenticated dürfen weder die Funktionen noch die Tabellen der Umstellung nutzen", async () => {
    for (const role of ["anon", "authenticated"]) {
      const conn = await pg.connect(role);
      for (const q of [
        "SELECT public.embedding_reindex_start('gemini', 'gemini-embedding-2')",
        "SELECT public.embedding_reindex_lease('x', 10)",
        "SELECT * FROM public.embedding_fact_vectors('openai', 'text-embedding-3-small')",
        "SELECT * FROM public.embedding_reindex_queue",
      ]) {
        const err = await conn.unsafe(q).then(() => null, e => String((e as { errno?: string }).errno));
        expect({ role, q, err }).toEqual({ role, q, err: "42501" });
      }
    }
  });

  describe("Trigger beim Schreiben", () => {
    test("ohne Umstellung: passende Angabe bleibt; andere Angabe wird NULL; ohne Angabe gilt das Verhalten vor der Anbieterwahl", async () => {
      await reset(GEMINI);
      await insertMessage(svc, 10, "Gemini passt", fakeVector("gemini", "a"), GEMINI_KEY);
      await insertMessage(svc, 11, "OpenAI passt nicht", fakeVector("openai", "b"), OPENAI_KEY);
      await insertMessage(svc, 12, "Ältere Function ohne Angabe", fakeVector("openai", "c"));
      expect(await row("messages", 10)).toMatchObject({ embedding_model: GEMINI_KEY });
      expect(tagOfText((await row("messages", 10)).embedding)).toBe("gemini");
      expect(await row("messages", 11)).toEqual({ embedding: null, embedding_model: null });
      expect(await row("messages", 12)).toEqual({ embedding: null, embedding_model: null });
      // Datenbank mit dem Verhalten vor der Anbieterwahl: ohne Angabe bleibt der Vektor, gekennzeichnet
      await reset(null);
      await insertMessage(svc, 13, "Alt", fakeVector("openai", "d"));
      expect(await row("messages", 13)).toMatchObject({ embedding_model: OPENAI_KEY });
      // Angabe umschreiben ohne neuen Vektor geht nicht
      await svc.unsafe(`UPDATE public.messages SET embedding_model = $1 WHERE id = 13`, [GEMINI_KEY]);
      expect(await row("messages", 13)).toMatchObject({ embedding_model: OPENAI_KEY });
    });

    test("während der Umstellung: fremder Vektor wird NULL und vorgemerkt, auch der des Ziels; Text-Änderung merkt vor; nur die Neuberechnung schreibt", async () => {
      await reset();
      await insertMessage(svc, 20, "Vorher", fakeVector("openai", "Vorher"), OPENAI_KEY);
      const started = await begin(GEMINI, "rechner:1", 120);
      await insertMessage(svc, 21, "Neu mit altem Vektor", fakeVector("openai", "x"), OPENAI_KEY);
      await insertMessage(svc, 22, "Neu mit Zielvektor", fakeVector("gemini", "y"), GEMINI_KEY);
      await svc.unsafe(`UPDATE public.messages SET content = 'Vorher, geändert' WHERE id = 20`);
      await svc.unsafe(`UPDATE public.messages SET metadata = '{"x":1}'::jsonb WHERE id = 20`);
      for (const id of [20, 21, 22]) expect(await row("messages", id)).toEqual({ embedding: null, embedding_model: null });
      const queue = [...(await svc.unsafe(`SELECT row_id FROM public.embedding_reindex_queue ORDER BY row_id`))].map(r => r.row_id);
      expect(queue).toEqual(["20", "21", "22"]);
      // Die Neuberechnung selbst schreibt (nach der Wartezeit) mit Angabe des Ziels
      await skipWait();
      const w = await svc.unsafe(`SELECT public.embedding_reindex_write($1::uuid, 'rechner:1', 'messages', $2::text::jsonb, NULL, 0, false) AS r`, [
        started.run_id,
        JSON.stringify([{ id: "21", embedding: vec(fakeVector("gemini", "Neu mit altem Vektor")), seq: Number((await svc.unsafe(`SELECT seq FROM public.embedding_reindex_queue WHERE row_id = '21'`))[0].seq) }]),
      ]);
      expect(w[0].r).toEqual({ ok: true, written: 1 });
      expect(await row("messages", 21)).toMatchObject({ embedding_model: GEMINI_KEY });
      expect([...(await svc.unsafe(`SELECT row_id FROM public.embedding_reindex_queue ORDER BY row_id`))].map(r => r.row_id)).toEqual(["20", "22"]);
    });
  });

  describe("geprüfte Suche", () => {
    test("nur ohne Umstellung, nur mit dem festgehaltenen Anbieter, nur Zeilen mit derselben Angabe; ältere match_messages nur für das Verhalten vor der Anbieterwahl", async () => {
      await reset();
      await insertMessage(svc, 30, "Urlaub am Meer", fakeVector("openai", "Urlaub am Meer"), OPENAI_KEY);
      await pg.admin.unsafe(`INSERT INTO public.memory (id, type, content, embedding, embedding_model) VALUES (30, 'fact', 'Mia mag Tee', $1::vector, $2)`, [vec(fakeVector("openai", "Mia mag Tee")), OPENAI_KEY]);
      const q = fakeVector("openai", "Urlaub am Meer");
      expect((await search(svc, OPENAI, q)).map(r => r.id)).toEqual(["30"]);
      expect(await search(svc, GEMINI, fakeVector("gemini", "Urlaub am Meer"))).toEqual([]);
      expect([...(await svc.unsafe(`SELECT id FROM public.match_messages($1::vector, NULL, -1, 50)`, [vec(q)]))].map(r => r.id)).toEqual(["30"]);
      const facts = await factVectorsFor(OPENAI, target, postgrestFetch(svc, BASE));
      expect(facts instanceof Map && [...facts.keys()]).toEqual(["30"]);
      // Unmittelbar nach dem Beginn: nichts mehr, für niemanden
      await begin(GEMINI);
      expect(await search(svc, OPENAI, q)).toEqual([]);
      expect(await search(svc, GEMINI, fakeVector("gemini", "Urlaub am Meer"))).toEqual([]);
      expect([...(await svc.unsafe(`SELECT id FROM public.match_messages($1::vector, NULL, -1, 50)`, [vec(q)]))]).toEqual([]);
      expect(await factVectorsFor(OPENAI, target, postgrestFetch(svc, BASE))).toEqual(new Map());
    });
  });

  describe("Stapel schreiben", () => {
    test("Fehler mitten im Stapel (ungültiger Vektor): alles zurückgerollt, weder Vektoren noch Fortschritt noch Austragen", async () => {
      await reset();
      for (const id of [40, 41]) await insertMessage(svc, id, `Zeile ${id}`, fakeVector("openai", `Zeile ${id}`), OPENAI_KEY);
      const started = await begin(GEMINI, "rechner:1", 120);
      await insertMessage(svc, 42, "Vorgemerkt", null);
      await skipWait();
      const seq = Number((await svc.unsafe(`SELECT seq FROM public.embedding_reindex_queue WHERE row_id = '42'`))[0].seq);
      const rows = [
        { id: "40", embedding: vec(fakeVector("gemini", "Zeile 40")) },
        { id: "42", embedding: vec(fakeVector("gemini", "Vorgemerkt")), seq },
        { id: "41", embedding: "[1,2]" },
      ];
      const err = await svc
        .unsafe(`SELECT public.embedding_reindex_write($1::uuid, 'rechner:1', 'messages', $2::text::jsonb, '41', 3, false)`, [started.run_id, JSON.stringify(rows)])
        .then(() => null, e => String((e as { errno?: string }).errno));
      // Datenfehler (Klasse 22): falsche Zahl von Werten
      expect(err).toMatch(/^22/);
      expect(tagOfText((await row("messages", 40)).embedding)).toBe("openai");
      expect(await row("messages", 40)).toMatchObject({ embedding_model: OPENAI_KEY });
      expect([...(await svc.unsafe(`SELECT * FROM public.embedding_reindex_progress`))]).toEqual([]);
      expect([...(await svc.unsafe(`SELECT row_id FROM public.embedding_reindex_queue`))].map(r => r.row_id)).toEqual(["42"]);
      // Derselbe Stapel ohne den Fehler: Vektoren, Austragen und Fortschritt in einem Aufruf
      rows[2] = { id: "41", embedding: vec(fakeVector("gemini", "Zeile 41")) };
      const ok = await svc.unsafe(`SELECT public.embedding_reindex_write($1::uuid, 'rechner:1', 'messages', $2::text::jsonb, '42', 3, false) AS r`, [started.run_id, JSON.stringify(rows)]);
      expect(ok[0].r).toEqual({ ok: true, written: 3 });
      expect([...(await svc.unsafe(`SELECT tab, last_id, done::int AS done, finished FROM public.embedding_reindex_progress`))]).toEqual([{ tab: "messages", last_id: "42", done: 3, finished: false }]);
      expect([...(await svc.unsafe(`SELECT row_id FROM public.embedding_reindex_queue`))]).toEqual([]);
      for (const id of [40, 41, 42]) expect(await row("messages", id)).toMatchObject({ embedding_model: GEMINI_KEY });
    });

    test("vor der Wartezeit und ohne Frist: kein Schreiben", async () => {
      await reset();
      const started = await begin(GEMINI, "rechner:1", 120);
      const early = await svc.unsafe(`SELECT public.embedding_reindex_write($1::uuid, 'rechner:1', 'messages', '[]'::text::jsonb, NULL, 0, false) AS r`, [started.run_id]);
      expect(early[0].r).toEqual({ ok: false, state: "zu-frueh" });
      await skipWait();
      const other = await svc.unsafe(`SELECT public.embedding_reindex_write($1::uuid, 'fremd:2', 'messages', '[]'::text::jsonb, NULL, 0, false) AS r`, [started.run_id]);
      expect(other[0].r).toEqual({ ok: false, state: "belegt" });
    });
  });

  describe("Sperren und Frist", () => {
    test("Umschalten wartet auf einen Schreiber, der gerade im Trigger ist; danach wird nicht umgeschaltet, die Zeile ist vorgemerkt", async () => {
      await reset();
      const started = await begin(GEMINI, "rechner:1", 120);
      await skipWait();
      for (const tab of ["messages", "memory", "knowledge", "assets"]) {
        await svc.unsafe(`SELECT public.embedding_reindex_write($1::uuid, 'rechner:1', $2, '[]'::text::jsonb, NULL, 0, true)`, [started.run_id, tab]);
      }
      const writer = await pg.connect("service_role");
      const finisher = await pg.connect("service_role");
      let release!: () => void;
      const gate = new Promise<void>(r => (release = r));
      let inTrigger!: () => void;
      const entered = new Promise<void>(r => (inTrigger = r));
      const tx = writer.begin(async t => {
        await t.unsafe(`INSERT INTO public.messages (id, chat_id, role, content, embedding, embedding_model) VALUES (50, 'c', 'user', 'Gleichzeitig', $1::vector, $2)`, [vec(fakeVector("openai", "Gleichzeitig")), OPENAI_KEY]);
        inTrigger();
        await gate;
      });
      await entered;
      let finished: any = null;
      const finishing = finisher.unsafe(`SELECT public.embedding_reindex_finish($1::uuid, 'rechner:1') AS r`, [started.run_id]).then(r => (finished = r[0].r));
      await Bun.sleep(300);
      // Wartet auf die geteilte Sperre des Schreibers
      expect(finished).toBeNull();
      release();
      await tx;
      await finishing;
      expect(finished).toMatchObject({ state: "umstellung", queued: 1, failed: 0 });
      expect(await row("messages", 50)).toEqual({ embedding: null, embedding_model: null });
      expect((await svc.unsafe(`SELECT count(*)::int AS n FROM public.embedding_reindex`))[0].n).toBe(1);
    });

    test("Schreiber wartet, während umgeschaltet wird, und sieht danach den neuen Anbieter: sein alter Vektor wird verworfen", async () => {
      await reset();
      const started = await begin(GEMINI, "rechner:1", 120);
      await skipWait();
      for (const tab of ["messages", "memory", "knowledge", "assets"]) {
        await svc.unsafe(`SELECT public.embedding_reindex_write($1::uuid, 'rechner:1', $2, '[]'::text::jsonb, NULL, 0, true)`, [started.run_id, tab]);
      }
      const finisher = await pg.connect("service_role");
      const writer = await pg.connect("service_role");
      let release!: () => void;
      const gate = new Promise<void>(r => (release = r));
      let locked!: () => void;
      const holding = new Promise<void>(r => (locked = r));
      const fin = finisher.begin(async t => {
        const r = await t.unsafe(`SELECT public.embedding_reindex_finish($1::uuid, 'rechner:1') AS r`, [started.run_id]);
        locked();
        await gate;
        return r[0].r;
      });
      await holding;
      let wrote = false;
      const writing = insertMessage(writer, 51, "Wartet auf das Umschalten", fakeVector("openai", "w"), OPENAI_KEY).then(() => (wrote = true));
      await Bun.sleep(300);
      expect(wrote).toBe(false);
      release();
      expect(await fin).toMatchObject({ state: "festgehalten", provider: "gemini" });
      await writing;
      expect(await row("messages", 51)).toEqual({ embedding: null, embedding_model: null });
    });

    test("Frist: ein zweiter Inhaber ist belegt; nach Ablauf übernimmt er, abgelehnte Texte werden wieder offen, der erste darf nicht mehr schreiben", async () => {
      await reset();
      // Aus dem Bestand (Hauptdurchgang), nicht vorgemerkt
      await pg.admin.unsafe(`INSERT INTO public.messages (id, chat_id, role, content) VALUES (61, 'c', 'user', 'Zweiter Text')`);
      const started = await begin(GEMINI, "erster:1", REINDEX_LEASE_SECONDS);
      await skipWait();
      // Während der Umstellung geschrieben: vorgemerkt
      await insertMessage(svc, 60, "Abgelehnt", null);
      await svc.unsafe(`SELECT public.embedding_reindex_write($1::uuid, 'erster:1', 'messages', $2::text::jsonb, NULL, 0, false)`, [started.run_id, JSON.stringify([{ id: "61", embedding: null, failed: true }])]);
      expect([...(await svc.unsafe(`SELECT row_id, failed FROM public.embedding_reindex_queue ORDER BY row_id`))]).toEqual([
        { row_id: "60", failed: false },
        { row_id: "61", failed: true },
      ]);
      expect((await svc.unsafe(`SELECT public.embedding_reindex_lease('zweiter:2', 120) AS r`))[0].r).toMatchObject({ state: "belegt" });
      // Frist abgelaufen (Absturz)
      await pg.admin.unsafe("UPDATE public.embedding_reindex SET lease_until = now() - interval '1 second'");
      expect((await svc.unsafe(`SELECT public.embedding_reindex_lease('zweiter:2', 120) AS r`))[0].r).toMatchObject({ state: "umstellung", run_id: started.run_id });
      expect([...(await svc.unsafe(`SELECT row_id, failed FROM public.embedding_reindex_queue ORDER BY row_id`))].every(r => r.failed === false)).toBe(true);
      const late = await svc.unsafe(`SELECT public.embedding_reindex_write($1::uuid, 'erster:1', 'messages', $2::text::jsonb, NULL, 0, false) AS r`, [
        started.run_id,
        JSON.stringify([{ id: "60", embedding: vec(fakeVector("gemini", "Abgelehnt")) }]),
      ]);
      expect(late[0].r).toEqual({ ok: false, state: "belegt" });
      expect(await row("messages", 60)).toEqual({ embedding: null, embedding_model: null });
    });

    test("Beginn: anderes Ziel, während ein Prozess den Lauf hält: belegt, nichts geändert; gleiches Ziel: active; Reservierung geht an denselben Inhaber über", async () => {
      await reset();
      const a = await begin({ provider: "openai", model: "text-embedding-3-large" }, "job-a", 120);
      expect(a).toMatchObject({ state: "umstellung", fresh: true, active: false });
      const before = [...(await svc.unsafe(`SELECT run_id, provider, model, holder FROM public.embedding_reindex`))];
      expect(await begin(GEMINI, "setup-b", 900)).toMatchObject({ state: "belegt", provider: "openai", model: "text-embedding-3-large" });
      expect([...(await svc.unsafe(`SELECT run_id, provider, model, holder FROM public.embedding_reindex`))]).toEqual(before);
      expect(await begin({ provider: "openai", model: "text-embedding-3-large" }, "setup-c", 900)).toMatchObject({ state: "umstellung", fresh: false, active: true });
      // Übergabe: der Hintergrundlauf mit demselben Inhaber übernimmt sofort
      await pg.admin.unsafe("UPDATE public.embedding_reindex SET lease_until = now() - interval '1 second'");
      const b = await begin(GEMINI, "setup-b", 900);
      expect(b).toMatchObject({ state: "umstellung", fresh: true, active: false });
      expect((await svc.unsafe(`SELECT public.embedding_reindex_lease('setup-b', 120) AS r`))[0].r).toMatchObject({ state: "umstellung", run_id: b.run_id });
      expect((await svc.unsafe(`SELECT public.embedding_reindex_lease('job-a', 120) AS r`))[0].r).toMatchObject({ state: "belegt" });
    });
  });

  describe("Abschluss", () => {
    test("erst mit allen Tabellen; abgelehnter Text blockiert; ein Vektor mit anderer Angabe wird vorgemerkt; danach festgehalten", async () => {
      await reset();
      await pg.admin.unsafe(`INSERT INTO public.messages (id, chat_id, role, content) VALUES (70, 'c', 'user', 'Wird abgelehnt')`);
      const started = await begin(GEMINI, "rechner:1", 120);
      await skipWait();
      const finish = async () => (await svc.unsafe(`SELECT public.embedding_reindex_finish($1::uuid, 'rechner:1') AS r`, [started.run_id]))[0].r;
      expect(await finish()).toMatchObject({ state: "umstellung", tables: 0 });
      await svc.unsafe(`SELECT public.embedding_reindex_write($1::uuid, 'rechner:1', 'messages', $2::text::jsonb, '70', 1, true)`, [started.run_id, JSON.stringify([{ id: "70", embedding: null, failed: true }])]);
      for (const tab of ["memory", "knowledge", "assets"]) await svc.unsafe(`SELECT public.embedding_reindex_write($1::uuid, 'rechner:1', $2, '[]'::text::jsonb, NULL, 0, true)`, [started.run_id, tab]);
      expect(await finish()).toMatchObject({ state: "umstellung", queued: 1, failed: 1 });
      // Wie ein Schreiber, der den Trigger vor dem Beginn passiert hat und erst jetzt sichtbar wird
      await pg.admin.unsafe("SET session_replication_role = replica");
      await pg.admin.unsafe(`INSERT INTO public.memory (id, type, content, embedding, embedding_model) VALUES (71, 'fact', 'Durchgerutscht', $1::vector, $2)`, [vec(fakeVector("openai", "Durchgerutscht")), OPENAI_KEY]);
      await pg.admin.unsafe("SET session_replication_role = origin");
      await svc.unsafe(`SELECT public.embedding_reindex_write($1::uuid, 'rechner:1', 'messages', $2::text::jsonb, NULL, 0, false)`, [
        started.run_id,
        JSON.stringify([{ id: "70", embedding: vec(fakeVector("gemini", "Wird abgelehnt")), seq: Number((await svc.unsafe(`SELECT seq FROM public.embedding_reindex_queue WHERE row_id = '70'`))[0].seq) }]),
      ]);
      expect(await finish()).toMatchObject({ state: "umstellung", queued: 1, failed: 0 });
      expect([...(await svc.unsafe(`SELECT tab, row_id FROM public.embedding_reindex_queue`))]).toEqual([{ tab: "memory", row_id: "71" }]);
      const seq = Number((await svc.unsafe(`SELECT seq FROM public.embedding_reindex_queue WHERE row_id = '71'`))[0].seq);
      await svc.unsafe(`SELECT public.embedding_reindex_write($1::uuid, 'rechner:1', 'memory', $2::text::jsonb, NULL, 0, false)`, [started.run_id, JSON.stringify([{ id: "71", embedding: vec(fakeVector("gemini", "Durchgerutscht")), seq }])]);
      expect(await finish()).toEqual({ state: "festgehalten", provider: "gemini", model: "gemini-embedding-2" });
      expect((await svc.unsafe(`SELECT public.embedding_provider_status() AS r`))[0].r).toEqual({ state: "festgehalten", provider: "gemini", model: "gemini-embedding-2" });
      expect((await search(svc, GEMINI, fakeVector("gemini", "Wird abgelehnt"))).map(r => r.id)).toEqual(["70"]);
    });
  });

  describe("Herkunft, offene Transaktionen und verspätete Updates", () => {
    const rest = () => postgrestFetch(svc, BASE);
    function reindexOptions(store: ReindexStore, fetchAll: FetchLike, holder: string, config = GEMINI, env = newEnv) {
      return {
        store,
        config,
        env,
        fetch: fetchAll,
        holder,
        every: () => () => {},
        batchSize: 2,
        // Zeit vergeht: Wartezeit in der Datenbank entsprechend verkürzen
        sleep: async (ms: number) => {
          await pg.admin.unsafe("UPDATE public.embedding_reindex SET write_after = write_after - make_interval(secs => $1)", [ms / 1000]);
        },
      };
    }
    /** Alles auf ein Ziel umrechnen (ganze Neuberechnung über die echte restReindexStore) */
    async function convertTo(config: EmbeddingConfig, env: EnvReader) {
      clearRegistryCache();
      const provider = fakeProvider();
      const fetchAll: FetchLike = (url, init) => (url.startsWith(`${BASE}/rest/v1/`) ? rest()(url, init) : provider.fetch(url, init));
      const store = restReindexStore(target, fetchAll);
      expect(await store.start(config, "rechner:1", 900)).toMatchObject({ state: "umstellung" });
      expect(await runReindex(reindexOptions(store, fetchAll, "rechner:1", config, env))).toMatchObject({ state: "fertig" });
      return { store, fetchAll, provider };
    }
    const convertToGemini = () => convertTo(GEMINI, newEnv);
    const queuedIds = async () => [...(await svc.unsafe(`SELECT row_id FROM public.embedding_reindex_queue ORDER BY row_id`))].map(r => r.row_id);

    test("UPDATE nur von embedding mit altem Vektor nach dem Umrechnen: die Kennung der Zeile gilt nicht als Herkunft, der alte Vektor wird nie als Gemini gespeichert oder verglichen", async () => {
      await reset();
      await insertMessage(svc, 300, "Umgerechnet", fakeVector("openai", "Umgerechnet"), OPENAI_KEY);
      await insertMessage(svc, 301, "Auch umgerechnet", fakeVector("openai", "Auch umgerechnet"), OPENAI_KEY);
      await convertToGemini();
      expect(await row("messages", 300)).toMatchObject({ embedding_model: GEMINI_KEY });
      // Verspäteter Schreiber wie embedFact vor #168: nur embedding, ohne Angabe
      await svc.unsafe(`UPDATE public.messages SET embedding = $1::vector WHERE id = 300`, [vec(fakeVector("openai", "Umgerechnet"))]);
      expect(tagOfText((await row("messages", 300)).embedding)).toBe("gemini");
      expect(await row("messages", 300)).toMatchObject({ embedding_model: GEMINI_KEY });
      // Mit geändertem Text: ohne Vektor und vorgemerkt, nie als Gemini
      await svc.unsafe(`UPDATE public.messages SET content = 'Neu formuliert', embedding = $1::vector WHERE id = 301`, [vec(fakeVector("openai", "Neu formuliert"))]);
      expect(await row("messages", 301)).toEqual({ embedding: null, embedding_model: null });
      expect([...(await svc.unsafe(`SELECT tab, row_id FROM public.embedding_reindex_queue`))]).toEqual([{ tab: "messages", row_id: "301" }]);
      // Gemini-Suche mit dem Suchvektor des alten Textes findet nur Gemini-Vektoren
      for (const hit of await search(svc, GEMINI, fakeVector("gemini", "Umgerechnet"))) {
        expect(tagOfText((await row("messages", hit.id)).embedding)).toBe("gemini");
      }
      // Ausdrücklich als Gemini angegeben (dieselbe Kennung wie die Zeile) bleibt gültig
      await svc.unsafe(`UPDATE public.messages SET embedding = $1::vector, embedding_model = $2 WHERE id = 300`, [vec(fakeVector("gemini", "Umgerechnet neu")), GEMINI_KEY]);
      expect(await row("messages", 300)).toMatchObject({ embedding_model: GEMINI_KEY });
      expect(JSON.parse((await row("messages", 300)).embedding!)).toEqual(fakeVector("gemini", "Umgerechnet neu"));
      // Datenbank mit dem Verhalten vor der Anbieterwahl: ältere Schreiber ohne Angabe schreiben weiter
      await reset(null);
      await insertMessage(svc, 302, "Alt", fakeVector("openai", "Alt"));
      await svc.unsafe(`UPDATE public.messages SET embedding = $1::vector WHERE id = 302`, [vec(fakeVector("openai", "Alt neu"))]);
      expect(await row("messages", 302)).toMatchObject({ embedding_model: OPENAI_KEY });
    });

    test("Beginn wartet auf eine vor ihm offene Schreibtransaktion: alter Vektor und Eintrag ohne Vektor werden vollständig nachgezogen", async () => {
      await reset();
      await insertMessage(svc, 310, "Bestand", fakeVector("openai", "Bestand"), OPENAI_KEY);
      await pg.admin.unsafe(`INSERT INTO public.memory (id, type, content, embedding, embedding_model) VALUES (310, 'fact', 'Bestand Fakt', $1::vector, $2)`, [vec(fakeVector("openai", "Bestand Fakt")), OPENAI_KEY]);
      const writer = await pg.connect("service_role");
      let release!: () => void;
      const gate = new Promise<void>(r => (release = r));
      let wrote!: () => void;
      const written = new Promise<void>(r => (wrote = r));
      // Vor dem Beginn: Trigger passiert (OpenAI noch festgehalten), Transaktion bleibt offen
      const tx = writer.begin(async t => {
        await t.unsafe(`INSERT INTO public.messages (id, chat_id, role, content, embedding, embedding_model) VALUES (311, 'c', 'user', 'Offen mit altem Vektor', $1::vector, $2)`, [vec(fakeVector("openai", "Offen mit altem Vektor")), OPENAI_KEY]);
        await t.unsafe(`INSERT INTO public.messages (id, chat_id, role, content) VALUES (312, 'c', 'user', 'Offen ohne Vektor')`);
        await t.unsafe(`INSERT INTO public.memory (id, type, content) VALUES (311, 'fact', 'Offener Fakt ohne Vektor')`);
        wrote();
        await gate;
      });
      await written;
      clearRegistryCache();
      const provider = fakeProvider();
      const fetchAll: FetchLike = (url, init) => (url.startsWith(`${BASE}/rest/v1/`) ? rest()(url, init) : provider.fetch(url, init));
      const store = restReindexStore(target, fetchAll);
      // Beginn, Hauptdurchgang und Abschluss, während die Transaktion offen ist
      let state = "offen";
      const running = (async () => {
        const started = await store.start(GEMINI, "rechner:1", 900);
        state = "begonnen";
        expect(started).toMatchObject({ state: "umstellung", fresh: true });
        return runReindex(reindexOptions(store, fetchAll, "rechner:1"));
      })();
      await Bun.sleep(400);
      // Der Beginn wartet auf die gemeinsame Sperre des Schreibers: kein Lauf, kein Scan
      expect(state).toBe("offen");
      expect((await pg.admin.unsafe(`SELECT count(*)::int AS n FROM public.embedding_reindex`))[0].n).toBe(0);
      release();
      await tx;
      expect(await running).toMatchObject({ state: "fertig", target: GEMINI });
      for (const id of [310, 311]) {
        expect(await row("messages", id)).toMatchObject({ embedding_model: GEMINI_KEY });
        expect(tagOfText((await row("messages", id)).embedding)).toBe("gemini");
      }
      expect(tagOfText((await row("messages", 312)).embedding)).toBe("gemini");
      for (const id of [310, 311]) expect(await row("memory", id)).toMatchObject({ embedding_model: GEMINI_KEY });
      expect([...(await svc.unsafe(`SELECT * FROM public.embedding_reindex_queue`))]).toEqual([]);
    }, 30_000);

    test("verzögertes UPDATE einer umgerechneten Zeile nach Abschluss: unveränderter Text behält den Zielvektor, geänderter Text wird vorgemerkt und nachgezogen", async () => {
      await reset();
      await insertMessage(svc, 320, "Bleibt gleich", fakeVector("openai", "Bleibt gleich"), OPENAI_KEY);
      await insertMessage(svc, 321, "Wird geändert", fakeVector("openai", "Wird geändert"), OPENAI_KEY);
      await pg.admin.unsafe(`INSERT INTO public.memory (id, type, content, embedding, embedding_model) VALUES (320, 'fact', 'Mia mag Tee', $1::vector, $2)`, [vec(fakeVector("openai", "Mia mag Tee")), OPENAI_KEY]);
      const { fetchAll } = await convertToGemini();
      const kept = await row("messages", 320);
      expect(kept).toMatchObject({ embedding_model: GEMINI_KEY });
      // Verspätete Schreiber mit ausdrücklich alter Angabe, gerechnet vor dem Beginn
      await svc.unsafe(`UPDATE public.messages SET embedding = $1::vector, embedding_model = $2 WHERE id = 320`, [vec(fakeVector("openai", "Bleibt gleich")), OPENAI_KEY]);
      await svc.unsafe(`UPDATE public.memory SET embedding = $1::vector, embedding_model = $2 WHERE id = 320`, [vec(fakeVector("openai", "Mia mag Tee")), OPENAI_KEY]);
      await svc.unsafe(`UPDATE public.messages SET content = 'Geändert nach Abschluss', embedding = $1::vector, embedding_model = $2 WHERE id = 321`, [vec(fakeVector("openai", "Geändert nach Abschluss")), OPENAI_KEY]);
      await insertMessage(svc, 322, "Neu nach Abschluss", fakeVector("openai", "Neu nach Abschluss"), OPENAI_KEY);
      expect(await row("messages", 320)).toEqual(kept);
      expect(await row("memory", 320)).toMatchObject({ embedding_model: GEMINI_KEY });
      expect(tagOfText((await row("memory", 320)).embedding)).toBe("gemini");
      for (const id of [321, 322]) expect(await row("messages", id)).toEqual({ embedding: null, embedding_model: null });
      expect([...(await svc.unsafe(`SELECT row_id FROM public.embedding_reindex_queue ORDER BY row_id`))].map(r => r.row_id)).toEqual(["321", "322"]);
      // Nachzug wie im Bot: nur mit der festgehaltenen Einstellung
      const store = restReindexStore(target, fetchAll);
      expect(await drainQueue({ store, config: OPENAI, env: oldEnv, fetch: fetchAll })).toEqual({ state: "anders" });
      expect(await drainQueue({ store, config: GEMINI, env: newEnv, fetch: fetchAll })).toEqual({ state: "fertig", written: 2, rejected: 0 });
      for (const id of [321, 322]) {
        expect(await row("messages", id)).toMatchObject({ embedding_model: GEMINI_KEY });
        expect(tagOfText((await row("messages", id)).embedding)).toBe("gemini");
      }
      expect([...(await svc.unsafe(`SELECT * FROM public.embedding_reindex_queue`))]).toEqual([]);
      expect((await search(svc, GEMINI, fakeVector("gemini", "Geändert nach Abschluss"))).map(r => r.id)).toContain("321");
    }, 30_000);

    test("Nachzug schreibt nicht, wenn die Zeile inzwischen wieder geändert wurde oder eine Umstellung läuft", async () => {
      await reset(GEMINI);
      await insertMessage(svc, 330, "Erst so", fakeVector("openai", "Erst so"), OPENAI_KEY);
      const seq = Number((await svc.unsafe(`SELECT seq FROM public.embedding_reindex_queue WHERE row_id = '330'`))[0].seq);
      await svc.unsafe(`UPDATE public.messages SET content = 'Dann anders', embedding = $1::vector, embedding_model = $2 WHERE id = 330`, [vec(fakeVector("openai", "Dann anders")), OPENAI_KEY]);
      const stale = await svc.unsafe(`SELECT public.embedding_queue_write('gemini', 'gemini-embedding-2', 'messages', $1::text::jsonb) AS r`, [JSON.stringify([{ id: "330", seq, embedding: vec(fakeVector("gemini", "Erst so")) }])]);
      expect(stale[0].r).toEqual({ ok: true, written: 0 });
      expect(await row("messages", 330)).toEqual({ embedding: null, embedding_model: null });
      expect((await svc.unsafe(`SELECT count(*)::int AS n FROM public.embedding_reindex_queue`))[0].n).toBe(1);
      await begin({ provider: "ollama", model: "nomic-embed-text" });
      const during = await svc.unsafe(`SELECT public.embedding_queue_write('gemini', 'gemini-embedding-2', 'messages', '[]'::text::jsonb) AS r`);
      expect(during[0].r).toEqual({ ok: false, state: "umstellung" });
    });
    test("Rückwechsel Gemini → OpenAI: Vektoren und Suchen ohne Angabe gelten nach einem Umschalten nie mehr als OpenAI", async () => {
      await reset(GEMINI);
      await insertMessage(svc, 400, "Zurück eins", fakeVector("gemini", "Zurück eins"), GEMINI_KEY);
      await insertMessage(svc, 401, "Zurück zwei", fakeVector("gemini", "Zurück zwei"), GEMINI_KEY);
      await pg.admin.unsafe(`INSERT INTO public.memory (id, type, content, embedding, embedding_model) VALUES (400, 'fact', 'Alex mag Kaffee', $1::vector, $2)`, [vec(fakeVector("gemini", "Alex mag Kaffee")), GEMINI_KEY]);
      const { fetchAll } = await convertTo(OPENAI, oldEnv);
      const converted = await row("messages", 400);
      expect(converted).toMatchObject({ embedding_model: OPENAI_KEY });
      expect(tagOfText(converted.embedding)).toBe("openai");
      // Verspätete Schreiber aus #167 ohne Angabe, gerechnet mit Gemini vor dem Beginn
      await svc.unsafe(`UPDATE public.messages SET embedding = $1::vector WHERE id = 400`, [vec(fakeVector("gemini", "Zurück eins"))]);
      await svc.unsafe(`UPDATE public.memory SET embedding = $1::vector WHERE id = 400`, [vec(fakeVector("gemini", "Alex mag Kaffee"))]);
      await svc.unsafe(`UPDATE public.messages SET content = 'Zurück zwei, neu', embedding = $1::vector WHERE id = 401`, [vec(fakeVector("gemini", "Zurück zwei, neu"))]);
      await insertMessage(svc, 402, "Zurück drei", fakeVector("gemini", "Zurück drei"));
      // Unveränderter Text behält den OpenAI-Vektor, neuer oder geänderter Text wird ohne Vektor vorgemerkt
      expect(await row("messages", 400)).toEqual(converted);
      expect(tagOfText((await row("memory", 400)).embedding)).toBe("openai");
      for (const id of [401, 402]) expect(await row("messages", id)).toEqual({ embedding: null, embedding_model: null });
      expect(await queuedIds()).toEqual(["401", "402"]);
      // Kein Gemini-Vektor trägt die OpenAI-Kennung
      const labeled = await pg.admin.unsafe(`SELECT embedding::text AS e FROM public.messages WHERE embedding_model = $1 UNION ALL SELECT embedding::text FROM public.memory WHERE embedding_model = $1`, [OPENAI_KEY]);
      expect(labeled.length).toBeGreaterThan(0);
      for (const r of labeled) expect(tagOfText(r.e)).toBe("openai");
      // Verspätete Suche einer älteren Function ohne Angabe (Gemini-Suchvektor): keine Treffer
      expect([...(await svc.unsafe(`SELECT id FROM public.match_messages($1::vector, NULL, -1, 50)`, [vec(fakeVector("gemini", "Zurück eins"))]))]).toEqual([]);
      expect([...(await svc.unsafe(`SELECT id FROM public.match_knowledge($1::vector, -1, 50)`, [vec(fakeVector("gemini", "Zurück eins"))]))]).toEqual([]);
      // Mit Angabe sucht OpenAI weiter
      expect((await search(svc, OPENAI, fakeVector("openai", "Zurück eins"))).map(r => r.id)).toContain("400");
      // Nachzug mit OpenAI: danach tragen alle Zeilen OpenAI-Vektoren
      const store = restReindexStore(target, fetchAll);
      expect(await drainQueue({ store, config: OPENAI, env: oldEnv, fetch: fetchAll })).toEqual({ state: "fertig", written: 2, rejected: 0 });
      for (const id of [400, 401, 402]) {
        expect(await row("messages", id)).toMatchObject({ embedding_model: OPENAI_KEY });
        expect(tagOfText((await row("messages", id)).embedding)).toBe("openai");
      }
      expect(await queuedIds()).toEqual([]);
      // Einmal umgeschaltet
      expect((await pg.admin.unsafe(`SELECT generation::int AS g FROM public.embedding_settings`))[0].g).toBe(1);
    }, 30_000);

    test("Nachzug: ändert sich der Text, während der Anbieter rechnet, gilt das Ergebnis nicht (mit gültigem Vektor und ganz ohne Vektor)", async () => {
      for (const withVector of [true, false]) {
        await reset(GEMINI);
        clearRegistryCache();
        // Fremder Vektor für neuen Text: ohne Vektor vorgemerkt
        await insertMessage(svc, 410, "Erster Text", fakeVector("openai", "Erster Text"), OPENAI_KEY);
        expect(await queuedIds()).toEqual(["410"]);
        const provider = fakeProvider();
        const fetchAll: FetchLike = (url, init) => (url.startsWith(`${BASE}/rest/v1/`) ? rest()(url, init) : provider.fetch(url, init));
        let changed = false;
        provider.delay = async (_n, text) => {
          if (text !== "Erster Text" || changed) return;
          changed = true;
          // Ein regulärer Schreiber, während der Nachzug den alten Text rechnet
          if (withVector) {
            await svc.unsafe(`UPDATE public.messages SET content = 'Zweiter Text', embedding = $1::vector, embedding_model = $2 WHERE id = 410`, [vec(fakeVector("gemini", "Zweiter Text")), GEMINI_KEY]);
          } else {
            await svc.unsafe(`UPDATE public.messages SET content = 'Zweiter Text' WHERE id = 410`);
          }
        };
        const store = restReindexStore(target, fetchAll);
        expect(await drainQueue({ store, config: GEMINI, env: newEnv, fetch: fetchAll })).toMatchObject({ state: "fertig" });
        expect(changed).toBe(true);
        expect({ withVector, embedding: JSON.parse((await row("messages", 410)).embedding ?? "null") }).toEqual({ withVector, embedding: fakeVector("gemini", "Zweiter Text") });
        expect(await row("messages", 410)).toMatchObject({ embedding_model: GEMINI_KEY });
        expect(await queuedIds()).toEqual([]);
      }
    }, 30_000);

    test("Neuberechnung schreibt nur, wenn der gelesene Stand noch gilt: Ergebnis mit alter seq und Hauptdurchgang für eine vorgemerkte Zeile bleiben aus", async () => {
      await reset();
      await insertMessage(svc, 420, "Vorher", fakeVector("openai", "Vorher"), OPENAI_KEY);
      await insertMessage(svc, 421, "Auch vorher", fakeVector("openai", "Auch vorher"), OPENAI_KEY);
      const started = await begin(GEMINI, "rechner:1", 120);
      await skipWait();
      await svc.unsafe(`UPDATE public.messages SET content = 'Erste Änderung' WHERE id = 420`);
      const firstSeq = Number((await svc.unsafe(`SELECT seq FROM public.embedding_reindex_queue WHERE row_id = '420'`))[0].seq);
      await svc.unsafe(`UPDATE public.messages SET content = 'Zweite Änderung' WHERE id = 420`);
      // Nach dem Lesen im Hauptdurchgang geändert: vorgemerkt
      await svc.unsafe(`UPDATE public.messages SET content = 'Auch geändert' WHERE id = 421`);
      const w = await svc.unsafe(`SELECT public.embedding_reindex_write($1::uuid, 'rechner:1', 'messages', $2::text::jsonb, NULL, 0, false) AS r`, [
        started.run_id,
        JSON.stringify([
          { id: "420", seq: firstSeq, embedding: vec(fakeVector("gemini", "Erste Änderung")) },
          { id: "421", embedding: vec(fakeVector("gemini", "Auch vorher")) },
        ]),
      ]);
      expect(w[0].r).toEqual({ ok: true, written: 0 });
      for (const id of [420, 421]) expect(await row("messages", id)).toEqual({ embedding: null, embedding_model: null });
      expect(await queuedIds()).toEqual(["420", "421"]);
    });

    test("Nachzug: wird eine vorgemerkte Zeile mit gültigem Zielvektor zur Anzeige-Meldung oder leer, verliert sie Vektor und Kennung (Runde 6)", async () => {
      for (const change of ["display_only", "leer"] as const) {
        await reset(GEMINI);
        clearRegistryCache();
        // Fremder Vektor für neuen Text: ohne Vektor vorgemerkt
        await insertMessage(svc, 430, "Bald Anzeige", fakeVector("openai", "Bald Anzeige"), OPENAI_KEY);
        expect(await queuedIds()).toEqual(["430"]);
        // Zwischendurch ein gültiger Zielvektor, danach nur der Text geändert
        await svc.unsafe(`UPDATE public.messages SET embedding = $1::vector, embedding_model = $2 WHERE id = 430`, [vec(fakeVector("gemini", "Bald Anzeige")), GEMINI_KEY]);
        if (change === "display_only") await svc.unsafe(`UPDATE public.messages SET metadata = '{"display_only": true}'::jsonb WHERE id = 430`);
        else await svc.unsafe(`UPDATE public.messages SET content = '' WHERE id = 430`);
        expect(await row("messages", 430)).toMatchObject({ embedding_model: GEMINI_KEY });
        const provider = fakeProvider();
        const fetchAll: FetchLike = (url, init) => (url.startsWith(`${BASE}/rest/v1/`) ? rest()(url, init) : provider.fetch(url, init));
        const store = restReindexStore(target, fetchAll);
        expect(await drainQueue({ store, config: GEMINI, env: newEnv, fetch: fetchAll })).toEqual({ state: "fertig", written: 0, rejected: 0 });
        expect({ change, row: await row("messages", 430) }).toEqual({ change, row: { embedding: null, embedding_model: null } });
        expect(await queuedIds()).toEqual([]);
        expect((await search(svc, GEMINI, fakeVector("gemini", "Bald Anzeige"))).map(r => r.id)).not.toContain("430");
      }
    }, 30_000);

    test("Neuberechnung und Nachzug wenden ein Ergebnis gleich an: Vektor, NULL (kein Text) und Ablehnung ergeben dieselben Zeilen und Vormerkungen", async () => {
      const items = (seqs: Record<string, number>) => [
        { id: "440", seq: seqs["440"], embedding: vec(fakeVector("gemini", "Neu gerechnet")) },
        { id: "441", seq: seqs["441"], embedding: null },
        { id: "442", seq: seqs["442"], embedding: null, failed: true },
      ];
      /** Zeilen mit Vektor, alle vorgemerkt; Ergebnis über einen der beiden Wege */
      async function apply(path: "neuberechnung" | "nachzug") {
        await reset(path === "nachzug" ? GEMINI : OPENAI);
        const key = path === "nachzug" ? GEMINI_KEY : OPENAI_KEY;
        const kind = path === "nachzug" ? "gemini" : "openai";
        for (const id of [440, 441, 442]) await insertMessage(svc, id, `Zeile ${id}`, fakeVector(kind, `Zeile ${id}`), key);
        let run: string | null = null;
        if (path === "neuberechnung") {
          run = (await begin(GEMINI, "rechner:1", 120)).run_id;
          await skipWait();
        }
        const seqs: Record<string, number> = {};
        for (const id of ["440", "441", "442"]) {
          seqs[id] = Number((await pg.admin.unsafe(`INSERT INTO public.embedding_reindex_queue (tab, row_id, seq) VALUES ('messages', $1, nextval('public.embedding_reindex_seq')) RETURNING seq`, [id]))[0].seq);
        }
        const json = JSON.stringify(items(seqs));
        const r =
          path === "neuberechnung"
            ? await svc.unsafe(`SELECT public.embedding_reindex_write($1::uuid, 'rechner:1', 'messages', $2::text::jsonb, NULL, 0, false) AS r`, [run, json])
            : await svc.unsafe(`SELECT public.embedding_queue_write('gemini', 'gemini-embedding-2', 'messages', $1::text::jsonb) AS r`, [json]);
        expect(r[0].r).toEqual({ ok: true, written: 3 });
        const rows: Record<string, unknown> = {};
        for (const id of [440, 441, 442]) {
          const x = await row("messages", id);
          rows[id] = { tag: tagOfText(x.embedding), model: x.embedding_model };
        }
        const queue = [...(await svc.unsafe(`SELECT row_id, failed FROM public.embedding_reindex_queue ORDER BY row_id`))].map(q => ({ ...q }));
        return { rows, queue };
      }
      const expected = {
        rows: { 440: { tag: "gemini", model: GEMINI_KEY }, 441: { tag: null, model: null }, 442: { tag: null, model: null } },
        queue: [{ row_id: "442", failed: true }],
      };
      expect(await apply("neuberechnung")).toEqual(expected);
      expect(await apply("nachzug")).toEqual(expected);
    });
  });

  describe("ganze Neuberechnung über restReindexStore", () => {
    test("Suchvektoren und Schreibvorgänge von vor dem Beginn, verzögert über Beginn, Wartezeit und Abschluss: nie ein Vergleich verschiedener Anbieter; nur ein relevanter Eintrag mit HTTP 400 endet nicht als fertig", async () => {
      await reset();
      clearRegistryCache();
      for (let i = 1; i <= 5; i++) await insertMessage(svc, 100 + i, `Nachricht ${i}`, fakeVector("openai", `Nachricht ${i}`), OPENAI_KEY);
      await insertMessage(svc, 106, "Pipeline fertig", null);
      await svc.unsafe(`UPDATE public.messages SET metadata = '{"display_only": true}'::jsonb WHERE id = 106`);
      await pg.admin.unsafe(`INSERT INTO public.memory (id, type, content, embedding, embedding_model) VALUES (100, 'fact', 'Mia mag Tee', $1::vector, $2), (101, 'goal', 'Marathon', NULL, NULL)`, [vec(fakeVector("openai", "Mia mag Tee")), OPENAI_KEY]);
      const rest = postgrestFetch(svc, BASE);
      const provider = fakeProvider();
      const fetchAll: FetchLike = (url, init) => (url.startsWith(`${BASE}/rest/v1/`) ? rest(url, init) : provider.fetch(url, init));
      const store: ReindexStore = restReindexStore(target, fetchAll);
      const hits: string[] = [];
      const violations: string[] = [];
      async function probe(config: EmbeddingConfig, query: number[], who: string) {
        const found = await search(svc, config, query);
        for (const f of found) {
          const r = await row("messages", f.id);
          if (r.embedding_model !== `${config.provider}:${config.model}` || tagOfText(r.embedding) !== tagOf(query)) violations.push(`${who}: ${f.id}`);
        }
        const facts = await factVectorsFor(config, target, rest);
        if (facts instanceof Map) for (const v of facts.values()) if (tagOf(v) !== tagOf(query)) violations.push(`${who}: Fakt`);
        if (found.length || (facts instanceof Map && facts.size)) hits.push(who);
      }

      // Vor dem Beginn: Freigabe gepuffert, Suchvektor und ein Vektor zum Schreiben gerechnet
      const pre = await embedForDatabase("Nachricht 3", oldEnv, fetchAll, target);
      expect(pre.ok && pre.config).toEqual(OPENAI);
      const staleQuery = pre.ok ? pre.vector : [];
      await probe(OPENAI, staleQuery, "vor dem Beginn");
      expect(hits).toEqual(["vor dem Beginn"]);
      hits.length = 0;

      // Beginn (wie tybo setup suche: reserviert mit Inhaber)
      const started = await store.start(GEMINI, "setup:1", 900);
      expect(started).toMatchObject({ state: "umstellung", fresh: true });
      const buffered = await embedForDatabase("Nachricht 3", oldEnv, fetchAll, target);
      expect(buffered.ok).toBe(true);
      await probe(OPENAI, buffered.ok ? buffered.vector : [], "gepufferte Freigabe direkt nach Beginn");
      await insertMessage(svc, 120, "Verspätet nach Beginn", fakeVector("openai", "Verspätet nach Beginn"), OPENAI_KEY);

      // Einziger Text, den der Anbieter ablehnt: der erste Lauf endet nicht als fertig
      provider.onCall = (_n, text) => {
        if (text === "Nachricht 2" && !rejectedOnce) {
          rejectedOnce = true;
          provider.script.unshift({ status: 400 });
        }
      };
      let rejectedOnce = false;
      let waited = 0;
      const options = (holder: string) => ({
        store,
        config: GEMINI,
        env: newEnv,
        fetch: fetchAll,
        holder,
        every: () => () => {},
        batchSize: 2,
        sleep: async (ms: number) => {
          // Zeit vergeht: Wartezeit in der Datenbank entsprechend verkürzen
          waited += ms;
          await pg.admin.unsafe("UPDATE public.embedding_reindex SET write_after = write_after - make_interval(secs => $1)", [ms / 1000]);
          await probe(OPENAI, staleQuery, "alter Suchvektor in der Wartezeit");
        },
        report: () => {},
      });
      const first = await runReindex(options("setup:1"));
      expect(first.state).toBe("fehler");
      expect(first.state !== "fertig" && first.message).toContain("abgelehnt");
      expect(waited).toBeGreaterThanOrEqual(6 * 60_000 - 5_000);
      expect((await svc.unsafe(`SELECT public.embedding_provider_status() AS r`))[0].r).toMatchObject({ state: "umstellung" });
      expect([...(await svc.unsafe(`SELECT row_id, failed FROM public.embedding_reindex_queue`))]).toEqual([{ row_id: "102", failed: true }]);

      // Nach der Wartezeit: verspäteter Schreiber mit altem Vektor, alter Suchvektor
      await insertMessage(svc, 121, "Verspätet nach der Wartezeit", fakeVector("openai", "Verspätet nach der Wartezeit"), OPENAI_KEY);
      await probe(OPENAI, staleQuery, "alter Suchvektor nach der Wartezeit");

      // Wiederaufnahme (neuer Inhaber): rechnet den abgelehnten und die verspäteten Einträge, schaltet um
      provider.onCall = undefined;
      const second = await runReindex(options("rechner:2"));
      expect(second).toMatchObject({ state: "fertig", target: GEMINI });
      expect(hits).toEqual([]);

      // Nach dem Abschluss: alter Suchvektor findet nichts, verspäteter alter Vektor wird verworfen
      await probe(OPENAI, staleQuery, "alter Suchvektor nach Abschluss");
      expect(hits).toEqual([]);
      await insertMessage(svc, 122, "Verspätet nach Abschluss", fakeVector("openai", "Verspätet nach Abschluss"), OPENAI_KEY);
      expect(await row("messages", 122)).toEqual({ embedding: null, embedding_model: null });
      // Die neue Einstellung sucht wieder, nur unter Gemini-Vektoren
      await probe(GEMINI, fakeVector("gemini", "Nachricht 3"), "neu nach Abschluss");
      expect(hits).toEqual(["neu nach Abschluss"]);
      expect(violations).toEqual([]);
      const all = [...(await pg.admin.unsafe(`SELECT id::text AS id, embedding_model, embedding IS NOT NULL AS has FROM public.messages ORDER BY id`))];
      for (const r of all) {
        if (["106", "122"].includes(r.id)) expect(r).toMatchObject({ has: false });
        else expect(r).toMatchObject({ has: true, embedding_model: GEMINI_KEY });
      }
      expect(await row("memory", 100)).toMatchObject({ embedding_model: GEMINI_KEY });
      expect(await row("memory", 101)).toEqual({ embedding: null, embedding_model: null });
    }, 60_000);
  });
});
