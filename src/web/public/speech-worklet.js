// Sprechmodus (Issue #250, Entscheidung 0023): Tonverarbeitung im AudioWorklet.
// Eigene Datei, weil die CSP (script-src 'self', worker-src 'self') kein
// Worklet aus einer blob:-Adresse zulässt. speech.js lädt sie mit
// audioWorklet.addModule("/speech-worklet.js").
//
// Der Weg eines Blocks: alle Kanäle zu Mono mischen, auf 16 kHz umrechnen
// (Tiefpass vor dem Ausdünnen, Phase läuft über die Blockgrenzen weiter),
// aus den 128er-Blöcken des Browsers 20-ms-Blöcke (320 Werte) bauen und je
// Block die Pausenerkennung fragen. Eine fertige Äußerung geht als PCM16
// mono 16 kHz an die Seite, die sie als WAV verpackt.
//
// Telefonhörer (Issue #258): mit processorOptions { mode: "call" } läuft
// statt dessen die Betriebsart „Gespräch" (createCallVad): Stücke von 20 ms
// gehen schon während des Sprechens an die Seite, die sie über den WebSocket
// schickt.
//
// Alles unterhalb von registerProcessor ist reine Rechnung ohne Browser und
// wird in tests/web-speech-worklet.test.ts mit künstlichen Signalen geprüft.
"use strict";

/** Zielrate, auch die der WAV-Datei */
const SPEECH_RATE = 16000;
/** Ein Auswerteblock: 20 ms bei 16 kHz */
const SPEECH_FRAME = 320;
const SPEECH_FRAME_MS = 20;
/** Ganze Äußerung samt Vorlauf und Endpause: höchstens 58 Sekunden (unter den 60 Sekunden und 2 MB des Servers) */
const SPEECH_MAX_SAMPLES = 928000;
/** Sprechbeginn: so lange über der Schwelle */
const SPEECH_START_MS = 150;
/** Strenger Sprechbeginn beim Unterbrechen per Stimme (Kopfhörer) */
const SPEECH_START_MAX_MS = 300;
/** Ende der Äußerung nach dieser Pause (pro Gerät einstellbar: 500, 800, 1.300) */
const SPEECH_PAUSE_MS = 800;
/** So viel vor dem Sprechbeginn geht mit, damit der Anfang nicht fehlt */
const SPEECH_PREROLL_MS = 300;
/** Weniger Sprechzeit gilt als Husten oder Klick und wird verworfen */
const SPEECH_MIN_SPEECH_MS = 300;
/** Von der Endpause gehen höchstens so viele Millisekunden mit */
const SPEECH_TAIL_MS = 200;

/** Über der Schwelle heißt: lauter als das Rauschen mal diesem Faktor, mindestens SPEECH_THRESHOLD_MIN (RMS, 1 = Vollaussteuerung) */
const SPEECH_THRESHOLD_FACTOR = 3;
const SPEECH_THRESHOLD_MIN = 0.008;
/** Grenzen der Rauschschätzung: nach oben, damit Sprache die Schwelle immer noch erreicht */
const SPEECH_NOISE_MIN = 0.0001;
const SPEECH_NOISE_MAX = 0.05;
/** Anteil, um den ein Block ohne Sprache die Rauschschätzung verschiebt */
const SPEECH_NOISE_ALPHA = 0.05;
/** Die ersten so vielen Blöcke ohne Sprache setzen die Rauschschätzung in einem Schritt (Kalibrierung) */
const SPEECH_CALIBRATION_FRAMES = 10;
/** Pegelmeldung an die Seite: alle 100 ms */
const SPEECH_LEVEL_FRAMES = 5;
/** Nulldurchgänge des Tiefpasses je Seite; mehr heißt steilere Flanke */
const SPEECH_RESAMPLE_ZEROS = 16;
/** Grenzfrequenz als Anteil der halben Zielrate: 7,2 kHz */
const SPEECH_RESAMPLE_CUTOFF = 0.9;
/** Bis zu so vielen Phasen liegen die Filterkerne fertig im Speicher */
const SPEECH_RESAMPLE_CACHE = 1024;

function speechGcd(a, b) {
  while (b) {
    const rest = a % b;
    a = b;
    b = rest;
  }
  return a;
}

/**
 * Rechnet Mono-Ton von inputRate auf 16 kHz um. push(samples, count, sink)
 * ruft sink(wert) für jeden neuen 16-kHz-Wert auf. Bei 16 kHz Eingang geht
 * alles unverändert durch.
 *
 * Sonst liegt jeder Ausgabewert an der Stelle n · inputRate / 16000 im
 * Eingang. Die Stelle wird als Bruch mitgeführt (Ganzzahl plus Zähler), nie
 * als Gleitkommazahl: so läuft die Phase bei 44,1 kHz (Schritt 441/160) über
 * beliebig viele Blöcke ohne Drift weiter. Der Wert entsteht aus einem
 * gefensterten Sinc um diese Stelle, dessen Grenzfrequenz unter der halben
 * Zielrate liegt: Tiefpass und Ausdünnen in einem Schritt.
 */
