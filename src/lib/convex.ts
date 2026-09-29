import { atomicWriteFile } from "./atomic-file";
/**
 * Convex Client Module
 *
 * Drop-in replacement for supabase.ts. Same exported function signatures.
 * Uses ConvexHttpClient for server-side operations.
 *
 * Tiered fallback:
 *   1. CONVEX_URL set → use Convex
 *   2. SUPABASE_URL set → use Supabase
 *   3. Neither → local JSON files (handled by memory.ts)
 */

import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

// ---------------------------------------------------------------------------
// Types (same as supabase.ts)
// ---------------------------------------------------------------------------

export interface Message {
  id?: string;
  chat_id: string;
  role: "user" | "assistant";
  content: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface MemoryItem {
  id?: string;
  type: "fact" | "goal";
  content: string;
  deadline?: string;
  completed?: boolean;
  completed_at?: string;
  created_at?: string;
}

export interface LogEntry {
  id?: string;
  level: "info" | "warn" | "error" | "debug";
  service: string;
  message: string;
  metadata?: Record<string, unknown>;
  created_at?: string;
}

export interface AsyncTask {
  id: string;
  created_at: string;
  updated_at: string;
  chat_id: string;
  original_prompt: string;
  status: "pending" | "running" | "needs_input" | "completed" | "failed";
  result?: string;
  session_id?: string;
  current_step?: string;
  pending_question?: string;
  pending_options?: { label: string; value: string }[];
  user_response?: string;
  thread_id?: number;
  processed_by?: string;
  reminder_sent?: boolean;
  metadata?: Record<string, any>;
}

// ---------------------------------------------------------------------------
// Singleton Client
// ---------------------------------------------------------------------------

let convexClient: ConvexHttpClient | null = null;
let supabaseClient: any = null;

// Lazy import supabase only if needed (fallback)
async function getSupabaseFallback() {
  if (supabaseClient !== undefined) return supabaseClient;
  try {
    const mod = await import("./supabase");
    supabaseClient = mod.getSupabase();
    return supabaseClient;
  } catch {
    supabaseClient = null;
    return null;
  }
}

/**
 * Get or create the singleton Convex client.
 * Returns null if CONVEX_URL is not set.
 */
export function getConvex(): ConvexHttpClient | null {
  if (convexClient) return convexClient;

  const url = process.env.CONVEX_URL;
  if (!url) return null;

  const token = process.env.CONVEX_AUTH_TOKEN;
  if (!token) throw new Error("CONVEX_AUTH_TOKEN is required for Convex");
  convexClient = new ConvexHttpClient(url);
  convexClient.setAuth(token);
  return convexClient;
}

/** Vergisst den Client, damit Tests mit eigener Umgebung neu beginnen. */
export function resetConvexClient(): void {
  convexClient = null;
}

/**
 * Whether Convex (or Supabase fallback) is configured and available.
 */
export function isConvexEnabled(): boolean {
  return !!process.env.CONVEX_URL || !!process.env.SUPABASE_URL;
}

// Backward-compat aliases
export { getSupabase } from "./supabase";
export const isSupabaseEnabled = isConvexEnabled;

/**
 * Determine which backend is active.
 */
function getBackend(): "convex" | "supabase" | "none" {
  if (process.env.CONVEX_URL) return "convex";
  if (process.env.SUPABASE_URL) return "supabase";
  return "none";
}

// ---------------------------------------------------------------------------
// Helpers (same as supabase.ts)
// ---------------------------------------------------------------------------

/**
 * Human-readable relative time (e.g. "2 minutes ago", "1 hour ago").
 */
export function getTimeAgo(date: Date): string {
  const now = Date.now();
  const diffMs = now - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  if (diffHour < 24)
    return `${diffHour} hour${diffHour === 1 ? "" : "s"} ago`;
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return date.toLocaleDateString();
}

/**
 * Parse natural-language relative dates into ISO strings.
 */
export function parseRelativeDate(input: string): string | undefined {
  if (!input) return undefined;

  const lower = input.trim().toLowerCase();
  const now = new Date();

  if (lower === "today") {
    now.setHours(23, 59, 59, 0);
    return now.toISOString();
  }

  if (lower === "tomorrow") {
    now.setDate(now.getDate() + 1);
    now.setHours(23, 59, 59, 0);
    return now.toISOString();
  }

  const inDays = lower.match(/^in\s+(\d+)\s+days?$/);
  if (inDays) {
    now.setDate(now.getDate() + parseInt(inDays[1], 10));
    now.setHours(23, 59, 59, 0);
    return now.toISOString();
  }

  const inHours = lower.match(/^in\s+(\d+)\s+hours?$/);
  if (inHours) {
    now.setHours(now.getHours() + parseInt(inHours[1], 10));
    return now.toISOString();
  }

  const inWeeks = lower.match(/^in\s+(\d+)\s+weeks?$/);
  if (inWeeks) {
    now.setDate(now.getDate() + parseInt(inWeeks[1], 10) * 7);
    now.setHours(23, 59, 59, 0);
    return now.toISOString();
  }

  const timeMatch = lower.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (timeMatch) {
    let hours = parseInt(timeMatch[1], 10);
    const minutes = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
    const meridiem = timeMatch[3];

    if (meridiem === "pm" && hours < 12) hours += 12;
    if (meridiem === "am" && hours === 12) hours = 0;

    now.setHours(hours, minutes, 0, 0);
    if (now.getTime() < Date.now()) {
      now.setDate(now.getDate() + 1);
    }
    return now.toISOString();
  }

  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString();
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Internal: Convert Convex response to common format
// ---------------------------------------------------------------------------

function convexToMessage(doc: any): Message {
  return {
    id: doc._id,
    chat_id: doc.chatId,
    role: doc.role,
    content: doc.content,
    metadata: doc.metadata,
    created_at: doc.createdAt
      ? new Date(doc.createdAt).toISOString()
      : undefined,
  };
}

function convexToMemoryItem(doc: any): MemoryItem {
  return {
    id: doc._id,
    type: doc.type,
    content: doc.content,
    deadline: doc.deadline ? new Date(doc.deadline).toISOString() : undefined,
    completed: doc.completed,
    completed_at: doc.completedAt
      ? new Date(doc.completedAt).toISOString()
      : undefined,
    created_at: doc.createdAt
      ? new Date(doc.createdAt).toISOString()
      : undefined,
  };
}

function convexToAsyncTask(doc: any): AsyncTask {
  return {
    id: doc._id,
    created_at: doc.createdAt
      ? new Date(doc.createdAt).toISOString()
      : new Date().toISOString(),
    updated_at: doc.updatedAt
      ? new Date(doc.updatedAt).toISOString()
      : new Date().toISOString(),
    chat_id: doc.chatId,
    original_prompt: doc.originalPrompt,
    status: doc.status,
    result: doc.result,
    session_id: doc.sessionId,
    current_step: doc.currentStep,
    pending_question: doc.pendingQuestion,
    pending_options: doc.pendingOptions,
    user_response: doc.userResponse,
    thread_id: doc.threadId,
    processed_by: doc.processedBy,
    reminder_sent: doc.reminderSent,
    metadata: doc.metadata,
  };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

// Session key helper — canonical definition lives in supabase.ts.
import { acceptedCreatedAt, isDisplayOnly, sessionKeyFor } from "./supabase";
export { acceptedCreatedAt, isDisplayOnly, sessionKeyFor };

// Nur-Anzeige-Einträge (metadata.display_only, Entscheidung 0006) kommen nie
// in den Convex-Speicher: persistMessage und saveDisplayOnlyMessage lehnen
// sie unter Convex ab, scripts/migrate-to-convex.ts überspringt sie. Das
// Convex-Backend begrenzt serverseitig (take, Suchindex) und kennt keinen
// display_only-Filter; ein Filter nach dem Limit könnte echte Beiträge
// verdrängen. Deshalb gilt die Regel beim Schreiben, und die Convex-Leser
// unten brauchen keinen Filter.

/**
 * Gespeicherte Nachricht, wie sie Zuhörer von onMessageSaved bekommen
 * (Issue #20, Live-Anzeige in der WebUI). metadata enthält immer msgId.
 * createdAt ist das mitgegebene created_at, wenn es gültig ist (Issue #69,
 * dann steht derselbe Wert im Speicher); sonst der Zeitpunkt direkt nach dem
 * Speichern, Supabase vergibt created_at dann selbst, der Wert kann um
 * Millisekunden früher liegen.
 */
export interface SavedMessageEvent {
  chatId: string;
  role: "user" | "assistant";
  content: string;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export type MessageSavedListener = (event: SavedMessageEvent) => void | Promise<void>;

const messageSavedListeners = new Set<MessageSavedListener>();

/**
 * Registriert einen Zuhörer, der nach jedem erfolgreichen saveMessage genau
 * einmal aufgerufen wird. Gibt die Abmeldung zurück. Fehler und abgelehnte
 * Promises eines Zuhörers bleiben bei ihm: Speichern und andere Zuhörer
 * laufen weiter.
 */
export function onMessageSaved(listener: MessageSavedListener): () => void {
  messageSavedListeners.add(listener);
  return () => {
    messageSavedListeners.delete(listener);
  };
}

function notifyMessageSaved(event: SavedMessageEvent): void {
  for (const listener of [...messageSavedListeners]) {
    try {
      const result = listener(event);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => {});
      }
    } catch {
      // Ein werfender Zuhörer beeinflusst weder das Speichern noch die anderen
    }
  }
}

/**
 * Vergibt metadata.msgId (UUID), falls keine gesetzt ist, speichert über
 * `persist` und benachrichtigt danach die Zuhörer, nur bei Erfolg. Eine
 * vorhandene msgId (z. B. web-<uuid> aus der WebUI) bleibt unverändert;
 * metadata.messageId (Telegram-Nachrichten-ID) ist ein anderes Feld.
 */
export async function saveMessageWith(
  message: Message,
  persist: (message: Message) => Promise<boolean>
): Promise<boolean> {
  const metadata: Record<string, unknown> = { ...(message.metadata ?? {}) };
  const existing = metadata.msgId;
  if (existing === undefined || existing === null || existing === "") metadata.msgId = crypto.randomUUID();
  // Ungültiges oder zukünftiges created_at gar nicht erst weitergeben (Issue #69)
  const { created_at: requested, ...rest } = message;
  const createdAt = acceptedCreatedAt(requested);
  const withId: Message = { ...rest, metadata, ...(createdAt ? { created_at: createdAt } : {}) };
  const ok = await persist(withId);
  if (ok === true) {
    notifyMessageSaved({
      chatId: withId.chat_id,
      role: withId.role,
      content: withId.content,
      metadata,
      createdAt: createdAt ?? new Date().toISOString(),
    });
  }
  return ok;
}

/**
 * Save a message. Generates embedding async via Convex action.
 * Zuhörer aus onMessageSaved hören danach davon (siehe saveMessageWith).
 */
export async function saveMessage(message: Message): Promise<boolean> {
  return saveMessageWith(message, persistMessage);
}

/**
 * Hält einen Nur-Anzeige-Eintrag fest (Entscheidung 0006, src/lib/outbox.ts):
 * direkter Insert ohne Embedding, msgId und onMessageSaved wie saveMessage.
 * Nur mit Supabase. Unter Convex false: Nur-Anzeige-Einträge kommen nie in
 * den Convex-Speicher (Regel am Anfang des Abschnitts Messages).
 */
export async function saveDisplayOnlyMessage(message: Message): Promise<boolean> {
  const backend = getBackend();
  if (backend !== "supabase") return false;
  const { insertMessageDirect } = await import("./supabase");
  return saveMessageWith(message, m => insertMessageDirect(m));
}

async function persistMessage(message: Message): Promise<boolean> {
  const backend = getBackend();

  if (backend === "convex") {
    // Nur-Anzeige-Einträge nie in Convex (Regel am Anfang des Abschnitts Messages)
    if (isDisplayOnly(message.metadata)) {
      console.warn("[convex] saveMessage: Nur-Anzeige-Eintrag unter Convex nicht gespeichert");
      return false;
    }
    const client = getConvex()!;
    try {
      const topicId =
        typeof message.metadata?.topicId === "number"
          ? message.metadata.topicId
          : undefined;
      const messageId = await client.mutation(anyApi.messages.insert, {
        chatId: message.chat_id,
        role: message.role,
        content: message.content,
        topicId,
        sessionKey: sessionKeyFor(message.chat_id, topicId ?? null),
        metadata: message.metadata || {},
        // message.created_at (Issue #69) bleibt unter Convex unbeachtet: es
        // dient der Reihenfolge zu Nur-Anzeige-Einträgen, und die gibt es hier nicht
        createdAt: Date.now(),
      });
      void client.action(anyApi.embeddings.generateMessageEmbedding, { messageId, text: message.content }).catch(() => {});
      return true;
    } catch (err) {
      console.error("Convex saveMessage error:", err);
      return false;
    }
  }

  if (backend === "supabase") {
    const { saveMessage: sbSave } = await import("./supabase");
    return sbSave(message);
  }

  return false;
}

/**
 * Retrieve the N most recent messages for a chat, ordered chronologically.
 */
export async function getRecentMessages(
  chatId: string,
  limit: number = 20,
  topicId?: number | null
): Promise<Message[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const docs = await client.query(anyApi.messages.getRecent, {
        chatId,
        limit,
        // undefined = full chat pool (legacy); number/null = session-isolated
        ...(topicId !== undefined
          ? { sessionKey: sessionKeyFor(chatId, topicId) }
          : {}),
      });
      return (docs || []).slice(0, limit).map(convexToMessage);
    } catch {
      return [];
    }
  }

