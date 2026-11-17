// Supabase-Egress der Telegram-Liste (Issue #684): Die letzte Aktivität je
// Topic bleibt im Prozess und wird nur fortgeschrieben, ein einzelnes
// Nachschlagen löst keine Abfrage über den ganzen Zeitraum aus. Echter
// supabase-js-Client gegen die Tabellen-Attrappe (egress-fixture.ts), die
// jede Abfrage mit Spalten, Zeilenzahl und Größe festhält.
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getStore } from "../src/lib/store";
import { TOPIC_ACTIVITY_ROW_LIMIT } from "../src/lib/store/supabase/message-reads";
import { ACTIVITY_SINCE_DAYS, createBotTelegram, createTelegramSource, type BotTelegramDeps } from "../src/web/bot-telegram";
import { createWebServer, type WebServer } from "../src/web/server";
import { normalizeIsoTimestamp } from "../src/web/telegram";
import { ACTIVITY_FULL_RELOAD_MS, ACTIVITY_LOOKBACK_MS } from "../src/web/telegram-activity";
import { fakeMessagesTable, totalBytes, type FakeMessagesTable, type TableRead, type TableRow } from "./egress-fixture";

const USER = "4711";
const GROUP = "-1001234567890";
const DAY_MS = 24 * 60 * 60 * 1000;
const PASSWORD = "test-passwort-lang";
/** Abstand zwischen Testnachrichten: größer als der Rückblick, damit im Ruhezustand genau eine Zeile im Fenster liegt */
const GAP_MS = 2 * ACTIVITY_LOOKBACK_MS;

const cleanups: (() => void | Promise<void>)[] = [];
let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
  warn.mockRestore();
});

function setup(overrides: Partial<BotTelegramDeps> = {}, start?: string) {
  const table = start ? fakeMessagesTable(start) : fakeMessagesTable();
  cleanups.push(() => table.restore());
  const logs: string[] = [];
  const messages = () => getStore().messages;
  const source = createTelegramSource({
    userId: USER,
    groupId: () => GROUP,
    topicNames: async () => ({ "8": "Recherche", "443": "Finanzen" }),
    topicMapping: () => ({}),
    history: (chatId, topicId, options) => messages().history(chatId, topicId, options),
    activity: (chatId, sinceDays) => messages().topicActivity(chatId, sinceDays),
    activitySince: (chatId, since) => messages().topicActivitySince(chatId, since),
    // Die Uhr der Quelle ist die der Datenbank-Attrappe
    now: () => table.dbNowMs(),
    log: m => logs.push(m),
    ...overrides,
  });
  return { table, source, logs };
}

/** Nachricht in Direktchat, General oder ein Topic; danach läuft die Datenbank-Uhr weiter */
function say(table: FakeMessagesTable, where: "dm" | "general" | number, options: { at?: string } = {}): TableRow {
  const row =
    where === "dm"
      ? table.insert({ chat_id: USER, session_key: `dm:${USER}`, role: "user", content: "Hallo im Direktchat" }, options)
      : table.insert(
          { chat_id: GROUP, session_key: where === "general" ? `group:${GROUP}` : `topic:${GROUP}:${where}`, role: "user", content: `Hallo in ${where}` },
          options
        );
  table.tickDb(GAP_MS);
  return row;
}

const iso = (row: TableRow) => normalizeIsoTimestamp(row.created_at);
const activityReads = (reads: TableRead[]) => reads.filter(r => r.select === "session_key,created_at");
const chatOf = (read: TableRead) => read.params.get("chat_id")!.slice("eq.".length);
const boundMs = (read: TableRead) => Date.parse(read.params.get("created_at")!.slice("gte.".length));
/** Abfrage über den ganzen Zeitraum (60 Tage), im Unterschied zum Fortschreiben */
const wholeWindow = (table: FakeMessagesTable, read: TableRead) => table.dbNowMs() - boundMs(read) > (ACTIVITY_SINCE_DAYS - 1) * DAY_MS;

/** Viele ältere Nachrichten in der Gruppe, mehr als das Zeilenlimit der Aktivitätsabfrage */
function fillGroup(table: FakeMessagesTable, count = TOPIC_ACTIVITY_ROW_LIMIT + 200) {
  for (let i = 0; i < count; i++) {
    table.insert({ chat_id: GROUP, session_key: `topic:${GROUP}:${700 + (i % 5)}`, role: "user", content: `alt ${i}` });
    table.tickDb(1000);
  }
  table.tickDb(10 * GAP_MS);
}

