/**
 * Issue #249, Checkbox 3: vorlesbare Fassung einer Antwort (speakable,
 * speakSegments). Reine Funktion, kein Modell.
 */

import { describe, expect, test } from "bun:test";
import { toApiMessage } from "../src/web/chat";
import { renderMarkdown } from "../src/web/markdown";
import {
  SPEAK_SEGMENT_MAX_CHARS,
  SPEAKABLE_CODE_NOTE,
  SPEAKABLE_MAX_CHARS,
  SPEAKABLE_REST_NOTE,
  SPEAKABLE_TABLE_NOTE,
  splitSentences,
  toSpeakable,
} from "../src/web/speakable";

describe("toSpeakable", () => {
  test("einfacher Text bleibt, Hervorhebungen fallen weg", () => {
    expect(toSpeakable("Das ist **wichtig** und _das_ ~~nicht~~ auch.")).toEqual({
      speakable: "Das ist wichtig und das nicht auch.",
      speakSegments: ["Das ist wichtig und das nicht auch."],
    });
  });

  test("Überschriften werden zu Sätzen", () => {
    const { speakable, speakSegments } = toSpeakable("## Wetter morgen\n\nEs wird sonnig.\n\n### Und danach?\n\nRegen.");
    expect(speakable).toBe("Wetter morgen. Es wird sonnig. Und danach? Regen.");
    // Kurze Sätze teilen sich ein Segment
    expect(speakSegments).toEqual(["Wetter morgen. Es wird sonnig. Und danach? Regen."]);
  });

  test("Liste: jeder Punkt ein Satz, ohne Aufzählungszeichen und Nummern", () => {
    const { speakable, speakSegments } = toSpeakable("Du brauchst:\n\n- Mehl\n- zwei Eier,\n- Milch.\n\n1. Erst rühren\n2. Dann backen!");
    expect(speakable).toBe("Du brauchst: Mehl. zwei Eier. Milch. Erst rühren. Dann backen!");
    // „Du brauchst:" und die kurzen Punkte teilen sich ein Segment
    expect(speakSegments).toEqual(["Du brauchst: Mehl. zwei Eier. Milch. Erst rühren. Dann backen!"]);
    expect(speakable).not.toMatch(/[-*]\s|\d\.\s/);
  });

  test("verschachtelte Liste und Aufgabenliste", () => {
    expect(toSpeakable("- außen\n  - innen eins\n  - innen zwei\n- [x] erledigt\n- [ ] offen").speakable).toBe(
      "außen innen eins. innen zwei. erledigt. offen."
    );
  });

  test("Tabelle wird durch einen Satz ersetzt, kein Strich bleibt", () => {
    const { speakable } = toSpeakable("Die Zahlen:\n\n| Monat | Umsatz |\n|---|---|\n| Mai | 10 |\n| Juni | 12 |\n\nMehr nicht.");
    expect(speakable).toBe(`Die Zahlen: ${SPEAKABLE_TABLE_NOTE} Mehr nicht.`);
    expect(speakable).not.toContain("|");
  });

  test("Codeblock wird durch einen Satz ersetzt, Inline-Code bleibt als Wort ohne Backticks", () => {
    const { speakable } = toSpeakable("Ruf `npm install` auf:\n\n```bash\nnpm install\n```\n\n~~~\nzweiter Block\n~~~\n\nFertig.");
    expect(speakable).toBe(`Ruf npm install auf: ${SPEAKABLE_CODE_NOTE} Fertig.`);
    expect(speakable).not.toContain("`");
  });

  test("Akzeptanz: Antwort mit Tabelle und Codeblock enthält weder | noch Backticks", () => {
    const answer = [
      "# Ergebnis",
      "",
      "| Name | Wert |",
      "|:-----|-----:|",
      "| a `x` | 1 \\| 2 |",
      "",
      "```ts",
      "const a = b | c;",
      "```",
      "",
      "Ein einzelner ` Backtick und ein | Strich im Text.",
    ].join("\n");
    const { speakable, speakSegments } = toSpeakable(answer);
    expect(speakable).not.toContain("|");
    expect(speakable).not.toContain("`");
    expect(speakSegments.join(" ")).toBe(speakable);
    expect(speakable).toContain(SPEAKABLE_TABLE_NOTE);
    expect(speakable).toContain(SPEAKABLE_CODE_NOTE);
    expect(speakable).not.toContain("const a");
  });

  test("Links nur mit Text; nackte Adressen nur mit dem Namen der Seite; Bilder mit ihrem Text", () => {
    const { speakable } = toSpeakable(
      "Schau in die [Anleitung](https://docs.example.org/a/b?c=1) oder auf https://www.example.com/pfad?x=1 und <https://tybo.ai>. ![Ein Diagramm](https://x.example/d.png)"
    );
    expect(speakable).toBe("Schau in die Anleitung oder auf example.com und tybo.ai. Ein Diagramm");
    expect(speakable).not.toContain("http");
    expect(speakable).not.toContain("docs.example.org");
  });

  test("Emojis fallen weg, auch zusammengesetzte, Flaggen und Tasten", () => {
    expect(toSpeakable("Fertig ✅ 🎉! Familie 👨‍👩‍👧 winkt 👋🏽, Flagge 🇩🇪, Taste 1️⃣.").speakable).toBe("Fertig! Familie winkt, Flagge, Taste 1.");
    expect(toSpeakable("😀").speakable).toBe("");
    expect(toSpeakable("😀").speakSegments).toEqual([]);
  });

  test("Steuer-Tags, rohes HTML und Trennlinien fallen weg, Zitate bleiben", () => {
    const { speakable } = toSpeakable("Gemerkt. [REMEMBER: mag Tee]\n\n---\n\n<div>roh</div>\n\n> Zitat mit <b>fett</b> &amp; mehr\n\n[INVOKE:research|Frage]");
    expect(speakable).toBe("Gemerkt. Zitat mit fett & mehr");
    expect(speakable).not.toContain("REMEMBER");
    expect(speakable).not.toContain("<");
  });

  test("Kürzung: höchstens 2.000 Zeichen samt Schlusssatz, an einer Satzgrenze", () => {
    const sentence = "Dies ist ein Satz mit genau so vielen Wörtern, dass er gut hundert Zeichen lang ist, damit es passt.";
    const long = Array.from({ length: 40 }, (_, i) => `${i + 1}: ${sentence}`).join(" ");
    const { speakable, speakSegments } = toSpeakable(long);
    expect([...speakable].length).toBeLessThanOrEqual(SPEAKABLE_MAX_CHARS);
    expect([...speakable].length).toBeGreaterThan(SPEAKABLE_MAX_CHARS - 200);
    expect(speakable.endsWith(` passt. ${SPEAKABLE_REST_NOTE}`)).toBe(true);
    expect(speakSegments[speakSegments.length - 1].endsWith(SPEAKABLE_REST_NOTE)).toBe(true);
    expect(speakSegments.join(" ")).toBe(speakable);
  });

  test("genau an der Grenze wird nicht gekürzt", () => {
    // 19 Sätze mit 99 Zeichen, einer mit 100, dazwischen 19 Leerzeichen: genau 2.000
    const sentences = Array.from({ length: 20 }, (_, i) => `${"Wort ".repeat(19)}${i === 0 ? "Ende" : "End"}.`);
    const text = sentences.join(" ");
    expect([...text].length).toBe(SPEAKABLE_MAX_CHARS);
    const { speakable, speakSegments } = toSpeakable(text);
    expect(speakable).toBe(text);
    expect(speakSegments).toHaveLength(20);
    expect(speakable).not.toContain(SPEAKABLE_REST_NOTE);
    const over = toSpeakable(`${text} Noch einer.`).speakable;
    expect(over.endsWith(SPEAKABLE_REST_NOTE)).toBe(true);
    expect([...over].length).toBeLessThanOrEqual(SPEAKABLE_MAX_CHARS);
  });

  test("Segmente: ein Satz je Segment, damit die Ausgabe früh beginnt; kurze Sätze hängen am nächsten", () => {
    const first = "Morgen wird es in ganz Norddeutschland sonnig und warm.";
    const second = "Am Nachmittag ziehen von Westen her ein paar Wolken auf.";
    expect(toSpeakable(`${first} ${second} Ja. Nein.`).speakSegments).toEqual([first, `${second} Ja. Nein.`]);
    expect(toSpeakable(`Ja. ${first} ${second}`).speakSegments).toEqual([`Ja. ${first}`, second]);
    expect(toSpeakable("Ja.").speakSegments).toEqual(["Ja."]);
  });

  test("Segmente passen in einen Aufruf der Sprachausgabe: lange Sätze werden an Kommas geteilt", () => {
    const long = `${Array.from({ length: 150 }, (_, i) => `Teil ${i + 1} des Satzes`).join(", ")}.`;
    const { speakSegments, speakable } = toSpeakable(long);
    expect(speakSegments.length).toBeGreaterThan(1);
    for (const s of speakSegments) expect([...s].length).toBeLessThanOrEqual(SPEAK_SEGMENT_MAX_CHARS);
    expect(speakSegments[0].endsWith(",")).toBe(true);
    expect(speakSegments.join(" ")).toBe(speakable);
    // Ohne Leerzeichen: harte Teilung
    for (const s of toSpeakable("x".repeat(1500)).speakSegments) expect([...s].length).toBeLessThanOrEqual(SPEAK_SEGMENT_MAX_CHARS);
  });

  test("splitSentences: Abkürzungen, Ordnungszahlen und Dezimalzahlen trennen nicht", () => {
    expect(splitSentences("Das ist z. B. am 3. Oktober so. Und dann? Ja! Dr. Müller kommt um 8.30 Uhr. Version 2.14.0 ist da: gut.")).toEqual([
      "Das ist z. B. am 3. Oktober so.",
      "Und dann?",
      "Ja!",
      "Dr. Müller kommt um 8.30 Uhr.",
      "Version 2.14.0 ist da: gut.",
    ]);
    expect(splitSentences("Er sagte: „Komm!“ Dann ging er … Und weg.")).toEqual(["Er sagte: „Komm!“", "Dann ging er …", "Und weg."]);
    expect(splitSentences("")).toEqual([]);
  });
});

