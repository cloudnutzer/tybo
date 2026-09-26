// Topics, die direkt in Telegram umbenannt oder angelegt werden (Issue #32):
// handleTopicServiceMessage mit echtem Namensspeicher in einer Temp-Datei,
// echter Telegram-Quelle, echtem Live-Feed und echtem Web-Server. Nur
// Supabase fehlt (keine Aktivität, kein Verlauf). src/bot.ts wird nie
// importiert, nur als Text gelesen.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTopicNameStore, type TopicNameStore } from "../src/lib/topic-names";
import type { TopicStateEntry } from "../src/lib/topic-state";
import { createTelegramLiveFeed, createTelegramSource } from "../src/web/bot-telegram";
import { createWebServer, TELEGRAM_ACTIVITY_PATH, type WebServer } from "../src/web/server";
import type { TelegramTopicChangeEvent } from "../src/web/telegram";
import {
  createTopicChangeHub,
  handleTopicServiceMessage,
  type TopicChange,
  type TopicChangeHub,
} from "../src/web/topic-changes";

const PASSWORD = "test-passwort-lang";
const GROUP = "-1001234567890";
const OTHER_GROUP = "-1009999999999";
const USER = "4711";
const root = await mkdtemp(join(tmpdir(), "tybo-web-topic-changes-"));
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

/** Namensspeicher in einer eigenen Datei, vorbelegt */
async function namesFile(initial: Record<string, string>): Promise<{ file: string; store: TopicNameStore }> {
  const file = join(root, `names-${++counter}.json`);
  await Bun.write(file, JSON.stringify(initial));
  return { file, store: createTopicNameStore(file) };
}

// Wie Telegram sie schickt: Service-Nachricht im Topic, die Umbenennung
// antwortet auf die Erstellungsnachricht mit dem alten Namen
const renamed = (topicId: unknown, name?: string) => ({
  message_thread_id: topicId,
  is_topic_message: true,
  forum_topic_edited: name === undefined ? {} : { name },
  reply_to_message: { forum_topic_created: { name: "Alter Name" } },
});
const created = (topicId: unknown, name: string) => ({
  message_thread_id: topicId,
  is_topic_message: true,
  forum_topic_created: { name, icon_color: 7322096 },
});

