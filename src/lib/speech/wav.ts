/**
 * Kennzeichnung erzeugter WAV-Dateien (Issue #249): ein LIST/INFO-Block mit
 * dem Hinweis „KI-generiert (<Name>)" als Kommentar (ICMT) und dem Namen als
 * erzeugendes Programm (ISFT). Das ist die maschinenlesbare Kennzeichnung
 * nach Art. 50 Abs. 2 KI-Verordnung, soweit das Format sie erlaubt; Ogg und
 * MP3 der Anbieter bleiben unverändert.
 *
 * Geklonte Stimmen (Issue #253): derselbe Kommentar mit dem Zusatz
 * „geklonte Stimme“, beide Hinweise in einem ICMT-Feld. Eine Datei, die
 * schon einen anderen LIST/INFO-Block trägt (etwa nur den Grundhinweis),
 * bekommt genau einen neuen Block; wiederholtes Markieren ändert nichts.
 *
 * Rein, ohne Dateizugriff: Bytes hinein, Bytes heraus.
 */

import { BRAND } from "../../brand";

export const AI_GENERATED_NOTE = `KI-generiert (${BRAND.name})`;
/** Zusatz für Ausgaben einer geklonten Stimme (Issue #253) */
export const CLONED_VOICE_NOTE = "geklonte Stimme";
/** Kommentar einer geklonten Stimme: Grundhinweis und Zusatz in einem Feld */
export const AI_CLONED_NOTE = `${AI_GENERATED_NOTE}, ${CLONED_VOICE_NOTE}`;

function tag(b: Buffer, o: number): string {
  return o + 4 <= b.length ? b.toString("latin1", o, o + 4) : "";
}

function isWav(b: Buffer): boolean {
  return b.length >= 12 && tag(b, 0) === "RIFF" && tag(b, 8) === "WAVE";
}

/** Felder des LIST/INFO-Blocks einer WAV-Datei (ICMT, ISFT, ...); leer, wenn es keinen gibt */
export function readWavInfo(wav: Buffer): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isWav(wav)) return out;
  let pos = 12;
  while (pos + 8 <= wav.length) {
    const size = wav.readUInt32LE(pos + 4);
    const end = Math.min(pos + 8 + size, wav.length);
    if (tag(wav, pos) === "LIST" && tag(wav, pos + 8) === "INFO") {
      let at = pos + 12;
      while (at + 8 <= end) {
        const fieldSize = wav.readUInt32LE(at + 4);
        const fieldEnd = Math.min(at + 8 + fieldSize, end);
        out[tag(wav, at)] = wav.toString("latin1", at + 8, fieldEnd).replace(/\0+$/, "");
        at = at + 8 + fieldSize + (fieldSize & 1);
      }
    }
    pos = pos + 8 + size + (size & 1);
  }
  return out;
}

/** INFO-Feld: Kennung, Länge samt Null-Byte am Ende, auf gerade Länge aufgefüllt */
function infoField(id: string, text: string): Buffer {
  const value = Buffer.from(`${text}\0`, "latin1");
  const head = Buffer.alloc(8);
  head.write(id, 0, "latin1");
  head.writeUInt32LE(value.length, 4);
  return Buffer.concat([head, value, Buffer.alloc(value.length & 1)]);
}

/** LIST-Block mit Typ INFO? */
function isInfoList(b: Buffer, pos: number): boolean {
  return tag(b, pos) === "LIST" && tag(b, pos + 8) === "INFO";
}

/**
 * WAV mit dem Hinweis „KI-generiert (<Name>)" im LIST/INFO-Block, mit
 * cloned zusätzlich „geklonte Stimme" im selben Kommentar. Trägt die Datei
 * genau diesen Kommentar schon oder ist sie kein WAV, kommt sie unverändert
 * zurück. Vorhandene LIST/INFO-Blöcke fallen weg, damit es nur einen
 * Kommentar gibt. Eine offene Größe des data-Blocks (0xFFFFFFFF oder über das
 * Dateiende hinaus, wie beim Schreiben im Strom) wird dabei auf die echte
 * Länge gesetzt, sonst läse ein Abspieler den angehängten Block als Ton.
 */
export function tagWavAiGenerated(wav: Buffer, opts: { cloned?: boolean } = {}): Buffer {
  const note = opts.cloned ? AI_CLONED_NOTE : AI_GENERATED_NOTE;
  if (!isWav(wav) || readWavInfo(wav).ICMT === note) return wav;
  const body = Buffer.from(wav);
  const kept: Buffer[] = [body.subarray(0, 12)];
  let pos = 12;
  while (pos + 8 <= body.length) {
    let size = body.readUInt32LE(pos + 4);
    // Offene Größe: über das Ende hinaus, oder 0 beim data-Block, obwohl noch Bytes folgen
    if (pos + 8 + size > body.length || (size === 0 && tag(body, pos) === "data" && pos + 8 < body.length)) {
      size = body.length - (pos + 8);
      body.writeUInt32LE(size, pos + 4);
    }
    const end = Math.min(pos + 8 + size + (size & 1), body.length);
    if (!isInfoList(body, pos)) kept.push(body.subarray(pos, end), Buffer.alloc((end - pos) & 1));
    pos = pos + 8 + size + (size & 1);
  }
  const fields = Buffer.concat([infoField("ICMT", note), infoField("ISFT", BRAND.name)]);
  const head = Buffer.alloc(12);
  head.write("LIST", 0, "latin1");
  head.writeUInt32LE(4 + fields.length, 4);
  head.write("INFO", 8, "latin1");
  const out = Buffer.concat([...kept, head, fields]);
  out.writeUInt32LE(out.length - 8, 4);
  return out;
}

/**
 * Dauer einer PCM-WAV-Datei in Sekunden (Issue #252, für den Echtzeitfaktor
 * der Probe). Eine offene Größe des data-Blocks (Schreiben im Strom) zählt
 * bis zum Dateiende. null, wenn es kein lesbares WAV ist.
 */
export function wavDurationSeconds(wav: Buffer): number | null {
  if (!isWav(wav)) return null;
  let byteRate = 0;
  let pos = 12;
  while (pos + 8 <= wav.length) {
    const id = tag(wav, pos);
    const size = wav.readUInt32LE(pos + 4);
    if (id === "fmt " && pos + 20 <= wav.length) byteRate = wav.readUInt32LE(pos + 16);
    if (id === "data") {
      if (!byteRate) return null;
      const bytes = Math.min(size, wav.length - (pos + 8));
      return bytes / byteRate;
    }
    pos = pos + 8 + size + (size & 1);
  }
  return null;
}
