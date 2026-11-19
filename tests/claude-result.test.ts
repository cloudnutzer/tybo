/**
 * Issue #325: Fehler-Auswertung der Claude-CLI (src/lib/claude/result.ts).
 * CLI-Signal zuerst; Limit-Meldungen mit den zusätzlichen Regeln aus #652.
 */
import { describe, expect, test } from "bun:test";
import {
  claudeLimitError,
  claudeLimitText,
  hasCliSignal,
  isClaudeErrorResponse,
  isCliResultError,
  isCreditLimitError,
  judgeClaudeResult,
} from "../src/lib/claude/result";

describe("claudeLimitText", () => {
  const messages = [
    ["You've hit your weekly limit · resets Nov 22, 4pm", "usage_limit"],
    ["You've reached your weekly limit", "usage_limit"],
    ["You're out of usage credits.", "quota"],
  ] as const;

  for (const [message, kind] of messages) {
    test.each([message, message.replace("'", "’"), ` \n\t${message.toUpperCase()}`])("erkennt %s", (text) => {
      expect(claudeLimitText(text)).toBe(kind);
    });

    test(`prüft Länge und Anfang: ${kind}, ${message}`, () => {
      expect(claudeLimitText(message.padEnd(499, "."))).toBe(kind);
      expect(claudeLimitText(` \n${message.padEnd(499, ".")}`)).toBe(kind);
      expect(claudeLimitText(message.padEnd(500, "."))).toBeUndefined();
      expect(claudeLimitText(message.padEnd(501, "."))).toBeUndefined();
      expect(claudeLimitText(`Die Meldung lautet: ${message}`)).toBeUndefined();
    });
  }

  test.each(["", " \n\t", "Alles erledigt", "You've hit yourself", "You're out of usage creditsomething"])("kein Limit: %s", (text) => {
    expect(claudeLimitText(text)).toBeUndefined();
  });
});

describe("claudeLimitError", () => {
  test.each([
    { text: "You've hit your weekly limit", rateLimit: undefined, kind: "usage_limit" },
    { text: "You've reached your weekly limit", rateLimit: undefined, kind: "usage_limit" },
    { text: "You're out of usage credits.", rateLimit: undefined, kind: "quota" },
    { text: "", rateLimit: { status: "rejected" }, kind: "usage_limit" },
    // Auch ein fremder CLI-Fehler bekommt bei rejected diese Art (M14-07).
    { text: "error_max_turns", rateLimit: { status: "rejected" }, kind: "usage_limit" },
    { text: "", rateLimit: { errorCode: "credits_required" }, kind: "quota" },
    { text: "You've hit your weekly limit", rateLimit: { errorCode: "credits_required" }, kind: "quota" },
    { text: "You're out of usage credits.", rateLimit: { status: "rejected" }, kind: "quota" },
    { text: "", rateLimit: { status: "rejected", errorCode: "credits_required" }, kind: "quota" },
    { text: "", rateLimit: { status: "allowed" }, kind: undefined },
    { text: "overloaded_error", rateLimit: undefined, kind: undefined },
    { text: "network error", rateLimit: { errorCode: "unknown" }, kind: undefined },
    { text: "", rateLimit: undefined, kind: undefined },
  ])("$text, $rateLimit -> $kind", ({ text, rateLimit, kind }) => {
    expect(claudeLimitError(text, rateLimit)).toBe(kind);
  });
});

