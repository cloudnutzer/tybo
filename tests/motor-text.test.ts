/** Reine Textdaten ohne Einstellungen, Prozesse oder Messdienste. */
import { describe, expect, test } from "bun:test";
import { motorStageStateText, motorStatusText } from "../src/lib/motor-text";
import type { EnginePreview, EnginePreviewStage } from "../src/lib/engine-choice";
import type { StageStatus } from "../src/lib/engine-stage-view";
const now = Date.parse("2026-11-22T13:40:00Z");
const until = "2026-11-22T15:00:00Z";
const stage = (extra: Partial<EnginePreviewStage> = {}): EnginePreviewStage => ({ id: "claude", engine: "claude", label: "Claude Code", model: "claude-fable-5-2", state: "answering", windows: [], ...extra }) as EnginePreviewStage;
const preview = (first = stage()): EnginePreview => {
  const codex = stage({ id: "codex", engine: "codex", label: "Codex", model: "gpt-6-astra", state: first.state === "answering" ? "free" : "answering" });
  return { answering: first.state === "answering" ? first : codex, role: first.state === "answering" ? "first" : "backup",
    ...(first.state !== "answering" ? { reason: first } : {}), stages: [first, codex],
    auto: { enabled: true, threshold: 95, returnBelow: 80 }, hasBackups: true,
    configured: { engine: "claude", source: "code" }, standard: { engine: "claude", source: "code" },
    available: [{ engine: "claude", label: "Claude Code", ready: true }, { engine: "codex", label: "Codex", ready: true }, { engine: "api", label: "Anthropic API", ready: true }],
  };
};
const blocked = (cause: "threshold" | "limit" | "outage", resetKnown: boolean): StageStatus => ({ state: "blocked", cause, resetKnown, blockedUntil: until,
  ...(cause === "threshold" ? { window: "weekly_all", percent: 96 } : {}) });
