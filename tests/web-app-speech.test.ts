// Sprechmodus in der App (Issue #250, Checkbox 5): speech.js und app.js wie im
// Browser nacheinander geladen, ohne Browser. Attrappen für DOM, fetch und
// EventSource wie in web-app-recording.test.ts, dazu Mikrofon, AudioContext,
// Worklet und speechSynthesis aus tests/speech-mode-fixture.ts. Geprüft:
// Sichtbarkeit und Sperren des Knopfs, der Bereich statt der Eingabebox,
// ein Durchlauf über die echten Wege der App (Upload, Verlauf nachladen,
// Ereignisse), Auflegen bei Gesprächswechsel, Abmelden, Verlassen und
// Neuladen, und die Risiko-Zeile vor dem Neuladen.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TYBO_BRAND } from "./brand-fixture";
import { speechHarness, SPEECH_SOURCE, type HarnessOptions } from "./speech-mode-fixture";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const appSource = await readFile(resolve(publicDir, "app.js"), "utf8");
const html = await readFile(resolve(publicDir, "index.html"), "utf8");
const css = await readFile(resolve(publicDir, "style.css"), "utf8");

const START = new Date(2026, 8, 30, 13, 4, 5).getTime();
const WEB = "33333333-3333-4333-8333-333333333333";
const LOADED = "0123456789abcdef";
const NEWER = "fedcba9876543210";
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

interface Options extends HarnessOptions {
  /** Antwort von GET /api/voice: bereit, nicht bereit, 503 oder ohne modes */
  voice?: "ready" | "not-ready" | "missing";
  closedTopic?: boolean;
  /** false: AudioContext ohne audioWorklet */
  worklet?: boolean;
  /** window.MediaRecorder (für die Aufnahme M4b) */
  recorder?: boolean;
  stored?: string;
}

