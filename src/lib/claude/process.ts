/**
 * Prozesskern der Claude-CLI (Issue #325): ein Ablauf für callClaude,
 * callClaudeStreaming und runClaudeWithTimeout. Startet den Prozess in eigener
 * Prozessgruppe, meldet ihn im Abbruch-Register an, überwacht Gesamtzeit und
 * optional Leerlauf, übergibt den Prompt über stdin und liest stdout als
 * Ganzes oder Zeile für Zeile. Was das Ergebnis bedeutet, entscheiden die
 * Aufrufer in src/lib/claude.ts.
 *
 * Reihenfolge mit Absicht: erst Anmeldung und Zeitlimits, dann stdin. So
 * beendet auch eine hängende Prompt-Übergabe den Lauf, und /stop greift
 * schon währenddessen. Wann der Lauf abgeschlossen ist, entscheidet der
 * Zustandsautomat in engines/lifecycle.ts: wenn stdout, stderr und das
 * Prozessende da sind, nach einem Beenden (Zeitlimit, /stop, Schreib- oder
 * Lesefehler) spätestens nach stopGraceMs. Bis dahin bleiben Zeitlimits und
 * Register-Eintrag bestehen, danach werden sie in jedem Ausgang entfernt.
 */

import type { spawn } from "bun";
import { abortError, checkAborted } from "../execution-context";
import { registerEngineCall, unregisterEngineCall, type EngineCallEntry, type EngineProc } from "../engines/calls";
import { createLineReader } from "../engines/lines";
import { superviseRun, type RunControl } from "../engines/lifecycle";
import { startsOwnGroup } from "../engines/platform";

/** Wie oft die Leerlauf-Grenze geprüft wird (höchstens; bei kürzerer Grenze öfter) */
export const IDLE_CHECK_INTERVAL_MS = 15_000;

/**
 * Prozessstart, Uhr, Timer und Prozessbeendigung. Tests ersetzen sie: eine
 * Attrappe mit pid 0 darf nie ein echtes Signal bekommen.
 */
export interface ClaudeRuntime {
  spawn: typeof spawn;
  now: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (handle: unknown) => void;
  terminate: (proc: EngineProc) => void;
  /** So lange wird nach dem Beenden höchstens noch auf stdout, stderr und das Prozessende gewartet */
  stopGraceMs: number;
  /** Betriebssystem: entscheidet über Wachhalten (caffeinate) und eigene Prozessgruppe; Tests setzen es */
  os: NodeJS.Platform;
}

/** Wartezeit nach dem Beenden: deutlich länger als der SIGKILL-Nachlauf (1,5 Sekunden) */
export const STOP_GRACE_MS = 5_000;

export interface ClaudeProcessSpec {
  /** Vollständige Befehlszeile, schon mit Wachhalten */
  command: string[];
  cwd: string;
  env: Record<string, string>;
  /** Prompt, geht über stdin (keine Längengrenze der Kommandozeile) */
  input: string;
  timeoutMs: number;
  /** Leerlauf-Grenze; nur mit onLine sinnvoll, ohne Angabe oder 0 keine */
  idleTimeoutMs?: number;
  /** Schlüssel im Abbruch-Register; ohne Angabe die laufende Ausführung */
  abortKey?: string;
  signal?: AbortSignal;
  quiet?: boolean;
  /**
   * Zeilenweise lesen. Der Parser ruft alive() für jede gültige, vollständige
   * Zeile auf; nur das zählt als Lebenszeichen, nicht leere oder kaputte
   * Zeilen. alive() liefert den Zeitpunkt. Ohne onLine wird stdout als Ganzes
   * gelesen. Nach einem Zeitlimit kommen keine Zeilen mehr.
   */
  onLine?: (line: string, alive: () => number) => void;
}

export interface ClaudeProcessOutcome {
  /** stdout als Ganzes; beim zeilenweisen Lesen leer */
  stdout: string;
  /** Über das Abbruch-Register beendet (/stop, Shutdown, Ausführung abgebrochen) */
  aborted: boolean;
  /** Welche Grenze griff; fehlt, wenn keine griff oder vorher abgebrochen wurde */
  limit?: "total" | "idle";
  /** Prompt konnte nicht übergeben werden (Prozess wurde beendet) */
  inputError?: unknown;
  /** Lesen von stdout oder ein Zeilen-Rückruf ist gescheitert */
  readError?: unknown;
  startedAt: number;
  /** Zeitpunkt, an dem die Grenze griff */
  limitAt?: number;
  /** Letztes Lebenszeichen (Start, sonst letzte gültige Zeile) */
  lastActivityAt: number;
  /** stderr, parallel gelesen, so weit bis zum Abschluss gekommen; leer bei Lesefehler auf stderr */
  stderr: string;
  /** Exit-Code des Prozesses; null, wenn unbekannt (Signal, nicht abgewartet, nie gestartet) */
  exitCode: number | null;
  /**
   * Der Start selbst ist gescheitert (Issue #565), etwa ENOENT, weil das
   * Programm nicht im PATH liegt. Dann lief nichts: kein Register-Eintrag,
   * keine Zeitlimits, stdout und stderr leer.
   */
  startError?: unknown;
}

