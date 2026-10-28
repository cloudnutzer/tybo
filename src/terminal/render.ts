/**
 * Antworten als formatierter Text im Terminal (Issue #60).
 *
 * Markdown wird mit marked (schon im Projekt) zerlegt und selbst ausgegeben:
 * Überschriften, Listen, Fett, Kursiv, Code-Blöcke, Zitate, Tabellen, Links
 * als „Text (Adresse)". Rohes HTML bleibt sichtbarer Text, nichts wird
 * interpretiert. Vor dem Zerlegen läuft der Text durch sanitizeTerminal,
 * die einzigen Escape-Sequenzen der Ausgabe sind also die Farben von tybo
 * selbst. Ohne Farbe (NO_COLOR, kein TTY) ist die Ausgabe schlichter Text
 * ohne ein einziges ESC-Zeichen.
 */

import { Lexer, type Token, type Tokens } from "marked";
import { sanitizeTerminal } from "./sanitize";

type Paint = (text: string) => string;

export interface Style {
  color: boolean;
  bold: Paint;
  dim: Paint;
  italic: Paint;
  underline: Paint;
  strike: Paint;
  red: Paint;
  green: Paint;
  yellow: Paint;
  cyan: Paint;
  magenta: Paint;
  inverse: Paint;
}

/** Eigene Ende-Codes je Attribut, damit Verschachtelungen (fett in kursiv) halten */
function sgr(on: number, off: number): Paint {
  return text => (text ? `\u001b[${on}m${text}\u001b[${off}m` : text);
}

const plain: Paint = text => text;

export function createStyle(color: boolean): Style {
  if (!color) {
    return { color, bold: plain, dim: plain, italic: plain, underline: plain, strike: plain, red: plain, green: plain, yellow: plain, cyan: plain, magenta: plain, inverse: plain };
  }
  return {
    color,
    bold: sgr(1, 22),
    dim: sgr(2, 22),
    italic: sgr(3, 23),
    underline: sgr(4, 24),
    strike: sgr(9, 29),
    red: sgr(31, 39),
    green: sgr(32, 39),
    yellow: sgr(33, 39),
    cyan: sgr(36, 39),
    magenta: sgr(35, 39),
    inverse: sgr(7, 27),
  };
}

/**
 * Farbe nur mit TTY und ohne NO_COLOR (https://no-color.org: jeder nicht
 * leere Wert). TERM=dumb gilt ebenfalls als ohne Farbe.
 */
export function wantsColor(env: Record<string, string | undefined>, isTTY: boolean): boolean {
  if (!isTTY) return false;
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  return env.TERM !== "dumb";
}

/** Entfernt die Farb-Sequenzen von tybo, etwa für Breitenberechnungen */
export function stripStyle(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}

/** Sichtbare Breite in Terminal-Spalten (breite Zeichen zählen doppelt) */
export function displayWidth(text: string): number {
  return Bun.stringWidth(stripStyle(text));
}

const NAMED_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML-Zeichenreferenzen in Markdown-Text wie im Browser als Zeichen; Ergebnis erneut bereinigt */
function decodeEntities(text: string): string {
  const decoded = text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" || ref[1] === "X" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[ref.toLowerCase()] ?? whole;
  });
  return sanitizeTerminal(decoded);
}

class TerminalRenderer {
  constructor(private readonly s: Style) {}

  inline(tokens: Token[] | undefined): string {
    let out = "";
    for (const token of tokens ?? []) out += this.inlineToken(token);
    return out;
  }

  private inlineToken(token: Token): string {
    const s = this.s;
    switch (token.type) {
      case "text": {
        const t = token as Tokens.Text;
        return t.tokens ? this.inline(t.tokens) : decodeEntities(t.text);
      }
      case "escape":
        return (token as Tokens.Escape).text;
      case "strong":
        return s.bold(this.inline((token as Tokens.Strong).tokens));
      case "em":
        return s.italic(this.inline((token as Tokens.Em).tokens));
      case "del":
        return s.color ? s.strike(this.inline((token as Tokens.Del).tokens)) : `~~${this.inline((token as Tokens.Del).tokens)}~~`;
      case "codespan": {
        const text = (token as Tokens.Codespan).text;
        return s.color ? s.yellow(text) : `\`${text}\``;
      }
      case "br":
        return "\n";
      case "link": {
        const t = token as Tokens.Link;
        const label = this.inline(t.tokens);
        const href = t.href ?? "";
        const bare = stripStyle(label);
        if (!href || bare === href || `mailto:${bare}` === href) return s.underline(label || href);
        return `${s.underline(label)} ${s.dim(`(${href})`)}`;
      }
      case "image": {
        const t = token as Tokens.Image;
        const alt = decodeEntities(t.text || "");
        return `[Bild${alt ? `: ${alt}` : ""}]${t.href ? ` ${s.dim(`(${t.href})`)}` : ""}`;
      }
      case "html":
        // Rohes HTML bleibt Text, wie es geschrieben wurde
        return (token as Tokens.HTML).text;
      case "checkbox":
        return "";
      default:
        return "raw" in token && typeof token.raw === "string" ? token.raw : "";
    }
  }

