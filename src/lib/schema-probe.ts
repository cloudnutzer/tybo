/**
 * Schemaprobe (Issue #560): Fehlt der Datenbank eine Datei aus SCHEMA_FILES?
 *
 * Ein Update holt neuen Code, aber keine neuen Tabellen. Die Probe prüft je
 * Datei ein Merkmal über die REST-Schnittstelle von Supabase (PostgREST) mit
 * dem vorhandenen Schlüssel und schreibt nichts:
 *
 * - Spalten und Tabellen: GET /rest/v1/<tabelle>?select=<spalten>&limit=0.
 *   Liefert keine Zeile, nur ob PostgREST die Spalten kennt.
 * - Funktionen: einmal das Verzeichnis der Schnittstelle (GET /rest/v1/,
 *   OpenAPI). Es listet jede aufrufbare Funktion als /rpc/<name>. PostgREST
 *   filtert das Verzeichnis aber nach den Rechten des Schlüssels
 *   (openapi-mode follow-privileges): Eine vorhandene Funktion ohne
 *   EXECUTE-Recht fehlt dort ebenso wie eine fehlende. Fehlt eine Funktion im
 *   Verzeichnis, fragt die Probe sie darum einzeln ab, mit GET
 *   /rest/v1/rpc/<name> und den Parameternamen der Funktion. PostgREST führt
 *   GET in einer Transaktion nur zum Lesen aus, und die Werte sind so gewählt,
 *   dass nichts Nennenswertes läuft. Nur „Funktion nicht im Schema-Cache“
 *   (PGRST202) heißt fehlend; fehlendes Ausführungsrecht (42501) und jede
 *   andere Antwort heißen „nicht prüfbar“.
 * - Rechte (nur 20261021_base_grants.sql, die Datei legt nichts an): ob die
 *   Grundtabellen mit dem Server-Schlüssel lesbar sind. Belegt wird nur das
 *   Leserecht, nicht Schreib- oder Sequenzrechte; die gibt dieselbe Datei
 *   mit, prüfen lässt sich das ohne Schreiben nicht.
 *
 * Fehlt etwas sicher (PostgREST meldet Tabelle, Spalte oder Funktion
 * unbekannt), zählt die Datei als fehlend. Netzfehler,
 * Zeitüberschreitung, abgelehnter Schlüssel, fehlende Rechte und unlesbare
 * Antworten heißen „nicht prüfbar“, nie „Migration fehlt“. Ist schon die
 * erste Anfrage (messages) so gescheitert, fragt die Probe nichts weiter.
 *
 * Neue Migrationen melden ihr Merkmal in SCHEMA_MARKERS an; der Typ und
 * tests/schema-probe.test.ts erzwingen das für jede Datei in SCHEMA_FILES.
 */

import { BRAND } from "../brand";
import { SCHEMA_FILES } from "../setup/supabase-schema";
import { isNewSupabaseKey, isPublishableSupabaseKey, supabaseHeaders } from "./supabase-keys";

export type SchemaFileName = (typeof SCHEMA_FILES)[number];

export type SchemaMarker =
  /** Tabelle mit diesen Spalten */
  | { kind: "columns"; table: string; columns: string[] }
  /**
   * Funktion im Schema public. args: Parameter für die Einzelabfrage, wenn
   * die Funktion im Verzeichnis fehlt; die Namen müssen zur Funktion passen
   * (sonst fände PostgREST sie nicht), die Werte verhindern echte Arbeit
   */
  | { kind: "function"; name: string; args: Record<string, string> }
  /** Leserecht des Server-Schlüssels auf diesen Tabellen */
  | { kind: "grants"; tables: string[] };

/** Wert für die Parameter der Einzelabfrage einer Funktion: kein gültiger Vektor, kein bekannter Anbieter */
const PROBE_VALUE = "tybo-schemaprobe";

/**
 * Merkmale je Datei; alle müssen da sein. Gewählt ist, was erst diese Datei
 * anlegt: message_chunks steht auch in db/schema.sql, darum prüft die
 * Migration ihre eigene, lesende Funktion message_chunks_status.
 */
