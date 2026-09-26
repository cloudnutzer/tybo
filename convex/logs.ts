import { requireOwner } from "./auth";
import { mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Insert a log entry.
 */
export const insert = mutation({
  args: {
    level: v.union(
      v.literal("debug"),
      v.literal("info"),
      v.literal("warn"),
      v.literal("error")
    ),
    event: v.string(),
    message: v.optional(v.string()),
    metadata: v.optional(v.any()),
    sessionId: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    service: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db.insert("logs", {
      createdAt: Date.now(),
      level: args.level,
      event: args.event,
      message: args.message,
      metadata: args.metadata ?? {},
      sessionId: args.sessionId,
      durationMs: args.durationMs,
      service: args.service,
    });
  },
});
