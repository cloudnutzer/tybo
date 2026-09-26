/**
 * Rückfragen in Telegram (Issue #114, Entscheidung 0017).
 *
 * Die Telegram-Seite des Rückfragen-Registers (choices.ts):
 * - sendChoice schickt eine offene Frage mit Knöpfen ("ch|<id>|<key>") in
 *   ihr Gespräch, merkt die Nachricht mit den Knöpfen am Register-Eintrag
 *   (attachChoiceTelegram) und hält sie im Verlauf fest (sendAndRecord mit
 *   metadata.choiceId). Fragen aus reinen Web-Gesprächen gehen als Kopie in
 *   den Direktchat; der Register-Bezug bleibt beim Web-Gespräch.
 * - Der Callback-Handler (choiceCallbackMiddleware) nimmt nur "ch|"-Knöpfe
 *   des Besitzers an, die zu einer gemerkten Nachricht der Frage gehören, und
 *   entscheidet über decideChoice(..., "telegram"). Alle anderen Präfixe
 *   gehen unverändert weiter (next).
 * - Nachziehen: Bearbeitet werden die gemerkten Nachrichten ausschließlich
 *   vom Zuhörer auf onChoiceChange ("decided" aus jedem Kanal, "expired"),
 *   genau einmal je Nachricht. Der Callback-Handler bearbeitet nur dann
 *   selbst, wenn es kein Ereignis gab (schon erledigt, abgelaufen, unbekannt)
 *   und die geklickte Nachricht noch nicht nachgezogen ist: dann verschwinden
 *   nur ihre Knöpfe. "created" und "handler-error" ändern nichts.
 * - Wurde die Frage entschieden oder ist sie abgelaufen, während sendChoice
 *   noch sendete, zieht sendChoice die eigene Nachricht selbst nach (das
 *   Ereignis kam, bevor die Nachricht gemerkt war).
 * - expireLapsedChoices (regelmäßig und beim Start) speichert überschrittene
 *   Fristen als Ablauf; der Zuhörer zieht dann die Nachrichten nach, auch die
 *   von Fragen, die während einer Ausfallzeit abgelaufen sind.
 *
 * Bearbeitungsfehler (Nachricht gelöscht, zu alt) werden geloggt, nie
 * geworfen; ins Log kommen nur IDs, nie Fragetexte.
 *
 * Lange Fragen: Knöpfe hängen am letzten Text-Stück, nur dieses Stück wird
 * gemerkt und beim Nachziehen mit seinem eigenen Text plus Ergebniszeile
 * bearbeitet, nicht mit der ganzen Frage.
 *
 * Viele Optionen (Issue #119, Topic-Zuordnung mit mehr als 100 Agenten):
 * Telegram nimmt höchstens TELEGRAM_BUTTONS_MAX Knöpfe je Nachricht. Die
 * ersten hängen an der Frage, die übrigen an Folge-Nachrichten („Weitere
 * Auswahl ... 2 von 3"), die nur gesendet, nicht festgehalten werden: der
 * Browser zeigt die Frage mit allen Optionen aus dem Register. Alle
 * Nachrichten mit Knöpfen werden gemerkt, jeder Knopf entscheidet also, und
 * beim Nachziehen verschwinden die Knöpfe überall. Scheitert eine
 * Folge-Nachricht, gilt die Frage trotzdem als gesendet (ins Log).
 */

import type { Composer, Context, MiddlewareFn } from "grammy";
import {
  attachChoiceTelegram,
  choiceCallbackData,
  decideChoice,
  expireChoice,
  expireLapsedChoices,
  getChoice,
  isLapsed,
  onChoiceChange,
  parseChoiceCallbackData,
  type Choice,
  type ChoiceChangeListener,
  type ChoiceChannel,
  type ChoiceKind,
  type ChoiceTelegramRef,
} from "./choices";
import { sendAndRecord, textChunks, type InlineButton, type SendAndRecordInput, type SendAndRecordResult } from "./outbox";
import { NO_LINK_PREVIEW } from "./telegram";

