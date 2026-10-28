/**
 * Ablage der offenen Fäden (Issue #290, Entscheidung 0025).
 *
 * Ein Faden ist eine Frage oder offene Entscheidung, mit der tybo eine
 * Antwort an den Nutzer beendet hat. Ablage: data/threads.json, wie
 * data/choices.json ohne Cache: jede Änderung liest die Datei frisch unter
 * einer Sperre mit Besitzer (file-lock.ts, <datei>.lock) und schreibt atomar
 * zurück (atomic-file.ts). Lesen geht ohne Sperre, weil Schreiben die Datei
 * nur als Ganzes ersetzt.
 *
 * Grenzen, geprüft unter derselben Sperre wie das Anlegen:
 * - Dieselbe Frage im selben Gespräch gibt es offen nur einmal.
 * - Höchstens THREADS_OPEN_MAX offene Fäden. Kommt ein weiterer dazu, wird
 *   der älteste offene still geschlossen (closedReason "limit"); er bleibt
 *   bis zum Aufräumen als geschlossen in der Datei.
 * - Geschlossene Fäden werden THREADS_CLOSED_KEEP_MS nach closedAt entfernt.
 *
 * Nummern (Issue #291): Jeder Faden hat eine feste Nummer nr, die /faeden
 * zeigt und /faeden zu <nr> nimmt. Vergeben wird sie unter der Sperre aus
 * nextNr der Datei; eine Nummer wird nie wieder vergeben, auch nicht nach dem
 * Aufräumen. Fäden aus der Zeit vor den Nummern (oder mit doppelter Nummer)
 * bekommen beim Lesen eine, in der Reihenfolge ihres Anlegens; Lesen ohne
 * Sperre rechnet dieselben Nummern aus, die das nächste Schreiben festhält.
 *
 * Nummernstand: nextNr steht zusätzlich in <datei>.nr und wird dort vor der
 * Ablage geschrieben. Er ist nur die Untergrenze für neue Nummern; Fäden ohne
 * Nummer werden allein aus der Ablage nummeriert, damit ein Leser vor dem
 * Ersetzen und ein gescheitertes Schreiben dieselben Nummern sehen, die die
 * Ablage später festhält. Ist die Ablage kaputt, geht es mit diesem Stand weiter,
 * damit eine alte Nummer (ein /faeden zu von früher, ein noch laufendes
 * Aux-Ergebnis) nie einen neuen Faden trifft. Fehlt auch der gesicherte
 * Stand, lehnt die Ablage Änderungen ab und lässt die kaputte Datei liegen.
 *
 * Ins Log kommen nur Kennungen, nie Thema, Kontext oder Frage.
 */

import { mkdir, readFile, rename } from "fs/promises";
import { randomInt } from "crypto";
import { dirname, join } from "path";
import { acquireFileLock, releaseFileLock } from "../file-lock";
import { atomicWriteFile } from "../atomic-file";
import type { ChoiceConversation } from "../choices";
import { describeThreadsSettings } from "./config";
import { nextReminderTime } from "./schedule";

// ---------------------------------------------------------------------------
// Datenmodell
// ---------------------------------------------------------------------------

export type ThreadState = "open" | "closed";

/**
 * Persistenter Versandauftrag einer Erinnerung (Issue #292, remind.ts):
 * "ready" heißt, noch nichts unterwegs (Wiederaufnahme setzt fort), "sending"
 * heißt, der Ausgang ist unbekannt (Wiederaufnahme wertet ihn als unklar,
 * sendet nie neu). choiceId ist die Rückfrage der Erinnerung, attempts zählt
 * die Versuche, since ist der Beginn des Zustands.
 */
export interface ThreadReminder {
  step: 1 | 2;
  choiceId?: string;
  attempts: number;
  state: "ready" | "sending";
  since: number;
}

