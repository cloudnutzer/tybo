// Agenten verwalten im Browser (Issue #51): System-Prompt sehen, bearbeiten
// und zurücksetzen, neue Agenten, Löschen mit Rückfrage, Wiederherstellen und
// der Board-Schalter im Reiter „Agenten". Ohne Browser: Attrappen für DOM,
// fetch, EventSource, Timer, localStorage, location und history wie in
// web-app-settings.test.ts. Hinter fetch laufen die echten createAgentsApi,
// createSettingsApi und createInstructionsApi mit dem Demo-Katalog im Speicher
// (createDemoAgents), nie config/*.json.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createAgentsApi } from "../src/web/agent-catalog";
import { createDemoAgents, createDemoInstructions, DEMO_GROUP_ID } from "../src/web/demo";
import { createInstructionsApi } from "../src/web/instructions";
import { createRevisionClock } from "../src/web/revision";
import { createSettingsApi } from "../src/web/settings";
import { TYBO_BRAND } from "./brand-fixture";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const settingsSource = await readFile(resolve(publicDir, "settings.js"), "utf8");
const appSource = await readFile(resolve(publicDir, "app.js"), "utf8");

interface Node {
  children: Node[];
  attributes: Record<string, string>;
  [key: string]: any;
}

/** Alle Zuweisungen an innerHTML, über alle Knoten */
let htmlWrites: string[] = [];

function node(tag = "div"): Node {
  const n: Node = {
    tagName: tag.toUpperCase(),
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
    contains() { return false; },
  };
  Object.defineProperty(n, "innerHTML", {
    set(v: string) { htmlWrites.push(v); },
    get() { return ""; },
  });
  return n;
}

/** Alle geöffneten Ströme, um Ereignisse von außen auszulösen */
let eventSources: FakeEventSource[] = [];

class FakeEventSource {
  listeners: Record<string, ((e: any) => void)[]> = {};
  constructor(public url: string) { eventSources.push(this); }
  addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); }
  close() {}
}

type Result = { status: number; body: any };
/** Anfrage zurückhalten: der Stand steht beim Absenden fest, die Antwort kommt erst nach release() */
interface Hold { method: string; path: string; release?: () => void; pending?: boolean }

interface Options {
  stored?: string;
  /** Chat-ID der Gruppe in GET /api/conversations; fehlt: die der Demo, null: keine */
  groupChatId?: string | null;
}

function setup(options: Options = {}) {
  htmlWrites = [];
  eventSources = [];
  const elements: Record<string, Node> = {};
  const document: Record<string, any> = {
    activeElement: null,
    getElementById(id: string) { return (elements[id] ??= node()); },
    createElement(tag: string) { return node(tag); },
    createDocumentFragment() { const f = node(); f.fragment = true; return f; },
  };
  const store: Record<string, string> = {};
  if (options.stored) store["tybo-last-conversation"] = options.stored;
  const windowListeners: Record<string, ((e: any) => void)[]> = {};
  const fire = (type: string) => { for (const fn of windowListeners[type] ?? []) fn({}); };
  const nav = { entries: [""], index: 0, backs: 0 };
  const location: Record<string, any> = {
    href: "/",
    pathname: "/",
    search: "",
    get hash() { return nav.entries[nav.index]; },
    set hash(value: string) {
      const next = value && !value.startsWith("#") ? "#" + value : value;
      if (next === nav.entries[nav.index]) return;
      nav.entries = nav.entries.slice(0, nav.index + 1).concat(next);
      nav.index++;
      fire("hashchange");
    },
  };
  const history = {
    replaceState(_s: unknown, _t: string, url: string) {
      nav.entries[nav.index] = url.includes("#") ? url.slice(url.indexOf("#")) : "";
    },
    back() {
      nav.backs++;
      if (nav.index === 0) return;
      nav.index--;
      fire("hashchange");
    },
  };
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
    location,
    history,
  };
  const timers = new Map<number, () => void>();
  let nextTimer = 1;
  const setTimeout = (fn: () => void) => { const id = nextTimer++; timers.set(id, fn); return id; };
  const clearTimeout = (id: number) => { timers.delete(id); };

  // Demo-Katalog, Einstellungen und Topics als eine Einheit im Speicher
  const demo = createDemoAgents({ seed: true });
  const instructionsPort = createDemoInstructions({});
  const server = {
    demo,
    boot: 1000,
    requests: [] as { method: string; path: string; body: any }[],
    holds: [] as Hold[],
    groupChatId: options.groupChatId,
    /** Antwort ersetzen: bekommt die echte Ausführung, liefert eine Antwort oder "offline" */
    respond: null as null | ((method: string, path: string, real: () => Promise<Result>) => Promise<Result | "offline"> | undefined),
    /** Bot neu gestartet: neue APIs mit späterem boot, Zähler beginnen neu */
    restartProcess() {
      server.boot += 1000;
      apis = createApis();
    },
  };
  const createApis = () => {
    const settings = createSettingsApi(demo.settings, () => {}, createRevisionClock(server.boot));
    return {
      settings,
      agents: createAgentsApi({ port: demo.catalog, settingsApi: settings, settingsPort: demo.settings, log: () => {}, clock: createRevisionClock(server.boot) }),
      instructions: createInstructionsApi(instructionsPort, { has: name => demo.catalog.isActive(name) }, () => {}, createRevisionClock(server.boot)),
    };
  };
  let apis = createApis();

  async function route(method: string, path: string, body: string): Promise<Result> {
    if (path === "/api/agents") return method === "POST" ? apis.agents.create(body) : apis.agents.list();
    const inst = path.match(/^\/api\/agents\/([^/]+)\/instructions(\/last)?$/);
    if (inst) return apis.instructions.handle(inst[1], !!inst[2], method, body);
    const admin = path.match(/^\/api\/agents\/([^/]+)(?:\/(prompt|restore|usage))?$/);
    if (admin) return apis.agents.handle(admin[1], admin[2], method, body);
    if (path === "/api/settings") return method === "PATCH" ? apis.settings.patch(body) : apis.settings.get();
    if (path === "/api/models") return { status: 200, body: { claude: { models: ["claude-opus-5-5", "claude-sonnet-5"], custom: true }, openrouter: { models: [] }, ollama: { models: [] } } };
    // Motor (Issue #126): hier nur Beiwerk, geprüft in web-app-settings.test.ts
    if (path === "/api/engines") return { status: 200, body: { default: { engine: "claude", source: "code" }, engines: [], overrides: [], availability: [] } };
    if (path === "/api/conversations" && method === "GET") {
      // Wie server.ts: Chat-ID der Forum-Gruppe neben den Topics
      const telegram = demo.topics.telegram;
      const chatId = server.groupChatId === undefined ? telegram.groupChatId?.() : server.groupChatId;
      const list = await telegram.listConversations();
      return { status: 200, body: { conversations: [], telegram: chatId ? { ...list, chatId } : list } };
    }
    if (path === "/api/telegram/rights") return { status: 200, body: { group: true, manageTopics: true, deleteMessages: true } };
    const messages = path.match(/^\/api\/conversations\/([^/]+)\/messages$/);
    if (messages) return { status: 200, body: { messages: [], hasMore: false, running: false } };
    return { status: 404, body: { error: "unbekannt" } };
  }

  const fetch = async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    const raw = init?.body ?? "";
    server.requests.push({ method, path, body: raw ? JSON.parse(raw) : undefined });
    const real = () => route(method, path, raw);
    let result: Result | "offline";
    const replaced = server.respond ? server.respond(method, path, real) : undefined;
    result = replaced ? await replaced : await real();
    const hold = server.holds.find(h => !h.pending && h.method === method && h.path === path);
    if (hold) {
      hold.pending = true;
      await new Promise<void>(r => { hold.release = r; });
    }
    if (result === "offline") throw new TypeError("offline");
    return Response.json(result.body, { status: result.status });
  };

  elements["chat-log"] = node();
  new Function("document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout", `${settingsSource}\n${appSource}`)(
    document, window, fetch, FakeEventSource, setTimeout, clearTimeout
  );

  const requests = (method: string, prefix = "") => server.requests.filter(r => r.method === method && r.path.startsWith(prefix));
  const all = (root: Node = elements["settings-panel"]): Node[] => [root, ...root.children.flatMap((c: Node) => all(c))];
  const byKey = (key: string) => all().find(n => n.attributes["data-focus-key"] === key);
  const byClass = (cls: string, root?: Node) => all(root).filter(n => String(n.className).split(" ").includes(cls));
  const texts = (cls: string, root?: Node) => byClass(cls, root).map(n => n.textContent);
  const click = (key: string) => {
    const b = byKey(key);
    if (!b) throw new Error(`Knopf ${key} fehlt`);
    b.dispatch("click");
  };
  const type = (key: string, value: string) => {
    const input = byKey(key);
    if (!input) throw new Error(`Feld ${key} fehlt`);
    input.value = value;
    input.dispatch("input");
  };
  const choose = (key: string, value: string) => {
    const s = byKey(key)!;
    s.value = value;
    s.dispatch("change");
  };
  /** Namen der Agentenzeilen in der Einstellungsliste */
  const agentRows = () => all().filter(n => String(n.attributes["data-focus-key"] || "").startsWith("agent:")).map(n => n.attributes["data-focus-key"].slice(6));
  const pickerAgents = () => elements["agent-options"].children.map((li: Node) => li.children[0].attributes["data-agent-option"]);
  const hold = (method: string, path: string) => {
    const h: Hold = { method, path };
    server.holds.push(h);
    return async () => {
      server.holds.splice(server.holds.indexOf(h), 1);
      h.release?.();
      await settle();
    };
  };
  return { server, elements, window, requests, all, byKey, byClass, texts, click, type, choose, agentRows, pickerAgents, hold, timers };
}

