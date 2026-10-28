/**
 * Issue #382: Rückfrage in einer Antwort erkennen und die Knöpfe dazu
 * (genutzt von Aufträgen aus Anrufen, src/lib/phone/task-turn.ts),
 * festgehalten vor dem Neuschreiben der früheren task-queue.ts.
 *
 * Eine Rückfrage liegt vor, wenn die letzte nicht leere Zeile auf „?“ endet
 * und es mindestens zwei nummerierte Punkte oder eine englische
 * Auswahl-Wendung gibt. Ohne Nummern gibt es bei Ja/Nein-Fragen zwei feste
 * Knöpfe. Höchstens sechs Optionen, Beschriftung auf 64 Zeichen gekürzt.
 * Knöpfe: je Option eine Zeile mit atask:<auftrag>:<wert>, darunter immer
 * „Cancel task“ mit atask:<auftrag>:cancel.
 */
import { describe, expect, test } from "bun:test";
import { detectTaskQuestion, taskQuestionKeyboard } from "../src/lib/task-question";

describe("detectTaskQuestion", () => {
  test("leer oder nur Leerraum: keine Rückfrage", () => {
    for (const output of ["", "  \n\t "]) {
      expect(detectTaskQuestion(output)).toEqual({ text: "", needsInput: false, question: null, options: [] });
    }
  });

  test("nummerierte Punkte und Frage am Ende: Optionen aus den Punkten", () => {
    const output = "  Zwei Wege:\n1. Schnell bauen\n2.   Gründlich bauen  \n\nWhich option do you want?\n";
    expect(detectTaskQuestion(output)).toEqual({
      text: "Zwei Wege:\n1. Schnell bauen\n2.   Gründlich bauen  \n\nWhich option do you want?",
      needsInput: true,
      question: "Which option do you want?",
      options: [
        { label: "1. Schnell bauen", value: "1" },
        { label: "2. Gründlich bauen", value: "2" },
      ],
    });
  });

  test("Punkte ohne Frage am Ende: keine Rückfrage, die Punkte stehen trotzdem in options", () => {
    const parsed = detectTaskQuestion("1. Alpha\n2. Beta\nFertig.");
    expect(parsed.needsInput).toBe(false);
    expect(parsed.question).toBeNull();
    expect(parsed.options).toEqual([
      { label: "1. Alpha", value: "1" },
      { label: "2. Beta", value: "2" },
    ]);
  });

  test("nur ein Punkt und keine Wendung: keine Rückfrage", () => {
    expect(detectTaskQuestion("1. Alpha\nPasst das?").needsInput).toBe(false);
  });

  test("Ja/Nein-Frage ohne Nummern: zwei feste Knöpfe", () => {
    const parsed = detectTaskQuestion("Der Plan steht.\nShould I deploy it now?");
    expect(parsed).toEqual({
      text: "Der Plan steht.\nShould I deploy it now?",
      needsInput: true,
      question: "Should I deploy it now?",
      options: ["Yes, go ahead|yes", "No, skip|no"].map(pair => ({ label: pair.split("|")[0], value: pair.split("|")[1] })),
    });
  });

  test("Wendung irgendwo im Text, Ja/Nein-Muster in der letzten Zeile: Ja/Nein", () => {
    const parsed = detectTaskQuestion("Please choose carefully.\nCan I proceed?");
    expect(parsed.needsInput).toBe(true);
    expect(parsed.options.map(o => o.value)).toEqual(["yes", "no"]);
  });

  test("Wendung ohne Ja/Nein-Muster: Rückfrage ohne Optionen", () => {
    expect(detectTaskQuestion("What do you think about the colors?")).toEqual({
      text: "What do you think about the colors?",
      needsInput: true,
      question: "What do you think about the colors?",
      options: [],
    });
  });

  test("Frage ohne Wendung und ohne Punkte: keine Rückfrage", () => {
    expect(detectTaskQuestion("Wie spät ist es?")).toEqual({ text: "Wie spät ist es?", needsInput: false, question: null, options: [] });
  });

  test("höchstens sechs Optionen, Beschriftung auf 64 Zeichen", () => {
    const long = "x".repeat(80);
    const lines = Array.from({ length: 8 }, (_, i) => `${i + 1}. ${i === 0 ? long : `Weg ${i + 1}`}`);
    const parsed = detectTaskQuestion(`${lines.join("\n")}\nWhich one?`);
    expect(parsed.needsInput).toBe(true);
    expect(parsed.options).toHaveLength(6);
    expect(parsed.options[0]).toEqual({ label: `1. ${"x".repeat(64)}`, value: "1" });
    expect(parsed.options[5]).toEqual({ label: "6. Weg 6", value: "6" });
  });
});

describe("taskQuestionKeyboard", () => {
  test("je Option eine Zeile, darunter Abbrechen", () => {
    const keyboard = taskQuestionKeyboard("t-1", [
      { label: "1. Alpha", value: "1" },
      { label: "Yes, go ahead", value: "yes" },
    ]);
    expect(keyboard.inline_keyboard).toEqual([
      [{ text: "1. Alpha", callback_data: "atask:t-1:1" }],
      [{ text: "Yes, go ahead", callback_data: "atask:t-1:yes" }],
      [{ text: "Cancel task", callback_data: "atask:t-1:cancel" }],
    ]);
  });

  test("ohne Optionen nur Abbrechen", () => {
    expect(taskQuestionKeyboard("t-2", []).inline_keyboard).toEqual([[{ text: "Cancel task", callback_data: "atask:t-2:cancel" }]]);
  });
});
