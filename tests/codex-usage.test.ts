import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexSessionDay, readCodexUsage, resetCodexUsageLogForTests, setCodexUsageSourceForTests } from "../src/lib/engines/codex-usage";
import { readUsage, recordUsage, setUsageFileForTests } from "../src/lib/engines/usage";
import { MEASURED_AT, READ_TIME, ROLLOUT, THREAD_ID, tokenCount, writeRollout } from "./codex-usage-fixture";

let dir: string, home: string, now: number;
let warnings: ReturnType<typeof spyOn>;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-codex-usage-"));
  home = join(dir, "codex");
  now = READ_TIME;
  setCodexUsageSourceForTests({ codexHome: () => home, now: () => now });
  setUsageFileForTests(join(dir, "engine-usage.json"));
  warnings = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  setCodexUsageSourceForTests(null);
  setUsageFileForTests(null);
  warnings.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

test("Testvorlage: nur Woche aus primary, secondary null, Reset und Messzeit aus der Zeile", async () => {
  writeRollout(home);
  expect(await readCodexUsage(THREAD_ID)).toEqual([{
    id: "weekly_all", percent: 48, resetsAt: "2026-11-18T07:47:30.000Z", measuredAt: MEASURED_AT, source: "session-file",
  }]);
  expect(warnings).not.toHaveBeenCalled();
});

for (const swapped of [false, true]) {
  test(`September-Form, Positionen ${swapped ? "vertauscht" : "wie belegt"}`, async () => {
    const session = { used_percent: 12, window_minutes: 300, resets_at: 1789212000 };
    const week = { used_percent: 31, window_minutes: 10080, resets_at: 1789600000 };
    writeRollout(home, tokenCount(swapped ? week : session, swapped ? session : week, "2026-09-12T09:15:02.000Z"));
    const result = await readCodexUsage(THREAD_ID);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({ id: "session", percent: 12, resetsAt: new Date(1789212000 * 1000).toISOString(), measuredAt: "2026-09-12T09:15:02.000Z", source: "session-file" });
    expect(result).toContainEqual({ id: "weekly_all", percent: 31, resetsAt: new Date(1789600000 * 1000).toISOString(), measuredAt: "2026-09-12T09:15:02.000Z", source: "session-file" });
  });
}

test("andere Dauer, Stand begrenzt und Reset fehlt", async () => {
  writeRollout(home, tokenCount({ used_percent: 104.5, window_minutes: 4320 }, { used_percent: -7, window_minutes: 300 }));
  expect(await readCodexUsage(THREAD_ID)).toEqual([
    { id: "window_4320", percent: 100, measuredAt: MEASURED_AT, source: "session-file" },
    { id: "session", percent: 0, measuredAt: MEASURED_AT, source: "session-file" },
  ]);
});

for (const reset of [undefined, null, "1794988050", 1e100, -1e100, 253402300800]) {
  test(`ungültiger Reset ${String(reset)} lässt das Fenster bestehen`, async () => {
    writeRollout(home, tokenCount({ used_percent: 4.125, window_minutes: 525600, resets_at: reset }));
    expect(await readCodexUsage(THREAD_ID)).toEqual([{ id: "window_525600", percent: 4.125, measuredAt: MEASURED_AT, source: "session-file" }]);
  });
}

test("gleiche Dauer nimmt den höheren Stand samt dessen Reset, bei Gleichstand primary", async () => {
  for (const [a, b] of [[21, 71], [71, 21], [71, 71]]) {
    writeRollout(home, tokenCount({ used_percent: a, window_minutes: 300, resets_at: 1794988050 }, { used_percent: b, window_minutes: 300 }));
    expect(await readCodexUsage(THREAD_ID)).toEqual([{
      id: "session", percent: 71, measuredAt: MEASURED_AT, source: "session-file",
      ...(a >= b ? { resetsAt: "2026-11-18T07:47:30.000Z" } : {}),
    }]);
  }
});

describe("unbekannte Formen werden übersprungen", () => {
  const invalid = [null, [], {}, { used_percent: 2 }, { window_minutes: 300 },
    ...[null, "300", 0, -1, 1.5, 525601, 1e100].map(window_minutes => ({ used_percent: 2, window_minutes })),
    ...[null, "2", true, {}, []].map(used_percent => ({ used_percent, window_minutes: 300 }))];
  for (const window of invalid) {
    test(JSON.stringify(window), async () => {
      writeRollout(home, tokenCount(window));
      expect(await readCodexUsage(THREAD_ID)).toEqual([]);
    });
  }
  test("nicht-endliche Zahlen, falsche Ereignisse und unbrauchbare rate_limits", async () => {
    writeRollout(home, ["null", "[]", '{"type":"token_count"}', tokenCount().replace('"event_msg"', '"other"'),
      tokenCount().replace('"token_count"', '"other"'), tokenCount().replace('"used_percent":48', '"used_percent":1e999'),
      ...[null, [], "unbekannt", {}, { primary: null }].map(rate_limits => JSON.stringify({ type: "event_msg", payload: { type: "token_count", rate_limits } }))].join("\n"));
    expect(await readCodexUsage(THREAD_ID)).toEqual([]);
  });
});

