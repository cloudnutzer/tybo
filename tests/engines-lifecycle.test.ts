/**
 * Issue #325, Entscheidung A: Abschluss eines Motor-Prozesses über den
 * Zustandsautomaten (src/lib/engines/lifecycle.ts).
 *
 * Teil 1 prüft den Automaten allein. Teil 2 ist die Matrix: alle acht
 * Kombinationen offen/zu von stdout, stderr und Prozessende, jeweils mit
 * Zeitlimit, /stop und Lesefehler, für die drei Claude-Wege (callClaude,
 * callClaudeStreaming, runClaudeWithTimeout) und die Motoren Codex und
 * OpenCode. "offen" heißt: bleibt offen und ignoriert jedes Signal, wie ein
 * Kind außerhalb der Prozessgruppe. Jeder Fall muss abschließen; danach sind
 * Register und Timer leer.
 *
 * Alle Prozesse sind Attrappen mit pid 0, Signale werden nur gezählt. Uhr und
 * Timer sind eine eigene Attrappe, die nur advance vorstellt.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { callClaude, callClaudeStreaming, runClaudeWithTimeout, setRuntimeForTests, setSpawnForTests } from "../src/lib/claude";
import { STOP_GRACE_MS } from "../src/lib/claude/process";
import { abortEngineCalls, registeredEngineCallCount } from "../src/lib/engines/calls";
import { CODEX_KILL_GRACE_MS, CODEX_STOP_WAIT_MS, createCodexEngine, setCodexRuntimeForTests } from "../src/lib/engines/codex";
import { superviseRun, type StopCause } from "../src/lib/engines/lifecycle";
import { createOpenCodeEngine, OPENCODE_KILL_GRACE_MS, OPENCODE_STOP_WAIT_MS, setOpenCodeRuntimeForTests } from "../src/lib/engines/opencode";
import { runExecution } from "../src/lib/execution-context";
import { setSettingsPath } from "../src/lib/settings";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { ev, until } from "./codex-fixture";
import { oc } from "./opencode-fixture";

const enc = new TextEncoder();

/** Uhr mit Timern, die nur advance auslöst; pending zählt offene Timer */
function fakeClock() {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  const handle = (id: number) => ({ id, unref() {} });
  const idOf = (h: unknown) => (h as { id: number } | undefined)?.id ?? -1;
  return {
    now: () => now,
    setTimeout: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn });
      return handle(id);
    },
    clearTimeout: (h: unknown) => void timers.delete(idOf(h)),
    setInterval: (fn: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn, every: ms });
      return handle(id);
    },
    clearInterval: (h: unknown) => void timers.delete(idOf(h)),
    advance(ms: number) {
      const until = now + ms;
      for (;;) {
        let due: [number, { at: number; fn: () => void; every?: number }] | undefined;
        for (const entry of timers) if (entry[1].at <= until && (!due || entry[1].at < due[1].at)) due = entry;
        if (!due) break;
        const [id, t] = due;
        now = t.at;
        if (t.every) t.at += t.every;
        else timers.delete(id);
        t.fn();
      }
      now = until;
    },
    pending: () => timers.size,
  };
}

/** Lässt Promise-Reaktionen und Strom-Ereignisse durchlaufen */
async function flush() {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
}

/** Ergebnis oder Fehler, und ob schon da */
function watch(p: Promise<unknown>) {
  const state: { done: boolean; value?: unknown; error?: unknown } = { done: false };
  p.then(
    (value) => Object.assign(state, { done: true, value }),
    (error) => Object.assign(state, { done: true, error })
  );
  return state;
}

/** Strom, den der Test steuert */
function controlled() {
  let c!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (x) => void (c = x) });
  return { stream, c };
}

