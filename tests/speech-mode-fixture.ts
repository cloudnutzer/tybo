/**
 * Künstliche Signale für die Tests des Sprechmodus im Browser (Issue #250).
 * Kein Test selbst. Alles ist berechnet, nichts aufgenommen.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TYBO_BRAND } from "./brand-fixture";

const publicDir = resolve(import.meta.dir, "..", "src", "web", "public");
export const WORKLET_SOURCE = await readFile(resolve(publicDir, "speech-worklet.js"), "utf8");
export const SPEECH_SOURCE = await readFile(resolve(publicDir, "speech.js"), "utf8");

/** speech-worklet.js ohne Browser: registerProcessor fehlt, es bleiben die reinen Funktionen */
export function loadWorklet(): any {
  return new Function(
    WORKLET_SOURCE +
      "\nreturn { createSpeechResampler, createSpeechVad, createSpeechPipeline, SPEECH_RATE, SPEECH_FRAME, SPEECH_MAX_SAMPLES };"
  )();
}

export function silence(rate: number, seconds: number): Float32Array {
  return new Float32Array(Math.round(rate * seconds));
}

export function tone(rate: number, seconds: number, hz: number, amplitude = 0.5): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

/**
 * Sprachähnlich: ein Ton mit Obertönen, dessen Lautstärke wie Silben
 * schwankt (200 ms laut, 200 ms still, wie Wörter mit kurzen Lücken). Ein
 * Dauerton wäre für die Erkennung ein Dauergeräusch, keine Sprache.
 */
export function speechLike(rate: number, seconds: number, amplitude = 0.4): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const syllable = Math.min(1, 3 * Math.max(0, Math.sin(2 * Math.PI * 2.5 * t)));
    const voice = Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t) + 0.25 * Math.sin(2 * Math.PI * 720 * t);
    out[i] = (amplitude * syllable * voice) / 1.75;
  }
  return out;
}

/** Gleichmäßiges Rauschen mit festem Startwert (immer dieselben Werte) */
export function noise(rate: number, seconds: number, amplitude: number, seed = 1): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  let state = seed >>> 0;
  for (let i = 0; i < out.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = amplitude * (state / 0x80000000 - 1);
  }
  return out;
}

export function concat(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function mix(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) out[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return out;
}

/** Schickt das Signal in Blöcken wie der Browser (128 Werte) durch process(); channels: alle Kanäle gleich lang */
export function feed(pipeline: { process(channels: Float32Array[]): void }, channels: Float32Array[], block = 128): void {
  const length = channels[0]!.length;
  for (let at = 0; at < length; at += block) {
    pipeline.process(channels.map(c => c.subarray(at, Math.min(length, at + block))));
  }
}

export function rms(samples: ArrayLike<number>, from = 0, to = samples.length): number {
  let sum = 0;
  for (let i = from; i < to; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / Math.max(1, to - from));
}

/** Frequenz aus den Nulldurchgängen nach oben, zwischen erstem und letztem gemessen */
export function frequency(samples: ArrayLike<number>, rate: number, from = 0, to = samples.length): number {
  let first = -1;
  let last = -1;
  let count = 0;
  for (let i = from + 1; i < to; i++) {
    if (samples[i - 1]! < 0 && samples[i]! >= 0) {
      // Durchgang zwischen den Werten, linear geschätzt
      const at = i - 1 + -samples[i - 1]! / (samples[i]! - samples[i - 1]!);
      if (first < 0) first = at;
      last = at;
      count++;
    }
  }
  return count < 2 ? 0 : ((count - 1) * rate) / (last - first);
}

// ---------------------------------------------------------------------------
// Attrappen für die Zustandsmaschine (speech.js): Mikrofon, AudioContext,
// Worklet, fetch, Uhr, speechSynthesis, Audio, Blob-URLs, Wake Lock, Speicher
// ---------------------------------------------------------------------------

export interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function domError(name: string) {
  const err = new Error(name);
  err.name = name;
  return err;
}

export class FakeTrack {
  enabled = true;
  stopped = false;
  onended: (() => void) | null = null;
  stop() {
    this.stopped = true;
  }
}

export class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}

