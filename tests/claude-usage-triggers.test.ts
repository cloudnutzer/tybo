import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installClaudeUsageMeasurement } from "../src/app/bot-start";
import { engineMeasurements } from "../src/lib/engine-check-now";
import { readSwitchState, setSwitchStateFileForTests, updateSwitchState } from "../src/lib/engine-switch-state";
import { CLAUDE_USAGE_WATCH_TICK_MS, createClaudeUsageService, scheduleClaudeUsageAfterChat } from "../src/lib/engines/claude-usage";
import { readUsage, recordUsage, setUsageFileForTests } from "../src/lib/engines/usage";
import { currentExecution, runCancelable } from "../src/lib/execution-context";

let dir: string;
let now: number;
let calls: number;
let tick: () => Promise<void>;
let queued: (() => Promise<void>) | undefined;
let cancelled: number;
let stopped: number;
let fail: boolean;
const iso = (offset = 0) => new Date(now + offset).toISOString();
const MIN = 60_000;
const makeService = () => createClaudeUsageService({
  now: () => now, subscription: () => true, missing: () => false, shutdown: () => false,
  readSettings: () => ({ engine: { backups: [{ engine: "codex" }] } }), log: () => {},
  call: async () => {
    calls++;
    return fail ? { text: "", isError: true } : { text: "", isError: false, usageReport: { rate_limits: { limits: [
      { kind: "weekly_all", percent: 4 }, { kind: "session", percent: 21 },
    ] } } };
  },
  every: (ms, run) => { expect(ms).toBe(CLAUDE_USAGE_WATCH_TICK_MS); expect(currentExecution()).toBeUndefined(); tick = run; return () => { stopped++; }; },
  defer: run => { expect(currentExecution()).toBeUndefined(); queued = run; return () => { cancelled++; queued = undefined; }; },
});
const flush = async () => { const run = queued; queued = undefined; await run?.(); };
const seed = (source: "report" | "stream", minutes = -11) => recordUsage("claude", [
  { id: "weekly_all", percent: 4, source, measuredAt: iso(minutes * MIN) },
  { id: "session", percent: 21, source, measuredAt: iso(minutes * MIN) },
]);
beforeEach(async () => {
  now = Date.now() - 86_400_000;
  calls = cancelled = stopped = 0; fail = false; queued = undefined;
  dir = mkdtempSync(join(tmpdir(), "tybo-usage-triggers-"));
  setUsageFileForTests(join(dir, "usage.json")); setSwitchStateFileForTests(join(dir, "switch.json"));
  await seed("stream");
});
afterEach(() => { setUsageFileForTests(null); setSwitchStateFileForTests(null); rmSync(dir, { recursive: true, force: true }); });

test("nach Chat: verzögert ohne Gesprächskontext, bei fehlendem Bericht und erst nach mehr als zehn Minuten", async () => {
  const s = makeService();
  await runCancelable("topic:123:4", async () => { s.afterChat(); s.afterChat(); expect(calls).toBe(0); });
  await flush(); expect(calls).toBe(1);
  now += 10 * MIN; s.afterChat(); await flush(); expect(calls).toBe(1);
  now++; s.afterChat(); await flush(); expect(calls).toBe(2);
});

test("frischer Bericht aus der Ablage drosselt auch direkt nach einem Neustart", async () => {
  await seed("report", -9);
  const s = makeService(); s.afterChat(); await flush(); expect(calls).toBe(0);
  // Der erste Chat überschreibt report, noch bevor dieser Dienst selbst misst.
  await seed("stream", 0);
  s.afterChat(); await flush(); expect(calls).toBe(0);
  now += 2 * MIN; s.afterChat(); await flush(); expect(calls).toBe(1);
});

