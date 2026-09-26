import { requireOwner } from "./auth";
import { query, mutation, action } from "./_generated/server";
import { v } from "convex/values";

const categoryValidator = v.union(
  v.literal("project"),
  v.literal("person"),
  v.literal("preference"),
  v.literal("learning"),
  v.literal("process"),
  v.literal("decision"),
  v.literal("reference"),
  v.literal("tool")
);

/**
 * Add or update a knowledge entry.
 * If an entry with the same category + title exists, update it (upsert).
 */
export const add = mutation({
  args: {
    category: categoryValidator,
    title: v.string(),
    content: v.string(),
    source: v.optional(v.string()),
    relatedProject: v.optional(v.string()),
    relatedEntities: v.optional(v.array(v.string())),
    tags: v.optional(v.array(v.string())),
    confidence: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    status: v.optional(v.union(v.literal("active"), v.literal("archived"))),
    metadata: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const now = Date.now();

    // Check for existing entry with same category + title
    const existing = await ctx.db
      .query("knowledge")
      .withIndex("by_category_title", (q) =>
        q.eq("category", args.category).eq("title", args.title)
      )
      .first();

    if (existing) {
      await ctx.db.patch(existing._id, {
        content: args.content,
        relatedProject: args.relatedProject ?? existing.relatedProject,
        relatedEntities: args.relatedEntities ?? existing.relatedEntities ?? [],
        tags: args.tags ?? existing.tags ?? [],
        confidence: args.confidence ?? existing.confidence ?? 1.0,
        updatedAt: now,
        metadata: args.metadata ?? existing.metadata ?? {},
      });
      return existing._id;
    }

    return await ctx.db.insert("knowledge", {
      createdAt: now,
      updatedAt: now,
      category: args.category,
      title: args.title,
      content: args.content,
      source: args.source ?? "telegram",
      relatedProject: args.relatedProject,
      relatedEntities: args.relatedEntities ?? [],
      tags: args.tags ?? [],
      confidence: args.confidence ?? 1.0,
      expiresAt: args.expiresAt,
      status: args.status ?? "active",
      metadata: args.metadata ?? {},
    });
  },
});

/**
 * Text search across active knowledge entries.
 */
