/**
 * Erinnerungen an offene Fäden über das Rückfragen-Register (Issue #292,
 * Entscheidungen 0017 und 0025): Art "thread", ref ist die Faden-ID.
 *
 * Knöpfe: „Erledigt" (done), „Später" (later), „Nicht mehr wichtig" (drop).
 * Der Handler läuft nur im Gewinnerprozess von decideChoice und ändert den
 * Faden unter der Sperre der Ablage (applyThreadButton): ein geschlossener
 * oder verschwundener Faden bleibt, wie er ist („Schon erledigt."). „Später"
 * verschiebt fest um 3 Tage mit Ruhezeit-Regel; nach der zweiten Erinnerung
 * verspricht es keine dritte.
 *
 * Lebenszyklus: Wird ein Faden auf irgendeinem Weg geschlossen, laufen seine
 * offenen Rückfragen ab (installThreadChoiceExpiry hört auf onThreadsClosed
 * der Ablage), Telegram zieht die Knöpfe über den Zuhörer des Registers nach.
 * sweepThreadChoices räumt zusätzlich offene Rückfragen ab, deren Faden ein
 * anderer Prozess geschlossen hat oder die es nicht mehr gibt.
 *
 * Versand (sendThreadReminder): eigener Weg, nicht über user-notify.ts und
 * nicht über sendChoice, nur ins Gespräch des Fadens:
 * - Telegram-Gespräch mit Telegram: sendAndRecord an Chat und Topic, Klartext,
 *   Knöpfe, source faeden, choiceId; die Nachricht mit den Knöpfen wird am
 *   Register gemerkt (attachChoiceTelegram). Wurde die Frage währenddessen
 *   entschieden oder ist sie abgelaufen, zieht der Versand sie selbst nach.
 * - Telegram-Gespräch ohne Telegram: kein Versand ("deferred").
 * - Web-Gespräch und Web-Direktchat: nur festhalten im Gespräch selbst
 *   (web:<uuid> bzw. web), mit choiceId; die Knöpfe zeigt der Browser aus dem
 *   Register. Nie eine Kopie im Direktchat, mit und ohne Telegram.
 * Der Text passt in ein Telegram-Stück, damit es keinen Teilerfolg über
 * mehrere Stücke gibt. Ausgang: "delivered" (zugestellt, auch Teilerfolg),
 * "rejected" (sicher nicht angekommen: Eingabe abgelehnt oder Telegram hat
 * ohne angenommene Nachricht abgelehnt), "unclear" (Ausnahme, Netzfehler,
 * Zeitüberschreitung, 5xx, Fehler beim Festhalten: der Eintrag kann trotzdem
 * gespeichert sein).
 *
 * Antworten gehen über notify ins Gespräch der Rückfrage: Telegram-Gespräch in
 * Chat und Topic, Web-Gespräch nur im Gespräch selbst (threadTarget), nie als
 * Kopie in den Direktchat. Ins Log kommen nur Faden- und Rückfrage-IDs.
 */

import {
  attachChoiceTelegram as realAttach,
  expireChoice as realExpire,
  listChoices as realListChoices,
  type Choice,
  type ChoiceConversation,
  type ChoiceHandler,
  type ChoiceOption,
  type ChoiceTelegramRef,
} from "./choices";
import { isWebChatId, outboxDelivered, webConversationChatId } from "./channels";
import { sendAndRecord, type SendAndRecordInput, type SendAndRecordResult } from "./outbox";
import { choiceButtons } from "./telegram-choices";
import { deadlineText } from "./threads/format";
import { laterReminderTime, localDateText, reminderTimeZone } from "./threads/schedule";
import {
  applyThreadButton as realApply,
  listAllThreadsChecked as realListThreads,
  onThreadsClosed,
  type Thread,
  type ThreadButton,
} from "./threads/store";

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;
const defaultLog: Log = line => console.log(line);

/** source der Erinnerungen und Antworten, wie CHOICE_SOURCES.thread */
export const THREAD_SOURCE = "faeden";

export const THREAD_OPTIONS: ChoiceOption[] = [
  { key: "done", label: "Erledigt" },
  { key: "later", label: "Später" },
  { key: "drop", label: "Nicht mehr wichtig" },
];

export const THREAD_CHOICE_TEXT = {
  done: "Erledigt.",
  dropped: "Vergessen.",
  already: "Schon erledigt.",
  later: (date: string) => `Ich frage am ${date} wieder.`,
  laterFinal: (date: string) => `Ich lasse ihn bis ${date} offen, danach schließe ich ihn.`,
  failed: "Das hat nicht geklappt, der Faden bleibt, wie er ist.",
} as const;

