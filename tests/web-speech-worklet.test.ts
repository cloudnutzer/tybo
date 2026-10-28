/**
 * Issue #250, Checkbox 1: Tonverarbeitung des Sprechmodus
 * (src/web/public/speech-worklet.js) und WAV-Verpackung (speech.js) ohne
 * Browser, mit künstlichen Signalen in 128er-Blöcken wie im AudioWorklet.
 * Die erzeugte WAV geht durch prepareSpeechAudio, also durch dieselbe
 * Prüfung wie POST /api/conversations/<id>/speech.
 */
import { describe, expect, test } from "bun:test";
import { prepareSpeechAudio } from "../src/web/audio-duration";
import { detectMedia } from "../src/web/media-check";
import { MAX_SPEECH_BYTES, MAX_SPEECH_SECONDS } from "../src/web/speech";
import { concat, feed, frequency, loadWorklet, mix, noise, rms, silence, speechHarness, speechLike, SPEECH_SOURCE, tone } from "./speech-mode-fixture";

const worklet = loadWorklet();
const { speechWav, SPEECH_WAV_MAX_SAMPLES } = new Function(SPEECH_SOURCE + "\nreturn { speechWav, SPEECH_WAV_MAX_SAMPLES };")();

interface Emitted {
  type: string;
  epoch: number;
  samples?: Int16Array;
  limit?: boolean;
  level?: number;
  speaking?: boolean;
  spokenMs?: number;
}

/** Pipeline mit eingeschalteter Erkennung; events ohne die Pegelmeldungen */
function pipeline(sampleRate: number, config: Record<string, unknown> = {}) {
  const all: Emitted[] = [];
  const frames: Float32Array[] = [];
  const p = worklet.createSpeechPipeline({
    sampleRate,
    emit: (message: Emitted) => all.push(message),
    onFrame: (block: Float32Array) => frames.push(block.slice()),
  });
  p.configure({ type: "config", epoch: 1, active: true, ...config });
  return {
    p,
    frames,
    all,
    get events() {
      return all.filter(e => e.type !== "level");
    },
    get utterances() {
      return all.filter(e => e.type === "utterance");
    },
  };
}

/** Prüft die WAV wie der Server und gibt Dauer und Bytes zurück */
function checkedWav(samples: Int16Array) {
  const wav: Uint8Array = speechWav(samples);
  const media = detectMedia(wav);
  expect(media).toMatchObject({ kind: "audio", mime: "audio/wav" });
  const prepared = prepareSpeechAudio(wav, "audio/wav");
  expect(prepared).not.toBeNull();
  expect(prepared!.seconds).toBeLessThanOrEqual(58);
  expect(prepared!.seconds).toBeLessThan(MAX_SPEECH_SECONDS);
  expect(wav.byteLength).toBeLessThan(MAX_SPEECH_BYTES);
  return { wav, seconds: prepared!.seconds };
}