function createSpeechResampler(inputRate) {
  const rate = Math.max(1, Math.round(Number(inputRate) || SPEECH_RATE));
  if (rate === SPEECH_RATE) {
    return {
      rate,
      push(samples, count, sink) {
        for (let i = 0; i < count; i++) sink(samples[i]);
      },
    };
  }
  const divisor = speechGcd(rate, SPEECH_RATE);
  /** Schritt je Ausgabewert in Eingangswerten: step / phases */
  const step = rate / divisor;
  const phases = SPEECH_RATE / divisor;
  /** Grenzfrequenz in Schwingungen je Eingangswert */
  const cutoff = 0.5 * SPEECH_RESAMPLE_CUTOFF * Math.min(1, SPEECH_RATE / rate);
  const half = Math.ceil(SPEECH_RESAMPLE_ZEROS / (2 * cutoff));
  const taps = 2 * half;
  const cache = phases <= SPEECH_RESAMPLE_CACHE ? new Array(phases) : null;

  /** Filterkern für die Stelle „Ganzzahl + phase/phases": Blackman-gefensterter Sinc, Summe 1 */
  function kernel(phase) {
    if (cache && cache[phase]) return cache[phase];
    const k = new Float32Array(taps);
    const frac = phase / phases;
    let sum = 0;
    for (let i = 0; i < taps; i++) {
      // Abstand des Eingangswerts von der Ausgabestelle
      const x = i - (half - 1) - frac;
      const u = x / half;
      const window = Math.abs(u) >= 1 ? 0 : 0.42 + 0.5 * Math.cos(Math.PI * u) + 0.08 * Math.cos(2 * Math.PI * u);
      const angle = 2 * Math.PI * cutoff * x;
      k[i] = (x === 0 ? 1 : Math.sin(angle) / angle) * window;
      sum += k[i];
    }
    for (let i = 0; i < taps; i++) k[i] /= sum;
    if (cache) cache[phase] = k;
    return k;
  }

  // Eingang mit Vorgeschichte: vor dem ersten Wert liegt Stille
  let buffer = new Float32Array(taps + 4096);
  let length = half - 1;
  /** Ausgabestelle relativ zum Anfang von buffer: Index des ersten Filterwerts und Zähler der Phase */
  let first = 0;
  let phase = 0;

  return {
    rate,
    push(samples, count, sink) {
      if (length + count > buffer.length) {
        const grown = new Float32Array(Math.max(buffer.length * 2, length + count));
        grown.set(buffer.subarray(0, length));
        buffer = grown;
      }
      for (let i = 0; i < count; i++) buffer[length + i] = samples[i];
      length += count;
      while (first + taps <= length) {
        const k = kernel(phase);
        let value = 0;
        for (let i = 0; i < taps; i++) value += buffer[first + i] * k[i];
        sink(value);
        phase += step;
        first += Math.floor(phase / phases);
        phase %= phases;
      }
      // Verbrauchtes vorn abwerfen, die Vorgeschichte des nächsten Werts bleibt
      const drop = Math.min(first, length);
      if (drop > 0) {
        buffer.copyWithin(0, drop, length);
        length -= drop;
        first -= drop;
      }
    },
  };
}

/**
 * Pausenerkennung über 20-ms-Blöcke. frame(block) nimmt 320 Werte (Float,
 * -1 bis 1) und meldet über emit:
 *   { type: "start" }                       Sprechbeginn erkannt
 *   { type: "utterance", samples, limit }   fertige Äußerung als Int16Array
 *   { type: "dropped" }                     zu kurz (Husten, Klick), verworfen
 *   { type: "level", level, speaking }      Pegel für die Anzeige
 * Jede Meldung trägt die zuletzt gesetzte epoch, damit die Seite Meldungen
 * aus einem früheren Abschnitt verwerfen kann.
 *
 * Regeln: Energie (RMS) je Block gegen eine Schwelle aus der mitlaufenden
 * Rauschschätzung. Die Schätzung lernt ausschließlich aus Blöcken ohne
 * Sprache, also aus Blöcken unter der Schwelle. Ein Block über der Schwelle
 * verändert sie nie, auch nicht der leiseste einer langen Äußerung: sonst
 * zöge leise, anhaltende Sprache die Schwelle zu sich hoch und die Äußerung
 * endete mitten im Satz. Auch die Kalibrierung nach dem Öffnen nimmt nur
 * stille Blöcke; wer sofort spricht, wird mit der Anfangsschwelle erkannt.
 * Rauschen, das allmählich lauter wird, bleibt unter
 * der mitwachsenden Schwelle und wird gelernt. Ein Geräusch, das auf einen
 * Schlag über der Schwelle liegt, zählt dagegen als Sprache, bis es endet
 * oder die 58-Sekunden-Grenze die Äußerung schließt.
 * Solange active false ist (Verstehen, Denken, Warten), wird nichts
 * ausgewertet und nichts gelernt.
 */
