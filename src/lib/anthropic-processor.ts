import { BRAND } from "../brand";
import { runExecution, checkAborted, executionSignal } from "./execution-context";
import { authorizeTool } from "./tools/registry";
/**
 * Anthropic API Processor — Direct API for VPS mode
 *
 * Uses Anthropic Messages API with client-side tool definitions.
 * VPS mode processes messages when the local machine is offline.
 *
 * Tools: Ask User (human-in-the-loop), Phone Call
 *
 * For external service access (Gmail, Calendar, Notion, etc.), students
 * connect MCP servers on their local machine. VPS mode uses Supabase
 * context (memory, goals, conversation history) for awareness.
 *
 * All tool descriptions and system prompt are generalized via env vars.
 * Configure USER_NAME, USER_EMAIL, USER_TIMEZONE, etc. in .env.
 */

import Anthropic from "@anthropic-ai/sdk";
import * as db from "./convex";
import { initiatePhoneCall } from "./voice";
import { buildTaskKeyboard } from "./task-queue";
import { callFallbackLLM } from "./fallback-llm";
import { TELEGRAM_FORMAT_RULES } from "./telegram";
import {
  getResilientClient,
  createResilientMessage,
  getModelForProvider,
} from "./resilient-client";
import { mcpManager } from "./mcp-client";
import type { Context } from "grammy";

export interface StreamCallbacks {
  onToolStart?: (toolName: string) => void;
  onTextDelta?: (accumulated: string) => void;
}

// ============================================================
// TIME RESOLUTION — parse scheduled time strings to epoch ms
// ============================================================

function resolveScheduledTime(input: string): number | null {
  if (!input) return null;

  // Try ISO 8601 parse (e.g. "2026-03-10T17:00:00+01:00")
  const isoDate = new Date(input);
  if (!isNaN(isoDate.getTime())) return isoDate.getTime();

  // Try relative patterns
  const lower = input.trim().toLowerCase();
  const now = new Date();

  // "in X hours/minutes"
  const relMatch = lower.match(
    /^in\s+(\d+)\s*(h(?:ours?)?|m(?:in(?:ute)?s?)?)$/
  );
  if (relMatch) {
    const val = parseInt(relMatch[1], 10);
    const unit = relMatch[2].startsWith("h") ? 3600000 : 60000;
    return now.getTime() + val * unit;
  }

  // "HH:MM" or "Hpm/am"
  const timeMatch = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const meridiem = timeMatch[3];

    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;

    now.setHours(hours, minutes, 0, 0);
    if (now.getTime() < Date.now()) {
      now.setDate(now.getDate() + 1);
    }
    return now.getTime();
  }

  return null;
}

// ============================================================
// ASK USER SIGNAL — thrown when Claude needs user input
// ============================================================

export class AskUserSignal {
  question: string;
  options: { label: string; value: string }[];
  toolUseId: string;
  messages: Anthropic.MessageParam[];
  assistantContent: Anthropic.ContentBlock[];

  constructor(
    question: string,
    options: { label: string; value: string }[],
    toolUseId: string,
    messages: Anthropic.MessageParam[],
    assistantContent: Anthropic.ContentBlock[]
  ) {
    this.question = question;
    this.options = options;
    this.toolUseId = toolUseId;
    this.messages = messages;
    this.assistantContent = assistantContent;
  }
}

// ============================================================
// RESUME STATE — passed when continuing from ask_user pause
// ============================================================

export interface ResumeState {
  taskId: string;
  messagesSnapshot: Anthropic.MessageParam[];
  assistantContent: Anthropic.ContentBlock[];
  userChoice: string;
  toolUseId: string;
}

// ============================================================
// ANTHROPIC CLIENT
// ============================================================

function getClient(): Anthropic {
  return getResilientClient();
}

// ============================================================
// TOOL DEFINITIONS
// ============================================================

