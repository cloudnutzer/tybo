/**
 * Abschnitte langer Nachrichten (supabase/functions/_shared/chunks.ts,
 * src/lib/message-chunks.ts): Teilen an Absatz-, Satz- und Wortgrenzen mit
 * Überlappung, Unicode, Grenze bei 8000 Zeichen, 200.000 Zeichen;
 * Ausschnitte statt Volltext in Suchtreffern; Rechnen und Schreiben (alles
 * oder nichts); Nachzug gegen eine Attrappe; Abschnitte nach dem Umschalten
 * der Neuberechnung; Befehl tybo suche abschnitte. Die Suche des Bots über
 * den Store: tests/message-chunks-search.test.ts.
 * Das SQL selbst prüft tests/message-chunks-pg.test.ts, die Edge Functions
 * tests/edge-functions.test.ts.
 *
 * Übernommen aus master (Commit c68c0e9), Issue #479.
 */

import { describe, expect, test } from "bun:test";
import {
  CHUNK_OVERLAP,
  CHUNK_SIZE,
  chunkRanges,
  chunkWriteArgs,
  chunkWriteState,
  contentHash,
  EMBED_MAX_CHARS,
  embedChunks,
  EXCERPT_CHARS,
  EXCERPT_LEAD,
  excerptFor,
  LAST_CHUNK_SLACK,
  needsChunks,
  queryTerms,
  shapeHits,
  splitIntoChunks,
  storeMessageChunks,
  type ChunkEmbedResult,
} from "../supabase/functions/_shared/chunks";
import type { EmbeddingConfig } from "../supabase/functions/_shared/embedding";
import { CHUNK_SYNC_BATCH, CHUNK_SYNC_MAX_MESSAGES, syncChunks, syncMessageChunks, type ChunkMessage, type ChunkStatus, type ChunkStore } from "../src/lib/message-chunks";
import { runReindex, type ReindexProgress } from "../src/lib/embedding-reindex";
import { runSearchCommand } from "../src/setup/search-reindex";
import { FakeDb, fakeProvider, fakeVector, tagOf, type Clock } from "./reindex-fixture";

const OPENAI: EmbeddingConfig = { provider: "openai", model: "text-embedding-3-small" };
const GEMINI: EmbeddingConfig = { provider: "gemini", model: "gemini-embedding-2" };
const KEYS: Record<string, string> = { OPENAI_API_KEY: "sk-test-chunks-geheim-7171", GEMINI_API_KEY: "AIza-test-chunks-geheim-7272" };

/** Satz mit fortlaufender Nummer, damit jede Stelle im Text eindeutig ist */
function sentences(chars: number, prefix = "Satz"): string {
  let out = "";
  for (let i = 0; out.length < chars; i++) out += `${prefix} ${i} erzählt etwas über das Wetter in Hamburg. `;
  return out.slice(0, chars);
}

/** Jeder Abschnitt ist ein Stück des Textes, zusammen decken sie ihn lückenlos ab, mit Überlappung */
function expectCover(text: string) {
  const ranges = chunkRanges(text);
  expect(ranges[0].start).toBe(0);
  expect(ranges[ranges.length - 1].end).toBe(text.length);
  for (let i = 1; i < ranges.length; i++) {
    // Überlappung: der nächste beginnt vor dem Ende des vorigen, aber nach dessen Anfang
    expect(ranges[i].start).toBeLessThan(ranges[i - 1].end);
    expect(ranges[i].start).toBeGreaterThan(ranges[i - 1].start);
    const overlap = ranges[i - 1].end - ranges[i].start;
    expect(overlap).toBeGreaterThan(CHUNK_OVERLAP - 120);
    expect(overlap).toBeLessThanOrEqual(CHUNK_OVERLAP);
  }
  for (const r of ranges) expect(r.end - r.start).toBeLessThanOrEqual(CHUNK_SIZE + LAST_CHUNK_SLACK);
  return ranges;
}

