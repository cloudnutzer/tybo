/**
 * Async Task Queue -- Human-in-the-Loop
 *
 * Manages long-running Claude tasks that may need user input.
 * Works identically on Mac and VPS.
 *
 * Flow:
 * 1. User sends message -> task created (status: running)
 * 2. Claude processes via Anthropic API
 * 3. If Claude calls ask_user tool -> inline keyboard buttons sent -> status: needs_input
 * 4. User taps button -> task resumed with saved state -> status: running
 * 5. Task completes -> status: completed
 */

import { InlineKeyboard } from "grammy";
import type { Context } from "grammy";
import { guardTelegramPayload } from "./telegram";
import {
  createTask,
  updateTask,
  getTaskById,
  getPendingTasks,
  getRunningTasks,
  getStaleTasks,
  type AsyncTask,
} from "./convex";

// ============================================================
// RESPONSE PARSING -- Detect questions in Claude output
// ============================================================

interface ParsedResponse {
  text: string;
  needsInput: boolean;
  question: string | null;
  options: { label: string; value: string }[];
}

/**
 * Parse Claude's output to detect questions and choice points
 */
export function parseClaudeResponse(output: string): ParsedResponse {
  const text = output.trim();

  if (!text) {
    return { text: "", needsInput: false, question: null, options: [] };
  }

  // Detect numbered options (1. Option A  2. Option B)
  const numberedPattern = /(?:^|\n)\s*(\d+)\.\s+(.+)/g;
  const numberedMatches: { label: string; value: string }[] = [];
  let match;

  while ((match = numberedPattern.exec(text)) !== null) {
    const label = match[2].trim().substring(0, 64);
    numberedMatches.push({
      label: `${match[1]}. ${label}`,
      value: match[1],
    });
  }

  // Detect if the response ends with a question
  const lines = text.split("\n").filter((l) => l.trim());
  const lastLine = lines[lines.length - 1]?.trim() || "";
  const hasQuestion = lastLine.endsWith("?");

  // Detect explicit choice markers
  const choiceMarkers = [
    "which would you prefer",
    "which do you prefer",
    "what would you like",
    "which should i",
    "which option",
    "please choose",
    "please select",
    "would you like me to",
    "should i",
    "do you want me to",
    "what do you think",
    "your preference",
    "your choice",
  ];
  const lowerText = text.toLowerCase();
  const hasChoiceMarker = choiceMarkers.some((m) => lowerText.includes(m));

  const needsInput =
    hasQuestion && (numberedMatches.length >= 2 || hasChoiceMarker);

  let options = numberedMatches;
  if (needsInput && options.length === 0) {
    const yesNoPatterns = [
      /should i/i,
      /would you like me to/i,
      /do you want me to/i,
      /shall i/i,
      /can i proceed/i,
      /go ahead/i,
    ];
    const isYesNo = yesNoPatterns.some((p) => p.test(lastLine));
    if (isYesNo) {
      options = [
        { label: "Yes, go ahead", value: "yes" },
        { label: "No, skip", value: "no" },
      ];
    }
  }

  return {
    text,
    needsInput,
    question: needsInput ? lastLine : null,
    options: options.slice(0, 6),
  };
}

// ============================================================
// INLINE KEYBOARD BUILDER
// ============================================================

/**
 * Build inline keyboard for task options
 */
export function buildTaskKeyboard(
  taskId: string,
  options: { label: string; value: string }[]
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const opt of options) {
    keyboard.text(opt.label, `atask:${taskId}:${opt.value}`).row();
  }

  // Always add a cancel option
  keyboard.text("Cancel task", `atask:${taskId}:cancel`);

  return keyboard;
}

// ============================================================
// TASK RESPONSE HANDLER
// ============================================================

/**
 * Handle a task response from Claude -- detect questions, update status
 */
