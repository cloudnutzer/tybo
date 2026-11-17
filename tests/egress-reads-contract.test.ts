/**
 * Issue #684: Vertrag der drei schlanken Leser über Supabase. Welche Abfrage
 * geht an die Tabelle (Spalten, Filter, Reihenfolge, Limit), wann wird leer
 * geantwortet und wann geworfen. Wie messages-read-contract.test.ts: kein
 * Netz, supabase-js gegen die Fetch-Attrappe.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getStore, resetStore } from "../src/lib/store";
import { NOTICE_HEAD_COLUMNS, supabaseMessageReads, TOPIC_ACTIVITY_ROW_LIMIT } from "../src/lib/store/supabase/message-reads";
import { useFakeSupabase, type FakeRequest, type FakeSupabaseOptions } from "./supabase-fixture";

const DM = "4711";
const GROUP = "-1005550001111";
const TABLE_PATH = "/rest/v1/messages";
const SECRET = "geheim-7f3a";
/** Zeitpunkt mit Mikrosekunden, wie ihn Postgres liefert */
const MICRO = "2026-11-16T08:15:42.123456+00:00";
const SINCE = "2026-11-16T08:14:42.123Z";

const cleanups: (() => void)[] = [];
let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  cleanups.push(() => warn.mockRestore());
});
afterEach(() => {
  resetStore();
  while (cleanups.length) cleanups.pop()!();
});

function fake(options: FakeSupabaseOptions = {}) {
  const f = useFakeSupabase(options);
  cleanups.push(() => f.restore());
  return f;
}

function messages() {
  resetStore();
  const store = getStore();
  expect(store.backend).toBe("supabase");
  return store.messages;
}

const tableReads = (requests: FakeRequest[]) => requests.filter(r => r.method === "GET" && r.url.pathname === TABLE_PATH);
const onlyRead = (requests: FakeRequest[]) => {
  const reads = tableReads(requests);
  expect(reads).toHaveLength(1);
  return reads[0].url.searchParams;
};
const tableFails = { respond: (r: FakeRequest) => (r.method === "GET" && r.url.pathname === TABLE_PATH ? Response.json({ code: "PGRST301", message: `JWT ${SECRET}` }, { status: 401 }) : undefined) };
const throwingClient = {
  from() {
    throw new Error(`Client kaputt ${SECRET}`);
  },
} as unknown as SupabaseClient;

describe("Topic-Aktivität ab einem Zeitpunkt (topicActivitySince)", () => {
  test("eine Abfrage ab since, jüngster Zeitpunkt je Schlüssel, jüngste zuerst", async () => {
    const f = fake({
      rows: () => [
        { session_key: `topic:${GROUP}:7`, created_at: MICRO },
        { session_key: `group:${GROUP}`, created_at: "2026-11-16T08:15:00.000Z" },
        { session_key: `topic:${GROUP}:7`, created_at: "2026-11-16T08:14:50.000Z" },
        { session_key: null, created_at: "2026-11-16T08:14:45.000Z" },
      ],
    });
    expect(await messages().topicActivitySince(GROUP, SINCE)).toEqual({
      activity: [
        { sessionKey: `topic:${GROUP}:7`, lastActivity: MICRO },
        { sessionKey: `group:${GROUP}`, lastActivity: "2026-11-16T08:15:00.000Z" },
      ],
      truncated: false,
    });
    const params = onlyRead(f.requests);
    expect(params.get("select")).toBe("session_key,created_at");
    expect(params.get("chat_id")).toBe(`eq.${GROUP}`);
    expect(params.get("created_at")).toBe(`gte.${SINCE}`);
    expect(params.get("order")).toBe("created_at.desc");
    expect(params.get("limit")).toBe(String(TOPIC_ACTIVITY_ROW_LIMIT));
  });

  test("keine Zeile: leer und nicht abgeschnitten", async () => {
    fake({ rows: () => [] });
    expect(await messages().topicActivitySince(DM, SINCE)).toEqual({ activity: [], truncated: false });
  });

  test("Zeilenlimit erreicht: truncated", async () => {
    const rows = Array.from({ length: TOPIC_ACTIVITY_ROW_LIMIT }, () => ({ session_key: `dm:${DM}`, created_at: MICRO }));
    fake({ rows: () => rows });
    const changes = await messages().topicActivitySince(DM, SINCE);
    expect(changes.truncated).toBe(true);
    expect(changes.activity).toEqual([{ sessionKey: `dm:${DM}`, lastActivity: MICRO }]);
  });

  test("Lesefehler und werfender Client: wirft ohne Details, eine Log-Zeile mit Fehlercode", async () => {
    fake(tableFails);
    const error = await messages().topicActivitySince(GROUP, SINCE).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).not.toContain(SECRET);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain("PGRST301");
    expect(String(warn.mock.calls[0][0])).not.toContain(SECRET);
    const thrown = await supabaseMessageReads(() => throwingClient).topicActivitySince(GROUP, SINCE).catch(e => e);
    expect(thrown).toBeInstanceOf(Error);
    expect(String(thrown.message)).not.toContain(SECRET);
  });

  test("ungültiger Zeitpunkt: Fehler ohne Abfrage", async () => {
    const f = fake({ rows: () => [] });
    const reader = messages();
    await expect(reader.topicActivitySince(GROUP, 'x",id.gt.0')).rejects.toThrow("ungültiger Zeitpunkt");
    await expect(reader.topicActivitySince(GROUP, "2026-11-16")).rejects.toThrow("ungültiger Zeitpunkt");
    expect(tableReads(f.requests)).toHaveLength(0);
  });

  test("ohne Client: leer, wie topicActivity", async () => {
    expect(await supabaseMessageReads(() => null).topicActivitySince(GROUP, SINCE)).toEqual({ activity: [], truncated: false });
  });
});

