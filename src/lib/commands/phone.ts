/**
 * /anruf (Issue #367, Entscheidung E9): tybo ruft den Nutzer über das
 * Telefonnetz an, aus Telegram, Browser und Terminal. Der Text nach dem
 * Befehl ist der Anlass, ohne Text meldet sich tybo allgemein. Zusammenfassung
 * und Auftrags-Rückfrage kommen in das Gespräch, in dem /anruf stand (reines
 * Web-Gespräch, Telegram-Chat samt Topic). Der Anruf läuft über den
 * Anrufdienst des Bots (services.phone, src/lib/phone/access.ts).
 */

import { chatConversation } from "../phone/conversation";
import { ALL_CHANNELS, type CommandContext, type CommandDefinition } from "./types";

export const CALL_COMMAND_TEXT = {
  unavailable: "Anrufe gibt es in diesem Prozess nicht.",
  notConfigured: (missing: string[]) => `Anrufe sind nicht eingerichtet. Es fehlt in .env: ${missing.join(", ")}. Anleitung: docs/sprechen.md.`,
} as const;

async function runCall(ctx: CommandContext): Promise<void> {
  const phone = ctx.services.phone;
  if (!phone) {
    await ctx.reply(CALL_COMMAND_TEXT.unavailable);
    return;
  }
  const missing = phone.missing();
  if (missing.length > 0) {
    await ctx.reply(CALL_COMMAND_TEXT.notConfigured(missing));
    return;
  }
  const result = await phone.call(ctx.args, chatConversation(ctx.chatId, ctx.topicId));
  await ctx.reply(result.message);
}

export const CALL_COMMAND: CommandDefinition = {
  name: "anruf",
  aliases: [],
  description: "Ich rufe dich an, mit oder ohne Anlass",
  args: "optional",
  argsHint: "[anlass]",
  telegramArgSeparators: [" ", "\n"],
  channels: ALL_CHANNELS,
  run: runCall,
};