const cases: [StageStatus, string][] = [
  [{ state: "answering" }, "antwortet"], [{ state: "free" }, "frei"],
  [blocked("threshold", true), "gesperrt bis So 16:00 (Woche, alle Modelle: 96 %)"],
  [blocked("threshold", false), "pausiert bis 16:00 (Woche, alle Modelle: 96 %, Reset unbekannt)"],
  [blocked("limit", true), "gesperrt bis So 16:00 (Limit erreicht)"],
  [blocked("limit", false), "pausiert bis 16:00 (Limit erreicht, Reset unbekannt)"],
  [blocked("outage", false), "pausiert bis 16:00 (Ausfall)"],
  [{ state: "not_ready", message: "Bitte anmelden" }, "nicht bereit (Bitte anmelden)"],
  [{ state: "not_ready" }, "nicht bereit"],
];
describe("verbindliche Zustände", () => {
  for (const [status, expected] of cases) test(expected, () => {
    expect(motorStageStateText(status, "Europe/Berlin")).toBe(expected);
    expect(motorStatusText(preview(stage(status)), "Europe/Berlin", now)).toContain(`claude-fable-5-2: ${expected}`);
  });
  test("Schwelle ohne Prozent oder Fenster erfindet keine Angaben", () => {
    expect(motorStageStateText({ ...blocked("threshold", false), percent: undefined }, "Europe/Berlin")).toContain("(Woche, alle Modelle, Reset unbekannt)");
    expect(motorStageStateText({ ...blocked("threshold", false), percent: undefined, window: undefined }, "Europe/Berlin")).toContain("(Schwelle erreicht, Reset unbekannt)");
  });
});
test("Grund ausführlich, jede gemessene Stufe mit Alter, höchstes zählendes Fenster", () => {
  const first = stage({ ...blocked("threshold", true), windows: [
    { id: "weekly_all", state: "known", percent: 96, resetsAt: until, measuredAt: "2026-11-22T13:28:00Z", source: "extern" },
    { id: "session", state: "known", percent: 99, measuredAt: "2026-11-22T13:39:00Z", source: "stream" },
  ] });
  const p = preview(first);
  p.stages[1].windows = [
    { id: "window_300", state: "known", percent: 48, resetsAt: until, measuredAt: "2026-11-22T13:37:00Z", source: "session-file" },
    { id: "window_120", state: "known", percent: 12, measuredAt: "2026-11-22T13:39:00Z", source: "session-file" },
  ];
  const text = motorStatusText(p, "Europe/Berlin", now);
  expect(text).toContain("Motor in diesem Gespräch: Codex (springt ein)");
  expect(text).toContain("Grund: Claude Code ist gesperrt bis So, 22.11., 16:00 Uhr (Woche, alle Modelle: 96 %)");
  expect(text).toContain("gesperrt bis So 16:00 (Woche, alle Modelle: 96 %, gemessen vor 12 Min.)");
  expect(text).toContain("antwortet (Fenster, 5 Stunden: 48 %, Reset So 16:00, gemessen vor 3 Min.)");
  expect(text).toContain("Außerdem wählbar: Anthropic API ✓");
  expect(text).not.toContain("99 %"); expect(text).not.toContain("12 %");
});
test("keine freie Stufe, mit und ohne Zeit; Automatik aus; manuelle Wahl", () => {
  const p = preview(stage(blocked("limit", true)));
  p.answering = null; p.role = "none"; p.earliestFree = until; p.auto.enabled = false;
  let text = motorStatusText(p, "Europe/Berlin", now);
  expect(text).toContain("Motor in diesem Gespräch: keiner frei");
  expect(text).toContain("Grund: Bis So, 22.11., 16:00 Uhr antworten Ersatzmodelle mit eingeschränktem Werkzeugumfang.");
  expect(text).toContain("Automatik: aus, Wechsel ab 95 %, zurück unter 80 %");
  delete p.earliestFree;
  expect(motorStatusText(p, "Europe/Berlin", now)).toContain("Grund: Es antworten Ersatzmodelle mit eingeschränktem Werkzeugumfang.");
  p.answering = p.stages[1]; p.role = "manual";
  expect(motorStatusText(p, "Europe/Berlin", now)).toContain("Codex (von Hand gewählt)");
});
test("abgelaufene und fremde Familienfenster erscheinen nicht; eigene OpenCode-Konfiguration bleibt ohne Preisbehauptung", () => {
  const p = preview();
  p.stages[0].windows = [
    { id: "weekly_all", state: "expired", measuredAt: "2026-11-20T12:00:00Z", resetsAt: "2026-11-21T12:00:00Z", source: "extern" },
    { id: "weekly_scoped:opus", state: "known", percent: 99, measuredAt: "2026-11-22T13:39:00Z", source: "report" },
  ];
  p.stages.push(stage({ engine: "opencode", label: "OpenCode", id: "opencode", model: undefined, state: "free" }));
  let text = motorStatusText(p, "Europe/Berlin", now);
  expect(text).not.toContain("gemessen"); expect(text).not.toContain("99 %"); expect(text).not.toContain("zahlt");
  p.stages[2].model = "openrouter/anthropic/claude-opus-5.5";
  expect(motorStatusText(p, "Europe/Berlin", now)).toContain("frei (zahlt je Verbrauch)");
});
test("Zeitzone und Wochentag sind stabil, einschließlich Sommerzeit", () => {
  expect(motorStageStateText({ ...blocked("limit", true), blockedUntil: "2026-07-05T22:10:00Z" }, "Europe/Berlin")).toBe("gesperrt bis Mo 00:10 (Limit erreicht)");
  expect(motorStageStateText(blocked("limit", false), "UTC")).toBe("pausiert bis 15:00 (Limit erreicht, Reset unbekannt)");
});
test("Text bleibt auch mit überlangen Bereitschaftsmeldungen unter 4000 Zeichen", () => {
  const p = preview(stage({ state: "not_ready", message: "Beispiel ".repeat(2000) }));
  expect(motorStatusText(p, "UTC", now).length).toBeLessThanOrEqual(4000);
});

test("lange und krumme Fensterdauern im Zustand wie in der WebUI", () => {
  for (const [window, name] of [["window_4320", "Fenster, 3 Tage"], ["window_150", "Fenster, 2,5 Stunden"], ["window_60", "Fenster, 60 Minuten"], ["window_1", "Fenster, 1 Minute"]] as const) {
    expect(motorStageStateText({ ...blocked("threshold", true), window }, "Europe/Berlin")).toBe(`gesperrt bis So 16:00 (${name}: 96 %)`);
  }
});
