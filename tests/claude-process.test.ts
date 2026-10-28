/**
 * Issue #325: Verträge der drei Claude-Aufrufwege (callClaude,
 * callClaudeStreaming, runClaudeWithTimeout) über den gemeinsamen
 * Prozesskern. Der Prozess ist eine Attrappe (setSpawnForTests), die
 * Prozessbeendigung ebenfalls (setRuntimeForTests): pid 0 bekommt nie ein
 * echtes Signal. Zeitlimits laufen mit echten, kurzen Timern.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  abortClaudeCalls,
  activeClaudeCallCount,
  callClaude,
  callClaudeStreaming,
  runClaudeWithTimeout,
  setRuntimeForTests,
  setSpawnForTests,
} from "../src/lib/claude";
import { registeredEngineCallCount } from "../src/lib/engines/calls";
import { abortExecutions, runExecution } from "../src/lib/execution-context";
import { setMcpReaderForTests } from "../src/lib/subprocess-env";
import { resolveStreamingLimits, runStreamingTurn, type ChatTurnDeps } from "../src/lib/chat-turn";
import { stopTree, type ProcessPlatform } from "../src/lib/engines/platform";
import { isolateShellEnv } from "./shell-env";

// Effort steht in der Befehlszeile: ein CLAUDE_EFFORT aus der Shell darf sie nicht ändern
isolateShellEnv({ CLAUDE_EFFORT: undefined, CLAUDE_AUTH: undefined, ANTHROPIC_API_KEY: undefined });

interface Fake {
  pid: number;
  stdin: { write(text: string): unknown; end(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(): void;
}

/** Prozessattrappe: stdout füttert der Test oder ein fester Text; close beendet sie */
function fakeProcess(opts: { output?: string; stdin?: Fake["stdin"] } = {}) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  let exit!: (code: number) => void;
  const enc = new TextEncoder();
  const proc: Fake = {
    pid: 0,
    stdin: opts.stdin ?? { write() {}, end() {} },
    stdout: new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) }),
    stderr: new ReadableStream({ start: (c) => c.close() }),
    exited: new Promise<number>((r) => (exit = r)),
    kill() {},
  };
  const fp = {
    proc,
    prompts: [] as string[],
    write(text: string) {
      if (!closed) controller.enqueue(enc.encode(text));
    },
    close() {
      if (closed) return;
      closed = true;
      controller.close();
      exit(0);
    },
  };
  if (opts.output !== undefined) {
    fp.write(opts.output);
    fp.close();
  }
  return fp;
}

let current: ReturnType<typeof fakeProcess>;
let spawned: { cmd: string[]; env: Record<string, string> }[];
let terminated: number;

beforeAll(() => setMcpReaderForTests(() => new Set()));
afterAll(() => {
  setSpawnForTests(null);
  setRuntimeForTests(null);
  setMcpReaderForTests(null);
});
beforeEach(() => {
  spawned = [];
  terminated = 0;
  setSpawnForTests(((o: { cmd: string[]; env: Record<string, string> }) => {
    spawned.push({ cmd: o.cmd, env: o.env });
    return current.proc;
  }) as any);
  setRuntimeForTests({
    terminate: () => {
      terminated++;
      current.close();
    },
  });
});
afterEach(() => {
  setSpawnForTests(null);
  setRuntimeForTests(null);
});

const json = (o: object) => JSON.stringify(o);
const line = (o: object) => json(o) + "\n";
const SUCCESS = { type: "result", subtype: "success", is_error: false, session_id: "s1" };

/** callClaude im JSON-Format mit einem Ergebnis-Objekt, einzeln oder als Ereignisliste */
async function viaJson(result: object, list: boolean) {
  current = fakeProcess({ output: list ? json([{ type: "system", subtype: "init" }, result]) : json(result) });
  return callClaude({ prompt: "p", outputFormat: "json", model: "m" });
}

/** callClaudeStreaming mit dem Ergebnis-Ereignis als letzter Zeile */
async function viaStream(result: object) {
  current = fakeProcess({ output: line({ type: "system", subtype: "init", session_id: "s1" }) + line(result) });
  return callClaudeStreaming({ prompt: "p", model: "m" });
}

const BILLING_OK = { ...SUCCESS, result: "Die billing-Seite zeigt deine Rechnung." };
const IS_ERROR = { type: "result", is_error: true, subtype: "success", result: "kaputt" };
const SUBTYPE = { type: "result", subtype: "error_max_turns", result: "abgebrochen" };
const API_STATUS = { type: "result", api_error_status: 529, result: "überlastet" };
const NO_SIGNAL_OK = { type: "result", result: "Alles gut erledigt." };

