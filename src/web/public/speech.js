// Sprechmodus in der WebUI (Issue #250, Entscheidung 0023): der Nutzer tippt
// auf „Sprechen", redet, macht eine Pause, und die Antwort wird vorgelesen.
// Klassisches Skript ohne Build, vor settings.js und app.js geladen; beide
// prüfen mit typeof, ob es da ist.
//
// - Die Pausenerkennung läuft im AudioWorklet (speech-worklet.js). Diese Datei
//   verpackt die fertige Äußerung als WAV, schickt sie an
//   POST /api/conversations/<id>/speech und führt die Zustände.
// - Vorgelesen wird nur die Antwort auf die eigene Äußerung, genau einmal.
// - Jede Sitzung und jede Äußerung trägt eine Laufnummer. Was mit einer alten
//   Nummer eintrifft (Mikrofon, Worklet, Upload, Sprachausgabe, Zeitgeber),
//   startet weder Aufnahme noch Ausgabe.
// - Einstellungen pro Gerät liegen nur in localStorage (SPEECH_DEVICE_KEY),
//   nie in PATCH /api/settings.
// - Nutzertext kommt nur über textContent in die Seite.
"use strict";

/** Rate und Höchstlänge der WAV-Datei wie in speech-worklet.js: 58 Sekunden, unter den 60 Sekunden und 2 MB des Servers */
const SPEECH_WAV_RATE = 16000;
const SPEECH_WAV_MAX_SAMPLES = 928000;
const SPEECH_WORKLET_PATH = "/speech-worklet.js";
const SPEECH_WORKLET_NAME = "speech-vad";

/**
 * PCM16 mono 16 kHz als WAV (44 Bytes Kopf, dann die Werte). Mehr als 58
 * Sekunden gehen nie hinaus, auch wenn das Worklet mehr liefern sollte.
 */
function speechWav(samples) {
  const count = Math.min(samples ? samples.length : 0, SPEECH_WAV_MAX_SAMPLES);
  const bytes = new Uint8Array(44 + count * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at, text) => {
    for (let i = 0; i < text.length; i++) bytes[at + i] = text.charCodeAt(i);
  };
  ascii(0, "RIFF");
  view.setUint32(4, 36 + count * 2, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true);
  // PCM, ein Kanal
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SPEECH_WAV_RATE, true);
  view.setUint32(28, SPEECH_WAV_RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, "data");
  view.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) view.setInt16(44 + i * 2, samples[i], true);
  return bytes;
}

// ---------------------------------------------------------------------------
// Modi, Voraussetzungen, Einstellungen pro Gerät
// ---------------------------------------------------------------------------

/** Schlüssel in localStorage; getrennt von den globalen speech-Einstellungen des Servers */
const SPEECH_DEVICE_KEY = "tybo-speech-device";
/** Pause bis zum Ende einer Äußerung, pro Gerät wählbar */
const SPEECH_PAUSES = { short: 500, normal: 800, long: 1300 };
const SPEECH_PAUSE_LABELS = { short: "Kurz", normal: "Normal", long: "Lang" };
const SPEECH_RATE_MIN = 0.8;
const SPEECH_RATE_MAX = 1.4;
const SPEECH_RATES = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4];
/** Sprechbeginn nach so vielen Millisekunden über der Schwelle; streng beim Unterbrechen per Stimme */
const SPEECH_MODE_START_MS = 150;
const SPEECH_MODE_STRICT_START_MS = 300;
/** Ohne Sprache in dieser Zeit pausiert der Modus */
const SPEECH_IDLE_PAUSE_MS = 2 * 60 * 1000;
/** Abstand der Beschäftigt-Abfrage und ihre Geduld */
const SPEECH_BUSY_POLL_MS = 2000;
const SPEECH_BUSY_MAX_MS = 2 * 60 * 1000;
/** Nach so langem Denken steht einmal der Hinweis zur Wartezeit */
const SPEECH_SLOW_HINT_MS = 8000;
/** So lange steht „Nichts verstanden", bevor wieder zugehört wird */
const SPEECH_NOTHING_MS = 1500;
/** So viele vorübergehende Fehler in Folge beenden den Modus */
const SPEECH_TRANSIENT_MAX = 3;
/** Anfang der Antwort im Bereich, in Zeichen */
const SPEECH_REPLY_PREVIEW_CHARS = 160;
const SPEECH_TTS_PATH = "/api/speech/tts";
const SPEECH_PROBE_TEXT = "So klingt die Stimme für den Sprechmodus.";

const SPEECH_MODE_TEXT = {
  get button() { return "Mit " + window.TYBO_BRAND.name + " sprechen"; },
  starting: "Mikrofon wird freigegeben …",
  listening: "Hört zu",
  understanding: "Verstehe …",
  thinking: "Denkt …",
  speaking: "Spricht",
  nothing: "Nichts verstanden",
  waiting: "Wartet",
  paused: "Pausiert",
  error: "Fehler",
  busy: "In diesem Gespräch läuft schon eine Antwort. Nichts gesendet.",
  busyOther: "In diesem Gespräch läuft gerade eine Antwort.",
  free: "Wieder frei. Sprich noch einmal.",
  limit: "Längste Äußerung erreicht, gesendet.",
  get asking() { return window.TYBO_BRAND.name + " fragt nach. Entscheide im Verlauf."; },
  noAnswer: "Keine Antwort zum Vorlesen. Siehe Verlauf.",
  slow: "Das kann je nach Motor dauern.",
  ttsFailed: "Vorlesen fehlgeschlagen. Die Antwort steht im Verlauf.",
  blocked: "Tippe, um die Antwort zu hören.",
  confirmStop: "Antwort abbrechen?",
  stopping: "Wird abgebrochen …",
  idlePaused: "Zwei Minuten nichts gehört. Mit „Weiter\" geht es weiter.",
  busyPaused: "Das Gespräch ist seit zwei Minuten beschäftigt. Mit „Weiter\" noch einmal versuchen.",
  userPaused: "Das Mikrofon ist aus.",
  network: "Verbindung unterbrochen. Ob die Äußerung ankam, steht im Verlauf. Nichts wird erneut gesendet.",
  again: "Sprich noch einmal.",
  transient: "Die Äußerung kam nicht an.",
  threeFailed: "Drei Fehler in Folge. Der Sprechmodus ist beendet.",
  closed: "Das Topic ist geschlossen.",
  gone: "Dieses Gespräch gibt es nicht mehr.",
  unavailable: "Der Sprechmodus ist gerade nicht verfügbar.",
  micFailed: "Das Mikrofon ließ sich nicht starten. Nichts gesendet.",
  micLost: "Das Mikrofon ist nicht mehr verfügbar.",
  deviceTitle: "Sprechmodus auf diesem Gerät",
  deviceIntro: "Gilt nur für diesen Browser auf diesem Gerät und wird nur hier gespeichert.",
  noStorage: "Dieser Browser speichert hier nichts. Es gelten die Standardwerte.",
  pauseLabel: "Pause bis zum Senden",
  pauseHint: "So lange wartet der Sprechmodus nach deinem letzten Wort, bevor er sendet: kurz 0,5 Sekunden, normal 0,8, lang 1,3.",
  voiceLabel: "Stimme",
  voiceDefault: "Vorauswahl des Browsers",
  voiceHint: "Eingebaute Stimmen dieses Browsers, auf dem Gerät gespeicherte zuerst.",
  voiceServer: "Gerade liest eine Stimme des Servers vor. Stimme und Probe gelten für die Browser-Stimme.",
  noGerman: "Dieser Browser hat keine deutsche Stimme. Zur Wahl stehen alle Stimmen; gesprochen wird mit der Sprachangabe Deutsch.",
  noVoices: "Dieser Browser hat keine eingebaute Stimme.",
  voicesLoading: "Die Stimmen werden noch geladen.",
  rateLabel: "Tempo",
  probe: "Probe",
  headphonesLabel: "Mit Kopfhörer: per Stimme unterbrechen",
  headphonesHint: "Nur mit Kopfhörer sinnvoll: über Lautsprecher hört der Sprechmodus sonst die eigene Antwort und unterbricht sich. Ob ein Kopfhörer steckt, wird nicht geprüft.",
};

