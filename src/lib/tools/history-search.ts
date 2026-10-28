/**
 * History-Search Built-in (nach dem Vorbild
 * von Hermes' session_search).
 *
 * Laesst das Modell selbst in der gespeicherten Konversations-Historie, der
 * Knowledge Base und den gespeicherten Bildern suchen, wenn ihm Kontext
 * fehlt — statt nur das zu sehen, was der Prompt-Builder automatisch
 * injiziert. Vor allem fuer die Fallback-Modelle relevant, die sonst gar
 * keinen Zugriff auf das Gedaechtnis haben.
 *
 * Durchsucht den Direktchat (Telegram-Nutzer-ID, ohne Telegram "web",
 * Entscheidung 0021) plus alle in config/topics.json bekannten Gruppen-Chats
 * (semantisch via Edge Function, Substring-Fallback). Bilder (Issue #318)
 * kommen aus getStore().assets.search mit frisch signiertem Link, der 15
 * Minuten gilt. Scheitert eine Quelle, liefern die anderen trotzdem.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { LINK_LIFETIME_SECONDS } from "../assets/bucket";
import { dmChatId } from "../channels";
import { optionalCredential } from "../credentials";
import { getSupabase } from "../supabase";
import { supabaseMessageReads } from "../store/supabase/message-reads";
import { getKnowledgeContext } from "../knowledge-base";
import { storeOr } from "../store";
import type { Asset, Message } from "../store/types";
import { registerBuiltinTool } from "./registry";

/**
 * TELEGRAM_USER_ID (wie bisher, auch ohne Bot-Token), der Direktchat
 * (ohne Telegram "web") und die Gruppen aus config/topics.json (ohne "*").
 */
function knownChatIds(): string[] {
  const ids = new Set<string>();
  const owner = optionalCredential("TELEGRAM_USER_ID");
  if (owner) ids.add(owner);
  ids.add(dmChatId());
  try {
    const topics = JSON.parse(
      readFileSync(join(process.cwd(), "config", "topics.json"), "utf-8")
    );
    for (const chatId of Object.keys(topics)) {
      if (chatId !== "*") ids.add(chatId);
    }
  } catch {
    // keine topics.json — nur den Direktchat durchsuchen
  }
  return Array.from(ids);
}

/** Quellen der Suche; Tests setzen eigene ein */
export interface HistorySearchDeps {
  chatIds: () => string[];
  searchMessages: (chatId: string, query: string, limit: number) => Promise<Message[]>;
  knowledgeContext: (query: string) => Promise<string>;
  searchImages: (query: string, limit: number) => Promise<Asset[]>;
}

const defaultDeps: HistorySearchDeps = {
  chatIds: knownChatIds,
  // Nur Supabase, ohne Datenbank leer
  searchMessages: (chatId, query, limit) => supabaseMessageReads(getSupabase).search(chatId, query, limit),
  knowledgeContext: query => getKnowledgeContext(query),
  searchImages: (query, limit) => storeOr<Asset[]>([], store => store.assets.search(query, limit)),
};

/** Ein Bildtreffer, so wie ihn das Modell sieht */
function imageHit(asset: Asset) {
  return {
    id: asset.id,
    date: asset.created_at ? String(asset.created_at).substring(0, 16) : "",
    type: asset.file_type,
    description: asset.description.substring(0, 400),
    tags: asset.tags ?? [],
    caption: asset.user_caption ?? undefined,
    link: asset.public_url ?? undefined,
  };
}

export function createHistorySearchHandler(deps: HistorySearchDeps = defaultDeps) {
  return async (args: Record<string, unknown>): Promise<string> => {
    const query = String(args.query || "").trim();
    if (!query) return JSON.stringify({ error: "query fehlt" });
    const limit = Math.min(Math.max(Number(args.limit) || 5, 1), 15);

    const [messageResults, knowledgeCtx, imageResults] = await Promise.all([
      Promise.all(
        deps.chatIds().map((chatId) =>
          deps.searchMessages(chatId, query, limit).catch((): Message[] => [])
        )
      ).then((lists) => lists.flat()),
      deps.knowledgeContext(query).catch(() => ""),
      Promise.resolve()
        .then(() => deps.searchImages(query, limit))
        .catch((): Asset[] => []),
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

    const images = imageResults.slice(0, limit).map(imageHit);

    return JSON.stringify({
      query,
      messages,
      knowledge_base: knowledgeCtx ? knowledgeCtx.substring(0, 2000) : undefined,
      images: images.length > 0 ? images : undefined,
      image_links_valid_minutes: images.some((i) => i.link) ? LINK_LIFETIME_SECONDS / 60 : undefined,
      hint:
        messages.length === 0 && !knowledgeCtx && images.length === 0
          ? "Keine Treffer — andere Suchbegriffe versuchen"
          : undefined,
    });
  };
}

registerBuiltinTool({
  name: "history_search",
  description:
    "Search the user's stored conversation history, knowledge base and saved images/files (semantic + full text). Use this when you lack context about earlier conversations, decisions, projects, facts or pictures the user sent — instead of guessing or saying you don't know.",
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
  isAvailable: () => !!optionalCredential("SUPABASE_URL"),
  handler: createHistorySearchHandler(),
});
