/**
 * Parakeet im Dauerbetrieb (Issue #257): ein Erkennungsprozess
 * (./parakeet_worker.ts) je Telefonhörer-Gespräch, der das Modell einmal lädt
 * und mehrere Aufnahmen nacheinander erkennt. close() beim Auflegen beendet
 * ihn.
 *
 * - Verfügbar nur, wenn Parakeet eingerichtet ist (Nachweis wie bisher) und
 *   das Laufzeitpaket die C-API-Bibliothek enthält (libsherpa-onnx-c-api,
 *   liegt im selben Paket wie das bisherige Programm, keine weitere
 *   Installation). Sonst bleibt es beim Aufruf je Äußerung.
 * - Umgebung: nur PATH, HOME und der Bibliothekspfad, keine Schlüssel.
 * - Aufnahmen gehen der Reihe nach hinein, Ergebnisse kommen in derselben
 *   Reihenfolge heraus. Ein Abbruch (signal) gibt sofort SpeechError
 *   timeout zurück; das späte Ergebnis wird verworfen.
 * - stderr wird verworfen (sherpa schreibt dort Modellangaben), stdout nur
 *   geparst, nie geloggt.
 */

import { join } from "node:path";
import { isSherpaWav, libraryEnv, type ParakeetPaths, type PlatformKey } from "./parakeet";
import { SpeechError, type SpeechOpts, type WarmStt } from "./types";

export const PARAKEET_WORKER_SCRIPT = join(import.meta.dir, "parakeet_worker.ts");
/** Laden des Modells, gemessen 2,5 s auf einem Mac mit M4 (aus dem Cache des Systems schneller) */
export const PARAKEET_WARM_TIMEOUT_MS = 60_000;
/** Höchstens so lange je Aufnahme */
export const PARAKEET_WARM_RECOGNIZE_MS = 30_000;

const CAPI_LIB: Record<PlatformKey, string> = {
  "osx-arm64": "libsherpa-onnx-c-api.dylib",
  "linux-x64": "libsherpa-onnx-c-api.so",
  "linux-aarch64": "libsherpa-onnx-c-api.so",
};

export function capiLibrary(paths: ParakeetPaths, key: PlatformKey): string {
  return join(paths.libDir, CAPI_LIB[key]);
}

export interface WarmProc {
  stdin: { write(chunk: Uint8Array): unknown; flush?(): unknown; end?(): unknown };
  stdout: ReadableStream<Uint8Array>;
  exited: Promise<number | null>;
  kill(signal?: number | NodeJS.Signals): void;
}

export type WarmSpawn = (cmd: string[], env: Record<string, string>) => WarmProc;

export const realWarmSpawn: WarmSpawn = (cmd, env) =>
  Bun.spawn({ cmd, env, stdin: "pipe", stdout: "pipe", stderr: "ignore" }) as unknown as WarmProc;

export interface ParakeetWarmOptions {
  paths: ParakeetPaths;
  key: PlatformKey;
  threads: number;
  spawn?: WarmSpawn;
  /** Programm, das das Skript ausführt (Standard: dieses Bun) */
  runtime?: string;
  env?: Record<string, string | undefined>;
  readyTimeoutMs?: number;
}

/** Befehl des Erkennungsprozesses (Pfade als ein JSON-Argument) */
export function warmCommand(o: Pick<ParakeetWarmOptions, "paths" | "key" | "threads" | "runtime">): string[] {
  const args = {
    lib: capiLibrary(o.paths, o.key),
    tokens: o.paths.tokens,
    encoder: o.paths.encoder,
    decoder: o.paths.decoder,
    joiner: o.paths.joiner,
    threads: o.threads,
  };
  return [o.runtime ?? process.execPath, PARAKEET_WORKER_SCRIPT, JSON.stringify(args)];
}

/** PCM16 aus einem WAV im Format von sherpa (16 kHz, mono, 16 Bit); null, wenn es nicht passt */
export function sherpaPcm(wav: Buffer): Buffer | null {
  if (!isSherpaWav(wav)) return null;
  let pos = 12;
  while (pos + 8 <= wav.length) {
    const id = wav.toString("latin1", pos, pos + 4);
    const size = wav.readUInt32LE(pos + 4);
    if (id === "data") return wav.subarray(pos + 8, Math.min(wav.length, pos + 8 + size));
    pos = pos + 8 + size + (size & 1);
  }
  return null;
}

