// Telefonhörer in der WebUI (Issue #258, Entscheidung 0024): ein flüssiges
// Gespräch mit tybo über den WebSocket GET /api/call (#257). Klassisches
// Skript ohne Build, nach speech.js und vor settings.js und app.js geladen;
// beide prüfen mit typeof, ob es da ist. Protokoll:
// docs/webui/telefonhoerer-protokoll.md.
//
// - Aufnahme: speech-worklet.js in der Betriebsart „Gespräch" liefert 20-ms-
//   Stücke, solange der Nutzer spricht; sie gehen binär hinaus, dazu
//   utterance_pause und utterance_end. Außerhalb von Sprache geht kein Ton
//   hinaus, vor ready gar keiner.
// - Wiedergabe: call-player-worklet.js spielt den Ton des Servers und meldet
//   Beginn (Satzanzeige) und Ende (played) jedes Abschnitts. Mit der
//   Browser-Stimme spricht speechSynthesis die Sätze nacheinander.
// - Echo (Issue #280): Mit navigator.audioSession (Safari) setzt der Tipp
//   "play-and-record" und der Ton läuft über einen MediaStream in ein
//   <audio>-Element: nur diese Wiedergabe gibt WebKit der Echo-Unterdrückung
//   des Mikrofons als Referenz. Dann hängt der Spieler auch am zweiten
//   Eingang des Aufnahme-Worklets, das seinen Ton im Mikrofon wiedererkennt.
//   Das Element puffert zusätzlich: played geht erst nach diesem Puffer
//   hinaus, Unterbrechen schaltet das Element so lange stumm, und fällt ein
//   angefangener Satz auf die Browser-Stimme zurück, wartet sie, bis sein
//   ausgegebener Anfang verklungen ist. Ohne die API
//   bleibt alles wie vor #280.
// - Das Mikrofon bleibt offen, während tybo spricht: Antippen unterbricht
//   immer, per Stimme nur mit Ton aus dem Server und strengerer Schwelle.
// - Jede Sitzung, jeder Mikrofon-Aufbau, jede Verbindung und jede Wiedergabe
//   trägt eine Laufnummer. Was mit einer alten Nummer eintrifft, startet
//   nichts mehr.
// - Einstellungen pro Gerät liegen nur in localStorage (CALL_DEVICE_KEY),
//   getrennt von denen des Sprechmodus.
// - Nutzertext kommt nur über textContent in die Seite.
"use strict";

const CALL_SOCKET_PATH = "/api/call";
const CALL_VAD_WORKLET_PATH = "/speech-worklet.js";
const CALL_VAD_WORKLET_NAME = "speech-vad";
const CALL_PLAYER_WORKLET_PATH = "/call-player-worklet.js";
const CALL_PLAYER_WORKLET_NAME = "call-player";
/** Sprechbeginn: normal wie im Sprechmodus, beim Unterbrechen per Stimme 300 ms durchgehend */
const CALL_START_MS = 150;
const CALL_STRICT_START_MS = 300;
/** Pausen pro Gerät wie im Sprechmodus (Reiter „Sprechen") */
const CALL_PAUSES = { short: 500, normal: 800, long: 1300 };
/** Nach einem Abbruch der Verbindung: so bald der eine neue Versuch, so lange darf er bis ready brauchen */
const CALL_RETRY_DELAY_MS = 1000;
const CALL_RETRY_READY_MS = 15000;
/** Schließcodes, bei denen ein Netzabbruch vorliegt (kein ended vom Server) */
const CALL_RETRY_CODES = [1005, 1006, 1011, 1012, 1013, 1014];
/** So viele Zeilen des Gesprächs stehen in der Ansicht */
const CALL_LINES = 4;
/** Zweimal hintereinander „nichts verstanden" nach Unterbrechen per Stimme: nur noch Antippen */
const CALL_ECHO_STRIKES = 2;
/**
 * Mit gesetzter Audio-Sitzung (Issue #280): jeder Fehlalarm macht den
 * Echo-Schutz im Worklet strenger; erst nach so vielen in Folge nur noch
 * Antippen, damit sich tybo nicht immer wieder selbst unterbricht
 */
const CALL_ECHO_STRIKES_SESSION = 4;
/**
 * Zusätzlicher Puffer des Wegs über MediaStream und <audio> (Issue #280):
 * so lange ist ein Ton noch zu hören, nachdem der Spieler ihn ausgegeben
 * hat. Kein Browser meldet diesen Wert, daher großzügig fest
 */
const CALL_ROUTE_BUFFER_MS = 300;
const CALL_NOTHING_NOTICE = "nichts verstanden";

/** Schlüssel in localStorage; getrennt von SPEECH_DEVICE_KEY des Sprechmodus */
const CALL_DEVICE_KEY = "tybo-call-device";

const CALL_TEXT = {
  get button() { return "Mit " + window.TYBO_BRAND.name + " telefonieren"; },
  title: "Telefonhörer",
  connecting: "Verbindet …",
  listening: "Hört zu",
  understanding: "Versteht …",
  thinking: "Denkt …",
  lookingUp: "schaut nach …",
  speaking: "Spricht",
  muted: "Stumm",
  lost: "Verbindung weg",
  ended: "Aufgelegt",
  error: "Fehler",
  mute: "Stumm",
  unmute: "Mikrofon an",
  hangup: "Auflegen",
  again: "Noch einmal",
  close: "Schließen",
  ok: "Verstanden",
  get hint() { return "Mit Kopfhörern kannst du " + window.TYBO_BRAND.name + " ins Wort fallen. Über Lautsprecher tippe zum Unterbrechen."; },
  iosMic: "Auf dem iPhone fragt die installierte App bei jedem Gespräch nach dem Mikrofon. Einfach erlauben.",
  nothing: "Nichts verstanden.",
  get tapOnly() { return "Ins Wort fallen per Stimme ist für dieses Gespräch aus, " + window.TYBO_BRAND.name + " hat sich wohl selbst gehört. Tippe zum Unterbrechen."; },
  reconnecting: "Die Verbindung ist weg. Ein neuer Versuch läuft.",
  reconnected: "Wieder verbunden.",
  micFailed: "Das Mikrofon ließ sich nicht starten.",
  micLost: "Das Mikrofon ist nicht mehr verfügbar.",
  connectFailed: "Die Verbindung zum Telefonhörer kam nicht zustande.",
  startFailed: "Der Telefonhörer ließ sich nicht starten.",
  protocol: "Die Verbindung wurde wegen eines Fehlers getrennt.",
  busy: "Es läuft schon ein Gespräch am Telefonhörer, in einem anderen Fenster oder auf einem anderen Gerät.",
  tooMany: "Zu viele Anrufe in kurzer Zeit. Bitte in ein paar Minuten noch einmal.",
  background: "Gespräch beendet, weil die App im Hintergrund war.",
  /** Wartende Werkzeug-Freigabe (Issue #259): nur per Knopf, nie per Stimme */
  get approval() { return window.TYBO_BRAND.name + " wartet auf deine Freigabe"; },
  noVoice: "Dieser Browser hat keine Stimme zum Vorsprechen.",
  noVoiceFallback: "Die Stimme auf dem Server steht gerade nicht bereit, und dieser Browser hat keine eigene Stimme zum Vorsprechen. Das Gespräch ist beendet.",
  stage: {
    erkennung: "Das Erkennen hat nicht geklappt.",
    modell: "Das Modell hat nicht geantwortet.",
    stimme: "Die Stimme hat nicht geklappt.",
  },
  get ends() {
    const name = window.TYBO_BRAND.name;
    return {
      aufgelegt: "Aufgelegt.",
      stille: "Zwei Minuten nichts gehört.",
      dauer: "Die Höchstdauer von 60 Minuten ist erreicht.",
      fehler: "Zwei Fehler in Folge.",
      budget: "Das Tagesbudget für Sprache ist aufgebraucht.",
      neustart: name + " startet kurz neu. Ruf gleich wieder an.",
      verbindung: "Die Verbindung ist abgerissen.",
      server: "Die WebUI wurde beendet.",
    };
  },
  deviceTitle: "Telefonhörer auf diesem Gerät",
  deviceIntro: "Gilt nur für diesen Browser auf diesem Gerät und wird nur hier gespeichert. Stimme, Tempo und Pause kommen aus dem Abschnitt darüber.",
  bargeLabel: "Ins Wort fallen",
  bargeVoice: "Per Stimme und Antippen",
  bargeTap: "Nur Antippen",
  bargeHint: "Per Stimme klappt zuverlässig nur mit Kopfhörer. Über Lautsprecher hängt es an der Echo-Unterdrückung des Browsers; mit der Stimme des Browsers geht nur Antippen.",
  noStorage: "Dieser Browser speichert hier nichts. Es gelten die Standardwerte.",
};

