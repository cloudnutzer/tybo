/**
 * Issue #327, Aufgabe 1: Vertrag des Telegram-Formatierers, netzfrei. Hält
 * fest, was markdownToTelegramHTML, escapeHtml, stripHtmlTags und
 * chunkForTelegram heute liefern; der neue Formatierer
 * (src/channels/telegram/format.ts) muss dasselbe liefern. Die Themen folgen
 * der früheren Sendeprobe (heute bun run test:tools --telegram), mit eigenen Eingaben.
 */
import { describe, expect, test } from "bun:test";
import { renderTelegram } from "../src/channels/telegram/format";
import { chunkForTelegram, escapeHtml, markdownToTelegramHTML, stripHtmlTags } from "../src/lib/telegram";

describe("markdownToTelegramHTML", () => {
  test("fett, kursiv und Inline-Code", () => {
    expect(markdownToTelegramHTML("Das ist **wichtig**, *eher leise* und `npm test`.")).toBe(
      "Das ist <b>wichtig</b>, <i>eher leise</i> und <code>npm test</code>."
    );
  });

  test("Unterstriche in Bezeichnern bleiben Text", () => {
    expect(markdownToTelegramHTML("Setze max_retry_count und lies user_id aus __init__.py")).toBe(
      "Setze max_retry_count und lies user_id aus __init__.py"
    );
    expect(markdownToTelegramHTML("Feld `created_at` in snake_case")).toBe("Feld <code>created_at</code> in snake_case");
  });

  test("Codeblock: <, > und & maskiert, kein weiteres Markdown, Sprachkennung als class", () => {
    const md = "Beispiel:\n```rust\nif a < b && c > d { **x** }\nlet s = \"<p>\";\n```\nfertig";
    expect(markdownToTelegramHTML(md)).toBe(
      'Beispiel:\n<pre><code class="language-rust">if a &lt; b &amp;&amp; c &gt; d { **x** }\nlet s = "&lt;p&gt;";</code></pre>\nfertig'
    );
  });

  test("Codeblock ohne Sprachkennung: ohne class; genau ein Zeilenumbruch am Ende fällt weg", () => {
    expect(markdownToTelegramHTML("```\n  eingerückt\n\n\tTab\n\n```")).toBe("<pre><code>  eingerückt\n\n\tTab\n</code></pre>");
  });

  test("Überschriften werden fett", () => {
    expect(markdownToTelegramHTML("# Haupt\n## Unter\n###### Tief\nText")).toBe("<b>Haupt</b>\n<b>Unter</b>\n<b>Tief</b>\nText");
  });

  test("aufeinanderfolgende Zitatzeilen werden ein blockquote", () => {
    expect(markdownToTelegramHTML("Davor\n> erste Zeile\n> zweite & dritte\nDanach")).toBe(
      "Davor\n<blockquote>erste Zeile\nzweite &amp; dritte</blockquote>Danach"
    );
  });

  test("Durchstreichung", () => {
    expect(markdownToTelegramHTML("Preis: ~~20 Euro~~ 15 Euro")).toBe("Preis: <s>20 Euro</s> 15 Euro");
  });

  test("Links, auch mit Unterstrichen in Text und Adresse", () => {
    expect(markdownToTelegramHTML("Siehe [die_doku](https://example.org/my_page_v2) und [Start](https://example.org)")).toBe(
      'Siehe <a href="https://example.org/my_page_v2">die_doku</a> und <a href="https://example.org">Start</a>'
    );
  });

  test("Trennlinie fällt weg, mehr als eine Leerzeile wird eine", () => {
    expect(markdownToTelegramHTML("oben\n\n---\n\nunten")).toBe("oben\n\nunten");
  });

  test("gemischte Antwort", () => {
    const md = [
      "## Ergebnis",
      "",
      "Ich habe **drei** Dateien geprüft:",
      "",
      "- `src/a.ts`: *ok*",
      "- `src/b_c.ts`: ~~kaputt~~ repariert",
      "",
      "```ts",
      "const ok = a < 3 && b > 1;",
      "```",
      "",
      "> Hinweis: Tests & Doku folgen.",
      "",
      "Mehr in [der Anleitung](https://example.org/how_to).",
    ].join("\n");
    expect(markdownToTelegramHTML(md)).toBe(
      [
        "<b>Ergebnis</b>",
        "",
        "Ich habe <b>drei</b> Dateien geprüft:",
        "",
        "- <code>src/a.ts</code>: <i>ok</i>",
        "- <code>src/b_c.ts</code>: <s>kaputt</s> repariert",
        "",
        '<pre><code class="language-ts">const ok = a &lt; 3 &amp;&amp; b &gt; 1;</code></pre>',
        "",
        "<blockquote>Hinweis: Tests &amp; Doku folgen.</blockquote>",
        'Mehr in <a href="https://example.org/how_to">der Anleitung</a>.',
      ].join("\n")
    );
  });

  test("leere und nur aus Leerraum bestehende Eingabe ergibt leeren Text", () => {
    expect(markdownToTelegramHTML("")).toBe("");
    expect(markdownToTelegramHTML("  \n\n \t")).toBe("");
  });
});

