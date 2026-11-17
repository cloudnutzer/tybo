/**
 * History-Search Built-in (nach dem Vorbild
 * von Hermes' session_search).
 *
 * Laesst das Modell selbst in den Fakten (Issue #523), der gespeicherten
 * Konversations-Historie, der Knowledge Base und den gespeicherten Bildern
 * suchen, wenn ihm Kontext
 * fehlt — statt nur das zu sehen, was der Prompt-Builder automatisch
 * injiziert. Vor allem fuer die Fallback-Modelle relevant, die sonst gar
 * keinen Zugriff auf das Gedaechtnis haben.
 *
 * Durchsucht den Direktchat (Telegram-Nutzer-ID, ohne Telegram "web",
 * Entscheidung 0021) plus alle in config/topics.json bekannten Gruppen-Chats
 * (semantisch via Edge Function, Substring-Fallback). Bilder (Issue #318)
 * kommen aus getStore().assets.search mit frisch signiertem Link, der 15
 * Minuten gilt. Scheitert eine Quelle, liefern die anderen trotzdem; sie steht
 * dann unter unavailable, damit das Modell sie nicht mit „nichts gefunden“
 * verwechselt. Dafür fragt der Handler jede Quelle in der Form, die bei einem
 * Fehler wirft, statt leer zu antworten. Fakten kommen ohne archivierte, mit Anlagedatum und Vorbehalt wie
 * im Prompt. Claude Code hat dieses Werkzeug nicht: Es nimmt denselben Handler
 * über bun run nachschlagen (scripts/nachschlagen.ts).
 */

import { readFileSync } from "fs";
import { join } from "path";
import { LINK_LIFETIME_SECONDS } from "../assets/bucket";
import { dmChatId } from "../channels";
import { optionalCredential } from "../credentials";
import { getSupabase } from "../supabase";
import { searchChatChecked } from "../store/supabase/message-reads";
import { getKnowledgeContext } from "../knowledge-base";
import { FACT_DATE_NOTE, factDate } from "../memory/context";
import { maskSecrets } from "../memory/secrets";
import { getStore, storeOr } from "../store";
import type { Asset, MemoryItem, Message } from "../store/types";
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

/** Quellen der Suche; Tests setzen eigene ein. Jede wirft, wenn sie scheitert; leer heißt „nichts gefunden“ */
export interface HistorySearchDeps {
  chatIds: () => string[];
  searchMessages: (chatId: string, query: string, limit: number) => Promise<Message[]>;
  knowledgeContext: (query: string) => Promise<string>;
  searchImages: (query: string, limit: number) => Promise<Asset[]>;
  searchFacts: (query: string, limit: number) => Promise<MemoryItem[]>;
}

const defaultDeps: HistorySearchDeps = {
  chatIds: knownChatIds,
  // Nur Supabase, ohne Datenbank leer
  searchMessages: async (chatId, query, limit) => {
    const client = getSupabase();
    return client ? searchChatChecked(client, chatId, query, limit) : [];
  },
  knowledgeContext: query => getKnowledgeContext(query, { strict: true }),
  searchImages: (query, limit) => storeOr<Asset[]>([], store => store.assets.search(query, limit, { strict: true })),
  searchFacts: (query, limit) => getStore().memory.searchFacts(query, limit, { meaning: true }),
};

/** Länge eines Fakts im Ergebnis */
const FACT_MAX_CHARS = 400;

/** Ein Fakt, so wie ihn das Modell sieht: erst maskiert, dann gekürzt (Issue #524) */
function factHit(fact: MemoryItem) {
  return { date: factDate(fact.created_at), text: maskSecrets(fact.content).substring(0, FACT_MAX_CHARS) };
}

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

    const unavailable: string[] = [];
    /** Fehler einer Quelle: gemerkt und wie „nichts“ behandelt */
    const orNote = <T>(source: string, empty: T) => () => {
      if (!unavailable.includes(source)) unavailable.push(source);
      return empty;
    };

    const [factResults, messageResults, knowledgeCtx, imageResults] = await Promise.all([
      Promise.resolve()
        .then(() => deps.searchFacts(query, limit))
        .catch(orNote<MemoryItem[]>("facts", [])),
      Promise.all(
        deps.chatIds().map((chatId) =>
          deps.searchMessages(chatId, query, limit).catch(orNote<Message[]>("messages", []))
        )
      ).then((lists) => lists.flat()),
      deps.knowledgeContext(query).catch(orNote("knowledge_base", "")),
      Promise.resolve()
        .then(() => deps.searchImages(query, limit))
        .catch(orNote<Asset[]>("images", [])),
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
    const facts = factResults.slice(0, limit).map(factHit);
    const nothing = facts.length === 0 && messages.length === 0 && !knowledgeCtx && images.length === 0;
    const failed = unavailable.length > 0;

    // Fakten zuerst: Die Sprach-Brücke kürzt das Ergebnis am Ende
    return JSON.stringify({
      query,
      facts: facts.length > 0 ? facts : undefined,
      facts_note: facts.length > 0 ? FACT_DATE_NOTE : undefined,
      messages,
      knowledge_base: knowledgeCtx ? knowledgeCtx.substring(0, 2000) : undefined,
      images: images.length > 0 ? images : undefined,
      image_links_valid_minutes: images.some((i) => i.link) ? LINK_LIFETIME_SECONDS / 60 : undefined,
      unavailable: failed ? unavailable : undefined,
      hint: !nothing
        ? undefined
        : failed
          ? `Suche gescheitert (${unavailable.join(", ")}): Das heißt nicht, dass nichts gespeichert ist.`
          : "Keine Treffer — andere Suchbegriffe versuchen",
    });
  };
}

registerBuiltinTool({
  name: "history_search",
  description:
    "Search the user's stored facts, conversation history, knowledge base and saved images/files (semantic + full text). Use this when you lack context about earlier conversations, decisions, projects, facts or pictures the user sent — instead of guessing or saying you don't know. If nothing is found, say so; if the result lists sources under \"unavailable\", say the search failed.",
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
