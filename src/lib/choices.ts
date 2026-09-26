/**
 * Rückfragen-Register (Issue #113, Entscheidung 0017).
 *
 * Eine offene Rückfrage mit Knöpfen (Werkzeug-Freigabe, Merk-Vorschlag,
 * /goal "Weiter?", Topic-Zuordnung) steht hier genau einmal und wird genau
 * einmal entschieden, egal ob der Klick aus Telegram, dem Browser oder dem
 * Terminal kommt.
 *
 * Ablage: data/choices.json. Bot und Sprach-Brücke laufen in eigenen
 * Prozessen, deshalb wie bei data/pending-reviews.json kein Cache: jede
 * Änderung liest die Datei frisch unter einer Sperre mit Besitzer
 * (file-lock.ts, <datei>.lock) und schreibt atomar zurück (atomic-file.ts).
 * Lesen geht ohne Sperre, weil Schreiben die Datei nur als Ganzes ersetzt.
 *
 * Genau einmal heißt:
 * - Die Entscheidung selbst ist atomar: nur der erste decideChoice für eine
 *   offene Frage gewinnt, auch über Prozessgrenzen hinweg.
 * - Der Handler der Art (onChoiceDecided) läuft nur im Gewinnerprozess, erst
 *   nachdem die Entscheidung gespeichert ist, und außerhalb der Sperre.
 *   Stürzt der Prozess zwischen Speichern und Handler ab, läuft der Handler
 *   nie; die Frage bleibt entschieden (lieber einmal zu wenig als doppelt).
 * - Ist für die Art kein Handler registriert, gilt die Entscheidung trotzdem;
 *   das wird geloggt und als handlerError an der Frage vermerkt.
 * - Wirft der Handler, bleibt die Frage done mit ihrem Ergebnis, der Fehler
 *   wird geloggt und als handlerError gespeichert. Nichts löst ihn erneut aus.
 *
 * Zuhörer (onChoiceChange) sind prozesslokal: sie hören nur Änderungen, die
 * dieser Prozess macht. Andere Prozesse sehen den neuen Stand beim nächsten
 * Lesen der Datei.
 *
 * Knöpfe: callback_data "ch|<id>|<key>", höchstens 64 Byte (Grenze von Telegram).
 */

import { mkdir, readFile, rename } from "fs/promises";
import { randomInt } from "crypto";
import { dirname, join } from "path";
import { acquireFileLock, releaseFileLock } from "./file-lock";
import { atomicWriteFile } from "./atomic-file";

// ---------------------------------------------------------------------------
// Datenmodell
// ---------------------------------------------------------------------------

export const CHOICE_KINDS = ["tool", "review", "goal", "topicmap"] as const;
export type ChoiceKind = (typeof CHOICE_KINDS)[number];

export const CHOICE_CHANNELS = ["telegram", "web", "terminal"] as const;
export type ChoiceChannel = (typeof CHOICE_CHANNELS)[number];

export type ChoiceState = "open" | "done" | "expired";

/** Gespräch, zu dem die Frage gehört: Telegram-Chat (optional Topic) oder Web-Gespräch */
export type ChoiceConversation =
  | { type: "telegram"; chatId: string; topicId?: number }
  | { type: "web"; conversationId: string };

export interface ChoiceTelegramRef {
  chatId: string;
  messageId: number;
}

export interface ChoiceOption {
  /** Kurzer Schlüssel für callback_data: A-Z, a-z, 0-9, _ und -, 1 bis 32 Zeichen (Agenten-IDs bis 30, Issue #119) */
  key: string;
  label: string;
}

export interface ChoiceResult {
  key: string;
  label: string;
  via: ChoiceChannel;
  at: number;
}

