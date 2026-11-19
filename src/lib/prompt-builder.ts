/**
 * Prompt eines Turns (Issue #358): setzt aus Agenten-Prompt, Kanalregeln,
 * Kontext und Tag-Abschnitten den Text zusammen, den der Motor bekommt.
 *
 * Zwei Formen:
 * - frisch (buildPromptContext): alles, dazu der Kontext für die
 *   Fallback-Kette (src/lib/fallback/chain.ts), falls der Motor scheitert
 *   Beim Motorwechsel erweitert handover nur den Verlauf des Motor-Prompts;
 *   der Fallback-Kontext behält die üblichen zehn Nachrichten.
 * - fortgesetzt (buildResumePrompt): die Session kennt den Rest schon, also
 *   nur Zeit, Kanal, neue Merk-Einträge, passende Fakten, Suchtreffer und die
 *   Nachricht
 *
 * Regeln (docs/topic-sessions.md F-2/F-3): Der Verlauf kommt nur aus dem
 * eigenen Topic (Direktchat und General zählen als ein Topic ohne Nummer).
 * Die semantische Suche läuft bei jeder Nachricht und über alle Topics.
 * Fakten (Issue #523): Der fortgesetzte Prompt bringt höchstens FOLLOW_UP_FACTS
 * passende Fakten, die die Session noch nicht kennt, aus demselben Suchvektor wie
 * die Treffer; was gezeigt wurde, meldet er über onFactsShown, gespeichert wird es
 * erst nach einem gelungenen Lauf (chat-turn.ts, session-manager.ts).
 * Der feste Kern (memory/core.ts, Issue #522) steht nur im frischen Prompt und
 * im Fallback-Kontext, neben dem Profil und außerhalb des Budgets der
 * Ähnlichkeitssuche; gelesen wird er jedes Mal, also ohne Neustart aktuell.
 * Kanalregeln stehen in beiden Formen, weil eine Session zwischen Telegram
 * und Browser wechseln kann; ohne Angabe gilt Telegram. Wen der Agent fragen
 * darf, steht nur im erzeugten Abschnitt (formatConsultationRules): der feste
 * Abschnitt des Code-Prompts fällt weg, ein gespeicherter Prompt bleibt
 * wortgleich und wird durch den erzeugten außer Kraft gesetzt. Ist die Liste
 * leer, steht ausdrücklich da, dass es niemanden zu fragen gibt.
 */

