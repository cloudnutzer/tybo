/**
 * Model Router — pinned to a single model by design.
 *
 * Historically this classified messages into Haiku/Sonnet/Opus tiers.
 * Per user decision (docs/topic-sessions.md, "Immer das beste Modell"), all
 * tiers now map to the same model and classifyComplexity() always returns
 * "opus". The tier structure is kept because the credit guard and the
 * streaming-progress UX (bot.ts: haiku = instant, opus = streaming) hang
 * off it — the tier no longer selects a model, only the UX path.
 *
 * The legacy TOOL_PATTERNS/COMPLEX_PATTERNS below are unused by the
 * classifier and kept only for reference should tiering ever return.
 */

// ============================================================
// TYPES
// ============================================================

export type ModelTier = "haiku" | "sonnet" | "opus";

// Standard seit 2026-09-22: Opus 5.5 mit effort high (claude.ts defaultEffort).
export const MODEL_IDS: Record<ModelTier, string> = {
  haiku: "claude-opus-5-5",
  sonnet: "claude-opus-5-5",
  opus: "claude-opus-5-5",
};

// Cost per million tokens (input / output) — all tiers map to claude-opus-5-5 ($4/$20)
export const MODEL_COSTS: Record<ModelTier, { input: number; output: number }> =
  {
    haiku: { input: 4.0, output: 20.0 },
    sonnet: { input: 4.0, output: 20.0 },
    opus: { input: 4.0, output: 20.0 },
  };

// ============================================================
// PATTERNS
// ============================================================

// Patterns that indicate tool usage is needed (→ Sonnet)
const TOOL_PATTERNS = [
  /\b(wordpress|wp|blog post|website|theme|deploy|rollback)\b/i,
  /\b(publish|staging|production)\b.*\b(post|page|site)\b/i,
  /\b(send|reply|forward|draft)\b.*\b(email|message|whatsapp|linkedin)\b/i,
  /\b(email|message|whatsapp|linkedin)\b.*\b(send|reply|forward|draft)\b/i,
  /\b(create|add|update|delete|move|edit)\b.*\b(task|project|page|post|event)\b/i,
  /\b(task|project|page|post|event)\b.*\b(create|add|update|delete|move|edit)\b/i,
  /\b(schedule|book|block|cancel)\b.*\b(meeting|call|event|time)\b/i,
  /\b(github|pr|pull request|issue|commit|push|merge)\b/i,
  /\b(community|members|analytics)\b/i,
  /\b(notion|database)\b.*\b(query|search|update|create)\b/i,
];

// Patterns that indicate complex reasoning (→ Opus)
const COMPLEX_PATTERNS = [
  /\b(analyze|analysis|evaluate|compare|contrast)\b/i,
  /\b(strategy|strategic|plan|roadmap|architecture)\b/i,
  /\b(write|draft|compose) .{50,}/i, // long writing requests
  /\b(research|investigate|deep dive)\b/i,
  /\b(decide|decision|should I|pros and cons)\b/i,
  /\b(explain in detail|why should|how does .{50,})\b/i, // complex explanations
  /\b(refactor|redesign|optimize|improve)\b/i,
  /\b(sponsor|partnership|brand deal|negotiate)\b/i,
  /\b(content strategy|video idea|script)\b/i,
];

// ============================================================
// CLASSIFIER
// ============================================================

/**
 * Classify message complexity to select the right model tier.
 * Zero overhead — pure regex matching, no API calls.
 *
 * Cost-optimized: defaults to Haiku. Only escalates when
 * tool usage or deep reasoning is clearly needed.
 */
export function classifyComplexity(message: string): ModelTier {
  // Always use Opus tier (streaming progress UX for all messages)
  return "opus";
}

/**
 * Map a model ID for OpenRouter (adds "anthropic/" prefix).
 */
export function toOpenRouterModel(model: string): string {
  if (model.startsWith("anthropic/")) return model;
  return `anthropic/${model}`;
}

/**
 * Select model ID for a message, with optional budget-based downgrade.
 */
export function selectModelForMessage(
  message: string,
  budgetRemaining?: number
): { tier: ModelTier; model: string } {
  const tier = classifyComplexity(message);

  return {
    tier,
    model: MODEL_IDS[tier],
  };
}