export interface FetchCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: any;
  aborted: boolean;
  settled: boolean;
  respond(status: number, body?: unknown, blob?: Blob): void;
  fail(): void;
}

export interface HarnessOptions {
  /** Antwort auf getUserMedia: sofort, Fehler oder von Hand (h.mic.pending) */
  microphone?: "grant" | "deny" | "missing" | "manual";
  /** addModule: sofort, Fehler oder von Hand (h.modules) */
  module?: "ok" | "fail" | "manual";
  /** modes.local.tts.where */
  tts?: "browser" | "server";
  /** false: navigator.wakeLock fehlt */
  wakeLock?: boolean;
  /** false: Zusagen für den Wake Lock von Hand (h.wake.pending) */
  wakeAuto?: boolean;
  /** false: kein localStorage */
  storage?: boolean;
  device?: Record<string, unknown>;
  voices?: { voiceURI: string; name?: string; lang: string; localService?: boolean }[];
  /** false: speechSynthesis fehlt */
  synth?: boolean;
  secure?: boolean;
}

/** speech.js mit Attrappen; die Uhr steht, bis advance() sie vorstellt */
export function speechHarness(options: HarnessOptions = {}) {
  // Uhr
  let now = 0;
  let timerSeq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  const setTimeout = (fn: () => void, ms = 0) => {
    const id = ++timerSeq;
    timers.set(id, { at: now + Math.max(0, ms), fn });
    return id;
  };
  const clearTimeout = (id: number) => void timers.delete(id);
  /** Lässt alle wartenden Promise-Schritte laufen */
  const flush = async () => {
    for (let i = 0; i < 3; i++) await new Promise<void>(resolve => setImmediate(resolve));
  };
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

  // Mikrofon
  const mic = {
    mode: options.microphone ?? "grant",
    calls: [] as any[],
    streams: [] as FakeStream[],
    pending: [] as Deferred<FakeStream>[],
  };
  const getUserMedia = (constraints: any) => {
    mic.calls.push(constraints);
    if (mic.mode === "deny") return Promise.reject(domError("NotAllowedError"));
    if (mic.mode === "missing") return Promise.reject(domError("NotFoundError"));
    if (mic.mode === "manual") {
      const d = deferred<FakeStream>();
      mic.pending.push(d);
      return d.promise.then(stream => {
        mic.streams.push(stream);
        return stream;
      });
    }
    const stream = new FakeStream();
    mic.streams.push(stream);
    return Promise.resolve(stream);
  };

  // AudioContext und Worklet
  const contexts: any[] = [];
  const modules: Deferred<void>[] = [];
  const nodes: any[] = [];
  const moduleMode = { value: options.module ?? "ok" };
  class FakeAudioContext {
    closed = false;
    resumed = 0;
    destination = { kind: "destination" };
    modulePaths: string[] = [];
    connections: string[] = [];
    constructor() {
      contexts.push(this);
    }
    get audioWorklet() {
      return {
        addModule: (path: string) => {
          this.modulePaths.push(path);
          if (moduleMode.value === "fail") return Promise.reject(new Error("kein Worklet"));
          if (moduleMode.value === "manual") {
            const d = deferred<void>();
            modules.push(d);
            return d.promise;
          }
          return Promise.resolve();
        },
      };
    }
    resume() {
      this.resumed++;
      return Promise.resolve();
    }
    close() {
      this.closed = true;
      return Promise.resolve();
    }
    createMediaStreamSource(stream: FakeStream) {
      return { stream, connected: 0, disconnected: 0, connect() { this.connected++; }, disconnect() { this.disconnected++; } };
    }
    createGain() {
      return { gain: { value: 1 }, connected: 0, disconnected: 0, connect() { this.connected++; }, disconnect() { this.disconnected++; } };
    }
    /** Ziel mit MediaStream (Telefonhörer mit Audio-Sitzung, Issue #280) */
    createMediaStreamDestination() {
      return { kind: "stream-destination", stream: { id: `wiedergabe-${contexts.indexOf(this) + 1}` } };
    }
  }
  class FakeWorkletNode {
    port = { posted: [] as any[], onmessage: null as ((e: any) => void) | null, postMessage(message: any) { this.posted.push(message); } };
    connected = 0;
    disconnected = 0;
    /** Ziele mit Ausgang und Eingang (connect(ziel, ausgang, eingang)) */
    targets: { target: any; output: number; input: number }[] = [];
    constructor(public context: any, public name: string, public options: any) {
      nodes.push(this);
    }
    connect(target?: any, output = 0, input = 0) {
      this.connected++;
      this.targets.push({ target, output, input });
    }
    /** disconnect(ziel) trennt nur dieses Ziel, ohne Ziel alle */
    disconnect(target?: any) {
      this.disconnected++;
      this.targets = target === undefined ? [] : this.targets.filter(t => t.target !== target);
    }
  }

  // Sprachausgabe des Browsers
  class FakeUtterance {
    voice: any = null;
    lang = "";
    rate = 1;
    volume = 1;
    onend: ((e?: any) => void) | null = null;
    onerror: ((e?: any) => void) | null = null;
    constructor(public text: string) {}
  }
  const synth = {
    voices: (options.voices ?? [{ voiceURI: "Anna", name: "Anna", lang: "de-DE", localService: true }]) as any[],
    all: [] as FakeUtterance[],
    cancelled: 0,
    speak(u: FakeUtterance) { this.all.push(u); },
    cancel() { this.cancelled++; },
    getVoices() { return this.voices; },
    listeners: {} as Record<string, (() => void)[]>,
    addEventListener(type: string, fn: () => void) { (this.listeners[type] ??= []).push(fn); },
    removeEventListener(type: string, fn: () => void) { this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== fn); },
    /** Gesprochenes ohne das stumme Stück zum Freischalten */
    get spoken() { return this.all.filter(u => u.volume !== 0); },
    get unlocks() { return this.all.filter(u => u.volume === 0); },
  };

  // Audio-Element und Blob-URLs (Server-Stimme)
  const audios: any[] = [];
  const playMode = { value: "ok" as "ok" | "blocked" | "broken" };
  class FakeAudio {
    src = "";
    srcObject: unknown = null;
    muted = false;
    autoplay = false;
    paused = true;
    plays = 0;
    pauses = 0;
    playbackRate = 1;
    /** Adresse bei jedem play() */
    played: string[] = [];
    onended: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor() {
      audios.push(this);
    }
    play() {
      this.plays++;
      if (playMode.value === "blocked") return Promise.reject(domError("NotAllowedError"));
      if (playMode.value === "broken") return Promise.reject(domError("NotSupportedError"));
      this.paused = false;
      this.played.push(this.src);
      return Promise.resolve();
    }
    pause() {
      this.pauses++;
      this.paused = true;
    }
  }
  const urls = { created: [] as string[], revoked: [] as string[], live: new Set<string>(), blobs: new Map<string, Blob>() };
  const URL = {
    createObjectURL(blob: Blob) {
      const url = `blob:attrappe/${urls.created.length + 1}`;
      urls.created.push(url);
      urls.live.add(url);
      urls.blobs.set(url, blob);
      return url;
    },
    revokeObjectURL(url: string) {
      urls.revoked.push(url);
      urls.live.delete(url);
    },
  };

  // Wake Lock
  const wake = {
    requests: 0,
    pending: [] as Deferred<any>[],
    sentinels: [] as any[],
    sentinel() {
      const sentinel = {
        released: false,
        listeners: [] as (() => void)[],
        release() { this.released = true; return Promise.resolve(); },
        addEventListener(_type: string, fn: () => void) { this.listeners.push(fn); },
        /** Der Browser gibt frei (Seite im Hintergrund) */
        lose() { this.released = true; for (const fn of this.listeners) fn(); },
      };
      wake.sentinels.push(sentinel);
      return sentinel;
    },
  };
  const wakeLock = {
    request(_type: string) {
      wake.requests++;
      if (options.wakeAuto === false) {
        const d = deferred<any>();
        wake.pending.push(d);
        return d.promise;
      }
      return Promise.resolve(wake.sentinel());
    },
  };

  // Speicher dieses Geräts
  const stored = new Map<string, string>();
  const storage = options.storage === false ? null : {
    getItem: (k: string) => stored.get(k) ?? null,
    setItem: (k: string, v: string) => void stored.set(k, v),
    removeItem: (k: string) => void stored.delete(k),
  };
  if (options.device) stored.set("tybo-speech-device", JSON.stringify(options.device));

  // fetch
  const calls: FetchCall[] = [];
  const fetch = (path: string, init: any = {}) => {
    const d = deferred<any>();
    const call: FetchCall = {
      method: init.method ?? "GET",
      path,
      headers: init.headers ?? {},
      body: init.body,
      aborted: false,
      settled: false,
      respond(status, body, blob) {
        if (call.settled) return;
        call.settled = true;
        d.resolve({
          status,
          ok: status >= 200 && status < 300,
          json: async () => {
            if (body === undefined) throw new Error("kein JSON");
            return body;
          },
          blob: async () => blob ?? new Blob(["ton"], { type: "audio/wav" }),
        });
      },
      fail() {
        if (call.settled) return;
        call.settled = true;
        d.reject(new TypeError("Netz weg"));
      },
    };
    if (init.signal) {
      init.signal.addEventListener("abort", () => {
        call.aborted = true;
        if (call.settled) return;
        call.settled = true;
        d.reject(domError("AbortError"));
      });
    }
    calls.push(call);
    return d.promise;
  };

  const win: any = {
    TYBO_BRAND,
    isSecureContext: options.secure ?? true,
    navigator: { mediaDevices: { getUserMedia }, ...(options.wakeLock === false ? {} : { wakeLock }) },
    AudioContext: FakeAudioContext,
    AudioWorkletNode: FakeWorkletNode,
    ...(options.synth === false ? {} : { speechSynthesis: synth, SpeechSynthesisUtterance: FakeUtterance }),
    Audio: FakeAudio,
    URL,
    Blob,
  };
  const api = new Function(
    "window",
    SPEECH_SOURCE +
      "\nreturn { createSpeechMode, speechModeSupported, readySpeechModes, readSpeechDevice, writeSpeechDevice, speechModeVoices, speechModeVoice, speechGuardMs, speechWav, SPEECH_MODE_TEXT, SPEECH_DEVICE_KEY, SPEECH_PAUSES," +
      " createSpeechDeviceSettings: typeof createSpeechDeviceSettings === 'function' ? createSpeechDeviceSettings : null };"
  )(win);

  const list: any[] = [];
  const seen = { changes: 0, levels: 0, accepted: 0, syncs: 0, unauthorized: 0, closed: [] as [string, string][] };
  const page = { running: false };
  const mode = api.createSpeechMode({
    win,
    fetch,
    setTimeout,
    clearTimeout,
    storage,
    messages: () => list,
    running: () => page.running,
    onChange: () => void seen.changes++,
    onLevel: () => void seen.levels++,
    onAccepted: () => void seen.accepted++,
    requestSync: () => void seen.syncs++,
    onUnauthorized: () => void seen.unauthorized++,
    onClosed: (id: string, text: string) => void seen.closed.push([id, text]),
    microphoneProblem: (err: any) => `Mikrofon: ${err && err.name}`,
    stopTracks: (stream: FakeStream) => {
      for (const t of stream.getTracks()) t.stop();
    },
  });

  const status = { ready: true, stt: { id: "whisper-cpp", label: "whisper.cpp", local: true, available: true }, tts: { id: options.tts === "server" ? "elevenlabs" : "browser", label: "Stimme", where: options.tts ?? "browser", available: true } };
  const CONVERSATION = "33333333-3333-4333-8333-333333333333";

  const h = {
    api,
    win,
    mode,
    list,
    seen,
    page,
    mic,
    contexts,
    modules,
    moduleMode,
    nodes,
    synth,
    audios,
    playMode,
    urls,
    wake,
    stored,
    storage,
    calls,
    status,
    CONVERSATION,
    flush,
    advance,
    now: () => now,
    timerCount: () => timers.size,
    view: () => mode.view(),
    /** Tipp auf „Sprechen" und warten, bis das Mikrofon entschieden ist */
    async start(conversationId = CONVERSATION) {
      mode.start(conversationId, status);
      await flush();
    },
    node: () => nodes[nodes.length - 1],
    /** Letzte Einstellung an das Worklet */
    vad: () => [...nodes[nodes.length - 1].port.posted].reverse().find((m: any) => m.type === "config"),
    /** Meldung des Worklets mit der aktuellen Laufnummer (oder der angegebenen) */
    async emit(message: Record<string, unknown>, node = nodes[nodes.length - 1]) {
      const config = [...node.port.posted].reverse().find((m: any) => m.type === "config");
      node.port.onmessage?.({ data: { epoch: config ? config.epoch : 0, ...message } });
      await flush();
    },
    /** Eine fertige Äußerung aus dem Worklet */
    async say(samples = new Int16Array(16000), extra: Record<string, unknown> = {}) {
      await h.emit({ type: "start" });
      await h.emit({ type: "utterance", samples, limit: false, ...extra });
    },
    uploads: () => calls.filter(c => c.method === "POST" && c.path.endsWith("/speech")),
    polls: () => calls.filter(c => c.method === "GET" && c.path.endsWith("/speech")),
    ttsCalls: () => calls.filter(c => c.path === "/api/speech/tts"),
    stops: () => calls.filter(c => c.path.endsWith("/stop")),
    lastUpload: () => calls.filter(c => c.method === "POST" && c.path.endsWith("/speech")).at(-1)!,
    /** Antwort auf den letzten Upload */
    async answerUpload(status: number, body?: unknown) {
      h.lastUpload().respond(status, body);
      await flush();
    },
    /** 202 mit Kennung der eigenen Nachricht */
    async accept(messageId = "m-1", transcript = "Wie wird das Wetter?") {
      await h.answerUpload(202, { transcript, messageId });
    },
    /** Nachricht im Verlauf (Ereignis oder Abgleich) */
    async add(message: Record<string, unknown>) {
      list.push(message);
      mode.messagesChanged();
      await flush();
    },
    own: (id = "m-1") => ({ id, role: "user", text: "Wie wird das Wetter?", source: "speech", createdAt: "2026-09-30T10:00:00.000Z" }),
    reply: (id = "a-1", segments = ["Morgen wird es sonnig.", "Nimm trotzdem eine Jacke mit."]) => ({
      id,
      role: "assistant",
      text: segments.join(" "),
      speakable: segments.join(" "),
      speakSegments: segments,
      createdAt: "2026-09-30T10:00:05.000Z",
    }),
    /** Bis zur Annahme: Start, Äußerung, 202, eigene Nachricht im Verlauf */
    async toThinking(messageId = "m-1") {
      if (mode.view().phase === "off") await h.start();
      await h.say();
      await h.accept(messageId);
      mode.status(true, false);
      await h.add(h.own(messageId));
    },
    tracks: () => mic.streams.flatMap(s => s.tracks),
    /** Alles frei: Spuren gestoppt, Kontexte zu, Wake Lock frei, keine Zeitgeber, keine offene Anfrage, keine Blob-URL */
    released() {
      return {
        tracksStopped: mic.streams.flatMap(s => s.tracks).every(t => t.stopped),
        contextsClosed: contexts.every(c => c.closed),
        wakeReleased: wake.sentinels.every(w => w.released),
        timers: timers.size,
        openRequests: calls.filter(c => !c.settled).length,
        liveUrls: urls.live.size,
      };
    },
  };
  return h;
}

export const ALL_RELEASED = { tracksStopped: true, contextsClosed: true, wakeReleased: true, timers: 0, openRequests: 0, liveUrls: 0 };