function createSpeechVad(emit) {
  const framesOf = ms => Math.max(1, Math.ceil(ms / SPEECH_FRAME_MS));
  const prerollFrames = framesOf(SPEECH_PREROLL_MS);
  const maxStartFrames = framesOf(SPEECH_START_MAX_MS);
  const tailFrames = framesOf(SPEECH_TAIL_MS);
  const ringFrames = prerollFrames + maxStartFrames;
  const ring = new Int16Array(ringFrames * SPEECH_FRAME);
  const utterance = new Int16Array(SPEECH_MAX_SAMPLES);
  const pcm = new Int16Array(SPEECH_FRAME);

  let epoch = 0;
  let active = false;
  let startFrames = framesOf(SPEECH_START_MS);
  let pauseFrames = framesOf(SPEECH_PAUSE_MS);

  let noise = SPEECH_THRESHOLD_MIN / SPEECH_THRESHOLD_FACTOR;
  let calibration = 0;
  let calibrationMin = Infinity;

  /** Nächster Schreibplatz im Ring und Zahl der gültigen Blöcke */
  let ringAt = 0;
  let ringCount = 0;
  let inUtterance = false;
  let utteranceLength = 0;
  /** Blöcke über der Schwelle in Folge (vor dem Sprechbeginn) */
  let run = 0;
  /** Blöcke unter der Schwelle in Folge (in der Äußerung) */
  let silence = 0;
  /** Blöcke über der Schwelle in der Äußerung */
  let speechFrames = 0;
  let levelCount = 0;
  let levelPeak = 0;

  function resetUtterance() {
    inUtterance = false;
    utteranceLength = 0;
    run = 0;
    silence = 0;
    speechFrames = 0;
    ringAt = 0;
    ringCount = 0;
  }

  function clampNoise(value) {
    return Math.min(SPEECH_NOISE_MAX, Math.max(SPEECH_NOISE_MIN, value));
  }

  /** true, wenn der Block über der Schwelle liegt; führt die Rauschschätzung nach */
  function judge(rms) {
    const loud = rms > Math.max(SPEECH_THRESHOLD_MIN, noise * SPEECH_THRESHOLD_FACTOR);
    // Nur Blöcke ohne Sprache lernen; ein Block über der Schwelle lässt die Schätzung unberührt,
    // auch während der Kalibrierung: wer sofort spricht, wird gehört und hebt die Schwelle nicht an
    if (loud) return true;
    if (calibration < SPEECH_CALIBRATION_FRAMES) {
      // Die ersten stillen Blöcke setzen die Schätzung in einem Schritt, danach lernt sie langsam
      calibration++;
      calibrationMin = Math.min(calibrationMin, rms);
      if (calibration === SPEECH_CALIBRATION_FRAMES) noise = clampNoise(calibrationMin * 1.5);
      return false;
    }
    noise = clampNoise(noise + (rms - noise) * SPEECH_NOISE_ALPHA);
    return false;
  }

  function finish(limit) {
    let length = utteranceLength;
    // Von der Endpause gehen höchstens 200 ms mit
    if (silence > tailFrames) length -= (silence - tailFrames) * SPEECH_FRAME;
    const spokenMs = speechFrames * SPEECH_FRAME_MS;
    if (spokenMs >= SPEECH_MIN_SPEECH_MS && length > 0) {
      const samples = utterance.slice(0, length);
      emit({ type: "utterance", epoch, samples, limit: !!limit, spokenMs }, [samples.buffer]);
    } else {
      emit({ type: "dropped", epoch });
    }
    resetUtterance();
  }

  function frame(block) {
    if (!active) return;
    let sum = 0;
    for (let i = 0; i < SPEECH_FRAME; i++) {
      let s = block[i];
      // NaN und Unendlich (defekter Treiber) zählen als Stille
      if (!(s >= -1 && s <= 1)) s = s > 1 ? 1 : s < -1 ? -1 : 0;
      sum += s * s;
      pcm[i] = Math.round(s * 32767);
    }
    const rms = Math.sqrt(sum / SPEECH_FRAME);
    const loud = judge(rms);

    if (rms > levelPeak) levelPeak = rms;
    if (++levelCount >= SPEECH_LEVEL_FRAMES) {
      emit({ type: "level", epoch, level: levelPeak, speaking: inUtterance });
      levelCount = 0;
      levelPeak = 0;
    }

    if (!inUtterance) {
      ring.set(pcm, ringAt * SPEECH_FRAME);
      ringAt = (ringAt + 1) % ringFrames;
      if (ringCount < ringFrames) ringCount++;
      run = loud ? run + 1 : 0;
      if (run < startFrames) return;
      // Sprechbeginn: Vorlauf und die Blöcke des Anlaufs aus dem Ring übernehmen
      const take = Math.min(ringCount, prerollFrames + run);
      let from = (ringAt - take + ringFrames) % ringFrames;
      utteranceLength = 0;
      for (let i = 0; i < take; i++) {
        utterance.set(ring.subarray(from * SPEECH_FRAME, (from + 1) * SPEECH_FRAME), utteranceLength);
        utteranceLength += SPEECH_FRAME;
        from = (from + 1) % ringFrames;
      }
      inUtterance = true;
      speechFrames = run;
      silence = 0;
      run = 0;
      emit({ type: "start", epoch });
      return;
    }

    utterance.set(pcm, utteranceLength);
    utteranceLength += SPEECH_FRAME;
    if (loud) {
      speechFrames++;
      silence = 0;
    } else {
      silence++;
    }
    if (silence >= pauseFrames) finish(false);
    // Grenze beim Sprechen erreicht: hier schließen und senden
    else if (utteranceLength + SPEECH_FRAME > SPEECH_MAX_SAMPLES) finish(true);
  }

  /**
   * Einstellungen der Seite: epoch (Laufnummer des Abschnitts), active,
   * pauseMs, startMs. Wechselt active, beginnt die Erkennung frisch: eine
   * angefangene Äußerung und der Vorlauf sind weg, die Rauschschätzung bleibt.
   */
  function configure(message) {
    if (!message || typeof message !== "object") return;
    if (typeof message.epoch === "number") epoch = message.epoch;
    if (typeof message.pauseMs === "number" && message.pauseMs > 0) pauseFrames = framesOf(message.pauseMs);
    if (typeof message.startMs === "number" && message.startMs > 0) startFrames = Math.min(maxStartFrames, framesOf(message.startMs));
    if (typeof message.active === "boolean" && message.active !== active) {
      active = message.active;
      resetUtterance();
      levelCount = 0;
      levelPeak = 0;
    }
  }

  return { frame, configure, noise: () => noise, speaking: () => inUtterance };
}

// ---------------------------------------------------------------------------
// Betriebsart „Gespräch" (Telefonhörer, Issue #258)
// ---------------------------------------------------------------------------

/** Nach so viel Stille in der Äußerung meldet das Worklet „pause" (der Server erkennt schon vorab) */
const CALL_PAUSE_MARK_MS = 300;
/** Strenger Modus (Unterbrechen per Stimme, während tybo spricht): Schwelle mal diesem Faktor */
const CALL_STRICT_FACTOR = 2;

// Echo-Schutz (Issue #280): Der zweite Eingang des Worklets ist der Ton, den
// der Spieler gerade ausgibt. Das Worklet sucht diesen Ton (mit Verzögerung)
// im Mikrofon; was er erklärt, ist Echo. Nur der unerklärte Rest kann Sprache
// sein und muss über dem erwarteten Rest-Echo liegen.
/** So lange gilt ein Spitzenpegel der Wiedergabe: Weg Lautsprecher zu Mikrofon samt Puffern beider Seiten */
const CALL_ECHO_HOLD_MS = 300;
/** Danach klingt er so ab (Zeitkonstante): Nachhall im Raum */
const CALL_ECHO_RELEASE_MS = 250;
/** Darunter gilt die Wiedergabe als still: kein Echo-Schutz, nichts gelernt */
const CALL_ECHO_REF_MIN = 0.003;
/** Längste Verzögerung Wiedergabe bis Mikrofon, die der Abgleich sucht (Ausgabepuffer, Lautsprecher, Aufnahme) */
const CALL_ECHO_DELAY_MAX_MS = 500;
/** Grobsuche auf 4 kHz: je 4 Werte bei 16 kHz gemittelt; die beste Stelle wird danach auf 16 kHz verfeinert */
const CALL_ECHO_DECIMATE = 4;
/**
 * Reserve des Referenzrings: so weit darf die Wiedergabe dem Mikrofon
 * vorauslaufen (sie wird je Browser-Block vor dem Mikrofon verarbeitet,
 * und ein 20-ms-Block wird mitten im Browser-Block fertig)
 */
const CALL_ECHO_HEADROOM_MS = 50;
/** Feinsuche: so viele Nachbarn je Seite der besten Verzögerung gehen in die gemeinsame Anpassung (Echo zwischen zwei Werten) */
const CALL_ECHO_FIT_SPAN = 2;
/**
 * So viele Echo-Wege sucht der Abgleich je Block (Lautsprecher direkt, dazu
 * Reflexionen); ein weiterer zählt nur, wenn er vom Rest mindestens diesen
 * Anteil erklärt
 */
const CALL_ECHO_PATHS = 3;
const CALL_ECHO_PATH_SHARE = 0.5;
/** Der Rest muss so viel lauter sein als das erwartete Rest-Echo (Faktor 2, also 6 dB) */
const CALL_ECHO_MARGIN = 2;
/**
 * Kopplung: wie laut das Echo, das der Abgleich nicht erklärt (Nachhall,
 * Verzerrung), im Verhältnis zur Wiedergabe ist. Startwert und Grenzen
 */
