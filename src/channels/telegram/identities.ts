/**
 * Agenten-Identitäten in Telegram (Issue #330, Entscheidung E15): welcher Bot
 * im Namen eines Agenten schreibt.
 *
 * - Jeder aktive Agent aus dem Katalog darf einen eigenen Absender-Bot
 *   haben, auch General. Das Token steht in TELEGRAM_BOT_TOKEN_<KENNUNG>, die
 *   Kennung groß, Bindestriche als Unterstriche (projekt-planer wird
 *   TELEGRAM_BOT_TOKEN_PROJEKT_PLANER). Ohne TELEGRAM_BOT_TOKEN_GENERAL
 *   spricht General wie bisher über den Haupt-Bot.
 * - Agenten-Bots senden nur. Sie werden mit init() angemeldet, nie gestartet
 *   (kein Polling, kein Webhook), und bekommen denselben Output-Guard wie der
 *   Haupt-Bot.
 * - Tokens werden in initialize() einmal gelesen, für die Agenten, die in
 *   diesem Moment aktiv sind. Ein später angelegter Agent bekommt seinen Bot
 *   beim nächsten Start (wie jede andere Änderung an .env). Wer gelöscht
 *   wird, verliert seine Identität sofort: Senden geht dann über den
 *   Haupt-Bot, eine Mention holt ihn nicht mehr. Wiederhergestellt gilt der
 *   schon angemeldete Bot wieder.
 * - Fehlt das Token oder scheitert die Anmeldung, sendet der Haupt-Bot. Das
 *   Log nennt dann nur eine Fehlerkategorie (initFailureCategory), nie den
 *   Fehlertext: der kann Token oder Telegram-URL samt Token enthalten.
 * - Namen werden mit den Aliassen aus src/agents/names.ts aufgelöst
 *   (BOT_REGISTRY_ALIASES), sonst nur kleingeschrieben.
 */

import { Bot, GrammyError, HttpError } from "grammy";
import { listAgentNames } from "../../agents/catalog";
import { AGENT_NAMES, BOT_REGISTRY_ALIASES } from "../../agents/names";
import { installTelegramOutputGuard } from "../../lib/telegram";
import { logLostPieces, sendRendered, transmitViaApi } from "./send";

/** Agent, der ohne eigenes Token über den Haupt-Bot spricht; nicht in AGENT_TOKEN_MAP */
export const MAIN_BOT_AGENT = "general";

const TOKEN_PREFIX = "TELEGRAM_BOT_TOKEN_";

/** Name der Variable mit dem Bot-Token eines Agenten */
export function agentTokenEnvName(agentId: string): string {
  return TOKEN_PREFIX + agentId.toUpperCase().replaceAll("-", "_");
}

/**
 * Token-Variablen der mitgelieferten Agenten ohne General, abgeleitet aus
 * AGENT_NAMES. Vertrag: Statusseite (src/web/status.ts) und Schlüssel-Katalog
 * (src/web/key-catalog.ts) führen genau diese Namen; Tests gleichen ab.
 * TELEGRAM_BOT_TOKEN_GENERAL und Tokens eigener Agenten stehen nicht darin,
 * sie liefert agentTokenEnvName.
 */
export const AGENT_TOKEN_MAP: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(AGENT_NAMES.filter(name => name !== MAIN_BOT_AGENT).map(name => [name, agentTokenEnvName(name)])),
);

export interface AgentIdentitiesOptions {
  /** Woher die Tokens kommen; Standard process.env */
  env?: Record<string, string | undefined>;
  /** Baut einen Agenten-Bot zum Token; Standard new Bot(token) */
  createBot?: (token: string) => Bot;
  /** Kennungen der aktiven Agenten, je Aufruf frisch; Standard der Katalog */
  activeAgents?: () => readonly string[];
}

type ThreadOption = { threadId?: number };

/**
 * Sichere Beschreibung einer gescheiterten Anmeldung fürs Log. Fehlertexte
 * von grammY enthalten oft die Telegram-URL samt Token, deshalb nur Art und
 * HTTP-Code, nie die Meldung selbst.
 */
export function initFailureCategory(reason: unknown): string {
  if (reason instanceof GrammyError) return `Telegram lehnt ab (${reason.error_code})`;
  if (reason instanceof HttpError) return "Telegram nicht erreichbar";
  return "unbekannter Fehler";
}

