/**
 * Embeddings des Bots für die Supabase-Datenbank (Issue #167): Fakten
 * (memory), Bilder (assets) und Suchanfragen gegen diese Spalten. Anbieter und
 * Modell aus EMBEDDING_PROVIDER/EMBEDDING_MODEL, dieselbe Logik wie in den
 * Edge Functions (supabase/functions/_shared/embedding.ts). Vor jedem
 * Embedding prüft embedForDatabase die Anbieterkennung der Datenbank
 * (Abschnitt Anbieterkennung); passt sie nicht, entsteht kein Vektor.
 *
 * Seit Issue #168 prüft die Datenbank selbst beim Schreiben und Vergleichen:
 * Schreiber geben mit embedding_model an, womit der Vektor entstand
 * (embedWithConfig, embeddingColumns), das Ranking der Fakten holt die
 * Vektoren über embedding_fact_vectors mit Anbieter und Modell des
 * Suchvektors (factVectorsFor). Eine zwischengespeicherte Freigabe allein
 * lässt also keinen Vergleich verschiedener Anbieter zu.
 *
 * Convex nutzt das nicht: dort entstehen die Vektoren in convex/embeddings.ts
 * mit OpenAI, die Suchanfrage dazu kommt weiter aus generateOpenAiEmbedding
 * (src/lib/supabase.ts).
 *
 * Gibt null zurück, wenn kein Embedding entstehen kann oder darf; Aufrufer
 * fallen dann auf Text bzw. lexikalisches Ranking zurück. Im Log stehen nur
 * feste Sätze, nie Schlüssel oder Antworten der Anbieter.
 */

import { drainQueue, ReindexStoreError, restReindexStore, type DrainOutcome } from "./embedding-reindex";
import {
  checkProviderSetup,
  embedForDatabase as embedChecked,
  embeddingConfig,
  firstReport,
  hasCredentials,
  MISSING_FUNCTION_CODES,
  REGISTRY_TIMEOUT_MS,
  restHeaders,
  type EmbeddingConfig,
  type EnvReader,
  type FetchLike,
  type ProviderCheck,
  type RegistryTarget,
} from "../../supabase/functions/_shared/embedding";

const processEnv: EnvReader = name => process.env[name];

/** Supabase-Adresse und Server-Schlüssel des Bots; null ohne Supabase */
export function registryTarget(env: EnvReader = processEnv): RegistryTarget | null {
  const url = (env("SUPABASE_URL") ?? "").trim();
  const key = (env("SUPABASE_SERVICE_ROLE_KEY") ?? "").trim();
  return url && key ? { url, key } : null;
}

/** Vektor samt Anbieter und Modell, womit er entstand */
export interface ConfiguredEmbedding {
  vector: number[];
  config: EmbeddingConfig;
}

export async function embedWithConfig(text: string, env: EnvReader = processEnv, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<ConfiguredEmbedding | null> {
  const result = await embedChecked(text, env, fetchFn, registryTarget(env));
  if (result.ok && result.config) return { vector: result.vector, config: result.config };
  if (result.ok) return null;
  // Fehlender Schlüssel ist der Normalfall ohne semantische Suche, kein Fehler
  if (result.reason !== "kein-zugang" && firstReport(result.message)) console.warn(`[embedding] Kein Embedding: ${result.message}`);
  return null;
}

export async function embedForDatabase(text: string, env: EnvReader = processEnv, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<number[] | null> {
  return (await embedWithConfig(text, env, fetchFn))?.vector ?? null;
}

/** PostgREST liefert vector-Spalten als Text „[…]“ */
export function parseVector(raw: unknown): number[] | null {
  if (Array.isArray(raw)) return raw.every(v => typeof v === "number") ? (raw as number[]) : null;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every(v => typeof v === "number") ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Vektoren der Fakten für das Ranking, geprüft in der Datenbank
 * (embedding_fact_vectors): nur ohne Umstellung, nur wenn die Datenbank genau
 * diesen Anbieter festhält, nur Fakten mit demselben embedding_model.
 * „fehlt“: der Datenbank fehlt die Migration 20260928 (dann gibt es auch
 * keine Umstellung, der Aufrufer rankt wie vor #168). null: nicht lesbar,
 * kein Ranking nach Vektoren.
 */
export async function factVectorsFor(
  config: EmbeddingConfig,
  target: RegistryTarget,
  fetchFn: FetchLike = (u, i) => fetch(u, i),
): Promise<Map<string, number[]> | "fehlt" | null> {
  let res: Response;
  try {
    res = await fetchFn(`${target.url.replace(/\/+$/, "")}/rest/v1/rpc/embedding_fact_vectors`, {
      method: "POST",
      headers: restHeaders(target.key),
      body: JSON.stringify({ p_provider: config.provider, p_model: config.model }),
      signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (res.status === 404) {
    try {
      const data = (await res.json()) as { code?: unknown } | null;
      return typeof data?.code === "string" && MISSING_FUNCTION_CODES.includes(data.code) ? "fehlt" : null;
    } catch {
      return null;
    }
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  try {
    const rows = await res.json();
    if (!Array.isArray(rows)) return null;
    const out = new Map<string, number[]>();
    for (const row of rows) {
      const v = parseVector(row?.embedding);
      if (v && row?.id !== undefined && row?.id !== null) out.set(String(row.id), v);
    }
    return out;
  } catch {
    return null;
  }
}

/** So oft zieht der Bot vorgemerkte Zeilen nach (drainEmbeddingQueue) */
export const DRAIN_INTERVAL_MS = 10 * 60_000;

/**
 * Nachzug (Issue #168): Zeilen, die die Datenbank ohne Vektor vorgemerkt hat,
 * weil ein verspäteter Schreiber für neuen oder geänderten Text einen Vektor
 * des alten Anbieters brachte, mit dieser Einstellung rechnen
 * (drainQueue). Nur mit Supabase, ohne Convex, mit Zugang zum Anbieter; die
 * Datenbank schreibt nur, wenn sie genau diese Einstellung festhält und keine
 * Umstellung läuft. Der Bot ruft das beim Start und alle DRAIN_INTERVAL_MS
 * auf. Wirft nie; null: nichts zu tun oder nicht möglich.
 */
export async function drainEmbeddingQueue(env: EnvReader = processEnv, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<DrainOutcome | null> {
  if ((env("CONVEX_URL") ?? "").trim()) return null;
  const target = registryTarget(env);
  const parsed = embeddingConfig(env);
  if (!target || !parsed.ok || !hasCredentials(parsed.config, env)) return null;
  try {
    return await drainQueue({ store: restReindexStore(target, fetchFn), config: parsed.config, env, fetch: fetchFn });
  } catch (e) {
    if (!(e instanceof ReindexStoreError)) console.warn("[embedding] Nachzug vorgemerkter Einträge gescheitert");
    return null;
  }
}

/**
 * Prüfung beim Start des Bots (nur mit Supabase, Convex bleibt außen vor):
 * passt EMBEDDING_PROVIDER/EMBEDDING_MODEL zur Kennung der Datenbank? Liefert
 * null ohne Supabase. Wirft nie.
 */
export async function checkEmbeddingAtStartup(env: EnvReader = processEnv, fetchFn: FetchLike = (u, i) => fetch(u, i)): Promise<ProviderCheck | null> {
  if ((env("CONVEX_URL") ?? "").trim()) return null;
  const target = registryTarget(env);
  if (!target) return null;
  try {
    return await checkProviderSetup(env, target, fetchFn);
  } catch {
    return { ok: false, message: "Embeddings: die Prüfung der Anbieterkennung ist fehlgeschlagen." };
  }
}
