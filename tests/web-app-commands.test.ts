// Befehlsliste beim Tippen von / und Befehls-Rückmeldungen (app.js, Issue #77)
// ohne Browser: Attrappen für DOM, fetch, EventSource, Timer und localStorage
// wie in web-app-goal.test.ts. Tasten laufen erst an die Eingabe und dann,
// wenn niemand stopPropagation ruft, an das Fenster (wie das Bubbling im Browser).
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TYBO_BRAND } from "./brand-fixture";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const source = await readFile(resolve(publicDir, "app.js"), "utf8");
const html = await readFile(resolve(publicDir, "index.html"), "utf8");
const css = await readFile(resolve(publicDir, "style.css"), "utf8");

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
    innerHTMLWrites: [] as string[],
    set innerHTML(v: string) { this.innerHTMLWrites.push(v); },
    appendChild(child: Node) { this.children.push(child); return child; },
    replaceChildren(...list: Node[]) {
      this.children = list.flatMap(c => (c.fragment ? c.children : [c]));
    },
    setAttribute(name: string, value: string) { this.attributes[name] = String(value); },
    getAttribute(name: string) { return this.attributes[name]; },
    removeAttribute(name: string) { delete this.attributes[name]; },
    listeners: {} as Record<string, ((e: any) => void)[]>,
    addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); },
    dispatch(type: string, event: any = {}) { for (const fn of this.listeners[type] ?? []) fn(event); },
    focus() {},
    scrolledIntoView: 0,
    scrollIntoView() { this.scrolledIntoView++; },
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

const COMMANDS = [
  { name: "board", aliases: [], description: "Board-Sitzung: alle Board-Agenten nacheinander", args: "optional", argsHint: "[thema]" },
  { name: "new", aliases: ["reset"], description: "Gespräch frisch starten, der Verlauf bleibt", args: "none" },
  { name: "help", aliases: ["hilfe"], description: "Spickzettel aller Befehle", args: "none" },
  { name: "stop", aliases: ["abbruch"], description: "Laufende Antwort abbrechen", args: "none" },
  { name: "goal", aliases: [], description: "Stehendes Ziel für dieses Topic", args: "optional", argsHint: "<text>|pause|stop" },
];

interface Options {
  commands?: { status: number; data: unknown } | "offline";
  history?: any[];
  touch?: boolean;
  /** Reines Web-Gespräch statt Topic 8 öffnen (Issue #112) */
  web?: boolean;
}

const WEB = "33333333-3333-4333-8333-333333333333";

