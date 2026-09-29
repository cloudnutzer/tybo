// Verlaufabgleich der Chat-Seite (app.js) ohne Browser: Attrappen für DOM,
// fetch, EventSource und Timer, damit sich die Reihenfolge exakt steuern lässt.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TYBO_BRAND } from "./brand-fixture";

const source = await readFile(resolve(import.meta.dir, "..", "src", "web", "public", "app.js"), "utf8");
// Läuft im Browser vorher im <head> (Issue #15); app.js verbindet damit den Schalter
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
    textContent: "",
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

type Message = { id: string; role: string; text: string; html?: string; createdAt: string; approvalId?: string; choiceId?: string; choice?: unknown };

function setup(prepare?: (server: any) => void) {
  FakeEventSource.all = [];
  const elements: Record<string, Node> = {};
  const document = {
    getElementById(id: string) { return (elements[id] ??= node()); },
    createElement() { return node(); },
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
    location: { href: "/" },
  };
  // Timer nur auf Abruf
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  /** Verzögerung je Timer: der Timer auf Mitternacht (Issue #186) wartet Stunden */
  const delays = new Map<number, number>();
  const setTimeout = (fn: () => void, ms?: number) => { const id = nextTimer++; timers.set(id, fn); delays.set(id, ms ?? 0); return id; };
  /** Offene Timer außer dem auf Mitternacht (nur mit Uhr um 12 Uhr eindeutig) */
  const shortTimers = () => [...timers.keys()].filter(id => (delays.get(id) ?? 0) < 60 * 60_000).length;
  const clearTimeout = (id: number) => { timers.delete(id); };
  const runTimers = () => {
    const due = [...timers.entries()];
    timers.clear();
    for (const [, fn] of due) fn();
  };

  // Server-Zustand, den der Test verändert
  const server = {
    messages: [] as Message[],
    /** Nächste Verlaufabrufe schlagen so fehl: "network" oder HTTP-Status */
    failures: [] as ("network" | number)[],
    historyCalls: 0,
    /** Zustand des Turns, wie ihn der Verlaufabruf meldet */
    status: { running: false } as Record<string, unknown>,
    /** Hält den nächsten Verlaufabruf an, bis der Test ihn freigibt */
    holdHistory: null as Promise<void> | null,
    posts: [] as unknown[],
    /** Gesprächsliste der Seitenleiste, jüngstes zuerst */
    conversations: [{ id: "c1", agent: "general" }] as { id: string; agent: string; title?: string }[],
    /** Verlauf weiterer Gespräche (c1 nutzt messages und status) */
    others: {} as Record<string, Message[]>,
    /** Gespräche, für die Stopp gedrückt wurde */
    stops: [] as string[],
    /** Zusätzliche Felder der POST-Antwort, z. B. running nach einem Befehl (Issue #74) */
    postExtra: {} as Record<string, unknown>,
  };
  const fetch = async (path: string, init?: { method?: string; body?: string }) => {
    if (path === "/api/conversations") {
      return Response.json({ conversations: server.conversations });
    }
    if (path === "/api/me") return Response.json({ ok: true });
    const stop = path.match(/^\/api\/conversations\/([^/]+)\/stop$/);
    if (stop && init?.method === "POST") {
      server.stops.push(stop[1]);
      return Response.json({ stopping: true });
    }
    const other = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (other && other[1] !== "c1") return Response.json({ messages: server.others[other[1]] ?? [], running: false });
    if (path === "/api/conversations/c1/messages") {
      server.historyCalls++;
      const failure = server.failures.shift();
      if (failure === "network") throw new TypeError("Failed to fetch");
      if (typeof failure === "number") return Response.json({ error: "kaputt" }, { status: failure });
      if (init?.method === "POST") {
        server.posts.push(JSON.parse(init.body!));
        return Response.json({ message: msg("u-post", "user", 59), ...server.postExtra }, { status: 202 });
      }
      // Stand beim Abruf, Antwort erst nach Freigabe (wie ein langsamer Server)
      const body = { messages: server.messages.slice(), ...server.status };
      const hold = server.holdHistory;
      server.holdHistory = null;
      if (hold) await hold;
      return Response.json(body);
    }
    return Response.json({}, { status: 404 });
  };

  prepare?.(server);
  elements["chat-log"] = node();
  new Function("document", "window", themeSource)(document, window);
  new Function("document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout", source)(
    document, window, fetch, FakeEventSource, setTimeout, clearTimeout
  );

  const shown = () => elements["messages"].children.map(c => c.attributes["data-id"]);
  const connection = () => (elements["connection"].hidden ? "" : elements["connection"].textContent);
  const latestSource = () => FakeEventSource.all.at(-1)!;
  /** Tippt Text ein und schickt das Formular ab */
  const sendText = (text: string) => {
    elements["input"].value = text;
    elements["input"].dispatch("input");
    elements["composer"].dispatch("submit", { preventDefault() {} });
  };
  const sendEnabled = () => !elements["send"].disabled;
  return { server, shown, connection, latestSource, runTimers, timers, shortTimers, sendText, sendEnabled, elements, root: document.documentElement, stored };
}

