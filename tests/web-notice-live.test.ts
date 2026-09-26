// Meldungen anderer Prozesse live (Issue #47, Schritt 3): Der Bot-Prozess
// fragt alle 15 Sekunden neue Nur-Anzeige-Einträge ab. Die Speicherattrappe
// verhält sich wie Supabase (eigene Zeilen-IDs, created_at mit Mikrosekunden,
// Sortierung created_at dann id, Seitenlimit). Ein „fremder Prozess" schreibt
// direkt in die Attrappe, ohne den lokalen Hook; die Uhr wird von Hand
// weitergeschaltet. src/bot.ts wird nie importiert.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, MessageSavedListener } from "../src/lib/convex";
import type { DisplayOnlyPageOptions, DisplayOnlyRow } from "../src/lib/supabase";
import {
  createTelegramLiveFeed,
  createTelegramSource,
  DISPLAY_ONLY_PAGE_SIZE,
  DISPLAY_ONLY_POLL_MS,
  type TelegramLiveDeps,
} from "../src/web/bot-telegram";
import { createWebServer, TELEGRAM_ACTIVITY_PATH, type WebServer } from "../src/web/server";
import { normalizeIsoTimestamp, type TelegramLiveEvent } from "../src/web/telegram";

const PASSWORD = "test-passwort-lang";
const USER = "4711";
const GROUP = "-1001234567890";
const OTHER_GROUP = "-1009999999999";
const root = await mkdtemp(join(tmpdir(), "tybo-web-notice-live-"));
let counter = 0;
afterAll(() => rm(root, { recursive: true, force: true }));

const servers: WebServer[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop();
  while (cleanups.length) cleanups.pop()!();
});

async function waitUntil(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > end) throw new Error("Zeitüberschreitung beim Warten");
    await Bun.sleep(5);
  }
}

/** Vergleichsschlüssel mit sechs Nachkommastellen wie in Postgres */
function sortKey(ts: string): string {
  return normalizeIsoTimestamp(ts)!.replace(/\.(\d{3})Z$/, ".$1000Z");
}

/** Supabase-Attrappe für Meldungen, mit kontrollierter Datenbank-Uhr */
function fakeStore() {
  const rows: DisplayOnlyRow[] = [];
  let nextId = 100;
  /** Datenbank-Zeit in Mikrosekunden seit Epoch */
  let dbMicros = Date.parse("2026-09-24T10:00:00.000Z") * 1000 + 123;
  const queries: { chatIds: string[]; options: DisplayOnlyPageOptions }[] = [];
  let failNext = 0;
  let failPages = 0;

  function stamp(micros: number): string {
    const ms = Math.floor(micros / 1000);
    const frac = String(micros % 1_000_000).padStart(6, "0");
    return `${new Date(ms).toISOString().slice(0, 19)}.${frac}+00:00`;
  }

  return {
    rows,
    queries,
    failOnce(n = 1) {
      failNext = n;
    },
    /** Nur die Seitenabfrage schlägt fehl, der Startstand gelingt */
    failPagesOnce(n = 1) {
      failPages = n;
    },
    tickDb(ms: number) {
      dbMicros += ms * 1000;
    },
    /** Wie insertMessageDirect: Zeile mit eigener ID und Datenbank-Zeitpunkt */
    insert(m: Message, options: { at?: string } = {}): DisplayOnlyRow {
      const row: DisplayOnlyRow = {
        id: String(nextId++),
        created_at: options.at ?? stamp(dbMicros),
        chat_id: m.chat_id,
        role: m.role,
        content: m.content,
        metadata: { ...(m.metadata ?? {}) },
      };
      dbMicros += 7;
      rows.push(row);
      return row;
    },
    /** Fremder Prozess: wie saveMessageWith (msgId), aber ohne Hook in diesem Prozess */
    foreign(m: Message, options: { at?: string } = {}): DisplayOnlyRow {
      return this.insert({ ...m, metadata: { msgId: crypto.randomUUID(), ...(m.metadata ?? {}) } }, options);
    },
    poll: {
      /** Uhr beim Start des Feeds: die Datenbank-Uhr, damit Tests nicht von der echten Zeit abhängen */
      now: () => stamp(dbMicros),
      async latestAt(chatIds: string[]) {
        if (failNext > 0) {
          failNext--;
          throw new Error("db weg");
        }
        const mine = rows.filter(r => chatIds.includes(r.chat_id) && (r.metadata as any)?.display_only === true);
        mine.sort((a, b) => (sortKey(a.created_at) < sortKey(b.created_at) ? 1 : -1));
        return mine[0]?.created_at ?? null;
      },
      async page(chatIds: string[], options: DisplayOnlyPageOptions) {
        queries.push({ chatIds, options });
        if (failNext > 0 || failPages > 0) {
          if (failNext > 0) failNext--;
          else failPages--;
          throw new Error("db weg");
        }
        let list = rows.filter(r => chatIds.includes(r.chat_id) && (r.metadata as any)?.display_only === true);
        if (options.since) list = list.filter(r => sortKey(r.created_at) >= sortKey(options.since!));
        if (options.after) {
          const a = sortKey(options.after.createdAt);
          const id = Number(options.after.id);
          list = list.filter(r => sortKey(r.created_at) > a || (sortKey(r.created_at) === a && Number(r.id) > id));
        }
        list.sort((x, y) => {
          const kx = sortKey(x.created_at);
          const ky = sortKey(y.created_at);
          return kx < ky ? -1 : kx > ky ? 1 : Number(x.id) - Number(y.id);
        });
        return list.slice(0, options.limit).map(r => ({ ...r, metadata: { ...(r.metadata as object) } }));
      },
    },
  };
}

