/**
 * Supabase-Adapter für Fakten und Ziele (Issue #311). Beide liegen in der
 * Tabelle memory, unterschieden durch type: offen ist type "goal", erledigt
 * type "completed_goal" mit completed_at (Issue #518, db/schema.sql). Fakten
 * bekommen ihr Embedding nach dem Speichern im Hintergrund, damit das
 * Speichern nicht auf den Anbieter wartet.
 *
 * Teiltext-Suchen behandeln `%`, `_` und `\` wörtlich (like-pattern.ts,
 * #310). deleteFact, completeGoal und cancelGoal nehmen den ersten Treffer;
 * der Gedächtnis-Dienst (#316) fragt stattdessen alle Treffer ab
 * (matchingFacts, matchingGoals) und ändert dann genau eine Zeile per ID.
 * Änderungen an Zielen gelten nur für offene Ziele und zählen als Erfolg nur,
 * wenn sie wirklich eine Zeile getroffen haben: von zwei gleichzeitigen
 * Aufrufen gewinnt einer.
 *
 * Tabellen-, Spalten- und RPC-Namen sind Schnittstelle zur Datenbank.
 * Fehler der Datenbank und Ausnahmen des Clients ergeben bei Fakten false bzw.
 * leere Listen; ohne Client (Supabase nicht eingerichtet) gilt das auch für
 * Ziele. Bei Zielen stehen sie im Log (nur Fehlercode oder -art, nie Zieltexte,
 * Meldungen der Datenbank oder Zugangsdaten), und wo „kein Treffer“ etwas
 * anderes heißt als „gescheitert“, wirft der Adapter GoalStoreError:
 * completeGoal, cancelGoal, matchingGoals und die ById-Methoden. addGoal kennt
 * keinen Treffer, dort heißt false „nicht gespeichert“.
 *
 * Archiv (Issue #520): Jede Abfrage auf Fakten filtert auf archived_at IS NULL.
 * Fehlt die Spalte noch (Code vor der Migration eingespielt), läuft die Abfrage
 * ohne Filter nach, denn dann gibt es auch kein Archiv; sonst stünden Prompts
 * still ohne Fakten da. Archivieren, Umschreiben und Zurückholen sind je ein
 * einziges UPDATE mit dem erwarteten Stand als Filter: Das prüft und schreibt
 * in einem Schritt, auch gegen gleichzeitige Änderungen. Ein Text, der für die
 * Adresse zu lang ist, lässt die Anfrage scheitern, geändert wird dann nichts.
 *
 * Geheimnisse (Issue #524): addFact und rewriteFact prüfen vor der Datenbank und
 * vor dem Embedding-Anbieter. Gelesen wird immer der Originaltext.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { embeddingColumns, FACT_MATCH_THRESHOLD, MISSING_COLUMN_CODES, MISSING_FUNCTION_CODES, type FetchLike, type RegistryTarget } from "../../../../supabase/functions/_shared/embedding";
import { containsPattern } from "../../../../supabase/functions/_shared/like-pattern";
import { embedWithConfig, factVectorsFor, parseVector, registryTarget, type ConfiguredEmbedding } from "../../embedding";
import type { MemoryStore } from "../ports";
import { factTerms, rankFactsByTerms } from "../fact-search";
import { containsSecret } from "../../memory/secrets";
import type { FactChange, FactSearchOptions, MemoryItem } from "../types";
import type { ClientSource } from "./messages";

const TABLE = "memory";
/** Längster Text, der an den Embedding-Anbieter geht */
export const EMBEDDING_TEXT_LIMIT = 8000;

type Kind = MemoryItem["type"];

/** Ein Ziel, das offen ist, und eines, das erledigt ist; nur diese Zeilen ändern den Stand eines Ziels */
const OPEN_GOAL: Kind = "goal";
const DONE_GOAL = "completed_goal";
const FACT: Kind = "fact";

/** Die Datenbank hat eine Abfrage zu Zielen nicht ausgeführt, nicht zu verwechseln mit „kein Treffer“ */
export class GoalStoreError extends Error {
  constructor(what: string, detail: string) {
    super(`Supabase: ${what} gescheitert (${detail})`);
    this.name = "GoalStoreError";
  }
}

/** Fehlercode der Datenbank fürs Log; ihre Meldungen können Inhalte nennen und bleiben draußen */
function errorDetail(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Za-z0-9]{1,12}$/.test(code) ? code : "ohne Code";
}

/** Führt eine Abfrage aus; wirft der Client, kommt null */
function attempt<T>(run: () => PromiseLike<T>): Promise<T | null> {
  return Promise.resolve()
    .then(run)
    .catch(() => null);
}

