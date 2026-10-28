/**
 * Supabase-Adapter für Fakten und Ziele (Issue #311). Beide liegen in der
 * Tabelle memory, unterschieden durch type; ein Ziel gilt als offen, solange
 * completed false ist. Fakten bekommen ihr Embedding nach dem Speichern im
 * Hintergrund, damit das Speichern nicht auf den Anbieter wartet.
 *
 * Teiltext-Suchen behandeln `%`, `_` und `\` wörtlich (like-pattern.ts,
 * #310). deleteFact, completeGoal und cancelGoal nehmen den ersten Treffer;
 * der Gedächtnis-Dienst (#316) fragt stattdessen alle Treffer ab
 * (matchingFacts, matchingGoals) und ändert dann genau eine Zeile per ID.
 *
 * Tabellen-, Spalten- und RPC-Namen sind Schnittstelle zur Datenbank.
 * Fehler der Datenbank und Ausnahmen des Clients ergeben false bzw. leere
 * Listen; ohne Client (Supabase nicht eingerichtet) ebenso.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { embeddingColumns, MISSING_COLUMN_CODES, type FetchLike, type RegistryTarget } from "../../../../supabase/functions/_shared/embedding";
import { containsPattern } from "../../../../supabase/functions/_shared/like-pattern";
import { embedWithConfig, factVectorsFor, parseVector, registryTarget, type ConfiguredEmbedding } from "../../embedding";
import type { MemoryStore } from "../ports";
import type { MemoryItem } from "../types";
import type { ClientSource } from "./messages";

const TABLE = "memory";
/** Längster Text, der an den Embedding-Anbieter geht */
export const EMBEDDING_TEXT_LIMIT = 8000;

type Kind = MemoryItem["type"];

/** Welche Zeilen eine Abfrage meint: Art, und bei Zielen nur die offenen */
interface Scope {
  kind: Kind;
  openOnly: boolean;
}

const FACTS: Scope = { kind: "fact", openOnly: false };
const OPEN_GOALS: Scope = { kind: "goal", openOnly: true };

/** Führt eine Abfrage aus; wirft der Client, kommt null */
function attempt<T>(run: () => PromiseLike<T>): Promise<T | null> {
  return Promise.resolve()
    .then(run)
    .catch(() => null);
}

/** Abfrage auf die Zeilen eines Bereichs, mit den gewünschten Spalten */
function scoped(client: SupabaseClient, scope: Scope, columns: string) {
  const query = client.from(TABLE).select(columns).eq("type", scope.kind);
  return scope.openOnly ? query.eq("completed", false) : query;
}

/** Alle Zeilen eines Bereichs nach Anlagezeit; Fehler ergeben [] */
async function listScope(client: SupabaseClient, scope: Scope, newestFirst: boolean): Promise<MemoryItem[]> {
  const result = await attempt(() => scoped(client, scope, "*").order("created_at", { ascending: !newestFirst }));
  if (!result || result.error || !Array.isArray(result.data)) return [];
  return result.data as unknown as MemoryItem[];
}

/**
 * Offene Ziele, älteste zuerst, wie activeGoals; aber ohne Client, bei
 * Fehler der Datenbank oder Ausnahme wirft es (ein Versuch, keine
 * Wiederholung), statt leer zu antworten. So
 * bleibt ein gescheiterter Abruf von „keine Ziele" unterscheidbar (#354).
 */
export async function readOpenGoals(clientSource: ClientSource): Promise<MemoryItem[]> {
  const client = clientSource();
  if (!client) throw new Error("Supabase nicht erreichbar: kein Client");
  // Ohne Wiederholungen (1 s, 2 s, 4 s): der Rückfall soll im Zeitlimit der Quelle bleiben
  const result = await scoped(client, OPEN_GOALS, "*").order("created_at", { ascending: true }).retry(false);
  if (result.error) throw new Error(`Supabase: ${result.error.message || "Abfrage gescheitert"}`);
  if (!Array.isArray(result.data)) throw new Error("Supabase: Antwort ohne Liste");
  return result.data as unknown as MemoryItem[];
}