describe("Zustandsautomat allein", () => {
  function scene() {
    const clock = fakeClock();
    const out = controlled();
    const err = controlled();
    let exit!: (code: number) => void;
    const proc = { stdout: out.stream, stderr: err.stream, exited: new Promise<number>((r) => (exit = r)) };
    const log: string[] = [];
    return { clock, out, err, exit, proc, log };
  }

  test("schließt erst ab, wenn stdout, stderr und Prozessende da sind, in beliebiger Reihenfolge", async () => {
    const s = scene();
    const run = superviseRun(s.proc, { clock: s.clock, graceMs: 100, terminate: () => s.log.push("terminate") });
    const done = watch(run.done);
    s.out.c.enqueue(enc.encode("Hallo "));
    s.exit(0);
    await flush();
    expect(run.exited).toBe(true);
    s.err.c.enqueue(enc.encode("Hinweis"));
    s.err.c.close();
    await flush();
    expect(done.done).toBe(false);
    expect(run.phase).toBe("running");
    s.out.c.enqueue(enc.encode("Welt"));
    s.out.c.close();
    await flush();
    expect(done.value).toEqual({ stdout: "Hallo Welt", stderr: "Hinweis", exitCode: 0, cutOff: false });
    expect(run.phase).toBe("settled");
    expect(s.log).toEqual([]);
    expect(s.clock.pending()).toBe(0);
  });

  test("erste Ursache gilt, beendet genau einmal, eine Frist für alles; danach wirkt stop nicht mehr", async () => {
    const s = scene();
    const run = superviseRun(s.proc, { clock: s.clock, graceMs: 100, terminate: () => s.log.push("terminate") });
    const done = watch(run.done);
    expect(run.stop("total")).toBe(true);
    s.clock.advance(60);
    // Zweite Ursache: weder neues Beenden noch neue Frist
    expect(run.stop("abort")).toBe(false);
    expect(run.cause).toBe("total");
    expect(run.phase).toBe("stopping");
    expect(s.log).toEqual(["terminate"]);
    expect(s.clock.pending()).toBe(1);
    s.clock.advance(39);
    await flush();
    expect(done.done).toBe(false);
    s.clock.advance(1);
    await flush();
    expect(done.value).toMatchObject({ cutOff: true, exitCode: null });
    expect(run.stop("read")).toBe(false);
    expect(s.clock.pending()).toBe(0);
  });

  test("Frist abgelaufen: beide Leser beendet, ein späteres Ende ändert nichts mehr", async () => {
    const s = scene();
    const run = superviseRun(s.proc, { clock: s.clock, graceMs: 100, terminate: () => {} });
    const done = watch(run.done);
    s.out.c.enqueue(enc.encode("teil"));
    s.err.c.enqueue(enc.encode("fehl"));
    await flush();
    run.stop("abort");
    s.clock.advance(100);
    await flush();
    expect(done.value).toEqual({ stdout: "teil", stderr: "fehl", exitCode: null, cutOff: true });
    // Die Ströme sind abgebrochen: Schreiben scheitert, Lesen gibt es nicht mehr
    expect(() => s.out.c.enqueue(enc.encode("x"))).toThrow();
    expect(() => s.err.c.enqueue(enc.encode("x"))).toThrow();
    s.exit(0);
    await flush();
    expect(run.phase).toBe("settled");
  });

  test("Rückruf wirft: Lesefehler, stdout wird nicht weiter gelesen, Ursache read", async () => {
    const s = scene();
    const run = superviseRun(s.proc, {
      clock: s.clock,
      graceMs: 100,
      terminate: () => s.log.push("terminate"),
      onChunk: () => {
        throw new Error("Parser kaputt");
      },
    });
    const done = watch(run.done);
    s.out.c.enqueue(enc.encode("x"));
    await flush();
    expect(run.cause).toBe("read");
    expect(s.log).toEqual(["terminate"]);
    expect(() => s.out.c.enqueue(enc.encode("y"))).toThrow();
    s.err.c.close();
    s.exit(143);
    await flush();
    expect(done.value).toMatchObject({ exitCode: 143, cutOff: false });
    expect((done.value as { readError: Error }).readError.message).toBe("Parser kaputt");
    expect(s.clock.pending()).toBe(0);
  });

  test("Lesefehler nach einer anderen Ursache: Ursache bleibt, Fehler wird gemeldet", async () => {
    const s = scene();
    const run = superviseRun(s.proc, { clock: s.clock, graceMs: 100, terminate: () => s.log.push("terminate") });
    const done = watch(run.done);
    run.stop("idle");
    s.out.c.error(new Error("weg"));
    s.err.c.close();
    s.exit(0);
    await flush();
    expect(run.cause).toBe("idle");
    expect(done.value).toMatchObject({ cutOff: false, readError: new Error("weg") });
    expect(s.log).toEqual(["terminate"]);
  });

  test("Lesefehler auf stderr: stderr leer, kein Beenden", async () => {
    const s = scene();
    const run = superviseRun(s.proc, { clock: s.clock, graceMs: 100, terminate: () => s.log.push("terminate") });
    const done = watch(run.done);
    s.err.c.enqueue(enc.encode("halb"));
    s.err.c.error(new Error("weg"));
    s.out.c.close();
    s.exit(0);
    await flush();
    expect(done.value).toEqual({ stdout: "", stderr: "", exitCode: 0, cutOff: false });
    expect(run.cause).toBeUndefined();
    expect(s.log).toEqual([]);
  });

  test("Beenden wirft: der Lauf schließt trotzdem nach der Frist ab", async () => {
    const s = scene();
    const run = superviseRun(s.proc, {
      clock: s.clock,
      graceMs: 100,
      terminate: () => {
        throw new Error("kein Signal");
      },
    });
    const done = watch(run.done);
    expect(run.stop("abort" as StopCause)).toBe(true);
    s.clock.advance(100);
    await flush();
    expect(done.value).toMatchObject({ cutOff: true });
  });
});

