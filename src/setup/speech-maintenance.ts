/**
 * Lokale Sprachmodelle in Gesamtprüfung und Deinstallation (Issue #251).
 * Eigene Funktionen, damit sie isoliert mit Attrappen testbar sind; die
 * Gesamtläufe von tybo pruefen (src/setup/checks/speech.ts) und tybo deinstallieren (src/setup/services/uninstall.ts) greifen auf echte
 * Dienste zu und laufen in Tests nicht.
 *
 * - checkLocalStt: nur wenn speech.stt auf parakeet steht oder auf auto mit
 *   vorhandenem Parakeet. Ergebnis aus available() (Dateien und Nachweis),
 *   sherpa-onnx startet nie.
 * - checkLocalTts (Issue #252): nur wenn speech.tts auf pocket oder piper
 *   steht; Ergebnis aus Dateien und Nachweis, kein Prozess startet.
 * - removeSpeechModels: fragt, ob models/speech/ gelöscht werden soll, und
 *   löscht nach „Ja“ genau diesen Ordner, nie andere Dateien unter models/.
 *   Darin liegen auch Pocket TTS und Piper samt ihrer Python-Umgebungen.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { settingsSchema } from "../lib/settings";
import { isSttChoice, isTtsChoice, type SttChoice, type TtsChoice } from "../lib/speech/ids";
import { PIPER_ATTRIBUTION, piperAvailability, piperPaths } from "../lib/speech/piper";
import { POCKET_ATTRIBUTION, POCKET_DEFAULT_VOICE, pocketAvailability, pocketPaths } from "../lib/speech/pocket";
import { parakeetAvailability, PARAKEET_ATTRIBUTION, speechDir, type StatFn } from "../lib/speech/parakeet";

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export interface LocalSttInput {
  /** Projektordner */
  root: string;
  platform: string;
  arch: string;
  /** Inhalt von config/settings.json (null: fehlt) */
  settingsText: string | null;
  /** SPEECH_STT aus der Umgebung */
  envStt: string | undefined;
  stat?: StatFn;
  readText?: (path: string) => string | null;
}

const stat0: StatFn = path => {
  try {
    const s = statSync(path);
    return s.isFile() ? { size: s.size, mtimeMs: s.mtimeMs } : null;
  } catch {
    return null;
  }
};

const read0 = (path: string): string | null => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** Wirksame Wahl fürs Hören wie in der Kette: Datei vor SPEECH_STT vor auto */
export function effectiveStt(settingsText: string | null, envStt: string | undefined): SttChoice {
  if (settingsText !== null) {
    try {
      const parsed = settingsSchema.safeParse(JSON.parse(settingsText));
      const fromFile = parsed.success ? parsed.data.speech?.stt : undefined;
      if (fromFile) return fromFile;
    } catch {
      // ungültig: wie die Laufzeit auf Umgebung und Standard zurück
    }
  }
  const env = envStt?.trim().toLowerCase();
  return isSttChoice(env) ? env : "auto";
}

/** Prüfung des lokalen Hörens; null, wenn sie nicht zutrifft (andere Wahl, auto ohne Parakeet) */
export function checkLocalStt(input: LocalSttInput): { name: string; status: CheckStatus; message: string } | null {
  const stt = effectiveStt(input.settingsText, input.envStt);
  const dir = speechDir(input.root);
  const readText = input.readText ?? read0;
  const avail = parakeetAvailability(dir, input.platform, input.arch, input.stat ?? stat0, readText);
  const name = "Parakeet (lokales Hören)";
  if (stt === "parakeet") {
    return avail.ok
      ? { name, status: "pass", message: `Eingerichtet und geprüft. ${PARAKEET_ATTRIBUTION}.` }
      : { name, status: "fail", message: `Hören steht fest auf Parakeet, aber ${avail.reason ?? "nicht verfügbar"}.` };
  }
  if (stt !== "auto") return null;
  // auto: nur prüfen, wenn Parakeet da ist (Ordner models/speech vorhanden)
  if (!existsSync(dir)) return null;
  return avail.ok
    ? { name, status: "pass", message: "Hören steht auf auto, Parakeet ist eingerichtet und kommt zuerst dran." }
    : { name, status: "warn", message: `Hören steht auf auto und überspringt Parakeet: ${avail.reason ?? "nicht verfügbar"}.` };
}

/** Wirksame Wahl fürs Sprechen wie in der Kette: Datei vor SPEECH_TTS vor auto */
export function effectiveTts(settingsText: string | null, envTts: string | undefined): TtsChoice {
  if (settingsText !== null) {
    try {
      const parsed = settingsSchema.safeParse(JSON.parse(settingsText));
      const fromFile = parsed.success ? parsed.data.speech?.tts : undefined;
      if (fromFile) return fromFile;
    } catch {
      // ungültig: Umgebung und Standard
    }
  }
  const env = envTts?.trim().toLowerCase();
  return isTtsChoice(env) ? env : "auto";
}

/** Prüfung der lokalen Stimme; null, wenn weder pocket noch piper gewählt ist */
export function checkLocalTts(input: { root: string; settingsText: string | null; envTts: string | undefined; pocketVoice?: string; exists?: (p: string) => boolean; readText?: (p: string) => string | null }): { name: string; status: CheckStatus; message: string } | null {
  const tts = effectiveTts(input.settingsText, input.envTts);
  const dir = speechDir(input.root);
  const exists = input.exists ?? existsSync;
  const readText = input.readText ?? read0;
  if (tts === "pocket") {
    const a = pocketAvailability(pocketPaths(dir), exists, readText, input.pocketVoice || POCKET_DEFAULT_VOICE);
    const name = "Pocket TTS (lokale Stimme)";
    return a.ok ? { name, status: "pass", message: `Eingerichtet und geprüft. ${POCKET_ATTRIBUTION}.` } : { name, status: "fail", message: `Vorlesen steht auf Pocket TTS, aber ${a.reason ?? "nicht verfügbar"}.` };
  }
  if (tts === "piper") {
    const a = piperAvailability(piperPaths(dir), exists, readText);
    const name = "Piper (lokale Stimme)";
    return a.ok ? { name, status: "pass", message: `Eingerichtet und geprüft. ${PIPER_ATTRIBUTION}.` } : { name, status: "fail", message: `Vorlesen steht auf Piper, aber ${a.reason ?? "nicht verfügbar"}.` };
  }
  return null;
}

export type RemoveOutcome = "fehlt" | "behalten" | "gelöscht" | "fehler";

/** Fragt und löscht nach „Ja“ nur models/speech/ */
export async function removeSpeechModels(
  root: string,
  ask: (question: string) => Promise<boolean>,
  log: (line: string) => void,
  remove: (path: string) => Promise<void> = path => rm(path, { recursive: true, force: true }),
  exists: (path: string) => boolean = existsSync,
): Promise<RemoveOutcome> {
  const dir = speechDir(root);
  if (!exists(dir)) return "fehlt";
  const yes = await ask("Lokale Sprachmodelle in models/speech/ löschen (Parakeet, sherpa-onnx, Pocket TTS, Piper samt ihrer Python-Umgebungen; andere Modelle unter models/ bleiben)? [j/N] ");
  if (!yes) {
    log("models/speech/ bleibt.");
    return "behalten";
  }
  try {
    await remove(join(root, "models", "speech"));
    log("models/speech/ gelöscht.");
    return "gelöscht";
  } catch (e) {
    log(`models/speech/ ließ sich nicht löschen (${e instanceof Error ? e.name : "Fehler"}).`);
    return "fehler";
  }
}
