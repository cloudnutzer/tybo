import { installTelegramToolApproval } from "./lib/telegram-tool-approval";
import { runCancelable, abortExecutions } from "./lib/execution-context";
import { authorizeBearer, secretMatches, verifyElevenLabs } from "./lib/http-security";
import { claimWebhookEvent } from "./lib/webhook-events";
/**
 * VPS Gateway — Telegram Webhook + Smart Routing + Voice + Human-in-the-Loop
 *
 * Always-on entry point for the Telegram bot on a VPS.
 * Routes to local machine (Claude Code CLI, subscription auth) when alive,
 * or processes on VPS via direct Anthropic API (pay-per-token) when local is down.
 *
 * Run: bun run src/vps-gateway.ts
 */

import { Bot, InputFile } from "grammy";
import type { Context } from "grammy";
import { readFile } from "fs/promises";
import { join } from "path";
import { createHmac } from "crypto";
import { spawn } from "child_process";
import {
  isMacAlive,
  startHealthMonitor,
  getHealthState,
} from "./lib/mac-health";
import { markdownToTelegramHTML, chunkForTelegram, stripHtmlTags } from "./lib/telegram";
import {
  handleTaskCallback,
  formatTaskStatus,
  checkStaleTasks,
} from "./lib/task-queue";
import { processWithAnthropic } from "./lib/anthropic-processor";
import type { ResumeState, StreamCallbacks } from "./lib/anthropic-processor";
import {
  processWithAgentSDK,
  getDailyBudgetRemaining,
} from "./lib/agent-session";
import type { AgentResumeState } from "./lib/agent-session";
import { selectModelForMessage } from "./lib/model-router";
import * as creditGuard from "./lib/credit-guard";
import {
  textToSpeech,
  buildVoiceAgentContext,
  summarizeTranscript,
  getCallTranscript,
  extractTaskFromTranscript,
} from "./lib/voice";
import { transcribeAudioBuffer } from "./lib/transcribe";
import {
  uploadAssetFromBuffer,
  updateAssetDescription,
  describeImageFromBuffer,
  parseAssetDescTag,
  stripAssetDescTag,
} from "./lib/asset-store";
import * as db from "./lib/convex";
import { BotRegistry } from "./lib/bot-registry";
import { getAgentByTopicId, getAgentConfig } from "./agents";
import { gatherBoardData } from "./lib/board-data";
import { stripInvocationTags } from "./lib/cross-agent";
import { mcpManager } from "./lib/mcp-client";

// ============================================================
// LOAD ENVIRONMENT
// ============================================================

const envPath = process.env.ENV_PATH || join(import.meta.dir, "..", ".env");
const envContent = await readFile(envPath, "utf-8").catch(() => "");
for (const line of envContent.split("\n")) {
  const trimmed = line.trim();
  if (trimmed && !trimmed.startsWith("#")) {
    const [key, ...valueParts] = trimmed.split("=");
    if (key && valueParts.length > 0) {
      process.env[key.trim()] = valueParts.join("=").trim();
    }
  }
}

// ============================================================
// CONFIGURATION
// ============================================================

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED_USER_ID = process.env.TELEGRAM_USER_ID || "";
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || "";
const MAC_PROCESS_URL = process.env.MAC_PROCESS_URL || "";
const NODE_ID = process.env.NODE_ID || "vps";
const PORT = parseInt(process.env.PORT || "3000");
const DEPLOY_SECRET = process.env.DEPLOY_SECRET || "";
const USER_NAME = process.env.USER_NAME || "User";
const BOT_NAME = process.env.BOT_NAME || "Go";

// ============================================================
// MCP MANAGER — Model-agnostic tool access for all LLMs
// ============================================================

await mcpManager.init().catch((err: any) => {
  console.error("[MCPManager] Init failed (continuing without MCP tools):", err.message);
});

// ============================================================
// BOT SETUP
// ============================================================

if (!BOT_TOKEN || !ALLOWED_USER_ID || !GATEWAY_SECRET) {
  console.error("TELEGRAM_BOT_TOKEN, TELEGRAM_USER_ID and GATEWAY_SECRET are required");
  process.exit(1);
}

const bot = new Bot(BOT_TOKEN);

// Deliver the credit-guard's 80% warning + plan-change nudge to the owner's chat.
creditGuard.setNotifier((msg) =>
  bot.api.sendMessage(process.env.TELEGRAM_USER_ID || "", msg).catch(() => {})
);

// Initialize bot (required for webhook mode — bot.start() does this for polling)
await bot.init();
console.log(`Bot initialized: @${bot.botInfo.username}`);

// Multi-bot registry (agent-specific bots for visible identities)
const botRegistry = new BotRegistry(bot);
await botRegistry.initialize();

// Global error handler — prevents Grammy from dumping full Context objects
bot.catch((err) => {
  const e = err.error;
  const errMsg = e instanceof Error ? e.message : String(e);
  console.error(`BotError [update ${err.ctx?.update?.update_id}]: ${errMsg}`);
});

// Security: only accept messages from allowed user
bot.use(async (ctx, next) => {
  const userId = ctx.from?.id?.toString();
  if (userId !== ALLOWED_USER_ID) {
    console.log(`Blocked message from unauthorized user: ${userId}`);
    return;
  }
  const key = db.sessionKeyFor(String(ctx.chat?.id || ""), ctx.msg?.message_thread_id ?? null);
  if (/^\/stop\b/i.test(ctx.message?.text || "")) {
    abortExecutions(key);
    await ctx.reply("Gestoppt.");
    return;
  }
  try { await runCancelable(key, next); }
  catch (error) { if (!(error instanceof Error && error.name === "AbortError")) throw error; }
});

installTelegramToolApproval(bot, ALLOWED_USER_ID);

// ============================================================
// FORWARD TO LOCAL MACHINE
// ============================================================

interface LocalResponse {
  success: boolean;
  response?: string | null;
  error?: string;
  async?: boolean; // true when local returned 202 (async handoff)
}

