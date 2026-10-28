/**
 * Issue #310: Vertrag für Suche, Verlauf, Topic-Aktivität und Meldungen
 * über Supabase. Hielt fest, was die alten Einstiege in supabase.ts taten:
 * Requests an Edge Function und Tabelle, jeder Rückfall der Suche, wann
 * leer geantwortet und wann geworfen wird. Jeder Fall läuft gegen jeden
 * Leser in READERS; seit Issue #382 gibt es die alten Einstiege nicht
 * mehr, es bleibt getStore().messages bzw. die Adapterfabrik. Kein Netz,
 * supabase-js gegen die Fetch-Attrappe.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resetSupabaseClient } from "../src/lib/supabase";
import { NOT_DISPLAY_ONLY_FILTER } from "../src/lib/store/supabase/messages";
import { getStore, resetStore } from "../src/lib/store";
import type { MessageStore } from "../src/lib/store/ports";
import { supabaseMessageReads, TOPIC_ACTIVITY_ROW_LIMIT } from "../src/lib/store/supabase/message-reads";
import { useFakeSupabase, type FakeRequest, type FakeSupabaseOptions } from "./supabase-fixture";

/** Die sechs Methoden, um die es hier geht */
type ReadParts = Pick<
  MessageStore,
  "search" | "history" | "topicActivity" | "displayOnlyPage" | "latestDisplayOnlyAt" | "findDisplayOnlyFile"
>;

/** Ein Weg, dieselben Leser aufzurufen */
interface Reader {
  name: string;
  /** Leser mit dem Client aus der Umgebung; geholt, solange die Attrappe aktiv ist */
  open(): ReadParts;
  /** Leser mit fest vorgegebenem Client (ohne Suche, die liest nur aus der Umgebung) */
  withClient(client: SupabaseClient | null): Omit<ReadParts, "search">;
}

const READERS: Reader[] = [
  {
    name: "getStore().messages",
    open: () => freshStore().messages,
    // getStore() nimmt den Client immer aus der Umgebung; vorgegeben geht er nur über die Adapterfabrik
    withClient: client => supabaseMessageReads(() => client),
  },
];

/** Store neu wählen, damit die Umgebung der Attrappe gilt */
function freshStore() {
  resetStore();
  const store = getStore();
  expect(store.backend).toBe("supabase");
  return store;
}

const NOW = new Date("2026-10-17T09:30:00.000Z");
const DM = "4711";
const GROUP = "-1005550001111";
const SEARCH_PATH = "/functions/v1/search-memory";
const TABLE_PATH = "/rest/v1/messages";
const SECRET = "geheim-7f3a";
/** Zeitpunkt mit Mikrosekunden, wie ihn Postgres liefert */
const MICRO = "2026-10-17T08:15:42.123456+00:00";

const cleanups: (() => void)[] = [];
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  const error = spyOn(console, "error").mockImplementation(() => {});
  cleanups.push(() => warn.mockRestore(), () => error.mockRestore());
});
afterEach(() => {
  resetStore();
  setSystemTime();
  while (cleanups.length) cleanups.pop()!();
});

function fake(options: FakeSupabaseOptions = {}) {
  const f = useFakeSupabase(options);
  cleanups.push(() => f.restore());
  return f;
}

const tableReads = (requests: FakeRequest[]) => requests.filter(r => r.method === "GET" && r.url.pathname === TABLE_PATH);
const edgeCalls = (requests: FakeRequest[]) => requests.filter(r => r.url.pathname === SEARCH_PATH);
const onlyRead = (requests: FakeRequest[]) => {
  const reads = tableReads(requests);
  expect(reads).toHaveLength(1);
  return reads[0].url.searchParams;
};
/** Antwort der Tabelle mit Fehler, Details enthalten ein Geheimnis */
const tableFails = { respond: (r: FakeRequest) => (r.method === "GET" && r.url.pathname === TABLE_PATH ? Response.json({ code: "PGRST301", message: `JWT ${SECRET}` }, { status: 401 }) : undefined) };
/** Client, der schon beim Aufbau der Abfrage wirft */
const throwingClient = {
  from() {
    throw new Error(`Client kaputt ${SECRET}`);
  },
} as unknown as SupabaseClient;

const hit = (id: number, content: string, metadata: Record<string, unknown> | null = {}) => ({
  id,
  chat_id: DM,
  role: "user",
  content,
  metadata,
  created_at: `2026-10-1${id % 7}T10:00:00.000Z`,
});
const NOTICE = hit(9, "Pipeline-Meldung zu Issue 12", { display_only: true, source: "pipeline" });
const TEXT_ROWS = [hit(5, "Neuere Frage zu Issue 12"), NOTICE, hit(2, "Alte Antwort zu Issue 12", null)];
const NOT_NOTICE = `(${NOT_DISPLAY_ONLY_FILTER})`;