function setup(options: Options = {}) {
  setSystemTime(new Date(START));
  FakeEventSource.all = [];
  const elements: Record<string, Node> = {};
  const docListeners: Record<string, (() => void)[]> = {};
  const document: Record<string, any> = {
    visibilityState: "visible",
    activeElement: null,
    getElementById(id: string) { return (elements[id] ??= node()); },
    createElement(tag: string) { const n = node(); n.tagName = tag; return n; },
    createElementNS() { return node(); },
    createDocumentFragment() { const f = node(); f.fragment = true; return f; },
    addEventListener(type: string, fn: () => void) { (docListeners[type] ??= []).push(fn); },
  };
  const meta = node();
  meta.setAttribute("content", LOADED);
  elements["ui-version"] = meta;

  let timerSeq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const setTimeout = (fn: () => void, ms = 0) => {
    const id = ++timerSeq;
    timers.set(id, { at: Date.now() + Math.max(0, ms), fn });
    return id;
  };
  const clearTimeout = (id: number) => { timers.delete(id); };
  const advance = async (ms: number) => {
    const end = Date.now() + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      setSystemTime(new Date(Math.max(Date.now(), due[1].at)));
      due[1].fn();
      await settle();
    }
    setSystemTime(new Date(end));
    await settle();
  };

  // Mikrofon, AudioContext, Worklet, Stimme: dieselben Attrappen wie in den Tests der Zustandsmaschine
  const fakes = speechHarness(options);
  const recorders: any[] = [];
  class FakeMediaRecorder {
    static isTypeSupported() { return true; }
    state = "inactive";
    constructor(public stream: any) { recorders.push(this); }
    start() { this.state = "recording"; }
    stop() { this.state = "inactive"; }
  }
  const windowListeners: Record<string, ((e: any) => void)[]> = {};
  const store: Record<string, string> = { "tybo-last-conversation": options.stored ?? WEB };
  if (options.device) store["tybo-speech-device"] = JSON.stringify(options.device);
  let reloads = 0;
  const location: Record<string, any> = { href: "/", hash: "", pathname: "/", search: "", reload() { reloads++; } };
  const window: Record<string, any> = {
    ...fakes.win,
    TYBO_BRAND,
    ...(options.worklet === false ? { AudioContext: class {} } : {}),
    ...(options.recorder ? { MediaRecorder: FakeMediaRecorder } : {}),
    localStorage: {
      getItem: (key: string) => store[key] ?? null,
      setItem: (key: string, value: string) => { store[key] = value; },
      removeItem: (key: string) => { delete store[key]; },
    },
    matchMedia: () => ({ matches: false }),
    getComputedStyle: () => ({ lineHeight: "22", paddingTop: "0", paddingBottom: "0", borderTopWidth: "0", borderBottomWidth: "0" }),
    addEventListener(type: string, fn: (e: any) => void) { (windowListeners[type] ??= []).push(fn); },
    location,
  };

  const topics = [
    { id: "topic-8", title: "Recherche", agent: "research", lastActivity: new Date(START).toISOString(), ...(options.closedTopic ? { closed: true } : {}) },
    { id: "topic-9", title: "Strategie", agent: "strategy", lastActivity: new Date(START).toISOString() },
  ];
  const localStatus = (ready: boolean) => ({
    ready,
    ...(ready ? {} : { reason: "Kein Anbieter fürs Hören verfügbar" }),
    stt: ready ? { id: "whisper-cpp", label: "whisper.cpp", local: true, available: true } : null,
    tts: { id: options.tts === "server" ? "elevenlabs" : "browser", label: "Stimme", where: options.tts ?? "browser", available: true },
  });
  const server = {
    requests: [] as { method: string; path: string; headers: Record<string, string>; body: any }[],
    version: LOADED,
    messages: {} as Record<string, any[]>,
    running: false,
    /** Antwort auf POST …/speech; Standard: 202 und die Nachricht steht im Verlauf */
    speech: null as null | ((id: string) => { status: number; body: unknown }),
    voice: options.voice ?? "ready",
    topics,
    of: (method: string, suffix: string) => server.requests.filter(r => r.method === method && r.path.endsWith(suffix)),
  };
  let counter = 0;
  const fetch = async (path: string, init?: { method?: string; body?: unknown; headers?: Record<string, string> }) => {
    if (path === "/api/presence") return { ok: true, status: 204, json: async () => ({}) } as any;
    const method = init?.method ?? "GET";
    server.requests.push({ method, path, headers: init?.headers ?? {}, body: init?.body });
    if (path === "/api/version") return Response.json({ version: server.version });
    if (path === "/api/conversations" && method === "GET") {
      return Response.json({ conversations: [{ id: WEB, agent: "general", title: "Betrieb" }], telegram: { dm: null, topics } });
    }
    if (path === "/api/voice") {
      if (server.voice === "missing") return Response.json({ error: "Sprach-Status ist nicht eingerichtet" }, { status: 503 });
      return Response.json({ modes: { local: localStatus(server.voice === "ready") } });
    }
    if (path === "/api/me") return Response.json({ authenticated: true });
    if (path === "/api/commands") return Response.json({ commands: [] });
    if (path === "/api/logout") return Response.json({});
    if (path.endsWith("/goal")) return Response.json({ card: null });
    const speech = path.match(/^\/api\/conversations\/([^/?]+)\/speech$/);
    if (speech && method === "POST") {
      if (server.speech) {
        const r = server.speech(speech[1]!);
        return Response.json(r.body, { status: r.status });
      }
      const message = { id: `s${++counter}`, role: "user", text: "Wie wird das Wetter?", source: "speech", createdAt: new Date().toISOString() };
      (server.messages[speech[1]!] ??= []).push(message);
      server.running = true;
      return Response.json({ transcript: message.text, messageId: message.id }, { status: 202 });
    }
    if (speech) return Response.json({ busy: server.running });
    const m = path.match(/^\/api\/conversations\/([^/?]+)\/messages$/);
    if (m && method === "POST") {
      const body = JSON.parse(init!.body as string);
      return Response.json({ message: { id: `u${++counter}`, role: "user", text: body.text, createdAt: new Date().toISOString() } }, { status: 202 });
    }
    if (m) return Response.json({ messages: server.messages[m[1]!] ?? [], hasMore: false, running: server.running });
    return Response.json({ error: "unbekannt" }, { status: 404 });
  };

  for (const id of ["attachments", "attach-note", "attach", "record", "recorder", "talk", "talk-panel", "talk-note", "talk-heard", "talk-reply", "talk-confirm", "talk-resume", "talk-close"]) {
    elements[id] = node();
    elements[id].hidden = true;
  }
  elements["chat-log"] = node();
  new Function("document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout", `${SPEECH_SOURCE}\n${appSource}`)(
    document, window, fetch, FakeEventSource, setTimeout, clearTimeout
  );

  const talk = elements["talk"];
  const panel = elements["talk-panel"];
  const box = elements["composer-box"];
  const entry = (id: string) => {
    for (const listId of ["dm-list", "topic-list", "older-list", "conversation-list"]) {
      const li = (elements[listId]?.children ?? []).find(l => l.children[0]?.attributes["data-id"] === id);
      if (li) return li.children[0];
    }
    throw new Error(`Eintrag ${id} fehlt`);
  };
  /** Live-Verbindung des offenen Gesprächs */
  const events = () => FakeEventSource.all.filter(e => /\/api\/conversations\/[^/]+\/events$/.test(e.url) && !e.closed).at(-1)!;
  const sse = (type: string, data: unknown) => events().emit(type, { data: JSON.stringify(data) });
  const state = () => elements["talk-state"].textContent;
  const note = () => (elements["talk-note"].hidden ? "" : elements["talk-note"].textContent);
  const outside = { target: { closest: () => null } };
  const onButton = { target: { closest: (sel: string) => (sel === "button" ? {} : null) } };
  return {
    elements, talk, panel, box, entry, events, sse, state, note, server, fakes, recorders, windowListeners, docListeners, document, window, advance, timers,
    reloads: () => reloads,
    tapTalk: () => talk.dispatch("click"),
    tapPanel: () => panel.dispatch("click", outside),
    tapPanelButton: () => panel.dispatch("click", onButton),
    space: (target = outside.target) => panel.dispatch("keydown", { key: " ", target, preventDefault() {} }),
    hangUp: () => elements["talk-hangup"].dispatch("click"),
    updateButtons: () => (elements["update-note"].children[1]?.children ?? []) as Node[],
    updateText: () => elements["update-note"].children[0]?.textContent ?? "",
    tracksStopped: () => fakes.mic.streams.length > 0 && fakes.mic.streams.every(s => s.tracks.every(t => t.stopped)),
  };
}