/** Telegram-Nachrichtenlänge */
const TELEGRAM_TEXT_MAX = 4096;
/** Telegram-Länge einer Callback-Antwort (answerCallbackQuery) */
const CALLBACK_ANSWER_MAX = 200;
/** Längste Ergebniszeile in der nachgezogenen Nachricht; der Rest bleibt für die Frage */
const STATUS_LINE_MAX = 1024;
/** Knöpfe je Zeile */
const BUTTONS_PER_ROW = 3;
/** Grenze von Telegram: Knöpfe an einer Nachricht */
export const TELEGRAM_BUTTONS_MAX = 100;

/** Text der Folge-Nachrichten mit weiteren Knöpfen; page ab 2 */
export const choiceMoreText = (page: number, pages: number) => `Weitere Auswahl zur Frage oben (${page} von ${pages})`;

/** source im Verlauf je Art */
export const CHOICE_SOURCES: Record<ChoiceKind, string> = {
  tool: "freigabe",
  review: "review",
  goal: "ziel",
  topicmap: "topic",
};

const VIA_TEXT: Record<ChoiceChannel, string> = {
  telegram: "in Telegram",
  web: "im Browser",
  terminal: "im Terminal",
};

export const EXPIRED_LINE = "Abgelaufen, nichts geändert";

/** Der Teil der Bot-API, den das Nachziehen braucht (bot.api passt) */
export interface ChoiceEditApi {
  editMessageText(chatId: string, messageId: number, text: string, other?: Record<string, unknown>): Promise<unknown>;
  editMessageReplyMarkup(chatId: string, messageId: number, other?: Record<string, unknown>): Promise<unknown>;
}

type Log = (line: string) => void;

const defaultLog: Log = line => console.log(line);

function errorName(e: unknown): string {
  return e instanceof Error ? e.name : "Fehler";
}

/** Kürzt auf höchstens max Zeichen (mit "…"), ohne ein Ersatzzeichenpaar zu zerschneiden */
function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 0) return "";
  let cut = text.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/**
 * prefix + Beschriftung + suffix, höchstens max Zeichen: gekürzt wird nur die
 * Beschriftung, Kanal- und Ablaufhinweis bleiben ganz.
 */
function withLabel(prefix: string, label: string, suffix: string, max: number): string {
  return `${prefix}${clip(label, max - prefix.length - suffix.length)}${suffix}`;
}

function refKey(chatId: string, messageId: number): string {
  return `${chatId}:${messageId}`;
}

/** Ergebniszeile einer erledigten oder abgelaufenen Frage; null, solange sie offen ist */
export function choiceStatusLine(choice: Choice): string | null {
  if (choice.state === "done" && choice.result) {
    return withLabel("✓ ", choice.result.label, ` (${VIA_TEXT[choice.result.via]})`, STATUS_LINE_MAX);
  }
  if (choice.state === "expired" || isLapsed(choice)) return EXPIRED_LINE;
  return null;
}

/** "Schon erledigt: Erlauben im Browser", höchstens 200 Zeichen */
export function alreadyText(choice: Choice): string {
  if (!choice.result) return "Schon erledigt";
  return withLabel("Schon erledigt: ", choice.result.label, ` ${VIA_TEXT[choice.result.via]}`, CALLBACK_ANSWER_MAX);
}

/** "✓ Erlauben" als Callback-Antwort, höchstens 200 Zeichen */
export function decidedAnswer(choice: Choice): string {
  return withLabel("✓ ", choice.result?.label ?? "", "", CALLBACK_ANSWER_MAX).trim();
}

/**
 * Text der nachgezogenen Nachricht: das letzte Stück der Frage, wie es
 * gesendet wurde, plus Leerzeile und Ergebniszeile, höchstens 4096 Zeichen.
 * Eine überlange Ergebniszeile wird auf STATUS_LINE_MAX gekürzt (ihr Ende mit
 * dem Kanal- oder Ablaufhinweis bleibt, wenn sie aus choiceStatusLine kommt).
 */
export function choiceEditedText(choice: Choice, status: string): string {
  const chunks = textChunks(choice.text, "plain");
  const last = chunks[chunks.length - 1] ?? "";
  const suffix = `\n\n${clip(status, STATUS_LINE_MAX)}`;
  return `${clip(last, TELEGRAM_TEXT_MAX - suffix.length)}${suffix}`;
}

