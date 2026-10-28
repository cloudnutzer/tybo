/**
 * Rückfragen in einer Antwort des Modells erkennen (Issue #336).
 *
 * Vorrang hat der Tag, den das Modell laut Prompt setzt:
 * [FRAGE: Frage | Antwort 1 | Antwort 2 ...] mit 1 bis 8 Antworten. Genau ein
 * gültiger Tag ergibt eine Rückfrage. Ein ungültiger Tag (keine Frage, keine
 * oder leere Antworten, doppelte Antworten, mehr als acht), ein angefangener
 * Tag ohne Schlussklammer auf derselben Zeile oder mehrere Tags ergeben keine;
 * dann wird auch nicht über Marker geraten, das Modell wollte erkennbar etwas
 * anderes.
 *
 * Geschützt sind Code (Blöcke mit Zaun, eingerückte Blöcke, Inline-Code),
 * Zitate, Tabellen und Tags in Anführungszeichen: dort ist ein Tag nur
 * erwähnt, zählt nie und bleibt stehen, wie er geschrieben ist. Code, Zitate
 * und Tabellen bestimmt der Markdown-Parser der Anzeige.
 *
 * Ohne Tag gilt der Rückfall über Marker, bewusst eng gefasst, damit
 * rhetorische Fragen und Floskeln keine Knöpfe bekommen:
 * - Nur die letzte Zeile zählt, und nur, wenn sie mit „?" endet. Code
 *   (Blöcke, eingerückt und inline), Zitate und Tabellen zählen nie als Frage,
 *   Sätze mit Anführungszeichen auch nicht.
 * - Ihr letzter Satz beginnt (auch nach einem Nebensatz mit Komma) mit einem
 *   Marker: Ja-Nein-Fragen wie „Soll ich", „Möchtest du", „Should I",
 *   „Would you like me to"; Auswahlfragen wie „Welche", „Which".
 * - Ja-Nein-Fragen bekommen „Ja"/„Nein" bzw. „Yes"/„No". Steht ein „oder"
 *   darin, braucht es wie bei Auswahlfragen eine nummerierte Liste (2 bis 8
 *   Punkte, ab 1 fortlaufend) direkt davor; deren Punkte sind dann die
 *   Antworten. Ohne Liste keine Rückfrage.
 * - Floskeln zum Schluss („sonst noch", „anything else") sind keine Rückfrage.
 *
 * Die Antwort selbst bleibt lesbar: jeder vollständige Tag außerhalb der
 * geschützten Stellen wird zu Frage und Antwortliste als Text, gültig oder
 * nicht. So geht nichts verloren, wenn die Knöpfe nicht ankommen; der Nutzer
 * kann auch tippen. Das Finden der Tags teilt sich der Kern mit der Anzeige
 * (src/web/question-tags.ts).
 */

import { QUESTION_OPTIONS_MAX, findTags, maskProtected, sameAnswer, type ParsedTag, type TagSpot } from "../web/question-tags";

export { QUESTION_OPTIONS_MAX };

/** Anweisung im Prompt (prompt-builder.ts) */
export const QUESTION_TAG_SECTION = `## QUESTIONS WITH BUTTONS
If you cannot continue without a decision from the user, end your response with exactly one tag:
[FRAGE: question | answer 1 | answer 2]
Give 1 to 8 short answers in the user's language. The user gets one button per answer plus a cancel button; the chosen answer comes back to you as the next message.
Use it only for real decisions you wait for, never for rhetorical questions or closing pleasantries. At most one FRAGE tag per response; no "|" or "]" inside the question or the answers.`;

export interface FoundQuestion {
  question: string;
  options: string[];
  via: "tag" | "marker";
}

export interface QuestionScan {
  /** Antwort mit lesbar gemachten Tags */
  text: string;
  /** Erkannte Rückfrage; null, wenn keine entstehen darf */
  found: FoundQuestion | null;
}

/** Füllzeichen für geschützte Stellen beim Marker-Rückfall: zählt als Inhalt, ist aber nie eine Frage */
const CODE_FILL = "\u0001";

/** Frage und Antworten als Markdown-Text */
function readable(tag: ParsedTag): string {
  return [tag.question, ...tag.options.map(o => `- ${o}`)].filter(Boolean).join("\n");
}

/** Tags außerhalb der geschützten Stellen durch lesbaren Text ersetzen, jeweils als eigener Absatz */
function renderTags(text: string, spots: TagSpot[]): string {
  let out = "";
  let from = 0;
  for (const spot of spots) {
    const before = text.slice(from, spot.start).replace(/[ \t]+$/, "");
    const block = readable(spot.tag);
    out += before;
    if (block) {
      if (out !== "" && !out.endsWith("\n\n")) out += out.endsWith("\n") ? "\n" : "\n\n";
      out += block;
    }
    from = spot.end;
    const after = text.slice(from).replace(/^[ \t]+/, "");
    from = text.length - after.length;
    if (block && after !== "" && !after.startsWith("\n\n")) out += after.startsWith("\n") ? "\n" : "\n\n";
  }
  return out + text.slice(from);
}

// ---------------------------------------------------------------------------
// Rückfall über Marker
// ---------------------------------------------------------------------------

