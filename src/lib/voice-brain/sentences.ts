/**
 * Satz-Strom des Telefonhörers (Issue #255): gibt aus einem laufenden
 * Modell-Strom vollständige, sprechbare Abschnitte heraus, sobald sie fertig
 * sind. Die Satzgrenze teilt er sich mit der Vorlese-Fassung aus V2
 * (src/web/sentence-boundary.ts, eine Funktion für beide).
 */

import { nextSentenceEnd } from "../../web/sentence-boundary";
import { TagFilter } from "./tags";

export { nextSentenceEnd, splitSentences, type SentenceEndOptions } from "../../web/sentence-boundary";

const chars = (text: string) => [...text].length;

/** Index hinter dem ersten Komma, Doppelpunkt oder Semikolon nach mindestens minChars Zeichen, sonst -1 */
function nextClauseEnd(text: string, minChars: number, final: boolean): number {
  const clause = /[,;:](\s+)/g;
  for (let match = clause.exec(text); match; match = clause.exec(text)) {
    const end = match.index + match[0].length;
    if (chars(text.slice(0, match.index + 1).trim()) < minChars) continue;
    // Aufzählung von Zahlen („1, 2, 3") nicht zerreißen
    if (/\d$/.test(text.slice(0, match.index))) {
      if (end >= text.length && !final) return -1;
      if (/^\d/.test(text.slice(end))) continue;
    }
    return end;
  }
  return -1;
}

/** Teilt an der letzten Wortgrenze vor max Zeichen; ohne Wortgrenze hart */
function splitAtWords(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (chars(rest) > max) {
    const head = [...rest].slice(0, max).join("");
    const space = head.lastIndexOf(" ");
    const cut = space > 0 ? space : head.length;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

const normalize = (text: string) => text.replace(/\s+/g, " ").replace(/ ([.,!?;:…])/g, "$1").trim();

export interface SentenceStreamOptions {
  /** Mindestlänge eines Abschnitts, Standard 12 Zeichen */
  minChars?: number;
  /** Der erste Abschnitt darf schon an Komma, Doppelpunkt oder Semikolon enden, Standard aus */
  earlyFirst?: boolean;
  /** Mindestlänge dieses frühen ersten Abschnitts, Standard 25 Zeichen */
  earlyMinChars?: number;
  /** Längere Abschnitte werden an der letzten Wortgrenze geteilt, Standard 240 Zeichen */
  maxChars?: number;
  /** Weitere Tags, die nie in einem Abschnitt erscheinen (Werkzeug-Tags, Issue #259) */
  extraTags?: string[];
}

/**
 * Nimmt Textstücke eines Modell-Stroms an und gibt vollständige, sprechbare
 * Abschnitte zurück. Intent-Tags ([REMEMBER: ...] usw.) fallen vorher weg,
 * mit dem strengen Tag-Filter: ein angefangenes Tag erscheint nie in einem
 * Abschnitt. flush() liefert am Ende den Rest.
 */
export class SentenceStream {
  private readonly filter: TagFilter;
  private readonly minChars: number;
  private readonly earlyFirst: boolean;
  private readonly earlyMinChars: number;
  private readonly maxChars: number;
  private buf = "";
  private count = 0;

  constructor(options: SentenceStreamOptions = {}) {
    this.filter = new TagFilter({ strict: true, extraTags: options.extraTags });
    this.minChars = options.minChars ?? 12;
    this.earlyFirst = options.earlyFirst ?? false;
    this.earlyMinChars = options.earlyMinChars ?? 25;
    this.maxChars = options.maxChars ?? 240;
  }

  push(chunk: string): string[] {
    this.buf += this.filter.push(chunk);
    return this.drain(false);
  }

  flush(): string[] {
    this.buf += this.filter.flush();
    return this.drain(true);
  }

  private drain(final: boolean): string[] {
    const out: string[] = [];
    const emit = (piece: string) => {
      const text = normalize(piece);
      if (!text) return;
      for (const part of splitAtWords(text, this.maxChars)) {
        out.push(part);
        this.count++;
      }
    };
    while (this.buf) {
      let end = nextSentenceEnd(this.buf, 0, { minChars: this.minChars, final });
      if (this.earlyFirst && this.count === 0) {
        const clause = nextClauseEnd(this.buf, this.earlyMinChars, final);
        if (clause >= 0 && (end < 0 || clause < end)) end = clause;
      }
      if (end < 0) {
        if (chars(this.buf.trim()) <= this.maxChars) break;
        const head = [...this.buf.trimStart()].slice(0, this.maxChars).join("");
        const lead = this.buf.length - this.buf.trimStart().length;
        const space = head.search(/\s\S*$/);
        end = lead + (space > 0 ? space + 1 : head.length);
      }
      emit(this.buf.slice(0, end));
      this.buf = this.buf.slice(end);
    }
    if (final) {
      emit(this.buf);
      this.buf = "";
    }
    return out;
  }
}
