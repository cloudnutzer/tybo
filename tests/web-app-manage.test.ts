// Web-Gespräche verwalten in der Oberfläche (Issue #21): Agent beim Anlegen
// wählen, Titel in der Kopfzeile umbenennen, löschen über ein Menü mit
// Rückfrage. Ohne Browser: Attrappen für DOM, fetch, EventSource, Timer und
// localStorage wie in web-app-telegram.test.ts.
import { describe, expect, test } from "bun:test";
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
    scrollHeight: 0,
    clientHeight: 0,
    focused: 0,
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
    focus() { this.focused++; },
    select() {},
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

type Conv = { id: string; title: string; agent: string; updatedAt?: string };

interface Options {
  conversations?: Conv[];
  /** Antwort auf GET /api/agents; null: Fehler 500 */
  agents?: { name: string; label: string }[] | null;
  telegram?: { dm: any; topics: any[] };
  stored?: string;
  /** Status für DELETE, Standard 200 */
  deleteStatus?: number;
  /** Antwort auf POST /api/conversations (Issue #29: Topic oder Fehler); Standard: Web-Gespräch neu<n> */
  create?: { status: number; body: any };
  /** Antwort auf GET /api/telegram/rights; Standard: alle Rechte */
  rights?: { status: number; body: any };
}

const AGENTS = [
  { name: "general", label: "General" },
  { name: "research", label: "Research" },
  { name: "cto", label: "CTO" },
];

function setup(options: Options = {}) {
  FakeEventSource.all = [];
  const elements: Record<string, Node> = {};
  const document = {
    getElementById(id: string) { return (elements[id] ??= node()); },
    createElement() { return node(); },
    createDocumentFragment() { const f = node(); f.fragment = true; return f; },
  };
  const store: Record<string, string> = {};
  if (options.stored) store["tybo-last-conversation"] = options.stored;
  const windowListeners: Record<string, ((e: any) => void)[]> = {};
  const window: Record<string, any> = {
    TYBO_BRAND,
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ lineHeight: "22", paddingTop: "0", paddingBottom: "0", borderTopWidth: "0", borderBottomWidth: "0" }),
    addEventListener(type: string, fn: (e: any) => void) { (windowListeners[type] ??= []).push(fn); },
    location: { href: "/" },
  };
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const setTimeout = (fn: () => void) => { const id = nextTimer++; timers.set(id, fn); return id; };
  const clearTimeout = (id: number) => { timers.delete(id); };

  const server = {
    conversations: (options.conversations ?? [
      { id: "c1", title: "Betrieb", agent: "general" },
      { id: "c2", title: "Recherche VPS", agent: "research" },
    ]).map(c => ({ ...c })),
    requests: [] as { method: string; path: string; body: any }[],
    created: 0,
    deleteStatus: options.deleteStatus ?? 200,
    patchStatus: 200,
    /** Status für GET /api/conversations, Standard 200 */
    listStatus: 200,
    /** Telegram-Teil der Liste, veränderlich wie auf dem Server */
    telegram: JSON.parse(JSON.stringify(options.telegram ?? { dm: null, topics: [] })) as { dm: any; topics: any[] },
    create: options.create,
    rights: options.rights ?? { status: 200, body: { group: true, manageTopics: true, deleteMessages: true } },
    /** Feste Antworten für Topic-Aktionen (Issue #30), sonst wie der Server */
    topicPatch: null as null | { status: number; body: any },
    topicClose: null as null | { status: number; body: any },
    topicDelete: null as null | { status: number; body: any },
    /** Agenten-Katalog wie auf dem Server; DELETE /api/agents/<name> entfernt (Issue #50) */
    agents: options.agents === null ? null : (options.agents ?? AGENTS).map(a => ({ ...a })),
  };
  const topic = (id: string) => server.telegram.topics.find(t => t.id === id);
  const fetch = async (path: string, init?: { method?: string; body?: string }) => {
    // Anwesenheit (Issue #226) läuft nebenher und zählt hier nicht mit
    if (path === "/api/presence") return { ok: true, status: 204, json: async () => ({}) } as any;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body) : undefined;
    server.requests.push({ method, path, body });
    if (path === "/api/agents") {
      if (server.agents === null) return Response.json({ error: "kaputt" }, { status: 500 });
      return Response.json({ agents: server.agents, defaultAgent: "general" });
    }
    const agentPath = path.match(/^\/api\/agents\/([a-z0-9-]+)$/);
    if (agentPath && method === "DELETE" && server.agents) {
      if (body?.confirm !== agentPath[1]) return Response.json({ error: "Name" }, { status: 400 });
      server.agents = server.agents.filter(a => a.name !== agentPath[1]);
      return Response.json({ deleted: true });
    }
    if (path === "/api/conversations" && method === "GET") {
      if (server.listStatus !== 200) return Response.json({ error: "kaputt" }, { status: server.listStatus });
      return Response.json({ conversations: server.conversations, telegram: server.telegram });
    }
    if (path === "/api/telegram/rights") return Response.json(server.rights.body, { status: server.rights.status });
    if (path === "/api/conversations" && method === "POST") {
      if (server.create) {
        const { conversation } = server.create.body ?? {};
        if (conversation?.id?.startsWith("topic-")) server.telegram.topics = [{ ...conversation }, ...server.telegram.topics];
        return Response.json(server.create.body, { status: server.create.status });
      }
      // Wie der Server seit Issue #29: immer ein Telegram-Topic, ab topic-900
      server.created++;
      const conversation = { id: `topic-${899 + server.created}`, title: "Neues Gespräch", agent: body?.agent ?? "general", lastActivity: null };
      server.telegram.topics = [{ ...conversation }, ...server.telegram.topics];
      return Response.json({ conversation }, { status: 201 });
    }
    const topicPath = path.match(/^\/api\/conversations\/(topic-\d+)(?:\/(close|reopen))?$/);
    if (topicPath && method !== "GET") {
      const [, id, action] = topicPath;
      const t = topic(id);
      if (action) {
        if (server.topicClose) return Response.json(server.topicClose.body, { status: server.topicClose.status });
        if (!t) return Response.json({ error: "Gespräch nicht gefunden" }, { status: 404 });
        if (action === "close") t.closed = true;
        else delete t.closed;
        return Response.json({ conversation: { ...t } });
      }
      if (method === "PATCH") {
        if (server.topicPatch) return Response.json(server.topicPatch.body, { status: server.topicPatch.status });
        if (!t) return Response.json({ error: "Gespräch nicht gefunden" }, { status: 404 });
        t.title = body.title;
        delete t.exactTitle;
        return Response.json({ conversation: { ...t } });
      }
      if (method === "DELETE") {
        if (server.topicDelete) return Response.json(server.topicDelete.body, { status: server.topicDelete.status });
        if (!t) return Response.json({ error: "Gespräch nicht gefunden" }, { status: 404 });
        // Wie der Server: bestätigt wird der gespeicherte Name, falls er vom Titel abweicht
        if (body?.confirm !== (t.exactTitle ?? t.title)) return Response.json({ error: "Zum Löschen den genauen Namen des Topics angeben" }, { status: 400 });
        server.telegram.topics = server.telegram.topics.filter(x => x.id !== id);
        return Response.json({ deleted: true });
      }
    }
    const one = path.match(/^\/api\/conversations\/([^/]+)$/);
    if (one && method === "PATCH") {
      if (server.patchStatus !== 200) return Response.json({ error: "Titel muss 1 bis 80 Zeichen lang sein" }, { status: server.patchStatus });
      const c = server.conversations.find(x => x.id === one[1]);
      if (!c) return Response.json({ error: "Gespräch nicht gefunden" }, { status: 404 });
      c.title = body.title;
      return Response.json({ conversation: { ...c, customTitle: true } });
    }
    if (one && method === "DELETE") {
      if (server.deleteStatus !== 200) return Response.json({ error: "läuft" }, { status: server.deleteStatus });
      server.conversations = server.conversations.filter(x => x.id !== one[1]);
      return Response.json({ deleted: true });
    }
    const messages = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (messages) {
      const telegramEntry = messages[1] === "dm" ? server.telegram.dm : topic(messages[1]);
      if (!server.conversations.some(c => c.id === messages[1]) && !telegramEntry) return Response.json({ error: "Gespräch nicht gefunden" }, { status: 404 });
      if (method === "POST" && telegramEntry?.closed) {
        return Response.json({ error: "Das Topic ist geschlossen. Erst wieder öffnen.", closed: true }, { status: 409 });
      }
      if (telegramEntry && method === "GET") return Response.json({ messages: [], hasMore: false, running: false });
      if (method === "POST") {
        return Response.json({ message: { id: "u1", role: "user", text: body.text, createdAt: "2026-09-23T11:00:00.000Z" } }, { status: 202 });
      }
      return Response.json({ messages: [], running: false });
    }
    return Response.json({ error: "unbekannt" }, { status: 404 });
  };

  elements["chat-log"] = node();
  new Function("document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout", source)(
    document, window, fetch, FakeEventSource, setTimeout, clearTimeout
  );

  const rows = () => elements["conversation-list"].children;
  const row = (id: string) => {
    const li = rows().find(l => l.children[0].attributes["data-id"] === id);
    if (!li) throw new Error(`Eintrag ${id} fehlt`);
    return li;
  };
  const titles = () => rows().map(li => li.children[0].children[0].textContent);
  /** Einträge einer Topic-Liste (topic-list oder older-list) */
  const topicRows = (list: string) => elements[list].children;
  const topicTitles = (list: string) => topicRows(list).map(li => li.children[0].children[0].textContent);
  const topicRow = (id: string) => {
    const li = [...topicRows("topic-list"), ...topicRows("older-list")].find(l => l.children[0].attributes["data-id"] === id);
    if (!li) throw new Error(`Topic ${id} fehlt`);
    return li;
  };
  const options_ = () => elements["agent-options"].children.map(li => li.children[0]);
  const optionLabel = (b: Node) => b.children[0].children[1].textContent;
  const press = (target: Node, key: string) => {
    const event = { key, prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopPropagation() { this.stopped = true; } };
    target.dispatch("keydown", event);
    return event;
  };
  const pressWindow = (key: string) => { for (const fn of windowListeners.keydown ?? []) fn({ key }); };
  /** Knöpfe eines Menüs (Eintrag: drittes Kind der Zeile, Kopfzeile: conversation-actions) */
  const panelButtons = (panel: Node) => panel.children.filter(c => c.attributes["type"] === "button");
  const headerPanel = () => elements["conversation-actions"].children[0];
  const requests = (method: string) => server.requests.filter(r => r.method === method);
  return { fetch, server, elements, store, rows, row, titles, topicRows, topicTitles, topicRow, options: options_, optionLabel, press, pressWindow, panelButtons, headerPanel, requests, timers };
}