describe("Telegram-Liste: letzte Aktivität im Prozess (Issue #684)", () => {
  test("erste Liste liest den Zeitraum je Chat einmal, nur session_key und created_at", async () => {
    const { table, source } = setup();
    fillGroup(table);
    const finance = say(table, 443);
    const dm = say(table, "dm");
    const list = await source.listConversations();
    expect(list.dm?.lastActivity).toBe(iso(dm));
    expect(list.topics[0]).toMatchObject({ id: "topic-443", lastActivity: iso(finance) });
    const reads = activityReads(table.reads);
    expect(reads.map(chatOf).sort()).toEqual([GROUP, USER].sort());
    expect(table.reads).toHaveLength(2);
    for (const read of reads) {
      expect(wholeWindow(table, read)).toBe(true);
      expect(read.params.get("order")).toBe("created_at.desc");
      expect(read.params.get("limit")).toBe(String(TOPIC_ACTIVITY_ROW_LIMIT));
    }
    expect(reads.find(r => chatOf(r) === GROUP)!.rows).toBe(TOPIC_ACTIVITY_ROW_LIMIT);
  });

  test("Ruhezustand: weitere Listen schreiben nur fort, eine Zeile je Chat statt der jüngsten 1.000", async () => {
    const { table, source } = setup();
    fillGroup(table);
    say(table, 443);
    say(table, "dm");
    const first = await source.listConversations();
    const fullBytes = totalBytes(table.reads);
    expect(fullBytes).toBeGreaterThan(50_000);

    const mark = table.mark();
    const takte = 20;
    for (let i = 0; i < takte; i++) {
      table.tickDb(15_000);
      expect(await source.listConversations()).toEqual(first);
    }
    const idle = table.since(mark);
    expect(idle).toHaveLength(takte * 2);
    for (const read of idle) {
      expect(read.select).toBe("session_key,created_at");
      expect(wholeWindow(table, read)).toBe(false);
      expect(read.rows).toBe(1);
    }
    // Zwanzig Listen kosten zusammen weniger als ein Zehntel einer einzigen Liste von früher
    expect(totalBytes(idle)).toBeLessThan(takte * 2 * 150);
    expect(totalBytes(idle)).toBeLessThan(fullBytes / 10);
  });

  test("Fortschreiben beginnt beim Rückblick hinter der jüngsten bekannten Nachricht des Chats", async () => {
    const { table, source } = setup();
    const finance = say(table, 443);
    const dm = say(table, "dm");
    await source.listConversations();
    const mark = table.mark();
    await source.listConversations();
    const reads = table.since(mark);
    const expected = (row: TableRow) => Math.floor(Date.parse(iso(row)!) - ACTIVITY_LOOKBACK_MS);
    expect(boundMs(reads.find(r => chatOf(r) === GROUP)!)).toBe(expected(finance));
    expect(boundMs(reads.find(r => chatOf(r) === USER)!)).toBe(expected(dm));
  });

  test("einzelnes Nachschlagen ohne Aktivität und der Verlauf lösen keine Aktivitätsabfrage aus", async () => {
    const { table, source } = setup();
    fillGroup(table);
    const finance = say(table, 443);
    say(table, "dm");

    // Vor der ersten Liste: das Gespräch gibt es, die Aktivität ist unbekannt
    expect(await source.getConversation("topic-443", { activity: false })).toMatchObject({ id: "topic-443", title: "Finanzen", lastActivity: null });
    expect(await source.getConversation("dm", { activity: false })).toMatchObject({ id: "dm", lastActivity: null });
    expect((await source.history("topic-443"))!.messages).toHaveLength(1);
    expect(activityReads(table.reads)).toHaveLength(0);
    expect(table.reads.map(r => r.select)).toEqual(["id,created_at,role,content,metadata"]);

    // Nach einer Liste: der bekannte Stand, weiter ohne Abfrage
    await source.listConversations();
    const mark = table.mark();
    for (let i = 0; i < 25; i++) {
      expect((await source.getConversation("topic-443", { activity: false }))?.lastActivity).toBe(iso(finance));
      expect(await source.getConversation("topic-8", { activity: false })).toMatchObject({ id: "topic-8", lastActivity: null });
      expect(await source.getConversation("topic-99999", { activity: false })).toBeNull();
    }
    expect(table.since(mark)).toHaveLength(0);
    await source.history("dm");
    await source.history("topic-443");
    expect(activityReads(table.since(mark))).toHaveLength(0);
    expect(table.since(mark)).toHaveLength(2);
  });

  test("einzelnes Nachschlagen mit Aktivität frischt nur den einen Chat auf und liest den Zeitraum nicht neu", async () => {
    const { table, source } = setup();
    fillGroup(table);
    say(table, 443);
    say(table, "dm");
    await source.listConversations();
    const mark = table.mark();

    const later = say(table, 443);
    expect((await source.getConversation("topic-443"))?.lastActivity).toBe(iso(later));
    const laterDm = say(table, "dm");
    expect((await source.getConversation("dm"))?.lastActivity).toBe(iso(laterDm));

    const reads = table.since(mark);
    expect(reads.map(chatOf)).toEqual([GROUP, USER]);
    for (const read of reads) {
      expect(wholeWindow(table, read)).toBe(false);
      expect(read.rows).toBeLessThanOrEqual(2);
    }
  });

  test("allererstes Nachschlagen mit Aktivität liest nur den Chat des Gesprächs", async () => {
    const { table, source } = setup();
    const finance = say(table, 443);
    say(table, "dm");
    expect((await source.getConversation("topic-443"))?.lastActivity).toBe(iso(finance));
    expect(table.reads.map(chatOf)).toEqual([GROUP]);
  });

  test("neue Nachricht aus einem anderen Prozess: die nächste Liste zeigt Aktivität und Reihenfolge", async () => {
    const { table, source } = setup();
    say(table, 8);
    say(table, 443);
    expect((await source.listConversations()).topics.map(t => t.id)).toEqual(["topic-443", "topic-8", "topic-1"]);

    const research = say(table, 8);
    const general = say(table, "general");
    const unnamed = say(table, 900);
    const list = await source.listConversations();
    expect(list.topics.map(t => t.id)).toEqual(["topic-900", "topic-1", "topic-8", "topic-443"]);
    expect(list.topics.map(t => t.lastActivity).slice(0, 3)).toEqual([iso(unnamed), iso(general), iso(research)]);
    expect(list.topics[0].title).toBe("Topic 900");
  });

  test("spät sichtbare Zeile mit älterem Zeitpunkt im Rückblick zählt", async () => {
    const { table, source } = setup();
    const finance = say(table, 443);
    await source.listConversations();
    // Früher begonnene Transaktion, erst jetzt sichtbar: created_at liegt vor der bekannten jüngsten Zeile
    const late = new Date(Date.parse(iso(finance)!) - ACTIVITY_LOOKBACK_MS / 2).toISOString();
    say(table, 8, { at: late });
    const list = await source.listConversations();
    expect(list.topics.map(t => [t.id, t.lastActivity])).toEqual([
      ["topic-443", iso(finance)],
      ["topic-8", late],
      ["topic-1", null],
    ]);
  });

  test("nach ACTIVITY_FULL_RELOAD_MS liest die nächste Liste den Zeitraum neu, Gelöschtes verschwindet", async () => {
    const { table, source } = setup();
    const research = say(table, 8);
    const finance = say(table, 443);
    say(table, "dm");
    await source.listConversations();
    table.remove(research.id);

    table.tickDb(ACTIVITY_FULL_RELOAD_MS - 10 * GAP_MS);
    let mark = table.mark();
    expect((await source.listConversations()).topics.find(t => t.id === "topic-8")?.lastActivity).toBe(iso(research));
    expect(table.since(mark).some(r => wholeWindow(table, r))).toBe(false);

    table.tickDb(10 * GAP_MS);
    mark = table.mark();
    const list = await source.listConversations();
    expect(table.since(mark).map(r => wholeWindow(table, r))).toEqual([true, true]);
    expect(list.topics.find(t => t.id === "topic-8")?.lastActivity).toBeNull();
    expect(list.topics.find(t => t.id === "topic-443")?.lastActivity).toBe(iso(finance));

    // Danach wieder nur fortschreiben
    mark = table.mark();
    await source.listConversations();
    expect(table.since(mark).some(r => wholeWindow(table, r))).toBe(false);
  });

  test("jüngste bekannte Zeile gelöscht: die leere Antwort führt zum Neulesen des Zeitraums", async () => {
    const { table, source } = setup();
    const research = say(table, 8);
    const finance = say(table, 443);
    await source.listConversations();
    table.remove(finance.id);
    const mark = table.mark();
    const list = await source.listConversations();
    expect(list.topics.map(t => [t.id, t.lastActivity])).toEqual([
      ["topic-8", iso(research)],
      ["topic-443", null],
      ["topic-1", null],
    ]);
    const group = table.since(mark).filter(r => chatOf(r) === GROUP);
    expect(group.map(r => wholeWindow(table, r))).toEqual([false, true]);
  });

  test("mehr neue Zeilen als das Zeilenlimit: Zeitraum neu lesen statt Sitzungen zu übersehen", async () => {
    const { table, source } = setup();
    say(table, 443);
    await source.listConversations();
    table.insert({ chat_id: GROUP, session_key: `topic:${GROUP}:8`, role: "user", content: "früh" });
    let newest: TableRow | undefined;
    for (let i = 0; i < TOPIC_ACTIVITY_ROW_LIMIT; i++) newest = table.insert({ chat_id: GROUP, session_key: `topic:${GROUP}:443`, role: "user", content: `viel ${i}` });
    const mark = table.mark();
    const list = await source.listConversations();
    const group = table.since(mark).filter(r => chatOf(r) === GROUP);
    expect(group.map(r => [wholeWindow(table, r), r.rows])).toEqual([
      [false, TOPIC_ACTIVITY_ROW_LIMIT],
      [true, TOPIC_ACTIVITY_ROW_LIMIT],
    ]);
    expect(list.topics.find(t => t.id === "topic-443")?.lastActivity).toBe(iso(newest!));
    // Wie vor Issue #684: Topic 8 liegt hinter den jüngsten 1.000 Zeilen und gilt als unbekannt
    expect(list.topics.find(t => t.id === "topic-8")?.lastActivity).toBeNull();
  });

  test("Lesefehler nach gelungenem Start: der Stand von vorher gilt, eine Log-Zeile, danach wieder frisch", async () => {
    const { table, source, logs } = setup();
    say(table, 443);
    say(table, "dm");
    const before = await source.listConversations();
    const research = say(table, 8);
    table.failNext(2);
    expect(await source.listConversations()).toEqual(before);
    expect(logs.filter(l => l.includes("Telegram-Aktivität nicht aufgefrischt"))).toHaveLength(2);
    expect(logs.join("\n")).not.toContain("Attrappe");

    const list = await source.listConversations();
    expect(list.topics[0]).toMatchObject({ id: "topic-8", lastActivity: iso(research) });
    expect(logs).toHaveLength(2);
  });

  test("Lesefehler beim ersten Lesen: Aktivität unbekannt, Log-Zeile, der nächste Aufruf liest den Zeitraum", async () => {
    const { table, source, logs } = setup();
    const finance = say(table, 443);
    const dm = say(table, "dm");
    table.failNext(2);
    const failed = await source.listConversations();
    expect(failed.dm?.lastActivity).toBeNull();
    expect(failed.topics.map(t => t.lastActivity)).toEqual([null, null, null]);
    expect(logs.filter(l => l.includes("Telegram-Aktivität nicht lesbar"))).toHaveLength(2);

    const mark = table.mark();
    const list = await source.listConversations();
    expect(list.dm?.lastActivity).toBe(iso(dm));
    expect(list.topics[0]).toMatchObject({ id: "topic-443", lastActivity: iso(finance) });
    expect(table.since(mark).map(r => wholeWindow(table, r))).toEqual([true, true]);
  });

  test("gleichzeitige erste Aufrufe teilen sich das Lesen des Zeitraums", async () => {
    const { table, source } = setup();
    fillGroup(table);
    const finance = say(table, 443);
    const lists = await Promise.all(Array.from({ length: 6 }, () => source.listConversations()));
    for (const list of lists) expect(list.topics[0]).toMatchObject({ id: "topic-443", lastActivity: iso(finance) });
    const whole = table.reads.filter(r => wholeWindow(table, r));
    expect(whole.map(chatOf).sort()).toEqual([GROUP, USER].sort());
  });

  test("älter als der Zeitraum gilt als unbekannt, auch im gehaltenen Stand", async () => {
    const { table, source } = setup();
    const old = say(table, 443);
    await source.listConversations();
    table.tickDb(ACTIVITY_SINCE_DAYS * DAY_MS - 20 * GAP_MS);
    expect((await source.getConversation("topic-443", { activity: false }))?.lastActivity).toBe(iso(old));
    table.tickDb(40 * GAP_MS);
    expect((await source.getConversation("topic-443", { activity: false }))?.lastActivity).toBeNull();
    expect((await source.listConversations()).topics.find(t => t.id === "topic-443")?.lastActivity).toBeNull();
  });

  test("ohne activitySince bleibt es beim alten Weg, das Nachschlagen ohne Aktivität fragt trotzdem nicht ab", async () => {
    // Der alte Weg rechnet den Zeitraum im Speicher mit der echten Uhr, nicht mit der Uhr der Quelle.
    // Die Datenbank-Attrappe startet hier deshalb kurz vor jetzt statt am festen Datum: mit dem festen
    // Datum scheiterte der Test, sobald die echte Uhr mehr als einen Tag weiter war (CI vom 17.11.2026).
    const { table, source } = setup({ activitySince: undefined }, new Date(Date.now() - 60 * 60 * 1000).toISOString());
    const finance = say(table, 443);
    await source.listConversations();
    await source.listConversations();
    expect(table.reads.map(r => wholeWindow(table, r))).toEqual([true, true, true, true]);
    const mark = table.mark();
    expect((await source.getConversation("topic-443", { activity: false }))?.lastActivity).toBe(iso(finance));
    expect(table.since(mark)).toHaveLength(0);
  });
});

