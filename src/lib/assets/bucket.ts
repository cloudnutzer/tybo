/**
 * Speicherordner (Supabase Storage) für Bilder und Dateien, Issue #141 und
 * #318. Der Name kommt aus SUPABASE_ASSETS_BUCKET; fehlt er oder besteht er
 * nur aus Leerraum, gilt tybo-assets. Der Ordner ist privat: Links darauf
 * sind immer signiert und laufen nach LINK_LIFETIME_SECONDS ab.
 */

export const DEFAULT_ASSETS_BUCKET = "tybo-assets";

/** So lange (Sekunden) gilt ein signierter Link auf eine gespeicherte Datei */
export const LINK_LIFETIME_SECONDS = 900;

export function assetsBucket(env: Record<string, string | undefined> = process.env): string {
  const named = (env.SUPABASE_ASSETS_BUCKET ?? "").trim();
  return named === "" ? DEFAULT_ASSETS_BUCKET : named;
}
