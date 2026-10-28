/**
 * Issue #258, Checkbox 2: Betriebsart „Gespräch" im Aufnahme-Worklet
 * (createCallVad in src/web/public/speech-worklet.js) und der Spieler
 * (src/web/public/call-player-worklet.js) ohne Browser, mit künstlichen
 * Signalen in 128er-Blöcken wie im AudioWorklet.
 */
import { describe, expect, test } from "bun:test";
import { CALL_LIMITS, MAX_UTTERANCE_BYTES } from "../src/web/call-protocol";
import { loadPlayer } from "./call-mode-fixture";
import { concat, feed, frequency, loadWorklet, mix, noise, silence, speechLike, tone } from "./speech-mode-fixture";

const worklet = new Function(
  (await Bun.file(new URL("../src/web/public/speech-worklet.js", import.meta.url)).text()) +
    "\nreturn { createSpeechPipeline, createCallVad, SPEECH_MAX_SAMPLES };"
)();
void loadWorklet;
const { createCallPlayer } = loadPlayer();

interface Event {
  type: string;
  epoch: number;
  samples?: Int16Array;
  limit?: boolean;
  /** Nummer des 20-ms-Blocks, bei dem die Meldung kam (ab 1) */
  frame: number;
}

/** Pipeline in der Betriebsart „Gespräch" mit eingeschalteter Erkennung */
function callPipeline(sampleRate: number, config: Record<string, unknown> = {}) {
  const all: Event[] = [];
  let frame = 0;
  const p = worklet.createSpeechPipeline({
    sampleRate,
    mode: "call",
    emit: (message: Omit<Event, "frame">) => all.push({ ...message, frame }),
    onFrame: () => void frame++,
  });
  p.configure({ type: "config", epoch: 1, active: true, pauseMs: 800, startMs: 150, ...config });
  return {
    p,
    all,
    frames: () => frame,
    get events() {
      return all.filter(e => e.type !== "level");
    },
    get chunks() {
      return all.filter(e => e.type === "chunk");
    },
    types() {
      // Stücke zusammengefasst, damit die Reihenfolge lesbar bleibt
      const out: string[] = [];
      for (const e of all) {
        if (e.type === "level") continue;
        if (e.type === "chunk" && out.at(-1) === "chunk") continue;
        out.push(e.type);
      }
      return out;
    },
  };
}

