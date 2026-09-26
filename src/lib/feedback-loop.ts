import { BRAND } from "../brand";
import { atomicWriteFile } from "./atomic-file";
/**
 * tybo Feedback Loop — Adaptive Interaction Scoring
 *
 * Scores Telegram interactions and (optionally) Claude Code terminal sessions.
 * Auto-detects the user's setup:
 *   - Convex → read messages + store scores in Convex
 *   - Supabase → read messages + store scores in Supabase (future)
 *   - Local → read from message history JSON + store scores locally
 *   - CC channel → parse JSONL if ~/.claude/history/ exists (local/hybrid users)
 *
 * Generates config/patterns.md with actionable insights injected into system prompt.
 *
 * Usage:
 *   bun run feedback              — score today
 *   bun run feedback --backfill=5 — score last 5 days
 *   bun run feedback --analyze    — run weekly analysis
 */

import { readFile, writeFile, readdir } from "fs/promises";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { getConvex, getRecentMessages } from "./convex";
import { anyApi } from "convex/server";

// ============================================================
// CONFIG
// ============================================================

const PROJECT_DIR = resolve(import.meta.dirname || ".", "../..");
export const PATTERNS_PATH = join(PROJECT_DIR, "config", "patterns.md");
const CLAUDE_HISTORY = join(homedir(), ".claude", "history", "raw-outputs");

/**
 * Schwerpunkt einer Claude-Code-Session: der Projektordner von tybo (erkannt
 * am Namen aus BRAND), sonst nach Ordner oder Stichworten in den Prompts.
 */
export function sessionFocusFor(cwd: string, promptText: string): string {
  if (cwd.toLowerCase().includes(BRAND.name)) return `${BRAND.name}-development`;
  if (cwd.includes("services/")) return "pai-services";
  if (cwd.includes("development/")) return "development";
  const allText = promptText.toLowerCase();
  if (allText.includes("research")) return "research";
  if (allText.includes("video") || allText.includes("content")) return "content-creation";
  return "general";
}

function log(msg: string) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

function getDateStr(date: Date): string {
  return date.toISOString().split("T")[0];
}

// ============================================================
// SETUP DETECTION
// ============================================================

interface SetupInfo {
  database: "convex" | "none";
  hasCCHistory: boolean;
  chatId: string;
}

function detectSetup(): SetupInfo {
  return {
    database: process.env.CONVEX_URL ? "convex" : "none",
    hasCCHistory: existsSync(CLAUDE_HISTORY),
    chatId: process.env.TELEGRAM_USER_ID || "",
  };
}

// ============================================================
// SHARED TYPES & SCORING
// ============================================================

export interface ScoredInteraction {
  date: string;
  channel: "claude-code" | "telegram";
  sessionId: string;
  score: number;
  label: string;
  durationMin: number;
  messageCount: number;
  toolCount: number;
  toolSuccessPct: number;
  correctionCount: number;
  appreciationCount: number;
  topSkills: string;
  sessionFocus: string;
  responseAvgSec: number;
}

function scoreLabel(score: number): string {
  if (score >= 80) return "Excellent";
  if (score >= 60) return "Good";
  if (score >= 40) return "Mixed";
  if (score >= 20) return "Poor";
  return "Failed";
}

// ============================================================
// TELEGRAM CHANNEL — Keyword Detection
// ============================================================

const APPRECIATION_KEYWORDS = [
  "thanks", "thank you", "perfect", "great", "exactly", "awesome",
  "love it", "brilliant", "nice", "well done", "good job", "excellent",
  "that's right", "correct", "spot on", "nailed it",
];

const CORRECTION_KEYWORDS = [
  "wrong", "that's not right", "not what i", "incorrect",
  "that's not", "you misunderstood", "i meant", "try again",
  "that's wrong", "fix this",
];

function detectAppreciation(text: string): boolean {
  return APPRECIATION_KEYWORDS.some(kw => text.toLowerCase().includes(kw));
}

function detectCorrection(text: string): boolean {
  const lower = text.toLowerCase();
  if (lower.startsWith("no ") || lower.startsWith("no,") || lower === "no") return true;
  return CORRECTION_KEYWORDS.some(kw => lower.includes(kw));
}

