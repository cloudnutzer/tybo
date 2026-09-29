// Attrappe für app.js am Handy (Issue #229): DOM, fetch, EventSource,
// caches, sessionStorage, Verlauf (history mit Zurück, popstate und
// hashchange), visualViewport und matchMedia für Schublade und Touch. Wie in
// web-app-attachments.test.ts ohne Browser; genutzt von web-app-share.test.ts
// und web-app-mobile.test.ts.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BRAND } from "../src/brand";
import { TYBO_BRAND } from "./brand-fixture";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
export const source = await readFile(resolve(publicDir, "app.js"), "utf8");
export const loginSource = await readFile(resolve(publicDir, "login.js"), "utf8");
export const html = await readFile(resolve(publicDir, "index.html"), "utf8");
export const css = await readFile(resolve(publicDir, "style.css"), "utf8");
const settingsSource = await readFile(resolve(publicDir, "settings.js"), "utf8");

export const ORIGIN = "https://app.example.org";
export const SHARE_CACHE = `${BRAND.cli}-teilen`;
export const DRAFT_CACHE = `${BRAND.cli}-entwuerfe`;
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
export const MINUTE = 60_000;

export interface Node {
  children: Node[];
  attributes: Record<string, string>;
  [key: string]: any;
}

export function node(): Node {
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
    set innerHTML(_v: string) {},
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
    clicks: 0,
    click() { this.clicks++; },
    focus() {},
    scrollIntoView() {},
  };
  return n;
}

export class FakeEventSource {
  static all: FakeEventSource[] = [];
  listeners: Record<string, ((e: any) => void)[]> = {};
  constructor(public url: string) { FakeEventSource.all.push(this); }
  addEventListener(type: string, fn: (e: any) => void) { (this.listeners[type] ??= []).push(fn); }
  close() {}
  emit(type: string, event: any = {}) { for (const fn of this.listeners[type] ?? []) fn(event); }
}

export const TOPICS = [
  { id: "topic-8", title: "Recherche", agent: "research", lastActivity: new Date().toISOString() },
  { id: "topic-9", title: "Strategie", agent: "strategy", lastActivity: new Date().toISOString() },
  { id: "topic-5", title: "Alt", agent: "general", lastActivity: new Date().toISOString(), closed: true },
];
export const WEB = "33333333-3333-4333-8333-333333333333";
export const WEB2 = "44444444-4444-4444-8444-444444444444";

/**
 * Cache-Attrappe (Cache Storage) mit echten Response-Objekten. hold(pass)
 * lässt noch pass Schreibvorgänge durch und hält alle weiteren put an
 * (langsames Gerät), bis die zurückgegebene Funktion sie freigibt; puts
 * zählt begonnene Schreibvorgänge.
 */
export function fakeCaches() {
  const store = new Map<string, Map<string, { blob: Blob; headers: Record<string, string> }>>();
  let gate: Promise<void> | null = null;
  let passing = 0;
  const state = { puts: 0 };
  const hold = (pass = 0) => {
    let release!: () => void;
    const held = new Promise<void>(resolve => (release = resolve));
    gate = held;
    passing = pass;
    return () => {
      if (gate === held) gate = null;
      release();
    };
  };
  const open = async (name: string) => {
    let e = store.get(name);
    if (!e) store.set(name, (e = new Map()));
    const entries = e;
    return {
      async keys() { return [...entries.keys()].map(url => ({ url })); },
      async match(r: { url: string } | string) {
        const s = entries.get(typeof r === "string" ? r : r.url);
        return s ? new Response(s.blob, { headers: s.headers }) : undefined;
      },
      async delete(r: { url: string } | string) { return entries.delete(typeof r === "string" ? r : r.url); },
      async put(url: string, res: Response) {
        state.puts++;
        const blob = await res.blob();
        if (gate) {
          if (passing > 0) passing--;
          else await gate;
        }
        entries.set(url, { blob, headers: Object.fromEntries(res.headers) });
      },
    };
  };
  return { store, open, hold, state, has: async (name: string) => store.has(name), delete: async (name: string) => store.delete(name) };
}

/**
 * Web-Locks-Attrappe (navigator.locks), von mehreren App-Instanzen geteilt
 * wie im Browser von mehreren Fenstern: exklusiv, mit ifAvailable und
 * Warten in Reihenfolge (ohne signal).
 */
