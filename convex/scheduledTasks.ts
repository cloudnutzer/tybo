import { requireOwner } from "./auth";
import {
  mutation,
  query,
  internalMutation,
  internalQuery,
  internalAction,
} from "./_generated/server";
import { api, internal } from "./_generated/api";
import { v } from "convex/values";

// ============================================================
// PUBLIC: Create a scheduled task
// ============================================================

export const create = mutation({
  args: {
    chatId: v.string(),
    type: v.union(
      v.literal("reminder"),
      v.literal("action"),
      v.literal("recurring")
    ),
    prompt: v.string(),
    scheduledAt: v.number(), // epoch ms
    recurrence: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    if (!Number.isFinite(args.scheduledAt) || args.scheduledAt < Date.now() - 60_000) throw new Error("Invalid scheduledAt");
    if (args.type === "recurring" && !args.recurrence) throw new Error("Recurrence required");
    if (args.recurrence && computeNextFireTime(args.scheduledAt, args.recurrence) === null) throw new Error("Invalid recurrence");
    const now = Date.now();

    const taskId = await ctx.db.insert("scheduledTasks", {
      createdAt: now,
      updatedAt: now,
      chatId: args.chatId,
      type: args.type,
      prompt: args.prompt,
      scheduledAt: args.scheduledAt,
      status: "pending",
      recurrence: args.recurrence,
      metadata: args.metadata ?? {},
    });

    // Use Convex's built-in durable scheduler
    const scheduledId = await ctx.scheduler.runAt(
      args.scheduledAt,
      internal.scheduledTasks.fire,
      { taskId }
    );

    await ctx.db.patch(taskId, {
      convexScheduledId: scheduledId.toString(),
    });

    return taskId;
  },
});

// ============================================================
// PUBLIC: List scheduled tasks
// ============================================================

export const list = query({
  args: {
    chatId: v.string(),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("fired"),
        v.literal("cancelled")
      )
    ),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    if (args.status) {
      return await ctx.db
        .query("scheduledTasks")
        .withIndex("by_chatId_status", (q) =>
          q.eq("chatId", args.chatId).eq("status", args.status!)
        )
        .order("asc")
        .collect();
    }
    return await ctx.db
      .query("scheduledTasks")
      .withIndex("by_chatId", (q) => q.eq("chatId", args.chatId))
      .order("desc")
      .take(50);
  },
});

// ============================================================
// PUBLIC: Get a task by ID
// ============================================================

export const getById = query({
  args: { id: v.id("scheduledTasks") },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db.get(args.id);
  },
});

// ============================================================
// PUBLIC: Cancel a task by ID
// ============================================================

export const cancel = mutation({
  args: { id: v.id("scheduledTasks") },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const task = await ctx.db.get(args.id);
    if (!task || task.status !== "pending") return false;

    if (task.convexScheduledId) {
      try {
        await ctx.scheduler.cancel(task.convexScheduledId as any);
      } catch {
        // May already have fired
      }
    }

    await ctx.db.patch(args.id, {
      status: "cancelled",
      updatedAt: Date.now(),
    });

    return true;
  },
});

// ============================================================
// PUBLIC: Cancel by prompt text match
// ============================================================

export const cancelBySearch = mutation({
  args: {
    chatId: v.string(),
    searchText: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const pending = await ctx.db
      .query("scheduledTasks")
      .withIndex("by_chatId_status", (q) =>
        q.eq("chatId", args.chatId).eq("status", "pending")
      )
      .collect();

    const lower = args.searchText.toLowerCase();
    const match = pending.find((t) =>
      t.prompt.toLowerCase().includes(lower)
    );

    if (!match) return null;

    if (match.convexScheduledId) {
      try {
        await ctx.scheduler.cancel(match.convexScheduledId as any);
      } catch {
        // May already have fired
      }
    }

    await ctx.db.patch(match._id, {
      status: "cancelled",
      updatedAt: Date.now(),
    });

    return match._id;
  },
});

// ============================================================
// INTERNAL: Fire a scheduled task — sends Telegram message
// ============================================================

