/**
 * Zeilenleser für die JSON-Zeilen der Motoren (Claude stream-json, Codex,
 * OpenCode). Eine Zeile, die über mehrere Chunks kommt, ein UTF-8-Zeichen,
 * das zwischen zwei Chunks geteilt ist, und eine letzte Zeile ohne
 * Zeilenumbruch (end) kommen jeweils vollständig an.
 */

export interface LineReader {
  push(chunk: Uint8Array): void;
  end(): void;
}

export function createLineReader(onLine: (line: string) => void): LineReader {
  const decoder = new TextDecoder();
  let pending = "";
  /** Gibt alle vollständigen Zeilen weiter und liefert den unvollständigen Rest */
  const emitComplete = (text: string): string => {
    let from = 0;
    for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", from)) {
      onLine(text.slice(from, nl));
      from = nl + 1;
    }
    return text.slice(from);
  };
  return {
    push(chunk) {
      pending = emitComplete(pending + decoder.decode(chunk, { stream: true }));
    },
    end() {
      const last = pending + decoder.decode();
      pending = "";
      if (last) onLine(last);
    },
  };
}