test.each([false, true])("Drossel bleibt nach überschriebenen report-Fenstern und Fehler=%s", async failed => {
  fail = failed;
  const s = makeService(); s.afterChat(); await flush(); expect(calls).toBe(1);
  now += MIN; await seed("stream", 0);
  expect((await readUsage(now)).claude.every(w => w.source === "stream")).toBe(true);
  for (let n = 0; n < 8; n++) { now += MIN; s.afterChat(); await flush(); }
  expect(calls).toBe(1);
  now += 2 * MIN; s.afterChat(); await flush(); expect(calls).toBe(2);
});

test("Zeitgeber misst nur aktive threshold/limit-Sperren von Claude; Familienpause bleibt", async () => {
  const s = makeService(); const stop = s.startWatch();
  await tick(); expect(calls).toBe(0);
  for (const [engine, cause, until] of [["codex", "limit", iso(120 * MIN)], ["claude", "outage", iso(120 * MIN)],
    ["claude", "threshold", iso(-MIN)], ["claude", "limit", iso()]] as const) {
    await updateSwitchState(state => ({ ...state, blocks: [{ engine, cause, since: iso(-MIN), until, resetKnown: false }] }));
    await tick(); expect(calls).toBe(0);
  }
  await updateSwitchState(state => ({ ...state, blocks: [{ engine: "claude", cause: "limit", family: "fable",
    since: iso(-MIN), until: iso(120 * MIN), resetKnown: false }] }));
  await tick(); expect(calls).toBe(1); expect(readSwitchState().blocks).toHaveLength(1);
  now += 25 * MIN; await tick(); expect(calls).toBe(1);
  now += 5 * MIN; await tick(); expect(calls).toBe(2);
  s.afterChat(); stop(); expect(stopped).toBe(1); expect(cancelled).toBe(1);
  now += 30 * MIN; await tick(); s.afterChat(); await flush(); expect(calls).toBe(2);
});

test("gescheiterte Versuche während einer Sperre höchstens alle 30 Minuten, keine Leerlaufmessung", async () => {
  fail = true;
  const s = makeService(); s.startWatch();
  await updateSwitchState(state => ({ ...state, blocks: [{ engine: "claude", cause: "threshold", window: "weekly_all",
    since: iso(-MIN), until: iso(120 * MIN), resetKnown: false }] }));
  for (let n = 0; n < 12; n++) { await tick(); now += 5 * MIN; }
  expect(calls).toBe(2);
  await updateSwitchState(state => ({ ...state, blocks: [] }));
  await tick(); expect(calls).toBe(2);
});

test("Registrierung ausschließlich beim Bot-Start, Prüffunktion ohne eigene Neubewertung und Aufräumen", async () => {
  expect(engineMeasurements.claude).toEqual([]);
  let requested = 0; let measured = 0;
  const remove = installClaudeUsageMeasurement(async options => {
    expect(options?.evaluate).toBe(false); expect(options?.signal).toBeInstanceOf(AbortSignal);
    measured++; return { status: "measured" };
  }, () => { requested++; });
  try {
    expect(engineMeasurements.claude).toHaveLength(1);
    expect(engineMeasurements.claude[0].timeoutMs).toBe(30_000);
    expect(await engineMeasurements.claude[0].measure(new AbortController().signal)).toEqual({ status: "measured" });
    scheduleClaudeUsageAfterChat(); expect(requested).toBe(1); expect(measured).toBe(1);
  } finally { remove(); }
  expect(engineMeasurements.claude).toEqual([]);
  scheduleClaudeUsageAfterChat(); expect(requested).toBe(1);
});

test("echter Zeitgeber hält einen ansonsten fertigen Prozess nicht am Leben", async () => {
  const module = new URL("../src/lib/engines/claude-usage.ts", import.meta.url).pathname;
  const proc = Bun.spawn([process.execPath, "-e", `import { startClaudeUsageWatch } from ${JSON.stringify(module)}; startClaudeUsageWatch();`],
    { stdout: "pipe", stderr: "pipe", timeout: 5000 });
  expect(await proc.exited).toBe(0);
});
