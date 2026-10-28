/**
 * Meldungen und Dateien in der WebUI (Entscheidung 0006, Issue #47).
 *
 * Nur-Anzeige-Einträge (metadata.display_only === true) aus src/lib/outbox.ts
 * erscheinen im Verlauf als Meldung mit Absender, Dateien als Karte mit
 * Download. Aus metadata wird nur übernommen, was hier geprüft ist; lokale
 * Pfade oder sonstige Felder gelangen nie in die API.
 *
 * Reine Funktionen, nichts aus src/lib (der Web-Server lädt diese Datei auch
 * in web:dev und Tests).
 */

export interface NoticeFile {
  /** Ablage-ID in data/outbox/<id>/ (UUID) */
  id: string;
  /** Bereinigter Dateiname wie in der Ablage */
  name: string;
  /** Größe in Bytes */
  size: number;
  /** MIME-Typ wie beim Festhalten ermittelt; nur Angabe, nie Grundlage für inline */
  mime: string;
}

export interface NoticeInfo {
  kind: "notice";
  /** Absender-Kennung, z. B. pipeline; fehlt, wenn sie ungültig war */
  source?: string;
  file?: NoticeFile;
}

/** Wie SOURCE_PATTERN in src/lib/outbox.ts */
export const NOTICE_SOURCE_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;
/** Wie OUTBOX_ID_PATTERN in src/lib/outbox.ts */
export const OUTBOX_FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Wie MAX_FILE_BYTES in src/lib/outbox.ts */
export const MAX_NOTICE_FILE_BYTES = 50 * 1024 * 1024;
const MAX_NAME_CHARS = 120;
const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/;

/**
 * Dateiname, wie ihn sanitizeFileName in src/lib/outbox.ts erzeugt: ohne
 * Pfadanteil, Steuerzeichen und führende Punkte, höchstens 120 Zeichen.
 * Alles andere gilt als manipuliert.
 */
export function isSafeFileName(name: unknown): name is string {
  if (typeof name !== "string" || !name || name.length > MAX_NAME_CHARS) return false;
  if (name !== name.normalize("NFC") || name !== name.trim()) return false;
  if (/^[.\s]/.test(name)) return false;
  return /^[\p{L}\p{N}._ ()+-]+$/u.test(name);
}

/** true nur bei metadata.display_only === true (JSON-Boolean), wie isDisplayOnly in src/lib/supabase.ts */
export function isDisplayOnlyMetadata(metadata: unknown): boolean {
  return !!metadata && typeof metadata === "object" && (metadata as Record<string, unknown>).display_only === true;
}

/** Geprüfte Dateiangaben; null, wenn ein Feld fehlt oder nicht passt */
export function pickNoticeFile(value: unknown): NoticeFile | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== "string" || !OUTBOX_FILE_ID_PATTERN.test(v.id)) return null;
  if (!isSafeFileName(v.name)) return null;
  if (typeof v.size !== "number" || !Number.isSafeInteger(v.size) || v.size < 1 || v.size > MAX_NOTICE_FILE_BYTES) return null;
  const mime = typeof v.mime === "string" && MIME_PATTERN.test(v.mime.toLowerCase()) ? v.mime.toLowerCase() : "application/octet-stream";
  return { id: v.id, name: v.name, size: v.size, mime };
}

/**
 * Meldungs-Angaben eines gespeicherten Eintrags; null, wenn er kein
 * Nur-Anzeige-Eintrag ist. Ungültige source bzw. file fallen einzeln weg,
 * die Meldung bleibt.
 */
export function pickNotice(metadata: unknown): NoticeInfo | null {
  if (!isDisplayOnlyMetadata(metadata)) return null;
  const m = metadata as Record<string, unknown>;
  const info: NoticeInfo = { kind: "notice" };
  if (typeof m.source === "string" && NOTICE_SOURCE_PATTERN.test(m.source)) info.source = m.source;
  const file = pickNoticeFile(m.file);
  if (file) info.file = file;
  return info;
}
