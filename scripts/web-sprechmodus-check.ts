#!/usr/bin/env bun
/**
 * Browser-Durchlauf des Sprechmodus (Issue #250) mit Headless-Chrome über das
 * DevTools-Protokoll. Kein Teil von `bun run check` (braucht Chrome), wird
 * von Hand gestartet:
 *
 *   bun run scripts/web-sprechmodus-check.ts
 *   bun run scripts/web-sprechmodus-check.ts --screenshots   # zusätzlich nach docs/webui/screenshots/
 *   bun run scripts/web-sprechmodus-check.ts --echt          # Hören mit whisper.cpp statt Attrappe
 *   bun run scripts/web-sprechmodus-check.ts --pocket        # Server-Stimme: echtes Pocket TTS (Issue #252)
 *
 * Eigener Web-Server auf freiem Port (Gesprächsspeicher in einem temporären
 * Verzeichnis), keine .env, src/bot.ts wird nicht geladen, nichts pollt
 * Telegram. Der Chat ist eine Attrappe: es antwortet kein Modell.
 *
 * Mikrofon: Chromes Attrappe spielt eine WAV-Datei ab
 * (--use-file-for-fake-audio-capture=<datei>%noloop), die dieses Skript im
 * temporären Verzeichnis erzeugt: auf dem Mac ein deutscher Satz mit `say`,
 * davor und danach Stille; ohne `say` Tonfolgen. Jedes neue Öffnen des
 * Mikrofons spielt die Datei von vorn. Der Ton läuft durch das echte
 * AudioWorklet der Seite (Mono, 16 kHz, Pausenerkennung).
 *
 * Stimme: Headless-Chrome hat keine Stimmen. speechSynthesis ist deshalb in
 * der Seite durch eine Attrappe ersetzt, die jedes Segment mitschreibt. Die
 * gemessene Zeit „Antwort bis erstes Segment" ist mit der Browser-Stimme
 * also eine Attrappenzeit.
 *
 * Ohne Schalter: Hören über eine Attrappe (fester Text), dazu ein Lauf mit
 * einer Server-Stimme, deren synthesize eine kurze erzeugte WAV liefert
 * (samt Vorladen). Geprüft werden alle Zustände des Bereichs.
 *
 * Mit --echt: Hören über die echte Sprach-Schnittstelle mit whisper.cpp
 * (scripts/web-dev-speech.ts, dieselbe Kette wie getSpeech()). Die Wahl ist
 * fest auf whisper-cpp gestellt und die Umgebung der Anbieter enthält keine
 * API-Schlüssel: kein Cloud-Anbieter kann einspringen, config/settings.json
 * wird nicht gelesen. Geprüft wird, dass der erkannte Text den gesprochenen
 * Satz trifft (verglichen ohne Satzzeichen und Großschreibung); gemessen
 * wird je Stufe. Braucht whisper-cli (PATH oder WHISPER_CLI_PATH), das
 * Modell (models/ggml-medium.bin oder WHISPER_MODEL_PATH) und `say`.
 *
 * Eigene Stimme (Issue #253): Der Reiter „Sprechen" zeigt den Abschnitt
 * „Eigene Stimme". Ablage, Einwilligung, Routen und Kennzeichnung sind echt
 * (createBotVoiceClone und createCloneTts in einem temporären Ordner), nur
 * der Pocket-Prozess ist eine Attrappe, die einen kurzen Ton liefert: kein
 * Python, kein Modell, kein Hugging-Face-Token. Geprüft: ohne Häkchen kein
 * Mikrofon, Aufnahme mit dem Mikrofon der Attrappe, Anhören, Speichern mit
 * Einwilligung, Probe mit Kennzeichnung, Verwenden, Löschen samt Ordner.
 *
 * Mit --pocket (Issue #252): Der Teil „Server-Stimme" liest mit dem echten
 * Pocket TTS aus models/speech/ dieses Checkouts vor (eingerichtet mit
 * `tybo setup sprache`), über dieselbe Kette wie im Bot. Der erste Satz
 * startet den Prozess (Kaltstart); gemessen werden „Antwort bis erstes
 * Segment" und die Dauer jeder Synthese. Ohne Netz für die Stimme, ohne
 * API-Schlüssel in der Umgebung der Anbieter.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { prepareSpeechAudio } from "../src/web/audio-duration";
import type { RunTurnOptions, WebChat } from "../src/web/chat";
import { createDemoAgents, createDemoCommands, createDemoEngines, createDemoInstructions, createDemoKeys, createDemoModels, createDemoStatus } from "../src/web/demo";
import { createWebServer } from "../src/web/server";
import type { SpeechPort, SpeechRecognition } from "../src/web/speech";
import { ConversationStore } from "../src/web/store";
import { UploadStore } from "../src/web/uploads";
import type { VoicePort } from "../src/web/voice";
import { createDevSpeech } from "./web-dev-speech";
import type { Settings } from "../src/lib/settings";
import { createCloneTts } from "../src/lib/speech/clone";
import { speechDir } from "../src/lib/speech/parakeet";
import { POCKET_CLONE_REVISION, POCKET_LANGUAGE, POCKET_VERSION, pocketClonePaths, pocketPaths, type PocketServerDeps } from "../src/lib/speech/pocket";
import { readWavInfo } from "../src/lib/speech/wav";
import { createBotVoiceClone } from "../src/web/bot-voice-clone";
import type { VoiceClonePort } from "../src/web/voice-clone";
import { existsSync as fileExists, mkdirSync, readdirSync, writeFileSync } from "node:fs";

const CHROME = process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PASSWORD = "browser-check-passwort";
const SHOTS = process.argv.includes("--screenshots");
const REAL = process.argv.includes("--echt");
const POCKET = process.argv.includes("--pocket");
const OUT = join(import.meta.dir, "..", "docs", "webui", "screenshots");
const ROOT = join(import.meta.dir, "..");

/** Der gesprochene Satz (say) und was die Attrappe daraus „erkennt" */
const SENTENCE = "Wie wird das Wetter morgen in Hamburg";
const TRANSCRIPT = "Wie wird das Wetter morgen in Hamburg?";
/** Antwort der Chat-Attrappe: drei Sätze, die zu drei Segmenten werden */
const ANSWER =
  "**Kurz gesagt:** Morgen wird es in Hamburg überwiegend sonnig bei achtzehn Grad. " +
  "Am Nachmittag ziehen von Westen ein paar Wolken auf, es bleibt aber trocken. " +
  "Eine leichte Jacke für den Abend an der Elbe schadet trotzdem nicht.";
/** Eingestellte Pause bis zum Ende einer Äußerung (Standard des Geräts) */
const PAUSE_MS = 800;

function abort(text: string): never {
  console.error(text);
  process.exit(1);
}

interface Deferred {
  promise: Promise<void>;
  resolve(): void;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>(r => (resolve = r));
  return { promise, resolve };
}

// --- Ton für Chromes Mikrofon-Attrappe --------------------------------------------

function wav(rate: number, samples: Int16Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, text: string) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i]!, true);
  return bytes;
}

