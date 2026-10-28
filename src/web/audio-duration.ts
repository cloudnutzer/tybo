/**
 * Aufnahme für die Erkennung vorbereiten (Issue #249): der Sprechmodus nimmt
 * höchstens 60 Sekunden je Äußerung an, auch bei komprimierten Formaten, bei
 * denen 2 MB für viele Minuten reichen würden.
 *
 * Eine Regel für alle Formate: Der Server zählt die Ton-Einheiten, deren
 * Dauer im Codec selbst steht, und schreibt aus genau diesen Einheiten eine
 * neue Datei. Nur diese Datei geht an die Erkennung, nie die hochgeladene.
 * Die Dauer ist die Summe der Einheiten. Was der Server gezählt hat und was
 * ein Decoder später ausgibt, kann so nicht auseinanderlaufen: Zeitangaben,
 * Tabellen und Reste des hochgeladenen Containers erreichen die Erkennung
 * nicht, sie können die Dauer weder kleiner noch größer machen.
 *
 * - WAV, nur unkomprimiert (PCM, Gleitkomma): Einheit ist der Block (ein
 *   Abtastwert je Kanal). Weiter geht ein neu geschriebenes WAV aus Kopf,
 *   fmt und dem ersten data-Block. Komprimierte Codecs im WAV: nicht bestimmbar
 * - Ogg/Opus und WebM/Opus: Einheit ist das Opus-Paket, seine Dauer steht im
 *   TOC-Byte. Weiter geht ein neu geschriebenes Ogg/Opus mit genau diesen
 *   Paketen (bei WebM also Ogg statt WebM). Andere Codecs: nicht bestimmbar
 * - MP3: Einheit ist der Frame, Länge und Dauer stehen im Frame-Kopf. Weiter
 *   gehen die Frames lückenlos hintereinander, ohne ID3 und ohne Reste
 * - MP4/M4A mit AAC-LC: Einheit ist der AAC-Frame (1024 Abtastwerte). Wo er
 *   endet, steht nur im Bitstrom; ./aac-frame liest ihn bis dorthin. Ein
 *   Sample muss genau ein Frame sein. Weiter geht ein neu geschriebenes M4A,
 *   je Sample das Kanal-Element des Frames und die Ende-Kennung
 * - MP4 mit Opus (so nimmt Chrome audio/mp4 auf): Einheit ist das Opus-Paket
 *   wie bei Ogg und WebM, weiter geht Ogg/Opus. Andere Codecs: nicht bestimmbar
 *
 * Die Dauer ist eine Obergrenze: Pre-Skip und gekürztes Ende bei Opus, Vor-
 * und Nachlauf bei AAC werden nicht abgezogen (wenige Millisekunden zur
 * vorsichtigen Seite).
 *
 * null heißt: nicht bestimmbar. Der Aufrufer lehnt dann ab, statt zu raten.
 * Importiert nur ./aac-frame, damit der Web-Server die Datei ohne src/lib
 * laden kann.
 */

import { AAC_FRAME_SAMPLES, AAC_SAMPLE_RATES, aacFrame, type AacConfig } from "./aac-frame";

/** Was an die Erkennung geht */
export interface PreparedAudio {
  /** Summe der Dauern aller Einheiten in audio: mehr gibt kein Decoder daraus aus */
  seconds: number;
  /** Vom Server neu geschrieben, enthält nur die gezählten Einheiten */
  audio: Uint8Array;
  mime: "audio/wav" | "audio/ogg" | "audio/mpeg" | "audio/mp4";
}

function u16be(b: Uint8Array, o: number): number {
  return (b[o] << 8) | b[o + 1];
}

function u32be(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function u16le(b: Uint8Array, o: number): number {
  return b[o] | (b[o + 1] << 8);
}

function u32le(b: Uint8Array, o: number): number {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

function tag(b: Uint8Array, o: number): string {
  return o + 4 <= b.length ? String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]) : "";
}

/** Beginnen die size Bytes ab start mit diesem Text? */
function startsWithAscii(b: Uint8Array, start: number, size: number, text: string): boolean {
  if (size < text.length) return false;
  for (let i = 0; i < text.length; i++) if (b[start + i] !== text.charCodeAt(i)) return false;
  return true;
}

