/**
 * Gedächtnis-Kontext für den Prompt (Issue #311): Fakten und Ziele aus
 * einem MemoryStore als Markdown-Abschnitt, dazu das Delta für fortgesetzte
 * Sessions.
 *
 * Ziele kommen immer vollständig hinein. Fakten belasten ein Budget
 * (MEMORY_CONTEXT_CHARS, Standard 6000 Zeichen, beim Aufruf gelesen); liegen
 * sie darüber, entscheidet die Reihenfolge, welche hineinkommen: mit
 * Suchtext erst nach Bedeutung (Vektoren aus store.factVectors), sonst nach
 * gemeinsamen Wörtern, ohne Suchtext wie gespeichert (neueste zuerst).
 * Mindestens zehn Fakten kommen immer hinein. Ohne Suchtext oder unter dem
 * Budget fragt nichts beim Embedding-Anbieter an.
 *
 * Überschriften, Listenform und die Hinweiszeile sind Teil des Prompts und
 * bleiben im Wortlaut.
 */
import { embedWithConfig, type ConfiguredEmbedding } from "../embedding";
import { EMBEDDING_TEXT_LIMIT } from "../store/supabase/memory";
import type { MemoryStore } from "../store/ports";
import type { MemoryItem } from "../store/types";

const STANDARD_BUDGET = 6000;
/** So viele Fakten stehen immer drin, auch über dem Budget */
const GUARANTEED_FACTS = 10;
/** Zeichen, die jeder Fakt zusätzlich zu seinem Text kostet */
const PER_FACT_OVERHEAD = 3;
/** Kürzere Wörter zählen beim Vergleich nicht */
const MIN_WORD_LENGTH = 4;

/**
 * Zeichenbudget der Fakten aus MEMORY_CONTEXT_CHARS, ohne Angabe der
 * Standard. Ein unlesbarer Wert ergibt NaN wie bisher: dann wird nie gekürzt.
 */
export function factCharBudget(env: Record<string, string | undefined> = process.env): number {
  return parseInt(env.MEMORY_CONTEXT_CHARS || String(STANDARD_BUDGET), 10);
}

const costOf = (fact: MemoryItem) => fact.content.length + PER_FACT_OVERHEAD;

/** Wörter eines Textes in Kleinschrift, ohne Satzzeichen, nur ab MIN_WORD_LENGTH Zeichen */
function significantWords(text: string): string[] {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/);
  return words.filter(word => word.length >= MIN_WORD_LENGTH);
}

/**
 * Nach gemeinsamen Wörtern mit der Nachricht: je Fakt zählt jedes Vorkommen
 * eines Nachrichtenworts. Gleichstand behält die gespeicherte Reihenfolge
 * (neuere zuerst). Ohne verwertbares Wort bleibt alles, wie es ist.
 */
export function orderByWords(facts: MemoryItem[], message: string): MemoryItem[] {
  const wanted = new Set(significantWords(message));
  if (wanted.size === 0) return facts;
  const hits = new Map<MemoryItem, number>();
  for (const fact of facts) hits.set(fact, significantWords(fact.content).filter(word => wanted.has(word)).length);
  return [...facts].sort((a, b) => hits.get(b)! - hits.get(a)!);
}

function cosine(a: number[], b: number[]): number {
  let product = 0;
  let lengthA = 0;
  let lengthB = 0;
  a.forEach((value, i) => {
    product += value * b[i];
    lengthA += value * value;
    lengthB += b[i] * b[i];
  });
  const scale = Math.sqrt(lengthA * lengthB);
  return scale === 0 ? 0 : product / scale;
}

/**
 * Nach Ähnlichkeit zum Suchvektor: Fakten mit Vektor gleicher Länge vorn,
 * ähnlichste zuerst; die übrigen danach in gespeicherter Reihenfolge.
 */
