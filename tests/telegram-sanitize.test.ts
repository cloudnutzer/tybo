/**
 * Issue #52: sanitizeModelOutput entschärft Markdown-Bilder und entfernt
 * unsichtbare Zeichen, bevor Modelltext an Telegram geht.
 */
import { describe, expect, test } from "bun:test";
import {
  IMAGE_PLACEHOLDER,
  markdownToTelegramHTML,
  sanitizeModelOutput,
  sanitizeTelegramText,
  stripInvisibleChars,
} from "../src/lib/telegram";

/** Unicode-Tag-Zeichen für "abc": so versteckt eine Injection Text */
const TAG_ABC = "\u{E0061}\u{E0062}\u{E0063}";

describe("Markdown-Bilder", () => {
  test("Inline-Bild wird zum Bildtext ohne Adresse", () => {
    const out = sanitizeModelOutput("Sieh mal: ![x](https://a.b/geheim) fertig");
    expect(out).toBe("Sieh mal: x fertig");
    expect(out).not.toContain("a.b");
  });

  test("leerer Bildtext wird zum Platzhalter", () => {
    expect(sanitizeModelOutput("![](https://a.b/geheim?d=123)")).toBe(IMAGE_PLACEHOLDER);
    expect(sanitizeModelOutput("![  ](https://a.b/x)")).toBe(IMAGE_PLACEHOLDER);
  });

  test("Adresse mit einer Ebene Klammern und Titel", () => {
    expect(sanitizeModelOutput("![Bild](https://a.b/x_(1)/y.png)")).toBe("Bild");
    expect(sanitizeModelOutput('![Bild](https://a.b/y.png "Titel")')).toBe("Bild");
    expect(sanitizeModelOutput("![Bild](<https://a.b/mit leer.png>)")).toBe("Bild");
  });

  test("mehrere Bilder in einem Text", () => {
    expect(sanitizeModelOutput("![a](https://x/1) und ![b](https://x/2)")).toBe("a und b");
  });

  // Präzisierung zu #52: Maßstab ist, was markdownToTelegramHTML zu einem Link
  // machen würde. Referenz-Bilder und Definitionen kennt der Umwandler nicht,
  // Telegram zeigt sie als sichtbaren Text, die Vorschau ist aus.
  test("Referenzbilder und Definitionen bleiben sichtbarer Text", () => {
    const text = "Vorher ![Logo][l] nachher\n\n[l]: https://a.b/geheim";
    expect(sanitizeModelOutput(text)).toBe(text);
    const html = markdownToTelegramHTML(text);
    expect(html).not.toContain("<a ");
    expect(html).toContain("https://a.b/geheim");
  });

  test("Kurzform ohne Definition bleibt Text", () => {
    expect(sanitizeModelOutput("![Achtung] bitte lesen")).toBe("![Achtung] bitte lesen");
  });

  test("Definition eines normalen Links bleibt", () => {
    const text = "Siehe [Doku][d]\n\n[d]: https://example.com/doku";
    expect(sanitizeModelOutput(text)).toBe(text);
  });

  test("mehrzeiliger Bildtext und verschachtelte Bilder", () => {
    expect(sanitizeModelOutput("![Zeile eins\nZeile zwei](https://a.b/geheim)")).toBe("Zeile eins\nZeile zwei");
    expect(sanitizeModelOutput("![a ![b](https://a.b/2) c](https://a.b/1)")).not.toContain("a.b/2");
  });

  test("jedes Bild, das der Umwandler zu einem Link machen würde, ist vorher weg", () => {
    for (const text of [
      "![x](https://a.b/geheim)",
      "vor ![x](https://a.b/((tief))/(x(y(z))).png) nach",
      "![a [b] c](https://a.b/geheim)",
      "![x](https://a.b/geheim\n  \"Titel\nzweite\")",
      "![a ![b](https://a.b/2) c](https://a.b/1)",
      "!![x](https://a.b/geheim)",
    ]) {
      const html = markdownToTelegramHTML(text);
      expect({ text, html }).toEqual({ text, html: html.replace(/!<a\s[^>]*>/g, "") });
    }
  });

  test("normaler Text und Links bleiben unverändert", () => {
    for (const text of [
      "[Doku](https://a.b/doku) 😀 **fett** und `![x](https://a.b/code)`",
      "```\n![x](https://a.b/im-code)\n```",
      "Ausruf! [Link](https://ok.example)",
      "\\![x](https://a.b/maskiert)",
    ]) {
      expect(sanitizeModelOutput(text)).toBe(text);
    }
  });

  test("eingeschobene unsichtbare Zeichen tarnen kein Bild", () => {
    expect(sanitizeModelOutput("!​[x](https://a.b/geheim)")).toBe("x");
    expect(sanitizeModelOutput(`!${TAG_ABC}[x](https://a.b/geheim)`)).toBe("x");
    expect(sanitizeModelOutput("!﻿[x]⁠(https://a.b/geheim)")).toBe("x");
  });

  test("HTML-Variante nach der Umwandlung: !<a> wird Bildtext", () => {
    expect(sanitizeTelegramText('!<a href="https://a.b/geheim">x</a>', true)).toBe("x");
    expect(sanitizeTelegramText('!<a href="https://a.b/geheim"></a>', true)).toBe(IMAGE_PLACEHOLDER);
    // Klartext zeigt Telegram wörtlich: nur unsichtbare Zeichen weg (Präzisierung, Runde 14)
    expect(sanitizeTelegramText('!<a href="https://a.b/geheim">x</a>​')).toBe('!<a href="https://a.b/geheim">x</a>');
  });
});

