/**
 * Issue #69: mitgegebenes created_at durch saveMessageWith, saveMessage
 * (Edge-Function und Direkt-Insert) und die Edge-Function selbst. Ungültige
 * oder zukünftige Werte fallen auf den Default der Datenbank zurück, ohne
 * Angabe ändert sich nichts. Kein Netz: supabase-js gegen die Fetch-Attrappe.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { acceptedCreatedAt } from "../supabase/functions/_shared/created-at";
import { messageRow } from "../supabase/functions/store-telegram-message/row";
import { onMessageSaved, saveMessageWith, type Message, type SavedMessageEvent } from "../src/lib/convex";
import { insertMessageDirect, saveMessage } from "../src/lib/supabase";
import { useFakeSupabase, type FakeRequest } from "./supabase-fixture";

const PAST = "2026-09-24T11:50:02.500Z";
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function future(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

/** Werte, die nie als created_at durchgehen */
const INVALID: unknown[] = [
  "2026-09-24", // nur Datum
  "2026-09-24T11:50:02", // ohne Zeitzone
  "2026-09-24 11:50:02Z", // Leerzeichen statt T
  "Thu, 24 Sep 2026 11:50:02 GMT", // Date.parse nimmt das, ISO ist es nicht
  "2026-02-31T10:00:00Z", // Tag existiert nicht
  "2026-09-24T24:00:00Z",
  "2026-09-24T11:50:02.1234567Z", // mehr als Mikrosekunden
  "morgen",
  "",
  1727178602000,
  null,
  {},
];

describe("acceptedCreatedAt", () => {
  test("nimmt gültige ISO-Zeitstempel in der Vergangenheit, normalisiert", () => {
    expect(acceptedCreatedAt(PAST)).toBe(PAST);
    expect(acceptedCreatedAt("2026-09-24T13:50:02+02:00")).toBe("2026-09-24T11:50:02.000Z");
    expect(acceptedCreatedAt("2026-09-24T11:50:02.123456Z")).toBe("2026-09-24T11:50:02.123Z");
    // genau jetzt ist nicht Zukunft
    expect(acceptedCreatedAt(PAST, Date.parse(PAST))).toBe(PAST);
  });

  test("lehnt ungültige Formate und fehlende Werte ab", () => {
    for (const value of [...INVALID, undefined]) expect(acceptedCreatedAt(value)).toBeNull();
  });

  test("lehnt Zeitpunkte in der Zukunft ab", () => {
    expect(acceptedCreatedAt(future())).toBeNull();
    expect(acceptedCreatedAt(PAST, Date.parse(PAST) - 1)).toBeNull();
  });
});

describe("Edge-Function store-telegram-message: messageRow", () => {
  const body = { chat_id: "-100777", role: "user", content: "Frage", metadata: { topicId: 2871, channel: "web" } };

  test("übernimmt gültiges created_at", () => {
    const row = messageRow({ ...body, created_at: PAST }, null);
    expect(row.created_at).toBe(PAST);
    expect(row.topic_id).toBe(2871);
    expect(row.session_key).toBe("topic:-100777:2871");
  });

  test("ungültig oder in der Zukunft: Feld fehlt, die Datenbank setzt den Default", () => {
    for (const created_at of [...INVALID, future()]) {
      expect("created_at" in messageRow({ ...body, created_at }, null)).toBe(false);
    }
  });

  test("ohne Angabe dieselbe Zeile wie bisher", () => {
    expect(messageRow(body, [0.1, 0.2])).toEqual({
      chat_id: "-100777",
      role: "user",
      content: "Frage",
      metadata: { topicId: 2871, channel: "web" },
      topic_id: 2871,
      session_key: "topic:-100777:2871",
      embedding: [0.1, 0.2],
    });
  });

  test("mit Angabe, womit der Vektor entstand (Issue #168): embedding_model nur zusammen mit dem Vektor", () => {
    expect(messageRow(body, [0.1, 0.2], Date.now(), "gemini:gemini-embedding-2")).toMatchObject({ embedding: [0.1, 0.2], embedding_model: "gemini:gemini-embedding-2" });
    expect("embedding_model" in messageRow(body, null, Date.now(), "gemini:gemini-embedding-2")).toBe(false);
  });
});

