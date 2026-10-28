/**
 * Offene Fäden erkennen (Issue #290, Entscheidung 0025).
 *
 * Nach einem Turn aus Telegram oder dem Browser prüft das Aux-Modell (Zweck
 * "threads"), ob die Antwort mit einer echten Frage oder offenen Entscheidung
 * an den Nutzer endet, und legt dann einen Faden an (store.ts).
 *
 * Ablauf (detectThread):
 * 1. THREADS=off: nichts, kein Aufruf.
 * 2. Vorfilter ohne Modell: Code-Blöcke und Steuer-Tags entfernen, dann muss
 *    das Endstück (THREADS_TAIL_CHARS) ein "?" oder eine
 *    Entscheidungs-Formulierung (DECISION_PHRASES) enthalten.
 * 3. Kein Faden, wenn im Gespräch seit Beginn des Turns eine Rückfrage im
 *    Register entstanden ist (gleich welcher Zustand) oder eine
 *    ask_user-Aufgabe auf Antwort wartet: die haben eigene Erinnerungen.
 * 4. Aux-Aufruf, Antwort als JSON, streng geprüft. Fehler, Zeitüberschreitung
 *    oder ungültiges JSON: kein Faden, eine Log-Zeile mit Gesprächskennung.
 * 5. Anlegen; dieselbe Frage im selben Gespräch gibt es nur einmal.
 *
 * noteTurnForThreads startet das ohne zu warten und fängt jeden Fehler: die
 * Antwort an den Nutzer wartet nie auf die Erkennung. Vor der Erkennung läuft
 * das Auflösen (resolve.ts, Issue #291): erst schließen, was die Nachricht
 * beantwortet, dann einen neuen Faden anlegen. Je Gespräch laufen die Turns
 * nacheinander, damit eine schnelle Folgenachricht den Faden der vorigen
 * Antwort schon sieht. Ins Log kommen nur Faden- und Gesprächskennungen, nie
 * Fragen oder Antworten.
 */

import { Marked, type Token, type Tokens } from "marked";
import { callAux as realCallAux, parseAuxJSON, type AuxPurpose, type AuxResult } from "../aux-model";
import { listChoices as realListChoices, type Choice, type ChoiceConversation } from "../choices";
import { resolveThreads, type ThreadResolveDeps } from "./resolve";
import { createThread as realCreateThread, isCalendarDate, threadsEnabled, type CreateThreadInput, type CreateThreadOutcome } from "./store";

export { threadsEnabled };

/** Länge des Endstücks der bereinigten Antwort für den Vorfilter */
export const THREADS_TAIL_CHARS = 600;
/** So viel der bereinigten Antwort bekommt das Aux-Modell */
export const THREADS_REPLY_CHARS = 1_500;
/** So viel der Nutzer-Nachricht bekommt das Aux-Modell */
export const THREADS_USER_CHARS = 500;
/** Höchstdauer eines Aux-Aufrufs */
export const THREADS_TIMEOUT_MS = 60_000;

/**
 * Formulierungen, mit denen eine Antwort eine Entscheidung beim Nutzer lässt,
 * ohne ein Fragezeichen zu setzen. Verglichen in Kleinbuchstaben.
 */
export const DECISION_PHRASES = [
  "sag mir",
  "sag bescheid",
  "sag einfach",
  "gib bescheid",
  "gib mir bescheid",
  "entscheide",
  "entscheidest",
  "deine entscheidung",
  "welche variante",
  "welche option",
  "lass mich wissen",
  "lass es mich wissen",
  "melde dich",
  "bitte bestätige",
  "dein okay",
  "dein ok",
  "let me know",
  "your call",
  "which option",
] as const;

const STEER_TAGS = /\[(?:REMEMBER|GOAL|DONE|CANCEL|FORGET|REMIND|INVOKE|ASSET_DESC)\s*:[^\]]*\]/gi;
const lexer = new Marked({ gfm: true });

/** Text der Blöcke ohne Codeblöcke; Zitate und Listen werden durchlaufen. */
function withoutCode(tokens: Token[]): string {
  const out: string[] = [];
  for (const token of tokens) {
    if (token.type === "code") out.push("");
    else if (token.type === "blockquote") out.push(withoutCode((token as Tokens.Blockquote).tokens));
    else if (token.type === "list") out.push(...(token as Tokens.List).items.map(item => withoutCode(item.tokens)));
    else out.push(token.raw);
  }
  return out.join("\n");
}

