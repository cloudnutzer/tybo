// Offene Fäden (Issue #293) in der Chat-Seite (app.js) ohne Browser: nach
// einer Antwort fragt die Seite nach, solange der Server Nacharbeit meldet
// (pending), auch weit über eine Minute hinaus. Attrappen für DOM, fetch,
// EventSource und Timer wie in web-app-sync.test.ts.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TYBO_BRAND } from "./brand-fixture";

const source = await readFile(resolve(import.meta.dir, "..", "src", "web", "public", "app.js"), "utf8");
const themeSource = await readFile(resolve(import.meta.dir, "..", "src", "web", "public", "theme.js"), "utf8");

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
    // Wie im DOM: textContent setzen ersetzt die Kinder (renderThreads leert so die Liste)
    _text: "",
    get textContent() { return this._text; },
    set textContent(v: string) { this._text = v; this.children = []; },
    hidden: false,
    disabled: false,
    value: "",
    scrollHeight: 0,
    scrollTop: 0,
    clientHeight: 0,
    set innerHTML(_v: string) {},
    appendChild(child: Node) { this.children.push(child); return child; },
    replaceChildren(...list: Node[]) {
      this.children = list.flatMap(c => (c.fragment ? c.children : [c]));
    },
    setAttribute(name: string, value: string) { this.attributes[name] = value; },
    getAttribute(name: string) { return this.attributes[name]; },
    removeAttribute(name: string) { delete this.attributes[name]; },
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

interface ThreadItem { id: string; nr: number; state: "open"; topic: string; context: string; question: string; conversation: { type: string; id: string | null; name: string }; age: string; reminders: number }

const item = (nr: number): ThreadItem => ({
  id: `t${nr}`,
  nr,
  state: "open",
  topic: `Thema ${nr}`,
  context: "Kontext.",
  question: `Frage ${nr}?`,
  conversation: { type: "web", id: "c1", name: "Gespräch" },
  age: "seit heute",
  reminders: 0,
});

function setup(initialThreads?: Record<string, unknown>[]) {
  FakeEventSource.all = [];
  const elements: Record<string, Node> = {};
  const document = {
    getElementById(id: string) { return (elements[id] ??= node()); },
    createElement() { return node(); },
    createTextNode(text: string) { const t = node(); t.textContent = text; return t; },
    createDocumentFragment() { const f = node(); f.fragment = true; return f; },
    documentElement: { dataset: {} as Record<string, string> },
    querySelectorAll: () => [],
    querySelector: () => null,
  };
  const stored: Record<string, string> = {};
  const window: Record<string, any> = {
    TYBO_BRAND,
    localStorage: {
      getItem: (key: string) => stored[key] ?? null,
      setItem: (key: string, value: string) => { stored[key] = value; },
    },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ lineHeight: "22", paddingTop: "0", paddingBottom: "0", borderTopWidth: "0", borderBottomWidth: "0" }),
    addEventListener() {},
    location: { href: "/", hash: "", pathname: "/", search: "" },
  };
  // Timer nur auf Abruf; der auf Mitternacht (Issue #186) wartet Stunden und bleibt liegen
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let nextTimer = 1;
  const setTimeout = (fn: () => void, ms?: number) => { const id = nextTimer++; timers.set(id, { fn, ms: ms ?? 0 }); return id; };
  const clearTimeout = (id: number) => { timers.delete(id); };
  /** Führt die fälligen kurzen Timer aus und stellt die Uhr um die größte Verzögerung vor */
  const runTimers = () => {
    const due = [...timers.entries()].filter(([, t]) => t.ms < 60 * 60_000);
    for (const [id] of due) timers.delete(id);
    const step = Math.max(0, ...due.map(([, t]) => t.ms));
    setSystemTime(new Date(Date.now() + step));
    for (const [, t] of due) t.fn();
  };
  const threadTimers = () => [...timers.values()].filter(t => t.ms < 60 * 60_000).length;

  // Antworten von GET /api/threads der Reihe nach; die letzte bleibt stehen
  const server = {
    threads: initialThreads ?? ([{ enabled: true, count: 0, pending: false, open: [] as ThreadItem[], closed: [] }] as Record<string, unknown>[]),
    threadCalls: 0,
  };
  const fetch = async (path: string) => {
    if (path === "/api/presence") return { ok: true, status: 204, json: async () => ({}) } as any;
    if (path === "/api/conversations") return Response.json({ conversations: [{ id: "c1", agent: "general" }] });
    if (path === "/api/me") return Response.json({ ok: true });
    if (path === "/api/conversations/c1/messages") return Response.json({ messages: [], running: false });
    if (path.startsWith("/api/threads")) {
      server.threadCalls++;
      const body = server.threads.length > 1 ? server.threads.shift()! : server.threads[0];
      return Response.json(body);
    }
    return Response.json({}, { status: 404 });
  };

  new Function("document", "window", themeSource)(document, window);
  new Function("document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout", source)(
    document, window, fetch, FakeEventSource, setTimeout, clearTimeout
  );

  const chatSource = () => FakeEventSource.all.filter(s => s.url === "/api/conversations/c1/events").at(-1)!;
  /** Antwort des Assistenten kommt per SSE */
  const reply = (id: string) =>
    chatSource().emit("message", { data: JSON.stringify({ id, role: "assistant", text: id, html: `<p>${id}</p>`, createdAt: new Date().toISOString() }) });
  /** Anzahl an der Seitenleiste ("" ohne Anzeige) */
  const count = () => (elements["threads-count"].hidden ? "" : elements["threads-count"].textContent);
  /** Nummern der Fäden in der geöffneten Liste */
  const listed = () =>
    elements["threads-body"].children
      .filter(c => c.className === "thread-list")
      .flatMap(list => list.children.map(li => li.attributes["data-thread-id"]));
  const bodyText = () => elements["threads-body"].children.map(c => c.textContent).join(" ");
  const openView = () => elements["open-threads"].dispatch("click");
  return { server, runTimers, threadTimers, reply, count, listed, bodyText, openView, chatSource, elements };
}

