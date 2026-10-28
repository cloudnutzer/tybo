// Seitenleiste mit Direktchat, Topics und Web-Gesprächen sowie der
// Telegram-Verlauf im Browser (Issue #18), ohne Browser: Attrappen für DOM,
// fetch, EventSource, Timer und localStorage wie in web-app-sync.test.ts.
import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TYBO_BRAND } from "./brand-fixture";

const source = await readFile(resolve(import.meta.dir, "..", "src", "web", "public", "app.js"), "utf8");

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
    clientHeight: 0,
    innerHTMLWrites: [] as string[],
    set innerHTML(v: string) { this.innerHTMLWrites.push(v); },
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
  n.scrollHeight = 0;
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

/** Nachricht n eines Telegram-Verlaufs, mit Mikrosekunden wie aus Postgres */
function tg(n: number, role = n % 2 ? "assistant" : "user", agent?: string): Message {
  const minute = String(Math.floor(n / 60)).padStart(2, "0");
  const second = String(n % 60).padStart(2, "0");
  return {
    id: `m${n}`, role, text: `Nachricht ${n}`, html: role === "assistant" ? `<p>Nachricht ${n}</p>` : undefined,
    createdAt: `2026-09-20T10:${minute}:${second}.123456Z`,
    ...(agent ? { agent } : {}),
  };
}

interface Options {
  conversations?: Entry[];
  telegram?: { dm: Entry | null; topics: Entry[] } | undefined;
  /** Kompletter Verlauf je Telegram-ID, chronologisch; der Server liefert Seiten zu 50 */
  history?: Record<string, Message[]>;
  web?: Record<string, Message[]>;
  /** Gespeicherter Wert von tybo-last-conversation; "blocked": Zugriff wirft */
  stored?: string | "blocked";
}

function setup(options: Options = {}) {
  FakeEventSource.all = [];
  const elements: Record<string, Node> = {};
  const document = {
    getElementById(id: string) { return (elements[id] ??= node()); },
    createElement() { return node(); },
    createDocumentFragment() { const f = node(); f.fragment = true; return f; },
  };
  const store: Record<string, string> = {};
  if (options.stored && options.stored !== "blocked") store["tybo-last-conversation"] = options.stored;
  const blocked = options.stored === "blocked";
  const window: Record<string, any> = {
    TYBO_BRAND,
    localStorage: {
      getItem: (key: string) => { if (blocked) throw new Error("SecurityError"); return store[key] ?? null; },
      setItem: (key: string, value: string) => { if (blocked) throw new Error("SecurityError"); store[key] = value; },
    },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ lineHeight: "22", paddingTop: "0", paddingBottom: "0", borderTopWidth: "0", borderBottomWidth: "0" }),
    addEventListener() {},
    location: { href: "/" },
  };
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  /** Verzögerung je Timer, für den Timer auf Mitternacht (Issue #186) */
  const delays = new Map<number, number>();
  const setTimeout = (fn: () => void, ms?: number) => { const id = nextTimer++; timers.set(id, fn); delays.set(id, ms ?? 0); return id; };
  const clearTimeout = (id: number) => { timers.delete(id); };

  const server = {
    conversations: options.conversations ?? [{ id: "c1", agent: "general", title: "Betrieb" }],
    telegram: "telegram" in options ? options.telegram : { dm: null, topics: [] },
    history: options.history ?? {},
    web: options.web ?? { c1: [{ id: "w1", role: "user", text: "Hallo", createdAt: "2026-09-23T10:00:00.000Z" }] },
    /** Alle Anfragen als "METHODE pfad" */
    calls: [] as string[],
    created: 0,
    /** Hält die nächste Verlaufsanfrage mit before= an */
    holdOlder: null as Promise<void> | null,
    /** Läuft laut Server gerade ein Turn (je Telegram-ID) */
    running: {} as Record<string, boolean>,
    /** Bodies der POST-Anfragen an Telegram-Gespräche */
    posts: [] as { id: string; body: any }[],
    stops: [] as string[],
    postCounter: 0,
  };
  const fetch = async (path: string, init?: { method?: string; body?: string }) => {
    // Anwesenheit (Issue #226) läuft nebenher und zählt hier nicht mit
    if (path === "/api/presence") return { ok: true, status: 204, json: async () => ({}) } as any;
    const method = init?.method ?? "GET";
    server.calls.push(`${method} ${path}`);
    if (path === "/api/conversations" && method === "GET") {
      const body: Record<string, unknown> = { conversations: server.conversations };
      if (server.telegram !== undefined) body.telegram = server.telegram;
      return Response.json(body);
    }
    if (path === "/api/conversations" && method === "POST") {
      server.created++;
      const conversation = { id: `neu${server.created}`, agent: "general", title: null };
      server.conversations = [conversation, ...server.conversations];
      return Response.json({ conversation }, { status: 201 });
    }
    const m = path.match(/^\/api\/conversations\/([^/?]+)\/messages(?:\?before=(.*))?$/);
    if (m) {
      const id = m[1];
      if (server.history[id]) {
        if (method === "POST") {
          // wie der Server: Nachricht mit web-ID, Turn läuft, im Speicher unter derselben ID
          const body = JSON.parse(init!.body!);
          server.posts.push({ id, body });
          const message = { id: `web-${++server.postCounter}`, role: "user", text: body.text, createdAt: new Date(Date.UTC(2026, 8, 23, 12, 0, server.postCounter)).toISOString() };
          server.history[id] = [...server.history[id], message];
          server.running[id] = true;
          return Response.json({ message }, { status: 202 });
        }
        const before = m[2] === undefined ? null : decodeURIComponent(m[2]);
        const all = server.history[id];
        const older = before === null ? all : all.filter(x => x.createdAt < before);
        const page = older.slice(-50);
        const body = { messages: page, hasMore: older.length > page.length, running: !!server.running[id] };
        if (before !== null && server.holdOlder) {
          const hold = server.holdOlder;
          server.holdOlder = null;
          await hold;
        }
        return Response.json(body);
      }
      if (server.web[id]) {
        if (method === "POST") return Response.json({ message: { id: "p1", role: "user", text: "x", createdAt: "2026-09-23T11:00:00.000Z" } }, { status: 202 });
        return Response.json({ messages: server.web[id], running: false });
      }
    }
    const stop = path.match(/^\/api\/conversations\/([^/]+)\/stop$/);
    if (stop && method === "POST") {
      server.stops.push(stop[1]);
      return Response.json({ stopping: !!server.running[stop[1]] });
    }
    return Response.json({ error: "unbekannt" }, { status: 404 });
  };

  elements["chat-log"] = node();
  // Layout-Ersatz: jede Nachricht 100 px, der Nachlade-Knopf 40 px
  Object.defineProperty(elements["chat-log"], "scrollHeight", {
    get: () => (elements["messages"]?.children.length ?? 0) * 100 + (elements["load-older"]?.hidden === false ? 40 : 0),
  });
  new Function("document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout", source)(
    document, window, fetch, FakeEventSource, setTimeout, clearTimeout
  );

  const button = (li: Node) => li.children[0];
  const titles = (listId: string) => elements[listId].children.map(li => button(li).children[0].textContent);
  const entry = (id: string) => {
    for (const listId of ["dm-list", "topic-list", "older-list", "conversation-list"]) {
      const li = elements[listId].children.find(l => button(l).attributes["data-id"] === id);
      if (li) return button(li);
    }
    throw new Error(`Eintrag ${id} fehlt`);
  };
  const shown = () => elements["messages"].children.map(c => c.attributes["data-id"]);
  const filter = (text: string) => {
    elements["conversation-filter"].value = text;
    elements["conversation-filter"].dispatch("input");
  };
  return { server, elements, store, titles, entry, shown, filter, timers, delays };
}