export class AgentIdentities {
  private readonly main: Bot;
  private readonly env: Record<string, string | undefined>;
  private readonly build: (token: string) => Bot;
  private readonly active: () => readonly string[];
  /** Angemeldete Agenten-Bots in Katalog-Reihenfolge */
  private own = new Map<string, Bot>();

  constructor(mainBot: Bot, options: AgentIdentitiesOptions = {}) {
    this.main = mainBot;
    this.env = options.env ?? process.env;
    this.build = options.createBot ?? (token => new Bot(token));
    this.active = options.activeAgents ?? listAgentNames;
    // Issue #52: auch der Haupt-Bot sendet hierüber nur bereinigt und ohne Vorschau
    installTelegramOutputGuard(mainBot.api);
  }

  /** Agenten-Bots anmelden (getMe je Token, sonst kein Netz) */
  async initialize(): Promise<void> {
    const candidates: { agent: string; bot: Bot }[] = [];
    for (const agent of this.active()) {
      const token = this.env[agentTokenEnvName(agent)]?.trim();
      if (!token) continue;
      const bot = this.build(token);
      installTelegramOutputGuard(bot.api);
      candidates.push({ agent, bot });
    }
    const results = await Promise.allSettled(candidates.map(c => c.bot.init()));
    const own = new Map<string, Bot>();
    results.forEach((result, i) => {
      const { agent, bot } = candidates[i];
      if (result.status === "fulfilled") {
        own.set(agent, bot);
        console.log(`[Identitäten] ${agent} schreibt als @${bot.botInfo.username}`);
      } else {
        console.error(`[Identitäten] Bot für ${agent} nicht angemeldet, Haupt-Bot springt ein: ${initFailureCategory(result.reason)}`);
      }
    });
    this.own = own;
    console.log(`[Identitäten] ${own.size} eigene Agenten-Bots, sonst der Haupt-Bot`);
  }

  /** Bot, der für diesen Agenten (Kennung oder Alias) schreibt */
  botFor(agentName: string): Bot {
    const agent = this.canonical(agentName);
    const bot = this.own.get(agent);
    return bot && this.active().includes(agent) ? bot : this.main;
  }

  /**
   * Agent, dessen eigener Bot im Text per @Name erwähnt wird, samt Text ohne
   * die Erwähnung (bleibt nichts übrig, der Originaltext). Der Haupt-Bot
   * zählt nicht, er gehört dem Agenten des Topics.
   */
  agentForMention(text: string): { agent: string; cleanedText: string } | null {
    const active = this.active();
    for (const [agent, bot] of this.own) {
      const username = bot.botInfo?.username;
      if (!username || !active.includes(agent)) continue;
      const pattern = new RegExp(`@${username}\\b`, "gi");
      if (!pattern.test(text)) continue;
      const cleanedText = text.replace(pattern, "").replace(/\s{2,}/g, " ").trim();
      return { agent, cleanedText: cleanedText || text };
    }
    return null;
  }

  /** Markdown als Nachricht des Agenten, in Stücken mit Klartext-Rückfall (Issue #328) */
  async sendAsAgent(agentName: string, chatId: string | number, text: string, options?: ThreadOption): Promise<void> {
    await this.deliver(agentName, chatId, text, options?.threadId);
  }

  /** Wie sendAsAgent, die Knöpfe hängen am letzten Stück */
  async sendWithKeyboardAsAgent(agentName: string, chatId: string | number, text: string, keyboard: unknown, options?: ThreadOption): Promise<void> {
    await this.deliver(agentName, chatId, text, options?.threadId, keyboard);
  }

  /** „schreibt …“ vom Bot des Agenten; Fehler sind egal */
  async sendTypingAsAgent(agentName: string, chatId: string | number, threadId?: number): Promise<void> {
    const extra = threadId ? { message_thread_id: threadId } : {};
    await this.botFor(agentName).api.sendChatAction(chatId, "typing", extra).catch(() => {});
  }

  private canonical(agentName: string): string {
    const lower = agentName.toLowerCase();
    return BOT_REGISTRY_ALIASES[lower] ?? lower;
  }

  private async deliver(agentName: string, chatId: string | number, text: string, threadId?: number, keyboard?: unknown): Promise<void> {
    const transmit = transmitViaApi(this.botFor(agentName).api);
    const report = await sendRendered({ text, format: "markdown", chatId, threadId, keyboard, transmit });
    logLostPieces(report, `Identität ${agentName}`);
  }
}
