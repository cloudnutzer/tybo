/**
 * Semantische Suche einrichten (Issue #166): Verlauf nach Bedeutung
 * durchsuchen. Die Edge Functions in supabase/functions/ erzeugen beim
 * Speichern ein Embedding und finden über match_messages ähnliche
 * Nachrichten; ohne Schlüssel in ihrer Umgebung speichern sie ohne Embedding
 * und suchen nur nach Text.
 *
 * Anbieter (Issue #167, supabase/functions/_shared/embedding.ts): OpenAI
 * (Standard, text-embedding-3-small), Google Gemini (gemini-embedding-2) oder
 * Ollama auf diesem Rechner (bge-m3). Gesteuert über EMBEDDING_PROVIDER und
 * EMBEDDING_MODEL, gleich in der .env des Bots und in der Umgebung der
 * Functions. Bleibt es bei OpenAI mit Standardmodell und steht nichts davon
 * in der .env, schreibt der Assistent beides nicht (Verhalten wie vor #167).
 * Vor jeder Änderung prüft er die Anbieterkennung der Datenbank
 * (embedding_settings): ein anderer Anbieter oder ein anderes Modell als dort
 * festgehalten ist ein Wechsel. Seit Issue #168 bietet der Assistent dann an,
 * alles neu zu berechnen (Rückfrage REINDEX_FIELD mit Umfang, Dauer und
 * Kosten); ohne ausdrückliches „neu berechnen“ bricht er ab und ändert nichts.
 * Mit Zustimmung reserviert er zuerst den Lauf in der Datenbank (atomar;
 * rechnet gerade ein anderer Prozess auf ein anderes Ziel, bricht er ab, ohne
 * etwas zu ändern), richtet dann Functions und .env wie sonst ein und startet
 * `tybo suche neu-berechnen` im Hintergrund mit demselben Inhaber
 * (src/setup/search-reindex.ts); der Funktionsnachweis folgt dort nach dem
 * Umschalten. Scheitert der Schritt, gibt er die Reservierung frei.
 *
 * Wege, je nach Datenbank (setupPath aus src/setup/steps/database.ts):
 * - Supabase in der Cloud: Management-API (src/setup/supabase-management.ts)
 *   mit dem Zugangstoken sbp_… nur für diesen Lauf: die drei Functions
 *   ausliefern (verify_jwt aus, die Prüfung macht authorizeServer, #162) und
 *   die Geheimnisse setzen. Keine Supabase-CLI, damit das Token nie in die
 *   Umgebung eines Unterprozesses kommt (Entscheidung 0020). Ollama geht hier
 *   nicht: Functions in der Cloud erreichen den Rechner des Nutzers nicht.
 * - Supabase auf diesem Rechner: die Edge Runtime von supabase start liest
 *   supabase/functions/.env beim Start (nicht im Repo, Rechte 0600, andere
 *   Werte bleiben). Nach einer Änderung Supabase einmal anhalten und über
 *   runDatabaseCommand("start") neu starten, mit Netz- und Portschutz aus
 *   src/setup/local-supabase.ts. Für Ollama bekommen die Functions die aus
 *   Docker erreichbare Adresse (host.docker.internal statt localhost).
 * - Zugangsdaten selbst eingetragen (etwa ein eigener Server): der Assistent
 *   fasst dort nichts an, er prüft nur und erklärt, was zu tun ist; dort nur
 *   OpenAI (die Umgebung der Functions kennt er nicht).
 * - Convex: nicht dieser Schritt.
 *
 * Schlüssel kommen als eigene, transiente Felder (SEARCH_KEY,
 * SEARCH_GEMINI_KEY), damit writeEnv die Namen OPENAI_API_KEY bzw.
 * GEMINI_API_KEY nicht als „nur für diesen Lauf“ abweist. Gespeichert werden
 * sie nur als Supabase-Geheimnis bzw. in supabase/functions/.env und in der
 * .env (der Bot nutzt sie selbst für Embeddings von Fakten und Bildern,
 * src/lib/embedding.ts). Sicherungen dieser Dateien liegen wie jede
 * .env-Sicherung mit Rechten 0600 in data/backups; sonst nie in data/,
 * Fortschritt, Meldungen oder Logs.
 *
 * „Aktiv“ gilt nur nach einem bestandenen Funktionsnachweis (probeSearch):
 * eine Probe-Nachricht über store-telegram-message speichern, über
 * search-memory mit einer Ähnlichkeit größer 0 wiederfinden, danach löschen,
 * auch nach Fehlschlag, Zeitlimit oder Abbruch. Dazu muss
 * store-telegram-message melden, mit welchem Anbieter und Modell es den
 * Vektor gerechnet hat, und das muss die gewählte Einstellung sein.
 *
 * Steht bei den Functions noch eine frühere Wahl (EMBEDDING_PROVIDER bzw.
 * EMBEDDING_MODEL, etwa Gemini), setzt der Assistent beide auf die jetzige
 * Wahl, auch wenn sie das Verhalten vor #167 ist und die .env keins davon
 * enthält. Das Ergebnis steht ohne
 * Werte in data/semantic-search.json (Zeitpunkt, Hash der Supabase-Adresse,
 * Anbieter und Modell).
 */

import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  checkProviderSetup,
  createEmbedding,
  DEFAULT_EMBEDDING_MODELS,
  DEFAULT_OLLAMA_URL,
  describeConfig,
  EMBEDDING_DIMENSIONS,
  isEmbeddingProvider,
  isLegacyDefault,
  modelProblem,
  ollamaProblem,
  PROVIDER_KEY_ENV,
  type EmbeddingConfig,
  type EmbeddingProvider,
  type FetchLike,
  type ProviderCheck,
  readStoredProvider,
  compareProvider,
  type StoredProvider,
} from "../../supabase/functions/_shared/embedding";
import { estimateReindex, estimateText, REINDEX_RESERVE_SECONDS, ReindexStoreError, restReindexStore, STORE_TIMEOUT_MS, type ReindexEstimate } from "../lib/embedding-reindex";
import { BRAND } from "../brand";
import { readEnvFile, updateEnvValues } from "../lib/env-file";
import { supabaseHeaders } from "../lib/supabase-keys";
import { readSetupEnv, type SetupContext } from "./context";
import {
  cliEnv,
  edgeRuntimeEnabled,
  checkExposure,
  DB_CONTAINER,
  guardText,
  localDeps,
  runDatabaseCommand,
  runningContainers,
  STATUS_TIMEOUT_MS,
  supabaseCli,
} from "./local-supabase";
import { presentValue, type ApplyResult, type RunReport, type SetupValues } from "./model";
import { configFromEnv, lastProvenActive, writeRecord } from "./search-record";
import { writeEnv, writeProblem } from "./steps/common";
import { setupPath } from "./steps/database";
import { CLOUD_TOKEN, tokenProblem, TOKEN_PREFIX } from "./supabase-cloud";
import { createSupabaseManagement, refFromUrl, SupabaseManagementError, type FunctionFile } from "./supabase-management";

// ---------------------------------------------------------------------------
// Feste Werte
// ---------------------------------------------------------------------------

/** Eingabefeld des OpenAI-Schlüssels, transient (nie unter diesem Namen gespeichert) */
export const SEARCH_KEY = "SEARCH_OPENAI_KEY";
/** Name, unter dem der Schlüssel gespeichert wird (.env, Geheimnis, supabase/functions/.env) */
export const OPENAI_ENV = "OPENAI_API_KEY";
export const OPENAI_KEY_PREFIX = "sk-";
export const OPENAI_KEYS_PAGE = "https://platform.openai.com/api-keys";
export const OPENAI_EMBEDDINGS_URL = "https://api.openai.com/v1/embeddings";
export const EMBEDDING_MODEL = DEFAULT_EMBEDDING_MODELS.openai;

/** Felder und Variablen der Anbieterwahl (Issue #167) */
export const PROVIDER_ENV = "EMBEDDING_PROVIDER";
export const MODEL_ENV = "EMBEDDING_MODEL";
export const OLLAMA_URL_ENV = "OLLAMA_URL";
/** Gemini-Schlüssel, transient wie SEARCH_KEY; gespeichert als GEMINI_API_KEY */
export const SEARCH_GEMINI_KEY = "SEARCH_GEMINI_KEY";
export const GEMINI_ENV = "GEMINI_API_KEY";
export const GEMINI_KEYS_PAGE = "https://aistudio.google.com/apikey";
/** Rückfrage „Modell mit ollama pull herunterladen?“, gilt nur für diesen Lauf */
export const OLLAMA_PULL = "SEARCH_OLLAMA_PULL";
export const OLLAMA_PAGE = "https://ollama.com/download";
export const OLLAMA_TIMEOUT_MS = 10_000;
/** bge-m3 hat etwa 1,2 GB; auch langsame Leitungen sollen fertig werden */
export const OLLAMA_PULL_TIMEOUT_MS = 60 * 60_000;
/** Aus Docker (Edge Runtime der lokalen Supabase) erreichbarer Name des Rechners */
export const DOCKER_HOST = "host.docker.internal";
export const OLLAMA_DOCKER_HINT = `Bei Ollama: die Edge Runtime läuft in Docker und braucht die aus Docker erreichbare Adresse (${DOCKER_HOST}); unter Linux muss Ollama dafür auf mehr als 127.0.0.1 hören (OLLAMA_HOST=0.0.0.0).`;

/** Die Edge Functions von tybo, in dieser Reihenfolge ausgeliefert */
export const EDGE_FUNCTIONS = ["store-telegram-message", "search-memory", "embed-knowledge"] as const;
export const FUNCTIONS_DIR = join("supabase", "functions");
export const SHARED_DIR = "_shared";

