#!/usr/bin/env bun
/**
 * Safari-Nachweis des Telefonhörers (Issue #258): WebSocket /api/call und
 * beide Worklets unter der unveränderten CSP des Web-Servers. Kein Teil von
 * `bun run check` (braucht macOS), wird von Hand gestartet:
 *
 *   bun run scripts/web-telefonhoerer-safari-check.ts                 # Safari über safaridriver, sonst WebKit
 *   bun run scripts/web-telefonhoerer-safari-check.ts --browser safari
 *   bun run scripts/web-telefonhoerer-safari-check.ts --browser webkit
 *
 * - safari: die Safari-App über WebDriver (/usr/bin/safaridriver). Geht nur,
 *   wenn in Safari unter Einstellungen, Entwickler „Entfernte Automation
 *   erlauben" an ist (oder einmal `safaridriver --enable`).
 * - webkit: dieselbe WebKit-Engine von Safari in einem WKWebView, über ein
 *   kleines Swift-Programm, das dieses Skript mit swiftc (Xcode Command Line
 *   Tools) in ein Temp-Verzeichnis übersetzt. Keine Einstellung am Browser.
 *
 * Eigener Web-Server auf freiem Port mit den echten Sicherheitsköpfen (CSP,
 * dieselbe createWebServer wie im Betrieb), Gesprächsspeicher in einem
 * Temp-Verzeichnis, keine .env, src/bot.ts wird weder gestartet noch
 * importiert. Nur der Anschluss (CallPort) ist eine Attrappe. Die Seite
 * meldet sich an, lädt die echte Startseite (mit call.js) und führt dort
 * PROBE aus: echter WebSocket mit start und ready, beide Worklets per
 * addModule aus eigenen Dateien, beide AudioWorkletNodes, Ton durch den
 * Spieler bis played, Meldungen der Pausenerkennung. Jeder
 * securitypolicyviolation-Bericht zählt als Fehler. Mikrofon braucht es
 * dafür nicht (Safari über WebDriver erlaubt keins).
 *
 * Audio-Sitzung (Issue #280): Vorher läuft der echte Telefonhörer
 * (createCallMode aus call.js) von Start bis Auflegen mit einem künstlichen
 * Mikrofon (leiser Oszillator über MediaStreamDestination statt
 * getUserMedia), je einmal mit einer Attrappe von navigator.audioSession,
 * ohne die API und, wenn der Browser sie hat, mit der echten. Geprüft wird:
 * play-and-record vor AudioContext und Mikrofon, Rückkehr zum vorigen Wert
 * beim Auflegen, Ton über MediaStream und <audio> nur mit Sitzung, Spieler
 * am zweiten Eingang des Aufnahme-Worklets, Ton bis played. Safari über
 * WebDriver startet jedes Gespräch in einem echten Klick.
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import type { RunTurnOptions, WebChat } from "../src/web/chat";
import type { CallLine, CallModeStatus, CallPort, CallTtsMode, CallTurnEvent } from "../src/web/call-protocol";
import { createDemoAgents, createDemoCommands, createDemoEngines, createDemoInstructions, createDemoKeys, createDemoModels, createDemoStatus } from "../src/web/demo";
import { createWebServer } from "../src/web/server";
import { ConversationStore } from "../src/web/store";
import { UploadStore } from "../src/web/uploads";
import type { VoicePort } from "../src/web/voice";

const { values } = parseArgs({ options: { browser: { type: "string", default: "auto" } } });
const WANT = values.browser === "safari" || values.browser === "webkit" ? values.browser : "auto";
const PASSWORD = "safari-check-passwort";

function abort(text: string): never {
  console.error(text);
  process.exit(1);
}
if (process.platform !== "darwin") abort("Safari und WebKit gibt es nur auf macOS.");

// --- Anschluss: Attrappe -----------------------------------------------------------------

const FAKE_STATUS: CallModeStatus = {
  ready: true,
  model: "attrappe",
  via: "api",
  expectation: "erster Satz nach rund 1,5 Sekunden",
  stt: { id: "parakeet", local: true, warm: true },
  tts: { id: "pocket", where: "server", stream: true },
};
const opened: CallTtsMode[] = [];
function fakeLine(tts: CallTtsMode): CallLine {
  return {
    info: { model: "attrappe", via: "api", stt: "parakeet", tts, sampleRate: 24000, sttWarm: true },
    async recognize() {
      return { ok: true, text: "Hallo?" };
    },
    async *turn(): AsyncGenerator<CallTurnEvent> {
      yield { type: "done", rawText: "", spokenText: "", aborted: false };
    },
    async interrupt() {},
    onTurn() {},
    close() {},
  };
}
const port: CallPort = {
  status: async () => FAKE_STATUS,
  restartPending: () => false,
  turnBegin: () => () => {},
  onRestart: () => () => {},
  async open({ tts }) {
    opened.push(tts);
    return fakeLine(tts);
  },
};

// --- Web-Server --------------------------------------------------------------------------

const dir = await mkdtemp(join(tmpdir(), "tybo-telefonhoerer-safari-"));
const store = new ConversationStore({ dir: join(dir, "web") });
await store.load();
const talk = await store.createConversation("general");
const chat: WebChat = {
  async runTurn({ agent }: RunTurnOptions) {
    return { text: "Attrappe.", info: { agent, model: "attrappe", durationMs: 1 } };
  },
  stop() {},
};
const voice: VoicePort = {
  localMode: () => ({ ready: true, stt: { id: "parakeet", label: "Attrappe", local: true, available: true }, tts: { id: "pocket", label: "Attrappe", where: "server", available: true } }),
};
const demo = createDemoAgents({ seed: false });
const serverLog: string[] = [];
const server = await createWebServer(
  { host: "127.0.0.1", port: 0, password: PASSWORD, allowedHosts: [] },
  {
    sessionFile: join(dir, "sessions.json"),
    dataDir: join(dir, "web"),
    conversationStore: store,
    chat,
    uploads: new UploadStore({ dir: join(dir, "uploads") }),
    cliTokenFile: join(dir, "cli-token"),
    voice,
    call: port,
    settings: demo.settings,
    engines: createDemoEngines(demo.settings),
    agentCatalog: demo.catalog,
    instructions: createDemoInstructions(),
    models: createDemoModels(),
    status: createDemoStatus(),
    commands: createDemoCommands(),
    keys: createDemoKeys(),
    log: line => serverLog.push(line),
  }
);
const front = server.url.replace(/\/$/, "");
// Gegenprobe: ein fremder Ursprung (anderer Port) mit WebSocket; die CSP muss ihn sperren, er zählt jeden Versuch
let foreignAttempts = 0;
const foreign = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch(req, srv) {
    foreignAttempts++;
    return srv.upgrade(req) ? undefined : new Response("nein", { status: 400 });
  },
  websocket: { message() {} },
});
const csp = (await fetch(`${front}/login`)).headers.get("content-security-policy") ?? "";

// --- Telefonhörer mit künstlichem Mikrofon (Issue #280) ------------------------------------

/**
 * Legt window.__callProbe an: variants() (welche Läufe), start(variant) (im
 * Klick), finish() (bis „Hört zu“, Ton durch den Spieler, Auflegen; legt das
 * Ergebnis in window.__callResults). Läuft auf der echten Startseite.
 */
