/**
 * Teil-Schnittstellen des Speichers (Issue #308), eine je Fachbereich. Ein
 * Adapter (Supabase ab #309, Datei in #316) setzt sie um; getStore() in
 * index.ts reicht sie gebündelt heraus.
 *
 * Folge-Issues dürfen beim Bau ihres Adapters Methoden ergänzen, aber keine
 * umbenennen oder entfernen. Zeitplan (ScheduleStore, #321) und Ausgaben
 * (Spend, #313) kommen eigenständig dazu, nicht hier.
 */
import type { ConfiguredEmbedding } from "../embedding";
import type {
  Asset,
  AssetUpload,
  AsyncTask,
  BoardRow,
  DisplayOnlyHead,
  DisplayOnlyPageOptions,
  DisplayOnlyRow,
  FactChange,
  FactSearchOptions,
  FactWish,
  HitsWithFacts,
  HistoryOptions,
  HistoryRow,
  KnowledgeCategory,
  KnowledgeContextQuery,
  KnowledgeEntry,
  KnowledgeHit,
  KnowledgeWriteResult,
  LogLevel,
  MemoryItem,
  Message,
  NodeStatus,
  PingResult,
  TaskChanges,
  TopicActivity,
  TopicActivityChanges,
} from "./types";

/** Nachrichten, Verlauf und Meldungen (#309, #310) */
export interface MessageStore {
  /** Speichert eine Nachricht samt Embedding; true bei Erfolg */
  save(message: Message): Promise<boolean>;
  /** Speichert eine Meldung (metadata.display_only) ohne Embedding */
  saveDisplayOnly(message: Message): Promise<boolean>;
  /** Die letzten Nachrichten eines Chats bzw. Topics, älteste zuerst */
  recent(chatId: string, limit: number, topicId?: number | null): Promise<Message[]>;
  /**
   * Rohzeilen der letzten Tage über alle Chats, neueste zuerst, ohne
   * Meldungen, für /board. Fehler ergeben eine leere Liste; mit strict wirft
   * jeder Abruffehler, damit „unbekannt" nie als „keine Beiträge" gilt (#364)
   */
  boardRows(days: number, options?: { strict?: boolean }): Promise<BoardRow[]>;
  /**
   * created_at der jüngsten Nutzernachricht über alle Gespräche (Telegram
   * und Browser), ohne Meldungen und Antworten; null ohne Nutzernachricht.
   * Wirft bei jedem Abruffehler, damit „unbekannt" nie als „nie" gilt (#364)
   */
  lastUserMessageAt(): Promise<string | null>;
  /** Suche nach Bedeutung, sonst nach Text */
  search(chatId: string, query: string, limit: number): Promise<Message[]>;
  /** Wie search, dazu Fakten aus demselben Suchvektor, ohne weiteren Aufruf beim Anbieter (#523) */
  searchWithFacts(chatId: string, query: string, limit: number, facts: FactWish): Promise<HitsWithFacts>;
  /** Verlauf für die WebUI, seitenweise */
  history(chatId: string, topicId: number | null, options: HistoryOptions): Promise<HistoryRow[]>;
  /** Letzte Aktivität je Topic der letzten Tage */
  topicActivity(chatId: string, sinceDays: number): Promise<TopicActivity[]>;
  /**
   * Letzte Aktivität je Topic ab einem Zeitpunkt (einschließlich), zum
   * Fortschreiben eines Stands im Prozess (#684). Wirft bei jedem Abruffehler,
   * damit „unbekannt" nie als „nichts Neues" gilt
   */
  topicActivitySince(chatId: string, since: string): Promise<TopicActivityChanges>;
  /** Eine Seite Meldungen aus den genannten Chats */
  displayOnlyPage(chatIds: string[], options: DisplayOnlyPageOptions): Promise<DisplayOnlyRow[]>;
  /** Dieselbe Seite wie displayOnlyPage, aber nur id und created_at (#684) */
  displayOnlyHeads(chatIds: string[], options: DisplayOnlyPageOptions): Promise<DisplayOnlyHead[]>;
  /** Volle Meldungen zu Zeilen-IDs aus displayOnlyHeads, nur aus den genannten Chats (#684) */
  displayOnlyRows(chatIds: string[], ids: string[]): Promise<DisplayOnlyRow[]>;
  /** Zeitpunkt der jüngsten Meldung oder null */
  latestDisplayOnlyAt(chatIds: string[]): Promise<string | null>;
  /** Meldung, die die Datei mit dieser ID trägt */
  findDisplayOnlyFile(fileId: string, chatIds: string[]): Promise<DisplayOnlyRow | null>;
}