async function settle() {
  for (let i = 0; i < 20; i++) await Bun.sleep(0);
}

const TOPICS: Entry[] = [
  { id: "topic-443", title: "Recherche", agent: "research", lastActivity: ago(5 * 60 * 1000) },
  { id: "topic-12", title: "Finanzen", agent: "finance", lastActivity: ago(29 * DAY) },
  { id: "topic-7", title: "Archiv <b>alt</b> & Co", agent: "cto", lastActivity: ago(31 * DAY) },
  { id: "topic-1", title: "General", agent: "general", lastActivity: null },
];
const DM: Entry = { id: "dm", title: "Direktchat", agent: "general", lastActivity: ago(30 * 60 * 1000) };

// ---------------------------------------------------------------------------
// Reine Hilfsfunktionen
// ---------------------------------------------------------------------------

const helpers = new Function("document", "window", `${source}\nreturn { relativeTime, splitTopics, matchesFilter, isTelegramId, timeKey, parseTime };`)(
  { getElementById: () => null }, {}
) as {
  relativeTime(v: unknown, now?: number): string;
  splitTopics(t: unknown, now?: number): { recent: Entry[]; older: Entry[] };
  matchesFilter(title: string, filter: string): boolean;
  isTelegramId(id: string): boolean;
  timeKey(v: string): string;
  parseTime(v: unknown): number;
};

