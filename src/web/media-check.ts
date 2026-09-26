/**
 * Typprüfung und Größengrenzen für Medien aus dem Web (Issue #71, #72).
 * Ohne Abhängigkeiten, damit auch der Web-Server (Upload-Route) sie nutzen
 * kann, ohne Asset-Speicher oder Transkription zu laden. Der Medien-Kern
 * (src/lib/media-turn.ts) exportiert alles hier weiter.
 */

export type MediaKind = "image" | "document" | "audio";

export interface DetectedMedia {
  kind: MediaKind;
  mime: string;
  ext: string;
}

export type MediaCheck =
  | { ok: true; kind: MediaKind; mime: string; ext: string }
  | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Typprüfung und Grenzen (nur Web-Pfad). Geprüft wird nur der Kopf der Datei,
// Dateiname und angegebener MIME-Typ fließen nicht ein.
// ---------------------------------------------------------------------------

export const MB = 1_048_576;
export const MEDIA_LIMITS: Record<MediaKind, number> = {
  image: 20 * MB,
  document: 20 * MB,
  audio: 25 * MB,
};

export const MEDIA_KIND_LABEL: Record<MediaKind, string> = { image: "Bild", document: "PDF", audio: "Sprachdatei" };

/** Nur so viel WebM wird nach den Spuren durchsucht */
const WEBM_SCAN_BYTES = 64 * 1024;

function startsWith(bytes: Uint8Array, sig: number[] | string, offset = 0): boolean {
  const s = typeof sig === "string" ? [...sig].map(c => c.charCodeAt(0)) : sig;
  if (bytes.length < offset + s.length) return false;
  return s.every((b, i) => bytes[offset + i] === b);
}

function u32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

/** OGG: erste Seite strukturell lesen, ihr erstes Paket muss mit OpusHead beginnen */
function isOggOpus(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, "OggS") || bytes.length < 27 || bytes[4] !== 0) return false;
  const segments = bytes[26];
  const payloadStart = 27 + segments;
  if (bytes.length < payloadStart) return false;
  // Das erste Paket endet mit dem ersten Lacing-Wert unter 255
  let packetLength = 0;
  for (let i = 0; i < segments; i++) {
    packetLength += bytes[27 + i];
    if (bytes[27 + i] < 255) break;
  }
  if (packetLength < 8 || bytes.length < payloadStart + 8) return false;
  return startsWith(bytes, "OpusHead", payloadStart);
}

/** M4A: vollständige ftyp-Box, Haupt- oder Neben-Marke M4A bzw. M4B */
function isM4a(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, "ftyp", 4)) return false;
  const size = u32(bytes, 0);
  if (size < 16 || size > bytes.length || size % 4 !== 0) return false;
  const brands = [8];
  for (let o = 16; o + 4 <= size; o += 4) brands.push(o);
  return brands.some(o => startsWith(bytes, "M4A ", o) || startsWith(bytes, "M4B ", o));
}

// --- MP4 ohne M4A-Marke (Aufnahme im Browser, Issue #109) ---

interface Mp4Box {
  type: string;
  dataStart: number;
  end: number;
}

/** Boxen zwischen start und end; null, wenn eine Box unvollständig oder kaputt ist */
function mp4Boxes(bytes: Uint8Array, start: number, end: number): Mp4Box[] | null {
  const boxes: Mp4Box[] = [];
  let pos = start;
  while (pos < end) {
    if (pos + 8 > end) return null;
    let size = u32(bytes, pos);
    let header = 8;
    if (size === 1) {
      // 64-Bit-Größe; mehr als 2^53 kommt bei 25 MB nicht vor
      if (pos + 16 > end) return null;
      size = u32(bytes, pos + 8) * 2 ** 32 + u32(bytes, pos + 12);
      header = 16;
    } else if (size === 0) {
      size = end - pos;
    }
    if (size < header || pos + size > end) return null;
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    boxes.push({ type, dataStart: pos + header, end: pos + size });
    pos += size;
  }
  return boxes;
}