function ascii(text: string): Uint8Array {
  return Uint8Array.from(text, c => c.charCodeAt(0));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

// --- WAV ---

const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_IEEE_FLOAT = 3;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

interface WavFormat {
  /** WAVE_FORMAT_PCM oder WAVE_FORMAT_IEEE_FLOAT */
  format: number;
  channels: number;
  sampleRate: number;
  /** Bytes je Block: ein Abtastwert je Kanal */
  blockAlign: number;
  bits: number;
}

/**
 * fmt-Block, nur für unkomprimiertes Audio (PCM oder Gleitkomma, auch als
 * WAVE_FORMAT_EXTENSIBLE): dort ist ein Block genau ein Abtastwert je Kanal.
 * Bei komprimierten Codecs (ADPCM, GSM, MP3 im WAV) fasst ein Block viele
 * Abtastwerte: null, nicht bestimmbar. Ebenso, wenn die Angaben nicht
 * zusammenpassen.
 */
function wavFormat(b: Uint8Array, fmt: number, size: number): WavFormat | null {
  if (size < 16 || fmt + 16 > b.length) return null;
  let format = u16le(b, fmt);
  if (format === WAVE_FORMAT_EXTENSIBLE) {
    // Der eigentliche Codec steht in den ersten zwei Bytes des SubFormat-GUID
    if (size < 40 || fmt + 40 > b.length) return null;
    format = u16le(b, fmt + 24);
  }
  if (format !== WAVE_FORMAT_PCM && format !== WAVE_FORMAT_IEEE_FLOAT) return null;
  const channels = u16le(b, fmt + 2);
  const sampleRate = u32le(b, fmt + 4);
  const blockAlign = u16le(b, fmt + 12);
  const bits = u16le(b, fmt + 14);
  const bitsOk = format === WAVE_FORMAT_PCM ? bits === 8 || bits === 16 || bits === 24 || bits === 32 : bits === 32 || bits === 64;
  if (!channels || !sampleRate || !bitsOk || blockAlign !== channels * (bits / 8)) return null;
  // Die Byte-Rate muss in ihr 32-Bit-Feld passen
  return sampleRate * blockAlign <= 0xffffffff ? { format, channels, sampleRate, blockAlign, bits } : null;
}

/** WAV aus genau einem fmt-Block (16 Bytes, PCM oder Gleitkomma) und einem data-Block */
function wavFile(f: WavFormat, data: Uint8Array): Uint8Array {
  // Ungerade Länge: RIFF füllt mit einem Byte auf
  const pad = data.length & 1;
  const out = new Uint8Array(44 + data.length + pad);
  const view = new DataView(out.buffer);
  out.set(ascii("RIFF"), 0);
  view.setUint32(4, 36 + data.length + pad, true);
  out.set(ascii("WAVEfmt "), 8);
  view.setUint32(16, 16, true);
  view.setUint16(20, f.format, true);
  view.setUint16(22, f.channels, true);
  view.setUint32(24, f.sampleRate, true);
  view.setUint32(28, f.sampleRate * f.blockAlign, true);
  view.setUint16(32, f.blockAlign, true);
  view.setUint16(34, f.bits, true);
  out.set(ascii("data"), 36);
  view.setUint32(40, data.length, true);
  out.set(data, 44);
  return out;
}

/**
 * Gezählt und weitergereicht werden die ganzen Blöcke des ersten
 * data-Blocks. Alles andere bleibt zurück: weitere data-Blöcke (manche
 * Decoder lesen sie mit), LIST, Reste hinter dem Ende. Zwei fmt-Blöcke:
 * nicht bestimmbar.
 */
function prepareWav(b: Uint8Array): PreparedAudio | null {
  if (tag(b, 0) !== "RIFF" || tag(b, 8) !== "WAVE") return null;
  let pos = 12;
  let format: WavFormat | null = null;
  while (pos + 8 <= b.length) {
    const id = tag(b, pos);
    const size = u32le(b, pos + 4);
    const data = pos + 8;
    if (id === "fmt ") {
      if (format) return null;
      format = wavFormat(b, data, size);
      if (!format) return null;
    } else if (id === "data") {
      if (!format) return null;
      const available = b.length - data;
      // Beim Schreiben im Strom steht die Größe oft auf 0 oder 0xFFFFFFFF: dann zählt, was da ist
      const length = size === 0 || size > available ? available : size;
      const blocks = Math.floor(length / format.blockAlign);
      if (!blocks) return null;
      const audio = wavFile(format, b.subarray(data, data + blocks * format.blockAlign));
      return { seconds: blocks / format.sampleRate, audio, mime: "audio/wav" };
    }
    pos = data + size + (size & 1);
  }
  return null;
}

// --- Opus ---

/** Längstes Opus-Paket: 120 ms bei 48 kHz */
const OPUS_MAX_PACKET_SAMPLES = 5760;

/**
 * Abtastwerte (48 kHz) eines Opus-Pakets aus seinem TOC-Byte (RFC 6716,
 * Abschnitt 3.1 und 3.2): Frame-Länge aus der Konfiguration, Anzahl der
 * Frames aus dem Code. null: leeres oder ungültiges Paket.
 */
function opusPacketSamples(b: Uint8Array, start: number, size: number): number | null {
  if (size < 1) return null;
  const config = b[start] >> 3;
  // 0 bis 11 SILK (10, 20, 40, 60 ms), 12 bis 15 Hybrid (10, 20 ms), ab 16 CELT (2,5, 5, 10, 20 ms)
  const frame = config < 12 ? [480, 960, 1920, 2880][config & 3] : config < 16 ? [480, 960][config & 1] : [120, 240, 480, 960][config & 3];
  const code = b[start] & 3;
  let frames = code === 0 ? 1 : 2;
  if (code === 3) {
    if (size < 2) return null;
    frames = b[start + 1] & 0x3f;
  }
  const samples = frame * frames;
  return frames > 0 && samples <= OPUS_MAX_PACKET_SAMPLES ? samples : null;
}

/** OpusHead ohne Kanal-Tabelle hat 19 Bytes, mit Tabelle für 255 Kanäle 276 */
const OPUS_HEAD_MIN = 19;
const OPUS_HEAD_MAX = 276;
/** Ein Paket muss auf eine Ogg-Seite passen: 255 Segmente, das letzte unter 255 Bytes */
const OGG_MAX_PACKET = 255 * 255 - 1;

function isOpusHead(b: Uint8Array, start: number, size: number): boolean {
  return size >= OPUS_HEAD_MIN && size <= OPUS_HEAD_MAX && startsWithAscii(b, start, size, "OpusHead");
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

const OPUS_TAGS = concat([ascii("OpusTags"), Uint8Array.of(4, 0, 0, 0), ascii("tybo"), Uint8Array.of(0, 0, 0, 0)]);
const OGG_FIRST_PAGE = 0x02;
const OGG_LAST_PAGE = 0x04;

/**
 * Schreibt Ogg/Opus (RFC 7845) Seite für Seite aus den gezählten Paketen:
 * je Stream OpusHead, ein leeres OpusTags, dann die Pakete. Die
 * Granule-Position läuft mit der Summe der Pakete und endet bei ihr. Mehrere
 * Streams stehen hintereinander (verkettet), jeder mit eigener Seriennummer.
 * Zählen und Schreiben sind derselbe Schritt: add() ist die einzige Stelle,
 * an der ein Paket zur Dauer beiträgt.
 */
class OggOpusWriter {
  private readonly pages: Uint8Array[] = [];
  /** Die offene Seite: Segmenttabelle und Nutzdaten */
  private readonly lacing = new Uint8Array(255);
  private readonly payload = new Uint8Array(255 * 255);
  private segments = 0;
  private size = 0;
  private serial = 0;
  private sequence = 0;
  private granule = 0;
  /** Die offene Seite trägt OpusTags: Audio beginnt auf einer neuen Seite */
  private tags = false;
  /** Abtastwerte (48 kHz) aller Pakete aller Streams */
  private samples = 0;

  /** Neuer Stream: schließt den vorigen ab, OpusHead (unverändert übernommen) auf die erste Seite, OpusTags auf die zweite */
  begin(head: Uint8Array): void {
    if (this.segments) this.flush(OGG_LAST_PAGE);
    this.serial++;
    this.sequence = 0;
    this.granule = 0;
    this.put(head, 0, head.length);
    this.flush(OGG_FIRST_PAGE);
    this.put(OPUS_TAGS, 0, OPUS_TAGS.length);
    this.tags = true;
  }

  /** Ein Audio-Paket (höchstens OGG_MAX_PACKET Bytes) mit seiner Dauer */
  add(b: Uint8Array, start: number, size: number, samples: number): void {
    if (this.tags || this.segments + Math.floor(size / 255) + 1 > 255) this.flush(0);
    this.put(b, start, size);
    this.granule += samples;
    this.samples += samples;
  }

  /** Ohne ein einziges Audio-Paket: nichts zu zählen, nichts weiterzureichen */
  result(): PreparedAudio | null {
    if (!this.samples) return null;
    if (this.segments) this.flush(OGG_LAST_PAGE);
    return { seconds: this.samples / 48_000, audio: concat(this.pages), mime: "audio/ogg" };
  }

  private put(b: Uint8Array, start: number, size: number): void {
    for (let rest = size; rest >= 255; rest -= 255) this.lacing[this.segments++] = 255;
    this.lacing[this.segments++] = size % 255;
    // Kleine Pakete Byte für Byte: spart bei sehr vielen Paketen je eine Sicht auf den Puffer
    if (size < 64) for (let i = 0; i < size; i++) this.payload[this.size + i] = b[start + i];
    else this.payload.set(b.subarray(start, start + size), this.size);
    this.size += size;
  }

  private flush(flags: number): void {
    const page = new Uint8Array(27 + this.segments + this.size);
    const view = new DataView(page.buffer);
    page.set(ascii("OggS"), 0);
    page[5] = flags;
    view.setUint32(6, this.granule >>> 0, true);
    view.setUint32(10, Math.floor(this.granule / 2 ** 32), true);
    view.setUint32(14, this.serial, true);
    view.setUint32(18, this.sequence++, true);
    page[26] = this.segments;
    page.set(this.lacing.subarray(0, this.segments), 27);
    page.set(this.payload.subarray(0, this.size), 27 + this.segments);
    let crc = 0;
    for (let i = 0; i < page.length; i++) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ page[i]) & 0xff]) >>> 0;
    view.setUint32(22, crc, true);
    this.pages.push(page);
    this.segments = 0;
    this.size = 0;
    this.tags = false;
  }
}