describe("Aufnahme-Worklet, Betriebsart „Gespräch“", () => {
  test("Stille und leises Rauschen: kein Stück verlässt das Gerät", () => {
    const c = callPipeline(48000);
    feed(c.p, [concat(silence(48000, 1), noise(48000, 3, 0.002))]);
    expect(c.chunks).toHaveLength(0);
    expect(c.events).toEqual([]);
    // Pegel für die Anzeige kommen trotzdem
    expect(c.all.some(e => e.type === "level")).toBe(true);
  });

  test("Stücke kommen während des Sprechens (mit 300 ms Vorlauf), pause nach 300 ms Stille, speechend nach der eingestellten Pause", () => {
    const c = callPipeline(48000);
    feed(c.p, [concat(silence(48000, 1), speechLike(48000, 1.2), silence(48000, 1.5))]);
    expect(c.types()).toEqual(["speechstart", "chunk", "pause", "speechend"]);
    const start = c.events.find(e => e.type === "speechstart")!;
    const pause = c.events.find(e => e.type === "pause")!;
    const end = c.events.find(e => e.type === "speechend")!;
    expect(end.limit).toBe(false);
    // Jedes Stück: 20 ms PCM16 mono 16 kHz
    for (const chunk of c.chunks) expect(chunk.samples!.length).toBe(320);
    // Bestätigt nach 300 ms Sprechzeit: der Puffer (Vorlauf und Anlauf) geht auf einmal hinaus
    const firstBurst = c.chunks.filter(e => e.frame === start.frame).length;
    expect(firstBurst).toBeGreaterThanOrEqual(15 + 15);
    // Danach live je Block, bis 300 ms Stille erreicht sind; ab da nichts mehr
    expect(Math.max(...c.chunks.map(e => e.frame))).toBe(pause.frame - 1);
    expect(end.frame - pause.frame).toBe(40 - 15);
    // Lückenlos: so viele Stücke wie Blöcke vom Beginn des Vorlaufs bis vor die Pause
    const origin = start.frame - firstBurst + 1;
    expect(c.chunks).toHaveLength(pause.frame - origin);
    // Erst nach dem Ende der Sprache beginnt die Stille-Zählung (Sprache endet bei 2,2 s)
    expect(pause.frame * 20).toBeGreaterThanOrEqual(2200);
  });

  test("Äußerung unter 300 ms (Klick, Husten): verworfen, kein Stück hinaus", () => {
    const c = callPipeline(48000);
    feed(c.p, [concat(silence(48000, 1), tone(48000, 0.2, 300, 0.5), silence(48000, 1.5))]);
    expect(c.types()).toEqual(["dropped"]);
    expect(c.chunks).toHaveLength(0);
  });

  test("Innere Sprechpause über 300 ms: pause, keine stillen Stücke danach; weiter gesprochen: Zurückgehaltenes zuerst, eine Äußerung", () => {
    const c = callPipeline(16000);
    feed(c.p, [concat(silence(16000, 1), tone(16000, 0.6, 220, 0.4), silence(16000, 0.5), tone(16000, 0.6, 220, 0.4), silence(16000, 1.2))]);
    expect(c.types()).toEqual(["speechstart", "chunk", "pause", "chunk", "pause", "speechend"]);
    const pauses = c.events.filter(e => e.type === "pause");
    // In der inneren Pause nach „pause“ kein Stück, bis wieder gesprochen wird
    const resumed = c.chunks.find(e => e.frame > pauses[0]!.frame)!;
    expect(c.chunks.filter(e => e.frame >= pauses[0]!.frame && e.frame < resumed.frame)).toHaveLength(0);
    // Beim Weitersprechen gehen die zurückgehaltenen Blöcke auf einmal hinaus: lückenlos
    const start = c.events.find(e => e.type === "speechstart")!;
    const firstBurst = c.chunks.filter(e => e.frame === start.frame).length;
    const origin = start.frame - firstBurst + 1;
    expect(c.chunks).toHaveLength(pauses[1]!.frame - origin);
    expect(c.events.filter(e => e.type === "speechend")).toHaveLength(1);
  });

  test("Kurze Pause unter 300 ms: kein pause, die Stücke laufen durch", () => {
    const c = callPipeline(16000);
    feed(c.p, [concat(silence(16000, 1), tone(16000, 0.5, 220, 0.4), silence(16000, 0.2), tone(16000, 0.5, 220, 0.4), silence(16000, 1))]);
    expect(c.types()).toEqual(["speechstart", "chunk", "pause", "speechend"]);
  });

  test("Grenze: alles Gesendete samt Vorlauf bleibt unter 58 s (Server: 60 s)", () => {
    const c = callPipeline(16000);
    feed(c.p, [concat(silence(16000, 0.5), tone(16000, 61, 220, 0.4))]);
    const endAt = c.all.findIndex(e => e.type === "speechend");
    const end = c.all[endAt]!;
    expect(end.limit).toBe(true);
    // Gesendet bis zum Ende der ersten Äußerung
    const sent = c.all.slice(0, endAt).filter(e => e.type === "chunk").reduce((n, e) => n + e.samples!.length, 0);
    expect(sent).toBeLessThanOrEqual(worklet.SPEECH_MAX_SAMPLES);
    expect(sent * 2).toBeLessThan(MAX_UTTERANCE_BYTES);
    expect(sent / 16000).toBeLessThan(CALL_LIMITS.maxUtteranceSeconds);
    expect(sent).toBeGreaterThan(worklet.SPEECH_MAX_SAMPLES - 320);
    // Der Ton läuft weiter: danach beginnt eine neue Äußerung
    expect(c.events.filter(e => e.type === "speechstart").length).toBe(2);
  });

  test("Streng (während tybo spricht): doppelte Schwelle, Beginn erst nach 300 ms durchgehender Sprache", () => {
    // Leiser Ton, der normal reicht, streng aber nicht
    const quiet = () => concat(silence(16000, 1), tone(16000, 1, 220, 0.015), silence(16000, 1));
    const normal = callPipeline(16000);
    feed(normal.p, [quiet()]);
    expect(normal.types()[0]).toBe("speechstart");
    const strict = callPipeline(16000, { strict: true, startMs: 300 });
    feed(strict.p, [quiet()]);
    expect(strict.events).toEqual([]);

    // Laut, aber nur 250 ms am Stück: streng nichts, auch keine Stücke
    const burst = callPipeline(16000, { strict: true, startMs: 300 });
    feed(burst.p, [concat(silence(16000, 1), tone(16000, 0.25, 220, 0.4), silence(16000, 0.1), tone(16000, 0.25, 220, 0.4), silence(16000, 1))]);
    expect(burst.events.filter(e => e.type === "speechstart")).toHaveLength(0);
    expect(burst.chunks).toHaveLength(0);

    // 400 ms am Stück: Beginn nach 300 ms
    const long = callPipeline(16000, { strict: true, startMs: 300 });
    feed(long.p, [concat(silence(16000, 1), tone(16000, 0.4, 220, 0.4), silence(16000, 1))]);
    const start = long.events.find(e => e.type === "speechstart")!;
    expect(start.frame).toBe(50 + 15);
  });

  test("Streng: das Echo lernt die Rauschschätzung nicht", () => {
    const strict = callPipeline(16000, { strict: true, startMs: 300 });
    const noiseBefore = strict.p.vad.noise();
    feed(strict.p, [noise(16000, 3, 0.01)]);
    expect(strict.p.vad.noise()).toBe(noiseBefore);
  });

  test("keep: Wechsel von streng auf normal behält die bestätigte Äußerung (Unterbrechen per Stimme)", () => {
    const c = callPipeline(16000, { strict: true, startMs: 300 });
    feed(c.p, [concat(silence(16000, 1), tone(16000, 0.4, 220, 0.4))]);
    expect(c.types()).toEqual(["speechstart", "chunk"]);
    const before = c.chunks.length;
    c.p.configure({ type: "config", epoch: 1, active: true, strict: false, keep: true, reset: false, startMs: 150 });
    feed(c.p, [concat(tone(16000, 0.4, 220, 0.4), silence(16000, 1))]);
    expect(c.types()).toEqual(["speechstart", "chunk", "pause", "speechend"]);
    expect(c.chunks.length).toBeGreaterThan(before + 15);
    // Ohne keep beginnt die Erkennung frisch: die laufende Äußerung ist weg
    const d = callPipeline(16000, { strict: true, startMs: 300 });
    feed(d.p, [concat(silence(16000, 1), tone(16000, 0.4, 220, 0.4))]);
    d.p.configure({ type: "config", epoch: 2, active: true, strict: false, reset: true });
    feed(d.p, [silence(16000, 1.5)]);
    expect(d.types()).toEqual(["speechstart", "chunk"]);
  });

  test("Aus (Verstehen, Denken, Stumm): nichts ausgewertet, nichts gesendet; Laufnummer an jeder Meldung", () => {
    const c = callPipeline(16000, { active: false });
    feed(c.p, [concat(silence(16000, 1), tone(16000, 1, 220, 0.4), silence(16000, 1))]);
    expect(c.all).toEqual([]);
    c.p.configure({ type: "config", epoch: 7, active: true });
    feed(c.p, [concat(silence(16000, 1), tone(16000, 1, 220, 0.4), silence(16000, 1))]);
    expect(c.all.length).toBeGreaterThan(0);
    expect(c.all.every(e => e.epoch === 7)).toBe(true);
  });

  test("Sprechmodus bleibt unverändert: ohne mode gibt es eine ganze Äußerung, keine Stücke", () => {
    const all: any[] = [];
    const p = worklet.createSpeechPipeline({ sampleRate: 16000, emit: (m: any) => all.push(m) });
    p.configure({ type: "config", epoch: 1, active: true });
    feed(p, [concat(silence(16000, 1), tone(16000, 1, 220, 0.4), silence(16000, 1.2))]);
    expect(all.filter(m => m.type !== "level").map(m => m.type)).toEqual(["start", "utterance"]);
  });
});

