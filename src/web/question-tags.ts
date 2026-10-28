/**
 * Rückfrage-Tags [FRAGE: Frage | Antwort ...] finden (Issue #336), geteilt
 * vom Chat-Kern (src/lib/turn-questions.ts: Erkennung) und der Anzeige
 * (markdown.ts: lesbar machen), damit beide dieselben Tags meinen. Ohne
 * Nebenwirkungen; liegt in src/web, weil der Web-Server zur Laufzeit nichts
 * außerhalb lädt, und importiert nur marked wie markdown.ts.
 *
 * Geschützt sind Code (Blöcke mit Zaun, eingerückte Blöcke, Inline-Code),
 * Zitate und Tags in Anführungszeichen: dort ist ein Tag nur erwähnt. Code
 * und Zitate bestimmt derselbe Markdown-Parser, der die Antwort im Browser
 * rendert; so gilt als geschützt, was dort als Code oder Zitat erscheint
 * (auch Inline-Code über mehrere Zeilen und Zitat-Fortsetzungen ohne ">").
 * Tabellen zählen ebenfalls als geschützt.
 */

import { Lexer, type Token } from "marked";

/** Höchstzahl der Antworten, wie ASK_OPTIONS_MAX in ask-choices.ts */
export const QUESTION_OPTIONS_MAX = 8;