describe("handleTopicServiceMessage", () => {
  function deps(store: TopicNameStore, groupId: () => string | null = () => GROUP) {
    const changes: TopicChange[] = [];
    const logs: string[] = [];
    return {
      changes,
      logs,
      deps: {
        groupId,
        store,
        notify: (c: TopicChange) => changes.push(c),
        log: (m: string) => logs.push(m),
      },
    };
  }

  test("Umbenennen eines bekannten Topics setzt den Namen und meldet erst danach", async () => {
    const { file, store } = await namesFile({ "443": "Projekt-Topics" });
    const seen: (string | undefined)[] = [];
    const d = deps(store);
    d.deps.notify = c => {
      d.changes.push(c);
      // Zur Meldung steht der neue Name schon im Speicher
      void store.getTopicName(c.topicId).then(n => seen.push(n));
    };
    expect(await handleTopicServiceMessage(d.deps, GROUP, renamed(443, "WebUI-Planung"))).toBe(true);
    await waitUntil(() => seen.length === 1);
    expect(seen).toEqual(["WebUI-Planung"]);
    expect(d.changes).toEqual([{ chatId: GROUP, topicId: 443 }]);
    expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({ "443": "WebUI-Planung" });
  });

  test("neu angelegtes Topic ohne Textnachricht bekommt seinen Namen", async () => {
    const { store } = await namesFile({});
    const d = deps(store);
    expect(await handleTopicServiceMessage(d.deps, GROUP, created(500, "Urlaub"))).toBe(true);
    expect(await store.getTopicName(500)).toBe("Urlaub");
    expect(d.changes).toEqual([{ chatId: GROUP, topicId: 500 }]);
  });

  test("Nachricht aus einer anderen Gruppe ändert nichts und meldet nichts", async () => {
    const { file, store } = await namesFile({ "443": "Projekt-Topics" });
    const d = deps(store);
    expect(await handleTopicServiceMessage(d.deps, OTHER_GROUP, renamed(443, "Fremd"))).toBe(false);
    expect(await handleTopicServiceMessage(d.deps, OTHER_GROUP, created(500, "Fremd neu"))).toBe(false);
    expect(await handleTopicServiceMessage(d.deps, USER, renamed(443, "Privat"))).toBe(false);
    expect(d.changes).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({ "443": "Projekt-Topics" });
  });

  test("ohne ermittelbare Gruppe: nichts", async () => {
    const { store } = await namesFile({ "443": "Projekt-Topics" });
    for (const groupId of [() => null, () => { throw new Error("topics.json kaputt"); }]) {
      const d = deps(store, groupId);
      expect(await handleTopicServiceMessage(d.deps, GROUP, renamed(443, "Neu"))).toBe(false);
      expect(d.changes).toEqual([]);
    }
    expect(await store.getTopicName(443)).toBe("Projekt-Topics");
  });

  test("forum_topic_edited ohne Namen (nur Symbol) ist keine Umbenennung, auch nicht über den alten Erstellungsnamen", async () => {
    const { store } = await namesFile({ "443": "Projekt-Topics" });
    const { store: empty } = await namesFile({});
    for (const s of [store, empty]) {
      const d = deps(s);
      expect(await handleTopicServiceMessage(d.deps, GROUP, renamed(443))).toBe(false);
      expect(await handleTopicServiceMessage(d.deps, GROUP, renamed(443, "   "))).toBe(false);
      expect(d.changes).toEqual([]);
    }
    expect(await store.getTopicName(443)).toBe("Projekt-Topics");
    expect(await empty.getTopicName(443)).toBeUndefined();
  });

  test("fehlende oder ungültige Thread-IDs werden ignoriert", async () => {
    const { file, store } = await namesFile({});
    const d = deps(store);
    for (const id of [undefined, null, "443", 0, -5, 1, 1.5, 12345678901, Number.NaN]) {
      expect(await handleTopicServiceMessage(d.deps, GROUP, renamed(id, "X"))).toBe(false);
    }
    expect(await handleTopicServiceMessage(d.deps, GROUP, null)).toBe(false);
    expect(d.changes).toEqual([]);
    expect(JSON.parse(await readFile(file, "utf-8"))).toEqual({});
  });

  test("werfender Speicher oder Zuhörer: nur eine Log-Zeile ohne Namen, kein Absturz", async () => {
    const broken = {
      recordTopicName: async () => { throw new Error("Platte voll"); },
      recordTopicNameIfMissing: async () => { throw new Error("Platte voll"); },
    };
    const logs: string[] = [];
    const changes: TopicChange[] = [];
    const result = await handleTopicServiceMessage(
      { groupId: () => GROUP, store: broken, notify: c => changes.push(c), log: m => logs.push(m) },
      GROUP,
      renamed(443, "Geheimer Name")
    );
    expect(result).toBe(false);
    expect(changes).toEqual([]);
    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain("Geheimer");

    const { store } = await namesFile({});
    const logs2: string[] = [];
    const ok = await handleTopicServiceMessage(
      { groupId: () => GROUP, store, notify: () => { throw new Error("kaputt"); }, log: m => logs2.push(m) },
      GROUP,
      renamed(443, "Neu")
    );
    expect(ok).toBe(false);
    expect(logs2).toHaveLength(1);
    expect(await store.getTopicName(443)).toBe("Neu");
  });
});

describe("createTopicChangeHub", () => {
  test("verteilt an alle, ein werfender Zuhörer hält die übrigen nicht auf; Abmeldung wirkt", () => {
    const logs: string[] = [];
    const hub = createTopicChangeHub(m => logs.push(m));
    const got: TopicChange[] = [];
    hub.on(() => { throw new Error("kaputt"); });
    const off = hub.on(c => got.push(c));
    hub.emit({ chatId: GROUP, topicId: 443 });
    off();
    hub.emit({ chatId: GROUP, topicId: 8 });
    expect(got).toEqual([{ chatId: GROUP, topicId: 443 }]);
    // Der werfende Zuhörer bleibt angemeldet: je Meldung eine Log-Zeile
    expect(logs).toHaveLength(2);
  });
});