test("letztes gültiges Ereignis vor fehlenden Werten und kaputter letzter Zeile", async () => {
  writeRollout(home, ROLLOUT + tokenCount({ used_percent: 72, window_minutes: 300 })
    + tokenCount(null) + '{"type":"event_msg","payload":{"type":"token_count"}}\n'
    + '{"type":"event_msg","payload":{"type":"token_count",');
  expect(await readCodexUsage(THREAD_ID)).toEqual([{ id: "session", percent: 72, measuredAt: MEASURED_AT, source: "session-file" }]);
});

test("mehrere Megabyte: Anfang allein liefert nichts, nur Ereignis im Ende zählt", async () => {
  const filler = '{"type":"event_msg","payload":{"type":"task_complete"}}\n'.repeat(60_000);
  const path = writeRollout(home, ROLLOUT + filler);
  expect(Buffer.byteLength(filler)).toBeGreaterThan(3_000_000);
  expect(await readCodexUsage(THREAD_ID)).toEqual([]);
  appendFileSync(path, tokenCount({ used_percent: 63, window_minutes: 10080 }));
  expect((await readCodexUsage(THREAD_ID))[0]?.percent).toBe(63);
});

test("einzelne Zeile über 256 KiB und angeschnittene erste Zeile zählen nie", async () => {
  const huge = tokenCount().trimEnd().replace('"payload":', `"padding":"${"x".repeat(300_000)}","payload":`);
  const path = writeRollout(home, huge);
  expect(await readCodexUsage(THREAD_ID)).toEqual([]);
  // Ein angeschnittener Text könnte selbst gültiges JSON ergeben, ist aber keine ganze Zeile.
  writeFileSync(path, "x".repeat(300_000) + tokenCount());
  expect(await readCodexUsage(THREAD_ID)).toEqual([]);
  appendFileSync(path, tokenCount({ used_percent: 19, window_minutes: 300 }));
  expect((await readCodexUsage(THREAD_ID))[0]?.percent).toBe(19);
});

test("gültige Messzeit wird normalisiert, fehlende oder ungültige durch die Lesezeit ersetzt", async () => {
  writeRollout(home, tokenCount(undefined, null, "2026-11-15T18:04:31.207+01:00"));
  expect((await readCodexUsage(THREAD_ID))[0]?.measuredAt).toBe(MEASURED_AT);
  for (const timestamp of [undefined, null, 1794988050, "kaputt", "+999999-01-01T00:00:00Z"]) {
    const event = JSON.parse(tokenCount());
    event.timestamp = timestamp;
    writeRollout(home, JSON.stringify(event));
    expect((await readCodexUsage(THREAD_ID))[0]?.measuredAt).toBe(new Date(now).toISOString());
  }
});

test("nach Mitternacht über Monats- und Jahresgrenze werden lokale Kalendertage gesucht", async () => {
  now = new Date(2026, 0, 1, 0, 1).getTime();
  expect(codexSessionDay(now)).toBe(join("2026", "01", "01"));
  expect(codexSessionDay(now, 1)).toBe(join("2025", "12", "31"));
  expect(codexSessionDay(now, 7)).toBe(join("2025", "12", "25"));
  writeRollout(home, tokenCount(undefined, null, new Date(now).toISOString()), { now, daysAgo: 1 });
  expect((await readCodexUsage(THREAD_ID))[0]?.percent).toBe(48);
});

test("falsche Dateinamen und Verzeichnisse mit passendem Namen sind keine Sitzungsdateien", async () => {
  const day = join(home, "sessions", codexSessionDay(now));
  mkdirSync(join(day, `rollout-zeit-${THREAD_ID}.jsonl`), { recursive: true });
  for (const name of [`anderer-name-${THREAD_ID}.jsonl`, `rollout-zeit-${THREAD_ID}.jsonl.bak`, `rollout-zeit-${THREAD_ID}0.jsonl`]) {
    writeFileSync(join(day, name), ROLLOUT);
  }
  expect(await readCodexUsage(THREAD_ID)).toEqual([]);
});

test("fehlender Ordner, fehlende Datei, fehlendes Ereignis: nur einmalige anonyme Logzeile", async () => {
  expect(await readCodexUsage(THREAD_ID)).toEqual([]);
  mkdirSync(join(home, "sessions", codexSessionDay(now)), { recursive: true });
  expect(await readCodexUsage(THREAD_ID)).toEqual([]);
  writeRollout(home, '{"type":"session_meta"}\n');
  expect(await readCodexUsage(THREAD_ID)).toEqual([]);
  expect(warnings.mock.calls).toEqual([["[CodexUsage] Kein Stand aus der Sitzungsdatei verfügbar; Messung bleibt unverändert."]]);
  resetCodexUsageLogForTests();
  await readCodexUsage(THREAD_ID);
  expect(warnings).toHaveBeenCalledTimes(2);
});

