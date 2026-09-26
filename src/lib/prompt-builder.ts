/**
 * Prompt Builder — assembles the per-message context prompt for Claude.
 *
 * Single source of truth for the prompt layout, shared by callClaude()
 * and callClaudeWithProgress() in bot.ts (previously duplicated there).
 *
 * Key behaviors (docs/topic-sessions.md F-2/F-3):
 * - Conversation context is TOPIC-ISOLATED: only messages from the same
 *   Telegram forum topic (or the topic-less DM/General pool) are included.
 * - Semantic search runs on EVERY message (no triviality gate) and stays
 *   cross-topic, so knowledge from other topics remains reachable.
 * - Knowledge base entries relevant to the message are included.
 */

import { BRAND } from "../brand";
import { getAgentConfigOrGeneral, getUserProfile } from "../agents";
import { formatOverridesSection } from "./agent-overrides";
import { getMemoryContext } from "./memory";
import {
  getConversationContext,
  getMemoryUpdatesSince,
  searchMessages,
} from "./convex";
import { getKnowledgeContext } from "./knowledge-base";

const TIMEZONE = process.env.USER_TIMEZONE || "UTC";

export interface PromptContextOptions {
  userMessage: string;
  chatId: string;
  agentName: string;
  topicId?: number;
}

export interface PromptContext {
  /** Full assembled prompt for the Claude subprocess. */
  fullPrompt: string;
  /** Context string for callFallbackLLM() when Claude fails. */
  fallbackContext: string;
}

const INTENT_DETECTION_SECTION = `## INTENT DETECTION
If the user sets a goal, include: [GOAL: description | DEADLINE: deadline]
If a goal is completed, include: [DONE: partial match]
If the user wants to cancel/abandon a goal, include: [CANCEL: partial match]
If you learn a fact worth remembering, include: [REMEMBER: fact]
If the user wants to forget a stored fact, include: [FORGET: partial match]
These tags will be parsed automatically. Include them naturally in your response.`;

const IMAGE_CATALOGUING_SECTION = `## IMAGE CATALOGUING
When you analyze an image, include this tag at the END of your response:
[ASSET_DESC: concise 1-2 sentence description | tag1, tag2, tag3]
This is used for search/recall of images later. Be descriptive but concise.
Example: [ASSET_DESC: Birthday invitation with pink bunny holding a cupcake | birthday, invitation, kids]`;

/**
 * Format semantic search hits into a prompt section ("" when no hits).
 */
function formatSemanticResults(
  results: Awaited<ReturnType<typeof searchMessages>>
): string {
  if (results.length === 0) return "";
  const formatted = results
    .map((m) => {
      const time = m.created_at
        ? new Date(m.created_at).toLocaleString("de-DE", {
            timeZone: TIMEZONE,
            day: "numeric",
            month: "short",
            hour: "2-digit",
            minute: "2-digit",
          })
        : "";
      const speaker = m.role === "user" ? "User" : "Bot";
      return `[${time}] ${speaker}: ${m.content.substring(0, 300)}${m.content.length > 300 ? "..." : ""}`;
    })
    .join("\n");
  return `## SEMANTIC SEARCH RESULTS\nThese older messages matched the user's current query (semantic similarity):\n${formatted}`;
}

/**
 * Slim prompt for follow-up messages in a live --resume session
 * (docs/topic-sessions.md F-1/F-3). The Claude CLI session already holds the
 * system prompt, profile, memory, and conversation history, so we only send
 * what changed: current time, fresh semantic hits, and the message itself.
 */
export async function buildResumePrompt(
  opts: Pick<PromptContextOptions, "userMessage" | "chatId"> & {
    /** Session start (epoch ms) — memories created after this are injected. */
    sinceMs?: number;
  }
): Promise<string> {
  const { userMessage, chatId, sinceMs } = opts;

  const [semanticResults, memoryUpdates] = await Promise.all([
    searchMessages(chatId, userMessage, 5).catch(() => []),
    sinceMs ? getMemoryUpdatesSince(sinceMs).catch(() => "") : Promise.resolve(""),
  ]);
  const semanticCtx = formatSemanticResults(semanticResults);

  const now = new Date().toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const sections: string[] = [`## CURRENT TIME\n${now}`];
  if (memoryUpdates)
    sections.push(`## MEMORY UPDATES\nNew facts/goals since this session started:\n${memoryUpdates}`);
  if (semanticCtx) sections.push(semanticCtx);
  sections.push(`## USER MESSAGE\n${userMessage}`);
  return sections.join("\n\n---\n\n");
}

/**
 * Build the full prompt + fallback context for one user message.
 * All context sources are fetched in parallel.
 */
export async function buildPromptContext(
  opts: PromptContextOptions
): Promise<PromptContext> {
  const { userMessage, chatId, agentName, topicId } = opts;
  const agentConfig = getAgentConfigOrGeneral(agentName);

  const [userProfile, memoryCtx, conversationCtx, semanticResults, knowledgeCtx] =
    await Promise.all([
      getUserProfile(),
      getMemoryContext(userMessage),
      // Topic-isolated: pass null (not undefined) for topic-less chats so the
      // General topic / DMs don't pull in forum-topic messages and vice versa.
      getConversationContext(chatId, 10, topicId ?? null),
      // Semantic search on every message — cross-topic by design.
      searchMessages(chatId, userMessage, 5).catch(() => []),
      getKnowledgeContext(userMessage).catch(() => ""),
    ]);

  const semanticCtx = formatSemanticResults(semanticResults);

  const now = new Date().toLocaleString("en-US", {
    timeZone: TIMEZONE,
    weekday: "long",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });

  const sections: string[] = [];
  sections.push(
    agentConfig?.systemPrompt ??
      `You are ${BRAND.name}, a personal AI assistant. Be concise, direct, and helpful.`
  );
  const overridesSection = formatOverridesSection(agentName);
  if (overridesSection) sections.push(overridesSection);
  if (userProfile) sections.push(`## USER PROFILE\n${userProfile}`);
  sections.push(`## CURRENT TIME\n${now}`);
  if (memoryCtx) sections.push(`## MEMORY\n${memoryCtx}`);
  if (knowledgeCtx) sections.push(`## KNOWLEDGE BASE\n${knowledgeCtx}`);
  if (conversationCtx) sections.push(`## RECENT CONVERSATION\n${conversationCtx}`);
  if (semanticCtx) sections.push(semanticCtx);
  sections.push(INTENT_DETECTION_SECTION);
  sections.push(IMAGE_CATALOGUING_SECTION);
  sections.push(`## USER MESSAGE\n${userMessage}`);

  const fullPrompt = sections.join("\n\n---\n\n");

  const fallbackParts: string[] = [];
  if (overridesSection) fallbackParts.push(overridesSection);
  if (userProfile) fallbackParts.push(`## USER PROFILE\n${userProfile}`);
  if (memoryCtx) fallbackParts.push(`## MEMORY (facts & goals)\n${memoryCtx}`);
  if (knowledgeCtx) fallbackParts.push(`## KNOWLEDGE BASE\n${knowledgeCtx}`);
  if (conversationCtx) fallbackParts.push(`## RECENT CONVERSATION\n${conversationCtx}`);
  if (semanticCtx) fallbackParts.push(semanticCtx);
  const fallbackContext = fallbackParts.join("\n\n");

  return { fullPrompt, fallbackContext };
}
