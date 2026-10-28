/**
 * Erkennungsprozess für Parakeet im Dauerbetrieb (Issue #257): lädt das
 * Modell einmal über die C-API von sherpa-onnx (libsherpa-onnx-c-api aus
 * dem eingerichteten Laufzeitpaket, bun:ffi) und erkennt danach beliebig
 * viele Aufnahmen nacheinander. Gestartet von ./parakeet-warm.ts mit Bun als
 * eigener Prozess: ein Absturz der Bibliothek trifft nie den Bot.
 *
 * Warum nicht sherpa-onnx-offline-websocket-server: Der Server aus demselben
 * Paket bindet laut Quelle (offline-websocket-server-impl.cc, listen auf
 * asio::ip::tcp::v4()) an alle Netzwerkkarten, ohne Anmeldung. Hier gibt es
 * keinen Port, nur stdin und stdout des Kindprozesses.
 *
 * Protokoll:
 * - Argument: JSON mit lib, tokens, encoder, decoder, joiner, threads
 * - stdin: je Aufnahme 4 Byte Länge (uint32 LE), dann PCM16 LE mono 16 kHz
 * - stdout: eine JSON-Zeile je Ereignis: {"ready":true} nach dem Laden,
 *   dann je Aufnahme {"text":"..."}. Nie etwas anderes (sherpa schreibt
 *   seine Meldungen nach stderr, das der Aufrufer verwirft).
 * - Exit-Code 3: Argumente unbrauchbar, 4: Modell ließ sich nicht laden,
 *   5: Aufnahme größer als MAX_FRAME_BYTES.
 *
 * Struktur-Offsets für sherpa-onnx 1.13.8 (SHERPA_VERSION in ./parakeet.ts),
 * ermittelt mit offsetof() gegen include/sherpa-onnx/c-api/c-api.h aus dem
 * Paket (LP64: macOS arm64, Linux x64 und arm64 gleich). Ein Versionswechsel
 * heißt: Offsets neu prüfen (scripts/parakeet-offsets.c).
 */

import { CString, dlopen, FFIType, ptr, read } from "bun:ffi";

export const RECOGNIZER_CONFIG = {
  size: 608,
  sampleRate: 0,
  featureDim: 4,
  encoder: 8,
  decoder: 16,
  joiner: 24,
  tokens: 104,
  numThreads: 112,
  debug: 116,
  provider: 120,
  modelType: 128,
  decodingMethod: 528,
  maxActivePaths: 536,
} as const;

/** 60 s PCM16 bei 16 kHz plus Luft */
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;

interface WorkerArgs {
  lib: string;
  tokens: string;
  encoder: string;
  decoder: string;
  joiner: string;
  threads: number;
}

function parseArgs(raw: string | undefined): WorkerArgs | null {
  try {
    const a = JSON.parse(raw ?? "");
    const strings = ["lib", "tokens", "encoder", "decoder", "joiner"] as const;
    if (!a || strings.some(k => typeof a[k] !== "string" || !a[k])) return null;
    const threads = Number.isInteger(a.threads) && a.threads > 0 && a.threads <= 16 ? a.threads : 2;
    return { lib: a.lib, tokens: a.tokens, encoder: a.encoder, decoder: a.decoder, joiner: a.joiner, threads };
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv[2]);
  if (!args) process.exit(3);

  const lib = dlopen(args.lib, {
    SherpaOnnxCreateOfflineRecognizer: { args: [FFIType.ptr], returns: FFIType.ptr },
    SherpaOnnxCreateOfflineStream: { args: [FFIType.ptr], returns: FFIType.ptr },
    SherpaOnnxDestroyOfflineStream: { args: [FFIType.ptr], returns: FFIType.void },
    SherpaOnnxAcceptWaveformOffline: { args: [FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.void },
    SherpaOnnxDecodeOfflineStream: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.void },
    SherpaOnnxGetOfflineStreamResult: { args: [FFIType.ptr], returns: FFIType.ptr },
    SherpaOnnxDestroyOfflineRecognizerResult: { args: [FFIType.ptr], returns: FFIType.void },
  });
  const f = lib.symbols;

  // Zeichenketten bleiben bis zum Ende des Prozesses referenziert (die Bibliothek kopiert sie, sicher ist sicher)
  const keep: Buffer[] = [];
  const cstr = (s: string): bigint => {
    const b = Buffer.from(`${s}\0`, "utf8");
    keep.push(b);
    return BigInt(ptr(b));
  };
  const o = RECOGNIZER_CONFIG;
  const config = new Uint8Array(o.size);
  const view = new DataView(config.buffer);
  view.setInt32(o.sampleRate, 16_000, true);
  view.setInt32(o.featureDim, 80, true);
  view.setBigUint64(o.encoder, cstr(args.encoder), true);
  view.setBigUint64(o.decoder, cstr(args.decoder), true);
  view.setBigUint64(o.joiner, cstr(args.joiner), true);
  view.setBigUint64(o.tokens, cstr(args.tokens), true);
  view.setInt32(o.numThreads, args.threads, true);
  view.setInt32(o.debug, 0, true);
  view.setBigUint64(o.provider, cstr("cpu"), true);
  // Wie --model-type=nemo_transducer im bisherigen Aufruf (./parakeet.ts, sherpaCommand)
  view.setBigUint64(o.modelType, cstr("nemo_transducer"), true);
  view.setBigUint64(o.decodingMethod, cstr("greedy_search"), true);
  view.setInt32(o.maxActivePaths, 4, true);

  const recognizer = f.SherpaOnnxCreateOfflineRecognizer(ptr(config));
  if (!recognizer) process.exit(4);
  process.stdout.write(`${JSON.stringify({ ready: true })}\n`);

  const recognize = (pcm: Buffer): string => {
    const n = Math.floor(pcm.length / 2);
    const samples = new Float32Array(n);
    for (let i = 0; i < n; i++) samples[i] = pcm.readInt16LE(i * 2) / 32768;
    const stream = f.SherpaOnnxCreateOfflineStream(recognizer);
    if (!stream) return "";
    try {
      f.SherpaOnnxAcceptWaveformOffline(stream, 16_000, ptr(samples), n);
      f.SherpaOnnxDecodeOfflineStream(recognizer, stream);
      const result = f.SherpaOnnxGetOfflineStreamResult(stream);
      if (!result) return "";
      try {
        const textPtr = read.ptr(result, 0);
        return textPtr ? new CString(textPtr as unknown as never).toString() : "";
      } finally {
        f.SherpaOnnxDestroyOfflineRecognizerResult(result);
      }
    } finally {
      f.SherpaOnnxDestroyOfflineStream(stream);
    }
  };

  let buf = Buffer.alloc(0);
  for await (const chunk of Bun.stdin.stream()) {
    buf = buf.length ? Buffer.concat([buf, Buffer.from(chunk)]) : Buffer.from(chunk);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len > MAX_FRAME_BYTES) process.exit(5);
      if (buf.length < 4 + len) break;
      const pcm = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let text = "";
      try {
        text = len ? recognize(pcm).trim() : "";
      } catch {
        text = "";
      }
      process.stdout.write(`${JSON.stringify({ text })}\n`);
    }
  }
  // stdin zu: Ende (der Aufrufer legt auf)
  process.exit(0);
}

if (import.meta.main) void main();
