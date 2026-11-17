/**
 * Gedächtnis-Dienst (Issue #316): wendet Merk-Tags an und bietet Fakten und
 * Ziele für Befehle und Prompts. Gespeichert wird über getStore().memory,
 * also Supabase oder ohne Datenbank die Datei (store/file/memory.ts).
 *
 * Merk-Tags: der Parser (intents.ts) liefert die Absichten, hier werden sie
 * der Reihe nach angewendet. Ein Ziel ohne Frist, das dieselbe Antwort schon
 * angelegt hat, kommt nicht ein zweites Mal hinzu. DONE und CANCEL mit
 * weniger als fünf Zeichen sind zu vage und bleiben liegen.
 *
 * DONE, CANCEL und FORGET suchen per Teiltext. Ein Treffer: genau dieser
 * Eintrag wird geändert, per ID. Mehrere Treffer: nichts wird geändert,
 * stattdessen geht eine Rückfrage mit Knöpfen ins Gespräch des Turns (der
 * Zustellweg kommt über setMemoryAsker, in bot.ts und der Sprach-Brücke aus
 * memory/choices.ts). Ohne Gespräch oder Zustellweg bleibt es bei einer
 * Log-Zeile, ebenfalls ohne Änderung.
 *
 * Fristen von Zielen liest parseDeadline (when.ts): englische Formen wie
 * bisher, deutsche („morgen", „in 3 Tagen") in USER_TIMEZONE, ohne Angabe in
 * der Zeitzone des Prozesses. Eine unlesbare Frist ergibt ein Ziel ohne
 * Frist; eine übergroße wirft, dann wird nichts gespeichert.
 *
 * KNOWLEDGE (#317) legt einen Eintrag in der Wissensbasis an
 * (knowledge-base.ts, nur mit Supabase); gleiche Kategorie und gleicher
 * Titel ersetzen den alten Inhalt. Ohne Datenbank bleibt es bei einer
 * Log-Zeile.
 *
 * REMIND (#322) legt eine Erinnerung in der Ablage aus schedule/store.ts an
 * (Supabase oder data/reminders.json), im Gespräch des Turns: Telegram-Chat
 * mit Topic, Web-Gespräch, ohne Gespräch der Direktchat. Ein Turn ohne
 * Telegram in einem Telegram-Gespräch (Direktchat, Topic) behält Chat und
 * Topic, die Chat-ID trägt aber den Vorsatz aus webOnlyChatId: zugestellt
 * wird dann nur in der WebUI (reminderChat in schedule/remind.ts, dieselbe
 * Bestimmung wie bei den Planungswerkzeugen des Motors api). Die Zeit liest
 * parseReminderTime (schedule/remind.ts) in USER_TIMEZONE; unlesbar: keine
 * Erinnerung, nur eine Log-Zeile. Zugestellt wird vom Planer im Bot.
 *
 * Scheitert das Anlegen oder Ändern eines Ziels (Issue #518), bricht das den
 * Turn nicht ab: Das Ergebnis nennt es (goalsFailed, goalChangesFailed), und
 * reportMemoryFailures sagt es dem Nutzer im Gespräch des Turns (Zustellweg
 * über setMemoryFailureNotice, aus memory/choices.ts). Übernahmen eines
 * Vorschlags melden es stattdessen in ihrem Ergebnis (describeApplied).
 *
 * Ein REMEMBER mit Geheimnis (Issue #524, memory/secrets.ts) wird nicht gespeichert,
 * auch nicht aus einem bestätigten Vorschlag; das Ergebnis zählt es (factsRefused),
 * die Meldung verweist auf die .env und nennt den Wert nie.
 *
 * Alle Schreibzugriffe eines Prozesses laufen nacheinander. Ins Log kommen
 * keine Merk-Inhalte.
 */
import type { ChoiceConversation } from "../choices";
import { addKnowledge } from "../knowledge-base";
import { existsSync } from "node:fs";
import { getStore, type Backend } from "../store";
import { fileMemory, memoryFilePath } from "../store/file/memory";
import { readOpenGoals } from "../store/supabase/memory";
import { getSupabase } from "../supabase";
import type { MemoryItem } from "../store/types";
import { parseReminderTime, reminderChat } from "../schedule/remind";
import { getScheduleStore } from "../schedule/store";
import { parseDeadline } from "../when";
import { memoryContext, memorySelection, type MemorySelection } from "./context";
import { factsList, goalsList } from "./format";
import { isVague, parseMemoryIntents, type MemoryIntent } from "./intents";
import { containsSecret, secretRefusedText } from "./secrets";