const CALL_ECHO_COUPLING_START = 0.04;
const CALL_ECHO_COUPLING_MIN = 0.02;
const CALL_ECHO_COUPLING_MAX = 8;
/** Lernen je 20-ms-Block: nach oben schnell, nach unten langsam (rund eine Sekunde) */
const CALL_ECHO_LEARN_UP = 0.3;
const CALL_ECHO_LEARN_DOWN = 0.05;
/** Gelernt wird nur, solange die Wiedergabe mindestens so viel der Hüllkurve erreicht (nicht in Haltezeit und Ausklingen) */
const CALL_ECHO_LEARN_SHARE = 0.5;
/**
 * Nach oben gelernt wird nur aus Blöcken, deren Ton die Wiedergabe zu
 * mindestens diesem Anteil erklärt: dort ist nachweislich Echo, der Rest ist
 * dessen Nachhall. Ein Rest ohne erkennbares Echo kann Nutzersprache sein.
 */
const CALL_ECHO_LEARN_MATCH = 0.5;

/**
 * Pausenerkennung für den Telefonhörer. Wie createSpeechVad (Energie gegen
 * mitlaufende Rauschschwelle, 300 ms Vorlauf), aber die Äußerung geht
 * laufend in Stücken von 20 ms hinaus statt am Ende als Ganzes. Meldungen
 * über emit, jede mit der zuletzt gesetzten epoch:
 *   { type: "speechstart" }                 Sprache bestätigt (300 ms Sprechzeit); danach kommen Stücke
 *   { type: "chunk", samples }              20 ms PCM16 mono 16 kHz (Int16Array, 320 Werte)
 *   { type: "pause" }                       300 ms Stille in der Äußerung
 *   { type: "speechend", limit }            eingestellte Pause erreicht (oder 58-Sekunden-Grenze)
 *   { type: "dropped" }                     unter 300 ms Sprechzeit: nichts ging hinaus
 *   { type: "level", level, speaking }      Pegel für die Anzeige
 *
 * Regeln:
 * - Bis 300 ms Sprechzeit bestätigt sind, bleibt alles im Gerät (Vorlauf und
 *   Anlauf im Puffer). Eine Kurzäußerung (Husten, Klick) verlässt das Gerät
 *   nie, weil sich schon Gesendetes nicht zurücknehmen ließe.
 * - Bei Stille ohne Äußerung geht nichts hinaus. In der Äußerung gehen Vorlauf
 *   und innere Sprechpausen bis 300 ms mit; ab der Meldung „pause" werden
 *   stille Blöcke zurückgehalten (sonst wäre die vorgezogene Erkennung des
 *   Servers veraltet). Spricht der Nutzer weiter, gehen die zurückgehaltenen
 *   Blöcke vor dem nächsten hinaus; endet die Äußerung, fallen sie weg.
 * - Alles Gesendete einer Äußerung (samt Vorlauf) bleibt unter 58 Sekunden,
 *   unter der 60-Sekunden-Grenze des Servers.
 * - strict (während tybo spricht): doppelte Schwelle, Sprechbeginn erst nach
 *   300 ms durchgehender Sprache, und die Rauschschätzung lernt nicht (das
 *   Echo der eigenen Stimme soll die Schwelle nicht verschieben).
 * - Echo-Schutz (Issue #280): reference(rms, ms) bekommt den Pegel der
 *   eigenen Wiedergabe, referenceSample(wert) ihren Ton auf 16 kHz, Wert für
 *   Wert im Gleichschritt mit dem Mikrofon. Die Hüllkurve hält jede Spitze
 *   300 ms und klingt dann ab. Solange sie läuft, sucht der Abgleich den Ton
 *   der Wiedergabe der letzten 500 ms im Block des Mikrofons (normierte
 *   Kreuzkorrelation grob auf 4 kHz, dann fein auf 16 kHz samt gemeinsamer
 *   Anpassung der Nachbarverzögerungen, damit auch ein Echo zwischen zwei
 *   Werten ganz erklärt wird; bis zu drei Echo-Wege, jeder weitere im Rest
 *   des vorigen gesucht). Der Anteil, den er erklärt, ist Echo und
 *   fällt weg; laut ist ein Block nur, wenn der Rest über der Grundschwelle
 *   und über dem Doppelten des erwarteten Rest-Echos (Hüllkurve mal
 *   Kopplung) liegt. Nutzersprache passt nicht zur Wiedergabe und bleibt so
 *   von Anfang an hörbar, auch ohne Lernpause.
 * - Die Kopplung startet so niedrig, dass die Grundschwelle gilt, und lernt
 *   nur aus Blöcken, die nicht laut sind, außerhalb einer Äußerung, während
 *   die Wiedergabe läuft: nach oben sofort, aber nur, wenn der Abgleich im
 *   Block mindestens die Hälfte als Echo erklärt (ein Rest ohne erkennbares
 *   Echo kann leise Nutzersprache sein); nach unten erst, wenn die
 *   Wiedergabe länger als die größte gesuchte Verzögerung durchgehend läuft
 *   (vorher kann ihr Echo noch unterwegs sein). raiseEcho() verdoppelt sie nach einem Fehlalarm und
 *   lässt sie nicht mehr darunter sinken. Die Stellung wird nie durch config
 *   zurückgesetzt, nur der Laufzähler einer Äußerung, wie bisher.
 */