/** Lässt ausstehende Promises (fetch, json) durchlaufen. */
async function settle() {
  for (let i = 0; i < 20; i++) await Bun.sleep(0);
}

const msg = (id: string, role: string, minute: number): Message => ({
  id, role, text: id, html: role === "assistant" ? `<p>${id}</p>` : undefined,
  createdAt: `2026-09-23T10:${String(minute).padStart(2, "0")}:00.000Z`,
});

test("Antwort zwischen Verlaufabruf und SSE-Anmeldung erscheint genau einmal", async () => {
  const app = setup();
  app.server.messages = [msg("u1", "user", 0)];
  await settle();
  // Verlauf ist geladen, die SSE-Verbindung aber noch nicht offen
  expect(app.shown()).toEqual(["u1"]);
  expect(app.server.historyCalls).toBe(1);

  // Die Antwort entsteht jetzt, ihr message-Ereignis erreicht niemanden
  app.server.messages.push(msg("a1", "assistant", 1));
  app.latestSource().emit("open");
  await settle();
  expect(app.shown()).toEqual(["u1", "a1"]);

  // Ein spätes Ereignis derselben Nachricht verdoppelt nichts
  app.latestSource().emit("message", { data: JSON.stringify(msg("a1", "assistant", 1)) });
  await settle();
  expect(app.shown()).toEqual(["u1", "a1"]);
});

afterEach(() => setSystemTime());

test("Nachladen nach Reconnect wird wiederholt, bis es klappt; Hinweis bleibt bis dahin", async () => {
  // Mittags: der Timer auf Mitternacht (Issue #186) ist klar von den Wiederholungen zu trennen
  const noon = new Date();
  noon.setHours(12, 0, 0, 0);
  setSystemTime(noon);
  const app = setup();
  app.server.messages = [msg("u1", "user", 0)];
  await settle();
  app.latestSource().emit("open");
  await settle();
  expect(app.shown()).toEqual(["u1"]);
  expect(app.connection()).toBe("");

  // Verbindung reißt ab, währenddessen entsteht die Antwort
  const first = app.latestSource();
  first.emit("error", {});
  expect(first.closed).toBe(true);
  expect(app.connection()).not.toBe("");
  app.server.messages.push(msg("a1", "assistant", 1));

  // Neu verbinden: erst /api/me, dann neue EventSource
  app.runTimers();
  await settle();
  const second = app.latestSource();
  expect(second).not.toBe(first);

  // Erster Abruf nach dem open scheitert im Netz, der nächste mit HTTP 500
  app.server.failures = ["network", 500];
  const before = app.server.historyCalls;
  second.emit("open");
  await settle();
  expect(app.server.historyCalls).toBe(before + 1);
  expect(app.shown()).toEqual(["u1"]);
  expect(app.connection()).not.toBe("");
  expect(app.shortTimers()).toBe(1);

  app.runTimers();
  await settle();
  expect(app.server.historyCalls).toBe(before + 2);
  expect(app.shown()).toEqual(["u1"]);
  expect(app.connection()).not.toBe("");

  // Dritter Versuch gelingt
  app.runTimers();
  await settle();
  expect(app.server.historyCalls).toBe(before + 3);
  expect(app.shown()).toEqual(["u1", "a1"]);
  expect(app.connection()).toBe("");
  expect(app.shortTimers()).toBe(0);

  // Kein weiterer Abruf mehr geplant, nichts doppelt
  app.runTimers();
  await settle();
  expect(app.server.historyCalls).toBe(before + 3);
  expect(app.shown()).toEqual(["u1", "a1"]);
});

