/**
 * Claude Code als Unterprozess (`claude -p`). Drei Wege, alle über den
 * Prozesskern in src/lib/claude/process.ts:
 *
 * - callClaude: JSON (mit --verbose als Ereignisliste) oder Text
 * - callClaudeStreaming: stream-json mit Fortschritt; jede Zeile wertet der
 *   Leser in src/lib/claude/stream.ts aus, hier werden nur seine Signale
 *   ausgeführt und das Ergebnis beurteilt
 * - runClaudeWithTimeout: Rohtext für Dienste wie den Check-in
 *
 * Fehler-Auswertung: src/lib/claude/result.ts. Plattform (Schlafsperre,
 * Home-Verzeichnis): src/lib/engines/platform.ts.
 *
 * Kosten bucht dieses Modul nicht (Issue #346): costUsd geht an den
 * Aufrufer, der den Lauf über src/lib/spend/credit.ts bucht.
 *
 * Anmeldung (Issue #349): ANTHROPIC_API_KEY kommt in allen drei Wegen nur
 * über subprocessEnv, also nach CLAUDE_AUTH (src/lib/engines/claude-auth.ts).
 * Ist apiKey eingestellt, aber kein Schlüssel da, startet kein Prozess:
 * callClaude und callClaudeStreaming liefern ein Fehlerergebnis (der übliche
 * Fallback greift), runClaudeWithTimeout wirft.
 */

import { spawn } from "bun";
import { DEFAULT_CLAUDE_MODEL } from "./default-model";
import { claudeAuthProblem } from "./engines/claude-auth";
import { abortAllEngineCalls, abortEngineCalls, activeEngineCallCount } from "./engines/calls";
import { homeDirectory, keepAwakeCommand } from "./engines/platform";
import { toolLabel } from "./engines/tool-labels";
import { checkAborted, currentExecution } from "./execution-context";
import { terminateProcessTree } from "./process-tree";
import { StreamPhaseTracker, stallPhaseLogText, type StallPhase } from "./stream-phase";
import { PRINT_MODE_DISALLOWED_TOOLS, subprocessEnv } from "./subprocess-env";
import { toolUsesFromEvent, type TurnTools } from "./turn-tools";
import { runClaudeProcess, STOP_GRACE_MS, type ClaudeProcessOutcome, type ClaudeRuntime } from "./claude/process";
import { isClaudeErrorResponse, judgeClaudeResult } from "./claude/result";
import {
  finishStreamReading,
  parseStreamLine,
  readStreamEvent,
  startStreamReading,
  type RunStep,
  type StreamOutcome,
} from "./claude/stream";

export { conversationEnv } from "./subprocess-env";
export { IDLE_CHECK_INTERVAL_MS } from "./claude/process";
export { hasCliSignal, isClaudeErrorResponse, isCliResultError, isCreditLimitError } from "./claude/result";
export { firstTextSnippet, MAX_RUN_STEPS, type RunStep } from "./claude/stream";

// ---------------------------------------------------------------------------
// Schnittstelle
// ---------------------------------------------------------------------------

/** Anfrage an einen Claude-Aufruf */
export interface ClaudeOptions {
  /** Eingabe für Claude, geht über stdin, nie über die Kommandozeile */
  prompt: string;
  /** Ausgabe von callClaude; ohne Angabe Text */
  outputFormat?: "json" | "text";
  /** Fortgesetzte Session (--resume) */
  resumeSessionId?: string;
  /** Modell; ohne Angabe DEFAULT_CLAUDE_MODEL */
  model?: string;
  /** Denkaufwand (low, medium, high, xhigh); ohne Angabe defaultEffort(model) */
  effort?: string;
  /** Freigegebene Werkzeuge (--allowedTools) */
  allowedTools?: string[];
  /** Höchstzahl Turns (--max-turns), als Text wie auf der Kommandozeile */
  maxTurns?: string;
  /** Arbeitsverzeichnis; ohne Angabe das des Bot-Prozesses */
  cwd?: string;
  /** Obergrenze der Gesamtzeit; ohne Angabe fünf Minuten */
  timeoutMs?: number;
  /** Schlüssel im Abbruch-Register, meist der Session-Schlüssel des Topics: /stop beendet den Aufruf darüber */
  abortKey?: string;
  /**
   * Keine eigene Log-Zeile bei Zeitüberschreitung (Issue #290): der Aufrufer
   * schreibt selbst genau eine Zeile, etwa callAux mit quiet.
   */
  quiet?: boolean;
}