/** PCM16 mono aus einer WAV-Datei von `say` (mit beliebigen Blöcken vor data, etwa FLLR) */
function pcmOf(bytes: Uint8Array): { rate: number; samples: Int16Array } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(bytes[at]!, bytes[at + 1]!, bytes[at + 2]!, bytes[at + 3]!);
  if (bytes.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let rate = 0;
  let channels = 0;
  let bits = 0;
  for (let at = 12; at + 8 <= bytes.length; ) {
    const size = view.getUint32(at + 4, true);
    if (tag(at) === "fmt ") {
      if (view.getUint16(at + 8, true) !== 1) return null;
      channels = view.getUint16(at + 10, true);
      rate = view.getUint32(at + 12, true);
      bits = view.getUint16(at + 22, true);
    } else if (tag(at) === "data") {
      if (bits !== 16 || channels !== 1 || !rate) return null;
      const count = Math.floor(Math.min(size, bytes.length - at - 8) / 2);
      const samples = new Int16Array(count);
      for (let i = 0; i < count; i++) samples[i] = view.getInt16(at + 8 + i * 2, true);
      return { rate, samples };
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/** Ton mit der Lautstärke von Silben: ohne `say` das „Gesprochene" */
function toneBursts(rate: number, seconds: number): Int16Array {
  const out = new Int16Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    const syllable = Math.min(1, 3 * Math.max(0, Math.sin(2 * Math.PI * 2.5 * t)));
    const voice = Math.sin(2 * Math.PI * 180 * t) + 0.5 * Math.sin(2 * Math.PI * 360 * t) + 0.25 * Math.sin(2 * Math.PI * 720 * t);
    out[i] = Math.round(((0.5 * syllable * voice) / 1.75) * 32767);
  }
  return out;
}

/** Kurzer Ton als „Stimme" des Servers */
function beep(seconds: number, hz: number): Uint8Array {
  const rate = 24000;
  const out = new Int16Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) {
    const fade = Math.min(1, i / 600, (out.length - i) / 600);
    out[i] = Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 0.2 * fade * 32767);
  }
  return wav(rate, out);
}

/** WAV für Chromes Mikrofon-Attrappe: Stille, Satz (oder Tonfolge), Stille; 48 kHz mono */
async function microphoneFile(dir: string): Promise<{ path: string; source: string; speechSeconds: number }> {
  const rate = 48000;
  let speech: Int16Array | null = null;
  let source = "Tonfolge";
  const say = Bun.which("say");
  if (say) {
    const raw = join(dir, "satz.wav");
    // Deutsche Stimme, wenn eine da ist; sonst die Standardstimme des Systems
    const list = Bun.spawnSync([say, "-v", "?"]).stdout.toString();
    const german = list.split("\n").map(l => /^(.+?)\s+de_DE\b/.exec(l)?.[1]?.trim()).filter(Boolean) as string[];
    const voice = german.includes("Anna") ? "Anna" : german[0];
    const made = Bun.spawnSync([say, ...(voice ? ["-v", voice] : []), "-o", raw, `--data-format=LEI16@${rate}`, SENTENCE]);
    const pcm = made.exitCode === 0 && existsSync(raw) ? pcmOf(new Uint8Array(await Bun.file(raw).arrayBuffer())) : null;
    if (pcm && pcm.rate === rate && pcm.samples.length > rate / 2) {
      speech = pcm.samples;
      source = `say${voice ? ` (Stimme ${voice})` : ""}: „${SENTENCE}"`;
    }
  }
  if (!speech) {
    if (REAL) abort("--echt braucht einen gesprochenen Satz: `say` fehlt oder liefert keine WAV-Datei.");
    speech = toneBursts(rate, 2.2);
  }
  const lead = Math.round(rate * 1.2);
  const tail = Math.round(rate * 3);
  const all = new Int16Array(lead + speech.length + tail);
  all.set(speech, lead);
  const path = join(dir, "mikrofon.wav");
  await Bun.write(path, wav(rate, all));
  return { path, source, speechSeconds: speech.length / rate };
}

// --- Voraussetzungen für --echt ------------------------------------------------------

let modelPath = "";
if (REAL) {
  const cli = process.env.WHISPER_CLI_PATH || "whisper-cli";
  if (!Bun.which(cli)) abort(`--echt braucht whisper.cpp: „${cli}" nicht gefunden (PATH oder WHISPER_CLI_PATH).`);
  // Absolut: die Anbieter arbeiten in einem temporären Verzeichnis
  modelPath = process.env.WHISPER_MODEL_PATH ? resolve(process.env.WHISPER_MODEL_PATH) : join(ROOT, "models", "ggml-medium.bin");
  if (!existsSync(modelPath)) abort(`--echt braucht das Modell: ${modelPath} fehlt (models/ggml-medium.bin oder WHISPER_MODEL_PATH=<Pfad>).`);
  if (!Bun.which("say")) abort("--echt braucht `say` für den gesprochenen Satz (macOS).");
}
if (!existsSync(CHROME)) abort(`Chrome nicht gefunden: ${CHROME} (CHROME_PATH setzen).`);

const dir = await mkdtemp(join(tmpdir(), "tybo-sprechmodus-"));
const mic = await microphoneFile(dir);
console.log(`Mikrofon-Attrappe: ${mic.source}, ${mic.speechSeconds.toFixed(2)} s`);

// --- Web-Server mit steuerbaren Attrappen ----------------------------------------------

const store = new ConversationStore({ dir: join(dir, "web") });
await store.load();
const talk = await store.createConversation("general");
await store.renameConversation(talk.id, "Wochenplanung");
await store.appendMessage(talk.id, { role: "user", text: "Was steht diese Woche an?" });
await store.appendMessage(talk.id, { role: "assistant", text: "Am Mittwoch der Zahnarzt um 9 Uhr, am Freitag das Abendessen mit Alex und Mia." });
const other = await store.createConversation("research");
await store.renameConversation(other.id, "Bahnpreise");
await store.appendMessage(other.id, { role: "user", text: "Was kostet die Fahrt nach Husum?" });
await store.appendMessage(other.id, { role: "assistant", text: "Mit Sparpreis etwa 39 Euro." });

const ctl = {
  /** Ergebnis der Hör-Attrappe */
  stt: "ok" as "ok" | "empty" | "unavailable",
  sttGate: null as Deferred | null,
  /** Was bei der Erkennung ankam (vom Server neu geschriebene Fassung) */
  heard: [] as { bytes: Uint8Array; mime: string }[],
  results: [] as SpeechRecognition[],
  sttMs: [] as number[],
  ttsWhere: "browser" as "browser" | "server",
  ttsCalls: [] as string[],
  busy: false,
  chatGate: null as Deferred | null,
  turns: 0,
  stops: 0,
};

const stopped = new Set<string>();
const chat: WebChat = {
  async runTurn({ conversationId, agent, sink }: RunTurnOptions) {
    const startedAt = Date.now();
    ctl.turns++;
    stopped.delete(conversationId);
    await sink.progress({ kind: "tool", text: "WebSearch" });
    if (ctl.chatGate) await ctl.chatGate.promise;
    else await Bun.sleep(250);
    if (stopped.has(conversationId)) return { text: "", aborted: true };
    return { text: ANSWER, info: { agent, model: "attrappe", durationMs: Date.now() - startedAt } };
  },
  stop(conversationId: string) {
    ctl.stops++;
    stopped.add(conversationId);
    ctl.chatGate?.resolve();
  },
};