export async function handleTaskResponse(
  taskId: string,
  claudeOutput: string,
  sessionId: string | null,
  ctx?: Context
): Promise<{ needsInput: boolean; response: ParsedResponse }> {
  const parsed = parseClaudeResponse(claudeOutput);

  if (parsed.needsInput && parsed.options.length > 0) {
    await updateTask(taskId, {
      status: "needs_input",
      session_id: sessionId || undefined,
      current_step: parsed.text.substring(0, 500),
      pending_question: parsed.question || undefined,
      pending_options: parsed.options,
    });

    if (ctx) {
      const keyboard = buildTaskKeyboard(taskId, parsed.options);
      await ctx
        .reply(parsed.text, {
          reply_markup: keyboard,
          parse_mode: "HTML",
        })
        .catch(() =>
          ctx.reply(parsed.text, { reply_markup: keyboard })
        );
    }
  } else {
    await updateTask(taskId, {
      status: "completed",
      session_id: sessionId || undefined,
      result: parsed.text.substring(0, 10000),
    });
  }

  return { needsInput: parsed.needsInput, response: parsed };
}

// ============================================================
// CALLBACK HANDLER
// ============================================================

/**
 * Handle user tapping an inline button for an async task.
 * Returns the user's choice text for resuming Claude.
 */
export async function handleTaskCallback(
  callbackData: string
): Promise<{
  taskId: string;
  choice: string;
  task: AsyncTask | null;
  cancelled: boolean;
} | null> {
  // Format: "atask:TASK_ID:VALUE"
  const parts = callbackData.split(":");
  if (parts.length < 3 || parts[0] !== "atask") return null;

  const taskId = parts[1];
  const choice = parts.slice(2).join(":");
  const task = await getTaskById(taskId);

  if (!task) return null;

  if (choice === "cancel") {
    await updateTask(taskId, {
      status: "failed",
      result: "Cancelled by user",
    });
    return { taskId, choice, task, cancelled: true };
  }

  // Map numeric choice back to option label for context
  let choiceText = choice;
  if (task.pending_options) {
    const option = task.pending_options.find((o) => o.value === choice);
    if (option) choiceText = option.label;
  }

  await updateTask(taskId, {
    status: "running",
    user_response: choiceText,
    pending_question: undefined,
    pending_options: undefined,
  });

  return { taskId, choice: choiceText, task, cancelled: false };
}

// ============================================================
// STATUS DISPLAY
// ============================================================

/**
 * Format task status for /tasks command
 */
export async function formatTaskStatus(chatId: string): Promise<string> {
  const pending = await getPendingTasks(chatId);
  const running = await getRunningTasks(chatId);

  if (pending.length === 0 && running.length === 0) {
    return "No active tasks. Send me something to work on!";
  }

  let msg = "";

  if (running.length > 0) {
    msg += "**Running:**\n";
    for (const t of running) {
      const age = Math.round(
        (Date.now() - new Date(t.created_at).getTime()) / 60000
      );
      msg += `- ${t.original_prompt.substring(0, 60)}... (${age}min)\n`;
    }
  }

  if (pending.length > 0) {
    msg += "\n**Waiting for your input:**\n";
    for (const t of pending) {
      msg += `- ${t.pending_question || t.original_prompt.substring(0, 60)}\n`;
    }
  }

  return msg;
}

// ============================================================
// STALE TASK REMINDERS
// ============================================================

/**
 * Check for stale tasks and send reminders
 */
export async function checkStaleTasks(
  botToken: string,
  chatId: string,
  thresholdMs: number = 2 * 60 * 60 * 1000
): Promise<number> {
  const stale = await getStaleTasks(thresholdMs);
  let reminded = 0;

  for (const task of stale) {
    if (task.chat_id !== chatId) continue;

    const keyboard = buildTaskKeyboard(task.id, task.pending_options || []);

    const msg = `**Reminder:** I'm still waiting for your input on this task:\n\n${
      task.pending_question || task.original_prompt.substring(0, 200)
    }`;

    try {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Issue #52: Frage stammt vom Modell, also Vorschau aus und bereinigt
        body: JSON.stringify(
          guardTelegramPayload("sendMessage", {
            chat_id: chatId,
            text: msg,
            parse_mode: "HTML",
            reply_markup: keyboard,
          })
        ),
      });

      await updateTask(task.id, { reminder_sent: true });
      reminded++;
    } catch (err) {
      console.error(`Failed to send reminder for task ${task.id}:`, err);
    }
  }

  return reminded;
}