function deriveTopicFromText(text: string): string {
  const lower = text.toLowerCase();
  if (lower.includes("task") || lower.includes("notion")) return "task-management";
  if (lower.includes("email") || lower.includes("gmail")) return "email";
  if (lower.includes("calendar") || lower.includes("meeting")) return "calendar";
  if (lower.includes("video") || lower.includes("content")) return "content";
  if (lower.includes("research")) return "research";
  if (lower.includes("whatsapp") || lower.includes("linkedin")) return "communication";
  if (lower.includes("code") || lower.includes("deploy")) return "development";
  if (lower.includes("schedule") || lower.includes("remind")) return "scheduling";
  return "general";
}

// ============================================================
// TELEGRAM SCORING — Convex
// ============================================================

interface SimpleMessage {
  id: string;
  created_at: string;
  role: string;
  content: string;
  metadata?: Record<string, any>;
}

async function fetchTelegramMessages(dateStr: string, chatId: string): Promise<SimpleMessage[]> {
  const c = getConvex();
  if (!c) return [];

  const dayStart = new Date(dateStr + "T00:00:00Z").getTime();
  const dayEnd = new Date(dateStr + "T23:59:59.999Z").getTime();

  try {
    const docs = await c.query(anyApi.messages.getRecent, { chatId, limit: 500 });
    return (docs || [])
      .filter((d: any) => {
        const t = d.createdAt ?? d._creationTime;
        return t >= dayStart && t <= dayEnd;
      })
      .map((d: any) => ({
        id: String(d._id || ""),
        created_at: new Date(d.createdAt ?? d._creationTime).toISOString(),
        role: d.role,
        content: d.content,
        metadata: d.metadata,
      }));
  } catch (err: any) {
    log(`Convex messages error: ${err.message}`);
    return [];
  }
}

function groupIntoConversations(messages: SimpleMessage[]): SimpleMessage[][] {
  if (messages.length === 0) return [];
  const sorted = [...messages].sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
  const convos: SimpleMessage[][] = [[sorted[0]]];
  for (let i = 1; i < sorted.length; i++) {
    const gap = new Date(sorted[i].created_at).getTime() - new Date(sorted[i - 1].created_at).getTime();
    if (gap > 30 * 60 * 1000) convos.push([sorted[i]]);
    else convos[convos.length - 1].push(sorted[i]);
  }
  return convos;
}

function scoreConversation(messages: SimpleMessage[], dateStr: string): ScoredInteraction {
  const userMsgs = messages.filter(m => m.role === "user");
  const assistantMsgs = messages.filter(m => m.role === "assistant");

  let appreciationCount = 0, correctionCount = 0, followUpCount = 0;

  for (let i = 0; i < userMsgs.length; i++) {
    if (detectAppreciation(userMsgs[i].content)) appreciationCount++;
    if (detectCorrection(userMsgs[i].content)) correctionCount++;
    if (i > 0) {
      const prevAssistant = assistantMsgs.find(a =>
        new Date(a.created_at).getTime() > new Date(userMsgs[i - 1].created_at).getTime() &&
        new Date(a.created_at).getTime() < new Date(userMsgs[i].created_at).getTime()
      );
      if (prevAssistant) {
        const gap = new Date(userMsgs[i].created_at).getTime() - new Date(prevAssistant.created_at).getTime();
        if (gap < 5 * 60 * 1000) followUpCount++;
      }
    }
  }

  let score = 50;
  if (appreciationCount > 0) score += 15;
  if (followUpCount > 0) score += 10;
  if (userMsgs.length > 3) score += 5;
  score -= correctionCount * 25;
  score = Math.max(0, Math.min(100, score));

  const startTime = new Date(messages[0].created_at);
  const endTime = new Date(messages[messages.length - 1].created_at);
  const combinedText = userMsgs.map(m => m.content).join(" ");

  const agents = messages.filter(m => m.metadata?.agent).map(m => m.metadata!.agent);
  const topAgent = agents.length > 0
    ? [...new Map(agents.map(a => [a, agents.filter(x => x === a).length])).entries()]
        .sort((a, b) => b[1] - a[1])[0]?.[0] || "default"
    : "default";

  return {
    date: dateStr,
    channel: "telegram",
    sessionId: String(messages[0].id).slice(0, 8) || `tg-${startTime.getTime()}`,
    score,
    label: scoreLabel(score),
    durationMin: Math.round((endTime.getTime() - startTime.getTime()) / 60000),
    messageCount: userMsgs.length,
    toolCount: 0,
    toolSuccessPct: 100,
    correctionCount,
    appreciationCount,
    topSkills: topAgent,
    sessionFocus: deriveTopicFromText(combinedText),
    responseAvgSec: 0,
  };
}

