/**
 * Vorlesen mit einer eigenen Stimme (Issue #253, Entscheidung 0023).
 *
 * Zwei Klon-Engines, beide nur nach Einrichtung mit `tybo setup sprache`:
 * - pocket: Kyutai Pocket TTS mit den Klon-Gewichten (kyutai/pocket-tts,
 *   gated). Derselbe Wächter wie bei der Katalogstimme (./pocket_guard.py),
 *   die Referenz lädt er beim Start aus der geprüften Kennung; ein eigener
 *   Prozess neben dem der Katalogstimme, Ende nach Leerlauf.
 * - qwen3-base: Qwen3-TTS Base über mlx-audio (nur Mac mit Apple Silicon),
 *   eigener Prozess je Aufruf aus einem eigenen venv, das Modell offline aus
 *   dem eigenen Hugging-Face-Ordner (feste Revision).
 *
 * Gewählt wird die Engine aus speech.cloneEngine, wenn sie eingerichtet ist,
 * sonst die erste eingerichtete (pocket vor qwen3-base). Vor jedem Vorlesen
 * liest die Ablage (./voices.ts) die Stimme neu: ohne gültige Einwilligung,
 * Referenz und Text gibt es keine Ausgabe. Jede Ausgabe ist ein WAV mit
 * „KI-generiert (tybo), geklonte Stimme" im LIST/INFO-Block (./wav.ts).
 *
 * Nur für den Sprechmodus der WebUI und die Probe: Telegram, /voice, Telefon
 * und ElevenLabs nutzen diese Stimme nie (./chain.ts).
 */

import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { BRAND } from "../../brand";
import type { CloneEngineId } from "./ids";
import { speechDir } from "./parakeet";
import {
  BASE_ENV_NAMES,
  CLONE_VOICE_PREFIX,
  createPocketServer,
  POCKET_CLONE_LABEL,
  POCKET_CLONE_NOTE,
  pocketCloneAvailability,
  pocketClonePaths,
  pocketPaths,
  realPocketServerDeps,
  type PocketServer,
  type PocketServerDeps,
} from "./pocket";
import type { RunFn } from "./process";
import { SpeechError, type Availability, type TtsProvider } from "./types";
import { clonedVoiceLabel, createVoiceStore, VOICE_CONSENT_TEXT, VOICE_ID_PATTERN, voicesDir, type VoiceRecord, type VoiceStore } from "./voices";
import { tagWavAiGenerated, wavDurationSeconds } from "./wav";

// ---------------------------------------------------------------------------
// Qwen3-TTS Base (Mac)
// ---------------------------------------------------------------------------

/** Geprüfte Version (PyPI, Praxistest 30.09.2026) */
export const QWEN_CLONE_MLX_AUDIO = "0.5.7";
export const QWEN_CLONE_REPO = "mlx-community/Qwen3-TTS-12Hz-1.7B-Base-bf16";
/** Revision laut Hub-API (01.10.2026), ein Wechsel ist eine Code-Änderung */
export const QWEN_CLONE_REVISION = "a6eb4f68e4b056f1215157bb696209bc82a6db48";
/** Summe der Dateien der Revision laut Hub-API */
export const QWEN_CLONE_MODEL_BYTES = 4_544_212_739;
export const QWEN_CLONE_LABEL = "Qwen3-TTS Base (mlx-audio)";
export const QWEN_CLONE_NOTE = "Qwen3-TTS Base 1.7B, Apache-2.0 (huggingface.co/Qwen); bessere Qualität, auf einem M4 langsamer als Echtzeit";
const QWEN_TIMEOUT_MS = 180_000;

export interface QwenClonePaths {
  dir: string;
  venv: string;
  python: string;
  hfHome: string;
  /** Ordner der festen Revision im Hub-Cache; geht als --model an mlx-audio (offline) */
  snapshot: string;
  /** Nachweis: Download vollständig */
  modelReady: string;
  proof: string;
}

export function qwenClonePaths(speech: string): QwenClonePaths {
  const dir = join(speech, "qwen-clone");
  const venv = join(dir, "venv");
  const hfHome = join(dir, "hf");
  return {
    dir,
    venv,
    python: join(venv, "bin", "python"),
    hfHome,
    snapshot: join(hfHome, "hub", `models--${QWEN_CLONE_REPO.replace("/", "--")}`, "snapshots", QWEN_CLONE_REVISION),
    modelReady: join(dir, "model.ok"),
    proof: join(speech, "qwen-clone.ok.json"),
  };
}