/**
 * Fakten und Ziele (#311, Datei-Adapter und ID-Änderungen #316). false und []
 * heißen bei den Zielen „kein Treffer“; hat der Speicher die Abfrage nicht
 * ausgeführt, werfen completeGoal, cancelGoal, matchingGoals und die
 * ById-Methoden für Ziele (#518). addGoal: false heißt „nicht gespeichert“.
 * activeGoals bleibt für Prompts leer statt zu werfen.
 *
 * Archiv (#520): Archivierte Fakten liefert außer archivedFacts keine Methode,
 * und keine Methode außer restoreFact ändert sie. Für einen Treffer zählt, dass
 * der Fakt in einem Schritt geprüft und geändert wird.
 *
 * Geheimnisse (#524): addFact und rewriteFact speichern keinen Text mit Geheimnis
 * und fragen dafür auch keinen Anbieter. Ausgaben lesen weiter den Originaltext,
 * denn Änderungen prüfen gegen ihn; maskiert wird beim Zeigen (memory/secrets.ts).
 */
export interface MemoryStore {
  /** false: nicht gespeichert, auch bei einem Geheimnis; das unterscheidet der Aufrufer vorher mit containsSecret */
  addFact(content: string): Promise<boolean>;
  /** Fehler ergeben [], mit strict wirft jeder, damit „unbekannt“ nie als „keine Fakten“ gilt */
  facts(options?: { strict?: boolean }): Promise<MemoryItem[]>;
  /** Archivierte Fakten, zuletzt archivierte zuerst; wirft, wenn sie nicht lesbar sind */
  archivedFacts(): Promise<MemoryItem[]>;
  /** Archiviert genau diesen Fakt, wenn sein Text noch expected lautet */
  archiveFact(id: string, expected: string): Promise<FactChange>;
  /** Holt genau diesen Fakt aus dem Archiv; conflict, wenn er nicht (mehr) dort liegt */
  restoreFact(id: string): Promise<FactChange>;
  /**
   * Ersetzt den Text, wenn er noch expected lautet, in einem Schritt mit dem
   * neuen Vektor. Ohne Vektor: changed_without_vector, der alte ist dann weg
   */
  rewriteFact(id: string, expected: string, content: string): Promise<FactChange>;
  /** Löscht den Fakt, der den Suchtext enthält */
  deleteFact(searchText: string): Promise<boolean>;
  addGoal(content: string, deadline?: Date): Promise<boolean>;
  activeGoals(): Promise<MemoryItem[]>;
  /** Markiert das Ziel, das den Suchtext enthält, als erreicht */
  completeGoal(searchText: string): Promise<boolean>;
  /** Streicht das Ziel, das den Suchtext enthält */
  cancelGoal(searchText: string): Promise<boolean>;
  /**
   * Fakten, die seit diesem Zeitpunkt angelegt, umgeschrieben oder
   * zurückgeholt wurden, und aktive Ziele, die seitdem angelegt wurden
   */
  changedSince(since: Date): Promise<MemoryItem[]>;
  /**
   * Vektoren der Fakten (je Fakt-ID), die zu Anbieter und Modell dieses
   * Suchvektors passen; null, wenn es keine passenden gibt
   */
  factVectors(query: ConfiguredEmbedding): Promise<Map<string, number[]> | null>;
  /**
   * Höchstens limit Fakten bzw. offene Ziele, deren Inhalt den Suchtext
   * enthält (ohne Rücksicht auf Groß- und Kleinschreibung), älteste zuerst
   * (#316: mehrere Treffer werden zur Rückfrage)
   */
  matchingFacts(searchText: string, limit: number): Promise<MemoryItem[]>;
  matchingGoals(searchText: string, limit: number): Promise<MemoryItem[]>;
  /**
   * Nicht archivierte Fakten zum Suchtext (#523): auf Wunsch erst nach Bedeutung,
   * dann nach gemeinsamen Wörtern. Leer heißt „nichts gefunden“; wirft, wenn die
   * Suche nicht ausgeführt werden konnte und nichts gefunden hat
   */
  searchFacts(query: string, limit: number, options?: FactSearchOptions): Promise<MemoryItem[]>;
  /** Änderungen an genau einem Eintrag; false, wenn es ihn (als offenes Ziel) nicht mehr gibt */
  deleteFactById(id: string): Promise<boolean>;
  completeGoalById(id: string): Promise<boolean>;
  cancelGoalById(id: string): Promise<boolean>;
}

