/**
 * Issue #60, Schritt 3: Markdown im Terminal (src/terminal/render.ts), Nachrichten
 * und Kopfzeile (src/terminal/view.ts), Bereinigung (src/terminal/sanitize.ts).
 * Mit NO_COLOR oder ohne TTY: keine einzige Escape-Sequenz. HTML bleibt Text.
 */
import { describe, expect, test } from "bun:test";
import type { Message } from "../src/terminal/api";
import { createStyle, renderTerminalMarkdown, stripStyle, wantsColor } from "../src/terminal/render";
import { sanitizeLine, sanitizeTerminal } from "../src/terminal/sanitize";
import { formatMessage, headerLine, progressLabel } from "../src/terminal/view";

const plain = createStyle(false);
const color = createStyle(true);

const SAMPLE = [
  "# Überschrift & mehr",
  "",
  "Absatz mit **fett**, *kursiv*, ~~weg~~, `code` und [Link](https://tybo.ai/x).",
  "",
  "- eins",
  "  - verschachtelt",
  "- [x] erledigt",
  "",
  "1. erstens",
  "2. zweitens",
  "",
  "> Zitat",
  "",
  "```ts",
  "const a = 1 < 2;",
  "```",
  "",
  "| Name | Wert |",
  "|---|---|",
  "| a | 10 |",
  "",
  "---",
].join("\n");

describe("NO_COLOR / kein TTY: schlichter Text", () => {
  test("wantsColor: nur mit TTY, ohne NO_COLOR, nicht bei TERM=dumb", () => {
    expect(wantsColor({}, true)).toBe(true);
    expect(wantsColor({}, false)).toBe(false);
    expect(wantsColor({ NO_COLOR: "1" }, true)).toBe(false);
    expect(wantsColor({ NO_COLOR: "" }, true)).toBe(true);
    expect(wantsColor({ TERM: "dumb" }, true)).toBe(false);
  });

  test("Markdown ohne ein einziges ESC-Zeichen, Struktur bleibt lesbar", () => {
    const out = renderTerminalMarkdown(SAMPLE, plain);
    expect(out).not.toContain("\u001b");
    expect(out).toBe(
      [
        "Überschrift & mehr",
        "==================",
        "",
        "Absatz mit fett, kursiv, ~~weg~~, `code` und Link (https://tybo.ai/x).",
        "",
        "- eins",
        "  - verschachtelt",
        "- [x] erledigt",
        "",
        "1. erstens",
        "2. zweitens",
        "",
        "> Zitat",
        "",
        "    const a = 1 < 2;",
        "",
        "Name | Wert",
        "-----+-----",
        "a    | 10",
        "",
        "------------------------",
      ].join("\n")
    );
  });

  test("Nachrichten und Kopfzeile ohne Escape-Sequenzen", () => {
    const m: Message = { id: "1", role: "assistant", text: "**x**", copyText: "**x**", createdAt: "2026-09-24T10:00:00.000Z", agent: "research", model: "claude-opus-5-5", durationMs: 8000 };
    const out = formatMessage(m, plain) + headerLine({ id: "topic-7", title: "Archiv", agent: "cto", kind: "topic", closed: true }, plain);
    expect(out).not.toContain("\u001b");
    expect(out).toContain("Research");
    expect(out).toContain("claude-opus-5-5 · 8,0 s");
    expect(out).toContain("tybo · Archiv · Agent CTO · geschlossen, nur lesen");
  });
});

describe("mit Farbe", () => {
  test("Fett, Kursiv, Überschrift und Code als Terminal-Attribute, keine Markdown-Zeichen", () => {
    const out = renderTerminalMarkdown("## Titel\n\n**fett** *kursiv* `code`", color);
    expect(out).toContain("\u001b[1mfett\u001b[22m");
    expect(out).toContain("\u001b[3mkursiv\u001b[23m");
    expect(out).toContain("\u001b[33mcode\u001b[39m");
    expect(stripStyle(out)).toBe("Titel\n\nfett kursiv code");
  });

  test("Links als Text mit Adresse, Bilder werden nicht geladen, nur beschrieben", () => {
    const out = stripStyle(renderTerminalMarkdown("[Seite](https://a.de) <https://b.de> ![Logo](https://c.de/l.png)", color));
    expect(out).toBe("Seite (https://a.de) https://b.de [Bild: Logo] (https://c.de/l.png)");
  });

  test("Tabellen: Spalten auf gleiche Breite, auch mit Umlauten", () => {
    const out = stripStyle(renderTerminalMarkdown("| Stadt | Grad |\n|---|---|\n| Köln | 21 |\n| Bad Tölz | 9 |", color));
    expect(out.split("\n")).toEqual(["Stadt    │ Grad", "─────────┼─────", "Köln     │ 21", "Bad Tölz │ 9"]);
  });
});