async function settle() {
  for (let i = 0; i < 30; i++) await Bun.sleep(0);
}

const helpers = new Function("document", "window", `${source}\nreturn { normalizeTitle, agentLabel };`)(
  { getElementById: () => null }, {}
) as { normalizeTitle(v: unknown): string | null; agentLabel(v: string): string };

describe("Hilfsfunktionen", () => {
  test("normalizeTitle wie der Server: erst Leerraum, dann 1 bis 80 Zeichen", () => {
    expect(helpers.normalizeTitle("  Reise \n nach  Rom ")).toBe("Reise nach Rom");
    expect(helpers.normalizeTitle("x".repeat(80))).toBe("x".repeat(80));
    expect(helpers.normalizeTitle("x".repeat(81))).toBeNull();
    expect(helpers.normalizeTitle("😀".repeat(80))).toBe("😀".repeat(80));
    expect(helpers.normalizeTitle("   ")).toBeNull();
  });

  test("agentLabel schreibt Abkürzungen groß", () => {
    expect(helpers.agentLabel("cto")).toBe("CTO");
    expect(helpers.agentLabel("coo")).toBe("COO");
    expect(helpers.agentLabel("research")).toBe("Research");
  });
});

describe("Agent beim Anlegen wählen", () => {
  test("Neues Gespräch öffnet die Auswahl, General ist markiert, nichts wird angelegt", async () => {
    const app = setup();
    await settle();
    // Anfangs zu (im HTML hidden), die Attrappe kennt das Attribut nicht
    expect(app.elements["agent-options"].children).toHaveLength(0);
    app.elements["new-chat"].dispatch("click");
    expect(app.elements["agent-picker"].hidden).toBe(false);
    expect(app.elements["new-chat"].attributes["aria-expanded"]).toBe("true");
    const opts = app.options();
    expect(opts.map(app.optionLabel)).toEqual(["General", "Research", "CTO"]);
    expect(opts.map(b => b.attributes["aria-selected"])).toEqual(["true", "false", "false"]);
    expect(opts.map(b => b.attributes["tabindex"])).toEqual(["0", "-1", "-1"]);
    expect(opts[0].attributes["role"]).toBe("option");
    expect(opts[1].children[0].attributes["data-agent"]).toBe("research");
    expect(opts[0].focused).toBe(1);
    expect(app.requests("POST")).toHaveLength(0);
  });

  test("Enter übernimmt General", async () => {
    const app = setup();
    await settle();
    app.elements["new-chat"].dispatch("click");
    const event = app.press(app.elements["agent-options"], "Enter");
    expect(event.prevented).toBe(true);
    await settle();
    expect(app.requests("POST")[0]).toMatchObject({ path: "/api/conversations", body: { agent: "general" } });
    expect(app.elements["agent-picker"].hidden).toBe(true);
    expect(app.elements["agent-name"].textContent).toBe("General");
    expect(app.store["tybo-last-conversation"]).toBe("topic-900");
  });

  test("Pfeiltasten wählen Research, Enter legt es mit Research an", async () => {
    const app = setup();
    await settle();
    app.elements["new-chat"].dispatch("click");
    app.press(app.elements["agent-options"], "ArrowDown");
    expect(app.options().map(b => b.attributes["aria-selected"])).toEqual(["false", "true", "false"]);
    app.press(app.elements["agent-options"], "ArrowUp");
    app.press(app.elements["agent-options"], "ArrowUp");
    expect(app.options()[2].attributes["aria-selected"]).toBe("true");
    app.press(app.elements["agent-options"], "Home");
    app.press(app.elements["agent-options"], "ArrowDown");
    app.press(app.elements["agent-options"], "Enter");
    await settle();
    expect(app.requests("POST")[0].body).toEqual({ agent: "research" });
    expect(app.elements["agent-name"].textContent).toBe("Research");
    expect(app.elements["agent-name"].getAttribute("data-agent")).toBe("research");
    expect(app.topicTitles("topic-list")[0]).toBe("Neues Gespräch");
    expect(app.titles()).toEqual(["Betrieb", "Recherche VPS"]);
    expect(FakeEventSource.all.filter(s => !s.closed).map(s => s.url)).toContain("/api/conversations/topic-900/events");
  });

  test("Klick auf einen Agenten legt an; Escape oder zweiter Klick schließt ohne Anlegen", async () => {
    const app = setup();
    await settle();
    app.elements["new-chat"].dispatch("click");
    const escape = app.press(app.elements["agent-options"], "Escape");
    expect(escape.stopped).toBe(true);
    expect(app.elements["agent-picker"].hidden).toBe(true);
    expect(app.elements["new-chat"].focused).toBeGreaterThan(0);
    app.elements["new-chat"].dispatch("click");
    app.elements["new-chat"].dispatch("click");
    expect(app.elements["agent-picker"].hidden).toBe(true);
    app.elements["new-chat"].dispatch("click");
    app.pressWindow("Escape");
    expect(app.elements["agent-picker"].hidden).toBe(true);
    expect(app.requests("POST")).toHaveLength(0);

    app.elements["new-chat"].dispatch("click");
    app.options()[2].dispatch("click");
    await settle();
    expect(app.requests("POST")[0].body).toEqual({ agent: "cto" });
    expect(app.elements["agent-name"].textContent).toBe("CTO");
  });

  test("Agent per API gelöscht: beim nächsten Öffnen fehlt er in der Auswahl, ohne Neuladen (Issue #50)", async () => {
    const app = setup();
    await settle();
    app.elements["new-chat"].dispatch("click");
    expect(app.options().map(app.optionLabel)).toEqual(["General", "Research", "CTO"]);
    app.elements["new-chat"].dispatch("click");
    // Wie ein anderer Browser oder die Agenten-API: löschen, die Seite bleibt offen
    const res = await app.fetch("/api/agents/research", { method: "DELETE", body: JSON.stringify({ confirm: "research" }) });
    expect(res.status).toBe(200);
    const loads = app.requests("GET").filter(r => r.path === "/api/agents").length;
    app.elements["new-chat"].dispatch("click");
    await settle();
    expect(app.requests("GET").filter(r => r.path === "/api/agents").length).toBe(loads + 1);
    expect(app.elements["agent-picker"].hidden).toBe(false);
    expect(app.options().map(app.optionLabel)).toEqual(["General", "CTO"]);
    expect(app.options().map(b => b.attributes["data-agent-option"])).not.toContain("research");
    expect(app.options().map(b => b.attributes["aria-selected"])).toEqual(["true", "false"]);
    app.press(app.elements["agent-options"], "ArrowDown");
    app.press(app.elements["agent-options"], "Enter");
    await settle();
    expect(app.requests("POST")[0].body).toEqual({ agent: "cto" });
  });

  test("markierter Agent gelöscht, während die Auswahl offen ist: Markierung springt auf General", async () => {
    const app = setup();
    await settle();
    app.server.agents = app.server.agents!.filter(a => a.name !== "cto");
    app.elements["new-chat"].dispatch("click");
    app.press(app.elements["agent-options"], "ArrowUp");
    expect(app.options()[2].attributes["aria-selected"]).toBe("true");
    await settle();
    expect(app.options().map(app.optionLabel)).toEqual(["General", "Research"]);
    expect(app.options().map(b => b.attributes["aria-selected"])).toEqual(["true", "false"]);
  });

  test("ohne Agentenliste (Fehler): nur General", async () => {
    const app = setup({ agents: null });
    await settle();
    app.elements["new-chat"].dispatch("click");
    expect(app.options().map(app.optionLabel)).toEqual(["General"]);
  });
});

