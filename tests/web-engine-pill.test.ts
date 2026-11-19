/** Reine Motor-Texte wie im Browser, ohne Browser-Zeitzone oder laufenden Bot. */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { formatShortSwitchTime, switchWindowLabel } from "../src/lib/engine-switch-text";
import type { ConversationEngineStage } from "../src/web/engines";
import { TYBO_BRAND } from "./brand-fixture";
const source = readFileSync(new URL("../src/web/public/app.js", import.meta.url), "utf8");
const settings = readFileSync(new URL("../src/web/public/settings.js", import.meta.url), "utf8");
const browser = new Function("document", "window", `${settings}\n${source}\nreturn { enginePillText, engineStageText, engineTime, engineWindowLabel };`)(
  { getElementById: () => null }, { TYBO_BRAND },
);
const until = "2026-11-22T15:00:00.000Z";
const backup: ConversationEngineStage = { engine: "codex", label: "Codex", role: "backup", model: "gpt-6-astra",
  reason: { label: "Claude Code", kind: "threshold", window: "weekly_all", percent: 96, until, resetKnown: true } };
const text = (stage: ConversationEngineStage) => browser.engineStageText(stage, "Europe/Berlin");

for (const [engine, label] of Object.entries({ claude: "Claude Code", codex: "Codex", opencode: "OpenCode", api: "Anthropic API" })) {
  test(`Pille für ${engine}, auch als Standard und ohne Vorschau`, () => {
    expect(browser.enginePillText(engine, engine)).toBe(label);
    expect(browser.enginePillText(engine, "claude")).toBe(label);
    for (const role of ["first", "manual", "backup"] as const) {
      const stage = { engine, label, role };
      expect(browser.enginePillText("claude", "claude", stage)).toBe(label + (role === "backup" ? " · springt ein" : ""));
      if (role !== "backup") expect(text(stage)).toBe(label + (role === "manual" ? " ist für dieses Gespräch gewählt." : " antwortet."));
    }
  });
}
test("keine Stufe, unbekannter Motor und langer Claude-Name", () => {
  expect(browser.enginePillText("claude", "claude", { engine: null, label: null, role: "none" })).toBe("Kein Motor frei");
  expect(browser.enginePillText(undefined, "codex")).toBe("Codex");
  expect(browser.enginePillText("__proto__", "constructor")).toBe("Claude Code");
  const stage = { engine: "claude", label: "Claude Code (claude-opus-5-5)", model: "claude-opus-5-5", role: "backup" };
  expect(browser.enginePillText("claude", "claude", stage)).toBe("Claude Code (claude-opus-5-5) · springt ein");
  expect(browser.enginePillText("claude", "claude", stage, true)).toBe("Claude Code · springt ein");
  expect(text(stage as ConversationEngineStage)).toBe("Claude Code (claude-opus-5-5) springt ein.");
});
test("Schwellensperre mit belegtem Reset", () => {
  expect(text(backup)).toBe("Claude Code ist bis So, 16:00 Uhr gesperrt (Woche, alle Modelle: 96 %). Codex springt ein.");
});
test("ohne Fenster oder Prozent keine unvollständige Klammer", () => {
  for (const missing of [{ window: undefined }, { percent: undefined }, { window: undefined, percent: undefined }]) {
    expect(text({ ...backup, reason: { ...backup.reason!, ...missing } })).toBe("Claude Code ist bis So, 16:00 Uhr gesperrt. Codex springt ein.");
  }
});
test("Limit mit belegtem Reset und Limit-Pause", () => {
  expect(text({ ...backup, reason: { ...backup.reason!, kind: "limit" } })).toBe("Claude Code ist bis So, 16:00 Uhr gesperrt (Limit erreicht). Codex springt ein.");
  expect(text({ ...backup, reason: { ...backup.reason!, kind: "limit", resetKnown: false } })).toBe("Claude Code ist pausiert bis 16:00 (Limit erreicht, Reset unbekannt). Codex springt ein.");
});
test("Schwelle ohne belegte Reset-Zeit ist eine Pause", () => {
  expect(text({ ...backup, reason: { ...backup.reason!, resetKnown: false } })).toBe("Claude Code ist pausiert bis 16:00 (Woche, alle Modelle: 96 %, Reset unbekannt). Codex springt ein.");
});
for (const resetKnown of [true, false, undefined]) test(`Ausfall bleibt Pause, auch mit resetKnown=${resetKnown}`, () => {
  expect(text({ ...backup, reason: { ...backup.reason!, kind: "outage", resetKnown } })).toBe("Claude Code ist pausiert bis 16:00 (Ausfall). Codex springt ein.");
});
test("fehlende Bereitschaft mit und ohne Prüfgrund", () => {
  const reason = { label: "OpenCode", kind: "not_ready" as const };
  expect(text({ ...backup, reason: { ...reason, message: "OpenCode ist nicht installiert" } })).toBe("OpenCode ist nicht bereit (OpenCode ist nicht installiert). Codex springt ein.");
  expect(text({ ...backup, reason })).toBe("OpenCode ist nicht bereit. Codex springt ein.");
});
test("älterer Server ohne resetKnown liefert eine Sperre", () => {
  const reason = { ...backup.reason! };
  delete reason.resetKnown;
  expect(text({ ...backup, reason })).toBe(text(backup));
});
test("kein Motor frei mit und ohne bekanntes Ende, Grund bleibt nachvollziehbar", () => {
  const stage: ConversationEngineStage = { engine: null, label: null, role: "none" };
  expect(text(stage)).toBe("Kein Motor ist frei. Es antworten Ersatzmodelle mit eingeschränktem Werkzeugumfang.");
  expect(text({ ...stage, until })).toBe("Kein Motor ist frei. Bis So, 16:00 Uhr antworten Ersatzmodelle mit eingeschränktem Werkzeugumfang.");
  expect(text({ ...stage, reason: backup.reason, until })).toBe("Claude Code ist bis So, 16:00 Uhr gesperrt (Woche, alle Modelle: 96 %). Kein Motor ist frei. Bis So, 16:00 Uhr antworten Ersatzmodelle mit eingeschränktem Werkzeugumfang.");
  expect(text({ ...stage, reason: backup.reason })).not.toContain("springt ein");
});
test("Zeiten und Fenster verwenden die vorhandenen Funktionen, wortgleich zum Kern", () => {
  for (const timeZone of ["UTC", "Europe/Berlin", "Pacific/Honolulu", "Asia/Tokyo"]) {
    for (const day of [true, false]) expect(browser.engineTime(until, timeZone, day)).toBe(formatShortSwitchTime(until, timeZone, day));
    expect(browser.engineStageText(backup, timeZone)).toContain(formatShortSwitchTime(until, timeZone).replace(" ", ", ") + " Uhr");
  }
  for (const window of ["weekly_all", "weekly_scoped:fable", "weekly_scoped:opus", "session", "window_1", "window_90", "window_150", "window_4320"] as const) {
    expect(browser.engineWindowLabel(window)).toBe(switchWindowLabel(window));
  }
  expect(browser.engineStageText(backup)).toContain("So, 15:00 Uhr");
  expect(source).not.toMatch(/ohne Werkzeuge/i);
  const stateFunction = source.slice(source.indexOf("function engineStageText"), source.indexOf("function replyMetaText"));
  expect(stateFunction).not.toContain("Date.now");
  expect(stateFunction).not.toContain("fetch(");
});
