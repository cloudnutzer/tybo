/**
 * Telegram-Kontext der Befehls-Schicht (Issue #74): Antworten gehen wie
 * früher per ctx.reply des Haupt-Bots, Markdown als HTML mit
 * Klartext-Rückfall. Das Gespräch (Chat, Topic, Agent) und die
 * Telegram-eigenen Teile (Tippt-Anzeige, Reset, Agenten-Turn) reicht
 * src/bot.ts herein; so bleibt das hier ohne grammY-Bot testbar.
 */

import { markdownToTelegramHTML } from "../telegram";
import type { AgentTurnOptions, CommandContext, CommandMatch, CommandServices, SessionResetOutcome } from "./types";

/** Was von grammYs Context gebraucht wird */
export interface TelegramReplier {
  reply(text: string, other?: Record<string, unknown>): Promise<unknown>;
}

export interface TelegramCommandInput {
  chat: TelegramReplier;
  chatId: string;
  topicId?: number;
  sessionKey: string;
  agent: string;
  text: string;
  match: CommandMatch;
  services: CommandServices;
  working(): () => void;
  resetSession(): Promise<SessionResetOutcome>;
  /** Telegram liefert die Antwort selbst aus und gibt undefined zurück */
  agentTurn(agent: string, prompt: string, options?: AgentTurnOptions): Promise<string | undefined>;
  boardMeeting(extraContext: string): Promise<void>;
}

export function createTelegramCommandContext(input: TelegramCommandInput): CommandContext {
  const { chat } = input;
  return {
    channel: "telegram",
    chatId: input.chatId,
    ...(input.topicId !== undefined ? { topicId: input.topicId } : {}),
    sessionKey: input.sessionKey,
    agent: input.agent,
    name: input.match.command.name,
    args: input.match.args,
    text: input.text,
    async reply(text, options) {
      if (options?.format === "markdown") {
        await chat.reply(markdownToTelegramHTML(text), { parse_mode: "HTML" }).catch(() => chat.reply(options.plainFallback ?? text));
        return;
      }
      await chat.reply(text);
    },
    async notice(text) {
      await chat.reply(text);
    },
    async buttons(text, rows) {
      await chat.reply(text, {
        reply_markup: { inline_keyboard: rows.map(row => row.map(b => ({ text: b.label, callback_data: b.action }))) },
      });
    },
    working: input.working,
    resetSession: input.resetSession,
    agentTurn: input.agentTurn,
    boardMeeting: input.boardMeeting,
    services: input.services,
  };
}

/** Führt einen erkannten Befehl in Telegram aus */
export async function runTelegramCommand(input: TelegramCommandInput): Promise<void> {
  await input.match.command.run(createTelegramCommandContext(input));
}
