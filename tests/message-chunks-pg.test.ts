/**
 * db/migrations/20261015_message_chunks.sql gegen echtes PostgreSQL mit
 * pgvector (tests/pg-harness.ts). Belegt: Nachzug schreibt Abschnitte nur
 * für lange Nachrichten ohne Anzeige-Meldungen, Schreiben prüft Anbieter und
 * Text, Suche liefert jede Nachricht einmal mit der besten Ähnlichkeit und
 * bei Abschnitt-Treffern nur den Abschnitt, geänderter Text und gelöschte
 * Nachrichten räumen ihre Abschnitte ab, der Trigger nimmt keine fremden
 * Vektoren an, und eine Neuberechnung stellt die Abschnitte mit um.
 *
 * Braucht TEST_PG_URL oder TEST_PG_BIN (siehe tests/pg-harness.ts);
 * ohne beide übersprungen, in der CI ein Fehler.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { SQL } from "bun";
import type { EmbeddingConfig, EnvReader, FetchLike } from "../supabase/functions/_shared/embedding";
import { contentHash, EXCERPT_CHARS, shapeHits, splitIntoChunks } from "../supabase/functions/_shared/chunks";
import { restChunkStore, syncChunks } from "../src/lib/message-chunks";
import { restReindexStore, runReindex } from "../src/lib/embedding-reindex";
import { fakeProvider, fakeVector } from "./reindex-fixture";
import { pgAvailable, postgrestFetch, startPg, vec, type PgServer } from "./pg-harness";

const available = pgAvailable();
const BASE = "https://projekt.supabase.co";
const target = { url: BASE, key: "sb_secret_attrappe_pg" };
const OPENAI: EmbeddingConfig = { provider: "openai", model: "text-embedding-3-small" };
const GEMINI: EmbeddingConfig = { provider: "gemini", model: "gemini-embedding-2" };
const KEYS = { OPENAI_API_KEY: "sk-test-pg-chunks-6161", GEMINI_API_KEY: "AIza-test-pg-chunks-6262" };
const oldEnv: EnvReader = name => ({ ...KEYS })[name as keyof typeof KEYS];
const newEnv: EnvReader = name => ({ ...KEYS, EMBEDDING_PROVIDER: "gemini", EMBEDDING_MODEL: "gemini-embedding-2" })[name as keyof typeof KEYS];

/** Text mit eindeutigen Sätzen; marker steht erst nach Zeichen 15.000 */
function longText(marker = "", chars = 20_000): string {
  let out = "";
  for (let i = 0; out.length < chars; i++) {
    out += `Absatz ${i} handelt von Booten auf der Elbe. `;
    if (marker && out.length > 15_000 && !out.includes(marker)) out += `${marker} `;
  }
  return out;
}

if (!available.ok && process.env.CI) {
  test("PostgreSQL für die Tests der Abschnitte ist in der CI eingerichtet", () => {
    throw new Error(`${available.reason}: der Dienst pgvector in .github/workflows/check.yml fehlt`);
  });
}