function toRows(buttons: InlineButton[]): InlineButton[][] {
  const rows: InlineButton[][] = [];
  for (let i = 0; i < buttons.length; i += BUTTONS_PER_ROW) rows.push(buttons.slice(i, i + BUTTONS_PER_ROW));
  return rows;
}

/** Knöpfe einer Frage, höchstens drei je Zeile */
export function choiceButtons(choice: Choice): InlineButton[][] {
  return toRows(choice.options.map(o => ({ text: o.label, callback_data: choiceCallbackData(choice.id, o.key) })));
}

/** Knöpfe je Telegram-Nachricht: höchstens TELEGRAM_BUTTONS_MAX, in Reihenfolge der Optionen */
export function choiceButtonPages(choice: Choice): InlineButton[][][] {
  const buttons = choiceButtons(choice).flat();
  const pages: InlineButton[][][] = [];
  for (let i = 0; i < buttons.length; i += TELEGRAM_BUTTONS_MAX) pages.push(toRows(buttons.slice(i, i + TELEGRAM_BUTTONS_MAX)));
  return pages;
}

/**
 * Bearbeitet gemerkte Nachrichten einer erledigten oder abgelaufenen Frage
 * (Standard: alle). Wirft nicht. Gibt die erfolgreich bearbeiteten zurück.
 */
export async function refreshChoiceMessages(
  choice: Choice,
  api: ChoiceEditApi,
  log: Log = defaultLog,
  refs: ChoiceTelegramRef[] = choice.telegram ?? []
): Promise<ChoiceTelegramRef[]> {
  const status = choiceStatusLine(choice);
  if (status === null) return [];
  const text = choiceEditedText(choice, status);
  const edited: ChoiceTelegramRef[] = [];
  for (const ref of refs) {
    try {
      // Ohne reply_markup verschwinden die Knöpfe
      await api.editMessageText(ref.chatId, ref.messageId, text, { link_preview_options: NO_LINK_PREVIEW });
      edited.push(ref);
    } catch (e) {
      log(`[choices] Telegram-Nachricht ${ref.messageId} zu Frage ${choice.id} nicht nachgezogen (${errorName(e)})`);
    }
  }
  return edited;
}

// ---------------------------------------------------------------------------
// Senden
// ---------------------------------------------------------------------------

export interface SendChoiceDeps {
  /** Standard sendAndRecord mit den Abhängigkeiten aus der Umgebung */
  send?: (input: SendAndRecordInput) => Promise<SendAndRecordResult>;
  /** Zieht die eigene Nachricht nach, wenn die Frage während des Sendens erledigt wurde */
  refresh: (choice: Choice, refs: ChoiceTelegramRef[]) => Promise<unknown>;
  log?: Log;
}

export interface SendChoiceResult {
  sent: boolean;
  recorded: boolean;
  /** Gemerkte Nachrichten mit den Knöpfen */
  messages: ChoiceTelegramRef[];
  error?: string;
}

/** Ziel in Telegram: Chat und Topic der Frage, bei reinen Web-Gesprächen der Direktchat */
function targetOf(choice: Choice): Pick<SendAndRecordInput, "chatId" | "topicId"> {
  const c = choice.conversation;
  if (c.type === "web") return {};
  return c.topicId !== undefined ? { chatId: c.chatId, topicId: c.topicId } : { chatId: c.chatId };
}

/**
 * Sendet eine offene Frage mit Knöpfen, merkt die Nachricht am
 * Register-Eintrag und hält sie im Verlauf fest (siehe oben). Wirft nicht.
 */