/** Anfrage an callClaudeStreaming: dazu Fortschritt und Leerlauf-Grenze */
export interface ClaudeStreamOptions extends ClaudeOptions {
  /** Ein Werkzeug startet; Anzeigename auf Deutsch, höchstens alle fünf Sekunden */
  onToolStart?: (label: string) => void;
  /**
   * Der erste Textblock über 30 Zeichen (meist der Plan), einmal je Aufruf:
   * Kurzfassung und der ungekürzte Block, aus dem sie stammt.
   */
  onFirstText?: (snippet: string, fullText: string) => void;
  /**
   * Leerlauf-Grenze (Issue #178): kommt so lange keine gültige stream-json-
   * Zeile, wird der Prozessbaum beendet (timeoutKind "idle"). Ohne Angabe gilt
   * nur timeoutMs.
   */
  idleTimeoutMs?: number;
}

/** Ergebnis eines Claude-Aufrufs */
export interface ClaudeResult {
  /** Antworttext; leer bei Abbruch und Zeitlimit */
  text: string;
  isError: boolean;
  /** Session für ein späteres --resume */
  sessionId?: string;
  /**
   * Kosten laut CLI in US-Dollar, falls gemeldet. Beim Strom die Summe aller
   * result-Ereignisse des Aufrufs, auch nach Abbruch, Zeitlimit oder
   * Lesefehler (was bis dahin gemeldet war).
   */
  costUsd?: number;
  /**
   * Über das Abbruch-Register beendet (/stop): kein Fehler im üblichen Sinn,
   * also kein Rückfall-Modell und kein Neuversuch mit frischer Session.
   */
  aborted?: boolean;
  /**
   * Zeitlimit gegriffen, Prozessbaum beendet. Die Arbeit des Laufs ist
   * verloren; ein Neuversuch würde nur ein weiteres Zeitfenster kosten.
   */
  timedOut?: boolean;
  /**
   * Nur callClaudeStreaming (Issue #178): "idle", wenn länger als
   * idleTimeoutMs keine Zeile kam, "total" für die Obergrenze timeoutMs.
   */
  timeoutKind?: "idle" | "total";
  /**
   * Werkzeuge des Aufrufs (Issue #53) aus stream-json bzw. json mit
   * --verbose. Fehlt, wenn die CLI nichts dazu lieferte (Textformat, altes
   * json-Format): dann sind sie unbekannt, nicht leer.
   */
  tools?: TurnTools;
  /**
   * Nur Streaming mit timedOut (Issue #179): die letzten Werkzeugschritte,
   * höchstens MAX_RUN_STEPS. Die Eingabe ist ungekürzt, damit Geheimnisse vor
   * jeder Kürzung maskiert werden können; gekürzt wird erst im Bericht.
   */
  steps?: RunStep[];
  /** Nur Streaming mit timedOut: der letzte Textblock, ungekürzt */
  lastText?: string;
  /** Nur Streaming mit timedOut: Laufzeit bis zum Abbruch */
  stoppedAfterMs?: number;
  /** Nur Streaming mit timedOut: Zeit seit der letzten gültigen Zeile */
  idleForMs?: number;
  /** Nur Streaming mit timedOut: wo der Lauf hing (Start, API, Modell, Werkzeug) */
  stallPhase?: StallPhase;
}

