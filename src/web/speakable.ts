/**
 * Vorlesbare Fassung einer Antwort (Issue #249): Klartext aus dem Markdown,
 * für die Sprachausgabe im Sprechmodus. Die angezeigte Antwort (text, html)
 * bleibt unverändert; diese Fassung gibt es nur zum Vorlesen.
 *
 * - Steuer-Tags ([REMEMBER:] usw.) fallen zuerst weg (stripControlTags)
 * - Überschriften und Listenpunkte werden zu Sätzen
 * - Codeblöcke werden durch „Den Code findest du im Chat." ersetzt, Tabellen
 *   durch „Die Tabelle findest du im Chat."
 * - Links nur mit ihrem Text; eine nackte Adresse nur mit dem Namen der Seite
 * - Emojis, Hervorhebungen, Backticks und rohes HTML fallen weg
 * - höchstens 2.000 Zeichen samt dem Schlusssatz „Der Rest steht im Chat.",
 *   gekürzt wird an Satzgrenzen
 *
 * speakSegments sind die Sätze dieser Fassung, damit die Ausgabe früh
 * beginnt: jedes Segment höchstens 600 Zeichen (die Grenze von POST
 * /api/speech/tts), sehr kurze Sätze mit dem nächsten verbunden. Mit einem
 * Leerzeichen verbunden ergeben die Segmente speakable.
 */

import { Marked, type Token, type Tokens } from "marked";
import { stripControlTags } from "./markdown";
import { MAX_TTS_CHARS } from "./speech";
import { splitSentences } from "./sentence-boundary";

export const SPEAKABLE_MAX_CHARS = 2000;
export const SPEAK_SEGMENT_MAX_CHARS = MAX_TTS_CHARS;
/** Kürzere Sätze werden mit dem nächsten zu einem Segment verbunden */
export const SPEAK_SEGMENT_MIN_CHARS = 40;
export const SPEAKABLE_CODE_NOTE = "Den Code findest du im Chat.";
export const SPEAKABLE_TABLE_NOTE = "Die Tabelle findest du im Chat.";
export const SPEAKABLE_REST_NOTE = "Der Rest steht im Chat.";

const lexer = new Marked({ gfm: true });

/** Emojis samt Verbindern, Varianten, Hauttönen, Flaggen und Tasten-Umrandung */
const EMOJI = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u{FE0F}\u{200D}\u{20E3}\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/gu;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_m, name: string) => (name === "#39" ? "'" : ENTITIES[name]));
}

/** Name der Seite für eine nackte Adresse (ohne www.); ohne gültige Adresse nichts */
function hostOf(href: string): string {
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(href) ? href : `https://${href}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return "";
  }
}

const looksLikeUrl = (text: string) => /^(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+$/i.test(text.trim());

function inline(tokens: Token[] | undefined): string {
  let out = "";
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "text": {
        const text = t as Tokens.Text;
        out += text.tokens?.length ? inline(text.tokens) : decodeEntities(text.text);
        break;
      }
      case "escape":
      case "codespan":
        out += (t as Tokens.Escape | Tokens.Codespan).text;
        break;
      case "strong":
      case "em":
      case "del":
        out += inline((t as Tokens.Strong).tokens);
        break;
      case "link": {
        const link = t as Tokens.Link;
        const label = inline(link.tokens).trim();
        // Eine Adresse vorzulesen hilft niemandem: nur der Name der Seite
        out += !label || looksLikeUrl(label) ? hostOf(link.href) : label;
        break;
      }
      case "image":
        out += (t as Tokens.Image).text;
        break;
      case "br":
        out += " ";
        break;
      // html, checkbox und alles Unbekannte: nichts zum Vorlesen
    }
  }
  return out;
}

/** Leerraum glätten, Emojis und übrig gebliebene Markdown-Zeichen entfernen */
function clean(text: string): string {
  return text
    .replace(EMOJI, "")
    .replace(/[`|]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