describe("Live-Feed: subscribeTopicChanges", () => {
  function feed(options: { groupId?: () => string | null; states?: () => Promise<Map<number, TopicStateEntry>> } = {}) {
    const hub = createTopicChangeHub(() => {});
    const live = createTelegramLiveFeed({
      userId: USER,
      groupId: options.groupId ?? (() => GROUP),
      onMessageSaved: () => () => {},
      onTopicChanged: hub.on,
      topicState: options.states ? () => options.states!() : undefined,
      log: () => {},
    });
    const events: TelegramTopicChangeEvent[] = [];
    const off = live.subscribeTopicChanges!(e => events.push(e));
    return { hub, events, off };
  }

  test("Topic der Gruppe: nur die ID; fremde Gruppe und General: nichts", async () => {
    const f = feed();
    f.hub.emit({ chatId: GROUP, topicId: 443 });
    f.hub.emit({ chatId: OTHER_GROUP, topicId: 8 });
    f.hub.emit({ chatId: GROUP, topicId: 1 });
    await Bun.sleep(5);
    expect(f.events).toEqual([{ conversationId: "topic-443" }]);
    f.off();
    f.hub.emit({ chatId: GROUP, topicId: 443 });
    await Bun.sleep(5);
    expect(f.events).toHaveLength(1);
  });

  test("gelöschtes Topic und unlesbarer Zustand: verworfen", async () => {
    const f = feed({ states: async () => new Map([[443, { deleted: true } as TopicStateEntry]]) });
    f.hub.emit({ chatId: GROUP, topicId: 443 });
    f.hub.emit({ chatId: GROUP, topicId: 8 });
    await Bun.sleep(5);
    expect(f.events).toEqual([{ conversationId: "topic-8" }]);

    const g = feed({ states: async () => { throw new Error("kaputt"); } });
    g.hub.emit({ chatId: GROUP, topicId: 8 });
    await Bun.sleep(5);
    expect(g.events).toEqual([]);
  });

  test("ohne onTopicChanged gibt es keine Namensänderungen (z.B. Demo)", () => {
    const live = createTelegramLiveFeed({ userId: USER, groupId: () => GROUP, onMessageSaved: () => () => {}, log: () => {} });
    expect(live.subscribeTopicChanges).toBeUndefined();
  });
});

// --- Mit echtem Server ------------------------------------------------------

interface Ctx {
  origin: string;
  cookie: string;
  store: TopicNameStore;
  hub: TopicChangeHub;
  /** Wie der Handler in src/bot.ts */
  service(chatId: string, msg: unknown): Promise<boolean>;
}

async function start(options: { names?: Record<string, string>; hub?: TopicChangeHub } = {}): Promise<Ctx> {
  const dir = join(root, `case-${++counter}`);
  const { store } = await namesFile(options.names ?? { "443": "Projekt-Topics", "8": "Finanzen" });
  const hub = options.hub ?? createTopicChangeHub(() => {});
  const telegram = createTelegramSource({
    userId: USER,
    groupId: () => GROUP,
    topicNames: store.getTopicNames,
    topicMapping: () => ({ "443": "general", "8": "finance" }),
    history: async () => [],
    activity: async () => [],
    log: () => {},
  });
  const server = await createWebServer(
    { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
    {
      sessionFile: join(dir, "web-sessions.json"),
      dataDir: join(dir, "web"),
      telegram,
      telegramLive: createTelegramLiveFeed({
        userId: USER,
        groupId: () => GROUP,
        onMessageSaved: () => () => {},
        onTopicChanged: hub.on,
        log: () => {},
      }),
      log: () => {},
    }
  );
  servers.push(server);
  const res = await fetch(`${server.url}/api/login`, {
    method: "POST",
    headers: { origin: server.url },
    body: JSON.stringify({ password: PASSWORD }),
  });
  return {
    origin: server.url,
    cookie: res.headers.get("set-cookie")!.split(";")[0],
    store,
    hub,
    service: (chatId, msg) =>
      handleTopicServiceMessage({ groupId: () => GROUP, store, notify: hub.emit, log: () => {} }, chatId, msg),
  };
}

async function listen(ctx: Ctx, path: string) {
  const controller = new AbortController();
  const res = await fetch(`${ctx.origin}${path}`, { headers: { cookie: ctx.cookie, origin: ctx.origin }, signal: controller.signal });
  expect(res.status).toBe(200);
  const events: { event: string; data: any }[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let connected = false;
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true, value: undefined }));
      if (done) break;
      connected = true;
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
  await waitUntil(() => connected);
  return { events };
}

async function titles(ctx: Ctx): Promise<Record<string, string>> {
  const body = await (await fetch(`${ctx.origin}/api/conversations`, { headers: { cookie: ctx.cookie } })).json();
  return Object.fromEntries(body.telegram.topics.map((t: { id: string; title: string }) => [t.id, t.title]));
}

