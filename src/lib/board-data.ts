import { AsyncLocalStorage } from "node:async_hooks";
import { supabaseHeaders } from "./supabase-keys";
const fetchContext = new AsyncLocalStorage<AbortSignal>();
const scopedFetch: typeof fetch = Object.assign((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, { ...init, signal: fetchContext.getStore() || init?.signal }), { preconnect: fetch.preconnect });
/**
 * Board Meeting Data Injection
 *
 * Gathers live data from the user's own sources (calendar, goals, Notion
 * tasks, email, AI news, content pipeline, transactions) and formats it
 * per-agent for informed board meeting discussions. Each source is only
 * queried when its env vars are set.
 *
 * Called once before the agent loop — all sources fetched in parallel.
 * Every source is wrapped in fetchWithTimeout — no source failure blocks the meeting.
 */

import {
  isGoogleAuthAvailable,
  getGoogleAccessToken,
} from "./data-sources/google-auth";

// ============================================================
// Types
// ============================================================

export interface BoardData {
  agentData: Record<string, string>;
  sharedSummary: string;
  fetchDurationMs: number;
  errors: string[];
}

interface SharedData {
  calendar: CalendarEvent[] | null;
  goals: string[] | null;
  tasks: TaskItem[] | null;
  emails: EmailItem[] | null;
  news: string[] | null;
  contentPipeline: ContentItem[] | null;
  transactions: TransactionItem[] | null;
}

interface CalendarEvent {
  summary: string;
  start: string;
  end: string;
  allDay: boolean;
}

interface TaskItem {
  title: string;
  due: string;
  status: string;
  isOverdue: boolean;
}

interface EmailItem {
  from: string;
  subject: string;
}

interface ContentItem {
  title: string;
  status: string;
}

interface TransactionItem {
  title: string;
  amount: string;
  date: string;
}

// ============================================================
// Fetch Utilities
// ============================================================

async function fetchWithTimeout<T>(
  name: string,
  fn: () => Promise<T>,
  timeoutMs: number = 5000
): Promise<{ data: T | null; error: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error(`${name} timed out`)), timeoutMs);
  try {
    const result = await fetchContext.run(controller.signal, fn);
    return { data: result, error: null };
  } catch (err: any) {
    console.warn(`[BoardData] ${name} failed: ${err.message}`);
    return { data: null, error: name };
  } finally { clearTimeout(timer); }
}

// ============================================================
// Data Fetchers
// ============================================================

async function fetchCalendar(): Promise<CalendarEvent[] | null> {
  if (!isGoogleAuthAvailable()) return null;

  const token = await getGoogleAccessToken();
  const endDate = new Date(Date.now() + 3 * 86400000);

  const params = new URLSearchParams({
    timeMin: new Date().toISOString(),
    timeMax: endDate.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "20",
  });

  const res = await scopedFetch(
    `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) throw new Error(`Calendar API: ${res.status}`);

  const data = await res.json();
  return (data.items || []).map((e: any) => ({
    summary: e.summary || "(no title)",
    start: e.start?.dateTime || e.start?.date || "",
    end: e.end?.dateTime || e.end?.date || "",
    allDay: !!e.start?.date,
  }));
}

async function fetchGoals(): Promise<string[] | null> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) return null;

  const res = await scopedFetch(
    `${supabaseUrl}/rest/v1/memory?type=eq.goal&select=content,metadata&order=created_at.desc&limit=5`,
    {
      headers: supabaseHeaders(supabaseKey),
    }
  );

  if (!res.ok) throw new Error(`Supabase goals: ${res.status}`);

  const data = await res.json();
  return data.map((g: any) => {
    const deadline = g.metadata?.deadline
      ? ` (deadline: ${g.metadata.deadline})`
      : "";
    return `${g.content}${deadline}`;
  });
}

async function fetchNotionTasks(): Promise<TaskItem[] | null> {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_DATABASE_ID;
  if (!token || !dbId) return null;

  const today = new Date().toISOString().split("T")[0];

  const res = await scopedFetch(
    `https://api.notion.com/v1/databases/${dbId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          or: [
            {
              and: [
                { property: "Due", date: { on_or_before: today } },
                { property: "Status", status: { does_not_equal: "Done" } },
              ],
            },
            {
              property: "Status",
              status: { equals: "In progress" },
            },
          ],
        },
        sorts: [{ property: "Due", direction: "ascending" }],
        page_size: 15,
      }),
    }
  );

  if (!res.ok) throw new Error(`Notion tasks: ${res.status}`);

  const data = await res.json();
  return (data.results || []).map((page: any) => {
    const title = extractNotionTitle(page);
    const due = page.properties?.Due?.date?.start || "";
    const status = page.properties?.Status?.status?.name || "";
    return { title, due, status, isOverdue: !!(due && due < today) };
  });
}