type App = ReturnType<typeof setup>;

async function settle() {
  for (let i = 0; i < 60; i++) await Bun.sleep(0);
}

async function openSettings(app: App) {
  app.elements["open-settings"].dispatch("click");
  await settle();
}

async function closeSettings(app: App) {
  app.elements["settings-back"].dispatch("click");
  await settle();
}

async function openAgent(app: App, name: string) {
  app.click(`agent:${name}`);
  await settle();
}

async function ready(options: Options = {}) {
  const app = setup(options);
  await settle();
  await openSettings(app);
  return app;
}

const promptView = (app: App, name: string) => app.byKey(`prompt-view:${name}`);
const badge = (app: App) => app.texts("settings-badge");

describe("System-Prompt (Checkbox 1)", () => {
  test("aufgeklappt: Prompt als Text in eigener Fläche, Kennzeichnung „Standard\", Hinweis auf die frische Session", async () => {
    const app = await ready();
    expect(app.agentRows()).toEqual(["general", "research", "content", "finance", "strategy", "critic", "cto", "coo"]);
    await openAgent(app, "research");
    expect(app.requests("GET", "/api/agents/research/prompt")).toHaveLength(1);
    const view = promptView(app, "research")!;
    expect(view.textContent).toContain("Du bist der Research-Agent von tybo.");
    expect(view.className).toBe("settings-prompt");
    expect(view.attributes["role"]).toBe("region");
    expect(view.attributes["tabindex"]).toBe("0");
    expect(badge(app)).toEqual(["Standard"]);
    expect(app.texts("actions-hint").some(t => t.startsWith("Gilt ab der nächsten frischen Session"))).toBe(true);
    // Mitgelieferter Agent mit Standard-Prompt: nichts zurückzusetzen
    expect(app.byKey("prompt-reset:research")).toBeUndefined();
    // Prompt steht oberhalb der Anweisungen
    const body = app.all().find(n => n.id === "settings-agent-research")!;
    const order = body.children.map((c: Node) => c.className);
    expect(order.indexOf("settings-section settings-prompt-section")).toBeLessThan(order.indexOf("settings-section"));
  });

  test("HTML-artiger Prompt erscheint als Text, nie über innerHTML", async () => {
    const app = setup();
    const html = '<img src=x onerror="alert(1)"><b>fett</b> & <script>x()</script>';
    await app.server.demo.catalog.setPrompt("research", html);
    await settle();
    await openSettings(app);
    await openAgent(app, "research");
    expect(promptView(app, "research")!.textContent).toBe(html);
    expect(badge(app)).toEqual(["Angepasst"]);
    app.click("prompt-edit:research");
    expect(app.byKey("prompt-text:research")!.value).toBe(html);
    expect(htmlWrites).toEqual([]);
  });

  test("Bearbeiten, Speichern sendet PUT; danach neuer Text, „Angepasst\" und „Gespeichert.\"", async () => {
    const app = await ready();
    await openAgent(app, "research");
    app.click("prompt-edit:research");
    const area = app.byKey("prompt-text:research")!;
    expect(area.tagName).toBe("TEXTAREA");
    expect(area.value).toContain("Research-Agent");
    app.type("prompt-text:research", "Du recherchierst gründlich.\r\nImmer mit Quelle.");
    expect(app.texts("settings-count")[0]).toBe("45 von 20.000 Zeichen");
    app.click("prompt-save:research");
    await settle();
    expect(app.requests("PUT")).toEqual([{ method: "PUT", path: "/api/agents/research/prompt", body: { text: "Du recherchierst gründlich.\nImmer mit Quelle." } }]);
    expect(app.byKey("prompt-text:research")).toBeUndefined();
    expect(promptView(app, "research")!.textContent).toBe("Du recherchierst gründlich.\nImmer mit Quelle.");
    expect(badge(app)).toEqual(["Angepasst"]);
    expect(app.texts("settings-status")).toContain("Gespeichert.");
    expect(app.server.demo.catalog.prompt("research")!.promptSource).toBe("custom");
  });

  test("Abbrechen verwirft den Entwurf ohne Anfrage", async () => {
    const app = await ready();
    await openAgent(app, "research");
    app.click("prompt-edit:research");
    app.type("prompt-text:research", "Entwurf");
    app.click("prompt-cancel:research");
    await settle();
    expect(app.requests("PUT")).toHaveLength(0);
    expect(promptView(app, "research")!.textContent).toContain("Research-Agent");
    app.click("prompt-edit:research");
    expect(app.byKey("prompt-text:research")!.value).toContain("Research-Agent");
  });

  test("Fehler (leer, 500, offline): Meldung, Entwurf bleibt, erneutes Speichern klappt", async () => {
    const app = await ready();
    await openAgent(app, "research");
    app.click("prompt-edit:research");
    app.type("prompt-text:research", "   ");
    app.click("prompt-save:research");
    await settle();
    expect(app.requests("PUT")).toHaveLength(0);
    expect(app.texts("actions-error")).toEqual(["System-Prompt darf nicht leer sein."]);

    app.type("prompt-text:research", "Mein Entwurf");
    for (const failure of [{ status: 500, body: { error: "Agenten-Katalog konnte nicht gespeichert werden" } }, "offline" as const]) {
      app.server.respond = (method, path) => (method === "PUT" ? Promise.resolve(failure) : undefined);
      app.click("prompt-save:research");
      await settle();
      expect(app.byKey("prompt-text:research")!.value).toBe("Mein Entwurf");
      expect(app.texts("actions-error")).toEqual([failure === "offline" ? "Server nicht erreichbar, nichts gespeichert." : "Agenten-Katalog konnte nicht gespeichert werden"]);
    }
    expect(app.server.demo.catalog.prompt("research")!.promptSource).toBe("code");
    app.server.respond = null;
    app.click("prompt-save:research");
    await settle();
    expect(promptView(app, "research")!.textContent).toBe("Mein Entwurf");
    expect(app.texts("actions-error")).toEqual([]);
  });

  test("Zurücksetzen nur bei angepassten mitgelieferten, erst nach Rückfrage; DELETE, danach „Standard\"", async () => {
    const app = setup();
    await app.server.demo.catalog.setPrompt("research", "Eigene Fassung");
    await settle();
    await openSettings(app);
    await openAgent(app, "research");
    app.click("prompt-reset:research");
    await settle();
    expect(app.requests("DELETE")).toHaveLength(0);
    expect(app.texts("actions-question")).toEqual(["System-Prompt von Research auf den Standard zurücksetzen?"]);
    app.click("prompt-reset-no:research");
    expect(app.texts("actions-question")).toEqual([]);
    expect(app.requests("DELETE")).toHaveLength(0);

    app.click("prompt-reset:research");
    app.click("prompt-reset-yes:research");
    await settle();
    expect(app.requests("DELETE")).toEqual([{ method: "DELETE", path: "/api/agents/research/prompt", body: undefined }]);
    expect(promptView(app, "research")!.textContent).toContain("Research-Agent");
    expect(badge(app)).toEqual(["Standard"]);
    expect(app.byKey("prompt-reset:research")).toBeUndefined();
  });

  test("eigener Agent: Kennzeichnung „Eigener Agent\", kein Zurücksetzen", async () => {
    const app = setup();
    await app.server.demo.catalog.create({ name: "planer", description: "Plant", systemPrompt: "Du planst." });
    await settle();
    await openSettings(app);
    await openAgent(app, "planer");
    expect(badge(app)).toEqual(["Eigener Agent"]);
    expect(app.byKey("prompt-edit:planer")).toBeDefined();
    expect(app.byKey("prompt-reset:planer")).toBeUndefined();
  });

  test("veraltete GET-Antwort überschreibt den gespeicherten Prompt nicht", async () => {
    const app = await ready();
    await openAgent(app, "research");
    // Wiederöffnen lädt den Prompt neu; diese Antwort (alter Stand) wird zurückgehalten
    await closeSettings(app);
    const release = app.hold("GET", "/api/agents/research/prompt");
    await openSettings(app);
    app.click("prompt-edit:research");
    app.type("prompt-text:research", "Neu");
    app.click("prompt-save:research");
    await settle();
    expect(promptView(app, "research")!.textContent).toBe("Neu");
    await release();
    expect(promptView(app, "research")!.textContent).toBe("Neu");
    expect(badge(app)).toEqual(["Angepasst"]);
  });

  test("Entwurf bleibt beim Schließen und Wiederöffnen, auch wenn sich der Prompt auf dem Server ändert", async () => {
    const app = await ready();
    await openAgent(app, "research");
    app.click("prompt-edit:research");
    app.type("prompt-text:research", "Halb fertig");
    await closeSettings(app);
    await app.server.demo.catalog.setPrompt("research", "Anderswo geändert");
    await openSettings(app);
    expect(app.byKey("prompt-text:research")!.value).toBe("Halb fertig");
    expect(badge(app)).toEqual(["Angepasst"]);
  });

  test("Prozesswechsel: Stand eines späteren Prozesses gilt, auch mit kleinerer Nummer", async () => {
    const app = setup();
    // Viele Stände im ersten Prozess, damit seq dort höher ist
    for (let i = 0; i < 5; i++) await app.server.demo.catalog.setPrompt("research", `Stand ${i}`);
    await settle();
    await openSettings(app);
    await openAgent(app, "research");
    for (let i = 0; i < 4; i++) {
      app.click("prompt-edit:research");
      app.type("prompt-text:research", `Browser ${i}`);
      app.click("prompt-save:research");
      await settle();
    }
    await closeSettings(app);
    app.server.restartProcess();
    await app.server.demo.catalog.setPrompt("research", "Nach dem Neustart");
    await openSettings(app);
    expect(promptView(app, "research")!.textContent).toBe("Nach dem Neustart");
  });
});