/** Handler-Typ einer Spur (trak > mdia > hdlr); null, wenn er fehlt oder mehrdeutig ist */
function mp4TrackHandler(bytes: Uint8Array, trak: Mp4Box): string | null {
  const mdia = mp4Boxes(bytes, trak.dataStart, trak.end)?.filter(b => b.type === "mdia");
  if (!mdia || mdia.length !== 1) return null;
  const hdlr = mp4Boxes(bytes, mdia[0].dataStart, mdia[0].end)?.filter(b => b.type === "hdlr");
  // Version und Flags (4), pre_defined (4), dann der Handler-Typ
  if (!hdlr || hdlr.length !== 1 || hdlr[0].end - hdlr[0].dataStart < 12) return null;
  const at = hdlr[0].dataStart + 8;
  return String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);
}

/**
 * MP4 nur als Audio, wie MediaRecorder es schreibt (Chrome und Firefox mit
 * Marke isom, Safari mit eigenen Marken): ftyp-Box am Anfang, die ganze
 * Datei lückenlos aus Boxen, genau eine moov-Box (am Anfang oder am Ende)
 * und darin nur Spuren mit Handler „soun", mindestens eine. Video-, Text-
 * oder unbekannte Spuren und alles Unvollständige werden abgelehnt.
 */
function isAudioMp4(bytes: Uint8Array): boolean {
  if (!startsWith(bytes, "ftyp", 4)) return false;
  const top = mp4Boxes(bytes, 0, bytes.length);
  if (!top || top[0].type !== "ftyp" || top[0].end - top[0].dataStart < 8) return false;
  if (top.slice(1).some(b => b.type === "ftyp")) return false;
  const moov = top.filter(b => b.type === "moov");
  if (moov.length !== 1) return false;
  const inner = mp4Boxes(bytes, moov[0].dataStart, moov[0].end);
  if (!inner) return false;
  const tracks = inner.filter(b => b.type === "trak");
  if (!tracks.length) return false;
  return tracks.every(trak => mp4TrackHandler(bytes, trak) === "soun");
}

// --- EBML (WebM) ---

interface EbmlElement {
  id: number;
  dataStart: number;
  /** null: unbekannte Größe */
  size: number | null;
}

/** Liest Kopf eines EBML-Elements; null, wenn er nicht vollständig im Fenster liegt */
function readEbmlHeader(bytes: Uint8Array, pos: number, end: number): EbmlElement | null {
  if (pos >= end) return null;
  const first = bytes[pos];
  let idLength = 0;
  for (let mask = 0x80, n = 1; n <= 4; mask >>= 1, n++) {
    if (first & mask) { idLength = n; break; }
  }
  if (!idLength || pos + idLength > end) return null;
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + bytes[pos + i];
  const sizePos = pos + idLength;
  if (sizePos >= end) return null;
  const sizeFirst = bytes[sizePos];
  let sizeLength = 0;
  for (let mask = 0x80, n = 1; n <= 8; mask >>= 1, n++) {
    if (sizeFirst & mask) { sizeLength = n; break; }
  }
  if (!sizeLength || sizePos + sizeLength > end) return null;
  let size = sizeFirst & (0xff >> sizeLength);
  let allOnes = size === 0xff >> sizeLength;
  for (let i = 1; i < sizeLength; i++) {
    const b = bytes[sizePos + i];
    if (b !== 0xff) allOnes = false;
    size = size * 256 + b;
  }
  return { id, dataStart: sizePos + sizeLength, size: allOnes ? null : size };
}

function* ebmlChildren(bytes: Uint8Array, start: number, end: number): Generator<EbmlElement | null> {
  let pos = start;
  while (pos < end) {
    const el = readEbmlHeader(bytes, pos, end);
    yield el;
    if (!el || el.size === null) return;
    pos = el.dataStart + el.size;
  }
}

