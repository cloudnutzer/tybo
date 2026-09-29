/**
 * Telegram-Teil des Bot-Starts als testbarer Baustein (Issue #228,
 * Entscheidung 0021). src/bot.ts holt alles, was an Telegram hängt, nur noch
 * hier ab: grammY-Bot, Output-Guard, Agenten-Bots (BotRegistry),
 * Rückfragen-Anbindung, Sende-Helfer, Topic-API, Voice-Sender, Start und Stopp.
 *
 * Mit Telegram (telegramConfigured: Token und Nutzer-ID gültig) baut die
 * übergebene Fabrik genau einen Bot, danach sofort der Output-Guard (Issue
 * #52), dann BotRegistry und Rückfragen. start(onReady) startet das Polling
 * und ruft onReady genau einmal aus onStart (Ziele fortsetzen, Issue #190).
 *
 * Ohne Telegram ruft das Modul die Fabrik nie auf und macht keinen
 * Netzaufruf: keine Agenten-Bots (auch nicht bei übrig gebliebenen
 * TELEGRAM_BOT_TOKEN_* in der .env), kein getMe, kein Polling. topicApi und
 * voiceSender sind undefined. Senden an eine Web-Chat-ID (Direktchat "web",
 * web:<uuid>) tut nichts, weil der Verlauf dort über den Speicher läuft;
 * Senden an jede andere Chat-ID wird ohne Netz abgelehnt und geloggt.
 * start(onReady) ruft onReady genau einmal, stop() tut nichts. Rückfragen
 * laufen weiter über das Register (Ablauf-Prüfung, Speichern), nur ohne
 * Telegram-Nachrichten.
 */

import { Bot, InputFile } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import { BotRegistry } from "./bot-registry";
import { isWebChatId, telegramConfigured } from "./channels";
import { chunkForTelegram, installTelegramOutputGuard, markdownToTelegramHTML, NO_LINK_PREVIEW, stripHtmlTags } from "./telegram";
import { createTelegramChoices, type TelegramChoices } from "./telegram-choices";
import { createTelegramVoiceSender } from "./voice-message";
import { rightsFromChatMember, type TelegramTopicApi } from "../web/topics";

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;

/** Was src/bot.ts von den Agenten-Bots braucht (BotRegistry passt) */
export interface AgentBots {
  initialize(): Promise<void>;
  agentForMention(text: string): { agent: string; cleanedText: string } | null;
  sendAsAgent(agent: string, chatId: string | number, text: string, options?: { threadId?: number }): Promise<void>;
  sendTypingAsAgent(agent: string, chatId: string | number, threadId?: number): Promise<void>;
  sendWithKeyboardAsAgent(agent: string, chatId: string | number, text: string, keyboard: unknown, options?: { threadId?: number }): Promise<void>;
}

export interface MirrorFileInput {
  bytes: Uint8Array;
  name: string;
}

export interface TelegramRuntimeDeps {
  env: Env;
  /** Bot-Fabrik; Standard ein grammY-Bot mit dem Token. Ohne Telegram nie aufgerufen */
  createBot?: (token: string) => Bot;
  /** Agenten-Bots; Standard BotRegistry mit derselben Fabrik und env. Ohne Telegram nie aufgerufen */
  createAgentBots?: (bot: Bot, env: Env, createBot: (token: string) => Bot) => AgentBots;
  /** Nur für Tests: Speichern der Rückfragen (Standard sendAndRecord) */
  choicesSend?: Parameters<typeof createTelegramChoices>[0]["send"];
  log?: Log;
}

