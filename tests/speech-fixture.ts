/**
 * Aufnahmen für die Tests des Sprechmodus (Issue #249). Kein Test selbst.
 * Alles hier ist künstlich erzeugt: Stille in den Ton-Einheiten, die der
 * Server zählt, dazu Container-Angaben, die sich verstellen lassen.
 */

import { bytes, el, elUnknown, ebmlHeader, ID, track } from "./media-fixture";

function u32le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff];
}
function u16le(n: number): number[] {
  return [n & 0xff, (n >>> 8) & 0xff];
}
function u32be(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}

/** WAV, PCM16 mono mit 16 kHz (wie der Browser in #250), Stille der gegebenen Dauer */
export function wavSilence(seconds: number, opts: { sampleRate?: number; dataSize?: number } = {}): Uint8Array {
  const sampleRate = opts.sampleRate ?? 16_000;
  const data = new Uint8Array(Math.round(seconds * sampleRate) * 2);
  const head = bytes(
    "RIFF",
    u32le(36 + data.length),
    "WAVE",
    "fmt ",
    u32le(16),
    u16le(1),
    u16le(1),
    u32le(sampleRate),
    u32le(sampleRate * 2),
    u16le(2),
    u16le(16),
    "data",
    u32le(opts.dataSize ?? data.length)
  );
  // Nicht über bytes(): das streut jedes Byte einzeln und scheitert bei Megabytes
  const out = new Uint8Array(head.length + data.length);
  out.set(head);
  return out;
}

/**
 * Gültiges komprimiertes WAV: IMA ADPCM (Codec 0x11), 16 kHz mono, 4 Bit je
 * Abtastwert, Blöcke zu 1024 Bytes mit je 2041 Abtastwerten, mit fact-Block.
 * Stille der gegebenen Dauer; 80 Sekunden sind rund 640 KB.
 */
export function wavImaAdpcm(seconds: number): Uint8Array {
  const sampleRate = 16_000;
  const blockAlign = 1024;
  const samplesPerBlock = (blockAlign - 4) * 2 + 1;
  const blocks = Math.ceil((seconds * sampleRate) / samplesPerBlock);
  // Jeder Block: Startwert 0, Schrittindex 0, danach Nibbles 0 (keine Änderung)
  const data = new Uint8Array(blocks * blockAlign);
  const head = bytes(
    "RIFF",
    u32le(4 + 8 + 20 + 8 + 4 + 8 + data.length),
    "WAVE",
    "fmt ",
    u32le(20),
    u16le(0x11),
    u16le(1),
    u32le(sampleRate),
    u32le(Math.round((sampleRate * blockAlign) / samplesPerBlock)),
    u16le(blockAlign),
    u16le(4),
    u16le(2),
    u16le(samplesPerBlock),
    "fact",
    u32le(4),
    u32le(blocks * samplesPerBlock),
    "data",
    u32le(data.length)
  );
  const out = new Uint8Array(head.length + data.length);
  out.set(head);
  return out;
}

/** WAV-Kopf mit frei wählbarem fmt-Block und einer Sekunde Platz für 16 kHz PCM16 mono (32000 Bytes) */
export function wavWithFormat(fmt: number[]): Uint8Array {
  const data = new Uint8Array(32_000);
  const head = bytes("RIFF", u32le(4 + 8 + fmt.length + 8 + data.length), "WAVE", "fmt ", u32le(fmt.length), fmt, "data", u32le(data.length));
  const out = new Uint8Array(head.length + data.length);
  out.set(head);
  return out;
}

/** MP4-Box */
export function box(type: string, ...children: (number[] | string | Uint8Array)[]): Uint8Array {
  const payload = bytes(...children);
  return bytes(u32be(8 + payload.length), type, payload);
}

/** Abtastrate der künstlichen AAC-Spuren und Abtastwerte je AAC-Frame */
export const AAC_RATE = 48_000;
export const AAC_FRAME = 1024;
/** Sekunden, die ein Decoder für so viele AAC-Frames ausgibt */
export const aacSeconds = (frames: number) => (frames * AAC_FRAME) / AAC_RATE;

