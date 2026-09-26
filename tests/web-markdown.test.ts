import { describe, expect, test } from "bun:test";
import { parseDocument } from "htmlparser2";
import { getElementsByTagName, textContent } from "domutils";
import type { Element } from "domhandler";
import { renderMarkdown, stripControlTags } from "../src/web/markdown";

/** Alle Elemente im gerenderten HTML, echt geparst statt per Textsuche. */
function parse(html: string) {
  const doc = parseDocument(html);
  const all = getElementsByTagName(() => true, doc.children, true) as Element[];
  return {
    all,
    tags: (name: string) => all.filter(el => el.name === name),
    text: textContent(doc),
  };
}

function eventHandlers(els: Element[]): string[] {
  return els.flatMap(el => Object.keys(el.attribs).filter(a => /^on/i.test(a)));
}

describe("renderMarkdown: rohes HTML", () => {
  test("<script> erscheint escaped und bleibt als Text sichtbar", () => {
    const html = renderMarkdown("Hallo <script>alert(1)</script> Welt");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    const doc = parse(html);
    expect(doc.tags("script")).toHaveLength(0);
    expect(doc.text).toContain("<script>alert(1)</script>");
  });

  test("<script> als eigener Block", () => {
    const doc = parse(renderMarkdown("<script>\nalert(1)\n</script>"));
    expect(doc.tags("script")).toHaveLength(0);
    expect(doc.text).toContain("alert(1)");
  });

  test("<img onerror> erzeugt kein img-Element und kein Eventhandler-Attribut", () => {
    for (const src of ["<img src=x onerror=alert(1)>", "Text <img src=x onerror=alert(1)> Text"]) {
      const html = renderMarkdown(src);
      expect(html).not.toContain("<img");
      expect(html).not.toContain("onerror=");
      const doc = parse(html);
      expect(doc.tags("img")).toHaveLength(0);
      expect(eventHandlers(doc.all)).toEqual([]);
      expect(doc.text).toContain("<img src=x onerror=alert(1)>");
    }
  });
});

describe("renderMarkdown: Links", () => {
  const hrefs = (md: string) => parse(renderMarkdown(md)).tags("a").map(a => a.attribs.href);

  test("erlaubte Protokolle", () => {
    expect(hrefs("[a](https://a.b/x)")).toEqual(["https://a.b/x"]);
    expect(hrefs("[a](http://a.b/)")).toEqual(["http://a.b/"]);
    expect(hrefs("[Mail](mailto:alex@example.com)")).toEqual(["mailto:alex@example.com"]);
  });

  test("Links haben rel und target", () => {
    const [a] = parse(renderMarkdown("[a](https://a.b)")).tags("a");
    expect(a.attribs.rel).toBe("noopener noreferrer");
    expect(a.attribs.target).toBe("_blank");
    expect(renderMarkdown("[a](https://a.b)")).toContain('rel="noopener noreferrer"');
  });

  test("javascript: erzeugt keinen Link, der Text bleibt", () => {
    const html = renderMarkdown("[x](javascript:alert(1))");
    expect(html).not.toContain('href="javascript:');
    const doc = parse(html);
    expect(doc.tags("a")).toHaveLength(0);
    expect(doc.text).toContain("x");
  });

  test("verschleierte und gesperrte URLs erzeugen keinen Link", () => {
    const bad = [
      "[x](JaVaScRiPt:alert(1))",
      "[x](  javascript:alert(1))",
      "[x](java\tscript:alert(1))",
      "[x](jav&#x61;script:alert(1))",
      "[x](&#106;avascript:alert(1))",
      "[x](<javascript:alert(1)>)",
      "[x](vbscript:msgbox(1))",
      "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
      "[x](/relativ/pfad)",
      "[x](relativ.html)",
      "[x](//evil.example/x)",
      "[x](#anker)",
      "[x](file:///etc/passwd)",
    ];
    for (const md of bad) {
      const doc = parse(renderMarkdown(md));
      expect({ md, links: doc.tags("a").length }).toEqual({ md, links: 0 });
      expect(doc.text).toContain("x");
    }
  });

  test("Referenzlinks und Autolinks laufen durch dieselbe Prüfung", () => {
    expect(hrefs("[a][r]\n\n[r]: https://a.b/ref")).toEqual(["https://a.b/ref"]);
    expect(hrefs("[a][r]\n\n[r]: javascript:alert(1)")).toEqual([]);
    expect(hrefs("<https://a.b/auto>")).toEqual(["https://a.b/auto"]);
    expect(hrefs("siehe https://a.b/gfm dort")).toEqual(["https://a.b/gfm"]);
    expect(hrefs("<alex@example.com>")).toEqual(["mailto:alex@example.com"]);
    expect(hrefs("<javascript:alert(1)>")).toEqual([]);
    for (const a of parse(renderMarkdown("<https://a.b> und https://c.d")).tags("a")) {
      expect(a.attribs.rel).toBe("noopener noreferrer");
      expect(a.attribs.target).toBe("_blank");
    }
  });

  test("kein Attributausbruch über URL oder Titel", () => {
    const cases = [
      '[x](https://a.b/"onmouseover="alert(1))',
      "[x](https://a.b/ \"t\\\" onmouseover=\\\"alert(1)\")",
      "[x](https://a.b/ 't\" onmouseover=\"alert(1)')",
      '[x][r]\n\n[r]: https://a.b "t\\" onclick=\\"alert(1)"',
    ];
    for (const md of cases) {
      const doc = parse(renderMarkdown(md));
      expect(eventHandlers(doc.all)).toEqual([]);
      for (const a of doc.tags("a")) {
        expect(Object.keys(a.attribs).sort()).toEqual(
          Object.keys(a.attribs).filter(k => ["href", "rel", "target", "title"].includes(k)).sort()
        );
      }
    }
  });
});