export const search = query({
  args: {
    query: v.string(),
    category: v.optional(categoryValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const limit = args.limit ?? 10;
    const queryLower = args.query.toLowerCase();
    const now = Date.now();

    let entries;
    if (args.category) {
      entries = await ctx.db
        .query("knowledge")
        .withIndex("by_category", (q) => q.eq("category", args.category!))
        .collect();
    } else {
      entries = await ctx.db
        .query("knowledge")
        .withIndex("by_status", (q) => q.eq("status", "active"))
        .collect();
    }

    // Filter: active, not expired, not superseded, text match
    const matched = entries.filter((e) => {
      if (e.status !== "active") return false;
      if (e.supersededBy) return false;
      if (e.expiresAt && e.expiresAt < now) return false;

      const titleMatch = e.title.toLowerCase().includes(queryLower);
      const contentMatch = e.content.toLowerCase().includes(queryLower);
      const tagMatch = e.tags?.some((t) =>
        t.toLowerCase().includes(queryLower)
      );
      return titleMatch || contentMatch || tagMatch;
    });

    // Sort by updatedAt descending
    matched.sort((a, b) => b.updatedAt - a.updatedAt);

    return matched.slice(0, limit);
  },
});

/**
 * Get recent knowledge entries, optionally by category.
 */
export const getRecent = query({
  args: {
    category: v.optional(categoryValidator),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const limit = args.limit ?? 10;
    const now = Date.now();

    let entries;
    if (args.category) {
      entries = await ctx.db
        .query("knowledge")
        .withIndex("by_category", (q) => q.eq("category", args.category!))
        .collect();
    } else {
      entries = await ctx.db
        .query("knowledge")
        .withIndex("by_status", (q) => q.eq("status", "active"))
        .collect();
    }

    // Filter: active, not expired, not superseded
    const filtered = entries.filter((e) => {
      if (e.status !== "active") return false;
      if (e.supersededBy) return false;
      if (e.expiresAt && e.expiresAt < now) return false;
      return true;
    });

    // Sort by updatedAt descending
    filtered.sort((a, b) => b.updatedAt - a.updatedAt);

    return filtered.slice(0, limit);
  },
});

/**
 * Get knowledge entries by related project name.
 */
export const getByProject = query({
  args: {
    project: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const limit = args.limit ?? 20;
    const projectLower = args.project.toLowerCase();
    const now = Date.now();

    const entries = await ctx.db
      .query("knowledge")
      .withIndex("by_status", (q) => q.eq("status", "active"))
      .collect();

    const matched = entries.filter((e) => {
      if (e.supersededBy) return false;
      if (e.expiresAt && e.expiresAt < now) return false;
      return e.relatedProject?.toLowerCase().includes(projectLower);
    });

    matched.sort((a, b) => b.updatedAt - a.updatedAt);

    return matched.slice(0, limit);
  },
});

/**
 * Archive a knowledge entry.
 */
export const archive = mutation({
  args: {
    id: v.id("knowledge"),
    reason: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const entry = await ctx.db.get(args.id);
    if (!entry) return false;

    const patch: Record<string, unknown> = {
      status: "archived",
      updatedAt: Date.now(),
    };

    if (args.reason) {
      patch.metadata = { ...(entry.metadata as object ?? {}), archiveReason: args.reason };
    }

    await ctx.db.patch(args.id, patch);
    return true;
  },
});

/**
 * Search only archived knowledge entries.
 */
export const searchArchived = query({
  args: {
    query: v.string(),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const limit = args.limit ?? 10;
    const queryLower = args.query.toLowerCase();

    const entries = await ctx.db
      .query("knowledge")
      .withIndex("by_status", (q) => q.eq("status", "archived"))
      .collect();

    const matched = entries.filter((e) => {
      const titleMatch = e.title.toLowerCase().includes(queryLower);
      const contentMatch = e.content.toLowerCase().includes(queryLower);
      const tagMatch = e.tags?.some((t) =>
        t.toLowerCase().includes(queryLower)
      );
      return titleMatch || contentMatch || tagMatch;
    });

    matched.sort((a, b) => b.updatedAt - a.updatedAt);

    return matched.slice(0, limit);
  },
});

/**
 * Build knowledge context string for prompt injection.
 * Includes recent high-priority categories + keyword matches.
 */
export const getContext = query({
  args: {
    userMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const now = Date.now();
    const entries: Array<{
      _id: string;
      category: string;
      title: string;
      content: string;
      relatedProject?: string;
    }> = [];
    const seenIds = new Set<string>();

    // Always include recent high-value knowledge
    const priorityCategories = ["project", "decision", "preference"] as const;
    for (const cat of priorityCategories) {
      const recent = await ctx.db
        .query("knowledge")
        .withIndex("by_category", (q) => q.eq("category", cat))
        .collect();

      const active = recent
        .filter(
          (e) =>
            e.status === "active" &&
            !e.supersededBy &&
            (!e.expiresAt || e.expiresAt > now)
        )
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 3);

      for (const e of active) {
        if (!seenIds.has(e._id as unknown as string)) {
          seenIds.add(e._id as unknown as string);
          entries.push({
            _id: e._id as unknown as string,
            category: e.category,
            title: e.title,
            content: e.content,
            relatedProject: e.relatedProject,
          });
        }
      }
    }

    // Keyword search from user message
    if (args.userMessage && args.userMessage.length > 5) {
      const words = args.userMessage
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 3);

      const allActive = await ctx.db
        .query("knowledge")
        .withIndex("by_status", (q) => q.eq("status", "active"))
        .collect();

      for (const word of words) {
        const wordLower = word.toLowerCase();
        const matches = allActive
          .filter((e) => {
            if (e.supersededBy) return false;
            if (e.expiresAt && e.expiresAt < now) return false;
            return (
              e.title.toLowerCase().includes(wordLower) ||
              e.content.toLowerCase().includes(wordLower) ||
              e.tags?.some((t) => t.toLowerCase().includes(wordLower))
            );
          })
          .slice(0, 3);

        for (const m of matches) {
          if (!seenIds.has(m._id as unknown as string)) {
            seenIds.add(m._id as unknown as string);
            entries.push({
              _id: m._id as unknown as string,
              category: m.category,
              title: m.title,
              content: m.content,
              relatedProject: m.relatedProject,
            });
          }
        }
      }
    }

    if (entries.length === 0) return "";

    const lines = entries.map((e) => {
      const project = e.relatedProject ? ` (${e.relatedProject})` : "";
      return `- [${e.category}] ${e.title}: ${e.content.substring(0, 200)}${project}`;
    });

    return `**Knowledge Base:**\n${lines.join("\n")}`;
  },
});

/**
 * Semantic (vector) search across knowledge entries.
 */
export const semanticSearch = action({
  args: {
    vector: v.array(v.float64()),
    category: v.optional(v.string()),
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const results = await ctx.vectorSearch("knowledge", "by_embedding", {
      vector: args.vector,
      limit: args.limit ?? 10,
      filter: args.category
        ? (q) => q.eq("category", args.category! as any)
        : undefined,
    });
    return results;
  },
});