/** Probe-Nachrichten: eigene Chat-ID je Lauf, nie die eines echten Gesprächs */
export const PROBE_PREFIX = "tybo-probe-";
/** Erster Aufruf einer Function kann dauern (Kaltstart) */
export const PROBE_TIMEOUT_MS = 60_000;
/** Aufräumen läuft mit eigener Frist, auch nach Abbruch */
export const CLEANUP_TIMEOUT_MS = 15_000;
/**
 * Kam auf das Speichern der Probe keine Antwort (Zeitlimit, Abbruch, Netz)
 * oder nur eine ungewisse (504 vom Gateway, siehe storeSettled),
 * kann store-telegram-message noch laufen (etwa beim Warten auf OpenAI) und
 * erst nach dem Löschen speichern. Eine Function läuft höchstens 400 Sekunden
 * (Wall-Clock-Limit der bezahlten Pläne, Free 150,
 * https://supabase.com/docs/guides/functions/limits); so lange ab dem
 * Abschicken räumt der Nachweis nach, außer die Probe wurde vorher gefunden
 * und gelöscht (sie wird höchstens einmal gespeichert).
 */
export const UNCERTAIN_WINDOW_MS = 400_000;
export const RECHECK_MS = 5_000;
export const OPENAI_TIMEOUT_MS = 20_000;

export const DOC_DEPLOY = "https://supabase.com/docs/reference/api/v1-deploy-a-function";
export const DOC_SECRETS = "https://supabase.com/docs/guides/functions/secrets";

export function keyProblem(key: string): string | null {
  return key.trim().startsWith(OPENAI_KEY_PREFIX) ? null : `Der OpenAI-Schlüssel beginnt mit ${OPENAI_KEY_PREFIX}`;
}

/** Hinweis zum Nachholen */
export function laterHint(): string {
  return `Später nachholen mit: ${BRAND.cli} setup suche.`;
}

export const TEXT_ONLY = `Ohne OpenAI-Schlüssel findet ${BRAND.name} im Verlauf nur, was wörtlich vorkommt (nur Textsuche). ${laterHint()}`;
export const TEXT_ONLY_GEMINI = `Ohne Gemini-Schlüssel findet ${BRAND.name} im Verlauf nur, was wörtlich vorkommt (nur Textsuche). ${laterHint()}`;

export function geminiKeyProblem(key: string): string | null {
  return /^\S{20,}$/.test(key.trim()) ? null : "Der Gemini-Schlüssel ist zu kurz oder enthält Leerzeichen";
}

// ---------------------------------------------------------------------------
// Ergebnis des letzten Funktionsnachweises (ohne Werte)
// ---------------------------------------------------------------------------

// Liegt in ./search-record, damit die Status-API es ohne den Assistenten liest
export { lastProvenActive, readRecord, recordPath, targetHash, writeRecord, type SearchRecord, type SearchState } from "./search-record";

// ---------------------------------------------------------------------------
// OpenAI-Schlüssel prüfen
// ---------------------------------------------------------------------------

export type KeyCheck = { ok: true } | { ok: false; message: string };

/**
 * Eine Embedding-Anfrage mit einem Wort: prüft Schlüssel, Modellzugriff und
 * Guthaben auf einmal (kostet einen Bruchteil eines Cents). Antworten von
 * OpenAI gehen nie weiter, nur feste Sätze.
 */
export async function checkOpenAiKey(key: string, ctx: SetupContext, signal: AbortSignal): Promise<KeyCheck> {
  let res: Response;
  try {
    res = await ctx.fetch(OPENAI_EMBEDDINGS_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: BRAND.name }),
      timeoutMs: OPENAI_TIMEOUT_MS,
      signal,
    });
  } catch {
    if (signal.aborted) return { ok: false, message: "Abgebrochen." };
    return { ok: false, message: "OpenAI ist nicht erreichbar. Internetverbindung prüfen und erneut versuchen." };
  }
  await res.body?.cancel().catch(() => {});
  if (res.ok) return { ok: true };
  if (res.status === 401) return { ok: false, message: `OpenAI lehnt den Schlüssel ab. Unter ${OPENAI_KEYS_PAGE} einen neuen erzeugen.` };
  if (res.status === 403) return { ok: false, message: "Der OpenAI-Schlüssel darf keine Embeddings erzeugen. Einen Schlüssel ohne Einschränkungen nehmen oder text-embedding-3-small freigeben." };
  if (res.status === 429) return { ok: false, message: "OpenAI nimmt gerade nichts an: Guthaben aufgebraucht oder zu viele Anfragen. Unter platform.openai.com Guthaben prüfen, dann erneut." };
  return { ok: false, message: `OpenAI meldet einen Fehler (HTTP ${res.status}). Später erneut versuchen.` };
}

/**
 * Gemini-Schlüssel prüfen: ein Embedding mit 1536 Werten anfordern (im
 * Rahmen des kostenlosen Kontingents gratis). Nur feste Sätze.
 */
export async function checkGeminiKey(key: string, config: EmbeddingConfig, ctx: SetupContext, signal: AbortSignal): Promise<KeyCheck> {
  const env = (name: string) => (name === GEMINI_ENV ? key : undefined);
  const result = await createEmbedding(BRAND.name, config, env, setupFetch(ctx, OPENAI_TIMEOUT_MS), signal);
  if (result.ok) return { ok: true };
  if (signal.aborted) return { ok: false, message: "Abgebrochen." };
  if (result.reason === "nicht-erreichbar" && !/HTTP/.test(result.message)) return { ok: false, message: "Google ist nicht erreichbar. Internetverbindung prüfen und erneut versuchen." };
  if (result.reason === "abgelehnt" && /HTTP 40[013]/.test(result.message)) return { ok: false, message: `Google lehnt den Gemini-Schlüssel ab. Unter ${GEMINI_KEYS_PAGE} einen neuen erzeugen.` };
  return { ok: false, message: result.message };
}

/** Adresse von Ollama für die Functions in Docker: localhost heißt dort der Container selbst */
export function dockerOllamaUrl(url: string): string {
  try {
    const u = new URL(url);
    if (["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"].includes(u.hostname)) u.hostname = DOCKER_HOST;
    return u.toString().replace(/\/+$/, "");
  } catch {
    return url;
  }
}

function ollamaHasModel(names: string[], model: string): boolean {
  const want = model.includes(":") ? model : `${model}:latest`;
  return names.some(n => n === model || n === want);
}

/**
 * Ollama prüfen: läuft es, ist das Modell da (sonst nach Rückfrage
 * herunterladen, wie „ollama pull“), liefert es höchstens 1536 Werte? Nur
 * feste Sätze; Antworten von Ollama gehen nicht weiter.
 */
export async function checkOllama(url: string, config: EmbeddingConfig, pull: boolean, ctx: SetupContext, report: (label: string) => void, signal: AbortSignal): Promise<KeyCheck & { pulled?: boolean }> {
  const base = url.replace(/\/+$/, "");
  let names: string[];
  try {
    const res = await ctx.fetch(`${base}/api/tags`, { timeoutMs: OLLAMA_TIMEOUT_MS, signal });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, message: `Ollama unter ${base} antwortet mit einem Fehler (HTTP ${res.status}).` };
    }
    const data = await jsonOrNull(res);
    names = Array.isArray(data?.models) ? data.models.map((m: any) => String(m?.name ?? m?.model ?? "")) : [];
  } catch {
    if (signal.aborted) return { ok: false, message: "Abgebrochen." };
    return { ok: false, message: `Ollama läuft nicht unter ${base}. Ollama installieren und starten (${OLLAMA_PAGE}), dann erneut.` };
  }
  let pulled = false;
  if (!ollamaHasModel(names, config.model)) {
    if (!pull) {
      return { ok: false, message: `Das Modell ${config.model} fehlt in Ollama. Im Terminal „ollama pull ${config.model}“ ausführen oder die Frage nach dem Herunterladen mit ja beantworten, dann erneut.` };
    }
    report(`Lade das Modell ${config.model} mit ollama pull (kann dauern)`);
    try {
      const res = await ctx.fetch(`${base}/api/pull`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: config.model, stream: false }),
        timeoutMs: OLLAMA_PULL_TIMEOUT_MS,
        signal,
      });
      const data = res.ok ? await jsonOrNull(res) : (await res.body?.cancel().catch(() => {}), null);
      if (!res.ok || data?.status !== "success") return { ok: false, message: `ollama pull ${config.model} ist fehlgeschlagen. Den Modellnamen prüfen oder im Terminal „ollama pull ${config.model}“ ausführen.` };
    } catch {
      if (signal.aborted) return { ok: false, message: "Abgebrochen beim Herunterladen des Modells." };
      return { ok: false, message: `ollama pull ${config.model} ist abgebrochen (Zeitlimit oder Verbindung). Im Terminal „ollama pull ${config.model}“ ausführen, dann erneut.` };
    }
    pulled = true;
  }
  const env = (name: string) => (name === OLLAMA_URL_ENV ? base : undefined);
  const result = await createEmbedding(BRAND.name, config, env, setupFetch(ctx, OPENAI_TIMEOUT_MS), signal);
  if (result.ok) return { ok: true, pulled };
  if (signal.aborted) return { ok: false, message: "Abgebrochen." };
  if (result.reason === "zu-viele-werte") return { ok: false, message: `${result.message} Etwa bge-m3 (1024 Werte) oder nomic-embed-text (768 Werte) nehmen.` };
  return { ok: false, message: `${config.model} liefert in Ollama kein Embedding: ${result.message} Ist es ein Embedding-Modell?` };
}

// ---------------------------------------------------------------------------
// Anbieterkennung der Datenbank (Issue #167)
// ---------------------------------------------------------------------------

/** fetch des Assistenten in der Form, die der gemeinsame Baustein erwartet */
export function setupFetch(ctx: SetupContext, timeoutMs = PROBE_TIMEOUT_MS): FetchLike {
  return (url, init = {}) =>
    ctx.fetch(url, {
      method: init.method,
      headers: init.headers as Record<string, string> | undefined,
      body: typeof init.body === "string" ? init.body : undefined,
      timeoutMs,
      signal: init.signal ?? undefined,
    });
}

/** Passt EMBEDDING_PROVIDER/EMBEDDING_MODEL der .env zur Kennung der Datenbank? Nur lesen */
export function checkDatabaseProvider(ctx: SetupContext, env: Record<string, string>, url: string, serviceKey: string, signal?: AbortSignal): Promise<ProviderCheck> {
  return checkProviderSetup(name => env[name], { url, key: serviceKey }, setupFetch(ctx), signal);
}

// ---------------------------------------------------------------------------
// Funktionsnachweis: Probe speichern, finden, löschen
// ---------------------------------------------------------------------------

