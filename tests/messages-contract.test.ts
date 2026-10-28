/**
 * Issue #309: Vertrag für Nachrichten speichern und lesen über Supabase.
 * Hält fest, was über den Store passiert: Requests an Edge Function und
 * Tabelle, Rückfall, Display-only, Topic-Varianten, Ereignis nach dem
 * Speichern, Format von Gesprächs- und Board-Kontext mit fester Uhr. Seit
 * Issue #314 gibt es nur noch den Einstieg getStore().messages mit der
 * Formatierung aus conversation-context.ts (früher liefen dieselben Fälle
 * auch gegen die Fassade convex.ts und supabase.ts); kein Netz, supabase-js
 * gegen die Fetch-Attrappe.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { formatBoardContext, formatConversationContext, loadBoardContext } from "../src/lib/conversation-context";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStore, resetStore, storeOr } from "../src/lib/store";
import { boardRowsSince, insertRow, NOT_DISPLAY_ONLY_FILTER, recentRows } from "../src/lib/store/supabase/messages";
import { resetSupabaseClient } from "../src/lib/supabase";
import { resetEdgeFallbackWarning } from "../src/lib/store/supabase/edge-warning";
import { onMessageSaved, type SavedMessageEvent } from "../src/lib/store/events";
import type { Message } from "../src/lib/store/types";
import { useFakeSupabase, type FakeRequest, type FakeSupabaseOptions } from "./supabase-fixture";

const NOW = new Date("2026-10-16T12:00:00.000Z");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DM = "4711";
const GROUP = "-1009876543210";
const EDGE_PATH = "/functions/v1/store-telegram-message";
const TABLE_PATH = "/rest/v1/messages";

/** Ein Weg, Nachrichten zu speichern und zu lesen */
interface Entry {
  name: string;
  /** Speichern mit msgId und Ereignis */
  save(message: Message): Promise<boolean>;
  saveDisplayOnly(message: Message): Promise<boolean>;
  recent(chatId: string, limit: number, topicId?: number | null): Promise<Message[]>;
  context(chatId: string, limit: number, topicId?: number | null): Promise<string>;
  board(days: number): Promise<string>;
}

const ENTRIES: Entry[] = [
  {
    name: "getStore().messages",
    save: m => freshStore().messages.save(m),
    saveDisplayOnly: m => freshStore().messages.saveDisplayOnly(m),
    recent: (c, l, t) => freshStore().messages.recent(c, l, t),
    context: async (c, l, t) => formatConversationContext(await freshStore().messages.recent(c, l, t)),
    board: async d => formatBoardContext(await freshStore().messages.boardRows(d), d),
  },
];

/** Store neu wählen, damit die Umgebung der Attrappe gilt */
function freshStore() {
  resetStore();
  const store = getStore();
  expect(store.backend).toBe("supabase");
  return store;
}

const READERS: Pick<Entry, "name" | "recent" | "context" | "board">[] = ENTRIES;

const cleanups: (() => void)[] = [];
let events: SavedMessageEvent[] = [];

beforeEach(() => {
  events = [];
  resetEdgeFallbackWarning();
  cleanups.push(onMessageSaved(e => void events.push(e)));
  // Rückfall-Meldungen sind Thema von save-message-edge-fallback.test.ts
  const e = spyOn(console, "error").mockImplementation(() => {});
  const w = spyOn(console, "warn").mockImplementation(() => {});
  cleanups.push(() => e.mockRestore(), () => w.mockRestore());
});
afterEach(() => {
  setSystemTime();
  while (cleanups.length) cleanups.pop()!();
});

function fake(options: FakeSupabaseOptions = {}) {
  const f = useFakeSupabase(options);
  cleanups.push(() => f.restore());
  return f;
}

const edgeUp = { edge: () => [] } satisfies FakeSupabaseOptions;
const posts = (requests: FakeRequest[], path: string) => requests.filter(r => r.method === "POST" && r.url.pathname === path);
const reads = (requests: FakeRequest[]) => requests.filter(r => r.method === "GET" && r.url.pathname === TABLE_PATH);
const bodyOf = (r: FakeRequest) => {
  const parsed = JSON.parse(r.body);
  return Array.isArray(parsed) ? parsed[0] : parsed;
};

