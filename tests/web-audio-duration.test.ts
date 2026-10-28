/**
 * Issue #249: Aufnahme für die Erkennung vorbereiten. Der Server zählt die
 * Ton-Einheiten (WAV-Blöcke, Opus-Pakete, MP3-Frames, AAC-Frames) und
 * schreibt aus genau ihnen die Datei, die an die Erkennung geht. Die Dauer
 * ist die Summe der Einheiten; Zeitangaben des Containers zählen nicht.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { audioDurationSeconds, prepareSpeechAudio } from "../src/web/audio-duration";
import { detectMedia } from "../src/web/media-check";
import { mp3FrameFixture, mp3Id3Fixture, oggOpusFixture, wavFixture } from "./audio-fixture";
import { bytes, el, elUnknown, ebmlHeader, ID, track, webmAudioClusters } from "./media-fixture";
import {
  AAC_FILL_OVERREAD,
  AAC_SILENT_FRAME,
  box,
  mp4Aac,
  mp4AacFragmented,
  mp4Fragmented,
  mp4Opus,
  oggOpusChained,
  oggOpusHeaders,
  oggOpusStream,
  oggPages,
  oggRawPage,
  OGG_PRE_SKIP,
  OPUS_HEAD,
  OPUS_SILENT_120,
  OPUS_SILENT_20,
  opusTrack,
  webmLive,
  webmOpusLaced,
  webmWithDuration,
  wavImaAdpcm,
  wavSilence,
  wavWithFormat,
} from "./speech-fixture";
import { MAX_SPEECH_BYTES } from "../src/web/speech";

const mimeOf = (b: Uint8Array) => detectMedia(b)?.mime ?? "unbekannt";
const seconds = (b: Uint8Array) => audioDurationSeconds(b, mimeOf(b));
const prepare = (b: Uint8Array) => prepareSpeechAudio(b, mimeOf(b));
const same = (a: Uint8Array, b: Uint8Array) => Buffer.from(a).equals(Buffer.from(b));
const recording = (name: string) => new Uint8Array(readFileSync(join(import.meta.dir, "fixtures", "recordings", name)));

const u16 = (n: number) => [n & 0xff, n >> 8];
const u32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
/** fmt-Block eines WAV */
const fmt = (codec: number, channels: number, rate: number, blockAlign: number, bits: number, extra: number[] = []) => [
  ...u16(codec), ...u16(channels), ...u32(rate), ...u32(rate * blockAlign), ...u16(blockAlign), ...u16(bits), ...extra,
];
/** Anhang eines WAVE_FORMAT_EXTENSIBLE mit dem Codec im SubFormat */
const extensible = (sub: number) => [...u16(22), ...u16(16), ...u32(1), ...u16(sub), 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71];

/** Ein RIFF-Block mit Kennung, Länge und Nutzdaten */
function chunk(id: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length);
  out.set(bytes(id, u32(data.length)));
  out.set(data, 8);
  return out;
}