export interface QwenCloneProof {
  version: 1;
  mlxAudio: string;
  revision: string;
  probe: { synthMs: number; audioSeconds: number; rtf: number; at: string };
}

export const QWEN_CLONE_PROOF_INVALID = `Qwen3-TTS Base nicht eingerichtet, ${BRAND.cli} setup sprache ausführen`;

export function qwenClonePlatformOk(platform: string, arch: string): boolean {
  return platform === "darwin" && arch === "arm64";
}

export function qwenCloneAvailability(paths: QwenClonePaths, platform: string, arch: string, exists: (path: string) => boolean, readText: (path: string) => string | null): Availability {
  if (!qwenClonePlatformOk(platform, arch)) return { ok: false, reason: "nur auf einem Mac mit Apple Silicon" };
  if (!exists(paths.python) || !exists(paths.snapshot) || !exists(paths.modelReady)) return { ok: false, reason: QWEN_CLONE_PROOF_INVALID };
  const raw = readText(paths.proof);
  if (raw === null) return { ok: false, reason: QWEN_CLONE_PROOF_INVALID };
  try {
    const proof = JSON.parse(raw) as QwenCloneProof;
    if (!proof || proof.version !== 1 || proof.mlxAudio !== QWEN_CLONE_MLX_AUDIO || proof.revision !== QWEN_CLONE_REVISION) return { ok: false, reason: QWEN_CLONE_PROOF_INVALID };
  } catch {
    return { ok: false, reason: QWEN_CLONE_PROOF_INVALID };
  }
  return { ok: true };
}

/** Umgebung für Python-Prozesse der Klon-Engines: Pfad, Proxy, Hugging-Face-Ordner, nie Schlüssel */
export function cloneProcessEnv(hfHome: string, base: Record<string, string | undefined>, offline = true): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of BASE_ENV_NAMES) {
    const v = base[name];
    if (v !== undefined) env[name] = v;
  }
  env.HF_HOME = hfHome;
  env.HF_HUB_DISABLE_TELEMETRY = "1";
  if (offline) env.HF_HUB_OFFLINE = "1";
  return env;
}

/**
 * Befehl für mlx-audio: Text und Referenztext als --name=wert, damit ein
 * Text mit „-" am Anfang nie als Schalter gilt
 */
export function qwenCloneCommand(paths: QwenClonePaths, ref: { audio: string; text: string }, text: string, prefix: string, language: string): string[] {
  return [
    paths.python, "-I", "-m", "mlx_audio.tts.generate",
    "--model", paths.snapshot,
    "--ref_audio", ref.audio,
    `--ref_text=${ref.text}`,
    `--text=${text}`,
    "--lang_code", language,
    "--file_prefix", prefix,
  ];
}

export interface QwenCloneJob {
  tmpDir: string;
  unique: string;
  language: string;
  env: Record<string, string>;
  signal?: AbortSignal;
}