const CALL_SETUP = `
window.__callResults = window.__callResults || [];
window.__callProbe = (() => {
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(20); } return !!fn(); };
  const native = "audioSession" in navigator && !!navigator.audioSession;
  const nativeType = native ? navigator.audioSession.type : null;
  const sessionType = () => (navigator.audioSession ? navigator.audioSession.type : null);
  let current = null;
  function install(variant) {
    if (variant === "attrappe") {
      const fake = { sets: [], current: "auto", get type() { return this.current; }, set type(v) { this.sets.push(v); this.current = v; } };
      Object.defineProperty(navigator, "audioSession", { value: fake, configurable: true });
    } else if (variant === "ohne") {
      Object.defineProperty(navigator, "audioSession", { value: undefined, configurable: true });
    }
  }
  function uninstall() {
    if (Object.getOwnPropertyDescriptor(navigator, "audioSession")) delete navigator.audioSession;
  }
  function start(variant) {
    install(variant);
    const run = { variant, before: sessionType(), atContext: null, atMic: null, steps: [], audios: [], context: null };
    current = run;
    // Künstliches Mikrofon: leiser Ton, die Pausenerkennung hört darin keine Sprache
    const micContext = new AudioContext();
    const osc = micContext.createOscillator();
    const gain = micContext.createGain();
    gain.gain.value = 0.0005;
    const dest = micContext.createMediaStreamDestination();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    run.mic = { context: micContext, osc };
    if (!navigator.mediaDevices) Object.defineProperty(navigator, "mediaDevices", { value: {}, configurable: true });
    const devices = navigator.mediaDevices;
    const gum = devices.getUserMedia;
    devices.getUserMedia = async () => { run.atMic = sessionType(); return dest.stream; };
    const Context = window.AudioContext;
    window.AudioContext = class extends Context { constructor(...a) { run.atContext = sessionType(); super(...a); run.context = this; } };
    const Audio = window.Audio;
    window.Audio = function (...a) { const el = new Audio(...a); run.audios.push(el); return el; };
    try {
      run.mode = createCallMode({ win: window, storage: null, microphoneProblem: e => "Mikrofon: " + (e && e.name), stopTracks: st => st.getTracks().forEach(t => t.stop()) });
      run.mode.start("__CONVERSATION__", __STATUS__, "General");
    } catch (e) {
      run.steps.push("start: " + e);
    } finally {
      // AudioContext, <audio> und getUserMedia ruft start() synchron auf
      window.AudioContext = Context;
      window.Audio = Audio;
      devices.getUserMedia = gum;
    }
  }
  async function finish() {
    const run = current;
    const out = { variant: run.variant, native, nativeType, before: run.before, steps: run.steps };
    try {
      out.listening = await until(() => run.mode.view().phase === "listening", 10000);
      out.phase = run.mode.view().phase;
      out.note = run.mode.view().note;
      out.atContext = run.atContext;
      out.atMic = run.atMic;
      out.during = sessionType();
      const el = run.audios[0];
      out.route = el ? { mediaStream: typeof MediaStream === "function" && el.srcObject instanceof MediaStream, paused: el.paused, count: run.audios.length } : null;
      const vad = run.mode.state.vadNode;
      const player = run.mode.state.playerNode;
      out.vadInputs = vad ? vad.numberOfInputs : null;
      const seen = [];
      if (player) {
        player.port.addEventListener("message", e => seen.push(e.data && e.data.type));
        // Eigene Laufnummer: call.js verwirft diese Meldungen, nichts geht als played an den Server
        player.port.postMessage({ type: "flush", epoch: 999 });
        player.port.postMessage({ type: "begin", id: 1 });
        const pcm = new Int16Array(24000 * 0.3);
        for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / 24000) * 3000);
        player.port.postMessage({ type: "audio", buffer: pcm.buffer, rate: 24000 }, [pcm.buffer]);
        player.port.postMessage({ type: "end", id: 1 });
        await until(() => seen.includes("played"), 5000);
      }
      out.player = seen;
      run.mode.hangUp();
      await until(() => !run.context || run.context.state === "closed", 3000);
      out.after = sessionType();
      out.sets = navigator.audioSession && Array.isArray(navigator.audioSession.sets) ? navigator.audioSession.sets.slice() : null;
      out.routeAfter = el ? { srcObject: el.srcObject === null, paused: el.paused } : null;
      out.contextClosed = run.context ? run.context.state === "closed" : null;
    } catch (e) {
      out.steps.push("Abbruch: " + (e && e.message ? e.message : String(e)));
    } finally {
      try { run.mic.osc.stop(); void run.mic.context.close(); } catch {}
      uninstall();
    }
    window.__callResults.push(out);
    // Der Server braucht einen Moment für das Auflegen, bevor das nächste Gespräch beginnt
    await wait(600);
    return JSON.stringify(out);
  }
  return { variants: () => ["attrappe", "ohne"].concat(native ? ["echt"] : []), start, finish };
})();
`.replace("__CONVERSATION__", talk.id).replace("__STATUS__", JSON.stringify(FAKE_STATUS));