export interface Thread {
  /** A-Z, a-z, 0-9, 10 Zeichen */
  id: string;
  /** Feste Nummer für /faeden, ab 1, nie wiederverwendet (Issue #291) */
  nr: number;
  conversation: ChoiceConversation;
  /** Thema in einem Satz */
  topic: string;
  /** Ein bis zwei Sätze, worum es geht */
  context: string;
  question: string;
  createdAt: number;
  /** Frist als Kalenderdatum YYYY-MM-DD */
  deadline?: string;
  state: ThreadState;
  closedReason?: string;
  closedAt?: number;
  /** Zugestellte (oder unklar ausgegangene) Erinnerungen, höchstens 2 */
  reminders: number;
  nextReminderAt?: number;
  /** Laufender Versandauftrag (Issue #292) */
  reminder?: ThreadReminder;
  /** Erinnerung ging raus: der nächste Turn im Gespräch bekommt den Faden einmal als Hinweis */
  hintPending?: true;
}

export interface CreateThreadInput {
  conversation: ChoiceConversation;
  topic: string;
  context: string;
  question: string;
  deadline?: string;
}

export type CreateThreadOutcome =
  | { status: "created"; thread: Thread; closed: Thread[] }
  | { status: "duplicate"; thread: Thread };

/**
 * Fäden an? Einstellung threads.enabled (WebUI, Issue #293) vor THREADS=off
 * in der .env (Groß- und Kleinschreibung egal) vor an (config.ts).
 */
export function threadsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return describeThreadsSettings(env).enabled.value;
}

export const THREADS_OPEN_MAX = 200;
export const THREADS_CLOSED_KEEP_MS = 30 * 24 * 3_600_000;

/** Abschlussgründe (Issue #291, #292); "limit" kommt aus der Obergrenze */
export const CLOSED_REASON = {
  answered: "beantwortet",
  manual: "von Hand",
  limit: "limit",
  done: "erledigt",
  dropped: "nicht mehr wichtig",
  noAnswer: "keine Antwort",
  gone: "Gespräch weg",
} as const;

const ID_LENGTH = 10;
const ID_RE = /^[A-Za-z0-9]{1,12}$/;
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Gültiges Kalenderdatum im Format YYYY-MM-DD (kein 31. Februar). */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** Vergleichsform einer Frage: Kleinbuchstaben, einfache Leerzeichen, ohne Satzzeichen am Ende. */
export function normalizeQuestion(question: string): string {
  return question.toLowerCase().replace(/\s+/g, " ").trim().replace(/[\s?!.…:;,]+$/u, "");
}

export function sameConversation(a: ChoiceConversation, b: ChoiceConversation): boolean {
  if (a.type === "telegram" && b.type === "telegram") return a.chatId === b.chatId && a.topicId === b.topicId;
  if (a.type === "web" && b.type === "web") return a.conversationId === b.conversationId;
  return false;
}

// ---------------------------------------------------------------------------
// Ablage
// ---------------------------------------------------------------------------

const DEFAULT_THREADS_FILE = join(process.cwd(), "data", "threads.json");
let threadsFile = DEFAULT_THREADS_FILE;

/** Datei mit dem gesicherten Nummernstand neben der Ablage */
function nrFile(file: string): string {
  return `${file}.nr`;
}

/** Nur für Tests: Ablage umlenken, null stellt zurück. */
export function setThreadsFileForTests(path: string | null): void {
  threadsFile = path ?? DEFAULT_THREADS_FILE;
}

interface StoreFile {
  version: 1;
  /** Nächste freie Nummer; fehlt in Dateien aus der Zeit vor Issue #291 */
  nextNr?: number;
  threads: Record<string, Thread>;
}

function log(message: string): void {
  console.log(`[threads] ${message}`);
}

function isConversation(value: any): value is ChoiceConversation {
  if (!value || typeof value !== "object") return false;
  if (value.type === "telegram") {
    return typeof value.chatId === "string" && value.chatId !== "" &&
      (value.topicId === undefined || Number.isInteger(value.topicId));
  }
  if (value.type === "web") return typeof value.conversationId === "string" && value.conversationId !== "";
  return false;
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "";
}

