// Live-Anzeige in der Chat-Seite (app.js, Issue #20) ohne Browser: Attrappen
// für DOM, fetch, EventSource, Timer und localStorage wie in
// web-app-telegram.test.ts. Geprüft: Aktivität und Neu-Punkt in der
// Seitenleiste über den Sammelstrom, Telegram-Nachrichten im offenen Topic.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TYBO_BRAND } from "./brand-fixture";

const source = await readFile(resolve(import.meta.dir, "..", "src", "web", "public", "app.js"), "utf8");
const ACTIVITY = "/api/telegram/events";

interface Node {
  children: Node[];
  attributes: Record<string, string>;
  [key: string]: any;
}

function node(): Node {
  const n: Node = {
    children: [],
    attributes: {},
    style: {},
    className: "",
    textContent: "",
    hidden: false,
    disabled: false,
    value: "",
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 0,
    set innerHTML(_v: string) {},
    appendChild(child: Node) { this.children.push(child); return child; },
    replaceChildren(...list: Node[]) {
      this.children = list.flatMap(c => (c.fragment ? c.children : [c]));
    },
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    getAttribute(name: string) { return this.attributes[name]; },
    listeners: {} as Record<string, ((e: any) => void)[]>,
    addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); },
    dispatch(type: string, event: any = {}) { for (const fn of this.listeners[type] ?? []) fn(event); },
    focus() {},
  };
  return n;
}

class FakeEventSource {
  static all: FakeEventSource[] = [];
  listeners: Record<string, ((e: any) => void)[]> = {};
  closed = false;
  constructor(public url: string) { FakeEventSource.all.push(this); }
  addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); }
  close() { this.closed = true; }
  emit(type: string, event: any = {}) { for (const fn of this.listeners[type] ?? []) fn(event); }
}

type Message = { id: string; role: string; text: string; html?: string; createdAt: string; agent?: string };
type Entry = { id: string; title?: string; agent: string; lastActivity?: string | null };

const DAY = 24 * 60 * 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function topics(): Entry[] {
  return [
    { id: "topic-8", title: "Finanzen", agent: "finance", lastActivity: ago(5 * 60 * 1000) },
    { id: "topic-443", title: "Projekt-Topics", agent: "general", lastActivity: ago(2 * DAY) },
    { id: "topic-7", title: "Archiv", agent: "cto", lastActivity: ago(40 * DAY) },
    { id: "topic-1", title: "General", agent: "general", lastActivity: null },
  ];
}
const DM: Entry = { id: "dm", title: "Direktchat", agent: "general", lastActivity: ago(DAY) };

interface Options {
  telegram?: { dm: Entry | null; topics: Entry[] };
  history?: Record<string, Message[]>;
  stored?: string;
  /** localStorage eines früheren Aufrufs, für ein Neuladen derselben Seite */
  store?: Record<string, string>;
}

