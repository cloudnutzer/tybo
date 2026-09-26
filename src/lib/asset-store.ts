import { extname } from "node:path";
/**
 * Asset Store — Persistent image/file storage with AI descriptions
 *
 * Backend detection:
 *   CONVEX_URL set → Convex Storage (generateUploadUrl + file upload)
 *   SUPABASE_URL set → Supabase Storage bucket
 *   Neither → returns null (no storage)
 *
 * Two flows depending on processing mode:
 *
 * MAC (Claude Code CLI / subscription auth):
 * 1. Image received → saved locally + uploaded to storage
 * 2. File path passed to Claude Code (Opus reads image natively)
 * 3. AFTER response: parse [ASSET_DESC] tag → update description + embedding
 *
 * VPS (Anthropic API / no Claude Code):
 * 1. Image received → uploaded to storage (no local save)
 * 2. Haiku vision generates description (VPS can't read local files)
 * 3. Description passed to Anthropic processor
 */

import { readFile } from "fs/promises";
import { basename } from "path";
import { anyApi } from "convex/server";

// ============================================================
// TYPES
// ============================================================

export interface AssetMetadata {
  userCaption?: string;
  conversationContext?: string;
  relatedProject?: string;
  channel?: string;
  telegramFileId?: string;
}

export interface Asset {
  id: string;
  created_at: string;
  storage_path: string;
  public_url: string | null;
  original_filename: string | null;
  file_type: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  description: string;
  user_caption: string | null;
  conversation_context: string | null;
  related_project: string | null;
  tags: string[];
  channel: string;
  metadata: Record<string, any>;
}

interface VisionResult {
  description: string;
  tags: string[];
  suggestedProject: string | null;
}

// Storage bucket name (Supabase): SUPABASE_ASSETS_BUCKET, Standard tybo-assets
export const DEFAULT_ASSETS_BUCKET = "tybo-assets";

export function assetsBucket(env: Record<string, string | undefined> = process.env): string {
  return env.SUPABASE_ASSETS_BUCKET?.trim() || DEFAULT_ASSETS_BUCKET;
}

// ============================================================
// BACKEND DETECTION
// ============================================================

function getBackend(): "convex" | "supabase" | "none" {
  if (process.env.CONVEX_URL) return "convex";
  if (process.env.SUPABASE_URL) return "supabase";
  return "none";
}

async function getConvexClient() {
  const { getConvex } = await import("./convex");
  return getConvex();
}

async function getSupabaseClient() {
  try {
    const { getSupabase } = await import("./supabase");
    return getSupabase();
  } catch {
    return null;
  }
}

function convexDocToAsset(doc: any): Asset {
  return {
    id: doc._id,
    created_at: new Date(doc.createdAt || doc._creationTime).toISOString(),
    storage_path: doc.storagePath || "",
    public_url: doc.publicUrl || null,
    original_filename: doc.originalFilename || null,
    file_type: doc.fileType,
    mime_type: doc.mimeType || null,
    file_size_bytes: doc.fileSizeBytes || null,
    description: doc.description,
    user_caption: doc.userCaption || null,
    conversation_context: doc.conversationContext || null,
    related_project: doc.relatedProject || null,
    tags: doc.tags || [],
    channel: doc.channel || "telegram",
    metadata: doc.metadata || {},
  };
}

// ============================================================
// QUICK UPLOAD (Mac path — no vision call, Claude Code reads image)
// ============================================================

/**
 * Upload file with a placeholder description.
 * Used on Mac path where Claude Code (Opus) reads the image directly.
 * The description gets updated async AFTER Claude responds.
 */
export async function uploadAssetQuick(
  localPath: string,
  metadata: AssetMetadata & {
    originalFilename?: string;
    fileType?: string;
    mimeType?: string;
  }
): Promise<Asset | null> {
  return uploadAsset(localPath, {
    ...metadata,
    description: metadata.userCaption || "Image (pending description)",
    tags: [],
    suggestedProject: null,
  });
}

/**
 * Upload from a Buffer (VPS path — no local file).
 */