export function orderByVector(
  facts: MemoryItem[],
  query: number[],
  vectorOf: (fact: MemoryItem) => number[] | null | undefined,
): MemoryItem[] {
  const scored: { fact: MemoryItem; similarity: number }[] = [];
  const unscored: MemoryItem[] = [];
  for (const fact of facts) {
    const vector = vectorOf(fact);
    if (vector && vector.length === query.length) scored.push({ fact, similarity: cosine(vector, query) });
    else unscored.push(fact);
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.map(entry => entry.fact).concat(unscored);
}

/** Fakten in Reihenfolge nehmen, bis das Budget erschöpft ist, aber mindestens GUARANTEED_FACTS */
function takeWithinBudget(ordered: MemoryItem[], budget: number): MemoryItem[] {
  const taken: MemoryItem[] = [];
  let spent = 0;
  for (const fact of ordered) {
    const overBudget = spent + costOf(fact) > budget;
    if (overBudget && taken.length >= GUARANTEED_FACTS) break;
    taken.push(fact);
    spent += costOf(fact);
  }
  return taken;
}

export function goalLine(goal: MemoryItem, position: number): string {
  const due = goal.deadline ? " (due: " + new Date(goal.deadline).toLocaleDateString() + ")" : "";
  return `${position}. ${goal.content}${due}`;
}

/** Brauchen die Fakten mehr Zeichen als das Budget? Nur dann zählt ihre Reihenfolge */
export function exceedsBudget(facts: MemoryItem[], budget: number): boolean {
  return facts.reduce((sum, fact) => sum + costOf(fact), 0) > budget;
}

/**
 * Setzt den Kontext zusammen. ordered sind dieselben Fakten in der
 * Reihenfolge, nach der über dem Budget ausgewählt wird; unter dem Budget
 * stehen alle Fakten wie in facts.
 */
export function composeMemoryContext(
  facts: MemoryItem[],
  goals: MemoryItem[],
  ordered: MemoryItem[] = facts,
  budget: number = factCharBudget(),
): string {
  const parts: string[] = [];
  if (facts.length > 0) {
    const trimmed = exceedsBudget(facts, budget);
    const shown = trimmed ? takeWithinBudget(ordered, budget) : facts;
    const lines = ["**Known Facts:**", ...shown.map(fact => "- " + fact.content)];
    if (trimmed) lines.push(`_(${shown.length} of ${facts.length} facts shown — most relevant to the current message)_`);
    parts.push(lines.join("\n"));
  }
  if (goals.length > 0) {
    parts.push(["**Active Goals:**", ...goals.map((goal, i) => goalLine(goal, i + 1))].join("\n"));
  }
  return parts.join("\n\n");
}

export interface MemoryContextDeps {
  /** Suchvektor zur Nachricht; null: keiner möglich */
  embed?: (text: string) => Promise<ConfiguredEmbedding | null>;
  budget?: number;
}

/** Nach Bedeutung, wenn ein Suchvektor entsteht und der Store passende Vektoren hat, sonst nach Wörtern */
async function orderByRelevance(
  store: MemoryStore,
  facts: MemoryItem[],
  message: string,
  embed: (text: string) => Promise<ConfiguredEmbedding | null>,
): Promise<MemoryItem[]> {
  const query = await embed(message.slice(0, EMBEDDING_TEXT_LIMIT));
  const vectors = query ? await store.factVectors(query) : null;
  return query && vectors ? orderByVector(facts, query.vector, fact => vectors.get(String(fact.id))) : orderByWords(facts, message);
}

/** Gedächtnis-Kontext aus dem Store, bei Suchtext über dem Budget nach Relevanz ausgewählt */
export async function memoryContext(store: MemoryStore, userMessage?: string, deps: MemoryContextDeps = {}): Promise<string> {
  const [facts, goals] = await Promise.all([store.facts(), store.activeGoals()]);
  const budget = deps.budget ?? factCharBudget();
  const embed = deps.embed ?? (text => embedWithConfig(text));
  const ranked = userMessage && exceedsBudget(facts, budget) ? await orderByRelevance(store, facts, userMessage, embed) : facts;
  return composeMemoryContext(facts, goals, ranked, budget);
}

/** Zeile im Delta: Art in eckigen Klammern, bei Zielen die Frist wie gespeichert */
function deltaLine(item: MemoryItem): string {
  if (item.type === "fact") return "- [fact] " + item.content;
  return "- [goal] " + item.content + (item.deadline ? ` (due: ${item.deadline})` : "");
}

/** Delta für Resume-Prompts: eine Zeile je Fakt bzw. Ziel aus changedSince */
export function memoryDelta(items: MemoryItem[]): string {
  return items.map(deltaLine).join("\n");
}