describe("HTML bleibt Text, nichts wird interpretiert", () => {
  test("Inline- und Block-HTML erscheinen wörtlich", () => {
    for (const style of [plain, color]) {
      const out = stripStyle(renderTerminalMarkdown('Vor <b onclick="x">fett?</b> nach\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>', style));
      expect(out).toContain('Vor <b onclick="x">fett?</b> nach');
      expect(out).toContain("<script>alert(1)</script>");
      expect(out).toContain("<img src=x onerror=alert(1)>");
    }
  });

  test("Zeichenreferenzen wie im Browser als Zeichen, aber keine Steuerzeichen daraus", () => {
    const out = renderTerminalMarkdown("A &amp; B &lt;i&gt; &#x1b;[31mrot &#27;]0;x", plain);
    // Die entstandenen Sequenzen fallen samt Inhalt weg, statt das Terminal zu steuern
    expect(out).toBe("A & B <i> rot ");
    expect(out).not.toContain("\u001b");
  });
});

describe("Terminal-Steuerzeichen entschärfen", () => {
  test("ANSI/CSI, OSC (Titel, Zwischenablage, Hyperlinks), DCS, C1 und Bidi fallen weg", () => {
    const evil = [
      "a\u001b[31mb\u001b[0m",
      "\u001b]0;Titel\u0007",
      "\u001b]52;c;Ym9lc2U=\u001b\\",
      "\u001b]8;;https://boese.example\u001b\\Link\u001b]8;;\u001b\\",
      "\u001bP1$r\u001b\\",
      "\u009b2J",
      "\u0007\u0008\u007f",
      "‮umgedreht",
      "c\r\nd\re",
    ].join("");
    const clean = sanitizeTerminal(evil);
    expect(clean).toBe("abLinkumgedrehtc\nde");
    expect(clean).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/);
  });

  test("abgeschnittene Sequenz am Textende wird ebenfalls entfernt", () => {
    expect(sanitizeTerminal("x\u001b]0;ohne Ende")).toBe("x");
    expect(sanitizeTerminal("x\u001b[")).toBe("x");
  });

  test("einzeilige Angaben: Umbrüche und Tabs werden zu Leerzeichen", () => {
    expect(sanitizeLine(" Topic\n\tName\u001b[2J ")).toBe("Topic Name");
  });

  test("Nachrichtentext, Agent und Fortschritt laufen durch die Bereinigung", () => {
    const m: Message = { id: "1", role: "user", text: "hi\u001b]0;x\u0007", createdAt: "2026-09-24T10:00:00.000Z" };
    expect(formatMessage(m, color)).not.toContain("\u001b]");
    expect(progressLabel("tool", "\u001b[2JBash")).toBe("Führt einen Befehl aus …");
    expect(progressLabel("tool", "mcp__notion__search")).toBe("Nutzt notion …");
    expect(progressLabel("snippet", "\u001b[2Jegal")).toBe("Formuliert die Antwort …");
  });

  test("Antworten aus copyText; ohne copyText ohne Steuer-Tags", () => {
    const m: Message = { id: "1", role: "assistant", text: "Hallo [REMEMBER: geheim]", createdAt: "2026-09-24T10:00:00.000Z" };
    expect(formatMessage(m, plain)).not.toContain("REMEMBER");
    const withCopy: Message = { ...m, copyText: "Aus copyText" };
    expect(formatMessage(withCopy, plain)).toContain("Aus copyText");
  });
});