/** Abfrage zu Zielen: ein Fehler steht im Log und wirft GoalStoreError */
async function goalQuery<T extends { error: unknown }>(what: string, run: () => PromiseLike<T>): Promise<T> {
  let result: T;
  try {
    result = await run();
  } catch (e) {
    const detail = e instanceof Error ? e.name : "Fehler";
    console.error(`[Gedächtnis] ${what} gescheitert (${detail})`);
    throw new GoalStoreError(what, detail);
  }
  if (result.error) {
    const detail = errorDetail(result.error);
    console.error(`[Gedächtnis] ${what} gescheitert (${detail})`);
    throw new GoalStoreError(what, detail);
  }
  return result;
}

/** Abfrage auf die Zeilen einer Art, mit den gewünschten Spalten */
function scoped(client: SupabaseClient, kind: Kind, columns: string) {
  return client.from(TABLE).select(columns).eq("type", kind);
}

/** Schränkt eine Abfrage auf nicht archivierte Fakten ein, solange es die Spalte gibt */
type ActiveFilter = <Q>(query: Q) => Q;

const onlyActive: ActiveFilter = query => (query as unknown as { is(column: string, value: null): typeof query }).is("archived_at", null);

const lacksColumn = (error: unknown) => MISSING_COLUMN_CODES.includes(String((error as { code?: unknown } | null)?.code ?? ""));

/** Abfrage auf nicht archivierte Fakten (siehe oben); wirft der Client, kommt null */
async function activeFacts<T extends { error: unknown }>(run: (active: ActiveFilter) => PromiseLike<T>): Promise<T | null> {
  const result = await attempt(() => run(onlyActive));
  return result && lacksColumn(result.error) ? attempt(() => run(query => query)) : result;
}

/** Alle nicht archivierten Fakten, neueste zuerst; Fehler ergeben [], mit strict wirft jeder */
async function listFacts(client: SupabaseClient, strict: boolean): Promise<MemoryItem[]> {
  const result = await activeFacts(active => active(scoped(client, FACT, "*")).order("created_at", { ascending: false }));
  if (!result || result.error || !Array.isArray(result.data)) {
    if (strict) throw new Error(`Supabase: Fakten lesen gescheitert (${result ? errorDetail(result.error) : "Ausnahme"})`);
    return [];
  }
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
  const result = await goalQuery("Ziele lesen", () => scoped(client, OPEN_GOAL, "*").order("created_at", { ascending: true }).retry(false));
  if (!Array.isArray(result.data)) throw new GoalStoreError("Ziele lesen", "Antwort ohne Liste");
  return result.data as unknown as MemoryItem[];
}

/** id der ersten Zeile der Art, deren Inhalt den Text wörtlich enthält */
async function firstFact(client: SupabaseClient, searchText: string): Promise<string | null> {
  const result = await activeFacts(active => active(scoped(client, FACT, "id")).ilike("content", containsPattern(searchText)).limit(1));
  const rows = result && !result.error ? (result.data as unknown as { id: unknown }[] | null) : null;
  const id = rows?.[0]?.id;
  return id === undefined || id === null ? null : String(id);
}

/** Höchstens limit Fakten, deren Inhalt den Text wörtlich enthält, älteste zuerst; Fehler ergeben [] */
async function matchingFactRows(client: SupabaseClient, searchText: string, limit: number): Promise<MemoryItem[]> {
  const result = await activeFacts(active =>
    active(scoped(client, FACT, "*")).ilike("content", containsPattern(searchText)).order("created_at", { ascending: true }).limit(limit),
  );
  if (!result || result.error || !Array.isArray(result.data)) return [];
  return result.data as unknown as MemoryItem[];
}

/** Höchstens limit offene Ziele, deren Inhalt den Text wörtlich enthält, älteste zuerst; wirft bei Fehlern */
async function matchingGoalRows(client: SupabaseClient, searchText: string, limit: number): Promise<MemoryItem[]> {
  const result = await goalQuery("Ziele suchen", () =>
    scoped(client, OPEN_GOAL, "*").ilike("content", containsPattern(searchText)).order("created_at", { ascending: true }).limit(limit),
  );
  return Array.isArray(result.data) ? (result.data as unknown as MemoryItem[]) : [];
}

/** Hat die Änderung (mit select("id")) mindestens eine Zeile getroffen? */
async function touchedRow(run: () => PromiseLike<{ data: unknown; error: unknown }>): Promise<boolean> {
  const result = await attempt(run);
  return result !== null && !result.error && Array.isArray(result.data) && result.data.length > 0;
}

