/**
 * An den Nutzer melden (Issue #227): ein Weg für bot-interne Meldungen
 * (Neustart, Credit-Guard, Erinnerungen an liegengebliebene Aufgaben,
 * Goal-Status). Alles geht über die Outbox (sendAndRecord): mit Telegram
 * dorthin wie bisher und genau einmal für die WebUI festgehalten, ohne
 * Telegram nur festgehalten (WebUI und Push). Web-Chat-IDs ("web",
 * web:<uuid>) gehen immer nur in die WebUI.
 *
 * Mit Telegram und einem Ziel, das die Outbox nicht kennt (etwa eine alte
 * Gruppe statt der Forum-Gruppe, Fehler "invalid"), geht die Meldung wie vor
 * Issue #227 direkt über den Haupt-Bot (sendTelegram), ohne Festhalten: die
 * Telegram-Ausgabe bleibt erhalten. Liefert der Rückfall die Nachrichten-ID,
 * meldet createUserDelivery auch diese Nachricht mit Knöpfen.
 *
 * createUserDelivery (Issue #322) ist derselbe Weg mit genauerem Ergebnis:
 * Ausgang (zugestellt, sicher abgelehnt, unklar) und die Telegram-Nachrichten
 * mit Knöpfen, damit eine Rückfrage aus dem Register (choiceId) in Telegram
 * nachgezogen werden kann. Die WebUI zeigt die Knöpfe einer Meldung mit
 * choiceId aus dem Register. createUserNotifier liefert davon nur „zugestellt".
 */

import { isWebChatId, outboxDelivered, WEB_DM_CHAT_ID } from "./channels";
import type { InlineButton, SendAndRecordInput, SendAndRecordResult } from "./outbox";

/** Absender bot-interner Meldungen in der WebUI */
export const SYSTEM_NOTICE_SOURCE = "system";

export interface UserNotifierDeps {
  /** telegramConfigured zum Zeitpunkt der Meldung */
  telegram(): boolean;
  /** sendAndRecord aus outbox.ts */
  send(input: SendAndRecordInput): Promise<SendAndRecordResult>;
  /**
   * Rückfall für Telegram-Ziele, die die Outbox ablehnt; darf werfen
   * (TelegramRejectedError: sicher abgelehnt, sonst unklar). Liefert
   * er die Nachrichten-ID, meldet createUserDelivery die Nachricht mit Knöpfen
   * (Issue #322), sonst bleibt telegram leer
   */
  sendTelegram?(chatId: string, text: string, topicId?: number, buttons?: InlineButton[][]): Promise<void | { messageId: number }>;
  /** Direktchat in Telegram (TELEGRAM_USER_ID), Ziel des Rückfalls ohne chatId */
  dmChatId?(): string;
  /** Nie Meldungstexte übergeben */
  log?(line: string): void;
}

export interface UserNotice {
  /** Gespräch der Meldung; fehlt: Direktchat */
  chatId?: string;
  topicId?: number;
  /** Absender in der WebUI, Standard system */
  source?: string;
  /** Standard "markdown" (in Telegram als HTML); "plain" unverändert */
  format?: "markdown" | "plain";
  /** Knöpfe nur in Telegram, die WebUI zeigt den Text */
  buttons?: InlineButton[][];
  /** Nur in Telegram, nie festhalten (etwa der Goal-Zwischenstand, den die Karte zeigt) */
  telegramOnly?: boolean;
  /** Rückfrage aus dem Register (Issue #322): metadata.choiceId des Eintrags, die WebUI zeigt ihre Knöpfe */
  choiceId?: string;
}

/**
 * Wirft sendTelegram, wenn Telegram den Rückfall sicher abgelehnt hat (Antwort
 * mit Status 4xx, nichts angenommen). Jeder andere Fehler gilt als unklar.
 */
export class TelegramRejectedError extends Error {
  override name = "TelegramRejectedError";
}

/** Meldung an den Nutzer; true, wenn zugestellt. Wirft nicht. */
export type UserNotifier = (text: string, target?: UserNotice) => Promise<boolean>;