test("unerwartete Quellenfehler werfen nie und werden nicht geloggt", async () => {
  setCodexUsageSourceForTests({ codexHome: () => { throw new Error(`${home}/${THREAD_ID} credits plan_type limit_id`); } });
  expect(await readCodexUsage(THREAD_ID)).toEqual([]);
  const output = warnings.mock.calls.flat().join();
  for (const forbidden of [home, THREAD_ID, "credits", "plan_type", "limit_id"]) expect(output).not.toContain(forbidden);
});

test("nur UUID-Kennungen gelangen zur Suche", async () => {
  let accessed = 0;
  setCodexUsageSourceForTests({ codexHome: () => { accessed++; return home; } });
  for (const id of ["", "../x", `${THREAD_ID}/x`, `${THREAD_ID}..`, "*", `${THREAD_ID}\n`, "a".repeat(500)]) {
    expect(await readCodexUsage(id)).toEqual([]);
  }
  expect(accessed).toBe(0);
});

test("Suche nach Ortszeit: heute vor gestern, bis sieben Tage zurück, kurz nach Mitternacht", async () => {
  now = new Date(2026, 10, 16, 0, 1).getTime();
  expect(codexSessionDay(now)).toBe(join("2026", "11", "16"));
  expect(codexSessionDay(now, 1)).toBe(join("2026", "11", "15"));
  const yesterday = writeRollout(home, tokenCount({ used_percent: 21, window_minutes: 300 }), { now, daysAgo: 1 });
  const today = writeRollout(home, ROLLOUT, { now });
  expect((await readCodexUsage(THREAD_ID))[0]?.percent).toBe(48);
  unlinkSync(today);
  expect((await readCodexUsage(THREAD_ID))[0]?.percent).toBe(21);
  unlinkSync(yesterday);
  const oldest = writeRollout(home, ROLLOUT, { now, daysAgo: 7 });
  expect((await readCodexUsage(THREAD_ID))[0]?.percent).toBe(48);
  unlinkSync(oldest);
  writeRollout(home, ROLLOUT, { now, daysAgo: 8 });
  expect(await readCodexUsage(THREAD_ID)).toEqual([]);
});

test("Pfad-Merker überlebt das Suchfenster, ist aber auf 200 Threads begrenzt", async () => {
  writeRollout(home);
  await readCodexUsage(THREAD_ID);
  now += 10 * 86_400_000;
  expect((await readCodexUsage(THREAD_ID))[0]?.percent).toBe(48);
  now = READ_TIME;
  let lastId = "";
  for (let n = 2; n <= 201; n++) {
    lastId = `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    writeRollout(home, ROLLOUT, { id: lastId });
    await readCodexUsage(lastId);
  }
  now += 10 * 86_400_000;
  expect(await readCodexUsage(THREAD_ID)).toEqual([]);
  expect((await readCodexUsage(lastId))[0]?.percent).toBe(48);
});

test("abgebrochene Messung greift nicht auf Dateien zu und meldet nichts", async () => {
  let accessed = 0;
  setCodexUsageSourceForTests({ codexHome: () => { accessed++; return home; } });
  expect(await readCodexUsage(THREAD_ID, AbortSignal.abort())).toEqual([]);
  expect(accessed).toBe(0);
  expect(warnings).not.toHaveBeenCalled();
});

test("Ablage enthält nur den Messvertrag; ältere Sitzungsdatei überschreibt jüngere externe Messung nicht", async () => {
  writeRollout(home);
  const windows = await readCodexUsage(THREAD_ID);
  expect((await recordUsage("codex", windows)).accepted).toEqual(["weekly_all"]);
  const file = join(dir, "engine-usage.json");
  const stored = readFileSync(file, "utf8");
  expect(JSON.parse(stored).engines.codex.windows).toEqual(windows);
  for (const forbidden of ["credits", "plan_type", "limit_id", "thread_id", THREAD_ID, home]) {
    expect(stored).not.toContain(forbidden);
    expect(warnings.mock.calls.flat().join()).not.toContain(forbidden);
  }
  const external = { ...windows[0], percent: 79, source: "extern" as const, measuredAt: "2026-11-16T10:00:00.000Z" };
  await recordUsage("codex", [external]);
  const before = readFileSync(file, "utf8");
  expect((await recordUsage("codex", await readCodexUsage(THREAD_ID))).rejected).toEqual([{ id: "weekly_all", reason: "older" }]);
  expect(readFileSync(file, "utf8")).toBe(before);
  expect((await readUsage(READ_TIME)).codex).toEqual([{ ...external, state: "known" }]);
});