async function settle() {
  for (let i = 0; i < 40; i++) await Bun.sleep(0);
}

async function started(options: Options = {}) {
  const app = setup(options);
  await settle();
  return app;
}

/** Bis „Hört zu" */
async function listening(options: Options = {}) {
  const app = await started(options);
  app.tapTalk();
  await settle();
  expect(app.state()).toBe("Hört zu");
  return app;
}

describe("Knopf „Sprechen“: Sichtbarkeit und Sperren", () => {
  test("bereiter Modus in einem Browser, der ihn kann: Knopf sichtbar und frei, die Eingabebox bleibt", async () => {
    const app = await started();
    expect(app.server.of("GET", "/api/voice")).toHaveLength(1);
    expect(app.talk.hidden).toBe(false);
    expect(app.talk.disabled).toBe(false);
    expect(app.panel.hidden).toBe(true);
    expect(app.box.hidden).toBe(false);
    // Das Mikrofon wird erst nach dem Tipp gefragt
    expect(app.fakes.mic.calls).toEqual([]);
  });

  test("kein Modus bereit, Status nicht eingerichtet: kein Knopf", async () => {
    expect((await started({ voice: "not-ready" })).talk.hidden).toBe(true);
    expect((await started({ voice: "missing" })).talk.hidden).toBe(true);
  });

  test("unsicherer Kontext (http im Heimnetz), kein audioWorklet, Browser-Stimme ohne speechSynthesis: kein Knopf", async () => {
    expect((await started({ secure: false })).talk.hidden).toBe(true);
    expect((await started({ worklet: false })).talk.hidden).toBe(true);
    expect((await started({ synth: false })).talk.hidden).toBe(true);
    // Mit einer Server-Stimme braucht es speechSynthesis nicht
    expect((await started({ synth: false, tts: "server" })).talk.hidden).toBe(false);
    // MediaRecorder braucht der Sprechmodus nicht (die Aufnahme M4b schon)
    const app = await started();
    expect(app.window.MediaRecorder).toBeUndefined();
    expect(app.elements["record"].hidden).toBe(true);
    expect(app.talk.hidden).toBe(false);
  });

  test("geschlossenes Topic: Knopf gesperrt, ein Tipp startet nichts", async () => {
    const app = await started({ closedTopic: true, stored: "topic-8" });
    expect(app.talk.hidden).toBe(false);
    expect(app.talk.disabled).toBe(true);
    app.tapTalk();
    await settle();
    expect(app.panel.hidden).toBe(true);
    expect(app.fakes.mic.calls).toEqual([]);
    // Im offenen Topic daneben geht es
    app.entry("topic-9").dispatch("click");
    await settle();
    expect(app.talk.disabled).toBe(false);
  });

  test("während einer Aufnahme (M4b) gesperrt; umgekehrt ist die Aufnahme gesperrt, solange der Sprechmodus läuft", async () => {
    const app = await started({ recorder: true });
    expect(app.elements["record"].hidden).toBe(false);
    app.elements["record"].dispatch("click");
    await settle();
    expect(app.recorders).toHaveLength(1);
    // Die Aufnahmezeile ersetzt Feld und Knöpfe: „Sprechen" ist weg bzw. gesperrt
    expect(app.talk.hidden || app.talk.disabled).toBe(true);
    expect(app.talk.disabled).toBe(true);
    app.tapTalk();
    await settle();
    expect(app.panel.hidden).toBe(true);
    expect(app.fakes.mic.calls).toHaveLength(1);
    app.elements["recorder-discard"].dispatch("click");
    await settle();
    expect(app.talk.hidden).toBe(false);
    expect(app.talk.disabled).toBe(false);

    app.tapTalk();
    await settle();
    expect(app.state()).toBe("Hört zu");
    expect(app.elements["record"].disabled).toBe(true);
    app.elements["record"].dispatch("click");
    await settle();
    expect(app.recorders).toHaveLength(1);
  });

  test("HTML: Knopf neben dem Mikrofon mit Namen für Screenreader und inline SVG, Bereich vor der Eingabebox, speech.js vor app.js", () => {
    expect(html).toContain('<script src="/speech.js" defer></script>');
    expect(html.indexOf('src="/speech.js"')).toBeLessThan(html.indexOf('src="/settings.js"'));
    expect(html.indexOf('src="/speech.js"')).toBeLessThan(html.indexOf('src="/app.js"'));
    const button = html.match(/<button type="button" id="talk"[^>]*>\s*<svg[^>]*aria-hidden="true">/)![0];
    expect(button).toContain('class="round-button talk"');
    expect(button).toContain('aria-label="Mit {{brand.name}} sprechen"');
    expect(button).toContain("hidden");
    expect(html.indexOf('id="record"')).toBeLessThan(html.indexOf('id="talk"'));
    expect(html.indexOf('id="talk"')).toBeLessThan(html.indexOf('id="send"'));
    const panel = html.slice(html.indexOf('id="talk-panel"'), html.indexOf('id="composer-box"'));
    expect(html).toContain('<div id="talk-panel" class="talk-panel" role="group" aria-label="Sprechmodus" tabindex="0" hidden>');
    expect(panel).toContain('id="talk-state" class="talk-state" role="status"');
    for (const id of ["talk-dot", "talk-level", "talk-note", "talk-heard", "talk-reply", "talk-pause", "talk-resume", "talk-hangup", "talk-close", "talk-yes", "talk-no"]) {
      expect(panel).toContain(`id="${id}"`);
    }
    expect(panel).toContain(">Pause</button>");
    expect(panel).toContain(">Weiter</button>");
    expect(panel).toContain(">Auflegen</button>");
  });

  test("CSS: am Handy 2.75rem, roter Punkt nur bei offenem Mikrofon, Pegel ohne Übergang, unter reduced-motion nur Text", () => {
    const block = css.slice(css.indexOf(".talk {"), css.indexOf(".composer textarea {"));
    expect(block).toContain('.talk-dot[data-mic="open"] { background: var(--error); }');
    expect(block).toMatch(/\.talk-dot \{[^}]*background: var\(--placeholder\)/);
    expect(block).not.toMatch(/transition|animation|@keyframes/);
    // Keine neue Farbe: nur Variablen
    expect(block).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|oklch\(/);
    const mobile = css.slice(css.indexOf("@media (max-width: 55.99rem)"));
    expect(mobile).toContain(".round-button { width: 2.75rem; height: 2.75rem; }");
    expect(mobile).toContain(".recorder, .recorder-button { min-height: 2.75rem; }");
    const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".talk-level { display: none; }");
  });
});

