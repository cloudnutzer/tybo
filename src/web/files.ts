/**
 * Dateien aus Meldungen herunterladen (Entscheidung 0006, Issue #47):
 * GET /api/files/<id>.
 *
 * - Nur ids, zu denen ein festgehaltener Eintrag existiert (FileSource.find,
 *   unabhängig von der gerade geladenen Verlaufsseite). Verwaiste Dateien
 *   in der Ablage ohne Eintrag gibt es nicht.
 * - Ausgeliefert wird nur <Ablage>/<id>/<Name aus dem Eintrag>, eine
 *   gewöhnliche Datei; Symlinks und alles, was aufgelöst außerhalb der
 *   Ablage liegt, ergeben 404.
 * - Immer Content-Disposition: attachment und nosniff. Nur mit ?inline=1 und
 *   nur für PNG, JPEG, WebP und GIF (Endung, festgehaltener Typ und die
 *   ersten Bytes passen zusammen) inline als Bild. SVG und alles andere kommen
 *   nie inline, sondern als application/octet-stream zum Speichern.
 * - Dateien aus Meldungen (rich) dazu: Audio und Video inline mit Range, weil
 *   Safari ohne Range nichts abspielt, nach denselben Prüfungen. HTML inline nur
 *   mit SANDBOXED_HTML_CSP: Die Seite läuft ohne eigenen Ursprung, kommt also
 *   weder an Sitzung noch an die API.
 *
 * Reine Web-Seite: nichts aus src/lib. Die echte FileSource baut
 * src/web/bot-files.ts für src/bot.ts.
 */

import { lstat, open, realpath } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { OUTBOX_FILE_ID_PATTERN, isSafeFileName, type NoticeFile } from "./notice";

export const FILES_PATH = /^\/api\/files\/([^/]+)$/;

export interface FileSource {
  /**
   * Geprüfte Angaben der Datei aus dem festgehaltenen Eintrag; null, wenn es
   * keinen gibt. webConversationIds: die reinen Web-Gespräche, die es gerade
   * gibt (Issue #227, Meldungen unter web:<uuid>). Darf werfen (Speicher
   * nicht lesbar), der Server antwortet dann mit 503.
   */
  find(id: string, webConversationIds?: string[]): Promise<NoticeFile | null>;
}

export interface FilesDeps {
  source: FileSource;
  /** Wurzel der Ablage, im Bot data/outbox */
  dir: string;
}

/** Bildtypen mit Vorschau: Endung → MIME-Typ */
const INLINE_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

/** Audio und Video zum Abspielen: Endung → MIME-Typ */
const MEDIA_TYPES: Record<string, string> = {
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
};

const HTML_EXTENSIONS = new Set([".html", ".htm"]);

/**
 * HTML aus Meldungen: sandbox ohne allow-same-origin nimmt der Seite den
 * Ursprung (keine Cookies, keine Anfragen als angemeldeter Nutzer), ohne
 * connect-src schickt sie nichts per Skript nach außen. Eigene Skripte, Bilder,
 * Schriften und eingebettete Hörproben laufen weiter.
 */
export const SANDBOXED_HTML_CSP =
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads; " +
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' https:; " +
  "img-src data: blob: https:; media-src data: blob:; font-src data: https:; " +
  "base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

/** Bildtyp mit Vorschau für einen Dateinamen, sonst null */
export function inlineImageType(name: string): string | null {
  return INLINE_TYPES[extname(name).toLowerCase()] ?? null;
}

/** Passen die ersten Bytes zum Bildtyp? */
function magicMatches(type: string, head: Uint8Array): boolean {
  const ascii = (from: number, to: number) => String.fromCharCode(...head.subarray(from, to));
  switch (type) {
    case "image/png":
      return head[0] === 0x89 && ascii(1, 4) === "PNG";
    case "image/jpeg":
      return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    case "image/gif":
      return ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a";
    case "image/webp":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
    case "audio/mpeg":
      return ascii(0, 3) === "ID3" || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0);
    case "audio/mp4":
    case "video/mp4":
      return ascii(4, 8) === "ftyp";
    case "video/quicktime":
      return ["ftyp", "moov", "mdat", "wide", "free"].includes(ascii(4, 8));
    case "audio/wav":
      return ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE";
    case "audio/ogg":
      return ascii(0, 4) === "OggS";
    case "audio/flac":
      return ascii(0, 4) === "fLaC";
    case "video/webm":
      return head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3;
    default:
      return false;
  }
}

