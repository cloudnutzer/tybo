/**
 * Issue #255: Satz-Strom des Telefonhörers und strenger Tag-Filter.
 * Die Satzgrenze teilt sich SentenceStream mit splitSentences (V2,
 * tests/web-speakable.test.ts).
 */
import { describe, expect, test } from "bun:test";
import { nextSentenceEnd, SentenceStream, splitSentences, type SentenceStreamOptions } from "../src/lib/voice-brain/sentences";
import { stripTags, TagFilter } from "../src/lib/voice-brain/tags";
import { splitSentences as speakableSplit } from "../src/web/speakable";

/** Füttert den Strom Stück für Stück; merkt sich, nach welchem Stück ein Abschnitt kam (-1: erst beim flush) */
function feed(chunks: string[], options?: SentenceStreamOptions) {
  const stream = new SentenceStream(options);
  const out: { text: string; after: number }[] = [];
  chunks.forEach((chunk, i) => {
    for (const text of stream.push(chunk)) out.push({ text, after: i });
  });
  for (const text of stream.flush()) out.push({ text, after: -1 });
  return out;
}

const texts = (out: { text: string }[]) => out.map((o) => o.text);
const INTENT_TAG = /\[(REMEMBER|GOAL|DONE|CANCEL|FORGET|KNOWLEDGE|INVOKE|ASSET_DESC)/i;

describe("SentenceStream", () => {
  test("drei Sätze ergeben drei Abschnitte in Reihenfolge, der erste vor dem Ende des Stroms", () => {
    const out = feed(["Heute ist es son", "nig in Berlin. Morgen wird es reg", "nerisch und kühl. Am Wochenende ", "kommt die Sonne zurück."], { earlyFirst: false });
    expect(texts(out)).toEqual(["Heute ist es sonnig in Berlin.", "Morgen wird es regnerisch und kühl.", "Am Wochenende kommt die Sonne zurück."]);
    // Erster Abschnitt, sobald das nächste Wort beginnt: nach dem zweiten Stück, lange vor dem Ende
    expect(out[0].after).toBe(1);
    expect(out[1].after).toBe(2);
    expect(out[2].after).toBe(-1);
  });

  test("ein Satz über mehrere Textstücke, Leerraum am Stückende wartet auf das nächste Zeichen", () => {
    const stream = new SentenceStream();
    expect(stream.push("Das ist ein ")).toEqual([]);
    expect(stream.push("ganzer Satz. ")).toEqual([]);
    // Kleinbuchstabe hätte den Satz fortgesetzt; erst das große „D" entscheidet
    expect(stream.push("Danach")).toEqual(["Das ist ein ganzer Satz."]);
    expect(stream.flush()).toEqual(["Danach"]);
  });

  test("„30. September“, „z. B.“, „bzw.“, „Dr.“ und „2.450 Euro“ beenden keinen Satz", () => {
    const out = feed([
      "Am 30. September kam Dr. Weber vorbei, z. B. wegen der Rechnung bzw. der Mahnung. ",
      "Die Rechnung lag bei 2.450 Euro. ",
      "Das war es.",
    ]);
    expect(texts(out)).toEqual([
      "Am 30. September kam Dr. Weber vorbei, z. B. wegen der Rechnung bzw. der Mahnung.",
      "Die Rechnung lag bei 2.450 Euro.",
      "Das war es.",
    ]);
  });

  test("Zahl am Satzende vor einem Großbuchstaben: kein Satzende (Ordnungszahl)", () => {
    expect(texts(feed(["Wir treffen uns am 3. Oktober im Büro. Gut so?"]))).toEqual(["Wir treffen uns am 3. Oktober im Büro.", "Gut so?"]);
  });

  test("kein Satzende vor dem 12. Zeichen: kurze Sätze hängen am nächsten", () => {
    expect(texts(feed(["Ja. Das passt mir gut. Okay."]))).toEqual(["Ja. Das passt mir gut.", "Okay."]);
  });

  test("früher erster Abschnitt am Komma nach mindestens 25 Zeichen, danach nur an Satzenden", () => {
    const out = feed(["Das Wetter morgen in Hamburg", " wird wechselhaft, mit Schauern am Nachmittag", ", Wind aus Westen und kühlen Temperaturen. ", "Nimm einen Schirm mit."], { earlyFirst: true });
    expect(texts(out)).toEqual([
      "Das Wetter morgen in Hamburg wird wechselhaft,",
      "mit Schauern am Nachmittag, Wind aus Westen und kühlen Temperaturen.",
      "Nimm einen Schirm mit.",
    ]);
    expect(out[0].after).toBe(1);
  });

  test("früher erster Abschnitt nicht vor 25 Zeichen und nicht mitten in „1, 2, 3“", () => {
    expect(texts(feed(["Kurz, knapp und gut gesagt. Weiter."], { earlyFirst: true }))).toEqual(["Kurz, knapp und gut gesagt.", "Weiter."]);
    expect(texts(feed(["Die Gewinnzahlen heute sind 1, 2, 3 und noch zwei mehr. Viel Glück."], { earlyFirst: true }))[0]).toBe(
      "Die Gewinnzahlen heute sind 1, 2, 3 und noch zwei mehr."
    );
    // Ohne earlyFirst wartet der erste Abschnitt auf das Satzende
    expect(texts(feed(["Das Wetter morgen in Hamburg wird wechselhaft, mit Schauern. "], { earlyFirst: false }))).toEqual([
      "Das Wetter morgen in Hamburg wird wechselhaft, mit Schauern.",
    ]);
  });

  test("Abschnitt über 240 Zeichen wird an der letzten Wortgrenze geteilt, schon während des Stroms", () => {
    const words = Array.from({ length: 60 }, (_, i) => `wort${i}`).join(" ");
    const stream = new SentenceStream();
    const early = stream.push(words);
    expect(early.length).toBe(1);
    expect([...early[0]].length).toBeLessThanOrEqual(240);
    expect(words.startsWith(early[0] + " ")).toBe(true);
    const rest = stream.flush();
    expect([early[0], ...rest].join(" ")).toBe(words);
    for (const part of rest) expect([...part].length).toBeLessThanOrEqual(240);
  });

  test("ein langer Satz, der am Stück kommt, wird ebenfalls geteilt", () => {
    const sentence = `${"sehr ".repeat(70)}lang.`;
    const out = texts(feed([sentence + " Ende gut, alles gut."]));
    for (const part of out) expect([...part].length).toBeLessThanOrEqual(240);
    expect(out.join(" ")).toBe(`${sentence.trim()} Ende gut, alles gut.`);
  });

  test("Antwort aus einem einzigen Satz ohne Leerraum am Ende kommt beim flush", () => {
    const stream = new SentenceStream();
    expect(stream.push("Gern geschehen, bis später!")).toEqual([]);
    expect(stream.flush()).toEqual(["Gern geschehen, bis später!"]);
  });

  test("Zeilenumbruch beendet einen Abschnitt", () => {
    expect(texts(feed(["Erster Gedanke ohne Punkt\nZweiter Gedanke hier"]))).toEqual(["Erster Gedanke ohne Punkt", "Zweiter Gedanke hier"]);
  });

  test("Merk-Tag mitten im Strom erscheint in keinem Abschnitt", () => {
    const out = feed(["Klar, das merke ich mir. [REMEM", "BER: Alex trinkt gern ", "Tee] Sonst noch etwas für dich?", " [GOAL: Tee kaufen | DEADLINE: Montag]"], { earlyFirst: true });
    expect(texts(out)).toEqual(["Klar, das merke ich mir.", "Sonst noch etwas für dich?"]);
    for (const o of out) expect(o.text).not.toMatch(INTENT_TAG);
  });

  test("angefangenes Tag am Ende des Stroms wird nicht vorgelesen", () => {
    const out = feed(["Das merke ich mir gerne für dich. [REMEMBER: Alex mag"]);
    expect(texts(out)).toEqual(["Das merke ich mir gerne für dich."]);
    const cut = feed(["Das merke ich mir gerne für dich. [REMEM"]);
    expect(texts(cut)).toEqual(["Das merke ich mir gerne für dich."]);
  });

  test("normale eckige Klammern bleiben", () => {
    expect(texts(feed(["Laut Shop [Stand heute] kostet es 20 Euro. Passt das?"]))).toEqual(["Laut Shop [Stand heute] kostet es 20 Euro.", "Passt das?"]);
  });
});

describe("TagFilter streng", () => {
  test("offenes Tag über 400 Zeichen bleibt zurück (Brücke: wird ausgegeben)", () => {
    const long = `[REMEMBER: ${"x".repeat(450)}`;
    const strict = new TagFilter({ strict: true });
    expect(strict.push(long)).toBe("");
    expect(strict.flush()).toBe("");
    const phone = new TagFilter();
    expect(phone.push(long)).toBe(long);
  });

  test("unvollständiges Präfix beim flush: streng verworfen, Brücke wie bisher", () => {
    const strict = new TagFilter({ strict: true });
    expect(strict.push("Gut. [REMEM")).toBe("Gut. ");
    expect(strict.flush()).toBe("");
    const phone = new TagFilter();
    expect(phone.push("Gut. [REMEM")).toBe("Gut. ");
    expect(phone.flush()).toBe("[REMEM");
  });

  test("Klammer, aus der kein Tag werden kann, geht sofort weiter", () => {
    const strict = new TagFilter({ strict: true });
    expect(strict.push("Preis [laut")).toBe("Preis [laut");
    expect(strict.push(" Shop] ok")).toBe(" Shop] ok");
    expect(strict.push(" [REMEMBERED")).toBe(" [REMEMBERED");
    expect(strict.flush()).toBe("");
  });

  // phone: Ausgabe der Brücke (unverändert), nur wo sie den ganzen Text durchreicht
  const NESTED: { text: string; spoken: string; phone?: string }[] = [
    { text: "Gut [laut [REMEMBER: Alex mag Tee] Shop] ok", spoken: "Gut [laut  Shop] ok", phone: "Gut [laut [REMEMBER: Alex mag Tee] Shop] ok" },
    { text: "Gut [Notiz [GOAL: Tee kaufen | DEADLINE: Montag] fertig] ok", spoken: "Gut [Notiz  fertig] ok", phone: "Gut [Notiz [GOAL: Tee kaufen | DEADLINE: Montag] fertig] ok" },
    // Tag mit zusätzlicher innerer Klammer, in gewöhnlicher Klammer und direkt
    { text: "Gut [Notiz [REMEMBER: Alex mag [grünen] Tee]] ok", spoken: "Gut [Notiz ] ok", phone: "Gut [Notiz [REMEMBER: Alex mag [grünen] Tee]] ok" },
    { text: "Gut [Notiz [GOAL: [grünen] Tee kaufen | DEADLINE: Montag]] ok", spoken: "Gut [Notiz ] ok", phone: "Gut [Notiz [GOAL: [grünen] Tee kaufen | DEADLINE: Montag]] ok" },
    { text: "Gut [REMEMBER: Alex mag [grünen] Tee] ok", spoken: "Gut  ok" },
    { text: "Gut [GOAL: [grünen] Tee kaufen | DEADLINE: Montag] ok", spoken: "Gut  ok" },
  ];

  test("verschachteltes Tag in gewöhnlicher Klammer als ein Textstück: streng entfernt, Brücke wie bisher", () => {
    for (const { text, spoken, phone } of NESTED) {
      const strict = new TagFilter({ strict: true });
      expect(strict.push(text) + strict.flush()).toBe(spoken);
      if (phone === undefined) continue;
      const bridge = new TagFilter();
      expect(bridge.push(text) + bridge.flush()).toBe(phone);
    }
  });

  test("verschachteltes Tag mit jeder Stückgrenze: streng nie ausgegeben", () => {
    for (const { text, spoken } of NESTED) {
      for (let a = 1; a < text.length; a++) {
        for (const b of [a + 1, a + 3, a + 7, text.length]) {
          if (b > text.length) continue;
          const strict = new TagFilter({ strict: true });
          const out = strict.push(text.slice(0, a)) + strict.push(text.slice(a, b)) + strict.push(text.slice(b)) + strict.flush();
          expect(out).toBe(spoken);
          expect(out).not.toMatch(INTENT_TAG);
        }
      }
    }
  });

  test("Tag mit innerer Klammer über SentenceStream, mit jeder Stückgrenze: nie vorgelesen", () => {
    const cases = [
      { text: "Das merke ich mir. [Notiz [REMEMBER: Alex mag [grünen] Tee]] Bis bald.", spoken: ["Das merke ich mir.", "[Notiz ] Bis bald."] },
      { text: "Das merke ich mir. [GOAL: [grünen] Tee kaufen | DEADLINE: Montag] Bis bald.", spoken: ["Das merke ich mir.", "Bis bald."] },
    ];
    for (const { text, spoken } of cases) {
      expect(texts(feed([text]))).toEqual(spoken);
      for (let a = 1; a < text.length; a++) {
        for (const b of [a + 1, a + 4, text.length]) {
          if (b > text.length) continue;
          const out = texts(feed([text.slice(0, a), text.slice(a, b), text.slice(b)]));
          expect(out).toEqual(spoken);
          for (const t of out) expect(t).not.toMatch(INTENT_TAG);
        }
      }
    }
  });
});

describe("eine Satzregel für V2 und V3", () => {
  test("speakable nutzt dieselbe Funktion", () => {
    expect(speakableSplit).toBe(splitSentences);
  });

  test("nextSentenceEnd: im laufenden Strom wartet eine Grenze am Textende", () => {
    expect(nextSentenceEnd("Das ist gut. ", 0, { final: false })).toBe(-1);
    expect(nextSentenceEnd("Das ist gut. ", 0, { final: true })).toBe(13);
    expect(nextSentenceEnd("Das ist gut. und", 0, { final: false })).toBe(-1);
    expect(nextSentenceEnd("Das ist gut. Und", 0, { final: false })).toBe(13);
  });
});

describe("KNOWLEDGE ist ein Steuer-Tag (Issue #317)", () => {
  const TAG = "[KNOWLEDGE: reference | Rahmengröße | Der Rahmen hat 56 cm | Rad]";
  const text = `Gern. ${TAG} Bis morgen.`;

  test("vollständiges Tag: Brücke und streng entfernen es", () => {
    expect(stripTags(text)).toBe("Gern.  Bis morgen.");
    const strict = new TagFilter({ strict: true });
    expect(strict.push(text) + strict.flush()).toBe("Gern.  Bis morgen.");
  });

  test("streng, mit jeder Stückgrenze: nie ausgegeben", () => {
    for (let a = 1; a < text.length; a++) {
      for (const b of [a + 1, a + 4, text.length]) {
        if (b > text.length) continue;
        const strict = new TagFilter({ strict: true });
        const out = strict.push(text.slice(0, a)) + strict.push(text.slice(a, b)) + strict.push(text.slice(b)) + strict.flush();
        expect(out).toBe("Gern.  Bis morgen.");
      }
    }
  });

  test("streng: unvollständiges Präfix und offenes Tag bleiben zurück", () => {
    for (const rest of ["[KNOW", "[KNOWLEDGE", "[KNOWLEDGE: reference | Rahmen", `[KNOWLEDGE: ${"x".repeat(450)}`]) {
      const strict = new TagFilter({ strict: true });
      expect(strict.push(`Gut. ${rest}`) + strict.flush()).toBe("Gut. ");
    }
  });

  test("über SentenceStream: kein Abschnitt enthält das Tag", () => {
    for (let cut = 1; cut < text.length; cut += 3) {
      const out = texts(feed([text.slice(0, cut), text.slice(cut)], { earlyFirst: false }));
      expect(out.join(" ")).toBe("Gern. Bis morgen.");
      for (const s of out) expect(s).not.toMatch(INTENT_TAG);
    }
  });
});
