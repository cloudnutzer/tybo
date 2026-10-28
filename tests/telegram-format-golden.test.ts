/**
 * Issue #327, Aufgabe 2: Golden-Tests für renderTelegram. Eine lange Antwort
 * wird einmal in Telegram-HTML umgewandelt und dieses HTML entlang seiner
 * Blockstruktur geteilt (zulässig laut Präzisierung im Issue): jeder Teil
 * höchstens max Zeichen (UTF-16, mit Tags und Entities) und für sich gültiges
 * HTML, kein Inhalt geht verloren.
 */
import { describe, expect, test } from "bun:test";
import { MIN_RENDER_MAX, renderTelegram } from "../src/channels/telegram/format";
import { escapeHtml, markdownToTelegramHTML } from "../src/lib/telegram";
import { htmlText, sameTextExceptBoundaries, styleDifference, telegramHtmlError } from "./telegram-html-check";

const MAX = 4000;

/** Gemeinsame Prüfungen für jeden Fall */
function expectWellFormed(parts: string[], md: string, max = MAX) {
  expect(parts.length).toBeGreaterThan(1);
  for (const [n, part] of parts.entries()) {
    expect({ n, length: part.length <= max }).toEqual({ n, length: true });
    expect({ n, error: telegramHtmlError(part) }).toEqual({ n, error: null });
    expect(part.trim()).not.toBe("");
  }
  expect(sameTextExceptBoundaries(parts, markdownToTelegramHTML(md))).toBeNull();
}

const PRE_TS = /^<pre><code class="language-ts">([\s\S]*)<\/code><\/pre>$/;

// 300 Zeilen: führende Leerzeichen, Tabs, Leerzeilen, Zeilen nur aus Leerraum, <, &, Umlaute, Emoji
const CODE = Array.from({ length: 300 }, (_, i) => {
  if (i % 17 === 0) return "";
  if (i % 23 === 0) return "    ";
  const indent = i % 5 === 0 ? "\t\t" : " ".repeat(i % 8);
  return `${indent}if (wert_${i} < grenze && name !== "Größe ${i}") { log("🚀 ${i} & mehr"); }`;
}).join("\n");
const CODE_MD = `Hier der Code:\n\n\`\`\`ts\n${CODE}\n\`\`\`\n\nFertig.`;

describe("Codeblock über max", () => {
  test("mehrere Teile, jeder ein vollständiges <pre><code class>, Code zeichengenau", () => {
    const parts = renderTelegram(CODE_MD);
    expectWellFormed(parts, CODE_MD);
    const codeParts = parts.filter(p => p.startsWith("<pre>"));
    expect(codeParts.length).toBeGreaterThan(1);
    for (const p of codeParts) expect(p).toMatch(PRE_TS);
    // Genau ein Zeilenumbruch vor dem schließenden Zaun gehört nicht zum Code (wie bisher)
    const joined = codeParts.map(p => htmlText(PRE_TS.exec(p)![1])).join("");
    expect(joined).toBe(CODE);
    expect(parts[0]).toBe("Hier der Code:");
    expect(parts.at(-1)).toBe("Fertig.");
  });

  test("eine einzelne Zeile über max: harter Schnitt, nie in Entity oder Surrogatpaar", () => {
    const line = "a&b<c>🎉ü".repeat(900);
    for (const max of [MAX, 500]) {
      const md = `\`\`\`ts\n${line}\n\`\`\``;
      const parts = renderTelegram(md, max);
      expectWellFormed(parts, md, max);
      const texts = parts.map(p => htmlText(PRE_TS.exec(p)![1]));
      for (const t of texts) {
        expect(/^[\uDC00-\uDFFF]/.test(t)).toBe(false);
        expect(/[\uD800-\uDBFF]$/.test(t)).toBe(false);
      }
      expect(texts.join("")).toBe(line);
    }
  });

  test("ohne Sprachkennung ohne class", () => {
    const parts = renderTelegram(`\`\`\`\n${CODE}\n\`\`\``);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p).toMatch(/^<pre><code>[\s\S]*<\/code><\/pre>$/);
  });
});

