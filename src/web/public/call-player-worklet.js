// Telefonhörer (Issue #258): Wiedergabe der Stimme aus dem Server im
// AudioWorklet. Eigene Datei, weil die CSP (script-src 'self', worker-src
// 'self') kein Worklet aus einer blob:-Adresse zulässt. call.js lädt sie mit
// audioWorklet.addModule("/call-player-worklet.js").
//
// Der Server schickt PCM16 LE mono in seiner Rate (ready.sampleRate, heute
// 24 kHz), Abschnitt für Abschnitt zwischen audio_begin und audio_end. Die
// Seite reicht jedes Stück hierher; der Spieler rechnet es linear auf die
// Rate des AudioContext um, legt es in einen Ringpuffer und spielt, sobald
// 60 ms bereitliegen (oder ein Abschnitt vollständig da ist). Er meldet den
// Beginn jedes Abschnitts (für die Satzanzeige) und sein Ende erst, wenn der
// letzte Wert wirklich ausgegeben ist (für played an den Server). flush()
// leert alles sofort: danach ist es still, und Meldungen tragen die neue
// Laufnummer, damit die Seite späte Meldungen verwerfen kann.
//
// Alles unterhalb von registerProcessor ist reine Rechnung ohne Browser und
// wird in tests/web-call-worklets.test.ts mit künstlichen Signalen geprüft.
"use strict";

/** Startpuffer: so viel muss bereitliegen, bevor nach Stille wieder gespielt wird */
const CALL_PLAYER_START_MS = 60;

/**
 * Spieler mit Ringpuffer. options: outputRate (Rate des AudioContext),
 * emit(message). Befehle:
 *   begin(id)                 ab hier Ton zu Abschnitt id
 *   audio(samples, inputRate) PCM16 (Int16Array) des laufenden Abschnitts
 *   end(id)                   Abschnitt id ist vollständig
 *   flush(epoch)              sofort still, alles verworfen, neue Laufnummer
 *   restart(id)               noch nicht gespielten Ton von id verwerfen, id
 *                             kommt von vorn (Rückfall der Stimme, Issue #276)
 *   drop(id)                  wie restart, aber id endet hier ohne played
 *                             (den Abschnitt spricht die Browser-Stimme)
 *   render(out)               füllt out (Float32Array) mit den nächsten Werten
 * Meldungen: { type: "begin", id, epoch } beim ersten ausgegebenen Wert eines
 * Abschnitts, { type: "played", id, epoch } nach dem letzten.
 */
