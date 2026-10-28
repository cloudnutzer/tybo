/**
 * Schritt „sprache“ (Issue #251, Entscheidung 0023): lokales Hören für den
 * Sprechmodus. Optional, nach „modelle“, im Terminal und mit --web.
 *
 * Wege: das Feld SPRACHE_WEG wählt den Pfad. Heute gibt es nur
 * „Sprechmodus lokal“ (Parakeet über sherpa-onnx); #247 stellt später
 * „Eigener ElevenLabs-Agent“ daneben, ohne den lokalen Pfad umzubauen
 * (eigene Auswahl, eigenes runWhen bzw. eigener Zweig in run).
 *
 * Ablauf „Sprechmodus lokal“:
 * 1. Bestandsaufnahme (speechInventory): Plattform, Arbeitsspeicher, freier
 *    Platz, whisper.cpp, ffmpeg, vorhandenes Parakeet mit Nachweis.
 * 2. Vorschlag mit Zahlen im Plan, Download und Platz getrennt; zu wenig
 *    Platz oder nicht unterstützte Plattform: kein Download.
 * 3. Download erst nach „Jetzt ausführen?“ (src/setup/speech-download.ts).
 * 4. Probe am Kandidaten (src/setup/parakeet-probe.ts), erst danach der
 *    Nachweis parakeet.ok.json.
 * 5. speech.stt fest auf parakeet über updateSettings() mit dem Pfad des
 *    Assistenten; bei auto oder einem anderen Anbieter nur nach Rückfrage.
 *
 * Pfad „Telefonhörer“ (Issue #260): src/setup/speech-call.ts, setzt einen
 * lokalen Erkenner voraus, misst den gewählten Modellweg und speichert ihn.
 *
 * Wiederholbar: Mit gültigem Nachweis wird nichts geladen und nicht geprüft;
 * sind nur die Dateien da, läuft nur die Probe. Kein Bot-Neustart, keine
 * Autostart-Änderung: Der Bot liest speech.stt beim nächsten Aufruf.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { totalmem } from "node:os";
import { join } from "node:path";
import { BRAND } from "../../brand";
import { formatGib } from "../../lib/agent-capacity";
import { settingsSchema, SettingsFileInvalidError, updateSettings, type Settings } from "../../lib/settings";
import { isSttChoice, isTtsChoice, type SttChoice, type TtsChoice } from "../../lib/speech/ids";
import {
  artifactFiles,
  artifactsFor,
  buildProof,
  checkProof,
  MODEL_ARTIFACT,
  PARAKEET_ATTRIBUTION,
  PARAKEET_LABEL,
  parakeetPaths,
  selectPlatform,
  speechDir,
  VAD_ARTIFACT,
  runtimeArtifact,
  type Artifact,
  type ArtifactId,
  type PlatformChoice,
  type StatFn,
} from "../../lib/speech/parakeet";
import type { Availability } from "../../lib/speech/types";
import { defaultFreeDisk, readSetupEnv, type SetupContext } from "../context";
import { fieldStates, presentValue, type ApplyResult, type RunReport, type SetupField, type SetupStep, type SetupValues, type StatusItem, type StepStatus } from "../model";
import { describeProbe, probeCandidate } from "../parakeet-probe";
import { diskNeeded, installArtifacts, nodeDownloadFs, type DownloadFs } from "../speech-download";
import { CALL_INVENTORY, CALL_WAY_FIELD, callFields, callPlan, callSetupInventory, callWayPreselect, runCallSetup } from "../speech-call";
import { CLONE_FIELD, cloneFields, cloneInventory, clonePlan, isCloneChoice, runClone, type CloneInventory } from "../speech-clone";
import {
  isVoiceChoice,
  PIPER_FALLBACK_FIELD,
  runVoice,
  VOICE_CHOICES,
  VOICE_FIELD,
  VOICE_LABELS,
  voiceInventory,
  voicePlan,
  voicePreselect,
  voiceStatusText,
  type VoiceInventory,
} from "../speech-voice";

/** Unter so viel Arbeitsspeicher (Byte) ein deutlicher Hinweis */
export const LOW_RAM_BYTES = 4 * 1024 ** 3;
/** Arbeitsspeicher beim Erkennen (gemessen für v2 auf dem Pi 5: 1,76 GB) */
const RAM_NEEDED_TEXT = "ca. 2 GB";