describe.skipIf(!available.ok)("Migration 20261015 (Abschnitte) gegen echtes PostgreSQL", () => {
  let pg: PgServer;
  let svc: SQL;
  const LONG = longText("Das Codewort heißt Zitronenfalter.");
  const OTHER = longText("", 12_000);

  beforeAll(async () => {
    pg = await startPg();
    await pg.applySchema();
    svc = await pg.connect("service_role");
    await pg.admin.unsafe("INSERT INTO public.embedding_settings (id, state, provider, model) VALUES (true, 'festgehalten', 'openai', 'text-embedding-3-small')");
    const insert = (id: number, chat: string, content: string, meta: object, v: number[] | null) =>
      pg.admin.unsafe(
        "INSERT INTO public.messages (id, chat_id, role, content, metadata, embedding, embedding_model) VALUES ($1, $2, 'user', $3, $4::text::jsonb, $5::vector, CASE WHEN $5::text IS NULL THEN NULL ELSE 'openai:text-embedding-3-small' END)",
        [id, chat, content, JSON.stringify(meta), v ? vec(v) : null],
      );
    await insert(1, "c", "Kurze Frage zum Wetter", {}, fakeVector("openai", "Kurze Frage zum Wetter"));
    await insert(2, "c", LONG, {}, fakeVector("openai", LONG.substring(0, 8000)));
    await insert(3, "c", OTHER, { display_only: true }, null);
    await insert(4, "d", OTHER, {}, fakeVector("openai", OTHER.substring(0, 8000)));
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  const rest = () => postgrestFetch(svc, BASE);
  const chunkRows = (id: number) =>
    pg.admin.unsafe("SELECT chunk_index, content, embedding_model, embedding IS NOT NULL AS has FROM public.message_chunks WHERE message_id = $1 ORDER BY chunk_index", [id]) as Promise<
      Array<{ chunk_index: number; content: string; embedding_model: string | null; has: boolean }>
    >;
  async function search(config: EmbeddingConfig, v: number[], chat: string | null = null) {
    return (await svc.unsafe("SELECT * FROM public.match_messages_chunked_checked($1, $2, $3::vector, $4, 0.5, 10)", [config.provider, config.model, vec(v), chat])) as Array<{
      id: string | number;
      content: string;
      chunk_index: number | null;
      content_length: number;
      similarity: number;
    }>;
  }

  test("Nachzug: Abschnitte für lange Nachrichten, nicht für kurze und Anzeige-Meldungen", async () => {
    const provider = fakeProvider();
    const store = restChunkStore(target, rest());
    const outcome = await syncChunks({ store, config: OPENAI, env: oldEnv, fetch: provider.fetch });
    const expected = splitIntoChunks(LONG).length + splitIntoChunks(OTHER).length;
    expect(outcome).toEqual({ state: "fertig", messages: 2, chunks: expected, failed: 0 });
    const rows = await chunkRows(2);
    expect(rows.map(r => r.content)).toEqual(splitIntoChunks(LONG));
    expect(rows.every(r => r.has && r.embedding_model === "openai:text-embedding-3-small")).toBe(true);
    expect(await chunkRows(1)).toEqual([]);
    expect(await chunkRows(3)).toEqual([]);
    expect(await store.status(OPENAI)).toEqual({ long: 2, done: 2, chunks: expected });
    // Nichts mehr offen
    expect(await store.pending(OPENAI, 0, 20)).toEqual([]);
  });

  test("Suche: jede Nachricht einmal, Abschnitt-Treffer mit Abschnitt statt Volltext, Chat-Filter", async () => {
    const chunks = splitIntoChunks(LONG);
    const k = chunks.findIndex(c => c.includes("Zitronenfalter"));
    expect(k).toBeGreaterThan(0);
    const hits = await search(OPENAI, fakeVector("openai", chunks[k]), "c");
    const ids = hits.map(h => Number(h.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(1);
    expect(ids).not.toContain(3);
    expect(ids).not.toContain(4);
    const best = hits[0];
    expect(Number(best.id)).toBe(2);
    expect(best.chunk_index).toBe(k);
    expect(best.content).toBe(chunks[k]);
    expect(best.content_length).toBe(LONG.length);
    expect(best.similarity).toBeCloseTo(1, 6);
    const short = hits.find(h => Number(h.id) === 1)!;
    expect(short.chunk_index).toBeNull();
    expect(short.content).toBe("Kurze Frage zum Wetter");
    // Wie search-memory: Ausschnitt um den Begriff, kurze unverändert
    const shaped = shapeHits(hits, "Codewort Zitronenfalter");
    expect(shaped[0].content.length).toBeLessThanOrEqual(EXCERPT_CHARS + 2);
    expect(shaped[0].content).toContain("Zitronenfalter");
    expect(shaped.find(h => Number(h.id) === 1)!.content).toBe("Kurze Frage zum Wetter");
    // Treffer über das Embedding der Nachricht: höchstens die ersten 8000 Zeichen
    const direct = await search(OPENAI, fakeVector("openai", LONG.substring(0, 8000)), "c");
    expect(direct.every(h => h.content.length <= 8000)).toBe(true);
    // Anderer Anbieter als festgehalten: nichts
    expect(await search(GEMINI, fakeVector("gemini", chunks[k]), "c")).toEqual([]);
  });

  test("Abschnitte mit niedrigerer Schwelle: 0,4 reicht bei 0,5 für einen Abschnitt, nicht für eine Nachricht", async () => {
    const q = [1];
    const near = [0.4, Math.sqrt(1 - 0.16)];
    await pg.admin.unsafe("INSERT INTO public.messages (id, chat_id, role, content, embedding, embedding_model) VALUES (5, 'e', 'user', 'Nachricht mit 0,4', $1::vector, 'openai:text-embedding-3-small'), (6, 'e', 'user', $2, NULL, NULL)", [vec(near), OTHER]);
    await pg.admin.unsafe("INSERT INTO public.message_chunks (message_id, chat_id, chunk_index, content, embedding, embedding_model) VALUES (6, 'e', 0, 'Abschnitt mit 0,4', $1::vector, 'openai:text-embedding-3-small')", [vec(near)]);
    const hits = await search(OPENAI, q, "e");
    expect(hits.map(h => [Number(h.id), h.chunk_index])).toEqual([[6, 0]]);
    expect(hits[0].similarity).toBeCloseTo(0.4, 6);
    await pg.admin.unsafe("DELETE FROM public.messages WHERE id IN (5, 6)");
  });

  test("Schreiben prüft Anbieter, Text, Anzeige-Meldung und Existenz", async () => {
    const call = (args: Record<string, unknown>) => svc.unsafe("SELECT public.message_chunks_write($1, $2, $3, $4, $5::text::jsonb) AS r", [args.id, args.provider, args.model, args.hash, JSON.stringify(args.chunks)]).then(r => r[0].r);
    const chunk = [{ chunk_index: 0, content: "x", embedding: JSON.stringify(fakeVector("openai", "x")) }];
    const hash = await contentHash(LONG);
    expect(await call({ id: 2, ...OPENAI, hash: "0".repeat(64), chunks: chunk })).toEqual({ ok: false, state: "geaendert" });
    expect(await call({ id: 2, ...GEMINI, hash, chunks: chunk })).toEqual({ ok: false, state: "gesperrt" });
    expect(await call({ id: 3, ...OPENAI, hash: await contentHash(OTHER), chunks: chunk })).toEqual({ ok: false, state: "anzeige" });
    expect(await call({ id: 999, ...OPENAI, hash, chunks: chunk })).toEqual({ ok: false, state: "fehlt" });
    // Unverändert geblieben
    expect((await chunkRows(2)).length).toBe(splitIntoChunks(LONG).length);
  });

  test("Trigger: fremder Vektor wird verworfen, ohne Angabe nur das Verhalten vor der Anbieterwahl", async () => {
    await pg.admin.unsafe("INSERT INTO public.message_chunks (message_id, chat_id, chunk_index, content, embedding, embedding_model) VALUES (1, 'c', 50, 'fremd', $1::vector, 'gemini:gemini-embedding-2')", [vec(fakeVector("gemini", "fremd"))]);
    const [foreign] = await pg.admin.unsafe("SELECT embedding IS NULL AS empty, embedding_model FROM public.message_chunks WHERE message_id = 1 AND chunk_index = 50");
    expect(foreign).toEqual({ empty: true, embedding_model: null });
    await pg.admin.unsafe("INSERT INTO public.message_chunks (message_id, chat_id, chunk_index, content, embedding) VALUES (1, 'c', 51, 'ohne', $1::vector)", [vec(fakeVector("openai", "ohne"))]);
    const [legacy] = await pg.admin.unsafe("SELECT embedding IS NULL AS empty, embedding_model FROM public.message_chunks WHERE message_id = 1 AND chunk_index = 51");
    // embedding_settings hält OpenAI fest, generation 0: das ist das Verhalten vor der Anbieterwahl
    expect(legacy).toEqual({ empty: false, embedding_model: "openai:text-embedding-3-small" });
    await pg.admin.unsafe("DELETE FROM public.message_chunks WHERE message_id = 1");
  });

  test("geänderter Text räumt die Abschnitte ab, gelöschte Nachricht ebenso", async () => {
    await pg.admin.unsafe("UPDATE public.messages SET metadata = metadata || '{\"x\": 1}'::jsonb WHERE id = 2");
    expect((await chunkRows(2)).length).toBeGreaterThan(0);
    await pg.admin.unsafe("UPDATE public.messages SET content = content || ' Nachtrag' WHERE id = 2");
    expect(await chunkRows(2)).toEqual([]);
    const store = restChunkStore(target, rest());
    expect(await store.pending(OPENAI, 0, 20)).toEqual([2]);
    await pg.admin.unsafe("DELETE FROM public.messages WHERE id = 4");
    expect(await chunkRows(4)).toEqual([]);
    // Wieder herstellen für die Neuberechnung
    await pg.admin.unsafe("UPDATE public.messages SET content = $1 WHERE id = 2", [LONG]);
    expect(await syncChunks({ store, config: OPENAI, env: oldEnv, fetch: fakeProvider().fetch })).toMatchObject({ state: "fertig", messages: 1 });
  });

  test("Neuberechnung: während der Umstellung nichts, danach Abschnitte des neuen Anbieters", async () => {
    const provider = fakeProvider();
    const fetchAll: FetchLike = (url, init) => (url.startsWith(`${BASE}/rest/v1/`) ? rest()(url, init) : provider.fetch(url, init));
    const store = restReindexStore(target, fetchAll);
    const chunks = restChunkStore(target, fetchAll);
    expect(await store.start(GEMINI)).toMatchObject({ state: "umstellung" });
    // Umstellung: keine Suche, kein Schreiben, nichts offen
    const k = splitIntoChunks(LONG).findIndex(c => c.includes("Zitronenfalter"));
    expect(await search(OPENAI, fakeVector("openai", splitIntoChunks(LONG)[k]))).toEqual([]);
    expect(await chunks.pending(OPENAI, 0, 20)).toEqual([]);
    const blocked = await chunks.write({ p_message_id: 2, p_provider: "openai", p_model: "text-embedding-3-small", p_hash: await contentHash(LONG), p_chunks: [] });
    expect(blocked).toBe("gesperrt");
    const outcome = await runReindex({
      store,
      chunks,
      config: GEMINI,
      env: newEnv,
      fetch: fetchAll,
      holder: "rechner:1",
      every: () => () => {},
      sleep: async (ms: number) => {
        await pg.admin.unsafe("UPDATE public.embedding_reindex SET write_after = write_after - make_interval(secs => $1)", [ms / 1000]);
      },
    });
    expect(outcome).toMatchObject({ state: "fertig", target: GEMINI, chunks: { state: "fertig", messages: 1, chunks: splitIntoChunks(LONG).length } });
    const rows = await chunkRows(2);
    expect(rows.every(r => r.embedding_model === "gemini:gemini-embedding-2")).toBe(true);
    const hits = await search(GEMINI, fakeVector("gemini", splitIntoChunks(LONG)[k]), "c");
    expect(Number(hits[0].id)).toBe(2);
    expect(hits[0].chunk_index).toBe(k);
    expect(await search(OPENAI, fakeVector("openai", splitIntoChunks(LONG)[k]), "c")).toEqual([]);
  });
});
