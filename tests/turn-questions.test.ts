import { describe, expect, test } from "bun:test";
import { QUESTION_OPTIONS_MAX, QUESTION_TAG_SECTION, renderQuestionTags, scanForQuestion } from "../src/lib/turn-questions";
import { ASK_OPTIONS_MAX } from "../src/lib/ask-choices";
import { buildPromptContext } from "../src/lib/prompt-builder";
import { INVALID_TAG_CASES, MARKER_CASES, NO_QUESTION_CASES, PROTECTED_CASES, TAG_CASES } from "./turn-questions-fixture";

describe("scanForQuestion: Fixtures", () => {
  for (const [group, cases] of [
    ["Tag", TAG_CASES],
    ["ungültiger Tag", INVALID_TAG_CASES],
    ["geschützt", PROTECTED_CASES],
    ["Marker", MARKER_CASES],
    ["keine Rückfrage", NO_QUESTION_CASES],
  ] as const) {
    for (const c of cases) {
      test(`${group}: ${c.name}`, () => {
        expect(scanForQuestion(c.reply).found).toEqual(c.expected);
      });
    }
  }
});

describe("scanForQuestion: lesbare Antwort", () => {
  test("gültiger Tag wird zu Frage und Antwortliste, als eigener Absatz", () => {
    const scan = scanForQuestion("Ich habe drei Wege gefunden. [FRAGE: Welchen nehmen wir? | Bahn | Auto] Sag Bescheid.");
    expect(scan.text).toBe("Ich habe drei Wege gefunden.\n\nWelchen nehmen wir?\n- Bahn\n- Auto\n\nSag Bescheid.");
  });

  test("Tag am Ende nach Leerzeile bleibt ohne zusätzliche Leerzeilen", () => {
    const scan = scanForQuestion("Entwurf fertig.\n\n[FRAGE: Verschicken? | Ja | Nein]");
    expect(scan.text).toBe("Entwurf fertig.\n\nVerschicken?\n- Ja\n- Nein");
  });

  test("ungültige Tags bleiben als Text lesbar", () => {
    expect(scanForQuestion("Fertig.\n[FRAGE: Soll ich weitermachen?]").text).toBe("Fertig.\n\nSoll ich weitermachen?");
    expect(scanForQuestion("[FRAGE: Erst A? | Ja | Nein]\n[FRAGE: Dann B? | Ja]").text).toBe(
      "Erst A?\n- Ja\n- Nein\n\nDann B?\n- Ja"
    );
  });

  test("Tag in Code bleibt unverändert und zählt nicht", () => {
    const reply = "Beispiel:\n\n```\n[FRAGE: Soll ich? | Ja | Nein]\n```\n\nUnd inline: `[FRAGE: X? | A]`";
    const scan = scanForQuestion(reply);
    expect(scan.text).toBe(reply);
    expect(scan.found).toBeNull();
  });

  test("Tags in Zitat, Anführungszeichen und eingerücktem Code bleiben unverändert", () => {
    for (const c of PROTECTED_CASES.filter(c => c.expected === null)) expect(scanForQuestion(c.reply).text).toBe(c.reply);
  });

  test("angefangener Tag bleibt stehen, ein vollständiger daneben wird lesbar, aber keine Rückfrage", () => {
    const missing = "Entwurf fertig. [FRAGE: Soll ich ihn verschicken | Ja | Nein\n\nSoll ich ihn verschicken?";
    expect(scanForQuestion(missing)).toEqual({ text: missing, found: null });
    const scan = scanForQuestion("[FRAGE: Erst A? | Ja | Nein]\n[FRAGE: Dann B?\n| Ja]");
    expect(scan.text).toBe("Erst A?\n- Ja\n- Nein\n\n[FRAGE: Dann B?\n| Ja]");
    expect(scan.found).toBeNull();
  });

  test("Marker-Rückfall ändert den Text nicht", () => {
    const reply = "Liste sortiert.\n\nSoll ich die doppelten löschen?";
    expect(scanForQuestion(reply).text).toBe(reply);
  });

  test("renderQuestionTags liefert dieselbe lesbare Fassung", () => {
    expect(renderQuestionTags("A [FRAGE: B? | C] D")).toBe("A\n\nB?\n- C\n\nD");
    expect(renderQuestionTags("ohne Tag")).toBe("ohne Tag");
  });
});

describe("scanForQuestion: Grenzen", () => {
  test("Höchstzahl der Antworten wie im Register", () => {
    expect(QUESTION_OPTIONS_MAX).toBe(ASK_OPTIONS_MAX);
    const eight = Array.from({ length: 8 }, (_, i) => `A${i}`).join(" | ");
    expect(scanForQuestion(`[FRAGE: Welche? | ${eight}]`).found?.options).toHaveLength(8);
  });

  test("Liste, die nicht bei 1 beginnt oder springt, ergibt keine Auswahl", () => {
    expect(scanForQuestion("2. A\n3. B\n\nWelche nehmen wir?").found).toBeNull();
    expect(scanForQuestion("1. A\n3. B\n\nWelche nehmen wir?").found).toBeNull();
  });

  test("Ja-Nein-Frage nach einer Schrittliste bekommt Ja und Nein, nicht die Schritte", () => {
    const found = scanForQuestion("Plan:\n1. Backup\n2. Update\n3. Neustart\n\nSoll ich loslegen?").found;
    expect(found).toEqual({ question: "Soll ich loslegen?", options: ["Ja", "Nein"], via: "marker" });
  });

  test("Liste mit dem Füllzeichen der Maskierung im Text: sicher abgelehnt statt beschädigter Antworten", () => {
    expect(scanForQuestion("1. A\u0001\n2. B\n\nWelche nehmen wir?").found).toBeNull();
    expect(scanForQuestion("1. A\u0001\n2. B\n\nWhich one should I take?").found).toBeNull();
  });

  test("Marker nur als ganzes Wort", () => {
    expect(scanForQuestion("Sollich das?").found).toBeNull();
    expect(scanForQuestion("Whichever works?").found).toBeNull();
  });

  test("Frage nach einem Codeblock am Ende zählt nicht, wenn der Code zuletzt steht", () => {
    expect(scanForQuestion("Soll ich das so lassen?\n\n```\nx = 1\n```").found).toBeNull();
  });
});

describe("Prompt: Anweisung für den Tag", () => {
  test("Abschnitt beschreibt das Tag-Format", () => {
    expect(QUESTION_TAG_SECTION).toContain("[FRAGE: question | answer 1 | answer 2]");
    expect(QUESTION_TAG_SECTION).toContain("1 to 8");
  });

  test("der volle Prompt enthält den Abschnitt", async () => {
    const { fullPrompt } = await buildPromptContext({ userMessage: "Hallo", chatId: "4242", agentName: "general" });
    expect(fullPrompt).toContain(QUESTION_TAG_SECTION);
  });
});
