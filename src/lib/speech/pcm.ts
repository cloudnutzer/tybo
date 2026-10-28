/**
 * PCM-Helfer für den Telefonhörer (Issue #257). Vertrag zum Browser: PCM16,
 * vorzeichenbehaftet, little-endian, mono. Hinein mit 16 kHz, heraus mit
 * 24 kHz (CALL_SAMPLE_RATE in src/web/call-protocol.ts).
 *
 * - pcmToWav: PCM16 mono mit WAV-Kopf (für Erkenner, die eine Datei wollen)
 * - wavToPcm: WAV am Stück lesen (Piper und andere Anbieter ohne Streaming)
 * - createWavStreamParser: WAV-Strom lesen, dessen Kopf eine unbekannte Länge
 *   trägt (pocket-tts schreibt nframes 1.000.000.000 und patcht nie)
 * - resamplePcm16: lineare Umrechnung der Abtastrate (Sprache, keine Musik)
 *
 * Erzeugter Ton für den Telefonhörer bleibt roher PCM-Strom und wird nicht
 * gespeichert; er trägt deshalb keine WAV-Kennzeichnung (./wav.ts).
 */

import { SpeechError } from "./types";

/** Länge des WAV-Kopfs vor den Tondaten: RIFF-Rahmen, fmt-Block und data-Kennung */
const WAV_HEAD_BYTES = 44;

/**
 * Schreibt den kanonischen 44-Byte-Kopf (einfaches PCM, ein Kanal, 16 Bit)
 * vor die Tondaten. Die Felder folgen hintereinander, der Zeiger wandert mit.
 */
export function pcmToWav(pcm: Uint8Array, sampleRate: number): Buffer {
  const wav = Buffer.alloc(WAV_HEAD_BYTES + pcm.length);
  let at = 0;
  const tag = (id: string) => {
    wav.write(id, at, 4, "latin1");
    at += 4;
  };
  const u16 = (n: number) => {
    at = wav.writeUInt16LE(n, at);
  };
  const u32 = (n: number) => {
    at = wav.writeUInt32LE(n, at);
  };
  tag("RIFF");
  u32(wav.length - 8);
  tag("WAVE");
  tag("fmt ");
  u32(16); // Größe des fmt-Blocks ohne Erweiterung
  u16(1); // Formatkennung: lineares PCM
  u16(1); // Kanäle
  u32(sampleRate);
  u32(sampleRate * 2); // Bytes je Sekunde
  u16(2); // Bytes je Abtastwert über alle Kanäle
  u16(16); // Bits je Abtastwert
  tag("data");
  u32(pcm.length);
  wav.set(pcm, at);
  return wav;
}

interface Fmt {
  sampleRate: number;
}

/** fmt prüfen: nur einfaches PCM, mono, 16 Bit */
function readFmt(b: Buffer, pos: number, size: number): Fmt {
  if (size < 16) throw new SpeechError("format");
  const format = b.readUInt16LE(pos);
  const channels = b.readUInt16LE(pos + 2);
  const sampleRate = b.readUInt32LE(pos + 4);
  const bits = b.readUInt16LE(pos + 14);
  if (format !== 1 || channels !== 1 || bits !== 16 || sampleRate < 8_000 || sampleRate > 96_000) throw new SpeechError("format");
  return { sampleRate };
}

/** WAV am Stück: Abtastrate und PCM16 des ersten data-Blocks */
export function wavToPcm(wav: Buffer): { sampleRate: number; pcm: Buffer } {
  if (wav.length < 12 || wav.toString("latin1", 0, 4) !== "RIFF" || wav.toString("latin1", 8, 12) !== "WAVE") throw new SpeechError("format");
  let pos = 12;
  let fmt: Fmt | null = null;
  while (pos + 8 <= wav.length) {
    const id = wav.toString("latin1", pos, pos + 4);
    const size = wav.readUInt32LE(pos + 4);
    if (id === "fmt ") fmt = readFmt(wav, pos + 8, size);
    else if (id === "data") {
      if (!fmt) throw new SpeechError("format");
      const end = Math.min(wav.length, pos + 8 + size);
      const pcm = wav.subarray(pos + 8, end - ((end - pos - 8) % 2));
      return { sampleRate: fmt.sampleRate, pcm };
    }
    pos = pos + 8 + size + (size & 1);
  }
  throw new SpeechError("format");
}