function createCallVad(emit) {
  const framesOf = ms => Math.max(1, Math.ceil(ms / SPEECH_FRAME_MS));
  const prerollFrames = framesOf(SPEECH_PREROLL_MS);
  const maxStartFrames = framesOf(SPEECH_START_MAX_MS);
  const minSpeechFrames = framesOf(SPEECH_MIN_SPEECH_MS);
  const pauseMarkFrames = framesOf(CALL_PAUSE_MARK_MS);
  const ringFrames = prerollFrames + maxStartFrames;
  const ring = new Int16Array(ringFrames * SPEECH_FRAME);
  const pcm = new Int16Array(SPEECH_FRAME);

  let epoch = 0;
  let active = false;
  let strict = false;
  let startFrames = framesOf(SPEECH_START_MS);
  let pauseFrames = framesOf(SPEECH_PAUSE_MS);

  let noise = SPEECH_THRESHOLD_MIN / SPEECH_THRESHOLD_FACTOR;
  let calibration = 0;
  let calibrationMin = Infinity;

  let ringAt = 0;
  let ringCount = 0;
  let inUtterance = false;
  /** Sprechzeit bestätigt, Stücke gehen hinaus */
  let confirmed = false;
  /** Vor der Bestätigung: Vorlauf und Anlauf als Blöcke (je Int16Array) */
  let pending = [];
  /** Nach „pause": zurückgehaltene stille Blöcke */
  let held = [];
  let pauseSent = false;
  let sent = 0;
  let run = 0;
  let silence = 0;
  let speechFrames = 0;
  let levelCount = 0;
  let levelPeak = 0;
  /** Hüllkurve der eigenen Wiedergabe, restliche Haltezeit in ms, gelernte Kopplung */
  let echoLevel = 0;
  let echoHold = 0;
  /** Letzter Pegel der Wiedergabe: gelernt wird nur, solange sie wirklich läuft (nicht im Ausklingen) */
  let echoNow = 0;
  let coupling = CALL_ECHO_COUPLING_START;
  /** Untergrenze der Kopplung, steigt mit jedem Fehlalarm (raiseEcho) */
  let couplingFloor = CALL_ECHO_COUPLING_MIN;
  /** So lange läuft die Wiedergabe schon ohne Unterbrechung (ms) */
  let echoRun = 0;
  /** Zuletzt erklärter Anteil (Quadrat der besten Korrelation), für Tests */
  let lastMatch = 0;

  // Ton der Wiedergabe in zwei Ringen, je doppelt abgelegt (jedes Fenster liegt am Stück):
  // auf 4 kHz für die Grobsuche, auf 16 kHz für die Feinsuche
  const lowFrame = SPEECH_FRAME / CALL_ECHO_DECIMATE;
  const maxLag = Math.round((CALL_ECHO_DELAY_MAX_MS * SPEECH_RATE) / 1000 / CALL_ECHO_DECIMATE);
  const headroom = Math.ceil((CALL_ECHO_HEADROOM_MS * SPEECH_RATE) / 1000 / CALL_ECHO_DECIMATE);
  // Eine Stelle mehr als maxLag, damit die Feinsuche auch genau 500 ms erreicht
  const refSize = maxLag + 1 + lowFrame + headroom;
  const refRing = new Float32Array(2 * refSize);
  const fineSize = refSize * CALL_ECHO_DECIMATE;
  const fineRing = new Float32Array(2 * fineSize);
  /** Werte auf 4 kHz bisher: Wiedergabe und Mikrofon (gleicher Takt, gleicher Anfang) */
  let refCount = 0;
  let micCount = 0;
  /** Werte der Wiedergabe auf 16 kHz bisher */
  let fineCount = 0;
  let refSum = 0;
  let refParts = 0;
  const micLow = new Float32Array(lowFrame);
  /** Der letzte Mikrofon-Block auf 16 kHz (für die Feinsuche) */
  const micFine = new Float32Array(SPEECH_FRAME);

  function resetUtterance() {
    inUtterance = false;
    confirmed = false;
    pending = [];
    held = [];
    pauseSent = false;
    sent = 0;
    run = 0;
    silence = 0;
    speechFrames = 0;
    ringAt = 0;
    ringCount = 0;
  }

  function clampNoise(value) {
    return Math.min(SPEECH_NOISE_MAX, Math.max(SPEECH_NOISE_MIN, value));
  }

  function clampCoupling(value) {
    return Math.min(CALL_ECHO_COUPLING_MAX, Math.max(couplingFloor, value));
  }

  /** Pegel der eigenen Wiedergabe für ms Millisekunden (ein Block des Browsers) */
  function reference(rms, ms) {
    const level = rms > 0 && Number.isFinite(rms) ? rms : 0;
    const span = ms > 0 && Number.isFinite(ms) ? ms : 0;
    echoNow = level;
    echoRun = level >= CALL_ECHO_REF_MIN ? echoRun + span : 0;
    if (level >= echoLevel) {
      echoLevel = level;
      echoHold = CALL_ECHO_HOLD_MS;
      return;
    }
    if (echoHold > 0) {
      echoHold -= span;
      return;
    }
    echoLevel = Math.max(level, echoLevel * Math.exp(-span / CALL_ECHO_RELEASE_MS));
    if (echoLevel < CALL_ECHO_REF_MIN / 10) echoLevel = 0;
  }

  /** Läuft die eigene Wiedergabe (oder ihr Nachhall)? */
  function echoing() {
    return echoLevel >= CALL_ECHO_REF_MIN;
  }

  /** Ein Wert der Wiedergabe auf 16 kHz; je vier ergeben einen Wert im Ring */
  function referenceSample(value) {
    const v = value > -2 && value < 2 ? value : 0;
    const fineAt = fineCount % fineSize;
    fineRing[fineAt] = fineRing[fineAt + fineSize] = v;
    fineCount++;
    refSum += v;
    if (++refParts < CALL_ECHO_DECIMATE) return;
    const at = refCount % refSize;
    refRing[at] = refRing[at + refSize] = refSum / CALL_ECHO_DECIMATE;
    refCount++;
    refSum = 0;
    refParts = 0;
  }

  /** Grobsuche, Feinsuche und Anpassung arbeiten auf dem Rest nach den schon gefundenen Wegen */
  const restFine = new Float32Array(SPEECH_FRAME);
  const restLow = new Float32Array(lowFrame);
  const pathColumns = CALL_ECHO_PATHS * (2 * CALL_ECHO_FIT_SPAN + 1);
  /** Verzögerungen (16 kHz) aller gefundenen Wege samt Nachbarn */
  const fitLags = new Int32Array(pathColumns);
  const fitGram = new Float64Array(pathColumns * pathColumns);
  const fitCross = new Float64Array(pathColumns);
  const fitStarts = new Int32Array(pathColumns);

  /**
   * Wie viel des Mikrofon-Blocks (die letzten 20 ms) die Wiedergabe erklärt,
   * zwischen 0 und 1. Je Echo-Weg (Lautsprecher direkt, Wand, Tisch): Grobsuche
   * mit dem größten Quadrat der normierten Kreuzkorrelation auf 4 kHz über
   * alle Verzögerungen bis 500 ms (Raster 0,25 ms), Feinsuche um die beste
   * Stelle auf 16 kHz (Raster 1/16 ms), dann gemeinsame Anpassung aller
   * bisher gefundenen Wege samt Nachbarverzögerungen (ein Echo zwischen zwei
   * Rasterpunkten wird sonst nur zum Teil erklärt). Der nächste Weg wird im
   * Rest gesucht und zählt nur, wenn er davon mindestens CALL_ECHO_PATH_SHARE
   * erklärt: ein weiteres Echo passt fast ganz, zufällige Ähnlichkeit mit
   * Nutzersprache nicht.
   */
  function match() {
    const n = SPEECH_FRAME;
    let em = 0;
    for (let i = 0; i < n; i++) em += micFine[i] * micFine[i];
    if (em < 1e-12) return 0;
    const micEnd = micCount * CALL_ECHO_DECIMATE;
    // Gültige Verzögerungen auf 16 kHz: das Fenster muss ganz im Ring liegen
    const lagMinAll = Math.max(0, micEnd - fineCount);
    const lagMaxAll = Math.min((maxLag + 1) * CALL_ECHO_DECIMATE, micEnd - n - (fineCount - fineSize));
    if (lagMaxAll < lagMinAll) return 0;
    restFine.set(micFine);
    restLow.set(micLow);
    let restEnergy = em;
    let explained = 0;
    let lags = 0;
    for (let path = 0; path < CALL_ECHO_PATHS; path++) {
      const coarse = search(restLow);
      if (coarse < 0) break;
      const center = refine(coarse * CALL_ECHO_DECIMATE, lagMinAll, lagMaxAll, micEnd);
      if (center < 0) break;
      const before = lags;
      for (let lag = Math.max(lagMinAll, center - CALL_ECHO_FIT_SPAN); lag <= Math.min(lagMaxAll, center + CALL_ECHO_FIT_SPAN); lag++) {
        let known = false;
        for (let a = 0; a < before; a++) if (fitLags[a] === lag) known = true;
        if (!known) fitLags[lags++] = lag;
      }
      if (lags === before) break;
      const total = fit(lags, micEnd, path + 1 < CALL_ECHO_PATHS);
      // Ein weiterer Weg muss einen deutlichen Teil des Rests erklären
      if (path > 0 && total - explained < CALL_ECHO_PATH_SHARE * restEnergy) break;
      explained = Math.max(explained, total);
      restEnergy = Math.max(0, em - explained);
      if (restEnergy < em * 1e-3 || path + 1 === CALL_ECHO_PATHS) break;
      // Rest für den nächsten Weg (fit hat ihn in restFine geschrieben), dazu auf 4 kHz
      for (let i = 0; i < lowFrame; i++) {
        let part = 0;
        for (let k = 0; k < CALL_ECHO_DECIMATE; k++) part += restFine[i * CALL_ECHO_DECIMATE + k];
        restLow[i] = part / CALL_ECHO_DECIMATE;
      }
    }
    return Math.min(1, explained / em);
  }

  /** Grobsuche auf 4 kHz: Verzögerung (in Werten zu 4 kHz) mit dem größten Quadrat der normierten Kreuzkorrelation, -1 ohne */
  function search(low) {
    const n = lowFrame;
    let em = 0;
    for (let i = 0; i < n; i++) em += low[i] * low[i];
    if (em < 1e-12) return -1;
    // Fenster der Wiedergabe für Verzögerung d: Werte micCount - n - d bis micCount - 1 - d
    const dMin = Math.max(0, micCount - refCount);
    const dMax = Math.min(maxLag + 1, micCount - n - (refCount - refSize));
    if (dMax < dMin) return -1;
    let start = (((micCount - n - dMin) % refSize) + refSize) % refSize;
    let er = 0;
    for (let i = 0; i < n; i++) er += refRing[start + i] * refRing[start + i];
    let best = 0;
    let bestLag = -1;
    for (let d = dMin; ; ) {
      if (er > em * 1e-6) {
        let num = 0;
        for (let i = 0; i < n; i++) num += low[i] * refRing[start + i];
        const share = (num * num) / (em * er);
        if (share > best) {
          best = share;
          bestLag = d;
        }
      }
      if (++d > dMax) break;
      // Ein Wert früher: der letzte fällt heraus, davor kommt einer dazu
      const last = refRing[start + n - 1];
      start = start === 0 ? refSize - 1 : start - 1;
      const first = refRing[start];
      er = Math.max(0, er - last * last + first * first);
    }
    return bestLag;
  }

  /** Feinsuche auf 16 kHz: Verzögerung um center mit dem größten Quadrat der normierten Kreuzkorrelation zum Rest, -1 ohne */
  function refine(center, lagMinAll, lagMaxAll, micEnd) {
    const n = SPEECH_FRAME;
    let em = 0;
    for (let i = 0; i < n; i++) em += restFine[i] * restFine[i];
    if (em < 1e-12) return -1;
    const lagMin = Math.max(lagMinAll, center - CALL_ECHO_DECIMATE);
    const lagMax = Math.min(lagMaxAll, center + CALL_ECHO_DECIMATE);
    let best = 0;
    let bestLag = -1;
    for (let lag = lagMin; lag <= lagMax; lag++) {
      const start = (((micEnd - n - lag) % fineSize) + fineSize) % fineSize;
      let er = 0;
      let num = 0;
      for (let i = 0; i < n; i++) {
        const r = fineRing[start + i];
        er += r * r;
        num += restFine[i] * r;
      }
      if (er <= em * 1e-6) continue;
      const share = (num * num) / (em * er);
      if (share > best) {
        best = share;
        bestLag = lag;
      }
    }
    return bestLag;
  }

  /**
   * Energie des Mikrofon-Blocks, die die Wiedergabe mit den ersten count
   * Verzögerungen aus fitLags zusammen erklärt (kleinste Quadrate). Mit
   * withRest steht danach in restFine, was übrig bleibt.
   */
  function fit(count, micEnd, withRest) {
    const n = SPEECH_FRAME;
    for (let a = 0; a < count; a++) fitStarts[a] = (((micEnd - n - fitLags[a]) % fineSize) + fineSize) % fineSize;
    let trace = 0;
    for (let a = 0; a < count; a++) {
      let cross = 0;
      for (let i = 0; i < n; i++) cross += micFine[i] * fineRing[fitStarts[a] + i];
      fitCross[a] = cross;
      for (let b = a; b < count; b++) {
        let g = 0;
        for (let i = 0; i < n; i++) g += fineRing[fitStarts[a] + i] * fineRing[fitStarts[b] + i];
        fitGram[a * count + b] = fitGram[b * count + a] = g;
      }
      trace += fitGram[a * count + a];
    }
    if (trace <= 0) return 0;
    // Leicht gedämpft, damit fast gleiche Nachbarn das Gleichungssystem nicht kippen
    for (let a = 0; a < count; a++) fitGram[a * count + a] += trace * 1e-6;
    // Cholesky-Zerlegung, dann Energie der Projektion als |L⁻¹ c|²
    for (let a = 0; a < count; a++) {
      for (let b = 0; b <= a; b++) {
        let s = fitGram[a * count + b];
        for (let k = 0; k < b; k++) s -= fitGram[a * count + k] * fitGram[b * count + k];
        if (a === b) {
          if (s <= 0) return 0;
          fitGram[a * count + a] = Math.sqrt(s);
        } else {
          fitGram[a * count + b] = s / fitGram[b * count + b];
        }
      }
    }
    let explained = 0;
    for (let a = 0; a < count; a++) {
      let s = fitCross[a];
      for (let k = 0; k < a; k++) s -= fitGram[a * count + k] * fitCross[k];
      fitCross[a] = s / fitGram[a * count + a];
      explained += fitCross[a] * fitCross[a];
    }
    if (withRest) {
      // Rückwärts einsetzen (Lᵀ x = y) für die Gewichte, dann Rest = Mikrofon minus Projektion
      for (let a = count - 1; a >= 0; a--) {
        let s = fitCross[a];
        for (let k = a + 1; k < count; k++) s -= fitGram[k * count + a] * fitCross[k];
        fitCross[a] = s / fitGram[a * count + a];
      }
      restFine.set(micFine);
      for (let a = 0; a < count; a++) {
        const w = fitCross[a];
        const start = fitStarts[a];
        for (let i = 0; i < n; i++) restFine[i] -= w * fineRing[start + i];
      }
    }
    return explained;
  }

  function judge(rms) {
    const factor = strict ? CALL_STRICT_FACTOR : 1;
    const base = factor * Math.max(SPEECH_THRESHOLD_MIN, noise * SPEECH_THRESHOLD_FACTOR);
    const echo = echoing();
    // Was die Wiedergabe erklärt, ist Echo: nur der Rest kann Sprache sein
    lastMatch = echo ? match() : 0;
    const rest = rms * Math.sqrt(1 - lastMatch);
    const loud = rest > Math.max(base, echo ? CALL_ECHO_MARGIN * coupling * echoLevel : 0);
    if (echo && !loud && !inUtterance && echoNow >= echoLevel * CALL_ECHO_LEARN_SHARE) {
      // Rest neben nachweislichem Echo ist Rest-Echo: daraus die Kopplung nach oben lernen.
      // Ein Rest ohne erkennbares Echo (leise Nutzersprache) hebt sie nie an.
      // Nach unten erst, wenn ein Echo der laufenden Wiedergabe schon da sein müsste
      const ratio = rest / echoLevel;
      if (ratio > coupling) {
        if (lastMatch >= CALL_ECHO_LEARN_MATCH) coupling = clampCoupling(coupling + (ratio - coupling) * CALL_ECHO_LEARN_UP);
      }
      else if (echoRun >= CALL_ECHO_DELAY_MAX_MS) coupling = clampCoupling(coupling + (ratio - coupling) * CALL_ECHO_LEARN_DOWN);
    }
    // Mit Echo lernt auch die Rauschschätzung nicht (sie soll das Zimmer messen, nicht die Wiedergabe)
    if (loud || strict || echo) return loud;
    if (calibration < SPEECH_CALIBRATION_FRAMES) {
      calibration++;
      calibrationMin = Math.min(calibrationMin, rms);
      if (calibration === SPEECH_CALIBRATION_FRAMES) noise = clampNoise(calibrationMin * 1.5);
      return false;
    }
    noise = clampNoise(noise + (rms - noise) * SPEECH_NOISE_ALPHA);
    return false;
  }

  /** Ein Block geht hinaus; false, wenn die 58-Sekunden-Grenze die Äußerung geschlossen hat */
  function send(block) {
    if (sent + SPEECH_FRAME > SPEECH_MAX_SAMPLES) {
      emit({ type: "speechend", epoch, limit: true });
      resetUtterance();
      return false;
    }
    const samples = block.slice(0);
    sent += SPEECH_FRAME;
    emit({ type: "chunk", epoch, samples }, [samples.buffer]);
    return true;
  }

  function confirm() {
    confirmed = true;
    emit({ type: "speechstart", epoch });
    const list = pending;
    pending = [];
    for (const block of list) if (!send(block)) return;
  }

  function frame(block) {
    // Der Mikrofon-Block auf 4 kHz für den Abgleich, auch inaktiv (sonst liefe er der Wiedergabe davon)
    for (let i = 0; i < lowFrame; i++) {
      let part = 0;
      for (let k = 0; k < CALL_ECHO_DECIMATE; k++) part += block[i * CALL_ECHO_DECIMATE + k];
      micLow[i] = part / CALL_ECHO_DECIMATE;
    }
    micFine.set(block);
    micCount += lowFrame;
    if (!active) return;
    let sum = 0;
    for (let i = 0; i < SPEECH_FRAME; i++) {
      let s = block[i];
      if (!(s >= -1 && s <= 1)) s = s > 1 ? 1 : s < -1 ? -1 : 0;
      sum += s * s;
      pcm[i] = Math.round(s * 32767);
    }
    const rms = Math.sqrt(sum / SPEECH_FRAME);
    const loud = judge(rms);

    if (rms > levelPeak) levelPeak = rms;
    if (++levelCount >= SPEECH_LEVEL_FRAMES) {
      emit({ type: "level", epoch, level: levelPeak, speaking: confirmed });
      levelCount = 0;
      levelPeak = 0;
    }

    if (!inUtterance) {
      ring.set(pcm, ringAt * SPEECH_FRAME);
      ringAt = (ringAt + 1) % ringFrames;
      if (ringCount < ringFrames) ringCount++;
      run = loud ? run + 1 : 0;
      if (run < startFrames) return;
      // Sprechbeginn: Vorlauf und Anlauf aus dem Ring, noch nichts senden
      const take = Math.min(ringCount, prerollFrames + run);
      let from = (ringAt - take + ringFrames) % ringFrames;
      pending = [];
      for (let i = 0; i < take; i++) {
        pending.push(ring.slice(from * SPEECH_FRAME, (from + 1) * SPEECH_FRAME));
        from = (from + 1) % ringFrames;
      }
      inUtterance = true;
      speechFrames = run;
      silence = 0;
      run = 0;
      if (speechFrames >= minSpeechFrames) confirm();
      return;
    }

    if (loud) {
      speechFrames++;
      silence = 0;
    } else {
      silence++;
    }

    if (!confirmed) {
      pending.push(pcm.slice(0));
      if (speechFrames >= minSpeechFrames) confirm();
      else if (silence >= pauseFrames) {
        // Zu kurz: nichts ging hinaus
        emit({ type: "dropped", epoch });
        resetUtterance();
      }
      return;
    }

    if (loud) {
      // Weiter gesprochen nach der Pause: Zurückgehaltenes zuerst
      const list = held;
      held = [];
      pauseSent = false;
      for (const b of list) if (!send(b)) return;
      send(pcm);
      return;
    }
    if (silence < pauseMarkFrames) {
      send(pcm);
      return;
    }
    if (!pauseSent) {
      pauseSent = true;
      emit({ type: "pause", epoch });
    }
    if (silence >= pauseFrames) {
      emit({ type: "speechend", epoch, limit: false });
      resetUtterance();
      return;
    }
    held.push(pcm.slice(0));
  }

  /**
   * Einstellungen der Seite: epoch, active, pauseMs, startMs, strict, keep,
   * reset. Wechselt active oder strict (ohne keep) oder ist reset gesetzt,
   * beginnt die Erkennung frisch: eine angefangene Äußerung (auch eine
   * bestätigte) ist weg.
   */
  function configure(message) {
    if (!message || typeof message !== "object") return;
    if (typeof message.epoch === "number") epoch = message.epoch;
    if (typeof message.pauseMs === "number" && message.pauseMs > 0) pauseFrames = Math.max(pauseMarkFrames + 1, framesOf(message.pauseMs));
    if (typeof message.startMs === "number" && message.startMs > 0) startFrames = Math.min(maxStartFrames, framesOf(message.startMs));
    const nextStrict = typeof message.strict === "boolean" ? message.strict : strict;
    const nextActive = typeof message.active === "boolean" ? message.active : active;
    // keep: nur die Schwelle wechselt, eine laufende Äußerung bleibt (Unterbrechen per Stimme)
    const fresh = message.reset === true || nextActive !== active || (nextStrict !== strict && message.keep !== true);
    active = nextActive;
    strict = nextStrict;
    if (fresh) {
      resetUtterance();
      levelCount = 0;
      levelPeak = 0;
    }
  }

  /**
   * Fehlalarm durch das eigene Echo (meldet die Seite): Kopplung verdoppeln
   * und nicht mehr darunter lernen, bis zum Auflegen
   */
  function raiseEcho() {
    couplingFloor = Math.min(CALL_ECHO_COUPLING_MAX, Math.max(couplingFloor * 2, coupling * 2));
    coupling = clampCoupling(coupling);
  }

  return { frame, configure, reference, referenceSample, raiseEcho, noise: () => noise, speaking: () => confirmed, coupling: () => coupling, echoLevel: () => echoLevel, match: () => lastMatch };
}

