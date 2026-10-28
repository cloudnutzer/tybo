/**
 * Teil „Eigene Stimme" im Schritt „sprache" (Issue #253, Entscheidung 0023):
 * richtet eine Klon-Engine ein. Die Stimme selbst nimmt der Nutzer danach in
 * der WebUI auf (Einstellungen, Sprechen, Eigene Stimme), mit Einwilligung.
 *
 * - Pocket TTS mit Klon-Gewichten (kyutai/pocket-tts, CC-BY-4.0, gated):
 *   braucht die eingerichtete lokale Stimme Pocket TTS (#252), einen
 *   Hugging-Face-Token mit Lesezugriff und die Freischaltung bei Kyutai.
 *   Der Assistent fragt die Zustimmung zu Kyutais Bedingungen ausdrücklich
 *   ab (Feld SPRACHE_KLON_BEDINGUNGEN); ohne Ja lädt er nichts. Der Token
 *   gilt nur für diesen Lauf (transient), wird nirgends gespeichert und geht
 *   nur als HF_TOKEN in die Umgebung des Download-Prozesses, nie als
 *   Argument. Die Freischaltung bei Hugging Face ersetzt nicht die
 *   Einwilligung je Stimme in tybo.
 * - Qwen3-TTS Base über mlx-audio (Apache-2.0, nicht gated), nur Mac mit
 *   Apple Silicon: eigenes venv unter models/speech/qwen-clone/ und das
 *   Modell (ca. 4,5 GB) an einer festen Revision. Bessere Qualität, auf
 *   einem M4 langsamer als Echtzeit (Praxistest 30.09.2026: RTF 1,34).
 *
 * Geladen wird erst nach „Jetzt ausführen?" mit Größen im Plan (wie #251 und
 * #252). Danach eine Probe mit einer Referenz (die hörbare Probe von Pocket
 * bzw. Piper, sonst ein erzeugter Ton) und erst dann der Nachweis
 * (pocket-clone.ok.json bzw. qwen-clone.ok.json) und speech.cloneEngine.
 * Abbruch: ein halbes venv wird gelöscht, halbe Modell-Downloads setzt der
 * nächste Lauf im eigenen Hugging-Face-Ordner fort (Nachweis model.ok erst
 * nach vollständigem Download).
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BRAND } from "../brand";
import { SettingsFileInvalidError, updateSettings } from "../lib/settings";
import {
  cloneProcessEnv,
  QWEN_CLONE_LABEL,
  QWEN_CLONE_MLX_AUDIO,
  QWEN_CLONE_MODEL_BYTES,
  QWEN_CLONE_NOTE,
  QWEN_CLONE_REPO,
  QWEN_CLONE_REVISION,
  qwenCloneAvailability,
  qwenClonePaths,
  qwenClonePlatformOk,
  synthesizeWithQwenClone,
  type QwenCloneProof,
} from "../lib/speech/clone";
import type { CloneEngineId } from "../lib/speech/ids";
import { speechDir } from "../lib/speech/parakeet";
import { piperPaths } from "../lib/speech/piper";
import {
  createPocketServer,
  POCKET_CLONE_BYTES,
  POCKET_CLONE_FILE,
  POCKET_CLONE_LABEL,
  POCKET_CLONE_NOTE,
  POCKET_CLONE_REPO,
  POCKET_CLONE_REVISION,
  POCKET_LANGUAGE,
  POCKET_VERSION,
  pocketCloneAvailability,
  pocketClonePaths,
  pocketEnv,
  pocketPaths,
  realPocketServerDeps,
  type PocketCloneProof,
} from "../lib/speech/pocket";
import { describeSpeechError } from "../lib/speech/types";
import { checkReferenceWav, pcm16Wav, VOICE_PROBE_TEXT } from "../lib/speech/voices";
import { wavDurationSeconds } from "../lib/speech/wav";
import type { SetupContext } from "./context";
import type { SetupField, SetupValues } from "./model";
import { runFnFromContext } from "./parakeet-probe";
import { checkPython, describeMeasure, installVenv, voicePlatformOk, type ProbeMeasure, type VoiceRunDeps } from "./speech-voice";

export const CLONE_FIELD = "SPRACHE_KLON";
export const CLONE_TERMS_FIELD = "SPRACHE_KLON_BEDINGUNGEN";
export const CLONE_TOKEN_FIELD = "SPRACHE_HF_TOKEN";

export type CloneChoice = "nein" | "pocket" | "qwen";
export const CLONE_CHOICES: readonly CloneChoice[] = ["nein", "pocket", "qwen"];

export const KYUTAI_TERMS_URL = "https://huggingface.co/kyutai/pocket-tts";
export const HF_TOKENS_URL = "https://huggingface.co/settings/tokens";

/** Gemessen 01.10.2026 mit pip download (Mac mit Apple Silicon, Python 3.14): 117 MB, im venv ca. 560 MB */
export const QWEN_RUNTIME_MB = 120;
export const QWEN_VENV_BYTES = 560_000_000;
/** Während der Einrichtung frei: venv, Modell, Puffer */
export const QWEN_DISK_NEEDED = 5_500_000_000;
export const POCKET_CLONE_DISK_NEEDED = 400_000_000;

