/**
 * Issue #60, Schritt 4: Eingabe von tybo ohne echtes Terminal
 * (src/terminal/editor.ts): Tasten aus Terminal-Bytes, Mehrzeilen, Verlauf der
 * eigenen Eingaben, Einfügen und das Zeitfenster für zweimal Strg+C.
 */
import { describe, expect, test } from "bun:test";
import { InterruptGate, KeyDecoder, LineEditor, type EditorAction } from "../src/terminal/editor";

/** Tippt Bytes in einen frischen oder gegebenen Editor, gibt alle Aktionen zurück */
function type(data: string | string[], editor = new LineEditor(), decoder = new KeyDecoder()) {
  const actions: EditorAction[] = [];
  for (const chunk of Array.isArray(data) ? data : [data]) {
    for (const key of decoder.push(chunk)) actions.push(editor.handle(key));
  }
  return { editor, actions, submitted: actions.filter(a => a.type === "submit").map(a => (a as { text: string }).text) };
}

const UP = "\u001b[A";
const DOWN = "\u001b[B";
const LEFT = "\u001b[D";

describe("Tasten aus Terminal-Bytes", () => {
  test("Buchstaben, Enter, Backspace, Pfeile, Pos1/Ende, Entf, Strg-Tasten", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("ab\r\u007f\u001b[A\u001b[B\u001b[C\u001b[D\u001b[H\u001b[F\u001bOH\u001b[3~\u0001\u0005\u0015\u0017\u0003\u0004").map(k => k.type)).toEqual([
      "char", "enter", "backspace", "up", "down", "right", "left", "home", "end", "home", "delete", "home", "end", "clear", "delete-word", "ctrl-c", "ctrl-d",
    ]);
  });

  test("Alt+Enter (ESC + Enter) ist eine neue Zeile", () => {
    expect(new KeyDecoder().push("\u001b\r").map(k => k.type)).toEqual(["newline"]);
  });

  test("Escape-Sequenz über zwei Blöcke geteilt", () => {
    const decoder = new KeyDecoder();
    expect(decoder.push("\u001b")).toEqual([]);
    expect(decoder.push("[")).toEqual([]);
    expect(decoder.push("A").map(k => k.type)).toEqual(["up"]);
  });

  test("Bracketed Paste: mehrzeiliger Text als ein Stück, auch geteilt; Steuerzeichen fallen weg", () => {
    const decoder = new KeyDecoder();
    const keys = [...decoder.push("\u001b[200~Zeile 1\r\nZei"), ...decoder.push("le 2\u001b[31m\u001b[20"), ...decoder.push("1~x")];
    expect(keys).toEqual([
      { type: "paste", text: "Zeile 1\nZeile 2[31m" },
      { type: "char", text: "x" },
    ]);
  });

  test("Umlaute und Emoji bleiben ganz", () => {
    const { editor } = type(["Grüße 👋", LEFT, "\u007f"]);
    expect(editor.text).toBe("Grüße👋");
  });
});

describe("Senden und Mehrzeilen", () => {
  test("Enter sendet den Text, danach ist die Eingabe leer", () => {
    const { editor, submitted } = type("Hallo\r");
    expect(submitted).toEqual(["Hallo"]);
    expect(editor.text).toBe("");
  });

  test("leere oder nur Leerraum: Enter sendet nichts", () => {
    expect(type("   \r").submitted).toEqual([]);
  });

  test("Alt+Enter fügt einen Zeilenumbruch ein", () => {
    expect(type("eins\u001b\rzwei\r").submitted).toEqual(["eins\nzwei"]);
  });

  test("\\ am Zeilenende, dann Enter: neue Zeile statt senden, der Backslash verschwindet", () => {
    const { submitted, editor } = type(["eins\\", "\r"]);
    expect(submitted).toEqual([]);
    expect(editor.text).toBe("eins\n");
    expect(type("eins\\\rzwei\r").submitted).toEqual(["eins\nzwei"]);
  });

  test("\\ mitten im Text sendet normal", () => {
    expect(type("C:\\Pfad\r").submitted).toEqual(["C:\\Pfad"]);
    expect(type(["a\\b", LEFT, "\r"]).submitted).toEqual(["a\\b"]);
  });

  test("Eingefügter Text mit Zeilen wird nicht zeilenweise gesendet", () => {
    const { submitted, editor } = type("\u001b[200~erste\nzweite\u001b[201~");
    expect(submitted).toEqual([]);
    expect(editor.text).toBe("erste\nzweite");
  });

  test("Pfeil hoch/runter bewegen in mehrzeiligem Text zwischen den Zeilen", () => {
    const { editor } = type(["abc\u001b\rde", UP, "X"]);
    expect(editor.text).toBe("abXc\nde");
    type([DOWN, "Y"], editor);
    expect(editor.text).toBe("abXc\ndeY");
  });

  test("render: Prompt, Einrückung und Cursorposition", () => {
    const { editor } = type(["ab\u001b\rcd", LEFT]);
    expect(editor.render("› ", "  ")).toEqual({ lines: ["› ab", "  cd"], cursorLine: 1, cursorColumn: 3 });
  });
});

