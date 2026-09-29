// Anwesenheit und Direktlink in der Chat-Seite (app.js, Issue #226) ohne
// Browser: Attrappen für DOM, fetch, EventSource, sendBeacon, Fokus und
// Sichtbarkeit. Geprüft: Meldungen beim Laden, Gesprächswechsel, Einstellungen,
// visibilitychange, focus/blur, pagehide (sendBeacon), pageshow, Abmelden und
// alle 30 Sekunden; steigende Nummer, eine Tab-Kennung pro Seite. Dazu der
// Direktlink #/gespraech/<id> (beim Laden, nach der Anmeldung, per hashchange,
// per Nachricht des Service Workers, unbekanntes Gespräch mit Hinweis) und das
// Schließen erledigter Benachrichtigungen.
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { renderServiceWorker } from "../src/web/service-worker";
import { TYBO_BRAND } from "./brand-fixture";

const source = await readFile(resolve(import.meta.dir, "..", "src", "web", "public", "app.js"), "utf8");
const ACTIVITY = "/api/telegram/events";
const WEB_ID = "3f2b8c1e-4d5a-4b6c-9d7e-8f9a0b1c2d3e";

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
    appendChild(child: Node) { this.children.push(child); return child; },
    replaceChildren(...list: Node[]) { this.children = list.flatMap(c => (c.fragment ? c.children : [c])); },
    setAttribute(name: string, value: string) { this.attributes[name] = String(value); },
    getAttribute(name: string) { return this.attributes[name] ?? null; },
    removeAttribute(name: string) { delete this.attributes[name]; },
    listeners: {} as Record<string, ((e: any) => void)[]>,
    addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); },
    dispatch(type: string, event: any = {}) { for (const fn of this.listeners[type] ?? []) fn(event); },
    click() {},
    focus() {},
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

interface Options {
  hash?: string;
  stored?: string;
  /** Web-Gespräche in der Liste */
  web?: { id: string; title: string }[];
  /** Ohne sendBeacon (ältere Browser) */
  noBeacon?: boolean;
  /** Service Worker mit postMessage-Kanal (Issue #226, Schritt 3) */
  serviceWorker?: boolean;
  /** /api/conversations antwortet 401 (abgelaufene Anmeldung) */
  unauthorized?: boolean;
  /** Benachrichtigungen, die der Service Worker zeigt */
  notifications?: { data: any; closed?: boolean }[];
  /** Zustand der Rückfragen für die Stand-Abfrage */
  choiceStates?: Record<string, string>;
}

export interface PresenceBody {
  tab: string;
  seq: number;
  conversation: string | null;
  visible: boolean;
  gone?: boolean;
}