describe("Bereich statt Eingabebox", () => {
  test("Tipp auf „Sprechen“: der Bereich ersetzt die Eingabebox, Zustand als Text, roter Punkt für das offene Mikrofon", async () => {
    const app = await started();
    app.tapTalk();
    // Noch im Tipp: Bereich da, Mikrofon angefragt, Ausgabe freigeschaltet
    expect(app.panel.hidden).toBe(false);
    expect(app.box.hidden).toBe(true);
    expect(app.state()).toBe("Mikrofon wird freigegeben …");
    expect(app.fakes.mic.calls).toEqual([{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } }]);
    expect(app.fakes.synth.unlocks).toHaveLength(1);
    expect(app.panel.focused).toBe(1);
    await settle();
    expect(app.state()).toBe("Hört zu");
    expect(app.panel.attributes["data-phase"]).toBe("listening");
    expect(app.elements["talk-dot"].attributes["data-mic"]).toBe("open");
    expect(app.elements["talk-level"].hidden).toBe(false);
    expect(app.elements["talk-pause"].hidden).toBe(false);
    expect(app.elements["talk-resume"].hidden).toBe(true);
    expect(app.elements["talk-hangup"].hidden).toBe(false);
    expect(app.elements["talk-close"].hidden).toBe(true);
    expect(app.talk.disabled).toBe(true);
    // Pegel: Breite springt, keine Bewegung
    await app.fakes.emit({ type: "level", level: 0.09, speaking: false });
    expect(app.elements["talk-level-bar"].style.width).toBe("42%");
    await app.fakes.emit({ type: "start" });
    expect(app.elements["talk-level-bar"].attributes["data-voice"]).toBe("true");
  });

  test("Durchlauf im reinen Web-Gespräch: Upload als WAV, eigene Nachricht über den Verlauf, Antwort als Ereignis, vorgelesen, wieder Zuhören", async () => {
    const app = await listening();
    const gets = app.server.of("GET", "/messages").length;
    await app.fakes.say(new Int16Array(16000).fill(500));
    await settle();
    const uploads = app.server.of("POST", "/speech");
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.path).toBe(`/api/conversations/${WEB}/speech`);
    expect(uploads[0]!.headers["Content-Type"]).toBe("audio/wav");
    expect(uploads[0]!.body.byteLength).toBe(44 + 32000);
    // Angenommen: der Verlauf wird nachgeladen (die eigene Nachricht kommt hier nicht als Ereignis)
    expect(app.server.of("GET", "/messages").length).toBe(gets + 1);
    expect(app.state()).toBe("Denkt …");
    expect(app.elements["talk-heard"].textContent).toBe("Du: Wie wird das Wetter?");
    expect(app.elements["talk-dot"].attributes["data-mic"]).toBe("closed");
    expect(app.elements["talk-level"].hidden).toBe(true);
    // Die eigene Nachricht steht im Verlauf
    expect(app.elements["messages"].children).toHaveLength(1);

    app.sse("status", { running: true });
    app.sse("progress", { kind: "tool", text: "WebSearch" });
    expect(app.elements["talk-step"].textContent).not.toBe("");
    // Antwort als Ereignis, dann der Abschluss
    app.server.running = false;
    app.sse("message", { id: "a1", role: "assistant", text: "Morgen wird es sonnig.", html: "<p>Morgen wird es sonnig.</p>", speakable: "Morgen wird es sonnig.", speakSegments: ["Morgen wird es sonnig."], createdAt: new Date(Date.now() + 1000).toISOString() });
    app.sse("status", { running: false });
    await settle();
    expect(app.state()).toBe("Spricht");
    expect(app.fakes.synth.spoken.map(u => u.text)).toEqual(["Morgen wird es sonnig."]);
    expect(app.elements["talk-reply"].textContent).toBe(`${TYBO_BRAND.name}: Morgen wird es sonnig.`);
    expect(app.elements["messages"].children).toHaveLength(2);
    expect(app.panel.attributes["data-tap"]).toBe("true");

    app.fakes.synth.spoken[0]!.onend!();
    await settle();
    expect(app.state()).toBe("Hört zu");
    expect(app.panel.attributes["data-tap"]).toBe("false");
    // Genau ein Upload, nichts doppelt vorgelesen
    expect(app.server.of("POST", "/speech")).toHaveLength(1);
    expect(app.fakes.synth.spoken).toHaveLength(1);
  });

  test("Turn endet ohne Antwort (Fehler-Ereignis): Hinweis, wieder Zuhören; ein Abriss der Live-Verbindung ist kein Turn-Fehler", async () => {
    const app = await listening();
    await app.fakes.say();
    await settle();
    app.sse("status", { running: true });
    // Transportfehler: die Verbindung reißt ab, der Zustand bleibt
    app.events().emit("error", {});
    await settle();
    expect(app.state()).toBe("Denkt …");
    // Neu verbunden, der Turn läuft noch
    await app.advance(1000);
    app.events().emit("open");
    await settle();
    expect(app.state()).toBe("Denkt …");
    // Der Turn scheitert
    app.server.running = false;
    app.sse("error", { id: "e1", role: "error", text: "Der Turn ist fehlgeschlagen.", createdAt: new Date(Date.now() + 1000).toISOString() });
    app.sse("status", { running: false });
    await settle();
    expect(app.state()).toBe("Hört zu");
    expect(app.note()).toBe("Keine Antwort zum Vorlesen. Siehe Verlauf.");
    expect(app.fakes.synth.spoken).toEqual([]);
  });

  test("409 beschaeftigt: „Wartet“, die Abfrage beendet es; 409 closed sperrt das Gespräch", async () => {
    const app = await listening({ stored: "topic-9" });
    app.server.speech = () => ({ status: 409, body: { error: "In diesem Gespräch läuft schon eine Antwort", reason: "beschaeftigt" } });
    await app.fakes.say();
    await settle();
    expect(app.state()).toBe("Wartet");
    expect(app.note()).toBe("In diesem Gespräch läuft schon eine Antwort. Nichts gesendet.");
    await app.advance(2000);
    expect(app.server.of("GET", "/speech")).toHaveLength(1);
    expect(app.state()).toBe("Hört zu");
    expect(app.note()).toBe("Wieder frei. Sprich noch einmal.");
    expect(app.server.of("POST", "/speech")).toHaveLength(1);

    // Das Topic wurde in einem anderen Browser geschlossen
    (app.server.topics[1] as any).closed = true;
    app.server.speech = () => ({ status: 409, body: { error: "Dieses Topic ist geschlossen.", closed: true } });
    await app.fakes.say();
    await settle();
    expect(app.state()).toBe("Fehler");
    expect(app.note()).toBe("Dieses Topic ist geschlossen.");
    expect(app.panel.attributes["data-phase"]).toBe("error");
    expect(app.elements["talk-close"].hidden).toBe(false);
    expect(app.elements["talk-hangup"].hidden).toBe(true);
    expect(app.elements["talk-pause"].hidden).toBe(true);
    expect(app.tracksStopped()).toBe(true);
    // Schließen bringt die Eingabebox zurück; das Topic ist jetzt gesperrt
    app.elements["talk-close"].dispatch("click");
    expect(app.panel.hidden).toBe(true);
    expect(app.box.hidden).toBe(false);
    expect(app.talk.disabled).toBe(true);
    expect(app.elements["closed-note"].hidden).toBe(false);
  });

  test("Tipp auf den Bereich und Leertaste unterbrechen die Antwort; ein Knopf im Bereich löst das nicht aus", async () => {
    const speaking = async () => {
      const app = await listening();
      await app.fakes.say();
      await settle();
      app.server.running = false;
      app.sse("message", { id: "a1", role: "assistant", text: "Lang.", speakable: "Lang.", speakSegments: ["Lang.", "Noch länger."], createdAt: new Date(Date.now() + 1000).toISOString() });
      app.sse("status", { running: false });
      await settle();
      expect(app.state()).toBe("Spricht");
      return app;
    };
    const tapped = await speaking();
    tapped.tapPanelButton();
    expect(tapped.state()).toBe("Spricht");
    tapped.tapPanel();
    expect(tapped.state()).toBe("Hört zu");
    expect(tapped.fakes.synth.spoken).toHaveLength(1);

    const spaced = await speaking();
    // Leertaste auf einem Knopf drückt den Knopf, nicht die Unterbrechung
    spaced.space({ closest: (sel: string) => (sel === "button" ? {} : null) } as any);
    expect(spaced.state()).toBe("Spricht");
    spaced.space();
    expect(spaced.state()).toBe("Hört zu");
  });

  test("beim Denken fragt der Tipp „Antwort abbrechen?“; Ja ruft stop", async () => {
    const app = await listening();
    await app.fakes.say();
    await settle();
    app.tapPanel();
    expect(app.note()).toBe("Antwort abbrechen?");
    expect(app.elements["talk-confirm"].hidden).toBe(false);
    expect(app.elements["talk-pause"].hidden).toBe(true);
    app.elements["talk-no"].dispatch("click");
    expect(app.elements["talk-confirm"].hidden).toBe(true);
    expect(app.server.of("POST", "/stop")).toHaveLength(0);
    app.tapPanel();
    app.elements["talk-yes"].dispatch("click");
    await settle();
    expect(app.server.of("POST", "/stop")).toHaveLength(1);
    expect(app.server.of("POST", "/stop")[0]!.path).toBe(`/api/conversations/${WEB}/stop`);
  });

  test("Pause und Weiter über die Knöpfe", async () => {
    const app = await listening();
    app.elements["talk-pause"].dispatch("click");
    expect(app.state()).toBe("Pausiert");
    expect(app.elements["talk-pause"].hidden).toBe(true);
    expect(app.elements["talk-resume"].hidden).toBe(false);
    expect(app.elements["talk-dot"].attributes["data-mic"]).toBe("closed");
    expect(app.tracksStopped()).toBe(true);
    app.elements["talk-resume"].dispatch("click");
    await settle();
    expect(app.state()).toBe("Hört zu");
    expect(app.fakes.mic.calls).toHaveLength(2);
  });

  test("getippte Nachrichten gehen im Sprechmodus nicht nebenher raus", async () => {
    const app = await listening();
    app.elements["input"].value = "getippt";
    app.elements["composer"].dispatch("submit", { preventDefault() {} });
    await settle();
    expect(app.server.of("POST", "/messages")).toHaveLength(0);
  });
});