  if (backend === "supabase") {
    const { getRecentMessages: sbGet } = await import("./supabase");
    return sbGet(chatId, limit, topicId);
  }

  return [];
}

// WebUI (Issue #17): nur Supabase. Unter Convex eine Log-Zeile und leere
// Liste, die Convex-Anbindung gehört nicht zur WebUI-Spec.
import type { HistoryOptions, HistoryRow, TopicActivity } from "./supabase";
export type { HistoryOptions, HistoryRow, TopicActivity };

/** Verlauf eines Session-Schlüssels, chronologisch, ohne Embedding. */
export async function getConversationHistory(
  chatId: string,
  topicId: number | null,
  options: HistoryOptions
): Promise<HistoryRow[]> {
  const backend = getBackend();
  if (backend === "convex") {
    console.warn("[convex] getConversationHistory: unter Convex nicht verfügbar, leere Liste");
    return [];
  }
  if (backend === "supabase") {
    const { getConversationHistory: sbGet } = await import("./supabase");
    return sbGet(chatId, topicId, options);
  }
  return [];
}

/** Letzte Aktivität je session_key eines Chats. */
export async function getTopicActivity(
  chatId: string,
  sinceDays: number
): Promise<TopicActivity[]> {
  const backend = getBackend();
  if (backend === "convex") {
    console.warn("[convex] getTopicActivity: unter Convex nicht verfügbar, leere Liste");
    return [];
  }
  if (backend === "supabase") {
    const { getTopicActivity: sbGet } = await import("./supabase");
    return sbGet(chatId, sinceDays);
  }
  return [];
}

