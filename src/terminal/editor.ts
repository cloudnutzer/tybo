/**
 * Eingabe von tybo (Issue #60), ohne Abhängigkeit und ohne echtes
 * Terminal testbar: KeyDecoder übersetzt Bytes aus dem Terminal im
 * Raw-Modus in Tasten, LineEditor hält Text, Cursor und Verlauf.
 *
 * Enter sendet. Alt+Enter oder \ am Zeilenende (dann Enter) beginnt eine
 * neue Zeile. Eingefügter Text (Bracketed Paste) bleibt mit allen Zeilen
 * im Feld, statt Zeile für Zeile gesendet zu werden. Pfeil hoch/runter
 * bewegen in mehrzeiligem Text zwischen den Zeilen, an der ersten bzw.
 * letzten Zeile durch frühere Eingaben.
 *
 * Tab (Issue #61): Ob ein Tab getippt oder eingefügt wurde, entscheidet
 * allein der Bracketed-Paste-Zustand, nie die Grenzen der Datenblöcke. Ein
 * Tab zwischen ESC[200~ und ESC[201~ bleibt Textzeichen, jeder andere Tab ist
 * die Tab-Taste. Grenze: Terminals ohne Bracketed Paste markieren Einfügungen
 * nicht; ein Tab in so eingefügtem Text wirkt dann wie getippt (ergänzt, wenn
 * der Cursor gerade am Ende einer einzeiligen Eingabe steht) und fehlt im Text.
 */

import { displayWidth } from "./render";

export type Key =
  | { type: "char"; text: string }
  | { type: "paste"; text: string }
  | { type: "enter" }
  | { type: "newline" }
  | { type: "backspace" }
  | { type: "delete" }
  | { type: "left" }
  | { type: "right" }
  | { type: "up" }
  | { type: "down" }
  | { type: "home" }
  | { type: "end" }
  | { type: "clear" }
  | { type: "delete-word" }
  | { type: "ctrl-c" }
  | { type: "ctrl-d" }
  /** Tab außerhalb von Bracketed Paste (Issue #61): ergänzen. Tabs in Bracketed Paste bleiben Text */
  | { type: "tab" };

const PASTE_START = "\u001b[200~";
const PASTE_END = "\u001b[201~";

