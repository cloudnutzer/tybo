/**
 * Befehle aus Telegram (Issue #344): verbindet die gemeinsame Befehls-Schicht
 * (src/lib/commands, Issue #74) mit dem Gespräch der Nachricht. Telegram-eigen
 * sind die Tippt-Anzeige, der Session-Reset mit Sperre für /motor, der
 * Agenten-Turn (Antwort geht selbst nach Telegram), /board mit den
 * Agenten-Bots und /voice als Sprachnachricht.
 */
import { InputFile } from "grammy";
import type { BoardDataLike, BoardCallResult } from "../../lib/board-meeting";
import { ABORT_REPLY, type TurnInfo } from "../../lib/chat-turn";
import { createTelegramSessionReset, runTelegramCommand, type TelegramSessionResetDeps } from "../../lib/commands/telegram";
import type { CommandMatch, CommandServices } from "../../lib/commands/types";
import { sessionKeyFor } from "../../lib/store/message-rules";
import type { Message } from "../../lib/store/types";
import type { TurnTools } from "../../lib/turn-tools";

export const VOICE_TEXT = {
  off: "Voice is not configured. Set ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID or GEMINI_API_KEY in .env",
  noAudio: "Could not generate voice. Here's the text response:",
  failed: "Something went wrong processing your voice request.",
} as const;

/** Was vom grammY-Context gebraucht wird */
export interface CommandChat {
  reply(text: string, other?: Record<string, unknown>): Promise<unknown>;
  replyWithVoice(voice: InputFile): Promise<unknown>;
}

export interface Typing {
  start(): void;
  stop(): void;
}

/** Sammler eines Turns (turnInfoCollector) */
export interface VoiceTurnCollector {
  onInfo(info: TurnInfo): void;
  onTools(tools: TurnTools | undefined): void;
  tools(): TurnTools | undefined;
  metadata(): Record<string, unknown>;
}

export interface VoiceReplyDeps<C> {
  enabled(): boolean;
  newTurn(): VoiceTurnCollector;
  /** Turn mit Fortschritt im Gespräch (Streaming) */
  runTurn(ctx: C, prompt: string, chatId: string, agent: string, topicId: number | undefined, turn: VoiceTurnCollector): Promise<string>;
  saveMessage(message: Message): Promise<unknown>;
  processIntents(text: string, tools: TurnTools | undefined, target: { chatId: string; topicId?: number; origin: "Telegram" }): Promise<unknown>;
  speak(text: string): Promise<Buffer | null>;
  /** Antwort als Text, wenn keine Sprache entstand */
  sendText(ctx: C, text: string): Promise<unknown>;
  logError?(message: string, error: unknown): void;
}

export interface TelegramBoardDeps<C> {
  agents(): string[];
  gatherData(): Promise<BoardDataLike>;
  stripInvocationTags(text: string): string;
  /** Modellaufruf ohne Fortschritt (callClaude) */
  ask(prompt: string, chatId: string, agent: string, topicId: number | undefined, onInfo: (info: TurnInfo) => void): Promise<string>;
  saveMessage(message: Message): Promise<unknown>;
  sendAsAgent(agent: string, chatId: string, text: string, options: { threadId?: number }): Promise<unknown>;
  sendTypingAsAgent(agent: string, chatId: string, threadId?: number): Promise<unknown>;
  notice(ctx: C, text: string): Promise<unknown>;
  run: typeof import("../../lib/board-meeting").runBoardMeeting;
  output: typeof import("../../lib/board-meeting").createTelegramBoardOutput;
}

export interface TelegramCommandsDeps<C extends CommandChat, S> {
  services: CommandServices;
  agentFor(chatId: string, topicId: number | undefined): string;
  typing(ctx: C): Typing;
  sessionReset: TelegramSessionResetDeps<S>;
  /** Antwort eines Agenten wie auf eine Nachricht, ohne offene Fäden */
  agentReply(request: { ctx: C; chatId: string; userMessage: string; agentName: string; topicId?: number }): Promise<void>;
  voice: VoiceReplyDeps<C>;
  board: TelegramBoardDeps<C>;
}

export type TelegramCommandRunner<C> = (ctx: C, chatId: string, topicId: number | undefined, text: string, match: CommandMatch) => Promise<void>;