export interface QwenCloneDeps {
  run: RunFn;
  readFile: (path: string) => Promise<Buffer>;
  unlink: (path: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  exists: (path: string) => boolean;
}

/** WAV mit der Stimme der Referenz; wirft SpeechError (timeout, exit, empty) */
export async function synthesizeWithQwenClone(text: string, ref: { audio: string; text: string }, paths: QwenClonePaths, job: QwenCloneJob, d: QwenCloneDeps): Promise<Buffer> {
  const prefix = `tybo_clone_${job.unique}`;
  const wavPath = join(job.tmpDir, `${prefix}_000.wav`);
  try {
    if (job.signal?.aborted) throw new SpeechError("timeout");
    await d.mkdir(job.tmpDir);
    const res = await d.run(qwenCloneCommand(paths, ref, text, prefix, job.language), {
      cwd: job.tmpDir,
      timeoutMs: QWEN_TIMEOUT_MS,
      // Nur diese Umgebung, nicht um process.env ergänzt: keine Schlüssel des Bots im Python-Prozess
      env: job.env,
      replaceEnv: true,
      ...(job.signal ? { signal: job.signal } : {}),
    });
    if (res.timedOut || job.signal?.aborted) throw new SpeechError("timeout");
    if (res.exitCode !== 0) throw new SpeechError("exit", res.exitCode ?? undefined);
    if (!d.exists(wavPath)) throw new SpeechError("empty");
    const audio = await d.readFile(wavPath);
    if (audio.length <= 44) throw new SpeechError("empty");
    return audio;
  } finally {
    await d.unlink(wavPath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Engines und Anbieter
// ---------------------------------------------------------------------------

export interface CloneEngine {
  id: CloneEngineId;
  label: string;
  note: string;
  available(): Availability;
  /** WAV mit der Stimme; wirft SpeechError */
  synthesize(voice: VoiceRecord, text: string, opts: { language?: string; signal?: AbortSignal }): Promise<Buffer>;
  /** Stimme vergessen: ein Prozess, der sie geladen hat, endet */
  forget(id: string): void;
}

export interface CloneSelection {
  voice?: string;
  engine?: CloneEngineId;
}

export interface CloneDeps {
  env: () => Record<string, string | undefined>;
  run: RunFn;
  readFile: (path: string) => Promise<Buffer>;
  unlink: (path: string) => Promise<void>;
  mkdir: (path: string) => Promise<void>;
  exists: (path: string) => boolean;
  cwd: () => string;
  tmpDir: string;
  unique: () => string;
  platform?: string;
  arch?: string;
  readText?: (path: string) => string | null;
  pocket?: PocketServerDeps;
  onPocketServer?: (server: PocketServer) => void;
  /** Gewählte eigene Stimme und Engine (speech.cloneVoice, speech.cloneEngine) */
  cloneSelection?: () => CloneSelection;
  /** Nur Tests: eigene Ablage */
  voices?: VoiceStore;
}

export type CloneProbeResult = { ok: true; audio: Buffer; engine: CloneEngineId } | { ok: false; reason: "unbekannt" | "engine" | "failed" };

export interface CloneEngineStatus {
  ready: boolean;
  id?: CloneEngineId;
  label?: string;
  note?: string;
  reason?: string;
}

function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Name einer Stimme synchron (für Anzeige und Verfügbarkeit); null, wenn sie nicht vollständig ist */
export function voiceNameSync(dir: string, id: string, readText: (path: string) => string | null = readTextOrNull): string | null {
  if (!VOICE_ID_PATTERN.test(id)) return null;
  try {
    if (!lstatSync(join(dir, id, "reference.wav")).isFile()) return null;
  } catch {
    return null;
  }
  try {
    const meta = JSON.parse(readText(join(dir, id, "meta.json")) ?? "null");
    const consent = JSON.parse(readText(join(dir, id, "consent.json")) ?? "null");
    if (!meta || meta.id !== id || typeof meta.name !== "string") return null;
    if (!consent || consent.version !== 1 || consent.text !== VOICE_CONSENT_TEXT || typeof consent.confirmedAt !== "string" || !consent.confirmedAt) return null;
    return meta.name;
  } catch {
    return null;
  }
}

export type CloneTts = ReturnType<typeof createCloneTts>;

export function createCloneTts(d: CloneDeps) {
  const readText = d.readText ?? readTextOrNull;
  const platform = () => d.platform ?? process.platform;
  const arch = () => d.arch ?? process.arch;
  const dirOfSpeech = () => speechDir(d.cwd());
  const dirOfVoices = () => voicesDir(d.cwd());
  let store: VoiceStore | null = d.voices ?? null;
  const voices = () => (store ??= createVoiceStore({ dir: dirOfVoices() }));
  const selection = () => d.cloneSelection?.() ?? {};

  // Pocket mit Klon-Gewichten: eigener Prozess, nimmt nur clone:<id> aus dem Ordner der Stimmen
  let pocketServer: PocketServer | null = null;
  const server = () => {
    if (!pocketServer) {
      pocketServer = createPocketServer({ paths: pocketPaths(dirOfSpeech()), env: d.env, deps: d.pocket ?? realPocketServerDeps, voicesDir: dirOfVoices() });
      d.onPocketServer?.(pocketServer);
    }
    return pocketServer;
  };
  const pocket: CloneEngine = {
    id: "pocket",
    label: POCKET_CLONE_LABEL,
    note: POCKET_CLONE_NOTE,
    available: () => pocketCloneAvailability(pocketPaths(dirOfSpeech()), pocketClonePaths(dirOfSpeech()), d.exists, readText),
    synthesize: (voice, text, opts) => server().synthesize(text, `${CLONE_VOICE_PREFIX}${voice.id}`, opts.signal),
    forget: id => {
      pocketServer?.stopVoice(`${CLONE_VOICE_PREFIX}${id}`);
    },
  };

  const qwen: CloneEngine = {
    id: "qwen3-base",
    label: QWEN_CLONE_LABEL,
    note: QWEN_CLONE_NOTE,
    available: () => qwenCloneAvailability(qwenClonePaths(dirOfSpeech()), platform(), arch(), d.exists, readText),
    synthesize: (voice, text, opts) => {
      const paths = qwenClonePaths(dirOfSpeech());
      return synthesizeWithQwenClone(
        text,
        { audio: voice.referencePath, text: voice.text },
        paths,
        {
          tmpDir: d.tmpDir,
          unique: `${Date.now()}_${d.unique()}`,
          language: qwenLanguageName(opts.language),
          env: cloneProcessEnv(paths.hfHome, d.env()),
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
        d,
      );
    },
    // Ein Prozess je Aufruf: nichts zu beenden
    forget: () => {},
  };

  const engines: CloneEngine[] = [pocket, qwen];

  /** Gewählte und eingerichtete Engine, sonst die erste eingerichtete; null ohne Engine */
  function activeEngine(): CloneEngine | null {
    const wanted = selection().engine;
    const preferred = wanted ? engines.find(e => e.id === wanted) : undefined;
    if (preferred && preferred.available().ok) return preferred;
    return engines.find(e => e.available().ok) ?? null;
  }

  function engineStatus(): CloneEngineStatus {
    const e = activeEngine();
    if (e) return { ready: true, id: e.id, label: e.label, note: e.note };
    return { ready: false, reason: `Keine Klon-Engine eingerichtet. Einrichten mit ${BRAND.cli} setup sprache (Pocket TTS mit Hugging-Face-Zugang oder auf dem Mac Qwen3-TTS Base).` };
  }

  /** Stimme lesen, Engine wählen, vorlesen, kennzeichnen */
  async function speak(id: string, text: string, opts: { language?: string; signal?: AbortSignal }): Promise<CloneProbeResult> {
    const voice = await voices().get(id);
    if (!voice) return { ok: false, reason: "unbekannt" };
    const engine = activeEngine();
    if (!engine) return { ok: false, reason: "engine" };
    let audio: Buffer;
    try {
      audio = await engine.synthesize(voice, text, opts);
    } catch {
      return { ok: false, reason: "failed" };
    }
    // Die Stimme kann während des Vorlesens gelöscht worden sein: dann keine Ausgabe
    if (!(await voices().get(id))) return { ok: false, reason: "unbekannt" };
    if (!wavDurationSeconds(audio)) return { ok: false, reason: "failed" };
    return { ok: true, audio: tagWavAiGenerated(audio, { cloned: true }), engine: engine.id };
  }

  const provider: TtsProvider = {
    id: "clone",
    get label() {
      const id = selection().voice;
      const name = id ? voiceNameSync(dirOfVoices(), id, readText) : null;
      return name ? clonedVoiceLabel(name) : "Eigene Stimme (KI-Stimme)";
    },
    local: true,
    where: "server",
    available: () => {
      const id = selection().voice;
      if (!id || !voiceNameSync(dirOfVoices(), id, readText)) return { ok: false, reason: "keine eigene Stimme gewählt (Abschnitt Eigene Stimme)" };
      if (!activeEngine()) return { ok: false, reason: `keine Klon-Engine eingerichtet, ${BRAND.cli} setup sprache ausführen` };
      return { ok: true };
    },
    // Je Aufruf keine andere Stimme: es gilt die gewählte eigene Stimme
    voiceAllowed: () => false,
    synthesize: async (text, opts) => {
      if (opts.voice !== undefined) throw new SpeechError("unavailable");
      const id = selection().voice;
      if (!id) throw new SpeechError("unavailable");
      const r = await speak(id, text, { ...(opts.language ? { language: opts.language } : {}), ...(opts.signal ? { signal: opts.signal } : {}) });
      if (!r.ok) throw new SpeechError(r.reason === "failed" ? "exit" : "unavailable");
      return { audio: r.audio, mime: "audio/wav" };
    },
  };

  return {
    provider,
    engines,
    activeEngine,
    engineStatus,
    /** Testsatz mit einer (auch noch nicht gewählten) Stimme */
    probe: (id: string, text: string) => speak(id, text, { language: "de" }),
    /** Gelöschte Stimme: laufende Prozesse mit ihr beenden */
    forget(id: string) {
      for (const e of engines) e.forget(id);
    },
    voices,
  };
}

/** Sprachname für mlx-audio (wie qwenLanguage in ./providers.ts, Standard german) */
function qwenLanguageName(code: string | undefined): string {
  const map: Record<string, string> = { de: "german", en: "english" };
  return map[(code ?? "de").toLowerCase()] ?? "german";
}

