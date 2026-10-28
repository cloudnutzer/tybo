/**
 * Leser für die stream-json-Ausgabe der Claude-CLI (Issue #326).
 *
 * Reine Auswertung ohne Prozess, Uhr, Log oder Rückrufe: Zeilen bzw.
 * Ereignisse gehen hinein, Fortschritts-Signale und am Ende das Ergebnis
 * kommen heraus. Den Zeitpunkt jeder Zeile liefert der Aufrufer, ebenso führt
 * er die Signale aus (Fortschritt anzeigen, Kosten buchen). Der Zustand eines
 * Laufs ist ein StreamReading; jedes Ereignis ergibt einen neuen Zustand, der
 * alte bleibt unverändert.
 *
 * Fertiger Text eines Turns: Ein assistant-Ereignis trägt je Inhaltsblock
 * eine Nachricht; alle Blöcke eines API-Turns haben dieselbe message.id. Ein
 * Turn mit Text und ohne tool_use beendet die Schleife der CLI. Folgt ein
 * zweiter solcher Turn, hat ein Stop-Hook Claude weiterarbeiten lassen; das
 * result-Ereignis enthält dann nur den letzten Text. Damit die eigentliche
 * Antwort nicht verloren geht, verbindet finishStreamReading alle diese Turns
 * (Befund vom 9.9.2026, Hook ohne TYBO_SUBPROCESS-Prüfung). Ereignisse ohne
 * message.id ordnet turnKey wie bisher zu.
 */

import { toolUsesFromEvent, type ToolUse } from "../turn-tools";
import type { CliErrorSignal } from "./result";

/** So viele Werkzeugschritte bleiben für den Bericht beim Zeitlimit */
export const MAX_RUN_STEPS = 8;

/** Mindestabstand zweier Werkzeug-Signale im Fortschritt */
export const TOOL_SIGNAL_GAP_MS = 5_000;

/** Der erste Text zählt als Plan, sobald ein Block länger ist als das */
const FIRST_TEXT_MIN_CHARS = 30;

/** Ein beobachteter Werkzeugaufruf: Name und wichtigste Eingabe (Befehl, Pfad, Adresse) */
export interface RunStep {
  name: string;
  input?: string;
}

/** Eingabefelder, die einen Schritt beschreiben, das erste vorhandene gewinnt */
const STEP_INPUT_FIELDS = ["command", "file_path", "notebook_path", "path", "url", "query", "pattern", "description"];

/** Schritt aus einem tool_use-Block; null ohne Namen. Die Eingabe bleibt ungekürzt. */
export function stepFromToolBlock(block: unknown): RunStep | null {
  if (!isRecord(block) || block.type !== "tool_use") return null;
  const name = block.name;
  if (typeof name !== "string" || name === "") return null;
  const input = isRecord(block.input) ? block.input : {};
  for (const field of STEP_INPUT_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim() !== "") return { name, input: value };
  }
  return { name };
}

/** Zeichen, die in einem regulären Ausdruck nicht unter „." fallen */
const LINE_BREAKS = new Set(["\n", "\r", " ", " "]);
const SENTENCE_END = new Set([".", "!", "?", "\n"]);

/**
 * Kurzfassung eines Textblocks für den Fortschritt: der erste Satz, wenn er
 * zwischen 30 und 150 Zeichen lang ist und keinen Zeilenumbruch vor dem
 * 30. Zeichen hat, sonst die ersten 150 Zeichen.
 */
export function firstTextSnippet(text: string): string {
  const scan = Math.min(text.length, 151);
  for (let i = 0; i < scan; i++) {
    const ch = text[i];
    if (i >= 30 && SENTENCE_END.has(ch)) return text.slice(0, i + 1).trim();
    if (LINE_BREAKS.has(ch)) break;
  }
  return text.substring(0, 150).trim();
}

/** Was der Aufrufer während des Laufs tun soll */
export type StreamSignal =
  /** Ein Werkzeug startet (roher Name der CLI), höchstens alle TOOL_SIGNAL_GAP_MS */
  | { kind: "tool"; name: string }
  /** Erster Textblock über 30 Zeichen, einmal je Lauf */
  | { kind: "firstText"; snippet: string; text: string };

/** Gesammelter Text eines Turns; key ist die message.id bzw. der Ersatz ohne id */
interface TurnText {
  readonly key: unknown;
  readonly text: string;
}