async function settle() {
  for (let i = 0; i < 20; i++) await Bun.sleep(0);
}

/** Läuft die Nachfrage-Kette, bis keine Timer mehr anstehen (höchstens limit Runden) */
async function runChain(app: ReturnType<typeof setup>, limit = 1_000) {
  let rounds = 0;
  while (app.threadTimers() > 0 && rounds < limit) {
    app.runTimers();
    await settle();
    rounds++;
  }
  return rounds;
}

const pendingFor = (n: number, open: ThreadItem[]) => Array.from({ length: n }, () => ({ enabled: true, count: open.length, pending: true, open, closed: [] }));
const done = (open: ThreadItem[]) => ({ enabled: true, count: open.length, pending: false, open, closed: [] });

async function started() {
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  setSystemTime(noon);
  const app = setup();
  await settle();
  app.chatSource().emit("open");
  await settle();
  return app;
}

afterEach(() => setSystemTime());

describe("Fäden nach einer Antwort nachholen (Issue #293)", () => {
  test("späte Neuanlage nach über 65 Sekunden: Anzahl und geöffnete Liste stimmen ohne Neuladen", async () => {
    const app = await started();
    app.openView();
    await settle();
    expect(app.count()).toBe("");
    expect(app.bodyText()).toContain("Keine offenen Fäden.");

    // Nebenmodell und Warteschlange brauchen lange: 40 Abfragen mit pending (über 3 Minuten)
    app.server.threads = [...pendingFor(40, []), done([item(7)])];
    const t0 = Date.now();
    app.reply("a1");
    await runChain(app);
    expect(Date.now() - t0).toBeGreaterThan(65_000);
    expect(app.count()).toBe("1");
    expect(app.listed()).toEqual(["t7"]);
    // Danach ist Ruhe: keine weitere Abfrage geplant
    expect(app.threadTimers()).toBe(0);
    const calls = app.server.threadCalls;
    app.runTimers();
    await settle();
    expect(app.server.threadCalls).toBe(calls);
  });

  test("späte Auflösung: der Faden verschwindet aus Anzahl und Liste, auch nach Minuten", async () => {
    const app = await started();
    app.server.threads = [done([item(3)])];
    app.openView();
    await settle();
    expect(app.count()).toBe("1");
    expect(app.listed()).toEqual(["t3"]);

    app.server.threads = [...pendingFor(30, [item(3)]), done([])];
    app.reply("a1");
    await runChain(app);
    expect(app.count()).toBe("");
    expect(app.listed()).toEqual([]);
    expect(app.bodyText()).toContain("Keine offenen Fäden.");
  });

  test("wartende Nacharbeit: Neuanlage geschrieben, Auflösen wartet noch; erst pending false beendet das Nachfragen", async () => {
    const app = await started();
    app.openView();
    await settle();
    // Erster Turn legt t5 an (nach 20 Abfragen sichtbar), der zweite wartet und löst es danach auf
    app.server.threads = [...pendingFor(20, []), ...pendingFor(25, [item(5)]), done([])];
    app.reply("a1");
    app.reply("a2");
    // Nach den festen Abfragen und einigen weiteren ist t5 sichtbar, die Kette läuft weiter
    for (let i = 0; i < 25; i++) {
      app.runTimers();
      await settle();
    }
    expect(app.count()).toBe("1");
    expect(app.listed()).toEqual(["t5"]);
    expect(app.threadTimers()).toBe(1);

    await runChain(app);
    expect(app.count()).toBe("");
    expect(app.listed()).toEqual([]);
    expect(app.threadTimers()).toBe(0);
  });

  test("ohne Nacharbeit: nur die festen Abfragen, danach keine weitere", async () => {
    const app = await started();
    const before = app.server.threadCalls;
    app.reply("a1");
    const rounds = await runChain(app);
    expect(rounds).toBe(2);
    expect(app.server.threadCalls).toBe(before + 2);
  });

  test("Obergrenze: meldet der Server endlos pending, endet das Nachfragen nach 30 Minuten", async () => {
    const app = await started();
    app.server.threads = [{ enabled: true, count: 0, pending: true, open: [], closed: [] }];
    const t0 = Date.now();
    app.reply("a1");
    await runChain(app);
    expect(app.threadTimers()).toBe(0);
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(30 * 60_000);
    expect(elapsed).toBeLessThan(31 * 60_000);
  });
});