/** Ziel in der Outbox für ein Gespräch: Chat und Topic bzw. das Web-Gespräch selbst */
export function threadTarget(conversation: ChoiceConversation): Pick<SendAndRecordInput, "chatId" | "topicId"> {
  if (conversation.type === "web") return { chatId: webConversationChatId(conversation.conversationId) };
  return conversation.topicId !== undefined ? { chatId: conversation.chatId, topicId: conversation.topicId } : { chatId: conversation.chatId };
}

/** Längen im Erinnerungstext; zusammen weit unter einem Telegram-Stück */
export const REMINDER_CONTEXT_MAX = 300;
export const REMINDER_QUESTION_MAX = 500;

/** Kürzt auf höchstens max Zeichen (mit "…"), ohne ein Ersatzzeichenpaar zu zerschneiden */
function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  let cut = clean.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Text einer Erinnerung: erst Kontext, dann die Frage, bei Frist die Frist */
export function reminderText(thread: Pick<Thread, "createdAt" | "context" | "question" | "deadline">, step: 1 | 2, timeZone: string): string {
  const since = localDateText(thread.createdAt, timeZone);
  const head = step === 2 ? `🧵 Noch einmal, offen seit ${since}` : `🧵 Offen seit ${since}`;
  const lines = [`${head}: ${clip(thread.context, REMINDER_CONTEXT_MAX)}`, `Frage: ${clip(thread.question, REMINDER_QUESTION_MAX)}`];
  if (thread.deadline) lines.push(`Frist: ${deadlineText(thread.deadline)}`);
  return lines.join("\n");
}

/** Gespräch lebt nur in der WebUI: Web-Gespräch oder Web-Direktchat */
export function isWebConversation(conversation: ChoiceConversation): boolean {
  return conversation.type === "web" || isWebChatId(conversation.chatId);
}

export type ReminderSendOutcome = "delivered" | "rejected" | "unclear" | "deferred";

export interface ReminderSendDeps {
  send?: (input: SendAndRecordInput) => Promise<SendAndRecordResult>;
  /** Telegram eingerichtet? (in bot.ts telegramConfigured) */
  telegram: () => boolean;
  attach?: typeof realAttach;
  /** Zieht die eigene Nachricht nach, wenn die Frage während des Sendens erledigt wurde */
  refresh?: (choice: Choice, refs: ChoiceTelegramRef[]) => Promise<unknown>;
  log?: Log;
}

/** Ausgang eines Versands der Outbox (siehe oben) */
export function classifyReminderResult(result: SendAndRecordResult): Exclude<ReminderSendOutcome, "deferred"> {
  if (outboxDelivered(result) || (result.messages?.length ?? 0) > 0) return "delivered";
  const kind = result.error?.kind;
  if (kind === "invalid") return "rejected";
  if (kind === "send" && result.error?.rejected) return "rejected";
  return "unclear";
}

/** Sendet die Erinnerung samt Rückfrage ins Gespräch des Fadens (siehe oben). Wirft nicht. */
export async function sendThreadReminder(choice: Choice, text: string, deps: ReminderSendDeps): Promise<{ outcome: ReminderSendOutcome; messages: ChoiceTelegramRef[] }> {
  const log = deps.log ?? defaultLog;
  const send = deps.send ?? (input => sendAndRecord(input));
  const web = isWebConversation(choice.conversation);
  if (!web && !deps.telegram()) return { outcome: "deferred", messages: [] };
  const input: SendAndRecordInput = {
    ...threadTarget(choice.conversation),
    text,
    format: "plain",
    source: THREAD_SOURCE,
    choiceId: choice.id,
    ...(web ? {} : { buttons: choiceButtons(choice) }),
  };
  let result: SendAndRecordResult;
  try {
    result = await send(input);
  } catch {
    log(`[faeden] Erinnerung ${choice.id} (Faden ${choice.ref ?? "-"}): Versand mit Ausnahme beendet`);
    return { outcome: "unclear", messages: [] };
  }
  const outcome = classifyReminderResult(result);
  const refs = (result.messages ?? []).filter(m => m.buttons).map(m => ({ chatId: m.chatId, messageId: m.messageId }));
  if (refs.length === 0) return { outcome, messages: [] };
  try {
    const stored = await (deps.attach ?? realAttach)(choice.id, refs);
    if (!stored) await deps.refresh?.({ ...choice, state: "expired" }, refs);
    else if (stored.state !== "open") await deps.refresh?.(stored, refs);
  } catch {
    log(`[faeden] Nachricht zu Erinnerung ${choice.id} nicht gemerkt`);
  }
  return { outcome, messages: refs };
}

