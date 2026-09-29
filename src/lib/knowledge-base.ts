/**
 * Knowledge Base Module
 *
 * Structured knowledge storage with categories, semantic search,
 * archiving, and project linking. Builds on top of the simple
 * facts/goals system in memory.ts with richer categorization.
 *
 * Categories: project, person, preference, learning, process, decision, reference, tool
 *
 * Usage (Claude response tags):
 *   [KNOWLEDGE: category | title | content | project?]
 *   [REMEMBER: fact]  ← backward compat, still handled by memory.ts
 *
 * Requires:
 *   - Supabase with `knowledge` table (see db/schema.sql)
 *   - Optional: OpenAI API key for semantic search embeddings
 */

import { getSupabase } from "./supabase";
import { supabaseHeaders } from "./supabase-keys";
import { getConvex, isConvexEnabled } from "./convex";
import { api } from "../../convex/_generated/api";
import type { Doc, Id } from "../../convex/_generated/dataModel";

function fromConvex(entry: Doc<"knowledge">): KnowledgeEntry {
  return { id: entry._id, created_at: new Date(entry.createdAt).toISOString(),
    updated_at: new Date(entry.updatedAt).toISOString(), category: entry.category,
    title: entry.title, content: entry.content, source: entry.source,
    related_project: entry.relatedProject, related_entities: entry.relatedEntities,
    tags: entry.tags, confidence: entry.confidence, status: entry.status,
    expires_at: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : undefined,
    superseded_by: entry.supersededBy, metadata: entry.metadata };
}
export type KnowledgeWriteResult = { ok: true; message: string } | { ok: false; message: string };


// ============================================================
// TYPES
// ============================================================

export type KnowledgeCategory =
  | "project"
  | "person"
  | "preference"
  | "learning"
  | "process"
  | "decision"
  | "reference"
  | "tool";

export interface KnowledgeEntry {
  id?: string;
  created_at?: string;
  updated_at?: string;
  category: KnowledgeCategory;
  title: string;
  content: string;
  source?: string;
  related_project?: string;
  related_entities?: string[];
  tags?: string[];
  confidence?: number;
  expires_at?: string;
  superseded_by?: string;
  status?: "active" | "archived";
  metadata?: Record<string, unknown>;
}

export interface KnowledgeSearchResult extends KnowledgeEntry {
  similarity?: number;
}

const VALID_CATEGORIES: KnowledgeCategory[] = [
  "project",
  "person",
  "preference",
  "learning",
  "process",
  "decision",
  "reference",
  "tool",
];

// ============================================================
// CRUD OPERATIONS
// ============================================================

/**
 * Add a knowledge entry. If an entry with the same title + category
 * already exists, it updates the existing one instead of duplicating.
 * Generates an embedding async via edge function (if OpenAI key is set).
 */
async function storeKnowledge(entry: KnowledgeEntry): Promise<string> {
  const convex = getConvex();
  if (convex) {
    await convex.mutation(api.knowledge.add, { category: entry.category, title: entry.title, content: entry.content,
      source: entry.source, relatedProject: entry.related_project, relatedEntities: entry.related_entities,
      tags: entry.tags, confidence: entry.confidence, expiresAt: entry.expires_at ? Date.parse(entry.expires_at) : undefined,
      status: entry.status, metadata: entry.metadata });
    return `📚 Learned: [${entry.category}] ${entry.title}`;
  }
  const client = getSupabase();
  if (!client) return "⚠️ Supabase not configured";

  const { data, error } = await client.from("knowledge").upsert({
    category: entry.category, title: entry.title, content: entry.content,
    source: entry.source || "telegram", related_project: entry.related_project || null,
    related_entities: entry.related_entities || [], tags: entry.tags || [],
    confidence: entry.confidence ?? 1, expires_at: entry.expires_at || null,
    status: entry.status || "active", metadata: entry.metadata || {}, updated_at: new Date().toISOString(),
  }, { onConflict: "category,title" }).select("id").single();
  if (error || !data?.id) throw error || new Error("Knowledge storage returned no ID");
  void generateEmbedding(data.id, `${entry.title}: ${entry.content}`).catch(() => {});
  return `📚 Saved: [${entry.category}] ${entry.title}`;
}

/**
 * Generate and store an embedding for a knowledge entry.
 * Uses the embed-knowledge edge function (Anbieter aus EMBEDDING_PROVIDER,
 * Standard OpenAI text-embedding-3-small, Issue #167).
 * Silently skips if no key is configured on the edge function.
 */
async function generateEmbedding(knowledgeId: string, text: string): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !supabaseKey) return;

  try {
    const response = await fetch(
      `${supabaseUrl}/functions/v1/embed-knowledge`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...supabaseHeaders(supabaseKey),
        },
        body: JSON.stringify({ knowledge_id: knowledgeId, text }),
      }
    );

    if (!response.ok) {
      // Edge function not deployed or OpenAI key missing — that's fine
      return;
    }
  } catch {
    // Edge function unavailable — knowledge still saved, just no embedding
  }
}