/** Prüft die Abfrage der eigenen Textsuche */
function expectTextSearch(params: URLSearchParams, pattern: string, limit: number) {
  expect(params.get("select")).toBe("*");
  expect(params.get("chat_id")).toBe(`eq.${DM}`);
  expect(params.get("content")).toBe(`ilike.${pattern}`);
  expect(params.get("or")).toBe(NOT_NOTICE);
  expect(params.get("order")).toBe("created_at.desc");
  expect(params.get("limit")).toBe(String(limit));
}

for (const reader of READERS) {
  describe(`Suche über ${reader.name}`, () => {
    test("Edge-Erfolg: Treffer der Function, Body mit chat_id, query und limit, Schlüssel in den Köpfen, keine Textsuche", async () => {
      const semantic = [hit(3, "Urlaub im Herbst"), hit(1, "Urlaubsplanung")];
      const f = fake({ edge: name => (name === "search-memory" ? semantic : undefined) });
      expect(await reader.open().search(DM, "Urlaub", 7)).toEqual(semantic);
      expect(f.requests).toHaveLength(1);
      const [call] = edgeCalls(f.requests);
      expect(call.method).toBe("POST");
      expect(JSON.parse(call.body)).toEqual({ chat_id: DM, query: "Urlaub", limit: 7 });
      expect(call.headers.get("content-type")).toBe("application/json");
      expect(call.headers.get("apikey")).toBe("test-service-key");
      expect(call.headers.get("authorization")).toBe("Bearer test-service-key");
    });

    test("Suchtext für die Function auf 8.000 Zeichen gekürzt", async () => {
      const f = fake({ edge: () => [] });
      await reader.open().search(DM, "x".repeat(8_001), 3);
      expect(JSON.parse(edgeCalls(f.requests)[0].body).query).toBe("x".repeat(8_000));
    });

    test("Edge-Antwort mit Meldung: verworfen, eigene Textsuche ohne Meldung", async () => {
      const f = fake({ rows: () => TEXT_ROWS, edge: () => [hit(4, "semantisch"), NOTICE] });
      const result = await reader.open().search(DM, "Issue", 5);
      expect(result.map(m => m.content)).toEqual(["Neuere Frage zu Issue 12", "Alte Antwort zu Issue 12"]);
      expectTextSearch(onlyRead(f.requests), "%Issue%", 5);
    });

    const fallbacks: [string, FakeSupabaseOptions][] = [
      ["Edge 503", {}],
      ["Netzfehler", { respond: r => { if (r.url.pathname === SEARCH_PATH) throw new TypeError("fetch failed"); return undefined; } }],
      ["Antwort ohne Array", { edgeResponse: () => Response.json({ error: "kaputt" }) }],
      ["Antwort ohne JSON", { edgeResponse: () => new Response("kein json", { status: 200 }) }],
    ];
    for (const [label, options] of fallbacks) {
      test(`${label}: eigene Textsuche, Filter in der Abfrage vor order und limit, neueste zuerst, Meldung fehlt`, async () => {
        const f = fake({ rows: () => TEXT_ROWS, ...options });
        const result = await reader.open().search(DM, "Issue", 4);
        expect(edgeCalls(f.requests)).toHaveLength(1);
        expectTextSearch(onlyRead(f.requests), "%Issue%", 4);
        expect(result.map(m => m.content)).toEqual(["Neuere Frage zu Issue 12", "Alte Antwort zu Issue 12"]);
      });
    }

    test("Textsuche maskiert %, _ und \\, die Function bekommt den Suchtext roh", async () => {
      const raw = "100%_sicher\\C:";
      const f = fake({ rows: () => [] });
      expect(await reader.open().search(DM, raw, 3)).toEqual([]);
      expect(JSON.parse(edgeCalls(f.requests)[0].body).query).toBe(raw);
      expectTextSearch(onlyRead(f.requests), "%100\\%\\_sicher\\\\C:%", 3);
    });

    test("Stern bleibt unverändert im Muster (PostgREST liest ihn als %, siehe Pull Request)", async () => {
      const f = fake({ rows: () => [] });
      await reader.open().search(DM, "a*b", 3);
      expectTextSearch(onlyRead(f.requests), "%a*b%", 3);
    });

    test("Textsuche scheitert: leere Liste", async () => {
      fake(tableFails);
      expect(await reader.open().search(DM, "Issue", 5)).toEqual([]);
    });
  });

  describe(`Verlauf über ${reader.name}`, () => {
    const HISTORY = [
      { id: "31", created_at: "2026-10-17T09:00:00.000Z", role: "assistant", content: "neu", metadata: {} },
      { id: "30", created_at: "2026-10-17T08:59:00.000Z", role: "assistant", content: "Meldung", metadata: { display_only: true } },
      { id: "29", created_at: "2026-10-17T08:58:00.000Z", role: "user", content: "alt", metadata: null },
    ];

    test("Topic als Zahl, ohne before: schlanke Spalten, Schlüssel des Topics, neueste abgefragt, älteste zuerst geliefert, Meldung bleibt", async () => {
      const f = fake({ rows: () => HISTORY });
      const rows = await reader.open().history(GROUP, 443, { limit: 50 });
      expect(rows.map(r => r.id)).toEqual(["29", "30", "31"]);
      const params = onlyRead(f.requests);
      expect(params.get("select")).toBe("id,created_at,role,content,metadata");
      expect(params.get("chat_id")).toBe(`eq.${GROUP}`);
      expect(params.get("session_key")).toBe(`eq.topic:${GROUP}:443`);
      expect(params.has("created_at")).toBe(false);
      expect(params.has("or")).toBe(false);
      expect(params.get("order")).toBe("created_at.desc");
      expect(params.get("limit")).toBe("50");
    });

    test("Topic null: group: in der Gruppe, dm: im Direktchat; before filtert auf ältere", async () => {
      const f = fake({ rows: () => [] });
      await reader.open().history(GROUP, null, { limit: 5 });
      await reader.open().history(DM, null, { limit: 51, before: "2026-10-17T08:00:00.000Z" });
      const [group, dm] = tableReads(f.requests).map(r => r.url.searchParams);
      expect(group.get("session_key")).toBe(`eq.group:${GROUP}`);
      expect(dm.get("session_key")).toBe(`eq.dm:${DM}`);
      expect(dm.get("created_at")).toBe("lt.2026-10-17T08:00:00.000Z");
      expect(dm.get("limit")).toBe("51");
    });

    test("Lesefehler: wirft ohne Details, eine Log-Zeile mit Fehlercode", async () => {
      fake(tableFails);
      const error = await reader.open().history(DM, null, { limit: 5 }).catch(e => e);
      expect(error).toBeInstanceOf(Error);
      expect(String(error.message)).not.toContain(SECRET);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("PGRST301");
      expect(String(warn.mock.calls[0][0])).not.toContain(SECRET);
    });

    test("werfender Client: wirft", async () => {
      await expect(reader.withClient(throwingClient).history(DM, null, { limit: 5 })).rejects.toBeInstanceOf(Error);
    });
  });

  describe(`Topic-Aktivität über ${reader.name}`, () => {
    test("eine Abfrage, jüngster Zeitpunkt je Schlüssel, jüngste zuerst, Meldungen zählen mit", async () => {
      setSystemTime(NOW);
      const f = fake({
        rows: () => [
          { session_key: `topic:${GROUP}:7`, created_at: "2026-10-17T09:00:00.000Z" },
          { session_key: `group:${GROUP}`, created_at: "2026-10-17T08:00:00.000Z" },
          { session_key: `topic:${GROUP}:7`, created_at: "2026-10-17T07:00:00.000Z" },
          { session_key: null, created_at: "2026-10-17T06:00:00.000Z" },
          { session_key: `topic:${GROUP}:9`, created_at: MICRO },
        ],
      });
      expect(await reader.open().topicActivity(GROUP, 30)).toEqual([
        { sessionKey: `topic:${GROUP}:7`, lastActivity: "2026-10-17T09:00:00.000Z" },
        { sessionKey: `group:${GROUP}`, lastActivity: "2026-10-17T08:00:00.000Z" },
        { sessionKey: `topic:${GROUP}:9`, lastActivity: MICRO },
      ]);
      const params = onlyRead(f.requests);
      expect(params.get("select")).toBe("session_key,created_at");
      expect(params.get("chat_id")).toBe(`eq.${GROUP}`);
      // 30 mal 24 Stunden, keine Kalendertage
      expect(params.get("created_at")).toBe(`gte.${new Date(NOW.getTime() - 30 * 86_400_000).toISOString()}`);
      expect(params.has("or")).toBe(false);
      expect(params.get("order")).toBe("created_at.desc");
      expect(params.get("limit")).toBe(String(TOPIC_ACTIVITY_ROW_LIMIT));
      expect(TOPIC_ACTIVITY_ROW_LIMIT).toBe(1000);
    });

    test("Lesefehler: leere Liste und eine Log-Zeile mit Fehlercode", async () => {
      fake(tableFails);
      expect(await reader.open().topicActivity(GROUP, 30)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain("PGRST301");
      expect(String(warn.mock.calls[0][0])).not.toContain(SECRET);
    });

    test("werfender Client: leere Liste und eine Log-Zeile", async () => {
      expect(await reader.withClient(throwingClient).topicActivity(GROUP, 30)).toEqual([]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).not.toContain(SECRET);
    });
  });

  describe(`Meldungen über ${reader.name}`, () => {
    const NOTICE_ROW = { id: "88", created_at: MICRO, chat_id: DM, role: "assistant", content: "Datei", metadata: { display_only: true, file: { id: "f-1" } } };

    test("Seite: nur Meldungen der Chats, since, Cursor mit Mikrosekunden, created_at und id aufsteigend", async () => {
      const f = fake({ rows: () => [NOTICE_ROW] });
      const rows = await reader.open().displayOnlyPage([DM, GROUP], { since: "2026-10-16T00:00:00Z", after: { createdAt: MICRO, id: "87" }, limit: 25 });
      expect(rows).toEqual([NOTICE_ROW]);
      expect(rows[0].created_at).toBe(MICRO);
      const params = onlyRead(f.requests);
      expect(params.get("select")).toBe("id,created_at,chat_id,role,content,metadata");
      expect(params.get("chat_id")).toBe(`in.(${DM},${GROUP})`);
      expect(params.get("metadata->>display_only")).toBe("eq.true");
      expect(params.get("created_at")).toBe("gte.2026-10-16T00:00:00Z");
      expect(params.get("or")).toBe(`(created_at.gt."${MICRO}",and(created_at.eq."${MICRO}",id.gt.87))`);
      expect(params.get("order")).toBe("created_at.asc,id.asc");
      expect(params.get("limit")).toBe("25");
    });

    test("Seite ohne since und after: kein Zeitfilter", async () => {
      const f = fake({ rows: () => [] });
      expect(await reader.open().displayOnlyPage([DM], { limit: 3 })).toEqual([]);
      const params = onlyRead(f.requests);
      expect(params.has("created_at")).toBe(false);
      expect(params.has("or")).toBe(false);
    });

    test("ungültiger Zeitpunkt und ungültiger Cursor: Fehler ohne Abfrage", async () => {
      const f = fake({ rows: () => [] });
      const page = reader.open().displayOnlyPage;
      await expect(page([DM], { since: 'x",id.gt.0', limit: 1 })).rejects.toThrow("ungültiger Zeitpunkt");
      await expect(page([DM], { since: "2026-10-17", limit: 1 })).rejects.toThrow("ungültiger Zeitpunkt");
      await expect(page([DM], { after: { createdAt: MICRO, id: "1,id.gt.0" }, limit: 1 })).rejects.toThrow("ungültiger Cursor");
      await expect(page([DM], { after: { createdAt: "gestern", id: "1" }, limit: 1 })).rejects.toThrow("ungültiger Cursor");
      expect(tableReads(f.requests)).toHaveLength(0);
    });

    test("leere chatIds: leer bzw. null ohne Abfrage", async () => {
      const f = fake({ rows: () => [NOTICE_ROW] });
      const parts = reader.open();
      expect(await parts.displayOnlyPage([], { limit: 5 })).toEqual([]);
      expect(await parts.latestDisplayOnlyAt([])).toBeNull();
      expect(await parts.findDisplayOnlyFile("f-1", [])).toBeNull();
      expect(f.requests).toHaveLength(0);
    });

    test("jüngste Meldung: Zeitpunkt unverändert, Abfrage auf Meldungen der Chats, neueste zuerst, eine Zeile", async () => {
      const f = fake({ rows: () => [{ created_at: MICRO }] });
      expect(await reader.open().latestDisplayOnlyAt([DM, GROUP])).toBe(MICRO);
      const params = onlyRead(f.requests);
      expect(params.get("select")).toBe("created_at");
      expect(params.get("chat_id")).toBe(`in.(${DM},${GROUP})`);
      expect(params.get("metadata->>display_only")).toBe("eq.true");
      expect(params.get("order")).toBe("created_at.desc");
      expect(params.get("limit")).toBe("1");
    });

    test("jüngste Meldung: keine Zeile ergibt null", async () => {
      fake({ rows: () => [] });
      expect(await reader.open().latestDisplayOnlyAt([DM])).toBeNull();
    });

    test("Dateinachweis: Meldung mit metadata.file.id nur aus den Chats, neueste zuerst", async () => {
      const f = fake({ rows: () => [NOTICE_ROW] });
      expect(await reader.open().findDisplayOnlyFile("f-1", [GROUP])).toEqual(NOTICE_ROW);
      const params = onlyRead(f.requests);
      expect(params.get("select")).toBe("id,created_at,chat_id,role,content,metadata");
      expect(params.get("chat_id")).toBe(`in.(${GROUP})`);
      expect(params.get("metadata->>display_only")).toBe("eq.true");
      expect(params.get("metadata->file->>id")).toBe("eq.f-1");
      expect(params.get("order")).toBe("created_at.desc");
      expect(params.get("limit")).toBe("1");
    });

    test("Dateinachweis: keine Zeile ergibt null", async () => {
      fake({ rows: () => [] });
      expect(await reader.open().findDisplayOnlyFile("f-2", [DM])).toBeNull();
    });

    test("Lesefehler: alle drei werfen, ohne Details", async () => {
      fake(tableFails);
      const parts = reader.open();
      for (const run of [() => parts.displayOnlyPage([DM], { limit: 5 }), () => parts.latestDisplayOnlyAt([DM]), () => parts.findDisplayOnlyFile("f-1", [DM])]) {
        const error = await run().catch(e => e);
        expect(error).toBeInstanceOf(Error);
        expect(String(error.message)).not.toContain(SECRET);
      }
    });

    test("werfender Client: alle drei werfen", async () => {
      const parts = reader.withClient(throwingClient);
      await expect(parts.displayOnlyPage([DM], { limit: 5 })).rejects.toBeInstanceOf(Error);
      await expect(parts.latestDisplayOnlyAt([DM])).rejects.toBeInstanceOf(Error);
      await expect(parts.findDisplayOnlyFile("f-1", [DM])).rejects.toBeInstanceOf(Error);
    });
  });

  describe(`ohne Supabase über ${reader.name}`, () => {
    test("Suche, Verlauf und Aktivität leer ohne Log, die drei Meldungsleser werfen auch bei leeren chatIds, kein Request", async () => {
      const f = fake();
      const parts = reader.open();
      f.restore();
      cleanups.pop();
      const saved = { url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY, convex: process.env.CONVEX_URL };
      delete process.env.SUPABASE_URL;
      delete process.env.SUPABASE_SERVICE_ROLE_KEY;
      delete process.env.CONVEX_URL;
      resetSupabaseClient();
      const fetchSpy = spyOn(globalThis, "fetch");
      try {
        expect(await parts.search(DM, "Issue", 5)).toEqual([]);
        expect(await parts.history(DM, null, { limit: 5 })).toEqual([]);
        expect(await parts.topicActivity(DM, 30)).toEqual([]);
        expect(warn).not.toHaveBeenCalled();
        for (const chatIds of [[DM], []]) {
          await expect(parts.displayOnlyPage(chatIds, { limit: 5 })).rejects.toThrow("Supabase nicht eingerichtet");
          await expect(parts.latestDisplayOnlyAt(chatIds)).rejects.toThrow("Supabase nicht eingerichtet");
          await expect(parts.findDisplayOnlyFile("f-1", chatIds)).rejects.toThrow("Supabase nicht eingerichtet");
        }
        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
        if (saved.url !== undefined) process.env.SUPABASE_URL = saved.url;
        if (saved.key !== undefined) process.env.SUPABASE_SERVICE_ROLE_KEY = saved.key;
        if (saved.convex !== undefined) process.env.CONVEX_URL = saved.convex;
        resetSupabaseClient();
      }
    });

    test("ohne Client übergeben: Verlauf und Aktivität leer, Meldungsleser werfen", async () => {
      const parts = reader.withClient(null);
      expect(await parts.history(DM, 1, { limit: 5 })).toEqual([]);
      expect(await parts.topicActivity(DM, 30)).toEqual([]);
      await expect(parts.displayOnlyPage([], { limit: 5 })).rejects.toThrow("Supabase nicht eingerichtet");
      await expect(parts.latestDisplayOnlyAt([])).rejects.toThrow("Supabase nicht eingerichtet");
      await expect(parts.findDisplayOnlyFile("f-1", [])).rejects.toThrow("Supabase nicht eingerichtet");
    });
  });
}