export async function uploadAssetFromBuffer(
  buffer: Buffer,
  filename: string,
  metadata: AssetMetadata & {
    description: string;
    tags?: string[];
    suggestedProject?: string | null;
    fileType?: string;
    mimeType?: string;
  }
): Promise<Asset | null> {
  const backend = getBackend();

  const ext = filename.split(".").pop()?.toLowerCase() || "bin";
  const imageExts = ["jpg", "jpeg", "png", "gif", "webp", "bmp", "svg"];
  const audioExts = ["mp3", "ogg", "wav", "m4a", "oga"];
  let fileType = metadata.fileType || "document";
  if (!metadata.fileType) {
    if (imageExts.includes(ext)) fileType = "image";
    else if (audioExts.includes(ext)) fileType = "audio";
  }

  const mimeMap: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    pdf: "application/pdf",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
  };
  const mimeType =
    metadata.mimeType || mimeMap[ext] || "application/octet-stream";

  // ---- Convex path ----
  if (backend === "convex") {
    const client = await getConvexClient();
    if (!client) {
      console.warn("⚠️ Convex not configured — asset not uploaded");
      return null;
    }

    try {
      // 1. Get upload URL from Convex
      const uploadUrl: string = await client.mutation(
        anyApi.assets.generateUploadUrl,
        {}
      );

      // 2. Upload file to Convex storage
      const uploadResponse = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": mimeType },
        body: new Uint8Array(buffer),
      });

      if (!uploadResponse.ok) {
        console.error("Convex storage upload error:", await uploadResponse.text());
        return null;
      }

      const { storageId } = await uploadResponse.json();

      // 3. Insert asset metadata with storage reference
      const doc = await client.mutation(anyApi.assets.insertWithStorage, {
        storageId,
        originalFilename: filename,
        fileType,
        mimeType,
        fileSizeBytes: buffer.length,
        description: metadata.description,
        userCaption: metadata.userCaption || undefined,
        conversationContext: metadata.conversationContext || undefined,
        relatedProject:
          metadata.suggestedProject || metadata.relatedProject || undefined,
        tags: metadata.tags || [],
        channel: metadata.channel || "telegram",
        metadata: {
          telegramFileId: metadata.telegramFileId,
        },
      });

      console.log(`📦 Asset stored in Convex: ${filename} (${fileType})`);
      return doc ? convexDocToAsset(doc) : null;
    } catch (err) {
      console.error("uploadAssetFromBuffer (Convex) error:", err);
      return null;
    }
  }

  // ---- Supabase path ----
  if (backend === "supabase") {
    const client = await getSupabaseClient();
    if (!client) {
      console.warn("⚠️ Supabase not configured — asset not uploaded");
      return null;
    }

    try {
      const storagePath = `${fileType}s/${new Date().toISOString().split("T")[0]}/${crypto.randomUUID()}${extname(filename).replace(/[^.a-zA-Z0-9]/g, "")}`;

      const { error: uploadError } = await client.storage
        .from(assetsBucket())
        .upload(storagePath, buffer, {
          contentType: mimeType,
          upsert: false,
        });

      if (uploadError) {
        console.error("Storage upload error:", uploadError.message);
        return null;
      }

      const { data: urlData } = await client.storage.from(assetsBucket()).createSignedUrl(storagePath, 900);
      const publicUrl = urlData?.signedUrl || null;

      const { data, error: insertError } = await client
        .from("assets")
        .insert({
          storage_path: storagePath,
          public_url: null,
          original_filename: filename,
          file_type: fileType,
          mime_type: mimeType,
          file_size_bytes: buffer.length,
          description: metadata.description,
          user_caption: metadata.userCaption || null,
          conversation_context: metadata.conversationContext || null,
          related_project:
            metadata.suggestedProject || metadata.relatedProject || null,
          tags: metadata.tags || [],
          channel: metadata.channel || "telegram",
          metadata: {
            telegramFileId: metadata.telegramFileId,
          },
        })
        .select()
        .single();

      if (insertError) {
        console.error("Asset insert error:", insertError.message);
        return null;
      }

      console.log(`📦 Asset stored: ${storagePath} (${fileType})`);
      return signAsset(data as Asset);
    } catch (err) {
      console.error("uploadAssetFromBuffer error:", err);
      return null;
    }
  }

  console.warn("⚠️ No storage backend configured — asset not uploaded");
  return null;
}

