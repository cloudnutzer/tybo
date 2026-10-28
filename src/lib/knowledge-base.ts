/**
 * Wissensbasis (Issue #317): strukturierte Einträge mit Kategorie, Titel und
 * Inhalt, etwa aus /learn oder aus dem Tag `[KNOWLEDGE: …]` einer Antwort
 * (Parser in memory/intents.ts, angewendet im Gedächtnis-Dienst, aus
 * fremden Inhalten nur als Vorschlag über das intent-gate).
 *
 * Gespeichert wird über getStore().knowledge, also nur mit Supabase. Ohne
 * Datenbank ist der Kontext leer und Schreiben scheitert mit einem klaren
 * Satz statt still.
 *
 * Kontext für den Prompt: ein Aufruf des Stores (knowledge_context) bringt
 * die neuesten Einträge der Vorrang-Kategorien und die Treffer zur Nachricht,
 * nach Bedeutung, sonst nach Text. Die Suchwörter zerlegt knowledgeTerms
 * Unicode-fest („Größe“ bleibt „Größe“).
 */
import { embedWithConfig, type ConfiguredEmbedding } from "./embedding";
import { getStore, storeOr } from "./store";
import { knowledgeTerms } from "./store/knowledge-terms";
import { KNOWLEDGE_TEXT } from "./store/supabase/knowledge";
import type { KnowledgeEntry, KnowledgeHit, KnowledgeWriteResult } from "./store/types";

export type { KnowledgeCategory, KnowledgeEntry, KnowledgeWriteResult } from "./store/types";
export { isKnowledgeCategory, KNOWLEDGE_CATEGORIES } from "./knowledge-categories";

/** Neueste Einträge je Vorrang-Kategorie im Kontext */
export const CONTEXT_PER_CATEGORY = 3;
/** Suchwörter aus der Nachricht: höchstens so viele, je mindestens so lang */
export const CONTEXT_TERMS = { max: 3, minLength: 4 };
/** Texttreffer je Suchwort bzw. Treffer nach Bedeutung insgesamt */
export const CONTEXT_PER_TERM = 3;
export const CONTEXT_MATCHES = 5;
/** Obergrenze des Abschnitts: Vorrang plus die größere der beiden Trefferarten */
export const CONTEXT_MAX_ENTRIES = CONTEXT_PER_CATEGORY * 3 + Math.max(CONTEXT_MATCHES, CONTEXT_PER_TERM * CONTEXT_TERMS.max);
/** So viel vom Inhalt eines Eintrags steht im Prompt */
const CONTENT_PREVIEW = 200;
const EMBEDDING_TEXT_LIMIT = 8000;

/** Speichert einen Eintrag; ohne Datenbank ok: false mit Grund */
export function addKnowledge(entry: KnowledgeEntry): Promise<KnowledgeWriteResult> {
  return storeOr<KnowledgeWriteResult>({ ok: false, message: KNOWLEDGE_TEXT.notConfigured }, store => store.knowledge.add(entry)).catch(
    (): KnowledgeWriteResult => ({ ok: false, message: KNOWLEDGE_TEXT.failed }),
  );
}

/** Eine Zeile je Eintrag, wie sie im Prompt steht */
export function knowledgeLine(entry: KnowledgeEntry): string {
  const project = entry.related_project ? ` (${entry.related_project})` : "";
  return `- [${entry.category}] ${entry.title}: ${entry.content.substring(0, CONTENT_PREVIEW)}${project}`;
}

export interface KnowledgeContextDeps {
  /** Suchvektor zur Nachricht; null: nur Vorrang und Text */
  embed?: (text: string) => Promise<ConfiguredEmbedding | null>;
}

/**
 * Abschnitt „Knowledge Base“ für den Prompt; leer ohne Datenbank, ohne
 * Einträge oder bei einem Fehler.
 */
export async function getKnowledgeContext(userMessage?: string, deps: KnowledgeContextDeps = {}): Promise<string> {
  if (getStore().backend !== "supabase") return "";
  const message = userMessage?.trim() ?? "";
  const embed = deps.embed ?? (text => embedWithConfig(text));
  const lookup = async (): Promise<KnowledgeHit[]> => {
    const embedding = message ? await embed(message.slice(0, EMBEDDING_TEXT_LIMIT)).catch(() => null) : null;
    return getStore().knowledge.context({
      terms: message ? knowledgeTerms(message, CONTEXT_TERMS) : [],
      embedding,
      perCategory: CONTEXT_PER_CATEGORY,
      perTerm: CONTEXT_PER_TERM,
      matches: CONTEXT_MATCHES,
    });
  };
  const hits = await lookup().catch((err: unknown): KnowledgeHit[] => {
    console.error("[Wissen] Kontext nicht lesbar:", err instanceof Error ? err.name : "Fehler");
    return [];
  });
  const lines = hits.slice(0, CONTEXT_MAX_ENTRIES).map(knowledgeLine);
  return lines.length > 0 ? `**Knowledge Base:**\n${lines.join("\n")}` : "";
}