export const SCHEMA_MARKERS: Record<SchemaFileName, SchemaMarker[]> = {
  "db/schema.sql": [
    { kind: "columns", table: "messages", columns: ["id"] },
    { kind: "columns", table: "memory", columns: ["id"] },
  ],
  "db/migrations/2026-07-02-fable-topics-memory.sql": [
    { kind: "columns", table: "messages", columns: ["topic_id", "session_key"] },
    { kind: "columns", table: "memory", columns: ["embedding"] },
  ],
  "db/migrations/20260909_security_knowledge.sql": [{ kind: "columns", table: "knowledge", columns: ["id"] }],
  "db/migrations/20260927_embedding_provider.sql": [{ kind: "columns", table: "embedding_settings", columns: ["state", "provider", "model"] }],
  "db/migrations/20260928_embedding_reindex.sql": [
    { kind: "columns", table: "embedding_settings", columns: ["generation"] },
    { kind: "columns", table: "embedding_reindex_queue", columns: ["failed"] },
  ],
  // Ungültige Vektoren lassen den Aufruf vor dem Funktionsrumpf scheitern; message_chunks_status hat nur Text und zählt nur
  "db/migrations/20261015_message_chunks.sql": [{ kind: "function", name: "message_chunks_status", args: { p_provider: PROBE_VALUE, p_model: PROBE_VALUE } }],
  "db/migrations/20261017_knowledge_context.sql": [{ kind: "function", name: "knowledge_context", args: { query_embedding: PROBE_VALUE } }],
  "db/migrations/20261017_scheduled_tasks.sql": [{ kind: "columns", table: "scheduled_tasks", columns: ["id", "due_at", "status"] }],
  "db/migrations/20261018_scheduled_tasks_lease.sql": [{ kind: "columns", table: "scheduled_tasks", columns: ["lease_owner", "lease_until", "send_started_at"] }],
  "db/migrations/20261021_base_grants.sql": [{ kind: "grants", tables: ["messages", "memory", "logs"] }],
  "db/migrations/20261031_memory_archive.sql": [{ kind: "columns", table: "memory", columns: ["archived_at", "revised_at"] }],
  "db/migrations/20261031_memory_facts_search.sql": [
    { kind: "function", name: "match_facts_checked", args: { p_provider: PROBE_VALUE, p_model: PROBE_VALUE, query_embedding: PROBE_VALUE } },
  ],
};

/** Befehl, der fehlende Dateien einspielt */
export const SCHEMA_REPAIR_COMMAND = `${BRAND.cli} setup datenbank`;

export type ProbeFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export interface SchemaProbeOptions {
  url: string;
  key: string;
  fetch?: ProbeFetch;
  /** Zeitlimit je Anfrage, Standard 8 s */
  timeoutMs?: number;
  /** Abbruch von außen (etwa das Zeitlimit des Prüfberichts) */
  signal?: AbortSignal;
}

export interface UncheckedFile {
  file: SchemaFileName;
  reason: string;
}

export type SchemaProbeResult =
  /** Alle Merkmale da */
  | { state: "ok" }
  /** Mindestens eine Datei fehlt sicher; unchecked: was daneben nicht prüfbar war */
  | { state: "missing"; missing: SchemaFileName[]; unchecked: UncheckedFile[] }
  /** Nichts fehlt sicher, aber nicht alles ließ sich prüfen */
  | { state: "unknown"; reason: string; unchecked: UncheckedFile[] };

const DEFAULT_TIMEOUT_MS = 8_000;

type Verdict = { state: "present" } | { state: "missing"; cause?: "table" | "column" | "rights" } | { state: "unknown"; reason: string };

const PRESENT: Verdict = { state: "present" };
const MISSING: Verdict = { state: "missing" };

/** Codes, mit denen PostgREST eine fehlende Tabelle bzw. Spalte meldet */
const MISSING_TABLE_CODES = new Set(["PGRST205", "42P01"]);
const MISSING_COLUMN_CODES = new Set(["42703", "PGRST204"]);
const PERMISSION_CODE = "42501";

function failureReason(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "Zeitüberschreitung";
  return "Datenbank nicht erreichbar";
}

async function errorCode(res: Response): Promise<string | undefined> {
  try {
    const body = (await res.json()) as { code?: unknown };
    return typeof body?.code === "string" ? body.code : undefined;
  } catch {
    return undefined;
  }
}

const NO_RIGHTS: Verdict = { state: "unknown", reason: "fehlende Rechte (Server-Schlüssel SUPABASE_SERVICE_ROLE_KEY nötig)" };

/**
 * Antwort auf eine Spaltenabfrage einordnen. Fehlende Rechte mit einem
 * Server-Schlüssel heißen cause "rights"; nur das Rechte-Merkmal wertet das
 * als fehlende Datei, alle anderen als nicht prüfbar
 */
