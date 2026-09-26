/**
 * Oberflächen-Version der WebUI (Issue #111): Prüfsumme über die Dateien in
 * publicDir und die Markenangaben aus src/brand.ts (HTML-Platzhalter und
 * /brand.js). Gleiche Dateien ergeben dieselbe Version, auch nach einem
 * Neustart; jede geänderte, neue oder gelöschte Datei eine neue.
 *
 * Eingerechnet werden nur relative Pfade und Inhalte, keine Zeitstempel,
 * absoluten Pfade oder Rechte. Versteckte Einträge (Punkt am Anfang) und
 * symbolische Links bleiben draußen: serveFile() liefert versteckte nie aus,
 * und ein Link könnte auf etwas außerhalb von publicDir zeigen.
 *
 * Die Version verrät nichts außer der Prüfsumme. Der Server berechnet sie
 * einmal beim Start: Dateien, die eine Übernahme vor dem Neustart schon
 * ersetzt, zählen erst ab dem Neustart. Ein in dieser Lücke geladener Tab
 * sieht nach dem Neustart einmal den Hinweis, das Neuladen gleicht ihn an.
 */

import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BRAND } from "../brand";

export const UI_VERSION_PATH = "/api/version";
/** Platzhalter in index.html, ersetzt beim Ausliefern (./brand-asset) */
export const UI_VERSION_PLACEHOLDER = "{{ui.version}}";
/** Hex-Zeichen der Version; 64 Bit reichen, um Fassungen zu unterscheiden */
const VERSION_LENGTH = 16;

/** Relative Pfade (mit /) aller eingerechneten Dateien, sortiert */
async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    // lstat statt entry: Links nie folgen
    const info = await lstat(join(root, rel));
    if (info.isSymbolicLink()) continue;
    if (info.isDirectory()) out.push(...(await listFiles(root, rel)));
    else if (info.isFile()) out.push(rel);
  }
  return out;
}

/** Abschnitt mit Länge davor, damit keine zwei Eingaben dieselben Bytes ergeben */
function section(hash: ReturnType<typeof createHash>, label: string, data: Uint8Array | string): void {
  const bytes = typeof data === "string" ? Buffer.from(data, "utf8") : data;
  hash.update(`${label}\0${bytes.byteLength}\0`);
  hash.update(bytes);
}

export interface UiVersionOptions {
  /** Nur für Tests: andere Markenangaben */
  brand?: Record<string, string>;
}

export async function computeUiVersion(publicDir: string, options: UiVersionOptions = {}): Promise<string> {
  const hash = createHash("sha256");
  section(hash, "brand", JSON.stringify(options.brand ?? BRAND));
  const files = (await listFiles(publicDir)).sort();
  for (const rel of files) {
    section(hash, "path", rel);
    section(hash, "file", await readFile(join(publicDir, rel)));
  }
  return hash.digest("hex").slice(0, VERSION_LENGTH);
}

/** Nur Kleinbuchstaben-Hex der festen Länge; alles andere ist keine Version */
export function isUiVersion(value: unknown): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${VERSION_LENGTH}}$`).test(value);
}