// ---------------------------------------------------------------------------
// Spieler
// ---------------------------------------------------------------------------

function player(outputRate = 24000) {
  const events: { type: string; id: number; epoch: number; at: number }[] = [];
  let rendered = 0;
  const p = createCallPlayer({ outputRate, emit: (m: any) => events.push({ ...m, at: rendered }) });
  const out: number[] = [];
  return {
    p,
    events,
    out,
    /** n Blöcke zu 128 Werten ausgeben */
    render(blocks: number) {
      for (let i = 0; i < blocks; i++) {
        const block = new Float32Array(128);
        p.render(block);
        rendered += 128;
        out.push(...block);
      }
    },
  };
}

const ramp = (from: number, count: number) => Int16Array.from({ length: count }, (_, i) => from + i);

/** Mikrofon und eigene Wiedergabe (zweiter Eingang) blockweise wie im AudioWorklet */
function feedWithReference(pipeline: { process(channels: Float32Array[], reference?: Float32Array[]): void }, mic: Float32Array, reference: Float32Array, block = 128) {
  for (let at = 0; at < mic.length; at += block) {
    const end = Math.min(mic.length, at + block);
    pipeline.process([mic.subarray(at, end)], [reference.subarray(at, Math.min(reference.length, end))]);
  }
}

/** Wiedergabe wie eine Stimme ohne lange Lücken: Ton mit langsam schwankender Lautstärke */
function playback(rate: number, seconds: number, amplitude = 0.3): Float32Array {
  const out = new Float32Array(Math.round(rate * seconds));
  for (let i = 0; i < out.length; i++) {
    const t = i / rate;
    out[i] = amplitude * (0.6 + 0.4 * Math.sin(2 * Math.PI * 1.3 * t)) * Math.sin(2 * Math.PI * 190 * t);
  }
  return out;
}

/** Echo am Mikrofon: Wiedergabe verzögert und gedämpft, dazu leises Rauschen im Zimmer */
function echoOf(signal: Float32Array, rate: number, delayMs: number, gain: number): Float32Array {
  const delay = Math.round((rate * delayMs) / 1000);
  const room = noise(rate, signal.length / rate, 0.002, 7);
  const out = new Float32Array(signal.length);
  for (let i = 0; i < out.length; i++) out[i] = room[i]! + (i >= delay ? gain * signal[i - delay]! : 0);
  return out;
}