async function classify(res: Response, serviceKey: boolean): Promise<Verdict> {
  if (res.ok) {
    await res.body?.cancel().catch(() => {});
    return PRESENT;
  }
  const code = await errorCode(res);
  if (code && MISSING_TABLE_CODES.has(code)) return { state: "missing", cause: "table" };
  if (code && MISSING_COLUMN_CODES.has(code)) return { state: "missing", cause: "column" };
  if (code === PERMISSION_CODE) {
    // Nur mit einem Server-Schlüssel sind fehlende Rechte das Zeichen der fehlenden Datei
    return serviceKey ? { state: "missing", cause: "rights" } : NO_RIGHTS;
  }
  if (res.status === 401 || res.status === 403) return { state: "unknown", reason: `Schlüssel abgelehnt (HTTP ${res.status})` };
  return { state: "unknown", reason: `unerwartete Antwort (HTTP ${res.status})` };
}

/** Code, mit dem PostgREST eine Funktion meldet, die es im Schema-Cache nicht findet */
const MISSING_FUNCTION_CODE = "PGRST202";

/**
 * Antwort auf die Einzelabfrage einer Funktion, die im Verzeichnis fehlt.
 * Fehlend nur bei PGRST202; ohne Ausführungsrecht (42501) oder mit einer
 * anderen Antwort von Postgres (etwa der ungültige Vektor) gibt es die
 * Funktion, nur prüfen lässt sie sich mit diesem Schlüssel nicht
 */
async function classifyCall(res: Response, name: string): Promise<Verdict> {
  if (res.ok) {
    await res.body?.cancel().catch(() => {});
    return PRESENT;
  }
  const code = await errorCode(res);
  if (code === MISSING_FUNCTION_CODE) return MISSING;
  if (code === PERMISSION_CODE) return { state: "unknown", reason: `Funktion ${name} vorhanden, aber für diesen Schlüssel nicht ausführbar (fehlendes EXECUTE-Recht)` };
  if (res.status === 401 || res.status === 403) return { state: "unknown", reason: `Schlüssel abgelehnt (HTTP ${res.status})` };
  if (code && !code.startsWith("PGRST")) return { state: "unknown", reason: `Funktion ${name} vorhanden, aber nicht im Verzeichnis der Schnittstelle (fehlendes EXECUTE-Recht?)` };
  return { state: "unknown", reason: `unerwartete Antwort (HTTP ${res.status})` };
}

/**
 * Schlüssel, der am Rechteschutz vorbei liest: service_role (JWT) oder
 * sb_secret_. Ein JWT ohne lesbare Rolle zählt als Server-Schlüssel, weil
 * SUPABASE_SERVICE_ROLE_KEY ihn so nennt; nur anon und sb_publishable_ nicht.
 */
export function isServerKey(key: string): boolean {
  if (isNewSupabaseKey(key)) return !isPublishableSupabaseKey(key);
  const payload = key.split(".")[1];
  if (!payload) return true;
  try {
    const role = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { role?: unknown }).role;
    return role !== "anon" && role !== "authenticated";
  } catch {
    return true;
  }
}