describe("Fehler-Auswertung über die öffentlichen Wege", () => {
  for (const [label, run] of [
    ["callClaude, JSON-Objekt", (r: object) => viaJson(r, false)],
    ["callClaude, Ereignisliste", (r: object) => viaJson(r, true)],
    ["callClaudeStreaming", (r: object) => viaStream(r)],
  ] as const) {
    describe(label, () => {
      test("CLI meldet Erfolg, Text enthält billing: kein Fehler", async () => {
        const r = await run(BILLING_OK);
        expect(r.isError).toBe(false);
        expect(r.text).toBe(BILLING_OK.result);
      });
      test("is_error allein: Fehler", async () => {
        expect((await run(IS_ERROR)).isError).toBe(true);
      });
      test("Fehler-subtype allein: Fehler", async () => {
        expect((await run(SUBTYPE)).isError).toBe(true);
      });
      test("ohne CLI-Signal, harmloser Text: kein Fehler", async () => {
        expect((await run(NO_SIGNAL_OK)).isError).toBe(false);
      });
    });
  }

  test("callClaude: api_error_status allein ist ein Fehler (JSON-Objekt und Liste)", async () => {
    expect((await viaJson(API_STATUS, false)).isError).toBe(true);
    expect((await viaJson(API_STATUS, true)).isError).toBe(true);
  });

  test("Streaming ohne CLI-Signal: Textmuster greift", async () => {
    expect((await viaStream({ type: "result", result: "API Error: 401 unauthorized" })).isError).toBe(true);
  });

  test("Textformat: nur Textmuster, Text getrimmt", async () => {
    current = fakeProcess({ output: "  Failed to authenticate.  \n" });
    const r = await callClaude({ prompt: "p" });
    expect(r).toEqual({ text: "Failed to authenticate.", isError: true });
    current = fakeProcess({ output: "Hallo\n" });
    expect(await callClaude({ prompt: "p" })).toEqual({ text: "Hallo", isError: false });
  });

  test("callClaude JSON, kein gültiges JSON: Textmuster auf die Ausgabe", async () => {
    current = fakeProcess({ output: "OAuth token has expired" });
    expect(await callClaude({ prompt: "p", outputFormat: "json" })).toEqual({ text: "OAuth token has expired", isError: true });
  });
});

describe("Rückgabe-Verträge", () => {
  test("callClaude JSON: Text, Session, Kosten, Werkzeuge der Liste", async () => {
    const r = await viaJson({ ...SUCCESS, result: "fertig", total_cost_usd: 0 }, true);
    expect(r).toMatchObject({ text: "fertig", sessionId: "s1", isError: false, costUsd: 0 });
    expect(r.tools?.uses).toEqual([]);
  });

  test("callClaudeStreaming: Text, Session, Werkzeuge", async () => {
    const r = await viaStream({ ...SUCCESS, result: "fertig" });
    expect(r).toMatchObject({ text: "fertig", sessionId: "s1", isError: false });
    expect(r.tools?.uses).toEqual([]);
  });

  test("runClaudeWithTimeout: Rohtext, ungetrimmt", async () => {
    current = fakeProcess({ output: "  roh\n" });
    expect(await runClaudeWithTimeout("p", 5_000)).toBe("  roh\n");
  });

  test("Prompt geht über stdin, nicht über die Kommandozeile", async () => {
    const prompts: string[] = [];
    current = fakeProcess({ output: "ok", stdin: { write: (t: string) => prompts.push(t), end() {} } });
    await runClaudeWithTimeout("geheimer prompt", 5_000);
    expect(prompts).toEqual(["geheimer prompt"]);
    expect(spawned[0]!.cmd.join(" ")).not.toContain("geheimer prompt");
  });

  test("Kommandozeilen der drei Wege", async () => {
    current = fakeProcess({ output: "{}" });
    await callClaude({ prompt: "p", outputFormat: "json", model: "claude-opus-x", resumeSessionId: "r1", maxTurns: "3", allowedTools: ["Read", "Bash"] });
    current = fakeProcess({ output: "" });
    await callClaudeStreaming({ prompt: "p", model: "claude-sonnet-x", effort: "low" });
    current = fakeProcess({ output: "" });
    await runClaudeWithTimeout("p", 5_000, { allowedTools: ["Read"] });
    const tail = (cmd: string[]) => cmd.slice(cmd.indexOf("-p"));
    const disallowed = (cmd: string[]) => cmd[cmd.indexOf("--disallowedTools") + 1];
    const d = disallowed(spawned[0]!.cmd);
    expect(tail(spawned[0]!.cmd)).toEqual([
      "-p", "--output-format", "json", "--verbose", "--model", "claude-opus-x", "--effort", "high",
      "--allowedTools", "Read,Bash", "--disallowedTools", d!, "--resume", "r1", "--max-turns", "3",
    ]);
    expect(tail(spawned[1]!.cmd)).toEqual([
      "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--model", "claude-sonnet-x", "--effort", "low", "--disallowedTools", d!,
    ]);
    expect(tail(spawned[2]!.cmd)).toEqual(["-p", "--output-format", "text", "--allowedTools", "Read", "--disallowedTools", d!]);
    // Wachhalten auf macOS, sonst direkt die CLI
    for (const s of spawned) {
      if (process.platform === "darwin") expect(s.cmd.slice(0, 2)).toEqual(["/usr/bin/caffeinate", "-i"]);
      else expect(s.cmd[0]).not.toContain("caffeinate");
    }
  });

  // Issue #349: der Schlüssel kommt in allen drei Wegen nur nach CLAUDE_AUTH
  // (Fälle mit Schlüssel in tests/claude-auth-spawn.test.ts); ohne Schlüssel
  // steht er in keinem Kind, auch nicht leer
  test("Umgebung: ohne Schlüssel kein ANTHROPIC_API_KEY in allen drei Wegen", async () => {
    current = fakeProcess({ output: "" });
    await callClaude({ prompt: "p" });
    current = fakeProcess({ output: "" });
    await callClaudeStreaming({ prompt: "p" });
    current = fakeProcess({ output: "" });
    await runClaudeWithTimeout("p", 5_000);
    expect(spawned).toHaveLength(3);
    for (const s of spawned) expect("ANTHROPIC_API_KEY" in s.env).toBe(false);
    expect(spawned[2]!.env.TYBO_SUBPROCESS).toBe("1");
    for (const s of spawned) expect(s.env.HOME).toBeDefined();
  });
});