async function fetchEmails(): Promise<EmailItem[] | null> {
  if (!isGoogleAuthAvailable()) return null;

  const token = await getGoogleAccessToken();

  const res = await scopedFetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/messages?q=is:unread+in:inbox&maxResults=5",
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!res.ok) throw new Error(`Gmail API: ${res.status}`);

  const data = await res.json();
  const messageIds: string[] =
    data.messages?.map((m: any) => m.id).slice(0, 5) || [];

  if (messageIds.length === 0) return [];

  const emails = await Promise.all(
    messageIds.map(async (id) => {
      try {
        const msgRes = await scopedFetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!msgRes.ok) return null;
        const msg = await msgRes.json();
        const headers = msg.payload?.headers || [];
        const subject =
          headers.find((h: any) => h.name === "Subject")?.value ||
          "(no subject)";
        const from =
          headers.find((h: any) => h.name === "From")?.value || "";
        const fromName = from.replace(/<.*>/, "").trim() || from;
        return { from: fromName, subject };
      } catch {
        return null;
      }
    })
  );

  return emails.filter(Boolean) as EmailItem[];
}

async function fetchAINews(): Promise<string[] | null> {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) return null;

  const res = await scopedFetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "grok-3-mini-fast",
      messages: [
        {
          role: "system",
          content:
            "Return 3-5 bullet points about the most important AI news from the last 24 hours. Each bullet: one sentence with source. Format: • [news] (source). No headers.",
        },
        { role: "user", content: "Top AI news today?" },
      ],
      max_tokens: 300,
      temperature: 0,
      search_mode: "on",
    }),
  });

  if (!res.ok) throw new Error(`Grok API: ${res.status}`);

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) return null;

  return content
    .split("\n")
    .map((l: string) => l.trim())
    .filter((l: string) => l.length > 0);
}

async function fetchContentPipeline(): Promise<ContentItem[] | null> {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_CONTENT_PIPELINE_DB;
  if (!token || !dbId) return null;

  const res = await scopedFetch(
    `https://api.notion.com/v1/databases/${dbId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          property: "Status",
          status: { does_not_equal: "Published" },
        },
        sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
        page_size: 10,
      }),
    }
  );

  if (!res.ok) throw new Error(`Notion content pipeline: ${res.status}`);

  const data = await res.json();
  return (data.results || []).map((page: any) => ({
    title: extractNotionTitle(page),
    status: page.properties?.Status?.status?.name || "Unknown",
  }));
}

async function fetchTransactions(): Promise<TransactionItem[] | null> {
  const token = process.env.NOTION_TOKEN;
  const dbId = process.env.NOTION_TRANSACTIONS_DB;
  if (!token || !dbId) return null;

  const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000)
    .toISOString()
    .split("T")[0];

  const res = await scopedFetch(
    `https://api.notion.com/v1/databases/${dbId}/query`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        filter: {
          property: "Date",
          date: { on_or_after: thirtyDaysAgo },
        },
        sorts: [{ property: "Date", direction: "descending" }],
        page_size: 10,
      }),
    }
  );

  if (!res.ok) throw new Error(`Notion transactions: ${res.status}`);

  const data = await res.json();
  return (data.results || []).map((page: any) => ({
    title: extractNotionTitle(page),
    amount: extractNotionNumber(page, "Amount") || "",
    date: page.properties?.Date?.date?.start || "",
  }));
}

