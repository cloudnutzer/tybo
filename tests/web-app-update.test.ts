// Hinweis „Neue Version“ in der Chat-Seite (app.js, Issue #111) ohne Browser:
// Attrappen für DOM, fetch (mit /api/version), EventSource, sessionStorage,
// Mikrofon und eine steuerbare Uhr (setSystemTime plus eigene Timer), wie in
// web-app-recording.test.ts. Geprüft: Vergleich nach Wiederverbinden und
// beim Sichtbarwerden (höchstens einmal pro Minute), genau ein Hinweis im Chat
// und in den Einstellungen, Entwürfe über das Neuladen, Rückfrage bei
// laufender Aufnahme, laufendem Upload und anderem, was verloren ginge.
// Seit Issue #224: Registrierung des Service Workers und Übernahme beim Neuladen.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TYBO_BRAND } from "./brand-fixture";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const source = await readFile(resolve(publicDir, "app.js"), "utf8");
const html = await readFile(resolve(publicDir, "index.html"), "utf8");
const css = await readFile(resolve(publicDir, "style.css"), "utf8");

const WEBM = new Uint8Array(await readFile(resolve(import.meta.dir, "fixtures", "recordings", "chrome-opus.webm")));

const START = new Date(2026, 8, 25, 16, 0, 0).getTime();
const LOADED = "0123456789abcdef";
const NEWER = "fedcba9876543210";
const ACTIVITY = "/api/telegram/events";
const DRAFTS_KEY = "tybo-reload-drafts";
afterEach(() => setSystemTime());

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
    selectionStart: 0,
    selectionEnd: 0,
    focused: 0,
    appendChild(child: Node) { this.children.push(child); return child; },
    replaceChildren(...list: Node[]) { this.children = list.flatMap(c => (c.fragment ? c.children : [c])); },
    setAttribute(name: string, value: string) { this.attributes[name] = String(value); },
    getAttribute(name: string) { return this.attributes[name] ?? null; },
    removeAttribute(name: string) { delete this.attributes[name]; },
    listeners: {} as Record<string, ((e: any) => void)[]>,
    addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); },
    dispatch(type: string, event: any = {}) { for (const fn of this.listeners[type] ?? []) fn(event); },
    click() {},
    focus() { this.focused++; },
    scrollIntoView() {},
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

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
}

class FakeTrack { stopped = false; stop() { this.stopped = true; } }
class FakeStream { tracks = [new FakeTrack()]; getTracks() { return this.tracks; } }

interface Options {
  /** Version im Meta-Tag der geladenen Seite; null: kein Meta-Tag */
  loaded?: string | null;
  /** Version, die der Server nennt */
  version?: string | null;
  /** sessionStorage: normal, gesperrt (Zugriff wirft), voll (setItem wirft), fehlt */
  storage?: "ok" | "blocked" | "full" | "missing";
  /** Inhalt des sessionStorage beim Laden (Neuladen desselben Tabs) */
  session?: Record<string, string>;
  /** Mikrofon antwortet erst von Hand */
  microphone?: "grant" | "manual";
  /** Upload antwortet erst von Hand */
  upload?: "ok" | "manual";
  /** Attrappe der Einstellungsansicht mit ungespeicherten Änderungen */
  settingsUnsaved?: boolean;
  stored?: string;
  /** Service-Worker-Schnittstelle (Issue #224); ohne sie gibt es keine */
  serviceWorker?: FakeContainer;
  /** Sicherer Kontext (HTTPS, localhost); Standard ja */
  secure?: boolean;
}

/** Attrappe eines wartenden Workers: merkt sich Nachrichten */
class FakeWorker {
  messages: unknown[] = [];
  postMessage(message: unknown) { this.messages.push(message); }
}

/** Attrappe für navigator.serviceWorker samt Registrierung (Issue #224) */
class FakeContainer {
  registered: [string, unknown][] = [];
  listeners: Record<string, (() => void)[]> = {};
  fail = false;
  registration = {
    waiting: null as FakeWorker | null,
    updates: 0,
    update() { this.updates++; return Promise.resolve(); },
  };
  register(path: string, options: unknown) {
    this.registered.push([path, options]);
    return this.fail ? Promise.reject(new Error("abgelehnt")) : Promise.resolve(this.registration);
  }
  addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); }
  emit(type: string) { for (const fn of this.listeners[type] ?? []) fn(); }
}

