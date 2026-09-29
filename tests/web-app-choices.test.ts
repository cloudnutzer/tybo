// Rückfrage-Knöpfe in der Chat-Seite (app.js, Issue #115) ohne Browser:
// Attrappen für DOM, fetch, EventSource, Timer und localStorage wie in
// web-app-goal.test.ts. Geprüft: Knöpfe unter der Nachricht, genau ein POST
// je Klick mit Sperre, Erledigt-Zeile, 409 mit Endzustand, Live-Ereignis
// aus Telegram, verspätetes GET und verspätete POST-Antwort, Verweis bei der
// Kopie im Direktchat, Sammelstrom, Fehler, Topic-Zuordnung mit Chip-Wechsel (Issue #119).
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TYBO_BRAND } from "./brand-fixture";

const source = await readFile(resolve(import.meta.dir, "..", "src", "web", "public", "app.js"), "utf8");
const ACTIVITY = "/api/telegram/events";
const WEB = "0b8f2a3c-1d2e-4f50-8a6b-7c8d9e0f1a2b";

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

const now = new Date().toISOString();
const TOPICS = [
  { id: "topic-8", title: "Recherche", agent: "research", lastActivity: now },
  { id: "topic-443", title: "Finanzen", agent: "finance", lastActivity: now },
];
const DM = { id: "dm", title: "Direktchat", agent: "general", lastActivity: now };
const OPTIONS = [
  { key: "ok", label: "Erlauben" },
  { key: "no", label: "Ablehnen" },
];
const AT = "2026-09-25T14:32:00.000Z";

function clock(iso: string): string {
  const d = new Date(iso);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}

function question(id: string, choice: Record<string, any> | null, over: Record<string, any> = {}) {
  return {
    id: `m-${id}`,
    role: "assistant",
    kind: "notice",
    source: "freigabe",
    text: "Werkzeug ausführen?",
    html: "<p>Werkzeug ausführen?</p>",
    createdAt: now,
    ...(choice ? { choice } : {}),
    ...over,
  };
}

const open = (id = "Abc123", over: Record<string, any> = {}) => ({ id, options: OPTIONS, state: "open", ...over });
const done = (id = "Abc123", via = "web", label = "Erlauben") => ({ id, options: [], state: "done", result: { key: "ok", label, via, at: AT } });

interface Deferred {
  path: string;
  body: any;
  resolve(status: number, data: unknown): void;
  fail(): void;
}

