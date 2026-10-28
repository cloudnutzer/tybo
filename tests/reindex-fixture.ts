/**
 * Attrappe der Datenbank für die Neuberechnung (Issue #168). Sie bildet nach,
 * was db/migrations/20260928_embedding_reindex.sql zusichert: Lauf mit Frist
 * (holder, lease_until), Wartezeit (write_after), Fortschritt je Tabelle im
 * selben Aufruf wie das Schreiben, Angabe embedding_model je Zeile, Trigger
 * (während der Umstellung fremdes Schreiben zu NULL und vormerken, sonst nur
 * Vektoren mit passender Angabe), abgelehnte Texte als offen vorgemerkt,
 * geprüfte Suche und Umschalten erst, wenn alle Tabellen durch sind, jeder
 * Vektor das Ziel trägt und die Warteschlange leer ist. Das SQL selbst prüft
 * tests/embedding-reindex-pg.test.ts gegen echtes PostgreSQL.
 *
 * Dazu eine Anbieter-Attrappe: Vektoren tragen ihren Anbieter in den ersten
 * Stellen (openai: Stelle 0, gemini: 1, ollama: 2), so sehen Tests, ob je
 * Werte verschiedener Anbieter zusammenkommen. Die Uhr ist unecht: sleep
 * stellt sie vor, oder VirtualClock mit Zeitgebern.
 */

import { createHash } from "node:crypto";
import { cosineSimilarity, embeddingKey, type EmbeddingConfig, type FetchLike } from "../supabase/functions/_shared/embedding";
import {
  REINDEX_TABLES,
  REINDEX_WRITE_DELAY_MS,
  TABLE_SPECS,
  type FinishResult,
  type LeaseResult,
  type ReindexOverview,
  type ReindexStore,
  type ReindexTable,
  type SourceRow,
  type StartResult,
  type TableCounts,
  type WriteInput,
  type WriteResult,
} from "../src/lib/embedding-reindex";

export const PROVIDER_INDEX: Record<EmbeddingConfig["provider"], number> = { openai: 0, gemini: 1, ollama: 2 };

/** Testvektor: Anbieter-Marke plus ein Wert aus dem Text (so ist erkennbar, welcher Text gerechnet wurde) */
export function fakeVector(provider: EmbeddingConfig["provider"], text: string): number[] {
  const v = new Array(1536).fill(0);
  v[PROVIDER_INDEX[provider]] = 1;
  v[3] = (parseInt(createHash("sha256").update(text).digest("hex").slice(0, 6), 16) % 997) + 1;
  return v;
}

export function tagOf(v: number[] | null): EmbeddingConfig["provider"] | null {
  if (!v) return null;
  if (v[0] === 1) return "openai";
  if (v[1] === 1) return "gemini";
  if (v[2] === 1) return "ollama";
  return null;
}

export interface Clock {
  t: number;
}

/**
 * Kontrollierte Uhr mit Zeitgebern: sleep und every warten auf die unechte
 * Zeit, run(p) stellt sie jeweils zum nächsten fälligen Zeitgeber vor, bis p
 * fertig ist. So laufen Frist, Pausen und langsame Anfragen in Millisekunden.
 */
export class VirtualClock implements Clock {
  t = 0;
  private timers: Array<{ at: number; n: number; fire: () => void }> = [];
  private n = 0;

  sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
    new Promise<void>(resolve => {
      const timer = { at: this.t + ms, n: this.n++, fire: resolve };
      this.timers.push(timer);
      signal?.addEventListener(
        "abort",
        () => {
          this.timers = this.timers.filter(x => x !== timer);
          resolve();
        },
        { once: true },
      );
    });

  every = (ms: number, fn: () => void): (() => void) => {
    let stopped = false;
    void (async () => {
      while (!stopped) {
        await this.sleep(ms);
        if (!stopped) fn();
      }
    })();
    return () => {
      stopped = true;
    };
  };

  async run<T>(p: Promise<T>): Promise<T> {
    let settled = false;
    p.then(
      () => (settled = true),
      () => (settled = true),
    );
    for (let idle = 0; !settled; ) {
      for (let i = 0; i < 5 && !settled; i++) await new Promise(r => setImmediate(r));
      if (settled) break;
      this.timers.sort((a, b) => a.at - b.at || a.n - b.n);
      const next = this.timers.shift();
      if (!next) {
        if (++idle > 1000) throw new Error("VirtualClock: nichts mehr fällig, aber nicht fertig");
        continue;
      }
      idle = 0;
      this.t = Math.max(this.t, next.at);
      next.fire();
    }
    return p;
  }
}