/** Zusätzliche Angaben für runClaudeWithTimeout */
export interface PlainClaudeRunOptions {
  /** Freigegebene Werkzeuge (--allowedTools) */
  allowedTools?: string[];
  /** Arbeitsverzeichnis; ohne Angabe das des Bot-Prozesses */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Einstellungen und Testzugänge
// ---------------------------------------------------------------------------

/** Programm der Claude-CLI; die Umgebungsvariable CLAUDE_PATH ersetzt es */
const cliProgram = process.env.CLAUDE_PATH || "claude";
const homeDir = homeDirectory();
/** Gesamtzeit eines Aufrufs ohne eigene Angabe: fünf Minuten */
const DEFAULT_CALL_TIMEOUT_MS = 5 * 60_000;

/**
 * Denkaufwand ohne eigene Angabe: CLAUDE_EFFORT, sonst high für Opus und
 * Fable (seit dem Wechsel auf Opus 5.5 am 22.9.2026, vorher xhigh); bei
 * anderen Modellen entscheidet die CLI.
 */
export function defaultEffort(model: string): string | undefined {
  const fromEnv = process.env.CLAUDE_EFFORT;
  if (fromEnv) return fromEnv;
  const strongModel = model.includes("opus") || model.includes("fable");
  return strongModel ? "high" : undefined;
}

/** Prozessstart; nur Tests ersetzen ihn (setSpawnForTests), nie global process.env */
let startProcess: typeof spawn = spawn;

/** Nur für Tests: Prozessstart durch eine Attrappe ersetzen, null stellt zurück. */
export function setSpawnForTests(fn: typeof spawn | null): void {
  startProcess = fn ?? spawn;
}

/**
 * Uhr, Timer und Prozessbeendigung (Issue #178). Nur Tests ersetzen sie
 * (setRuntimeForTests): eine Attrappe mit pid 0 darf nie echt beendet werden,
 * process.kill(-0) träfe die eigene Prozessgruppe.
 */
type ClaudeClock = Omit<ClaudeRuntime, "spawn">;

const realClock: ClaudeClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  terminate: terminateProcessTree,
  stopGraceMs: STOP_GRACE_MS,
};

let clock: ClaudeClock = realClock;

/** Nur für Tests: Uhr, Timer und Prozessbeendigung ersetzen, null stellt zurück. */
export function setRuntimeForTests(r: Partial<ClaudeClock> | null): void {
  clock = r ? { ...realClock, ...r } : realClock;
}

function runtime(): ClaudeRuntime {
  return { ...clock, spawn: startProcess };
}

// ---------------------------------------------------------------------------
// Abbruch-Register (/stop): seit Issue #121 für alle Motoren in
// src/lib/engines/calls.ts; die Claude-Namen bleiben als Aliase.
// ---------------------------------------------------------------------------

/** Alias von abortEngineCalls (src/lib/engines/calls.ts) */
export const abortClaudeCalls = abortEngineCalls;
/** Alias von abortAllEngineCalls (src/lib/engines/calls.ts) */
export const abortAllClaudeCalls = abortAllEngineCalls;
/** Alias von activeEngineCallCount (src/lib/engines/calls.ts) */
export const activeClaudeCallCount = activeEngineCallCount;

// ---------------------------------------------------------------------------
// Kommandozeile und Umgebung
// ---------------------------------------------------------------------------

