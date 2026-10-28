/**
 * Telegram-Teil des Bot-Starts als testbarer Baustein (Issue #228,
 * Entscheidung 0021). src/bot.ts holt alles, was an Telegram hängt, nur noch
 * hier ab: grammY-Bot, Output-Guard, Agenten-Bots (AgentIdentities),
 * Rückfragen-Anbindung, Sende-Helfer, Topic-API, Voice-Sender, Start und Stopp.
 *
 * Updates kommen auf einem von zwei Wegen (Issue #350):
 * Polling (Standard) oder Webhook. Im Webhook-Modus ruft start() nie
 * bot.start(); es meldet den Bot an (getMe), trägt den Webhook bei Telegram
 * ein, wenn eine öffentliche Adresse gesetzt ist, öffnet den Listener
 * (POST /telegram, Secret im Kopf X-Telegram-Bot-Api-Secret-Token) und ruft
 * erst dann onReady, genau einmal. stop() schließt den Listener. Andere
 * Pfade als /telegram gehen an deps.routes (Server-Wege, Issue #351), sonst 404. Den Weg
 * legt das Betriebsprofil fest (src/lib/runtime-profile.ts, TYBO_PROFILE);
 * bei ungültigem Profil gibt es keinen Eingang, onReady kommt trotzdem einmal.
 *
 * Dritter Weg relay (Issue #353, Profil peer): start() meldet den Bot nur an
 * (bot.init, also getMe), ruft nie bot.start, getUpdates, deleteWebhook oder
 * setWebhook. Updates kommen über relayIntake() (bot.handleUpdate), das erst
 * nach der Anmeldung und bis stop() eine Funktion liefert.
 *
 * Mit Telegram (telegramConfigured: Token und Nutzer-ID gültig) baut die
 * übergebene Fabrik genau einen Bot, danach sofort der Output-Guard (Issue
 * #52), dann die Agenten-Identitäten und Rückfragen. start(onReady) startet das Polling
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

import { Bot, BotError, InputFile, webhookCallback } from "grammy";
import type { Update, UserFromGetMe } from "grammy/types";
import { isWebChatId, telegramConfigured } from "./channels";
import { AgentIdentities } from "../channels/telegram/identities";
import { logLostPieces, sendRendered, transmitViaApi } from "../channels/telegram/send";
import { installTelegramOutputGuard } from "./telegram";
import { createTelegramChoices, type TelegramChoices } from "./telegram-choices";
import { createTelegramVoiceSender } from "./voice-message";
import { resolveRuntimeProfile } from "./runtime-profile";
import { rightsFromChatMember, type TelegramTopicApi } from "../web/topics";

type Env = Record<string, string | undefined>;
type Log = (line: string) => void;

/** Was src/bot.ts von den Agenten-Bots braucht (AgentIdentities passt) */
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

/** Webhook-Eingang: Adresse des Listeners, Pfad, Secret, optional die öffentliche Adresse */
export interface TelegramWebhookConfig {
  hostname: string;
  port: number;
  /** Pfad des Listeners, immer /telegram */
  path: string;
  secret: string;
  /** Öffentliche https-Adresse für setWebhook; ohne sie trägt der Betreiber den Webhook selbst ein */
  publicUrl: string | null;
  /** Nur für Tests: nach so vielen Millisekunden antwortet der Listener mit 200 (Standard 10 Sekunden) */
  handlerTimeoutMs?: number;
}

/** Wie Updates ankommen; Standard Polling. relay: nur weitergereichte Updates (Profil peer) */
export type TelegramIntake = { mode: "polling" } | { mode: "webhook"; webhook: TelegramWebhookConfig } | { mode: "relay" };