describe("Markdown-Tabelle mit 80 Zeilen", () => {
  const LAENDER = ["Bayern", "Hessen", "Nordrhein-Westfalen", "Sachsen"];
  const rows = Array.from({ length: 80 }, (_, i) => ({ stadt: `Stadt ${i}`, einwohner: String(10000 + i * 137), land: LAENDER[i % 4] }));
  const md = [
    "Die Liste:",
    "",
    "| Stadt | Einwohner | Bundesland |",
    "|---|---:|---|",
    ...rows.map(r => `| ${r.stadt} | ${r.einwohner} | ${r.land} |`),
    "",
    "Ende der Liste.",
  ].join("\n");

  test("kein |, jeder Eintrag genau einmal vollständig in einem Teil, Spaltennamen an jedem Eintrag", () => {
    const parts = renderTelegram(md);
    expectWellFormed(parts, md);
    for (const p of parts) expect(p).not.toContain("|");
    for (const r of rows) {
      // Erste Spalte wird Überschrift ohne Spaltennamen, die übrigen Spalten bekommen ihren Namen
      const entry = `<b>${r.stadt}</b>\n- Einwohner: ${r.einwohner}\n- Bundesland: ${r.land}`;
      const holders = parts.filter(p => p.includes(`<b>${r.stadt}</b>`));
      expect({ stadt: r.stadt, holders: holders.length }).toEqual({ stadt: r.stadt, holders: 1 });
      expect(holders[0].split(`<b>${r.stadt}</b>`).length).toBe(2);
      expect(holders[0]).toContain(entry);
    }
  });
});

describe("Zitat über max", () => {
  const lines = Array.from({ length: 120 }, (_, i) => `> Zeile ${i}: Wer früh aufsteht & Kaffee kocht, hat <mehr> vom Tag.`);
  const longLine = `> ${Array.from({ length: 700 }, (_, i) => `wort${i}`).join(" ")}`;
  const md = `${lines.join("\n")}\n\nDazwischen.\n\n${longLine}`;

  test("jeder Teil in eigenem <blockquote>, Text vollständig", () => {
    const parts = renderTelegram(md);
    expectWellFormed(parts, md);
    const quotes = parts.filter(p => p !== "Dazwischen.");
    expect(quotes.length).toBeGreaterThan(2);
    for (const p of quotes) {
      expect(p).toMatch(/^<blockquote>[\s\S]*<\/blockquote>$/);
      expect(p.split("<blockquote>").length).toBe(2);
    }
  });
});

describe("Absatz über max mit Formatierung", () => {
  const SPANS = 60;
  const md = Array.from(
    { length: SPANS },
    (_, i) => `Satz ${i} hat **fett ${i}**, *kursiv ${i}*, \`code_${i}()\`, [Link ${i}](https://example.org/seite_${i}) und ~~alt ${i}~~ im Fließtext.`
  ).join(" ");

  test("an Wortgrenzen geteilt, keine Formatierung offen über eine Teilgrenze", () => {
    const parts = renderTelegram(md, 1000);
    expectWellFormed(parts, md, 1000);
    for (const p of parts) for (const raw of ["**", "`", "~~", "]("]) expect({ p, raw, offen: p.includes(raw) }).toEqual({ p, raw, offen: false });
    const all = parts.join("\n");
    for (const tag of ["<b>", "<i>", "<code>", "<s>", "<a href="]) expect({ tag, n: all.split(tag).length - 1 }).toEqual({ tag, n: SPANS });
  });

  test("Wort ohne Leerraum über max: Schnitt an Zeichengrenzen, nie im Surrogatpaar", () => {
    const md = "😀&".repeat(3000);
    const parts = renderTelegram(md);
    expectWellFormed(parts, md);
    expect(parts.map(htmlText).join("")).toBe(md);
  });
});