function isReminder(r: any): r is ThreadReminder {
  if (!r || typeof r !== "object") return false;
  if (r.step !== 1 && r.step !== 2) return false;
  if (r.choiceId !== undefined && (typeof r.choiceId !== "string" || !ID_RE.test(r.choiceId))) return false;
  if (!Number.isInteger(r.attempts) || r.attempts < 0) return false;
  if (r.state !== "ready" && r.state !== "sending") return false;
  return typeof r.since === "number" && Number.isFinite(r.since);
}

function isThread(id: string, t: any): t is Thread {
  if (!t || typeof t !== "object" || t.id !== id || !ID_RE.test(id)) return false;
  if (!isConversation(t.conversation)) return false;
  if (!nonEmpty(t.topic) || !nonEmpty(t.context) || !nonEmpty(t.question)) return false;
  if (typeof t.createdAt !== "number" || !Number.isFinite(t.createdAt)) return false;
  if (t.deadline !== undefined && !isCalendarDate(t.deadline)) return false;
  if (!Number.isInteger(t.reminders) || t.reminders < 0) return false;
  // nr fehlt in alten Dateien; ungültige Nummern vergibt readStore neu
  if (t.nr !== undefined && typeof t.nr !== "number") return false;
  if (t.nextReminderAt !== undefined && typeof t.nextReminderAt !== "number") return false;
  if (t.reminder !== undefined && !isReminder(t.reminder)) return false;
  if (t.hintPending !== undefined && t.hintPending !== true) return false;
  if (t.state === "closed") return typeof t.closedAt === "number" && (t.closedReason === undefined || typeof t.closedReason === "string");
  return t.state === "open" && t.closedAt === undefined;
}

type ReadOutcome = { ok: true; threads: Record<string, Thread>; nextNr: number; numbered: boolean } | { ok: false; reason: string };

function validNr(nr: unknown): nr is number {
  return Number.isSafeInteger(nr) && (nr as number) >= 1;
}

/**
 * Gibt Fäden ohne gültige oder mit doppelter Nummer eine neue, in der
 * Reihenfolge des Anlegens (bei Gleichstand nach id), ab der höheren von
 * nextNr der Ablage und höchster vergebener Nummer plus eins. Deterministisch, damit
 * Lesen ohne Sperre dieselben Nummern zeigt, die das nächste Schreiben
 * festhält. Gibt die neue nextNr zurück und ob etwas vergeben wurde.
 */
function assignNumbers(threads: Record<string, Thread>, storedNext: unknown): { nextNr: number; numbered: boolean } {
  const ordered = Object.values(threads).sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const used = new Set<number>();
  const missing: Thread[] = [];
  for (const t of ordered) {
    if (validNr(t.nr) && !used.has(t.nr)) used.add(t.nr);
    else missing.push(t);
  }
  let next = Math.max(validNr(storedNext) ? storedNext : 1, used.size ? Math.max(...used) + 1 : 1);
  for (const t of missing) t.nr = next++;
  return { nextNr: next, numbered: missing.length > 0 || !validNr(storedNext) || storedNext !== next };
}

/** Gesicherter Nummernstand aus <datei>.nr; null, wenn er fehlt oder ungültig ist. */
async function readSavedNr(file: string): Promise<number | null> {
  try {
    const text = (await readFile(nrFile(file), "utf-8")).trim();
    const nr = /^\d+$/.test(text) ? Number(text) : NaN;
    return validNr(nr) ? nr : null;
  } catch {
    return null;
  }
}

/**
 * Liest die Ablage; fehlende Datei ist leer, kaputte Datei meldet ok: false.
 * nextNr ist nie kleiner als der gesicherte Stand in <datei>.nr.
 */