// ---------------------------------------------------------------------------
// Voraussetzungen und Einstellungen pro Gerät
// ---------------------------------------------------------------------------

/** "server" oder "browser": wer laut Status spricht */
function callTtsPlace(status) {
  return status && status.tts && status.tts.where === "server" ? "server" : "browser";
}

/**
 * Kann dieser Browser den Telefonhörer? Sicherer Kontext, Mikrofon,
 * AudioContext mit audioWorklet, WebSocket, und mit der Browser-Stimme
 * speechSynthesis. MediaRecorder braucht er nicht. Wirft nie.
 */
function callSupported(win, status) {
  try {
    if (!win || win.isSecureContext !== true) return false;
    const devices = win.navigator && win.navigator.mediaDevices;
    if (!devices || typeof devices.getUserMedia !== "function") return false;
    const Context = win.AudioContext;
    if (typeof Context !== "function" || !Context.prototype || !("audioWorklet" in Context.prototype)) return false;
    if (typeof win.AudioWorkletNode !== "function" || typeof win.WebSocket !== "function") return false;
    if (callTtsPlace(status) === "browser") return !!win.speechSynthesis && typeof win.SpeechSynthesisUtterance === "function";
    return true;
  } catch {
    return false;
  }
}

/** modes.call aus GET /api/voice, wenn bereit; sonst null */
function readyCallMode(data) {
  const call = data && data.modes && typeof data.modes === "object" ? data.modes.call : null;
  return call && call.ready === true ? call : null;
}

function callDeviceDefaults() {
  return { bargeIn: "voice", hintSeen: false, iosHintSeen: false };
}

/** Einstellungen dieses Geräts; ohne localStorage oder bei kaputtem Inhalt die Standardwerte. Wirft nie. */
function readCallDevice(storage) {
  const device = callDeviceDefaults();
  let parsed = null;
  try {
    const raw = storage ? storage.getItem(CALL_DEVICE_KEY) : null;
    parsed = typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    return device;
  }
  if (!parsed || typeof parsed !== "object") return device;
  if (parsed.bargeIn === "tap") device.bargeIn = "tap";
  if (parsed.hintSeen === true) device.hintSeen = true;
  if (parsed.iosHintSeen === true) device.iosHintSeen = true;
  return device;
}

/** Schreibt die Einstellungen dieses Geräts; false, wenn der Browser nichts speichert */
function writeCallDevice(storage, device) {
  try {
    if (!storage) return false;
    storage.setItem(CALL_DEVICE_KEY, JSON.stringify({
      bargeIn: device.bargeIn === "tap" ? "tap" : "voice",
      hintSeen: device.hintSeen === true,
      iosHintSeen: device.iosHintSeen === true,
    }));
    return true;
  } catch {
    return false;
  }
}

/** Installierte App auf iPhone oder iPad (Home-Bildschirm). Wirft nie. */
function callIosApp(win) {
  try {
    const nav = win && win.navigator;
    if (!nav) return false;
    const ua = String(nav.userAgent || "");
    const ios = /iPad|iPhone|iPod/.test(ua) || (nav.platform === "MacIntel" && Number(nav.maxTouchPoints) > 1);
    if (!ios) return false;
    if (nav.standalone === true) return true;
    return typeof win.matchMedia === "function" && !!win.matchMedia("(display-mode: standalone)").matches;
  } catch {
    return false;
  }
}

/** mm:ss */
function callClock(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const pad = n => String(n).padStart(2, "0");
  return pad(Math.floor(seconds / 60)) + ":" + pad(seconds % 60);
}

