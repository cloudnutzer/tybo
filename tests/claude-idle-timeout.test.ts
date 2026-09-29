/**
 * Issue #178: Leerlauf-Grenze und Obergrenze in callClaudeStreaming.
 * Der Claude-Prozess ist eine Attrappe (setSpawnForTests), deren stdout der
 * Test Zeile für Zeile füttert. Uhr, Timer und Prozessbeendigung sind
 * Attrappen (setRuntimeForTests): pid 0 wird nie echt beendet, die Zeit läuft
 * nur, wenn der Test sie weiterstellt.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  abortClaudeCalls,
  callClaudeStreaming,
  IDLE_CHECK_INTERVAL_MS,
  setRuntimeForTests,
  setSpawnForTests,
  type ClaudeResult,
} from "../src/lib/claude";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import {
  ABORT_REPLY,
  longRunNoticeText,
  resolveStreamingLimits,
  runStreamingTurn,
  type ChatTurnDeps,
} from "../src/lib/chat-turn";
import { sessionKeyFor } from "../src/lib/convex";
import { createClaudeEngine } from "../src/lib/engines";

const MIN = 60_000;
const IDLE = 15 * MIN;
const MAX = 90 * MIN;

interface FakeTimer {
  id: number;
  fn: () => void;
  at: number;
  every?: number;
  cleared: boolean;
}

/** Uhr und Timer, die nur der Test weiterstellt */
function fakeClock() {
  let now = 0;
  let nextId = 1;
  const timers: FakeTimer[] = [];
  const add = (fn: () => void, ms: number, every?: number) => {
    const t: FakeTimer = { id: nextId++, fn, at: now + ms, every, cleared: false };
    timers.push(t);
    return t.id;
  };
  const clear = (id: unknown) => {
    const t = timers.find((x) => x.id === id);
    if (t) t.cleared = true;
  };
  return {
    timers,
    now: () => now,
    runtime: {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => add(fn, ms),
      clearTimeout: clear,
      setInterval: (fn: () => void, ms: number) => add(fn, ms, ms),
      clearInterval: clear,
    },
    /** Zeit vorstellen und fällige Timer der Reihe nach auslösen */
    advance(ms: number) {
      const target = now + ms;
      for (;;) {
        const due = timers.filter((t) => !t.cleared && t.at <= target).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        if (due.every) due.at += due.every;
        else due.cleared = true;
        due.fn();
      }
      now = target;
    },
    active: () => timers.filter((t) => !t.cleared),
  };
}

/** Prozessattrappe: stdout füttert der Test, terminate schließt den Stream */
function fakeProcess() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
  let closed = false;
  const enc = new TextEncoder();
  return {
    proc: {
      pid: 0,
      stdin: { write() {}, end() {} },
      stdout,
      stderr: new ReadableStream({ start: (c) => c.close() }),
      exited: Promise.resolve(0),
      kill() {},
    },
    write(text: string) {
      if (!closed) controller.enqueue(enc.encode(text));
    },
    line(event: object) {
      this.write(JSON.stringify(event) + "\n");
    },
    close() {
      if (closed) return;
      closed = true;
      controller.close();
    },
    fail() {
      if (closed) return;
      closed = true;
      controller.error(new Error("stream kaputt"));
    },
  };
}

const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

let clock: ReturnType<typeof fakeClock>;
let fp: ReturnType<typeof fakeProcess>;
let terminated: number;
/** Wie der Prozess auf das Beenden reagiert: Stream schließt normal oder mit Fehler */
let onTerminate: "close" | "fail";

beforeAll(() => {
  setMcpReaderForTests(() => new Set());
  setSpawnForTests((() => fp.proc) as any);
});
afterAll(() => {
  setSpawnForTests(null);
  setRuntimeForTests(null);
  setMcpReaderForTests(null);
});
beforeEach(() => {
  clock = fakeClock();
  fp = fakeProcess();
  terminated = 0;
  onTerminate = "close";
  setRuntimeForTests({
    ...clock.runtime,
    terminate: () => {
      terminated++;
      // Verzögertes SIGKILL gibt es in der Attrappe nicht: kein echter Prozess
      if (onTerminate === "fail") fp.fail();
      else fp.close();
    },
  });
});
afterEach(() => setRuntimeForTests(null));

function start(opts: { idle?: number; max?: number; abortKey?: string } = {}): Promise<ClaudeResult> {
  return callClaudeStreaming({
    prompt: "p",
    model: "test-model",
    timeoutMs: opts.max ?? MAX,
    ...(opts.idle !== undefined ? { idleTimeoutMs: opts.idle } : { idleTimeoutMs: IDLE }),
    ...(opts.abortKey ? { abortKey: opts.abortKey } : {}),
  });
}

