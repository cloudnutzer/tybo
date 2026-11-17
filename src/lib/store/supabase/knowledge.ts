/**
 * Supabase-Adapter für die Wissensbasis (Issue #317), Tabelle knowledge.
 *
 * Schreiben: ein Eintrag ist durch Kategorie und Titel bestimmt; gleiche
 * Kategorie und gleicher Titel ersetzen den alten Inhalt. Den Vektor rechnet
 * danach im Hintergrund die Edge Function embed-knowledge, das Speichern
 * wartet nicht darauf.
 *
 * Lesen: nur aktive Einträge, die weder ersetzt (superseded_by) noch
 * abgelaufen (expires_at) sind. Archivieren gibt es nicht mehr, archivierte
 * Altbestände bleiben trotzdem draußen.
 *
 * Kontext: ein Aufruf der Datenbankfunktion knowledge_context (Migration
 * 20261017) liefert Vorrang-Einträge und Treffer, nach Bedeutung geprüft mit
 * Anbieter und Modell des Suchvektors, sonst nach Text. Fehlt die Funktion
 * oder scheitert sie, folgt der Rückfall über die Tabelle mit einer Abfrage
 * je Vorrang-Kategorie (3) und einer je Suchwort (höchstens 3, siehe
 * CONTEXT_TERMS in knowledge-base.ts), also 3 bis 6 Abfragen, parallel.
 * Jede hat ihre eigene Grenze, damit viele neue Einträge einer Kategorie
 * oder Treffer eines Worts die anderen nicht verdrängen.
 *
 * Tabellen-, Spalten- und Funktionsnamen sind Schnittstelle zur Datenbank.
 * Fehler und Ausnahmen ergeben leere Listen bzw. einen Schreibfehler; nur der
 * Kontext mit strict wirft, damit das Nachschlagen „nicht lesbar“ von „kein Eintrag“
 * trennen kann.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { containsPattern } from "../../../../supabase/functions/_shared/like-pattern";
import { embedWithConfig, type ConfiguredEmbedding } from "../../embedding";
import { supabaseHeaders } from "../../supabase-keys";
import { knowledgeTerms } from "../knowledge-terms";
import type { KnowledgeStore } from "../ports";
import type { KnowledgeCategory, KnowledgeContextQuery, KnowledgeEntry, KnowledgeHit, KnowledgeWriteResult } from "../types";
import type { ClientSource } from "./messages";

const TABLE = "knowledge";
const COLUMNS = "id,created_at,updated_at,category,title,content,source,related_project,related_entities,tags,confidence,expires_at,status,metadata";

/** Kategorien, deren neueste Einträge immer im Kontext stehen, in dieser Reihenfolge */
export const PRIORITY_CATEGORIES: KnowledgeCategory[] = ["project", "decision", "preference"];
/** Ab dieser Ähnlichkeit zählt ein Eintrag als Treffer nach Bedeutung */
export const SIMILARITY_THRESHOLD = 0.7;
/** Längster Text, der an den Embedding-Anbieter geht */
const EMBEDDING_TEXT_LIMIT = 8000;

const CONTEXT_UNREADABLE = "Supabase: Wissensbasis nicht lesbar";

/** Sätze für den Nutzer, im Wortlaut wie vor #317 (/learn zeigt sie an) */
export const KNOWLEDGE_TEXT = {
  notConfigured: "⚠️ Supabase not configured",
  failed: "Knowledge storage failed",
  saved: (entry: KnowledgeEntry) => `📚 Saved: [${entry.category}] ${entry.title}`,
};

export interface KnowledgeDeps {
  /** Suchvektor samt Anbieter und Modell; null: keine Bedeutungssuche */
  embed?: (text: string) => Promise<ConfiguredEmbedding | null>;
  /** Vektor für einen gespeicherten Eintrag nachtragen lassen; wirft nie */
  embedEntry?: (id: string, text: string) => Promise<void>;
  /** Uhr für den Ablauf (expires_at) */
  now?: () => number;
}

/** Edge Function embed-knowledge; ohne Adresse oder Server-Schlüssel nichts */
async function embedViaEdge(id: string, text: string): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return;
  try {
    const response = await fetch(`${url}/functions/v1/embed-knowledge`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...supabaseHeaders(key) },
      body: JSON.stringify({ knowledge_id: id, text }),
    });
    await response.body?.cancel().catch(() => {});
  } catch {
    // Ohne Vektor findet die Textsuche den Eintrag weiterhin
  }
}

interface Answer {
  data: unknown;
  error: unknown;
}

/** Zeilen einer Abfrage; Ausnahme, Fehler oder keine Liste ergeben null */
async function rows(run: () => PromiseLike<Answer>): Promise<Record<string, unknown>[] | null> {
  try {
    const answer = await run();
    return !answer.error && Array.isArray(answer.data) ? (answer.data as Record<string, unknown>[]) : null;
  } catch {
    return null;
  }
}

function asHit(row: Record<string, unknown>, match: KnowledgeHit["match"]): KnowledgeHit {
  const hit = { ...row } as unknown as KnowledgeHit;
  if (match) hit.match = match;
  if (typeof row.similarity !== "number") delete hit.similarity;
  return hit;
}