/** Schalter für claude -p, gemeinsam für JSON, Text und stream-json, in fester Reihenfolge */
function printModeFlags(format: "json" | "text" | "stream-json", o: ClaudeOptions, model: string): string[] {
  const level = o.effort ?? defaultEffort(model);
  // json mit --verbose liefert alle Ereignisse als Liste samt Werkzeugaufrufen
  // (Issue #53); stream-json braucht --verbose ohnehin, die Teil-Nachrichten
  // halten den Leerlauf-Wächter wach und zeigen beim Zeitlimit, wo es hing
  const verbose = format === "json" ? ["--verbose"] : format === "stream-json" ? ["--verbose", "--include-partial-messages"] : [];
  return [
    "-p", "--output-format", format, ...verbose, "--model", model,
    ...(level ? ["--effort", level] : []),
    ...(o.allowedTools && o.allowedTools.length > 0 ? ["--allowedTools", o.allowedTools.join(",")] : []),
    // Werkzeuge, auf die claude -p nur warten würde (etwa Monitor), sind gesperrt
    "--disallowedTools", PRINT_MODE_DISALLOWED_TOOLS.join(","),
    ...(o.resumeSessionId ? ["--resume", o.resumeSessionId] : []),
    ...(o.maxTurns ? ["--max-turns", o.maxTurns] : []),
  ];
}

/**
 * Umgebung eines CLI-Subprozesses (Issue #54): ohne Geheimnisse außer den
 * Freigaben, ohne CLAUDECODE, mit TYBO_SUBPROCESS=1 und dem Gespräch des
 * laufenden Aufrufs. Hooks in .claude/settings.local.json prüfen auf
 * TYBO_SUBPROCESS: ein Stop-Hook brachte sonst in langen Sessions alte
 * Befunde zurück (9.9.2026). Den API-Schlüssel setzt subprocessEnv nach
 * CLAUDE_AUTH, für alle drei Wege gleich.
 */
function cliEnv(cwd: string): Record<string, string> {
  return { ...subprocessEnv({ cwd, home: homeDir, conversationKey: currentExecution()?.key }), HOME: homeDir, PATH: process.env.PATH || "" };
}

/** Lauf ohne verwertbare Ausgabe (Lese- oder Schreibfehler) */
const failedCall = (): ClaudeResult => ({ text: "", isError: true });

/** CLAUDE_AUTH=apiKey ohne Schlüssel: kein Prozess, ein Fehlerergebnis mit der Meldung; sonst null */
function blockedByAuth(): ClaudeResult | null {
  const problem = claudeAuthProblem();
  if (!problem) return null;
  console.error(`[Claude] Nicht gestartet: ${problem}`);
  return { text: problem, isError: true };
}

// ---------------------------------------------------------------------------
// callClaude
// ---------------------------------------------------------------------------

/**
 * Ein Claude-Aufruf mit JSON- oder Textausgabe. Zeitlimit, Abbruch und
 * Aufräumen übernimmt der Prozesskern; hier wird nur die Ausgabe gedeutet.
 */
export async function callClaude(request: ClaudeOptions): Promise<ClaudeResult> {
  const format = request.outputFormat ?? "text";
  const model = request.model ?? DEFAULT_CLAUDE_MODEL;
  const limitMs = request.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  const workDir = request.cwd || process.cwd();
  const blocked = blockedByAuth();
  if (blocked) return blocked;
  const run = await runClaudeProcess(
    {
      command: keepAwakeCommand([cliProgram, ...printModeFlags(format, request, model)]),
      cwd: workDir,
      env: cliEnv(workDir),
      input: request.prompt,
      timeoutMs: limitMs,
      abortKey: request.abortKey,
    },
    runtime()
  );
  if (run.aborted) return { text: "", isError: true, aborted: true };
  if (run.limit) {
    if (!request.quiet) console.error(`[Claude] Zeitlimit nach ${Math.round(limitMs / 1000)}s (Modell ${model}), Prozessbaum beendet`);
    return { text: "", isError: true, timedOut: true };
  }
  if (run.readError !== undefined || run.inputError !== undefined) return failedCall();
  if (format === "json") return jsonResult(run.stdout, workDir);
  // Textformat: kein CLI-Signal, nur das Textmuster
  return { text: run.stdout.trim(), isError: isClaudeErrorResponse(run.stdout) };
}

/** JSON aus der Ausgabe; undefined, wenn sie keins ist */
function parseJsonOutput(output: string): unknown {
  try {
    return JSON.parse(output);
  } catch {
    return undefined;
  }
}