export interface TelegramRuntimeDeps {
  env: Env;
  /** Weg der Updates; Standard aus dem Betriebsprofil der env (ohne Angabe Polling) */
  intake?: TelegramIntake;
  /** Bot-Fabrik; Standard ein grammY-Bot mit dem Token. Ohne Telegram nie aufgerufen */
  createBot?: (token: string) => Bot;
  /** Agenten-Bots; Standard AgentIdentities mit derselben Fabrik und env. Ohne Telegram nie aufgerufen */
  createAgentBots?: (bot: Bot, env: Env, createBot: (token: string) => Bot) => AgentBots;
  /**
   * Weitere Wege am Webhook-Listener (Issue #351, src/app/server-routes.ts):
   * null heißt, der Pfad gehört nicht dazu. Den Listener gibt es nur im
   * Server-Profil, im Profil local sind diese Wege also nie erreichbar
   */
  routes?: (request: Request) => Promise<Response> | null;
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
  /** Wie sendMessage, aber mit Ergebnis: true nur, wenn Telegram jedes Stück angenommen hat */
  sendMessageChecked(chatId: string | number, text: string, threadId?: number): Promise<boolean>;
  /** Meldung mit optionalen Knöpfen (HTML, Rückfall Klartext) */
  sendStatus(chatId: string, text: string, threadId?: number, keyboard?: unknown): Promise<void>;
  /** Klartext ohne HTML-Modus; Fehler wirft */
  sendPlain(chatId: string, text: string, threadId?: number): Promise<void>;
  /** Foto bzw. Dokument vom Haupt-Bot; Fehler wirft */
  sendFile(chatId: string, file: MirrorFileInput, options: { as: "photo" | "document"; caption: string; threadId?: number }): Promise<void>;
  typing(chatId: string | number): Promise<void>;
  /** Agenten-Bots anmelden (getMe je Token); ohne Telegram nichts */
  initialize(): Promise<void>;
  /** Polling bzw. Webhook-Listener starten, onReady genau einmal nach dem Start; ohne Telegram sofort */
  start(onReady: () => unknown): Promise<void>;
  /** Port des Webhook-Listeners, solange er offen ist; sonst null */
  webhookPort(): number | null;
  /** Eingang relay: Update in dieselben Handler wie beim Polling; null vor der Anmeldung, nach stop() und in anderen Wegen */
  relayIntake(): ((update: Update) => Promise<void>) | null;
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

/** Was bot.catch von grammY bekommt, soweit es für die Logzeile zählt */
export interface HandlerFailure {
  error: unknown;
  ctx?: { update?: { update_id?: number } };
}

/**
 * Logzeile für einen Fehler in einem Telegram-Handler: Kennung des Updates
 * und Fehlermeldung, nie der Context mit Nachrichtentext oder Token.
 */
export function handlerFailureLine(failure: HandlerFailure): string {
  const { error } = failure;
  const reason = error instanceof Error ? error.message : String(error);
  const update = failure.ctx?.update?.update_id ?? "?";
  return `Telegram-Handler fehlgeschlagen (Update ${update}): ${reason}`;
}

export function createTelegramRuntime(deps: TelegramRuntimeDeps): TelegramRuntime {
  const log = deps.log ?? defaultLog;
  const env = deps.env;
  if (!telegramConfigured(env)) return createWebOnlyRuntime(log, deps);

  const createBot = deps.createBot ?? ((token: string) => new Bot(token));
  const bot = createBot(env.TELEGRAM_BOT_TOKEN!.trim());
  // Issue #52: jede Sendung und Bearbeitung über diesen Bot (ctx.reply,
  // ctx.editMessageText, direkte Api-Aufrufe) ohne Link-Vorschau, Text bereinigt
  installTelegramOutputGuard(bot.api);
  // Fehler aus Handlern: eine Zeile statt grammYs Ausgabe samt ganzem Context
  bot.catch(failure => console.error(handlerFailureLine(failure)));
  const agents = (deps.createAgentBots ?? ((b, e, factory) => new AgentIdentities(b, { env: e, createBot: factory })))(bot, env, createBot);
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
  const intake = deps.intake ?? intakeFromProfile(env, log);
  // Vor allen Handlern: dasselbe Update ein zweites Mal (Telegram stellt nach
  // Fehlern oder Zeitüberschreitung erneut zu) löst keinen zweiten Turn aus
  if (intake.mode === "webhook") bot.use(skipRepeatedUpdates(log));
  let listener: ReturnType<typeof Bun.serve> | null = null;
  let relayOpen = false;
  let stopped = false;
  let readyFired = false;
  const once = (onReady: () => unknown) => {
    if (!readyFired) {
      readyFired = true;
      void onReady();
    }
  };

  return {
    telegram: true,
    bot,
    agents,
    choices,
    topicApi,
    voiceSender: createTelegramVoiceSender(bot.api),
    // Wege 3 und 4 (Issue #328): Markdown in Stücken, Rückfall bei jedem Fehler,
    // ein verlorenes Stück geloggt, nie geworfen; Knöpfe am letzten Stück
    async sendMessage(chatId, text, threadId) {
      logLostPieces(await sendRendered({ text, format: "markdown", chatId, threadId, transmit: transmitViaApi(bot.api) }), "sendMessage");
    },
    async sendMessageChecked(chatId, text, threadId) {
      const report = await sendRendered({ text, format: "markdown", chatId, threadId, transmit: transmitViaApi(bot.api) });
      logLostPieces(report, "sendMessage");
      return report.complete;
    },
    async sendStatus(chatId, text, threadId, keyboard) {
      logLostPieces(await sendRendered({ text, format: "markdown", chatId, threadId, keyboard, transmit: transmitViaApi(bot.api) }), "sendStatus");
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
      if (intake.mode === "off") return Promise.resolve(once(onReady));
      if (intake.mode === "relay") {
        return bot.init().then(
          () => {
            relayOpen = !stopped;
            log(`[telegram] Profil peer: angemeldet als @${bot.botInfo.username}, Updates nur über /relay`);
            return once(onReady);
          },
          error => {
            log(`[telegram] Profil peer: kein Telegram-Eingang, Anmeldung gescheitert (${reasonOf(error)})`);
            return once(onReady);
          },
        );
      }
      if (intake.mode === "webhook") {
        // Auch ohne offenen Listener genau einmal bereit: WebUI und Ziele laufen weiter
        return startWebhook(bot, intake.webhook, log, () => stopped, deps.routes).then(server => {
          listener = server;
          return once(onReady);
        });
      }
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
    webhookPort: () => listener?.port ?? null,
    relayIntake: () => (relayOpen && !stopped ? update => bot.handleUpdate(update) : null),
    stop() {
      stopped = true;
      relayOpen = false;
      if (intake.mode === "off" || intake.mode === "relay") return;
      if (intake.mode === "webhook") {
        // Laufende Anfragen nicht abwarten; Telegram stellt Unbeantwortetes erneut zu
        void listener?.stop(true);
        listener = null;
        return;
      }
      void bot.stop();
    },
  };
}

/** Weg aus dem Betriebsprofil; ungültig heißt kein Eingang, nie Polling als Ersatz */
function intakeFromProfile(env: Env, log: Log): TelegramIntake | { mode: "off" } {
  const result = resolveRuntimeProfile(env);
  if (!result.ok) {
    log(`[telegram] Profil ${result.name}: kein Telegram-Eingang (${result.reason})`);
    return { mode: "off" };
  }
  if (result.profile.telegram.mode === "webhook") log(`[telegram] Profil ${result.profile.name}: Updates per Webhook`);
  if (result.profile.telegram.mode === "relay") log(`[telegram] Profil ${result.profile.name}: kein Polling, Updates vom Server über /relay`);
  return result.profile.telegram;
}

/** Größte Anfrage am Webhook; Updates sind wenige Kilobyte groß */
const WEBHOOK_BODY_LIMIT = 1024 * 1024;
/** Wie viele Update-Kennungen gegen doppelte Zustellung gemerkt werden */
const SEEN_UPDATES = 1000;

/** Middleware: ein schon gesehenes update_id endet hier, mit einer Logzeile */
export function skipRepeatedUpdates(log: Log) {
  const seen = new Set<number>();
  return async (ctx: { update: { update_id: number } }, next: () => Promise<void>) => {
    const id = ctx.update.update_id;
    if (seen.has(id)) {
      log(`[telegram] Update ${id} erneut zugestellt, übersprungen`);
      return;
    }
    seen.add(id);
    if (seen.size > SEEN_UPDATES) seen.delete(seen.values().next().value!);
    await next();
  };
}

/**
 * Webhook-Start: erst getMe (damit keine gefälschte Anfrage eine Anmeldung
 * auslöst), dann setWebhook mit Secret, wenn eine öffentliche Adresse gesetzt
 * ist, dann der Listener. Scheitert getMe oder der Listener, gibt es keinen
 * Eingang und eine Logzeile; null heißt: nicht gestartet.
 */
async function startWebhook(
  bot: Bot,
  config: TelegramWebhookConfig,
  log: Log,
  stopped: () => boolean,
  routes?: TelegramRuntimeDeps["routes"],
): Promise<ReturnType<typeof Bun.serve> | null> {
  try {
    await bot.init();
  } catch (error) {
    log(`[telegram] Webhook nicht gestartet: Anmeldung bei Telegram gescheitert (${reasonOf(error)})`);
    return null;
  }
  if (config.publicUrl) {
    try {
      await bot.api.setWebhook(config.publicUrl, { secret_token: config.secret });
      log(`[telegram] Webhook bei Telegram eingetragen: ${config.publicUrl}`);
    } catch (error) {
      log(`[telegram] Webhook nicht eingetragen (${reasonOf(error)}); der Listener läuft trotzdem`);
    }
  } else {
    log("[telegram] Webhook-Modus ohne TELEGRAM_WEBHOOK_URL: Eintrag bei Telegram von Hand (docs/telegram-webhook.md)");
  }
  if (stopped()) return null;

  // Bun-Adapter ausdrücklich, ohne grammYs Timeout: der hängt an den laufenden
  // Handler ein Promise, das bei späterem Scheitern unbehandelt bleibt und den
  // ganzen Context ausgibt. Die Frist kommt deshalb von hier
  const handle = webhookCallback(bot, "bun", { secretToken: config.secret, timeoutMilliseconds: Infinity });
  const timeoutMs = config.handlerTimeoutMs ?? 10_000;
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: config.hostname,
      port: config.port,
      maxRequestBodySize: WEBHOOK_BODY_LIMIT,
      fetch(request) {
        if (new URL(request.url).pathname !== config.path) return routes?.(request) ?? new Response("Not Found", { status: 404 });
        if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
        // Fehler im Handler landen hier, nicht in bot.catch, auch nach Ablauf
        // der Frist: eine Zeile und 200, damit Telegram nicht erneut zustellt
        const handled = handle(request).catch(error => {
          const failure = error instanceof BotError ? { error: error.error, ctx: error.ctx } : { error };
          console.error(handlerFailureLine(failure));
          return new Response(null, { status: 200 });
        });
        // Nach der Frist antwortet der Listener mit 200, der Turn läuft weiter
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<Response>(resolve => {
          timer = setTimeout(() => resolve(new Response(null, { status: 200 })), timeoutMs);
        });
        return Promise.race([handled, timeout]).finally(() => clearTimeout(timer));
      },
    });
  } catch (error) {
    log(`[telegram] Webhook-Listener auf ${config.hostname}:${config.port} nicht geöffnet (${reasonOf(error)})`);
    return null;
  }
  log(`[telegram] Webhook-Listener auf http://${config.hostname}:${server.port}${config.path}`);
  return server;
}

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

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
    sendMessageChecked: async (chatId: string | number) => (await refuse("Nachricht", chatId), true),
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
    webhookPort: () => null,
    relayIntake: () => null,
    stop() {},
  };
}
