/**
 * Anhänge eigener Nachrichten im Web-Chat (Issue #72, Entscheidung 0012):
 * Typen, Anzeigename, Download-Adressen und die Prüfung gespeicherter Angaben.
 *
 * Reine Funktionen, nichts aus src/lib zur Laufzeit (der Web-Server lädt
 * diese Datei auch in web:dev und Tests). Die Ablage selbst steht in ./uploads.
 */

import type { MediaKind } from "./media-check";

/** Höchstens so viele Anhänge je Nachricht */
export const MAX_ATTACHMENTS = 5;
/** Anzeigename höchstens so lang (Unicode-Codepoints) */
export const ATTACHMENT_NAME_MAX_CHARS = 120;
/** Obergrenze einer Datei über alle Arten (Sprachdateien 25 MB, siehe MEDIA_LIMITS) */
export const MAX_ATTACHMENT_BYTES = 25 * 1_048_576;
/** Kopfzeile mit dem Dateinamen, UTF-8 prozentkodiert (encodeURIComponent) */
export const FILE_NAME_HEADER = "x-file-name";

/** Wie crypto.randomUUID() */
export const UPLOAD_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const KINDS: readonly MediaKind[] = ["image", "document", "audio"];
/** Nur Typen, die detectMedia liefern kann */
const MIMES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "application/pdf",
  "audio/ogg",
  "audio/mp4",
  "audio/webm",
  "audio/wav",
  "audio/mpeg",
]);
/** Bilder mit Vorschau (wie inlineImageType in ./files) */
const PREVIEW_MIMES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** Angaben zu einem Anhang, wie sie gespeichert und an den Turn gegeben werden */
export interface MessageAttachment {
  /** Upload-ID (UUID) */
  id: string;
  /** Anzeigename, nie Teil eines Pfads */
  name: string;
  size: number;
  /** Aus den ersten Bytes erkannt, nie aus Kopfzeile oder Name */
  mime: string;
  kind: MediaKind;
}

/** Anhang in API und Live-Ereignissen: dazu die Download-Adresse, bei Bildern die Vorschau */
export interface ApiAttachment extends MessageAttachment {
  url: string;
  previewUrl?: string;
}

export function isUploadId(value: unknown): value is string {
  return typeof value === "string" && UPLOAD_ID_PATTERN.test(value);
}

/** Standardname, wenn keiner mitkam oder nichts davon übrig bleibt */
export function defaultAttachmentName(kind: MediaKind, ext: string): string {
  const base = kind === "image" ? "bild" : kind === "document" ? "dokument" : "sprachdatei";
  return ext ? `${base}.${ext}` : base;
}

/**
 * Anzeigename aus der Kopfzeile: prozentkodiert (UTF-8). Ohne Pfadanteil,
 * Steuer- und Formatzeichen (auch Richtungswechsel), Leerraum
 * zusammengezogen, höchstens 120 Zeichen. undefined: keine Kopfzeile oder
 * nichts übrig, null: ungültige Kodierung.
 */
export function parseAttachmentName(header: string | null): string | undefined | null {
  if (header === null) return undefined;
  let decoded: string;
  try {
    decoded = decodeURIComponent(header);
  } catch {
    return null;
  }
  const base = decoded.split(/[\\/]/).pop() ?? "";
  const clean = base
    .normalize("NFC")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const chars = [...clean];
  const name = chars.length > ATTACHMENT_NAME_MAX_CHARS ? chars.slice(0, ATTACHMENT_NAME_MAX_CHARS).join("").trim() : clean;
  return name || undefined;
}

/** Download-Adresse eines Anhangs; mit inline die Bildvorschau */
export function attachmentUrl(conversationId: string, id: string, inline = false): string {
  return `/api/conversations/${encodeURIComponent(conversationId)}/attachments/${id}${inline ? "?inline=1" : ""}`;
}

/** Anhang mit Adressen für API und Live-Ereignisse */
export function toApiAttachment(conversationId: string, a: MessageAttachment): ApiAttachment {
  return {
    id: a.id,
    name: a.name,
    size: a.size,
    mime: a.mime,
    kind: a.kind,
    url: attachmentUrl(conversationId, a.id),
    ...(PREVIEW_MIMES.has(a.mime) ? { previewUrl: attachmentUrl(conversationId, a.id, true) } : {}),
  };
}

/** Geprüfter Anhang aus gespeicherten Angaben; null, wenn ein Feld fehlt oder nicht passt */
export function pickAttachment(value: unknown): MessageAttachment | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isUploadId(v.id)) return null;
  if (typeof v.name !== "string" || parseAttachmentName(encodeURIComponent(v.name)) !== v.name) return null;
  if (typeof v.size !== "number" || !Number.isSafeInteger(v.size) || v.size < 1 || v.size > MAX_ATTACHMENT_BYTES) return null;
  if (typeof v.mime !== "string" || !MIMES.has(v.mime)) return null;
  if (typeof v.kind !== "string" || !KINDS.includes(v.kind as MediaKind)) return null;
  return { id: v.id, name: v.name, size: v.size, mime: v.mime, kind: v.kind as MediaKind };
}

/**
 * Anhänge einer gespeicherten Nachricht (metadata.attachments) mit Adressen;
 * ungültige Einträge fallen einzeln weg, höchstens MAX_ATTACHMENTS. Leere
 * Liste, wenn keine da sind.
 */
export function pickApiAttachments(value: unknown, conversationId: string): ApiAttachment[] {
  if (!Array.isArray(value)) return [];
  const out: ApiAttachment[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const a = pickAttachment(item);
    if (!a || seen.has(a.id)) continue;
    seen.add(a.id);
    out.push(toApiAttachment(conversationId, a));
    if (out.length >= MAX_ATTACHMENTS) break;
  }
  return out;
}