describe("Zeitlimit", () => {
  test("callClaude: timedOut, Prozess beendet, Register leer", async () => {
    current = fakeProcess();
    const r = await callClaude({ prompt: "p", timeoutMs: 20, quiet: true });
    expect(r).toEqual({ text: "", isError: true, timedOut: true });
    expect(terminated).toBe(1);
    expect(registeredEngineCallCount()).toBe(0);
  });

  test("callClaudeStreaming: timedOut mit timeoutKind total", async () => {
    current = fakeProcess();
    const r = await callClaudeStreaming({ prompt: "p", timeoutMs: 20 });
    expect(r).toMatchObject({ text: "", isError: true, timedOut: true, timeoutKind: "total" });
    expect(terminated).toBe(1);
    expect(registeredEngineCallCount()).toBe(0);
  });

  test("runClaudeWithTimeout wirft Timeout", async () => {
    current = fakeProcess();
    await expect(runClaudeWithTimeout("p", 20)).rejects.toThrow("Timeout");
    expect(terminated).toBe(1);
    expect(registeredEngineCallCount()).toBe(0);
  });
});

describe("Abbruch", () => {
  test("callClaude: aborted, kein timedOut, Register leer", async () => {
    current = fakeProcess();
    const p = callClaude({ prompt: "p", abortKey: "k-abbruch", timeoutMs: 5_000 });
    await Bun.sleep(5);
    expect(activeClaudeCallCount()).toBe(1);
    expect(abortClaudeCalls("k-abbruch")).toBe(1);
    expect(await p).toEqual({ text: "", isError: true, aborted: true });
    expect(registeredEngineCallCount()).toBe(0);
  });

  test("callClaudeStreaming: aborted", async () => {
    current = fakeProcess();
    const p = callClaudeStreaming({ prompt: "p", abortKey: "k-abbruch-s", timeoutMs: 5_000 });
    await Bun.sleep(5);
    abortClaudeCalls("k-abbruch-s");
    expect(await p).toEqual({ text: "", isError: true, aborted: true });
    expect(registeredEngineCallCount()).toBe(0);
  });

  test("runClaudeWithTimeout in einer Ausführung: wirft AbortError", async () => {
    current = fakeProcess();
    const p = runExecution("k-abbruch-r", "general", () => runClaudeWithTimeout("p", 5_000));
    await Bun.sleep(5);
    abortClaudeCalls("k-abbruch-r");
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(registeredEngineCallCount()).toBe(0);
  });

  test("Abbruch einer fortgesetzten Session: kein Fallback, kein frischer Neuversuch", async () => {
    current = fakeProcess();
    let calls = 0;
    let fallbacks = 0;
    const KEY = "dm:325";
    const deps: Partial<ChatTurnDeps> = {
      runFallbackChain: async () => {
        fallbacks++;
        return { text: "fallback", source: "none" };
      },
      buildPromptContext: async () => ({ fullPrompt: "prompt", fallbackContext: "" }),
      buildResumePrompt: async () => "resume",
      isSessionModeEnabled: () => true,
      getResumableSession: async () => ({ engine: "claude", engineSessionId: "sid-alt", startedAt: 1, messageCount: 1 }) as any,
      takeExpiredSession: async () => undefined,
      recordSessionTurn: async () => true,
      resetSession: async () => 0,
      shouldDistill: () => false,
      distillSession: async () => {},
      log: async () => {},
      getAgentConfig: () => ({ model: "m" }) as ReturnType<ChatTurnDeps["getAgentConfig"]>,
      getSettings: () => ({}),
      resolveStreamingLimits: () => resolveStreamingLimits({}),
      reportSecrets: () => [],
    };
    setSpawnForTests(((o: { cmd: string[]; env: Record<string, string> }) => {
      calls++;
      spawned.push({ cmd: o.cmd, env: o.env });
      return current.proc;
    }) as any);
    const reply = runExecution(KEY, "general", () =>
      runStreamingTurn({ userMessage: "x", chatId: "325", agentName: "general", sink: { progress() {}, notice() {} }, deps })
    ).catch((e) => e);
    for (let i = 0; i < 50 && calls === 0; i++) await Bun.sleep(2);
    expect(spawned[0]!.cmd).toContain("--resume");
    abortClaudeCalls(KEY);
    await reply;
    expect(calls).toBe(1);
    expect(fallbacks).toBe(0);
    expect(registeredEngineCallCount()).toBe(0);
  });
});