  /** Zeilen eines Blocks; Leerzeilen zwischen Blöcken setzt blocks() */
  private block(token: Token): string[] | null {
    const s = this.s;
    switch (token.type) {
      case "space":
      case "checkbox":
        return null;
      case "heading": {
        const t = token as Tokens.Heading;
        const text = this.inline(t.tokens);
        if (s.color) return [t.depth === 1 ? s.bold(s.underline(s.cyan(text))) : t.depth === 2 ? s.bold(s.cyan(text)) : s.bold(text)];
        if (t.depth <= 2) return [text, (t.depth === 1 ? "=" : "-").repeat(Math.max(3, displayWidth(text)))];
        return [text];
      }
      case "paragraph":
        return this.inline((token as Tokens.Paragraph).tokens).split("\n");
      case "text": {
        const t = token as Tokens.Text;
        return (t.tokens ? this.inline(t.tokens) : decodeEntities(t.text)).split("\n");
      }
      case "list":
        return this.list(token as Tokens.List);
      case "code": {
        const t = token as Tokens.Code;
        const lines = t.text.replace(/\n$/, "").split("\n");
        if (s.color) return lines.map(line => `${s.dim("│")} ${s.yellow(line)}`);
        return lines.map(line => `    ${line}`);
      }
      case "blockquote": {
        const inner = this.blocks((token as Tokens.Blockquote).tokens);
        return inner.map(line => (s.color ? `${s.dim("│")} ${s.italic(line)}` : `> ${line}`));
      }
      case "hr":
        return [s.dim((s.color ? "─" : "-").repeat(24))];
      case "table":
        return this.table(token as Tokens.Table);
      case "html":
        // HTML-Block als sichtbarer Text
        return (token as Tokens.HTML).text.replace(/\n+$/, "").split("\n");
      default:
        return "raw" in token && typeof token.raw === "string" ? token.raw.replace(/\n+$/, "").split("\n") : null;
    }
  }

  blocks(tokens: Token[]): string[] {
    const out: string[] = [];
    for (const token of tokens) {
      const lines = this.block(token);
      if (!lines || lines.length === 0) continue;
      if (out.length > 0) out.push("");
      out.push(...lines);
    }
    return out;
  }

  private list(list: Tokens.List): string[] {
    const s = this.s;
    const out: string[] = [];
    const start = typeof list.start === "number" ? list.start : 1;
    list.items.forEach((item, i) => {
      const bullet = list.ordered ? `${start + i}.` : s.color ? "•" : "-";
      const task = item.task ? (item.checked ? "[x] " : "[ ] ") : "";
      const marker = `${bullet} `;
      const pad = " ".repeat(displayWidth(marker));
      // Enge Listen: Blöcke eines Punkts ohne Leerzeile dazwischen
      const lines = item.loose ? this.blocks(item.tokens) : item.tokens.flatMap(t => this.block(t) ?? []);
      if (lines.length === 0) lines.push("");
      lines[0] = `${task}${lines[0]}`;
      out.push(`${s.color ? s.cyan(marker) : marker}${lines[0]}`);
      for (const line of lines.slice(1)) out.push(line ? `${pad}${line}` : "");
    });
    return out;
  }

  private table(table: Tokens.Table): string[] {
    const s = this.s;
    const header = table.header.map(cell => this.inline(cell.tokens));
    const rows = table.rows.map(row => row.map(cell => this.inline(cell.tokens)));
    const widths = header.map((h, i) => Math.max(displayWidth(h), ...rows.map(r => displayWidth(r[i] ?? ""))));
    const pad = (text: string, i: number) => text + " ".repeat(Math.max(0, widths[i] - displayWidth(text)));
    const sep = s.color ? s.dim(" │ ") : " | ";
    const line = (cells: string[], paint: Paint = plain) => cells.map((c, i) => paint(pad(c, i))).join(sep).trimEnd();
    const rule = widths.map(w => (s.color ? "─" : "-").repeat(w)).join(s.color ? "─┼─" : "-+-");
    // Fett je Zelle: der gedimmte Trenner beendet sonst auch das Fett (beide enden mit Code 22)
    return [line(header, s.bold), s.dim(rule), ...rows.map(r => line(r))];
  }
}

/** Markdown einer Antwort als Terminal-Text (Zeilen mit \n getrennt, ohne abschließenden Umbruch) */
export function renderTerminalMarkdown(markdown: string, style: Style): string {
  const clean = sanitizeTerminal(markdown);
  let tokens: Token[];
  try {
    tokens = new Lexer({ gfm: true }).lex(clean);
  } catch {
    return clean;
  }
  return new TerminalRenderer(style).blocks(tokens).join("\n");
}
