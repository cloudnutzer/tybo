/**
 * Bekannte Dateiendungen mit Art und MIME-Typ (Issue #318), eine Tabelle
 * für den Speicher-Adapter (Art und Typ beim Hochladen) und die
 * Bildbeschreibung (Bildtyp für das Vision-Modell). Ein MIME-Typ null heißt:
 * Art bekannt, Typ nicht festgelegt (dann gilt application/octet-stream).
 */

type Entry = readonly [extension: string, kind: "image" | "audio" | "document", mime: string | null];

const TABLE: readonly Entry[] = [
  ["jpg", "image", "image/jpeg"],
  ["jpeg", "image", "image/jpeg"],
  ["png", "image", "image/png"],
  ["gif", "image", "image/gif"],
  ["webp", "image", "image/webp"],
  ["bmp", "image", null],
  ["svg", "image", null],
  ["mp3", "audio", "audio/mpeg"],
  ["ogg", "audio", "audio/ogg"],
  ["oga", "audio", null],
  ["wav", "audio", "audio/wav"],
  ["m4a", "audio", null],
  ["pdf", "document", "application/pdf"],
];

const BY_EXTENSION = new Map(TABLE.map(entry => [entry[0], entry]));

/** Endung nach dem letzten Punkt, klein geschrieben; ohne Punkt leer */
export function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

/** Art zur Endung (image, audio); unbekannt und pdf: document */
export function kindForExtension(extension: string): string {
  const entry = BY_EXTENSION.get(extension);
  return entry && entry[1] !== "document" ? entry[1] : "document";
}

/** MIME-Typ zur Endung oder null */
export function mimeForExtension(extension: string): string | null {
  return BY_EXTENSION.get(extension)?.[2] ?? null;
}

/** Bildtypen, die das Vision-Modell annimmt */
const VISION_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Bildtyp für das Vision-Modell; alles andere gilt als JPEG */
export function visionMediaType(filename: string): string {
  const mime = mimeForExtension(extensionOf(filename));
  return mime && VISION_TYPES.has(mime) ? mime : "image/jpeg";
}