async function forwardToLocal(
  text: string,
  chatId: string,
  threadId?: number,
  photoFileId?: string
): Promise<LocalResponse> {
  if (!MAC_PROCESS_URL) {
    return { success: false, error: "MAC_PROCESS_URL not configured" };
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000); // 10s — expect 202 almost instantly

    const payload: Record<string, any> = { text, chatId, threadId };
    if (photoFileId) payload.photoFileId = photoFileId;

    const res = await fetch(MAC_PROCESS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${GATEWAY_SECRET}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    // 202 = local accepted, will process and send to Telegram in background
    if (res.status === 202) {
      console.log(`[HYBRID] Async handoff to local for chatId=${chatId}`);
      return { success: true, response: null, async: true };
    }

    if (!res.ok) {
      return { success: false, error: `Local returned ${res.status}` };
    }

    // 200 = synchronous response (backwards compatible)
    const data = (await res.json()) as Record<string, any>;
    return {
      success: true,
      response: data.response || data.result || "Processed.",
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
}

// ============================================================
// SEND RESPONSE (handles long messages)
// ============================================================

async function sendResponse(ctx: Context, text: string): Promise<void> {
  if (!text) return; // Empty = handled elsewhere (e.g. ask_user buttons)

  const html = markdownToTelegramHTML(text);
  const chunks = chunkForTelegram(html);

  for (const chunk of chunks) {
    try {
      await ctx.reply(chunk, { parse_mode: "HTML" });
    } catch (htmlErr) {
      console.warn(`[VPS sendResponse] HTML send failed (${chunk.length} chars), retrying plain:`, htmlErr);
      try {
        await ctx.reply(stripHtmlTags(chunk));
      } catch (plainErr) {
        console.error(`[VPS sendResponse] DELIVERY FAILED (${chunk.length} chars) — message lost:`, plainErr);
      }
    }
  }
}

// ============================================================
// PHONE CALL TRANSCRIPT DEDUPLICATION
// ============================================================

const processedCallIds = new Set<string>();

// ============================================================
// PHONE CALL TRANSCRIPT POLLING (fire-and-forget)
// ============================================================

function startCallTranscriptPolling(
  conversationId: string,
  chatId: string
): void {
  const POLL_INTERVAL_MS = 10_000;
  const MAX_ATTEMPTS = 90;

  console.log(
    `Starting transcript polling for call ${conversationId} (every ${POLL_INTERVAL_MS / 1000}s, max ${MAX_ATTEMPTS} attempts)`
  );

  (async () => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

      try {
        // Skip if already processed (webhook may have handled it)
        if (processedCallIds.has(conversationId)) {
          console.log(`Transcript for ${conversationId} already processed (by webhook), stopping poll`);
          return;
        }

        const transcript = await getCallTranscript(conversationId);
        if (!transcript) {
          if (attempt % 6 === 0) {
            console.log(
              `Transcript poll #${attempt} for ${conversationId}: not ready yet`
            );
          }
          continue;
        }

        // Wait 30s for webhook to claim it first (dedup race fix)
        console.log(`Waiting 30s for webhook to process call ${conversationId} first...`);
        await new Promise((resolve) => setTimeout(resolve, 30_000));

        if (processedCallIds.has(conversationId)) {
          console.log(`Call ${conversationId} already processed (by webhook), skipping poll`);
          return;
        }
        processedCallIds.add(conversationId);
        console.log(`Webhook did not fire for ${conversationId}, poller taking over as fallback`);

        console.log(
          `Transcript received for ${conversationId} after ${attempt} polls`
        );

        const summary = await summarizeTranscript(transcript);

        const summaryMsg = `**Phone Call Summary**\n\n${summary}\n\n_Full transcript saved._`;
        await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: markdownToTelegramHTML(summaryMsg),
              parse_mode: "HTML",
            }),
          }
        ).catch(() => {
          fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: stripHtmlTags(markdownToTelegramHTML(summaryMsg)),
            }),
          }).catch(() => {});
        });

        await db
          .saveMessage({
            chat_id: chatId,
            role: "assistant",
            content: `[Phone call transcript]\n${transcript}\n\n[Summary]\n${summary}`,
            metadata: {
              type: "phone_call",
              conversation_id: conversationId,
              processed_by: NODE_ID,
            },
          })
          .catch(() => {});

        // Extract and auto-execute any tasks from the call
        extractTaskFromTranscript(transcript, summary)
          .then(async (task) => {
            if (task) {
              console.log(
                `Task detected from call: "${task.length} chars"`
              );
              await executeCallTask(task, chatId);
            }
          })
          .catch((err) =>
            console.error("Call task extraction failed:", err)
          );

        return; // Done
      } catch (err: any) {
        console.error(
          `Transcript poll error (attempt ${attempt}):`,
          err.message
        );
      }
    }

    console.log(
      `Transcript polling timed out for ${conversationId} after ${MAX_ATTEMPTS} attempts`
    );
  })();
}

// ============================================================
// CALL TASK AUTO-EXECUTION
// ============================================================

/**
 * Execute a task extracted from a call transcript.
 * Routes to local Mac (if alive) or processes on VPS directly.
 * Sends progress + result to Telegram.
 */
