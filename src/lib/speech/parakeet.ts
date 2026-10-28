/**
 * Parakeet TDT 0.6B v3 über sherpa-onnx (Issue #251, Entscheidung 0023).
 *
 * Gemeinsamer Baustein für den Anbieter „parakeet“ (./providers.ts) und den
 * Einrichtungsschritt „sprache“ (src/setup/steps/speech.ts):
 * - Artefakte mit Version, Größe und SHA-256 als Konstanten. Die Release-API
 *   wird zur Laufzeit nie gefragt; ein Versionswechsel ist eine Code-Änderung.
 * - Plattform-Auswahl: Mac mit Apple Silicon, Linux x64, Linux arm64. Alles
 *   andere ist „nicht unterstützt“ und lädt nichts.
 * - Ablage unter models/speech/ und der Nachweis parakeet.ok.json: Ihn
 *   schreibt nur die Einrichtung nach bestandener Probe. Er hält Version,
 *   Modell, Plattform und je Datei Größe und Änderungszeit fest; weicht eine
 *   Datei ab oder fehlt sie, ist er entwertet.
 * - Erkennung: Eingabe als Temp-Datei, bei Bedarf über ffmpeg zu WAV (PCM16,
 *   16 kHz, mono), dann sherpa-onnx-vad-with-offline-asr. stdout und stderr
 *   werden nur geparst, nie geloggt und nie Teil eines Fehlers.
 */

import { join } from "node:path";
import { BRAND } from "../../brand";
import type { RunFn } from "./process";
import { SpeechError, type Availability } from "./types";

export const SHERPA_VERSION = "1.13.8";
export const PARAKEET_MODEL = "parakeet-tdt-0.6b-v3-int8";
export const PARAKEET_LABEL = "Parakeet TDT 0.6B v3";
export const PARAKEET_ATTRIBUTION = "Parakeet TDT 0.6B v3 von NVIDIA, Lizenz CC-BY-4.0 (huggingface.co/nvidia/parakeet-tdt-0.6b-v3)";
export const SHERPA_PROGRAM = "sherpa-onnx-vad-with-offline-asr";

/** Ordner aller lokalen Sprachdateien, relativ zum Projektordner */
export function speechDir(root: string): string {
  return join(root, "models", "speech");
}

const RELEASE = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

export type PlatformKey = "osx-arm64" | "linux-x64" | "linux-aarch64";

export type ArtifactId = "laufzeit" | "modell" | "vad";

/** Ein Download mit fester Größe und Prüfsumme (Parakeet; seit Issue #252 auch die Piper-Stimme) */
export interface Artifact<I extends string = ArtifactId> {
  id: I;
  /** Dateiname im Release */
  file: string;
  url: string;
  /** Größe des Downloads in Byte (Release-API, Feld size) */
  bytes: number;
  sha256: string;
  /** Platz nach dem Entpacken in Byte (gemessen, Summe der Dateien im Archiv) */
  unpackedBytes: number;
  /** Ordner im Archiv; fehlt: einzelne Datei ohne Entpacken */
  archiveDir?: string;
  /** Ziel relativ zu models/speech */
  target: string;
}

interface RuntimePackage {
  file: string;
  bytes: number;
  sha256: string;
  unpackedBytes: number;
  /** Bibliotheken unter lib/, die das Programm braucht */
  libs: string[];
}

// Stand 01.10.2026, Release v1.13.8 vom 10.09.2026; Größen und Summen aus der
// Release-API (digest je Asset), entpackte Größen aus tar tv gemessen
const RUNTIMES: Record<PlatformKey, RuntimePackage> = {
  "osx-arm64": {
    file: "sherpa-onnx-v1.13.8-osx-arm64-shared-no-tts.tar.bz2",
    bytes: 18_252_168,
    sha256: "91b96512c4fa1960f8a9ed5360a6c8dda53a4b5015d0590244f14086a234557a",
    unpackedBytes: 61_332_719,
    libs: ["libonnxruntime.dylib"],
  },
  "linux-x64": {
    file: "sherpa-onnx-v1.13.8-linux-x64-shared-no-tts.tar.bz2",
    bytes: 24_802_494,
    sha256: "d0f96c8b65c6cd0974fada22737e337de81bc8cd2abbec2e39caf358b1eec5fc",
    unpackedBytes: 76_718_008,
    libs: ["libonnxruntime.so"],
  },
  // Für Linux arm64 gibt es kein no-tts-Paket
  "linux-aarch64": {
    file: "sherpa-onnx-v1.13.8-linux-aarch64-shared-cpu.tar.bz2",
    bytes: 28_091_778,
    sha256: "4e3734f82bc1379fd91f219f5869c7e9d03b7a4f7561907d8abca4849c51a789",
    unpackedBytes: 78_104_112,
    libs: ["libonnxruntime.so"],
  },
};

