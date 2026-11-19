/** Wortgleichheit der Browseranzeige mit /motor, ohne Browser oder Motorlauf. */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { motorStageStateText } from "../src/lib/motor-text";
import { switchWindowLabel } from "../src/lib/engine-switch-text";
import { BACKUP_MODEL_PATTERN } from "../src/lib/settings";
import { CODEX_NOT_LOGGED_IN } from "../src/lib/engines/check";
import type { StageStatus } from "../src/lib/engine-stage-view";
const source = await readFile(new URL("../src/web/public/settings.js", import.meta.url), "utf8");
const browser = new Function(`${source}\nreturn { engineUsageText, engineMeasurementAge, ENGINE_MEASUREMENT_SOURCES, engineStateText, engineOrderState, engineWindowLabel, engineFlat, enginePatch, engineBackupError, engineStageId, sameFieldValue, ENGINE_BACKUP_MODEL_PATTERN, ENGINE_FALLBACK_TEXT };`)();
const until = "2026-11-22T15:00:00Z";
const blocked = (cause: "threshold" | "limit" | "outage", resetKnown: boolean): StageStatus => ({ state: "blocked", cause, resetKnown, blockedUntil: until,
  ...(cause === "threshold" ? { window: "weekly_all", percent: 95.6 } : {}) });
const cases: StageStatus[] = [
  { state: "answering" }, { state: "free" }, { state: "not_ready" },
  // Die API lässt bekannte Meldungen unverändert durch; fremde Ausgaben werden bereinigt.
  { state: "not_ready", message: CODEX_NOT_LOGGED_IN },
  ...(["threshold", "limit", "outage"] as const).flatMap(cause => [blocked(cause, true), blocked(cause, false)]),
  { ...blocked("threshold", true), percent: undefined },
  { ...blocked("threshold", true), window: undefined },
  { ...blocked("threshold", false), window: undefined, percent: undefined },
];

describe("Browser und /motor: Zeichen für Zeichen derselbe Zustand", () => {
  for (const zone of ["Europe/Berlin", "UTC", "Pacific/Honolulu", "Asia/Tokyo"]) {
    for (const [i, status] of cases.entries()) test(`${zone}, Fall ${i}`, () => {
      expect(browser.engineStateText(status, zone)).toBe(motorStageStateText(status, zone));
      const { percent, message, ...entry } = status;
      expect(browser.engineOrderState({ id: "codex", engine: "codex", ...entry }, {
        timeZone: zone,
        availability: [{ engine: "codex", message }],
        blocks: [{ engine: "claude", cause: "threshold", window: "weekly_all", percent: 1 },
          { engine: "codex", cause: "limit", window: "weekly_all", percent: 2 },
          { engine: "codex", cause: "threshold", window: "session", percent: 3 },
          { engine: "codex", ...status, percent }],
      })).toBe(motorStageStateText(status, zone));
    });
  }
  test("kein Zustand ohne Gegenstück, aus free oder blocks wird niemals antwortet", () => {
    expect(browser.engineOrderState(null, {})).toBe("noch nicht gespeichert");
    expect(browser.engineOrderState({ engine: "claude", state: "free" }, { blocks: [{ engine: "claude", cause: "threshold" }] })).toBe("frei");
  });
});

const windows = [
  ["weekly_all", "Woche, alle Modelle"], ["weekly_scoped:fable", "Woche, Fable"], ["weekly_scoped:opus", "Woche, Opus"],
  ["weekly_scoped:sonnet", "Woche, Sonnet"], ["weekly_scoped:haiku", "Woche, Haiku"], ["session", "5 Stunden"],
  ["window_1", "Fenster, 1 Minute"], ["window_60", "Fenster, 60 Minuten"], ["window_119", "Fenster, 119 Minuten"],
  ["window_120", "Fenster, 2 Stunden"], ["window_150", "Fenster, 2,5 Stunden"], ["window_121", "Fenster, 2,02 Stunden"],
  ["window_2880", "Fenster, 2 Tage"], ["window_4320", "Fenster, 3 Tage"], ["window_3600", "Fenster, 2,5 Tage"],
];
for (const [id, label] of windows) test(`Fenster: ${id}`, () => {
  expect(browser.engineWindowLabel(id)).toBe(label);
  expect(browser.engineWindowLabel(id)).toBe(switchWindowLabel(id as "session"));
});