/** Kontrollierte Uhr für den Zeitgeber des Feeds */
function fakeClock() {
  const timers: { ms: number; fn: () => Promise<void>; elapsed: number; stopped: boolean }[] = [];
  return {
    timers,
    every(ms: number, fn: () => Promise<void>) {
      const t = { ms, fn, elapsed: 0, stopped: false };
      timers.push(t);
      return () => {
        t.stopped = true;
      };
    },
    active: () => timers.filter(t => !t.stopped).length,
    async advance(ms: number) {
      for (const t of timers) {
        if (t.stopped) continue;
        t.elapsed += ms;
        while (t.elapsed >= t.ms && !t.stopped) {
          t.elapsed -= t.ms;
          await t.fn();
        }
      }
    },
  };
}

type Store = ReturnType<typeof fakeStore>;
type Clock = ReturnType<typeof fakeClock>;

function makeFeed(store: Store, clock: Clock, extra: Partial<TelegramLiveDeps> = {}) {
  const hooks = new Set<MessageSavedListener>();
  const logs: string[] = [];
  const feed = createTelegramLiveFeed({
    userId: USER,
    groupId: () => GROUP,
    onMessageSaved: l => {
      hooks.add(l);
      return () => void hooks.delete(l);
    },
    displayOnly: { ...store.poll, every: (ms, fn) => clock.every(ms, fn) },
    log: m => logs.push(m),
    ...extra,
  });
  /** Wie saveDisplayOnlyMessage in diesem Prozess: msgId vergeben, speichern, dann der lokale Hook */
  const saveLocal = async (m: Message) => {
    const metadata = { msgId: crypto.randomUUID(), ...(m.metadata ?? {}) };
    store.insert({ ...m, metadata });
    await Promise.all(
      [...hooks].map(h => h({ chatId: m.chat_id, role: m.role, content: m.content, metadata, createdAt: new Date().toISOString() }))
    );
  };
  return { feed, hooks, logs, saveLocal, fire: (e: Parameters<MessageSavedListener>[0]) => Promise.all([...hooks].map(h => h(e))) };
}

const NOTICE = (chatId: string, text: string, extra: Record<string, unknown> = {}): Message => ({
  chat_id: chatId,
  role: "assistant",
  content: text,
  metadata: { display_only: true, source: "pipeline", ...extra },
});