describe("judgeClaudeResult", () => {
  test("CLI meldet Erfolg, Text enthält billing: kein Fehler", () => {
    expect(judgeClaudeResult({ is_error: false, subtype: "success" }, "Siehe billing")).toBe(false);
  });

  test("jedes CLI-Signal einzeln führt zum Fehler", () => {
    expect(judgeClaudeResult({ is_error: true }, "alles gut")).toBe(true);
    expect(judgeClaudeResult({ subtype: "error_during_execution" }, "alles gut")).toBe(true);
    expect(judgeClaudeResult({ api_error_status: 500 }, "alles gut")).toBe(true);
  });

  test("ohne CLI-Signal greift das Textmuster", () => {
    expect(judgeClaudeResult({}, "API Error: 429 rate_limit_error")).toBe(true);
    expect(judgeClaudeResult(null, "Du hast dein usage limit erreicht")).toBe(true);
    expect(judgeClaudeResult(undefined, "Alles erledigt")).toBe(false);
  });

  test("null zählt nicht als Signal", () => {
    expect(hasCliSignal({ is_error: null, subtype: null, api_error_status: null })).toBe(false);
    expect(hasCliSignal({ api_error_status: 0 })).toBe(true);
    expect(isCliResultError({ is_error: false, subtype: "success", api_error_status: null })).toBe(false);
  });

  const texts = [
    ["leer", ""],
    ["Leerraum", " \t\n"],
    ["Nutzungsgrenze", "You've hit your weekly limit · resets Nov 22, 4pm"],
    ["Kontingent", "You're out of usage credits."],
    ["Antwort", "Alles erledigt."],
    ["kurzes Zitat am Anfang", "You've hit your weekly limit bedeutet, dass die Woche ausgeschöpft ist."],
    ["langes Zitat am Anfang", "You've hit your weekly limit bedeutet: " + "Erklärung. ".repeat(60)],
  ] as const;
  // Spalten entsprechen texts. Ein kurzes Zitat ist ohne Erfolgssignal oder
  // zusammen mit rejected nicht von der echten Limit-Meldung unterscheidbar.
  const combinations = [
    { cli: "keines", fields: undefined, status: undefined, expected: [false, false, true, true, false, true, false] },
    { cli: "keines", fields: undefined, status: "allowed", expected: [false, false, true, true, false, true, false] },
    { cli: "keines", fields: undefined, status: "rejected", expected: [true, true, true, true, false, true, false] },
    { cli: "Fehler", fields: { subtype: "error_max_turns" }, status: undefined, expected: [true, true, true, true, true, true, true] },
    { cli: "Fehler", fields: { subtype: "error_max_turns" }, status: "allowed", expected: [true, true, true, true, true, true, true] },
    { cli: "Fehler", fields: { subtype: "error_max_turns" }, status: "rejected", expected: [true, true, true, true, true, true, true] },
    { cli: "Erfolg", fields: { is_error: false, subtype: "success" }, status: undefined, expected: [false, false, false, false, false, false, false] },
    { cli: "Erfolg", fields: { is_error: false, subtype: "success" }, status: "allowed", expected: [false, false, false, false, false, false, false] },
    { cli: "Erfolg", fields: { is_error: false, subtype: "success" }, status: "rejected", expected: [true, true, true, true, false, true, false] },
  ];
  for (const { cli, fields, status, expected } of combinations) {
    texts.forEach(([name, text], index) => {
      test(`CLI ${cli}, Status ${status ?? "fehlt"}, ${name}`, () => {
        expect(judgeClaudeResult(fields, text, status ? { status } : undefined)).toBe(expected[index]);
      });
    });
  }

  test("credits_required allein macht einen Lauf nicht zum Fehler", () => {
    for (const fields of [undefined, { is_error: false, subtype: "success" }]) {
      expect(judgeClaudeResult(fields, "", { errorCode: "credits_required" })).toBe(false);
      expect(judgeClaudeResult(fields, "Alles erledigt", { status: "rejected", errorCode: "credits_required" })).toBe(false);
    }
  });
});

describe("isClaudeErrorResponse", () => {
  test("harte Marker unabhängig von der Länge", () => {
    expect(isClaudeErrorResponse("x".repeat(2000) + " OAuth token has expired")).toBe(true);
  });

  test("weiche Marker nur in kurzen Antworten", () => {
    expect(isClaudeErrorResponse("Bitte add funds")).toBe(true);
    expect(isClaudeErrorResponse("Bericht über billing. " + "x".repeat(600))).toBe(false);
  });
});

describe("isCreditLimitError", () => {
  test("nur ausdrückliche Formulierungen", () => {
    expect(isCreditLimitError("Claude usage limit reached")).toBe(true);
    expect(isCreditLimitError("overloaded_error")).toBe(false);
    expect(isCreditLimitError(undefined as unknown as string)).toBe(false);
  });
});

describe("Bisherige Textmuster bleiben unverändert", () => {
  test.each([
    "You've hit your weekly limit · resets Nov 22, 4pm",
    "You've reached your weekly limit",
    "You're out of usage credits.",
  ])("neuer Meldungsanfang erweitert weder Fehlertextmuster noch Abo-Marker: %s", (text) => {
    expect(isClaudeErrorResponse(text)).toBe(false);
    expect(isCreditLimitError(text)).toBe(false);
  });

  test("der bestehende enge Marker hit your limit bleibt wirksam", () => {
    const text = "You've hit your limit · resets Nov 22, 4pm";
    expect(isClaudeErrorResponse(text)).toBe(true);
    expect(isCreditLimitError(text)).toBe(true);
  });
});