/** AAC-LC-Stille, mono: ein Frame, wie ihn ffmpeg für Stille schreibt (Einzelkanal-Element ohne Bänder, dann die Ende-Kennung) */
export const AAC_SILENT_FRAME = [0x01, 0x18, 0x20, 0x07];
/** AudioSpecificConfig: AAC-LC, 48 kHz, mono, 1024 Abtastwerte je Frame */
const AAC_LC_48K_MONO = [0x11, 0x88];

export interface Mp4Options {
  /** Dauer in mvhd und mdhd (Sekunden) statt der echten; die Sample-Tabelle bleibt */
  headerSeconds?: number;
  /** Dauer je Sample in stts bzw. als Standard in trex statt 1024 */
  sampleDelta?: number;
  /** Anzahl der Samples in stts statt der echten (Widerspruch zu stsz) */
  sttsSamples?: number;
  /** Art des Eintrags in stsd, Standard mp4a */
  entry?: string;
  /** Objekttyp im esds, Standard 0x40 (MPEG-4 Audio) */
  objectType?: number;
  /** AudioSpecificConfig, Standard AAC-LC mit 48 kHz mono */
  asc?: number[];
  /**
   * So viele AAC-Frames je MP4-Sample statt einem: die Sample-Tabelle (stts,
   * stsc, stsz) nennt entsprechend weniger und größere Samples, der Ton in
   * mdat bleibt derselbe. ffmpeg dekodiert alle Frames
   */
  framesPerSample?: number;
  /** Inhalt eines Frames statt der Stille: jedes Sample trägt diese Bytes */
  frame?: number[] | Uint8Array;
  /** Der ganze Eintrag in stsd statt mp4a mit esds (etwa Opus mit dOps) */
  sampleEntry?: Uint8Array;
}

const frameOf = (opts: Mp4Options) => opts.frame ?? AAC_SILENT_FRAME;

/**
 * Ein MP4-Sample, das nach der AAC-Syntax genau ein Frame ist, aus dem ffmpeg
 * aber zwei dekodiert: Kanal-Element (Stille), ein Füllelement mit einem Byte
 * (Art 1011, Dynamik), ein Füllelement mit fünf Bytes, Ende-Kennung. ffmpeg
 * 9.0.1 liest bei der Dynamik ein Byte über das erste Füllelement hinaus,
 * sieht dadurch mitten im zweiten eine Ende-Kennung und dekodiert dessen Rest
 * (ab Byte 7 ein vollständiger Stille-Frame) als weiteren Frame. Gemessen:
 * aus mp4Aac(1000, { frame: AAC_FILL_OVERREAD }) dekodiert ffmpeg 2000 Frames,
 * aus der vom Server weitergereichten Datei 1000.
 */
export const AAC_FILL_OVERREAD = [0x01, 0x18, 0x20, 0x06, 0x1b, 0x0c, 0xae, 0x01, 0x18, 0x20, 0x07, 0x1c];

