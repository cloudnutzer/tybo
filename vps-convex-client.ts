/**
 * VPS Convex Client — Drop-in replacement for supabase.ts on the VPS
 *
 * Uses ConvexHttpClient to talk to the Convex backend directly.
 * Exports the same interfaces and function signatures as the VPS supabase.ts
 * so gateway code can `import * as db from "./convex-client"` without changes.
 *
 * If CONVEX_URL is not set, falls back to lazy-importing the original supabase.ts.
 *
 * Key conversions:
 *   - Convex stores timestamps as epoch ms (numbers); VPS types use ISO strings
 *   - Convex uses camelCase fields; VPS types use snake_case
 */

import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

// ---------------------------------------------------------------------------
// Types (snake_case — matches existing VPS code)
// ---------------------------------------------------------------------------

export interface Message {
  id?: string;
  created_at?: string;
  role: "user" | "assistant";
  content: string;
  channel?: string;
  metadata?: Record<string, unknown>;
}

export interface MemoryItem {
  id?: string;
  created_at?: string;
  updated_at?: string;
  type: "fact" | "goal";
  content: string;
  deadline?: string;
  completed_at?: string;
  priority?: number;
  metadata?: Record<string, unknown>;
}

export interface LogEntry {
  id?: string;
  created_at?: string;
  level: "info" | "warn" | "error" | "debug";
  event: string;
  message?: string;
  metadata?: Record<string, unknown>;
  session_id?: string;
  duration_ms?: number;
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
  reminder_sent: boolean;
  metadata?: Record<string, any>;
}

export interface BoardMeetingDecisions {
  date: string;
  topic: string;
  decisions: string[];
  action_items: string[];
  participating_agents: string[];
}

// ---------------------------------------------------------------------------
// Singleton Client
// ---------------------------------------------------------------------------

let client: ConvexHttpClient | null = null;

function getClient(): ConvexHttpClient | null {
  if (client) return client;
  const url = process.env.CONVEX_URL;
  if (!url) return null;
  client = new ConvexHttpClient(url);
  return client;
}

function defaultChatId(): string {
  return process.env.TELEGRAM_USER_ID || "";
}

// ---------------------------------------------------------------------------
// Supabase fallback (lazy)
// ---------------------------------------------------------------------------

let _sbModule: any = undefined;

async function getSbModule(): Promise<any> {
  if (_sbModule !== undefined) return _sbModule;
  try {
    _sbModule = await import("./supabase");
    return _sbModule;
  } catch {
    _sbModule = null;
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API: client access
// ---------------------------------------------------------------------------

/**
 * Return null — Convex doesn't expose a raw client equivalent like SupabaseClient.
 * Kept for interface compatibility.
 */
export function getSupabase(): null {
  return null;
}

/**
 * Whether the Convex backend is configured.
 * Falls back to checking SUPABASE_URL for compat.
 */
export function isSupabaseEnabled(): boolean {
  return !!process.env.CONVEX_URL || !!process.env.SUPABASE_URL;
}

// ---------------------------------------------------------------------------
// Internal converters: Convex camelCase <-> snake_case
// ---------------------------------------------------------------------------

function epochToIso(epoch?: number): string | undefined {
  return epoch != null ? new Date(epoch).toISOString() : undefined;
}

function isoToEpoch(iso?: string): number | undefined {
  if (!iso) return undefined;
  const ms = new Date(iso).getTime();
  return isNaN(ms) ? undefined : ms;
}

function convexToMessage(doc: any): Message {
  return {
    id: doc._id ?? doc.id,
    role: doc.role,
    content: doc.content,
    channel: doc.channel,
    metadata: doc.metadata,
    created_at: epochToIso(doc.createdAt ?? doc._creationTime),
  };
}

function convexToMemoryItem(doc: any): MemoryItem {
  return {
    id: doc._id ?? doc.id,
    type: doc.type === "completed_goal" ? "goal" : doc.type,
    content: doc.content,
    deadline: epochToIso(doc.deadline),
    completed_at: epochToIso(doc.completedAt),
    priority: doc.priority,
    metadata: doc.metadata,
    created_at: epochToIso(doc.createdAt ?? doc._creationTime),
    updated_at: epochToIso(doc.updatedAt),
  };
}

function convexToAsyncTask(doc: any): AsyncTask {
  return {
    id: doc._id ?? doc.id,
    created_at: new Date(doc.createdAt ?? doc._creationTime).toISOString(),
    updated_at: new Date(doc.updatedAt ?? doc._creationTime).toISOString(),
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
    reminder_sent: doc.reminderSent ?? false,
    metadata: doc.metadata,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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
    if (now.getTime() < Date.now()) now.setDate(now.getDate() + 1);
    return now.toISOString();
  }
  const parsed = new Date(input);
  if (!isNaN(parsed.getTime())) return parsed.toISOString();
  return undefined;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export async function saveMessage(message: Message): Promise<boolean> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.saveMessage(message) : false;
  }
  try {
    await c.mutation(anyApi.messages.insert, {
      chatId: (message as any).chat_id || defaultChatId(),
      role: message.role,
      content: message.content,
      metadata: message.metadata || {},
      createdAt: message.created_at
        ? new Date(message.created_at).getTime()
        : Date.now(),
    });
    return true;
  } catch (err) {
    console.error("saveMessage error:", err);
    return false;
  }
}

export async function getRecentMessages(
  limit: number = 20,
  channel?: string
): Promise<Message[]> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.getRecentMessages(defaultChatId(), limit) : [];
  }
  try {
    const chatId = defaultChatId();
    const docs = await c.query(anyApi.messages.getRecent, { chatId, limit });
    return (docs || []).map(convexToMessage);
  } catch {
    return [];
  }
}