function createCallPlayer(options) {
  const outputRate = Math.max(1, Math.round(Number(options.outputRate) || 48000));
  const emit = options.emit;
  const startSamples = Math.ceil((outputRate * CALL_PLAYER_START_MS) / 1000);

  let buffer = new Float32Array(outputRate * 4);
  /** Absolute Zähler: geschrieben und gelesen (nie zurückgesetzt, nur beim Leeren gleichgezogen) */
  let written = 0;
  let read = 0;
  let playing = false;
  let epoch = 0;
  /** Abschnitte in Reihenfolge: { id, start, end (null bis end()), begun } */
  let marks = [];
  /** Umrechnung des laufenden Abschnitts: Stelle im Eingang und letzter Wert davor */
  let pos = 0;
  let prev = 0;

  function capacity() {
    return buffer.length;
  }

  function write(value) {
    if (written - read >= capacity()) {
      // Voll: verdoppeln, Reihenfolge bleibt
      const grown = new Float32Array(capacity() * 2);
      for (let i = read; i < written; i++) grown[i % grown.length] = buffer[i % capacity()];
      buffer = grown;
    }
    buffer[written % capacity()] = value;
    written++;
  }

  function begin(id) {
    marks.push({ id, start: written, end: null, begun: false });
    pos = 0;
    prev = 0;
  }

  /** Linear von inputRate auf outputRate; die Stelle läuft über die Stücke weiter */
  function audio(samples, inputRate) {
    if (!marks.length || marks[marks.length - 1].end !== null) return;
    const n = samples ? samples.length : 0;
    if (!n) return;
    const rate = Math.max(1, Number(inputRate) || outputRate);
    if (rate === outputRate) {
      for (let i = 0; i < n; i++) write(samples[i] / 32768);
      return;
    }
    const step = rate / outputRate;
    // pos ist die Stelle im Eingang; -1 meint den letzten Wert des vorigen Stücks
    while (pos < n - 1) {
      const index = Math.floor(pos);
      const frac = pos - index;
      const a = index < 0 ? prev : samples[index];
      const b = samples[index + 1];
      write((a + (b - a) * frac) / 32768);
      pos += step;
    }
    pos -= n;
    prev = samples[n - 1];
  }

  function end(id) {
    const mark = marks.find(m => m.id === id && m.end === null);
    if (mark) mark.end = written;
  }

  /** Ungespielten Ton des laufenden Abschnitts id verwerfen; Gespieltes bleibt gespielt */
  function cut(id, remove) {
    const index = marks.findIndex(m => m.id === id && m.end === null);
    if (index < 0) return;
    written = Math.max(read, marks[index].start);
    if (remove) marks.splice(index, 1);
    pos = 0;
    prev = 0;
  }

  function restart(id) {
    cut(id, false);
  }

  function drop(id) {
    cut(id, true);
  }

  function flush(nextEpoch) {
    epoch = typeof nextEpoch === "number" ? nextEpoch : epoch + 1;
    read = written;
    marks = [];
    playing = false;
    pos = 0;
    prev = 0;
  }

  /** Meldet Beginn und Ende der Abschnitte bis zur Lesestelle */
  function report() {
    while (marks.length) {
      const mark = marks[0];
      if (!mark.begun && read > mark.start) {
        mark.begun = true;
        emit({ type: "begin", id: mark.id, epoch });
      }
      if (mark.end === null || read < mark.end) return;
      if (!mark.begun) {
        mark.begun = true;
        emit({ type: "begin", id: mark.id, epoch });
      }
      marks.shift();
      emit({ type: "played", id: mark.id, epoch });
    }
  }

  function render(out) {
    const length = out.length;
    if (!playing) {
      const available = written - read;
      const complete = marks.some(m => m.end !== null && m.end <= written);
      if (available >= startSamples || (complete && available > 0)) playing = true;
    }
    let i = 0;
    if (playing) {
      for (; i < length && read < written; i++, read++) out[i] = buffer[read % capacity()];
      // Leer gelaufen: bis zum nächsten Startpuffer still
      if (read >= written) playing = false;
    }
    for (; i < length; i++) out[i] = 0;
    report();
  }

  return {
    begin,
    audio,
    end,
    restart,
    drop,
    flush,
    render,
    buffered: () => written - read,
    playing: () => playing,
    epoch: () => epoch,
    marks: () => marks.map(m => m.id),
  };
}

if (typeof registerProcessor === "function" && typeof AudioWorkletProcessor === "function") {
  registerProcessor(
    "call-player",
    class extends AudioWorkletProcessor {
      constructor() {
        super();
        this.closed = false;
        // sampleRate ist im Worklet die Rate des AudioContext
        this.player = createCallPlayer({ outputRate: sampleRate, emit: message => this.port.postMessage(message) });
        this.port.onmessage = event => {
          const data = event.data;
          if (!data) return;
          if (data.type === "close") this.closed = true;
          else if (data.type === "begin") this.player.begin(data.id);
          else if (data.type === "audio") this.player.audio(new Int16Array(data.buffer), data.rate);
          else if (data.type === "end") this.player.end(data.id);
          else if (data.type === "flush") this.player.flush(data.epoch);
          else if (data.type === "restart") this.player.restart(data.id);
          else if (data.type === "drop") this.player.drop(data.id);
        };
      }

      process(_inputs, outputs) {
        if (this.closed) return false;
        const output = outputs[0];
        if (!output || !output.length) return true;
        this.player.render(output[0]);
        // Weitere Kanäle (Stereo-Ausgang) bekommen dasselbe
        for (let c = 1; c < output.length; c++) output[c].set(output[0]);
        return true;
      }
    }
  );
}