/**
 * Bereite Sprechmodi aus GET /api/voice, in fester Reihenfolge. Heute gibt es
 * nur „local" (Hören, Motor, Sprechen); ein weiterer Modus (eigener
 * ElevenLabs-Agent, Issue #245) kommt hier in die Liste, ohne dass der Knopf
 * umgebaut wird. Eine Auswahl zwischen Modi gibt es noch nicht: der Knopf
 * nimmt den ersten bereiten.
 */
const SPEECH_MODE_ORDER = ["local"];

function readySpeechModes(data) {
  const modes = data && data.modes && typeof data.modes === "object" ? data.modes : null;
  if (!modes) return [];
  return SPEECH_MODE_ORDER.filter(id => modes[id] && modes[id].ready === true).map(id => ({ id, status: modes[id] }));
}

/** "browser" oder "server": wer im Modus local vorliest */
function speechTtsPlace(status) {
  return status && status.tts && status.tts.where === "server" ? "server" : "browser";
}

/**
 * Kann dieser Browser den Sprechmodus? Sicherer Kontext, Mikrofon,
 * AudioContext mit audioWorklet, und zum Vorlesen speechSynthesis
 * (Browser-Stimme) bzw. ein Audio-Element (Server-Stimme). MediaRecorder
 * braucht der Modus nicht. Wirft nie.
 */
function speechModeSupported(win, status) {
  try {
    if (!win || win.isSecureContext !== true) return false;
    const devices = win.navigator && win.navigator.mediaDevices;
    if (!devices || typeof devices.getUserMedia !== "function") return false;
    const Context = win.AudioContext;
    if (typeof Context !== "function" || !Context.prototype || !("audioWorklet" in Context.prototype)) return false;
    if (typeof win.AudioWorkletNode !== "function") return false;
    if (speechTtsPlace(status) === "browser") return !!win.speechSynthesis && typeof win.SpeechSynthesisUtterance === "function";
    return typeof win.Audio === "function";
  } catch {
    return false;
  }
}

function speechDeviceDefaults() {
  return { pause: "normal", voice: "", rate: 1, headphones: false };
}

function speechClampRate(value) {
  const rate = Number(value);
  if (!Number.isFinite(rate)) return 1;
  return Math.min(SPEECH_RATE_MAX, Math.max(SPEECH_RATE_MIN, rate));
}

/** Einstellungen dieses Geräts; ohne localStorage oder bei kaputtem Inhalt die Standardwerte. Wirft nie. */
function readSpeechDevice(storage) {
  const device = speechDeviceDefaults();
  let raw = null;
  try {
    raw = storage ? storage.getItem(SPEECH_DEVICE_KEY) : null;
  } catch {
    return device;
  }
  if (typeof raw !== "string") return device;
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return device;
  }
  if (!parsed || typeof parsed !== "object") return device;
  if (typeof parsed.pause === "string" && Object.prototype.hasOwnProperty.call(SPEECH_PAUSES, parsed.pause)) device.pause = parsed.pause;
  if (typeof parsed.voice === "string" && parsed.voice.length <= 200) device.voice = parsed.voice;
  if (typeof parsed.rate === "number") device.rate = speechClampRate(parsed.rate);
  if (parsed.headphones === true) device.headphones = true;
  return device;
}

