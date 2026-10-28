/**
 * Rückfrage bei mehrdeutigen Merk-Tags (Issue #316, Entscheidung 0017):
 * treffen DONE, CANCEL oder FORGET mehrere Einträge, fragt tybo über das
 * Rückfragen-Register (Art "memory") nach, welcher gemeint ist. Vorher
 * ändert sich nichts.
 *
 * Die Frage trägt alles, was die Entscheidung braucht, dauerhaft in
 * data/choices.json, auch über einen Neustart: action ist done, cancel oder
 * forget, ref die Liste der Eintrags-IDs als JSON. Die Knöpfe heißen e0, e1,
 * … (Stelle in der Liste) und "none" für „Keins davon"; Supabase-IDs sind
 * für einen Knopfschlüssel zu lang. Nach dem Klick wird genau der Eintrag
 * mit dieser ID geändert, nie erneut per Teiltext gesucht; gibt es ihn
 * nicht mehr (oder ist das Ziel schon erledigt), bleibt alles, wie es ist.
 *
 * Zustellung (createMemoryAsker) wie bei Merk-Vorschlägen
 * (review-choices.ts): Telegram-Gespräch per sendChoice, reines
 * Web-Gespräch im Gespräch selbst und als Kopie im Direktchat, Turn ohne
 * Telegram nur im WebUI-Gespräch. Kommt die Frage nirgends an, läuft sie
 * sofort ab und es bleibt bei „nichts geändert".
 *
 * Ergebnis (createMemoryChoices): der Handler läuft nur im Gewinnerprozess
 * von decideChoice (also genau einmal) und meldet im Gespräch der Frage.
 * Ins Log kommen nur IDs der Rückfrage, keine Merk-Inhalte.
 */
import {
  createChoice as realCreateChoice,
  expireChoice as realExpireChoice,
  type Choice,
  type ChoiceConversation,
  type ChoiceHandler,
  type ChoiceOption,
  type CreateChoiceInput,
} from "../choices";
import { outboxDelivered } from "../channels";
import type { SendAndRecordInput, SendAndRecordResult } from "../outbox";
import type { PostWeb } from "../review-choices";
import type { MemoryItem } from "../store/types";
import { applyToEntry, type AmbiguousMatch, type MemoryAsker, type SearchAction } from "./service";

/** source der Fragen und Meldungen, wie CHOICE_SOURCES.memory */
export const MEMORY_SOURCE = "gedaechtnis";
export const NONE_KEY = "none";
/** Vorsatz der Kopie im Direktchat bei Fragen aus reinen Web-Gesprächen */
const WEB_COPY_PREFIX = "(Web-Gespräch) ";

const ACTIONS: readonly SearchAction[] = ["done", "cancel", "forget"];
const ENTRY_KEY = /^e(\d{1,2})$/;
const LABEL_MAX = 40;
const LINE_MAX = 200;

export const MEMORY_CHOICE_TEXT = {
  question: {
    done: (query: string) => `🧠 Mehrere offene Ziele passen zu „${query}". Welches ist erledigt?`,
    cancel: (query: string) => `🧠 Mehrere offene Ziele passen zu „${query}". Welches soll ich streichen?`,
    forget: (query: string) => `🧠 Mehrere Fakten passen zu „${query}". Welchen soll ich vergessen?`,
  },
  more: "Es gibt weitere Treffer, hier die ältesten.",
  untouched: "Nichts ist geändert, bis du wählst.",
  none: "Keins davon",
  applied: {
    done: (label: string) => `✅ Erledigt: ${label}`,
    cancel: (label: string) => `🗑️ Gestrichen: ${label}`,
    forget: (label: string) => `🧹 Vergessen: ${label}`,
  },
  nothing: "Nichts geändert.",
  gone: "Den Eintrag gibt es nicht mehr, nichts geändert.",
  failed: "Das hat nicht geklappt, nichts geändert.",
} as const;

type Log = (line: string) => void;
const defaultLog: Log = line => console.log(line);

const errorName = (e: unknown) => (e instanceof Error ? e.name : "Fehler");