describe("Umbenennen in der Kopfzeile", () => {
  test("Titel antippen, Enter speichert normalisiert; Kopfzeile und Liste zeigen den neuen Titel", async () => {
    const app = setup();
    await settle();
    expect(app.elements["chat-title"].disabled).toBe(false);
    app.elements["chat-title"].dispatch("click");
    expect(app.elements["title-input"].hidden).toBe(false);
    expect(app.elements["chat-title"].hidden).toBe(true);
    expect(app.elements["title-input"].value).toBe("Betrieb");
    expect(app.elements["title-input"].focused).toBeGreaterThan(0);
    app.elements["title-input"].value = "  Betrieb   und  Wartung ";
    app.press(app.elements["title-input"], "Enter");
    await settle();
    expect(app.requests("PATCH")).toEqual([{ method: "PATCH", path: "/api/conversations/c1", body: { title: "Betrieb und Wartung" } }]);
    expect(app.elements["title-input"].hidden).toBe(true);
    expect(app.elements["chat-title"].hidden).toBe(false);
    expect(app.elements["chat-title"].textContent).toBe("Betrieb und Wartung");
    expect(app.titles()[0]).toBe("Betrieb und Wartung");
  });

  test("Escape und Verlassen des Felds brechen ab, ohne zu speichern", async () => {
    const app = setup();
    await settle();
    app.elements["chat-title"].dispatch("click");
    app.elements["title-input"].value = "Anders";
    const event = app.press(app.elements["title-input"], "Escape");
    expect(event.stopped).toBe(true);
    expect(app.elements["title-input"].hidden).toBe(true);
    expect(app.elements["chat-title"].textContent).toBe("Betrieb");
    app.elements["chat-title"].dispatch("click");
    app.elements["title-input"].value = "Auch anders";
    app.elements["title-input"].dispatch("blur");
    expect(app.elements["title-input"].hidden).toBe(true);
    await settle();
    expect(app.requests("PATCH")).toHaveLength(0);
    expect(app.elements["chat-title"].textContent).toBe("Betrieb");
  });

  test("zu lang: kein Speichern, Feld bleibt offen und markiert; leer oder unverändert: nichts senden", async () => {
    const app = setup();
    await settle();
    app.elements["chat-title"].dispatch("click");
    app.elements["title-input"].value = "😀".repeat(81);
    app.press(app.elements["title-input"], "Enter");
    await settle();
    expect(app.requests("PATCH")).toHaveLength(0);
    expect(app.elements["title-input"].hidden).toBe(false);
    expect(app.elements["title-input"].attributes["aria-invalid"]).toBe("true");
    expect(app.elements["connection"].hidden).toBe(false);
    app.elements["title-input"].value = "   ";
    app.press(app.elements["title-input"], "Enter");
    await settle();
    expect(app.elements["title-input"].hidden).toBe(true);
    app.elements["chat-title"].dispatch("click");
    app.press(app.elements["title-input"], "Enter");
    await settle();
    expect(app.requests("PATCH")).toHaveLength(0);
    expect(app.elements["chat-title"].textContent).toBe("Betrieb");
  });

  test("Server lehnt ab: Meldung, Feld bleibt zum Korrigieren offen", async () => {
    const app = setup();
    await settle();
    app.server.patchStatus = 400;
    app.elements["chat-title"].dispatch("click");
    app.elements["title-input"].value = "Neu";
    app.press(app.elements["title-input"], "Enter");
    await settle();
    expect(app.elements["title-input"].hidden).toBe(false);
    expect(app.elements["connection"].textContent).toContain("80 Zeichen");
  });

  test("ein Abruf der Liste im Hintergrund zerstört das Eingabefeld nicht", async () => {
    const app = setup({ conversations: [{ id: "c1", title: "Neues Gespräch", agent: "general" }] });
    await settle();
    app.elements["chat-title"].dispatch("click");
    app.elements["title-input"].value = "Mein Titel halb get";
    // Senden löst bei „Neues Gespräch" einen Abruf der Liste aus
    app.elements["input"].value = "Erste Frage";
    app.elements["composer"].dispatch("submit", { preventDefault() {} });
    await settle();
    expect(app.server.requests.filter(r => r.method === "GET" && r.path === "/api/conversations").length).toBeGreaterThan(1);
    expect(app.elements["title-input"].hidden).toBe(false);
    expect(app.elements["title-input"].value).toBe("Mein Titel halb get");
  });

  test("General und Direktchat: Titel gesperrt, kein Menü, auch nicht in der Seitenleiste (Issue #30)", async () => {
    for (const stored of ["topic-1", "dm"]) {
      const app = setup({
        telegram: {
          dm: { id: "dm", title: "Direktchat", agent: "general", lastActivity: new Date().toISOString() },
          topics: [{ id: "topic-1", title: "General", agent: "general", lastActivity: new Date().toISOString() }],
        },
        stored,
      });
      await settle();
      expect(app.elements["chat-title"].textContent).toBe(stored === "dm" ? "Direktchat" : "General");
      expect(app.elements["chat-title"].disabled).toBe(true);
      expect(app.elements["conversation-menu"].hidden).toBe(true);
      app.elements["chat-title"].dispatch("click");
      // Keine Bearbeitung: Titel bleibt sichtbar, das Feld wird nicht befüllt
      expect(app.elements["chat-title"].hidden).toBe(false);
      expect(app.elements["title-input"].value).toBe("");
      // Kein Menü-Knopf in der Seitenleiste, also weder Umbenennen noch Schließen noch Löschen
      expect(app.elements["topic-list"].children[0].children).toHaveLength(1);
      expect(app.elements["dm-list"].children[0].children).toHaveLength(1);
      // Das Header-Menü lässt sich auch nicht über den Knopf öffnen
      app.elements["conversation-menu"].dispatch("click");
      expect(app.elements["conversation-actions"].hidden).toBe(true);
      expect(app.requests("PATCH").concat(app.requests("DELETE"))).toHaveLength(0);
    }
  });
});

