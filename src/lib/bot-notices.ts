/**
 * Verdrahtung der bot-internen Meldungen an den Nutzer (Issue #227, als
 * eigenes Modul seit Issue #322): Neustart, Credit-Guard, Rückfall beim
 * Speichern ohne Embedding, liegengebliebene Aufgaben, Goal-Status und
 * Erinnerungen gehen alle über denselben Weg aus user-notify.ts. Mit
 * Telegram an Telegram und einmal für die WebUI festgehalten, ohne Telegram
 * nur in der WebUI. Lehnt die Outbox ein Telegram-Ziel ab, geht die Meldung
 * wie vor Issue #227 direkt über den Haupt-Bot (sendStatusMessage). Für
 * Erinnerungen (deliverToUser) geht der Rückfall über sendMessage, damit die
 * Nachricht mit Knöpfen am Register gemerkt werden kann und ihre Knöpfe in
 * Telegram wirken.
 *
 * src/bot.ts baut die Meldewege nur hier zusammen, damit sie ohne den Bot
 * prüfbar sind (tests/user-notify.test.ts). Kein Weg schickt an der Outbox
 * vorbei an Telegram, außer dem genannten Rückfall.
 */
import { createTelegramGoalStatus } from "./goal-actions";
import type { GoalStatusMessage, GoalTarget } from "./goal-engine";
import type { ChoiceTelegramRef, Choice } from "./choices";
import type { InlineButton, SendAndRecordInput, SendAndRecordResult } from "./outbox";
import type { PostWeb } from "./review-choices";
import { createAskReminderShow, type AskReminderShow, type LegacyTaskNotify } from "./task-reminders";
import { markdownToTelegramHTML, NO_LINK_PREVIEW, stripHtmlTags } from "./telegram";
import {
  createUserDelivery,
  createUserNotifier,
  TelegramRejectedError,
  type UserDeliverer,
  type UserNotifier,
  type UserNotifierDeps,
} from "./user-notify";

export interface BotNoticesDeps {
  /** Telegram eingerichtet? */
  telegram(): boolean;
  /** sendAndRecord aus outbox.ts */
  send(input: SendAndRecordInput): Promise<SendAndRecordResult>;
  /** Haupt-Bot direkt, nur für den Rückfall */
  sendStatusMessage(chatId: string, text: string, topicId?: number, keyboard?: unknown): Promise<unknown>;
  /**
   * Haupt-Bot direkt mit Ergebnis (api.sendMessage), Rückfall von
   * deliverToUser; darf werfen. Fehlt: auch dort sendStatusMessage, ohne Nachrichten-ID
   */
  sendMessage?(chatId: string, text: string, options: Record<string, unknown>): Promise<{ message_id: number }>;
  /** Direktchat in Telegram */
  dmChatId(): string;
  log?(line: string): void;
}

export interface BotNotices {
  notifyUser: UserNotifier;
  /** Derselbe Weg mit Ausgang und Telegram-Nachrichten (Erinnerungen) */
  deliverToUser: UserDeliverer;
  /** Klartext in den Direktchat (Credit-Guard, Rückfall beim Speichern); wartet nicht */
  plain(text: string): void;
  /** Meldung der Neustart-Steuerung ins Gespräch der Anfrage */
  restart(text: string, chatId?: string, topicId?: number): Promise<void>;
  /**
   * Wege der Erinnerungen an wartende Aufträge (createTaskReminders): alte
   * Aufträge mit atask-Knöpfen über den Meldeweg, Rückfragen des Registers
   * als dieselbe Frage. refresh zieht eine Telegram-Nachricht nach, wenn die
   * Frage während des Sendens entschieden wurde; postWeb nur mit WebUI
   */
  taskReminders(options: { refresh(choice: Choice, refs: ChoiceTelegramRef[]): Promise<unknown>; postWeb?: PostWeb }): {
    notifyLegacy: LegacyTaskNotify;
    showAsk: AskReminderShow;
  };
  /** Goal-Status über den gemeinsamen Weg, ohne zweites Festhalten */
  goalStatus(options: { ask?(target: GoalTarget, text: string): Promise<boolean>; noButtonsHint?: string }): (target: GoalTarget, message: GoalStatusMessage) => Promise<void>;
}