describe("Links und Formatierung bleiben", () => {
  test("normaler Link bleibt als Text mit Adresse", () => {
    const text = "Mehr unter [Anthropic](https://www.anthropic.com) und https://example.com.";
    expect(sanitizeModelOutput(text)).toBe(text);
  });

  test("Formatierung, Code, Listen und Umlaute unverändert", () => {
    const text = "**fett** *kursiv* ~~weg~~ `code`\n\n```ts\nconst a = 1;\n```\n\n- Punkt\n> Zitat\nÄÖÜß 😀";
    expect(sanitizeModelOutput(text)).toBe(text);
  });

  test("markdownToTelegramHTML: Link bleibt Link, Bild verliert Adresse", () => {
    const html = markdownToTelegramHTML("**A** [Link](https://ok.example) ![x](https://a.b/geheim)");
    expect(html).toBe('<b>A</b> <a href="https://ok.example">Link</a> x');
  });

  test("leerer Text bleibt leer", () => {
    expect(sanitizeModelOutput("")).toBe("");
  });
});

describe("unsichtbare Zeichen", () => {
  test("Tag-Zeichen fallen weg", () => {
    expect(sanitizeModelOutput(`Hallo${TAG_ABC}\u{E0001}\u{E007F} Welt`)).toBe("Hallo Welt");
  });

  test("Zero-Width-Zeichen fallen weg", () => {
    expect(stripInvisibleChars("a​b‌c⁠d﻿e᠎f⁣g")).toBe("abcdefg");
  });

  test("Variation Selectors für Datenschmuggel fallen weg, FE0F bleibt", () => {
    expect(stripInvisibleChars("x︀\u{E0100}\u{E01EF}y")).toBe("xy");
    expect(stripInvisibleChars("❤️")).toBe("❤️");
  });

  test("ZWJ zwischen Emoji bleibt", () => {
    for (const emoji of ["👨‍👩‍👧‍👦", "🏳️‍🌈", "👩🏽‍💻", "🧑‍🚀", "❤️‍🔥"]) {
      expect(sanitizeModelOutput(emoji)).toBe(emoji);
    }
  });

  test("ZWJ außerhalb von Emoji fällt weg", () => {
    expect(stripInvisibleChars("a‍b")).toBe("ab");
    expect(stripInvisibleChars("😀‍b")).toBe("😀b");
    expect(stripInvisibleChars("a‍😀")).toBe("a😀");
    expect(stripInvisibleChars("‍")).toBe("");
  });

  test("Flaggen mit Tag-Zeichen bleiben", () => {
    for (const flag of ["🏴󠁧󠁢󠁥󠁮󠁧󠁿", "🏴󠁧󠁢󠁳󠁣󠁴󠁿", "🏴󠁧󠁢󠁷󠁬󠁳󠁿"]) {
      expect(sanitizeModelOutput(flag)).toBe(flag);
    }
    // Andere Tag-Folgen hinter der schwarzen Flagge sind kein RGI-Emoji
    expect(sanitizeModelOutput(`🏴${TAG_ABC}\u{E007F}`)).toBe("🏴");
  });

  test("vollständig entfernter Inhalt ergibt leeren Text", () => {
    expect(sanitizeModelOutput(`​‌${TAG_ABC}﻿`)).toBe("");
    expect(markdownToTelegramHTML("​⁠")).toBe("");
  });
});

