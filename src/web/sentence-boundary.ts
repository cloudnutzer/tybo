/**
 * Satzgrenze für die Sprachausgabe, eine Regel für zwei Wege (Issue #255):
 * splitSentences zerlegt eine fertige Antwort (Vorlese-Fassung, V2), der
 * Satz-Strom des Telefonhörers (src/lib/voice-brain/sentences.ts, V3) nutzt
 * nextSentenceEnd auf einem laufenden Strom. Liegt in src/web, weil der
 * Web-Server nichts außerhalb von src/web lädt.
 *
 * Satzende: ".", "!", "?" oder "…" (auch mit schließender Anführung oder
 * Klammer) plus Leerraum, oder ein Zeilenumbruch. Kein Satzende vor einem
 * Kleinbuchstaben und nach einem Punkt hinter einer Zahl („30. September"),
 * einem einzelnen Buchstaben („z. B.") oder einer Abkürzung („bzw.", „Dr.").
 */

/** Abkürzungen, nach deren Punkt kein Satz endet (klein, ohne Punkt) */
const ABBREVIATIONS = new Set([
  "dr", "prof", "hr", "fr", "nr", "str", "st", "tel", "abs", "art", "ca", "bzw", "ggf", "evtl", "vgl", "inkl", "exkl", "zzgl", "bspw", "sog", "usw",
  "etc", "mr", "mrs", "ms", "vs", "no", "approx", "mio", "mrd", "min", "max", "std", "sek",
]);

/** Steht vor diesem Punkt etwas, nach dem der Satz weitergeht (Zahl, einzelner Buchstabe, Abkürzung)? */
function isAbbreviation(word: string): boolean {
  const w = word.replace(/^[("'„“«]+/, "");
  if (/\d$/.test(w)) return true;
  if (/^\p{L}$/u.test(w)) return true;
  if (/^(?:\p{L}\.)+\p{L}$/u.test(w)) return true;
  return ABBREVIATIONS.has(w.toLowerCase());
}

const chars = (text: string) => [...text].length;

export interface SentenceEndOptions {
  /** Kürzere Sätze (ohne Leerraum gezählt) enden hier noch nicht, Standard 0 */
  minChars?: number;
  /**
   * false: der Text kann noch weitergehen. Eine Grenze direkt am Ende des
   * Texts zählt dann noch nicht, weil das nächste Zeichen (Kleinbuchstabe?)
   * noch fehlt. Standard true.
   */
  final?: boolean;
}

/**
 * Index hinter der ersten Satzgrenze (samt Leerraum) ab `from`, sonst -1.
 * Ein Zeilenumbruch im Leerraum ist immer eine Grenze.
 */
export function nextSentenceEnd(text: string, from = 0, { minChars = 0, final = true }: SentenceEndOptions = {}): number {
  const boundary = /([.!?…]+)["'”“»)\]]*(\s+)|\n/gu;
  boundary.lastIndex = from;
  for (let match = boundary.exec(text); match; match = boundary.exec(text)) {
    const end = match.index + match[0].length;
    const head = text.slice(from, end).trim();
    if (!head || chars(head) < minChars) continue;
    if (match[0].includes("\n")) return end;
    // Am Ende eines laufenden Stroms ist das nächste Zeichen noch unbekannt
    if (end >= text.length && !final) return -1;
    // Kleinbuchstabe danach: der Satz geht weiter
    if (/\p{Ll}/u.test(text[end] ?? "")) continue;
    if (match[1] === ".") {
      const word = /(\S+)$/.exec(text.slice(from, match.index))?.[1] ?? "";
      if (isAbbreviation(word)) continue;
    }
    return end;
  }
  return -1;
}

/** Sätze eines Klartexts; „z. B.", „3. Oktober" und „Dr. Müller" trennen nicht */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  for (let end = nextSentenceEnd(text, start); end >= 0; end = nextSentenceEnd(text, start)) {
    out.push(text.slice(start, end).trim());
    start = end;
  }
  const rest = text.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