export function setupApp(options: Options = {}) {
  FakeEventSource.all = [];
  const elements: Record<string, Node> = {};
  const docListeners: Record<string, (() => void)[]> = {};
  const winListeners: Record<string, ((e: any) => void)[]> = {};
  const focus = { value: true };
  const document = {
    visibilityState: "visible",
    hasFocus: () => focus.value,
    getElementById(id: string) { return (elements[id] ??= node()); },
    createElement(tag: string) { const n = node(); n.tagName = tag; return n; },
    createElementNS() { return node(); },
    createDocumentFragment() { const f = node(); f.fragment = true; return f; },
    addEventListener(type: string, fn: () => void) { (docListeners[type] ??= []).push(fn); },
  };
  const intervals: (() => void)[] = [];
  const beacons: { path: string; body: PresenceBody }[] = [];
  const presence: PresenceBody[] = [];
  const beaconBodies: Promise<void>[] = [];
  const store: Record<string, string> = options.stored ? { "tybo-last-conversation": options.stored } : {};
  const swListeners: Record<string, ((e: any) => void)[]> = {};
  const started = { value: false };
  const notifications = (options.notifications ?? []).map(n => ({ ...n, closed: false, close() { this.closed = true; } }));
  const location = {
    href: "/",
    hash: options.hash ?? "",
    pathname: "/",
    search: "",
    reload() {},
  };
  const window: Record<string, any> = {
    TYBO_BRAND,
    isSecureContext: true,
    crypto: globalThis.crypto,
    navigator: {
      ...(options.noBeacon
        ? {}
        : {
            sendBeacon(path: string, blob: Blob) {
              beaconBodies.push(blob.text().then(t => { beacons.push({ path, body: JSON.parse(t) }); }));
              return true;
            },
          }),
      ...(options.serviceWorker
        ? {
            serviceWorker: {
              register: () => Promise.resolve({ update: () => Promise.resolve(), getNotifications: () => Promise.resolve(notifications.filter(n => !n.closed)) }),
              addEventListener(type: string, fn: (e: any) => void) { (swListeners[type] ??= []).push(fn); },
              startMessages() { started.value = true; },
            },
          }
        : {}),
    },
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ lineHeight: "22", paddingTop: "0", paddingBottom: "0", borderTopWidth: "0", borderBottomWidth: "0" }),
    addEventListener(type: string, fn: (e: any) => void) { (winListeners[type] ??= []).push(fn); },
    location,
    history: {
      replaceState(_s: unknown, _t: string, url: string) {
        const i = url.indexOf("#");
        location.hash = i >= 0 ? url.slice(i) : "";
      },
      back() {},
    },
  };

  const topics = [
    { id: "topic-8", title: "Recherche", agent: "research", lastActivity: "2026-09-28T10:00:00.000Z" },
    { id: "topic-9", title: "Strategie", agent: "strategy", lastActivity: "2026-09-28T09:00:00.000Z" },
  ];
  const web = options.web ?? [];
  const requests: string[] = [];
  /** Sitzung abgelaufen: /api/conversations antwortet ab jetzt 401 */
  const auth = { expired: !!options.unauthorized };
  const fetch = async (path: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? "GET";
    if (path === "/api/presence") {
      presence.push(JSON.parse(init!.body!));
      return new Response(null, { status: 204 });
    }
    requests.push(`${method} ${path}`);
    if (path === "/api/conversations" && method === "GET" && auth.expired) return Response.json({ error: "Nicht angemeldet" }, { status: 401 });
    const choiceQuery = /^\/api\/conversations\/([^/]+)\/choices\?ids=(.*)$/.exec(path);
    if (choiceQuery) {
      const ids = decodeURIComponent(choiceQuery[2]).split(",");
      return Response.json({ choices: ids.map(id => ({ id, options: [], state: options.choiceStates?.[id] ?? "expired" })) });
    }
    if (path === "/api/conversations" && method === "GET") {
      return Response.json({
        conversations: web.map(c => ({ ...c, agent: "general", createdAt: "2026-09-28T08:00:00.000Z", updatedAt: "2026-09-28T08:00:00.000Z" })),
        telegram: { dm: { id: "dm", title: "Direktchat", agent: "general", lastActivity: "2026-09-28T11:00:00.000Z" }, topics },
      });
    }
    if (path === "/api/logout") return Response.json({ ok: true });
    if (path === "/api/commands") return Response.json({ commands: [] });
    if (path.endsWith("/goal")) return Response.json({ card: null });
    if (/\/messages$/.test(path)) return Response.json({ messages: [], hasMore: false, running: false });
    return Response.json({ error: "unbekannt" }, { status: 404 });
  };

  const settings = { open: false };
  const createSettingsView = () => ({
    show() { settings.open = true; },
    hide() { settings.open = false; },
    isOpen: () => settings.open,
    hasUnsavedChanges: () => false,
  });
  const settingsTabFromHash = (hash: string) => (String(hash).startsWith("#/einstellungen") ? "agenten" : null);
  const settingsHash = (tab: string) => "#/einstellungen/" + tab;
  const setInterval = (fn: () => void) => { intervals.push(fn); return intervals.length; };
  const clearInterval = () => {};

  for (const id of ["attachments", "attach-note", "attach", "record", "recorder"]) {
    elements[id] = node();
    elements[id].hidden = true;
  }
  new Function(
    "document", "window", "fetch", "EventSource", "setInterval", "clearInterval",
    "createSettingsView", "settingsTabFromHash", "settingsHash", source
  )(document, window, fetch, FakeEventSource, setInterval, clearInterval, createSettingsView, settingsTabFromHash, settingsHash);

  const fireWindow = (type: string, event: any = {}) => { for (const fn of winListeners[type] ?? []) fn(event); };
  const setVisibility = (state: "visible" | "hidden") => {
    document.visibilityState = state;
    for (const fn of docListeners["visibilitychange"] ?? []) fn();
  };
  const entry = (id: string) => {
    for (const listId of ["dm-list", "topic-list", "older-list", "conversation-list"]) {
      const li = (elements[listId]?.children ?? []).find(l => l.children[0]?.attributes["data-id"] === id);
      if (li) return li.children[0];
    }
    throw new Error(`Eintrag ${id} fehlt`);
  };
  const openedStreams = () => FakeEventSource.all.filter(s => s.url !== ACTIVITY).map(s => s.url);
  return {
    elements, window, location, requests, presence, beacons, intervals, focus, settings, store, swListeners, started, notifications, auth,
    connection: () => (elements["connection"].hidden ? "" : elements["connection"].textContent),
    title: () => elements["chat-title"].textContent,
    swMessage: (data: unknown, ports: MessagePort[] = []) => { for (const fn of swListeners["message"] ?? []) fn({ data, ports }); },
    fireWindow, setVisibility, entry, openedStreams,
    beaconsDone: () => Promise.all(beaconBodies),
    last: () => presence.at(-1)!,
    hashChange: (hash: string) => { location.hash = hash; fireWindow("hashchange"); },
  };
}