async function readStore(file: string): Promise<ReadOutcome> {
  const saved = await readSavedNr(file);
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (error: any) {
    if (error.code === "ENOENT") return { ok: true, threads: {}, nextNr: saved ?? 1, numbered: false };
    return { ok: false, reason: `nicht lesbar (${error.code || "Fehler"})` };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "kein gültiges JSON" };
  }
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1 ||
      !parsed.threads || typeof parsed.threads !== "object" || Array.isArray(parsed.threads)) {
    return { ok: false, reason: "unbekannte Struktur" };
  }
  const threads: Record<string, Thread> = {};
  for (const [id, t] of Object.entries(parsed.threads)) {
    if (isThread(id, t)) threads[id] = t;
    else log(`ungültiger Eintrag ${JSON.stringify(id.slice(0, 20))} übersprungen`);
  }
  // Fäden ohne Nummer werden nur aus der Ablage selbst nummeriert, nie mit
  // dem gesicherten Stand: der kann schon weiter sein (vor dem Ersetzen der
  // Ablage geschrieben, oder das Ersetzen ist gescheitert), und die gelesenen
  // Nummern müssen dieselben bleiben, die das Ersetzen festhält.
  const assigned = assignNumbers(threads, parsed.nextNr);
  const nextNr = Math.max(assigned.nextNr, saved ?? 1);
  return { ok: true, threads, nextNr, numbered: assigned.numbered || nextNr !== assigned.nextNr };
}

// Innerhalb des Prozesses reiht storeTail die Änderungen auf, die Sperre
// schützt gegen andere Prozesse.
let storeTail: Promise<unknown> = Promise.resolve();

export type ThreadsClosedListener = (threads: Thread[]) => void | Promise<void>;
const closedListeners = new Set<ThreadsClosedListener>();

/**
 * Meldet Fäden, die dieser Prozess geschlossen hat (Issue #292), auf jedem
 * Weg: Auflösen, /faeden zu, Knopf, still nach der zweiten Erinnerung,
 * Gespräch weg, Obergrenze. Gemeldet wird erst nach erfolgreichem Schreiben,
 * außerhalb der Sperre; Fehler der Zuhörer werden geloggt, nie geworfen.
 * Gibt eine Abmelde-Funktion zurück.
 */
export function onThreadsClosed(listener: ThreadsClosedListener): () => void {
  closedListeners.add(listener);
  return () => { closedListeners.delete(listener); };
}

async function emitClosed(threads: Thread[]): Promise<void> {
  if (threads.length === 0) return;
  for (const listener of [...closedListeners]) {
    try {
      await listener(threads.map(t => ({ ...t })));
    } catch {
      log(`Zuhörer für geschlossene Fäden scheiterte (${threads.map(t => t.id).join(", ")})`);
    }
  }
}

/**
 * Liest, ändert und schreibt die Ablage unter Sperre; fn gibt zurück, ob
 * geschrieben werden muss. Vorher werden geschlossene Fäden nach
 * THREADS_CLOSED_KEEP_MS entfernt. Eine kaputte Datei wird nicht still
 * überschrieben, sondern als <datei>.kaputt-<zeit> aufbewahrt, und es geht
 * mit dem gesicherten Nummernstand weiter; ohne ihn wirft updateStore und
 * ändert nichts. Der Nummernstand wird vor der Ablage geschrieben. Fäden, die
 * fn geschlossen hat, gehen nach dem Schreiben an onThreadsClosed.
 */
function updateStore<T>(fn: (threads: Record<string, Thread>, now: number, nr: () => number) => { result: T; changed: boolean }): Promise<T> {
  const file = threadsFile;
  const run = storeTail.catch(() => {}).then(async () => {
    await mkdir(dirname(file), { recursive: true });
    const lockFile = `${file}.lock`;
    const lock = await acquireFileLock(lockFile);
    try {
      const outcome = await readStore(file);
      let threads: Record<string, Thread>;
      let changed = false;
      let nextNr = 1;
      if (outcome.ok) {
        threads = outcome.threads;
        nextNr = outcome.nextNr;
        changed = outcome.numbered;
      } else {
        const saved = await readSavedNr(file);
        if (saved === null) {
          log(`Ablage ${outcome.reason}, Nummernstand nicht gesichert: keine Änderung, Datei bleibt liegen`);
          throw new Error("Ablage der Fäden kaputt, Nummernstand nicht gesichert");
        }
        nextNr = saved;
        const backup = `${file}.kaputt-${Date.now()}`;
        await rename(file, backup);
        log(`Ablage ${outcome.reason}, aufbewahrt als ${backup}, weiter mit leerer Ablage`);
        threads = {};
        changed = true;
      }
      const now = Date.now();
      const cutoff = now - THREADS_CLOSED_KEEP_MS;
      for (const [id, t] of Object.entries(threads)) {
        if (t.state !== "closed" || (t.closedAt ?? 0) >= cutoff) continue;
        delete threads[id];
        changed = true;
      }
      const openBefore = new Set(Object.values(threads).filter(t => t.state === "open").map(t => t.id));
      const r = fn(threads, now, () => nextNr++);
      const closed = Object.values(threads).filter(t => openBefore.has(t.id) && t.state === "closed");
      if (r.changed || changed) {
        if ((await readSavedNr(file)) !== nextNr) await atomicWriteFile(nrFile(file), `${nextNr}\n`);
        const store: StoreFile = { version: 1, nextNr, threads };
        await atomicWriteFile(file, JSON.stringify(store, null, 2));
      }
      return { result: r.result, closed: r.changed || changed ? closed : [] };
    } finally {
      await releaseFileLock(lockFile, lock).catch(() => {});
    }
  });
  storeTail = run;
  return run.then(async ({ result, closed }) => {
    await emitClosed(closed);
    return result;
  });
}

