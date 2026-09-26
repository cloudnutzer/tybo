/**
 * Audioformat an den Bytes erkennen (Issue #78): textToSpeech in
 * src/lib/voice.ts liefert je nach Weg Ogg/Opus (lokales Qwen3-TTS mit
 * ffmpeg), WAV (lokal ohne ffmpeg, Gemini) oder MP3 (ElevenLabs). Endung und
 * MIME-Typ kommen deshalb aus dem Inhalt, nicht pauschal audio/mpeg. Alles
 * andere (HTML-Fehlerseiten, SVG, leere oder abgeschnittene Daten) gilt als
 * fehlgeschlagene Synthese und wird nie als Sprachnachricht verschickt.
 *
 * Rein, ohne Laufzeit-Importe.
 */

export interface AudioType {
  mime: "audio/ogg" | "audio/wav" | "audio/mpeg";
  /** Endung mit Punkt */
  ext: ".ogg" | ".wav" | ".mp3";
}

/** Darunter ist es kein brauchbares Audio, auch wenn der Anfang passt (ein WAV-Kopf allein hat 44 Bytes) */
export const MIN_AUDIO_BYTES = 64;

function ascii(data: Uint8Array, offset: number, text: string): boolean {
  if (data.length < offset + text.length) return false;
  for (let i = 0; i < text.length; i++) {
    if (data[offset + i] !== text.charCodeAt(i)) return false;
  }
  return true;
}

function indexOfAscii(data: Uint8Array, text: string, limit: number): number {
  const end = Math.min(data.length, limit) - text.length;
  for (let i = 0; i <= end; i++) if (ascii(data, i, text)) return i;
  return -1;
}

/** MPEG-Audio-Frame-Kopf: 11 Bit Sync, gültige Version, Layer, Bitrate und Abtastrate */
function isMpegFrameHeader(data: Uint8Array, offset = 0): boolean {
  if (data.length < offset + 4) return false;
  const b1 = data[offset + 1]!;
  const b2 = data[offset + 2]!;
  if (data[offset] !== 0xff || (b1 & 0xe0) !== 0xe0) return false;
  const version = (b1 >> 3) & 0x03; // 01 reserviert
  const layer = (b1 >> 1) & 0x03; // 00 reserviert
  const bitrate = (b2 >> 4) & 0x0f; // 1111 ungültig, 0000 „frei" kommt in der Praxis nicht vor
  const sampleRate = (b2 >> 2) & 0x03; // 11 reserviert
  return version !== 0x01 && layer !== 0x00 && bitrate !== 0x0f && bitrate !== 0x00 && sampleRate !== 0x03;
}

/**
 * Erkennt Ogg/Opus, WAV und MP3 (mit ID3-Kopf oder direkt mit Frame-Sync).
 * null: kein Audio, das als Sprachnachricht taugt.
 */
export function detectAudioType(data: Uint8Array | null | undefined): AudioType | null {
  if (!data || data.length < MIN_AUDIO_BYTES) return null;
  // Ogg-Container reicht nicht: Telegram spielt Sprachnachrichten nur mit Opus
  // ab. Der OpusHead steht im ersten Ogg-Paket direkt hinter dem Seitenkopf
  if (ascii(data, 0, "OggS")) return indexOfAscii(data, "OpusHead", 128) > 0 ? { mime: "audio/ogg", ext: ".ogg" } : null;
  if (ascii(data, 0, "RIFF") && ascii(data, 8, "WAVE")) return { mime: "audio/wav", ext: ".wav" };
  if (ascii(data, 0, "ID3")) {
    // ID3v2: Version 2 bis 4, Größe als vier 7-Bit-Bytes
    const major = data[3]!;
    const sizeBytes = [data[6]!, data[7]!, data[8]!, data[9]!];
    if (major < 2 || major > 4 || sizeBytes.some(b => b >= 0x80)) return null;
    return { mime: "audio/mpeg", ext: ".mp3" };
  }
  if (isMpegFrameHeader(data)) return { mime: "audio/mpeg", ext: ".mp3" };
  return null;
}
