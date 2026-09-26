import { OPENROUTER_APP_HEADERS } from "../brand";
import { checkAborted, executionSignal } from "./execution-context";
/**
 * Resilient Anthropic Client — Auto-Failover to OpenRouter
 *
 * When Anthropic API fails (credit depleted, rate limited, auth error),
 * automatically routes through OpenRouter's Anthropic-compatible endpoint.
 * Same SDK, same types, same tool format — just a different URL.
 *
 * OpenRouter is OPTIONAL. If OPENROUTER_API_KEY is not set, errors
 * propagate normally (no failover). This keeps tybo usable for
 * community members who don't have an OpenRouter account.
 *
 * Re-checks Anthropic availability every 15 minutes so it automatically
 * recovers when credits are topped up or rate limits expire.
 *
 * Usage:
 *   import { getResilientClient, createResilientMessage } from "./resilient-client";
 *   const client = getResilientClient();
 *   const response = await createResilientMessage({ model, messages, ... });
 */

import Anthropic from "@anthropic-ai/sdk";

// ============================================================
// STATE
// ============================================================

let anthropicClient: Anthropic | null = null;
let openRouterClient: Anthropic | null = null;
let anthropicAvailable = true;
let lastCheckTime = 0;

const RETRY_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// HTTP status codes that indicate credit/auth/capacity issues
const CREDIT_ERROR_CODES = [400, 401, 402, 429, 529];

// Error message patterns that indicate credit/auth issues
const CREDIT_ERROR_PATTERNS = [
  /credit balance is too low/i,
  /insufficient_quota/i,
  /rate_limit/i,
  /overloaded/i,
  /authentication/i,
  /invalid.*api.*key/i,
  /billing/i,
];

// ============================================================
// CLIENT FACTORIES
// ============================================================

function getAnthropicClient(): Anthropic {
  if (!anthropicClient) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY not set");
    }
    anthropicClient = new Anthropic({ apiKey });
  }
  return anthropicClient;
}

function getOpenRouterClient(): Anthropic {
  if (!openRouterClient) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) {
      throw new Error("OPENROUTER_API_KEY not set — cannot failover");
    }
    openRouterClient = new Anthropic({
      apiKey,
      baseURL: "https://openrouter.ai/api",
      defaultHeaders: { ...OPENROUTER_APP_HEADERS },
    });
  }
  return openRouterClient;
}

// ============================================================
// ERROR DETECTION
// ============================================================

/**
 * Check if an error indicates a credit/auth/capacity issue.
 */
export function isCreditError(err: any): boolean {
  // Check HTTP status code
  if (err?.status && CREDIT_ERROR_CODES.includes(err.status)) {
    return true;
  }

  // Check error message patterns
  const message = err?.message || err?.error?.message || String(err);
  for (const pattern of CREDIT_ERROR_PATTERNS) {
    if (pattern.test(message)) {
      return true;
    }
  }

  return false;
}

// ============================================================
// STATE MANAGEMENT
// ============================================================

/**
 * Mark Anthropic as unavailable. Will be re-checked after RETRY_INTERVAL_MS.
 */
export function markAnthropicDown(): void {
  if (anthropicAvailable) {
    console.log("[Resilient] Anthropic marked DOWN — routing via OpenRouter");
  }
  anthropicAvailable = false;
  lastCheckTime = Date.now();
}

/**
 * Check if Anthropic is currently available.
 * Periodically re-enables to test if credits were topped up.
 */
export function isAnthropicAvailable(): boolean {
  if (!anthropicAvailable) {
    const elapsed = Date.now() - lastCheckTime;
    if (elapsed > RETRY_INTERVAL_MS) {
      console.log("[Resilient] Re-checking Anthropic availability...");
      anthropicAvailable = true;
    }
  }
  return anthropicAvailable;
}

// ============================================================
// MODEL MAPPING
// ============================================================

/**
 * Map model ID for the current provider.
 * OpenRouter requires "anthropic/" prefix on Claude models.
 */
export function getModelForProvider(model: string): string {
  if (!anthropicAvailable && !model.startsWith("anthropic/")) {
    return `anthropic/${model}`;
  }
  return model;
}

/**
 * Check if web_search tool should be stripped (OpenRouter doesn't support it).
 */
export function shouldStripWebSearch(): boolean {
  return !anthropicAvailable;
}

// ============================================================
// RESILIENT CLIENT
// ============================================================

/**
 * Get the appropriate Anthropic SDK client (direct or OpenRouter-pointed).
 */
export function getResilientClient(): Anthropic {
  if (isAnthropicAvailable()) {
    return getAnthropicClient();
  }

  // Only failover if OpenRouter is configured
  if (process.env.OPENROUTER_API_KEY) {
    return getOpenRouterClient();
  }

  // No OpenRouter — use Anthropic anyway (will error, but that's expected)
  return getAnthropicClient();
}

/**
 * Create a message with automatic failover.
 * Tries Anthropic first, falls back to OpenRouter on credit/auth errors.
 */
export async function createResilientMessage(
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  checkAborted();
  // Already known to be down — go straight to OpenRouter
  if (!anthropicAvailable) {
    if (process.env.OPENROUTER_API_KEY) {
      return callOpenRouter(params);
    }
    // No OpenRouter configured — try Anthropic anyway
    return getAnthropicClient().messages.create(params, { signal: executionSignal(300_000) });
  }

  // Try Anthropic first
  try {
    const client = getAnthropicClient();
    const response = await client.messages.create(params, { signal: executionSignal(300_000) });
    return response;
  } catch (err: any) {
    if (isCreditError(err) && process.env.OPENROUTER_API_KEY) {
      markAnthropicDown();
      console.log(
        `[Resilient] Anthropic failed (${err.status || err.message}), retrying via OpenRouter...`
      );
      return callOpenRouter(params);
    }
    throw err;
  }
}

// ============================================================
// OPENROUTER CALLER
// ============================================================

async function callOpenRouter(
  params: Anthropic.MessageCreateParamsNonStreaming
): Promise<Anthropic.Message> {
  const client = getOpenRouterClient();

  const adjustedParams = { ...params };

  // Add anthropic/ prefix if needed
  if (!adjustedParams.model.startsWith("anthropic/")) {
    adjustedParams.model = `anthropic/${adjustedParams.model}`;
  }

  // Strip web_search tool (Anthropic-only)
  if (adjustedParams.tools) {
    adjustedParams.tools = adjustedParams.tools.filter(
      (t: any) => t.type !== "web_search_20250305"
    );
  }

  return client.messages.create(adjustedParams, { signal: executionSignal(300_000) });
}

// ============================================================
// ENV HELPERS (for Agent SDK)
// ============================================================

/**
 * Get environment variables for routing Agent SDK through OpenRouter.
 */
export function getOpenRouterEnv(): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: "https://openrouter.ai/api",
    ANTHROPIC_AUTH_TOKEN: process.env.OPENROUTER_API_KEY || "",
    ANTHROPIC_API_KEY: "",
  };
}
