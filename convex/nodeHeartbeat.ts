import { requireOwner } from "./auth";
import { query, mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Insert or update heartbeat for a node.
 * If a record with the same nodeId exists, update it; otherwise insert.
 */
export const upsert = mutation({
  args: {
    nodeId: v.string(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const existing = await ctx.db
      .query("nodeHeartbeat")
      .withIndex("by_nodeId", (q) => q.eq("nodeId", args.nodeId))
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        lastHeartbeat: Date.now(),
        metadata: args.metadata ?? existing.metadata ?? {},
      });
      return existing._id;
    }

    return await ctx.db.insert("nodeHeartbeat", {
      nodeId: args.nodeId,
      lastHeartbeat: Date.now(),
      metadata: args.metadata ?? {},
    });
  },
});

/**
 * Get heartbeat status for a node.
 * Returns online status based on maxAgeMs threshold (default 90s).
 */
export const getStatus = query({
  args: {
    nodeId: v.string(),
    maxAgeMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const maxAge = args.maxAgeMs ?? 90_000;

    const node = await ctx.db
      .query("nodeHeartbeat")
      .withIndex("by_nodeId", (q) => q.eq("nodeId", args.nodeId))
      .first();

    if (!node) {
      return { online: false, lastHeartbeat: null };
    }

    const age = Date.now() - node.lastHeartbeat;
    return {
      online: age < maxAge,
      lastHeartbeat: node.lastHeartbeat,
    };
  },
});
