/**
 * Symbole der installierbaren WebUI (Issue #224): icon-192.png, icon-512.png
 * und icon-maskable-512.png in src/web/public, exakt aus der Geometrie von
 * favicon.svg gerechnet (helle Fassung: dunkles Quadrat, heller Ring, oranger
 * Punkt), wie apple-touch-icon.png.
 *
 * Ohne neue Abhängigkeit: Die drei Formen (abgerundetes Quadrat, Ring, Punkt)
 * sind einfache Flächen, deren Abdeckung sich je Pixel mit 8 x 8 Stichproben
 * ausrechnen lässt (Kantenglättung). Das PNG entsteht mit node:zlib und
 * einer eigenen CRC-32. Gleiche Eingaben ergeben dieselben Bytes; ein Test
 * vergleicht die Dateien im Repo mit einer frischen Berechnung.
 *
 * Aufruf: bun run scripts/web-icons.ts
 */

import { deflateSync } from "node:zlib";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Geometrie aus favicon.svg (viewBox 0 0 32 32), helle Fassung */
export const MARK = {
  view: 32,
  square: { radius: 9, color: "#1B1A17" },
  ring: { cx: 15, cy: 17, r: 7.5, width: 3, color: "#F3F0E8" },
  dot: { cx: 23.5, cy: 8.5, r: 3.6, color: "#EA5B1C" },
} as const;

/** Sichere Zone eines maskierbaren Symbols: Kreis mit 80 % Durchmesser */
export const MASKABLE_SAFE_DIAMETER = 0.8;

export type IconVariant = "any" | "maskable";

export interface IconFile {
  name: string;
  size: number;
  variant: IconVariant;
}

export const ICON_FILES: IconFile[] = [
  { name: "icon-192.png", size: 192, variant: "any" },
  { name: "icon-512.png", size: 512, variant: "any" },
  { name: "icon-maskable-512.png", size: 512, variant: "maskable" },
];

const SAMPLES = 8;

function rgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Punkt im abgerundeten Quadrat 0..view mit Eckradius r */
function inRoundedSquare(x: number, y: number, view: number, r: number): boolean {
  if (x < 0 || y < 0 || x > view || y > view) return false;
  const cx = Math.min(Math.max(x, r), view - r);
  const cy = Math.min(Math.max(y, r), view - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}

/**
 * Maskierbar: Ring und Punkt so um die Mitte verkleinert, dass ihr äußerster
 * Punkt genau auf dem Rand der sicheren Zone liegt; der Hintergrund füllt
 * randlos die ganze Fläche (die Maske des Systems schneidet ihn zu).
 */
export function maskableScale(): number {
  const c = MARK.view / 2;
  const ringFar = Math.hypot(MARK.ring.cx - c, MARK.ring.cy - c) + MARK.ring.r + MARK.ring.width / 2;
  const dotFar = Math.hypot(MARK.dot.cx - c, MARK.dot.cy - c) + MARK.dot.r;
  return (MASKABLE_SAFE_DIAMETER * c) / Math.max(ringFar, dotFar);
}

/** RGBA-Pixel (Zeile für Zeile) eines Symbols */
export function renderIconPixels(size: number, variant: IconVariant): Uint8Array {
  const { view, square, ring, dot } = MARK;
  const c = view / 2;
  const scale = variant === "maskable" ? maskableScale() : 1;
  const colors = { square: rgb(square.color), ring: rgb(ring.color), dot: rgb(dot.color) };
  const inner = ring.r - ring.width / 2;
  const outer = ring.r + ring.width / 2;
  const out = new Uint8Array(size * size * 4);
  const unit = view / size;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SAMPLES; sy++) {
        for (let sx = 0; sx < SAMPLES; sx++) {
          const x = (px + (sx + 0.5) / SAMPLES) * unit;
          const y = (py + (sy + 0.5) / SAMPLES) * unit;
          const background = variant === "maskable" || inRoundedSquare(x, y, view, square.radius);
          if (!background) continue;
          // Ring und Punkt im (bei maskierbar verkleinerten) Zeichen-Raum
          const mx = c + (x - c) / scale;
          const my = c + (y - c) / scale;
          let color = colors.square;
          const dr = Math.hypot(mx - ring.cx, my - ring.cy);
          if (dr >= inner && dr <= outer) color = colors.ring;
          if (Math.hypot(mx - dot.cx, my - dot.cy) <= dot.r) color = colors.dot;
          r += color[0];
          g += color[1];
          b += color[2];
          a++;
        }
      }
      const i = (py * size + px) * 4;
      if (a > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
      }
      out[i + 3] = Math.round((a / (SAMPLES * SAMPLES)) * 255);
    }
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.byteLength, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** PNG (RGBA, 8 Bit, ohne Zeilenfilter) aus Pixeln */
export function encodePng(size: number, pixels: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // Bits je Kanal
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    raw.set(pixels.subarray(y * size * 4, (y + 1) * size * 4), y * (size * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

export function renderIcon(file: IconFile): Buffer {
  return encodePng(file.size, renderIconPixels(file.size, file.variant));
}

export const PUBLIC_DIR = resolve(import.meta.dir, "..", "src", "web", "public");

if (import.meta.main) {
  for (const file of ICON_FILES) {
    await writeFile(join(PUBLIC_DIR, file.name), renderIcon(file));
    console.log(`${file.name} (${file.size} px, ${file.variant}) geschrieben`);
  }
}
