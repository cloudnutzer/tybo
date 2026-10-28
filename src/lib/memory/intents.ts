/**
 * Merk-Tags aus einer Modellantwort lesen (Issue #316). Reiner Parser: kein
 * Speicher, keine Uhr, keine Umgebung. Was mit den Absichten geschieht,
 * entscheidet der Dienst (service.ts).
 *
 * Form eines Tags: `[NAME: Inhalt]`. Der Name ist unabhängig von Groß- und
 * Kleinschreibung, der Inhalt reicht bis zur ersten schließenden Klammer
 * (auch über Zeilen) und wird am Rand von Leerraum befreit. Weitere Angaben
 * folgen nach einem `|` als `FELD: Wert`, etwa `[GOAL: Text | DEADLINE: morgen]`.
 *
 * Die Tag-Namen sind Schnittstelle zu Modell und Prompts und bleiben im
 * Wortlaut.
 *
 * REMIND (#322) hat feste Stellen: `[REMIND: wann | Text]`. Die Zeit bleibt
 * hier Text; lesen und anlegen tut der Dienst (schedule/remind.ts). Fehlt
 * die Zeit oder der Text: keine Erinnerung.
 *
 * KNOWLEDGE (#317) hat feste Stellen statt Angaben:
 * `[KNOWLEDGE: Kategorie | Titel | Inhalt | Projekt]`, das Projekt darf
 * fehlen. Unbekannte Kategorie, leerer Titel oder Inhalt: kein Eintrag.
 */
import { isKnowledgeCategory } from "../knowledge-categories";
import type { KnowledgeCategory } from "../store/types";

/** Tags, die das Gedächtnis auswertet */
export const MEMORY_TAG_NAMES = ["REMEMBER", "GOAL", "DONE", "CANCEL", "FORGET", "KNOWLEDGE", "REMIND"] as const;

export type TagName = (typeof MEMORY_TAG_NAMES)[number];

/**
 * Kürzester Suchtext für DONE und CANCEL: kürzere treffen zu leicht ein
 * falsches Ziel. FORGET kennt keine Grenze.
 */
export const MIN_GOAL_QUERY_LENGTH = 5;

/** Ein gefundenes Tag: Name wie angefragt, Inhalt getrimmt, Stelle im Text */
export interface RawTag {
  name: TagName;
  body: string;
  index: number;
}

/** Inhalt eines Tags, aufgeteilt am ersten `|` */
export interface TagParts {
  /** Vor dem ersten `|` */
  head: string;
  /** Angaben danach als FELD (groß geschrieben) und Wert; fehlt das `|`, null */
  field: { name: string; value: string } | null;
  /** Nach dem `|` steht etwas, das keine Angabe `FELD: Wert` ist */
  malformed: boolean;
}

/** Eine Absicht aus der Antwort, in der Sprache des Gedächtnisses */
export type MemoryIntent =
  | { type: "fact"; text: string }
  | { type: "goal"; text: string; deadline?: string }
  | { type: "done"; query: string }
  | { type: "cancel"; query: string }
  | { type: "forget"; query: string }
  | { type: "knowledge"; category: KnowledgeCategory; title: string; content: string; project?: string }
  | { type: "remind"; when: string; text: string };

/** Alle Vorkommen eines Tags in Textreihenfolge; leere Inhalte zählen nicht */
export function readTags(text: string, name: TagName): RawTag[] {
  const pattern = new RegExp(`\\[${name}:([^\\]]*)\\]`, "gi");
  const found: RawTag[] = [];
  for (const match of text.matchAll(pattern)) {
    const body = match[1].trim();
    if (body) found.push({ name, body, index: match.index ?? 0 });
  }
  return found;
}

const FIELD = /^([A-Za-z]+):\s*([\s\S]*)$/;

/**
 * Teilt einen Inhalt am ersten `|`: davor der Text, danach höchstens eine
 * Angabe `FELD: Wert`. Der Wert darf selbst `|` enthalten.
 */
