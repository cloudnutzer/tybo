/**
 * Bot Registry — Multi-Bot Agent Identity
 *
 * Maps agent names to individual Grammy Bot instances.
 * Agent bots are outbound-only (no polling/webhook) — they just send messages.
 * Falls back to primary bot if no token is configured for an agent.
 */

import { Bot } from "grammy";
import {
  markdownToTelegramHTML,
  chunkForTelegram,
  stripHtmlTags,
  installTelegramOutputGuard,
  NO_LINK_PREVIEW,
} from "./telegram";

/** Env var mapping: agent name → env var suffix */
export const AGENT_TOKEN_MAP: Record<string, string> = {
  research: "TELEGRAM_BOT_TOKEN_RESEARCH",
  content: "TELEGRAM_BOT_TOKEN_CONTENT",
  finance: "TELEGRAM_BOT_TOKEN_FINANCE",
  strategy: "TELEGRAM_BOT_TOKEN_STRATEGY",
  critic: "TELEGRAM_BOT_TOKEN_CRITIC",
  cto: "TELEGRAM_BOT_TOKEN_CTO",
  coo: "TELEGRAM_BOT_TOKEN_COO",
};

/** Alias resolution: alternative names → canonical agent name */
const AGENT_ALIASES: Record<string, string> = {
  ceo: "strategy",
  cfo: "finance",
  cmo: "content",
  researcher: "research",
  "devils-advocate": "critic",
  dev: "cto",
  development: "cto",
  ops: "coo",
  operations: "coo",
};

export class BotRegistry {
  private primary: Bot;
  private bots: Map<string, Bot> = new Map();

  constructor(primaryBot: Bot) {
    this.primary = primaryBot;
    // Issue #52: jede Sendung über den Haupt-Bot ohne Link-Vorschau, Text bereinigt
    installTelegramOutputGuard(primaryBot.api);
  }

  /**
   * Initialize agent bots from env vars.
   * Creates Bot instances and calls bot.init() (no bot.start() — outbound only).
   */
  async initialize(): Promise<void> {
    const initPromises: Promise<void>[] = [];

    for (const [agent, envVar] of Object.entries(AGENT_TOKEN_MAP)) {
      const token = process.env[envVar];
      if (!token) continue;

      const agentBot = new Bot(token);
      installTelegramOutputGuard(agentBot.api);
      initPromises.push(
        agentBot
          .init()
          .then(() => {
            this.bots.set(agent, agentBot);
            console.log(
              `[BotRegistry] ${agent} bot initialized: @${agentBot.botInfo.username}`
            );
          })
          .catch((err) => {
            console.error(
              `[BotRegistry] Failed to init ${agent} bot: ${err.message}`
            );
          })
      );
    }

    await Promise.all(initPromises);
    console.log(
      `[BotRegistry] ${this.bots.size} agent bot(s) ready, primary bot as fallback`
    );
  }

  /** Resolve agent name (handles aliases) and return the Bot instance. */
  resolve(agentName: string): Bot {
    const canonical = AGENT_ALIASES[agentName.toLowerCase()] || agentName.toLowerCase();
    return this.bots.get(canonical) || this.primary;
  }

  /** Check if a dedicated bot exists for this agent. */
  hasBot(agentName: string): boolean {
    const canonical = AGENT_ALIASES[agentName.toLowerCase()] || agentName.toLowerCase();
    return this.bots.has(canonical);
  }

  /**
   * Mention-Routing (Buzz-Muster): findet in
   * einem Nachrichtentext die @Mention eines Agent-Bots. Liefert den Agenten
   * und den Text ohne die Mention — oder null, wenn kein Agent-Bot erwaehnt
   * wird. Der Haupt-Bot selbst zaehlt nicht (der gehoert dem Topic-Agenten).
   */
  agentForMention(text: string): { agent: string; cleanedText: string } | null {
    for (const [agent, agentBot] of this.bots) {
      const username = agentBot.botInfo?.username;
      if (!username) continue;
      const mention = new RegExp(`@${username}\\b`, "i");
      if (mention.test(text)) {
        const cleaned = text.replace(new RegExp(`@${username}\\b`, "gi"), "").replace(/\s{2,}/g, " ").trim();
        return { agent, cleanedText: cleaned || text };
      }
    }
    return null;
  }

  /**
   * Send a message as a specific agent's bot.
   * Converts Markdown to HTML, chunks long messages, retries as plain text.
   * Link preview off on every chunk (Issue #52).
   */
  async sendAsAgent(
    agentName: string,
    chatId: string | number,
    text: string,
    options?: { threadId?: number }
  ): Promise<void> {
    const agentBot = this.resolve(agentName);
    const html = markdownToTelegramHTML(text);
    const chunks = chunkForTelegram(html);

    for (const chunk of chunks) {
      const params: Record<string, any> = {
        parse_mode: "HTML" as const,
        link_preview_options: NO_LINK_PREVIEW,
      };
      if (options?.threadId) {
        params.message_thread_id = options.threadId;
      }
      try {
        await agentBot.api.sendMessage(chatId, chunk, params);
      } catch (htmlErr) {
        // Retry as plain text (strip tags, preserve content)
        console.warn(`[BotRegistry] HTML send failed for ${agentName} (${chunk.length} chars), retrying as plain text:`, htmlErr);
        try {
          const plainParams: Record<string, any> = { link_preview_options: NO_LINK_PREVIEW };
          if (options?.threadId) {
            plainParams.message_thread_id = options.threadId;
          }
          await agentBot.api.sendMessage(chatId, stripHtmlTags(chunk), plainParams);
        } catch (plainErr) {
          console.error(
            `[BotRegistry] DELIVERY FAILED for ${agentName} (${chunk.length} chars) — message lost:`,
            plainErr
          );
        }
      }
    }
  }

  /** Send typing indicator from agent's bot. */
  async sendTypingAsAgent(
    agentName: string,
    chatId: string | number,
    threadId?: number
  ): Promise<void> {
    const agentBot = this.resolve(agentName);
    try {
      const params: Record<string, any> = {
        action: "typing" as const,
      };
      if (threadId) {
        params.message_thread_id = threadId;
      }
      await agentBot.api.sendChatAction(chatId, "typing", params);
    } catch {
      // Typing indicator failures are non-critical
    }
  }

  /** Send a message with an inline keyboard as a specific agent. */
  async sendWithKeyboardAsAgent(
    agentName: string,
    chatId: string | number,
    text: string,
    keyboard: any,
    options?: { threadId?: number }
  ): Promise<void> {
    const agentBot = this.resolve(agentName);
    const html = markdownToTelegramHTML(text);

    const params: Record<string, any> = {
      reply_markup: keyboard,
      parse_mode: "HTML" as const,
      link_preview_options: NO_LINK_PREVIEW,
    };
    if (options?.threadId) {
      params.message_thread_id = options.threadId;
    }
    try {
      await agentBot.api.sendMessage(chatId, html, params);
    } catch (htmlErr) {
      console.warn(`[BotRegistry] HTML keyboard send failed for ${agentName}, retrying as plain text:`, htmlErr);
      try {
        params.parse_mode = undefined;
        await agentBot.api.sendMessage(chatId, stripHtmlTags(html), params);
      } catch (plainErr) {
        console.error(
          `[BotRegistry] DELIVERY FAILED for keyboard ${agentName} — message lost:`,
          plainErr
        );
      }
    }
  }

}