describe("Teilen", () => {
  test("bis einschließlich 8000 Zeichen keine Abschnitte, ab 8001 schon", () => {
    expect(splitIntoChunks("a".repeat(EMBED_MAX_CHARS))).toEqual([]);
    expect(needsChunks("a".repeat(EMBED_MAX_CHARS))).toBe(false);
    expect(splitIntoChunks("")).toEqual([]);
    const over = sentences(EMBED_MAX_CHARS + 1);
    expect(needsChunks(over)).toBe(true);
    const chunks = splitIntoChunks(over);
    expect(chunks.length).toBe(2);
    expectCover(over);
  });

  test("schneidet hinter Absätzen, wenn es sie im Fenster gibt", () => {
    const para = sentences(1000).trim();
    const text = Array.from({ length: 14 }, () => para).join("\n\n");
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Jeder Abschnitt außer dem letzten endet mit einem Absatz
    for (const c of chunks.slice(0, -1)) expect(c.endsWith("\n\n")).toBe(true);
    expectCover(text);
  });

  test("ohne Absätze an Satzenden, Folgeabschnitt beginnt an einem Wortanfang", () => {
    const text = sentences(20_000);
    const ranges = expectCover(text);
    for (const r of ranges.slice(0, -1)) expect(text.slice(r.end - 2, r.end)).toBe(". ");
    for (const r of ranges.slice(1)) expect(/\s/.test(text[r.start - 1])).toBe(true);
  });

  test("ohne Leerraum hart geschnitten, nie mitten in einem Emoji", () => {
    const text = "😀".repeat(9000);
    const ranges = expectCover(text);
    for (const r of ranges) {
      const piece = text.slice(r.start, r.end);
      // Kein halbes Ersatzpaar am Anfang oder Ende
      expect(piece.codePointAt(0)).toBe(0x1f600);
      expect(piece.charCodeAt(piece.length - 1)).toBe(0xde00);
      expect(piece.length % 2).toBe(0);
    }
  });

  test("Umlaute und gemischte Schrift bleiben unverändert", () => {
    const text = sentences(12_000, "Größenänderung 東京 ß").replace(/Hamburg/g, "Zürich");
    const chunks = splitIntoChunks(text);
    expect(chunks.join("").includes("Zürich")).toBe(true);
    const ranges = expectCover(text);
    expect(chunks).toEqual(ranges.map(r => text.slice(r.start, r.end)));
  });

  test("200.000 Zeichen: rund 37 Abschnitte, alle Stellen abgedeckt", () => {
    const text = sentences(200_000);
    const ranges = expectCover(text);
    expect(ranges.length).toBeGreaterThanOrEqual(34);
    expect(ranges.length).toBeLessThanOrEqual(40);
    // Jede Stelle steht in einem Abschnitt, auch ein Begriff kurz vor Schluss
    const marker = text.indexOf("Satz 3500 ");
    expect(ranges.some(r => r.start <= marker && marker + 10 <= r.end)).toBe(true);
  });

  test("kein winziger Rest am Ende", () => {
    const text = sentences(CHUNK_SIZE * 2 + 50);
    const ranges = chunkRanges(text);
    const last = ranges[ranges.length - 1];
    expect(last.end - last.start).toBeGreaterThan(CHUNK_OVERLAP);
  });
});