import { homedir } from "node:os";
import { getAgentConfigOrGeneral, getUserProfile } from "../agents";
import type { AgentConfig } from "../agents/types";
import {
  DEFAULT_PROMPT_CHANNEL,
  factLookupSection,
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
import { getMemorySelection } from "./memory";
import { FACT_DATE_NOTE, factIdsOf, factLine, memoryDeltaSelection, type MemorySelection } from "./memory/context";
import { followUpSearch } from "./memory/follow-up";
import { coreForPrompt } from "./memory/core";
import { storeOr } from "./store";
import type { FactWish, HitsWithFacts, MemoryItem, Message } from "./store/types";
import { QUESTION_TAG_SECTION } from "./turn-questions";
import type { HandoverReason } from "./session-manager";
import type { EngineId } from "./engines/types";
import { claudeNotesSection } from "./engines/claude-notes";
import { projectSecrets } from "./jobs/mask";
import { getSettings } from "./settings";

export type { PromptChannel } from "../agents/prompt-parts";

const PROJECT_ROOT = process.cwd();
/** Nachrichten aus dem eigenen Topic im frischen Prompt */
const RECENT_LIMIT = 10;
export const HANDOVER_MAX_MESSAGES = 30;
/** Budget des formatierten Verlaufs einschließlich Sprecher, Zeiten und Zeilenumbrüchen. */
export const HANDOVER_MAX_CHARS = 24_000;
const HANDOVER_RECENT_MAX_CHARS = 6_000;
/** Datenbank und Rechner können beim Speichern der ersten Antwort leicht auseinanderliegen. */
const HANDOVER_CLOCK_TOLERANCE_MS = 5_000;

export interface PromptHandover {
  fromLabel: string;
  reason: HandoverReason;
  since: number;
}
/** Treffer der semantischen Suche je Prompt */
const SIMILAR_LIMIT = 5;
/** Länge eines Suchtreffers im Prompt, danach "..." */
const SIMILAR_MAX_CHARS = 300;
/** So viele neue Fakten höchstens je Folgenachricht; bei weniger Treffern weniger */
const FOLLOW_UP_FACTS = 5;
/** Mehr anfragen, als gezeigt werden: Fakten aus MEMORY_UPDATES fallen danach heraus */
const FOLLOW_UP_FACT_SPARE = 5;

/** Trenner zwischen den Abschnitten des Prompts */
const SECTION_BREAK = "\n\n---\n\n";

/** Überschrift des festen Kerns im Prompt */
const CORE_SECTION = "USER CORE (confirmed by the user)";

export interface PromptContextOptions {
  userMessage: string;
  /** Telegram-Chat oder web:<id> */
  chatId: string;
  agentName: string;
  topicId?: number;
  /** Kanal der Antwort; fehlt er, gelten die Telegram-Regeln */
  channel?: PromptChannel;
  engine?: EngineId;
  handover?: PromptHandover;
}

export interface ResumePromptOptions {
  userMessage: string;
  chatId: string;
  /** Beginn der Session (ms): Merk-Einträge danach kommen in den Prompt */
  sinceMs?: number;
  channel?: PromptChannel;
  /** Fakten, die die Session schon kennt */
  shownFactIds?: string[];
  /** Bekommt die Fakten, die die Session mit diesem Prompt kennt; verbucht wird nach dem Lauf */
  onFactsShown?: (ids: string[]) => void;
}

export interface PromptContext {
  /** Vollständiger Prompt für den Motor */
  fullPrompt: string;
  /** Kontext für die Fallback-Kette (fallback/chain.ts), wenn der Motor scheitert */
  fallbackContext: string;
  /** Fakten, die dieser Prompt zeigt */
  shownFactIds?: string[];
}

/** Woher der Builder seine Angaben holt; Tests reichen Fakes herein */
export interface PromptSources {
  /** Agent ohne statische Konsultationshinweise; die erzeugten kommen aus consultation */
  agent(name: string): AgentConfig | undefined;
  overrides(name: string): string;
  consultation(name: string): string;
  profile(): Promise<string>;
  /** Fester Kern; ohne Kern leer */
  core(): Promise<string>;
  /** Als Text, wenn die Quelle die gezeigten Fakten nicht nennt */
  memory(userMessage: string): Promise<string | MemorySelection>;
  knowledge(userMessage: string): Promise<string>;
  /** Fertiger Abschnitt mit den Projekt-Notizen von Claude Code, nur für Codex */
  claudeNotes(): Promise<string>;
  /** Letzte Nachrichten des Topics, älteste zuerst; topicId null heißt ohne Topic */
  recent(chatId: string, limit: number, topicId: number | null): Promise<Message[]>;
  similar(chatId: string, query: string, limit: number): Promise<Message[]>;
  /** Treffer für eine Folgenachricht samt Fakten aus demselben Suchvektor */
  followUp(chatId: string, query: string, limit: number, facts: FactWish): Promise<HitsWithFacts>;
  /** Neue oder geänderte Merk-Einträge seit since, schon als Zeilen */
  memorySince(since: Date): Promise<string | MemorySelection>;
  now(): Date;
  timeZone(): string;
}

const readClaudeNotes = () => claudeNotesSection({ projectRoot: PROJECT_ROOT, home: homedir(), secrets: projectSecrets(PROJECT_ROOT) });
let claudeNotesSource = readClaudeNotes;
/** Tests mit Teil-Quellen dürfen nie die echten Notizen lesen. */
export function setClaudeNotesSourceForTests(source: (() => string) | null): void {
  claudeNotesSource = source ?? readClaudeNotes;
}

/** Echte Quellen; ohne Datenbank (Issue #314) gibt es keinen Verlauf, keine Treffer und kein Delta */
export const defaultPromptSources: PromptSources = {
  agent: name => getAgentConfigOrGeneral(name, { consultationHints: false }),
  overrides: formatOverridesSection,
  consultation: name => formatConsultationRules(name),
  profile: getUserProfile,
  core: () => coreForPrompt(),
  memory: userMessage => getMemorySelection(userMessage),
  knowledge: userMessage => getKnowledgeContext(userMessage),
  claudeNotes: async () => getSettings().engine?.codex?.claudeNotes === false ? "" : claudeNotesSource(),
  recent: (chatId, limit, topicId) => storeOr([], store => store.messages.recent(chatId, limit, topicId)),
  similar: (chatId, query, limit) => storeOr([], store => store.messages.search(chatId, query, limit)),
  followUp: followUpSearch,
  memorySince: async since => memoryDeltaSelection(await storeOr([], store => store.memory.changedSince(since))),
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

/** Antwort einer Quelle einheitlich; als reiner Text nennt sie keine Fakten */
const asSelection = (value: string | MemorySelection): MemorySelection => (typeof value === "string" ? { context: value, factIds: [] } : value);

/** Fakten einer Folgenachricht als Abschnitt; ohne Fakten leer */
function followUpFactsSection(facts: MemoryItem[]): string[] {
  if (facts.length === 0) return [];
  return [`## RELEVANT FACTS\nStored facts that may fit this message and were not shown earlier in this session:\n${FACT_DATE_NOTE}\n${facts.map(factLine).join("\n")}`];
}

/** Ein Fehler der Quelle zählt wie "nichts gefunden" */
function orEmpty<T>(read: () => Promise<T>, empty: T): Promise<T> {
  return read().catch(() => empty);
}

/** Sessionbeginn aus dem Verlauf, einschließlich unmittelbar vorausgehender Nutzerbeiträge. */
function handoverConversation(messages: Message[], since: number, now: Date): string | undefined {
  const recent = messages.slice(-HANDOVER_MAX_MESSAGES);
  let start = recent.findIndex(message => message.created_at !== undefined
    && Date.parse(message.created_at) >= since - HANDOVER_CLOCK_TOLERANCE_MS);
  if (start < 0) return undefined;
  while (start > 0 && recent[start - 1]!.role === "user") start--;
  // Kurze Sessions dürfen den üblichen Kontext nicht verkleinern (Auslegung von 0027).
  const first = Math.min(start, Math.max(0, recent.length - RECENT_LIMIT));
  const lines = recent.slice(first).map((message, index) => formatConversationContext(
    [message], now,
    first + index >= Math.max(start, recent.length - 4) ? HANDOVER_RECENT_MAX_CHARS : undefined
  ));
  let length = lines.join("\n").length;
  while (length > HANDOVER_MAX_CHARS && lines.length) {
    length -= lines.shift()!.length + (lines.length ? 1 : 0);
  }
  return lines.join("\n");
}

export const HANDOVER_REASONS: Record<HandoverReason, string> = {
  limit: "Limit erreicht",
  outage: "Ausfall",
  user: "Wahl des Nutzers",
  changed: "Einstellung oder Verfügbarkeit geändert",
};

function handoverLine(handover: PromptHandover): string {
  return `Du übernimmst dieses Gespräch von ${handover.fromLabel}. Der Wechsel hat einen technischen Grund (${HANDOVER_REASONS[handover.reason]}); für den Nutzer läuft das Gespräch weiter. Unten steht der Verlauf seit Beginn der Session. Knüpfe daran an, ohne den Wechsel zu erklären.`;
}

/**
 * Prompt für die Folgenachricht einer laufenden Session (docs/topic-sessions.md
 * F-1/F-3). System-Prompt, Profil, Kern, Gedächtnis und Verlauf hat die Session
 * schon; neu sind Zeit, Kanal, Merk-Einträge seit sinceMs, passende Fakten und
 * frische Treffer.
 */
export async function buildResumePrompt(opts: ResumePromptOptions, sources: Partial<PromptSources> = {}): Promise<string> {
  const s = withDefaults(sources);
  const timeZone = s.timeZone();
  const known = opts.shownFactIds ?? [];
  const wish: FactWish = { limit: FOLLOW_UP_FACTS + FOLLOW_UP_FACT_SPARE, excludeIds: known };
  const [found, delta] = await Promise.all([
    orEmpty(() => s.followUp(opts.chatId, opts.userMessage, SIMILAR_LIMIT, wish), { messages: [], facts: [] } as HitsWithFacts),
    opts.sinceMs ? orEmpty(() => s.memorySince(new Date(opts.sinceMs!)), "") : Promise.resolve(""),
  ]);
  const { context: updates, factIds: updatedIds } = asSelection(delta);
  const shown = new Set([...known, ...updatedIds]);
  const facts = (found.facts ?? []).filter(fact => !shown.has(String(fact.id))).slice(0, FOLLOW_UP_FACTS);
  opts.onFactsShown?.([...new Set([...shown, ...factIdsOf(facts)])]);
  return [
    ...section("CURRENT TIME", formatPromptTime(s.now(), timeZone)),
    formatChannelRules(opts.channel ?? DEFAULT_PROMPT_CHANNEL),
    ...section("MEMORY UPDATES", updates ? `Facts and goals added since this session began:\n${updates}` : ""),
    ...followUpFactsSection(facts),
    ...similarSection(found.messages, timeZone),
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

  const [profile, core, selection, recent, hits, knowledge, claudeNotes] = await Promise.all([
    s.profile(),
    orEmpty(() => s.core(), ""),
    s.memory(userMessage),
    // Nur das eigene Topic: ohne Topic null (nicht undefined), sonst kämen Forum-Topics dazu
    s.recent(chatId, opts.handover ? HANDOVER_MAX_MESSAGES : RECENT_LIMIT, opts.topicId ?? null),
    orEmpty(() => s.similar(chatId, userMessage, SIMILAR_LIMIT), [] as Message[]),
    orEmpty(() => s.knowledge(userMessage), ""),
    opts.engine === "codex" ? orEmpty(() => s.claudeNotes(), "") : "",
  ]);
  const { context: memory, factIds: shownFactIds } = asSelection(selection);
  const now = s.now();
  const conversation = formatConversationContext(opts.handover ? recent.slice(-RECENT_LIMIT) : recent, now);
  const handover = opts.handover ? handoverConversation(recent, opts.handover.since, now) : undefined;
  const overrides = s.overrides(agentName);
  const similar = similarSection(hits, timeZone);
  const agent = s.agent(agentName);
  const systemPrompt = agent?.systemPrompt ?? FALLBACK_SYSTEM_PROMPT;
  const lookup = factLookupSection(agent?.allowedTools);
  // Darf der Agent niemanden fragen, steht das ausdrücklich da, auch gegen Weiterleitungsvorschläge im Prompt
  const consultation = s.consultation(agentName) || NO_CONSULTATION_RULES;

  const fullPrompt = [
    systemPrompt,
    ...(overrides ? [overrides] : []),
    formatChannelRules(opts.channel ?? DEFAULT_PROMPT_CHANNEL),
    ...section("USER PROFILE", profile),
    ...section(CORE_SECTION, core),
    ...section("CURRENT TIME", formatPromptTime(s.now(), timeZone)),
    ...section("MEMORY", memory),
    ...section("KNOWLEDGE BASE", knowledge),
    ...(claudeNotes ? [claudeNotes] : []),
    ...section("RECENT CONVERSATION", handover && opts.handover ? `${handoverLine(opts.handover)}\n${handover}` : conversation),
    ...similar,
    ...(consultation ? [consultation] : []),
    ...(lookup ? [lookup] : []),
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
    ...section(CORE_SECTION, core),
    ...section("MEMORY (facts & goals)", memory),
    ...section("KNOWLEDGE BASE", knowledge),
    ...section("RECENT CONVERSATION", conversation),
    ...similar,
  ].join("\n\n");

  return { fullPrompt, fallbackContext, shownFactIds };
}
