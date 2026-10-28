// Telefonhörer in der App (Issue #258, Checkbox 3): speech.js, call.js und
// app.js wie im Browser nacheinander geladen, ohne Browser. Attrappen für
// DOM, fetch und EventSource wie in web-app-speech.test.ts, dazu WebSocket,
// Mikrofon, AudioContext, Worklets und speechSynthesis aus
// tests/call-mode-fixture.ts. Geprüft: Sichtbarkeit nach modes.call und
// Sperren des Knopfs, die Ansicht statt der Eingabebox, der Tipp öffnet
// Mikrofon und Verbindung und schickt start mit dem offenen Gespräch,
// Antippen unterbricht, Stumm, Hinweis, Auflegen bei Gesprächswechsel,
// Abmelden, Verlassen, Einstellungen und Neuladen, die Risiko-Zeile, der
// gegenseitige Ausschluss mit Aufnahme und Sprechmodus.
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TYBO_BRAND } from "./brand-fixture";
import { SPEECH_SOURCE } from "./speech-mode-fixture";
import { CALL_SOURCE, CALL_STATUS, callHarness, FakeWebSocket, type CallHarnessOptions } from "./call-mode-fixture";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
const appSource = await readFile(resolve(publicDir, "app.js"), "utf8");
const settingsSource = await readFile(resolve(publicDir, "settings.js"), "utf8");
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

interface Options extends CallHarnessOptions {
  /** settings.js mitladen (Einstellungen öffnen) */
  settingsView?: boolean;
  /** modes.call: bereit (Server-Stimme), bereit mit Browser-Stimme, nicht bereit oder fehlt */
  call?: "ready" | "browser" | "not-ready" | "missing";
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