describe("Fäden laden, während Nacharbeit läuft, ohne neue Antwort (Issue #293)", () => {
  /** Startet die Seite mit vorgegebenen Antworten von GET /api/threads schon beim Erstladen */
  async function startedWith(threads: Record<string, unknown>[]) {
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    setSystemTime(noon);
    const app = setup(threads);
    await settle();
    app.chatSource().emit("open");
    await settle();
    return app;
  }

  test("Ansicht öffnen während Nacharbeit, späte Neuanlage: Anzahl und Liste zeigen selbstständig den Endstand", async () => {
    const app = await started();
    expect(app.threadTimers()).toBe(0);
    app.server.threads = [...pendingFor(20, []), done([item(9)])];
    app.openView();
    await settle();
    expect(app.listed()).toEqual([]);
    await runChain(app);
    expect(app.count()).toBe("1");
    expect(app.listed()).toEqual(["t9"]);
    expect(app.threadTimers()).toBe(0);
  });

  test("Ansicht öffnen während Nacharbeit, späte Auflösung: der Faden verschwindet ohne weitere Aktion", async () => {
    const app = await started();
    app.server.threads = [...pendingFor(15, [item(4)]), done([])];
    app.openView();
    await settle();
    expect(app.count()).toBe("1");
    expect(app.listed()).toEqual(["t4"]);
    await runChain(app);
    expect(app.count()).toBe("");
    expect(app.listed()).toEqual([]);
    expect(app.bodyText()).toContain("Keine offenen Fäden.");
    expect(app.threadTimers()).toBe(0);
  });

  test("Erstladen bzw. Neuladen während Nacharbeit: Anzahl folgt bis zum Endstand, auch die danach geöffnete Liste", async () => {
    const app = await startedWith([...pendingFor(12, [item(2)]), done([item(2), item(6)])]);
    expect(app.count()).toBe("1");
    expect(app.threadTimers()).toBe(1);
    await runChain(app);
    expect(app.count()).toBe("2");
    expect(app.threadTimers()).toBe(0);
    app.openView();
    await settle();
    expect(app.listed()).toEqual(["t2", "t6"]);
  });

  test("Ansicht mehrfach laden während Nacharbeit: nur eine Abfragekette", async () => {
    const app = await started();
    app.server.threads = [...pendingFor(10, []), done([item(1)])];
    app.openView();
    await settle();
    expect(app.threadTimers()).toBe(1);
    // Neuladen über die Sichtbarkeit bzw. erneutes Laden setzt die Kette fort statt eine zweite zu starten
    app.openView();
    await settle();
    expect(app.threadTimers()).toBe(1);
    await runChain(app);
    expect(app.count()).toBe("1");
    expect(app.listed()).toEqual(["t1"]);
    expect(app.threadTimers()).toBe(0);
  });
});
