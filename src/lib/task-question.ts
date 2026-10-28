/**
 * Rückfrage am Ende einer Antwort erkennen und als Knöpfe anbieten. Genutzt
 * von Aufträgen aus Anrufen (src/lib/phone/task-turn.ts): Erkennt die
 * Antwort eine Rückfrage mit Optionen, wartet der Auftrag in async_tasks
 * (needs_input), und die Knöpfe laufen über den atask-Weg
 * (src/lib/legacy-task-buttons.ts). Tests: tests/task-question.test.ts.
 *
 * Die Erkennung ist eine Schätzung am Text, kein Werkzeugaufruf:
 * - Die letzte nicht leere Zeile endet auf „?“, und
 * - es gibt mindestens zwei nummerierte Punkte („1. …“) oder eine der
 *   englischen Auswahl-Wendungen in ASKING_PHRASES.
 * Ohne Punkte, aber mit Ja/Nein-Frage in der letzten Zeile gibt es zwei
 * feste Knöpfe. Nummerierte Punkte stehen immer in options, auch ohne
 * Rückfrage; entscheidend ist needsInput.
 */

import { InlineKeyboard } from "grammy";

export interface TaskOption {
  /** Beschriftung des Knopfs */
  readonly label: string;
  /** Teil der Knopfdaten atask:<auftrag>:<value> */
  readonly value: string;
}

export interface TaskQuestion {
  /** Antwort ohne Leerraum am Rand */
  readonly text: string;
  /** Die Antwort wartet auf eine Auswahl des Nutzers */
  readonly needsInput: boolean;
  /** Letzte Zeile, wenn needsInput, sonst null */
  readonly question: string | null;
  /** Höchstens MAX_OPTIONS Knöpfe */
  readonly options: TaskOption[];
}

const MAX_OPTIONS = 6;
const MAX_LABEL = 64;
/** „1. Text“ am Zeilenanfang, Leerraum davor erlaubt */
const NUMBERED_ITEM = /(?:^|\n)\s*(\d+)\.\s+(.+)/g;

/** Wendungen, mit denen das Modell eine Auswahl anbietet; geprüft am klein geschriebenen Text */
const ASKING_PHRASES = [
  ["which would you prefer", "which do you prefer", "what would you like", "which should i", "which option"],
  ["please choose", "please select", "would you like me to", "should i", "do you want me to"],
  ["what do you think", "your preference", "your choice"],
].flat();

/** Ja/Nein-Fragen in der letzten Zeile */
const YES_NO_QUESTION = /should i|would you like me to|do you want me to|shall i|can i proceed|go ahead/i;

const YES_NO_OPTIONS: readonly TaskOption[] = [{ label: "Yes, go ahead", value: "yes" }, { label: "No, skip", value: "no" }];

function numberedItems(text: string): TaskOption[] {
  return [...text.matchAll(NUMBERED_ITEM)].map(([, number, rest]) => ({
    label: `${number}. ${rest.trim().slice(0, MAX_LABEL)}`,
    value: number,
  }));
}

function lastFilledLine(text: string): string {
  const filled = text.split("\n").filter(line => line.trim() !== "");
  return filled.length > 0 ? filled[filled.length - 1].trim() : "";
}

/** Rückfrage und Optionen aus der Antwort des Modells */
export function detectTaskQuestion(output: string): TaskQuestion {
  const text = output.trim();
  if (text === "") return { text, needsInput: false, question: null, options: [] };

  const items = numberedItems(text);
  const closing = lastFilledLine(text);
  const lower = text.toLowerCase();
  const offersChoice = items.length >= 2 || ASKING_PHRASES.some(phrase => lower.includes(phrase));
  const needsInput = closing.endsWith("?") && offersChoice;

  let options = items;
  if (needsInput && items.length === 0 && YES_NO_QUESTION.test(closing)) options = [...YES_NO_OPTIONS];
  return { text, needsInput, question: needsInput ? closing : null, options: options.slice(0, MAX_OPTIONS) };
}

/** Knöpfe zum Auftrag: je Option eine Zeile, zuletzt immer Abbrechen */
export function taskQuestionKeyboard(taskId: string, options: TaskOption[]): InlineKeyboard {
  const rows = options.map(option => [InlineKeyboard.text(option.label, `atask:${taskId}:${option.value}`)]);
  rows.push([InlineKeyboard.text("Cancel task", `atask:${taskId}:cancel`)]);
  return InlineKeyboard.from(rows);
}