// ============================================================
// ARCHIVING
// ============================================================

/**
 * Archive a knowledge entry by ID. Keeps the row for history but
 * excludes it from all active searches.
 */
export async function archiveKnowledge(
  id: string,
  reason?: string
): Promise<string> {
  const convex = getConvex();
  if (convex) return await convex.mutation(api.knowledge.archive, { id: id as Id<"knowledge">, reason }) ? "🗄️ Archived" : "⚠️ Entry not found";
  const client = getSupabase();
  if (!client) return "⚠️ Supabase not configured";

  try {
    const { data: entry } = await client
      .from("knowledge")
      .select("title, category")
      .eq("id", id)
      .single();

    if (!entry) return `⚠️ Knowledge entry not found: ${id}`;

    const update: Record<string, unknown> = {
      status: "archived",
      updated_at: new Date().toISOString(),
    };

    if (reason) {
      update.metadata = { archive_reason: reason };
    }

    const { error } = await client
      .from("knowledge")
      .update(update)
      .eq("id", id);

    if (error) {
      console.error("archiveKnowledge error:", error.message);
      return `⚠️ Failed to archive: ${error.message}`;
    }

    return `🗄️ Archived: [${entry.category}] ${entry.title}${reason ? ` (${reason})` : ""}`;
  } catch (err) {
    console.error("archiveKnowledge exception:", err);
    return "⚠️ Failed to archive knowledge";
  }
}

/**
 * Search archived knowledge explicitly (for historical context).
 */
export async function searchArchived(
  query: string,
  limit: number = 10
): Promise<KnowledgeSearchResult[]> {
  const convex = getConvex();
  if (convex) return (await convex.query(api.knowledge.searchArchived, { query, limit })).map(fromConvex);
  const client = getSupabase();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from("knowledge")
      .select("*")
      .eq("status", "archived")
      .or(`title.ilike.%${query.replace(/[^\p{L}\p{N} _-]/gu, " ")}%,content.ilike.%${query.replace(/[^\p{L}\p{N} _-]/gu, " ")}%,tags.cs.{${query.replace(/[^\p{L}\p{N} _-]/gu, " ")}}`)
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("searchArchived error:", error.message);
      return [];
    }

    return (data || []) as KnowledgeSearchResult[];
  } catch (err) {
    console.error("searchArchived exception:", err);
    return [];
  }
}

// ============================================================
// SEARCH & RETRIEVAL
// ============================================================

/**
 * Search active knowledge by text query, optionally filtered by category.
 * Uses text matching (ilike). For semantic search, the match_knowledge()
 * SQL function can be called via the search-memory edge function.
 */
export async function searchKnowledge(
  query: string,
  category?: KnowledgeCategory,
  limit: number = 10
): Promise<KnowledgeSearchResult[]> {
  const convex = getConvex();
  if (convex) return (await convex.query(api.knowledge.search, { query, category, limit })).map(fromConvex);
  const client = getSupabase();
  if (!client) return [];

  try {
    let q = client
      .from("knowledge")
      .select("*")
      .eq("status", "active")
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (category) {
      q = q.eq("category", category);
    }

    // Text search across title, content, tags
    q = q.or(`title.ilike.%${query.replace(/[^\p{L}\p{N} _-]/gu, " ")}%,content.ilike.%${query.replace(/[^\p{L}\p{N} _-]/gu, " ")}%,tags.cs.{${query.replace(/[^\p{L}\p{N} _-]/gu, " ")}}`);

    // Exclude expired entries
    q = q.or("expires_at.is.null,expires_at.gt." + new Date().toISOString());

    // Exclude superseded entries
    q = q.is("superseded_by", null);

    const { data, error } = await q;

    if (error) {
      console.error("searchKnowledge error:", error.message);
      return [];
    }

    return (data || []) as KnowledgeSearchResult[];
  } catch (err) {
    console.error("searchKnowledge exception:", err);
    return [];
  }
}

/**
 * Get all knowledge linked to a specific project.
 */
export async function getKnowledgeByProject(
  project: string,
  limit: number = 20
): Promise<KnowledgeEntry[]> {
  const convex = getConvex();
  if (convex) return (await convex.query(api.knowledge.getByProject, { project, limit })).map(fromConvex);
  const client = getSupabase();
  if (!client) return [];

  try {
    const { data, error } = await client
      .from("knowledge")
      .select("*")
      .eq("status", "active")
      .ilike("related_project", `%${project}%`)
      .is("superseded_by", null)
      .or("expires_at.is.null,expires_at.gt." + new Date().toISOString())
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("getKnowledgeByProject error:", error.message);
      return [];
    }

    return (data || []) as KnowledgeEntry[];
  } catch (err) {
    console.error("getKnowledgeByProject exception:", err);
    return [];
  }
}

