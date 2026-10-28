/**
 * Prompt eines Turns (Issue #358): setzt aus Agenten-Prompt, Kanalregeln,
 * Kontext und Tag-Abschnitten den Text zusammen, den der Motor bekommt.
 *
 * Zwei Formen:
 * - frisch (buildPromptContext): alles, dazu der Kontext für die
 *   Fallback-Kette (src/lib/fallback/chain.ts), falls der Motor scheitert
 * - fortgesetzt (buildResumePrompt): die Session kennt den Rest schon, also
 *   nur Zeit, Kanal, neue Merk-Einträge, Suchtreffer und die Nachricht
 *
 * Regeln (docs/topic-sessions.md F-2/F-3): Der Verlauf kommt nur aus dem
 * eigenen Topic (Direktchat und General zählen als ein Topic ohne Nummer).
 * Die semantische Suche läuft bei jeder Nachricht und über alle Topics.
 * Kanalregeln stehen in beiden Formen, weil eine Session zwischen Telegram
 * und Browser wechseln kann; ohne Angabe gilt Telegram. Wen der Agent fragen
 * darf, steht nur im erzeugten Abschnitt (formatConsultationRules): der feste
 * Abschnitt des Code-Prompts fällt weg, ein gespeicherter Prompt bleibt
 * wortgleich und wird durch den erzeugten außer Kraft gesetzt. Ist die Liste
 * leer, steht ausdrücklich da, dass es niemanden zu fragen gibt.
 */

import { getAgentConfigOrGeneral, getUserProfile } from "../agents";
import type { AgentConfig } from "../agents/types";
import {
  DEFAULT_PROMPT_CHANNEL,
  FALLBACK_SYSTEM_PROMPT,
  formatChannelRules,
  formatConsultationRules,
  formatPromptTime,
  IMAGE_TAG_SECTION,
  MEMORY_TAGS_SECTION,
  NO_CONSULTATION_RULES,
  promptTimeZone,
  type PromptChannel,
} from "../agents/prompt-parts";
import { formatOverridesSection } from "./agent-overrides";
import { formatConversationContext } from "./conversation-context";
import { getKnowledgeContext } from "./knowledge-base";
import { getMemoryContext } from "./memory";
import { memoryDelta } from "./memory/context";
import { storeOr } from "./store";
import type { Message } from "./store/types";
import { QUESTION_TAG_SECTION } from "./turn-questions";

export type { PromptChannel } from "../agents/prompt-parts";

/** Nachrichten aus dem eigenen Topic im frischen Prompt */
const RECENT_LIMIT = 10;
/** Treffer der semantischen Suche je Prompt */
const SIMILAR_LIMIT = 5;
/** Länge eines Suchtreffers im Prompt, danach "..." */
const SIMILAR_MAX_CHARS = 300;

/** Trenner zwischen den Abschnitten des Prompts */
const SECTION_BREAK = "\n\n---\n\n";

export interface PromptContextOptions {
  userMessage: string;
  /** Telegram-Chat oder web:<id> */
  chatId: string;
  agentName: string;
  topicId?: number;
  /** Kanal der Antwort; fehlt er, gelten die Telegram-Regeln */
  channel?: PromptChannel;
}

export interface ResumePromptOptions {
  userMessage: string;
  chatId: string;
  /** Beginn der Session (ms): Merk-Einträge danach kommen in den Prompt */
  sinceMs?: number;
  channel?: PromptChannel;
}

export interface PromptContext {
  /** Vollständiger Prompt für den Motor */
  fullPrompt: string;
  /** Kontext für die Fallback-Kette (fallback/chain.ts), wenn der Motor scheitert */
  fallbackContext: string;
}

/** Woher der Builder seine Angaben holt; Tests reichen Fakes herein */
export interface PromptSources {
  /** Agent ohne statische Konsultationshinweise; die erzeugten kommen aus consultation */
  agent(name: string): AgentConfig | undefined;
  overrides(name: string): string;
  consultation(name: string): string;
  profile(): Promise<string>;
  memory(userMessage: string): Promise<string>;
  knowledge(userMessage: string): Promise<string>;
  /** Letzte Nachrichten des Topics, älteste zuerst; topicId null heißt ohne Topic */
  recent(chatId: string, limit: number, topicId: number | null): Promise<Message[]>;
  similar(chatId: string, query: string, limit: number): Promise<Message[]>;
  /** Neue oder geänderte Merk-Einträge seit since, schon als Zeilen */
  memorySince(since: Date): Promise<string>;
  now(): Date;
  timeZone(): string;
}

/** Echte Quellen; ohne Datenbank (Issue #314) gibt es keinen Verlauf, keine Treffer und kein Delta */
export const defaultPromptSources: PromptSources = {
  agent: name => getAgentConfigOrGeneral(name, { consultationHints: false }),
  overrides: formatOverridesSection,
  consultation: name => formatConsultationRules(name),
  profile: getUserProfile,
  memory: userMessage => getMemoryContext(userMessage),
  knowledge: userMessage => getKnowledgeContext(userMessage),
  recent: (chatId, limit, topicId) => storeOr([], store => store.messages.recent(chatId, limit, topicId)),
  similar: (chatId, query, limit) => storeOr([], store => store.messages.search(chatId, query, limit)),
  memorySince: async since => memoryDelta(await storeOr([], store => store.memory.changedSince(since))),
  now: () => new Date(),
  timeZone: promptTimeZone,
};