export function tagParts(body: string): TagParts {
  const cut = body.indexOf("|");
  if (cut < 0) return { head: body.trim(), field: null, malformed: false };
  const head = body.slice(0, cut).trim();
  const named = FIELD.exec(body.slice(cut + 1).trim());
  if (!named) return { head, field: null, malformed: true };
  return { head, field: { name: named[1].toUpperCase(), value: named[2].trim() }, malformed: false };
}

/** Ziel aus einem GOAL-Inhalt; null, wenn die Angabe nach `|` keine Frist ist oder der Text fehlt */
function goalOf(body: string): Extract<MemoryIntent, { type: "goal" }> | null {
  const parts = tagParts(body);
  if (!parts.head || parts.malformed) return null;
  if (!parts.field) return { type: "goal", text: parts.head };
  if (parts.field.name !== "DEADLINE") return null;
  return parts.field.value ? { type: "goal", text: parts.head, deadline: parts.field.value } : { type: "goal", text: parts.head };
}

/** Wissenseintrag aus einem KNOWLEDGE-Inhalt; null, wenn eine Pflichtstelle fehlt */
function knowledgeOf(body: string): Extract<MemoryIntent, { type: "knowledge" }> | null {
  const [rawCategory, rawTitle, rawContent, ...rest] = body.split("|").map(part => part.trim());
  const category = (rawCategory ?? "").toLowerCase();
  if (!isKnowledgeCategory(category) || !rawTitle || !rawContent) return null;
  const project = rest.join("|").trim();
  return project ? { type: "knowledge", category, title: rawTitle, content: rawContent, project } : { type: "knowledge", category, title: rawTitle, content: rawContent };
}

/** Inhalt eines REMIND-Tags: vor dem ersten `|` die Zeit, danach der Text (darf `|` enthalten); null, wenn eins fehlt */
export function remindParts(body: string): { when: string; text: string } | null {
  const cut = body.indexOf("|");
  if (cut < 0) return null;
  const when = body.slice(0, cut).trim();
  const text = body.slice(cut + 1).trim();
  return when && text ? { when, text } : null;
}

/** Erinnerung aus einem REMIND-Inhalt; null, wenn Zeit oder Text fehlt */
function remindOf(body: string): Extract<MemoryIntent, { type: "remind" }> | null {
  const parts = remindParts(body);
  return parts ? { type: "remind", ...parts } : null;
}

/**
 * Alle Absichten einer Antwort in der Reihenfolge, in der der Dienst sie
 * anwendet: erst Ziele mit Frist, dann Ziele ohne, dann DONE, REMEMBER,
 * FORGET, CANCEL, KNOWLEDGE und zuletzt REMIND. So trifft ein DONE auch ein Ziel, das dieselbe Antwort
 * erst anlegt, und ein FORGET einen Fakt aus derselben Antwort. Innerhalb
 * einer Art gilt die Textreihenfolge.
 */
export function parseMemoryIntents(text: string): MemoryIntent[] {
  const goals = readTags(text, "GOAL")
    .map(tag => goalOf(tag.body))
    .filter((goal): goal is Extract<MemoryIntent, { type: "goal" }> => goal !== null);
  const queries = (name: TagName) => readTags(text, name).map(tag => tag.body);
  return [
    ...goals.filter(goal => goal.deadline !== undefined),
    ...goals.filter(goal => goal.deadline === undefined),
    ...queries("DONE").map(query => ({ type: "done" as const, query })),
    ...queries("REMEMBER").map(text => ({ type: "fact" as const, text })),
    ...queries("FORGET").map(query => ({ type: "forget" as const, query })),
    ...queries("CANCEL").map(query => ({ type: "cancel" as const, query })),
    ...queries("KNOWLEDGE")
      .map(knowledgeOf)
      .filter((entry): entry is Extract<MemoryIntent, { type: "knowledge" }> => entry !== null),
    ...readTags(text, "REMIND")
      .map(tag => remindOf(tag.body))
      .filter((entry): entry is Extract<MemoryIntent, { type: "remind" }> => entry !== null),
  ];
}

/** DONE oder CANCEL mit zu kurzem Suchtext: wird nicht angewendet */
export function isVague(intent: MemoryIntent): boolean {
  return (intent.type === "done" || intent.type === "cancel") && intent.query.length < MIN_GOAL_QUERY_LENGTH;
}