describe("Löschen", () => {
  test("Menü am Eintrag: Löschen fragt nach, Abbrechen löscht nicht", async () => {
    const app = setup();
    await settle();
    const more = app.row("c2").children[1];
    expect(more.attributes["aria-label"]).toBe("Optionen für Recherche VPS");
    more.dispatch("click");
    const panel = app.row("c2").children[2];
    expect(app.row("c2").children[1].attributes["aria-expanded"]).toBe("true");
    expect(app.panelButtons(panel).map(b => b.textContent)).toEqual(["Umbenennen", "Löschen"]);
    app.panelButtons(panel)[1].dispatch("click");
    const confirm = app.row("c2").children[2];
    expect(confirm.children[0].textContent).toBe("Gespräch löschen?");
    expect(app.panelButtons(confirm).map(b => b.textContent)).toEqual(["Löschen", "Abbrechen"]);
    app.panelButtons(confirm)[1].dispatch("click");
    expect(app.row("c2").children).toHaveLength(2);
    expect(app.requests("DELETE")).toHaveLength(0);
  });

  test("nicht offenes Gespräch löschen: verschwindet aus der Liste, offenes bleibt", async () => {
    const app = setup();
    await settle();
    app.row("c2").children[1].dispatch("click");
    app.panelButtons(app.row("c2").children[2])[1].dispatch("click");
    app.panelButtons(app.row("c2").children[2])[0].dispatch("click");
    await settle();
    expect(app.requests("DELETE")).toEqual([{ method: "DELETE", path: "/api/conversations/c2", body: undefined }]);
    expect(app.titles()).toEqual(["Betrieb"]);
    expect(app.elements["chat-title"].textContent).toBe("Betrieb");
    expect(FakeEventSource.all.filter(s => !s.closed).map(s => s.url)).toEqual(["/api/telegram/events", "/api/conversations/c1/events"]);
  });

  test("offenes Gespräch über die Kopfzeile löschen: jüngstes anderes öffnet, Entwurf, Strom und Auswahl aufgeräumt", async () => {
    const app = setup({ stored: "c2" });
    await settle();
    expect(app.elements["chat-title"].textContent).toBe("Recherche VPS");
    const oldStream = FakeEventSource.all.at(-1)!;
    // Entwurf im zu löschenden Gespräch
    app.elements["input"].value = "halber Entwurf";
    app.elements["input"].dispatch("input");
    expect(app.elements["conversation-menu"].hidden).toBe(false);
    app.elements["conversation-menu"].dispatch("click");
    expect(app.elements["conversation-actions"].hidden).toBe(false);
    expect(app.elements["conversation-menu"].attributes["aria-expanded"]).toBe("true");
    app.panelButtons(app.headerPanel())[1].dispatch("click");
    expect(app.headerPanel().children[0].textContent).toBe("Gespräch löschen?");
    app.panelButtons(app.headerPanel())[0].dispatch("click");
    await settle();
    expect(app.requests("DELETE")[0].path).toBe("/api/conversations/c2");
    expect(oldStream.closed).toBe(true);
    expect(app.elements["chat-title"].textContent).toBe("Betrieb");
    expect(app.store["tybo-last-conversation"]).toBe("c1");
    expect(app.elements["conversation-actions"].hidden).toBe(true);
    expect(app.elements["input"].value).toBe("");
    expect(app.titles()).toEqual(["Betrieb"]);
    // Kein Wiederholungs-Timer für das gelöschte Gespräch übrig
    for (const fn of [...app.timers.values()]) fn();
    await settle();
    expect(app.server.requests.some(r => r.path.startsWith("/api/conversations/c2") && r.method === "GET" && r.path.endsWith("/messages") &&
      app.server.requests.indexOf(r) > app.server.requests.findIndex(x => x.method === "DELETE"))).toBe(false);
  });

  test("nach dem Löschen öffnet das auf dem Server zuletzt aktive Gespräch, nicht das lokal nächste", async () => {
    const app = setup({
      stored: "c",
      conversations: [
        { id: "c", title: "C", agent: "general" },
        { id: "b", title: "B", agent: "general" },
        { id: "a", title: "A", agent: "research" },
      ],
    });
    await settle();
    expect(app.titles()).toEqual(["C", "B", "A"]);
    expect(app.elements["chat-title"].textContent).toBe("C");
    // In A wurde inzwischen geantwortet: auf dem Server steht A jetzt oben
    const [c, b, a] = app.server.conversations;
    app.server.conversations = [a, c, b];
    app.elements["conversation-menu"].dispatch("click");
    app.panelButtons(app.headerPanel())[1].dispatch("click");
    app.panelButtons(app.headerPanel())[0].dispatch("click");
    await settle();
    expect(app.elements["chat-title"].textContent).toBe("A");
    expect(app.elements["agent-name"].textContent).toBe("Research");
    expect(app.store["tybo-last-conversation"]).toBe("a");
    expect(app.titles()).toEqual(["A", "B"]);
  });

  test("letztes Web-Gespräch gelöscht, sonst nichts da: kein POST, Leerzustand mit „Neues Gespräch\" (Issue #30)", async () => {
    const app = setup({ conversations: [{ id: "c1", title: "Einzig", agent: "research" }] });
    await settle();
    app.elements["conversation-menu"].dispatch("click");
    app.panelButtons(app.headerPanel())[1].dispatch("click");
    app.panelButtons(app.headerPanel())[0].dispatch("click");
    await settle();
    expect(app.requests("POST")).toEqual([]);
    expect(app.elements["chat-title"].textContent).toBe("tybo");
    expect(app.elements["agent-name"].textContent).toBe("");
    expect(app.titles()).toEqual([]);
    expect(app.elements["web-group"].hidden).toBe(true);
    expect(app.elements["empty"].hidden).toBe(false);
    expect(app.elements["empty-new"].hidden).toBe(false);
    expect(app.elements["input"].disabled).toBe(true);
    expect(app.elements["conversation-menu"].hidden).toBe(true);
  });

  test("Server lehnt ab (Antwort läuft, 409): Meldung, Gespräch bleibt", async () => {
    const app = setup({ deleteStatus: 409 });
    await settle();
    app.elements["conversation-menu"].dispatch("click");
    app.panelButtons(app.headerPanel())[1].dispatch("click");
    app.panelButtons(app.headerPanel())[0].dispatch("click");
    await settle();
    expect(app.titles()).toEqual(["Betrieb", "Recherche VPS"]);
    expect(app.elements["chat-title"].textContent).toBe("Betrieb");
    const last = app.elements["messages"].children.at(-1)!;
    expect(last.className).toBe("msg msg-error");
    expect(last.children[0].textContent).toContain("nicht löschen");
    expect(app.elements["conversation-actions"].hidden).toBe(true);
  });

  test("Umbenennen aus dem Menü eines anderen Eintrags öffnet es und startet die Bearbeitung", async () => {
    const app = setup();
    await settle();
    app.row("c2").children[1].dispatch("click");
    app.panelButtons(app.row("c2").children[2])[0].dispatch("click");
    await settle();
    expect(app.elements["chat-title"].textContent).toBe("Recherche VPS");
    expect(app.elements["title-input"].hidden).toBe(false);
    expect(app.elements["title-input"].value).toBe("Recherche VPS");
  });

  test("Escape schließt ein offenes Menü; Löschen-Ereignis aus einem anderen Browser öffnet das nächste Gespräch", async () => {
    const app = setup();
    await settle();
    app.elements["conversation-menu"].dispatch("click");
    app.pressWindow("Escape");
    expect(app.elements["conversation-actions"].hidden).toBe(true);
    expect(app.elements["conversation-menu"].focused).toBeGreaterThan(0);

    const stream = FakeEventSource.all.at(-1)!;
    expect(stream.url).toBe("/api/conversations/c1/events");
    app.server.conversations = app.server.conversations.filter(c => c.id !== "c1");
    stream.emit("deleted", { data: JSON.stringify({ id: "c1" }) });
    await settle();
    expect(stream.closed).toBe(true);
    expect(app.elements["chat-title"].textContent).toBe("Recherche VPS");
    expect(app.titles()).toEqual(["Recherche VPS"]);
  });

  test("Verlauf meldet 404 und die Liste kennt das Gespräch nicht mehr: aufräumen statt endlos wiederholen", async () => {
    const app = setup({ stored: "c2" });
    await settle();
    app.server.conversations = app.server.conversations.filter(c => c.id !== "c2");
    // Nächster Abgleich (wie nach einem Wiederverbinden)
    FakeEventSource.all.at(-1)!.emit("open");
    await settle();
    expect(app.elements["chat-title"].textContent).toBe("Betrieb");
    expect(app.titles()).toEqual(["Betrieb"]);
  });
});

// ---------------------------------------------------------------------------
// Issue #30: Topics aus der Oberfläche anlegen und verwalten
// ---------------------------------------------------------------------------

const texts = (n: Node): string[] => [n.textContent, ...n.children.flatMap(texts)];
const recently = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const DM = { id: "dm", title: "Direktchat", agent: "general", lastActivity: null };