describe("Pausenerkennung", () => {
  test("reine Stille sendet nie etwas", () => {
    const run = pipeline(48000);
    feed(run.p, [silence(48000, 10)]);
    expect(run.events).toEqual([]);
    // Auch leises Rauschen ist keine Sprache
    const quiet = pipeline(48000);
    feed(quiet.p, [noise(48000, 10, 0.002)]);
    expect(quiet.events).toEqual([]);
  });

  test("Sprache und danach 800 ms Stille ergeben genau eine Äußerung mit Vorlauf und höchstens 200 ms Endpause", () => {
    const run = pipeline(48000);
    // 1,4 Sekunden: das Signal endet mit einer lauten Silbe, die Pause beginnt also genau hier
    feed(run.p, [concat(silence(48000, 1), speechLike(48000, 1.4))]);
    // Noch in der Äußerung: Beginn gemeldet, nichts gesendet
    expect(run.events.map(e => e.type)).toEqual(["start"]);
    feed(run.p, [silence(48000, 0.7)]);
    expect(run.utterances).toHaveLength(0);
    feed(run.p, [silence(48000, 0.3)]);
    expect(run.events.map(e => e.type)).toEqual(["start", "utterance"]);
    // Weitere Stille sendet nichts mehr
    feed(run.p, [silence(48000, 3)]);
    expect(run.events.map(e => e.type)).toEqual(["start", "utterance"]);

    const utterance = run.utterances[0]!;
    expect(utterance.samples).toBeInstanceOf(Int16Array);
    expect(utterance.limit).toBe(false);
    expect(utterance.epoch).toBe(1);
    // 300 ms Vorlauf + 1,4 s Sprache + höchstens 200 ms Endpause, auf wenige Blöcke genau
    const seconds = utterance.samples!.length / 16000;
    expect(seconds).toBeGreaterThan(1.8);
    expect(seconds).toBeLessThan(1.96);
    // Der Vorlauf ist Stille, danach beginnt die Sprache: der Anfang fehlt nicht
    expect(rms(utterance.samples!, 0, 3200)).toBeLessThan(40);
    expect(rms(utterance.samples!, 4800, 12800)).toBeGreaterThan(1000);
    // Das Ende ist die kurze Endpause
    expect(rms(utterance.samples!, utterance.samples!.length - 1600)).toBeLessThan(40);

    const { wav, seconds: counted } = checkedWav(utterance.samples!);
    expect(counted).toBeCloseTo(seconds, 5);
    // PCM16, mono, 16 kHz
    const view = new DataView(wav.buffer);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(wav.byteLength).toBe(44 + utterance.samples!.length * 2);
  });

  test("die Pause ist einstellbar: kurz 500 ms, lang 1.300 ms", () => {
    const short = pipeline(16000, { pauseMs: 500 });
    feed(short.p, [concat(silence(16000, 0.5), speechLike(16000, 1.4), silence(16000, 0.4))]);
    expect(short.utterances).toHaveLength(0);
    feed(short.p, [silence(16000, 0.15)]);
    expect(short.utterances).toHaveLength(1);

    const long = pipeline(16000, { pauseMs: 1300 });
    feed(long.p, [concat(silence(16000, 0.5), speechLike(16000, 1.4), silence(16000, 1.2))]);
    expect(long.utterances).toHaveLength(0);
    feed(long.p, [silence(16000, 0.2)]);
    expect(long.utterances).toHaveLength(1);
    // Auch nach langer Pause gehen höchstens 200 ms davon mit
    expect(long.utterances[0]!.samples!.length / 16000).toBeLessThan(1.96);
  });

  test("ein Klick von 200 ms wird verworfen, ebenso ein Knacken von 60 ms", () => {
    const run = pipeline(48000);
    feed(run.p, [concat(silence(48000, 1), tone(48000, 0.2, 300, 0.6), silence(48000, 2))]);
    expect(run.events.map(e => e.type)).toEqual(["start", "dropped"]);
    expect(run.utterances).toHaveLength(0);

    const crack = pipeline(48000);
    feed(crack.p, [concat(silence(48000, 1), tone(48000, 0.06, 300, 0.9), silence(48000, 2))]);
    expect(crack.events).toEqual([]);
  });

  test("lange Sprache wird an der 58-Sekunden-Grenze geschlossen und gesendet; keine WAV ist länger", () => {
    const run = pipeline(48000);
    feed(run.p, [concat(silence(48000, 0.5), speechLike(48000, 70))]);
    const first = run.utterances[0]!;
    expect(first.limit).toBe(true);
    // Vorlauf und Sprache zusammen: genau an der Grenze, nie darüber
    expect(first.samples!.length).toBe(worklet.SPEECH_MAX_SAMPLES);
    expect(first.samples!.length).toBe(SPEECH_WAV_MAX_SAMPLES);
    expect(checkedWav(first.samples!).seconds).toBe(58);
    // Alles, was danach noch entsteht, bleibt ebenfalls unter der Grenze
    feed(run.p, [silence(48000, 2)]);
    for (const u of run.utterances) checkedWav(u.samples!);
  });

  test("speechWav schneidet bei 58 Sekunden ab, auch wenn mehr geliefert wird", () => {
    const tooLong = new Int16Array(16000 * 61);
    const wav: Uint8Array = speechWav(tooLong);
    expect(wav.byteLength).toBe(44 + 928000 * 2);
    expect(prepareSpeechAudio(wav, "audio/wav")!.seconds).toBe(58);
    // Leer bleibt eine gültige, leere WAV
    expect(speechWav(new Int16Array(0)).byteLength).toBe(44);
  });

  test("die Rauschschwelle passt sich an: allmählich lauteres Dauerrauschen wird nicht zur Äußerung, Sprache darüber wird erkannt", () => {
    const run = pipeline(48000);
    const hum = (seconds: number, amplitude: number, seed: number) => noise(48000, seconds, amplitude, seed);
    // Erst still, dann wird ein Geräusch in Stufen lauter. Jede Stufe liegt unter der Schwelle, die mit der Schätzung wächst
    // (Spitze 0,012, 0,03 und 0,08 sind nach dem Tiefpass rund 0,004, 0,0095 und 0,025 RMS)
    feed(run.p, [concat(silence(48000, 2), hum(6, 0.012, 7))]);
    expect(run.p.vad.noise()).toBeGreaterThan(0.003);
    feed(run.p, [hum(6, 0.03, 8)]);
    expect(run.p.vad.noise()).toBeGreaterThan(0.008);
    feed(run.p, [hum(6, 0.08, 9)]);
    expect(run.p.vad.noise()).toBeGreaterThan(0.02);
    expect(run.events).toEqual([]);
    expect(run.p.vad.speaking()).toBe(false);

    // Sprache über dem Rauschen: eine Äußerung, die mit der Pause endet
    feed(run.p, [mix(speechLike(48000, 2, 0.9), hum(2, 0.08, 10))]);
    feed(run.p, [hum(1.5, 0.08, 11)]);
    expect(run.utterances).toHaveLength(1);
    const spoken = run.utterances[0]!;
    expect(spoken.samples!.length / 16000).toBeGreaterThan(2);
    expect(spoken.samples!.length / 16000).toBeLessThan(2.8);

    // Wird es wieder still, sinkt die Schätzung
    feed(run.p, [silence(48000, 3)]);
    expect(run.p.vad.noise()).toBeLessThan(0.005);
  });

  test("leise, anhaltende Sprache ohne Lücken bleibt eine Äußerung bis zur Pause und hebt die Rauschschätzung nicht an", () => {
    // Dauerton: 20 Sekunden 300 Hz mit Amplitude 0,06, kein Block fällt unter die Schwelle
    const steady = pipeline(16000);
    feed(steady.p, [noise(16000, 1, 0.002)]);
    const quiet = steady.p.vad.noise();
    feed(steady.p, [tone(16000, 20, 300, 0.06)]);
    expect(steady.events.map(e => e.type)).toEqual(["start"]);
    expect(steady.p.vad.speaking()).toBe(true);
    // Kein Block über der Schwelle hat die Schätzung verändert
    expect(steady.p.vad.noise()).toBe(quiet);
    feed(steady.p, [silence(16000, 1)]);
    expect(steady.events.map(e => e.type)).toEqual(["start", "utterance"]);
    const whole = steady.utterances[0]!;
    expect(whole.limit).toBe(false);
    expect(whole.spokenMs).toBeGreaterThanOrEqual(19_900);
    // 300 ms Vorlauf + 20 s + höchstens 200 ms Endpause
    expect(whole.samples!.length / 16000).toBeGreaterThan(20.2);
    expect(whole.samples!.length / 16000).toBeLessThan(20.6);

    // Pausenarm: die Lautstärke schwankt wie Silben, fällt aber nie unter die Schwelle
    const flowing = pipeline(48000);
    const signal = tone(48000, 12, 220, 0.08);
    for (let i = 0; i < signal.length; i++) signal[i] *= 0.75 + 0.25 * Math.sin((2 * Math.PI * 3 * i) / 48000);
    feed(flowing.p, [concat(silence(48000, 1), signal)]);
    expect(flowing.events.map(e => e.type)).toEqual(["start"]);
    expect(flowing.p.vad.noise()).toBeLessThan(0.001);
    feed(flowing.p, [silence(48000, 1)]);
    expect(flowing.utterances).toHaveLength(1);
    expect(flowing.utterances[0]!.spokenMs).toBeGreaterThanOrEqual(11_900);
    expect(flowing.utterances[0]!.samples!.length / 16000).toBeGreaterThan(12.2);
  });

  test("ein Geräusch, das auf einen Schlag über der Schwelle liegt, zählt als Sprache und wird nicht gelernt", () => {
    const run = pipeline(48000);
    feed(run.p, [concat(silence(48000, 2), noise(48000, 5, 0.03, 7))]);
    expect(run.events.map(e => e.type)).toEqual(["start"]);
    expect(run.p.vad.speaking()).toBe(true);
    expect(run.p.vad.noise()).toBeLessThan(0.001);
    // Endet es, schließt die Pause die Äußerung wie jede andere
    feed(run.p, [silence(48000, 1)]);
    expect(run.events.map(e => e.type)).toEqual(["start", "utterance"]);
  });

  test("Sprache hebt die Rauschschätzung nicht an", () => {
    const run = pipeline(16000);
    feed(run.p, [noise(16000, 2, 0.002)]);
    const quiet = run.p.vad.noise();
    feed(run.p, [speechLike(16000, 8, 0.6)]);
    expect(run.p.vad.speaking()).toBe(true);
    expect(run.p.vad.noise()).toBeLessThan(quiet * 4);
    expect(run.p.vad.noise()).toBeLessThan(0.005);
  });

  test("ausgeschaltet wird nichts ausgewertet und nichts gelernt; eine angefangene Äußerung ist weg", () => {
    const run = pipeline(16000);
    feed(run.p, [concat(noise(16000, 1, 0.002), speechLike(16000, 1))]);
    expect(run.events.map(e => e.type)).toEqual(["start"]);
    const learned = run.p.vad.noise();
    run.p.configure({ type: "config", epoch: 2, active: false });
    feed(run.p, [concat(speechLike(16000, 2), noise(16000, 3, 0.04), silence(16000, 2))]);
    expect(run.all.filter(e => e.epoch === 2)).toEqual([]);
    expect(run.p.vad.noise()).toBe(learned);
    // Wieder an: frisch, mit neuer Laufnummer
    run.p.configure({ type: "config", epoch: 3, active: true });
    feed(run.p, [concat(silence(16000, 0.5), speechLike(16000, 1), silence(16000, 1))]);
    expect(run.events.map(e => [e.type, e.epoch])).toEqual([["start", 1], ["start", 3], ["utterance", 3]]);
  });

  test("strenger Sprechbeginn (300 ms) für das Unterbrechen per Stimme", () => {
    const burst = () => concat(silence(16000, 0.5), tone(16000, 0.22, 300, 0.6), silence(16000, 1.5));
    const normal = pipeline(16000);
    feed(normal.p, [burst()]);
    expect(normal.events.map(e => e.type)).toEqual(["start", "dropped"]);
    const strict = pipeline(16000, { startMs: 300 });
    feed(strict.p, [burst()]);
    expect(strict.events).toEqual([]);
    // Echte Sprache kommt auch streng durch, samt Vorlauf
    feed(strict.p, [concat(tone(16000, 1, 300, 0.6), silence(16000, 1))]);
    expect(strict.events.map(e => e.type)).toEqual(["start", "utterance"]);
    expect(strict.utterances[0]!.samples!.length / 16000).toBeGreaterThan(1.4);
  });

  test("Pegelmeldungen kommen alle 100 ms und sagen, ob gerade gesprochen wird", () => {
    const run = pipeline(16000);
    feed(run.p, [concat(silence(16000, 1), tone(16000, 1, 300, 0.5))]);
    const levels = run.all.filter(e => e.type === "level");
    expect(levels.length).toBe(20);
    expect(levels[2]!.level).toBeLessThan(0.001);
    expect(levels[19]!.level).toBeGreaterThan(0.3);
    expect(levels[19]!.speaking).toBe(true);
    expect(levels[2]!.speaking).toBe(false);
  });
});