async function scoreTelegramChannel(dateStr: string, chatId: string): Promise<ScoredInteraction[]> {
  const messages = await fetchTelegramMessages(dateStr, chatId);
  log(`  Telegram: ${messages.length} messages`);
  if (messages.length === 0) return [];
  const convos = groupIntoConversations(messages);
  return convos.map(c => scoreConversation(c, dateStr));
}

// ============================================================
// CLAUDE CODE CHANNEL — JSONL Parsing (optional, local/hybrid only)
// ============================================================

interface CCEvent {
  session_id: string;
  hook_event_type: string;
  payload: Record<string, any>;
  timestamp: number;
}

const FRUSTRATION_KEYWORDS = [
  "wrong", "garbage", "not what i", "try again", "that's not",
  "no no", "undo", "revert", "broken", "messed up", "doesn't work",
  "didn't work", "not this", "i said", "why did you", "that was wrong",
];

async function scoreCCChannel(dateStr: string): Promise<ScoredInteraction[]> {
  if (!existsSync(CLAUDE_HISTORY)) return [];

  const [year, month] = dateStr.split("-");
  const filePath = join(CLAUDE_HISTORY, `${year}-${month}`, `${dateStr}_all-events.jsonl`);
  if (!existsSync(filePath)) return [];

  const content = await readFile(filePath, "utf-8");
  const events: CCEvent[] = [];
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { /* skip */ }
  }

  // Group by session
  const sessions = new Map<string, CCEvent[]>();
  for (const e of events) {
    const sid = e.session_id || "unknown";
    if (!sessions.has(sid)) sessions.set(sid, []);
    sessions.get(sid)!.push(e);
  }

  const scores: ScoredInteraction[] = [];
  for (const [sessionId, sessionEvents] of sessions) {
    const prompts = sessionEvents.filter(e => e.hook_event_type === "UserPromptSubmit");
    const tools = sessionEvents.filter(e => e.hook_event_type === "PostToolUse");
    const stops = sessionEvents.filter(e => e.hook_event_type === "Stop");

    if (prompts.length === 0) continue;

    const timestamps = sessionEvents.map(e => e.timestamp).sort();
    const durationMin = Math.round((timestamps[timestamps.length - 1] - timestamps[0]) / 60000);

    const totalTools = tools.length;
    const errorTools = tools.filter(e => {
      const resp = e.payload?.tool_response;
      return resp && typeof resp === "object" && resp.code !== undefined && resp.code !== 0;
    }).length;
    const toolSuccessPct = totalTools > 0 ? Math.round(((totalTools - errorTools) / totalTools) * 100) : 100;

    let correctionCount = 0, fastFollowUps = 0;
    for (let i = 0; i < prompts.length; i++) {
      const text = prompts[i].payload?.prompt || "";
      if (FRUSTRATION_KEYWORDS.some(kw => text.toLowerCase().includes(kw))) correctionCount++;
      if (i > 0) {
        const stop = stops.find(s => s.timestamp > prompts[i - 1].timestamp && s.timestamp < prompts[i].timestamp);
        if (stop && (prompts[i].timestamp - stop.timestamp) / 1000 < 60) fastFollowUps++;
      }
    }

    // Count multi-tool chains (5+ tools between prompts)
    let chains = 0, chain = 0;
    for (const e of [...sessionEvents].sort((a, b) => a.timestamp - b.timestamp)) {
      if (e.hook_event_type === "PostToolUse") chain++;
      else if (e.hook_event_type === "UserPromptSubmit") { if (chain >= 5) chains++; chain = 0; }
    }
    if (chain >= 5) chains++;

    const writeEdits = tools.filter(e => {
      const n = e.payload?.tool_name;
      return n === "Write" || n === "Edit";
    }).length;

    let score = 50;
    if (fastFollowUps > 0) score += 15;
    if (toolSuccessPct > 90) score += 10;
    if (chains > 0) score += 10;
    if (writeEdits > 0) score += 5;
    score -= correctionCount * 25;
    if (toolSuccessPct < 50) score -= 10;
    score = Math.max(0, Math.min(100, score));

    // Top tools
    const toolCounts = new Map<string, number>();
    for (const t of tools) { const n = t.payload?.tool_name || "?"; toolCounts.set(n, (toolCounts.get(n) || 0) + 1); }
    const topSkills = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([n]) => n).join(", ");

    // Derive focus
    const cwd = sessionEvents[0]?.payload?.cwd || "";
    const sessionFocus = sessionFocusFor(cwd, prompts.map(p => p.payload?.prompt || "").join(" "));

    scores.push({
      date: dateStr, channel: "claude-code", sessionId: sessionId.slice(0, 8),
      score, label: scoreLabel(score), durationMin, messageCount: prompts.length,
      toolCount: totalTools, toolSuccessPct, correctionCount, appreciationCount: 0,
      topSkills, sessionFocus, responseAvgSec: 0,
    });
  }

  return scores;
}