describe("Aufnahme-Worklet: Echo-Schutz mit dem Pegel der eigenen Wiedergabe (Issue #280)", () => {
  const RATE = 16000;
  const STRICT = { strict: true, startMs: 300 };

  test("Die eigene Wiedergabe löst nicht aus; ohne Referenz hätte dasselbe Echo unterbrochen", () => {
    const own = concat(silence(RATE, 0.5), playback(RATE, 4), silence(RATE, 1));
    const mic = echoOf(own, RATE, 120, 0.5);
    const protectedVad = callPipeline(RATE, STRICT);
    feedWithReference(protectedVad.p, mic, own);
    expect(protectedVad.events).toEqual([]);
    expect(protectedVad.chunks).toHaveLength(0);
    // Der Abgleich findet die Wiedergabe im Mikrofon: fast alles ist erklärt, kaum Rest-Echo
    expect(protectedVad.p.vad.coupling()).toBeLessThan(0.1);

    const blind = callPipeline(RATE, STRICT);
    feed(blind.p, [mic]);
    expect(blind.events.some(e => e.type === "speechstart")).toBe(true);
  });

  test("Auch ein Echo so laut wie die Wiedergabe (Lautsprecher ohne Echo-Unterdrückung) löst nicht aus", () => {
    const own = concat(silence(RATE, 0.5), playback(RATE, 4), silence(RATE, 1));
    const c = callPipeline(RATE, STRICT);
    feedWithReference(c.p, echoOf(own, RATE, 200, 1), own);
    expect(c.events).toEqual([]);
  });

  test("Lautere eigene Sprache über dem Echo unterbricht, erst nachdem sie begonnen hat", () => {
    const own = concat(silence(RATE, 0.5), playback(RATE, 4), silence(RATE, 1));
    const echo = echoOf(own, RATE, 120, 0.5);
    const voiceAt = 2.5;
    const voice = concat(silence(RATE, voiceAt), tone(RATE, 1, 330, 0.6), silence(RATE, own.length / RATE - voiceAt - 1));
    const c = callPipeline(RATE, STRICT);
    feedWithReference(c.p, mix(echo, voice), own);
    const start = c.events.find(e => e.type === "speechstart");
    expect(start).toBeDefined();
    // 20-ms-Blöcke: frühestens 300 ms nach Beginn der Sprache
    expect(start!.frame).toBeGreaterThanOrEqual(Math.round(voiceAt * 50) + 15);
    expect(start!.frame).toBeLessThan(Math.round(voiceAt * 50) + 30);
    // Auch Sprache in Echo-Lautstärke: sie passt nicht zur Wiedergabe, also kein Echo
    const quiet = callPipeline(RATE, STRICT);
    const soft = concat(silence(RATE, voiceAt), tone(RATE, 1, 330, 0.08), silence(RATE, own.length / RATE - voiceAt - 1));
    feedWithReference(quiet.p, mix(echo, soft), own);
    expect(quiet.events.filter(e => e.type === "speechstart")).toHaveLength(1);
  });

  // Prüfung am Pull Request #283: Wiedergabe 190 Hz mit 0,3, der Nutzer spricht ab 100 ms mit 330 Hz und 0,1
  for (const rate of [16000, 48000]) {
    test(`Frühe Nutzersprache ohne vorherige Lernpause unterbricht wie ohne Echo-Schutz (${rate / 1000} kHz)`, () => {
      const own = tone(rate, 3, 190, 0.3);
      const user = concat(silence(rate, 0.1), tone(rate, 2, 330, 0.1), silence(rate, 0.9));
      const c = callPipeline(rate, STRICT);
      feedWithReference(c.p, user, own);
      // Ohne zweiten Eingang (Betrieb vor #280 und ohne Audio-Sitzung)
      const before = callPipeline(rate, STRICT);
      feed(before.p, [user]);
      const start = c.events.find(e => e.type === "speechstart");
      expect(start).toBeDefined();
      // 400 ms: 100 ms Stille, dann 300 ms durchgehende Sprache
      expect(start!.frame).toBe(20);
      expect(start!.frame).toBe(before.events.find(e => e.type === "speechstart")!.frame);
      expect(c.chunks.length).toBe(before.chunks.length);
    });
  }

  // Zweite Prüfung am Pull Request #283: leiser als die anfängliche Zusatzschwelle, ohne Echo im Mikrofon
  for (const amplitude of [0.04, 0.05, 0.06]) {
    test(`Leise frühe Nutzersprache (${amplitude}) wird nicht als Rest-Echo gelernt und unterbricht wie ohne Echo-Schutz (48 kHz)`, () => {
      const rate = 48000;
      const own = tone(rate, 3, 190, 0.3);
      const user = concat(silence(rate, 0.1), tone(rate, 2, 330, amplitude), silence(rate, 0.9));
      const c = callPipeline(rate, STRICT);
      const start = c.p.vad.coupling();
      feedWithReference(c.p, user, own);
      const before = callPipeline(rate, STRICT);
      feed(before.p, [user]);
      expect(c.events.find(e => e.type === "speechstart")?.frame).toBe(20);
      expect(c.types()).toEqual(before.types());
      expect(c.chunks.length).toBe(before.chunks.length);
      // Der Rest ohne erkennbares Echo hat die Kopplung nicht angehoben
      expect(c.p.vad.coupling()).toBeLessThanOrEqual(start);
    });
  }

  /** Breitbandiges, nichtperiodisches Echo: Rauschen durch einen Tiefpass erster Ordnung bei 1 kHz */
  function smoothNoise(rate: number, seconds: number): Float32Array {
    const raw = noise(rate, seconds, 0.5, 7);
    const k = 1 - Math.exp((-2 * Math.PI * 1000) / rate);
    const out = new Float32Array(raw.length);
    let y = 0;
    for (let i = 0; i < raw.length; i++) out[i] = y += k * (raw[i]! - y);
    return out;
  }

  // Prüfung am Pull Request #283: Dauertöne verdecken Versatz zwischen den Rasterpunkten und den Rand bei 500 ms
  test("Reines Rauschecho gleich laut, auch zwischen zwei Rasterpunkten und bis genau 500 ms, löst nie aus (48 kHz)", () => {
    const rate = 48000;
    const own = concat(smoothNoise(rate, 3), silence(rate, 0.8));
    for (const delayMs of [0, 120, 120.0208, 120.125, 250, 333.4, 410.77, 499, 499.9, 500]) {
      const delay = Math.round((rate * delayMs) / 1000);
      const mic = new Float32Array(own.length);
      for (let i = delay; i < mic.length; i++) mic[i] = own[i - delay]!;
      const c = callPipeline(rate, STRICT);
      feedWithReference(c.p, mic, own);
      expect({ delayMs, events: c.events }).toEqual({ delayMs, events: [] });
      // Ohne zweiten Eingang hätte dasselbe Echo unterbrochen
      if (delayMs === 120.125 || delayMs === 500) {
        const blind = callPipeline(rate, STRICT);
        feed(blind.p, [mic]);
        expect(blind.events.some(e => e.type === "speechstart")).toBe(true);
      }
    }
  });

  test("Neben Rauschecho unterbricht leise Nutzersprache trotzdem", () => {
    const rate = 48000;
    const own = concat(smoothNoise(rate, 3), silence(rate, 0.8));
    const delay = Math.round(rate * 0.2);
    const user = concat(silence(rate, 1.5), tone(rate, 1, 330, 0.05), silence(rate, 1.3));
    const mic = new Float32Array(own.length);
    for (let i = 0; i < mic.length; i++) mic[i] = (i >= delay ? own[i - delay]! : 0) + user[i]!;
    const c = callPipeline(rate, STRICT);
    feedWithReference(c.p, mic, own);
    expect(c.events.filter(e => e.type === "speechstart")).toHaveLength(1);
    expect(c.events[0]!.frame).toBe(90);
  });

  /** Mikrofon aus mehreren Echo-Wegen der Wiedergabe: [Verzögerung in ms, Verstärkung] je Weg */
  function multipathEcho(own: Float32Array, rate: number, paths: [number, number][]): Float32Array {
    const mic = new Float32Array(own.length);
    for (const [delayMs, gain] of paths) {
      const delay = Math.round((rate * delayMs) / 1000);
      for (let i = delay; i < mic.length; i++) mic[i]! += gain * own[i - delay]!;
    }
    return mic;
  }

  // Dritte Prüfung am Pull Request #283: zwei Wege (120 und 130 ms) lösten bei 440 ms aus, ein einzelner nicht
  test("Rauschecho über zwei und drei Echo-Wege löst nie aus (48 kHz)", () => {
    const rate = 48000;
    const own = smoothNoise(rate, 3);
    for (const paths of [
      [[120, 0.7], [130, 0.3]],
      [[130, 0.3], [120, 0.7]],
      [[120, 0.5], [130, 0.5]],
      [[80, 0.6], [210, 0.4], [400, 0.3]],
    ] as [number, number][][]) {
      const mic = multipathEcho(own, rate, paths);
      const c = callPipeline(rate, STRICT);
      feedWithReference(c.p, mic, own);
      expect({ paths, events: c.events }).toEqual({ paths, events: [] });
      // Ohne zweiten Eingang hätte dasselbe Echo unterbrochen
      const blind = callPipeline(rate, STRICT);
      feed(blind.p, [mic]);
      expect(blind.events.some(e => e.type === "speechstart")).toBe(true);
    }
  });

  test("Neben Rauschecho über zwei Wege unterbricht Nutzersprache trotzdem (48 kHz)", () => {
    const rate = 48000;
    const own = concat(smoothNoise(rate, 3), silence(rate, 0.8));
    const echo = multipathEcho(own, rate, [[120, 0.7], [130, 0.3]]);
    for (const amplitude of [0.05, 0.2]) {
      const user = concat(silence(rate, 1.5), tone(rate, 1, 330, amplitude), silence(rate, 1.3));
      const c = callPipeline(rate, STRICT);
      feedWithReference(c.p, mix(echo, user), own);
      const starts = c.events.filter(e => e.type === "speechstart");
      expect({ amplitude, starts: starts.length }).toEqual({ amplitude, starts: 1 });
      // Erst nach 300 ms der Sprache ab 1,5 s, nicht vorher durch das Echo
      expect(starts[0]!.frame).toBeGreaterThanOrEqual(90);
      expect(starts[0]!.frame).toBeLessThan(100);
    }
  });

  for (const rate of [16000, 48000]) {
    test(`Reines Echo so laut wie die Wiedergabe, 200 bis 500 ms verzögert, löst nie aus (${rate / 1000} kHz)`, () => {
      for (const delayMs of [200, 300, 377, 450, 500]) {
        const own = concat(tone(rate, 3, 190, 0.3), silence(rate, 0.8));
        const c = callPipeline(rate, STRICT);
        feedWithReference(c.p, echoOf(own, rate, delayMs, 1), own);
        expect({ delayMs, events: c.events }).toEqual({ delayMs, events: [] });
      }
    });
  }

  test("Bevor das Echo da sein kann, lernt die Kopplung nicht nach unten", () => {
    const c = callPipeline(RATE, STRICT);
    const start = c.p.vad.coupling();
    // 450 ms Wiedergabe, das Mikrofon hört (noch) nichts
    feedWithReference(c.p, silence(RATE, 0.45), tone(RATE, 0.45, 190, 0.3));
    expect(c.p.vad.coupling()).toBe(start);
    // Läuft sie länger als die größte gesuchte Verzögerung ohne Echo: Kopfhörer, jetzt sinkt sie
    feedWithReference(c.p, silence(RATE, 1), tone(RATE, 1, 190, 0.3));
    expect(c.p.vad.coupling()).toBeLessThan(start);
  });

  test("Ohne zweiten Eingang oder mit leerem: genau wie vor #280", () => {
    const voice = concat(silence(RATE, 0.5), speechLike(RATE, 1.5), silence(RATE, 1.2));
    const without = callPipeline(RATE);
    feed(without.p, [voice]);
    const empty = callPipeline(RATE);
    for (let at = 0; at < voice.length; at += 128) empty.p.process([voice.subarray(at, Math.min(voice.length, at + 128))], []);
    expect(without.events.length).toBeGreaterThan(0);
    expect(empty.all).toEqual(without.all);
  });

  test("Kopfhörer: kommt kein Echo an, sinkt die Kopplung, und normale Sprache unterbricht wie bisher", () => {
    const own = concat(playback(RATE, 5), silence(RATE, 0.5));
    const room = noise(RATE, own.length / RATE, 0.002, 3);
    const c = callPipeline(RATE, STRICT);
    // Zwei Sekunden nur Wiedergabe: die Kopplung lernt nach unten
    const learn = Math.round(RATE * 2);
    feedWithReference(c.p, room.subarray(0, learn), own.subarray(0, learn));
    expect(c.p.vad.coupling()).toBeLessThan(0.1);
    // Dann spricht der Nutzer in normaler Lautstärke
    const voice = mix(room.subarray(learn), concat(tone(RATE, 1, 330, 0.1), silence(RATE, own.length / RATE - 3)));
    feedWithReference(c.p, voice, own.subarray(learn));
    expect(c.events[0]).toMatchObject({ type: "speechstart" });
  });

  test("Nachhall: die Hüllkurve hält 300 ms und klingt ab; danach gilt wieder nur die normale Schwelle", () => {
    const c = callPipeline(RATE, STRICT);
    const own = playback(RATE, 1);
    feedWithReference(c.p, silence(RATE, 1), own);
    const peak = c.p.vad.echoLevel();
    expect(peak).toBeGreaterThan(0.1);
    feedWithReference(c.p, silence(RATE, 0.25), silence(RATE, 0.25));
    expect(c.p.vad.echoLevel()).toBe(peak);
    feedWithReference(c.p, silence(RATE, 0.3), silence(RATE, 0.3));
    expect(c.p.vad.echoLevel()).toBeLessThan(peak * 0.6);
    feedWithReference(c.p, silence(RATE, 2), silence(RATE, 2));
    expect(c.p.vad.echoLevel()).toBe(0);
    // Ohne Wiedergabe unterbricht ein leiser Ton wie vor #280 (streng: doppelte Grundschwelle)
    feedWithReference(c.p, concat(tone(RATE, 0.5, 330, 0.06), silence(RATE, 0.2)), silence(RATE, 0.7));
    expect(c.events[0]).toMatchObject({ type: "speechstart" });
  });

  test("raiseEcho nach einem Fehlalarm: Kopplung verdoppelt, und sie lernt nicht mehr darunter", () => {
    const c = callPipeline(RATE, STRICT);
    const own = playback(RATE, 2);
    feedWithReference(c.p, echoOf(own, RATE, 100, 0.3), own);
    const learned = c.p.vad.coupling();
    c.p.raiseEcho();
    expect(c.p.vad.coupling()).toBeCloseTo(learned * 2, 5);
    // Zwei Sekunden ganz ohne Echo: bleibt auf der neuen Untergrenze
    feedWithReference(c.p, silence(RATE, 2), playback(RATE, 2));
    expect(c.p.vad.coupling()).toBeCloseTo(learned * 2, 5);
    // Ein weiterer Fehlalarm verdoppelt erneut, nach oben begrenzt
    for (let i = 0; i < 20; i++) c.p.raiseEcho();
    expect(c.p.vad.coupling()).toBe(8);
  });

  test("config setzt den Echo-Schutz nicht zurück; die Laufzählung einer Äußerung bleibt wie bisher", () => {
    const c = callPipeline(RATE, STRICT);
    const own = playback(RATE, 2);
    feedWithReference(c.p, echoOf(own, RATE, 100, 0.3), own);
    const learned = c.p.vad.coupling();
    const level = c.p.vad.echoLevel();
    c.p.configure({ type: "config", epoch: 2, active: true, strict: false, reset: true });
    c.p.configure({ type: "config", epoch: 3, active: true, strict: true, reset: true });
    expect(c.p.vad.coupling()).toBe(learned);
    expect(c.p.vad.echoLevel()).toBe(level);
  });

  test("Sprechmodus: ein zweiter Eingang ändert nichts", () => {
    const all: any[] = [];
    const p = worklet.createSpeechPipeline({ sampleRate: RATE, emit: (m: any) => all.push(m) });
    p.configure({ type: "config", epoch: 1, active: true });
    const voice = concat(silence(RATE, 1), speechLike(RATE, 1), silence(RATE, 1.5));
    feedWithReference(p, voice, playback(RATE, 3.5));
    expect(all.filter(m => m.type === "utterance")).toHaveLength(1);
  });
});

