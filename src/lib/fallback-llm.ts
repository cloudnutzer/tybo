import { OPENROUTER_APP_HEADERS } from "../brand";
import { reserveBudget, settleBudget } from "./daily-budget";
import { checkAborted, executionSignal, currentExecution } from "./execution-context";
/**
 * Go - Fallback LLM Chain with MCP Tool Access
 *
 * When the primary Claude subprocess fails or times out, fall back to:
 * 1. Kimi K3 via OpenRouter (moonshotai/kimi-k3, provider pinned) — best quality
 * 2. Opus 5 via Claude CLI (claude-opus-5[1m], effort high) — same subscription
 * 3. OpenRouter (cloud - any model)
 * 4. Ollama (local) — offline last resort
 *
 * Tiers 1-3 are skipped if FALLBACK_OFFLINE_ONLY=true.
 * Kimi K3 can be disabled with FALLBACK_K3=false (it costs real money
 * per call — $3/$15 per 1M tokens, thinking tokens billed as output).
 *
 * If MCPManager is active, fallback LLMs get full tool access
 * via OpenAI-compatible function calling (not the Opus tier — the CLI
 * brings its own tools). Since PRD Phase 2 the tool set is the merged
 * gateway: MCP servers + tybo built-ins (Firecrawl REST backup, Apify,
 * Telegram document/voice, Cloudflare read-only) — all served through
 * mcpManager.getOpenAITools() / mcpManager.callTool().
 */

import { mcpManager, type OpenAITool } from "./mcp-client";
import { callClaude } from "./claude";
import { TELEGRAM_FORMAT_RULES } from "./telegram";
import { getSettings, type Settings } from "./settings";

const OPENROUTER_API_KEY = () => process.env.OPENROUTER_API_KEY || "";
// Vorrang: config/settings.json (fallback.*) vor .env vor Standard. offlineOnly
// mit ??, damit ein gespeichertes false ein FALLBACK_OFFLINE_ONLY=true schlaegt.
export const OPENROUTER_MODEL = () => describeFallback(getSettings()).openrouterModel.value;
export const OLLAMA_MODEL = () => describeFallback(getSettings()).ollamaModel.value;
export const FALLBACK_OFFLINE_ONLY = () => describeFallback(getSettings()).offlineOnly.value;

type Sourced<T> = { value: T; source: "settings" | "env" | "code" };

/** Die drei Fallback-Werte mit Quelle (WebUI, Issue #36); die Getter oben lesen daraus. */
export function describeFallback(settings: Settings): {
  openrouterModel: Sourced<string>;
  ollamaModel: Sourced<string>;
  offlineOnly: Sourced<boolean>;
} {
  const fb = settings.fallback;
  const pick = (fromSettings: string | undefined, env: string | undefined, fallback: string): Sourced<string> =>
    fromSettings !== undefined
      ? { value: fromSettings, source: "settings" }
      : env
        ? { value: env, source: "env" }
        : { value: fallback, source: "code" };
  const offlineEnv = process.env.FALLBACK_OFFLINE_ONLY;
  return {
    openrouterModel: pick(fb?.openrouterModel, process.env.OPENROUTER_MODEL, "minimax/minimax-m2.7"),
    ollamaModel: pick(fb?.ollamaModel, process.env.OLLAMA_MODEL, "qwen3:8b"),
    offlineOnly:
      fb?.offlineOnly !== undefined
        ? { value: fb.offlineOnly, source: "settings" }
        : offlineEnv
          ? { value: offlineEnv === "true", source: "env" }
          : { value: false, source: "code" },
  };
}