export const LEGACY_KEY = "openai:text-embedding-3-small";

interface Row {
  data: SourceRow;
  embedding: number[] | null;
  /** Spalte embedding_model */
  model: string | null;
}

export interface FakeDbOptions {
  settings?: null | "altbestand" | EmbeddingConfig;
  clock?: Clock;
}

export class FakeDb implements ReindexStore {
  clock: Clock;
  settings: null | "altbestand" | EmbeddingConfig;
  run: null | { runId: string; target: EmbeddingConfig; writeAfter: number; holder: string | null; leaseUntil: number } = null;
  tables: Record<ReindexTable, Map<string, Row>> = { messages: new Map(), memory: new Map(), knowledge: new Map(), assets: new Map() };
  progress = new Map<ReindexTable, { lastId: string | null; done: number; finished: boolean }>();
  /** Warteschlange: „tabelle:id“ → seq, failed (abgelehnt) */
  queue = new Map<string, { seq: number; failed: boolean }>();
  seq = 0;
  runs = 0;
  /** Wie embedding_settings.generation: wie oft schon umgeschaltet */
  generation = 0;
  /** Protokoll der Schreibaufrufe: Zeit, Tabelle, IDs */
  writes: Array<{ t: number; table: ReindexTable; ids: string[] }> = [];
  /** Eingriffe für Fehlerfälle */
  hooks: {
    /** Vor dem Schreiben; wirft: nichts geschrieben (Absturz vor dem Schreiben) */
    beforeWrite?(input: WriteInput): void;
    /** Nach dem Schreiben; wirft: geschrieben, aber die Antwort geht verloren */
    afterWrite?(input: WriteInput): void;
    /** Vor dem Umschalten */
    beforeFinish?(): void;
    /** Nach dem Lesen eines Stapels im Hauptdurchgang */
    afterBatch?(table: ReindexTable, rows: SourceRow[]): void;
  } = {};

  constructor(options: FakeDbOptions = {}) {
    this.clock = options.clock ?? { t: 0 };
    this.settings = options.settings === undefined ? null : options.settings;
  }

  /** Zeile anlegen (Vorbereitung, ohne Trigger); Angabe ohne model: was die Datenbank gerade festhält */
  seed(table: ReindexTable, data: SourceRow, embedding: number[] | null = null, model?: string | null): void {
    this.tables[table].set(String(data.id), { data: { ...data }, embedding, model: embedding ? (model === undefined ? (this.currentKey() ?? LEGACY_KEY) : model) : null });
  }

  /** Wie embedding_current_key: null während der Umstellung */
  currentKey(): string | null {
    if (this.run) return null;
    if (this.settings && this.settings !== "altbestand") return embeddingKey(this.settings);
    return LEGACY_KEY;
  }

  /** Wie embedding_accepted_key: ohne Angabe nur, solange nie umgeschaltet wurde */
  acceptedKey(declared?: string): string | null {
    const current = this.currentKey();
    if (current === null) return null;
    if (declared !== undefined) return declared === current ? current : null;
    return current === LEGACY_KEY && this.generation === 0 ? current : null;
  }

  /** Wie embedding_row_current: mit seq noch genau so vorgemerkt, ohne seq gar nicht */
  rowCurrent(table: ReindexTable, row: { id: string; seq?: number }): boolean {
    return this.queue.get(`${table}:${row.id}`)?.seq === row.seq;
  }