/**
 * Update an existing asset's description after Claude has responded.
 * Called async (fire-and-forget) after the main response is sent.
 */
export async function updateAssetDescription(
  assetId: string,
  description: string,
  tags?: string[],
  relatedProject?: string | null
): Promise<void> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = await getConvexClient();
    if (!client) return;

    try {
      await client.mutation(anyApi.assets.updateDescription, {
        id: assetId,
        description,
        tags: tags || [],
        relatedProject: relatedProject || undefined,
      });
      console.log(
        `📝 Asset ${assetId.substring(0, 8)} description updated (Convex)`
      );
    } catch (err) {
      console.error("updateAssetDescription (Convex) error:", err);
    }
    return;
  }

  if (backend === "supabase") {
    const client = await getSupabaseClient();
    if (!client) return;

    try {
      const updateData: Record<string, any> = { description };
      if (tags && tags.length > 0) updateData.tags = tags;
      if (relatedProject) updateData.related_project = relatedProject;

      const embedding = await generateEmbedding(
        `${description} ${(tags || []).join(" ")}`
      );
      if (embedding) updateData.embedding = embedding;

      const { error } = await client
        .from("assets")
        .update(updateData)
        .eq("id", assetId);

      if (error) {
        console.error("updateAssetDescription error:", error.message);
      } else {
        console.log(
          `📝 Asset ${assetId.substring(0, 8)} description updated${embedding ? " (with embedding)" : ""}`
        );
      }
    } catch (err) {
      console.error("updateAssetDescription exception:", err);
    }
  }
}

/**
 * Generate an embedding vector. Tries Gemini (free) first, then OpenAI.
 * Gracefully returns null if no API key is set.
 */
async function generateEmbedding(text: string): Promise<number[] | null> {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    try {
      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${geminiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "models/text-embedding-004",
            content: { parts: [{ text }] },
            outputDimensionality: 1536,
          }),
        }
      );
      if (response.ok) {
        const data = await response.json();
        return data.embedding?.values || null;
      }
    } catch {
      // Fall through to OpenAI
    }
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (!openaiKey) return null;

  try {
    const response = await fetch("https://api.openai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${openaiKey}`,
      },
      body: JSON.stringify({
        model: "text-embedding-3-small",
        input: text,
        dimensions: 1536,
      }),
    });

    if (!response.ok) {
      console.error("Embedding API error:", await response.text());
      return null;
    }

    const result = await response.json();
    return result.data?.[0]?.embedding || null;
  } catch (err) {
    console.error("generateEmbedding error:", err);
    return null;
  }
}

// ============================================================
// IMAGE DESCRIPTION (Haiku Vision — for VPS path)
// ============================================================

/**
 * Use Anthropic Haiku to describe an image.
 * Used on VPS path where Claude Code can't read local files.
 */
export async function describeImage(
  localPath: string,
  caption?: string,
  recentContext?: string
): Promise<VisionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("⚠️ No ANTHROPIC_API_KEY — skipping vision description");
    return {
      description: caption || "Image (no description available)",
      tags: [],
      suggestedProject: null,
    };
  }

  try {
    const imageBuffer = await readFile(localPath);
    return describeImageFromBuffer(
      imageBuffer,
      localPath,
      caption,
      recentContext
    );
  } catch (err) {
    console.error("describeImage error:", err);
    return {
      description: caption || "Image (description failed)",
      tags: [],
      suggestedProject: null,
    };
  }
}

/**
 * Describe an image from a Buffer (VPS path — no local file).
 */