describe("renderMarkdown: Bilder", () => {
  test("Bild wird Link mit Alt-Text statt <img>", () => {
    const html = renderMarkdown("![a](https://evil/x.png)");
    expect(html).not.toContain("<img");
    const [a] = parse(html).tags("a");
    expect(a.attribs.href).toBe("https://evil/x.png");
    expect(a.attribs.rel).toBe("noopener noreferrer");
    expect(a.attribs.target).toBe("_blank");
    expect(textContent(a)).toBe("a");
  });

  test("Bild mit gesperrter URL wird nur Text", () => {
    for (const md of ["![a](javascript:alert(1))", "![a](data:image/png;base64,AAAA)", "![a](/x.png)", "![a][r]\n\n[r]: javascript:alert(1)"]) {
      const doc = parse(renderMarkdown(md));
      expect(doc.tags("img")).toHaveLength(0);
      expect(doc.tags("a")).toHaveLength(0);
      expect(doc.text).toContain("a");
    }
  });

  test("kein Attributausbruch über Alt-Text oder Titel", () => {
    for (const md of [
      '![" onerror="alert(1)](https://a.b/x.png)',
      '![<img src=x onerror=alert(1)>](https://a.b/x.png)',
      '![a](https://a.b/x.png "t\\" onerror=\\"alert(1)")',
    ]) {
      const doc = parse(renderMarkdown(md));
      expect(doc.tags("img")).toHaveLength(0);
      expect(eventHandlers(doc.all)).toEqual([]);
    }
  });
});

describe("renderMarkdown: GFM", () => {
  test("Tabelle erzeugt <table>", () => {
    const doc = parse(renderMarkdown("| A | B |\n|---|---|\n| 1 | 2 |"));
    expect(doc.tags("table")).toHaveLength(1);
    expect(doc.tags("td").map(td => textContent(td))).toEqual(["1", "2"]);
  });

  test("Listen", () => {
    expect(parse(renderMarkdown("- a\n- b")).tags("li")).toHaveLength(2);
    expect(parse(renderMarkdown("1. a\n2. b")).tags("ol")).toHaveLength(1);
  });

  test("Codeblock mit ts erzeugt class=\"language-ts\"", () => {
    const html = renderMarkdown("```ts\nconst a = 1 < 2;\n```");
    expect(html).toContain('<pre><code class="language-ts">');
    const [code] = parse(html).tags("code");
    expect(textContent(code)).toBe("const a = 1 < 2;");
  });

  test("Codeblock ohne Sprache hat keine Klasse, HTML darin bleibt Text", () => {
    const html = renderMarkdown("```\n<script>alert(1)</script>\n```");
    expect(html).toContain("<pre><code>");
    expect(parse(html).tags("script")).toHaveLength(0);
  });

  test("kein Attributausbruch über die Code-Sprache", () => {
    const html = renderMarkdown('```ts"><script>alert(1)</script> onclick="x\nconst a = 1;\n```');
    const doc = parse(html);
    expect(doc.tags("script")).toHaveLength(0);
    expect(eventHandlers(doc.all)).toEqual([]);
    const [code] = doc.tags("code");
    expect(code.attribs.class).toMatch(/^language-[\w+-]+$/);
  });

  test("Inline-Code escaped", () => {
    const doc = parse(renderMarkdown("`<b>fett</b>`"));
    expect(doc.tags("b")).toHaveLength(0);
    expect(doc.text).toContain("<b>fett</b>");
  });
});

