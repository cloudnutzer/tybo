/**
 * Issue #325: Fehler-Auswertung der Claude-CLI (src/lib/claude/result.ts).
 * CLI-Signal zuerst, Textmuster nur ohne Signal.
 */
import { describe, expect, test } from "bun:test";
import {
  hasCliSignal,
  isClaudeErrorResponse,
  isCliResultError,
  isCreditLimitError,
  judgeClaudeResult,
} from "../src/lib/claude/result";

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