// ============================================================
// Notion Helpers
// ============================================================

function extractNotionTitle(page: any): string {
  const props = page.properties || {};
  for (const key of Object.keys(props)) {
    const prop = props[key];
    if (prop.type === "title" && prop.title?.length > 0) {
      return prop.title.map((t: any) => t.plain_text).join("");
    }
  }
  return "(untitled)";
}

function extractNotionNumber(page: any, name: string): string | null {
  const prop = page.properties?.[name];
  if (!prop) return null;
  if (prop.type === "number" && prop.number != null)
    return prop.number.toString();
  if (prop.type === "rich_text")
    return (
      prop.rich_text?.map((t: any) => t.plain_text).join("") || null
    );
  return null;
}

// ============================================================
// Per-Agent Formatters
// ============================================================

function formatResearchData(d: SharedData): string {
  const sections: string[] = ["## LIVE DATA FOR THIS MEETING\n"];

  if (d.news?.length) {
    sections.push("### AI News (Last 24h)");
    sections.push(d.news.join("\n"));
  }

  if (d.emails?.length) {
    sections.push("\n### Recent Unread Emails");
    d.emails.forEach((e) => sections.push(`• ${e.from}: ${e.subject}`));
  }

  return sections.length > 1 ? sections.join("\n") : "";
}

function formatContentData(d: SharedData): string {
  const sections: string[] = ["## LIVE DATA FOR THIS MEETING\n"];

  if (d.contentPipeline?.length) {
    sections.push("### Content Pipeline");
    d.contentPipeline.forEach((c) =>
      sections.push(`• [${c.status}] ${c.title}`)
    );
  }

  return sections.length > 1 ? sections.join("\n") : "";
}

function formatFinanceData(d: SharedData): string {
  const sections: string[] = ["## LIVE DATA FOR THIS MEETING\n"];

  if (d.transactions?.length) {
    sections.push("### Recent Transactions (30d)");
    d.transactions.forEach((t) =>
      sections.push(
        `• ${t.date}: ${t.title} ${t.amount ? `— $${t.amount}` : ""}`
      )
    );
  }

  if (d.emails?.length) {
    const costEmails = d.emails.filter((e) =>
      /invoice|receipt|payment|billing|subscription|charge/i.test(e.subject)
    );
    if (costEmails.length) {
      sections.push("\n### Cost-Related Emails");
      costEmails.forEach((e) =>
        sections.push(`• ${e.from}: ${e.subject}`)
      );
    }
  }

  return sections.length > 1 ? sections.join("\n") : "";
}