describe("Auflegen", () => {
  test("Knopf „Auflegen“: Bereich weg, Eingabebox zurück, Mikrofon frei", async () => {
    const app = await listening();
    app.hangUp();
    expect(app.panel.hidden).toBe(true);
    expect(app.box.hidden).toBe(false);
    expect(app.talk.disabled).toBe(false);
    expect(app.tracksStopped()).toBe(true);
    expect(app.fakes.contexts.every((c: any) => c.closed)).toBe(true);
    expect(app.talk.focused).toBe(1);
    // Danach geht ein neuer Start
    app.tapTalk();
    await settle();
    expect(app.state()).toBe("Hört zu");
  });

  test("Gesprächswechsel legt auf; die Antwort des laufenden Turns wird im neuen Gespräch nicht vorgelesen", async () => {
    const app = await listening();
    await app.fakes.say();
    await settle();
    app.entry("topic-9").dispatch("click");
    await settle();
    expect(app.panel.hidden).toBe(true);
    expect(app.box.hidden).toBe(false);
    expect(app.tracksStopped()).toBe(true);
    // Kein Abbruch des Turns
    expect(app.server.of("POST", "/stop")).toHaveLength(0);
    app.sse("message", { id: "a9", role: "assistant", text: "Fremd.", speakable: "Fremd.", speakSegments: ["Fremd."], createdAt: new Date(Date.now() + 1000).toISOString() });
    await settle();
    expect(app.fakes.synth.spoken).toEqual([]);
  });

  test("Abmelden, pagehide und das Öffnen der Einstellungen legen auf", async () => {
    const logout = await listening();
    logout.elements["logout"].dispatch("click");
    await settle();
    expect(logout.tracksStopped()).toBe(true);
    expect(logout.panel.hidden).toBe(true);

    const hide = await listening();
    for (const fn of hide.windowListeners["pagehide"] ?? []) fn({});
    expect(hide.tracksStopped()).toBe(true);
    expect(hide.panel.hidden).toBe(true);
  });

  test("abgelaufene Anmeldung (401 auf den Upload): alles frei, weiter zur Anmeldung", async () => {
    const app = await listening();
    app.server.speech = () => ({ status: 401, body: { error: "Nicht angemeldet" } });
    await app.fakes.say();
    await settle();
    expect(app.tracksStopped()).toBe(true);
    expect(app.panel.hidden).toBe(true);
    expect(app.window.location.href).toBe("/login");
  });

  test("visibilitychange holt den Wake Lock zurück, solange der Modus läuft", async () => {
    const app = await listening();
    expect(app.fakes.wake.requests).toBe(1);
    app.fakes.wake.sentinels[0].lose();
    app.document.visibilityState = "hidden";
    for (const fn of app.docListeners["visibilitychange"] ?? []) fn();
    await settle();
    expect(app.fakes.wake.requests).toBe(1);
    app.document.visibilityState = "visible";
    for (const fn of app.docListeners["visibilitychange"] ?? []) fn();
    await settle();
    expect(app.fakes.wake.requests).toBe(2);
  });
});

