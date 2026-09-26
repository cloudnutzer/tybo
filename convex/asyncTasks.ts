import { requireOwner } from "./auth";
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Create a new async task (human-in-the-loop).
 */
export const create = mutation({
  args: {
    chatId: v.string(),
    originalPrompt: v.string(),
    threadId: v.optional(v.number()),
    processedBy: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const now = Date.now();
    return await ctx.db.insert("asyncTasks", {
      createdAt: now,
      updatedAt: now,
      chatId: args.chatId,
      originalPrompt: args.originalPrompt,
      status: "running",
      threadId: args.threadId,
      processedBy: args.processedBy,
      reminderSent: false,
      metadata: args.metadata ?? {},
    });
  },
});

/**
 * Update task fields. Only provided fields are patched.
 */
export const update = mutation({
  args: {
    id: v.id("asyncTasks"),
    status: v.optional(
      v.union(
        v.literal("pending"),
        v.literal("running"),
        v.literal("needs_input"),
        v.literal("completed"),
        v.literal("failed")
      )
    ),
    result: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    currentStep: v.optional(v.string()),
    pendingQuestion: v.optional(v.string()),
    pendingOptions: v.optional(v.any()),
    userResponse: v.optional(v.string()),
    processedBy: v.optional(v.string()),
    reminderSent: v.optional(v.boolean()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const { id, ...updates } = args;

    // Filter out undefined values
    const patch: Record<string, unknown> = { updatedAt: Date.now() };
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        patch[key] = value;
      }
    }

    await ctx.db.patch(id, patch);
    return id;
  },
});

/**
 * Get a task by its Convex ID.
 */
export const getById = query({
  args: { id: v.id("asyncTasks") },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db.get(args.id);
  },
});

/**
 * Get tasks waiting for user input in a specific chat.
 */
export const getPending = query({
  args: { chatId: v.string() },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db
      .query("asyncTasks")
      .withIndex("by_chatId_status", (q) =>
        q.eq("chatId", args.chatId).eq("status", "needs_input")
      )
      .order("desc")
      .collect();
  },
});

/**
 * Get currently running tasks in a specific chat.
 */
export const getRunning = query({
  args: { chatId: v.string() },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db
      .query("asyncTasks")
      .withIndex("by_chatId_status", (q) =>
        q.eq("chatId", args.chatId).eq("status", "running")
      )
      .order("desc")
      .collect();
  },
});

/**
 * Get tasks waiting for input that haven't been updated recently (stale).
 */
export const getStale = query({
  args: {
    thresholdMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const threshold = args.thresholdMs ?? 2 * 60 * 60 * 1000; // 2 hours default
    const cutoff = Date.now() - threshold;

    const needsInput = await ctx.db
      .query("asyncTasks")
      .withIndex("by_status", (q) => q.eq("status", "needs_input"))
      .collect();

    // Filter for stale + not yet reminded
    return needsInput.filter(
      (t) => t.updatedAt < cutoff && !t.reminderSent
    );
  },
});