describe("Registrierung", () => {
  test("Ausführung schon abgebrochen: kein Prozess", async () => {
    current = fakeProcess({ output: "" });
    const p = runExecution("k-vorher", "general", async () => {
      abortExecutions("k-vorher");
      return callClaude({ prompt: "p" });
    });
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(spawned).toHaveLength(0);
  });
});

describe("Korrekturen im Prozesskern (Issue #325)", () => {
  test("Streaming: api_error_status allein ist ein Fehler", async () => {
    expect((await viaStream(API_STATUS)).isError).toBe(true);
  });

  test("callClaude JSON ohne CLI-Signal: Textmuster greift (Objekt und Liste)", async () => {
    const authFailed = { type: "result", result: "Failed to authenticate. API Error: 401" };
    expect((await viaJson(authFailed, false)).isError).toBe(true);
    expect((await viaJson(authFailed, true)).isError).toBe(true);
  });

  /** Timer, die der Kern anlegt und wieder entfernt, gezählt über echte Timer */
  function countTimers() {
    const open = new Set<unknown>();
    setRuntimeForTests({
      setTimeout: (fn, ms) => {
        const h = setTimeout(fn, ms);
        open.add(h);
        return h;
      },
      clearTimeout: (h) => {
        open.delete(h);
        clearTimeout(h as ReturnType<typeof setTimeout>);
      },
      setInterval: (fn, ms) => {
        const h = setInterval(fn, ms);
        open.add(h);
        return h;
      },
      clearInterval: (h) => {
        open.delete(h);
        clearInterval(h as ReturnType<typeof setInterval>);
      },
      terminate: () => {
        terminated++;
        current.close();
      },
    });
    return open;
  }

  const brokenStdin = {
    sofort: () => ({
      write() {
        throw new Error("EPIPE");
      },
      end() {},
    }),
    später: () => ({
      write: () => Promise.reject(new Error("EPIPE")),
      end() {},
    }),
  };

  for (const [art, stdin] of Object.entries(brokenStdin)) {
    test(`stdin scheitert ${art}: Prozess beendet, Register und Timer leer, Fehler-Ergebnis`, async () => {
      const open = countTimers();
      current = fakeProcess({ stdin: stdin() });
      const r = await callClaude({ prompt: "p", timeoutMs: 5_000 });
      expect(r).toEqual({ text: "", isError: true });
      expect(terminated).toBe(1);
      expect(registeredEngineCallCount()).toBe(0);
      expect(open.size).toBe(0);

      current = fakeProcess({ stdin: stdin() });
      const s = await callClaudeStreaming({ prompt: "p", timeoutMs: 5_000, idleTimeoutMs: 60_000 });
      expect(s).toEqual({ text: "", isError: true });
      expect(terminated).toBe(2);
      expect(open.size).toBe(0);

      current = fakeProcess({ stdin: stdin() });
      await expect(runClaudeWithTimeout("p", 5_000)).rejects.toThrow("EPIPE");
      expect(terminated).toBe(3);
      expect(registeredEngineCallCount()).toBe(0);
      expect(open.size).toBe(0);
    });
  }

  test("verspäteter Schreibfehler nach Prozessende: kein Signal, Ergebnis gilt", async () => {
    let reject!: (e: Error) => void;
    current = fakeProcess({ stdin: { write: () => new Promise((_, r) => (reject = r)), end() {} } });
    const p = callClaude({ prompt: "p", timeoutMs: 5_000 });
    current.write("fertig");
    current.close();
    await Bun.sleep(5);
    reject(new Error("EPIPE"));
    expect(await p).toEqual({ text: "fertig", isError: false });
    await Bun.sleep(5);
    expect(terminated).toBe(0);
  });

  test("Abbruch zwischen Start und Anmeldung: Prozess beendet, AbortError, nichts angemeldet", async () => {
    const open = countTimers();
    current = fakeProcess();
    setSpawnForTests((() => {
      abortExecutions("k-start");
      return current.proc;
    }) as any);
    const p = runExecution("k-start", "general", () => callClaude({ prompt: "p", timeoutMs: 5_000 }));
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(terminated).toBe(1);
    expect(registeredEngineCallCount()).toBe(0);
    expect(open.size).toBe(0);
  });

  test("/stop zweimal und Zeitlimit danach: Prozess nur einmal beendet", async () => {
    setRuntimeForTests({ terminate: () => void terminated++ });
    current = fakeProcess();
    const p = callClaudeStreaming({ prompt: "p", abortKey: "k-doppelt", timeoutMs: 30 });
    await Bun.sleep(5);
    abortClaudeCalls("k-doppelt");
    abortClaudeCalls("k-doppelt");
    await Bun.sleep(40);
    current.close();
    expect(await p).toEqual({ text: "", isError: true, aborted: true });
    expect(terminated).toBe(1);
  });
});