/** moov mit einer AAC-Spur (Nummer 1): frames Samples in der Tabelle ab chunkOffset, dazu weitere Boxen (mvex) */
function aacMoov(frames: number, chunkOffset: number, opts: Mp4Options, ...extra: Uint8Array[]): Uint8Array {
  const seconds = opts.headerSeconds ?? aacSeconds(frames);
  const asc = opts.asc ?? AAC_LC_48K_MONO;
  const perSample = opts.framesPerSample ?? 1;
  const samples = frames / perSample;
  const config = bytes([0x04, 13 + 2 + asc.length, opts.objectType ?? 0x40, 0x15, 0, 0, 0], u32be(0), u32be(0), [0x05, asc.length], asc);
  const esds = box("esds", [0, 0, 0, 0], [0x03, 3 + config.length + 3, 0, 1, 0], config, [0x06, 1, 2]);
  const entry = opts.sampleEntry ?? box(opts.entry ?? "mp4a", [0, 0, 0, 0, 0, 0, 0, 1], new Array(8).fill(0), [0, 1, 0, 16, 0, 0, 0, 0], u32be(AAC_RATE * 65536), esds);
  const stbl = box(
    "stbl",
    box("stsd", [0, 0, 0, 0], u32be(1), entry),
    box("stts", [0, 0, 0, 0], ...(frames ? [u32be(1), u32be(opts.sttsSamples ?? samples), u32be(opts.sampleDelta ?? AAC_FRAME)] : [u32be(0)])),
    box("stsc", [0, 0, 0, 0], ...(frames ? [u32be(1), u32be(1), u32be(samples), u32be(1)] : [u32be(0)])),
    // Alle Samples gleich groß
    box("stsz", [0, 0, 0, 0], u32be(frames ? frameOf(opts).length * perSample : 0), u32be(samples)),
    box("stco", [0, 0, 0, 0], ...(frames ? [u32be(1), u32be(chunkOffset)] : [u32be(0)]))
  );
  const trak = box(
    "trak",
    box("tkhd", [0, 0, 0, 7], u32be(0), u32be(0), u32be(1), u32be(0), u32be(Math.round(seconds * 1000)), new Array(60).fill(0)),
    box(
      "mdia",
      box("mdhd", [0, 0, 0, 0], u32be(0), u32be(0), u32be(AAC_RATE), u32be(Math.round(seconds * AAC_RATE)), [0x55, 0xc4, 0, 0]),
      box("hdlr", [0, 0, 0, 0], [0, 0, 0, 0], "soun", new Array(13).fill(0)),
      box("minf", box("smhd", new Array(8).fill(0)), box("dinf", box("dref", [0, 0, 0, 0], u32be(1), box("url ", [0, 0, 0, 1]))), stbl)
    )
  );
  const mvhd = box("mvhd", [0, 0, 0, 0], u32be(0), u32be(0), u32be(1000), u32be(Math.round(seconds * 1000)), [0, 1, 0, 0, 1, 0], new Array(70).fill(0), u32be(2));
  return box("moov", mvhd, trak, ...extra);
}

const FTYP = () => box("ftyp", "M4A ", [0, 0, 0, 0], "isom");

function aacFrames(frames: number, opts: Mp4Options = {}): Uint8Array {
  const frame = frameOf(opts);
  const out = new Uint8Array(frames * frame.length);
  for (let i = 0; i < frames; i++) out.set(frame, i * frame.length);
  return out;
}

/**
 * Gültig dekodierbares M4A (AAC-LC, mono, 48 kHz) mit Stille: frames Samples
 * in der Sample-Tabelle (stts, stsc, stsz, stco), jedes ein AAC-Frame mit 1024
 * Abtastwerten. 3750 Frames sind 80 Sekunden in rund 16 KB. Mit headerSeconds
 * nennen mvhd und mdhd eine andere Dauer, Ton und Tabelle bleiben gleich.
 */
export function mp4Aac(frames: number, opts: Mp4Options = {}): Uint8Array {
  const ftyp = FTYP();
  // Die Größe von moov hängt nicht vom Versatz ab: erst messen, dann mit dem Versatz bauen
  const offset = ftyp.length + aacMoov(frames, 0, opts).length + 8;
  return bytes(ftyp, aacMoov(frames, offset, opts), box("mdat", aacFrames(frames, opts)));
}

/** dOps (Opus in ISOBMFF): mono, Pre-Skip 312, 48 kHz, wie OPUS_HEAD weiter unten, hier Big-Endian und mit Version 0 */
const DOPS = [0, 1, 0x01, 0x38, ...u32be(48_000), 0, 0, 0];

/**
 * MP4 mit Opus, wie Chrome audio/mp4 aufnimmt: Eintrag Opus mit dOps, jedes
 * Sample ein Opus-Paket (Standard 20 ms Stille). Mit dops lässt sich die
 * dOps-Box verstellen, null lässt sie weg.
 */
