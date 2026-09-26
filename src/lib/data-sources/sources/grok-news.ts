/**
 * Grok News Data Source
 *
 * Fetches AI news summary from xAI's Grok API.
 * Quick, cheap alternative to a full research agent.
 *
 * Required env vars: XAI_API_KEY
 */

import { register } from "../registry";
import type { DataSource, DataSourceResult } from "../types";

const grokNewsSource: DataSource = {
  id: "grok-news",
  name: "AI News (Grok)",
  emoji: "📰",

  isAvailable(): boolean {
    return !!process.env.XAI_API_KEY;
  },

  async fetch(): Promise<DataSourceResult> {
    const apiKey = process.env.XAI_API_KEY!;

    const response = await fetch("https://api.x.ai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "grok-3-mini-fast",
        messages: [
          {
            role: "system",
            content:
              "You are a concise AI news briefer. Return 3-5 bullet points about the most important AI news from the last 24 hours. Each bullet should be one sentence with a source link or @handle. Format: • [news item] (source). No headers, no fluff. Only include news you found via search — never make up stories.",
          },
          {
            role: "user",
            content: "What are today's top AI news stories?",
          },
        ],
        max_tokens: 300,
        temperature: 0,
        search_mode: "on",
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Grok API error (${response.status}): ${text}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content?.trim();

    if (!content) {
      return { lines: ["No news available"], meta: { empty: true } };
    }

    // Validate that the response contains search citations
    const hasSearchResults =
      data.choices?.[0]?.message?.search_results?.length > 0 ||
      data.choices?.[0]?.search_results?.length > 0 ||
      content.includes("@") ||
      content.includes("x.com") ||
      content.includes("twitter.com") ||
      content.includes("http");

    if (!hasSearchResults && !content.toLowerCase().includes("quiet")) {
      console.warn("Grok news response has no search citations — likely hallucinated, skipping");
      return {
        lines: ["Quiet 24h in AI — no verified news from search."],
        meta: { model: "grok-3-mini-fast", filtered: true },
      };
    }

    // Split into lines and clean up
    const lines = content
      .split("\n")
      .map((l: string) => l.trim())
      .filter((l: string) => l.length > 0);

    return { lines, meta: { model: "grok-3-mini-fast" } };
  },
};

register(grokNewsSource);
