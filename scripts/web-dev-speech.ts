/**
 * Echte Sprach-Schnittstelle ohne Bot (Issue #250) für web:dev mit
 * WEB_DEV_SPEECH=real (createWebDevSpeech) und für den Sprechmodus-Durchlauf
 * (scripts/web-sprechmodus-check.ts --echt, createDevSpeech).
 *
 * Dieselbe Kette wie getSpeech() in src/lib/speech/index.ts (createSpeech mit
 * den echten Anbietern: recognize, synthesizeSpeech, localMode), aber mit
 * hereingereichten Einstellungen statt config/settings.json. So entscheidet
 * im Testaufbau der Aufbau selbst (web:dev: seine Einstellungen im Speicher,
 * sonst SPEECH_STT/SPEECH_TTS der Befehlszeile), nie eine Datei des
 * Checkouts, die Vorrang vor der Umgebung hätte.
 *
 * Importiert src/bot.ts nicht, auch nicht über Umwege: nur src/lib/speech
 * (und darüber src/lib/settings.ts für getSpeech). Nichts pollt Telegram.
 */

import { readFile } from "node:fs/promises";
import type { Settings } from "../src/lib/settings";
import { createSpeech, realProviderDeps, type Speech } from "../src/lib/speech";
import { createSttProviders, createTtsProviders, type ProviderDeps } from "../src/lib/speech/providers";
import type { SettingsData, SettingsPort } from "../src/web/settings";
import type { SpeechPort } from "../src/web/speech";
import type { VoicePort } from "../src/web/voice";

export interface DevSpeechOptions {
  /** Einstellungen des Aufbaus (nur speech zählt); nie config/settings.json */
  settings: () => Settings;
  /** Umgebung für Anbieterwahl und Anbieter; Standard process.env */
  env?: () => Record<string, string | undefined>;
  /** Arbeitsverzeichnis der Anbieter (Temp-Datei von whisper.cpp unter uploads/, Standardpfad des Modells) */
  cwd?: () => string;
  log?: (line: string) => void;
}

export interface DevSpeech {
  speech: Speech;
  /** Für WebServerDeps.speech */
  port: SpeechPort;
  /** Für WebServerDeps.voice */
  voice: VoicePort;
}

export function createDevSpeech(options: DevSpeechOptions): DevSpeech {
  const env = options.env ?? (() => process.env);
  const providerDeps: ProviderDeps = { ...realProviderDeps, env, ...(options.cwd ? { cwd: options.cwd } : {}) };
  const speech = createSpeech({
    stt: createSttProviders(providerDeps),
    tts: createTtsProviders(providerDeps),
    getSettings: options.settings,
    env,
    log: options.log ?? (line => console.log(line)),
    readFile: path => readFile(path),
  });
  const port: SpeechPort = {
    recognize: (audio, mime, opts) => speech.recognize(Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength), mime, { timeoutMs: opts.timeoutMs }),
    async synthesize(text, opts) {
      const result = await speech.synthesizeSpeech(text, opts);
      // Auch reason voice (Stimme beim Anbieter nicht freigegeben, Issue #252) geht an die Route: 400
      return result;
    },
  };
  return { speech, port, voice: { localMode: () => speech.localMode() } };
}

/**
 * web:dev mit WEB_DEV_SPEECH=real: Hören und Sprechen über die echte Kette.
 * Gewählt wird wie im Bot, nur aus den Einstellungen von web:dev (im
 * Speicher, Reiter „Sprechen") statt config/settings.json; fehlt dort ein
 * Wert, gilt SPEECH_STT bzw. SPEECH_TTS aus der Befehlszeile, sonst auto.
 * settings ist dieselbe Einstellungs-Attrappe, nur mit den echten
 * Anbieterlisten samt Verfügbarkeit.
 */
export function createWebDevSpeech<T extends SettingsPort & { data(): SettingsData }>(
  settings: T,
  options: Omit<DevSpeechOptions, "settings"> = {}
): DevSpeech & { settings: T } {
  // Die Demo-Einstellungen prüfen die Kennungen wie das Schema (dieselben Listen)
  const dev = createDevSpeech({ ...options, settings: () => ({ speech: settings.data().speech }) as Settings });
  // Alles andere (auch Getter wie agents) weiter von der Attrappe
  const port: T = Object.create(settings);
  port.speechOptions = () => dev.speech.options();
  return { ...dev, settings: port };
}
