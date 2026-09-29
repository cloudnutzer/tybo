/**
 * Neuberechnung der Embeddings nach einem Anbieterwechsel (Issue #168), nur
 * für Supabase (Convex bleibt bei OpenAI, convex/embeddings.ts).
 *
 * Vektoren verschiedener Modelle sind nicht vergleichbar. Wechselt Anbieter
 * oder Modell, rechnet runReindex jede Zeile der Spalten embedding in
 * messages, memory, knowledge und assets mit dem neuen Modell neu, in
 * Stapeln. Die Datenbank sorgt dafür, dass dabei nichts gemischt wird
 * (db/migrations/20260928_embedding_reindex.sql): jede Zeile trägt in
 * embedding_model, womit ihr Vektor entstand; ein Trigger prüft das bei
 * jedem Schreiben, die Suchfunktionen beim Vergleichen, und während der
 * Umstellung gibt es keine semantische Suche. Neue Vektoren entstehen erst
 * nach einer Schonfrist (write_after).
 *
 * Wiederaufnahme: Fortschritt je Lauf und Tabelle (letzte bestätigte ID)
 * steht in der Datenbank und wird im selben Aufruf wie der Stapel gesetzt.
 * Nach einem Abbruch geht es beim nächsten unbestätigten Stapel weiter. Ein
 * Lauf gehört einem Prozess (Frist, lease); der Prozess verlängert sie alle
 * REINDEX_RENEW_MS, auch mitten in einem langsamen Stapel oder einer langen
 * Anfrage beim Anbieter; ein zweiter wartet.
 *
 * Texte, die der Anbieter ablehnt (etwa HTTP 400 oder 404), bleiben in der
 * Datenbank als offen vorgemerkt: kein Umschalten, bis sie gerechnet sind;
 * ein neuer Lauf versucht sie erneut. Nur Anzeige-Meldungen, Nicht-Fakten und
 * leere Texte bekommen absichtlich keinen Vektor.
 *
 * Texte und Kürzung wie bei den Schreibern:
 * - messages: content wie store-telegram-message (ungekürzt); Anzeige-
 *   Meldungen (metadata.display_only, Entscheidung 0006) bekommen keinen Vektor
 * - memory: nur Fakten, content auf 8000 Zeichen wie generateEmbedding in
 *   src/lib/supabase.ts; andere Einträge ohne Vektor
 * - knowledge: „Titel: Inhalt“ wie src/lib/knowledge-base.ts
 * - assets: Beschreibung und Tags wie updateAssetDescription in src/lib/asset-store.ts
 * Zeilen ohne Text bekommen NULL, damit kein alter Vektor zurückbleibt.
 *
 * Wirft nicht über die Grenze runReindex hinaus; Meldungen sind feste Sätze
 * ohne Schlüssel oder Antworttexte der Anbieter.
 */

import {
  createEmbedding,
  describeConfig,
  restHeaders,
  type EmbedResult,
  type EmbeddingConfig,
  type EnvReader,
  type FetchLike,
  type RegistryTarget,
} from "../../supabase/functions/_shared/embedding";

export const REINDEX_TABLES = ["messages", "memory", "knowledge", "assets"] as const;
export type ReindexTable = (typeof REINDEX_TABLES)[number];

export type SourceRow = Record<string, unknown> & { id: string | number };