// --- Probe in der Seite ------------------------------------------------------------------

/** Rumpf einer async-Funktion; liefert JSON. Läuft auf der echten Startseite. */
const PROBE = `
const out = window.__probe = { href: location.href, secure: window.isSecureContext, ua: navigator.userAgent, violations: [], steps: [] };
document.addEventListener("securitypolicyviolation", e => out.violations.push(e.violatedDirective + " " + e.blockedURI));
const wait = ms => new Promise(r => setTimeout(r, ms));
const within = (promise, ms, what) => Promise.race([promise, wait(ms).then(() => { throw new Error(what + ": keine Antwort nach " + ms + " ms"); })]);
const until = async (fn, ms) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await wait(20); } return !!fn(); };
// Telefonhörer mit künstlichem Mikrofon (Issue #280): in Safari schon vorher in echten Klicks gelaufen, im WKWebView hier
if (!window.__callProbe) {
  try {
    __CALL_SETUP__
    for (const variant of window.__callProbe.variants()) {
      window.__callProbe.start(variant);
      await window.__callProbe.finish();
    }
  } catch (e) {
    out.steps.push("Telefonhörer: " + (e && e.message ? e.message : String(e)));
  }
}
out.calls = window.__callResults || [];
try {
  out.callJs = typeof createCallMode === "function";
  // WebSocket: dieselbe Adresse wie call.js (CSP connect-src 'self')
  const url = (location.protocol === "https:" ? "wss://" : "ws://") + location.host + "/api/call";
  out.socketUrl = url;
  const got = [];
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  out.ready = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 10000);
    ws.onopen = () => ws.send(JSON.stringify({ type: "start", conversationId: "__CONVERSATION__", tts: "server" }));
    ws.onmessage = e => {
      if (typeof e.data !== "string") return;
      const m = JSON.parse(e.data);
      got.push(m.type + (m.state ? ":" + m.state : ""));
      if (m.type === "ready") { clearTimeout(timer); resolve(true); }
    };
    ws.onclose = e => { got.push("close:" + e.code); clearTimeout(timer); resolve(false); };
  });
  await wait(200);
  ws.onclose = e => got.push("close:" + e.code);
  ws.send(JSON.stringify({ type: "hangup" }));
  await until(() => ws.readyState === 3, 3000);
  out.socket = got;

  // Beide Worklets aus eigenen Dateien (CSP script-src und worker-src 'self')
  // Safari-App: im echten WebDriver-Klick angelegt (window.__probeContext), ohne Nutzeraktion bliebe er angehalten
  const context = window.__probeContext || new AudioContext();
  out.steps.push("AudioContext " + context.state + (window.__probeContext ? " (aus dem Klick)" : ""));
  try { await within(context.resume(), 3000, "resume"); } catch (e) { out.steps.push(String(e.message || e)); }
  out.steps.push("nach resume " + context.state);
  out.modules = [];
  for (const path of ["/speech-worklet.js", "/call-player-worklet.js"]) {
    try { await within(context.audioWorklet.addModule(path), 10000, "addModule"); out.modules.push(path); } catch (e) { out.steps.push("addModule " + path + ": " + e); }
  }
  const vad = new AudioWorkletNode(context, "speech-vad", { numberOfInputs: 1, numberOfOutputs: 1, processorOptions: { mode: "call" } });
  const vadSeen = [];
  vad.port.onmessage = e => vadSeen.push(e.data && e.data.type);
  const tone = context.createOscillator();
  tone.frequency.value = 220;
  const mute = context.createGain();
  mute.gain.value = 0;
  tone.connect(vad);
  vad.connect(mute);
  mute.connect(context.destination);
  tone.start();
  vad.port.postMessage({ type: "config", epoch: 1, active: true, strict: false, keep: false, reset: true, pauseMs: 800, startMs: 150 });
  const player = new AudioWorkletNode(context, "call-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
  const playerSeen = [];
  player.port.onmessage = e => playerSeen.push(e.data && e.data.type);
  const quiet = context.createGain();
  quiet.gain.value = 0.05;
  player.connect(quiet);
  quiet.connect(context.destination);
  player.port.postMessage({ type: "flush", epoch: 1 });
  player.port.postMessage({ type: "begin", id: 1 });
  const pcm = new Int16Array(24000 * 0.3);
  for (let i = 0; i < pcm.length; i++) pcm[i] = Math.round(Math.sin(2 * Math.PI * 440 * i / 24000) * 8000);
  player.port.postMessage({ type: "audio", buffer: pcm.buffer, rate: 24000 }, [pcm.buffer]);
  player.port.postMessage({ type: "end", id: 1 });
  await until(() => playerSeen.includes("played") && vadSeen.includes("level"), 5000);
  out.contextState = context.state;
  out.sampleRate = context.sampleRate;
  out.player = playerSeen;
  out.vad = [...new Set(vadSeen)];
  tone.stop();
  // Gegenprobe: die CSP greift wirklich (Worklet aus blob:, WebSocket zu fremdem Host), Verstöße werden gemeldet
  out.ownViolations = out.violations.slice();
  const control = [];
  try { await within(context.audioWorklet.addModule(URL.createObjectURL(new Blob(["//"], { type: "text/javascript" }))), 3000, "blob"); control.push("blob-Worklet geladen"); } catch { control.push("blob-Worklet abgewiesen"); }
  try {
    const foreign = new WebSocket("ws://127.0.0.1:__FOREIGN_PORT__/api/call");
    foreign.onopen = () => control.push("fremder WebSocket offen");
    foreign.onerror = () => control.push("fremder WebSocket: Fehler");
  } catch (e) {
    control.push("fremder WebSocket abgewiesen (" + (e && e.name) + ")");
  }
  await wait(1500);
  out.control = control;
  out.controlViolations = out.violations.slice(out.ownViolations.length);
  await context.close();
} catch (e) {
  out.steps.push("Abbruch: " + (e && e.message ? e.message : String(e)));
}
await wait(100);
return JSON.stringify(out);
`.replace("__CONVERSATION__", talk.id).replace("__FOREIGN_PORT__", String(foreign.port)).replace("__CALL_SETUP__", () => CALL_SETUP);

