/**
 * Teil „Stimme“ im Schritt „sprache“ (Issue #252, Entscheidung 0023): womit
 * der Sprechmodus vorliest.
 *
 * - Browser-Stimme (Standard): nichts zu installieren.
 * - Lokale Stimme Pocket TTS (Kyutai, CC-BY-4.0): eigenes venv unter
 *   models/speech/pocket/ mit pocket-tts in der geprüften Version (auf Linux
 *   PyTorch aus dem CPU-Index, sonst zieht pip rund 3 GB CUDA-Pakete), dann
 *   Modell und Stimme in den eigenen Hugging-Face-Ordner. Danach eine Probe
 *   mit Zeitmessung: Ladezeit des Modells getrennt, RTF = Rechenzeit der
 *   Synthese geteilt durch die Dauer des erzeugten Tons. Erst nach der Probe
 *   der Nachweis pocket.ok.json und die hörbare Probe-Datei.
 * - Ist Pocket langsamer als Echtzeit (RTF > 1), wird es nicht eingestellt.
 *   Mit Zustimmung (Feld SPRACHE_PIPER_BEI_LANGSAM) richtet der Lauf Piper ein
 *   und stellt darauf um, sonst steht der Vorschlag im Ergebnis.
 * - Piper (GPL-3.0, eigener Prozess, Stimme Thorsten CC0) auch direkt wählbar.
 * - ElevenLabs nur mit ELEVENLABS_API_KEY und ELEVENLABS_VOICE_ID; Cloud.
 *
 * Alles lädt erst nach „Jetzt ausführen?“ (Plan mit Größen). Beim späteren
 * Vorlesen lädt nichts nach (HF_HUB_OFFLINE im Bot, ./pocket.ts).
 *
 * Abbruch und Fehler: Eine halb installierte Python-Umgebung wird gelöscht;
 * der nächste Lauf legt sie neu an und nimmt die Pakete aus dem pip-Cache
 * (Wiederaufnahme). Halbe Modell-Downloads bleiben im Hugging-Face-Ordner
 * liegen und werden beim nächsten Lauf fortgesetzt: vollständig ist das
 * Modell erst mit dem Nachweis model.ok, ohne ihn lädt jeder Lauf (nach Ja)
 * weiter, statt nur die Offline-Probe zu starten. Halbe Piper-Dateien
 * löscht der Download-Baustein aus Issue #251.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BRAND } from "../brand";
import { SettingsFileInvalidError, updateSettings } from "../lib/settings";
import type { TtsChoice } from "../lib/speech/ids";
import type { Artifact } from "../lib/speech/parakeet";
import { speechDir } from "../lib/speech/parakeet";
import {
  PIPER_ARTIFACTS,
  PIPER_ATTRIBUTION,
  PIPER_VERSION,
  PIPER_VOICE,
  piperAvailability,
  piperPaths,
  synthesizeWithPiper,
  type PiperArtifactId,
  type PiperProof,
} from "../lib/speech/piper";
import {
  BASE_ENV_NAMES,
  createPocketServer,
  POCKET_ATTRIBUTION,
  POCKET_DEFAULT_VOICE,
  POCKET_LANGUAGE,
  POCKET_VERSION,
  pocketAvailability,
  pocketEnv,
  pocketPaths,
  realPocketServerDeps,
  type PocketProof,
  type PocketServerDeps,
} from "../lib/speech/pocket";
import { describeSpeechError } from "../lib/speech/types";
import { tagWavAiGenerated, wavDurationSeconds } from "../lib/speech/wav";
import type { SetupContext } from "./context";
import type { RunReport } from "./model";
import { runFnFromContext } from "./parakeet-probe";
import { installArtifacts, nodeDownloadFs, type DownloadFs } from "./speech-download";

export const VOICE_FIELD = "SPRACHE_STIMME";
export const PIPER_FALLBACK_FIELD = "SPRACHE_PIPER_BEI_LANGSAM";

/** keep: die bisherige Einstellung bleibt (etwa qwen3-mlx oder gemini, die hier nicht wählbar sind) */
export type VoiceChoice = "keep" | "browser" | "pocket" | "piper" | "elevenlabs";
export const VOICE_CHOICES: readonly VoiceChoice[] = ["keep", "browser", "pocket", "piper", "elevenlabs"];

// Download und Platz: gemessen am 01.10.2026 mit pip download bzw. im venv
// (Mac mit Apple Silicon); Linux nach Größe der Wheels von PyTorch (CPU-Index)
export const POCKET_RUNTIME_MB: Record<string, number> = { darwin: 170, linux: 250 };
export const POCKET_MODEL_MB = 220;
/** Platz nach der Installation: venv rund 0,93 GB plus Modell */
export const POCKET_DISK_BYTES = 1_200_000_000;
/** Während der Installation zusätzlich (pip entpackt die Wheels) */
export const POCKET_DISK_NEEDED = 1_600_000_000;
export const PIPER_RUNTIME_MB = 60;
export const PIPER_VOICE_MB = 63;
export const PIPER_DISK_NEEDED = 400_000_000;