/** Eingefügter Text: Zeilenenden vereinheitlichen, Steuerzeichen außer \n und \t weg */
function cleanPaste(text: string): string {
  return text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

export class KeyDecoder {
  private pending = "";
  private paste: string | null = null;

  /** Bytes (als Text) aus dem Terminal; unvollständige Sequenzen warten auf den nächsten Block */
  push(data: string): Key[] {
    this.pending += data;
    const keys: Key[] = [];
    while (this.pending) {
      if (this.paste !== null) {
        const end = this.pending.indexOf(PASTE_END);
        if (end === -1) {
          // Das Ende der Einfügung kann geteilt ankommen: einen möglichen Anfang davon zurückhalten
          let keep = 0;
          for (let k = Math.min(PASTE_END.length - 1, this.pending.length); k > 0; k--) {
            if (PASTE_END.startsWith(this.pending.slice(-k))) {
              keep = k;
              break;
            }
          }
          this.paste += this.pending.slice(0, this.pending.length - keep);
          this.pending = this.pending.slice(this.pending.length - keep);
          break;
        }
        this.paste += this.pending.slice(0, end);
        this.pending = this.pending.slice(end + PASTE_END.length);
        keys.push({ type: "paste", text: cleanPaste(this.paste) });
        this.paste = null;
        continue;
      }
      const consumed = this.next(keys);
      if (consumed === 0) break;
      this.pending = this.pending.slice(consumed);
    }
    return keys;
  }

  /** Ein allein stehendes ESC nach kurzer Pause verwerfen (Escape-Taste) */
  flush(): void {
    if (this.paste === null && this.pending === "\u001b") this.pending = "";
  }

  /** Liest eine Taste vom Anfang von pending; 0: noch unvollständig */
  private next(keys: Key[]): number {
    const s = this.pending;
    const c = s[0];
    if (c === "\u001b") {
      if (s.length === 1) return 0;
      const n = s[1];
      if (n === "\r" || n === "\n") {
        keys.push({ type: "newline" });
        return 2;
      }
      if (n === "[" || n === "O") {
        const m = /^\u001b[[O]([0-9;]*)([ -/]*)([@-~])/.exec(s);
        if (!m) return /^\u001b[[O][0-9; -/]*$/.test(s) ? 0 : 2;
        if (m[0] === PASTE_START) {
          this.paste = "";
          return m[0].length;
        }
        const key = this.csi(m[1], m[3]);
        if (key) keys.push(key);
        return m[0].length;
      }
      if (n === "\u007f" || n === "\b") {
        keys.push({ type: "delete-word" });
        return 2;
      }
      // Alt+Taste: nicht belegt
      return 2;
    }
    if (c === "\r" || c === "\n") {
      keys.push({ type: "enter" });
      // \r\n aus manchen Terminals ist eine Taste
      return c === "\r" && s[1] === "\n" ? 2 : 1;
    }
    if (c === "\u007f" || c === "\b") keys.push({ type: "backspace" });
    else if (c === "\u0003") keys.push({ type: "ctrl-c" });
    else if (c === "\u0004") keys.push({ type: "ctrl-d" });
    else if (c === "\u0001") keys.push({ type: "home" });
    else if (c === "\u0005") keys.push({ type: "end" });
    else if (c === "\u0015") keys.push({ type: "clear" });
    else if (c === "\u0017") keys.push({ type: "delete-word" });
    // Außerhalb von Bracketed Paste immer die Taste, egal wie die Blöcke geteilt sind
    else if (c === "\t") keys.push({ type: "tab" });
    else if (c < " " || (c >= "\u0080" && c <= "\u009f")) {
      // übrige Steuerzeichen: ignorieren
    } else {
      // zusammenhängender Text in einem Stück (schnell getippt oder ohne Bracketed Paste)
      const m = /^[^\u0000-\u001f\u007f-\u009f]+/.exec(s)!;
      keys.push({ type: "char", text: m[0] });
      return m[0].length;
    }
    return 1;
  }

  private csi(params: string, final: string): Key | null {
    const first = params.split(";")[0];
    switch (final) {
      case "A":
        return { type: "up" };
      case "B":
        return { type: "down" };
      case "C":
        return { type: "right" };
      case "D":
        return { type: "left" };
      case "H":
        return { type: "home" };
      case "F":
        return { type: "end" };
      case "~":
        if (first === "1" || first === "7") return { type: "home" };
        if (first === "4" || first === "8") return { type: "end" };
        if (first === "3") return { type: "delete" };
        return null;
      default:
        return null;
    }
  }
}

export type EditorAction = { type: "none" } | { type: "submit"; text: string } | { type: "interrupt" } | { type: "eof" } | { type: "complete" };

export interface RenderedInput {
  /** Zeilen samt Prompt, wie sie ins Terminal gehen */
  lines: string[];
  /** Zeile und Spalte des Cursors innerhalb dieser Zeilen (ohne Umbruch durch die Terminalbreite) */
  cursorLine: number;
  cursorColumn: number;
}

const MAX_HISTORY = 200;
const TAB_TEXT = "    ";

/** Anzeige eines Zeichens: Tabulator als Leerzeichen */
function show(text: string): string {
  return text.replace(/\t/g, TAB_TEXT);
}

export class LineEditor {
  /** Text als Liste von Codepoints, damit der Cursor nie ein Zeichen teilt */
  private chars: string[] = [];
  private cursor = 0;
  private readonly history: string[] = [];
  private index: number | null = null;
  private draft = "";

  get text(): string {
    return this.chars.join("");
  }

  get cursorIndex(): number {
    return this.cursor;
  }

  /** Setzt den Text (etwa einen Entwurf nach einem Fehler), Cursor ans Ende */
  setText(text: string): void {
    this.chars = Array.from(text);
    this.cursor = this.chars.length;
  }

  /** Frühere Eingaben, älteste zuerst (für Tests) */
  historyEntries(): string[] {
    return [...this.history];
  }

  private insert(text: string): void {
    const add = Array.from(text);
    this.chars.splice(this.cursor, 0, ...add);
    this.cursor += add.length;
    this.index = null;
  }

  /** Anfang und Ende der Zeile, in der der Cursor steht */
  private lineBounds(at = this.cursor): { start: number; end: number } {
    let start = at;
    while (start > 0 && this.chars[start - 1] !== "\n") start--;
    let end = at;
    while (end < this.chars.length && this.chars[end] !== "\n") end++;
    return { start, end };
  }

  private moveLine(direction: -1 | 1): boolean {
    const { start, end } = this.lineBounds();
    const column = this.cursor - start;
    if (direction === -1) {
      if (start === 0) return false;
      const prev = this.lineBounds(start - 1);
      this.cursor = Math.min(prev.start + column, prev.end);
    } else {
      if (end === this.chars.length) return false;
      const next = this.lineBounds(end + 1);
      this.cursor = Math.min(next.start + column, next.end);
    }
    return true;
  }

  private historyUp(): void {
    if (this.history.length === 0) return;
    if (this.index === null) {
      this.draft = this.text;
      this.index = this.history.length - 1;
    } else if (this.index > 0) {
      this.index--;
    } else {
      return;
    }
    this.setText(this.history[this.index]);
  }

  private historyDown(): void {
    if (this.index === null) return;
    if (this.index < this.history.length - 1) {
      this.index++;
      this.setText(this.history[this.index]);
      return;
    }
    this.index = null;
    this.setText(this.draft);
  }

  private remember(text: string): void {
    if (this.history.at(-1) !== text) this.history.push(text);
    if (this.history.length > MAX_HISTORY) this.history.shift();
  }

  handle(key: Key): EditorAction {
    switch (key.type) {
      case "char":
      case "paste":
        this.insert(key.text);
        return { type: "none" };
      case "newline":
        this.insert("\n");
        return { type: "none" };
      case "enter": {
        // \ direkt vor dem Cursor am Zeilenende: statt senden eine neue Zeile
        const atLineEnd = this.cursor === this.chars.length || this.chars[this.cursor] === "\n";
        if (atLineEnd && this.cursor > 0 && this.chars[this.cursor - 1] === "\\") {
          this.chars[this.cursor - 1] = "\n";
          this.index = null;
          return { type: "none" };
        }
        const text = this.text;
        if (!text.trim()) return { type: "none" };
        this.remember(text);
        this.chars = [];
        this.cursor = 0;
        this.index = null;
        this.draft = "";
        return { type: "submit", text };
      }
      case "backspace":
        if (this.cursor > 0) {
          this.chars.splice(this.cursor - 1, 1);
          this.cursor--;
        }
        return { type: "none" };
      case "delete":
        if (this.cursor < this.chars.length) this.chars.splice(this.cursor, 1);
        return { type: "none" };
      case "delete-word": {
        let start = this.cursor;
        while (start > 0 && /\s/.test(this.chars[start - 1])) start--;
        while (start > 0 && !/\s/.test(this.chars[start - 1])) start--;
        this.chars.splice(start, this.cursor - start);
        this.cursor = start;
        return { type: "none" };
      }
      case "left":
        if (this.cursor > 0) this.cursor--;
        return { type: "none" };
      case "right":
        if (this.cursor < this.chars.length) this.cursor++;
        return { type: "none" };
      case "home":
        this.cursor = this.lineBounds().start;
        return { type: "none" };
      case "end":
        this.cursor = this.lineBounds().end;
        return { type: "none" };
      case "up":
        if (!this.moveLine(-1)) this.historyUp();
        return { type: "none" };
      case "down":
        if (!this.moveLine(1)) this.historyDown();
        return { type: "none" };
      case "clear":
        this.chars = [];
        this.cursor = 0;
        this.index = null;
        return { type: "none" };
      case "ctrl-c":
        return { type: "interrupt" };
      case "tab":
        // Nur am Ende einer einzeiligen Eingabe; sonst tut Tab nichts
        return this.cursor === this.chars.length && !this.chars.includes("\n") ? { type: "complete" } : { type: "none" };
      case "ctrl-d":
        if (this.chars.length === 0) return { type: "eof" };
        if (this.cursor < this.chars.length) this.chars.splice(this.cursor, 1);
        return { type: "none" };
    }
  }

  /** Zeilen mit Prompt (erste Zeile) und Einrückung (weitere Zeilen) */
  render(prompt: string, continuation: string): RenderedInput {
    const before = this.chars.slice(0, this.cursor).join("").split("\n");
    const lines = this.text.split("\n").map((line, i) => (i === 0 ? prompt : continuation) + show(line));
    const cursorLine = before.length - 1;
    const cursorColumn = displayWidth(cursorLine === 0 ? prompt : continuation) + displayWidth(show(before[cursorLine]));
    return { lines, cursorLine, cursorColumn };
  }
}

/**
 * Strg+C: läuft eine Antwort, stoppt der erste Druck sie. Ohne laufende
 * Antwort zeigt er nur einen Hinweis, der Entwurf bleibt. Ein zweiter Druck
 * innerhalb von windowMs beendet tybo, egal ob eine Antwort läuft.
 */
export class InterruptGate {
  private last = -Infinity;

  constructor(
    private readonly windowMs = 2000,
    private readonly now: () => number = Date.now
  ) {}

  press(running: boolean): "stop" | "exit" | "hint" {
    const t = this.now();
    if (t - this.last <= this.windowMs) {
      this.last = -Infinity;
      return "exit";
    }
    this.last = t;
    return running ? "stop" : "hint";
  }
}
