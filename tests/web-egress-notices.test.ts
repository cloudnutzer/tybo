// Supabase-Egress des Meldungs-Abholers (Issue #684): Der Abholer fragt im
// Rückblick-Fenster erst nur id und created_at ab und lädt Text und Metadaten
// nur für Meldungen, die er noch nicht gesehen hat. Echter supabase-js-Client
// gegen die Tabellen-Attrappe (egress-fixture.ts), die jede Abfrage mit
// Spalten, Zeilenzahl und Größe festhält; die Uhr des Zeitgebers wird von
// Hand weitergeschaltet. src/bot.ts wird nie importiert.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { MessageSavedListener } from "../src/lib/store/events";
import { getStore } from "../src/lib/store";
import {
  createBotTelegramLive,
  createTelegramLiveFeed,
  DISPLAY_ONLY_LOOKBACK_MS,
  DISPLAY_ONLY_PAGE_SIZE,
  DISPLAY_ONLY_POLL_MS,
  type TelegramLiveDeps,
} from "../src/web/bot-telegram";
import type { TelegramLiveEvent } from "../src/web/telegram";
import { fakeMessagesTable, totalBytes, type FakeMessagesTable, type TableRead, type TableRow } from "./egress-fixture";

const USER = "4711";
const GROUP = "-1001234567890";
const HEAD_COLUMNS = "id,created_at";
const FULL_COLUMNS = "id,created_at,chat_id,role,content,metadata";

const cleanups: (() => void)[] = [];
let warn: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  warn.mockRestore();
});

/** Kontrollierte Uhr für den Zeitgeber des Feeds */
function fakeClock() {
  const timers: { ms: number; fn: () => Promise<void>; stopped: boolean }[] = [];
  return {
    every(ms: number, fn: () => Promise<void>) {
      const timer = { ms, fn, stopped: false };
      timers.push(timer);
      return () => {
        timer.stopped = true;
      };
    },
    /** Ein Takt: jede laufende Abfrage einmal, bis sie fertig ist */
    async tick() {
      for (const timer of timers) if (!timer.stopped) await timer.fn();
    },
  };
}

function setup(extra: Partial<TelegramLiveDeps> = {}, poll: Partial<NonNullable<TelegramLiveDeps["displayOnly"]>> = {}) {
  const table = fakeMessagesTable();
  cleanups.push(() => table.restore());
  const clock = fakeClock();
  const hooks = new Set<MessageSavedListener>();
  const logs: string[] = [];
  const events: TelegramLiveEvent[] = [];
  const messages = () => getStore().messages;
  const feed = createTelegramLiveFeed({
    userId: USER,
    groupId: () => GROUP,
    onMessageSaved: listener => {
      hooks.add(listener);
      return () => void hooks.delete(listener);
    },
    displayOnly: {
      latestAt: chatIds => messages().latestDisplayOnlyAt(chatIds),
      heads: (chatIds, options) => messages().displayOnlyHeads(chatIds, options),
      rows: (chatIds, ids) => messages().displayOnlyRows(chatIds, ids),
      every: (ms, fn) => clock.every(ms, fn),
      now: () => table.dbNow(),
      ...poll,
    },
    log: m => logs.push(m),
    ...extra,
  });
  /** Zuhören und warten, bis die Abfrage beim Start durch ist; danach ist jeder tick() genau eine Abfrage */
  async function start() {
    cleanups.push(feed.subscribe(e => events.push(e)));
    await clock.tick();
  }
  return { table, clock, feed, hooks, logs, events, start, texts: () => events.map(e => e.message?.text) };
}

/** Meldung eines anderen Prozesses: wie saveMessageWith (msgId), aber ohne Hook in diesem Prozess */
function notice(table: FakeMessagesTable, text: string, options: { at?: string; topicId?: number; chatId?: string; msgId?: string } = {}): TableRow {
  const chatId = options.chatId ?? (options.topicId ? GROUP : USER);
  return table.insert(
    {
      chat_id: chatId,
      role: "assistant",
      content: text,
      metadata: {
        display_only: true,
        source: "pipeline",
        msgId: options.msgId ?? crypto.randomUUID(),
        ...(options.topicId ? { topicId: options.topicId } : {}),
      },
    },
    options.at ? { at: options.at } : {}
  );
}