/** Nicht archivierten Fakt löschen; false, wenn es ihn so nicht mehr gibt */
async function deleteActiveFact(client: SupabaseClient, id: string): Promise<boolean> {
  return touchedRow(async () => (await activeFacts(active => active(client.from(TABLE).delete().eq("id", id).eq("type", FACT)).select("id"))) ?? { data: null, error: "Ausnahme" });
}

/** Ergebnis einer Änderung an genau einem Fakt (mit select("id")); gelingt sie, zählt done */
async function factChange(run: () => PromiseLike<{ data: unknown; error: unknown }>, done: FactChange = "changed"): Promise<FactChange> {
  const result = await attempt(run);
  if (!result || result.error || !Array.isArray(result.data)) return "failed";
  return result.data.length > 0 ? done : "conflict";
}

/** Vektor für einen neuen Text; ohne Anbieter oder bei einem Fehler null */
async function vectorColumns(content: string) {
  try {
    const embedded = await embedWithConfig(content.slice(0, EMBEDDING_TEXT_LIMIT));
    return embedded ? embeddingColumns(embedded.vector, embedded.config) : null;
  } catch {
    return null;
  }
}

/** Offenes Ziel per ID erledigen; false, wenn es kein offenes Ziel mehr ist */
async function completeGoalRow(client: SupabaseClient, id: string): Promise<boolean> {
  const at = new Date().toISOString();
  const result = await goalQuery("Ziel erledigen", () =>
    client.from(TABLE).update({ type: DONE_GOAL, completed_at: at, updated_at: at }).eq("id", id).eq("type", OPEN_GOAL).select("id"),
  );
  return Array.isArray(result.data) && result.data.length > 0;
}

/** Offenes Ziel per ID löschen; false, wenn es kein offenes Ziel mehr ist */
async function cancelGoalRow(client: SupabaseClient, id: string): Promise<boolean> {
  const result = await goalQuery("Ziel streichen", () => client.from(TABLE).delete().eq("id", id).eq("type", OPEN_GOAL).select("id"));
  return Array.isArray(result.data) && result.data.length > 0;
}

/**
 * Embedding für einen gespeicherten Fakt nachtragen, samt embedding_model
 * (die Datenbank verwirft so einen Vektor eines anderen Anbieters, #168).
 * Kennt die Tabelle die Spalte noch nicht, nur den Vektor. Wirft nie: der
 * Fakt ist gespeichert, ihm fehlt dann nur der Vektor. Geschrieben wird nur,
 * solange der Text noch content lautet: Ein verspäteter Vektor landet nie an
 * einem inzwischen umgeschriebenen Fakt (Issue #520).
 */