function setup(options: Options = {}) {
  setSystemTime(new Date(START));
  FakeEventSource.all = [];
  const elements: Record<string, Node> = {};
  const docListeners: Record<string, (() => void)[]> = {};
  const document = {
    visibilityState: "visible",
    getElementById(id: string) { return (elements[id] ??= node()); },
    createElement(tag: string) { const n = node(); n.tagName = tag; return n; },
    createElementNS() { return node(); },
    createDocumentFragment() { const f = node(); f.fragment = true; return f; },
    addEventListener(type: string, fn: () => void) { (docListeners[type] ??= []).push(fn); },
  };
  const meta = node();
  if (options.loaded !== null) meta.setAttribute("content", options.loaded ?? LOADED);
  elements["ui-version"] = meta;

  let timerSeq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const setTimeout = (fn: () => void, ms = 0) => {
    const id = ++timerSeq;
    timers.set(id, { at: Date.now() + Math.max(0, ms), fn });
    return id;
  };
  const clearTimeout = (id: number) => { timers.delete(id); };
  const advance = (ms: number) => {
    const end = Date.now() + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      setSystemTime(new Date(Math.max(Date.now(), due[1].at)));
      due[1].fn();
    }
    setSystemTime(new Date(end));
  };

  const session: Record<string, string> = { ...(options.session ?? {}) };
  const storageMode = options.storage ?? "ok";
  const sessionStorage = {
    getItem: (key: string) => session[key] ?? null,
    setItem: (key: string, value: string) => {
      if (storageMode === "full") throw Object.assign(new Error("voll"), { name: "QuotaExceededError" });
      session[key] = value;
    },
    removeItem: (key: string) => { delete session[key]; },
  };
  const microphone: Deferred<FakeStream>[] = [];
  const recorders: any[] = [];
  class FakeMediaRecorder {
    static isTypeSupported() { return true; }
    state = "inactive";
    ondataavailable: ((e: any) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((e: any) => void) | null = null;
    constructor(public stream: FakeStream, public init: { mimeType: string }) { recorders.push(this); }
    get mimeType() { return this.init.mimeType; }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; }
  }
  const store: Record<string, string> = { "tybo-last-conversation": options.stored ?? "topic-8" };
  let reloads = 0;
  const window: Record<string, any> = {
    TYBO_BRAND,
    isSecureContext: options.secure ?? true,
    navigator: {
      ...(options.serviceWorker ? { serviceWorker: options.serviceWorker } : {}),
      mediaDevices: {
        getUserMedia() {
          if ((options.microphone ?? "grant") === "grant") return Promise.resolve(new FakeStream());
          const d = deferred<FakeStream>();
          microphone.push(d);
          return d.promise;
        },
      },
    },
    MediaRecorder: FakeMediaRecorder,
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ lineHeight: "22", paddingTop: "0", paddingBottom: "0", borderTopWidth: "0", borderBottomWidth: "0" }),
    addEventListener() {},
    location: { href: "/", hash: "", pathname: "/", search: "", reload() { reloads++; } },
    history: { replaceState() {} },
  };
  if (storageMode === "blocked") {
    Object.defineProperty(window, "sessionStorage", { get() { throw Object.assign(new Error("gesperrt"), { name: "SecurityError" }); } });
  } else if (storageMode !== "missing") {
    window.sessionStorage = sessionStorage;
  }

  const topics = [
    { id: "topic-8", title: "Recherche", agent: "research", lastActivity: new Date(START).toISOString() },
    { id: "topic-9", title: "Strategie", agent: "strategy", lastActivity: new Date(START).toISOString() },
  ];
  const server = {
    version: options.version === undefined ? LOADED : options.version,
    versionCalls: 0,
    /** Offene Antworten auf /api/version, wenn hold gesetzt ist */
    hold: false,
    held: [] as Deferred<void>[],
    uploads: [] as Deferred<void>[],
    requests: [] as string[],
  };
  let uploadSeq = 0;
  const fetch = async (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
    // Anwesenheit (Issue #226) läuft nebenher und zählt hier nicht mit
    if (path === "/api/presence") return { ok: true, status: 204, json: async () => ({}) } as any;
    const method = init?.method ?? "GET";
    server.requests.push(`${method} ${path}`);
    if (path === "/api/version") {
      server.versionCalls++;
      if (server.hold) {
        const d = deferred<void>();
        server.held.push(d);
        await d.promise;
      }
      return Response.json({ version: server.version });
    }
    if (path === "/api/conversations" && method === "GET") {
      return Response.json({ conversations: [], telegram: { dm: null, topics } });
    }
    if (path === "/api/me") return Response.json({ authenticated: true });
    if (path === "/api/commands") return Response.json({ commands: [] });
    if (path.endsWith("/goal")) return Response.json({ card: null });
    if (/\/attachments$/.test(path) && method === "POST") {
      if ((options.upload ?? "ok") === "manual") {
        const d = deferred<void>();
        server.uploads.push(d);
        await d.promise;
      }
      const blob = init!.body as Blob;
      return Response.json(
        { id: `00000000-0000-4000-8000-${String(++uploadSeq).padStart(12, "0")}`, name: "a.pdf", size: blob.size, mime: "application/pdf", kind: "pdf" },
        { status: 201 }
      );
    }
    if (/\/messages$/.test(path) && method === "POST") {
      const body = JSON.parse(init!.body as string);
      return Response.json({ message: { id: `u${Date.now()}`, role: "user", text: body.text, createdAt: new Date().toISOString() } }, { status: 202 });
    }
    if (/\/messages$/.test(path)) return Response.json({ messages: [], hasMore: false, running: false });
    return Response.json({ error: "unbekannt" }, { status: 404 });
  };

  // Einstellungen als Attrappe (settings.js selbst prüft web-app-settings-unsaved)
  const settings = { open: false, unsaved: !!options.settingsUnsaved };
  const createSettingsView = () => ({
    show() { settings.open = true; },
    hide() { settings.open = false; },
    isOpen: () => settings.open,
    hasUnsavedChanges: () => settings.unsaved,
  });
  const settingsTabFromHash = (hash: string) => (String(hash).startsWith("#/einstellungen") ? "agenten" : null);
  const settingsHash = (tab: string) => "#/einstellungen/" + tab;

  for (const id of ["attachments", "attach-note", "attach", "record", "recorder"]) {
    elements[id] = node();
    elements[id].hidden = true;
  }
  new Function(
    "document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout",
    "createSettingsView", "settingsTabFromHash", "settingsHash", source
  )(document, window, fetch, FakeEventSource, setTimeout, clearTimeout, createSettingsView, settingsTabFromHash, settingsHash);

  const input = elements["input"];
  const chatNote = elements["update-note"];
  const settingsNote = elements["settings-update-note"];
  const noteText = (n: Node = chatNote) => n.children[0]?.textContent ?? "";
  const buttons = (n: Node = chatNote) => (n.children[1]?.children ?? []) as Node[];
  const press = (label: string, n: Node = chatNote) => {
    const b = buttons(n).find(x => x.textContent === label);
    if (!b) throw new Error(`Knopf ${label} fehlt`);
    b.dispatch("click");
  };
  const entry = (id: string) => {
    for (const listId of ["dm-list", "topic-list", "older-list", "conversation-list"]) {
      const li = (elements[listId]?.children ?? []).find(l => l.children[0]?.attributes["data-id"] === id);
      if (li) return li.children[0];
    }
    throw new Error(`Eintrag ${id} fehlt`);
  };
  const conversationSource = () => FakeEventSource.all.filter(s => s.url !== ACTIVITY).at(-1)!;
  const activitySource = () => FakeEventSource.all.filter(s => s.url === ACTIVITY).at(-1)!;
  /** Verbindung weg (etwa Neustart des Bots) und wieder da */
  const reconnectConversation = async () => {
    conversationSource().emit("error", {});
    advance(RECONNECT_WAIT);
    await settle();
    conversationSource().emit("open");
    await settle();
  };
  const reconnectActivity = async () => {
    activitySource().emit("error", {});
    advance(RECONNECT_WAIT);
    await settle();
    activitySource().emit("open");
    await settle();
  };
  const setVisibility = (state: "visible" | "hidden") => {
    document.visibilityState = state;
    for (const fn of docListeners["visibilitychange"] ?? []) fn();
  };
  const type = (value: string) => {
    input.value = value;
    input.dispatch("input");
  };
  const addPdf = () => {
    elements["file-input"].files = [new File(["%PDF-1.4\n%%EOF"], "a.pdf", { type: "application/pdf" })];
    elements["file-input"].dispatch("change");
  };
  return {
    elements, input, chatNote, settingsNote, noteText, buttons, press, entry, server, session, settings, window,
    conversationSource, activitySource, reconnectConversation, reconnectActivity, setVisibility, type, addPdf,
    advance, timers, microphone, recorders,
    reloads: () => reloads,
    tapRecord: () => elements["record"].dispatch("click"),
    submit: () => elements["composer"].dispatch("submit", { preventDefault() {} }),
  };
}

