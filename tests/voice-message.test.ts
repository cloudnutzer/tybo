/**
 * Issue #78, Checkbox 4: Sprachsynthese für /voice aus Browser und Terminal
 * (src/lib/voice-message.ts). textToSpeech ist eine Attrappe; das Format
 * kommt aus den Bytes, WAV wird nach Ogg/Opus gewandelt oder gar nicht
 * verschickt. Der Versand (createTelegramVoiceSender, in src/bot.ts
 * verdrahtet) läuft über eine echte grammY-Api ohne Netz.
 */
import { describe, expect, test } from "bun:test";
import { Api, InputFile } from "grammy";
import { detectAudioType } from "../src/lib/audio-type";
import { convertWavWithFfmpeg, createTelegramVoiceSender, createVoiceSynthesis } from "../src/lib/voice-message";
import { htmlFixture, mp3FrameFixture, mp3Id3Fixture, oggOpusFixture, svgFixture, wavFixture } from "./audio-fixture";

function synthesis(audio: Buffer | null | (() => Promise<Buffer | null>), convertWav?: (wav: Buffer) => Promise<Buffer | null>) {
  const logs: string[] = [];
  const texts: string[] = [];
  const voice = createVoiceSynthesis({
    enabled: () => true,
    textToSpeech: async text => {
      texts.push(text);
      return typeof audio === "function" ? audio() : audio;
    },
    convertWav: convertWav ?? (async () => null),
    log: m => logs.push(m),
  });
  return { voice, logs, texts };
}

describe("createVoiceSynthesis", () => {
  test("MP3 und Ogg/Opus gehen unverändert weiter, Name und MIME aus den Bytes", async () => {
    for (const [audio, mime, fileName] of [
      [mp3Id3Fixture(), "audio/mpeg", "antwort.mp3"],
      [mp3FrameFixture(), "audio/mpeg", "antwort.mp3"],
      [oggOpusFixture(), "audio/ogg", "antwort.ogg"],
    ] as const) {
      const { voice, texts } = synthesis(audio);
      expect(await voice.synthesize("Hallo")).toEqual({ audio, mime, fileName });
      expect(texts).toEqual(["Hallo"]);
    }
  });

  test("WAV wird nach Ogg/Opus gewandelt, wenn der Wandler Ogg/Opus liefert", async () => {
    const wav = wavFixture();
    const seen: Buffer[] = [];
    const { voice } = synthesis(wav, async input => (seen.push(input), oggOpusFixture()));
    expect(await voice.synthesize("Hallo")).toEqual({ audio: oggOpusFixture(), mime: "audio/ogg", fileName: "antwort.ogg" });
    expect(seen).toEqual([wav]);
  });

  test("WAV ohne gelungene Wandlung (ffmpeg fehlt, Fehler, kein Ogg/Opus): fehlgeschlagen, kein WAV", async () => {
    for (const convert of [async () => null, async () => htmlFixture(), async () => wavFixture(), async () => Promise.reject(new Error("weg"))]) {
      const { voice, logs } = synthesis(wavFixture(), convert as (wav: Buffer) => Promise<Buffer | null>);
      expect(await voice.synthesize("Hallo")).toBeNull();
      expect(logs).toEqual(["WAV nicht nach Ogg/Opus gewandelt, keine Sprachnachricht"]);
    }
  });

  test("null, Fehler, HTML und SVG: fehlgeschlagen (null), ohne Inhalte im Log", async () => {
    for (const audio of [null, Buffer.alloc(0), htmlFixture(), svgFixture(), async () => Promise.reject(new Error("geheim sk-123"))]) {
      const { voice, logs } = synthesis(audio as any);
      expect(await voice.synthesize("Hallo")).toBeNull();
      expect(logs.join(" ")).not.toContain("geheim");
      expect(logs.join(" ")).not.toContain("Hallo");
    }
  });

  test("enabled kommt aus der Abhängigkeit", () => {
    const off = createVoiceSynthesis({ enabled: () => false, textToSpeech: async () => null });
    expect(off.enabled()).toBe(false);
  });
});

describe("convertWavWithFfmpeg", () => {
  test.skipIf(!Bun.which("ffmpeg"))("wandelt WAV im Speicher nach Ogg/Opus (nur mit installiertem ffmpeg)", async () => {
    const ogg = await convertWavWithFfmpeg(wavFixture());
    expect(detectAudioType(ogg)).toEqual({ mime: "audio/ogg", ext: ".ogg" });
  });

  test.skipIf(!Bun.which("ffmpeg"))("kaputte Eingabe: null statt Ausnahme", async () => {
    expect(await convertWavWithFfmpeg(htmlFixture())).toBeNull();
  });
});