async function attachEmbedding(client: SupabaseClient, id: string, content: string): Promise<void> {
  try {
    const embedded = await embedWithConfig(content.slice(0, EMBEDDING_TEXT_LIMIT));
    if (!embedded) return;
    const row = client.from(TABLE);
    const first = await row.update(embeddingColumns(embedded.vector, embedded.config)).eq("id", id).eq("content", content);
    if (first.error && lacksColumn(first.error)) {
      await client.from(TABLE).update({ embedding: embedded.vector }).eq("id", id).eq("content", content);
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

/** Vektoren aus der Spalte embedding aller nicht archivierten Fakten; Fehler ergeben eine leere Zuordnung */
async function storedFactVectors(client: SupabaseClient): Promise<Map<string, number[]>> {
  const found = new Map<string, number[]>();
  const result = await activeFacts(active => active(scoped(client, FACT, "id, embedding")));
  if (!result || result.error || !Array.isArray(result.data)) return found;
  for (const row of result.data as unknown as { id: unknown; embedding: unknown }[]) {
    const vector = parseVector(row.embedding);
    if (vector && row.id !== null && row.id !== undefined) found.set(String(row.id), vector);
  }
  return found;
}

/** So viele Fakten liest die Textsuche je Abfrage */
const TEXT_SEARCH_PAGE = 200;

/** Zeile aus match_facts_checked oder der Textsuche als Fakt */
export function factFromRow(row: { id?: unknown; content?: unknown; created_at?: unknown; revised_at?: unknown }): MemoryItem {
  return {
    ...(row.id !== undefined && row.id !== null ? { id: String(row.id) } : {}),
    type: FACT,
    content: String(row.content ?? ""),
    ...(typeof row.created_at === "string" ? { created_at: row.created_at } : {}),
    ...(typeof row.revised_at === "string" ? { revised_at: row.revised_at } : {}),
  };
}

/** Fakten nach Bedeutung; ohne Anbieter oder ohne die Funktion leer, failed nur bei einem echten Fehler */
async function factsByMeaning(client: SupabaseClient, query: string, limit: number, excludeIds: string[]): Promise<{ rows: MemoryItem[]; failed: boolean }> {
  const embedded = await embedWithConfig(query.slice(0, EMBEDDING_TEXT_LIMIT)).catch(() => null);
  if (!embedded) return { rows: [], failed: false };
  const result = await attempt(() =>
    client.rpc("match_facts_checked", {
      p_provider: embedded.config.provider,
      p_model: embedded.config.model,
      query_embedding: embedded.vector,
      match_threshold: FACT_MATCH_THRESHOLD,
      match_count: limit,
      p_exclude_ids: excludeIds,
    }),
  );
  if (!result) return { rows: [], failed: true };
  if (result.error) return { rows: [], failed: !MISSING_FUNCTION_CODES.includes(String((result.error as { code?: unknown }).code)) };
  return { rows: Array.isArray(result.data) ? result.data.map(factFromRow) : [], failed: false };
}

/**
 * Fakten nach gemeinsamen Wörtern; die Wörter enthalten keine Zeichen, die im
 * Filter etwas bedeuten (factTerms). Gelesen wird, bis keine Zeile mehr kommt, erst
 * danach gelten Ausschluss, Mindestzahl der Wörter und limit: Neue bekannte oder
 * schwache Treffer verdrängen so keinen älteren passenden Fakt.
 */
async function factsByWords(client: SupabaseClient, query: string, limit: number, options: FactSearchOptions): Promise<{ rows: MemoryItem[]; failed: boolean }> {
  const terms = factTerms(query);
  if (terms.length === 0) return { rows: [], failed: false };
  const anyTerm = terms.map(term => `content.ilike.*${term}*`).join(",");
  const exclude = new Set(options.excludeIds ?? []);
  // Nach ID: Ein Fakt, der während des Lesens dazukommt, verschiebt die Seiten und käme sonst doppelt
  const candidates = new Map<string, MemoryItem>();
  for (let from = 0; ; from += TEXT_SEARCH_PAGE) {
    const result = await activeFacts(active =>
      active(scoped(client, FACT, "id, content, created_at, revised_at"))
        .or(anyTerm)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .range(from, from + TEXT_SEARCH_PAGE - 1),
    );
    if (!result || result.error || !Array.isArray(result.data)) return { rows: [], failed: true };
    for (const row of result.data as unknown as Parameters<typeof factFromRow>[0][]) {
      const fact = factFromRow(row);
      if (!exclude.has(String(fact.id))) candidates.set(String(fact.id), fact);
    }
    if (result.data.length < TEXT_SEARCH_PAGE) break;
  }
  return { rows: rankFactsByTerms([...candidates.values()], terms, limit, options.minTerms), failed: false };
}

/** Siehe MemoryStore.searchFacts: Bedeutung vor Text, jeder Fakt einmal */
async function searchFactRows(client: SupabaseClient, query: string, limit: number, options: FactSearchOptions): Promise<MemoryItem[]> {
  const meaning = options.meaning ? await factsByMeaning(client, query, limit, options.excludeIds ?? []) : { rows: [], failed: false };
  const words = await factsByWords(client, query, limit, options);
  const seen = new Set<string>();
  const found = [...meaning.rows, ...words.rows].filter(fact => {
    const key = String(fact.id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (found.length === 0 && (meaning.failed || words.failed)) throw new Error("Supabase: Fakten suchen gescheitert");
  return found.slice(0, limit);
}

/** Ist der Zeitpunkt später als since? Ohne gültigen Zeitpunkt nein */
function isAfter(at: string | undefined, since: number): boolean {
  return (at ? Date.parse(at) : NaN) > since;
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

  const facts = (options: { strict?: boolean } = {}) => {
    if (options.strict && !clientSource()) return Promise.reject(new Error("Supabase nicht erreichbar: kein Client"));
    return withClient<MemoryItem[]>([], client => listFacts(client, options.strict === true));
  };
  // Für Prompts und das Delta: leer statt Fehler, ein Turn hängt nicht daran; steht aber im Log
  const activeGoals = () =>
    withClient<MemoryItem[]>([], async client => {
      try {
        return await readOpenGoals(() => client);
      } catch {
        return [];
      }
    });

  /** Erstes passendes offenes Ziel finden und mit change bearbeiten */
  const changeFirstGoal = (searchText: string, change: (client: SupabaseClient, id: string) => Promise<boolean>) =>
    withClient(false, async client => {
      const [first] = await matchingGoalRows(client, searchText, 1);
      return first ? change(client, String(first.id)) : false;
    });

  return {
    addFact: content =>
      withClient(false, async client => {
        if (containsSecret(content)) return false;
        const inserted = await attempt(() => client.from(TABLE).insert({ type: "fact", content }).select("id").single());
        if (!inserted || inserted.error) return false;
        const id = (inserted.data as { id?: unknown } | null)?.id;
        if (id !== undefined && id !== null) void attachEmbedding(client, String(id), content);
        return true;
      }),
    facts,
    archivedFacts: async () => {
      const client = clientSource();
      if (!client) throw new Error("Supabase nicht erreichbar: kein Client");
      const result = await attempt(() => scoped(client, FACT, "*").not("archived_at", "is", null).order("archived_at", { ascending: false }));
      if (!result || result.error || !Array.isArray(result.data)) {
        throw new Error(`Supabase: Archiv lesen gescheitert (${result ? errorDetail(result.error) : "Ausnahme"})`);
      }
      return result.data as unknown as MemoryItem[];
    },
    archiveFact: (id, expected) =>
      withClient<FactChange>("failed", client => {
        const at = new Date().toISOString();
        return factChange(() => client.from(TABLE).update({ archived_at: at, updated_at: at }).eq("id", id).eq("type", FACT).eq("content", expected).is("archived_at", null).select("id"));
      }),
    restoreFact: id =>
      withClient<FactChange>("failed", client => {
        const at = new Date().toISOString();
        return factChange(() => client.from(TABLE).update({ archived_at: null, revised_at: at, updated_at: at }).eq("id", id).eq("type", FACT).not("archived_at", "is", null).select("id"));
      }),
    rewriteFact: (id, expected, content) =>
      withClient<FactChange>("failed", async client => {
        if (containsSecret(content)) return "secret";
        // Erst der Vektor, dann ein einziges UPDATE: Text und Vektor gehören nie zu verschiedenen Ständen
        const vector = await vectorColumns(content);
        const at = new Date().toISOString();
        return factChange(
          () =>
            client
              .from(TABLE)
              .update({ content, revised_at: at, updated_at: at, ...(vector ?? { embedding: null, embedding_model: null }) })
              .eq("id", id)
              .eq("type", FACT)
              .eq("content", expected)
              .is("archived_at", null)
              .select("id"),
          vector ? "changed" : "changed_without_vector",
        );
      }),
    deleteFact: searchText =>
      withClient(false, async client => {
        const id = await firstFact(client, searchText);
        return id !== null && deleteActiveFact(client, id);
      }),
    addGoal: (content, deadline) =>
      withClient(false, async client => {
        let due: string | undefined;
        try {
          due = deadline?.toISOString();
        } catch {
          return false;
        }
        try {
          await goalQuery("Ziel anlegen", () => client.from(TABLE).insert({ type: OPEN_GOAL, content, deadline: due }));
          return true;
        } catch {
          return false;
        }
      }),
    activeGoals,
    completeGoal: searchText => changeFirstGoal(searchText, completeGoalRow),
    cancelGoal: searchText => changeFirstGoal(searchText, cancelGoalRow),
    async changedSince(since) {
      const cutoff = since.getTime();
      const [factRows, goalRows] = await Promise.all([facts(), activeGoals()]);
      return [
        ...factRows.filter(fact => isAfter(fact.created_at, cutoff) || isAfter(fact.revised_at, cutoff)),
        ...goalRows.filter(goal => isAfter(goal.created_at, cutoff)),
      ];
    },
    factVectors: query =>
      withClient(null, async client => {
        const lookup = await lookupFactVectors(query, { target: registryTarget(), raw: () => storedFactVectors(client) });
        return lookup ? lookup.vectors : null;
      }),
    matchingFacts: (searchText, limit) => withClient<MemoryItem[]>([], client => matchingFactRows(client, searchText, limit)),
    matchingGoals: (searchText, limit) => withClient<MemoryItem[]>([], client => matchingGoalRows(client, searchText, limit)),
    searchFacts: async (query, limit, options = {}) => {
      const client = clientSource();
      if (!client) throw new Error("Supabase nicht erreichbar: kein Client");
      return searchFactRows(client, query, limit, options);
    },
    deleteFactById: id => withClient(false, client => deleteActiveFact(client, id)),
    completeGoalById: id => withClient(false, client => completeGoalRow(client, id)),
    cancelGoalById: id => withClient(false, client => cancelGoalRow(client, id)),
  };
}
