"use node";
import { requireOwner } from "./auth";

import { action } from "./_generated/server";
import { internal } from "./_generated/api";
import { v } from "convex/values";

const EMBEDDING_DIMENSIONS = 1536;

/**
 * Generate an embedding vector via Gemini (free) or OpenAI (fallback).
 *
 * Priority: GEMINI_API_KEY → OPENAI_API_KEY
 * Gemini text-embedding-004 is free and produces 768-dim vectors by default,
 * but we request 1536 to match our vector indexes.
 */
async function generateEmbedding(text: string): Promise<number[]> {
  const geminiKey = process.env.GEMINI_API_KEY;
  if (geminiKey) {
    return generateGeminiEmbedding(text, geminiKey);
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    return generateOpenAIEmbedding(text, openaiKey);
  }

  throw new Error(
    "No embedding API key set. Add GEMINI_API_KEY (free) or OPENAI_API_KEY to Convex environment."
  );
}

/**
 * Gemini text-embedding-004 — FREE tier, excellent quality.
 */
async function generateGeminiEmbedding(
  text: string,
  apiKey: string
): Promise<number[]> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "models/text-embedding-004",
        content: { parts: [{ text }] },
        outputDimensionality: EMBEDDING_DIMENSIONS,
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `Gemini embedding API error: ${response.status} ${error}`
    );
  }

  const data = await response.json();
  return data.embedding.values;
}

/**
 * OpenAI text-embedding-3-small — fallback if Gemini key not set.
 */
async function generateOpenAIEmbedding(
  text: string,
  apiKey: string
): Promise<number[]> {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: "text-embedding-3-small",
      input: text,
      dimensions: EMBEDDING_DIMENSIONS,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(
      `OpenAI embedding API error: ${response.status} ${error}`
    );
  }

  const data = await response.json();
  return data.data[0].embedding;
}

/**
 * Generate and store an embedding for a message.
 */
export const generateMessageEmbedding = action({
  args: {
    messageId: v.id("messages"),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const embedding = await generateEmbedding(args.text);
    await ctx.runMutation(internal.embeddingPatches.patchMessageEmbedding, {
      id: args.messageId,
      embedding,
    });
  },
});

/**
 * Generate and store an embedding for an asset.
 */
export const generateAssetEmbedding = action({
  args: {
    assetId: v.id("assets"),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const embedding = await generateEmbedding(args.text);
    await ctx.runMutation(internal.embeddingPatches.patchAssetEmbedding, {
      id: args.assetId,
      embedding,
    });
  },
});

/**
 * Generate and store an embedding for a knowledge entry.
 */
export const generateKnowledgeEmbedding = action({
  args: {
    knowledgeId: v.id("knowledge"),
    text: v.string(),
  },
  handler: async (ctx, args) => {
    await requireOwner(ctx);
    const embedding = await generateEmbedding(args.text);
    await ctx.runMutation(internal.embeddingPatches.patchKnowledgeEmbedding, {
      id: args.knowledgeId,
      embedding,
    });
  },
});

// Internal mutations live in embeddingPatches.ts (mutations can't be in "use node" files)