describe("Abfrage im Bot-Prozess (Attrappe)", () => {
  test("Eintrag aus fremdem Prozess erscheint nach einem Intervall, vorher nicht", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const { feed } = makeFeed(store, clock);
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await Bun.sleep(0);

    const row = store.foreign(NOTICE(GROUP, "**Issue #47** fertig", { topicId: 443 }));
    await clock.advance(DISPLAY_ONLY_POLL_MS - 1);
    expect(events).toEqual([]);
    await clock.advance(1);
    expect(events).toHaveLength(1);
    const [e] = events;
    expect(e!.conversationId).toBe("topic-443");
    expect(e!.at).toBe(normalizeIsoTimestamp(row.created_at)!);
    expect(e!.message!.id).toBe((row.metadata as any).msgId);
    expect(e!.message!.kind).toBe("notice");
    expect(e!.message!.source).toBe("pipeline");
    expect(e!.message!.html).toContain("<strong>Issue #47</strong>");
  });

  test("Gesprächszuordnung: Direktchat, General, Topic; fremde Chats werden nicht abgefragt", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const { feed } = makeFeed(store, clock);
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    store.foreign(NOTICE(USER, "privat", { source: "briefing" }));
    store.foreign(NOTICE(GROUP, "allgemein", { source: "watchdog" }));
    store.foreign(NOTICE(GROUP, "topic", { topicId: 8 }));
    store.foreign(NOTICE(OTHER_GROUP, "fremd", { topicId: 8 }));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events.map(e => [e.conversationId, e.message!.text])).toEqual([
      ["dm", "privat"],
      ["topic-1", "allgemein"],
      ["topic-8", "topic"],
    ]);
    expect(store.queries.every(q => q.chatIds.join() === `${USER},${GROUP}`)).toBe(true);
  });

  test("Meldungen vor dem Start kommen nicht live (sie stehen im Verlauf)", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    store.foreign(NOTICE(USER, "alt 1"));
    store.foreign(NOTICE(USER, "alt 2"));
    const { feed } = makeFeed(store, clock);
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events).toEqual([]);
    store.tickDb(1000);
    store.foreign(NOTICE(USER, "neu"));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events.map(e => e.message!.text)).toEqual(["neu"]);
  });

  test("lokal gespeichert (Hook) und danach abgefragt: genau eine Nachricht und eine Aktivität", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const { feed, saveLocal } = makeFeed(store, clock);
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await saveLocal(NOTICE(GROUP, "lokal", { topicId: 443 }));
    expect(events).toHaveLength(1);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events).toHaveLength(1);
  });

  test("erst abgefragt, dann meldet der Hook dieselbe msgId: nichts doppelt", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const { feed, fire } = makeFeed(store, clock);
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    const row = store.foreign(NOTICE(USER, "zuerst abgefragt"));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await fire({ chatId: USER, role: "assistant", content: row.content, metadata: row.metadata!, createdAt: new Date().toISOString() });
    expect(events).toHaveLength(1);
  });

  test("gleiche Zeitstempel über das Seitenlimit hinaus: jede Meldung genau einmal", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const { feed } = makeFeed(store, clock);
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    const at = "2026-09-24T10:05:00.654321+00:00";
    const total = DISPLAY_ONLY_PAGE_SIZE * 2 + 17;
    for (let i = 0; i < total; i++) store.foreign(NOTICE(USER, `m${i}`), { at });
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events).toHaveLength(total);
    expect(new Set(events.map(e => e.message!.id)).size).toBe(total);
    // Der Cursor behält die Mikrosekunden
    expect(store.queries.some(q => q.options.after?.createdAt === at)).toBe(true);
  });

  test("Mikrosekunden: .123000 und .123001 sind verschiedene Meldungen", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const { feed } = makeFeed(store, clock);
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    store.foreign(NOTICE(USER, "a"), { at: "2026-09-24T10:06:00.123000+00:00" });
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    store.foreign(NOTICE(USER, "b"), { at: "2026-09-24T10:06:00.123001+00:00" });
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events.map(e => e.message!.text)).toEqual(["a", "b"]);
  });

  test("spät sichtbare Zeile mit älterem Zeitpunkt (im Rückblick) kommt trotzdem", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const { feed } = makeFeed(store, clock);
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    store.foreign(NOTICE(USER, "später begonnen"), { at: "2026-09-24T10:10:00.500000+00:00" });
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    store.foreign(NOTICE(USER, "früher begonnen, später sichtbar"), { at: "2026-09-24T10:10:00.200000+00:00" });
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events.map(e => e.message!.text)).toEqual(["später begonnen", "früher begonnen, später sichtbar"]);
  });

  test("Abfragefehler: einmal geloggt, Stand bleibt, nächste Abfrage liefert", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const { feed, logs } = makeFeed(store, clock);
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    store.foreign(NOTICE(USER, "trotz Störung"));
    store.failOnce(2);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events).toEqual([]);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events.map(e => e.message!.text)).toEqual(["trotz Störung"]);
    expect(logs.filter(l => l.startsWith("Meldungen nicht abrufbar"))).toHaveLength(1);
    expect(logs.join("\n")).not.toContain("trotz Störung");
  });

  test("Startstand nicht lesbar: nichts Altes wird live nachgereicht", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    store.foreign(NOTICE(USER, "alt"));
    store.failOnce(1);
    const { feed } = makeFeed(store, clock);
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events).toEqual([]);
  });

  test("Startstand gelesen, erste Seite fehlgeschlagen: danach gespeicherte Meldung kommt", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    store.foreign(NOTICE(USER, "alt"));
    store.failPagesOnce(1);
    const { feed } = makeFeed(store, clock);
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await Bun.sleep(0);
    store.tickDb(1000);
    store.foreign(NOTICE(USER, "neu"));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events.map(e => e.message!.text)).toEqual(["neu"]);
  });

  test("Meldung zwischen Start und erstem lesbaren Startstand kommt live, alte nicht", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    store.foreign(NOTICE(USER, "alt"));
    store.tickDb(1000);
    store.failOnce(1);
    const { feed } = makeFeed(store, clock);
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await Bun.sleep(0);
    // Die WebUI ist erreichbar, der Startstand noch nicht gelesen
    store.tickDb(1000);
    store.foreign(NOTICE(USER, "in der Lücke"));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events.map(e => e.message!.text)).toEqual(["in der Lücke"]);
  });

  test("mehr als zehn Seiten alter Meldungen: keine davon live, danach die neue", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const at = "2026-09-24T09:59:30.500000+00:00";
    const total = DISPLAY_ONLY_PAGE_SIZE * 10 + 1;
    for (let i = 0; i < total; i++) store.foreign(NOTICE(USER, `alt ${i + 1}`), { at });
    const { feed } = makeFeed(store, clock);
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await Bun.sleep(0);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events).toEqual([]);
    store.tickDb(1000);
    store.foreign(NOTICE(USER, "neu"));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events.map(e => e.message!.text)).toEqual(["neu"]);
  });

  test("Topic-Zustand einmal nicht lesbar: nächste Abfrage meldet die Meldung, genau einmal", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    let failures = 1;
    const { feed, logs, fire } = makeFeed(store, clock, {
      topicState: async () => {
        if (failures > 0) {
          failures--;
          throw new Error("kaputt");
        }
        return new Map();
      },
    });
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    const row = store.foreign(NOTICE(GROUP, "nachgeholt", { topicId: 443 }));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events).toEqual([]);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events.map(e => e.message!.text)).toEqual(["nachgeholt"]);
    expect(logs.some(l => l.includes("Topic-Zustand nicht lesbar"))).toBe(true);
    // Weitere Abfragen und der Hook mit derselben msgId melden sie nicht noch einmal
    await clock.advance(DISPLAY_ONLY_POLL_MS * 5);
    await fire({ chatId: GROUP, role: "assistant", content: row.content, metadata: row.metadata!, createdAt: row.created_at });
    expect(events).toHaveLength(1);
  });

  test("lokal gespeichert, Topic-Zustand im Hook nicht lesbar: die Abfrage holt sie nach, genau einmal", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    let failures = 1;
    const { feed, saveLocal } = makeFeed(store, clock, {
      topicState: async () => {
        if (failures > 0) {
          failures--;
          throw new Error("kaputt");
        }
        return new Map();
      },
    });
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await saveLocal(NOTICE(GROUP, "lokal", { topicId: 443 }));
    expect(events).toEqual([]);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events.map(e => e.message!.text)).toEqual(["lokal"]);
  });

  test("Hook und Abfrage gleichzeitig bei langsamem Topic-Zustand: genau einmal", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    let release!: () => void;
    const gate = new Promise<void>(r => (release = r));
    const { feed, fire } = makeFeed(store, clock, { topicState: async () => (await gate, new Map()) });
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    const row = store.foreign(NOTICE(GROUP, "einmal", { topicId: 443 }));
    const polled = clock.advance(DISPLAY_ONLY_POLL_MS);
    const hooked = fire({ chatId: GROUP, role: "assistant", content: row.content, metadata: row.metadata!, createdAt: row.created_at });
    release();
    await Promise.all([polled, hooked]);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    expect(events.map(e => e.message!.text)).toEqual(["einmal"]);
  });

  test("gelöschtes Topic: keine Meldung", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const { feed } = makeFeed(store, clock, { topicState: async () => new Map([[9, { deleted: true } as any]]) });
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    store.foreign(NOTICE(GROUP, "weg", { topicId: 9 }));
    store.foreign(NOTICE(GROUP, "da", { topicId: 10 }));
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await Bun.sleep(0);
    expect(events.map(e => e.message!.text)).toEqual(["da"]);
  });

  test("ein gemeinsamer Zeitgeber und Hook für alle Zuhörer, angehalten mit dem letzten", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const { feed, hooks, saveLocal } = makeFeed(store, clock);
    const a: TelegramLiveEvent[] = [];
    const b: TelegramLiveEvent[] = [];
    const offA = feed.subscribe(e => a.push(e));
    const offB = feed.subscribe(e => b.push(e));
    expect(clock.active()).toBe(1);
    expect(hooks.size).toBe(1);
    await clock.advance(DISPLAY_ONLY_POLL_MS);
    await saveLocal(NOTICE(USER, "an beide"));
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    offA();
    offA();
    expect(clock.active()).toBe(1);
    offB();
    expect(clock.active()).toBe(0);
    expect(hooks.size).toBe(0);
  });

  test("gewöhnliche Nachrichten laufen weiter nur über den Hook, ohne Entdopplung", async () => {
    const store = fakeStore();
    const clock = fakeClock();
    const { feed, fire } = makeFeed(store, clock);
    const events: TelegramLiveEvent[] = [];
    feed.subscribe(e => events.push(e));
    const msg = { chatId: USER, role: "user" as const, content: "hi", metadata: { msgId: crypto.randomUUID() }, createdAt: new Date().toISOString() };
    await fire(msg);
    await fire(msg);
    expect(events).toHaveLength(2);
  });
});

