/**
 * Issue #134, Schritt 3: echtes gatherBoardData() ohne Tabelle mit
 * Geschäftszahlen und ohne GitHub-Abfrage fremder Repos. fetch ist eine
 * Attrappe, die jede Adresse aufzeichnet; die Umgebung wird je Test gesetzt
 * und danach wiederhergestellt. Für die ganze Sitzung sind Modell und
 * Speicher Attrappen.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { gatherBoardData } from "../src/lib/board-data";
import { runBoardMeeting, type BoardOutput } from "../src/lib/board-meeting";
import { stripInvocationTags } from "../src/lib/cross-agent";

const VARS = [
  "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN",
  "SUPABASE_URL", "SUPABASE_ANON_KEY",
  "NOTION_TOKEN", "NOTION_DATABASE_ID", "NOTION_CONTENT_PIPELINE_DB", "NOTION_TRANSACTIONS_DB",
  "XAI_API_KEY", "METRICS_SHEET_ID", "GITHUB_TOKEN", "USER_TIMEZONE",
];

let savedEnv: Record<string, string | undefined>;
let realFetch: typeof fetch;
let urls: string[];

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
const today = new Date().toISOString().split("T")[0];

/** Antworten der erlaubten Quellen; unbekannte Adressen scheitern laut */
function respond(url: string): Response {
  if (url.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "attrappe", expires_in: 3600 });
  if (url.startsWith("https://www.googleapis.com/calendar/")) return json({ items: [{ summary: "Zahnarzt", start: { date: today }, end: { date: today } }] });
  if (url.startsWith("https://supabase.test/rest/v1/memory")) return json([{ content: "Buch fertig schreiben", metadata: { deadline: "2026-12-01" } }]);
  if (url === "https://api.notion.com/v1/databases/db-tasks/query")
    return json({ results: [{ properties: { Name: { type: "title", title: [{ plain_text: "Steuer abgeben" }] }, Due: { date: { start: "2026-01-01" } }, Status: { status: { name: "Not started" } } } }] });
  if (url === "https://api.notion.com/v1/databases/db-content/query")
    return json({ results: [{ properties: { Name: { type: "title", title: [{ plain_text: "Video Folge 3" }] }, Status: { status: { name: "Draft" } } } }] });
  if (url === "https://api.notion.com/v1/databases/db-tx/query")
    return json({ results: [{ properties: { Name: { type: "title", title: [{ plain_text: "Hosting" }] }, Amount: { type: "number", number: 12 }, Date: { date: { start: today } } } }] });
  if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) return json({ messages: [{ id: "m1" }] });
  if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages/m1"))
    return json({ payload: { headers: [{ name: "Subject", value: "Invoice September" }, { name: "From", value: "Shop <shop@example.com>" }] } });
  if (url === "https://api.x.ai/v1/chat/completions") return json({ choices: [{ message: { content: "• Neues Modell erschienen (Quelle)" } }] });
  throw new Error(`unerwartete Abfrage: ${url}`);
}