/** Ein Opus-Paket zählen und schreiben; false: ungültig oder zu groß für eine Seite */
function addOpusPacket(out: OggOpusWriter, b: Uint8Array, start: number, size: number): boolean {
  const samples = opusPacketSamples(b, start, size);
  if (samples === null || size > OGG_MAX_PACKET) return false;
  out.add(b, start, size, samples);
  return true;
}

// --- Ogg/Opus ---

/**
 * Die Pakete je logischem Stream (Seriennummer). Verkettete Ogg-Dateien
 * (mehrere logische Streams hintereinander) zählen zusammen und gehen als
 * Kette weiter. Die Granule-Positionen der Seiten werden nicht gelesen: sie
 * zählen weder nach unten noch nach oben.
 *
 * Nicht bestimmbar: ein Stream, der nicht mit OpusHead und OpusTags beginnt,
 * eine Seriennummer, die zweimal beginnt, eine Seite, die nicht zum laufenden
 * Stream gehört (auch ineinander verschachtelte Streams), ein ungültiges
 * Opus-Paket, ein Paket, dessen Fortsetzung fehlt oder nicht angekündigt ist,
 * Reste hinter der letzten Seite.
 */
function prepareOggOpus(b: Uint8Array): PreparedAudio | null {
  const out = new OggOpusWriter();
  const seen = new Set<number>();
  /** Laufender Stream; -1: noch keiner */
  let serial = -1;
  /** Abgeschlossene Pakete des laufenden Streams; die ersten beiden sind OpusHead und OpusTags */
  let done = 0;
  /** Teile eines Pakets von den vorigen Seiten, das auf dieser weitergeht */
  let open: Uint8Array[] | null = null;
  const packet = (p: Uint8Array, start: number, size: number): boolean => {
    const index = done++;
    if (index === 0) {
      if (!isOpusHead(p, start, size)) return false;
      out.begin(p.subarray(start, start + size));
      return true;
    }
    if (index === 1) return startsWithAscii(p, start, size, "OpusTags");
    return addOpusPacket(out, p, start, size);
  };
  let pos = 0;
  while (pos + 27 <= b.length) {
    if (tag(b, pos) !== "OggS" || b[pos + 4] !== 0) return null;
    const segments = b[pos + 26];
    const payload = pos + 27 + segments;
    if (payload > b.length) return null;
    const pageSerial = u32le(b, pos + 14);
    // Bit 2 der Kopf-Flags: erste Seite eines logischen Streams
    if (b[pos + 5] & OGG_FIRST_PAGE) {
      // Der vorige Stream ist damit zu Ende: er braucht beide Kopf-Pakete und darf kein Paket offen haben
      if (seen.has(pageSerial) || open || (serial >= 0 && done < 2)) return null;
      seen.add(pageSerial);
      serial = pageSerial;
      done = 0;
    } else if (pageSerial !== serial) return null;
    // Bit 1: die Seite setzt ein Paket fort. Das muss zum Ende der vorigen Seite passen
    if (((b[pos + 5] & 0x01) !== 0) !== (open !== null)) return null;
    // Pakete aus den Segmenten: ein Segment unter 255 Bytes schließt ein Paket ab
    let start = payload;
    let at = payload;
    for (let i = 0; i < segments; i++) {
      const length = b[pos + 27 + i];
      if (at + length > b.length) return null;
      at += length;
      if (length === 255) continue;
      if (open) {
        open.push(b.subarray(start, at));
        const whole = concat(open);
        open = null;
        if (!packet(whole, 0, whole.length)) return null;
      } else if (!packet(b, start, at - start)) return null;
      start = at;
    }
    // Das letzte Segment ist voll: das Paket geht auf der nächsten Seite weiter
    if (segments && b[pos + 27 + segments - 1] === 255) (open ??= []).push(b.subarray(start, at));
    pos = at;
  }
  // Reste nach der letzten vollständigen Seite: abgeschnitten
  if (pos !== b.length || serial < 0 || open || done < 2) return null;
  return out.result();
}

// --- MP3 ---

