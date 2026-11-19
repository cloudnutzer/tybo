import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { readStream } from "../src/lib/claude/stream";
import { usageFromClaudeReport } from "../src/lib/engines/claude-usage";
import { isUsageWindowId } from "../src/lib/engines/usage";

const at = Date.parse("2026-11-16T22:05:11.000Z");
const measuredAt = new Date(at).toISOString();
const report = (...limits: unknown[]) => ({ rate_limits: { limits } });
const scoped = (display_name: unknown) => ({ kind: "weekly_scoped", percent: 7, scope: { model: { display_name } } });

describe("Verbrauchsbericht abbilden", () => {
  test("Mitschnitt: drei Fenster, Mikrosekunden und UTC-Versatz, Messzeit am Laufende", () => {
    const fixture = readFileSync(new URL("./fixtures/claude-usage-report.jsonl", import.meta.url), "utf8");
    const { outcome } = readStream(fixture.trim().split("\n").map(line => ({ line, at: at - 1000 })));
    expect(usageFromClaudeReport(outcome.usageReport, at)).toEqual([
      { id: "session", percent: 21, resetsAt: "2026-11-17T00:29:59.958Z", measuredAt, source: "report" },
      { id: "weekly_all", percent: 4, resetsAt: "2026-11-21T09:59:59.958Z", measuredAt, source: "report" },
      { id: "weekly_scoped:fable", percent: 7, resetsAt: "2026-11-21T09:59:59.958Z", measuredAt, source: "report" },
    ]);
    expect(outcome.costUsd).toBe(0);
    expect(outcome.rateLimit).toBeUndefined();
  });

  test("bekannte Familien und unbekannte Namen im bestehenden Kennungsformat", () => {
    for (const [name, family] of [["Opus 5.5", "opus"], ["Fable", "fable"], ["Claude SONNET", "sonnet"],
      ["Haiku 5.5", "haiku"], ["Neue Familie!", "neue-familie-"], ["Äpfel", "-pfel"], ["A".repeat(70), "a".repeat(40)]]) {
      const windows = usageFromClaudeReport(report(scoped(name)), at);
      expect(windows.map(w => w.id)).toEqual([`weekly_scoped:${family}`]);
      expect(isUsageWindowId(windows[0].id)).toBe(true);
    }
    for (const name of ["", "   ", "ÄÖ", null, 7]) expect(usageFromClaudeReport(report(scoped(name)), at)).toEqual([]);
  });

  test("unbekannte Arten und surface ohne Modell übergehen", () => {
    expect(usageFromClaudeReport(report(null, [], "Text", { kind: "unbekannt", percent: 90 },
      { kind: "weekly_scoped", percent: 9, scope: { surface: "claude-code" } },
      { kind: "weekly_scoped", percent: 9, scope: null }), at)).toEqual([]);
  });

  test("Prozentzahl begrenzen und runden, Text und nicht endliche Werte verwerfen", () => {
    for (const [percent, expected] of [[130, 100], [-4, 0], [21.5, 22], [21.49, 21]]) {
      expect(usageFromClaudeReport(report({ kind: "session", percent }), at)[0].percent).toBe(expected);
    }
    for (const percent of ["21", null, undefined, NaN, Infinity]) {
      expect(usageFromClaudeReport(report({ kind: "session", percent }), at)).toEqual([]);
    }
  });

  test("unlesbare oder fehlende Reset-Zeit: gültiges Fenster ohne Reset", () => {
    for (const resets_at of ["kaputt", undefined, null, 1794875399958]) {
      expect(usageFromClaudeReport(report({ kind: "session", percent: 21, resets_at }), at)).toEqual([
        { id: "session", percent: 21, measuredAt, source: "report" },
      ]);
    }
  });

  test("kein Bericht, limits null, kaputte Zeile und ungültige Uhr ergeben keine Messung", () => {
    for (const value of [undefined, null, {}, [], "Text", { rate_limits: {} }, { rate_limits: { limits: null } }]) {
      expect(usageFromClaudeReport(value, at)).toEqual([]);
    }
    expect(usageFromClaudeReport(readStream([{ line: "{kaputt", at }]).outcome.usageReport, at)).toEqual([]);
    for (const time of [NaN, Infinity, 1e99]) expect(usageFromClaudeReport(report(scoped("Fable")), time)).toEqual([]);
  });

  test("Eingabe unverändert; letztes Fenster derselben Kennung gewinnt", () => {
    const input = report(scoped("Fable"), { ...scoped("Fable"), percent: 8 });
    const before = structuredClone(input);
    expect(usageFromClaudeReport(input, at).map(w => w.percent)).toEqual([8]);
    expect(input).toEqual(before);
  });
});