interface Pending {
  resolve(text: string): void;
  reject(e: unknown): void;
  /** Abgebrochen: Ergebnis kommt noch, wird aber verworfen */
  dropped: boolean;
}

/**
 * Startet den Erkennungsprozess und wartet, bis das Modell geladen ist.
 * Wirft SpeechError: exit (Prozess endete vorher), timeout (Laden zu lang).
 */
export async function startParakeetWarm(o: ParakeetWarmOptions): Promise<WarmStt> {
  const spawn = o.spawn ?? realWarmSpawn;
  const base = o.env ?? process.env;
  const env: Record<string, string> = { ...libraryEnv(o.paths, o.key) };
  for (const name of ["PATH", "HOME", "TMPDIR", "LANG"]) {
    const v = base[name];
    if (v !== undefined) env[name] = v;
  }
  const proc = spawn(warmCommand(o), env);
  let exited = false;
  let closed = false;
  const queue: Pending[] = [];
  let ready: (() => void) | null = null;
  let failStart: ((e: unknown) => void) | null = null;

  const failAll = (e: unknown) => {
    for (const p of queue.splice(0)) if (!p.dropped) p.reject(e);
  };

  const onLine = (line: string) => {
    let msg: { ready?: boolean; text?: unknown };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg.ready === true) {
      ready?.();
      ready = null;
      return;
    }
    if (typeof msg.text !== "string") return;
    const p = queue.shift();
    if (!p || p.dropped) return;
    if (!msg.text.trim()) p.reject(new SpeechError("empty"));
    else p.resolve(msg.text);
  };

  void (async () => {
    const reader = proc.stdout.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (line) onLine(line);
        }
      }
    } catch {
      // wie Prozessende
    }
  })();

  void proc.exited.then(
    code => {
      exited = true;
      failStart?.(new SpeechError("exit", code ?? undefined));
      failAll(new SpeechError("exit", code ?? undefined));
    },
    () => {
      exited = true;
      failStart?.(new SpeechError("exit"));
      failAll(new SpeechError("exit"));
    },
  );

  const kill = () => {
    if (exited) return;
    try {
      proc.stdin.end?.();
    } catch {
      // schon zu
    }
    try {
      proc.kill("SIGTERM");
    } catch {
      // schon beendet
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      ready = resolve;
      failStart = reject;
      timer = setTimeout(() => reject(new SpeechError("timeout")), o.readyTimeoutMs ?? PARAKEET_WARM_TIMEOUT_MS);
    });
  } catch (e) {
    kill();
    throw e;
  } finally {
    clearTimeout(timer);
    failStart = null;
  }

  return {
    async transcribe(audio: Buffer, _mime: string, opts: SpeechOpts): Promise<string> {
      if (closed || exited) throw new SpeechError("exit");
      if (opts.signal?.aborted) throw new SpeechError("timeout");
      const pcm = sherpaPcm(audio);
      if (!pcm) throw new SpeechError("format");
      return new Promise<string>((resolve, reject) => {
        let t: ReturnType<typeof setTimeout> | undefined;
        const done = () => {
          clearTimeout(t);
          opts.signal?.removeEventListener("abort", onAbort);
        };
        const entry: Pending = {
          dropped: false,
          resolve: text => {
            done();
            resolve(text);
          },
          reject: e => {
            done();
            reject(e);
          },
        };
        // Abbruch: sofort zurück, das spätere Ergebnis wird übersprungen
        const onAbort = () => {
          if (entry.dropped) return;
          entry.dropped = true;
          done();
          reject(new SpeechError("timeout"));
        };
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        t = setTimeout(onAbort, PARAKEET_WARM_RECOGNIZE_MS);
        queue.push(entry);
        const head = Buffer.alloc(4);
        head.writeUInt32LE(pcm.length, 0);
        try {
          proc.stdin.write(head);
          proc.stdin.write(pcm);
          proc.stdin.flush?.();
        } catch {
          queue.splice(queue.indexOf(entry), 1);
          entry.reject(new SpeechError("exit"));
        }
      });
    },
    close() {
      if (closed) return;
      closed = true;
      failAll(new SpeechError("exit"));
      kill();
    },
  };
}