test("Wiederverbindung bei offener Freigabe: status während des Abgleichs, Antwort trägt die Kennung", async () => {
  const app = setup();
  const awaiting = { running: true, awaiting: true, approvalId: "freigabe-a" };
  app.server.messages = [msg("u1", "user", 0), { ...msg("q1", "assistant", 1), approvalId: "freigabe-a" }];
  app.server.status = awaiting;
  await settle();
  app.latestSource().emit("open");
  await settle();

  // Verbindung reißt ab, neu verbinden
  const first = app.latestSource();
  first.emit("error", {});
  app.runTimers();
  await settle();
  const second = app.latestSource();
  expect(second).not.toBe(first);

  // Der Verlaufabruf nach dem open läuft noch, da kommt der erste status der
  // neuen Verbindung; der Server meldet darin die offene Freigabe mit
  let releaseHistory!: () => void;
  app.server.holdHistory = new Promise<void>(r => (releaseHistory = r));
  second.emit("open");
  await settle();
  second.emit("status", { data: JSON.stringify(awaiting) });
  releaseHistory();
  await settle();

  // Die Frage bleibt beantwortbar, die Antwort geht mit ihrer Kennung raus
  expect(app.shown()).toEqual(["u1", "q1"]);
  app.sendText("ja");
  expect(app.sendEnabled()).toBe(false); // während des Sendens gesperrt
  await settle();
  expect(app.server.posts).toEqual([{ text: "ja", approvalId: "freigabe-a" }]);
});

test("Fragenwechsel A zu B während des Abgleichs: ein Ja zu A gibt B nicht frei", async () => {
  const app = setup();
  const qa = { ...msg("qa", "assistant", 1), approvalId: "freigabe-a" };
  app.server.messages = [msg("u1", "user", 0), qa];
  app.server.status = { running: true, awaiting: true, approvalId: "freigabe-a" };
  await settle();
  app.latestSource().emit("open");
  await settle();
  expect(app.shown()).toEqual(["u1", "qa"]);

  // Verbindung reißt ab; währenddessen läuft A ab und der Server stellt B
  const first = app.latestSource();
  first.emit("error", {});
  app.runTimers();
  await settle();
  const second = app.latestSource();
  const qb = { ...msg("qb", "assistant", 2), approvalId: "freigabe-b" };
  app.server.messages = [msg("u1", "user", 0), qa, qb];
  const statusB = { running: true, awaiting: true, approvalId: "freigabe-b" };
  app.server.status = statusB;

  // Verlaufabruf hängt noch, der erste status der neuen Verbindung meldet B
  let releaseHistory!: () => void;
  app.server.holdHistory = new Promise<void>(r => (releaseHistory = r));
  second.emit("open");
  await settle();
  second.emit("status", { data: JSON.stringify(statusB) });
  await settle();

  // Sichtbar ist nur A: Senden bleibt gesperrt, ein Ja geht nicht raus
  expect(app.shown()).toEqual(["u1", "qa"]);
  expect(app.sendEnabled()).toBe(false);
  app.sendText("ja");
  await settle();
  expect(app.server.posts).toEqual([]);

  // Erst mit der angezeigten Frage B lässt sich B beantworten
  releaseHistory();
  await settle();
  expect(app.shown()).toEqual(["u1", "qa", "qb"]);
  app.sendText("ja");
  await settle();
  expect(app.server.posts).toEqual([{ text: "ja", approvalId: "freigabe-b" }]);
});

// Issue #116: die Kennung ist die Register-ID der Rückfrage; die Frage steht mit choice (oder nur choiceId) im Verlauf
const REGISTER_ID = "Ab3dEf7hIj";
const registerChoice = (state = "open") => ({
  id: REGISTER_ID,
  state,
  options: state === "open" ? [{ key: "allow", label: "Erlauben" }, { key: "deny", label: "Ablehnen" }] : [],
});

test("Freigabe über das Register: Frage mit choice, „ja“ geht mit der Register-ID raus", async () => {
  const app = setup();
  app.server.messages = [msg("u1", "user", 0), { ...msg("q1", "assistant", 1), choice: registerChoice() }];
  app.server.status = { running: true, awaiting: true, approvalId: REGISTER_ID };
  await settle();
  app.latestSource().emit("open");
  await settle();
  expect(app.sendEnabled()).toBe(false); // leeres Feld
  app.sendText("ja");
  await settle();
  expect(app.server.posts).toEqual([{ text: "ja", approvalId: REGISTER_ID }]);
});

