/**
 * Weg "claude-cli" für den Telefonhörer (Issue #256): eine offene
 * Claude-Code-Sitzung je Gespräch, im Abo ohne API-Schlüssel.
 *
 * - Start: `claude -p --input-format stream-json --output-format stream-json
 *   --verbose --include-partial-messages --model <m> --effort <e> --safe-mode
 *   --strict-mcp-config --tools "" --disable-slash-commands
 *   --no-session-persistence --system-prompt <s>`. --safe-mode hält CLAUDE.md,
 *   Hooks, Plugins, MCP-Server und Auto-Memory heraus, die Anmeldung bleibt.
 *   Vor dem ersten Start prüft der Weg `claude --help`; fehlt ein Flag, startet
 *   er nicht (BrainError "setup" mit den fehlenden Flags).
 * - Umgebung: subprocessEnv() (TYBO_SUBPROCESS=1), danach zusätzlich ohne
 *   jede Variable, die nach Geheimnis aussieht: die Sitzung hat weder
 *   Werkzeuge noch MCP-Server, braucht also auch keine Freigaben. Bleiben
 *   dürfen nur die Anmeldungen der CLI selbst (CLI_LOGIN_VARS);
 *   ANTHROPIC_API_KEY nur nach CLAUDE_AUTH (Issue #349). Bei apiKey ohne
 *   Schlüssel startet keine Sitzung (BrainError "setup").
 *   Haiku bekommt MAX_THINKING_TOKENS=0.
 * - Turn: eine Zeile {"type":"user",...} auf stdin; Text aus stream_event mit
 *   text_delta, Ende mit result. total_cost_usd ist über die Sitzung
 *   kumulativ (gemessen 01.10.2026, CLI 2.1.286); gebucht wird je result
 *   nur der Zuwachs (spend/credit.ts, Issue #346).
 * - Abbruch: Jeder Turn hat genau einen Abbruch-Zustand (ActiveTurn.cancel),
 *   gesetzt vom Signal des Aufrufers, von interrupt(), /stop und close(),
 *   gemeldet an runVoiceTurn über call.abort(). Gesetzt heißt: Warteschlange
 *   leer, kein Textstück mehr, keine Äußerung mehr senden. Der Turn ist ab
 *   dem Aufruf von stream() eingetragen, auch während er auf das Ende des
 *   vorigen Unterbrechens oder die Flag-Prüfung wartet.
 * - interrupt(): control_request mit subtype interrupt, dann Warten auf
 *   result (höchstens 2 s, sonst wird der Prozess beendet und beim nächsten
 *   Turn neu gestartet). Der nächste Turn wartet, bis das erledigt ist;
 *   Ereignisse des abgebrochenen Turns erreichen ihn nie. Der unterbrochene
 *   Turn endet mit AbortError, nie als Fehler oder Absturz (das erwartete
 *   error_during_execution zählt nicht). /stop und close() enden mit
 *   BrainError "ended".
 * - Absturz (Prozess endet ohne result): einmal neu starten, die letzten
 *   höchstens 12 Äußerungen gehen als Anhang in den System-Prompt. Kam im
 *   Turn noch kein Text, wird die Äußerung gleich im neuen Prozess
 *   wiederholt; sonst endet der Turn mit Fehler (nichts doppelt sprechen),
 *   und der nächste Turn startet neu. Der zweite Absturz in Folge ist ein
 *   Fehler an den Aufrufer, danach ist der Weg beendet.
 * - Die Sitzung steht in engines/calls.ts unter abortKey: /stop und das
 *   Herunterfahren beenden sie, danach startet sie nicht wieder. Als
 *   Verarbeitung (Neustart wartet) zählt sie nur während eines Turns
 *   (Issue #257); zwischen den Turns hält sie keinen Neustart auf.
 * - prepare(system) (Issue #257): startet die Sitzung schon beim Öffnen des
 *   Gesprächs (Flag-Prüfung und Prozessstart), damit der erste Turn nicht
 *   darauf wartet. Der erste stream() nutzt diesen Prozess.
 * - Budget: reserveRequest vor jeder gesendeten Äußerung, genau eine
 *   Abrechnung je Reservierung (Erfolg, Fehler, Abbruch, Absturz).
 */

