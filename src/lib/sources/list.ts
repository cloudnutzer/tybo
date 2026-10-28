/**
 * Die Quellen von tybo, ausdrücklich aufgezählt (Issue #354): keine
 * Selbsteintragung beim Import. Die Reihenfolge ist die der Abschnitte.
 * Eigene Quelle: Vorlage example.ts kopieren, dann hier eintragen.
 */
import { calendarSource } from "./calendar";
import { gmailSource } from "./gmail";
import { goalsSource } from "./goals";
import { newsSource } from "./news";
import { notionSource } from "./notion";
import { isReady } from "./run";
import type { Env, Source } from "./types";

export const SOURCES: readonly Source[] = checkedList([calendarSource, gmailSource, notionSource, newsSource, goalsSource()]);

/** Kennungen müssen eindeutig sein; wirft bei einer doppelten */
export function checkedList(list: readonly Source[]): readonly Source[] {
  const seen = new Set<string>();
  for (const source of list) {
    if (seen.has(source.id)) throw new Error(`Quelle doppelt in der Liste: ${source.id}`);
    seen.add(source.id);
  }
  return list;
}

/** Die bereiten Quellen der Liste, Reihenfolge bleibt */
export function readySources(list: readonly Source[], env: Env = process.env): Source[] {
  return list.filter(source => isReady(source, env));
}