/** Aufträge mit Rückfrage und Lebenszeichen der Rechner (#312) */
export interface TaskStore {
  create(chatId: string, originalPrompt: string, threadId?: number, processedBy?: string): Promise<AsyncTask | null>;
  update(taskId: string, changes: TaskChanges): Promise<boolean>;
  byId(taskId: string): Promise<AsyncTask | null>;
  /** Aufträge, die auf eine Antwort des Nutzers warten */
  pending(chatId: string): Promise<AsyncTask[]>;
  running(chatId: string): Promise<AsyncTask[]>;
  /** Wartende Aufträge, die länger als olderThanMs liegen */
  stale(olderThanMs: number): Promise<AsyncTask[]>;
  heartbeat(nodeId: string, metadata?: Record<string, unknown>): Promise<boolean>;
  nodeStatus(nodeId: string, maxAgeMs: number): Promise<NodeStatus>;
}

/** Protokoll und Verbindungstest (#312) */
export interface LogStore {
  /**
   * Schreibt eine Logzeile; Fehler dabei bleiben still. Unter Supabase
   * landet service in der Spalte event (die Tabelle hat keine Spalte service)
   */
  write(level: LogLevel, service: string, message: string, metadata?: Record<string, unknown>): Promise<void>;
  /** Prüft, ob der Speicher erreichbar ist; wirft nie, auch nicht ohne Einrichtung */
  ping(): Promise<PingResult>;
}

/** Bilder und Dateien (#318) */
export interface AssetStore {
  upload(input: AssetUpload): Promise<Asset | null>;
  setDescription(assetId: string, description: string, tags?: string[], relatedProject?: string | null): Promise<void>;
  byId(assetId: string): Promise<Asset | null>;
  recent(limit: number, fileType?: string): Promise<Asset[]>;
  /** Fehler ergeben eine leere Liste; mit strict wirft die Suche (Nachschlagen, #523) */
  search(query: string, limit: number, options?: { strict?: boolean }): Promise<Asset[]>;
}

/** Wissensbasis (#317); archivierte, ersetzte und abgelaufene Einträge liefert keine Methode */
export interface KnowledgeStore {
  /** Legt an bzw. ersetzt den Eintrag mit gleicher Kategorie und gleichem Titel */
  add(entry: KnowledgeEntry): Promise<KnowledgeWriteResult>;
  /** Nach Bedeutung, sonst nach Text; ohne Suchwort leer */
  search(query: string, limit: number, category?: KnowledgeCategory): Promise<KnowledgeHit[]>;
  /** Neueste zuerst */
  recent(limit: number, category?: KnowledgeCategory): Promise<KnowledgeEntry[]>;
  /** Kontext für den Prompt in einem Aufruf: Vorrang, dann Bedeutung, sonst Text; jeder Eintrag einmal */
  context(query: KnowledgeContextQuery): Promise<KnowledgeHit[]>;
}

/** Welcher Adapter den Speicher trägt */
export type Backend = "supabase" | "file";

/** Alle Teile eines Speichers, von getStore() einmal gewählt */
export interface Store {
  readonly backend: Backend;
  readonly messages: MessageStore;
  readonly memory: MemoryStore;
  readonly tasks: TaskStore;
  readonly logs: LogStore;
  readonly assets: AssetStore;
  readonly knowledge: KnowledgeStore;
}