const RESULT = { type: "result", subtype: "success", is_error: false, result: "fertig", session_id: "s1" };

describe("Leerlauf-Grenze", () => {
  test("stummer Prozess: Abbruch nach idleTimeoutMs, timeoutKind idle", async () => {
    const p = start();
    await tick();
    clock.advance(IDLE - IDLE_CHECK_INTERVAL_MS);
    await tick();
    expect(terminated).toBe(0);
    clock.advance(IDLE_CHECK_INTERVAL_MS);
    const r = await p;
    expect(terminated).toBe(1);
    expect(r).toMatchObject({ text: "", isError: true, timedOut: true, timeoutKind: "idle" });
    expect(clock.active()).toHaveLength(0);
  });

  test("regelmäßige Zeilen aller Art: kein Abbruch über die alten 30 Minuten hinaus", async () => {
    const p = start();
    await tick();
    const events = [
      { type: "system", subtype: "init", session_id: "s1" },
      { type: "system", subtype: "task_started" },
      { type: "tool_progress", parent_tool_use_id: "toolu_1" },
      { type: "user", message: { content: [{ type: "tool_result", content: "42" }] } },
      { type: "assistant", parent_tool_use_id: "toolu_1", message: { id: "sub", content: [{ type: "tool_use", name: "Bash" }] } },
      { type: "system", subtype: "task_notification" },
    ];
    // 50 Minuten lang alle 5 Minuten eine Zeile
    for (let i = 0; i < 10; i++) {
      fp.line(events[i % events.length]!);
      await tick();
      clock.advance(5 * MIN);
      await tick();
    }
    expect(terminated).toBe(0);
    fp.line(RESULT);
    fp.close();
    const r = await p;
    expect(r).toMatchObject({ text: "fertig", isError: false, sessionId: "s1" });
    expect(r.timedOut).toBeUndefined();
    expect(clock.active()).toHaveLength(0);
  });

  test("geteilte Zeile zählt erst vollständig; leere und kaputte Zeilen zählen nicht", async () => {
    const p = start();
    await tick();
    clock.advance(10 * MIN);
    fp.write('{"type":"sys');
    await tick();
    clock.advance(2 * MIN);
    fp.write('tem","subtype":"x"}\n'); // bei Minute 12 vollständig
    await tick();
    clock.advance(10 * MIN);
    fp.write("\n   \nkein json\n"); // bei Minute 22, zählt nicht
    await tick();
    clock.advance(4 * MIN); // Minute 26: 14 Minuten still
    await tick();
    expect(terminated).toBe(0);
    clock.advance(MIN); // Minute 27: 15 Minuten still
    const r = await p;
    expect(r.timeoutKind).toBe("idle");
  });

  test("Stream-Fehler nach dem Abbruch bleibt ein Zeitlimit", async () => {
    onTerminate = "fail";
    const p = start();
    await tick();
    clock.advance(IDLE);
    const r = await p;
    expect(r).toMatchObject({ isError: true, timedOut: true, timeoutKind: "idle" });
    expect(clock.active()).toHaveLength(0);
  });

  test("ohne idleTimeoutMs keine Leerlauf-Prüfung", async () => {
    const p = start({ idle: 0 });
    await tick();
    expect(clock.active()).toHaveLength(1); // nur die Obergrenze
    clock.advance(60 * MIN);
    await tick();
    expect(terminated).toBe(0);
    fp.line(RESULT);
    fp.close();
    expect((await p).text).toBe("fertig");
  });
});