/**
 * Vom Block des Browsers bis zur Pausenerkennung. process(channels) nimmt
 * die Kanäle eines Eingangs (je ein Float32Array gleicher Länge, üblich 128
 * Werte), configure(message) reicht Einstellungen an die Erkennung weiter.
 * Im Telefonhörer kommt als zweites Argument der zweite Eingang dazu (der
 * Ton des Spielers, Issue #280); vor jedem Block gehen sein Pegel an
 * reference() und sein Ton, mit einem eigenen Umrechner auf 16 kHz, Wert für
 * Wert an referenceSample(). Fehlt der Eingang, zählt er als Stille, damit
 * Wiedergabe und Mikrofon im Gleichschritt bleiben.
 * options: sampleRate (Rate des AudioContext), emit(message, transfer),
 * mode ("call" für den Telefonhörer, sonst Sprechmodus) und für Tests
 * onFrame(block), das jeden 20-ms-Block sieht.
 */
function createSpeechPipeline(options) {
  const resampler = createSpeechResampler(options.sampleRate);
  const vad = options.mode === "call" ? createCallVad(options.emit) : createSpeechVad(options.emit);
  const onFrame = typeof options.onFrame === "function" ? options.onFrame : null;
  const block = new Float32Array(SPEECH_FRAME);
  let filled = 0;
  let mono = new Float32Array(128);

  function sink(value) {
    block[filled++] = value;
    if (filled < SPEECH_FRAME) return;
    filled = 0;
    if (onFrame) onFrame(block);
    vad.frame(block);
  }

  const refResampler = typeof vad.referenceSample === "function" ? createSpeechResampler(options.sampleRate) : null;
  const refSink = value => vad.referenceSample(value);
  let refMono = new Float32Array(128);

  /** Zweiter Eingang (eigene Wiedergabe, Issue #280) an die Erkennung, vor den Blöcken des Mikrofons */
  function feedReference(reference, length) {
    if (!refResampler) return;
    if (refMono.length < length) refMono = new Float32Array(length);
    refMono.fill(0, 0, length);
    let channels = 0;
    for (const channel of reference || []) {
      if (!channel || !channel.length) continue;
      channels++;
      const n = Math.min(length, channel.length);
      for (let i = 0; i < n; i++) refMono[i] += channel[i];
    }
    if (channels > 1) for (let i = 0; i < length; i++) refMono[i] /= channels;
    let sum = 0;
    for (let i = 0; i < length; i++) sum += refMono[i] * refMono[i];
    vad.reference(Math.sqrt(sum / length), (length * 1000) / options.sampleRate);
    refResampler.push(refMono, length, refSink);
  }

  function process(channels, reference) {
    const count = channels ? channels.length : 0;
    if (!count || !channels[0]) return;
    const length = channels[0].length;
    if (!length) return;
    feedReference(reference, length);
    if (mono.length < length) mono = new Float32Array(length);
    if (count === 1) {
      mono.set(channels[0]);
    } else {
      // Alle Kanäle zu Mono: der Mittelwert
      for (let i = 0; i < length; i++) {
        let sum = 0;
        for (let c = 0; c < count; c++) sum += channels[c][i];
        mono[i] = sum / count;
      }
    }
    resampler.push(mono, length, sink);
  }

  return { process, configure: vad.configure, raiseEcho: () => vad.raiseEcho && vad.raiseEcho(), vad };
}

if (typeof registerProcessor === "function" && typeof AudioWorkletProcessor === "function") {
  registerProcessor(
    "speech-vad",
    class extends AudioWorkletProcessor {
      constructor(options) {
        super();
        this.closed = false;
        const mode = options && options.processorOptions && options.processorOptions.mode === "call" ? "call" : "speech";
        // sampleRate ist im Worklet die Rate des AudioContext (üblich 44,1 oder 48 kHz)
        this.pipeline = createSpeechPipeline({
          sampleRate,
          mode,
          emit: (message, transfer) => this.port.postMessage(message, transfer || []),
        });
        this.port.onmessage = event => {
          const data = event.data;
          if (!data) return;
          if (data.type === "close") this.closed = true;
          else if (data.type === "config") this.pipeline.configure(data);
          else if (data.type === "echo") this.pipeline.raiseEcho();
        };
      }

      process(inputs) {
        if (this.closed) return false;
        this.pipeline.process(inputs[0], inputs[1]);
        return true;
      }
    }
  );
}