// ---------------------------------------------------------------------------
// Matrix
// ---------------------------------------------------------------------------

type Dim = "zu" | "offen";
type Trigger = "Zeitlimit" | "/stop" | "Lesefehler";
interface Combo {
  stdout: Dim;
  stderr: Dim;
  exit: Dim;
}

const COMBOS: Combo[] = [];
for (const stdout of ["zu", "offen"] as const)
  for (const stderr of ["zu", "offen"] as const) for (const exit of ["zu", "offen"] as const) COMBOS.push({ stdout, stderr, exit });
const TRIGGERS: Trigger[] = ["Zeitlimit", "/stop", "Lesefehler"];
const TIMEOUT_MS = 60_000;

/**
 * Prozess für einen Fall der Matrix: stdout trägt die vollständige Antwort.
 * "zu" endet sofort; beim Auslöser Lesefehler endet stdout mit einem Fehler
 * statt regulär, bei "offen" erst zum Auslöser. "offen" ignoriert Signale.
 */
function matrixProcess(combo: Combo, trigger: Trigger, payload: string) {
  const out = controlled();
  const err = controlled();
  let exit!: (code: number) => void;
  const proc = {
    pid: 0,
    stdin: { write() {}, end() {} },
    stdout: out.stream,
    stderr: err.stream,
    exited: new Promise<number>((r) => (exit = r)),
    kill() {},
  };
  const failStdout = () => out.c.error(new Error("Lesefehler"));
  out.c.enqueue(enc.encode(payload));
  if (combo.stdout === "zu") {
    if (trigger === "Lesefehler") failStdout();
    else out.c.close();
  }
  if (combo.stderr === "zu") err.c.close();
  if (combo.exit === "zu") exit(0);
  return { proc, failStdout };
}

type Clock = ReturnType<typeof fakeClock>;

interface Way {
  name: string;
  payload: string;
  /** Wartezeit nach dem Beenden und Nachlauf bis SIGKILL des Motors */
  graceMs: number;
  killMs: number;
  /** Setzt Prozessstart und Uhr ein; liefert, wie oft beendet wurde und ob der Lauf gestartet ist */
  install(clock: Clock, proc: object): { stops: () => number; started: () => boolean };
  restore(): void;
  start(key: string): Promise<unknown>;
  ok(r: unknown): void;
  timedOut(r: unknown): void;
  aborted(r: unknown): void;
  readFailed(r: unknown): void;
}

const json = (o: object) => JSON.stringify(o) + "\n";

