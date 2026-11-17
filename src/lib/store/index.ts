/**
 * Einstieg in den Speicher (Issue #308): wählt einmal den Adapter und gibt
 * dessen Teile heraus.
 *
 * Übergang: Was noch nicht gebaut ist, bleibt ein Platzhalter, der bei
 * jedem Methodenaufruf StoreNotReadyError wirft, statt still leer zu
 * antworten. Unter Supabase sind alle Nachrichten-Methoden gebaut
 * (Speichern, recent und boardRows in #309, Suche, Verlauf und Meldungen in
 * #310), ebenso Fakten und Ziele (#311), Aufträge, Lebenszeichen,
 * Protokoll und Verbindungstest (#312), das Wissen (#317) und Bilder samt
 * Dateien (#318). Ohne Datenbank trägt seit #316 der Datei-Adapter das
 * Gedächtnis (Fakten und Ziele), die übrigen Teile bleiben dort Platzhalter
 * (Wissen und Bilder gibt es nur mit Datenbank, knowledge-base.ts und
 * asset-store.ts antworten dann leer bzw. mit Schreibfehler). Seit #314 rufen alle Aufrufer den Store direkt;
 * wer ohne Datenbank still leer antworten soll, nimmt storeOr. Den
 * Gedächtnis-Kontext baut src/lib/memory/context.ts aus getStore().memory.
 */
import type {
  AssetStore,
  Backend,
  KnowledgeStore,
  LogStore,
  MemoryStore,
  MessageStore,
  Store,
  TaskStore,
} from "./ports";
import { getSupabase } from "../supabase";
import { supabaseMessageReads } from "./supabase/message-reads";
import { supabaseLogs } from "./supabase/logs";
import { supabaseMemory } from "./supabase/memory";
import { supabaseMessages } from "./supabase/messages";
import { supabaseKnowledge } from "./supabase/knowledge";
import { supabaseAssets } from "./supabase/assets";
import { supabaseTasks } from "./supabase/tasks";
import { fileMemory, memoryFilePath } from "./file/memory";

export type { Backend, Store } from "./ports";

/** Name eines Teils im Store, so wie er in Fehlermeldungen erscheint */
export type StorePart = Exclude<keyof Store, "backend">;

export class StoreNotReadyError extends Error {
  readonly part: StorePart;
  readonly backend: Backend;

  constructor(part: StorePart, backend: Backend) {
    super(`${part} (${backend}) noch nicht gebaut`);
    this.name = "StoreNotReadyError";
    this.part = part;
    this.backend = backend;
  }
}

function filled(value: string | undefined): boolean {
  return typeof value === "string" && value.trim() !== "";
}

/**
 * Wählt den Adapter aus der Umgebung: Supabase, wenn URL und Service-Role-Key
 * beide gesetzt sind, sonst die Datei. Andere Datenbanken zählen nicht
 * (Entscheidung E1, Issue #324).
 */
export function selectBackend(env: Record<string, string | undefined> = process.env): Backend {
  return filled(env.SUPABASE_URL) && filled(env.SUPABASE_SERVICE_ROLE_KEY) ? "supabase" : "file";
}

/** Je Teil alle Methodennamen; der Typ verlangt, dass keine fehlt */
type MethodNames<T> = { [K in keyof T]-?: true };

const MESSAGE_METHODS: MethodNames<MessageStore> = {
  save: true,
  saveDisplayOnly: true,
  recent: true,
  boardRows: true,
  lastUserMessageAt: true,
  search: true,
  searchWithFacts: true,
  history: true,
  topicActivity: true,
  topicActivitySince: true,
  displayOnlyPage: true,
  displayOnlyHeads: true,
  displayOnlyRows: true,
  latestDisplayOnlyAt: true,
  findDisplayOnlyFile: true,
};
const MEMORY_METHODS: MethodNames<MemoryStore> = {
  addFact: true,
  facts: true,
  archivedFacts: true,
  archiveFact: true,
  restoreFact: true,
  rewriteFact: true,
  deleteFact: true,
  addGoal: true,
  activeGoals: true,
  completeGoal: true,
  cancelGoal: true,
  changedSince: true,
  factVectors: true,
  matchingFacts: true,
  matchingGoals: true,
  searchFacts: true,
  deleteFactById: true,
  completeGoalById: true,
  cancelGoalById: true,
};
const TASK_METHODS: MethodNames<TaskStore> = {
  create: true,
  update: true,
  byId: true,
  pending: true,
  running: true,
  stale: true,
  heartbeat: true,
  nodeStatus: true,
};
const LOG_METHODS: MethodNames<LogStore> = { write: true, ping: true };
const ASSET_METHODS: MethodNames<AssetStore> = {
  upload: true,
  setDescription: true,
  byId: true,
  recent: true,
  search: true,
};
const KNOWLEDGE_METHODS: MethodNames<KnowledgeStore> = { add: true, search: true, recent: true, context: true };