describe("Grenzfälle", () => {
  test("ungültiges oder zu kleines max: RangeError", () => {
    for (const max of [0, -1, 1.5, Number.NaN, MIN_RENDER_MAX - 1]) expect(() => renderTelegram("x".repeat(5000), max)).toThrow(RangeError);
    expect(renderTelegram("x".repeat(500), MIN_RENDER_MAX).every(p => p.length <= MIN_RENDER_MAX)).toBe(true);
  });

  test("überlange Adresse in einem Link: Teile bleiben gültig und vollständig", () => {
    const md = `Vorher [hier](https://example.org/${"x".repeat(5000)}) nachher`;
    const parts = renderTelegram(md);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(MAX);
      expect(telegramHtmlError(p)).toBeNull();
    }
    expect(parts.map(htmlText).join("").replace(/\s+/g, "")).toContain("x".repeat(5000));
  });

  test("Sprachkennung, neben der kein Zeichen Code mehr passt: Teile ohne class, Code vollständig", () => {
    const lang = "l".repeat(MAX);
    const md = `\`\`\`${lang}\n${CODE}\n\`\`\``;
    const parts = renderTelegram(md);
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(MAX);
      expect(p).toMatch(/^<pre><code>[\s\S]*<\/code><\/pre>$/);
    }
    expect(parts.map(p => htmlText(p)).join("")).toBe(CODE);
  });

  test("überlanger Tabellen-Eintrag: Teile gültig, Inhalt vollständig", () => {
    const md = `| Name | Beschreibung | Preis |\n|---|---|---|\n| Gerät | ${"sehr lang ".repeat(600)}| 5 |\n| Zweites | kurz | 7 |`;
    const parts = renderTelegram(md);
    expectWellFormed(parts, md);
    for (const p of parts) expect(p).not.toContain("|");
    expect(parts.at(-1)).toContain("<b>Zweites</b>\n- Beschreibung: kurz\n- Preis: 7");
  });

  test("ASCII-Tabelle im Codeblock ohne Sprache wird wie bisher Liste", () => {
    const body = Array.from({ length: 120 }, (_, i) => `| Gerät ${i} | ${i * 3} Watt | Lager ${i % 5} |`).join("\n");
    const md = `\`\`\`\n| Name | Leistung | Ort |\n|---|---|---|\n${body}\n\`\`\``;
    const parts = renderTelegram(md);
    expectWellFormed(parts, md);
    for (const p of parts) {
      expect(p).not.toContain("<pre>");
      expect(p).not.toContain("|");
    }
    expect(parts.join("\n")).toContain("<b>Gerät 119</b>\n- Leistung: 357 Watt\n- Ort: Lager 4");
  });
});

describe("Schutz (Entscheidung 0008, Issue #52)", () => {
  const IMAGES = [
    "![x](https://a.b/geheim)",
    "vor ![x](https://a.b/((tief))/(x(y(z))).png) nach",
    "![a [b] c](https://a.b/geheim)",
    "![x](https://a.b/geheim\n  \"Titel\nzweite\")",
    "![a ![b](https://a.b/2) c](https://a.b/1)",
    "!![x](https://a.b/geheim)",
    "![!](https://a.b/geheim)[Doku](https://ok.example/doku)",
    "![!](https://a.b/1)![](https://a.b/2)(https://ok.example/doku)",
    "![a`code`b](https://a.b/geheim)",
    "!​[x](https://a.b/geheim)",
    'Hallo <img src="https://a.b/geheim" alt="Logo"> Welt',
    '!<a href="https://a.b/geheim">x</a>',
  ];
  /** Kein Bild-Link (maskiertes "\\!" vor einem Link ist ein normaler Link) und kein img-Tag */
  const noImageLink = (parts: string[]) => parts.every(p => !/(?<!\\)!<a\s|<img/i.test(p));
  const hrefs = (parts: string[]) => parts.flatMap(p => [...p.matchAll(/<a\s[^>]*href="([^"]*)"/g)].map(m => m[1]));

  test("Bildfälle aus telegram-sanitize, kurz und in langen Antworten: kein Bild, kein Bild-Link", () => {
    const filler = Array.from({ length: 80 }, (_, i) => `Absatz ${i} mit etwas Text, damit die Antwort lang wird.`).join("\n\n");
    for (const image of IMAGES) {
      const short = renderTelegram(image);
      expect({ image, ok: noImageLink(short) }).toEqual({ image, ok: true });
      const long = renderTelegram(`${filler}\n\n${image}\n\n${filler}`);
      expect(long.length).toBeGreaterThan(1);
      expect({ image, ok: noImageLink(long) }).toEqual({ image, ok: true });
      // Das Teilen bringt keine Adresse als Link zurück, die die kurze Form nicht hat
      expect({ image, hrefs: hrefs(long) }).toEqual({ image, hrefs: hrefs(short) });
    }
  });

  test("maskiertes Bild in einem überlangen Wort: auch beim Zeichenschnitt kein Bild-Link", () => {
    const parts = renderTelegram("\\![x](https://a.b/geheim)".repeat(400));
    expect(parts.length).toBeGreaterThan(1);
    expect(noImageLink(parts)).toBe(true);
  });

  test("Bildsyntax in Code bleibt Text", () => {
    const md = `\`\`\`\n${"![x](https://a.b/im-code)\n".repeat(300)}\`\`\``;
    const parts = renderTelegram(md);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p).toMatch(/^<pre><code>(!\[x\]\(https:\/\/a\.b\/im-code\)\n?)+<\/code><\/pre>$/);
  });
});