export interface Choice {
  /** Kurz, URL- und callback_data-tauglich (A-Z, a-z, 0-9), höchstens 12 Zeichen */
  id: string;
  kind: ChoiceKind;
  conversation: ChoiceConversation;
  text: string;
  /** Mindestens 1 Option mit eindeutigen Schlüsseln, höchstens CHOICE_OPTIONS_MAX (außer "topicmap") */
  options: ChoiceOption[];
  state: ChoiceState;
  /** Nur bei state "done" gesetzt */
  result?: ChoiceResult;
  createdAt: number;
  expiresAt?: number;
  /** Bezug, z.B. Review-ID, Goal-ID, Freigabe-ID */
  ref?: string;
  /** Telegram-Nachrichten mit den Knöpfen (Issue #114, attachChoiceTelegram) */
  telegram?: ChoiceTelegramRef[];
  /** Handler fehlte oder ist gescheitert; die Entscheidung bleibt trotzdem gültig */
  handlerError?: { message: string; at: number };
  /**
   * Offen älter als CHOICE_MAX_AGE_MS geworden, mit Telegram-Nachricht: schon
   * expired, aber noch nicht gemeldet. expireLapsedChoices meldet den Ablauf
   * und entfernt den Eintrag erst dann.
   */
  unannounced?: true;
}

export interface CreateChoiceInput {
  kind: ChoiceKind;
  conversation: ChoiceConversation;
  text: string;
  options: ChoiceOption[];
  expiresAt?: number;
  ref?: string;
}

export const CHOICE_ID_MAX = 12;
const CHOICE_ID_LENGTH = 10;
const ID_RE = /^[A-Za-z0-9]{1,12}$/;
const KEY_RE = /^[A-Za-z0-9_-]{1,32}$/;
const ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
/**
 * Höchstzahl der Optionen, als Schutz vor unsinnig großen Einträgen. Gilt
 * nicht für die Art "topicmap" (Issue #119): die Topic-Zuordnung bietet
 * jeden aktiven Agenten an, dort begrenzt allein der Agenten-Katalog die
 * Zahl, damit jeder Agent auswählbar bleibt. Die Grenze von Telegram
 * (100 Knöpfe je Nachricht) gilt hier nicht: sendChoice verteilt die Knöpfe
 * auf mehrere Nachrichten.
 */
export const CHOICE_OPTIONS_MAX = 1000;
/** Arten ohne Höchstzahl der Optionen (siehe CHOICE_OPTIONS_MAX) */
const UNBOUNDED_OPTION_KINDS: readonly ChoiceKind[] = ["topicmap"];
/**
 * Einträge älter als das (offen oder nicht) werden bei jeder Änderung entfernt,
 * bevor sie greift. Ausnahme: offene mit Telegram-Nachricht laufen erst ab und
 * bleiben, bis expireLapsedChoices die Nachricht nachgezogen hat (unannounced).
 */
export const CHOICE_MAX_AGE_MS = 7 * 24 * 3_600_000;
export const CALLBACK_DATA_MAX_BYTES = 64;

// ---------------------------------------------------------------------------
// Ablage
// ---------------------------------------------------------------------------

const DEFAULT_CHOICES_FILE = join(process.cwd(), "data", "choices.json");
let choicesFile = DEFAULT_CHOICES_FILE;

/** Nur für Tests: Ablage umlenken, null stellt zurück. */
export function setChoicesFileForTests(path: string | null): void {
  choicesFile = path ?? DEFAULT_CHOICES_FILE;
}

interface StoreFile {
  version: 1;
  choices: Record<string, Choice>;
}

