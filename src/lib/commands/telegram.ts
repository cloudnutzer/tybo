/**
 * Telegram-Kontext der Befehls-Schicht (Issue #74): Antworten gehen wie
 * früher per ctx.reply des Haupt-Bots, Markdown als HTML mit
 * Klartext-Rückfall. Das Gespräch (Chat, Topic, Agent) und die
 * Telegram-eigenen Teile (Tippt-Anzeige, Reset, Agenten-Turn) reicht
 * src/bot.ts herein; so bleibt das hier ohne grammY-Bot testbar.
 */

import { markdownToTelegramHTML } from "../telegram";
import type { AgentTurnOptions, CommandContext, CommandMatch, CommandServices, SessionResetOptions, SessionResetOutcome } from "./types";

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
  resetSession(options?: SessionResetOptions): Promise<SessionResetOutcome>;
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

/** Bausteine des Telegram-Resets; src/bot.ts reicht die echten aus execution-context und session-manager herein */
export interface TelegramSessionResetDeps<S> {
  /** Läuft unter dem Schlüssel gerade eine Ausführung? */
  isActive(sessionKey: string): boolean;
  /** Sperrt neue Ausführungen unter dem Schlüssel bis zur zurückgegebenen Freigabe */
  block(sessionKey: string): () => void;
  sessionsForKey(sessionKey: string): Promise<S[]>;
  shouldDistill(session: S): boolean;
  distill(session: S): Promise<unknown>;
  /** Alle Sessions des Schlüssels (alle Agenten) entfernen, Anzahl zurück */
  reset(sessionKey: string): Promise<number>;
  sessionModeEnabled(): boolean;
}

/**
 * Session-Reset eines Telegram-Gesprächs. Ohne whileBlocked (/new) wie
 * bisher ohne Sperre: endende Sessions destillieren, dann verwerfen; ein
 * laufender Turn speichert danach nichts mehr (Epoche). Mit whileBlocked
 * (/motor, Issue #125) wie im Browser: läuft im Gespräch eine Antwort,
 * „busy" und keine Wirkung; sonst sind neue Ausführungen des Schlüssels von
 * vor dem Reset bis nach whileBlocked gesperrt (sie enden wie nach /stop).
 * Prüfen und Sperren geschehen ohne await dazwischen.
 */
export function createTelegramSessionReset<S>(
  sessionKey: string,
  deps: TelegramSessionResetDeps<S>
): (options?: SessionResetOptions) => Promise<SessionResetOutcome> {
  const resetNow = async (): Promise<SessionResetOutcome> => {
    for (const s of await deps.sessionsForKey(sessionKey)) {
      if (deps.shouldDistill(s)) void Promise.resolve(deps.distill(s)).catch(() => {});
    }
    const reset = await deps.reset(sessionKey);
    return { status: "done", reset, sessionMode: deps.sessionModeEnabled() };
  };
  return async options => {
    if (!options?.whileBlocked) return resetNow();
    if (deps.isActive(sessionKey)) return { status: "busy" };
    const release = deps.block(sessionKey);
    try {
      const outcome = await resetNow();
      await options.whileBlocked();
      return outcome;
    } finally {
      release();
    }
  };
}

/** Führt einen erkannten Befehl in Telegram aus */
export async function runTelegramCommand(input: TelegramCommandInput): Promise<void> {
  await input.match.command.run(createTelegramCommandContext(input));
}