describe("Rückfragen als nummerierte Auswahl (Issue #120)", () => {
  const base: Message = { id: "q1", role: "assistant", kind: "notice", source: "freigabe", text: "**Strategy** möchte `Write` ausführen", createdAt: "2026-09-26T10:00:00.000Z" };
  const options = [
    { key: "ok", label: "Erlauben" },
    { key: "no", label: "Ablehnen" },
  ];

  test("offene Rückfrage: Optionen nummeriert unter der Nachricht", () => {
    const out = formatMessage({ ...base, choice: { id: "Frage000001", state: "open", options } }, plain);
    expect(out.split("\n").at(-1)).toBe("[1] Erlauben  [2] Ablehnen");
  });

  test("drei Optionen, mit Farbe fett nummeriert", () => {
    const three = [...options, { key: "all", label: "Immer erlauben" }];
    const out = formatMessage({ ...base, choice: { id: "Frage000001", state: "open", options: three } }, color);
    expect(stripStyle(out).split("\n").at(-1)).toBe("[1] Erlauben  [2] Ablehnen  [3] Immer erlauben");
    expect(out).toContain("\u001b[1m[1]");
  });

  test("erledigt: Knopf und Kanal statt Optionen", () => {
    const done = (via: "telegram" | "web" | "terminal") =>
      formatMessage({ ...base, choice: { id: "Frage000001", state: "done", options: [], result: { key: "ok", label: "Erlauben", via, at: "2026-09-26T10:01:00.000Z" } } }, plain).split("\n").at(-1);
    expect(done("telegram")).toBe("Erledigt: Erlauben · in Telegram");
    expect(done("web")).toBe("Erledigt: Erlauben · im Browser");
    expect(done("terminal")).toBe("Erledigt: Erlauben · im Terminal");
  });

  test("abgelaufen, Kopie aus anderem Gespräch und Frage ohne Knöpfe hier", () => {
    expect(formatMessage({ ...base, choice: { id: "Frage000001", state: "expired", options: [] } }, plain).split("\n").at(-1)).toBe("Abgelaufen");
    const copy = formatMessage({ ...base, choice: { id: "Frage000001", state: "open", options: [], elsewhere: "0b8f" } }, plain);
    expect(copy.split("\n").at(-1)).toBe("Antwort im Gespräch, aus dem die Frage kommt.");
    expect(copy).not.toContain("[1]");
    expect(formatMessage({ ...base, choice: { id: "Frage000001", state: "open", options: [] } }, plain).split("\n").at(-1)).toBe("Antwort in Telegram.");
  });

  test("ohne Rückfrage keine Zusatzzeile, unvollständige Daten werden ignoriert", () => {
    expect(formatMessage(base, plain).split("\n")).toHaveLength(2);
    const broken = { ...base, choice: { id: "Frage000001", state: "komisch", options } } as unknown as Message;
    expect(formatMessage(broken, plain)).not.toContain("[1]");
    const badOptions = { ...base, choice: { id: "Frage000001", state: "open", options: [{ key: "ok" }, { key: "", label: "leer" }] } } as unknown as Message;
    expect(formatMessage(badOptions, plain).split("\n").at(-1)).toBe("Antwort in Telegram.");
  });

  test("Beschriftungen laufen durch sanitizeLine: keine Steuerzeichen, keine Umbrüche", () => {
    const evil = [
      { key: "ok", label: "Er\u001b]0;Titel\u0007lau\nben" },
      { key: "no", label: "\u001b[2JAb‮lehnen" },
    ];
    const out = formatMessage({ ...base, choice: { id: "Frage000001", state: "open", options: evil } }, color);
    expect(stripStyle(out).split("\n").at(-1)).toBe("[1] Erlau ben  [2] Ablehnen");
    expect(out).not.toContain("\u001b]");
    expect(out).not.toContain("\u001b[2J");
    const done = formatMessage({ ...base, choice: { id: "Frage000001", state: "done", options: [], result: { key: "ok", label: "Ja\u001b[31m\nwirklich", via: "telegram", at: "" } } }, plain);
    expect(done.split("\n").at(-1)).toBe("Erledigt: Ja wirklich · in Telegram");
  });
});
