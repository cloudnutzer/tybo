import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isUsageWindowId, rateLimitWindowId, readUsage, recordUsage, setUsageFileForTests,
  type UsageWindow, type UsageWindowId,
} from "../src/lib/engines/usage";

let directory: string;
let file: string;
let warnings: ReturnType<typeof spyOn>;
const empty = { claude: [], codex: [], opencode: [], api: [] };
const measuredAt = "2026-01-02T12:00:00.000Z";
const resetsAt = "2026-01-09T12:00:00.000Z";
const window = (id: UsageWindowId = "weekly_all", changes: Partial<UsageWindow> = {}): UsageWindow => ({
  id, percent: 6, measuredAt, source: "stream", ...changes,
});
const raw = (engines: unknown, version = 1) => writeFileSync(file, JSON.stringify({ version, engines }));

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "engine-usage-"));
  file = join(directory, "usage.json");
  setUsageFileForTests(file, 40);
  warnings = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setUsageFileForTests(null);
  warnings.mockRestore();
  rmSync(directory, { recursive: true, force: true });
});

describe("Fensterkennungen", () => {
  test("alle vier Formen und ihre Grenzen", () => {
    for (const id of ["weekly_all", "session", "weekly_scoped:fable", "weekly_scoped:opus 5.5",
      "weekly_scoped:a_1-b.c", `weekly_scoped:${"a".repeat(40)}`, "window_1", "window_1440", "window_525600"]) {
      expect(isUsageWindowId(id)).toBe(true);
    }
    for (const id of ["weekly", "window_0", "window_01", "window_1.5", "window_525601", "window_-1",
      "weekly_scoped:", "weekly_scoped:Opus", "weekly_scoped:ä", "weekly_scoped: opus", "weekly_scoped:opus ",
      "weekly_scoped:opus\nfable", `weekly_scoped:${"a".repeat(41)}`, "session\n", "window_1\n", null, 1]) {
      expect(isUsageWindowId(id)).toBe(false);
    }
  });

  test("nur bekannte Arten des Ereignisstroms erhalten ein Fenster", () => {
    expect(["seven_day", "five_hour", "seven_day_opus", "seven_day_sonnet"].map(rateLimitWindowId))
      .toEqual(["weekly_all", "session", "weekly_scoped:opus", "weekly_scoped:sonnet"]);
    for (const value of ["overage", "seven_day_overage_included", "seven_day_fable", "unbekannt", undefined]) {
      expect(rateLimitWindowId(value)).toBeUndefined();
    }
  });
});