interface TableSpec {
  /** Spalten für select */
  columns: string;
  /** Text für das Embedding; null: diese Zeile bekommt keinen Vektor */
  text(row: SourceRow): string | null;
  label: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export const TABLE_SPECS: Record<ReindexTable, TableSpec> = {
  messages: {
    columns: "id,content,metadata",
    label: "Verlauf",
    text: row => {
      const meta = row.metadata as Record<string, unknown> | null | undefined;
      if (meta && typeof meta === "object" && meta.display_only === true) return null;
      const content = str(row.content);
      return content ? content : null;
    },
  },
  memory: {
    columns: "id,type,content",
    label: "Erinnerungen",
    text: row => (row.type === "fact" && str(row.content) ? str(row.content).substring(0, 8000) : null),
  },
  knowledge: {
    columns: "id,title,content",
    label: "Wissen",
    text: row => `${str(row.title)}: ${str(row.content)}`,
  },
  assets: {
    columns: "id,description,tags",
    label: "Bilder",
    text: row => {
      const description = str(row.description);
      if (!description) return null;
      const tags = Array.isArray(row.tags) ? row.tags.filter((t): t is string => typeof t === "string") : [];
      return `${description} ${tags.join(" ")}`;
    },
  },
};

/** Wartezeit nach dem Beginn, bis neue Vektoren entstehen (wie im SQL: 6 Minuten, länger als REGISTRY_TTL_MS) */
export const REINDEX_WRITE_DELAY_MS = 6 * 60_000;
/** Zeilen je Stapel */
export const REINDEX_BATCH_SIZE = 50;
/** Frist des Laufs */
export const REINDEX_LEASE_SECONDS = 120;
/** So oft verlängert der rechnende Prozess die Frist, unabhängig vom Fortschritt */
export const REINDEX_RENEW_MS = 30_000;
/** So lange hält tybo setup suche den Lauf, bis die Neuberechnung ihn übernimmt (gleicher Inhaber) */
export const REINDEX_RESERVE_SECONDS = 15 * 60;
/** Pausen bei HTTP 429 ohne Retry-After: 10 s, verdoppelt bis höchstens 5 Minuten */
export const RATE_LIMIT_FIRST_MS = 10_000;
export const RATE_LIMIT_MAX_MS = 5 * 60_000;
/** So lange insgesamt Pausen für eine Zeile, danach Abbruch (fortsetzbar) */
export const RATE_LIMIT_GIVE_UP_MS = 60 * 60_000;
/** Netz- und Serverfehler: so viele Versuche je Zeile */
export const TRANSIENT_ATTEMPTS = 5;
/** So viele Zeilen hintereinander vom Anbieter abgelehnt: eher Schlüssel oder Modell, Abbruch */
export const REJECTED_IN_A_ROW = 3;
/** Runden für nachgezogene Zeilen, bevor der Lauf aufgibt (fortsetzbar) */
export const QUEUE_ROUNDS = 50;

// ---------------------------------------------------------------------------
// Schätzung
// ---------------------------------------------------------------------------

export type TableCounts = Record<ReindexTable, { rows: number; chars: number }>;

/** Preise in US-Dollar je Million Tokens (Stand 09/2026, Preislisten der Anbieter); unbekannt: null */
export const PRICE_PER_MILLION: Record<string, number> = {
  "openai:text-embedding-3-small": 0.02,
  "openai:text-embedding-3-large": 0.13,
  "openai:text-embedding-ada-002": 0.1,
};

/** Grobe Sekunden je Anfrage (nacheinander, ohne Pausen) */
export const SECONDS_PER_REQUEST: Record<EmbeddingConfig["provider"], number> = {
  openai: 0.3,
  gemini: 0.4,
  ollama: 0.5,
};

export interface ReindexEstimate {
  rows: number;
  chars: number;
  /** Etwa ein Token je vier Zeichen */
  tokens: number;
  /** Minuten inklusive Wartezeit am Anfang, aufgerundet */
  minutes: number;
  /** US-Dollar; null: Preis unbekannt; 0: kostenlos (Ollama) */
  costUsd: number | null;
  config: EmbeddingConfig;
  perTable: TableCounts;
}

export function estimateReindex(counts: TableCounts, config: EmbeddingConfig): ReindexEstimate {
  let rows = 0;
  let chars = 0;
  for (const t of REINDEX_TABLES) {
    rows += counts[t].rows;
    chars += counts[t].chars;
  }
  const tokens = Math.ceil(chars / 4);
  const seconds = rows * SECONDS_PER_REQUEST[config.provider] + REINDEX_WRITE_DELAY_MS / 1000;
  const price = config.provider === "ollama" ? 0 : (PRICE_PER_MILLION[`${config.provider}:${config.model}`] ?? null);
  return {
    rows,
    chars,
    tokens,
    minutes: Math.ceil(seconds / 60),
    costUsd: price === null ? null : (tokens / 1_000_000) * price,
    config,
    perTable: counts,
  };
}

function number(n: number): string {
  return n.toLocaleString("de-DE");
}

function dollars(usd: number): string {
  if (usd === 0) return "0 US-Dollar";
  if (usd < 0.01) return "unter 1 Cent";
  return `etwa ${usd.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} US-Dollar`;
}

/** Ein Satz mit Umfang, Dauer und Kosten, nachvollziehbar gerechnet */
export function estimateText(e: ReindexEstimate): string {
  const parts = REINDEX_TABLES.filter(t => e.perTable[t].rows > 0).map(t => `${TABLE_SPECS[t].label} ${number(e.perTable[t].rows)}`);
  const scope = `ca. ${number(e.rows)} Einträge${parts.length ? ` (${parts.join(", ")})` : ""}, etwa ${number(e.tokens)} Tokens (ein Token je vier Zeichen)`;
  const duration = `Dauer etwa ${e.minutes} Minuten (${number(e.rows)} Anfragen nacheinander, je etwa ${String(SECONDS_PER_REQUEST[e.config.provider]).replace(".", ",")} s, plus ${REINDEX_WRITE_DELAY_MS / 60_000} Minuten Wartezeit am Anfang; Pausen bei Ratenlimits kommen dazu)`;
  const cost =
    e.config.provider === "ollama"
      ? "Kosten: keine (Ollama rechnet auf diesem Rechner)"
      : e.costUsd === null
        ? e.config.provider === "gemini"
          ? "Kosten: im kostenlosen Kontingent von Gemini keine, sonst laut Preisliste von Google"
          : `Kosten: Preis für ${e.config.model} unbekannt, siehe Preisliste des Anbieters`
        : `Kosten: ${dollars(e.costUsd)} (${String(PRICE_PER_MILLION[`${e.config.provider}:${e.config.model}`]).replace(".", ",")} US-Dollar je Million Tokens)`;
  return `${scope}; ${duration}; ${cost}`;
}

// ---------------------------------------------------------------------------
// Datenbank
// ---------------------------------------------------------------------------

export type LeaseResult =
  | { state: "umstellung"; runId: string; target: EmbeddingConfig; waitMs: number; progress: Partial<Record<ReindexTable, { lastId: string | null; done: number; finished: boolean }>>; queued: number }
  | { state: "belegt"; target?: EmbeddingConfig }
  | { state: "kein-lauf" };

export type StartResult =
  /** active: gerade hält ein anderer Prozess diesen Lauf (er rechnet schon) */
  | { state: "umstellung"; runId: string; target: EmbeddingConfig; fresh: boolean; active?: boolean }
  | { state: "festgehalten"; target: EmbeddingConfig }
  | { state: "belegt"; target?: EmbeddingConfig };

export interface WriteRow {
  id: string;
  embedding: number[] | null;
  /** Vorgemerkte Zeile: nur mit dieser Nummer austragen */
  seq?: number;
  /** Vom Anbieter abgelehnt: ohne Vektor, bleibt offen (kein Umschalten) */
  failed?: boolean;
}

export interface WriteInput {
  runId: string;
  holder: string;
  table: ReindexTable;
  rows: WriteRow[];
  /** Fortschritt: letzte bestätigte ID des Hauptdurchgangs */
  lastId?: string | null;
  done?: number;
  finished?: boolean;
}

export type WriteResult = { ok: true } | { ok: false; state: "belegt" | "zu-frueh" };

/** umstellung: noch nicht umgeschaltet; queued: offen vorgemerkt, davon failed abgelehnt */
export type FinishResult = { state: "festgehalten"; target: EmbeddingConfig } | { state: "umstellung"; queued: number; failed: number } | { state: "belegt" };

/** Stand für tybo suche status, nur lesen */
export interface ReindexOverview {
  target: EmbeddingConfig;
  /** Ein Prozess rechnet gerade (Frist nicht abgelaufen) */
  active: boolean;
  /** Ab wann neue Vektoren entstehen (ISO) */
  writeAfter: string;
  progress: Partial<Record<ReindexTable, { done: number; finished: boolean }>>;
  queued: number;
}

/** Was die Neuberechnung von der Datenbank braucht; Tests setzen eine Attrappe ein */
export interface ReindexStore {
  estimate(): Promise<TableCounts>;
  /** Beginnen bzw. reservieren; mit holder und seconds hält der Aufrufer den Lauf so lange */
  start(target: EmbeddingConfig, holder?: string, seconds?: number): Promise<StartResult>;
  lease(holder: string, seconds: number): Promise<LeaseResult>;
  /** Hauptdurchgang: Zeilen nach afterId, aufsteigend nach id */
  batch(table: ReindexTable, afterId: string | null, limit: number): Promise<SourceRow[]>;
  /** Vorgemerkte Zeilen (fremd geschrieben während der Umstellung), ohne die in diesem Lauf abgelehnten */
  queued(table: ReindexTable, limit: number): Promise<Array<{ rowId: string; seq: number }>>;
  rows(table: ReindexTable, ids: string[]): Promise<SourceRow[]>;
  write(input: WriteInput): Promise<WriteResult>;
  finish(runId: string, holder: string): Promise<FinishResult>;
  /** null: keine Umstellung */
  overview(): Promise<ReindexOverview | null>;
}

/** Nachzug ohne Umstellung (drainQueue); „anders“: die Datenbank hält einen anderen Anbieter fest */
export type QueueWriteResult = { ok: true } | { ok: false; state: "umstellung" | "anders" };

/** Was drainQueue von der Datenbank braucht */
export interface QueueStore {
  queued: ReindexStore["queued"];
  rows: ReindexStore["rows"];
  queueWrite(config: EmbeddingConfig, table: ReindexTable, rows: WriteRow[]): Promise<QueueWriteResult>;
}

export class ReindexStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReindexStoreError";
  }
}