// Tier 1: Kimi K3 ueber OpenRouter. Einheitspreis bei allen Providern,
// aber 4x Speed-Unterschied — deshalb Fireworks pinnen (allow_fallbacks
// laesst OpenRouter ausweichen, wenn Fireworks down ist). K3 denkt immer;
// Thinking-Tokens zaehlen als Output. Abschaltbar via FALLBACK_K3=false.
const K3_MODEL = () => process.env.FALLBACK_K3_MODEL || "moonshotai/kimi-k3";
const K3_ENABLED = () => process.env.FALLBACK_K3 !== "false";
const K3_PROVIDER = () => process.env.FALLBACK_K3_PROVIDER || "Fireworks";
// Tier 2: Opus 5 mit 1M-Kontext auf effort "high" (xhigh geht seit 30.8.2026 auch
// auf Opus 5, im Fallback-Pfad bewusst nicht, Latenz).
const CLAUDE_FALLBACK_MODEL = () =>
  process.env.FALLBACK_CLAUDE_MODEL || "claude-opus-5[1m]";
const CLAUDE_FALLBACK_EFFORT = () => process.env.FALLBACK_CLAUDE_EFFORT || "high";

export type FallbackSource = "kimi-k3" | "opus5" | "openrouter" | "ollama" | "none";

export interface FallbackResult {
  text: string;
  source: FallbackSource;
  /** Model ID that actually answered; absent when source is "none". */
  model?: string;
}

/** Fallback text as the user sees it: with the "responded via" tag when a backend answered. */
export function formatFallbackReply(result: FallbackResult): string {
  return result.source !== "none" ? `${result.text}\n\n_(responded via ${result.source})_` : result.text;
}

/**
 * Try fallback LLMs and return response with source tag appended.
 * The tag tells the user which backend actually responded.
 *
 * @param context - Pre-built context string (memory, conversation history, profile, semantic search)
 *                  that gets injected into the system prompt so fallback models have full awareness.
 */
export async function callFallbackLLM(prompt: string, context?: string): Promise<string> {
  return formatFallbackReply(await callFallbackLLMWithSource(prompt, context));
}

/**
 * Try fallback LLMs and return both the response text and which backend responded.
 */
