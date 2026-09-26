import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  HISTORY_COLUMNS,
  TOPIC_ACTIVITY_ROW_LIMIT,
  getConversationHistory,
  getTopicActivity,
} from "../src/lib/supabase";
import * as backend from "../src/lib/convex";

type Call = [string, ...unknown[]];

/** Supabase-Client als Attrappe: merkt sich die Aufrufkette, liefert ein festes Ergebnis. */
function fakeClient(result: { data?: unknown; error?: unknown } | (() => never)) {
  const calls: Call[] = [];
  const builder: any = {
    then(resolve: (v: unknown) => void, reject: (e: unknown) => void) {
      try {
        resolve(typeof result === "function" ? result() : { data: result.data ?? null, error: result.error ?? null });
      } catch (e) {
        reject(e);
      }
    },
  };
  for (const method of ["select", "eq", "lt", "gte", "order", "limit"]) {
    builder[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return builder;
    };
  }
  const client: any = {
    from(table: string) {
      calls.push(["from", table]);
      return builder;
    },
  };
  return { client, calls };
}

const GROUP = "-1001234567890";
let warn: ReturnType<typeof spyOn> | undefined;
afterEach(() => {
  warn?.mockRestore();
  warn = undefined;
});

function silence() {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  return warn;
}

describe("getConversationHistory", () => {
  test("liest nur die schlanken Spalten, jüngste zuerst, gibt chronologisch zurück", async () => {
    const { client, calls } = fakeClient({
      data: [
        { id: "3", created_at: "2026-09-23T10:03:00Z", role: "assistant", content: "c", metadata: {} },
        { id: "2", created_at: "2026-09-23T10:02:00Z", role: "user", content: "b", metadata: {} },
      ],
    });
    const rows = await getConversationHistory(GROUP, 443, { limit: 50 }, client);
    expect(rows.map(r => r.id)).toEqual(["2", "3"]);
    expect(calls).toContainEqual(["from", "messages"]);
    expect(calls).toContainEqual(["select", HISTORY_COLUMNS]);
    expect(HISTORY_COLUMNS).not.toContain("embedding");
    expect(HISTORY_COLUMNS).not.toContain("*");
    expect(calls).toContainEqual(["eq", "chat_id", GROUP]);
    expect(calls).toContainEqual(["eq", "session_key", `topic:${GROUP}:443`]);
    expect(calls).toContainEqual(["order", "created_at", { ascending: false }]);
    expect(calls).toContainEqual(["limit", 50]);
    expect(calls.some(c => c[0] === "lt")).toBe(false);
  });

  test("topicId null liest group:<chatId> (General) bzw. dm:<id>", async () => {
    const group = fakeClient({ data: [] });
    await getConversationHistory(GROUP, null, { limit: 5 }, group.client);
    expect(group.calls).toContainEqual(["eq", "session_key", `group:${GROUP}`]);
    const dm = fakeClient({ data: [] });
    await getConversationHistory("4711", null, { limit: 5 }, dm.client);
    expect(dm.calls).toContainEqual(["eq", "session_key", "dm:4711"]);
  });

  test("before filtert auf ältere Nachrichten", async () => {
    const { client, calls } = fakeClient({ data: [] });
    await getConversationHistory(GROUP, 8, { limit: 51, before: "2026-09-23T10:00:00.000Z" }, client);
    expect(calls).toContainEqual(["lt", "created_at", "2026-09-23T10:00:00.000Z"]);
    expect(calls).toContainEqual(["limit", 51]);
  });

  test("Fehler als error-Ergebnis: wirft statt leerer Liste, eine Log-Zeile ohne Details (PR #83, Runde 4)", async () => {
    const spy = silence();
    const { client } = fakeClient({ error: { code: "PGRST301", message: "JWT secret-token-xyz abgelaufen" } });
    const error = await getConversationHistory(GROUP, 8, { limit: 50 }, client).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).not.toContain("secret-token-xyz");
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line).toContain("PGRST301");
    expect(line).not.toContain("secret-token-xyz");
  });

  test("Fehler als Exception: wirft ohne Details, eine Log-Zeile (PR #83, Runde 4)", async () => {
    const spy = silence();
    const { client } = fakeClient(() => {
      throw new TypeError("fetch failed https://geheim.supabase.co");
    });
    const error = await getConversationHistory(GROUP, 8, { limit: 50 }, client).catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error.message)).not.toContain("geheim");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).not.toContain("geheim");
  });

  test("ohne Client: leere Liste", async () => {
    expect(await getConversationHistory(GROUP, 8, { limit: 50 }, null)).toEqual([]);
  });
});