export async function describeImageFromBuffer(
  imageBuffer: Buffer,
  filename: string,
  caption?: string,
  recentContext?: string
): Promise<VisionResult> {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENROUTER_API_KEY) {
    console.warn(
      "⚠️ No ANTHROPIC_API_KEY or OPENROUTER_API_KEY — skipping vision description"
    );
    return {
      description: caption || "Image (no description available)",
      tags: [],
      suggestedProject: null,
    };
  }

  try {
    const { createResilientMessage, getModelForProvider } = await import(
      "./resilient-client"
    );

    const base64 = imageBuffer.toString("base64");

    const ext = filename.split(".").pop()?.toLowerCase() || "jpg";
    const mimeMap: Record<string, string> = {
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      png: "image/png",
      gif: "image/gif",
      webp: "image/webp",
    };
    const mediaType = mimeMap[ext] || "image/jpeg";

    let promptParts: string[] = [];

    if (caption) {
      promptParts.push(
        `The user sent this image with the message: "${caption}"\nAnalyze the image with this context in mind.`
      );
    }
    if (recentContext) {
      promptParts.push(`Recent conversation for context:\n${recentContext}`);
    }
    promptParts.push(`Describe this image concisely for future reference. Include:
1. What the image shows (objects, text, UI elements, people, etc.)
2. Any text visible in the image
3. The apparent purpose/context${caption ? " — especially in relation to the user's message" : ""}

Respond in JSON only:
{
  "description": "A concise 1-2 sentence description",
  "tags": ["tag1", "tag2", "tag3"],
  "suggestedProject": "project name or null"
}`);

    const response = await createResilientMessage({
      model: getModelForProvider("claude-opus-5-5"),
      max_tokens: 400,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: promptParts.join("\n\n"),
            },
            {
              type: "image",
              source: {
                type: "base64",
                media_type: mediaType as any,
                data: base64,
              },
            },
          ],
        },
      ],
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const text = (textBlock as any)?.text || "";

    // Robust JSON extraction: Haiku sometimes returns markdown instead of clean JSON
    let parsed: any = null;
    try {
      const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      parsed = JSON.parse(jsonStr);
    } catch {
      const jsonStart = text.indexOf("{");
      const jsonEnd = text.lastIndexOf("}");
      if (jsonStart !== -1 && jsonEnd > jsonStart) {
        try {
          parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
        } catch {
          console.log("Vision returned non-JSON, using raw text as description");
        }
      }
    }

    if (parsed) {
      return {
        description: parsed.description || caption || "Image",
        tags: Array.isArray(parsed.tags) ? parsed.tags : [],
        suggestedProject: parsed.suggestedProject || null,
      };
    }

    // Fallback: use raw vision text as description
    return {
      description: text.replace(/[*_#`]/g, "").trim().slice(0, 500) || caption || "Image",
      tags: [],
      suggestedProject: null,
    };
  } catch (err) {
    console.error("describeImageFromBuffer error:", err);
    return {
      description: caption || "Image (description failed)",
      tags: [],
      suggestedProject: null,
    };
  }
}

// ============================================================
// UPLOAD & STORAGE
// ============================================================

/**
 * Upload a file from local path to storage and insert metadata.
 */
export async function uploadAsset(
  localPath: string,
  metadata: AssetMetadata & {
    description: string;
    tags?: string[];
    suggestedProject?: string | null;
    originalFilename?: string;
    fileType?: string;
    mimeType?: string;
  }
): Promise<Asset | null> {
  try {
    const fileBuffer = await readFile(localPath);
    const filename = metadata.originalFilename || basename(localPath);

    return uploadAssetFromBuffer(fileBuffer, filename, {
      ...metadata,
      fileType: metadata.fileType,
      mimeType: metadata.mimeType,
    });
  } catch (err) {
    console.error("uploadAsset error:", err);
    return null;
  }
}

// ============================================================
// RETRIEVAL
// ============================================================

/**
 * Get recent assets, optionally filtered by file type.
 */