describe("Spieler (call-player-worklet.js)", () => {
  test("spielt in Reihenfolge, meldet Beginn und Ende jedes Abschnitts erst beim Ausgeben", () => {
    const s = player(24000);
    s.p.begin(1);
    s.p.audio(ramp(1, 1000), 24000);
    s.p.end(1);
    s.p.begin(2);
    s.p.audio(ramp(2001, 1000), 24000);
    s.p.audio(ramp(3001, 500), 24000);
    s.p.end(2);
    // Noch nichts ausgegeben: keine Meldung
    expect(s.events).toEqual([]);
    s.render(30);
    const played = s.out.filter(v => v !== 0).map(v => Math.round(v * 32768));
    expect(played).toEqual([...ramp(1, 1000), ...ramp(2001, 1000), ...ramp(3001, 500)].map(Number));
    expect(s.events.map(e => [e.type, e.id])).toEqual([["begin", 1], ["played", 1], ["begin", 2], ["played", 2]]);
    // played 1 erst, nachdem der letzte Wert von Abschnitt 1 heraus ist
    // at ist der Anfang des Blocks, in dem die Meldung kam: der letzte Wert lag in diesem Block
    const played1 = s.events.find(e => e.type === "played" && e.id === 1)!;
    expect(played1.at + 128).toBeGreaterThanOrEqual(1000);
    expect(played1.at).toBeLessThan(1000);
    const played2 = s.events.find(e => e.type === "played" && e.id === 2)!;
    expect(played2.at + 128).toBeGreaterThanOrEqual(2500);
    expect(played2.at).toBeLessThan(2500);
    expect(s.p.buffered()).toBe(0);
  });

  test("Startpuffer 60 ms: unter 60 ms eines offenen Abschnitts bleibt es still, dann spielt es", () => {
    const s = player(24000);
    s.p.begin(1);
    s.p.audio(ramp(1, 1000), 24000);
    s.render(4);
    expect(s.out.every(v => v === 0)).toBe(true);
    expect(s.p.playing()).toBe(false);
    s.p.audio(ramp(1001, 500), 24000);
    s.render(1);
    expect(s.p.playing()).toBe(true);
    expect(Math.round(s.out[512]! * 32768)).toBe(1);
  });

  test("Ein kurzer, vollständiger Abschnitt spielt auch unter 60 ms", () => {
    const s = player(24000);
    s.p.begin(4);
    s.p.audio(ramp(1, 200), 24000);
    s.p.end(4);
    s.render(3);
    expect(s.events.map(e => e.type)).toEqual(["begin", "played"]);
  });

  test("Leeren: sofort still, keine Meldung für verworfene Abschnitte, neue Laufnummer", () => {
    const s = player(24000);
    s.p.begin(1);
    s.p.audio(ramp(1, 4800), 24000);
    s.p.end(1);
    s.render(2);
    expect(s.events.map(e => e.type)).toEqual(["begin"]);
    s.p.flush(5);
    expect(s.p.buffered()).toBe(0);
    const before = s.out.length;
    s.render(10);
    expect(s.out.slice(before).every(v => v === 0)).toBe(true);
    expect(s.events.map(e => e.type)).toEqual(["begin"]);
    // Ton ohne offenen Abschnitt (verspätet nach dem Leeren) wird nicht gespielt
    s.p.audio(ramp(1, 2400), 24000);
    s.render(10);
    expect(s.out.slice(before).every(v => v === 0)).toBe(true);
    // Neuer Abschnitt nach dem Leeren: Meldungen mit der neuen Laufnummer
    s.p.begin(2);
    s.p.audio(ramp(1, 2400), 24000);
    s.p.end(2);
    s.render(30);
    expect(s.events.slice(1)).toMatchObject([{ type: "begin", id: 2, epoch: 5 }, { type: "played", id: 2, epoch: 5 }]);
  });

  test("Umrechnung 24 kHz auf 48 kHz: Länge verdoppelt, Frequenz bleibt, über Stückgrenzen ohne Sprung", () => {
    const s = player(48000);
    const sine = Int16Array.from({ length: 24000 }, (_, i) => Math.round(16000 * Math.sin((2 * Math.PI * 440 * i) / 24000)));
    s.p.begin(1);
    // In ungeraden Stücken wie aus dem Netz
    for (let at = 0; at < sine.length; at += 777) s.p.audio(sine.subarray(at, Math.min(sine.length, at + 777)), 24000);
    s.p.end(1);
    const written = s.p.buffered();
    expect(Math.abs(written - 48000)).toBeLessThanOrEqual(4);
    s.render(Math.ceil(written / 128) + 2);
    const samples = Float32Array.from(s.out);
    expect(frequency(samples, 48000, 1000, 47000)).toBeCloseTo(440, 0);
    // Kein Sprung an den Stückgrenzen: größter Schritt wie beim Sinus selbst
    let maxStep = 0;
    for (let i = 1; i < 47000; i++) maxStep = Math.max(maxStep, Math.abs(samples[i]! - samples[i - 1]!));
    expect(maxStep).toBeLessThan((16000 / 32768) * ((2 * Math.PI * 440) / 48000) * 1.1);
    expect(s.events.map(e => e.type)).toEqual(["begin", "played"]);
  });

  test("Großer Rückstand: der Ringpuffer wächst, nichts geht verloren", () => {
    const s = player(24000);
    s.p.begin(1);
    for (let i = 0; i < 10; i++) s.p.audio(ramp(i * 24000, 24000).map(v => v % 30000), 24000);
    s.p.end(1);
    expect(s.p.buffered()).toBe(240000);
    s.render(Math.ceil(240000 / 128) + 1);
    expect(s.events.map(e => e.type)).toEqual(["begin", "played"]);
    expect(s.p.buffered()).toBe(0);
  });
});

