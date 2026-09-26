import { requireOwner } from "./auth";
import { query, mutation, action } from "./_generated/server";
import { v } from "convex/values";

/**
 * Generate a Convex storage upload URL.
 */
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    await requireOwner(ctx);
    return await ctx.storage.generateUploadUrl();
  },
});

/**
 * Insert asset metadata with a Convex storage ID reference.
 */
export const insertWithStorage = mutation({
  args: {
    storageId: v.optional(v.id("_storage")),
    storagePath: v.optional(v.string()),
    publicUrl: v.optional(v.string()),
    originalFilename: v.optional(v.string()),
    fileType: v.string(),
    mimeType: v.optional(v.string()),
    fileSizeBytes: v.optional(v.number()),
    description: v.string(),
    userCaption: v.optional(v.string()),
    conversationContext: v.optional(v.string()),
    relatedProject: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    channel: v.optional(v.string()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db.insert("assets", {
      createdAt: Date.now(),
      storageId: args.storageId,
      storagePath: args.storagePath,
      publicUrl: args.publicUrl,
      originalFilename: args.originalFilename,
      fileType: args.fileType,
      mimeType: args.mimeType,
      fileSizeBytes: args.fileSizeBytes,
      description: args.description,
      userCaption: args.userCaption,
      conversationContext: args.conversationContext,
      relatedProject: args.relatedProject,
      tags: args.tags ?? [],
      channel: args.channel ?? "telegram",
      metadata: args.metadata ?? {},
    });
  },
});

/**
 * Get recent assets, optionally filtered by file type.
 */
export const getRecent = query({
  args: {
    fileType: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const limit = args.limit ?? 20;

    if (args.fileType) {
      return await ctx.db
        .query("assets")
        .withIndex("by_fileType", (q) => q.eq("fileType", args.fileType!))
        .order("desc")
        .take(limit);
    }

    return await ctx.db
      .query("assets")
      .order("desc")
      .take(limit);
  },
});

/**
 * Get a single asset by its Convex ID.
 */
export const getById = query({
  args: { id: v.id("assets") },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db.get(args.id);
  },
});

/**
 * Text search across asset descriptions and tags.
 */
export const textSearch = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const limit = args.limit ?? 10;
    const queryLower = args.query.toLowerCase();

    const assets = await ctx.db
      .query("assets")
      .order("desc")
      .take(500);

    const matched = assets.filter((a) => {
      const descMatch = a.description.toLowerCase().includes(queryLower);
      const tagMatch = a.tags?.some((t) =>
        t.toLowerCase().includes(queryLower)
      );
      return descMatch || tagMatch;
    });

    return matched.slice(0, limit);
  },
});

/**
 * Update an asset's description and tags.
 */
export const updateDescription = mutation({
  args: {
    id: v.id("assets"),
    description: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const patch: Record<string, unknown> = {};
    if (args.description !== undefined) patch.description = args.description;
    if (args.tags !== undefined) patch.tags = args.tags;

    if (Object.keys(patch).length > 0) {
      await ctx.db.patch(args.id, patch);
    }
    return args.id;
  },
});

/**
 * Semantic (vector) search across assets.
 */
export const semanticSearch = action({
  args: {
    vector: v.array(v.float64()),
    fileType: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const results = await ctx.vectorSearch("assets", "by_embedding", {
      vector: args.vector,
      limit: args.limit ?? 10,
      filter: args.fileType
        ? (q) => q.eq("fileType", args.fileType!)
        : undefined,
    });
    return results;
  },
});