describe("getTopicActivity", () => {
  const now = Date.parse("2026-09-23T12:00:00Z");

  test("eine Abfrage, letzte Nachricht je session_key, jüngste zuerst", async () => {
    const { client, calls } = fakeClient({
      data: [
        { session_key: `topic:${GROUP}:443`, created_at: "2026-09-23T11:00:00Z" },
        { session_key: `group:${GROUP}`, created_at: "2026-09-23T10:00:00Z" },
        { session_key: `topic:${GROUP}:443`, created_at: "2026-09-23T09:00:00Z" },
        { session_key: null, created_at: "2026-09-23T08:30:00Z" },
        { session_key: `topic:${GROUP}:8`, created_at: "2026-09-22T08:00:00Z" },
      ],
    });
    const activity = await getTopicActivity(GROUP, 30, client, now);
    expect(activity).toEqual([
      { sessionKey: `topic:${GROUP}:443`, lastActivity: "2026-09-23T11:00:00Z" },
      { sessionKey: `group:${GROUP}`, lastActivity: "2026-09-23T10:00:00Z" },
      { sessionKey: `topic:${GROUP}:8`, lastActivity: "2026-09-22T08:00:00Z" },
    ]);
    expect(calls.filter(c => c[0] === "from")).toHaveLength(1);
    expect(calls).toContainEqual(["select", "session_key, created_at"]);
    expect(calls).toContainEqual(["eq", "chat_id", GROUP]);
    expect(calls).toContainEqual(["gte", "created_at", "2026-08-24T12:00:00.000Z"]);
    expect(calls).toContainEqual(["order", "created_at", { ascending: false }]);
    expect(calls).toContainEqual(["limit", TOPIC_ACTIVITY_ROW_LIMIT]);
  });

  test("Fehler (Ergebnis und Exception): leere Liste und Log-Zeile", async () => {
    const spy = silence();
    expect(await getTopicActivity(GROUP, 30, fakeClient({ error: { code: "57014" } }).client, now)).toEqual([]);
    const thrown = fakeClient(() => {
      throw new Error("boom");
    });
    expect(await getTopicActivity(GROUP, 30, thrown.client, now)).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});

describe("Durchreichung in convex.ts", () => {
  const saved = { CONVEX_URL: process.env.CONVEX_URL, SUPABASE_URL: process.env.SUPABASE_URL };
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("unter Convex: leere Liste und Log-Zeile, keine Abfrage", async () => {
    const spy = silence();
    process.env.CONVEX_URL = "https://synthetic.convex.cloud";
    expect(await backend.getConversationHistory(GROUP, 8, { limit: 50 })).toEqual([]);
    expect(await backend.getTopicActivity(GROUP, 30)).toEqual([]);
    expect(spy).toHaveBeenCalledTimes(2);
  });

  test("ohne Backend: leere Liste", async () => {
    delete process.env.CONVEX_URL;
    delete process.env.SUPABASE_URL;
    expect(await backend.getConversationHistory(GROUP, 8, { limit: 50 })).toEqual([]);
    expect(await backend.getTopicActivity(GROUP, 30)).toEqual([]);
  });
});