for (const entry of ENTRIES) {
  describe(`speichern über ${entry.name}`, () => {
    test("Edge Function zuerst, Body mit topic_id, session_key und msgId, Schlüssel in den Köpfen", async () => {
      const f = fake(edgeUp);
      const ok = await entry.save({ chat_id: GROUP, role: "user", content: "Hallo", metadata: { topicId: 77, channel: "web" } });
      expect(ok).toBe(true);
      expect(f.requests.map(r => `${r.method} ${r.url.pathname}`)).toEqual([`POST ${EDGE_PATH}`]);
      const sent = JSON.parse(f.requests[0].body);
      expect(Object.keys(sent)).toEqual(["chat_id", "role", "content", "metadata", "topic_id", "session_key"]);
      expect(sent).toMatchObject({ chat_id: GROUP, role: "user", content: "Hallo", topic_id: 77, session_key: `topic:${GROUP}:77` });
      expect(sent.metadata).toMatchObject({ topicId: 77, channel: "web" });
      expect(sent.metadata.msgId).toMatch(UUID);
      const headers = f.requests[0].headers;
      expect(headers.get("content-type")).toBe("application/json");
      expect(headers.get("apikey")).toBe("test-service-key");
      expect(headers.get("authorization")).toBe("Bearer test-service-key");
    });

    test("genau ein Ereignis nach Erfolg, mit der msgId aus dem Request", async () => {
      const f = fake(edgeUp);
      await entry.save({ chat_id: DM, role: "assistant", content: "Antwort" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ chatId: DM, role: "assistant", content: "Antwort" });
      expect(events[0].metadata.msgId).toBe(JSON.parse(f.requests[0].body).metadata.msgId);
    });

    test("vorhandene msgId bleibt", async () => {
      const f = fake(edgeUp);
      await entry.save({ chat_id: DM, role: "user", content: "x", metadata: { msgId: "web-abc" } });
      expect(JSON.parse(f.requests[0].body).metadata.msgId).toBe("web-abc");
      expect(events[0].metadata.msgId).toBe("web-abc");
    });

    test("Edge Function aus (503): ein Direkt-Insert mit denselben Feldern, ein Ereignis", async () => {
      const f = fake();
      expect(await entry.save({ chat_id: DM, role: "user", content: "Frage", metadata: { topicId: 3 } })).toBe(true);
      expect(f.requests.map(r => `${r.method} ${r.url.pathname}`)).toEqual([`POST ${EDGE_PATH}`, `POST ${TABLE_PATH}`]);
      const row = bodyOf(f.requests[1]);
      expect(row).toMatchObject({ chat_id: DM, role: "user", content: "Frage", topic_id: 3, session_key: `topic:${DM}:3` });
      expect(row.metadata.msgId).toBe(JSON.parse(f.requests[0].body).metadata.msgId);
      expect(row).not.toHaveProperty("embedding");
      expect(events).toHaveLength(1);
    });

    test("Edge-Erfolg ohne Vektor: kein zweiter Insert", async () => {
      const f = fake({ edgeResponse: () => Response.json({ ok: true, embedded: false, embedding_status: "abgelehnt" }) });
      expect(await entry.save({ chat_id: DM, role: "user", content: "x" })).toBe(true);
      expect(posts(f.requests, TABLE_PATH)).toHaveLength(0);
      expect(events).toHaveLength(1);
    });

    test("Edge aus und Insert scheitert: false, kein Ereignis", async () => {
      fake({ respond: r => (r.method === "POST" && r.url.pathname === TABLE_PATH ? Response.json({ message: "kaputt" }, { status: 500 }) : undefined) });
      expect(await entry.save({ chat_id: DM, role: "user", content: "x" })).toBe(false);
      expect(events).toHaveLength(0);
    });

    test("Display-only über save: nie die Edge Function, ein Insert", async () => {
      const f = fake(edgeUp);
      expect(await entry.save({ chat_id: GROUP, role: "assistant", content: "Meldung", metadata: { display_only: true, topicId: 9 } })).toBe(true);
      expect(f.requests.map(r => `${r.method} ${r.url.pathname}`)).toEqual([`POST ${TABLE_PATH}`]);
      expect(bodyOf(f.requests[0])).toMatchObject({ topic_id: 9, session_key: `topic:${GROUP}:9` });
      expect(events).toHaveLength(1);
    });

    test("saveDisplayOnly: genau ein Insert, msgId, ein Ereignis", async () => {
      const f = fake(edgeUp);
      const ok = await entry.saveDisplayOnly({ chat_id: DM, role: "assistant", content: "Briefing", metadata: { display_only: true, source: "briefing" } });
      expect(ok).toBe(true);
      expect(f.requests.map(r => `${r.method} ${r.url.pathname}`)).toEqual([`POST ${TABLE_PATH}`]);
      const row = bodyOf(f.requests[0]);
      expect(row).toMatchObject({ chat_id: DM, topic_id: null, session_key: `dm:${DM}`, metadata: { display_only: true, source: "briefing" } });
      expect(row.metadata.msgId).toMatch(UUID);
      expect(events.map(e => e.metadata.msgId)).toEqual([row.metadata.msgId]);
    });

    test("saveDisplayOnly scheitert: false, kein Ereignis", async () => {
      fake({ respond: r => (r.method === "POST" ? Response.json({ message: "nein" }, { status: 403 }) : undefined) });
      expect(await entry.saveDisplayOnly({ chat_id: DM, role: "assistant", content: "x", metadata: { display_only: true } })).toBe(false);
      expect(events).toHaveLength(0);
    });

    test("Topic-ID: nur Zahlen zählen; Gruppe, Direktchat und Web-Gespräch haben eigene Schlüssel", async () => {
      const cases: [Message, number | null, string][] = [
        [{ chat_id: GROUP, role: "user", content: "a", metadata: { topicId: "12" } }, null, `group:${GROUP}`],
        [{ chat_id: GROUP, role: "user", content: "b" }, null, `group:${GROUP}`],
        [{ chat_id: DM, role: "user", content: "c", metadata: { topicId: null } }, null, `dm:${DM}`],
        [{ chat_id: "web:abc-123", role: "user", content: "d", metadata: { topicId: 5 } }, 5, "web:abc-123"],
      ];
      for (const [message, topicId, sessionKey] of cases) {
        const f = fake(edgeUp);
        await entry.save(message);
        expect(JSON.parse(f.requests[0].body)).toMatchObject({ topic_id: topicId, session_key: sessionKey });
        f.restore();
        cleanups.pop();
      }
    });

    test("created_at: gültig geht mit und steht im Ereignis, ungültig fehlt", async () => {
      let f = fake(edgeUp);
      await entry.save({ chat_id: DM, role: "user", content: "x", created_at: "2026-10-01T08:00:00.000Z" });
      expect(JSON.parse(f.requests[0].body).created_at).toBe("2026-10-01T08:00:00.000Z");
      expect(events[0].createdAt).toBe("2026-10-01T08:00:00.000Z");
      f.restore();
      cleanups.pop();
      f = fake(edgeUp);
      await entry.save({ chat_id: DM, role: "user", content: "x", created_at: "morgen" });
      expect("created_at" in JSON.parse(f.requests[0].body)).toBe(false);
    });
  });
}

