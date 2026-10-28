/**
 * Gemeinsamer Rahmen der Edge Functions (Issue #320). Jede Function liefert
 * nur noch ihren fachlichen Teil; hier liegen Preflight, Schlüsselprüfung,
 * Server-Schlüssel, JSON-Rumpf, Pflichtfelder und Fehlerantworten.
 *
 * Ohne Deno-API und ohne esm.sh: Umgebung, Datenbank-Client und fetch kommen
 * als Parameter herein, damit Bun-Tests den Rahmen direkt prüfen können.
 *
 * Reihenfolge einer Anfrage:
 * 1. OPTIONS: Preflight mit CORS-Köpfen, vor der Schlüsselprüfung und ohne
 *    Aufruf an Datenbank oder Anbieter (bis #320 stand die Prüfung davor, der
 *    Preflight bekam 405).
 * 2. authorizeServer (auth.ts): 405, 503 oder 401 als Text.
 * 3. adminKey (admin-key.ts): ohne nutzbaren Server-Schlüssel 503.
 * 4. Rumpf lesen, Pflichtfelder prüfen (400), dann die Function. Was dabei
 *    wirft, wird zu 500 mit dem Fehlertext.
 *
 * Das Fehlerformat bleibt je Function, wie es war: search-memory antwortet
 * mit { error }, die schreibenden mit { ok: false, error }.
 */
import { adminKey, type EnvReader } from "./admin-key.ts";
import { authorizeServer } from "./auth.ts";
import { embedForDatabase, firstReport, MISSING_COLUMN_CODES, type EmbedResult, type FetchLike } from "./embedding.ts";

/** Köpfe für Browser-Aufrufe, am Preflight und an jeder JSON-Antwort */
export const CORS_HEADERS: Readonly<Record<string, string>> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** Antwort als JSON mit CORS-Köpfen */
export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } });
}

/** Fehler der Datenbank, so weit die Functions ihn lesen */
export interface DbError {
  code?: string;
  message: string;
}

/** Ergebnis einer Abfrage, wie supabase-js es liefert */
export type DbResult<T = unknown> = PromiseLike<{ data: T | null; error: DbError | null }>;

/** Wie die Function an ihren Client kommt (createClient aus supabase-js) */
export type ConnectFn<Db> = (url: string, key: string) => Db;

export interface EdgeRequest<Db> {
  /** Der gelesene JSON-Rumpf; die Pflichtfelder sind gesetzt */
  body: Record<string, any>;
  /** Client mit dem Server-Schlüssel, erst beim ersten Aufruf erzeugt */
  db(): Db;
  /**
   * Embedding für die eigene Datenbank (Anbieter und Kennung wie in
   * embedding.ts). Eine Sperre wegen falschen Anbieters kommt einmal je
   * Isolate ins Log, als fester Satz ohne Werte.
   */
  embed(text: string): Promise<EmbedResult>;
  /**
   * Arbeit nach der Antwort weiterlaufen lassen (EdgeRuntime.waitUntil).
   * true: übernommen, die Antwort wartet nicht darauf; false: die Laufzeit
   * kann das nicht, der Aufrufer wartet selbst vor der Antwort.
   */
  background(task: Promise<unknown>): boolean;
}

export interface EdgeFunction<Db> {
  /** Felder, die im Rumpf gesetzt sein müssen (leer, 0, null zählen als fehlend) */
  required: readonly string[];
  /** Satz der 400-Antwort bei fehlendem Pflichtfeld */
  missingMessage: string;
  /** Form der Fehlerantwort dieser Function (400 und 500) */
  failure(message: string): Record<string, unknown>;
  run(request: EdgeRequest<Db>): Promise<Response>;
}

export interface EdgeRuntime<Db> {
  env: EnvReader;
  connect: ConnectFn<Db>;
  /** Standard: das globale fetch zur Zeit des Aufrufs */
  fetch?: FetchLike;
  /**
   * Arbeit nach der Antwort (in Supabase EdgeRuntime.waitUntil); false oder
   * ohne Angabe: nicht möglich, siehe EdgeRequest.background
   */
  waitUntil?(task: Promise<unknown>): boolean;
}

/** EdgeRuntime.waitUntil der Supabase-Laufzeit, zur Zeit des Aufrufs gelesen; false ohne sie */
export function edgeRuntimeWaitUntil(task: Promise<unknown>): boolean {
  const runtime = (globalThis as { EdgeRuntime?: { waitUntil?: (p: Promise<unknown>) => void } }).EdgeRuntime;
  if (!runtime?.waitUntil) return false;
  runtime.waitUntil(task);
  return true;
}

/** Ist ein Pflichtfeld nicht gesetzt? Wirft wie bisher, wenn der Rumpf null ist */
function firstMissing(body: Record<string, unknown>, required: readonly string[]): string | undefined {
  return required.find(field => !body[field]);
}

/** Baut den Handler für Deno.serve */
export function edgeHandler<Db>(fn: EdgeFunction<NoInfer<Db>>, runtime: EdgeRuntime<Db>): (req: Request) => Promise<Response> {
  const { env, connect } = runtime;
  const fetchFn: FetchLike = runtime.fetch ?? ((input, init) => fetch(input, init));

  return async (req) => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

    const refused = authorizeServer(req, env);
    if (refused) return refused;
    const key = adminKey(env);
    if (!key) return new Response("Not configured", { status: 503 });

    try {
      const body = await req.json();
      if (firstMissing(body, fn.required) !== undefined) return jsonResponse(fn.failure(fn.missingMessage), 400);

      let client: Db | undefined;
      const target = { url: env("SUPABASE_URL") ?? "", key };
      return await fn.run({
        body,
        db: () => (client ??= connect(env("SUPABASE_URL")!, key)),
        embed: async (text) => {
          const result = await embedForDatabase(text, env, fetchFn, target);
          if (!result.ok && result.reason === "gesperrt" && firstReport(result.message)) console.warn(result.message);
          return result;
        },
        background: (task) => runtime.waitUntil?.(task) ?? false,
      });
    } catch (err) {
      return jsonResponse(fn.failure(String(err)), 500);
    }
  };
}

/**
 * Schreiben mit Angabe embedding_model (die Datenbank prüft den Vektor,
 * Issue #168). Kennt die Datenbank die Spalte nicht (Migration 20260928
 * fehlt), ein zweiter Versuch ohne die Angabe.
 */
export async function writeWithModelLabel(label: string | undefined, write: (label: string | undefined) => DbResult): Promise<DbError | null> {
  return (await writeRowWithModelLabel(label, write)).error;
}

/**
 * Wie writeWithModelLabel, liefert aber auch die Daten des zählenden
 * Versuchs (etwa die ID der eingefügten Zeile über select("id").single()).
 */
export async function writeRowWithModelLabel<T>(
  label: string | undefined,
  write: (label: string | undefined) => DbResult<T>,
): Promise<{ data: T | null; error: DbError | null }> {
  const first = await write(label);
  if (!first.error || !label || !MISSING_COLUMN_CODES.includes(String(first.error.code))) return first;
  return await write(undefined);
}