function asConfig(provider: unknown, model: unknown): EmbeddingConfig | undefined {
  if ((provider === "openai" || provider === "gemini" || provider === "ollama") && typeof model === "string" && model) return { provider, model };
  return undefined;
}

/** Zeitlimit je Anfrage an die Datenbank */
export const STORE_TIMEOUT_MS = 30_000;

/** Die Datenbank über die REST-API von Supabase (PostgREST) mit dem Server-Schlüssel */
export function restReindexStore(target: RegistryTarget, fetchFn: FetchLike): ReindexStore & QueueStore {
  const base = target.url.replace(/\/+$/, "");
  async function call(path: string, init: { method: string; body?: unknown }): Promise<any> {
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        method: init.method,
        headers: restHeaders(target.key),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
      });
    } catch {
      throw new ReindexStoreError("Die Datenbank ist nicht erreichbar.");
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      throw new ReindexStoreError("Der Datenbank fehlt die Migration 20260928_embedding_reindex.sql. Schema aktualisieren mit tybo setup datenbank.");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ReindexStoreError(`Die Datenbank meldet einen Fehler (HTTP ${res.status}).`);
    }
    try {
      return await res.json();
    } catch {
      throw new ReindexStoreError("Die Datenbank hat keine lesbare Antwort geliefert.");
    }
  }
  const rpc = (fn: string, args: Record<string, unknown>) => call(`/rest/v1/rpc/${fn}`, { method: "POST", body: args });
  const idList = (ids: string[]) => ids.map(id => `"${id.replace(/["\\]/g, "")}"`).join(",");
  return {
    async estimate() {
      const data = await rpc("embedding_reindex_estimate", {});
      const out = {} as TableCounts;
      for (const t of REINDEX_TABLES) {
        const v = data?.[t];
        out[t] = { rows: Number(v?.rows) || 0, chars: Number(v?.chars) || 0 };
      }
      return out;
    },
    async start(config, holder, seconds) {
      const data = await rpc("embedding_reindex_start", { p_provider: config.provider, p_model: config.model, p_holder: holder ?? null, p_seconds: seconds ?? 0 });
      const t = asConfig(data?.provider, data?.model);
      if (data?.state === "umstellung" && t && typeof data.run_id === "string") return { state: "umstellung", runId: data.run_id, target: t, fresh: data.fresh === true, active: data.active === true };
      if (data?.state === "festgehalten" && t) return { state: "festgehalten", target: t };
      if (data?.state === "belegt") return { state: "belegt", target: t };
      throw new ReindexStoreError("Die Datenbank hat keine lesbare Antwort geliefert.");
    },
    async lease(holder, seconds) {
      const data = await rpc("embedding_reindex_lease", { p_holder: holder, p_seconds: seconds });
      if (data?.state === "kein-lauf") return { state: "kein-lauf" };
      const t = asConfig(data?.provider, data?.model);
      if (data?.state === "belegt") return { state: "belegt", target: t };
      if (data?.state !== "umstellung" || !t || typeof data.run_id !== "string") throw new ReindexStoreError("Die Datenbank hat keine lesbare Antwort geliefert.");
      const progress: Extract<LeaseResult, { state: "umstellung" }>["progress"] = {};
      for (const tab of REINDEX_TABLES) {
        const p = data.progress?.[tab];
        if (p) progress[tab] = { lastId: typeof p.last_id === "string" ? p.last_id : null, done: Number(p.done) || 0, finished: p.finished === true };
      }
      return { state: "umstellung", runId: data.run_id, target: t, waitMs: Math.max(0, Number(data.wait_ms) || 0), progress, queued: Number(data.queued) || 0 };
    },
    async batch(table, afterId, limit) {
      const after = afterId === null ? "" : `&id=gt.${encodeURIComponent(afterId)}`;
      return call(`/rest/v1/${table}?select=${TABLE_SPECS[table].columns}&order=id.asc&limit=${limit}${after}`, { method: "GET" });
    },
    async queued(table, limit) {
      const data = await call(`/rest/v1/embedding_reindex_queue?select=row_id,seq&tab=eq.${table}&failed=is.false&order=seq.asc&limit=${limit}`, { method: "GET" });
      return (Array.isArray(data) ? data : []).map((r: any) => ({ rowId: String(r.row_id), seq: Number(r.seq) }));
    },
    async rows(table, ids) {
      if (!ids.length) return [];
      return call(`/rest/v1/${table}?select=${TABLE_SPECS[table].columns}&id=in.(${encodeURIComponent(idList(ids))})`, { method: "GET" });
    },
    async write(input) {
      const data = await rpc("embedding_reindex_write", {
        p_run: input.runId,
        p_holder: input.holder,
        p_tab: input.table,
        p_rows: input.rows.map(r => ({
          id: r.id,
          embedding: r.embedding && !r.failed ? JSON.stringify(r.embedding) : null,
          ...(r.seq !== undefined ? { seq: r.seq } : {}),
          ...(r.failed ? { failed: true } : {}),
        })),
        p_last_id: input.lastId ?? null,
        p_done: input.done ?? 0,
        p_finished: input.finished ?? false,
      });
      if (data?.ok === true) return { ok: true };
      if (data?.state === "zu-frueh") return { ok: false, state: "zu-frueh" };
      return { ok: false, state: "belegt" };
    },
    async queueWrite(config, table, rows) {
      const data = await rpc("embedding_queue_write", {
        p_provider: config.provider,
        p_model: config.model,
        p_tab: table,
        p_rows: rows.map(r => ({
          id: r.id,
          seq: r.seq,
          embedding: r.embedding && !r.failed ? JSON.stringify(r.embedding) : null,
          ...(r.failed ? { failed: true } : {}),
        })),
      });
      if (data?.ok === true) return { ok: true };
      return { ok: false, state: data?.state === "umstellung" ? "umstellung" : "anders" };
    },
    async overview() {
      const runs = await call("/rest/v1/embedding_reindex?select=run_id,provider,model,write_after,lease_until", { method: "GET" });
      const run = Array.isArray(runs) ? runs[0] : null;
      const t = asConfig(run?.provider, run?.model);
      if (!run || !t) return null;
      const rows = await call(`/rest/v1/embedding_reindex_progress?select=tab,done,finished&run_id=eq.${encodeURIComponent(String(run.run_id))}`, { method: "GET" });
      const progress: ReindexOverview["progress"] = {};
      for (const r of Array.isArray(rows) ? rows : []) {
        if ((REINDEX_TABLES as readonly string[]).includes(r.tab)) progress[r.tab as ReindexTable] = { done: Number(r.done) || 0, finished: r.finished === true };
      }
      const queue = await call("/rest/v1/embedding_reindex_queue?select=row_id&limit=1000", { method: "GET" });
      const until = Date.parse(String(run.lease_until ?? ""));
      return { target: t, active: Number.isFinite(until) && until > Date.now(), writeAfter: String(run.write_after ?? ""), progress, queued: Array.isArray(queue) ? queue.length : 0 };
    },
    async finish(runId, holder) {
      const data = await rpc("embedding_reindex_finish", { p_run: runId, p_holder: holder });
      const t = asConfig(data?.provider, data?.model);
      if (data?.state === "festgehalten" && t) return { state: "festgehalten", target: t };
      if (data?.state === "umstellung") return { state: "umstellung", queued: Number(data.queued) || 0, failed: Number(data.failed) || 0 };
      return { state: "belegt" };
    },
  };
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