/**
 * Get recent knowledge entries, optionally filtered by category.
 */
export async function getRecentKnowledge(
  limit: number = 10,
  category?: KnowledgeCategory
): Promise<KnowledgeEntry[]> {
  const convex = getConvex();
  if (convex) return (await convex.query(api.knowledge.getRecent, { category, limit })).map(fromConvex);
  const client = getSupabase();
  if (!client) return [];

  try {
    let q = client
      .from("knowledge")
      .select("*")
      .eq("status", "active")
      .is("superseded_by", null)
      .or("expires_at.is.null,expires_at.gt." + new Date().toISOString())
      .order("updated_at", { ascending: false })
      .limit(limit);

    if (category) {
      q = q.eq("category", category);
    }

    const { data, error } = await q;

    if (error) {
      console.error("getRecentKnowledge error:", error.message);
      return [];
    }

    return (data || []) as KnowledgeEntry[];
  } catch (err) {
    console.error("getRecentKnowledge exception:", err);
    return [];
  }
}

/**
 * Build context string from knowledge entries relevant to the current message.
 * Includes recent high-priority knowledge (projects, decisions, preferences)
 * plus keyword-matched entries from the user's message.
 */
export async function getKnowledgeContext(
  userMessage?: string
): Promise<string> {
  if (!isConvexEnabled()) return "";

  try {
    const entries: KnowledgeEntry[] = [];

    // Always include recent high-value knowledge
    const priorityCategories: KnowledgeCategory[] = [
      "project",
      "decision",
      "preference",
    ];
    for (const cat of priorityCategories) {
      const recent = await getRecentKnowledge(3, cat);
      entries.push(...recent);
    }

    // If we have a user message, search for relevant knowledge
    if (userMessage && userMessage.length > 5) {
      const words = userMessage
        .replace(/[^\w\s]/g, "")
        .split(/\s+/)
        .filter((w) => w.length > 3)
        .slice(0, 3);

      for (const word of words) {
        const matches = await searchKnowledge(word, undefined, 3);
        for (const m of matches) {
          if (!entries.find((e) => e.id === m.id)) {
            entries.push(m);
          }
        }
      }
    }

    if (entries.length === 0) return "";

    const lines = entries.map((e) => {
      const project = e.related_project ? ` (${e.related_project})` : "";
      return `- [${e.category}] ${e.title}: ${e.content.substring(0, 200)}${project}`;
    });

    return `**Knowledge Base:**\n${lines.join("\n")}`;
  } catch (err) {
    console.error("getKnowledgeContext exception:", err);
    return "";
  }
}

// ============================================================
// INTENT TAG PARSING
// ============================================================

/**
 * Parse [KNOWLEDGE: category | title | content | project?] tag from Claude response.
 * Returns parsed entry or null if no tag found.
 */
export function parseKnowledgeTag(
  response: string
): { entry: KnowledgeEntry; rawTag: string } | null {
  const match = response.match(
    /\[KNOWLEDGE:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)(?:\s*\|\s*(.+?))?\]/i
  );
  if (!match) return null;

  const category = match[1].trim().toLowerCase() as KnowledgeCategory;

  if (!VALID_CATEGORIES.includes(category)) {
    console.warn(`Invalid knowledge category: ${category}`);
    return null;
  }

  return {
    entry: {
      category,
      title: match[2].trim(),
      content: match[3].trim(),
      related_project: match[4]?.trim() || undefined,
      source: "telegram",
    },
    rawTag: match[0],
  };
}

/**
 * Parse ALL [KNOWLEDGE:] tags from a response (there may be multiple).
 */
export function parseAllKnowledgeTags(
  response: string
): { entry: KnowledgeEntry; rawTag: string }[] {
  const results: { entry: KnowledgeEntry; rawTag: string }[] = [];
  const regex =
    /\[KNOWLEDGE:\s*(.+?)\s*\|\s*(.+?)\s*\|\s*(.+?)(?:\s*\|\s*(.+?))?\]/gi;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(response)) !== null) {
    const category = match[1].trim().toLowerCase() as KnowledgeCategory;
    if (!VALID_CATEGORIES.includes(category)) continue;

    results.push({
      entry: {
        category,
        title: match[2].trim(),
        content: match[3].trim(),
        related_project: match[4]?.trim() || undefined,
        source: "telegram",
      },
      rawTag: match[0],
    });
  }

  return results;
}

export async function addKnowledge(entry: KnowledgeEntry): Promise<KnowledgeWriteResult> {
  try {
    const message = await storeKnowledge(entry);
    return { ok: !message.startsWith("⚠️"), message };
  } catch (error) { return { ok: false, message: "Knowledge storage failed" }; }
}