describe("Neues Gespräch als Topic (Issue #30)", () => {
  test("Anlegen öffnet topic-<n> und listet es ganz oben unter Topics, nicht bei den Web-Gesprächen", async () => {
    const app = setup({
      telegram: { dm: null, topics: [{ id: "topic-443", title: "Recherche", agent: "research", lastActivity: recently(5) }] },
    });
    await settle();
    app.elements["new-chat"].dispatch("click");
    app.press(app.elements["agent-options"], "ArrowDown");
    app.press(app.elements["agent-options"], "Enter");
    await settle();
    expect(app.requests("POST")).toEqual([{ method: "POST", path: "/api/conversations", body: { agent: "research" } }]);
    expect(app.store["tybo-last-conversation"]).toBe("topic-900");
    expect(app.elements["chat-title"].textContent).toBe("Neues Gespräch");
    expect(app.elements["agent-name"].textContent).toBe("Research");
    // Ohne Aktivität, trotzdem oben vor dem aktiven Topic und nicht unter „Ältere Topics"
    expect(app.topicRows("topic-list").map(li => li.children[0].attributes["data-id"])).toEqual(["topic-900", "topic-443"]);
    expect(app.topicRows("older-list")).toHaveLength(0);
    expect(app.topicRow("topic-900").children[0].attributes["aria-current"]).toBe("true");
    expect(app.titles()).toEqual(["Betrieb", "Recherche VPS"]);
    // Umbenennen per Titel geht für das neue Topic
    expect(app.elements["chat-title"].disabled).toBe(false);
  });

  test("auch nach einem Abgleich der Liste bleibt das neue Topic oben", async () => {
    const app = setup({
      telegram: { dm: null, topics: [{ id: "topic-443", title: "Recherche", agent: "research", lastActivity: recently(5) }] },
    });
    await settle();
    app.elements["new-chat"].dispatch("click");
    app.press(app.elements["agent-options"], "Enter");
    await settle();
    // Server sortiert Topics ohne Aktivität ans Ende
    app.server.telegram.topics = [app.server.telegram.topics[1], app.server.telegram.topics[0]];
    // Wiederverbinden des Sammelstroms gleicht die Liste ab
    const activity = FakeEventSource.all.find(s => s.url === "/api/telegram/events" && !s.closed)!;
    activity.emit("open");
    activity.emit("open");
    await settle();
    expect(app.server.requests.filter(r => r.method === "GET" && r.path === "/api/conversations").length).toBeGreaterThan(1);
    expect(app.topicRows("topic-list").map(li => li.children[0].attributes["data-id"])).toEqual(["topic-900", "topic-443"]);
  });

  for (const [status, reason, error] of [
    [409, "no_group", "Keine Forum-Gruppe eingerichtet (TELEGRAM_GROUP_ID)"],
    [403, "no_manage_topics", "Dem Bot fehlt in der Gruppe das Recht ‚Topics verwalten'"],
    [502, undefined, "Telegram hat die Aktion abgelehnt"],
    [503, undefined, "Topics verwalten ist nicht eingerichtet"],
  ] as const) {
    test(`Server lehnt ab (${status}): seine Meldung erscheint, nichts wird angelegt`, async () => {
      const app = setup({ create: { status, body: { error, ...(reason ? { reason } : {}) } } });
      await settle();
      app.elements["new-chat"].dispatch("click");
      app.press(app.elements["agent-options"], "Enter");
      await settle();
      const last = app.elements["messages"].children.at(-1)!;
      expect(last.className).toBe("msg msg-error");
      expect(last.children[0].textContent).toBe(error);
      expect(texts(app.elements["messages"]).join("|")).not.toContain("konnte nicht angelegt werden");
      expect(app.elements["chat-title"].textContent).toBe("Betrieb");
      expect(app.topicRows("topic-list")).toHaveLength(0);
      expect(app.requests("POST")).toHaveLength(1);
    });
  }

  test("500 mit conversation: Topic ist angelegt, wird geöffnet, Meldung dazu, kein zweiter POST", async () => {
    const conversation = { id: "topic-950", title: "Neues Gespräch", agent: "general", lastActivity: null };
    const app = setup({ create: { status: 500, body: { error: "Topic angelegt, Agent-Zuordnung nicht gespeichert", conversation } } });
    await settle();
    app.elements["new-chat"].dispatch("click");
    app.press(app.elements["agent-options"], "Enter");
    await settle();
    expect(app.store["tybo-last-conversation"]).toBe("topic-950");
    expect(app.topicTitles("topic-list")).toEqual(["Neues Gespräch"]);
    expect(texts(app.elements["messages"]).join("|")).toContain("Agent-Zuordnung nicht gespeichert");
    expect(app.requests("POST")).toHaveLength(1);
  });

  test("ohne Gespräch offen: Ablehnung erscheint im Hinweisbalken", async () => {
    const app = setup({ conversations: [], create: { status: 409, body: { error: "Keine Forum-Gruppe eingerichtet (TELEGRAM_GROUP_ID)" } } });
    await settle();
    app.elements["empty-new"].dispatch("click");
    expect(app.elements["agent-picker"].hidden).toBe(false);
    app.press(app.elements["agent-options"], "Enter");
    await settle();
    expect(app.elements["connection"].hidden).toBe(false);
    expect(app.elements["connection"].textContent).toBe("Keine Forum-Gruppe eingerichtet (TELEGRAM_GROUP_ID)");
  });
});

describe("Startverhalten ohne automatisches Anlegen (Issue #30)", () => {
  const getLists = (app: ReturnType<typeof setup>) => app.server.requests.filter(r => r.method === "GET" && r.path === "/api/conversations");

  test("gemerktes Topic wird geöffnet", async () => {
    const app = setup({
      stored: "topic-12",
      telegram: { dm: DM, topics: [{ id: "topic-12", title: "Finanzen", agent: "finance", lastActivity: recently(60) }] },
    });
    await settle();
    expect(app.elements["chat-title"].textContent).toBe("Finanzen");
    expect(app.requests("POST")).toEqual([]);
  });

  test("ohne gemerktes: jüngstes Web-Gespräch", async () => {
    const app = setup({ telegram: { dm: DM, topics: [] } });
    await settle();
    expect(app.elements["chat-title"].textContent).toBe("Betrieb");
    expect(app.requests("POST")).toEqual([]);
  });

  test("ohne Web-Gespräche: Direktchat; die Gruppe „Web-Gespräche\" fehlt", async () => {
    const app = setup({ conversations: [], telegram: { dm: DM, topics: [] } });
    await settle();
    expect(app.requests("POST")).toEqual([]);
    expect(app.elements["chat-title"].textContent).toBe("Direktchat");
    expect(app.elements["web-group"].hidden).toBe(true);
  });

  test("ohne Web-Gespräche und Direktchat: das zuletzt aktive offene Topic", async () => {
    const app = setup({
      conversations: [],
      telegram: {
        dm: null,
        topics: [
          { id: "topic-5", title: "Zu", agent: "cto", lastActivity: recently(1), closed: true },
          { id: "topic-443", title: "Recherche", agent: "research", lastActivity: recently(5) },
          { id: "topic-12", title: "Finanzen", agent: "finance", lastActivity: recently(90) },
        ],
      },
    });
    await settle();
    expect(app.requests("POST")).toEqual([]);
    expect(app.elements["chat-title"].textContent).toBe("Recherche");
  });

  test("gar kein Gespräch: Leerzustand mit „Neues Gespräch\", Eingabe gesperrt, kein POST", async () => {
    const app = setup({ conversations: [] });
    await settle();
    expect(app.requests("POST")).toEqual([]);
    expect(getLists(app)).toHaveLength(1);
    expect(app.elements["empty"].hidden).toBe(false);
    expect(app.elements["empty-title"].textContent).toBe("Noch kein Gespräch");
    expect(app.elements["empty-new"].hidden).toBe(false);
    expect(app.elements["input"].disabled).toBe(true);
    expect(app.elements["send"].disabled).toBe(true);
    expect(app.elements["web-group"].hidden).toBe(true);
    // Knopf im Leerzustand öffnet die Agentenauswahl, legt aber noch nichts an
    app.elements["empty-new"].dispatch("click");
    expect(app.elements["agent-picker"].hidden).toBe(false);
    expect(app.requests("POST")).toEqual([]);
    app.press(app.elements["agent-options"], "Enter");
    await settle();
    expect(app.requests("POST")).toHaveLength(1);
    expect(app.elements["chat-title"].textContent).toBe("Neues Gespräch");
    expect(app.elements["empty-new"].hidden).toBe(true);
    expect(app.elements["input"].disabled).toBe(false);
  });

  test("letztes Web-Gespräch gelöscht, Direktchat vorhanden: kein neues Gespräch, Direktchat offen", async () => {
    const app = setup({ conversations: [{ id: "c1", title: "Einzig", agent: "research" }], telegram: { dm: DM, topics: [] } });
    await settle();
    app.elements["conversation-menu"].dispatch("click");
    app.panelButtons(app.headerPanel())[1].dispatch("click");
    app.panelButtons(app.headerPanel())[0].dispatch("click");
    await settle();
    expect(app.requests("POST")).toEqual([]);
    expect(app.elements["chat-title"].textContent).toBe("Direktchat");
    expect(app.elements["web-group"].hidden).toBe(true);
  });
});