const MODEL_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function mbText(bytes: number): string {
  const mb = bytes / 1_000_000;
  return mb >= 1000 ? `ca. ${(mb / 1000).toFixed(1).replace(".", ",")} GB` : `ca. ${Math.round(mb)} MB`;
}

export const CLONE_LABELS: Record<CloneChoice, string> = {
  nein: "Nein, keine eigene Stimme einrichten",
  pocket: `Pocket TTS mit Stimmenklonen (Kyutai, ${mbText(POCKET_CLONE_BYTES)}, braucht Hugging-Face-Konto und Zustimmung zu Kyutais Bedingungen)`,
  qwen: `Qwen3-TTS Base, nur Mac mit Apple Silicon (${mbText(QWEN_CLONE_MODEL_BYTES)} Modell plus ${mbText(QWEN_RUNTIME_MB * 1_000_000)} Laufzeit; bessere Qualität, auf einem M4 langsamer als Echtzeit)`,
};

export function isCloneChoice(v: unknown): v is CloneChoice {
  return typeof v === "string" && (CLONE_CHOICES as readonly string[]).includes(v);
}

const wantsPocket = (v: SetupValues) => v[CLONE_FIELD] === "pocket";

/** Felder des Teils; isLocal aus dem Schritt (nur auf dem lokalen Weg sichtbar) */
export function cloneFields(isLocal: (v: SetupValues) => boolean): SetupField[] {
  return [
    {
      name: CLONE_FIELD,
      label: "Eigene Stimme klonen (optional)?",
      kind: "choice",
      default: "nein",
      choices: CLONE_CHOICES.map(value => ({ value, label: CLONE_LABELS[value] })),
      help: `Damit ${BRAND.name} im Sprechmodus mit deiner eigenen Stimme vorliest (oder mit der einer Person, die es ausdrücklich erlaubt hat). Hier wird nur die Klon-Engine eingerichtet; die Stimme nimmst du danach in der WebUI auf, mit Einwilligung. Nie für Telegram oder Telefonate.`,
      visible: isLocal,
      validate: value => (isCloneChoice(value) ? null : "Unbekannte Auswahl."),
    },
    {
      name: CLONE_TERMS_FIELD,
      label: "Stimmst du Kyutais Bedingungen für das Klon-Modell zu?",
      kind: "yesno",
      default: "false",
      link: KYUTAI_TERMS_URL,
      help: `Die Klon-Gewichte von Kyutai sind nur nach Anmeldung bei Hugging Face und Zustimmung zu Kyutais Bedingungen erhältlich (${KYUTAI_TERMS_URL}). Sie verbieten, Stimmen ohne ausdrückliche und rechtmäßige Einwilligung nachzuahmen oder zu klonen. Ja heißt: Du hast die Bedingungen gelesen, auf der Seite mit deinem Konto akzeptiert und stimmst ihnen zu. Ohne Ja lädt ${BRAND.name} nichts.`,
      visible: v => isLocal(v) && wantsPocket(v),
    },
    {
      name: CLONE_TOKEN_FIELD,
      label: "Hugging-Face-Token (Lesezugriff, nur für diesen Download)",
      kind: "secret",
      transient: true,
      link: HF_TOKENS_URL,
      help: `Ein Token mit Lesezugriff aus ${HF_TOKENS_URL}. Er gilt nur für diesen Lauf, wird nirgends gespeichert und geht nur an den Download der Klon-Gewichte.`,
      visible: v => isLocal(v) && wantsPocket(v),
      validate: value => (/^hf_[A-Za-z0-9]{20,}$/.test(value.trim()) ? null : "Ein Hugging-Face-Token beginnt mit hf_."),
    },
  ];
}