export function fakeLocks() {
  const held = new Set<string>();
  const queues = new Map<string, (() => void)[]>();
  return {
    held,
    async request(name: string, options: { ifAvailable?: boolean } | ((lock: unknown) => unknown), callback?: (lock: unknown) => unknown) {
      const fn = typeof options === "function" ? options : callback!;
      const opts = typeof options === "function" ? {} : options;
      if (held.has(name)) {
        if (opts.ifAvailable) return fn(null);
        await new Promise<void>(resolve => {
          if (!queues.has(name)) queues.set(name, []);
          queues.get(name)!.push(resolve);
        });
      }
      held.add(name);
      try {
        return await fn({ name });
      } finally {
        const next = queues.get(name)?.shift();
        if (next) next();
        else held.delete(name);
      }
    },
  };
}

let idCounter = 0;
/** Kennung wie shareId in sw.js: Zeitpunkt in den ersten zwölf Stellen */
export function handoffId(at = Date.now()) {
  return Math.floor(at).toString(16).padStart(12, "0") + (++idCounter).toString(16).padStart(20, "0");
}

/** Legt eine Übergabe ab wie sw.js (Dateien zuerst, Beschreibung zuletzt) */
export async function putHandoff(
  caches: ReturnType<typeof fakeCaches>,
  content: { title?: string; text?: string; url?: string; files?: File[]; rejected?: unknown[]; at?: number }
) {
  const id = handoffId(content.at);
  const cache = await caches.open(SHARE_CACHE);
  const files = content.files ?? [];
  for (let i = 0; i < files.length; i++) {
    await cache.put(`${ORIGIN}/teilen/${id}/${i}`, new Response(files[i], { headers: { "Content-Type": files[i].type } }));
  }
  const meta = {
    v: 1,
    id,
    at: content.at ?? Date.now(),
    title: content.title ?? "",
    text: content.text ?? "",
    url: content.url ?? "",
    files: files.map((f, n) => ({ n, name: f.name, type: f.type, size: f.size, kind: f.type === "application/pdf" ? "document" : "image" })),
    rejected: content.rejected ?? [],
  };
  await cache.put(`${ORIGIN}/teilen/${id}`, new Response(JSON.stringify(meta), { headers: { "Content-Type": "application/json" } }));
  return id;
}

export interface Options {
  stored?: string;
  hash?: string;
  caches?: ReturnType<typeof fakeCaches>;
  session?: Record<string, string>;
  /** Solange gesetzt, wartet GET /api/conversations darauf */
  listGate?: Promise<void>;
  conversations?: unknown[];
  topics?: unknown[];
  /** Sitzung abgelaufen: GET /api/conversations antwortet 401 */
  expired?: boolean;
  /** Schmales Fenster unter 56rem (Schublade) */
  narrow?: boolean;
  /** Touch-Gerät (pointer: coarse) */
  touch?: boolean;
  /** Verlauf wie im Browser (pushState, back, popstate); ohne: nur replaceState */
  browserHistory?: boolean;
  /** Start-Zustand des aktuellen Verlaufseintrags (Neuladen) */
  historyState?: unknown;
  /** Sichtbarer Bereich; die Attrappe feuert resize bei setViewport */
  viewport?: { height: number; offsetTop?: number; scale?: number };
  /** Layout-Höhe (documentElement.clientHeight) */
  layoutHeight?: number;
  /** settings.js mitladen (Einstellungen öffnen) */
  withSettings?: boolean;
  /** Geteilte Web Locks (zwei Fenster); ohne: eigene. null: Browser ohne Web Locks */
  locks?: ReturnType<typeof fakeLocks> | null;
  /** Solange gesetzt, warten Uploads darauf */
  uploadGate?: Promise<void>;
  /** Solange gesetzt, wartet POST …/messages darauf */
  postGate?: Promise<void>;
  /** POST …/messages scheitert mit 500 */
  postFails?: boolean;
  /** Echte Zeitgeber statt stiller (Warten und Nachsehen in app.js) */
  timers?: boolean;
}

/** Eintrag im Verlauf der Attrappe */
export interface HistoryEntry {
  state: unknown;
  url: string;
}