describe("Topics umbenennen, schließen, wieder öffnen (Issue #30)", () => {
  const TOPICS = () => ({
    dm: DM,
    topics: [
      { id: "topic-443", title: "Recherche", agent: "research", lastActivity: recently(5) },
      { id: "topic-1", title: "General", agent: "general", lastActivity: recently(10) },
      { id: "topic-7", title: "Archiv", agent: "cto", lastActivity: recently(60 * 24 * 45) },
    ],
  });

  test("Titel antippen benennt das Topic um: PATCH, Kopfzeile, Liste; Leerraum innen bleibt wie in Telegram", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    expect(app.elements["chat-title"].disabled).toBe(false);
    expect(app.elements["conversation-menu"].hidden).toBe(false);
    app.elements["chat-title"].dispatch("click");
    expect(app.elements["title-input"].value).toBe("Recherche");
    app.elements["title-input"].value = "  VPS  und Hosting ";
    app.press(app.elements["title-input"], "Enter");
    await settle();
    expect(app.requests("PATCH")).toEqual([{ method: "PATCH", path: "/api/conversations/topic-443", body: { title: "VPS  und Hosting" } }]);
    expect(app.elements["chat-title"].textContent).toBe("VPS  und Hosting");
    expect(app.topicTitles("topic-list")[0]).toBe("VPS  und Hosting");
    // Eingabe nennt den neuen Namen
    expect(app.elements["input"].attributes["placeholder"]).toBe("Nachricht an VPS  und Hosting");
  });

  test("Topic-Namen bis 128 Zeichen; länger wird nicht gesendet", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    app.elements["chat-title"].dispatch("click");
    app.elements["title-input"].value = "x".repeat(129);
    app.press(app.elements["title-input"], "Enter");
    await settle();
    expect(app.requests("PATCH")).toHaveLength(0);
    expect(app.elements["title-input"].attributes["aria-invalid"]).toBe("true");
    expect(app.elements["connection"].textContent).toContain("128 Zeichen");
    app.elements["title-input"].value = "x".repeat(128);
    app.press(app.elements["title-input"], "Enter");
    await settle();
    expect(app.requests("PATCH")).toHaveLength(1);
    expect(app.elements["chat-title"].textContent).toBe("x".repeat(128));
  });

  test("500 mit conversation: umbenannt übernehmen, Meldung des Servers im Hinweisbalken", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    app.server.topicPatch = { status: 500, body: { error: "In Telegram umbenannt, Name in der WebUI nicht gespeichert", conversation: { id: "topic-443", title: "Neu", agent: "research", lastActivity: recently(5) } } };
    app.elements["chat-title"].dispatch("click");
    app.elements["title-input"].value = "Neu";
    app.press(app.elements["title-input"], "Enter");
    await settle();
    expect(app.elements["title-input"].hidden).toBe(true);
    expect(app.elements["chat-title"].textContent).toBe("Neu");
    expect(app.elements["connection"].textContent).toBe("In Telegram umbenannt, Name in der WebUI nicht gespeichert");
  });

  test("Menü am Topic: Umbenennen, Schließen, Agent ändern …, Löschen …; General und Direktchat ohne Menü", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    const row = app.topicRow("topic-443");
    expect(row.children).toHaveLength(2);
    expect(row.children[1].attributes["aria-label"]).toBe("Optionen für Recherche");
    row.children[1].dispatch("click");
    await settle();
    const panel = app.topicRow("topic-443").children[2];
    expect(app.panelButtons(panel).map(b => b.textContent)).toEqual(["Umbenennen", "Schließen", "Agent ändern …", "Löschen …"]);
    expect(app.topicRow("topic-1").children).toHaveLength(1);
    expect(app.elements["dm-list"].children[0].children).toHaveLength(1);
  });

  test("Schließen: gedämpft mit Schloss unter „Ältere Topics\", Eingabe gesperrt mit Hinweis, kein Senden", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    app.elements["conversation-menu"].dispatch("click");
    await settle();
    expect(app.panelButtons(app.headerPanel()).map(b => b.textContent)).toEqual(["Umbenennen", "Schließen", "Agent ändern …", "Löschen …"]);
    app.panelButtons(app.headerPanel())[1].dispatch("click");
    await settle();
    expect(app.requests("POST").map(r => r.path)).toEqual(["/api/conversations/topic-443/close"]);
    expect(app.elements["conversation-actions"].hidden).toBe(true);
    // In „Ältere Topics", aufgeklappt, weil offen; mit Schloss und data-closed
    expect(app.topicRows("topic-list").map(li => li.children[0].attributes["data-id"])).toEqual(["topic-1"]);
    const entry = app.topicRow("topic-443").children[0];
    expect(entry.attributes["data-closed"]).toBe("true");
    const lock = entry.children[1].children.find((c: Node) => c.className === "closed-mark");
    expect(lock.attributes["aria-label"]).toBe("geschlossen");
    expect(app.elements["older-list"].hidden).toBe(false);
    // Schreiben gesperrt
    expect(app.elements["input"].disabled).toBe(true);
    expect(app.elements["closed-note"].hidden).toBe(false);
    app.elements["input"].value = "Trotzdem";
    app.elements["composer"].dispatch("submit", { preventDefault() {} });
    await settle();
    expect(app.requests("POST").filter(r => r.path.endsWith("/messages"))).toHaveLength(0);
    expect(app.elements["send"].disabled).toBe(true);
  });

  test("Wieder öffnen: closed verschwindet (auch wenn die Antwort kein closed-Feld hat), Eingabe wieder frei", async () => {
    const telegram = TOPICS();
    (telegram.topics[0] as any).closed = true;
    const app = setup({ telegram, stored: "topic-443" });
    await settle();
    expect(app.elements["input"].disabled).toBe(true);
    expect(app.topicRow("topic-443").children[0].attributes["data-closed"]).toBe("true");
    app.elements["conversation-menu"].dispatch("click");
    await settle();
    expect(app.panelButtons(app.headerPanel())[1].textContent).toBe("Wieder öffnen");
    app.panelButtons(app.headerPanel())[1].dispatch("click");
    await settle();
    expect(app.requests("POST").map(r => r.path)).toEqual(["/api/conversations/topic-443/reopen"]);
    expect(app.topicRows("topic-list").map(li => li.children[0].attributes["data-id"])).toEqual(["topic-443", "topic-1"]);
    expect(app.topicRow("topic-443").children[0].attributes["data-closed"]).toBeUndefined();
    expect(app.elements["input"].disabled).toBe(false);
    expect(app.elements["closed-note"].hidden).toBe(true);
  });

  test("Listenabgleich übernimmt geschlossen und wieder offen", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    app.server.telegram.topics[0].closed = true;
    const activity = FakeEventSource.all.find(s => s.url === "/api/telegram/events")!;
    activity.emit("open");
    activity.emit("open");
    await settle();
    expect(app.elements["input"].disabled).toBe(true);
    delete app.server.telegram.topics[0].closed;
    activity.emit("open");
    await settle();
    expect(app.elements["input"].disabled).toBe(false);
    expect(app.topicRow("topic-443").children[0].attributes["data-closed"]).toBeUndefined();
  });

  test("Server meldet beim Senden 409 closed: sperren, seine Meldung zeigen, Entwurf bleibt", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    // In einem anderen Browser geschlossen, dieser weiß es noch nicht
    app.server.telegram.topics[0].closed = true;
    app.elements["input"].value = "Frage";
    app.elements["input"].dispatch("input");
    app.elements["composer"].dispatch("submit", { preventDefault() {} });
    await settle();
    expect(app.elements["input"].disabled).toBe(true);
    expect(app.elements["input"].value).toBe("Frage");
    const last = app.elements["messages"].children.at(-1)!;
    expect(last.children[0].textContent).toBe("Das Topic ist geschlossen. Erst wieder öffnen.");
  });

  test("Schließen scheitert (403): Meldung des Servers im Menü, Topic bleibt offen", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    app.server.topicClose = { status: 403, body: { error: "Dem Bot fehlt in der Gruppe das Recht ‚Topics verwalten'", reason: "no_manage_topics" } };
    app.elements["conversation-menu"].dispatch("click");
    await settle();
    app.panelButtons(app.headerPanel())[1].dispatch("click");
    await settle();
    expect(app.elements["conversation-actions"].hidden).toBe(false);
    const error = app.headerPanel().children.find((c: Node) => c.className === "actions-error");
    expect(error.textContent).toBe("Dem Bot fehlt in der Gruppe das Recht ‚Topics verwalten'");
    expect(error.attributes["role"]).toBe("alert");
    expect(app.elements["input"].disabled).toBe(false);
  });

  test("Umbenennen aus dem Menü am Topic-Eintrag öffnet das Topic und startet die Bearbeitung", async () => {
    const app = setup({ telegram: TOPICS() });
    await settle();
    expect(app.elements["chat-title"].textContent).toBe("Betrieb");
    app.elements["older-toggle"].dispatch("click");
    app.topicRow("topic-7").children[1].dispatch("click");
    await settle();
    app.panelButtons(app.topicRow("topic-7").children[2])[0].dispatch("click");
    await settle();
    expect(app.elements["chat-title"].textContent).toBe("Archiv");
    expect(app.elements["title-input"].hidden).toBe(false);
    expect(app.elements["title-input"].value).toBe("Archiv");
  });
});

describe("splitTopics (Issue #30)", () => {
  const split = new Function("document", "window", `${source}\nreturn splitTopics;`)({ getElementById: () => null }, {}) as
    (topics: any[], now?: number, pinned?: Set<string>) => { recent: any[]; older: any[] };
  const now = Date.parse("2026-09-24T12:00:00Z");

  test("geschlossen immer älter, angeheftet ohne Aktivität oben (zuletzt angelegtes zuerst)", () => {
    const { recent, older } = split([
      { id: "topic-2", lastActivity: "2026-09-24T11:00:00Z", closed: true },
      { id: "topic-3", lastActivity: "2026-09-24T10:00:00Z" },
      { id: "topic-8", lastActivity: null },
      { id: "topic-9", lastActivity: null },
      { id: "topic-4", lastActivity: null },
    ], now, new Set(["topic-8", "topic-9"]));
    expect(recent.map(t => t.id)).toEqual(["topic-9", "topic-8", "topic-3"]);
    expect(older.map(t => t.id)).toEqual(["topic-2", "topic-4"]);
  });
});