export interface ReindexProgress {
  table: ReindexTable;
  /** Bestätigte Zeilen dieser Tabelle im Hauptdurchgang */
  done: number;
  /** Zeilen der Tabelle laut Schätzung (nur mit Text) */
  total: number;
  phase: "warten" | "haupt" | "nachzug" | "pause";
  /** Wartezeit in ms (warten, pause) */
  waitMs?: number;
}

export interface ReindexOptions {
  store: ReindexStore;
  /** Einstellung aus der Umgebung; muss dem Ziel des Laufs entsprechen */
  config: EmbeddingConfig;
  env: EnvReader;
  fetch: FetchLike;
  holder: string;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /**
   * Ruft fn alle ms Millisekunden auf, bis die Rückgabe aufgerufen wird
   * (Verlängern der Frist); Standard setInterval. Tests setzen eine
   * kontrollierte Uhr ein.
   */
  every?(ms: number, fn: () => void): () => void;
  signal?: AbortSignal;
  report?(p: ReindexProgress): void;
  batchSize?: number;
}

export type ReindexOutcome =
  | { state: "fertig"; target: EmbeddingConfig; written: number; withoutVector: number }
  | { state: "kein-lauf" | "belegt" | "abgebrochen" | "fehler" | "konfiguration"; message: string };

