/**
 * Embeddings für die semantische Suche (Issue #167), gemeinsam für die Edge
 * Functions und den Bot (src/lib/embedding.ts). Ohne Deno- und
 * Bun-Abhängigkeiten: Umgebung und fetch kommen als Parameter herein. Eine
 * Datei ohne relative Importe, weil Deno sie mit Endung .ts verlangt und die
 * Typprüfung des Bots sie so nicht annimmt. Unten: die Anbieterkennung der
 * Datenbank.
 *
 * Gesteuert über EMBEDDING_PROVIDER (openai | gemini | ollama, Standard
 * openai) und EMBEDDING_MODEL (optional, sonst der Standard des Anbieters).
 * Ohne beide Variablen ist die Anfrage an OpenAI Byte für Byte dieselbe wie
 * vor #167 (Adresse, Köpfe, Rumpf aus model und input).
 *
 * Die Datenbank speichert VECTOR(1536). Liefert ein Modell weniger Werte,
 * werden sie mit Nullen aufgefüllt: Skalarprodukt und Längen bleiben gleich,
 * also auch die Kosinus-Ähnlichkeit. Mehr Werte sind ein Fehler.
 *
 * Fehlermeldungen sind feste Sätze mit höchstens dem HTTP-Status. Antworten
 * der Anbieter gehen nie weiter: OpenAI etwa wiederholt in seiner
 * Fehlermeldung Teile des Schlüssels.
 */

export type EnvReader = (name: string) => string | undefined;
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const EMBEDDING_PROVIDERS = ["openai", "gemini", "ollama"] as const;
export type EmbeddingProvider = (typeof EMBEDDING_PROVIDERS)[number];

/** Breite der Spalten embedding in der Datenbank */
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * Standardmodelle:
 * - openai: text-embedding-3-small, 1536 Werte (wie vor #167)
 * - gemini: gemini-embedding-2, stabil, bis 8192 Tokens, Ausgabe über
 *   outputDimensionality wählbar (1536 empfohlen),
 *   https://ai.google.dev/gemini-api/docs/embeddings
 * - ollama: bge-m3, mehrsprachig (über 100 Sprachen, gut im Deutschen),
 *   bis 8192 Tokens, 1024 Werte, etwa 1,2 GB, https://ollama.com/library/bge-m3
 */
export const DEFAULT_EMBEDDING_MODELS: Record<EmbeddingProvider, string> = {
  openai: "text-embedding-3-small",
  gemini: "gemini-embedding-2",
  ollama: "bge-m3",
};

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
export const GEMINI_API_BASE = "https://generativelanguage.googleapis.com/v1beta";

/** Name des Schlüssels je Anbieter (Ollama braucht keinen) */
export const PROVIDER_KEY_ENV: Record<EmbeddingProvider, string | null> = {
  openai: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  ollama: null,
};

/** Erlaubte Modellnamen, etwa text-embedding-3-small, gemini-embedding-2, bge-m3:latest, jina/jina-embeddings-v2-base-de */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model: string;
}

export type ConfigResult = { ok: true; config: EmbeddingConfig } | { ok: false; message: string };

function setting(env: EnvReader, name: string): string {
  return (env(name) ?? "").trim();
}

export function isEmbeddingProvider(value: string): value is EmbeddingProvider {
  return (EMBEDDING_PROVIDERS as readonly string[]).includes(value);
}

export function modelProblem(model: string): string | null {
  return MODEL_PATTERN.test(model) ? null : "EMBEDDING_MODEL darf nur Buchstaben, Ziffern und . _ : / - enthalten (höchstens 200 Zeichen).";
}

/** Anbieter und Modell aus der Umgebung; ungültige Werte sind ein Fehler, kein stiller Rückfall */
export function embeddingConfig(env: EnvReader): ConfigResult {
  const raw = setting(env, "EMBEDDING_PROVIDER").toLowerCase();
  const provider = raw || "openai";
  if (!isEmbeddingProvider(provider)) return { ok: false, message: "EMBEDDING_PROVIDER kennt nur openai, gemini oder ollama." };
  const model = setting(env, "EMBEDDING_MODEL") || DEFAULT_EMBEDDING_MODELS[provider];
  const problem = modelProblem(model);
  if (problem) return { ok: false, message: problem };
  return { ok: true, config: { provider, model } };
}

/** Das Verhalten vor #167: OpenAI mit text-embedding-3-small */
export function isLegacyDefault(config: EmbeddingConfig): boolean {
  return config.provider === "openai" && config.model === DEFAULT_EMBEDDING_MODELS.openai;
}