describe("stripControlTags", () => {
  test("jedes der sieben Tags verschwindet", () => {
    const tags = [
      "[GOAL: Marathon laufen]",
      "[DONE: Steuererklärung abgegeben]",
      "[CANCEL: Umzug nach Berlin]",
      "[REMEMBER: Alex trinkt keinen Kaffee]",
      "[FORGET: alte Telefonnummer]",
      "[INVOKE:research|Wie groß ist der Markt?]",
      "[ASSET_DESC: Foto eines Heizkessels]",
    ];
    for (const tag of tags) {
      expect(stripControlTags(`Vorher ${tag} nachher`)).toBe("Vorher nachher");
      expect(stripControlTags(`Antwort.\n\n${tag}`)).toBe("Antwort.");
    }
  });

  test("GOAL mit DEADLINE", () => {
    expect(stripControlTags("Gut. [GOAL: 10 km laufen | DEADLINE: 2026-12-31]")).toBe("Gut.");
  });

  test("Memory-Tags ohne Beachtung der Groß-/Kleinschreibung", () => {
    const text = "a [remember: x] b [Goal: y | deadline: z] c [done: fertig gemacht] d [Cancel: abgesagt!] e [forget: alt] f";
    expect(stripControlTags(text)).toBe("a b c d e f");
  });

  test("wiederholte und mehrzeilige Tags", () => {
    const text = "Text [REMEMBER: eins] und [REMEMBER: zwei]\n[REMEMBER: über\nzwei Zeilen]\nEnde";
    expect(stripControlTags(text)).toBe("Text und\nEnde");
  });

  test("normaler Text in eckigen Klammern bleibt", () => {
    const text = "Siehe [Link](https://a.b) und Quelle [1], [ ] offen, [x] erledigt, [Hinweis: kein Tag], [INVOKE:kaputt]";
    expect(stripControlTags(text)).toBe(text);
    const doc = parse(renderMarkdown("[Link](https://a.b) und [1]"));
    expect(doc.tags("a").map(a => a.attribs.href)).toEqual(["https://a.b/"]);
    expect(doc.text).toContain("[1]");
  });

  test("überzählige Leerzeilen werden zusammengezogen", () => {
    const text = "Absatz eins.\n\n[REMEMBER: x]\n\n[GOAL: y]\n\n\nAbsatz zwei.\n\n[ASSET_DESC: z]\n";
    expect(stripControlTags(text)).toBe("Absatz eins.\n\nAbsatz zwei.");
  });

  test("Leerzeilen in Codeblöcken bleiben erhalten", () => {
    const text = "Code:\n\n```ts\nconst a = 1;\n\n\n\nconst b = 2;\n```\n\n\n\nEnde";
    expect(stripControlTags(text)).toBe("Code:\n\n```ts\nconst a = 1;\n\n\n\nconst b = 2;\n```\n\nEnde");
    const [code] = parse(renderMarkdown(text)).tags("code");
    expect(textContent(code)).toBe("const a = 1;\n\n\n\nconst b = 2;");
  });
});

describe("renderMarkdown mit Steuer-Tags", () => {
  test("erst Tags entfernen, dann rendern", () => {
    const raw = "**Erledigt.** [REMEMBER: Alex mag Tee]\n\n[GOAL: Buch lesen | DEADLINE: Freitag]\n\n- Punkt [INVOKE:finance|Kosten?]\n\n[ASSET_DESC: Bild]";
    const html = renderMarkdown(raw);
    for (const word of ["REMEMBER", "GOAL", "DEADLINE", "INVOKE", "ASSET_DESC"]) expect(html).not.toContain(word);
    const doc = parse(html);
    expect(doc.tags("strong")).toHaveLength(1);
    expect(doc.tags("li").map(li => textContent(li))).toEqual(["Punkt"]);
    // der Eingabetext bleibt für die Gedächtnisverarbeitung unverändert
    expect(raw).toContain("[REMEMBER: Alex mag Tee]");
  });

  test("Tag innerhalb eines Links wird nicht zum Link-Ziel", () => {
    const doc = parse(renderMarkdown("[REMEMBER: x](https://a.b) Text"));
    expect(doc.text).not.toContain("REMEMBER");
  });
});
