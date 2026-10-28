/**
 * Abschluss eines Motor-Prozesses (Issue #325, Entscheidung A), gemeinsam
 * für Claude, Codex und OpenCode: ein Zustandsautomat mit genau einem
 * Abschluss.
 *
 * Zustände: running (läuft), stopping (beendet, mit Ursache) und settled
 * (abgeschlossen). Ein Lauf schließt ab, sobald stdout, stderr und das
 * Prozessende alle da sind. Das erste stop() setzt die Ursache, beendet den
 * Prozessbaum und startet einmal die Frist für alles weitere Warten. Läuft
 * sie ab, beendet cancel() beide Leser und der Lauf schließt trotzdem ab,
 * egal welches Ereignis noch fehlt: Kinder, die die Prozessgruppe verlassen
 * haben, können stdout oder stderr beliebig lange offen halten, und ob die
 * Signale wirken, entscheidet hier nichts mehr.
 *
 * stdout und stderr werden über getReader() gelesen, stderr von Anfang an
 * parallel, damit eine volle Pipe den Prozess nicht blockiert. Scheitert das
 * Lesen von stdout oder ein Rückruf, ist das ein Lesefehler: stop("read"),
 * stdout gilt dann als fertig.
 */

/** Warum ein Lauf beendet wurde; die erste Ursache gilt */
export type StopCause = "total" | "idle" | "abort" | "input" | "read";

export type RunPhase = "running" | "stopping" | "settled";

/** Timer der Frist; real oder als Attrappe (Tests zählen offene Timer) */
export interface RunClock {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

/** Was vom gestarteten Prozess gebraucht wird */
export interface RunProcess {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: PromiseLike<unknown>;
}

export interface SuperviseOptions {
  clock: RunClock;
  /** So lange wird nach dem ersten stop() höchstens noch gewartet */
  graceMs: number;
  /** Beendet den Prozessbaum; genau einmal, beim ersten stop() */
  terminate: () => void;
  /**
   * Jeder Chunk von stdout, auch nach stop(). Wirft der Rückruf, ist das ein
   * Lesefehler. Ohne Angabe wird stdout als Text gesammelt.
   */
  onChunk?: (chunk: Uint8Array) => void;
  /** stdout ist regulär zu Ende (nicht abgeschnitten); wirft er, Lesefehler */
  onEnd?: () => void;
}

export interface RunEnd {
  /** stdout als Text; mit onChunk leer */
  stdout: string;
  /** stderr, so weit gelesen; leer bei Lesefehler auf stderr */
  stderr: string;
  /** Exit-Code; null ohne gemeldetes Prozessende oder ohne Zahl */
  exitCode: number | null;
  /** Lese- oder Rückruffehler auf stdout, auch wenn vorher schon eine andere Ursache galt */
  readError?: unknown;
  /** Die Frist ist abgelaufen, mindestens ein Warten wurde abgebrochen */
  cutOff: boolean;
}

export interface RunControl {
  readonly phase: RunPhase;
  /** Erste Ursache; undefined, solange niemand stop() gerufen hat */
  readonly cause: StopCause | undefined;
  /** Prozessende gemeldet */
  readonly exited: boolean;
  /** Nur der erste Aufruf im Zustand running wirkt; liefert, ob er es war */
  stop(cause: StopCause): boolean;
  /** Der eine Abschluss; lehnt nie ab */
  readonly done: Promise<RunEnd>;
}

/** Startet die Überwachung direkt nach dem Prozessstart */
export function superviseRun(proc: RunProcess, opts: SuperviseOptions): RunControl {
  let phase: RunPhase = "running";
  let cause: StopCause | undefined;
  let exited = false;
  let exitCode: number | null = null;
  let readError: { error: unknown } | undefined;
  let graceTimer: unknown;
  let pending = 3; // stdout, stderr, Prozessende
  let stdoutText = "";
  let stderrText = "";

  const settled = () => phase === "settled";
  const out = proc.stdout.getReader();
  const err = proc.stderr.getReader();

  let resolveDone!: (end: RunEnd) => void;
  const done = new Promise<RunEnd>((resolve) => (resolveDone = resolve));

  const settle = (cutOff: boolean) => {
    if (settled()) return;
    phase = "settled";
    if (graceTimer !== undefined) opts.clock.clearTimeout(graceTimer);
    if (cutOff) {
      // Beendet auch ein laufendes read(): die Leser-Schleifen enden dann von selbst
      for (const reader of [out, err]) reader.cancel().catch(() => {});
    }
    resolveDone({ stdout: stdoutText, stderr: stderrText, exitCode, ...(readError ? { readError: readError.error } : {}), cutOff });
  };

  const arrived = () => {
    if (--pending === 0) settle(false);
  };

  const stop = (why: StopCause): boolean => {
    if (phase !== "running") return false;
    phase = "stopping";
    cause = why;
    graceTimer = opts.clock.setTimeout(() => settle(true), opts.graceMs);
    try {
      opts.terminate();
    } catch {}
    return true;
  };

  /** Liest bis zum Ende; false, wenn der Lauf inzwischen abgeschlossen ist */
  const drain = async (reader: ReadableStreamDefaultReader<Uint8Array>, take: (chunk: Uint8Array) => void) => {
    for (;;) {
      const next = await reader.read();
      if (settled()) return false;
      if (next.done) return true;
      take(next.value);
    }
  };

  void (async () => {
    const decoder = new TextDecoder();
    try {
      const complete = await drain(out, opts.onChunk ?? ((chunk) => (stdoutText += decoder.decode(chunk, { stream: true }))));
      if (!complete) return;
      if (opts.onChunk) opts.onEnd?.();
      else stdoutText += decoder.decode();
    } catch (error) {
      if (settled()) return;
      readError = { error };
      // Ein Rückruffehler lässt den Strom offen: nicht weiter lesen
      out.cancel().catch(() => {});
      stop("read");
    }
    arrived();
  })();

  void (async () => {
    const decoder = new TextDecoder();
    try {
      if (!(await drain(err, (chunk) => (stderrText += decoder.decode(chunk, { stream: true }))))) return;
      stderrText += decoder.decode();
    } catch {
      stderrText = "";
    }
    arrived();
  })();

  Promise.resolve(proc.exited).then(
    (code) => {
      exited = true;
      exitCode = typeof code === "number" ? code : null;
      if (!settled()) arrived();
    },
    () => {
      exited = true;
      if (!settled()) arrived();
    }
  );

  return {
    get phase() {
      return phase;
    },
    get cause() {
      return cause;
    },
    get exited() {
      return exited;
    },
    stop,
    done,
  };
}
