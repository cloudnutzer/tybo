/**
 * History-Search Built-in (nach dem Vorbild
 * von Hermes' session_search).
 *
 * Laesst das Modell selbst in der gespeicherten Konversations-Historie und
 * der Knowledge Base suchen, wenn ihm Kontext fehlt — statt nur das zu
 * sehen, was der Prompt-Builder automatisch injiziert. Vor allem fuer die
 * Fallback-Modelle relevant, die sonst gar keinen Zugriff auf das
 * Gedaechtnis haben.
 *
 * Durchsucht die DM des Owners plus alle in config/topics.json bekannten
 * Gruppen-Chats (semantisch via Edge Function, Substring-Fallback).
 */

import { readFileSync } from "fs";
import { join } from "path";
import { optionalCredential } from "../credentials";
import { searchMessages } from "../supabase";
import { getKnowledgeContext } from "../knowledge-base";
import { registerBuiltinTool } from "./registry";

/** Owner-DM + Gruppen aus config/topics.json (ohne "*"-Wildcard). */
function knownChatIds(): string[] {
  const ids = new Set<string>();
  const owner = optionalCredential("TELEGRAM_USER_ID");
  if (owner) ids.add(owner);
  try {
    const topics = JSON.parse(
      readFileSync(join(process.cwd(), "config", "topics.json"), "utf-8")
    );
    for (const chatId of Object.keys(topics)) {
      if (chatId !== "*") ids.add(chatId);
    }
  } catch {
    // keine topics.json — nur DM durchsuchen
  }
  return Array.from(ids);
}

registerBuiltinTool({
  name: "history_search",
  description:
    "Search the user's stored conversation history and knowledge base (semantic + full text). Use this when you lack context about earlier conversations, decisions, projects, or facts — instead of guessing or saying you don't know.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "What to search for (natural language works)",
      },
      limit: {
        type: "number",
        description: "Max results per source (default 5, max 15)",
      },
    },
    required: ["query"],
  },
  isAvailable: () =>
    !!optionalCredential("SUPABASE_URL") &&
    !!optionalCredential("TELEGRAM_USER_ID"),
  handler: async (args) => {
    const query = String(args.query || "").trim();
    if (!query) return JSON.stringify({ error: "query fehlt" });
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 15);

    const chatIds = knownChatIds();
    const [messageResults, knowledgeCtx] = await Promise.all([
      Promise.all(
        chatIds.map((chatId) =>
          searchMessages(chatId, query, limit).catch(() => [])
        )
      ).then((lists) => lists.flat()),
      getKnowledgeContext(query).catch(() => ""),
    ]);

    // Neueste zuerst, dedupe ueber Inhalt, dann kappen
    const seen = new Set<string>();
    const messages = messageResults
      .sort(
        (a, b) =>
          new Date(b.created_at || 0).getTime() -
          new Date(a.created_at || 0).getTime()
      )
      .filter((m) => {
        const key = m.content.substring(0, 120);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .slice(0, limit)
      .map((m) => ({
        date: m.created_at ? String(m.created_at).substring(0, 16) : "",
        speaker: m.role === "user" ? "User" : "Bot",
        text: m.content.substring(0, 400),
      }));

    return JSON.stringify({
      query,
      messages,
      knowledge_base: knowledgeCtx ? knowledgeCtx.substring(0, 2000) : undefined,
      hint:
        messages.length === 0 && !knowledgeCtx
          ? "Keine Treffer — andere Suchbegriffe versuchen"
          : undefined,
    });
  },
});