  /**
   * Schreiben eines anderen Prozesses (Bot, Edge Function) wie mit dem
   * Trigger: während der Umstellung ohne Vektor, die Zeile wird vorgemerkt;
   * sonst bleibt ein Vektor nur mit passender Angabe (ohne Angabe: das
   * Verhalten vor der Anbieterwahl, nur solange nie umgeschaltet wurde); ein
   * fremder für unveränderten Text ändert nichts, für geänderten wird die
   * Zeile vorgemerkt. Jede Textänderung gibt einer vorgemerkten Zeile eine
   * neue seq
   */
  foreignWrite(table: ReindexTable, data: SourceRow, embedding: number[] | null, model?: string): void {
    const id = String(data.id);
    const old = this.tables[table].get(id);
    const cols = TABLE_SPECS[table].columns.split(",").filter(c => c !== "id");
    const textChanged = !old || cols.some(c => c in data && JSON.stringify(data[c]) !== JSON.stringify(old.data[c]));
    const vectorSet = embedding !== null && (!old || embedding !== old.embedding);
    let vec = embedding;
    let label: string | null = null;
    if (this.run) {
      if (textChanged || vectorSet) {
        vec = null;
        this.queue.set(`${table}:${id}`, { seq: ++this.seq, failed: false });
      } else {
        vec = old?.embedding ?? null;
        label = old?.model ?? null;
      }
    } else {
      let enqueued = false;
      if (vectorSet) {
        const allowed = this.acceptedKey(model);
        if (allowed !== null) label = allowed;
        else if (old && !textChanged) {
          vec = old.embedding;
          label = old.model;
        } else {
          vec = null;
          enqueued = true;
          this.queue.set(`${table}:${id}`, { seq: ++this.seq, failed: false });
        }
      } else if (vec !== null) label = old?.model ?? null;
      const q = this.queue.get(`${table}:${id}`);
      if (old && textChanged && !enqueued && q) this.queue.set(`${table}:${id}`, { seq: ++this.seq, failed: false });
    }
    this.tables[table].set(id, { data: { ...(old?.data ?? {}), ...data }, embedding: vec, model: vec ? label : null });
  }

  /** Umstellung beginnen wie embedding_reindex_start */
  startNow(target: EmbeddingConfig): void {
    this.run = { runId: `run-${++this.runs}`, target, writeAfter: this.clock.t + REINDEX_WRITE_DELAY_MS, holder: null, leaseUntil: 0 };
    this.progress.clear();
    this.queue.clear();
  }

  /** Wie match_messages_checked: nur ohne Umstellung, nur passende Angabe */
  matchChecked(table: ReindexTable, config: EmbeddingConfig, query: number[]): Array<{ id: string; similarity: number; model: string | null }> {
    const key = embeddingKey(config);
    if (this.currentKey() !== key) return [];
    return [...this.tables[table].entries()]
      .filter(([, r]) => r.embedding && r.model === key)
      .map(([id, r]) => ({ id, similarity: cosineSimilarity(r.embedding!, query), model: r.model }));
  }

  /** Status wie embedding_provider_status */
  status(): Record<string, unknown> {
    if (this.run) return { state: "umstellung", provider: this.run.target.provider, model: this.run.target.model };
    if (this.settings === null) return { state: "leer", vectors: this.allVectors().some(v => v !== null) };
    if (this.settings === "altbestand") return { state: "altbestand", provider: null, model: null };
    return { state: "festgehalten", ...this.settings };
  }

  allVectors(): Array<number[] | null> {
    return REINDEX_TABLES.flatMap(t => [...this.tables[t].values()].map(r => r.embedding));
  }

  // --- ReindexStore ---------------------------------------------------------

  async estimate(): Promise<TableCounts> {
    const out = {} as TableCounts;
    for (const t of REINDEX_TABLES) {
      const texts = [...this.tables[t].values()].map(r => TABLE_SPECS[t].text(r.data)).filter((x): x is string => x !== null);
      out[t] = { rows: texts.length, chars: texts.reduce((n, x) => n + x.length, 0) };
    }
    return out;
  }

  async start(target: EmbeddingConfig, holder?: string, seconds = 0): Promise<StartResult> {
    let fresh = true;
    if (this.run) {
      const busy = this.run.holder !== null && this.run.leaseUntil > this.clock.t && this.run.holder !== holder;
      if (this.run.target.provider === target.provider && this.run.target.model === target.model) {
        if (busy) return { state: "umstellung", runId: this.run.runId, target, fresh: false, active: true };
        fresh = false;
      } else if (busy) return { state: "belegt", target: this.run.target };
      else this.startNow(target);
    } else if (this.settings && this.settings !== "altbestand" && this.settings.provider === target.provider && this.settings.model === target.model) {
      return { state: "festgehalten", target };
    } else this.startNow(target);
    for (const q of this.queue.values()) q.failed = false;
    this.run!.holder = seconds > 0 ? (holder ?? null) : null;
    this.run!.leaseUntil = seconds > 0 ? this.clock.t + seconds * 1000 : 0;
    return { state: "umstellung", runId: this.run!.runId, target, fresh, active: false };
  }