describe("Abschluss erst nach stdout, stderr und Prozessende (Issue #325)", () => {
  /** Attrappe, deren stdout, stderr und Prozessende unabhängig voneinander enden */
  function fakeParts() {
    let out!: ReadableStreamDefaultController<Uint8Array>;
    let err!: ReadableStreamDefaultController<Uint8Array>;
    let exit!: (code: number) => void;
    const state = { stdout: false, stderr: false, exited: false };
    const proc: Fake = {
      pid: 0,
      stdin: { write() {}, end() {} },
      stdout: new ReadableStream<Uint8Array>({ start: (c) => void (out = c) }),
      stderr: new ReadableStream<Uint8Array>({ start: (c) => void (err = c) }),
      exited: new Promise<number>((r) => (exit = r)),
      kill() {},
    };
    const parts = {
      proc,
      write(text: string) {
        out.enqueue(new TextEncoder().encode(text));
      },
      closeStdout() {
        // Nach einem Abbruch des Lesens ist der Strom schon geschlossen
        try {
          if (!state.stdout) out.close();
        } catch {}
        state.stdout = true;
      },
      failStdout() {
        if (!state.stdout) out.error(new Error("Lesefehler"));
        state.stdout = true;
      },
      closeStderr(text = "") {
        if (state.stderr) return;
        if (text) err.enqueue(new TextEncoder().encode(text));
        err.close();
        state.stderr = true;
      },
      exit(code = 0) {
        state.exited = true;
        exit(code);
      },
      /** Wie ein echter Prozess beim Beenden: alles zu, Prozess weg */
      kill() {
        parts.closeStdout();
        parts.closeStderr();
        parts.exit(143);
      },
    };
    return parts;
  }

  let parts: ReturnType<typeof fakeParts>;
  beforeEach(() => {
    parts = fakeParts();
    setSpawnForTests(((o: { cmd: string[]; env: Record<string, string> }) => {
      spawned.push({ cmd: o.cmd, env: o.env });
      return parts.proc;
    }) as any);
    setRuntimeForTests({
      terminate: () => {
        terminated++;
        parts.kill();
      },
    });
  });

  /** Ist die Promise nach kurzer Zeit schon erfüllt? */
  async function settledSoon(p: Promise<unknown>): Promise<boolean> {
    let done = false;
    p.then(
      () => void (done = true),
      () => void (done = true)
    );
    await Bun.sleep(10);
    return done;
  }

  const ways = [
    ["callClaude", (timeoutMs: number, abortKey?: string) => callClaude({ prompt: "p", timeoutMs, abortKey, quiet: true })],
    ["callClaudeStreaming", (timeoutMs: number, abortKey?: string) => callClaudeStreaming({ prompt: "p", timeoutMs, abortKey })],
    ["runClaudeWithTimeout", (timeoutMs: number) => runClaudeWithTimeout("p", timeoutMs)],
  ] as const;

  for (const [name, run] of ways) {
    test(`${name}: stdout zu, stderr offen, Prozess läuft: Zeitlimit beendet den Prozess`, async () => {
      const p = Promise.resolve(run(40)).catch((e: Error) => e);
      parts.closeStdout();
      expect(await settledSoon(p)).toBe(false);
      expect(registeredEngineCallCount()).toBe(1);
      const r = await p;
      if (name === "runClaudeWithTimeout") expect((r as Error).message).toBe("Timeout");
      else expect(r).toMatchObject({ isError: true, timedOut: true });
      expect(terminated).toBe(1);
      expect(registeredEngineCallCount()).toBe(0);
    });

    test(`${name}: stdout und stderr zu, Prozess läuft noch: Ende erst mit exited`, async () => {
      const p = Promise.resolve(run(5_000)).catch((e: Error) => e);
      parts.write(name === "callClaudeStreaming" ? line({ ...SUCCESS, result: "fertig" }) : "fertig");
      parts.closeStdout();
      parts.closeStderr("Hinweis");
      expect(await settledSoon(p)).toBe(false);
      expect(registeredEngineCallCount()).toBe(1);
      parts.exit(0);
      const r = await p;
      if (name === "runClaudeWithTimeout") expect(r).toBe("fertig");
      else expect(r).toMatchObject({ text: "fertig", isError: false });
      expect(terminated).toBe(0);
      expect(registeredEngineCallCount()).toBe(0);
    });

    test(`${name}: Prozess endet vor stdout und stderr: Ergebnis gilt`, async () => {
      const p = Promise.resolve(run(5_000)).catch((e: Error) => e);
      parts.exit(0);
      parts.write(name === "callClaudeStreaming" ? line({ ...SUCCESS, result: "fertig" }) : "fertig");
      expect(await settledSoon(p)).toBe(false);
      parts.closeStderr();
      expect(await settledSoon(p)).toBe(false);
      parts.closeStdout();
      const r = await p;
      if (name === "runClaudeWithTimeout") expect(r).toBe("fertig");
      else expect(r).toMatchObject({ text: "fertig", isError: false });
      expect(terminated).toBe(0);
      expect(registeredEngineCallCount()).toBe(0);
    });

    test(`${name}: Lesefehler auf stdout: laufender Prozess wird beendet`, async () => {
      const p = Promise.resolve(run(5_000)).catch((e: Error) => e);
      parts.failStdout();
      const r = await p;
      if (name === "runClaudeWithTimeout") expect((r as Error).message).toBe("Lesefehler");
      else expect(r).toEqual({ text: "", isError: true });
      expect(terminated).toBe(1);
      await expect(parts.proc.exited).resolves.toBe(143);
      expect(registeredEngineCallCount()).toBe(0);
    });
  }

  // Reihenfolgen nach dem Beenden (Lesefehler, Gesamtzeit, offenes stderr in
  // jeder Folge) prüft seit dem Zustandsautomaten die Matrix in
  // tests/engines-lifecycle.test.ts für alle Kombinationen

  for (const [name, run] of ways.slice(0, 2)) {
    test(`${name}: /stop während des Wartens auf stderr erreicht den Prozess`, async () => {
      const key = `k-stderr-${name}`;
      const p = run(5_000, key);
      parts.closeStdout();
      expect(await settledSoon(p)).toBe(false);
      expect(abortClaudeCalls(key)).toBe(1);
      expect(await p).toEqual({ text: "", isError: true, aborted: true });
      expect(terminated).toBe(1);
      expect(registeredEngineCallCount()).toBe(0);
    });
  }

  test("runClaudeWithTimeout: Abbruch der Ausführung während des Wartens auf stderr", async () => {
    const p = runExecution("k-stderr-r", "general", () => runClaudeWithTimeout("p", 5_000));
    parts.closeStdout();
    expect(await settledSoon(p)).toBe(false);
    abortClaudeCalls("k-stderr-r");
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(terminated).toBe(1);
    expect(registeredEngineCallCount()).toBe(0);
  });

  test("Streaming: Fehler im Zeilen-Rückruf beendet den laufenden Prozess", async () => {
    const throwing = (tag: string) => {
      throw new Error(tag);
    };
    const p = callClaudeStreaming({
      prompt: "p",
      timeoutMs: 5_000,
      onToolStart: () => throwing("Rückruf kaputt"),
    });
    parts.write(line({ type: "assistant", message: { id: "m1", content: [{ type: "tool_use", id: "t1", name: "Read", input: {} }] } }));
    const r = await p;
    expect(r).toEqual({ text: "", isError: true });
    expect(terminated).toBe(1);
    expect(registeredEngineCallCount()).toBe(0);
  });
});

