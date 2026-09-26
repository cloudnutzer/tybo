import { requireOwner } from "./auth";
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Insert a batch of interaction scores.
 */
export const insertBatch = mutation({
  args: {
    scores: v.array(
      v.object({
        date: v.string(),
        channel: v.union(v.literal("claude-code"), v.literal("telegram")),
        sessionId: v.string(),
        score: v.number(),
        label: v.string(),
        durationMin: v.number(),
        messageCount: v.number(),
        toolCount: v.number(),
        toolSuccessPct: v.number(),
        correctionCount: v.number(),
        appreciationCount: v.number(),
        topSkills: v.string(),
        sessionFocus: v.string(),
        responseAvgSec: v.number(),
      })
    ),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const ids = [];
    for (const score of args.scores) {
      const id = await ctx.db.insert("interactionScores", score);
      ids.push(id);
    }
    return ids;
  },
});

/**
 * Get all scores for a date range (for analyzer).
 */
export const getByDateRange = query({
  args: {
    startDate: v.string(), // YYYY-MM-DD
    endDate: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const endDate = args.endDate || "9999-12-31";
    const scores = await ctx.db
      .query("interactionScores")
      .withIndex("by_date", (q) =>
        q.gte("date", args.startDate).lte("date", endDate)
      )
      .collect();
    return scores;
  },
});

/**
 * Get all scores (for full analysis).
 */
export const getAll = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    return await ctx.db.query("interactionScores").collect();
  },
});

/**
 * Check if scores exist for a specific date (avoid duplicates).
 */
export const existsForDate = query({
  args: { date: v.string() },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const first = await ctx.db
      .query("interactionScores")
      .withIndex("by_date", (q) => q.eq("date", args.date))
      .first();
    return !!first;
  },
});