describe("Neuladen wegen einer neuen Version", () => {
  async function withUpdate() {
    const app = await listening();
    app.server.version = NEWER;
    app.events().emit("error", {});
    await app.advance(1000);
    app.events().emit("open");
    await settle();
    expect(app.updateText()).toBe(`Neue Version von ${TYBO_BRAND.name} verfügbar`);
    return app;
  }
  const press = (app: Awaited<ReturnType<typeof withUpdate>>, label: string) => {
    const b = app.updateButtons().find(x => x.textContent === label);
    if (!b) throw new Error(`Knopf ${label} fehlt`);
    b.dispatch("click");
  };

  test("die Rückfrage nennt „Der Sprechmodus läuft und wird beendet.“; Abbrechen lässt ihn laufen, Bestätigen legt auf und lädt", async () => {
    const app = await withUpdate();
    press(app, "Neu laden");
    expect(app.reloads()).toBe(0);
    expect(app.updateText()).toBe("Der Sprechmodus läuft und wird beendet. Trotzdem neu laden?");
    press(app, "Abbrechen");
    expect(app.state()).toBe("Hört zu");
    expect(app.tracksStopped()).toBe(false);
    press(app, "Neu laden");
    press(app, "Neu laden");
    expect(app.reloads()).toBe(1);
    expect(app.tracksStopped()).toBe(true);
    expect(app.panel.hidden).toBe(true);
  });

  test("ohne laufenden Sprechmodus keine Rückfrage", async () => {
    const app = await withUpdate();
    app.hangUp();
    press(app, "Neu laden");
    expect(app.reloads()).toBe(1);
  });
});
