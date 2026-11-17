/**
 * Fakten nach gemeinsamen Wörtern ordnen (Issue #523), für beide Adapter: die
 * Textsuche des Nachschlagens und der Rückfall der Folgenachricht, wenn kein
 * Vektor da ist. Fragt keinen Anbieter.
 */
import { knowledgeTerms, mentions } from "./knowledge-terms";
import type { MemoryItem } from "./types";

/** Kürzere Wörter zählen nicht */
const MIN_TERM_LENGTH = 4;
/** Mehr Wörter einer Nachricht werden nicht verglichen */
const MAX_TERMS = 12;

/** Häufige Wörter sagen nichts über das Thema; sonst passte fast jeder Fakt */
const STOP_WORDS = new Set(
  "aber alle also auch bist dann dass dein deine denn dich dies diese dieser dieses doch dort durch eine einem einen einer eines etwas euch habe haben hast hatte heute hier ihre immer jetzt kann kannst mein meine meinem meinen meiner mich mir muss nach nicht noch oder schon sein seine sich sind sollte über unser unsere viel waren warum weil wenn werde werden wieder wird wurde about also been come could from have just like make only some than that their them then there these they this what when where which will with would your"
    .split(" "),
);

/** Wörter eines Suchtextes, die etwas über das Thema sagen */
export function factTerms(text: string): string[] {
  return knowledgeTerms(text, { minLength: MIN_TERM_LENGTH, max: MAX_TERMS }).filter(term => !STOP_WORDS.has(term.toLocaleLowerCase()));
}

/**
 * Fakten, die mindestens minTerms der Wörter enthalten (bei weniger Wörtern alle),
 * meiste Wörter zuerst. Gleichstand behält die Reihenfolge von facts.
 */
export function rankFactsByTerms(facts: MemoryItem[], terms: string[], limit: number, minTerms = 1): MemoryItem[] {
  if (terms.length === 0) return [];
  const needed = Math.max(1, Math.min(minTerms, terms.length));
  return facts
    .map(fact => ({ fact, hits: terms.filter(term => mentions({ content: fact.content }, term)).length }))
    .filter(entry => entry.hits >= needed)
    .sort((a, b) => b.hits - a.hits)
    .slice(0, limit)
    .map(entry => entry.fact);
}
