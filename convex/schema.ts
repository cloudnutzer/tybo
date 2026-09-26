import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  interactionScores: defineTable({
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
  }).index("by_date", ["date"]),
  // Conversation history
  messages: defineTable({
    createdAt: v.number(), // epoch ms
    chatId: v.string(),
    // Telegram forum topic (message_thread_id). First-class column so context
    // can be filtered per topic; older rows carry it only in metadata until
    // the backfill migration runs (see migrations.backfillSessionKeys).
    topicId: v.optional(v.number()),
    // Session key: "topic:{chatId}:{topicId}" | "dm:{chatId}" | "group:{chatId}"
    sessionKey: v.optional(v.string()),
    role: v.union(v.literal("user"), v.literal("assistant")),
    content: v.string(),
    metadata: v.optional(v.any()),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_chatId", ["chatId"])
    .index("by_chatId_createdAt", ["chatId", "createdAt"])
    .index("by_sessionKey", ["sessionKey", "createdAt"])
    .searchIndex("search_content", { searchField: "content", filterFields: ["chatId"] })
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["chatId"],
    }),

  // Per-topic conversation sessions (claude -p --resume continuity).
  // One row per session key; claudeSessionId links to the Claude CLI session.
  sessions: defineTable({
    key: v.string(), // "topic:{chatId}:{topicId}" | "dm:{chatId}" | "group:{chatId}"
    agentName: v.string(),
    claudeSessionId: v.optional(v.string()),
    model: v.string(), // model the session was started with; mismatch forces a fresh session
    startedAt: v.number(),
    lastActivity: v.number(),
    messageCount: v.number(),
    metadata: v.optional(v.any()),
  }).index("by_key", ["key"]),

  // Facts, goals, preferences
  memory: defineTable({
    createdAt: v.number(),
    updatedAt: v.number(),
    type: v.union(
      v.literal("fact"),
      v.literal("goal"),
      v.literal("completed_goal"),
      v.literal("preference")
    ),
    content: v.string(),
    deadline: v.optional(v.number()),
    completedAt: v.optional(v.number()),
    completed: v.optional(v.boolean()),
    priority: v.optional(v.number()),
    metadata: v.optional(v.any()),
  })
    .index("by_type", ["type"])
    .index("by_type_completed", ["type", "completed"]),

  // Observability logs
  logs: defineTable({
    createdAt: v.number(),
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
    // "service" field used by tybo logging (maps from supabase.ts log() calls)
    service: v.optional(v.string()),
  })
    .index("by_level", ["level"])
    .index("by_service", ["service"]),

  // Voice call transcripts
  callTranscripts: defineTable({
    createdAt: v.number(),
    conversationId: v.string(),
    transcript: v.optional(v.string()),
    summary: v.optional(v.string()),
    actionItems: v.optional(v.array(v.string())),
    durationSeconds: v.optional(v.number()),
    metadata: v.optional(v.any()),
  }).index("by_conversationId", ["conversationId"]),

  // Human-in-the-loop async tasks
  asyncTasks: defineTable({
    createdAt: v.number(),
    updatedAt: v.number(),
    chatId: v.string(),
    originalPrompt: v.string(),
    status: v.union(
      v.literal("pending"),
      v.literal("running"),
      v.literal("needs_input"),
      v.literal("completed"),
      v.literal("failed")
    ),
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
  })
    .index("by_chatId", ["chatId"])
    .index("by_status", ["status"])
    .index("by_chatId_status", ["chatId", "status"]),

  // Hybrid mode health tracking
  nodeHeartbeat: defineTable({
    nodeId: v.string(),
    lastHeartbeat: v.number(),
    metadata: v.optional(v.any()),
  }).index("by_nodeId", ["nodeId"]),

  // Persistent file/image storage with AI descriptions
  assets: defineTable({
    createdAt: v.number(),
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
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_fileType", ["fileType"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["fileType"],
    }),

  // Scheduled tasks (reminders, deferred actions, recurring)
  scheduledTasks: defineTable({
    createdAt: v.number(),
    updatedAt: v.number(),
    chatId: v.string(),
    type: v.union(
      v.literal("reminder"),
      v.literal("action"),
      v.literal("recurring")
    ),
    prompt: v.string(),
    scheduledAt: v.number(), // epoch ms — when to fire
    status: v.union(
      v.literal("pending"),
      v.literal("fired"),
      v.literal("sending"),
      v.literal("failed"),
      v.literal("cancelled")
    ),
    attempts: v.optional(v.number()),
    retryAt: v.optional(v.number()),
    nextScheduled: v.optional(v.boolean()),
    recurrence: v.optional(v.string()), // e.g. "daily", "every 2h", "weekdays", "hourly"
    convexScheduledId: v.optional(v.string()), // Convex scheduler ID for cancellation
    result: v.optional(v.string()),
    metadata: v.optional(v.any()),
  })
    .index("by_status", ["status"])
    .index("by_chatId", ["chatId"])
    .index("by_chatId_status", ["chatId", "status"]),

  // Structured knowledge base
  knowledge: defineTable({
    createdAt: v.number(),
    updatedAt: v.number(),
    category: v.union(
      v.literal("project"),
      v.literal("person"),
      v.literal("preference"),
      v.literal("learning"),
      v.literal("process"),
      v.literal("decision"),
      v.literal("reference"),
      v.literal("tool")
    ),
    title: v.string(),
    content: v.string(),
    source: v.optional(v.string()),
    relatedProject: v.optional(v.string()),
    relatedEntities: v.optional(v.array(v.string())),
    tags: v.optional(v.array(v.string())),
    confidence: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    supersededBy: v.optional(v.string()),
    status: v.optional(v.union(v.literal("active"), v.literal("archived"))),
    metadata: v.optional(v.any()),
    embedding: v.optional(v.array(v.float64())),
  })
    .index("by_category", ["category"])
    .index("by_status", ["status"])
    .index("by_category_title", ["category", "title"])
    .vectorIndex("by_embedding", {
      vectorField: "embedding",
      dimensions: 1536,
      filterFields: ["category"],
    }),

  // Self-metered Agent SDK credit tally. From 2026-06-15 Anthropic meters
  // programmatic claude -p / Agent SDK usage on Pro/Max subscriptions against a
  // monthly credit. Anthropic exposes no balance API, so tybo sums total_cost_usd
  // per billing cycle and compares to a ceiling to route models, warn, and degrade.
  // One row per cycle (cycleStartMs = the reset-day boundary). See convex/creditGuard.ts.
  // observedCeilingUsd is the spend level at which a real credit-exhaustion error
  // first fired this cycle — the bot's learned read of the member's actual plan,
  // so up/downgrades self-correct without anyone re-entering their plan.
  creditTally: defineTable({
    cycleStartMs: v.number(),
    cycleSpendUsd: v.number(),
    plan: v.optional(v.string()),
    warnedThisCycle: v.boolean(),
    observedCeilingUsd: v.optional(v.number()),
    lastUpdatedMs: v.number(),
  }).index("by_cycleStartMs", ["cycleStartMs"]),
});
