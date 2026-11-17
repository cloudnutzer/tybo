/**
 * Kindprozess für tests/services-import.test.ts: importiert Briefing und
 * Check-in in einem frischen Prozess und zählt dabei Netzaufrufe und Timer.
 * Im Testprozess selbst ginge das nicht verlässlich: bun führt alle
 * Testdateien in einem Prozess aus, und Arbeit, die eine frühere Datei
 * angestoßen hat, legt während des Imports eigene Timer an. Hier läuft
 * nichts anderes, gezählt wird nur, was der Import auslöst.
 *
 * Aufruf: bun --no-env-file tests/fixtures/import-side-effects.ts <projektordner>
 * Ausgabe: eine JSON-Zeile mit fetchCalls, timers (Stack je Timer) und importMs.
 */

const fetchCalls: string[] = [];
const timers: string[] = [];
const originalSetTimeout = globalThis.setTimeout;

globalThis.fetch = (async (url: string | URL | Request) => {
  fetchCalls.push(String(url));
  throw new Error("kein Netz im Test");
}) as typeof fetch;
globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...rest: unknown[]) => {
  timers.push(`${ms ?? 0} ms: ${new Error().stack ?? ""}`);
  return originalSetTimeout(fn, ms, ...rest);
}) as typeof setTimeout;

const root = process.argv[2];
const start = Date.now();
await import(`${root}/src/routines/briefing.ts`);
await import(`${root}/src/routines/checkin.ts`);
const importMs = Date.now() - start;
globalThis.setTimeout = originalSetTimeout;

console.log(JSON.stringify({ fetchCalls, timers, importMs }));
