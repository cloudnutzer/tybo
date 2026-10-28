/**
 * Attrappen für den Telefonhörer im Browser (Issue #258): call.js mit
 * Mikrofon, AudioContext, Worklets, speechSynthesis und Wake Lock aus
 * tests/speech-mode-fixture.ts, dazu ein WebSocket und eine Uhr. Kein Test
 * selbst.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { SPEECH_SOURCE, speechHarness, type HarnessOptions } from "./speech-mode-fixture";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
export const CALL_SOURCE = await readFile(resolve(publicDir, "call.js"), "utf8");
export const PLAYER_SOURCE = await readFile(resolve(publicDir, "call-player-worklet.js"), "utf8");

/** call-player-worklet.js ohne Browser */
export function loadPlayer(): any {
  return new Function(PLAYER_SOURCE + "\nreturn { createCallPlayer, CALL_PLAYER_START_MS };")();
}

export class FakeWebSocket {
  static all: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  /** Gesendet: Text (JSON) und binär (ArrayBuffer) in Reihenfolge */
  sent: (string | ArrayBuffer)[] = [];
  closedWith: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWebSocket.all.push(this);
  }
  send(data: string | ArrayBuffer) {
    if (this.readyState !== 1) throw new Error("nicht offen");
    this.sent.push(data);
  }
  close(code = 1000) {
    if (this.closedWith === null) this.closedWith = code;
    this.readyState = 3;
  }
  /** Server nimmt an */
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  receive(message: Record<string, unknown>) {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  receiveBinary(bytes: number, fill = 7) {
    const buffer = new ArrayBuffer(bytes);
    new Int16Array(buffer).fill(fill);
    this.onmessage?.({ data: buffer });
  }
  /** Verbindung reißt ab bzw. Server schließt */
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
  json(): any[] {
    return this.sent.filter(m => typeof m === "string").map(m => JSON.parse(m as string));
  }
  types(): string[] {
    return this.sent.map(m => (typeof m === "string" ? JSON.parse(m).type : "pcm"));
  }
  binaries(): ArrayBuffer[] {
    return this.sent.filter(m => typeof m !== "string") as ArrayBuffer[];
  }
}

export const CALL_STATUS = {
  ready: true,
  model: "claude-sonnet-5-5",
  via: "api",
  expectation: "erster Satz nach rund 1,5 Sekunden",
  stt: { id: "parakeet", local: true, warm: true },
  tts: { id: "pocket", where: "server" as "server" | "browser", stream: true },
};

export interface CallHarnessOptions extends HarnessOptions {
  /** Gerät: Einstellungen des Telefonhörers in localStorage */
  callDevice?: Record<string, unknown>;
  /** iPhone-App (Home-Bildschirm) */
  ios?: boolean;
  /** false: kein WebSocket im Fenster */
  socket?: boolean;
  /**
   * navigator.audioSession (Issue #280): "ok" mit Startwert type "auto",
   * "throws" wirft beim Setzen; ohne Angabe fehlt die API (Chrome, Android)
   */
  audioSession?: "ok" | "throws";
}

/** Attrappe der W3C Audio Session: merkt sich jeden gesetzten Wert */
export class FakeAudioSession {
  sets: string[] = [];
  #type = "auto";
  constructor(private throws = false) {}
  get type() {
    return this.#type;
  }
  set type(value: string) {
    if (this.throws) throw new Error("nicht erlaubt");
    this.sets.push(value);
    this.#type = value;
  }
}