/**
 * Echtes Worklet an der Zustandsmaschine: speech.js öffnet das Mikrofon, die
 * Einstellungen an den Worklet-Knoten gehen an die echte Pipeline, deren
 * Meldungen zurück an speech.js. Gezählt werden die Uploads.
 */
async function uploadsFor(sampleRate: number, signal: Float32Array) {
  const h = speechHarness();
  await h.start();
  const node = h.node();
  const real = worklet.createSpeechPipeline({
    sampleRate,
    emit: (message: Emitted) => node.port.onmessage?.({ data: message }),
  });
  for (const message of node.port.posted) if (message.type === "config") real.configure(message);
  const post = node.port.postMessage.bind(node.port);
  node.port.postMessage = (message: any) => {
    post(message);
    if (message.type === "config") real.configure(message);
  };
  feed(real, [signal]);
  await h.flush();
  return h;
}

describe("Kalibrierung beim Öffnen des Mikrofons", () => {
  const word = (rate: number, seconds: number) => tone(rate, seconds, 300, 0.06);

  for (const rate of [16000, 44100, 48000]) {
    test(`${rate} Hz: Sprache ohne vorangestellte Stille wird gehört und hebt die Rauschschwelle nicht an`, async () => {
      const run = pipeline(rate);
      feed(run.p, [word(rate, 4)]);
      expect(run.events.map(e => e.type)).toEqual(["start"]);
      // Kein Block der Sprache ist in die Schätzung gegangen
      expect(run.p.vad.noise()).toBeLessThan(0.003);
      feed(run.p, [silence(rate, 1)]);
      expect(run.events.map(e => e.type)).toEqual(["start", "utterance"]);
      expect(run.utterances[0]!.spokenMs).toBeGreaterThanOrEqual(3_900);

      const h = await uploadsFor(rate, concat(word(rate, 4), silence(rate, 1)));
      expect(h.uploads()).toHaveLength(1);
      const seconds = prepareSpeechAudio(h.lastUpload().body, "audio/wav")!.seconds;
      expect(seconds).toBeGreaterThan(4);
      expect(seconds).toBeLessThan(4.3);
    });

    test(`${rate} Hz: 100 ms Stille und 300 ms Sprache ergeben genau einen Upload`, async () => {
      const run = pipeline(rate);
      feed(run.p, [concat(silence(rate, 0.1), word(rate, 0.3), silence(rate, 1))]);
      expect(run.events.map(e => e.type)).toEqual(["start", "utterance"]);
      expect(run.utterances[0]!.spokenMs).toBeGreaterThanOrEqual(300);

      const h = await uploadsFor(rate, concat(silence(rate, 0.1), word(rate, 0.3), silence(rate, 1)));
      expect(h.uploads()).toHaveLength(1);
      expect(h.view().phase).toBe("understanding");
      const seconds = prepareSpeechAudio(h.lastUpload().body, "audio/wav")!.seconds;
      // 100 ms Vorlauf (mehr Stille gab es nicht) + 300 ms Sprache + höchstens 200 ms Endpause
      expect(seconds).toBeGreaterThan(0.38);
      expect(seconds).toBeLessThan(0.66);
    });
  }

  test("nach der Kalibrierung aus stillen Blöcken gilt die gemessene Rauschschwelle", () => {
    // Sprache zuerst, danach Rauschen: die Schätzung kommt allein aus den stillen Blöcken
    const run = pipeline(16000);
    feed(run.p, [concat(word(16000, 1), silence(16000, 1), noise(16000, 1, 0.004, 3))]);
    expect(run.events.map(e => e.type)).toEqual(["start", "utterance"]);
    expect(run.p.vad.noise()).toBeLessThan(0.003);
    // Ein Klick bleibt verworfen, auch direkt nach dem Öffnen
    const click = pipeline(16000);
    feed(click.p, [concat(tone(16000, 0.2, 300, 0.6), silence(16000, 1.5))]);
    expect(click.events.map(e => e.type)).toEqual(["start", "dropped"]);
  });
});