const MP3_BITRATES: Record<string, number[]> = {
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const MP3_SAMPLE_RATES: Record<number, number[]> = {
  3: [44_100, 48_000, 32_000], // MPEG 1
  2: [22_050, 24_000, 16_000], // MPEG 2
  0: [11_025, 12_000, 8_000], // MPEG 2.5
};

interface Mp3Frame {
  length: number;
  seconds: number;
  /** Version, Layer und Abtastrate: in einer Datei bei allen Frames gleich */
  kind: number;
}

/** Länge in Bytes und Dauer eines Frames; null, wenn an dieser Stelle kein gültiger Frame-Kopf steht */
function mp3Frame(b: Uint8Array, pos: number): Mp3Frame | null {
  if (pos + 4 > b.length || b[pos] !== 0xff || (b[pos + 1] & 0xe0) !== 0xe0) return null;
  const versionBits = (b[pos + 1] >> 3) & 3;
  const layerBits = (b[pos + 1] >> 1) & 3;
  const bitrateIndex = (b[pos + 2] >> 4) & 15;
  const rateIndex = (b[pos + 2] >> 2) & 3;
  const padding = (b[pos + 2] >> 1) & 1;
  if (versionBits === 1 || layerBits === 0 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null;
  const layer = 4 - layerBits;
  const mpeg1 = versionBits === 3;
  const sampleRate = MP3_SAMPLE_RATES[versionBits][rateIndex];
  const bitrate = MP3_BITRATES[`${mpeg1 ? 1 : 2}-${layer}`][bitrateIndex] * 1000;
  const samples = layer === 1 ? 384 : layer === 2 || mpeg1 ? 1152 : 576;
  const length = layer === 1 ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4 : Math.floor(((samples / 8) * bitrate) / sampleRate) + padding;
  return length >= 4 ? { length, seconds: samples / sampleRate, kind: (versionBits << 4) | (layerBits << 2) | rateIndex } : null;
}

/**
 * Gezählt und weitergereicht werden die vollständigen Frames, lückenlos
 * hintereinander: ein Decoder findet darin an jedem Frame-Ende den nächsten
 * Kopf und nichts dazwischen. ID3-Blöcke, Auffüllung und ein abgeschnittener
 * letzter Frame bleiben zurück, ebenso Frames, deren Version, Layer oder
 * Abtastrate vom ersten abweicht.
 */
function prepareMp3(b: Uint8Array): PreparedAudio | null {
  let pos = 0;
  if (tag(b, 0).startsWith("ID3") && b.length >= 10) {
    // ID3v2: Größe als vier 7-Bit-Bytes, dazu Kopf und gegebenenfalls Fußzeile
    const size = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    pos = 10 + size + (b[5] & 0x10 ? 10 : 0);
  }
  const frames: Uint8Array[] = [];
  let seconds = 0;
  let kind = -1;
  while (pos + 4 <= b.length) {
    const frame = mp3Frame(b, pos);
    if (!frame || pos + frame.length > b.length || (kind >= 0 && frame.kind !== kind)) {
      pos++;
      continue;
    }
    kind = frame.kind;
    // Zählen und Sammeln sind derselbe Schritt
    frames.push(b.subarray(pos, pos + frame.length));
    seconds += frame.seconds;
    pos += frame.length;
  }
  return frames.length ? { seconds, audio: concat(frames), mime: "audio/mpeg" } : null;
}

// --- WebM ---

const EBML_SEGMENT = 0x18538067;
const EBML_INFO = 0x1549a966;
const EBML_TRACKS = 0x1654ae6b;
const EBML_TRACK_ENTRY = 0xae;
const EBML_TRACK_NUMBER = 0xd7;
const EBML_TRACK_TYPE = 0x83;
const EBML_CODEC_ID = 0x86;
const EBML_CODEC_PRIVATE = 0x63a2;
const EBML_CONTENT_ENCODINGS = 0x6d80;
const EBML_CLUSTER = 0x1f43b675;
const EBML_SIMPLE_BLOCK = 0xa3;
const EBML_BLOCK_GROUP = 0xa0;
const EBML_BLOCK = 0xa1;
/** In diese Elemente wird hineingelesen, alle anderen werden übersprungen */
const EBML_MASTERS = new Set([EBML_SEGMENT, EBML_INFO, EBML_TRACKS, EBML_TRACK_ENTRY, EBML_CLUSTER, EBML_BLOCK_GROUP]);
const WEBM_TRACK_AUDIO = 2;

/** Kopf eines EBML-Elements; size null: unbekannte Größe */
function ebmlElement(b: Uint8Array, pos: number): { id: number; dataStart: number; size: number | null } | null {
  const first = b[pos];
  let idLength = 0;
  for (let mask = 0x80, n = 1; n <= 4; mask >>= 1, n++) {
    if (first & mask) {
      idLength = n;
      break;
    }
  }
  if (!idLength || pos + idLength >= b.length) return null;
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + b[pos + i];
  const sizePos = pos + idLength;
  const sizeFirst = b[sizePos];
  let sizeLength = 0;
  for (let mask = 0x80, n = 1; n <= 8; mask >>= 1, n++) {
    if (sizeFirst & mask) {
      sizeLength = n;
      break;
    }
  }
  if (!sizeLength || sizePos + sizeLength > b.length) return null;
  let size = sizeFirst & (0xff >> sizeLength);
  let allOnes = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    if (b[sizePos + i] !== 0xff) allOnes = false;
    size = size * 256 + b[sizePos + i];
  }
  return { id, dataStart: sizePos + sizeLength, size: allOnes ? null : size };
}

function ebmlUint(b: Uint8Array, start: number, size: number): number {
  let value = 0;
  for (let i = 0; i < size; i++) value = value * 256 + b[start + i];
  return value;
}

/** EBML-Zahl variabler Länge (Länge aus dem ersten Byte, Markierungsbit entfernt); null: passt nicht vor end */
function ebmlVint(b: Uint8Array, pos: number, end: number): { value: number; length: number } | null {
  if (pos >= end) return null;
  let length = 1;
  for (let mask = 0x80; length <= 8 && !(b[pos] & mask); mask >>= 1) length++;
  if (length > 8 || pos + length > end) return null;
  let value = b[pos] & (0xff >> length);
  for (let i = 1; i < length; i++) value = value * 256 + b[pos + i];
  return { value, length };
}

/**
 * Kopf eines Blocks (SimpleBlock oder Block): Spur und die Größen der
 * gebündelten Pakete (Lacing: ohne, Xiph, feste Größe, EBML). Der
 * Zeitversatz wird übersprungen. null: der Aufbau passt nicht in den Block.
 */
function webmBlock(b: Uint8Array, start: number, end: number): { track: number; at: number; sizes: number[] } | null {
  const track = ebmlVint(b, start, end);
  if (!track) return null;
  let at = start + track.length;
  if (at + 3 > end) return null;
  // Zwei Bytes Zeitversatz zum Cluster, danach die Flags
  const lacing = (b[at + 2] >> 1) & 3;
  at += 3;
  if (lacing === 0) return { track: track.value, at, sizes: [end - at] };
  if (at >= end) return null;
  const count = b[at++] + 1;
  const sizes: number[] = [];
  let used = 0;
  if (lacing === 1) {
    // Xiph: je Paket Bytes aufaddieren, bis eines unter 255 liegt
    for (let i = 0; i < count - 1; i++) {
      let size = 0;
      for (;;) {
        if (at >= end) return null;
        const byte = b[at++];
        size += byte;
        if (byte !== 255) break;
      }
      sizes.push(size);
      used += size;
    }
  } else if (lacing === 3) {
    // EBML: erste Größe als Zahl, die folgenden als Differenz mit Vorzeichen
    let size = 0;
    for (let i = 0; i < count - 1; i++) {
      const v = ebmlVint(b, at, end);
      if (!v) return null;
      at += v.length;
      size = i === 0 ? v.value : size + v.value - (2 ** (7 * v.length - 1) - 1);
      if (size < 0) return null;
      sizes.push(size);
      used += size;
    }
  } else {
    // Feste Größe: der Rest teilt sich gleichmäßig auf
    const rest = end - at;
    if (rest % count !== 0) return null;
    return { track: track.value, at, sizes: new Array(count).fill(rest / count) };
  }
  const last = end - at - used;
  if (last < 0) return null;
  sizes.push(last);
  return { track: track.value, at, sizes };
}

/**
 * Die Opus-Pakete der Tonspur in der Reihenfolge der Datei, mit dem OpusHead
 * aus CodecPrivate. Ein Block kann viele Pakete bündeln (Lacing). Duration
 * und Zeitstempel werden nicht gelesen: sie zählen weder nach unten noch
 * nach oben.
 *
 * Die Dauer eines Pakets steht nur bei Opus im Paket selbst. Alles andere ist
 * nicht bestimmbar: ein anderer Codec, eine Spur ohne OpusHead oder mit
 * ContentEncodings (Pakete liegen dann nicht im Klartext vor), mehr als eine
 * Tonspur mit Blöcken, ein Block ohne bekannte Spur, ein ungültiges Paket,
 * ein abgeschnittenes oder unlesbares Element.
 */
function prepareWebmOpus(b: Uint8Array): PreparedAudio | null {
  interface Track {
    type: number | null;
    codec: string;
    encoded: boolean;
    /** CodecPrivate: bei Opus der OpusHead */
    head: Uint8Array | null;
  }
  const out = new OggOpusWriter();
  const tracks = new Map<number, Track>();
  let entry: Track | null = null;
  /** Die Tonspur, deren Pakete gezählt werden und weitergehen */
  let audio: Track | null = null;
  let pos = 0;
  while (pos < b.length) {
    const el = ebmlElement(b, pos);
    if (!el) return null;
    if (EBML_MASTERS.has(el.id)) {
      if (el.id === EBML_TRACK_ENTRY) entry = { type: null, codec: "", encoded: false, head: null };
      pos = el.dataStart;
      continue;
    }
    if (el.size === null) return null;
    const end = el.dataStart + el.size;
    // Abgeschnitten: was dahinter fehlt, lässt sich nicht zählen
    if (end > b.length) return null;
    if (el.id === EBML_TRACK_NUMBER && entry && el.size >= 1 && el.size <= 8) {
      const number = ebmlUint(b, el.dataStart, el.size);
      // Zwei Spuren mit derselben Nummer: die Blöcke ließen sich nicht zuordnen
      if (tracks.has(number) && tracks.get(number) !== entry) return null;
      tracks.set(number, entry);
    } else if (el.id === EBML_TRACK_TYPE && entry && el.size >= 1 && el.size <= 8) entry.type = ebmlUint(b, el.dataStart, el.size);
    else if (el.id === EBML_CODEC_ID && entry) entry.codec = el.size <= 32 ? String.fromCharCode(...b.subarray(el.dataStart, end)) : "?";
    else if (el.id === EBML_CODEC_PRIVATE && entry) entry.head = b.subarray(el.dataStart, end);
    else if (el.id === EBML_CONTENT_ENCODINGS && entry) entry.encoded = true;
    else if (el.id === EBML_SIMPLE_BLOCK || el.id === EBML_BLOCK) {
      const block = webmBlock(b, el.dataStart, end);
      const track = block ? tracks.get(block.track) : undefined;
      if (!block || !track || track.type === null) return null;
      // Untertitel und Ähnliches neben der Tonspur zählen nicht und gehen nicht weiter
      if (track.type === WEBM_TRACK_AUDIO) {
        if (track.codec !== "A_OPUS" || track.encoded) return null;
        if (!audio) {
          if (!track.head || !isOpusHead(track.head, 0, track.head.length)) return null;
          audio = track;
          out.begin(track.head);
        } else if (track !== audio) return null;
        let at = block.at;
        for (const size of block.sizes) {
          if (!addOpusPacket(out, b, at, size)) return null;
          at += size;
        }
      }
    }
    pos = end;
  }
  return out.result();
}

// --- MP4 ---

interface Mp4Box {
  type: string;
  /** Anfang der Box samt Kopf */
  at: number;
  /** Anfang und Ende des Inhalts */
  start: number;
  end: number;
}

/** Die Boxen zwischen start und end; null, wenn sie den Bereich nicht lückenlos füllen (abgeschnitten, Reste, kaputte Größe) */
function mp4Boxes(b: Uint8Array, start: number, end: number): Mp4Box[] | null {
  const out: Mp4Box[] = [];
  let pos = start;
  while (pos < end) {
    if (pos + 8 > end) return null;
    let size = u32be(b, pos);
    let header = 8;
    if (size === 1) {
      if (pos + 16 > end) return null;
      size = u32be(b, pos + 8) * 2 ** 32 + u32be(b, pos + 12);
      header = 16;
    } else if (size === 0) size = end - pos;
    if (size < header || pos + size > end) return null;
    out.push({ type: tag(b, pos + 4), at: pos, start: pos + header, end: pos + size });
    pos += size;
  }
  return out;
}

/** Die Boxen in einer Box */
const mp4Inside = (b: Uint8Array, parent: Mp4Box | null) => (parent ? mp4Boxes(b, parent.start, parent.end) : null);

/** Die eine Box dieses Typs; null, wenn sie fehlt oder mehrfach vorkommt */
function mp4Only(list: Mp4Box[] | null, type: string): Mp4Box | null {
  const found = list?.filter(x => x.type === type) ?? [];
  return found.length === 1 ? found[0] : null;
}

/** Ein Deskriptor aus dem esds (ISO/IEC 14496-1): Kennung, dann die Länge in bis zu vier Bytes zu 7 Bit */
function mp4Descriptor(b: Uint8Array, pos: number, end: number): { id: number; start: number; end: number } | null {
  if (pos >= end) return null;
  const id = b[pos++];
  let size = 0;
  for (let i = 0; i < 4; i++) {
    if (pos >= end) return null;
    const byte = b[pos++];
    size = size * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) break;
  }
  return pos + size <= end ? { id, start: pos, end: pos + size } : null;
}

