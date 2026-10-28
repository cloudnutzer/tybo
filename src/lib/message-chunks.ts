/**
 * Abschnitte langer Nachrichten nachziehen (nur Supabase). Teilen, Rechnen
 * und Schreiben: supabase/functions/_shared/chunks.ts; Tabelle und Prüfung:
 * db/migrations/20261015_message_chunks.sql.
 *
 * Neue lange Nachrichten bekommen ihre Abschnitte in store-telegram-message.
 * Hier entstehen sie für alles, was dort fehlt: Nachrichten von vor den
 * Abschnitten (einmalige Nachberechnung, tybo suche abschnitte), Nachrichten
 * ohne Abschnitte, weil der Anbieter gerade nicht wollte oder der Direkt-Insert
 * ohne Edge Function lief, geänderte Texte und alle Abschnitte nach einer
 * Neuberechnung auf einen anderen Anbieter (runReindex ruft das nach dem
 * Umschalten auf). Der Bot ruft es beim Start und alle DRAIN_INTERVAL_MS auf
 * (src/app/bot-start.ts, nach dem Nachziehen der vorgemerkten Einträge).
 *
 * Geschrieben wird nur, was die Datenbank für den festgehaltenen Anbieter
 * annimmt (message_chunks_write); welche Nachrichten offen sind, sagt sie
 * selbst (message_chunks_pending).
 *
 * Wirft nie über syncChunks hinaus; Meldungen sind feste Sätze ohne
 * Schlüssel, Texte oder Antworten der Anbieter.
 */

import { createEmbedding, embeddingConfig, hasCredentials, MISSING_FUNCTION_CODES, restHeaders, type EmbeddingConfig, type EnvReader, type FetchLike, type RegistryTarget } from "../../supabase/functions/_shared/embedding";
import { chunkWriteState, storeMessageChunks, type ChunkWriteState } from "../../supabase/functions/_shared/chunks";

/** Nachrichten je Abfrage der offenen */
export const CHUNK_SYNC_BATCH = 20;
/** Höchstens so viele Nachrichten je Nachzug im laufenden Bot (die Nachberechnung hat keine Grenze) */
export const CHUNK_SYNC_MAX_MESSAGES = 50;
/** Zeitlimit je Anfrage an die Datenbank (Schreiben enthält bis zu 40 Vektoren) */
export const CHUNK_STORE_TIMEOUT_MS = 60_000;

export interface ChunkMessage {
  id: number;
  content: string;
  metadata: Record<string, unknown> | null;
}

export interface ChunkStatus {
  /** Nachrichten über 8000 Zeichen */
  long: number;
  /** davon mit Abschnitten des festgehaltenen Anbieters */
  done: number;
  chunks: number;
}

/** Was der Nachzug von der Datenbank braucht; Tests setzen eine Attrappe ein */
export interface ChunkStore {
  /** Offene lange Nachrichten nach afterId; „fehlt“: Migration 20261015 nicht eingespielt */
  pending(config: EmbeddingConfig, afterId: number, limit: number): Promise<number[] | "fehlt">;
  message(id: number): Promise<ChunkMessage | null>;
  write(args: Record<string, unknown>): Promise<ChunkWriteState>;
  status(config: EmbeddingConfig): Promise<ChunkStatus | "fehlt">;
}

export class ChunkStoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChunkStoreError";
  }
}

const MISSING = Symbol("fehlt");

/** Die Datenbank über die REST-API von Supabase mit dem Server-Schlüssel */
export function restChunkStore(target: RegistryTarget, fetchFn: FetchLike): ChunkStore {
  const base = target.url.replace(/\/+$/, "");
  async function call(path: string, init: { method: string; body?: unknown }): Promise<any> {
    let res: Response;
    try {
      res = await fetchFn(`${base}${path}`, {
        method: init.method,
        headers: restHeaders(target.key),
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(CHUNK_STORE_TIMEOUT_MS),
      });
    } catch {
      throw new ChunkStoreError("Die Datenbank ist nicht erreichbar.");
    }
    if (res.status === 404) {
      const data = (await res.json().catch(() => null)) as { code?: unknown } | null;
      if (typeof data?.code === "string" && MISSING_FUNCTION_CODES.includes(data.code)) return MISSING;
      throw new ChunkStoreError("Die Datenbank meldet einen Fehler (HTTP 404).");
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new ChunkStoreError(`Die Datenbank meldet einen Fehler (HTTP ${res.status}).`);
    }
    try {
      return await res.json();
    } catch {
      throw new ChunkStoreError("Die Datenbank hat keine lesbare Antwort geliefert.");
    }
  }
  const rpc = (fn: string, args: Record<string, unknown>) => call(`/rest/v1/rpc/${fn}`, { method: "POST", body: args });
  return {
    async pending(config, afterId, limit) {
      const data = await rpc("message_chunks_pending", { p_provider: config.provider, p_model: config.model, p_after_id: afterId, p_limit: limit });
      if (data === MISSING) return "fehlt";
      return (Array.isArray(data) ? data : []).map((r: any) => Number(r?.id)).filter(n => Number.isSafeInteger(n));
    },
    async message(id) {
      const data = await call(`/rest/v1/messages?select=id,content,metadata&id=eq.${id}`, { method: "GET" });
      const row = Array.isArray(data) ? data[0] : null;
      if (!row || typeof row.content !== "string") return null;
      return { id: Number(row.id), content: row.content, metadata: row.metadata && typeof row.metadata === "object" ? row.metadata : null };
    },
    async write(args) {
      try {
        const data = await rpc("message_chunks_write", args);
        return data === MISSING ? "fehlt" : chunkWriteState(data);
      } catch {
        return "fehler";
      }
    },
    async status(config) {
      const data = await rpc("message_chunks_status", { p_provider: config.provider, p_model: config.model });
      if (data === MISSING) return "fehlt";
      return { long: Number(data?.long) || 0, done: Number(data?.done) || 0, chunks: Number(data?.chunks) || 0 };
    },
  };
}