function withDefaults(sources: Partial<PromptSources>): PromptSources {
  return { ...defaultPromptSources, ...sources };
}

/** Abschnitt mit Überschrift; leerer Inhalt ergibt keinen Abschnitt */
function section(heading: string, body: string): string[] {
  return body ? [`## ${heading}\n${body}`] : [];
}

/** Suchtreffer als Abschnitt, im selben Zeitformat wie die aktuelle Zeit; ohne Treffer leer */
function similarSection(hits: Message[], timeZone: string): string[] {
  if (hits.length === 0) return [];
  const lines = hits.map(hit => {
    const when = hit.created_at ? formatPromptTime(new Date(hit.created_at), timeZone) : "time unknown";
    const who = hit.role === "user" ? "User" : "Bot";
    const text = hit.content.length > SIMILAR_MAX_CHARS ? `${hit.content.slice(0, SIMILAR_MAX_CHARS)}...` : hit.content;
    return `[${when}] ${who}: ${text}`;
  });
  return [`## SEMANTIC SEARCH RESULTS\nOlder messages that are close in meaning to the current one:\n${lines.join("\n")}`];
}

/** Ein Fehler der Quelle zählt wie "nichts gefunden" */
function orEmpty<T>(read: () => Promise<T>, empty: T): Promise<T> {
  return read().catch(() => empty);
}

/**
 * Prompt für die Folgenachricht einer laufenden Session (docs/topic-sessions.md
 * F-1/F-3). System-Prompt, Profil, Gedächtnis und Verlauf hat die Session
 * schon; neu sind Zeit, Kanal, Merk-Einträge seit sinceMs und frische Treffer.
 */
export async function buildResumePrompt(opts: ResumePromptOptions, sources: Partial<PromptSources> = {}): Promise<string> {
  const s = withDefaults(sources);
  const timeZone = s.timeZone();
  const [hits, updates] = await Promise.all([
    orEmpty(() => s.similar(opts.chatId, opts.userMessage, SIMILAR_LIMIT), [] as Message[]),
    opts.sinceMs ? orEmpty(() => s.memorySince(new Date(opts.sinceMs!)), "") : Promise.resolve(""),
  ]);
  return [
    ...section("CURRENT TIME", formatPromptTime(s.now(), timeZone)),
    formatChannelRules(opts.channel ?? DEFAULT_PROMPT_CHANNEL),
    ...section("MEMORY UPDATES", updates ? `Facts and goals added since this session began:\n${updates}` : ""),
    ...similarSection(hits, timeZone),
    `## USER MESSAGE\n${opts.userMessage}`,
  ].join(SECTION_BREAK);
}

/**
 * Frischer Prompt und Fallback-Kontext für eine Nachricht. Alle Quellen
 * laufen parallel; Suche und Wissensbasis dürfen scheitern, dann fehlt nur
 * ihr Abschnitt.
 */
export async function buildPromptContext(opts: PromptContextOptions, sources: Partial<PromptSources> = {}): Promise<PromptContext> {
  const s = withDefaults(sources);
  const timeZone = s.timeZone();
  const { userMessage, chatId, agentName } = opts;

  const [profile, memory, recent, hits, knowledge] = await Promise.all([
    s.profile(),
    s.memory(userMessage),
    // Nur das eigene Topic: ohne Topic null (nicht undefined), sonst kämen Forum-Topics dazu
    s.recent(chatId, RECENT_LIMIT, opts.topicId ?? null),
    orEmpty(() => s.similar(chatId, userMessage, SIMILAR_LIMIT), [] as Message[]),
    orEmpty(() => s.knowledge(userMessage), ""),
  ]);
  const conversation = formatConversationContext(recent, s.now());
  const overrides = s.overrides(agentName);
  const similar = similarSection(hits, timeZone);
  const systemPrompt = s.agent(agentName)?.systemPrompt ?? FALLBACK_SYSTEM_PROMPT;
  // Darf der Agent niemanden fragen, steht das ausdrücklich da, auch gegen Weiterleitungsvorschläge im Prompt
  const consultation = s.consultation(agentName) || NO_CONSULTATION_RULES;

  const fullPrompt = [
    systemPrompt,
    ...(overrides ? [overrides] : []),
    formatChannelRules(opts.channel ?? DEFAULT_PROMPT_CHANNEL),
    ...section("USER PROFILE", profile),
    ...section("CURRENT TIME", formatPromptTime(s.now(), timeZone)),
    ...section("MEMORY", memory),
    ...section("KNOWLEDGE BASE", knowledge),
    ...section("RECENT CONVERSATION", conversation),
    ...similar,
    ...(consultation ? [consultation] : []),
    MEMORY_TAGS_SECTION,
    // Rückfragen mit Knöpfen (Issue #336)
    QUESTION_TAG_SECTION,
    IMAGE_TAG_SECTION,
    `## USER MESSAGE\n${userMessage}`,
  ].join(SECTION_BREAK);

  // Ohne System-Prompt und Tags: das Ersatzmodell bekommt nur, was es über den Nutzer wissen muss
  const fallbackContext = [
    ...(overrides ? [overrides] : []),
    ...section("USER PROFILE", profile),
    ...section("MEMORY (facts & goals)", memory),
    ...section("KNOWLEDGE BASE", knowledge),
    ...section("RECENT CONVERSATION", conversation),
    ...similar,
  ].join("\n\n");

  return { fullPrompt, fallbackContext };
}