function setup(options: Options = {}) {
  FakeEventSource.all = [];
  const elements: Record<string, Node> = {};
  const document = {
    getElementById(id: string) { return (elements[id] ??= node()); },
    createElement() { return node(); },
    createDocumentFragment() { const f = node(); f.fragment = true; return f; },
  };
  const store: Record<string, string> = options.store ?? {};
  if (options.stored) store["tybo-last-conversation"] = options.stored;
  const window: Record<string, any> = {
    TYBO_BRAND,
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
    },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ lineHeight: "22", paddingTop: "0", paddingBottom: "0", borderTopWidth: "0", borderBottomWidth: "0" }),
    addEventListener() {},
    location: { href: "/" },
  };
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const setTimeout = (fn: () => void) => { const id = nextTimer++; timers.set(id, fn); return id; };
  const clearTimeout = (id: number) => { timers.delete(id); };
  const runTimers = () => {
    const due = [...timers.entries()];
    timers.clear();
    for (const [, fn] of due) fn();
  };

  const server = {
    telegram: options.telegram ?? { dm: DM, topics: topics() },
    history: options.history ?? { "topic-8": [], "topic-443": [], "topic-7": [], "topic-1": [], dm: [] },
    calls: [] as string[],
  };
  const fetch = async (path: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    server.calls.push(`${method} ${path}`);
    if (path === "/api/conversations" && method === "GET") {
      return Response.json({ conversations: [{ id: "c1", agent: "general", title: "Betrieb" }], telegram: server.telegram });
    }
    if (path === "/api/me") return Response.json({ authenticated: true });
    const m = path.match(/^\/api\/conversations\/([^/?]+)\/messages$/);
    if (m && server.history[m[1]]) return Response.json({ messages: server.history[m[1]], hasMore: false, running: false });
    if (m && m[1] === "c1") return Response.json({ messages: [], running: false });
    return Response.json({ error: "unbekannt" }, { status: 404 });
  };

  elements["chat-log"] = node();
  new Function("document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout", source)(
    document, window, fetch, FakeEventSource, setTimeout, clearTimeout
  );

  const button = (li: Node) => li.children[0];
  const listed = (listId: string) => elements[listId].children.map(li => button(li).attributes["data-id"]);
  const entry = (id: string) => {
    for (const listId of ["dm-list", "topic-list", "older-list", "conversation-list"]) {
      const li = elements[listId].children.find(l => button(l).attributes["data-id"] === id);
      if (li) return button(li);
    }
    throw new Error(`Eintrag ${id} fehlt`);
  };
  const meta = (id: string) => entry(id).children[1];
  const hasDot = (id: string) => meta(id).children.some((c: Node) => c.className === "unread-dot");
  const time = (id: string) => meta(id).children.find((c: Node) => c.className === "conversation-time")?.textContent ?? "";
  const activitySource = () => FakeEventSource.all.filter(s => s.url === ACTIVITY).at(-1);
  const conversationSource = () => FakeEventSource.all.filter(s => s.url !== ACTIVITY).at(-1)!;
  const activity = (id: string, lastActivity: string) =>
    activitySource()!.emit("activity", { data: JSON.stringify({ id, lastActivity }) });
  const shown = () => elements["messages"].children.map(c => c.attributes["data-id"]);
  const titleOf = (id: string) => entry(id).children[0].textContent;
  const topicChanged = (id: string) => activitySource()!.emit("topic", { data: JSON.stringify({ id }) });
  return { server, store, elements, listed, entry, hasDot, time, titleOf, activitySource, conversationSource, activity, topicChanged, shown, runTimers, timers };
}

async function settle() {
  for (let i = 0; i < 20; i++) await Bun.sleep(0);
}

