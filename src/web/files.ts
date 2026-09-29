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
 *   ersten Bytes passen zusammen) inline als Bild. HTML, SVG und alles andere
 *   kommen nie inline, sondern als application/octet-stream zum Speichern.
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
 * Antwort für eine gefundene Datei; null, wenn sie in der Ablage fehlt oder
 * nicht ausgeliefert werden darf (dann 404). displayName: Name für den
 * Download, wenn er vom Namen in der Ablage abweicht (Anhänge, Issue #72).
 */
export async function serveOutboxFile(dir: string, file: NoticeFile, wantInline: boolean, displayName?: string): Promise<Response | null> {
  const resolved = await resolveInside(dir, file);
  if (!resolved) return null;
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
