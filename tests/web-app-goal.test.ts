// Status-Karte des Ziels in der Chat-Seite (app.js, Issue #76) ohne Browser:
// Attrappen für DOM, fetch, EventSource, Timer und localStorage wie in
// web-app-live.test.ts. Geprüft: Karte beim Öffnen, Knöpfe mit Doppelklick-
// Schutz, Live-Änderung aus Telegram, veraltete Knöpfe, Neuverbinden und
// Gesprächswechsel.
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

type Entry = { id: string; title?: string; agent: string; lastActivity?: string | null };
type Card = Record<string, any> | null;

const now = new Date().toISOString();
const TOPICS: Entry[] = [
  { id: "topic-8", title: "Recherche", agent: "research", lastActivity: now },
  { id: "topic-443", title: "Finanzen", agent: "finance", lastActivity: now },
];

function card(over: Record<string, any> = {}): Card {
  return {
    goalId: 1790000000000,
    goal: "Marktbericht schreiben",
    agent: "research",
    status: "active",
    running: true,
    turnsUsed: 2,
    maxTurns: 10,
    note: "Nächster Schritt: Quellen prüfen",
    actions: ["pause", "stop"],
    ...over,
  };
}

interface Deferred {
  body: any;
  resolve(status: number, data: unknown): void;
}

function setup(options: { goals?: Record<string, Card>; stored?: string; messages?: Record<string, any[]> } = {}) {
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
    goals: options.goals ?? { "topic-8": card(), "topic-443": null },
    calls: [] as string[],
    posts: [] as Deferred[],
    /** POST /choices/<id> (Rückfrage im Verlauf, Issue #118), wartet auf den Test */
    choicePosts: [] as Deferred[],
    /** GET /goal wartet, bis der Test sie beantwortet */
    holdGet: false,
    heldGets: [] as { id: string; resolve(): void }[],
  };
  const fetch = async (path: string, init?: { method?: string; body?: string }) => {
    // Anwesenheit (Issue #226) läuft nebenher und zählt hier nicht mit
    if (path === "/api/presence") return { ok: true, status: 204, json: async () => ({}) } as any;
    const method = init?.method ?? "GET";
    server.calls.push(`${method} ${path}`);
    if (path === "/api/conversations" && method === "GET") {
      return Response.json({ conversations: [{ id: "c1", agent: "general", title: "Betrieb" }], telegram: { dm: null, topics: TOPICS } });
    }
    if (path === "/api/me") return Response.json({ authenticated: true });
    const goal = path.match(/^\/api\/conversations\/([^/?]+)\/goal$/);
    if (goal && method === "GET") {
      const id = goal[1];
      if (server.holdGet) {
        await new Promise<void>(resolve => server.heldGets.push({ id, resolve }));
      }
      return Response.json({ card: server.goals[id] ?? null });
    }
    if (goal && method === "POST") {
      return new Promise<Response>(resolve => {
        server.posts.push({ body: JSON.parse(init!.body!), resolve: (status, data) => resolve(Response.json(data, { status })) });
      });
    }
    const pick = path.match(/^\/api\/conversations\/([^/?]+)\/choices\/([^/?]+)$/);
    if (pick && method === "POST") {
      return new Promise<Response>(resolve => {
        server.choicePosts.push({ body: { path, ...JSON.parse(init!.body!) }, resolve: (status, data) => resolve(Response.json(data, { status })) });
      });
    }
    const m = path.match(/^\/api\/conversations\/([^/?]+)\/messages$/);
    if (m) return Response.json({ messages: structuredClone(options.messages?.[m[1]] ?? []), hasMore: false, running: false });
    return Response.json({ error: "unbekannt" }, { status: 404 });
  };

  elements["chat-log"] = node();
  new Function("document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout", source)(
    document, window, fetch, FakeEventSource, setTimeout, clearTimeout
  );

  const box = () => elements["goal-card"];
  const part = (cls: string) => box().children.find(c => c.className === cls);
  const find = (n: Node, cls: string): Node | undefined => n.children.find(c => c.className === cls);
  const buttons = () => (part("goal-actions")?.children ?? []);
  const button = (action: string) => buttons().find(b => b.attributes["data-action"] === action)!;
  const conversationSource = () => FakeEventSource.all.filter(s => s.url !== ACTIVITY).at(-1)!;
  const emitGoal = (c: Card) => conversationSource().emit("goal", { data: JSON.stringify({ card: c }) });
  const entry = (id: string) => {
    for (const listId of ["dm-list", "topic-list", "older-list", "conversation-list"]) {
      const li = (elements[listId]?.children ?? []).find(l => l.children[0]?.attributes["data-id"] === id);
      if (li) return li.children[0];
    }
    throw new Error(`Eintrag ${id} fehlt`);
  };
  const goalGets = () => server.calls.filter(c => c.startsWith("GET ") && c.endsWith("/goal"));
  const all = (n: Node | undefined, out: Node[] = []): Node[] => {
    for (const c of n?.children ?? []) {
      out.push(c);
      all(c, out);
    }
    return out;
  };
  const question = (id: string) => all(elements["messages"]).find(x => x.attributes["data-choice"] === id);
  const questionButtons = (id: string) => all(question(id)).filter(x => String(x.className).includes("choice-button") && x.attributes["data-key"]);
  const questionStatus = (id: string) => all(question(id)).find(x => x.className === "choice-status")?.textContent;
  const emitChoice = (data: unknown) => conversationSource().emit("choice", { data: JSON.stringify(data) });
  return { server, elements, box, part, find, buttons, button, emitGoal, conversationSource, entry, goalGets, question, questionButtons, questionStatus, emitChoice };
}