function setup(options: { messages?: Record<string, any[]>; stored?: string; topics?: any[] } = {}) {
  FakeEventSource.all = [];
  const elements: Record<string, Node> = {};
  const document = {
    getElementById(id: string) { return (elements[id] ??= node()); },
    createElement() { return node(); },
    createDocumentFragment() { const f = node(); f.fragment = true; return f; },
  };
  const store: Record<string, string> = { "tybo-last-conversation": options.stored ?? "topic-8" };
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

  const server = {
    messages: options.messages ?? { "topic-8": [question("1", open())] },
    calls: [] as string[],
    posts: [] as Deferred[],
    /** Stand im Register für die Stand-Abfrage; sonst der Stand aus dem Verlauf, unbekannt abgelaufen */
    choices: {} as Record<string, any>,
    /** Status der Stand-Abfrage (200 oder ein Fehler) */
    choicesStatus: 200,
    /** Ältere Seite je Gespräch (Abfrage mit before=); vorhanden heißt: jüngste Seite meldet hasMore */
    older: {} as Record<string, any[]>,
    /** Topics der Liste; ein Test kann den Agenten ändern (Issue #119) */
    topics: structuredClone(options.topics ?? TOPICS) as any[],
  };
  const fetch = async (path: string, init?: { method?: string; body?: string }) => {
    // Anwesenheit (Issue #226) läuft nebenher und zählt hier nicht mit
    if (path === "/api/presence") return { ok: true, status: 204, json: async () => ({}) } as any;
    const method = init?.method ?? "GET";
    server.calls.push(`${method} ${path}`);
    if (path === "/api/conversations" && method === "GET") {
      return Response.json({ conversations: [{ id: WEB, agent: "general", title: "Betrieb" }], telegram: { dm: DM, topics: structuredClone(server.topics) } });
    }
    if (path === "/api/me") return Response.json({ authenticated: true });
    if (/\/goal$/.test(path)) return Response.json({ card: null });
    if (/\/choices\//.test(path) && method === "POST") {
      return new Promise<Response>((resolve, reject) => {
        server.posts.push({
          path,
          body: JSON.parse(init!.body!),
          resolve: (status, data) => resolve(Response.json(data, { status })),
          fail: () => reject(new TypeError("Netzwerk")),
        });
      });
    }
    const snap = path.match(/^\/api\/conversations\/([^/?]+)\/choices\?ids=(.*)$/);
    if (snap && method === "GET") {
      if (server.choicesStatus !== 200) return Response.json({ error: "Fehler" }, { status: server.choicesStatus });
      const ids = snap[2].split(",").filter(Boolean).map(decodeURIComponent);
      const fromHistory = (id: string) => (server.messages[snap[1]] ?? []).find(m => m.choice?.id === id)?.choice;
      return Response.json({ choices: ids.map(id => structuredClone(server.choices[id] ?? fromHistory(id) ?? { id, options: [], state: "expired" })) });
    }
    const m = path.match(/^\/api\/conversations\/([^/?]+)\/messages$/);
    if (m) return Response.json({ messages: structuredClone(server.messages[m[1]] ?? []), hasMore: m[1] in server.older, running: false });
    const page = path.match(/^\/api\/conversations\/([^/?]+)\/messages\?before=/);
    if (page) return Response.json({ messages: structuredClone(server.older[page[1]] ?? []), hasMore: false });
    return Response.json({ error: "unbekannt" }, { status: 404 });
  };

  elements["chat-log"] = node();
  new Function("document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout", source)(
    document, window, fetch, FakeEventSource, setTimeout, clearTimeout
  );

  const all = (n: Node, out: Node[] = []): Node[] => {
    for (const c of n.children) {
      out.push(c);
      all(c, out);
    }
    return out;
  };
  const inMessages = () => all(elements["messages"]);
  const box = (id = "Abc123") => inMessages().find(n => n.attributes["data-choice"] === id);
  const buttons = (id = "Abc123") => (box(id) ? all(box(id)!).filter(n => String(n.className).includes("choice-button") && n.attributes["data-key"]) : []);
  const status = (id = "Abc123") => (box(id) ? all(box(id)!).find(n => n.className === "choice-status")?.textContent : undefined);
  const error = (id = "Abc123") => (box(id) ? all(box(id)!).find(n => n.className === "choice-error") : undefined);
  const conversationSource = () => FakeEventSource.all.filter(s => s.url !== ACTIVITY).at(-1)!;
  const activitySource = () => FakeEventSource.all.filter(s => s.url === ACTIVITY).at(-1)!;
  const emit = (target: FakeEventSource, type: string, data: unknown) => target.emit(type, { data: JSON.stringify(data) });
  const messageGets = (id: string) => server.calls.filter(c => c === `GET /api/conversations/${id}/messages`);
  const entry = (id: string) => {
    for (const listId of ["dm-list", "topic-list", "older-list", "conversation-list"]) {
      const li = (elements[listId]?.children ?? []).find(l => l.children[0]?.attributes["data-id"] === id);
      if (li) return li.children[0];
    }
    throw new Error(`Eintrag ${id} fehlt`);
  };
  /** Fällige Timer ausführen (z. B. den neuen Versuch von syncMessages) */
  const runTimers = () => {
    const due = [...timers.entries()];
    timers.clear();
    for (const [, fn] of due) fn();
  };
  const snapshots = () => server.calls.filter(c => c.includes("/choices?"));
  return { server, elements, box, buttons, status, error, conversationSource, activitySource, emit, messageGets, entry, all, runTimers, snapshots };
}

async function settle() {
  for (let i = 0; i < 20; i++) await Bun.sleep(0);
}