const MODEL_ARCHIVE_DIR = "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8";

export const MODEL_ARTIFACT: Artifact = {
  id: "modell",
  file: `${MODEL_ARCHIVE_DIR}.tar.bz2`,
  url: `${RELEASE}/asr-models/${MODEL_ARCHIVE_DIR}.tar.bz2`,
  bytes: 487_170_055,
  sha256: "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
  unpackedBytes: 671_239_000,
  archiveDir: MODEL_ARCHIVE_DIR,
  target: PARAKEET_MODEL,
};

export const VAD_ARTIFACT: Artifact = {
  id: "vad",
  file: "silero_vad.onnx",
  url: `${RELEASE}/asr-models/silero_vad.onnx`,
  bytes: 643_854,
  sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6",
  unpackedBytes: 643_854,
  target: "silero_vad.onnx",
};

/** Ordner der Laufzeit unter models/speech, unabhängig von der Plattform */
export const RUNTIME_TARGET = `sherpa-onnx-v${SHERPA_VERSION}`;

export function runtimeArtifact(key: PlatformKey): Artifact {
  const r = RUNTIMES[key];
  return {
    id: "laufzeit",
    file: r.file,
    url: `${RELEASE}/v${SHERPA_VERSION}/${r.file}`,
    bytes: r.bytes,
    sha256: r.sha256,
    unpackedBytes: r.unpackedBytes,
    archiveDir: r.file.replace(/\.tar\.bz2$/, ""),
    target: RUNTIME_TARGET,
  };
}

/** Alle drei Artefakte für eine Plattform, in Ladereihenfolge */
export function artifactsFor(key: PlatformKey): Artifact[] {
  return [runtimeArtifact(key), VAD_ARTIFACT, MODEL_ARTIFACT];
}

export type PlatformChoice = { ok: true; key: PlatformKey; label: string } | { ok: false; label: string; reason: string };

const SUPPORTED_LABEL: Record<PlatformKey, string> = {
  "osx-arm64": "Mac mit Apple Silicon",
  "linux-x64": "Linux x64",
  "linux-aarch64": "Linux arm64",
};

function unsupportedLabel(platform: string, arch: string): string {
  if (platform === "darwin") return "Intel-Mac";
  if (platform === "win32") return "Windows";
  if (platform === "linux" && (arch === "ia32" || arch === "arm")) return "32-Bit-Linux";
  return `${platform} ${arch}`;
}

/** Paket für Betriebssystem und Architektur (wie process.platform und process.arch) */
export function selectPlatform(platform: string, arch: string): PlatformChoice {
  let key: PlatformKey | null = null;
  if (platform === "darwin" && arch === "arm64") key = "osx-arm64";
  else if (platform === "linux" && arch === "x64") key = "linux-x64";
  else if (platform === "linux" && arch === "arm64") key = "linux-aarch64";
  if (key) return { ok: true, key, label: SUPPORTED_LABEL[key] };
  const label = unsupportedLabel(platform, arch);
  return {
    ok: false,
    label,
    reason: `Parakeet läuft hier nicht (${label}); unterstützt sind Mac mit Apple Silicon, Linux x64 und Linux arm64. Stattdessen whisper.cpp oder Spracherkennung in der Cloud (ElevenLabs, Gemini).`,
  };
}