export interface TelegramRuntime {
  /** Telegram eingerichtet und ein Bot gebaut */
  readonly telegram: boolean;
  /** grammY-Bot; null ohne Telegram */
  readonly bot: Bot | null;
  readonly agents: AgentBots;
  /** Rückfragen (Issue #114); ohne Telegram nur Register und Ablauf */
  readonly choices: TelegramChoices;
  /** Topic-API für die WebUI (Issue #29); undefined ohne Telegram */
  readonly topicApi: TelegramTopicApi | undefined;
  /** Sprachnachricht über den Haupt-Bot (Issue #78); undefined ohne Telegram */
  readonly voiceSender: ((chatId: string, audio: Buffer, fileName: string, threadId?: number) => Promise<void>) | undefined;
  /** Markdown als Telegram-HTML, in Stücken, Rückfall Klartext; Fehler loggen, nicht werfen */
  sendMessage(chatId: string | number, text: string, threadId?: number): Promise<void>;
  /** Meldung mit optionalen Knöpfen (HTML, Rückfall Klartext) */
  sendStatus(chatId: string, text: string, threadId?: number, keyboard?: unknown): Promise<void>;
  /** Klartext ohne HTML-Modus; Fehler wirft */
  sendPlain(chatId: string, text: string, threadId?: number): Promise<void>;
  /** Foto bzw. Dokument vom Haupt-Bot; Fehler wirft */
  sendFile(chatId: string, file: MirrorFileInput, options: { as: "photo" | "document"; caption: string; threadId?: number }): Promise<void>;
  typing(chatId: string | number): Promise<void>;
  /** Agenten-Bots anmelden (getMe je Token); ohne Telegram nichts */
  initialize(): Promise<void>;
  /** Polling starten, onReady genau einmal nach dem Start; ohne Telegram sofort */
  start(onReady: () => unknown): Promise<void>;
  stop(): void;
}

/** Ablehnung ohne Telegram: kein Netz, ein Log-Eintrag */
export class TelegramUnavailableError extends Error {
  constructor() {
    super("Telegram ist nicht eingerichtet");
    this.name = "TelegramUnavailableError";
  }
}

const defaultLog: Log = line => console.log(line);

export function createTelegramRuntime(deps: TelegramRuntimeDeps): TelegramRuntime {
  const log = deps.log ?? defaultLog;
  const env = deps.env;
  if (!telegramConfigured(env)) return createWebOnlyRuntime(log, deps);

  const createBot = deps.createBot ?? ((token: string) => new Bot(token));
  const bot = createBot(env.TELEGRAM_BOT_TOKEN!.trim());
  // Issue #52: jede Sendung und Bearbeitung über diesen Bot (ctx.reply,
  // ctx.editMessageText, direkte Api-Aufrufe) ohne Link-Vorschau, Text bereinigt
  installTelegramOutputGuard(bot.api);
  // Global error handler: grammY soll keine ganzen Context-Objekte ausgeben
  bot.catch(err => {
    const e = err.error;
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error(`BotError [update ${err.ctx?.update?.update_id}]: ${errMsg}`);
  });
  const agents = (deps.createAgentBots ?? ((b, e, factory) => new BotRegistry(b, { env: e, createBot: factory })))(bot, env, createBot);
  const owner = env.TELEGRAM_USER_ID!.trim();
  const choices = createTelegramChoices({
    api: bot.api,
    owner,
    send: deps.choicesSend,
    telegram: () => telegramConfigured(env),
  });

  let mainBotId: number | null = null;
  const topicApi: TelegramTopicApi = {
    createForumTopic: async (chatId, name) => ({ topicId: (await bot.api.createForumTopic(chatId, name)).message_thread_id }),
    editForumTopic: async (chatId, topicId, name) => {
      await bot.api.editForumTopic(chatId, topicId, { name });
    },
    closeForumTopic: async (chatId, topicId) => {
      await bot.api.closeForumTopic(chatId, topicId);
    },
    reopenForumTopic: async (chatId, topicId) => {
      await bot.api.reopenForumTopic(chatId, topicId);
    },
    deleteForumTopic: async (chatId, topicId) => {
      await bot.api.deleteForumTopic(chatId, topicId);
    },
    getMyRights: async chatId => {
      mainBotId ??= (await bot.api.getMe()).id;
      return rightsFromChatMember(await bot.api.getChatMember(chatId, mainBotId));
    },
  };

  let initialized: Promise<void> | null = null;

  return {
    telegram: true,
    bot,
    agents,
    choices,
    topicApi,
    voiceSender: createTelegramVoiceSender(bot.api),
    async sendMessage(chatId, text, threadId) {
      const html = markdownToTelegramHTML(text);
      const opts: Record<string, any> = { link_preview_options: NO_LINK_PREVIEW };
      if (threadId) opts.message_thread_id = threadId;
      for (const chunk of chunkForTelegram(html)) {
        try {
          await bot.api.sendMessage(chatId, chunk, { parse_mode: "HTML", ...opts });
        } catch (htmlErr) {
          console.warn(`[sendDirectMessage] HTML send failed (${chunk.length} chars), retrying plain:`, htmlErr);
          try {
            await bot.api.sendMessage(chatId, stripHtmlTags(chunk), opts);
          } catch (plainErr) {
            console.error(`[sendDirectMessage] DELIVERY FAILED (${chunk.length} chars) — message lost:`, plainErr);
          }
        }
      }
    },
    async sendStatus(chatId, text, threadId, keyboard) {
      const opts: Record<string, any> = { link_preview_options: NO_LINK_PREVIEW };
      if (threadId) opts.message_thread_id = threadId;
      if (keyboard) opts.reply_markup = keyboard;
      const html = markdownToTelegramHTML(text);
      try {
        await bot.api.sendMessage(chatId, html, { parse_mode: "HTML", ...opts });
      } catch {
        await bot.api.sendMessage(chatId, stripHtmlTags(html), opts).catch(() => {});
      }
    },
    async sendPlain(chatId, text, threadId) {
      await bot.api.sendMessage(chatId, text, threadId ? { message_thread_id: threadId } : {});
    },
    async sendFile(chatId, file, { as, caption, threadId }) {
      const input = new InputFile(file.bytes, file.name);
      const options = { caption, ...(threadId ? { message_thread_id: threadId } : {}) };
      if (as === "photo") await bot.api.sendPhoto(chatId, input, options);
      else await bot.api.sendDocument(chatId, input, options);
    },
    async typing(chatId) {
      await bot.api.sendChatAction(chatId, "typing");
    },
    initialize() {
      initialized ??= agents.initialize();
      return initialized;
    },
    start(onReady) {
      let ready = false;
      return bot.start({
        onStart: (botInfo: UserFromGetMe) => {
          log(`Bot online as @${botInfo.username}`);
          if (ready) return;
          ready = true;
          void onReady();
        },
      });
    },
    stop() {
      void bot.stop();
    },
  };
}

