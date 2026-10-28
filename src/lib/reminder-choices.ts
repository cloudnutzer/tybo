/**
 * Erinnerungen zustellen und ihre Knöpfe (Issue #322, Entscheidungen 0017
 * und E2): Art "reminder" im Rückfragen-Register, ref ist die ID des
 * Eintrags in der Ablage (schedule/store.ts), action der Termin, zu dem die
 * Erinnerung zugestellt wurde ("due-" und die Millisekunden in Basis 36).
 *
 * Zustellung (createReminderSender, vom Planer aufgerufen): erst die
 * Rückfrage anlegen, dann genau eine Meldung über createUserDelivery
 * (user-notify.ts) mit choiceId: in Telegram mit den Knöpfen an der
 * Nachricht, in der WebUI zeigt der Browser die Knöpfe aus dem Register.
 * Es gibt also keinen zweiten Versand über sendChoice. Ziel ist das
 * Gespräch des Eintrags; ohne Telegram geht eine Erinnerung aus einem
 * Telegram-Gespräch in den Web-Direktchat, und die Rückfrage gehört dann
 * auch dorthin (sonst wäre sie im Browser nicht entscheidbar). Eine
 * Erinnerung aus einem Turn ohne Telegram (Chat-ID aus webOnlyChatId,
 * schedule/remind.ts) kommt mit Telegram nur in das WebUI-Gespräch dieses
 * Telegram-Chats ("dm" bzw. "topic-<n>", über postWeb), die Rückfrage trägt
 * noTelegram wie die Merk-Rückfragen; die Antwort auf den Knopf ebenso. Eine neue
 * Zustellung desselben Eintrags lässt dessen ältere offene Rückfragen
 * ablaufen. Scheitert das Anlegen der Rückfrage, kommt die Erinnerung ohne
 * Knöpfe; ist sie sicher nicht angekommen, läuft die Rückfrage ab.
 *
 * Knöpfe (createReminderChoices, Handler im Gewinnerprozess von decideChoice):
 * - „Erledigt": ändert nichts. Eine einmalige Erinnerung ist nach der
 *   Zustellung schon erledigt, eine Serie läuft weiter.
 * - „in 1 Stunde" und „morgen 9 Uhr" (in USER_TIMEZONE): eine einmalige
 *   Erinnerung bekommt den neuen Termin (due_at) und wartet wieder, aber nur,
 *   solange sie noch genau die zugestellte ist (derselbe Termin; bedingte
 *   Änderung). Ein alter Knopf verändert so nie einen späteren Termin. Die
 *   Knöpfe sind schon sichtbar, während der Planer den Versand noch
 *   abschließt (status running): dann übernimmt der Klick den Eintrag samt
 *   Übernahme (leaseOwner leer), der Abschluss des Planers trifft danach
 *   nicht mehr und überschreibt nichts. Erst running, dann done versucht:
 *   der Planer wechselt nur von running nach done, so geht kein Klick
 *   zwischen beiden verloren. Bei einer Serie bleibt die Serie, wie sie
 *   ist; zum neuen Termin kommt eine einmalige Kopie. Gleichzeitig mit
 *   /erinnerungen absagen: Die Kopie wird angelegt, danach die Serie frisch
 *   gelesen. Ist sie inzwischen abgesagt (oder weg, oder nicht lesbar),
 *   nimmt der Handler die Kopie mit cancel() zurück und meldet „gibt es
 *   nicht mehr" bzw. einen Fehler; nur wenn die Serie danach noch läuft,
 *   heißt es „die Serie läuft weiter". Eine Absage nach diesem Lesen trifft
 *   die Serie; die Kopie stand da schon als eigene Erinnerung in der Liste.
 * Antworten gehen über notify ins Gespräch der Rückfrage. Ins Log kommen nur IDs.
 */
