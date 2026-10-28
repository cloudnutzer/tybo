/**
 * Sammelt die Abschnitte einer Quellen-Liste (Issue #354). Nicht bereite
 * Quellen werden übersprungen, die übrigen laufen gleichzeitig, jede mit
 * eigenem Zeitlimit. Läuft eine Quelle in ihr Zeitlimit, wird ihr Signal
 * ausgelöst und ein spätes Ergebnis verworfen; Fehler und Zeitlimit einer
 * Quelle halten die anderen nicht auf. Die Ausgänge kommen in der
 * Reihenfolge der Liste zurück.
 */
import type { Env, Section, Source, SourceContext, SourceOutcome } from "./types";

/** Zeitlimit einer Quelle ohne eigenes */
export const DEFAULT_SOURCE_TIMEOUT_MS = 20_000;

export interface RunOptions {
  env?: Env;
  now?: Date;
  fetch?: typeof fetch;
  /** Zeitlimit für Quellen ohne eigenes */
  timeoutMs?: number;
}

/** USER_TIMEZONE, wenn Intl sie kennt, sonst UTC */
export function userTimeZone(env: Env): string {
  const zone = env.USER_TIMEZONE?.trim();
  if (!zone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return "UTC";
  }
}

/** Kalendertag des Zeitpunkts in der Zeitzone, als YYYY-MM-DD */
export function dayIn(when: Date, timeZone: string): string {
  return when.toLocaleDateString("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
}

/** Ob die Quelle bereit ist; eine werfende Prüfung gilt als nicht bereit */
export function isReady(source: Source, env: Env): boolean {
  try {
    return source.ready(env);
  } catch {
    return false;
  }
}

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** Eine Quelle mit Zeitlimit; wirft nie */
export async function runSource(source: Source, options: RunOptions = {}): Promise<SourceOutcome> {
  const env = options.env ?? process.env;
  if (!isReady(source, env)) return { source, status: "skipped" };

  const limit = source.timeoutMs ?? options.timeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  const controller = new AbortController();
  const ctx: SourceContext = {
    env,
    now: options.now ?? new Date(),
    timeZone: userTimeZone(env),
    signal: controller.signal,
    fetch: options.fetch ?? globalThis.fetch,
  };
  const started = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<"timeout">(resolve => {
    timer = setTimeout(() => resolve("timeout"), limit);
  });
  try {
    // collect kann synchron werfen, deshalb im then
    const work = Promise.resolve().then(() => source.collect(ctx));
    work.catch(() => {}); // ein Fehler nach dem Zeitlimit bleibt still
    const first: Section | "timeout" = await Promise.race([work, expired]);
    const ms = Date.now() - started;
    if (first === "timeout") {
      controller.abort(new Error(`Zeitlimit ${limit} ms`));
      return { source, status: "timeout", ms };
    }
    return { source, status: "ok", section: first, ms };
  } catch (err) {
    return { source, status: "failed", error: reason(err), ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** Alle Quellen der Liste gleichzeitig, Ausgänge in Listen-Reihenfolge */
export function runSources(list: readonly Source[], options: RunOptions = {}): Promise<SourceOutcome[]> {
  return Promise.all(list.map(source => runSource(source, options)));
}