async function settle() {
  for (let i = 0; i < 20; i++) await Bun.sleep(0);
}

describe("Status-Karte beim Öffnen", () => {
  test("Topic mit Ziel: Ziel, Zustand, Runde x von n mit Agent, letzter Stand, Knöpfe Pause und Stopp", async () => {
    const app = setup();
    await settle();
    expect(app.goalGets()).toContain("GET /api/conversations/topic-8/goal");
    expect(app.box().hidden).toBe(false);
    const head = app.part("goal-head")!;
    expect(head.children.map(c => c.textContent)).toEqual(["Ziel", "arbeitet"]);
    expect(head.children[1].attributes["data-state"]).toBe("running");
    expect(app.part("goal-text")!.textContent).toBe("Marktbericht schreiben");
    expect(app.part("goal-meta")!.textContent).toBe("Runde 2 von 10 · Research");
    expect(app.part("goal-note")!.textContent).toBe("Letzter Stand: Nächster Schritt: Quellen prüfen");
    expect(app.buttons().map(b => [b.textContent, b.type])).toEqual([["Pause", "button"], ["Stopp", "button"]]);
  });

  test("Topic ohne Ziel und ältere Web-Gespräche: keine Karte; Web-Gespräche fragen gar nicht", async () => {
    const app = setup({ stored: "topic-443" });
    await settle();
    expect(app.box().hidden).toBe(true);
    expect(app.box().children).toEqual([]);
    const web = setup({ stored: "c1" });
    await settle();
    expect(web.goalGets()).toEqual([]);
    expect(web.box().hidden).toBe(true);
  });

  test("feindlicher Zieltext bleibt Text; unvollständige Karte wird nicht gezeigt, fremde Knöpfe fallen weg", async () => {
    const app = setup({ goals: { "topic-8": card({ goal: "<img src=x onerror=alert(1)>", actions: ["pause", "loeschen"] }) } });
    await settle();
    expect(app.part("goal-text")!.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(app.buttons().map(b => b.attributes["data-action"])).toEqual(["pause"]);
    app.emitGoal({ goal: "ohne Kennung" });
    expect(app.box().hidden).toBe(true);
  });
});

describe("Knöpfe", () => {
  test("Pause: POST mit Aktion und goalId, während der Anfrage gesperrt, zweiter Klick zählt nicht; danach Weiter und Stopp", async () => {
    const app = setup();
    await settle();
    app.button("pause").dispatch("click");
    await settle();
    expect(app.server.posts.map(p => p.body)).toEqual([{ action: "pause", goalId: 1790000000000 }]);
    expect(app.buttons().every(b => b.disabled)).toBe(true);
    app.button("stop").dispatch("click");
    await settle();
    expect(app.server.posts).toHaveLength(1);
    app.server.posts[0].resolve(200, { card: card({ status: "paused", running: false, actions: ["resume", "stop"] }) });
    await settle();
    expect(app.part("goal-head")!.children[1].textContent).toBe("pausiert");
    expect(app.buttons().map(b => [b.textContent, b.disabled])).toEqual([["Weiter", false], ["Stopp", false]]);
  });

  test("am Budget: „Weiter (+5)“; Stopp entfernt die Karte", async () => {
    const app = setup({ goals: { "topic-8": card({ status: "paused", running: false, turnsUsed: 10, actions: ["more", "stop"] }) } });
    await settle();
    expect(app.buttons().map(b => b.textContent)).toEqual(["Weiter (+5)", "Stopp"]);
    app.button("more").dispatch("click");
    await settle();
    expect(app.server.posts[0].body.action).toBe("more");
    app.server.posts[0].resolve(200, { card: card({ maxTurns: 15, turnsUsed: 10 }) });
    await settle();
    expect(app.part("goal-meta")!.textContent).toBe("Runde 10 von 15 · Research");
    app.button("stop").dispatch("click");
    await settle();
    app.server.posts[1].resolve(200, { card: null });
    await settle();
    expect(app.box().hidden).toBe(true);
  });

  test("veraltet (409): Meldung unter den Knöpfen, die Karte zeigt den aktuellen Stand", async () => {
    const app = setup({ goals: { "topic-8": card({ status: "paused", running: false, turnsUsed: 10, actions: ["more", "stop"] }) } });
    await settle();
    app.button("more").dispatch("click");
    await settle();
    app.server.posts[0].resolve(409, {
      error: "Der Knopf passt nicht mehr zum Stand des Ziels. Die Karte zeigt jetzt den aktuellen Stand.",
      stale: true,
      card: card({ maxTurns: 15 }),
    });
    await settle();
    expect(app.buttons().map(b => b.textContent)).toEqual(["Pause", "Stopp"]);
    const error = app.part("goal-error")!;
    expect(error.attributes.role).toBe("alert");
    expect(error.textContent).toBe("Der Knopf passt nicht mehr zum Stand des Ziels. Die Karte zeigt jetzt den aktuellen Stand.");
  });

  test("Server nicht erreichbar: Meldung, Knöpfe wieder frei", async () => {
    const app = setup();
    await settle();
    app.button("pause").dispatch("click");
    await settle();
    app.server.posts[0].resolve(500, { error: "Die Aktion ist fehlgeschlagen." });
    await settle();
    expect(app.part("goal-error")!.textContent).toBe("Die Aktion ist fehlgeschlagen.");
    expect(app.buttons().every(b => !b.disabled)).toBe(true);
  });
});

describe("Live und Wiederherstellung", () => {
  test("Druck in Telegram: goal-Ereignis aktualisiert die Karte; null entfernt sie", async () => {
    const app = setup();
    await settle();
    app.emitGoal(card({ status: "active", running: true, maxTurns: 15, turnsUsed: 10 }));
    expect(app.part("goal-meta")!.textContent).toBe("Runde 10 von 15 · Research");
    app.emitGoal(null);
    expect(app.box().hidden).toBe(true);
    // Neues Ziel im selben Gespräch erscheint ohne Neuladen
    app.emitGoal(card({ goal: "Neues Ziel", running: false, turnsUsed: 0 }));
    expect(app.box().hidden).toBe(false);
    expect(app.part("goal-head")!.children[1].textContent).toBe("aktiv");
  });

  test("ein goal-Ereignis während eines Knopfdrucks gewinnt gegen die ältere Antwort", async () => {
    const app = setup();
    await settle();
    app.button("pause").dispatch("click");
    await settle();
    app.emitGoal(null);
    app.server.posts[0].resolve(200, { card: card({ status: "paused" }) });
    await settle();
    expect(app.box().hidden).toBe(true);
  });

  test("Neuverbinden (open) lädt die Karte neu", async () => {
    const app = setup();
    await settle();
    const before = app.goalGets().length;
    app.server.goals["topic-8"] = card({ status: "paused", running: false, actions: ["resume", "stop"] });
    app.conversationSource().emit("open");
    await settle();
    expect(app.goalGets().length).toBe(before + 1);
    expect(app.part("goal-head")!.children[1].textContent).toBe("pausiert");
  });

  test("Gesprächswechsel: alte Karte weg, die neue lädt; eine späte Antwort des alten Gesprächs wird verworfen", async () => {
    const app = setup({ goals: { "topic-8": card(), "topic-443": card({ goal: "Budget planen", agent: "finance" }) } });
    await settle();
    expect(app.part("goal-text")!.textContent).toBe("Marktbericht schreiben");

    app.server.holdGet = true;
    app.entry("topic-443").dispatch("click");
    await settle();
    // Sofort weg, noch bevor die Karte des neuen Gesprächs da ist
    expect(app.box().hidden).toBe(true);
    // Zurück zu topic-8, dann antworten beide gehaltenen Abfragen (443 zuerst)
    app.entry("topic-8").dispatch("click");
    await settle();
    for (const held of app.server.heldGets.splice(0)) held.resolve();
    await settle();
    expect(app.part("goal-text")!.textContent).toBe("Marktbericht schreiben");
  });
});

describe("Budget-Frage im Verlauf neben der Karte (Issue #118)", () => {
  const AT = "2026-09-26T09:15:00.000Z";
  const budgetCard = () => card({ status: "paused", running: false, turnsUsed: 10, actions: ["more", "stop"] });
  const budgetQuestion = {
    id: "m-budget",
    role: "assistant",
    kind: "notice",
    source: "ziel",
    text: '⏸️ Turn-Budget erreicht (10/10) fuer das Ziel:\n"Marktbericht schreiben"\n\nWeitermachen?',
    html: "<p>⏸️ Turn-Budget erreicht (10/10)</p>",
    createdAt: now,
    choice: { id: "Goal12345", state: "open", options: [{ key: "more", label: "Weiter (+5)" }, { key: "stop", label: "Beenden" }] },
  };
  const decided = (via: string, key = "more", label = "Weiter (+5)") => ({
    conversationId: "topic-8",
    choice: { id: "Goal12345", options: [], state: "done", result: { key, label, via, at: AT } },
  });

  test("Karte zeigt Weiter (+5) und Stopp, die Frage im Verlauf Weiter (+5) und Beenden", async () => {
    const app = setup({ goals: { "topic-8": budgetCard() }, messages: { "topic-8": [budgetQuestion] } });
    await settle();
    expect(app.buttons().map(b => b.textContent)).toEqual(["Weiter (+5)", "Stopp"]);
    expect(app.questionButtons("Goal12345").map(b => [b.textContent, b.disabled])).toEqual([["Weiter (+5)", false], ["Beenden", false]]);
  });

  test("Weiter in der Karte: die Frage im Verlauf wird ohne Neuladen „Erledigt: Weiter (+5) · im Browser“", async () => {
    const app = setup({ goals: { "topic-8": budgetCard() }, messages: { "topic-8": [budgetQuestion] } });
    await settle();
    app.button("more").dispatch("click");
    await settle();
    expect(app.server.posts.map(p => p.body)).toEqual([{ action: "more", goalId: 1790000000000 }]);
    app.server.posts[0].resolve(200, { card: card({ maxTurns: 15, turnsUsed: 10 }) });
    // Der Server meldet die entschiedene Frage per SSE choice
    app.emitChoice(decided("web"));
    await settle();
    expect(app.part("goal-meta")!.textContent).toBe("Runde 10 von 15 · Research");
    expect(app.questionButtons("Goal12345")).toEqual([]);
    expect(app.questionStatus("Goal12345")).toStartWith("Erledigt: Weiter (+5) · im Browser");
  });

  test("Weiter im Verlauf: POST an die Rückfrage, die Karte zieht über das goal-Ereignis nach", async () => {
    const app = setup({ goals: { "topic-8": budgetCard() }, messages: { "topic-8": [budgetQuestion] } });
    await settle();
    app.questionButtons("Goal12345")[0].dispatch("click");
    await settle();
    expect(app.server.choicePosts.map(p => p.body)).toEqual([{ path: "/api/conversations/topic-8/choices/Goal12345", option: "more" }]);
    expect(app.server.posts).toEqual([]);
    app.server.choicePosts[0].resolve(200, { choice: decided("web").choice });
    app.emitGoal(card({ maxTurns: 15, turnsUsed: 10 }));
    await settle();
    expect(app.questionStatus("Goal12345")).toStartWith("Erledigt: Weiter (+5) · im Browser");
    expect(app.buttons().map(b => b.textContent)).toEqual(["Pause", "Stopp"]);
  });

  test("Beenden in Telegram: Karte verschwindet, Frage „Erledigt: Beenden · in Telegram“", async () => {
    const app = setup({ goals: { "topic-8": budgetCard() }, messages: { "topic-8": [budgetQuestion] } });
    await settle();
    app.emitGoal(null);
    app.emitChoice(decided("telegram", "stop", "Beenden"));
    await settle();
    expect(app.box().hidden).toBe(true);
    expect(app.questionStatus("Goal12345")).toStartWith("Erledigt: Beenden · in Telegram");
  });

  test("Ziel ersetzt: Frage „Abgelaufen“, die Karte zeigt das neue Ziel", async () => {
    const app = setup({ goals: { "topic-8": budgetCard() }, messages: { "topic-8": [budgetQuestion] } });
    await settle();
    app.emitGoal(card({ goalId: 1790000000999, goal: "Neues Ziel", turnsUsed: 0 }));
    app.emitChoice({ conversationId: "topic-8", choice: { id: "Goal12345", options: [], state: "expired" } });
    await settle();
    expect(app.questionStatus("Goal12345")).toBe("Abgelaufen");
    expect(app.part("goal-text")!.textContent).toBe("Neues Ziel");
  });
});