export async function getConversationContext(
  limit: number = 10,
  channel?: string
): Promise<string> {
  const messages = await getRecentMessages(limit, channel);
  if (messages.length === 0) return "";
  return messages
    .map((msg) => {
      const time = msg.created_at ? getTimeAgo(new Date(msg.created_at)) : "";
      const speaker = msg.role === "user" ? "User" : "Bot";
      return `[${time}] ${speaker}: ${msg.content}`;
    })
    .join("\n");
}

export async function getBoardMeetingContext(
  days: number = 7
): Promise<string> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb
      ? sb.getBoardMeetingContext(days)
      : "\n\nNo conversation data available.";
  }
  try {
    const docs = await c.query(anyApi.messages.getBoardMeetingContext, { days });
    if (!docs || (Array.isArray(docs) && docs.length === 0)) {
      return "\n\nNo recent conversations across topics.";
    }

    // If the Convex function returns raw message docs, format them
    if (Array.isArray(docs)) {
      const byChannel: Record<string, any[]> = {};
      for (const msg of docs) {
        const threadId = (msg.metadata as any)?.thread_id;
        const ch = threadId ? `topic_${threadId}` : "general";
        if (!byChannel[ch]) byChannel[ch] = [];
        if (byChannel[ch].length < 15) byChannel[ch].push(msg);
      }

      let context = `\n\n## BOARD MEETING CONTEXT (Last ${days} days)\n`;
      context += "Review of conversations across all agents:\n\n";

      for (const [ch, messages] of Object.entries(byChannel)) {
        context += `### ${ch}\n`;
        const exchanges = messages.map((m: any) => {
          const role = m.role === "user" ? "User" : "Agent";
          const preview =
            m.content.substring(0, 200) +
            (m.content.length > 200 ? "..." : "");
          return `- ${role}: ${preview}`;
        });
        context += exchanges.join("\n") + "\n\n";
      }

      return context;
    }

    // If it returned a formatted string already
    return typeof docs === "string" ? docs : "\n\nNo recent conversations.";
  } catch {
    return "\n\nFailed to load conversation context.";
  }
}

export async function searchMessages(
  query: string,
  limit: number = 10
): Promise<Message[]> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.searchMessages(defaultChatId(), query, limit) : [];
  }
  try {
    const chatId = defaultChatId();
    const docs = await c.query(anyApi.messages.textSearch, {
      chatId,
      query,
      limit,
    });
    return (docs || []).map(convexToMessage);
  } catch {
    return [];
  }
}