import { spawn } from "bun";
import { isCliResultError } from "../../claude/result";
import { registerEngineCall, unregisterEngineCall, type EngineCallEntry } from "../../engines/calls";
import { claudeAuthProblem, withClaudeAuth } from "../../engines/claude-auth";
import { terminateProcessTree } from "../../process-tree";
import { bookRunOutcome, claudeUsage, type RunOutcome } from "../../spend/credit";
import { isSecretName, subprocessEnv } from "../../subprocess-env";
import { BrainError, type BrainBackend, type BrainCall, type BrainMessage } from "../types";

const IS_WINDOWS = process.platform === "win32";
const HOME_DIR = process.env.HOME || process.env.USERPROFILE || "";

/** Flags, ohne die der Weg nicht startet */
export const CLI_REQUIRED_FLAGS = [
  "--input-format",
  "--output-format",
  "--verbose",
  "--include-partial-messages",
  "--model",
  "--effort",
  "--safe-mode",
  "--strict-mcp-config",
  "--tools",
  "--disable-slash-commands",
  "--no-session-persistence",
  "--system-prompt",
] as const;

/** So lange wartet interrupt() auf das result des abgebrochenen Turns */
export const INTERRUPT_GRACE_MS = 2_000;
/** Höchstens so viele Äußerungen gehen nach einem Absturz in den System-Prompt */
export const RESTART_HISTORY = 12;

/** Anmeldungen der CLI, die in der Umgebung bleiben dürfen (wenn subprocessEnv sie durchließ) */
const CLI_LOGIN_VARS = new Set(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]);

/** Fehlende Flags laut `claude --help` */
export function missingCliFlags(helpText: string): string[] {
  return CLI_REQUIRED_FLAGS.filter((flag) => !new RegExp(`(^|[\\s,])${flag.replace(/-/g, "\\-")}(?![\\w-])`, "m").test(helpText));
}

export function claudeCliArgs(o: { model: string; effort: string; system: string }): string[] {
  return [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    o.model,
    "--effort",
    o.effort,
    "--safe-mode",
    "--strict-mcp-config",
    "--tools",
    "",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--system-prompt",
    o.system,
  ];
}

/**
 * Umgebung der Sitzung: subprocessEnv ohne alles, was nach Geheimnis
 * aussieht, außer den Anmeldungen der CLI; dazu HOME, PATH und bei Haiku
 * MAX_THINKING_TOKENS=0. ANTHROPIC_API_KEY allein nach der Anmeldung in env
 * (CLAUDE_AUTH, src/lib/engines/claude-auth.ts).
 */
export function claudeCliEnv(model: string, base: Record<string, string>, env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (isSecretName(name) && !CLI_LOGIN_VARS.has(name)) continue;
    out[name] = value;
  }
  out.HOME = HOME_DIR || out.HOME || "";
  out.PATH = env.PATH || out.PATH || "";
  const withAuth = withClaudeAuth(out, env);
  if (/haiku/i.test(model)) withAuth.MAX_THINKING_TOKENS = "0";
  withAuth.TYBO_SUBPROCESS = "1";
  return withAuth;
}

/** Anhang an den System-Prompt nach einem Neustart: der bisherige Verlauf */
export function restartAppendix(history: BrainMessage[], agentName = "tybo"): string {
  const recent = history.slice(-RESTART_HISTORY);
  if (!recent.length) return "";
  const lines = recent.map((m) => `${m.role === "user" ? "Nutzer" : agentName}: ${m.content}`);
  return `\n\nDie Sitzung wurde neu gestartet. Bisheriger Verlauf dieses Gesprächs, mach dort weiter:\n${lines.join("\n")}`;
}

// ---------------------------------------------------------------------------
// Laufzeit (in Tests ersetzbar)
// ---------------------------------------------------------------------------

export interface CliProc {
  pid: number;
  stdin: { write(chunk: string): unknown; flush?(): unknown; end?(): unknown };
  stdout: ReadableStream<Uint8Array>;
  stderr?: ReadableStream<Uint8Array> | null;
  exited: Promise<number | null>;
  kill(signal?: number): void;
}