describe("Prozesskern mit Plattform-Attrappe: Kinder nach dem Prozessende (Entscheidung A, Issue #325)", () => {
  /**
   * Prozess 4242 mit Kind in derselben Gruppe, nur als Attrappe: kein echtes
   * Signal geht raus. Das Kind ignoriert SIGTERM und hält stderr offen, bis
   * die Gruppe SIGKILL bekommt. state.members zählt die Gruppe.
   */
  function scene() {
    let out!: ReadableStreamDefaultController<Uint8Array>;
    let err!: ReadableStreamDefaultController<Uint8Array>;
    let exit!: (code: number) => void;
    const state = { members: 2, stderrOpen: true, stdoutOpen: true };
    const log: string[] = [];
    const proc = {
      pid: 4242,
      exitCode: null as number | null,
      stdin: { write() {}, end() {} },
      stdout: new ReadableStream<Uint8Array>({ start: (c) => void (out = c) }),
      stderr: new ReadableStream<Uint8Array>({ start: (c) => void (err = c) }),
      exited: new Promise<number>((r) => (exit = r)),
      kill() {},
    };
    const closeStderr = () => {
      if (!state.stderrOpen) return;
      state.stderrOpen = false;
      err.close();
    };
    const timers = (set: Set<unknown>) => ({
      setTimeout: (fn: () => void, ms: number) => {
        const h = setTimeout(() => {
          set.delete(h);
          fn();
        }, ms);
        set.add(h);
        return h;
      },
      clearTimeout: (h: unknown) => {
        set.delete(h);
        clearTimeout(h as ReturnType<typeof setTimeout>);
      },
    });
    const platformTimers = new Set<unknown>();
    const platform: ProcessPlatform = {
      os: "linux",
      groupAlive: (pgid) => pgid === 4242 && state.members > 0,
      signalGroup: (pgid, signal) => {
        log.push(`group -${pgid} ${signal}`);
        if (signal === "SIGKILL") {
          state.members = 0;
          closeStderr();
        }
      },
      taskkill: (pid) => void log.push(`taskkill ${pid}`),
      ...timers(platformTimers),
    };
    const runtimeTimers = new Set<unknown>();
    setSpawnForTests((() => proc) as any);
    setRuntimeForTests({
      ...timers(runtimeTimers),
      terminate: (p) => {
        terminated++;
        stopTree(p as any, { first: "SIGTERM", killAfterMs: 20 }, platform);
      },
      stopGraceMs: 300,
    });
    return {
      state,
      log,
      platformTimers,
      runtimeTimers,
      write: (text: string) => out.enqueue(new TextEncoder().encode(text)),
      closeStdout: () => {
        if (state.stdoutOpen) out.close();
        state.stdoutOpen = false;
      },
      failStdout: () => {
        if (state.stdoutOpen) out.error(new Error("Lesefehler"));
        state.stdoutOpen = false;
      },
      /** Der Prozess selbst endet und ist abgeräumt; das Kind bleibt in der Gruppe */
      async exitLeader() {
        proc.exitCode = 0;
        state.members = Math.max(0, state.members - 1);
        exit(0);
        await Bun.sleep(0);
      },
    };
  }

  const ways = [
    ["callClaude", (timeoutMs: number, key: string) => callClaude({ prompt: "p", timeoutMs, abortKey: key, quiet: true })],
    ["callClaudeStreaming", (timeoutMs: number, key: string) => callClaudeStreaming({ prompt: "p", timeoutMs, abortKey: key })],
    ["runClaudeWithTimeout", (timeoutMs: number, key: string) => runExecution(key, "general", () => runClaudeWithTimeout("p", timeoutMs))],
  ] as const;

  const fertig = (name: string) => (name === "callClaudeStreaming" ? line({ ...SUCCESS, result: "fertig" }) : "fertig");

  /** Abschluss vor der Wartezeit von 300 ms: das SIGKILL an die Gruppe hat das Kind erreicht */
  async function quickly(p: Promise<unknown>) {
    const started = Date.now();
    const r = await p;
    expect(Date.now() - started).toBeLessThan(250);
    return r;
  }

  for (const [name, run] of ways) {
    test(`${name}: Prozess endet, stdout normal zu, Kind ignoriert SIGTERM und hält stderr: Zeitlimit schickt SIGTERM und SIGKILL an die Gruppe, Abschluss`, async () => {
      const s = scene();
      const p = Promise.resolve(run(40, `k-kind-t-${name}`)).catch((e: Error) => e);
      // Start abwarten: runExecution startet den Prozess erst danach
      await Bun.sleep(1);
      s.write(fertig(name));
      s.closeStdout();
      await s.exitLeader();
      const r = await quickly(p);
      if (name === "runClaudeWithTimeout") expect((r as Error).message).toBe("Timeout");
      else expect(r).toMatchObject({ isError: true, timedOut: true });
      expect(s.log).toEqual(["group -4242 SIGTERM", "group -4242 SIGKILL"]);
      expect(s.state.stderrOpen).toBe(false);
      expect(terminated).toBe(1);
      expect(registeredEngineCallCount()).toBe(0);
      expect(s.runtimeTimers.size).toBe(0);
      expect(s.platformTimers.size).toBe(0);
    });

    test(`${name}: Prozess endet, stdout normal zu, Kind hält stderr: Abbruch erreicht das Kind über die Gruppe, Abschluss`, async () => {
      const s = scene();
      const key = `k-kind-a-${name}`;
      const p = Promise.resolve(run(5_000, key)).catch((e: Error) => e);
      // Start abwarten: runExecution startet den Prozess erst danach
      await Bun.sleep(1);
      s.write(fertig(name));
      s.closeStdout();
      await s.exitLeader();
      await Bun.sleep(5);
      expect(abortClaudeCalls(key)).toBe(1);
      const r = await quickly(p);
      if (name === "runClaudeWithTimeout") expect(r).toMatchObject({ name: "AbortError" });
      else expect(r).toEqual({ text: "", isError: true, aborted: true });
      expect(s.log).toEqual(["group -4242 SIGTERM", "group -4242 SIGKILL"]);
      expect(registeredEngineCallCount()).toBe(0);
      expect(s.runtimeTimers.size).toBe(0);
      expect(s.platformTimers.size).toBe(0);
    });

    test(`${name}: Prozess beendet, Kind lebt, Lesefehler: Kind über die Gruppe beendet, Abschluss`, async () => {
      const s = scene();
      const p = Promise.resolve(run(5_000, `k-kind-l-${name}`)).catch((e: Error) => e);
      // Start abwarten: runExecution startet den Prozess erst danach
      await Bun.sleep(1);
      await s.exitLeader();
      s.failStdout();
      await quickly(p);
      expect(s.log).toEqual(["group -4242 SIGTERM", "group -4242 SIGKILL"]);
      expect(registeredEngineCallCount()).toBe(0);
      expect(s.runtimeTimers.size).toBe(0);
      expect(s.platformTimers.size).toBe(0);
    });

    for (const trigger of ["Lesefehler", "Zeitlimit", "Abbruch"] as const) {
      test(`${name}: Gruppe leer, ein Kind außerhalb der Gruppe hält stderr, dann ${trigger}: kein Signal, Abschluss nach der Wartezeit`, async () => {
        const s = scene();
        const key = `k-leer-${trigger}-${name}`;
        const p = Promise.resolve(run(trigger === "Zeitlimit" ? 40 : 5_000, key)).catch((e: Error) => e);
        // Start abwarten: runExecution startet den Prozess erst danach
        await Bun.sleep(1);
        s.state.members = 1;
        await s.exitLeader();
        if (trigger === "Lesefehler") s.failStdout();
        else s.closeStdout();
        if (trigger === "Abbruch") {
          await Bun.sleep(5);
          abortClaudeCalls(key);
        }
        await p;
        expect(s.log).toEqual([]);
        expect(s.state.stderrOpen).toBe(true);
        expect(registeredEngineCallCount()).toBe(0);
        expect(s.runtimeTimers.size).toBe(0);
        expect(s.platformTimers.size).toBe(0);
      });
    }
  }
});