const EBML_HEADER = 0x1a45dfa3;
const EBML_DOCTYPE = 0x4282;
const EBML_SEGMENT = 0x18538067;
const EBML_TRACKS = 0x1654ae6b;
const EBML_TRACK_ENTRY = 0xae;
const EBML_TRACK_TYPE = 0x83;
const EBML_TRACK_VIDEO = 0xe0;
const EBML_CLUSTER = 0x1f43b675;

/**
 * Audiospuren einer Tracks-Liste; null bei Videospur, fehlendem oder
 * mehrfachem TrackType und bei Elementen über die Listengrenze hinaus
 */
function countAudioTracks(bytes: Uint8Array, start: number, end: number): number | null {
  let audio = 0;
  for (const entry of ebmlChildren(bytes, start, end)) {
    if (!entry || entry.size === null || entry.dataStart + entry.size > end) return null;
    if (entry.id !== EBML_TRACK_ENTRY) continue;
    const entryEnd = entry.dataStart + entry.size;
    let type: number | null = null;
    for (const field of ebmlChildren(bytes, entry.dataStart, entryEnd)) {
      if (!field || field.size === null || field.dataStart + field.size > entryEnd) return null;
      if (field.id === EBML_TRACK_VIDEO) return null;
      if (field.id !== EBML_TRACK_TYPE) continue;
      if (type !== null || field.size < 1 || field.size > 4) return null;
      type = 0;
      for (let i = 0; i < field.size; i++) type = type * 256 + bytes[field.dataStart + i];
    }
    if (type === null || type === 1) return null;
    if (type === 2) audio++;
  }
  return audio;
}

/**
 * WebM nur als Audio: DocType webm, in den ersten 64 KiB genau eine
 * vollständige Tracks-Liste mit mindestens einer Audiospur (TrackType 2) und
 * keiner Videospur. Geprüft wird das Segment bis zu seinem Ende bzw. bis zum
 * Fensterende, auch über Cluster hinweg. Unvollständiges oder Unklares vor
 * dem ersten Cluster wird abgelehnt.
 */
function isAudioWebm(all: Uint8Array): boolean {
  if (!startsWith(all, [0x1a, 0x45, 0xdf, 0xa3])) return false;
  const bytes = all.subarray(0, WEBM_SCAN_BYTES);
  const end = bytes.length;
  const header = readEbmlHeader(bytes, 0, end);
  if (!header || header.id !== EBML_HEADER || header.size === null) return false;
  const headerEnd = header.dataStart + header.size;
  if (headerEnd > end) return false;
  let docType: string | null = null;
  for (const el of ebmlChildren(bytes, header.dataStart, headerEnd)) {
    if (!el || el.size === null || el.dataStart + el.size > headerEnd) return false;
    if (el.id === EBML_DOCTYPE) {
      docType = String.fromCharCode(...bytes.subarray(el.dataStart, el.dataStart + el.size)).replace(/\0+$/, "");
    }
  }
  if (docType !== "webm") return false;

  // Segment suchen (davor dürfen nur Elemente mit bekannter Größe stehen)
  let segment: EbmlElement | null = null;
  for (const el of ebmlChildren(bytes, headerEnd, end)) {
    if (!el) return false;
    if (el.id === EBML_SEGMENT) { segment = el; break; }
    if (el.size === null) return false;
  }
  if (!segment) return false;
  const segmentComplete = segment.size !== null && segment.dataStart + segment.size <= end;
  const segmentEnd = segmentComplete ? segment.dataStart + segment.size! : end;

  // Nach dem ersten Cluster wird bis zum Fensterende weitergelesen, damit eine
  // spätere Tracks-Liste (etwa mit Videospur) nicht übersehen wird. Cluster
  // unbekannter Größe werden flach durchlaufen: ihre Kinder (Timecode, Blöcke)
  // haben andere IDs als Tracks, ein folgendes Element bleibt so sichtbar.
  let audio: number | null = null;
  let clusterSeen = false;
  // Ende des Fensters mitten in einem Element: bis dahin ist alles geprüft
  const windowEndsHere = () => clusterSeen && !segmentComplete;
  let pos = segment.dataStart;
  while (pos < segmentEnd) {
    const el = readEbmlHeader(bytes, pos, segmentEnd);
    if (!el) return windowEndsHere();
    if (el.id === EBML_CLUSTER) {
      // Spuren müssen vor dem ersten Cluster stehen
      if (audio === null || audio === 0) return false;
      clusterSeen = true;
      if (el.size === null) { pos = el.dataStart; continue; }
      if (el.dataStart + el.size > segmentEnd) return windowEndsHere();
      pos = el.dataStart + el.size;
      continue;
    }
    if (el.size === null) return false;
    const elEnd = el.dataStart + el.size;
    if (el.id === EBML_TRACKS) {
      // Eine zweite Tracks-Liste ist mehrdeutig
      if (audio !== null || elEnd > segmentEnd) return false;
      audio = countAudioTracks(bytes, el.dataStart, elEnd);
      if (audio === null) return false;
    } else if (elEnd > segmentEnd) {
      return windowEndsHere();
    }
    pos = elEnd;
  }
  // Ohne Cluster nur, wenn das Segment vollständig im Fenster lag
  return (segmentComplete || clusterSeen) && audio !== null && audio > 0;
}

