/**
 * Sprachsynthese für /voice aus Browser und Terminal (Issue #78).
 *
 * Nimmt textToSpeech aus src/lib/voice.ts unverändert und prüft das Ergebnis
 * an den Bytes (./audio-type.ts): nur Ogg/Opus, MP3 und WAV gehen weiter,
 * alles andere gilt als fehlgeschlagene Synthese. WAV spielt Telegram nicht
 * als Sprachnachricht ab; es wird deshalb mit ffmpeg nach Ogg/Opus gewandelt
 * (nur im Speicher, über stdin/stdout). Fehlt ffmpeg oder scheitert die
 * Wandlung, gilt die Synthese als fehlgeschlagen: kein Versand, die Antwort
 * bleibt als Text.
 *
 * createTelegramVoiceSender ist der Versand für src/bot.ts: immer sendVoice,
 * nur Ogg/Opus und MP3, nie als Datei.
 *
 * Die Audiodaten bleiben im Speicher; hier entsteht keine Datei (das lokale
 * TTS in voice.ts nutzt wie bisher kurz /tmp).
 */

import { InputFile, type Api } from "grammy";
import { detectAudioType } from "./audio-type";
import type { SynthesizedAudio, VoiceSynthesis } from "./commands/types";

export interface VoiceSynthesisDeps {
  enabled(): boolean;
  textToSpeech(text: string): Promise<Buffer | null>;
  /** WAV nach Ogg/Opus; null, wenn es nicht geht (Standard: ffmpeg, falls vorhanden) */
  convertWav?(wav: Buffer): Promise<Buffer | null>;
  /** Nie Texte oder Audiodaten übergeben */
  log?(message: string): void;
}

const FFMPEG_TIMEOUT_MS = 60_000;

/** WAV über ffmpeg nach Ogg/Opus, ohne Dateien; null bei fehlendem ffmpeg, Fehler oder Zeitüberschreitung */
export async function convertWavWithFfmpeg(wav: Buffer): Promise<Buffer | null> {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  const timer = setTimeout(() => proc?.kill(), FFMPEG_TIMEOUT_MS);
  try {
    proc = Bun.spawn(["ffmpeg", "-loglevel", "error", "-f", "wav", "-i", "pipe:0", "-c:a", "libopus", "-b:a", "48k", "-f", "ogg", "pipe:1"], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    const stdin = proc.stdin as import("bun").FileSink;
    stdin.write(wav);
    await stdin.end();
    const out = Buffer.from(await new Response(proc.stdout as ReadableStream<Uint8Array>).arrayBuffer());
    return (await proc.exited) === 0 ? out : null;
  } catch {
    // ffmpeg fehlt (ENOENT) oder bricht ab
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function createVoiceSynthesis(deps: VoiceSynthesisDeps): VoiceSynthesis {
  const log = deps.log ?? (() => {});
  const convertWav = deps.convertWav ?? convertWavWithFfmpeg;

  return {
    enabled: () => deps.enabled(),
    async synthesize(text: string): Promise<SynthesizedAudio | null> {
      let audio: Buffer | null;
      try {
        audio = await deps.textToSpeech(text);
      } catch (e) {
        log(`Sprachsynthese fehlgeschlagen (${e instanceof Error ? e.name : typeof e})`);
        return null;
      }
      let type = detectAudioType(audio);
      if (!audio || !type) {
        if (audio) log("Sprachsynthese lieferte kein erkennbares Audio");
        return null;
      }
      if (type.ext === ".wav") {
        const converted = await convertWav(audio).catch(() => null);
        const convertedType = detectAudioType(converted);
        if (converted && convertedType?.ext === ".ogg") {
          audio = converted;
          type = convertedType;
        } else {
          log("WAV nicht nach Ogg/Opus gewandelt, keine Sprachnachricht");
          return null;
        }
      }
      return { audio, mime: type.mime, fileName: `antwort${type.ext}` };
    },
  };
}

/**
 * Sprachnachricht über die Bot-API (sendVoice). Wirft bei allem außer
 * Ogg/Opus und MP3, ohne Telegram aufzurufen; WAV geht nie als Datei raus.
 */
export function createTelegramVoiceSender(api: Pick<Api, "sendVoice">) {
  return async (chatId: string, audio: Buffer, fileName: string, threadId?: number): Promise<void> => {
    const type = detectAudioType(audio);
    if (!type || type.ext === ".wav") throw new Error("Kein Sprachnachrichten-Format");
    await api.sendVoice(chatId, new InputFile(audio, fileName), threadId ? { message_thread_id: threadId } : {});
  };
}