function join2(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** WebM mit einer Opus-Spur (OpusHead in CodecPrivate) und einem Cluster mit einem Block aus diesen Bytes */
const webmBlock = (payload: number[], tracks: Uint8Array = opusTrack()) =>
  bytes(ebmlHeader(), elUnknown(ID.Segment, el(ID.Tracks, tracks), el(ID.Cluster, el([0xe7], bytes([0])), el([0xa3], bytes(payload)))));

describe("audioDurationSeconds: Summe der gezählten Einheiten", () => {
  test("WAV: Blöcke des data-Blocks durch die Abtastrate", () => {
    expect(seconds(wavSilence(1.5))).toBeCloseTo(1.5, 5);
    expect(seconds(wavSilence(61))).toBeCloseTo(61, 5);
    // 480 Bytes bei 24 kHz, 16 Bit mono
    expect(seconds(wavFixture())).toBeCloseTo(0.01, 5);
  });

  test("WAV aus einem Strom (Größe 0 oder 0xFFFFFFFF): zählt, was da ist", () => {
    expect(seconds(wavSilence(2, { dataSize: 0 }))).toBeCloseTo(2, 5);
    expect(seconds(wavSilence(2, { dataSize: 0xffffffff }))).toBeCloseTo(2, 5);
  });

  test("komprimiertes WAV (IMA ADPCM): nicht bestimmbar statt 0,04 Sekunden (Regression: 80 Sekunden unter 2 MB)", () => {
    const adpcm = wavImaAdpcm(80);
    expect(adpcm.length).toBeLessThan(MAX_SPEECH_BYTES);
    expect(mimeOf(adpcm)).toBe("audio/wav");
    // Gültig aufgebaut: Codec 0x11, 1024 Bytes je Block, fact-Block mit rund 80 Sekunden bei 16 kHz
    const view = new DataView(adpcm.buffer);
    expect(view.getUint16(20, true)).toBe(0x11);
    expect(view.getUint16(32, true)).toBe(1024);
    expect(view.getUint32(48, true) / 16_000).toBeGreaterThanOrEqual(80);
    // Abtastrate mal Blockgröße hätte 0,04 Sekunden ergeben
    expect((adpcm.length - 60) / (16_000 * 1024)).toBeLessThan(0.05);
    expect(seconds(adpcm)).toBeNull();
    expect(seconds(wavImaAdpcm(5))).toBeNull();
  });

  test("WAV: nur PCM und Gleitkomma mit stimmigen Formatangaben, auch als WAVE_FORMAT_EXTENSIBLE", () => {
    // 32000 Bytes Daten
    expect(seconds(wavWithFormat(fmt(1, 1, 16_000, 2, 16)))).toBeCloseTo(1, 5);
    expect(seconds(wavWithFormat(fmt(1, 2, 16_000, 4, 16)))).toBeCloseTo(0.5, 5);
    expect(seconds(wavWithFormat(fmt(1, 1, 8_000, 1, 8)))).toBeCloseTo(4, 5);
    expect(seconds(wavWithFormat(fmt(3, 1, 16_000, 4, 32)))).toBeCloseTo(0.5, 5);
    expect(seconds(wavWithFormat(fmt(0xfffe, 1, 16_000, 2, 16, extensible(1))))).toBeCloseTo(1, 5);
    // Komprimierte Codecs: MS ADPCM, A-law, mu-law, GSM, MP3, ADPCM hinter EXTENSIBLE
    for (const codec of [2, 6, 7, 0x31, 0x55]) expect(seconds(wavWithFormat(fmt(codec, 1, 16_000, 256, 4)))).toBeNull();
    expect(seconds(wavWithFormat(fmt(0xfffe, 1, 16_000, 2, 16, extensible(0x11))))).toBeNull();
    // EXTENSIBLE ohne SubFormat
    expect(seconds(wavWithFormat(fmt(0xfffe, 1, 16_000, 2, 16)))).toBeNull();
    // Angaben passen nicht zusammen: PCM mit aufgeblähter Blockgröße, ohne Kanäle, ohne Abtastrate, 4 Bit
    expect(seconds(wavWithFormat(fmt(1, 1, 16_000, 1024, 16)))).toBeNull();
    expect(seconds(wavWithFormat(fmt(1, 0, 16_000, 2, 16)))).toBeNull();
    expect(seconds(wavWithFormat(fmt(1, 1, 0, 2, 16)))).toBeNull();
    expect(seconds(wavWithFormat(fmt(1, 1, 16_000, 1, 4)))).toBeNull();
    // Byte-Rate passt nicht in ihr 32-Bit-Feld
    expect(seconds(wavWithFormat(fmt(1, 8, 4_000_000_000, 32, 32)))).toBeNull();
  });

  test("WAV ohne fmt-Block, ohne data-Block oder ohne einen ganzen Block: nicht bestimmbar", () => {
    expect(audioDurationSeconds(bytes("RIFF", [4, 0, 0, 0], "WAVE"), "audio/wav")).toBeNull();
    expect(audioDurationSeconds(wavSilence(1).slice(0, 36), "audio/wav")).toBeNull();
    expect(audioDurationSeconds(wavSilence(0), "audio/wav")).toBeNull();
    expect(audioDurationSeconds(wavSilence(1).slice(0, 45), "audio/wav")).toBeNull();
  });

  test("Ogg/Opus: Summe der Opus-Pakete, ohne Abzug von Pre-Skip und gekürztem Ende", () => {
    expect(mimeOf(oggOpusFixture())).toBe("audio/ogg");
    // 0,1 Sekunden Ton (ffmpeg, siehe audio-fixture.ts) in sechs Paketen zu 20 ms
    expect(seconds(oggOpusFixture())).toBeCloseTo(0.12, 5);
  });

  test("Ogg/Opus aus der Fixture-Werkstatt: ein Stream zählt seine Sekunden", () => {
    expect(mimeOf(oggOpusStream(40))).toBe("audio/ogg");
    expect(seconds(oggOpusStream(40))).toBeCloseTo(40, 5);
    expect(seconds(oggOpusStream(60))).toBeCloseTo(60, 5);
  });

  test("verkettetes Ogg: die Streams zählen zusammen, nicht nur der längste (Regression 80 statt 40 Sekunden)", () => {
    const chained = oggOpusChained(40, 40);
    // Klein wie eine kurze Aufnahme, erkannt als Ogg/Opus, tatsächlich 80 Sekunden
    expect(chained.length).toBeLessThan(20_000);
    expect(mimeOf(chained)).toBe("audio/ogg");
    expect(seconds(chained)).toBeCloseTo(80, 5);
    expect(seconds(oggOpusChained(10, 25, 30))).toBeCloseTo(65, 5);
    expect(seconds(oggOpusChained(20, 20))).toBeCloseTo(40, 5);
  });

  test("verkettetes Ogg mit einem zweiten Stream, der kein Opus ist, oder doppelter Seriennummer: nicht bestimmbar", () => {
    const first = oggOpusStream(5, 7);
    // Zweiter Stream beginnt mit einer ersten Seite ohne OpusHead
    const other = oggOpusStream(5, 8);
    other.set([..."Vorbis!!"].map(c => c.charCodeAt(0)), 28);
    expect(audioDurationSeconds(bytes(first, other), "audio/ogg")).toBeNull();
    // Dieselbe Seriennummer beginnt zweimal
    expect(audioDurationSeconds(bytes(first, oggOpusStream(5, 7)), "audio/ogg")).toBeNull();
    // Seiten eines Streams, der nie begonnen hat (erste Seite fehlt)
    const headless = oggOpusStream(5, 9).subarray(47);
    expect(audioDurationSeconds(bytes(first, headless), "audio/ogg")).toBeNull();
    // Ineinander verschachtelt: nach dem Beginn des zweiten Streams kommt noch eine Seite des ersten
    const second = oggOpusStream(5, 8);
    const page = oggRawPage(7, 9, 0, 0, [3], OPUS_SILENT_20);
    expect(audioDurationSeconds(bytes(first, second), "audio/ogg")).toBeCloseTo(10, 5);
    expect(audioDurationSeconds(bytes(first, second, page), "audio/ogg")).toBeNull();
    // Der nächste Stream beginnt, bevor der vorige sein OpusTags hatte
    const headOnly = oggOpusHeaders(7).subarray(0, 47);
    expect(audioDurationSeconds(bytes(headOnly, second), "audio/ogg")).toBeNull();
  });

  test("Ogg, dessen Granule-Positionen eine Sekunde nennen, bei 80 Sekunden Opus-Paketen: es zählen die Pakete (Regression)", () => {
    // Jede Audioseite trägt dieselbe Granule-Position, die Prüfsummen stimmen
    const frozen = oggOpusStream(80, 1, { granule: () => 48_312 });
    expect(frozen.length).toBeLessThan(20_000);
    expect(frozen.length).toBe(oggOpusStream(80).length);
    expect(mimeOf(frozen)).toBe("audio/ogg");
    // 4000 Pakete zu 20 ms
    expect(seconds(frozen)).toBeCloseTo(80, 5);
    // Nur die letzte Seite klein, Granule-Position 0 überall, rückwärts laufend
    expect(seconds(oggOpusStream(80, 1, { granule: s => (s === 80 ? 48_312 : OGG_PRE_SKIP + s * 48_000) }))).toBeCloseTo(80, 5);
    expect(seconds(oggOpusStream(80, 1, { granule: () => 0 }))).toBeCloseTo(80, 5);
    expect(seconds(oggOpusStream(80, 1, { granule: s => (81 - s) * 480 }))).toBeCloseTo(80, 5);
    // In einer Kette zählt jeder Stream mit seinen Paketen
    const chained = bytes(oggOpusStream(40, 5, { granule: () => 960 }), oggOpusStream(40, 6, { granule: () => 960 }));
    expect(seconds(chained)).toBeCloseTo(80, 5);
    // Pakete zu 120 ms: 50 je Seite sind 6 Sekunden
    expect(seconds(oggOpusStream(11, 1, { granule: () => 48_312, packet: OPUS_SILENT_120 }))).toBeCloseTo(66, 5);
  });

  test("Ogg: die Granule-Position zählt gar nicht, weder nach unten noch nach oben", () => {
    // Ende mitten im letzten Paket (RFC 7845, Abschnitt 4.4): gezählt werden alle 40 Sekunden Pakete
    expect(seconds(oggOpusStream(40, 1, { granule: s => (s === 40 ? OGG_PRE_SKIP + 40 * 48_000 - 480 : OGG_PRE_SKIP + s * 48_000) }))).toBeCloseTo(40, 5);
    // Granule-Position weit über den Paketen: es bleibt bei 10 Sekunden, mehr Ton ist nicht da
    expect(seconds(oggOpusStream(10, 1, { granule: s => OGG_PRE_SKIP + (s + 60) * 48_000 }))).toBeCloseTo(10, 5);
  });

  test("Ogg: ein Paket über zwei Seiten zählt einmal, ungültige Pakete und fehlende Fortsetzungen sind nicht bestimmbar", () => {
    // 300 Bytes: CELT, Vollband, ein Frame von 20 ms, aufgeteilt in 255 und 45 Bytes
    const big = new Uint8Array(300);
    big.set([0xf8, 0xff, 0xfe]);
    const first = oggRawPage(1, 2, 0, -1, [255], big.subarray(0, 255));
    const rest = (flags: number) => oggRawPage(1, 3, flags, OGG_PRE_SKIP + 960, [45], big.subarray(255));
    expect(audioDurationSeconds(bytes(oggOpusHeaders(), first, rest(0x05)), "audio/ogg")).toBeCloseTo(0.02, 5);
    // Fortsetzung nicht angekündigt, angekündigt ohne offenes Paket, am Ende offen
    expect(audioDurationSeconds(bytes(oggOpusHeaders(), first, rest(0x04)), "audio/ogg")).toBeNull();
    expect(audioDurationSeconds(bytes(oggOpusHeaders(), rest(0x05)), "audio/ogg")).toBeNull();
    expect(audioDurationSeconds(bytes(oggOpusHeaders(), first), "audio/ogg")).toBeNull();
    // Ungültige Opus-Pakete: leer, Code 3 ohne Frames, Code 3 mit mehr als 120 ms
    expect(seconds(oggOpusStream(3, 1, { packet: new Uint8Array(0) }))).toBeNull();
    expect(seconds(oggOpusStream(3, 1, { packet: bytes([0xfb, 0x00]) }))).toBeNull();
    expect(seconds(oggOpusStream(3, 1, { packet: bytes([0xfb, 0x07, 1, 2, 3, 4, 5, 6, 7]) }))).toBeNull();
    // Zweites Paket ist kein OpusTags
    const noTags = oggOpusStream(3);
    noTags.set([..."OpusTagx"].map(c => c.charCodeAt(0)), oggOpusHeaders().length - 20);
    expect(audioDurationSeconds(noTags, "audio/ogg")).toBeNull();
    // Nur Kopf-Seiten, kein einziges Audio-Paket
    expect(audioDurationSeconds(oggOpusHeaders(), "audio/ogg")).toBeNull();
  });

  test("Ogg mit kaputtem Seitenaufbau oder Resten hinter der letzten Seite: nicht bestimmbar", () => {
    const broken = oggOpusFixture().subarray(0, 60);
    expect(audioDurationSeconds(broken, "audio/ogg")).toBeNull();
    expect(audioDurationSeconds(bytes(oggOpusStream(2), [0, 0, 0]), "audio/ogg")).toBeNull();
  });

  test("MP3: Summe der Frames, mit und ohne ID3-Kopf", () => {
    // Fünf MPEG-2-Layer-III-Frames mit 16 kHz: 5 * 576 / 16000
    expect(seconds(mp3FrameFixture())).toBeCloseTo(0.18, 5);
    expect(seconds(mp3Id3Fixture())).toBeCloseTo(0.18, 5);
  });

  test("MP3 ohne einen gültigen Frame: nicht bestimmbar", () => {
    expect(audioDurationSeconds(bytes("ID3", [4, 0, 0, 0, 0, 0, 0], new Array(200).fill(0)), "audio/mpeg")).toBeNull();
  });

  test("WebM wie aus MediaRecorder (ohne Duration, Cluster unbekannter Größe): Summe der Pakete", () => {
    expect(mimeOf(webmLive(3))).toBe("audio/webm");
    expect(seconds(webmLive(3))).toBeCloseTo(3, 5);
    expect(seconds(webmLive(90))).toBeCloseTo(90, 5);
    // Echte Aufnahme aus Chrome (tests/fixtures/recordings): 1,5 Sekunden
    expect(seconds(recording("chrome-opus.webm"))).toBeCloseTo(1.5, 5);
  });

  test("WebM mit gebündelten Paketen (Xiph-Lacing): 667 Pakete zu 120 ms in drei Blöcken sind 80,04 Sekunden, nicht 57,6 (Regression)", () => {
    const laced = webmOpusLaced(667);
    // Klein wie eine kurze Aufnahme, ohne Duration, der letzte Block beginnt bei 57,6 Sekunden
    expect(laced.length).toBeLessThan(11_000);
    expect(mimeOf(laced)).toBe("audio/webm");
    expect(seconds(laced)).toBeCloseTo(80.04, 5);
    // Knapp unter und knapp über der Grenze: 500 Pakete sind genau 60 Sekunden, 501 sind 60,12
    expect(seconds(webmOpusLaced(500))).toBeCloseTo(60, 5);
    expect(seconds(webmOpusLaced(501))).toBeCloseTo(60.12, 5);
    expect(seconds(webmOpusLaced(100))).toBeCloseTo(12, 5);
  });

  test("WebM: jede Art der Bündelung zählt gleich (ohne, Xiph, EBML, feste Größe)", () => {
    for (const lacing of ["none", "xiph", "ebml", "fixed"] as const) {
      expect(seconds(webmOpusLaced(667, { lacing }))).toBeCloseTo(80.04, 5);
      expect(seconds(webmOpusLaced(7, { lacing, perBlock: 3 }))).toBeCloseTo(0.84, 5);
    }
    // Pakete über 254 Bytes: Xiph-Größe aus mehreren Bytes, EBML-Größe aus zwei Bytes
    const big = new Uint8Array(300);
    big.set([0xf8, 0xff, 0xfe]);
    for (const lacing of ["xiph", "ebml", "fixed"] as const) {
      expect(seconds(webmOpusLaced(9, { lacing, perBlock: 3, packet: big, frozenTime: true }))).toBeCloseTo(0.18, 5);
    }
  });

  test("WebM: Zeitstempel und Duration zählen gar nicht, weder nach unten noch nach oben", () => {
    expect(seconds(webmOpusLaced(667, { frozenTime: true }))).toBeCloseTo(80.04, 5);
    expect(seconds(webmOpusLaced(667, { frozenTime: true, lacing: "none" }))).toBeCloseTo(80.04, 5);
    expect(seconds(webmOpusLaced(667, { durationMs: 5_000 }))).toBeCloseTo(80.04, 5);
    // Eine größere Duration macht aus 1,2 Sekunden Paketen nicht mehr
    expect(seconds(webmOpusLaced(10, { durationMs: 70_000 }))).toBeCloseTo(1.2, 5);
    // Nur Duration, kein einziger Block: nichts zu zählen
    expect(mimeOf(webmWithDuration(7.25))).toBe("audio/webm");
    expect(seconds(webmWithDuration(7.25))).toBeNull();
  });

  test("WebM, dessen Pakete sich nicht sicher zählen lassen: nicht bestimmbar", () => {
    // Anderer Codec als Opus: die Dauer steht nicht im Paket
    expect(seconds(webmOpusLaced(10, { codec: "A_VORBIS" }))).toBeNull();
    // Ungültige Opus-Pakete: leer, Code 3 ohne Frames, Code 3 mit mehr als 120 ms
    expect(seconds(webmOpusLaced(4, { lacing: "none", packet: new Uint8Array(0) }))).toBeNull();
    expect(seconds(webmOpusLaced(4, { packet: bytes([0xfb, 0x00]) }))).toBeNull();
    expect(seconds(webmOpusLaced(4, { packet: bytes([0xfb, 0x07, 1, 2, 3, 4, 5, 6, 7]) }))).toBeNull();
    // Abgeschnitten mitten im letzten Block, und Reste hinter dem letzten Element
    const whole = webmOpusLaced(667);
    expect(audioDurationSeconds(whole.subarray(0, whole.length - 100), "audio/webm")).toBeNull();
    expect(audioDurationSeconds(bytes(webmOpusLaced(10), [0, 0, 0]), "audio/webm")).toBeNull();
    // Gegenprobe: ein gültiger Block zählt 20 ms
    expect(seconds(webmBlock([0x81, 0, 0, 0x80, 0xf8, 0xff, 0xfe]))).toBeCloseTo(0.02, 5);
    // Bündelung, die nicht in den Block passt: mehr Größenangaben als Bytes
    expect(seconds(webmBlock([0x81, 0, 0, 0x82, 5, 3, 0xf8, 0xff, 0xfe]))).toBeNull();
    expect(seconds(webmBlock([0x81, 0, 0, 0x84, 1, 0xf8, 0xff, 0xfe]))).toBeNull();
    // Block auf einer Spur, die es nicht gibt, oder einer Spur mit ContentEncodings
    expect(seconds(webmBlock([0x82, 0, 0, 0x80, 0xf8, 0xff, 0xfe]))).toBeNull();
    const encoded = el(ID.TrackEntry, el(ID.TrackNumber, bytes([1])), el(ID.TrackType, bytes([2])), el(ID.CodecID, bytes("A_OPUS")), el([0x63, 0xa2], OPUS_HEAD), el([0x6d, 0x80]));
    expect(seconds(webmBlock([0x81, 0, 0, 0x80, 0xf8, 0xff, 0xfe], encoded))).toBeNull();
    // Spur ohne OpusHead in CodecPrivate, oder mit etwas anderem darin
    expect(seconds(webmBlock([0x81, 0, 0, 0x80, 0xf8, 0xff, 0xfe], opusTrack({ codecPrivate: null })))).toBeNull();
    expect(seconds(webmBlock([0x81, 0, 0, 0x80, 0xf8, 0xff, 0xfe], opusTrack({ codecPrivate: bytes("OpusTags", new Array(11).fill(0)) })))).toBeNull();
    expect(seconds(webmBlock([0x81, 0, 0, 0x80, 0xf8, 0xff, 0xfe], track(2)))).toBeNull();
    expect(seconds(webmAudioClusters({ knownCluster: true }))).toBeNull();
    // Zwei Tonspuren mit Blöcken: welche ein Decoder nimmt, steht nicht fest
    const second = el(ID.TrackEntry, el(ID.TrackNumber, bytes([2])), el(ID.TrackType, bytes([2])), el(ID.CodecID, bytes("A_OPUS")), el([0x63, 0xa2], OPUS_HEAD));
    const block = (n: number) => el([0xa3], bytes([0x80 | n, 0, 0, 0x80], OPUS_SILENT_20));
    const two = bytes(ebmlHeader(), elUnknown(ID.Segment, el(ID.Tracks, opusTrack(), second), el(ID.Cluster, el([0xe7], bytes([0])), block(1), block(2))));
    expect(seconds(two)).toBeNull();
  });

  test("WebM ohne Blöcke, unbekannter Typ: nicht bestimmbar", () => {
    expect(seconds(webmLive(0))).toBeNull();
    expect(audioDurationSeconds(wavSilence(1), "image/png")).toBeNull();
  });
});

/** Was ein M4A in seinen Tabellen nennt, gelesen ohne den Server-Code: die Größen der Samples, ihre Bytes und die Dauer in den Köpfen */
function m4aSamples(file: Uint8Array) {
  const view = new DataView(file.buffer, file.byteOffset);
  const at = (type: string) => Buffer.from(file).indexOf(type) + 4;
  const count = view.getUint32(at("stsz") + 8);
  const sizes = Array.from({ length: count }, (_, i) => view.getUint32(at("stsz") + 12 + i * 4));
  let pos = view.getUint32(at("stco") + 8);
  const samples = sizes.map(size => file.subarray(pos, (pos += size)));
  return {
    samples,
    // stts: ein Eintrag aus Anzahl und Dauer je Sample
    stts: [view.getUint32(at("stts") + 4), view.getUint32(at("stts") + 8), view.getUint32(at("stts") + 12)],
    // mdhd: Zeitbasis und Dauer
    timescale: view.getUint32(at("mdhd") + 12),
    duration: view.getUint32(at("mdhd") + 16),
    // Hinter dem letzten Sample ist die Datei zu Ende
    rest: file.length - pos,
  };
}

describe("MP4: gezählt werden die AAC-Frames, deren Ende der Server im Bitstrom liest, oder die Opus-Pakete", () => {
  test("zwei AAC-Frames je MP4-Sample, Sample-Tabelle und Kopf nennen 40 Sekunden bei 80 Sekunden Ton: nicht bestimmbar (Regression Runde 5)", () => {
    // Wie in der Prüfung: 3750 Frames in mdat, die Tabelle nennt 1875 Samples zu 8 Bytes
    const packed = mp4Aac(3750, { headerSeconds: 40, framesPerSample: 2 });
    const honest = mp4Aac(3750, { headerSeconds: 40 });
    expect(packed.length).toBe(15_568);
    expect(packed.length).toBe(honest.length);
    expect(mimeOf(packed)).toBe("audio/mp4");
    // Derselbe Ton: nur stts, stsc und stsz unterscheiden sich
    const mdat = (file: Uint8Array) => file.subarray(file.length - 3750 * 4);
    expect(same(mdat(packed), mdat(honest))).toBe(true);
    const view = new DataView(packed.buffer);
    const at = (type: string) => Buffer.from(packed).indexOf(type);
    expect(view.getUint32(at("stsz") + 8)).toBe(8);
    expect(view.getUint32(at("stsz") + 12)).toBe(1875);
    expect(view.getUint32(at("stts") + 12)).toBe(1875);
    expect(view.getUint32(at("stsc") + 16)).toBe(1875);
    expect(prepare(packed)).toBeNull();
    expect(seconds(packed)).toBeNull();
    // Auch mit noch mehr Frames je Sample und bei passender Kopf-Angabe
    expect(seconds(mp4Aac(3750, { framesPerSample: 10 }))).toBeNull();
    expect(seconds(mp4Aac(3750, { headerSeconds: 1, framesPerSample: 3750 }))).toBeNull();
    // Dieselben Frames, je Sample einer: 80 Sekunden, gleich was der Kopf nennt
    expect(seconds(honest)).toBe(80);
    // Schon ein einziges Sample mit zwei Frames unter lauter ehrlichen genügt
    const one = mp4Aac(100);
    const table = Buffer.from(one).indexOf("stsz") + 4;
    expect(seconds(one)).toBeCloseTo((100 * 1024) / 48_000, 9);
    // Tabelle nennt 99 Samples; das letzte wäre 8 Bytes groß, wenn stsz einzelne Größen trüge: hier über einen zweiten Frame im Sample
    const doubled = mp4Aac(100, { frame: [...AAC_SILENT_FRAME, ...AAC_SILENT_FRAME] });
    expect(new DataView(doubled.buffer).getUint32(Buffer.from(doubled).indexOf("stsz") + 8)).toBe(8);
    expect(new DataView(one.buffer).getUint32(table + 4)).toBe(4);
    expect(seconds(doubled)).toBeNull();
  });

  test("kurzes, gültiges AAC-LC wird gezählt: ein Sample, ein Frame, 1024 Abtastwerte (Befund Runde 6)", () => {
    // Die Gegenprobe aus der Prüfung: mp4Aac(47), 756 Bytes, rund eine Sekunde
    const short = mp4Aac(47);
    expect(short.length).toBe(756);
    expect(mimeOf(short)).toBe("audio/mp4");
    expect(seconds(short)).toBeCloseTo((47 * 1024) / 48_000, 9);
    expect(seconds(mp4Aac(586))).toBeCloseTo((586 * 1024) / 48_000, 9);
    // Fragmentiert wie aus MediaRecorder: drei Fragmente zu 47 Frames
    expect(seconds(mp4Fragmented(3))).toBeCloseTo((3 * 47 * 1024) / 48_000, 9);
    expect(seconds(mp4AacFragmented([10, 1, 30]))).toBeCloseTo((41 * 1024) / 48_000, 9);
    // Genau an der Grenze: 2812 Frames bleiben unter 60 Sekunden, 2813 liegen darüber
    expect(seconds(mp4Aac(2812))).toBeLessThanOrEqual(60);
    expect(seconds(mp4Aac(2813))).toBeGreaterThan(60);
  });

  test("Kopf, Sample-Dauern und Fragment-Zeitstempel zählen gar nicht: es zählen die Frames (Fälle aus Runde 4)", () => {
    expect(seconds(mp4Aac(3750))).toBe(80);
    expect(seconds(mp4Aac(3750, { headerSeconds: 1 }))).toBe(80);
    expect(seconds(mp4Aac(3750, { headerSeconds: 1, sampleDelta: 12 }))).toBe(80);
    expect(seconds(mp4Aac(3750, { headerSeconds: 1, sttsSamples: 47 }))).toBe(80);
    // Ein größerer Kopf macht aus einer Sekunde Frames nicht mehr
    expect(seconds(mp4Aac(47, { headerSeconds: 900 }))).toBeCloseTo((47 * 1024) / 48_000, 9);
    // tfdt zurückgesetzt, stehend, mit Lücke: 2813 + 469 Frames sind 70,016 Sekunden
    for (const tfdt of [() => 0, (i: number) => i * 1024, (_: number, start: number) => start + 10_000_000]) {
      expect(seconds(mp4AacFragmented([2813, 469], { tfdt }))).toBeCloseTo(70.016, 9);
    }
    expect(seconds(mp4AacFragmented([2813, 469], { sampleDelta: 1 }))).toBeCloseTo(70.016, 9);
    expect(seconds(mp4Fragmented(75))).toBeCloseTo((75 * 47 * 1024) / 48_000, 9);
  });

  test("weiter geht ein neu geschriebenes M4A mit genau den gezählten Frames und eigenen Zeitangaben", () => {
    const out = prepare(mp4Aac(586))!;
    expect(out.mime).toBe("audio/mp4");
    expect(mimeOf(out.audio)).toBe("audio/mp4");
    const read = m4aSamples(out.audio);
    expect(read.samples).toHaveLength(586);
    expect(read.samples.every(s => same(s, new Uint8Array(AAC_SILENT_FRAME)))).toBe(true);
    expect(read.rest).toBe(0);
    // Dauer in den Köpfen: Frames mal 1024 in der Zeitbasis der Abtastrate
    expect(read.stts).toEqual([1, 586, 1024]);
    expect([read.timescale, read.duration]).toEqual([48_000, 586 * 1024]);
    // Kopf-Angaben, Sample-Dauern, Fragmente und tfdt des Uploads hinterlassen keine Spur
    for (const upload of [
      mp4Aac(586, { headerSeconds: 1 }),
      mp4Aac(586, { headerSeconds: 900, sampleDelta: 12 }),
      mp4Aac(586, { sttsSamples: 47 }),
      mp4AacFragmented([500, 86]),
      mp4AacFragmented([1, 585], { tfdt: () => 0, sampleDelta: 1 }),
    ]) {
      expect(same(prepare(upload)!.audio, out.audio)).toBe(true);
    }
    // Füllelemente im Sample bleiben zurück: ein Füllelement mit zwei Bytes (Kennung 110, Anzahl 0010) vor dem Frame, heraus kommt der schlichte Frame
    const text = "1100010" + "10100101".repeat(2) + AAC_SILENT_FRAME.map(b => b.toString(2).padStart(8, "0")).join("");
    const filled = Array.from({ length: Math.ceil(text.length / 8) }, (_, i) => parseInt(text.slice(i * 8, i * 8 + 8).padEnd(8, "0"), 2));
    expect(filled).toHaveLength(7);
    expect(same(prepare(mp4Aac(586, { frame: filled }))!.audio, out.audio)).toBe(true);
  });

  test("Füllelement, über das ffmpeg hinausliest und dahinter einen zweiten Frame findet: gezählt wird ein Frame je Sample, und nur der geht weiter", () => {
    // Der versteckte Frame steht ab Byte 7 im Sample, mitten im zweiten Füllelement
    expect(AAC_FILL_OVERREAD.slice(7, 11)).toEqual(AAC_SILENT_FRAME);
    const upload = mp4Aac(1000, { frame: AAC_FILL_OVERREAD });
    expect(mimeOf(upload)).toBe("audio/mp4");
    const out = prepare(upload)!;
    // Nach der Syntax ein Frame je Sample: 1000 Frames
    expect(out.seconds).toBe((1000 * 1024) / 48_000);
    // Weiter geht je Sample nur das Kanal-Element mit der Ende-Kennung: dieselbe Datei wie aus 1000 schlichten Frames.
    // Die Füllelemente, an denen sich ein Decoder verlesen könnte, erreichen die Erkennung nicht
    expect(same(out.audio, prepare(mp4Aac(1000))!.audio)).toBe(true);
    const read = m4aSamples(out.audio);
    expect(read.samples).toHaveLength(1000);
    expect(read.samples.every(sample => same(sample, new Uint8Array(AAC_SILENT_FRAME)))).toBe(true);
    expect(Buffer.from(out.audio).includes(Buffer.from(AAC_FILL_OVERREAD.slice(3, 7)))).toBe(false);
    // 3000 solcher Samples zählen 64 Sekunden
    expect(seconds(mp4Aac(3000, { frame: AAC_FILL_OVERREAD }))).toBe(64);
  });

  test("echte Aufnahmen: Chrome, ffmpeg (fragmentiert, moov am Ende, Stereo) und der Encoder von macOS", () => {
    // [Datei, Frames, Abtastrate]: je Frame 1024 Abtastwerte
    const files: [string, number, number][] = [
      ["chrome-aac.mp4", 71, 48_000],
      ["fragmented-iso5-aac.mp4", 6, 16_000],
      ["moov-end-aac.mp4", 6, 16_000],
      ["stereo-aac.m4a", 32, 44_100],
      ["apple-aac.m4a", 19, 24_000],
    ];
    for (const [name, frames, rate] of files) {
      const file = recording(name);
      expect(mimeOf(file), name).toBe("audio/mp4");
      const out = prepare(file);
      expect(out, name).not.toBeNull();
      expect(out!.mime, name).toBe("audio/mp4");
      expect(out!.seconds, name).toBe((frames * 1024) / rate);
      const read = m4aSamples(out!.audio);
      expect(read.samples, name).toHaveLength(frames);
      expect([read.timescale, read.duration, read.rest], name).toEqual([rate, frames * 1024, 0]);
      // Nichts dazugekommen: die Frames sind zusammen nicht größer als der Upload
      expect(read.samples.reduce((n, s) => n + s.length, 0), name).toBeLessThan(file.length);
    }
    // Ein gekipptes Bit in den Huffman-Codes des ersten Frames verschiebt sein Ende: das Sample ist dann kein einzelner Frame mehr
    const broken = recording("stereo-aac.m4a").slice();
    const first = new DataView(broken.buffer).getUint32(Buffer.from(broken).indexOf("stco") + 4 + 8);
    broken[first + 27] ^= 0x10;
    expect(prepare(broken)).toBeNull();
    // Zwei echte Frames (Stereo, 44,1 kHz) in einem Sample: nicht bestimmbar; je Sample einer: gezählt
    const [a, b] = m4aSamples(prepare(recording("stereo-aac.m4a"))!.audio).samples;
    const stereo = { asc: [0x12, 0x10] };
    expect(seconds(mp4Aac(10, { ...stereo, frame: a }))).toBe((10 * 1024) / 44_100);
    expect(seconds(mp4Aac(10, { ...stereo, frame: b }))).toBe((10 * 1024) / 44_100);
    expect(seconds(mp4Aac(10, { ...stereo, frame: [...a, ...b] }))).toBeNull();
  });

  test("MP4 mit Opus, wie Chrome audio/mp4 aufnimmt: gezählt werden die Opus-Pakete, weiter geht Ogg/Opus", () => {
    const chrome = prepare(recording("chrome-opus.mp4"))!;
    expect(chrome.mime).toBe("audio/ogg");
    expect(mimeOf(chrome.audio)).toBe("audio/ogg");
    // 25 Pakete zu 60 ms wie in der WebM-Aufnahme desselben Browsers
    expect(chrome.seconds).toBe(1.5);
    const pages = oggPages(chrome.audio);
    expect(pages.every(p => p.crcOk)).toBe(true);
    expect(pages.slice(2).flatMap(p => p.packets)).toHaveLength(25);
    expect(pages[pages.length - 1].granule).toBe(1.5 * 48_000);
    // OpusHead aus dOps: Version 1, mono, Pre-Skip 3840 und 48 kHz in Little-Endian
    expect(String.fromCharCode(...pages[0].packets[0].subarray(0, 8))).toBe("OpusHead");
    expect([...pages[0].packets[0].subarray(8, 19)]).toEqual([1, 1, 0x00, 0x0f, 0x80, 0xbb, 0, 0, 0, 0, 0]);
    // Dieselben Pakete und derselbe Kopf im MP4 wie im Ogg: Byte für Byte dasselbe Ergebnis
    expect(same(prepare(mp4Opus(2000))!.audio, prepare(oggOpusStream(40))!.audio)).toBe(true);
    expect(seconds(mp4Opus(3001))).toBeCloseTo(60.02, 9);
    expect(seconds(mp4Opus(100, { headerSeconds: 1, sampleDelta: 1 }))).toBeCloseTo(2, 9);
    expect(seconds(mp4Opus(100, { frame: OPUS_SILENT_120 }))).toBeCloseTo(12, 9);
    // Nicht bestimmbar: ohne dOps, mit unbekannter Version, mit ungültigen oder leeren Paketen
    expect(seconds(mp4Opus(100, { dops: null }))).toBeNull();
    expect(seconds(mp4Opus(100, { dops: [1, 1, 0x01, 0x38, 0, 0, 0xbb, 0x80, 0, 0, 0] }))).toBeNull();
    expect(seconds(mp4Opus(100, { frame: [0xfb, 0x00] }))).toBeNull();
    expect(seconds(mp4Opus(100, { frame: [0xfb, 0x07, 1, 2, 3, 4, 5, 6, 7] }))).toBeNull();
  });

  test("nicht bestimmbar: andere Codecs, andere AAC-Arten, kaputte Tabellen, abgeschnittene Dateien", () => {
    // AAC-Stille in einem Eintrag, der Opus heißt, aber kein dOps trägt; ALAC; MP3 im mp4a (Objekttyp 0x6b)
    expect(seconds(mp4Aac(100, { entry: "Opus" }))).toBeNull();
    expect(seconds(mp4Aac(100, { entry: "alac" }))).toBeNull();
    expect(seconds(mp4Aac(100, { objectType: 0x6b }))).toBeNull();
    // AudioSpecificConfig: AAC Main, SBR als Objekttyp, frei angegebene Abtastrate, 960 Abtastwerte je Frame, ohne und mit sechs Kanälen
    for (const asc of [[0x09, 0x88], [0x2b, 0x8b, 0x08, 0x80], [0x17, 0x80, 0x5d, 0xc0, 0x08], [0x11, 0x8c], [0x11, 0x80], [0x11, 0xb0], [0x11]]) {
      expect(seconds(mp4Aac(100, { asc })), asc.join()).toBeNull();
    }
    // Gegenprobe: 16 kHz mono wird gezählt, mit der Rate aus der AudioSpecificConfig
    expect(seconds(mp4Aac(100, { asc: [0x14, 0x08] }))).toBe((100 * 1024) / 16_000);
    // Zwei Kanäle in der Konfiguration, aber ein Einzelkanal-Element im Frame
    expect(seconds(mp4Aac(100, { asc: [0x11, 0x90] }))).toBeNull();
    // Kein einziges Sample
    expect(seconds(mp4Aac(0))).toBeNull();
    expect(seconds(mp4Fragmented(0))).toBeNull();
    // Abgeschnitten, Reste hinter der letzten Box
    const whole = mp4Aac(100);
    expect(audioDurationSeconds(whole.subarray(0, whole.length - 3), "audio/mp4")).toBeNull();
    expect(audioDurationSeconds(bytes(whole, [0, 0, 0]), "audio/mp4")).toBeNull();
    // Chunk-Versatz zeigt hinter die Datei, oder auf den Anfang (Samples wären keine Frames)
    const patched = (value: number) => {
      const file = whole.slice();
      new DataView(file.buffer).setUint32(Buffer.from(file).indexOf("stco") + 4 + 8, value);
      return file;
    };
    expect(seconds(patched(whole.length - 399))).toBeNull();
    expect(seconds(patched(0))).toBeNull();
    expect(seconds(patched(whole.length - 400))).toBeCloseTo((100 * 1024) / 48_000, 9);
    // Fragment für eine andere Spur
    expect(seconds(mp4AacFragmented([47, 47], { trackId: 2 }))).toBeNull();
    // Das zweite Fragment zeigt zurück auf die Frames des ersten: kein Sample zählt zweimal
    const twice = mp4AacFragmented([47, 47]);
    expect(seconds(twice)).toBeCloseTo((94 * 1024) / 48_000, 9);
    const buffer = Buffer.from(twice);
    const secondMoof = buffer.indexOf("moof", buffer.indexOf("moof") + 4) - 4;
    // trun: nach Flags und Anzahl der Datenversatz ab dem Anfang von moof, mit Vorzeichen
    new DataView(twice.buffer).setInt32(buffer.indexOf("trun", secondMoof) + 4 + 8, buffer.indexOf("mdat") + 4 - secondMoof);
    expect(mimeOf(twice)).toBe("audio/mp4");
    expect(seconds(twice)).toBeNull();
    // Zwei Tonspuren: welche ein Decoder nimmt, steht nicht fest
    const moovAt = Buffer.from(whole).indexOf("moov") - 4;
    const trakAt = Buffer.from(whole).indexOf("trak") - 4;
    const trak = whole.subarray(trakAt, trakAt + new DataView(whole.buffer).getUint32(trakAt));
    const mdat = whole.subarray(moovAt + new DataView(whole.buffer).getUint32(moovAt));
    const mvhd = whole.subarray(moovAt + 8, trakAt);
    const two = bytes(whole.subarray(0, moovAt), box("moov", mvhd, trak, trak), mdat);
    expect(mimeOf(two)).toBe("audio/mp4");
    expect(seconds(two)).toBeNull();
  });
});

describe("prepareSpeechAudio: weiter geht nur, was gezählt wurde", () => {
  /** Alles, was angenommen wird, quer durch die Formate und Sonderfälle */
  const accepted: [string, Uint8Array][] = [
    ["WAV PCM16", wavSilence(1.2)],
    ["WAV aus einem Strom", wavSilence(2, { dataSize: 0xffffffff })],
    ["WAV Stereo", wavWithFormat(fmt(1, 2, 16_000, 4, 16))],
    ["WAV 8 Bit", wavWithFormat(fmt(1, 1, 8_000, 1, 8))],
    ["WAV Gleitkomma", wavWithFormat(fmt(3, 1, 16_000, 4, 32))],
    ["WAV EXTENSIBLE", wavWithFormat(fmt(0xfffe, 1, 16_000, 2, 16, extensible(1)))],
    ["Ogg/Opus (ffmpeg)", oggOpusFixture()],
    ["Ogg/Opus", oggOpusStream(40)],
    ["Ogg/Opus verkettet", oggOpusChained(10, 25)],
    ["Ogg/Opus mit verstellten Granule-Positionen", oggOpusStream(40, 1, { granule: () => 48_312 })],
    ["Ogg/Opus mit Paketen zu 120 ms", oggOpusStream(3, 1, { packet: OPUS_SILENT_120 })],
    ["WebM/Opus (Chrome)", recording("chrome-opus.webm")],
    ["WebM/Opus wie MediaRecorder", webmLive(3)],
    ["WebM/Opus gebündelt", webmOpusLaced(500)],
    ["WebM/Opus mit Duration", webmOpusLaced(10, { durationMs: 70_000 })],
    ["MP3", mp3FrameFixture()],
    ["MP3 mit ID3", mp3Id3Fixture()],
    ["M4A AAC-LC", mp4Aac(586)],
    ["M4A mit verstellten Kopf-Angaben", mp4Aac(586, { headerSeconds: 1, sampleDelta: 12 })],
    ["MP4 AAC-LC fragmentiert", mp4Fragmented(3)],
    ["MP4 AAC-LC (Chrome)", recording("chrome-aac.mp4")],
    ["MP4 AAC-LC (ffmpeg, fragmentiert)", recording("fragmented-iso5-aac.mp4")],
    ["M4A AAC-LC Stereo (ffmpeg)", recording("stereo-aac.m4a")],
    ["M4A AAC-LC Stereo (macOS)", recording("apple-aac.m4a")],
    ["MP4 Opus (Chrome)", recording("chrome-opus.mp4")],
    ["MP4 Opus", mp4Opus(500)],
  ];

  test("Fixpunkt: die vorbereitete Aufnahme noch einmal vorbereitet ergibt dieselben Bytes und dieselbe Dauer", () => {
    for (const [name, file] of accepted) {
      const first = prepare(file);
      expect(first, name).not.toBeNull();
      // Der Typ der vorbereiteten Datei ist an ihren Bytes erkennbar und stimmt mit der Angabe überein
      expect(mimeOf(first!.audio), name).toBe(first!.mime);
      const again = prepareSpeechAudio(first!.audio, first!.mime);
      expect(again, name).not.toBeNull();
      expect(again!.seconds, name).toBe(first!.seconds);
      expect(same(again!.audio, first!.audio), name).toBe(true);
      // Nie die Bytes des Uploads selbst: eine eigene, neu geschriebene Datei
      expect(first!.audio.buffer, name).not.toBe(file.buffer);
    }
  });

  test("WAV: weiter geht ein neu geschriebenes WAV aus 44 Bytes Kopf und den gezählten Blöcken", () => {
    const clean = wavSilence(1);
    // Ein sauberes PCM16-WAV (wie vom Browser) kommt Byte für Byte gleich heraus
    expect(same(prepare(clean)!.audio, clean)).toBe(true);
    // LIST vor den Daten, Reste dahinter, Größe aus einem Strom: heraus kommt dasselbe saubere WAV
    const data = new Uint8Array(32_000);
    const head = (...chunks: Uint8Array[]) => join2(bytes("RIFF", u32(0), "WAVE"), chunk("fmt ", new Uint8Array(fmt(1, 1, 16_000, 2, 16))), ...chunks);
    const list = chunk("LIST", bytes("INFOICMT", u32(4), "tybo"));
    for (const file of [head(list, chunk("data", data)), head(chunk("data", data), list), head(chunk("data", data), bytes([1, 2, 3])), wavSilence(1, { dataSize: 0 })]) {
      const out = prepare(file)!;
      expect(out.seconds).toBe(1);
      expect(same(out.audio, clean)).toBe(true);
    }
    // Ein angebrochener Block am Ende zählt nicht und geht nicht weiter
    const odd = prepare(head(chunk("data", new Uint8Array(32_001))))!;
    expect(same(odd.audio, clean)).toBe(true);
    // EXTENSIBLE wird zum schlichten fmt-Block mit dem Codec aus dem SubFormat
    const ext = prepare(wavWithFormat(fmt(0xfffe, 1, 16_000, 2, 16, extensible(1))))!;
    expect(same(ext.audio, clean)).toBe(true);
    // Gleitkomma bleibt Gleitkomma, 8 Bit bleibt 8 Bit
    const float = new DataView(prepare(wavWithFormat(fmt(3, 1, 16_000, 4, 32)))!.audio.buffer);
    expect([float.getUint16(20, true), float.getUint16(34, true), float.getUint32(40, true)]).toEqual([3, 32, 32_000]);
    // Zwei fmt-Blöcke: welcher gilt, steht nicht fest
    expect(prepare(head(chunk("fmt ", new Uint8Array(fmt(1, 1, 8_000, 1, 8))), chunk("data", data)))).toBeNull();
  });

  test("WAV mit einem zweiten data-Block: gezählt und weitergereicht wird nur der erste (ffmpeg dekodiert im Upload beide)", () => {
    // 1 Sekunde, dahinter ein zweiter data-Block mit 62 Sekunden: zusammen unter 2 MB
    const hidden = join2(wavSilence(1), chunk("data", new Uint8Array(62 * 32_000)));
    expect(hidden.length).toBeLessThan(MAX_SPEECH_BYTES);
    expect(mimeOf(hidden)).toBe("audio/wav");
    const out = prepare(hidden)!;
    expect(out.seconds).toBe(1);
    // Der zweite Block erreicht die Erkennung nicht: heraus kommt genau das WAV von einer Sekunde
    expect(out.audio.length).toBe(44 + 32_000);
    expect(same(out.audio, wavSilence(1))).toBe(true);
    // Dasselbe mit 8 kHz und 8 Bit: 1 Sekunde gezählt, dahinter 200 Sekunden
    const small = join2(bytes("RIFF", u32(0), "WAVE"), chunk("fmt ", new Uint8Array(fmt(1, 1, 8_000, 1, 8))), chunk("data", new Uint8Array(8_000)), chunk("data", new Uint8Array(200 * 8_000)));
    expect(prepare(small)!.seconds).toBe(1);
    expect(prepare(small)!.audio.length).toBe(44 + 8_000);
  });

  test("Ogg: weiter geht ein neu geschriebener Stream mit genau den gezählten Paketen und eigenen Zeitangaben", () => {
    const honest = prepare(oggOpusStream(40))!;
    const pages = oggPages(honest.audio);
    expect(pages.every(p => p.crcOk)).toBe(true);
    expect(pages.map(p => p.serial)).toEqual(new Array(pages.length).fill(1));
    expect(pages.map(p => p.sequence)).toEqual(pages.map((_, i) => i));
    // Erste Seite: OpusHead unverändert, zweite: OpusTags, danach nur die 2000 Pakete
    expect(pages[0].flags).toBe(0x02);
    expect(same(pages[0].packets[0], OPUS_HEAD)).toBe(true);
    expect(String.fromCharCode(...pages[1].packets[0].subarray(0, 8))).toBe("OpusTags");
    const packets = pages.slice(2).flatMap(p => p.packets);
    expect(packets).toHaveLength(2000);
    expect(packets.every(p => same(p, OPUS_SILENT_20))).toBe(true);
    // Die Granule-Position läuft mit den Paketen und endet bei ihrer Summe, die letzte Seite schließt den Stream
    expect(pages[pages.length - 1].granule).toBe(40 * 48_000);
    expect(pages[pages.length - 1].flags).toBe(0x04);
    let sum = 0;
    for (const page of pages.slice(2)) {
      sum += page.packets.length * 960;
      expect(page.granule).toBe(sum);
    }
    // Verstellte Granule-Positionen im Upload hinterlassen keine Spur: dieselben Bytes wie beim ehrlichen Stream
    for (const granule of [() => 48_312, () => 0, (s: number) => (81 - s) * 480, (s: number) => OGG_PRE_SKIP + (s + 60) * 48_000]) {
      expect(same(prepare(oggOpusStream(40, 1, { granule }))!.audio, honest.audio)).toBe(true);
    }
    // Verkettet: zwei Streams hintereinander mit den Seriennummern 1 und 2, jeder mit eigener Zählung
    const chain = oggPages(prepare(oggOpusChained(10, 25))!.audio);
    expect([...new Set(chain.map(p => p.serial))]).toEqual([1, 2]);
    expect(chain.filter(p => p.flags & 0x04).map(p => p.granule)).toEqual([10 * 48_000, 25 * 48_000]);
    expect(chain.every(p => p.crcOk)).toBe(true);
    // Pakete über 254 Bytes belegen mehrere Segmente und kommen ganz an, auch mit genau 510 Bytes (Segmente 255, 255, 0)
    for (const size of [300, 510]) {
      const big = new Uint8Array(size);
      big.set([0xf8, 0xff, 0xfe]);
      const bigPages = oggPages(prepare(webmOpusLaced(200, { packet: big, lacing: "fixed" }))!.audio);
      expect(bigPages.slice(2).flatMap(p => p.packets)).toHaveLength(200);
      expect(bigPages.slice(2).flatMap(p => p.packets).every(p => same(p, big))).toBe(true);
      expect(bigPages.every(p => p.crcOk)).toBe(true);
      expect(bigPages[bigPages.length - 1].granule).toBe(200 * 960);
    }
  });

  test("WebM: weiter geht Ogg/Opus mit dem OpusHead der Spur und genau den gezählten Paketen", () => {
    const out = prepare(webmOpusLaced(667))!;
    expect(out.mime).toBe("audio/ogg");
    expect(mimeOf(out.audio)).toBe("audio/ogg");
    const pages = oggPages(out.audio);
    expect(pages.every(p => p.crcOk)).toBe(true);
    expect(same(pages[0].packets[0], OPUS_HEAD)).toBe(true);
    const packets = pages.slice(2).flatMap(p => p.packets);
    expect(packets).toHaveLength(667);
    expect(packets.every(p => same(p, OPUS_SILENT_120))).toBe(true);
    expect(pages[pages.length - 1].granule).toBe(667 * 5760);
    // Bündelung, Zeitstempel und Duration des Uploads hinterlassen keine Spur
    for (const opts of [{ lacing: "none" }, { lacing: "ebml" }, { lacing: "fixed" }, { frozenTime: true }, { durationMs: 5_000 }, { durationMs: 900_000 }, { perBlock: 7 }] as const) {
      expect(same(prepare(webmOpusLaced(667, opts))!.audio, out.audio)).toBe(true);
    }
    // Echte Aufnahme aus Chrome: 25 Pakete zu 60 ms
    const chrome = oggPages(prepare(recording("chrome-opus.webm"))!.audio);
    expect(chrome.slice(2).flatMap(p => p.packets)).toHaveLength(25);
    expect(chrome[chrome.length - 1].granule).toBe(1.5 * 48_000);
  });

  test("MP3: weiter gehen nur die vollständigen Frames, lückenlos hintereinander", () => {
    const frames = mp3FrameFixture();
    // ID3-Kopf bleibt zurück
    expect(same(prepare(mp3Id3Fixture())!.audio, frames)).toBe(true);
    // Fünf Frames zu 72 Bytes; Auffüllung dazwischen und ein ID3v1-Block am Ende bleiben zurück
    expect(frames.length).toBe(5 * 72);
    const id3v1 = bytes("TAG", new Array(125).fill(0x20));
    const padded = bytes(frames.subarray(0, 144), new Array(50).fill(0), frames.subarray(144), id3v1);
    expect(prepare(padded)!.seconds).toBeCloseTo(0.18, 5);
    expect(same(prepare(padded)!.audio, frames)).toBe(true);
    // Ein abgeschnittener letzter Frame zählt nicht und geht nicht weiter
    const cut = prepare(frames.subarray(0, 300))!;
    expect(cut.seconds).toBeCloseTo((4 * 576) / 16_000, 5);
    expect(same(cut.audio, frames.subarray(0, 288))).toBe(true);
    // Ein Frame mit anderer Abtastrate (MPEG 1, 44,1 kHz, 417 Bytes) mitten in der Datei gehört nicht zur Kette
    const foreign = new Uint8Array(417);
    foreign.set([0xff, 0xfb, 0x90, 0x00]);
    const mixed = bytes(frames.subarray(0, 144), foreign, frames.subarray(144));
    expect(prepare(mixed)!.seconds).toBeCloseTo(0.18, 5);
    expect(same(prepare(mixed)!.audio, frames)).toBe(true);
  });
});
