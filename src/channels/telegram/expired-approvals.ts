/**
 * Abgelaufene Werkzeug-Freigaben in Telegram (Issue #352).
 *
 * Knöpfe mit callback_data "toolapproval:<y|n>:<kennung>" stammen aus der
 * Zeit vor dem Rückfragen-Register (Issue #116) und zuletzt vom früheren
 * Server-Gateway. Freigaben fragt tybo heute über das Register
 * (src/lib/tool-approval.ts); hinter einem alten Knopf wartet nichts mehr.
 *
 * Stufe 2 der Knopf-Kette (callbacks.ts), nach der Besitzerprüfung:
 * - alter Freigabe-Knopf vom Besitzer: Antwort „Freigabe abgelaufen“, die
 *   Knöpfe verschwinden aus der Nachricht, sonst passiert nichts
 * - derselbe Knopf von jemand anderem: endet still
 * - jeder andere Knopf: unverändert an die nächste Stufe
 */
import type { Context, MiddlewareFn } from "grammy";

export const EXPIRED_APPROVAL_TEXT = "Freigabe abgelaufen";

/** Aufbau der alten Knöpfe: Erlauben (y) oder Ablehnen (n) und eine Kennung */
const OLD_APPROVAL_DATA = /^toolapproval:[yn]:[a-f0-9-]+$/;

export function expiredApprovalButtons(owner: string): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (!data || !OLD_APPROVAL_DATA.test(data)) return next();
    if (String(ctx.from?.id ?? "") !== owner) return;
    // Ist der Klick zu alt oder die Nachricht schon ohne Knöpfe, bleibt es dabei
    await ctx.answerCallbackQuery({ text: EXPIRED_APPROVAL_TEXT }).catch(() => undefined);
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
  };
}
