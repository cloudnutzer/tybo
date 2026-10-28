/**
 * Issue #45: Nur-Anzeige-Einträge (metadata.display_only = true) erscheinen
 * in keinem Kontext-Leser, aber weiter im WebUI-Verlauf. Echter
 * supabase-js-Client gegen eine fetch-Attrappe (tests/supabase-fixture.ts):
 * geprüft werden der Filter in der Abfrage (vor dem Limit) und das Ergebnis.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { isDisplayOnly } from "../src/lib/store/message-rules";
import { NOT_DISPLAY_ONLY_FILTER } from "../src/lib/store/supabase/messages";
import { formatConversationContext, loadBoardContext } from "../src/lib/conversation-context";
import { getStore } from "../src/lib/store";
import { buildPromptContext, buildResumePrompt } from "../src/lib/prompt-builder";
import { getBuiltinTool } from "../src/lib/tools/registry";
import "../src/lib/tools/history-search";
import { useFakeSupabase, type FakeRequest } from "./supabase-fixture";
import { isolateAgentCatalog } from "./catalog-fixture";
import {
  activityDirect as getTopicActivity,
  boardDirect as getBoardMeetingContext,
  historyDirect as getConversationHistory,
  reads,
  recentDirect as getRecentMessages,
} from "./supabase-direct";

// Supabase-Weg direkt, wie früher über src/lib/supabase.ts
const searchMessages = (chatId: string, query: string, limit: number) => reads().search(chatId, query, limit);
const getConversationContext = async (chatId: string, limit: number, topicId?: number | null) =>
  formatConversationContext(await getRecentMessages(chatId, limit, topicId));

// buildPromptContext liest den Agenten-Katalog (Issue #49): nie die echte config/agents.json
isolateAgentCatalog();

const USER = "4711";
const NOW = "2026-09-24T10:00:00.000Z";
const MELDUNG = "PIPELINE-MELDUNG Issue 45 gemergt";

/** Was die Datenbank ohne Filter liefern würde: eine Meldung zwischen echten Beiträgen */
function rows() {
  return [
    { id: 4, chat_id: USER, role: "assistant", content: MELDUNG, metadata: { display_only: true, source: "pipeline" }, created_at: NOW, session_key: `dm:${USER}` },
    { id: 3, chat_id: USER, role: "assistant", content: "Antwort mit false", metadata: { display_only: false }, created_at: NOW, session_key: `dm:${USER}` },
    { id: 2, chat_id: USER, role: "user", content: "Frage ohne metadata", metadata: null, created_at: NOW, session_key: `dm:${USER}` },
    { id: 1, chat_id: USER, role: "user", content: "Frage mit leerem metadata", metadata: {}, created_at: NOW, session_key: `dm:${USER}` },
  ];
}

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fake(edge?: (name: string) => unknown[] | undefined) {
  const f = useFakeSupabase({ rows, edge });
  cleanups.push(() => f.restore());
  return f;
}

function messageReads(requests: FakeRequest[]): URL[] {
  return requests.filter(r => r.method === "GET" && r.url.pathname === "/rest/v1/messages").map(r => r.url);
}

function expectFiltered(url: URL) {
  expect(url.searchParams.get("or")).toBe(`(${NOT_DISPLAY_ONLY_FILTER})`);
  expect(url.searchParams.has("limit")).toBe(true);
}

function expectVisible(contents: string[]) {
  expect(contents).not.toContain(MELDUNG);
  expect(contents).toContain("Antwort mit false");
  expect(contents).toContain("Frage ohne metadata");
  expect(contents).toContain("Frage mit leerem metadata");
}

test("isDisplayOnly: nur der Boolean true zählt", () => {
  expect(isDisplayOnly({ display_only: true })).toBe(true);
  for (const value of [undefined, null, {}, { display_only: false }, { display_only: "true" }, { display_only: 1 }]) {
    expect(isDisplayOnly(value)).toBe(false);
  }
});

test("Filter schließt NULL und false nicht aus", () => {
  // metadata->>display_only ist Text: NULL ohne Feld, 'false', 'true'
  expect(NOT_DISPLAY_ONLY_FILTER).toBe("metadata->>display_only.is.null,metadata->>display_only.neq.true");
});