describe("Ausschnitte", () => {
  test("Fenster um den Suchbegriff, auch tief im Text, mit Auslassungszeichen", () => {
    const text = sentences(15_000) + " Das Codewort lautet Zitronenfalter. " + sentences(5_000);
    const excerpt = excerptFor(text, "Wie lautet das Codewort Zitronenfalter?");
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_CHARS + 2);
    expect(excerpt.startsWith("…")).toBe(true);
    expect(excerpt.endsWith("…")).toBe(true);
    // Der Begriff steht vorn: der Prompt zeigt nur die ersten 300 Zeichen
    expect(excerpt.indexOf("Zitronenfalter")).toBeGreaterThan(0);
    expect(excerpt.indexOf("Zitronenfalter")).toBeLessThan(300);
  });

  test("Begriff am Ende des Textes: Ausschnitt beginnt trotzdem kurz davor", () => {
    const text = sentences(5000) + " Das Codewort lautet Zitronenfalter.";
    const excerpt = excerptFor(text, "Codewort Zitronenfalter");
    expect(excerpt.indexOf("Codewort")).toBeLessThan(EXCERPT_LEAD + 10);
    expect(excerpt.endsWith("Zitronenfalter.")).toBe(true);
  });

  test("Allerweltswörter verschieben den Ausschnitt nicht, Begriffe nur am Wortanfang", () => {
    // „der“ steckt in „Ordner“ und „die“ steht überall: der Ausschnitt soll beim seltenen Begriff beginnen
    const filler = "Die Ordner der Ablage und die Ränder der Seiten. ".repeat(200);
    const text = filler + "Hier steht das Quastenflosser-Protokoll der Bienen. " + filler;
    const excerpt = excerptFor(text, "Was steht im Quastenflosser-Protokoll der Bienen?");
    expect(excerpt.indexOf("Quastenflosser")).toBeGreaterThan(0);
    expect(excerpt.indexOf("Quastenflosser")).toBeLessThan(EXCERPT_LEAD + 30);
  });

  test("ohne Treffer der Anfang; kurze Texte unverändert", () => {
    const text = sentences(5000);
    expect(excerptFor(text, "Quantencomputer").startsWith("Satz 0")).toBe(true);
    expect(excerptFor("kurz", "kurz")).toBe("kurz");
  });

  test("Groß- und Kleinschreibung egal, Wörter unter drei Zeichen zählen nicht", () => {
    expect(queryTerms("Wo ist ÄRGER im Büro? ärger")).toEqual(["ist", "ärger", "büro"]);
    const text = sentences(4000) + " ÄRGER im BÜRO " + sentences(4000);
    expect(excerptFor(text, "ärger büro")).toContain("ÄRGER im BÜRO");
  });

  test("shapeHits: Abschnitt-Treffer und lange Nachrichten als Ausschnitt, kurze unverändert, nie doppelt", () => {
    const long = sentences(7000) + " Zitronenfalter " + sentences(900);
    const hits = [
      { id: 1, content: "kurze Nachricht", similarity: 0.9 },
      { id: 2, content: long, similarity: 0.8, chunk_index: 2, content_length: 200_000 },
      { id: 3, content: long.slice(0, 8000), similarity: 0.7, chunk_index: null, content_length: 20_000 },
      { id: 4, content: "x".repeat(20_000), similarity: 0.6 },
    ];
    const shaped = shapeHits(hits, "Zitronenfalter");
    expect(shaped[0]).toBe(hits[0]);
    expect(shaped[1].excerpt).toBe(true);
    expect(shaped[1].content).toContain("Zitronenfalter");
    expect(shaped[2].excerpt).toBe(true);
    expect(shaped[3].content.length).toBeLessThanOrEqual(EXCERPT_CHARS + 2);
    for (const h of shaped.slice(1)) expect(h.content.length).toBeLessThanOrEqual(EXCERPT_CHARS + 2);
    // Ein zweites Mal ändert nichts
    expect(shapeHits(shaped, "Zitronenfalter")).toEqual(shaped);
  });
});

/** Embedding-Attrappe: Vektor aus dem Text, Ergebnis je Aufruf steuerbar */
function fakeEmbed(config: EmbeddingConfig = OPENAI, fail?: (n: number, text: string) => ChunkEmbedResult | undefined) {
  const texts: string[] = [];
  let n = 0;
  let active = 0;
  let peak = 0;
  const embed = async (text: string): Promise<ChunkEmbedResult> => {
    const call = ++n;
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 1));
    active--;
    const f = fail?.(call, text);
    if (f) return f;
    texts.push(text);
    return { ok: true, vector: fakeVector(config.provider, text), config };
  };
  return { embed, texts, peak: () => peak };
}

