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
 *
 * Jeder Fakt trägt sein Anlagedatum (Issue #519), das Budget zählt es mit.
 * Das Datum sagt nur, wann der Fakt angelegt wurde, nicht, dass er noch
 * stimmt; das steht im Vorbehalt über den Fakten (FACT_DATE_NOTE). Jeder
 * Eintrag ist genau eine Zeile, darauf baut fitMemoryContext.
 *
 * Geheimnisse (Issue #524): Hier laufen Start, Delta, Nachladen (factLine) und
 * der Sprachkontext zusammen. Maskiert wird vor dem Zusammenführen der Zeilen und
 * vor jedem Kürzen, sonst bliebe ein mehrzeiliger privater Schlüssel unerkannt. Der
 * Speicher behält den Originaltext; was eine laufende Session schon geladen hat,
 * lässt sich nicht zurückholen.
 */
import { promptTimeZone } from "../../agents/prompt-parts";
import { embedWithConfig, type ConfiguredEmbedding } from "../embedding";
import { EMBEDDING_TEXT_LIMIT } from "../store/supabase/memory";
import type { MemoryStore } from "../store/ports";
import type { MemoryItem } from "../store/types";
import { maskSecrets } from "./secrets";

const STANDARD_BUDGET = 6000;
/** So viele Fakten stehen immer drin, auch über dem Budget */
const GUARANTEED_FACTS = 10;
/** Kürzere Wörter zählen beim Vergleich nicht */
const MIN_WORD_LENGTH = 4;

/** Steht statt des Datums, wenn created_at fehlt oder unlesbar ist; nie das heutige Datum */
export const UNKNOWN_FACT_DATE = "Anlagedatum unbekannt";
/** Vorbehalt über den Fakten; ohne Fakten fehlt er */
export const FACT_DATE_NOTE =
  "_Das Datum vor einem Fakt ist sein Anlagedatum, keine Bestätigung der Aktualität: Ältere Stände können überholt sein, bei Zahlen, Status und Versionen im Zweifel prüfen._";
/** Beginn der Hinweiszeile zu gekürzten Fakten */
const TRIM_NOTE_START = "_(";

const dayFormats = new Map<string, Intl.DateTimeFormat>();

/** Formatierer für YYYY-MM-DD; eine ungültige Zone ergibt UTC wie bei formatPromptTime */
function dayFormat(timeZone: string): Intl.DateTimeFormat {
  let format = dayFormats.get(timeZone);
  if (!format) {
    const options = { year: "numeric", month: "2-digit", day: "2-digit" } as const;
    try {
      format = new Intl.DateTimeFormat("en-CA", { ...options, timeZone });
    } catch {
      format = new Intl.DateTimeFormat("en-CA", { ...options, timeZone: "UTC" });
    }
    dayFormats.set(timeZone, format);
  }
  return format;
}

/**
 * Anlagedatum als YYYY-MM-DD in der Zeitzone des Prompts. Nur Zeitpunkte, die
 * mit einem Datum beginnen, gelten: Date.parse läse sonst auch beliebige Texte.
 * Der Kalendertag wird vorher geprüft, Date machte aus dem 30.2. still den 2.3.
 */
export function factDate(createdAt: string | null | undefined, timeZone: string = promptTimeZone()): string {
  if (typeof createdAt !== "string") return UNKNOWN_FACT_DATE;
  const start = /^(\d{4})-(\d{2})-(\d{2})/.exec(createdAt);
  if (!start) return UNKNOWN_FACT_DATE;
  const [year, month, day] = start.slice(1).map(Number);
  const calendarDay = new Date(Date.UTC(year, month - 1, day));
  if (calendarDay.getUTCMonth() !== month - 1 || calendarDay.getUTCDate() !== day) return UNKNOWN_FACT_DATE;
  const at = new Date(createdAt);
  return Number.isNaN(at.getTime()) ? UNKNOWN_FACT_DATE : dayFormat(timeZone).format(at);
}

/** Text eines Eintrags auf einer Zeile und ohne Geheimnisse, damit Kürzen nie mitten im Eintrag trennt */
const oneLine = (text: string) => maskSecrets(text).replace(/\s*[\r\n]+\s*/g, " ");

/**
 * Zeichenbudget der Fakten aus MEMORY_CONTEXT_CHARS, ohne Angabe der
 * Standard. Ein unlesbarer Wert ergibt NaN wie bisher: dann wird nie gekürzt.
 */
export function factCharBudget(env: Record<string, string | undefined> = process.env): number {
  return parseInt(env.MEMORY_CONTEXT_CHARS || String(STANDARD_BUDGET), 10);
}

/** Datum und Text eines Fakts, gleich im Kontext und im Delta */
const datedFact = (fact: MemoryItem) => `[${factDate(fact.created_at)}] ${oneLine(fact.content)}`;

export const factLine = (fact: MemoryItem) => "- " + datedFact(fact);

/** Zeichen, die ein Fakt im Prompt belegt: seine Zeile samt Zeilenumbruch */
const costOf = (fact: MemoryItem) => factLine(fact).length + 1;

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
  return `${position}. ${maskSecrets(goal.content)}${due}`;
}

/** Zielzeile im Prompt: genau eine Zeile; /goals zeigt das Ziel weiter wie gespeichert */
const promptGoalLine = (goal: MemoryItem, position: number) => goalLine({ ...goal, content: oneLine(goal.content) }, position);

/** Brauchen die Fakten mehr Zeichen als das Budget? Nur dann zählt ihre Reihenfolge */
export function exceedsBudget(facts: MemoryItem[], budget: number): boolean {
  return facts.reduce((sum, fact) => sum + costOf(fact), 0) > budget;
}

/** Kontext für den Prompt und die Fakten, die er zeigt (Issue #523) */
export interface MemorySelection {
  context: string;
  factIds: string[];
}

/** Kennungen der Fakten unter diesen Einträgen; ohne Kennung zählt ein Fakt nicht */
export function factIdsOf(items: MemoryItem[]): string[] {
  return items.filter(item => item.type !== "goal" && item.id !== undefined && item.id !== null).map(item => String(item.id));
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
  return composeMemorySelection(facts, goals, ordered, budget).context;
}

function composeMemorySelection(facts: MemoryItem[], goals: MemoryItem[], ordered: MemoryItem[], budget: number): MemorySelection {
  const parts: string[] = [];
  let factIds: string[] = [];
  if (facts.length > 0) {
    const trimmed = exceedsBudget(facts, budget);
    const shown = trimmed ? takeWithinBudget(ordered, budget) : facts;
    factIds = factIdsOf(shown);
    const lines = ["**Known Facts:**", FACT_DATE_NOTE, ...shown.map(factLine)];
    if (trimmed) lines.push(`_(${shown.length} of ${facts.length} facts shown — most relevant to the current message)_`);
    parts.push(lines.join("\n"));
  }
  if (goals.length > 0) {
    parts.push(["**Active Goals:**", ...goals.map((goal, i) => promptGoalLine(goal, i + 1))].join("\n"));
  }
  return { context: parts.join("\n\n"), factIds };
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
  return (await memorySelection(store, userMessage, deps)).context;
}

/** Wie memoryContext, nennt dazu die gezeigten Fakten */
export async function memorySelection(store: MemoryStore, userMessage?: string, deps: MemoryContextDeps = {}): Promise<MemorySelection> {
  const [facts, goals] = await Promise.all([store.facts(), store.activeGoals()]);
  const budget = deps.budget ?? factCharBudget();
  const embed = deps.embed ?? (text => embedWithConfig(text));
  const ranked = userMessage && exceedsBudget(facts, budget) ? await orderByRelevance(store, facts, userMessage, embed) : facts;
  return composeMemorySelection(facts, goals, ranked, budget);
}

/** Zeile im Delta: Art in eckigen Klammern, bei Fakten das Datum, bei Zielen die Frist wie gespeichert */
function deltaLine(item: MemoryItem): string {
  if (item.type === "fact") return "- [fact] " + datedFact(item);
  return "- [goal] " + oneLine(item.content) + (item.deadline ? ` (due: ${item.deadline})` : "");
}

/** Delta für Resume-Prompts: eine Zeile je Fakt bzw. Ziel aus changedSince, bei Fakten mit Vorbehalt davor */
export function memoryDelta(items: MemoryItem[]): string {
  const note = items.some(item => item.type === "fact") ? [FACT_DATE_NOTE] : [];
  return [...note, ...items.map(deltaLine)].join("\n");
}

/** Delta samt den Fakten, die es zeigt */
export function memoryDeltaSelection(items: MemoryItem[]): MemorySelection {
  return { context: memoryDelta(items), factIds: factIdsOf(items) };
}

/**
 * Kürzt einen fertigen Kontext auf maxChars, ohne einen Eintrag zu zerschneiden:
 * Einträge, die nicht mehr passen, fallen ganz weg, Überschrift und Vorbehalt
 * bleiben, solange von ihrem Abschnitt ein Eintrag bleibt. Die Hinweiszeile
 * fällt beim Kürzen weg, ihre Zahlen stimmten dann nicht mehr.
 */
export function fitMemoryContext(context: string, maxChars: number): string {
  if (context.length <= maxChars) return context;
  const kept: string[] = [];
  let spent = 0;
  for (const section of context.split("\n\n")) {
    const lines = section.split("\n");
    const head = lines.filter(line => line.startsWith("**") || line === FACT_DATE_NOTE);
    const entries = lines.filter(line => !head.includes(line) && !line.startsWith(TRIM_NOTE_START));
    const breakCost = kept.length > 0 ? 2 : 0;
    let size = spent + breakCost + head.join("\n").length;
    const fitting: string[] = [];
    for (const entry of entries) {
      const next = size + 1 + entry.length;
      if (next > maxChars) continue;
      fitting.push(entry);
      size = next;
    }
    if (fitting.length === 0) continue;
    kept.push([...head, ...fitting].join("\n"));
    spent = size;
  }
  return kept.join("\n\n");
}