describe("Stand beim Zeitlimit (Issue #179)", () => {
  const toolUse = (id: string, name: string, input: object) => ({
    type: "assistant",
    message: { id, content: [{ type: "tool_use", name, input }] },
  });

  test("letzte acht Schritte in Reihenfolge, ungekürzt, letzter Text, Dauer und Leerlauf", async () => {
    const p = start();
    await tick();
    fp.line({ type: "system", subtype: "init", session_id: "sid-lauf" });
    fp.line({ type: "assistant", message: { id: "m0", content: [{ type: "text", text: "Erster Plan" }] } });
    const long = "echo " + "x".repeat(3000);
    for (let i = 1; i <= 10; i++) fp.line(toolUse(`m${i}`, "Bash", { command: i === 10 ? long : `schritt ${i}` }));
    fp.line(toolUse("m11", "Read", { file_path: "/tmp/datei.md" }));
    fp.line({ type: "assistant", message: { id: "m12", content: [{ type: "text", text: "Jetzt lege ich die Issues an." }] } });
    fp.line(toolUse("m13", "Agent", { description: "Plan prüfen", prompt: "lang" }));
    await tick();
    clock.advance(5 * MIN);
    fp.line(toolUse("m14", "TodoWrite", { todos: [] })); // letzte Aktivität bei Minute 5
    await tick();
    clock.advance(IDLE);
    const r = await p;

    expect(r).toMatchObject({ timedOut: true, timeoutKind: "idle", sessionId: "sid-lauf" });
    expect(r.steps).toEqual([
      { name: "Bash", input: "schritt 6" },
      { name: "Bash", input: "schritt 7" },
      { name: "Bash", input: "schritt 8" },
      { name: "Bash", input: "schritt 9" },
      { name: "Bash", input: long },
      { name: "Read", input: "/tmp/datei.md" },
      { name: "Agent", input: "Plan prüfen" },
      { name: "TodoWrite" },
    ]);
    expect(r.lastText).toBe("Jetzt lege ich die Issues an.");
    expect(r.stoppedAfterMs).toBe(5 * MIN + IDLE);
    expect(r.idleForMs).toBe(IDLE);
    // Die vollständige Werkzeugliste für die Einstufung bleibt getrennt
    expect(r.tools?.uses).toHaveLength(13);
  });

  test("ohne Schritte und Text: leere Liste, kein lastText", async () => {
    const p = start();
    await tick();
    clock.advance(IDLE);
    const r = await p;
    expect(r.steps).toEqual([]);
    expect("lastText" in r).toBe(false);
    expect(r.sessionId).toBeUndefined();
  });

  test("Erfolg trägt keine Schritte", async () => {
    const p = start();
    await tick();
    fp.line(toolUse("m1", "Bash", { command: "ls" }));
    fp.line(RESULT);
    fp.close();
    const r = await p;
    expect(r.steps).toBeUndefined();
    expect(r.lastText).toBeUndefined();
  });
});

describe("Obergrenze", () => {
  test("beendet auch einen aktiven Lauf, timeoutKind total, Grund nur einmal", async () => {
    const p = start();
    await tick();
    for (let m = 0; m < 89; m++) {
      fp.line({ type: "tool_progress" });
      await tick();
      clock.advance(MIN);
      await tick();
    }
    expect(terminated).toBe(0);
    fp.line({ type: "tool_progress" });
    await tick();
    clock.advance(MIN);
    const r = await p;
    expect(r).toMatchObject({ timedOut: true, timeoutKind: "total" });
    expect(terminated).toBe(1);
    // Spätere Prüfungen setzen keinen zweiten Grund
    clock.advance(IDLE * 2);
    expect(terminated).toBe(1);
    expect(clock.active()).toHaveLength(0);
  });
});

describe("Abschluss räumt beide Timer ab", () => {
  test("Erfolg", async () => {
    const p = start();
    await tick();
    expect(clock.active()).toHaveLength(2);
    fp.line(RESULT);
    fp.close();
    await p;
    expect(clock.active()).toHaveLength(0);
  });

  test("Stream-Fehler ohne Zeitlimit: Fehler, kein timedOut", async () => {
    const p = start();
    await tick();
    fp.fail();
    const r = await p;
    expect(r).toMatchObject({ isError: true });
    expect(r.timedOut).toBeUndefined();
    expect(clock.active()).toHaveLength(0);
  });

  test("/stop bei scharfen Timern: aborted, kein späteres Zeitlimit", async () => {
    const p = start({ abortKey: "stop-test" });
    await tick();
    clock.advance(10 * MIN);
    expect(abortClaudeCalls("stop-test")).toBe(1);
    const r = await p;
    expect(r).toMatchObject({ aborted: true, isError: true });
    expect(r.timedOut).toBeUndefined();
    expect(clock.active()).toHaveLength(0);
    clock.advance(MAX);
    expect(terminated).toBe(1);
  });
});