// ============================================================
// STORAGE — Convex (primary) or local JSON (fallback)
// ============================================================

const LOCAL_SCORES_PATH = join(PROJECT_DIR, "config", "interaction-scores.json");

async function saveScores(scores: ScoredInteraction[]): Promise<void> {
  if (scores.length === 0) return;

  const c = getConvex();
  if (c) {
    try {
      await c.mutation(anyApi.interactionScores.insertBatch, { scores });
      log(`  Saved ${scores.length} scores to Convex`);
      return;
    } catch (err: any) {
      log(`  WARN: Convex save failed, falling back to local: ${err.message}`);
    }
  }

  // Fallback: local JSON
  let existing: ScoredInteraction[] = [];
  try {
    existing = JSON.parse(await readFile(LOCAL_SCORES_PATH, "utf-8"));
  } catch { /* no existing file */ }
  existing.push(...scores);
  const configDir = join(PROJECT_DIR, "config");
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  await atomicWriteFile(LOCAL_SCORES_PATH, JSON.stringify(existing, null, 2));
  log(`  Saved ${scores.length} scores to local JSON`);
}

async function loadAllScores(): Promise<ScoredInteraction[]> {
  const c = getConvex();
  if (c) {
    try {
      const docs = await c.query(anyApi.interactionScores.getAll, {});
      return (docs || []).map((d: any) => ({
        date: d.date, channel: d.channel, sessionId: d.sessionId, score: d.score,
        label: d.label, durationMin: d.durationMin, messageCount: d.messageCount,
        toolCount: d.toolCount, toolSuccessPct: d.toolSuccessPct,
        correctionCount: d.correctionCount, appreciationCount: d.appreciationCount,
        topSkills: d.topSkills, sessionFocus: d.sessionFocus, responseAvgSec: d.responseAvgSec,
      }));
    } catch { /* fall through */ }
  }

  // Fallback: local JSON
  try {
    return JSON.parse(await readFile(LOCAL_SCORES_PATH, "utf-8"));
  } catch { return []; }
}

async function dateAlreadyScored(dateStr: string): Promise<boolean> {
  const c = getConvex();
  if (c) {
    try {
      return await c.query(anyApi.interactionScores.existsForDate, { date: dateStr });
    } catch { /* fall through */ }
  }
  try {
    const existing: ScoredInteraction[] = JSON.parse(await readFile(LOCAL_SCORES_PATH, "utf-8"));
    return existing.some(s => s.date === dateStr);
  } catch { return false; }
}