/** Abbruch mit Meldung; der Stand bis zum letzten bestätigten Stapel bleibt */
class Stop extends Error {
  constructor(
    readonly state: "abgebrochen" | "fehler" | "belegt",
    message: string,
  ) {
    super(message);
  }
}

const RESUME = "Fortsetzen mit: tybo suche neu-berechnen. Bis dahin sucht tybo nur nach Text.";
const TAKEN = "Die Neuberechnung hat inzwischen ein anderer Prozess übernommen.";

const defaultEvery: NonNullable<ReindexOptions["every"]> = (ms, fn) => {
  const timer = setInterval(fn, ms);
  (timer as { unref?: () => void }).unref?.();
  return () => clearInterval(timer);
};

interface RowContext {
  o: ReindexOptions;
  signal: AbortSignal;
  /** Wirft, wenn abgebrochen wurde oder der Lauf verloren ist */
  halt(): void;
  state: { rejected: number };
  keepAlive(waitMs: number): Promise<void>;
}

/**
 * Ein Embedding für eine Zeile, mit Pausen: HTTP 429 wartet Retry-After (sonst
 * 10 s, verdoppelt bis 5 Minuten) und wiederholt dieselbe Zeile; Netz- und
 * Serverfehler bis zu fünf Versuche. Eine einzelne Ablehnung (etwa ein zu
 * langer Text) ergibt „abgelehnt“ (die Zeile bleibt offen), drei hintereinander
 * brechen ab.
 */