export function mp4Opus(packets: number, opts: Mp4Options & { dops?: number[] | null } = {}): Uint8Array {
  const dops = opts.dops === undefined ? DOPS : opts.dops;
  const sampleEntry = box("Opus", [0, 0, 0, 0, 0, 0, 0, 1], new Array(8).fill(0), [0, 1, 0, 16, 0, 0, 0, 0], u32be(48_000 * 65536), ...(dops ? [box("dOps", dops)] : []));
  return mp4Aac(packets, { frame: [0xf8, 0xff, 0xfe], ...opts, sampleEntry });
}

export interface Mp4FragmentOptions extends Mp4Options {
  /** tfdt je Fragment statt des fortlaufenden Beginns (in Abtastwerten) */
  tfdt?: (index: number, start: number) => number;
  /** Spurnummer in tfhd, Standard 1 */
  trackId?: number;
}

/**
 * Gültig dekodierbares fragmentiertes MP4 wie aus MediaRecorder: mvhd und mdhd
 * nennen 0, die Sample-Tabelle ist leer, der Ton liegt in den Fragmenten
 * (tfdt plus trun, Dauer und Größe je Sample als Standard aus trex). Je
 * Eintrag ein Fragment mit so vielen AAC-Frames.
 */
export function mp4AacFragmented(fragments: number[], opts: Mp4FragmentOptions = {}): Uint8Array {
  const trex = box("trex", [0, 0, 0, 0], u32be(1), u32be(1), u32be(opts.sampleDelta ?? AAC_FRAME), u32be(frameOf(opts).length), u32be(0));
  const parts: Uint8Array[] = [];
  let start = 0;
  fragments.forEach((frames, i) => {
    // Flags: tfhd mit Basis am moof, trun mit Datenversatz (hinter moof und dem Kopf von mdat)
    const moof = (dataOffset: number) =>
      box(
        "moof",
        box("mfhd", [0, 0, 0, 0], u32be(i + 1)),
        box(
          "traf",
          box("tfhd", [0, 0x02, 0, 0], u32be(opts.trackId ?? 1)),
          box("tfdt", [0, 0, 0, 0], u32be(opts.tfdt ? opts.tfdt(i, start) : start)),
          box("trun", [0, 0, 0, 1], u32be(frames), u32be(dataOffset))
        )
      );
    parts.push(moof(moof(0).length + 8), box("mdat", aacFrames(frames, opts)));
    start += frames * AAC_FRAME;
  });
  return bytes(FTYP(), aacMoov(0, 0, { ...opts, headerSeconds: opts.headerSeconds ?? 0 }, box("mvex", trex)), ...parts);
}

/** Frames je Fragment in mp4Fragmented: rund eine Sekunde */
const MP4_FRAGMENT_FRAMES = 47;

/** Fragmentiertes MP4 mit Fragmenten von rund einer Sekunde (47 AAC-Frames, 1,0027 Sekunden) */
export function mp4Fragmented(fragments: number): Uint8Array {
  return mp4AacFragmented(new Array(fragments).fill(MP4_FRAGMENT_FRAMES));
}

const INFO_SCALE = bytes([0x2a, 0xd7, 0xb1, 0x83, 0x0f, 0x42, 0x40]);

/** WebM nur mit Audio und Duration in Info (Millisekunden als 64-Bit-Gleitkommazahl) */
export function webmWithDuration(seconds: number): Uint8Array {
  const value = new Uint8Array(8);
  new DataView(value.buffer).setFloat64(0, seconds * 1000);
  return bytes(
    ebmlHeader(),
    elUnknown(ID.Segment, el(ID.Info, INFO_SCALE, el([0x44, 0x89], value)), el(ID.Tracks, track(2)), elUnknown(ID.Cluster))
  );
}

/** Opus-Stille, 20 ms: CELT, Vollband, ein Frame */
export const OPUS_SILENT_20 = bytes([0xf8, 0xff, 0xfe]);

/** Pre-Skip der künstlichen Opus-Streams (wie libopus: 312 Abtastwerte) */
export const OGG_PRE_SKIP = 312;

