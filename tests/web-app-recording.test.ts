// Sprachaufnahme im Browser (app.js, Issue #109): Knopf nur im sicheren
// Kontext, Aufnahme-Ablauf mit Attrappen für getUserMedia und MediaRecorder,
// Anhang aus der Aufnahme über die bestehende Upload-Route. Ohne Browser:
// DOM-, fetch- und EventSource-Attrappen wie in web-app-attachments.test.ts,
// dazu eine steuerbare Uhr (setSystemTime plus eigene Timer-Warteschlange).
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TYBO_BRAND } from "./brand-fixture";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const source = await readFile(resolve(publicDir, "app.js"), "utf8");
const html = await readFile(resolve(publicDir, "index.html"), "utf8");
const css = await readFile(resolve(publicDir, "style.css"), "utf8");
const recordings = resolve(import.meta.dir, "fixtures", "recordings");
const WEBM = new Uint8Array(await readFile(resolve(recordings, "chrome-opus.webm")));
const MP4 = new Uint8Array(await readFile(resolve(recordings, "fragmented-iso5-aac.mp4")));

const START = new Date(2026, 8, 25, 13, 4, 5).getTime();
/** Reines Web-Gespräch mit UUID (Issue #112) */
const WEB = "33333333-3333-4333-8333-333333333333";
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

class FakeTrack {
  stopped = false;
  stop() { this.stopped = true; }
}

class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() { return this.tracks; }
}

