/** Motor, Uhr und Prozess als Attrappen; Sitzungsdateien nur im temporären Ordner. */
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortEngineCalls } from "../src/lib/engines/calls";
import { CODEX_KILL_GRACE_MS, CODEX_USAGE_WAIT_MS, codexRuntime, createCodexEngine, setCodexUsageReader, type CodexRuntime } from "../src/lib/engines/codex";
import { readCodexUsage, setCodexUsageSourceForTests } from "../src/lib/engines/codex-usage";
import type { EngineRequest, EngineResult } from "../src/lib/engines/types";
import { readUsage, recordUsage, setUsageFileForTests, type UsageWindow } from "../src/lib/engines/usage";
import { noteStageRun } from "../src/lib/engine-switch-run";
import type { SwitchState } from "../src/lib/engine-switch";
import { setSettingsPath } from "../src/lib/settings";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { ev, installCodexFake, until, type CodexFake } from "./codex-fixture";
import { MEASURED_AT, READ_TIME, THREAD_ID, tokenCount, writeRollout } from "./codex-usage-fixture";

let dir: string, home: string, file: string, fake: CodexFake;
let writes: Promise<unknown>[];
let warnings: ReturnType<typeof spyOn>, errors: ReturnType<typeof spyOn>;
const fullWindow: UsageWindow = { id: "weekly_all", percent: 100, measuredAt: new Date(READ_TIME).toISOString(), resetsAt: "2026-11-18T07:47:30.000Z", source: "session-file" };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tybo-codex-measure-"));
  home = join(dir, "codex");
  file = join(dir, "data/engine-usage.json");
  writes = [];
  setSettingsPath(join(dir, "settings.json"));
  setMcpReaderForTests(() => new Set());
  setUsageFileForTests(file);
  setCodexUsageSourceForTests({ codexHome: () => home, now: () => READ_TIME });
  fake = installCodexFake();
  warnings = spyOn(console, "warn").mockImplementation(() => {});
  errors = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(writes);
  fake.restore();
  setSettingsPath();
  setMcpReaderForTests(null);
  setUsageFileForTests(null);
  setCodexUsageSourceForTests(null);
  warnings.mockRestore(); errors.mockRestore();
  rmSync(dir, { recursive: true, force: true });
});

function wire(read: CodexRuntime["readUsage"] = readCodexUsage, record: CodexRuntime["recordUsage"] = (engine, windows) => {
  const write = recordUsage(engine, windows);
  writes.push(write);
  return write;
}) {
  setCodexUsageReader(read, record);
}

function run(extra: Partial<EngineRequest> = {}) {
  return createCodexEngine().run({ cwd: dir, prompt: "hallo", streaming: true, timeoutMs: 60_000, ...extra });
}

async function switchAfter(result: EngineResult): Promise<SwitchState> {
  let state: SwitchState = { version: 1, blocks: [], counters: [] };
  await noteStageRun({ engine: "codex" }, undefined, result, { enabled: true, threshold: 95, returnBelow: 80 }, READ_TIME,
    async mutate => ({ state: state = mutate(state), persisted: true }),
    { readUsage: async () => ({ claude: [], codex: [], opencode: [], api: [] }) });
  return state;
}

for (const failure of [undefined, "You've hit your usage limit", "quota exceeded", "other failure"]) {
  test(`Prozessabschluss ${failure ?? "Erfolg"}: Messwert im Ergebnis und in der gemeinsamen Ablage`, async () => {
    writeRollout(home);
    wire();
    fake.next({ events: [ev.started(THREAD_ID), ev.message("m", "Antwort"), failure ? ev.failed(failure) : ev.completed()], exitCode: failure ? 1 : 0 });
    const result = await run();
    expect(result).toMatchObject({ engine: "codex", isError: !!failure, text: failure ?? "Antwort", sessionId: THREAD_ID });
    expect(result.rateLimit?.windows).toEqual([{ id: "weekly_all", percent: 48, measuredAt: MEASURED_AT, resetsAt: fullWindow.resetsAt, source: "session-file" }]);
    if (failure?.includes("usage limit")) expect(result.errorKind).toBe("usage_limit");
    if (failure?.includes("quota")) expect(result.errorKind).toBe("quota");
    await Promise.all(writes);
    const saved = readFileSync(file, "utf8");
    expect(JSON.parse(saved).engines.codex.windows).toEqual(result.rateLimit?.windows);
    for (const forbidden of ["credits", "plan_type", "limit_id", "thread_id", THREAD_ID, home]) {
      expect(saved).not.toContain(forbidden);
      // Bestehende [Codex]-Diagnosen nennen die Session; hier gilt nur der neue Leser.
      expect(warnings.mock.calls.filter(call => String(call[0]).startsWith("[CodexUsage]")).flat().join()).not.toContain(forbidden);
    }
    expect(fake.timerCount()).toBe(0);
  });
}