const ROWS = [
  { id: 5, chat_id: DM, role: "assistant", content: "Meldung", metadata: { display_only: true }, created_at: "2026-10-16T11:59:00.000Z" },
  { id: 4, chat_id: DM, role: "assistant", content: "zweite Antwort", metadata: {}, created_at: "2026-10-16T11:58:00.000Z" },
  { id: 3, chat_id: DM, role: "user", content: "erste Frage", metadata: null, created_at: "2026-10-16T11:50:00.000Z" },
];

for (const reader of READERS) {
  describe(`lesen über ${reader.name}`, () => {
    test("recent: Filter vor dem Limit, neueste zuerst abgefragt, älteste zuerst geliefert, Meldung fehlt", async () => {
      const f = fake({ rows: () => ROWS });
      const result = await reader.recent(DM, 20, null);
      expect(result.map(m => m.content)).toEqual(["erste Frage", "zweite Antwort"]);
      const [url] = reads(f.requests).map(r => r.url);
      expect(url.searchParams.get("select")).toBe("*");
      expect(url.searchParams.get("chat_id")).toBe(`eq.${DM}`);
      expect(url.searchParams.get("or")).toBe(`(${NOT_DISPLAY_ONLY_FILTER})`);
      expect(url.searchParams.get("session_key")).toBe(`eq.dm:${DM}`);
      expect(url.searchParams.get("order")).toBe("created_at.desc");
      expect(url.searchParams.get("limit")).toBe("20");
    });

    test("recent: undefined heißt ganzer Chat, Zahl heißt Topic, null in der Gruppe heißt ohne Topic", async () => {
      const f = fake({ rows: () => [] });
      await reader.recent(GROUP, 5);
      await reader.recent(GROUP, 5, 42);
      await reader.recent(GROUP, 5, null);
      const keys = reads(f.requests).map(r => r.url.searchParams.get("session_key"));
      expect(keys).toEqual([null, `eq.topic:${GROUP}:42`, `eq.group:${GROUP}`]);
    });

    test("recent: Lesefehler ergibt eine leere Liste", async () => {
      fake({ respond: r => (r.method === "GET" ? Response.json({ message: "weg" }, { status: 500 }) : undefined) });
      expect(await reader.recent(DM, 10, null)).toEqual([]);
    });

    test("Kontext mit fester Uhr: Alter, Sprecher, Meldung fehlt", async () => {
      setSystemTime(NOW);
      fake({ rows: () => ROWS });
      expect(await reader.context(DM, 10, null)).toBe("[10 minutes ago] User: erste Frage\n[2 minutes ago] Bot: zweite Antwort");
    });

    test("Kontext: Kürzung bei 800 (tybo) und 20.000 Zeichen (Nutzer), Grenze selbst bleibt ganz", async () => {
      setSystemTime(NOW);
      const at = "2026-10-16T11:59:30.000Z";
      const rows = [
        { role: "assistant", content: "b".repeat(801), created_at: at },
        { role: "assistant", content: "a".repeat(800), created_at: at },
        { role: "user", content: "u".repeat(20_001), created_at: at },
        { role: "user", content: "v".repeat(20_000), created_at: at },
      ];
      fake({ rows: () => rows });
      const lines = (await reader.context(DM, 10, null)).split("\n");
      expect(lines).toEqual([
        `[just now] User: ${"v".repeat(20_000)}`,
        `[just now] User: ${"u".repeat(20_000)}...`,
        `[just now] Bot: ${"a".repeat(800)}`,
        `[just now] Bot: ${"b".repeat(800)}...`,
      ]);
    });

    test("Kontext: Stunden, Tage, ab 30 Tagen das Datum, ohne Zeitpunkt leere Klammer", async () => {
      setSystemTime(NOW);
      const old = "2026-09-16T12:00:00.000Z";
      const rows = [
        { role: "user", content: "ohne", created_at: undefined },
        { role: "user", content: "eine Stunde", created_at: "2026-10-16T11:00:00.000Z" },
        { role: "user", content: "29 Tage", created_at: "2026-09-17T12:00:00.000Z" },
        { role: "user", content: "30 Tage", created_at: old },
      ];
      fake({ rows: () => rows });
      expect((await reader.context(DM, 10, null)).split("\n")).toEqual([
        `[${new Date(old).toLocaleDateString()}] User: 30 Tage`,
        "[29 days ago] User: 29 Tage",
        "[1 hour ago] User: eine Stunde",
        "[] User: ohne",
      ]);
    });

    test("Kontext ohne Nachrichten: leerer Text", async () => {
      fake({ rows: () => [] });
      expect(await reader.context(DM, 10, null)).toBe("");
    });

    test("Board: Request mit festen Spalten, seit days Tagen, Filter, neueste zuerst, höchstens 100", async () => {
      setSystemTime(NOW);
      const f = fake({ rows: () => [] });
      await reader.board(7);
      const [url] = reads(f.requests).map(r => r.url);
      expect(url.searchParams.get("select")).toBe("role,content,metadata,created_at");
      const since = new Date(NOW);
      since.setDate(since.getDate() - 7);
      expect(url.searchParams.get("created_at")).toBe(`gte.${since.toISOString()}`);
      expect(url.searchParams.get("or")).toBe(`(${NOT_DISPLAY_ONLY_FILTER})`);
      expect(url.searchParams.get("order")).toBe("created_at.desc");
      expect(url.searchParams.get("limit")).toBe("100");
      expect(url.searchParams.has("chat_id")).toBe(false);
    });

    test("Board: Gruppen nach metadata.thread_id, je Gruppe höchstens 15, Vorschau 200 Zeichen", async () => {
      const rows = [
        { role: "user", content: "x".repeat(201), metadata: { thread_id: 12 }, created_at: "2026-10-16T11:00:00.000Z" },
        { role: "assistant", content: "Antwort ohne Topic", metadata: null, created_at: "2026-10-16T10:00:00.000Z" },
        { role: "assistant", content: "Meldung", metadata: { display_only: true, thread_id: 12 }, created_at: "2026-10-16T09:00:00.000Z" },
        { role: "assistant", content: "y".repeat(200), metadata: { thread_id: 12, topicId: 99 }, created_at: "2026-10-16T08:00:00.000Z" },
        ...Array.from({ length: 16 }, (_, i) => ({ role: "user", content: `g${i}`, metadata: { thread_id: 0 }, created_at: "2026-10-15T08:00:00.000Z" })),
      ];
      fake({ rows: () => rows });
      const general = ["- Agent: Antwort ohne Topic", ...Array.from({ length: 14 }, (_, i) => `- User: g${i}`)];
      expect(await reader.board(3)).toBe(
        "\n\n## BOARD MEETING CONTEXT (Last 3 days)\n" +
          "Review of conversations across all agents:\n\n" +
          `### topic_12\n- User: ${"x".repeat(200)}...\n- Agent: ${"y".repeat(200)}\n\n` +
          `### general\n${general.join("\n")}\n\n`
      );
    });

    test("Board ohne Zeilen oder mit Lesefehler: fester Hinweis", async () => {
      let f = fake({ rows: () => [] });
      expect(await reader.board(7)).toBe("\n\nNo recent conversations across topics.");
      f.restore();
      cleanups.pop();
      f = fake({ respond: r => (r.method === "GET" ? Response.json({ message: "weg" }, { status: 500 }) : undefined) });
      expect(await reader.board(7)).toBe("\n\nNo recent conversations across topics.");
    });
  });
}