export async function getRecentMessagesAllChannels(
  limit: number = 50,
  maxAgeMs: number = 24 * 60 * 60 * 1000
): Promise<Message[]> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.getRecentMessages(defaultChatId(), limit) : [];
  }
  try {
    // getBoardMeetingContext returns recent messages across all chats
    const days = Math.ceil(maxAgeMs / (24 * 60 * 60 * 1000));
    const docs = await c.query(anyApi.messages.getBoardMeetingContext, {
      days,
      limit,
    });
    if (!docs || !Array.isArray(docs)) return [];
    return docs.map(convexToMessage);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Memory: Facts
// ---------------------------------------------------------------------------

export async function addFact(content: string): Promise<boolean> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.addFact(content) : false;
  }
  try {
    await c.mutation(anyApi.memory.addFact, { content });
    return true;
  } catch {
    return false;
  }
}

export async function getFacts(): Promise<MemoryItem[]> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.getFacts() : [];
  }
  try {
    const docs = await c.query(anyApi.memory.getFacts, {});
    return (docs || []).map(convexToMemoryItem);
  } catch {
    return [];
  }
}

export async function deleteFact(searchText: string): Promise<boolean> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.deleteFact(searchText) : false;
  }
  try {
    const result = await c.mutation(anyApi.memory.deleteFact, { searchText });
    return !!result;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Memory: Goals
// ---------------------------------------------------------------------------

export async function addGoal(
  content: string,
  deadline?: string
): Promise<boolean> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.addGoal(content, deadline) : false;
  }
  const parsedDeadline = deadline ? parseRelativeDate(deadline) : undefined;
  try {
    await c.mutation(anyApi.memory.addGoal, {
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

export async function completeGoal(searchText: string): Promise<boolean> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.completeGoal(searchText) : false;
  }
  try {
    const result = await c.mutation(anyApi.memory.completeGoal, { searchText });
    return !!result;
  } catch {
    return false;
  }
}

export async function cancelGoal(searchText: string): Promise<boolean> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.cancelGoal(searchText) : false;
  }
  try {
    const result = await c.mutation(anyApi.memory.cancelGoal, { searchText });
    return !!result;
  } catch {
    return false;
  }
}

export async function getActiveGoals(): Promise<MemoryItem[]> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.getActiveGoals() : [];
  }
  try {
    const docs = await c.query(anyApi.memory.getActiveGoals, {});
    return (docs || []).map(convexToMemoryItem);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Memory Context
// ---------------------------------------------------------------------------

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

export function formatFactsList(facts: MemoryItem[]): string {
  if (facts.length === 0) return "No stored facts.";
  return facts.map((f) => `- ${f.content}`).join("\n");
}

export async function getMemoryContext(): Promise<string> {
  const [facts, goals] = await Promise.all([getFacts(), getActiveGoals()]);
  const sections: string[] = [];

  if (facts.length > 0) {
    sections.push(`**Known Facts:**\n${formatFactsList(facts)}`);
  }
  if (goals.length > 0) {
    sections.push(`**Active Goals:**\n${formatGoalsList(goals)}`);
  }

  return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

export async function log(
  event: string,
  level: LogEntry["level"] = "info",
  message?: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    if (sb) sb.log(level, event, message || "", metadata);
    return;
  }
  try {
    await c.mutation(anyApi.logs.insert, {
      level,
      event,
      message,
      metadata: metadata || {},
      service: "vps-gateway",
    });
  } catch {
    // Logging should never throw
  }
}

export async function logToolUse(
  toolName: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await log("tool_use", "info", toolName, metadata);
}

export async function logSkillUse(
  skillName: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await log("skill_use", "info", skillName, metadata);
}

export async function logSubagent(
  agentName: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await log("subagent", "info", agentName, metadata);
}

export async function logSecurityEvent(
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await log("security", "warn", message, metadata);
}

export async function logMessage(
  message: string,
  metadata?: Record<string, unknown>
): Promise<void> {
  await log("message", "info", message, metadata);
}

// ---------------------------------------------------------------------------
// Node Heartbeat (Hybrid mode)
// ---------------------------------------------------------------------------

export async function upsertHeartbeat(
  nodeId: string,
  metadata?: Record<string, any>
): Promise<boolean> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.upsertHeartbeat(nodeId, metadata) : false;
  }
  try {
    await c.mutation(anyApi.nodeHeartbeat.upsert, {
      nodeId,
      metadata: metadata || {},
    });
    return true;
  } catch (err) {
    console.error("upsertHeartbeat error:", err);
    return false;
  }
}