/**
 * Markdown-Codeblöcke entfernen, so wie der Markdown-Parser (marked, GFM) sie
 * erkennt: umzäunt (auch offen am Ende) und eingerückt, auch innerhalb von
 * Zitaten und Listen oder direkt nach einer Überschrift.
 */
function stripCodeBlocks(text: string): string {
  return withoutCode(lexer.lexer(text));
}

/** Antwort ohne Code-Blöcke (umzäunt, auch offen am Ende, und eingerückt) und ohne Steuer-Tags. */
export function cleanReply(reply: string): string {
  return stripCodeBlocks(reply.replace(/\r\n?/g, "\n")).replace(STEER_TAGS, " ").replace(/[ \t]+\n/g, "\n").trim();
}

/** Vorfilter: "?" oder Entscheidungs-Formulierung im bereinigten Endstück. */
export function passesPrefilter(reply: string): boolean {
  const tail = cleanReply(reply).slice(-THREADS_TAIL_CHARS);
  if (tail.includes("?")) return true;
  const lower = tail.toLowerCase();
  return DECISION_PHRASES.some(p => lower.includes(p));
}

/** Kennung eines Gesprächs fürs Log, ohne Inhalt */
export function conversationKey(c: ChoiceConversation): string {
  return c.type === "web" ? `web:${c.conversationId}` : c.topicId !== undefined ? `tg:${c.chatId}:${c.topicId}` : `tg:${c.chatId}`;
}

const TELEGRAM_CHAT = /^(-?\d{1,20}|web)$/;
const WEB_CHAT = /^web:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;

/**
 * Gespräch eines Turns aus Chat und Topic, wie bei Merk-Vorschlägen
 * (reviewConversation): web:<uuid> ist ein reines Web-Gespräch, "web" der
 * Web-Direktchat ohne Telegram, sonst ein Telegram-Chat (Topic nur, wenn
 * gesetzt; General und Direktchat ohne). null bei unbekanntem Chat.
 */
export function threadConversation(chatId: string, topicId?: number | null): ChoiceConversation | null {
  const web = WEB_CHAT.exec(chatId);
  if (web) return { type: "web", conversationId: web[1] };
  if (!TELEGRAM_CHAT.test(chatId)) return null;
  return typeof topicId === "number" && Number.isInteger(topicId) ? { type: "telegram", chatId, topicId } : { type: "telegram", chatId };
}

/** Chat-ID, unter der ask_user-Aufgaben eines Gesprächs liegen (reine Web-Gespräche: web:<id>) */
function taskChatId(c: ChoiceConversation): string {
  return c.type === "web" ? `web:${c.conversationId}` : c.chatId;
}

function sameConversation(a: ChoiceConversation, b: ChoiceConversation): boolean {
  if (a.type === "telegram" && b.type === "telegram") return a.chatId === b.chatId && a.topicId === b.topicId;
  if (a.type === "web" && b.type === "web") return a.conversationId === b.conversationId;
  return false;
}

/** Datum und Wochentag in der Zeitzone des Nutzers, etwa "2026-10-15 (Donnerstag)" */
export function referenceDate(now: Date, timeZone: string): string {
  let zone = timeZone;
  try {
    new Intl.DateTimeFormat("de-DE", { timeZone: zone });
  } catch {
    zone = "UTC";
  }
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const weekday = new Intl.DateTimeFormat("de-DE", { timeZone: zone, weekday: "long" }).format(now);
  return `${parts} (${weekday})`;
}