describe("saveMessage und insertMessageDirect (Supabase)", () => {
  function fake(edgeUp: boolean) {
    const f = useFakeSupabase({ edge: () => (edgeUp ? [] : undefined) });
    cleanups.push(() => f.restore());
    return f;
  }
  const edgeBody = (requests: FakeRequest[]) => {
    const r = requests.find(q => q.method === "POST" && q.url.pathname === "/functions/v1/store-telegram-message");
    return r ? JSON.parse(r.body) : undefined;
  };
  const insertBody = (requests: FakeRequest[]) => {
    const r = requests.find(q => q.method === "POST" && q.url.pathname === "/rest/v1/messages");
    if (!r) return undefined;
    const parsed = JSON.parse(r.body);
    return Array.isArray(parsed) ? parsed[0] : parsed;
  };
  const message = (created_at?: unknown): Message => ({
    chat_id: "-100777",
    role: "user",
    content: "Frage",
    metadata: { topicId: 2871 },
    ...(created_at !== undefined ? { created_at: created_at as string } : {}),
  });

  test("Edge-Pfad: gültiges created_at geht im Body mit", async () => {
    const f = fake(true);
    expect(await saveMessage(message(PAST))).toBe(true);
    expect(edgeBody(f.requests).created_at).toBe(PAST);
    expect(insertBody(f.requests)).toBeUndefined();
  });

  test("Edge-Pfad: ungültig, zukünftig oder ohne Angabe fehlt das Feld", async () => {
    for (const value of ["Thu, 24 Sep 2026 11:50:02 GMT", future(), undefined]) {
      const f = fake(true);
      expect(await saveMessage(message(value))).toBe(true);
      const sent = edgeBody(f.requests);
      expect(sent.content).toBe("Frage");
      expect("created_at" in sent).toBe(false);
      f.restore();
      cleanups.pop();
    }
  });

  test("Fallback Direkt-Insert: gültiges created_at in der Zeile, ungültiges nicht", async () => {
    let f = fake(false);
    expect(await saveMessage(message(PAST))).toBe(true);
    expect(insertBody(f.requests).created_at).toBe(PAST);
    f.restore();
    cleanups.pop();

    f = fake(false);
    expect(await saveMessage(message(future()))).toBe(true);
    expect("created_at" in insertBody(f.requests)).toBe(false);
    f.restore();
    cleanups.pop();

    f = fake(false);
    expect(await saveMessage(message())).toBe(true);
    expect("created_at" in insertBody(f.requests)).toBe(false);
  });

  test("insertMessageDirect (Nur-Anzeige-Weg) übernimmt created_at genauso", async () => {
    const f = fake(true);
    expect(await insertMessageDirect({ ...message(PAST), metadata: { display_only: true } })).toBe(true);
    expect(insertBody(f.requests).created_at).toBe(PAST);
    expect(edgeBody(f.requests)).toBeUndefined();
  });
});

describe("saveMessageWith: Live-Ereignis und Speicher mit demselben Zeitpunkt", () => {
  function run(created_at: unknown) {
    const events: SavedMessageEvent[] = [];
    const persisted: Message[] = [];
    cleanups.push(onMessageSaved(e => void events.push(e)));
    return {
      events,
      persisted,
      save: () =>
        saveMessageWith({ chat_id: "1", role: "user", content: "x", created_at: created_at as string }, async m => {
          persisted.push(m);
          return true;
        }),
    };
  }

  test("gültiges created_at: gespeichert und im Ereignis derselbe Wert", async () => {
    const r = run(PAST);
    await r.save();
    expect(r.persisted[0].created_at).toBe(PAST);
    expect(r.events[0].createdAt).toBe(PAST);
  });

  test("ungültiges oder zukünftiges created_at: nicht weitergegeben, Ereignis mit Speicherzeitpunkt", async () => {
    for (const value of ["2026-09-24", future()]) {
      const r = run(value);
      const before = Date.now();
      await r.save();
      expect("created_at" in r.persisted[0]).toBe(false);
      const at = Date.parse(r.events[0].createdAt);
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(Date.now());
      cleanups.pop()!();
    }
  });

  test("ohne created_at wie bisher", async () => {
    const r = run(undefined);
    await r.save();
    expect("created_at" in r.persisted[0]).toBe(false);
    expect(Number.isFinite(Date.parse(r.events[0].createdAt))).toBe(true);
  });
});