/** OpusHead: mono, 48 kHz, Pre-Skip 312 (RFC 7845, Abschnitt 5.1) */
export const OPUS_HEAD = bytes("OpusHead", [1, 1], u16le(OGG_PRE_SKIP), u32le(48_000), u16le(0), [0]);

/** WebM-Spur 1 als Tonspur mit Opus; codecPrivate null: ohne CodecPrivate */
export function opusTrack(opts: { codec?: string; codecPrivate?: Uint8Array | null } = {}): Uint8Array {
  const head = opts.codecPrivate === undefined ? OPUS_HEAD : opts.codecPrivate;
  return el(
    ID.TrackEntry,
    el(ID.TrackNumber, bytes([1])),
    el(ID.TrackType, bytes([2])),
    el(ID.CodecID, bytes(opts.codec ?? "A_OPUS")),
    ...(head ? [el([0x63, 0xa2], head)] : [])
  );
}

/**
 * WebM ohne Duration wie aus MediaRecorder: ein Cluster unbekannter Größe je
 * Sekunde, darin 50 Blöcke mit je einem Paket von 20 ms
 */
export function webmLive(clusters: number): Uint8Array {
  const second: number[] = [];
  for (let i = 0; i < 50; i++) {
    const ms = i * 20;
    second.push(...el([0xa3], bytes([0x81, (ms >> 8) & 0xff, ms & 0xff, 0x80], OPUS_SILENT_20)));
  }
  const parts: Uint8Array[] = [];
  for (let i = 0; i < clusters; i++) {
    const ms = i * 1000;
    parts.push(elUnknown(ID.Cluster, el([0xe7], bytes([(ms >> 16) & 0xff, (ms >> 8) & 0xff, ms & 0xff])), new Uint8Array(second)));
  }
  return bytes(ebmlHeader(), elUnknown(ID.Segment, el(ID.Info, INFO_SCALE), el(ID.Tracks, opusTrack()), ...parts));
}

/** Opus-Stille, 120 ms in einem Paket: CELT, Vollband, sechs Frames zu 20 ms mit fester Größe (Code 3) */
export const OPUS_SILENT_120 = bytes([0xfb, 0x06], ...new Array(6).fill([0xff, 0xfe]));

export type WebmLacing = "none" | "xiph" | "ebml" | "fixed";

export interface WebmLacedOptions {
  /** Pakete je Block, höchstens 256 (Standard 240) */
  perBlock?: number;
  lacing?: WebmLacing;
  /** Alle Blöcke mit Zeitstempel 0 statt fortlaufend */
  frozenTime?: boolean;
  codec?: string;
  /** Duration in Info (Millisekunden); Standard: keine */
  durationMs?: number;
  /** Das einzelne Paket, Standard 120 ms Stille */
  packet?: Uint8Array;
}

/**
 * Gültig dekodierbares WebM/Opus (mono, 48 kHz, OpusHead in CodecPrivate)
 * ohne Duration: Stille in Paketen zu 120 ms, per Lacing zu vielen in einen
 * Block gebündelt, je Block ein Cluster. Der Zeitstempel eines Blocks nennt
 * nur seinen Anfang: bei 667 Paketen in drei Blöcken beginnt der letzte bei
 * 57,6 Sekunden, die Aufnahme dauert 80,04 Sekunden (dekodiert ohne Pre-Skip
 * 80,0335) und ist rund 10 KB groß.
 */