function claudeInstall(clock: Clock, proc: object) {
  let stops = 0;
  let spawned = false;
  setSpawnForTests((() => ((spawned = true), proc)) as any);
  setRuntimeForTests({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    terminate: () => void stops++,
    stopGraceMs: STOP_GRACE_MS,
  });
  return { stops: () => stops, started: () => spawned };
}

function claudeRestore() {
  setSpawnForTests(null);
  setRuntimeForTests(null);
}

const claudeResult = {
  ok: (r: unknown) => expect(r).toMatchObject({ text: "fertig", isError: false }),
  timedOut: (r: unknown) => expect(r).toMatchObject({ text: "", isError: true, timedOut: true }),
  aborted: (r: unknown) => expect(r).toEqual({ text: "", isError: true, aborted: true }),
  readFailed: (r: unknown) => expect(r).toEqual({ text: "", isError: true }),
};

/** Codex und OpenCode: Signale zählen, SIGINT ist das Beenden */
function engineInstall(set: (r: any) => void, clock: Clock, proc: object, version?: string) {
  const signals: string[] = [];
  let started = false;
  set({
    spawn: (o: { cmd: string[] }) => {
      if (version && o.cmd.at(-1) === "--version") {
        const out = controlled();
        out.c.enqueue(enc.encode(version));
        out.c.close();
        const err = controlled();
        err.c.close();
        return { pid: 0, stdin: { write() {}, end() {} }, stdout: out.stream, stderr: err.stream, exited: Promise.resolve(0), kill() {} };
      }
      started = true;
      return proc;
    },
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    setInterval: clock.setInterval,
    clearInterval: clock.clearInterval,
    signal: (_p: unknown, s: string) => void signals.push(s),
  });
  return { stops: () => signals.filter((s) => s === "SIGINT").length, started: () => started };
}

const engineResult = (engine: string) => ({
  ok: (r: unknown) => expect(r).toMatchObject({ engine, text: "fertig", isError: false }),
  timedOut: (r: unknown) => expect(r).toMatchObject({ engine, isError: true, timedOut: true, timeoutKind: "total" }),
  aborted: (r: unknown) => expect(r).toEqual({ engine, text: "", isError: true, aborted: true }),
  readFailed: (r: unknown) => {
    expect(r).toMatchObject({ engine, isError: true });
    expect(r).not.toHaveProperty("timedOut");
    expect(r).not.toHaveProperty("aborted");
  },
});

const S = "ses_lebenslauf";
const ways: Way[] = [
  {
    name: "callClaude",
    payload: "fertig",
    graceMs: STOP_GRACE_MS,
    killMs: 0,
    install: claudeInstall,
    restore: claudeRestore,
    start: (key) => callClaude({ prompt: "p", timeoutMs: TIMEOUT_MS, abortKey: key, quiet: true }),
    ...claudeResult,
  },
  {
    name: "callClaudeStreaming",
    payload: json({ type: "result", subtype: "success", is_error: false, session_id: "s1", result: "fertig" }),
    graceMs: STOP_GRACE_MS,
    killMs: 0,
    install: claudeInstall,
    restore: claudeRestore,
    start: (key) => callClaudeStreaming({ prompt: "p", timeoutMs: TIMEOUT_MS, abortKey: key }),
    ...claudeResult,
  },
  {
    name: "runClaudeWithTimeout",
    payload: "fertig",
    graceMs: STOP_GRACE_MS,
    killMs: 0,
    install: claudeInstall,
    restore: claudeRestore,
    // Ohne abortKey: der Abbruch kommt über die Ausführung
    start: (key) => runExecution(key, "general", () => runClaudeWithTimeout("p", TIMEOUT_MS)),
    ok: (r) => expect(r).toBe("fertig"),
    timedOut: (r) => expect((r as Error).message).toBe("Timeout"),
    aborted: (r) => expect(r).toMatchObject({ name: "AbortError" }),
    readFailed: (r) => expect((r as Error).message).toBe("Lesefehler"),
  },
  {
    name: "Codex",
    payload: [ev.started("t-1"), ev.message("m", "fertig"), ev.completed()].map(json).join(""),
    graceMs: CODEX_STOP_WAIT_MS,
    killMs: CODEX_KILL_GRACE_MS,
    install: (clock, proc) => engineInstall(setCodexRuntimeForTests, clock, proc),
    restore: () => setCodexRuntimeForTests(null),
    start: (key) => createCodexEngine().run({ prompt: "p", streaming: true, timeoutMs: TIMEOUT_MS, cwd: "/tmp/tybo-projekt", abortKey: key }),
    ...engineResult("codex"),
  },
  {
    name: "OpenCode",
    payload: oc.reply(S, "fertig").map(json).join(""),
    graceMs: OPENCODE_STOP_WAIT_MS,
    killMs: OPENCODE_KILL_GRACE_MS,
    install: (clock, proc) => engineInstall(setOpenCodeRuntimeForTests, clock, proc, "1.18.33\n"),
    restore: () => setOpenCodeRuntimeForTests(null),
    start: (key) => createOpenCodeEngine().run({ prompt: "p", streaming: true, timeoutMs: TIMEOUT_MS, cwd: "/tmp/tybo-projekt", abortKey: key }),
    ...engineResult("opencode"),
  },
];