describe("Rechnen und Schreiben", () => {
  test("contentHash ist SHA-256 als Hex (wie sha256 in Postgres)", async () => {
    expect(await contentHash("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(await contentHash("Grüße 😀")).toHaveLength(64);
  });

  test("ein Embedding je Abschnitt, höchstens vier gleichzeitig, Schreiben mit Anbieter, Hash und Vektoren als Text", async () => {
    const text = sentences(30_000);
    const e = fakeEmbed();
    let written: Record<string, unknown> | null = null;
    const outcome = await storeMessageChunks(42, text, OPENAI, e.embed, async args => {
      written = args;
      return "ok";
    });
    const chunks = splitIntoChunks(text);
    expect(outcome).toEqual({ state: "ok", chunks: chunks.length });
    expect(e.texts.sort()).toEqual([...chunks].sort());
    expect(e.peak()).toBeLessThanOrEqual(4);
    expect(written!).toEqual(chunkWriteArgs(42, OPENAI, await contentHash(text), chunks.map((c, i) => ({ chunk_index: i, content: c, embedding: fakeVector("openai", c) }))));
    const rows = (written as any).p_chunks;
    expect(typeof rows[0].embedding).toBe("string");
    expect(rows.map((r: any) => r.chunk_index)).toEqual(chunks.map((_, i) => i));
  });

  test("kurzer Text: nichts angefragt, nichts geschrieben", async () => {
    const e = fakeEmbed();
    let calls = 0;
    expect(await storeMessageChunks(1, "kurz", OPENAI, e.embed, async () => (calls++, "ok"))).toEqual({ state: "kurz" });
    expect(e.texts).toEqual([]);
    expect(calls).toBe(0);
  });

  test("ein Abschnitt scheitert: nichts geschrieben, Grund zurück", async () => {
    const e = fakeEmbed(OPENAI, n => (n === 2 ? { ok: false, reason: "abgelehnt", status: 400, message: "OpenAI lehnt die Anfrage ab (HTTP 400)." } : undefined));
    let calls = 0;
    const outcome = await storeMessageChunks(1, sentences(20_000), OPENAI, e.embed, async () => (calls++, "ok"));
    expect(outcome.state).toBe("kein-embedding");
    expect(calls).toBe(0);
  });

  test("Vektor einer anderen Einstellung: nichts geschrieben", async () => {
    const e = fakeEmbed(GEMINI);
    let calls = 0;
    const outcome = await storeMessageChunks(1, sentences(20_000), OPENAI, e.embed, async () => (calls++, "ok"));
    expect(outcome.state).toBe("kein-embedding");
    expect(calls).toBe(0);
  });

  test("Antwort der Datenbank deuten", () => {
    expect(chunkWriteState({ ok: true, written: 3 })).toBe("ok");
    expect(chunkWriteState({ ok: false, state: "gesperrt" })).toBe("gesperrt");
    expect(chunkWriteState({ ok: false, state: "geaendert" })).toBe("geaendert");
    expect(chunkWriteState(null)).toBe("fehler");
    expect(chunkWriteState({ ok: false, state: "unbekannt" })).toBe("fehler");
  });
});

/** Attrappe der Datenbank für den Nachzug: lange Nachrichten ohne Abschnitte der festgehaltenen Einstellung */
class FakeChunkStore implements ChunkStore {
  messages = new Map<number, ChunkMessage>();
  chunks = new Map<number, { key: string; rows: any[] }>();
  /** Was die Datenbank festhält; null: Umstellung */
  current: EmbeddingConfig | null = OPENAI;
  writes = 0;
  constructor(entries: Array<[number, string, Record<string, unknown>?]>) {
    for (const [id, content, metadata] of entries) this.messages.set(id, { id, content, metadata: metadata ?? {} });
  }
  key(c: EmbeddingConfig) {
    return `${c.provider}:${c.model}`;
  }
  async pending(config: EmbeddingConfig, afterId: number, limit: number) {
    if (!this.current || this.key(this.current) !== this.key(config)) return [];
    return [...this.messages.values()]
      .filter(m => m.id > afterId && m.content.length > 8000 && m.metadata?.display_only !== true && this.chunks.get(m.id)?.key !== this.key(config))
      .map(m => m.id)
      .sort((a, b) => a - b)
      .slice(0, limit);
  }
  async message(id: number) {
    return this.messages.get(id) ?? null;
  }
  async write(args: Record<string, unknown>) {
    this.writes++;
    const key = `${args.p_provider}:${args.p_model}`;
    if (!this.current || this.key(this.current) !== key) return "gesperrt" as const;
    const m = this.messages.get(Number(args.p_message_id));
    if (!m) return "fehlt" as const;
    if ((await contentHash(m.content)) !== args.p_hash) return "geaendert" as const;
    this.chunks.set(m.id, { key, rows: args.p_chunks as any[] });
    return "ok" as const;
  }
  async status(config: EmbeddingConfig): Promise<ChunkStatus> {
    const long = [...this.messages.values()].filter(m => m.content.length > 8000 && m.metadata?.display_only !== true);
    const done = long.filter(m => this.chunks.get(m.id)?.key === this.key(config));
    return { long: long.length, done: done.length, chunks: done.reduce((n, m) => n + this.chunks.get(m.id)!.rows.length, 0) };
  }
}

const env = (extra: Record<string, string> = {}) => (name: string) => ({ ...KEYS, ...extra })[name];

describe("Nachzug", () => {
  test("nur lange Nachrichten ohne Abschnitte, Anzeige-Meldungen und kurze nicht", async () => {
    const store = new FakeChunkStore([
      [1, "kurz"],
      [2, sentences(20_000)],
      [3, sentences(9_000), { display_only: true }],
      [4, sentences(50_000)],
    ]);
    const provider = fakeProvider();
    const outcome = await syncChunks({ store, config: OPENAI, env: env(), fetch: provider.fetch });
    expect(outcome).toEqual({ state: "fertig", messages: 2, chunks: splitIntoChunks(sentences(20_000)).length + splitIntoChunks(sentences(50_000)).length, failed: 0 });
    expect([...store.chunks.keys()].sort()).toEqual([2, 4]);
    expect(store.chunks.get(2)!.rows.every(r => tagOf(JSON.parse(r.embedding)) === "openai")).toBe(true);
    // Zweiter Lauf: nichts mehr offen
    const again = await syncChunks({ store, config: OPENAI, env: env(), fetch: provider.fetch });
    expect(again).toEqual({ state: "fertig", messages: 0, chunks: 0, failed: 0 });
  });

  test("Ratenlimit: Durchgang endet, Rest später", async () => {
    const store = new FakeChunkStore([[1, sentences(20_000)], [2, sentences(20_000)]]);
    const provider = fakeProvider();
    provider.script.push({ status: 429 });
    const outcome = await syncChunks({ store, config: OPENAI, env: env(), fetch: provider.fetch });
    expect(outcome.state).toBe("spaeter");
    expect(store.chunks.size).toBe(0);
    expect(await syncChunks({ store, config: OPENAI, env: env(), fetch: provider.fetch })).toMatchObject({ state: "fertig", messages: 2 });
  });

  test("ein abgelehnter Text überspringt nur diese Nachricht", async () => {
    const store = new FakeChunkStore([[1, sentences(9_000)], [2, sentences(20_000)]]);
    const provider = fakeProvider();
    provider.script.push({ status: 400 });
    const outcome = await syncChunks({ store, config: OPENAI, env: env(), fetch: provider.fetch });
    expect(outcome).toMatchObject({ state: "fertig", messages: 1, failed: 1 });
    expect([...store.chunks.keys()]).toEqual([2]);
  });

  test("Umstellung: nichts offen, nichts geschrieben; Grenze je Aufruf", async () => {
    const store = new FakeChunkStore([[1, sentences(20_000)], [2, sentences(20_000)], [3, sentences(20_000)]]);
    store.current = null;
    const provider = fakeProvider();
    expect(await syncChunks({ store, config: OPENAI, env: env(), fetch: provider.fetch })).toEqual({ state: "fertig", messages: 0, chunks: 0, failed: 0 });
    expect(provider.calls).toBe(0);
    store.current = OPENAI;
    expect(await syncChunks({ store, config: OPENAI, env: env(), fetch: provider.fetch, maxMessages: 2 })).toMatchObject({ state: "spaeter", messages: 2 });
  });

  test("Text seit dem Lesen geändert: nicht geschrieben, gezählt", async () => {
    const store = new FakeChunkStore([[1, sentences(20_000)]]);
    const original = store.message.bind(store);
    store.message = async id => {
      const m = await original(id);
      return m ? { ...m, content: m.content + " alt" } : m;
    };
    const outcome = await syncChunks({ store, config: OPENAI, env: env(), fetch: fakeProvider().fetch });
    expect(outcome).toMatchObject({ state: "fertig", messages: 0, failed: 1 });
    expect(store.chunks.size).toBe(0);
  });
});

describe("Neuberechnung", () => {
  test("nach dem Umschalten bekommen lange Nachrichten Abschnitte des neuen Anbieters", async () => {
    const clock: Clock = { t: 0 };
    const db = new FakeDb({ settings: OPENAI, clock });
    const long = sentences(20_000);
    db.seed("messages", { id: 1, content: "kurz", metadata: {} }, fakeVector("openai", "kurz"));
    db.seed("messages", { id: 2, content: long, metadata: {} }, fakeVector("openai", long.substring(0, 8000)));
    db.startNow(GEMINI);
    const store = new FakeChunkStore([[1, "kurz"], [2, long]]);
    // Alte Abschnitte mit OpenAI; die Datenbank hält ab dem Umschalten Gemini fest
    store.chunks.set(2, { key: "openai:text-embedding-3-small", rows: [] });
    store.current = null;
    const finish = db.finish.bind(db);
    db.finish = async (runId, holder) => {
      const r = await finish(runId, holder);
      if (r.state === "festgehalten") store.current = GEMINI;
      return r;
    };
    const provider = fakeProvider();
    const progress: ReindexProgress[] = [];
    const outcome = await runReindex({
      store: db,
      chunks: store,
      config: GEMINI,
      env: env({ EMBEDDING_PROVIDER: "gemini" }),
      fetch: provider.fetch,
      holder: "rechner:1",
      sleep: async ms => {
        clock.t += ms;
      },
      report: p => progress.push(p),
    });
    expect(outcome).toMatchObject({ state: "fertig", target: GEMINI, chunks: { state: "fertig", messages: 1, chunks: splitIntoChunks(long).length } });
    expect(store.chunks.get(2)!.key).toBe("gemini:gemini-embedding-2");
    expect(store.chunks.get(2)!.rows.every(r => tagOf(JSON.parse(r.embedding)) === "gemini")).toBe(true);
    expect(progress.some(p => p.phase === "abschnitte")).toBe(true);
  });
});

describe("tybo suche abschnitte", () => {
  test("rechnet alle offenen, meldet Anzahl und Stand", async () => {
    const store = new FakeChunkStore([[1, sentences(20_000)], [2, sentences(9_000)], [3, "kurz"]]);
    const out: string[] = [];
    const err: string[] = [];
    const code = await runSearchCommand(["abschnitte"], {
      root: "/tmp",
      env: { ...KEYS, SUPABASE_URL: "https://projekt.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test" },
      out: l => out.push(l),
      err: l => err.push(l),
      fetch: fakeProvider().fetch,
      chunkStore: store,
    });
    expect(err).toEqual([]);
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Abschnitte für 2 lange Nachrichten berechnet");
    expect(out.join("\n")).toContain("2 von 2 Nachrichten über 8000 Zeichen haben Abschnitte");
    expect(out.join("\n")).not.toContain(KEYS.OPENAI_API_KEY);
  });

  test("ohne Zugang zum Anbieter: Hinweis statt Lauf", async () => {
    const err: string[] = [];
    const code = await runSearchCommand(["abschnitte"], {
      root: "/tmp",
      env: { SUPABASE_URL: "https://projekt.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test" },
      out: () => {},
      err: l => err.push(l),
      chunkStore: new FakeChunkStore([]),
    });
    expect(code).toBe(2);
    expect(err.join(" ")).toContain("OpenAI");
  });

  test("webui (Issue #479): eine alte CONVEX_URL bricht nichts ab", async () => {
    const store = new FakeChunkStore([[1, sentences(20_000)]]);
    const out: string[] = [];
    const code = await runSearchCommand(["abschnitte"], {
      root: "/tmp",
      env: { ...KEYS, SUPABASE_URL: "https://projekt.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", CONVEX_URL: "https://alt.convex.cloud" },
      out: l => out.push(l),
      err: () => {},
      fetch: fakeProvider().fetch,
      chunkStore: store,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("Abschnitte für 1 lange Nachrichten berechnet");
  });

  test("unbekannte Angabe: Exit 2 mit Hilfe; ohne Supabase: Hinweis auf tybo setup datenbank", async () => {
    const err: string[] = [];
    expect(await runSearchCommand(["abschnitte", "alle"], { root: "/tmp", env: KEYS, out: () => {}, err: l => err.push(l) })).toBe(2);
    expect(err.join("\n")).toContain("tybo suche abschnitte");
    err.length = 0;
    expect(await runSearchCommand(["abschnitte"], { root: "/tmp", env: KEYS, out: () => {}, err: l => err.push(l) })).toBe(2);
    expect(err.join(" ")).toContain("setup datenbank");
  });

  test("Migration fehlt: Exit 1 mit Hinweis auf die Datei", async () => {
    const store = new FakeChunkStore([]);
    store.pending = async () => "fehlt";
    const err: string[] = [];
    const code = await runSearchCommand(["abschnitte"], {
      root: "/tmp",
      env: { ...KEYS, SUPABASE_URL: "https://projekt.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test" },
      out: () => {},
      err: l => err.push(l),
      fetch: fakeProvider().fetch,
      chunkStore: store,
    });
    expect(code).toBe(1);
    expect(err.join(" ")).toContain("20261015_message_chunks.sql");
  });
});

describe("tybo suche status (Issue #479)", () => {
  test("ohne laufende Neuberechnung: Stand der Abschnitte mit offenen und Hinweis auf den Befehl", async () => {
    const store = new FakeChunkStore([[1, sentences(20_000)], [2, sentences(9_000)]]);
    await syncChunks({ store, config: OPENAI, env: env(), fetch: fakeProvider().fetch, maxMessages: 1 });
    const out: string[] = [];
    const code = await runSearchCommand(["status"], {
      root: "/tmp",
      env: { ...KEYS, SUPABASE_URL: "https://projekt.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test" },
      out: l => out.push(l),
      err: () => {},
      fetch: async url => {
        if (url.endsWith("/rpc/embedding_reindex_status")) return new Response(JSON.stringify({ state: "keine" }));
        if (url.endsWith("/rpc/embedding_provider_status")) return new Response(JSON.stringify({ state: "festgehalten", provider: "openai", model: "text-embedding-3-small" }));
        return new Response(JSON.stringify({ state: "keine" }));
      },
      chunkStore: store,
    });
    expect(code).toBe(0);
    expect(out.join("\n")).toContain("1 von 2 Nachrichten über 8000 Zeichen haben Abschnitte");
    expect(out.join("\n")).toContain("offen 1, nachrechnen mit tybo suche abschnitte");
  });
});

describe("Nachzug im laufenden Bot (syncMessageChunks)", () => {
  test("ohne Supabase oder ohne Zugang zum Anbieter: null, kein Aufruf", async () => {
    const calls: string[] = [];
    const fetchFn = async (url: string) => (calls.push(url), new Response("[]"));
    expect(await syncMessageChunks(env(), fetchFn)).toBeNull();
    expect(await syncMessageChunks(name => ({ SUPABASE_URL: "https://projekt.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test" })[name], fetchFn)).toBeNull();
    expect(calls).toEqual([]);
  });

  test("mit Supabase über REST, höchstens CHUNK_SYNC_MAX_MESSAGES; alte CONVEX_URL ändert nichts; Datenbank weg: null", async () => {
    const asked: string[] = [];
    const supa = { SUPABASE_URL: "https://projekt.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_test", CONVEX_URL: "https://alt.convex.cloud" };
    const ok = await syncMessageChunks(env(supa), async (url, init) => {
      asked.push(url);
      if (url.endsWith("/rpc/message_chunks_pending")) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ p_provider: "openai", p_model: "text-embedding-3-small", p_after_id: 0, p_limit: CHUNK_SYNC_BATCH });
        return new Response("[]");
      }
      return new Response("unerwartet", { status: 500 });
    });
    expect(ok).toEqual({ state: "fertig", messages: 0, chunks: 0, failed: 0 });
    expect(asked).toEqual(["https://projekt.supabase.co/rest/v1/rpc/message_chunks_pending"]);
    expect(CHUNK_SYNC_MAX_MESSAGES).toBe(50);
    const missing = await syncMessageChunks(env(supa), async () => new Response(JSON.stringify({ code: "PGRST202" }), { status: 404 }));
    expect(missing).toEqual({ state: "fehlt" });
    const down = await syncMessageChunks(env(supa), async () => {
      throw new TypeError("weg");
    });
    expect(down).toBeNull();
  });
});