export async function callFallbackLLMWithSource(
  prompt: string,
  context?: string
): Promise<FallbackResult> {
  // Get tools if available (MCP + built-ins, OpenAI function calling format)
  const tools =
    mcpManager.isReady && mcpManager.toolCount > 0
      ? mcpManager.getOpenAITools()
      : undefined;

  if (tools) {
    console.log(
      `[Fallback] Tools available: ${mcpManager.toolCount} (MCP + built-ins)`
    );
  }

  checkAborted();
  // Tier 1: Kimi K3 via OpenRouter — skip if offline-only, disabled, or no key
  if (K3_ENABLED() && OPENROUTER_API_KEY() && !FALLBACK_OFFLINE_ONLY()) {
    try {
      console.log(
        `🔄 Fallback: trying Kimi K3 (${K3_MODEL()})${tools ? ` with ${tools.length} tools` : ""}...`
      );
      const text = await callK3(prompt, context, tools);
      if (text) {
        console.log(`✅ Kimi K3 responded (${K3_MODEL()})`);
        return { text, source: "kimi-k3", model: K3_MODEL() };
      }
    } catch (err) {
      console.error("❌ Kimi K3 failed:", err);
    }
  }

  checkAborted();
  // Tier 2: Opus 5 via Claude CLI — the primary already failed, but model-
  // specific throttles differ, so a second Claude model is worth one attempt.
  if (!FALLBACK_OFFLINE_ONLY()) {
    try {
      console.log(
        `🔄 Fallback: trying Claude CLI (${CLAUDE_FALLBACK_MODEL()}, effort ${CLAUDE_FALLBACK_EFFORT()})...`
      );
      const promptWithContext = context ? `${context}\n\n---\n\n${prompt}` : prompt;
      const result = await callClaude({
        prompt: promptWithContext,
        model: CLAUDE_FALLBACK_MODEL(),
        effort: CLAUDE_FALLBACK_EFFORT(),
        timeoutMs: 300_000,
        abortKey: currentExecution()?.key,
      });
      if (!result.isError && result.text) {
        console.log(`✅ Opus 5 responded (${CLAUDE_FALLBACK_MODEL()})`);
        return { text: result.text, source: "opus5", model: CLAUDE_FALLBACK_MODEL() };
      }
      console.error(
        `❌ Opus 5 returned error: ${result.timedOut ? "timeout (300s), killed" : result.text?.substring(0, 150) || "(empty)"}`
      );
    } catch (err) {
      console.error("❌ Opus 5 CLI failed:", err);
    }
  }

  checkAborted();
  // Tier 3: OpenRouter (cloud) — skip if FALLBACK_OFFLINE_ONLY is set
  if (OPENROUTER_API_KEY() && !FALLBACK_OFFLINE_ONLY()) {
    // Einmal auflösen: ein Dateiwechsel während der Anfrage darf die
    // Herkunft dieser Antwort nicht nachträglich ändern.
    const model = OPENROUTER_MODEL();
    try {
      console.log(
        `🔄 Fallback: trying OpenRouter (${model})${tools ? ` with ${tools.length} tools` : ""}...`
      );

      const text = await callWithToolLoop(
        "https://openrouter.ai/api/v1/chat/completions",
        OPENROUTER_API_KEY(),
        model,
        prompt,
        tools,
        { ...OPENROUTER_APP_HEADERS },
        10,
        context
      );

      if (text) {
        console.log(`✅ OpenRouter responded (${model})`);
        return { text, source: "openrouter", model };
      }
    } catch (err) {
      console.error("❌ OpenRouter failed:", err);
    }
  } else if (FALLBACK_OFFLINE_ONLY()) {
    console.log("⏭️ Skipping OpenRouter (FALLBACK_OFFLINE_ONLY=true)");
  }

  checkAborted();
  // Tier 4: Ollama (local) — OpenAI-compatible endpoint for tool calling
  const ollamaModel = OLLAMA_MODEL();
  try {
    console.log(
      `🔄 Fallback: trying Ollama (${ollamaModel})${tools ? ` with ${tools.length} tools` : ""}...`
    );

    const text = await callWithToolLoop(
      "http://localhost:11434/v1/chat/completions",
      "", // No auth for Ollama
      ollamaModel,
      prompt,
      tools,
      undefined,
      10,
      context
    );

    if (text) {
      console.log(`✅ Ollama responded (${ollamaModel})`);
      return { text, source: "ollama", model: ollamaModel };
    }
  } catch (err) {
    console.error("❌ Ollama failed (is it running?):", err);
  }

  return {
    text: "I'm having trouble connecting to all my backends right now. Please try again in a few minutes.",
    source: "none",
  };
}

/**
 * Direct Kimi K3 call via OpenRouter (provider pinned, see K3_PROVIDER).
 * Used by the fallback chain (tier 1) and the /k3 Telegram command.
 * K3 thinks long — generous timeout and token budget, so the reasoning
 * phase doesn't eat the whole completion window.
 */
export async function callK3(
  prompt: string,
  context?: string,
  tools?: OpenAITool[]
): Promise<string | null> {
  const effectiveTools =
    tools ??
    (mcpManager.isReady && mcpManager.toolCount > 0
      ? mcpManager.getOpenAITools()
      : undefined);
  return callWithToolLoop(
    "https://openrouter.ai/api/v1/chat/completions",
    OPENROUTER_API_KEY(),
    K3_MODEL(),
    prompt,
    effectiveTools,
    { ...OPENROUTER_APP_HEADERS },
    10,
    context,
    {
      timeoutMs: 240_000,
      maxTokens: 16000,
      extraBody: {
        provider: { order: [K3_PROVIDER()], allow_fallbacks: true },
      },
    }
  );
}

// ============================================================
// TOOL CALLING LOOP — Works with any OpenAI-compatible API
// ============================================================

/**
 * Call an OpenAI-compatible API with optional function calling.
 * Handles the tool call loop: model requests tool → execute → feed result → repeat.
 */
