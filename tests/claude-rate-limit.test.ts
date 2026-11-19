/** Limit-Messwerte durch den echten Aufrufweg, ausschließlich mit Prozessattrappen. */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { abortClaudeCalls, callClaudeStreaming, setRuntimeForTests, setSpawnForTests } from "../src/lib/claude";
import { createClaudeEngine } from "../src/lib/engines/claude";
import type { EngineRequest } from "../src/lib/engines/types";
import { readUsage, recordUsage, setUsageFileForTests, type RecordUsageResult } from "../src/lib/engines/usage";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { isolateShellEnv } from "./shell-env";

isolateShellEnv({ CLAUDE_AUTH: "subscription", ANTHROPIC_API_KEY: undefined });
const fixture = readFileSync(new URL("./fixtures/claude-rate-limit-stream.jsonl", import.meta.url), "utf8");
const rateLine = fixture.trim().split("\n")[2];
const at = Date.parse("2026-01-02T12:00:00.000Z");
const expected = {
  status: "allowed", rateLimitType: "seven_day", resetsAt: "2026-11-22T15:00:00.000Z",
  overageStatus: "rejected", isUsingOverage: false,
  windows: [{ id: "weekly_all", percent: 6, resetsAt: "2026-11-22T15:00:00.000Z", measuredAt: new Date(at).toISOString(), source: "stream" }],
};

function fakeProcess() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let resolveExit!: (code: number) => void;
  let closed = false;
  const proc = {
    pid: 0,
    stdin: { write() {}, end() {} },
    stdout: new ReadableStream<Uint8Array>({ start(c) { controller = c; } }),
    stderr: new ReadableStream<Uint8Array>({ start(c) { c.close(); } }),
    exited: new Promise<number>(resolve => { resolveExit = resolve; }),
    kill() { throw new Error("Echtes Prozesssignal ist in diesem Test verboten"); },
  };
  return {
    proc,
    write(text: string) { controller.enqueue(new TextEncoder().encode(text)); },
    finish(code = 0, error?: Error) {
      if (closed) return;
      closed = true;
      if (error) controller.error(error);
      else controller.close();
      resolveExit(code);
    },
  };
}

let fp: ReturnType<typeof fakeProcess>;
let log: ReturnType<typeof spyOn>;
let warnings: ReturnType<typeof spyOn>;
let timers: Map<number, { fn: () => void; ms: number; interval: boolean }>;
let directory: string;
let file: string;
let writes: Promise<RecordUsageResult>[];
const record: typeof recordUsage = (engine, windows) => {
  const pending = recordUsage(engine, windows);
  writes.push(pending);
  return pending;
};
const runEngine = (options: Partial<EngineRequest> = {}, save = record) => createClaudeEngine({ recordUsage: save }).run({
  prompt: "Probe", streaming: true, cwd: process.cwd(), timeoutMs: 1234, ...options,
});
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "claude-rate-limit-"));
  file = join(directory, "usage.json");
  writes = [];
  setUsageFileForTests(file, 40);
  warnings = spyOn(console, "warn").mockImplementation(() => {});
  fp = fakeProcess();
  timers = new Map();
  let nextTimer = 0;
  setSpawnForTests((() => fp.proc) as any);
  setRuntimeForTests({
    now: () => at,
    setTimeout: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms, interval: false }); return id; },
    clearTimeout: id => { timers.delete(id as number); },
    setInterval: (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms, interval: true }); return id; },
    clearInterval: id => { timers.delete(id as number); },
    terminate: () => fp.finish(),
  });
  setMcpReaderForTests(() => new Set());
  log = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(writes);
  setUsageFileForTests(null);
  rmSync(directory, { recursive: true, force: true });
  warnings.mockRestore();
  fp.finish();
  setSpawnForTests(null);
  setRuntimeForTests(null);
  setMcpReaderForTests(null);
  log.mockRestore();
});