export function webmOpusLaced(packets: number, opts: WebmLacedOptions = {}): Uint8Array {
  const perBlock = opts.perBlock ?? 240;
  const lacing = opts.lacing ?? "xiph";
  const packet = opts.packet ?? OPUS_SILENT_120;
  const f32 = new Uint8Array(4);
  new DataView(f32.buffer).setFloat32(0, 48_000);
  const entry = el(
    ID.TrackEntry,
    el(ID.TrackNumber, bytes([1])),
    el([0x73, 0xc5], bytes([1])),
    el(ID.TrackType, bytes([2])),
    el(ID.CodecID, bytes(opts.codec ?? "A_OPUS")),
    el([0x63, 0xa2], OPUS_HEAD),
    // CodecDelay 6,5 ms (Pre-Skip) und SeekPreRoll 80 ms in Nanosekunden
    el([0x56, 0xaa], bytes(u32be(6_500_000))),
    el([0x56, 0xbb], bytes(u32be(80_000_000))),
    el([0xe1], el([0xb5], f32), el([0x9f], bytes([1])))
  );
  const info: Uint8Array[] = [INFO_SCALE];
  if (opts.durationMs !== undefined) {
    const value = new Uint8Array(8);
    new DataView(value.buffer).setFloat64(0, opts.durationMs);
    info.push(el([0x44, 0x89], value));
  }
  const clusters: Uint8Array[] = [];
  for (let first = 0; first < packets; first += perBlock) {
    const count = Math.min(perBlock, packets - first);
    const ms = opts.frozenTime ? 0 : first * 120;
    const sizes: number[] = [];
    // Xiph: je Paket 255er-Bytes und ein Rest unter 255
    const xiph = [...new Array(Math.floor(packet.length / 255)).fill(255), packet.length % 255];
    if (lacing === "xiph") for (let i = 0; i < count - 1; i++) sizes.push(...xiph);
    // EBML: erste Größe als Zahl (ein oder zwei Bytes), danach Differenz 0 (ein Byte, Versatz 63)
    const ebmlFirst = packet.length < 127 ? [0x80 | packet.length] : [0x40 | (packet.length >> 8), packet.length & 0xff];
    if (lacing === "ebml") for (let i = 0; i < count - 1; i++) sizes.push(...(i === 0 ? ebmlFirst : [0xbf]));
    const flags = { none: 0x80, xiph: 0x82, fixed: 0x84, ebml: 0x86 }[lacing];
    const blocks: Uint8Array[] = [];
    if (lacing === "none") {
      for (let i = 0; i < count; i++) blocks.push(el([0xa3], bytes([0x81, 0, 0, flags], packet)));
    } else {
      blocks.push(el([0xa3], bytes([0x81, 0, 0, flags, count - 1], sizes, ...new Array(count).fill(packet))));
    }
    clusters.push(el(ID.Cluster, el([0xe7], bytes(u32be(ms))), ...blocks));
  }
  return bytes(ebmlHeader(), elUnknown(ID.Segment, el(ID.Info, ...info), el(ID.Tracks, entry), ...clusters));
}

/** Ogg-Prüfsumme: CRC-32 mit Polynom 0x04c11db7, ohne Spiegelung, Startwert 0 */
const OGG_CRC = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    table[i] = r >>> 0;
  }
  return table;
})();

export function oggCrc(page: Uint8Array): number {
  let crc = 0;
  for (const byte of page) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
  return crc;
}

/** Eine Ogg-Seite mit gültiger Prüfsumme aus der Segmenttabelle und den Nutzdaten; Granule-Position -1: kein Paket endet hier */
export function oggRawPage(serial: number, sequence: number, flags: number, granule: number, lacing: number[], data: Uint8Array): Uint8Array {
  const page = bytes(
    "OggS",
    [0, flags],
    u32le(granule >>> 0),
    u32le(Math.floor(granule / 2 ** 32)),
    u32le(serial),
    u32le(sequence),
    u32le(0),
    [lacing.length],
    lacing,
    data
  );
  page.set(u32le(oggCrc(page)), 22);
  return page;
}

/** Eine Ogg-Seite aus ganzen Paketen; jedes Paket bleibt unter 255 Bytes (ein Segment) */
function oggPage(serial: number, sequence: number, flags: number, granule: number, packets: Uint8Array[]): Uint8Array {
  return oggRawPage(serial, sequence, flags, granule, packets.map(p => p.length), bytes(...packets));
}

/** Kopf-Seiten eines Ogg/Opus-Streams: OpusHead (mono, 48 kHz) und OpusTags */
export function oggOpusHeaders(serial = 1): Uint8Array {
  const tags = bytes("OpusTags", u32le(4), "tybo", u32le(0));
  return bytes(oggPage(serial, 0, 0x02, 0, [OPUS_HEAD]), oggPage(serial, 1, 0, 0, [tags]));
}