export async function getNodeStatus(
  nodeId: string,
  maxAgeMs: number = 90_000
): Promise<{ online: boolean; lastHeartbeat: string | null }> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb
      ? sb.getNodeStatus(nodeId, maxAgeMs)
      : { online: false, lastHeartbeat: null };
  }
  try {
    const result = await c.query(anyApi.nodeHeartbeat.getStatus, {
      nodeId,
      maxAgeMs,
    });
    if (!result) return { online: false, lastHeartbeat: null };
    return {
      online: result.online,
      lastHeartbeat:
        result.lastHeartbeat != null
          ? typeof result.lastHeartbeat === "number"
            ? new Date(result.lastHeartbeat).toISOString()
            : result.lastHeartbeat
          : null,
    };
  } catch {
    return { online: false, lastHeartbeat: null };
  }
}

// ---------------------------------------------------------------------------
// Async Tasks (Human-in-the-Loop)
// ---------------------------------------------------------------------------

export async function createTask(task: {
  chat_id: string;
  original_prompt: string;
  thread_id?: number;
  processed_by?: string;
  metadata?: Record<string, any>;
}): Promise<AsyncTask | null> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb
      ? sb.createTask(
          task.chat_id,
          task.original_prompt,
          task.thread_id,
          task.processed_by
        )
      : null;
  }
  try {
    const id = await c.mutation(anyApi.asyncTasks.create, {
      chatId: task.chat_id,
      originalPrompt: task.original_prompt,
      threadId: task.thread_id,
      processedBy: task.processed_by,
      metadata: task.metadata,
    });
    if (!id) return null;
    // Fetch the created task to return it
    const doc = await c.query(anyApi.asyncTasks.getById, { id });
    return doc ? convexToAsyncTask(doc) : null;
  } catch (err) {
    console.error("createTask error:", err);
    return null;
  }
}

export async function updateTask(
  taskId: string,
  updates: Partial<Omit<AsyncTask, "id" | "created_at">>
): Promise<boolean> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.updateTask(taskId, updates) : false;
  }
  try {
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

    await c.mutation(anyApi.asyncTasks.update, {
      id: taskId,
      ...convexUpdates,
    });
    return true;
  } catch (err) {
    console.error("updateTask error:", err);
    return false;
  }
}

export async function getPendingTasks(chatId: string): Promise<AsyncTask[]> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.getPendingTasks(chatId) : [];
  }
  try {
    const docs = await c.query(anyApi.asyncTasks.getPending, { chatId });
    return (docs || []).map(convexToAsyncTask);
  } catch {
    return [];
  }
}

export async function getRunningTasks(chatId: string): Promise<AsyncTask[]> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.getRunningTasks(chatId) : [];
  }
  try {
    const docs = await c.query(anyApi.asyncTasks.getRunning, { chatId });
    return (docs || []).map(convexToAsyncTask);
  } catch {
    return [];
  }
}

export async function getTaskById(taskId: string): Promise<AsyncTask | null> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.getTaskById(taskId) : null;
  }
  try {
    const doc = await c.query(anyApi.asyncTasks.getById, { id: taskId });
    return doc ? convexToAsyncTask(doc) : null;
  } catch {
    return null;
  }
}

export async function getStaleTasks(
  maxAgeMs: number = 2 * 60 * 60 * 1000
): Promise<AsyncTask[]> {
  const c = getClient();
  if (!c) {
    const sb = await getSbModule();
    return sb ? sb.getStaleTasks(maxAgeMs) : [];
  }
  try {
    const docs = await c.query(anyApi.asyncTasks.getStale, {
      thresholdMs: maxAgeMs,
    });
    return (docs || []).map(convexToAsyncTask);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Call Transcripts
// ---------------------------------------------------------------------------

export async function saveCallTranscript(data: {
  conversation_id: string;
  transcript?: string;
  summary?: string;
  action_items?: string[];
  duration_seconds?: number;
  metadata?: Record<string, any>;
}): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  try {
    await c.mutation(anyApi.callTranscripts.insert, {
      conversationId: data.conversation_id,
      transcript: data.transcript,
      summary: data.summary,
      actionItems: data.action_items,
      durationSeconds: data.duration_seconds,
      metadata: data.metadata || {},
    });
    return true;
  } catch (err) {
    console.error("saveCallTranscript error:", err);
    return false;
  }
}

export async function getRecentCallTranscripts(
  limit: number = 10
): Promise<any[]> {
  const c = getClient();
  if (!c) return [];
  try {
    // Use getBoardMeetingContext-style approach: query recent, take limit
    // callTranscripts doesn't have a getRecent query, use the index
    // Fall back to a knowledge search if no dedicated query exists
    const docs = await c.query(anyApi.knowledge.getRecent, {
      category: "reference" as any,
      limit,
    });
    return docs || [];
  } catch {
    return [];
  }
}

export async function hasCallTranscript(
  conversationId: string
): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  try {
    const doc = await c.query(anyApi.callTranscripts.getByConversationId, {
      conversationId,
    });
    return !!doc;
  } catch {
    return false;
  }
}