/**
 * WAV-Strom: push() nimmt die Bytes, wie sie kommen, und gibt PCM-Stücke
 * gerader Länge zurück, sobald der Kopf gelesen ist. Die Länge im data-Kopf
 * wird ignoriert (gestreamt ist sie unbekannt).
 */
/** Größter erlaubter WAV-Kopf (alle Blöcke vor data); der Ton danach zählt nicht */
export const MAX_WAV_HEAD_BYTES = 64 * 1024;

export function createWavStreamParser() {
  let head = Buffer.alloc(0);
  let fmt: Fmt | null = null;
  let inData = false;
  let carry: Buffer | null = null;
  let total = 0;
  return {
    push(chunk: Uint8Array): Buffer[] {
      let bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (!inData) {
        // Gepuffert wird nur, bis der Kopf vollständig ist; was danach im selben Stück kommt, ist Ton
        head = Buffer.concat([head, bytes]);
        if (head.length < 12) return [];
        if (head.toString("latin1", 0, 4) !== "RIFF" || head.toString("latin1", 8, 12) !== "WAVE") throw new SpeechError("format");
        let pos = 12;
        for (;;) {
          // Begrenzt wird nur der Kopf selbst: Blöcke vor data samt data-Kennung
          if (pos + 8 > MAX_WAV_HEAD_BYTES) throw new SpeechError("format");
          if (pos + 8 > head.length) return [];
          const id = head.toString("latin1", pos, pos + 4);
          const size = head.readUInt32LE(pos + 4);
          if (id === "data") {
            if (!fmt) throw new SpeechError("format");
            inData = true;
            bytes = head.subarray(pos + 8);
            head = Buffer.alloc(0);
            break;
          }
          if (pos + 8 + size > MAX_WAV_HEAD_BYTES) throw new SpeechError("format");
          if (pos + 8 + size > head.length) return [];
          if (id === "fmt ") fmt = readFmt(head, pos + 8, size);
          pos = pos + 8 + size + (size & 1);
        }
      }
      if (carry) {
        bytes = Buffer.concat([carry, bytes]);
        carry = null;
      }
      if (bytes.length % 2) {
        carry = Buffer.from(bytes.subarray(bytes.length - 1));
        bytes = bytes.subarray(0, bytes.length - 1);
      }
      if (!bytes.length) return [];
      total += bytes.length;
      return [Buffer.from(bytes)];
    },
    get sampleRate(): number | null {
      return fmt?.sampleRate ?? null;
    },
    get started(): boolean {
      return inData;
    },
    get totalBytes(): number {
      return total;
    },
  };
}

/** Lineare Umrechnung von PCM16 mono; gleiche Rate: unverändert */
export function resamplePcm16(pcm: Uint8Array, from: number, to: number): Buffer {
  const input = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2));
  if (from === to || input.length < 4) return input;
  const n = input.length / 2;
  const outN = Math.max(1, Math.round((n * to) / from));
  const out = Buffer.alloc(outN * 2);
  const step = (n - 1) / Math.max(1, outN - 1);
  for (let i = 0; i < outN; i++) {
    const x = i * step;
    const k = Math.floor(x);
    const frac = x - k;
    const a = input.readInt16LE(k * 2);
    const b = input.readInt16LE(Math.min(n - 1, k + 1) * 2);
    out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(a + (b - a) * frac))), i * 2);
  }
  return out;
}