/** Schließt einen offenen Faden (unter der Sperre von updateStore) */
function close(t: Thread, reason: string, now: number): void {
  t.state = "closed";
  t.closedReason = reason;
  t.closedAt = now;
  delete t.reminder;
  delete t.hintPending;
}

function newId(taken: Record<string, Thread>): string {
  for (;;) {
    let id = "";
    for (let i = 0; i < ID_LENGTH; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
    if (!Object.prototype.hasOwnProperty.call(taken, id)) return id;
  }
}

// ---------------------------------------------------------------------------
// Funktionen
// ---------------------------------------------------------------------------

/**
 * Legt einen offenen Faden an. Gibt es im selben Gespräch schon einen offenen
 * mit derselben Frage, bleibt es bei dem ("duplicate"). Wirft bei ungültiger
 * Eingabe oder wenn das Speichern scheitert.
 */
export async function createThread(input: CreateThreadInput): Promise<CreateThreadOutcome> {
  if (!isConversation(input.conversation)) throw new Error("ungültiges Gespräch");
  if (!nonEmpty(input.topic) || !nonEmpty(input.context) || !nonEmpty(input.question)) throw new Error("leeres Feld");
  if (input.deadline !== undefined && !isCalendarDate(input.deadline)) throw new Error("ungültige Frist");
  const key = normalizeQuestion(input.question);

  const outcome = await updateStore<CreateThreadOutcome>((threads, now, nextNr) => {
    const open = Object.values(threads).filter(t => t.state === "open");
    const same = open.find(t => sameConversation(t.conversation, input.conversation) && normalizeQuestion(t.question) === key);
    if (same) return { result: { status: "duplicate", thread: same }, changed: false };

    const closed: Thread[] = [];
    open.sort((a, b) => a.createdAt - b.createdAt);
    while (open.length >= THREADS_OPEN_MAX) {
      const oldest = open.shift()!;
      close(oldest, CLOSED_REASON.limit, now);
      closed.push(oldest);
    }
    const thread: Thread = {
      id: newId(threads),
      nr: nextNr(),
      conversation: { ...input.conversation },
      topic: input.topic.trim(),
      context: input.context.trim(),
      question: input.question.trim(),
      createdAt: now,
      ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
      state: "open",
      reminders: 0,
      nextReminderAt: nextReminderTime(now, input.deadline),
    };
    threads[thread.id] = thread;
    return { result: { status: "created", thread, closed }, changed: true };
  });
  if (outcome.status === "created") {
    for (const c of outcome.closed) log(`Faden ${c.id} geschlossen (Obergrenze ${THREADS_OPEN_MAX})`);
  }
  return outcome;
}

/** Offene Fäden, neueste zuerst; mit conversation nur die dieses Gesprächs. Kaputte Datei zählt als leer. */
export async function listOpenThreads(conversation?: ChoiceConversation): Promise<Thread[]> {
  const outcome = await readStore(threadsFile);
  if (!outcome.ok) {
    log(`Ablage ${outcome.reason}, gelesen als leer`);
    return [];
  }
  return Object.values(outcome.threads)
    .filter(t => t.state === "open" && (!conversation || sameConversation(t.conversation, conversation)))
    .sort((a, b) => b.createdAt - a.createdAt || b.nr - a.nr);
}

export interface CloseThreadsOutcome {
  /** Jetzt geschlossen */
  closed: Thread[];
  /** Nicht geschlossen: unbekannt, schon geschlossen oder aus einem anderen Gespräch */
  skipped: number[];
}

/**
 * Schließt Fäden nach Nummer, aber nur offene aus diesem Gespräch; alles wird
 * unter der Sperre frisch geprüft und gemeinsam gespeichert (scheitert das
 * Schreiben, bleibt kein Faden halb geschlossen). Ein schon geschlossener
 * Faden behält Grund und Zeitpunkt. Wirft, wenn das Speichern scheitert.
 */
export async function closeThreads(conversation: ChoiceConversation, nrs: number[], reason: string): Promise<CloseThreadsOutcome> {
  if (!isConversation(conversation)) throw new Error("ungültiges Gespräch");
  if (!nonEmpty(reason)) throw new Error("leerer Grund");
  const wanted = [...new Set(nrs.filter(validNr))];
  if (wanted.length === 0) return { closed: [], skipped: [...new Set(nrs)] };
  const outcome = await updateStore<CloseThreadsOutcome>((threads, now) => {
    const byNr = new Map(Object.values(threads).map(t => [t.nr, t]));
    const closed: Thread[] = [];
    const skipped: number[] = [];
    for (const nr of wanted) {
      const t = byNr.get(nr);
      if (!t || t.state !== "open" || !sameConversation(t.conversation, conversation)) {
        skipped.push(nr);
        continue;
      }
      close(t, reason, now);
      closed.push(t);
    }
    return { result: { closed, skipped }, changed: closed.length > 0 };
  });
  for (const t of outcome.closed) log(`Faden ${t.id} (Nr. ${t.nr}) geschlossen (${reason})`);
  return outcome;
}

/** Ein Faden nach Nummer, offen oder geschlossen; null, wenn es ihn nicht (mehr) gibt. */
export async function findThread(nr: number): Promise<Thread | null> {
  const outcome = await readStore(threadsFile);
  if (!outcome.ok) return null;
  return Object.values(outcome.threads).find(t => t.nr === nr) ?? null;
}

export const THREADS_RECENT_CLOSED_MS = 7 * 24 * 3_600_000;

/** Geschlossene Fäden mit closedAt in den letzten 7 Tagen vor now, zuletzt geschlossene zuerst. */
export async function listRecentlyClosedThreads(now: number = Date.now()): Promise<Thread[]> {
  const outcome = await readStore(threadsFile);
  if (!outcome.ok) return [];
  return Object.values(outcome.threads)
    .filter(t => t.state === "closed" && (t.closedAt ?? 0) >= now - THREADS_RECENT_CLOSED_MS)
    .sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));
}

