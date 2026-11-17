/**
 * Zustellwege des WhatsApp-Gateways für Rückfragen aus dem Besitzer-Turn
 * (Issue #345): Merk-Vorschläge aus Turns mit fremden Inhalten (Issue #53,
 * #117) und die Auswahl bei mehrdeutigen DONE, CANCEL und FORGET (Issue #316).
 *
 * Das Gateway ist ein eigener Prozess ohne pollenden Bot, wie die
 * Sprach-Brücke. Die Rückfrage kommt in dasselbe Register (data/choices.json),
 * der Vorschlag in dieselbe Ablage (data/pending-reviews.json). Gezeigt wird
 * sie im Direktchat des Besitzers: mit Telegram per Bot-API samt Knöpfen,
 * ohne Telegram festgehalten im Web-Direktchat "web" für die WebUI. Den Klick
 * beantwortet in beiden Fällen der laufende Bot, nur dort wirkt er (einmal).
 * In WhatsApp gibt es keine Knöpfe.
 */
import { Api } from "grammy";
import { telegramConfigured } from "../../lib/channels";
import { setMemoryAsker, setMemoryFailureNotice } from "../../lib/memory";
import { createMemoryAsker, createMemoryChoices } from "../../lib/memory/choices";
import { sendAndRecord } from "../../lib/outbox";
import { createReviewNotifier } from "../../lib/review-choices";
import { setReviewNotifier } from "../../lib/session-distill";
import { createTelegramChoices, type ChoiceEditApi, type TelegramChoicesDeps } from "../../lib/telegram-choices";

type Env = Record<string, string | undefined>;

/** Prozessweite Anmeldungen; Tests ersetzen sie */
export const WHATSAPP_CHOICE_INSTALLERS = { setReviewNotifier, setMemoryAsker, setMemoryFailureNotice };

export interface WhatsAppChoiceOptions {
  /** Bot-API zum Nachziehen der Knöpfe; Standard grammY mit TELEGRAM_BOT_TOKEN */
  createApi?(token: string): ChoiceEditApi;
  /** Versand mit Festhalten; Standard sendAndRecord aus outbox.ts */
  send?: TelegramChoicesDeps["send"];
  installers?: Partial<typeof WHATSAPP_CHOICE_INSTALLERS>;
}

/** Richtet die Zustellwege im Gateway-Prozess ein, dazu die Meldung über nicht gespeicherte Ziele (Issue #518) */
export function installWhatsAppChoices(env: Env, options: WhatsAppChoiceOptions = {}): void {
  const install = { ...WHATSAPP_CHOICE_INSTALLERS, ...options.installers };
  const telegram = telegramConfigured(env);
  const createApi = options.createApi ?? ((token: string) => new Api(token));
  const choices = createTelegramChoices({
    ...(telegram ? { api: createApi(env.TELEGRAM_BOT_TOKEN!.trim()), owner: env.TELEGRAM_USER_ID!.trim() } : {}),
    ...(options.send ? { send: options.send } : {}),
    telegram: () => telegramConfigured(env),
  });
  const ways = { sendChoice: (choice: Parameters<typeof choices.sendChoice>[0]) => choices.sendChoice(choice) };
  install.setReviewNotifier(createReviewNotifier(ways));
  install.setMemoryAsker(createMemoryAsker(ways));
  install.setMemoryFailureNotice(createMemoryChoices({ sendAndRecord: options.send ?? (input => sendAndRecord(input)), dmChatId: () => (telegram ? env.TELEGRAM_USER_ID!.trim() : undefined) }).failureNotice);
}