export function sameConfig(a: EmbeddingConfig, b: EmbeddingConfig): boolean {
  return a.provider === b.provider && a.model === b.model;
}

/**
 * Kennzeichen eines Vektors in der Datenbank (Spalte embedding_model, Issue
 * #168): „anbieter:modell“. Schreiber geben es mit, Suchende nennen es; die
 * Datenbank prüft beides gegen das, was sie festhält.
 */
export function embeddingKey(config: EmbeddingConfig): string {
  return `${config.provider}:${config.model}`;
}

export function describeConfig(config: EmbeddingConfig): string {
  const names: Record<EmbeddingProvider, string> = { openai: "OpenAI", gemini: "Google Gemini", ollama: "Ollama" };
  return `${names[config.provider]} (${config.model})`;
}

export function ollamaProblem(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Schema");
    if (u.username || u.password || u.search || u.hash) throw new Error("Zusatz");
    return null;
  } catch {
    return "OLLAMA_URL ist keine Adresse wie http://localhost:11434.";
  }
}

/** Adresse von Ollama; ohne OLLAMA_URL der Standard auf diesem Rechner */
export function ollamaUrl(env: EnvReader): string {
  return (setting(env, "OLLAMA_URL") || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
}

/** Ist der nötige Zugang da (Schlüssel bzw. gültige Ollama-Adresse)? Ohne ihn fragt niemand an */
export function hasCredentials(config: EmbeddingConfig, env: EnvReader): boolean {
  const keyName = PROVIDER_KEY_ENV[config.provider];
  if (keyName) return setting(env, keyName) !== "";
  return ollamaProblem(ollamaUrl(env)) === null;
}

// ---------------------------------------------------------------------------
// Werte prüfen und auffüllen
// ---------------------------------------------------------------------------

export type EmbedFailure = "kein-zugang" | "nicht-erreichbar" | "abgelehnt" | "ungueltig" | "zu-viele-werte" | "gesperrt" | "konfiguration";

/**
 * config: womit der Vektor entstanden ist (nur von embedForDatabase; für den
 * Nachweis in tybo setup suche). status: HTTP-Status des Anbieters bei einer
 * Ablehnung; retryAfterMs: Wartezeit aus Retry-After bei HTTP 429 (Issue
 * #168, für die Pausen der Neuberechnung)
 */
export type EmbedResult =
  | { ok: true; vector: number[]; config?: EmbeddingConfig }
  | { ok: false; reason: EmbedFailure; message: string; status?: number; retryAfterMs?: number };

/**
 * Prüft einen Vektor und füllt ihn auf 1536 Werte auf. Ungültig: kein Feld,
 * leer, nicht-endliche Zahlen, nur Nullen (dann ist keine Ähnlichkeit
 * definiert). Mehr als 1536 Werte: Fehler mit der Zahl, ohne Kürzen, denn
 * gekürzte Vektoren wären still andere Werte.
 */
export function fitDimensions(values: unknown): EmbedResult {
  if (!Array.isArray(values) || values.length === 0) {
    return { ok: false, reason: "ungueltig", message: "Die Antwort enthält keinen Vektor." };
  }
  let nonZero = false;
  for (const v of values) {
    if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, reason: "ungueltig", message: "Der Vektor enthält Werte, die keine Zahlen sind." };
    if (v !== 0) nonZero = true;
  }
  if (!nonZero) return { ok: false, reason: "ungueltig", message: "Der Vektor besteht nur aus Nullen." };
  if (values.length > EMBEDDING_DIMENSIONS) {
    return {
      ok: false,
      reason: "zu-viele-werte",
      message: `Das Modell liefert ${values.length} Werte, die Datenbank speichert höchstens ${EMBEDDING_DIMENSIONS}. Ein anderes Modell wählen (EMBEDDING_MODEL).`,
    };
  }
  const vector = values.slice() as number[];
  while (vector.length < EMBEDDING_DIMENSIONS) vector.push(0);
  return { ok: true, vector };
}

// ---------------------------------------------------------------------------
// Anfragen
// ---------------------------------------------------------------------------

interface ProviderRequest {
  url: string;
  init: RequestInit;
  vector(data: any): unknown;
}