/** Formular „Neuer Agent" ausfüllen */
function fillCreate(app: App, values: { name?: string; description?: string; prompt?: string }) {
  if (values.name !== undefined) app.type("create-name", values.name);
  if (values.description !== undefined) app.type("create-description", values.description);
  if (values.prompt !== undefined) app.type("create-prompt", values.prompt);
}

describe("Neuer Agent (Checkbox 2)", () => {
  test("Erfolg: POST mit Modell und Effort; erscheint in der Liste, bei „Neues Gespräch\" und in „Agent ändern …\"", async () => {
    const app = await ready({ stored: "topic-443" });
    expect(app.byKey("create-name")).toBeUndefined();
    app.click("create-open");
    fillCreate(app, { name: "projekt-planer", description: "  Plant Projekte  ", prompt: "Du planst <b>Projekte</b>." });
    app.choose("create-model", "claude-sonnet-5");
    app.choose("create-effort", "low");
    app.click("create-submit");
    await settle();
    expect(app.requests("POST", "/api/agents")).toEqual([{
      method: "POST",
      path: "/api/agents",
      body: { name: "projekt-planer", description: "Plant Projekte", systemPrompt: "Du planst <b>Projekte</b>.", model: "claude-sonnet-5", effort: "low" },
    }]);
    expect(app.byKey("create-name")).toBeUndefined();
    expect(app.agentRows().at(-1)).toBe("projekt-planer");
    expect(app.texts("settings-agent-notice")[0]).toContain("„Projekt Planer“ angelegt");
    // Aufgeklappt mit Prompt als Text, Modell aus den Einstellungen
    expect(promptView(app, "projekt-planer")!.textContent).toBe("Du planst <b>Projekte</b>.");
    expect(app.server.demo.settings.data().agents!["projekt-planer"]).toEqual({ model: "claude-sonnet-5", effort: "low" });
    expect(app.all().find(n => n.id === "settings-model-projekt-planer")!.value).toBe("claude-sonnet-5");
    expect(htmlWrites).toEqual([]);

    // Ohne Neuladen: Auswahl für neue Gespräche und Topic-Zuordnung kennen ihn
    await closeSettings(app);
    const before = app.requests("GET", "/api/agents").length;
    const release = app.hold("GET", "/api/agents");
    app.elements["new-chat"].dispatch("click");
    // Das Öffnen fragt neu; schon vorher steht der neue Agent da
    expect(app.requests("GET", "/api/agents").length).toBe(before + 1);
    expect(app.pickerAgents()).toContain("projekt-planer");
    await release();
    app.elements["new-chat"].dispatch("click");
    app.elements["conversation-menu"].dispatch("click");
    await settle();
    const panel = app.elements["conversation-actions"].children[0];
    panel.children.find((b: Node) => b.textContent === "Agent ändern …")!.dispatch("click");
    const choices = app.elements["conversation-actions"].children[0].children.filter((c: Node) => c.attributes["data-agent-choice"]);
    expect(choices.map((c: Node) => c.attributes["data-agent-choice"])).toContain("projekt-planer");
  });

  test("Feldfehler vor dem Senden stehen am Feld; Eingaben bleiben", async () => {
    const app = await ready();
    app.click("create-open");
    fillCreate(app, { name: "X", description: "", prompt: "  " });
    app.click("create-submit");
    await settle();
    expect(app.requests("POST", "/api/agents")).toHaveLength(0);
    const error = (key: string) => app.all().find(n => n.id === `settings-create-${key}-error`)?.textContent;
    expect(error("name")).toContain("Kennung: a-z");
    expect(error("description")).toContain("Beschreibung: eine Zeile");
    expect(error("prompt")).toBe("System-Prompt darf nicht leer sein.");
    expect(app.byKey("create-name")!.attributes["aria-invalid"]).toBe("true");
    expect(app.byKey("create-name")!.attributes["aria-describedby"]).toContain("settings-create-name-error");
    expect(app.byKey("create-name")!.value).toBe("X");
    // Tippen im Feld nimmt seinen Fehler weg, die anderen bleiben
    app.type("create-name", "gut-name");
    expect(error("name")).toBeUndefined();
    expect(error("prompt")).toBeDefined();
    // Eigenes Modell ohne Namen
    app.choose("create-model", " eigenes");
    fillCreate(app, { description: "Eine Zeile", prompt: "Prompt" });
    app.click("create-submit");
    await settle();
    expect(error("model")).toBe("Bitte einen Modellnamen eingeben.");
    expect(app.requests("POST", "/api/agents")).toHaveLength(0);
  });

  test("Kollision: Server-Fehler 409 steht an der Kennung, Formular bleibt offen", async () => {
    const app = await ready();
    app.click("create-open");
    fillCreate(app, { name: "cfo", description: "Zahlen", prompt: "Du rechnest." });
    app.click("create-submit");
    await settle();
    expect(app.requests("POST", "/api/agents")).toHaveLength(1);
    expect(app.all().find(n => n.id === "settings-create-name-error")!.textContent).toContain("schon vergeben");
    expect(app.byKey("create-prompt")!.value).toBe("Du rechnest.");
    expect(app.agentRows()).not.toContain("cfo");
    // Offline: allgemeiner Fehler, nichts verloren
    app.type("create-name", "rechner");
    app.server.respond = (method, path) => (method === "POST" && path === "/api/agents" ? Promise.resolve("offline" as const) : undefined);
    app.click("create-submit");
    await settle();
    expect(app.texts("actions-error")).toContain("Server nicht erreichbar, nichts gespeichert.");
    expect(app.byKey("create-name")!.value).toBe("rechner");
  });

  test("Teilerfolg 201 mit settingsSaved false: Agent übernommen, Warnung, keine Wiederholung", async () => {
    const app = await ready();
    app.server.respond = (method, path, real) => {
      if (method !== "POST" || path !== "/api/agents") return undefined;
      return real().then(r => ({ status: r.status, body: { ...r.body, settingsSaved: false, warning: "Agent angelegt, aber Modell und Effort nicht gespeichert. Bitte in den Einstellungen nachtragen." } }));
    };
    app.click("create-open");
    fillCreate(app, { name: "teil", description: "Halb", prompt: "Du bist halb." });
    app.choose("create-effort", "low");
    app.click("create-submit");
    await settle();
    expect(app.requests("POST", "/api/agents")).toHaveLength(1);
    expect(app.agentRows()).toContain("teil");
    const notice = app.byClass("settings-agent-notice")[0];
    expect(notice.attributes["role"]).toBe("alert");
    expect(notice.textContent).toContain("Modell und Effort nicht gespeichert");
  });
});

