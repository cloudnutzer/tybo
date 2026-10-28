/**
 * Konsultation anderer Agenten (Issue #341): Ein Agent schreibt in seine
 * Antwort `[INVOKE:agent|Frage]`, der genannte Agent antwortet sichtbar als
 * eigene Nachricht. Der Tag ist Schnittstelle und bleibt wortgleich.
 *
 * Ablauf einer Konsultation (consult):
 *  1. Recht prüfen (mayConsult im Agenten-Katalog); ohne Recht kein Aufruf
 *  2. Tippt-Anzeige des befragten Agenten
 *  3. Prompt aus Gesprächsauszug und Frage (die Frage steht genau einmal)
 *  4. Antwort ohne eigene [INVOKE:]-Tags zustellen: keine Ketten
 *
 * Der Gesprächsauszug kommt aus dem Nachrichtenspeicher: die letzten
 * CONSULT_EXCERPT_MESSAGES Nachrichten genau dieses Gesprächs (Chat und
 * Topic), ohne Meldungen (display_only) und ohne Nachrichten anderer Topics,
 * zusammen höchstens CONSULT_EXCERPT_MAX_CHARS Zeichen (die neuesten
 * bleiben). [INVOKE:]-Tags fallen aus dem Auszug, sonst stünde die Frage
 * doppelt im Prompt. Fehlt der Verlauf (keine Datenbank, leer, Lesefehler),
 * steht dort CONSULT_NO_HISTORY.
 *
 * Budget je Antwort (AGENT_INVOKE_BUDGET) und die Reihenfolge der Stufen
 * regelt der gemeinsame Abschluss (src/lib/turn-finish.ts).
 */
import { mayConsult } from "../agents/catalog";
import { formatConversationContext } from "./conversation-context";
import { storeOr } from "./store";
import { isDisplayOnly, topicOf } from "./store/message-rules";
import type { Message } from "./store/types";

/** Eine Frage an einen anderen Agenten */
export interface ConsultRequest {
  targetAgent: string;
  question: string;
}

/** Überschrift des Konsultations-Prompts; Attrappen in Tests erkennen den Aufruf daran */
export const CONSULT_HEADING = "## AGENT CONSULTATION";
/** So viele jüngste Nachrichten des Gesprächs liest der Auszug höchstens */
export const CONSULT_EXCERPT_MESSAGES = 12;
/** Länge des Auszugs insgesamt; ältere Nachrichten fallen zuerst heraus */
export const CONSULT_EXCERPT_MAX_CHARS = 6_000;
/** Steht im Prompt, wenn es keinen Verlauf gibt */
export const CONSULT_NO_HISTORY = "(No earlier messages of this conversation are available.)";

// Kennung aus Buchstaben, Ziffern, Unterstrich und Bindestrich (Issue #49), Frage bis zur Klammer
const TAG_SOURCE = String.raw`\[INVOKE:([\w-]+)\|([^\]]+)\]`;

/** Alle [INVOKE:agent|Frage] einer Antwort, in ihrer Reihenfolge; Kennung klein */
export function extractConsults(text: string): ConsultRequest[] {
  return Array.from(text.matchAll(new RegExp(TAG_SOURCE, "g")), ([, agent, question]) => ({
    targetAgent: agent.toLowerCase(),
    question: question.trim(),
  }));
}

/** Text ohne [INVOKE:]-Tags, außen ohne Leerraum */
export function stripConsultTags(text: string): string {
  return text.replace(new RegExp(TAG_SOURCE, "g"), "").trim();
}

/** Höchstens budget Konsultationen; was darüber liegt, entfällt mit einer Log-Zeile */
export function limitConsults(requests: ConsultRequest[], budget: number): ConsultRequest[] {
  if (requests.length <= budget) return requests;
  console.warn(`[Konsultation] ${requests.length} angefragt, nur ${budget} erlaubt`);
  return requests.slice(0, budget);
}

/** Wo konsultiert wird: Chat und Topic des fragenden Agenten (null bzw. fehlend: kein Topic) */
export interface ConsultScene {
  chatId: string;
  topicId?: number | null;
}

/** Was der Kanal liefert: Tippt-Anzeige, Modellaufruf als befragter Agent, Zustellen */
export interface ConsultChannel {
  typing(targetAgent: string): Promise<void>;
  ask(prompt: string, targetAgent: string): Promise<string>;
  deliver(targetAgent: string, text: string): Promise<void>;
}

/** Liest die jüngsten Nachrichten eines Gesprächs, älteste zuerst */
export type RecentMessages = (chatId: string, limit: number, topicId: number | null) => Promise<Message[]>;

export interface ConsultDeps {
  /** Ohne Angabe der Nachrichtenspeicher; ohne Datenbank leer */
  recent?: RecentMessages;
  /** Ohne Angabe die Rechte aus dem Agenten-Katalog */
  allowed?(fromAgent: string, targetAgent: string): boolean;
  now?(): Date;
}

const storeRecent: RecentMessages = (chatId, limit, topicId) =>
  storeOr([], store => store.messages.recent(chatId, limit, topicId));

type ExcerptInput = Pick<Message, "role" | "content" | "created_at" | "metadata">;

/**
 * Auszug aus Nachrichten (älteste zuerst): nur das Topic der Szene, ohne
 * Meldungen, ohne [INVOKE:]-Tags, leere fallen weg. Eine Zeile je Nachricht
 * wie im übrigen Gesprächskontext. Leer, wenn nichts übrig bleibt.
 */