/**
 * JSON-Ausgabe von callClaude: ein Objekt (altes Format) oder die
 * Ereignisliste von --verbose mit dem result-Ereignis. Kein gültiges JSON:
 * Textmuster auf die ganze Ausgabe.
 */
function jsonResult(output: string, cwd: string): ClaudeResult {
  const parsed: any = parseJsonOutput(output);
  if (parsed === undefined) return { text: output, isError: isClaudeErrorResponse(output) };
  const events: any[] | null = Array.isArray(parsed) ? parsed : null;
  const tools: TurnTools | undefined = events ? { uses: events.flatMap(toolUsesFromEvent), cwd } : undefined;
  const withTools = tools ? { tools } : {};
  const final = events ? events.find((e) => e?.type === "result") : parsed;
  if (!final) return { text: "", isError: true, ...withTools };
  const cost = typeof final.total_cost_usd === "number" ? final.total_cost_usd : undefined;
  // Im Listenformat nie die ganze Ereignisliste als Antworttext
  const text = final.result || (events ? "" : output);
  const isError = judgeClaudeResult(final, String(text));
  return { text, sessionId: final.session_id, isError, costUsd: cost, ...withTools };
}

// ---------------------------------------------------------------------------
// runClaudeWithTimeout
// ---------------------------------------------------------------------------

/**
 * Claude im Textformat für Dienste (Check-in): liefert die Ausgabe roh, wirft
 * bei Zeitlimit Error("Timeout"), bei abgebrochener Ausführung AbortError,
 * bei CLAUDE_AUTH=apiKey ohne Schlüssel einen Error mit der Meldung (ohne
 * Prozess). Ohne Modell.
 */
export async function runClaudeWithTimeout(prompt: string, timeoutMs: number, extra: PlainClaudeRunOptions = {}): Promise<string> {
  const workDir = extra.cwd || process.cwd();
  const problem = claudeAuthProblem();
  if (problem) throw new Error(problem);
  const toolFlags = extra.allowedTools ? ["--allowedTools", extra.allowedTools.join(",")] : [];
  const flags = ["-p", "--output-format", "text", ...toolFlags, "--disallowedTools", PRINT_MODE_DISALLOWED_TOOLS.join(",")];
  const run = await runClaudeProcess(
    { command: keepAwakeCommand([cliProgram, ...flags]), cwd: workDir, env: cliEnv(workDir), input: prompt, timeoutMs },
    runtime()
  );
  if (run.readError !== undefined) throw run.readError;
  checkAborted();
  if (run.limit) throw new Error("Timeout");
  if (run.inputError !== undefined) throw run.inputError;
  return run.stdout;
}

// ---------------------------------------------------------------------------
// callClaudeStreaming
// ---------------------------------------------------------------------------

/**
 * Claude mit stream-json und Fortschritt. Jede gültige Zeile ist ein
 * Lebenszeichen (Issue #178) und geht an den Phasen-Tracker und den Leser;
 * dessen Signale werden hier ausgeführt: Werkzeug und erster Text als
 * Fortschritt. Die Kosten sammelt der Leser und liefert sie im Ergebnis.
 */
