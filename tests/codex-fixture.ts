/**
 * Attrappe für den Codex-Motor (Issue #123): ersetzt Prozessstart, Timer und
 * Signale (setCodexRuntimeForTests). Kein echtes codex, keine echten
 * Signale: die Attrappe hat pid 0, Signale landen nur in `signals`.
 * SIGINT verhält sich wie Codex: der Turn bricht ab, stdout schließt, Exit 1.
 */
import { setCodexRuntimeForTests, type CodexRuntime } from "../src/lib/engines/codex";

export interface FakeRun {
  /** JSONL-Ereignisse, die sofort auf stdout stehen */
  events?: object[];
  /** Roher Text auf stdout nach den Ereignissen (etwa codex --version) */
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  /** stdout bleibt offen, bis ein Signal kommt */
  hang?: boolean;
  /** Prozessstart wirft (etwa: codex nicht installiert) */
  throws?: string;
  /** stdin.write wirft mit dieser Meldung */
  stdinWriteThrows?: string;
  /** stdin.end liefert ein abgelehntes Promise mit dieser Meldung (etwa EPIPE) */
  stdinEndRejects?: string;
  /** stdin.end liefert ein Promise, das nie erfüllt wird (stockende Pipe) */
  stdinEndPending?: boolean;
  /** stdin.write liefert ein Promise, das kurz darauf mit dieser Meldung ablehnt */
  stdinWriteRejectsLater?: string;
  /** write bzw. end liefert eine Promise, die erst fake.rejectStdin() ablehnt */
  stdinHeld?: "write" | "end";
  /** stdout bricht nach den Ereignissen mit dieser Meldung ab (Lesefehler) */
  stdoutError?: string;
  /** SIGINT beendet den Prozess nicht, erst SIGKILL */
  ignoreSigint?: boolean;
  /** Eigener Strom statt stdout (etwa endlose Ausgabe); Exit weiterhin über hang/Signale */
  stdoutStream?: ReadableStream<Uint8Array>;
  /** Eigener Strom statt stderr */
  stderrStream?: ReadableStream<Uint8Array>;
}

export interface SpawnCall {
  cmd: string[];
  cwd?: string;
  detached?: boolean;
  env?: Record<string, string>;
  stdin: string;
}

interface Timer {
  id: number;
  at: number;
  fn: () => void;
  every?: number;
}

export interface CodexFake {
  spawns: SpawnCall[];
  signals: string[];
  /** Nächster Lauf; ohne Angabe wirft der Start */
  next(run: FakeRun): void;
  /** Uhr vorstellen und fällige Timer ausführen */
  advance(ms: number): void;
  /** Eine weitere Zeile auf stdout des laufenden Prozesses */
  emit(event: object): void;
  /** Den laufenden Prozess regulär beenden */
  finish(exitCode?: number): void;
  /** Die mit stdinHeld zurückgehaltene stdin-Promise ablehnen */
  rejectStdin(message: string): void;
  /** Anzahl offener Timer */
  timerCount(): number;
  /** Befehl ohne caffeinate-Vorsatz (macOS) */
  command(i?: number): string[];
  restore(): void;
}

export interface FakeOptions {
  realTimers?: boolean;
  /** Laufzeit einsetzen bzw. mit null zurückstellen; Standard der Codex-Motor (OpenCode: tests/opencode-fixture.ts) */
  install?: (runtime: Partial<CodexRuntime> | null) => void;
  /** Feste Antwort für bestimmte Befehle (etwa --version), ohne die Warteschlange zu verbrauchen */
  auto?: (cmd: string[]) => FakeRun | undefined;
}