export async function getRecentAssets(
  limit: number = 5,
  fileType?: string
): Promise<Asset[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = await getConvexClient();
    if (!client) return [];

    try {
      const docs = await client.query(anyApi.assets.getRecent, {
        limit,
        fileType,
      });
      return (docs || []).map(convexDocToAsset);
    } catch (err) {
      console.error("getRecentAssets (Convex) error:", err);
      return [];
    }
  }

  if (backend === "supabase") {
    const client = await getSupabaseClient();
    if (!client) return [];

    try {
      let query = client
        .from("assets")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);

      if (fileType) {
        query = query.eq("file_type", fileType);
      }

      const { data, error } = await query;
      if (error) {
        console.error("getRecentAssets error:", error.message);
        return [];
      }
      return Promise.all(((data || []) as Asset[]).map(signAsset));
    } catch (err) {
      console.error("getRecentAssets exception:", err);
      return [];
    }
  }

  return [];
}

/**
 * Search assets by text query (description + tags).
 */
export async function searchAssets(
  query: string,
  limit: number = 5
): Promise<Asset[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = await getConvexClient();
    if (!client) return [];

    try {
      const docs = await client.query(anyApi.assets.textSearch, {
        query,
        limit,
      });
      return (docs || []).map(convexDocToAsset);
    } catch (err) {
      console.error("searchAssets (Convex) error:", err);
      return [];
    }
  }

  if (backend === "supabase") {
    const client = await getSupabaseClient();
    if (!client) return [];

    try {
      const { data, error } = await client
        .from("assets")
        .select("*")
        .or(`description.ilike.%${query}%,tags.cs.{${query}}`)
        .order("created_at", { ascending: false })
        .limit(limit);

      if (error) {
        console.error("searchAssets error:", error.message);
        return [];
      }
      return Promise.all(((data || []) as Asset[]).map(signAsset));
    } catch (err) {
      console.error("searchAssets exception:", err);
      return [];
    }
  }

  return [];
}

/**
 * Get a single asset by ID.
 */
export async function getAssetById(assetId: string): Promise<Asset | null> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = await getConvexClient();
    if (!client) return null;

    try {
      const doc = await client.query(anyApi.assets.getById, { id: assetId });
      return doc ? convexDocToAsset(doc) : null;
    } catch {
      return null;
    }
  }

  if (backend === "supabase") {
    const client = await getSupabaseClient();
    if (!client) return null;

    try {
      const { data, error } = await client
        .from("assets")
        .select("*")
        .eq("id", assetId)
        .single();

      if (error) return null;
      return signAsset(data as Asset);
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Format recent assets as context string for prompt injection.
 */
export async function getAssetContext(limit: number = 5): Promise<string> {
  const assets = await getRecentAssets(limit);
  if (assets.length === 0) return "";

  const lines = assets.map((a) => {
    const age = getTimeAgo(a.created_at);
    const tags = a.tags.length > 0 ? ` [${a.tags.join(", ")}]` : "";
    return `- ${a.description}${tags} (${age}, id: ${a.id.substring(0, 8)})`;
  });

  return `\n\nRECENT IMAGES/FILES:\n${lines.join("\n")}`;
}

// ============================================================
// PARSE HELPERS
// ============================================================

/**
 * Parse [ASSET_DESC: description | tag1, tag2] from Claude's response.
 * Returns null if no tag found.
 */
export function parseAssetDescTag(
  response: string
): { description: string; tags: string[] } | null {
  const match = response.match(
    /\[ASSET_DESC:\s*(.+?)(?:\s*\|\s*(.+?))?\s*\]/
  );
  if (!match) return null;

  const description = match[1].trim();
  const tags = match[2]
    ? match[2]
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  return { description, tags };
}

/**
 * Strip [ASSET_DESC: ...] tag from response before sending to user.
 */
export function stripAssetDescTag(response: string): string {
  return response.replace(/\s*\[ASSET_DESC:[^\]]+\]\s*/g, "").trim();
}

// ============================================================
// HELPERS
// ============================================================

function getTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 60) return `${diffMins}min ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return `${Math.floor(diffDays / 7)}w ago`;
}

async function signAsset(asset: Asset): Promise<Asset> {
  const client = await getSupabaseClient();
  if (!client || !asset.storage_path) return { ...asset, public_url: null };
  const { data, error } = await client.storage.from(assetsBucket()).createSignedUrl(asset.storage_path, 900);
  return { ...asset, public_url: error ? null : data?.signedUrl || null };
}