export type ProbeState = "aktiv" | "textsuche" | "fehler" | "abgebrochen";

/** Nur für die Meldung: wie describeConfig, aber für Werte aus einer Antwort */
function usedText(provider: unknown, model: unknown): string | null {
  if (typeof provider !== "string" || typeof model !== "string") return null;
  return isEmbeddingProvider(provider) && !modelProblem(model) ? describeConfig({ provider, model }) : null;
}

export interface ProbeResult {
  state: ProbeState;
  /** Fester Satz, ohne Werte */
  message: string;
  /** Probe gelöscht (oder nie gespeichert) */
  cleaned: boolean;
}

function restUrl(url: string, filter: string): string {
  return `${url.replace(/\/+$/, "")}/rest/v1/messages?${filter}`;
}

/** Löscht Probe-Nachrichten; true, wenn Supabase das Löschen bestätigt */
async function deleteProbes(url: string, key: string, filter: string, ctx: SetupContext): Promise<boolean> {
  try {
    const res = await ctx.fetch(restUrl(url, filter), {
      method: "DELETE",
      headers: { ...supabaseHeaders(key), Prefer: "return=minimal" },
      timeoutMs: CLEANUP_TIMEOUT_MS,
    });
    await res.body?.cancel().catch(() => {});
    return res.ok;
  } catch {
    return false;
  }
}

/** Löscht die Probe; removed: Zahl der gelöschten Zeilen (0, wenn unbekannt) */
async function deleteProbe(url: string, key: string, chatId: string, ctx: SetupContext): Promise<{ ok: boolean; removed: number }> {
  try {
    const res = await ctx.fetch(restUrl(url, `chat_id=eq.${chatId}&select=chat_id`), {
      method: "DELETE",
      headers: { ...supabaseHeaders(key), Prefer: "return=representation" },
      timeoutMs: CLEANUP_TIMEOUT_MS,
    });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return { ok: false, removed: 0 };
    }
    const rows = await jsonOrNull(res);
    return { ok: true, removed: Array.isArray(rows) ? rows.length : 0 };
  } catch {
    return { ok: false, removed: 0 };
  }
}

/**
 * Beendet eine Antwort auf das Speichern die Function sicher? 2xx kommt von
 * der Function selbst (sie ist fertig), 4xx außer 408 weist die Anfrage vor
 * dem Speichern ab (fehlt, nicht angemeldet, ungültig). 5xx und 408 können vom
 * Gateway stammen, während die Function weiterläuft (etwa 504 beim Warten auf
 * OpenAI): ungewiss.
 */
export function storeSettled(status: number): boolean {
  if (status >= 200 && status < 300) return true;
  return status >= 400 && status < 500 && status !== 408;
}

/**
 * Aufräumen nach dem Nachweis. answered: die Antwort auf das Speichern beendet
 * die Function sicher (storeSettled), die Zeile existiert also schon oder nie;
 * dann genügt ein Löschen. Sonst (Zeitlimit, Abbruch, Netz, Gateway-Fehler wie
 * 504) kann die Function noch speichern: nachräumen, bis
 * die Probe gefunden und gelöscht ist oder UNCERTAIN_WINDOW_MS seit dem
 * Abschicken um sind. true: nach allem, was sich wissen lässt, ist keine
 * Probe mehr da.
 */
async function cleanupProbe(url: string, key: string, chatId: string, ctx: SetupContext, answered: boolean, sentAt: number): Promise<boolean> {
  const first = await deleteProbe(url, key, chatId, ctx);
  if (answered) return first.ok;
  if (first.ok && first.removed > 0) return true;
  const deadline = sentAt + UNCERTAIN_WINDOW_MS;
  // Höchstzahl der Runden: gilt auch, wenn die Uhr steht
  for (let round = Math.ceil(UNCERTAIN_WINDOW_MS / RECHECK_MS); round > 0 && ctx.now().getTime() < deadline; round--) {
    await ctx.sleep(RECHECK_MS);
    const next = await deleteProbe(url, key, chatId, ctx);
    if (next.ok && next.removed > 0) return true;
  }
  // Nach dem Fenster speichert die Function nicht mehr: ein letztes Löschen entscheidet
  return (await deleteProbe(url, key, chatId, ctx)).ok;
}

/** Laufende Nachweise samt Aufräumen (nach laufender Nummer), damit ein Abbruch sie nie abschneidet */
const probes = new Map<number, Promise<ProbeResult>>();
let nextProbe = 0;
/** Ausgang des Aufräumens beendeter Nachweise (die letzten), für die Abbruchmeldung */
const finishedProbes: Array<{ seq: number; cleaned: boolean }> = [];
const KEEP_FINISHED = 50;

/** Läuft gerade ein Nachweis (etwa in der Gesamtprüfung)? */
export function probeRunning(): boolean {
  return probes.size > 0;
}

/**
 * Merker für waitForProbes: der älteste laufende Nachweis bzw. der nächste,
 * der startet. Beim Abbruch zählen nur Nachweise ab hier, frühere haben ihr
 * Ergebnis schon selbst gemeldet.
 */
export function probeMark(): number {
  return probes.size ? Math.min(...probes.keys()) : nextProbe;
}

/**
 * Wartet, bis alle angefangenen Nachweise samt Aufräumen fertig sind.
 * uncleaned: Nachweise ab mark, deren Probe sich nicht löschen ließ (ihre
 * Meldung erreicht nach einem Abbruch sonst niemanden).
 */
export async function waitForProbes(mark = probeMark()): Promise<{ uncleaned: number }> {
  while (probes.size) await Promise.allSettled([...probes.values()]);
  return { uncleaned: finishedProbes.filter(f => f.seq >= mark && !f.cleaned).length };
}

/** Warnung nach einem Abbruch, wenn eine Probe stehen geblieben ist; sonst null */
export function probeCleanupWarning(uncleaned: number): string | null {
  if (!uncleaned) return null;
  return `Achtung: Die Probe der semantischen Suche ließ sich nicht löschen und steht noch in der Tabelle messages. ${cleanupHint()}`;
}

/** Übrig gebliebene Proben früherer Läufe (etwa nach Absturz) */
export function leftoverFilter(): string {
  return `chat_id=like.${PROBE_PREFIX}*`;
}

export function cleanupHint(): string {
  return `Übrig gebliebene Proben löscht der nächste Lauf von ${BRAND.cli} setup suche selbst; von Hand: im SQL-Editor von Supabase delete from messages where chat_id like '${PROBE_PREFIX}%';`;
}

function functionProblem(name: string, status: number): string {
  if (status === 404) return `Die Edge Function ${name} fehlt (nicht ausgeliefert oder die Edge Runtime läuft nicht).`;
  if (status === 401) return `Die Edge Function ${name} lehnt den Supabase-Schlüssel aus der .env ab.`;
  if (status === 503) return `Die Edge Function ${name} hat keinen Supabase-Schlüssel in ihrer Umgebung.`;
  return `Die Edge Function ${name} antwortet mit einem Fehler (HTTP ${status}).`;
}