/** Schreibt die Einstellungen dieses Geräts; false, wenn der Browser nichts speichert */
function writeSpeechDevice(storage, device) {
  try {
    if (!storage) return false;
    storage.setItem(SPEECH_DEVICE_KEY, JSON.stringify({
      pause: Object.prototype.hasOwnProperty.call(SPEECH_PAUSES, device.pause) ? device.pause : "normal",
      voice: typeof device.voice === "string" ? device.voice : "",
      rate: speechClampRate(device.rate),
      headphones: device.headphones === true,
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Stimmen des Browsers für den Sprechmodus: die deutschen, lokale vor
 * Online-Stimmen. Gibt es keine deutsche, alle Stimmen (german false; dann
 * wird mit lang "de-DE" gesprochen). Wirft nie; ohne speechSynthesis leer.
 */
function speechModeVoices(win) {
  let all = [];
  try {
    const synth = win && win.speechSynthesis;
    all = synth && typeof synth.getVoices === "function" ? Array.from(synth.getVoices() || []) : [];
  } catch {
    all = [];
  }
  all = all.filter(v => v && typeof v.voiceURI === "string");
  const german = all.filter(v => /^de(?:[-_]|$)/i.test(String(v.lang || "")));
  const base = german.length ? german : all;
  // Lokale zuerst, sonst die Reihenfolge des Browsers
  const list = base.filter(v => v.localService === true).concat(base.filter(v => v.localService !== true));
  return { list, german: german.length > 0 };
}

/** Die gewählte Stimme; fehlt sie (oder ist keine gewählt), die Vorauswahl: die erste deutsche, sonst keine */
function speechModeVoice(voices, stored) {
  const hit = stored ? voices.list.find(v => v.voiceURI === stored) : null;
  if (hit) return hit;
  return voices.german ? voices.list[0] || null : null;
}

/** Wächter je Segment: kommt in dieser Zeit weder end noch error, geht es mit dem nächsten weiter */
function speechGuardMs(text, rate) {
  return Math.round(4000 + (String(text).length * 110) / speechClampRate(rate));
}

// ---------------------------------------------------------------------------
// Zustandsmaschine
// ---------------------------------------------------------------------------

/**
 * Der Sprechmodus eines Fensters. deps:
 *   win                         window (Mikrofon, AudioContext, Stimme, Wake Lock)
 *   fetch, setTimeout, clearTimeout   für Tests ersetzbar, sonst die des Fensters
 *   storage                     localStorage oder null (Einstellungen dieses Geräts)
 *   messages()                  Nachrichten des offenen Gesprächs, nach Zeit sortiert
 *   running()                   läuft im Gespräch gerade ein Turn (Stand der Seite)
 *   onChange()                  Zustand hat sich geändert: Bereich neu zeichnen
 *   onLevel()                   nur der Pegel hat sich geändert
 *   onAccepted()                Äußerung angenommen: Verlauf abgleichen (die eigene Nachricht kommt in reinen Web-Gesprächen nicht als Ereignis)
 *   requestSync()               Verlauf abgleichen; danach ruft die Seite synced()
 *   onUnauthorized()            Anmeldung abgelaufen
 *   onClosed(id, text)          das Topic ist inzwischen geschlossen
 *   microphoneProblem(err)      Text zu einem getUserMedia-Fehler (aus app.js)
 *   stopTracks(stream)          alle Spuren beenden (aus app.js)
 *
 * Die Seite meldet: status(running, awaiting), messagesChanged(),
 * synced(running, mark), turnError(), progress(text), visibility(visible).
 * Der Nutzer löst aus: start(), pause(), resume(), hangUp(), tap(),
 * confirmStop(yes), close().
 */
function createSpeechMode(deps) {
  const win = deps.win;
  const doFetch = deps.fetch || ((...args) => win.fetch(...args));
  const setTimer = deps.setTimeout || ((fn, ms) => win.setTimeout(fn, ms));
  const clearTimer = deps.clearTimeout || (id => win.clearTimeout(id));
  const notify = () => {
    if (typeof deps.onChange === "function") deps.onChange();
  };

  const s = {
    /** off | starting | listening | understanding | nothing | thinking | speaking | waiting | paused | error */
    phase: "off",
    /** Laufnummer der Sitzung (Tipp auf „Sprechen" bis Auflegen) */
    session: 0,
    /** Laufnummer der Äußerung; auch Pause und Auflegen zählen weiter, damit späte Ergebnisse verfallen */
    utterance: 0,
    /** Laufnummer des Mikrofon-Aufbaus (getUserMedia, addModule) */
    capture: 0,
    /** Laufnummer der Ausgabe: jedes Starten und Stoppen zählt weiter */
    speak: 0,
    /** Laufnummer des Abschnitts der Pausenerkennung; Meldungen des Worklets tragen sie */
    epoch: 0,
    conversationId: null,
    /** "browser" | "server" */
    tts: "browser",
    note: "",
    heard: "",
    reply: "",
    step: "",
    /** Schritt, der schon während „Verstehe …" ankam; gilt ab „Denkt …" */
    earlyStep: "",
    level: 0,
    voiceActive: false,
    confirm: false,
    blocked: false,
    blockedPlay: null,
    asking: false,
    slow: false,
    /** Letzter bekannter Stand: im Gespräch läuft ein Turn */
    running: false,
    /** Erwartete Antwort: { utterance, messageId }; silent nach bestätigtem Abbruch (wird nie vorgelesen) */
    pending: null,
    transient: 0,
    /** Zählt angenommene Äußerungen (202); ein Abgleich, der davor begann, entscheidet nicht über „keine Antwort" */
    accepted: 0,
    /** Nach dem Warten „Sprich noch einmal" zeigen (es wurde etwas verworfen) */
    freeNote: true,
    /** Kopfhörer-Einstellung für die laufende Ausgabe: Sprache unterbricht */
    bargeIn: false,
    stream: null,
    context: null,
    source: null,
    node: null,
    sink: null,
    upload: null,
    poll: null,
    pollSeq: 0,
    audio: null,
    queue: null,
    current: null,
    ttsAborts: new Set(),
    urls: new Set(),
    wake: null,
    wakeWanted: false,
    wakeTicket: 0,
    wakePending: false,
    timers: new Map(),
    /** Schon vorgelesene Antworten: nie ein zweites Mal, auch nicht in einer späteren Sitzung */
    spoken: new Set(),
  };

  function device() {
    return readSpeechDevice(deps.storage);
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

  // --- Mikrofon und Pausenerkennung -------------------------------------------

  function setMic(enabled) {
    const stream = s.stream;
    if (!stream || typeof stream.getTracks !== "function") return;
    for (const track of stream.getTracks()) track.enabled = !!enabled;
  }

  /** Erkennung ein oder aus. Ein neuer Abschnitt bekommt eine neue Laufnummer; keep behält sie (laufende Äußerung übernehmen). */
  function setVad(active, options) {
    if (!s.node) return;
    if (!(options && options.keep)) s.epoch++;
    try {
      s.node.port.postMessage({
        type: "config",
        epoch: s.epoch,
        active: !!active,
        pauseMs: SPEECH_PAUSES[device().pause] || SPEECH_PAUSES.normal,
        startMs: options && options.strict ? SPEECH_MODE_STRICT_START_MS : SPEECH_MODE_START_MS,
      });
    } catch {
      // Worklet schon geschlossen
    }
  }

  function closeCapture() {
    s.capture++;
    if (s.node) {
      try {
        s.node.port.postMessage({ type: "close" });
      } catch {
        // schon geschlossen
      }
      s.node.port.onmessage = null;
    }
    for (const part of [s.source, s.node, s.sink]) {
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
    s.node = null;
    s.sink = null;
  }

  /**
   * Mikrofon holen und das Worklet anschließen. Der AudioContext entsteht
   * sofort (im Tipp), das Mikrofon kommt danach. Jeder Schritt prüft die
   * Laufnummer: Wurde inzwischen aufgelegt oder pausiert, wird ein spät
   * eintreffender Stream sofort gestoppt und nichts gestartet.
   */
  async function openMicrophone() {
    closeCapture();
    const capture = s.capture;
    const current = () => s.capture === capture;
    let context;
    let module;
    try {
      context = new win.AudioContext();
      s.context = context;
      if (typeof context.resume === "function") {
        const resumed = context.resume();
        if (resumed && typeof resumed.catch === "function") resumed.catch(() => {});
      }
      module = Promise.resolve(context.audioWorklet.addModule(SPEECH_WORKLET_PATH));
    } catch {
      fail(SPEECH_MODE_TEXT.micFailed);
      return;
    }
    // Scheitert das Laden, während das Mikrofon noch gefragt wird: unten behandelt
    module.catch(() => {});
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
    try {
      await module;
    } catch {
      if (current()) fail(SPEECH_MODE_TEXT.micFailed);
      return;
    }
    if (!current()) return;
    try {
      const source = context.createMediaStreamSource(stream);
      const node = new win.AudioWorkletNode(context, SPEECH_WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1 });
      // Stumm an den Ausgang, damit der Browser das Worklet sicher rechnet
      const sink = context.createGain();
      sink.gain.value = 0;
      node.port.onmessage = event => onWorklet(capture, event && event.data);
      source.connect(node);
      node.connect(sink);
      sink.connect(context.destination);
      s.source = source;
      s.node = node;
      s.sink = sink;
    } catch {
      fail(SPEECH_MODE_TEXT.micFailed);
      return;
    }
    if (typeof stream.getTracks === "function") {
      for (const track of stream.getTracks()) {
        track.onended = () => {
          if (current()) fail(SPEECH_MODE_TEXT.micLost);
        };
      }
    }
    listen("");
  }

  function onWorklet(capture, data) {
    if (capture !== s.capture || !data || data.epoch !== s.epoch) return;
    if (data.type === "level") {
      if (s.phase !== "listening" && !(s.phase === "speaking" && s.bargeIn)) return;
      s.level = typeof data.level === "number" ? data.level : 0;
      if (typeof deps.onLevel === "function") deps.onLevel();
      return;
    }
    if (data.type === "start") {
      if (s.phase === "speaking" && s.bargeIn) {
        // Kopfhörer: erkannte Sprache stoppt die Ausgabe sofort; die begonnene Äußerung läuft weiter
        stopOutput();
        s.phase = "listening";
        s.note = "";
        s.voiceActive = true;
        setVad(true, { keep: true });
        notify();
      } else if (s.phase === "listening") {
        s.voiceActive = true;
        cancelTimer("idle");
        notify();
      }
      return;
    }
    if (data.type === "dropped") {
      if (s.phase !== "listening") return;
      s.voiceActive = false;
      startIdleTimer();
      notify();
      return;
    }
    if (data.type === "utterance" && s.phase === "listening" && data.samples) void send(data.samples, !!data.limit);
  }

  function startIdleTimer() {
    timer("idle", SPEECH_IDLE_PAUSE_MS, () => {
      if (s.phase === "listening") pause(SPEECH_MODE_TEXT.idlePaused);
    });
  }

  // --- Zustände ---------------------------------------------------------------

  /** Zurück auf „Hört zu"; läuft im Gespräch noch ein Turn, stattdessen „Wartet" */
  function listen(note) {
    if (s.running) {
      wait(note || SPEECH_MODE_TEXT.busyOther, { immediate: true, freeNote: false });
      return;
    }
    cancelTimer("slow");
    cancelTimer("nothing");
    s.phase = "listening";
    s.note = note || "";
    s.pending = null;
    s.confirm = false;
    s.asking = false;
    s.slow = false;
    s.step = "";
    s.voiceActive = false;
    s.level = 0;
    setMic(true);
    setVad(true);
    startIdleTimer();
    notify();
  }

  /** Alles freigeben, was Mikrofon, Ausgabe, Netz, Zeitgeber und Bildschirm hält */
  function release() {
    s.utterance++;
    stopOutput();
    cancelTimers();
    if (s.upload) s.upload.abort();
    s.upload = null;
    stopPoll();
    closeCapture();
    releaseWake();
    s.pending = null;
    s.confirm = false;
    s.asking = false;
    s.slow = false;
    s.step = "";
    s.voiceActive = false;
    s.level = 0;
  }

  /** Fehler mit Satz: der Modus endet und gibt alles frei; der Satz bleibt stehen, bis der Nutzer schließt */
  function fail(text) {
    release();
    s.audio = null;
    s.phase = "error";
    s.note = text;
    notify();
  }

  function pause(note) {
    if (!["starting", "listening", "understanding", "nothing", "thinking", "speaking", "waiting"].includes(s.phase)) return;
    release();
    s.phase = "paused";
    s.note = typeof note === "string" && note ? note : SPEECH_MODE_TEXT.userPaused;
    notify();
  }

  /** „Weiter" (aus einem Tipp): Ausgabe wieder freischalten, Mikrofon neu holen */
  function resume() {
    if (s.phase !== "paused") return;
    s.phase = "starting";
    s.note = "";
    s.running = typeof deps.running === "function" ? !!deps.running() : s.running;
    notify();
    unlockOutput();
    requestWake();
    void openMicrophone();
  }

  /** Tipp auf „Sprechen": status ist modes.local aus GET /api/voice */
  function start(conversationId, status) {
    if (s.phase !== "off" && s.phase !== "error") return;
    if (!conversationId) return;
    s.session++;
    s.conversationId = conversationId;
    s.tts = speechTtsPlace(status);
    s.phase = "starting";
    s.note = "";
    s.heard = "";
    s.reply = "";
    s.transient = 0;
    s.running = typeof deps.running === "function" ? !!deps.running() : false;
    notify();
    unlockOutput();
    requestWake();
    void openMicrophone();
  }

  /** Auflegen: alles frei, ein laufender Turn läuft weiter, seine Antwort wird nicht vorgelesen */
  function hangUp() {
    if (s.phase === "off") return;
    s.session++;
    release();
    s.audio = null;
    s.phase = "off";
    s.conversationId = null;
    s.note = "";
    s.heard = "";
    s.reply = "";
    notify();
  }

  function unauthorized() {
    hangUp();
    if (typeof deps.onUnauthorized === "function") deps.onUnauthorized();
  }

  // --- Äußerung senden ----------------------------------------------------------

  function conversationPath(suffix) {
    return "/api/conversations/" + encodeURIComponent(s.conversationId) + suffix;
  }

  function errorOf(data, fallback) {
    return data && typeof data.error === "string" && data.error ? data.error : fallback;
  }

  /**
   * Eine fertige Äußerung als WAV hochladen. Genau ein Versuch: Geht die
   * Antwort verloren, wird nie erneut gesendet, der Turn könnte schon laufen.
   */
  async function send(samples, limit) {
    const utterance = ++s.utterance;
    const session = s.session;
    const current = () => s.session === session && s.utterance === utterance;
    s.phase = "understanding";
    s.earlyStep = "";
    s.note = limit ? SPEECH_MODE_TEXT.limit : "";
    s.voiceActive = false;
    s.level = 0;
    // Kein Selbstgespräch, keine zweite Äußerung: Mikrofon stumm, Erkennung aus, Rauschschätzung eingefroren
    setMic(false);
    setVad(false);
    cancelTimer("idle");
    // Antwort und Abschluss können vor der 202 eintreffen: die Erwartung steht schon jetzt
    s.pending = { utterance, messageId: null };
    notify();
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    s.upload = controller;
    let res;
    let data = null;
    try {
      res = await doFetch(conversationPath("/speech"), {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "audio/wav" },
        body: speechWav(samples),
        signal: controller ? controller.signal : undefined,
      });
      try {
        data = await res.json();
      } catch {
        data = null;
      }
    } catch {
      if (!current()) return;
      s.upload = null;
      // Ob die Äußerung ankam, ist offen: nichts wiederholen, nachfragen, wann das Gespräch frei ist
      wait(SPEECH_MODE_TEXT.network, { freeNote: true });
      return;
    }
    if (!current()) return;
    s.upload = null;
    const status = res.status;
    if (status === 401) {
      unauthorized();
      return;
    }
    if (status === 202 && data && typeof data.messageId === "string" && data.messageId) {
      s.transient = 0;
      s.accepted++;
      s.heard = typeof data.transcript === "string" ? data.transcript : "";
      s.reply = "";
      s.pending = { utterance, messageId: data.messageId };
      think(limit ? SPEECH_MODE_TEXT.limit : "");
      // Die eigene Nachricht kommt in reinen Web-Gesprächen nicht als Ereignis: über den Verlauf nachladen
      if (typeof deps.onAccepted === "function") deps.onAccepted();
      evaluate(false);
      return;
    }
    s.pending = null;
    const reason = data && typeof data.reason === "string" ? data.reason : "";
    if (status === 422) {
      s.transient = 0;
      s.phase = "nothing";
      s.note = "";
      notify();
      timer("nothing", SPEECH_NOTHING_MS, () => {
        if (s.phase === "nothing") listen("");
      });
      return;
    }
    if (status === 409 && reason === "beschaeftigt") {
      // Die Aufnahme ist verworfen und wird nie später gesendet
      wait(SPEECH_MODE_TEXT.busy, { freeNote: true });
      return;
    }
    // Vorübergehend: zu lang oder zu groß, Erkennung gescheitert, Zeitlimit, Serverfehler
    if (status === 413 || status === 502 || status === 504 || (status >= 500 && status !== 503)) {
      s.transient++;
      if (s.transient >= SPEECH_TRANSIENT_MAX) {
        fail(errorOf(data, SPEECH_MODE_TEXT.transient) + ". " + SPEECH_MODE_TEXT.threeFailed);
        return;
      }
      listen(errorOf(data, SPEECH_MODE_TEXT.transient) + ". " + SPEECH_MODE_TEXT.again);
      return;
    }
    // Endgültig: Gespräch weg, Topic geschlossen, Format, kein Anbieter, Modus nicht verfügbar
    if (status === 404) {
      fail(SPEECH_MODE_TEXT.gone);
      return;
    }
    if (status === 409 && data && data.closed === true) {
      const id = s.conversationId;
      const text = errorOf(data, SPEECH_MODE_TEXT.closed);
      fail(text);
      if (typeof deps.onClosed === "function") deps.onClosed(id, text);
      return;
    }
    fail(errorOf(data, SPEECH_MODE_TEXT.unavailable));
  }

  function think(note) {
    s.phase = "thinking";
    s.note = note || "";
    // Der erste Schritt kann über die Live-Verbindung vor der Antwort auf den Upload ankommen
    s.step = s.earlyStep;
    s.earlyStep = "";
    s.slow = false;
    s.confirm = false;
    s.asking = false;
    // Ehrliche Wartezeit: einmal je Äußerung
    timer("slow", SPEECH_SLOW_HINT_MS, () => {
      if (s.phase !== "thinking") return;
      s.slow = true;
      notify();
    });
    notify();
  }

  /**
   * Sucht die Antwort auf die eigene Äußerung: die erste Nachricht mit
   * speakable hinter der eigenen (messageId aus der 202), gleich ob sie als
   * Ereignis oder über den Abgleich kam. Dahinter endet die Suche an einer
   * Fehlermeldung (der eigene Turn ist gescheitert) und an einer fremden
   * gesprochenen Nachricht: was danach kommt, ist die Antwort auf jemand
   * anderen und bleibt stumm. synced: der Verlauf wurde gerade erfolgreich
   * abgeglichen; erst dann darf „kein Turn läuft" als „keine Antwort" gelten.
   */
  function evaluate(synced) {
    const pending = s.pending;
    if (s.phase !== "thinking" || !pending || !pending.messageId) return;
    const list = typeof deps.messages === "function" ? deps.messages() || [] : [];
    const at = list.findIndex(m => m && m.id === pending.messageId);
    let answer = null;
    let over = false;
    if (at >= 0) {
      for (let i = at + 1; i < list.length; i++) {
        const m = list[i];
        if (!m || typeof m.id !== "string" || m.id.startsWith("lokal-")) continue;
        if (m.role === "error" || (m.role === "user" && m.source === "speech")) {
          over = true;
          break;
        }
        if (m.role === "assistant" && m.kind !== "notice" && typeof m.speakable === "string" && m.speakable.trim()) {
          answer = m;
          break;
        }
      }
    }
    if (answer && pending.silent) {
      // Abbruch bestätigt: die Antwort steht im Verlauf und wird nie vorgelesen, auch später nicht
      s.spoken.add(answer.id);
    } else if (answer && !s.spoken.has(answer.id)) {
      s.spoken.add(answer.id);
      speak(answer);
      return;
    }
    // Schon vorgelesen (doppelt geliefert) oder entwertet: nie vorlesen
    if (answer) over = true;
    if ((over || synced) && !s.running) {
      s.pending = null;
      listen(SPEECH_MODE_TEXT.noAnswer);
    }
  }

  // --- Meldungen der Seite ------------------------------------------------------

  /** status-Ereignis des Gesprächs (oder Stand nach dem Senden einer getippten Nachricht) */
  function status(running, awaiting) {
    const was = s.running;
    s.running = !!running;
    if (s.phase === "thinking") {
      const asking = !!running && !!awaiting;
      if (asking !== s.asking) {
        s.asking = asking;
        notify();
      }
      if (!s.running) {
        evaluate(false);
        // Der Turn ist gerade zu Ende gegangen, ohne Antwort im bekannten Verlauf: erst abgleichen, dann entscheiden.
        // Nur beim Wechsel: ein Abgleich meldet seinen Stand auch hier und soll sich nicht selbst neu anstoßen
        if (was && s.phase === "thinking" && typeof deps.requestSync === "function") deps.requestSync();
      }
      return;
    }
    // Ein anderer Turn beginnt (etwa eine getippte Nachricht): warten statt hineinsprechen
    if (s.phase === "listening" && s.running) wait(SPEECH_MODE_TEXT.busyOther, { freeNote: false });
    else if (s.phase === "waiting" && !s.running) pollNow();
  }

  /**
   * Der Verlauf wurde erfolgreich abgeglichen; running ist der Stand danach.
   * mark ist der Wert von mark() beim Start dieses Abgleichs: Begann er vor
   * der Annahme der Äußerung, kennt er weder sie noch ihren Turn und darf
   * nicht als „keine Antwort" gelten.
   */
  function synced(running, mark) {
    s.running = !!running;
    if (s.phase === "thinking") evaluate(mark === undefined || mark === s.accepted);
    else if (s.phase === "listening" && s.running) wait(SPEECH_MODE_TEXT.busyOther, { freeNote: false });
    else if (s.phase === "waiting" && !s.running) pollNow();
  }

  function messagesChanged() {
    if (s.phase === "thinking") evaluate(false);
  }

  /** Fachlicher Fehler des Turns (error-Ereignis mit Daten). Ein Abriss der Live-Verbindung ist kein Turn-Fehler und kommt hier nicht an. */
  function turnError() {
    if (s.phase !== "thinking") return;
    evaluate(false);
    if (s.phase === "thinking" && typeof deps.requestSync === "function") deps.requestSync();
  }

  /** Jüngster Schritt aus der Statuszeile des Turns */
  function progress(text) {
    if (typeof text !== "string") return;
    if (s.phase === "understanding") {
      s.earlyStep = text;
      return;
    }
    if (s.phase !== "thinking") return;
    s.step = text;
    notify();
  }

  // --- Warten, bis das Gespräch frei ist -------------------------------------------

  function wait(note, options) {
    cancelTimer("idle");
    cancelTimer("slow");
    cancelTimer("nothing");
    s.phase = "waiting";
    s.note = note || "";
    s.pending = null;
    s.confirm = false;
    s.asking = false;
    s.voiceActive = false;
    s.level = 0;
    s.freeNote = !(options && options.freeNote === false);
    setMic(false);
    setVad(false);
    timer("busyLimit", SPEECH_BUSY_MAX_MS, () => {
      if (s.phase === "waiting") pause(SPEECH_MODE_TEXT.busyPaused);
    });
    notify();
    if (options && options.immediate) void poll();
    else schedulePoll();
  }

  function schedulePoll() {
    timer("poll", SPEECH_BUSY_POLL_MS, () => void poll());
  }

  function stopPoll() {
    s.pollSeq++;
    if (s.poll) s.poll.abort();
    s.poll = null;
  }

  function pollNow() {
    cancelTimer("poll");
    void poll();
  }

  /** GET …/speech: { busy }. Netzfehler und „noch beschäftigt" führen zum nächsten Versuch. */
  async function poll() {
    if (s.phase !== "waiting") return;
    stopPoll();
    const seq = s.pollSeq;
    const current = () => s.phase === "waiting" && s.pollSeq === seq;
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    s.poll = controller;
    let res;
    let data = null;
    try {
      res = await doFetch(conversationPath("/speech"), { method: "GET", credentials: "same-origin", signal: controller ? controller.signal : undefined });
      try {
        data = await res.json();
      } catch {
        data = null;
      }
    } catch {
      if (!current()) return;
      s.poll = null;
      schedulePoll();
      return;
    }
    if (!current()) return;
    s.poll = null;
    if (res.status === 401) {
      unauthorized();
      return;
    }
    if (res.status === 404) {
      fail(SPEECH_MODE_TEXT.gone);
      return;
    }
    if (res.status === 409 && data && data.closed === true) {
      const id = s.conversationId;
      const text = errorOf(data, SPEECH_MODE_TEXT.closed);
      fail(text);
      if (typeof deps.onClosed === "function") deps.onClosed(id, text);
      return;
    }
    if (res.status === 503) {
      fail(errorOf(data, SPEECH_MODE_TEXT.unavailable));
      return;
    }
    if (res.status === 200 && data && data.busy === false) {
      cancelTimer("busyLimit");
      s.running = false;
      listen(s.freeNote ? SPEECH_MODE_TEXT.free : "");
      return;
    }
    schedulePoll();
  }

  // --- Vorlesen -------------------------------------------------------------------

  /**
   * Ausgabe freischalten, im Tipp auf „Sprechen" und auf „Weiter" (iOS
   * verlangt eine Nutzeraktion): ein stummes Stück über speechSynthesis, und
   * für die Server-Stimme ein Audio-Element, das einmal kurze Stille spielt
   * und danach für alle Segmente wiederverwendet wird.
   */
  function unlockOutput() {
    try {
      const synth = win.speechSynthesis;
      if (synth && typeof win.SpeechSynthesisUtterance === "function") {
        synth.cancel();
        const silent = new win.SpeechSynthesisUtterance(" ");
        silent.volume = 0;
        silent.lang = "de-DE";
        synth.speak(silent);
      }
    } catch {
      // ohne Stimme: die Ausgabe meldet es später
    }
    if (s.tts !== "server" || typeof win.Audio !== "function") return;
    try {
      if (!s.audio) s.audio = new win.Audio();
      const audio = s.audio;
      const url = win.URL.createObjectURL(new win.Blob([speechWav(new Int16Array(1600))], { type: "audio/wav" }));
      s.urls.add(url);
      const done = () => revoke(url);
      audio.onended = done;
      audio.onerror = done;
      audio.src = url;
      const playing = audio.play();
      if (playing && typeof playing.catch === "function") playing.catch(done);
    } catch {
      // ohne Audio: die Ausgabe meldet es später
    }
  }

  function revoke(url) {
    if (!s.urls.has(url)) return;
    s.urls.delete(url);
    try {
      win.URL.revokeObjectURL(url);
    } catch {
      // schon freigegeben
    }
  }

  /** Ausgabe sofort aus: Stimme, Audio, laufende und vorgeladene Anfragen, Blob-URLs, Wächter */
  function stopOutput() {
    s.speak++;
    cancelTimer("guard");
    try {
      if (win.speechSynthesis) win.speechSynthesis.cancel();
    } catch {
      // keine Stimme
    }
    if (s.audio) {
      s.audio.onended = null;
      s.audio.onerror = null;
      try {
        s.audio.pause();
      } catch {
        // spielte nicht
      }
    }
    for (const controller of s.ttsAborts) controller.abort();
    s.ttsAborts.clear();
    for (const url of Array.from(s.urls)) revoke(url);
    s.queue = null;
    s.current = null;
    s.blocked = false;
    s.blockedPlay = null;
    s.bargeIn = false;
  }

  function speak(answer) {
    cancelTimer("slow");
    stopOutput();
    const token = s.speak;
    const segments = (Array.isArray(answer.speakSegments) ? answer.speakSegments : []).filter(t => typeof t === "string" && t.trim());
    const text = String(answer.speakable).trim();
    s.queue = { token, segments: segments.length ? segments : [text], loads: new Map() };
    s.phase = "speaking";
    s.pending = null;
    s.confirm = false;
    s.asking = false;
    s.slow = false;
    s.note = "";
    s.reply = [...text].length > SPEECH_REPLY_PREVIEW_CHARS ? [...text].slice(0, SPEECH_REPLY_PREVIEW_CHARS).join("") + " …" : text;
    // Über Lautsprecher bleibt das Mikrofon stumm. Nur mit der Kopfhörer-Einstellung läuft die Erkennung weiter, mit strengerem Sprechbeginn
    s.bargeIn = device().headphones === true;
    setMic(s.bargeIn);
    if (s.bargeIn) setVad(true, { strict: true });
    notify();
    if (s.tts === "server") void playServer(token, 0);
    else speakBrowser(token, 0);
  }

  function doneSpeaking(token, note) {
    if (token !== s.speak) return;
    stopOutput();
    listen(note || "");
  }

  /** Tipp (oder Leertaste) im Bereich */
  function tap() {
    if (s.phase === "speaking") {
      if (s.blocked && typeof s.blockedPlay === "function") {
        const play = s.blockedPlay;
        s.blocked = false;
        s.blockedPlay = null;
        s.note = "";
        notify();
        play();
        return;
      }
      stopOutput();
      listen("");
      return;
    }
    if (s.phase === "thinking" && !s.confirm) {
      s.confirm = true;
      notify();
    }
  }

  /** Antwort auf „Antwort abbrechen?" */
  function confirmStop(yes) {
    if (!s.confirm) return;
    s.confirm = false;
    if (yes && s.phase === "thinking") {
      s.note = SPEECH_MODE_TEXT.stopping;
      // Sofort entwerten, nicht erst beim Ende des Turns: eine Antwort, die den Abbruch überholt
      // (Ereignis oder Verlaufsabgleich), bleibt stumm, gleich ob POST …/stop ankommt
      if (s.pending) s.pending.silent = true;
      const session = s.session;
      Promise.resolve()
        .then(() => doFetch(conversationPath("/stop"), { method: "POST", credentials: "same-origin" }))
        .then(res => {
          if (res && res.status === 401 && s.session === session) unauthorized();
        })
        .catch(() => {});
    }
    notify();
  }

  function blockOutput(token, play) {
    if (token !== s.speak) return;
    s.blocked = true;
    s.blockedPlay = play;
    s.note = SPEECH_MODE_TEXT.blocked;
    notify();
  }

  /** Browser-Stimme: immer satzweise, ein SpeechSynthesisUtterance je Segment */
  function speakBrowser(token, index) {
    if (token !== s.speak || !s.queue) return;
    const segments = s.queue.segments;
    if (index >= segments.length) {
      doneSpeaking(token, "");
      return;
    }
    const synth = win.speechSynthesis;
    if (!synth || typeof win.SpeechSynthesisUtterance !== "function") {
      doneSpeaking(token, SPEECH_MODE_TEXT.ttsFailed);
      return;
    }
    const settings = device();
    const text = segments[index];
    let done = false;
    const next = event => {
      // Späte Meldung einer abgelösten Ausgabe (unterbrochen, aufgelegt): nichts anfassen, der Wächter gehört der neuen
      if (done || token !== s.speak) return;
      done = true;
      cancelTimer("guard");
      // Ohne Nutzeraktion blockiert: der nächste Tipp spielt dieses Segment
      if (event && event.error === "not-allowed") {
        blockOutput(token, () => speakBrowser(token, index));
        return;
      }
      speakBrowser(token, index + 1);
    };
    try {
      const utterance = new win.SpeechSynthesisUtterance(text);
      // Stimmen können spät geladen sein (voiceschanged): bei jedem Segment frisch lesen
      const voice = speechModeVoice(speechModeVoices(win), settings.voice);
      if (voice) utterance.voice = voice;
      utterance.lang = voice && /^de(?:[-_]|$)/i.test(String(voice.lang || "")) ? voice.lang : "de-DE";
      utterance.rate = settings.rate;
      utterance.onend = next;
      utterance.onerror = next;
      // Festhalten, sonst räumt mancher Browser das Objekt vor dem end-Ereignis weg
      s.current = utterance;
      // Wächter: kommt weder end noch error, abbrechen und zum nächsten Segment
      timer("guard", speechGuardMs(text, settings.rate), () => {
        if (done || token !== s.speak) return;
        done = true;
        try {
          synth.cancel();
        } catch {
          // keine Stimme
        }
        speakBrowser(token, index + 1);
      });
      synth.speak(utterance);
    } catch {
      next(null);
    }
  }

  /** Ein Segment vom Server holen; höchstens einmal je Segment */
  function loadSegment(queue, index) {
    if (index >= queue.segments.length) return null;
    if (queue.loads.has(index)) return queue.loads.get(index);
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    if (controller) s.ttsAborts.add(controller);
    const load = Promise.resolve()
      .then(() =>
        doFetch(SPEECH_TTS_PATH, {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: queue.segments[index] }),
          signal: controller ? controller.signal : undefined,
        })
      )
      .then(async res => {
        if (res.ok) return { ok: true, blob: await res.blob() };
        let data = null;
        try {
          data = await res.json();
        } catch {
          data = null;
        }
        return { ok: false, status: res.status, reason: data && typeof data.reason === "string" ? data.reason : "" };
      })
      .catch(() => ({ ok: false, status: 0, reason: "" }))
      .then(result => {
        if (controller) s.ttsAborts.delete(controller);
        return result;
      });
    queue.loads.set(index, load);
    return load;
  }

  /**
   * Server-Stimme: je Segment POST /api/speech/tts, Wiedergabe über das eine
   * Audio-Element mit blob:-Adresse. Während ein Segment läuft, wird genau
   * das nächste vorgeladen. Scheitert der Server, gibt es keinen stillen
   * Wechsel der Stimme; nur 409 browser (Einstellung inzwischen geändert)
   * führt mit der Browser-Stimme weiter.
   */
  async function playServer(token, index) {
    const queue = s.queue;
    if (token !== s.speak || !queue) return;
    if (index >= queue.segments.length) {
      doneSpeaking(token, "");
      return;
    }
    const audio = s.audio;
    if (!audio) {
      doneSpeaking(token, SPEECH_MODE_TEXT.ttsFailed);
      return;
    }
    const result = await loadSegment(queue, index);
    queue.loads.delete(index);
    if (token !== s.speak) return;
    if (!result.ok) {
      if (result.status === 401) {
        unauthorized();
        return;
      }
      if (result.status === 409 && result.reason === "browser") {
        for (const controller of s.ttsAborts) controller.abort();
        s.ttsAborts.clear();
        speakBrowser(token, index);
        return;
      }
      doneSpeaking(token, SPEECH_MODE_TEXT.ttsFailed);
      return;
    }
    let url;
    try {
      url = win.URL.createObjectURL(result.blob);
    } catch {
      doneSpeaking(token, SPEECH_MODE_TEXT.ttsFailed);
      return;
    }
    s.urls.add(url);
    audio.onended = () => {
      if (token !== s.speak) return;
      revoke(url);
      void playServer(token, index + 1);
    };
    audio.onerror = () => {
      if (token !== s.speak) return;
      revoke(url);
      doneSpeaking(token, SPEECH_MODE_TEXT.ttsFailed);
    };
    audio.src = url;
    try {
      audio.playbackRate = device().rate;
    } catch {
      // Tempo nicht einstellbar
    }
    // Höchstens ein Segment vorladen, während dieses läuft
    void loadSegment(queue, index + 1);
    const play = () => {
      if (token !== s.speak) return;
      let playing;
      try {
        playing = audio.play();
      } catch (err) {
        playing = Promise.reject(err);
      }
      Promise.resolve(playing).catch(err => {
        if (token !== s.speak) return;
        const name = err && typeof err.name === "string" ? err.name : "";
        // Blockierte Wiedergabe: der nächste Tipp spielt das Segment
        if (name === "NotAllowedError") blockOutput(token, play);
        else if (name !== "AbortError") {
          revoke(url);
          doneSpeaking(token, SPEECH_MODE_TEXT.ttsFailed);
        }
      });
    };
    play();
  }

  // --- Bildschirm wach halten -------------------------------------------------------

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
          // Späte Zusage nach Pause oder Auflegen: sofort wieder frei
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

  /** visibilitychange: der Browser gibt den Wake Lock im Hintergrund frei; zurück im Vordergrund neu holen, solange der Modus läuft */
  function visibility(visible) {
    if (visible && s.wakeWanted) acquireWake();
  }

  // --- Anzeige ----------------------------------------------------------------------

  const LABELS = {
    starting: SPEECH_MODE_TEXT.starting,
    listening: SPEECH_MODE_TEXT.listening,
    understanding: SPEECH_MODE_TEXT.understanding,
    nothing: SPEECH_MODE_TEXT.nothing,
    thinking: SPEECH_MODE_TEXT.thinking,
    speaking: SPEECH_MODE_TEXT.speaking,
    waiting: SPEECH_MODE_TEXT.waiting,
    paused: SPEECH_MODE_TEXT.paused,
    error: SPEECH_MODE_TEXT.error,
  };

  function view() {
    let note = s.note;
    if (s.phase === "thinking") {
      if (s.confirm) note = SPEECH_MODE_TEXT.confirmStop;
      else if (s.asking) note = SPEECH_MODE_TEXT.asking;
      else if (!note && s.slow) note = SPEECH_MODE_TEXT.slow;
    }
    return {
      phase: s.phase,
      active: s.phase !== "off",
      conversationId: s.conversationId,
      label: LABELS[s.phase] || "",
      note,
      heard: s.heard,
      reply: s.reply,
      step: s.phase === "thinking" ? s.step : "",
      level: s.level,
      voiceActive: s.voiceActive,
      /** Das Mikrofon ist offen und hört zu (stehender roter Punkt) */
      micOpen: s.phase === "listening" || (s.phase === "speaking" && s.bargeIn),
      confirm: s.phase === "thinking" && s.confirm,
      blocked: s.phase === "speaking" && s.blocked,
      canPause: ["starting", "listening", "understanding", "nothing", "thinking", "speaking", "waiting"].includes(s.phase),
      canResume: s.phase === "paused",
      ended: s.phase === "error",
    };
  }

  return {
    start,
    pause: () => pause(""),
    resume,
    hangUp,
    /** Fehler gelesen: Bereich schließen */
    close: hangUp,
    tap,
    confirmStop,
    status,
    synced,
    /** Vor einem Abgleich des Verlaufs lesen und an synced() zurückgeben */
    mark: () => s.accepted,
    messagesChanged,
    turnError,
    progress,
    visibility,
    view,
    active: () => s.phase !== "off",
    /** Der Modus hält das Mikrofon oder wartet auf eine Antwort (nicht: Fehler gezeigt) */
    engaged: () => s.phase !== "off" && s.phase !== "error",
    state: s,
  };
}

// ---------------------------------------------------------------------------
// Abschnitt „Sprechmodus auf diesem Gerät" im Reiter „Sprechen"
// ---------------------------------------------------------------------------

/** Segment-Steuerung wie „Bei /board dabei": choices [{ value, label }]; auch für den Telefonhörer (call.js) */
function speechSegment(h, labelId, prefix, choices, value, disabled, pick) {
  const group = h("div", { className: "theme-switch settings-switch", role: "radiogroup", "aria-labelledby": labelId });
  choices.forEach((c, index) => {
    const checked = c.value === value;
    const button = h("button", {
      type: "button",
      className: "theme-option",
      role: "radio",
      "aria-checked": checked ? "true" : "false",
      tabindex: checked ? "0" : "-1",
      "data-focus-key": prefix + ":" + c.value,
      disabled,
      text: c.label,
    });
    button.addEventListener("click", () => {
      if (c.value !== value) pick(c.value);
    });
    button.addEventListener("keydown", event => {
      let next = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = choices[(index + 1) % choices.length];
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = choices[(index + choices.length - 1) % choices.length];
      else if (event.key === "Home") next = choices[0];
      else if (event.key === "End") next = choices[choices.length - 1];
      else if (event.key === " ") next = c;
      if (!next) return;
      if (typeof event.preventDefault === "function") event.preventDefault();
      if (next.value !== value) pick(next.value);
    });
    group.appendChild(button);
  });
  return group;
}


/**
 * Einstellungen pro Gerät: Pause, Stimme, Tempo, Probe und das Unterbrechen
 * per Stimme mit Kopfhörer. Jede Änderung geht sofort in localStorage
 * (SPEECH_DEVICE_KEY) und nirgends sonst hin: dieser Baustein kennt keinen
 * Weg zum Server. deps: win (window), storage (localStorage oder null),
 * render() zum Neuzeichnen, h(tag, props, children) und
 * sectionNode(id, title, hints, children) aus settings.js, tts() liefert
 * "browser" oder "server" (wer gerade vorliest) oder null, solange der
 * Status nicht geladen ist.
 */
function createSpeechDeviceSettings(deps) {
  const win = deps.win;
  const storage = deps.storage;
  const state = { watching: false, writeFailed: false };

  function render() {
    if (typeof deps.render === "function") deps.render();
  }

  function canStore() {
    if (!storage || state.writeFailed) return false;
    try {
      storage.getItem(SPEECH_DEVICE_KEY);
      return true;
    } catch {
      return false;
    }
  }

  function save(patch) {
    const next = Object.assign(readSpeechDevice(storage), patch);
    if (!writeSpeechDevice(storage, next)) state.writeFailed = true;
    render();
  }

  function synth() {
    try {
      return win.speechSynthesis && typeof win.SpeechSynthesisUtterance === "function" ? win.speechSynthesis : null;
    } catch {
      return null;
    }
  }

  /** Beim Öffnen des Reiters: Stimmen können später eintreffen (voiceschanged) */
  function open() {
    const s = synth();
    if (state.watching || !s || typeof s.addEventListener !== "function") return;
    state.watching = true;
    s.addEventListener("voiceschanged", () => render());
  }

  /** „Probe": ein Satz mit der gewählten Stimme und dem gewählten Tempo */
  function probe() {
    const s = synth();
    if (!s) return;
    const device = readSpeechDevice(storage);
    try {
      s.cancel();
      const utterance = new win.SpeechSynthesisUtterance(SPEECH_PROBE_TEXT);
      const voice = speechModeVoice(speechModeVoices(win), device.voice);
      if (voice) utterance.voice = voice;
      utterance.lang = voice && /^de(?:[-_]|$)/i.test(String(voice.lang || "")) ? voice.lang : "de-DE";
      utterance.rate = device.rate;
      s.speak(utterance);
    } catch {
      // keine Stimme: der Hinweis im Abschnitt sagt es
    }
  }

  function voiceLabel(voice) {
    const name = typeof voice.name === "string" && voice.name ? voice.name : voice.voiceURI;
    return name + " (" + String(voice.lang || "?") + (voice.localService === true ? "" : ", online") + ")";
  }

  function nodes() {
    const h = deps.h;
    const device = readSpeechDevice(storage);
    const stored = canStore();
    const s = synth();
    const voices = speechModeVoices(win);
    const place = typeof deps.tts === "function" ? deps.tts() : null;
    const children = [];
    if (!stored) children.push(h("p", { className: "actions-hint", role: "status", "data-speech-device": "no-storage", text: SPEECH_MODE_TEXT.noStorage }));

    // Pause
    children.push(h("div", { className: "settings-field" }, [
      h("p", { className: "settings-label", id: "speech-device-pause", text: SPEECH_MODE_TEXT.pauseLabel }),
      h("div", { className: "settings-actions" }, [
        speechSegment(h, "speech-device-pause", "speech-device-pause", Object.keys(SPEECH_PAUSES).map(value => ({ value, label: SPEECH_PAUSE_LABELS[value] })), device.pause, !stored, value => save({ pause: value })),
      ]),
      h("p", { className: "actions-hint", text: SPEECH_MODE_TEXT.pauseHint }),
    ]));

    // Stimme
    const preset = speechModeVoice(voices, "");
    const chosen = device.voice && voices.list.some(v => v.voiceURI === device.voice) ? device.voice : "";
    const select = h("select", { id: "speech-device-voice", className: "settings-input", "data-focus-key": "speech-device:voice", "aria-describedby": "speech-device-voice-hint", disabled: !stored || !voices.list.length });
    const option = (value, label) => {
      const node = h("option", { value, text: label });
      if (value === chosen) {
        node.selected = true;
        node.setAttribute("selected", "");
      }
      select.appendChild(node);
    };
    option("", preset ? "Vorauswahl: " + voiceLabel(preset) : SPEECH_MODE_TEXT.voiceDefault);
    for (const voice of voices.list) option(voice.voiceURI, voiceLabel(voice));
    select.value = chosen;
    select.addEventListener("change", () => save({ voice: String(select.value || "") }));
    const voiceHints = [];
    if (!s) voiceHints.push(SPEECH_MODE_TEXT.noVoices);
    else if (!voices.list.length) voiceHints.push(SPEECH_MODE_TEXT.voicesLoading);
    else if (!voices.german) voiceHints.push(SPEECH_MODE_TEXT.noGerman);
    else voiceHints.push(SPEECH_MODE_TEXT.voiceHint);
    if (place === "server") voiceHints.push(SPEECH_MODE_TEXT.voiceServer);
    const probeButton = h("button", { type: "button", className: "quiet-button settings-speech-probe", "data-focus-key": "speech-device:probe", disabled: !s, text: SPEECH_MODE_TEXT.probe });
    probeButton.addEventListener("click", () => probe());
    children.push(h("div", { className: "settings-field" }, [
      h("label", { className: "settings-label", for: "speech-device-voice", text: SPEECH_MODE_TEXT.voiceLabel }),
      select,
      h("p", { className: "actions-hint", id: "speech-device-voice-hint", "data-speech-device": !s ? "no-synth" : !voices.list.length ? "no-voices" : voices.german ? "german" : "no-german", text: voiceHints.join(" ") }),
    ]));

    // Tempo und Probe
    const rate = h("select", { id: "speech-device-rate", className: "settings-input", "data-focus-key": "speech-device:rate", disabled: !stored });
    const rates = SPEECH_RATES.includes(device.rate) ? SPEECH_RATES : SPEECH_RATES.concat([device.rate]).sort((a, b) => a - b);
    for (const value of rates) {
      const node = h("option", { value: String(value), text: String(value).replace(".", ",") + "-fach" + (value === 1 ? " (normal)" : "") });
      if (value === device.rate) {
        node.selected = true;
        node.setAttribute("selected", "");
      }
      rate.appendChild(node);
    }
    rate.value = String(device.rate);
    rate.addEventListener("change", () => save({ rate: speechClampRate(rate.value) }));
    children.push(h("div", { className: "settings-field" }, [
      h("label", { className: "settings-label", for: "speech-device-rate", text: SPEECH_MODE_TEXT.rateLabel }),
      rate,
      h("div", { className: "settings-actions" }, [probeButton]),
    ]));

    // Kopfhörer
    children.push(h("div", { className: "settings-field" }, [
      h("p", { className: "settings-label", id: "speech-device-headphones", text: SPEECH_MODE_TEXT.headphonesLabel }),
      h("div", { className: "settings-actions" }, [
        speechSegment(h, "speech-device-headphones", "speech-device-headphones", [{ value: "on", label: "An" }, { value: "off", label: "Aus" }], device.headphones ? "on" : "off", !stored, value => save({ headphones: value === "on" })),
      ]),
      h("p", { className: "actions-hint", text: SPEECH_MODE_TEXT.headphonesHint }),
    ]));

    return [deps.sectionNode("speech-device", SPEECH_MODE_TEXT.deviceTitle, [SPEECH_MODE_TEXT.deviceIntro], children)];
  }

  return { nodes, open, probe, save };
}