describe("Server: Umbenennung in Telegram erreicht offene Browser", () => {
  test("Umbenennen setzt den Namen und erreicht den SSE-Zuhörer; die Liste zeigt ihn sofort", async () => {
    const ctx = await start();
    const activity = await listen(ctx, TELEGRAM_ACTIVITY_PATH);
    expect((await titles(ctx))["topic-443"]).toBe("Projekt-Topics");

    expect(await ctx.service(GROUP, renamed(443, "WebUI-Planung"))).toBe(true);
    await waitUntil(() => activity.events.length === 1);
    // Nur die ID, kein Name, keine Aktivität (es kam keine Nachricht)
    expect(activity.events).toEqual([{ event: "topic", data: { id: "topic-443" } }]);
    expect((await titles(ctx))["topic-443"]).toBe("WebUI-Planung");
  });

  test("neues Topic ohne Textnachricht erscheint in der Liste", async () => {
    const ctx = await start();
    const activity = await listen(ctx, TELEGRAM_ACTIVITY_PATH);
    expect(await ctx.service(GROUP, created(500, "Urlaub"))).toBe(true);
    await waitUntil(() => activity.events.length === 1);
    expect(activity.events[0]).toEqual({ event: "topic", data: { id: "topic-500" } });
    expect((await titles(ctx))["topic-500"]).toBe("Urlaub");
  });

  test("Nachricht aus einer anderen Gruppe ändert nichts und löst kein SSE aus", async () => {
    const ctx = await start();
    const activity = await listen(ctx, TELEGRAM_ACTIVITY_PATH);
    expect(await ctx.service(OTHER_GROUP, renamed(443, "Fremd"))).toBe(false);
    expect(await ctx.service(OTHER_GROUP, created(500, "Fremd neu"))).toBe(false);
    // Auch eine direkt gemeldete fremde Änderung kommt nicht durch
    ctx.hub.emit({ chatId: OTHER_GROUP, topicId: 443 });
    await Bun.sleep(30);
    expect(activity.events).toEqual([]);
    const list = await titles(ctx);
    expect(list["topic-443"]).toBe("Projekt-Topics");
    expect(list["topic-500"]).toBeUndefined();
  });

  test("Server-Stopp meldet den Zuhörer ab", async () => {
    let subscribed = 0;
    let unsubscribed = 0;
    const inner = createTopicChangeHub(() => {});
    const hub: TopicChangeHub = {
      emit: inner.emit,
      on(listener) {
        subscribed++;
        const off = inner.on(listener);
        return () => {
          unsubscribed++;
          off();
        };
      },
    };
    await start({ hub });
    expect(subscribed).toBe(1);
    for (const s of servers.splice(0)) await s.stop();
    expect(unsubscribed).toBe(1);
  });
});

describe("Verdrahtung", () => {
  test("src/bot.ts registriert den Handler hinter der Nutzer-Prüfung, mit Gruppe, Speicher und topicChanges (ohne bot.ts zu importieren)", async () => {
    const bot = await Bun.file(join(import.meta.dir, "..", "src", "bot.ts")).text();
    const auth = bot.indexOf("if (userId !== ALLOWED_USER_ID)");
    const handler = bot.indexOf('bot.on(["message:forum_topic_created", "message:forum_topic_edited"]');
    expect(auth).toBeGreaterThan(0);
    expect(handler).toBeGreaterThan(auth);
    const body = bot.slice(handler, bot.indexOf("});", handler));
    expect(body).toContain("handleTopicServiceMessage(");
    expect(body).toContain("groupId: () => botGroupId(process.env)");
    expect(body).toContain("store: { recordTopicName, recordTopicNameIfMissing }");
    expect(body).toContain("notify: topicChanges.emit");
    // Der Textpfad bleibt unverändert
    expect(bot).toContain("void captureTopicName({ recordTopicName, recordTopicNameIfMissing }, topicId, ctx.message);");
    const live = await Bun.file(join(import.meta.dir, "..", "src", "web", "bot-telegram.ts")).text();
    const botLive = live.slice(live.indexOf("export function createBotTelegramLive"));
    expect(botLive.slice(0, botLive.indexOf("\n}\n"))).toContain("onTopicChanged: topicChanges.on");
  });
});