const TAG = /\[FRAGE:([^\]\n]*)\]/gi;
const TAG_START = /\[FRAGE:/gi;
/**
 * Token-Arten, deren Inhalt nur erwähnt ist. Dazu Tabellen: die Striche
 * eines Tags teilen dort die Zellen, auch in Inline-Code.
 */
const PROTECTED_TYPES = new Set(["code", "codespan", "blockquote", "table"]);

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Stelle von raw im Text ab from, höchstens bis to. Der Parser rückt Inhalt
 * von Listenpunkten aus; über mehrere Zeilen passt raw dann nur mit
 * beliebigem Einzug (und ">") am Zeilenanfang.
 */
function locate(text: string, raw: string, from: number, to: number): { start: number; end: number } | null {
  if (raw === "") return null;
  const at = text.indexOf(raw, from);
  if (at >= 0 && at + raw.length <= to) return { start: at, end: at + raw.length };
  if (!raw.includes("\n")) return null;
  const pattern = raw
    .split("\n")
    .map((line, i) => escapeRegExp(i === 0 ? line : line.replace(/^[ \t]+/, "")))
    .join("\n[ \t>]*");
  const re = new RegExp(pattern, "g");
  re.lastIndex = from;
  const m = re.exec(text);
  return m && m.index + m[0].length <= to ? { start: m.index, end: m.index + m[0].length } : null;
}

/** Untergeordnete Tokens in der Reihenfolge des Quelltexts */
function children(token: Token): Token[] {
  const t = token as Token & { tokens?: Token[]; items?: Token[]; header?: { tokens: Token[] }[]; rows?: { tokens: Token[] }[][] };
  if (t.type === "table") return [...(t.header ?? []), ...(t.rows ?? []).flat()].flatMap(cell => cell.tokens);
  return t.items ?? t.tokens ?? [];
}

/**
 * Geschützte Stellen im Bereich [from, to) sammeln. Findet sich eine geschützte
 * Stelle nicht im Text wieder, gilt vorsichtshalber der ganze Bereich als
 * geschützt.
 */
function collect(text: string, tokens: Token[], from: number, to: number, out: [number, number][]): void {
  let cursor = from;
  for (const token of tokens) {
    const spot = locate(text, token.raw, cursor, to);
    if (PROTECTED_TYPES.has(token.type)) {
      if (!spot) {
        out.push([from, to]);
        return;
      }
      out.push([spot.start, spot.end]);
    } else {
      const inner = children(token);
      if (inner.length) collect(text, inner, spot?.start ?? cursor, spot?.end ?? to, out);
    }
    if (spot) cursor = spot.end;
  }
}

/**
 * Geschützte Stellen unkenntlich machen, Länge und Zeilen bleiben: Code
 * (Blöcke, eingerückt, inline), Zitate und Tabellen werden zu fill,
 * Leerzeilen darin bleiben leer.
 */
export function maskProtected(text: string, fill: string): string {
  // Der Parser liest \r\n und \r als Zeilenende; gleich lang ersetzen, damit die Stellen stimmen
  const source = text.replace(/\r\n?/g, m => (m.length === 2 ? " \n" : "\n"));
  const ranges: [number, number][] = [];
  collect(source, Lexer.lex(source, { gfm: true }), 0, source.length, ranges);
  if (ranges.length === 0) return text;
  ranges.sort((a, b) => a[0] - b[0]);
  let out = "";
  let from = 0;
  for (const [start, end] of ranges) {
    if (end <= from) continue;
    const begin = Math.max(start, from);
    out += text.slice(from, begin);
    out += text
      .slice(begin, end)
      .split("\n")
      .map(line => (line.trim() === "" ? line : fill.repeat(line.length)))
      .join("\n");
    from = end;
  }
  return out + text.slice(from);
}

/** Öffnende Anführungszeichen und die Zeichen, die sie schließen */
const QUOTE_PAIRS: Record<string, string> = { '"': '"', "„": "“”", "“": "”", "«": "»", "»": "«" };

/** true, wenn text[start, end) innerhalb einer Zeile in Anführungszeichen steht */
function quotedAt(text: string, start: number, end: number): boolean {
  const lineStart = text.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = text.indexOf("\n", end) < 0 ? text.length : text.indexOf("\n", end);
  let closers: string | null = null;
  for (const c of text.slice(lineStart, start)) {
    if (closers) {
      if (closers.includes(c)) closers = null;
    } else if (QUOTE_PAIRS[c]) {
      closers = QUOTE_PAIRS[c];
    }
  }
  const open = closers;
  return open !== null && [...text.slice(end, lineEnd)].some(c => open.includes(c));
}

export const sameAnswer = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

export interface ParsedTag {
  question: string;
  options: string[];
  valid: boolean;
}

function parseTag(inner: string): ParsedTag {
  const [head = "", ...rest] = inner.split("|").map(p => p.replace(/\s+/g, " ").trim());
  const options = rest.filter(Boolean);
  const valid =
    head !== "" &&
    rest.length > 0 &&
    options.length === rest.length &&
    options.length <= QUESTION_OPTIONS_MAX &&
    new Set(options.map(sameAnswer)).size === options.length;
  return { question: head, options, valid };
}

export interface TagSpot {
  start: number;
  end: number;
  tag: ParsedTag;
}

/**
 * Tags außerhalb der geschützten Stellen: vollständige (spots) und ob
 * daneben ein angefangener oder anders kaputter Tag steht (broken)
 */
export function findTags(reply: string): { spots: TagSpot[]; broken: boolean } {
  // Ohne Tag nichts zu parsen (die Anzeige ruft das für jede Nachricht auf)
  if (!/\[FRAGE:/i.test(reply)) return { spots: [], broken: false };
  const masked = maskProtected(reply, " ");
  const spots: TagSpot[] = [];
  const covered = new Set<number>();
  for (const m of masked.matchAll(TAG)) {
    const start = m.index!;
    const end = start + m[0].length;
    covered.add(start);
    if (quotedAt(masked, start, end)) continue;
    spots.push({ start, end, tag: parseTag(reply.slice(start + "[FRAGE:".length, end - 1)) });
  }
  const broken = [...masked.matchAll(TAG_START)].some(
    m => !covered.has(m.index!) && !quotedAt(masked, m.index!, m.index! + m[0].length)
  );
  return { spots, broken };
}

/** Vollständige Tags außerhalb von Code, Zitat und Anführungszeichen, für die Anzeige (src/web/markdown.ts) */
export function questionTagSpans(reply: string): { start: number; end: number; question: string; options: string[] }[] {
  return findTags(reply).spots.map(s => ({ start: s.start, end: s.end, question: s.tag.question, options: s.tag.options }));
}
