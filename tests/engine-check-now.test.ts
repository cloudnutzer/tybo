/** Prüfergebnis entsteht im selben Schreibdurchgang wie recheck, ohne echte Motoren. */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngineChecker } from "../src/lib/engine-check-now";
import { createEngineCommandServices } from "../src/lib/engine-choice";
import { readSwitchState, setSwitchStateFileForTests, updateSwitchState } from "../src/lib/engine-switch-state";
import { type SwitchBlock, type SwitchUsage } from "../src/lib/engine-switch";
import type { Settings } from "../src/lib/settings";

const now = Date.parse("2026-11-17T12:00:00Z");
const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
let dir: string;
let settings: Settings;
const usage: SwitchUsage = { claude: [], codex: [], opencode: [], api: [] };
const block = (engine: SwitchBlock["engine"], cause: SwitchBlock["cause"], until = at(60)): SwitchBlock => ({ engine, cause, since: at(-10), until, resetKnown: false });
const runtime = () => ({ now: () => now, readSettings: () => settings, readState: readSwitchState, updateState: updateSwitchState, readUsage: async () => usage,
  checkEngine: async (engine: SwitchBlock["engine"]) => ({ engine, checked: true, installed: true, loggedIn: true }), forgetCheck: () => {}, measurements: {} });
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-check-now-")); setSwitchStateFileForTests(join(dir, "switch.json"));
  settings = { engine: { backups: [{ engine: "codex" }] } };
});
afterEach(() => { setSwitchStateFileForTests(null); rmSync(dir, { recursive: true, force: true }); });

test("abgelaufene Ausfälle werden entfernt, aber nicht als aufgehoben gezählt", async () => {
  await updateSwitchState(s => ({ ...s, blocks: [block("claude", "outage", at(-1)), block("codex", "limit", at(0))] }));
  const check = createEngineChecker({ ...runtime(), checkEngine: async () => { throw new Error("keine aktive Ausfallsperre"); } });
  expect(await check()).toMatchObject({ before: 0, lifted: 0, remaining: 0, liftedWithoutMeasurement: 0 });
  expect(readSwitchState().blocks).toEqual([]);
});

test("Zahlen berücksichtigen erst während der Mutation hinzugekommene Sperren", async () => {
  const check = createEngineChecker({ ...runtime(), updateState: async mutate => {
    await updateSwitchState(s => ({ ...s, blocks: [block("codex", "limit")] }));
    return updateSwitchState(mutate);
  } });
  expect(await check()).toMatchObject({ before: 1, lifted: 1, remaining: 0, liftedWithoutMeasurement: 1 });
});

test("gleichzeitige Aufrufe teilen Messung, Mutation und Zahlen", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let measured = 0;
  await updateSwitchState(s => ({ ...s, blocks: [block("codex", "limit")] }));
  const check = createEngineChecker({ ...runtime(), measurements: { claude: [{ timeoutMs: 1000, measure: async () => { measured++; await gate; } }] } });
  const first = check(); const second = check();
  expect(first).toBe(second);
  release();
  const result = await first;
  expect(measured).toBe(1);
  expect(result).toMatchObject({ before: 1, lifted: 1, remaining: 0, liftedWithoutMeasurement: 1 });
});

test("Dienst nutzt Prüfkern und dessen Bereitschaft einmal je Aufruf", async () => {
  let checked = 0;
  const d = runtime();
  d.checkEngine = async engine => { checked++; return { engine, checked: true, installed: true, loggedIn: true }; };
  await updateSwitchState(s => ({ ...s, blocks: [block("claude", "outage")] }));
  const service = createEngineCommandServices({ getSettings: () => settings, env: () => ({}), now: () => now,
    readSwitchState, updateSwitchState, readUsage: d.readUsage, checkEngine: d.checkEngine, checkNow: createEngineChecker(d) });
  const result = await service.check("dm:668", "general");
  expect(result).toMatchObject({ before: 1, lifted: 1, remaining: 0, liftedWithoutMeasurement: 0 });
  expect(result.preview.answering?.engine).toBe("claude");
  expect(checked).toBe(4);
});

test("Befehlsvorschau teilt auch ohne Ersatzstufen einen Stand der Bereitschaft", async () => {
  settings = { engine: { default: "codex" } };
  const checked: string[] = [];
  const service = createEngineCommandServices({ getSettings: () => settings, env: () => ({}), checkEngine: async engine => {
    checked.push(engine); return { engine, checked: true, installed: true, loggedIn: true };
  } });
  const result = await service.preview("dm:668", "general");
  expect(result.available).toHaveLength(4); expect(checked).toHaveLength(4); expect(new Set(checked).size).toBe(4);
});
