/**
 * Issue #78: Die Audio-Fixtures für Synthese- und Versandtests sind echte,
 * vollständige Dateien. Ohne Werkzeuge: Ogg-Seiten mit gültigen Prüfsummen
 * bis zur letzten Seite, MP3-Frames lückenlos bis zum Dateiende. Mit
 * installiertem ffmpeg zusätzlich: streng dekodiert, ohne Fehler, mit Ton.
 */
import { describe, expect, test } from "bun:test";
import { mp3FrameFixture, mp3Id3Fixture, oggOpusFixture, wavFixture } from "./audio-fixture";

/** CRC-32 der Ogg-Seiten: Polynom 0x04c11db7, nicht gespiegelt, Startwert 0 */
function oggCrc(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 24;
    for (let i = 0; i < 8; i++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
  }
  return crc >>> 0;
}

/** Zerlegt eine Ogg-Datei in Pakete; wirft bei falschem Aufbau oder falscher Prüfsumme */
function readOgg(data: Buffer): { packets: Buffer[]; lastGranule: bigint; eos: boolean } {
  const packets: Buffer[] = [];
  let pending: Buffer[] = [];
  let offset = 0;
  let sequence = 0;
  let lastGranule = 0n;
  let eos = false;
  while (offset < data.length) {
    if (eos) throw new Error("Daten nach der letzten Seite");
    if (data.toString("latin1", offset, offset + 4) !== "OggS") throw new Error(`keine Ogg-Seite bei ${offset}`);
    const flags = data[offset + 5]!;
    lastGranule = data.readBigInt64LE(offset + 6);
    if (data.readUInt32LE(offset + 18) !== sequence++) throw new Error("Seitennummer springt");
    const segments = data[offset + 26]!;
    const lacing = data.subarray(offset + 27, offset + 27 + segments);
    const headerLength = 27 + segments;
    const bodyLength = lacing.reduce((sum, n) => sum + n, 0);
    const page = Buffer.from(data.subarray(offset, offset + headerLength + bodyLength));
    if (page.length !== headerLength + bodyLength) throw new Error("Seite abgeschnitten");
    const stored = page.readUInt32LE(22);
    page.writeUInt32LE(0, 22);
    if (oggCrc(page) !== stored) throw new Error(`Prüfsumme falsch auf Seite ${sequence - 1}`);
    let bodyOffset = headerLength;
    for (const n of lacing) {
      pending.push(page.subarray(bodyOffset, bodyOffset + n));
      bodyOffset += n;
      if (n < 255) {
        packets.push(Buffer.concat(pending));
        pending = [];
      }
    }
    eos = (flags & 0x04) !== 0;
    offset += page.length;
  }
  if (pending.length) throw new Error("letztes Paket unvollständig");
  return { packets, lastGranule, eos };
}

const MPEG2_LAYER3_KBITS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const MPEG1_LAYER3_KBITS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const SAMPLE_RATES: Record<number, number[]> = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

/** Zählt Layer-III-Frames hinter einem ID3v2-Kopf; wirft, wenn sie nicht genau bis zum Dateiende reichen */
function countMp3Frames(data: Buffer): number {
  let offset = 0;
  if (data.toString("latin1", 0, 3) === "ID3") {
    const size = ((data[6]! & 0x7f) << 21) | ((data[7]! & 0x7f) << 14) | ((data[8]! & 0x7f) << 7) | (data[9]! & 0x7f);
    offset = 10 + size + (data[5]! & 0x10 ? 10 : 0);
  }
  let frames = 0;
  while (offset < data.length) {
    if (data.length < offset + 4 || data[offset] !== 0xff || (data[offset + 1]! & 0xe0) !== 0xe0) throw new Error(`kein Frame bei ${offset}`);
    const version = (data[offset + 1]! >> 3) & 0x03;
    const layer = (data[offset + 1]! >> 1) & 0x03;
    if (layer !== 0x01 || version === 0x01) throw new Error("kein MPEG-Layer-III-Frame");
    const kbits = (version === 3 ? MPEG1_LAYER3_KBITS : MPEG2_LAYER3_KBITS)[data[offset + 2]! >> 4];
    const sampleRate = SAMPLE_RATES[version]![(data[offset + 2]! >> 2) & 0x03];
    if (!kbits || !sampleRate) throw new Error("ungültige Bitrate oder Abtastrate");
    const padding = (data[offset + 2]! >> 1) & 0x01;
    const length = Math.floor(((version === 3 ? 144 : 72) * kbits * 1000) / sampleRate) + padding;
    if (offset + length > data.length) throw new Error(`Frame ${frames} abgeschnitten`);
    offset += length;
    frames++;
  }
  return frames;
}

describe("Audio-Fixtures sind vollständig", () => {
  test("Ogg/Opus: OpusHead, OpusTags, Audiopakete, gültige Prüfsummen, Endseite", () => {
    const { packets, lastGranule, eos } = readOgg(oggOpusFixture());
    expect(packets[0]!.toString("latin1", 0, 8)).toBe("OpusHead");
    expect(packets[1]!.toString("latin1", 0, 8)).toBe("OpusTags");
    expect(packets.length).toBeGreaterThan(2);
    expect(lastGranule).toBeGreaterThan(0n);
    expect(eos).toBe(true);
  });

  test("Ogg-Prüfung erkennt eine verfälschte Seite", () => {
    const broken = oggOpusFixture();
    broken[broken.length - 1]! ^= 0xff;
    expect(() => readOgg(broken)).toThrow("Prüfsumme");
  });

  test("MP3 mit und ohne ID3: vollständige Frames bis zum Dateiende", () => {
    expect(countMp3Frames(mp3FrameFixture())).toBe(5);
    expect(countMp3Frames(mp3Id3Fixture())).toBe(5);
  });

  test("MP3-Prüfung erkennt einen abgeschnittenen Frame", () => {
    expect(() => countMp3Frames(mp3FrameFixture().subarray(0, 100))).toThrow("abgeschnitten");
  });

  const decodable = [
    ["MP3 ohne ID3", mp3FrameFixture],
    ["MP3 mit ID3", mp3Id3Fixture],
    ["Ogg/Opus", oggOpusFixture],
    ["WAV", wavFixture],
  ] as const;
  for (const [name, fixture] of decodable) {
    test.skipIf(!Bun.which("ffmpeg"))(`${name}: ffmpeg dekodiert streng, ohne Fehler, mit Ton (nur mit installiertem ffmpeg)`, async () => {
      const proc = Bun.spawn(["ffmpeg", "-v", "error", "-xerror", "-err_detect", "explode", "-i", "pipe:0", "-f", "s16le", "pipe:1"], {
        stdin: fixture(),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [pcm, errors, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), new Response(proc.stderr).text(), proc.exited]);
      expect(errors).toBe("");
      expect(code).toBe(0);
      expect(pcm.byteLength).toBeGreaterThan(0);
    });
  }
});