/** Wartezeit bis zum ersten Wiederverbinden (Start 1 Sekunde) */
const RECONNECT_WAIT = 1000;

async function settle() {
  for (let i = 0; i < 30; i++) await Bun.sleep(0);
}

async function started(options: Options = {}) {
  const app = setup(options);
  await settle();
  app.conversationSource().emit("open");
  app.activitySource().emit("open");
  await settle();
  return app;
}

describe("Vergleich der Version (Issue #111, Schritt 2)", () => {
  test("erster Aufbau der Live-Verbindungen fragt nicht; kein Dauer-Polling", async () => {
    const app = await started({ version: NEWER });
    app.advance(30 * 60_000);
    await settle();
    expect(app.server.versionCalls).toBe(0);
    expect(app.chatNote.children).toEqual([]);
  });

  test("Neustart ohne Änderung: Wiederverbinden fragt, kein Hinweis", async () => {
    const app = await started();
    await app.reconnectConversation();
    expect(app.server.versionCalls).toBe(1);
    await app.reconnectActivity();
    expect(app.server.versionCalls).toBe(2);
    expect(app.chatNote.children).toEqual([]);
    expect(app.settingsNote.children).toEqual([]);
  });

  test("geänderte Version nach Wiederverbinden: genau ein Hinweis mit Knopf, auch in den Einstellungen", async () => {
    const app = await started();
    app.server.version = NEWER;
    await app.reconnectConversation();
    expect(app.noteText()).toBe("Neue Version von tybo verfügbar");
    expect(app.buttons().map(b => b.textContent)).toEqual(["Neu laden"]);
    expect(app.buttons()[0].type).toBe("button");
    expect(app.noteText(app.settingsNote)).toBe("Neue Version von tybo verfügbar");
    const calls = app.server.versionCalls;
    // Weitere Anlässe fragen nicht mehr und erzeugen keinen zweiten Hinweis
    await app.reconnectActivity();
    await app.reconnectConversation();
    app.advance(2 * 60_000);
    app.setVisibility("hidden");
    app.setVisibility("visible");
    await settle();
    expect(app.server.versionCalls).toBe(calls);
    expect(app.chatNote.children).toHaveLength(2);
    expect(app.chatNote.children[0].textContent).toBe("Neue Version von tybo verfügbar");
    // Kein automatisches Neuladen
    expect(app.reloads()).toBe(0);
  });

  test("beide Live-Verbindungen gleichzeitig: eine gemeinsame Anfrage", async () => {
    const app = await started({ version: NEWER });
    app.server.hold = true;
    app.conversationSource().emit("error", {});
    app.activitySource().emit("error", {});
    app.advance(RECONNECT_WAIT);
    await settle();
    app.conversationSource().emit("open");
    app.activitySource().emit("open");
    await settle();
    expect(app.server.versionCalls).toBe(1);
    app.server.held[0].resolve();
    await settle();
    expect(app.noteText()).toBe("Neue Version von tybo verfügbar");
  });

  test("Sichtbarwerden: höchstens einmal pro Minute; die gebremste Prüfung wird nachgeholt", async () => {
    const app = await started();
    app.setVisibility("hidden");
    app.setVisibility("visible");
    await settle();
    expect(app.server.versionCalls).toBe(1);
    // 20 Sekunden später, inzwischen neue Version: noch keine Anfrage
    app.server.version = NEWER;
    app.advance(20_000);
    app.setVisibility("hidden");
    app.setVisibility("visible");
    app.setVisibility("hidden");
    app.setVisibility("visible");
    await settle();
    expect(app.server.versionCalls).toBe(1);
    expect(app.chatNote.children).toEqual([]);
    // Nach Ablauf der Minute genau eine nachgeholte Anfrage, dann der Hinweis
    app.advance(39_999);
    await settle();
    expect(app.server.versionCalls).toBe(1);
    app.advance(1);
    await settle();
    expect(app.server.versionCalls).toBe(2);
    expect(app.noteText()).toBe("Neue Version von tybo verfügbar");
  });

  test("nachgeholte Prüfung im versteckten Tab fällt aus, das nächste Sichtbarwerden prüft sofort", async () => {
    const app = await started({ version: NEWER });
    app.server.version = LOADED;
    app.setVisibility("visible");
    await settle();
    expect(app.server.versionCalls).toBe(1);
    app.server.version = NEWER;
    app.advance(10_000);
    app.setVisibility("visible");
    app.setVisibility("hidden");
    app.advance(60_000);
    await settle();
    expect(app.server.versionCalls).toBe(1);
    app.setVisibility("visible");
    await settle();
    expect(app.server.versionCalls).toBe(2);
    expect(app.noteText()).toBe("Neue Version von tybo verfügbar");
  });

  test("im Hintergrund pausierter Timer: Sichtbarwerden nach der Minute und alter Timer fragen nur einmal", async () => {
    const app = await started();
    app.setVisibility("visible");
    await settle();
    expect(app.server.versionCalls).toBe(1);
    // Gebremst: Timer für die restlichen 40 Sekunden
    app.advance(20_000);
    app.setVisibility("hidden");
    app.setVisibility("visible");
    await settle();
    expect(app.server.versionCalls).toBe(1);
    // Hintergrund: die Uhr läuft weiter, der Timer nicht
    app.setVisibility("hidden");
    setSystemTime(new Date(Date.now() + 90_000));
    app.setVisibility("visible");
    await settle();
    expect(app.server.versionCalls).toBe(2);
    // Der alte Timer darf danach nicht gleich noch einmal fragen
    app.advance(1_000);
    await settle();
    expect(app.server.versionCalls).toBe(2);
    // Übrig bleibt nur der Timer auf kurz nach Mitternacht für die Zeitstempel (Issue #186)
    const atMidnight = (at: number) => { const d = new Date(at - 1000); return d.getHours() + d.getMinutes() + d.getSeconds() + d.getMilliseconds() === 0; };
    expect([...app.timers.values()].filter(t => !atMidnight(t.at))).toHaveLength(0);
  });

  test("gebremster Timer nach einer Prüfung beim Wiederverbinden: die Minute gilt ab dort neu", async () => {
    const app = await started();
    app.setVisibility("visible");
    await settle();
    app.advance(20_000);
    app.setVisibility("visible");
    await settle();
    expect(app.server.versionCalls).toBe(1);
    // 30 Sekunden vor Ablauf des Timers prüft das Wiederverbinden
    app.advance(9_000);
    await app.reconnectConversation();
    expect(app.server.versionCalls).toBe(2);
    // Der Timer fällt fällig, fragt aber erst eine Minute nach dieser Prüfung
    app.advance(59_000);
    await settle();
    expect(app.server.versionCalls).toBe(2);
    app.advance(1_000);
    await settle();
    expect(app.server.versionCalls).toBe(3);
  });

  test("Wiederverbinden ist nicht gebremst, auch kurz nach einer Prüfung", async () => {
    const app = await started();
    app.setVisibility("visible");
    await settle();
    app.server.version = NEWER;
    app.advance(5_000);
    await app.reconnectConversation();
    expect(app.server.versionCalls).toBe(2);
    expect(app.noteText()).toBe("Neue Version von tybo verfügbar");
  });

  test("fehlgeschlagene Abfrage: still, der nächste Anlass fragt erneut", async () => {
    const app = await started();
    app.server.version = "kaputt";
    await app.reconnectConversation();
    expect(app.chatNote.children).toEqual([]);
    app.server.version = NEWER;
    await app.reconnectConversation();
    expect(app.noteText()).toBe("Neue Version von tybo verfügbar");
  });

  test("ohne Meta-Tag (alter Server): keine Abfrage, kein Hinweis", async () => {
    const app = await started({ loaded: null, version: NEWER });
    await app.reconnectConversation();
    app.setVisibility("visible");
    await settle();
    expect(app.server.versionCalls).toBe(0);
    expect(app.chatNote.children).toEqual([]);
  });

  test("index.html und style.css: status-Regionen oben im Chat und unter der Kopfzeile der Einstellungen, ruhig", () => {
    expect(html).toContain('<meta name="tybo-ui-version" id="ui-version" content="{{ui.version}}">');
    const main = html.slice(html.indexOf('<div id="main"'));
    expect(main.indexOf('id="update-note"')).toBeGreaterThan(main.indexOf("</header>"));
    expect(main.indexOf('id="update-note"')).toBeLessThan(main.indexOf('id="chat-log"'));
    expect(main).toMatch(/<div id="update-note" class="update-note" role="status"><\/div>/);
    const settings = main.slice(main.indexOf('<section id="settings"'));
    expect(settings.indexOf('id="settings-update-note"')).toBeGreaterThan(settings.indexOf("</header>"));
    expect(settings.indexOf('id="settings-update-note"')).toBeLessThan(settings.indexOf("settings-scroll"));
    expect(settings).toMatch(/<div id="settings-update-note" class="update-note" role="status"><\/div>/);
    const block = css.slice(css.indexOf(".update-note {"), css.indexOf("/* Verlauf"));
    expect(block).toContain(".update-note:empty { display: none; }");
    expect(block.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-f]{3,6}\b|animation|transition|@keyframes/i);
  });
});