function log(message: string): void {
  console.log(`[choices] ${message}`);
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

function optionsProblem(options: unknown, kind: ChoiceKind): string | null {
  if (!Array.isArray(options) || options.length < 1) return "keine Optionen angegeben";
  if (options.length > CHOICE_OPTIONS_MAX && !UNBOUNDED_OPTION_KINDS.includes(kind)) {
    return `1 bis ${CHOICE_OPTIONS_MAX} Optionen erwartet`;
  }
  const seen = new Set<string>();
  for (const o of options) {
    if (!o || typeof o.key !== "string" || !KEY_RE.test(o.key)) return `ungültiger Optionsschlüssel ${JSON.stringify(o?.key)}`;
    if (typeof o.label !== "string" || o.label.trim() === "") return `leere Beschriftung bei ${o.key}`;
    if (seen.has(o.key)) return `doppelter Optionsschlüssel ${o.key}`;
    seen.add(o.key);
  }
  return null;
}

function isChoice(id: string, c: any): c is Choice {
  if (!c || typeof c !== "object" || c.id !== id || !ID_RE.test(id)) return false;
  if (!CHOICE_KINDS.includes(c.kind) || !isConversation(c.conversation)) return false;
  if (typeof c.text !== "string" || optionsProblem(c.options, c.kind) !== null) return false;
  if (typeof c.createdAt !== "number" || (c.expiresAt !== undefined && typeof c.expiresAt !== "number")) return false;
  if (c.unannounced !== undefined && !(c.unannounced === true && c.state === "expired")) return false;
  if (c.state === "done") {
    const r = c.result;
    return !!r && typeof r.key === "string" && typeof r.label === "string" &&
      CHOICE_CHANNELS.includes(r.via) && typeof r.at === "number";
  }
  return (c.state === "open" || c.state === "expired") && c.result === undefined;
}

function isTelegramRef(r: any): r is ChoiceTelegramRef {
  return !!r && typeof r === "object" && typeof r.chatId === "string" && /^-?\d{1,20}$/.test(r.chatId) &&
    Number.isSafeInteger(r.messageId) && r.messageId > 0;
}

/** Nur gültige Telegram-Bezüge behalten; ohne gültigen fehlt das Feld. */
function cleanTelegramRefs(c: Choice): Choice {
  if (c.telegram === undefined) return c;
  const refs = Array.isArray(c.telegram) ? c.telegram.filter(isTelegramRef).map(r => ({ chatId: r.chatId, messageId: r.messageId })) : [];
  const { telegram: _old, ...rest } = c;
  return refs.length > 0 ? { ...rest, telegram: refs } : rest;
}

type ReadOutcome = { ok: true; store: StoreFile } | { ok: false; reason: string };

/** Liest die Ablage; fehlende Datei ist leer, kaputte Datei meldet ok: false. */
async function readStore(file: string): Promise<ReadOutcome> {
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch (error: any) {
    if (error.code === "ENOENT") return { ok: true, store: { version: 1, choices: {} } };
    return { ok: false, reason: `nicht lesbar (${error.code || error.message})` };
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "kein gültiges JSON" };
  }
  if (!parsed || typeof parsed !== "object" || parsed.version !== 1 ||
      !parsed.choices || typeof parsed.choices !== "object" || Array.isArray(parsed.choices)) {
    return { ok: false, reason: "unbekannte Struktur" };
  }
  const choices: Record<string, Choice> = {};
  for (const [id, c] of Object.entries(parsed.choices)) {
    if (isChoice(id, c)) choices[id] = cleanTelegramRefs(c);
    else log(`ungültiger Eintrag ${JSON.stringify(id)} in ${file} übersprungen`);
  }
  return { ok: true, store: { version: 1, choices } };
}

/** Wie readStore, aber eine kaputte Datei zählt als leer (nur Lesen, nichts wird überschrieben). */
async function readForView(): Promise<Record<string, Choice>> {
  const outcome = await readStore(choicesFile);
  if (outcome.ok) return outcome.store.choices;
  log(`${choicesFile} ${outcome.reason}, gelesen als leer`);
  return {};
}

/**
 * Wie readForView, wirft aber, wenn die Ablage nicht lesbar ist (Issue #115):
 * die WebUI darf einen Lesefehler nicht als verschwundene, also abgelaufene
 * Fragen anzeigen. Fehlt die Datei, ist die Ablage leer wie sonst auch.
 */
async function readChecked(): Promise<Record<string, Choice>> {
  const outcome = await readStore(choicesFile);
  if (outcome.ok) return outcome.store.choices;
  throw new Error(`Rückfragen-Ablage ${outcome.reason}`);
}

