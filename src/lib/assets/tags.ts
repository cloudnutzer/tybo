/**
 * Der Steuer-Tag [ASSET_DESC: Beschreibung | schlagwort, schlagwort] (Issue
 * #318). Claude hängt ihn an die Antwort auf ein Bild (Anweisung in
 * src/lib/prompt-builder.ts); die Kanäle tragen daraus die Beschreibung nach
 * und entfernen ihn, bevor die Antwort den Nutzer erreicht. Der Tag-Name ist
 * Schnittstelle und bleibt.
 */

const OPENER = "[ASSET_DESC:";
/** Alle Tags samt Leerraum davor und danach, zum Entfernen */
const EVERY_TAG = /\s*\[ASSET_DESC:[^\]]+\]\s*/g;

export interface AssetDescription {
  description: string;
  tags: string[];
}

/**
 * Inhalt des ersten Tags: Text bis zum ersten senkrechten Strich als
 * Beschreibung, danach kommagetrennte Schlagwörter. Ohne Tag null.
 */
export function parseAssetDescTag(response: string): AssetDescription | null {
  const start = response.indexOf(OPENER);
  if (start < 0) return null;
  const end = response.indexOf("]", start + OPENER.length);
  if (end < 0) return null;
  const inner = response.slice(start + OPENER.length, end);
  if (inner.length === 0) return null;
  const bar = inner.indexOf("|");
  const description = (bar < 0 ? inner : inner.slice(0, bar)).trim();
  const tagText = bar < 0 ? "" : inner.slice(bar + 1);
  const tags = tagText
    .split(",")
    .map(tag => tag.trim())
    .filter(tag => tag !== "");
  return { description, tags };
}

/**
 * Antwort ohne alle [ASSET_DESC]-Tags, außen ohne Leerraum. Der Leerraum um
 * einen Tag fällt mit weg (die WebUI hat dafür eine eigene, wortschonende
 * Fassung in src/web/markdown.ts).
 */
export const stripAssetDescTag = (response: string): string => response.replace(EVERY_TAG, "").trim();