// ============================================================
// ANALYZER — Generate Patterns
// ============================================================

function computeStats(rows: ScoredInteraction[]) {
  if (rows.length === 0) return { count: 0, avgScore: 0, excellentCount: 0, correctionTotal: 0, appreciationTotal: 0 };
  return {
    count: rows.length,
    avgScore: Math.round(rows.reduce((a, r) => a + r.score, 0) / rows.length),
    excellentCount: rows.filter(r => r.score >= 80).length,
    correctionTotal: rows.reduce((a, r) => a + r.correctionCount, 0),
    appreciationTotal: rows.reduce((a, r) => a + r.appreciationCount, 0),
  };
}

function groupBy<T>(items: T[], keyFn: (i: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const i of items) { const k = keyFn(i); if (!m.has(k)) m.set(k, []); m.get(k)!.push(i); }
  return m;
}

export function generatePatterns(allRows: ScoredInteraction[]): string {
  const now = new Date();
  const thisWeek = allRows.filter(r => (now.getTime() - new Date(r.date).getTime()) < 7 * 24 * 60 * 60 * 1000);
  const prevWeek = allRows.filter(r => { const age = now.getTime() - new Date(r.date).getTime(); return age >= 7 * 24 * 60 * 60 * 1000 && age < 14 * 24 * 60 * 60 * 1000; });

  const ccRows = thisWeek.filter(r => r.channel === "claude-code");
  const tgRows = thisWeek.filter(r => r.channel === "telegram");
  const ccStats = computeStats(ccRows);
  const tgStats = computeStats(tgRows);
  const allStats = computeStats(thisWeek);
  const prevStats = computeStats(prevWeek);

  const byFocus = groupBy(thisWeek, r => r.sessionFocus);
  const focusRanked = [...byFocus.entries()].map(([f, rows]) => ({ f, ...computeStats(rows) })).sort((a, b) => b.avgScore - a.avgScore);

  const trend = prevStats.count > 0 ? (allStats.avgScore > prevStats.avgScore ? "improving" : allStats.avgScore < prevStats.avgScore ? "declining" : "stable") : "baseline";
  const trendDelta = prevStats.count > 0 ? allStats.avgScore - prevStats.avgScore : 0;

  const lowScoring = thisWeek.filter(r => r.score < 40);
  const correctionHotspots = [...groupBy(lowScoring, r => r.sessionFocus).entries()]
    .map(([f, rows]) => ({ f, count: rows.length })).sort((a, b) => b.count - a.count).slice(0, 3);

  // Quick Reference
  const qr: string[] = [];
  if (focusRanked.length > 0) qr.push(`Best: ${focusRanked[0].f} (avg ${focusRanked[0].avgScore})`);
  if (focusRanked.length > 1) { const w = focusRanked[focusRanked.length - 1]; if (w.avgScore < 50) qr.push(`Weak: ${w.f} (avg ${w.avgScore}) — confirm before acting`); }
  if (ccStats.count > 0 && tgStats.count > 0) qr.push(`Stronger: ${ccStats.avgScore > tgStats.avgScore ? "CC" : "Telegram"} (${ccStats.avgScore} vs ${tgStats.avgScore})`);
  if (correctionHotspots.length > 0) qr.push(`Most corrections: ${correctionHotspots[0].f}`);
  if (trend !== "baseline") qr.push(`Trend: ${trend} (${trendDelta > 0 ? "+" : ""}${trendDelta})`);

  return `# ${BRAND.name} Patterns\n\n> ${now.toISOString().split("T")[0]} | ${allRows.length} total | ${thisWeek.length} this week\n\n## Quick Reference\n\n${qr.map(l => `- ${l}`).join("\n")}\n\n## Stats\n\n| Channel | Sessions | Avg | Excellent | Corrections |\n|---------|----------|-----|-----------|-------------|\n| CC | ${ccStats.count} | ${ccStats.avgScore} | ${ccStats.excellentCount} | ${ccStats.correctionTotal} |\n| Telegram | ${tgStats.count} | ${tgStats.avgScore} | ${tgStats.excellentCount} | ${tgStats.correctionTotal} |\n\n## Focus Areas\n\n${focusRanked.map(f => `- **${f.f}**: avg ${f.avgScore} (${f.count} sessions, ${f.correctionTotal} corrections)`).join("\n")}\n\n## Trend: ${trend} ${trendDelta !== 0 ? `(${trendDelta > 0 ? "+" : ""}${trendDelta})` : ""}`;
}