test("Frage nur mit choiceId (Register gerade nicht lesbar): trotzdem beantwortbar", async () => {
  const app = setup();
  app.server.messages = [msg("u1", "user", 0), { ...msg("q1", "assistant", 1), choiceId: REGISTER_ID }];
  app.server.status = { running: true, awaiting: true, approvalId: REGISTER_ID };
  await settle();
  app.latestSource().emit("open");
  await settle();
  app.sendText("nein");
  await settle();
  expect(app.server.posts).toEqual([{ text: "nein", approvalId: REGISTER_ID }]);
});

test("Telegram-Gespräch: status kommt vor der Frage, erst die angezeigte Frage ist beantwortbar", async () => {
  const app = setup();
  app.server.messages = [msg("u1", "user", 0)];
  app.server.status = { running: true };
  await settle();
  app.latestSource().emit("open");
  await settle();
  // Status wartet schon, die Nachricht aus dem Nachrichtenspeicher noch nicht da
  app.latestSource().emit("status", { data: JSON.stringify({ running: true, awaiting: true, approvalId: REGISTER_ID }) });
  await settle();
  app.sendText("ja");
  await settle();
  expect(app.server.posts).toEqual([]);
  app.latestSource().emit("message", { data: JSON.stringify({ ...msg("q1", "assistant", 1), choice: registerChoice() }) });
  await settle();
  app.sendText("ja");
  await settle();
  expect(app.server.posts).toEqual([{ text: "ja", approvalId: REGISTER_ID }]);
});

test("Klick in Telegram erledigt die Frage: status ohne awaiting, nächste Nachricht ohne Kennung", async () => {
  const app = setup();
  app.server.messages = [msg("u1", "user", 0), { ...msg("q1", "assistant", 1), choice: registerChoice() }];
  app.server.status = { running: true, awaiting: true, approvalId: REGISTER_ID };
  await settle();
  app.latestSource().emit("open");
  await settle();
  app.latestSource().emit("choice", {
    data: JSON.stringify({ choice: { ...registerChoice("done"), result: { key: "allow", label: "Erlauben", via: "telegram", at: new Date().toISOString() } } }),
  });
  app.latestSource().emit("status", { data: JSON.stringify({ running: true, awaiting: false }) });
  await settle();
  app.sendText("ja");
  await settle();
  // Turn läuft ohne Frage: nichts geht raus, auch nicht als Antwort
  expect(app.server.posts).toEqual([]);
  app.latestSource().emit("status", { data: JSON.stringify({ running: false }) });
  app.sendText("Danke");
  await settle();
  expect(app.server.posts).toEqual([{ text: "Danke" }]);
});

test("status ohne awaiting beendet die Freigabe: normale Nachricht ohne Kennung", async () => {
  const app = setup();
  app.server.status = { running: true, awaiting: true, approvalId: "freigabe-a" };
  await settle();
  app.latestSource().emit("open");
  await settle();
  app.latestSource().emit("status", { data: JSON.stringify({ running: false }) });
  app.sendText("Neue Frage");
  await settle();
  expect(app.server.posts).toEqual([{ text: "Neue Frage" }]);
});

test("Offene Freigabe-Frage: Senden und Stopp sichtbar, Stopp bricht den wartenden Turn ab", async () => {
  const app = setup();
  const { elements } = app;
  app.server.messages = [msg("u1", "user", 0)];
  app.server.status = { running: true };
  await settle();
  app.latestSource().emit("open");
  await settle();

  // Turn läuft ohne Frage: Stopp statt Senden
  expect(elements["stop"].hidden).toBe(false);
  expect(elements["send"].hidden).toBe(true);

  // Freigabe-Frage kommt und steht im Verlauf: beide Knöpfe sichtbar
  const q1 = { ...msg("q1", "assistant", 1), approvalId: "freigabe-a" };
  app.latestSource().emit("message", { data: JSON.stringify(q1) });
  app.latestSource().emit("status", { data: JSON.stringify({ running: true, awaiting: true, approvalId: "freigabe-a" }) });
  await settle();
  expect(elements["send"].hidden).toBe(false);
  expect(elements["stop"].hidden).toBe(false);
  expect(elements["stop"].disabled).toBe(false);

  // Stopp bricht den wartenden Turn ab, statt eine Antwort zu schicken
  elements["stop"].dispatch("click");
  await settle();
  expect(app.server.stops).toEqual(["c1"]);
  expect(app.server.posts).toEqual([]);
  expect(elements["stop"].disabled).toBe(true);

  // Server meldet das Ende: Stopp verschwindet, Senden bleibt
  app.latestSource().emit("message", { data: JSON.stringify({ ...msg("e1", "error", 2), text: "Abgebrochen." }) });
  app.latestSource().emit("status", { data: JSON.stringify({ running: false }) });
  await settle();
  expect(elements["stop"].hidden).toBe(true);
  expect(elements["send"].hidden).toBe(false);
  expect(elements["activity"].hidden).toBe(true);
  expect(app.shown()).toEqual(["u1", "q1", "e1"]);
});