/** Satz mit Schlusszeichen; leer bleibt leer */
function sentence(text: string): string {
  const t = clean(text).replace(/[,;]$/, "");
  if (!t) return "";
  return /[.!?:…]["'”“»)\]]*$/.test(t) ? t : `${t}.`;
}

/** Stücke in Lesereihenfolge; Überschriften und Listenpunkte als Sätze */
function blocks(tokens: Token[] | undefined): string[] {
  const out: string[] = [];
  const push = (piece: string) => {
    // Mehrere Code- oder Tabellenblöcke hintereinander: der Hinweis nur einmal
    if (piece && out[out.length - 1] !== piece) out.push(piece);
  };
  for (const t of tokens ?? []) {
    switch (t.type) {
      case "heading":
        push(sentence(inline((t as Tokens.Heading).tokens)));
        break;
      case "paragraph":
        push(clean(inline((t as Tokens.Paragraph).tokens)));
        break;
      case "text": {
        const text = t as Tokens.Text;
        push(clean(text.tokens?.length ? inline(text.tokens) : decodeEntities(text.text)));
        break;
      }
      case "list":
        for (const item of (t as Tokens.List).items) push(sentence(blocks(item.tokens).join(" ")));
        break;
      case "blockquote":
        for (const piece of blocks((t as Tokens.Blockquote).tokens)) push(piece);
        break;
      case "code":
        push(SPEAKABLE_CODE_NOTE);
        break;
      case "table":
        push(SPEAKABLE_TABLE_NOTE);
        break;
      // space, hr, html, def: nichts zum Vorlesen
    }
  }
  return out;
}

// Satzgrenze: dieselbe Regel wie der Satz-Strom des Telefonhörers (Issue #255, sentence-boundary.ts)
export { splitSentences };

/** Teilt einen zu langen Satz an Komma, Semikolon, Doppelpunkt oder zur Not an einem Leerzeichen */
function splitLong(segment: string, max: number): string[] {
  const out: string[] = [];
  let rest = segment;
  while ([...rest].length > max) {
    const head = [...rest].slice(0, max).join("");
    const soft = Math.max(head.lastIndexOf(", "), head.lastIndexOf("; "), head.lastIndexOf(": "));
    const space = head.lastIndexOf(" ");
    // Nicht zu früh trennen: ein Satzzeichen zählt nur in der hinteren Hälfte
    const cut = soft >= head.length / 2 ? soft + 1 : space > 0 ? space : head.length;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

export interface Speakable {
  speakable: string;
  speakSegments: string[];
}

const chars = (text: string) => [...text].length;

/**
 * Kurze Sätze („Ja.", Überschriften, Listenpunkte) wandern zum nächsten
 * Segment, bis es mindestens SPEAK_SEGMENT_MIN_CHARS hat: sonst bräuchte
 * eine Liste je Punkt einen eigenen Aufruf der Sprachausgabe. Ein kurzer
 * Rest am Ende hängt am Segment davor.
 */
function mergeShort(sentences: string[]): string[] {
  const out: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (current && chars(current) < SPEAK_SEGMENT_MIN_CHARS && chars(current) + 1 + chars(s) <= SPEAK_SEGMENT_MAX_CHARS) current += ` ${s}`;
    else {
      if (current) out.push(current);
      current = s;
    }
  }
  if (!current) return out;
  const last = out[out.length - 1];
  if (last !== undefined && chars(current) < SPEAK_SEGMENT_MIN_CHARS && chars(last) + 1 + chars(current) <= SPEAK_SEGMENT_MAX_CHARS) {
    out[out.length - 1] = `${last} ${current}`;
  } else out.push(current);
  return out;
}

/** Vorlesbare Fassung einer Antwort in Markdown; leer, wenn nichts zum Vorlesen bleibt */
export function toSpeakable(markdown: string): Speakable {
  // Überschriften und Listenpunkte sind schon eigene Stücke; innerhalb eines Stücks trennen die Satzzeichen
  const pieces = blocks(lexer.lexer(stripControlTags(markdown)));
  const all = pieces.flatMap(splitSentences).flatMap(s => splitLong(s, SPEAK_SEGMENT_MAX_CHARS));
  const total = all.reduce((n, s) => n + chars(s), 0) + Math.max(0, all.length - 1);
  let kept = all;
  if (total > SPEAKABLE_MAX_CHARS) {
    // Platz für den Schlusssatz samt Leerzeichen freihalten, gekürzt wird an einer Satzgrenze
    const budget = SPEAKABLE_MAX_CHARS - chars(SPEAKABLE_REST_NOTE) - 1;
    kept = [];
    let length = 0;
    for (const s of all) {
      const added = chars(s) + (kept.length ? 1 : 0);
      if (length + added > budget) break;
      kept.push(s);
      length += added;
    }
    kept.push(SPEAKABLE_REST_NOTE);
  }
  const speakSegments = mergeShort(kept);
  return { speakable: speakSegments.join(" "), speakSegments };
}