// --- Mit echtem Server ------------------------------------------------------

async function startServer() {
  const dir = join(root, `case-${++counter}`);
  const store = fakeStore();
  const clock = fakeClock();
  const { feed, saveLocal } = makeFeed(store, clock);
  const telegram = createTelegramSource({
    userId: USER,
    groupId: () => GROUP,
    topicNames: async () => ({ "443": "Projekt-Topics" }),
    topicMapping: () => ({ "443": "general" }),
    history: async (chatId, topicId) =>
      store.rows.filter(r => r.chat_id === chatId && ((r.metadata as any)?.topicId ?? null) === topicId),
    activity: async () => [],
    log: () => {},
  });
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    { sessionFile: join(dir, "web-sessions.json"), dataDir: join(dir, "web"), telegram, telegramLive: feed, log: () => {} }
  );
  servers.push(server);
  const res = await fetch(`${server.url}/api/login`, {
    method: "POST",
    headers: { origin: server.url },
    body: JSON.stringify({ password: PASSWORD }),
  });
  return { origin: server.url, cookie: res.headers.get("set-cookie")!.split(";")[0]!, store, clock, saveLocal, server };
}

type ServerCtx = Awaited<ReturnType<typeof startServer>>;

async function listen(ctx: ServerCtx, path: string) {
  const controller = new AbortController();
  const res = await fetch(`${ctx.origin}${path}`, { headers: { cookie: ctx.cookie, origin: ctx.origin }, signal: controller.signal });
  expect(res.status).toBe(200);
  const events: { event: string; data: any }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      buffer += decoder.decode(value);
      let i: number;
      while ((i = buffer.indexOf("\n\n")) >= 0) {
        const chunk = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        const event = /^event: (.+)$/m.exec(chunk)?.[1];
        const data = /^data: (.+)$/m.exec(chunk)?.[1];
        if (event && data) events.push({ event, data: JSON.parse(data) });
      }
    }
  })();
  cleanups.push(() => controller.abort());
  return { events, of: (name: string) => events.filter(e => e.event === name).map(e => e.data) };
}