describe("Matrix: jeder Lauf schließt ab, Register und Timer leer (Issue #325)", () => {
  beforeAll(() => {
    setMcpReaderForTests(() => new Set());
    setSettingsPath("/tmp/tybo-lifecycle-test/fehlt/settings.json");
  });
  afterAll(() => {
    setMcpReaderForTests(null);
    setSettingsPath();
  });
  afterEach(() => {
    for (const way of ways) way.restore();
  });

  test("Wartezeit nach dem Beenden liegt über dem SIGKILL-Nachlauf jedes Motors", () => {
    expect(STOP_GRACE_MS).toBeGreaterThan(1_500);
    expect(CODEX_STOP_WAIT_MS).toBeGreaterThan(CODEX_KILL_GRACE_MS);
    expect(OPENCODE_STOP_WAIT_MS).toBeGreaterThan(OPENCODE_KILL_GRACE_MS);
  });

  for (const way of ways) {
    for (const combo of COMBOS) {
      for (const trigger of TRIGGERS) {
        const label = `stdout ${combo.stdout}, stderr ${combo.stderr}, Prozessende ${combo.exit}`;
        test(`${way.name}: ${label}, ${trigger}`, async () => {
          const clock = fakeClock();
          const scene = matrixProcess(combo, trigger, way.payload);
          const ctl = way.install(clock, scene.proc);
          const key = `k-matrix-${way.name}-${label}-${trigger}`;
          const run = watch(way.start(key));
          await until(ctl.started);
          await flush();

          // Alles schon zu: der Lauf ist ohne Auslöser fertig
          const finishedAlone = combo.stdout === "zu" && combo.stderr === "zu" && combo.exit === "zu" && trigger !== "Lesefehler";
          if (finishedAlone) expect(run.done).toBe(true);

          if (trigger === "Zeitlimit") clock.advance(TIMEOUT_MS);
          if (trigger === "/stop") expect(abortEngineCalls(key)).toBe(finishedAlone ? 0 : 1);
          if (trigger === "Lesefehler" && combo.stdout === "offen") scene.failStdout();
          await flush();

          // Spätestens nach der Wartezeit abgeschlossen, egal was noch offen ist
          clock.advance(way.graceMs);
          await flush();
          expect(run.done).toBe(true);
          const r = run.error ?? run.value;
          if (finishedAlone) way.ok(r);
          else if (trigger === "Zeitlimit") way.timedOut(r);
          else if (trigger === "/stop") way.aborted(r);
          else way.readFailed(r);

          expect(ctl.stops()).toBe(finishedAlone ? 0 : 1);
          expect(registeredEngineCallCount()).toBe(0);
          // Nur der SIGKILL-Nachlauf des Motors darf noch ausstehen; er läuft ab und ist dann weg
          clock.advance(way.killMs);
          expect(clock.pending()).toBe(0);
        });
      }
    }
  }
});