async function postFunction(url: string, key: string, name: string, body: unknown, ctx: SetupContext, signal: AbortSignal): Promise<Response> {
  return ctx.fetch(`${url.replace(/\/+$/, "")}/functions/v1/${name}`, {
    method: "POST",
    headers: { ...supabaseHeaders(key), "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: PROBE_TIMEOUT_MS,
    signal,
  });
}

async function jsonOrNull(res: Response): Promise<any> {
  try {
    return JSON.parse(await res.text());
  } catch {
    return null;
  }
}

/**
 * Der Nachweis: HTTP-Status UND Inhalt zählen. store-telegram-message kann
 * 200 mit ok:false liefern und gibt keine Zeilen-ID zurück; die Probe hat
 * darum eine eigene Chat-ID und eine eindeutige Kennung im Text. Aktiv nur,
 * wenn search-memory genau diese Probe mit numerischer similarity > 0
 * liefert (die Textsuche liefert Zeilen ohne similarity) und
 * store-telegram-message expected als Anbieter und Modell des Vektors meldet.
 * Rechnen die Functions mit etwas anderem (zurückgebliebene Einstellung) oder
 * melden sie es nicht (ältere Version), ist das ein Fehler, nicht aktiv.
 */
export function probeSearch(url: string, key: string, ctx: SetupContext, signal: AbortSignal, expected: EmbeddingConfig): Promise<ProbeResult> {
  // Angemeldet, damit ein Abbruch (Strg+C) auf das Aufräumen wartet (waitForProbes)
  const seq = nextProbe++;
  const p = probeInner(url, key, ctx, signal, expected);
  probes.set(seq, p);
  const done = (cleaned: boolean) => {
    finishedProbes.push({ seq, cleaned });
    if (finishedProbes.length > KEEP_FINISHED) finishedProbes.shift();
    probes.delete(seq);
  };
  // Unerwarteter Fehler: nicht bekannt, ob die Probe weg ist, also als stehen geblieben zählen
  p.then(r => done(r.cleaned), () => done(false));
  return p;
}

async function probeInner(url: string, key: string, ctx: SetupContext, signal: AbortSignal, expected: EmbeddingConfig): Promise<ProbeResult> {
  // Reste früherer Läufe zuerst, ohne Einfluss aufs Ergebnis
  await deleteProbes(url, key, leftoverFilter(), ctx);
  const marker = randomUUID();
  const chatId = `${PROBE_PREFIX}${marker}`;
  const content = `Probe der semantischen Suche von ${BRAND.name} (${marker}): Der Leuchtturm steht am Hafen und leuchtet nachts.`;
  let stored = false;
  /** Die Antwort auf das Speichern beendet die Function sicher: danach speichert sie nichts mehr */
  let answered = false;
  let sentAt = 0;
  let outcome: Omit<ProbeResult, "cleaned">;
  try {
    outcome = await (async (): Promise<Omit<ProbeResult, "cleaned">> => {
      if (signal.aborted) return { state: "abgebrochen", message: "Abgebrochen." };
      // Ab dem Abschicken kann eine Zeile existieren, auch wenn die Antwort nie ankommt
      stored = true;
      sentAt = ctx.now().getTime();
      const save = await postFunction(url, key, "store-telegram-message", { chat_id: chatId, role: "user", content, metadata: { setup_probe: true } }, ctx, signal);
      // Nicht jede Antwort beendet die Function (504 vom Gateway etwa nicht)
      answered = storeSettled(save.status);
      if (!save.ok) {
        await save.body?.cancel().catch(() => {});
        return { state: "fehler", message: functionProblem("store-telegram-message", save.status) };
      }
      const saved = await jsonOrNull(save);
      if (saved?.ok !== true) return { state: "fehler", message: "store-telegram-message hat die Probe nicht gespeichert (Antwort ohne ok)." };

      const search = await postFunction(url, key, "search-memory", { chat_id: chatId, query: content, limit: 5 }, ctx, signal);
      if (!search.ok) {
        await search.body?.cancel().catch(() => {});
        return { state: "fehler", message: functionProblem("search-memory", search.status) };
      }
      const rows = await jsonOrNull(search);
      if (!Array.isArray(rows)) return { state: "fehler", message: "search-memory hat keine Trefferliste geliefert." };
      const hit = rows.find(r => r && typeof r === "object" && r.chat_id === chatId && r.content === content);
      if (!hit) return { state: "fehler", message: "search-memory hat die Probe nicht wiedergefunden." };
      if (typeof hit.similarity === "number" && Number.isFinite(hit.similarity) && hit.similarity > 0) {
        // Womit die Functions wirklich rechnen: erst das bestätigt die Wahl
        const used = usedText(saved?.embedding_provider, saved?.embedding_model);
        if (!used) {
          return { state: "fehler", message: "store-telegram-message meldet nicht, mit welchem Anbieter und Modell es das Embedding gerechnet hat (ältere Version der Functions). Die Functions neu ausliefern bzw. Supabase neu starten, dann erneut." };
        }
        if (saved.embedding_provider !== expected.provider || saved.embedding_model !== expected.model) {
          return {
            state: "fehler",
            message: `Die Functions rechnen die Embeddings mit ${used}, gewählt ist ${describeConfig(expected)}. EMBEDDING_PROVIDER und EMBEDDING_MODEL der Functions stimmen nicht mit der .env überein; ${BRAND.cli} setup suche gleicht sie an.`,
          };
        }
        return { state: "aktiv", message: "Probe gespeichert, nach Bedeutung wiedergefunden und gelöscht." };
      }
      return { state: "textsuche", message: textOnlyReason(saved?.embedding_status) };
    })();
  } catch {
    outcome = signal.aborted
      ? { state: "abgebrochen", message: "Abgebrochen." }
      : { state: "fehler", message: "Supabase antwortet nicht (Zeitlimit oder keine Verbindung)." };
  }
  // Aufräumen auch nach Fehler, Zeitlimit und Abbruch, mit eigener Frist
  const cleaned = stored ? await cleanupProbe(url, key, chatId, ctx, answered, sentAt) : true;
  return { ...outcome, cleaned };
}

/**
 * Warum die Probe ohne Embedding gespeichert wurde: store-telegram-message
 * meldet seit #167 einen festen Kurzgrund (embedding_status); ältere
 * Functions melden keinen.
 */
export function textOnlyReason(status: unknown): string {
  const base = "Die Probe wurde nur per Textsuche gefunden, ohne Embedding:";
  switch (status) {
    case "kein-zugang":
      return `${base} den Functions fehlt der Schlüssel des Anbieters (bzw. eine gültige OLLAMA_URL).`;
    case "abgelehnt":
      return `${base} der Anbieter lehnt den Schlüssel der Functions ab, oder das Modell fehlt dort.`;
    case "nicht-erreichbar":
      return `${base} die Functions erreichen den Anbieter nicht. ${OLLAMA_DOCKER_HINT}`;
    case "gesperrt":
      return `${base} der Anbieter der Functions passt nicht zur Anbieterkennung der Datenbank (embedding_settings).`;
    case "zu-viele-werte":
    case "ungueltig":
      return `${base} das Modell liefert keine brauchbaren Vektoren (höchstens ${EMBEDDING_DIMENSIONS} Werte).`;
    case "konfiguration":
      return `${base} EMBEDDING_PROVIDER oder EMBEDDING_MODEL der Functions ist ungültig.`;
    default:
      return `${base} den Functions fehlt der OpenAI-Schlüssel, oder OpenAI lehnt ihn ab.`;
  }
}

/** Meldung zum Nachweis samt Aufräumen */
export function probeText(p: ProbeResult): string {
  const cleanup = p.cleaned ? "" : ` Die Probe ließ sich nicht löschen. ${cleanupHint()}`;
  return `${p.message}${cleanup}`;
}

// ---------------------------------------------------------------------------
// Dateien der Functions
// ---------------------------------------------------------------------------

async function tsFiles(root: string, dir: string): Promise<FunctionFile[]> {
  const names = (await readdir(join(root, FUNCTIONS_DIR, dir))).filter(n => n.endsWith(".ts") && !n.endsWith(".test.ts")).sort();
  const out: FunctionFile[] = [];
  for (const n of names) {
    out.push({ path: `supabase/functions/${dir}/${n}`, content: await readFile(join(root, FUNCTIONS_DIR, dir, n), "utf8") });
  }
  return out;
}

/** Dateien einer Function samt _shared, Pfade wie im Projekt (relative Importe bleiben gültig) */
export async function functionFiles(root: string, slug: string): Promise<{ entrypoint: string; files: FunctionFile[] }> {
  const own = await tsFiles(root, slug);
  const shared = await tsFiles(root, SHARED_DIR);
  return { entrypoint: `supabase/functions/${slug}/index.ts`, files: [...own, ...shared] };
}

// ---------------------------------------------------------------------------
// Anbieterwahl (Issue #167)
// ---------------------------------------------------------------------------

export interface SearchChoice {
  config: EmbeddingConfig;
  /**
   * EMBEDDING_PROVIDER und EMBEDDING_MODEL ausdrücklich setzen: die Wahl
   * weicht vom Verhalten vor #167 ab, oder eins davon steht schon in der .env
   */
  explicit: boolean;
  /** OPENAI_API_KEY bzw. GEMINI_API_KEY; null bei Ollama */
  keyName: string | null;
  /** Eingegebener oder vorhandener Schlüssel, "" ohne */
  key: string;
  /** Der Schlüssel wurde in diesem Lauf eingegeben */
  entered: boolean;
  /** Ollama-Adresse aus Sicht des Bots (nur bei Ollama von Bedeutung) */
  ollamaUrl: string;
  /** Rückfrage „mit ollama pull herunterladen?“ mit ja beantwortet */
  pull: boolean;
  /** Antwort auf die Rückfrage beim Anbieterwechsel (REINDEX_FIELD, Issue #168) */
  reindex?: string;
}

export type ChoiceResult = { ok: true; choice: SearchChoice } | { ok: false; message: string };

/**
 * Anbieter, Modell, Schlüssel und Ollama-Adresse aus Eingaben und .env.
 * Wechselt der Anbieter, gilt ein EMBEDDING_MODEL aus der .env nicht mehr
 * (es gehört zum alten Anbieter), sondern der Standard des neuen.
 */
export function resolveChoice(values: SetupValues, env: Record<string, string>): ChoiceResult {
  const envProvider = (presentValue(env, PROVIDER_ENV) ?? "").toLowerCase();
  const provider = (values[PROVIDER_ENV]?.trim() || envProvider || "openai").toLowerCase();
  if (!isEmbeddingProvider(provider)) return { ok: false, message: "EMBEDDING_PROVIDER kennt nur openai, gemini oder ollama. Nichts wurde geändert." };
  const envModel = presentValue(env, MODEL_ENV);
  const sameProvider = provider === (envProvider || "openai");
  const model = values[MODEL_ENV]?.trim() || (sameProvider ? envModel : undefined) || DEFAULT_EMBEDDING_MODELS[provider];
  const badModel = modelProblem(model);
  if (badModel) return { ok: false, message: `${badModel} Nichts wurde geändert.` };
  const config: EmbeddingConfig = { provider, model };
  const keyName = PROVIDER_KEY_ENV[provider];
  const entered = keyName ? (values[provider === "gemini" ? SEARCH_GEMINI_KEY : SEARCH_KEY]?.trim() ?? "") : "";
  if (entered) {
    const problem = provider === "gemini" ? geminiKeyProblem(entered) : keyProblem(entered);
    if (problem) return { ok: false, message: `${problem}. Nichts wurde geändert.` };
  }
  const ollamaUrl = (values[OLLAMA_URL_ENV]?.trim() || presentValue(env, OLLAMA_URL_ENV) || DEFAULT_OLLAMA_URL).replace(/\/+$/, "");
  if (provider === "ollama") {
    const problem = ollamaProblem(ollamaUrl);
    if (problem) return { ok: false, message: `${problem} Nichts wurde geändert.` };
  }
  return {
    ok: true,
    choice: {
      config,
      explicit: !isLegacyDefault(config) || !!envProvider || !!envModel,
      keyName,
      key: keyName ? entered || presentValue(env, keyName) || "" : "",
      entered: !!entered,
      ollamaUrl,
      pull: values[OLLAMA_PULL] === "true",
      reindex: values[REINDEX_FIELD]?.trim() || undefined,
    },
  };
}

/** Was in die .env des Bots gehört, nur Abweichungen */
export function botChanges(choice: SearchChoice, env: Record<string, string>): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const put = (name: string, value: string) => {
    if (env[name] !== value) out.push([name, value]);
  };
  if (choice.explicit) {
    put(PROVIDER_ENV, choice.config.provider);
    put(MODEL_ENV, choice.config.model);
  }
  if (choice.keyName && choice.key) put(choice.keyName, choice.key);
  if (choice.config.provider === "ollama" && (presentValue(env, OLLAMA_URL_ENV) || choice.ollamaUrl !== DEFAULT_OLLAMA_URL)) put(OLLAMA_URL_ENV, choice.ollamaUrl);
  return out;
}

/**
 * Was die Functions brauchen (Geheimnisse bzw. supabase/functions/.env).
 * runtimeHasSelection: dort steht schon EMBEDDING_PROVIDER oder
 * EMBEDDING_MODEL (etwa von einem früheren Lauf mit Gemini); dann werden beide
 * auf die jetzige Wahl gesetzt, auch beim Verhalten vor #167.
 */