// WebUI-Meldungen (Issue #47): nur Supabase, wie oben. Unter Convex gibt es
// keine Nur-Anzeige-Einträge (Regel am Anfang des Abschnitts Messages), also
// nichts abzuholen; keine Convex-Erweiterung.
import type { DisplayOnlyPageOptions, DisplayOnlyRow } from "./supabase";
export type { DisplayOnlyPageOptions, DisplayOnlyRow };

/** Meldungen der Chats, älteste zuerst; wirft bei Fehlern (siehe supabase.ts). */
export async function getDisplayOnlyPage(chatIds: string[], options: DisplayOnlyPageOptions): Promise<DisplayOnlyRow[]> {
  const backend = getBackend();
  if (backend !== "supabase") return [];
  const { getDisplayOnlyPage: sbGet } = await import("./supabase");
  return sbGet(chatIds, options);
}

/** created_at der jüngsten Meldung; wirft bei Fehlern (siehe supabase.ts). */
export async function getLatestDisplayOnlyAt(chatIds: string[]): Promise<string | null> {
  const backend = getBackend();
  if (backend !== "supabase") return null;
  const { getLatestDisplayOnlyAt: sbGet } = await import("./supabase");
  return sbGet(chatIds);
}

/** Eintrag zu einer Datei der Ablage; wirft bei Fehlern (siehe supabase.ts). */
export async function findDisplayOnlyFile(fileId: string, chatIds: string[]): Promise<DisplayOnlyRow | null> {
  const backend = getBackend();
  if (backend !== "supabase") return null;
  const { findDisplayOnlyFile: sbFind } = await import("./supabase");
  return sbFind(fileId, chatIds);
}