export async function callClaudeStreaming(request: ClaudeStreamOptions): Promise<ClaudeResult> {
  const model = request.model ?? DEFAULT_CLAUDE_MODEL;
  const workDir = request.cwd || process.cwd();
  const blocked = blockedByAuth();
  if (blocked) return blocked;
  let reading = startStreamReading();
  // Die CLI schickt auch während langer Werkzeuge alle 30 s tool_progress,
  // beim Generieren kommen die stream_event-Deltas dazu: ein arbeitender Lauf
  // ist nie still
  const phase = new StreamPhaseTracker(clock.now());

  const onLine = (line: string, alive: () => number) => {
    const event = parseStreamLine(line);
    if (!event) return;
    const at = alive();
    phase.observe(event, at);
    const step = readStreamEvent(reading, event, at);
    reading = step.reading;
    for (const signal of step.signals) {
      if (signal.kind === "tool") request.onToolStart?.(toolLabel(signal.name));
      else request.onFirstText?.(signal.snippet, signal.text);
    }
  };

  const run = await runClaudeProcess(
    {
      command: keepAwakeCommand([cliProgram, ...printModeFlags("stream-json", request, model)]),
      cwd: workDir,
      env: cliEnv(workDir),
      input: request.prompt,
      timeoutMs: request.timeoutMs ?? DEFAULT_CALL_TIMEOUT_MS,
      idleTimeoutMs: request.idleTimeoutMs,
      abortKey: request.abortKey,
      onLine,
    },
    runtime()
  );

  const outcome = finishStreamReading(reading);
  // Bis hierher gemeldete Kosten gehen auch bei Abbruch, Zeitlimit und Lesefehler mit
  const spent = outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {};
  if (run.aborted) return { text: "", isError: true, aborted: true, ...spent };
  const tools: TurnTools = { uses: outcome.uses, cwd: workDir };
  // Auch ein Lesefehler nach dem Zeitlimit bleibt ein Zeitlimit: sonst
  // startete chat-turn einen frischen Resume-Versuch mit neuem Zeitfenster
  if (run.limit) return { ...timeoutResult(run, outcome, tools, phase, model), ...spent };
  if (run.readError !== undefined || run.inputError !== undefined) {
    console.error("[Claude streaming] Fehler:", run.readError ?? run.inputError);
    if (run.stderr) console.error("[Claude streaming] stderr:", run.stderr.substring(0, 500));
    return { ...failedCall(), ...spent };
  }

  if (outcome.joinedTurns) {
    console.error(`[Claude streaming] ${outcome.joinedTurns} fertige Turns in einem Aufruf (Hook?), alle weitergegeben`);
  }
  const length = outcome.text ? `${outcome.text.length} Zeichen` : "LEER";
  console.error(`[Claude streaming] Ergebnis: text=${length}, sessionId=${outcome.sessionId || "keine"}`);
  if (run.stderr) console.error("[Claude streaming] stderr:", run.stderr.substring(0, 500));

  // CLI-Signal zuerst, das Textmuster nur ohne Signal (src/lib/claude/result.ts)
  const isError = judgeClaudeResult(outcome.signal, outcome.text);
  return { text: outcome.text, sessionId: outcome.sessionId, isError, costUsd: outcome.costUsd, tools };
}

/** Ergebnis beim Zeitlimit: Stand des Laufs für den Bericht (Issue #179) */
function timeoutResult(
  run: ClaudeProcessOutcome,
  outcome: StreamOutcome,
  tools: TurnTools,
  phase: StreamPhaseTracker,
  model: string
): ClaudeResult {
  const at = run.limitAt ?? clock.now();
  const stoppedAfterMs = at - run.startedAt;
  const idleForMs = at - run.lastActivityAt;
  const stallPhase = phase.snapshot(at);
  console.error(
    `[Claude streaming] Zeitlimit (${run.limit}) nach ${Math.round(stoppedAfterMs / 1000)}s, ` +
      `letztes Lebenszeichen vor ${Math.round(idleForMs / 1000)}s, Phase: ${stallPhaseLogText(stallPhase)} ` +
      `(Modell ${model}), sessionId=${outcome.sessionId || "keine"}, Prozessbaum beendet`
  );
  if (run.stderr) console.error("[Claude streaming] stderr (Zeitlimit):", run.stderr.substring(0, 500));
  return {
    text: "",
    sessionId: outcome.sessionId,
    isError: true,
    timedOut: true,
    timeoutKind: run.limit,
    tools,
    steps: outcome.steps,
    ...(outcome.lastText ? { lastText: outcome.lastText } : {}),
    stoppedAfterMs,
    idleForMs,
    stallPhase,
  };
}