export interface ParakeetPaths {
  dir: string;
  runtimeDir: string;
  program: string;
  libDir: string;
  libs: string[];
  modelDir: string;
  tokens: string;
  encoder: string;
  decoder: string;
  joiner: string;
  vad: string;
  proof: string;
}

export function parakeetPaths(dir: string, key: PlatformKey): ParakeetPaths {
  const runtimeDir = join(dir, RUNTIME_TARGET);
  const libDir = join(runtimeDir, "lib");
  const modelDir = join(dir, PARAKEET_MODEL);
  return {
    dir,
    runtimeDir,
    program: join(runtimeDir, "bin", SHERPA_PROGRAM),
    libDir,
    libs: RUNTIMES[key].libs.map(l => join(libDir, l)),
    modelDir,
    tokens: join(modelDir, "tokens.txt"),
    encoder: join(modelDir, "encoder.int8.onnx"),
    decoder: join(modelDir, "decoder.int8.onnx"),
    joiner: join(modelDir, "joiner.int8.onnx"),
    vad: join(dir, VAD_ARTIFACT.target),
    proof: join(dir, "parakeet.ok.json"),
  };
}

/** Dateien, die ein Artefakt am Zielort ausmachen */
export function artifactFiles(paths: ParakeetPaths, id: ArtifactId): string[] {
  if (id === "laufzeit") return [paths.program, ...paths.libs];
  if (id === "modell") return [paths.tokens, paths.encoder, paths.decoder, paths.joiner];
  return [paths.vad];
}

/** Alle Dateien, die Erkennung und Nachweis brauchen */
export function requiredFiles(paths: ParakeetPaths): string[] {
  return [...artifactFiles(paths, "laufzeit"), ...artifactFiles(paths, "vad"), ...artifactFiles(paths, "modell")];
}

// ---------------------------------------------------------------------------
// Nachweis
// ---------------------------------------------------------------------------

export interface FileStamp {
  size: number;
  mtimeMs: number;
}

export type StatFn = (path: string) => FileStamp | null;

export interface ParakeetProof {
  version: 1;
  sherpa: string;
  model: string;
  platform: PlatformKey;
  /** Je Datei (relativ zu models/speech) Größe und Änderungszeit */
  files: Record<string, FileStamp>;
  probe: { wer: number; ms: number; at: string };
}

function relativeTo(dir: string, path: string): string {
  return path.startsWith(dir + "/") ? path.slice(dir.length + 1) : path;
}

/** Nachweis für die Dateien, wie sie jetzt liegen; null, wenn eine fehlt */
export function buildProof(paths: ParakeetPaths, key: PlatformKey, stat: StatFn, probe: ParakeetProof["probe"]): ParakeetProof | null {
  const files: Record<string, FileStamp> = {};
  for (const f of requiredFiles(paths)) {
    const s = stat(f);
    if (!s) return null;
    files[relativeTo(paths.dir, f)] = { size: s.size, mtimeMs: Math.trunc(s.mtimeMs) };
  }
  return { version: 1, sherpa: SHERPA_VERSION, model: PARAKEET_MODEL, platform: key, files, probe };
}

export const PROOF_INVALID = `Probe nicht bestanden oder Dateien geändert, ${BRAND.cli} setup sprache ausführen`;

/**
 * Passt der Nachweis zu den Dateien? Nur Dateien lesen (für available()):
 * Version, Modell, Plattform, genau die nötigen Dateien, je Größe und
 * Änderungszeit.
 */