/**
 * Build a formatted conversation context string from recent messages.
 * topicId semantics as in getRecentMessages().
 */
export async function getConversationContext(
  chatId: string,
  limit: number = 10,
  topicId?: number | null
): Promise<string> {
  const messages = await getRecentMessages(chatId, limit, topicId);
  if (messages.length === 0) return "";

  return messages
    .map((msg) => {
      const time = msg.created_at ? getTimeAgo(new Date(msg.created_at)) : "";
      const speaker = msg.role === "user" ? "User" : "Bot";
      const content = msg.role === "assistant" && msg.content.length > 800
        ? msg.content.substring(0, 800) + "..."
        : msg.content;
      return `[${time}] ${speaker}: ${content}`;
    })
    .join("\n");
}

/**
 * Get recent messages across all channels/topics for board meeting context.
 */
export async function getBoardMeetingContext(
  days: number = 7
): Promise<string> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      // Das Backend liefert Rohzeilen (neueste zuerst), Aufbau wie bei Supabase
      const result = await client.query(anyApi.messages.getBoardMeetingContext, { days });
      const { formatBoardMeetingContext } = await import("./supabase");
      return formatBoardMeetingContext((Array.isArray(result) ? result : []).map(convexToMessage), days);
    } catch {
      return "\n\nFailed to load conversation context.";
    }
  }

  if (backend === "supabase") {
    const { getBoardMeetingContext: sbGet } = await import("./supabase");
    return sbGet(days);
  }

  return "\n\nNo conversation data available.";
}

/**
 * Semantic search across messages.
 * Falls back to text search when semantic search is unavailable.
 */
export async function searchMessages(
  chatId: string,
  query: string,
  limit: number = 10
): Promise<Message[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const docs = await client.query(anyApi.messages.textSearch, {
        chatId,
        query,
        limit,
      });
      const vector = await (await import("./supabase")).generateOpenAiEmbedding(query);
      if (vector) {
        const hits = await client.action(anyApi.messages.semanticSearch, { vector, chatId, limit }).catch(() => []);
        for (const hit of hits) {
          if (docs.some((doc: any) => doc._id === hit._id)) continue;
          const doc = await client.query(anyApi.messages.getById, { id: hit._id });
          if (doc && doc.chatId === chatId) docs.push(doc);
        }
      }
      return (docs || []).slice(0, limit).map(convexToMessage);
    } catch {
      return [];
    }
  }

  if (backend === "supabase") {
    const { searchMessages: sbSearch } = await import("./supabase");
    return sbSearch(chatId, query, limit);
  }

  return [];
}

