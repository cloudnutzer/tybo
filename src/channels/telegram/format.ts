/**
 * Telegram-Formatierer (Issue #327): Markdown aus Modellantworten wird
 * Telegram-HTML. Die Einzelumwandlung (toTelegramHtml) erkennt die
 * Markdown-Blöcke: Codeblöcke werden pre, Zitate blockquote, Tabellen als
 * Ganzes Listen, Absätze bleiben durch Leerzeilen getrennt. renderTelegram
 * teilt eine zu lange Antwort genau entlang dieser Struktur, nie mit einer
 * zweiten Lesart des Markdowns: zwischen den Blöcken, einen zu langen Block
 * an Zeile, Wort oder Zeichen, und was am Schnitt offen ist, wird geschlossen
 * und im nächsten Stück wieder geöffnet. So ist jedes Stück für sich gültiges
 * HTML, und jedes Zeichen behält seine Formatierung, auch bei einem Codeblock
 * über 4.000 Zeichen (früher wurde das fertige HTML ohne Rücksicht auf Tags
 * geschnitten, Telegram lehnte die Teile mit offenen Tags ab).
 *
 * Telegram kennt nur b, i, s, u, code, pre, a und blockquote; zu maskieren
 * sind nur &, < und >. Bereinigt wird immer zuerst (sanitizeModelOutput,
 * Entscheidung 0008, Issue #52); die Link-Vorschau schalten die Sendewege ab.
 *
 * Tabellen-Umbau und Bereinigung liegen in src/lib/telegram.ts, das seine
 * alten Namen (markdownToTelegramHTML, escapeHtml, stripHtmlTags,
 * chunkForTelegram) auf dieses Modul weiterleitet. Der Importzyklus ist
 * gewollt: Keines der beiden Module ruft beim Laden etwas aus dem anderen auf.
 */

import { asciiTableToList, convertTablesToLists, sanitizeModelOutput, TABLE_CODE_LANGS } from "../../lib/telegram";

/** Grenze je Nachricht in UTF-16-Einheiten (JavaScript .length), unter dem Telegram-Limit von 4.096 */
export const TELEGRAM_TEXT_MAX = 4000;

/** Kleinste Grenze für renderTelegram: Platz für Rahmen-Tags, wieder geöffnete Formatierung und Inhalt */
export const MIN_RENDER_MAX = 100;

// ------------------------------------------------------------
// Maskieren und Klartext
// ------------------------------------------------------------

const ESCAPES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };
const UNESCAPES: Record<string, string> = { amp: "&", lt: "<", gt: ">" };

/** Maskiert &, < und > (mehr verlangt Telegram-HTML nicht; Anführungszeichen bleiben) */
export function escapeTelegramHtml(text: string): string {
  return text.replace(/[&<>]/g, c => ESCAPES[c]);
}

/**
 * Telegram-HTML als Klartext für den Rückfall, wenn Telegram das HTML
 * ablehnt: Tags fallen weg, ihr Inhalt bleibt, &lt; &gt; &amp; werden in
 * einem Durchgang wieder Zeichen (aus "&amp;lt;" wird "&lt;").
 */
export function htmlToPlainText(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/&(amp|lt|gt);/g, (_m, name: string) => UNESCAPES[name]);
}

// ------------------------------------------------------------
// Klartext teilen (ohne Umwandlung)
// ------------------------------------------------------------

/** Bevorzugte Schnittstellen in dieser Reihenfolge; die Trennzeichen selbst fallen weg */
const PLAIN_BREAKS = ["\n\n", "\n", " "];
/** Eine Schnittstelle zählt nur, wenn das Stück davor länger als 30 % der Grenze ist */
const PLAIN_MIN_SHARE = 0.3;

/**
 * Teilt Klartext (oder schon fertiges HTML ohne Rücksicht auf Tags) in Stücke
 * von höchstens max Zeichen: an einer Leerzeile, sonst am Zeilenumbruch,
 * sonst am Leerzeichen, sonst hart. Leer ergibt keine Stücke.
 */
export function splitPlainText(text: string, max = TELEGRAM_TEXT_MAX): string[] {
  const pieces: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = max;
    let gap = 0;
    for (const sep of PLAIN_BREAKS) {
      const at = rest.lastIndexOf(sep, max);
      if (at > max * PLAIN_MIN_SHARE) {
        cut = at;
        gap = sep.length;
        break;
      }
    }
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut + gap);
  }
  if (rest !== "") pieces.push(rest);
  return pieces;
}