export interface UserDelivery {
  /** Wie outboxDelivered: an Telegram gesendet bzw. für die WebUI festgehalten */
  delivered: boolean;
  /**
   * "delivered": angekommen, auch nur teilweise (Telegram angenommen, Festhalten
   * gescheitert); "rejected": sicher nicht angekommen (Eingabe abgelehnt oder
   * Telegram hat ohne angenommene Nachricht abgelehnt); "unclear": Ausnahme,
   * Netzfehler oder Festhalten gescheitert, es kann trotzdem angekommen sein
   */
  outcome: "delivered" | "rejected" | "unclear";
  /** Von Telegram angenommene Nachrichten mit Knöpfen */
  telegram: { chatId: string; messageId: number }[];
}

/** Meldung an den Nutzer mit genauem Ergebnis. Wirft nicht. */
export type UserDeliverer = (text: string, target?: UserNotice) => Promise<UserDelivery>;

/** Ausgang eines Ergebnisses der Outbox, siehe UserDelivery */
function outcomeOf(result: SendAndRecordResult): UserDelivery["outcome"] {
  if (outboxDelivered(result) || (result.messages?.length ?? 0) > 0) return "delivered";
  const error = result.error;
  if (error?.kind === "invalid" || (error?.kind === "send" && error.rejected)) return "rejected";
  return "unclear";
}

export function createUserNotifier(deps: UserNotifierDeps): UserNotifier {
  const deliver = createUserDelivery(deps);
  return async (text, target) => (await deliver(text, target)).delivered;
}

export function createUserDelivery(deps: UserNotifierDeps): UserDeliverer {
  const log = deps.log ?? ((line: string) => console.warn(line));
  const done = (delivered: boolean, outcome: UserDelivery["outcome"], telegram: UserDelivery["telegram"] = []): UserDelivery => ({ delivered, outcome, telegram });
  return async (text, target = {}) => {
    const { chatId, topicId, buttons, telegramOnly, choiceId } = target;
    const source = target.source ?? SYSTEM_NOTICE_SOURCE;
    const format = target.format ?? "markdown";
    try {
      const telegram = deps.telegram() && !isWebChatId(chatId);
      // Nur für Telegram bestimmt: ohne Telegram gibt es nichts zu melden
      if (!telegram && telegramOnly) return done(true, "delivered");
      // Ohne Telegram: Web-Ziele bleiben, eine Telegram-ID oder ein Topic wird zum Web-Direktchat
      const input: SendAndRecordInput = telegram
        ? {
            text,
            source,
            format,
            ...(chatId ? { chatId } : {}),
            ...(topicId !== undefined ? { topicId } : {}),
            ...(buttons?.length ? { buttons } : {}),
            ...(telegramOnly ? { record: false as const } : {}),
            ...(choiceId ? { choiceId } : {}),
          }
        : { text, source, format, chatId: isWebChatId(chatId) ? chatId : WEB_DM_CHAT_ID, ...(choiceId ? { choiceId } : {}) };
      const result = await deps.send(input);
      if (telegram && result.error?.kind === "invalid" && !result.messages?.length && deps.sendTelegram) {
        const fallbackChat = chatId || deps.dmChatId?.() || "";
        let sent: void | { messageId: number };
        try {
          sent = await deps.sendTelegram(fallbackChat, text, topicId, buttons);
        } catch (e) {
          if (!(e instanceof TelegramRejectedError)) throw e;
          log("[meldung] Meldung an den Nutzer nicht zugestellt (Telegram hat abgelehnt)");
          return done(false, "rejected");
        }
        const refs = buttons?.length && sent && typeof sent.messageId === "number" ? [{ chatId: fallbackChat, messageId: sent.messageId }] : [];
        return done(true, "delivered", refs);
      }
      const delivered = outboxDelivered(result);
      if (!delivered) log("[meldung] Meldung an den Nutzer nicht zugestellt");
      const withButtons = (result.messages ?? []).filter(m => m.buttons).map(m => ({ chatId: m.chatId, messageId: m.messageId }));
      return done(delivered, outcomeOf(result), withButtons);
    } catch (e) {
      log(`[meldung] Meldung an den Nutzer nicht zugestellt (${e instanceof Error ? e.name : "Fehler"})`);
      return done(false, "unclear");
    }
  };
}