/** Zeitlimits: Installation und Download dürfen bei langsamer Leitung lange dauern */
const VENV_TIMEOUT_MS = 5 * 60 * 1000;
const PIP_TIMEOUT_MS = 45 * 60 * 1000;
const MODEL_TIMEOUT_MS = 45 * 60 * 1000;
const PYTHON_CHECK_MS = 15_000;

export const PYTORCH_CPU_INDEX = "https://download.pytorch.org/whl/cpu";

/** Satz für die Probe, in der Sprache des Modells */
export const VOICE_PROBE_TEXT = `Hallo, hier spricht ${BRAND.name} mit lokaler Stimme. So klingt das Vorlesen im Sprechmodus.`;

export const VOICE_LABELS: Record<VoiceChoice, string> = {
  keep: "Beibehalten (die bisherige Einstellung bleibt unverändert)",
  browser: "Browser-Stimme (ohne Installation, klingt je nach Gerät anders)",
  pocket: `Lokale Stimme Jürgen, empfohlen: privat, alles auf deinem Rechner (Pocket TTS, Download ca. ${POCKET_RUNTIME_MB.darwin} bis ${POCKET_RUNTIME_MB.linux} MB Laufzeit plus ca. ${POCKET_MODEL_MB} MB Modell, CC-BY-4.0 Kyutai)`,
  piper: `Piper für schwache Rechner (Download ca. ${PIPER_RUNTIME_MB} MB Laufzeit plus ca. ${PIPER_VOICE_MB} MB Stimme, GPL-3.0, Stimme Thorsten CC0)`,
  elevenlabs: "ElevenLabs, optional (mit vorhandenem Schlüssel und ELEVENLABS_VOICE_ID; Cloud: Text geht an ElevenLabs, kostet Guthaben je Zeichen)",
};

/** Plattformen mit passenden Paketen (PyTorch für Pocket, onnxruntime für Piper) */
export function voicePlatformOk(platform: string, arch: string): boolean {
  return (platform === "darwin" && arch === "arm64") || (platform === "linux" && (arch === "x64" || arch === "arm64"));
}