interface Deferred<T> { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function domError(name: string) {
  const err = new Error(name);
  err.name = name;
  return err;
}

interface Options {
  secure?: boolean;
  /** false: navigator.mediaDevices fehlt */
  devices?: boolean;
  /** false: window.MediaRecorder fehlt */
  recorder?: boolean;
  /** Formate, die isTypeSupported bejaht */
  supported?: string[];
  /** Antwort auf getUserMedia: Stream sofort, Fehler, oder von Hand (deferred) */
  microphone?: "grant" | "deny" | "missing" | "busy" | "manual";
  /** Fehler beim Anlegen oder Starten des Recorders */
  recorderFails?: "create" | "start";
  stored?: string;
  closedTopic?: boolean;
}

interface Request { method: string; path: string; headers: Record<string, string>; body: unknown }

let uuidCounter = 0;
function uuid(): string {
  uuidCounter++;
  return `00000000-0000-4000-8000-${String(uuidCounter).padStart(12, "0")}`;
}

function setup(options: Options = {}) {
  setSystemTime(new Date(START));
  FakeEventSource.all = [];
  const elements: Record<string, Node> = {};
  const created: Node[] = [];
  const document = {
    activeElement: null as Node | null,
    getElementById(id: string) { return (elements[id] ??= node()); },
    createElement(tag: string) {
      const n = node();
      n.tagName = tag;
      if (tag === "audio") {
        n.paused = true;
        n.ended = false;
        n.plays = 0;
        n.play = () => { n.plays++; n.paused = false; n.dispatch("play"); return Promise.resolve(); };
        n.pause = () => { if (!n.paused) { n.paused = true; n.dispatch("pause"); } };
      }
      created.push(n);
      return n;
    },
    createElementNS() { return node(); },
    createDocumentFragment() { const f = node(); f.fragment = true; return f; },
  };

  // Steuerbare Timer: laufen nur, wenn advance die Uhr vorstellt
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

  // Mikrofon und Recorder
  const streams: FakeStream[] = [];
  const microphoneCalls: Deferred<FakeStream>[] = [];
  const recorders: any[] = [];
  const supported = options.supported ?? ["audio/webm;codecs=opus", "audio/mp4"];
  class FakeMediaRecorder {
    static isTypeSupported(type: string) { return supported.includes(type); }
    state = "inactive";
    ondataavailable: ((e: any) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: ((e: any) => void) | null = null;
    mimeType: string;
    stops = 0;
    constructor(public stream: FakeStream, init: { mimeType: string }) {
      if (options.recorderFails === "create") throw domError("NotSupportedError");
      this.mimeType = init.mimeType;
      recorders.push(this);
    }
    start() {
      if (options.recorderFails === "start") throw domError("InvalidStateError");
      this.state = "recording";
    }
    stop() {
      if (this.state === "inactive") throw domError("InvalidStateError");
      this.state = "inactive";
      this.stops++;
    }
    /** Wie der Browser nach stop(): letzte Daten, dann das stop-Ereignis */
    deliver(...parts: Uint8Array[]) {
      for (const p of parts) this.ondataavailable?.({ data: new Blob([p]) });
      this.onstop?.();
    }
  }
  const mediaDevices = {
    getUserMedia(constraints: unknown) {
      expect(constraints).toEqual({ audio: true });
      const mode = options.microphone ?? "grant";
      if (mode === "deny") return Promise.reject(domError("NotAllowedError"));
      if (mode === "missing") return Promise.reject(domError("NotFoundError"));
      if (mode === "busy") return Promise.reject(domError("NotReadableError"));
      const stream = new FakeStream();
      streams.push(stream);
      if (mode === "grant") return Promise.resolve(stream);
      const d = deferred<FakeStream>();
      microphoneCalls.push(d);
      return d.promise.then(() => stream);
    },
  };
  const urls = { created: [] as string[], revoked: [] as string[] };
  const windowListeners: Record<string, ((e: any) => void)[]> = {};
  const store: Record<string, string> = { "tybo-last-conversation": options.stored ?? "topic-8" };
  const window: Record<string, any> = {
    TYBO_BRAND,
    isSecureContext: options.secure ?? true,
    navigator: options.devices === false ? {} : { mediaDevices },
    ...(options.recorder === false ? {} : { MediaRecorder: FakeMediaRecorder }),
    URL: {
      createObjectURL: () => { const u = `blob:https://app.tybo.ai/${uuid()}`; urls.created.push(u); return u; },
      revokeObjectURL: (u: string) => { urls.revoked.push(u); },
    },
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
    },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ lineHeight: "22", paddingTop: "0", paddingBottom: "0", borderTopWidth: "0", borderBottomWidth: "0" }),
    addEventListener(type: string, fn: (e: any) => void) { (windowListeners[type] ??= []).push(fn); },
    location: { href: "/", hash: "" },
  };

  const topics = [
    { id: "topic-8", title: "Recherche", agent: "research", lastActivity: new Date(START).toISOString(), ...(options.closedTopic ? { closed: true } : {}) },
    { id: "topic-9", title: "Strategie", agent: "strategy", lastActivity: new Date(START).toISOString() },
  ];
  const server = {
    requests: [] as Request[],
    uploads: () => server.requests.filter(r => r.method === "POST" && r.path.endsWith("/attachments")),
    posts: () => server.requests.filter(r => r.method === "POST" && r.path.endsWith("/messages")),
  };
  let counter = 0;
  const fetch = async (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
    // Anwesenheit (Issue #226) läuft nebenher und zählt hier nicht mit
    if (path === "/api/presence") return { ok: true, status: 204, json: async () => ({}) } as any;
    const method = init?.method ?? "GET";
    server.requests.push({ method, path, headers: init?.headers ?? {}, body: init?.body });
    if (path === "/api/conversations" && method === "GET") {
      return Response.json({ conversations: [{ id: WEB, agent: "general", title: "Betrieb" }], telegram: { dm: null, topics } });
    }
    if (path === "/api/me") return Response.json({ authenticated: true });
    if (path === "/api/commands") return Response.json({ commands: [] });
    if (path.endsWith("/goal")) return Response.json({ card: null });
    if (/^\/api\/conversations\/[^/]+\/attachments$/.test(path) && method === "POST") {
      const blob = init!.body as Blob;
      return Response.json({ id: uuid(), name: decodeURIComponent(init!.headers!["X-File-Name"]), size: blob.size, mime: blob.type, kind: "audio" }, { status: 201 });
    }
    const m = path.match(/^\/api\/conversations\/([^/?]+)\/messages$/);
    if (m && method === "POST") {
      const body = JSON.parse(init!.body as string);
      return Response.json({ message: { id: `u${++counter}`, role: "user", text: body.text, createdAt: new Date().toISOString() } }, { status: 202 });
    }
    if (m) return Response.json({ messages: [], hasMore: false, running: false });
    return Response.json({ error: "unbekannt" }, { status: 404 });
  };

  for (const id of ["attachments", "attach-note", "attach", "record", "recorder"]) {
    elements[id] = node();
    elements[id].hidden = true;
  }
  new Function("document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout", source)(
    document, window, fetch, FakeEventSource, setTimeout, clearTimeout
  );

  const input = elements["input"];
  const record = elements["record"];
  const chips = () => elements["attachments"].children;
  const note = () => (elements["attach-note"].hidden ? "" : elements["attach-note"].textContent);
  const entry = (id: string) => {
    for (const listId of ["dm-list", "topic-list", "older-list", "conversation-list"]) {
      const li = (elements[listId]?.children ?? []).find(l => l.children[0]?.attributes["data-id"] === id);
      if (li) return li.children[0];
    }
    throw new Error(`Eintrag ${id} fehlt`);
  };
  const recorderShown = () => !elements["recorder"].hidden;
  const time = () => elements["recorder-time"].textContent;
  const type = (value: string) => {
    input.value = value;
    input.dispatch("input");
  };
  const submit = () => elements["composer"].dispatch("submit", { preventDefault() {} });
  const enter = () => input.dispatch("keydown", { key: "Enter", shiftKey: false, isComposing: false, keyCode: 13, preventDefault() {}, stopPropagation() {} });
  return {
    elements, input, record, chips, note, entry, recorderShown, time, type, submit, enter, server, streams, recorders, microphoneCalls,
    urls, created, windowListeners, advance, timers,
    tapRecord: () => record.dispatch("click"),
    tapStop: () => elements["recorder-stop"].dispatch("click"),
    tapDiscard: () => elements["recorder-discard"].dispatch("click"),
  };
}