test("volle Woche sperrt unmittelbar bis zum Reset, auch solange das Speichern wartet", async () => {
  writeRollout(home, tokenCount({ used_percent: 100, window_minutes: 10080, resets_at: 1794988050 }, null, fullWindow.measuredAt));
  let finish!: () => void;
  let saving = false;
  wire(readCodexUsage, (engine, windows) => {
    saving = true;
    const saved = new Promise<void>(resolve => { finish = resolve; }).then(() => recordUsage(engine, windows));
    writes.push(saved);
    return saved;
  });
  fake.next({ events: [ev.started(THREAD_ID), ev.failed("usage limit")], exitCode: 1 });
  try {
    const result = await run();
    expect(saving).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(result.rateLimit?.windows).toEqual([fullWindow]);
    expect((await switchAfter(result)).blocks.find(block => block.cause === "limit"))
      .toMatchObject({ engine: "codex", cause: "limit", window: "weekly_all", resetKnown: true, until: fullWindow.resetsAt });
    expect(fake.timerCount()).toBe(0);
  } finally { finish(); }
  await Promise.all(writes);
  expect((await readUsage(READ_TIME)).codex).toEqual([{ ...fullWindow, state: "known" }]);
});

test("Fehler ohne neues Ereignis behält alte Messzeit; keine belegte Reset-Sperre", async () => {
  writeRollout(home, tokenCount({ used_percent: 100, window_minutes: 10080, resets_at: 1794988050 }));
  wire();
  fake.next({ events: [ev.failed("usage limit")], exitCode: 1 });
  const result = await run({ resumeSessionId: THREAD_ID });
  expect(result.rateLimit?.windows[0]?.measuredAt).toBe(MEASURED_AT);
  const state = await switchAfter(result);
  expect(state.blocks.find(block => block.cause === "limit")).toMatchObject({ resetKnown: false, until: new Date(READ_TIME + 3_600_000).toISOString() });
  expect(state.blocks.find(block => block.cause === "limit")?.window).toBeUndefined();
});

test("Fortsetzung ohne thread.started liest mit resumeSessionId; gemeldete Kennung geht vor", async () => {
  const seen: string[] = [];
  wire(async id => { seen.push(id); return []; });
  fake.next({ events: [ev.message("m", "Antwort"), ev.completed()] });
  expect(await run({ resumeSessionId: THREAD_ID })).toMatchObject({ isError: false, text: "Antwort" });
  fake.next({ events: [ev.started("00000000-0000-4000-8000-000000000002"), ev.completed()] });
  await run({ resumeSessionId: THREAD_ID });
  expect(seen).toEqual([THREAD_ID, "00000000-0000-4000-8000-000000000002"]);
  expect(fake.timerCount()).toBe(0);
});

test("ohne Kennung keine Suche und keine Messung", async () => {
  let reads = 0;
  wire(async () => { reads++; return []; });
  fake.next({ events: [ev.message("m", "Antwort"), ev.completed()] });
  expect((await run()).rateLimit).toBeUndefined();
  expect(reads).toBe(0);
});

test("nicht-streamender Lauf übernimmt denselben Messwert", async () => {
  writeRollout(home);
  wire();
  fake.next({ events: [ev.started(THREAD_ID), ev.message("m", "Antwort"), ev.completed()] });
  const result = await run({ streaming: false });
  expect(result).toMatchObject({ text: "Antwort", isError: false, rateLimit: { windows: [{ id: "weekly_all", percent: 48 }] } });
  expect(fake.timerCount()).toBe(0);
});

test("ein beim Abbruchsignal geliefertes Ergebnis wird ebenfalls verworfen", async () => {
  let signal: AbortSignal | undefined;
  let stored = 0;
  wire((_id, cancel) => {
    signal = cancel;
    return new Promise(resolve => cancel!.addEventListener("abort", () => resolve([fullWindow]), { once: true }));
  }, async () => { stored++; return { accepted: [], rejected: [] }; });
  fake.next({ events: [ev.started(THREAD_ID), ev.message("m", "Antwort"), ev.completed()] });
  const running = run();
  await until(() => !!signal);
  fake.advance(CODEX_USAGE_WAIT_MS);
  expect((await running).rateLimit).toBeUndefined();
  expect(stored).toBe(0);
  expect(fake.timerCount()).toBe(0);
});