/** id der ersten Zeile im Bereich, deren Inhalt den Text wörtlich enthält */
async function firstMatch(client: SupabaseClient, scope: Scope, searchText: string): Promise<string | null> {
  const result = await attempt(() => scoped(client, scope, "id").ilike("content", containsPattern(searchText)).limit(1));
  const rows = result && !result.error ? (result.data as unknown as { id: unknown }[] | null) : null;
  const id = rows?.[0]?.id;
  return id === undefined || id === null ? null : String(id);
}

/** Höchstens limit Zeilen im Bereich, deren Inhalt den Text wörtlich enthält, älteste zuerst; Fehler ergeben [] */
async function allMatches(client: SupabaseClient, scope: Scope, searchText: string, limit: number): Promise<MemoryItem[]> {
  const result = await attempt(() =>
    scoped(client, scope, "*").ilike("content", containsPattern(searchText)).order("created_at", { ascending: true }).limit(limit),
  );
  if (!result || result.error || !Array.isArray(result.data)) return [];
  return result.data as unknown as MemoryItem[];
}

/** Hat die Änderung (mit select("id")) mindestens eine Zeile getroffen? */
async function touchedRow(run: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<boolean> {
  const result = await attempt(run);
  return result !== null && !result.error && Array.isArray(result.data) && result.data.length > 0;
}

/** Erfolg einer Änderung: kein Fehler und keine Ausnahme */
async function succeeded(run: () => PromiseLike<{ error: unknown }>): Promise<boolean> {
  const result = await attempt(run);
  return result !== null && !result.error;
}

/**
 * Embedding für einen gespeicherten Fakt nachtragen, samt embedding_model
 * (die Datenbank verwirft so einen Vektor eines anderen Anbieters, #168).
 * Kennt die Tabelle die Spalte noch nicht, nur den Vektor. Wirft nie: der
 * Fakt ist gespeichert, ihm fehlt dann nur der Vektor.
 */
async function attachEmbedding(client: SupabaseClient, id: string, content: string): Promise<void> {
  try {
    const embedded = await embedWithConfig(content.slice(0, EMBEDDING_TEXT_LIMIT));
    if (!embedded) return;
    const row = client.from(TABLE);
    const first = await row.update(embeddingColumns(embedded.vector, embedded.config)).eq("id", id);
    const code = String((first.error as { code?: unknown } | null)?.code ?? "");
    if (first.error && MISSING_COLUMN_CODES.includes(code)) {
      await client.from(TABLE).update({ embedding: embedded.vector }).eq("id", id);
    }
  } catch {
    // Ohne Vektor rankt der Kontext diesen Fakt lexikalisch bzw. hinten
  }
}

/** Ergebnis der Vektorsuche: geprüft aus der RPC oder roh aus den Zeilen (Migration fehlt) */
export interface FactVectorLookup {
  vectors: Map<string, number[]>;
  checked: boolean;
}

export interface FactVectorDeps {
  /** Datenbank für die RPC; null: keine Prüfung möglich */
  target: RegistryTarget | null;
  fetch?: FetchLike;
  /** Vektoren aus den Zeilen, nur gefragt, wenn der Datenbank die Migration fehlt */
  raw: () => Promise<Map<string, number[]>>;
}

/**
 * Vektoren der Fakten für diesen Suchvektor (Issue #168). Geprüft liefert
 * die RPC embedding_fact_vectors nur Vektoren mit Anbieter und Modell des
 * Suchvektors. Fehlt ihr die Migration, gibt es keine Umstellung, dann
 * gelten die Vektoren der Zeilen (checked: false). Leer (Anbieterwechsel,
 * laufende Umstellung), nicht lesbar oder ohne Datenbank: null.
 */
export async function lookupFactVectors(query: ConfiguredEmbedding, deps: FactVectorDeps): Promise<FactVectorLookup | null> {
  if (!deps.target) return null;
  const answer = await factVectorsFor(query.config, deps.target, deps.fetch);
  if (answer === "fehlt") return { vectors: await deps.raw(), checked: false };
  if (!answer || answer.size === 0) return null;
  return { vectors: answer, checked: true };
}

/** Vektoren aus der Spalte embedding aller Fakten; Fehler ergeben eine leere Zuordnung */
async function storedFactVectors(client: SupabaseClient): Promise<Map<string, number[]>> {
  const found = new Map<string, number[]>();
  const result = await attempt(() => scoped(client, FACTS, "id, embedding"));
  if (!result || result.error || !Array.isArray(result.data)) return found;
  for (const row of result.data as unknown as { id: unknown; embedding: unknown }[]) {
    const vector = parseVector(row.embedding);
    if (vector && row.id !== null && row.id !== undefined) found.set(String(row.id), vector);
  }
  return found;
}

/** Ist der Zeitpunkt der Zeile später als since? Ohne gültigen Zeitpunkt nein */
function createdAfter(item: MemoryItem, since: number): boolean {
  const created = item.created_at ? Date.parse(item.created_at) : NaN;
  return created > since;
}

/**
 * Fakten und Ziele über Supabase. Der Client kommt bei jedem Aufruf frisch
 * aus clientSource; ohne Client schreibt nichts und liest leer.
 */
export function supabaseMemory(clientSource: ClientSource): MemoryStore {
  /** Führt fn mit Client aus, sonst gilt fallback */
  const withClient = <T>(fallback: T, fn: (client: SupabaseClient) => Promise<T>): Promise<T> => {
    const client = clientSource();
    return client ? fn(client) : Promise.resolve(fallback);
  };

  const facts = () => withClient<MemoryItem[]>([], client => listScope(client, FACTS, true));
  const activeGoals = () => withClient<MemoryItem[]>([], client => listScope(client, OPEN_GOALS, false));

  /** Erste passende Zeile finden und mit change bearbeiten */
  const changeFirst = (scope: Scope, searchText: string, change: (client: SupabaseClient, id: string) => PromiseLike<{ error: unknown }>) =>
    withClient(false, async client => {
      const id = await firstMatch(client, scope, searchText);
      return id !== null && succeeded(() => change(client, id));
    });
  const remove = (client: SupabaseClient, id: string) => client.from(TABLE).delete().eq("id", id);

  return {
    addFact: content =>
      withClient(false, async client => {
        const inserted = await attempt(() => client.from(TABLE).insert({ type: "fact", content }).select("id").single());
        if (!inserted || inserted.error) return false;
        const id = (inserted.data as { id?: unknown } | null)?.id;
        if (id !== undefined && id !== null) void attachEmbedding(client, String(id), content);
        return true;
      }),
    facts,
    deleteFact: searchText => changeFirst(FACTS, searchText, remove),
    addGoal: (content, deadline) =>
      withClient(false, async client => {
        let due: string | undefined;
        try {
          due = deadline?.toISOString();
        } catch {
          return false;
        }
        return succeeded(() => client.from(TABLE).insert({ type: "goal", content, deadline: due, completed: false }));
      }),
    activeGoals,
    completeGoal: searchText =>
      changeFirst(OPEN_GOALS, searchText, (client, id) =>
        client.from(TABLE).update({ completed: true, completed_at: new Date().toISOString() }).eq("id", id),
      ),
    cancelGoal: searchText => changeFirst(OPEN_GOALS, searchText, remove),
    async changedSince(since) {
      const cutoff = since.getTime();
      const [factRows, goalRows] = await Promise.all([facts(), activeGoals()]);
      return [...factRows, ...goalRows].filter(item => createdAfter(item, cutoff));
    },
    factVectors: query =>
      withClient(null, async client => {
        const lookup = await lookupFactVectors(query, { target: registryTarget(), raw: () => storedFactVectors(client) });
        return lookup ? lookup.vectors : null;
      }),
    matchingFacts: (searchText, limit) => withClient<MemoryItem[]>([], client => allMatches(client, FACTS, searchText, limit)),
    matchingGoals: (searchText, limit) => withClient<MemoryItem[]>([], client => allMatches(client, OPEN_GOALS, searchText, limit)),
    deleteFactById: id =>
      withClient(false, client => touchedRow(() => client.from(TABLE).delete().eq("id", id).eq("type", "fact").select("id"))),
    completeGoalById: id =>
      withClient(false, client =>
        touchedRow(() =>
          client
            .from(TABLE)
            .update({ completed: true, completed_at: new Date().toISOString() })
            .eq("id", id)
            .eq("type", "goal")
            .eq("completed", false)
            .select("id"),
        ),
      ),
    cancelGoalById: id =>
      withClient(false, client =>
        touchedRow(() => client.from(TABLE).delete().eq("id", id).eq("type", "goal").eq("completed", false).select("id")),
      ),
  };
}