const real = REAL
  ? createDevSpeech({
      // Fest gewählt: nur whisper.cpp, nie still ein anderer Anbieter
      settings: () => ({ speech: { stt: "whisper-cpp", tts: "browser", language: "de" } }),
      // Ohne API-Schlüssel: kein Cloud-Anbieter ist verfügbar
      env: () => ({ WHISPER_MODEL_PATH: modelPath, ...(process.env.WHISPER_CLI_PATH ? { WHISPER_CLI_PATH: process.env.WHISPER_CLI_PATH } : {}) }),
      cwd: () => dir,
      log: () => {},
    })
  : null;
/** Echte lokale Stimme (--pocket): Einstellungen fest auf pocket, Dateien aus diesem Checkout */
const realTts = POCKET
  ? createDevSpeech({
      settings: () => ({ speech: { tts: "pocket", language: "de" } }),
      env: () => ({ PATH: process.env.PATH, HOME: process.env.HOME }),
      cwd: () => ROOT,
      log: () => {},
    })
  : null;
if (realTts && !realTts.speech.options().tts.find(t => t.id === "pocket")?.available) abort("--pocket: Pocket TTS ist in diesem Checkout nicht eingerichtet (tybo setup sprache).");
const pocketMs: number[] = [];
if (real) {
  const local = real.voice.localMode();
  if (!local.ready || local.stt?.id !== "whisper-cpp") abort(`--echt: whisper.cpp ist nicht bereit (${local.reason ?? "ohne Grund"}).`);
}

const speech: SpeechPort = {
  async recognize(audio, mime, opts) {
    ctl.heard.push({ bytes: audio.slice(), mime });
    const startedAt = Date.now();
    let result: SpeechRecognition;
    if (real) result = await real.port.recognize(audio, mime, opts);
    else {
      if (ctl.sttGate) await ctl.sttGate.promise;
      result = ctl.stt === "ok" ? { ok: true, text: TRANSCRIPT, provider: "attrappe" } : { ok: false, reason: ctl.stt };
    }
    ctl.sttMs.push(Date.now() - startedAt);
    ctl.results.push(result);
    return result;
  },
  async synthesize(text) {
    if (ctl.ttsWhere === "browser") return { ok: false, reason: "browser" };
    ctl.ttsCalls.push(text);
    if (realTts) {
      const at = Date.now();
      const result = await realTts.port.synthesize(text, {});
      pocketMs.push(Date.now() - at);
      return result;
    }
    await Bun.sleep(60);
    return { ok: true, audio: beep(0.7, 330 + 110 * (ctl.ttsCalls.length % 3)), mime: "audio/wav", provider: "attrappe" };
  },
  isBusy: () => ctl.busy,
};
const voice: VoicePort = {
  localMode: () => ({
    ready: true,
    stt: REAL ? { id: "whisper-cpp", label: "whisper.cpp", local: true, available: true } : { id: "whisper-cpp", label: "Attrappe", local: true, available: true },
    tts:
      ctl.ttsWhere === "server"
        ? { id: "elevenlabs", label: "Attrappe (Server)", where: "server", available: true }
        : { id: "browser", label: "Browser-Stimme", where: "browser", available: true },
  }),
};

// --- Eigene Stimme (Issue #253): echte Ablage und Routen, Pocket-Prozess als Attrappe ---
const cloneCwd = join(dir, "clone");
{
  const sd = speechDir(cloneCwd);
  const pp = pocketPaths(sd);
  const cp = pocketClonePaths(sd);
  mkdirSync(join(pp.venv, "bin"), { recursive: true });
  writeFileSync(pp.program, "#!/bin/sh\n");
  mkdirSync(pp.modelCache, { recursive: true });
  mkdirSync(cp.cloneCache, { recursive: true });
  writeFileSync(cp.cloneReady, "{}");
  writeFileSync(cp.cloneProof, JSON.stringify({ version: 1, pocket: POCKET_VERSION, language: POCKET_LANGUAGE, revision: POCKET_CLONE_REVISION, probe: { loadMs: 1, synthMs: 1, audioSeconds: 1, rtf: 0.1, at: "x" } }));
}
const cloneSpawned: string[][] = [];
const clonePocket: PocketServerDeps = {
  spawn(cmd) {
    cloneSpawned.push(cmd);
    return { exited: new Promise(() => {}), kill: () => {} };
  },
  async fetch(url) {
    if (url.endsWith("/health")) return new Response("ok");
    return new Response(new Uint8Array(beep(1.2, 220)), { headers: { "content-type": "audio/wav" } });
  },
  freePort: async () => 45_000,
  now: () => Date.now(),
  sleep: ms => Bun.sleep(ms),
  setTimer: () => 0,
  clearTimer: () => {},
};
let cloneSettings: Settings = { speech: { stt: "whisper-cpp", tts: "browser" } };
const cloneTts = createCloneTts({
  env: () => ({ PATH: process.env.PATH }),
  run: async () => ({ exitCode: 1, stdout: "", stderr: "", timedOut: false }),
  readFile: p => Bun.file(p).arrayBuffer().then(b => Buffer.from(b)),
  unlink: async () => {},
  mkdir: async () => {},
  exists: fileExists,
  cwd: () => cloneCwd,
  tmpDir: dir,
  unique: () => "u",
  pocket: clonePocket,
  cloneSelection: () => ({ ...(cloneSettings.speech?.cloneVoice ? { voice: cloneSettings.speech.cloneVoice } : {}) }),
});
const cloneCreates: { name: string; consent: boolean; bytes: number; head: string }[] = [];
const probeNotes: string[] = [];
const realClonePort = createBotVoiceClone({
  clone: () => cloneTts,
  getSettings: () => cloneSettings,
  updateSettings: async mutate => {
    cloneSettings = mutate(cloneSettings);
    return cloneSettings;
  },
  log: () => {},
});
const voiceClone: VoiceClonePort = {
  ...realClonePort,
  async create(input) {
    cloneCreates.push({ name: input.name, consent: input.consent, bytes: input.audio.byteLength, head: Buffer.from(input.audio.slice(0, 44)).toString("hex") });
    return realClonePort.create(input);
  },
  async probe(id) {
    const r = await realClonePort.probe(id);
    if (r.ok) probeNotes.push(readWavInfo(Buffer.from(r.audio)).ICMT ?? "");
    return r;
  },
};