export interface ChunkSyncOptions {
  store: ChunkStore;
  /** Einstellung aus der Umgebung; geschrieben wird nur, wenn die Datenbank genau sie festhält */
  config: EmbeddingConfig;
  env: EnvReader;
  fetch: FetchLike;
  signal?: AbortSignal;
  /** Höchstens so viele Nachrichten; ohne Angabe alle offenen */
  maxMessages?: number;
  report?(done: number): void;
}

export type ChunkSyncOutcome =
  /** messages: Nachrichten mit neuen Abschnitten, chunks: Abschnitte, failed: vom Anbieter abgelehnt oder Text geändert */
  | { state: "fertig"; messages: number; chunks: number; failed: number }
  /** Anbieter gerade nicht erreichbar, Ratenlimit, Abbruch oder Umstellung: beim nächsten Mal weiter */
  | { state: "spaeter"; messages: number; chunks: number; failed: number }
  /** Der Datenbank fehlt die Migration 20261015 */
  | { state: "fehlt" };

/** Fehler, die beim nächsten Mal vorbei sein können: kein Grund, die nächste Nachricht zu versuchen */
function transient(failure: { reason?: string; status?: number } | undefined): boolean {
  if (!failure) return true;
  return failure.status === 429 || failure.status === 401 || failure.status === 403 || failure.reason === "nicht-erreichbar" || failure.reason === "ungueltig" || failure.reason === "kein-zugang";
}

/**
 * Offene lange Nachrichten durchgehen und ihre Abschnitte schreiben. Ein vom
 * Anbieter abgelehnter Abschnitt überspringt nur diese Nachricht (sie bleibt
 * offen); Netzfehler, Ratenlimit, Sperre (Umstellung) beenden den Durchgang.
 * Wirft ChunkStoreError, wenn die Datenbank nicht antwortet.
 */
export async function syncChunks(o: ChunkSyncOptions): Promise<ChunkSyncOutcome> {
  let messages = 0;
  let chunks = 0;
  let failed = 0;
  let afterId = 0;
  const max = o.maxMessages ?? Number.POSITIVE_INFINITY;
  const embed = (text: string) => createEmbedding(text, o.config, o.env, o.fetch, o.signal);
  for (;;) {
    const ids = await o.store.pending(o.config, afterId, CHUNK_SYNC_BATCH);
    if (ids === "fehlt") return { state: "fehlt" };
    if (!ids.length) return { state: "fertig", messages, chunks, failed };
    for (const id of ids) {
      if (o.signal?.aborted || messages + failed >= max) return { state: "spaeter", messages, chunks, failed };
      afterId = id;
      const message = await o.store.message(id);
      if (!message) continue;
      const outcome = await storeMessageChunks(id, message.content, o.config, embed, args => o.store.write(args));
      if (outcome.state === "ok") {
        messages++;
        chunks += outcome.chunks;
        o.report?.(messages);
      } else if (outcome.state === "kein-embedding") {
        if (transient(outcome.failure)) return { state: "spaeter", messages, chunks, failed };
        failed++;
      } else if (outcome.state === "geaendert") {
        failed++;
      } else if (outcome.state === "gesperrt" || outcome.state === "fehler") {
        return { state: "spaeter", messages, chunks, failed };
      } else if (outcome.state === "fehlt") {
        // Nachricht inzwischen gelöscht; fehlt die Funktion, hätte pending das schon gemeldet
        continue;
      }
    }
  }
}

const processEnv: EnvReader = name => process.env[name];

/**
 * Nachzug im laufenden Bot: nur mit Supabase und mit Zugang zum Anbieter;
 * höchstens CHUNK_SYNC_MAX_MESSAGES Nachrichten je Aufruf. Wirft nie; null:
 * nichts zu tun oder nicht möglich.
 */
export async function syncMessageChunks(env: EnvReader = processEnv, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<ChunkSyncOutcome | null> {
  // Wie registryTarget in embedding.ts (nicht importiert: embedding.ts hängt über embedding-reindex.ts an diesem Modul)
  const url = (env("SUPABASE_URL") ?? "").trim();
  const key = (env("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  const parsed = embeddingConfig(env);
  if (!url || !key || !parsed.ok || !hasCredentials(parsed.config, env)) return null;
  try {
    return await syncChunks({ store: restChunkStore({ url, key }, fetchFn), config: parsed.config, env, fetch: fetchFn, maxMessages: CHUNK_SYNC_MAX_MESSAGES });
  } catch (e) {
    if (!(e instanceof ChunkStoreError)) console.warn("[embedding] Nachzug der Abschnitte langer Nachrichten gescheitert");
    return null;
  }
}