export function buildConsultExcerpt(messages: ExcerptInput[], topicId: number | null, now: Date = new Date()): string {
  const kept = messages
    .filter(m => !isDisplayOnly(m.metadata) && topicOf(m.metadata) === topicId)
    .map(m => ({ ...m, content: stripConsultTags(m.content) }))
    .filter(m => m.content.length > 0)
    .slice(-CONSULT_EXCERPT_MESSAGES);

  const newest = kept.at(-1);
  if (!newest) return "";

  // Die neueste Nachricht kommt immer mit und ohne die Kürzung des
  // Gesprächskontexts (die schneidet hinten ab); ist sie zu lang, ihr Ende
  const head = formatConversationContext([{ ...newest, content: "" }], now);
  const room = CONSULT_EXCERPT_MAX_CHARS - head.length;
  const lines = [head + (newest.content.length <= room ? newest.content : `...${newest.content.slice(-(room - 3))}`)];
  let size = lines[0].length;
  for (let i = kept.length - 2; i >= 0; i--) {
    const line = formatConversationContext([kept[i]], now);
    if (size + 1 + line.length > CONSULT_EXCERPT_MAX_CHARS) break;
    lines.unshift(line);
    size += 1 + line.length;
  }
  return lines.join("\n");
}

/** Prompt für den befragten Agenten: Auszug, dann die Frage (genau einmal) */
export function formatConsultPrompt(fromAgent: string, excerpt: string, question: string): string {
  return [
    CONSULT_HEADING,
    "",
    `The ${fromAgent} agent is answering the user and asks for your view.`,
    "",
    "Recent conversation (oldest first):",
    excerpt.trim() || CONSULT_NO_HISTORY,
    "",
    `Question from ${fromAgent}:`,
    question,
    "",
    `Answer from your own specialty and keep it short: ${fromAgent} builds on your answer, and the user sees it as your message.`,
  ].join("\n");
}

async function loadExcerpt(scene: ConsultScene, deps: ConsultDeps): Promise<string> {
  const topicId = scene.topicId ?? null;
  try {
    const messages = await (deps.recent ?? storeRecent)(scene.chatId, CONSULT_EXCERPT_MESSAGES * 2, topicId);
    return buildConsultExcerpt(messages, topicId, deps.now?.() ?? new Date());
  } catch (error) {
    console.warn(`[Konsultation] Verlauf nicht lesbar (${error instanceof Error ? error.name : "Fehler"})`);
    return "";
  }
}

/**
 * Eine Konsultation ausführen. null, wenn fromAgent den Agenten nicht fragen
 * darf (dann weder Tippt-Anzeige noch Aufruf); sonst die zugestellte Antwort
 * ohne [INVOKE:]-Tags. Fehler des Kanals gehen an den Aufrufer.
 */
export async function consult(
  fromAgent: string,
  request: ConsultRequest,
  scene: ConsultScene,
  channel: ConsultChannel,
  deps: ConsultDeps = {},
): Promise<string | null> {
  const { targetAgent, question } = request;
  if (!(deps.allowed ?? mayConsult)(fromAgent, targetAgent)) {
    console.log(`[Konsultation] ${fromAgent} darf ${targetAgent} nicht fragen`);
    return null;
  }
  // Ins Log nur die Kennungen, nie die Frage
  console.log(`[Konsultation] ${fromAgent} fragt ${targetAgent}`);
  await channel.typing(targetAgent);
  const prompt = formatConsultPrompt(fromAgent, await loadExcerpt(scene, deps), question);
  const answer = stripConsultTags(await channel.ask(prompt, targetAgent));
  await channel.deliver(targetAgent, answer);
  return answer;
}

/** Was die Agenten-Bots in Telegram können müssen (AgentIdentities) */
export interface AgentBots {
  sendTypingAsAgent(agent: string, chatId: string | number, threadId?: number): Promise<unknown>;
  sendAsAgent(agent: string, chatId: string | number, text: string, options?: { threadId?: number }): Promise<unknown>;
}

export interface AgentBotConsult {
  bots: AgentBots;
  fromAgent: string;
  request: ConsultRequest;
  chatId: string | number;
  threadId?: number;
  /** Modellaufruf als befragter Agent im selben Topic (callClaude) */
  ask(prompt: string, chatId: string, targetAgent: string, threadId?: number): Promise<string>;
  /** Nach dem Zustellen, etwa zum Speichern für die WebUI */
  delivered?(targetAgent: string, text: string): Promise<void>;
  deps?: ConsultDeps;
}

/**
 * Konsultation in Telegram (Text, Medien, Telefon-Aufträge): Tippt-Anzeige
 * und Antwort kommen vom Bot des befragten Agenten im selben Topic.
 */
export function consultViaAgentBots(c: AgentBotConsult): Promise<string | null> {
  const chatId = String(c.chatId);
  return consult(
    c.fromAgent,
    c.request,
    { chatId, topicId: c.threadId ?? null },
    {
      typing: async target => void (await c.bots.sendTypingAsAgent(target, c.chatId, c.threadId)),
      ask: (prompt, target) => c.ask(prompt, chatId, target, c.threadId),
      deliver: async (target, text) => {
        await c.bots.sendAsAgent(target, c.chatId, text, { threadId: c.threadId });
        await c.delivered?.(target, text);
      },
    },
    c.deps,
  );
}