async function settle() {
  for (let i = 0; i < 30; i++) await Bun.sleep(0);
}

function all(n: Node): Node[] {
  return [n, ...n.children.flatMap(all)];
}
function find(n: Node, cls: string): Node | undefined {
  return all(n).find(c => String(c.className).split(" ").includes(cls));
}
const allStopped = (streams: FakeStream[]) => streams.every(s => s.tracks.every(t => t.stopped));

describe("Knopf nur im sicheren Kontext (Issue #109, Schritt 1)", () => {
  test("HTTPS mit Mikrofon und MediaRecorder: Knopf im Telegram-Gespräch und (Issue #112) im reinen Web-Gespräch", async () => {
    const app = setup();
    await settle();
    expect(app.record.hidden).toBe(false);
    expect(app.record.disabled).toBe(false);
    expect(app.recorderShown()).toBe(false);
    app.entry(WEB).dispatch("click");
    await settle();
    expect(app.record.hidden).toBe(false);
    expect(app.record.disabled).toBe(false);
  });

  test("ohne sicheren Kontext (http im Heimnetz) kein Knopf, auch nicht im Web-Gespräch", async () => {
    for (const stored of ["topic-8", WEB]) {
      const app = setup({ secure: false, stored });
      await settle();
      expect(app.record.hidden).toBe(true);
      // Die Büroklammer bleibt wie bisher
      expect(app.elements["attach"].hidden).toBe(false);
    }
  });

  test("ohne navigator.mediaDevices oder ohne MediaRecorder kein Knopf", async () => {
    for (const app of [setup({ devices: false }), setup({ recorder: false })]) {
      await settle();
      expect(app.record.hidden).toBe(true);
    }
  });

  test("geschlossenes Topic: Knopf gesperrt", async () => {
    const app = setup({ closedTopic: true });
    await settle();
    expect(app.record.hidden).toBe(false);
    expect(app.record.disabled).toBe(true);
  });

  test("index.html: Mikrofon rechts in der Box vor Senden, versteckt; Aufnahme-Zeile mit Punkt, Zeit, Verwerfen, Stopp", () => {
    const box = html.slice(html.indexOf('<div class="composer-box">'), html.indexOf("</form>"));
    expect(box.indexOf("<textarea")).toBeLessThan(box.indexOf('id="record"'));
    expect(box.indexOf('id="record"')).toBeLessThan(box.indexOf('id="send"'));
    expect(box).toMatch(/<button[^>]*id="record"[^>]*aria-label="Sprachaufnahme starten"[^>]*hidden>/);
    expect(box).toMatch(/<div id="recorder"[^>]*hidden>/);
    for (const part of ['class="recorder-dot"', 'id="recorder-time"', ">Verwerfen<", ">Stopp<"]) expect(box).toContain(part);
  });

  test("style.css: Aufnahme ohne Animation und ohne neue Farben; Rot nur für den Punkt", () => {
    const start = css.indexOf("Sprachaufnahme (Issue #109)");
    // Ab dem Ende des einleitenden Kommentars bis zum nächsten Abschnitt
    const block = css.slice(css.indexOf("*/", start) + 2, css.indexOf("/* Dateien über dem Chat", start));
    expect(start).toBeGreaterThan(0);
    const rules = block.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(rules).not.toMatch(/#[0-9a-f]{3,6}\b|animation|transition|@keyframes/i);
    expect(rules.match(/var\(--error\)/g)).toHaveLength(1);
    expect(rules).toMatch(/\.recorder-dot \{[^}]*var\(--error\)/);
  });
});

describe("Aufnahme-Ablauf (Issue #109, Schritt 2)", () => {
  test("Antippen fragt das Mikrofon an und startet WebM; Zeile mit Zeit statt Feld; die Zeit läuft mit der Uhr", async () => {
    const app = setup();
    await settle();
    app.tapRecord();
    await settle();
    expect(app.streams).toHaveLength(1);
    expect(app.recorders).toHaveLength(1);
    expect(app.recorders[0].mimeType).toBe("audio/webm;codecs=opus");
    expect(app.recorders[0].state).toBe("recording");
    expect(app.recorderShown()).toBe(true);
    expect(app.input.hidden).toBe(true);
    expect(app.record.hidden).toBe(true);
    expect(app.elements["send"].hidden).toBe(true);
    expect(app.elements["attach"].hidden).toBe(true);
    expect(app.time()).toBe("00:00");
    app.advance(1000);
    expect(app.time()).toBe("00:01");
    app.advance(64_000);
    expect(app.time()).toBe("01:05");
  });

  test("Formatwahl: das erste unterstützte (Safari: audio/mp4); keins: Meldung, kein Mikrofon", async () => {
    const safari = setup({ supported: ["audio/mp4"] });
    await settle();
    safari.tapRecord();
    await settle();
    expect(safari.recorders[0].mimeType).toBe("audio/mp4");
    const none = setup({ supported: [] });
    await settle();
    none.tapRecord();
    await settle();
    expect(none.streams).toHaveLength(0);
    expect(none.note()).toContain("kann hier keine Sprache aufnehmen");
    expect(none.recorderShown()).toBe(false);
  });

  test("Stopp: letzte Daten abwarten, genau ein Audio-Chip; alle Spuren stoppen", async () => {
    const app = setup();
    await settle();
    app.tapRecord();
    await settle();
    app.advance(12_400);
    app.tapStop();
    const rec = app.recorders[0];
    expect(rec.stops).toBe(1);
    expect(allStopped(app.streams)).toBe(true);
    // Noch kein Chip, solange das stop-Ereignis fehlt
    expect(app.chips()).toHaveLength(0);
    rec.deliver(WEBM.subarray(0, 4000), WEBM.subarray(4000));
    await settle();
    expect(app.chips()).toHaveLength(1);
    expect(app.recorderShown()).toBe(false);
    expect(app.input.hidden).toBe(false);
    expect(app.record.hidden).toBe(false);
    const chip = app.chips()[0];
    expect(find(chip, "attachment-name")!.textContent).toBe("aufnahme-20260925-130405.webm");
    expect(find(chip, "attachment-meta")!.textContent).toMatch(/^00:12 · /);
    // Ein zweites, verspätetes stop-Ereignis hängt nichts mehr an
    rec.onstop?.();
    await settle();
    expect(app.chips()).toHaveLength(1);
  });

  test("Verwerfen: kein Chip, Spuren gestoppt, Recorder angehalten; späte Daten bleiben folgenlos", async () => {
    const app = setup();
    await settle();
    app.tapRecord();
    await settle();
    app.advance(3000);
    const rec = app.recorders[0];
    const { ondataavailable, onstop } = rec;
    app.tapDiscard();
    expect(allStopped(app.streams)).toBe(true);
    expect(rec.state).toBe("inactive");
    expect(app.recorderShown()).toBe(false);
    expect(app.input.hidden).toBe(false);
    ondataavailable({ data: new Blob([WEBM]) });
    onstop();
    await settle();
    expect(app.chips()).toHaveLength(0);
    expect(app.note()).toBe("");
    // Kein Timer tickt weiter
    app.advance(10 * 60_000);
    expect(app.chips()).toHaveLength(0);
  });

  test("Höchstdauer 5 Minuten: stoppt von selbst, Chip mit 05:00", async () => {
    const app = setup();
    await settle();
    app.tapRecord();
    await settle();
    app.advance(4 * 60_000 + 59_000);
    expect(app.recorders[0].state).toBe("recording");
    expect(app.time()).toBe("04:59");
    app.advance(1000);
    expect(app.recorders[0].state).toBe("inactive");
    expect(app.recorders[0].stops).toBe(1);
    expect(allStopped(app.streams)).toBe(true);
    expect(app.time()).toBe("05:00");
    app.recorders[0].deliver(WEBM);
    await settle();
    expect(app.chips()).toHaveLength(1);
    expect(find(app.chips()[0], "attachment-meta")!.textContent).toMatch(/^05:00 · /);
  });

  test("verweigerte Freigabe: Meldung am Eingabefeld, nichts gesendet, nichts angehängt", async () => {
    const app = setup({ microphone: "deny" });
    await settle();
    app.tapRecord();
    await settle();
    expect(app.note()).toContain("Kein Zugriff auf das Mikrofon");
    expect(app.note()).toContain("Nichts gesendet");
    expect(app.recorders).toHaveLength(0);
    expect(app.recorderShown()).toBe(false);
    expect(app.chips()).toHaveLength(0);
    expect(app.server.uploads()).toHaveLength(0);
    expect(app.server.posts()).toHaveLength(0);
    // Noch einmal antippen geht
    expect(app.record.disabled).toBe(false);
  });

  test("kein Mikrofon, belegtes Mikrofon, Recorder startet nicht: je eine Meldung, Spuren frei", async () => {
    const missing = setup({ microphone: "missing" });
    await settle();
    missing.tapRecord();
    await settle();
    expect(missing.note()).toBe("Kein Mikrofon gefunden. Nichts gesendet.");
    const busy = setup({ microphone: "busy" });
    await settle();
    busy.tapRecord();
    await settle();
    expect(busy.note()).toContain("ließ sich nicht starten");
    for (const fails of ["create", "start"] as const) {
      const app = setup({ recorderFails: fails });
      await settle();
      app.tapRecord();
      await settle();
      expect(app.note()).toContain("ließ sich nicht starten");
      expect(allStopped(app.streams)).toBe(true);
      expect(app.recorderShown()).toBe(false);
      expect(app.chips()).toHaveLength(0);
    }
  });

  test("Recorder-Fehler während der Aufnahme: verworfen, Meldung, Spuren frei, kein Chip", async () => {
    const app = setup();
    await settle();
    app.tapRecord();
    await settle();
    app.recorders[0].onerror({ error: domError("UnknownError") });
    expect(app.note()).toContain("abgebrochen");
    expect(allStopped(app.streams)).toBe(true);
    expect(app.recorderShown()).toBe(false);
    await settle();
    expect(app.chips()).toHaveLength(0);
  });

  test("leere Aufnahme: Meldung, kein Chip", async () => {
    const app = setup();
    await settle();
    app.tapRecord();
    await settle();
    app.tapStop();
    app.recorders[0].deliver();
    await settle();
    expect(app.chips()).toHaveLength(0);
    expect(app.note()).toBe("Die Aufnahme ist leer. Nichts angehängt.");
  });

  test("Gesprächswechsel während der Aufnahme: verworfen, alle Spuren gestoppt, nichts im neuen Gespräch", async () => {
    const app = setup();
    await settle();
    app.tapRecord();
    await settle();
    const rec = app.recorders[0];
    const { ondataavailable, onstop } = rec;
    app.entry("topic-9").dispatch("click");
    await settle();
    expect(allStopped(app.streams)).toBe(true);
    expect(rec.state).toBe("inactive");
    expect(app.recorderShown()).toBe(false);
    ondataavailable({ data: new Blob([WEBM]) });
    onstop();
    await settle();
    expect(app.chips()).toHaveLength(0);
    app.entry("topic-8").dispatch("click");
    await settle();
    expect(app.chips()).toHaveLength(0);
  });

  test("Gesprächswechsel nach Stopp, bevor die letzten Daten da sind: kein Chip, weder hier noch dort", async () => {
    const app = setup();
    await settle();
    app.tapRecord();
    await settle();
    app.tapStop();
    const rec = app.recorders[0];
    const { ondataavailable, onstop } = rec;
    app.entry("topic-9").dispatch("click");
    await settle();
    ondataavailable({ data: new Blob([WEBM]) });
    onstop();
    await settle();
    expect(app.chips()).toHaveLength(0);
    app.entry("topic-8").dispatch("click");
    await settle();
    expect(app.chips()).toHaveLength(0);
  });

  test("verspätete Freigabe nach Gesprächswechsel: Mikrofon sofort wieder frei, keine Aufnahme", async () => {
    const app = setup({ microphone: "manual" });
    await settle();
    app.tapRecord();
    await settle();
    // Während der Freigabe-Frage: Knopf gesperrt, noch keine Zeile
    expect(app.record.disabled).toBe(true);
    expect(app.recorderShown()).toBe(false);
    app.entry("topic-9").dispatch("click");
    await settle();
    app.microphoneCalls[0].resolve(undefined as any);
    await settle();
    expect(app.recorders).toHaveLength(0);
    expect(allStopped(app.streams)).toBe(true);
    expect(app.recorderShown()).toBe(false);
    expect(app.record.disabled).toBe(false);
  });

  test("Seite verlassen (pagehide) während der Aufnahme: verworfen, Spuren frei", async () => {
    const app = setup();
    await settle();
    app.tapRecord();
    await settle();
    for (const fn of app.windowListeners["pagehide"] ?? []) fn({});
    expect(allStopped(app.streams)).toBe(true);
    expect(app.recorders[0].state).toBe("inactive");
    app.recorders[0].onstop?.();
    await settle();
    expect(app.chips()).toHaveLength(0);
  });

  test("pagehide während der Freigabe-Frage: die spätere Freigabe gibt das Mikrofon gleich wieder frei", async () => {
    const app = setup({ microphone: "manual" });
    await settle();
    app.tapRecord();
    await settle();
    for (const fn of app.windowListeners["pagehide"] ?? []) fn({});
    app.microphoneCalls[0].resolve(undefined as any);
    await settle();
    expect(app.recorders).toHaveLength(0);
    expect(allStopped(app.streams)).toBe(true);
  });

  test("während der Aufnahme kein Senden: Enter und Absenden tun nichts", async () => {
    const app = setup();
    await settle();
    app.type("Hallo");
    app.tapRecord();
    await settle();
    app.enter();
    app.submit();
    await settle();
    expect(app.server.posts()).toHaveLength(0);
    expect(app.recorderShown()).toBe(true);
  });

  test("fünf Anhänge: kein Start, Hinweis", async () => {
    const app = setup();
    await settle();
    for (let i = 0; i < 5; i++) {
      app.tapRecord();
      await settle();
      app.tapStop();
      app.recorders[i].deliver(WEBM);
      await settle();
    }
    expect(app.chips()).toHaveLength(5);
    app.tapRecord();
    await settle();
    expect(app.recorders).toHaveLength(5);
    expect(app.note()).toBe("Höchstens 5 Anhänge je Nachricht.");
  });
});

describe("Anhang aus der Aufnahme (Issue #109, Schritt 3)", () => {
  test("WebM: Typ und Endung aus den Bytes, Upload über die bestehende Route, Nachricht mit der ID; Text optional", async () => {
    const app = setup();
    await settle();
    app.tapRecord();
    await settle();
    app.advance(2000);
    app.tapStop();
    app.recorders[0].deliver(WEBM);
    await settle();
    app.submit();
    await settle();
    const [upload] = app.server.uploads();
    expect(upload.path).toBe("/api/conversations/topic-8/attachments");
    expect(upload.headers["Content-Type"]).toBe("audio/webm");
    expect(upload.headers["X-File-Name"]).toBe("aufnahme-20260925-130405.webm");
    const blob = upload.body as Blob;
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(WEBM);
    const [post] = app.server.posts();
    const body = JSON.parse(post.body as string);
    expect(body.text).toBe("");
    expect(body.attachments).toHaveLength(1);
    expect(app.chips()).toHaveLength(0);
  });

  test("reines Web-Gespräch (Issue #112): Aufnahme wird Chip, Upload und Nachricht gehen an dieses Gespräch", async () => {
    const app = setup({ stored: WEB });
    await settle();
    app.tapRecord();
    await settle();
    app.advance(1000);
    app.tapStop();
    app.recorders[0].deliver(WEBM);
    await settle();
    expect(app.chips()).toHaveLength(1);
    app.submit();
    await settle();
    expect(app.server.uploads().map(u => u.path)).toEqual([`/api/conversations/${WEB}/attachments`]);
    const [post] = app.server.posts();
    expect(post.path).toBe(`/api/conversations/${WEB}/messages`);
    expect(JSON.parse(post.body as string).attachments).toHaveLength(1);
  });

  test("MP4 (Safari): audio/mp4 und .m4a, auch wenn der Recorder etwas anderes meldet; mit Text", async () => {
    const app = setup({ supported: ["audio/mp4"] });
    await settle();
    app.tapRecord();
    await settle();
    app.recorders[0].mimeType = "audio/webm";
    app.tapStop();
    app.recorders[0].deliver(MP4);
    await settle();
    app.type("Bitte zusammenfassen");
    app.submit();
    await settle();
    const [upload] = app.server.uploads();
    expect(upload.headers["Content-Type"]).toBe("audio/mp4");
    expect(upload.headers["X-File-Name"]).toBe("aufnahme-20260925-130405.m4a");
    expect(JSON.parse(app.server.posts()[0].body as string).text).toBe("Bitte zusammenfassen");
  });

  test("unbekannte Bytes: Meldung, kein Chip, nichts hochgeladen", async () => {
    const app = setup();
    await settle();
    app.tapRecord();
    await settle();
    app.tapStop();
    app.recorders[0].deliver(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    await settle();
    expect(app.chips()).toHaveLength(0);
    expect(app.note()).toBe("Die Aufnahme ist abgebrochen. Nichts angehängt.");
  });

  test("Chip spielt die Aufnahme über <audio> mit Objekt-URL ab; Entfernen gibt die URL frei", async () => {
    const app = setup();
    await settle();
    app.tapRecord();
    await settle();
    app.tapStop();
    app.recorders[0].deliver(WEBM);
    await settle();
    const chip = app.chips()[0];
    const audio = all(chip).find(n => n.tagName === "audio")!;
    expect(audio.attributes.src).toBe(app.urls.created[0]);
    expect(audio.attributes.src).toMatch(/^blob:/);
    const play = find(chip, "attachment-play")!;
    expect(play.attributes["aria-label"]).toBe("Aufnahme abspielen");
    play.dispatch("click");
    expect(audio.plays).toBe(1);
    // Neu gezeichnet: derselbe Player, jetzt mit Pause
    const again = find(app.chips()[0], "attachment-play")!;
    expect(again.attributes["aria-label"]).toBe("Pause");
    expect(all(app.chips()[0]).find(n => n.tagName === "audio")).toBe(audio);
    find(app.chips()[0], "attachment-remove")!.dispatch("click");
    expect(app.chips()).toHaveLength(0);
    expect(app.urls.revoked).toEqual([app.urls.created[0]]);
    expect(audio.paused).toBe(true);
  });

  test("nach erfolgreichem Senden und beim Verlassen der Seite wird die Objekt-URL freigegeben", async () => {
    const app = setup();
    await settle();
    for (let i = 0; i < 2; i++) {
      app.tapRecord();
      await settle();
      app.tapStop();
      app.recorders[i].deliver(WEBM);
      await settle();
    }
    expect(app.urls.created).toHaveLength(2);
    app.submit();
    await settle();
    expect(app.urls.revoked.sort()).toEqual([...app.urls.created].sort());
    app.tapRecord();
    await settle();
    app.tapStop();
    app.recorders[2].deliver(WEBM);
    await settle();
    for (const fn of app.windowListeners["pagehide"] ?? []) fn({});
    expect(app.urls.revoked).toContain(app.urls.created[2]);
    // Zurück aus dem Zurück-Cache: neue URL für die Wiedergabe
    for (const fn of app.windowListeners["pageshow"] ?? []) fn({ persisted: true });
    expect(app.urls.created).toHaveLength(4);
    expect(all(app.chips()[0]).find(n => n.tagName === "audio")!.attributes.src).toBe(app.urls.created[3]);
  });
});