describe("Server: Meldung aus fremdem Prozess erscheint ohne Neuladen", () => {
  test("innerhalb eines Abfrageintervalls im offenen Topic und in der Seitenleiste, genau einmal", async () => {
    const ctx = await startServer();
    const topic = await listen(ctx, "/api/conversations/topic-443/events");
    const activity = await listen(ctx, TELEGRAM_ACTIVITY_PATH);
    await waitUntil(() => topic.events.length > 0);
    await ctx.clock.advance(DISPLAY_ONLY_POLL_MS);

    const fileId = crypto.randomUUID();
    const row = ctx.store.foreign(
      NOTICE(GROUP, "Report.html", { source: "datei", topicId: 443, file: { id: fileId, name: "Report.html", size: 10, mime: "text/html" } })
    );
    await ctx.clock.advance(DISPLAY_ONLY_POLL_MS);
    await waitUntil(() => topic.of("message").length === 1 && activity.of("activity").length === 1);
    const [message] = topic.of("message");
    expect(message.kind).toBe("notice");
    expect(message.source).toBe("datei");
    expect(message.file).toEqual({ id: fileId, name: "Report.html", size: 10, mime: "text/html" });
    expect(activity.of("activity")).toEqual([{ id: "topic-443", lastActivity: normalizeIsoTimestamp(row.created_at) }]);
    expect(JSON.stringify(activity.events)).not.toContain("Report");

    // Dieselbe ID wie im Verlauf: der Browser mischt ohne Doppelung
    const history = await (await fetch(`${ctx.origin}/api/conversations/topic-443/messages`, { headers: { cookie: ctx.cookie } })).json();
    expect(history.messages.map((m: { id: string }) => m.id)).toEqual([message.id]);
    expect(history.messages[0].kind).toBe("notice");

    // Weitere Abfragen melden nichts erneut (kein zweiter Neu-Punkt)
    await ctx.clock.advance(DISPLAY_ONLY_POLL_MS * 3);
    await Bun.sleep(20);
    expect(topic.of("message")).toHaveLength(1);
    expect(activity.of("activity")).toHaveLength(1);
  });

  test("lokal gespeicherte Meldung: Hook meldet sie, die Abfrage nicht noch einmal", async () => {
    const ctx = await startServer();
    const dm = await listen(ctx, "/api/conversations/dm/events");
    const activity = await listen(ctx, TELEGRAM_ACTIVITY_PATH);
    await waitUntil(() => dm.events.length > 0);
    await ctx.clock.advance(DISPLAY_ONLY_POLL_MS);
    await ctx.saveLocal(NOTICE(USER, "Briefing", { source: "briefing" }));
    await waitUntil(() => dm.of("message").length === 1 && activity.of("activity").length === 1);
    await ctx.clock.advance(DISPLAY_ONLY_POLL_MS * 2);
    await Bun.sleep(20);
    expect(dm.of("message")).toHaveLength(1);
    expect(activity.of("activity")).toHaveLength(1);
  });

  test("Server-Stopp hält den Zeitgeber an", async () => {
    const ctx = await startServer();
    expect(ctx.clock.active()).toBe(1);
    await ctx.server.stop();
    servers.splice(servers.indexOf(ctx.server), 1);
    expect(ctx.clock.active()).toBe(0);
  });
});