/**
 * Prüfrunde 1 zu PR #417: Die Befunde hatten eine Ursache. Die Teilgrenzen
 * kamen aus einer zweiten Lesart des Markdowns (Leerzeilen, Halb-voll- und
 * Viertel-Regeln) statt aus der Struktur der Einzelumwandlung. Die Fälle der
 * Prüfung stehen hier einzeln, die Klasse prüft der Eigenschaftstest danach:
 * Jedes Zeichen trägt in den Teilen dieselbe Formatierung wie in der
 * Einzelumwandlung, und jeder Tabelleneintrag, der in ein Stück passt, steht
 * ganz in genau einem Stück.
 */
describe("Teilen erhält Struktur und Formatierung der Einzelumwandlung", () => {
  const expectSameStyle = (parts: string[], md: string) => expect(styleDifference(parts, markdownToTelegramHTML(md))).toBeNull();

  test("zweispaltige Tabelle: geteilt zwischen den Einträgen, keiner verliert seinen Namen", () => {
    const words = (w: string, n: number) => `${w} `.repeat(n).trim();
    const md = `| Name | Beschreibung |\n|---|---|\n| A | ${words("a", 200)} |\n| B | ${words("b", 1800)} |\n| C | ${words("c", 1800)} |`;
    const parts = renderTelegram(md);
    expect(parts).toEqual([`- <b>A</b>: ${words("a", 200)}`, `- <b>B</b>: ${words("b", 1800)}`, `- <b>C</b>: ${words("c", 1800)}`]);
  });

  test("Link über Leerzeilen: bleibt in jedem Teil ein Link, keine Markdown-Reste", () => {
    const md = `[Anfang\n\n${"Wort ".repeat(1000)}\n\nEnde](https://example.org)`;
    const parts = renderTelegram(md);
    expectWellFormed(parts, md);
    for (const p of parts) {
      expect(p).toMatch(/^<a href="https:\/\/example\.org">[^<]*<\/a>$/);
      expect(p).not.toContain("[");
      expect(p).not.toContain("](");
    }
    expectSameStyle(parts, md);
  });

  test("Sprachkennung bleibt, wenn der Rahmen passt: ts-Codeblock mit 200 Zeichen bei max 100", () => {
    const code = Array.from({ length: 16 }, (_, i) => `let x${i} = ${i};`).join("\n");
    expect(code.length).toBeGreaterThan(200);
    const md = `\`\`\`ts\n${code}\n\`\`\``;
    const parts = renderTelegram(md, 100);
    expectWellFormed(parts, md, 100);
    for (const p of parts) expect(p).toMatch(PRE_TS);
    expect(parts.map(p => htmlText(PRE_TS.exec(p)![1])).join("")).toBe(code);
  });

  test("Link mit langer Adresse in langem Absatz: bleibt Link, Adresse nicht als Text", () => {
    const href = `https://example.org/${"u".repeat(1000)}`;
    const md = `${"Text davor. ".repeat(300)}[hier](${href}) ${"Text danach. ".repeat(100)}`;
    const parts = renderTelegram(md);
    expectWellFormed(parts, md);
    expect(parts.filter(p => p.includes(`<a href="${href}">hier</a>`)).length).toBe(1);
    for (const p of parts) expect(htmlText(p)).not.toContain("uuuu");
    expectSameStyle(parts, md);
  });

  test("Formatierung über eine Teilgrenze wird geschlossen und mit denselben Tags wieder geöffnet", () => {
    const md = `> **${"fett und weiter ".repeat(400)}**`;
    const parts = renderTelegram(md);
    expectWellFormed(parts, md);
    for (const p of parts) expect(p).toMatch(/^<blockquote><b>[^<]*<\/b><\/blockquote>$/);
    expectSameStyle(parts, md);
  });

  describe("Eigenschaft: zufällige Antworten", () => {
    /** Fester Zufall (mulberry32), damit jeder Lauf dieselben Fälle prüft */
    function random(seed: number) {
      let s = seed >>> 0;
      return () => {
        s = (s + 0x6d2b79f5) >>> 0;
        let t = s;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const WORDS = ["Haus", "a&b", "<tag>", "Größe", "🎉", "x_y", "sehr", "lang", "1 < 2", "Ende"];

    function makeAnswer(seed: number) {
      const rnd = random(seed);
      const int = (n: number) => Math.floor(rnd() * n);
      const pick = <T>(list: readonly T[]) => list[int(list.length)];
      const word = () => (rnd() < 0.01 ? "z".repeat(150 + int(400)) : pick(WORDS));
      const words = (n: number) => Array.from({ length: n }, word).join(" ");
      /** Ohne mehrzeiligen Link: in einer Zitatzeile verschachtelt schon die Einzelumwandlung ihn falsch */
      const span = (k: number, multiline = true) =>
        pick([
          () => words(1 + int(6)),
          () => `**${words(1 + int(4))}**`,
          () => `*${words(1 + int(3))}*`,
          () => `\`code_${k}()\``,
          () => `~~${words(1 + int(3))}~~`,
          () => `[${words(1 + int(5))}](https://example.org/s_${k})`,
          () => `[**${words(1 + int(2))}** ${words(1 + int(3))}](https://example.org/b_${k})`,
          ...(multiline ? [() => `[${words(1 + int(3))}\n\n${words(5 + int(120))}](https://example.org/m_${k})`] : []),
        ])();
      const entries: string[] = [];
      let n = 0;
      const blocks = Array.from({ length: 3 + int(6) }, () => {
        const id = n++;
        switch (int(6)) {
          case 0: {
            const rows = Array.from({ length: 2 + int(10) }, (_, r) => ({ key: `Eintrag-${id}-${r}`, value: words(1 + int(rnd() < 0.2 ? 250 : 20)) }));
            for (const r of rows) entries.push(`- <b>${r.key}</b>: ${escapeHtml(r.value)}`);
            return ["| Name | Wert |", "|---|---|", ...rows.map(r => `| ${r.key} | ${r.value} |`)].join("\n");
          }
          case 1: {
            const rows = Array.from({ length: 2 + int(10) }, (_, r) => ({ key: `Zeile-${id}-${r}`, b: words(1 + int(20)), c: words(1 + int(rnd() < 0.2 ? 200 : 10)) }));
            for (const r of rows) entries.push(`<b>${r.key}</b>\n- Farbe: ${escapeHtml(r.b)}\n- Ort: ${escapeHtml(r.c)}`);
            return ["| Name | Farbe | Ort |", "|---|---|---|", ...rows.map(r => `| ${r.key} | ${r.b} | ${r.c} |`)].join("\n");
          }
          case 2:
            return Array.from({ length: 1 + int(20) }, (_, l) => `> ${span(id * 100 + l, false)} ${words(int(40))}`).join("\n");
          case 3: {
            const lang = pick(["ts", "python", ""]);
            const lines = Array.from({ length: 1 + int(80) }, (_, l) => `${" ".repeat(int(6))}x${l} = a < b && "${words(int(8))}";`);
            return `\`\`\`${lang}\n${lines.join("\n")}\n\`\`\``;
          }
          case 4:
            return `# Titel ${id} ${words(int(5))}`;
          default:
            return Array.from({ length: 1 + int(30) }, (_, k) => span(id * 100 + k)).join(pick([" ", " ", "\n"]));
        }
      });
      return { md: blocks.join("\n\n"), entries, max: 150 + int(1500) };
    }

    test("200 Antworten: Länge, gültiges HTML, Formatierung je Zeichen gleich, Einträge ganz", () => {
      const problems: string[] = [];
      for (let seed = 1; seed <= 200; seed++) {
        const { md, entries, max } = makeAnswer(seed);
        const parts = renderTelegram(md, max);
        const whole = markdownToTelegramHTML(md);
        const fail = (what: string) => problems.push(`Fall ${seed} (max ${max}): ${what}`);
        for (const [k, p] of parts.entries()) {
          if (p.length > max) fail(`Teil ${k} hat ${p.length} Zeichen`);
          const error = telegramHtmlError(p);
          if (error) fail(`Teil ${k}: ${error}`);
        }
        const text = sameTextExceptBoundaries(parts, whole);
        if (text) fail(text);
        const style = styleDifference(parts, whole);
        if (style) fail(`Formatierung weicht ab, ${style}`);
        for (const entry of entries) {
          if (entry.length > max) continue;
          const holders = parts.filter(p => p.includes(entry)).length;
          if (holders !== 1) fail(`Eintrag ${JSON.stringify(entry.slice(0, 40))} steht ${holders}-mal ganz in einem Teil`);
        }
      }
      expect(problems.slice(0, 10)).toEqual([]);
    }, 60_000);
  });
});

/**
 * Prüfrunde 2 zu PR #417: Formatierung fiel weg, wenn neben ihrem Rahmen
 * keine pauschalen fünf Zeichen mehr frei waren, auch wenn ihr Inhalt
 * kleiner war. Jetzt zählt das längste unteilbare Stück des tatsächlichen
 * Inhalts (Zeichen, Surrogatpaar, Entity). Die Fälle liegen je genau auf der
 * Grenze: ein Zeichen weniger Platz, und die Formatierung fällt weg.
 */
describe("Formatierung fällt nur weg, wenn ihr tatsächlicher Inhalt nicht passt", () => {
  const BASE = "https://example.org/";
  /** Adresse, mit der das Link-Tag samt </a> und weiteren extra Zeichen genau total lang ist */
  const hrefFor = (total: number, extra: number) => BASE + "u".repeat(total - extra - `<a href="${BASE}"></a>`.length);
  const expectValid = (parts: string[], max: number) => {
    for (const p of parts) {
      expect(p.length).toBeLessThanOrEqual(max);
      expect(telegramHtmlError(p)).toBeNull();
    }
  };
  const expectSameStyle = (parts: string[], md: string) => expect(styleDifference(parts, markdownToTelegramHTML(md))).toBeNull();

  test("Reproduktion: Link mit 3.998 Zeichen in einem längeren Absatz bleibt Link", () => {
    const href = `${BASE}${"u".repeat(3982 - BASE.length)}`;
    const md = `Vorher [x](${href}) nachher`;
    const parts = renderTelegram(md);
    expect(parts).toEqual(["Vorher", `<a href="${href}">x</a>`, "nachher"]);
    expect(parts[1].length).toBe(3998);
    expectWellFormed(parts, md);
  });

  test("Reproduktion: Sprachkennung mit 55 Zeichen bei max 100 bleibt an jedem Teil", () => {
    const lang = "l".repeat(55);
    const md = `\`\`\`${lang}\n${"a".repeat(10)}\n\`\`\``;
    const parts = renderTelegram(md, 100);
    expectWellFormed(parts, md, 100);
    const frame = new RegExp(`^<pre><code class="language-${lang}">(a+)</code></pre>$`);
    for (const p of parts) expect(p).toMatch(frame);
    expect(parts.map(p => frame.exec(p)![1]).join("")).toBe("a".repeat(10));
    expectSameStyle(parts, md);
  });

  test("Link genau auf der Grenze: Linktext aus Zeichen, Emoji oder Entity", () => {
    for (const [text, unit] of [["x", 1], ["🎉", 2], ["a&b", "&amp;".length]] as const) {
      for (const slack of [-1, 0, 1]) {
        const href = hrefFor(MAX + slack, unit);
        const md = `Vorher [${text}](${href}) nachher`;
        const parts = renderTelegram(md);
        const label = { text, slack };
        expectValid(parts, MAX);
        if (slack <= 0) {
          expect({ ...label, links: parts.filter(p => p.startsWith(`<a href="${href}">`)).length > 0 }).toEqual({ ...label, links: true });
          expect({ ...label, style: styleDifference(parts, markdownToTelegramHTML(md)) }).toEqual({ ...label, style: null });
          for (const p of parts) expect(htmlText(p)).not.toContain("uuuu");
        } else {
          expect({ ...label, links: parts.some(p => p.includes("<a ")) }).toEqual({ ...label, links: false });
          expect(parts.map(htmlText).join("").replace(/\s+/g, "")).toContain(`(${href})`);
        }
      }
    }
  });

  test("fett, kursiv und Inline-Code in einem Link genau auf der Grenze", () => {
    for (const [md, inner, tag] of [["**x**", "<b>x</b>", "b"], ["*x*", "<i>x</i>", "i"], ["`x`", "<code>x</code>", "code"]] as const) {
      for (const slack of [0, 1]) {
        const href = hrefFor(MAX + slack, inner.length);
        const parts = renderTelegram(`Vorher [${md}](${href}) nachher`);
        const label = { tag, slack };
        expectValid(parts, MAX);
        // Auf der Grenze bleibt beides; ein Zeichen zu viel, und nur die innere Formatierung fällt weg, der Link passt weiter
        if (slack === 0) expect({ ...label, parts }).toEqual({ ...label, parts: ["Vorher", `<a href="${href}">${inner}</a>`, "nachher"] });
        else {
          expect({ ...label, link: parts.filter(p => p.includes(`<a href="${href}">x</a>`)).length }).toEqual({ ...label, link: 1 });
          expect({ ...label, inner: parts.some(p => p.includes(`<${tag}>`)) }).toEqual({ ...label, inner: false });
        }
      }
    }
  });

  test("Sprachkennung genau auf der Grenze: Inhalt aus Zeichen oder mit Entity", () => {
    const max = 100;
    const frameWithout = '<pre><code class="language-"></code></pre>'.length;
    for (const [code, unit] of [["a".repeat(10), 1], ["a&b\nc&d", "&amp;".length]] as const) {
      for (const slack of [-1, 0, 1]) {
        const lang = "l".repeat(max + slack - unit - frameWithout);
        const md = `\`\`\`${lang}\n${code}\n\`\`\``;
        const parts = renderTelegram(md, max);
        const label = { code, slack };
        expectValid(parts, max);
        expect(parts.map(p => htmlText(p)).join("")).toBe(code);
        const withLang = parts.filter(p => p.startsWith(`<pre><code class="language-${lang}">`)).length;
        const plain = parts.filter(p => p.startsWith("<pre><code>")).length;
        expect({ ...label, withLang, plain }).toEqual({ ...label, withLang: slack <= 0 ? parts.length : 0, plain: slack <= 0 ? 0 : parts.length });
        if (slack <= 0) expectSameStyle(parts, md);
      }
    }
  });
});