describe("Präzisierung zu #52: Maßstab ist der Telegram-Umwandler (Gegenbeispiele Runde 7)", () => {
  test("doppelte Referenz-Definition in einer Liste: unverändert, kein versteckter Link", () => {
    const text = "1. [r]: https://a.b/geheim\n    [r]: https://a.b/geheim\n\n![x][r]";
    expect(sanitizeModelOutput(text)).toBe(text);
    expect(markdownToTelegramHTML(text)).not.toContain("<a ");
  });

  test("Liste im Zitat mit Tabelle: nur das Bild wird Bildtext, Fettdruck und Blockgrenzen bleiben", () => {
    const text = "> - **Wichtig**\n> - ![Logo](https://a.b/geheim)\n| Name | Wert |\n|---|---|\n| A | B |";
    expect(sanitizeModelOutput(text)).toBe("> - **Wichtig**\n> - Logo\n| Name | Wert |\n|---|---|\n| A | B |");
    const html = markdownToTelegramHTML(text);
    expect(html).toContain("<b>Wichtig</b>");
    expect(html).not.toContain("a.b/geheim");
  });
});

describe("Eigenschaften über Zufallstexte", () => {
  // Kleiner fester Zufallsgenerator, damit Fehlschläge nachstellbar sind
  function rng(seed: number) {
    return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  }
  const PARTS = [
    "![", "]", "(", ")", "[", "!", "\\", "`", "```\n", "\n", " ", "**", "x", "😀", "👨‍👩‍👧", "https://a.b/g",
    "> ", "- ", "1. ", "| a | b |", "\r\n", "<a href=\"https://a.b/h\">y</a>", "text",
  ];

  test("idempotent, Text ohne \"![\" unverändert, im Umwandler-HTML nie ein Bild-Link", () => {
    const next = rng(52);
    for (let i = 0; i < 3000; i++) {
      let text = "";
      const n = 1 + Math.floor(next() * 25);
      for (let k = 0; k < n; k++) text += PARTS[Math.floor(next() * PARTS.length)];
      const once = sanitizeModelOutput(text);
      expect({ text, twice: sanitizeModelOutput(once) }).toEqual({ text, twice: once });
      if (!text.includes("!") && !text.includes("\r")) expect({ text, once }).toEqual({ text, once: text });
      const html = markdownToTelegramHTML(text);
      expect({ text, bildLink: /!<a\s/.test(sanitizeTelegramText(html, true)) }).toEqual({ text, bildLink: false });
    }
  });
});

describe("Runde 8: normaler Link nach Bild mit \"!\", rohe <img>-Tags", () => {
  test("![!](…)[Doku](…): Bildtext und vollständiger Doku-Link bleiben, auch mehrfach bereinigt", () => {
    const text = "![!](https://a.b/geheim)[Doku](https://ok.example/doku)";
    const once = sanitizeModelOutput(text);
    expect(once).toBe("! [Doku](https://ok.example/doku)");
    expect(sanitizeModelOutput(once)).toBe(once);
    expect(sanitizeTelegramText(text)).toBe(text);
    const html = markdownToTelegramHTML(text);
    expect(html).toContain('<a href="https://ok.example/doku">Doku</a>');
    expect(html).not.toContain("a.b/geheim");
  });

  test("verschachteltes Bild: kein neues Bild aus dem Ersatztext", () => {
    const once = sanitizeModelOutput("![a ![b](https://a.b/2) c](https://a.b/1)");
    expect(sanitizeModelOutput(once)).toBe(once);
    expect(markdownToTelegramHTML(once)).not.toMatch(/!<a\s/);
  });

  test("rohes <img> wird im HTML zu alt bzw. [Bild], auch ohne \"!\"; Klartext bleibt wörtlich", () => {
    expect(sanitizeTelegramText('Hallo <img src="https://a.b/geheim" alt="Logo"> Welt', true)).toBe("Hallo Logo Welt");
    expect(sanitizeTelegramText("<IMG SRC=https://a.b/geheim>", true)).toBe(IMAGE_PLACEHOLDER);
    expect(sanitizeTelegramText('<img src="https://a.b/geheim">')).toBe('<img src="https://a.b/geheim">');
    expect(sanitizeTelegramText('<pre><img src="x"></pre>', true)).toBe('<pre><img src="x"></pre>');
  });
});