const AAC_LC = 2;

/**
 * AudioSpecificConfig (ISO/IEC 14496-3) aus dem esds: nur AAC-LC mit einem
 * festen Abtastraten-Index, einem oder zwei Kanälen und 1024 Abtastwerten je
 * Frame. Was dahinter steht (etwa ein Hinweis auf SBR), wird nicht gelesen
 * und geht nicht weiter.
 */
function mp4AacConfig(b: Uint8Array, esds: Mp4Box): AacConfig | null {
  const es = mp4Descriptor(b, esds.start + 4, esds.end);
  if (!es || es.id !== 0x03 || es.start + 3 > es.end) return null;
  // ES_ID (2 Bytes), Flags: abhängiger Stream (2 Bytes), URL (Länge plus Text), OCR-Stream (2 Bytes)
  const flags = b[es.start + 2];
  let at = es.start + 3 + (flags & 0x80 ? 2 : 0);
  if (flags & 0x40) at += at < es.end ? 1 + b[at] : 1;
  if (flags & 0x20) at += 2;
  const decoder = mp4Descriptor(b, at, es.end);
  // Objekttyp 0x40: MPEG-4 Audio; danach 12 Bytes Stream-Art, Puffer und Bitraten
  if (!decoder || decoder.id !== 0x04 || decoder.start + 13 > decoder.end || b[decoder.start] !== 0x40) return null;
  const specific = mp4Descriptor(b, decoder.start + 13, decoder.end);
  if (!specific || specific.id !== 0x05 || specific.start + 2 > specific.end) return null;
  // 5 Bit Objekttyp, 4 Bit Abtastraten-Index, 4 Bit Kanäle, dann frameLengthFlag, dependsOnCoreCoder, extensionFlag
  const bits = u16be(b, specific.start);
  const rateIndex = (bits >> 7) & 15;
  const channels = (bits >> 3) & 15;
  if (bits >> 11 !== AAC_LC || rateIndex >= AAC_SAMPLE_RATES.length || (channels !== 1 && channels !== 2) || bits & 7) return null;
  return { rateIndex, channels };
}

