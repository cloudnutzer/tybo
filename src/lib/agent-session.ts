import { authorizeTool } from "./tools/registry";
import { currentExecution, checkAborted, runExecution } from "./execution-context";
import { reserveBudget, settleBudget, remainingBudget } from "./daily-budget";
import { shellSecurityHook } from "./sdk-security";
/**
 * Agent Session — Claude Agent SDK Session Manager
 *
 * Provides full Claude Code capabilities on VPS via the Agent SDK:
 * MCP servers, skills, hooks, CLAUDE.md — all loaded from the user's
 * project settings via settingSources.
 *
 * Community version: no in-process MCP servers. Users configure their
 * own MCP servers in their Claude Code settings, and the Agent SDK
 * loads them automatically via settingSources: ["user", "project"].
 *
 * Full capabilities: Skills, hooks, CLAUDE.md, MCP servers, all built-in
 * tools — everything from Claude Code desktop, running on VPS.
 *
 * Usage: processWithAgentSDK(userMessage, chatId, ctx, resumeState?)
 */

import { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import { selectModelForMessage, toOpenRouterModel, MODEL_IDS } from "./model-router";
import * as creditGuard from "./credit-guard";
import { AskUserSignal } from "./anthropic-processor";
import { buildTaskKeyboard } from "./task-queue";
import { callFallbackLLM } from "./fallback-llm";
import { TELEGRAM_FORMAT_RULES } from "./telegram";
import {
  isAnthropicAvailable,
  markAnthropicDown,
  isCreditError,
  getOpenRouterEnv,
} from "./resilient-client";
import * as db from "./convex";
import type { Context } from "grammy";
import { subprocessEnv } from "./subprocess-env";

/** SDK-Aufruf; nur Tests ersetzen ihn (setQueryForTests), es startet dann kein Claude */
let query: typeof sdkQuery = sdkQuery;

/** Nur für Tests: SDK-Aufruf durch eine Attrappe ersetzen, null stellt zurück. */
export function setQueryForTests(fn: typeof sdkQuery | null): void {
  query = fn ?? sdkQuery;
}

/**
 * Umgebung des SDK-Subprozesses (Issue #54): wie bei der CLI ohne Geheimnisse
 * außer den Freigaben. Gezielte Ausnahme für den OpenRouter-Fallback:
 * getOpenRouterEnv() setzt OPENROUTER_API_KEY als ANTHROPIC_AUTH_TOKEN, der
 * Schlüssel selbst bleibt unter seinem Namen draußen.
 */
export function sdkEnv(useOpenRouter: boolean, cwd: string = process.cwd()): Record<string, string> {
  return {
    ...subprocessEnv({ cwd, conversationKey: currentExecution()?.key }),
    ...(useOpenRouter
      ? getOpenRouterEnv()
      : { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || "" }),
    HOME: process.env.HOME || "/root",
    // Ensure bun is in PATH for VPS environments
    PATH: `${process.env.HOME || "/root"}/.bun/bin:/usr/local/bin:/usr/bin:/bin`,
  };
}

/**
 * Start des SDK-Subprozesses: bun ohne automatisches Laden der .env
 * (--no-env-file), sonst holte Bun die gefilterten Geheimnisse aus der .env
 * im Arbeitsverzeichnis zurück (Issue #54).
 */
export function sdkProcessOptions(
  useOpenRouter: boolean,
  cwd: string = process.cwd(),
): Pick<Options, "cwd" | "executable" | "executableArgs" | "env"> {
  return {
    cwd,
    executable: "bun",
    executableArgs: ["--no-env-file"],
    env: sdkEnv(useOpenRouter, cwd),
  };
}

// ============================================================
// TYPES
// ============================================================

/**
 * Resume state for continuing from ask_user pause via Agent SDK.
 * Uses session_id for resume instead of messages snapshot.
 */
export interface AgentResumeState {
  taskId: string;
  sessionId: string;
  userChoice: string;
  originalPrompt: string;
}

// ============================================================
// BUDGET TRACKING
// ============================================================

export const getDailyBudgetRemaining = remainingBudget;

// ============================================================
// DYNAMIC CONTEXT
// ============================================================

function buildDynamicContext(): string {
  const userName = process.env.USER_NAME || "User";
  const userTimezone = process.env.USER_TIMEZONE || "UTC";

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

  return `
TELEGRAM CONTEXT:
You are responding via Telegram to ${userName}. Keep messages concise (max 2-3 short paragraphs).
Current time: ${localTime} (${userTimezone})

${TELEGRAM_FORMAT_RULES}

VOICE & STYLE:
- Direct, conversational, slightly casual. Never corporate or generic.
- Keep responses concise — this is Telegram, not an essay.
- No excessive emojis. One per message max, only if natural.

TOOL RULES:
- Use tools proactively — don't just describe what you could do, DO it.
- Use AskUserQuestion BEFORE taking irreversible actions.
- AskUserQuestion pauses the conversation and sends buttons to Telegram.

LIMITATIONS (CRITICAL):
- You CANNOT modify your own code, server, or configuration
- You CANNOT restart services, deploy updates, or fix bugs in yourself
- If something is broken, tell the user clearly — do NOT promise to fix it yourself
- Never say "I'll look into that", "Let me debug this", or "I'll fix that" about your own systems

INTENT DETECTION - Include at END of response when relevant:
- [GOAL: goal text | DEADLINE: optional]
- [DONE: what was completed] — ONLY when user explicitly states they finished something. Use the full goal text.
- [CANCEL: partial match]
- [REMEMBER: fact]
- [FORGET: partial match]`;
}

// ============================================================
// PROGRESS UPDATES
// ============================================================

async function sendProgress(ctx: Context, text: string): Promise<void> {
  try {
    await ctx.reply(text, { parse_mode: "HTML" });
  } catch {
    await ctx.reply(text).catch(() => {});
  }
}

// ============================================================
// MAIN PROCESSOR
// ============================================================

/**
 * Process a message using the Agent SDK.
 * Drop-in replacement for processWithAnthropic() on VPS.
 *
 * The Agent SDK spawns a Claude Code subprocess that loads:
 * - User's CLAUDE.md (project instructions)
 * - User's MCP servers (from Claude Code settings)
 * - User's skills and hooks
 * - Built-in tools (Read, Write, Bash, WebSearch, etc.)
 */
async function processWithAgentSDKUnlocked(
  userMessage: string,
  chatId: string,
  ctx: Context,
  resumeState?: AgentResumeState,
  onCallInitiated?: (conversationId: string) => void
): Promise<string> {
  const startTime = Date.now();

  // Check daily budget
  const budgetRemaining = getDailyBudgetRemaining();
  if (budgetRemaining <= 0) {
    console.log(`[COST] Daily budget exceeded`);
    return "Daily API budget reached. I'll be back at full capacity tomorrow. For urgent requests, try again when the local machine is online.";
  }

  // Select model tier based on complexity, then clamp to the credit cap if the
  // monthly Agent SDK credit is exhausted (subscription, lowcost mode). Fail-open.
  const baseSelection = selectModelForMessage(userMessage, budgetRemaining);
  const tier = await creditGuard.capTier(baseSelection.tier);
  const selectedModel = MODEL_IDS[tier];
  const useOpenRouter = !isAnthropicAvailable() && !!process.env.OPENROUTER_API_KEY;
  const model = useOpenRouter ? toOpenRouterModel(selectedModel) : selectedModel;
  console.log(`[SDK] Model: ${tier.toUpperCase()} (${model})${useOpenRouter ? " [via OpenRouter]" : ""}`);

  // Load conversation context from Supabase
  let contextStr = "";
  try {
    const conversationHistory = await db.getConversationContext(
      chatId,
      10
    );
    const persistentMemory = await db.getMemoryContext();
    contextStr = persistentMemory + conversationHistory;
  } catch (err) {
    console.error("Failed to load conversation context:", err);
  }

  // Build the prompt
  let prompt: string;
  if (resumeState) {
    console.log(
      `[SDK] Resuming session ${resumeState.sessionId}: "${resumeState.userChoice}"`
    );
    prompt = `User chose: ${resumeState.userChoice}`;
  } else {
    prompt = userMessage;
    if (contextStr) {
      prompt = `[Previous conversation context]\n${contextStr}\n\n[Current message]\n${userMessage}`;
    }
  }

  const reservedAmount = Math.min(getDailyBudgetRemaining(), 2.0);
  const reservation = reserveBudget("agent-sdk", reservedAmount);
  // Build query options
  const options: Options = {
    model,
    maxTurns: 15,
    maxBudgetUsd: reservedAmount,
    abortController: currentExecution()?.controller,
    ...sdkProcessOptions(useOpenRouter),
    stderr: (data: string) => {
      console.error(`[SDK:stderr] ${data.trim()}`);
    },
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      append: buildDynamicContext(),
    },
    // Load BOTH user (~/.claude/) and project settings — enables Skills, rules, CLAUDE.md
    settingSources: ["user", "project"],
    // Enable all Claude Code built-in tools INCLUDING Skill
    allowedTools: [
      "Skill",        // Skill system — reads from ~/.claude/skills/ and project skills
      "Read",         // Read files
      "Write",        // Write files
      "Edit",         // Edit files
      "Bash",         // Shell commands
      "Glob",         // File pattern search
      "Grep",         // Content search
      "WebFetch",     // Fetch web content
      "WebSearch",    // Search the web
      "Task",         // Spawn sub-agents
      "TodoRead",     // Read todos
      "TodoWrite",    // Write todos
    ],
    permissionMode: "acceptEdits",
    persistSession: true,
    extraArgs: { effort: tier === "haiku" ? "low" : tier === "sonnet" ? "medium" : "high" },
    // Fable 5 rejects {type: "disabled"} with a 400 — adaptive is the only valid mode
    // Programmatic hooks — security guardrails for VPS
    hooks: {
      // Log all tool usage for observability
      PostToolUse: [
        {
          matcher: "*",
          hooks: [
            async (input: any) => {
              const toolName = input?.toolName || "unknown";
              const duration = input?.durationMs || 0;
              console.log(`[HOOK:PostToolUse] ${toolName} (${duration}ms)`);
              return {};
            },
          ],
        },
      ],
      // Security: block dangerous patterns
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            shellSecurityHook,
          ],
        },
      ],
    },
    canUseTool: async (toolName, input) => {
      checkAborted();
      if (["Bash", "Write", "Edit", "MultiEdit"].includes(toolName) || toolName.startsWith("mcp__")) {
        const denied = await authorizeTool({ name: toolName, description: "SDK action", requiresApproval: true,
          inputSchema: { type: "object", properties: {} }, isAvailable: () => true, handler: async () => "" }, input);
        if (denied) return { behavior: "deny", message: denied.content };
      }
      // Intercept AskUserQuestion — pause the agent loop for HITL
      if (toolName === "AskUserQuestion") {
        const inputObj = input as Record<string, any>;
        const questions = inputObj.questions || [];
        const firstQuestion = questions[0];
        const question = firstQuestion?.question || "Confirm?";
        const rawOptions = firstQuestion?.options || [];

        const options =
          rawOptions.length > 0
            ? rawOptions.map((opt: any) => ({
                label: opt.label || "Option",
                value: opt.label || "option",
              }))
            : [
                { label: "Yes, go ahead", value: "yes" },
                { label: "No, skip", value: "no" },
              ];

        throw new AskUserSignal(question, options, "", [], []);
      }

      // Allow everything else
      return { behavior: "allow" as const, updatedInput: input };
    },
  };

  // Resume existing session if available
  if (resumeState?.sessionId) {
    options.resume = resumeState.sessionId;
  }

  // Run the Agent SDK query with progress streaming
  let result = "";
  let sessionId = "";
  let totalCost = 0;
  let numTurns = 0;
  const enableProgress = tier !== "haiku";
  let sentPlan = false;

  try {
    for await (const message of query({ prompt, options })) {
      // Extract text from assistant messages
      if (message.type === "assistant") {
        let turnText = "";
        for (const block of message.message.content) {
          if ("text" in block && block.text) {
            turnText += block.text;
            result += block.text;
          }
        }
        sessionId = message.session_id;

        // Send first meaningful text as a progress update (skip for HITL resumes — user already saw "Got it: resuming...")
        if (enableProgress && !sentPlan && !resumeState && turnText.trim().length > 20) {
          const planPreview =
            turnText.length > 500
              ? turnText.substring(0, 500) + "..."
              : turnText;
          sendProgress(ctx, planPreview);
          sentPlan = true;
        }
      }

      // Extract session ID from system init
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        console.log(
          `[SDK] Session initialized: ${sessionId}, tools: ${message.tools?.length || 0}, mcp: ${message.mcp_servers?.length || 0}`
        );
      }

      // Handle result (success or error)
      if (message.type === "result") {
        sessionId = message.session_id;
        numTurns = message.num_turns;
        totalCost = message.total_cost_usd;

        if (message.subtype === "success") {
          if (message.result) {
            result = message.result;
          }
          console.log(
            `[SDK] Success: ${numTurns} turns, $${totalCost.toFixed(4)}, ${message.duration_ms}ms`
          );
        } else {
          console.error(
            `[SDK] Error (${message.subtype}): ${message.errors?.join(", ")}`
          );
          if (!result) {
            result = `Processing stopped: ${message.subtype}. ${message.errors?.[0] || ""}`;
          }
        }
      }
    }
  } catch (signal) {
    checkAborted();
    if (signal instanceof AskUserSignal) {
      // Pause execution — save state and send Telegram buttons
      const task = await db.createTask(
        chatId,
        userMessage || "resumed task",
        ctx.message?.message_thread_id,
        "vps"
      );

      if (task) {
        await db.updateTask(task.id, {
          status: "needs_input",
          pending_question: signal.question,
          pending_options: signal.options,
          current_step: `ask_user: ${signal.question}`,
          metadata: {
            agent_sdk_session_id: sessionId,
            use_agent_sdk: true,
          },
        });

        const keyboard = buildTaskKeyboard(task.id, signal.options);
        await ctx
          .reply(signal.question, {
            reply_markup: keyboard,
            parse_mode: "HTML",
          })
          .catch(() =>
            ctx.reply(signal.question, { reply_markup: keyboard })
          );
      } else {
        return signal.question;
      }

      const elapsed = Date.now() - startTime;
      console.log(
        `[SDK] Paused (ask_user): ${elapsed}ms, session: ${sessionId}`
      );

      return "";
    }

    // Not an AskUserSignal — check if credit error for OpenRouter retry
    if (isCreditError(signal) && !useOpenRouter && process.env.OPENROUTER_API_KEY) {
      markAnthropicDown();
      console.log("[Resilient] Agent SDK credit error — retrying via OpenRouter...");
      return processWithAgentSDK(userMessage, chatId, ctx, resumeState, onCallInitiated);
    }

    // Try fallback LLMs before throwing
    console.error("Agent SDK error:", signal);
    console.log("🔄 VPS: Agent SDK failed, trying fallback LLMs...");
    try {
      const fallbackResponse = await callFallbackLLM(userMessage);
      return fallbackResponse;
    } catch (fallbackErr) {
      console.error("❌ Fallback also failed:", fallbackErr);
    }
    throw signal;
  } finally { settleBudget(reservation, totalCost || undefined); }

  // Track cost
  if (totalCost > 0) {
    // Also self-meter against the monthly Agent SDK credit (no-op off-subscription, fail-open)
    creditGuard.record(totalCost).catch(() => {});
  }

  const elapsed = Date.now() - startTime;
  console.log(
    `[SDK] Complete: ${numTurns} turns, $${totalCost.toFixed(4)}, ${elapsed}ms, budget: $${getDailyBudgetRemaining().toFixed(2)}`
  );

  return result || "Processed but no response generated.";
}

export async function processWithAgentSDK(...args: Parameters<typeof processWithAgentSDKUnlocked>): Promise<string> {
  const key = db.sessionKeyFor(args[1], args[2].msg?.message_thread_id ?? null);
  return runExecution(key, "general", () => processWithAgentSDKUnlocked(...args));
}