/** Jeder Eintrag einmal, der erste gewinnt */
export function uniqueById<T extends { id?: string }>(entries: T[]): T[] {
  const seen = new Set<string>();
  return entries.filter(entry => {
    const key = entry.id === undefined || entry.id === null ? null : String(entry.id);
    if (key === null) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** PostgREST-Filter „eines der Wörter in Titel, Inhalt oder Schlagwörtern“; Wörter aus knowledgeTerms */
function anyTermFilter(terms: string[]): string {
  return terms.flatMap(term => [`title.ilike.${containsPattern(term)}`, `content.ilike.${containsPattern(term)}`, `tags.cs.{${term}}`]).join(",");
}

export function supabaseKnowledge(clientSource: ClientSource, deps: KnowledgeDeps = {}): KnowledgeStore {
  const embed = deps.embed ?? (text => embedWithConfig(text));
  const embedEntry = deps.embedEntry ?? embedViaEdge;
  const now = deps.now ?? Date.now;

  /** Nur Einträge, die gelten: aktiv, nicht ersetzt, nicht abgelaufen */
  const live = (client: SupabaseClient) =>
    client
      .from(TABLE)
      .select(COLUMNS)
      .eq("status", "active")
      .is("superseded_by", null)
      .or(`expires_at.is.null,expires_at.gt.${new Date(now()).toISOString()}`);

  const withClient = <T>(fallback: T, fn: (client: SupabaseClient) => Promise<T>): Promise<T> => {
    const client = clientSource();
    return client ? fn(client) : Promise.resolve(fallback);
  };

  /** Texttreffer für die Wörter, neueste zuerst */
  const textSearch = (client: SupabaseClient, terms: string[], limit: number, category?: KnowledgeCategory) =>
    rows(() => {
      const query = live(client).or(anyTermFilter(terms));
      return (category ? query.eq("category", category) : query).order("updated_at", { ascending: false }).limit(limit);
    });

  /** Rückfall ohne knowledge_context: je Vorrang-Kategorie und je Suchwort eine eigene Abfrage */
  const contextByTables = async (client: SupabaseClient, q: KnowledgeContextQuery): Promise<KnowledgeHit[]> => {
    const [priority, textual] = await Promise.all([
      Promise.all(
        PRIORITY_CATEGORIES.map(category =>
          rows(() => live(client).eq("category", category).order("updated_at", { ascending: false }).limit(q.perCategory)),
        ),
      ),
      Promise.all(q.terms.map(term => textSearch(client, [term], q.perTerm))),
    ]);
    if (q.strict && [...priority, ...textual].includes(null)) throw new Error(CONTEXT_UNREADABLE);
    const picked: KnowledgeHit[] = [
      ...priority.flatMap(found => (found ?? []).map(row => asHit(row, "priority"))),
      ...textual.flatMap(found => (found ?? []).map(row => asHit(row, "text"))),
    ];
    return uniqueById(picked);
  };

  return {
    add: entry =>
      withClient<KnowledgeWriteResult>({ ok: false, message: KNOWLEDGE_TEXT.notConfigured }, async client => {
        const row = {
          category: entry.category,
          title: entry.title,
          content: entry.content,
          source: entry.source || "telegram",
          related_project: entry.related_project || null,
          related_entities: entry.related_entities ?? [],
          tags: entry.tags ?? [],
          confidence: entry.confidence ?? 1,
          expires_at: entry.expires_at || null,
          status: "active",
          metadata: entry.metadata ?? {},
          updated_at: new Date(now()).toISOString(),
        };
        let id: unknown;
        try {
          const answer = await client.from(TABLE).upsert(row, { onConflict: "category,title" }).select("id").single();
          id = answer.error ? undefined : (answer.data as { id?: unknown } | null)?.id;
        } catch {
          id = undefined;
        }
        if (id === undefined || id === null || id === "") return { ok: false, message: KNOWLEDGE_TEXT.failed };
        void embedEntry(String(id), `${entry.title}: ${entry.content}`).catch(() => {});
        return { ok: true, message: KNOWLEDGE_TEXT.saved(entry) };
      }),

    recent: (limit, category) =>
      withClient<KnowledgeEntry[]>([], async client => {
        const found = await rows(() => {
          const query = live(client);
          return (category ? query.eq("category", category) : query).order("updated_at", { ascending: false }).limit(limit);
        });
        return (found ?? []) as unknown as KnowledgeEntry[];
      }),

    search: (query, limit, category) =>
      withClient<KnowledgeHit[]>([], async client => {
        const terms = knowledgeTerms(query, { minLength: 2, max: 5 });
        if (terms.length === 0) return [];
        const vector = await embed(query.slice(0, EMBEDDING_TEXT_LIMIT)).catch(() => null);
        if (vector) {
          const semantic = await rows(() =>
            client.rpc("match_knowledge_checked", {
              p_provider: vector.config.provider,
              p_model: vector.config.model,
              query_embedding: vector.vector,
              match_threshold: SIMILARITY_THRESHOLD,
              match_count: limit,
              p_category: category ?? null,
            }),
          );
          if (semantic && semantic.length > 0) return semantic.map(row => asHit(row, "semantic"));
        }
        return ((await textSearch(client, terms, limit, category)) ?? []).map(row => asHit(row, "text"));
      }),

    context: q => {
      if (q.strict && !clientSource()) return Promise.reject(new Error(CONTEXT_UNREADABLE));
      return withClient<KnowledgeHit[]>([], async client => {
        const answer = await rows(() =>
          client.rpc("knowledge_context", {
            p_terms: q.terms,
            p_provider: q.embedding?.config.provider ?? null,
            p_model: q.embedding?.config.model ?? null,
            query_embedding: q.embedding?.vector ?? null,
            p_per_category: q.perCategory,
            p_per_term: q.perTerm,
            p_matches: q.matches,
            match_threshold: SIMILARITY_THRESHOLD,
          }),
        );
        if (!answer) return contextByTables(client, q);
        return uniqueById(
          answer.map(row => {
            const { reason, stage: _stage, ...rest } = row;
            const match = reason === "priority" || reason === "semantic" || reason === "text" ? reason : undefined;
            return asHit(rest, match);
          }),
        );
      });
    },
  };
}