function buildToolDefinitions(): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [
    {
      name: "phone_call",
      description:
        "Initiate a phone call via ElevenLabs voice agent. Use when user says 'call me', 'ring me', or wants a voice conversation. Provide context about what to discuss.",
      input_schema: {
        type: "object" as const,
        properties: {
          context: {
            type: "string",
            description:
              "Context/reason for the call. What should be discussed on the call.",
          },
        },
        required: ["context"],
      },
    },
    {
      name: "ask_user",
      description:
        "Ask the user a question and wait for their response before continuing. Use this when you need confirmation before taking a significant action or when you need the user to choose between options. The conversation will pause until the user responds via Telegram buttons.",
      input_schema: {
        type: "object" as const,
        properties: {
          question: {
            type: "string",
            description: "The question to ask the user",
          },
          options: {
            type: "array",
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description: "Button label shown to user (max 64 chars)",
                },
                value: {
                  type: "string",
                  description:
                    "Value returned when user clicks this option",
                },
              },
              required: ["label", "value"],
            },
            description:
              "Array of options for the user to choose from. Defaults to Yes/No if not provided.",
          },
        },
        required: ["question"],
      },
    },
    {
      name: "schedule_task",
      description:
        "Schedule a reminder, action, or recurring task. Use when the user says 'remind me', 'at 5pm', 'in 2 hours', 'later today', 'every morning', 'check emails tonight', etc. The task fires at the scheduled time via Telegram message.",
      input_schema: {
        type: "object" as const,
        properties: {
          type: {
            type: "string",
            enum: ["reminder", "action", "recurring"],
            description:
              "reminder = just notify. action = notify with prompt to execute. recurring = repeats on schedule.",
          },
          prompt: {
            type: "string",
            description:
              "What to remind about or what action to take. Be specific.",
          },
          scheduledTime: {
            type: "string",
            description:
              "ISO 8601 datetime with timezone offset (e.g. '2026-03-10T17:00:00+01:00'). Compute from current time shown in system prompt. For relative times like 'in 2 hours', calculate the absolute time.",
          },
          recurrence: {
            type: "string",
            description:
              "Only for type=recurring. Pattern: 'daily', 'hourly', 'weekdays', 'weekly', 'every 2h', 'every 30m'.",
          },
        },
        required: ["type", "prompt", "scheduledTime"],
      },
    },
    {
      name: "list_scheduled_tasks",
      description:
        "List the user's scheduled tasks. Use when user asks 'what's scheduled?', 'show my reminders', 'upcoming tasks'.",
      input_schema: {
        type: "object" as const,
        properties: {
          status: {
            type: "string",
            enum: ["pending", "fired", "cancelled"],
            description: "Filter by status. Defaults to 'pending' (upcoming).",
          },
        },
        required: [],
      },
    },
    {
      name: "cancel_scheduled_task",
      description:
        "Cancel a scheduled task by matching its description. Use when user says 'cancel the 5pm reminder', 'remove the email check', etc.",
      input_schema: {
        type: "object" as const,
        properties: {
          searchText: {
            type: "string",
            description:
              "Text to match against task prompts. Partial match works (e.g. 'email' matches 'check emails').",
          },
        },
        required: ["searchText"],
      },
    },
  ];

  // Only include tools that have their dependencies configured
  const filtered = tools.filter((tool) => {
    switch (tool.name) {
      case "phone_call":
        return !!(
          process.env.ELEVENLABS_API_KEY && process.env.ELEVENLABS_AGENT_ID
        );
      case "schedule_task":
      case "list_scheduled_tasks":
      case "cancel_scheduled_task":
        return !!process.env.CONVEX_URL; // Requires Convex
      case "ask_user":
        return true; // Always available
      default:
        return true;
    }
  });

  // Merge gateway tools (MCP servers + built-ins) if MCPManager is active
  if (mcpManager.isReady && mcpManager.toolCount > 0) {
    filtered.push(...mcpManager.getAnthropicTools());
  }

  return filtered;
}

// ============================================================
// TOOL EXECUTOR
// ============================================================