export async function probeSchema(options: SchemaProbeOptions): Promise<SchemaProbeResult> {
  const base = `${options.url.trim().replace(/\/+$/, "")}/rest/v1`;
  const headers = supabaseHeaders(options.key.trim());
  const doFetch: ProbeFetch = options.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const serviceKey = isServerKey(options.key.trim());
  const signal = () => (options.signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), options.signal]) : AbortSignal.timeout(timeoutMs));

  // Jede Abfrage höchstens einmal (messages?select=id prüfen Verbindung und Rechte)
  const asked = new Map<string, Promise<Verdict>>();
  const select = async (table: string, columns: string[], grants = false): Promise<Verdict> => {
    const url = `${base}/${encodeURIComponent(table)}?select=${columns.map(encodeURIComponent).join(",")}&limit=0`;
    let pending = asked.get(url);
    if (!pending) {
      pending = doFetch(url, { headers, signal: signal() }).then(
        res => classify(res, serviceKey),
        (e: unknown): Verdict => ({ state: "unknown", reason: failureReason(e) }),
      );
      asked.set(url, pending);
    }
    const verdict = await pending;
    return !grants && verdict.state === "missing" && verdict.cause === "rights" ? NO_RIGHTS : verdict;
  };

  // Erst die Verbindung: scheitert schon messages ohne Antwort von PostgREST, fragt die Probe nichts weiter
  // (fehlende Rechte mit dem Server-Schlüssel sind eine Antwort: dann fehlt 20261021_base_grants.sql)
  const first = await select("messages", ["id"], true);
  if (first.state === "unknown") return { state: "unknown", reason: first.reason, unchecked: [] };

  let functions: Promise<Set<string> | string> | undefined;
  const functionList = () =>
    (functions ??= (async () => {
      try {
        const res = await doFetch(`${base}/`, { headers: { ...headers, Accept: "application/openapi+json" }, signal: signal() });
        if (!res.ok) {
          await res.body?.cancel().catch(() => {});
          return res.status === 401 || res.status === 403 ? `Schlüssel abgelehnt (HTTP ${res.status})` : `Verzeichnis der Schnittstelle nicht lesbar (HTTP ${res.status})`;
        }
        const doc = (await res.json()) as { paths?: unknown };
        if (!doc || typeof doc.paths !== "object" || doc.paths === null) return "Verzeichnis der Schnittstelle unlesbar";
        const names = Object.keys(doc.paths as Record<string, unknown>)
          .filter(p => p.startsWith("/rpc/"))
          .map(p => p.slice("/rpc/".length));
        return new Set(names);
      } catch (e) {
        return failureReason(e);
      }
    })());

  // Funktion fehlt im Verzeichnis: fehlt sie wirklich, oder darf der Schlüssel sie nur nicht ausführen?
  const functionCall = async (name: string, args: Record<string, string>): Promise<Verdict> => {
    const query = Object.entries(args)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join("&");
    try {
      const res = await doFetch(`${base}/rpc/${encodeURIComponent(name)}${query ? `?${query}` : ""}`, { headers, signal: signal() });
      return await classifyCall(res, name);
    } catch (e) {
      return { state: "unknown", reason: failureReason(e) };
    }
  };

  const check = async (marker: SchemaMarker): Promise<Verdict> => {
    if (marker.kind === "columns") {
      return select(marker.table, marker.columns);
    }
    if (marker.kind === "grants") {
      const verdicts = await Promise.all(marker.tables.map(t => select(t, ["id"], true)));
      // Eine fehlende Tabelle ist Sache von db/schema.sql, nicht der Rechte
      if (verdicts.some(v => v.state === "missing" && v.cause === "rights")) return MISSING;
      return verdicts.find(v => v.state === "unknown") ?? PRESENT;
    }
    const list = await functionList();
    if (typeof list === "string") return { state: "unknown", reason: list };
    return list.has(marker.name) ? PRESENT : functionCall(marker.name, marker.args);
  };

  const files = SCHEMA_FILES as readonly SchemaFileName[];
  const results = await Promise.all(
    files.map(async file => {
      const verdicts = await Promise.all(SCHEMA_MARKERS[file].map(check));
      if (verdicts.some(v => v.state === "missing")) return { file, verdict: MISSING };
      const unknown = verdicts.find(v => v.state === "unknown");
      return { file, verdict: unknown ?? PRESENT };
    }),
  );
  const missing = results.filter(r => r.verdict.state === "missing").map(r => r.file);
  const unchecked = results.flatMap(r => (r.verdict.state === "unknown" ? [{ file: r.file, reason: r.verdict.reason }] : []));
  if (missing.length) return { state: "missing", missing, unchecked };
  if (unchecked.length) return { state: "unknown", reason: unchecked[0].reason, unchecked };
  return { state: "ok" };
}

/** Dateiname ohne Ordner, für Meldungen */
export function schemaFileLabel(file: string): string {
  return file.slice(file.lastIndexOf("/") + 1);
}

/**
 * Meldung für den Nutzer bei fehlenden Dateien, mit Reparaturbefehl; null,
 * wenn nichts sicher fehlt
 */
export function schemaGapNotice(result: SchemaProbeResult): string | null {
  if (result.state !== "missing") return null;
  const names = result.missing.map(schemaFileLabel).join(", ");
  return [
    `Der Datenbank fehlen ${result.missing.length === 1 ? "eine Migration" : `${result.missing.length} Migrationen`}: ${names}.`,
    `Bis sie eingespielt sind, funktionieren Teile von ${BRAND.name} nicht (etwa Erinnerungen, Abschnitte langer Nachrichten oder die Suche).`,
    `Nachholen im Terminal im Ordner von ${BRAND.name}: ${SCHEMA_REPAIR_COMMAND}`,
  ].join(" ");
}