/** Methodennamen je Teil, auch für Tests, die jeden Platzhalter prüfen */
export const STORE_METHODS: { [P in StorePart]: (keyof Store[P])[] } = {
  messages: Object.keys(MESSAGE_METHODS) as (keyof MessageStore)[],
  memory: Object.keys(MEMORY_METHODS) as (keyof MemoryStore)[],
  tasks: Object.keys(TASK_METHODS) as (keyof TaskStore)[],
  logs: Object.keys(LOG_METHODS) as (keyof LogStore)[],
  assets: Object.keys(ASSET_METHODS) as (keyof AssetStore)[],
  knowledge: Object.keys(KNOWLEDGE_METHODS) as (keyof KnowledgeStore)[],
};

function placeholder<P extends StorePart>(part: P, backend: Backend): Store[P] {
  const methods: Record<string, () => never> = {};
  for (const name of STORE_METHODS[part]) {
    methods[name as string] = () => {
      throw new StoreNotReadyError(part, backend);
    };
  }
  return Object.freeze(methods) as unknown as Store[P];
}

/** Nachrichten: unter Supabase vollständig aus den beiden Adapter-Modulen, sonst Platzhalter */
function messagePart(backend: Backend): MessageStore {
  if (backend !== "supabase") return placeholder("messages", backend);
  return Object.freeze({ ...supabaseMessages(getSupabase), ...supabaseMessageReads(getSupabase) });
}

/** Gedächtnis: Supabase oder die Datei (#316), deren Ort beim Wählen gilt */
function memoryPart(backend: Backend): MemoryStore {
  if (backend === "supabase") return Object.freeze(supabaseMemory(getSupabase));
  const path = memoryFilePath();
  return Object.freeze(fileMemory(() => path));
}

function buildStore(backend: Backend): Store {
  const onSupabase = backend === "supabase";
  return Object.freeze({
    backend,
    messages: messagePart(backend),
    memory: memoryPart(backend),
    tasks: onSupabase ? Object.freeze(supabaseTasks(getSupabase)) : placeholder("tasks", backend),
    logs: onSupabase ? Object.freeze(supabaseLogs(getSupabase)) : placeholder("logs", backend),
    assets: onSupabase ? Object.freeze(supabaseAssets(getSupabase)) : placeholder("assets", backend),
    knowledge: onSupabase ? Object.freeze(supabaseKnowledge(getSupabase)) : placeholder("knowledge", backend),
  });
}

let chosen: Store | null = null;

/** Der Speicher dieses Prozesses; gewählt beim ersten Aufruf, danach immer derselbe */
export function getStore(): Store {
  chosen ??= buildStore(selectBackend());
  return chosen;
}

/** Vergisst die Wahl, damit der nächste getStore() neu wählt (für Tests). Die Zuhörer in events.ts bleiben */
export function resetStore(): void {
  chosen = null;
}

/**
 * Für Aufrufer, die ohne Datenbank still weiterarbeiten (Issue #314): führt
 * `use` mit dem Store aus; ist der Teil dort noch ein Platzhalter, gilt
 * `fallback` (dieselben Leerwerte wie früher die alte Datenbank-Fassade). Der
 * Platzhalter wirft schon beim Aufruf, nicht erst im Promise, deshalb hier
 * try/await statt .catch(). Alle anderen Fehler gehen weiter an den Aufrufer.
 */
export async function storeOr<T>(fallback: T, use: (store: Store) => Promise<T>): Promise<T> {
  try {
    return await use(getStore());
  } catch (err) {
    if (err instanceof StoreNotReadyError) return fallback;
    throw err;
  }
}