function setup(options: Options = {}) {
  FakeEventSource.all = [];
  const elements: Record<string, Node> = {};
  const document = {
    activeElement: null as Node | null,
    getElementById(id: string) { return (elements[id] ??= node()); },
    createElement() { return node(); },
    createDocumentFragment() { const f = node(); f.fragment = true; return f; },
  };
  const store: Record<string, string> = { "tybo-last-conversation": options.web ? WEB : "topic-8" };
  const windowListeners: Record<string, ((e: any) => void)[]> = {};
  const window: Record<string, any> = {
    TYBO_BRAND,
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
    },
    matchMedia: (query: string) => ({ matches: !!options.touch && query.includes("pointer: coarse") }),
    getComputedStyle: () => ({ lineHeight: "22", paddingTop: "0", paddingBottom: "0", borderTopWidth: "0", borderBottomWidth: "0" }),
    addEventListener(type: string, fn: (e: any) => void) { (windowListeners[type] ??= []).push(fn); },
    location: { href: "/" },
  };
  const setTimeout = () => 0;
  const clearTimeout = () => {};

  const server = {
    commands: options.commands ?? { status: 200, data: { commands: COMMANDS } },
    calls: [] as string[],
    posts: [] as any[],
    postReply: null as null | { status: number; data: unknown },
    /** Solange gesetzt, wartet GET /api/commands auf dieses Promise */
    commandsGate: null as null | Promise<void>,
  };
  let counter = 0;
  const fetch = async (path: string, init?: { method?: string; body?: string }) => {
    // Anwesenheit (Issue #226) läuft nebenher und zählt hier nicht mit
    if (path === "/api/presence") return { ok: true, status: 204, json: async () => ({}) } as any;
    const method = init?.method ?? "GET";
    server.calls.push(`${method} ${path}`);
    if (path === "/api/conversations" && method === "GET") {
      return Response.json({
        conversations: options.web ? [{ id: WEB, agent: "general", title: "Betrieb" }] : [],
        telegram: { dm: null, topics: [{ id: "topic-8", title: "Recherche", agent: "research", lastActivity: new Date().toISOString() }] },
      });
    }
    if (path === "/api/me") return Response.json({ authenticated: true });
    if (path === "/api/commands") {
      if (server.commandsGate) await server.commandsGate;
      const c = server.commands;
      if (c === "offline") throw new TypeError("Failed to fetch");
      return Response.json(c.data, { status: c.status });
    }
    if (path === "/api/conversations/topic-8/goal") return Response.json({ card: null });
    const m = path.match(/^\/api\/conversations\/([^/?]+)\/messages$/);
    if (m && method === "POST") {
      const body = JSON.parse(init!.body!);
      server.posts.push(body);
      if (server.postReply) return Response.json(server.postReply.data, { status: server.postReply.status });
      const message = { id: `u${++counter}`, role: "user", text: body.text, createdAt: new Date().toISOString() };
      return Response.json({ message, running: false }, { status: 202 });
    }
    if (m) return Response.json({ messages: options.history ?? [], hasMore: false, running: false });
    return Response.json({ error: "unbekannt" }, { status: 404 });
  };

  elements["chat-log"] = node();
  elements["command-list"] = node();
  elements["command-list"].hidden = true;
  new Function("document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout", source)(
    document, window, fetch, FakeEventSource, setTimeout, clearTimeout
  );

  const input = elements["input"];
  const list = elements["command-list"];
  // Fokus wie im Browser: focus()/focus-Ereignis setzen, blur nimmt ihn weg
  const dispatchInput = input.dispatch.bind(input);
  input.focus = () => { document.activeElement = input; };
  input.dispatch = (type: string, event: any = {}) => {
    if (type === "focus") document.activeElement = input;
    if (type === "blur") document.activeElement = null;
    dispatchInput(type, event);
  };
  /** Tippen: Wert setzen und input auslösen (Tippen heißt, die Eingabe hat den Fokus) */
  const type = (value: string) => {
    document.activeElement = input;
    input.value = value;
    input.dispatch("input");
  };
  /** Taste an die Eingabe, danach ans Fenster, wenn niemand stopPropagation ruft */
  const key = (k: string, extra: Record<string, unknown> = {}) => {
    let stopped = false;
    const event = {
      key: k,
      shiftKey: false,
      isComposing: false,
      keyCode: 0,
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() { stopped = true; },
      ...extra,
    };
    input.dispatch("keydown", event);
    if (!stopped) for (const fn of windowListeners.keydown ?? []) fn(event);
    return event;
  };
  const options_ = () => list.children.filter(c => c.className === "command-option");
  const names = () => options_().map(o => o.children[0].children[0].textContent);
  const selected = () => options_().find(o => o.attributes["aria-selected"] === "true")?.attributes["data-name"];
  const note = () => list.children.find(c => c.className === "command-note")?.textContent;
  const shown = () => elements["messages"].children;
  const conversationSource = () => FakeEventSource.all.filter(s => s.url === "/api/conversations/topic-8/events").at(-1)!;
  const emitMessage = (m: object) => conversationSource().emit("message", { data: JSON.stringify(m) });
  const commandGets = () => server.calls.filter(c => c === "GET /api/commands").length;
  return { server, elements, input, list, type, key, options: options_, names, selected, note, shown, emitMessage, commandGets };
}

async function settle() {
  for (let i = 0; i < 20; i++) await Bun.sleep(0);
}

function all(n: Node): Node[] {
  return [n, ...n.children.flatMap(all)];
}
const byClass = (n: Node, cls: string) => all(n).find(c => String(c.className).split(" ").includes(cls));