describe("Löschen und Wiederherstellen (Checkbox 3)", () => {
  test("General hat weder Löschknopf noch Board-Schalter", async () => {
    const app = await ready();
    await openAgent(app, "general");
    expect(app.byKey("delete:general")).toBeUndefined();
    expect(app.byKey("board:general:on")).toBeUndefined();
    expect(app.texts("actions-hint")).toContain("General leitet /board und nimmt nicht selbst teil.");
  });

  test("Rückfrage nennt die Topics und verlangt die Kennung; danach Liste, Seitenleiste, Chip und Auswahl ohne Neuladen aktuell", async () => {
    const app = await ready({ stored: "topic-443" });
    expect(app.elements["agent-name"].textContent).toBe("Research");
    await openAgent(app, "research");
    app.click("delete:research");
    await settle();
    expect(app.requests("GET", "/api/agents/research/usage")).toHaveLength(1);
    expect(app.texts("actions-question")).toEqual(["„Research“ löschen?"]);
    const affected = app.byClass("settings-affected")[0];
    expect(affected.children.map((li: Node) => li.textContent)).toEqual(["„Recherche“ (Topic 443)"]);
    expect(app.texts("actions-hint")).toContain("Dieses Topic wechselt zu General:");
    // Ohne passende Kennung: kein DELETE
    expect(app.byKey("delete-yes:research")!.disabled).toBe(true);
    app.type("delete-input:research", "Research");
    expect(app.byKey("delete-yes:research")!.disabled).toBe(true);
    app.byKey("delete-input:research")!.dispatch("keydown", { key: "Enter", preventDefault() {} });
    app.click("delete-yes:research");
    await settle();
    expect(app.requests("DELETE")).toHaveLength(0);

    app.type("delete-input:research", "research");
    expect(app.byKey("delete-yes:research")!.disabled).toBe(false);
    const conversationsBefore = app.requests("GET", "/api/conversations").filter(r => r.path === "/api/conversations").length;
    app.click("delete-yes:research");
    await settle();
    expect(app.requests("DELETE")).toEqual([{ method: "DELETE", path: "/api/agents/research", body: { confirm: "research" } }]);
    expect(app.agentRows()).not.toContain("research");
    expect(app.texts("settings-agent-notice")).toEqual(["„Research“ gelöscht. Ein Topic nutzt jetzt General."]);
    // Gelöschte Agenten mit Wiederherstellen
    expect(app.byKey("restore:research")).toBeDefined();
    // Seitenleiste neu geholt: das Topic nutzt jetzt General, der Chip ebenso
    expect(app.requests("GET", "/api/conversations").filter(r => r.path === "/api/conversations").length).toBe(conversationsBefore + 1);
    expect(app.elements["agent-name"].textContent).toBe("General");
    await closeSettings(app);
    const release = app.hold("GET", "/api/agents");
    app.elements["new-chat"].dispatch("click");
    expect(app.pickerAgents()).not.toContain("research");
    await release();
  });

  test("ohne lesbare Topic-Zuordnung keine Rückfrage, sondern Fehler mit „Erneut prüfen\"", async () => {
    const app = await ready();
    await openAgent(app, "finance");
    app.server.respond = (method, path) =>
      path === "/api/agents/finance/usage" ? Promise.resolve({ status: 409, body: { error: "config/topics.json ist nicht lesbar oder ungültig. Nichts gelöscht." } }) : undefined;
    app.click("delete:finance");
    await settle();
    expect(app.texts("actions-error")).toEqual(["config/topics.json ist nicht lesbar oder ungültig. Nichts gelöscht."]);
    expect(app.byKey("delete-input:finance")).toBeUndefined();
    app.server.respond = null;
    app.click("delete-retry:finance");
    await settle();
    expect(app.byClass("settings-affected")[0].children.map((li: Node) => li.textContent)).toEqual(["„Finanzen“ (Topic 12)"]);
    // „*" und mehrere Chats werden genannt; einen Namen gibt es nur für die Gruppe der Seitenleiste
    app.server.respond = (method, path) =>
      path === "/api/agents/finance/usage"
        ? Promise.resolve({ status: 200, body: { name: "finance", topics: [{ chatId: "*", topicId: 9 }, { chatId: "-1", topicId: 12 }, { chatId: DEMO_GROUP_ID, topicId: 12 }] } })
        : undefined;
    app.click("delete-no:finance");
    app.click("delete:finance");
    await settle();
    expect(app.byClass("settings-affected")[0].children.map((li: Node) => li.textContent)).toEqual([
      "Topic 9, in allen Chats",
      "Topic 12, Chat -1",
      `„Finanzen“ (Topic 12), Chat ${DEMO_GROUP_ID}`,
    ]);
  });

  /** Löschvorschau für research mit diesen Topics öffnen, Texte der Liste */
  async function affectedFor(app: App, topics: { chatId: string; topicId: number }[]) {
    await openAgent(app, "research");
    app.server.respond = (method, path) =>
      path === "/api/agents/research/usage" ? Promise.resolve({ status: 200, body: { name: "research", topics } }) : undefined;
    app.click("delete:research");
    await settle();
    return app.byClass("settings-affected")[0].children.map((li: Node) => li.textContent);
  }

  test("gleiche Topic-Nummer in verschiedenen Chats: Name nur beim Topic der eigenen Gruppe", async () => {
    const app = await ready();
    expect(await affectedFor(app, [{ chatId: "-999999", topicId: 443 }, { chatId: DEMO_GROUP_ID, topicId: 443 }])).toEqual([
      "Topic 443, Chat -999999",
      `„Recherche“ (Topic 443), Chat ${DEMO_GROUP_ID}`,
    ]);
  });

  test("ein einzelner fremder Chat: kein Name aus der Seitenleiste, Chat-ID und Topic-Nummer stehen da", async () => {
    const app = await ready();
    expect(await affectedFor(app, [{ chatId: "-999999", topicId: 443 }])).toEqual(["Topic 443, Chat -999999"]);
    expect(app.texts("actions-hint")).toContain("Dieses Topic wechselt zu General:");
  });

  test("Chat-ID der Gruppe unbekannt: kein Name, auch nicht bei gleicher Topic-Nummer", async () => {
    const app = await ready({ groupChatId: null });
    expect(await affectedFor(app, [{ chatId: DEMO_GROUP_ID, topicId: 443 }])).toEqual([`Topic 443, Chat ${DEMO_GROUP_ID}`]);
  });

  test("Teilerfolg: HTTP 500 mit removed und topicsMoved false übernimmt den Bestand, warnt, wiederholt nicht", async () => {
    const app = await ready();
    await openAgent(app, "finance");
    app.server.respond = (method, path, real) => {
      if (method !== "DELETE" || path !== "/api/agents/finance") return undefined;
      return real().then(r => ({ status: 500, body: { ...r.body, error: "Agent gelöscht, aber seine Topics konnten nicht auf General umgestellt werden.", topicsMoved: false, moved: [] } }));
    };
    app.click("delete:finance");
    await settle();
    app.type("delete-input:finance", "finance");
    app.click("delete-yes:finance");
    await settle();
    expect(app.requests("DELETE")).toHaveLength(1);
    expect(app.agentRows()).not.toContain("finance");
    const notice = app.byClass("settings-agent-notice")[0];
    expect(notice.attributes["role"]).toBe("alert");
    expect(notice.textContent).toContain("nicht auf General umgestellt");
  });

  test("Wiederherstellen bringt den mitgelieferten Agenten zurück, auch in die Auswahl", async () => {
    const app = setup();
    await app.server.demo.catalog.delete("critic");
    await settle();
    await openSettings(app);
    expect(app.agentRows()).not.toContain("critic");
    expect(app.texts("settings-label")).toContain("Gelöschte Agenten");
    app.click("restore:critic");
    await settle();
    expect(app.requests("POST", "/api/agents/critic/restore")).toHaveLength(1);
    expect(app.agentRows()).toContain("critic");
    expect(app.byKey("restore:critic")).toBeUndefined();
    expect(app.texts("settings-agent-notice")[0]).toContain("„Critic“ ist wieder da");
    await closeSettings(app);
    const release = app.hold("GET", "/api/agents");
    app.elements["new-chat"].dispatch("click");
    expect(app.pickerAgents()).toContain("critic");
    await release();
  });

  test("eigener Agent: nach dem Löschen endgültig weg, nicht unter „Gelöschte Agenten\"", async () => {
    const app = setup();
    await app.server.demo.catalog.create({ name: "planer", description: "Plant", systemPrompt: "Du planst." });
    await settle();
    await openSettings(app);
    await openAgent(app, "planer");
    app.click("delete:planer");
    await settle();
    expect(app.texts("actions-hint")).toContain("Kein Topic nutzt diesen Agenten.");
    expect(app.texts("actions-hint")).toContain("Ein eigener Agent ist danach endgültig weg, auch sein System-Prompt.");
    app.type("delete-input:planer", "planer");
    app.click("delete-yes:planer");
    await settle();
    expect(app.agentRows()).not.toContain("planer");
    expect(app.byKey("restore:planer")).toBeUndefined();
  });

  test("veraltete Liste nach dem Löschen bringt den Agenten nicht zurück (Seite und Auswahl)", async () => {
    const app = await ready();
    await closeSettings(app);
    // Wiederöffnen fragt den Katalog; diese Antwort (mit Research) kommt erst nach dem Löschen
    const releaseSettings = app.hold("GET", "/api/agents");
    await openSettings(app);
    await openAgent(app, "research");
    app.click("delete:research");
    await settle();
    app.type("delete-input:research", "research");
    app.click("delete-yes:research");
    await settle();
    expect(app.agentRows()).not.toContain("research");
    await releaseSettings();
    expect(app.agentRows()).not.toContain("research");
    await closeSettings(app);
    const release = app.hold("GET", "/api/agents");
    app.elements["new-chat"].dispatch("click");
    expect(app.pickerAgents()).not.toContain("research");
    await release();
  });

  test("veraltete Gesprächsliste nach dem Löschen setzt Seitenleiste und Chip nicht auf den Agenten zurück", async () => {
    const app = await ready({ stored: "topic-443" });
    expect(app.elements["agent-name"].textContent).toBe("Research");
    // Topic-Ereignis holt die Liste; diese Antwort (noch mit Research) hängt
    const releaseOld = app.hold("GET", "/api/conversations");
    const activity = eventSources.find(s => s.url === "/api/telegram/events")!;
    for (const fn of activity.listeners.topic ?? []) fn({ data: JSON.stringify({ id: "topic-443" }) });
    await settle();
    await openAgent(app, "research");
    app.click("delete:research");
    await settle();
    app.type("delete-input:research", "research");
    app.click("delete-yes:research");
    await settle();
    const sidebarAgent = () => app.all(app.elements["topic-list"])
      .filter(n => n.attributes["data-agent"] !== undefined)
      .map(n => n.attributes["data-agent"]);
    expect(app.elements["agent-name"].textContent).toBe("General");
    expect(sidebarAgent()).not.toContain("research");
    await releaseOld();
    expect(app.elements["agent-name"].textContent).toBe("General");
    expect(app.elements["agent-name"].getAttribute("data-agent")).toBe("general");
    expect(sidebarAgent()).not.toContain("research");
    expect(sidebarAgent()).toContain("general");
  });

  test("Auswahl für neue Gespräche: eine ältere Antwort auf ihr eigenes Laden ersetzt den Stand nach dem Löschen nicht", async () => {
    const app = setup();
    await settle();
    // Auswahl öffnen: ihre Abfrage (noch mit Research) hängt
    const releasePicker = app.hold("GET", "/api/agents");
    app.elements["new-chat"].dispatch("click");
    await settle();
    await openSettings(app);
    await openAgent(app, "research");
    app.click("delete:research");
    await settle();
    app.type("delete-input:research", "research");
    app.click("delete-yes:research");
    await settle();
    await closeSettings(app);
    await releasePicker();
    const release = app.hold("GET", "/api/agents");
    app.elements["new-chat"].dispatch("click");
    expect(app.pickerAgents()).not.toContain("research");
    await release();
  });

  test("Löschen und Wiederanlegen derselben Kennung: alter Prompt kommt nicht zurück", async () => {
    const app = setup();
    await app.server.demo.catalog.create({ name: "planer", description: "Plant", systemPrompt: "Alte Fassung" });
    await settle();
    await openSettings(app);
    await openAgent(app, "planer");
    await closeSettings(app);
    const releaseOld = app.hold("GET", "/api/agents/planer/prompt");
    await openSettings(app);
    // Anfrage mit alter Fassung unterwegs; jetzt löschen und neu anlegen
    app.click("delete:planer");
    await settle();
    app.type("delete-input:planer", "planer");
    app.click("delete-yes:planer");
    await settle();
    app.click("create-open");
    fillCreate(app, { name: "planer", description: "Neu", prompt: "Neue Fassung" });
    app.click("create-submit");
    await settle();
    expect(promptView(app, "planer")!.textContent).toBe("Neue Fassung");
    await releaseOld();
    expect(promptView(app, "planer")!.textContent).toBe("Neue Fassung");
  });
});