for (const lateFailure of [false, true]) {
  test(`langsames Lesen endet nach genau zwei Sekunden; spätes ${lateFailure ? "Ablehnen" : "Ergebnis"} bleibt folgenlos`, async () => {
    let complete!: (windows: UsageWindow[]) => void;
    let reject!: (error: Error) => void;
    let signal: AbortSignal | undefined;
    let stored = 0;
    wire((_id, cancel) => {
      signal = cancel;
      return new Promise((resolve, fail) => { complete = resolve; reject = fail; });
    }, async () => { stored++; return { accepted: [], rejected: [] }; });
    fake.next({ events: [ev.started(THREAD_ID), ev.message("m", "Antwort"), ev.completed()] });
    let ended = false;
    const running = run().then(result => { ended = true; return result; });
    await until(() => !!signal);
    const finishedAt = codexRuntime().now();
    fake.advance(CODEX_USAGE_WAIT_MS - 1);
    await Promise.resolve();
    expect(ended).toBe(false);
    fake.advance(1);
    const result = await running;
    expect(codexRuntime().now() - finishedAt).toBe(2_000);
    expect(result).toMatchObject({ isError: false, text: "Antwort", sessionId: THREAD_ID, usage: { inputTokens: 10 }, tools: { uses: [] } });
    expect(result.rateLimit).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(fake.timerCount()).toBe(0);
    rmSync(dir, { recursive: true, force: true });
    if (lateFailure) reject(new Error("später Lesefehler"));
    else complete([fullWindow]);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(stored).toBe(0);
    expect(existsSync(dir)).toBe(false);
    expect(warnings.mock.calls).toEqual([["[CodexUsage] Kein Stand aus der Sitzungsdatei verfügbar; Messung bleibt unverändert."]]);
  });
}

test("Lesefehler, fehlende Datei und Schreibfehler verändern die Antwort nicht", async () => {
  for (const read of [readCodexUsage, () => { throw new Error(home); }, async () => { throw new Error(THREAD_ID); }, async () => [fullWindow]]) {
    wire(read, async () => { throw new Error("Schreibfehler"); });
    fake.next({ events: [ev.started(THREAD_ID), ev.message("m", "Antwort"), ev.completed()] });
    expect(await run()).toMatchObject({ text: "Antwort", isError: false });
    expect(fake.timerCount()).toBe(0);
  }
  expect(warnings).toHaveBeenCalledTimes(1);
  expect(warnings.mock.calls.flat().join()).not.toContain(home);
  expect(warnings.mock.calls.flat().join()).not.toContain(THREAD_ID);
});

test("Standard-Runtime und Teil-Attrappen setzen eine echte Verdrahtung vollständig zurück", async () => {
  let reads = 0, records = 0;
  wire(async () => { reads++; return [fullWindow]; }, async () => { records++; return { accepted: [], rejected: [] }; });
  fake.restore();
  expect(codexRuntime().readUsage).toBeUndefined();
  expect(codexRuntime().recordUsage).toBeUndefined();
  fake = installCodexFake();
  setCodexUsageSourceForTests({ codexHome: () => { throw new Error("echter Ordner darf nicht gelesen werden"); } });
  fake.next({ events: [ev.started(THREAD_ID), ev.message("m", "Antwort"), ev.completed()] });
  expect(await run()).toMatchObject({ text: "Antwort", isError: false });
  expect(reads).toBe(0); expect(records).toBe(0);
  expect(warnings).not.toHaveBeenCalled();
  expect(existsSync(file)).toBe(false);
});

for (const stop of ["abort", "prompt", "timeout"] as const) {
  test(`${stop}: kein Lesen und keine zusätzliche Wartezeit`, async () => {
    let reads = 0;
    wire(async () => { reads++; return new Promise(() => {}); });
    fake.next({ events: [ev.started(THREAD_ID)], hang: true, ...(stop === "prompt" ? { stdinWriteThrows: "EPIPE" } : {}) });
    const running = run({ abortKey: "codex-usage-stop", timeoutMs: 100 });
    if (stop === "abort") abortEngineCalls("codex-usage-stop");
    if (stop === "timeout") fake.advance(100);
    const result = await running;
    expect(result.isError).toBe(true);
    expect(reads).toBe(0);
    if (stop === "abort") expect(result.aborted).toBe(true);
    if (stop === "timeout") expect(result.timedOut).toBe(true);
    if (stop === "prompt") expect(result.text).toContain("Auftrag nicht angenommen");
    fake.advance(CODEX_KILL_GRACE_MS);
    expect(fake.timerCount()).toBe(0);
  });
}