/** OpusHead (RFC 7845) aus der dOps-Box (Opus in ISOBMFF): dieselben Felder, dort Big-Endian und mit Version 0 */
function mp4OpusHead(b: Uint8Array, dops: Mp4Box): Uint8Array | null {
  const size = dops.end - dops.start;
  if (size < 11 || b[dops.start] !== 0) return null;
  const head = concat([ascii("OpusHead"), b.subarray(dops.start, dops.end)]);
  head[8] = 1;
  // Pre-Skip (2 Bytes), Abtastrate der Aufnahme (4), Verstärkung (2): Byte-Reihenfolge umdrehen
  head.subarray(10, 12).reverse();
  head.subarray(12, 16).reverse();
  head.subarray(16, 18).reverse();
  return isOpusHead(head, 0, head.length) ? head : null;
}

/**
 * Codec der Spur aus stsd: genau ein Eintrag, mp4a (Version 0) mit esds oder
 * Opus mit dOps. Alles andere (ALAC, MP3 im MP4, QuickTime-Varianten,
 * mehrere Einträge): null.
 */
function mp4Codec(b: Uint8Array, stsd: Mp4Box): { aac: AacConfig } | { opus: Uint8Array } | null {
  if (stsd.start + 8 > stsd.end || u32be(b, stsd.start + 4) !== 1) return null;
  const entries = mp4Boxes(b, stsd.start + 8, stsd.end);
  if (entries?.length !== 1) return null;
  const entry = entries[0];
  // 6 Bytes reserviert, 2 Datenverweis, dann die Version (1 und 2 von QuickTime haben weitere Felder), zusammen 28 Bytes
  if (entry.start + 28 > entry.end || u16be(b, entry.start + 8) !== 0) return null;
  const inside = mp4Boxes(b, entry.start + 28, entry.end);
  if (entry.type === "mp4a") {
    const esds = mp4Only(inside, "esds");
    const aac = esds ? mp4AacConfig(b, esds) : null;
    return aac ? { aac } : null;
  }
  if (entry.type === "Opus") {
    const dops = mp4Only(inside, "dOps");
    const opus = dops ? mp4OpusHead(b, dops) : null;
    return opus ? { opus } : null;
  }
  return null;
}

/**
 * Ruft visit für jedes Sample der Spur in der Reihenfolge der Datei auf: erst
 * die Sample-Tabelle (stsz, stsc, stco oder co64), dann die Fragmente (moof
 * mit tfhd und trun, Standardgröße aus trex). Gelesen wird nur, wo ein Sample
 * liegt und wie groß es ist; Dauern und Zeitstempel (stts, tfdt, elst) nicht.
 *
 * false: visit lehnt ein Sample ab, oder die Angaben sind nicht sicher
 * lesbar: ein leeres Sample, eines außerhalb der Datei oder vor dem Ende des
 * vorigen (Samples liegen hintereinander, keines zweimal), eine Tabelle, die
 * nicht in ihre Box passt, stz2, mehr Samples als Platz in den Chunks, ein
 * Fragment für eine andere Spur oder mit mehreren Spuren.
 */
