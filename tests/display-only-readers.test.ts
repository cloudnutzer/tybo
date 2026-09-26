/**
 * Issue #45: Nur-Anzeige-Einträge (metadata.display_only = true) erscheinen
 * in keinem Kontext-Leser, aber weiter im WebUI-Verlauf. Echter
 * supabase-js-Client gegen eine fetch-Attrappe (tests/supabase-fixture.ts):
 * geprüft werden der Filter in der Abfrage (vor dem Limit) und das Ergebnis.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { ConvexHttpClient } from "convex/browser";
import {
  NOT_DISPLAY_ONLY_FILTER,
  getBoardMeetingContext,
  getConversationContext,
  getConversationHistory,
  getRecentMessages,
  getTopicActivity,
  isDisplayOnly,
  searchMessages,
} from "../src/lib/supabase";
import { getFunctionName } from "convex/server";
import * as supabaseModule from "../src/lib/supabase";
import * as facade from "../src/lib/convex";
import { buildPromptContext, buildResumePrompt } from "../src/lib/prompt-builder";
import { migrateMessages } from "../scripts/migrate-to-convex";
import { getBuiltinTool } from "../src/lib/tools/registry";
import "../src/lib/tools/history-search";
import { useFakeSupabase, type FakeRequest } from "./supabase-fixture";
import { isolateAgentCatalog } from "./catalog-fixture";

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

  test("Edge-Function search-memory: Textsuche filtert vor dem Limit", () => {
    const source = readFileSync(join(import.meta.dir, "../supabase/functions/search-memory/index.ts"), "utf8");
    const fallback = source.slice(source.indexOf("// Fallback: basic text search"));
    const filterAt = fallback.indexOf(`.or("${NOT_DISPLAY_ONLY_FILTER}")`);
    expect(filterAt).toBeGreaterThan(-1);
    expect(filterAt).toBeLessThan(fallback.indexOf(".limit(limit)"));
  });

  test("getBoardMeetingContext: Filter in der Abfrage, Meldung fehlt", async () => {
    const f = fake();
    const context = await getBoardMeetingContext(7);
    expectFiltered(messageReads(f.requests)[0]);
    expect(context).not.toContain(MELDUNG);
    expect(context).toContain("Frage ohne metadata");
  });

  test("Fassade convex.ts reicht die gefilterten Ergebnisse durch", async () => {
    fake();
    expectVisible((await facade.getRecentMessages(USER, 20, null)).map(m => m.content));
    expectVisible((await facade.searchMessages(USER, "Issue", 5)).map(m => m.content));
    expect(await facade.getBoardMeetingContext(7)).not.toContain(MELDUNG);
  });
});

describe("Convex: Nur-Anzeige-Einträge kommen gar nicht erst in den Speicher", () => {
  // Das Convex-Backend begrenzt serverseitig (take, Suchindex) und kennt
  // keinen display_only-Filter. Statt nach dem Limit zu filtern, gilt die
  // Regel beim Schreiben. Die Tests schreiben über die echten Wege in eine
  // Attrappe mit den Limits von convex/messages.ts und lesen dann über die
  // unveränderten Convex-Leser.
  const CHAT_B = "-1009876543210";
  const ECHT_B = "Echter Beitrag in Chat B";

  /** Speicher-Attrappe: Mutationen schreiben, Abfragen begrenzen wie das Backend */
  function convexStore(readLimit = 4000) {
    const saved = {
      CONVEX_URL: process.env.CONVEX_URL,
      CONVEX_AUTH_TOKEN: process.env.CONVEX_AUTH_TOKEN,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY,
      TELEGRAM_USER_ID: process.env.TELEGRAM_USER_ID,
      TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
      TELEGRAM_GROUP_ID: process.env.TELEGRAM_GROUP_ID,
    };
    process.env.CONVEX_URL = "https://example.convex.cloud";
    process.env.CONVEX_AUTH_TOKEN = "test-convex-token";
    delete process.env.OPENAI_API_KEY;
    // Chat B steht in keiner Umgebungsvariablen
    process.env.TELEGRAM_USER_ID = USER;
    delete process.env.TELEGRAM_CHAT_ID;
    delete process.env.TELEGRAM_GROUP_ID;
    facade.resetConvexClient();
    const docs: any[] = [];
    let seq = 0;
    const newestFirst = () => [...docs].sort((a, b) => b.createdAt - a.createdAt || b.seq - a.seq);
    const mutation = spyOn(ConvexHttpClient.prototype, "mutation").mockImplementation((async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      if (name !== "messages:insert" && name !== "migrations:insertMessage") throw new Error(`unerwartete Mutation ${name}`);
      const doc = { _id: `m${seq}`, seq: seq++, ...args, createdAt: args.createdAt ?? Date.now() };
      docs.push(doc);
      return doc._id;
    }) as any);
    const query = spyOn(ConvexHttpClient.prototype, "query").mockImplementation((async (ref: any, args: any) => {
      const name = getFunctionName(ref);
      if (name === "messages:getRecent") {
        const pool = newestFirst().filter(d => (args.sessionKey ? d.sessionKey === args.sessionKey : d.chatId === args.chatId));
        return pool.slice(0, args.limit ?? 20).reverse();
      }
      if (name === "messages:getBoardMeetingContext") {
        const limit = args.limit ?? 100;
        // Wie ein Convex-Leselimit: zu große Abfragen scheitern
        if (limit > readLimit) throw new Error("Too many documents read");
        const since = Date.now() - (args.days ?? 7) * 24 * 60 * 60 * 1000;
        return newestFirst().filter(d => d.createdAt >= since).slice(0, limit);
      }
      if (name === "messages:textSearch") {
        const hits = newestFirst().filter(d => d.chatId === args.chatId && d.content.includes(args.query));
        return hits.slice(0, Math.max(1, Math.min(args.limit ?? 10, 50)));
      }
      if (name === "messages:getByChat") {
        const pool = newestFirst().filter(d => d.chatId === args.chatId);
        const start = Number(args.paginationOpts.cursor ?? 0);
        const end = start + args.paginationOpts.numItems;
        return { page: pool.slice(start, end), isDone: end >= pool.length, continueCursor: String(end) };
      }
      if (name === "messages:getById") return docs.find(d => d._id === args.id) ?? null;
      throw new Error(`unerwartete Abfrage ${name}`);
    }) as any);
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const action = spyOn(ConvexHttpClient.prototype, "action").mockImplementation((async (ref: any) => {
      const name = getFunctionName(ref);
      if (name === "embeddings:generateMessageEmbedding") return null;
      if (name === "messages:semanticSearch") return [];
      throw new Error(`unerwartete Aktion ${name}`);
    }) as any);
    cleanups.push(() => {
      mutation.mockRestore();
      query.mockRestore();
      action.mockRestore();
      warn.mockRestore();
      facade.resetConvexClient();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    return { docs, mutation };
  }

  function meldung(i: number, chatId = USER) {
    return { chat_id: chatId, role: "assistant" as const, content: `${MELDUNG} ${i}`, metadata: { display_only: true, source: "pipeline" } };
  }

  test("saveMessage mit display_only schreibt unter Convex nichts und meldet false", async () => {
    const { docs, mutation } = convexStore();
    expect(await facade.saveMessage(meldung(0))).toBe(false);
    expect(await facade.saveDisplayOnlyMessage(meldung(1))).toBe(false);
    expect(mutation).not.toHaveBeenCalled();
    expect(docs).toEqual([]);
    // Echte Beiträge (auch display_only: false) landen weiter im Speicher
    expect(await facade.saveMessage({ chat_id: USER, role: "user", content: "echt", metadata: { display_only: false } })).toBe(true);
    expect(docs.map(d => d.content)).toEqual(["echt"]);
  });

  test("Board-Kontext: echter Beitrag in unbekanntem Chat B bleibt hinter 4010 Meldungen in Chat A erhalten, auch mit Leselimit 4000", async () => {
    const { docs } = convexStore(4000);
    expect(await facade.saveMessage({ chat_id: CHAT_B, role: "user", content: ECHT_B, metadata: { topicId: 7 } })).toBe(true);
    for (let i = 0; i < 4010; i++) await facade.saveMessage(meldung(i));
    expect(docs.some(d => isDisplayOnly(d.metadata))).toBe(false);
    const context = await facade.getBoardMeetingContext(7);
    expect(context).toContain(ECHT_B);
    expect(context).not.toContain(MELDUNG);
  });

  test("getRecentMessages: mehr Meldungen als Limit verdrängen die älteren echten Beiträge nicht", async () => {
    convexStore();
    for (const content of ["Echt 1", "Echt 2", "Echt 3"]) await facade.saveMessage({ chat_id: USER, role: "user", content });
    for (let i = 0; i < 6; i++) await facade.saveMessage(meldung(i));
    expect((await facade.getRecentMessages(USER, 5, null)).map(m => m.content)).toEqual(["Echt 1", "Echt 2", "Echt 3"]);
    const context = await facade.getConversationContext(USER, 5, null);
    expect(context).toContain("Echt 1");
    expect(context).not.toContain(MELDUNG);
  });

  test("searchMessages ohne Embedding: 60 passende Meldungen über der Textsuch-Grenze 50 verdrängen den echten Treffer nicht", async () => {
    const embedding = spyOn(supabaseModule, "generateEmbedding").mockResolvedValue(null);
    cleanups.push(() => embedding.mockRestore());
    convexStore();
    await facade.saveMessage({ chat_id: USER, role: "user", content: "Alte Frage zu Issue 45" });
    for (let i = 0; i < 60; i++) await facade.saveMessage({ ...meldung(i), content: `Issue ${MELDUNG} ${i}` });
    expect((await facade.searchMessages(USER, "Issue", 3)).map(m => m.content)).toEqual(["Alte Frage zu Issue 45"]);
  });

  test("Migration Supabase nach Convex überspringt Nur-Anzeige-Einträge", async () => {
    const source = [
      { chat_id: USER, role: "user", content: "echt", metadata: {}, created_at: NOW },
      { chat_id: USER, role: "assistant", content: MELDUNG, metadata: { display_only: true, source: "pipeline" }, created_at: NOW },
      { chat_id: USER, role: "assistant", content: "Antwort", metadata: null, created_at: NOW },
    ];
    const supabase = {
      from: () => ({ select: () => ({ range: (from: number, to: number) => ({ order: async () => ({ data: source.slice(from, to + 1), error: null }) }) }) }),
    } as any;
    const inserted: any[] = [];
    const convex = { mutation: async (_ref: unknown, item: any) => void inserted.push(item) } as any;
    const log = spyOn(console, "log").mockImplementation(() => {});
    cleanups.push(() => log.mockRestore());
    const result = await migrateMessages(supabase, convex, false);
    expect(inserted.map(item => item.content)).toEqual(["echt", "Antwort"]);
    expect(result.inserted).toBe(2);
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
