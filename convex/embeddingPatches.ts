import { internalMutation } from "./_generated/server";
import { v } from "convex/values";

// Internal mutations to patch embeddings (called from actions in embeddings.ts)
// These must be in a non-"use node" file since mutations can't run in Node.js.

export const patchMessageEmbedding = internalMutation({
  args: {
    id: v.id("messages"),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { embedding: args.embedding });
  },
});

export const patchAssetEmbedding = internalMutation({
  args: {
    id: v.id("assets"),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { embedding: args.embedding });
  },
});

export const patchKnowledgeEmbedding = internalMutation({
  args: {
    id: v.id("knowledge"),
    embedding: v.array(v.float64()),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.id, { embedding: args.embedding });
  },
});