// Innerhalb des Prozesses reiht storeTail die Änderungen auf, die Sperre
// schützt gegen andere Prozesse.
let storeTail: Promise<unknown> = Promise.resolve();

/**
 * Liest, ändert und schreibt die Ablage unter Sperre; fn gibt zurück, ob
 * geschrieben werden muss. Eine kaputte Datei wird nicht still überschrieben,
 * sondern daneben als <datei>.kaputt-<zeit> aufbewahrt (mit Log), dann geht es
 * mit einer leeren Ablage weiter.
 */
function updateStore<T>(fn: (choices: Record<string, Choice>, now: number) => { result: T; changed: boolean }): Promise<T> {
  const file = choicesFile;
  const run = storeTail.catch(() => {}).then(async () => {
    await mkdir(dirname(file), { recursive: true });
    const lockFile = `${file}.lock`;
    const lock = await acquireFileLock(lockFile);
    try {
      const outcome = await readStore(file);
      let choices: Record<string, Choice>;
      let changed = false;
      if (outcome.ok) {
        choices = outcome.store.choices;
      } else {
        const backup = `${file}.kaputt-${Date.now()}`;
        await rename(file, backup);
        log(`${file} ${outcome.reason}, aufbewahrt als ${backup}, weiter mit leerer Ablage`);
        choices = {};
        changed = true;
      }
      const now = Date.now();
      // Vor fn aufräumen: eine Frage außerhalb der Aufbewahrung ist für fn
      // schon unbekannt oder abgelaufen und kann nicht mehr entschieden werden.
      // Offene mit Telegram-Nachricht nicht löschen, sonst gehen die Bezüge
      // verloren und die Knöpfe bleiben stehen: expired + unannounced, bis
      // expireLapsedChoices nachzieht und entfernt
      const cutoff = now - CHOICE_MAX_AGE_MS;
      for (const [id, c] of Object.entries(choices)) {
        if (c.createdAt >= cutoff || c.unannounced) continue;
        if (c.state === "open" && (c.telegram?.length ?? 0) > 0) {
          c.state = "expired";
          c.unannounced = true;
        } else {
          delete choices[id];
        }
        changed = true;
      }
      const r = fn(choices, now);
      if (r.changed || changed) {
        const store: StoreFile = { version: 1, choices };
        await atomicWriteFile(file, JSON.stringify(store, null, 2));
      }
      return r.result;
    } finally {
      await releaseFileLock(lockFile, lock).catch(() => {});
    }
  });
  storeTail = run;
  return run;
}

function lapsed(c: Choice, now: number): boolean {
  return c.state === "open" && c.expiresAt !== undefined && c.expiresAt <= now;
}

/** Sicht nach außen: eine offene Frage mit überschrittenem expiresAt gilt als expired. */
function effective(c: Choice, now: number): Choice {
  return lapsed(c, now) ? { ...c, state: "expired" } : c;
}

function newId(taken: Record<string, Choice>): string {
  for (;;) {
    let id = "";
    for (let i = 0; i < CHOICE_ID_LENGTH; i++) id += ID_ALPHABET[randomInt(ID_ALPHABET.length)];
    if (!Object.prototype.hasOwnProperty.call(taken, id)) return id;
  }
}

function has(choices: Record<string, Choice>, id: string): boolean {
  return Object.prototype.hasOwnProperty.call(choices, id);
}

// ---------------------------------------------------------------------------
// Zuhörer und Handler (prozesslokal)
// ---------------------------------------------------------------------------

export type ChoiceChangeType = "created" | "decided" | "expired" | "handler-error";
export type ChoiceChangeListener = (change: { type: ChoiceChangeType; choice: Choice }) => void | Promise<void>;
export type ChoiceHandler = (choice: Choice) => void | Promise<void>;

const listeners = new Set<ChoiceChangeListener>();
const handlers = new Map<ChoiceKind, ChoiceHandler>();