/** Echte grammY-Api; ein Transformer fängt jeden Aufruf ab, nichts geht ins Netz */
function telegramApi() {
  const calls: { method: string; payload: Record<string, unknown> }[] = [];
  const api = new Api("123456:test-token");
  api.config.use(async (_prev, method, payload) => {
    calls.push({ method, payload: payload as Record<string, unknown> });
    return { ok: true, result: {} } as any;
  });
  return { api, calls };
}

const bytesOf = (file: unknown) => Buffer.from((file as any).fileData as Uint8Array);

describe("createTelegramVoiceSender: Versand in src/bot.ts", () => {
  test("Ogg/Opus und MP3 gehen per sendVoice raus, mit Thread, nie als Dokument", async () => {
    for (const [audio, fileName] of [[oggOpusFixture(), "antwort.ogg"], [mp3FrameFixture(), "antwort.mp3"], [mp3Id3Fixture(), "antwort.mp3"]] as const) {
      const { api, calls } = telegramApi();
      await createTelegramVoiceSender(api)("-100123", audio, fileName, 443);
      expect(calls.map(c => c.method)).toEqual(["sendVoice"]);
      expect(calls[0]!.payload).toMatchObject({ chat_id: "-100123", message_thread_id: 443 });
      const voice = calls[0]!.payload.voice;
      expect(voice).toBeInstanceOf(InputFile);
      expect((voice as InputFile).filename).toBe(fileName);
      expect(bytesOf(voice).equals(audio)).toBe(true);
    }
  });

  test("Direktchat: ohne Thread", async () => {
    const { api, calls } = telegramApi();
    await createTelegramVoiceSender(api)("42", mp3FrameFixture(), "antwort.mp3");
    expect(calls.map(c => c.method)).toEqual(["sendVoice"]);
    expect(calls[0]!.payload).not.toHaveProperty("message_thread_id");
  });

  test("WAV, HTML und SVG: wirft, ohne Telegram aufzurufen", async () => {
    for (const [audio, fileName] of [[wavFixture(), "antwort.wav"], [htmlFixture(), "antwort.mp3"], [svgFixture(), "antwort.ogg"]] as const) {
      const { api, calls } = telegramApi();
      await expect(createTelegramVoiceSender(api)("42", audio, fileName)).rejects.toThrow();
      expect(calls).toEqual([]);
    }
  });

  test("WAV mit gelungener Wandlung: Synthese und Versand ergeben eine Sprachnachricht (Ogg/Opus)", async () => {
    const { voice } = synthesis(wavFixture(), async () => oggOpusFixture());
    const audio = (await voice.synthesize("Hallo"))!;
    const { api, calls } = telegramApi();
    await createTelegramVoiceSender(api)("42", audio.audio, audio.fileName);
    expect(calls.map(c => c.method)).toEqual(["sendVoice"]);
    expect((calls[0]!.payload.voice as InputFile).filename).toBe("antwort.ogg");
    expect(bytesOf(calls[0]!.payload.voice).equals(oggOpusFixture())).toBe(true);
  });

  test.skipIf(!Bun.which("ffmpeg"))("WAV mit echtem ffmpeg: gewandelt, streng dekodierbar, per sendVoice (nur mit installiertem ffmpeg)", async () => {
    const voice = createVoiceSynthesis({ enabled: () => true, textToSpeech: async () => wavFixture() });
    const audio = (await voice.synthesize("Hallo"))!;
    expect(audio).toMatchObject({ mime: "audio/ogg", fileName: "antwort.ogg" });
    const { api, calls } = telegramApi();
    await createTelegramVoiceSender(api)("42", audio.audio, audio.fileName);
    expect(calls.map(c => c.method)).toEqual(["sendVoice"]);
    const proc = Bun.spawn(["ffmpeg", "-v", "error", "-xerror", "-err_detect", "explode", "-i", "pipe:0", "-f", "null", "-"], {
      stdin: bytesOf(calls[0]!.payload.voice),
      stderr: "pipe",
    });
    expect(await new Response(proc.stderr).text()).toBe("");
    expect(await proc.exited).toBe(0);
  });
});