/**
 * Die Anfrage je Anbieter. OpenAI: bei text-embedding-3-small wie vor #167
 * nur model und input; andere text-embedding-3-Modelle bekommen dimensions,
 * damit sie 1536 Werte liefern. Gemini: Schlüssel im Kopf x-goog-api-key
 * (nie in der Adresse, die landet sonst in Logs), outputDimensionality 1536
 * (https://ai.google.dev/api/embeddings). Ollama: /api/embed
 * (https://docs.ollama.com/api/embed).
 */
export function providerRequest(text: string, config: EmbeddingConfig, env: EnvReader): ProviderRequest {
  if (config.provider === "openai") {
    const body: Record<string, unknown> = { model: config.model, input: text };
    if (config.model !== DEFAULT_EMBEDDING_MODELS.openai && config.model.startsWith("text-embedding-3")) body.dimensions = EMBEDDING_DIMENSIONS;
    return {
      url: OPENAI_EMBEDDINGS_URL,
      init: {
        method: "POST",
        headers: { Authorization: `Bearer ${setting(env, "OPENAI_API_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
      vector: data => data?.data?.[0]?.embedding,
    };
  }
  if (config.provider === "gemini") {
    return {
      url: `${GEMINI_API_BASE}/models/${encodeURIComponent(config.model)}:embedContent`,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": setting(env, "GEMINI_API_KEY") },
        body: JSON.stringify({ model: `models/${config.model}`, content: { parts: [{ text }] }, outputDimensionality: EMBEDDING_DIMENSIONS }),
      },
      vector: data => data?.embedding?.values,
    };
  }
  return {
    url: `${ollamaUrl(env)}/api/embed`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: config.model, input: text }),
    },
    vector: data => data?.embeddings?.[0],
  };
}

/**
 * Retry-After in Millisekunden: Sekunden oder ein HTTP-Datum
 * (https://www.rfc-editor.org/rfc/rfc9110#field.retry-after). Ungültig oder
 * fehlend: undefined. Höchstens eine Stunde.
 */
export function retryAfterMs(value: string | null, now: number = Date.now()): number | undefined {
  const raw = (value ?? "").trim();
  if (!raw) return undefined;
  let ms: number;
  if (/^\d+$/.test(raw)) ms = Number(raw) * 1000;
  else {
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return undefined;
    ms = at - now;
  }
  return Math.min(Math.max(ms, 0), 3_600_000);
}

function statusMessage(config: EmbeddingConfig, status: number): { reason: EmbedFailure; message: string } {
  const name = describeConfig(config);
  if (status === 401 || status === 403) return { reason: "abgelehnt", message: `${name} lehnt den Schlüssel ab (HTTP ${status}).` };
  // Google meldet einen ungültigen Schlüssel mit 400
  if (status === 400) return { reason: "abgelehnt", message: `${name} lehnt die Anfrage ab, etwa wegen eines ungültigen Schlüssels (HTTP 400).` };
  if (status === 404) return { reason: "abgelehnt", message: `${name}: Modell nicht gefunden (HTTP 404).` };
  if (status === 429) return { reason: "abgelehnt", message: `${name} nimmt gerade nichts an: Kontingent oder Guthaben aufgebraucht (HTTP 429).` };
  return { reason: "nicht-erreichbar", message: `${name} meldet einen Fehler (HTTP ${status}).` };
}

/**
 * Ein Embedding für einen Text. Wirft nie; ohne Zugang (Schlüssel bzw.
 * Ollama-Adresse) kein Aufruf. Der Text geht unverändert hinaus, gekürzt
 * wird beim Aufrufer (der Bot kürzt wie vor #167 auf 8000 Zeichen).
 */
export async function createEmbedding(text: string, config: EmbeddingConfig, env: EnvReader, fetchFn: FetchLike, signal?: AbortSignal): Promise<EmbedResult> {
  if (!hasCredentials(config, env)) {
    const keyName = PROVIDER_KEY_ENV[config.provider];
    return { ok: false, reason: "kein-zugang", message: keyName ? `${keyName} ist nicht gesetzt.` : "OLLAMA_URL ist ungültig." };
  }
  const request = providerRequest(text, config, env);
  let res: Response;
  try {
    res = await fetchFn(request.url, signal ? { ...request.init, signal } : request.init);
  } catch {
    return { ok: false, reason: "nicht-erreichbar", message: `${describeConfig(config)} ist nicht erreichbar.` };
  }
  if (!res.ok) {
    const wait = res.status === 429 ? retryAfterMs(res.headers.get("retry-after")) : undefined;
    await res.body?.cancel().catch(() => {});
    return { ok: false, ...statusMessage(config, res.status), status: res.status, ...(wait !== undefined ? { retryAfterMs: wait } : {}) };
  }
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    return { ok: false, reason: "ungueltig", message: `${describeConfig(config)} hat keine lesbare Antwort geliefert.` };
  }
  return fitDimensions(request.vector(data));
}

/** Kosinus-Ähnlichkeit (für Tests und Vergleiche; 0 bei Länge null) */
export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// ---------------------------------------------------------------------------
// Anbieterkennung der Datenbank
// ---------------------------------------------------------------------------

/**
 * Anbieter und Modell je Datenbank. Die Datenbank hält in
 * embedding_settings fest, womit ihre Vektoren entstehen
 * (db/migrations/20260927_embedding_provider.sql). Vor
 * jedem Embedding prüft embedForDatabase, ob die eigene Einstellung dazu
 * passt; sonst entsteht kein Vektor: nichts wird geschrieben, gesucht wird nur
 * nach Text. So mischt eine Datenbank nie Werte verschiedener Modelle.
 *
 * Festgehalten wird atomar in der Datenbank (claim_embedding_provider), nach
 * dem ersten gelungenen Embedding. Ohne Schlüssel fragt niemand an, auch nicht die
 * Datenbank: ohne EMBEDDING_PROVIDER und ohne Schlüssel bleibt alles wie vor
 * #167.
 *
 * Datenbanken ohne Kennung:
 * - Migration fehlt (Tabelle bzw. Funktion unbekannt): nur das Verhalten vor
 *   #167 ist erlaubt (OpenAI text-embedding-3-small), alles andere gesperrt.
 *   Nie zwischengespeichert: vor jedem Embedding wird neu gelesen und nach
 *   dem Embedding noch einmal, damit eine inzwischen eingespielte Migration mit
 *   anderem Anbieter auch die gerade laufende Anfrage sperrt.
 * - Vektoren ohne Kennung (Installationen vor #167): Zustand „altbestand“,
 *   ebenso nur das alte Verhalten. Die alten Vektoren werden nie als
 *   bestimmter Anbieter gekennzeichnet.
 * - Kennung nicht lesbar (Netz, HTTP 5xx, Rechte, unerwartete Antwort, auch
 *   beim Festhalten): alles gesperrt, auch das alte Verhalten. Ob die
 *   Datenbank schon festgelegt ist, weiß dann niemand; ein OpenAI-Vektor
 *   könnte in eine Gemini-Datenbank geraten. Nur die bestätigt fehlende
 *   Migration (PostgREST meldet die Funktion als unbekannt) ist der
 *   Altfall mit OpenAI.
 * - Keine Supabase-Adresse bzw. kein Server-Schlüssel (nur Bot): keine
 *   Datenbank, die Vektoren aufnimmt; altes Verhalten wie bisher.
 *
 * Neuberechnung nach einem Anbieterwechsel (Issue #168,
 * db/migrations/20260928_embedding_reindex.sql, src/lib/embedding-reindex.ts):
 * Zustand „umstellung“ mit dem Ziel-Anbieter. Solange sie läuft, entsteht für
 * niemanden ein Embedding, auch nicht für das Ziel: gesucht wird nur nach
 * Text, geschrieben wird ohne Vektor. Ältere Fassungen dieses Bausteins
 * kennen den Zustand nicht und halten die Kennung für nicht lesbar, sperren
 * also ebenfalls.
 *
 * Die Prüfung hier ist zwischengespeichert und darum nur eine Vorabprüfung.
 * Verbindlich prüft die Datenbank beim Schreiben (Trigger, Angabe
 * embedding_model = embeddingKey) und beim Suchen (match_messages_checked,
 * embedding_fact_vectors): ein Vektor, der mit einer veralteten Freigabe
 * entstand, wird dort verworfen bzw. mit nichts verglichen.
 */

export type StoredProvider =
  | { state: "festgehalten"; config: EmbeddingConfig }
  | { state: "altbestand" }
  /** Noch nie genutzt; vectors: es liegen schon Vektoren ohne Kennung vor */
  | { state: "leer"; vectors: boolean }
  /** Migration nicht eingespielt */
  | { state: "fehlt" }
  /** Neuberechnung auf target läuft oder ist unterbrochen (Issue #168) */
  | { state: "umstellung"; target: EmbeddingConfig };

export type Verdict = { ok: true } | { ok: false; message: string };

/** Wo die Kennung liegt: Supabase-Adresse und Server-Schlüssel */
export interface RegistryTarget {
  url: string;
  key: string;
}

const LEGACY_TEXT = "OpenAI (text-embedding-3-small) wie vor der Anbieterwahl";

/** Passt die Einstellung zur Datenbank? */
export function compareProvider(stored: StoredProvider, config: EmbeddingConfig): Verdict {
  if (stored.state === "umstellung") {
    return {
      ok: false,
      message: `Die Embeddings der Datenbank werden gerade auf ${describeConfig(stored.target)} neu berechnet. Bis das fertig ist, entsteht kein Embedding und die Suche findet nur Text. Stand und Fortsetzen: tybo suche status.`,
    };
  }
  if (stored.state === "festgehalten") {
    if (sameConfig(stored.config, config)) return { ok: true };
    return {
      ok: false,
      message: `Die Datenbank ist auf ${describeConfig(stored.config)} festgelegt, eingestellt ist ${describeConfig(config)}. Vektoren verschiedener Modelle sind nicht vergleichbar: bis das wieder passt, entsteht kein Embedding und die Suche findet nur Text. EMBEDDING_PROVIDER und EMBEDDING_MODEL wieder auf ${describeConfig(stored.config)} stellen, in der .env und bei den Edge Functions.`,
    };
  }
  if (isLegacyDefault(config)) return { ok: true };
  if (stored.state === "fehlt") {
    return {
      ok: false,
      message: `Der Datenbank fehlt die Tabelle embedding_settings (Migration 20260927_embedding_provider.sql). Ohne sie ist nur ${LEGACY_TEXT} erlaubt, ${describeConfig(config)} bleibt gesperrt. Das Schema aktualisieren (setup datenbank), dann erneut.`,
    };
  }
  if (stored.state === "altbestand" || stored.vectors) {
    return {
      ok: false,
      message: `Die Datenbank enthält Vektoren ohne Anbieterkennung (aus der Zeit vor der Anbieterwahl). Sie werden nicht umgedeutet, und neue Vektoren von ${describeConfig(config)} wären mit ihnen nicht vergleichbar. Mit dieser Datenbank bleibt nur ${LEGACY_TEXT}: EMBEDDING_PROVIDER und EMBEDDING_MODEL entfernen.`,
    };
  }
  return { ok: true };
}

/** Zeitlimit für die Anfrage an die Kennung */
export const REGISTRY_TIMEOUT_MS = 10_000;

/** Köpfe für die REST-API: neue Schlüssel (sb_…) nur in apikey, JWT-Schlüssel in beide (wie src/lib/supabase-keys.ts) */
export function restHeaders(key: string): Record<string, string> {
  if (key.startsWith("sb_")) return { apikey: key, "Content-Type": "application/json" };
  return { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };
}

type RegistryFunction = "claim_embedding_provider" | "embedding_provider_status";

/**
 * Antwort der RPC streng prüfen, je nach Funktion. Status: festgehalten,
 * altbestand oder leer mit vectors als Wahrheitswert. Festhalten: nur
 * festgehalten oder altbestand, denn danach gibt es immer eine Zeile; „leer“
 * wäre kein Festhalten. Beide: umstellung mit Ziel-Anbieter und -Modell
 * (Issue #168; das Festhalten gibt es während einer Neuberechnung nicht).
 * Alles andere: null (nicht lesbar).
 */
function parseStored(data: unknown, fn: RegistryFunction): StoredProvider | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.state === "altbestand") return { state: "altbestand" };
  if (d.state === "leer") {
    if (fn !== "embedding_provider_status" || typeof d.vectors !== "boolean") return null;
    return { state: "leer", vectors: d.vectors };
  }
  if ((d.state === "festgehalten" || d.state === "umstellung") && typeof d.provider === "string" && typeof d.model === "string") {
    if (!isEmbeddingProvider(d.provider) || modelProblem(d.model)) return null;
    const config: EmbeddingConfig = { provider: d.provider, model: d.model };
    return d.state === "festgehalten" ? { state: "festgehalten", config } : { state: "umstellung", target: config };
  }
  return null;
}

/** Fehlercodes für eine unbekannte Funktion: PostgREST (Schema-Cache) bzw. Postgres */
export const MISSING_FUNCTION_CODES = ["PGRST202", "42883"];

/**
 * Fehlercodes für eine unbekannte Spalte (PostgREST bzw. Postgres): der
 * Datenbank fehlt embedding_model (Migration 20260928 nicht eingespielt).
 * Schreiber wiederholen dann ohne die Angabe, wie vor Issue #168.
 */
export const MISSING_COLUMN_CODES = ["PGRST204", "42703"];

/** Spalten für einen Vektor samt Angabe, womit er entstand (Issue #168) */
export function embeddingColumns(vector: number[], config: EmbeddingConfig): { embedding: number[]; embedding_model: string } {
  return { embedding: vector, embedding_model: embeddingKey(config) };
}

/** Bestätigt die Antwort, dass die Funktion fehlt? Ein 404 allein (Proxy, falsche Adresse) reicht nicht */
async function confirmsMissingFunction(res: Response): Promise<boolean> {
  try {
    const data = (await res.json()) as { code?: unknown } | null;
    return typeof data?.code === "string" && MISSING_FUNCTION_CODES.includes(data.code);
  } catch {
    return false;
  }
}

/**
 * Eine der beiden Funktionen der Migration aufrufen. null: nicht lesbar
 * (Netz, HTTP 5xx, Rechte, unerwartete Antwort). „fehlt“ nur, wenn PostgREST
 * die Statusfunktion ausdrücklich nicht kennt: dann fehlt die Migration. Beim
 * Festhalten beweist eine fehlende Funktion nichts (der Status war eben noch
 * lesbar), das ist dann nicht lesbar.
 */
export async function callRegistry(
  fn: RegistryFunction,
  args: Record<string, string>,
  target: RegistryTarget,
  fetchFn: FetchLike,
  signal?: AbortSignal,
): Promise<StoredProvider | null> {
  let res: Response;
  try {
    // Eigenes Zeitlimit: eine hängende Datenbank soll keine Antwort des Bots aufhalten
    res = await fetchFn(`${target.url.replace(/\/+$/, "")}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: restHeaders(target.key),
      body: JSON.stringify(args),
      signal: signal ?? AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (res.status === 404) return fn === "embedding_provider_status" && (await confirmsMissingFunction(res)) ? { state: "fehlt" } : null;
  if (!res.ok) {
    await res.body?.cancel().catch(() => {});
    return null;
  }
  try {
    return parseStored(await res.json(), fn);
  } catch {
    return null;
  }
}

/** Nur lesen, ohne festzuhalten (Start, Prüfung, Einrichtung) */
export function readStoredProvider(target: RegistryTarget, fetchFn: FetchLike, signal?: AbortSignal): Promise<StoredProvider | null> {
  return callRegistry("embedding_provider_status", {}, target, fetchFn, signal);
}

// ---------------------------------------------------------------------------
// Prüfen vor jedem Embedding, mit kurzem Zwischenspeicher
// ---------------------------------------------------------------------------

/** Wie lange ein Ergebnis gilt; eine geänderte Kennung greift spätestens danach */
export const REGISTRY_TTL_MS = 5 * 60_000;

const verdicts = new Map<string, { verdict: Verdict; until: number }>();
const reported = new Set<string>();

/** Nur für Tests */
export function clearRegistryCache(): void {
  verdicts.clear();
  reported.clear();
}

/** Eine Sperrmeldung nur einmal je Prozess bzw. Isolate ins Log */
export function firstReport(message: string): boolean {
  if (reported.has(message)) return false;
  reported.add(message);
  return true;
}

/** Wie lange eine nicht lesbare Kennung (gesperrt) gemerkt wird: eine hängende Datenbank bremst nur jede Minute einmal */
export const UNREADABLE_TTL_MS = 60_000;

interface Precheck {
  verdict: Verdict;
  /** Noch nichts festgehalten: nach einem gelungenen Embedding festhalten */
  claim: boolean;
  /** Migration fehlte beim Lesen: vor der Freigabe des Vektors den Übergang erneut prüfen */
  recheck?: boolean;
}

/** Kennung nicht lesbar: gesperrt, auch das alte Verhalten (die Datenbank könnte auf einen anderen Anbieter festgelegt sein) */
function unreadable(config: EmbeddingConfig): { ok: false; message: string } {
  return {
    ok: false,
    message: `Die Anbieterkennung der Datenbank ist nicht lesbar (Netz, Rechte oder Serverfehler); bis sie lesbar ist, entsteht kein Embedding mit ${describeConfig(config)} und die Suche findet nur Text.`,
  };
}

/** Keine Datenbank (nur Bot ohne Supabase): nichts zu schützen, altes Verhalten wie bisher */
function withoutDatabase(config: EmbeddingConfig): Verdict {
  if (isLegacyDefault(config)) return { ok: true };
  return { ok: false, message: `Ohne Supabase-Adresse und Server-Schlüssel ist nur ${LEGACY_TEXT} erlaubt; ${describeConfig(config)} bleibt gesperrt.` };
}

/**
 * Vor dem Embedding nur lesen: passt die Einstellung zur Kennung? Ist noch
 * nichts festgehalten, darf das Embedding entstehen und wird danach
 * festgehalten (claim). So legt ein Anbieter, der nie ein Embedding geliefert
 * hat (Ollama nicht erreichbar, Modell vertippt, Kontingent leer), die
 * Datenbank nicht fest.
 */
async function precheck(config: EmbeddingConfig, target: RegistryTarget | null, fetchFn: FetchLike, now: number): Promise<Precheck> {
  const cacheKey = `${target?.url ?? ""}|${config.provider}|${config.model}`;
  const cached = verdicts.get(cacheKey);
  if (cached && cached.until > now) return { verdict: cached.verdict, claim: false };
  if (!target) return { verdict: withoutDatabase(config), claim: false };
  const stored = await readStoredProvider(target, fetchFn);
  if (!stored) {
    const verdict = unreadable(config);
    verdicts.set(cacheKey, { verdict, until: now + UNREADABLE_TTL_MS });
    return { verdict, claim: false };
  }
  const verdict = compareProvider(stored, config);
  if (stored.state === "leer") return { verdict, claim: verdict.ok };
  // Fehlende Migration ist ein Übergang: wird sie eingespielt und ein anderer
  // Anbieter festgehalten, darf keine gemerkte Erlaubnis weiter OpenAI-Vektoren liefern,
  // auch nicht die gerade laufende Anfrage (recheck)
  if (stored.state === "fehlt") return { verdict, claim: false, recheck: verdict.ok };
  // Neuberechnung: nur kurz merken, damit die Suche nach dem Umschalten bald wieder greift
  verdicts.set(cacheKey, { verdict, until: now + (stored.state === "umstellung" ? UNREADABLE_TTL_MS : REGISTRY_TTL_MS) });
  return { verdict, claim: false };
}

/**
 * Festhalten nach dem ersten gelungenen Embedding (atomar in der Datenbank);
 * das Ergebnis gilt. Scheitert das Festhalten, ist unbekannt, worauf die
 * Datenbank jetzt festgelegt ist: der Vektor wird verworfen, gesperrt wie
 * bei nicht lesbarer Kennung.
 */
async function claim(config: EmbeddingConfig, target: RegistryTarget, fetchFn: FetchLike, now: number): Promise<Verdict> {
  const cacheKey = `${target.url}|${config.provider}|${config.model}`;
  const stored = await callRegistry("claim_embedding_provider", { p_provider: config.provider, p_model: config.model }, target, fetchFn);
  if (!stored) {
    const verdict = unreadable(config);
    verdicts.set(cacheKey, { verdict, until: now + UNREADABLE_TTL_MS });
    return verdict;
  }
  const verdict = compareProvider(stored, config);
  verdicts.set(cacheKey, { verdict, until: now + (stored.state === "umstellung" ? UNREADABLE_TTL_MS : REGISTRY_TTL_MS) });
  return verdict;
}

/**
 * Nach einem Embedding, das bei fehlender Migration begonnen hat: fehlt sie
 * noch, bleibt es beim alten Verhalten. Ist sie inzwischen eingespielt, muss
 * die Kennung die Einstellung bestätigen (ist noch nichts festgehalten, wird
 * jetzt festgehalten). Nicht lesbar oder abweichend: der Vektor wird verworfen.
 */
async function confirmAfterMissing(config: EmbeddingConfig, target: RegistryTarget, fetchFn: FetchLike, now: number): Promise<Verdict> {
  const stored = await readStoredProvider(target, fetchFn);
  if (!stored) {
    const verdict = unreadable(config);
    verdicts.set(`${target.url}|${config.provider}|${config.model}`, { verdict, until: now + UNREADABLE_TTL_MS });
    return verdict;
  }
  if (stored.state === "fehlt") return compareProvider(stored, config);
  if (stored.state === "leer") return claim(config, target, fetchFn, now);
  const verdict = compareProvider(stored, config);
  verdicts.set(`${target.url}|${config.provider}|${config.model}`, { verdict, until: now + (stored.state === "umstellung" ? UNREADABLE_TTL_MS : REGISTRY_TTL_MS) });
  return verdict;
}

/**
 * Darf mit dieser Einstellung ein Embedding entstehen? Nur lesen, nichts
 * festhalten (das macht embedForDatabase nach einem gelungenen Embedding).
 * Nicht lesbar: gesperrt, für eine Minute gemerkt.
 */
export async function checkProvider(config: EmbeddingConfig, target: RegistryTarget | null, fetchFn: FetchLike, now: number = Date.now()): Promise<Verdict> {
  return (await precheck(config, target, fetchFn, now)).verdict;
}

/**
 * Das Embedding für eine Spalte dieser Datenbank bzw. eine Suche darin:
 * Einstellung lesen, ohne Zugang nichts anfragen, Kennung prüfen, beim
 * Anbieter anfragen und, wenn noch nichts festgehalten ist, danach festhalten.
 * Verliert ein paralleler erster Aufruf mit anderer Einstellung, wird sein
 * Vektor verworfen, ebenso ein Vektor, der bei fehlender Migration begonnen
 * hat, wenn die Datenbank inzwischen anders festgelegt ist.
 */
export async function embedForDatabase(text: string, env: EnvReader, fetchFn: FetchLike, target: RegistryTarget | null, now: number = Date.now()): Promise<EmbedResult> {
  const parsed = embeddingConfig(env);
  if (!parsed.ok) return { ok: false, reason: "konfiguration", message: parsed.message };
  const config = parsed.config;
  if (!hasCredentials(config, env)) return createEmbedding(text, config, env, fetchFn);
  const pre = await precheck(config, target, fetchFn, now);
  if (!pre.verdict.ok) return { ok: false, reason: "gesperrt", message: pre.verdict.message };
  const result = await createEmbedding(text, config, env, fetchFn);
  if (!result.ok) return result;
  if (!target || (!pre.claim && !pre.recheck)) return { ...result, config };
  const verdict = pre.recheck ? await confirmAfterMissing(config, target, fetchFn, now) : await claim(config, target, fetchFn, now);
  return verdict.ok ? { ...result, config } : { ok: false, reason: "gesperrt", message: verdict.message };
}

export interface ProviderCheck {
  /** false: Einstellung und Datenbank passen nicht zusammen */
  ok: boolean;
  /** Ein Satz ohne Werte */
  message: string;
  /** Die Kennung war nicht lesbar (Netz, Rechte, Serverfehler): nichts entschieden */
  unreadable?: boolean;
  /** Eine Neuberechnung läuft oder ist unterbrochen (Issue #168) */
  reindex?: EmbeddingConfig;
}

/**
 * Prüfung für Start und Gesamtprüfung: liest die Kennung, ohne festzuhalten,
 * und vergleicht sie mit der Einstellung. Unabhängig von Schlüsseln: eine
 * falsche Einstellung ist auch ohne Schlüssel falsch.
 */
export async function checkProviderSetup(env: EnvReader, target: RegistryTarget, fetchFn: FetchLike, signal?: AbortSignal): Promise<ProviderCheck> {
  const parsed = embeddingConfig(env);
  if (!parsed.ok) return { ok: false, message: `Embeddings: ${parsed.message}` };
  const config = parsed.config;
  const stored = await readStoredProvider(target, fetchFn, signal);
  if (!stored) return { ok: false, unreadable: true, message: `Embeddings: ${unreadable(config).message}` };
  const verdict = compareProvider(stored, config);
  if (stored.state === "umstellung") return { ok: false, reindex: stored.target, message: `Embeddings: ${(verdict as { message: string }).message}` };
  if (!verdict.ok) return { ok: false, message: `Embeddings: ${verdict.message}` };
  if (stored.state === "festgehalten") return { ok: true, message: `Embeddings: ${describeConfig(config)}, passt zur Datenbank.` };
  if (stored.state === "leer" && !stored.vectors) return { ok: true, message: `Embeddings: ${describeConfig(config)}; die Datenbank hält den Anbieter beim ersten Embedding fest.` };
  if (stored.state === "fehlt") return { ok: true, message: `Embeddings: ${describeConfig(config)} wie bisher; die Tabelle embedding_settings fehlt noch (Schema aktualisieren mit setup datenbank).` };
  return { ok: true, message: `Embeddings: ${describeConfig(config)} wie bisher; ältere Vektoren ohne Anbieterkennung bleiben unverändert.` };
}