async function executeTool(
  name: string,
  input: Record<string, any>,
  toolUseId: string,
  messages: Anthropic.MessageParam[],
  assistantContent: Anthropic.ContentBlock[],
  onCallInitiated?: (conversationId: string) => void
): Promise<string> {
  checkAborted();
  if (["phone_call", "schedule_task", "cancel_scheduled_task"].includes(name)) {
    const denied = await authorizeTool({ name, description: "Agent action", requiresApproval: true,
      inputSchema: { type: "object", properties: {} }, isAvailable: () => true, handler: async () => "" }, input);
    if (denied) return denied.content;
  }
  try {
    switch (name) {
      case "phone_call": {
        const result = await initiatePhoneCall(input.context);
        if (result.success && result.conversationId && onCallInitiated) {
          onCallInitiated(result.conversationId);
        }
        return JSON.stringify(result);
      }

      case "ask_user": {
        const options: { label: string; value: string }[] = input.options || [
          { label: "Yes, go ahead", value: "yes" },
          { label: "No, skip", value: "no" },
        ];
        // Throw signal to pause the loop
        throw new AskUserSignal(
          input.question,
          options,
          toolUseId,
          messages,
          assistantContent
        );
      }

      case "schedule_task": {
        const scheduledMs = resolveScheduledTime(input.scheduledTime);
        if (!scheduledMs) {
          return JSON.stringify({
            error: `Could not parse time: ${input.scheduledTime}`,
          });
        }

        const chatId =
          process.env.TELEGRAM_USER_ID || process.env.TELEGRAM_CHAT_ID || "";
        const taskId = await db.createScheduledTask(
          chatId,
          input.type,
          input.prompt,
          scheduledMs,
          input.recurrence
        );

        if (!taskId) {
          return JSON.stringify({ error: "Failed to create scheduled task" });
        }

        const scheduledDate = new Date(scheduledMs);
        const tz = process.env.USER_TIMEZONE || "UTC";
        const formatted = scheduledDate.toLocaleString("en-US", {
          timeZone: tz,
          weekday: "short",
          month: "short",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });

        return JSON.stringify({
          success: true,
          taskId,
          type: input.type,
          scheduledFor: formatted,
          prompt: input.prompt,
          recurrence: input.recurrence || null,
        });
      }

      case "list_scheduled_tasks": {
        const chatId =
          process.env.TELEGRAM_USER_ID || process.env.TELEGRAM_CHAT_ID || "";
        const status = input.status || "pending";
        const tasks = await db.listScheduledTasks(chatId, status);

        if (tasks.length === 0) {
          return JSON.stringify({
            tasks: [],
            message: `No ${status} scheduled tasks.`,
          });
        }

        const tz = process.env.USER_TIMEZONE || "UTC";
        const formatted = tasks.map((t, i) => ({
          index: i + 1,
          type: t.type,
          prompt: t.prompt,
          scheduledFor: new Date(t.scheduled_at).toLocaleString("en-US", {
            timeZone: tz,
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            hour12: true,
          }),
          recurrence: t.recurrence || null,
          status: t.status,
        }));

        return JSON.stringify({ tasks: formatted });
      }

      case "cancel_scheduled_task": {
        const chatId =
          process.env.TELEGRAM_USER_ID || process.env.TELEGRAM_CHAT_ID || "";
        const cancelled = await db.cancelScheduledTask(
          chatId,
          input.searchText
        );

        return JSON.stringify({
          success: cancelled,
          message: cancelled
            ? `Cancelled task matching "${input.searchText}"`
            : `No pending task found matching "${input.searchText}"`,
        });
      }

      default: {
        // Route to MCPManager if it knows this tool
        if (mcpManager.hasTool(name)) {
          const result = await mcpManager.callTool(name, input);
          return result.content;
        }
        return JSON.stringify({ error: `Unknown tool: ${name}` });
      }
    }
  } catch (err: any) {
    // Re-throw AskUserSignal — it's not an error
    if (err instanceof AskUserSignal) throw err;

    console.error(`Tool ${name} error:`, err.message);
    return JSON.stringify({ error: err.message });
  }
}

// ============================================================
// MESSAGE COMPRESSION — truncate tool results before storing
// ============================================================

function compressMessages(
  messages: Anthropic.MessageParam[]
): Anthropic.MessageParam[] {
  return messages.map((msg) => {
    if (typeof msg.content === "string") {
      return { ...msg, content: msg.content.substring(0, 2000) };
    }
    if (Array.isArray(msg.content)) {
      const compressed = msg.content.map((block: any) => {
        if (
          block.type === "tool_result" &&
          typeof block.content === "string"
        ) {
          return { ...block, content: block.content.substring(0, 500) };
        }
        if (block.type === "text" && typeof block.text === "string") {
          return { ...block, text: block.text.substring(0, 2000) };
        }
        return block;
      });
      return { ...msg, content: compressed };
    }
    return msg;
  });
}

// ============================================================
// SYSTEM PROMPT
// ============================================================