async function executeCallTask(
  taskDescription: string,
  chatId: string
): Promise<void> {
  console.log(
    `Executing call task: "${taskDescription.length} chars..."`
  );

  // Notify user that task is starting
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: `<b>Starting task from call:</b>\n${taskDescription}`,
      parse_mode: "HTML",
    }),
  }).catch(() => {
    fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `Starting task from call:\n${taskDescription}`,
      }),
    }).catch(() => {});
  });

  try {
    let response: string;

    if (isMacAlive()) {
      // Forward to local machine for Claude Code processing
      console.log("Routing call task to local machine...");
      const localResult = await forwardToLocal(taskDescription, chatId);
      if (localResult.async) {
        // Local accepted async — it handles processing + Telegram response
        console.log(`[HYBRID] Async handoff for call task, chatId=${chatId}`);
        return;
      } else if (localResult.success && localResult.response) {
        response = localResult.response;
      } else {
        console.log(
          `Local forwarding failed (${localResult.error}), processing call task on VPS...`
        );
        response = await processCallTaskOnVPS(taskDescription, chatId);
      }
    } else {
      console.log("Local machine down, processing call task on VPS...");
      response = await processCallTaskOnVPS(taskDescription, chatId);
    }

    // Send result using centralized conversion + chunking
    if (response) {
      const html = markdownToTelegramHTML(response);
      const chunks = chunkForTelegram(html);
      for (const chunk of chunks) {
        await fetch(
          `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: chunk,
              parse_mode: "HTML",
            }),
          }
        ).catch(() => {
          fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: chatId, text: stripHtmlTags(chunk) }),
          }).catch(() => {});
        });
      }
    }
  } catch (error: any) {
    console.error("Call task execution error:", error);
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `Task from call failed: ${error.message?.substring(0, 200) || "Unknown error"}`,
      }),
    }).catch(() => {});
  }
}

/**
 * Process a call task directly on VPS using Anthropic API.
 */
async function processCallTaskOnVPS(
  taskDescription: string,
  chatId: string
): Promise<string> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENROUTER_API_KEY) {
    return "Cannot process task — no API key configured.";
  }

  try {
    const { createResilientMessage, getModelForProvider } = await import("./lib/resilient-client");

    const { model } = selectModelForMessage(taskDescription);

    const response = await createResilientMessage({
      model: getModelForProvider(model),
      max_tokens: 4096,
      messages: [
        {
          role: "user",
          content: taskDescription,
        },
      ],
      system:
        "You are Go, a personal AI assistant. Execute the requested task thoroughly and provide a complete response.",
    });

    const textBlocks = response.content.filter(
      (b) => b.type === "text"
    );
    return (
      textBlocks.map((b) => b.text).join("\n") ||
      "Task completed but no output generated."
    );
  } catch (err: any) {
    console.error("VPS task processing error:", err.message);
    return `Task processing failed: ${err.message}`;
  }
}

// ============================================================
// TIERED VPS PROCESSING
// ============================================================

/**
 * Process a message on VPS with tiered model routing.
 *
 * - Haiku (simple) → Direct Anthropic API (fast, 2-5s)
 * - Sonnet/Opus (complex) → Agent SDK if enabled (full Claude Code)
 * - Fallback: Direct API for all tiers when Agent SDK is disabled
 */
async function processOnVPS(
  text: string,
  chatId: string,
  ctx: Context,
  onCallInitiated?: (conversationId: string) => void,
  streamCallbacks?: StreamCallbacks
): Promise<string> {
  const useAgentSDK = process.env.USE_AGENT_SDK === "true";
  const { tier, model } = selectModelForMessage(
    text,
    useAgentSDK ? getDailyBudgetRemaining() : undefined
  );

  if (useAgentSDK && tier !== "haiku") {
    // Sonnet/Opus → Agent SDK (full Claude Code capabilities)
    console.log(`Agent SDK: ${tier.toUpperCase()} (${model})`);
    await ctx
      .reply("<i>Working on it...</i>", { parse_mode: "HTML" })
      .catch(() => {});
    try {
      const result = await processWithAgentSDK(text, chatId, ctx, undefined, onCallInitiated);
      if (result) return result;
    } catch (err: any) {
      console.error(`Agent SDK failed, falling back to direct API: ${err.message || err}`);
    }
    // Fallback to direct API
    console.log(`Fallback to direct API (${tier})`);
    return processWithAnthropic(
      text,
      chatId,
      ctx,
      undefined,
      onCallInitiated || ((convId) => startCallTranscriptPolling(convId, chatId)),
      model,
      streamCallbacks
    );
  }

  // Haiku or Agent SDK disabled → Direct API (fast, cheap)
  console.log(`Direct API: ${tier.toUpperCase()} (${model})`);
  return processWithAnthropic(
    text,
    chatId,
    ctx,
    undefined,
    onCallInitiated || ((convId) => startCallTranscriptPolling(convId, chatId)),
    model,
    streamCallbacks
  );
}

// ============================================================
// MESSAGE HANDLER — Smart Routing
// ============================================================

bot.command("start", async (ctx) => {
  await ctx.reply(
    `${BOT_NAME} Gateway active. Local machine: ` +
      (isMacAlive()
        ? "ONLINE (routing to local)"
        : "OFFLINE (VPS processing)")
  );
});

bot.command("status", async (ctx) => {
  const health = getHealthState();
  const localStatus = health.isAlive ? "ONLINE" : "OFFLINE";
  const lastCheck = health.lastCheck
    ? `${Math.round((Date.now() - health.lastCheck) / 1000)}s ago`
    : "never";

  await ctx.reply(
    `**Gateway Status**\n` +
      `Local machine: ${localStatus}\n` +
      `Last check: ${lastCheck}\n` +
      `Failures: ${health.consecutiveFailures}\n` +
      `Node: ${NODE_ID}`,
    { parse_mode: "HTML" }
  );
});

bot.command("credit", async (ctx) => {
  const status = await creditGuard.formatStatus();
  await ctx.reply(markdownToTelegramHTML(status), { parse_mode: "HTML" }).catch(() => ctx.reply(status));
});

bot.command("plan", async (ctx) => {
  const status = await creditGuard.formatPlan();
  await ctx.reply(markdownToTelegramHTML(status), { parse_mode: "HTML" }).catch(() => ctx.reply(status));
});

bot.command("tasks", async (ctx) => {
  const chatId = ctx.chat.id.toString();
  const status = await formatTaskStatus(chatId);
  await ctx
    .reply(status, { parse_mode: "HTML" })
    .catch(() => ctx.reply(status));
});

bot.on("message:text", async (ctx) => {
  const text = ctx.message.text;
  const chatId = ctx.chat.id.toString();
  const threadId = ctx.message.message_thread_id;

  console.log(
    `Message: "${text.length} chars..." | Local: ${isMacAlive() ? "UP" : "DOWN"}`
  );

  await ctx.replyWithChatAction("typing").catch(() => {});

  // Log incoming message
  await db
    .saveMessage({
      chat_id: chatId,
      role: "user",
      content: text,
      metadata: {
        telegram_user_id: ctx.from?.id,
        telegram_chat_id: ctx.chat.id,
        thread_id: threadId,
        processed_by: NODE_ID,
      },
    })
    .catch(() => {});

  // ---- Board Meeting: intercept /board before generic routing ----
  if (/^\/board\b|^board meeting/i.test(text)) {
    // If Mac is alive, forward — Mac handles multi-bot board meeting
    if (isMacAlive()) {
      console.log("📊 Board meeting → forwarding to Mac");
      const localResult = await forwardToLocal(text, chatId, threadId);
      if (localResult.async || (localResult.success && localResult.response)) {
        if (localResult.response) {
          await botRegistry.sendAsAgent("general", chatId, localResult.response, { threadId });
        }
        return;
      }
      console.log("Mac forwarding failed, running board meeting on VPS...");
    }

    // VPS-native board meeting (Mac down or forwarding failed)
    console.log("📊 Running board meeting on VPS");
    const extraContext = text.replace(/^\/board\s*/i, "").replace(/^board meeting\s*/i, "").trim();

    await botRegistry.sendAsAgent("general", chatId,
      `*Board Meeting Starting*\n\nGathering perspectives from all agents...${extraContext ? `\n\nContext: ${extraContext}` : ""}`,
      { threadId }
    );

    const [boardContext, boardData] = await Promise.all([
      db.getBoardMeetingContext(7),
      gatherBoardData(),
    ]);
    console.log(`[BoardMeeting] Data gathered in ${boardData.fetchDurationMs}ms (errors: ${boardData.errors.join(", ") || "none"})`);

    const boardAgents = ["research", "content", "finance", "strategy", "cto", "coo", "critic"];
    const agentResponses: { agent: string; response: string }[] = [];

    for (const agent of boardAgents) {
      await botRegistry.sendTypingAsAgent(agent, chatId, threadId);

      const previousInput = agentResponses
        .map((r) => `**${r.agent}**: ${r.response.substring(0, 300)}`)
        .join("\n\n");

      const agentConfig = getAgentConfig(agent);
      const dataBlock = boardData.agentData[agent] || "";
      const boardPrompt = `${agentConfig?.systemPrompt || ""}

${dataBlock}

${boardContext}

${previousInput ? `## PREVIOUS AGENT INPUTS\n${previousInput}` : ""}

You are participating in a board meeting. Reference specific numbers and data from your LIVE DATA section above. Provide a concise analysis from your domain. Focus on what matters most from your perspective. Keep it to 2-4 key points.${extraContext ? `\n\nAdditional context: ${extraContext}` : ""}`;

      try {
        const response = await processWithAnthropic(boardPrompt, chatId, ctx);
        const cleanResponse = stripInvocationTags(response);
        agentResponses.push({ agent, response: cleanResponse });
        await botRegistry.sendAsAgent(agent, chatId, cleanResponse, { threadId });
        await new Promise((resolve) => setTimeout(resolve, 1000));
      } catch (err) {
        console.error(`[BoardMeeting] ${agent} failed:`, err);
        agentResponses.push({ agent, response: "(unavailable)" });
      }
    }

    // Orchestrator synthesizes
    await botRegistry.sendTypingAsAgent("general", chatId, threadId);
    const synthesisPrompt = `Board meeting synthesis. All agent contributions:

${agentResponses.map((r) => `**${r.agent.toUpperCase()}**:\n${r.response}`).join("\n\n---\n\n")}

${boardData.sharedSummary ? `## CURRENT METRICS SNAPSHOT\n${boardData.sharedSummary}\n` : ""}
Synthesize key themes, identify conflicts or alignments, and propose 3-5 concrete action items with clear ownership. Ground your action items in the specific numbers above.`;

    const synthesis = await processWithAnthropic(synthesisPrompt, chatId, ctx);
    await botRegistry.sendAsAgent("general", chatId, synthesis, { threadId });

    // Persist full meeting
    await db.saveMessage({
      chat_id: chatId,
      role: "assistant",
      content: `[Board Meeting]\n\n${agentResponses.map((r) => `${r.agent}: ${r.response}`).join("\n\n")}\n\n[Synthesis]\n${synthesis}`,
      metadata: { type: "board_meeting", thread_id: threadId, processed_by: NODE_ID },
    }).catch(() => {});

    return;
  }

  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);

  let response: string;
  let processedBy = NODE_ID;
  let streamedResponse = false;

  try {
    const { tier } = selectModelForMessage(text);

    // Simple messages → VPS Haiku direct (<1s). No "Working...", no Mac subprocess overhead.
    if (tier === "haiku") {
      console.log(`[FAST] Simple message → VPS Haiku`);
      response = await processOnVPS(text, chatId, ctx);
    } else if (isMacAlive()) {
      console.log("Routing to local machine...");
      const localResult = await forwardToLocal(text, chatId, threadId);

      if (localResult.async) {
        // Local accepted async — it handles processing + Telegram response
        clearInterval(typingInterval);
        return;
      } else if (localResult.success && localResult.response) {
        response = localResult.response;
        processedBy = "local";
      } else {
        console.log(
          `Local forwarding failed (${localResult.error}), processing on VPS...`
        );

        // Send "Working..." and build streaming callbacks
        let progressMsgId: number | null = null;
        let lastEditAt = 0;
        const EDIT_THROTTLE_MS = 1500;
        let activityLog: string[] = [];
        let isTextPhase = false;

        try {
          const msg = await ctx.reply("<i>Working...</i>", { parse_mode: "HTML" });
          progressMsgId = msg.message_id;
        } catch {}

        const streamCbs: StreamCallbacks = {
          onToolStart: (toolName) => {
            if (isTextPhase) return;
            activityLog.push(`⚡ ${toolName}`);
            if (activityLog.length > 6) activityLog = activityLog.slice(-6);
            const now = Date.now();
            if (now - lastEditAt < EDIT_THROTTLE_MS || !progressMsgId) return;
            lastEditAt = now;
            const text = `_Working..._\n\n${activityLog.join("\n")}`;
            bot.api.editMessageText(Number(chatId), progressMsgId, text, { parse_mode: "HTML" }).catch(() => {
              bot.api.editMessageText(Number(chatId), progressMsgId!, text).catch(() => {});
            });
          },
          onTextDelta: (accumulated) => {
            if (!isTextPhase) { isTextPhase = true; activityLog = []; }
            const now = Date.now();
            if (now - lastEditAt < EDIT_THROTTLE_MS || !progressMsgId) return;
            lastEditAt = now;
            const display = accumulated.length > 4000 ? accumulated.substring(0, 4000) + "\n\n_..." : accumulated;
            bot.api.editMessageText(Number(chatId), progressMsgId, display, { parse_mode: "HTML" }).catch(() => {
              bot.api.editMessageText(Number(chatId), progressMsgId!, display).catch(() => {});
            });
          },
        };

        response = await processOnVPS(text, chatId, ctx, undefined, streamCbs);

        // Final edit with complete response, or delete progress msg and chunk
        if (progressMsgId) {
          if (isTextPhase && response) {
            const html = markdownToTelegramHTML(response);
            if (html.length <= 4000) {
              try {
                await bot.api.editMessageText(Number(chatId), progressMsgId, html, { parse_mode: "HTML" });
                streamedResponse = true;
              } catch {
                // Edit failed — delete progress, send via chunked path
                console.warn(`[VPS] HTML edit failed, falling through to chunked send`);
                try { await bot.api.deleteMessage(Number(chatId), progressMsgId); } catch {}
              }
            } else {
              // Too long for edit — delete progress, send via chunked path
              try { await bot.api.deleteMessage(Number(chatId), progressMsgId); } catch {}
              // streamedResponse stays false → caller sends via sendAsAgent
            }
          } else {
            try { await bot.api.deleteMessage(Number(chatId), progressMsgId); } catch {}
          }
        }
      }
    } else {
      console.log("Local machine down, processing on VPS...");

      // Send "Working..." and build streaming callbacks
      let progressMsgId: number | null = null;
      let lastEditAt = 0;
      const EDIT_THROTTLE_MS = 1500;
      let activityLog: string[] = [];
      let isTextPhase = false;

      try {
        const msg = await ctx.reply("<i>Working...</i>", { parse_mode: "HTML" });
        progressMsgId = msg.message_id;
      } catch {}

      const streamCbs: StreamCallbacks = {
        onToolStart: (toolName) => {
          if (isTextPhase) return;
          activityLog.push(`⚡ ${toolName}`);
          if (activityLog.length > 6) activityLog = activityLog.slice(-6);
          const now = Date.now();
          if (now - lastEditAt < EDIT_THROTTLE_MS || !progressMsgId) return;
          lastEditAt = now;
          const text = `_Working..._\n\n${activityLog.join("\n")}`;
          bot.api.editMessageText(Number(chatId), progressMsgId, text, { parse_mode: "HTML" }).catch(() => {
            bot.api.editMessageText(Number(chatId), progressMsgId!, text).catch(() => {});
          });
        },
        onTextDelta: (accumulated) => {
          if (!isTextPhase) { isTextPhase = true; activityLog = []; }
          const now = Date.now();
          if (now - lastEditAt < EDIT_THROTTLE_MS || !progressMsgId) return;
          lastEditAt = now;
          const display = accumulated.length > 4000 ? accumulated.substring(0, 4000) + "\n\n_..." : accumulated;
          bot.api.editMessageText(Number(chatId), progressMsgId, display, { parse_mode: "HTML" }).catch(() => {
            bot.api.editMessageText(Number(chatId), progressMsgId!, display).catch(() => {});
          });
        },
      };

      response = await processOnVPS(text, chatId, ctx, undefined, streamCbs);

      // Final edit with complete response, or delete progress msg and chunk
      if (progressMsgId) {
        if (isTextPhase && response) {
          const html = markdownToTelegramHTML(response);
          if (html.length <= 4000) {
            try {
              await bot.api.editMessageText(Number(chatId), progressMsgId, html, { parse_mode: "HTML" });
              streamedResponse = true;
            } catch {
              // Edit failed — delete progress, send via chunked path
              console.warn(`[VPS] HTML edit failed, falling through to chunked send`);
              try { await bot.api.deleteMessage(Number(chatId), progressMsgId); } catch {}
            }
          } else {
            // Too long for edit — delete progress, send via chunked path
            try { await bot.api.deleteMessage(Number(chatId), progressMsgId); } catch {}
            // streamedResponse stays false → caller sends via sendAsAgent
          }
        } else {
          try { await bot.api.deleteMessage(Number(chatId), progressMsgId); } catch {}
        }
      }
    }
  } finally {
    clearInterval(typingInterval);
  }

  if (response) {
    // Determine agent from topic (if forum mode)
    const agentName = threadId ? getAgentByTopicId(threadId, chatId) || "general" : "general";

    await db
      .saveMessage({
        chat_id: chatId,
        role: "assistant",
        content: response,
        metadata: {
          telegram_chat_id: ctx.chat.id,
          thread_id: threadId,
          processed_by: processedBy,
          agent: agentName,
        },
      })
      .catch(() => {});

    // Route response through agent's bot (skip if already streamed to Telegram)
    if (!streamedResponse) {
      await botRegistry.sendAsAgent(agentName, chatId, response, { threadId });
    }
  }
});

// ============================================================
// PHOTO MESSAGE HANDLER
// ============================================================

bot.on("message:photo", async (ctx) => {
  console.log("Photo message received");
  await ctx.replyWithChatAction("typing").catch(() => {});

  const chatId = ctx.chat.id.toString();
  const threadId = ctx.message.message_thread_id;
  const caption = ctx.message.caption || "User sent a photo. Describe and respond to it.";

  // Get highest resolution photo
  const photos = ctx.message.photo;
  if (!photos || photos.length === 0) {
    await ctx.reply("Could not process photo.");
    return;
  }
  const largest = photos[photos.length - 1];

  // Fire-and-forget: don't block Grammy's update loop
  (async () => {
    const typingInterval = setInterval(() => {
      ctx.replyWithChatAction("typing").catch(() => {});
    }, 4000);

    try {
      // Log incoming message
      await db
        .saveMessage({
          chat_id: chatId,
          role: "user",
          content: `[Photo] ${caption}`,
          metadata: {
            telegram_user_id: ctx.from?.id,
            telegram_chat_id: ctx.chat.id,
            thread_id: threadId,
            processed_by: NODE_ID,
          },
        })
        .catch(() => {});

      let response: string;
      let processedBy = NODE_ID;

      if (isMacAlive()) {
        // Path A: Forward photo file_id to Mac for processing
        console.log("Forwarding photo to local machine...");
        const localResult = await forwardToLocal(caption, chatId, threadId, largest.file_id);

        if (localResult.async) {
          // Local accepted async — it handles processing + Telegram response
          return;
        } else if (localResult.success && localResult.response) {
          response = localResult.response;
          processedBy = "local";
        } else {
          console.log(`Photo forwarding failed (${localResult.error}), processing on VPS...`);
          response = await processPhotoOnVPS(largest.file_id, caption, chatId, ctx);
        }
      } else {
        // Path B: Process photo on VPS
        console.log("Local machine down, processing photo on VPS...");
        response = await processPhotoOnVPS(largest.file_id, caption, chatId, ctx);
      }

      if (response) {
        await db
          .saveMessage({
            chat_id: chatId,
            role: "assistant",
            content: response,
            metadata: {
              telegram_chat_id: ctx.chat.id,
              thread_id: threadId,
              processed_by: processedBy,
            },
          })
          .catch(() => {});
      }

      await sendResponse(ctx, response);
    } catch (err) {
      console.error("Photo handler error:", err);
      await ctx.reply("Sorry, I couldn't process that image.").catch(() => {});
    } finally {
      clearInterval(typingInterval);
    }
  })();
});

/**
 * Process a photo on VPS using Haiku vision + asset storage.
 */
async function processPhotoOnVPS(
  fileId: string,
  caption: string,
  chatId: string,
  ctx: Context
): Promise<string> {
  // Download photo from Telegram API to buffer
  const file = await ctx.api.getFile(fileId);
  const filePath = file.file_path;
  if (!filePath) return "Could not download photo.";

  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;
  const dlRes = await fetch(fileUrl);
  const buffer = Buffer.from(await dlRes.arrayBuffer());

  const ext = filePath.split(".").pop() || "jpg";
  const filename = `photo_${Date.now()}.${ext}`;

  // Get description via Haiku vision
  const visionResult = await describeImageFromBuffer(buffer, filename, caption);

  // Upload to Supabase Storage
  const asset = await uploadAssetFromBuffer(buffer, filename, {
    description: visionResult.description,
    tags: visionResult.tags,
    suggestedProject: visionResult.suggestedProject,
    userCaption: caption,
    channel: "telegram",
    telegramFileId: fileId,
  });

  // Build prompt with image description for text processing
  const imageContext = `[Image description: ${visionResult.description}]${
    visionResult.tags.length > 0 ? `\n[Tags: ${visionResult.tags.join(", ")}]` : ""
  }${asset ? `\n(asset: ${asset.id})` : ""}`;

  const response = await processOnVPS(
    `${imageContext}\n\nUser says: ${caption}`,
    chatId,
    ctx
  );

  // Parse [ASSET_DESC] from response, update asset
  if (asset) {
    const parsed = parseAssetDescTag(response);
    if (parsed) {
      updateAssetDescription(asset.id, parsed.description, parsed.tags).catch(() => {});
    }
  }

  return stripAssetDescTag(response);
}

// ============================================================
// VOICE MESSAGE HANDLER
// ============================================================

bot.on("message:voice", async (ctx) => {
  console.log("Voice message received");
  await ctx.replyWithChatAction("typing").catch(() => {});

  const chatId = ctx.chat.id.toString();
  const threadId = ctx.message.message_thread_id;

  // Fire-and-forget: don't block Grammy's update loop
  (async () => {
    try {
      // Download voice file as buffer (no temp files on VPS)
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${file.file_path}`;
      const downloadRes = await fetch(fileUrl);
      const oggBuffer = Buffer.from(await downloadRes.arrayBuffer());

      // Transcribe with Gemini (buffer-based, no disk writes)
      const transcription = await transcribeAudioBuffer(oggBuffer);
      console.log(`Transcribed: ${transcription.length} chars...`);

      await db
        .saveMessage({
          chat_id: chatId,
          role: "user",
          content: `[Voice message]: ${transcription}`,
          metadata: {
            telegram_user_id: ctx.from?.id,
            telegram_chat_id: ctx.chat.id,
            thread_id: threadId,
            processed_by: NODE_ID,
            type: "voice",
          },
        })
        .catch(() => {});

      const typingInterval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 4000);

      let response: string;
      let processedBy = NODE_ID;

      try {
        const voiceText = `[Voice message transcription]: ${transcription}`;
        if (isMacAlive()) {
          const localResult = await forwardToLocal(voiceText, chatId, threadId);
          if (localResult.async) {
            // Local accepted async — it handles processing + Telegram response
            clearInterval(typingInterval);
            return;
          } else if (localResult.success && localResult.response) {
            response = localResult.response;
            processedBy = "local";
          } else {
            response = await processOnVPS(voiceText, chatId, ctx);
          }
        } else {
          response = await processOnVPS(voiceText, chatId, ctx);
        }
      } finally {
        clearInterval(typingInterval);
      }

      if (!response) return; // ask_user handled it

      await db
        .saveMessage({
          chat_id: chatId,
          role: "assistant",
          content: response,
          metadata: {
            telegram_chat_id: ctx.chat.id,
            thread_id: threadId,
            processed_by: processedBy,
            type: "voice_response",
          },
        })
        .catch(() => {});

      // Reply with voice + text
      const audioBuffer = await textToSpeech(response);
      if (audioBuffer) {
        await ctx
          .replyWithVoice(new InputFile(audioBuffer, "response.wav"))
          .catch((err) => {
            console.error("Failed to send voice reply:", err.message);
          });
      }
      await sendResponse(ctx, response);
    } catch (error: any) {
      console.error("Voice processing error:", error);
      await ctx
        .reply(
          "Sorry, couldn't process your voice message. Please try again or send text."
        )
        .catch(() => {});
    }
  })();
});