describe("Board-Schalter (Checkbox 4)", () => {
  test("„Aus\" sendet PATCH { board: false }; bleibt nach Schließen und Wiederöffnen", async () => {
    const app = await ready();
    await openAgent(app, "research");
    expect(app.byKey("board:research:on")!.attributes["aria-checked"]).toBe("true");
    expect(app.byKey("board:research:off")!.attributes["aria-checked"]).toBe("false");
    app.click("board:research:off");
    await settle();
    expect(app.requests("PATCH", "/api/agents")).toEqual([{ method: "PATCH", path: "/api/agents/research", body: { board: false } }]);
    expect(app.byKey("board:research:off")!.attributes["aria-checked"]).toBe("true");
    expect(app.texts("settings-status")).toContain("Gespeichert.");
    expect(app.server.demo.catalog.list().find(a => a.name === "research")!.board).toBe(false);
    // Gleicher Wert: keine Anfrage
    app.click("board:research:off");
    await settle();
    expect(app.requests("PATCH", "/api/agents")).toHaveLength(1);
    await closeSettings(app);
    await openSettings(app);
    expect(app.byKey("board:research:off")!.attributes["aria-checked"]).toBe("true");
  });

  test("Fehler: Meldung, der Schalter zeigt wieder den gespeicherten Wert", async () => {
    const app = await ready();
    await openAgent(app, "content");
    app.server.respond = (method, path) => (method === "PATCH" && path === "/api/agents/content" ? Promise.resolve({ status: 500, body: { error: "Agenten-Katalog konnte nicht gespeichert werden" } }) : undefined);
    app.click("board:content:off");
    await settle();
    expect(app.texts("actions-error")).toEqual(["Agenten-Katalog konnte nicht gespeichert werden"]);
    expect(app.byKey("board:content:on")!.attributes["aria-checked"]).toBe("true");
  });
});