const YES_NO_DE = ["soll ich", "sollen wir", "möchtest du", "möchten sie", "willst du", "wollen sie", "wollen wir", "magst du", "darf ich"];
const YES_NO_EN = [
  "should i",
  "shall i",
  "should we",
  "shall we",
  "would you like me to",
  "do you want me to",
  "want me to",
  "may i",
  "can i go ahead",
  "can i proceed",
];
const CHOICE_MARKERS = ["welche", "welcher", "welches", "welchen", "was davon", "which"];
const PLEASANTRIES = ["sonst noch", "noch etwas", "noch was", "weitere fragen", "anything else", "something else", "else i can"];
const QUOTES = /["„“”«»]/;
const EITHER_OR = /(^|[^\p{L}])(oder|or)([^\p{L}]|$)/iu;
const LIST_ITEM = /^\s*(\d{1,2})[.)]\s+(.+)$/;

const unemphasize = (s: string) => s.replace(/^(?:\*{1,3}|_{1,3})+/, "").replace(/(?:\*{1,3}|_{1,3})+$/, "").trim();

/** Marker am Anfang von text, nur als ganzes Wort */
function startsWithMarker(text: string, markers: string[]): boolean {
  return markers.some(m => text.startsWith(m) && !/\p{L}/u.test(text.charAt(m.length)));
}

/** Satz und die Stücke nach jedem Komma: dort darf der Marker stehen */
function clauses(sentence: string): string[] {
  const lower = sentence.toLowerCase();
  const parts = [lower];
  let at = lower.indexOf(", ");
  while (at >= 0) {
    parts.push(lower.slice(at + 2));
    at = lower.indexOf(", ", at + 2);
  }
  return parts;
}

/**
 * Text eines Listenpunkts aus dem Original. Die maskierte Fassung ist gleich
 * lang und zeigt, wo Code steht: Fett-Zeichen fallen nur außerhalb davon weg,
 * Inline-Code bleibt, wie er geschrieben ist.
 */
function itemText(masked: string, original: string): string {
  let out = "";
  let from = 0;
  for (const m of masked.matchAll(/\*\*|__/g)) {
    out += original.slice(from, m.index);
    from = m.index! + m[0].length;
  }
  return out + original.slice(from);
}

/**
 * Nummerierte Liste (ab 1 fortlaufend) direkt vor Zeile index, Leerzeilen
 * dazwischen erlaubt. Die Struktur kommt aus den maskierten Zeilen, die
 * Antworten aus den gleich langen Originalzeilen.
 */
function listBefore(lines: string[], originals: string[], index: number): string[] {
  let i = index - 1;
  while (i >= 0 && lines[i].trim() === "") i--;
  const items: { n: number; text: string }[] = [];
  for (; i >= 0; i--) {
    const m = LIST_ITEM.exec(lines[i]);
    if (!m) break;
    const at = lines[i].length - m[2].length;
    items.unshift({ n: Number(m[1]), text: itemText(m[2], originals[i].slice(at)) });
  }
  if (items.some((item, k) => item.n !== k + 1)) return [];
  return items.map(item => unemphasize(item.text).replace(/:$/, "").trim());
}

function markerQuestion(text: string): FoundQuestion | null {
  const lines = maskProtected(text, CODE_FILL).split("\n");
  const originals = text.split("\n");
  let last = lines.length - 1;
  while (last >= 0 && lines[last].trim() === "") last--;
  if (last < 0) return null;
  const line = lines[last].trim();
  if (line.includes(CODE_FILL)) return null;
  const clean = unemphasize(line);
  if (!clean.endsWith("?")) return null;

  const body = clean.slice(0, -1);
  const cut = Math.max(body.lastIndexOf(". "), body.lastIndexOf("! "), body.lastIndexOf("? "));
  const sentence = `${(cut >= 0 ? body.slice(cut + 2) : body).trim()}?`;
  if (sentence.length < 4 || QUOTES.test(sentence)) return null;
  const lower = sentence.toLowerCase();
  if (PLEASANTRIES.some(p => lower.includes(p))) return null;

  const parts = clauses(sentence);
  const german = parts.some(p => startsWithMarker(p, YES_NO_DE));
  const yesNo = german || parts.some(p => startsWithMarker(p, YES_NO_EN));
  const choice = startsWithMarker(lower, CHOICE_MARKERS);
  if (!yesNo && !choice) return null;

  const list = listBefore(lines, originals, last);
  // Sicherheitsnetz: ein Maskierungszeichen wird nie eine Antwort
  const usable =
    list.length >= 2 &&
    list.length <= QUESTION_OPTIONS_MAX &&
    list.every(o => o !== "" && !o.includes(CODE_FILL)) &&
    new Set(list.map(sameAnswer)).size === list.length;
  if (choice || EITHER_OR.test(sentence)) {
    return usable ? { question: sentence, options: list, via: "marker" } : null;
  }
  return { question: sentence, options: german ? ["Ja", "Nein"] : ["Yes", "No"], via: "marker" };
}

/** Rückfrage suchen und die Antwort lesbar machen */
export function scanForQuestion(reply: string): QuestionScan {
  const { spots, broken } = findTags(reply);
  if (spots.length === 0 && !broken) return { text: reply, found: markerQuestion(reply) };
  const text = renderTags(reply, spots);
  const only = !broken && spots.length === 1 && spots[0].tag.valid ? spots[0].tag : null;
  return { text, found: only ? { question: only.question, options: only.options, via: "tag" } : null };
}

/** Nur die lesbare Fassung, ohne Erkennung (Antworten ohne Rückfrage, etwa vom Ersatzmodell) */
export function renderQuestionTags(reply: string): string {
  return scanForQuestion(reply).text;
}