/** Was eine Antwort im Gedächtnis bewirkt hat; die Texte wie im Tag */
export interface ProcessedIntents {
  /** Neue Ziele (GOAL) */
  goalsAdded: string[];
  /** Ziele, die nicht gespeichert wurden (Issue #518); fehlt, wenn keines scheiterte */
  goalsFailed?: string[];
  /** DONE bzw. CANCEL, die die Datenbank nicht ausführen konnte, der Suchtext; fehlt, wenn keines scheiterte */
  goalChangesFailed?: string[];
  /** Erledigte Ziele (DONE), der Suchtext */
  goalsCompleted: string[];
  /** Gestrichene Ziele (CANCEL), der Suchtext */
  goalsCancelled: string[];
  /** Neue Fakten (REMEMBER) */
  factsAdded: string[];
  /** So viele REMEMBER enthielten ein Geheimnis und wurden nicht gespeichert (#524); fehlt, wenn keins */
  factsRefused?: number;
  /** Vergessene Fakten (FORGET), der Suchtext */
  factsRemoved: string[];
  /** Titel der Wissenseinträge aus KNOWLEDGE (#317); fehlt, wenn keiner gespeichert wurde */
  knowledgeAdded?: string[];
  /** DONE, CANCEL bzw. FORGET mit mehreren Treffern, zu denen eine Rückfrage gestellt wurde */
  asked?: { action: SearchAction; query: string }[];
  /** Angelegte Erinnerungen aus REMIND (#322), Fälligkeit als ISO; fehlt, wenn keine */
  remindersAdded?: { text: string; dueAt: string }[];
}

/** Die drei Tags, die einen vorhandenen Eintrag suchen */
export type SearchAction = "done" | "cancel" | "forget";

/** Gespräch des Turns: dorthin geht eine Rückfrage */
export interface IntentConversation {
  conversation: ChoiceConversation;
  /** Turn ohne Telegram (Issue #259): Rückfrage nur im WebUI-Gespräch */
  noTelegram?: { conversationId: string };
}

/** Mehrere Treffer für einen Suchtext */
export interface AmbiguousMatch {
  action: SearchAction;
  query: string;
  /** Höchstens MAX_CHOICE_ENTRIES, älteste zuerst */
  matches: MemoryItem[];
  /** Es gibt mehr Treffer als gezeigt */
  more: boolean;
  where: IntentConversation;
}

/** Stellt die Rückfrage; true, wenn sie angekommen ist. Darf werfen */
export type MemoryAsker = (question: AmbiguousMatch) => Promise<boolean>;

/** So viele Einträge stehen höchstens zur Auswahl */
export const MAX_CHOICE_ENTRIES = 10;

let asker: MemoryAsker | null = null;

/** Zustellweg für Rückfragen; null nimmt ihn weg */
export function setMemoryAsker(fn: MemoryAsker | null): void {
  asker = fn;
}

/** Sagt dem Nutzer, was nicht geklappt hat; darf werfen */
export type MemoryFailureNotice = (where: IntentConversation, text: string) => Promise<void>;

let failureNotice: MemoryFailureNotice | null = null;

/** Zustellweg für Meldungen über gescheiterte Ziele; null nimmt ihn weg */
export function setMemoryFailureNotice(fn: MemoryFailureNotice | null): void {
  failureNotice = fn;
}

const memory = () => getStore().memory;

let tail: Promise<unknown> = Promise.resolve();
/** Führt fn nach allen vorher angestoßenen Schreibzugriffen dieses Prozesses aus */
function inTurn<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.catch(() => {}).then(fn);
  tail = run;
  return run;
}

/** Frist aus Worten, in USER_TIMEZONE bzw. der Zeitzone des Prozesses; leer: keine */
function deadlineFrom(words?: string): Date | undefined {
  if (!words) return undefined;
  const timeZone = process.env.USER_TIMEZONE?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  return parseDeadline(words, { timeZone });
}