export const PATH_FIELD = "SPRACHE_WEG";
export const SWITCH_FIELD = "SPRACHE_UMSTELLEN";
export const SWITCH_AUTO_FIELD = "SPRACHE_UMSTELLEN_AUTO";
/** Nur intern (existingFieldValues): aktuelle Wahl fürs Hören und die Bestandsaufnahme für den Plan */
export const CURRENT_STT = "SPRACHE_STT";
export const INVENTORY = "SPRACHE_BESTAND";

export const AUTO_EXPLANATION =
  "Mit auto geht eine Aufnahme, die Parakeet nicht versteht oder in der es nichts hört, an ElevenLabs oder Gemini weiter, falls eingerichtet.";

const isLocal = (v: SetupValues) => (v[PATH_FIELD] ?? "lokal") === "lokal";
const isCall = (v: SetupValues) => v[PATH_FIELD] === "telefon";

export const SPEECH_FIELDS: SetupField[] = [
  {
    name: PATH_FIELD,
    label: "Weg für den Sprechmodus",
    kind: "choice",
    default: "lokal",
    choices: [
      { value: "lokal", label: "Sprechmodus lokal (empfohlen): Parakeet hört auf diesem Rechner, ohne Cloud-Schlüssel" },
      { value: "telefon", label: "Telefonhörer: flüssiges Gespräch mit kurzen Antworten (setzt den Sprechmodus lokal voraus)" },
    ],
    help: `Wie ${BRAND.name} beim Sprechen zuhört. Lokal bleibt die Aufnahme auf diesem Rechner; nötig sind einmalig rund 500 MB Download. Der Telefonhörer kommt danach: er misst, wie schnell ${BRAND.name} auf diesem Gerät antwortet, und speichert den Modellweg.`,
  },
  {
    name: SWITCH_AUTO_FIELD,
    label: "Hören fest auf Parakeet stellen (statt auto)?",
    kind: "yesno",
    default: "true",
    help: `Hören steht auf auto. ${AUTO_EXPLANATION} Ja: nur noch Parakeet, nie still in die Cloud. Nein: auto bleibt.`,
    visible: v => isLocal(v) && (v[CURRENT_STT] ?? "auto") === "auto",
  },
  {
    name: SWITCH_FIELD,
    label: "Hören von einem anderen Anbieter auf Parakeet umstellen?",
    kind: "yesno",
    default: "true",
    help: "Hören ist fest auf einen anderen Anbieter eingestellt. Ja: nach bestandener Probe nur noch Parakeet. Nein: die bisherige Wahl bleibt.",
    visible: v => isLocal(v) && !!v[CURRENT_STT] && v[CURRENT_STT] !== "auto" && v[CURRENT_STT] !== "parakeet",
  },
  // Teil „Stimme“ (Issue #252): womit der Sprechmodus vorliest; vorausgewählt ist die eingestellte Stimme
  {
    name: VOICE_FIELD,
    label: "Stimme fürs Vorlesen",
    kind: "choice",
    // Enter im Terminal ändert nichts (auch nicht qwen3-mlx oder gemini); im Browser ist die eingestellte Stimme vorausgewählt
    default: "keep",
    choices: VOICE_CHOICES.map(value => ({ value, label: VOICE_LABELS[value] })),
    help: `Womit ${BRAND.name} im Sprechmodus vorliest. Die Browser-Stimme braucht nichts, klingt aber je nach Gerät anders. Die lokale Stimme läuft auf diesem Rechner, ohne Cloud. Geladen wird erst nach deinem Ja.`,
    visible: isLocal,
    validate: (value, values) => {
      if (!isVoiceChoice(value)) return "Unbekannte Auswahl.";
      if (value === "elevenlabs") {
        const inv = parseInventory(values);
        if (inv && !inv.voice.elevenVoice) return "ElevenLabs braucht ELEVENLABS_API_KEY und ELEVENLABS_VOICE_ID in der .env (WebUI: Einstellungen, Schlüssel).";
      }
      return null;
    },
  },
  {
    name: PIPER_FALLBACK_FIELD,
    label: "Falls Pocket TTS hier langsamer als Echtzeit ist: stattdessen Piper einrichten?",
    kind: "yesno",
    default: "false",
    help: "Die Probe misst, wie schnell Pocket TTS auf diesem Rechner vorliest. Ist es langsamer als Echtzeit (etwa auf einem Raspberry Pi), richtet der Lauf bei Ja zusätzlich Piper ein (ca. 120 MB, GPL-3.0, Stimme Thorsten CC0) und liest damit vor. Bei Nein bleibt das Vorlesen unverändert und das Ergebnis nennt den Vorschlag.",
    visible: v => isLocal(v) && v[VOICE_FIELD] === "pocket",
  },
  // Teil „Eigene Stimme" (Issue #253): Klon-Engine, Zustimmung zu Kyutais Bedingungen, Token nur für diesen Lauf
  ...cloneFields(isLocal),
  // Pfad „Telefonhörer" (Issue #260): Modellweg vor der Probe wählen
  ...callFields(),
];