const withText = (reads: TableRead[]) => reads.filter(r => r.select.includes("content") || r.select === "*");
const heads = (reads: TableRead[]) => reads.filter(r => r.select === HEAD_COLUMNS);
const idsOf = (read: TableRead) => /^in\.\((.*)\)$/.exec(read.params.get("id") ?? "")?.[1].split(",") ?? [];

describe("Meldungs-Abholer: Text nur für neue Meldungen (Issue #684)", () => {
  test("Start: Startstand und Köpfe, kein Nachrichtentext, auch wenn alte Meldungen im Fenster liegen", async () => {
    const { table, start, events } = setup();
    notice(table, "alt, lange her");
    table.tickDb(10 * DISPLAY_ONLY_LOOKBACK_MS);
    notice(table, "alt, im Fenster");
    table.tickDb(5_000);
    notice(table, "alt, die jüngste", { topicId: 443 });
    table.tickDb(5_000);
    await start();

    expect(table.reads.map(r => r.select)).toEqual(["created_at", HEAD_COLUMNS]);
    const [latest, page] = table.reads;
    expect(latest.params.get("limit")).toBe("1");
    expect(page.rows).toBe(2);
    expect(page.params.get("chat_id")).toBe(`in.(${USER},${GROUP})`);
    expect(page.params.get("metadata->>display_only")).toBe("eq.true");
    expect(page.params.get("order")).toBe("created_at.asc,id.asc");
    expect(page.params.get("limit")).toBe(String(DISPLAY_ONLY_PAGE_SIZE));
    expect(withText(table.reads)).toHaveLength(0);
    expect(events).toEqual([]);
  });

  test("Ruhezustand über viele Takte: je Takt eine Abfrage, nur id und created_at, kein Text", async () => {
    const { table, clock, start, texts } = setup();
    notice(table, "alt");
    table.tickDb(1_000);
    await start();
    const long = "x".repeat(9_000);
    notice(table, long);
    await clock.tick();
    expect(texts()).toEqual([long]);

    const mark = table.mark();
    const takte = 40;
    for (let i = 0; i < takte; i++) {
      table.tickDb(DISPLAY_ONLY_POLL_MS);
      await clock.tick();
    }
    const idle = table.since(mark);
    expect(idle).toHaveLength(takte);
    for (const read of idle) {
      expect(read.select).toBe(HEAD_COLUMNS);
      // Die zuletzt gesehenen Meldungen liegen dauerhaft im Rückblick-Fenster
      expect(read.rows).toBe(2);
      expect(read.params.get("created_at")).toMatch(/^gte\./);
    }
    expect(withText(idle)).toHaveLength(0);
    // Früher kam die 9-KB-Meldung in jedem Takt neu: 40 Takte wären rund 360 KB
    expect(totalBytes(idle)).toBeLessThan(takte * 150);
    expect(texts()).toEqual([long]);
  });

  test("neue Meldung: Text genau einmal geladen, nur für diese Zeile, genau einmal gemeldet", async () => {
    const { table, clock, start, events } = setup();
    notice(table, "alt");
    table.tickDb(1_000);
    await start();
    table.tickDb(DISPLAY_ONLY_POLL_MS);
    const fresh = notice(table, "Pipeline fertig", { topicId: 443 });

    let mark = table.mark();
    await clock.tick();
    const reads = table.since(mark);
    expect(reads.map(r => r.select)).toEqual([HEAD_COLUMNS, FULL_COLUMNS]);
    expect(reads[0].rows).toBe(2);
    expect(idsOf(reads[1])).toEqual([String(fresh.id)]);
    expect(reads[1].rows).toBe(1);
    expect(reads[1].params.get("chat_id")).toBe(`in.(${USER},${GROUP})`);
    expect(reads[1].params.get("metadata->>display_only")).toBe("eq.true");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ conversationId: "topic-443", message: { text: "Pipeline fertig", id: fresh.metadata!.msgId } });

    mark = table.mark();
    for (let i = 0; i < 5; i++) await clock.tick();
    expect(table.since(mark).map(r => r.select)).toEqual(Array(5).fill(HEAD_COLUMNS));
    expect(events).toHaveLength(1);
  });

  test("Meldung im Rückblick-Fenster: spät sichtbare Zeile mit älterem Zeitpunkt wird geladen, die bekannte daneben nicht noch einmal", async () => {
    const { table, clock, start, texts } = setup();
    await start();
    const known = notice(table, "später begonnen");
    await clock.tick();
    expect(texts()).toEqual(["später begonnen"]);

    const earlier = new Date(Date.parse(known.created_at.replace(/\.(\d{3})\d{3}\+00:00$/, ".$1Z")) - DISPLAY_ONLY_LOOKBACK_MS / 2).toISOString();
    const late = notice(table, "früher begonnen, später sichtbar", { at: earlier });
    const mark = table.mark();
    await clock.tick();
    const reads = table.since(mark);
    expect(reads.map(r => r.select)).toEqual([HEAD_COLUMNS, FULL_COLUMNS]);
    expect(idsOf(reads[1])).toEqual([String(late.id)]);
    expect(texts()).toEqual(["später begonnen", "früher begonnen, später sichtbar"]);

    await clock.tick();
    expect(texts()).toHaveLength(2);
  });

  test("Seitenwechsel: mehr neue Meldungen als eine Seite, jede einmal gemeldet, Text nur für neue Zeilen", async () => {
    const { table, clock, start, events } = setup();
    notice(table, "alt");
    table.tickDb(1_000);
    await start();
    const at = table.dbNow();
    const total = DISPLAY_ONLY_PAGE_SIZE * 2 + 17;
    for (let i = 0; i < total; i++) notice(table, `m${i}`, { at });

    let mark = table.mark();
    await clock.tick();
    let reads = table.since(mark);
    // Drei Seiten Köpfe (die alte Meldung liegt mit im Fenster), nach jeder der Text ihrer neuen Zeilen
    expect(reads.map(r => r.select)).toEqual([HEAD_COLUMNS, FULL_COLUMNS, HEAD_COLUMNS, FULL_COLUMNS, HEAD_COLUMNS, FULL_COLUMNS]);
    expect(heads(reads).map(r => r.rows)).toEqual([DISPLAY_ONLY_PAGE_SIZE, DISPLAY_ONLY_PAGE_SIZE, 18]);
    expect(heads(reads).map(r => r.params.has("or"))).toEqual([false, true, true]);
    expect(withText(reads).map(r => r.rows)).toEqual([DISPLAY_ONLY_PAGE_SIZE - 1, DISPLAY_ONLY_PAGE_SIZE, 18]);
    expect(events).toHaveLength(total);
    expect(new Set(events.map(e => e.message!.id)).size).toBe(total);
    expect(events.map(e => e.message!.text)).toEqual(Array.from({ length: total }, (_, i) => `m${i}`));

    // Nächster Takt: dieselben Seiten liegen noch im Fenster, aber kein Text mehr
    mark = table.mark();
    await clock.tick();
    reads = table.since(mark);
    expect(reads.map(r => r.select)).toEqual([HEAD_COLUMNS, HEAD_COLUMNS, HEAD_COLUMNS]);
    expect(events).toHaveLength(total);
  });

  test("mehr als zehn Seiten alter Meldungen beim Start: kein Text, nichts gemeldet, die neue danach schon", async () => {
    const { table, clock, start, texts } = setup();
    const at = table.dbNow();
    const total = DISPLAY_ONLY_PAGE_SIZE * 10 + 1;
    for (let i = 0; i < total; i++) notice(table, `alt ${i}`, { at });
    table.tickDb(1_000);
    await start();
    // Seitenlimit: die erste Abfrage hört nach zehn Seiten auf, die zweite liest den Rest
    expect(heads(table.reads)).toHaveLength(10);
    await clock.tick();
    expect(heads(table.reads)).toHaveLength(11);
    expect(heads(table.reads)[10].rows).toBe(1);
    expect(withText(table.reads)).toHaveLength(0);
    expect(texts()).toEqual([]);

    table.tickDb(1_000);
    const fresh = notice(table, "neu");
    await clock.tick();
    await clock.tick();
    expect(texts()).toEqual(["neu"]);
    const loaded = withText(table.reads);
    expect(loaded).toHaveLength(1);
    expect(idsOf(loaded[0])).toEqual([String(fresh.id)]);
  });

  test("Text nicht ladbar: der Stand bleibt, die nächste Abfrage meldet die Meldung, genau einmal", async () => {
    const { table, clock, start, texts, logs } = setup();
    await start();
    notice(table, "kommt trotzdem");
    table.failIf(params => (params.get("select") ?? "").includes("content"));
    await clock.tick();
    await clock.tick();
    expect(texts()).toEqual([]);
    expect(logs.filter(l => l.includes("Meldungen nicht abrufbar"))).toHaveLength(1);

    table.failIf(null);
    await clock.tick();
    expect(texts()).toEqual(["kommt trotzdem"]);
    expect(logs.filter(l => l.includes("Meldungen werden wieder abgeholt"))).toHaveLength(1);
    await clock.tick();
    expect(texts()).toHaveLength(1);
  });

  test("Köpfe nicht ladbar: einmal geloggt, danach kommt die Meldung", async () => {
    const { table, clock, start, texts, logs } = setup();
    await start();
    notice(table, "nach der Störung");
    table.failNext(1);
    await clock.tick();
    expect(texts()).toEqual([]);
    expect(logs).toHaveLength(1);
    await clock.tick();
    expect(texts()).toEqual(["nach der Störung"]);
  });

  test("zwischen beiden Abfragen gelöscht: nichts gemeldet, die nächste Meldung kommt normal", async () => {
    const gone: number[] = [];
    let table!: FakeMessagesTable;
    const ctx = setup(
      {},
      {
        rows: (chatIds, ids) => {
          // Die erste angefragte Zeile verschwindet, bevor ihr Text gelesen wird
          if (gone.length === 0) {
            gone.push(Number(ids[0]));
            table.remove(Number(ids[0]));
          }
          return getStore().messages.displayOnlyRows(chatIds, ids);
        },
      }
    );
    table = ctx.table;
    await ctx.start();
    const removed = notice(table, "gleich wieder weg");
    await ctx.clock.tick();
    expect(gone).toEqual([removed.id]);
    expect(ctx.texts()).toEqual([]);
    expect(ctx.logs).toEqual([]);

    table.tickDb(1_000);
    notice(table, "bleibt");
    await ctx.clock.tick();
    expect(ctx.texts()).toEqual(["bleibt"]);
  });

  test("lokal gespeichert (Hook) und danach abgefragt: genau eine Nachricht", async () => {
    const { table, clock, start, hooks, events } = setup();
    await start();
    const msgId = crypto.randomUUID();
    const row = notice(table, "aus diesem Prozess", { msgId });
    await Promise.all([...hooks].map(h => h({ chatId: USER, role: "assistant", content: row.content, metadata: row.metadata!, createdAt: new Date().toISOString() })));
    expect(events).toHaveLength(1);
    await clock.tick();
    await clock.tick();
    expect(events).toHaveLength(1);
    expect(events[0].message!.id).toBe(msgId);
  });

  test("Topic-Zustand einmal nicht lesbar: die nächste Abfrage meldet die Meldung, ohne den Text neu zu laden", async () => {
    let unreadable = 1;
    const { table, clock, start, texts } = setup({
      topicState: async () => {
        if (unreadable-- > 0) throw new Error("Datei gesperrt");
        return new Map();
      },
    });
    await start();
    notice(table, "im Topic", { topicId: 443 });
    await clock.tick();
    expect(texts()).toEqual([]);
    await clock.tick();
    expect(texts()).toEqual(["im Topic"]);
    expect(withText(table.reads)).toHaveLength(1);
  });

  test("nur heads ohne rows und ohne page: der Abholer startet nicht, der Hook läuft weiter", async () => {
    const { table, feed, logs, hooks } = setup({}, { rows: undefined });
    const events: TelegramLiveEvent[] = [];
    cleanups.push(feed.subscribe(e => events.push(e)));
    expect(logs.filter(l => l.includes("Meldungen anderer Prozesse nicht verfügbar"))).toHaveLength(1);
    expect(hooks.size).toBe(1);
    expect(table.reads).toHaveLength(0);
  });
});

describe("Verdrahtung des Bots (createBotTelegramLive)", () => {
  test("der echte Abholer fragt beim Start nur Startstand und Köpfe ab", async () => {
    const table = fakeMessagesTable();
    cleanups.push(() => table.restore());
    notice(table, "alt");
    const feed = createBotTelegramLive({ TELEGRAM_BOT_TOKEN: "123:test", TELEGRAM_USER_ID: USER, TELEGRAM_GROUP_ID: GROUP }, () => {});
    cleanups.push(feed.subscribe(() => {}));
    const end = Date.now() + 2000;
    while (table.reads.length < 2 && Date.now() < end) await Bun.sleep(5);
    await Bun.sleep(20);
    expect(table.reads.map(r => r.select)).toEqual(["created_at", HEAD_COLUMNS]);
    expect(table.reads[1].params.get("chat_id")).toBe(`in.(${USER},${GROUP})`);
  });
});