  async lease(holder: string, seconds: number): Promise<LeaseResult> {
    const r = this.run;
    if (!r) return { state: "kein-lauf" };
    if (r.holder !== holder && r.holder !== null && r.leaseUntil > this.clock.t) return { state: "belegt", target: r.target };
    // Neuer Inhaber: abgelehnte Texte erneut versuchen
    if (seconds > 0 && r.holder !== holder) for (const q of this.queue.values()) q.failed = false;
    r.holder = seconds > 0 ? holder : null;
    r.leaseUntil = seconds > 0 ? this.clock.t + seconds * 1000 : 0;
    const progress: Extract<LeaseResult, { state: "umstellung" }>["progress"] = {};
    for (const [t, p] of this.progress) progress[t] = { ...p };
    return { state: "umstellung", runId: r.runId, target: r.target, waitMs: Math.max(0, r.writeAfter - this.clock.t), progress, queued: this.queue.size };
  }

  private sortedIds(table: ReindexTable): string[] {
    const ids = [...this.tables[table].keys()];
    const numeric = table === "messages" || table === "memory";
    return ids.sort((a, b) => (numeric ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0));
  }

  async batch(table: ReindexTable, afterId: string | null, limit: number): Promise<SourceRow[]> {
    const numeric = table === "messages" || table === "memory";
    const ids = this.sortedIds(table).filter(id => afterId === null || (numeric ? Number(id) > Number(afterId) : id > afterId));
    const rows = ids.slice(0, limit).map(id => ({ ...this.tables[table].get(id)!.data }));
    this.hooks.afterBatch?.(table, rows);
    return rows;
  }

  async queued(table: ReindexTable, limit: number): Promise<Array<{ rowId: string; seq: number }>> {
    return [...this.queue.entries()]
      .filter(([k, q]) => k.startsWith(`${table}:`) && !q.failed)
      .sort((a, b) => a[1].seq - b[1].seq)
      .slice(0, limit)
      .map(([k, q]) => ({ rowId: k.slice(table.length + 1), seq: q.seq }));
  }

  async rows(table: ReindexTable, ids: string[]): Promise<SourceRow[]> {
    return ids.filter(id => this.tables[table].has(id)).map(id => ({ ...this.tables[table].get(id)!.data }));
  }

  async write(input: WriteInput): Promise<WriteResult> {
    this.hooks.beforeWrite?.(input);
    const r = this.run;
    if (!r || r.runId !== input.runId || r.holder !== input.holder || r.leaseUntil <= this.clock.t) return { ok: false, state: "belegt" };
    if (this.clock.t < r.writeAfter) return { ok: false, state: "zu-frueh" };
    const key = embeddingKey(r.target);
    for (const row of input.rows) {
      if (!this.rowCurrent(input.table, row)) continue;
      const existing = this.tables[input.table].get(row.id);
      const vec = row.failed ? null : row.embedding;
      if (existing) {
        existing.embedding = vec;
        existing.model = vec ? key : null;
      }
      const qk = `${input.table}:${row.id}`;
      const q = this.queue.get(qk);
      if (row.failed) {
        if (row.seq !== undefined) {
          if (q && q.seq === row.seq) q.failed = true;
        } else if (!q) this.queue.set(qk, { seq: ++this.seq, failed: true });
      } else if (row.seq !== undefined && q?.seq === row.seq) this.queue.delete(qk);
    }
    if (input.lastId !== undefined && (input.lastId !== null || input.finished)) {
      const p = this.progress.get(input.table) ?? { lastId: null, done: 0, finished: false };
      this.progress.set(input.table, { lastId: input.lastId ?? p.lastId, done: p.done + (input.done ?? 0), finished: p.finished || !!input.finished });
    } else if (input.finished) {
      const p = this.progress.get(input.table) ?? { lastId: null, done: 0, finished: false };
      this.progress.set(input.table, { ...p, finished: true });
    }
    this.writes.push({ t: this.clock.t, table: input.table, ids: input.rows.map(x => x.id) });
    this.hooks.afterWrite?.(input);
    return { ok: true };
  }