/** /voice: Antwort des Gesprächs-Agenten als Sprachnachricht, ohne Stimme nur ein Hinweis */
export function createVoiceReply<C extends CommandChat>(deps: VoiceReplyDeps<C>, typing: (ctx: C) => Typing) {
  return async (ctx: C, chatId: string, topicId: number | undefined, agent: string, prompt: string): Promise<void> => {
    if (!deps.enabled()) {
      await ctx.reply(VOICE_TEXT.off);
      return;
    }
    const indicator = typing(ctx);
    indicator.start();
    try {
      const turn = deps.newTurn();
      const answer = await deps.runTurn(ctx, prompt, chatId, agent, topicId, turn);
      await deps.saveMessage({
        chat_id: chatId,
        role: "assistant",
        content: answer,
        metadata: { agent, type: "voice_reply", topicId, ...turn.metadata() },
      });
      await deps.processIntents(answer, turn.tools(), { chatId, topicId, origin: "Telegram" });
      const audio = await deps.speak(answer);
      if (audio) {
        await ctx.replyWithVoice(new InputFile(audio, "response.mp3"));
        return;
      }
      await ctx.reply(VOICE_TEXT.noAudio);
      await deps.sendText(ctx, answer);
    } catch (error) {
      (deps.logError ?? console.error)("/voice command error:", error);
      await ctx.reply(VOICE_TEXT.failed);
    } finally {
      indicator.stop();
    }
  };
}

/** /board in Telegram: Beiträge der Reihe nach von den Agenten-Bots, Kern in src/lib/board-meeting.ts */
export function createTelegramBoard<C>(deps: TelegramBoardDeps<C>) {
  return async (ctx: C, chatId: string, topicId: number | undefined, extraContext: string): Promise<void> => {
    const callAgent = async (prompt: string, agent: string): Promise<BoardCallResult> => {
      let info: TurnInfo | undefined;
      const text = await deps.ask(prompt, chatId, agent, topicId, latest => (info = latest));
      if (text === ABORT_REPLY) return { text: "", aborted: true };
      const result: BoardCallResult = { text };
      if (info?.model) result.model = info.model;
      if (info?.engine) result.engine = info.engine;
      if (info) result.durationMs = info.durationMs;
      return result;
    };
    const output = deps.output(
      {
        sendAsAgent: (agent, target, text, threadId) => deps.sendAsAgent(agent, target, text, { threadId }),
        sendTypingAsAgent: (agent, target, threadId) => deps.sendTypingAsAgent(agent, target, threadId),
        notice: text => deps.notice(ctx, text),
      },
      chatId,
      topicId
    );
    await deps.run(
      {
        agents: deps.agents,
        gatherData: deps.gatherData,
        stripInvocationTags: deps.stripInvocationTags,
        callAgent,
        save: message => deps.saveMessage({ chat_id: chatId, ...message }) as Promise<boolean | void>,
        newMessageId: () => crypto.randomUUID(),
      },
      { extraContext: extraContext || undefined, sessionKey: sessionKeyFor(chatId, topicId ?? null), topicId },
      output
    );
  };
}

export function createTelegramCommands<C extends CommandChat, S>(deps: TelegramCommandsDeps<C, S>): TelegramCommandRunner<C> {
  const voiceReply = createVoiceReply(deps.voice, deps.typing);
  const board = createTelegramBoard(deps.board);
  return (ctx, chatId, topicId, text, match) => {
    const sessionKey = sessionKeyFor(chatId, topicId ?? null);
    const agent = deps.agentFor(chatId, topicId);
    return runTelegramCommand({
      chat: ctx,
      chatId,
      topicId,
      sessionKey,
      agent,
      text,
      match,
      services: {
        ...deps.services,
        voiceReply: (_command, prompt) => voiceReply(ctx, chatId, topicId, deps.agentFor(chatId, topicId), prompt),
      },
      working: () => {
        const indicator = deps.typing(ctx);
        indicator.start();
        return () => indicator.stop();
      },
      // /new ohne Sperre; /motor (whileBlocked) lehnt bei laufender Antwort ab und sperrt bis nach dem Schreiben
      resetSession: createTelegramSessionReset(sessionKey, deps.sessionReset),
      // Die Antwort geht selbst nach Telegram, deshalb kein Rückgabewert (Issue #78)
      agentTurn: async (turnAgent, prompt) => {
        await deps.agentReply({ ctx, chatId, userMessage: prompt, agentName: turnAgent, topicId });
        return undefined;
      },
      boardMeeting: extraContext => board(ctx, chatId, topicId, extraContext),
    });
  };
}