export interface VoiceInventory {
  /** Wirksame Wahl fürs Sprechen (Datei vor SPEECH_TTS vor auto) */
  tts: TtsChoice;
  platformOk: boolean;
  /** python3 im PATH */
  python: boolean;
  elevenVoice: boolean;
  pocket: { program: boolean; model: boolean; ok: boolean };
  piper: { program: boolean; voice: boolean; ok: boolean };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Nur Dateien und PATH, kein Prozess */
export function voiceInventory(ctx: SetupContext, env: Record<string, string | undefined>, tts: TtsChoice): VoiceInventory {
  const dir = speechDir(ctx.root);
  const p = pocketPaths(dir);
  const i = piperPaths(dir);
  const arch = ctx.arch ?? process.arch;
  const which = ctx.which ?? ((c: string) => Bun.which(c));
  const voice = env.POCKET_TTS_VOICE || POCKET_DEFAULT_VOICE;
  return {
    tts,
    platformOk: voicePlatformOk(ctx.platform, arch),
    python: !!which("python3"),
    elevenVoice: !!env.ELEVENLABS_API_KEY && !!env.ELEVENLABS_VOICE_ID,
    pocket: { program: existsSync(p.program), model: existsSync(p.modelReady), ok: pocketAvailability(p, existsSync, readText, voice).ok },
    piper: { program: existsSync(i.program), voice: existsSync(i.model) && existsSync(i.config), ok: piperAvailability(i, existsSync, readText).ok },
  };
}

/**
 * Vorauswahl im Feld: die eingestellte Stimme, auto gilt als Browser-Stimme.
 * Eine hier nicht wählbare Einstellung (qwen3-mlx, gemini) bleibt: keep.
 */
export function voicePreselect(tts: TtsChoice): VoiceChoice {
  if (tts === "auto" || tts === "browser") return "browser";
  return (VOICE_CHOICES as readonly string[]).includes(tts) ? (tts as VoiceChoice) : "keep";
}

export function isVoiceChoice(v: unknown): v is VoiceChoice {
  return typeof v === "string" && (VOICE_CHOICES as readonly string[]).includes(v);
}

function mbText(n: number): string {
  return `ca. ${n} MB`;
}

/** Plan-Sätze für den Teil Stimme */
export function voicePlan(inv: VoiceInventory, choice: VoiceChoice, piperFallback: boolean, platform: string): string[] {
  const out: string[] = [];
  const runtime = POCKET_RUNTIME_MB[platform] ?? POCKET_RUNTIME_MB.linux;
  if (choice === "keep") return [`Vorlesen bleibt unverändert (${inv.tts === "auto" ? "automatisch" : inv.tts}), nichts zu installieren.`];
  if (choice === "browser") {
    out.push(inv.tts === "auto" || inv.tts === "browser" ? "Vorlesen: Browser-Stimme, nichts zu installieren." : "Vorlesen: zurück auf die Browser-Stimme, nichts zu installieren.");
    return out;
  }
  if (choice === "elevenlabs") {
    out.push(inv.elevenVoice ? "Vorlesen: ElevenLabs. Cloud: der vorzulesende Text geht an ElevenLabs." : "ElevenLabs braucht ELEVENLABS_API_KEY und ELEVENLABS_VOICE_ID in der .env; ohne beide ändert sich nichts.");
    return out;
  }
  if (!inv.platformOk) return ["Lokale Stimmen gibt es hier nicht (unterstützt: Mac mit Apple Silicon, Linux x64 und arm64). Es wird nichts heruntergeladen."];
  if (!inv.python) out.push("python3 fehlt (3.10 bis 3.14). Bitte zuerst Python installieren; es wird nichts heruntergeladen.");
  if (choice === "pocket") {
    if (inv.pocket.ok) out.push("Pocket TTS ist eingerichtet und geprüft. Es wird nichts geladen, die Probe läuft noch einmal mit Zeitmessung.");
    else {
      const parts: string[] = [];
      if (!inv.pocket.program) parts.push(`Laufzeit pocket-tts ${POCKET_VERSION} mit PyTorch ${mbText(runtime)}${platform === "linux" ? " (PyTorch aus dem CPU-Index, ohne CUDA)" : ""}`);
      if (!inv.pocket.model) parts.push(`deutsches Modell (6 Schichten) und Stimme juergen ${mbText(POCKET_MODEL_MB)}`);
      if (parts.length) out.push(`Lokale Stimme Pocket TTS: Download ${parts.join(", ")}, auf der Platte danach ca. 1,2 GB unter models/speech/pocket/. Während der Installation braucht es kurz ca. 1,6 GB frei.`);
      out.push("Der Download beginnt erst nach deinem Ja. Abbrechen löscht eine halbe Python-Umgebung; ein halber Modell-Download wird beim nächsten Lauf fortgesetzt.");
    }
    out.push("Danach eine Probe: Modell laden (Zeit getrennt gemessen), einen Satz vorlesen, Echtzeitfaktor RTF = Rechenzeit geteilt durch Tondauer. Die Probe-Datei kannst du anhören.");
    out.push(
      piperFallback
        ? `Ist Pocket hier langsamer als Echtzeit (RTF über 1), richtet der Lauf stattdessen Piper ein (Download ${mbText(PIPER_RUNTIME_MB)} Laufzeit plus ${mbText(PIPER_VOICE_MB)} Stimme) und stellt das Vorlesen darauf um.`
        : "Ist Pocket hier langsamer als Echtzeit (RTF über 1), bleibt das Vorlesen unverändert und das Ergebnis schlägt Piper vor.",
    );
    out.push(`${POCKET_ATTRIBUTION}.`);
    return out;
  }
  // piper
  if (inv.piper.ok) out.push("Piper ist eingerichtet und geprüft. Es wird nichts geladen, die Probe läuft noch einmal.");
  else {
    out.push(`Piper: Download ${mbText(PIPER_RUNTIME_MB)} Laufzeit (piper-tts ${PIPER_VERSION}) plus ${mbText(PIPER_VOICE_MB)} Stimme ${PIPER_VOICE}, auf der Platte danach ca. 250 MB unter models/speech/piper/.`);
    out.push("Der Download beginnt erst nach deinem Ja, die Stimme mit Prüfsumme. Abbrechen löscht halbe Dateien.");
  }
  out.push("Danach eine Probe mit Zeitmessung, die Probe-Datei kannst du anhören.");
  out.push(`${PIPER_ATTRIBUTION}.`);
  return out;
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

export interface VoiceRunDeps {
  /** Pocket-Prozess für die Probe; fehlt: echte (Bun.spawn) */
  pocketServer?: PocketServerDeps;
  fs?: DownloadFs;
  /** Nur Tests: eigene Piper-Dateien statt der echten */
  piperArtifacts?: Artifact<PiperArtifactId>[];
}

export interface VoiceRunResult {
  ok: boolean;
  message: string;
  changed: string[];
  /** Hörbare Probe dieses Laufs */
  audio?: "pocket" | "piper";
}

export interface ProbeMeasure {
  loadMs: number | null;
  synthMs: number;
  audioSeconds: number;
  rtf: number;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(2).replace(".", ",")} s`;
}

function rtfText(rtf: number): string {
  return rtf.toFixed(2).replace(".", ",");
}

export function describeMeasure(m: ProbeMeasure): string {
  const load = m.loadMs !== null ? `Modell geladen in ${seconds(m.loadMs)}, ` : "";
  return `${load}${m.audioSeconds.toFixed(1).replace(".", ",")} s Ton in ${seconds(m.synthMs)} erzeugt (RTF ${rtfText(m.rtf)}, ${m.rtf <= 1 ? "schneller als Echtzeit" : "langsamer als Echtzeit"}).`;
}

/** Nur ausgewählte Variablen (Pfad, Proxy), nie Schlüssel; pip ohne Rückfragen */
export function pipEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const n of BASE_ENV_NAMES) {
    const v = process.env[n];
    if (v !== undefined) env[n] = v;
  }
  env.PIP_DISABLE_PIP_VERSION_CHECK = "1";
  env.PIP_NO_INPUT = "1";
  return env;
}

/** Python 3.10 bis 3.14 (pocket-tts 3.3.0: >=3.10,<3.15); Piper ab 3.9 */
export async function checkPython(ctx: SetupContext, min: number, signal: AbortSignal): Promise<string | null> {
  const which = ctx.which ?? ((c: string) => Bun.which(c));
  if (!which("python3")) return "python3 fehlt. Bitte Python 3.10 bis 3.14 installieren (Mac: python.org oder Homebrew; Linux: Paket python3 und python3-venv).";
  const r = await ctx.run(["python3", "-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { timeoutMs: PYTHON_CHECK_MS, signal, env: pipEnv() });
  const m = /^3\.(\d+)$/.exec(r.stdout.trim());
  if (r.code !== 0 || !m) return "python3 ließ sich nicht starten.";
  const minor = Number(m[1]);
  if (minor < min || minor > 14) return `python3 ist Version 3.${minor}; nötig ist 3.${min} bis 3.14.`;
  return null;
}

/** venv anlegen und ein Paket installieren; bei Fehler oder Abbruch ist das venv gelöscht */
export async function installVenv(ctx: SetupContext, venv: string, python: string, packages: string[], signal: AbortSignal, report: (label: string) => void, label: string): Promise<{ ok: true } | { ok: false; aborted: boolean; message: string }> {
  await rm(venv, { recursive: true, force: true });
  await mkdir(join(venv, ".."), { recursive: true });
  report("Lege eine eigene Python-Umgebung an");
  const v = await ctx.run(["python3", "-m", "venv", venv], { timeoutMs: VENV_TIMEOUT_MS, signal, env: pipEnv() });
  if (signal.aborted || v.code !== 0) {
    await rm(venv, { recursive: true, force: true });
    return signal.aborted
      ? { ok: false, aborted: true, message: "Abgebrochen. Die halbe Python-Umgebung ist gelöscht." }
      : { ok: false, aborted: false, message: `Python-Umgebung ließ sich nicht anlegen (auf Debian und Raspberry Pi OS fehlt oft python3-venv: sudo apt install python3-venv).` };
  }
  report(label);
  const extra = ctx.platform === "linux" && packages.some(p => p.startsWith("pocket-tts")) ? ["--extra-index-url", PYTORCH_CPU_INDEX] : [];
  const pip = await ctx.run([python, "-m", "pip", "install", "--disable-pip-version-check", "--no-input", ...extra, ...packages], { timeoutMs: PIP_TIMEOUT_MS, signal, env: pipEnv() });
  if (signal.aborted || pip.code !== 0) {
    await rm(venv, { recursive: true, force: true });
    if (signal.aborted) return { ok: false, aborted: true, message: "Abgebrochen. Die halbe Python-Umgebung ist gelöscht; der nächste Lauf nimmt schon geladene Pakete aus dem pip-Cache." };
    return { ok: false, aborted: false, message: `Installation mit pip fehlgeschlagen (${pip.timedOut ? "Zeitlimit" : `Exit-Code ${pip.code}`}). Die halbe Python-Umgebung ist gelöscht; der nächste Lauf nimmt schon geladene Pakete aus dem pip-Cache.` };
  }
  return { ok: true };
}

async function setTts(ctx: SetupContext, tts: TtsChoice): Promise<string | null> {
  try {
    await updateSettings(s => ({ ...s, speech: { ...s.speech, tts } }), { path: ctx.settingsPath });
    return null;
  } catch (e) {
    return e instanceof SettingsFileInvalidError ? "config/settings.json ist ungültig" : "config/settings.json ließ sich nicht schreiben";
  }
}

/** Wo die Probe zu hören ist: im Browser darunter, im Terminal mit Befehl zum Abspielen und zum Schicken */
function playHint(path: string, ctx: SetupContext): string {
  if (ctx.browserSetup) return "Probe unten anhören.";
  const rel = path.startsWith(ctx.root + "/") ? path.slice(ctx.root.length + 1) : path;
  const play = ctx.platform === "darwin" ? `afplay ${rel}` : `aplay ${rel}`;
  return `Probe anhören: ${play}; ans Handy schicken: bun run notify --source datei --file ${rel}.`;
}

/** Pocket: Installation, Modell, Probe; wirft nie */
async function runPocket(
  ctx: SetupContext,
  inv: VoiceInventory,
  signal: AbortSignal,
  step: (label: string) => void,
  deps: VoiceRunDeps,
): Promise<{ ok: boolean; message: string; changed: string[]; measure?: ProbeMeasure }> {
  const dir = speechDir(ctx.root);
  const paths = pocketPaths(dir);
  const changed: string[] = [];
  const pyErr = await checkPython(ctx, 10, signal);
  if (signal.aborted) return { ok: false, message: "Abgebrochen. Nichts wurde geändert.", changed };
  if (pyErr) return { ok: false, message: `${pyErr} Es wurde nichts heruntergeladen.`, changed };
  if (!inv.pocket.program || !inv.pocket.model) {
    const free = await (ctx.freeDisk ?? (async () => null))(dir);
    if (free !== null && free < POCKET_DISK_NEEDED) {
      return { ok: false, message: `Zu wenig Platz: nötig sind ca. 1,6 GB frei, frei sind ca. ${Math.round(free / 1_000_000)} MB. Es wurde nichts heruntergeladen.`, changed };
    }
  }
  await mkdir(paths.dir, { recursive: true });
  if (!inv.pocket.program) {
    const runtime = POCKET_RUNTIME_MB[ctx.platform] ?? POCKET_RUNTIME_MB.linux;
    const inst = await installVenv(ctx, paths.venv, paths.python, [`pocket-tts==${POCKET_VERSION}`], signal, step, `Lade pocket-tts ${POCKET_VERSION} mit PyTorch (ca. ${runtime} MB), das dauert einige Minuten`);
    if (!inst.ok) return { ok: false, message: inst.message, changed };
    changed.push(paths.venv);
  }
  // Ohne Nachweis model.ok ist der Download unvollständig (auch wenn modelCache schon da ist): fortsetzen
  if (!existsSync(paths.modelReady)) {
    step(`Lade das deutsche Modell und die Stimme juergen (ca. ${POCKET_MODEL_MB} MB)`);
    const tmp = join(paths.dir, `.tmp-load-${randomBytes(4).toString("hex")}.wav`);
    // Einmal online erzeugen: pocket-tts lädt dabei Modell, Tokenizer und Stimme in HF_HOME
    const r = await ctx.run([paths.program, "generate", "-q", "--language", POCKET_LANGUAGE, "--voice", POCKET_DEFAULT_VOICE, "--text", "Probe.", "--output-path", tmp], {
      timeoutMs: MODEL_TIMEOUT_MS,
      signal,
      env: pocketEnv(paths, process.env, false),
      cwd: paths.dir,
    });
    await rm(tmp, { force: true });
    if (signal.aborted) return { ok: false, message: "Abgebrochen. Ein halber Modell-Download wird beim nächsten Lauf fortgesetzt.", changed };
    if (r.code !== 0 || !existsSync(paths.modelCache)) {
      return { ok: false, message: `Modell ließ sich nicht laden (${r.timedOut ? "Zeitlimit" : `Exit-Code ${r.code}`}). Der nächste Lauf setzt den Download fort.`, changed };
    }
    await writeFile(paths.modelReady, JSON.stringify({ version: 1, pocket: POCKET_VERSION, language: POCKET_LANGUAGE, voice: POCKET_DEFAULT_VOICE }) + "\n", { mode: 0o600 });
    changed.push(paths.hfHome);
  }

  step("Probe: Modell laden und einen Satz vorlesen (ohne Netz)");
  await rm(paths.proof, { force: true });
  const server = createPocketServer({ paths, env: () => process.env, deps: deps.pocketServer ?? realPocketServerDeps });
  let measure: ProbeMeasure;
  let audio: Buffer;
  try {
    const t0 = ctx.now().getTime();
    await server.warmUp(POCKET_DEFAULT_VOICE, signal);
    const t1 = ctx.now().getTime();
    if (signal.aborted) return { ok: false, message: "Abgebrochen. Kein Nachweis geschrieben.", changed };
    audio = await server.synthesize(VOICE_PROBE_TEXT, POCKET_DEFAULT_VOICE, signal);
    const t2 = ctx.now().getTime();
    const duration = wavDurationSeconds(audio);
    if (!duration) return { ok: false, message: "Probe nicht bestanden: die Antwort war kein lesbares WAV. Kein Nachweis geschrieben.", changed };
    measure = { loadMs: t1 - t0, synthMs: t2 - t1, audioSeconds: duration, rtf: (t2 - t1) / 1000 / duration };
  } catch (e) {
    if (signal.aborted) return { ok: false, message: "Abgebrochen. Kein Nachweis geschrieben.", changed };
    return { ok: false, message: `Probe nicht bestanden (${describeSpeechError(e)}). Kein Nachweis geschrieben, das Vorlesen bleibt unverändert.`, changed };
  } finally {
    server.stop();
  }
  if (signal.aborted) return { ok: false, message: "Abgebrochen. Kein Nachweis geschrieben.", changed };
  await writeFile(paths.probeWav, tagWavAiGenerated(audio), { mode: 0o600 });
  const proof: PocketProof = {
    version: 1,
    pocket: POCKET_VERSION,
    language: POCKET_LANGUAGE,
    voice: POCKET_DEFAULT_VOICE,
    probe: { loadMs: measure.loadMs ?? 0, synthMs: measure.synthMs, audioSeconds: Math.round(measure.audioSeconds * 100) / 100, rtf: Math.round(measure.rtf * 1000) / 1000, at: ctx.now().toISOString() },
  };
  await writeFile(paths.proof, JSON.stringify(proof, null, 2) + "\n", { mode: 0o600 });
  changed.push(paths.proof, paths.probeWav);
  return { ok: true, message: `Probe bestanden. ${describeMeasure(measure)}`, changed, measure };
}

/** Piper: Installation, Stimme, Probe; wirft nie */
async function runPiper(
  ctx: SetupContext,
  inv: VoiceInventory,
  signal: AbortSignal,
  step: (label: string) => void,
  deps: VoiceRunDeps,
): Promise<{ ok: boolean; message: string; changed: string[]; measure?: ProbeMeasure }> {
  const dir = speechDir(ctx.root);
  const paths = piperPaths(dir);
  const changed: string[] = [];
  const pyErr = await checkPython(ctx, 9, signal);
  if (signal.aborted) return { ok: false, message: "Abgebrochen. Nichts wurde geändert.", changed };
  if (pyErr) return { ok: false, message: `${pyErr} Es wurde nichts heruntergeladen.`, changed };
  if (!inv.piper.program || !inv.piper.voice) {
    const free = await (ctx.freeDisk ?? (async () => null))(dir);
    if (free !== null && free < PIPER_DISK_NEEDED) {
      return { ok: false, message: `Zu wenig Platz: nötig sind ca. 400 MB frei, frei sind ca. ${Math.round(free / 1_000_000)} MB. Es wurde nichts heruntergeladen.`, changed };
    }
  }
  await mkdir(paths.dir, { recursive: true });
  if (!inv.piper.program) {
    const inst = await installVenv(ctx, paths.venv, paths.python, [`piper-tts==${PIPER_VERSION}`], signal, step, `Lade piper-tts ${PIPER_VERSION} (ca. ${PIPER_RUNTIME_MB} MB)`);
    if (!inst.ok) return { ok: false, message: inst.message, changed };
    changed.push(paths.venv);
  }
  const arts = (deps.piperArtifacts ?? PIPER_ARTIFACTS).filter(a => !existsSync(join(dir, a.target)));
  if (arts.length) {
    step(`Lade die Stimme ${PIPER_VOICE} (ca. ${PIPER_VOICE_MB} MB, mit Prüfsumme)`);
    const got = await installArtifacts(dir, arts, { fetch: ctx.fetch, fs: deps.fs ?? nodeDownloadFs, run: ctx.run, signal });
    if (!got.ok) return { ok: false, message: got.aborted ? "Abgebrochen. Halbe Dateien sind gelöscht." : `${got.message} Halbe Dateien sind gelöscht.`, changed };
    changed.push(paths.model);
  }
  step("Probe: einen Satz vorlesen");
  await rm(paths.proof, { force: true });
  const tmpDir = join(paths.dir, `.tmp-probe-${randomBytes(4).toString("hex")}`);
  let audio: Buffer;
  let measure: ProbeMeasure;
  try {
    const t0 = ctx.now().getTime();
    audio = await synthesizeWithPiper(VOICE_PROBE_TEXT, paths, { tmpDir, unique: "probe", signal }, {
      run: runFnFromContext(ctx),
      writeFile: (p, d) => writeFile(p, d),
      readFile: p => readFile(p),
      unlink: p => rm(p, { force: true }),
      mkdir: async p => {
        await mkdir(p, { recursive: true });
      },
      exists: existsSync,
    });
    const ms = ctx.now().getTime() - t0;
    const duration = wavDurationSeconds(audio);
    if (!duration) return { ok: false, message: "Probe nicht bestanden: die Antwort war kein lesbares WAV. Kein Nachweis geschrieben.", changed };
    measure = { loadMs: null, synthMs: ms, audioSeconds: duration, rtf: ms / 1000 / duration };
  } catch (e) {
    if (signal.aborted) return { ok: false, message: "Abgebrochen. Kein Nachweis geschrieben.", changed };
    return { ok: false, message: `Probe nicht bestanden (${describeSpeechError(e)}). Kein Nachweis geschrieben, das Vorlesen bleibt unverändert.`, changed };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  if (signal.aborted) return { ok: false, message: "Abgebrochen. Kein Nachweis geschrieben.", changed };
  await writeFile(paths.probeWav, tagWavAiGenerated(audio), { mode: 0o600 });
  const proof: PiperProof = {
    version: 1,
    piper: PIPER_VERSION,
    voice: PIPER_VOICE,
    probe: { synthMs: measure.synthMs, audioSeconds: Math.round(measure.audioSeconds * 100) / 100, rtf: Math.round(measure.rtf * 1000) / 1000, at: ctx.now().toISOString() },
  };
  await writeFile(paths.proof, JSON.stringify(proof, null, 2) + "\n", { mode: 0o600 });
  changed.push(paths.proof, paths.probeWav);
  return { ok: true, message: `Probe bestanden (Ladezeit inbegriffen, Piper startet je Aufruf neu). ${describeMeasure(measure)}`, changed, measure };
}

/**
 * Ablauf Teil „Stimme“. settingsValid: config/settings.json lesbar (sonst
 * keine Umstellung). Wirft nie.
 */
export async function runVoice(
  values: Record<string, string>,
  ctx: SetupContext,
  inv: VoiceInventory & { settingsValid: boolean },
  report: RunReport,
  signal: AbortSignal,
  deps: VoiceRunDeps = {},
): Promise<VoiceRunResult> {
  // Ohne Eingabe bleibt die bisherige Einstellung (nie still auf browser umstellen)
  const raw = values[VOICE_FIELD] ?? voicePreselect(inv.tts);
  const choice: VoiceChoice = isVoiceChoice(raw) ? raw : "keep";
  const piperFallback = (values[PIPER_FALLBACK_FIELD] ?? "false") === "true";
  // Teilschritte: venv und pip, Modell bzw. Stimme, Probe, Einstellung; Vorhandenes zählt nicht mit
  const pocketSteps = (inv.pocket.program ? 0 : 2) + (inv.pocket.model ? 0 : 1) + 1;
  const piperSteps = (inv.piper.program ? 0 : 2) + (inv.piper.voice ? 0 : 1) + 1;
  let at = 0;
  let total = choice === "pocket" ? pocketSteps + 1 : choice === "piper" ? piperSteps + 1 : 1;
  const step = (label: string) => {
    at++;
    // Piper nach zu langsamem Pocket: die Schritte kommen dazu
    if (at > total) total = at;
    report({ at, total, label: `Stimme: ${label}` });
  };

  if (choice === "keep") return { ok: true, message: `Vorlesen bleibt unverändert (${inv.tts === "auto" ? "automatisch" : inv.tts}).`, changed: [] };

  if (choice === "browser") {
    if (inv.tts === "auto" || inv.tts === "browser") return { ok: true, message: "Vorlesen: Browser-Stimme, nichts installiert.", changed: [] };
    if (!inv.settingsValid) return { ok: false, message: "config/settings.json ist ungültig; das Vorlesen ist nicht umgestellt.", changed: [] };
    step("Einstellung fürs Vorlesen");
    const err = await setTts(ctx, "browser");
    return err ? { ok: false, message: `${err}; das Vorlesen ist nicht umgestellt.`, changed: [] } : { ok: true, message: "Vorlesen steht jetzt auf der Browser-Stimme.", changed: [ctx.settingsPath] };
  }

  if (choice === "elevenlabs") {
    if (!inv.elevenVoice) return { ok: false, message: "ElevenLabs braucht ELEVENLABS_API_KEY und ELEVENLABS_VOICE_ID in der .env (WebUI: Einstellungen, Schlüssel). Das Vorlesen ist nicht umgestellt.", changed: [] };
    if (inv.tts === "elevenlabs") return { ok: true, message: "Vorlesen steht schon auf ElevenLabs (Cloud: Text geht an ElevenLabs).", changed: [] };
    if (!inv.settingsValid) return { ok: false, message: "config/settings.json ist ungültig; das Vorlesen ist nicht umgestellt.", changed: [] };
    step("Einstellung fürs Vorlesen");
    const err = await setTts(ctx, "elevenlabs");
    return err ? { ok: false, message: `${err}; das Vorlesen ist nicht umgestellt.`, changed: [] } : { ok: true, message: "Vorlesen steht jetzt auf ElevenLabs. Cloud: der vorzulesende Text geht an ElevenLabs.", changed: [ctx.settingsPath] };
  }

  if (!inv.platformOk) return { ok: false, message: "Lokale Stimmen gibt es hier nicht (unterstützt: Mac mit Apple Silicon, Linux x64 und arm64). Es wurde nichts heruntergeladen.", changed: [] };
  if (!inv.settingsValid) return { ok: false, message: "config/settings.json ist ungültig. Bitte erst reparieren oder in der WebUI neu speichern; nichts wurde geladen.", changed: [] };
  if (signal.aborted) return { ok: false, message: "Abgebrochen. Nichts wurde geändert.", changed: [] };

  const finish = async (id: "pocket" | "piper", body: string, changed: string[]): Promise<VoiceRunResult> => {
    const probe = id === "pocket" ? pocketPaths(speechDir(ctx.root)).probeWav : piperPaths(speechDir(ctx.root)).probeWav;
    const hint = playHint(probe, ctx);
    const attribution = `${id === "pocket" ? POCKET_ATTRIBUTION : PIPER_ATTRIBUTION}.`;
    if (signal.aborted) return { ok: false, message: `${body} Abgebrochen. Das Vorlesen ist nicht umgestellt.`, changed, audio: id };
    if (inv.tts === id) return { ok: true, message: `${body} Vorlesen steht schon auf ${id === "pocket" ? "Pocket TTS" : "Piper"}. ${attribution} ${hint}`, changed, audio: id };
    step("Einstellung fürs Vorlesen");
    const err = await setTts(ctx, id);
    if (err) return { ok: false, message: `${body} ${err}; das Vorlesen ist nicht umgestellt. ${hint}`, changed, audio: id };
    return {
      ok: true,
      message: `${body} Vorlesen steht jetzt auf ${id === "pocket" ? "Pocket TTS" : "Piper"}, ohne Neustart. ${attribution} ${hint}`,
      changed: [...changed, ctx.settingsPath],
      audio: id,
    };
  };

  if (choice === "piper") {
    const r = await runPiper(ctx, inv, signal, step, deps);
    if (!r.ok) return { ok: false, message: `Piper: ${r.message}`, changed: r.changed };
    return finish("piper", `Piper ist eingerichtet. ${r.message}`, r.changed);
  }

  const r = await runPocket(ctx, inv, signal, step, deps);
  if (!r.ok) return { ok: false, message: `Pocket TTS: ${r.message}`, changed: r.changed };
  const head = `Pocket TTS ist eingerichtet. ${r.message}`;
  if (r.measure && r.measure.rtf > 1) {
    const slow = "Das ist langsamer als Echtzeit, Antworten kämen spürbar verzögert.";
    if (!piperFallback) {
      return {
        ok: true,
        message: `${head} ${slow} Das Vorlesen bleibt unverändert. Vorschlag: Piper (ca. ${PIPER_VOICE_MB} MB, deutlich leichter); dafür ${BRAND.cli} setup sprache noch einmal und als Stimme Piper wählen. ${playHint(pocketPaths(speechDir(ctx.root)).probeWav, ctx)}`,
        changed: r.changed,
        audio: "pocket",
      };
    }
    total += piperSteps;
    const p = await runPiper(ctx, inv, signal, step, deps);
    if (!p.ok) return { ok: false, message: `${head} ${slow} Piper (wie gewünscht stattdessen): ${p.message}`, changed: [...r.changed, ...p.changed], audio: "pocket" };
    return finish("piper", `${head} ${slow} Deshalb stattdessen Piper: ${p.message}`, [...r.changed, ...p.changed]);
  }
  return finish("pocket", head, r.changed);
}

/** Satz zum Stand der Stimme für Status und Test */
export function voiceStatusText(inv: VoiceInventory): string {
  const current =
    inv.tts === "auto" || inv.tts === "browser"
      ? "Browser-Stimme"
      : inv.tts === "pocket"
        ? `Pocket TTS${inv.pocket.ok ? "" : " (nicht eingerichtet)"}`
        : inv.tts === "piper"
          ? `Piper${inv.piper.ok ? "" : " (nicht eingerichtet)"}`
          : inv.tts;
  return `Vorlesen: ${current}.`;
}