const demo = createDemoAgents({ seed: false });
const server = await createWebServer(
  { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
  {
    sessionFile: join(dir, "sessions.json"),
    dataDir: join(dir, "web"),
    conversationStore: store,
    chat,
    uploads: new UploadStore({ dir: join(dir, "uploads") }),
    cliTokenFile: join(dir, "cli-token"),
    speech,
    voice,
    voiceClone,
    // Einstellungen wie in web:dev nur im Speicher (für den Reiter „Sprechen")
    settings: demo.settings,
    engines: createDemoEngines(demo.settings),
    agentCatalog: demo.catalog,
    instructions: createDemoInstructions(),
    models: createDemoModels(),
    status: createDemoStatus(),
    commands: createDemoCommands(),
    keys: createDemoKeys(),
    log: () => {},
  }
);
const front = server.url.replace(/\/$/, "");

// --- Chrome ------------------------------------------------------------------------
const debugPort = 9970 + Math.floor(Math.random() * 19);
const chrome = Bun.spawn(
  [CHROME, "--headless=new", `--remote-debugging-port=${debugPort}`, `--user-data-dir=${join(dir, "chrome")}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1280,900",
    "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${mic.path}%noloop`,
    // Der Audio-Dienst läuft auf dem Mac in einer Sandbox und kann die WAV im temporären Verzeichnis sonst nicht lesen: das Mikrofon bliebe still
    "--disable-features=AudioServiceSandbox",
    "--autoplay-policy=no-user-gesture-required", "about:blank"],
  { stdout: "ignore", stderr: "ignore" }
);

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  if (!pass) failures++;
  console.log(`${pass ? "OK  " : "FEHL"} ${name}${detail ? `  (${detail})` : ""}`);
}

async function pageSocketUrl(): Promise<string> {
  for (let i = 0; i < 100; i++) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as any[];
      const page = targets.find(t => t.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // Chrome startet noch
    }
    await Bun.sleep(100);
  }
  throw new Error("Chrome nicht erreichbar");
}

