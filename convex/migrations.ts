import { requireOwner } from "./auth";
import { mutation } from "./_generated/server";
import { v } from "convex/values";

/**
 * Migration-specific insert functions that accept ALL fields including timestamps.
 * These bypass the normal mutations which auto-generate createdAt/updatedAt.
 * Only used by scripts/migrate-to-convex.ts.
 */

export const insertMessage = mutation({
  args: {
    chatId: v.string(),
    role: v.string(),
    content: v.string(),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db.insert("messages", {
      chatId: args.chatId,
      role: args.role as "user" | "assistant",
      content: args.content,
      metadata: args.metadata ?? {},
      createdAt: args.createdAt,
    });
  },
});

export const insertMemory = mutation({
  args: {
    type: v.string(),
    content: v.string(),
    createdAt: v.number(),
    updatedAt: v.optional(v.number()),
    deadline: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    completed: v.optional(v.boolean()),
    priority: v.optional(v.number()),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db.insert("memory", {
      type: args.type as any,
      content: args.content,
      createdAt: args.createdAt,
      updatedAt: args.updatedAt ?? args.createdAt,
      deadline: args.deadline,
      completedAt: args.completedAt,
      completed: args.completed,
      priority: args.priority,
      metadata: args.metadata ?? {},
    });
  },
});

export const insertLog = mutation({
  args: {
    level: v.string(),
    event: v.string(),
    message: v.optional(v.string()),
    metadata: v.optional(v.any()),
    sessionId: v.optional(v.string()),
    durationMs: v.optional(v.number()),
    service: v.optional(v.string()),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db.insert("logs", {
      level: args.level as any,
      event: args.event,
      message: args.message,
      metadata: args.metadata ?? {},
      sessionId: args.sessionId,
      durationMs: args.durationMs,
      service: args.service,
      createdAt: args.createdAt,
    });
  },
});

export const insertCallTranscript = mutation({
  args: {
    conversationId: v.string(),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    actionItems: v.optional(v.array(v.string())),
    durationSeconds: v.optional(v.number()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db.insert("callTranscripts", {
      conversationId: args.conversationId,
      transcript: args.transcript,
      summary: args.summary,
      actionItems: args.actionItems ?? [],
      durationSeconds: args.durationSeconds,
      metadata: args.metadata ?? {},
      createdAt: args.createdAt,
    });
  },
});

export const insertAsyncTask = mutation({
  args: {
    chatId: v.string(),
    originalPrompt: v.string(),
    status: v.string(),
    result: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    currentStep: v.optional(v.string()),
    pendingQuestion: v.optional(v.string()),
    pendingOptions: v.optional(v.any()),
    userResponse: v.optional(v.string()),
    threadId: v.optional(v.number()),
    processedBy: v.optional(v.string()),
    reminderSent: v.optional(v.boolean()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db.insert("asyncTasks", {
      chatId: args.chatId,
      originalPrompt: args.originalPrompt,
      status: args.status as any,
      result: args.result,
      sessionId: args.sessionId,
      currentStep: args.currentStep,
      pendingQuestion: args.pendingQuestion,
      pendingOptions: args.pendingOptions,
      userResponse: args.userResponse,
      threadId: args.threadId,
      processedBy: args.processedBy,
      reminderSent: args.reminderSent ?? false,
      metadata: args.metadata ?? {},
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    });
  },
});

export const insertNodeHeartbeat = mutation({
  args: {
    nodeId: v.string(),
    lastHeartbeat: v.number(),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db.insert("nodeHeartbeat", {
      nodeId: args.nodeId,
      lastHeartbeat: args.lastHeartbeat,
      metadata: args.metadata ?? {},
    });
  },
});

export const insertAsset = mutation({
  args: {
    fileType: v.string(),
    description: v.optional(v.string()),
    storagePath: v.optional(v.string()),
    publicUrl: v.optional(v.string()),
    originalFilename: v.optional(v.string()),
    mimeType: v.optional(v.string()),
    fileSizeBytes: v.optional(v.number()),
    userCaption: v.optional(v.string()),
    conversationContext: v.optional(v.string()),
    relatedProject: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
    channel: v.optional(v.string()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db.insert("assets", {
      fileType: args.fileType,
      description: args.description ?? "",
      storagePath: args.storagePath,
      publicUrl: args.publicUrl,
      originalFilename: args.originalFilename,
      mimeType: args.mimeType,
      fileSizeBytes: args.fileSizeBytes,
      userCaption: args.userCaption,
      conversationContext: args.conversationContext,
      relatedProject: args.relatedProject,
      tags: args.tags ?? [],
      channel: args.channel,
      metadata: args.metadata ?? {},
      createdAt: args.createdAt,
    });
  },
});

export const insertKnowledge = mutation({
  args: {
    category: v.string(),
    title: v.string(),
    content: v.string(),
    source: v.optional(v.string()),
    relatedProject: v.optional(v.string()),
    relatedEntities: v.optional(v.array(v.string())),
    tags: v.optional(v.array(v.string())),
    confidence: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    supersededBy: v.optional(v.string()),
    status: v.optional(v.string()),
    metadata: v.optional(v.any()),
    createdAt: v.number(),
    updatedAt: v.number(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    return await ctx.db.insert("knowledge", {
      category: args.category as any,
      title: args.title,
      content: args.content,
      source: args.source,
      relatedProject: args.relatedProject,
      relatedEntities: args.relatedEntities ?? [],
      tags: args.tags ?? [],
      confidence: args.confidence,
      expiresAt: args.expiresAt,
      supersededBy: args.supersededBy,
      status: (args.status as any) ?? "active",
      metadata: args.metadata ?? {},
      createdAt: args.createdAt,
      updatedAt: args.updatedAt,
    });
  },
});

/**
 * Backfill topicId + sessionKey onto existing messages (docs/topic-sessions.md F-2).
 * topicId comes from metadata.topicId; sessionKey is derived:
 *   topic:{chatId}:{topicId} when a topic exists,
 *   group:{chatId} for group chats (negative Telegram chat IDs),
 *   dm:{chatId} otherwise.
 * Idempotent: only touches rows without a sessionKey. Run repeatedly until
 * it reports done=true, e.g.:
 *   npx convex run migrations:backfillSessionKeys '{"batchSize": 500}'
 */
export const backfillSessionKeys = mutation({
  args: { batchSize: v.optional(v.number()) },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const batchSize = args.batchSize ?? 500;
    const batch = await ctx.db
      .query("messages")
      .filter((q) => q.eq(q.field("sessionKey"), undefined))
      .take(batchSize);

    for (const msg of batch) {
      const topicId =
        typeof msg.metadata?.topicId === "number"
          ? msg.metadata.topicId
          : undefined;
      const sessionKey =
        topicId !== undefined
          ? `topic:${msg.chatId}:${topicId}`
          : msg.chatId.startsWith("-")
            ? `group:${msg.chatId}`
            : `dm:${msg.chatId}`;
      await ctx.db.patch(msg._id, { topicId, sessionKey });
    }

    return { patched: batch.length, done: batch.length < batchSize };
  },
});