// ============================================================
// CALLBACK QUERY HANDLER (Inline Buttons — Human-in-the-Loop)
// ============================================================

bot.on("callback_query:data", async (ctx) => {
  const data = ctx.callbackQuery.data;
  console.log(`Button pressed: ${data}`);
  await ctx.answerCallbackQuery();

  if (data.startsWith("atask:")) {
    const result = await handleTaskCallback(data);
    const chatId = ctx.chat?.id?.toString() || "";

    if (!result) {
      await ctx.editMessageText("Task not found.").catch(() => {});
      return;
    }

    if (result.cancelled) {
      await ctx.editMessageText("Task cancelled.").catch(() => {});
      return;
    }

    // Agent SDK resume: task has session_id from Agent SDK
    if (
      result.task?.metadata?.use_agent_sdk &&
      result.task?.metadata?.agent_sdk_session_id
    ) {
      console.log(
        `Resuming via Agent SDK: task=${result.taskId}, session=${result.task.metadata.agent_sdk_session_id}`
      );
      await ctx
        .editMessageText(`Got it: "${result.choice}". Resuming...`)
        .catch(() => {});

      const agentResume: AgentResumeState = {
        taskId: result.taskId,
        sessionId: result.task.metadata.agent_sdk_session_id,
        userChoice: result.choice,
        originalPrompt: result.task.original_prompt,
      };

      const response = await processWithAgentSDK(
        result.task.original_prompt,
        chatId,
        ctx,
        agentResume
      );

      if (response) {
        await db
          .saveMessage({
            chat_id: chatId,
            role: "assistant",
            content: response,
            metadata: {
              telegram_chat_id: ctx.chat?.id,
              processed_by: NODE_ID,
              resumed_from_task: result.taskId,
            },
          })
          .catch(() => {});

        await sendResponse(ctx, response);
      }

      await db
        .updateTask(result.taskId, {
          status: "completed",
          result: response?.substring(0, 1000) || "Completed",
        })
        .catch(() => {});

      return;
    }

    // Direct API resume: task has messages_snapshot from direct Anthropic API
    if (result.task?.metadata?.messages_snapshot) {
      console.log(
        `Resuming from ask_user: task=${result.taskId}, choice="${result.choice}"`
      );
      await ctx
        .editMessageText(`Got it: "${result.choice}". Resuming...`)
        .catch(() => {});

      const resumeState: ResumeState = {
        taskId: result.taskId,
        messagesSnapshot: result.task.metadata.messages_snapshot,
        assistantContent: result.task.metadata.assistant_content,
        userChoice: result.choice,
        toolUseId: result.task.metadata.tool_use_id,
      };

      const response = await processWithAnthropic(
        result.task.original_prompt,
        chatId,
        ctx,
        resumeState
      );

      if (response) {
        await db
          .saveMessage({
            chat_id: chatId,
            role: "assistant",
            content: response,
            metadata: {
              telegram_chat_id: ctx.chat?.id,
              processed_by: NODE_ID,
              resumed_from_task: result.taskId,
            },
          })
          .catch(() => {});

        await sendResponse(ctx, response);
      }

      await db
        .updateTask(result.taskId, {
          status: "completed",
          result: response?.substring(0, 1000) || "Completed",
        })
        .catch(() => {});

      return;
    }

    // Mac-originated task or no snapshot: forward to Mac if alive
    if (isMacAlive() && MAC_PROCESS_URL) {
      const macResumeUrl = MAC_PROCESS_URL.replace("/process", "/resume");
      console.log(`[HYBRID] Forwarding HITL callback to Mac: task=${result.taskId}`);
      await ctx
        .editMessageText(`Got it: "${result.choice}". Resuming...`)
        .catch(() => {});

      try {
        const res = await fetch(macResumeUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${GATEWAY_SECRET}`,
          },
          body: JSON.stringify({
            taskId: result.taskId,
            choice: result.choice,
            sessionId: result.task?.session_id || null,
            originalPrompt: result.task?.original_prompt || "",
            pendingQuestion: result.task?.pending_question || null,
            chatId,
            threadId: result.task?.metadata?.topicId,
          }),
        });

        if (res.ok) {
          console.log(`[HYBRID] Mac accepted HITL resume for task=${result.taskId}`);
          return;
        }
        console.warn(`[HYBRID] Mac /resume returned ${res.status}, falling back to VPS`);
      } catch (err: any) {
        console.warn(`[HYBRID] Mac /resume failed: ${err.message}, falling back to VPS`);
      }
    }

    // Fallback: no snapshot, start fresh with context on VPS
    await ctx
      .editMessageText(`Got it: "${result.choice}". Resuming...`)
      .catch(() => {});

    const response = await processWithAnthropic(
      `Continue this task: ${result.task?.original_prompt}\n\nPrevious context: ${result.task?.current_step}\n\nUser chose: ${result.choice}`,
      chatId,
      ctx
    );
    await sendResponse(ctx, response);
    return;
  }
});

// ============================================================
// HEARTBEAT + STALE TASK CHECKER
// ============================================================

setInterval(async () => {
  await db.upsertHeartbeat(NODE_ID, {
    mac_alive: isMacAlive(),
    uptime: process.uptime(),
  });
}, 30_000);

db.upsertHeartbeat(NODE_ID, { started_at: new Date().toISOString() });

setInterval(async () => {
  const reminded = await checkStaleTasks(BOT_TOKEN, ALLOWED_USER_ID);
  if (reminded > 0) {
    console.log(`Sent ${reminded} task reminder(s)`);
  }
}, 15 * 60 * 1000);

// ============================================================
// START
// ============================================================

startHealthMonitor();

const server = Bun.serve({
  maxRequestBodySize: 256 * 1024,
  port: PORT,
  async fetch(req) {
    const url = new URL(req.url);

    const corsHeaders: Record<string, string> = {};

    // Health endpoint
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({
          status: "ok",
          service: "vps-gateway",
          revision: process.env.RELEASE_REVISION || "working-tree",
          node: NODE_ID,
          local_alive: isMacAlive(),
          uptime: Math.floor(process.uptime()),
          timestamp: new Date().toISOString(),
        }),
        {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        }
      );
    }

    // ElevenLabs voice agent context endpoint
    if (url.pathname === "/context" && req.method === "GET") {
      const denied = authorizeBearer(req, GATEWAY_SECRET);
      if (denied) return denied;
      try {
        console.log("Voice agent requesting context...");
        const context = await buildVoiceAgentContext();
        return new Response(JSON.stringify(context), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (error: any) {
        console.error("Context endpoint error:", error);
        return new Response(
          JSON.stringify({ error: "Failed to fetch context" }),
          {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders },
          }
        );
      }
    }

    // ElevenLabs post-call webhook
    if (url.pathname === "/webhook/elevenlabs" && req.method === "POST") {
      try {
        const rawBody = await req.text();
        const webhookSecret = process.env.ELEVENLABS_WEBHOOK_SECRET || "";
        if (!webhookSecret) return new Response("Webhook not configured", { status: 503 });
        if (!verifyElevenLabs(rawBody, req.headers.get("elevenlabs-signature"), webhookSecret))
          return new Response("Unauthorized", { status: 401 });
        const event = JSON.parse(rawBody);
        const payload = (event.data || event) as {
          conversation_id?: string;
          status?: string;
          transcript?: { role: string; message: string }[];
        };
        console.log(
          "ElevenLabs webhook received:",
          payload.conversation_id
        );

        if (!payload.conversation_id || !Array.isArray(payload.transcript) ||
            !payload.transcript.every(m => typeof m.role === "string" && typeof m.message === "string"))
          return new Response("Invalid transcript", { status: 400 });
        if (!claimWebhookEvent("elevenlabs", payload.conversation_id))
          return Response.json({ ok: true, duplicate: true });
        if ((payload.status === "done" || event.type === "post_call_transcription") && payload.transcript) {
          // Dedup: skip if already processed by polling
          if (payload.conversation_id && processedCallIds.has(payload.conversation_id)) {
            console.log(`Webhook transcript for ${payload.conversation_id} already processed (by polling), skipping`);
            return new Response(JSON.stringify({ ok: true, skipped: "already_processed" }), {
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          }
          if (payload.conversation_id) {
            processedCallIds.add(payload.conversation_id);
          }

          const botName = BOT_NAME;
          const transcriptText = payload.transcript
            .map(
              (msg) =>
                `${msg.role === "agent" ? botName : USER_NAME}: ${msg.message}`
            )
            .join("\n");

          const summary = await summarizeTranscript(transcriptText);
          const telegramMsg = `**Call Summary**\n\n${summary}`;

          await fetch(
            `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                chat_id: ALLOWED_USER_ID,
                text: telegramMsg,
                parse_mode: "HTML",
              }),
            }
          );

          await db
            .saveMessage({
              chat_id: ALLOWED_USER_ID,
              role: "assistant",
              content: `[Call transcript]\n${transcriptText}\n\n[Summary]\n${summary}`,
              metadata: {
                type: "phone_call",
                conversation_id: payload.conversation_id,
                processed_by: NODE_ID,
              },
            })
            .catch(() => {});

          // Extract and auto-execute any tasks from the call
          extractTaskFromTranscript(transcriptText, summary)
            .then(async (task) => {
              if (task) {
                console.log(
                  `Task detected from webhook call: "${task.length} chars"`
                );
                await executeCallTask(task, ALLOWED_USER_ID);
              }
            })
            .catch((err) =>
              console.error("Call task extraction failed:", err)
            );
        }

        return new Response(JSON.stringify({ ok: true }), {
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      } catch (error: any) {
        console.error("ElevenLabs webhook error:", error);
        return new Response(JSON.stringify({ error: error.message }), {
          status: 500,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        });
      }
    }

    // GitHub auto-deploy webhook
    if (url.pathname === "/deploy" && req.method === "POST") {
      if (!DEPLOY_SECRET) {
        return new Response("Deploy not configured", { status: 503 });
      }

      const body = await req.text();
      const signature = req.headers.get("x-hub-signature-256") || "";
      const expected =
        "sha256=" +
        createHmac("sha256", DEPLOY_SECRET).update(body).digest("hex");

      if (!secretMatches(signature, expected)) {
        console.log("Deploy webhook: invalid signature");
        return new Response("Invalid signature", { status: 401 });
      }

      try {
        const payload = JSON.parse(body) as { ref?: string };
        const deployBranch = process.env.DEPLOY_BRANCH || "refs/heads/master";
        if (payload.ref && payload.ref !== deployBranch) {
          return new Response(
            JSON.stringify({
              ok: true,
              skipped: `not ${deployBranch}`,
            }),
            { headers: { "Content-Type": "application/json" } }
          );
        }
      } catch {}

      console.log("Deploy webhook: valid push, deploying...");

      const deployScript =
        process.env.DEPLOY_SCRIPT || join(import.meta.dir, "..", "deploy.sh");
      const child = spawn("bash", [deployScript], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      return new Response(
        JSON.stringify({ ok: true, message: "Deploy started" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // Telegram webhook
    if (url.pathname === "/telegram" && req.method === "POST") {
      const secretToken = req.headers.get(
        "x-telegram-bot-api-secret-token"
      );
      if (!secretMatches(secretToken, GATEWAY_SECRET)) {
        return new Response("Unauthorized", { status: 401 });
      }

      try {
        const update = await req.json();
        if (!update || !Number.isSafeInteger(update.update_id)) return new Response("Invalid update", { status: 400 });
        bot.handleUpdate(update).catch((err: any) => {
          console.error(`Error handling update: ${err.message || err}`);
        });
      } catch (err) {
        console.error("Failed to parse webhook update");
        return new Response("Invalid update", { status: 400 });
      }

      return new Response("OK", { status: 200 });
    }

    return new Response("Not found", { status: 404 });
  },
});

const useAgentSDK = process.env.USE_AGENT_SDK === "true";
console.log(`
VPS Gateway started!
  Port: ${PORT}
  Node: ${NODE_ID}
  Bot: @${bot.botInfo.username}
  Webhook: /telegram
  Health: /health
  Context: /context (voice agent)
  Webhook: /webhook/elevenlabs
  Deploy: /deploy${DEPLOY_SECRET ? " [configured]" : " [NOT configured]"}
  Local health: ${process.env.MAC_HEALTH_URL || "(Supabase heartbeat only)"}
  Model routing: enabled (haiku/sonnet/opus)
  Agent SDK: ${useAgentSDK ? "enabled (sonnet/opus → full Claude Code)" : "disabled (direct API only)"}
  MCP tools: ${mcpManager.isReady ? mcpManager.getStatus() : "disabled"}
  Daily budget: $${process.env.DAILY_API_BUDGET || "5.00"}
`);

db.testConnection().catch(() => {});

// ============================================================
// STARTUP RECOVERY — Process missed calls from crashes
// ============================================================

/**
 * On startup, check ElevenLabs for recent completed conversations
 * that were never processed (e.g. gateway crashed during a call).
 * Fetches conversations from the last 30 minutes and processes any
 * that don't already exist in Supabase.
 */
async function recoverMissedCalls(): Promise<void> {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  if (!apiKey || !agentId) return;

  try {
    console.log("Checking for missed call transcripts...");

    const res = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversations?agent_id=${agentId}`,
      { headers: { "xi-api-key": apiKey } }
    );

    if (!res.ok) {
      console.error(`Failed to fetch recent conversations: ${res.status}`);
      return;
    }

    const data = (await res.json()) as {
      conversations?: {
        conversation_id: string;
        status: string;
        start_time_unix_secs?: number;
      }[];
    };

    if (!data.conversations?.length) {
      console.log("No recent conversations found.");
      return;
    }

    const thirtyMinAgo = Date.now() / 1000 - 30 * 60;
    const candidates = data.conversations.filter(
      (c) =>
        c.status === "done" &&
        c.start_time_unix_secs &&
        c.start_time_unix_secs > thirtyMinAgo
    );

    if (candidates.length === 0) {
      console.log("No missed calls to recover.");
      return;
    }

    console.log(
      `Found ${candidates.length} recent completed call(s), checking if already processed...`
    );

    // Check Supabase for each conversation_id
    const sb = db.getSupabase();

    for (const conv of candidates) {
      // Skip if already in our in-memory dedup set
      if (processedCallIds.has(conv.conversation_id)) {
        continue;
      }

      // Check Supabase for existing transcript
      let alreadySaved = false;
      if (sb) {
        try {
          const { data: existing } = await sb
            .from("messages")
            .select("id")
            .contains("metadata", { conversation_id: conv.conversation_id })
            .limit(1);
          alreadySaved = !!(existing && existing.length > 0);
        } catch {
          // If query fails, attempt recovery anyway
        }
      }

      if (alreadySaved) {
        processedCallIds.add(conv.conversation_id);
        console.log(
          `Call ${conv.conversation_id} already in Supabase, skipping.`
        );
        continue;
      }

      // Fetch and process the missed transcript
      console.log(`Recovering missed call: ${conv.conversation_id}`);
      processedCallIds.add(conv.conversation_id);

      const transcript = await getCallTranscript(conv.conversation_id);
      if (!transcript) {
        console.log(
          `Could not fetch transcript for ${conv.conversation_id}, skipping.`
        );
        continue;
      }

      const summary = await summarizeTranscript(transcript);
      const chatId = ALLOWED_USER_ID;

      // Send summary to Telegram
      const summaryMsg = `**Recovered Call Summary**\n_(missed during downtime)_\n\n${summary}\n\n_Full transcript saved._`;
      await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text: summaryMsg,
          parse_mode: "HTML",
        }),
      }).catch(() => {
        fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: stripHtmlTags(markdownToTelegramHTML(summaryMsg)),
          }),
        }).catch(() => {});
      });

      // Save to Supabase
      await db
        .saveMessage({
          chat_id: chatId,
          role: "assistant",
          content: `[Phone call transcript - recovered]\n${transcript}\n\n[Summary]\n${summary}`,
          metadata: {
            type: "phone_call",
            conversation_id: conv.conversation_id,
            processed_by: NODE_ID,
            recovered: true,
          },
        })
        .catch(() => {});

      // Extract and execute tasks
      extractTaskFromTranscript(transcript, summary)
        .then(async (task) => {
          if (task) {
            console.log(
              `Task detected from recovered call: "${task.length} chars"`
            );
            await executeCallTask(task, chatId);
          }
        })
        .catch((err) =>
          console.error("Recovered call task extraction failed:", err)
        );

      console.log(`Successfully recovered call ${conv.conversation_id}`);
    }
  } catch (err: any) {
    console.error("Call recovery error:", err.message);
  }
}

// Run recovery after server is ready (non-blocking)
recoverMissedCalls().catch((err) =>
  console.error("Startup call recovery failed:", err)
);

// Updated February 2026: Clarified deployment modes and authentication following Anthropic's January 2026 ToS enforcement.