export function buildThreadsPrompt(input: { reply: string; userText: string; now: Date; timeZone: string }): string {
  const reply = cleanReply(input.reply).slice(-THREADS_REPLY_CHARS);
  const user = input.userText.trim().slice(-THREADS_USER_CHARS);
  return `Du prüfst, ob eine Antwort eines Assistenten mit einer echten, offenen Frage oder Entscheidung an den Nutzer endet, auf die der Nutzer noch antworten muss.

Heute ist ${referenceDate(input.now, input.timeZone)}, Zeitzone ${input.timeZone}. Rechne relative Fristen ("bis Freitag", "morgen", "Ende des Monats") von diesem Datum aus in ein Kalenderdatum um.

Zählt als offen:
- eine Frage, deren Antwort der Assistent braucht, um weiterzumachen
- eine Entscheidung zwischen Varianten, die der Nutzer treffen soll
- eine Bitte um Bestätigung, bevor der Assistent etwas tut ("Soll ich die Issues anlegen?")

Zählt NICHT als offen:
- rhetorische Fragen
- Höflichkeitsfloskeln und allgemeine Angebote ("Soll ich noch etwas tun?", "Noch Fragen?", "Kann ich sonst helfen?", "Melde dich, wenn du mehr brauchst")
- Fragen, die der Assistent selbst beantwortet
- Angebote ohne Entscheidung des Nutzers ("Wenn du willst, kann ich auch ...")
- Fragen, die nicht am Ende der Antwort stehen

Nutzer-Nachricht (Ende):
"""
${user}
"""

Antwort des Assistenten (Ende):
"""
${reply}
"""

Antworte nur mit JSON, ohne weiteren Text:
{"open": true|false, "topic": "Thema in einem Satz", "context": "ein bis zwei Sätze, worum es geht", "question": "die offene Frage", "deadline": "YYYY-MM-DD" oder null}
Bei "open": false dürfen die anderen Felder leer sein. Eine Frist nur, wenn im Text eine genannt ist.`;
}

/** Geprüfte Ausgabe des Aux-Modells */
export type ThreadVerdict =
  | { open: false }
  | { open: true; topic: string; context: string; question: string; deadline?: string };

const FIELD_MAX = { topic: 200, context: 500, question: 500 } as const;

/** Prüft die JSON-Ausgabe streng; null, wenn sie nicht dem Schema entspricht. */
export function parseVerdict(text: string): ThreadVerdict | null {
  const raw = parseAuxJSON(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || typeof raw.open !== "boolean") return null;
  if (!raw.open) return { open: false };
  const fields: Record<string, string> = {};
  for (const key of ["topic", "context", "question"] as const) {
    const v = raw[key];
    if (typeof v !== "string" || v.trim() === "") return null;
    fields[key] = v.trim().slice(0, FIELD_MAX[key]);
  }
  const deadline = raw.deadline;
  if (deadline !== undefined && deadline !== null && !isCalendarDate(deadline)) return null;
  return {
    open: true,
    topic: fields.topic,
    context: fields.context,
    question: fields.question,
    ...(typeof deadline === "string" ? { deadline } : {}),
  };
}

/** ask_user-Aufgabe, die auf Antwort wartet (Ausschnitt aus AsyncTask) */
export interface PendingAskUser {
  chat_id: string;
  thread_id?: number | null;
}

export interface ThreadDetectDeps {
  callAux(purpose: AuxPurpose, prompt: string, opts: { timeoutMs: number; quiet: true }): Promise<AuxResult>;
  createThread(input: CreateThreadInput): Promise<CreateThreadOutcome>;
  listChoices(): Promise<Choice[]>;
  /** Wartende ask_user-Aufgaben eines Chats (getStore().tasks.pending) */
  pendingAskUser(chatId: string): Promise<PendingAskUser[]>;
  now(): Date;
  timeZone(): string;
  env: Record<string, string | undefined>;
  timeoutMs: number;
  log(message: string): void;
}

const defaultDeps: ThreadDetectDeps = {
  callAux: realCallAux,
  createThread: realCreateThread,
  listChoices: realListChoices,
  pendingAskUser: async chatId => (await import("../store")).storeOr([], store => store.tasks.pending(chatId)),
  now: () => new Date(),
  timeZone: () => process.env.USER_TIMEZONE || "UTC",
  env: process.env,
  timeoutMs: THREADS_TIMEOUT_MS,
  log: message => console.log(`[threads] ${message}`),
};

export interface NoteTurnInput {
  conversation: ChoiceConversation;
  userText: string;
  reply: string;
  /** Beginn des Turns (ms); Rückfragen ab hier unterdrücken den Faden */
  turnStartedAt: number;
}

export type DetectOutcome =
  | { status: "off" }
  | { status: "no-question" }
  | { status: "suppressed"; by: "choice" | "ask_user" }
  | { status: "none" }
  | { status: "created"; id: string }
  | { status: "duplicate"; id: string }
  | { status: "failed"; reason: "fehler" | "zeitüberschreitung" | "ungültige Antwort" };