describe("Topic löschen mit Namensbestätigung (Issue #30)", () => {
  const TOPICS = () => ({
    dm: DM,
    topics: [
      { id: "topic-443", title: "Recherche", agent: "research", lastActivity: recently(5) },
      { id: "topic-12", title: "Finanzen <alt> & Co", agent: "finance", lastActivity: recently(30) },
      { id: "topic-1", title: "General", agent: "general", lastActivity: recently(10) },
    ],
  });
  const byClass = (panel: Node, name: string) => panel.children.filter((c: Node) => String(c.className).split(" ").includes(name));
  /** Öffnet Menü der Kopfzeile und die Rückfrage; gibt das Panel zurück */
  async function openConfirm(app: ReturnType<typeof setup>) {
    app.elements["conversation-menu"].dispatch("click");
    await settle();
    const del = app.panelButtons(app.headerPanel()).find(b => b.textContent === "Löschen …")!;
    expect(del.disabled).toBe(false);
    del.dispatch("click");
    return app.headerPanel();
  }
  const input = (panel: Node) => byClass(panel, "confirm-input")[0];
  const red = (panel: Node) => byClass(panel, "danger-button")[0];
  const type = (panel: Node, value: string) => {
    input(panel).value = value;
    input(panel).dispatch("input");
  };

  test("Rückfrage im Seitenstil: Name, Hinweis zum Gedächtnis, Feld mit Fokus, roter Knopf gesperrt", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    const panel = await openConfirm(app);
    expect(panel.className).toContain("delete-confirm");
    expect(byClass(panel, "actions-question")[0].textContent).toBe("Topic ‚Recherche' in Telegram endgültig löschen?");
    expect(byClass(panel, "actions-hint")[0].textContent).toBe("Alle Nachrichten darin verschwinden aus Telegram. Der Verlauf im Gedächtnis von tybo bleibt.");
    expect(byClass(panel, "confirm-label")[0].textContent).toBe("Zum Bestätigen Namen eintippen");
    expect(byClass(panel, "confirm-label")[0].attributes["for"]).toBe(input(panel).id);
    expect(red(panel).textContent).toBe("Endgültig löschen");
    expect(red(panel).disabled).toBe(true);
    expect(app.panelButtons(panel).map(b => b.textContent)).toEqual(["Endgültig löschen", "Abbrechen"]);
    expect(app.requests("DELETE")).toHaveLength(0);
  });

  test("roter Knopf erst bei exakt gleichem Namen aktiv; nichts wird normalisiert", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    const panel = await openConfirm(app);
    for (const wrong of ["Recherch", "recherche", "Recherche ", " Recherche", "RECHERCHE", "Recherche\n"]) {
      type(panel, wrong);
      expect(red(panel).disabled).toBe(true);
      // Enter mit falschem Namen tut nichts
      app.press(input(panel), "Enter");
    }
    red(panel).dispatch("click");
    await settle();
    expect(app.requests("DELETE")).toHaveLength(0);
    type(panel, "Recherche");
    expect(red(panel).disabled).toBe(false);
    type(panel, "Recherche!");
    expect(red(panel).disabled).toBe(true);
  });

  test("Löschen des offenen Topics: DELETE mit Namen, Strom zu, vorhandenes Gespräch offen, kein POST", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    const stream = FakeEventSource.all.find(s => s.url === "/api/conversations/topic-443/events")!;
    app.elements["input"].value = "Entwurf";
    app.elements["input"].dispatch("input");
    const panel = await openConfirm(app);
    type(panel, "Recherche");
    red(panel).dispatch("click");
    await settle();
    expect(app.requests("DELETE")).toEqual([{ method: "DELETE", path: "/api/conversations/topic-443", body: { confirm: "Recherche" } }]);
    expect(stream.closed).toBe(true);
    expect(app.requests("POST")).toEqual([]);
    expect(app.elements["chat-title"].textContent).toBe("Betrieb");
    expect(app.store["tybo-last-conversation"]).toBe("c1");
    expect(() => app.topicRow("topic-443")).toThrow();
    expect(app.elements["conversation-actions"].hidden).toBe(true);
    expect(app.elements["input"].value).toBe("");
  });

  test("Enter im Feld mit exaktem Namen löscht; Name mit Sonderzeichen nur als Text", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-12" });
    await settle();
    const panel = await openConfirm(app);
    expect(byClass(panel, "actions-question")[0].textContent).toBe("Topic ‚Finanzen <alt> & Co' in Telegram endgültig löschen?");
    type(panel, "Finanzen <alt> & Co");
    const event = app.press(input(panel), "Enter");
    expect(event.prevented).toBe(true);
    await settle();
    expect(app.requests("DELETE")[0].body).toEqual({ confirm: "Finanzen <alt> & Co" });
    expect(() => app.topicRow("topic-12")).toThrow();
  });

  test("Bestandsname mit Leerraum außen: verlangt und gesendet wird exactTitle, nicht der Titel", async () => {
    const telegram = TOPICS();
    telegram.topics.push({ id: "topic-7", title: "Sieben", exactTitle: " Sieben ", agent: "general", lastActivity: recently(40) });
    const app = setup({ telegram, stored: "topic-7" });
    await settle();
    const panel = await openConfirm(app);
    expect(byClass(panel, "actions-question")[0].textContent).toBe("Topic ‚ Sieben ' in Telegram endgültig löschen?");
    type(panel, "Sieben");
    expect(red(panel).disabled).toBe(true);
    app.press(input(panel), "Enter");
    await settle();
    expect(app.requests("DELETE")).toHaveLength(0);
    type(panel, " Sieben ");
    expect(red(panel).disabled).toBe(false);
    red(panel).dispatch("click");
    await settle();
    expect(app.requests("DELETE")).toEqual([{ method: "DELETE", path: "/api/conversations/topic-7", body: { confirm: " Sieben " } }]);
    expect(() => app.topicRow("topic-7")).toThrow();
  });

  const SIEBEN = () => {
    const telegram = TOPICS();
    telegram.topics.push({ id: "topic-7", title: "Sieben", exactTitle: " Sieben ", agent: "general", lastActivity: recently(40) });
    return telegram;
  };

  async function deleteAs(app: ReturnType<typeof setup>, name: string) {
    const panel = await openConfirm(app);
    expect(byClass(panel, "actions-question")[0].textContent).toBe(`Topic ‚${name}' in Telegram endgültig löschen?`);
    type(panel, name);
    expect(red(panel).disabled).toBe(false);
    red(panel).dispatch("click");
    await settle();
    expect(app.requests("DELETE")).toEqual([{ method: "DELETE", path: "/api/conversations/topic-7", body: { confirm: name } }]);
    expect(() => app.topicRow("topic-7")).toThrow();
  }

  test("nach dem Umbenennen von ‚ Sieben ' in ‚Acht' verlangt die Löschrückfrage ‚Acht', DELETE klappt", async () => {
    const app = setup({ telegram: SIEBEN(), stored: "topic-7" });
    await settle();
    app.elements["chat-title"].dispatch("click");
    app.elements["title-input"].value = "Acht";
    app.press(app.elements["title-input"], "Enter");
    await settle();
    expect(app.elements["chat-title"].textContent).toBe("Acht");
    await deleteAs(app, "Acht");
  });

  test("Listenabgleich ohne exactTitle (in Telegram umbenannt): verlangt wird der neue Name", async () => {
    const app = setup({ telegram: SIEBEN(), stored: "topic-7" });
    await settle();
    const t = app.server.telegram.topics.find(x => x.id === "topic-7")!;
    t.title = "Acht";
    delete t.exactTitle;
    const activity = FakeEventSource.all.find(s => s.url === "/api/telegram/events")!;
    activity.emit("open");
    activity.emit("open");
    await settle();
    expect(app.elements["chat-title"].textContent).toBe("Acht");
    await deleteAs(app, "Acht");
  });

  test("Teilstand { id, closed: true } behält den gültigen exakten Namen", async () => {
    const app = setup({ telegram: SIEBEN(), stored: "topic-7" });
    await settle();
    app.server.telegram.topics.find(x => x.id === "topic-7")!.closed = true;
    // Der Abgleich danach scheitert, damit nur der Teilstand wirkt
    app.server.listStatus = 500;
    app.elements["input"].value = "Hallo";
    app.elements["input"].dispatch("input");
    app.elements["composer"].dispatch("submit", { preventDefault() {} });
    await settle();
    expect(app.elements["input"].disabled).toBe(true);
    app.server.listStatus = 200;
    await deleteAs(app, " Sieben ");
  });

  test("nicht offenes Topic über den Eintrag löschen: offenes bleibt", async () => {
    const app = setup({ telegram: TOPICS() });
    await settle();
    app.topicRow("topic-12").children[1].dispatch("click");
    await settle();
    app.panelButtons(app.topicRow("topic-12").children[2]).find(b => b.textContent === "Löschen …")!.dispatch("click");
    const panel = app.topicRow("topic-12").children[2];
    // Den Fokus ins Feld setzt focusKey über querySelector; das prüft der Browser-Durchlauf
    expect(input(panel).attributes["data-focus-key"]).toBe("entry:confirm-name:topic-12");
    type(panel, "Finanzen <alt> & Co");
    red(panel).dispatch("click");
    await settle();
    expect(app.requests("DELETE")[0].path).toBe("/api/conversations/topic-12");
    expect(app.topicTitles("topic-list")).toEqual(["Recherche", "General"]);
    expect(app.elements["chat-title"].textContent).toBe("Betrieb");
  });

  test("letztes Gespräch überhaupt gelöscht: Leerzustand, kein POST", async () => {
    const app = setup({ conversations: [], telegram: { dm: null, topics: [{ id: "topic-443", title: "Recherche", agent: "research", lastActivity: recently(5) }] } });
    await settle();
    expect(app.elements["chat-title"].textContent).toBe("Recherche");
    const panel = await openConfirm(app);
    type(panel, "Recherche");
    red(panel).dispatch("click");
    await settle();
    expect(app.requests("POST")).toEqual([]);
    expect(app.elements["chat-title"].textContent).toBe("tybo");
    expect(app.elements["empty-new"].hidden).toBe(false);
    expect(app.elements["topic-group"].hidden).toBe(true);
  });

  test("cleanup „unvollständig\": trotzdem gelöscht, Hinweis im Balken", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    app.server.topicDelete = { status: 200, body: { deleted: true, cleanup: "unvollständig" } };
    app.server.telegram.topics = app.server.telegram.topics.filter(t => t.id !== "topic-443");
    const panel = await openConfirm(app);
    type(panel, "Recherche");
    red(panel).dispatch("click");
    await settle();
    expect(() => app.topicRow("topic-443")).toThrow();
    expect(app.elements["connection"].textContent).toContain("unvollständig");
  });

  for (const [status, error] of [
    [409, "In diesem Topic läuft gerade eine Antwort"],
    [400, "Zum Löschen den genauen Namen des Topics angeben"],
    [502, "Telegram hat die Aktion abgelehnt"],
    [500, "Der Topic-Zustand konnte nicht gespeichert werden"],
  ] as const) {
    test(`Server lehnt ab (${status}): seine Meldung in der Rückfrage, Topic bleibt`, async () => {
      const app = setup({ telegram: TOPICS(), stored: "topic-443" });
      await settle();
      app.server.topicDelete = { status, body: { error } };
      const panel = await openConfirm(app);
      type(panel, "Recherche");
      red(panel).dispatch("click");
      await settle();
      const now = app.headerPanel();
      expect(byClass(now, "actions-error")[0].textContent).toBe(error);
      expect(app.topicRow("topic-443")).toBeTruthy();
      expect(app.elements["chat-title"].textContent).toBe("Recherche");
      // Eingetippter Name bleibt stehen, erneuter Versuch möglich
      expect(input(now).value).toBe("Recherche");
      expect(red(now).disabled).toBe(false);
    });
  }

  test("403 beim Löschen: Meldung, Rechte werden neu geholt", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    app.server.topicDelete = { status: 403, body: { error: "Dem Bot fehlt in der Gruppe das Recht ‚Nachrichten löschen'", reason: "no_delete_messages" } };
    const panel = await openConfirm(app);
    const before = app.server.requests.filter(r => r.path === "/api/telegram/rights").length;
    app.server.rights = { status: 200, body: { group: true, manageTopics: true, deleteMessages: false } };
    type(panel, "Recherche");
    red(panel).dispatch("click");
    await settle();
    expect(byClass(app.headerPanel(), "actions-error")[0].textContent).toBe("Dem Bot fehlt in der Gruppe das Recht ‚Nachrichten löschen'");
    expect(app.server.requests.filter(r => r.path === "/api/telegram/rights").length).toBe(before + 1);
    // Abbrechen: im Menü ist Löschen jetzt gesperrt
    app.panelButtons(app.headerPanel()).find(b => b.textContent === "Abbrechen")!.dispatch("click");
    app.elements["conversation-menu"].dispatch("click");
    await settle();
    expect(app.panelButtons(app.headerPanel()).find(b => b.textContent === "Löschen …")!.disabled).toBe(true);
  });

  test("ohne Recht „Nachrichten löschen\": Löschen … gesperrt mit Erklärung, wie man es in Telegram gibt", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443", rights: { status: 200, body: { group: true, manageTopics: true, deleteMessages: false } } });
    await settle();
    app.elements["conversation-menu"].dispatch("click");
    await settle();
    const panel = app.headerPanel();
    const del = app.panelButtons(panel).find(b => b.textContent === "Löschen …")!;
    expect(del.disabled).toBe(true);
    const hint = byClass(panel, "actions-hint")[0];
    expect(hint.textContent).toContain("Nachrichten löschen");
    expect(hint.textContent).toContain("Gruppe → Administratoren → Bot");
    expect(del.attributes["aria-describedby"]).toBe(hint.id);
    // Schließen bleibt möglich
    expect(app.panelButtons(panel).find(b => b.textContent === "Schließen")!.disabled).toBe(false);
    del.dispatch("click");
    expect(byClass(app.headerPanel(), "confirm-input")).toHaveLength(0);
  });

  test("Rechteabfrage scheitert: nicht als erteilt behandeln, erneut prüfen möglich", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443", rights: { status: 502, body: { error: "Telegram hat die Rechte des Bots nicht geliefert" } } });
    await settle();
    app.elements["conversation-menu"].dispatch("click");
    await settle();
    let panel = app.headerPanel();
    expect(app.panelButtons(panel).find(b => b.textContent === "Löschen …")!.disabled).toBe(true);
    expect(byClass(panel, "actions-hint")[0].textContent).toContain("Telegram hat die Rechte des Bots nicht geliefert");
    app.server.rights = { status: 200, body: { group: true, manageTopics: true, deleteMessages: true } };
    app.panelButtons(panel).find(b => b.textContent === "Rechte erneut prüfen")!.dispatch("click");
    await settle();
    panel = app.headerPanel();
    expect(app.panelButtons(panel).find(b => b.textContent === "Löschen …")!.disabled).toBe(false);
    expect(byClass(panel, "actions-hint")).toHaveLength(0);
  });

  test("solange die Rechte laden, ist Löschen gesperrt", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    app.elements["conversation-menu"].dispatch("click");
    // Noch vor der Antwort auf GET /api/telegram/rights
    const panel = app.headerPanel();
    expect(app.panelButtons(panel).find(b => b.textContent === "Löschen …")!.disabled).toBe(true);
    expect(byClass(panel, "actions-hint")[0].textContent).toBe("Rechte des Bots werden geprüft …");
  });

  test("Löschen-Ereignis aus einem anderen Browser: offenes Topic räumt auf, nächstes öffnet ohne Anlegen", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    const stream = FakeEventSource.all.find(s => s.url === "/api/conversations/topic-443/events")!;
    app.server.telegram.topics = app.server.telegram.topics.filter(t => t.id !== "topic-443");
    stream.emit("deleted", { data: JSON.stringify({ id: "topic-443" }) });
    await settle();
    expect(stream.closed).toBe(true);
    expect(app.requests("POST")).toEqual([]);
    expect(app.elements["chat-title"].textContent).toBe("Betrieb");
    expect(() => app.topicRow("topic-443")).toThrow();
    // Kein Wiederholungs-Timer für das gelöschte Topic
    const deletedAt = app.server.requests.length;
    for (const fn of [...app.timers.values()]) fn();
    await settle();
    expect(app.server.requests.slice(deletedAt).some(r => r.path.startsWith("/api/conversations/topic-443"))).toBe(false);
  });

  test("Verlauf 404 und Topic fehlt in der Liste: aufräumen statt endlos wiederholen", async () => {
    const app = setup({ telegram: TOPICS(), stored: "topic-443" });
    await settle();
    app.server.telegram.topics = app.server.telegram.topics.filter(t => t.id !== "topic-443");
    FakeEventSource.all.find(s => s.url === "/api/conversations/topic-443/events")!.emit("open");
    await settle();
    expect(app.elements["chat-title"].textContent).toBe("Betrieb");
  });

  test("Web-Gespräche: Rückfrage bleibt neutral (kein roter Knopf, kein Namensfeld)", async () => {
    const app = setup();
    await settle();
    app.elements["conversation-menu"].dispatch("click");
    app.panelButtons(app.headerPanel())[1].dispatch("click");
    const panel = app.headerPanel();
    expect(byClass(panel, "danger-button")).toHaveLength(0);
    expect(byClass(panel, "confirm-input")).toHaveLength(0);
    expect(app.server.requests.some(r => r.path === "/api/telegram/rights")).toBe(false);
  });
});
