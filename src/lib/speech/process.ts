/**
 * Subprozess für lokale Sprach-Anbieter (whisper.cpp, Qwen3-TTS, ffmpeg,
 * sherpa-onnx). Die Anbieter bekommen RunFn hereingereicht, Tests eine
 * Attrappe.
 *
 * stdout und stderr werden parallel geleert (sonst kann ein voller Puffer
 * den Prozess blockieren), der Zeitgeber wird immer aufgeräumt. stderr
 * kommt mit zurück, darf aber nie ins Log (Issue #248).
 *
 * Issue #251: Ist das Signal schon ausgelöst, startet nichts. Zeitlimit und
 * Abbruch schicken erst SIGTERM, nach KILL_GRACE_MS SIGKILL, damit auch ein
 * Prozess endet, der SIGTERM ignoriert. env ergänzt die Umgebung (etwa den
 * Bibliothekspfad von sherpa-onnx), statt sie zu ersetzen; mit replaceEnv
 * (Issue #253, Klon-Engines) ist env die ganze Umgebung, ohne process.env
 * und damit ohne Schlüssel des Bots.
 */

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** signal (Issue #249): Abbruch beendet den Prozess wie das Zeitlimit, timedOut ist dann true */
export type RunFn = (
  cmd: string[],
  opts: { cwd?: string; timeoutMs: number; signal?: AbortSignal; env?: Record<string, string>; replaceEnv?: boolean },
) => Promise<RunResult>;

/** Bun.spawn oder eine Attrappe (Tests prüfen die Umgebung am Übergang) */
export type SpawnFn = (options: {
  cmd: string[];
  cwd?: string;
  stdout: "pipe";
  stderr: "pipe";
  env?: Record<string, string | undefined>;
}) => { stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number | null>; kill(signal?: "SIGTERM" | "SIGKILL"): void };

/** Schonfrist zwischen SIGTERM und SIGKILL */
export const KILL_GRACE_MS = 2_000;
/** Nach Abbruch höchstens so lange auf restliche Ausgabe warten */
const PIPE_GRACE_MS = 500;

export function createRunProcess(spawn: SpawnFn = o => Bun.spawn(o)): RunFn {
  return (cmd, opts) => run(spawn, cmd, opts);
}

export const runProcess: RunFn = createRunProcess();

async function run(spawn: SpawnFn, cmd: string[], opts: Parameters<RunFn>[1]): Promise<RunResult> {
  if (opts.signal?.aborted) return { exitCode: null, stdout: "", stderr: "", timedOut: true };
  const proc = spawn({
    cmd,
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
    ...(opts.env ? { env: opts.replaceEnv ? { ...opts.env } : { ...process.env, ...opts.env } } : {}),
  });
  let timedOut = false;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => {
    timedOut = true;
    try {
      proc.kill("SIGTERM");
    } catch {
      // schon beendet
    }
    killTimer ??= setTimeout(() => {
      try {
        proc.kill("SIGKILL");
      } catch {
        // schon beendet
      }
    }, KILL_GRACE_MS);
  };
  const timer = setTimeout(stop, opts.timeoutMs);
  opts.signal?.addEventListener("abort", stop, { once: true });
  if (opts.signal?.aborted) stop();
  try {
    const output = Promise.all([
      new Response(proc.stdout).text().catch(() => ""),
      new Response(proc.stderr).text().catch(() => ""),
    ]);
    const exitCode = await proc.exited;
    // Nach Abbruch kann ein verwaister Kindprozess die Pipes offen halten: dann nicht darauf warten
    const [stdout, stderr] = timedOut
      ? await Promise.race([output, new Promise<[string, string]>(resolve => setTimeout(() => resolve(["", ""]), PIPE_GRACE_MS))])
      : await output;
    return { exitCode, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    clearTimeout(killTimer);
    opts.signal?.removeEventListener("abort", stop);
  }
}