test("Gesprächswechsel: anderer Eintrag zeigt seinen Verlauf und Agenten, alter Strom zu, Schublade zu", async () => {
  const app = setup(server => {
    server.conversations = [
      { id: "c1", agent: "general", title: "Betrieb" },
      { id: "c2", agent: "research", title: "VPS-Kosten" },
    ];
    server.messages = [msg("u1", "user", 0)];
    server.others.c2 = [msg("r1", "user", 0), msg("r2", "assistant", 1)];
  });
  const { elements } = app;
  await settle();
  const first = app.latestSource();
  first.emit("open");
  await settle();
  expect(first.url).toBe("/api/conversations/c1/events");
  expect(elements["chat-title"].textContent).toBe("Betrieb");
  expect(elements["agent-name"].textContent).toBe("General");
  expect(app.shown()).toEqual(["u1"]);

  // Handy: Schublade öffnen
  elements["menu"].dispatch("click");
  expect(elements["sidebar"].getAttribute("data-open")).toBe("true");
  expect(elements["scrim"].hidden).toBe(false);

  // Zweiten Listeneintrag wählen
  const entries = () => elements["conversation-list"].children.map(li => li.children[0]);
  expect(entries().map(b => b.children[0].textContent)).toEqual(["Betrieb", "VPS-Kosten"]);
  entries()[1].dispatch("click");
  await settle();

  // Schublade zu
  expect(elements["sidebar"].getAttribute("data-open")).toBe("false");
  expect(elements["scrim"].hidden).toBe(true);
  expect(elements["menu"].getAttribute("aria-expanded")).toBe("false");

  // Alter Ereignisstrom geschlossen, neuer für c2
  expect(first.closed).toBe(true);
  const second = app.latestSource();
  expect(second).not.toBe(first);
  expect(second.url).toBe("/api/conversations/c2/events");

  // Verlauf und Agent von c2
  expect(app.shown()).toEqual(["r1", "r2"]);
  expect(elements["chat-title"].textContent).toBe("VPS-Kosten");
  expect(elements["agent-name"].textContent).toBe("Research");
  expect(elements["agent-name"].getAttribute("data-agent")).toBe("research");
  const answer = elements["messages"].children[1];
  expect(answer.children.find(c => c.className === "msg-head")?.attributes["data-agent"]).toBe("research");
  expect(entries().map(b => b.getAttribute("aria-current"))).toEqual([undefined, "true"]);

  // Ein spätes Ereignis des alten Stroms landet nicht im neuen Gespräch
  first.emit("message", { data: JSON.stringify(msg("u9", "user", 5)) });
  await settle();
  expect(app.shown()).toEqual(["r1", "r2"]);
  expect(elements["send"].hidden).toBe(false);
  expect(elements["stop"].hidden).toBe(true);
});

test("Schalter Hell/Dunkel ist nach dem Start verbunden und stört den Chat nicht", async () => {
  const app = setup();
  app.server.messages = [msg("u1", "user", 0)];
  await settle();
  expect(app.elements["theme-system"].attributes["aria-checked"]).toBe("true");
  app.elements["theme-dark"].dispatch("click");
  expect(app.root.dataset.theme).toBe("dark");
  expect(app.stored["tybo-theme"]).toBe("dark");
  expect(app.elements["theme-dark"].attributes["aria-checked"]).toBe("true");
  expect(app.elements["theme-system"].attributes["aria-checked"]).toBe("false");
  expect(app.shown()).toEqual(["u1"]);
});

