/**
 * Eingaben für `tybo setup` (Issue #65): eine Zeile lesen, geheime Werte
 * ohne Echo.
 *
 * - Terminal (TTY mit Raw-Modus): tybo liest Taste für Taste und zeigt
 *   sichtbare Eingaben selbst an; bei geheimen Feldern erscheint nichts,
 *   auch keine Sternchen (die Länge bleibt so verborgen). Strg+C bricht ab,
 *   Strg+D auf leerer Zeile ebenso. Der Raw-Modus gilt nur während einer
 *   Frage und wird danach immer zurückgestellt, auch beim Abbruch.
 * - Pipe oder Datei: zeilenweise, ohne jede Escape-Sequenz; Ende der Eingabe
 *   bricht ab. Eine Pipe zeigt ohnehin nichts an.
 */

import { StringDecoder } from "node:string_decoder";
import { terminalModes, type TerminalInput, type TerminalOutput } from "../terminal/app";

/** Abbruch der Einrichtung (Strg+C, Ende der Eingabe) */
export class SetupAbort extends Error {
  constructor(message = "Abgebrochen") {
    super(message);
    this.name = "SetupAbort";
  }
}

export interface AskOptions {
  /** Ohne Echo lesen */
  secret?: boolean;
}

export interface Prompter {
  /** Liest eine Zeile; wirft SetupAbort bei Strg+C oder Ende der Eingabe */
  ask(question: string, options?: AskOptions): Promise<string>;
  /** Bricht eine laufende Frage ab (Strg+C als Signal) */
  cancel?(): void;
  close?(): void;
}

interface Pending {
  resolve(line: string): void;
  reject(e: Error): void;
  secret: boolean;
  raw: boolean;
  line: string;
}

/** Nur druckbare Zeichen anzeigen, keine Steuerzeichen aus der Eingabe */
function printable(ch: string): boolean {
  const code = ch.codePointAt(0) ?? 0;
  return code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code < 0xa0);
}

export function createTerminalPrompter(stdin: TerminalInput, stdout: TerminalOutput): Required<Prompter> {
  let buffer = "";
  let ended = false;
  let skipLf = false;
  // Angefangene Escape-Folge: nach ESC ("esc") oder nach ESC+[ bzw. ESC+O ("seq")
  let escape: "none" | "esc" | "seq" = "none";
  let pending: Pending | null = null;
  // Zustandsbehaftet: ein Umlaut oder Emoji kann auf zwei Pakete verteilt ankommen
  const decoder = new StringDecoder("utf8");

  const useRaw = () => !!stdin.isTTY && typeof stdin.setRawMode === "function";

  function finish(result: { line: string } | { error: Error }) {
    const p = pending;
    if (!p) return;
    pending = null;
    if (p.raw) {
      try {
        stdin.setRawMode?.(false);
      } catch {
        // Terminal schon weg
      }
      terminalModes.rawMode = false;
    }
    // Aus einer Pipe erscheint die Eingabe nicht; ohne Zeilenumbruch klebte die nächste Zeile an der Frage
    if (!p.raw && !stdin.isTTY) stdout.write("\n");
    stdin.pause?.();
    if ("line" in result) p.resolve(result.line);
    else p.reject(result.error);
  }

  function pumpRaw(p: Pending) {
    const chars = [...buffer];
    let i = 0;
    for (; i < chars.length && pending === p; i++) {
      const ch = chars[i];
      if (skipLf) {
        skipLf = false;
        if (ch === "\n") continue;
      }
      // Escape-Folgen (Pfeiltasten usw.) überspringen, auch über Paketgrenzen
      // hinweg. Steuerzeichen (Strg+C, Enter) beenden eine angefangene Folge
      // und wirken normal.
      if (escape !== "none" && ch.charCodeAt(0) >= 0x20) {
        if (escape === "esc") {
          escape = ch === "[" || ch === "O" ? "seq" : "none";
          if (escape === "seq") continue;
        } else {
          if (/[@-~]/.test(ch)) escape = "none";
          continue;
        }
      } else {
        escape = "none";
      }
      if (ch === "\x03") {
        stdout.write("\n");
        buffer = chars.slice(i + 1).join("");
        finish({ error: new SetupAbort() });
        return;
      }
      if (ch === "\x04") {
        if (p.line === "") {
          stdout.write("\n");
          buffer = chars.slice(i + 1).join("");
          finish({ error: new SetupAbort("Eingabe beendet") });
          return;
        }
        continue;
      }
      if (ch === "\r" || ch === "\n") {
        skipLf = ch === "\r";
        stdout.write("\n");
        buffer = chars.slice(i + 1).join("");
        finish({ line: p.line });
        return;
      }
      if (ch === "\x7f" || ch === "\b") {
        const cps = [...p.line];
        if (cps.length) {
          cps.pop();
          p.line = cps.join("");
          if (!p.secret) stdout.write("\b \b");
        }
        continue;
      }
      if (ch === "\x15") {
        if (!p.secret) stdout.write("\b \b".repeat([...p.line].length));
        p.line = "";
        continue;
      }
      if (ch === "\x1b") {
        escape = "esc";
        continue;
      }
      if (!printable(ch)) continue;
      p.line += ch;
      if (!p.secret) stdout.write(ch);
    }
    buffer = chars.slice(i).join("");
  }

  function pumpLines(p: Pending) {
    const m = /\r?\n/.exec(buffer);
    if (m) {
      const line = buffer.slice(0, m.index);
      buffer = buffer.slice(m.index + m[0].length);
      finish({ line });
      return;
    }
    if (ended) {
      if (buffer) {
        const line = buffer;
        buffer = "";
        finish({ line });
      } else {
        finish({ error: new SetupAbort("Eingabe beendet") });
      }
    }
  }

  function pump() {
    const p = pending;
    if (!p) return;
    if (p.raw) {
      pumpRaw(p);
      if (pending === p && ended) finish({ error: new SetupAbort("Eingabe beendet") });
    } else {
      pumpLines(p);
    }
  }

  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
    pump();
  };
  const onEnd = () => {
    buffer += decoder.end();
    ended = true;
    pump();
  };
  stdin.on("data", onData);
  stdin.on("end", onEnd);
  stdin.pause?.();

  return {
    ask(question, options = {}) {
      if (pending) return Promise.reject(new Error("Es läuft schon eine Frage"));
      stdout.write(question);
      return new Promise<string>((resolve, reject) => {
        const raw = useRaw();
        pending = { resolve, reject, secret: !!options.secret, raw, line: "" };
        if (raw) {
          stdin.setRawMode!(true);
          terminalModes.rawMode = true;
        }
        stdin.resume?.();
        pump();
      });
    },
    cancel() {
      if (!pending) return;
      stdout.write("\n");
      finish({ error: new SetupAbort() });
    },
    close() {
      if (pending) finish({ error: new SetupAbort() });
      stdin.off?.("data", onData);
      stdin.off?.("end", onEnd);
      stdin.pause?.();
    },
  };
}