export async function searchTranscripts(
  query: string,
  limit: number = 10
): Promise<any[]> {
  const c = getClient();
  if (!c) return [];
  try {
    // Use knowledge search as transcripts don't have text search
    const results = await c.query(anyApi.knowledge.search, {
      query,
      limit,
    });
    return results || [];
  } catch {
    return [];
  }
}

export async function saveTranscriptChunks(
  conversationId: string,
  chunks: string[]
): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  try {
    // Save as a single transcript with chunks joined
    await c.mutation(anyApi.callTranscripts.insert, {
      conversationId,
      transcript: chunks.join("\n\n---\n\n"),
      metadata: { chunked: true, chunkCount: chunks.length },
    });
    return true;
  } catch (err) {
    console.error("saveTranscriptChunks error:", err);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Board Decisions (via knowledge table)
// ---------------------------------------------------------------------------

export async function saveBoardDecisions(
  decisions: BoardMeetingDecisions
): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  try {
    await c.mutation(anyApi.knowledge.add, {
      category: "decision" as any,
      title: `Board Meeting: ${decisions.topic}`,
      content: JSON.stringify({
        date: decisions.date,
        topic: decisions.topic,
        decisions: decisions.decisions,
        action_items: decisions.action_items,
        participating_agents: decisions.participating_agents,
      }),
      tags: ["board-meeting"],
      source: "board-meeting",
      metadata: {
        type: "board_decisions",
        date: decisions.date,
        agents: decisions.participating_agents,
      },
    });
    return true;
  } catch (err) {
    console.error("saveBoardDecisions error:", err);
    return false;
  }
}

export async function saveBoardTranscript(
  transcript: string,
  date: string
): Promise<boolean> {
  const c = getClient();
  if (!c) return false;
  try {
    await c.mutation(anyApi.knowledge.add, {
      category: "reference" as any,
      title: `Board Meeting Transcript ${date}`,
      content: transcript,
      tags: ["board-meeting", "transcript"],
      source: "board-meeting",
      metadata: { type: "board_transcript", date },
    });
    return true;
  } catch (err) {
    console.error("saveBoardTranscript error:", err);
    return false;
  }
}

export async function getLastBoardDecisions(): Promise<BoardMeetingDecisions | null> {
  const c = getClient();
  if (!c) return null;
  try {
    const results = await c.query(anyApi.knowledge.search, {
      query: "board meeting",
      category: "decision" as any,
      limit: 1,
    });
    if (!results || results.length === 0) return null;

    const entry = results[0];
    try {
      const parsed = JSON.parse(entry.content);
      return {
        date: parsed.date || entry.updatedAt
          ? new Date(entry.updatedAt).toISOString()
          : new Date().toISOString(),
        topic: parsed.topic || entry.title,
        decisions: parsed.decisions || [],
        action_items: parsed.action_items || [],
        participating_agents: parsed.participating_agents || [],
      };
    } catch {
      return {
        date: new Date(entry.updatedAt).toISOString(),
        topic: entry.title,
        decisions: [entry.content],
        action_items: [],
        participating_agents: [],
      };
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Connection Test
// ---------------------------------------------------------------------------

export async function testConnection(): Promise<string> {
  const c = getClient();
  if (!c) {
    if (process.env.SUPABASE_URL) {
      const sb = await getSbModule();
      return sb
        ? sb.testConnection()
        : "Supabase module not available.";
    }
    return "No database configured (missing CONVEX_URL and SUPABASE_URL).";
  }
  try {
    await c.query(anyApi.memory.getFacts, {});
    return "Convex connection OK.";
  } catch (err) {
    return `Convex connection error: ${err}`;
  }
}