/** Auf eine Zeile gebracht und höchstens max Zeichen (mit „…"), ohne ein Ersatzzeichenpaar zu teilen */
function shorten(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  let cut = line.slice(0, max - 1);
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

/** Datum im Format des Nutzers (de, USER_TIMEZONE); leer bei ungültigem Wert */
function dayOf(iso: string | undefined): string {
  const at = iso ? new Date(iso) : null;
  if (!at || !Number.isFinite(at.getTime())) return "";
  const timeZone = process.env.USER_TIMEZONE?.trim() || undefined;
  try {
    return at.toLocaleDateString("de-DE", { timeZone, day: "2-digit", month: "2-digit", year: "numeric" });
  } catch {
    return at.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
  }
}

/** Zeile je Treffer: Inhalt, bei Zielen die Frist, sonst das Anlagedatum (unterscheidet gleiche Texte) */
function entryLine(item: MemoryItem, position: number): string {
  const due = dayOf(item.deadline);
  const created = dayOf(item.created_at);
  const note = due ? ` (fällig ${due})` : created ? ` (vom ${created})` : "";
  return `${position}. ${shorten(item.content, LINE_MAX)}${note}`;
}

/** Text, Knöpfe und Bezug einer Frage zu mehreren Treffern */
export function memoryChoiceInput(question: AmbiguousMatch): CreateChoiceInput {
  const lines = [
    MEMORY_CHOICE_TEXT.question[question.action](shorten(question.query, LINE_MAX)),
    ...question.matches.map((item, i) => entryLine(item, i + 1)),
    ...(question.more ? [MEMORY_CHOICE_TEXT.more] : []),
    MEMORY_CHOICE_TEXT.untouched,
  ];
  const options: ChoiceOption[] = [
    ...question.matches.map((item, i) => ({ key: `e${i}`, label: `${i + 1}. ${shorten(item.content, LABEL_MAX)}` })),
    { key: NONE_KEY, label: MEMORY_CHOICE_TEXT.none },
  ];
  return {
    kind: "memory",
    conversation: question.where.conversation,
    text: lines.join("\n"),
    options,
    action: question.action,
    ref: JSON.stringify(question.matches.map(item => String(item.id))),
    ...(question.where.noTelegram ? { noTelegram: { conversationId: question.where.noTelegram.conversationId } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Zustellung
// ---------------------------------------------------------------------------

export interface MemoryAskerDeps {
  /** Frage in Telegram zeigen (createTelegramChoices().sendChoice); Web-Gespräche als Kopie im Direktchat */
  sendChoice(choice: Choice): Promise<{ sent: boolean }>;
  /** Nur im Bot-Prozess mit WebUI */
  postWeb?: PostWeb;
  createChoice?(input: CreateChoiceInput): Promise<Choice>;
  expireChoice?(id: string): Promise<unknown>;
  log?: Log;
}

/** Zustellweg für setMemoryAsker: legt die Rückfrage an und zeigt sie; false, wenn sie nirgends ankam */
export function createMemoryAsker(deps: MemoryAskerDeps): MemoryAsker {
  const log = deps.log ?? defaultLog;
  const create = deps.createChoice ?? realCreateChoice;
  const expire = deps.expireChoice ?? realExpireChoice;

  async function toWeb(choice: Choice, conversationId: string): Promise<boolean> {
    if (!deps.postWeb) return false;
    try {
      return await deps.postWeb(conversationId, { text: choice.text, kind: "notice", source: MEMORY_SOURCE, choiceId: choice.id });
    } catch (e) {
      log(`[Gedächtnis] Rückfrage ${choice.id} nicht ins Web-Gespräch gelegt (${errorName(e)})`);
      return false;
    }
  }

  return async question => {
    const choice = await create(memoryChoiceInput(question));
    let shown = false;
    if (question.where.noTelegram) {
      shown = await toWeb(choice, question.where.noTelegram.conversationId);
    } else {
      if (choice.conversation.type === "web") shown = await toWeb(choice, choice.conversation.conversationId);
      try {
        shown = (await deps.sendChoice(choice)).sent || shown;
      } catch (e) {
        log(`[Gedächtnis] Rückfrage ${choice.id} nicht nach Telegram gesendet (${errorName(e)})`);
      }
    }
    if (shown) return true;
    log(`[Gedächtnis] Rückfrage ${choice.id} nirgends zugestellt, abgelaufen`);
    await Promise.resolve(expire(choice.id)).catch(() => {});
    return false;
  };
}

// ---------------------------------------------------------------------------
// Entscheidung
// ---------------------------------------------------------------------------

export interface MemoryChoicesDeps {
  /** Meldung mit Festhalten (Telegram und Browser), sendAndRecord aus outbox.ts */
  sendAndRecord(input: SendAndRecordInput): Promise<SendAndRecordResult>;
  postWeb?: PostWeb;
  /** Direktchat für die Kopie bei reinen Web-Gesprächen, nur mit Telegram */
  dmChatId(): string | undefined;
  /** Standard applyToEntry aus dem Dienst */
  apply?(action: SearchAction, id: string): Promise<boolean>;
  log?: Log;
}

/** Eintrags-IDs aus dem Bezug der Frage; null, wenn er nicht lesbar ist */
function idsOf(ref: string | undefined): string[] | null {
  try {
    const ids: unknown = JSON.parse(ref ?? "");
    return Array.isArray(ids) && ids.every(id => typeof id === "string" && id !== "") ? ids : null;
  } catch {
    return null;
  }
}

/** Handler der Art "memory" (onChoiceDecided) samt Meldung des Ergebnisses */
export function createMemoryChoices(deps: MemoryChoicesDeps): { handler: ChoiceHandler } {
  const log = deps.log ?? defaultLog;
  const apply = deps.apply ?? applyToEntry;

  async function record(input: SendAndRecordInput, choiceId: string): Promise<void> {
    try {
      if (!outboxDelivered(await deps.sendAndRecord(input))) log(`[Gedächtnis] Ergebnis zu ${choiceId} nicht zugestellt`);
    } catch (e) {
      log(`[Gedächtnis] Ergebnis zu ${choiceId} nicht zugestellt (${errorName(e)})`);
    }
  }

  async function web(conversationId: string, text: string, choiceId: string): Promise<void> {
    try {
      if (!deps.postWeb || !(await deps.postWeb(conversationId, { text, kind: "notice", source: MEMORY_SOURCE }))) {
        log(`[Gedächtnis] Ergebnis zu ${choiceId}: Web-Gespräch nicht erreichbar`);
      }
    } catch (e) {
      log(`[Gedächtnis] Ergebnis zu ${choiceId} nicht ins Web-Gespräch gelegt (${errorName(e)})`);
    }
  }

  /** Ergebnis ins Gespräch der Frage (Web-Gespräch zusätzlich als Kopie in den Direktchat; ohne Telegram nur WebUI) */
  async function say(choice: Choice, text: string): Promise<void> {
    if (choice.noTelegram) return web(choice.noTelegram.conversationId, text, choice.id);
    const c: ChoiceConversation = choice.conversation;
    if (c.type === "telegram") {
      return record({ chatId: c.chatId, ...(c.topicId !== undefined ? { topicId: c.topicId } : {}), text, source: MEMORY_SOURCE, format: "plain" }, choice.id);
    }
    await web(c.conversationId, text, choice.id);
    const dm = deps.dmChatId();
    if (dm) await record({ chatId: dm, text: `${WEB_COPY_PREFIX}${text}`, source: MEMORY_SOURCE, format: "plain" }, choice.id);
  }

  const handler: ChoiceHandler = async choice => {
    const action = choice.action as SearchAction | undefined;
    const key = choice.result?.key;
    const ids = idsOf(choice.ref);
    if (!action || !ACTIONS.includes(action) || !ids || !key) throw new Error("Gedächtnis-Frage ohne Aktion, Einträge oder Auswahl");
    if (key === NONE_KEY) {
      log(`[Gedächtnis] Rückfrage ${choice.id}: keins gewählt`);
      await say(choice, MEMORY_CHOICE_TEXT.nothing);
      return;
    }
    const position = ENTRY_KEY.exec(key);
    const id = position ? ids[Number(position[1])] : undefined;
    if (!id) throw new Error("Auswahl ohne Eintrag");
    let changed: boolean;
    try {
      changed = await apply(action, id);
    } catch (e) {
      await say(choice, MEMORY_CHOICE_TEXT.failed);
      throw e;
    }
    log(`[Gedächtnis] Rückfrage ${choice.id}: ${action} ${key} (${choice.result?.via ?? "-"}), ${changed ? "geändert" : "Eintrag fehlt"}`);
    const label = choice.options.find(o => o.key === key)?.label ?? key;
    await say(choice, changed ? MEMORY_CHOICE_TEXT.applied[action](label) : MEMORY_CHOICE_TEXT.gone);
  };

  return { handler };
}