function isButton(key: string | undefined): key is ThreadButton {
  return key === "done" || key === "later" || key === "drop";
}

export interface ThreadChoicesDeps {
  /** Antwort im Gespräch der Rückfrage; darf werfen, geloggt wird hier */
  notify(conversation: ChoiceConversation, text: string): Promise<void>;
  /** Standard applyThreadButton aus der Ablage */
  apply?: typeof realApply;
  env?: Env;
  log?: Log;
}

export interface ThreadChoices {
  /** Handler der Art "thread" (onChoiceDecided) */
  handler: ChoiceHandler;
}

export function createThreadChoices(deps: ThreadChoicesDeps): ThreadChoices {
  const log = deps.log ?? defaultLog;
  const apply = deps.apply ?? realApply;
  const env = () => deps.env ?? process.env;

  async function say(choice: Choice, text: string): Promise<void> {
    try {
      await deps.notify(choice.conversation, text);
    } catch {
      log(`[faeden] Antwort zu Rückfrage ${choice.id} (Faden ${choice.ref ?? "-"}) nicht zugestellt`);
    }
  }

  const handler: ChoiceHandler = async choice => {
    const id = choice.ref;
    const key = choice.result?.key;
    if (typeof id !== "string" || !id || !isButton(key)) throw new Error("Fäden-Frage ohne Faden oder gültige Auswahl");
    let outcome;
    try {
      outcome = await apply(id, key, now => laterReminderTime(now, env()));
    } catch (e) {
      await say(choice, THREAD_CHOICE_TEXT.failed);
      throw e;
    }
    log(`[faeden] Faden ${id}: ${key} (${choice.result?.via ?? "-"}), ${outcome.status}`);
    if (outcome.status === "not-open") {
      await say(choice, THREAD_CHOICE_TEXT.already);
      return;
    }
    if (outcome.status === "closed") {
      await say(choice, key === "done" ? THREAD_CHOICE_TEXT.done : THREAD_CHOICE_TEXT.dropped);
      return;
    }
    const date = localDateText(outcome.thread.nextReminderAt ?? Date.now(), reminderTimeZone(env()));
    await say(choice, outcome.final ? THREAD_CHOICE_TEXT.laterFinal(date) : THREAD_CHOICE_TEXT.later(date));
  };

  return { handler };
}

export interface ThreadChoiceExpiryDeps {
  listChoices?: () => Promise<Choice[]>;
  expireChoice?: typeof realExpire;
  /** Alle Fäden; wirft, wenn die Ablage nicht lesbar ist (dann wird nichts abgeräumt) */
  listThreads?: () => Promise<Thread[]>;
  log?: Log;
}

/** Offene Rückfragen der Art thread, deren ref passt, ablaufen lassen; gibt die Zahl zurück */
async function expireMatching(match: (ref: string) => boolean, deps: ThreadChoiceExpiryDeps): Promise<number> {
  const list = deps.listChoices ?? realListChoices;
  const expire = deps.expireChoice ?? realExpire;
  const log = deps.log ?? defaultLog;
  const open = (await list()).filter(c => c.kind === "thread" && c.state === "open" && typeof c.ref === "string" && match(c.ref));
  let n = 0;
  for (const c of open) {
    try {
      if ((await expire(c.id)).status === "expired") n++;
    } catch {
      log(`[faeden] Rückfrage ${c.id} (Faden ${c.ref}) nicht abgelaufen`);
    }
  }
  return n;
}

/**
 * Lässt beim Schließen eines Fadens (jeder Weg, onThreadsClosed) seine offenen
 * Rückfragen ablaufen. Gibt die Abmelde-Funktion zurück.
 */
export function installThreadChoiceExpiry(deps: ThreadChoiceExpiryDeps = {}): () => void {
  const log = deps.log ?? defaultLog;
  return onThreadsClosed(async threads => {
    const ids = new Set(threads.map(t => t.id));
    try {
      await expireMatching(ref => ids.has(ref), deps);
    } catch {
      log(`[faeden] Rückfragen geschlossener Fäden nicht abgelaufen (${[...ids].join(", ")})`);
    }
  });
}

/**
 * Offene Rückfragen der Art thread ablaufen lassen, deren Faden geschlossen
 * oder verschwunden ist (ein anderer Prozess hat geschlossen). Ist die Ablage
 * der Fäden nicht lesbar, passiert nichts. Gibt die Zahl zurück.
 */
export async function sweepThreadChoices(deps: ThreadChoiceExpiryDeps = {}): Promise<number> {
  const threads = await (deps.listThreads ?? realListThreads)();
  const open = new Set(threads.filter(t => t.state === "open").map(t => t.id));
  return expireMatching(ref => !open.has(ref), deps);
}