function buildSystemPrompt(): string {
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

  return `You are ${botName}, ${userName}'s AI assistant, responding via Telegram.

Current time: ${localTime} (${userTimezone})
Processing node: VPS (local machine may be offline)

AVAILABLE TOOLS:
- ask_user: Ask the user a question via inline buttons. Use BEFORE any irreversible action.
${process.env.ELEVENLABS_API_KEY ? "- phone_call: Initiate a voice call via ElevenLabs" : ""}
${process.env.CONVEX_URL ? `- schedule_task: Schedule reminders, actions, or recurring tasks. Use for "remind me at 5pm", "check emails tonight", "every morning at 9am", etc. Compute absolute ISO 8601 datetime from current time.
- list_scheduled_tasks: Show upcoming/pending scheduled tasks.
- cancel_scheduled_task: Cancel a scheduled task by matching its description.` : ""}

${mcpManager.isReady && mcpManager.toolCount > 0
    ? `EXTERNAL TOOLS AVAILABLE: ${mcpManager.toolCount} tools (MCP servers + ${BRAND.name} built-ins:
web search/scraping via Firecrawl, Apify actors, sending files/voice messages to the
user via Telegram, Cloudflare deployment status).
Use them when the user asks to interact with these services.`
    : `NOTE: External service integrations (Gmail, Calendar, Notion, etc.) are available
on the local machine via MCP servers. When the local machine is offline, you can
still have conversations, answer questions, and use your knowledge. For tasks that
require external service access, let the user know you'll handle it when the local
machine is back online, or use ask_user to confirm actions.`}

HUMAN-IN-THE-LOOP (CRITICAL):
- Use ask_user tool BEFORE taking irreversible actions
- ask_user pauses the conversation and sends buttons to Telegram
- The user will tap a button, and the conversation resumes with their choice
- Always provide clear options (e.g. "Should I proceed?" with Yes/No)

IMPORTANT BEHAVIORS:
- Keep responses concise (Telegram-friendly, max 2-3 paragraphs)
- Use ask_user tool for confirmations instead of just asking in text
- When user sends a short reply (like "1", "yes", "no"), check conversation context
- Be helpful and proactive with what you CAN do (reasoning, planning, advice)

${TELEGRAM_FORMAT_RULES}

LIMITATIONS (CRITICAL):
- You CANNOT modify your own code, server, or configuration
- You CANNOT restart services, deploy updates, or fix bugs in yourself
- You CANNOT access the filesystem of the server you run on
- If something is broken, tell the user clearly — do NOT promise to fix it yourself
- Never say "I'll look into that", "Let me debug this", or "I'll fix that" about your own systems

INTENT DETECTION - Include at END of response when relevant:
- [GOAL: goal text | DEADLINE: optional] — for goals/tasks
- [DONE: what was completed] — ONLY when user explicitly states they finished something. Use the full goal text, not a vague summary.
- [CANCEL: partial match] — for cancelling/abandoning a goal
- [REMEMBER: fact] — for important facts to remember
- [FORGET: partial match] — for removing a stored fact`;
}

// ============================================================
// MAIN PROCESSOR
// ============================================================