// ---------------------------------------------------------------------------
// Bestand und Plan
// ---------------------------------------------------------------------------

export interface CloneInventory {
  platformOk: boolean;
  qwenPlatform: boolean;
  /** Pocket TTS (#252) installiert: venv und Programm */
  pocketProgram: boolean;
  pocketClone: { model: boolean; ok: boolean };
  qwen: { venv: boolean; model: boolean; ok: boolean };
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Nur Dateien, kein Prozess */
export function cloneInventory(ctx: SetupContext): CloneInventory {
  const dir = speechDir(ctx.root);
  const pp = pocketPaths(dir);
  const cp = pocketClonePaths(dir);
  const qp = qwenClonePaths(dir);
  const arch = ctx.arch ?? process.arch;
  return {
    platformOk: voicePlatformOk(ctx.platform, arch),
    qwenPlatform: qwenClonePlatformOk(ctx.platform, arch),
    pocketProgram: existsSync(pp.program),
    pocketClone: { model: existsSync(cp.cloneReady), ok: pocketCloneAvailability(pp, cp, existsSync, readText).ok },
    qwen: { venv: existsSync(qp.python), model: existsSync(qp.modelReady), ok: qwenCloneAvailability(qp, ctx.platform, arch, existsSync, readText).ok },
  };
}

/** Plan-Sätze für den Teil Eigene Stimme; pocketThisRun: Pocket TTS wird im selben Lauf eingerichtet */
export function clonePlan(inv: CloneInventory, choice: CloneChoice, values: SetupValues, pocketThisRun: boolean): string[] {
  if (choice === "nein") return [];
  const after = `Danach die Stimme in der WebUI aufnehmen: Einstellungen, Sprechen, Eigene Stimme (mit Einwilligung, nur lokal unter data/speech/voices/).`;
  if (choice === "pocket") {
    if (!inv.platformOk) return ["Eigene Stimme mit Pocket TTS gibt es hier nicht (unterstützt: Mac mit Apple Silicon, Linux x64 und arm64). Es wird nichts heruntergeladen."];
    const out: string[] = [];
    if (!inv.pocketProgram && !pocketThisRun) out.push("Eigene Stimme mit Pocket TTS braucht zuerst die lokale Stimme Pocket TTS (Feld Stimme fürs Vorlesen: Lokale Stimme). Ohne sie wird nichts geladen.");
    if (values[CLONE_TERMS_FIELD] !== "true") out.push(`Ohne deine Zustimmung zu Kyutais Bedingungen (${KYUTAI_TERMS_URL}) lädt ${BRAND.name} die Klon-Gewichte nicht.`);
    if (inv.pocketClone.ok) out.push("Stimmenklonen mit Pocket TTS ist eingerichtet und geprüft. Es wird nichts geladen, die Probe läuft noch einmal.");
    else {
      if (!inv.pocketClone.model) {
        out.push(`Eigene Stimme mit Pocket TTS: Download der Klon-Gewichte von Kyutai (kyutai/pocket-tts, deutsches Modell, ${mbText(POCKET_CLONE_BYTES)}, CC-BY-4.0) mit deinem Hugging-Face-Token. Das ist deine bewusste Zustimmung zu Kyutais Bedingungen; der Token wird nicht gespeichert.`);
        out.push("Der Download beginnt erst nach deinem Ja. Ein halber Download wird beim nächsten Lauf fortgesetzt.");
      }
      out.push("Danach eine Probe: Pocket TTS klont eine Referenz und liest einen Satz vor, erst dann gilt die Engine als eingerichtet.");
    }
    out.push(`${POCKET_CLONE_NOTE}.`, after);
    return out;
  }
  if (!inv.qwenPlatform) return ["Qwen3-TTS Base gibt es nur auf einem Mac mit Apple Silicon. Es wird nichts heruntergeladen."];
  const out: string[] = [];
  if (inv.qwen.ok) out.push("Qwen3-TTS Base ist eingerichtet und geprüft. Es wird nichts geladen, die Probe läuft noch einmal.");
  else {
    const parts: string[] = [];
    if (!inv.qwen.venv) parts.push(`Laufzeit mlx-audio ${QWEN_CLONE_MLX_AUDIO} ${mbText(QWEN_RUNTIME_MB * 1_000_000)} (im venv danach ${mbText(QWEN_VENV_BYTES)})`);
    if (!inv.qwen.model) parts.push(`Modell ${QWEN_CLONE_REPO} ${mbText(QWEN_CLONE_MODEL_BYTES)}`);
    if (parts.length) out.push(`Eigene Stimme mit Qwen3-TTS Base: Download ${parts.join(", ")}, unter models/speech/qwen-clone/. Während der Einrichtung braucht es ${mbText(QWEN_DISK_NEEDED)} frei.`);
    out.push("Der Download beginnt erst nach deinem Ja. Abbrechen löscht eine halbe Python-Umgebung; ein halber Modell-Download wird beim nächsten Lauf fortgesetzt.");
    out.push("Danach eine Probe mit Zeitmessung (RTF).");
  }
  out.push("Hinweis: bessere Qualität, auf einem M4 langsamer als Echtzeit (Praxistest: RTF 1,34, erster Ton nach 2,3 s, 4,8 GB Arbeitsspeicher).", `${QWEN_CLONE_NOTE}.`, after);
  return out;
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

/** Download der Klon-Gewichte: Token nur aus der Umgebung (HF_TOKEN), feste Revision; Exit 3 gated, 4 Token, 5 sonst */
export const POCKET_CLONE_FETCH_SCRIPT = [
  "import sys",
  "from huggingface_hub import hf_hub_download",
  "try:",
  "    from huggingface_hub.errors import GatedRepoError, RepositoryNotFoundError, HfHubHTTPError",
  "except ImportError:",
  "    from huggingface_hub.utils import GatedRepoError, RepositoryNotFoundError, HfHubHTTPError",
  "try:",
  "    hf_hub_download(repo_id=sys.argv[1], filename=sys.argv[2], revision=sys.argv[3])",
  "except GatedRepoError:",
  "    sys.exit(3)",
  "except RepositoryNotFoundError:",
  "    sys.exit(4)",
  "except HfHubHTTPError as e:",
  "    status = getattr(getattr(e, 'response', None), 'status_code', 0)",
  "    sys.exit(4 if status == 401 else 3 if status == 403 else 5)",
  "except Exception:",
  "    sys.exit(5)",
].join("\n");

/** Download des Qwen-Modells an der festen Revision in den eigenen Hugging-Face-Ordner */
export const QWEN_CLONE_FETCH_SCRIPT = [
  "import sys",
  "from huggingface_hub import snapshot_download",
  "try:",
  "    snapshot_download(repo_id=sys.argv[1], revision=sys.argv[2])",
  "except Exception:",
  "    sys.exit(5)",
].join("\n");

export interface CloneRunResult {
  ok: boolean;
  message: string;
  changed: string[];
}

/** Referenz für die Probe: die hörbare Probe von Pocket bzw. Piper, sonst ein erzeugter Ton (5 s) */
export async function probeReference(ctx: SetupContext): Promise<Buffer> {
  const dir = speechDir(ctx.root);
  for (const path of [pocketPaths(dir).probeWav, piperPaths(dir).probeWav]) {
    const raw = existsSync(path) ? readFileSync(path) : null;
    if (!raw) continue;
    const check = checkReferenceWav(raw);
    if (check.ok) return pcm16Wav(check.pcm, check.sampleRate);
  }
  const rate = 24_000;
  const pcm = Buffer.alloc(rate * 2 * 5);
  for (let i = 0; i < rate * 5; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 4000), i * 2);
  return pcm16Wav(pcm, rate);
}

/** Die Probe-Referenz liegt wie eine Stimme in einem Temp-Ordner (Kennung nach Muster) */
const PROBE_ID = "0000000000000000";

async function setCloneEngine(ctx: SetupContext, engine: CloneEngineId): Promise<string | null> {
  try {
    await updateSettings(s => ({ ...s, speech: { ...s.speech, cloneEngine: engine } }), { path: ctx.settingsPath });
    return null;
  } catch (e) {
    return e instanceof SettingsFileInvalidError ? "config/settings.json ist ungültig" : "config/settings.json ließ sich nicht schreiben";
  }
}

const ABORTED = (what: string): CloneRunResult => ({ ok: false, message: `Abgebrochen. ${what}`, changed: [] });

/** Pocket mit Klon-Gewichten; wirft nie */
export async function runPocketClone(values: SetupValues, ctx: SetupContext, signal: AbortSignal, step: (label: string) => void, deps: VoiceRunDeps = {}): Promise<CloneRunResult> {
  const inv = cloneInventory(ctx);
  const dir = speechDir(ctx.root);
  const pp = pocketPaths(dir);
  const cp = pocketClonePaths(dir);
  const changed: string[] = [];
  if (!inv.platformOk) return { ok: false, message: "Eigene Stimme mit Pocket TTS gibt es hier nicht. Es wurde nichts heruntergeladen.", changed };
  if (values[CLONE_TERMS_FIELD] !== "true") return { ok: false, message: `Ohne Zustimmung zu Kyutais Bedingungen (${KYUTAI_TERMS_URL}) wurde nichts heruntergeladen.`, changed };
  if (!existsSync(pp.program)) return { ok: false, message: "Zuerst die lokale Stimme Pocket TTS einrichten (Stimme fürs Vorlesen: Lokale Stimme). Es wurde nichts heruntergeladen.", changed };
  const token = (values[CLONE_TOKEN_FIELD] ?? "").trim();
  if (!inv.pocketClone.model) {
    if (!token) return { ok: false, message: `Ohne Hugging-Face-Token (${HF_TOKENS_URL}) lassen sich die Klon-Gewichte nicht laden. Es wurde nichts heruntergeladen.`, changed };
    const free = await (ctx.freeDisk ?? (async () => null))(dir);
    if (free !== null && free < POCKET_CLONE_DISK_NEEDED) return { ok: false, message: `Zu wenig Platz: nötig sind ${mbText(POCKET_CLONE_DISK_NEEDED)} frei. Es wurde nichts heruntergeladen.`, changed };
    if (signal.aborted) return ABORTED("Nichts wurde geladen.");
    step(`Lade die Klon-Gewichte von Kyutai (${mbText(POCKET_CLONE_BYTES)})`);
    // Token nur in der Umgebung dieses einen Prozesses, nie als Argument (sonst in der Prozessliste)
    const env = { ...pocketEnv(pp, process.env, false), HF_TOKEN: token };
    const r = await ctx.run([pp.python, "-I", "-c", POCKET_CLONE_FETCH_SCRIPT, POCKET_CLONE_REPO, POCKET_CLONE_FILE, POCKET_CLONE_REVISION], { timeoutMs: MODEL_TIMEOUT_MS, signal, env, cwd: pp.dir });
    if (signal.aborted) return ABORTED("Ein halber Download wird beim nächsten Lauf fortgesetzt.");
    if (r.code === 3) return { ok: false, message: `Kein Zugang zu den Klon-Gewichten: Bitte auf ${KYUTAI_TERMS_URL} mit deinem Konto anmelden und die Bedingungen akzeptieren, dann noch einmal. Es wurde nichts eingerichtet.`, changed };
    if (r.code === 4) return { ok: false, message: `Der Hugging-Face-Token wurde abgelehnt (ungültig oder ohne Lesezugriff, ${HF_TOKENS_URL}). Es wurde nichts eingerichtet.`, changed };
    const file = join(cp.cloneCache, "snapshots", POCKET_CLONE_REVISION, POCKET_CLONE_FILE);
    if (r.code !== 0 || !existsSync(file)) {
      return { ok: false, message: `Download der Klon-Gewichte fehlgeschlagen (${r.timedOut ? "Zeitlimit" : `Exit-Code ${r.code}`}). Der nächste Lauf setzt ihn fort.`, changed };
    }
    await writeFile(cp.cloneReady, JSON.stringify({ version: 1, repo: POCKET_CLONE_REPO, revision: POCKET_CLONE_REVISION }) + "\n", { mode: 0o600 });
    changed.push(cp.cloneCache);
  }

  step("Probe: Pocket TTS klont eine Referenz und liest einen Satz vor (ohne Netz)");
  await rm(cp.cloneProof, { force: true });
  const probeDir = join(pp.dir, `.tmp-clone-probe-${randomBytes(4).toString("hex")}`);
  const server = createPocketServer({ paths: pp, env: () => process.env, deps: deps.pocketServer ?? realPocketServerDeps, voicesDir: probeDir });
  let measure: ProbeMeasure;
  try {
    await mkdir(join(probeDir, PROBE_ID), { recursive: true, mode: 0o700 });
    await writeFile(join(probeDir, PROBE_ID, "reference.wav"), await probeReference(ctx), { mode: 0o600 });
    const voice = `clone:${PROBE_ID}`;
    const t0 = ctx.now().getTime();
    await server.warmUp(voice, signal);
    const t1 = ctx.now().getTime();
    if (signal.aborted) return ABORTED("Kein Nachweis geschrieben.");
    const audio = await server.synthesize(VOICE_PROBE_TEXT, voice, signal);
    const t2 = ctx.now().getTime();
    const seconds = wavDurationSeconds(audio);
    if (!seconds) return { ok: false, message: "Probe nicht bestanden: die Antwort war kein lesbares WAV. Kein Nachweis geschrieben.", changed };
    measure = { loadMs: t1 - t0, synthMs: t2 - t1, audioSeconds: seconds, rtf: (t2 - t1) / 1000 / seconds };
  } catch (e) {
    if (signal.aborted) return ABORTED("Kein Nachweis geschrieben.");
    return { ok: false, message: `Probe nicht bestanden (${describeSpeechError(e)}): Die Klon-Gewichte ließen sich nicht laden oder die Stimme nicht klonen. Kein Nachweis geschrieben.`, changed };
  } finally {
    server.stop();
    await rm(probeDir, { recursive: true, force: true }).catch(() => {});
  }
  if (signal.aborted) return ABORTED("Kein Nachweis geschrieben.");
  const proof: PocketCloneProof = {
    version: 1,
    pocket: POCKET_VERSION,
    language: POCKET_LANGUAGE,
    revision: POCKET_CLONE_REVISION,
    probe: { loadMs: measure.loadMs ?? 0, synthMs: measure.synthMs, audioSeconds: Math.round(measure.audioSeconds * 100) / 100, rtf: Math.round(measure.rtf * 1000) / 1000, at: ctx.now().toISOString() },
  };
  await writeFile(cp.cloneProof, JSON.stringify(proof, null, 2) + "\n", { mode: 0o600 });
  changed.push(cp.cloneProof);
  const err = await setCloneEngine(ctx, "pocket");
  if (err) return { ok: false, message: `Probe bestanden, aber ${err}; die Engine ist nicht ausgewählt.`, changed };
  changed.push(ctx.settingsPath);
  return { ok: true, message: `${POCKET_CLONE_LABEL} ist eingerichtet. Probe bestanden. ${describeMeasure(measure)}`, changed };
}

/** Qwen3-TTS Base (Mac); wirft nie */
export async function runQwenClone(ctx: SetupContext, signal: AbortSignal, step: (label: string) => void): Promise<CloneRunResult> {
  const inv = cloneInventory(ctx);
  const dir = speechDir(ctx.root);
  const qp = qwenClonePaths(dir);
  const changed: string[] = [];
  if (!inv.qwenPlatform) return { ok: false, message: "Qwen3-TTS Base gibt es nur auf einem Mac mit Apple Silicon. Es wurde nichts heruntergeladen.", changed };
  const pyErr = await checkPython(ctx, 10, signal);
  if (signal.aborted) return ABORTED("Nichts wurde geändert.");
  if (pyErr) return { ok: false, message: `${pyErr} Es wurde nichts heruntergeladen.`, changed };
  if (!inv.qwen.venv || !inv.qwen.model) {
    const free = await (ctx.freeDisk ?? (async () => null))(dir);
    if (free !== null && free < QWEN_DISK_NEEDED) return { ok: false, message: `Zu wenig Platz: nötig sind ${mbText(QWEN_DISK_NEEDED)} frei, frei sind ${mbText(free)}. Es wurde nichts heruntergeladen.`, changed };
  }
  await mkdir(qp.dir, { recursive: true });
  if (!inv.qwen.venv) {
    const inst = await installVenv(ctx, qp.venv, qp.python, [`mlx-audio==${QWEN_CLONE_MLX_AUDIO}`], signal, step, `Lade mlx-audio ${QWEN_CLONE_MLX_AUDIO} (${mbText(QWEN_RUNTIME_MB * 1_000_000)}), das dauert einige Minuten`);
    if (!inst.ok) return { ok: false, message: inst.message, changed };
    changed.push(qp.venv);
  }
  if (!existsSync(qp.modelReady)) {
    step(`Lade das Modell ${QWEN_CLONE_REPO} (${mbText(QWEN_CLONE_MODEL_BYTES)}), das dauert je nach Leitung lange`);
    const r = await ctx.run([qp.python, "-I", "-c", QWEN_CLONE_FETCH_SCRIPT, QWEN_CLONE_REPO, QWEN_CLONE_REVISION], { timeoutMs: MODEL_TIMEOUT_MS, signal, env: cloneProcessEnv(qp.hfHome, process.env, false), cwd: qp.dir });
    if (signal.aborted) return ABORTED("Ein halber Modell-Download wird beim nächsten Lauf fortgesetzt.");
    if (r.code !== 0 || !existsSync(qp.snapshot)) return { ok: false, message: `Modell ließ sich nicht laden (${r.timedOut ? "Zeitlimit" : `Exit-Code ${r.code}`}). Der nächste Lauf setzt den Download fort.`, changed };
    await writeFile(qp.modelReady, JSON.stringify({ version: 1, repo: QWEN_CLONE_REPO, revision: QWEN_CLONE_REVISION }) + "\n", { mode: 0o600 });
    changed.push(qp.hfHome);
  }

  step("Probe: Qwen3-TTS Base klont eine Referenz und liest einen Satz vor (ohne Netz)");
  await rm(qp.proof, { force: true });
  const tmpDir = join(qp.dir, `.tmp-probe-${randomBytes(4).toString("hex")}`);
  let measure: ProbeMeasure;
  try {
    await mkdir(tmpDir, { recursive: true });
    const ref = join(tmpDir, "reference.wav");
    await writeFile(ref, await probeReference(ctx), { mode: 0o600 });
    const t0 = ctx.now().getTime();
    const audio = await synthesizeWithQwenClone(VOICE_PROBE_TEXT, { audio: ref, text: VOICE_PROBE_TEXT }, qp, { tmpDir, unique: "probe", language: "german", env: cloneProcessEnv(qp.hfHome, process.env), signal }, {
      run: runFnFromContext(ctx),
      readFile: p => Bun.file(p).arrayBuffer().then(b => Buffer.from(b)),
      unlink: p => rm(p, { force: true }),
      mkdir: async p => {
        await mkdir(p, { recursive: true });
      },
      exists: existsSync,
    });
    const ms = ctx.now().getTime() - t0;
    const seconds = wavDurationSeconds(audio);
    if (!seconds) return { ok: false, message: "Probe nicht bestanden: die Antwort war kein lesbares WAV. Kein Nachweis geschrieben.", changed };
    measure = { loadMs: null, synthMs: ms, audioSeconds: seconds, rtf: ms / 1000 / seconds };
  } catch (e) {
    if (signal.aborted) return ABORTED("Kein Nachweis geschrieben.");
    return { ok: false, message: `Probe nicht bestanden (${describeSpeechError(e)}). Kein Nachweis geschrieben.`, changed };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
  if (signal.aborted) return ABORTED("Kein Nachweis geschrieben.");
  const proof: QwenCloneProof = {
    version: 1,
    mlxAudio: QWEN_CLONE_MLX_AUDIO,
    revision: QWEN_CLONE_REVISION,
    probe: { synthMs: measure.synthMs, audioSeconds: Math.round(measure.audioSeconds * 100) / 100, rtf: Math.round(measure.rtf * 1000) / 1000, at: ctx.now().toISOString() },
  };
  await writeFile(qp.proof, JSON.stringify(proof, null, 2) + "\n", { mode: 0o600 });
  changed.push(qp.proof);
  const err = await setCloneEngine(ctx, "qwen3-base");
  if (err) return { ok: false, message: `Probe bestanden, aber ${err}; die Engine ist nicht ausgewählt.`, changed };
  changed.push(ctx.settingsPath);
  return { ok: true, message: `${QWEN_CLONE_LABEL} ist eingerichtet. Probe bestanden (Ladezeit inbegriffen). ${describeMeasure(measure)}`, changed };
}

/** Teil Eigene Stimme; null, wenn nichts gewählt ist */
export async function runClone(values: SetupValues, ctx: SetupContext, signal: AbortSignal, step: (label: string) => void, deps: VoiceRunDeps = {}): Promise<CloneRunResult | null> {
  const raw = values[CLONE_FIELD] ?? "nein";
  const choice: CloneChoice = isCloneChoice(raw) ? raw : "nein";
  if (choice === "nein") return null;
  const r = choice === "pocket" ? await runPocketClone(values, ctx, signal, step, deps) : await runQwenClone(ctx, signal, step);
  const after = r.ok ? ` Jetzt in der WebUI die eigene Stimme aufnehmen: Einstellungen, Sprechen, Eigene Stimme.` : "";
  return { ...r, message: `Eigene Stimme: ${r.message}${after}` };
}