describe("echter Weg: runStreamingTurn mit callClaudeStreaming", () => {
  const CHAT = "5151";
  const KEY = sessionKeyFor(CHAT, null);

  /** Chat-Kern mit Attrappen, callClaudeStreaming echt; beide Timer-Ebenen an derselben Uhr */
  function turn(opts: { resume?: boolean } = {}) {
    const notices: string[] = [];
    let claudeCalls = 0;
    let fallbacks = 0;
    const recorded: string[] = [];
    const deps: Partial<ChatTurnDeps> = {
      getEngine: () =>
        createClaudeEngine({
          callClaudeStreaming: (o) => {
            claudeCalls++;
            return callClaudeStreaming(o);
          },
          callClaude: async () => {
            throw new Error("unerwartet");
          },
        }),
      callFallbackLLMWithSource: async () => {
        fallbacks++;
        return { text: "fallback", source: "none" };
      },
      buildPromptContext: async () => ({ fullPrompt: "prompt", fallbackContext: "" }),
      buildResumePrompt: async () => "resume",
      isSessionModeEnabled: () => !!opts.resume,
      getResumableSession: async () =>
        opts.resume ? ({ engine: "claude", engineSessionId: "sid-alt", startedAt: 1, messageCount: 1 } as any) : undefined,
      takeExpiredSession: async () => undefined,
      recordSessionTurn: async (_k, _a, _m, _e, sid) => (recorded.push(sid), true),
      resetSession: async () => 0,
      shouldDistill: () => false,
      distillSession: async () => {},
      log: async () => {},
      getAgentConfig: () => ({ model: "test-model" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
      getSettings: () => ({}),
      resolveStreamingLimits: () => resolveStreamingLimits({}),
      reportSecrets: () => [],
      setTimer: (fn, ms) => clock.runtime.setTimeout(fn, ms),
      clearTimer: (h) => clock.runtime.clearTimeout(h),
      now: clock.now,
    };
    const reply = runStreamingTurn({
      userMessage: "Plane das",
      chatId: CHAT,
      agentName: "general",
      sink: { progress: () => {}, notice: (t) => void notices.push(t) },
      deps,
    });
    return { reply, notices, calls: () => claudeCalls, fallbacks: () => fallbacks, recorded: () => recorded };
  }

  /** Zeit in Schritten vorstellen, damit Stream und Timer dazwischen arbeiten */
  async function run(minutes: number, everyMin: number, line?: object) {
    for (let m = 0; m < minutes; m += everyMin) {
      if (line) fp.line(line);
      await tick();
      clock.advance(everyMin * MIN);
      await tick();
    }
  }

  test("aktiver Lauf über 60 Minuten: drei Hinweise, dann Antwort", async () => {
    const t = turn();
    await tick();
    await run(65, 5, { type: "tool_progress", parent_tool_use_id: "toolu_1" });
    expect(terminated).toBe(0);
    fp.line(RESULT);
    fp.close();
    expect(await t.reply).toBe("fertig");
    expect(t.notices).toEqual(
      [20, 40, 60].map((m) => longRunNoticeText({ elapsedMin: m, maxMin: 90, idleMin: 15 }))
    );
    expect(clock.active()).toHaveLength(0);
  });

  test("hängender Lauf mit Resume-Session: Stand statt Fallback, kein zweiter Aufruf", async () => {
    const t = turn({ resume: true });
    await tick();
    fp.line({ type: "system", subtype: "init", session_id: "sid-alt" });
    fp.line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", name: "Bash", input: { command: "gh issue create --title Plan" } }] } });
    await run(20, 1);
    const reply = await t.reply;
    expect(reply).not.toBe("fallback");
    expect(t.fallbacks()).toBe(0);
    expect(reply.startsWith("⏱ Zeitlimit: seit 15 Minuten keine Aktivität, Claude wurde nach 15 Minuten Laufzeit abgebrochen.")).toBe(true);
    expect(reply).toContain("1. Bash: gh issue create --title Plan");
    expect(reply).toContain("Schreib **weiter**");
    expect(terminated).toBe(1);
    expect(t.calls()).toBe(1);
    // Kein zusätzlicher Hinweis: der Stand kommt einmal, als Antwort
    expect(t.notices).toEqual([]);
    expect(t.recorded()).toEqual(["sid-alt"]);
    expect(clock.active()).toHaveLength(0);
  });

  test("/stop bei scharfen Timern: Abbruch, danach kein Hinweis und kein Zeitlimit", async () => {
    const t = turn();
    await tick();
    await run(25, 5, { type: "tool_progress" });
    expect(t.notices).toHaveLength(1);
    expect(abortClaudeCalls(KEY)).toBe(1);
    expect(await t.reply).toBe(ABORT_REPLY);
    clock.advance(MAX);
    await tick();
    expect(t.notices).toHaveLength(1);
    expect(terminated).toBe(1);
    expect(clock.active()).toHaveLength(0);
  });
});