describe("Umrechnung auf 16 kHz", () => {
  for (const rate of [16000, 44100, 48000]) {
    test(`Eingang mit ${rate} Hz: Länge stimmt auf einen Block genau, 440 Hz bleiben 440 Hz`, () => {
      const run = pipeline(rate);
      feed(run.p, [tone(rate, 3, 440, 0.5)]);
      // 3 Sekunden sind 150 Blöcke zu 20 ms
      expect(Math.abs(run.frames.length - 150)).toBeLessThanOrEqual(1);
      const out = concat(...run.frames);
      expect(frequency(out, 16000, 1600)).toBeCloseTo(440, 1);
      // Lautstärke bleibt: 0,5 Spitze sind 0,354 RMS
      expect(rms(out, 1600)).toBeCloseTo(0.3536, 2);
    });
  }

  test("Stereo und mehr Kanäle werden zu Mono gemischt", () => {
    const left = tone(48000, 1, 440, 0.5);
    const same = pipeline(48000);
    feed(same.p, [left, left]);
    const both = concat(...same.frames);
    expect(Math.abs(same.frames.length - 50)).toBeLessThanOrEqual(1);
    expect(frequency(both, 16000, 1600)).toBeCloseTo(440, 1);
    expect(rms(both, 1600)).toBeCloseTo(0.3536, 2);

    // Nur links: halbe Lautstärke
    const half = pipeline(48000);
    feed(half.p, [left, silence(48000, 1)]);
    expect(rms(concat(...half.frames), 1600)).toBeCloseTo(0.1768, 2);

    // Gegenphase löscht sich aus
    const inverse = pipeline(48000);
    feed(inverse.p, [left, left.map(v => -v)]);
    expect(rms(concat(...inverse.frames), 1600)).toBeLessThan(0.0001);

    // Vier Kanäle, einer trägt den Ton
    const four = pipeline(44100);
    const l = tone(44100, 1, 440, 0.8);
    feed(four.p, [l, silence(44100, 1), silence(44100, 1), silence(44100, 1)]);
    expect(rms(concat(...four.frames), 1600)).toBeCloseTo(0.1414, 2);
  });

  test("Töne über der halben Zielrate (8 kHz) werden unterdrückt statt gespiegelt", () => {
    for (const [rate, hz] of [[48000, 12000], [48000, 9500], [44100, 10000], [44100, 15000]] as const) {
      const run = pipeline(rate);
      feed(run.p, [tone(rate, 1, hz, 0.5)]);
      // Mehr als 40 dB unter dem Eingang (0,354 RMS)
      expect(rms(concat(...run.frames), 1600)).toBeLessThan(0.0035);
    }
    // Sprache bis 5 kHz kommt unverändert an
    const pass = pipeline(44100);
    feed(pass.p, [tone(44100, 1, 5000, 0.5)]);
    const out = concat(...pass.frames);
    expect(rms(out, 1600)).toBeCloseTo(0.3536, 2);
    expect(frequency(out, 16000, 1600)).toBeCloseTo(5000, 0);
  });

  test("128er-Blöcke ergeben lückenlose 20-ms-Blöcke", () => {
    // Bei 16 kHz geht jeder Wert unverändert durch: eine Rampe zeigt jede Lücke und jede Dopplung
    const ramp = new Float32Array(16000 * 2);
    for (let i = 0; i < ramp.length; i++) ramp[i] = (i % 30000) / 32768;
    const run = pipeline(16000);
    feed(run.p, [ramp]);
    expect(run.frames.length).toBe(100);
    for (const f of run.frames) expect(f.length).toBe(320);
    const out = concat(...run.frames);
    for (let i = 0; i < out.length; i++) {
      if (out[i] !== ramp[i]) throw new Error(`Wert ${i} weicht ab`);
    }

    // Andere Blockgrößen (Safari liefert nicht immer 128) ergeben dieselben Blöcke
    const odd = pipeline(16000);
    feed(odd.p, [ramp], 441);
    expect(odd.frames.length).toBe(100);
    expect(concat(...odd.frames)).toEqual(out);

    // 44,1 kHz: die Phase läuft über die Blockgrenzen weiter, das Ergebnis hängt nicht von der Blockgröße ab
    const signal = tone(44100, 2, 440, 0.5);
    const a = pipeline(44100);
    feed(a.p, [signal], 128);
    const b = pipeline(44100);
    feed(b.p, [signal], 1000);
    expect(a.frames.length).toBe(b.frames.length);
    expect(concat(...a.frames)).toEqual(concat(...b.frames));
    // Kein Sprung an den Blockgrenzen: benachbarte Werte eines 440-Hz-Tons liegen nah beieinander
    const smooth = concat(...a.frames);
    let jump = 0;
    for (let i = 1601; i < smooth.length; i++) jump = Math.max(jump, Math.abs(smooth[i]! - smooth[i - 1]!));
    expect(jump).toBeLessThan(0.5 * 2 * Math.PI * (440 / 16000) * 1.05);
  });

  test("ungewöhnliche Raten laufen auch: 22,05 kHz, 32 kHz, 96 kHz, 8 kHz", () => {
    for (const rate of [22050, 32000, 96000, 8000]) {
      const run = pipeline(rate);
      feed(run.p, [tone(rate, 2, 440, 0.5)]);
      expect(Math.abs(run.frames.length - 100)).toBeLessThanOrEqual(1);
      expect(frequency(concat(...run.frames), 16000, 1600)).toBeCloseTo(440, 1);
    }
  });
});