describe("Knöpfe unter der Nachricht", () => {
  test("offene Rückfrage: eine Reihe Knöpfe mit den Beschriftungen, der erste in der Handlungsfarbe", async () => {
    const app = setup();
    await settle();
    const list = app.buttons();
    expect(list.map(b => [b.textContent, b.type, b.disabled, b.attributes["data-key"]])).toEqual([
      ["Erlauben", "button", false, "ok"],
      ["Ablehnen", "button", false, "no"],
    ]);
    expect(list[0].className).toContain("primary");
    expect(list[1].className).not.toContain("primary");
    expect(app.status()).toBeUndefined();
  });

  test("Antwort (keine Meldung) mit Rückfrage und feindliche Beschriftung: Knöpfe, Text bleibt Text", async () => {
    const hostile = "<img src=x onerror=alert(1)>";
    const app = setup({
      messages: { "topic-8": [question("1", open("Abc123", { options: [{ key: "ok", label: hostile }] }), { kind: undefined, source: undefined })] },
    });
    await settle();
    expect(app.buttons().map(b => b.textContent)).toEqual([hostile]);
  });

  test("unvollständige Rückfrage: keine Knöpfe; Nachricht ohne Rückfrage: nichts", async () => {
    const app = setup({ messages: { "topic-8": [question("1", { id: "Abc123", state: "vielleicht" }), question("2", null)] } });
    await settle();
    expect(app.box()).toBeUndefined();
    expect(app.all(app.elements["messages"]).some(n => n.className === "choice")).toBe(false);
  });

  test("erledigt und abgelaufen aus dem Verlauf: Zeile statt Knöpfe", async () => {
    const app = setup({ messages: { "topic-8": [question("1", done("Abc123", "telegram")), question("2", { id: "Old123", options: [], state: "expired" })] } });
    await settle();
    expect(app.buttons()).toEqual([]);
    expect(app.status()).toBe(`Erledigt: Erlauben · in Telegram · ${clock(AT)}`);
    expect(app.status("Old123")).toBe("Abgelaufen");
  });
});

describe("Klick", () => {
  test("genau ein POST, währenddessen gesperrt; danach Erledigt-Zeile; zweiter Klick löst nichts aus", async () => {
    const app = setup();
    await settle();
    const [allow, deny] = app.buttons();
    allow.dispatch("click");
    await settle();
    expect(app.server.posts.map(p => [p.path, p.body])).toEqual([["/api/conversations/topic-8/choices/Abc123", { option: "ok" }]]);
    expect(app.buttons().every(b => b.disabled)).toBe(true);
    deny.dispatch("click");
    app.buttons()[1].dispatch("click");
    await settle();
    expect(app.server.posts).toHaveLength(1);
    app.server.posts[0].resolve(200, { choice: done() });
    await settle();
    expect(app.buttons()).toEqual([]);
    expect(app.status()).toBe(`Erledigt: Erlauben · im Browser · ${clock(AT)}`);
    // Alte Knopf-Referenzen nach der Entscheidung: nichts passiert
    allow.dispatch("click");
    deny.dispatch("click");
    await settle();
    expect(app.server.posts).toHaveLength(1);
  });

  test("Sperre hält über ein Neuzeichnen (neue Nachricht per SSE) hinweg", async () => {
    const app = setup();
    await settle();
    app.buttons()[0].dispatch("click");
    await settle();
    app.emit(app.conversationSource(), "message", { id: "m-neu", role: "assistant", text: "Zwischenstand", html: "<p>Zwischenstand</p>", createdAt: new Date().toISOString() });
    await settle();
    expect(app.buttons().map(b => b.disabled)).toEqual([true, true]);
    app.buttons()[1].dispatch("click");
    await settle();
    expect(app.server.posts).toHaveLength(1);
  });

  test("409 schon entschieden: zeigt den gemeldeten Endzustand statt eines Fehlers", async () => {
    const app = setup();
    await settle();
    app.buttons()[1].dispatch("click");
    await settle();
    app.server.posts[0].resolve(409, { error: "Diese Rückfrage ist schon entschieden.", already: true, choice: done("Abc123", "telegram") });
    await settle();
    expect(app.status()).toBe(`Erledigt: Erlauben · in Telegram · ${clock(AT)}`);
    expect(app.error()).toBeUndefined();
  });

  test("409 abgelaufen und 404: „Abgelaufen“, kein Fehler", async () => {
    const app = setup({ messages: { "topic-8": [question("1", open("Abc123")), question("2", open("Def456"))] } });
    await settle();
    app.buttons("Abc123")[0].dispatch("click");
    app.buttons("Def456")[0].dispatch("click");
    await settle();
    expect(app.server.posts).toHaveLength(2);
    app.server.posts[0].resolve(409, { error: "Diese Rückfrage ist abgelaufen.", expired: true, choice: { id: "Abc123", options: [], state: "expired" } });
    app.server.posts[1].resolve(404, { error: "Diese Rückfrage gibt es in diesem Gespräch nicht." });
    await settle();
    expect(app.status("Abc123")).toBe("Abgelaufen");
    expect(app.status("Def456")).toBe("Abgelaufen");
    expect(app.error("Abc123")).toBeUndefined();
  });

  test("Fehler (500, Netzwerk): Meldung unter den Knöpfen, Knöpfe wieder frei", async () => {
    const app = setup();
    await settle();
    app.buttons()[0].dispatch("click");
    await settle();
    app.server.posts[0].resolve(500, { error: "Die Auswahl ist fehlgeschlagen." });
    await settle();
    expect(app.error()!.textContent).toBe("Die Auswahl ist fehlgeschlagen.");
    expect(app.error()!.attributes.role).toBe("alert");
    expect(app.buttons().map(b => b.disabled)).toEqual([false, false]);
    app.buttons()[0].dispatch("click");
    await settle();
    app.server.posts[1].fail();
    await settle();
    expect(app.error()!.textContent).toBe("Server nicht erreichbar.");
    expect(app.buttons().map(b => b.disabled)).toEqual([false, false]);
  });
});