describe("Spieler: Rückfall der Stimme (Issue #276)", () => {
  test("restart verwirft den ungespielten Ton des Abschnitts, Gespieltes bleibt, der neue Ton folgt; played genau einmal", () => {
    const s = player(24000);
    s.p.begin(1);
    s.p.audio(ramp(1, 1000), 24000);
    s.p.end(1);
    s.p.begin(2);
    s.p.audio(ramp(5001, 3000), 24000);
    // Abschnitt 1 und ein Teil von 2 sind gespielt
    s.render(10);
    s.p.restart(2);
    s.p.audio(ramp(20001, 500), 24000);
    s.p.end(2);
    s.render(30);
    const played = s.out.filter(v => v !== 0).map(v => Math.round(v * 32768));
    expect(played).toEqual([...ramp(1, 1000), ...ramp(5001, 280), ...ramp(20001, 500)].map(Number));
    expect(s.events.map(e => [e.type, e.id])).toEqual([["begin", 1], ["played", 1], ["begin", 2], ["played", 2]]);
  });

  test("restart vor Beginn: nichts vom ersten Versuch ist zu hören; ältere Abschnitte bleiben", () => {
    const s = player(24000);
    s.p.begin(1);
    s.p.audio(ramp(1, 2000), 24000);
    s.p.end(1);
    s.p.begin(2);
    s.p.audio(ramp(5001, 100), 24000);
    s.p.restart(2);
    s.p.audio(ramp(9001, 100), 24000);
    s.p.end(2);
    s.render(30);
    const played = s.out.filter(v => v !== 0).map(v => Math.round(v * 32768));
    expect(played).toEqual([...ramp(1, 2000), ...ramp(9001, 100)].map(Number));
  });

  test("drop beendet den Abschnitt ohne played (die Browser-Stimme spricht ihn), unbekannte IDs ändern nichts", () => {
    const s = player(24000);
    s.p.begin(1);
    s.p.audio(ramp(1, 1000), 24000);
    s.p.end(1);
    s.p.begin(2);
    s.p.audio(ramp(5001, 1000), 24000);
    s.p.drop(7);
    s.p.drop(1);
    s.p.drop(2);
    s.render(30);
    const played = s.out.filter(v => v !== 0).map(v => Math.round(v * 32768));
    expect(played).toEqual([...ramp(1, 1000)].map(Number));
    expect(s.events.map(e => [e.type, e.id])).toEqual([["begin", 1], ["played", 1]]);
    expect(s.p.marks()).toEqual([]);
  });
});