/**
 * Ein Lauf der Claude-CLI. Wirft nur, wenn die Ausführung schon vor dem Start
 * oder bis zur Anmeldung abgebrochen wurde (AbortError); ein bereits
 * gestarteter Prozess wird dann beendet. Scheitert der Start selbst (unter
 * Linux etwa ENOENT, wenn claude nicht im PATH liegt), kommt ein Ergebnis mit
 * startError zurück (Issue #565), kein Wurf.
 */
export async function runClaudeProcess(spec: ClaudeProcessSpec, rt: ClaudeRuntime): Promise<ClaudeProcessOutcome> {
  checkAborted();
  if (spec.signal?.aborted) throw abortError();
  const start = () =>
    rt.spawn({
      detached: startsOwnGroup(rt.os),
      cmd: spec.command,
      cwd: spec.cwd,
      env: spec.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
  let proc: ReturnType<typeof start>;
  try {
    proc = start();
  } catch (err) {
    const at = rt.now();
    return { stdout: "", aborted: false, startedAt: at, lastActivityAt: at, stderr: "", exitCode: null, startError: err };
  }
  const terminate = () => {
    try {
      rt.terminate(proc);
    } catch {}
  };

  // Ein Abbruch über das Register ist ein stop() wie jedes andere: höchstens
  // einmal beendet, danach begrenzt gewartet
  let run: RunControl | undefined;
  let entry: EngineCallEntry;
  try {
    entry = registerEngineCall(spec.abortKey, proc, () => void run?.stop("abort"));
  } catch (err) {
    // Zwischen Start und Anmeldung abgebrochen: Prozess nicht verwaist lassen
    terminate();
    throw err;
  }

  const startedAt = rt.now();
  let lastActivityAt = startedAt;
  let limitAt: number | undefined;
  let inputError: unknown;
  const limited = () => run!.cause === "total" || run!.cause === "idle";

  // Nach einem Zeitlimit kommen keine Zeilen mehr
  const onLine = spec.onLine;
  const lines = onLine ? createLineReader((line) => onLine(line, () => (lastActivityAt = rt.now()))) : undefined;
  run = superviseRun(proc, {
    clock: rt,
    graceMs: rt.stopGraceMs,
    terminate,
    ...(lines
      ? {
          onChunk: (chunk: Uint8Array) => {
            if (!limited()) lines.push(chunk);
          },
          onEnd: () => {
            if (!limited()) lines.end();
          },
        }
      : {}),
  });
  const control = run;
  const onAbort = () => { entry.aborted = true; control.stop("abort"); };
  spec.signal?.addEventListener("abort", onAbort, { once: true });
  if (spec.signal?.aborted) onAbort();

  const hitLimit = (kind: "total" | "idle") => {
    const at = rt.now();
    if (control.stop(kind)) limitAt = at;
  };
  const totalTimer = rt.setTimeout(() => hitLimit("total"), spec.timeoutMs);
  const idleMs = spec.idleTimeoutMs;
  const idleTimer =
    idleMs && idleMs > 0
      ? rt.setInterval(() => {
          if (rt.now() - lastActivityAt >= idleMs) hitLimit("idle");
        }, Math.min(IDLE_CHECK_INTERVAL_MS, idleMs))
      : undefined;

  // Prompt übergeben, ohne darauf zu warten: scheitert es (sofort oder als
  // spätere Ablehnung, etwa EPIPE), wird der Prozess beendet. Nach dem
  // Prozessende oder einem anderen Beenden bleibt ein Schreibfehler folgenlos:
  // die PID kann längst neu vergeben sein
  void (async () => {
    if (control.phase !== "running") return;
    await proc.stdin.write(spec.input);
    await proc.stdin.end();
  })().catch((err) => {
    if (control.exited || control.phase !== "running") return;
    inputError = err;
    if (!spec.quiet) console.error("[Claude] Prompt konnte nicht übergeben werden:", err instanceof Error ? err.message : String(err));
    control.stop("input");
  });

  let end: Awaited<RunControl["done"]>;
  try {
    end = await control.done;
  } finally {
    spec.signal?.removeEventListener("abort", onAbort);
    rt.clearTimeout(totalTimer);
    if (idleTimer !== undefined) rt.clearInterval(idleTimer);
    unregisterEngineCall(spec.abortKey, entry);
  }

  const limit = limited() ? (control.cause as "total" | "idle") : undefined;
  return {
    stdout: end.stdout,
    aborted: entry.aborted,
    ...(limit && !entry.aborted ? { limit, limitAt } : {}),
    ...(control.cause === "input" ? { inputError } : {}),
    ...("readError" in end ? { readError: end.readError } : {}),
    startedAt,
    lastActivityAt,
    stderr: end.stderr,
    exitCode: end.exitCode,
  };
}