// ---------------------------------------------------------------------------
// Memory: Facts
// ---------------------------------------------------------------------------

/**
 * Store a fact in the memory table.
 */
export async function addFact(content: string): Promise<boolean> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      await client.mutation(anyApi.memory.addFact, { content });
      return true;
    } catch {
      return false;
    }
  }

  if (backend === "supabase") {
    const { addFact: sbAdd } = await import("./supabase");
    return sbAdd(content);
  }

  return false;
}

/**
 * Retrieve all stored facts.
 */
export async function getFacts(): Promise<MemoryItem[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const docs = await client.query(anyApi.memory.getFacts, {});
      return (docs || []).map(convexToMemoryItem);
    } catch {
      return [];
    }
  }

  if (backend === "supabase") {
    const { getFacts: sbGet } = await import("./supabase");
    return sbGet();
  }

  return [];
}

// ---------------------------------------------------------------------------
// Agent SDK credit tally (self-metered). Convex if configured, else a local
// JSON file (works for Supabase members too — no extra SQL table needed). The
// tally is one tiny row per billing cycle. ALL helpers are fail-open: a null
// return must never block a reply — credit-guard.ts treats it as "no cap".
// ---------------------------------------------------------------------------

export interface SpendRow {
  cycleSpendUsd: number;
  cycleStartMs: number;
  warnedThisCycle: boolean;
  observedCeilingUsd: number | null;
}

function creditCycleStartMs(resetDay: number, nowMs: number): number {
  const rd = Math.min(Math.max(Math.round(resetDay), 1), 28);
  const now = new Date(nowMs);
  let y = now.getUTCFullYear();
  let m = now.getUTCMonth();
  if (now.getUTCDate() < rd) {
    m -= 1;
    if (m < 0) {
      m = 11;
      y -= 1;
    }
  }
  return Date.UTC(y, m, rd, 0, 0, 0, 0);
}

async function creditFilePath(): Promise<string> {
  // Mirror memory.ts: a gitignored JSON file alongside the project data.
  const { join } = await import("path");
  return join(process.env.GO_PROJECT_ROOT || process.cwd(), "credit-tally.json");
}

async function readLocalTally(resetDay: number): Promise<SpendRow & { plan?: string }> {
  const cs = creditCycleStartMs(resetDay, Date.now());
  try {
    const { readFile } = await import("fs/promises");
    const raw = JSON.parse(await readFile(await creditFilePath(), "utf-8"));
    if (raw && raw.cycleStartMs === cs) {
      return {
        cycleSpendUsd: raw.cycleSpendUsd ?? 0,
        cycleStartMs: cs,
        warnedThisCycle: !!raw.warnedThisCycle,
        observedCeilingUsd: raw.observedCeilingUsd ?? null,
        plan: raw.plan,
      };
    }
  } catch {
    /* missing/old cycle → fresh */
  }
  return { cycleSpendUsd: 0, cycleStartMs: cs, warnedThisCycle: false, observedCeilingUsd: null };
}

async function writeLocalTally(row: SpendRow & { plan?: string }): Promise<void> {
  try {
    const { writeFile, mkdir } = await import("fs/promises");
    const { dirname } = await import("path");
    const path = await creditFilePath();
    await mkdir(dirname(path), { recursive: true });
    await atomicWriteFile(path, JSON.stringify({ ...row, lastUpdatedMs: Date.now() }, null, 2));
  } catch {
    /* fail-open */
  }
}

export async function recordSpend(
  costUsd: number,
  resetDay: number,
  plan?: string
): Promise<SpendRow | null> {
  if (!(costUsd > 0)) return null;
  if (getBackend() === "convex") {
    const client = getConvex();
    if (!client) return null;
    try {
      return (await client.mutation(anyApi.creditGuard.record, { costUsd, resetDay, plan })) as SpendRow;
    } catch {
      return null;
    }
  }
  // local file (covers local + supabase deployments)
  const cur = await readLocalTally(resetDay);
  const next: SpendRow & { plan?: string } = {
    ...cur,
    cycleSpendUsd: cur.cycleSpendUsd + Math.max(0, costUsd),
    plan: plan ?? cur.plan,
  };
  await writeLocalTally(next);
  return next;
}

export async function getSpend(resetDay: number): Promise<SpendRow | null> {
  if (getBackend() === "convex") {
    const client = getConvex();
    if (!client) return null;
    try {
      return (await client.query(anyApi.creditGuard.getCurrent, { resetDay })) as SpendRow;
    } catch {
      return null;
    }
  }
  return readLocalTally(resetDay);
}