describe("Befehlsliste: Öffnen und Filtern", () => {
  test("/ am Anfang öffnet die Liste mit Name und Kurzbeschreibung, lädt /api/commands genau einmal", async () => {
    const app = setup();
    await settle();
    expect(app.commandGets()).toBe(0);
    expect(app.list.hidden).toBe(true);
    app.type("/");
    await settle();
    expect(app.list.hidden).toBe(false);
    // /b64 kennt nur die Oberfläche (Entscheidung 0013, Issue #73), steht aber in derselben Liste
    expect(app.names()).toEqual(["/b64", "/board", "/goal", "/help", "/new", "/stop"]);
    expect(byClass(app.options()[0], "command-args")!.textContent).toBe("<code>");
    const board = app.options()[1];
    expect(board.attributes.role).toBe("option");
    expect(byClass(board, "command-args")!.textContent).toBe("[thema]");
    expect(byClass(board, "command-desc")!.textContent).toBe("Board-Sitzung: alle Board-Agenten nacheinander");
    expect(app.selected()).toBe("b64");
    expect(app.input.attributes["aria-activedescendant"]).toBe("command-option-0");
    app.type("/b");
    app.type("/");
    expect(app.commandGets()).toBe(1);
  });

  test("/bo zeigt /board; Alias findet den Befehl; Leerzeichen, Text davor oder kein Treffer schließt", async () => {
    const app = setup();
    await settle();
    app.type("/bo");
    await settle();
    expect(app.names()).toEqual(["/board"]);
    app.type("/RES");
    expect(app.names()).toEqual(["/new"]);
    app.type("/board Preise");
    expect(app.list.hidden).toBe(true);
    app.type("Hallo /bo");
    expect(app.list.hidden).toBe(true);
    app.type("/xyz");
    expect(app.list.hidden).toBe(true);
    expect(app.list.children).toEqual([]);
    app.type("");
    expect(app.list.hidden).toBe(true);
  });

  test("feindliche Namen und Beschreibungen nur als Text; unbrauchbare Einträge fallen weg", async () => {
    const evil = '<img src=x onerror="alert(1)">';
    const app = setup({
      commands: {
        status: 200,
        data: { commands: [{ name: "echo", aliases: [], description: evil, args: "none" }, { name: "<b>", description: "x" }, null, { description: "ohne Namen" }] },
      },
    });
    await settle();
    app.type("/");
    await settle();
    expect(app.names()).toEqual(["/b64", "/echo"]);
    expect(byClass(app.options()[1], "command-desc")!.textContent).toBe(evil);
    for (const n of all(app.list)) expect(n.innerHTMLWrites).toEqual([]);
  });
});