describe("Runde 9: Code im Bildtext, img neben Link", () => {
  test("![a`code`b](…): Bild erkannt, Code bleibt, in Markdown und im HTML des Umwandlers", () => {
    const text = "![a`code`b](https://a.b/geheim) und `![x](https://a.b/im-code)`";
    const once = sanitizeModelOutput(text);
    expect(once).toBe("a`code`b und `![x](https://a.b/im-code)`");
    expect(sanitizeModelOutput(once)).toBe(once);
    const raw = markdownToTelegramHTML("![a`code`b](https://a.b/geheim)");
    expect(sanitizeTelegramText('!<a href="https://a.b/geheim">a<code>code</code>b</a>', true)).toBe("a<code>code</code>b");
    expect(raw).not.toContain("a.b/geheim");
  });

  test("<img alt=\"!\"> vor einem Link: Link bleibt vollständig, kein neues Bild, idempotent", () => {
    const html = '<img src="https://a.b/geheim" alt="!"><a href="https://ok.example/doku">Doku</a>';
    const once = sanitizeTelegramText(html, true);
    expect(once).toBe('! <a href="https://ok.example/doku">Doku</a>');
    expect(sanitizeTelegramText(once, true)).toBe(once);
    expect(sanitizeTelegramText(html)).toBe(html);
  });
});

describe("Runde 10: Zusammensetzungen, Code-Reihenfolge, Schlussprüfung", () => {
  test("benachbarte Ersetzungen: normale Adresse bleibt, kein neues Bild", () => {
    const text = "![!](https://a.b/1)![](https://a.b/2)(https://ok.example/doku)";
    const once = sanitizeModelOutput(text);
    expect(once).toContain("(https://ok.example/doku)");
    expect(once).not.toContain("a.b/");
    expect(sanitizeModelOutput(once)).toBe(once);
    expect(markdownToTelegramHTML(text)).not.toMatch(/!<a\s|<img/i);
  });

  test("HTML-Guard: aus Bildtext entsteht kein !<a", () => {
    const html = '![!](https://a.b/1)![<a href="https://a.b/geheim">Doku</a>](https://a.b/2)';
    const once = sanitizeTelegramText(html, true);
    expect(once).not.toMatch(/!<a\s/);
    expect(sanitizeTelegramText(once, true)).toBe(once);
  });

  test("zusammengesetztes <img> wird nicht zum Tag", () => {
    const html = '<im<img alt="g"> src="https://a.b/geheim">';
    expect(sanitizeTelegramText(html, true)).not.toMatch(/<img/i);
    expect(sanitizeTelegramText(html)).toBe(html);
  });

  test("Fences vor Inline-Code wie im Umwandler", () => {
    const text = "`Text vor ```\n![x](https://a.b/geheim)\n```";
    expect(sanitizeModelOutput(text)).toBe(text);
    expect(markdownToTelegramHTML(text)).toContain("![x](https://a.b/geheim)");
  });
});