export async function markSpendWarned(resetDay: number): Promise<void> {
  if (getBackend() === "convex") {
    const client = getConvex();
    if (!client) return;
    try {
      await client.mutation(anyApi.creditGuard.markWarned, { resetDay });
    } catch {
      /* fail-open */
    }
    return;
  }
  const cur = await readLocalTally(resetDay);
  await writeLocalTally({ ...cur, warnedThisCycle: true });
}

export async function recordObservedCeiling(resetDay: number, spendUsd: number): Promise<void> {
  if (getBackend() === "convex") {
    const client = getConvex();
    if (!client) return;
    try {
      await client.mutation(anyApi.creditGuard.recordObservedCeiling, { resetDay, spendUsd });
    } catch {
      /* fail-open */
    }
    return;
  }
  const cur = await readLocalTally(resetDay);
  if (cur.observedCeilingUsd == null) {
    await writeLocalTally({ ...cur, observedCeilingUsd: Math.max(0, spendUsd) });
  }
}

// ---------------------------------------------------------------------------
// Memory: Goals
// ---------------------------------------------------------------------------

/**
 * Add a goal, optionally with a deadline (natural language or ISO).
 */
export async function addGoal(
  content: string,
  deadline?: string
): Promise<boolean> {
  const backend = getBackend();
  const parsedDeadline = deadline ? parseRelativeDate(deadline) : undefined;

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      await client.mutation(anyApi.memory.addGoal, {
        content,
        deadline: parsedDeadline
          ? new Date(parsedDeadline).getTime()
          : undefined,
      });
      return true;
    } catch {
      return false;
    }
  }

  if (backend === "supabase") {
    const { addGoal: sbAdd } = await import("./supabase");
    return sbAdd(content, deadline);
  }

  return false;
}

/**
 * Mark a goal as completed by partial text match.
 */
export async function completeGoal(searchText: string): Promise<boolean> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const result = await client.mutation(anyApi.memory.completeGoal, {
        searchText,
      });
      return !!result;
    } catch {
      return false;
    }
  }

  if (backend === "supabase") {
    const { completeGoal: sbComplete } = await import("./supabase");
    return sbComplete(searchText);
  }

  return false;
}

/**
 * Delete a fact by partial text match.
 */
export async function deleteFact(searchText: string): Promise<boolean> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const result = await client.mutation(anyApi.memory.deleteFact, {
        searchText,
      });
      return !!result;
    } catch {
      return false;
    }
  }

  if (backend === "supabase") {
    const { deleteFact: sbDelete } = await import("./supabase");
    return sbDelete(searchText);
  }

  return false;
}

/**
 * Cancel (delete) a goal by partial text match.
 */
export async function cancelGoal(searchText: string): Promise<boolean> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const result = await client.mutation(anyApi.memory.cancelGoal, {
        searchText,
      });
      return !!result;
    } catch {
      return false;
    }
  }

  if (backend === "supabase") {
    const { cancelGoal: sbCancel } = await import("./supabase");
    return sbCancel(searchText);
  }

  return false;
}

/**
 * Get all active (incomplete) goals.
 */
export async function getActiveGoals(): Promise<MemoryItem[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const docs = await client.query(anyApi.memory.getActiveGoals, {});
      return (docs || []).map(convexToMemoryItem);
    } catch {
      return [];
    }
  }

  if (backend === "supabase") {
    const { getActiveGoals: sbGet } = await import("./supabase");
    return sbGet();
  }

  return [];
}

// ---------------------------------------------------------------------------
// Memory Context
// ---------------------------------------------------------------------------

/**
 * Format goals into a readable list.
 */
export function formatGoalsList(goals: MemoryItem[]): string {
  if (goals.length === 0) return "No active goals.";
  return goals
    .map((g, i) => {
      const deadline = g.deadline
        ? ` (due: ${new Date(g.deadline).toLocaleDateString()})`
        : "";
      return `${i + 1}. ${g.content}${deadline}`;
    })
    .join("\n");
}

/**
 * Format facts into a readable list.
 */
export function formatFactsList(facts: MemoryItem[]): string {
  if (facts.length === 0) return "No stored facts.";
  return facts.map((f) => `- ${f.content}`).join("\n");
}

/**
 * Build a combined memory context string with facts and goals.
 */