async function embedRow(text: string, c: RowContext): Promise<number[] | "abgelehnt"> {
  let pausedMs = 0;
  let nextPause = RATE_LIMIT_FIRST_MS;
  let transient = 0;
  for (;;) {
    c.halt();
    const result: EmbedResult = await createEmbedding(text, c.o.config, c.o.env, c.o.fetch, c.signal);
    // Fertig gerechnet: behalten (wird vor dem Aufhören noch bestätigt)
    if (result.ok) {
      c.state.rejected = 0;
      return result.vector;
    }
    c.halt();
    if (result.status === 429) {
      const wait = Math.max(1000, result.retryAfterMs ?? nextPause);
      if (pausedMs + wait > RATE_LIMIT_GIVE_UP_MS) throw new Stop("fehler", `${describeConfig(c.o.config)} nimmt seit über einer Stunde nichts an (HTTP 429). ${RESUME}`);
      pausedMs += wait;
      nextPause = Math.min(nextPause * 2, RATE_LIMIT_MAX_MS);
      await c.keepAlive(wait);
      continue;
    }
    if (result.reason === "kein-zugang" || result.status === 401 || result.status === 403) throw new Stop("fehler", `${result.message} ${RESUME}`);
    if (result.reason === "nicht-erreichbar" || result.reason === "ungueltig") {
      transient++;
      if (transient >= TRANSIENT_ATTEMPTS) throw new Stop("fehler", `${result.message} ${RESUME}`);
      await c.keepAlive(Math.min(RATE_LIMIT_FIRST_MS * transient, 60_000));
      continue;
    }
    // Abgelehnt (400, 404, zu viele Werte): diese Zeile bleibt offen, mehrfach hintereinander: Abbruch
    c.state.rejected++;
    if (c.state.rejected >= REJECTED_IN_A_ROW) throw new Stop("fehler", `${result.message} ${RESUME}`);
    return "abgelehnt";
  }
}

/**
 * Die Neuberechnung: Lauf übernehmen, Wartezeit abwarten, jede Tabelle in
 * Stapeln, dann vorgemerkte Zeilen nachziehen, dann umschalten. Bei Fehler
 * oder Abbruch bleibt die Umstellung (Textsuche), die Kennung unverändert.
 * Die Frist wird alle REINDEX_RENEW_MS verlängert, solange der Lauf rechnet;
 * übernimmt trotzdem ein anderer, bricht die laufende Anfrage ab und nichts
 * wird mehr geschrieben.
 */