/**
 * Content-Disposition mit ASCII-Ersatznamen und dem echten Namen nach
 * RFC 5987 (Umlaute), ohne Anführungszeichen, Backslash oder Steuerzeichen.
 */
export function contentDisposition(kind: "attachment" | "inline", name: string): string {
  const fallback = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\;]/g, "_")
    .trim() || "datei";
  const encoded = encodeURIComponent(name).replace(/['()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

type Resolved = { path: string } | null;

/** Pfad der Datei, nur wenn sie als gewöhnliche Datei innerhalb der Ablage liegt */
async function resolveInside(dir: string, file: NoticeFile): Promise<Resolved> {
  if (!OUTBOX_FILE_ID_PATTERN.test(file.id) || !isSafeFileName(file.name)) return null;
  let root: string;
  try {
    root = await realpath(dir);
  } catch {
    return null;
  }
  const folder = join(root, file.id);
  const target = join(folder, file.name);
  if (!target.startsWith(folder + sep)) return null;
  try {
    // Weder Ordner noch Datei dürfen Symlinks sein
    const folderInfo = await lstat(folder);
    if (!folderInfo.isDirectory() || folderInfo.isSymbolicLink()) return null;
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const real = await realpath(target);
    if (real !== target || !real.startsWith(root + sep)) return null;
    return { path: real };
  } catch {
    return null;
  }
}

async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = new Uint8Array(12);
    const { bytesRead } = await handle.read(buffer, 0, 12, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * Einzelner Bereich aus einem Range-Kopf. null: kein auswertbarer Kopf, also
 * die ganze Datei (auch bei mehreren Bereichen). "invalid": außerhalb der Datei.
 */
export function parseRange(header: string | null, size: number): { start: number; end: number } | "invalid" | null {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (!match[1] && !match[2])) return null;
  if (size === 0) return "invalid";
  if (!match[1]) {
    const suffix = Number(match[2]);
    return suffix === 0 ? "invalid" : { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start >= size || end < start ? "invalid" : { start, end };
}

/** Audio oder Video, mit Range; beantwortet auch einen ungültigen Bereich */
function mediaResponse(path: string, type: string, disposition: string, range: string | null): Response {
  const whole = Bun.file(path);
  const headers: Record<string, string> = {
    "Content-Type": type,
    "Content-Disposition": disposition,
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  };
  const part = parseRange(range, whole.size);
  if (part === "invalid") return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${whole.size}` } });
  if (!part) return new Response(whole, { headers });
  return new Response(whole.slice(part.start, part.end + 1), {
    status: 206,
    headers: { ...headers, "Content-Range": `bytes ${part.start}-${part.end}/${whole.size}` },
  });
}

/**
 * Antwort für eine gefundene Datei; null, wenn sie in der Ablage fehlt oder
 * nicht ausgeliefert werden darf (dann 404). displayName: Name für den
 * Download, wenn er vom Namen in der Ablage abweicht (Anhänge, Issue #72).
 * rich: Datei aus einer Meldung, Audio, Video und HTML dürfen inline.
 */
export async function serveOutboxFile(
  dir: string,
  file: NoticeFile,
  wantInline: boolean,
  displayName?: string,
  rich?: { range: string | null }
): Promise<Response | null> {
  const resolved = await resolveInside(dir, file);
  if (!resolved) return null;
  if (wantInline && rich) {
    const extension = extname(file.name).toLowerCase();
    const shownName = displayName ?? file.name;
    if (HTML_EXTENSIONS.has(extension) && file.mime === "text/html") {
      return new Response(Bun.file(resolved.path), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Content-Disposition": contentDisposition("inline", shownName),
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy": SANDBOXED_HTML_CSP,
        },
      });
    }
    const mediaType = MEDIA_TYPES[extension];
    if (mediaType && file.mime.split("/")[0] === mediaType.split("/")[0]) {
      try {
        if (magicMatches(mediaType, await readHead(resolved.path))) {
          return mediaResponse(resolved.path, mediaType, contentDisposition("inline", shownName), rich.range);
        }
      } catch {
        return null;
      }
    }
  }
  let inlineType: string | null = null;
  if (wantInline) {
    const byName = inlineImageType(file.name);
    if (byName && file.mime === byName) {
      try {
        if (magicMatches(byName, await readHead(resolved.path))) inlineType = byName;
      } catch {
        return null;
      }
    }
  }
  return new Response(Bun.file(resolved.path), {
    headers: {
      "Content-Type": inlineType ?? "application/octet-stream",
      "Content-Disposition": contentDisposition(inlineType ? "inline" : "attachment", displayName ?? file.name),
      "X-Content-Type-Options": "nosniff",
    },
  });
}
