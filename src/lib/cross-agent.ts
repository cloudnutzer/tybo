/**
 * Cross-Agent Invocation — Visible Agent-to-Agent Communication
 *
 * Parses [INVOKE:agent|question] tags from Claude responses,
 * executes them as visible messages from the target agent's bot.
 */

import type { BotRegistry } from "./bot-registry";
import { canInvokeAgent, formatCrossAgentContext } from "../agents/base";

export interface Invocation {
  targetAgent: string;
  question: string;
}

/** Extract all [INVOKE:agent|question] tags from text. Kennungen mit Bindestrich (projekt-planer) zaehlen mit (Issue #49). */
export function parseInvocationTags(text: string): Invocation[] {
  const pattern = /\[INVOKE:([\w-]+)\|([^\]]+)\]/g;
  const invocations: Invocation[] = [];
  let match;

  while ((match = pattern.exec(text)) !== null) {
    invocations.push({
      targetAgent: match[1].toLowerCase(),
      question: match[2].trim(),
    });
  }

  return invocations;
}

/** Return text with all [INVOKE:...] tags removed. */
export function stripInvocationTags(text: string): string {
  return text.replace(/\[INVOKE:[\w-]+\|[^\]]+\]/g, "").trim();
}

/** Reply budget (Buzz-Lehre): hoechstens budget Rueckfragen pro Antwort, der Rest entfaellt mit Log */
export function capInvocations(invocations: Invocation[], budget: number): Invocation[] {
  if (invocations.length <= budget) return invocations;
  console.warn(`[CrossAgent] ${invocations.length} invocations requested, capping at ${budget}`);
  return invocations.slice(0, budget);
}

/**
 * Was eine Rueckfrage je Kanal braucht (Issue #76): Tippt-Anzeige des
 * Ziel-Agenten, Claude-Aufruf als dieser Agent, Zustellen der Antwort.
 * Telegram stellt ueber den Bot des Agenten zu, die WebUI zusaetzlich als
 * eigene Nachricht mit Sprecher.
 */
export interface InvocationIO {
  typing(targetAgent: string): Promise<void>;
  call(prompt: string, targetAgent: string): Promise<string>;
  deliver(targetAgent: string, text: string): Promise<void>;
}

/**
 * Execute a cross-agent invocation, channel-neutral.
 *
 * 1. Validates permission via canInvokeAgent()
 * 2. Typing indicator of the target agent
 * 3. Calls Claude with target agent's config + cross-agent context
 * 4. Strips nested [INVOKE:] tags (no chains) and delivers the answer
 * 5. Returns response text for source agent to reference
 */
export async function executeInvocation(
  sourceAgent: string,
  invocation: Invocation,
  io: InvocationIO
): Promise<string | null> {
  const { targetAgent, question } = invocation;

  // Check permissions
  if (!canInvokeAgent(sourceAgent, targetAgent)) {
    console.log(
      `[CrossAgent] ${sourceAgent} cannot invoke ${targetAgent} — skipping`
    );
    return null;
  }

  console.log(
    `[CrossAgent] ${sourceAgent} → ${targetAgent}: "${question.substring(0, 60)}..."`
  );

  await io.typing(targetAgent);

  // Build the cross-agent prompt
  const crossPrompt = formatCrossAgentContext(
    sourceAgent,
    targetAgent,
    question,
    question
  );

  // Call Claude as the target agent
  const response = await io.call(crossPrompt, targetAgent);

  // Strip any nested invocation tags (prevent infinite chains)
  const cleanResponse = stripInvocationTags(response);

  await io.deliver(targetAgent, cleanResponse);

  return cleanResponse;
}

/**
 * Execute a visible cross-agent invocation in Telegram: typing and answer
 * from the target agent's bot in the same thread. onDelivered (optional)
 * runs after the answer went out, e.g. to store it for the WebUI.
 */
export async function executeVisibleInvocation(
  registry: BotRegistry,
  sourceAgent: string,
  invocation: Invocation,
  chatId: string | number,
  threadId: number | undefined,
  callClaudeFn: (
    userMessage: string,
    chatId: string,
    agentName: string,
    topicId?: number
  ) => Promise<string>,
  onDelivered?: (targetAgent: string, text: string) => Promise<void>
): Promise<string | null> {
  return executeInvocation(sourceAgent, invocation, {
    typing: (targetAgent) => registry.sendTypingAsAgent(targetAgent, chatId, threadId),
    call: (prompt, targetAgent) => callClaudeFn(prompt, String(chatId), targetAgent, threadId),
    deliver: async (targetAgent, text) => {
      await registry.sendAsAgent(targetAgent, chatId, text, { threadId });
      await onDelivered?.(targetAgent, text);
    },
  });
}