export function checkProof(raw: string | null, paths: ParakeetPaths, key: PlatformKey, stat: StatFn): Availability {
  const missing = requiredFiles(paths).some(f => !stat(f));
  if (raw === null) return { ok: false, reason: missing ? `nicht eingerichtet, ${BRAND.cli} setup sprache ausführen` : PROOF_INVALID };
  if (missing) return { ok: false, reason: PROOF_INVALID };
  let proof: ParakeetProof;
  try {
    proof = JSON.parse(raw);
  } catch {
    return { ok: false, reason: PROOF_INVALID };
  }
  if (!proof || proof.version !== 1 || proof.sherpa !== SHERPA_VERSION || proof.model !== PARAKEET_MODEL || proof.platform !== key) {
    return { ok: false, reason: PROOF_INVALID };
  }
  const wanted = requiredFiles(paths).map(f => relativeTo(paths.dir, f));
  const listed = proof.files && typeof proof.files === "object" ? Object.keys(proof.files) : [];
  if (listed.length !== wanted.length || !wanted.every(w => listed.includes(w))) return { ok: false, reason: PROOF_INVALID };
  for (const f of requiredFiles(paths)) {
    const s = stat(f)!;
    const p = proof.files[relativeTo(paths.dir, f)];
    // Ganze Millisekunden: Bun 1.4 liefert mtimeMs mit Nachkommastellen, ältere Versionen nicht
    if (!p || p.size !== s.size || Math.trunc(p.mtimeMs) !== Math.trunc(s.mtimeMs)) return { ok: false, reason: PROOF_INVALID };
  }
  return { ok: true };
}

/** Verfügbarkeit für Projektordner, Plattform und Architektur; nur Dateien, synchron */
export function parakeetAvailability(dir: string, platform: string, arch: string, stat: StatFn, readText: (path: string) => string | null): Availability {
  const sel = selectPlatform(platform, arch);
  if (!sel.ok) return { ok: false, reason: `auf dieser Plattform nicht unterstützt (${sel.label})` };
  const paths = parakeetPaths(dir, sel.key);
  return checkProof(readText(paths.proof), paths, sel.key, stat);
}

// ---------------------------------------------------------------------------
// Erkennung
// ---------------------------------------------------------------------------

/** Ist das schon das Format, das sherpa liest (PCM16, 16 kHz, mono)? */
export function isSherpaWav(b: Buffer): boolean {
  if (b.length < 12 || b.toString("latin1", 0, 4) !== "RIFF" || b.toString("latin1", 8, 12) !== "WAVE") return false;
  let pos = 12;
  let fmtOk = false;
  while (pos + 8 <= b.length) {
    const id = b.toString("latin1", pos, pos + 4);
    const size = b.readUInt32LE(pos + 4);
    if (id === "fmt ") {
      if (size < 16 || pos + 24 > b.length) return false;
      const format = b.readUInt16LE(pos + 8);
      const channels = b.readUInt16LE(pos + 10);
      const rate = b.readUInt32LE(pos + 12);
      const bits = b.readUInt16LE(pos + 22);
      // Nur einfaches PCM; Gleitkomma, 24 Bit, WAVE_FORMAT_EXTENSIBLE gehen über ffmpeg
      fmtOk = format === 1 && channels === 1 && rate === 16000 && bits === 16;
      if (!fmtOk) return false;
    } else if (id === "data") {
      return fmtOk;
    }
    pos = pos + 8 + size + (size & 1);
  }
  return false;
}

const SEGMENT = /^\s*\d+(?:\.\d+)?\s+--\s+\d+(?:\.\d+)?:\s?(.*)$/;

/** Erkannte Segmente aus stdout („0.102 -- 1.100: Text“), zusammengefügt; alles andere wird ignoriert */
export function parseSegments(stdout: string): string {
  const parts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const m = SEGMENT.exec(line);
    const text = m?.[1]?.trim();
    if (text) parts.push(text);
  }
  return parts.join(" ");
}

export function sherpaCommand(paths: ParakeetPaths, wav: string, threads: number): string[] {
  return [
    paths.program,
    `--silero-vad-model=${paths.vad}`,
    `--tokens=${paths.tokens}`,
    `--encoder=${paths.encoder}`,
    `--decoder=${paths.decoder}`,
    `--joiner=${paths.joiner}`,
    "--model-type=nemo_transducer",
    `--num-threads=${threads}`,
    wav,
  ];
}

/** Bibliothekspfad des Pakets (zusätzlich zum RPATH im Programm), ohne Systeminstallation */
export function libraryEnv(paths: ParakeetPaths, key: PlatformKey): Record<string, string> {
  return key === "osx-arm64" ? { DYLD_LIBRARY_PATH: paths.libDir } : { LD_LIBRARY_PATH: paths.libDir };
}

