/**
 * Antwort auf eine Nachricht direkt aus Telegram (Issue #336), verdrahtet
 * in src/app/bot-telegram-channel.ts und ohne Start des Bots prüfbar. Reihenfolge je Turn: Turn mit
 * Fortschritt, Abbruch melden, sonst der gemeinsame Abschluss
 * (src/lib/turn-finish.ts, Issue #339): Antwort speichern, Merk-Tags, /goal,
 * dann entweder die befragten Agenten ([INVOKE:]) oder die Antwort selbst,
 * danach Rückfrage und offene Fäden.
 *
 * Rückfrage: Der Chat-Kern meldet sie über onQuestion (chat-turn.ts),
 * angeboten wird sie erst, wenn die Antwort verschickt ist, genau einmal und
 * im Gespräch des Turns (offer() kennt Chat und Topic). Bei Abbruch und bei
 * Antworten mit [INVOKE:] gibt es keine: dort antworten erst die befragten
 * Agenten. Scheitert das Anbieten, ist die Antwort schon da, und die Fäden
 * laufen trotzdem.
 */
import { ABORT_REPLY, SHUTDOWN_ABORT_REPLY, type TurnQuestion } from "../../lib/chat-turn";
import { isAbortError } from "../../lib/execution-context";
import { turnInfoCollector } from "../../lib/turn-collector";
import type { FinishedTurn } from "../../lib/turn-finish";
import { logErrorMasked } from "../../lib/telegram-token-mask";

/**
 * Antwort, wenn der Turn mit einem Fehler endet (Issue #565, Wortlaut nach
 * R1-38): deutsch und mit dem nächsten Schritt, denn bei einem Dauerfehler
 * hilft „noch einmal“ allein nicht weiter
 */
export const TELEGRAM_TURN_FAILED_TEXT =
  "Das hat nicht geklappt. Versuch es noch einmal. Kommt das öfter: im Terminal tybo pruefen oder in der WebUI Einstellungen, Status.";

/** Angaben, mit denen der Kanal den Turn startet (askWithProgress, src/app/bot-turns.ts) */
export interface TelegramTurnRun {
  userMessage: string;
  chatId: string;
  agentName: string;
  topicId?: number;
  collector: ReturnType<typeof turnInfoCollector>;
  turnHint?: string;
  onQuestion(question: TurnQuestion): void;
}

export interface TelegramReplyDeps<Ctx> {
  runTurn(ctx: Ctx, run: TelegramTurnRun): Promise<string>;
  /** Tippt-Anzeige im Chat der Nachricht */
  typing(ctx: Ctx): { start(): void; stop(): void };
  /** Antwort direkt auf die Nachricht (Abbruch, Fehler) */
  reply(ctx: Ctx, text: string): Promise<unknown>;
  sendAsAgent(agent: string, chatId: string, text: string, options: { threadId?: number }): Promise<unknown>;
  /** Gemeinsamer Abschluss (createTurnFinish), derselbe wie für Medien */
  finishTurn(turn: FinishedTurn): Promise<void>;
  threadTurnHint(chatId: string, topicId?: number): Promise<string | undefined>;
  isShuttingDown(): boolean;
  /** Neustart prüfen, sobald die Antwort draußen ist */
  afterTurn(chatId: string, topicId?: number): void;
  now?(): number;
  logError?(message: string, error: unknown): void;
}

export interface TelegramReplyInput<Ctx> {
  ctx: Ctx;
  chatId: string;
  userMessage: string;
  agentName: string;
  topicId?: number;
  /** Offene Fäden (Issue #290): nur bei Nachrichten, nicht bei Befehlen */
  threads?: boolean;
}

export function createTelegramReply<Ctx>(deps: TelegramReplyDeps<Ctx>): (input: TelegramReplyInput<Ctx>) => Promise<void> {
  const now = deps.now ?? Date.now;
  // Ohne Token im Log (Issue #526)
  const logError = deps.logError ?? logErrorMasked;
  const abortText = () => (deps.isShuttingDown() ? SHUTDOWN_ABORT_REPLY : ABORT_REPLY);

  return async ({ ctx, chatId, userMessage, agentName, topicId, threads }) => {
    const typing = deps.typing(ctx);
    typing.start();
    const turnStartedAt = now();
    const where = { threadId: topicId };
    try {
      const collector = turnInfoCollector();
      // Hinweis auf einen offenen Faden (Issue #292): nur bei Nachrichten, einmal je Gespräch
      const turnHint = threads ? await deps.threadTurnHint(chatId, topicId) : undefined;
      let question: TurnQuestion | undefined;
      const text = await deps.runTurn(ctx, {
        userMessage,
        chatId,
        agentName,
        ...(topicId !== undefined ? { topicId } : {}),
        collector,
        ...(turnHint ? { turnHint } : {}),
        onQuestion: q => {
          question = q;
        },
      });

      // /stop oder Neustart: nichts speichern, kein Ersatzmodell, keine Rückfrage
      if (text === ABORT_REPLY) {
        await deps.reply(ctx, abortText()).catch(() => {});
        return;
      }

      await deps.finishTurn({
        chatId,
        ...(topicId !== undefined ? { topicId } : {}),
        agentName,
        reply: text,
        metadata: { agent: agentName, topicId, ...collector.metadata() },
        tools: collector.tools(),
        ...(question ? { question } : {}),
        ...(threads ? { threads: { userText: userMessage, startedAt: turnStartedAt } } : {}),
        send: reply => deps.sendAsAgent(agentName, chatId, reply, where),
      });
    } catch (error) {
      // Ein Abbruch, der erst hier ankommt, ist kein Fehler (Issue #188)
      if (isAbortError(error)) {
        await deps.reply(ctx, abortText()).catch(() => {});
        return;
      }
      logError("[Telegram] Antwort fehlgeschlagen:", error);
      await deps.reply(ctx, TELEGRAM_TURN_FAILED_TEXT);
    } finally {
      typing.stop();
      deps.afterTurn(chatId, topicId);
    }
  };
}