/**
 * Status einer sicheren Ablehnung durch Telegram: grammY wirft dann einen
 * GrammyError mit ok false und error_code 4xx (auch 429). Sonst (Netzfehler,
 * Zeitüberschreitung, 5xx, Unbekanntes) undefined: unklar, ob etwas ankam.
 */
function rejectionCode(e: unknown): number | undefined {
  if (e === null || typeof e !== "object") return undefined;
  const { ok, error_code } = e as { ok?: unknown; error_code?: unknown };
  return ok === false && typeof error_code === "number" && error_code >= 400 && error_code <= 499 ? error_code : undefined;
}

function asRejection(e: unknown): unknown {
  return rejectionCode(e) === undefined ? e : new TelegramRejectedError(`Telegram hat abgelehnt (${rejectionCode(e)})`);
}

export function createBotNotices(deps: BotNoticesDeps): BotNotices {
  const notifierDeps: UserNotifierDeps = {
    telegram: deps.telegram,
    send: deps.send,
    sendTelegram: async (chatId: string, text: string, topicId?: number, buttons?: InlineButton[][]) => {
      await deps.sendStatusMessage(chatId, text, topicId, buttons ? { inline_keyboard: buttons } : undefined);
    },
    dmChatId: deps.dmChatId,
    ...(deps.log ? { log: deps.log } : {}),
  };
  const notifyUser = createUserNotifier(notifierDeps);
  const sendMessage = deps.sendMessage;
  // Wie die Outbox (HTML, nur nach einer 400 von Telegram ein zweiter Versuch ohne Auszeichnung), aber mit
  // Nachrichten-ID. Sicher abgelehnt (4xx): TelegramRejectedError. Netzfehler und alles Unklare: kein zweiter
  // Versand, der Fehler geht unverändert weiter (Ausgang unklar)
  const deliverDeps: UserNotifierDeps = sendMessage
    ? {
        ...notifierDeps,
        sendTelegram: async (chatId, text, topicId, buttons) => {
          const options = {
            link_preview_options: NO_LINK_PREVIEW,
            ...(topicId ? { message_thread_id: topicId } : {}),
            ...(buttons ? { reply_markup: { inline_keyboard: buttons } } : {}),
          };
          const html = markdownToTelegramHTML(text);
          try {
            return { messageId: (await sendMessage(chatId, html, { parse_mode: "HTML", ...options })).message_id };
          } catch (e) {
            if (rejectionCode(e) !== 400) throw asRejection(e);
          }
          try {
            return { messageId: (await sendMessage(chatId, stripHtmlTags(html), options)).message_id };
          } catch (e) {
            throw asRejection(e);
          }
        },
      }
    : notifierDeps;
  return {
    notifyUser,
    deliverToUser: createUserDelivery(deliverDeps),
    plain: text => void notifyUser(text, { format: "plain" }),
    restart: async (text, chatId, topicId) => {
      await notifyUser(text, { chatId, topicId });
    },
    taskReminders: ({ refresh, postWeb }) => ({
      notifyLegacy: (text, target) => notifyUser(text, target),
      showAsk: createAskReminderShow({
        telegram: deps.telegram,
        send: deps.send,
        refresh,
        ...(postWeb ? { postWeb } : {}),
        ...(deps.log ? { log: deps.log } : {}),
      }),
    }),
    goalStatus: ({ ask, noButtonsHint }) =>
      createTelegramGoalStatus({ notify: notifyUser, ...(ask ? { ask } : {}), ...(noButtonsHint ? { noButtonsHint } : {}) }),
  };
}