describe("Live", () => {
  test("SSE choice aus Telegram (via telegram) ersetzt die Knöpfe ohne Neuladen", async () => {
    const app = setup();
    await settle();
    const gets = app.messageGets("topic-8").length;
    app.emit(app.conversationSource(), "choice", { conversationId: "topic-8", choice: done("Abc123", "telegram", "Ablehnen") });
    await settle();
    expect(app.buttons()).toEqual([]);
    expect(app.status()).toBe(`Erledigt: Ablehnen · in Telegram · ${clock(AT)}`);
    expect(app.messageGets("topic-8").length).toBe(gets);
  });

  test("Merk-Vorschlag im Web-Gespräch (Issue #117): Knöpfe, „Verwerfen“ in Telegram erscheint ohne Neuladen", async () => {
    const REVIEW = [{ key: "ok", label: "Übernehmen" }, { key: "no", label: "Verwerfen" }];
    const proposal = question("r", open("Rev123", { options: REVIEW }), { source: "review", text: "🧠 Merk-Vorschlag", html: "<p>🧠 Merk-Vorschlag</p>" });
    const app = setup({ messages: { [WEB]: [proposal] }, stored: WEB });
    await settle();
    expect(app.buttons("Rev123").map(b => b.textContent)).toEqual(["Übernehmen", "Verwerfen"]);
    const gets = app.messageGets(WEB).length;
    app.emit(app.conversationSource(), "choice", { conversationId: WEB, choice: { id: "Rev123", options: [], state: "done", result: { key: "no", label: "Verwerfen", via: "telegram", at: AT } } });
    await settle();
    expect(app.buttons("Rev123")).toEqual([]);
    expect(app.status("Rev123")).toBe(`Erledigt: Verwerfen · in Telegram · ${clock(AT)}`);
    expect(app.messageGets(WEB).length).toBe(gets);
  });

  test("SSE choice für ein anderes Gespräch ändert nichts", async () => {
    const app = setup();
    await settle();
    app.emit(app.conversationSource(), "choice", { conversationId: "topic-443", choice: done() });
    await settle();
    expect(app.buttons()).toHaveLength(2);
  });

  test("verspätetes GET nach entschiedenem SSE öffnet die Knöpfe nicht wieder; Endzustand aus GET wird übernommen", async () => {
    const app = setup();
    await settle();
    app.emit(app.conversationSource(), "choice", { conversationId: "topic-8", choice: done("Abc123", "telegram") });
    await settle();
    // Wiederverbinden: open gleicht den Verlauf ab, der Server liefert noch „offen"
    app.conversationSource().emit("open");
    await settle();
    expect(app.buttons()).toEqual([]);
    expect(app.status()).toContain("in Telegram");
    // Umgekehrt: GET bringt den Endzustand einer bekannten Nachricht
    app.server.messages["topic-8"] = [question("1", done("Abc123", "telegram")), question("2", open("Def456"))];
    app.emit(app.conversationSource(), "choice", { conversationId: "topic-8", choice: { id: "Def456", options: [], state: "expired" } });
    app.conversationSource().emit("open");
    await settle();
    expect(app.status("Def456")).toBe("Abgelaufen");
  });

  test("verspätete POST-Antwort nach Gesprächswechsel ändert das neue Gespräch nicht; zurück: erledigt", async () => {
    const app = setup({
      messages: { "topic-8": [question("1", open())], "topic-443": [question("9", open("Zzz999"))] },
    });
    await settle();
    app.buttons()[0].dispatch("click");
    await settle();
    app.entry("topic-443").dispatch("click");
    await settle();
    expect(app.buttons("Zzz999").map(b => b.disabled)).toEqual([false, false]);
    app.server.posts[0].resolve(200, { choice: done() });
    await settle();
    expect(app.buttons("Zzz999").map(b => b.disabled)).toEqual([false, false]);
    expect(app.status("Zzz999")).toBeUndefined();
    // Der Server kennt die Entscheidung erst später; zurück im Topic bleibt sie erledigt
    app.entry("topic-8").dispatch("click");
    await settle();
    expect(app.status()).toBe(`Erledigt: Erlauben · im Browser · ${clock(AT)}`);
  });

  test("Sammelstrom: erledigte Rückfrage, die hier noch offen steht, gleicht den Verlauf ab", async () => {
    const app = setup();
    await settle();
    const before = app.messageGets("topic-8").length;
    app.server.messages["topic-8"] = [question("1", done("Abc123", "telegram"))];
    app.emit(app.activitySource(), "choice", { conversationId: "topic-8", id: "Abc123", state: "done" });
    await settle();
    expect(app.messageGets("topic-8").length).toBe(before + 1);
    expect(app.status()).toContain("Erledigt: Erlauben · in Telegram");
    // Unbekannte oder schon erledigte Fragen lösen nichts aus
    app.emit(app.activitySource(), "choice", { conversationId: "topic-8", id: "Abc123", state: "done" });
    app.emit(app.activitySource(), "choice", { conversationId: "topic-443", id: "Fremd1", state: "done" });
    await settle();
    expect(app.messageGets("topic-8").length).toBe(before + 1);
  });
});