// --- Safari über WebDriver ---------------------------------------------------------------

async function viaSafari(): Promise<{ result: any } | { unavailable: string }> {
  const driverPort = 4440 + Math.floor(Math.random() * 50);
  const driver = Bun.spawn(["/usr/bin/safaridriver", "-p", String(driverPort)], { stdout: "ignore", stderr: "ignore" });
  const base = `http://127.0.0.1:${driverPort}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(90_000) });
    return (await r.json()) as any;
  };
  let session = "";
  try {
    let created: any = null;
    for (let i = 0; i < 40 && !created; i++) {
      try {
        created = await call("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } });
      } catch {
        await Bun.sleep(150);
      }
    }
    session = created?.value?.sessionId ?? "";
    if (!session) return { unavailable: created?.value?.message ?? "safaridriver antwortet nicht" };
    await call("POST", `/session/${session}/url`, { url: `${front}/login` });
    await call("POST", `/session/${session}/execute/sync`, { script: `document.getElementById("password").value = arguments[0]; document.getElementById("login-form").requestSubmit();`, args: [PASSWORD] });
    for (let i = 0; i < 100; i++) {
      const path = (await call("POST", `/session/${session}/execute/sync`, { script: `return location.pathname + "|" + document.readyState`, args: [] })).value;
      if (path === "/|complete") break;
      await Bun.sleep(100);
    }
    // Safari startet einen AudioContext nur in einer Nutzeraktion; execute/sync zählt nicht, ein WebDriver-Klick schon.
    // Der Knopf hängt nur in dieser Prüfseite, der Handler ist eine Eigenschaft (kein Inline-Attribut, CSP bleibt unberührt)
    await call("POST", `/session/${session}/execute/sync`, {
      script: `const b = document.createElement("button"); b.id = "probe-audio"; b.textContent = "Ton"; b.style.position = "fixed"; b.style.top = "0"; b.style.left = "0"; b.style.zIndex = "99999"; b.onclick = () => { if (window.__callVariant) { const v = window.__callVariant; window.__callVariant = null; window.__callProbe.start(v); return; } window.__probeContext = new AudioContext(); void window.__probeContext.resume(); }; document.body.appendChild(b);`,
      args: [],
    });
    const button = (await call("POST", `/session/${session}/element`, { using: "css selector", value: "#probe-audio" })).value;
    const elementId = button?.["element-6066-11e4-a52e-4f735466cecf"];
    // Telefonhörer (Issue #280): jedes Gespräch beginnt in einem echten Klick, wie der Tipp auf den Hörer
    await call("POST", `/session/${session}/timeouts`, { script: 60_000 });
    const variants = (await call("POST", `/session/${session}/execute/sync`, { script: `${CALL_SETUP}; return window.__callProbe.variants();`, args: [] })).value as string[];
    for (const variant of Array.isArray(variants) ? variants : []) {
      await call("POST", `/session/${session}/execute/sync`, { script: `window.__callVariant = arguments[0];`, args: [variant] });
      if (elementId) await call("POST", `/session/${session}/element/${elementId}/click`, {});
      await call("POST", `/session/${session}/execute/async`, { script: `const done = arguments[arguments.length - 1]; window.__callProbe.finish().then(done, e => done(String(e)));`, args: [] });
    }
    if (elementId) await call("POST", `/session/${session}/element/${elementId}/click`, {});
    await call("POST", `/session/${session}/timeouts`, { script: 60_000 });
    const script = `const done = arguments[arguments.length - 1]; (async () => { ${PROBE} })().then(done, e => done(JSON.stringify({ steps: ["Ausnahme: " + e] })));`;
    const r = await call("POST", `/session/${session}/execute/async`, { script, args: [] });
    return { result: JSON.parse(r.value) };
  } finally {
    if (session) await call("DELETE", `/session/${session}`).catch(() => {});
    driver.kill();
    await driver.exited;
  }
}

// --- WebKit (WKWebView) über ein kleines Swift-Programm ----------------------------------

const SWIFT = `
import Cocoa
import WebKit

let args = CommandLine.arguments
let start = URL(string: args[1])!
let password = args[2]
let probe = try! String(contentsOfFile: args[3], encoding: .utf8)

func finish(_ text: String, _ code: Int32) -> Never {
  FileHandle.standardOutput.write((text + "\\n").data(using: .utf8)!)
  exit(code)
}

final class Driver: NSObject, WKNavigationDelegate {
  var stage = 0
  func webView(_ web: WKWebView, didFinish navigation: WKNavigation!) {
    let path = web.url?.path ?? ""
    if stage == 0 && path == "/login" {
      stage = 1
      let quoted = String(data: try! JSONSerialization.data(withJSONObject: [password]), encoding: .utf8)!
      web.evaluateJavaScript("document.getElementById('password').value = \\(quoted)[0]; document.getElementById('login-form').requestSubmit(); true") { _, error in
        if let error { finish("{\\"steps\\":[\\"Anmeldung: \\(error.localizedDescription)\\"]}", 1) }
      }
    } else if stage == 1 && path == "/" {
      stage = 2
      web.callAsyncJavaScript(probe, arguments: [:], in: nil, in: .page) { result in
        switch result {
        case .success(let value): finish(value as? String ?? "{}", 0)
        case .failure(let error): finish("{\\"steps\\":[\\"Probe: \\(error.localizedDescription)\\"]}", 1)
        }
      }
    }
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let config = WKWebViewConfiguration()
config.mediaTypesRequiringUserActionForPlayback = []
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 1280, height: 900), configuration: config)
let driver = Driver()
web.navigationDelegate = driver
// Ohne sichtbares Fenster gilt die Seite als im Hintergrund, WebKit hält dann den AudioContext an („interrupted")
let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 900), styleMask: [.borderless], backing: .buffered, defer: false)
window.alphaValue = 0.01
window.ignoresMouseEvents = true
window.contentView = web
window.orderFrontRegardless()
web.load(URLRequest(url: start))
Timer.scheduledTimer(withTimeInterval: 90, repeats: false) { _ in
  web.evaluateJavaScript("JSON.stringify(Object.assign({}, window.__probe || {}, { steps: ((window.__probe || {}).steps || []).concat(['Zeit abgelaufen']) }))") { value, _ in
    finish(value as? String ?? "{\\"steps\\":[\\"Zeit abgelaufen\\"]}", 1)
  }
}
app.run()
`;

async function viaWebKit(): Promise<{ result: any; version: string }> {
  const swiftc = Bun.which("swiftc");
  if (!swiftc) abort("webkit braucht swiftc (xcode-select --install).");
  const source = join(dir, "probe.swift");
  const binary = join(dir, "probe");
  const probeFile = join(dir, "probe.js");
  await Bun.write(source, SWIFT);
  await Bun.write(probeFile, PROBE);
  const built = Bun.spawnSync([swiftc, "-O", "-o", binary, source], { stdout: "pipe", stderr: "pipe" });
  if (built.exitCode !== 0) abort(`swiftc: ${built.stderr.toString().slice(0, 2000)}`);
  const run = Bun.spawn([binary, `${front}/login`, PASSWORD, probeFile], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(run.stdout).text();
  await run.exited;
  const plist = "/System/Library/Frameworks/WebKit.framework/Resources/Info.plist";
  const version = existsSync(plist) ? Bun.spawnSync(["/usr/bin/defaults", "read", plist, "CFBundleVersion"]).stdout.toString().trim() : "?";
  return { result: JSON.parse(text.trim().split("\n").at(-1) || "{}"), version };
}

// --- Ablauf ------------------------------------------------------------------------------

let failures = 0;
function check(name: string, pass: boolean, detail = "") {
  if (!pass) failures++;
  console.log(`${pass ? "OK  " : "FEHL"} ${name}${detail ? `  (${detail})` : ""}`);
}

try {
  console.log(`CSP der Seite (unverändert aus src/web/server): ${csp}`);
  let engine = "";
  let result: any = null;
  if (WANT !== "webkit") {
    const safari = await viaSafari();
    if ("result" in safari) {
      engine = "Safari-App über safaridriver";
      result = safari.result;
    } else if (WANT === "safari") {
      check("Safari über safaridriver", false, safari.unavailable);
    } else {
      console.log(`Safari über safaridriver nicht möglich: ${safari.unavailable}`);
      console.log("Weiter mit der WebKit-Engine von Safari (WKWebView).");
    }
  }
  if (!result && WANT !== "safari") {
    const webkit = await viaWebKit();
    engine = `WebKit ${webkit.version} (WKWebView, Engine von Safari ${Bun.spawnSync(["/usr/bin/defaults", "read", "/Applications/Safari.app/Contents/Info.plist", "CFBundleShortVersionString"]).stdout.toString().trim()})`;
    result = webkit.result;
  }
  if (result) {
    console.log(`Browser: ${engine}`);
    console.log(`User-Agent: ${result.ua}`);
    for (const step of result.steps ?? []) console.log(`  ${step}`);
    check("Startseite geladen, sicherer Kontext, call.js da", result.secure === true && result.callJs === true && String(result.href).startsWith(front), `${result.href}, isSecureContext ${result.secure}`);
    check("WebSocket /api/call unter connect-src 'self': start, ready, hangup", result.ready === true && opened.length === 1 + (Array.isArray(result.calls) ? result.calls.length : 0) && (result.socket ?? []).includes("ready") && (result.socket ?? []).some((t: string) => t.startsWith("close:1000")), `${result.socketUrl}: ${(result.socket ?? []).join(" → ")}`);
    check("beide Worklets aus eigenen Dateien geladen (script-src, worker-src 'self')", (result.modules ?? []).join() === "/speech-worklet.js,/call-player-worklet.js", (result.modules ?? []).join(", "));
    check("Pausenerkennung im Worklet rechnet (Betriebsart Gespräch)", (result.vad ?? []).includes("level"), `${(result.vad ?? []).join(", ")}; AudioContext ${result.contextState}, ${result.sampleRate} Hz`);
    check("Spieler-Worklet spielt Ton: begin und played", (result.player ?? []).includes("begin") && (result.player ?? []).includes("played"), (result.player ?? []).join(", "));
    const calls: any[] = Array.isArray(result.calls) ? result.calls : [];
    const byVariant = (v: string) => calls.find(c => c.variant === v);
    const native = calls[0]?.native === true;
    console.log(`  navigator.audioSession im Browser: ${native ? `ja (type ${calls[0].nativeType})` : "nein"}`);
    for (const c of calls) console.log(`  Telefonhörer ${c.variant}: ${JSON.stringify({ ...c, native: undefined, nativeType: undefined })}`);
    const fake = byVariant("attrappe");
    check("Telefonhörer mit Audio-Sitzung (Attrappe): play-and-record vor AudioContext und Mikrofon, „Hört zu“",
      !!fake && fake.listening === true && fake.before === "auto" && fake.atContext === "play-and-record" && fake.atMic === "play-and-record" && fake.during === "play-and-record",
      fake ? `vorher ${fake.before}, AudioContext ${fake.atContext}, Mikrofon ${fake.atMic}, im Gespräch ${fake.during}, ${fake.phase}` : "kein Lauf");
    check("Telefonhörer mit Audio-Sitzung: Ton über MediaStream und <audio>, Spieler am zweiten Eingang, Ton bis played",
      !!fake && fake.route?.mediaStream === true && fake.route?.paused === false && fake.vadInputs === 2 && (fake.player ?? []).includes("played"),
      fake ? `route ${JSON.stringify(fake.route)}, Eingänge ${fake.vadInputs}, Spieler ${(fake.player ?? []).join(", ")}` : "kein Lauf");
    check("Auflegen setzt die Sitzung zurück und gibt <audio> und AudioContext frei",
      !!fake && fake.after === "auto" && JSON.stringify(fake.sets) === JSON.stringify(["play-and-record", "auto"]) && fake.routeAfter?.srcObject === true && fake.routeAfter?.paused === true && fake.contextClosed === true,
      fake ? `nachher ${fake.after}, gesetzt ${JSON.stringify(fake.sets)}, <audio> ${JSON.stringify(fake.routeAfter)}, AudioContext zu ${fake.contextClosed}` : "kein Lauf");
    const none = byVariant("ohne");
    check("Ohne API: kein Fehler, „Hört zu“, kein <audio>, Spieler direkt (Ton bis played)",
      !!none && none.listening === true && none.route === null && none.vadInputs === 2 && (none.player ?? []).includes("played") && none.contextClosed === true && none.steps.length === 0,
      none ? `${none.phase}, route ${JSON.stringify(none.route)}, Spieler ${(none.player ?? []).join(", ")}${none.steps.length ? ", " + none.steps.join("; ") : ""}` : "kein Lauf");
    if (native) {
      const real = byVariant("echt");
      check("Echte API des Browsers: play-and-record im Gespräch, danach der vorige Wert",
        !!real && real.listening === true && real.during === "play-and-record" && real.after === real.nativeType && real.route?.mediaStream === true,
        real ? `vorher ${real.before}, im Gespräch ${real.during}, nachher ${real.after}, route ${JSON.stringify(real.route)}` : "kein Lauf");
    }
    check("keine CSP-Verstöße", Array.isArray(result.ownViolations) && result.ownViolations.length === 0, (result.ownViolations ?? []).join(" | "));
    const control = result.controlViolations ?? [];
    check("Gegenprobe: die CSP greift (Worklet aus blob: abgewiesen und gemeldet, WebSocket zu fremdem Port kommt nie an)",
      (result.control ?? []).includes("blob-Worklet abgewiesen") && control.some((v: string) => v.startsWith("script-src")) && control.some((v: string) => v.startsWith("connect-src")) && !(result.control ?? []).includes("fremder WebSocket offen") && foreignAttempts === 0,
      `${(result.control ?? []).join(", ")}; Versuche am fremden Port: ${foreignAttempts}; gemeldet: ${control.join(" | ")}`);
  }
} catch (e) {
  failures++;
  console.log(`FEHL Abbruch: ${e instanceof Error ? e.message : String(e)}`);
} finally {
  foreign.stop(true);
  await server.stop({ graceMs: 200 });
  await rm(dir, { recursive: true, force: true });
}

const callLog = serverLog.filter(l => l.startsWith("Telefonhörer"));
if (callLog.length) console.log(`\nServer-Log (Telefonhörer):\n  ${callLog.join("\n  ")}`);
console.log(failures ? `\n${failures} Prüfung(en) fehlgeschlagen` : "\nAlle Prüfungen bestanden");
process.exit(failures ? 1 : 0);