export async function runReindex(o: ReindexOptions): Promise<ReindexOutcome> {
  const size = o.batchSize ?? REINDEX_BATCH_SIZE;
  let runId = "";
  let written = 0;
  let withoutVector = 0;
  const report = o.report ?? (() => {});
  const holder = o.holder;
  // Eigener Abbruch: von außen (Strg+C) oder weil der Lauf verloren ist
  const inner = new AbortController();
  const onAbort = () => inner.abort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  let lost = false;
  let stopBeat: (() => void) | null = null;
  let beating: Promise<void> | null = null;

  const halt = () => {
    if (lost) throw new Stop("belegt", TAKEN);
    if (o.signal?.aborted) throw new Stop("abgebrochen", `Abgebrochen. ${RESUME}`);
  };
  async function renew(): Promise<void> {
    const lease = await o.store.lease(holder, REINDEX_LEASE_SECONDS);
    if (lease.state !== "umstellung" || (runId && lease.runId !== runId)) {
      lost = true;
      inner.abort();
      throw new Stop("belegt", TAKEN);
    }
  }
  /** Verlängern im Takt, unabhängig vom Fortschritt; Fehler (Netz) fängt der nächste Schlag */
  function beat(): void {
    if (beating || lost) return;
    beating = renew()
      .catch(() => {})
      .finally(() => {
        beating = null;
      });
  }
  async function stopBeating(): Promise<void> {
    stopBeat?.();
    stopBeat = null;
    if (beating) await beating;
  }
  /** Warten in Abschnitten, dabei die Frist verlängern */
  async function pause(ms: number, table: ReindexTable, phase: ReindexProgress["phase"], done = 0, total = 0): Promise<void> {
    let left = ms;
    while (left > 0) {
      halt();
      report({ table, done, total, phase, waitMs: left });
      const step = Math.min(left, 60_000);
      await o.sleep(step, inner.signal);
      halt();
      left -= step;
      await renew();
    }
  }
  async function write(input: Omit<WriteInput, "runId" | "holder">): Promise<void> {
    halt();
    const result = await o.store.write({ ...input, runId, holder });
    if (!result.ok) {
      if (result.state === "zu-frueh") throw new Stop("fehler", `Die Datenbank lässt noch nicht schreiben (Wartezeit). ${RESUME}`);
      lost = true;
      throw new Stop("belegt", TAKEN);
    }
    for (const r of input.rows) {
      if (r.failed) continue;
      if (r.embedding) written++;
      else withoutVector++;
    }
  }
  const state = { rejected: 0 };
  const context = (keepAlive: RowContext["keepAlive"]): RowContext => ({ o, signal: inner.signal, halt, state, keepAlive });
  async function compute(table: ReindexTable, row: SourceRow | undefined, keepAlive: RowContext["keepAlive"]): Promise<Omit<WriteRow, "id" | "seq">> {
    const text = row ? TABLE_SPECS[table].text(row) : null;
    if (text === null) return { embedding: null };
    const v = await embedRow(text, context(keepAlive));
    return v === "abgelehnt" ? { embedding: null, failed: true } : { embedding: v };
  }

  try {
    const first = await o.store.lease(holder, REINDEX_LEASE_SECONDS);
    if (first.state === "kein-lauf") return { state: "kein-lauf", message: "Es läuft keine Neuberechnung; die Datenbank ist nicht in Umstellung. Anbieter wechseln mit tybo setup suche." };
    if (first.state === "belegt") return { state: "belegt", message: "Ein anderer Prozess rechnet gerade neu. Stand: tybo suche status. Ist er abgestürzt, geht es nach zwei Minuten mit tybo suche neu-berechnen weiter." };
    runId = first.runId;
    if (first.target.provider !== o.config.provider || first.target.model !== o.config.model) {
      await o.store.lease(holder, 0).catch(() => {});
      return {
        state: "konfiguration",
        message: `Die Datenbank wird auf ${describeConfig(first.target)} umgestellt, eingestellt ist ${describeConfig(o.config)}. EMBEDDING_PROVIDER und EMBEDDING_MODEL in der .env auf das Ziel stellen (tybo setup suche), dann erneut.`,
      };
    }
    stopBeat = (o.every ?? defaultEvery)(REINDEX_RENEW_MS, beat);
    let totals: TableCounts | null = null;
    try {
      totals = await o.store.estimate();
    } catch {
      // Nur für die Anzeige
    }
    const total = (t: ReindexTable) => totals?.[t].rows ?? 0;

    if (first.waitMs > 0) await pause(first.waitMs, "messages", "warten");

    // Hauptdurchgang je Tabelle, ab dem letzten bestätigten Stapel
    for (const table of REINDEX_TABLES) {
      const p = first.progress[table];
      if (p?.finished) continue;
      let cursor = p?.lastId ?? null;
      let done = p?.done ?? 0;
      report({ table, done, total: total(table), phase: "haupt" });
      for (;;) {
        halt();
        const rows = await o.store.batch(table, cursor, size);
        if (!rows.length) {
          await write({ table, rows: [], lastId: cursor, done: 0, finished: true });
          break;
        }
        const out: WriteRow[] = [];
        try {
          for (const row of rows) {
            out.push({ id: String(row.id), ...(await compute(table, row, ms => pause(ms, table, "pause", done, total(table)))) });
          }
        } catch (e) {
          // Was bis hierher gerechnet ist, bestätigen; dann abbrechen
          if (out.length && e instanceof Stop && e.state !== "belegt") {
            await o.store.write({ table, rows: out, lastId: out[out.length - 1].id, done: out.length, runId, holder }).catch(() => {});
          }
          throw e;
        }
        cursor = out[out.length - 1].id;
        await write({ table, rows: out, lastId: cursor, done: out.length });
        done += out.length;
        report({ table, done, total: total(table), phase: "haupt" });
        await renew();
      }
    }

    // Nachziehen: während der Umstellung fremd geschriebene oder geänderte Zeilen
    for (let round = 0; round < QUEUE_ROUNDS; round++) {
      for (const table of REINDEX_TABLES) {
        for (;;) {
          halt();
          const entries = await o.store.queued(table, size);
          if (!entries.length) break;
          const found = new Map((await o.store.rows(table, entries.map(e => e.rowId))).map(r => [String(r.id), r]));
          const out: WriteRow[] = [];
          for (const entry of entries) {
            out.push({ id: entry.rowId, seq: entry.seq, ...(await compute(table, found.get(entry.rowId), ms => pause(ms, table, "pause"))) });
          }
          report({ table, done: out.length, total: entries.length, phase: "nachzug" });
          await write({ table, rows: out });
          await renew();
        }
      }
      halt();
      const finished = await o.store.finish(runId, holder);
      if (finished.state === "festgehalten") {
        await stopBeating();
        return { state: "fertig", target: finished.target, written, withoutVector };
      }
      if (finished.state === "belegt") {
        lost = true;
        throw new Stop("belegt", TAKEN);
      }
      // Nur noch abgelehnte Texte offen: nicht umschalten, beim nächsten Lauf erneut
      if (finished.queued > 0 && finished.queued === finished.failed) {
        throw new Stop(
          "fehler",
          `${describeConfig(o.config)} hat ${finished.failed === 1 ? "einen Eintrag" : `${finished.failed} Einträge`} abgelehnt (etwa zu lang oder vom Modell nicht angenommen). Ohne sie schaltet die Suche nicht um. ${RESUME}`,
        );
      }
    }
    throw new Stop("fehler", `Während der Neuberechnung kommen laufend neue Einträge ohne Vektor dazu. ${RESUME}`);
  } catch (e) {
    await stopBeating();
    if (e instanceof Stop) {
      if (e.state !== "belegt" && runId) await o.store.lease(holder, 0).catch(() => {});
      return { state: e.state, message: e.message };
    }
    if (runId && !lost) await o.store.lease(holder, 0).catch(() => {});
    const text = e instanceof ReindexStoreError ? e.message : "Die Neuberechnung ist auf einen unerwarteten Fehler gestoßen.";
    return { state: "fehler", message: `${text} ${RESUME}` };
  } finally {
    o.signal?.removeEventListener("abort", onAbort);
    await stopBeating();
  }
}