export interface OggPageInfo {
  serial: number;
  sequence: number;
  flags: number;
  granule: number;
  /** Prüfsumme der Seite stimmt */
  crcOk: boolean;
  /** Pakete, die auf dieser Seite enden */
  packets: Uint8Array[];
}

/**
 * Liest die Seiten einer Ogg-Datei für Prüfungen im Test, unabhängig vom
 * Server-Code: Kopf-Felder, Prüfsumme und die Pakete aus den Segmenten (ein
 * Paket, das über Seiten geht, steht bei der Seite, auf der es endet).
 */
export function oggPages(file: Uint8Array): OggPageInfo[] {
  const pages: OggPageInfo[] = [];
  const open = new Map<number, number[]>();
  let pos = 0;
  while (pos < file.length) {
    if (String.fromCharCode(...file.subarray(pos, pos + 4)) !== "OggS") throw new Error(`keine Ogg-Seite bei ${pos}`);
    const view = new DataView(file.buffer, file.byteOffset + pos);
    const segments = file[pos + 26];
    const lacing = [...file.subarray(pos + 27, pos + 27 + segments)];
    const size = 27 + segments + lacing.reduce((n, l) => n + l, 0);
    const page = file.slice(pos, pos + size);
    const crc = view.getUint32(22, true);
    page.set([0, 0, 0, 0], 22);
    const serial = view.getUint32(14, true);
    const packets: Uint8Array[] = [];
    let current = open.get(serial) ?? [];
    let at = pos + 27 + segments;
    for (const length of lacing) {
      current.push(...file.subarray(at, at + length));
      at += length;
      if (length < 255) {
        packets.push(new Uint8Array(current));
        current = [];
      }
    }
    open.set(serial, current);
    pages.push({
      serial,
      sequence: view.getUint32(18, true),
      flags: file[pos + 5],
      granule: view.getUint32(10, true) * 2 ** 32 + view.getUint32(6, true),
      crcOk: oggCrc(page) === crc,
      packets,
    });
    pos += size;
  }
  return pages;
}

export interface OggOptions {
  /** Granule-Position der Audioseite für Sekunde s (ab 1) statt Pre-Skip plus s Sekunden */
  granule?: (second: number) => number;
  /** Das einzelne Paket, Standard 20 ms Stille */
  packet?: Uint8Array;
}

/**
 * Ein vollständiger logischer Ogg/Opus-Stream mit Stille: OpusHead (mono,
 * 48 kHz), OpusTags, dann je Sekunde eine Seite mit 50 Paketen zu 20 ms
 * (Opus-Stille: CELT, Vollband, ein Frame). Die letzte Seite trägt das
 * Ende-Flag und die Granule-Position Pre-Skip plus Dauer. Mit granule lassen
 * sich die Zeitangaben der Seiten verstellen, die Pakete bleiben gleich und
 * die Prüfsummen gültig.
 */
export function oggOpusStream(seconds: number, serial = 1, opts: OggOptions = {}): Uint8Array {
  const silent = opts.packet ?? OPUS_SILENT_20;
  const pages = [oggOpusHeaders(serial)];
  for (let s = 1; s <= seconds; s++) {
    const granule = opts.granule ? opts.granule(s) : OGG_PRE_SKIP + s * 48_000;
    pages.push(oggPage(serial, s + 1, s === seconds ? 0x04 : 0, granule, new Array(50).fill(silent)));
  }
  return bytes(...pages);
}

/**
 * Verkettetes Ogg (RFC 3533, „chaining"): mehrere vollständige logische
 * Streams hintereinander, jeder mit eigener Seriennummer und einer
 * Granule-Position, die wieder bei 0 beginnt. Gültig und abspielbar; die
 * Dauer ist die Summe der Teile.
 */
export function oggOpusChained(...seconds: number[]): Uint8Array {
  const parts = seconds.map((s, i) => oggOpusStream(s, 0x1000 + i));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