// ---------------------------------------------------------------------------
// Bestandsaufnahme
// ---------------------------------------------------------------------------

export interface SpeechInventory {
  platform: string;
  arch: string;
  sel: PlatformChoice;
  ramBytes: number;
  /** Freier Platz im Projektordner; null: unbekannt */
  freeBytes: number | null;
  whisper: boolean;
  ffmpeg: boolean;
  /** Je Artefakt: alle Dateien am Zielort */
  files: Record<ArtifactId, boolean>;
  proof: Availability;
  /** Wirksame Wahl fürs Hören (Datei vor SPEECH_STT vor auto) */
  stt: SttChoice;
  /** speech.stt kommt aus der Datei */
  sttFromFile: boolean;
  settingsValid: boolean;
  /** Vorhandene Cloud-Schlüssel fürs Hören (nur Namen der Anbieter) */
  cloud: string[];
  /** Teil Stimme (Issue #252) */
  voice: VoiceInventory;
  /** Teil Eigene Stimme (Issue #253) */
  clone: CloneInventory;
}

export const statFile: StatFn = path => {
  try {
    const s = statSync(path);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
};

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

type ReadSettings = { ok: true; settings: Settings } | { ok: false };

function readSettingsFile(path: string): ReadSettings {
  const raw = readText(path);
  if (raw === null) return existsSync(path) ? { ok: false } : { ok: true, settings: {} };
  try {
    const parsed = settingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? { ok: true, settings: parsed.data } : { ok: false };
  } catch {
    return { ok: false };
  }
}

const which = (ctx: SetupContext, cmd: string) => (ctx.which ?? ((c: string) => Bun.which(c)))(cmd);

export async function speechInventory(ctx: SetupContext): Promise<SpeechInventory> {
  const env = await readSetupEnv(ctx);
  const arch = ctx.arch ?? process.arch;
  const sel = selectPlatform(ctx.platform, arch);
  const dir = speechDir(ctx.root);
  const files: Record<ArtifactId, boolean> = { laufzeit: false, modell: false, vad: false };
  let proof: Availability = { ok: false, reason: sel.ok ? "nicht eingerichtet" : "nicht unterstützt" };
  if (sel.ok) {
    const paths = parakeetPaths(dir, sel.key);
    for (const id of Object.keys(files) as ArtifactId[]) files[id] = artifactFiles(paths, id).every(f => statFile(f) !== null);
    proof = checkProof(readText(paths.proof), paths, sel.key, statFile);
  }
  const whisperCli = presentValue(env, "WHISPER_CLI_PATH") ?? "whisper-cli";
  const whisperModel = presentValue(env, "WHISPER_MODEL_PATH") ?? join(ctx.root, "models", "ggml-medium.bin");
  const whisperProgram = whisperCli.includes("/") ? existsSync(whisperCli) : !!which(ctx, whisperCli);
  const settings = readSettingsFile(ctx.settingsPath);
  const fileStt = settings.ok ? settings.settings.speech?.stt : undefined;
  const envStt = presentValue(env, "SPEECH_STT")?.toLowerCase();
  const stt: SttChoice = fileStt ?? (isSttChoice(envStt) ? envStt : "auto");
  const cloud: string[] = [];
  if (presentValue(env, "ELEVENLABS_API_KEY")) cloud.push("ElevenLabs");
  if (presentValue(env, "GEMINI_API_KEY")) cloud.push("Gemini");
  const fileTts = settings.ok ? settings.settings.speech?.tts : undefined;
  const envTts = presentValue(env, "SPEECH_TTS")?.toLowerCase();
  const tts: TtsChoice = fileTts ?? (isTtsChoice(envTts) ? envTts : "auto");
  const voiceEnv = {
    ELEVENLABS_API_KEY: presentValue(env, "ELEVENLABS_API_KEY"),
    ELEVENLABS_VOICE_ID: presentValue(env, "ELEVENLABS_VOICE_ID"),
    POCKET_TTS_VOICE: presentValue(env, "POCKET_TTS_VOICE"),
  };
  return {
    platform: ctx.platform,
    arch,
    sel,
    ramBytes: (ctx.totalMem ?? totalmem)(),
    freeBytes: await (ctx.freeDisk ?? defaultFreeDisk)(dir),
    whisper: whisperProgram && existsSync(whisperModel),
    ffmpeg: !!which(ctx, "ffmpeg"),
    files,
    proof,
    stt,
    sttFromFile: fileStt !== undefined,
    settingsValid: settings.ok,
    cloud,
    voice: voiceInventory(ctx, voiceEnv, tts),
    clone: cloneInventory(ctx),
  };
}

/** Artefakte, die noch fehlen */
export function missingArtifacts(inv: SpeechInventory): Artifact[] {
  if (!inv.sel.ok) return [];
  return artifactsFor(inv.sel.key).filter(a => !inv.files[a.id]);
}

/** Byte als MB (1.000.000), unter 10 MB mit einer Nachkommastelle, ab 1.000 MB als GB */
export function mb(bytes: number): string {
  const v = bytes / 1_000_000;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(".", ",")} GB`;
  return v < 10 ? `${v.toFixed(1).replace(".", ",")} MB` : `${Math.round(v)} MB`;
}

const filesAll = (inv: SpeechInventory) => inv.files.laufzeit && inv.files.modell && inv.files.vad;
const filesAny = (inv: SpeechInventory) => inv.files.laufzeit || inv.files.modell || inv.files.vad;

function inventoryItems(inv: SpeechInventory): StatusItem[] {
  const items: StatusItem[] = [
    { label: "Plattform", ok: inv.sel.ok, detail: inv.sel.ok ? `${inv.sel.label} (${inv.platform} ${inv.arch})` : inv.sel.reason },
    {
      label: "Arbeitsspeicher",
      ok: inv.ramBytes >= LOW_RAM_BYTES,
      detail: `${formatGib(inv.ramBytes)}${inv.ramBytes < LOW_RAM_BYTES ? `, knapp für Parakeet (${RAM_NEEDED_TEXT} beim Erkennen)` : ""}`,
    },
    { label: "Freier Platz", ok: inv.freeBytes !== null, detail: inv.freeBytes === null ? "unbekannt" : mb(inv.freeBytes) },
    { label: "whisper.cpp", ok: inv.whisper, detail: inv.whisper ? "vorhanden, mit Modell" : "nicht vorhanden" },
    {
      label: "ffmpeg",
      ok: inv.ffmpeg,
      detail: inv.ffmpeg ? "vorhanden" : "fehlt: Aufnahmen aus dem Browser gehen trotzdem, Sprachnachrichten aus Telegram brauchen ffmpeg",
    },
    {
      label: "Parakeet",
      ok: inv.proof.ok,
      detail: inv.proof.ok ? "eingerichtet, Probe bestanden" : filesAll(inv) ? "Dateien da, Probe fehlt" : filesAny(inv) ? "unvollständig" : "nicht vorhanden",
    },
  ];
  return items;
}

/** Werte für Sichtbarkeit und Plan (existingFieldValues), nie an der Oberfläche */
export async function speechPathValues(ctx: SetupContext): Promise<SetupValues> {
  const inv = await speechInventory(ctx);
  const out: SetupValues = { [CURRENT_STT]: inv.stt, [INVENTORY]: JSON.stringify(inv) };
  // Vorauswahl: die eingestellte Stimme (auto gilt als Browser-Stimme), damit Enter nichts umstellt
  out[VOICE_FIELD] = voicePreselect(inv.voice.tts);
  // Telefonhörer (Issue #260): Wege mit Bereitschaft für den Plan, vorausgewählt der gespeicherte Weg
  const call = await callSetupInventory(ctx);
  out[CALL_INVENTORY] = JSON.stringify(call);
  out[CALL_WAY_FIELD] = callWayPreselect(call);
  return out;
}

// ---------------------------------------------------------------------------
// Status und Plan
// ---------------------------------------------------------------------------

export async function speechStatus(ctx: SetupContext): Promise<StepStatus> {
  const inv = await speechInventory(ctx);
  const fields = fieldStates(SPEECH_FIELDS, {});
  const items = inventoryItems(inv);
  items.push({ label: "Stimme", ok: true, detail: voiceStatusText(inv.voice).replace(/^Vorlesen: /, "").replace(/\.$/, "") });
  if (!inv.sel.ok) return { state: "fehlt", detail: inv.sel.reason, fields, items };
  if (inv.proof.ok && inv.stt === "parakeet") {
    return { state: "erledigt", detail: "Parakeet ist eingerichtet, die Probe bestanden, Hören steht fest auf Parakeet.", fields, items };
  }
  if (inv.proof.ok) {
    return { state: "teilweise", detail: `Parakeet ist eingerichtet und geprüft, Hören steht aber auf ${inv.stt}.`, fields, items };
  }
  if (filesAll(inv)) return { state: "teilweise", detail: `Die Dateien für Parakeet sind da, die Probe fehlt. Nachholen mit ${BRAND.cli} setup sprache.`, fields, items };
  if (filesAny(inv)) return { state: "teilweise", detail: `Parakeet ist unvollständig. Weiter mit ${BRAND.cli} setup sprache.`, fields, items };
  return { state: "fehlt", detail: "Lokales Hören (Parakeet) ist nicht eingerichtet.", fields, items };
}

function parseInventory(values: SetupValues): SpeechInventory | null {
  try {
    return values[INVENTORY] ? (JSON.parse(values[INVENTORY]) as SpeechInventory) : null;
  } catch {
    return null;
  }
}

/** Alternativen bei wenig Arbeitsspeicher, aus dem Vorhandenen */
function alternatives(inv: SpeechInventory): string {
  const parts: string[] = [];
  if (inv.whisper) parts.push("das vorhandene whisper.cpp");
  if (inv.cloud.length) parts.push(`Spracherkennung in der Cloud mit dem vorhandenen Schlüssel (${inv.cloud.join(", ")})`);
  if (!parts.length) parts.push("Spracherkennung in der Cloud mit eigenem Schlüssel (ElevenLabs oder Gemini) oder whisper.cpp");
  return parts.join(" oder ");
}

/** Wird Hören nach diesem Lauf umgestellt? */
function wantsSwitch(inv: SpeechInventory, values: SetupValues): boolean {
  if (inv.stt === "parakeet") return false;
  const answer = inv.stt === "auto" ? values[SWITCH_AUTO_FIELD] : values[SWITCH_FIELD];
  return (answer ?? "true") === "true";
}

/** Vorschlag mit Zahlen: Download und Platz getrennt */
export function proposal(inv: SpeechInventory): string[] {
  if (!inv.sel.ok) return [inv.sel.reason, "Es wird nichts heruntergeladen."];
  const out: string[] = [];
  const all = artifactsFor(inv.sel.key);
  const missing = missingArtifacts(inv);
  const runtime = runtimeArtifact(inv.sel.key);
  const installed = all.reduce((s, a) => s + a.unpackedBytes, 0);
  if (inv.proof.ok) {
    out.push("Parakeet ist eingerichtet und die Probe bestanden. Es wird nichts geladen und nichts neu geprüft.");
  } else if (!missing.length) {
    out.push("Die Dateien für Parakeet sind schon da. Es wird nichts geladen, nur die Probe läuft noch einmal.");
  } else {
    const download = missing.reduce((s, a) => s + a.bytes, 0);
    const parts = missing.map(a =>
      a.id === "modell" ? `Modell ${mb(MODEL_ARTIFACT.bytes)}` : a.id === "laufzeit" ? `Laufzeit ${mb(runtime.bytes)} für ${inv.sel.ok ? inv.sel.label : ""}` : `VAD ${mb(VAD_ARTIFACT.bytes)}`,
    );
    out.push(
      `${PARAKEET_LABEL} (NVIDIA, CC-BY-4.0). Download ca. ${mb(download)} (${parts.join(", ")}), auf der Platte danach ca. ${mb(installed)}, beim Erkennen ${RAM_NEEDED_TEXT} Arbeitsspeicher.`,
    );
    const need = diskNeeded(missing);
    if (inv.freeBytes !== null && inv.freeBytes < need) {
      out.push(`Zu wenig Platz: Während des Entpackens braucht es ca. ${mb(need)} frei, frei sind ${mb(inv.freeBytes)}. Es fehlen ca. ${mb(need - inv.freeBytes)}. Es wird nichts heruntergeladen.`);
    } else {
      out.push(`Während des Entpackens braucht es kurz ca. ${mb(need)} frei (Archive plus entpackte Dateien)${inv.freeBytes !== null ? `, frei sind ${mb(inv.freeBytes)}` : ""}.`);
      out.push("Der Download beginnt erst nach deinem Ja, mit Fortschritt und Prüfsumme je Datei. Abbrechen löscht alle halben Dateien.");
    }
  }
  if (inv.ramBytes < LOW_RAM_BYTES) {
    out.push(`Achtung: Dieser Rechner hat ${formatGib(inv.ramBytes)} Arbeitsspeicher, Parakeet braucht beim Erkennen ${RAM_NEEDED_TEXT}. Das kann knapp werden. Alternative: ${alternatives(inv)}.`);
  }
  if (!inv.proof.ok) out.push("Danach eine Probe mit einer kurzen deutschen Aufnahme und mit zwei Sekunden Stille; erst wenn beide bestehen, gilt Parakeet als eingerichtet.");
  if (!inv.ffmpeg) out.push("ffmpeg fehlt: Aufnahmen aus dem Browser gehen trotzdem, Sprachnachrichten aus Telegram brauchen ffmpeg.");
  return out;
}

/** Bestandsaufnahme als ein Satz für den Plan */
export function inventorySentence(inv: SpeechInventory): string {
  const parts = inventoryItems(inv).map(i => `${i.label}: ${i.detail}`);
  return `Bestandsaufnahme: ${parts.join("; ")}.`;
}

export function speechPlan(values: SetupValues): string[] {
  // Pfad „Telefonhörer" (Issue #260): eigener Plan
  if (isCall(values)) return callPlan(values);
  const inv = parseInventory(values);
  if (!inv) return ["Bestandsaufnahme nicht möglich."];
  const out = [inventorySentence(inv), ...proposal(inv)];
  if (inv.sel.ok) {
    if (inv.stt === "parakeet") out.push("Hören steht schon fest auf Parakeet.");
    else if (wantsSwitch(inv, values)) out.push("Nach bestandener Probe stellt der Assistent Hören fest auf Parakeet (config/settings.json, alle anderen Einstellungen bleiben).");
    else out.push(`Hören bleibt auf ${inv.stt}.`);
    out.push(`${PARAKEET_ATTRIBUTION}.`);
  }
  const choice = values[VOICE_FIELD];
  const voiceChoice = isVoiceChoice(choice) ? choice : voicePreselect(inv.voice.tts);
  out.push(...voicePlan(inv.voice, voiceChoice, values[PIPER_FALLBACK_FIELD] === "true", inv.platform));
  const cloneChoice = values[CLONE_FIELD];
  if (inv.clone) out.push(...clonePlan(inv.clone, isCloneChoice(cloneChoice) ? cloneChoice : "nein", values, voiceChoice === "pocket"));
  return out;
}

// ---------------------------------------------------------------------------
// Ablauf
// ---------------------------------------------------------------------------

export interface SpeechRunDeps {
  fs?: DownloadFs;
  /** Nur für Tests und den Browser-Durchlauf: eigene Artefakte statt der echten */
  artifacts?: Artifact[];
}

/** Ablauf „Sprechmodus lokal“; wirft nie, räumt bei Fehler und Abbruch auf */
export async function runLocalSpeech(values: SetupValues, ctx: SetupContext, report: RunReport, signal: AbortSignal, deps: SpeechRunDeps = {}): Promise<{ ok: boolean; message: string; changed: string[] }> {
  const fs = deps.fs ?? nodeDownloadFs;
  const changed: string[] = [];
  const inv = await speechInventory(ctx);
  // Abbruch vor jeder weiteren Änderung beachten (Download, Nachweis, Einstellung)
  if (signal.aborted) return { ok: false, message: "Abgebrochen. Nichts wurde geändert.", changed };
  if (!inv.sel.ok) return { ok: false, message: `${inv.sel.reason} Es wurde nichts heruntergeladen.`, changed };
  const key = inv.sel.key;
  const dir = speechDir(ctx.root);
  const paths = parakeetPaths(dir, key);
  const switching = wantsSwitch(inv, values);
  if (switching && !inv.settingsValid) {
    return { ok: false, message: "config/settings.json ist ungültig. Bitte erst reparieren oder in der WebUI neu speichern; nichts wurde geladen.", changed };
  }
  const missing = (deps.artifacts ?? ctx.speechArtifacts ?? artifactsFor(key)).filter(a => !inv.files[a.id]);
  // Platz und angezeigte Größen immer aus den echten Paketen, wie im Plan (Attrappen ersetzen nur Inhalt und Adresse)
  const real = artifactsFor(key);
  const realOf = (art: Artifact) => real.find(r => r.id === art.id) ?? art;
  const total = missing.length + (inv.proof.ok ? 0 : 1) + 1;
  let at = 0;

  if (missing.length) {
    const need = diskNeeded(missing.map(realOf));
    if (inv.freeBytes !== null && inv.freeBytes < need) {
      return { ok: false, message: `Zu wenig Platz: es fehlen ca. ${mb(need - inv.freeBytes)} (nötig ca. ${mb(need)}, frei ${mb(inv.freeBytes)}). Es wurde nichts heruntergeladen.`, changed };
    }
    let lastTenth = -1;
    const result = await installArtifacts(
      dir,
      missing,
      { fetch: ctx.fetch, fs, run: ctx.run, signal },
      {
        start: art => {
          at++;
          lastTenth = -1;
          report({ at, total, label: `Lade ${artifactName(art)} (${mb(realOf(art).bytes)})` });
        },
        progress: (art, done, size) => {
          const tenth = Math.floor((done / size) * 10);
          if (tenth === lastTenth) return;
          lastTenth = tenth;
          report({ at, total, label: `Lade ${artifactName(art)} (${mb(realOf(art).bytes)})`, detail: `${tenth * 10} %` });
        },
        unpack: art => {
          if (art.archiveDir) report({ at, total, label: `Prüfsumme stimmt, entpacke ${artifactName(art)}` });
        },
      },
    );
    if (!result.ok) {
      const done = missing.filter(a => artifactFiles(paths, a.id).every(f => statFile(f) !== null));
      const kept = done.length ? ` Vollständig abgelegt und geprüft: ${done.map(artifactName).join(", ")}.` : "";
      return { ok: false, message: `${result.aborted ? "Abgebrochen. Halbe Dateien sind gelöscht." : `${result.message} Halbe Dateien sind gelöscht.`}${kept}`, changed: done.length ? [dir] : [] };
    }
    changed.push(dir);
  }

  let probeText = "";
  if (!inv.proof.ok) {
    if (signal.aborted) return { ok: false, message: "Abgebrochen. Kein Nachweis geschrieben.", changed };
    at++;
    report({ at, total, label: "Probe mit einer deutschen Aufnahme und mit Stille" });
    // Ein alter Nachweis gilt nicht mehr, bis die neue Probe besteht
    await rm(paths.proof, { force: true }).catch(() => {});
    const probe = await probeCandidate(ctx, paths, key, signal);
    if (!probe.ok) return { ok: false, message: probe.aborted ? "Abgebrochen. Kein Nachweis geschrieben." : `${probe.message} Kein Nachweis geschrieben, Hören bleibt unverändert.`, changed };
    const proof = buildProof(paths, key, statFile, { wer: Math.round(probe.wer * 1000) / 1000, ms: probe.ms, at: ctx.now().toISOString() });
    if (!proof) return { ok: false, message: "Nach der Probe fehlte eine Datei. Kein Nachweis geschrieben.", changed };
    if (signal.aborted) return { ok: false, message: "Abgebrochen. Kein Nachweis geschrieben.", changed };
    try {
      await writeFile(paths.proof, JSON.stringify(proof, null, 2) + "\n", { mode: 0o600 });
    } catch (e) {
      return { ok: false, message: `Nachweis nicht geschrieben (${e instanceof Error ? e.name : "Fehler"}).`, changed };
    }
    if (!changed.includes(dir)) changed.push(paths.proof);
    probeText = `Probe bestanden. ${describeProbe(probe)}`;
  }

  at++;
  report({ at, total, label: "Einstellung fürs Hören" });
  if (signal.aborted) return { ok: false, message: `${probeText} Abgebrochen. Hören ist nicht umgestellt.`.trim(), changed };
  let settingText: string;
  if (inv.stt === "parakeet") settingText = "Hören steht schon fest auf Parakeet.";
  else if (!switching) settingText = `Hören bleibt auf ${inv.stt}${inv.stt === "auto" ? ` (${AUTO_EXPLANATION})` : ""}.`;
  else {
    try {
      await updateSettings(s => ({ ...s, speech: { ...s.speech, stt: "parakeet" } }), { path: ctx.settingsPath });
      changed.push(ctx.settingsPath);
      settingText = "Hören steht jetzt fest auf Parakeet; der Bot nutzt es ab der nächsten Aufnahme, ohne Neustart.";
    } catch (e) {
      const why = e instanceof SettingsFileInvalidError ? "config/settings.json ist ungültig" : "config/settings.json ließ sich nicht schreiben";
      return { ok: false, message: `${probeText} ${why}; Hören ist nicht umgestellt.`.trim(), changed };
    }
  }
  const head = inv.proof.ok ? "Parakeet ist schon eingerichtet, nichts geladen." : "Parakeet ist eingerichtet.";
  return { ok: true, message: [head, probeText, settingText, `${PARAKEET_ATTRIBUTION}.`].filter(Boolean).join(" "), changed };
}

function artifactName(art: Artifact): string {
  return art.id === "modell" ? "Modell" : art.id === "laufzeit" ? "Laufzeit sherpa-onnx" : "VAD (Silero)";
}

/**
 * Ganzer Ablauf: erst Hören (Parakeet), dann der Teil Stimme (Issue #252).
 * Die Stimme läuft auch, wenn Hören scheiterte (etwa zu wenig Platz für
 * Parakeet), nur nach Abbruch nicht.
 */
export async function runSpeech(values: SetupValues, ctx: SetupContext, report: RunReport, signal: AbortSignal): Promise<ApplyResult> {
  const hearing = await runLocalSpeech(values, ctx, report, signal);
  if (signal.aborted) return hearing;
  const inv = await speechInventory(ctx);
  const voice = await runVoice(values, ctx, { ...inv.voice, settingsValid: inv.settingsValid }, report, signal, ctx.speechVoice);
  // Eigene Stimme (Issue #253) nach der Stimme: Pocket mit Klon braucht das eingerichtete Pocket TTS
  let cloneAt = 0;
  const clone = signal.aborted ? null : await runClone(values, ctx, signal, label => report({ at: ++cloneAt, total: Math.max(cloneAt, 3), label: `Eigene Stimme: ${label}` }), ctx.speechVoice);
  return {
    ok: hearing.ok && voice.ok && (clone?.ok ?? true),
    message: `Hören: ${hearing.message} ${voice.message}${clone ? ` ${clone.message}` : ""}`,
    changed: [...new Set([...hearing.changed, ...voice.changed, ...(clone?.changed ?? [])])],
    ...(voice.audio ? { audio: voice.audio } : {}),
  };
}

export const speechStep: SetupStep = {
  id: "sprache",
  title: "Sprache",
  description: `Sprechmodus auf diesem Rechner: Parakeet erkennt Sprache ohne Cloud-Schlüssel, und als Stimme fürs Vorlesen gibt es neben der Browser-Stimme eine lokale Stimme (Pocket TTS, auf schwachen Rechnern Piper) oder ElevenLabs. Ohne das hört ${BRAND.name} nur mit whisper.cpp oder über die Cloud und liest mit der Browser-Stimme vor.`,
  optional: true,
  fields: SPEECH_FIELDS,
  status: speechStatus,

  /** Gesamtprüfung: nur die Dateien und der Nachweis, sherpa startet nicht */
  async test(_values, ctx) {
    const inv = await speechInventory(ctx);
    if (!inv.sel.ok) return { ok: false, message: inv.sel.reason };
    const voice = voiceStatusText(inv.voice);
    return inv.proof.ok
      ? { ok: true, message: `Parakeet: eingerichtet, Probe bestanden${inv.stt === "parakeet" ? ", Hören fest auf Parakeet" : `, Hören steht auf ${inv.stt}`}. ${voice}` }
      : { ok: false, message: `Parakeet: ${inv.proof.reason ?? "nicht eingerichtet"}. ${voice}` };
  },

  runWhen: v => isLocal(v) || isCall(v),
  plan: speechPlan,
  run: (values, ctx, report, signal) => (isCall(values) ? runCallSetup(values, ctx, report, signal) : runSpeech(values, ctx, report, signal)),
};
