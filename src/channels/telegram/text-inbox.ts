/**
 * Text-Eingang aus Telegram (Issue #344): was mit einer Textnachricht des
 * Besitzers passiert, bevor ein Agent antwortet. Reihenfolge:
 *
 * 1. Topic-Namen nebenbei merken (ohne zu warten)
 * 2. Nachricht speichern, ein Zitat als kurzer Vermerk in den Metadaten
 * 3. Befehl der gemeinsamen Befehls-Schicht (Issue #74, seit #346 auch /credit): fertig
 * 4. @agentbot-Erwähnung eines aktiven Agenten: dieser Agent antwortet
 * 5. Topic ohne Agent: einmal fragen, wem es gehört (Register, sonst alte Knöpfe)
 * 6. Antwort des Topic-Agenten bzw. von general
 *
 * Zitiert der Nutzer per Telegram-Reply eine Nachricht, steht sie vor dem
 * Prompt: die Session sieht sonst nur die Antwort, nicht den Bezug, vor allem
 * wenn die zitierte Nachricht aus einem anderen Prozess kam.
 */
import type { CommandMatch } from "../../lib/commands/types";
import type { Message } from "../../lib/store/types";
import { legacyButtonPages, TOPIC_MAP_TEXT } from "../../lib/topic-choices";

/** Längstes Zitat im Prompt, danach ein Kürzungsvermerk */
export const QUOTE_MAX_CHARS = 3000;
/** Länge des Zitats in den Metadaten der gespeicherten Nachricht */
export const QUOTE_NOTE_CHARS = 300;

export interface ReplyQuote {
  text: string;
  /** Die zitierte Nachricht kam von einem Bot (tybo oder ein Agenten-Bot) */
  byBot: boolean;
}

interface QuotedMessage {
  text?: string;
  caption?: string;
  forum_topic_created?: unknown;
  from?: { is_bot?: boolean };
}

/**
 * Zitat einer Nachricht. In Forum-Topics zeigt jede Nachricht technisch auf
 * die Service-Nachricht der Topic-Anlage; die trägt keinen Inhalt und zählt
 * nicht als Zitat. Bildunterschriften zählen wie Text.
 */
export function replyQuote(message: unknown): ReplyQuote | undefined {
  const quoted = (message as { reply_to_message?: QuotedMessage } | undefined)?.reply_to_message;
  if (!quoted || quoted.forum_topic_created) return undefined;
  const content = quoted.text || quoted.caption;
  if (!content) return undefined;
  return {
    text: content.length <= QUOTE_MAX_CHARS ? content : `${content.slice(0, QUOTE_MAX_CHARS)}\n[... gekuerzt]`,
    byBot: quoted.from?.is_bot === true,
  };
}

/** Prompt mit vorangestelltem Zitat; ohne Zitat unverändert */
export function promptWithQuote(prompt: string, quote: ReplyQuote | undefined): string {
  if (!quote) return prompt;
  const author = quote.byBot ? "dir (dem Bot)" : "sich selbst";
  return `[Der User antwortet per Telegram-Reply auf diese Nachricht von ${author}:]\n"""\n${quote.text}\n"""\n\n${prompt}`;
}

/** Was vom grammY-Context gebraucht wird */
export interface TextUpdate {
  chat?: { id: number | string };
  message?: { text?: string; message_id?: number; message_thread_id?: number; reply_to_message?: unknown };
  reply(text: string, other?: Record<string, unknown>): Promise<unknown>;
}

export interface TextReplyRequest<C> {
  ctx: C;
  chatId: string;
  userMessage: string;
  agentName: string;
  topicId?: number;
  threads: true;
}

export interface TextInboxDeps<C extends TextUpdate> {
  captureTopicName(topicId: number, message: unknown): Promise<unknown>;
  saveMessage(message: Message): Promise<unknown>;
  matchCommand(text: string): CommandMatch | null | undefined;
  runCommand(ctx: C, chatId: string, topicId: number | undefined, text: string, match: CommandMatch): Promise<void>;
  agentForMention(text: string): { agent: string; cleanedText: string } | null;
  isActiveAgent(agent: string): boolean;
  topicAgent(topicId: number, chatId: string): string | undefined;
  /** true genau einmal je Topic: nur dann wird gefragt */
  claimTopicQuestion(chatId: string, topicId: number): Promise<boolean>;
  /** Frage über das Rückfragen-Register; false, wenn das nicht klappte */
  askTopicAgent(chatId: string, topicId: number): Promise<boolean>;
  agentNames(): string[];
  /** Antwort eines Agenten (createTelegramReply) */
  reply(request: TextReplyRequest<C>): Promise<void>;
}

/** Fragt einmal, welcher Agent das Topic übernimmt; ohne Register wie früher mit topicmap:-Knöpfen */
async function askForTopicAgent<C extends TextUpdate>(deps: TextInboxDeps<C>, ctx: C, chatId: string, topicId: number): Promise<void> {
  if (deps.topicAgent(topicId, chatId)) return;
  if (!(await deps.claimTopicQuestion(chatId, topicId))) return;
  if (await deps.askTopicAgent(chatId, topicId)) return;
  const pages = legacyButtonPages(topicId, deps.agentNames());
  for (let page = 0; page < pages.length; page++) {
    const text = page === 0 ? TOPIC_MAP_TEXT.question(topicId) : TOPIC_MAP_TEXT.legacyMore(page + 1, pages.length);
    await ctx.reply(text, { reply_markup: { inline_keyboard: pages[page] }, message_thread_id: topicId }).catch(() => {});
  }
}

export function createTelegramTextInbox<C extends TextUpdate>(deps: TextInboxDeps<C>): (ctx: C) => Promise<void> {
  return async ctx => {
    const text = ctx.message?.text?.trim();
    if (!text) return;
    const chatId = String(ctx.chat?.id ?? "");
    const topicId = ctx.message?.message_thread_id;

    if (topicId !== undefined) void deps.captureTopicName(topicId, ctx.message).catch(() => {});

    const quote = replyQuote(ctx.message);
    const metadata = { topicId, messageId: ctx.message?.message_id, replyTo: quote?.text.slice(0, QUOTE_NOTE_CHARS) };
    await deps.saveMessage({ chat_id: chatId, role: "user", content: text, metadata });

    const match = deps.matchCommand(text);
    if (match) {
      await deps.runCommand(ctx, chatId, topicId, text, match);
      return;
    }

    const answer = (agentName: string, prompt: string) =>
      deps.reply({ ctx, chatId, userMessage: promptWithQuote(prompt, quote), agentName, topicId, threads: true });

    // Gelöschte Agenten (Issue #49) kommen nicht mehr, auch wenn ihr Bot-Token noch gilt
    const mention = deps.agentForMention(text);
    if (mention && deps.isActiveAgent(mention.agent)) {
      await answer(mention.agent, mention.cleanedText);
      return;
    }

    if (topicId !== undefined) await askForTopicAgent(deps, ctx, chatId, topicId);
    // Bis zur Zuordnung antwortet general; ebenso im Direktchat (Topic 0 gibt es nicht)
    const agent = topicId ? deps.topicAgent(topicId, chatId) || "general" : "general";
    await answer(agent, text);
  };
}