  async finish(runId: string, holder: string): Promise<FinishResult> {
    this.hooks.beforeFinish?.();
    const r = this.run;
    if (!r || r.runId !== runId || r.holder !== holder || r.leaseUntil <= this.clock.t) return { state: "belegt" };
    const finished = REINDEX_TABLES.filter(t => this.progress.get(t)?.finished).length;
    if (finished < 4) return { state: "umstellung", queued: this.queue.size, failed: 0 };
    // Vektoren mit anderer Angabe vormerken
    const key = embeddingKey(r.target);
    for (const t of REINDEX_TABLES) {
      for (const [id, row] of this.tables[t]) {
        if (row.embedding && row.model !== key && !this.queue.has(`${t}:${id}`)) this.queue.set(`${t}:${id}`, { seq: ++this.seq, failed: false });
      }
    }
    if (this.queue.size > 0) return { state: "umstellung", queued: this.queue.size, failed: [...this.queue.values()].filter(q => q.failed).length };
    this.settings = r.target;
    this.generation++;
    this.run = null;
    this.progress.clear();
    return { state: "festgehalten", target: r.target };
  }

  async overview(): Promise<ReindexOverview | null> {
    const r = this.run;
    if (!r) return null;
    const progress: ReindexOverview["progress"] = {};
    for (const [t, p] of this.progress) progress[t] = { done: p.done, finished: p.finished };
    return { target: r.target, active: r.leaseUntil > this.clock.t, writeAfter: new Date(r.writeAfter).toISOString(), progress, queued: this.queue.size };
  }
}

export interface FakeProvider {
  fetch: FetchLike;
  /** Gesendete Texte, in Reihenfolge */
  texts: string[];
  /** Nächste Antworten statt eines Embeddings: Status und optional Retry-After */
  script: Array<{ status: number; retryAfter?: string } | "netz">;
  /** Vor jeder Antwort aufgerufen (etwa um mittendrin abzubrechen) */
  onCall?(n: number, text: string): void;
  /** Vor jeder Antwort abgewartet (langsamer Anbieter, etwa mit VirtualClock.sleep) */
  delay?(n: number, text: string): Promise<void>;
  calls: number;
}

/**
 * Anbieter-Attrappe für OpenAI, Gemini und Ollama, dazu die Status-RPC der
 * Datenbank (für embedForDatabase in den Tests zum Übergang)
 */
export function fakeProvider(db?: FakeDb, supabaseUrl = "https://projekt.supabase.co"): FakeProvider {
  const p: FakeProvider = { texts: [], script: [], calls: 0, fetch: async () => new Response() };
  const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });
  p.fetch = async (url, init = {}) => {
    const body = init.body ? JSON.parse(String(init.body)) : {};
    if (db && url.startsWith(`${supabaseUrl}/rest/v1/rpc/`)) {
      const fn = url.slice(`${supabaseUrl}/rest/v1/rpc/`.length);
      if (fn === "embedding_provider_status") return json(db.status());
      if (fn === "claim_embedding_provider") {
        if (!db.run && db.settings === null) db.settings = db.allVectors().some(v => v !== null) ? "altbestand" : { provider: body.p_provider, model: body.p_model };
        return json(db.status());
      }
      return json({ code: "PGRST202" }, 404);
    }
    let provider: EmbeddingConfig["provider"];
    let text: string;
    if (url.startsWith("https://api.openai.com/")) {
      provider = "openai";
      text = body.input;
    } else if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      provider = "gemini";
      text = body.content.parts[0].text;
    } else if (url.includes("/api/embed")) {
      provider = "ollama";
      text = body.input;
    } else throw new Error(`Unerwartete Adresse in Tests: ${url}`);
    p.calls++;
    p.onCall?.(p.calls, text);
    if (p.delay) await p.delay(p.calls, text);
    const next = p.script.shift();
    if (next === "netz") throw new TypeError("Unable to connect");
    if (next) return json({ error: { message: "rate limited sk-geheim" } }, next.status, next.retryAfter ? { "Retry-After": next.retryAfter } : {});
    p.texts.push(text);
    const v = fakeVector(provider, text);
    if (provider === "openai") return json({ data: [{ embedding: v }] });
    if (provider === "gemini") return json({ embedding: { values: v } });
    return json({ embeddings: [v] });
  };
  return p;
}
