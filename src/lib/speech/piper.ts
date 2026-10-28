/**
 * Piper als lokale Stimme für schwache Rechner (Issue #252): Vorschlag der
 * Einrichtung, wenn Pocket TTS dort langsamer als Echtzeit ist.
 *
 * - Eigener Prozess je Aufruf aus einem eigenen venv unter
 *   models/speech/piper/ (piper-tts 1.8.0 aus piper1-gpl, GPL-3.0). tybo
 *   bettet Piper nicht ein, es ruft nur das Programm auf.
 * - Stimme de_DE-thorsten-medium aus rhasspy/piper-voices (Datensatz CC0,
 *   MODEL_CARD), als feste Dateien mit Größe und SHA-256 an einer festen
 *   Revision: ein Wechsel ist eine Code-Änderung.
 * - Der Text geht als Datei an Piper (-i), nie als Argument; Temp-Dateien
 *   werden immer gelöscht. Ausgaben des Programms gehen nie ins Log.
 */

import { join } from "node:path";
import { BRAND } from "../../brand";
import type { Artifact } from "./parakeet";
import type { RunFn } from "./process";
import { SpeechError, type Availability } from "./types";

export const PIPER_VERSION = "1.8.0";
export const PIPER_VOICE = "de_DE-thorsten-medium";
export const PIPER_LABEL = "Piper (Thorsten)";
export const PIPER_ATTRIBUTION = "Stimme: Piper (piper-tts 1.8.0, GPL-3.0, eigener Prozess) mit de_DE-thorsten-medium, Datensatz Thorsten-Voice CC0 (huggingface.co/rhasspy/piper-voices)";
/** Höchstens so lange je Aufruf */
export const PIPER_TIMEOUT_MS = 120_000;

// Stand 01.10.2026, Revision c10ece1 von rhasspy/piper-voices; Größe und SHA-256 aus der Hub-API (LFS-oid) bzw. gemessen
const VOICES = "https://huggingface.co/rhasspy/piper-voices/resolve/c10ece1aade47bb51c153c893d14e5bf8e5b7117/de/de_DE/thorsten/medium";

export type PiperArtifactId = "piper-stimme" | "piper-konfig";

export const PIPER_ARTIFACTS: Artifact<PiperArtifactId>[] = [
  {
    id: "piper-stimme",
    file: `${PIPER_VOICE}.onnx`,
    url: `${VOICES}/${PIPER_VOICE}.onnx`,
    bytes: 63_201_294,
    sha256: "7e64762d8e5118bb578f2eea6207e1a35a8e0c30595010b666f983fc87bb7819",
    unpackedBytes: 63_201_294,
    target: join("piper", `${PIPER_VOICE}.onnx`),
  },
  {
    id: "piper-konfig",
    file: `${PIPER_VOICE}.onnx.json`,
    url: `${VOICES}/${PIPER_VOICE}.onnx.json`,
    bytes: 4_819,
    sha256: "974adee790533adb273a1ac88f49027d2a1b8f0f2cf4905954a4791e79264e85",
    unpackedBytes: 4_819,
    target: join("piper", `${PIPER_VOICE}.onnx.json`),
  },
];

export interface PiperPaths {
  dir: string;
  venv: string;
  python: string;
  program: string;
  model: string;
  config: string;
  proof: string;
  probeWav: string;
}

export function piperPaths(speechDir: string): PiperPaths {
  const dir = join(speechDir, "piper");
  const venv = join(dir, "venv");
  return {
    dir,
    venv,
    python: join(venv, "bin", "python"),
    program: join(venv, "bin", "piper"),
    model: join(dir, `${PIPER_VOICE}.onnx`),
    config: join(dir, `${PIPER_VOICE}.onnx.json`),
    proof: join(speechDir, "piper.ok.json"),
    probeWav: join(speechDir, "piper-probe.wav"),
  };
}

export interface PiperProof {
  version: 1;
  piper: string;
  voice: string;
  probe: { synthMs: number; audioSeconds: number; rtf: number; at: string };
}

export const PIPER_PROOF_INVALID = `Probe fehlt oder Version geändert, ${BRAND.cli} setup sprache ausführen`;

/** Nur Dateien, synchron: Programm, Stimme und ein passender Nachweis */
export function piperAvailability(paths: PiperPaths, exists: (path: string) => boolean, readText: (path: string) => string | null): Availability {
  if (!exists(paths.program)) return { ok: false, reason: `nicht eingerichtet, ${BRAND.cli} setup sprache ausführen` };
  if (!exists(paths.model) || !exists(paths.config)) return { ok: false, reason: `Stimme fehlt, ${BRAND.cli} setup sprache ausführen` };
  const raw = readText(paths.proof);
  if (raw === null) return { ok: false, reason: PIPER_PROOF_INVALID };
  try {
    const proof = JSON.parse(raw) as PiperProof;
    if (!proof || proof.version !== 1 || proof.piper !== PIPER_VERSION || proof.voice !== PIPER_VOICE) return { ok: false, reason: PIPER_PROOF_INVALID };
  } catch {
    return { ok: false, reason: PIPER_PROOF_INVALID };
  }
  return { ok: true };
}

export function piperCommand(paths: PiperPaths, input: string, output: string): string[] {
  return [paths.program, "-m", paths.model, "-c", paths.config, "-i", input, "-f", output];
}

export interface PiperDeps {
  run: RunFn;
  writeFile: (path: string, data: Buffer) => Promise<void>;
  readFile: (path: string) => Promise<Buffer>;
  unlink: (path: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  exists: (path: string) => boolean;
}

/** WAV für den Text; wirft SpeechError (unavailable, timeout, exit, empty) */
export async function synthesizeWithPiper(text: string, paths: PiperPaths, job: { tmpDir: string; unique: string; signal?: AbortSignal }, d: PiperDeps): Promise<Buffer> {
  if (!d.exists(paths.program) || !d.exists(paths.model)) throw new SpeechError("unavailable");
  const input = join(job.tmpDir, `piper_${job.unique}.txt`);
  const output = join(job.tmpDir, `piper_${job.unique}.wav`);
  try {
    if (job.signal?.aborted) throw new SpeechError("timeout");
    await d.mkdir(job.tmpDir);
    // Ein Absatz: Piper liest zeilenweise und würde sonst je Zeile neu ansetzen
    await d.writeFile(input, Buffer.from(text.replace(/\s*\n+\s*/g, " ").trim() + "\n", "utf8"));
    const res = await d.run(piperCommand(paths, input, output), { timeoutMs: PIPER_TIMEOUT_MS, ...(job.signal ? { signal: job.signal } : {}) });
    if (res.timedOut || job.signal?.aborted) throw new SpeechError("timeout");
    if (res.exitCode !== 0) throw new SpeechError("exit", res.exitCode ?? undefined);
    if (!d.exists(output)) throw new SpeechError("empty");
    const audio = await d.readFile(output);
    if (audio.length <= 44) throw new SpeechError("empty");
    return audio;
  } finally {
    for (const p of [input, output]) await d.unlink(p).catch(() => {});
  }
}
