/**
 * Fortschrittsanzeige eines Turns in Telegram, aus src/bot.ts herausgelöst,
 * damit Tests den Weg bis zur Bot-API prüfen können (Issue #52).
 */
import type { Context } from "grammy";
import type { TurnSink } from "./chat-turn";
import { escapeHtml, NO_LINK_PREVIEW } from "./telegram";

/**
 * Telegram sink for the streaming path: one "Working on it..." message that
 * collects tool steps and the first snippet, deleted once the turn is done.
 * Edits run one after another so a late edit cannot outlive the delete.
 * Snippets use telegramText (vor der Kürzung bereinigt, Issue #52), sonst text.
 */
export function createTelegramProgressSink(ctx: Context, notice: (text: string) => Promise<unknown>): TurnSink {
  let progressMsgId: number | undefined;
  const progressSteps: string[] = ["<i>Working on it...</i>"];
  let closed = false;
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    queue = queue.then(fn).catch(() => {});
    return queue;
  };

  // Send or edit the progress message
  const updateProgress = (step: string) =>
    enqueue(async () => {
      if (closed) return;
      progressSteps.push(`→ ${step}`);
      const text = progressSteps.join("\n");
      try {
        if (!progressMsgId) {
          const msg = await ctx.reply(text, { parse_mode: "HTML", link_preview_options: NO_LINK_PREVIEW });
          progressMsgId = msg.message_id;
        } else {
          await ctx.api.editMessageText(ctx.chat!.id, progressMsgId, text, {
            parse_mode: "HTML",
            link_preview_options: NO_LINK_PREVIEW,
          });
        }
      } catch {
        // Edit can fail if text is identical or message too old, ignore
      }
    });

  return {
    start: () =>
      enqueue(async () => {
        try {
          const msg = await ctx.reply("<i>Working on it...</i>", { parse_mode: "HTML" });
          progressMsgId = msg.message_id;
        } catch {}
      }),
    progress: (p) => {
      if (p.kind === "tool") return updateProgress(escapeHtml(p.text));
      const snippet = p.telegramText ?? p.text;
      // Leer: nach dem Bereinigen blieb kein brauchbarer Anfang übrig
      if (!snippet) return;
      return updateProgress(`<i>"${escapeHtml(snippet)}..."</i>`);
    },
    notice: (text) => notice(text).then(() => {}),
    // Delete progress message before the final response (or abort/fallback)
    finish: () =>
      enqueue(async () => {
        closed = true;
        if (progressMsgId) {
          try {
            await ctx.api.deleteMessage(ctx.chat!.id, progressMsgId);
          } catch {
            // May fail if message is too old, that's fine
          }
        }
      }),
  };
}
