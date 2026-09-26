/**
 * Kleine, vollständige Audio-Dateien für Tests (Issue #78): je ein
 * Beispiel für die Formate aus textToSpeech (Ogg/Opus, WAV, MP3) plus
 * Nicht-Audio, das eine Audio-Endung tragen könnte. Nur oggVorbisFixture
 * ist eine reine Signatur für Erkennungstests.
 */

function bytes(...parts: (string | number[] | Uint8Array)[]): Buffer {
  return Buffer.concat(parts.map(p => (typeof p === "string" ? Buffer.from(p, "latin1") : Buffer.from(p))));
}

const silence = (n: number) => new Uint8Array(n);

/** RIFF/WAVE mit fmt- und data-Block, 16 Bit mono 24 kHz wie Gemini */
export function wavFixture(): Buffer {
  const data = silence(480);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0);
  fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(24000, 4);
  fmt.writeUInt32LE(48000, 8);
  fmt.writeUInt16LE(2, 12);
  fmt.writeUInt16LE(16, 14);
  const size = Buffer.alloc(4);
  size.writeUInt32LE(36 + data.length, 0);
  const dataSize = Buffer.alloc(4);
  dataSize.writeUInt32LE(data.length, 0);
  return bytes("RIFF", size, "WAVE", "fmt ", [16, 0, 0, 0], fmt, "data", dataSize, data);
}

/*
 * Echte, dekodierbare Aufnahmen (440-Hz-Ton, 0,1 s), erzeugt mit ffmpeg:
 *   -f lavfi -i "sine=frequency=440:duration=0.1:sample_rate=16000" -ac 1
 *   -c:a libmp3lame -b:a 16k -write_xing 0 -id3v2_version 0|4 -f mp3
 *   (Ogg/Opus: sample_rate=48000, -c:a libopus -b:a 16k -f ogg)
 * Den Nachweis, dass sie vollständig und dekodierbar sind, führt
 * tests/audio-fixture.test.ts.
 */
const MP3_FRAMES =
  "//MoxAAM8ALRv0EYAqkAZLh//+AD4Pg+D58EInB85dLg+D4P8EOD7//D/AjsoD+sHDmIAf1gQ5kAf4EOcP9Hv6F0mHf/+icy" +
  "//MoxAcN6LKQAZt4AB+C/jJgQ6bAkBYgNkOQqEHJhYD2HKTkJKl9APCq7ErldB////evbWhfBUJA1+JToNLgEAlUgAfgbfi/" +
  "//MoxAoNkHKSOZXQAsS6VozoC5bAy2gAGgiAqRQksAMiucx4omGT4XhuDcRIVqvf//dXlP9Hfr9q6v+7RqlWC+WUjPEqy5QN" +
  "//MoxA4QgNqQAZuIAAE5sUFCk0gwABGZoehOFxYNzxgG4auD0RZnrdBAgpAibL32dPJkwRMjv4FIBX+VYFf+hg9uOYtxOjKc" +
  "//MoxAcOwLZAAc9IAcnoNkDKZSJJydLjVSkpHpZyUialxcE8aR1K6BECQqatChQ6qhQ5UlpIgp4KbFNyCuDfx/FMQU1Fqqqq";
const OGG_OPUS =
  "T2dnUwACAAAAAAAAAAAAAAAAAAAAAAIotXIBE09wdXNIZWFkAQE4AYC7AAAAAABPZ2dTAAAAAAAAAAAAAAAAAAABAAAASZW+" +
  "VAEuT3B1c1RhZ3MGAAAAZmZtcGVnAQAAABQAAABlbmNvZGVyPUxhdmMgbGlib3B1c09nZ1MABPgTAAAAAAAAAAAAAAIAAADp" +
  "HXrDBkU7NTM2I3iCAbdsRyTqAkZv+rYDjIE01uheAesbsV7vyXgY8gqzIUHM0aaf4Yqbhp1rgeoEnutAiitHUCgJ0EZTAHRN" +
  "tp96w/QA+XijP/esmIUDXCYKV5+K8o09bIVMwBPqQbZh53f7dxTMWHWvNRLH9wshBXhb4UZ4svXifY+1ePppKdPLeJujElFF" +
  "AKzjUZgqOLSDqFbpMHSeGsZ7FbYcChkq6O3Emtd53XZAdutGpV7d9egrqCh0sAV4m6MRtBy/Uih1GdqwJAwsUSZDbA//BI9Q" +
  "gCycHYoxq4Ic+sbnUMzJ9wP0HOjhbWiCb+J4m6NfdZz8STO/c/rkeazCRm0L4bmKPIbNcyzW2pEplP1EmVyzZhs/Iy83CL2C" +
  "aSK296Wi1Qt4BejXOi7/4IuNpCLnhsyRns2RB5AhKuG/GAvygLF3DPP/iQ==";

/** MP3 mit ID3v2.4-Kopf (10 Bytes Auffüllung), danach fünf MPEG-2-Layer-III-Frames (16 kbit/s, 16 kHz) */
export function mp3Id3Fixture(): Buffer {
  return bytes("ID3", [4, 0, 0, 0, 0, 0, 10], silence(10), Buffer.from(MP3_FRAMES, "base64"));
}

/** MP3 ohne ID3, direkt mit Frame-Sync, wie ElevenLabs es liefert */
export function mp3FrameFixture(): Buffer {
  return Buffer.from(MP3_FRAMES, "base64");
}

/** Ogg/Opus mit OpusHead, OpusTags und Audiospur, gültige Prüfsummen, wie ffmpeg -c:a libopus es schreibt */
export function oggOpusFixture(): Buffer {
  return Buffer.from(OGG_OPUS, "base64");
}

/** Nur die Signatur: Ogg-Container ohne Opus (z. B. Vorbis), für Erkennungstests */
export function oggVorbisFixture(): Buffer {
  const header = bytes("OggS", [0, 2], silence(8), [1, 0, 0, 0], silence(4), silence(4), [1, 30]);
  return bytes(header, [1], "vorbis", silence(80));
}

export const htmlFixture = () => Buffer.from("<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>Fehler</body></html>");

export const svgFixture = () =>
  Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