beforeEach(() => {
  savedEnv = Object.fromEntries(VARS.map(k => [k, process.env[k]]));
  for (const k of VARS) delete process.env[k];
  realFetch = globalThis.fetch;
  urls = [];
  globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    urls.push(url);
    return respond(url);
  }, { preconnect: realFetch.preconnect }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of VARS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function configureAllSources() {
  Object.assign(process.env, {
    GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret", GOOGLE_REFRESH_TOKEN: "refresh",
    SUPABASE_URL: "https://supabase.test", SUPABASE_ANON_KEY: "anon",
    NOTION_TOKEN: "notion", NOTION_DATABASE_ID: "db-tasks", NOTION_CONTENT_PIPELINE_DB: "db-content", NOTION_TRANSACTIONS_DB: "db-tx",
    XAI_API_KEY: "xai", USER_TIMEZONE: "Europe/Berlin",
  });
}

const forbidden = () => urls.filter(u => /sheets\.googleapis\.com|api\.github\.com/.test(u));

describe("gatherBoardData", () => {
  test("ohne METRICS_SHEET_ID, ohne GitHub-Token und ohne Quellen: keine Abfrage, kein Fehler", async () => {
    const data = await gatherBoardData();
    expect(urls).toEqual([]);
    expect(data.errors).toEqual([]);
    expect(data.sharedSummary).toBe("");
    expect(Object.keys(data.agentData).sort()).toEqual(["content", "coo", "critic", "finance", "research", "strategy"]);
    expect(data.agentData.critic).toBe("## LIVE DATA FOR THIS MEETING\n\n### Risk Indicators\n• Overdue tasks: 0\n• Unread emails: unknown");
  });

  test("alle übrigen Quellen erscheinen in den Ausgaben; Tabelle und GitHub werden auch mit Variablen nie abgefragt", async () => {
    configureAllSources();
    process.env.METRICS_SHEET_ID = "irgendeine-tabelle";
    process.env.GITHUB_TOKEN = "gh-attrappe";
    const data = await gatherBoardData();
    expect(data.errors).toEqual([]);
    expect(forbidden()).toEqual([]);
    expect(data.agentData.research).toContain("• Neues Modell erschienen (Quelle)");
    expect(data.agentData.research).toContain("• Shop: Invoice September");
    expect(data.agentData.content).toContain("• [Draft] Video Folge 3");
    expect(data.agentData.finance).toContain(`• ${today}: Hosting — $12`);
    expect(data.agentData.finance).toContain("### Cost-Related Emails");
    expect(data.agentData.strategy).toContain("• Buch fertig schreiben (deadline: 2026-12-01)");
    expect(data.agentData.strategy).toContain("• 📌 Zahnarzt (all day)");
    expect(data.agentData.coo).toContain("• Steuer abgeben (due: 2026-01-01)");
    expect(data.agentData.critic).toContain("• Overdue tasks: 1");
    expect(data.agentData.critic).toContain("• Unread emails: 1");
    expect(data.sharedSummary).toBe("⚠️ 1 overdue tasks");
    for (const text of [...Object.values(data.agentData), data.sharedSummary]) expect(text).not.toMatch(/MRR|YouTube|GitHub|Rank|members/i);
  });

  test("eine scheiternde Quelle blockiert die übrigen nicht", async () => {
    configureAllSources();
    const ok = globalThis.fetch;
    globalThis.fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      if (url.startsWith("https://api.x.ai/")) {
        urls.push(url);
        return new Response("kaputt", { status: 500 });
      }
      return ok(input, init);
    }, { preconnect: realFetch.preconnect }) as typeof fetch;
    const data = await gatherBoardData();
    expect(data.errors).toEqual(["news"]);
    expect(data.agentData.coo).toContain("Steuer abgeben");
  });
});

describe("/board-Sitzung mit echter Datensammlung", () => {
  test("ohne METRICS_SHEET_ID und ohne GitHub-Token läuft die Sitzung ohne Fehler durch", async () => {
    const prompts: { agent: string; prompt: string }[] = [];
    const saved: string[] = [];
    const ended: { result: unknown; message: string | null }[] = [];
    const contributions: string[] = [];
    const output: BoardOutput = {
      start: async () => {},
      thinking: async () => {},
      contribution: async c => void contributions.push(c.agent),
      failed: async agent => void contributions.push(`fehlgeschlagen ${agent}`),
      end: async (result, message) => void ended.push({ result, message }),
    };
    let n = 0;
    const result = await runBoardMeeting(
      {
        agents: () => ["research", "finance", "critic"],
        gatherData: gatherBoardData,
        callAgent: async (prompt, agent) => {
          prompts.push({ agent, prompt });
          return { text: agent === "general" ? "Zusammenfassung" : `Beitrag ${agent}` };
        },
        stripInvocationTags,
        save: async m => {
          saved.push(m.content);
          return true;
        },
        newMessageId: () => `id-${++n}`,
        pauseMs: 0,
        log: () => {},
      },
      { sessionKey: "topic:-100:9" },
      output,
    );
    expect(urls).toEqual([]);
    expect(result).toEqual({ contributions: 3, synthesis: true, stopped: false, aborted: false, empty: false });
    expect(contributions).toEqual(["research", "finance", "critic", "general"]);
    expect(prompts.map(p => p.agent)).toEqual(["research", "finance", "critic", "general"]);
    expect(prompts.find(p => p.agent === "critic")!.prompt).toContain("• Overdue tasks: 0");
    expect(prompts.find(p => p.agent === "general")!.prompt).not.toContain("CURRENT METRICS SNAPSHOT");
    expect(saved.length).toBeGreaterThan(0);
  });
});