/** Wie listAllThreads, wirft aber, wenn die Ablage nicht lesbar ist: ein Lesefehler ist keine leere Ablage. */
export async function listAllThreadsChecked(): Promise<Thread[]> {
  const outcome = await readStore(threadsFile);
  if (!outcome.ok) throw new Error(`Ablage der Fäden ${outcome.reason}`);
  return Object.values(outcome.threads);
}

/** Alle Fäden wie gespeichert (offen und geschlossen), für Tests und Auswertungen. */
export async function listAllThreads(): Promise<Thread[]> {
  const outcome = await readStore(threadsFile);
  return outcome.ok ? Object.values(outcome.threads) : [];
}

/** Ein Faden nach ID, offen oder geschlossen; null, wenn es ihn nicht (mehr) gibt oder die Ablage kaputt ist. */
export async function getThread(id: string): Promise<Thread | null> {
  const outcome = await readStore(threadsFile);
  if (!outcome.ok || !Object.prototype.hasOwnProperty.call(outcome.threads, id)) return null;
  return outcome.threads[id];
}

// ---------------------------------------------------------------------------
// Erinnerungen (Issue #292)
// ---------------------------------------------------------------------------

export type ThreadButton = "done" | "later" | "drop";

export type ThreadButtonOutcome =
  | { status: "closed"; thread: Thread }
  /** final: die zweite Erinnerung ist durch (oder unterwegs), es kommt keine dritte */
  | { status: "postponed"; thread: Thread; final: boolean }
  | { status: "not-open" };