describe("Ablage der Messwerte", () => {
  test("Abgleich bleibt bei fehlender Datei still, beschädigte Werte warnen weiter", async () => {
    expect(await readUsage(Date.now(), { quietMissing: true })).toEqual(empty);
    expect(await readUsage(Date.now(), { quietMissing: true })).toEqual(empty);
    expect(warnings).not.toHaveBeenCalled();
    writeFileSync(file, "kaputt");
    expect(await readUsage(Date.now(), { quietMissing: true })).toEqual(empty);
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  test("fehlende Datei: leer, kein Wurf, eine gedrosselte Logzeile", async () => {
    expect(await readUsage()).toEqual(empty);
    expect(await readUsage()).toEqual(empty);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(existsSync(file)).toBe(false);
  });

  test("gültige leere Ablage, leere Datei und kaputte Formate", async () => {
    raw({});
    expect(await readUsage()).toEqual(empty);
    expect(warnings).not.toHaveBeenCalled();
    for (const text of ["", "kein JSON", "null", "[]", "{}", '{"version":1,"engines":[]}']) {
      writeFileSync(file, text);
      expect(await readUsage()).toEqual(empty);
    }
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  test("unbekannte Version gilt als leer und wird beim Schreiben ersetzt", async () => {
    raw({ claude: { windows: [window()] } }, 2);
    expect(await readUsage()).toEqual(empty);
    expect(await recordUsage("codex", [window("window_1440")])).toEqual({ accepted: ["window_1440"], rejected: [] });
    expect(JSON.parse(readFileSync(file, "utf8")).version).toBe(1);
    expect((await readUsage()).claude).toEqual([]);
  });

  test("einzelne kaputte Einträge oder Motoren entfernen keine gültigen Messungen", async () => {
    raw({
      claude: { windows: [null, window("session", { percent: -1 }), window(), window("session", { resetsAt: "kaputt" })] },
      codex: { windows: "kaputt" }, opencode: { windows: [window("window_1440")] }, api: null,
    });
    const readings = await readUsage();
    expect(readings.claude).toEqual([{ ...window(), state: "known" }]);
    expect(readings.opencode).toEqual([{ ...window("window_1440"), state: "known" }]);
    expect(readings.codex).toEqual([]);
    expect(readings.api).toEqual([]);
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  test("frischer Checkout: Ordner entsteht vor der Sperre, alle Kennungsformen werden gespeichert", async () => {
    file = join(directory, "data", "engine-usage.json");
    setUsageFileForTests(file);
    const ids: UsageWindowId[] = ["weekly_all", "session", "weekly_scoped:opus 5.5", "window_1440"];
    expect(await recordUsage("claude", ids.map(id => window(id)))).toEqual({ accepted: ids, rejected: [] });
    expect((await readUsage()).claude.map(w => w.id)).toEqual(ids);
    expect(readdirSync(join(directory, "data"))).toEqual(["engine-usage.json"]);
  });

  test("abgelaufen heißt unbekannt, ohne Prozentwert; genau am Reset ist das Fenster abgelaufen", async () => {
    await recordUsage("claude", [window("weekly_all", { resetsAt }), window("session")]);
    expect((await readUsage(Date.parse(resetsAt) - 1)).claude[0]).toEqual({ ...window("weekly_all", { resetsAt }), state: "known" });
    for (const now of [Date.parse(resetsAt), Date.parse(resetsAt) + 1]) {
      const readings = (await readUsage(now)).claude;
      expect(readings[0]).toEqual({ state: "expired", id: "weekly_all", resetsAt, measuredAt, source: "stream" });
      expect(readings[0]).not.toHaveProperty("percent");
      expect(readings[1]).toEqual({ ...window("session"), state: "known" });
    }
    expect(JSON.parse(readFileSync(file, "utf8")).engines.claude.windows[0].percent).toBe(6);
  });

  test("zwei gleichzeitige Schreiber verlieren weder Fenster noch Motoren", async () => {
    setUsageFileForTests(file);
    const first = await Promise.all([
      recordUsage("claude", [window()]), recordUsage("claude", [window("session")]),
    ]);
    expect(first.every(result => result.accepted.length === 1 && result.rejected.length === 0)).toBe(true);
    expect((await readUsage()).claude.map(w => w.id).sort()).toEqual(["session", "weekly_all"]);
    await Promise.all([recordUsage("codex", [window("window_1440")]), recordUsage("api", [window()])]);
    const readings = await readUsage();
    expect(readings.claude).toHaveLength(2);
    expect(readings.codex).toHaveLength(1);
    expect(readings.api).toHaveLength(1);
  });

  test("jüngste Zeit gewinnt numerisch, gleiche Zeit darf ersetzen, andere Fenster bleiben", async () => {
    const newer = window("weekly_all", { measuredAt: "2026-01-02T13:00:00+01:00", percent: 25 });
    await recordUsage("claude", [newer, window("session")]);
    const older = window("weekly_all", { measuredAt: "2026-01-02T14:30:00+03:00", percent: 1 });
    expect(await recordUsage("claude", [older])).toEqual({ accepted: [], rejected: [{ id: "weekly_all", reason: "older" }] });
    expect((await readUsage()).claude[0]).toMatchObject({ state: "known", percent: 25 });
    expect(await recordUsage("claude", [window("weekly_all", { percent: 30 })])).toEqual({ accepted: ["weekly_all"], rejected: [] });
    expect((await readUsage()).claude).toEqual([{ ...window("weekly_all", { percent: 30 }), state: "known" }, { ...window("session"), state: "known" }]);
  });

  test("neuere externe Messung ersetzt stream, Quelle bekommt keinen Vorrang", async () => {
    await recordUsage("claude", [window()]);
    const external = window("weekly_all", { source: "extern", measuredAt: "2026-01-02T13:00:00Z", percent: 42.125 });
    expect(await recordUsage("claude", [external])).toEqual({ accepted: ["weekly_all"], rejected: [] });
    expect((await readUsage()).claude).toEqual([{ ...external, state: "known" }]);
    expect((await recordUsage("claude", [window()])).rejected).toEqual([{ id: "weekly_all", reason: "older" }]);
  });

  test("ungültige Werte einzeln abgelehnt; gültige weder gerundet noch begrenzt", async () => {
    const invalid = [
      { id: "weekly" }, { id: "window_0" }, { id: "weekly_scoped:" },
      ...[NaN, Infinity, -Infinity, -1, 101, "6"].map(percent => ({ percent })),
      ...["kaputt", "2026-02-30T00:00:00Z", "2026-01-02", "2026-01-02T12:00:00", "2026-01-02T12:00:00Z\n"].map(measuredAt => ({ measuredAt })),
      { resetsAt: "kaputt" }, { resetsAt: 1 }, { source: "unbekannt" },
    ].map(changes => ({ ...window(), ...changes })) as UsageWindow[];
    const result = await recordUsage("claude", [...invalid, window("session", { percent: 6.125 }), window("window_1", { percent: 0 }), window("window_2", { percent: 100 })]);
    expect(result.accepted).toEqual(["session", "window_1", "window_2"]);
    expect(result.rejected).toEqual(invalid.map(w => ({ id: w.id, reason: "invalid" })));
    expect((await readUsage()).claude.map(w => w.state === "known" && w.percent)).toEqual([6.125, 0, 100]);
  });

  test("ferne Zukunft ist invalid; kleine Uhrabweichung erlaubt, kaputter Altbestand blockiert nicht", async () => {
    const future = window("weekly_all", { source: "extern", measuredAt: new Date(Date.now() + 300_000).toISOString() });
    expect(await recordUsage("claude", [future])).toEqual({ accepted: [], rejected: [{ id: "weekly_all", reason: "invalid" }] });
    expect(existsSync(file)).toBe(false);
    const near = window("session", { measuredAt: new Date(Date.now() + 30_000).toISOString() });
    expect((await recordUsage("claude", [near])).accepted).toEqual(["session"]);
    raw({ claude: { windows: [future] } });
    expect(await readUsage()).toEqual(empty);
    expect((await recordUsage("claude", [window()])).accepted).toEqual(["weekly_all"]);
  });

  test("kaputte Datei wird unter der Sperre durch gültige Messwerte ersetzt", async () => {
    writeFileSync(file, "unsinnig");
    expect(await recordUsage("claude", [window()])).toEqual({ accepted: ["weekly_all"], rejected: [] });
    expect((await readUsage()).claude).toEqual([{ ...window(), state: "known" }]);
    expect(warnings).toHaveBeenCalledTimes(1);
    expect(existsSync(`${file}.lock`)).toBe(false);
  });

  for (const owner of [JSON.stringify({ pid: process.pid, token: "test" }), "unlesbar"]) {
    test(`belegte Sperre (${owner.startsWith("{") ? "lebender Besitzer" : "unlesbar"}): unsaved, kein Wurf oder Wartestau`, async () => {
      await recordUsage("claude", [window()]);
      warnings.mockClear();
      writeFileSync(`${file}.lock`, owner);
      const previous = readFileSync(file, "utf8");
      const started = performance.now();
      const results = await Promise.all(Array.from({ length: 8 }, () => recordUsage("claude", [window("session")])));
      expect(performance.now() - started).toBeLessThan(300);
      for (const result of results) expect(result).toEqual({ accepted: [], rejected: [{ id: "session", reason: "unsaved" }] });
      expect(readFileSync(file, "utf8")).toBe(previous);
      expect(readFileSync(`${file}.lock`, "utf8")).toBe(owner);
      expect((await readUsage()).claude).toHaveLength(1);
      expect(warnings).toHaveBeenCalledTimes(1);
    });
  }

  test("Schreibfehler: unsaved, kein Wurf, Sperre und temporäre Dateien aufgeräumt", async () => {
    mkdirSync(file);
    expect(await recordUsage("claude", [window()])).toEqual({ accepted: [], rejected: [{ id: "weekly_all", reason: "unsaved" }] });
    expect(await readUsage()).toEqual(empty);
    expect(readdirSync(directory)).toEqual(["usage.json"]);
  });

  test("Ordner nicht anlegbar: gültige Messung unsaved, ungültige bleibt invalid", async () => {
    writeFileSync(file, "kein Ordner");
    setUsageFileForTests(join(file, "usage.json"));
    expect(await recordUsage("claude", [window(), window("session", { percent: -1 })])).toEqual({
      accepted: [], rejected: [{ id: "session", reason: "invalid" }, { id: "weekly_all", reason: "unsaved" }],
    });
  });

  test("Test-Standardpfad liegt außerhalb des Arbeitsordners", () => {
    expect(process.env.ENGINE_USAGE_FILE_PATH).toBeTruthy();
    expect(process.env.ENGINE_USAGE_FILE_PATH!.startsWith(process.cwd() + "/")).toBe(false);
  });
});