describe("toApiMessage", () => {
  const base = { id: "m1", createdAt: "2026-09-30T10:00:00.000Z" };

  test("Antwort auf Gesprochenes: speakable und speakSegments dazu, Anzeige unverändert", () => {
    const text = "## Plan\n\n- eins\n- zwei 😀\n\n```js\nx()\n```";
    const spoken = toApiMessage({ ...base, role: "assistant", text, speech: true });
    const typed = toApiMessage({ ...base, role: "assistant", text });
    expect(spoken.speakable).toBe(`Plan. eins. zwei. ${SPEAKABLE_CODE_NOTE}`);
    expect(spoken.speakSegments).toEqual([`Plan. eins. zwei. ${SPEAKABLE_CODE_NOTE}`]);
    expect(spoken.text).toBe(text);
    expect(spoken.html).toBe(renderMarkdown(text));
    expect(spoken.html).toBe(typed.html!);
    expect(spoken.copyText).toBe(typed.copyText!);
    expect("speech" in spoken).toBe(false);
    expect(typed.speakable).toBeUndefined();
    expect(typed.speakSegments).toBeUndefined();
  });

  test("gesprochene Nutzernachricht: source speech; sonst kein source, nie das interne Feld", () => {
    const spoken = toApiMessage({ ...base, role: "user", text: "Hallo", speech: true });
    expect(spoken).toEqual({ ...base, role: "user", text: "Hallo", source: "speech" });
    expect(toApiMessage({ ...base, role: "user", text: "Hallo" })).toEqual({ ...base, role: "user", text: "Hallo" });
    // Nur die eigene Markierung zählt: ein fremdes source oder ein anderer Wert ergibt nichts
    expect(toApiMessage({ ...base, role: "user", text: "Hallo", source: "speech" }).source).toBeUndefined();
    expect(toApiMessage({ ...base, role: "user", text: "Hallo", speech: "ja" } as any).source).toBeUndefined();
    expect(toApiMessage({ ...base, role: "error", text: "Abgebrochen.", speech: true } as any)).toEqual({ ...base, role: "error", text: "Abgebrochen." });
  });

  test("Meldungen bekommen nie eine vorlesbare Fassung", () => {
    const notice = toApiMessage({ ...base, role: "assistant", text: "Job fertig", kind: "notice", source: "job", speech: true } as any);
    expect(notice.speakable).toBeUndefined();
    expect(notice.source).toBe("job");
  });
});