describe("Wiederverbinden: Stand aller geladenen Rückfragen", () => {
  const newer = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `neu-${i}`, role: "assistant", kind: "notice", source: "pipeline", text: `Meldung ${i}`, html: `<p>Meldung ${i}</p>`, createdAt: now }));

  test("ältere offene Frage außerhalb der jüngsten Seite, in der Lücke in Telegram entschieden: nach dem Wiederverbinden erledigt", async () => {
    const app = setup();
    await settle();
    expect(app.buttons()).toHaveLength(2);
    // Verbindung weg; inzwischen 50 neuere Meldungen und die Entscheidung in Telegram, deren Ereignis verloren ging
    app.server.messages["topic-8"] = newer(50);
    app.server.choices["Abc123"] = done("Abc123", "telegram", "Ablehnen");
    app.conversationSource().emit("open");
    await settle();
    expect(app.server.calls).toContain("GET /api/conversations/topic-8/choices?ids=Abc123");
    expect(app.buttons()).toEqual([]);
    expect(app.status()).toBe(`Erledigt: Ablehnen · in Telegram · ${clock(AT)}`);
  });

  test("nur offene, noch nicht entschiedene Fragen werden abgefragt; ohne offene keine Abfrage", async () => {
    const app = setup({ messages: { "topic-8": [question("1", open()), question("2", done("Def456")), question("3", open("Ghi789"))] } });
    await settle();
    expect(app.server.calls.filter(c => c.includes("/choices?"))).toEqual(["GET /api/conversations/topic-8/choices?ids=Abc123,Ghi789"]);
    app.server.choices["Abc123"] = done();
    app.server.choices["Ghi789"] = { id: "Ghi789", options: [], state: "expired" };
    app.conversationSource().emit("open");
    await settle();
    expect(app.status()).toContain("Erledigt: Erlauben");
    expect(app.status("Ghi789")).toBe("Abgelaufen");
    const before = app.server.calls.length;
    app.conversationSource().emit("open");
    await settle();
    expect(app.server.calls.slice(before).filter(c => c.includes("/choices?"))).toEqual([]);
  });

  test("Stand-Abfrage scheitert (Register nicht lesbar): Knöpfe bleiben, Hinweis und neuer Versuch; danach erledigt", async () => {
    const app = setup();
    await settle();
    app.server.messages["topic-8"] = newer(50);
    app.server.choicesStatus = 503;
    app.server.choices["Abc123"] = done("Abc123", "telegram");
    app.conversationSource().emit("open");
    await settle();
    expect(app.buttons()).toHaveLength(2);
    expect(app.status()).toBeUndefined();
    app.server.choicesStatus = 200;
    app.conversationSource().emit("open");
    await settle();
    expect(app.status()).toContain("Erledigt: Erlauben · in Telegram");
  });

  test("„Abgelaufen“ lässt sich durch ein späteres Erledigt korrigieren, Erledigt nicht durch Abgelaufen", async () => {
    const app = setup();
    await settle();
    app.emit(app.conversationSource(), "choice", { conversationId: "topic-8", choice: { id: "Abc123", options: [], state: "expired" } });
    await settle();
    expect(app.status()).toBe("Abgelaufen");
    app.emit(app.conversationSource(), "choice", { conversationId: "topic-8", choice: done("Abc123", "telegram") });
    await settle();
    expect(app.status()).toContain("Erledigt: Erlauben · in Telegram");
    app.emit(app.conversationSource(), "choice", { conversationId: "topic-8", choice: { id: "Abc123", options: [], state: "expired" } });
    app.emit(app.conversationSource(), "choice", { conversationId: "topic-8", choice: open() });
    await settle();
    expect(app.status()).toContain("Erledigt: Erlauben · in Telegram");
    expect(app.buttons()).toEqual([]);
  });
});