describe("Verdrahtung des Bots (createBotTelegram)", () => {
  test("die echte Quelle schreibt fort: zweite Liste ohne Abfrage über den Zeitraum", async () => {
    const table = fakeMessagesTable(new Date(Date.now() - 60 * 60 * 1000).toISOString());
    cleanups.push(() => table.restore());
    say(table, 443);
    say(table, "dm");
    const source = createBotTelegram({ TELEGRAM_BOT_TOKEN: "123:test", TELEGRAM_USER_ID: USER, TELEGRAM_GROUP_ID: GROUP }, () => {});
    const whole = (read: TableRead) => Date.now() - boundMs(read) > (ACTIVITY_SINCE_DAYS - 1) * DAY_MS;
    await source.listConversations();
    expect(activityReads(table.reads).map(whole)).toEqual([true, true]);
    const mark = table.mark();
    await source.listConversations();
    await source.history("topic-443");
    const later = activityReads(table.since(mark));
    expect(later.map(whole)).toEqual([false, false]);
    expect(later.map(r => r.rows)).toEqual([1, 1]);
  });
});

describe("Server: der Abgleich eines offenen Tabs (Issue #684)", () => {
  const servers: WebServer[] = [];
  let root = "";
  afterEach(async () => {
    for (const server of servers.splice(0)) await server.stop();
  });
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  test("Liste, Gespräch, Verlauf und Ziel: nur die Liste und der Abruf des Gesprächs fragen Aktivität ab, und nur wenige Zeilen", async () => {
    root ||= await mkdtemp(join(tmpdir(), "tybo-web-egress-"));
    const { table, source } = setup();
    fillGroup(table);
    const finance = say(table, 443);
    say(table, "dm");
    const server = await createWebServer(
      { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
      { sessionFile: join(root, "web-sessions.json"), dataDir: join(root, "web"), telegram: source, log: () => {} }
    );
    servers.push(server);
    const login = await fetch(`${server.url}/api/login`, { method: "POST", headers: { origin: server.url }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const get = (path: string) => fetch(`${server.url}${path}`, { headers: { cookie, origin: server.url } });

    // Erster Abruf nach dem Start: einmal der ganze Zeitraum
    expect((await get("/api/conversations")).status).toBe(200);
    expect(activityReads(table.reads).map(r => wholeWindow(table, r))).toEqual([true, true]);

    // Danach ein Abgleich, wie ihn ein offener Tab etwa jede halbe Stunde auslöst
    const mark = table.mark();
    const listed = await (await get("/api/conversations")).json();
    expect(listed.telegram.topics[0]).toMatchObject({ id: "topic-443", lastActivity: iso(finance) });
    const single = await (await get("/api/conversations/topic-443")).json();
    expect(single.conversation).toMatchObject({ id: "topic-443", lastActivity: iso(finance) });
    const history = await (await get("/api/conversations/topic-443/messages")).json();
    expect(history.messages).toHaveLength(1);
    expect((await get("/api/conversations/topic-443/goal")).status).toBe(200);
    expect((await get("/api/conversations/topic-99999/messages")).status).toBe(404);

    const reads = table.since(mark);
    const activity = activityReads(reads);
    // Liste: Gruppe und Direktchat; Abruf des Gesprächs: nur die Gruppe; Verlauf, Ziel und 404: nichts
    expect(activity.map(chatOf).sort()).toEqual([GROUP, GROUP, USER].sort());
    for (const read of activity) {
      expect(wholeWindow(table, read)).toBe(false);
      expect(read.rows).toBe(1);
    }
    expect(reads.filter(r => r.select !== "session_key,created_at").map(r => r.select)).toEqual(["id,created_at,role,content,metadata"]);
    expect(totalBytes(activity)).toBeLessThan(500);
  });
});