describe("ohne Supabase (Aufruferweg über den Store)", () => {
  test("speichern false ohne Request und ohne Ereignis, lesen leer, Board mit eigenem Hinweis", async () => {
    const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, convex: process.env.CONVEX_URL };
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY;
    delete process.env.CONVEX_URL;
    resetSupabaseClient();
    resetStore();
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      expect(await storeOr(false, store => store.messages.save({ chat_id: DM, role: "user", content: "x" }))).toBe(false);
      expect(await storeOr(false, store => store.messages.saveDisplayOnly({ chat_id: DM, role: "user", content: "x" }))).toBe(false);
      expect(await storeOr([], store => store.messages.recent(DM, 5))).toEqual([]);
      const store = getStore();
      expect(await loadBoardContext(store.backend === "supabase" ? store.messages : null, 7)).toBe("\n\nNo conversation data available.");
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(events).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
      if (saved.url !== undefined) process.env.SUPABASE_URL = saved.url;
      if (saved.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
      if (saved.convex !== undefined) process.env.CONVEX_URL = saved.convex;
      resetSupabaseClient();
      resetStore();
    }
  });
});

describe("Adapter mit werfendem Client", () => {
  const throwing = {
    from() {
      throw new Error("Client kaputt");
    },
  } as unknown as SupabaseClient;

  test("recentRows fängt die Ausnahme und liefert eine leere Liste", async () => {
    expect(await recentRows(throwing, DM, 5, null)).toEqual([]);
  });

  test("boardRowsSince gibt die Ausnahme weiter (getBoardMeetingContext meldet dann den Ladefehler)", async () => {
    await expect(boardRowsSince(throwing, 7)).rejects.toThrow("Client kaputt");
  });

  test("insertRow: Ausnahme ergibt false", async () => {
    expect(await insertRow({ chat_id: DM, role: "user", content: "x" }, throwing)).toBe(false);
  });
});