describe("Köpfe der Meldungen (displayOnlyHeads)", () => {
  test("dieselbe Seite wie displayOnlyPage, aber nur id und created_at", async () => {
    const options = { since: "2026-11-15T00:00:00Z", after: { createdAt: MICRO, id: "87" }, limit: 25 };
    const f = fake({ rows: () => [{ id: 88, created_at: MICRO }] });
    expect(await messages().displayOnlyHeads([DM, GROUP], options)).toEqual([{ id: 88, created_at: MICRO }] as never);
    const head = onlyRead(f.requests);
    f.requests.length = 0;
    await messages().displayOnlyPage([DM, GROUP], options);
    const page = onlyRead(f.requests);

    expect(head.get("select")).toBe("id,created_at");
    expect(NOTICE_HEAD_COLUMNS.replace(/\s/g, "")).toBe("id,created_at");
    expect(page.get("select")).toBe("id,created_at,chat_id,role,content,metadata");
    // Bis auf die Spalten ist die Abfrage dieselbe
    head.delete("select");
    page.delete("select");
    expect(head.toString()).toBe(page.toString());
    expect(head.get("chat_id")).toBe(`in.(${DM},${GROUP})`);
    expect(head.get("metadata->>display_only")).toBe("eq.true");
    expect(head.get("created_at")).toBe("gte.2026-11-15T00:00:00Z");
    expect(head.get("or")).toBe(`(created_at.gt."${MICRO}",and(created_at.eq."${MICRO}",id.gt.87))`);
    expect(head.get("order")).toBe("created_at.asc,id.asc");
    expect(head.get("limit")).toBe("25");
  });

  test("ungültiger Zeitpunkt und Cursor scheitern vor der Abfrage, leere chatIds ergeben []", async () => {
    const f = fake({ rows: () => [] });
    const reader = messages();
    await expect(reader.displayOnlyHeads([DM], { since: "gestern", limit: 1 })).rejects.toThrow("ungültiger Zeitpunkt");
    await expect(reader.displayOnlyHeads([DM], { after: { createdAt: MICRO, id: "1,id.gt.0" }, limit: 1 })).rejects.toThrow("ungültiger Cursor");
    expect(await reader.displayOnlyHeads([], { limit: 5 })).toEqual([]);
    expect(tableReads(f.requests)).toHaveLength(0);
  });

  test("Lesefehler: wirft, eine Log-Zeile ohne Details", async () => {
    fake(tableFails);
    await expect(messages().displayOnlyHeads([DM], { limit: 5 })).rejects.toBeInstanceOf(Error);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain(SECRET);
  });
});

describe("Volle Meldungen zu Zeilen-IDs (displayOnlyRows)", () => {
  const ROW = { id: 88, created_at: MICRO, chat_id: DM, role: "assistant", content: "Datei", metadata: { display_only: true } };

  test("nur die genannten Zeilen, nur Meldungen der Chats, sortiert wie die Seiten", async () => {
    const f = fake({ rows: () => [ROW] });
    expect(await messages().displayOnlyRows([DM, GROUP], ["88", "91"])).toEqual([ROW] as never);
    const params = onlyRead(f.requests);
    expect(params.get("select")).toBe("id,created_at,chat_id,role,content,metadata");
    expect(params.get("id")).toBe("in.(88,91)");
    expect(params.get("chat_id")).toBe(`in.(${DM},${GROUP})`);
    expect(params.get("metadata->>display_only")).toBe("eq.true");
    expect(params.get("order")).toBe("created_at.asc,id.asc");
    expect(params.has("limit")).toBe(false);
  });

  test("leere ids oder chatIds: [] ohne Abfrage; eine ID, die keine Ziffernfolge ist, scheitert vor der Abfrage", async () => {
    const f = fake({ rows: () => [ROW] });
    const reader = messages();
    expect(await reader.displayOnlyRows([DM], [])).toEqual([]);
    expect(await reader.displayOnlyRows([], ["88"])).toEqual([]);
    await expect(reader.displayOnlyRows([DM], ["88", "1) or (1=1"])).rejects.toThrow("ungültige Zeilen-ID");
    await expect(reader.displayOnlyRows([DM], [""])).rejects.toThrow("ungültige Zeilen-ID");
    expect(tableReads(f.requests)).toHaveLength(0);
  });

  test("Lesefehler: wirft; ohne Client: Supabase nicht eingerichtet", async () => {
    fake(tableFails);
    await expect(messages().displayOnlyRows([DM], ["88"])).rejects.toBeInstanceOf(Error);
    const parts = supabaseMessageReads(() => null);
    await expect(parts.displayOnlyRows([DM], ["88"])).rejects.toThrow("Supabase nicht eingerichtet");
    await expect(parts.displayOnlyHeads([DM], { limit: 5 })).rejects.toThrow("Supabase nicht eingerichtet");
  });
});