describe("Befehlsliste: Tastatur und Antippen", () => {
  test("Pfeiltasten wandern reihum; Enter übernimmt den markierten Befehl ins Feld, ohne zu senden", async () => {
    const app = setup();
    await settle();
    app.type("/");
    await settle();
    let e = app.key("ArrowDown");
    expect(e.defaultPrevented).toBe(true);
    expect(app.selected()).toBe("board");
    app.key("ArrowUp");
    app.key("ArrowUp");
    expect(app.selected()).toBe("stop");
    expect(app.input.attributes["aria-activedescendant"]).toBe("command-option-5");
    app.key("ArrowUp");
    expect(app.selected()).toBe("new");
    e = app.key("Enter");
    await settle();
    expect(e.defaultPrevented).toBe(true);
    expect(app.input.value).toBe("/new");
    expect(app.list.hidden).toBe(true);
    expect(app.server.posts).toEqual([]);
    // Erst das nächste Enter sendet
    app.key("Enter");
    await settle();
    expect(app.server.posts).toEqual([{ text: "/new" }]);
  });

  test("/bo + Enter: /board mit Leerzeichen im Feld, kein POST; weiter tippen öffnet nichts", async () => {
    const app = setup();
    await settle();
    app.type("/bo");
    await settle();
    app.key("Enter");
    await settle();
    expect(app.input.value).toBe("/board ");
    expect(app.server.posts).toEqual([]);
    app.type("/board Preise");
    expect(app.list.hidden).toBe(true);
  });

  test("Esc schließt ohne Senden und ohne die Schublade zu schließen; erst neuer Text öffnet wieder", async () => {
    const app = setup();
    await settle();
    app.elements["sidebar"].setAttribute("data-open", "true");
    app.type("/ne");
    await settle();
    const e = app.key("Escape");
    expect(e.defaultPrevented).toBe(true);
    expect(app.list.hidden).toBe(true);
    expect(app.input.value).toBe("/ne");
    expect(app.elements["sidebar"].attributes["data-open"]).toBe("true");
    expect(app.server.posts).toEqual([]);
    // Fokus zurück: bleibt zu, solange der Text gleich ist
    app.input.dispatch("focus");
    expect(app.list.hidden).toBe(true);
    // Zweites Escape bei geschlossener Liste gehört wieder dem Fenster
    app.key("Escape");
    expect(app.elements["sidebar"].attributes["data-open"]).toBe("false");
    app.type("/n");
    expect(app.list.hidden).toBe(false);
  });

  test("Antippen übernimmt ohne POST; Mausdruck auf die Liste nimmt der Eingabe den Fokus nicht", async () => {
    const app = setup();
    await settle();
    app.type("/");
    await settle();
    const down = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app.list.dispatch("mousedown", down);
    expect(down.defaultPrevented).toBe(true);
    const help = app.options().find(o => o.attributes["data-name"] === "help")!;
    help.dispatch("click");
    await settle();
    expect(app.input.value).toBe("/help");
    expect(app.list.hidden).toBe(true);
    expect(app.server.posts).toEqual([]);
  });

  test("Touch: Enter bleibt wie bisher (kein Übernehmen, kein Senden), Antippen wählt", async () => {
    const app = setup({ touch: true });
    await settle();
    app.type("/bo");
    await settle();
    const e = app.key("Enter");
    expect(e.defaultPrevented).toBe(false);
    expect(app.input.value).toBe("/bo");
    expect(app.server.posts).toEqual([]);
    app.options()[0].dispatch("click");
    expect(app.input.value).toBe("/board ");
  });

  test("IME und Shift+Enter werden nicht abgefangen", async () => {
    const app = setup();
    await settle();
    app.type("/bo");
    await settle();
    expect(app.key("Enter", { isComposing: true }).defaultPrevented).toBe(false);
    expect(app.key("ArrowDown", { keyCode: 229 }).defaultPrevented).toBe(false);
    expect(app.key("Enter", { shiftKey: true }).defaultPrevented).toBe(false);
    expect(app.input.value).toBe("/bo");
    expect(app.server.posts).toEqual([]);
  });

  test("Verlassen der Eingabe schließt die Liste", async () => {
    const app = setup();
    await settle();
    app.type("/");
    await settle();
    app.input.dispatch("blur");
    expect(app.list.hidden).toBe(true);
    app.input.dispatch("focus");
    expect(app.list.hidden).toBe(false);
  });

  test("späte Antwort von /api/commands nach Verlassen der Eingabe öffnet die Liste nicht wieder (Erfolg und Fehler)", async () => {
    for (const commands of [{ status: 200, data: { commands: COMMANDS } }, { status: 503, data: { error: "nicht eingerichtet" } }]) {
      const app = setup({ commands });
      await settle();
      let release!: () => void;
      app.server.commandsGate = new Promise<void>(r => { release = r; });
      app.type("/");
      await settle();
      expect(app.note()).toBe("Befehle werden geladen …");
      app.input.dispatch("blur");
      expect(app.list.hidden).toBe(true);
      release();
      await settle();
      expect(app.commandGets()).toBe(1);
      expect(app.list.hidden).toBe(true);
      expect(app.list.children).toEqual([]);
      expect(app.input.attributes["aria-activedescendant"]).toBeUndefined();
      // Zurück in die Eingabe: Liste mit dem geladenen Stand bzw. dem Hinweis
      app.input.dispatch("focus");
      expect(app.list.hidden).toBe(false);
      await settle();
      if (commands.status === 200) expect(app.names()).toContain("/board");
      else expect(app.note()).toBe("Befehlsliste gerade nicht erreichbar.");
    }
  });

  test("Web-Gespräch: Befehle kommen nach /b64, der erste Eintrag ist markiert, eine per Pfeil gewählte Markierung bleibt", async () => {
    const commands = { status: 200, data: { commands: [{ name: "agent", aliases: [], description: "Agent anpassen", args: "optional" }, ...COMMANDS] } };
    for (const moved of [false, true]) {
      const app = setup({ commands, web: true });
      await settle();
      let release!: () => void;
      app.server.commandsGate = new Promise<void>(r => { release = r; });
      app.type("/");
      await settle();
      // Solange geladen wird, kennt die Oberfläche nur /b64
      expect(app.names()).toEqual(["/b64"]);
      if (moved) app.key("ArrowDown");
      release();
      await settle();
      expect(app.names()[0]).toBe("/agent");
      expect(app.selected()).toBe(moved ? "b64" : "agent");
    }
  });

  test("Telegram-Gespräch: Befehle kommen nach /b64, die bisherige Markierung bleibt wie vor #112", async () => {
    const commands = { status: 200, data: { commands: [{ name: "agent", aliases: [], description: "Agent anpassen", args: "optional" }, ...COMMANDS] } };
    for (const moved of [false, true]) {
      const app = setup({ commands });
      await settle();
      let release!: () => void;
      app.server.commandsGate = new Promise<void>(r => { release = r; });
      app.type("/");
      await settle();
      expect(app.names()).toEqual(["/b64"]);
      if (moved) app.key("ArrowDown");
      release();
      await settle();
      expect(app.names()[0]).toBe("/agent");
      expect(app.selected()).toBe("b64");
    }
  });

  test("Pfeiltasten halten den markierten Eintrag im sichtbaren Ausschnitt, auch beim Umlauf", async () => {
    const app = setup();
    await settle();
    app.type("/");
    await settle();
    const scrolled = () => app.options().find(o => o.attributes["aria-selected"] === "true")!.scrolledIntoView;
    const names = app.names().map(n => n.slice(1));
    // Pfeil nach oben vom ersten Eintrag: Umlauf zum letzten, der wird sichtbar
    app.key("ArrowUp");
    expect(app.selected()).toBe(names.at(-1));
    expect(scrolled()).toBe(1);
    // Pfeil nach unten vom letzten: zurück zum ersten
    app.key("ArrowDown");
    expect(app.selected()).toBe(names[0]);
    expect(scrolled()).toBe(1);
    app.key("ArrowDown");
    expect(app.selected()).toBe(names[1]);
    expect(scrolled()).toBe(1);
    expect(app.server.posts).toEqual([]);
  });
});

