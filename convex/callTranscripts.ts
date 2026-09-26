import { requireOwner } from "./auth";
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Insert a call transcript.
 */
export const insert = mutation({
  args: {
    conversationId: v.string(),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    actionItems: v.optional(v.array(v.string())),
    durationSeconds: v.optional(v.number()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db.insert("callTranscripts", {
      createdAt: Date.now(),
      conversationId: args.conversationId,
      transcript: args.transcript,
      summary: args.summary,
      actionItems: args.actionItems ?? [],
      durationSeconds: args.durationSeconds,
      metadata: args.metadata ?? {},
    });
  },
});

/**
 * Get a transcript by its conversation ID.
 */
export const getByConversationId = query({
  args: { conversationId: v.string() },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db
      .query("callTranscripts")
      .withIndex("by_conversationId", (q) =>
        q.eq("conversationId", args.conversationId)
      )
      .first();
  },
});
