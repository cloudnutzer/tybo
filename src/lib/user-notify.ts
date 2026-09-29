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
 * Telegram-Ausgabe bleibt erhalten.
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
  /** Rückfall für Telegram-Ziele, die die Outbox ablehnt; darf werfen */
  sendTelegram?(chatId: string, text: string, topicId?: number, buttons?: InlineButton[][]): Promise<void>;
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
}

/** Meldung an den Nutzer; true, wenn zugestellt. Wirft nicht. */
export type UserNotifier = (text: string, target?: UserNotice) => Promise<boolean>;

export function createUserNotifier(deps: UserNotifierDeps): UserNotifier {
  const log = deps.log ?? ((line: string) => console.warn(line));
  return async (text, target = {}) => {
    const { chatId, topicId, buttons, telegramOnly } = target;
    const source = target.source ?? SYSTEM_NOTICE_SOURCE;
    const format = target.format ?? "markdown";
    try {
      const telegram = deps.telegram() && !isWebChatId(chatId);
      // Nur für Telegram bestimmt: ohne Telegram gibt es nichts zu melden
      if (!telegram && telegramOnly) return true;
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
          }
        : { text, source, format, chatId: isWebChatId(chatId) ? chatId : WEB_DM_CHAT_ID };
      const result = await deps.send(input);
      if (telegram && result.error?.kind === "invalid" && !result.messages?.length && deps.sendTelegram) {
        await deps.sendTelegram(chatId || deps.dmChatId?.() || "", text, topicId, buttons);
        return true;
      }
      const delivered = outboxDelivered(result);
      if (!delivered) log("[meldung] Meldung an den Nutzer nicht zugestellt");
      return delivered;
    } catch (e) {
      log(`[meldung] Meldung an den Nutzer nicht zugestellt (${e instanceof Error ? e.name : "Fehler"})`);
      return false;
    }
  };
}