describe("escapeHtml", () => {
  test("nur &, < und >", () => {
    expect(escapeHtml(`a < b > c & "d" 'e'`)).toBe(`a &lt; b &gt; c &amp; "d" 'e'`);
    expect(escapeHtml("&amp;")).toBe("&amp;amp;");
  });
});

describe("stripHtmlTags", () => {
  test("Tags weg, Inhalt bleibt, Entities zurück", () => {
    expect(stripHtmlTags('<b>fett</b> <a href="https://x.y">Link</a> &lt;tag&gt; &amp; mehr')).toBe("fett Link <tag> & mehr");
  });

  test("doppelt maskiert wird einmal zurückgewandelt", () => {
    expect(stripHtmlTags("&amp;lt; &amp;amp;")).toBe("&lt; &amp;");
  });

  test("Umkehrung von escapeHtml", () => {
    const text = "if (a < b && b > c) { return '&'; }";
    expect(stripHtmlTags(escapeHtml(text))).toBe(text);
  });
});

describe("chunkForTelegram (Klartext-Teilung)", () => {
  test("leer ergibt keine Teile, kurz genau einen", () => {
    expect(chunkForTelegram("")).toEqual([]);
    expect(chunkForTelegram("kurz")).toEqual(["kurz"]);
    expect(chunkForTelegram("x".repeat(4000))).toEqual(["x".repeat(4000)]);
  });

  test("Stufe 1: an der Leerzeile, die Leerzeile fällt weg", () => {
    const a = "a".repeat(3000);
    const b = "b".repeat(2000);
    expect(chunkForTelegram(`${a}\n\n${b}`)).toEqual([a, b]);
  });

  test("Stufe 2: am Zeilenumbruch, wenn keine Leerzeile passt", () => {
    const a = "a".repeat(3000);
    const b = "b".repeat(2000);
    expect(chunkForTelegram(`${a}\n${b}`)).toEqual([a, b]);
  });

  test("Stufe 3: am Leerzeichen", () => {
    const a = "a".repeat(3000);
    const b = "b".repeat(2000);
    expect(chunkForTelegram(`${a} ${b}`)).toEqual([a, b]);
  });

  test("Stufe 4: harter Schnitt nach maxLength", () => {
    const text = "z".repeat(9000);
    expect(chunkForTelegram(text)).toEqual(["z".repeat(4000), "z".repeat(4000), "z".repeat(1000)]);
  });

  test("Grenze 30 %: eine Leerzeile zu weit vorn zählt nicht, die nächste Stufe greift", () => {
    // Leerzeile bei 1000 (unter 30 % von 4000), Leerzeichen bei 3500
    const text = `${"a".repeat(1000)}\n\n${"b".repeat(2498)} ${"c".repeat(2000)}`;
    const chunks = chunkForTelegram(text);
    expect(chunks).toEqual([`${"a".repeat(1000)}\n\n${"b".repeat(2498)}`, "c".repeat(2000)]);
  });

  test("eigene Grenze; jeder Teil höchstens so lang", () => {
    const text = Array.from({ length: 50 }, (_, i) => `Zeile ${i} mit etwas Text`).join("\n");
    const chunks = chunkForTelegram(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join("\n")).toBe(text);
  });
});

describe("Kurz-Vertrag renderTelegram", () => {
  const SHORT = [
    "Das ist **wichtig**, *eher leise* und `npm test`.",
    "```rust\nif a < b && c > d {}\n```",
    "# Titel\n\n> Zitat\n\n| Name | Wert |\n|---|---|\n| a | 1 |",
    "Sieh ![Bild](https://a.b/geheim) und [Link](https://ok.example)",
    "x".repeat(4000),
  ];

  test("HTML höchstens max lang: genau [markdownToTelegramHTML(md)]", () => {
    for (const md of SHORT) expect({ md, parts: renderTelegram(md) }).toEqual({ md, parts: [markdownToTelegramHTML(md)] });
    expect(renderTelegram("abc", 100)).toEqual(["abc"]);
  });

  test("leer oder nur Leerraum (auch nach der Bereinigung): []", () => {
    expect(renderTelegram("")).toEqual([]);
    expect(renderTelegram(" \n\t ")).toEqual([]);
    expect(renderTelegram("​⁠")).toEqual([]);
    expect(renderTelegram("---")).toEqual([]);
  });
});

describe("Importzyklus format.ts und telegram.ts", () => {
  // Beide Module importieren einander; keines darf beim Laden etwas aus dem anderen brauchen
  for (const first of ["../src/channels/telegram/format.ts", "../src/lib/telegram.ts"]) {
    test(`zuerst ${first.split("/").pop()} geladen: beide Einstiege funktionieren`, () => {
      const script = [
        `await import(${JSON.stringify(new URL(first, import.meta.url).pathname)});`,
        `const f = await import(${JSON.stringify(new URL("../src/channels/telegram/format.ts", import.meta.url).pathname)});`,
        `const t = await import(${JSON.stringify(new URL("../src/lib/telegram.ts", import.meta.url).pathname)});`,
        'console.log(JSON.stringify([f.renderTelegram("**a** | b"), t.markdownToTelegramHTML("**a**")]));',
      ].join("\n");
      const run = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
      expect(run.stderr.toString()).toBe("");
      expect(JSON.parse(run.stdout.toString())).toEqual([["<b>a</b> | b"], "<b>a</b>"]);
    });
  }
});