async function processWithAnthropicUnlocked(
  userMessage: string,
  chatId: string,
  ctx: Context,
  resumeState?: ResumeState,
  onCallInitiated?: (conversationId: string) => void,
  model?: string,
  streamCallbacks?: StreamCallbacks
): Promise<string> {
  const startTime = Date.now();
  const effectiveModel = getModelForProvider(
    model || process.env.ANTHROPIC_MODEL || "claude-opus-5-5"
  );

  // Get conversation context from Supabase
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

  const systemPrompt = buildSystemPrompt() + contextStr;
  const tools = buildToolDefinitions();

  let messages: Anthropic.MessageParam[];

  if (resumeState) {
    // Resume from ask_user pause — restore messages + inject user's choice
    console.log(
      `Resuming from ask_user (task ${resumeState.taskId}): "${resumeState.userChoice}"`
    );
    messages = [
      ...resumeState.messagesSnapshot,
      // Re-add the assistant message that contained the ask_user tool_use
      { role: "assistant" as const, content: resumeState.assistantContent },
      // Add the tool result with user's choice
      {
        role: "user" as const,
        content: [
          {
            type: "tool_result" as const,
            tool_use_id: resumeState.toolUseId,
            content: `User chose: ${resumeState.userChoice}`,
          },
        ],
      },
    ];
  } else {
    messages = [{ role: "user", content: userMessage }];
  }

  const MAX_ITERATIONS = 15;
  let iterations = 0;
  let totalToolCalls = 0;

  // Send typing indicator
  const typingInterval = setInterval(() => {
    ctx.replyWithChatAction("typing").catch(() => {});
  }, 4000);
  ctx.replyWithChatAction("typing").catch(() => {});

  try {
    while (iterations < MAX_ITERATIONS) {
      checkAborted();
      iterations++;

      let response: Anthropic.Message;

      if (streamCallbacks) {
        const anthropic = getClient();
        const stream = anthropic.messages.stream({
          model: effectiveModel,
          max_tokens: 4096,
          system: systemPrompt,
          tools,
          messages,
        }, { signal: executionSignal(300_000) });

        let textAccumulator = "";

        stream.on("streamEvent", (event) => {
          if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
            streamCallbacks.onToolStart?.(event.content_block.name || "tool");
          }
        });

        stream.on("text", (text: string) => {
          textAccumulator += text;
          streamCallbacks.onTextDelta?.(textAccumulator);
        });

        response = await stream.finalMessage();
      } else {
        response = await createResilientMessage({
          model: effectiveModel,
          max_tokens: 4096,
          system: systemPrompt,
          tools,
          messages,
        });
      }

      // Check if we're done (no more tool calls)
      if (
        response.stop_reason === "end_turn" ||
        response.stop_reason === "stop_sequence"
      ) {
        const textBlocks = response.content.filter(
          (b): b is Anthropic.TextBlock => b.type === "text"
        );
        const result = textBlocks.map((b) => b.text).join("\n");

        const elapsed = Date.now() - startTime;
        console.log(
          `Anthropic API: ${iterations} iterations, ${totalToolCalls} tool calls, ${elapsed}ms`
        );

        return result || "Processed but no response generated.";
      }

      // Handle tool calls
      if (response.stop_reason === "tool_use") {
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const block of response.content) {
          if (block.type === "tool_use") {
            totalToolCalls++;
            console.log(
              `Tool call: ${block.name}(${JSON.stringify(block.input).substring(0, 100)})`
            );

            try {
              const result = await executeTool(
                block.name,
                block.input as Record<string, any>,
                block.id,
                messages,
                response.content,
                onCallInitiated
              );

              toolResults.push({
                type: "tool_result",
                tool_use_id: block.id,
                content: result,
              });
            } catch (signal) {
              if (signal instanceof AskUserSignal) {
                // Pause the loop — save state and send buttons
                const task = await db.createTask(
                  chatId,
                  userMessage || "resumed task",
                  ctx.message?.message_thread_id,
                  "vps"
                );

                if (task) {
                  // Save compressed messages snapshot + assistant content
                  await db.updateTask(task.id, {
                    status: "needs_input",
                    pending_question: signal.question,
                    pending_options: signal.options,
                    current_step: `ask_user: ${signal.question}`,
                    metadata: {
                      messages_snapshot: compressMessages(messages),
                      assistant_content: response.content,
                      tool_use_id: signal.toolUseId,
                    },
                  });

                  // Send inline keyboard to Telegram
                  const keyboard = buildTaskKeyboard(
                    task.id,
                    signal.options
                  );
                  await ctx
                    .reply(signal.question, {
                      reply_markup: keyboard,
                      parse_mode: "HTML",
                    })
                    .catch(() =>
                      ctx.reply(signal.question, { reply_markup: keyboard })
                    );
                } else {
                  // Fallback: can't save state, just show the question as text
                  return signal.question;
                }

                const elapsed = Date.now() - startTime;
                console.log(
                  `Anthropic API paused (ask_user): ${iterations} iterations, ${totalToolCalls} tool calls, ${elapsed}ms`
                );

                // Return empty — the response was already sent via buttons
                return "";
              }
              throw signal; // Re-throw unknown errors
            }
          }
        }

        // Add assistant response + tool results to messages
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: toolResults });
      }
    }

    return "Reached maximum iterations. Try a simpler request.";
  } catch (err: any) {
    console.error("Anthropic API error:", err.message);

    // Try fallback LLMs before returning an error
    console.log("🔄 VPS: Anthropic API failed, trying fallback LLMs...");
    try {
      const fallbackResponse = await callFallbackLLM(userMessage);
      return fallbackResponse;
    } catch (fallbackErr) {
      console.error("❌ Fallback also failed:", fallbackErr);
    }

    if (err.status === 401) {
      return "API authentication error. Check ANTHROPIC_API_KEY.";
    }
    if (err.status === 429) {
      return "Rate limited and fallback unavailable. Please try again in a moment.";
    }

    return `Error: ${err.message}`;
  } finally {
    clearInterval(typingInterval);
  }
}

export async function processWithAnthropic(...args: Parameters<typeof processWithAnthropicUnlocked>): Promise<string> {
  const key = db.sessionKeyFor(args[1], args[2].msg?.message_thread_id ?? null);
  return runExecution(key, "general", () => processWithAnthropicUnlocked(...args));
}