export async function sendChoice(choice: Choice, deps: SendChoiceDeps): Promise<SendChoiceResult> {
  const log = deps.log ?? defaultLog;
  if (choice.state !== "open" || isLapsed(choice)) {
    return { sent: false, recorded: false, messages: [], error: "Frage ist nicht mehr offen" };
  }
  const send = deps.send ?? (input => sendAndRecord(input));
  const pages = choiceButtonPages(choice);
  const withButtons = (r: SendAndRecordResult) =>
    (r.messages ?? []).filter(m => m.buttons).map(m => ({ chatId: m.chatId, messageId: m.messageId }));
  let result: SendAndRecordResult;
  try {
    result = await send({
      ...targetOf(choice),
      text: choice.text,
      format: "plain",
      buttons: pages[0],
      source: CHOICE_SOURCES[choice.kind],
      choiceId: choice.id,
    });
  } catch (e) {
    log(`[choices] Frage ${choice.id} nicht gesendet (${errorName(e)})`);
    return { sent: false, recorded: false, messages: [], error: "Senden gescheitert" };
  }
  const refs = withButtons(result);
  if (!result.sent) {
    return { sent: false, recorded: result.recorded, messages: [], error: result.error?.message ?? "Senden gescheitert" };
  }
  // Weitere Knöpfe in Folge-Nachrichten, nur gesendet (der Verlauf hat die Frage schon)
  for (let i = 1; i < pages.length; i++) {
    try {
      const more = await send({
        ...targetOf(choice),
        text: choiceMoreText(i + 1, pages.length),
        format: "plain",
        buttons: pages[i],
        source: CHOICE_SOURCES[choice.kind],
        record: false,
      });
      refs.push(...withButtons(more));
      if (!more.sent) log(`[choices] Knöpfe ${i + 1} von ${pages.length} zu Frage ${choice.id} nicht gesendet`);
    } catch (e) {
      log(`[choices] Knöpfe ${i + 1} von ${pages.length} zu Frage ${choice.id} nicht gesendet (${errorName(e)})`);
    }
  }
  if (refs.length === 0) {
    log(`[choices] Frage ${choice.id} gesendet, aber ohne message_id; die Knöpfe sind nicht gemerkt`);
    return { sent: true, recorded: result.recorded, messages: [] };
  }

  let stored: Choice | undefined;
  try {
    stored = await attachChoiceTelegram(choice.id, refs);
  } catch (e) {
    log(`[choices] Nachricht zu Frage ${choice.id} nicht gemerkt (${errorName(e)})`);
    return { sent: true, recorded: result.recorded, messages: [] };
  }

  if (!stored) {
    // Frage verschwand während des Sendens (aufgeräumt): Knöpfe weg
    await deps.refresh({ ...choice, state: "expired" }, refs);
  } else if (stored.state !== "open") {
    // Entschieden oder abgelaufen, bevor die Nachricht gemerkt war: das
    // Ereignis kam ohne sie, also hier nachziehen
    await deps.refresh(stored, refs);
  } else if (isLapsed(stored)) {
    // Frist lief während des Sendens ab: das Ereignis zieht alle gemerkten
    // Nachrichten nach, auch diese
    await expireChoice(choice.id).catch(e => log(`[choices] Ablauf von ${choice.id} nicht gespeichert (${errorName(e)})`));
  }
  return { sent: true, recorded: result.recorded, messages: refs };
}

// ---------------------------------------------------------------------------
// Callback, Zuhörer, Ablauf
// ---------------------------------------------------------------------------

export interface TelegramChoicesDeps {
  api: ChoiceEditApi;
  /** TELEGRAM_USER_ID */
  owner: string;
  send?: (input: SendAndRecordInput) => Promise<SendAndRecordResult>;
  log?: Log;
}

export interface TelegramChoices {
  sendChoice(choice: Choice): Promise<SendChoiceResult>;
  /** Callback-Middleware für "ch|"; alles andere geht an next */
  middleware: MiddlewareFn<Context>;
  /** Zuhörer für onChoiceChange */
  listener: ChoiceChangeListener;
  /** Überschrittene Fristen als Ablauf speichern (zieht über den Zuhörer nach) */
  sweep(): Promise<Choice[]>;
}

/** Wie viele nachgezogene Nachrichten sich der Handler merkt */
const REFRESHED_MAX = 2000;

