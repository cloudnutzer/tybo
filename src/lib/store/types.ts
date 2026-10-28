/**
 * Datentypen des Speichers (Issue #308). Die Feldnamen sind die Spalten der
 * Supabase-Tabellen (messages, memory, async_tasks, logs, assets, knowledge)
 * und bleiben deshalb in snake_case; sie sind Schnittstelle, kein Stil.
 */

/** Eine Zeile aus messages: was der Nutzer oder tybo gesagt hat */
export interface Message {
  id?: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  /** topicId, msgId, messageId, display_only, agent und andere Zusätze */
  metadata?: Record<string, unknown>;
  /** ISO-Zeitpunkt; fehlt er, vergibt die Datenbank ihn */
  created_at?: string;
}

/**
 * Rohzeile für /board: nur die Spalten, die die Abfrage holt (ohne chat_id
 * und id), deshalb ein eigener Typ statt Message
 */
export interface BoardRow {
  role: Message["role"];
  content: string;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

/** Schlanke Verlaufszeile für die WebUI, nie mit Embedding */
export interface HistoryRow {
  id: string;
  created_at: string;
  role: string;
  content: string;
  metadata: Record<string, unknown> | null;
}

export interface HistoryOptions {
  limit: number;
  /** Nur Nachrichten vor diesem ISO-Zeitpunkt (ältere nachladen) */
  before?: string;
}

/** Letzte Aktivität je Session-Schlüssel (Topic oder Direktchat) */
export interface TopicActivity {
  sessionKey: string;
  lastActivity: string;
}

/** Meldung (metadata.display_only) mit dem Chat, zu dem sie gehört */
export interface DisplayOnlyRow extends HistoryRow {
  chat_id: string;
}

export interface DisplayOnlyPageOptions {
  /** Ab diesem Zeitpunkt, einschließlich */
  since?: string;
  /** Nach genau diesem Eintrag weiterblättern (erst created_at, dann id) */
  after?: { createdAt: string; id: string };
  limit: number;
}

/** Eine Zeile aus memory: Fakt oder Ziel */
export interface MemoryItem {
  id?: string;
  type: "fact" | "goal";
  content: string;
  /** Frist eines Ziels, ISO */
  deadline?: string;
  completed?: boolean;
  completed_at?: string;
  created_at?: string;
}

export type TaskStatus = "pending" | "running" | "needs_input" | "completed" | "failed";

/** Eine Zeile aus async_tasks: Auftrag mit möglicher Rückfrage an den Nutzer */
export interface AsyncTask {
  id: string;
  created_at: string;
  updated_at: string;
  chat_id: string;
  original_prompt: string;
  status: TaskStatus;
  result?: string;
  session_id?: string;
  current_step?: string;
  pending_question?: string;
  pending_options?: { label: string; value: string }[];
  user_response?: string;
  thread_id?: number;
  processed_by?: string;
  reminder_sent?: boolean;
  metadata?: Record<string, unknown>;
}

/** Felder, die ein Aufrufer an einem Auftrag ändern darf */
export type TaskChanges = Partial<Omit<AsyncTask, "id" | "created_at">>;

/** Ob ein Rechner (node_heartbeat) sich zuletzt rechtzeitig gemeldet hat */
export interface NodeStatus {
  online: boolean;
  lastHeartbeat: string | null;
}

export type LogLevel = "info" | "warn" | "error" | "debug";

/** Eine Zeile aus logs */
export interface LogEntry {
  id?: string;
  level: LogLevel;
  service: string;
  message: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

/** Ergebnis von LogStore.ping(): erreichbar ja/nein und ein Satz dazu */
export interface PingResult {
  ok: boolean;
  message: string;
}

/** Eine Zeile aus assets: hochgeladenes Bild oder Datei mit Beschreibung */
export interface Asset {
  id: string;
  created_at: string;
  storage_path: string;
  public_url: string | null;
  original_filename: string | null;
  file_type: string;
  mime_type: string | null;
  file_size_bytes: number | null;
  description: string;
  user_caption: string | null;
  conversation_context: string | null;
  related_project: string | null;
  tags: string[];
  channel: string;
  metadata: Record<string, unknown>;
}

/** Was zum Hochladen eines Assets gebraucht wird */
export interface AssetUpload {
  data: Uint8Array;
  filename: string;
  description: string;
  fileType?: string;
  mimeType?: string;
  tags?: string[];
  userCaption?: string;
  conversationContext?: string;
  relatedProject?: string | null;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export type KnowledgeCategory =
  | "project"
  | "person"
  | "preference"
  | "learning"
  | "process"
  | "decision"
  | "reference"
  | "tool";

/** Eine Zeile aus knowledge: strukturierter Wissenseintrag */
export interface KnowledgeEntry {
  id?: string;
  created_at?: string;
  updated_at?: string;
  category: KnowledgeCategory;
  title: string;
  content: string;
  source?: string;
  related_project?: string;
  related_entities?: string[];
  tags?: string[];
  confidence?: number;
  expires_at?: string;
  superseded_by?: string;
  status?: "active" | "archived";
  metadata?: Record<string, unknown>;
}

/** Treffer der Wissenssuche, mit Ähnlichkeit bei semantischer Suche */
export interface KnowledgeHit extends KnowledgeEntry {
  similarity?: number;
  /** Warum der Eintrag im Kontext steht: Vorrang-Kategorie, Bedeutung oder Text (#317) */
  match?: "priority" | "semantic" | "text";
}

/** Anfrage für den Wissens-Kontext eines Prompts (#317) */
export interface KnowledgeContextQuery {
  /** Suchwörter für den Textrückfall, schon zerlegt (store/knowledge-terms.ts) */
  terms: string[];
  /** Suchvektor samt Anbieter und Modell; null: nur Vorrang und Text */
  embedding: { vector: number[]; config: { provider: string; model: string } } | null;
  /** Neueste Einträge je Vorrang-Kategorie (project, decision, preference) */
  perCategory: number;
  /** Texttreffer je Suchwort */
  perTerm: number;
  /** Treffer nach Bedeutung */
  matches: number;
}

/** Ergebnis beim Anlegen eines Wissenseintrags, mit Satz für den Nutzer */
export type KnowledgeWriteResult = { ok: true; message: string } | { ok: false; message: string };