/** Meldet Änderungen dieses Prozesses; gibt eine Abmelde-Funktion zurück. */
export function onChoiceChange(listener: ChoiceChangeListener): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Handler für eine Art; ersetzt einen früheren. Gibt eine Abmelde-Funktion zurück. */
export function onChoiceDecided(kind: ChoiceKind, handler: ChoiceHandler): () => void {
  handlers.set(kind, handler);
  return () => { if (handlers.get(kind) === handler) handlers.delete(kind); };
}

async function emit(type: ChoiceChangeType, choice: Choice): Promise<void> {
  for (const listener of [...listeners]) {
    try {
      await listener({ type, choice });
    } catch (error: any) {
      log(`Zuhörer scheiterte bei ${type} ${choice.id}: ${error?.message || error}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Funktionen
// ---------------------------------------------------------------------------

/** Legt eine offene Frage an. Wirft bei ungültiger Eingabe oder wenn das Speichern scheitert. */
export async function createChoice(input: CreateChoiceInput): Promise<Choice> {
  if (!CHOICE_KINDS.includes(input.kind)) throw new Error(`unbekannte Art ${JSON.stringify(input.kind)}`);
  if (!isConversation(input.conversation)) throw new Error("ungültiges Gespräch");
  if (typeof input.text !== "string" || input.text.trim() === "") throw new Error("leerer Fragetext");
  const problem = optionsProblem(input.options, input.kind);
  if (problem) throw new Error(problem);
  if (input.expiresAt !== undefined && !Number.isFinite(input.expiresAt)) throw new Error("ungültiges expiresAt");

  const choice = await updateStore(choices => {
    const c: Choice = {
      id: newId(choices),
      kind: input.kind,
      conversation: { ...input.conversation },
      text: input.text,
      options: input.options.map(o => ({ key: o.key, label: o.label })),
      state: "open",
      createdAt: Date.now(),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      ...(input.ref !== undefined ? { ref: input.ref } : {}),
    };
    choices[c.id] = c;
    return { result: c, changed: true };
  });
  await emit("created", choice);
  return choice;
}

/** Offene Frage mit überschrittener Frist, deren Ablauf noch nicht gespeichert ist */
export function isLapsed(c: Choice, now = Date.now()): boolean {
  return lapsed(c, now);
}

/** Eine Frage nach ID; abgelaufene erscheinen als expired. undefined: unbekannt. */
export async function getChoice(id: string): Promise<Choice | undefined> {
  const choices = await readForView();
  return has(choices, id) ? effective(choices[id], Date.now()) : undefined;
}

/**
 * Wie getChoice für die WebUI (Issue #115), wirft aber, wenn die Ablage nicht
 * lesbar ist, statt die Frage als unbekannt zu melden.
 */
export async function getChoiceChecked(id: string): Promise<Choice | undefined> {
  const choices = await readChecked();
  return has(choices, id) ? effective(choices[id], Date.now()) : undefined;
}

/**
 * Alle Fragen im Register (Issue #115: Abgleich der WebUI mit Änderungen
 * anderer Prozesse); abgelaufene erscheinen als expired. Wirft, wenn die
 * Ablage nicht lesbar ist: ein Lesefehler ist kein leeres Register.
 */
export async function listChoices(): Promise<Choice[]> {
  const now = Date.now();
  return Object.values(await readChecked()).map(c => effective(c, now));
}

function sameConversation(a: ChoiceConversation, b: ChoiceConversation): boolean {
  if (a.type === "telegram" && b.type === "telegram") return a.chatId === b.chatId && a.topicId === b.topicId;
  if (a.type === "web" && b.type === "web") return a.conversationId === b.conversationId;
  return false;
}

/** Offene Fragen genau dieses Gesprächs (Telegram-Chat ohne Topic ist ein anderes Gespräch als mit), älteste zuerst. */
export async function listOpenChoices(conversation: ChoiceConversation): Promise<Choice[]> {
  const now = Date.now();
  return Object.values(await readForView())
    .map(c => effective(c, now))
    .filter(c => c.state === "open" && sameConversation(c.conversation, conversation))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export type DecideOutcome =
  | { status: "decided"; choice: Choice }
  | { status: "already"; choice: Choice }
  | { status: "expired" }
  | { status: "unknown" }
  | { status: "invalid_key"; choice: Choice };

type InnerOutcome = DecideOutcome | { status: "lapsed"; choice: Choice };

/**
 * Entscheidet eine offene Frage. Nur der erste Aufruf gewinnt ("decided"),
 * jeder weitere bekommt "already" mit dem ersten Ergebnis. Ein unbekannter
 * Schlüssel wird abgelehnt ("invalid_key") und lässt die Frage offen.
 */
export async function decideChoice(id: string, key: string, via: ChoiceChannel): Promise<DecideOutcome> {
  if (!CHOICE_CHANNELS.includes(via)) throw new Error(`unbekannter Kanal ${JSON.stringify(via)}`);
  const outcome = await updateStore<InnerOutcome>((choices, now) => {
    if (!has(choices, id)) return { result: { status: "unknown" }, changed: false };
    const c = choices[id];
    if (c.state === "done") return { result: { status: "already", choice: c }, changed: false };
    if (c.state === "expired") return { result: { status: "expired" }, changed: false };
    if (lapsed(c, now)) {
      c.state = "expired";
      return { result: { status: "lapsed", choice: c }, changed: true };
    }
    const option = c.options.find(o => o.key === key);
    if (!option) return { result: { status: "invalid_key", choice: c }, changed: false };
    c.state = "done";
    c.result = { key: option.key, label: option.label, via, at: now };
    return { result: { status: "decided", choice: c }, changed: true };
  });

  if (outcome.status === "lapsed") {
    await emit("expired", outcome.choice);
    return { status: "expired" };
  }
  if (outcome.status !== "decided") return outcome;

  // Gewonnen und gespeichert: jetzt, außerhalb der Sperre, Zuhörer und Handler
  let choice = outcome.choice;
  await emit("decided", choice);
  const handler = handlers.get(choice.kind);
  let failure: string | null = null;
  if (!handler) {
    failure = `kein Handler für ${choice.kind} registriert`;
  } else {
    try {
      await handler(choice);
    } catch (error: any) {
      failure = String(error?.message || error);
    }
  }
  if (failure !== null) {
    log(`Frage ${choice.id} (${choice.kind}) entschieden, aber ${failure}`);
    choice = (await recordHandlerError(choice.id, failure)) ?? { ...choice, handlerError: { message: failure, at: Date.now() } };
    await emit("handler-error", choice);
  }
  return { status: "decided", choice };
}

/** Vermerkt einen Handlerfehler; ändert weder state noch result. */
async function recordHandlerError(id: string, message: string): Promise<Choice | undefined> {
  try {
    return await updateStore<Choice | undefined>(choices => {
      if (!has(choices, id) || choices[id].state !== "done") return { result: undefined, changed: false };
      choices[id].handlerError = { message, at: Date.now() };
      return { result: choices[id], changed: true };
    });
  } catch (error: any) {
    log(`Handlerfehler für ${id} nicht gespeichert: ${error?.message || error}`);
    return undefined;
  }
}

export type ExpireOutcome =
  | { status: "expired"; choice: Choice }
  | { status: "already"; choice: Choice }
  | { status: "unknown" };

/**
 * Lässt eine offene Frage ablaufen. Eine entschiedene bleibt done
 * ("already" mit Ergebnis), eine schon abgelaufene meldet "already".
 */
export async function expireChoice(id: string): Promise<ExpireOutcome> {
  const outcome = await updateStore<ExpireOutcome>(choices => {
    if (!has(choices, id)) return { result: { status: "unknown" }, changed: false };
    const c = choices[id];
    if (c.state !== "open") return { result: { status: "already", choice: c }, changed: false };
    c.state = "expired";
    return { result: { status: "expired", choice: c }, changed: true };
  });
  if (outcome.status === "expired") await emit("expired", outcome.choice);
  return outcome;
}

/**
 * Läuft offene Fragen mit überschrittener Frist ab (Issue #114): getChoice
 * zeigt sie nur rechnerisch als expired, erst das hier speichert den Ablauf
 * und meldet "expired" an die Zuhörer. Für einen regelmäßigen Lauf und den
 * Abgleich beim Start des Bots. Gibt die abgelaufenen Fragen zurück.
 *
 * Fragen, die wegen ihres Alters schon abgelaufen, aber noch nicht gemeldet
 * sind (unannounced), werden hier gemeldet und dabei entfernt; ein zweiter
 * Lauf findet sie nicht mehr.
 */
export async function expireLapsedChoices(): Promise<Choice[]> {
  const expired = await updateStore<Choice[]>((choices, now) => {
    const out: Choice[] = [];
    for (const c of Object.values(choices)) {
      if (c.unannounced) {
        delete choices[c.id];
        const { unannounced: _flag, ...rest } = c;
        out.push(rest);
        continue;
      }
      if (!lapsed(c, now)) continue;
      c.state = "expired";
      out.push(c);
    }
    return { result: out, changed: out.length > 0 };
  });
  for (const c of expired) await emit("expired", c);
  return expired;
}

/**
 * Merkt Telegram-Nachrichten mit den Knöpfen einer Frage (Issue #114), unter
 * derselben Sperre wie jede Änderung; schon gemerkte werden nicht doppelt
 * eingetragen. Gibt den gespeicherten Stand danach zurück (state wie
 * gespeichert, also nicht rechnerisch abgelaufen), undefined bei unbekannter
 * Frage. Die Bezüge werden in jedem Zustand gemerkt: wer sendet, sieht so,
 * ob die Frage während des Sendens entschieden wurde oder abgelaufen ist, und
 * muss die Nachricht dann selbst nachziehen.
 */
export async function attachChoiceTelegram(id: string, refs: ChoiceTelegramRef[]): Promise<Choice | undefined> {
  const valid = refs.filter(isTelegramRef).map(r => ({ chatId: r.chatId, messageId: r.messageId }));
  return updateStore<Choice | undefined>(choices => {
    if (!has(choices, id)) return { result: undefined, changed: false };
    const c = choices[id];
    const known = c.telegram ?? [];
    const added = valid.filter(r => !known.some(k => k.chatId === r.chatId && k.messageId === r.messageId));
    const unique = added.filter((r, i) => added.findIndex(o => o.chatId === r.chatId && o.messageId === r.messageId) === i);
    if (unique.length === 0) return { result: c, changed: false };
    c.telegram = [...known, ...unique];
    return { result: c, changed: true };
  });
}

// ---------------------------------------------------------------------------
// callback_data für Telegram-Knöpfe
// ---------------------------------------------------------------------------

/** "ch|<id>|<key>" (höchstens 3 + 12 + 1 + 32 = 48 Byte); wirft bei ungültiger ID, ungültigem Schlüssel oder mehr als 64 Byte. */
export function choiceCallbackData(id: string, key: string): string {
  if (!ID_RE.test(id)) throw new Error(`ungültige Rückfrage-ID ${JSON.stringify(id)}`);
  if (!KEY_RE.test(key)) throw new Error(`ungültiger Optionsschlüssel ${JSON.stringify(key)}`);
  const data = `ch|${id}|${key}`;
  if (Buffer.byteLength(data, "utf-8") > CALLBACK_DATA_MAX_BYTES) throw new Error("callback_data länger als 64 Byte");
  return data;
}

/** Zerlegt "ch|<id>|<key>"; null bei allem anderen (auch alte Knöpfe wie "rev|..."). */
export function parseChoiceCallbackData(data: unknown): { id: string; key: string } | null {
  if (typeof data !== "string" || Buffer.byteLength(data, "utf-8") > CALLBACK_DATA_MAX_BYTES) return null;
  const parts = data.split("|");
  if (parts.length !== 3 || parts[0] !== "ch") return null;
  const [, id, key] = parts;
  if (!ID_RE.test(id) || !KEY_RE.test(key)) return null;
  return { id, key };
}