describe("Limit-Meldung an allen Ausgängen", () => {
  test("Erfolg aus der Vorlage", async () => {
    fp.write(fixture);
    fp.finish();
    expect(await callClaudeStreaming({ prompt: "Probe" })).toMatchObject({ text: "ok", isError: false, rateLimit: expected });
    expect(timers.size).toBe(0);
    expect(existsSync(file)).toBe(false); // Der direkte Aufruf schreibt selbst nichts.
  });

  test("CLI-Fehler behält Messwerte und Fehlersignal", async () => {
    fp.write(rateLine + '\n{"type":"result","is_error":true,"subtype":"error_during_execution","result":"Limit"}\n');
    fp.finish(1);
    expect(await runEngine()).toMatchObject({ text: "Limit", isError: true, rateLimit: expected });
    expect(await Promise.all(writes)).toEqual([{ accepted: ["weekly_all"], rejected: [] }]);
  });

  for (const ending of ["abort", "timeout", "read-error"] as const) {
    test.each(["allowed", "rejected"])(`${ending} mit %s: Messwerte bleiben, keine Limit-Fehlerart`, async (status) => {
      let consumed!: () => void;
      const read = new Promise<void>(resolve => { consumed = resolve; });
      const rateEvent = JSON.parse(rateLine);
      rateEvent.rate_limit_info.status = status;
      // Der Rückruf hinter der Messzeile bestätigt deren Verarbeitung ohne Sleep.
      fp.write(JSON.stringify(rateEvent) + "\n" + JSON.stringify({ type: "assistant", message: {
        content: [{ type: "text", text: "Der Messwert ist jetzt gelesen und der Lauf arbeitet weiter." }],
      } }) + "\n");
      const run = runEngine({ abortKey: "rate-limit-test", onFirstText: consumed });
      await read;
      if (ending === "abort") expect(abortClaudeCalls("rate-limit-test")).toBe(1);
      else if (ending === "timeout") [...timers.values()].find(t => !t.interval && t.ms === 1234)!.fn();
      else fp.finish(1, new Error("Lesefehler der Attrappe"));
      const result = await run;
      expect(result).toMatchObject({ text: "", isError: true, rateLimit: { ...expected, status } });
      expect(result).not.toHaveProperty("errorKind");
      expect(log.mock.calls.some(call => String(call[0]).startsWith("[ClaudeLimit]"))).toBe(false);
      if (ending === "abort") expect(result.aborted).toBe(true);
      if (ending === "timeout") expect(result).toMatchObject({ timedOut: true, timeoutKind: "total" });
      expect(timers.size).toBe(0);
      expect(await Promise.all(writes)).toEqual([{ accepted: ["weekly_all"], rejected: [] }]);
    });
  }

  test("Startdiagnose nach einer Messzeile verliert das Feld nicht", async () => {
    fp.write(rateLine + "\n");
    fp.finish(127);
    expect(await callClaudeStreaming({ prompt: "Probe" })).toMatchObject({ isError: true, errorKind: "not_installed", rateLimit: expected });
  });

  test("Startfehler ohne Ereignis bekommt kein rateLimit", async () => {
    setSpawnForTests((() => { throw Object.assign(new Error("Attrappe fehlt"), { code: "ENOENT" }); }) as any);
    const result = await callClaudeStreaming({ prompt: "Probe" });
    expect(result.isError).toBe(true);
    expect(result).not.toHaveProperty("rateLimit");
  });
});

describe("Speichern im Claude-Motor", () => {
  test("nach der Vorlage steht weekly_all mit 6 Prozent und vollständiger Herkunft in der Datei", async () => {
    fp.write(fixture);
    fp.finish();
    const result = await runEngine();
    expect(result).toMatchObject({ engine: "claude", text: "ok", isError: false, rateLimit: expected });
    expect(writes).toHaveLength(1);
    expect(await writes[0]).toEqual({ accepted: ["weekly_all"], rejected: [] });
    const stored = JSON.parse(readFileSync(file, "utf8"));
    expect(stored.version).toBe(1);
    expect(stored.engines.claude.windows).toEqual(expected.windows);
  });

  test("Speichern wird nicht abgewartet, die Antwort kommt bei noch offenem Schreibauftrag", async () => {
    let finishWrite!: (result: RecordUsageResult) => void;
    const pending = new Promise<RecordUsageResult>(resolve => { finishWrite = resolve; });
    let called = false;
    fp.write(fixture);
    fp.finish();
    try {
      const result = await runEngine({}, (engine, windows) => {
        expect(engine).toBe("claude");
        expect(windows).toEqual(expected.windows);
        called = true;
        return pending;
      });
      expect(called).toBe(true);
      expect(result).toMatchObject({ text: "ok", isError: false });
    } finally {
      finishWrite({ accepted: ["weekly_all"], rejected: [] });
      await pending;
    }
  });

  test("kaputte Ablage wird repariert, Antwort unverändert", async () => {
    writeFileSync(file, "unsinniger Inhalt");
    fp.write(fixture);
    fp.finish();
    expect(await runEngine()).toMatchObject({ text: "ok", isError: false });
    expect(await writes[0]).toEqual({ accepted: ["weekly_all"], rejected: [] });
    expect((await readUsage(at)).claude).toEqual(expected.windows.map(window => ({ ...window, state: "known" })));
    expect(warnings).toHaveBeenCalledTimes(1);
  });

  for (const problem of ["Schreibfehler", "belegte Sperre"]) {
    test(`${problem}: Antwort und isError bleiben unverändert`, async () => {
      if (problem === "Schreibfehler") mkdirSync(file);
      else writeFileSync(`${file}.lock`, JSON.stringify({ pid: process.pid, token: "test" }));
      fp.write(fixture);
      fp.finish();
      const result = await runEngine();
      expect(result).toMatchObject({ text: "ok", isError: false, rateLimit: expected });
      expect(await writes[0]).toEqual({ accepted: [], rejected: [{ id: "weekly_all", reason: "unsaved" }] });
      expect(result).toMatchObject({ text: "ok", isError: false });
      expect(warnings.mock.calls.some(call => String(call[0]).includes("nicht gespeichert"))).toBe(true);
    });
  }

  test("ohne Fenster kein Schreibauftrag, auch bei kaputtem Ereignis", async () => {
    for (const info of [undefined, { rateLimitType: "overage", utilization: 0.5 },
      { rateLimitType: "seven_day", utilization: "0.5" }, { rateLimitType: "seven_day", resetsAt: "kaputt" }]) {
      fp = fakeProcess();
      const events = fixture.trim().split("\n");
      events[2] = JSON.stringify({ type: "rate_limit_event", rate_limit_info: info });
      fp.write(events.join("\n") + "\n");
      fp.finish();
      expect(await runEngine()).toMatchObject({ text: "ok", isError: false });
    }
    expect(writes).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  test("JSON-Läufe speichern keine Messwerte", async () => {
    fp.write(JSON.stringify(fixture.trim().split("\n").map(line => JSON.parse(line))));
    fp.finish();
    const result = await runEngine({ streaming: false });
    expect(result).toMatchObject({ text: "ok", isError: false });
    expect(result).not.toHaveProperty("rateLimit");
    expect(writes).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });
});