export interface CliRuntime {
  spawn(o: { cmd: string[]; cwd: string; env: Record<string, string> }): CliProc;
  terminate(proc: CliProc): void;
  /** Ausgabe von `claude --help` (null: ließ sich nicht starten) */
  help(): Promise<string | null>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

function claudePath(): string {
  return process.env.CLAUDE_PATH || "claude";
}

export const defaultCliRuntime: CliRuntime = {
  spawn: (o) =>
    spawn({ cmd: o.cmd, cwd: o.cwd, env: o.env, detached: !IS_WINDOWS, stdin: "pipe", stdout: "pipe", stderr: "pipe" }) as unknown as CliProc,
  terminate: (proc) => terminateProcessTree(proc),
  help: () => cliHelpText(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

let helpCache: { path: string; at: number; text: Promise<string | null> } | undefined;

/** `claude --help` mit 5 s Zeitlimit, Ergebnis gilt 10 Minuten */
async function cliHelpText(): Promise<string | null> {
  const path = claudePath();
  if (helpCache && helpCache.path === path && Date.now() - helpCache.at < 600_000) return helpCache.text;
  const text = (async () => {
    try {
      const proc = spawn({ cmd: [path, "--help"], env: claudeCliEnv("", subprocessEnv({ home: HOME_DIR })), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const timer = setTimeout(() => proc.kill(), 5_000);
      const out = await new Response(proc.stdout).text();
      clearTimeout(timer);
      const code = await proc.exited;
      return code === 0 ? out : null;
    } catch {
      return null;
    }
  })();
  helpCache = { path, at: Date.now(), text };
  return text;
}

/** Fehlende Flags der installierten CLI; null, wenn `claude --help` nicht lief */
export async function checkCliFlags(runtime: CliRuntime = defaultCliRuntime): Promise<{ missing: string[] } | null> {
  const help = await runtime.help();
  return help === null ? null : { missing: missingCliFlags(help) };
}

// ---------------------------------------------------------------------------
// Sitzung
// ---------------------------------------------------------------------------

export interface ClaudeCliBackendOptions {
  /** z. B. claude-sonnet-5-5 (ohne Präfix "claude:") */
  model: string;
  effort: string;
  /** Session-Schlüssel des Gesprächs für /stop (engines/calls.ts) */
  abortKey?: string;
  /** Name des Agenten im Neustart-Anhang */
  agentName?: string;
  /** Tagesbudget "voice": reservieren, Rückgabe rechnet ab */
  reserveRequest?: () => () => void;
  cwd?: string;
  runtime?: CliRuntime;
  /**
   * Bucht je result-Ereignis einen Lauf (Standard: spend/credit.ts, Herkunft
   * voice): costUsd ist der Zuwachs gegenüber dem letzten total_cost_usd,
   * fehlt er im Ereignis, gilt der Lauf als „nicht gemeldet"; usage geht wie
   * im Ereignis gemeldet mit
   */
  recordRun?: (outcome: RunOutcome) => void;
}

interface TurnSink {
  text(t: string): void;
  result(ev: { is_error?: boolean; subtype?: string; result?: string }): void;
  crash(): void;
}

interface Session {
  proc: CliProc;
  entry?: EngineCallEntry;
  /** Prozess wurde von tybo beendet (Unterbrechen, close, /stop): kein Absturz */
  expected: boolean;
  exited: boolean;
  lastTotal: number;
  sink: TurnSink | null;
  /** Ein laufender Turn hat das Ende schon als Absturz gezählt */
  turnCrash?: boolean;
}

function abortError(): Error {
  const err = new Error("Abgebrochen");
  err.name = "AbortError";
  return err;
}

/**
 * Ein Turn mit genau einem Abbruch-Zustand (cancel). Alle Quellen setzen ihn:
 * Signal des Aufrufers, interrupt(), /stop, close(). Ist er gesetzt, ist die
 * Warteschlange leer, die Sitzung legt nichts mehr hinein, und der Aufrufer
 * (runVoiceTurn) erfährt es über call.abort().
 */
interface ActiveTurn {
  call: BrainCall;
  cancel: AbortController;
  /** Textstücke, die noch nicht ausgegeben wurden */
  queue: string[];
  /** Sitzung des aktuellen Versuchs (null: noch keine Äußerung gesendet) */
  session: Session | null;
  /** result oder Absturz des aktuellen Versuchs ist da */
  finished: boolean;
  controlSent: boolean;
  done: Promise<void>;
  resolveDone(): void;
  attempt(s: Session): void;
  notify(): void;
  wait(): Promise<void>;
}

function newTurn(call: BrainCall): ActiveTurn {
  let wake: (() => void) | null = null;
  const turn: ActiveTurn = {
    call,
    cancel: new AbortController(),
    queue: [],
    session: null,
    finished: false,
    controlSent: false,
    done: Promise.resolve(),
    resolveDone: () => {},
    attempt(s) {
      turn.session = s;
      turn.finished = false;
      turn.controlSent = false;
      turn.done = new Promise<void>((r) => (turn.resolveDone = r));
    },
    notify() {
      const w = wake;
      wake = null;
      w?.();
    },
    wait: () => new Promise<void>((resolve) => (wake = resolve)),
  };
  return turn;
}

/**
 * Kosten eines Turns aus dem über die Sitzung kumulierten total_cost_usd:
 * der Zuwachs seit dem letzten Wert (springt der Zähler zurück, etwa nach
 * einem Neustart der Sitzung, zählt der neue Wert ganz). Ohne Zahl: keine
 * Kostenmeldung, der Stand bleibt.
 */
function sessionCostStep(s: Session, total: unknown): { costUsd?: number } {
  if (typeof total !== "number" || !(total >= 0)) return {};
  const step = total >= s.lastTotal ? total - s.lastTotal : total;
  s.lastTotal = total;
  return { costUsd: step };
}

/**
 * Text eines result für die Limit-Erkennung: Antworttext und errors der CLI
 * zusammen, denn ein Limit-Fehler steht oft nur in errors.
 */
function resultErrorText(ev: { result?: unknown; errors?: unknown }): string {
  const parts = [ev.result, ...(Array.isArray(ev.errors) ? ev.errors : [])];
  return parts.filter((part): part is string => typeof part === "string" && part !== "").join("\n");
}

export function createClaudeCliBackend(options: ClaudeCliBackendOptions): BrainBackend {
  const runtime = options.runtime ?? defaultCliRuntime;
  const recordRun = options.recordRun ?? ((outcome: RunOutcome) => void bookRunOutcome("voice", "claude", options.model, outcome));
  const cwd = options.cwd ?? process.cwd();
  let session: Session | null = null;
  /** Gestartete Prozesse; ab dem zweiten bekommt der System-Prompt den Verlauf */
  let started = 0;
  let crashes = 0;
  /** ended: close(), /stop oder zweiter Absturz; dann keine neue Sitzung */
  let ended: string | null = null;
  let flagsChecked = false;
  let pendingInterrupt: Promise<void> | null = null;
  /** Der laufende Turn, ab dem Aufruf von stream() bis result, Absturz oder Zeitlimit */
  let active: ActiveTurn | null = null;
  /**
   * Zuletzt begonnener Turn, auch nach seinem result: runVoiceTurn spricht
   * danach noch den Rest aus sentences.flush(), interrupt(), /stop und close()
   * müssen ihn auch dann beenden. Ein schon abgeschlossener Turn ignoriert das.
   */
  let lastTurn: ActiveTurn | null = null;

  /** Turn beenden, gleich aus welcher Quelle: ein Zustand für Ausgabe, Warteschlange und Aufrufer */
  const stopTurn = (turn: ActiveTurn, reason: unknown) => {
    if (turn.cancel.signal.aborted) return;
    turn.queue.length = 0;
    turn.cancel.abort(reason);
    turn.call.abort?.(reason);
  };

  const kill = (s: Session) => {
    s.expected = true;
    if (!s.exited) runtime.terminate(s.proc);
    if (s.entry) unregisterEngineCall(options.abortKey, s.entry);
    s.entry = undefined;
    if (session === s) session = null;
  };

  const start = (system: string) => {
    const authProblem = claudeAuthProblem();
    if (authProblem) throw new BrainError("setup", authProblem);
    const env = claudeCliEnv(options.model, subprocessEnv({ cwd, home: HOME_DIR, conversationKey: options.abortKey }));
    const proc = runtime.spawn({ cmd: [claudePath(), ...claudeCliArgs({ model: options.model, effort: options.effort, system })], cwd, env });
    started++;
    const s: Session = { proc, expected: false, exited: false, lastTotal: 0, sink: null };
    try {
      s.entry = registerEngineCall(
        options.abortKey,
        proc,
        () => {
          // /stop oder Herunterfahren: Gespräch endet, keine Wiederbelebung, der laufende Turn liefert nichts mehr
          ended = "Gespräch beendet (gestoppt)";
          const turn = active ?? lastTurn;
          if (turn) stopTurn(turn, new BrainError("ended", ended));
          kill(s);
          s.sink?.crash();
        },
        // Nur während eines Turns zählt die Sitzung als Verarbeitung (Issue #257)
        { busy: () => active !== null },
      );
    } catch (err) {
      runtime.terminate(proc);
      throw err;
    }
    session = s;
    if (proc.stderr) void new Response(proc.stderr).text().catch(() => "");
    void readLines(s);
    proc.exited.then(
      () => onExit(s),
      () => onExit(s),
    );
    return s;
  };

  const onExit = (s: Session) => {
    s.exited = true;
    if (s.entry) unregisterEngineCall(options.abortKey, s.entry);
    s.entry = undefined;
    if (session === s) session = null;
    // Im Leerlauf gestorben (kein Turn, nicht von tybo beendet): zählt wie ein Absturz
    if (!s.expected && !s.sink && !s.turnCrash) {
      crashes++;
      if (crashes >= 2) ended = "Claude-Sitzung zweimal hintereinander abgestürzt";
    }
    // Erst den Rest von stdout lesen lassen; endet stdout nicht (Enkelprozess hält die Pipe), nach 1 s trotzdem
    const late = setTimeout(() => s.sink?.crash(), 1_000);
    (late as { unref?: () => void }).unref?.();
  };

  const readLines = async (s: Session) => {
    const reader = s.proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (line) handleLine(s, line);
        }
      }
    } catch {
      // Lesefehler wie Prozessende behandeln
    }
    s.sink?.crash();
  };

  const handleLine = (s: Session, line: string) => {
    let ev: any;
    try {
      ev = JSON.parse(line);
    } catch {
      return;
    }
    if (ev?.type === "stream_event") {
      const e = ev.event;
      if (e?.type === "content_block_delta" && e.delta?.type === "text_delta" && typeof e.delta.text === "string") s.sink?.text(e.delta.text);
    } else if (ev?.type === "result") {
      const usage = claudeUsage(ev.usage);
      recordRun({
        // Fehler wie die CLI ihn meldet: is_error, ein subtype außer success oder api_error_status
        isError: isCliResultError(ev),
        text: resultErrorText(ev),
        ...sessionCostStep(s, ev.total_cost_usd),
        ...(usage ? { usage } : {}),
      });
      s.sink?.result(ev);
    }
  };

  const interrupt = (): Promise<void> => {
    if (active) return interruptTurn(active);
    // Turn hat sein result schon, runVoiceTurn spricht vielleicht noch den Rest: nur dort beenden, keine Steuerzeile
    if (lastTurn) stopTurn(lastTurn, abortError());
    return pendingInterrupt ?? Promise.resolve();
  };

  /** Unterbrechen: Turn beenden, dann die Sitzung bitten, ihn zu beenden (höchstens 2 s) */
  const interruptTurn = (turn: ActiveTurn, reason: unknown = abortError()): Promise<void> => {
    stopTurn(turn, reason);
    // Steuerzeile nur einmal, nur an eine laufende Sitzung und nur, solange der Turn noch kein result hat
    const s = turn.session;
    if (turn.controlSent || turn.finished || !s || s.exited || ended) return pendingInterrupt ?? turn.done;
    turn.controlSent = true;
    try {
      s.proc.stdin.write(JSON.stringify({ type: "control_request", request_id: `int_${crypto.randomUUID()}`, request: { subtype: "interrupt" } }) + "\n");
      s.proc.stdin.flush?.();
    } catch {
      // stdin zu: der Prozess ist weg, das Zeitlimit räumt auf
    }
    const done = turn.done;
    let timer: unknown;
    const waited = new Promise<void>((resolve) => {
      timer = runtime.setTimeout(() => {
        // Kein result binnen 2 s: Prozess beenden, der nächste Turn startet neu
        kill(s);
        turn.resolveDone();
        resolve();
      }, INTERRUPT_GRACE_MS);
      done.then(() => resolve());
    }).then(() => runtime.clearTimeout(timer));
    const pending: Promise<void> = waited.then(() => {
      if (pendingInterrupt === pending) pendingInterrupt = null;
    });
    pendingInterrupt = pending;
    return pending;
  };

  async function* stream(call: BrainCall): AsyncGenerator<{ text: string }> {
    // Ab hier ist das der laufende Turn: interrupt(), /stop und close() treffen ihn
    // auch während der Wartezeit und der Flag-Prüfung
    const turn = newTurn(call);
    active = turn;
    lastTurn = turn;
    // Abbruch über das Signal wirkt wie interrupt(); ein BrainError als Grund (etwa von runVoiceTurn weitergereicht) beendet nur
    const onCallAbort = () => {
      const reason = call.signal?.reason ?? abortError();
      if (reason instanceof BrainError) stopTurn(turn, reason);
      else void interruptTurn(turn, reason);
    };
    if (call.signal?.aborted) onCallAbort();
    else call.signal?.addEventListener("abort", onCallAbort, { once: true });
    turn.cancel.signal.addEventListener("abort", () => turn.notify(), { once: true });
    /** Abgebrochen: mit dem Grund des Abbruchs enden (BrainError "ended" nach /stop und close(), sonst AbortError) */
    const throwIfStopped = () => {
      if (!turn.cancel.signal.aborted) return;
      const reason = turn.cancel.signal.reason;
      throw reason instanceof BrainError ? reason : abortError();
    };
    try {
      if (pendingInterrupt) await pendingInterrupt;
      if (ended) throw new BrainError("ended", ended);
      throwIfStopped();
      const last = call.messages[call.messages.length - 1];
      if (!last || last.role !== "user") throw new BrainError("api", "Keine Äußerung im Turn");
      const history = call.messages.slice(0, -1);

      if (!flagsChecked) {
        const check = await checkCliFlags(runtime);
        if (check === null) throw new BrainError("setup", "Claude Code ließ sich nicht prüfen (claude --help lief nicht)");
        if (check.missing.length) throw new BrainError("setup", `Claude Code kennt diese Flags nicht: ${check.missing.join(", ")} (Claude Code aktualisieren)`);
        flagsChecked = true;
      }

      let yielded = false;
      while (true) {
        // Während Warten, Prüfung oder vor dem Neustart abgebrochen oder beendet: nichts starten, nichts senden, nichts reservieren
        if (ended) throw new BrainError("ended", ended);
        throwIfStopped();
        // Neuer Prozess nach Absturz oder Zeitlimit beim Unterbrechen: mit dem Verlauf als Anhang
        const s = session && !session.exited ? session : start(call.system + (started > 0 ? restartAppendix(history, options.agentName) : ""));

        const settle = (() => {
          if (!options.reserveRequest) return undefined;
          try {
            return options.reserveRequest();
          } catch (err) {
            throw new BrainError("budget", err instanceof Error ? err.message : String(err));
          }
        })();
        let settled = false;
        const settleOnce = () => {
          if (settled) return;
          settled = true;
          settle?.();
        };

        // Ein Versuch dieses Turns in dieser Sitzung
        turn.attempt(s);
        let outcome: { kind: "result"; ev: any } | { kind: "crash" } | null = null;
        const finish = (o: NonNullable<typeof outcome>) => {
          s.sink = null;
          outcome = o;
          turn.finished = true;
          turn.resolveDone();
          turn.notify();
        };
        s.sink = {
          text: (t) => {
            if (turn.cancel.signal.aborted) return;
            turn.queue.push(t);
            turn.notify();
          },
          result: (ev) => finish({ kind: "result", ev }),
          crash: () => {
            if (outcome) return;
            s.turnCrash = true;
            finish({ kind: "crash" });
          },
        };

        try {
          try {
            s.proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: last.content }] } }) + "\n");
            s.proc.stdin.flush?.();
          } catch {
            s.sink?.crash();
          }
          // Ausgabe: vor jedem Stück nur den einen Zustand des Turns prüfen
          while (!turn.cancel.signal.aborted) {
            if (turn.queue.length) {
              yielded = true;
              yield { text: turn.queue.shift()! };
              continue;
            }
            if (outcome) break;
            await turn.wait();
          }
          const result = outcome as { kind: "result"; ev: any } | { kind: "crash" } | null;
          if (turn.cancel.signal.aborted) {
            // Unterbrochen, gestoppt oder geschlossen: error_during_execution oder das
            // Beenden nach dem Zeitlimit sind erwartet, kein Fehler und kein Absturz
            settleOnce();
            if (result?.kind === "crash") kill(s);
            throwIfStopped();
          }
          if (result?.kind === "result") {
            settleOnce();
            if (result.ev.is_error || (result.ev.subtype && result.ev.subtype !== "success")) {
              throw new BrainError("api", `Claude Code: ${String(result.ev.result || result.ev.subtype || "Fehler").slice(0, 200)}`);
            }
            crashes = 0;
            return;
          }
          // Absturz
          settleOnce();
          if (ended) throw new BrainError("ended", ended);
          kill(s);
          crashes++;
          if (crashes >= 2) {
            ended = "Claude-Sitzung zweimal hintereinander abgestürzt";
            throw new BrainError("network", ended);
          }
          if (yielded) throw new BrainError("network", "Claude-Sitzung abgestürzt, sie startet beim nächsten Satz neu");
          // Noch nichts gesprochen: dieselbe Äußerung im neuen Prozess
        } finally {
          settleOnce();
          // Verbraucher hört vorzeitig auf (return() mitten im Turn): wie ein Unterbrechen.
          // Nach /stop oder close() ist die Sitzung schon beendet, dann keine Steuerzeile
          if (!outcome && !(turn.cancel.signal.reason instanceof BrainError)) void interruptTurn(turn);
        }
      }
    } finally {
      call.signal?.removeEventListener("abort", onCallAbort);
      // active bleibt, bis die Sitzung den Turn beendet hat (result oder Zeitlimit)
      if (active === turn) {
        if (turn.finished || !turn.session) active = null;
        else
          void turn.done.then(() => {
            if (active === turn) active = null;
          });
      }
    }
  }

  /** Sitzung vorab starten (Issue #257); wirft BrainError setup bzw. ended wie stream() */
  async function prepare(system: string): Promise<void> {
    if (ended) throw new BrainError("ended", ended);
    if (!flagsChecked) {
      const check = await checkCliFlags(runtime);
      if (check === null) throw new BrainError("setup", "Claude Code ließ sich nicht prüfen (claude --help lief nicht)");
      if (check.missing.length) throw new BrainError("setup", `Claude Code kennt diese Flags nicht: ${check.missing.join(", ")} (Claude Code aktualisieren)`);
      flagsChecked = true;
    }
    if (ended) throw new BrainError("ended", ended);
    if (!session || session.exited) start(system);
  }

  return {
    id: "claude-cli",
    label: `Claude Code, offene Sitzung (${options.model})`,
    stream,
    prepare,
    interrupt,
    close() {
      ended = ended ?? "Gespräch beendet";
      const turn = active ?? lastTurn;
      if (turn) stopTurn(turn, new BrainError("ended", ended));
      if (session) {
        try {
          session.proc.stdin.end?.();
        } catch {
          // schon zu
        }
        kill(session);
      }
    },
  };
}