describe("Befehlsliste: leer, fehlgeschlagen, normales Senden", () => {
  test("leere Liste vom Server: nichts öffnet, Enter sendet /x wie bisher", async () => {
    const app = setup({ commands: { status: 200, data: { commands: [] } } });
    await settle();
    app.type("/x");
    await settle();
    expect(app.list.hidden).toBe(true);
    app.key("Enter");
    await settle();
    expect(app.server.posts).toEqual([{ text: "/x" }]);
  });

  test("Server ohne Befehle (503) oder offline: Hinweis statt Liste, Enter sendet, beim nächsten Öffnen neuer Versuch", async () => {
    for (const commands of [{ status: 503, data: { error: "Befehle sind nicht eingerichtet" } }, "offline" as const]) {
      const app = setup({ commands });
      await settle();
      app.type("/");
      await settle();
      expect(app.list.hidden).toBe(false);
      // Nur der lokale Befehl, darunter der Hinweis
      expect(app.names()).toEqual(["/b64"]);
      expect(app.note()).toBe("Befehlsliste gerade nicht erreichbar.");
      app.type("/help");
      app.key("Enter");
      await settle();
      expect(app.server.posts).toEqual([{ text: "/help" }]);
      // Wieder da: nächstes Öffnen lädt neu
      app.server.commands = { status: 200, data: { commands: COMMANDS } };
      app.type("/bo");
      await settle();
      expect(app.names()).toEqual(["/board"]);
      expect(app.commandGets()).toBe(2);
    }
  });

  test("normaler Text: keine Liste, keine Anfrage an /api/commands, Enter sendet", async () => {
    const app = setup();
    await settle();
    app.type("Hallo tybo");
    app.key("Enter");
    await settle();
    expect(app.server.posts).toEqual([{ text: "Hallo tybo" }]);
    expect(app.commandGets()).toBe(0);
    expect(app.input.value).toBe("");
  });
});