describe("Kopie im Direktchat", () => {
  test("keine Knöpfe, Hinweis und „Zum Gespräch“ öffnet das Web-Gespräch; erledigt: Zeile", async () => {
    const app = setup({
      stored: "dm",
      messages: { dm: [question("1", { id: "Web123", options: [], state: "open", elsewhere: WEB })], [WEB]: [] },
    });
    await settle();
    expect(app.buttons("Web123")).toEqual([]);
    const nodes = app.all(app.box("Web123")!);
    expect(nodes.find(n => n.className === "choice-status")!.textContent).toBe("Antwort im Gespräch, aus dem die Frage kommt.");
    const link = nodes.find(n => String(n.className).includes("choice-open"))!;
    expect(link.textContent).toBe("Zum Gespräch");
    app.emit(app.conversationSource(), "choice", { conversationId: "dm", choice: { ...done("Web123", "web"), elsewhere: WEB } });
    await settle();
    expect(app.status("Web123")).toBe(`Erledigt: Erlauben · im Browser · ${clock(AT)}`);
    link.dispatch("click");
    await settle();
    expect(app.messageGets(WEB).length).toBe(1);
    expect(app.server.posts).toEqual([]);
  });
});

describe("Register beim Server nicht lesbar (nur choiceId, ohne choice)", () => {
  /** Nachricht, wie der Server sie bei einem Lesefehler liefert */
  const unread = (id: string, choiceId: string, over: Record<string, any> = {}) => question(id, null, { choiceId, ...over });

  test("vorhandene Web-Rückfrage: Abgleich während der Störung behält die Knöpfe; nach der Erholung Ergebnis ohne Neuladen", async () => {
    const app = setup({ stored: WEB, messages: { [WEB]: [question("1", open())] } });
    await settle();
    expect(app.buttons()).toHaveLength(2);
    // Störung: Verlauf nur mit Kennung, Stand-Abfrage 503
    app.server.messages[WEB] = [unread("1", "Abc123")];
    app.server.choicesStatus = 503;
    app.conversationSource().emit("open");
    await settle();
    expect(app.buttons()).toHaveLength(2);
    expect(app.snapshots()).toEqual([`GET /api/conversations/${WEB}/choices?ids=Abc123`, `GET /api/conversations/${WEB}/choices?ids=Abc123`]);
    // Erholung: inzwischen in Telegram entschieden; der neue Versuch bringt es ohne weiteres Zutun
    app.server.choicesStatus = 200;
    app.server.choices["Abc123"] = done("Abc123", "telegram", "Ablehnen");
    app.runTimers();
    await settle();
    expect(app.buttons()).toEqual([]);
    expect(app.status()).toBe(`Erledigt: Ablehnen · in Telegram · ${clock(AT)}`);
  });

  test("vorhandene Web-Rückfrage: SSE choice nach der Störung trifft die Nachricht weiter", async () => {
    const app = setup({ stored: WEB, messages: { [WEB]: [question("1", open())] } });
    await settle();
    app.server.messages[WEB] = [unread("1", "Abc123")];
    app.server.choicesStatus = 503;
    app.conversationSource().emit("open");
    await settle();
    app.emit(app.conversationSource(), "choice", { conversationId: WEB, choice: done("Abc123", "telegram") });
    await settle();
    expect(app.status()).toContain("Erledigt: Erlauben · in Telegram");
  });

  test("Telegram-Verlauf erstmals während der Störung geladen: keine Knöpfe, neuer Versuch; nach der Erholung offene Knöpfe", async () => {
    const app = setup({ messages: { "topic-8": [unread("1", "Abc123")] } });
    app.server.choicesStatus = 503;
    await settle();
    expect(app.box()).toBeUndefined();
    expect(app.snapshots()).toEqual(["GET /api/conversations/topic-8/choices?ids=Abc123"]);
    app.server.choicesStatus = 200;
    app.server.choices["Abc123"] = open();
    app.runTimers();
    await settle();
    expect(app.buttons()).toHaveLength(2);
    // Offen gemeldet: ein späteres SSE choice ersetzt die Knöpfe durch das Ergebnis
    app.emit(app.conversationSource(), "choice", { conversationId: "topic-8", choice: done("Abc123", "telegram") });
    await settle();
    expect(app.status()).toContain("Erledigt: Erlauben · in Telegram");
  });

  test("Live-Nachricht während der Störung: Stand wird nachgeholt, nach der Erholung Ergebnis ohne Neuladen", async () => {
    const app = setup({ messages: { "topic-8": [] } });
    await settle();
    app.server.choicesStatus = 503;
    app.emit(app.conversationSource(), "message", unread("live", "Live1234"));
    await settle();
    expect(app.box("Live1234")).toBeUndefined();
    expect(app.snapshots()).toEqual(["GET /api/conversations/topic-8/choices?ids=Live1234"]);
    app.server.choicesStatus = 200;
    app.server.choices["Live1234"] = done("Live1234", "telegram");
    app.runTimers();
    await settle();
    expect(app.status("Live1234")).toContain("Erledigt: Erlauben · in Telegram");
  });

  test("Live-Nachricht während der Störung: Sammelstrom-Ereignis nach der Erholung gleicht ab", async () => {
    const app = setup({ messages: { "topic-8": [] } });
    await settle();
    app.server.choicesStatus = 503;
    app.emit(app.conversationSource(), "message", unread("live", "Live1234"));
    await settle();
    app.server.choicesStatus = 200;
    app.server.choices["Live1234"] = done("Live1234", "telegram");
    app.emit(app.activitySource(), "choice", { conversationId: "topic-8", id: "Live1234", state: "done" });
    await settle();
    expect(app.status("Live1234")).toContain("Erledigt: Erlauben · in Telegram");
  });

  test("ältere Seite während der Störung nachgeladen: nach der Erholung offene Knöpfe ohne Neuladen", async () => {
    const plain = { id: "neu", role: "assistant", kind: "notice", source: "pipeline", text: "Meldung", html: "<p>Meldung</p>", createdAt: now };
    const app = setup({ messages: { "topic-8": [plain] } });
    app.server.older["topic-8"] = [unread("alt", "Old12345", { createdAt: "2026-09-01T08:00:00.000Z" })];
    await settle();
    expect(app.snapshots()).toEqual([]);
    expect(app.elements["load-older"].hidden).toBe(false);
    // Störung: die ältere Seite bringt nur die Kennung, die Stand-Abfrage scheitert
    app.server.choicesStatus = 503;
    app.elements["load-older"].dispatch("click");
    await settle();
    expect(app.box("Old12345")).toBeUndefined();
    expect(app.snapshots()).toEqual(["GET /api/conversations/topic-8/choices?ids=Old12345"]);
    // Erholung: Frage weiterhin offen; der neue Versuch bringt die Knöpfe ohne Neuladen, Wechsel oder SSE-open
    app.server.choicesStatus = 200;
    app.server.choices["Old12345"] = open("Old12345");
    const opens = app.conversationSource();
    app.runTimers();
    await settle();
    expect(app.buttons("Old12345")).toHaveLength(2);
    expect(app.conversationSource()).toBe(opens);
  });

  test("ungültige Kennung ohne choice: keine Stand-Abfrage", async () => {
    const app = setup({ messages: { "topic-8": [unread("1", "../x")] } });
    await settle();
    expect(app.snapshots()).toEqual([]);
    expect(app.box()).toBeUndefined();
  });
});

