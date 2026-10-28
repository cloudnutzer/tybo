/**
 * Kleiner Rechner für [RECHNE: …] im Telefonhörer (Issue #259). Kein eval,
 * keine Funktionen, keine Variablen: nur Zahlen, + - * /, Klammern und
 * Prozent.
 *
 * - Zahlen: deutsches Komma („18,5“) und Tausenderpunkt („2.450“,
 *   „1.250.000,75“). Ein Punkt gefolgt von genau drei Ziffern (auch
 *   mehrfach) ist ein Tausenderpunkt, sonst ein Dezimalpunkt („2.5“).
 * - Prozent: „18 %“ ist 0,18. „18 % von 2.450“ ist 18 Prozent von 2.450,
 *   also 441; „von“ geht nur direkt nach einer Prozentangabe.
 * - Auch erlaubt: „×“, „·“ als mal, „÷“ und „:“ als geteilt, „−“ als minus,
 *   Leerraum und „€“ bzw. „Euro“ hinter Zahlen (werden übergangen).
 * - Grenzen: höchstens 200 Zeichen, 20 Klammerebenen, Ergebnis endlich.
 *   Division durch null, Fremdzeichen und alles andere: kein Ergebnis.
 */

export const CALC_MAX_CHARS = 200;
export const CALC_MAX_DEPTH = 20;

export type CalcResult = { ok: true; value: number; text: string } | { ok: false };

type Token = { t: "num"; v: number } | { t: "op"; v: "+" | "-" | "*" | "/" } | { t: "(" } | { t: ")" } | { t: "%" } | { t: "von" };

const NUMBER = /^(?:\d{1,3}(?:\.\d{3})+(?:,\d+)?(?![\d.,])|\d+(?:[.,]\d+)?)/;

function tokenize(input: string): Token[] | null {
  const out: Token[] = [];
  let s = input;
  while (s.length) {
    const ws = /^\s+/.exec(s);
    if (ws) {
      s = s.slice(ws[0].length);
      continue;
    }
    const unit = /^(?:€|euro\b|eur\b)/i.exec(s);
    if (unit) {
      s = s.slice(unit[0].length);
      continue;
    }
    const num = NUMBER.exec(s);
    if (num) {
      const raw = num[0];
      // Tausenderpunkt (Gruppen zu genau drei Ziffern), sonst Punkt oder Komma als Dezimaltrenner
      const normalized = /^\d{1,3}(?:\.\d{3})+(?:,\d+)?$/.test(raw) ? raw.replace(/\./g, "").replace(",", ".") : raw.replace(",", ".");
      const v = Number(normalized);
      if (!Number.isFinite(v)) return null;
      out.push({ t: "num", v });
      s = s.slice(raw.length);
      continue;
    }
    const von = /^von\b/i.exec(s);
    if (von) {
      out.push({ t: "von" });
      s = s.slice(von[0].length);
      continue;
    }
    const c = s[0];
    if (c === "+") out.push({ t: "op", v: "+" });
    else if (c === "-" || c === "−") out.push({ t: "op", v: "-" });
    else if (c === "*" || c === "×" || c === "·") out.push({ t: "op", v: "*" });
    else if (c === "/" || c === "÷" || c === ":") out.push({ t: "op", v: "/" });
    else if (c === "(") out.push({ t: "(" });
    else if (c === ")") out.push({ t: ")" });
    else if (c === "%") out.push({ t: "%" });
    else return null;
    s = s.slice(1);
  }
  return out;
}

class Parser {
  private i = 0;
  private depth = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): number | null {
    const v = this.expr();
    if (v === null || this.i !== this.tokens.length) return null;
    return v;
  }

  private peek(): Token | undefined {
    return this.tokens[this.i];
  }

  // expr := term (("+" | "-") term)*
  private expr(): number | null {
    let left = this.term();
    if (left === null) return null;
    for (let tok = this.peek(); tok?.t === "op" && (tok.v === "+" || tok.v === "-"); tok = this.peek()) {
      this.i++;
      const right = this.term();
      if (right === null) return null;
      left = tok.v === "+" ? left + right : left - right;
    }
    return left;
  }

  // term := unary (("*" | "/") unary | "von" unary)*
  private term(): number | null {
    let left = this.unary();
    if (left === null) return null;
    for (let tok = this.peek(); tok && ((tok.t === "op" && (tok.v === "*" || tok.v === "/")) || tok.t === "von"); tok = this.peek()) {
      // „von“ nur direkt nach einer Prozentangabe („18 % von 2.450“)
      if (tok.t === "von" && this.tokens[this.i - 1]?.t !== "%") return null;
      this.i++;
      const right = this.unary();
      if (right === null) return null;
      if (tok.t === "op" && tok.v === "/") {
        if (right === 0) return null;
        left = left / right;
      } else left = left * right;
    }
    return left;
  }

  // unary := ("+" | "-") unary | postfix
  private unary(): number | null {
    const tok = this.peek();
    if (tok?.t === "op" && (tok.v === "-" || tok.v === "+")) {
      this.i++;
      if (++this.depth > CALC_MAX_DEPTH) return null;
      const v = this.unary();
      this.depth--;
      if (v === null) return null;
      return tok.v === "-" ? -v : v;
    }
    return this.postfix();
  }

  // postfix := primary "%"?
  private postfix(): number | null {
    const v = this.primary();
    if (v === null) return null;
    if (this.peek()?.t === "%") {
      this.i++;
      return v / 100;
    }
    return v;
  }

  // primary := Zahl | "(" expr ")"
  private primary(): number | null {
    const tok = this.peek();
    if (!tok) return null;
    if (tok.t === "num") {
      this.i++;
      return tok.v;
    }
    if (tok.t === "(") {
      this.i++;
      if (++this.depth > CALC_MAX_DEPTH) return null;
      const v = this.expr();
      this.depth--;
      if (v === null || this.peek()?.t !== ")") return null;
      this.i++;
      return v;
    }
    return null;
  }
}

/** Ergebnis so, wie man es sagt: deutsches Komma, Tausenderpunkt, höchstens sechs Nachkommastellen */
export function formatGermanNumber(value: number): string {
  const rounded = Math.abs(value) < 1e-9 ? 0 : value;
  return rounded.toLocaleString("de-DE", { maximumFractionDigits: 6, useGrouping: true });
}

export function evaluateExpression(input: string): CalcResult {
  const expr = input.trim();
  if (!expr || expr.length > CALC_MAX_CHARS) return { ok: false };
  const tokens = tokenize(expr);
  if (!tokens || !tokens.length) return { ok: false };
  const value = new Parser(tokens).parse();
  if (value === null || !Number.isFinite(value)) return { ok: false };
  return { ok: true, value, text: formatGermanNumber(value) };
}