/**
 * Start nach der ersten Ablauf-Prüfung der Rückfragen (Issue #228): erst
 * wenn sie fertig ist (auch wenn sie scheitert), startet die Laufzeit, und
 * erst danach setzt onReady die Ziele fort. Sonst läuft ein Ziel schon, während
 * abgelaufene Rückfragen noch als offen gelten
 */
export async function startAfterFirstSweep(
  runtime: Pick<TelegramRuntime, "start">,
  firstSweep: Promise<unknown>,
  onReady: () => unknown,
): Promise<void> {
  await firstSweep.catch(() => {});
  await runtime.start(onReady);
}

function createWebOnlyRuntime(log: Log, deps: TelegramRuntimeDeps): TelegramRuntime {
  log("Telegram nicht eingerichtet: nur WebUI");
  /** Web-Ziele: nichts zu senden; alles andere ohne Netz ablehnen */
  const refuse = async (what: string, chatId: string | number): Promise<void> => {
    if (isWebChatId(String(chatId))) return;
    log(`[telegram] ${what} an Chat ${String(chatId)} abgelehnt: Telegram ist nicht eingerichtet`);
    throw new TelegramUnavailableError();
  };
  const agents: AgentBots = {
    initialize: async () => {},
    agentForMention: () => null,
    sendAsAgent: (_agent, chatId) => refuse("Agenten-Nachricht", chatId),
    sendTypingAsAgent: async () => {},
    sendWithKeyboardAsAgent: (_agent, chatId) => refuse("Agenten-Nachricht", chatId),
  };
  let started = false;
  return {
    telegram: false,
    bot: null,
    agents,
    // Ohne api und Besitzer: Register, Ablauf-Prüfung und Speichern, nichts nachzuziehen
    choices: createTelegramChoices({ send: deps.choicesSend, telegram: () => false }),
    topicApi: undefined,
    voiceSender: undefined,
    sendMessage: (chatId: string | number) => refuse("Nachricht", chatId),
    sendStatus: (chatId: string) => refuse("Meldung", chatId),
    sendPlain: (chatId: string) => refuse("Nachricht", chatId),
    sendFile: (chatId: string) => refuse("Datei", chatId),
    typing: async () => {},
    initialize: async () => {},
    start(onReady) {
      if (!started) {
        started = true;
        void onReady();
      }
      return Promise.resolve();
    },
    stop() {},
  };
}
