/**
 * Suchwörter für die Wissensbasis (Issue #317). Zerlegt einen Text in
 * Wörter aus Unicode-Buchstaben, kombinierenden Zeichen und Ziffern; alles
 * andere trennt. So bleibt „Größe“ ganz (früher wurde daraus „Gre“), auch
 * wenn das ö als o plus kombinierendes Trema ankommt: der Text wird vorher
 * nach NFC zusammengesetzt, wie ihn die Datenbank in der Regel speichert.
 *
 * Die Wörter enthalten damit nie Zeichen, die in PostgREST-Filtern (Komma,
 * Punkt, Klammern, Anführungszeichen) oder LIKE-Mustern (%, _) etwas
 * bedeuten. Ohne Wort gibt es keine Textsuche.
 */

const WORD = /[\p{L}\p{M}\p{N}]+/gu;
const MARK = /\p{M}/gu;

export interface TermOptions {
  /** So viele Zeichen braucht ein Wort mindestens (kombinierende nicht mitgezählt) */
  minLength: number;
  /** Höchstens so viele Wörter, in der Reihenfolge im Text */
  max: number;
}

/** Wörter in Textreihenfolge, ohne Wiederholung (Groß- und Kleinschreibung egal) */
export function knowledgeTerms(text: string, options: TermOptions): string[] {
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const [word] of text.normalize("NFC").matchAll(WORD)) {
    if (picked.length >= options.max) break;
    if ([...word.replace(MARK, "")].length < options.minLength) continue;
    const key = word.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(word);
  }
  return picked;
}

/** Enthält Titel oder Inhalt das Wort, oder gleicht ihm ein Schlagwort? Ohne Rücksicht auf Groß und klein */
export function mentions(entry: { title?: string; content?: string; tags?: string[] }, term: string): boolean {
  const wanted = term.normalize("NFC").toLocaleLowerCase();
  const inText = (value?: string) => typeof value === "string" && value.normalize("NFC").toLocaleLowerCase().includes(wanted);
  return inText(entry.title) || inText(entry.content) || (entry.tags ?? []).some(tag => String(tag).normalize("NFC").toLocaleLowerCase() === wanted);
}