import {
  attachChoiceTelegram as realAttach,
  createChoice as realCreate,
  expireChoice as realExpire,
  type Choice,
  type ChoiceConversation,
  type ChoiceHandler,
  type ChoiceOption,
  type ChoiceTelegramRef,
} from "./choices";
import { isWebChatId, WEB_DM_CHAT_ID } from "./channels";
import { reviewConversation, type PostWeb } from "./review-choices";
import type { ScheduledTask, ScheduleStore } from "./schedule/contract";
import { shortStamp, type SendOutcome } from "./schedule/planner";
import { webOnlyChatOf } from "./schedule/remind";
import { choiceButtons } from "./telegram-choices";
import type { UserDeliverer } from "./user-notify";
import { clockAt, effectiveTimeZone, fromLocal, shiftDays } from "./when";

type Log = (line: string) => void;
const defaultLog: Log = line => console.log(line);

/** Absender in der WebUI, wie CHOICE_SOURCES.reminder */
export const REMINDER_SOURCE = "erinnerung";

export const REMINDER_OPTIONS: ChoiceOption[] = [
  { key: "done", label: "Erledigt" },
  { key: "hour", label: "in 1 Stunde" },
  { key: "tomorrow", label: "morgen 9 Uhr" },
];

type ReminderButton = "done" | "hour" | "tomorrow";
const isButton = (key: unknown): key is ReminderButton => key === "done" || key === "hour" || key === "tomorrow";

export const REMINDER_CHOICE_TEXT = {
  done: "Erledigt.",
  moved: (stamp: string) => `Verschoben auf ${stamp}.`,
  copied: (stamp: string) => `Ich erinnere dich am ${stamp} noch einmal, die Serie läuft weiter.`,
  changed: "Diese Erinnerung hat sich inzwischen geändert, nichts verschoben.",
  gone: "Diese Erinnerung gibt es nicht mehr, nichts verschoben.",
  failed: "Das hat nicht geklappt, die Erinnerung bleibt, wie sie ist.",
} as const;

const HOUR = 3_600_000;
const TELEGRAM_CHAT = /^-?\d{1,20}$/;

/** Termin an der Rückfrage (Choice.action) */
export function occurrenceAction(dueAt: string): string {
  return `due-${Date.parse(dueAt).toString(36)}`;
}

/** Millisekunden aus occurrenceAction; null, wenn es keine ist */
export function occurrenceOf(action: string | undefined): number | null {
  const m = /^due-([0-9a-z]{1,12})$/.exec(action ?? "");
  if (!m) return null;
  const ms = parseInt(m[1], 36);
  return Number.isSafeInteger(ms) ? ms : null;
}

/** Morgen 9:00 in der Zone, vom Zeitpunkt now aus */
export function tomorrowAtNine(now: number, timeZone: string): Date {
  const day = shiftDays(clockAt(now, timeZone), 1);
  return new Date(fromLocal(day.year, day.month, day.day, 9, 0, 0, timeZone));
}

export interface ReminderTarget {
  chatId: string;
  topicId?: number;
  /** Gespräch der Rückfrage, passend zum Ort der Meldung */
  conversation: ChoiceConversation;
  /** Nur in dieses WebUI-Gespräch ("dm", "topic-<n>"), nie nach Telegram */
  webOnly?: string;
}

/** WebUI-Gespräch eines Telegram-Chats: Gruppen (negative ID) nach Topic, General ist topic-1 */
function webConversationOfTelegram(chatId: string, topicId: number | undefined): string {
  return chatId.startsWith("-") ? `topic-${topicId ?? 1}` : "dm";
}

/**
 * Ziel einer Erinnerung: Web-Gespräch bzw. Web-Direktchat wie gespeichert,
 * Telegram-Chat (mit Topic) nur mit Telegram, sonst der Web-Direktchat; ein
 * Telegram-Chat aus webOnlyChatId mit Telegram nur in sein WebUI-Gespräch.
 * Unbekannte Chat-Kennung: null.
 */
