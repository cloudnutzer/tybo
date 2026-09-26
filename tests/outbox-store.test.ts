/**
 * Issue #45: Festhalten der Nur-Anzeige-Einträge. Direkter Insert mit
 * topic_id/session_key, nie über die Edge-Function (kein Embedding), msgId
 * und onMessageSaved wie bei saveMessage. Kein Netz: fetch ist eine Attrappe.
 */
import { afterEach, expect, test } from "bun:test";
import { onMessageSaved, saveDisplayOnlyMessage, type SavedMessageEvent } from "../src/lib/convex";
import { insertMessageDirect, saveMessage } from "../src/lib/supabase";
import { useFakeSupabase } from "./supabase-fixture";

const GROUP = "-1001234567890";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function fake() {
  const f = useFakeSupabase();
  cleanups.push(() => f.restore());
  return f;
}

test("insertMessageDirect schreibt topic_id und session_key, ohne Edge-Function", async () => {
  const inserted: unknown[] = [];
  const client: any = {
    from(table: string) {
      expect(table).toBe("messages");
      return {
        insert: async (row: unknown) => {
          inserted.push(row);
          return { error: null };
        },
      };
    },
  };
  const ok = await insertMessageDirect(
    { chat_id: GROUP, role: "assistant", content: "Stand", metadata: { display_only: true, source: "pipeline", topicId: 443 } },
    client
  );
  expect(ok).toBe(true);
  expect(inserted).toEqual([
    {
      chat_id: GROUP,
      role: "assistant",
      content: "Stand",
      metadata: { display_only: true, source: "pipeline", topicId: 443 },
      topic_id: 443,
      session_key: `topic:${GROUP}:443`,
    },
  ]);
});

test("insertMessageDirect: Fehler und Exception ergeben false", async () => {
  const failing: any = { from: () => ({ insert: async () => ({ error: { code: "42501" } }) }) };
  const throwing: any = {
    from: () => ({
      insert: async () => {
        throw new Error("weg");
      },
    }),
  };
  const message = { chat_id: "4711", role: "assistant" as const, content: "x", metadata: { display_only: true } };
  expect(await insertMessageDirect(message, failing)).toBe(false);
  expect(await insertMessageDirect(message, throwing)).toBe(false);
  expect(await insertMessageDirect(message, null)).toBe(false);
});

test("saveDisplayOnlyMessage: ein direkter Insert, kein Embedding, msgId und Zuhörer", async () => {
  const f = fake();
  const events: SavedMessageEvent[] = [];
  cleanups.push(onMessageSaved(e => void events.push(e)));

  const ok = await saveDisplayOnlyMessage({
    chat_id: "4711",
    role: "assistant",
    content: "Briefing ist da",
    metadata: { display_only: true, source: "briefing" },
  });
  expect(ok).toBe(true);

  // Genau eine Anfrage: POST auf die Tabelle, keine Edge-Function, kein OpenAI
  expect(f.requests.map(r => `${r.method} ${r.url.pathname}`)).toEqual(["POST /rest/v1/messages"]);
  const row = JSON.parse(f.requests[0].body);
  expect(row).toMatchObject({
    chat_id: "4711",
    role: "assistant",
    content: "Briefing ist da",
    topic_id: null,
    session_key: "dm:4711",
    metadata: { display_only: true, source: "briefing" },
  });
  expect(row.metadata.msgId).toMatch(UUID);
  expect(row).not.toHaveProperty("embedding");

  expect(events).toHaveLength(1);
  expect(events[0].metadata.msgId).toBe(row.metadata.msgId);
  expect(events[0].metadata.display_only).toBe(true);
});

test("saveMessage mit display_only nimmt ebenfalls nie die Edge-Function", async () => {
  const f = fake();
  const ok = await saveMessage({
    chat_id: GROUP,
    role: "assistant",
    content: "x",
    metadata: { display_only: true, source: "watcher", topicId: 7 },
  });
  expect(ok).toBe(true);
  expect(f.requests.some(r => r.url.pathname.startsWith("/functions/"))).toBe(false);
  expect(JSON.parse(f.requests[0].body)).toMatchObject({ topic_id: 7, session_key: `topic:${GROUP}:7` });
});

test("normale Nachrichten gehen weiter zuerst über die Edge-Function", async () => {
  const f = fake();
  await saveMessage({ chat_id: "4711", role: "user", content: "Hallo" });
  expect(f.requests[0].url.pathname).toBe("/functions/v1/store-telegram-message");
});

test("unter Convex wird nicht festgehalten und nichts aufgerufen", async () => {
  const f = fake();
  process.env.CONVEX_URL = "https://example.convex.cloud";
  const ok = await saveDisplayOnlyMessage({ chat_id: "4711", role: "assistant", content: "x", metadata: { display_only: true } });
  expect(ok).toBe(false);
  expect(f.requests).toHaveLength(0);
});