/**
 * Verspätete Schreibantworten: der Server hat geschrieben, die Antwort kommt
 * aber erst, nachdem der Browser einen neueren Stand übernommen hat (Wiederöffnen
 * lädt Katalog und Prompt). Die alte Antwort darf ihn nicht überschreiben, und
 * ein inzwischen begonnener Entwurf bleibt stehen.
 */
describe("verspätete Schreibantworten", () => {
  async function reopen(app: App) {
    await closeSettings(app);
    await openSettings(app);
  }

  test("Prompt-PUT: neuerer Stand von anderswo bleibt, nicht die eigene alte Fassung", async () => {
    const app = await ready();
    await openAgent(app, "research");
    app.click("prompt-edit:research");
    app.type("prompt-text:research", "Meine Fassung");
    const release = app.hold("PUT", "/api/agents/research/prompt");
    app.click("prompt-save:research");
    await settle();
    expect(app.server.demo.catalog.prompt("research")!.systemPrompt).toBe("Meine Fassung");
    // Danach anderswo geändert, der Browser übernimmt das beim Wiederöffnen
    await app.server.demo.catalog.setPrompt("research", "Anderswo neuer");
    await reopen(app);
    await release();
    expect(app.byKey("prompt-text:research")).toBeUndefined();
    expect(promptView(app, "research")!.textContent).toBe("Anderswo neuer");
    expect(badge(app)).toEqual(["Angepasst"]);
  });

  test("Prompt-DELETE: Standard aus der alten Antwort ersetzt weder neueren Prompt noch neuen Entwurf", async () => {
    const app = setup();
    await app.server.demo.catalog.setPrompt("research", "Eigene Fassung");
    await settle();
    await openSettings(app);
    await openAgent(app, "research");
    app.click("prompt-reset:research");
    const release = app.hold("DELETE", "/api/agents/research/prompt");
    app.click("prompt-reset-yes:research");
    await settle();
    expect(app.server.demo.catalog.prompt("research")!.promptSource).toBe("code");
    await app.server.demo.catalog.setPrompt("research", "Anderswo neuer");
    await reopen(app);
    expect(promptView(app, "research")!.textContent).toBe("Anderswo neuer");
    // Während die alte Antwort noch unterwegs ist: neuer Entwurf
    app.click("prompt-edit:research");
    app.type("prompt-text:research", "Mein Entwurf");
    await release();
    expect(app.byKey("prompt-text:research")!.value).toBe("Mein Entwurf");
    app.click("prompt-cancel:research");
    expect(promptView(app, "research")!.textContent).toBe("Anderswo neuer");
    expect(badge(app)).toEqual(["Angepasst"]);
  });

  test("Prompt-PUT über einen Prozesswechsel: Antwort des alten Prozesses gilt nicht, auch mit höherer Nummer", async () => {
    const app = await ready();
    await openAgent(app, "research");
    // Mehrere Stände im alten Prozess, damit seq dort höher ist als nach dem Neustart
    for (let i = 0; i < 3; i++) {
      app.click("prompt-edit:research");
      app.type("prompt-text:research", `Browser ${i}`);
      app.click("prompt-save:research");
      await settle();
    }
    app.click("prompt-edit:research");
    app.type("prompt-text:research", "Letzte alte Fassung");
    const release = app.hold("PUT", "/api/agents/research/prompt");
    app.click("prompt-save:research");
    await settle();
    app.server.restartProcess();
    await app.server.demo.catalog.setPrompt("research", "Nach dem Neustart");
    await reopen(app);
    await release();
    expect(promptView(app, "research")!.textContent).toBe("Nach dem Neustart");
  });

  test("Prompt-PUT nach Löschen und Wiederanlegen derselben Kennung: der neue Agent behält seinen Prompt", async () => {
    const app = setup();
    await app.server.demo.catalog.create({ name: "planer", description: "Plant", systemPrompt: "Alte Fassung" });
    await settle();
    await openSettings(app);
    await openAgent(app, "planer");
    app.click("prompt-edit:planer");
    app.type("prompt-text:planer", "Browser-Fassung");
    const release = app.hold("PUT", "/api/agents/planer/prompt");
    app.click("prompt-save:planer");
    await settle();
    await app.server.demo.catalog.delete("planer");
    await app.server.demo.catalog.create({ name: "planer", description: "Neu", systemPrompt: "Neue Fassung" });
    await reopen(app);
    await release();
    expect(app.byKey("prompt-text:planer")).toBeUndefined();
    expect(promptView(app, "planer")!.textContent).toBe("Neue Fassung");
  });

  test("Katalog-PATCH (Board): neuerer Katalog bleibt, Entwürfe für neuen Agenten und Prompt bleiben", async () => {
    const app = await ready();
    await openAgent(app, "research");
    const release = app.hold("PATCH", "/api/agents/research");
    app.click("board:research:off");
    await settle();
    // Anderswo angelegt; der Browser kennt ihn nach dem Wiederöffnen
    await app.server.demo.catalog.create({ name: "planer", description: "Plant", systemPrompt: "Du planst." });
    await reopen(app);
    expect(app.agentRows()).toContain("planer");
    app.click("create-open");
    fillCreate(app, { name: "entwurf", description: "Halb fertig" });
    app.click("prompt-edit:research");
    app.type("prompt-text:research", "Prompt-Entwurf");
    await release();
    expect(app.agentRows()).toContain("planer");
    expect(app.byKey("board:research:off")!.attributes["aria-checked"]).toBe("true");
    expect(app.byKey("create-name")!.value).toBe("entwurf");
    expect(app.byKey("create-description")!.value).toBe("Halb fertig");
    expect(app.byKey("prompt-text:research")!.value).toBe("Prompt-Entwurf");
  });

  test("Katalog-PATCH über einen Prozesswechsel: Antwort des alten Prozesses gilt nicht", async () => {
    const app = await ready();
    await openAgent(app, "research");
    // Mehrere Katalogstände im alten Prozess
    app.click("board:research:off");
    await settle();
    app.click("board:research:on");
    await settle();
    const release = app.hold("PATCH", "/api/agents/research");
    app.click("board:research:off");
    await settle();
    app.server.restartProcess();
    await app.server.demo.catalog.create({ name: "planer", description: "Plant", systemPrompt: "Du planst." });
    await reopen(app);
    expect(app.agentRows()).toContain("planer");
    await release();
    expect(app.agentRows()).toContain("planer");
    expect(app.byKey("board:research:off")!.attributes["aria-checked"]).toBe("true");
  });

  test("Katalog-DELETE, danach dieselbe Kennung neu angelegt: die alte Antwort entfernt den neuen Agenten nicht", async () => {
    const app = setup();
    await app.server.demo.catalog.create({ name: "planer", description: "Plant", systemPrompt: "Alte Fassung" });
    await settle();
    await openSettings(app);
    await openAgent(app, "planer");
    app.click("delete:planer");
    await settle();
    app.type("delete-input:planer", "planer");
    const release = app.hold("DELETE", "/api/agents/planer");
    app.click("delete-yes:planer");
    await settle();
    await app.server.demo.catalog.create({ name: "planer", description: "Neu", systemPrompt: "Neue Fassung" });
    await reopen(app);
    expect(app.agentRows()).toContain("planer");
    await release();
    expect(app.agentRows()).toContain("planer");
    await openAgent(app, "planer");
    expect(promptView(app, "planer")!.textContent).toBe("Neue Fassung");
    await closeSettings(app);
    const releasePicker = app.hold("GET", "/api/agents");
    app.elements["new-chat"].dispatch("click");
    expect(app.pickerAgents()).toContain("planer");
    await releasePicker();
  });
});