/** „erster Satz nach …" wird „Erster Satz nach …" */
function callExpectation(status) {
  const text = status && typeof status.expectation === "string" ? status.expectation.trim() : "";
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

// ---------------------------------------------------------------------------
// Zustandsmaschine
// ---------------------------------------------------------------------------

/**
 * Der Telefonhörer eines Fensters. deps:
 *   win                         window (Mikrofon, AudioContext, Worklets, WebSocket, Stimme, Wake Lock)
 *   setTimeout, clearTimeout, now   für Tests ersetzbar
 *   storage                     localStorage oder null
 *   url()                       Adresse des WebSockets (Standard aus win.location)
 *   onChange()                  Zustand geändert: Ansicht neu zeichnen
 *   onLevel()                   nur der Pegel hat sich geändert
 *   onTick()                    die Gesprächsdauer ist weitergelaufen
 *   onUnauthorized()            Anmeldung abgelaufen
 *   microphoneProblem(err)      Text zu einem getUserMedia-Fehler (aus app.js)
 *   stopTracks(stream)          alle Spuren beenden (aus app.js)
 *
 * Der Nutzer löst aus: start(conversationId, status, agent), tap(),
 * mute(on), hangUp(), retry(), close(), acknowledgeHint(). Die Seite
 * meldet visibility(visible).
 */
function createCallMode(deps) {
  const win = deps.win;
  const setTimer = deps.setTimeout || ((fn, ms) => win.setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout || (id => win.clearTimeout(id));
  const now = deps.now || (() => Date.now());
  const notify = () => {
    if (typeof deps.onChange === "function") deps.onChange();
  };

  const s = {
    /** off | connecting | listening | understanding | thinking | speaking | lost | ended | error */
    phase: "off",
    muted: false,
    session: 0,
    capture: 0,
    link: 0,
    epoch: 0,
    playEpoch: 0,
    synthToken: 0,
    conversationId: null,
    agent: "",
    status: null,
    /** Gewünschte Stimme ("server" | "browser") und die laut ready tatsächliche */
    tts: "browser",
    ttsActual: null,
    sampleRate: 24000,
    ws: null,
    /** ready auf der laufenden Verbindung bzw. irgendwann in diesem Gespräch */
    ready: false,
    wasReady: false,
    retried: false,
    /** ended vom Server ist da: der Abschluss kommt von dort */
    endedByServer: false,
    startError: "",
    captureReady: false,
    stream: null,
    context: null,
    source: null,
    vadNode: null,
    vadSink: null,
    playerNode: null,
    /** Wiedergabe über MediaStream und <audio> (Issue #280): { destination, element, failed } oder null */
    route: null,
    vadConfig: null,
    startedAt: 0,
    duration: 0,
    note: "",
    step: "",
    expectation: "",
    lines: [],
    /** Offene Werkzeug-Freigaben des Gesprächs (Issue #259): { id, options } */
    approvals: [],
    turn: 0,
    /** Nach interrupt: Sätze und Ton des abgebrochenen Turns verwerfen, bis der Server wieder zuhört */
    discarding: false,
    audioId: null,
    /** Zum laufenden Abschnitt (audioId) ging schon Ton an den Spieler */
    audioFed: false,
    /**
     * Abschnitte mit Ton vom Server, noch nicht zu Ende gespielt (Issue #276),
     * und Reste im Puffer des <audio>-Wegs ("drain:<id>", Issue #280)
     */
    serverPending: new Set(),
    sentences: new Map(),
    synthQueue: [],
    synthBusy: false,
    synthCurrent: null,
    voiceActive: false,
    level: 0,
    /** Die laufende Äußerung begann als Unterbrechen per Stimme */
    bargeVoice: false,
    echoStrikes: 0,
    tapOnly: false,
    iosHint: false,
    hidden: false,
    /** Gesetzte Audio-Sitzung (Issue #280): { session, previous } bis zum Freigeben, sonst null */
    audioSession: null,
    /** Namen der Zeitgeber für played, die auf den Puffer des <audio>-Wegs warten */
    playedTimers: new Set(),
    wake: null,
    wakeWanted: false,
    wakeTicket: 0,
    wakePending: false,
    timers: new Map(),
  };

  function device() {
    return readCallDevice(deps.storage);
  }

  function speechDevice() {
    return typeof readSpeechDevice === "function" ? readSpeechDevice(deps.storage) : { pause: "normal", voice: "", rate: 1 };
  }

  // --- Zeitgeber -------------------------------------------------------------

  function timer(name, ms, fn) {
    cancelTimer(name);
    const id = setTimer(() => {
      if (s.timers.get(name) !== id) return;
      s.timers.delete(name);
      fn();
    }, ms);
    s.timers.set(name, id);
  }

  function cancelTimer(name) {
    if (!s.timers.has(name)) return;
    clearTimer(s.timers.get(name));
    s.timers.delete(name);
  }

  function cancelTimers() {
    for (const id of s.timers.values()) clearTimer(id);
    s.timers.clear();
  }

  function tick() {
    timer("tick", 1000, () => {
      if (!live()) return;
      if (typeof deps.onTick === "function") deps.onTick();
      else notify();
      tick();
    });
  }

  /** Das Gespräch läuft (nicht aus, nicht beendet, kein Fehler) */
  function live() {
    return s.phase !== "off" && s.phase !== "ended" && s.phase !== "error";
  }

  // --- Verbindung ---------------------------------------------------------------

  function socketUrl() {
    if (typeof deps.url === "function") return deps.url();
    const loc = win.location;
    return (loc.protocol === "https:" ? "wss://" : "ws://") + loc.host + CALL_SOCKET_PATH;
  }

  function sendJson(message) {
    const ws = s.ws;
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  function connect() {
    if (!live()) return;
    const link = ++s.link;
    s.ready = false;
    let ws;
    try {
      ws = new win.WebSocket(socketUrl());
    } catch {
      fail(CALL_TEXT.connectFailed);
      return;
    }
    s.ws = ws;
    try {
      ws.binaryType = "arraybuffer";
    } catch {
      // ältere Umgebung
    }
    ws.onopen = () => {
      if (link !== s.link) return;
      // Genau einmal je Verbindung, gleich nach dem Öffnen (der Server wartet höchstens 10 s)
      sendJson({ type: "start", conversationId: s.conversationId, tts: s.tts });
    };
    ws.onmessage = event => onSocket(link, event && event.data);
    ws.onclose = event => onClose(link, event || {});
    ws.onerror = () => {};
  }

  function closeSocket(sayGoodbye) {
    const ws = s.ws;
    s.link++;
    s.ws = null;
    s.ready = false;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      if (sayGoodbye && ws.readyState === 1) ws.send(JSON.stringify({ type: "hangup" }));
    } catch {
      // schon zu
    }
    try {
      ws.close(1000);
    } catch {
      // schon zu
    }
  }

  function onSocket(link, data) {
    if (link !== s.link || !live()) return;
    if (typeof data !== "string") {
      onAudio(data);
      return;
    }
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;
    switch (msg.type) {
      case "ready":
        onReady(msg);
        return;
      case "state":
        onState(msg.state);
        return;
      case "transcript":
        onTranscript(typeof msg.text === "string" ? msg.text : "");
        return;
      case "sentence":
        onSentence(msg.id, typeof msg.text === "string" ? msg.text : "");
        return;
      case "audio_begin":
        if (s.discarding || typeof msg.id !== "number") return;
        s.audioId = msg.id;
        s.audioFed = false;
        s.serverPending.add(msg.id);
        postPlayer({ type: "begin", id: msg.id });
        return;
      case "audio_restart":
        // Rückfall der Stimme (Issue #276): der Abschnitt kommt von vorn, Ungespieltes fällt weg
        if (s.discarding || typeof msg.id !== "number" || msg.id !== s.audioId) return;
        postPlayer({ type: "restart", id: msg.id });
        return;
      case "speak_browser":
        onSpeakBrowser(msg.id, typeof msg.text === "string" ? msg.text : "");
        return;
      case "audio_end":
        if (s.discarding || typeof msg.id !== "number") return;
        postPlayer({ type: "end", id: msg.id });
        s.audioId = null;
        return;
      case "tool":
        // Suche (und unbekannte Werkzeuge): „schaut nach …"; Rechnen und Denkauftrag bleiben bei „Denkt …" (Issue #259)
        if (s.discarding || msg.name === "rechne" || msg.name === "denkauftrag") return;
        if (s.phase === "thinking" || s.phase === "understanding") {
          s.step = CALL_TEXT.lookingUp;
          notify();
        }
        return;
      case "approval":
        onApprovals(msg.choices);
        return;
      case "notice":
        onNotice(typeof msg.text === "string" ? msg.text : "");
        return;
      case "error":
        onError(typeof msg.reason === "string" ? msg.reason : "", typeof msg.message === "string" ? msg.message : "");
        return;
      case "ended":
        onEnded(typeof msg.reason === "string" ? msg.reason : "", typeof msg.seconds === "number" ? msg.seconds : null);
        return;
    }
  }

  /** Offene Freigaben (Issue #259): nur geprüfte Kennungen und Knöpfe; entschieden wird per Knopf, nie per Stimme */
  function onApprovals(list) {
    const valid = [];
    for (const c of Array.isArray(list) ? list : []) {
      // Muster wie CHOICE_ID_PATTERN und CHOICE_KEY_PATTERN im Server
      if (!c || typeof c.id !== "string" || !/^[A-Za-z0-9]{1,12}$/.test(c.id) || !Array.isArray(c.options)) continue;
      const options = c.options.filter(o => o && typeof o.key === "string" && /^[A-Za-z0-9_-]{1,32}$/.test(o.key) && typeof o.label === "string").map(o => ({ key: o.key, label: o.label }));
      if (options.length) valid.push({ id: c.id, options });
    }
    s.approvals = valid;
    notify();
  }

  function onReady(msg) {
    const again = s.wasReady;
    s.ready = true;
    s.wasReady = true;
    cancelTimer("retryLimit");
    s.ttsActual = msg.tts === "server" ? "server" : "browser";
    if (typeof msg.sampleRate === "number" && msg.sampleRate > 0) s.sampleRate = msg.sampleRate;
    if (!s.startedAt) {
      s.startedAt = now();
      tick();
    }
    // Spricht doch der Browser (Rückfall vom Server) und kann er das nicht: ohne Stimme kein Gespräch
    if (s.ttsActual === "browser" && !synth()) {
      fail(s.tts === "server" ? CALL_TEXT.noVoiceFallback : CALL_TEXT.noVoice);
      return;
    }
    if (again) s.note = CALL_TEXT.reconnected;
    if (s.muted) sendJson({ type: "mute", on: true });
    notify();
  }

  const SERVER_PHASES = { verbindet: "connecting", "hoert-zu": "listening", versteht: "understanding", denkt: "thinking", spricht: "speaking" };

  function onState(state) {
    const phase = SERVER_PHASES[state];
    if (!phase) return;
    if (s.discarding) {
      // Nach interrupt: Zustände des abgebrochenen Turns verfallen, bis der Server mit „hört zu" bestätigt.
      // Das tut er für jedes interrupt, auch wenn nichts mehr lief (docs/webui/telefonhoerer-protokoll.md)
      if (phase !== "listening") return;
      s.discarding = false;
      // Die neue Äußerung ist schon ganz hinaus („Versteht …" am Browser): so bleiben, versteht kommt gleich
      if (s.phase === "understanding") return;
    }
    if (phase === "listening") {
      // Ab hier gehört alles zum nächsten Turn
      s.step = "";
      if (s.phase !== "listening") s.voiceActive = false;
    }
    if (phase === "thinking" && s.phase !== "thinking") s.step = "";
    s.phase = phase;
    arm();
    notify();
  }

  function onTranscript(text) {
    // Erkannter Text des abgebrochenen Turns: verwerfen, die Sperre löst nur „hört zu"
    if (s.discarding) return;
    s.turn++;
    s.expectation = "";
    if (s.bargeVoice) s.echoStrikes = 0;
    s.bargeVoice = false;
    if (s.note === CALL_TEXT.nothing || s.note === CALL_TEXT.reconnected) s.note = "";
    if (text) addLine("user", text);
    notify();
  }

  function onSentence(id, text) {
    if (s.discarding || typeof id !== "number" || !text) return;
    s.sentences.set(id, text);
    if (s.ttsActual === "browser") {
      s.synthQueue.push({ id, text });
      speakNext();
    }
  }

  /**
   * Diesen Abschnitt spricht die Browser-Stimme (Issue #276, Server-Stimme
   * ausgefallen): Ton des Servers zu ihm verwerfen, Satz in die Reihe der
   * Browser-Stimme. Sie beginnt erst, wenn der Ton davor gespielt ist, über
   * den <audio>-Weg auch ein schon ausgegebener Anfang dieses Abschnitts.
   */
  function onSpeakBrowser(id, text) {
    if (s.discarding || typeof id !== "number" || !text) return;
    s.serverPending.delete(id);
    if (s.audioId === id) {
      postPlayer({ type: "drop", id });
      s.audioId = null;
      // Über <audio> ist der schon ausgegebene Anfang des Satzes noch im Puffer: die
      // Ersatzstimme wartet, bis er verklungen ist, statt ihn zu überlagern (Issue #280)
      if (s.audioFed && routeActive()) waitForRoute("drain:" + id);
    }
    // Ohne Browser-Stimme bliebe der Satz stumm und unbestätigt: verständlich beenden wie bei ready
    if (!synth()) {
      fail(CALL_TEXT.noVoiceFallback);
      return;
    }
    s.synthQueue.push({ id, text });
    speakNext();
    // Solange die Ersatzstimme spricht, unterbricht nur Antippen
    arm();
  }

  function onNotice(text) {
    if (text === CALL_NOTHING_NOTICE) {
      s.note = CALL_TEXT.nothing;
      if (s.bargeVoice) {
        s.echoStrikes++;
        s.bargeVoice = false;
        // Der Echo-Schutz im Worklet wird strenger, bevor der nächste Satz kommt
        postVad({ type: "echo" });
        const limit = s.audioSession ? CALL_ECHO_STRIKES_SESSION : CALL_ECHO_STRIKES;
        if (s.echoStrikes >= limit && !s.tapOnly) {
          // Vermutlich das eigene Echo: für dieses Gespräch nur noch Antippen
          s.tapOnly = true;
          s.note = CALL_TEXT.tapOnly;
          arm();
        }
      }
    } else if (text) {
      s.note = text;
    }
    notify();
  }

  function onError(reason, message) {
    if (!s.ready) {
      s.startError = message || CALL_TEXT.startFailed;
      return;
    }
    s.note = CALL_TEXT.stage[reason] || message || CALL_TEXT.startFailed;
    notify();
  }

  function onEnded(reason, seconds) {
    s.endedByServer = true;
    if (reason === "abgemeldet") {
      unauthorized();
      return;
    }
    if (reason === "start" || reason === "protokoll" || reason === "zu-gross" || !s.wasReady) {
      fail(s.startError || (reason === "protokoll" || reason === "zu-gross" ? CALL_TEXT.protocol : CALL_TEXT.startFailed));
      return;
    }
    finish(CALL_TEXT.ends[reason] || CALL_TEXT.ends.aufgelegt, seconds);
  }

  function onClose(link, event) {
    if (link !== s.link || !live()) return;
    s.ws = null;
    s.ready = false;
    if (s.endedByServer) return;
    const code = typeof event.code === "number" ? event.code : 1006;
    if (code === 4001) {
      unauthorized();
      return;
    }
    if (code === 4409) {
      fail(CALL_TEXT.busy);
      return;
    }
    if (code === 4029) {
      fail(CALL_TEXT.tooMany);
      return;
    }
    if (!s.wasReady) {
      fail(s.startError || CALL_TEXT.connectFailed);
      return;
    }
    if (!s.retried && CALL_RETRY_CODES.includes(code)) {
      lose();
      return;
    }
    finish(CALL_TEXT.ends.verbindung, null);
  }

  /**
   * Netzabbruch nach ready: genau ein neuer Versuch als neues start (der
   * Server kennt keine Fortsetzung). Was von der alten Verbindung noch in
   * Aufnahme und Ausgabe steckt, fällt weg.
   */
  function lose() {
    s.retried = true;
    s.phase = "lost";
    s.note = CALL_TEXT.reconnecting;
    s.step = "";
    s.voiceActive = false;
    s.level = 0;
    stopPlayback();
    s.discarding = false;
    s.bargeVoice = false;
    arm();
    notify();
    timer("retry", CALL_RETRY_DELAY_MS, () => {
      if (s.phase !== "lost") return;
      connect();
      timer("retryLimit", CALL_RETRY_READY_MS, () => {
        if (s.ready || !live()) return;
        closeSocket(true);
        finish(CALL_TEXT.ends.verbindung, null);
      });
    });
  }

  // --- Mikrofon und Pausenerkennung ----------------------------------------------

  function setTracks(enabled) {
    const stream = s.stream;
    if (!stream || typeof stream.getTracks !== "function") return;
    for (const track of stream.getTracks()) track.enabled = !!enabled;
  }

  /** Unterbrechen per Stimme ist erlaubt: Einstellung, nicht abgeschaltet, Ton aus dem Server */
  function voiceBarge() {
    return !s.tapOnly && device().bargeIn === "voice" && s.ttsActual === "server" && !fallbackVoice();
  }

  /** Die Ersatzstimme (speak_browser, Issue #276) spricht oder wartet: sie geht an der Echo-Unterdrückung vorbei */
  function fallbackVoice() {
    return s.synthBusy || s.synthQueue.length > 0;
  }

  /**
   * Erkennung nach Zustand einstellen: zuhören (normal), während tybo spricht
   * nur mit erlaubtem Unterbrechen per Stimme (streng), sonst aus. Jeder
   * Wechsel ist ein neuer Abschnitt mit neuer Laufnummer.
   */
  function arm() {
    const ok = s.ready && s.captureReady && !s.muted;
    let next = { active: false, strict: false };
    if (ok && s.phase === "listening") next = { active: true, strict: false };
    else if (ok && s.phase === "speaking" && voiceBarge()) next = { active: true, strict: true };
    // Unverändert: nichts neu beginnen, sonst wäre eine laufende Äußerung weg
    const prev = s.vadConfig;
    if (prev && prev.active === next.active && prev.strict === next.strict) return;
    configureVad(next, false);
  }

  function postVad(message) {
    if (!s.vadNode) return;
    try {
      s.vadNode.port.postMessage(message);
    } catch {
      // Worklet schon geschlossen
    }
  }

  function configureVad(next, keep) {
    if (!s.vadNode) return;
    if (!keep) s.epoch++;
    s.vadConfig = next;
    if (!next.active) s.voiceActive = false;
    const pause = speechDevice().pause;
    try {
      s.vadNode.port.postMessage({
        type: "config",
        epoch: s.epoch,
        active: next.active,
        strict: next.strict,
        keep: !!keep,
        reset: !keep,
        pauseMs: CALL_PAUSES[pause] || CALL_PAUSES.normal,
        startMs: next.strict ? CALL_STRICT_START_MS : CALL_START_MS,
      });
    } catch {
      // Worklet schon geschlossen
    }
  }

  function closeCapture() {
    s.capture++;
    s.captureReady = false;
    s.vadConfig = null;
    closeRoute();
    for (const node of [s.vadNode, s.playerNode]) {
      if (!node) continue;
      try {
        node.port.postMessage({ type: "close" });
      } catch {
        // schon geschlossen
      }
      node.port.onmessage = null;
    }
    for (const part of [s.source, s.vadNode, s.vadSink, s.playerNode]) {
      if (!part) continue;
      try {
        part.disconnect();
      } catch {
        // schon getrennt
      }
    }
    if (s.stream) {
      if (typeof s.stream.getTracks === "function") for (const track of s.stream.getTracks()) track.onended = null;
      deps.stopTracks(s.stream);
    }
    if (s.context) {
      s.context.onstatechange = null;
      try {
        const closing = s.context.close();
        if (closing && typeof closing.catch === "function") closing.catch(() => {});
      } catch {
        // schon geschlossen
      }
    }
    s.stream = null;
    s.context = null;
    s.source = null;
    s.vadNode = null;
    s.vadSink = null;
    s.playerNode = null;
  }

  /**
   * Wiedergabe über MediaStream (Issue #280), nur mit gesetzter
   * Audio-Sitzung: Der Spieler schreibt in eine MediaStreamAudioDestination,
   * ein <audio>-Element spielt ihren Strom. So läuft der Ton wie bei einem
   * Telefonat im Browser, und die Echo-Unterdrückung des Mikrofons kennt
   * ihn. Das Element startet hier im Tipp (iOS verlangt das). Weigert es
   * sich, spielt der Spieler wie bisher direkt in den AudioContext.
   */
  function openRoute(context, capture) {
    s.route = null;
    if (!s.audioSession || typeof context.createMediaStreamDestination !== "function" || typeof win.Audio !== "function") return;
    let route;
    try {
      const destination = context.createMediaStreamDestination();
      const element = new win.Audio();
      element.autoplay = true;
      element.srcObject = destination.stream;
      route = { destination, element, failed: false };
      s.route = route;
      const playing = element.play();
      if (playing && typeof playing.then === "function") playing.then(null, () => routeFailed(route, capture));
    } catch {
      if (route) routeFailed(route, capture);
      else s.route = null;
    }
  }

  /** Das <audio>-Element spielt nicht: zurück auf den direkten Weg, auch für einen schon verbundenen Spieler */
  function routeFailed(route, capture) {
    if (route.failed) return;
    route.failed = true;
    dropElement(route.element);
    if (capture !== s.capture || s.route !== route || !s.playerNode || !s.context) return;
    try {
      s.playerNode.disconnect(route.destination);
    } catch {
      // nie verbunden
    }
    try {
      s.playerNode.connect(s.context.destination);
    } catch {
      // Kontext schon zu
    }
  }

  /** Wohin der Spieler ausgibt: MediaStream (wenn er spielt) oder direkt */
  function playbackTarget(context) {
    return routeActive() ? s.route.destination : context.destination;
  }

  /** Der Ton läuft über das <audio>-Element (mit seinem zusätzlichen Puffer) */
  function routeActive() {
    return !!(s.route && !s.route.failed);
  }

  /**
   * Unterbrechen: was schon im Puffer des <audio>-Elements steckt, soll
   * nicht mehr zu hören sein. Das Element bleibt an (ein neues play()
   * bräuchte unter iOS einen Tipp) und ist stumm, bis der Puffer leer ist.
   */
  function silenceRoute() {
    if (!routeActive()) return;
    const route = s.route;
    try {
      route.element.muted = true;
    } catch {
      // Element weg
    }
    timer("routeUnmute", CALL_ROUTE_BUFFER_MS, () => {
      if (s.route !== route || route.failed) return;
      try {
        route.element.muted = false;
      } catch {
        // Element weg
      }
    });
  }

  function dropElement(element) {
    try {
      element.pause();
    } catch {
      // schon angehalten
    }
    try {
      element.srcObject = null;
    } catch {
      // nichts zu lösen
    }
  }

  function closeRoute() {
    const route = s.route;
    s.route = null;
    if (!route) return;
    route.failed = true;
    dropElement(route.element);
  }

  /**
   * AudioContext (im Tipp angelegt und gestartet, iOS verlangt das), beide
   * Worklets und das Mikrofon. Der Strom bleibt bis zum Auflegen offen
   * (sonst fragt die installierte iOS-App nach einer Minute erneut). Jeder
   * Schritt prüft die Laufnummer: Wurde inzwischen aufgelegt, wird ein spät
   * eintreffender Strom sofort gestoppt und nichts gestartet.
   */
  async function openCapture() {
    closeCapture();
    const capture = s.capture;
    const current = () => s.capture === capture;
    let context;
    let modules;
    try {
      context = new win.AudioContext();
      s.context = context;
      if (typeof context.resume === "function") {
        const resumed = context.resume();
        if (resumed && typeof resumed.catch === "function") resumed.catch(() => {});
      }
      context.onstatechange = () => {
        if (current()) checkBackground();
      };
      openRoute(context, capture);
      modules = Promise.all([
        Promise.resolve(context.audioWorklet.addModule(CALL_VAD_WORKLET_PATH)),
        Promise.resolve(context.audioWorklet.addModule(CALL_PLAYER_WORKLET_PATH)),
      ]);
    } catch {
      fail(CALL_TEXT.micFailed);
      return;
    }
    modules.catch(() => {});
    let stream;
    try {
      stream = await win.navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (err) {
      if (current()) fail(deps.microphoneProblem(err));
      return;
    }
    if (!current()) {
      deps.stopTracks(stream);
      return;
    }
    s.stream = stream;
    setTracks(!s.muted);
    try {
      await modules;
    } catch {
      if (current()) fail(CALL_TEXT.micFailed);
      return;
    }
    if (!current()) return;
    try {
      const source = context.createMediaStreamSource(stream);
      // Zweiter Eingang: der Ton des Spielers, als Pegel für den Echo-Schutz
      const vadNode = new win.AudioWorkletNode(context, CALL_VAD_WORKLET_NAME, { numberOfInputs: 2, numberOfOutputs: 1, processorOptions: { mode: "call" } });
      // Stumm an den Ausgang, damit der Browser das Worklet sicher rechnet
      const sink = context.createGain();
      sink.gain.value = 0;
      vadNode.port.onmessage = event => onWorklet(capture, event && event.data);
      source.connect(vadNode);
      vadNode.connect(sink);
      sink.connect(context.destination);
      const playerNode = new win.AudioWorkletNode(context, CALL_PLAYER_WORKLET_NAME, { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
      playerNode.port.onmessage = event => onPlayer(capture, event && event.data);
      playerNode.connect(playbackTarget(context));
      // Nur mit Audio-Sitzung kennt die Erkennung den Ton des Spielers; ohne bleibt sie wie vor #280
      if (s.audioSession) playerNode.connect(vadNode, 0, 1);
      // Ein neuer Spieler beginnt mit Laufnummer 0: auf die laufende Nummer bringen, sonst verfielen seine Meldungen
      playerNode.port.postMessage({ type: "flush", epoch: s.playEpoch });
      s.source = source;
      s.vadNode = vadNode;
      s.vadSink = sink;
      s.playerNode = playerNode;
    } catch {
      fail(CALL_TEXT.micFailed);
      return;
    }
    if (typeof stream.getTracks === "function") {
      for (const track of stream.getTracks()) {
        track.onended = () => {
          if (current()) fail(CALL_TEXT.micLost);
        };
      }
    }
    s.captureReady = true;
    arm();
    notify();
  }

  function onWorklet(capture, data) {
    if (capture !== s.capture || !data || data.epoch !== s.epoch || !live()) return;
    if (data.type === "level") {
      s.level = typeof data.level === "number" ? data.level : 0;
      if (typeof deps.onLevel === "function") deps.onLevel();
      return;
    }
    if (data.type === "speechstart") {
      if (s.phase === "speaking") {
        if (!voiceBarge()) return;
        // Per Stimme ins Wort gefallen: die bestätigte Äußerung läuft weiter, ab jetzt mit normaler Schwelle
        if (!interrupt({ keepVad: true })) return;
        s.bargeVoice = true;
      }
      if (s.phase !== "listening") return;
      s.voiceActive = true;
      notify();
      return;
    }
    if (data.type === "chunk") {
      // Nur im Zustand „hört zu", nie stumm, nie vor ready
      if (s.phase !== "listening" || s.muted || !s.ready || !data.samples || !s.ws || s.ws.readyState !== 1) return;
      try {
        s.ws.send(data.samples.buffer);
      } catch {
        // Verbindung weg: onclose kümmert sich
      }
      return;
    }
    if (data.type === "pause") {
      if (s.phase === "listening" && s.voiceActive) sendJson({ type: "utterance_pause" });
      return;
    }
    if (data.type === "speechend") {
      if (s.phase !== "listening" || !s.voiceActive) return;
      sendJson({ type: "utterance_end" });
      // Bis der Server antwortet: nichts mehr senden
      s.phase = "understanding";
      s.voiceActive = false;
      s.level = 0;
      s.note = "";
      arm();
      notify();
      return;
    }
    if (data.type === "dropped") {
      s.voiceActive = false;
      notify();
    }
  }

  // --- Wiedergabe ------------------------------------------------------------------

  function postPlayer(message, transfer) {
    if (!s.playerNode) return;
    try {
      s.playerNode.port.postMessage(message, transfer || []);
    } catch {
      // schon geschlossen
    }
  }

  function onAudio(data) {
    if (s.discarding || s.audioId === null || s.ttsActual !== "server" || !data) return;
    const buffer = data instanceof ArrayBuffer ? data : data.buffer instanceof ArrayBuffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : null;
    if (!buffer || buffer.byteLength % 2 !== 0) return;
    postPlayer({ type: "audio", buffer, rate: s.sampleRate }, [buffer]);
    s.audioFed = true;
  }

  function onPlayer(capture, data) {
    if (capture !== s.capture || !data || data.epoch !== s.playEpoch || !live()) return;
    if (data.type === "begin") {
      showSentence(data.id);
      return;
    }
    if (data.type === "played" && typeof data.id === "number") {
      if (!routeActive()) {
        played(data.id);
        return;
      }
      // Über <audio> ist der Ton erst nach dessen Puffer zu Ende gehört
      const name = "played:" + data.id;
      const epoch = s.playEpoch;
      s.playedTimers.add(name);
      timer(name, CALL_ROUTE_BUFFER_MS, () => {
        s.playedTimers.delete(name);
        if (capture !== s.capture || epoch !== s.playEpoch || !live()) return;
        played(data.id);
      });
    }
  }

  /**
   * Die Ersatzstimme hält an, bis der Puffer des <audio>-Wegs leer ist: ein
   * Eintrag in serverPending, den der Zeitgeber wieder löst. Unterbrechen und
   * Auflegen räumen ihn mit den übrigen played-Zeitgebern ab.
   */
  function waitForRoute(key) {
    const name = "played:" + key;
    const capture = s.capture;
    const epoch = s.playEpoch;
    s.serverPending.add(key);
    s.playedTimers.add(name);
    timer(name, CALL_ROUTE_BUFFER_MS, () => {
      s.playedTimers.delete(name);
      if (capture !== s.capture || epoch !== s.playEpoch || !live()) return;
      if (s.serverPending.delete(key)) speakNext();
    });
  }

  function played(id) {
    sendJson({ type: "played", id });
    // Ein Satz der Browser-Stimme (Rückfall) wartet, bis der Ton davor gespielt ist
    if (s.serverPending.delete(id)) speakNext();
  }

  function showSentence(id) {
    const text = s.sentences.get(id);
    if (!text) return;
    s.sentences.delete(id);
    addLine("tybo", text);
    notify();
  }

  function addLine(who, text) {
    const last = s.lines[s.lines.length - 1];
    if (who === "tybo" && last && last.who === "tybo" && last.turn === s.turn) last.text += " " + text;
    else s.lines.push({ who, text, turn: s.turn });
    while (s.lines.length > CALL_LINES) s.lines.shift();
  }

  function synth() {
    try {
      return win.speechSynthesis && typeof win.SpeechSynthesisUtterance === "function" ? win.speechSynthesis : null;
    } catch {
      return null;
    }
  }

  /** Browser-Stimme: Satz für Satz, played nach dem Ende jedes Satzes */
  function speakNext() {
    if (s.synthBusy || !s.synthQueue.length || s.serverPending.size) return;
    const engine = synth();
    if (!engine) {
      s.synthQueue = [];
      return;
    }
    const item = s.synthQueue.shift();
    const token = s.synthToken;
    const settings = speechDevice();
    let done = false;
    let started = false;
    // Satzanzeige mit dem Beginn der Wiedergabe (start); nach Unterbrechen oder Ende verfällt ein spätes start
    const show = () => {
      if (started || done || token !== s.synthToken) return;
      started = true;
      showSentence(item.id);
    };
    const next = ended => {
      if (done || token !== s.synthToken) return;
      // Ein Browser ohne start: der Satz ist gesprochen, also spätestens jetzt anzeigen
      if (ended) show();
      done = true;
      cancelTimer("synthGuard");
      s.synthBusy = false;
      s.synthCurrent = null;
      if (ended) sendJson({ type: "played", id: item.id });
      speakNext();
      // Ersatzstimme fertig: Ton aus dem Server darf wieder per Stimme unterbrochen werden
      arm();
    };
    try {
      const utterance = new win.SpeechSynthesisUtterance(item.text);
      const voice = typeof speechModeVoice === "function" && typeof speechModeVoices === "function" ? speechModeVoice(speechModeVoices(win), settings.voice) : null;
      if (voice) utterance.voice = voice;
      utterance.lang = voice && /^de(?:[-_]|$)/i.test(String(voice.lang || "")) ? voice.lang : "de-DE";
      utterance.rate = typeof settings.rate === "number" ? settings.rate : 1;
      utterance.onstart = show;
      utterance.onend = () => next(true);
      utterance.onerror = () => next(false);
      s.synthBusy = true;
      s.synthCurrent = utterance;
      // Wächter: kommt weder end noch error, ohne Bestätigung weiter (der Server hat eine eigene Frist)
      const guard = typeof speechGuardMs === "function" ? speechGuardMs(item.text, utterance.rate) : 4000 + item.text.length * 110;
      timer("synthGuard", guard, () => {
        if (done || token !== s.synthToken) return;
        try {
          engine.cancel();
        } catch {
          // keine Stimme
        }
        next(false);
      });
      engine.speak(utterance);
    } catch {
      next(false);
    }
  }

  /** Wiedergabe sofort still: Ringpuffer leer, Browser-Stimme abgebrochen, späte Meldungen verfallen */
  function stopPlayback() {
    // Auch die Ersatzstimme in einem Server-Gespräch (speak_browser, Issue #276) verstummt sofort
    const browserSpeaking = s.synthBusy || s.synthCurrent !== null;
    s.playEpoch++;
    postPlayer({ type: "flush", epoch: s.playEpoch });
    // Auch den Rest im Puffer des <audio>-Wegs, und ungehörte Satzenden bestätigt niemand mehr
    silenceRoute();
    for (const name of s.playedTimers) cancelTimer(name);
    s.playedTimers.clear();
    s.synthToken++;
    s.synthQueue = [];
    s.synthBusy = false;
    s.synthCurrent = null;
    cancelTimer("synthGuard");
    const engine = synth();
    if (engine && (s.ttsActual === "browser" || browserSpeaking)) {
      try {
        engine.cancel();
      } catch {
        // keine Stimme
      }
    }
    s.sentences.clear();
    s.serverPending.clear();
    s.audioId = null;
  }

  /** Stummes Stück im Tipp, damit iOS die Browser-Stimme später ohne Nutzeraktion spricht (auch für den Rückfall vom Server) */
  function unlockSynth() {
    const engine = synth();
    if (!engine) return;
    try {
      engine.cancel();
      const silent = new win.SpeechSynthesisUtterance(" ");
      silent.volume = 0;
      silent.lang = "de-DE";
      engine.speak(silent);
    } catch {
      // ohne Stimme: ready sagt es
    }
  }

  // --- Unterbrechen, Stumm --------------------------------------------------------

  /** Laufende Antwort abbrechen: Wiedergabe still, interrupt an den Server, wieder zuhören */
  function interrupt(options) {
    if (!["understanding", "thinking", "speaking"].includes(s.phase) || !s.ready) return false;
    stopPlayback();
    // Alles, was vom abgebrochenen Turn noch unterwegs ist, fällt weg
    s.discarding = true;
    // interrupt geht vor jedem Ton der neuen Äußerung hinaus
    sendJson({ type: "interrupt" });
    s.phase = "listening";
    s.step = "";
    s.note = "";
    s.bargeVoice = false;
    if (options && options.keepVad) configureVad({ active: true, strict: false }, true);
    else arm();
    notify();
    return true;
  }

  /** Antippen der Ansicht oder Leertaste: unterbricht immer */
  function tap() {
    interrupt();
  }

  function mute(on) {
    if (!live() || s.phase === "lost") return;
    const next = !!on;
    if (next === s.muted) return;
    s.muted = next;
    // Stumm: Spur aus und angefangene Aufnahme verworfen; der Strom bleibt offen (track.stop() erst beim Auflegen)
    setTracks(!next);
    // Vor ready wäre mute ein Protokollfehler; onReady holt es nach
    if (s.ready) sendJson({ type: "mute", on: next });
    s.voiceActive = false;
    s.level = 0;
    if (next) configureVad({ active: false, strict: false }, false);
    else arm();
    notify();
  }

  // --- Anfang und Ende ---------------------------------------------------------------

  /** Tipp auf „Telefonhörer": status ist modes.call aus GET /api/voice */
  function start(conversationId, status, agent) {
    if (live() || !conversationId) return;
    s.session++;
    const dev = device();
    Object.assign(s, {
      phase: "connecting",
      muted: false,
      conversationId,
      agent: typeof agent === "string" ? agent : "",
      status: status || null,
      tts: callTtsPlace(status),
      ttsActual: null,
      sampleRate: 24000,
      ready: false,
      wasReady: false,
      retried: false,
      endedByServer: false,
      startError: "",
      startedAt: 0,
      duration: 0,
      note: "",
      step: "",
      expectation: callExpectation(status),
      lines: [],
      approvals: [],
      turn: 0,
      discarding: false,
      audioId: null,
      voiceActive: false,
      level: 0,
      bargeVoice: false,
      echoStrikes: 0,
      tapOnly: false,
      hidden: false,
      iosHint: !dev.iosHintSeen && callIosApp(win),
    });
    s.sentences.clear();
    s.serverPending.clear();
    if (s.iosHint) writeCallDevice(deps.storage, Object.assign(dev, { iosHintSeen: true }));
    notify();
    // Vor AudioContext und Mikrofon: iOS soll die Sprachverarbeitung für Telefonate nehmen
    claimAudioSession();
    // Alles, was iOS nur in einer Nutzeraktion erlaubt, jetzt im Tipp; die Browser-Stimme
    // auch bei Ton aus dem Server, denn ready kann auf den Browser zurückfallen
    unlockSynth();
    requestWake();
    void openCapture();
    connect();
  }

  /** Alles freigeben: Verbindung, Mikrofon, Wiedergabe, Zeitgeber, Bildschirm */
  function release(sayGoodbye) {
    stopPlayback();
    closeSocket(sayGoodbye);
    closeCapture();
    releaseAudioSession();
    cancelTimers();
    releaseWake();
    s.voiceActive = false;
    s.level = 0;
    s.discarding = false;
    s.step = "";
    if (s.startedAt) s.duration = now() - s.startedAt;
  }

  /** Vom Server oder durch Abbruch beendet: „Aufgelegt" mit Dauer und Grund bleibt stehen */
  function finish(text, seconds) {
    release(!s.endedByServer);
    if (typeof seconds === "number" && seconds >= 0) s.duration = seconds * 1000;
    s.phase = "ended";
    s.note = text;
    notify();
  }

  /** Fehler mit Satz und „Noch einmal" */
  function fail(text) {
    release(true);
    s.phase = "error";
    s.note = text;
    notify();
  }

  /** Auflegen (Knopf, Gesprächswechsel, Abmelden, Verlassen, Neuladen): zurück zur Eingabebox */
  function hangUp() {
    if (s.phase === "off") return;
    s.session++;
    release(true);
    s.phase = "off";
    s.conversationId = null;
    s.note = "";
    s.lines = [];
    s.approvals = [];
    notify();
  }

  function unauthorized() {
    hangUp();
    if (typeof deps.onUnauthorized === "function") deps.onUnauthorized();
  }

  /** „Noch einmal" nach einem Fehler oder Auflegen (aus einem Tipp) */
  function retry() {
    if (live() || !s.conversationId) return;
    const id = s.conversationId;
    const status = s.status;
    const agent = s.agent;
    s.phase = "off";
    start(id, status, agent);
  }

  // --- Audio-Sitzung (Issue #280) ------------------------------------------------------------

  /**
   * navigator.audioSession (Safari ab iOS 17, W3C Audio Session) auf
   * "play-and-record": iOS soll Mikrofon und Wiedergabe als Telefonat
   * behandeln. Der vorige Wert wird gemerkt und bei jedem Ende
   * zurückgesetzt. Ohne die API (Chrome, Firefox, Android) ändert sich
   * nichts. Wirft nie.
   */
  function claimAudioSession() {
    releaseAudioSession();
    let session = null;
    try {
      session = win.navigator ? win.navigator.audioSession : null;
    } catch {
      session = null;
    }
    if (!session || typeof session !== "object") return;
    try {
      const previous = session.type;
      if (typeof previous !== "string") return;
      session.type = "play-and-record";
      s.audioSession = { session, previous };
    } catch {
      // Die API wehrt sich: wie ohne sie
    }
  }

  function releaseAudioSession() {
    const held = s.audioSession;
    s.audioSession = null;
    if (!held) return;
    try {
      held.session.type = held.previous;
    } catch {
      // nichts mehr zu tun
    }
  }

  // --- Hintergrund und Bildschirm ---------------------------------------------------------

  /** iOS hält den Ton an, wenn die App in den Hintergrund geht: dann auflegen und es sagen */
  function checkBackground() {
    const context = s.context;
    if (!live() || !context) return;
    const state = context.state;
    if (s.hidden && (state === "suspended" || state === "interrupted")) background();
  }

  function background() {
    finish(CALL_TEXT.background, null);
  }

  function visibility(visible) {
    s.hidden = !visible;
    if (!live()) return;
    if (visible) {
      const state = s.context ? s.context.state : "running";
      // Zurück aus dem Hintergrund und der Ton steht: das Gespräch ist nicht mehr zu retten
      if (state === "suspended" || state === "interrupted") {
        background();
        return;
      }
      if (s.wakeWanted) acquireWake();
      return;
    }
    checkBackground();
  }

  function requestWake() {
    s.wakeWanted = true;
    acquireWake();
  }

  function acquireWake() {
    let api = null;
    try {
      api = win.navigator && win.navigator.wakeLock;
    } catch {
      api = null;
    }
    if (!api || typeof api.request !== "function" || s.wake || s.wakePending) return;
    const ticket = ++s.wakeTicket;
    s.wakePending = true;
    let request;
    try {
      request = Promise.resolve(api.request("screen"));
    } catch {
      s.wakePending = false;
      return;
    }
    request.then(
      lock => {
        if (ticket !== s.wakeTicket || !s.wakeWanted) {
          dropLock(lock);
          return;
        }
        s.wakePending = false;
        s.wake = lock;
        if (lock && typeof lock.addEventListener === "function") {
          lock.addEventListener("release", () => {
            if (s.wake === lock) s.wake = null;
          });
        }
      },
      () => {
        if (ticket === s.wakeTicket) s.wakePending = false;
      }
    );
  }

  function dropLock(lock) {
    try {
      const released = lock && typeof lock.release === "function" ? lock.release() : null;
      if (released && typeof released.catch === "function") released.catch(() => {});
    } catch {
      // schon frei
    }
  }

  function releaseWake() {
    s.wakeWanted = false;
    s.wakeTicket++;
    s.wakePending = false;
    const lock = s.wake;
    s.wake = null;
    if (lock) dropLock(lock);
  }

  // --- Anzeige ---------------------------------------------------------------------

  function acknowledgeHint() {
    writeCallDevice(deps.storage, Object.assign(device(), { hintSeen: true }));
    notify();
  }

  const LABELS = {
    connecting: CALL_TEXT.connecting,
    listening: CALL_TEXT.listening,
    understanding: CALL_TEXT.understanding,
    thinking: CALL_TEXT.thinking,
    speaking: CALL_TEXT.speaking,
    lost: CALL_TEXT.lost,
    ended: CALL_TEXT.ended,
    error: CALL_TEXT.error,
  };

  function view() {
    // Bis Mikrofon und Verbindung stehen, heißt es „Verbindet …", auch wenn der Server schon zuhört
    let phase = s.phase;
    if (live() && phase !== "lost" && (!s.ready || !s.captureReady)) phase = "connecting";
    let label = LABELS[phase] || "";
    if (phase === "listening" && s.muted) label = CALL_TEXT.muted;
    const running = live() && phase !== "connecting" && phase !== "lost";
    let note = s.note;
    if (phase === "connecting" && !note && s.iosHint) note = CALL_TEXT.iosMic;
    const elapsed = s.phase === "ended" || s.phase === "error" ? s.duration : s.startedAt ? now() - s.startedAt : 0;
    return {
      phase,
      active: s.phase !== "off",
      conversationId: s.conversationId,
      title: CALL_TEXT.title,
      agent: s.agent,
      label,
      step: phase === "thinking" || phase === "understanding" ? s.step : "",
      note,
      expectation: live() && s.turn === 0 ? s.expectation : "",
      duration: s.startedAt || s.duration ? callClock(elapsed) : "",
      lines: s.lines.map(l => ({ who: l.who, text: l.text })),
      /** Wartende Freigaben mit Knöpfen wie im Verlauf (Issue #259) */
      approvals: live() ? s.approvals.map(a => ({ id: a.id, options: a.options.slice() })) : [],
      level: s.level,
      voiceActive: s.voiceActive,
      /** Das Mikrofon ist offen (stehender roter Punkt): Strom da, nicht stumm */
      micOpen: live() && s.captureReady && !s.muted,
      muted: s.muted,
      canMute: running,
      /** Antippen unterbricht */
      tappable: running && ["understanding", "thinking", "speaking"].includes(phase),
      canHangup: live(),
      canRetry: s.phase === "error" || s.phase === "ended",
      ended: s.phase === "ended" || s.phase === "error",
      hint: live() && !device().hintSeen,
      tapOnly: s.tapOnly,
    };
  }

  return {
    start,
    tap,
    mute,
    hangUp,
    retry,
    /** Fehler oder „Aufgelegt" gelesen: Ansicht schließen */
    close: hangUp,
    acknowledgeHint,
    visibility,
    view,
    active: () => s.phase !== "off",
    /** Ein Gespräch läuft (nicht: Aufgelegt oder Fehler gezeigt) */
    engaged: () => live(),
    state: s,
  };
}

// ---------------------------------------------------------------------------
// Abschnitt „Telefonhörer auf diesem Gerät" im Reiter „Sprechen"
// ---------------------------------------------------------------------------

/**
 * Einstellung pro Gerät: „Ins Wort fallen: per Stimme und Antippen / nur
 * Antippen". Jede Änderung geht sofort in localStorage (CALL_DEVICE_KEY)
 * und nirgends sonst hin. deps: storage, render(), h, sectionNode (aus
 * settings.js), segment (speechSegment aus speech.js).
 */
function createCallDeviceSettings(deps) {
  const storage = deps.storage;
  const state = { writeFailed: false };

  function canStore() {
    if (!storage || state.writeFailed) return false;
    try {
      storage.getItem(CALL_DEVICE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  function save(patch) {
    if (!writeCallDevice(storage, Object.assign(readCallDevice(storage), patch))) state.writeFailed = true;
    if (typeof deps.render === "function") deps.render();
  }

  function nodes() {
    const h = deps.h;
    const device = readCallDevice(storage);
    const stored = canStore();
    const children = [];
    if (!stored) children.push(h("p", { className: "actions-hint", role: "status", "data-call-device": "no-storage", text: CALL_TEXT.noStorage }));
    children.push(h("div", { className: "settings-field" }, [
      h("p", { className: "settings-label", id: "call-device-barge", text: CALL_TEXT.bargeLabel }),
      h("div", { className: "settings-actions" }, [
        deps.segment(h, "call-device-barge", "call-device-barge", [{ value: "voice", label: CALL_TEXT.bargeVoice }, { value: "tap", label: CALL_TEXT.bargeTap }], device.bargeIn, !stored, value => save({ bargeIn: value })),
      ]),
      h("p", { className: "actions-hint", text: CALL_TEXT.bargeHint }),
    ]));
    return [deps.sectionNode("call-device", CALL_TEXT.deviceTitle, [CALL_TEXT.deviceIntro], children)];
  }

  return { nodes, save };
}