// ============================================================
// PATTERNS LOADER (for system prompt injection)
// ============================================================

/**
 * Get the Quick Reference section for system prompt injection.
 * Returns empty string if no patterns file exists yet.
 */
export function getQuickReference(): string {
  try {
    if (!existsSync(PATTERNS_PATH)) return "";
    const content = readFileSync(PATTERNS_PATH, "utf-8");
    const match = content.match(/## Quick Reference\n\n([\s\S]*?)(?=\n## )/);
    return match ? match[1].trim() : "";
  } catch { return ""; }
}

// ============================================================
// PUBLIC API
// ============================================================

export async function scoreDay(dateStr: string, force = false): Promise<ScoredInteraction[]> {
  const setup = detectSetup();

  if (!force && await dateAlreadyScored(dateStr)) {
    log(`  ${dateStr}: already scored (use --force)`);
    return [];
  }

  // Score both channels in parallel
  const [tgScores, ccScores] = await Promise.all([
    setup.database !== "none" ? scoreTelegramChannel(dateStr, setup.chatId) : Promise.resolve([]),
    setup.hasCCHistory ? scoreCCChannel(dateStr) : Promise.resolve([]),
  ]);

  log(`  CC: ${ccScores.length} sessions | Telegram: ${tgScores.length} conversations`);

  const allScores = [...ccScores, ...tgScores];
  if (allScores.length > 0) await saveScores(allScores);

  return allScores;
}

export async function analyze(): Promise<string> {
  const allRows = await loadAllScores();
  log(`Loaded ${allRows.length} scored interactions`);
  if (allRows.length === 0) return "";

  const markdown = generatePatterns(allRows);

  const configDir = join(PROJECT_DIR, "config");
  if (!existsSync(configDir)) mkdirSync(configDir, { recursive: true });
  await atomicWriteFile(PATTERNS_PATH, markdown);
  log(`Written ${PATTERNS_PATH}`);

  return markdown;
}

export async function getWeeklySummaryMessage(): Promise<string | null> {
  const allRows = await loadAllScores();
  const now = new Date();
  const thisWeek = allRows.filter(r => (now.getTime() - new Date(r.date).getTime()) < 7 * 24 * 60 * 60 * 1000);
  const prevWeek = allRows.filter(r => { const age = now.getTime() - new Date(r.date).getTime(); return age >= 7 * 24 * 60 * 60 * 1000 && age < 14 * 24 * 60 * 60 * 1000; });
  if (thisWeek.length === 0) return null;

  const stats = computeStats(thisWeek);
  const prevStats = computeStats(prevWeek);
  const delta = prevStats.count > 0 ? stats.avgScore - prevStats.avgScore : 0;

  const byFocus = groupBy(thisWeek, r => r.sessionFocus);
  const ranked = [...byFocus.entries()].map(([f, rows]) => ({ f, ...computeStats(rows) })).sort((a, b) => b.avgScore - a.avgScore);

  let msg = `📊 ${BRAND.name} Weekly\n\nAvg: ${stats.avgScore}`;
  if (prevStats.count > 0) msg += ` (${delta > 0 ? "+" : ""}${delta})`;
  msg += ` | ${stats.count} interactions | ${stats.excellentCount} excellent | ${stats.correctionTotal} corrections`;
  if (ranked.length > 0) msg += `\n💪 ${ranked[0].f} (${ranked[0].avgScore})`;
  const worst = ranked[ranked.length - 1];
  if (worst && worst.avgScore < 50 && worst.f !== ranked[0]?.f) msg += `\n⚠️ ${worst.f} (${worst.avgScore})`;

  return msg;
}