// ------------------------------------------------------------
// Einzelumwandlung Markdown zu Telegram-HTML
// ------------------------------------------------------------

/** Codezaun: drei Backticks, Sprachkennung, Zeilenumbruch, Inhalt bis zu den nächsten drei Backticks */
const FENCE = /```(\w*)\n([^]*?)```/g;
/** Inline-Code innerhalb einer Zeile */
const INLINE_CODE = /`([^\n`]+)`/g;

const CODE_CLOSE = "</code></pre>";

function codeOpen(lang: string): string {
  return lang === "" ? "<pre><code>" : `<pre><code class="language-${lang}">`;
}

/** Inhalt eines Zauns ohne den einen Zeilenumbruch vor den schließenden Backticks */
function fenceBody(raw: string): string {
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

/** Zaun ohne Programmiersprache, der nur eine ASCII-Tabelle trägt, als Liste; sonst null */
function fenceAsList(lang: string, raw: string): string | null {
  return TABLE_CODE_LANGS.has(lang.toLowerCase()) ? asciiTableToList(raw) || null : null;
}

/**
 * Hält geschützte Stücke (Code) hinter Platzhaltern aus \x00 und einer
 * Nummer fest, damit Maskieren und Inline-Regeln sie nicht verändern.
 */
function createVault() {
  const kept: string[] = [];
  return {
    keep: (piece: string) => `\x00${kept.push(piece) - 1}\x00`,
    restore: (text: string) => text.replace(/\x00(\d+)\x00/g, (_m, n: string) => kept[Number(n)]),
  };
}

/**
 * Inline-Regeln auf maskiertem Text, die Reihenfolge zählt: Links zuerst
 * (Unterstriche und Sternchen in Adressen bleiben), fett vor kursiv,
 * Überschriften werden fett (Telegram hat keine).
 */
const INLINE_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\[([^\]]+)]\(([^)]+)\)/g, '<a href="$2">$1</a>'],
  [/\*{2}(.+?)\*{2}/g, "<b>$1</b>"],
  [/(?<!\*)\*([^\n*]+)\*(?!\*)/g, "<i>$1</i>"],
  [/~{2}(.+?)~{2}/g, "<s>$1</s>"],
  [/^#{1,6}\s+(.+)$/gm, "<b>$1</b>"],
];

/** Lauf aufeinanderfolgender Zitatzeilen ("> " schon maskiert), samt Zeilenumbruch danach */
const QUOTE_RUN = /(?:^&gt; .+(?:\n|$))+/gm;
const QUOTE_MARK = "&gt; ";

function wrapQuotes(html: string): string {
  return html.replace(QUOTE_RUN, run => {
    const lines = (run.endsWith("\n") ? run.slice(0, -1) : run).split("\n");
    return `<blockquote>${lines.map(line => line.slice(QUOTE_MARK.length)).join("\n")}</blockquote>`;
  });
}

/**
 * Wandelt Markdown ohne Teilen in Telegram-HTML. Ablauf: bereinigen, Code
 * schützen (Zäune, dann Inline-Code; ASCII-Tabellen in Zäunen ohne Sprache
 * werden Listen), Pipe-Tabellen zu Listen, maskieren, Inline-Regeln,
 * Zitate, Trennlinien weg, höchstens eine Leerzeile, Code zurück, Leerraum
 * an den Enden weg.
 */
export function toTelegramHtml(markdown: string): string {
  const vault = createVault();
  let text = sanitizeModelOutput(markdown).replace(FENCE, (_m, lang: string, raw: string) => {
    return fenceAsList(lang, raw) ?? vault.keep(codeOpen(lang) + escapeTelegramHtml(fenceBody(raw)) + CODE_CLOSE);
  });
  text = text.replace(INLINE_CODE, (_m, code: string) => vault.keep(`<code>${escapeTelegramHtml(code)}</code>`));
  text = escapeTelegramHtml(convertTablesToLists(text));
  for (const [pattern, replacement] of INLINE_RULES) text = text.replace(pattern, replacement);
  text = wrapQuotes(text).replace(/^-{3,}$/gm, "").replace(/\n\n\n+/g, "\n\n");
  return vault.restore(text).trim();
}

// ------------------------------------------------------------
// Teilen entlang der Struktur der Einzelumwandlung
// ------------------------------------------------------------

/** Ein Stück Telegram-HTML: Tag, Entity oder ein Codepunkt */
interface Token {
  text: string;
  /** Tag-Name bei Tags */
  tag?: string;
  closing?: boolean;
}

const HTML_TOKEN = /<(\/?)([a-z]+)[^>]*>|&(?:amp|lt|gt|quot|#\d+|#x[\da-f]+);|[^]/giu;

function tokenize(html: string): Token[] {
  return Array.from(html.matchAll(HTML_TOKEN), m => (m[2] ? { text: m[0], tag: m[2].toLowerCase(), closing: m[1] === "/" } : { text: m[0] }));
}

/** Blockelemente: Grenzen davor und dahinter sind Blockgrenzen, beim Teilen in sich wird ihr Rahmen an jedem Teil wiederholt */
const CONTAINERS = new Set(["pre", "blockquote"]);

const isBlank = (t: Token) => !t.tag && /^\s$/u.test(t.text);
const isOpening = (t: Token | undefined) => !!t?.tag && !t.closing;
const isClosing = (t: Token | undefined) => !!t?.tag && !!t.closing;
const inPre = (stack: Token[]) => stack.some(t => t.tag === "pre");
/** Offene Formatierung (fett, Link, Inline-Code ...), Blockelemente und der Code im pre zählen nicht */
const inFormatting = (stack: Token[]) => !inPre(stack) && stack.some(t => !CONTAINERS.has(t.tag!));
const openTags = (stack: Token[]) => stack.map(t => t.text).join("");
const closeTags = (stack: Token[]) => stack.map(t => `</${t.tag}>`).reverse().join("");
const closeLength = (stack: Token[]) => stack.reduce((n, t) => n + t.tag!.length + 3, 0);
const frameLength = (stack: Token[]) => openTags(stack).length + closeLength(stack);

/** Offene Tags nach t: öffnend kommt dazu, schließend nimmt das letzte gleichnamige weg */
function withTag(stack: Token[], t: Token): Token[] {
  if (!t.tag) return stack;
  if (!t.closing) return [...stack, t];
  const at = stack.map(s => s.tag).lastIndexOf(t.tag);
  return at < 0 ? stack : [...stack.slice(0, at), ...stack.slice(at + 1)];
}

/**
 * Die Blöcke der fertigen Einzelumwandlung als Tokenbereiche [start, end),
 * ohne Leerraum an den Rändern. Grenzen liegen nur außerhalb jedes Tags: an
 * einer Leerzeile sowie vor und hinter einem Codeblock oder Zitat. Ein Link
 * oder eine Formatierung über eine Leerzeile bleibt so ein Block.
 */
function topBlocks(tokens: Token[]): Array<[number, number]> {
  const blocks: Array<[number, number]> = [];
  let stack: Token[] = [];
  let start = -1;
  let end = -1;
  let newlines = 0;
  let afterContainer = false;
  tokens.forEach((t, k) => {
    if (stack.length === 0) {
      if (isBlank(t)) {
        if (t.text === "\n") newlines++;
        return;
      }
      const opensContainer = isOpening(t) && CONTAINERS.has(t.tag!);
      if (start >= 0 && (newlines >= 2 || afterContainer || opensContainer)) {
        blocks.push([start, end]);
        start = -1;
      }
      if (start < 0) start = k;
      newlines = 0;
      afterContainer = false;
    }
    stack = withTag(stack, t);
    end = k + 1;
    if (stack.length === 0 && isClosing(t) && CONTAINERS.has(t.tag!)) afterContainer = true;
  });
  if (start >= 0) blocks.push([start, end]);
  return blocks;
}

/** Was statt eines weggefallenen Links hinter seinem Text steht: " (Adresse)" */
function linkTail(open: Token): Token[] {
  const href = /href="([^"]*)"/.exec(open.text)?.[1];
  return href === undefined ? [] : tokenize(` (${href})`);
}

/**
 * Je öffnendem Tag (Index in tokens) das längste unteilbare Stück Inhalt
 * (Zeichen, Entity), das es umschließt, auch in verschachtelten Tags. Für
 * einen Link darin zählt außerdem " (Adresse)": Fällt er weg, steht das an
 * seiner Stelle. Fällt er nicht weg, ändert das nichts, denn sein Tag enthält
 * die ganze Adresse; wo er passt, passt jedes Stück davon.
 */
function largestUnits(tokens: Token[]): Map<number, number> {
  const largest = new Map<number, number>();
  const open: Array<{ at: number; tag: string; size: number }> = [];
  const grow = (size: number) => {
    for (const o of open) o.size = Math.max(o.size, size);
  };
  tokens.forEach((t, k) => {
    if (!t.tag) return grow(t.text.length);
    if (t.closing) {
      const at = open.map(o => o.tag).lastIndexOf(t.tag);
      if (at >= 0) largest.set(open[at].at, open.splice(at, 1)[0].size);
      return;
    }
    if (t.tag === "a") grow(Math.max(...linkTail(t).map(u => u.text.length)));
    open.push({ at: k, tag: t.tag, size: 0 });
  });
  for (const o of open) largest.set(o.at, o.size);
  return largest;
}

/**
 * Rahmen, die ihren Inhalt nicht tragen: Passt neben einem öffnenden Tag samt
 * allen umschließenden Tags und ihren Schlüssen das längste unteilbare Stück
 * seines tatsächlichen Inhalts nicht (largestUnits), verliert der Codeblock
 * seine Sprachkennung, ein Link wird Text "Linktext (Adresse)", jede andere
 * Formatierung fällt weg. Sonst bleibt jede Formatierung genau so, wie die
 * Einzelumwandlung sie erzeugt hat, auch wenn neben ihr nur ein Zeichen Platz
 * ist.
 */
function fitFrames(tokens: Token[], budget: number): Token[] {
  const largest = largestUnits(tokens);
  const out: Token[] = [];
  let stack: Token[] = [];
  /** Alle geöffneten Tags in Reihenfolge; tail ist bei weggefallenen das, was statt des Schlusses kommt */
  const opened: Array<{ tag: string; kept: boolean; tail: Token[] }> = [];
  tokens.forEach((t, k) => {
    if (isOpening(t)) {
      const fits = (open: Token) => frameLength([...stack, open]) + largest.get(k)! <= budget;
      let open: Token | null = t;
      if (!fits(open) && open.tag === "code" && open.text !== "<code>") open = { text: "<code>", tag: "code" };
      if (!fits(open)) open = null;
      opened.push({ tag: t.tag!, kept: open !== null, tail: open === null && t.tag === "a" ? linkTail(t) : [] });
      if (open) {
        out.push(open);
        stack = withTag(stack, open);
      }
      return;
    }
    if (isClosing(t)) {
      const at = opened.map(o => o.tag).lastIndexOf(t.tag!);
      const entry = at < 0 ? undefined : opened.splice(at, 1)[0];
      if (entry && !entry.kept) {
        out.push(...entry.tail);
        return;
      }
      stack = withTag(stack, t);
    }
    out.push(t);
  });
  return out;
}

/** Arten von Schnittstellen, höher ist besser */
const LINE = 3;
const WORD = 2;
const CHAR = 1;

/**
 * Rang eines Schnitts vor tokens[c] bei offenen Tags stack, -1 wenn dort
 * nicht geschnitten wird (leeres Element davor oder danach, "!" vor einem
 * Link: aus einem maskierten "\!" würde ein Bild). Erst zählt die Art:
 * Zeilenumbruch vor Leerzeichen vor Zeichen (im Codeblock nur Zeile oder
 * Zeichen, eine Zeile über dem Platz wird hart geschnitten). Bei gleicher Art
 * gewinnt ein Schnitt außerhalb jeder Formatierung.
 */
function cutRank(tokens: Token[], c: number, stack: Token[]): number {
  const prev = tokens[c - 1];
  const next = tokens[c];
  if (isOpening(prev) || isClosing(next)) return -1;
  if (next.text === "!" && isOpening(tokens[c + 1]) && tokens[c + 1].tag === "a") return -1;
  if (inPre(stack)) return 2 * (prev.text === "\n" ? LINE : CHAR) + 1;
  const kind = next.text === "\n" ? LINE : isBlank(next) ? WORD : CHAR;
  return 2 * kind + (inFormatting(stack) ? 0 : 1);
}

/**
 * Teilt einen Block, der allein zu lang ist, in Stücke von höchstens budget
 * Zeichen. Jedes Stück wird so lang wie möglich und endet an der besten
 * Schnittstelle (cutRank, bei gleichem Rang die letzte). Was am Schnitt offen
 * ist, wird geschlossen und im nächsten Stück mit denselben Tags wieder
 * geöffnet (Sprachkennung, Link-Adresse, Zitat). Leerraum an Schnittstellen
 * fällt weg, im Codeblock bleibt er: Der Zeilenumbruch steht am Ende des
 * vorderen Stücks, der Code aller Stücke ergibt genau den Inhalt.
 */
function splitBlock(blockTokens: Token[], budget: number): string[] {
  const tokens = fitFrames(blockTokens, budget);
  const pieces: string[] = [];
  let carried: Token[] = [];
  let i = 0;
  while (i < tokens.length) {
    while (i < tokens.length && !inPre(carried) && (isBlank(tokens[i]) || isClosing(tokens[i]))) {
      carried = withTag(carried, tokens[i]);
      i++;
    }
    if (i >= tokens.length) break;
    let stack = carried;
    let size = openTags(carried).length;
    let best = -1;
    let bestRank = -1;
    let bestStack = carried;
    let last = -1;
    let lastStack = carried;
    let j = i;
    for (; j < tokens.length; j++) {
      if (j > i) {
        const rank = cutRank(tokens, j, stack);
        if (rank >= 0 && rank >= bestRank) [best, bestRank, bestStack] = [j, rank, stack];
        [last, lastStack] = [j, stack];
      }
      const next = withTag(stack, tokens[j]);
      if (size + tokens[j].text.length + closeLength(next) > budget) break;
      size += tokens[j].text.length;
      stack = next;
    }
    const [cut, open] = j >= tokens.length ? [j, stack] : best >= 0 ? [best, bestStack] : [last, lastStack];
    // Leerraum und leere öffnende Tags vor dem Schnitt gehören nicht ins Stück; die Tags öffnet das nächste
    let end = cut;
    while (end > i && !inPre(open) && (isBlank(tokens[end - 1]) || isOpening(tokens[end - 1]))) end--;
    const body = tokens.slice(i, end);
    pieces.push(openTags(carried) + body.map(t => t.text).join("") + closeTags(body.reduce(withTag, carried)));
    carried = open;
    i = cut;
  }
  return pieces;
}

// ------------------------------------------------------------
// renderTelegram
// ------------------------------------------------------------

/**
 * Markdown als Telegram-HTML in Stücken von höchstens max Zeichen (UTF-16,
 * mit Tags und Entities). Passt die Einzelumwandlung, ist das Ergebnis genau
 * [toTelegramHtml(markdown)]; leer oder nur Leerraum (auch nach der
 * Bereinigung) ergibt []. Sonst wird das HTML der Einzelumwandlung selbst
 * geteilt, nie ein zweites Mal umgewandelt: ganze Blöcke (topBlocks) werden
 * zu Stücken zusammengefasst, solange sie passen; ein Block, der allein zu
 * lang ist, wird in sich geteilt (splitBlock), und seine Teile stehen für
 * sich. Jedes Zeichen behält so die Formatierung der Einzelumwandlung. max
 * muss eine ganze Zahl ab MIN_RENDER_MAX sein, sonst RangeError.
 */
export function renderTelegram(markdown: string, max = TELEGRAM_TEXT_MAX): string[] {
  if (!Number.isInteger(max) || max < MIN_RENDER_MAX) {
    throw new RangeError(`renderTelegram: max muss eine ganze Zahl ab ${MIN_RENDER_MAX} sein, war ${max}`);
  }
  const whole = toTelegramHtml(markdown);
  if (whole.length <= max) return whole === "" ? [] : [whole];

  const tokens = tokenize(whole);
  const offsets = [0];
  for (const t of tokens) offsets.push(offsets.at(-1)! + t.text.length);
  const html = (start: number, end: number) => whole.slice(offsets[start], offsets[end]);

  const parts: string[] = [];
  let pending: [number, number] | null = null;
  for (const [start, end] of topBlocks(tokens)) {
    if (offsets[end] - offsets[start] > max) {
      if (pending) parts.push(html(...pending));
      pending = null;
      parts.push(...splitBlock(tokens.slice(start, end), max));
      continue;
    }
    if (pending && offsets[end] - offsets[pending[0]] <= max) {
      pending[1] = end;
      continue;
    }
    if (pending) parts.push(html(...pending));
    pending = [start, end];
  }
  if (pending) parts.push(html(...pending));
  return parts;
}
