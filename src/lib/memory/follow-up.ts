/**
 * Suche für eine Folgenachricht (Issue #523): Treffer in den Nachrichten und
 * passende Fakten aus demselben Suchvektor. Bringt die Suche keine Fakten (kein
 * Vektor, ältere Function, nichts über der Schwelle), kommt die Textsuche über
 * gemeinsame Wörter; auch sie fragt keinen Anbieter. Ein einzelnes Wort reicht
 * ihr nicht, sonst stünde bei jeder Nachricht etwas Unpassendes im Prompt.
 */
import { storeOr } from "../store";
import type { FactWish, HitsWithFacts, MemoryItem } from "../store/types";

/** So viele gemeinsame Wörter braucht ein Fakt ohne Vektor (bei kürzeren Nachrichten alle) */
const MIN_SHARED_WORDS = 2;

export async function followUpSearch(chatId: string, query: string, limit: number, facts: FactWish): Promise<HitsWithFacts> {
  const nothing: HitsWithFacts = { messages: [], facts: null };
  const found = await storeOr(nothing, store => store.messages.searchWithFacts(chatId, query, limit, facts)).catch(() => nothing);
  if (found.facts?.length) return found;
  const byWords = await storeOr<MemoryItem[]>([], store =>
    store.memory.searchFacts(query, facts.limit, { excludeIds: facts.excludeIds, minTerms: MIN_SHARED_WORDS }),
  ).catch(() => []);
  return { messages: found.messages, facts: byWords };
}
