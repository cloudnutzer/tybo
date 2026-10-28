/**
 * Telegram-Kanal (Issue #344): alle Handler des Haupt-Bots in einem
 * Composer. Er hängt erst beim Start am Bot (telegramRuntime.bot, Issue
 * #228); ohne Telegram gibt es keinen Bot und damit keine Handler, der
 * Import allein pollt nie.
 *
 * Reihenfolge: zuerst die Besitzerprüfung (fremde Absender bleiben ohne
 * Antwort), dann die Knöpfe (src/channels/telegram/callbacks.ts), die
 * Service-Nachrichten zu Topics, Text und Medien. Text, Medien und Knöpfe
 * laufen im Bereich ihres Gesprächs (update-scope.ts) und blockieren grammYs
 * Update-Schleife nicht.
 */
import { Composer, type Context } from "grammy";
import { installCallbackChain, type CallbackChain } from "./callbacks";
import { handleTelegramMedia, type MediaInboxDeps } from "./media-inbox";
import { createTelegramTextInbox, type TextInboxDeps } from "./text-inbox";

export const MEDIA_UPDATES = ["message:voice", "message:photo", "message:document", "message:video", "message:video_note"] as const;
export const TOPIC_SERVICE_UPDATES = ["message:forum_topic_created", "message:forum_topic_edited"] as const;

export interface TelegramChannelDeps {
  /** Telegram-ID des Besitzers; alles andere wird still verworfen */
  owner: string;
  scope(ctx: Context, run: () => Promise<void>): Promise<void>;
  text: TextInboxDeps<Context>;
  media: MediaInboxDeps;
  callbacks: Omit<CallbackChain, "owner" | "scope">;
  /** Topic angelegt oder umbenannt (Issue #32); Fehler behandelt der Empfänger selbst */
  topicService(chatId: string, message: unknown): void;
  logError?(message: string, error: unknown): void;
}

export interface TelegramChannel {
  handlers: Composer<Context>;
  /** Abmelden vom Rückfragen-Register */
  close(): void;
}

export function createTelegramChannel(deps: TelegramChannelDeps): TelegramChannel {
  const logError = deps.logError ?? ((message: string, error: unknown) => console.error(message, error));
  const handlers = new Composer<Context>();

  handlers.use(async (ctx, next) => {
    // Ohne Besitzer-ID nimmt der Kanal nichts an
    if (deps.owner !== "" && String(ctx.from?.id ?? "") === deps.owner) await next();
  });

  const close = installCallbackChain(handlers, { ...deps.callbacks, owner: deps.owner, scope: deps.scope });

  handlers.on([...TOPIC_SERVICE_UPDATES], ctx => {
    deps.topicService(String(ctx.chat?.id ?? ""), ctx.message);
  });

  const handleText = createTelegramTextInbox(deps.text);
  handlers.on("message:text", ctx => {
    deps.scope(ctx, () => handleText(ctx)).catch(error => logError("Text handler error:", error));
  });

  handlers.on([...MEDIA_UPDATES], ctx => {
    deps.scope(ctx, () => handleTelegramMedia(ctx, deps.media)).catch(error => logError("Media handler error:", error));
  });

  return { handlers, close };
}
