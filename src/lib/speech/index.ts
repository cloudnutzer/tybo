/**
 * Sprach-Schnittstelle (Issue #248, Entscheidung 0023): Hören und Sprechen
 * mit austauschbaren Anbietern. transcribe.ts ruft getSpeech(), das Sprechen
 * für Telegram, /voice und elevenlabs_tts geht über textToSpeech und
 * isVoiceEnabled unten; Tests setzen mit setSpeechForTests eine Instanz mit
 * Attrappen.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { getSettings } from "../settings";
import { createSpeech, type Speech } from "./chain";
import { createCloneTts, type CloneTts } from "./clone";
import { runProcess } from "./process";
import { createSttProviders, createTtsProviders, type ProviderDeps } from "./providers";

export { createSpeech, type Speech, type SpeechChoice, type SpeechOptions, type LocalModeStatus, type RecognizeResult, type SynthesizeResult } from "./chain";
export { STT_IDS, TTS_IDS, type SttId, type TtsId } from "./ids";

/** Echte Abhängigkeiten der Anbieter */
export const realProviderDeps: ProviderDeps = {
  env: () => process.env,
  run: runProcess,
  fetch: (url, init) => fetch(url, init),
  exists: existsSync,
  which: cmd => Bun.which(cmd),
  readFile: path => readFile(path),
  writeFile: (path, data) => writeFile(path, data),
  unlink: path => unlink(path),
  mkdir: async path => {
    await mkdir(path, { recursive: true });
  },
  cwd: () => process.cwd(),
  // Wie bisher /tmp (mlx-audio schreibt relativ zum cwd); tmpdir() nur, wo es /tmp nicht gibt
  tmpDir: existsSync("/tmp") ? "/tmp" : tmpdir(),
  unique: () => `${Math.floor(Math.random() * 1e9).toString(36)}`,
  // Pocket TTS (Issue #252): der Kindprozess endet mit dem Bot
  onPocketServer: server => {
    process.once("exit", () => server.stop());
  },
  // Eigene Stimme (Issue #253): gewählt in config/settings.json
  cloneSelection: () => {
    const s = getSettings().speech ?? {};
    return { ...(s.cloneVoice ? { voice: s.cloneVoice } : {}), ...(s.cloneEngine ? { engine: s.cloneEngine } : {}) };
  },
};

let instance: Speech | null = null;
let clone: CloneTts | null = null;

/** Eigene Stimme (Issue #253): Engine, Probe, Vergessen; derselbe Anbieter wie in getSpeech() */
export function getCloneTts(): CloneTts {
  clone ??= createCloneTts(realProviderDeps);
  return clone;
}

export function getSpeech(): Speech {
  instance ??= createSpeech({
    stt: createSttProviders(realProviderDeps),
    tts: createTtsProviders(realProviderDeps, getCloneTts()),
    getSettings,
    env: () => process.env,
    log: line => console.log(line),
    readFile: path => readFile(path),
  });
  return instance;
}

/**
 * Sprachnachricht erzeugen (Issue #367, vorher eine Hülle in voice.ts): Audio
 * vom gewählten Server-Anbieter bzw. der Kette (speech.tts, SPEECH_TTS). Ist
 * die Browser-Stimme gewählt, spricht trotzdem der Server, denn eine
 * Sprachnachricht braucht Bytes. null: kein Anbieter lieferte.
 */
export function textToSpeech(text: string): Promise<Buffer | null> {
  return getSpeech().synthesizeServer(text);
}

/** Ob ein Server-Anbieter Sprachnachrichten erzeugen kann; die Browser-Stimme allein reicht nicht */
export function isVoiceEnabled(): boolean {
  return getSpeech().isVoiceEnabled();
}

/** Nur für Tests: eigene Instanz (ohne Argument: wieder die echte) */
export function setSpeechForTests(speech?: Speech, cloneTts?: CloneTts): void {
  instance = speech ?? null;
  clone = cloneTts ?? null;
}