function mp4Samples(b: Uint8Array, top: Mp4Box[], moov: Mp4Box[], trackId: number, stbl: Mp4Box[], visit: (start: number, size: number) => boolean): boolean {
  let last = 0;
  const sample = (start: number, size: number): boolean => {
    if (size < 1 || start < last || start + size > b.length) return false;
    last = start + size;
    return visit(start, size);
  };

  const stsz = mp4Only(stbl, "stsz");
  if (!stsz || stsz.start + 12 > stsz.end) return false;
  const uniform = u32be(b, stsz.start + 4);
  const count = u32be(b, stsz.start + 8);
  if (count) {
    if (!uniform && stsz.start + 12 + count * 4 > stsz.end) return false;
    const stsc = mp4Only(stbl, "stsc");
    const offsets = stbl.filter(x => x.type === "stco" || x.type === "co64");
    if (!stsc || stsc.start + 8 > stsc.end || offsets.length !== 1 || offsets[0].start + 8 > offsets[0].end) return false;
    const wide = offsets[0].type === "co64";
    const chunks = u32be(b, offsets[0].start + 4);
    const runs = u32be(b, stsc.start + 4);
    if (offsets[0].start + 8 + chunks * (wide ? 8 : 4) > offsets[0].end || stsc.start + 8 + runs * 12 > stsc.end) return false;
    // stsc: ab welchem Chunk (gezählt ab 1) wie viele Samples je Chunk gelten, aufsteigend
    for (let i = 0; i < runs; i++) {
      const first = u32be(b, stsc.start + 8 + i * 12);
      if (i === 0 ? first !== 1 : first <= u32be(b, stsc.start + 8 + (i - 1) * 12)) return false;
    }
    let done = 0;
    let run = 0;
    for (let chunk = 1; chunk <= chunks && done < count && runs; chunk++) {
      if (run + 1 < runs && u32be(b, stsc.start + 8 + (run + 1) * 12) === chunk) run++;
      const at = offsets[0].start + 8 + (chunk - 1) * (wide ? 8 : 4);
      let pos = wide ? u32be(b, at) * 2 ** 32 + u32be(b, at + 4) : u32be(b, at);
      for (let n = u32be(b, stsc.start + 12 + run * 12); n > 0 && done < count; n--, done++) {
        const size = uniform || u32be(b, stsz.start + 12 + done * 4);
        if (!sample(pos, size)) return false;
        pos += size;
      }
    }
    if (done !== count) return false;
  }

  // Standardgröße der Samples in Fragmenten: trex der Spur
  let trexSize: number | null = null;
  for (const trex of mp4Inside(b, mp4Only(moov, "mvex"))?.filter(x => x.type === "trex") ?? []) {
    if (trex.start + 20 <= trex.end && u32be(b, trex.start + 4) === trackId) trexSize = u32be(b, trex.start + 16);
  }
  for (const moof of top) {
    if (moof.type !== "moof") continue;
    const trafs = mp4Inside(b, moof)?.filter(x => x.type === "traf");
    if (!trafs || trafs.length > 1) return false;
    if (!trafs.length) continue;
    const parts = mp4Inside(b, trafs[0]);
    const tfhd = mp4Only(parts, "tfhd");
    if (!parts || !tfhd || tfhd.start + 8 > tfhd.end || u32be(b, tfhd.start + 4) !== trackId) return false;
    // tfhd: je nach Flags Basis der Daten (8 Bytes), Beschreibungs-Index, Standarddauer, Standardgröße
    const flags = u32be(b, tfhd.start) & 0xffffff;
    let at = tfhd.start + 8;
    // Ohne eigene Basis zählt der Versatz ab dem Anfang von moof
    let base = moof.at;
    if (flags & 0x1) {
      if (at + 8 > tfhd.end) return false;
      base = u32be(b, at) * 2 ** 32 + u32be(b, at + 4);
      at += 8;
    }
    at += (flags & 0x2 ? 4 : 0) + (flags & 0x8 ? 4 : 0);
    let standard = trexSize;
    if (flags & 0x10) {
      if (at + 4 > tfhd.end) return false;
      standard = u32be(b, at);
    }
    let pos = base;
    for (const trun of parts) {
      if (trun.type !== "trun") continue;
      if (trun.start + 8 > trun.end) return false;
      // trun: Anzahl, je nach Flags Datenversatz und Flags des ersten Samples, dann je Sample Dauer, Größe, Flags, Versatz
      const f = u32be(b, trun.start) & 0xffffff;
      const samples = u32be(b, trun.start + 4);
      let entry = trun.start + 8;
      if (f & 0x1) {
        if (entry + 4 > trun.end) return false;
        // Mit Vorzeichen
        pos = base + (u32be(b, entry) | 0);
        entry += 4;
      }
      if (f & 0x4) entry += 4;
      const step = (f & 0x100 ? 4 : 0) + (f & 0x200 ? 4 : 0) + (f & 0x400 ? 4 : 0) + (f & 0x800 ? 4 : 0);
      if (entry + samples * step > trun.end) return false;
      for (let i = 0; i < samples; i++) {
        const size = f & 0x200 ? u32be(b, entry + i * step + (f & 0x100 ? 4 : 0)) : standard;
        if (size === null || !sample(pos, size)) return false;
        pos += size;
      }
    }
  }
  return true;
}

function be32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function mp4Box(type: string, ...parts: (Uint8Array | number[])[]): Uint8Array {
  const body = concat(parts.map(p => (p instanceof Uint8Array ? p : Uint8Array.from(p))));
  return concat([Uint8Array.from(be32(8 + body.length)), ascii(type), body]);
}

/**
 * Schreibt M4A aus den gezählten AAC-Frames (ihre Größen, dazu die Frames
 * hintereinander): eine Spur, je Frame ein Sample mit 1024 Abtastwerten, alle
 * in einem Chunk. Zeitbasis ist die Abtastrate, die Dauer in den Köpfen die
 * Summe der Frames.
 */