// ---------------------------------------------------------------------------
// Nachzug ohne Umstellung
// ---------------------------------------------------------------------------

export interface DrainOptions {
  store: QueueStore;
  /** Einstellung aus der Umgebung; geschrieben wird nur, wenn die Datenbank genau sie festhält */
  config: EmbeddingConfig;
  env: EnvReader;
  fetch: FetchLike;
  signal?: AbortSignal;
  batchSize?: number;
}

export type DrainOutcome =
  | { state: "fertig"; written: number; rejected: number }
  /** umstellung: das erledigt die Neuberechnung; anders: diese Einstellung passt nicht zur Datenbank */
  | { state: "umstellung" | "anders" }
  /** Anbieter gerade nicht erreichbar oder Ratenlimit: beim nächsten Mal */
  | { state: "spaeter"; written: number };

/**
 * Zeilen nachziehen, die der Trigger außerhalb einer Umstellung vorgemerkt hat:
 * ein verspäteter Schreiber brachte für neuen oder geänderten Text einen Vektor
 * eines anderen Anbieters (db/migrations/20260928_embedding_reindex.sql). Der
 * Bot ruft das regelmäßig auf. Abgelehnte Texte bleiben als failed vorgemerkt
 * (die nächste Neuberechnung versucht sie erneut), bei Netzfehlern und HTTP
 * 429 geht es beim nächsten Aufruf weiter. Wirft ReindexStoreError, wenn die
 * Datenbank nicht antwortet.
 */
export async function drainQueue(o: DrainOptions): Promise<DrainOutcome> {
  const size = o.batchSize ?? REINDEX_BATCH_SIZE;
  let written = 0;
  let rejected = 0;
  for (const table of REINDEX_TABLES) {
    for (let round = 0; round < QUEUE_ROUNDS; round++) {
      if (o.signal?.aborted) return { state: "spaeter", written };
      const entries = await o.store.queued(table, size);
      if (!entries.length) break;
      const found = new Map((await o.store.rows(table, entries.map(e => e.rowId))).map(r => [String(r.id), r]));
      const out: WriteRow[] = [];
      let later = false;
      for (const entry of entries) {
        const row = found.get(entry.rowId);
        const text = row ? TABLE_SPECS[table].text(row) : null;
        if (text === null) {
          out.push({ id: entry.rowId, seq: entry.seq, embedding: null });
          continue;
        }
        const result = await createEmbedding(text, o.config, o.env, o.fetch, o.signal);
        if (result.ok) {
          out.push({ id: entry.rowId, seq: entry.seq, embedding: result.vector });
        } else if (result.status === 429 || result.reason === "nicht-erreichbar" || result.reason === "ungueltig" || result.reason === "kein-zugang" || result.status === 401 || result.status === 403) {
          later = true;
          break;
        } else {
          out.push({ id: entry.rowId, seq: entry.seq, embedding: null, failed: true });
        }
      }
      if (out.length) {
        const w = await o.store.queueWrite(o.config, table, out);
        if (!w.ok) return { state: w.state };
        for (const r of out) {
          if (r.failed) rejected++;
          else if (r.embedding) written++;
        }
      }
      if (later) return { state: "spaeter", written };
    }
  }
  return { state: "fertig", written, rejected };
}
