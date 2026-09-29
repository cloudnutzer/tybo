/**
 * Ergebnis des letzten Nachweises der semantischen Suche (Issue #166), ohne
 * Werte: Zustand, Zeitpunkt, Hash der Supabase-Adresse, seit #167 auch
 * Anbieter und Modell der Embeddings, in data/semantic-search.json. „Aktiv“
 * gilt nur für genau diese Datenbank und genau diesen Anbieter samt Modell. Eigenes Modul ohne weitere Abhängigkeiten, damit
 * die Status-API der WebUI (src/web/bot-status.ts) es lesen kann, ohne den
 * Einrichtungsassistenten zu laden. Geschrieben wird es nur von
 * src/setup/semantic-search.ts und der Gesamtprüfung.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { embeddingConfig, sameConfig, type EmbeddingConfig } from "../../supabase/functions/_shared/embedding";

export type SearchState = "aktiv" | "textsuche";

export interface SearchRecord {
  state: SearchState;
  /** ISO-Zeitpunkt der Prüfung */
  checkedAt: string;
  /** sha256 der Supabase-Adresse: gilt nur für genau diese Datenbank */
  target: string;
  /** Anbieter und Modell beim Nachweis (Issue #167) */
  provider: EmbeddingConfig["provider"];
  model: string;
}

/** Nachweise vor #167 kannten nur OpenAI text-embedding-3-small */
const BEFORE_167: EmbeddingConfig = { provider: "openai", model: "text-embedding-3-small" };

export function recordPath(ctx: { root: string }): string {
  return join(ctx.root, "data", "semantic-search.json");
}

export function targetHash(url: string): string {
  return createHash("sha256").update(url.trim().replace(/\/+$/, "")).digest("hex");
}

export async function readRecord(ctx: { root: string }): Promise<SearchRecord | null> {
  try {
    const data = JSON.parse(await readFile(recordPath(ctx), "utf8"));
    if ((data?.state === "aktiv" || data?.state === "textsuche") && typeof data.checkedAt === "string" && typeof data.target === "string") {
      const parsed = embeddingConfig(name => (name === "EMBEDDING_PROVIDER" ? data.provider : name === "EMBEDDING_MODEL" ? data.model : undefined));
      const config = data.provider === undefined && data.model === undefined ? BEFORE_167 : parsed.ok ? parsed.config : null;
      if (!config) return null;
      return { state: data.state, checkedAt: data.checkedAt, target: data.target, provider: config.provider, model: config.model };
    }
  } catch {}
  return null;
}

/** Schreibt das Ergebnis; ein Fehler dabei ändert am Ergebnis des Laufs nichts */
export async function writeRecord(ctx: { root: string; now(): Date }, url: string, state: SearchState, config: EmbeddingConfig = BEFORE_167): Promise<void> {
  const record: SearchRecord = { state, checkedAt: ctx.now().toISOString(), target: targetHash(url), provider: config.provider, model: config.model };
  try {
    await mkdir(join(ctx.root, "data"), { recursive: true, mode: 0o700 });
    await writeFile(recordPath(ctx), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  } catch {}
}

/**
 * War die Suche für diese Adresse beim letzten Nachweis aktiv, mit genau
 * diesem Anbieter und Modell? config null: die Einstellung ist ungültig, dann
 * nie aktiv.
 */
export async function lastProvenActive(ctx: { root: string }, url: string | undefined, config: EmbeddingConfig | null): Promise<SearchRecord | null> {
  if (!url || !config) return null;
  const record = await readRecord(ctx);
  if (!record || record.state !== "aktiv" || record.target !== targetHash(url)) return null;
  return sameConfig(record, config) ? record : null;
}

/** Anbieter und Modell aus einer Umgebung (.env); null bei ungültiger Einstellung */
export function configFromEnv(env: Record<string, string | undefined>): EmbeddingConfig | null {
  const parsed = embeddingConfig(name => env[name]);
  return parsed.ok ? parsed.config : null;
}

/**
 * Anzeige für Status und Übersicht: „aktiv“ nur nach bestandenem Nachweis
 * für genau diese Adresse, sonst „textsuche“. null ohne Supabase (Convex
 * oder keine Datenbank), dann gilt der Schritt nicht.
 */
export async function searchDisplayState(root: string, env: Record<string, string | undefined>): Promise<SearchState | null> {
  if ((env.CONVEX_URL ?? "") !== "") return null;
  const url = (env.SUPABASE_URL ?? "").trim();
  if (!url) return null;
  return (await lastProvenActive({ root }, url, configFromEnv(env))) ? "aktiv" : "textsuche";
}