/** call.js mit Attrappen; die Uhr steht, bis advance() sie vorstellt */
export function callHarness(options: CallHarnessOptions = {}) {
  FakeWebSocket.all = [];
  const fakes = speechHarness(options);
  if (options.callDevice) fakes.stored.set("tybo-call-device", JSON.stringify(options.callDevice));
  let now = 1_000_000;
  let timerSeq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const setTimeout = (fn: () => void, ms = 0) => {
    const id = ++timerSeq;
    timers.set(id, { at: now + Math.max(0, ms), fn });
    return id;
  };
  const clearTimeout = (id: number) => void timers.delete(id);
  const flush = fakes.flush;
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const entry of timers) if (entry[1].at <= end && (!next || entry[1].at < next[1].at)) next = entry;
      if (!next) break;
      now = next[1].at;
      timers.delete(next[0]);
      next[1].fn();
      await flush();
    }
    now = end;
    await flush();
  }

  const win = fakes.win;
  if (options.socket !== false) win.WebSocket = FakeWebSocket;
  win.location = { protocol: "https:", host: "tybo.example" };
  if (options.audioSession) win.navigator.audioSession = new FakeAudioSession(options.audioSession === "throws");
  if (options.ios) {
    win.navigator.userAgent = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)";
    win.navigator.standalone = true;
  }
  const api = new Function(
    "window",
    SPEECH_SOURCE + "\n" + CALL_SOURCE +
      "\nreturn { createCallMode, callSupported, readyCallMode, readCallDevice, writeCallDevice, callIosApp, callClock, createCallDeviceSettings, CALL_TEXT, CALL_DEVICE_KEY };"
  )(win);
  const seen = { changes: 0, levels: 0, ticks: 0, unauthorized: 0 };
  const mode = api.createCallMode({
    win,
    setTimeout,
    clearTimeout,
    now: () => now,
    storage: fakes.storage,
    onChange: () => void seen.changes++,
    onLevel: () => void seen.levels++,
    onTick: () => void seen.ticks++,
    onUnauthorized: () => void seen.unauthorized++,
    microphoneProblem: (err: any) => `Mikrofon: ${err && err.name}`,
    stopTracks: (stream: any) => {
      for (const t of stream.getTracks()) t.stop();
    },
  });
  const CONVERSATION = "33333333-3333-4333-8333-333333333333";

  const vadNodes = () => fakes.nodes.filter((n: any) => n.name === "speech-vad");
  const playerNodes = () => fakes.nodes.filter((n: any) => n.name === "call-player");
  const h = {
    api,
    win,
    fakes,
    mode,
    seen,
    CONVERSATION,
    flush,
    advance,
    now: () => now,
    timerCount: () => timers.size,
    view: () => mode.view(),
    sockets: () => FakeWebSocket.all,
    ws: () => FakeWebSocket.all[FakeWebSocket.all.length - 1]!,
    vadNode: () => vadNodes().at(-1),
    playerNode: () => playerNodes().at(-1),
    /** Letzte Einstellung an das Aufnahme-Worklet */
    vad: () => [...vadNodes().at(-1).port.posted].reverse().find((m: any) => m.type === "config"),
    /** Befehle an den Spieler */
    player: () => playerNodes().at(-1).port.posted as any[],
    /** Meldung des Aufnahme-Worklets mit der aktuellen Laufnummer */
    async emit(message: Record<string, unknown>) {
      const node = vadNodes().at(-1);
      const config = [...node.port.posted].reverse().find((m: any) => m.type === "config");
      node.port.onmessage?.({ data: { epoch: config ? config.epoch : 0, ...message } });
      await flush();
    },
    /** Meldung des Spielers mit der aktuellen Laufnummer (oder der angegebenen) */
    async played(type: "begin" | "played", id: number, epoch?: number) {
      const node = playerNodes().at(-1);
      const flushes = node.port.posted.filter((m: any) => m.type === "flush");
      const current = flushes.length ? flushes.at(-1).epoch : 0;
      node.port.onmessage?.({ data: { type, id, epoch: epoch ?? current } });
      await flush();
    },
    chunk: (fill = 300) => ({ type: "chunk", samples: new Int16Array(320).fill(fill) }),
    /** Tipp auf „Telefonhörer", Mikrofon entschieden, Verbindung offen, start gesendet */
    async start(status: any = CALL_STATUS) {
      mode.start(CONVERSATION, status, "General");
      await flush();
      h.ws().open();
      await flush();
    },
    /** Bis „Hört zu": ready und state hoert-zu */
    async listening(status: any = CALL_STATUS, ready: Record<string, unknown> = {}) {
      await h.start(status);
      h.ws().receive({ type: "ready", model: "claude-sonnet-5-5", via: "api", stt: "parakeet", tts: status.tts.where, sampleRate: 24000, ...ready });
      h.ws().receive({ type: "state", state: "hoert-zu" });
      await flush();
    },
    /** Eine ganze Äußerung aus dem Worklet: Beginn, drei Stücke, Pause, Ende */
    async utter() {
      await h.emit({ type: "speechstart" });
      for (let i = 0; i < 3; i++) await h.emit(h.chunk());
      await h.emit({ type: "pause" });
      await h.emit({ type: "speechend", limit: false });
    },
    /** Server bis „Spricht" mit Abschnitt 1 (Ton aus dem Server oder nur Satz) */
    async speaking(text = "Mir geht es gut, danke.", id = 1) {
      const ws = h.ws();
      ws.receive({ type: "state", state: "versteht" });
      ws.receive({ type: "transcript", text: "Wie geht es dir?" });
      ws.receive({ type: "state", state: "denkt" });
      ws.receive({ type: "sentence", id, text });
      ws.receive({ type: "state", state: "spricht" });
      await flush();
    },
    tracks: () => fakes.mic.streams.flatMap(s => s.tracks),
    released() {
      return {
        tracksStopped: fakes.mic.streams.flatMap(s => s.tracks).every(t => t.stopped),
        contextsClosed: fakes.contexts.every((c: any) => c.closed),
        wakeReleased: fakes.wake.sentinels.every((w: any) => w.released),
        timers: timers.size,
        socketsClosed: FakeWebSocket.all.every(w => w.readyState === 3),
      };
    },
  };
  return h;
}

export const CALL_RELEASED = { tracksStopped: true, contextsClosed: true, wakeReleased: true, timers: 0, socketsClosed: true };