// ---------------------------------------------------------------------------
// Einzelne Änderungen (Befehle wie /remember, /done; Teiltext: erster Treffer)
// ---------------------------------------------------------------------------

export function addFact(content: string): Promise<boolean> {
  return inTurn(() => memory().addFact(content));
}

/** Ziel anlegen; deadline in Worten, siehe oben */
export function addGoal(text: string, deadline?: string): Promise<boolean> {
  return inTurn(() => memory().addGoal(text, deadlineFrom(deadline)));
}

export function completeGoal(searchText: string): Promise<boolean> {
  return inTurn(() => memory().completeGoal(searchText));
}

export function cancelGoal(searchText: string): Promise<boolean> {
  return inTurn(() => memory().cancelGoal(searchText));
}

export function deleteFact(searchText: string): Promise<boolean> {
  return inTurn(() => memory().deleteFact(searchText));
}

/** Genau den Eintrag mit dieser ID ändern (Auswahl aus einer Rückfrage); false, wenn es ihn nicht mehr gibt */
export function applyToEntry(action: SearchAction, id: string): Promise<boolean> {
  return inTurn(() => {
    const store = memory();
    if (action === "done") return store.completeGoalById(id);
    if (action === "cancel") return store.cancelGoalById(id);
    return store.deleteFactById(id);
  });
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

/** Offene Ziele und der Speicher, aus dem sie kamen */
export interface OpenGoals {
  goals: MemoryItem[];
  from: Backend;
}

const onlyOpen = (goals: MemoryItem[]) => goals.filter(goal => goal.type === "goal" && goal.completed !== true);

/** Gibt es eine lokale Ablage (memory.json oder ihre SQLite-Datei)? */
const hasLocalMemory = (path: string) => existsSync(path) || existsSync(`${path}.sqlite`);

/**
 * Offene Ziele als Einträge, ohne erreichte (Quelle Ziele, #354). Mit
 * Supabase wird streng gelesen: scheitert der Abruf, gelten wie im
 * früheren Briefing die offenen Ziele der lokalen Ablage (from: "file").
 * Gibt es dort keine, wirft der ursprüngliche Fehler weiter, damit ein
 * gescheiterter Abruf nicht als „keine Ziele" erscheint. Mit
 * localFallback: false wirft jeder gescheiterte Abruf (Check-in, #364: die
 * lokale Ablage hat keinen Aktualitätsnachweis).
 */
export async function openGoals(options: { localFallback?: boolean } = {}): Promise<OpenGoals> {
  const store = getStore();
  if (store.backend !== "supabase") return { goals: onlyOpen(await store.memory.activeGoals()), from: store.backend };
  try {
    return { goals: onlyOpen(await readOpenGoals(getSupabase)), from: "supabase" };
  } catch (error) {
    if (options.localFallback === false) throw error;
    const path = memoryFilePath();
    const local = hasLocalMemory(path) ? onlyOpen(await fileMemory(() => path).activeGoals()) : [];
    if (local.length === 0) throw error;
    return { goals: local, from: "file" };
  }
}

/** Offene Ziele als nummerierte Liste (/goals); wirft, wenn sie nicht lesbar sind, damit das nie wie „keine Ziele“ aussieht */
export const listGoals = (): Promise<string> => openGoals({ localFallback: false }).then(({ goals }) => goalsList(goals));

/** Fakten als Spiegelstriche (/memory) */
export const listFacts = (): Promise<string> => memory().facts().then(factsList);

/**
 * Fakten und Ziele für den Prompt. Supabase: mit Nachricht über dem Budget
 * nach Relevanz ausgewählt. Datei: wie vor #316 vollständig, ohne Kürzung
 * und ohne Embedding-Anfrage.
 */
export function getMemoryContext(userMessage?: string): Promise<string> {
  if (getStore().backend === "file") return memoryContext(memory(), undefined, { budget: Infinity });
  return memoryContext(memory(), userMessage);
}

/** Wie getMemoryContext, nennt dazu die gezeigten Fakten (Issue #523) */
export function getMemorySelection(userMessage?: string): Promise<MemorySelection> {
  if (getStore().backend === "file") return memorySelection(memory(), undefined, { budget: Infinity });
  return memorySelection(memory(), userMessage);
}

// ---------------------------------------------------------------------------
// Merk-Tags
// ---------------------------------------------------------------------------

const TAG_OF: Record<SearchAction, string> = { done: "DONE", cancel: "CANCEL", forget: "FORGET" };
const RESULT_OF: Record<SearchAction, "goalsCompleted" | "goalsCancelled" | "factsRemoved"> = {
  done: "goalsCompleted",
  cancel: "goalsCancelled",
  forget: "factsRemoved",
};

type Search = Extract<MemoryIntent, { type: SearchAction }>;

/** Erinnerung aus REMIND anlegen; null, wenn die Zeit unlesbar ist oder die Ablage scheitert */
async function addReminder(intent: Extract<MemoryIntent, { type: "remind" }>, where: IntentConversation | undefined): Promise<{ text: string; dueAt: string } | null> {
  const dueAt = parseReminderTime(intent.when);
  if (!dueAt) {
    console.log("[Gedächtnis] REMIND mit unlesbarer Zeit übersprungen");
    return null;
  }
  const task = await inTurn(() => getScheduleStore().add({ ...reminderChat(where), kind: "reminder", text: intent.text, dueAt }));
  if (!task) {
    console.log("[Gedächtnis] REMIND nicht gespeichert (Ablage nicht erreichbar)");
    return null;
  }
  return { text: task.text, dueAt: task.dueAt };
}

/** Ergebnis eines Suchtags: geändert, nichts gefunden bzw. getan, oder Rückfrage gestellt */
type SearchOutcome = "changed" | "none" | "asked" | "failed";

async function ask(question: AmbiguousMatch): Promise<boolean> {
  if (!asker) return false;
  try {
    return await asker(question);
  } catch (e) {
    console.log(`[Gedächtnis] Rückfrage zu ${TAG_OF[question.action]} nicht gestellt (${e instanceof Error ? e.name : "Fehler"})`);
    return false;
  }
}

/** Sucht alle Treffer und ändert nur bei genau einem; bei mehreren Rückfrage */
async function resolveSearch(intent: Search, where: IntentConversation | undefined): Promise<SearchOutcome> {
  const action = intent.type;
  let found: MemoryItem[];
  try {
    found = await inTurn(() =>
      action === "forget" ? memory().matchingFacts(intent.query, MAX_CHOICE_ENTRIES + 1) : memory().matchingGoals(intent.query, MAX_CHOICE_ENTRIES + 1),
    );
  } catch (e) {
    console.error(`[Gedächtnis] ${TAG_OF[action]} nicht ausgeführt (${e instanceof Error ? e.name : "Fehler"})`);
    return "failed";
  }
  const usable = found.filter(item => typeof item.id === "string" || typeof item.id === "number");
  if (usable.length === 0) return "none";
  if (usable.length === 1) {
    try {
      return (await applyToEntry(action, String(usable[0].id))) ? "changed" : "none";
    } catch (e) {
      console.error(`[Gedächtnis] ${TAG_OF[action]} nicht ausgeführt (${e instanceof Error ? e.name : "Fehler"})`);
      return "failed";
    }
  }

  const tag = TAG_OF[action];
  if (!where) {
    console.log(`[Gedächtnis] ${tag} trifft ${usable.length} Einträge, ohne Gespräch keine Rückfrage: nichts geändert`);
    return "none";
  }
  const question: AmbiguousMatch = {
    action,
    query: intent.query,
    matches: usable.slice(0, MAX_CHOICE_ENTRIES),
    more: usable.length > MAX_CHOICE_ENTRIES,
    where,
  };
  if (await ask(question)) return "asked";
  console.log(`[Gedächtnis] ${tag} trifft ${usable.length} Einträge, Rückfrage nicht zugestellt: nichts geändert`);
  return "none";
}

const emptyResult = (): ProcessedIntents => ({ goalsAdded: [], goalsCompleted: [], goalsCancelled: [], factsAdded: [], factsRemoved: [] });

/** Ziel aus einem Tag anlegen; wirft nie, damit ein Turn nicht vor der Antwort abbricht */
async function tryAddGoal(text: string, deadline: string | undefined): Promise<boolean> {
  try {
    return await addGoal(text, deadline);
  } catch (e) {
    console.error(`[Gedächtnis] Ziel nicht gespeichert (${e instanceof Error ? e.name : "Fehler"})`);
    return false;
  }
}

type ReportedFailures = Pick<ProcessedIntents, "goalsFailed" | "goalChangesFailed" | "factsRefused">;

/** Meldung über abgelehnte Fakten und gescheiterte Ziele; null, wenn nichts davon vorkam */
export function memoryFailureText(processed: ReportedFailures): string | null {
  const refused = processed.factsRefused ? [secretRefusedText(processed.factsRefused)] : [];
  const lines = [
    ...(processed.goalsFailed ?? []).map(goal => `⚠️ Das Ziel „${goal}" wurde nicht gespeichert. Nochmal anlegen: /track ${goal}`),
    ...(processed.goalChangesFailed ?? []).map(query => `⚠️ Das Ziel zu „${query}" konnte ich nicht ändern, es ist unverändert.`),
  ];
  const failed = lines.length > 0 ? [...lines, "Das Speichern ist gescheitert, Details stehen im Log."] : [];
  return refused.length + failed.length > 0 ? [...refused, ...failed].join("\n") : null;
}

/**
 * Sagt dem Nutzer, welche Ziele und Fakten aus einer Antwort nicht gespeichert wurden.
 * Wirft nie; kommt die Meldung nicht an, bleibt es beim Log.
 */
export async function reportMemoryFailures(processed: ReportedFailures, where: IntentConversation | undefined): Promise<void> {
  const text = memoryFailureText(processed);
  if (!text) return;
  if (!failureNotice || !where) {
    console.error("[Gedächtnis] Gescheiterte Ziele nicht gemeldet: kein Zustellweg oder Gespräch");
    return;
  }
  try {
    await failureNotice(where, text);
  } catch (e) {
    console.error(`[Gedächtnis] Meldung über gescheiterte Ziele nicht zugestellt (${e instanceof Error ? e.name : "Fehler"})`);
  }
}

/**
 * Wendet die Merk-Tags einer Antwort an. where: Gespräch des Turns für
 * Rückfragen bei mehreren Treffern; ohne wird bei mehreren nichts geändert.
 */
export async function processIntents(text: string, where?: IntentConversation): Promise<ProcessedIntents> {
  const result = emptyResult();
  for (const intent of parseMemoryIntents(text)) {
    if (intent.type === "fact") {
      if (containsSecret(intent.text)) {
        console.log("[Gedächtnis] REMEMBER mit Geheimnis nicht gespeichert");
        result.factsRefused = (result.factsRefused ?? 0) + 1;
        continue;
      }
      if (await addFact(intent.text)) result.factsAdded.push(intent.text);
      continue;
    }
    if (intent.type === "goal") {
      if (intent.deadline === undefined && result.goalsAdded.includes(intent.text)) continue;
      if (await tryAddGoal(intent.text, intent.deadline)) result.goalsAdded.push(intent.text);
      else (result.goalsFailed ??= []).push(intent.text);
      continue;
    }
    if (intent.type === "knowledge") {
      const { category, title, content, project } = intent;
      const stored = await inTurn(() => addKnowledge({ category, title, content, ...(project ? { related_project: project } : {}) }));
      if (stored.ok) (result.knowledgeAdded ??= []).push(title);
      else console.log("[Gedächtnis] KNOWLEDGE nicht gespeichert (Wissensbasis nicht erreichbar)");
      continue;
    }
    if (intent.type === "remind") {
      const added = await addReminder(intent, where);
      if (added) (result.remindersAdded ??= []).push(added);
      continue;
    }
    if (isVague(intent)) {
      console.warn(`[Gedächtnis] ${TAG_OF[intent.type]} mit zu kurzem Suchtext übersprungen`);
      continue;
    }
    const outcome = await resolveSearch(intent, where);
    if (outcome === "changed") result[RESULT_OF[intent.type]].push(intent.query);
    if (outcome === "asked") (result.asked ??= []).push({ action: intent.type, query: intent.query });
    if (outcome === "failed" && intent.type !== "forget") (result.goalChangesFailed ??= []).push(intent.query);
  }
  return result;
}