export async function settle() {
  for (let i = 0; i < 30; i++) await Bun.sleep(0);
}

describe("Anwesenheit aus app.js (Issue #226)", () => {
  test("beim Laden und bei jedem Gesprächswechsel: offenes Gespräch, sichtbar, steigende Nummer, eine Tab-Kennung", async () => {
    const app = setupApp({ stored: "topic-8" });
    await settle();
    expect(app.last()).toEqual({ tab: expect.stringMatching(/^[0-9a-f]{32}$/), seq: expect.any(Number), conversation: "topic-8", visible: true });
    app.entry("topic-9").dispatch("click");
    await settle();
    expect(app.last().conversation).toBe("topic-9");
    const seqs = app.presence.map(p => p.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(new Set(app.presence.map(p => p.tab)).size).toBe(1);
  });

  test("verdeckt (visibilitychange), ohne Fokus (blur) und wieder da (focus, pageshow)", async () => {
    const app = setupApp({ stored: "dm" });
    await settle();
    app.setVisibility("hidden");
    expect(app.last()).toMatchObject({ conversation: "dm", visible: false });
    app.setVisibility("visible");
    expect(app.last()).toMatchObject({ conversation: "dm", visible: true });
    app.focus.value = false;
    app.fireWindow("blur");
    expect(app.last()).toMatchObject({ conversation: "dm", visible: false });
    app.focus.value = true;
    app.fireWindow("focus");
    expect(app.last()).toMatchObject({ conversation: "dm", visible: true });
  });

  test("Einstellungen: kein Gespräch; zurück im Chat wieder das offene", async () => {
    const app = setupApp({ stored: "dm" });
    await settle();
    app.hashChange("#/einstellungen/agenten");
    expect(app.settings.open).toBe(true);
    expect(app.last()).toMatchObject({ conversation: null });
    app.hashChange("");
    expect(app.last()).toMatchObject({ conversation: "dm", visible: true });
  });

  test("alle 30 Sekunden eine Meldung", async () => {
    const app = setupApp({ stored: "dm" });
    await settle();
    expect(app.intervals).toHaveLength(1);
    const before = app.presence.length;
    app.intervals[0]();
    expect(app.presence.length).toBe(before + 1);
    expect(app.last()).toMatchObject({ conversation: "dm", visible: true });
  });

  test("pagehide per sendBeacon mit gone; danach nichts mehr bis pageshow aus dem Zurück-Cache", async () => {
    const app = setupApp({ stored: "dm" });
    await settle();
    const count = app.presence.length;
    app.fireWindow("pagehide");
    await app.beaconsDone();
    expect(app.beacons).toHaveLength(1);
    expect(app.beacons[0].path).toBe("/api/presence");
    expect(app.beacons[0].body).toMatchObject({ gone: true, conversation: null, visible: false });
    app.fireWindow("focus");
    app.intervals[0]();
    expect(app.presence.length).toBe(count);
    app.fireWindow("pageshow");
    expect(app.last()).toMatchObject({ conversation: "dm", visible: true });
    expect(app.last().seq).toBeGreaterThan(app.beacons[0].body.seq);
  });

  test("ohne sendBeacon geht gone per fetch (keepalive)", async () => {
    const app = setupApp({ stored: "dm", noBeacon: true });
    await settle();
    app.fireWindow("pagehide");
    expect(app.last()).toMatchObject({ gone: true, visible: false });
  });

  test("Abmelden nimmt die Anwesenheit zurück, bevor abgemeldet wird", async () => {
    const app = setupApp({ stored: "dm" });
    await settle();
    app.elements["logout"].dispatch("click");
    await settle();
    await app.beaconsDone();
    expect(app.beacons.at(-1)!.body).toMatchObject({ gone: true });
    expect(app.requests).toContain("POST /api/logout");
  });
});

describe("Direktlink #/gespraech/<id> (Issue #226)", () => {
  test("beim Laden: genau dieses Gespräch statt des zuletzt geöffneten, danach ist die Adresse leer", async () => {
    const app = setupApp({ hash: `#/gespraech/${WEB_ID}`, stored: "topic-8", web: [{ id: WEB_ID, title: "Urlaub planen" }] });
    await settle();
    expect(app.openedStreams().at(-1)).toBe(`/api/conversations/${WEB_ID}/events`);
    expect(app.title()).toBe("Urlaub planen");
    expect(app.location.hash).toBe("");
    expect(app.connection()).toBe("");
    expect(app.store["tybo-last-conversation"]).toBe(WEB_ID);
  });

  test("Topic und Direktchat als Ziel", async () => {
    const app = setupApp({ hash: "#/gespraech/topic-9", stored: "topic-8" });
    await settle();
    expect(app.openedStreams().at(-1)).toBe("/api/conversations/topic-9/events");
  });

  test("unbekanntes oder gelöschtes Gespräch: Direktchat offen, Hinweis im Verbindungsbalken", async () => {
    for (const hash of ["#/gespraech/0b8f2a3c-1d2e-4f50-8a6b-7c8d9e0f1a2b", "#/gespraech/..%2Fx", "#/gespraech/%E0%A4%A"]) {
      const app = setupApp({ hash, stored: "topic-8" });
      await settle();
      expect(app.openedStreams().at(-1)).toBe("/api/conversations/dm/events");
      expect(app.connection()).toBe("Dieses Gespräch gibt es nicht mehr. Hier ist der Direktchat.");
      // Die Live-Verbindung steht: der Hinweis bleibt, bis das Gespräch wechselt
      for (const source of FakeEventSource.all) source.emit("open");
      await settle();
      expect(app.connection()).toBe("Dieses Gespräch gibt es nicht mehr. Hier ist der Direktchat.");
      app.entry("topic-9").dispatch("click");
      await settle();
      expect(app.connection()).toBe("");
    }
  });

  test("abgelaufene Anmeldung: Weiterleitung zur Anmeldung behält den Direktlink", async () => {
    const app = setupApp({ hash: `#/gespraech/${WEB_ID}`, unauthorized: true });
    await settle();
    expect(app.window.location.href).toBe(`/login#/gespraech/${WEB_ID}`);
  });

  test("später per Adresse (hashchange) oder aus den Einstellungen heraus", async () => {
    const app = setupApp({ stored: "topic-8", web: [{ id: WEB_ID, title: "Urlaub planen" }] });
    await settle();
    app.hashChange("#/gespraech/topic-9");
    await settle();
    expect(app.openedStreams().at(-1)).toBe("/api/conversations/topic-9/events");
    expect(app.location.hash).toBe("");
    app.hashChange("#/einstellungen/agenten");
    expect(app.settings.open).toBe(true);
    app.hashChange(`#/gespraech/${WEB_ID}`);
    await settle();
    expect(app.settings.open).toBe(false);
    expect(app.openedStreams().at(-1)).toBe(`/api/conversations/${WEB_ID}/events`);
  });

  test("Tipp auf eine Benachrichtigung bei offenem Fenster: Nachricht des Service Workers wechselt das Gespräch", async () => {
    const app = setupApp({ stored: "topic-8", serviceWorker: true });
    await settle();
    expect(app.started.value).toBe(true);
    app.swMessage({ type: "open-conversation", conversationId: "topic-9" });
    await settle();
    expect(app.openedStreams().at(-1)).toBe("/api/conversations/topic-9/events");
    const count = app.openedStreams().length;
    app.swMessage({ type: "anders", conversationId: "dm" });
    app.swMessage({ type: "open-conversation", conversationId: "../x" });
    await settle();
    expect(app.openedStreams().length).toBe(count);
    app.swMessage({ type: "open-conversation", conversationId: "0b8f2a3c-1d2e-4f50-8a6b-7c8d9e0f1a2b" });
    await settle();
    expect(app.openedStreams().at(-1)).toBe("/api/conversations/dm/events");
    expect(app.connection()).toBe("Dieses Gespräch gibt es nicht mehr. Hier ist der Direktchat.");
  });
});

describe("Tipp auf eine Benachrichtigung, Fenster zeigt die Offline-Seite (Issue #226)", () => {
  const ORIGIN = "https://app.example.org";
  const withoutHash = (url: string) => url.split("#")[0];

  /**
   * Ein Browser-Tab unter dem echten sw.js: zuerst die Offline-Seite unter /
   * (hört nicht auf Nachrichten, reagiert nicht auf Hash-Wechsel). navigate
   * wie im Browser: nur anderer Hash heißt kein Neuladen; sonst lädt die Seite,
   * und da tybo wieder erreichbar ist, kommt die Chat-App mit dieser Adresse.
   */
  function tab() {
    const state = { url: `${ORIGIN}/`, app: null as ReturnType<typeof setupApp> | null, loads: 0 };
    const win = {
      get url() { return state.url; },
      focused: true,
      postMessage(message: unknown, ports: MessagePort[] = []) { state.app?.swMessage(message, ports); },
      async focus() { return win; },
      async navigate(url: string) {
        const reload = withoutHash(url) !== withoutHash(state.url);
        state.url = url;
        if (reload) {
          state.loads++;
          const hash = new URL(url).hash;
          state.app = setupApp({ hash, stored: "topic-8", serviceWorker: true });
        } else if (state.app) {
          state.app.hashChange(new URL(url).hash);
        }
        return win;
      },
    };
    return { win, state };
  }

  async function worker(windows: unknown[]) {
    const template = await readFile(resolve(import.meta.dir, "..", "src", "web", "public", "sw.js"), "utf8");
    const listeners: Record<string, ((e: any) => void)[]> = {};
    const opened: string[] = [];
    const self = {
      location: new URL(`${ORIGIN}/sw.js`),
      addEventListener(type: string, fn: (e: any) => void) { (listeners[type] ??= []).push(fn); },
      registration: {},
      clients: { async matchAll() { return windows; }, async openWindow(url: string) { opened.push(url); return null; } },
    };
    new Function("self", "caches", "fetch", renderServiceWorker(template, "0123456789abcdef"))(self, {}, fetch);
    return {
      opened,
      async click(conversationId: string) {
        const waits: Promise<unknown>[] = [];
        const notification = { data: { url: `${ORIGIN}/#/gespraech/${conversationId}`, conversationId, category: "reply" }, close() {} };
        for (const fn of listeners["notificationclick"] ?? []) fn({ notification, waitUntil: (p: Promise<unknown>) => waits.push(p) });
        await Promise.all(waits);
      },
    };
  }

  test("tybo wieder erreichbar: genau das angeklickte Gespräch öffnet; danach wechselt die laufende App ohne Neuladen", async () => {
    const { win, state } = tab();
    const sw = await worker([win]);
    await sw.click("topic-9");
    await settle();
    expect(state.loads).toBe(1);
    expect(state.app).not.toBeNull();
    expect(state.app!.openedStreams().at(-1)).toBe("/api/conversations/topic-9/events");
    expect(state.app!.title()).toBe("Strategie");
    // Die App räumt die Adresse auf
    expect(state.app!.location.hash).toBe("");
    expect(sw.opened).toEqual([]);

    // Jetzt läuft die Chat-App: bestätigt und wechselt, kein zweites Laden
    await sw.click("dm");
    await settle();
    expect(state.loads).toBe(1);
    expect(state.app!.openedStreams().at(-1)).toBe("/api/conversations/dm/events");
  });
});

describe("Benachrichtigungen schließen beim Öffnen (Issue #226)", () => {
  test("das sichtbare Gespräch und entschiedene Rückfragen; offene Rückfragen und andere Antworten bleiben", async () => {
    const app = setupApp({
      stored: "topic-8",
      serviceWorker: true,
      choiceStates: { q1: "done", q2: "open" },
      notifications: [
        { data: { conversationId: "topic-8", category: "reply" } },
        { data: { conversationId: "dm", category: "choice", choiceId: "q1" } },
        { data: { conversationId: "topic-9", category: "choice", choiceId: "q2" } },
        { data: { conversationId: "topic-9", category: "reply" } },
        { data: { url: "/#/einstellungen/benachrichtigungen" } },
      ],
    });
    await settle();
    expect(app.notifications.map(n => n.closed)).toEqual([true, true, false, false, false]);
  });
});

const loginSource = await readFile(resolve(import.meta.dir, "..", "src", "web", "public", "login.js"), "utf8");

/** Anmeldung mit login.js: wohin sie danach weiterleitet */
async function login(hash: string) {
  const elements: Record<string, Node> = {};
  const document = { getElementById: (id: string) => (elements[id] ??= node()) };
  const window: Record<string, any> = { isSecureContext: false, navigator: {}, location: { href: "/login" + hash, hash } };
  const fetch = async () => Response.json({ ok: true });
  new Function("document", "window", "fetch", loginSource)(document, window, fetch);
  elements["password"].value = "geheim-genug";
  elements["password"].select = () => {};
  let submit: Promise<void> | undefined;
  for (const fn of elements["login-form"].listeners.submit) submit = fn({ preventDefault() {} }) as Promise<void>;
  await submit;
  return window.location.href;
}

describe("Anmeldung behält den Direktlink (login.js, Issue #226)", () => {
  test("Gespräch und Einstellungen bleiben, alles andere fällt weg", async () => {
    expect(await login(`#/gespraech/${WEB_ID}`)).toBe(`/#/gespraech/${WEB_ID}`);
    expect(await login("#/einstellungen/benachrichtigungen")).toBe("/#/einstellungen/benachrichtigungen");
    expect(await login("#javascript:alert(1)")).toBe("/");
    expect(await login("#/gespraech/a/b")).toBe("/");
    expect(await login("")).toBe("/");
  });
});

describe("Direktlink bei inzwischen abgelaufener Anmeldung (Issue #226, Prüfung PR #237)", () => {
  // Gültiges Ziel, das beim Laden der App noch nicht in der Liste stand
  const NEW_ID = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

  async function expireAndOpen(open: (app: ReturnType<typeof setupApp>) => void) {
    const app = setupApp({ stored: "topic-8", serviceWorker: true });
    await settle();
    const streams = app.openedStreams().length;
    app.auth.expired = true;
    open(app);
    await settle();
    // Zur Anmeldung mit genau diesem Ziel; kein Direktchat-Fallback, kein Hinweis danach
    expect(app.window.location.href).toBe(`/login#/gespraech/${NEW_ID}`);
    expect(app.openedStreams().length).toBe(streams);
    expect(app.title()).toBe("Recherche");
    expect(app.connection()).not.toBe("Dieses Gespräch gibt es nicht mehr. Hier ist der Direktchat.");
    expect(app.store["tybo-last-conversation"]).toBe("topic-8");
    // Nach der Anmeldung: die App lädt mit dem Direktlink und öffnet genau dieses Gespräch
    const next = await login(app.window.location.href.slice("/login".length));
    expect(next).toBe(`/#/gespraech/${NEW_ID}`);
    const after = setupApp({ hash: next.slice(1), stored: "topic-8", web: [{ id: NEW_ID, title: "Neu angelegt" }] });
    await settle();
    expect(after.openedStreams().at(-1)).toBe(`/api/conversations/${NEW_ID}/events`);
    expect(after.title()).toBe("Neu angelegt");
    expect(after.connection()).toBe("");
  }

  test("Tipp auf eine Benachrichtigung (Nachricht des Service Workers)", async () => {
    await expireAndOpen(app => app.swMessage({ type: "open-conversation", conversationId: NEW_ID }));
  });

  test("Adresse ändert sich (hashchange)", async () => {
    await expireAndOpen(app => app.hashChange(`#/gespraech/${NEW_ID}`));
  });
});
