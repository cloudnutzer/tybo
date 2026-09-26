import { Bot, InlineKeyboard, type Context, type MiddlewareFn } from "grammy";
import { setToolApprovalHandler, toolApprovalPreview } from "./tools/registry";
import { currentExecution } from "./execution-context";
import { installTelegramOutputGuard, NO_LINK_PREVIEW } from "./telegram";
import { sanitizeToolArgs } from "./tool-approval";

/** callback_data der Freigabe-Knöpfe vor dem Rückfragen-Register */
const LEGACY_CALLBACK = /^toolapproval:([yn]):([a-f0-9-]+)$/;
export const LEGACY_EXPIRED_TEXT = "Freigabe abgelaufen";

/**
 * Nur noch für den VPS-Gateway (src/vps-gateway.ts, Nicht-Ziel von Issue
 * #116): Frage an den Besitzer im Direktchat, Knöpfe "toolapproval:",
 * offene Freigaben nur im Speicher. Der Bot selbst fragt über das
 * Rückfragen-Register (src/lib/tool-approval.ts).
 *
 * Register after owner authentication and before the ordinary callback handler.
 */
export function installTelegramToolApproval(bot: Bot, owner: string): void {
  // Issue #52: Werkzeugargumente stammen vom Modell
  installTelegramOutputGuard(bot.api);
  const pending = new Map<string, (approved: boolean) => void>();
  bot.on("callback_query:data", async (ctx, next) => {
    const match = ctx.callbackQuery.data.match(LEGACY_CALLBACK);
    if (!match) return next();
    if (String(ctx.from.id) !== owner) return;
    const resolve = pending.get(match[2]);
    if (!resolve) { await ctx.answerCallbackQuery({ text: LEGACY_EXPIRED_TEXT }); return; }
    resolve(match[1] === "y");
    await ctx.answerCallbackQuery();
    await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  });
  setToolApprovalHandler((tool, args) => new Promise<boolean>(resolve => {
    const id = crypto.randomUUID();
    const signal = currentExecution()?.controller.signal;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (approved: boolean) => {
      pending.delete(id); clearTimeout(timer); signal?.removeEventListener("abort", abort); resolve(approved);
    };
    const abort = () => finish(false);
    pending.set(id, finish);
    timer = setTimeout(() => finish(false), 600_000);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { finish(false); return; }
    const preview = toolApprovalPreview(sanitizeToolArgs(args) as Record<string, unknown>);
    void bot.api.sendMessage(owner, `Tool-Freigabe: ${tool.name}\n${tool.description.slice(0, 150)}\n\n${preview}`, {
      link_preview_options: NO_LINK_PREVIEW,
      reply_markup: new InlineKeyboard().text("Erlauben", `toolapproval:y:${id}`).text("Ablehnen", `toolapproval:n:${id}`),
    }).catch(() => finish(false));
  }));
}

/**
 * Knöpfe "toolapproval:" aus der Zeit vor dem Rückfragen-Register (Issue
 * #116): Die Freigabe dahinter gibt es nach dem Update nicht mehr, der Klick
 * meldet "Freigabe abgelaufen" und nimmt die Knöpfe weg. Alles andere geht an
 * next. Nach der Besitzerprüfung registrieren.
 */
export function legacyToolApprovalMiddleware(owner: string): MiddlewareFn<Context> {
  return async (ctx, next) => {
    const data = ctx.callbackQuery?.data;
    if (typeof data !== "string" || !LEGACY_CALLBACK.test(data)) return next();
    if (String(ctx.from?.id ?? "") !== owner) return;
    await ctx.answerCallbackQuery({ text: LEGACY_EXPIRED_TEXT }).catch(() => {});
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
  };
}
