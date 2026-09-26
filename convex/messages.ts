import { requireOwner } from "./auth";
import { query, mutation, action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

/**
 * Insert a message into the messages table.
 */
export const insert = mutation({
  args: {
    chatId: v.string(),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    topicId: v.optional(v.number()),
    sessionKey: v.optional(v.string()),
    metadata: v.optional(v.any()),
    createdAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const id = await ctx.db.insert("messages", {
      chatId: args.chatId,
      role: args.role,
      content: args.content,
      topicId: args.topicId,
      sessionKey: args.sessionKey,
      metadata: args.metadata ?? {},
      createdAt: args.createdAt ?? Date.now(),
    });
    return id;
  },
});

/**
 * Get N most recent messages for a chatId, returned in chronological order.
 */
export const getRecent = query({
  args: {
    chatId: v.string(),
    limit: v.optional(v.number()),
    // When provided, context is session-isolated (per Telegram topic/DM)
    sessionKey: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const limit = args.limit ?? 20;
    if (args.sessionKey) {
      const messages = await ctx.db
        .query("messages")
        .withIndex("by_sessionKey", (q) => q.eq("sessionKey", args.sessionKey))
        .order("desc")
        .take(limit);
      return messages.reverse();
    }
    const messages = await ctx.db
      .query("messages")
      .withIndex("by_chatId_createdAt", (q) => q.eq("chatId", args.chatId))
      .order("desc")
      .take(limit);
    return messages.reverse();
  },
});

/**
 * Get messages by chatId with pagination (cursor-based).
 */
export const getByChat = query({
  args: {
    chatId: v.string(),
    paginationOpts: v.object({
      numItems: v.number(),
      cursor: v.union(v.string(), v.null()),
    }),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db
      .query("messages")
      .withIndex("by_chatId_createdAt", (q) => q.eq("chatId", args.chatId))
      .order("desc")
      .paginate(args.paginationOpts);
  },
});

/**
 * Basic text search on message content (case-insensitive substring match).
 * Convex doesn't have ilike — we filter in application code.
 */
export const textSearch = query({
  args: {
    chatId: v.string(),
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const limit = args.limit ?? 10;
    return await ctx.db.query("messages")
      .withSearchIndex("search_content", q => q.search("content", args.query).eq("chatId", args.chatId))
      .take(Math.max(1, Math.min(limit, 50)));
  },
});

/**
 * Get a single message by its Convex ID.
 */
export const getById = query({
  args: { id: v.id("messages") },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db.get(args.id);
  },
});

/**
 * Semantic (vector) search across messages.
 */
export const semanticSearch = action({
  args: {
    vector: v.array(v.float64()),
    chatId: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const results = await ctx.vectorSearch("messages", "by_embedding", {
      vector: args.vector,
      limit: args.limit ?? 10,
      filter: args.chatId
        ? (q) => q.eq("chatId", args.chatId!)
        : undefined,
    });
    return results;
  },
});

/**
 * Get recent messages across all chats for board meeting context.
 * Returns messages from the last N days, grouped by thread/channel.
 */
export const getBoardMeetingContext = query({
  args: {
    days: v.optional(v.number()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const days = args.days ?? 7;
    const limit = args.limit ?? 100;
    const since = Date.now() - days * 24 * 60 * 60 * 1000;

    // Fetch recent messages across all chats
    const messages = await ctx.db
      .query("messages")
      .order("desc")
      .filter((q) => q.gte(q.field("createdAt"), since))
      .take(limit);

    return messages;
  },
});