export async function getMemoryContext(userMessage?: string): Promise<string> {
  const factsPromise = process.env.CONVEX_URL
    ? getConvex()!.query(anyApi.memory.getContextFacts, {}).then(docs => docs.map(convexToMemoryItem))
    : getFacts();
  const [facts, goals] = await Promise.all([factsPromise, getActiveGoals()]);
  // Shared pure assembly (relevance ranking + char budget when userMessage
  // is given) — implemented in supabase.ts, backend-agnostic.
  const { buildMemoryContextString } = await import("./supabase");
  return buildMemoryContextString(facts, goals, userMessage);
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

/**
 * Write a log entry. Fails silently.
 */
export async function log(
  level: LogEntry["level"],
  service: string,
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      await client.mutation(anyApi.logs.insert, {
        level,
        service,
        message,
        metadata: metadata || {},
        createdAt: Date.now(),
      });
    } catch {
      // Logging should never throw
    }
    return;
  }

  if (backend === "supabase") {
    const { log: sbLog } = await import("./supabase");
    return sbLog(level, service, message, metadata);
  }
}

// ---------------------------------------------------------------------------
// Async Tasks (Human-in-the-Loop)
// ---------------------------------------------------------------------------

/**
 * Create a new async task.
 */
export async function createTask(
  chatId: string,
  originalPrompt: string,
  threadId?: number,
  processedBy?: string
): Promise<AsyncTask | null> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const doc = await client.mutation(anyApi.asyncTasks.create, {
        chatId,
        originalPrompt,
        threadId,
        processedBy,
      });
      return doc ? convexToAsyncTask(doc) : null;
    } catch (err) {
      console.error("createTask error:", err);
      return null;
    }
  }

  if (backend === "supabase") {
    const { createTask: sbCreate } = await import("./supabase");
    return sbCreate(chatId, originalPrompt, threadId, processedBy);
  }

  return null;
}

/**
 * Update an async task's fields.
 */
export async function updateTask(
  taskId: string,
  updates: Partial<Omit<AsyncTask, "id" | "created_at">>
): Promise<boolean> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      // Convert snake_case update keys to camelCase for Convex
      const convexUpdates: Record<string, any> = {};
      if (updates.status !== undefined) convexUpdates.status = updates.status;
      if (updates.result !== undefined) convexUpdates.result = updates.result;
      if (updates.session_id !== undefined)
        convexUpdates.sessionId = updates.session_id;
      if (updates.current_step !== undefined)
        convexUpdates.currentStep = updates.current_step;
      if (updates.pending_question !== undefined)
        convexUpdates.pendingQuestion = updates.pending_question;
      if (updates.pending_options !== undefined)
        convexUpdates.pendingOptions = updates.pending_options;
      if (updates.user_response !== undefined)
        convexUpdates.userResponse = updates.user_response;
      if (updates.processed_by !== undefined)
        convexUpdates.processedBy = updates.processed_by;
      if (updates.reminder_sent !== undefined)
        convexUpdates.reminderSent = updates.reminder_sent;
      if (updates.metadata !== undefined)
        convexUpdates.metadata = updates.metadata;

      await client.mutation(anyApi.asyncTasks.update, {
        id: taskId,
        ...convexUpdates,
      });
      return true;
    } catch (err) {
      console.error("updateTask error:", err);
      return false;
    }
  }

  if (backend === "supabase") {
    const { updateTask: sbUpdate } = await import("./supabase");
    return sbUpdate(taskId, updates);
  }

  return false;
}

/**
 * Get a task by its ID.
 */
export async function getTaskById(taskId: string): Promise<AsyncTask | null> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const doc = await client.query(anyApi.asyncTasks.getById, {
        id: taskId,
      });
      return doc ? convexToAsyncTask(doc) : null;
    } catch {
      return null;
    }
  }

  if (backend === "supabase") {
    const { getTaskById: sbGet } = await import("./supabase");
    return sbGet(taskId);
  }

  return null;
}

/**
 * Get tasks waiting for user input in a specific chat.
 */
export async function getPendingTasks(chatId: string): Promise<AsyncTask[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const docs = await client.query(anyApi.asyncTasks.getPending, { chatId });
      return (docs || []).map(convexToAsyncTask);
    } catch {
      return [];
    }
  }

  if (backend === "supabase") {
    const { getPendingTasks: sbGet } = await import("./supabase");
    return sbGet(chatId);
  }

  return [];
}

/**
 * Get currently running tasks in a specific chat.
 */
export async function getRunningTasks(chatId: string): Promise<AsyncTask[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const docs = await client.query(anyApi.asyncTasks.getRunning, { chatId });
      return (docs || []).map(convexToAsyncTask);
    } catch {
      return [];
    }
  }

  if (backend === "supabase") {
    const { getRunningTasks: sbGet } = await import("./supabase");
    return sbGet(chatId);
  }

  return [];
}

/**
 * Get tasks that have been waiting for input longer than the threshold.
 */
export async function getStaleTasks(
  thresholdMs: number = 2 * 60 * 60 * 1000
): Promise<AsyncTask[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const docs = await client.query(anyApi.asyncTasks.getStale, {
        thresholdMs,
      });
      return (docs || []).map(convexToAsyncTask);
    } catch {
      return [];
    }
  }

  if (backend === "supabase") {
    const { getStaleTasks: sbGet } = await import("./supabase");
    return sbGet(thresholdMs);
  }

  return [];
}