function formatStrategyData(d: SharedData): string {
  const sections: string[] = ["## LIVE DATA FOR THIS MEETING\n"];

  if (d.goals?.length) {
    sections.push("### Active Goals");
    d.goals.forEach((g) => sections.push(`• ${g}`));
  }

  if (d.calendar?.length) {
    sections.push("\n### Calendar (Today + 3 Days)");
    const tz = process.env.USER_TIMEZONE || "UTC";
    d.calendar.forEach((e) => {
      if (e.allDay) {
        sections.push(`• 📌 ${e.summary} (all day)`);
      } else {
        const time = new Date(e.start).toLocaleTimeString("en-US", {
          timeZone: tz,
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
        sections.push(`• ${time} — ${e.summary}`);
      }
    });
  }

  if (d.news?.length) {
    sections.push("\n### Top AI News");
    d.news.slice(0, 3).forEach((n) => sections.push(n));
  }

  return sections.length > 1 ? sections.join("\n") : "";
}

function formatCOOData(d: SharedData): string {
  const sections: string[] = ["## LIVE DATA FOR THIS MEETING\n"];

  if (d.tasks?.length) {
    const overdue = d.tasks.filter((t) => t.isOverdue);
    const inProgress = d.tasks.filter((t) => t.status === "In progress");

    if (overdue.length) {
      sections.push(`### ⚠️ OVERDUE TASKS (${overdue.length})`);
      overdue.forEach((t) =>
        sections.push(`• ${t.title} (due: ${t.due})`)
      );
    }
    if (inProgress.length) {
      sections.push("\n### In Progress");
      inProgress.forEach((t) =>
        sections.push(`• ${t.title}${t.due ? ` (due: ${t.due})` : ""}`)
      );
    }
  } else {
    sections.push("### Tasks\nNo task data available.");
  }

  if (d.calendar?.length) {
    sections.push("\n### Today's Calendar");
    const tz = process.env.USER_TIMEZONE || "UTC";
    const todayStr = new Date().toISOString().split("T")[0];
    const todayEvents = d.calendar.filter((e) => {
      const eventDate = e.allDay ? e.start : e.start.split("T")[0];
      return eventDate === todayStr;
    });
    if (todayEvents.length) {
      todayEvents.forEach((e) => {
        if (e.allDay) {
          sections.push(`• 📌 ${e.summary} (all day)`);
        } else {
          const time = new Date(e.start).toLocaleTimeString("en-US", {
            timeZone: tz,
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
          });
          sections.push(`• ${time} — ${e.summary}`);
        }
      });
    } else {
      sections.push("No events today.");
    }
  }

  if (d.emails?.length) {
    sections.push("\n### Unread Emails");
    d.emails.forEach((e) =>
      sections.push(`• ${e.from}: ${e.subject}`)
    );
  }

  return sections.length > 1 ? sections.join("\n") : "";
}

function formatCriticData(d: SharedData): string {
  const sections: string[] = ["## LIVE DATA FOR THIS MEETING\n"];

  sections.push("### Risk Indicators");
  const overdueTasks = d.tasks?.filter((t) => t.isOverdue) || [];
  sections.push(`• Overdue tasks: ${overdueTasks.length}`);
  sections.push(`• Unread emails: ${d.emails?.length ?? "unknown"}`);

  return sections.join("\n");
}

// ============================================================
// Main Entry Point
// ============================================================

export async function gatherBoardData(): Promise<BoardData> {
  const start = Date.now();
  const errors: string[] = [];

  const [
    calendarResult,
    goalsResult,
    tasksResult,
    emailsResult,
    newsResult,
    contentResult,
    transactionsResult,
  ] = await Promise.all([
    fetchWithTimeout("calendar", fetchCalendar, 5000),
    fetchWithTimeout("goals", fetchGoals, 5000),
    fetchWithTimeout("tasks", fetchNotionTasks, 5000),
    fetchWithTimeout("emails", fetchEmails, 5000),
    fetchWithTimeout("news", fetchAINews, 10000),
    fetchWithTimeout("content-pipeline", fetchContentPipeline, 5000),
    fetchWithTimeout("transactions", fetchTransactions, 5000),
  ]);

  for (const r of [
    calendarResult,
    goalsResult,
    tasksResult,
    emailsResult,
    newsResult,
    contentResult,
    transactionsResult,
  ]) {
    if (r.error) errors.push(r.error);
  }

  const shared: SharedData = {
    calendar: calendarResult.data,
    goals: goalsResult.data,
    tasks: tasksResult.data,
    emails: emailsResult.data,
    news: newsResult.data,
    contentPipeline: contentResult.data,
    transactions: transactionsResult.data,
  };

  // cto hat keine eigene Quelle mehr (früher GitHub-Abfrage fremder Repos)
  const agentData: Record<string, string> = {
    research: formatResearchData(shared),
    content: formatContentData(shared),
    finance: formatFinanceData(shared),
    strategy: formatStrategyData(shared),
    coo: formatCOOData(shared),
    critic: formatCriticData(shared),
  };

  // Shared summary for synthesis prompt
  const summaryParts: string[] = [];
  const overdue = shared.tasks?.filter((t) => t.isOverdue) || [];
  if (overdue.length)
    summaryParts.push(`⚠️ ${overdue.length} overdue tasks`);

  return {
    agentData,
    sharedSummary: summaryParts.join("\n"),
    fetchDurationMs: Date.now() - start,
    errors,
  };
}