describe("Verlauf der eigenen Eingaben", () => {
  test("Pfeil hoch holt frühere Eingaben, runter zurück bis zum Entwurf", () => {
    const { editor } = type("erste\rzweite\rEntwurf");
    type(UP, editor);
    expect(editor.text).toBe("zweite");
    type(UP, editor);
    expect(editor.text).toBe("erste");
    type(UP, editor);
    expect(editor.text).toBe("erste");
    type(DOWN, editor);
    expect(editor.text).toBe("zweite");
    type(DOWN, editor);
    expect(editor.text).toBe("Entwurf");
  });

  test("gleiche Eingabe direkt hintereinander nur einmal im Verlauf; auch mehrzeilige", () => {
    const { editor } = type("a\ra\rb\u001b\rc\r");
    expect(editor.historyEntries()).toEqual(["a", "b\nc"]);
    type(UP, editor);
    expect(editor.text).toBe("b\nc");
  });

  test("früheren Eintrag holen, ändern und senden", () => {
    const { editor, submitted } = type(["frage\r", UP, " nochmal\r"]);
    expect(submitted).toEqual(["frage", "frage nochmal"]);
    expect(editor.historyEntries()).toEqual(["frage", "frage nochmal"]);
  });

  test("setText stellt einen Entwurf nach einem Fehler wieder her", () => {
    const editor = new LineEditor();
    editor.setText("nicht gesendet");
    expect(editor.text).toBe("nicht gesendet");
    expect(editor.cursorIndex).toBe("nicht gesendet".length);
  });
});

describe("Strg+C und Strg+D", () => {
  test("Strg+C ist interrupt, der Entwurf bleibt", () => {
    const { editor, actions } = type("Entwurf\u0003");
    expect(actions.at(-1)).toEqual({ type: "interrupt" });
    expect(editor.text).toBe("Entwurf");
  });

  test("Strg+D beendet nur bei leerer Eingabe, sonst löscht es das Zeichen unter dem Cursor", () => {
    expect(type("\u0004").actions).toEqual([{ type: "eof" }]);
    const { editor, actions } = type(["ab", LEFT, "\u0004"]);
    expect(actions.at(-1)).toEqual({ type: "none" });
    expect(editor.text).toBe("a");
  });

  test("InterruptGate: während der Antwort stoppen, im Leerlauf Hinweis, zweimal in 2 s beenden", () => {
    let now = 0;
    const gate = new InterruptGate(2000, () => now);
    expect(gate.press(true)).toBe("stop");
    now = 1500;
    expect(gate.press(true)).toBe("exit");
    now = 10_000;
    expect(gate.press(false)).toBe("hint");
    now = 12_001;
    expect(gate.press(false)).toBe("hint");
    now = 13_000;
    expect(gate.press(false)).toBe("exit");
  });
});

describe("Tab (Issue #61)", () => {
  test("getippter Tab allein: Ergänzen am Ende der Eingabe, kein Textzeichen", () => {
    const { editor, actions } = type(["/wec", "\t"]);
    expect(actions.at(-1)).toEqual({ type: "complete" });
    expect(editor.text).toBe("/wec");
  });

  test("Tab mit anderen Tasten in einem Block (schnell getippt): wirkt wie einzeln", () => {
    const together = type("/wec\t");
    const apart = type(["/wec", "\t"]);
    expect(together.actions.at(-1)).toEqual({ type: "complete" });
    expect(together.actions).toEqual(apart.actions);
    expect(together.editor.text).toBe("/wec");
    // Taste nach dem Tab im selben Block
    expect(type("/wec\tx").actions).toEqual(type(["/wec", "\t", "x"]).actions);
  });

  test("ohne Bracketed Paste: Tab ist die Taste, gleich bei jeder Blockteilung", () => {
    // Grenze: unmarkiertes Einfügen ist von Tippen nicht zu unterscheiden
    const bytes = "a\tb";
    const whole = type(bytes);
    expect(whole.editor.text).toBe("ab");
    for (let i = 1; i < bytes.length; i++) {
      const split = type([bytes.slice(0, i), bytes.slice(i)]);
      expect(split.actions).toEqual(whole.actions);
      expect(split.editor.text).toBe("ab");
    }
    expect(type(bytes.split("")).actions).toEqual(whole.actions);
  });

  test("Bracketed Paste mit Tabs, an jeder Stelle geteilt: bleibt Text, keine Ergänzung", () => {
    const bytes = "/we\u001b[200~\ta\tb\t\u001b[201~";
    const expected = "/we\ta\tb\t";
    for (let i = 0; i <= bytes.length; i++) {
      for (let j = i; j <= bytes.length; j++) {
        const chunks = [bytes.slice(0, i), bytes.slice(i, j), bytes.slice(j)].filter(c => c !== "");
        const { editor, actions } = type(chunks);
        expect(actions.some(a => a.type === "complete")).toBe(false);
        expect(editor.text).toBe(expected);
      }
    }
    expect(type(bytes.split("")).editor.text).toBe(expected);
  });

  test("Tab in Bracketed Paste bleibt Text, auch allein", () => {
    const { editor, actions } = type(["\u001b[200~", "\t", "\u001b[201~"]);
    expect(actions.some(a => a.type === "complete")).toBe(false);
    expect(editor.text).toBe("\t");
  });

  test("Tab mit Cursor nicht am Ende oder in mehrzeiliger Eingabe: nichts", () => {
    expect(type(["/wec", LEFT, "\t"]).actions.at(-1)).toEqual({ type: "none" });
    expect(type(["a\u001b\rb", "\t"]).actions.at(-1)).toEqual({ type: "none" });
  });
});