// ---------------------------------------------------------------------------
// Node Heartbeat (Hybrid mode)
// ---------------------------------------------------------------------------

/**
 * Update heartbeat for a node.
 */
export async function upsertHeartbeat(
  nodeId: string,
  metadata?: Record<string, any>
): Promise<boolean> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      await client.mutation(anyApi.nodeHeartbeat.upsert, {
        nodeId,
        metadata: metadata || {},
      });
      return true;
    } catch (err) {
      console.error("upsertHeartbeat error:", err);
      return false;
    }
  }

  if (backend === "supabase") {
    const { upsertHeartbeat: sbUpsert } = await import("./supabase");
    return sbUpsert(nodeId, metadata);
  }

  return false;
}

/**
 * Check if a node is online (heartbeat within maxAgeMs).
 */
export async function getNodeStatus(
  nodeId: string,
  maxAgeMs: number = 90_000
): Promise<{ online: boolean; lastHeartbeat: string | null }> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const result = await client.query(anyApi.nodeHeartbeat.getStatus, {
        nodeId,
        maxAgeMs,
      });
      return result || { online: false, lastHeartbeat: null };
    } catch {
      return { online: false, lastHeartbeat: null };
    }
  }

  if (backend === "supabase") {
    const { getNodeStatus: sbGet } = await import("./supabase");
    return sbGet(nodeId, maxAgeMs);
  }

  return { online: false, lastHeartbeat: null };
}

// ---------------------------------------------------------------------------
// Scheduled Tasks
// ---------------------------------------------------------------------------

export interface ScheduledTask {
  id: string;
  created_at: string;
  chat_id: string;
  type: "reminder" | "action" | "recurring";
  prompt: string;
  scheduled_at: string;
  status: "pending" | "fired" | "cancelled";
  recurrence?: string;
}

function convexToScheduledTask(doc: any): ScheduledTask {
  return {
    id: doc._id,
    created_at: doc.createdAt
      ? new Date(doc.createdAt).toISOString()
      : new Date().toISOString(),
    chat_id: doc.chatId,
    type: doc.type,
    prompt: doc.prompt,
    scheduled_at: doc.scheduledAt
      ? new Date(doc.scheduledAt).toISOString()
      : new Date().toISOString(),
    status: doc.status,
    recurrence: doc.recurrence,
  };
}

/**
 * Create a scheduled task. Returns the task ID.
 */
export async function createScheduledTask(
  chatId: string,
  type: "reminder" | "action" | "recurring",
  prompt: string,
  scheduledAt: number, // epoch ms
  recurrence?: string
): Promise<string | null> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const id = await client.mutation(anyApi.scheduledTasks.create, {
        chatId,
        type,
        prompt,
        scheduledAt,
        recurrence,
      });
      return id;
    } catch (err) {
      console.error("createScheduledTask error:", err);
      return null;
    }
  }

  return null;
}

/**
 * List scheduled tasks for a chat.
 */
export async function listScheduledTasks(
  chatId: string,
  status?: "pending" | "fired" | "cancelled"
): Promise<ScheduledTask[]> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const docs = await client.query(anyApi.scheduledTasks.list, {
        chatId,
        status,
      });
      return (docs || []).map(convexToScheduledTask);
    } catch {
      return [];
    }
  }

  return [];
}

/**
 * Cancel a scheduled task by prompt text match.
 */
export async function cancelScheduledTask(
  chatId: string,
  searchText: string
): Promise<boolean> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      const result = await client.mutation(
        anyApi.scheduledTasks.cancelBySearch,
        { chatId, searchText }
      );
      return !!result;
    } catch {
      return false;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Connection Test
// ---------------------------------------------------------------------------

/**
 * Test the database connection. Returns a descriptive status string.
 */
export async function testConnection(): Promise<string> {
  const backend = getBackend();

  if (backend === "convex") {
    const client = getConvex()!;
    try {
      // Try a simple query to verify connection
      await client.query(anyApi.memory.getFacts, {});
      return "Convex connection OK.";
    } catch (err) {
      return `Convex connection error: ${err}`;
    }
  }

  if (backend === "supabase") {
    const { testConnection: sbTest } = await import("./supabase");
    return sbTest();
  }

  return "No database configured (missing CONVEX_URL and SUPABASE_URL).";
}

export async function getMemoryUpdatesSince(sinceMs: number): Promise<string> {
  if (!process.env.CONVEX_URL) return (await import("./supabase")).getMemoryUpdatesSince(sinceMs);
  const facts = await getFacts();
  return facts.filter(f => Date.parse(f.created_at || "") > sinceMs).map(f => `- ${f.content}`).join("\n");
}