describe("Neu laden und Entwürfe (Issue #111, Schritt 3)", () => {
  async function withUpdate(options: Options = {}) {
    const app = await started(options);
    app.server.version = NEWER;
    await app.reconnectConversation();
    expect(app.noteText()).toBe("Neue Version von tybo verfügbar");
    return app;
  }

  test("Entwürfe zweier Gespräche überstehen das Neuladen, pro Gespräch", async () => {
    const app = await withUpdate();
    app.type("Entwurf in Recherche");
    app.entry("topic-9").dispatch("click");
    await settle();
    app.type("Entwurf in Strategie");
    app.press("Neu laden");
    expect(app.reloads()).toBe(1);
    expect(JSON.parse(app.session[DRAFTS_KEY])).toEqual({
      drafts: { "topic-8": "Entwurf in Recherche", "topic-9": "Entwurf in Strategie" },
    });

    // Derselbe Tab nach dem Laden: Strategie offen, der Entwurf steht wieder da
    const after = setup({ session: { ...app.session }, stored: "topic-9" });
    await settle();
    expect(after.input.value).toBe("Entwurf in Strategie");
    expect(after.session[DRAFTS_KEY]).toBeUndefined();
    after.entry("topic-8").dispatch("click");
    await settle();
    expect(after.input.value).toBe("Entwurf in Recherche");
  });

  test("leerer Entwurf und gesendeter Entwurf werden nicht gesichert", async () => {
    const app = await withUpdate();
    app.type("schon gesendet");
    app.submit();
    await settle();
    expect(app.input.value).toBe("");
    app.entry("topic-9").dispatch("click");
    await settle();
    app.type("");
    app.press("Neu laden");
    expect(app.reloads()).toBe(1);
    expect(app.session[DRAFTS_KEY]).toBeUndefined();
  });

  test("ohne Entwurf und ohne Laufendes: sofort neu laden, ohne Rückfrage", async () => {
    const app = await withUpdate({ storage: "blocked" });
    app.press("Neu laden");
    expect(app.reloads()).toBe(1);
  });

  for (const storage of ["blocked", "full", "missing"] as const) {
    test(`Speicher ${storage}: kein stiller Verlust, Rückfrage vor dem Neuladen`, async () => {
      const app = await withUpdate({ storage });
      app.type("wichtiger Text");
      app.press("Neu laden");
      expect(app.reloads()).toBe(0);
      expect(app.noteText()).toBe("Entwürfe ließen sich nicht sichern und gehen verloren. Trotzdem neu laden?");
      expect(app.buttons().map(b => b.textContent)).toEqual(["Neu laden", "Abbrechen"]);
      // Fokus auf Abbrechen, der Entwurf bleibt
      expect(app.buttons()[1].focused).toBe(1);
      app.press("Abbrechen");
      expect(app.noteText()).toBe("Neue Version von tybo verfügbar");
      expect(app.input.value).toBe("wichtiger Text");
      expect(app.reloads()).toBe(0);
    });
  }

  test("laufende Aufnahme: Rückfrage; Abbrechen lässt sie laufen, Bestätigen verwirft sie und lädt", async () => {
    const app = await withUpdate();
    app.tapRecord();
    await settle();
    expect(app.recorders[0].state).toBe("recording");
    app.press("Neu laden");
    expect(app.reloads()).toBe(0);
    expect(app.noteText()).toBe("Eine Sprachaufnahme läuft und geht verloren. Trotzdem neu laden?");
    app.press("Abbrechen");
    expect(app.recorders[0].state).toBe("recording");
    expect(app.reloads()).toBe(0);
    app.press("Neu laden");
    app.press("Neu laden");
    expect(app.reloads()).toBe(1);
    expect(app.recorders[0].state).toBe("inactive");
  });

  test("voller Speicher, Rückfrage erst nur wegen Anhang, danach Text: Bestätigen fragt erneut nach dem Entwurf", async () => {
    const app = await withUpdate({ storage: "full" });
    app.addPdf();
    await settle();
    app.press("Neu laden");
    expect(app.noteText()).toBe("Nicht gesendete Anhänge gehen verloren. Trotzdem neu laden?");
    app.type("neuer Text");
    app.press("Neu laden");
    expect(app.reloads()).toBe(0);
    expect(app.noteText()).toBe(
      "Nicht gesendete Anhänge gehen verloren. Entwürfe ließen sich nicht sichern und gehen verloren. Trotzdem neu laden?"
    );
    expect(app.buttons()[1].focused).toBeGreaterThan(0);
    // Abbrechen behält den Text
    app.press("Abbrechen");
    expect(app.input.value).toBe("neuer Text");
    expect(app.reloads()).toBe(0);
    // Erneut, diesmal mit dem Verlust in der Rückfrage: Bestätigen lädt
    app.press("Neu laden");
    app.press("Neu laden");
    expect(app.reloads()).toBe(1);
  });

  test("Aufnahme im Abschluss (Recorder-Daten ausstehend, dann Verarbeitung): Rückfrage, Abbrechen lässt den Abschluss zu", async () => {
    const app = await withUpdate();
    app.tapRecord();
    await settle();
    const recorder = app.recorders[0];
    app.elements["recorder-stop"].dispatch("click");
    expect(recorder.state).toBe("inactive");
    // Recorder hat die letzten Daten noch nicht geliefert
    app.press("Neu laden");
    expect(app.reloads()).toBe(0);
    expect(app.noteText()).toBe("Eine Sprachaufnahme läuft und geht verloren. Trotzdem neu laden?");
    app.press("Abbrechen");
    // Daten und stop-Ereignis kommen; die Verarbeitung (Typ aus den ersten Bytes) läuft asynchron
    recorder.ondataavailable({ data: new Blob([WEBM]) });
    recorder.onstop();
    app.press("Neu laden");
    expect(app.reloads()).toBe(0);
    expect(app.noteText()).toBe("Eine Sprachaufnahme läuft und geht verloren. Trotzdem neu laden?");
    app.press("Abbrechen");
    await settle();
    // Abschluss fertig: ein Anhang, nichts neu geladen
    expect(app.elements["attachments"].children).toHaveLength(1);
    expect(app.reloads()).toBe(0);
    app.press("Neu laden");
    expect(app.reloads()).toBe(0);
    expect(app.noteText()).toBe("Nicht gesendete Anhänge gehen verloren. Trotzdem neu laden?");
  });

  test("Aufnahme wartet noch auf die Mikrofonfreigabe: ebenfalls Rückfrage", async () => {
    const app = await withUpdate({ microphone: "manual" });
    app.tapRecord();
    await settle();
    expect(app.microphone).toHaveLength(1);
    app.press("Neu laden");
    expect(app.reloads()).toBe(0);
    expect(app.noteText()).toContain("Eine Sprachaufnahme läuft");
  });

  test("laufender Upload, auch nach Gesprächswechsel: Rückfrage", async () => {
    const app = await withUpdate({ upload: "manual" });
    app.addPdf();
    await settle();
    app.type("mit Anhang");
    app.submit();
    await settle();
    expect(app.server.uploads).toHaveLength(1);
    app.entry("topic-9").dispatch("click");
    await settle();
    app.press("Neu laden");
    expect(app.reloads()).toBe(0);
    expect(app.noteText()).toBe("Ein Upload läuft noch und bricht ab. Trotzdem neu laden?");
    app.press("Abbrechen");
    expect(app.reloads()).toBe(0);
  });

  test("fertiger, nicht gesendeter Anhang: Rückfrage", async () => {
    const app = await withUpdate();
    app.addPdf();
    await settle();
    app.press("Neu laden");
    expect(app.reloads()).toBe(0);
    expect(app.noteText()).toBe("Nicht gesendete Anhänge gehen verloren. Trotzdem neu laden?");
  });

  test("ungespeicherte Einstellungen: Rückfrage, auch im Hinweis der Einstellungsseite", async () => {
    const app = await withUpdate({ settingsUnsaved: true });
    app.elements["open-settings"].dispatch("click");
    await settle();
    expect(app.elements["main"].getAttribute("data-view")).toBe("settings");
    expect(app.noteText(app.settingsNote)).toBe("Neue Version von tybo verfügbar");
    app.press("Neu laden", app.settingsNote);
    expect(app.reloads()).toBe(0);
    expect(app.noteText(app.settingsNote)).toBe("Ungespeicherte Einstellungen gehen verloren. Trotzdem neu laden?");
    // Fokus im sichtbaren Hinweis (Einstellungen), nicht im versteckten des Chats
    expect(app.buttons(app.settingsNote)[1].focused).toBe(1);
    expect(app.buttons()[1].focused).toBe(0);
    app.settings.unsaved = false;
    app.press("Abbrechen", app.settingsNote);
    app.press("Neu laden", app.settingsNote);
    expect(app.reloads()).toBe(1);
  });

  test("Abbrechen verwirft die gesicherten Entwürfe; ein späteres normales Laden setzt nichts Altes ein", async () => {
    const app = await withUpdate();
    app.type("Entwurf");
    app.addPdf();
    await settle();
    app.press("Neu laden");
    expect(app.session[DRAFTS_KEY]).toBeDefined();
    app.press("Abbrechen");
    expect(app.session[DRAFTS_KEY]).toBeUndefined();
  });

  test("unlesbare gesicherte Entwürfe: leeres Feld statt Fehler", async () => {
    for (const raw of ["{kaputt", JSON.stringify({ drafts: ["x"] }), JSON.stringify({ drafts: { "topic-8": 5 } })]) {
      const app = setup({ session: { [DRAFTS_KEY]: raw } });
      await settle();
      expect(app.input.value).toBe("");
    }
  });
});