const ws = new WebSocket(await pageSocketUrl());
await new Promise(r => ws.addEventListener("open", r, { once: true }));
let nextId = 1;
const pending = new Map<number, (msg: any) => void>();
const problems: string[] = [];
/** Alle Anfragen der Seite: „METHODE /pfad" */
const requests: string[] = [];
ws.addEventListener("message", event => {
  const msg = JSON.parse(String(event.data));
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)!(msg);
    pending.delete(msg.id);
  }
  if (msg.method === "Runtime.exceptionThrown") problems.push(msg.params.exceptionDetails?.exception?.description ?? msg.params.exceptionDetails?.text ?? "Ausnahme");
  if (msg.method === "Log.entryAdded" && msg.params.entry.level === "error") problems.push(msg.params.entry.text);
  if (msg.method === "Network.requestWillBeSent") {
    const url = String(msg.params.request.url);
    if (url.startsWith(front)) requests.push(`${msg.params.request.method} ${url.slice(front.length).split("?")[0]}`);
  }
});
function cdp(method: string, params: object = {}): Promise<any> {
  const id = nextId++;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) =>
    pending.set(id, msg => (msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result)))
  );
}
async function js<T = any>(expression: string): Promise<T> {
  const r = await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(`JS-Fehler: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text} in ${expression.slice(0, 120)}`);
  return r.result.value;
}
async function waitFor(expression: string, timeoutMs = 8000): Promise<boolean> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      if (await js<boolean>(`!!(${expression})`)) return true;
    } catch {
      // Seite lädt gerade
    }
    await Bun.sleep(40);
  }
  return false;
}
async function goto(url: string) {
  await cdp("Page.navigate", { url });
  await Bun.sleep(150);
  await waitFor(`document.readyState === "complete"`);
}
async function viewport(width: number, height = width < 600 ? 844 : 800) {
  await cdp("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 1000 });
}
async function scheme(value: "light" | "dark") {
  await cdp("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value }] });
}
const noHorizontalScroll = (width: number) => js<boolean>(`document.documentElement.scrollWidth <= ${width} && document.body.scrollWidth <= ${width}`);

async function shoot(name: string) {
  await Bun.sleep(200);
  const { data } = await cdp("Page.captureScreenshot", { format: "png" });
  await Bun.write(join(OUT, `${name}.png`), Buffer.from(data, "base64"));
  console.log(`Bild ${name}.png`);
}
/** 1280 und 390 px, hell und dunkel, im gerade stehenden Zustand; ohne --screenshots nur die Breitenprüfung */
async function shootAll(name: string, prepare?: () => Promise<void>) {
  for (const width of [1280, 390]) {
    for (const s of ["light", "dark"] as const) {
      if (!SHOTS && s === "dark") continue;
      await viewport(width);
      await scheme(s);
      if (prepare) await prepare();
      await Bun.sleep(60);
      check(`${name} ${width} px ${s === "dark" ? "dunkel" : "hell"}: kein seitliches Scrollen`, await noHorizontalScroll(width));
      if (SHOTS) await shoot(`${name}-${width}${s === "dark" ? "-dunkel" : ""}`);
    }
  }
  await scheme("light");
  await viewport(1280);
}

/**
 * In jeder Seite vor ihren Skripten: Stimme als Attrappe, Mitschrift von
 * Mikrofon, AudioContext, Audio-Wiedergabe, Blob-URLs und Zuständen, und ein
 * Halt für „Nichts verstanden" (sonst nur 1,5 Sekunden zu sehen).
 */
const PAGE_HOOKS = `(() => {
  const spoken = [];
  let current = null;
  let cancels = 0;
  class Utterance {
    constructor(text) { this.text = text; this.volume = 1; this.rate = 1; this.lang = ""; this.voice = null; this.onend = null; this.onerror = null; }
  }
  const voices = [
    { voiceURI: "Online", name: "Deutsch (online)", lang: "de-DE", localService: false, default: false },
    { voiceURI: "Anna", name: "Anna", lang: "de-DE", localService: true, default: true },
    { voiceURI: "Samantha", name: "Samantha", lang: "en-US", localService: true, default: false },
  ];
  const finish = u => { if (current !== u) return; current = null; if (u.onend) u.onend({}); };
  const tts = {
    spoken,
    /** true: ein Segment „spricht", bis release() es beendet */
    hold: false,
    release() { if (current) finish(current); },
    get cancels() { return cancels; },
    get speaking() { return !!current; },
  };
  const synth = {
    getVoices: () => voices,
    speak(u) {
      // Das stumme Stück zum Freischalten zählt nicht
      if (u.volume === 0) return;
      spoken.push({ text: u.text, rate: u.rate, lang: u.lang, voice: u.voice ? u.voice.voiceURI : null, at: performance.now() });
      current = u;
      if (!tts.hold) window.__realTimeout(() => finish(u), 350);
    },
    cancel() { if (current) cancels++; current = null; },
    addEventListener() {},
    removeEventListener() {},
  };
  window.__realTimeout = window.setTimeout.bind(window);
  Object.defineProperty(window, "speechSynthesis", { value: synth, configurable: true });
  window.SpeechSynthesisUtterance = Utterance;
  window.__tts = tts;

  window.__streams = [];
  const devices = navigator.mediaDevices;
  if (devices && devices.getUserMedia) {
    const original = devices.getUserMedia.bind(devices);
    devices.getUserMedia = async constraints => {
      const stream = await original(constraints);
      window.__streams.push(stream);
      return stream;
    };
  }
  // Das Laden des Worklets meldet Chrome nicht als Netzwerk-Ereignis der Seite: die Adresse hier mitschreiben
  window.__modules = [];
  if (window.AudioWorklet) {
    const addModule = AudioWorklet.prototype.addModule;
    AudioWorklet.prototype.addModule = function (url, ...rest) { window.__modules.push(String(url)); return addModule.call(this, url, ...rest); };
  }
  window.__contexts = [];
  if (window.AudioContext) {
    const Original = window.AudioContext;
    window.AudioContext = class extends Original {
      constructor(...args) { super(...args); window.__contexts.push(this); }
    };
  }
  window.__plays = [];
  const play = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function () {
    window.__plays.push({ src: this.src, at: performance.now() });
    return play.apply(this, arguments);
  };
  window.__urls = { created: [], revoked: [] };
  const create = URL.createObjectURL.bind(URL);
  const revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = blob => { const url = create(blob); window.__urls.created.push(url); return url; };
  URL.revokeObjectURL = url => { window.__urls.revoked.push(url); revoke(url); };

  window.__phases = [];
  window.__messageTimes = [];
  document.addEventListener("DOMContentLoaded", () => {
    const state = document.getElementById("talk-state");
    if (state) new MutationObserver(() => { const last = window.__phases[window.__phases.length - 1]; if (!last || last.text !== state.textContent) window.__phases.push({ text: state.textContent, at: performance.now() }); }).observe(state, { childList: true, characterData: true, subtree: true });
    const messages = document.getElementById("messages");
    if (messages) new MutationObserver(() => window.__messageTimes.push(performance.now())).observe(messages, { childList: true });
  });

  window.__holdNothing = false;
  window.__held = [];
  window.setTimeout = (fn, ms, ...rest) => (window.__holdNothing && ms === 1500 ? (window.__held.push(fn), 0) : window.__realTimeout(fn, ms, ...rest));
  window.__releaseHeld = () => { for (const fn of window.__held.splice(0)) fn(); };
})()`;

const stateText = `document.getElementById("talk-state").textContent`;
const panelShown = `!document.getElementById("talk-panel").hidden`;
const inState = (text: string) => `${panelShown} && ${stateText} === ${JSON.stringify(text)}`;
const noteText = () => js<string>(`(n => (n.hidden ? "" : n.textContent))(document.getElementById("talk-note"))`);
const click = (id: string) => js(`document.getElementById(${JSON.stringify(id)}).click()`);
const tracksEnded = () => js<boolean>(`window.__streams.length > 0 && window.__streams.every(s => s.getTracks().every(t => t.readyState === "ended"))`);
const contextsClosed = () => js<boolean>(`window.__contexts.length > 0 && window.__contexts.every(c => c.state === "closed")`);
const micEnabled = () => js<boolean>(`window.__streams.at(-1).getAudioTracks()[0].enabled`);
const uploads = () => requests.filter(r => r.startsWith("POST ") && r.endsWith("/speech")).length;
const normalize = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

async function openTalkConversation() {
  await waitFor(`document.querySelector('.conversation[data-id="${talk.id}"]')`);
  await js(`document.querySelector('.conversation[data-id="${talk.id}"]').click()`);
  await waitFor(`document.querySelectorAll("#chat-log .msg").length >= 2`);
}
/** Segmente der jüngsten Antwort laut API */
async function lastSegments(): Promise<string[]> {
  return js<string[]>(`fetch("/api/conversations/${talk.id}/messages", { credentials: "same-origin" }).then(r => r.json()).then(d => { const a = d.messages.filter(m => m.role === "assistant" && m.speakable).at(-1); return a ? a.speakSegments : []; })`);
}
/** Mikrofon neu öffnen (die Datei der Attrappe beginnt von vorn): Pause, dann Weiter */
async function speakAgain() {
  if (await js<boolean>(`!document.getElementById("talk-pause").hidden`)) await click("talk-pause");
  await waitFor(inState("Pausiert"));
  await click("talk-resume");
}

try {
  await cdp("Runtime.enable");
  await cdp("Log.enable");
  await cdp("Page.enable");
  await cdp("Network.enable");
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: PAGE_HOOKS });
  await viewport(1280);
  await scheme("light");

  // --- Anmelden, Gespräch öffnen ---------------------------------------------------------
  await goto(`${front}/login`);
  await waitFor(`document.getElementById("password")`);
  await js(`document.getElementById("password").value = ${JSON.stringify(PASSWORD)}`);
  await js(`document.getElementById("login-form").requestSubmit()`);
  check("Anmeldung führt zum Chat", await waitFor(`location.pathname === "/" && document.getElementById("input")`, 10000));
  await openTalkConversation();

  // --- Knopf ------------------------------------------------------------------------------
  check("Knopf „Sprechen“ sichtbar und frei", await waitFor(`(b => b && !b.hidden && !b.disabled && b.getClientRects().length > 0)(document.getElementById("talk"))`));
  const button = await js<any>(`(b => ({ label: b.getAttribute("aria-label"), svg: !!b.querySelector("svg"), next: b.nextElementSibling && b.nextElementSibling.id }))(document.getElementById("talk"))`);
  check("Knopf: Name für Screenreader, inline SVG, vor Senden", /^Mit .+ sprechen$/.test(button.label) && button.svg && button.next === "send", JSON.stringify(button));
  check("vor dem Tipp kein Mikrofon angefragt", (await js<number>(`window.__streams.length`)) === 0);
  await shootAll("sprechmodus-knopf", async () => {
    const size = await js<number>(`document.getElementById("talk").getBoundingClientRect().width`);
    if ((await js<number>(`window.innerWidth`)) < 600) check("Knopf am Handy 2.75rem", size >= 44, `${size}px`);
  });

  // --- Durchlauf ohne Anhalten, mit Zeiten --------------------------------------------------
  await click("talk");
  check("Tipp: der Bereich ersetzt die Eingabebox", await js<boolean>(`${panelShown} && document.getElementById("composer-box").hidden`));
  check("Zustand „Hört zu“, roter Punkt für das offene Mikrofon", (await waitFor(inState("Hört zu"))) && (await js<boolean>(`document.getElementById("talk-dot").getAttribute("data-mic") === "open"`)));
  check("Mikrofon mit Echo- und Rauschunterdrückung, AudioContext läuft, Worklet aus eigener Datei",
    await js<boolean>(`window.__streams.length === 1 && window.__contexts.length === 1 && window.__contexts[0].state === "running" && JSON.stringify(window.__modules) === JSON.stringify(["/speech-worklet.js"])`),
    await js<string>(`"Rate des AudioContext: " + window.__contexts[0].sampleRate + " Hz, Zustand " + window.__contexts.map(c => c.state).join("/") + ", " + window.__streams.length + " Stream(s)"`));
  check("Äußerung erkannt, Antwort vorgelesen, wieder „Hört zu“",
    (await waitFor(inState("Spricht"), REAL ? 60000 : 20000)) && (await waitFor(inState("Hört zu"), 20000)),
    await js<string>(`window.__phases.map(p => p.text).join(" → ")`));
  const phases = await js<{ text: string; at: number }[]>(`window.__phases`);
  const at = (text: string) => phases.find(p => p.text === text)?.at ?? NaN;
  const order = phases.map(p => p.text);
  check("Reihenfolge der Zustände", JSON.stringify(order) === JSON.stringify(["Mikrofon wird freigegeben …", "Hört zu", "Verstehe …", "Denkt …", "Spricht", "Hört zu"]), order.join(" → "));
  check("genau ein Upload", uploads() === 1 && ctl.heard.length === 1 && ctl.turns === 1, `${uploads()} Upload(s), ${ctl.heard.length} Erkennung(en), ${ctl.turns} Turn(s)`);
  const prepared = ctl.heard[0] ? prepareSpeechAudio(ctl.heard[0].bytes, ctl.heard[0].mime) : null;
  const header = ctl.heard[0] ? new DataView(ctl.heard[0].bytes.buffer, ctl.heard[0].bytes.byteOffset) : null;
  check("Upload ist WAV, PCM16 mono 16 kHz, Länge passt zur Äußerung (Vorlauf, Sprache, höchstens 200 ms Endpause)",
    !!prepared && ctl.heard[0]!.mime === "audio/wav" && header!.getUint32(24, true) === 16000 && header!.getUint16(22, true) === 1 && header!.getUint16(34, true) === 16 &&
      prepared.seconds > mic.speechSeconds * 0.6 && prepared.seconds < mic.speechSeconds + 0.9,
    prepared ? `${prepared.seconds.toFixed(2)} s, ${ctl.heard[0]!.bytes.byteLength} Bytes` : "keine Aufnahme");
  const heardText = ctl.results[0]?.ok ? ctl.results[0].text : "";
  if (REAL) {
    check("whisper.cpp erkennt den gesprochenen Satz", normalize(heardText) === normalize(SENTENCE), `erkannt: „${heardText}“, gesprochen: „${SENTENCE}“`);
  }
  check("erkannter Text steht im Bereich und als Nachricht im Verlauf",
    (await js<string>(`document.getElementById("talk-heard").textContent`)) === `Du: ${heardText}` &&
      (await js<boolean>(`[...document.querySelectorAll("#chat-log .msg")].some(m => m.textContent.includes(${JSON.stringify(heardText)}))`)));
  const segments = await lastSegments();
  const spoken = await js<{ text: string; lang: string; voice: string; rate: number; at: number }[]>(`window.__tts.spoken`);
  check("vorgelesen wird die vorlesbare Fassung, satzweise, jedes Segment genau einmal",
    segments.length === 3 && JSON.stringify(spoken.map(s => s.text)) === JSON.stringify(segments), `${spoken.length} von ${segments.length} Segmenten`);
  check("Stimme: deutsche lokale Vorauswahl, Sprache de-DE, Tempo 1", spoken.every(s => s.voice === "Anna" && s.lang === "de-DE" && s.rate === 1));
  const messageTimes = await js<number[]>(`window.__messageTimes`);
  const answerAt = Math.max(...messageTimes.filter(t => t <= at("Spricht") + 5));
  console.log(`Zeiten${REAL ? " (Hören: whisper.cpp)" : " (Hören: Attrappe)"}:`);
  console.log(`  Sprechende bis 202 (Erkennen):      ${Math.round(at("Denkt …") - at("Verstehe …") + PAUSE_MS)} ms, davon ${PAUSE_MS} ms Pause bis zum Senden, ${Math.round(at("Denkt …") - at("Verstehe …"))} ms Upload und Erkennung (Anbieter allein: ${ctl.sttMs[0]} ms)`);
  console.log(`  202 bis Antwort (Chat-Attrappe):    ${Math.round(answerAt - at("Denkt …"))} ms, zählt nicht als Denkzeit eines Motors`);
  console.log(`  Antwort bis erstes Segment:         ${Math.round(spoken[0]!.at - answerAt)} ms (Stimme ist eine Attrappe)`);

  if (!REAL) {
    await shootAll("sprechmodus-hoert-zu");

    // --- Pausiert, Weiter, dann jeder Zustand angehalten ------------------------------------
    await click("talk-pause");
    check("Pause: Zustand „Pausiert“, Spuren gestoppt, AudioContext geschlossen", (await waitFor(inState("Pausiert"))) && (await tracksEnded()) && (await contextsClosed()));
    await shootAll("sprechmodus-pausiert");
    ctl.sttGate = deferred();
    await click("talk-resume");
    check("„Weiter“ holt das Mikrofon neu", (await waitFor(inState("Hört zu"))) && (await js<number>(`window.__streams.length`)) === 2);
    check("Verstehe: Mikrofon stumm, Punkt grau", (await waitFor(inState("Verstehe …"), 15000)) && !(await micEnabled()) &&
      (await js<boolean>(`document.getElementById("talk-dot").getAttribute("data-mic") === "closed" && document.getElementById("talk-level").hidden`)));
    await shootAll("sprechmodus-verstehe");
    ctl.chatGate = deferred();
    ctl.sttGate.resolve();
    ctl.sttGate = null;
    check("Denkt: jüngster Schritt der Statuszeile im Bereich", (await waitFor(`${inState("Denkt …")} && document.getElementById("talk-step").textContent !== ""`)),
      await js<string>(`document.getElementById("talk-step").textContent`));
    await shootAll("sprechmodus-denkt");
    await js(`document.getElementById("talk-panel").click()`);
    check("Tipp beim Denken fragt „Antwort abbrechen?“", (await noteText()) === "Antwort abbrechen?" && (await js<boolean>(`!document.getElementById("talk-confirm").hidden`)));
    await click("talk-no");
    check("„Nein“ lässt den Turn laufen", ctl.stops === 0 && (await js<boolean>(`document.getElementById("talk-confirm").hidden`)));
    await js(`window.__tts.hold = true`);
    ctl.chatGate.resolve();
    ctl.chatGate = null;
    check("Spricht: Mikrofon stumm (kein Selbstgespräch über Lautsprecher)", (await waitFor(`${inState("Spricht")} && window.__tts.speaking`)) && !(await micEnabled()) &&
      (await js<boolean>(`document.getElementById("talk-reply").textContent.length > 20`)));
    await shootAll("sprechmodus-spricht");
    const before = await js<number>(`window.__tts.spoken.length`);
    await js(`document.getElementById("talk-panel").click()`);
    check("Tipp auf den Bereich unterbricht: Ausgabe aus, wieder „Hört zu“, Mikrofon an",
      (await waitFor(inState("Hört zu"))) && (await js<number>(`window.__tts.cancels`)) >= 1 && !(await js<boolean>(`window.__tts.speaking`)) && (await micEnabled()));
    await Bun.sleep(600);
    check("nach dem Unterbrechen folgt kein weiteres Segment", (await js<number>(`window.__tts.spoken.length`)) === before);
    await js(`window.__tts.hold = false`);

    // --- Nichts verstanden ----------------------------------------------------------------
    ctl.stt = "empty";
    await js(`window.__holdNothing = true`);
    await speakAgain();
    check("422: Zustand „Nichts verstanden“", await waitFor(inState("Nichts verstanden"), 15000));
    await shootAll("sprechmodus-nichts-verstanden");
    await js(`window.__holdNothing = false; window.__releaseHeld()`);
    check("danach wieder „Hört zu“", await waitFor(inState("Hört zu")));
    ctl.stt = "ok";

    // --- Wartet (409 beschaeftigt) ---------------------------------------------------------
    ctl.busy = true;
    const heardBefore = ctl.heard.length;
    const uploadsBefore = uploads();
    await speakAgain();
    check("409 beschaeftigt: Zustand „Wartet“ mit Satz, Aufnahme verworfen",
      (await waitFor(inState("Wartet"), 15000)) && (await noteText()) === "In diesem Gespräch läuft schon eine Antwort. Nichts gesendet." && ctl.heard.length === heardBefore);
    await shootAll("sprechmodus-wartet");
    const pollsBefore = requests.filter(r => r.startsWith("GET ") && r.endsWith("/speech")).length;
    ctl.busy = false;
    check("die Abfrage beendet das Warten: „Wieder frei. Sprich noch einmal.“",
      (await waitFor(inState("Hört zu"), 6000)) && (await noteText()) === "Wieder frei. Sprich noch einmal." && requests.filter(r => r.startsWith("GET ") && r.endsWith("/speech")).length > 0,
      `${pollsBefore} Abfrage(n) während des Wartens`);
    check("dieselbe Aufnahme wird nie erneut gesendet", uploads() === uploadsBefore + 1 && ctl.heard.length === heardBefore);

    // --- Fehler (kein Anbieter) --------------------------------------------------------------
    ctl.stt = "unavailable";
    await speakAgain();
    check("503 kein-anbieter: Zustand „Fehler“ mit Satz, alles frei",
      (await waitFor(inState("Fehler"), 15000)) && (await noteText()) === "Kein Anbieter fürs Hören verfügbar" && (await tracksEnded()) && (await contextsClosed()));
    await shootAll("sprechmodus-fehler");
    await click("talk-close");
    check("„Schließen“ bringt die Eingabebox zurück", await js<boolean>(`document.getElementById("talk-panel").hidden && !document.getElementById("composer-box").hidden`));
    ctl.stt = "ok";

    // --- Server-Stimme samt Vorladen ------------------------------------------------------------
    ctl.ttsWhere = "server";
    await cdp("Page.reload", {});
    await Bun.sleep(200);
    await waitFor(`document.readyState === "complete" && document.getElementById("input")`);
    await openTalkConversation();
    await waitFor(`!document.getElementById("talk").hidden`);
    await click("talk");
    check("Server-Stimme: Audio-Element im Tipp freigeschaltet (kurze Stille aus einer blob:-Adresse)",
      (await waitFor(`window.__plays.length === 1`)) && (await js<boolean>(`window.__plays[0].src.startsWith("blob:")`)));
    let maxAhead = 0;
    const watch = setInterval(() => {
      void js<number>(`window.__plays.length`).then(plays => {
        // plays zählt die Stille mit: gespielt sind plays - 1 Segmente, geholt ctl.ttsCalls
        maxAhead = Math.max(maxAhead, ctl.ttsCalls.length - Math.max(0, plays - 1));
      }).catch(() => {});
    }, 25);
    const ok = (await waitFor(inState("Spricht"), 20000)) && (await waitFor(inState("Hört zu"), 20000));
    clearInterval(watch);
    const serverSegments = await lastSegments();
    check("Server-Stimme: Segmente in Reihenfolge über POST /api/speech/tts", ok && JSON.stringify(ctl.ttsCalls) === JSON.stringify(serverSegments), `${ctl.ttsCalls.length} Aufrufe`);
    check("Server-Stimme: höchstens ein Segment vorgeladen", maxAhead <= 1, `höchstens ${maxAhead} voraus`);
    const plays = await js<{ src: string; at: number }[]>(`window.__plays`);
    check("Server-Stimme: jedes Segment über das Audio-Element mit blob:-Adresse", plays.length === 1 + serverSegments.length && plays.every(p => p.src.startsWith("blob:")));
    check("Server-Stimme: alle Blob-URLs wieder freigegeben", await js<boolean>(`window.__urls.created.length === ${1 + serverSegments.length} && window.__urls.created.every(u => window.__urls.revoked.includes(u))`));
    check("Server-Stimme: die Browser-Stimme bleibt stumm", (await js<number>(`window.__tts.spoken.length`)) === 0);
    const ph = await js<{ text: string; at: number }[]>(`window.__phases`);
    const times = await js<number[]>(`window.__messageTimes`);
    const speakAt = ph.find(p => p.text === "Spricht")?.at ?? NaN;
    const answered = Math.max(...times.filter(t => t <= speakAt + 5));
    console.log(
      realTts
        ? `Zeit mit Pocket TTS (echt, erster Satz mit Kaltstart): Antwort bis erstes Segment ${Math.round(plays[1]!.at - answered)} ms; Synthese je Segment ${pocketMs.map(ms => `${ms} ms`).join(", ")} (${serverSegments.map(t => `${t.length} Zeichen`).join(", ")})`
        : `Zeit mit Server-Stimme (Attrappe, 60 ms je Segment): Antwort bis erstes Segment ${Math.round(plays[1]!.at - answered)} ms`
    );

    // --- Auflegen und Gesprächswechsel ------------------------------------------------------------
    await click("talk-hangup");
    check("Auflegen: Bereich weg, Eingabebox zurück, Spuren gestoppt, AudioContext geschlossen",
      (await js<boolean>(`document.getElementById("talk-panel").hidden && !document.getElementById("composer-box").hidden`)) && (await tracksEnded()) && (await contextsClosed()));
    await click("talk");
    await waitFor(inState("Hört zu"));
    await js(`document.querySelector('.conversation[data-id="${other.id}"]').click()`);
    check("Gesprächswechsel legt auf", (await waitFor(`document.getElementById("talk-panel").hidden`)) && (await tracksEnded()) && (await contextsClosed()));

    // --- Einstellungen pro Gerät -------------------------------------------------------------------
    ctl.ttsWhere = "browser";
    await js(`location.hash = "#/einstellungen/sprechen"`);
    const section = `document.querySelector('[aria-labelledby="settings-g-title-speech-device"]')`;
    check("Reiter „Sprechen“: Abschnitt „Sprechmodus auf diesem Gerät“", await waitFor(section));
    const patchesBefore = requests.filter(r => r.startsWith("PATCH ")).length;
    await js(`document.querySelector('[data-focus-key="speech-device-pause:long"]').click()`);
    await js(`document.querySelector('[data-focus-key="speech-device-headphones:on"]').click()`);
    await js(`(s => { s.value = "1.2"; s.dispatchEvent(new Event("change")); })(document.getElementById("speech-device-rate"))`);
    await Bun.sleep(200);
    const stored = await js<string>(`localStorage.getItem("tybo-speech-device")`);
    check("Änderungen nur in localStorage, kein PATCH /api/settings",
      stored === JSON.stringify({ pause: "long", voice: "", rate: 1.2, headphones: true }) && requests.filter(r => r.startsWith("PATCH ")).length === patchesBefore, stored);
    const voices = await js<string[]>(`[...document.getElementById("speech-device-voice").options].map(o => o.textContent)`);
    check("Stimmenliste: deutsche, lokale zuerst", JSON.stringify(voices) === JSON.stringify(["Vorauswahl: Anna (de-DE)", "Anna (de-DE)", "Deutsch (online) (de-DE, online)"]), voices.join(" | "));
    await js(`document.querySelector('[data-focus-key="speech-device:probe"]').click()`);
    check("„Probe“ spricht mit Tempo und Stimme dieses Geräts", await js<boolean>(`(s => s && s.text === "So klingt die Stimme für den Sprechmodus." && s.rate === 1.2 && s.voice === "Anna")(window.__tts.spoken.at(-1))`));
    await shootAll("sprechmodus-geraet", async () => {
      await js(`${section}.scrollIntoView({ block: "start" })`);
    });
    await js(`localStorage.removeItem("tybo-speech-device")`);
  } else {
    await click("talk-hangup");
    check("Auflegen: Spuren gestoppt, AudioContext geschlossen", (await tracksEnded()) && (await contextsClosed()));
  }

  // --- Eigene Stimme (Issue #253) -------------------------------------------------------
  {
    await js(`location.hash = "#/einstellungen/sprechen"`);
    const section = `document.querySelector('[aria-labelledby="settings-g-title-voice-clone"]')`;
    check("Reiter „Sprechen“: Abschnitt „Eigene Stimme“", await waitFor(`${section} && ${section}.querySelector("#voice-clone-consent")`));
    const streamsBefore = await js<number>(`window.__streams.length`);
    check("ohne Häkchen: kein Aufnahmeknopf, kein Datei-Feld, kein Mikrofon",
      await js<boolean>(`!${section}.querySelector('[data-focus-key="voice-clone:start"]') && !document.querySelector('.settings-panel input[type=file], #settings-view input[type=file]') && window.__streams.length === ${streamsBefore}`));
    await shootAll("eigene-stimme-einwilligung", async () => {
      await js(`${section}.scrollIntoView({ block: "start" })`);
    });
    await js(`document.getElementById("voice-clone-consent").click()`);
    check("mit Häkchen: Name, Vorlesetext, Aufnahmeknopf", await waitFor(`${section}.querySelector('[data-focus-key="voice-clone:start"]') && ${section}.querySelector(".voice-clone-reading").textContent.length > 100`));
    check("Häkchen allein öffnet das Mikrofon nicht", (await js<number>(`window.__streams.length`)) === streamsBefore);
    await js(`(i => { i.value = "Alex"; i.dispatchEvent(new Event("input")); })(document.getElementById("voice-clone-name"))`);
    await js(`${section}.querySelector('[data-focus-key="voice-clone:start"]').click()`);
    check("Aufnahme läuft: Punkt, Zeit, Stopp", await waitFor(`${section}.querySelector(".voice-clone-recorder .recorder-time") && ${section}.querySelector('[data-focus-key="voice-clone:stop"]:not([disabled])')`));
    check("genau ein Mikrofon geöffnet", (await js<number>(`window.__streams.length`)) === streamsBefore + 1);
    await Bun.sleep(1200);
    await shootAll("eigene-stimme-aufnahme", async () => {
      await js(`${section}.scrollIntoView({ block: "start" })`);
    });
    await Bun.sleep(5500);
    await js(`${section}.querySelector('[data-focus-key="voice-clone:stop"]').click()`);
    check("nach Stopp: Anhören, Mikrofon frei", (await waitFor(`${section}.querySelector("audio.voice-clone-audio")`)) && (await tracksEnded()));
    await js(`${section}.querySelector('[data-focus-key="voice-clone:save"]').click()`);
    check("gespeichert: Liste zeigt „Alex (KI-Stimme)“", await waitFor(`[...${section}.querySelectorAll(".voice-clone-name")].some(n => n.textContent === "Alex (KI-Stimme)")`, 15000));
    const created = cloneCreates.at(-1);
    check("Aufnahme als WAV (24 kHz, mono, PCM16) mit Einwilligung an den Server", !!created && created.consent && created.name === "Alex" && created.head.startsWith("52494646") && created.head.slice(48, 56) === "c05d0000" && created.bytes > 5 * 48_000, JSON.stringify(created));
    const voiceDirs = readdirSync(join(cloneCwd, "data", "speech", "voices")).filter(n => /^[a-f0-9]{16}$/.test(n));
    check("Ablage: Referenz, Text, Einwilligung", voiceDirs.length === 1 && ["consent.json", "meta.json", "reference.wav", "text.txt"].every(f => fileExists(join(cloneCwd, "data", "speech", "voices", voiceDirs[0]!, f))), voiceDirs.join(","));
    const id = voiceDirs[0]!;
    await js(`document.querySelector('[data-focus-key="voice-clone:probe:${id}"]').click()`);
    check("Probe: Abspieler an der Stimme, WAV gekennzeichnet", (await waitFor(`document.querySelector('li[data-voice-id="${id}"] audio')`, 15000)) && probeNotes.at(-1) === "KI-generiert (tybo), geklonte Stimme", probeNotes.join(" | "));
    check("Probe startet Pocket nur mit der geprüften Kennung", JSON.stringify(cloneSpawned.at(-1)?.slice(-4)) === JSON.stringify(["--clone-dir", join(cloneCwd, "data", "speech", "voices"), "--clone-id", id]));
    await shootAll("eigene-stimme-probe", async () => {
      await js(`${section}.scrollIntoView({ block: "start" })`);
    });
    await js(`document.querySelector('[data-focus-key="voice-clone:use:${id}"]').click()`);
    check("Verwenden: liest im Sprechmodus vor", (await waitFor(`document.querySelector('li[data-voice-id="${id}"] [data-voice-active]')`)) && cloneSettings.speech?.tts === "clone" && cloneSettings.speech?.cloneVoice === id, JSON.stringify(cloneSettings.speech));
    await shootAll("eigene-stimme-liste", async () => {
      await js(`${section}.scrollIntoView({ block: "start" })`);
    });
    await js(`document.querySelector('[data-focus-key="voice-clone:remove:${id}"]').click()`);
    await waitFor(`document.querySelector('[data-focus-key="voice-clone:remove-yes:${id}"]')`);
    await js(`document.querySelector('[data-focus-key="voice-clone:remove-yes:${id}"]').click()`);
    check("Löschen: Eintrag und Ordner weg, Auswahl zurück auf Browser-Stimme",
      (await waitFor(`!document.querySelector('li[data-voice-id="${id}"]')`)) && !fileExists(join(cloneCwd, "data", "speech", "voices", id)) && cloneSettings.speech?.tts === "browser" && cloneSettings.speech?.cloneVoice === undefined,
      JSON.stringify(cloneSettings.speech));
    await js(`location.hash = ""`);
  }

  // --- Abschluss ------------------------------------------------------------------------
  const csp = problems.filter(p => /Content Security Policy|Refused/i.test(p));
  check("keine CSP-Verstöße (Worklet und blob:-Audio erlaubt)", csp.length === 0, csp.join(" | "));
  // 409, 422 und 503 sind hier gewollte Antworten
  const errors = problems.filter(p => !/Failed to load resource|Content Security Policy|Refused/i.test(p));
  check("keine Skriptfehler", errors.length === 0, errors.join(" | "));
} catch (e) {
  failures++;
  console.log(`FEHL Abbruch: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  ws.close();
  chrome.kill();
  await chrome.exited;
  ctl.sttGate?.resolve();
  ctl.chatGate?.resolve();
  await server.stop({ graceMs: 200 });
  await rm(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} Prüfung(en) fehlgeschlagen` : "\nAlle Prüfungen bestanden");
process.exit(failures ? 1 : 0);