/** Frist ohne Signal von außen (Telegram-Weg): Wandlung und Erkennung zusammen */
export const PARAKEET_TIMEOUT_MS = 30_000;
/** Mit Signal von außen begrenzt das Signal; dies ist nur die Obergrenze je Prozess */
const BACKSTOP_MS = 120_000;
const FFMPEG_ARGS = ["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", "-f", "wav"];

export interface SherpaDeps {
  run: RunFn;
  which: (cmd: string) => string | null;
  writeFile: (path: string, data: Buffer) => Promise<void>;
  unlink: (path: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
}

export interface SherpaJob {
  paths: ParakeetPaths;
  key: PlatformKey;
  /** Ordner für Temp-Dateien */
  tmpDir: string;
  /** Eindeutiger Teil der Temp-Dateinamen */
  unique: string;
  /** Endung der Eingabe-Datei (nur für ffmpeg) */
  ext: string;
  threads: number;
  signal?: AbortSignal;
  now?: () => number;
}

/**
 * Erkennt eine Aufnahme mit sherpa-onnx. Wirft SpeechError: unavailable
 * (Dateien fehlen), format (kein passendes WAV und kein ffmpeg), timeout
 * (Frist oder Abbruch), exit (Programm scheiterte), empty (keine Sprache
 * erkannt). Temp-Dateien werden immer gelöscht. Prüft keinen Nachweis: das
 * ist Sache von available() bzw. der Probe in der Einrichtung.
 */
export async function transcribeWithSherpa(audio: Buffer, job: SherpaJob, d: SherpaDeps, exists: (path: string) => boolean): Promise<string> {
  const now = job.now ?? Date.now;
  const deadline = job.signal ? undefined : now() + PARAKEET_TIMEOUT_MS;
  const timeLeft = () => (deadline === undefined ? BACKSTOP_MS : deadline - now());
  const stopped = () => !!job.signal?.aborted || timeLeft() <= 0;
  const runOpts = (env?: Record<string, string>) => ({
    timeoutMs: Math.max(1, timeLeft()),
    ...(job.signal ? { signal: job.signal } : {}),
    ...(env ? { env } : {}),
  });

  if (requiredFiles(job.paths).some(f => !exists(f))) throw new SpeechError("unavailable");
  const ready = isSherpaWav(audio);
  if (!ready && !d.which("ffmpeg")) throw new SpeechError("format");

  const input = join(job.tmpDir, `parakeet_${job.unique}_in.${ready ? "wav" : job.ext}`);
  const converted = join(job.tmpDir, `parakeet_${job.unique}_16k.wav`);
  const temps = ready ? [input] : [input, converted];
  try {
    if (stopped()) throw new SpeechError("timeout");
    await d.mkdir(job.tmpDir);
    await d.writeFile(input, audio);
    let wav = input;
    if (!ready) {
      if (stopped()) throw new SpeechError("timeout");
      const ff = await d.run(["ffmpeg", "-y", "-loglevel", "error", "-i", input, ...FFMPEG_ARGS, converted], runOpts());
      if (ff.timedOut || stopped()) throw new SpeechError("timeout");
      if (ff.exitCode !== 0) throw new SpeechError("format");
      wav = converted;
    }
    if (stopped()) throw new SpeechError("timeout");
    const res = await d.run(sherpaCommand(job.paths, wav, job.threads), runOpts(libraryEnv(job.paths, job.key)));
    if (res.timedOut || stopped()) throw new SpeechError("timeout");
    if (res.exitCode !== 0) throw new SpeechError("exit", res.exitCode ?? undefined);
    const text = parseSegments(res.stdout);
    if (!text) throw new SpeechError("empty");
    return text;
  } finally {
    for (const t of temps) await d.unlink(t).catch(() => {});
  }
}

/** Zwei Sekunden Stille als WAV (PCM16, 16 kHz, mono), für die Stille-Probe */
export function silenceWav(seconds = 2): Buffer {
  const samples = 16000 * seconds;
  const data = samples * 2;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVE", 8, "latin1");
  b.write("fmt ", 12, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(data, 40);
  return b;
}