describe("Service Worker und Neue Version (Issue #224)", () => {
  async function withUpdate(options: Options = {}) {
    const app = await started(options);
    app.server.version = NEWER;
    await app.reconnectConversation();
    expect(app.noteText()).toBe("Neue Version von tybo verfügbar");
    return app;
  }

  test("registriert /sw.js mit Scope / und updateViaCache none, nur im sicheren Kontext", async () => {
    const secure = new FakeContainer();
    await started({ serviceWorker: secure });
    expect(secure.registered).toEqual([["/sw.js", { scope: "/", updateViaCache: "none" }]]);
    const insecure = new FakeContainer();
    await started({ serviceWorker: insecure, secure: false });
    expect(insecure.registered).toEqual([]);
  });

  test("abgelehnte Registrierung bleibt still, Neu laden geht wie bisher", async () => {
    const container = new FakeContainer();
    container.fail = true;
    const app = await withUpdate({ serviceWorker: container });
    app.press("Neu laden");
    expect(app.reloads()).toBe(1);
  });

  test("neue Version erkannt: der Worker wird gleich geprüft", async () => {
    const container = new FakeContainer();
    const app = await started({ serviceWorker: container });
    await app.reconnectConversation();
    expect(container.registration.updates).toBe(0);
    app.server.version = NEWER;
    await app.reconnectConversation();
    expect(container.registration.updates).toBe(1);
  });

  test("ohne wartenden Worker: sofort neu laden", async () => {
    const container = new FakeContainer();
    const app = await withUpdate({ serviceWorker: container });
    app.press("Neu laden");
    expect(app.reloads()).toBe(1);
  });

  test("wartender Worker: erst skip-waiting, geladen wird nach der Übernahme, genau einmal", async () => {
    const container = new FakeContainer();
    const waiting = new FakeWorker();
    const app = await withUpdate({ serviceWorker: container });
    container.registration.waiting = waiting;
    app.type("Entwurf bleibt");
    app.press("Neu laden");
    expect(waiting.messages).toEqual([{ type: "skip-waiting" }]);
    expect(app.reloads()).toBe(0);
    // Entwürfe sind schon vor dem Warten gesichert
    expect(JSON.parse(app.session[DRAFTS_KEY])).toEqual({ drafts: { "topic-8": "Entwurf bleibt" } });
    container.emit("controllerchange");
    expect(app.reloads()).toBe(1);
    // Die Frist danach lädt nicht noch einmal
    app.advance(5000);
    expect(app.reloads()).toBe(1);
  });

  test("Übernahme bleibt aus: nach höchstens 3 Sekunden trotzdem neu laden", async () => {
    const container = new FakeContainer();
    const app = await withUpdate({ serviceWorker: container });
    container.registration.waiting = new FakeWorker();
    app.press("Neu laden");
    app.advance(2999);
    expect(app.reloads()).toBe(0);
    app.advance(1);
    expect(app.reloads()).toBe(1);
    container.emit("controllerchange");
    expect(app.reloads()).toBe(1);
  });

  test("während der Übernahme ist die Seite gesperrt, Eingabe bis controllerchange wird gesichert", async () => {
    const container = new FakeContainer();
    const app = await withUpdate({ serviceWorker: container });
    container.registration.waiting = new FakeWorker();
    app.type("Erster Teil");
    app.press("Neu laden");
    expect(app.elements["main"].inert).toBe(true);
    expect(app.elements["sidebar"].inert).toBe(true);
    expect(app.input.readOnly).toBe(true);
    // Trotz Sperre geändert (etwa durch eine Erweiterung): geht nicht verloren
    app.type("Erster Teil und mehr");
    container.emit("controllerchange");
    expect(app.reloads()).toBe(1);
    expect(JSON.parse(app.session[DRAFTS_KEY])).toEqual({ drafts: { "topic-8": "Erster Teil und mehr" } });
  });

  test("Eingabe während der Übernahme bis zur Frist wird gesichert", async () => {
    const container = new FakeContainer();
    const app = await withUpdate({ serviceWorker: container });
    container.registration.waiting = new FakeWorker();
    app.press("Neu laden");
    app.type("Nachgetippt");
    app.advance(3000);
    expect(app.reloads()).toBe(1);
    expect(JSON.parse(app.session[DRAFTS_KEY])).toEqual({ drafts: { "topic-8": "Nachgetippt" } });
  });

  test("neues Verlustrisiko während der Übernahme: nicht laden, erneut fragen, entsperren", async () => {
    const container = new FakeContainer();
    const app = await withUpdate({ serviceWorker: container, storage: "full" });
    container.registration.waiting = new FakeWorker();
    app.press("Neu laden");
    expect(app.reloads()).toBe(0);
    // Ohne Entwurf ging nichts verloren; jetzt kommt Text dazu, der Speicher ist voll
    app.type("Wichtiger Text");
    container.emit("controllerchange");
    expect(app.reloads()).toBe(0);
    expect(app.noteText()).toBe("Entwürfe ließen sich nicht sichern und gehen verloren. Trotzdem neu laden?");
    expect(app.input.value).toBe("Wichtiger Text");
    expect(app.input.readOnly).toBe(false);
    expect(app.elements["main"].inert).toBe(false);
    // Die Frist lädt danach nicht still nach
    app.advance(5000);
    expect(app.reloads()).toBe(0);
    app.press("Abbrechen");
    expect(app.reloads()).toBe(0);
    expect(app.input.value).toBe("Wichtiger Text");
  });

  test("Entwurfsschutz vor der Übernahme: Rückfrage bei Aufnahme, Abbrechen schickt nichts, Bestätigen übernimmt", async () => {
    const container = new FakeContainer();
    const waiting = new FakeWorker();
    const app = await withUpdate({ serviceWorker: container });
    container.registration.waiting = waiting;
    app.tapRecord();
    await settle();
    app.press("Neu laden");
    expect(app.noteText()).toBe("Eine Sprachaufnahme läuft und geht verloren. Trotzdem neu laden?");
    expect(waiting.messages).toEqual([]);
    app.press("Abbrechen");
    expect(waiting.messages).toEqual([]);
    expect(app.recorders[0].state).toBe("recording");
    app.press("Neu laden");
    app.press("Neu laden");
    expect(waiting.messages).toEqual([{ type: "skip-waiting" }]);
    expect(app.recorders[0].state).toBe("inactive");
    container.emit("controllerchange");
    expect(app.reloads()).toBe(1);
  });
});