/** Art, MIME-Typ und Endung nur aus den Bytes; null, wenn nicht erlaubt */
export function detectMedia(bytes: Uint8Array): DetectedMedia | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { kind: "image", mime: "image/png", ext: "png" };
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return { kind: "image", mime: "image/jpeg", ext: "jpg" };
  if (startsWith(bytes, "GIF87a") || startsWith(bytes, "GIF89a")) return { kind: "image", mime: "image/gif", ext: "gif" };
  if (startsWith(bytes, "RIFF") && startsWith(bytes, "WEBP", 8)) return { kind: "image", mime: "image/webp", ext: "webp" };
  if (startsWith(bytes, "%PDF-")) return { kind: "document", mime: "application/pdf", ext: "pdf" };
  if (isOggOpus(bytes)) return { kind: "audio", mime: "audio/ogg", ext: "ogg" };
  if (isM4a(bytes) || isAudioMp4(bytes)) return { kind: "audio", mime: "audio/mp4", ext: "m4a" };
  if (isAudioWebm(bytes)) return { kind: "audio", mime: "audio/webm", ext: "webm" };
  if (startsWith(bytes, "RIFF") && startsWith(bytes, "WAVE", 8)) return { kind: "audio", mime: "audio/wav", ext: "wav" };
  if (startsWith(bytes, "ID3")) return { kind: "audio", mime: "audio/mpeg", ext: "mp3" };
  // MP3-Frame-Sync: vollständiger 4-Byte-Frame-Kopf verlangt
  if (bytes.length >= 4 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) return { kind: "audio", mime: "audio/mpeg", ext: "mp3" };
  return null;
}

/** detectMedia plus Größengrenze je Art */
export function checkMediaUpload(bytes: Uint8Array): MediaCheck {
  if (bytes.length === 0) return { ok: false, reason: "Die Datei ist leer." };
  const detected = detectMedia(bytes);
  if (!detected) {
    return {
      ok: false,
      reason: "Dateityp nicht erlaubt. Erlaubt sind Bilder (PNG, JPEG, GIF, WebP), PDF und Sprachdateien (OGG, MP3, M4A, WebM, WAV).",
    };
  }
  const limit = MEDIA_LIMITS[detected.kind];
  if (bytes.length > limit) {
    return { ok: false, reason: `Datei zu groß: ${MEDIA_KIND_LABEL[detected.kind]} höchstens ${limit / MB} MB.` };
  }
  return { ok: true, ...detected };
}