/**
 * Zustand eines Laufs. Er wird nie verändert: readStreamEvent liefert einen
 * neuen Zustand, der alte bleibt gültig und ergibt erneut ausgewertet
 * dasselbe.
 */
export interface StreamReading {
  readonly sessionId?: string;
  /** Inhalt des result-Ereignisses, sobald es da ist */
  readonly result?: { readonly text: string; readonly signal: CliErrorSignal };
  /** Summe der Kosten aller result-Ereignisse (Hook-Folgeturns melden je eins), Issue #346 */
  readonly costUsd?: number;
  /** Letzter Textblock, ungekürzt */
  readonly lastText: string;
  readonly uses: readonly ToolUse[];
  /** Die letzten MAX_RUN_STEPS Schritte */
  readonly steps: readonly RunStep[];
  /** Turns mit Text, in der Reihenfolge ihres ersten Textblocks */
  readonly turnTexts: readonly TurnText[];
  /** Turns mit mindestens einem tool_use-Block */
  readonly toolTurns: readonly unknown[];
  readonly firstTextSeen: boolean;
  readonly lastToolSignalAt?: number;
}

/** Ein Übergang: neuer Zustand und die Signale dazu */
export interface StreamTransition {
  reading: StreamReading;
  signals: StreamSignal[];
}

export function startStreamReading(): StreamReading {
  return { lastText: "", uses: [], steps: [], turnTexts: [], toolTurns: [], firstTextSeen: false };
}

/**
 * Eine Zeile als Ereignis; undefined für leere, kaputte und Zeilen ohne
 * JSON-Objekt. Nur ein Ereignis zählt als Lebenszeichen des Laufs.
 */
export function parseStreamLine(line: string): Record<string, any> | undefined {
  if (line.trim() === "") return undefined;
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ein Ereignis zum Zeitpunkt at einlesen. reading bleibt unverändert;
 * zurück kommen der neue Zustand und die Signale.
 */
export function readStreamEvent(reading: StreamReading, event: Record<string, any>, at: number): StreamTransition {
  switch (event.type) {
    // Teil-Nachrichten (--include-partial-messages) sind nur Lebenszeichen;
    // Text und Werkzeuge kommen aus den vollständigen assistant-Ereignissen
    case "stream_event":
      return { reading, signals: [] };
    case "system":
      if (event.subtype === "init" && event.session_id) return { reading: { ...reading, sessionId: event.session_id }, signals: [] };
      return { reading, signals: [] };
    case "result":
      return readResult(reading, event);
    case "assistant":
      return readAssistant(reading, event, at);
    default:
      return { reading, signals: [] };
  }
}

function readResult(reading: StreamReading, event: Record<string, any>): StreamTransition {
  const next: StreamReading = {
    ...reading,
    result: {
      text: event.result || "",
      signal: { is_error: event.is_error, subtype: event.subtype, api_error_status: event.api_error_status ?? null },
    },
    ...(event.session_id ? { sessionId: event.session_id } : {}),
  };
  if (typeof event.total_cost_usd !== "number") return { reading: next, signals: [] };
  return { reading: { ...next, costUsd: (reading.costUsd ?? 0) + event.total_cost_usd }, signals: [] };
}

function readAssistant(reading: StreamReading, event: Record<string, any>, at: number): StreamTransition {
  const blocks = event.message?.content;
  if (!Array.isArray(blocks)) return { reading, signals: [] };
  const key = turnKey(reading, event.message.id);
  const signals: StreamSignal[] = [];
  let { steps, lastText, firstTextSeen, lastToolSignalAt } = reading;
  let addedText: string | undefined;
  let usesTool = false;
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    if (block.type === "tool_use") {
      usesTool = true;
      const step = stepFromToolBlock(block);
      if (step) steps = keepStep(steps, step);
      if (block.name && toolSignalDue(lastToolSignalAt, at)) {
        lastToolSignalAt = at;
        signals.push({ kind: "tool", name: String(block.name) });
      }
    } else if (block.type === "text" && typeof block.text === "string" && block.text) {
      addedText = (addedText ?? "") + block.text;
      lastText = block.text;
      if (!firstTextSeen && block.text.length > FIRST_TEXT_MIN_CHARS) {
        firstTextSeen = true;
        signals.push({ kind: "firstText", snippet: firstTextSnippet(block.text), text: block.text });
      }
    }
  }
  const next: StreamReading = {
    ...reading,
    uses: [...reading.uses, ...toolUsesFromEvent(event)],
    steps,
    lastText,
    firstTextSeen,
    ...(lastToolSignalAt !== undefined ? { lastToolSignalAt } : {}),
    turnTexts: addedText === undefined ? reading.turnTexts : appendTurnText(reading.turnTexts, key, addedText),
    toolTurns: usesTool && !reading.toolTurns.includes(key) ? [...reading.toolTurns, key] : reading.toolTurns,
  };
  return { reading: next, signals };
}

