/**
 * Kategorien der Wissensbasis (Issue #317). Die Datenbank lässt nur diese
 * zu (CHECK auf knowledge.category); die Namen sind Schnittstelle zu Modell,
 * Prompts und Tabelle. Ohne Abhängigkeiten, damit der Tag-Parser
 * (memory/intents.ts) rein bleibt.
 */
import type { KnowledgeCategory } from "./store/types";

/** Reihenfolge wie im CHECK der Tabelle (db/migrations/20260909_security_knowledge.sql) */
export const KNOWLEDGE_CATEGORIES: readonly KnowledgeCategory[] = ["project", "person", "preference", "learning", "process", "decision", "reference", "tool"];

export function isKnowledgeCategory(value: string): value is KnowledgeCategory {
  return (KNOWLEDGE_CATEGORIES as readonly string[]).includes(value);
}
