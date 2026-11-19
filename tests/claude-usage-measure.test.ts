/** Der echte Aufrufweg mit Prozessattrappe, eigener Uhr und temporären Ablagen. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_CLAUDE_AUX } from "../src/lib/aux-targets";
import { createEngineChecker } from "../src/lib/engine-check-now";
import { PROJECT_ROOT } from "../src/lib/env";
import { callClaudeStreaming, setRuntimeForTests, setSpawnForTests } from "../src/lib/claude";
import { setClaudeAvailability } from "../src/lib/claude-availability";
import { stageBlock, type SwitchBlock } from "../src/lib/engine-switch";
import { readSwitchState, setSwitchStateFileForTests, setSwitchStateWriterForTests, updateSwitchState } from "../src/lib/engine-switch-state";
import { abortAllEngineCalls, activeEngineCallCount } from "../src/lib/engines/calls";
import { CLAUDE_USAGE_TIMEOUT_MS, createClaudeUsageService } from "../src/lib/engines/claude-usage";
import { readUsage, recordUsage, setUsageFileForTests } from "../src/lib/engines/usage";
import { currentExecution, runCancelable } from "../src/lib/execution-context";
import { PRINT_MODE_DISALLOWED_TOOLS, setMcpReaderForTests } from "../src/lib/subprocess-env";
import { isolateShellEnv } from "./shell-env";

isolateShellEnv({ CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: undefined });
const marker = "ERFUNDENES-KENNWORT-671";
const report = (percent = 7, kind = "weekly_scoped", family = "Fable") => ({ rate_limits: { limits: [
  { kind, percent, scope: { model: { display_name: family } } },
] } });
function fakeProcess() {
  let out!: ReadableStreamDefaultController<Uint8Array>;
  let err!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (code: number) => void;
  let closed = false;
  const input: string[] = [];
  return {
    input,
    proc: {
      pid: 0, stdin: { write(text: string) { input.push(text); }, end() {} },
      stdout: new ReadableStream<Uint8Array>({ start(c) { out = c; } }),
      stderr: new ReadableStream<Uint8Array>({ start(c) { err = c; } }),
      exited: new Promise<number>(resolve => { resolveExit = resolve; }),
      kill() { throw new Error("Echtes Prozesssignal verboten"); },
    },
    line(value: unknown) { out.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n")); },
    stderr() { err.enqueue(new TextEncoder().encode(marker)); },
    finish(error?: Error) {
      if (closed) return;
      closed = true;
      if (error) out.error(error); else out.close();
      err.close(); resolveExit(error ? 1 : 0);
    },
  };
}
let fp: ReturnType<typeof fakeProcess>;
let now: number;
let dir: string;
let usageFile: string;
let switchFile: string;
let starts: any[];
let timers: Map<number, { fn: () => void; ms: number }>;
let terminated: number;
let errorLog: ReturnType<typeof spyOn>;
let warnLog: ReturnType<typeof spyOn>;
const service = (deps: Parameters<typeof createClaudeUsageService>[0] = {}) => createClaudeUsageService({
  now: () => now, readSettings: () => ({ engine: { backups: [{ engine: "codex" }] } }), ...deps,
});
const iso = (offset = 0) => new Date(now + offset).toISOString();
const block = (extra: Partial<SwitchBlock> = {}): SwitchBlock => ({ engine: "claude", cause: "threshold",
  window: "weekly_scoped:fable", since: iso(-60_000), until: iso(7_200_000), resetKnown: true, ...extra });
function output(usage_report: unknown = report(), limit = false) {
  fp.line({ type: "assistant", message: { content: [{ type: "text", text: marker }] }, local_command_source: marker, usage_report });
  fp.line({ type: "result", is_error: limit, result: limit ? `You've hit your usage limit ${marker}` : marker, total_cost_usd: 0 });
  fp.stderr();
  fp.finish();
}

beforeEach(() => {
  now = Date.now() - 86_400_000;
  dir = mkdtempSync(join(tmpdir(), "tybo-usage-measure-"));
  usageFile = join(dir, "usage.json"); switchFile = join(dir, "switch.json");
  setUsageFileForTests(usageFile, 40); setSwitchStateFileForTests(switchFile, 40);
  fp = fakeProcess(); starts = []; timers = new Map(); terminated = 0;
  let next = 0;
  setSpawnForTests(((options: any) => { starts.push(options); return fp.proc; }) as any);
  setRuntimeForTests({ now: () => now, setTimeout: (fn, ms) => { const id = ++next; timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => { timers.delete(id as number); }, terminate: () => { terminated++; fp.finish(); } });
  setMcpReaderForTests(() => new Set());
  errorLog = spyOn(console, "error").mockImplementation(() => {});
  warnLog = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  fp.finish(); setSpawnForTests(null); setRuntimeForTests(null); setMcpReaderForTests(null);
  setUsageFileForTests(null); setSwitchStateFileForTests(null);
  errorLog.mockRestore(); warnLog.mockRestore(); rmSync(dir, { recursive: true, force: true });
});

describe("Messlauf", () => {
  test("Prompt über stdin, keine Session, keine Gesprächskennung; derselbe Lauf für zwei Anforderer", async () => {
    const s = service();
    await runCancelable("topic:123:456", async () => {
      const first = s.measure();
      const second = s.measure();
      expect(second).toBe(first);
      expect(activeEngineCallCount()).toBe(1);
      expect(starts).toHaveLength(1);
      expect(starts[0].cwd).toBe(PROJECT_ROOT);
      expect(starts[0].cmd).toContain(DEFAULT_CLAUDE_AUX);
      expect(starts[0].cmd).toContain("--include-partial-messages");
      expect(starts[0].cmd).toContain(PRINT_MODE_DISALLOWED_TOOLS.join(","));
      expect(starts[0].cmd).not.toContain("--resume");
      expect(starts[0].cmd).not.toContain("/usage");
      expect(starts[0].env.TYBO_SUBPROCESS).toBe("1");
      expect(starts[0].env.TYBO_CONVERSATION_ID).toBeUndefined();
      expect(fp.input).toEqual(["/usage"]);
      now += 10_000;
      output();
      expect(await first).toEqual({ status: "measured" });
      expect(await second).toBe(await first);
      expect(currentExecution()?.key).toBe("topic:123:456");
    });
    expect((await readUsage(now)).claude[0]).toMatchObject({ id: "weekly_scoped:fable", measuredAt: iso(), source: "report" });
    expect(activeEngineCallCount()).toBe(0);
    expect(errorLog).not.toHaveBeenCalled();
  });

  test.each(["api-key", "missing", "shutdown"])("nicht messbar bei %s: kein Prozess, keine Ablage", async reason => {
    if (reason === "api-key") process.env.CLAUDE_AUTH = "apiKey";
    if (reason === "missing") setClaudeAvailability({ state: "missing", reason: "Test" });
    if (reason === "shutdown") abortAllEngineCalls({ probes: true });
    expect(await service().measure()).toEqual({ status: "not-measurable", reason });
    expect(starts).toEqual([]); expect(readdirSync(dir)).toEqual([]); expect(warnLog).not.toHaveBeenCalled();
  });

  test("Zeitlimit nach 25 s: beenden, keine Werte oder Sperren ändern, genau eine feste Logzeile", async () => {
    await recordUsage("claude", [{ id: "weekly_all", percent: 96, measuredAt: iso(-60_000), source: "extern" }]);
    await updateSwitchState(state => ({ ...state, blocks: [block()], counters: [
      { engine: "claude", kind: "limit", scope: "fable", count: 3, lastAt: iso(-60_000) },
    ] }));
    const previous = [readFileSync(usageFile, "utf8"), readFileSync(switchFile, "utf8")];
    warnLog.mockClear();
    const s = service();
    const run = s.measure();
    fp.stderr();
    const timer = [...timers.values()].find(t => t.ms === CLAUDE_USAGE_TIMEOUT_MS)!;
    expect(timer.ms).toBe(25_000);
    now += 25_000; timer.fn();
    expect(await run).toEqual({ status: "failed", reason: "Zeitlimit" });
    expect(terminated).toBe(1); expect(timers.size).toBe(0);
    expect([readFileSync(usageFile, "utf8"), readFileSync(switchFile, "utf8")]).toEqual(previous);
    expect(warnLog.mock.calls).toEqual([["[Motor] Messlauf Claude Code ohne Ergebnis (Zeitlimit)"]]);
    expect(errorLog).not.toHaveBeenCalled();
    expect(s.lastAttemptAt()).toBe(now - 25_000);
  });

  test.each([undefined, { rate_limits: { limits: null } }, {}])("ohne verwertbaren Bericht unveränderter Stand", async value => {
    await recordUsage("claude", [{ id: "weekly_all", percent: 96, measuredAt: iso(-60_000), source: "extern" }]);
    await updateSwitchState(state => ({ ...state, blocks: [block()], counters: [
      { engine: "claude", kind: "limit", scope: "fable", count: 3, lastAt: iso(-60_000) },
    ] }));
    const previous = [readFileSync(usageFile, "utf8"), readFileSync(switchFile, "utf8")];
    warnLog.mockClear();
    // Explizit undefined übergeben, ohne den Standardwert von output.
    fp.line({ type: "assistant", usage_report: value, local_command_source: marker });
    fp.line({ type: "result", result: marker }); fp.stderr(); fp.finish();
    expect((await service().measure()).status).toBe("failed");
    expect([readFileSync(usageFile, "utf8"), readFileSync(switchFile, "utf8")]).toEqual(previous);
    expect(warnLog).toHaveBeenCalledTimes(1); expect(errorLog).not.toHaveBeenCalled();
  });

  test("frische Messung unter Rückkehrschwelle löst threshold und limit; andere Fenster und Familienpause bleiben", async () => {
    const unmeasured = block({ window: "weekly_scoped:opus" });
    const familyPause = block({ cause: "limit", window: undefined, family: "fable" });
    await updateSwitchState(state => ({ ...state, blocks: [block(), block({ cause: "limit" }), unmeasured, familyPause],
      counters: [{ engine: "claude", kind: "limit", scope: "fable", count: 4, lastAt: iso(-60_000) }] }));
    output();
    expect(await service().measure()).toEqual({ status: "measured" });
    expect(readSwitchState().blocks).toEqual([unmeasured, familyPause]);
    expect(readSwitchState().counters[0].count).toBe(4);
  });

  test("96 Prozent sperren Fable für 60 Minuten ohne Reset, Opus bleibt frei", async () => {
    output(report(96));
    expect(await service().measure()).toEqual({ status: "measured" });
    const state = readSwitchState();
    expect(stageBlock({ engine: "claude", model: "claude-fable-5-2" }, undefined, state, now)).toMatchObject({
      window: "weekly_scoped:fable", percent: 96, until: iso(3_600_000), resetKnown: false,
    });
    expect(stageBlock({ engine: "claude", model: "claude-opus-5-5" }, undefined, state, now)).toBeUndefined();
  });

  test("bekannter Reset und Schreibfehler des Sperrzustands: Messung gilt im Speicher", async () => {
    setSwitchStateWriterForTests(async () => { throw new Error(marker); });
    output({ rate_limits: { limits: [{ kind: "weekly_all", percent: 96, resets_at: iso(7_200_000) }] } });
    expect(await service().measure()).toEqual({ status: "measured" });
    expect(readSwitchState().blocks[0]).toMatchObject({ until: iso(7_200_000), resetKnown: true });
    expect(existsSync(switchFile)).toBe(false);
    expect(JSON.stringify(warnLog.mock.calls)).not.toContain(marker);
  });

  test("gültiger Bericht auch bei Limit-Text: keine Antworttexte, stderr oder Kosten in Logs und Dateien", async () => {
    output(report(100), true);
    expect(await service().measure()).toEqual({ status: "measured" });
    expect(errorLog).not.toHaveBeenCalled();
    expect(JSON.stringify(warnLog.mock.calls)).not.toContain(marker);
    expect(readdirSync(dir).sort()).toEqual(["switch.json", "usage.json"]);
    for (const name of readdirSync(dir)) {
      const text = readFileSync(join(dir, name), "utf8");
      expect(text).not.toContain(marker); expect(text).not.toContain("costUsd");
    }
  });

  test("Abbruch des ersten Anforderers beendet den Prozess und verwirft den Bericht", async () => {
    const owner = new AbortController();
    const s = service(); const first = s.measure({ signal: owner.signal }); const second = s.measure();
    fp.line({ type: "assistant", usage_report: report() }); fp.stderr();
    owner.abort();
    expect(await first).toEqual({ status: "failed", reason: "abgebrochen" });
    expect(await second).toBe(await first);
    expect(terminated).toBe(1); expect(readdirSync(dir)).toEqual([]);
  });

  test("Abbruch eines beitretenden Anforderers beendet nur sein Warten", async () => {
    const s = service(); const first = s.measure(); const waiter = new AbortController();
    const second = s.measure({ signal: waiter.signal }); waiter.abort();
    expect(await second).toEqual({ status: "failed", reason: "abgebrochen" });
    expect(terminated).toBe(0); expect(activeEngineCallCount()).toBe(1);
    output(); expect(await first).toEqual({ status: "measured" }); expect(starts).toHaveLength(1);
  });

  test("beim Warten auf die Dateisperre abgebrochen: kein spätes Speichern", async () => {
    const owner = new AbortController();
    let saving!: () => void;
    const started = new Promise<void>(resolve => { saving = resolve; });
    const s = service({ record: (...args) => { const p = recordUsage(...args); saving(); return p; } });
    writeFileSync(`${usageFile}.lock`, JSON.stringify({ pid: process.pid, token: "test" }));
    output(); const run = s.measure({ signal: owner.signal, evaluate: false });
    await started; owner.abort(); rmSync(`${usageFile}.lock`);
    expect(await run).toEqual({ status: "failed", reason: "abgebrochen" });
    expect(existsSync(usageFile)).toBe(false); expect(existsSync(switchFile)).toBe(false);
  });

  test("Prüfpfad speichert nur Messwerte, seine spätere Bewertung zählt die Sperre", async () => {
    await updateSwitchState(state => ({ ...state, blocks: [block()] }));
    output(); expect(await service().measure({ evaluate: false })).toEqual({ status: "measured" });
    expect(readSwitchState().blocks).toHaveLength(1);
  });
});

describe("quiet im Streaming", () => {
  test.each(["start", "input", "read", "joined", "auth"])("keine Diagnose für %s, auch nicht mit fremdem Fehlertext", async kind => {
    if (kind === "start") setSpawnForTests((() => { throw Object.assign(new Error(marker), { code: "ENOENT" }); }) as any);
    else if (kind === "input") fp.proc.stdin.write = () => { throw new Error(marker); };
    else if (kind === "read") { fp.stderr(); fp.finish(new Error(marker)); }
    else if (kind === "auth") process.env.CLAUDE_AUTH = "apiKey";
    else { fp.line({ type: "assistant", message: { id: "first", content: [{ type: "text", text: marker }] } }); output(); }
    await callClaudeStreaming({ prompt: "/usage", quiet: true });
    expect(errorLog).not.toHaveBeenCalled();
  });
});

describe("Messung im Prüfkern", () => {
  const checker = (s: ReturnType<typeof service>, timeoutMs = 30_000) => createEngineChecker({
    now: () => now, readSettings: () => ({ engine: { backups: [{ engine: "codex" }] } }),
    claudeSubscription: () => true,
    measurements: { claude: [{ timeoutMs, measure: signal => s.measure({ signal, evaluate: false }) }] },
  });

  test("gelungener Bericht mit altem Opus-Fenster heißt gemessen und zählt die aufgehobene Sperre", async () => {
    await recordUsage("claude", [{ id: "weekly_scoped:opus", percent: 96, measuredAt: iso(-60_000), source: "extern" }]);
    await updateSwitchState(state => ({ ...state, blocks: [block()] }));
    output();
    const result = await checker(service())();
    expect(result).toMatchObject({ before: 1, lifted: 1, remaining: 0, liftedWithoutMeasurement: 0,
      measured: { claude: true }, measurementResults: { claude: "measured" } });
    expect(result.notMeasured).not.toContain("claude");
  });

  test("beitretende Prüfung zählt auch die Freigabe eines schon laufenden Hintergrundmesslaufs", async () => {
    await updateSwitchState(state => ({ ...state, blocks: [block()] }));
    const s = service(); const background = s.measure(); const checked = checker(s)();
    output();
    expect(await background).toEqual({ status: "measured" });
    expect(await checked).toMatchObject({ before: 1, lifted: 1, remaining: 0, measured: { claude: true } });
    expect(starts).toHaveLength(1);
  });

  test("Prüfdeckel bricht die eigene Messung ab, verwirft spätes Ergebnis und prüft trotzdem die Sperre neu", async () => {
    await updateSwitchState(state => ({ ...state, blocks: [block()] }));
    const s = service();
    const checked = checker(s, 5)();
    fp.stderr();
    const result = await checked;
    expect(result).toMatchObject({ before: 1, lifted: 1, remaining: 0, liftedWithoutMeasurement: 1,
      measured: { claude: false }, measurementResults: { claude: "failed" } });
    expect(result.notMeasured).not.toContain("claude");
    expect(terminated).toBe(1); expect(existsSync(usageFile)).toBe(false);
    expect(activeEngineCallCount()).toBe(0);
  });
});
