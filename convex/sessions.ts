import { requireOwner } from "./auth";
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Per-topic conversation sessions (docs/topic-sessions.md F-1).
 * A session binds a session key ("topic:{chatId}:{topicId}" | "dm:{chatId}" |
 * "group:{chatId}") to a Claude CLI session ID so follow-up messages can use
 * `claude -p --resume` instead of rebuilding the full context prompt.
 */

export const getByKey = query({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db
      .query("sessions")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
  },
});

export const upsert = mutation({
  args: {
    key: v.string(),
    agentName: v.string(),
    claudeSessionId: v.optional(v.string()),
    model: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    const now = Date.now();
    if (existing) {
      await ctx.db.patch(existing._id, {
        agentName: args.agentName,
        claudeSessionId: args.claudeSessionId,
        model: args.model,
        lastActivity: now,
        messageCount: existing.messageCount + 1,
        ...(args.metadata !== undefined ? { metadata: args.metadata } : {}),
      });
      return existing._id;
    }
    return await ctx.db.insert("sessions", {
      key: args.key,
      agentName: args.agentName,
      claudeSessionId: args.claudeSessionId,
      model: args.model,
      startedAt: now,
      lastActivity: now,
      messageCount: 1,
      metadata: args.metadata,
    });
  },
});

/**
 * Reset a session (manual /new or idle expiry): clears the Claude session ID
 * so the next message starts fresh. Messages stay in the DB.
 */
export const reset = mutation({
  args: { key: v.string() },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const existing = await ctx.db
      .query("sessions")
      .withIndex("by_key", (q) => q.eq("key", args.key))
      .first();
    if (!existing) return null;
    const now = Date.now();
    await ctx.db.patch(existing._id, {
      claudeSessionId: undefined,
      startedAt: now,
      lastActivity: now,
      messageCount: 0,
    });
    return existing._id;
  },
});