describe("/stop während einer Antwort (Issue #74)", () => {
  test("Nachrichten bleiben gesperrt, /stop geht raus: Senden-Knopf erscheint dafür", async () => {
    const app = setup();
    const { elements } = app;
    app.server.status = { running: true };
    await settle();
    app.latestSource().emit("open");
    await settle();
    expect(elements["send"].hidden).toBe(true);

    app.sendText("Noch eine Frage");
    await settle();
    expect(app.server.posts).toEqual([]);

    elements["input"].value = " /STOP ";
    elements["input"].dispatch("input");
    expect(elements["send"].hidden).toBe(false);
    expect(app.sendEnabled()).toBe(true);
    app.sendText("/stop");
    await settle();
    expect(app.server.posts).toEqual([{ text: "/stop" }]);
    // /stopp ist kein /stop: gesperrt
    elements["input"].value = "/stopp";
    elements["input"].dispatch("input");
    expect(elements["send"].hidden).toBe(true);
  });

  test("Befehl meldet running false: keine Arbeitsanzeige danach", async () => {
    const app = setup();
    const { elements } = app;
    await settle();
    app.latestSource().emit("open");
    await settle();
    app.server.postExtra = { running: false, command: "stop" };
    app.sendText("/stop");
    await settle();
    expect(app.server.posts).toEqual([{ text: "/stop" }]);
    expect(elements["activity"].hidden).toBe(true);
    expect(elements["stop"].hidden).toBe(true);
  });

  test("ohne running in der Antwort gilt der Turn wie bisher als laufend", async () => {
    const app = setup();
    const { elements } = app;
    await settle();
    app.latestSource().emit("open");
    await settle();
    app.sendText("Frage");
    await settle();
    expect(elements["activity"].hidden).toBe(false);
    expect(elements["stop"].hidden).toBe(false);
  });
});

describe("Steuerbefehle während Antworten und Rückfragen (Issue #76)", () => {
  const URGENT = ["/goal pause", "/goal stop", "/goal cancel", "/goal done", "/goal abbrechen", "/GOAL Pause", "/abbruch", "/stop"];

  test("/goal pause und alle Stopp-Aliase gehen während einer Antwort sofort raus", async () => {
    const app = setup();
    const { elements } = app;
    app.server.status = { running: true };
    await settle();
    app.latestSource().emit("open");
    await settle();
    for (const text of URGENT) {
      elements["input"].value = text;
      elements["input"].dispatch("input");
      expect(elements["send"].hidden).toBe(false);
      expect(app.sendEnabled()).toBe(true);
      app.sendText(text);
      await settle();
    }
    expect(app.server.posts).toEqual(URGENT.map(text => ({ text })));
    // Ein neues Ziel oder /goal weiter bleiben gesperrt, bis die Antwort fertig ist
    for (const text of ["/goal Neues Ziel", "/goal weiter", "/goal pausieren"]) {
      elements["input"].value = text;
      elements["input"].dispatch("input");
      expect(elements["send"].hidden).toBe(true);
      app.sendText(text);
      await settle();
    }
    expect(app.server.posts).toHaveLength(URGENT.length);
  });

  test("während einer Rückfrage ([INVOKE:]): Stopp-Knopf und /goal pause gehen raus, die Hauptantwort bleibt stehen", async () => {
    const app = setup();
    const { elements } = app;
    app.server.messages = [msg("u1", "user", 0)];
    app.server.status = { running: true };
    await settle();
    app.latestSource().emit("open");
    await settle();
    // Hauptantwort gespeichert, danach die Rückfrage an Critic; der Turn läuft weiter
    app.latestSource().emit("message", { data: JSON.stringify({ ...msg("a1", "assistant", 1), agent: "general" }) });
    app.latestSource().emit("notice", { data: JSON.stringify({ text: "Critic denkt nach …" }) });
    await settle();
    expect(elements["stop"].hidden).toBe(false);

    app.sendText("/goal pause");
    await settle();
    expect(app.server.posts).toEqual([{ text: "/goal pause" }]);

    elements["stop"].dispatch("click");
    await settle();
    expect(app.server.stops).toEqual(["c1"]);

    app.latestSource().emit("error", { data: JSON.stringify({ ...msg("e1", "error", 2), text: "Abgebrochen." }) });
    app.latestSource().emit("status", { data: JSON.stringify({ running: false }) });
    await settle();
    expect(elements["stop"].hidden).toBe(true);
    expect(app.shown()).toContain("a1");
  });
});