export const fire = internalAction({
  args: { taskId: v.id("scheduledTasks") },
  handler: async (ctx, args) => {
    const task = await ctx.runMutation(internal.scheduledTasks.claim, { id: args.taskId });
    if (!task) return;

    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = task.chatId || process.env.TELEGRAM_CHAT_ID;

    if (!botToken || !chatId) {
      console.error(
        "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID for scheduled task"
      );
      await ctx.runMutation(internal.scheduledTasks.retry, { id: args.taskId, attempt: task.attempts!, error: "Telegram is not configured" });
      return;
    }

    // Format message based on type
    let message: string;
    switch (task.type) {
      case "reminder":
        message = `⏰ *Reminder*\n\n${escapeMarkdown(task.prompt)}`;
        break;
      case "action":
        message = `⚡ *Scheduled Action*\n\n${escapeMarkdown(task.prompt)}\n\n_Reply to this message to execute it._`;
        break;
      case "recurring":
        message = `🔄 *Recurring*\n\n${escapeMarkdown(task.prompt)}`;
        break;
      default:
        message = `📋 ${escapeMarkdown(task.prompt)}`;
    }

    // Send via Telegram Bot API
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${botToken}/sendMessage`,
        {
          method: "POST",
          signal: AbortSignal.timeout(30_000),
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: message,
            parse_mode: "Markdown",
          }),
        }
      );

      const result = await response.json() as { ok?: boolean };
      if (!response.ok || result.ok !== true) throw new Error(`Telegram send failed: ${response.status}`);
    } catch (err) {
      await ctx.runMutation(internal.scheduledTasks.retry, { id: args.taskId, attempt: task.attempts!, error: String(err).slice(0, 300) });
      return;
    }

    // Mark as fired
    await ctx.runMutation(internal.scheduledTasks.markFired, {
      id: args.taskId, attempt: task.attempts!,
    });

    // If recurring, schedule the next occurrence
    if (task.type === "recurring" && task.recurrence) {
      await ctx.runMutation(internal.scheduledTasks.scheduleNext, {
        taskId: args.taskId,
      });
    }
  },
});

// ============================================================
// INTERNAL: Mark task as fired
// ============================================================

export const markFired = internalMutation({
  args: { id: v.id("scheduledTasks"), attempt: v.number() },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.id);
    if (!task || task.status !== "sending" || task.attempts !== args.attempt) return;
    await ctx.db.patch(args.id, {
      status: "fired",
      updatedAt: Date.now(),
    });
  },
});

// ============================================================
// INTERNAL: Schedule next occurrence of a recurring task
// ============================================================

export const scheduleNext = internalMutation({
  args: { taskId: v.id("scheduledTasks") },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.taskId);
    if (!task || !task.recurrence || task.status !== "fired" || task.nextScheduled) return;
    await ctx.db.patch(args.taskId, { nextScheduled: true });

    const nextTime = computeNextFireTime(task.scheduledAt, task.recurrence);
    if (!nextTime) return;

    const now = Date.now();
    const newTaskId = await ctx.db.insert("scheduledTasks", {
      createdAt: now,
      updatedAt: now,
      chatId: task.chatId,
      type: "recurring",
      prompt: task.prompt,
      scheduledAt: nextTime,
      status: "pending",
      recurrence: task.recurrence,
      metadata: task.metadata,
    });

    const scheduledId = await ctx.scheduler.runAt(
      nextTime,
      internal.scheduledTasks.fire,
      { taskId: newTaskId }
    );

    await ctx.db.patch(newTaskId, {
      convexScheduledId: scheduledId.toString(),
    });
  },
});

// ============================================================
// HELPERS
// ============================================================

/**
 * Escape Telegram Markdown v1 special characters.
 */
function escapeMarkdown(text: string): string {
  return text.replace(/([_[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

/**
 * Compute next fire time based on recurrence pattern.
 */
export function computeNextFireTime(lastFireAt: number, recurrence: string, now = Date.now()): number | null {
  if (!Number.isFinite(lastFireAt) || !Number.isFinite(now)) return null;
  const r = recurrence.toLowerCase().trim();
  const fixed: Record<string, number> = { hourly: 3_600_000, daily: 86_400_000, weekly: 604_800_000 };
  let ms = fixed[r];
  const match = r.match(/^every\s+(\d+)\s*(h(?:ours?)?|m(?:in(?:ute)?s?)?)$/);
  if (match) ms = Number(match[1]) * (match[2].startsWith("h") ? 3_600_000 : 60_000);
  if (r === "weekdays") {
    const d = new Date(Math.max(lastFireAt, now));
    const original = new Date(lastFireAt);
    d.setUTCHours(original.getUTCHours(), original.getUTCMinutes(), original.getUTCSeconds(), original.getUTCMilliseconds());
    if (d.getTime() <= now || d.getTime() <= lastFireAt) d.setUTCDate(d.getUTCDate() + 1);
    while ([0, 6].includes(d.getUTCDay())) d.setUTCDate(d.getUTCDate() + 1);
    return d.getTime();
  }
  if (!Number.isSafeInteger(ms) || ms < 60_000 || ms > 366 * 86_400_000) return null;
  const next = lastFireAt + Math.max(1, Math.floor((now - lastFireAt) / ms) + 1) * ms;
  return Number.isSafeInteger(next) ? next : null;
}

export const claim = internalMutation({
  args: { id: v.id("scheduledTasks") },
  handler: async (ctx, { id }) => {
    const task = await ctx.db.get(id);
    if (!task || (task.status !== "pending" && !(task.status === "sending" && task.updatedAt <= Date.now() - 120_000))) return null;
    if (task.retryAt && task.retryAt > Date.now()) return null;
    const attempts = (task.attempts || 0) + 1;
    if (attempts > 5) { await ctx.db.patch(id, { status: "failed", result: "Delivery attempts exhausted" }); return null; }
    await ctx.db.patch(id, { status: "sending", attempts, updatedAt: Date.now() });
    // Recover a worker crash after the lease expires.
    await ctx.scheduler.runAfter(121_000, internal.scheduledTasks.fire, { taskId: id });
    return { ...task, attempts };
  },
});

export const retry = internalMutation({
  args: { id: v.id("scheduledTasks"), attempt: v.number(), error: v.string() },
  handler: async (ctx, args) => {
    const task = await ctx.db.get(args.id);
    if (!task || task.status !== "sending" || task.attempts !== args.attempt) return;
    await ctx.db.patch(args.id, { status: args.attempt >= 5 ? "failed" : "pending", retryAt: Date.now() + Math.min(3_600_000, 30_000 * 2 ** args.attempt), result: args.error, updatedAt: Date.now() });
    if (args.attempt < 5) {
      const next = await ctx.scheduler.runAfter(Math.min(3_600_000, 30_000 * 2 ** args.attempt), internal.scheduledTasks.fire, { taskId: args.id });
      await ctx.db.patch(args.id, { convexScheduledId: String(next) });
    }
  },
});