describe("Sammelstrom der Seitenleiste", () => {
  test("wird vor dem Strom des Gesprächs geöffnet, nur mit Telegram-Gesprächen", async () => {
    setup({ stored: "topic-8" });
    await settle();
    expect(FakeEventSource.all.map(s => s.url)).toEqual([ACTIVITY, "/api/conversations/topic-8/events"]);

    setup({ telegram: { dm: null, topics: [] } });
    await settle();
    expect(FakeEventSource.all.map(s => s.url)).toEqual(["/api/conversations/c1/events"]);
  });

  test("Topic 8 offen, Nachricht in 443: Aktivität live, Topic rückt nach oben, Neu-Punkt; Öffnen entfernt ihn", async () => {
    const app = setup({ stored: "topic-8" });
    await settle();
    expect(app.listed("topic-list")).toEqual(["topic-8", "topic-443"]);
    expect(app.time("topic-443")).not.toBe("gerade eben");
    expect(app.hasDot("topic-443")).toBe(false);

    app.activity("topic-443", new Date().toISOString());
    expect(app.listed("topic-list")).toEqual(["topic-443", "topic-8"]);
    expect(app.time("topic-443")).toBe("gerade eben");
    expect(app.hasDot("topic-443")).toBe(true);
    expect(app.entry("topic-443").attributes["data-unread"]).toBe("true");
    const dot = app.entry("topic-443").children[1].children.find((c: Node) => c.className === "unread-dot");
    expect(dot.attributes["aria-label"]).toBe("neu");
    // Das offene Topic bekommt keinen Punkt
    expect(app.hasDot("topic-8")).toBe(false);
    // Kein Nachrichteninhalt im offenen Topic 8
    expect(app.shown()).toEqual([]);

    app.entry("topic-443").dispatch("click");
    await settle();
    expect(app.hasDot("topic-443")).toBe(false);
    expect(app.entry("topic-443").attributes["data-unread"]).toBeUndefined();
    expect(app.entry("topic-443").attributes["aria-current"]).toBe("true");
  });

  test("Neu-Punkt übersteht ein Neuladen und verschwindet erst beim Öffnen des Topics", async () => {
    const app = setup({ stored: "topic-8" });
    await settle();
    app.activity("topic-443", new Date().toISOString());
    expect(app.hasDot("topic-443")).toBe(true);

    // Seite neu laden: gleiche Speicherung, Topic 8 bleibt offen
    const reloaded = setup({ store: app.store });
    await settle();
    expect(reloaded.entry("topic-8").attributes["aria-current"]).toBe("true");
    expect(reloaded.hasDot("topic-443")).toBe(true);
    expect(reloaded.hasDot("topic-8")).toBe(false);

    reloaded.entry("topic-443").dispatch("click");
    await settle();
    expect(reloaded.hasDot("topic-443")).toBe(false);

    // Nach dem Öffnen auch beim nächsten Neuladen kein Punkt mehr
    const again = setup({ store: reloaded.store });
    await settle();
    expect(again.hasDot("topic-443")).toBe(false);
  });

  test("kaputter Speicher für Neu-Punkte stört nicht", async () => {
    const app = setup({ stored: "topic-8", store: { "tybo-unread": "{kaputt" } });
    await settle();
    expect(app.hasDot("topic-443")).toBe(false);
    app.activity("topic-443", new Date().toISOString());
    expect(app.hasDot("topic-443")).toBe(true);
  });

  test("Aktivität im offenen Topic: Zeit aktualisiert, kein Punkt", async () => {
    const app = setup({ stored: "topic-443" });
    await settle();
    app.activity("topic-443", new Date().toISOString());
    expect(app.time("topic-443")).toBe("gerade eben");
    expect(app.hasDot("topic-443")).toBe(false);
  });

  test("Direktchat bekommt Zeit und Punkt; älteres Topic wandert zu den aktuellen", async () => {
    const app = setup({ stored: "topic-8" });
    await settle();
    expect(app.listed("older-list")).toContain("topic-7");
    app.activity("dm", new Date().toISOString());
    expect(app.time("dm")).toBe("gerade eben");
    expect(app.hasDot("dm")).toBe(true);
    app.activity("topic-7", new Date().toISOString());
    expect(app.listed("topic-list")[0]).toBe("topic-7");
    expect(app.listed("older-list")).not.toContain("topic-7");
    expect(app.hasDot("topic-7")).toBe(true);
  });

  test("älterer Zeitpunkt als bekannt ändert die Reihenfolge nicht", async () => {
    const app = setup({ stored: "topic-8" });
    await settle();
    app.activity("topic-443", ago(10 * DAY));
    expect(app.listed("topic-list")).toEqual(["topic-8", "topic-443"]);
  });

  test("unbekanntes Topic holt die Liste neu; Unsinn wird ignoriert", async () => {
    const app = setup({ stored: "topic-8" });
    await settle();
    const lists = () => app.server.calls.filter(c => c === "GET /api/conversations").length;
    expect(lists()).toBe(1);
    app.activity("<b>x</b>", new Date().toISOString());
    app.activity("topic-443", "kaputt");
    app.activitySource()!.emit("activity", { data: "kein json" });
    await settle();
    expect(lists()).toBe(1);
    expect(app.hasDot("topic-443")).toBe(false);

    app.server.telegram = { dm: DM, topics: [{ id: "topic-999", title: "Neu", agent: "general", lastActivity: new Date().toISOString() }, ...topics()] };
    app.activity("topic-999", new Date().toISOString());
    await settle();
    expect(lists()).toBe(2);
    expect(app.listed("topic-list")[0]).toBe("topic-999");
    expect(app.hasDot("topic-999")).toBe(true);
  });

  test("Verbindung weg: verbindet neu und gleicht die Liste ab; Gesprächswechsel lässt den Strom offen", async () => {
    const app = setup({ stored: "topic-8" });
    await settle();
    const first = app.activitySource()!;
    first.emit("open");
    await settle();
    const lists = () => app.server.calls.filter(c => c === "GET /api/conversations").length;
    expect(lists()).toBe(1);

    app.entry("topic-443").dispatch("click");
    await settle();
    expect(first.closed).toBe(false);

    first.emit("error", {});
    expect(first.closed).toBe(true);
    // Während der Lücke: neue Nachrichten im Direktchat und in Topic 8, kommen nie als Ereignis;
    // im offenen Topic 443 ebenfalls, dort gibt es keinen Punkt
    // Unveränderte Topics behalten ihre ursprünglichen Zeitstempel
    const now = new Date().toISOString();
    app.server.telegram = {
      dm: { ...DM, lastActivity: now },
      topics: app.server.telegram.topics.map(t => (t.id === "topic-443" || t.id === "topic-8" ? { ...t, lastActivity: now } : t)),
    };
    expect(app.hasDot("dm")).toBe(false);
    app.runTimers();
    const second = app.activitySource()!;
    expect(second).not.toBe(first);
    second.emit("open");
    await settle();
    expect(lists()).toBe(2);
    expect(app.time("dm")).toBe("gerade eben");
    expect(app.hasDot("dm")).toBe(true);
    expect(app.hasDot("topic-8")).toBe(true);
    expect(app.hasDot("topic-443")).toBe(false);
    // Unverändert gebliebene Topics bekommen keinen Punkt
    expect(app.hasDot("topic-7")).toBe(false);
  });
});