export function setup(options: Options = {}) {
  FakeEventSource.all = [];
  const elements: Record<string, Node> = {};
  const documentListeners: Record<string, ((e: any) => void)[]> = {};
  const document = {
    activeElement: null as Node | null,
    visibilityState: "visible",
    addEventListener(type: string, fn: (e: any) => void) { (documentListeners[type] ??= []).push(fn); },
    getElementById(id: string) { return (elements[id] ??= node()); },
    createElement(tag: string) { const n = node(); n.tagName = tag; return n; },
    createDocumentFragment() { const f = node(); f.fragment = true; return f; },
  };
  const store: Record<string, string> = { "tybo-last-conversation": options.stored ?? "topic-8" };
  const session: Record<string, string> = { ...(options.session ?? {}) };
  const windowListeners: Record<string, ((e: any) => void)[]> = {};
  const caches = options.caches ?? fakeCaches();
  const fire = (type: string, event: any = {}) => { for (const fn of windowListeners[type] ?? []) fn(event); };
  /**
   * Verlauf wie im Browser: Einträge mit Zustand und Adresse. Setzen von
   * location.hash legt einen Eintrag ohne Zustand an und meldet popstate und
   * hashchange; back() wechselt später (nach einem Mikrotask) den Eintrag und
   * meldet popstate, bei anderem Hash auch hashchange. Zurück vom ersten
   * Eintrag verlässt die App (exited).
   */
  const nav = {
    entries: [{ state: options.historyState ?? null, url: "/" + (options.hash ?? "") }] as HistoryEntry[],
    index: 0,
    exited: false,
    pushes: 0,
  };
  const hashOf = (url: string) => (url.includes("#") ? url.slice(url.indexOf("#")) : "");
  const location: Record<string, any> = {
    href: "/",
    pathname: "/",
    search: "",
    get hash() { return hashOf(nav.entries[nav.index].url); },
    set hash(value: string) {
      const next = value && !value.startsWith("#") ? "#" + value : value;
      if (next === this.hash) return;
      nav.entries = nav.entries.slice(0, nav.index + 1).concat({ state: null, url: "/" + next });
      nav.index++;
      fire("popstate", { state: null });
      fire("hashchange");
    },
  };
  const history: Record<string, any> = {
    get state() { return nav.entries[nav.index].state; },
    replaceState(state: unknown, _t: string, url: string) {
      nav.entries[nav.index] = { state: state ?? null, url };
    },
  };
  if (options.browserHistory) {
    history.pushState = (state: unknown, _t: string, url: string) => {
      nav.entries = nav.entries.slice(0, nav.index + 1).concat({ state: state ?? null, url });
      nav.index++;
      nav.pushes++;
    };
    history.back = () => {
      if (nav.index === 0) {
        nav.exited = true;
        return;
      }
      const before = location.hash;
      nav.index--;
      const entry = nav.entries[nav.index];
      void Promise.resolve().then(() => {
        fire("popstate", { state: entry.state });
        if (hashOf(entry.url) !== before) fire("hashchange");
      });
    };
  }
  const vvListeners: Record<string, ((e: any) => void)[]> = {};
  const visualViewport = options.viewport
    ? {
        height: options.viewport.height,
        offsetTop: options.viewport.offsetTop ?? 0,
        scale: options.viewport.scale ?? 1,
        addEventListener(type: string, fn: (e: any) => void) { (vvListeners[type] ??= []).push(fn); },
      }
    : undefined;
  /** Tastatur auf oder zu: sichtbaren Bereich ändern, resize melden */
  const setViewport = (next: { height: number; offsetTop?: number; scale?: number }) => {
    Object.assign(visualViewport!, { offsetTop: 0, scale: 1 }, next);
    for (const fn of vvListeners["resize"] ?? []) fn({});
  };
  const rootStyle: Record<string, string> = {};
  (document as any).documentElement = {
    clientHeight: options.layoutHeight ?? 844,
    style: {
      setProperty: (name: string, value: string) => { rootStyle[name] = value; },
      removeProperty: (name: string) => { delete rootStyle[name]; },
    },
  };
  const window: Record<string, any> = {
    TYBO_BRAND,
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
    },
    sessionStorage: {
      getItem: (key: string) => session[key] ?? null,
      setItem: (key: string, value: string) => { session[key] = value; },
      removeItem: (key: string) => { delete session[key]; },
    },
    caches,
    navigator: options.locks === null ? {} : { locks: options.locks ?? fakeLocks() },
    visualViewport,
    matchMedia: (query: string) => ({
      matches: (!!options.narrow && query === "(max-width: 55.99rem)") || (!!options.touch && query === "(pointer: coarse)"),
    }),
    getComputedStyle: () => ({ lineHeight: "22", paddingTop: "0", paddingBottom: "0", borderTopWidth: "0", borderBottomWidth: "0" }),
    addEventListener(type: string, fn: (e: any) => void) { (windowListeners[type] ??= []).push(fn); },
    location,
    history,
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
  };
  const server = {
    requests: [] as { method: string; path: string; body: unknown }[],
    posts: () => server.requests.filter(r => r.method === "POST" && r.path.endsWith("/messages")),
    uploads: () => server.requests.filter(r => r.method === "POST" && r.path.endsWith("/attachments")),
  };
  let counter = 0;
  const fetch = async (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
    if (path === "/api/presence") return { ok: true, status: 204, json: async () => ({}) } as any;
    const method = init?.method ?? "GET";
    server.requests.push({ method, path, body: init?.body });
    if (path === "/api/conversations" && method === "GET") {
      if (options.listGate) await options.listGate;
      if (options.expired) return Response.json({ error: "Nicht angemeldet" }, { status: 401 });
      return Response.json({
        conversations: options.conversations ?? [{ id: WEB, agent: "general", title: "Betrieb" }],
        telegram: { dm: null, topics: options.topics ?? TOPICS },
      });
    }
    if (path === "/api/commands") return Response.json({ commands: [] });
    if (path.endsWith("/goal")) return Response.json({ card: null });
    if (path === "/api/conversations" && method === "POST") {
      return Response.json({ conversation: { id: WEB2, agent: "general", title: "Neues Gespräch" } }, { status: 201 });
    }
    const up = path.match(/^\/api\/conversations\/([^/]+)\/attachments$/);
    if (up && method === "POST") {
      if (options.uploadGate) await options.uploadGate;
      counter++;
      return Response.json({ id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`, name: "x.png", size: 10, mime: "image/png", kind: "image" }, { status: 201 });
    }
    const m = path.match(/^\/api\/conversations\/([^/?]+)\/messages$/);
    if (m && method === "POST") {
      if (options.postGate) await options.postGate;
      if (options.postFails) return Response.json({ error: "Interner Fehler" }, { status: 500 });
      const body = JSON.parse(init!.body as string);
      return Response.json({ message: { id: `u${++counter}`, role: "user", text: body.text, createdAt: new Date().toISOString() } }, { status: 202 });
    }
    if (m) return Response.json({ messages: [], hasMore: false, running: false });
    return Response.json({ error: "unbekannt" }, { status: 404 });
  };

  elements["chat-log"] = node();
  for (const id of ["attachments", "attach-note", "attach", "share-note", "attach-menu"]) {
    elements[id] = node();
    elements[id].hidden = true;
  }
  new Function("document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout", "File", options.withSettings ? `${settingsSource}\n${source}` : source)(
    document, window, fetch, FakeEventSource, options.timers ? setTimeout : () => 0, options.timers ? clearTimeout : () => {}, File
  );

  const input = elements["input"];
  const chipNames = () => elements["attachments"].children.map(c => find(c, "attachment-name")!.textContent);
  const note = () => (elements["attach-note"].hidden ? "" : elements["attach-note"].textContent);
  const shareLine = () => (elements["share-note"].hidden ? "" : elements["share-note"] && elements["share-text"].textContent);
  const entry = (id: string) => {
    for (const listId of ["dm-list", "topic-list", "older-list", "conversation-list"]) {
      const li = (elements[listId]?.children ?? []).find(l => l.children[0]?.attributes["data-id"] === id);
      if (li) return li.children[0];
    }
    throw new Error(`Eintrag ${id} fehlt`);
  };
  const title = () => elements["chat-title"].textContent;
  const submit = () => elements["composer"].dispatch("submit", { preventDefault() {} });
  const drawerOpen = () => elements["sidebar"].attributes["data-open"] === "true";
  /** Zurück-Knopf des Systems */
  const back = () => (history.back ? history.back() : undefined);
  /** App verborgen (Wechsel in eine andere App) oder wieder sichtbar */
  const setVisibility = (value: "hidden" | "visible") => {
    document.visibilityState = value;
    for (const fn of documentListeners["visibilitychange"] ?? []) fn({});
  };
  /** Wisch von (x0, y0) nach (x1, y1) */
  const swipe = (x0: number, y0: number, x1: number, y1: number, target: any = null) => {
    fire("touchstart", { touches: [{ clientX: x0, clientY: y0 }], target });
    fire("touchend", { changedTouches: [{ clientX: x1, clientY: y1 }], target });
  };
  return {
    elements, input, server, caches, session, location, history, nav, fire, chipNames, note, shareLine, entry, title, submit,
    drawerOpen, back, swipe, setViewport, rootStyle, windowListeners, setVisibility,
  };
}

export async function settle() {
  for (let i = 0; i < 60; i++) await Bun.sleep(0);
}

export function all(n: Node): Node[] {
  return [n, ...n.children.flatMap(all)];
}
export function find(n: Node, cls: string): Node | undefined {
  return all(n).find(c => String(c.className).split(" ").includes(cls));
}

export function png(name: string, size = 40): File {
  return new File([new Uint8Array([...PNG_HEAD, ...new Array(size - 8).fill(7)])], name, { type: "image/png" });
}

/** Entwurfs-Stände im Gerät */
export async function draftKeys(caches: ReturnType<typeof fakeCaches>) {
  return [...(caches.store.get(DRAFT_CACHE)?.keys() ?? [])].filter(key => key.startsWith("/entwurf/"));
}

export async function shareKeys(caches: ReturnType<typeof fakeCaches>) {
  return [...(caches.store.get(SHARE_CACHE)?.keys() ?? [])];
}