  // Mikrofon, AudioContext, Worklets, Stimme, WebSocket: dieselben Attrappen wie in den Tests der Zustandsmaschine
  const harness = callHarness(options);
  const fakes = harness.fakes;
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
  const location: Record<string, any> = { href: "/", hash: "", pathname: "/", search: "", protocol: "https:", host: "tybo.example", reload() { reloads++; } };
  const window: Record<string, any> = {
    ...harness.win,
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
      const call = options.call ?? "ready";
      const modes: Record<string, unknown> = { local: localStatus(server.voice === "ready") };
      if (call === "ready") modes.call = CALL_STATUS;
      else if (call === "browser") modes.call = { ...CALL_STATUS, tts: { id: "browser", where: "browser", stream: false } };
      else if (call === "not-ready") modes.call = { ...CALL_STATUS, ready: false, reason: "Kein Modell bereit" };
      return Response.json({ modes });
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

  for (const id of ["attachments", "attach-note", "attach", "record", "recorder", "talk", "talk-panel", "talk-note", "talk-heard", "talk-reply", "talk-confirm", "talk-resume", "talk-close", "call", "call-panel", "call-note", "call-lines", "call-hint", "call-again", "call-close", "call-expect"]) {
    elements[id] = node();
    elements[id].hidden = true;
  }
  elements["chat-log"] = node();
  new Function("document", "window", "fetch", "EventSource", "setTimeout", "clearTimeout", `${SPEECH_SOURCE}\n${CALL_SOURCE}\n${options.settingsView ? settingsSource : ""}\n${appSource}`)(
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
    // Telefonhörer
    call: elements["call"],
    callPanel: elements["call-panel"],
    callState: () => elements["call-state"].textContent,
    callNote: () => (elements["call-note"].hidden ? "" : elements["call-note"].textContent),
    tapCall: () => elements["call"].dispatch("click"),
    tapCallPanel: () => elements["call-panel"].dispatch("click", outside),
    tapCallButton: () => elements["call-panel"].dispatch("click", onButton),
    spaceCall: (target = outside.target) => elements["call-panel"].dispatch("keydown", { key: " ", target, preventDefault() {} }),
    sockets: () => FakeWebSocket.all,
    ws: () => FakeWebSocket.all.at(-1)!,
    vadNode: () => fakes.nodes.filter((n: any) => n.name === "speech-vad").at(-1),
    playerNode: () => fakes.nodes.filter((n: any) => n.name === "call-player").at(-1),
    /** Meldung des Aufnahme-Worklets des Telefonhörers mit der aktuellen Laufnummer */
    async emitCall(message: Record<string, unknown>) {
      const node = fakes.nodes.filter((n: any) => n.name === "speech-vad" && n.options?.processorOptions?.mode === "call").at(-1);
      const config = [...node.port.posted].reverse().find((m: any) => m.type === "config");
      node.port.onmessage?.({ data: { epoch: config ? config.epoch : 0, ...message } });
      await settle();
    },
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


/** Tipp auf „Telefonhörer", Verbindung offen, ready, „Hört zu" */
async function calling(options: Options = {}) {
  const app = await started(options);
  app.tapCall();
  await settle();
  app.ws().open();
  app.ws().receive({ type: "ready", model: "claude-sonnet-5-5", via: "api", stt: "parakeet", tts: options.call === "browser" ? "browser" : "server", sampleRate: 24000 });
  app.ws().receive({ type: "state", state: "hoert-zu" });
  await settle();
  expect(app.callState()).toBe("Hört zu");
  return app;
}

describe("Knopf „Telefonhörer“: Sichtbarkeit und Sperren", () => {
  test("modes.call bereit in einem Browser, der ihn kann: Knopf sichtbar und frei; Mikrofon und Verbindung erst nach dem Tipp", async () => {
    const app = await started();
    expect(app.call.hidden).toBe(false);
    expect(app.call.disabled).toBe(false);
    expect(app.callPanel.hidden).toBe(true);
    expect(app.fakes.mic.calls).toEqual([]);
    expect(app.sockets()).toEqual([]);
    // Der Sprechmodus steht daneben
    expect(app.talk.hidden).toBe(false);
  });

  test("ohne modes.call.ready kein Knopf: nicht bereit, fehlt, Status nicht eingerichtet", async () => {
    expect((await started({ call: "not-ready" })).call.hidden).toBe(true);
    expect((await started({ call: "missing" })).call.hidden).toBe(true);
    expect((await started({ voice: "missing" })).call.hidden).toBe(true);
  });

  test("Browser ohne Fähigkeiten: unsicherer Kontext, kein WebSocket, kein audioWorklet, Browser-Stimme ohne speechSynthesis: kein Knopf", async () => {
    expect((await started({ secure: false })).call.hidden).toBe(true);
    expect((await started({ socket: false })).call.hidden).toBe(true);
    expect((await started({ worklet: false })).call.hidden).toBe(true);
    expect((await started({ call: "browser", synth: false })).call.hidden).toBe(true);
    expect((await started({ call: "ready", synth: false })).call.hidden).toBe(false);
  });

  test("geschlossenes Topic: gesperrt, ein Tipp startet nichts", async () => {
    const app = await started({ closedTopic: true, stored: "topic-8" });
    expect(app.call.disabled).toBe(true);
    app.tapCall();
    await settle();
    expect(app.sockets()).toEqual([]);
    expect(app.fakes.mic.calls).toEqual([]);
  });

  test("Ausschluss: während Aufnahme oder Sprechmodus gesperrt; während des Gesprächs sind Aufnahme und Sprechmodus gesperrt", async () => {
    const app = await started({ recorder: true });
    app.elements["record"].dispatch("click");
    await settle();
    expect(app.call.disabled || app.call.hidden).toBe(true);
    app.tapCall();
    await settle();
    expect(app.sockets()).toEqual([]);
    app.elements["recorder-discard"].dispatch("click");
    await settle();

    app.tapTalk();
    await settle();
    expect(app.state()).toBe("Hört zu");
    expect(app.call.disabled).toBe(true);
    app.tapCall();
    await settle();
    expect(app.sockets()).toEqual([]);
    app.hangUp();
    await settle();

    app.tapCall();
    await settle();
    expect(app.sockets()).toHaveLength(1);
    expect(app.talk.disabled).toBe(true);
    expect(app.elements["record"].disabled).toBe(true);
    const mics = app.fakes.mic.calls.length;
    app.tapTalk();
    app.elements["record"].dispatch("click");
    await settle();
    expect(app.fakes.mic.calls).toHaveLength(mics);
    expect(app.recorders).toHaveLength(1);
  });

  test("HTML: Knopf neben „Sprechen“ mit Namen für Screenreader und inline SVG, Ansicht an der Stelle des Sprechmodus, call.js nach speech.js und vor app.js", () => {
    expect(html).toContain('<script src="/call.js" defer></script>');
    expect(html.indexOf('src="/speech.js"')).toBeLessThan(html.indexOf('src="/call.js"'));
    expect(html.indexOf('src="/call.js"')).toBeLessThan(html.indexOf('src="/settings.js"'));
    expect(html.indexOf('src="/call.js"')).toBeLessThan(html.indexOf('src="/app.js"'));
    const button = html.match(/<button type="button" id="call"[^>]*>\s*<svg[^>]*aria-hidden="true">/)![0];
    expect(button).toContain('class="round-button call"');
    expect(button).toContain('aria-label="Mit {{brand.name}} telefonieren"');
    expect(button).toContain("hidden");
    expect(html.indexOf('id="talk"')).toBeLessThan(html.indexOf('id="call"'));
    expect(html.indexOf('id="call"')).toBeLessThan(html.indexOf('id="send"'));
    expect(html).toContain('<div id="call-panel" class="talk-panel call-panel" role="group" aria-label="Telefonhörer" tabindex="0" hidden>');
    const panel = html.slice(html.indexOf('id="call-panel"'), html.indexOf('id="composer-box"'));
    expect(panel).toContain('id="call-state" class="talk-state" role="status"');
    for (const id of ["call-agent", "call-time", "call-dot", "call-level", "call-expect", "call-note", "call-lines", "call-hint", "call-hint-ok", "call-mute", "call-again", "call-hangup", "call-close"]) {
      expect(panel).toContain(`id="${id}"`);
    }
    expect(panel).toContain(">Stumm</button>");
    expect(panel).toContain(">Auflegen</button>");
    expect(panel).toContain(">Noch einmal</button>");
    expect(panel).toContain(">Verstanden</button>");
    expect(panel).toContain('class="recorder-button recorder-stop">Auflegen');
  });

  test("CSS: Kontur 1.8, Dauer in tabular-nums, keine neue Farbe, keine Bewegung; Handy 2.75rem und reduced-motion über die gemeinsamen Regeln", () => {
    const block = css.slice(css.indexOf("/*\n * Telefonhörer (Issue #258)"), css.indexOf("/* Einzeilig: mit vier Knöpfen"));
    expect(block).toContain(".round-button.call svg { stroke-width: 1.8; }");
    expect(block).toContain("font-variant-numeric: tabular-nums");
    const rules = block.slice(block.indexOf("*/"));
    expect(rules).not.toMatch(/transition|animation|@keyframes/);
    expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|oklch\(/);
    const mobile = css.slice(css.indexOf("@media (max-width: 55.99rem)"));
    expect(mobile).toContain(".round-button { width: 2.75rem; height: 2.75rem; }");
    const reduced = css.slice(css.lastIndexOf("@media (prefers-reduced-motion: reduce)"));
    expect(reduced).toContain(".talk-level { display: none; }");
  });
});

describe("Gesprächsansicht", () => {
  test("Tipp: Ansicht statt Eingabebox, start mit dem offenen Gespräch, Kopfzeile mit Agent und Dauer, Erwartung, roter Punkt", async () => {
    const app = await started();
    app.tapCall();
    // Noch im Tipp: Ansicht da, Mikrofon angefragt, Verbindung im Aufbau, Fokus in der Ansicht
    expect(app.callPanel.hidden).toBe(false);
    expect(app.box.hidden).toBe(true);
    expect(app.callState()).toBe("Verbindet …");
    expect(app.fakes.mic.calls).toHaveLength(1);
    expect(app.sockets()).toHaveLength(1);
    expect(app.ws().url).toBe("wss://tybo.example/api/call");
    expect(app.callPanel.focused).toBe(1);
    expect(app.elements["call-agent"].textContent).toBe("General");
    expect(app.elements["call-expect"].textContent).toBe("Erster Satz nach rund 1,5 Sekunden");
    expect(app.elements["call-expect"].hidden).toBe(false);
    await settle();
    app.ws().open();
    expect(app.ws().json()).toEqual([{ type: "start", conversationId: WEB, tts: "server" }]);
    app.ws().receive({ type: "ready", model: "m", via: "api", stt: "parakeet", tts: "server", sampleRate: 24000 });
    app.ws().receive({ type: "state", state: "hoert-zu" });
    await settle();
    expect(app.callState()).toBe("Hört zu");
    expect(app.callPanel.attributes["data-phase"]).toBe("listening");
    expect(app.elements["call-dot"].attributes["data-mic"]).toBe("open");
    expect(app.elements["call-time"].textContent).toBe("00:00");
    expect(app.elements["call-expect"].hidden).toBe(false);
    expect(app.elements["call-mute"].hidden).toBe(false);
    expect(app.elements["call-hangup"].hidden).toBe(false);
    expect(app.elements["call-close"].hidden).toBe(true);
    // Einmal pro Gerät der Kopfhörer-Hinweis
    expect(app.elements["call-hint"].hidden).toBe(false);
    expect(app.elements["call-hint-text"].textContent).toBe(`Mit Kopfhörern kannst du ${TYBO_BRAND.name} ins Wort fallen. Über Lautsprecher tippe zum Unterbrechen.`);
    app.elements["call-hint-ok"].dispatch("click");
    expect(app.elements["call-hint"].hidden).toBe(true);
    await app.advance(61_000);
    expect(app.elements["call-time"].textContent).toBe("01:01");
  });

  test("Turn: Stücke gehen binär hinaus, Zeilen „Du: …“ und tybos Sätze mit dem Beginn der Wiedergabe, Zustände als Text", async () => {
    const app = await calling();
    await app.emitCall({ type: "speechstart" });
    await app.emitCall({ type: "chunk", samples: new Int16Array(320).fill(5) });
    await app.emitCall({ type: "pause" });
    await app.emitCall({ type: "speechend" });
    expect(app.ws().types()).toEqual(["start", "pcm", "utterance_pause", "utterance_end"]);
    expect(app.callState()).toBe("Versteht …");
    app.ws().receive({ type: "state", state: "versteht" });
    app.ws().receive({ type: "transcript", text: "Wie wird das Wetter?" });
    app.ws().receive({ type: "state", state: "denkt" });
    await settle();
    expect(app.callState()).toBe("Denkt …");
    expect(app.elements["call-expect"].hidden).toBe(true);
    app.ws().receive({ type: "tool", name: "history_search" });
    expect(app.elements["call-step"].textContent).toBe("schaut nach …");
    app.ws().receive({ type: "sentence", id: 1, text: "Morgen wird es sonnig." });
    app.ws().receive({ type: "state", state: "spricht" });
    app.ws().receive({ type: "audio_begin", id: 1 });
    await settle();
    expect(app.callState()).toBe("Spricht");
    expect(app.callPanel.attributes["data-tap"]).toBe("true");
    const lines = () => app.elements["call-lines"].children.map((c: any) => c.textContent);
    expect(lines()).toEqual(["Du: Wie wird das Wetter?"]);
    app.playerNode().port.onmessage({ data: { type: "begin", id: 1, epoch: 0 } });
    expect(lines()).toEqual(["Du: Wie wird das Wetter?", `${TYBO_BRAND.name}: Morgen wird es sonnig.`]);
    // Mikrofon offen, während tybo spricht
    expect(app.elements["call-dot"].attributes["data-mic"]).toBe("open");
  });

  test("Rückfall der Stimme (Issue #276): audio_restart an den Spieler, speak_browser spricht nach dem Ton davor, played genau einmal", async () => {
    const app = await calling();
    await app.emitCall({ type: "speechstart" });
    await app.emitCall({ type: "speechend" });
    app.ws().receive({ type: "transcript", text: "Hallo" });
    app.ws().receive({ type: "sentence", id: 1, text: "Erster Satz." });
    app.ws().receive({ type: "audio_begin", id: 1 });
    app.ws().receive({ type: "audio_restart", id: 1 });
    // Fremde ID: nichts
    app.ws().receive({ type: "audio_restart", id: 9 });
    app.ws().receive({ type: "audio_end", id: 1 });
    app.ws().receive({ type: "notice", text: "Testa ist nicht erreichbar, weiter mit Jürgen." });
    await settle();
    const posted = () => app.playerNode().port.posted.map((m: any) => m.type + ":" + (m.id ?? ""));
    expect(posted().filter((x: string) => x.startsWith("restart"))).toEqual(["restart:1"]);
    expect(app.callNote()).toBe("Testa ist nicht erreichbar, weiter mit Jürgen.");
    app.ws().receive({ type: "sentence", id: 2, text: "Zweiter Satz." });
    app.ws().receive({ type: "audio_begin", id: 2 });
    app.ws().receive({ type: "speak_browser", id: 2, text: "Zweiter Satz." });
    await settle();
    expect(posted()).toContain("drop:2");
    const synth = app.window.speechSynthesis;
    // Der Ton von Satz 1 läuft noch: die Browser-Stimme wartet
    expect(synth.spoken.map((u: any) => u.text)).toEqual([]);
    app.playerNode().port.onmessage({ data: { type: "played", id: 1, epoch: 0 } });
    await settle();
    expect(synth.spoken.map((u: any) => u.text)).toEqual(["Zweiter Satz."]);
    synth.spoken[0].onend();
    await settle();
    expect(app.ws().json().filter((m: any) => m.type === "played").map((m: any) => m.id)).toEqual([1, 2]);
  });

  test("Rückfall der Stimme (Issue #276): Verlassen der Seite bricht die Ersatzstimme ab, kein spätes played", async () => {
    const app = await calling();
    await app.emitCall({ type: "speechstart" });
    await app.emitCall({ type: "speechend" });
    app.ws().receive({ type: "transcript", text: "Hallo" });
    app.ws().receive({ type: "sentence", id: 1, text: "Erster Satz." });
    app.ws().receive({ type: "speak_browser", id: 1, text: "Erster Satz." });
    await settle();
    const synth = app.window.speechSynthesis;
    expect(synth.spoken.map((u: any) => u.text)).toEqual(["Erster Satz."]);
    const cancelled = synth.cancelled;
    for (const fn of app.windowListeners["pagehide"] ?? []) fn({});
    expect(synth.cancelled).toBeGreaterThan(cancelled);
    expect(app.ws().json().at(-1)).toEqual({ type: "hangup" });
    synth.spoken[0].onend();
    await app.advance(60_000);
    await settle();
    expect(app.ws().json().filter((m: any) => m.type === "played")).toEqual([]);
  });

  test("Antippen der Ansicht und Leertaste unterbrechen: Wiedergabe leer, interrupt; ein Knopf in der Ansicht löst das nicht aus", async () => {
    const app = await calling();
    const speak = async () => {
      await app.emitCall({ type: "speechstart" });
      await app.emitCall({ type: "speechend" });
      app.ws().receive({ type: "state", state: "versteht" });
      app.ws().receive({ type: "transcript", text: "Hallo" });
      app.ws().receive({ type: "sentence", id: 1, text: "Hallo." });
      app.ws().receive({ type: "state", state: "spricht" });
      await settle();
    };
    await speak();
    app.tapCallButton();
    expect(app.ws().types()).not.toContain("interrupt");
    app.tapCallPanel();
    expect(app.ws().types().at(-1)).toBe("interrupt");
    expect(app.playerNode().port.posted.at(-1)).toMatchObject({ type: "flush" });
    expect(app.callState()).toBe("Hört zu");
    app.ws().receive({ type: "state", state: "hoert-zu" });
    await speak();
    app.spaceCall();
    expect(app.ws().types().filter(t => t === "interrupt")).toHaveLength(2);
    // Leertaste auf einem Knopf drückt den Knopf, nicht das Unterbrechen
    app.ws().receive({ type: "state", state: "hoert-zu" });
    await speak();
    app.spaceCall({ closest: (sel: string) => (sel === "button" ? {} : null) } as any);
    expect(app.ws().types().filter(t => t === "interrupt")).toHaveLength(2);
  });

  test("Stumm: Knopf mit aria-pressed, Zustand „Stumm“, mute an den Server, Spur aus, Strom offen", async () => {
    const app = await calling();
    app.elements["call-mute"].dispatch("click");
    expect(app.elements["call-mute"].attributes["aria-pressed"]).toBe("true");
    expect(app.callState()).toBe("Stumm");
    expect(app.ws().json().at(-1)).toEqual({ type: "mute", on: true });
    expect(app.fakes.mic.streams[0]!.tracks[0]!.enabled).toBe(false);
    expect(app.tracksStopped()).toBe(false);
    expect(app.elements["call-dot"].attributes["data-mic"]).toBe("closed");
    app.elements["call-mute"].dispatch("click");
    expect(app.callState()).toBe("Hört zu");
    expect(app.ws().json().at(-1)).toEqual({ type: "mute", on: false });
  });

  test("getippte Nachrichten gehen während des Gesprächs nicht nebenher raus", async () => {
    const app = await calling();
    app.elements["input"].value = "getippt";
    app.elements["composer"].dispatch("submit", { preventDefault() {} });
    await settle();
    expect(app.server.of("POST", "/messages")).toHaveLength(0);
  });

  test("Aufgelegt vom Server: Zustand mit Dauer und Grund, „Schließen“ und „Noch einmal“", async () => {
    const app = await calling();
    await app.advance(5000);
    app.ws().receive({ type: "ended", reason: "stille", seconds: 125 });
    app.ws().drop(1000);
    await settle();
    expect(app.callState()).toBe("Aufgelegt");
    expect(app.callNote()).toBe("Zwei Minuten nichts gehört.");
    expect(app.elements["call-time"].textContent).toBe("nach 02:05");
    expect(app.elements["call-close"].hidden).toBe(false);
    expect(app.elements["call-again"].hidden).toBe(false);
    expect(app.elements["call-hangup"].hidden).toBe(true);
    expect(app.elements["call-mute"].hidden).toBe(true);
    expect(app.tracksStopped()).toBe(true);
    expect(app.box.hidden).toBe(true);
    app.elements["call-close"].dispatch("click");
    expect(app.callPanel.hidden).toBe(true);
    expect(app.box.hidden).toBe(false);
    expect(app.call.focused).toBe(1);
  });

  test("Fehler beim Start: Satz und „Noch einmal“ ruft erneut an", async () => {
    const app = await started();
    app.tapCall();
    await settle();
    app.ws().open();
    app.ws().receive({ type: "error", reason: "nicht-bereit", message: "Der Telefonhörer ist gerade nicht bereit." });
    app.ws().receive({ type: "ended", reason: "start", seconds: 0 });
    await settle();
    expect(app.callState()).toBe("Fehler");
    expect(app.callPanel.attributes["data-phase"]).toBe("error");
    expect(app.callNote()).toBe("Der Telefonhörer ist gerade nicht bereit.");
    app.elements["call-again"].dispatch("click");
    await settle();
    expect(app.sockets()).toHaveLength(2);
    expect(app.callState()).toBe("Verbindet …");
  });

  test("Mikrofon verweigert: Satz aus RECORDING_TEXT, kein Ton hinaus", async () => {
    const app = await started({ microphone: "deny" });
    app.tapCall();
    await settle();
    expect(app.callState()).toBe("Fehler");
    expect(app.callNote()).toContain("Mikrofon");
    expect(app.ws().binaries()).toHaveLength(0);
  });
});

describe("Auflegen", () => {
  test("Knopf „Auflegen“: hangup, Verbindung zu, alle Spuren gestoppt, AudioContext zu, Eingabebox zurück", async () => {
    const app = await calling();
    app.elements["call-hangup"].dispatch("click");
    expect(app.ws().json().at(-1)).toEqual({ type: "hangup" });
    expect(app.ws().readyState).toBe(3);
    expect(app.tracksStopped()).toBe(true);
    expect(app.fakes.contexts.every((c: any) => c.closed)).toBe(true);
    expect(app.fakes.wake.sentinels.every((w: any) => w.released)).toBe(true);
    expect(app.callPanel.hidden).toBe(true);
    expect(app.box.hidden).toBe(false);
    expect(app.call.focused).toBe(1);
  });

  test("Gesprächswechsel legt auf", async () => {
    const app = await calling();
    app.entry("topic-9").dispatch("click");
    await settle();
    expect(app.ws().json().at(-1)).toEqual({ type: "hangup" });
    expect(app.tracksStopped()).toBe(true);
    expect(app.callPanel.hidden).toBe(true);
    expect(app.box.hidden).toBe(false);
  });

  test("Abmelden, pagehide und das Öffnen der Einstellungen legen auf", async () => {
    const logout = await calling();
    logout.elements["logout"].dispatch("click");
    await settle();
    expect(logout.tracksStopped()).toBe(true);
    expect(logout.ws().readyState).toBe(3);
    expect(logout.callPanel.hidden).toBe(true);

    const hide = await calling();
    for (const fn of hide.windowListeners["pagehide"] ?? []) fn({});
    expect(hide.tracksStopped()).toBe(true);
    expect(hide.ws().json().at(-1)).toEqual({ type: "hangup" });

    const settings = await calling({ settingsView: true });
    settings.elements["open-settings"].dispatch("click");
    await settle();
    expect(settings.elements["main"].attributes["data-view"]).toBe("settings");
    expect(settings.tracksStopped()).toBe(true);
    expect(settings.ws().json().at(-1)).toEqual({ type: "hangup" });
    expect(settings.callPanel.hidden).toBe(true);
  });

  test("abgemeldet während des Gesprächs (ended abgemeldet): alles frei, weiter zur Anmeldung", async () => {
    const app = await calling();
    app.ws().receive({ type: "ended", reason: "abgemeldet", seconds: 4 });
    await settle();
    expect(app.tracksStopped()).toBe(true);
    expect(app.callPanel.hidden).toBe(true);
    expect(app.window.location.href).toBe("/login");
  });

  test("Hintergrund auf dem iPhone: hält der Browser den Ton an, legt tybo auf und sagt es", async () => {
    const app = await calling();
    app.document.visibilityState = "hidden";
    for (const fn of app.docListeners["visibilitychange"] ?? []) fn();
    app.fakes.contexts[0].state = "interrupted";
    app.fakes.contexts[0].onstatechange?.();
    await settle();
    expect(app.callState()).toBe("Aufgelegt");
    expect(app.callNote()).toBe("Gespräch beendet, weil die App im Hintergrund war.");
    expect(app.tracksStopped()).toBe(true);
  });
});

describe("Neuladen wegen einer neuen Version", () => {
  async function withUpdate() {
    const app = await calling();
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

  test("die Rückfrage nennt das laufende Gespräch; Bestätigen legt auf und lädt", async () => {
    const app = await withUpdate();
    press(app, "Neu laden");
    expect(app.reloads()).toBe(0);
    expect(app.updateText()).toBe("Ein Gespräch am Telefonhörer läuft und wird aufgelegt. Trotzdem neu laden?");
    press(app, "Abbrechen");
    expect(app.callState()).toBe("Hört zu");
    press(app, "Neu laden");
    press(app, "Neu laden");
    expect(app.reloads()).toBe(1);
    expect(app.tracksStopped()).toBe(true);
    expect(app.ws().json().at(-1)).toEqual({ type: "hangup" });
  });
});

describe("Freigabe-Zeile (Issue #259)", () => {
  test("offene Freigabe: Zeile mit Text und denselben Knöpfen wie im Verlauf, Klick schickt POST für das Gespräch des Telefonats", async () => {
    const app = await calling();
    expect(app.elements["call-approval"].hidden).toBe(true);
    app.ws().receive({ type: "approval", choices: [{ id: "abc123", options: [{ key: "ok", label: "Freigeben" }, { key: "no", label: "Ablehnen" }] }] });
    await settle();
    expect(app.elements["call-approval"].hidden).toBe(false);
    expect(app.elements["call-approval-text"].textContent).toBe(`${TYBO_BRAND.name} wartet auf deine Freigabe`);
    const box = app.elements["call-approval-choices"].children[0]!;
    expect(box.attributes["data-choice"]).toBe("abc123");
    const buttons = box.children[0]!.children;
    expect(buttons.map((b: Node) => b.textContent)).toEqual(["Freigeben", "Ablehnen"]);
    expect(buttons[0]!.className).toContain("choice-button primary");
    buttons[0]!.dispatch("click");
    await settle();
    const posts = app.server.of("POST", "/choices/abc123");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.path).toBe(`/api/conversations/${WEB}/choices/abc123`);
    expect(JSON.parse(posts[0]!.body)).toEqual({ option: "ok" });
    // Der Server meldet die erledigte Frage: Zeile weg
    app.ws().receive({ type: "approval", choices: [] });
    await settle();
    expect(app.elements["call-approval"].hidden).toBe(true);
    // Über den WebSocket ging dafür nichts hinaus
    expect(app.ws().json().map((m: any) => m.type)).toEqual(["start"]);
  });

  test("Meldung nach dem Telefonat trägt den Absender „Telefonhörer“", () => {
    expect(appSource).toContain('telefonhoerer: "Telefonhörer"');
    expect(html).toContain('id="call-approval"');
  });
});