export function reminderTarget(task: Pick<ScheduledTask, "chatId" | "topicId">, telegram: boolean): ReminderTarget | null {
  const webOnlyChat = webOnlyChatOf(task.chatId);
  const chatId = webOnlyChat ?? task.chatId;
  if (isWebChatId(chatId)) {
    const conversation = reviewConversation(chatId);
    return conversation ? { chatId, conversation } : null;
  }
  if (!TELEGRAM_CHAT.test(chatId)) return null;
  if (!telegram) return { chatId: WEB_DM_CHAT_ID, conversation: reviewConversation(WEB_DM_CHAT_ID)! };
  const topicId = task.topicId ?? undefined;
  return {
    chatId,
    ...(topicId !== undefined ? { topicId } : {}),
    conversation: reviewConversation(chatId, topicId)!,
    ...(webOnlyChat !== null ? { webOnly: webConversationOfTelegram(chatId, topicId) } : {}),
  };
}

export interface ReminderSenderDeps {
  deliver: UserDeliverer;
  /** Meldung in ein WebUI-Gespräch ohne Telegram (Erinnerung aus einem Turn ohne Telegram) */
  postWeb?: PostWeb;
  /** Telegram eingerichtet? */
  telegram(): boolean;
  createChoice?: typeof realCreate;
  attach?: typeof realAttach;
  expire?: typeof realExpire;
  /** Zieht die Telegram-Nachricht nach, wenn die Frage während des Sendens erledigt wurde */
  refresh?(choice: Choice, refs: ChoiceTelegramRef[]): Promise<unknown>;
  log?: Log;
}

/** Versand einer Erinnerung samt Rückfrage für den Planer (siehe Kopf) */
export function createReminderSender(deps: ReminderSenderDeps): (task: ScheduledTask, text: string) => Promise<SendOutcome> {
  const log = deps.log ?? defaultLog;
  const create = deps.createChoice ?? realCreate;
  const attach = deps.attach ?? realAttach;
  const expire = deps.expire ?? realExpire;

  return async (task, text) => {
    const telegram = deps.telegram();
    const target = reminderTarget(task, telegram);
    if (!target) {
      log(`[erinnerung] ${task.id}: unbekanntes Gespräch, nicht zugestellt`);
      return "rejected";
    }
    let choice: Choice | null = null;
    try {
      choice = await create(
        {
          kind: "reminder",
          conversation: target.conversation,
          text,
          options: REMINDER_OPTIONS,
          ref: task.id,
          action: occurrenceAction(task.dueAt),
          ...(target.webOnly ? { noTelegram: { conversationId: target.webOnly } } : {}),
        },
        { replace: c => c.kind === "reminder" && c.ref === task.id },
      );
    } catch {
      log(`[erinnerung] ${task.id}: Rückfrage nicht angelegt, Erinnerung ohne Knöpfe`);
    }
    if (target.webOnly) {
      let outcome: SendOutcome;
      try {
        const post = { text, kind: "notice" as const, source: REMINDER_SOURCE, ...(choice ? { choiceId: choice.id } : {}) };
        outcome = deps.postWeb && (await deps.postWeb(target.webOnly, post)) ? "delivered" : "rejected";
      } catch {
        outcome = "unclear";
      }
      if (outcome === "rejected") log(`[erinnerung] ${task.id}: WebUI-Gespräch nicht erreichbar`);
      if (choice && outcome === "rejected") await Promise.resolve(expire(choice.id)).catch(() => {});
      return outcome;
    }
    const toTelegram = telegram && !isWebChatId(target.chatId);
    const delivery = await deps.deliver(text, {
      chatId: target.chatId,
      ...(target.topicId !== undefined ? { topicId: target.topicId } : {}),
      source: REMINDER_SOURCE,
      format: "plain",
      ...(choice ? { choiceId: choice.id } : {}),
      ...(choice && toTelegram ? { buttons: choiceButtons(choice) } : {}),
    });
    if (!choice) return delivery.outcome;
    try {
      if (delivery.outcome === "rejected") await expire(choice.id);
      else if (delivery.telegram.length) {
        const stored = await attach(choice.id, delivery.telegram);
        if (!stored) await deps.refresh?.({ ...choice, state: "expired" }, delivery.telegram);
        else if (stored.state !== "open") await deps.refresh?.(stored, delivery.telegram);
      }
    } catch {
      log(`[erinnerung] ${task.id}: Rückfrage ${choice.id} nicht nachgetragen`);
    }
    return delivery.outcome;
  };
}