function m4aFile(config: AacConfig, sizes: number[], frames: Uint8Array): Uint8Array {
  const rate = AAC_SAMPLE_RATES[config.rateIndex];
  const duration = be32(sizes.length * AAC_FRAME_SAMPLES);
  const zeros = (n: number) => new Array<number>(n).fill(0);
  const matrix = [...be32(0x10000), ...zeros(12), ...be32(0x10000), ...zeros(12), ...be32(0x40000000)];
  // AudioSpecificConfig: AAC-LC, Abtastraten-Index, Kanäle, 1024 Abtastwerte je Frame
  const asc = [(AAC_LC << 3) | (config.rateIndex >> 1), ((config.rateIndex & 1) << 7) | (config.channels << 3)];
  // esds: ES-Deskriptor, darin Decoder-Konfiguration (MPEG-4 Audio, Audio-Stream) mit der AudioSpecificConfig, dann SL-Konfiguration
  const esds = mp4Box("esds", zeros(4), [0x03, 25, 0, 0, 0], [0x04, 17, 0x40, 0x15], zeros(11), [0x05, 2], asc, [0x06, 1, 2]);
  // Die Abtastrate steht hier als 16.16-Zahl; was nicht hineinpasst, steht nur in der AudioSpecificConfig
  const mp4a = mp4Box("mp4a", zeros(6), [0, 1], zeros(8), [0, config.channels, 0, 16], zeros(4), be32(rate <= 0xffff ? rate * 0x10000 : 0), esds);
  const table = new Uint8Array(sizes.length * 4);
  const view = new DataView(table.buffer);
  sizes.forEach((size, i) => view.setUint32(i * 4, size));
  const moov = (chunkOffset: number) =>
    mp4Box(
      "moov",
      mp4Box("mvhd", zeros(12), be32(rate), duration, be32(0x10000), [1, 0], zeros(10), matrix, zeros(24), be32(2)),
      mp4Box(
        "trak",
        mp4Box("tkhd", [0, 0, 0, 7], zeros(8), be32(1), zeros(4), duration, zeros(12), [1, 0, 0, 0], matrix, zeros(8)),
        mp4Box(
          "mdia",
          mp4Box("mdhd", zeros(12), be32(rate), duration, [0x55, 0xc4, 0, 0]),
          mp4Box("hdlr", zeros(8), ascii("soun"), zeros(13)),
          mp4Box(
            "minf",
            mp4Box("smhd", zeros(8)),
            mp4Box("dinf", mp4Box("dref", zeros(4), be32(1), mp4Box("url ", [0, 0, 0, 1]))),
            mp4Box(
              "stbl",
              mp4Box("stsd", zeros(4), be32(1), mp4a),
              mp4Box("stts", zeros(4), be32(1), be32(sizes.length), be32(AAC_FRAME_SAMPLES)),
              mp4Box("stsc", zeros(4), be32(1), be32(1), be32(sizes.length), be32(1)),
              mp4Box("stsz", zeros(4), be32(0), be32(sizes.length), table),
              mp4Box("stco", zeros(4), be32(1), be32(chunkOffset))
            )
          )
        )
      )
    );
  const ftyp = mp4Box("ftyp", ascii("M4A "), zeros(4), ascii("M4A mp42isom"));
  // Die Größe von moov hängt nicht vom Versatz ab: erst messen, dann mit dem Versatz schreiben
  const offset = ftyp.length + moov(0).length + 8;
  return concat([ftyp, moov(offset), mp4Box("mdat", frames)]);
}

/**
 * Die Samples der einen Tonspur, gezählt in der Einheit ihres Codecs. Der
 * Container sagt nur, wo die Samples liegen; was ein Sample enthält, liest
 * der Server selbst.
 *
 * - AAC-LC: jedes Sample muss genau ein AAC-Frame sein (./aac-frame liest
 *   seine Syntax bis zum Ende). Weiter geht ein neu geschriebenes M4A mit
 *   diesen Frames, je Frame nur das Kanal-Element und die Ende-Kennung
 * - Opus: jedes Sample ist ein Opus-Paket. Weiter geht Ogg/Opus wie bei WebM
 *
 * Nicht bestimmbar: ein anderer Codec, mehr als eine Spur, ein Sample mit
 * zwei Frames oder Resten, ein ungültiges Paket, Boxen, die ihren Bereich
 * nicht lückenlos füllen, und alles, was mp4Samples ablehnt.
 */
function prepareMp4(b: Uint8Array): PreparedAudio | null {
  const top = mp4Boxes(b, 0, b.length);
  const moov = mp4Inside(b, mp4Only(top, "moov"));
  const trak = mp4Inside(b, mp4Only(moov, "trak"));
  const tkhd = mp4Only(trak, "tkhd");
  const stbl = mp4Inside(b, mp4Only(mp4Inside(b, mp4Only(mp4Inside(b, mp4Only(trak, "mdia")), "minf")), "stbl"));
  const stsd = mp4Only(stbl, "stsd");
  if (!top || !moov || !tkhd || !stbl || !stsd) return null;
  // Spurnummer: nach Version und Flags zwei Zeitangaben zu 4 Bytes (Version 1: 8 Bytes)
  const idAt = tkhd.start + (b[tkhd.start] === 1 ? 20 : 12);
  if (idAt + 4 > tkhd.end) return null;
  const trackId = u32be(b, idAt);
  const codec = mp4Codec(b, stsd);
  if (!codec) return null;

  if ("opus" in codec) {
    const out = new OggOpusWriter();
    out.begin(codec.opus);
    return mp4Samples(b, top, moov, trackId, stbl, (start, size) => addOpusPacket(out, b, start, size)) ? out.result() : null;
  }
  // Der Frame, der weitergeht, ist nie größer als sein Sample: alle zusammen passen in die Länge der Datei
  const frames = new Uint8Array(b.length);
  const sizes: number[] = [];
  let used = 0;
  const complete = mp4Samples(b, top, moov, trackId, stbl, (start, size) => {
    // Zählen und Sammeln sind derselbe Schritt
    const frame = aacFrame(b, start, size, codec.aac);
    if (!frame) return false;
    frames.set(frame, used);
    used += frame.length;
    sizes.push(frame.length);
    return true;
  });
  if (!complete || !sizes.length) return null;
  const seconds = (sizes.length * AAC_FRAME_SAMPLES) / AAC_SAMPLE_RATES[codec.aac.rateIndex];
  return { seconds, audio: m4aFile(codec.aac, sizes, frames.subarray(0, used)), mime: "audio/mp4" };
}

/**
 * Zählt die Ton-Einheiten einer Aufnahme (Typ aus detectMedia, ./media-check)
 * und schreibt aus ihnen die Datei, die an die Erkennung geht; null, wenn
 * sich die Einheiten nicht sicher zählen lassen oder der Typ unbekannt ist.
 * Wer das Ergebnis noch einmal vorbereitet, bekommt dieselben Bytes und
 * dieselbe Dauer.
 */
export function prepareSpeechAudio(bytes: Uint8Array, mime: string): PreparedAudio | null {
  switch (mime) {
    case "audio/wav":
      return prepareWav(bytes);
    case "audio/ogg":
      return prepareOggOpus(bytes);
    case "audio/webm":
      return prepareWebmOpus(bytes);
    case "audio/mpeg":
      return prepareMp3(bytes);
    case "audio/mp4":
      return prepareMp4(bytes);
    default:
      return null;
  }
}

/** Dauer der vorbereiteten Aufnahme in Sekunden; null wie bei prepareSpeechAudio */
export function audioDurationSeconds(bytes: Uint8Array, mime: string): number | null {
  return prepareSpeechAudio(bytes, mime)?.seconds ?? null;
}