describe("Schlussprüfung über Zufallstexte (HTML und Klartext)", () => {
  function rng(seed: number) {
    return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  }
  const PARTS = [
    "![", "!", "[", "]", "(", ")", "![!](https://a.b/1)", "![](https://a.b/2)", "(https://ok.example/doku)",
    "<im", "<img alt=\"g\">", "<img src=\"https://a.b/g\" alt=\"!\">", "<a href=\"https://a.b/h\">y</a>", "!<a href=\"https://a.b/i\">z</a>",
    "`", "```\n", "\n", " ", "x", "\\", "<code>", "</code>", "<pre>", "</pre>",
  ];
  const MD_IMG = /!\[[^\]]*\]\((?:(?:[^()]|\([^()]*\))+|[^)]+)\)/;

  test("nach dem Guard kein Bild außerhalb von Code, idempotent", () => {
    const next = rng(10);
    for (let i = 0; i < 4000; i++) {
      let text = "";
      const n = 1 + Math.floor(next() * 12);
      for (let k = 0; k < n; k++) text += PARTS[Math.floor(next() * PARTS.length)];
      for (const html of [true]) {
        const once = sanitizeTelegramText(text, html);
        expect({ text, html, twice: sanitizeTelegramText(once, html) }).toEqual({ text, html, twice: once });
        // Code entfernen wie der Guard (HTML: pre/code, Klartext: Fences, dann Inline-Code)
        const outside = html
          ? once.replace(/<(pre|code)\b[^>]*>[\s\S]*?<\/\1>/gi, "\u0001")
          : once.replace(/```\w*\n[\s\S]*?```/g, "\u0001").replace(/`[^`\n]+`/g, "\u0001");
        // Maskiertes "\\!" ist wie im Umwandler ein normaler Link, kein Bild
        const unescaped = (re: RegExp) =>
          [...outside.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))].some((m) => {
            let n = 0;
            while (outside[m.index - 1 - n] === "\\") n++;
            return n % 2 === 0;
          });
        const bad = unescaped(/!<a\s/) || /<img\b/i.test(outside) || unescaped(MD_IMG);
        expect({ text, html, once, bad }).toEqual({ text, html, once, bad: false });
      }
    }
  });
});

describe("Runde 11: ein Durchgang über das Original, normale Adressen bleiben", () => {
  const OK = "https://ok.example/doku";
  test("!<a>!</a>!<a></a>(…ok…): die normale Adresse bleibt vollständig", () => {
    const text = `!<a href="https://a.b/1">!</a>!<a href="https://a.b/2"></a>(${OK})`;
    for (const html of [true]) {
      const once = sanitizeTelegramText(text, html);
      expect(once).toContain(`(${OK})`);
      expect(once).not.toContain("a.b/");
      expect(sanitizeTelegramText(once, html)).toBe(once);
    }
  });

  // Orakel: Entfernt werden darf eine Adresse nur, wenn sie im ORIGINAL Teil
  // einer Bildform ist. Jede andere OK-Adresse muss im Ergebnis stehen bleiben.
  function rng(seed: number) {
    return () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  }
  const PARTS = [
    "!", "![", "[", "]", "(", ")", "x", " ", "\n", `(${OK})`, `[Doku](${OK})`, "![](https://a.b/2)", "![!](https://a.b/1)",
    '!<a href="https://a.b/1">!</a>', '!<a href="https://a.b/2"></a>', '<img alt="!" src="https://a.b/3">', "<im", `<a href="${OK}">y</a>`,
    `<A href="${OK}">Doku</A>`, '!<A HREF="https://a.b/4">!</A>', '<IMG alt="!" SRC="https://a.b/5">',
  ];
  const IMAGE_FORMS = /!<a\s[^>]*>([\s\S]*?)<\/a>|!\[([^\]]*)\]\((?:(?:[^()]|\([^()]*\))+|[^)]+)\)|<img\b[^>]*>/gi;

  test("jede OK-Adresse außerhalb einer ursprünglichen Bildform bleibt erhalten", () => {
    const next = rng(11);
    for (let i = 0; i < 4000; i++) {
      let text = "";
      const n = 1 + Math.floor(next() * 12);
      for (let k = 0; k < n; k++) text += PARTS[Math.floor(next() * PARTS.length)];
      const spans = [...text.matchAll(IMAGE_FORMS)].map((m) => [m.index!, m.index! + m[0].length]);
      let expected = 0;
      for (let at = text.indexOf(OK); at !== -1; at = text.indexOf(OK, at + 1)) {
        if (!spans.some(([a, b]) => at >= a && at < b)) expected++;
      }
      for (const html of [true]) {
        const once = sanitizeTelegramText(text, html);
        const kept = once.split(OK).length - 1;
        expect({ text, html, once, erhalten: kept >= expected }).toEqual({ text, html, once, erhalten: true });
      }
    }
  });
});

describe("Runde 12: spitze Klammern im Markdown-Bildtext sind Text", () => {
  test("![<Dateiname>](…) behält den Bildtext, im HTML-Versand escaped", () => {
    const text = "![<Dateiname>](https://a.b/geheim)";
    expect(sanitizeModelOutput(text)).toBe("<Dateiname>");
    expect(sanitizeTelegramText(text)).toBe(text);
    const html = markdownToTelegramHTML(text);
    expect(html).toBe("&lt;Dateiname&gt;");
    expect(sanitizeTelegramText(html, true)).toBe("&lt;Dateiname&gt;");
    // Schon gebautes HTML: nur Markup im Bildtext zählt als leer
    expect(sanitizeTelegramText('!<a href="https://a.b/g"><b></b></a>', true)).toBe(IMAGE_PLACEHOLDER);
  });
});

describe("Runde 13: Groß- und Kleinschreibung bei Link-Tags", () => {
  test("![!](…)<A href=…>Doku</A>: normale Adresse bleibt, auch im Klartext und wiederholt", () => {
    const text = '![!](https://a.b/geheim)<A href="https://ok.example/doku">Doku</A>';
    for (const html of [true]) {
      const once = sanitizeTelegramText(text, html);
      expect(once).toBe('! <A href="https://ok.example/doku">Doku</A>');
      expect(sanitizeTelegramText(once, html)).toBe(once);
    }
    expect(sanitizeModelOutput(text)).toBe('! <A href="https://ok.example/doku">Doku</A>');
  });
});