async function callWithToolLoop(
  url: string,
  apiKey: string,
  model: string,
  prompt: string,
  tools?: OpenAITool[],
  extraHeaders?: Record<string, string>,
  maxIterations = 10,
  context?: string,
  opts?: {
    timeoutMs?: number;
    maxTokens?: number;
    extraBody?: Record<string, unknown>;
  }
): Promise<string | null> {
  const timeoutMs = opts?.timeoutMs ?? 60000;
  const maxTokens = opts?.maxTokens ?? 4096;
  const userName = process.env.USER_NAME || "User";
  const userTimezone = process.env.USER_TIMEZONE || "UTC";
  const botName = process.env.BOT_NAME || "Go";

  const now = new Date();
  const localTime = now.toLocaleString("en-US", {
    timeZone: userTimezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const contextBlock = context
    ? `\n\n${context}\n\nUse the context above to answer the user's message. You have access to their conversation history, memory, and profile.`
    : "";

  const systemPrompt = `You are ${botName}, ${userName}'s AI assistant on Telegram.
Current time: ${localTime} (${userTimezone})
Processing: Fallback mode (primary AI unavailable)

${tools && tools.length > 0 ? `You have ${tools.length} tools available (MCP servers + built-in REST tools: web search/scraping via Firecrawl, Apify actors, sending files or voice messages to the user via Telegram, Cloudflare deployment status). Use them when the user asks to interact with external services. Call tools as needed — you have full access.` : ""}${contextBlock}

Keep responses concise (Telegram-friendly). Be helpful with what you can do.

${TELEGRAM_FORMAT_RULES}`;

  const messages: any[] = [
    { role: "system", content: systemPrompt },
    { role: "user", content: prompt },
  ];

  for (let i = 0; i < maxIterations; i++) {
    checkAborted();
    const body: any = {
      model,
      messages,
      max_tokens: maxTokens,
      ...opts?.extraBody,
    };

    // Only include tools if available and model might support them
    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...extraHeaders,
    };
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const reservation = apiKey ? reserveBudget("openrouter", Number(process.env.FALLBACK_REQUEST_RESERVATION_USD || "1")) : undefined;
    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: executionSignal(timeoutMs),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error(
        `[Fallback] API error ${response.status}: ${errText.substring(0, 200)}`
      );

      // If tools caused the error, retry without tools
      if (tools && tools.length > 0 && i === 0) {
        console.log("[Fallback] Retrying without tools...");
        return callWithToolLoop(
          url,
          apiKey,
          model,
          prompt,
          undefined,
          extraHeaders,
          1,
          context,
          opts
        );
      }
      return null;
    }

    const data = (await response.json()) as any;
    if (reservation) settleBudget(reservation, typeof data.usage?.cost === "number" ? data.usage.cost : undefined);
    const choice = data.choices?.[0];
    if (!choice) return null;

    const msg = choice.message;

    // No tool calls → return the text response
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      // Some models put content in msg.content, others in msg.reasoning
      return msg.content || msg.reasoning || "";
    }

    // Tool calls requested — execute them and continue
    console.log(
      `[Fallback] Tool calls: ${msg.tool_calls.map((tc: any) => tc.function?.name).join(", ")}`
    );

    // Add assistant message with tool_calls to conversation
    messages.push(msg);

    // Execute each tool call
    for (const tc of msg.tool_calls) {
      checkAborted();
      const fnName = tc.function?.name;
      let fnArgs: Record<string, unknown> = {};

      try {
        fnArgs =
          typeof tc.function?.arguments === "string"
            ? JSON.parse(tc.function.arguments)
            : tc.function?.arguments || {};
      } catch {
        console.error(
          `[Fallback] Bad tool args for ${fnName}`
        );
      }

      const result = await mcpManager.callTool(fnName, fnArgs);

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result.content.substring(0, 4000), // Truncate large results
      });
    }
  }

  console.log("[Fallback] Max tool iterations reached");
  return null;
}