export interface ReminderChoicesDeps {
  store(): ScheduleStore;
  now(): number;
  /** IANA-Zeitzone; Standard USER_TIMEZONE */
  timeZone?(): string;
  /** Antwort im Gespräch der Rückfrage; darf werfen, geloggt wird hier */
  notify(conversation: ChoiceConversation, text: string): Promise<void>;
  /** Antwort auf eine Rückfrage mit noTelegram, nur ins WebUI-Gespräch */
  postWeb?: PostWeb;
  log?: Log;
}

export function createReminderChoices(deps: ReminderChoicesDeps): { handler: ChoiceHandler } {
  const log = deps.log ?? defaultLog;
  const zone = () => effectiveTimeZone(deps.timeZone?.());

  async function say(choice: Choice, text: string): Promise<void> {
    try {
      if (choice.noTelegram) {
        const posted = deps.postWeb && (await deps.postWeb(choice.noTelegram.conversationId, { text, kind: "notice", source: REMINDER_SOURCE }));
        if (!posted) throw new Error("WebUI-Gespräch nicht erreichbar");
      } else await deps.notify(choice.conversation, text);
    } catch {
      log(`[erinnerung] Antwort zu Rückfrage ${choice.id} nicht zugestellt`);
    }
  }

  const handler: ChoiceHandler = async choice => {
    const id = choice.ref;
    const key = choice.result?.key;
    const occurrence = occurrenceOf(choice.action);
    if (typeof id !== "string" || !id || !isButton(key) || occurrence === null) throw new Error("Erinnerungs-Frage ohne Eintrag, Termin oder gültige Auswahl");
    log(`[erinnerung] ${id}: ${key} (${choice.result?.via ?? "-"})`);
    if (key === "done") {
      await say(choice, REMINDER_CHOICE_TEXT.done);
      return;
    }
    const store = deps.store();
    const now = deps.now();
    const due = key === "hour" ? new Date(now + HOUR) : tomorrowAtNine(now, zone());
    const stamp = shortStamp(due.getTime(), zone());
    const task = await store.byId(id);
    if (!task || task.status === "cancelled") {
      await say(choice, REMINDER_CHOICE_TEXT.gone);
      return;
    }
    if (task.recurrence) {
      const copy = await store.add({ chatId: task.chatId, topicId: task.topicId, kind: "reminder", text: task.text, dueAt: due });
      if (!copy) {
        await say(choice, REMINDER_CHOICE_TEXT.failed);
        throw new Error("Kopie der Erinnerung nicht angelegt");
      }
      // Gleichzeitige Absage der Serie (siehe Kopf): nach dem Anlegen frisch lesen, mit Fehlersignal
      const fresh = await store.listAll({ idPrefix: id });
      const series = fresh?.find(t => t.id === id);
      if (series && series.status !== "cancelled") {
        await say(choice, REMINDER_CHOICE_TEXT.copied(stamp));
        return;
      }
      // Abgesagt, weg oder nicht lesbar: die Kopie zurücknehmen (lieber keine als eine nach der Absage)
      const withdrawn = await store.cancel(copy.id);
      if (!fresh || !withdrawn) {
        log(`[erinnerung] ${id}: Serie nicht lesbar oder Kopie ${copy.id} nicht zurückgenommen`);
        await say(choice, REMINDER_CHOICE_TEXT.failed);
        throw new Error("Serie nach dem Kopieren nicht prüfbar");
      }
      await say(choice, REMINDER_CHOICE_TEXT.gone);
      return;
    }
    // Zuerst den noch laufenden Versand übernehmen, dann den abgeschlossenen (siehe Kopf)
    const delivered = new Date(occurrence);
    const waiting = { status: "pending", dueAt: due, attempts: 0, lastError: null } as const;
    const moved =
      (await store.updateIf(id, { status: "running", dueAt: delivered }, { ...waiting, leaseOwner: null, leaseUntil: null, sendStartedAt: null })) ??
      (await store.updateIf(id, { status: "done", dueAt: delivered }, waiting));
    await say(choice, moved ? REMINDER_CHOICE_TEXT.moved(stamp) : REMINDER_CHOICE_TEXT.changed);
  };

  return { handler };
}