/**
 * Knopf einer Erinnerung, unter der Sperre frisch geprüft: nur ein offener
 * Faden ändert sich. "done" und "drop" schließen, "later" setzt
 * nextReminderAt auf laterAt(now) und lässt reminders stehen. Läuft gerade
 * ein Versandauftrag, gilt seine Stufe als verbraucht und der Auftrag endet:
 * ein spätes Versandergebnis überschreibt das nicht, und ein Klick vor dem
 * Versand verhindert ihn. Wirft, wenn das Speichern scheitert.
 */
export async function applyThreadButton(id: string, button: ThreadButton, laterAt: (now: number) => number): Promise<ThreadButtonOutcome> {
  return updateStore<ThreadButtonOutcome>((threads, now) => {
    const t = Object.prototype.hasOwnProperty.call(threads, id) ? threads[id] : undefined;
    if (!t || t.state !== "open") return { result: { status: "not-open" }, changed: false };
    if (button === "done" || button === "drop") {
      close(t, button === "done" ? CLOSED_REASON.done : CLOSED_REASON.dropped, now);
      return { result: { status: "closed", thread: t }, changed: true };
    }
    if (t.reminder) {
      t.reminders = Math.max(t.reminders, t.reminder.step);
      delete t.reminder;
    }
    t.nextReminderAt = laterAt(now);
    return { result: { status: "postponed", thread: t, final: t.reminders >= 2 }, changed: true };
  });
}

/**
 * Offene Fäden dieses Gesprächs mit hintPending; das Feld wird unter derselben
 * Sperre gelöscht (einmal verbrauchen: von zwei gleichzeitigen Turns bekommt
 * ihn nur einer). Wirft, wenn das Speichern scheitert.
 */
export async function takeReminderHints(conversation: ChoiceConversation): Promise<Thread[]> {
  if (!isConversation(conversation)) return [];
  return updateStore<Thread[]>(threads => {
    const taken = Object.values(threads).filter(t => t.state === "open" && t.hintPending && sameConversation(t.conversation, conversation));
    for (const t of taken) delete t.hintPending;
    return { result: taken.map(t => ({ ...t })), changed: taken.length > 0 };
  });
}

/**
 * Altbestand aus #290/#291: offene Fäden ohne nextReminderAt bekommen
 * nextReminderTime(now, deadline), damit nach dem Update nicht alle auf
 * einmal erinnern. Gibt die Zahl der geänderten zurück.
 */
export async function fillMissingReminders(env: Record<string, string | undefined> = process.env, at?: number): Promise<number> {
  return updateStore<number>((threads, storeNow) => {
    const now = at ?? storeNow;
    let n = 0;
    for (const t of Object.values(threads)) {
      if (t.state !== "open" || t.nextReminderAt !== undefined) continue;
      t.nextReminderAt = nextReminderTime(now, t.deadline, env);
      n++;
    }
    return { result: n, changed: n > 0 };
  });
}

/**
 * Änderung an Fäden unter der Sperre für den Zeitgeber der Erinnerungen
 * (remind.ts): fn bekommt die Ablage und die Zeit, gibt Ergebnis und
 * "geändert" zurück. Schließen geht über closeThreadIn, damit Grund und
 * Zeitpunkt stimmen und onThreadsClosed meldet.
 */
export function updateThreads<T>(fn: (threads: Record<string, Thread>, now: number) => { result: T; changed: boolean }): Promise<T> {
  return updateStore<T>((threads, now) => fn(threads, now));
}

/** Schließt einen offenen Faden innerhalb von updateThreads */
export function closeThreadIn(t: Thread, reason: string, now: number): void {
  if (t.state === "open") close(t, reason, now);
}