describe("Hilfsfunktionen", () => {
  const now = new Date(2026, 8, 23, 15, 0, 0).getTime(); // 23.9.2026 15:00 Ortszeit
  const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).toISOString();

  test("relative Zeit: Minuten, Stunden, gestern, Datum", () => {
    expect(helpers.relativeTime(new Date(now - 20_000).toISOString(), now)).toBe("gerade eben");
    expect(helpers.relativeTime(new Date(now - 5 * 60_000).toISOString(), now)).toBe("vor 5 Min.");
    expect(helpers.relativeTime(at(2026, 9, 23, 11, 30), now)).toBe("vor 3 Std.");
    expect(helpers.relativeTime(at(2026, 9, 22, 23, 50), now)).toBe("gestern");
    expect(helpers.relativeTime(at(2026, 9, 22, 0, 5), now)).toBe("gestern");
    expect(helpers.relativeTime(at(2026, 9, 12), now)).toBe("12.9.");
    expect(helpers.relativeTime(at(2025, 12, 31), now)).toBe("31.12.2025");
  });

  test("relative Zeit: Mikrosekunden gehen, null und Unsinn ergeben leer", () => {
    expect(helpers.relativeTime(new Date(now - 5 * 60_000).toISOString().replace("Z", "123Z"), now)).toBe("vor 5 Min.");
    for (const v of [null, undefined, "", "gestern", 42]) expect(helpers.relativeTime(v, now)).toBe("");
  });

  test("30-Tage-Grenze: genau 30 Tage ist aktuell, eine Millisekunde mehr älter, null älter", () => {
    const topics = [
      { id: "topic-1", agent: "general", lastActivity: new Date(now - 30 * DAY).toISOString() },
      { id: "topic-2", agent: "general", lastActivity: new Date(now - 30 * DAY - 1).toISOString() },
      { id: "topic-3", agent: "general", lastActivity: null },
      { id: "topic-4", agent: "general", lastActivity: "kaputt" },
      { id: "topic-5", agent: "general", lastActivity: new Date(now).toISOString() },
    ];
    const { recent, older } = helpers.splitTopics(topics, now);
    expect(recent.map(t => t.id)).toEqual(["topic-1", "topic-5"]);
    expect(older.map(t => t.id)).toEqual(["topic-2", "topic-3", "topic-4"]);
  });

  test("Filter ohne Groß/Klein, Telegram-IDs, Sortierschlüssel mit Mikrosekunden", () => {
    expect(helpers.matchesFilter("Finanzen", "FIN")).toBe(true);
    expect(helpers.matchesFilter("Finanzen", "  ")).toBe(true);
    expect(helpers.matchesFilter("Finanzen", "rech")).toBe(false);
    expect(helpers.isTelegramId("dm")).toBe(true);
    expect(helpers.isTelegramId("topic-443")).toBe(true);
    expect(helpers.isTelegramId("topic-0")).toBe(false);
    expect(helpers.isTelegramId("5f1c0c1e-aaaa-4bbb-8ccc-123456789abc")).toBe(false);
    expect(helpers.timeKey("2026-09-23T10:00:00.123Z") < helpers.timeKey("2026-09-23T10:00:00.123001Z")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 1. Seitenleiste
// ---------------------------------------------------------------------------

describe("Seitenleiste", () => {
  test("drei Gruppen: Direktchat, aktuelle Topics, ältere eingeklappt, Web-Gespräche", async () => {
    const app = setup({ telegram: { dm: DM, topics: TOPICS } });
    await settle();
    const { elements } = app;
    expect(elements["dm-group"].hidden).toBe(false);
    expect(app.titles("dm-list")).toEqual(["Direktchat"]);
    expect(app.titles("topic-list")).toEqual(["Recherche", "Finanzen"]);
    expect(app.titles("conversation-list")).toEqual(["Betrieb"]);
    // Ältere: eingeklappt, Zahl im Knopf
    expect(elements["older-label"].textContent).toBe("Ältere Topics (2)");
    expect(elements["older-toggle"].hidden).toBe(false);
    expect(elements["older-toggle"].attributes["aria-expanded"]).toBe("false");
    expect(elements["older-list"].hidden).toBe(true);

    // Topic-Eintrag: Agentenpunkt mit Name, rechts die letzte Aktivität
    const meta = app.entry("topic-443").children[1];
    expect(meta.attributes["data-agent"]).toBe("research");
    expect(meta.children.map((c: Node) => c.className)).toEqual(["agent-dot", "", "conversation-time"]);
    expect(meta.children[1].textContent).toBe("Research");
    expect(meta.children[2].textContent).toBe("vor 5 Min.");
    expect(app.entry("dm").children[1].children[2].textContent).toBe("vor 30 Min.");
    // Web-Gespräche ohne Zeitangabe wie bisher
    expect(app.entry("c1").children[1].children).toHaveLength(2);

    // Aufklappen per Knopf (ein echter <button>: Enter und Leertaste lösen click aus)
    elements["older-toggle"].dispatch("click");
    expect(elements["older-toggle"].attributes["aria-expanded"]).toBe("true");
    expect(elements["older-list"].hidden).toBe(false);
    expect(app.titles("older-list")).toEqual(["Archiv <b>alt</b> & Co", "General"]);
    // Topic ohne bekannte Aktivität: kein erfundenes Datum
    expect(app.entry("topic-1").children[1].children).toHaveLength(2);
    elements["older-toggle"].dispatch("click");
    expect(elements["older-list"].hidden).toBe(true);
  });

  test("Titel mit HTML-Sonderzeichen nur als Text", async () => {
    const app = setup({ telegram: { dm: null, topics: TOPICS } });
    await settle();
    app.elements["older-toggle"].dispatch("click");
    const title = app.entry("topic-7").children[0];
    expect(title.textContent).toBe("Archiv <b>alt</b> & Co");
    expect(title.innerHTMLWrites).toEqual([]);
  });

  test("ohne Direktchat und ohne Topics: nur Web-Gespräche; fehlendes telegram-Feld stört nicht", async () => {
    for (const telegram of [{ dm: null, topics: [] }, undefined]) {
      const app = setup({ telegram });
      await settle();
      expect(app.elements["dm-group"].hidden).toBe(true);
      expect(app.elements["topic-group"].hidden).toBe(true);
      expect(app.titles("conversation-list")).toEqual(["Betrieb"]);
      expect(app.elements["chat-title"].textContent).toBe("Betrieb");
    }
  });

  test("nur ältere Topics: Gruppe mit eingeklapptem Teil, ohne leere Liste", async () => {
    const app = setup({ telegram: { dm: null, topics: TOPICS.slice(2) } });
    await settle();
    expect(app.elements["topic-group"].hidden).toBe(false);
    expect(app.elements["topic-list"].hidden).toBe(true);
    expect(app.elements["older-label"].textContent).toBe("Ältere Topics (2)");
  });

  test("Filter wirkt auf alle drei Gruppen, ohne Anfrage an den Server", async () => {
    const app = setup({
      telegram: { dm: DM, topics: TOPICS },
      conversations: [{ id: "c1", agent: "general", title: "Betrieb" }, { id: "c2", agent: "research", title: "VPS-Kosten" }],
      web: { c1: [], c2: [] },
    });
    await settle();
    const { elements } = app;
    const calls = app.server.calls.length;

    app.filter("fin");
    expect(elements["dm-group"].hidden).toBe(true);
    expect(app.titles("topic-list")).toEqual(["Finanzen"]);
    expect(elements["web-group"].hidden).toBe(true);
    expect(elements["filter-empty"].hidden).toBe(true);

    // Treffer unter den älteren Topics: aufgeklappt sichtbar, Knopf weg
    app.filter("archiv");
    expect(elements["topic-list"].hidden).toBe(true);
    expect(elements["older-list"].hidden).toBe(false);
    expect(app.titles("older-list")).toEqual(["Archiv <b>alt</b> & Co"]);
    expect(elements["older-toggle"].hidden).toBe(true);

    app.filter("DIREKT");
    expect(app.titles("dm-list")).toEqual(["Direktchat"]);
    expect(elements["topic-group"].hidden).toBe(true);

    app.filter("vps");
    expect(app.titles("conversation-list")).toEqual(["VPS-Kosten"]);
    expect(elements["web-group"].hidden).toBe(false);

    app.filter("gibt es nicht");
    expect(elements["filter-empty"].hidden).toBe(false);
    expect([elements["dm-group"], elements["topic-group"], elements["web-group"]].every(g => g.hidden)).toBe(true);

    // Filter leeren: alles wieder da, ältere wieder eingeklappt wie vorher
    app.filter("");
    expect(app.titles("topic-list")).toEqual(["Recherche", "Finanzen"]);
    expect(elements["older-list"].hidden).toBe(true);
    expect(elements["older-toggle"].hidden).toBe(false);
    expect(elements["filter-empty"].hidden).toBe(true);
    expect(app.server.calls.length).toBe(calls);
  });
});

// ---------------------------------------------------------------------------
// 2. Telegram-Gespräch öffnen, Verlauf, Nachladen, Eingabe gesperrt
// ---------------------------------------------------------------------------

describe("Telegram-Gespräch", () => {
  const history = () => ({
    "topic-443": Array.from({ length: 120 }, (_, i) => tg(i, undefined, i === 119 ? "finance" : i % 2 ? "research" : undefined)),
    dm: [] as Message[],
  });

  test("Öffnen eines Topics lädt /api/conversations/topic-443/messages, öffnet SSE, Eingabe frei", async () => {
    const app = setup({ telegram: { dm: DM, topics: TOPICS }, history: history() });
    await settle();
    const { elements } = app;
    const webStream = FakeEventSource.all.at(-1)!;
    expect(webStream.url).toBe("/api/conversations/c1/events");
    webStream.emit("open");
    await settle();

    // Entwurf im Web-Gespräch
    elements["input"].value = "halb geschrieben";
    elements["input"].dispatch("input");

    app.entry("topic-443").dispatch("click");
    await settle();
    expect(app.server.calls).toContain("GET /api/conversations/topic-443/messages");
    // Web-Strom zu, eigener Strom für das Topic
    expect(webStream.closed).toBe(true);
    // Dazu der Sammelstrom der Seitenleiste (Issue #20), vor dem Web-Strom geöffnet
    const streams = FakeEventSource.all.filter(s => s.url !== "/api/telegram/events");
    expect(streams).toHaveLength(2);
    expect(streams[1].url).toBe("/api/conversations/topic-443/events");

    // Kopfzeile, Verlauf, Sprecher
    expect(elements["chat-title"].textContent).toBe("Recherche");
    expect(elements["agent-name"].textContent).toBe("Research");
    expect(elements["agent-name"].getAttribute("data-agent")).toBe("research");
    expect(app.shown()).toEqual(Array.from({ length: 50 }, (_, i) => `m${70 + i}`));
    const head = (id: string) => elements["messages"].children.find(c => c.attributes["data-id"] === id)!.children.find((c: Node) => c.className === "msg-head");
    expect(head("m119").attributes["data-agent"]).toBe("finance");
    expect(head("m119").children[1].textContent).toBe("Finance");
    expect(head("m117").attributes["data-agent"]).toBe("research");
    expect(app.entry("topic-443").attributes["aria-current"]).toBe("true");

    // Eingabe frei, Platzhalter mit dem Namen; der Web-Entwurf bleibt beim Web-Gespräch
    expect(elements["input"].disabled).toBe(false);
    expect(elements["input"].value).toBe("");
    expect(elements["input"].attributes.placeholder).toBe("Nachricht an Recherche");
    expect(elements["send"].disabled).toBe(true);
    elements["input"].value = "Frage aus dem Browser";
    elements["input"].dispatch("input");
    expect(elements["send"].disabled).toBe(false);

    // Nachladen sichtbar
    expect(elements["load-older"].hidden).toBe(false);
    expect(elements["empty"].hidden).toBe(true);
  });

  test("Nachladen hängt ältere vorne an, ohne Doppelungen, Cursor unverändert mit Mikrosekunden", async () => {
    const app = setup({ telegram: { dm: DM, topics: TOPICS }, history: history(), stored: "topic-443" });
    await settle();
    const { elements } = app;
    expect(app.shown()).toHaveLength(50);

    // Oben stehen, erste sichtbare Nachricht ist m70
    const log = elements["chat-log"];
    log.scrollTop = 0;
    const fromBottom = log.scrollHeight - log.scrollTop;

    // Doppelklick: nur eine Anfrage
    let release!: () => void;
    app.server.holdOlder = new Promise<void>(r => (release = r));
    elements["load-older"].dispatch("click");
    elements["load-older"].dispatch("click");
    await settle();
    expect(elements["load-older"].disabled).toBe(true);
    release();
    await settle();
    const older = app.server.calls.filter(c => c.includes("?before="));
    expect(older).toEqual([`GET /api/conversations/topic-443/messages?before=${encodeURIComponent("2026-09-20T10:01:10.123456Z")}`]);
    expect(app.shown()).toEqual(Array.from({ length: 100 }, (_, i) => `m${20 + i}`));
    // Abstand zum unteren Ende gleich: m70 bleibt an derselben Stelle
    expect(log.scrollHeight - log.scrollTop).toBe(fromBottom);
    expect(elements["load-older"].hidden).toBe(false);

    // Zweites Nachladen: die letzten 20, danach kein Knopf mehr
    elements["load-older"].dispatch("click");
    await settle();
    expect(app.shown()).toEqual(Array.from({ length: 120 }, (_, i) => `m${i}`));
    expect(new Set(app.shown()).size).toBe(120);
    expect(elements["load-older"].hidden).toBe(true);
  });

  test("Antwort auf Nachladen nach Gesprächswechsel wird verworfen", async () => {
    const app = setup({ telegram: { dm: DM, topics: TOPICS }, history: { ...history(), dm: [tg(500), tg(501)] }, stored: "topic-443" });
    await settle();
    let release!: () => void;
    app.server.holdOlder = new Promise<void>(r => (release = r));
    app.elements["load-older"].dispatch("click");
    await settle();
    app.entry("dm").dispatch("click");
    await settle();
    expect(app.shown()).toEqual(["m500", "m501"]);
    release();
    await settle();
    expect(app.shown()).toEqual(["m500", "m501"]);
    expect(app.elements["load-older"].hidden).toBe(true);
    expect(app.elements["chat-title"].textContent).toBe("Direktchat");
  });

  test("leerer Telegram-Verlauf: Hinweis auf die Spiegelung, Platzhalter mit Namen", async () => {
    const app = setup({ telegram: { dm: DM, topics: [] }, history: { dm: [] }, stored: "dm" });
    await settle();
    expect(app.elements["empty"].hidden).toBe(false);
    expect(app.elements["empty-title"].textContent).toBe("Noch keine Nachrichten");
    expect(app.elements["empty-text"].textContent).toContain("erscheint auch in Telegram");
    expect(app.elements["input"].attributes.placeholder).toBe("Nachricht an Direktchat");
    expect(app.elements["load-older"].hidden).toBe(true);
  });

  test("zurück ins Web-Gespräch: Eingabe frei mit Entwurf, SSE wieder offen, Senden geht", async () => {
    const app = setup({ telegram: { dm: DM, topics: TOPICS }, history: history() });
    await settle();
    const { elements } = app;
    elements["input"].value = "Entwurf";
    elements["input"].dispatch("input");
    app.entry("topic-443").dispatch("click");
    await settle();
    app.entry("c1").dispatch("click");
    await settle();

    expect(elements["input"].disabled).toBe(false);
    expect(elements["input"].value).toBe("Entwurf");
    expect(elements["input"].attributes.placeholder).toBe("Nachricht an tybo");
    expect(elements["empty-text"].textContent).toContain("Enter sendet");
    expect(elements["load-older"].hidden).toBe(true);
    const stream = FakeEventSource.all.at(-1)!;
    expect(stream.url).toBe("/api/conversations/c1/events");
    expect(stream.closed).toBe(false);
    expect(app.shown()).toEqual(["w1"]);

    expect(elements["send"].disabled).toBe(false);
    elements["composer"].dispatch("submit", { preventDefault() {} });
    await settle();
    expect(app.server.calls).toContain("POST /api/conversations/c1/messages");
  });
});

// ---------------------------------------------------------------------------
// 2b. In Telegram-Gespräche schreiben (Issue #19)
// ---------------------------------------------------------------------------

describe("In Telegram-Gespräche schreiben", () => {
  const reply = (id: string, second: number) => ({
    id, role: "assistant", text: "Antwort", html: "<p>Antwort</p>", createdAt: `2026-09-23T12:00:${String(second).padStart(2, "0")}.000Z`,
  });
  const ev = (data: unknown) => ({ data: JSON.stringify(data) });

  async function openTopic(history: Message[] = [tg(1), tg(2)]) {
    const app = setup({ telegram: { dm: DM, topics: TOPICS }, history: { "topic-443": history, dm: [] }, stored: "topic-443" });
    await settle();
    const stream = FakeEventSource.all.at(-1)!;
    expect(stream.url).toBe("/api/conversations/topic-443/events");
    stream.emit("open");
    await settle();
    return { app, stream };
  }

  function type(app: ReturnType<typeof setup>, text: string) {
    app.elements["input"].value = text;
    app.elements["input"].dispatch("input");
    app.elements["composer"].dispatch("submit", { preventDefault() {} });
  }

  test("Senden: POST ans Topic, Nachricht sofort sichtbar, Stopp statt Senden, Antwort per SSE ohne Doppelung", async () => {
    const { app, stream } = await openTopic();
    const { elements } = app;
    type(app, "Wie weit ist das Deck?");
    await settle();
    expect(app.server.posts).toEqual([{ id: "topic-443", body: { text: "Wie weit ist das Deck?" } }]);
    expect(app.shown()).toEqual(["m1", "m2", "web-1"]);
    expect(elements["input"].value).toBe("");
    expect(elements["stop"].hidden).toBe(false);
    expect(elements["send"].hidden).toBe(true);

    // Der Server veröffentlicht die Nutzernachricht auch per SSE, mit der ID aus dem POST
    stream.emit("message", ev({ id: "web-1", role: "user", text: "Wie weit ist das Deck?", createdAt: "2026-09-23T12:00:01.000Z" }));
    stream.emit("status", ev({ running: true }));
    stream.emit("progress", ev({ kind: "tool", text: "Read" }));
    stream.emit("message", ev(reply("web-2", 30)));
    stream.emit("status", ev({ running: false }));
    await settle();
    expect(app.shown()).toEqual(["m1", "m2", "web-1", "web-2"]);
    expect(elements["stop"].hidden).toBe(true);

    // Nachladen (neu verbunden): der Server liefert dieselben IDs, nichts doppelt
    app.server.history["topic-443"].push(reply("web-2", 31));
    app.server.running["topic-443"] = false;
    stream.emit("open");
    await settle();
    expect(app.shown()).toEqual(["m1", "m2", "web-1", "web-2"]);
  });

  test("Nutzernachricht kommt per SSE vor der POST-Antwort: steht trotzdem nur einmal da", async () => {
    const { app, stream } = await openTopic();
    stream.emit("message", ev({ id: "web-1", role: "user", text: "Frage", createdAt: "2026-09-23T12:00:01.000Z" }));
    await settle();
    type(app, "Frage");
    await settle();
    expect(app.server.posts).toHaveLength(1);
    expect(app.shown()).toEqual(["m1", "m2", "web-1"]);
  });

  test("Abgleich während des Turns: running bleibt, live Empfangenes bleibt, ältere Seiten und Nachlade-Knopf auch", async () => {
    const long = Array.from({ length: 60 }, (_, i) => tg(i));
    const { app, stream } = await openTopic(long);
    const { elements } = app;
    expect(elements["load-older"].hidden).toBe(false);
    elements["load-older"].dispatch("click");
    await settle();
    expect(app.shown()).toHaveLength(60);
    expect(elements["load-older"].hidden).toBe(true);

    type(app, "Frage");
    await settle();
    stream.emit("status", ev({ running: true }));
    // reine Live-Meldung (nicht im Speicher), z. B. ein Fehler mit ID
    stream.emit("error", ev({ id: "web-live", role: "error", text: "Nur live", createdAt: "2026-09-23T12:00:59.000Z" }));
    await settle();

    // Verbindung weg, neu verbinden: Abgleich mit dem Server, Turn läuft noch
    stream.emit("error", {});
    const [timerId, reconnect] = [...app.timers.entries()].at(-1)!;
    app.timers.delete(timerId);
    reconnect();
    await settle();
    const again = FakeEventSource.all.at(-1)!;
    expect(again).not.toBe(stream);
    expect(again.url).toBe("/api/conversations/topic-443/events");
    again.emit("open");
    await settle();

    expect(elements["stop"].hidden).toBe(false);
    expect(elements["activity"].hidden).toBe(false);
    const ids = app.shown();
    expect(ids).toHaveLength(62);
    expect(new Set(ids).size).toBe(62);
    expect(ids.slice(0, 2)).toEqual(["m0", "m1"]);
    expect(ids.slice(-2)).toEqual(["web-1", "web-live"]);
    expect(elements["load-older"].hidden).toBe(true);
  });

  test("Stopp schickt POST .../topic-443/stop", async () => {
    const { app, stream } = await openTopic();
    type(app, "Lange Aufgabe");
    await settle();
    stream.emit("status", ev({ running: true }));
    app.elements["stop"].dispatch("click");
    await settle();
    expect(app.server.stops).toEqual(["topic-443"]);
    expect(app.server.calls).toContain("POST /api/conversations/topic-443/stop");
  });

  test("Entwürfe bleiben beim eigenen Gespräch", async () => {
    const { app } = await openTopic();
    const { elements } = app;
    elements["input"].value = "für das Topic";
    elements["input"].dispatch("input");
    app.entry("dm").dispatch("click");
    await settle();
    expect(elements["input"].value).toBe("");
    expect(elements["input"].attributes.placeholder).toBe("Nachricht an Direktchat");
    elements["input"].value = "für den Direktchat";
    app.entry("c1").dispatch("click");
    await settle();
    expect(elements["input"].value).toBe("");
    expect(elements["input"].attributes.placeholder).toBe("Nachricht an tybo");
    app.entry("topic-443").dispatch("click");
    await settle();
    expect(elements["input"].value).toBe("für das Topic");
    app.entry("dm").dispatch("click");
    await settle();
    expect(elements["input"].value).toBe("für den Direktchat");
  });
});

// ---------------------------------------------------------------------------
// 3. Zuletzt geöffnetes Gespräch
// ---------------------------------------------------------------------------

describe("zuletzt geöffnetes Gespräch", () => {
  test("wird gemerkt und beim nächsten Start wieder geöffnet", async () => {
    const first = setup({ telegram: { dm: DM, topics: TOPICS }, history: { "topic-443": [tg(1)] } });
    await settle();
    expect(first.store["tybo-last-conversation"]).toBe("c1");
    first.entry("topic-443").dispatch("click");
    await settle();
    expect(first.store["tybo-last-conversation"]).toBe("topic-443");

    const again = setup({ telegram: { dm: DM, topics: TOPICS }, history: { "topic-443": [tg(1)] }, stored: "topic-443" });
    await settle();
    expect(again.elements["chat-title"].textContent).toBe("Recherche");
    expect(again.shown()).toEqual(["m1"]);
    expect(FakeEventSource.all.map(s => s.url)).toEqual(["/api/telegram/events", "/api/conversations/topic-443/events"]);
  });

  test("gemerktes älteres Topic: Gruppe aufgeklappt, Eintrag markiert", async () => {
    const app = setup({ telegram: { dm: DM, topics: TOPICS }, history: { "topic-7": [] }, stored: "topic-7" });
    await settle();
    expect(app.elements["older-list"].hidden).toBe(false);
    expect(app.entry("topic-7").attributes["aria-current"]).toBe("true");
  });

  test("unbekannte ID, fremder Wert oder gesperrter Speicher: jüngstes Web-Gespräch", async () => {
    for (const stored of ["topic-999", "<script>", "dm", "blocked"]) {
      // "dm" ohne Direktchat in der Liste ist ebenfalls unbekannt
      const app = setup({ telegram: { dm: null, topics: TOPICS }, stored });
      await settle();
      expect(app.elements["chat-title"].textContent).toBe("Betrieb");
      expect(FakeEventSource.all.at(-1)!.url).toBe("/api/conversations/c1/events");
    }
  });

  test("gemerktes Gespräch weg und gar keine Gespräche: nichts anlegen, Leerzustand (Issue #30)", async () => {
    const app = setup({ telegram: { dm: null, topics: [] }, conversations: [], stored: "topic-443", web: {} });
    await settle();
    expect(app.server.created).toBe(0);
    expect(app.titles("conversation-list")).toEqual([]);
    expect(app.store["tybo-last-conversation"]).toBe("topic-443");
  });
});

test("index.html: Filterfeld beschriftet, drei Gruppen, Einklappknopf mit aria-expanded, Nachladeknopf", async () => {
  const html = await readFile(resolve(import.meta.dir, "..", "src", "web", "public", "index.html"), "utf8");
  expect(html).toMatch(/<input type="search" id="conversation-filter"[^>]*placeholder="Suchen"[^>]*aria-label="[^"]+"/);
  for (const id of ["dm-group", "dm-list", "topic-group", "topic-list", "older-list", "web-group", "conversation-list", "filter-empty", "load-older", "empty-title", "empty-text"]) {
    expect(html).toContain(`id="${id}"`);
  }
  expect(html).toMatch(/<button type="button" id="older-toggle"[^>]*aria-expanded="false"[^>]*aria-controls="older-list"/);
  // Reihenfolge der Gruppen wie in Telegram: Direktchat, Topics, Web-Gespräche
  const order = ["Direktchat", "Topics", "Web-Gespräche"].map(label => html.indexOf(`class="group-label">${label}<`));
  expect(order.every(i => i > 0)).toBe(true);
  expect([...order].sort((a, b) => a - b)).toEqual(order);
});

// ---------------------------------------------------------------------------
// Board-Sitzung mit mehreren Sprechern (Issue #75)
// ---------------------------------------------------------------------------

describe("Board-Sitzung: mehrere Sprecher in einem Gespräch", () => {
  const ev = (data: unknown) => ({ data: JSON.stringify(data) });
  const contribution = (id: string, agent: string, second: number) => ({
    id, role: "assistant", agent, model: "claude-test", durationMs: 42_000, text: `Beitrag ${agent}`, html: `<p>Beitrag ${agent}</p>`, copyText: `Beitrag ${agent}`,
    createdAt: `2026-09-23T12:01:${String(second).padStart(2, "0")}.000Z`,
  });

  async function openTopic() {
    const app = setup({ telegram: { dm: DM, topics: TOPICS }, history: { "topic-443": [tg(1), tg(2)], dm: [] }, stored: "topic-443" });
    await settle();
    const stream = FakeEventSource.all.at(-1)!;
    stream.emit("open");
    await settle();
    return { app, stream };
  }

  function speaker(app: ReturnType<typeof setup>, id: string) {
    const item = app.elements["messages"].children.find(c => c.attributes["data-id"] === id)!;
    const head = item.children.find((c: Node) => c.className === "msg-head")!;
    const foot = item.children.find((c: Node) => c.className === "msg-foot");
    const meta = foot?.children.find((c: Node) => c.className === "msg-meta");
    return { agent: head.attributes["data-agent"], dot: head.children[0].className, name: head.children[1].textContent, meta: meta?.textContent };
  }

  test("jeder Beitrag live als eigene Nachricht mit Name, Farbe und Dauer; Fortschritt nennt den Agenten", async () => {
    const { app, stream } = await openTopic();
    const { elements } = app;
    stream.emit("message", ev({ id: "web-1", role: "user", text: "/board Preis", createdAt: "2026-09-23T12:01:00.000Z" }));
    stream.emit("status", ev({ running: true }));
    stream.emit("notice", ev({ text: "Research denkt nach …" }));
    await settle();
    expect(elements["activity-text"].textContent).toBe("Research denkt nach …");
    stream.emit("message", ev(contribution("web-2", "research", 10)));
    stream.emit("notice", ev({ text: "CTO denkt nach …" }));
    await settle();
    // Erster Beitrag steht, während der nächste Agent noch arbeitet
    expect(app.shown()).toEqual(["m1", "m2", "web-1", "web-2"]);
    expect(elements["activity-text"].textContent).toBe("CTO denkt nach …");
    expect(elements["stop"].hidden).toBe(false);
    stream.emit("message", ev(contribution("web-3", "cto", 20)));
    stream.emit("message", ev(contribution("web-4", "general", 30)));
    stream.emit("status", ev({ running: false }));
    await settle();

    expect(app.shown()).toEqual(["m1", "m2", "web-1", "web-2", "web-3", "web-4"]);
    expect(speaker(app, "web-2")).toEqual({ agent: "research", dot: "agent-dot", name: "Research", meta: "Research · claude-test · 42 s" });
    expect(speaker(app, "web-3")).toEqual({ agent: "cto", dot: "agent-dot", name: "CTO", meta: "CTO · claude-test · 42 s" });
    expect(speaker(app, "web-4")).toEqual({ agent: "general", dot: "agent-dot", name: "General", meta: "General · claude-test · 42 s" });
    // Dieselben Farben wie in der Seitenleiste: gleiches data-agent am Punkt
    expect(app.entry("topic-443").children[1].attributes["data-agent"]).toBe("research");
  });

  test("nach dem Neuladen: Beiträge mit denselben IDs, jeder einmal, Sprecher unverändert", async () => {
    const { app, stream } = await openTopic();
    stream.emit("message", ev(contribution("web-2", "research", 10)));
    stream.emit("message", ev(contribution("web-3", "critic", 20)));
    await settle();
    app.server.history["topic-443"].push(contribution("web-2", "research", 10), contribution("web-3", "critic", 20));
    stream.emit("open");
    await settle();
    expect(app.shown()).toEqual(["m1", "m2", "web-2", "web-3"]);
    expect(speaker(app, "web-3").agent).toBe("critic");
    expect(speaker(app, "web-3").name).toBe("Critic");
  });
});

describe("Zeitstempel an Nachrichten (Issue #186)", () => {
  let previousTz: string | undefined;
  beforeAll(() => {
    previousTz = process.env.TZ;
    process.env.TZ = "Europe/Berlin";
  });
  afterAll(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });
  afterEach(() => setSystemTime());
  const ev = (data: unknown) => ({ data: JSON.stringify(data) });

  /** Sichtbare Kurzform und datetime des Zeitstempels einer angezeigten Nachricht */
  function stamp(app: ReturnType<typeof setup>, id: string) {
    const item = app.elements["messages"].children.find(c => c.attributes["data-id"] === id);
    if (!item) throw new Error(`Nachricht ${id} fehlt`);
    const foot = item.children.find((c: Node) => c.className === "msg-foot");
    const at = (foot ?? item).children.find((c: Node) => String(c.className).split(" ").includes("msg-time"));
    return at ? { text: at.children[0].textContent as string, datetime: at.attributes["datetime"] } : null;
  }

  test("Web-Gespräch: geladen und live, Nutzer und Antwort; ohne createdAt keine Zeit", async () => {
    setSystemTime(new Date("2026-09-26T20:00:00.000Z"));
    const app = setup({
      web: { c1: [
        { id: "w1", role: "user", text: "Hallo", createdAt: "2026-09-23T10:00:00.000Z" },
        { id: "w2", role: "assistant", text: "Hi", html: "<p>Hi</p>", createdAt: "2026-09-25T19:08:00.000Z" },
      ] },
    });
    await settle();
    expect(stamp(app, "w1")).toEqual({ text: "23.09. 12:00", datetime: "2026-09-23T10:00:00.000Z" });
    expect(stamp(app, "w2")).toEqual({ text: "gestern 21:08", datetime: "2026-09-25T19:08:00.000Z" });
    const stream = FakeEventSource.all.at(-1)!;
    expect(stream.url).toBe("/api/conversations/c1/events");
    stream.emit("open");
    stream.emit("message", ev({ id: "w3", role: "user", text: "Neu", createdAt: "2026-09-26T19:59:00.000Z" }));
    stream.emit("message", ev({ id: "w4", role: "assistant", text: "Ok", html: "<p>Ok</p>", createdAt: "2026-09-26T20:00:00.000Z", agent: "general" }));
    stream.emit("message", ev({ id: "w5", role: "assistant", text: "Ohne", html: "<p>Ohne</p>" }));
    await settle();
    expect(stamp(app, "w3")!.text).toBe("21:59");
    expect(stamp(app, "w4")!.text).toBe("22:00");
    expect(stamp(app, "w5")).toBeNull();
  });

  test("Telegram-Gespräch: geladen, nachgeladen und live; über Mitternacht wird aus „21:08“ „gestern 21:08“", async () => {
    setSystemTime(new Date("2026-09-26T19:30:00.000Z"));
    const history = { "topic-443": Array.from({ length: 60 }, (_, i) => tg(i)), dm: [] as Message[] };
    const app = setup({ telegram: { dm: DM, topics: TOPICS }, history, stored: "topic-443" });
    await settle();
    // Geladene Seite: m10 bis m59 (Mikrosekunden aus Postgres), 20.09. 12:00 in Berlin
    expect(stamp(app, "m59")).toEqual({ text: "20.09. 12:00", datetime: "2026-09-20T10:00:59.123456Z" });
    expect(stamp(app, "m58")!.text).toBe("20.09. 12:00");
    // Nachgeladen
    app.elements["load-older"].dispatch("click");
    await settle();
    expect(stamp(app, "m0")).toEqual({ text: "20.09. 12:00", datetime: "2026-09-20T10:00:00.123456Z" });
    // Live aus Telegram
    const stream = FakeEventSource.all.at(-1)!;
    expect(stream.url).toBe("/api/conversations/topic-443/events");
    stream.emit("open");
    stream.emit("message", ev({ id: "live-1", role: "assistant", text: "Da", html: "<p>Da</p>", createdAt: "2026-09-26T19:08:00.000Z", agent: "research", model: "claude-opus-5-5", durationMs: 1_002_000 }));
    await settle();
    expect(stamp(app, "live-1")!.text).toBe("21:08");

    // Timer auf kurz nach Mitternacht (Ortszeit): jetzt 21:30 Uhr, also 2,5 Stunden plus 1 s
    const midnight = [...app.delays].filter(([id, ms]) => app.timers.has(id) && ms === 150 * 60 * 1000 + 1000);
    expect(midnight).toHaveLength(1);
    setSystemTime(new Date("2026-09-26T22:00:01.000Z"));
    app.timers.get(midnight[0]![0])!();
    expect(stamp(app, "live-1")!.text).toBe("gestern 21:08");
    // Nächster Timer für die folgende Mitternacht
    expect([...app.delays].some(([id, ms]) => app.timers.has(id) && ms === 24 * 60 * 60 * 1000)).toBe(true);
  });
});