describe("Rückmeldungen von Befehlen", () => {
  const NEW_NOTICE = {
    id: "n-new",
    role: "assistant",
    kind: "notice",
    source: "befehl",
    text: "Neue Session gestartet.",
    html: "<p>Neue Session gestartet.</p>",
    createdAt: "2026-09-24T20:00:01.000Z",
  };
  const USER_NEW = { id: "u-new", role: "user", text: "/new", createdAt: "2026-09-24T20:00:00.000Z" };

  test("/new: Rückmeldung erscheint live als Meldung „Befehl“ ohne Blase, doppelt geliefert nur einmal", async () => {
    const app = setup();
    await settle();
    app.type("/new");
    app.key("Escape");
    app.key("Enter");
    await settle();
    expect(app.server.posts).toEqual([{ text: "/new" }]);
    app.emitMessage(NEW_NOTICE);
    app.emitMessage(NEW_NOTICE);
    const notices = app.shown().filter(n => n.className === "msg msg-notice");
    expect(notices.length).toBe(1);
    expect(byClass(notices[0], "notice-source")!.textContent).toBe("Befehl");
    expect(byClass(notices[0], "bubble")).toBeUndefined();
    expect(byClass(notices[0], "notice-body")!.innerHTMLWrites).toEqual([NEW_NOTICE.html]);
  });

  test("/new nach Neuladen: genau eine Meldung „Befehl“, Nutzertext als eigene Blase", async () => {
    const app = setup({ history: [USER_NEW, NEW_NOTICE] });
    await settle();
    const list = app.shown();
    expect(list.map(n => n.className)).toEqual(["msg msg-user", "msg msg-notice"]);
    expect(byClass(list[1], "notice-source")!.textContent).toBe("Befehl");
  });

  test("Fehler eines Befehls: roter Fehlerkasten mit dem Text, klar getrennt von Meldungen", async () => {
    const app = setup();
    await settle();
    app.emitMessage({ id: "e1", role: "error", text: "Der Befehl ist fehlgeschlagen.", createdAt: "2026-09-24T20:00:02.000Z" });
    const error = app.shown().find(n => n.attributes["data-id"] === "e1")!;
    expect(error.className).toBe("msg msg-error");
    expect(byClass(error, "bubble")!.textContent).toBe("Der Befehl ist fehlgeschlagen.");
    // Abgelehnt beim Senden: Meldung des Servers als lokaler Fehler
    app.server.postReply = { status: 500, data: { error: "Der Befehl ist fehlgeschlagen." } };
    app.type("/help");
    app.key("Escape");
    app.key("Enter");
    await settle();
    const local = app.shown().at(-1)!;
    expect(local.className).toBe("msg msg-error");
    expect(byClass(local, "bubble")!.textContent).toBe("Der Befehl ist fehlgeschlagen.");
  });

  test("Agentenbeiträge von /board und /critic bleiben Antworten mit Blase und Agentenkopf", async () => {
    const app = setup();
    await settle();
    app.emitMessage({ id: "a1", role: "assistant", agent: "critic", text: "Einwand", html: "<p>Einwand</p>", createdAt: "2026-09-24T20:00:03.000Z" });
    const reply = app.shown().find(n => n.attributes["data-id"] === "a1")!;
    expect(reply.className).toBe("msg msg-assistant");
    expect(byClass(reply, "notice-source")).toBeUndefined();
    expect(byClass(reply, "content")).toBeDefined();
  });
});

describe("Markup und Aussehen", () => {
  test("Liste über der Eingabebox, versteckt, als listbox; Eingabe verweist darauf", () => {
    const list = html.indexOf('<ul id="command-list" class="command-list" role="listbox" aria-label="Befehle" hidden></ul>');
    expect(list).toBeGreaterThan(html.indexOf('<form id="composer"'));
    expect(list).toBeLessThan(html.indexOf('class="composer-box"'));
    expect(html).toContain('aria-controls="command-list"');
  });

  test("nur vorhandene Farbvariablen, Einträge mindestens 44 px hoch, kein Schatten", () => {
    const start = css.indexOf(".command-list {");
    const block = css.slice(start, css.indexOf(".composer-note", start));
    expect(block).toContain("min-height: 2.75rem");
    expect(block).not.toMatch(/#[0-9a-f]{3,6}\b|rgba?\(/i);
    expect(block).not.toContain("box-shadow");
  });
});