describe("Topic-Zuordnung (Issue #119)", () => {
  const AGENTS = [
    { key: "general", label: "General Agent" },
    { key: "research", label: "Research Agent (Deep Research)" },
    { key: "content", label: "Content Agent" },
    { key: "finance", label: "Finance Agent" },
    { key: "strategy", label: "Strategy Agent" },
    { key: "cto", label: "CTO" },
    { key: "coo", label: "COO" },
    { key: "critic", label: "Critic Agent" },
    { key: "planer", label: "planer" },
    { key: "a" + "b".repeat(28) + "c", label: "a" + "b".repeat(28) + "c" },
  ];
  const topicQuestion = (state: Record<string, any>) =>
    question("1", { id: "Map1234567", ...state }, { source: "topic", text: "Dieses Topic (ID 77) ist noch keinem Agent zugeordnet." });

  test("Knöpfe für alle Agenten, Klick entscheidet, Topic-Ereignis wechselt den Chip ohne Neuladen", async () => {
    const topics = [{ id: "topic-77", title: "Neues Projekt", agent: "general", lastActivity: now }, ...TOPICS];
    const app = setup({ stored: "topic-77", topics, messages: { "topic-77": [topicQuestion({ options: AGENTS, state: "open" })] } });
    await settle();
    expect(app.buttons("Map1234567").map(b => [b.textContent, b.attributes["data-key"]])).toEqual(AGENTS.map(a => [a.label, a.key]));
    expect(app.elements["agent-name"].textContent).toBe("General");

    app.buttons("Map1234567")[1].dispatch("click");
    await settle();
    expect(app.server.posts.map(p => [p.path, p.body])).toEqual([["/api/conversations/topic-77/choices/Map1234567", { option: "research" }]]);
    app.server.posts[0].resolve(200, {
      choice: { id: "Map1234567", options: [], state: "done", result: { key: "research", label: "Research Agent (Deep Research)", via: "web", at: AT } },
    });
    await settle();
    expect(app.buttons("Map1234567")).toEqual([]);
    expect(app.status("Map1234567")).toBe(`Erledigt: Research Agent (Deep Research) · im Browser · ${clock(AT)}`);

    // Der Server meldet das Topic im Sammelstrom, die Liste bringt den neuen Agenten
    app.server.topics[0].agent = "research";
    const reloads = app.server.calls.length;
    app.emit(app.activitySource(), "topic", { id: "topic-77" });
    await settle();
    expect(app.server.calls.slice(reloads)).toContain("GET /api/conversations");
    expect(app.elements["agent-name"].textContent).toBe("Research");
    expect(app.elements["agent-name"].attributes["data-agent"]).toBe("research");
    expect(app.server.calls.filter(c => c === "GET /").length).toBe(0);
  });

  test("in Telegram entschieden: Erledigt-Zeile nach dem Abgleich, Chip über das Topic-Ereignis", async () => {
    const topics = [{ id: "topic-77", title: "Neues Projekt", agent: "general", lastActivity: now }, ...TOPICS];
    const app = setup({ stored: "topic-77", topics, messages: { "topic-77": [topicQuestion({ options: AGENTS, state: "open" })] } });
    await settle();
    app.server.messages["topic-77"] = [topicQuestion({ options: [], state: "done", result: { key: "finance", label: "Finance Agent", via: "telegram", at: AT } })];
    app.server.topics[0].agent = "finance";
    app.emit(app.activitySource(), "choice", { id: "Map1234567", state: "done" });
    app.emit(app.activitySource(), "topic", { id: "topic-77" });
    await settle();
    expect(app.status("Map1234567")).toBe(`Erledigt: Finance Agent · in Telegram · ${clock(AT)}`);
    expect(app.elements["agent-name"].textContent).toBe("Finance");
  });
});
