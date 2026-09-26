import { requireOwner } from "./auth";
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Add a fact to memory.
 */
export const addFact = mutation({
  args: {
    content: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const now = Date.now();
    return await ctx.db.insert("memory", {
      type: "fact",
      content: args.content,
      createdAt: now,
      updatedAt: now,
      metadata: args.metadata ?? {},
    });
  },
});

/**
 * Get all facts, ordered by creation time descending.
 */
export const getFacts = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    return await ctx.db
      .query("memory")
      .withIndex("by_type", (q) => q.eq("type", "fact"))
      .order("desc")
      .collect();
  },
});

/**
 * Add a goal with an optional deadline (epoch ms).
 */
export const addGoal = mutation({
  args: {
    content: v.string(),
    deadline: v.optional(v.number()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const now = Date.now();
    return await ctx.db.insert("memory", {
      type: "goal",
      content: args.content,
      deadline: args.deadline,
      completed: false,
      createdAt: now,
      updatedAt: now,
      metadata: args.metadata ?? {},
    });
  },
});

/**
 * Get all active (not completed) goals.
 */
export const getActiveGoals = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    return await ctx.db
      .query("memory")
      .withIndex("by_type_completed", (q) =>
        q.eq("type", "goal").eq("completed", false)
      )
      .order("asc")
      .collect();
  },
});

/**
 * Complete a goal by partial text match. Finds the first matching
 * active goal and marks it completed.
 */
export const completeGoal = mutation({
  args: {
    searchText: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const searchLower = args.searchText.toLowerCase();

    const goals = await ctx.db
      .query("memory")
      .withIndex("by_type_completed", (q) =>
        q.eq("type", "goal").eq("completed", false)
      )
      .collect();

    const match = goals.find((g) =>
      g.content.toLowerCase().includes(searchLower)
    );

    if (!match) return false;

    await ctx.db.patch(match._id, {
      completed: true,
      completedAt: Date.now(),
      updatedAt: Date.now(),
      type: "completed_goal",
    });
    return true;
  },
});

/**
 * Cancel (delete) a goal by partial text match.
 */
export const cancelGoal = mutation({
  args: {
    searchText: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const searchLower = args.searchText.toLowerCase();

    const goals = await ctx.db
      .query("memory")
      .withIndex("by_type_completed", (q) =>
        q.eq("type", "goal").eq("completed", false)
      )
      .collect();

    const match = goals.find((g) =>
      g.content.toLowerCase().includes(searchLower)
    );

    if (!match) return false;

    await ctx.db.delete(match._id);
    return true;
  },
});

/**
 * Delete a fact by partial text match.
 */
export const deleteFact = mutation({
  args: {
    searchText: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const searchLower = args.searchText.toLowerCase();

    const facts = await ctx.db
      .query("memory")
      .withIndex("by_type", (q) => q.eq("type", "fact"))
      .collect();

    const match = facts.find((f) =>
      f.content.toLowerCase().includes(searchLower)
    );

    if (!match) return false;

    await ctx.db.delete(match._id);
    return true;
  },
});

/**
 * Build combined memory context string (facts + active goals).
 */
export const getContext = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    const facts = await ctx.db
      .query("memory")
      .withIndex("by_type", (q) => q.eq("type", "fact"))
      .order("desc")
      .take(200);

    const goals = await ctx.db
      .query("memory")
      .withIndex("by_type_completed", (q) =>
        q.eq("type", "goal").eq("completed", false)
      )
      .order("asc")
      .take(100);

    const sections: string[] = [];

    if (facts.length > 0) {
      const factLines = facts.map((f) => `- ${f.content}`).join("\n");
      sections.push(`**Known Facts:**\n${factLines}`);
    }

    if (goals.length > 0) {
      const goalLines = goals
        .map((g, i) => {
          const deadline = g.deadline
            ? ` (due: ${new Date(g.deadline).toLocaleDateString()})`
            : "";
          return `${i + 1}. ${g.content}${deadline}`;
        })
        .join("\n");
      sections.push(`**Active Goals:**\n${goalLines}`);
    }

    return sections.join("\n\n");
  },
});

export const getContextFacts = query({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    return ctx.db.query("memory").withIndex("by_type", q => q.eq("type", "fact")).order("desc").take(200);
  },
});