test("backups und auto unverändert hin und zurück, keine gemeinsamen Referenzen", () => {
  for (const backups of [[], [{ engine: "claude" }], [{ engine: "claude", model: "opus", effort: "high" }, { engine: "codex" }, { engine: "opencode" }]]) {
    for (const auto of [{ enabled: true }, { enabled: false, threshold: 50, returnBelow: 0 }, { threshold: 99 }]) {
      const settings = { default: "codex", backups, auto, codex: { model: "gpt-6", effort: "high" }, opencode: { model: "openrouter/test/model" } };
      const flat = browser.engineFlat(settings);
      expect(browser.enginePatch(flat)).toEqual(settings);
      expect(flat.backups).not.toBe(backups);
      expect(browser.enginePatch(flat).backups).not.toBe(flat.backups);
    }
  }
  expect(browser.enginePatch({ autoReturnBelow: null, backups: [] })).toEqual({ auto: { returnBelow: null }, backups: [] });
  expect(browser.sameFieldValue([{ engine: "claude", model: "opus" }], [{ engine: "claude", model: "sonnet" }])).toBe(false);
  expect(browser.sameFieldValue([{ engine: "codex" }, { engine: "claude" }], [{ engine: "claude" }, { engine: "codex" }])).toBe(false);
});

test("höchstens vier eindeutige Ersatzstufen, nie API; Altbestand ohne Modell bleibt gültig", () => {
  const stages = [{ engine: "claude" }, { engine: "claude", model: "opus" }, { engine: "codex" }, { engine: "opencode" }];
  expect(browser.engineBackupError(stages)).toBeNull();
  expect(browser.engineBackupError([...stages, { engine: "claude", model: "sonnet" }])).toContain("vier");
  expect(browser.engineBackupError([{ engine: "codex" }, { engine: "codex" }])).toContain("schon vorhanden");
  expect(browser.engineBackupError([{ engine: "claude", model: "opus", effort: "high" }, { engine: "claude", model: "opus" }])).toContain("schon vorhanden");
  expect(browser.engineBackupError([{ engine: "api" }])).not.toBeNull();
  expect(browser.ENGINE_BACKUP_MODEL_PATTERN.source).toBe(BACKUP_MODEL_PATTERN.source);
  for (const model of ["", "-opus", "opus;ls", "a".repeat(101), "claude opus", "openrouter/model"]) {
    expect(browser.engineBackupError([{ engine: "claude", model }])).not.toBeNull();
  }
  expect(browser.ENGINE_FALLBACK_TEXT).toBe("Ersatzmodelle mit eingeschränktem Werkzeugumfang");
  expect(source).not.toContain("ohne Werkzeuge");
  expect(source).not.toContain("Ersatzmodelle (eingeschränkter Werkzeugumfang)");
});

test("Stand je Fenster: alle Quellen, Reset-Zeit, Alter, keine und abgelaufene Messung", () => {
  const now = Date.parse("2026-11-22T13:40:00Z");
  const reading = { id: "weekly_all", state: "known", percent: 95.6, resetsAt: until, measuredAt: "2026-11-22T13:40:00Z" };
  expect(browser.ENGINE_MEASUREMENT_SOURCES).toEqual({ stream: "aus dem letzten Lauf", report: "Verbrauchsbericht", "session-file": "Sitzungsdatei von Codex", extern: "eingeliefert" });
  for (const [source, label] of Object.entries(browser.ENGINE_MEASUREMENT_SOURCES)) {
    expect(browser.engineUsageText({ ...reading, source }, "Europe/Berlin", now)).toBe(`Woche, alle Modelle: 96 % · Reset So 16:00 · gerade eben · ${label}`);
  }
  expect(browser.engineUsageText(null)).toBe("noch nicht gemessen");
  const expired = browser.engineUsageText({ ...reading, state: "expired", source: "extern" }, "Europe/Berlin", now);
  expect(expired).toBe("Woche, alle Modelle: Reset vorbei, noch nicht neu gemessen · Reset So 16:00 · gerade eben · eingeliefert");
  expect(expired).not.toContain("96");
  expect(browser.engineUsageText({ ...reading, resetsAt: undefined, source: "report" }, "Europe/Berlin", now)).toContain("Reset unbekannt");
  for (const [minutes, label] of [[1, "vor 1 Minute"], [3, "vor 3 Minuten"], [60, "vor 1 Stunde"], [180, "vor 3 Stunden"], [1440, "vor 1 Tag"], [4320, "vor 3 Tagen"]] as const) {
    expect(browser.engineMeasurementAge(new Date(now - minutes * 60000).toISOString(), now)).toBe(label);
  }
});