describe("Kontext-Leser", () => {
  test("getRecentMessages: Filter in der Abfrage, Meldung fehlt im Ergebnis", async () => {
    const f = fake();
    const result = await getRecentMessages(USER, 20, null);
    const [url] = messageReads(f.requests);
    expectFiltered(url);
    expect(url.searchParams.get("session_key")).toBe(`eq.dm:${USER}`);
    expectVisible(result.map(m => m.content));
  });

  test("getRecentMessages ohne topicId (alter Pool) filtert ebenso", async () => {
    const f = fake();
    const result = await getRecentMessages(USER, 10);
    expectFiltered(messageReads(f.requests)[0]);
    expectVisible(result.map(m => m.content));
  });

  test("getConversationContext (Voll-Prompt, voice.ts, Agent-SDK) enthält die Meldung nicht", async () => {
    fake();
    const context = await getConversationContext(USER, 10, null);
    expect(context).not.toContain(MELDUNG);
    expect(context).toContain("Frage ohne metadata");
  });

  test("searchMessages Textsuche: Filter vor dem Limit, Meldung fehlt", async () => {
    const f = fake();
    const result = await searchMessages(USER, "Issue", 5);
    expect(f.requests[0].url.pathname).toBe("/functions/v1/search-memory");
    const [url] = messageReads(f.requests);
    expectFiltered(url);
    expect(url.searchParams.get("content")).toBe("ilike.%Issue%");
    expectVisible(result.map(m => m.content));
  });

  test("searchMessages semantisch: Treffer mit display_only werden verworfen", async () => {
    fake(name => (name === "search-memory" ? rows() : undefined));
    const result = await searchMessages(USER, "Issue", 5);
    expectVisible(result.map(m => m.content));
  });

  test("searchMessages: Edge-Textsuche mit mehr Meldungen als Limit verdrängt den älteren echten Treffer nicht", async () => {
    // Ältere Edge-Function: Textsuche erst begrenzt, Meldungen füllen das Limit
    const meldungen = Array.from({ length: 6 }, (_, i) => ({
      id: 100 + i, chat_id: USER, role: "assistant", content: `${MELDUNG} Nr. ${i}`,
      metadata: { display_only: true, source: "pipeline" }, created_at: NOW,
    }));
    const echt = { id: 1, chat_id: USER, role: "user", content: "Alte Frage zu Issue 45", metadata: {}, created_at: "2026-09-01T10:00:00.000Z" };
    const f = useFakeSupabase({
      rows: () => [...meldungen, echt],
      edge: name => (name === "search-memory" ? meldungen.slice(0, 5) : undefined),
    });
    cleanups.push(() => f.restore());
    const result = await searchMessages(USER, "Issue", 5);
    expect(result.map(m => m.content)).toEqual(["Alte Frage zu Issue 45"]);
    // Ersatzabfrage filtert vor dem Limit
    const [url] = messageReads(f.requests);
    expectFiltered(url);
    expect(url.searchParams.get("limit")).toBe("5");
  });

  // Edge-Function search-memory, Textsuche mit Filter vor dem Limit: als
  // Verhaltenstest in tests/edge-functions.test.ts (Issue #320)

  test("getBoardMeetingContext: Filter in der Abfrage, Meldung fehlt", async () => {
    const f = fake();
    const context = await getBoardMeetingContext(7);
    expectFiltered(messageReads(f.requests)[0]);
    expect(context).not.toContain(MELDUNG);
    expect(context).toContain("Frage ohne metadata");
  });

  test("Aufruferweg über den Store reicht die gefilterten Ergebnisse durch", async () => {
    fake();
    const store = getStore();
    expectVisible((await store.messages.recent(USER, 20, null)).map(m => m.content));
    expect(formatConversationContext(await store.messages.recent(USER, 20, null))).not.toContain(MELDUNG);
    expectVisible((await store.messages.search(USER, "Issue", 5)).map(m => m.content));
    expect(await loadBoardContext(store.messages, 7)).not.toContain(MELDUNG);
  });
});

describe("Prompt-Aufbau", () => {
  test("Voll-Prompt und Fallback-Kontext enthalten die Meldung nicht", async () => {
    fake(name => (name === "search-memory" ? rows() : undefined));
    const { fullPrompt, fallbackContext } = await buildPromptContext({
      userMessage: "Was ist mit Issue 45?",
      chatId: USER,
      agentName: "general",
    });
    expect(fullPrompt).toContain("## RECENT CONVERSATION");
    expect(fullPrompt).toContain("Frage ohne metadata");
    expect(fullPrompt).toContain("## SEMANTIC SEARCH RESULTS");
    expect(fullPrompt).not.toContain(MELDUNG);
    expect(fallbackContext).toContain("Frage ohne metadata");
    expect(fallbackContext).not.toContain(MELDUNG);
  });

  test("Resume-Prompt enthält die Meldung nicht", async () => {
    fake(name => (name === "search-memory" ? rows() : undefined));
    const prompt = await buildResumePrompt({ userMessage: "Was ist mit Issue 45?", chatId: USER });
    expect(prompt).toContain("Frage ohne metadata");
    expect(prompt).not.toContain(MELDUNG);
  });
});

describe("history_search", () => {
  test("liefert keine Meldungen", async () => {
    fake();
    const saved = process.env.TELEGRAM_USER_ID;
    process.env.TELEGRAM_USER_ID = USER;
    cleanups.push(() => {
      if (saved === undefined) delete process.env.TELEGRAM_USER_ID;
      else process.env.TELEGRAM_USER_ID = saved;
    });
    const tool = getBuiltinTool("history_search")!;
    const output = await tool.handler({ query: "Issue", limit: 15 });
    const text = typeof output === "string" ? output : JSON.stringify(output);
    expect(text).not.toContain(MELDUNG);
    expect(text).toContain("Frage ohne metadata");
  });
});

describe("WebUI-Leser liefern Meldungen weiter", () => {
  test("getConversationHistory ohne Filter, Meldung im Ergebnis", async () => {
    const f = fake();
    const history = await getConversationHistory(USER, null, { limit: 50 });
    const [url] = messageReads(f.requests);
    expect(url.searchParams.has("or")).toBe(false);
    expect(history.map(r => r.content)).toContain(MELDUNG);
    expect(history.find(r => r.content === MELDUNG)?.metadata).toEqual({ display_only: true, source: "pipeline" });
  });

  test("getTopicActivity ohne Filter", async () => {
    const f = fake();
    const activity = await getTopicActivity(USER, 60, undefined, Date.parse(NOW));
    expect(messageReads(f.requests)[0].searchParams.has("or")).toBe(false);
    expect(activity).toEqual([{ sessionKey: `dm:${USER}`, lastActivity: NOW }]);
  });
});