/**
 * Turn eines Ereignisses: die message.id; ohne id „turn-<n>" mit n gleich
 * der Zahl der Turns, die bis dahin Text hatten. Ein Werkzeug-Ereignis ohne
 * id und der folgende Text ohne id landen so im selben Turn.
 */
function turnKey(reading: StreamReading, id: unknown): unknown {
  return id || `turn-${reading.turnTexts.length}`;
}

function appendTurnText(turns: readonly TurnText[], key: unknown, text: string): TurnText[] {
  const index = turns.findIndex((turn) => turn.key === key);
  if (index === -1) return [...turns, { key, text }];
  return turns.map((turn, i) => (i === index ? { key, text: turn.text + text } : turn));
}

function keepStep(steps: readonly RunStep[], step: RunStep): readonly RunStep[] {
  const next = [...steps, step];
  return next.length > MAX_RUN_STEPS ? next.slice(next.length - MAX_RUN_STEPS) : next;
}

function toolSignalDue(lastAt: number | undefined, at: number): boolean {
  return lastAt === undefined || at - lastAt >= TOOL_SIGNAL_GAP_MS;
}

/** Ergebnis eines Laufs, wie es aus den Ereignissen hervorgeht */
export interface StreamOutcome {
  text: string;
  sessionId?: string;
  /** Fehler-Felder der CLI; ohne result-Ereignis alle leer */
  signal: CliErrorSignal;
  costUsd?: number;
  /** Mehr als ein fertiger Turn: so viele wurden zum Text verbunden */
  joinedTurns?: number;
  uses: ToolUse[];
  steps: RunStep[];
  lastText: string;
}

/**
 * Ergebnis nach dem letzten Ereignis. Ohne result-Ereignis gilt der letzte
 * Textblock. Meldet die CLI keinen Fehler und gab es mehrere fertige Turns,
 * stehen alle im Text, getrennt durch eine Leerzeile.
 */
export function finishStreamReading(reading: StreamReading): StreamOutcome {
  const signal: CliErrorSignal = reading.result?.signal ?? {};
  let text = reading.result?.text || reading.lastText;
  let joinedTurns: number | undefined;
  if (text && !signal.is_error) {
    const finished = finishedTurnTexts(reading);
    if (finished.length > 1) {
      text = finished.join("\n\n");
      joinedTurns = finished.length;
    }
  }
  return {
    text,
    ...(reading.sessionId ? { sessionId: reading.sessionId } : {}),
    signal,
    ...(reading.costUsd !== undefined ? { costUsd: reading.costUsd } : {}),
    ...(joinedTurns ? { joinedTurns } : {}),
    uses: [...reading.uses],
    steps: [...reading.steps],
    lastText: reading.lastText,
  };
}

/** Texte der Turns ohne Werkzeug, getrimmt und nicht leer, in Reihenfolge */
function finishedTurnTexts(reading: StreamReading): string[] {
  const texts: string[] = [];
  for (const turn of reading.turnTexts) {
    const text = turn.text.trim();
    if (!reading.toolTurns.includes(turn.key) && text) texts.push(text);
  }
  return texts;
}

/**
 * Ganzer Lauf in einem Schritt, etwa für Tests: Zeilen mit Zeitpunkt hinein,
 * Signale, Zahl der Lebenszeichen und Ergebnis heraus.
 */
export function readStream(lines: { line: string; at: number }[]): {
  signals: StreamSignal[];
  activeLines: number;
  outcome: StreamOutcome;
} {
  let reading = startStreamReading();
  const signals: StreamSignal[] = [];
  let activeLines = 0;
  for (const { line, at } of lines) {
    const event = parseStreamLine(line);
    if (!event) continue;
    activeLines++;
    const step = readStreamEvent(reading, event, at);
    reading = step.reading;
    signals.push(...step.signals);
  }
  return { signals, activeLines, outcome: finishStreamReading(reading) };
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