class Timeout extends Error {}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Timeout()), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Erkennung eines Turns; wartet auf das Ergebnis (für Tests und noteTurnForThreads). */
export async function detectThread(input: NoteTurnInput, deps: Partial<ThreadDetectDeps> = {}): Promise<DetectOutcome> {
  const d = { ...defaultDeps, ...deps };
  if (!threadsEnabled(d.env)) return { status: "off" };
  if (!passesPrefilter(input.reply)) return { status: "no-question" };
  const key = conversationKey(input.conversation);
  const fail = (reason: "fehler" | "zeitüberschreitung" | "ungültige Antwort"): DetectOutcome => {
    d.log(`keine Erkennung für Gespräch ${key} (${reason})`);
    return { status: "failed", reason };
  };

  try {
    // Rückfragen mit eigenen Erinnerungen: kein zweiter Weg für dieselbe Frage
    const choices = await d.listChoices();
    if (choices.some(c => c.createdAt >= input.turnStartedAt && sameConversation(c.conversation, input.conversation))) {
      return { status: "suppressed", by: "choice" };
    }
    const topicId = input.conversation.type === "telegram" ? input.conversation.topicId : undefined;
    const tasks = await d.pendingAskUser(taskChatId(input.conversation));
    if (tasks.some(t => (t.thread_id ?? undefined) === topicId)) return { status: "suppressed", by: "ask_user" };
  } catch {
    return fail("fehler");
  }

  let result: AuxResult;
  try {
    const prompt = buildThreadsPrompt({ reply: input.reply, userText: input.userText, now: d.now(), timeZone: d.timeZone() });
    // Eigene Grenze zusätzlich zu der von callAux: ein hängender Aufruf darf die Erkennung nicht ewig offen halten
    result = await withTimeout(d.callAux("threads", prompt, { timeoutMs: d.timeoutMs, quiet: true }), d.timeoutMs + 5_000);
  } catch (e) {
    return fail(e instanceof Timeout ? "zeitüberschreitung" : "fehler");
  }
  if (result.isError) return fail("fehler");
  const verdict = parseVerdict(result.text);
  if (!verdict) return fail("ungültige Antwort");
  if (!verdict.open) return { status: "none" };

  try {
    const outcome = await d.createThread({
      conversation: input.conversation,
      topic: verdict.topic,
      context: verdict.context,
      question: verdict.question,
      ...(verdict.deadline ? { deadline: verdict.deadline } : {}),
    });
    if (outcome.status === "duplicate") return { status: "duplicate", id: outcome.thread.id };
    d.log(`Faden ${outcome.thread.id} angelegt (Gespräch ${key})`);
    return { status: "created", id: outcome.thread.id };
  } catch {
    return fail("fehler");
  }
}

// Nacharbeit je Gespräch (Schlüssel conversationKey), nacheinander
const turnQueues = new Map<string, Promise<void>>();

/**
 * Läuft oder wartet noch Nacharbeit (Auflösen, Erkennung) in diesem Prozess?
 * Erst false, wenn alles geschrieben ist (Issue #293: die WebUI fragt so
 * lange nach).
 */
export function threadsWorkPending(): boolean {
  return turnQueues.size > 0;
}

/** Auflösen, dann Erkennung; wartet auf beides (für Tests). Fehler werden gefangen. */
export async function processTurnForThreads(input: NoteTurnInput, deps: Partial<ThreadDetectDeps & ThreadResolveDeps> = {}): Promise<void> {
  const log = deps.log ?? defaultDeps.log;
  const key = conversationKey(input.conversation);
  await resolveThreads(input, deps).catch(() => log(`kein Auflösen für Gespräch ${key} (fehler)`));
  await detectThread(input, deps).catch(() => log(`keine Erkennung für Gespräch ${key} (fehler)`));
}

/**
 * Nach dem Versand einer Antwort aufrufen: startet Auflösen und Erkennung
 * ohne zu warten und fängt jeden Fehler. Turns desselben Gesprächs laufen
 * nacheinander, andere Gespräche unabhängig. Nicht für /goal, Sprach-Brücke,
 * Board-Sitzungen, Meldungen der Outbox und Befehle.
 */
export function noteTurnForThreads(input: NoteTurnInput, deps: Partial<ThreadDetectDeps & ThreadResolveDeps> = {}): void {
  try {
    if (!threadsEnabled(deps.env ?? defaultDeps.env)) return;
    const key = conversationKey(input.conversation);
    const previous = turnQueues.get(key) ?? Promise.resolve();
    const run = previous.then(() => processTurnForThreads(input, deps)).catch(() => {});
    turnQueues.set(key, run);
    void run.finally(() => {
      if (turnQueues.get(key) === run) turnQueues.delete(key);
    });
  } catch {
    // nie zum Aufrufer durchreichen
  }
}