describe("Topic in Telegram umbenannt oder angelegt (Issue #32)", () => {
  const lists = (app: ReturnType<typeof setup>) => app.server.calls.filter(c => c === "GET /api/conversations").length;

  test("offenes Topic umbenannt: Seitenleiste und Kopfzeile zeigen den neuen Namen, kein Neu-Punkt", async () => {
    const app = setup({ stored: "topic-443" });
    await settle();
    expect(app.elements["chat-title"].textContent).toBe("Projekt-Topics");
    expect(app.titleOf("topic-443")).toBe("Projekt-Topics");

    app.server.telegram = { dm: DM, topics: app.server.telegram.topics.map(t => (t.id === "topic-443" ? { ...t, title: "WebUI-Planung" } : t)) };
    app.topicChanged("topic-443");
    await settle();
    expect(lists(app)).toBe(2);
    expect(app.titleOf("topic-443")).toBe("WebUI-Planung");
    expect(app.elements["chat-title"].textContent).toBe("WebUI-Planung");
    expect(app.hasDot("topic-443")).toBe(false);
  });

  test("anderes Topic umbenannt: nur die Seitenleiste ändert sich, kein Neu-Punkt", async () => {
    const app = setup({ stored: "topic-8" });
    await settle();
    app.server.telegram = { dm: DM, topics: app.server.telegram.topics.map(t => (t.id === "topic-443" ? { ...t, title: "WebUI-Planung" } : t)) };
    app.topicChanged("topic-443");
    await settle();
    expect(app.titleOf("topic-443")).toBe("WebUI-Planung");
    expect(app.elements["chat-title"].textContent).toBe("Finanzen");
    expect(app.hasDot("topic-443")).toBe(false);
  });

  test("neues Topic ohne Nachricht erscheint in der Liste, ohne Neu-Punkt; Unsinn wird ignoriert", async () => {
    const app = setup({ stored: "topic-8" });
    await settle();
    app.topicChanged("<b>x</b>");
    app.activitySource()!.emit("topic", { data: "kein json" });
    app.activitySource()!.emit("topic", { data: JSON.stringify({ id: 5 }) });
    await settle();
    expect(lists(app)).toBe(1);

    app.server.telegram = { dm: DM, topics: [...app.server.telegram.topics, { id: "topic-500", title: "Urlaub", agent: "general", lastActivity: null }] };
    app.topicChanged("topic-500");
    await settle();
    expect(lists(app)).toBe(2);
    expect(app.titleOf("topic-500")).toBe("Urlaub");
    expect(app.hasDot("topic-500")).toBe(false);
  });
});

describe("Nachricht aus Telegram im offenen Topic", () => {
  test("erscheint ohne Neuladen; beim Abgleich mit gleicher ID nicht doppelt", async () => {
    const app = setup({ stored: "topic-443" });
    await settle();
    const stream = app.conversationSource();
    expect(stream.url).toBe("/api/conversations/topic-443/events");
    const user: Message = { id: "0b7c2f7e-5a52-4c38-9d11-2f5e0c7b9a10", role: "user", text: "Hallo aus Telegram", createdAt: new Date().toISOString() };
    const reply: Message = {
      id: "1c8d3f8f-6b63-4d49-8e22-3f6f1d8cab21", role: "assistant", text: "Antwort", html: "<p>Antwort</p>",
      createdAt: new Date(Date.now() + 1).toISOString(), agent: "general",
    };
    stream.emit("message", { data: JSON.stringify(user) });
    stream.emit("message", { data: JSON.stringify(reply) });
    expect(app.shown()).toEqual([user.id, reply.id]);

    // Nachladen: der Speicher liefert dieselben IDs mit leicht früherem created_at
    app.server.history["topic-443"] = [
      { ...user, createdAt: new Date(Date.parse(user.createdAt) - 2).toISOString() },
      { ...reply, createdAt: new Date(Date.parse(reply.createdAt) - 2).toISOString() },
    ];
    stream.emit("open");
    await settle();
    expect(app.shown()).toEqual([user.id, reply.id]);
  });
});