export function installCodexFake(opts: FakeOptions = {}): CodexFake {
  const install = opts.install ?? setCodexRuntimeForTests;
  const enc = new TextEncoder();
  const spawns: SpawnCall[] = [];
  const signals: string[] = [];
  const queue: FakeRun[] = [];
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map<number, Timer>();
  let heldStdin: ((err: Error) => void) | null = null;
  const holdStdin = () => new Promise<never>((_, reject) => void (heldStdin = reject));
  let current: { controller: ReadableStreamDefaultController<Uint8Array>; close: (code: number) => void } | null = null;

  const fakeSpawn = (options: { cmd: string[]; cwd?: string; detached?: boolean; env?: Record<string, string> }) => {
    const run = opts.auto?.(options.cmd) ?? queue.shift();
    if (!run) throw new Error("unerwarteter Prozessstart");
    if (run.throws) throw new Error(run.throws);
    const call: SpawnCall = { cmd: options.cmd, cwd: options.cwd, detached: options.detached, env: options.env, stdin: "" };
    spawns.push(call);
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (controller = c) });
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>((r) => (resolveExit = r));
    let closed = false;
    const close = (code: number) => {
      if (closed) return;
      closed = true;
      // Der Leser kann stdout schon abgebrochen haben (etwa bei zu viel Ausgabe)
      try {
        controller.close();
      } catch {
        // bereits geschlossen
      }
      resolveExit(code);
    };
    for (const e of run.events ?? []) controller.enqueue(enc.encode(JSON.stringify(e) + "\n"));
    if (run.stdout) controller.enqueue(enc.encode(run.stdout));
    if (run.stdoutError) {
      closed = true;
      controller.error(new Error(run.stdoutError));
      resolveExit(run.exitCode ?? 1);
    } else if (!run.hang) close(run.exitCode ?? 0);
    const proc = {
      pid: 0,
      stdin: {
        write(s: string) {
          if (run.stdinHeld === "write") return holdStdin();
          if (run.stdinWriteThrows) throw new Error(run.stdinWriteThrows);
          if (run.stdinWriteRejectsLater) {
            const message = run.stdinWriteRejectsLater;
            return new Promise<number>((_, reject) => setTimeout(() => reject(new Error(message)), 5));
          }
          call.stdin += s;
        },
        end() {
          if (run.stdinHeld === "end") return holdStdin();
          if (run.stdinEndRejects) return Promise.reject(new Error(run.stdinEndRejects));
          if (run.stdinEndPending) return new Promise<void>(() => {});
        },
      },
      stdout: run.stdoutStream ?? stdout,
      stderr: run.stderrStream ?? new ReadableStream<Uint8Array>({
        start: (c) => {
          if (run.stderr) c.enqueue(enc.encode(run.stderr));
          c.close();
        },
      }),
      exited,
      kill() {
        throw new Error("proc.kill darf in Tests nie aufgerufen werden");
      },
      __close: close,
      __ignoreSigint: run.ignoreSigint === true,
    };
    current = { controller, close };
    return proc;
  };

  const runtime: Partial<CodexRuntime> = {
    spawn: fakeSpawn as any,
    signal: (proc, signal) => {
      signals.push(signal);
      // Codex bricht bei SIGINT den Turn ab und endet mit Exit 1
      if (signal === "SIGINT" && (proc as any).__ignoreSigint) return;
      (proc as any).__close?.(signal === "SIGKILL" ? 137 : 1);
    },
  };
  if (!opts.realTimers) {
    Object.assign(runtime, {
      now: () => now,
      setTimeout: (fn: () => void, ms: number) => {
        const id = nextId++;
        timers.set(id, { id, at: now + ms, fn });
        return id;
      },
      clearTimeout: (id: unknown) => void timers.delete(id as number),
      setInterval: (fn: () => void, ms: number) => {
        const id = nextId++;
        timers.set(id, { id, at: now + ms, fn, every: ms });
        return id;
      },
      clearInterval: (id: unknown) => void timers.delete(id as number),
    } satisfies Partial<CodexRuntime>);
  }
  install(runtime);

  return {
    spawns,
    signals,
    next: (run) => void queue.push(run),
    advance(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.values()].filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        if (due.every) due.at += due.every;
        else timers.delete(due.id);
        due.fn();
      }
      now = end;
    },
    emit(event) {
      current?.controller.enqueue(enc.encode(JSON.stringify(event) + "\n"));
    },
    finish(exitCode = 0) {
      current?.close(exitCode);
    },
    rejectStdin(message) {
      heldStdin?.(new Error(message));
      heldStdin = null;
    },
    timerCount: () => timers.size,
    command(i = spawns.length - 1) {
      const cmd = spawns[i]!.cmd;
      return cmd[0] === "/usr/bin/caffeinate" ? cmd.slice(2) : cmd;
    },
    restore() {
      queue.length = 0;
      heldStdin = null;
      timers.clear();
      install(null);
    },
  };
}

/** Kleine Helfer für Ereignisse */
export const ev = {
  started: (id: string) => ({ type: "thread.started", thread_id: id }),
  message: (id: string, text: string) => ({ type: "item.completed", item: { id, type: "agent_message", text } }),
  webSearch: (id: string, query: string) => ({ type: "item.started", item: { id, type: "web_search", query, action: { type: "search" } } }),
  mcp: (id: string, server: string, tool: string) => ({
    type: "item.started",
    item: { id, type: "mcp_tool_call", server, tool, arguments: {}, result: null, error: null, status: "in_progress" },
  }),
  command: (id: string, command: string) => ({ type: "item.started", item: { id, type: "command_execution", command, status: "in_progress" } }),
  completed: () => ({ type: "turn.completed", usage: { input_tokens: 10, cached_input_tokens: 4, output_tokens: 3, reasoning_output_tokens: 1 } }),
  failed: (message: string) => ({ type: "turn.failed", error: { message } }),
};

export async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("Bedingung nicht erreicht");
    await new Promise((r) => setTimeout(r, 1));
  }
}