export function runtimeValues(choice: SearchChoice, runtimeHasSelection = false): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  if (choice.explicit || runtimeHasSelection) out.push([PROVIDER_ENV, choice.config.provider], [MODEL_ENV, choice.config.model]);
  if (choice.keyName && choice.key) out.push([choice.keyName, choice.key]);
  if (choice.config.provider === "ollama") out.push([OLLAMA_URL_ENV, dockerOllamaUrl(choice.ollamaUrl)]);
  return out;
}

const OLLAMA_CLOUD = `Ollama läuft auf diesem Rechner; die Edge Functions in der Supabase-Cloud erreichen es nicht (weder über localhost noch über ${DOCKER_HOST}). Für Ollama Supabase auf diesem Rechner nutzen (${BRAND.cli} setup datenbank), sonst OpenAI oder Gemini wählen. Nichts wurde geändert.`;

function selfHostedOnlyOpenAi(config: EmbeddingConfig): string {
  return `Bei selbst eingetragenem Supabase richtet ${BRAND.name} nur OpenAI mit ${EMBEDDING_MODEL} ein, denn die Umgebung der Functions dort kennt der Assistent nicht. Für ${describeConfig(config)} dort selbst EMBEDDING_PROVIDER, EMBEDDING_MODEL und den Schlüssel bzw. OLLAMA_URL als Geheimnisse der Functions setzen (${DOC_SECRETS}), dieselben Werte in die .env schreiben, dann ${BRAND.cli} setup suche. Nichts wurde geändert.`;
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export function searchPlan(values: SetupValues): string[] {
  const path = values.DB_BACKEND;
  if (path === "convex") return ["Nichts: mit Convex läuft die semantische Suche über Convex selbst, dieser Schritt gilt nur für Supabase."];
  if (!path) return ["Nichts: erst die Datenbank einrichten (Schritt Datenbank)."];
  const provider = (values[PROVIDER_ENV] ?? "openai").toLowerCase();
  if (provider === "ollama" && path === "supabase-cloud") return [OLLAMA_CLOUD];
  const out: string[] = [];
  if (provider === "gemini") out.push("Den Gemini-Schlüssel mit einer Probe-Anfrage prüfen (im kostenlosen Kontingent enthalten).");
  else if (provider === "ollama") out.push("Prüfen, ob Ollama läuft und das Modell da ist; fehlt es, lädt der Assistent es nur nach deiner Zustimmung herunter (ollama pull).");
  else out.push("Den OpenAI-Schlüssel mit einer Probe-Anfrage prüfen (kostet einen Bruchteil eines Cents).");
  out.push("Die Anbieterkennung der Datenbank prüfen: hält sie schon einen anderen Anbieter oder ein anderes Modell fest, ist das ein Wechsel. Dann nur mit deiner Zustimmung („Alles neu berechnen“): Einrichtung wie unten, danach rechnet tybo im Hintergrund alle Einträge neu (bis dahin nur Textsuche). Ohne Zustimmung bricht der Assistent ab und ändert nichts.");
  if (path === "supabase-cloud") {
    out.push(
      "Das Projekt aus SUPABASE_URL der .env bei Supabase finden (das Zugangstoken gilt nur für diesen Lauf und wird nirgends gespeichert).",
      `Die Edge Functions ${EDGE_FUNCTIONS.join(", ")} ausliefern.`,
      provider === "openai" ? "Den Schlüssel als Supabase-Geheimnis OPENAI_API_KEY setzen." : "Schlüssel, EMBEDDING_PROVIDER und EMBEDDING_MODEL als Supabase-Geheimnisse setzen.",
    );
  } else if (path === "supabase-lokal") {
    out.push(
      provider === "ollama"
        ? `EMBEDDING_PROVIDER, EMBEDDING_MODEL und die aus Docker erreichbare Ollama-Adresse (${DOCKER_HOST}) in supabase/functions/.env eintragen (nur auf diesem Rechner, nicht im Repo, andere Einträge bleiben).`
        : "Den Schlüssel in supabase/functions/.env eintragen (nur auf diesem Rechner, nicht im Repo, andere Einträge bleiben).",
      "Supabase kurz anhalten und neu starten, damit die Edge Runtime die Werte liest (die Daten bleiben, nur auf diesem Rechner erreichbar).",
    );
  } else {
    out.push("An einem selbst eingetragenen Supabase ändert der Assistent nichts: Functions und Geheimnis richtest du dort selbst ein, er prüft nur (dort nur OpenAI).");
  }
  if (provider === "ollama") out.push("Die Texte für die Suche verlassen dafür den Rechner nicht: Ollama rechnet die Embeddings hier.");
  out.push(
    provider === "openai" ? "OPENAI_API_KEY in die .env schreiben (der Bot braucht ihn selbst für Fakten und Bilder)." : "Anbieter, Modell und Schlüssel bzw. Ollama-Adresse in die .env schreiben (der Bot braucht sie selbst für Fakten und Bilder).",
    "Test: eine Probe-Nachricht speichern, nach Bedeutung wiederfinden und wieder löschen.",
    provider === "ollama" ? "Ohne laufendes Ollama und ohne das Modell ändert der Schritt nichts, dann gibt es nur die Textsuche." : "Ohne Schlüssel ändert der Schritt nichts, dann gibt es nur die Textsuche.",
    "Ohne Wechsel bekommt alter Verlauf keine Embeddings nachträglich, nur neue Nachrichten.",
  );
  return out;
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

function fail(message: string, changed: string[] = []): ApplyResult {
  return { ok: false, message, changed };
}

function keyLabel(choice: SearchChoice): string {
  return choice.config.provider === "gemini" ? "Gemini-Schlüssel" : "OpenAI-Schlüssel";
}

/** Kein Schlüssel: nichts ändern; eine nachweislich funktionierende Einrichtung bleibt aktiv */
async function withoutKey(ctx: SetupContext, url: string, choice: SearchChoice): Promise<ApplyResult> {
  const active = await lastProvenActive(ctx, url, choice.config);
  if (active) return { ok: true, message: `Kein ${keyLabel(choice)} eingegeben, nichts geändert. Die semantische Suche war bei der letzten Prüfung aktiv und bleibt es.`, changed: [] };
  return { ok: true, message: choice.config.provider === "gemini" ? TEXT_ONLY_GEMINI : TEXT_ONLY, changed: [] };
}

/** Schreibt Anbieter, Modell, Schlüssel und Ollama-Adresse in die .env, wenn sie abweichen */
async function saveBotEnv(ctx: SetupContext, env: Record<string, string>, choice: SearchChoice, changed: string[]): Promise<ApplyResult | null> {
  const changes = botChanges(choice, env);
  if (!changes.length) return null;
  const written = await writeEnv(ctx, changes, changed);
  if (!written.ok) return fail(written.message, changed);
  for (const c of written.changed) if (!changed.includes(c)) changed.push(c);
  return null;
}

/** Nachweis, Ergebnis merken, Meldung */
async function finish(ctx: SetupContext, url: string, serviceKey: string, config: EmbeddingConfig, done: string, changed: string[], signal: AbortSignal, notActive: string): Promise<ApplyResult> {
  const probe = await probeSearch(url, serviceKey, ctx, signal, config);
  if (probe.state === "aktiv" || probe.state === "textsuche") await writeRecord(ctx, url, probe.state, config);
  if (probe.state === "aktiv") {
    return { ok: probe.cleaned, message: `${done} Semantische Suche: aktiv (${describeConfig(config)}). ${probeText(probe)}`, changed };
  }
  if (probe.state === "abgebrochen") return fail(`${done} Abgebrochen vor dem Ende des Tests. ${probeText(probe)} ${laterHint()}`, changed);
  return fail(`${done} Der Test ist fehlgeschlagen: ${probeText(probe)} ${notActive}`, changed);
}

/**
 * Der Ablauf. values: Eingaben (Anbieter, Schlüssel, bei der Cloud das
 * Zugangstoken); der Weg kommt aus der .env (setupPath). Schreibt selbst und
 * testet am Ende selbst.
 */
export async function runSemanticSearch(values: SetupValues, ctx: SetupContext, report: RunReport, signal: AbortSignal): Promise<ApplyResult> {
  let env: Record<string, string>;
  try {
    env = await readSetupEnv(ctx);
  } catch {
    return fail("Die .env ließ sich nicht lesen. Nichts wurde geändert.");
  }
  // Weg aus der .env, nie aus den Eingaben: dieser Schritt wählt keine Datenbank
  const path = setupPath(env);
  if (path === "convex") return fail("Mit Convex läuft die semantische Suche über Convex selbst (npx convex env set OPENAI_API_KEY …, siehe CLAUDE.md, Phase 2.5). Dieser Schritt gilt nur für Supabase.");
  const url = presentValue(env, "SUPABASE_URL");
  const serviceKey = presentValue(env, "SUPABASE_SERVICE_ROLE_KEY");
  if (!path || !url) return fail(`Erst die Datenbank einrichten (${BRAND.cli} setup datenbank), dann diesen Schritt.`);
  if (!serviceKey) return fail(`In der .env fehlt SUPABASE_SERVICE_ROLE_KEY. Erst ${BRAND.cli} setup datenbank, dann diesen Schritt.`);

  const resolved = resolveChoice(values, env);
  if (!resolved.ok) return fail(resolved.message);
  const choice = resolved.choice;

  if (path === "supabase-cloud" || path === "supabase-lokal") {
    // Ein reservierter Lauf (Wechsel mit Neuberechnung) wird freigegeben, wenn der Schritt scheitert
    const slot: ReservationSlot = {};
    const result = path === "supabase-cloud" ? await runCloud(values, ctx, env, url, serviceKey, choice, report, signal, slot) : await runLocal(ctx, env, url, serviceKey, choice, report, signal, slot);
    if (!result.ok && slot.reservation) await slot.reservation.release();
    return result;
  }
  return runSelfHosted(ctx, env, url, serviceKey, choice, report, signal);
}

/** Zugang prüfen: Schlüssel bzw. Ollama samt Modell */
async function checkKeyStep(choice: SearchChoice, ctx: SetupContext, report: RunReport, at: number, total: number, signal: AbortSignal): Promise<ApplyResult | null> {
  const { provider } = choice.config;
  report({ at, total, label: provider === "ollama" ? "Prüfe Ollama und das Modell" : `Prüfe den ${keyLabel(choice)}` });
  const check =
    provider === "gemini"
      ? await checkGeminiKey(choice.key, choice.config, ctx, signal)
      : provider === "ollama"
        ? await checkOllama(choice.ollamaUrl, choice.config, choice.pull, ctx, label => report({ at, total, label }), signal)
        : await checkOpenAiKey(choice.key, ctx, signal);
  if (signal.aborted) return fail("Abgebrochen. Nichts wurde geändert.");
  return check.ok ? null : fail(`${check.message} Nichts wurde geändert.`);
}

/**
 * Ein reservierter Lauf (Issue #168): embedding_reindex_start hat das Ziel
 * atomar festgehalten, bevor der Assistent Functions, Geheimnisse oder .env
 * ändert. holder: hält den Lauf bis zur Übergabe an die Neuberechnung im
 * Hintergrund (gleicher Inhaber); null: ein anderer Prozess rechnet schon auf
 * dasselbe Ziel.
 */
export interface Reservation {
  estimate: ReindexEstimate | null;
  holder: string | null;
  /** Freigeben (Schritt gescheitert oder nicht im Hintergrund gestartet), wirft nie */
  release(): Promise<void>;
}

export interface ReservationSlot {
  reservation?: Reservation;
}

/**
 * Anbieterkennung der Datenbank vor jeder Änderung. Passt die Wahl: weiter.
 * Ein Wechsel (anderer Anbieter oder anderes Modell, Altbestand, laufende
 * Umstellung) geht nur mit der Antwort „neu-berechnen“ weiter: dann Schätzung
 * und Reservierung des Laufs in der Datenbank, atomar vor jeder Änderung.
 * Rechnet gerade ein anderer Prozess auf ein anderes Ziel, lautet die Antwort
 * „belegt“ und nichts ändert sich. Ohne Zustimmung Abbruch, ohne etwas zu
 * ändern. answer null: ohne Angebot (selbst eingetragenes Supabase).
 */
async function providerGate(
  ctx: SetupContext,
  url: string,
  serviceKey: string,
  choice: SearchChoice,
  signal: AbortSignal,
  answer?: string | null,
): Promise<{ fail: ApplyResult } | { reindex: Reservation } | null> {
  const wanted: Record<string, string> = { [PROVIDER_ENV]: choice.config.provider, [MODEL_ENV]: choice.config.model };
  const check = await checkProviderSetup(name => wanted[name], { url, key: serviceKey }, setupFetch(ctx), signal);
  if (signal.aborted) return { fail: fail("Abgebrochen. Nichts wurde geändert.") };
  if (check.ok) return null;
  if (check.unreadable) return { fail: fail(`${check.message} Nichts wurde geändert.`) };
  const stored = await readStoredProvider({ url, key: serviceKey }, setupFetch(ctx), signal);
  if (signal.aborted) return { fail: fail("Abgebrochen. Nichts wurde geändert.") };
  const decision = switchDecision(stored, choice.config);
  if (answer === null || (decision.kind !== "wechsel" && decision.kind !== "fortsetzen" && decision.kind !== "anderes-ziel")) return { fail: fail(`${check.message} Nichts wurde geändert.`) };
  if (answer !== REINDEX_YES) {
    const why = answer === REINDEX_NO ? "Abgebrochen, wie gewählt." : `Neu berechnen geht nur mit Zustimmung: ${BRAND.cli} setup suche erneut und bei „${REINDEX_LABEL}“ „Alles neu berechnen“ wählen.`;
    return { fail: fail(`${check.message} ${why} Nichts wurde geändert.`) };
  }
  const store = restReindexStore({ url, key: serviceKey }, setupFetch(ctx, STORE_TIMEOUT_MS));
  let estimate: ReindexEstimate;
  try {
    estimate = estimateReindex(await store.estimate(), choice.config);
  } catch (e) {
    const text = e instanceof ReindexStoreError ? e.message : "Der Umfang ließ sich nicht lesen.";
    return { fail: fail(`${text} Nichts wurde geändert.`) };
  }
  if (signal.aborted) return { fail: fail("Abgebrochen. Nichts wurde geändert.") };
  const holder = `setup:${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  let started: Awaited<ReturnType<typeof store.start>>;
  try {
    started = await store.start(choice.config, holder, REINDEX_RESERVE_SECONDS);
  } catch (e) {
    const text = e instanceof ReindexStoreError ? e.message : "Die Datenbank hat nicht geantwortet.";
    return { fail: fail(`Die Neuberechnung ließ sich nicht beginnen: ${text} Nichts wurde geändert.`) };
  }
  if (started.state === "belegt") {
    return {
      fail: fail(`Gerade rechnet ein anderer Prozess auf ${started.target ? describeConfig(started.target) : "einen anderen Anbieter"} neu. Nichts wurde geändert; nach dessen Ende erneut ${BRAND.cli} setup suche (Stand: ${BRAND.cli} suche status).`),
    };
  }
  // Inzwischen schon auf dem Ziel festgehalten: kein Wechsel mehr
  if (started.state === "festgehalten") return null;
  const own = !started.active;
  return {
    reindex: {
      estimate,
      holder: own ? holder : null,
      release: async () => {
        if (own) await store.lease(holder, 0).catch(() => {});
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Anbieterwechsel mit Neuberechnung (Issue #168)
// ---------------------------------------------------------------------------

/** Rückfrage beim Wechsel, transient */
export const REINDEX_FIELD = "SEARCH_REINDEX";
export const REINDEX_LABEL = "Neuberechnung beim Anbieterwechsel";
export const REINDEX_YES = "neu-berechnen";
export const REINDEX_NO = "abbrechen";
/** Kein Wechsel: die Rückfrage hat nur diese eine Antwort */
export const REINDEX_NONE = "weiter";
/** Ausgabe der Neuberechnung im Hintergrund */
export const REINDEX_LOG = join("logs", "embedding-reindex.log");

export type SwitchDecision =
  | { kind: "passt" }
  | { kind: "unlesbar" }
  | { kind: "fehlt" }
  /** Datenbank hält etwas anderes fest (from: was bisher gilt) */
  | { kind: "wechsel"; from: string }
  /** Eine Neuberechnung auf genau diese Wahl ist unterbrochen oder läuft */
  | { kind: "fortsetzen" }
  /** Eine Neuberechnung auf ein anderes Ziel ist unterbrochen oder läuft */
  | { kind: "anderes-ziel"; from: string };

const UNTAGGED = "Vektoren ohne Anbieterkennung (aus der Zeit vor der Anbieterwahl)";

/** Ist die Wahl für diese Datenbank ein Wechsel? Nur Supabase */
export function switchDecision(stored: StoredProvider | null, config: EmbeddingConfig): SwitchDecision {
  if (!stored) return { kind: "unlesbar" };
  if (stored.state === "fehlt") return { kind: "fehlt" };
  if (stored.state === "umstellung") {
    return stored.target.provider === config.provider && stored.target.model === config.model ? { kind: "fortsetzen" } : { kind: "anderes-ziel", from: describeConfig(stored.target) };
  }
  if (compareProvider(stored, config).ok) return { kind: "passt" };
  return { kind: "wechsel", from: stored.state === "festgehalten" ? describeConfig(stored.config) : UNTAGGED };
}

/**
 * Auswahl der Rückfrage (choicesFrom): liest die Kennung und, bei einem
 * Wechsel, den Umfang aus der Datenbank. Wirft nie; ist nichts lesbar, gibt
 * es nur „weiter“ (die Ausführung prüft erneut und bricht ohne Zustimmung ab).
 */
export async function reindexChoices(values: SetupValues, ctx: SetupContext): Promise<{ choices: Array<{ value: string; label: string }> }> {
  const none = (label: string) => ({ choices: [{ value: REINDEX_NONE, label }] });
  let env: Record<string, string>;
  try {
    env = await readSetupEnv(ctx);
  } catch {
    return none("Weiter (die .env ließ sich nicht lesen; geprüft wird beim Ausführen)");
  }
  const url = presentValue(env, "SUPABASE_URL");
  const key = presentValue(env, "SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key || setupPath(env) === "convex") return none("Weiter (nichts neu zu berechnen)");
  const resolved = resolveChoice(values, env);
  if (!resolved.ok) return none("Weiter (die Wahl wird beim Ausführen geprüft)");
  const config = resolved.choice.config;
  // Ohne Schlüssel ändert der Lauf nichts (nur Textsuche): keine Anfrage an die Datenbank
  if (resolved.choice.keyName && !resolved.choice.key) return none("Weiter (ohne Schlüssel ändert sich nichts)");
  let stored: StoredProvider | null = null;
  try {
    stored = await readStoredProvider({ url, key }, setupFetch(ctx, STORE_TIMEOUT_MS));
  } catch {
    stored = null;
  }
  const decision = switchDecision(stored, config);
  if (decision.kind === "passt") return none(`Weiter: ${describeConfig(config)} passt zur Datenbank, nichts neu zu berechnen`);
  if (decision.kind === "unlesbar") return none("Weiter (die Anbieterkennung ist gerade nicht lesbar; geprüft wird beim Ausführen)");
  if (decision.kind === "fehlt") return none("Weiter (der Datenbank fehlt die Anbieterkennung; geprüft wird beim Ausführen)");
  let scope: string;
  try {
    scope = estimateText(estimateReindex(await restReindexStore({ url, key }, setupFetch(ctx, STORE_TIMEOUT_MS)).estimate(), config));
  } catch (e) {
    const text = e instanceof ReindexStoreError ? e.message : "Der Umfang ließ sich nicht lesen.";
    return { choices: [{ value: REINDEX_NO, label: `Abbrechen, nichts ändern (${text})` }] };
  }
  if (decision.kind === "fortsetzen") {
    return {
      choices: [
        { value: REINDEX_YES, label: `Unterbrochene Neuberechnung auf ${describeConfig(config)} fortsetzen: ${scope}` },
        { value: REINDEX_NO, label: "Abbrechen, nichts ändern (bis die Neuberechnung fertig ist, sucht tybo nur nach Text)" },
      ],
    };
  }
  return {
    choices: [
      { value: REINDEX_NO, label: `Abbrechen, nichts ändern (es bleibt bei ${decision.from})` },
      {
        value: REINDEX_YES,
        label: `${decision.kind === "anderes-ziel" ? `Neu beginnen mit ${describeConfig(config)} statt ${decision.from}` : `Alles neu berechnen mit ${describeConfig(config)} statt ${decision.from}`}: ${scope}`,
      },
    ],
  };
}

/**
 * Nach der Einrichtung bei einem Wechsel: der Lauf ist schon reserviert
 * (providerGate, ab da nur Textsuche); die Neuberechnung im Hintergrund
 * übernimmt ihn mit demselben Inhaber. Startet sie nicht, wird die
 * Reservierung freigegeben, damit der Befehl von Hand gleich rechnen kann.
 * Der Funktionsnachweis folgt dort nach dem Umschalten.
 */
async function launchReindex(ctx: SetupContext, config: EmbeddingConfig, reservation: Reservation, done: string, changed: string[]): Promise<ApplyResult> {
  // Kurz: die volle Schätzung stand schon in der Rückfrage, und die Oberfläche kürzt lange Meldungen
  const e = reservation.estimate;
  const scope = e ? ` (ca. ${e.rows.toLocaleString("de-DE")} Einträge, etwa ${e.minutes} Minuten)` : "";
  if (reservation.holder === null) {
    return {
      ok: true,
      message: `${done} Die Neuberechnung auf ${describeConfig(config)} läuft schon in einem anderen Prozess${scope}. Stand: ${BRAND.cli} suche status. Bis sie fertig ist, findet die Suche nur Text. Am Ende kommt eine Meldung in Telegram und der WebUI.`,
      changed,
    };
  }
  const cmd = [process.execPath, "--no-env-file", join(ctx.root, "scripts", "tybo.ts"), "suche", "neu-berechnen", `--inhaber=${reservation.holder}`];
  const launched = ctx.startBackground ? await ctx.startBackground(cmd, { cwd: ctx.root, logFile: join(ctx.root, REINDEX_LOG) }).catch(() => false) : false;
  if (!launched) await reservation.release();
  const how = launched
    ? `Sie läuft im Hintergrund (Ausgabe in ${REINDEX_LOG}); Stand: ${BRAND.cli} suche status.`
    : `Starten mit: ${BRAND.cli} suche neu-berechnen (setzt nach einem Abbruch fort).`;
  return {
    ok: true,
    message: `${done} Neuberechnung auf ${describeConfig(config)} begonnen${scope}. ${how} Bis sie fertig ist, findet die Suche nur Text. Am Ende kommt eine Meldung in Telegram und der WebUI. Danach ${BRAND.name} neu starten (in der WebUI: Neustart anfordern), damit der Bot die neue Einstellung aus der .env nutzt.`,
    changed,
  };
}

// --- Cloud ------------------------------------------------------------------

const CLOUD_TOTAL = 6;

async function runCloud(
  values: SetupValues,
  ctx: SetupContext,
  env: Record<string, string>,
  url: string,
  serviceKey: string,
  choice: SearchChoice,
  report: RunReport,
  signal: AbortSignal,
  slot: ReservationSlot = {},
): Promise<ApplyResult> {
  if (choice.config.provider === "ollama") return fail(OLLAMA_CLOUD);
  const key = choice.key;
  const keyName = choice.keyName!;
  const token = values[CLOUD_TOKEN]?.trim() ?? "";
  if (!key && !token) return withoutKey(ctx, url, choice);
  if (!token) return fail(`Für Supabase in der Cloud braucht der Assistent das Zugangstoken (beginnt mit ${TOKEN_PREFIX}), um die Functions auszuliefern und das Geheimnis zu setzen. Nichts wurde geändert.`);
  if (tokenProblem(token)) return fail(`Das Zugangstoken beginnt mit ${TOKEN_PREFIX}. Unter supabase.com/dashboard/account/tokens erzeugen. Nichts wurde geändert.`);
  const ref = refFromUrl(url);
  if (!ref) return fail("SUPABASE_URL in der .env ist keine Adresse eines Supabase-Projekts (https://<projekt>.supabase.co). Nichts wurde geändert.");

  if (key) {
    const bad = await checkKeyStep(choice, ctx, report, 1, CLOUD_TOTAL, signal);
    if (bad) return bad;
  }
  const api = createSupabaseManagement(token, { fetch: ctx.fetch, sleep: ctx.sleep });
  const changed: string[] = [];
  /** Was bei Supabase schon passiert ist, für Meldungen nach Fehler oder Abbruch */
  const done: string[] = [];
  const state = () => (done.length ? `Schon erledigt: ${done.join(", ")}.` : "Nichts wurde geändert.");
  const again = `Erneut mit: ${BRAND.cli} setup suche.`;
  const aborted = () => fail(`Abgebrochen. ${state()} ${again}`, changed);
  try {
    report({ at: 2, total: CLOUD_TOTAL, label: "Suche das Projekt bei Supabase" });
    const project = await api.project(ref, signal);
    if (signal.aborted) return aborted();
    if (!project) return fail("Das Projekt aus SUPABASE_URL ist mit diesem Zugangstoken nicht erreichbar (anderes Konto oder gelöscht). Ein Token des passenden Kontos nehmen. Nichts wurde geändert.");

    // Namen der Geheimnisse: Schlüssel schon da? Steht noch eine frühere Anbieterwahl dort?
    const names = await api.secretNames(ref, signal);
    if (signal.aborted) return aborted();
    let secretSet = false;
    if (!key) {
      // Geheimnis vielleicht schon gesetzt (etwa von einem anderen Rechner), ohne Kopie in der .env
      if (!names.includes(keyName)) return withoutKey(ctx, url, choice);
      secretSet = true;
    }

    // Vor jeder Änderung: passt die Wahl zur Anbieterkennung der Datenbank? Wechsel nur mit
    // Zustimmung und erst, wenn die Datenbank den Lauf reserviert hat
    const gate = await providerGate(ctx, url, serviceKey, choice, signal, choice.reindex);
    if (gate && "fail" in gate) return gate.fail;
    const reindex = gate ? gate.reindex : undefined;
    slot.reservation = reindex;

    for (const slug of EDGE_FUNCTIONS) {
      report({ at: 3, total: CLOUD_TOTAL, label: "Liefere die Edge Functions aus", detail: slug });
      const { entrypoint, files } = await functionFiles(ctx.root, slug);
      await api.deployFunction(ref, { slug, entrypoint, files, verifyJwt: false }, signal);
      done.push(`Function ${slug} ausgeliefert`);
      if (signal.aborted) return aborted();
    }

    const secrets = runtimeValues(choice, names.includes(PROVIDER_ENV) || names.includes(MODEL_ENV));
    if (secrets.length) {
      const names = secrets.map(([n]) => n).join(", ");
      report({ at: 4, total: CLOUD_TOTAL, label: secrets.length === 1 ? `Setze das Geheimnis ${names}` : `Setze die Geheimnisse ${names}` });
      await api.setSecrets(ref, secrets.map(([name, value]) => ({ name, value })), signal);
      done.push(secrets.length === 1 ? `Geheimnis ${names} gesetzt` : `Geheimnisse ${names} gesetzt`);
      if (signal.aborted) return aborted();
    }

    if (botChanges(choice, env).length) {
      report({ at: 5, total: CLOUD_TOTAL, label: "Schreibe die .env" });
      const bad = await saveBotEnv(ctx, env, choice, changed);
      if (bad) return fail(`${bad.message} ${state()}`, changed);
    }

    const summary = secretSet
      ? `Functions ausgeliefert, das Geheimnis ${keyName} war bei Supabase schon gesetzt (in der .env steht keiner; der Bot nutzt ihn für Fakten und Bilder nur, wenn du ihn hier einträgst).`
      : "Functions ausgeliefert und Geheimnis gesetzt.";
    if (reindex !== undefined) {
      report({ at: 6, total: CLOUD_TOTAL, label: "Starte die Neuberechnung" });
      return launchReindex(ctx, choice.config, reindex, summary, changed);
    }
    report({ at: 6, total: CLOUD_TOTAL, label: "Teste: Probe speichern, finden, löschen" });
    return finish(ctx, url, serviceKey, choice.config, summary, changed, signal, again);
  } catch (e) {
    if (signal.aborted || (e instanceof SupabaseManagementError && e.kind === "abgebrochen")) return aborted();
    const text = e instanceof SupabaseManagementError ? e.message : e instanceof Error && e.name === "EnvFileError" ? "Die Dateien der Functions ließen sich nicht lesen." : "Die Anfrage an Supabase ist fehlgeschlagen.";
    return fail(`${text} ${state()} ${again}`, changed);
  }
}

// --- Lokal ------------------------------------------------------------------

const LOCAL_TOTAL = 5;

export function functionsEnvPath(root: string): string {
  return join(root, FUNCTIONS_DIR, ".env");
}

/**
 * Merker „Neustart offen“: die Edge Runtime liest supabase/functions/.env nur
 * beim Start von Supabase (https://supabase.com/docs/guides/functions/secrets).
 * Derselbe Schlüssel in der Datei beweist also nicht, dass sie ihn kennt. Der
 * Merker entsteht vor dem Schreiben der Datei und verschwindet erst nach einem
 * gelungenen Neustart; ein Abbruch oder Fehler dazwischen lässt ihn stehen,
 * der nächste Lauf holt den Neustart nach. Inhalt: nur der Zeitpunkt.
 */
export function restartMarkerPath(root: string): string {
  return join(root, "data", "semantic-search-restart");
}

async function restartPending(root: string): Promise<boolean> {
  return stat(restartMarkerPath(root)).then(
    () => true,
    () => false,
  );
}

async function markRestart(ctx: SetupContext): Promise<void> {
  await mkdir(join(ctx.root, "data"), { recursive: true, mode: 0o700 });
  await writeFile(restartMarkerPath(ctx.root), `${ctx.now().toISOString()}\n`, { mode: 0o600 });
}

async function runLocal(
  ctx: SetupContext,
  env: Record<string, string>,
  url: string,
  serviceKey: string,
  choice: SearchChoice,
  report: RunReport,
  signal: AbortSignal,
  slot: ReservationSlot = {},
): Promise<ApplyResult> {
  const root = ctx.root;
  const ollama = choice.config.provider === "ollama";
  const key = choice.key;
  const edge = edgeRuntimeEnabled(root);
  // Ohne Schlüssel ist die Textsuche kein Fehler, auch ohne Edge Runtime
  if (!key && !ollama && !edge) return { ok: true, message: choice.config.provider === "gemini" ? TEXT_ONLY_GEMINI : TEXT_ONLY, changed: [] };
  if (!edge) {
    return fail("In supabase/config.toml ist die Edge Runtime ausgeschaltet ([edge_runtime] enabled = false). Ohne sie gibt es keine Functions und nur die Textsuche. Einschalten, dann erneut.");
  }
  const fnEnvPath = functionsEnvPath(root);
  let fnEnv: Record<string, string>;
  try {
    fnEnv = await readEnvFile(fnEnvPath);
  } catch {
    return fail("supabase/functions/.env ließ sich nicht lesen. Nichts wurde geändert.");
  }
  const runtimeKey = choice.keyName ? presentValue(fnEnv, choice.keyName) : undefined;
  if (!ollama && !key && !runtimeKey) return withoutKey(ctx, url, choice);

  const changed: string[] = [];
  // Ein früherer Lauf hat die Datei geschrieben, aber nicht neu gestartet
  let restart = await restartPending(root);
  // Wortlaut: bei OpenAI und Gemini geht es um den Schlüssel, bei Ollama um Adresse und Einstellungen
  const it = ollama ? { nom: "Die Werte sind", acc: "die Werte", pron: "sie" } : { nom: "Der Schlüssel ist", acc: "den Schlüssel", pron: "ihn" };
  const later = `Der nächste Lauf von ${BRAND.cli} setup suche startet Supabase dann neu, damit die Edge Runtime ${it.acc} liest.`;
  if (key || ollama) {
    const bad = await checkKeyStep(choice, ctx, report, 1, LOCAL_TOTAL, signal);
    if (bad) return bad;
  }
  // Ein früherer Neustart hat Supabase angehalten, aber nicht wieder gestartet:
  // ohne laufende Datenbank ist die Anbieterkennung nicht lesbar. Erst über
  // tybo datenbank start (Portschutz) starten; die Edge Runtime liest dabei
  // supabase/functions/.env, der offene Neustart ist damit erledigt.
  let resumed = false;
  if (restart) {
    const running = await runningContainers(ctx);
    if (running && !running.has(DB_CONTAINER)) {
      report({ at: 1, total: LOCAL_TOTAL, label: "Starte Supabase wieder (der letzte Lauf hatte es angehalten)" });
      const errors: string[] = [];
      const code = await runDatabaseCommand(["start"], { ctx, env, out: () => {}, err: line => errors.push(line), signal });
      if (code !== 0) return fail(`Supabase ist nicht wieder gestartet. ${errors.join(" ")} Danach: ${BRAND.cli} setup suche.`);
      await rm(restartMarkerPath(root), { force: true }).catch(() => {});
      restart = false;
      resumed = true;
    }
  }
  // Vor jeder Änderung: passt die Wahl zur Anbieterkennung der Datenbank? Wechsel nur mit
  // Zustimmung und erst, wenn die Datenbank den Lauf reserviert hat
  const gate = await providerGate(ctx, url, serviceKey, choice, signal, choice.reindex);
  if (gate && "fail" in gate) return gate.fail;
  const reindex = gate ? gate.reindex : undefined;
  slot.reservation = reindex;

  // Auch eine zurückgebliebene Wahl eines früheren Laufs (etwa Gemini) wird angeglichen
  const leftover = presentValue(fnEnv, PROVIDER_ENV) !== undefined || presentValue(fnEnv, MODEL_ENV) !== undefined;
  const diff = runtimeValues(choice, leftover).filter(([name, value]) => fnEnv[name] !== value);
  if (diff.length) {
    const onlyKey = diff.length === 1 && diff[0][0] === choice.keyName;
    report({ at: 2, total: LOCAL_TOTAL, label: onlyKey ? "Trage den Schlüssel für die Edge Runtime ein" : "Trage die Einstellungen für die Edge Runtime ein" });
    try {
      await markRestart(ctx);
    } catch (e) {
      return fail(writeProblem("data/semantic-search-restart", e));
    }
    try {
      const result = await updateEnvValues(fnEnvPath, diff, { backupDir: ctx.backupDir, now: ctx.now, io: ctx.envIo });
      if (result.changed) changed.push(fnEnvPath);
    } catch (e) {
      return fail(writeProblem("supabase/functions/.env", e));
    }
    restart = true;
  }
  if (botChanges(choice, env).length) {
    report({ at: 3, total: LOCAL_TOTAL, label: "Schreibe die .env" });
    const bad2 = await saveBotEnv(ctx, env, choice, changed);
    if (bad2) return restart ? fail(`${bad2.message} ${later}`, changed) : bad2;
  }
  if (signal.aborted) {
    const state = restart ? `${it.nom} eingetragen, die Edge Runtime kennt ${it.pron} erst nach einem Neustart. ${later}` : "Nichts wurde geändert.";
    return fail(`Abgebrochen. ${state} Erneut mit: ${BRAND.cli} setup suche.`, changed);
  }

  if (restart) {
    report({ at: 4, total: LOCAL_TOTAL, label: "Starte Supabase neu (die Daten bleiben)" });
    // Ohne Signal: das Anhalten läuft zu Ende; nie --no-backup, nie --all
    const stop = await ctx.run(supabaseCli(["stop", "--workdir", root]), { timeoutMs: STATUS_TIMEOUT_MS, cwd: root, env: cliEnv() });
    if (stop.code !== 0 || stop.timedOut) {
      const guard = await checkExposure(ctx, localDeps(ctx));
      const state = guard.state === "sicher" ? "Es läuft weiter, nur auf diesem Rechner erreichbar." : guard.state === "keine" ? "Es läuft jetzt nicht mehr." : guardText(guard, root);
      return fail(`${it.nom} eingetragen, aber Supabase ließ sich für den Neustart nicht anhalten. ${state} Docker neu starten, dann: ${BRAND.cli} datenbank start und ${BRAND.cli} setup suche.`, changed);
    }
    const errors: string[] = [];
    const code = await runDatabaseCommand(["start"], { ctx, env, out: () => {}, err: line => errors.push(line), signal });
    if (code !== 0) {
      return fail(`${it.nom} eingetragen, aber Supabase ist nicht wieder gestartet. ${errors.join(" ")} Danach: ${BRAND.cli} setup suche.`, changed);
    }
    // Erst jetzt kennt die Edge Runtime die Werte sicher
    await rm(restartMarkerPath(root), { force: true }).catch(() => {});
  }

  const summary = changed.includes(fnEnvPath)
    ? ollama
      ? "Einstellungen eingetragen, Supabase neu gestartet."
      : "Schlüssel eingetragen, Supabase neu gestartet."
    : restart || resumed
      ? `Supabase neu gestartet, damit die Edge Runtime ${it.acc} liest (der letzte Lauf hatte das nicht mehr geschafft).`
      : key || ollama
        ? `Die Edge Runtime hatte ${it.acc} schon.`
        : "Die Edge Runtime hat einen Schlüssel aus supabase/functions/.env.";
  if (reindex !== undefined) {
    report({ at: 5, total: LOCAL_TOTAL, label: "Starte die Neuberechnung" });
    return launchReindex(ctx, choice.config, reindex, summary, changed);
  }
  report({ at: 5, total: LOCAL_TOTAL, label: "Teste: Probe speichern, finden, löschen" });
  return finish(ctx, url, serviceKey, choice.config, summary, changed, signal, `Erneut mit: ${BRAND.cli} setup suche.`);
}

// --- Selbst eingetragen -------------------------------------------------------

const SELF_TOTAL = 3;

export function selfHostedHint(): string {
  return `Bei selbst eingetragenem Supabase richtet ${BRAND.name} die Functions nicht ein. Im Projektordner selbst: für jede der Functions ${EDGE_FUNCTIONS.join(", ")} „supabase functions deploy <name> --no-verify-jwt“, dann „supabase secrets set OPENAI_API_KEY=…“ (Anleitung: ${DOC_SECRETS}). Danach ${BRAND.cli} setup suche erneut.`;
}

async function runSelfHosted(
  ctx: SetupContext,
  env: Record<string, string>,
  url: string,
  serviceKey: string,
  choice: SearchChoice,
  report: RunReport,
  signal: AbortSignal,
): Promise<ApplyResult> {
  if (!isLegacyDefault(choice.config)) return fail(selfHostedOnlyOpenAi(choice.config));
  if (!choice.key) {
    const r = await withoutKey(ctx, url, choice);
    return { ...r, message: `${r.message} ${selfHostedHint()}` };
  }
  const changed: string[] = [];
  const bad = await checkKeyStep(choice, ctx, report, 1, SELF_TOTAL, signal);
  if (bad) return bad;
  // Kein Wechsel mit Neuberechnung: die Functions dort richtet der Nutzer selbst ein
  const gate = await providerGate(ctx, url, serviceKey, choice, signal, null);
  if (gate && "fail" in gate) return gate.fail;
  if (gate) return fail(`Bei selbst eingetragenem Supabase stellt der Assistent den Anbieter nicht um (die Functions dort kennt er nicht). Nichts wurde geändert.`);
  report({ at: 2, total: SELF_TOTAL, label: "Schreibe die .env" });
  const bad2 = await saveBotEnv(ctx, env, choice, changed);
  if (bad2) return bad2;
  report({ at: 3, total: SELF_TOTAL, label: "Teste: Probe speichern, finden, löschen" });
  return finish(ctx, url, serviceKey, choice.config, "OPENAI_API_KEY ist in der .env.", changed, signal, selfHostedHint());
}