export function createTelegramChoices(deps: TelegramChoicesDeps): TelegramChoices {
  const log = deps.log ?? defaultLog;
  // Nachrichten, die in diesem Prozess schon nachgezogen sind; der
  // Callback-Handler bearbeitet sie nicht noch einmal
  const refreshed = new Set<string>();
  const markRefreshed = (refs: ChoiceTelegramRef[]) => {
    for (const r of refs) refreshed.add(refKey(r.chatId, r.messageId));
    while (refreshed.size > REFRESHED_MAX) refreshed.delete(refreshed.values().next().value as string);
  };
  const refresh = async (choice: Choice, refs?: ChoiceTelegramRef[]) => {
    markRefreshed(await refreshChoiceMessages(choice, deps.api, log, refs));
  };

  const listener: ChoiceChangeListener = async ({ type, choice }) => {
    if (type !== "decided" && type !== "expired") return;
    await refresh(choice);
  };

  const middleware: MiddlewareFn<Context> = async (ctx, next) => {
    const query = ctx.callbackQuery;
    const data = query?.data;
    if (typeof data !== "string" || !data.startsWith("ch|")) return next();
    // Doppelt zur Besitzerprüfung in bot.ts: fremde Absender kommen nie durch
    if (String(ctx.from?.id ?? "") !== deps.owner) return;
    const answer = (text?: string) => ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {});

    const parsed = parseChoiceCallbackData(data);
    if (!parsed) {
      await answer("Ungültiger Knopf");
      return;
    }
    const message = query?.message;
    const chatId = message ? String(message.chat.id) : "";
    const messageId = message?.message_id;
    const stripClicked = async () => {
      if (!chatId || messageId === undefined || refreshed.has(refKey(chatId, messageId))) return;
      try {
        await deps.api.editMessageReplyMarkup(chatId, messageId, { reply_markup: { inline_keyboard: [] } });
        markRefreshed([{ chatId, messageId }]);
      } catch (e) {
        log(`[choices] Knöpfe an Nachricht ${messageId} nicht entfernt (${errorName(e)})`);
      }
    };

    let current: Choice | undefined;
    try {
      current = await getChoice(parsed.id);
    } catch (e) {
      log(`[choices] Frage ${parsed.id} nicht lesbar (${errorName(e)})`);
      await answer("Gerade nicht möglich, bitte gleich nochmal");
      return;
    }
    if (!current) {
      await answer("Abgelaufen");
      await stripClicked();
      return;
    }
    const refs = current.telegram ?? [];
    if (refs.length === 0) {
      // Nachricht noch nicht gemerkt (Klick kurz nach dem Senden) oder
      // Merken gescheitert: nicht entscheiden, der Browser geht weiter
      await answer("Noch nicht bereit, bitte gleich nochmal tippen");
      return;
    }
    const belongs = messageId !== undefined && refs.some(r => r.chatId === chatId && r.messageId === messageId);
    if (!belongs) {
      log(`[choices] Knopf zu Frage ${parsed.id} an fremder Nachricht, ignoriert`);
      await answer("Dieser Knopf gehört nicht zu dieser Frage");
      return;
    }

    let outcome;
    try {
      outcome = await decideChoice(parsed.id, parsed.key, "telegram");
    } catch (e) {
      log(`[choices] Frage ${parsed.id} nicht entschieden (${errorName(e)})`);
      await answer("Gerade nicht möglich, bitte gleich nochmal");
      return;
    }
    switch (outcome.status) {
      case "decided":
        // Nachgezogen hat der Zuhörer
        await answer(decidedAnswer(outcome.choice));
        return;
      case "already":
        await answer(alreadyText(outcome.choice));
        await stripClicked();
        return;
      case "expired":
        await answer("Abgelaufen");
        await stripClicked();
        return;
      case "unknown":
        await answer("Abgelaufen");
        await stripClicked();
        return;
      case "invalid_key":
        // Frage bleibt offen, Knöpfe bleiben
        await answer("Diese Auswahl gibt es nicht");
        return;
    }
  };

  return {
    sendChoice: choice => sendChoice(choice, { send: deps.send, refresh, log }),
    middleware,
    listener,
    sweep: () => expireLapsedChoices(),
  };
}

/**
 * Bindet Rückfragen an den Bot: Callback-Middleware (nach der
 * Besitzerprüfung, vor dem allgemeinen Callback-Handler registrieren) und
 * Zuhörer. Gibt die Abmelde-Funktion des Zuhörers zurück.
 */
export function installTelegramChoices(bot: Composer<Context>, choices: TelegramChoices): () => void {
  bot.on("callback_query:data", choices.middleware);
  return onChoiceChange(choices.listener);
}
