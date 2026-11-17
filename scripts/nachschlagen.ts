#!/usr/bin/env bun
/**
 * Im Gedächtnis nachschlagen (Issue #523): derselbe Weg wie das Werkzeug
 * history_search, für Motoren ohne dieses Werkzeug. Claude Code ruft den Befehl
 * über Bash auf; der Prompt erklärt ihn (factLookupSection in
 * src/agents/prompt-parts.ts). Sucht in Fakten, Nachrichten, Wissensbasis und
 * Bildern und schreibt das Ergebnis als JSON nach stdout. Liest nur.
 *
 *   bun run nachschlagen "Wie heißt der Hund von Mia?"
 *   bun run nachschlagen --limit 10 "Waldhonig"
 *
 * Subprozesse erben keine Geheimnisse (src/lib/subprocess-env.ts), die Zugangsdaten
 * kommen hier wie bei bun run notify aus der .env des Projekts.
 *
 * Exit-Code: 0 Suche gelaufen, auch ohne Treffer (dann steht ein hint im JSON);
 * 1 keine Treffer und mindestens eine Quelle nicht erreichbar (unavailable im
 * JSON), oder die Suche selbst ist gescheitert; 2 falsche Eingabe.
 */

import { loadEnv } from "../src/lib/env";
import { createHistorySearchHandler } from "../src/lib/tools/history-search";

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;

export const USAGE = `Aufruf: bun run nachschlagen [--limit <zahl>] "<suchtext>"
  Sucht in Fakten, Nachrichten, Wissensbasis und Bildern und gibt JSON aus.`;

/** Suchtext und Limit aus den Argumenten; null bei falscher Eingabe */
export function parseArgs(args: string[]): { query: string; limit?: number } | null {
  const words: string[] = [];
  let limit: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--limit") {
      limit = Number(args[++i]);
      if (!Number.isFinite(limit)) return null;
    } else if (args[i].startsWith("--")) {
      return null;
    } else {
      words.push(args[i]);
    }
  }
  const query = words.join(" ").trim();
  return query ? { query, ...(limit === undefined ? {} : { limit }) } : null;
}

export interface LookupDeps {
  search(args: Record<string, unknown>): Promise<string>;
  print(text: string): void;
  printError(text: string): void;
}

/** Führt die Suche aus und liefert den Exit-Code; Fehlertexte nennen nur die Art, keine Inhalte */
export async function runLookup(args: string[], deps: LookupDeps): Promise<number> {
  const parsed = parseArgs(args);
  if (!parsed) {
    deps.printError(USAGE);
    return EXIT_USAGE;
  }
  let raw: string;
  try {
    raw = await deps.search(parsed);
  } catch (e) {
    deps.printError(`Suche gescheitert (${e instanceof Error ? e.name : "Fehler"})`);
    return EXIT_FAILED;
  }
  deps.print(raw);
  const result = JSON.parse(raw) as { unavailable?: string[]; hint?: string };
  return result.unavailable?.length && result.hint ? EXIT_FAILED : EXIT_OK;
}

if (import.meta.main) {
  await loadEnv();
  const code = await runLookup(process.argv.slice(2), {
    search: createHistorySearchHandler(),
    print: text => console.log(text),
    printError: text => console.error(text),
  });
  process.exit(code);
}
