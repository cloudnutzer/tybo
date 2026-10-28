/**
 * Sprach-Schnittstelle (Issue #248): Auswahl und Weiterschalten mit
 * Anbieter-Attrappen. Kein Netzwerk, kein Subprozess, kein Modell.
 */

import { describe, expect, test } from "bun:test";
import { createSpeech, TRANSCRIPTION_TEXT, type SpeechDeps } from "../src/lib/speech/chain";
import { SpeechError, type SttProvider, type TtsProvider } from "../src/lib/speech/types";
import { settingsSchema, type Settings } from "../src/lib/settings";
import type { SttId, TtsId } from "../src/lib/speech/ids";

type Behavior = "ok" | "empty" | "blank" | "throw" | "unavailable";

function fakeStt(id: SttId, behavior: Behavior, calls: string[]): SttProvider {
  return {
    id,
    label: `Label-${id}`,
    local: id === "parakeet" || id === "whisper-cpp",
    available: () => (behavior === "unavailable" ? { ok: false, reason: "Grund-" + id } : { ok: true }),
    transcribe: async (_audio, _mime, opts) => {
      calls.push(`${id}:${opts.language ?? "-"}`);
      if (behavior === "throw") throw new SpeechError("exit", 1);
      if (behavior === "empty") return "";
      if (behavior === "blank") return "   \n";
      return `Text von ${id}`;
    },
  };
}

function fakeTts(id: TtsId, behavior: Behavior, calls: string[]): TtsProvider {
  return {
    id,
    label: `Label-${id}`,
    local: id !== "elevenlabs" && id !== "gemini",
    where: id === "browser" ? "browser" : "server",
    available: () => (behavior === "unavailable" ? { ok: false, reason: "Grund-" + id } : { ok: true }),
    synthesize: async () => {
      calls.push(id);
      if (behavior === "throw" || id === "browser") throw new SpeechError("unavailable");
      return { audio: Buffer.from(`audio-${id}`), mime: "audio/ogg" };
    },
  };
}

interface Setup {
  stt?: Partial<Record<SttId, Behavior>>;
  tts?: Partial<Record<TtsId, Behavior>>;
  settings?: Settings;
  env?: Record<string, string | undefined>;
}

function setup(o: Setup = {}) {
  const calls: string[] = [];
  const logs: string[] = [];
  const sttB = { parakeet: "unavailable", "whisper-cpp": "ok", elevenlabs: "ok", gemini: "ok", ...o.stt } as Record<SttId, Behavior>;
  const ttsB = { browser: "ok", "qwen3-mlx": "ok", elevenlabs: "ok", gemini: "ok", pocket: "unavailable", ...o.tts } as Record<TtsId, Behavior>;
  let settings: Settings = o.settings ?? {};
  const deps: SpeechDeps = {
    stt: (Object.keys(sttB) as SttId[]).map(id => fakeStt(id, sttB[id], calls)),
    tts: (Object.keys(ttsB) as TtsId[]).map(id => fakeTts(id, ttsB[id], calls)),
    getSettings: () => settings,
    env: () => o.env ?? {},
    log: line => logs.push(line),
    readFile: async () => Buffer.from("audio"),
    now: () => 0,
  };
  const speech = createSpeech(deps);
  return { speech, calls, logs, setSettings: (s: Settings) => (settings = s) };
}

const AUDIO = Buffer.from("x");

describe("Hören: auto", () => {
  test("Reihenfolge parakeet, whisper-cpp, elevenlabs, gemini", async () => {
    const { speech, calls } = setup({ stt: { parakeet: "throw", "whisper-cpp": "throw", elevenlabs: "throw", gemini: "ok" } });
    expect(await speech.transcribeBuffer(AUDIO)).toBe("Text von gemini");
    expect(calls).toEqual(["parakeet:-", "whisper-cpp:-", "elevenlabs:-", "gemini:-"]);
  });

  test("nicht verfügbare Anbieter werden übersprungen", async () => {
    const { speech, calls } = setup({ stt: { parakeet: "unavailable", "whisper-cpp": "unavailable" } });
    expect(await speech.transcribeBuffer(AUDIO)).toBe("Text von elevenlabs");
    expect(calls).toEqual(["elevenlabs:-"]);
  });

  test("Laufzeitfehler, leeres und nur aus Leerzeichen bestehendes Ergebnis schalten weiter", async () => {
    const { speech, calls } = setup({ stt: { parakeet: "throw", "whisper-cpp": "empty", elevenlabs: "blank" } });
    expect(await speech.transcribeBuffer(AUDIO)).toBe("Text von gemini");
    expect(calls).toEqual(["parakeet:-", "whisper-cpp:-", "elevenlabs:-", "gemini:-"]);
  });

  test("alle verfügbaren gescheitert: [Transcription failed]", async () => {
    const { speech } = setup({ stt: { "whisper-cpp": "throw", elevenlabs: "throw", gemini: "empty" } });
    expect(await speech.transcribeBuffer(AUDIO)).toBe(TRANSCRIPTION_TEXT.failed);
    expect(await speech.transcribeFile("/x/a.ogg")).toBe(TRANSCRIPTION_TEXT.failed);
  });

  test("kein Anbieter verfügbar: die alten Platzhalter je Zugang", async () => {
    const { speech, calls } = setup({ stt: { "whisper-cpp": "unavailable", elevenlabs: "unavailable", gemini: "unavailable" } });
    expect(await speech.transcribeFile("/x/a.ogg")).toBe("[Voice transcription unavailable - no transcription provider configured]");
    expect(await speech.transcribeBuffer(AUDIO)).toBe("[Voice transcription unavailable - no provider configured]");
    expect(calls).toEqual([]);
  });

  test("Lesefehler im Dateiweg wirft nicht", async () => {
    const logs: string[] = [];
    const s = createSpeech({
      stt: [], tts: [], getSettings: () => ({}), env: () => ({}), log: l => logs.push(l),
      readFile: async () => { throw new Error("ENOENT /geheim/pfad"); },
    });
    expect(await s.transcribeFile("/x/a.ogg")).toBe(TRANSCRIPTION_TEXT.failed);
    expect(logs.join("\n")).not.toContain("geheim");
  });
});

describe("Hören: fest gewählt", () => {
  test("nicht verfügbar: klarer Platzhalter, kein anderer Anbieter, Log mit Grund", async () => {
    const { speech, calls, logs } = setup({ settings: { speech: { stt: "whisper-cpp" } }, stt: { "whisper-cpp": "unavailable" } });
    expect(await speech.transcribeBuffer(AUDIO)).toBe("[Voice transcription unavailable - whisper-cpp not available]");
    expect(await speech.transcribeFile("/x/a.ogg")).toBe("[Voice transcription unavailable - whisper-cpp not available]");
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toContain("Grund-whisper-cpp");
  });

  test("Fehler: [Transcription failed], kein anderer Anbieter", async () => {
    const { speech, calls } = setup({ settings: { speech: { stt: "elevenlabs" } }, stt: { elevenlabs: "throw" } });
    expect(await speech.transcribeBuffer(AUDIO)).toBe(TRANSCRIPTION_TEXT.failed);
    expect(calls).toEqual(["elevenlabs:-"]);
  });

  test("leeres Ergebnis: [Transcription failed], kein anderer Anbieter", async () => {
    const { speech, calls } = setup({ settings: { speech: { stt: "whisper-cpp" } }, stt: { "whisper-cpp": "empty" } });
    expect(await speech.transcribeBuffer(AUDIO)).toBe(TRANSCRIPTION_TEXT.failed);
    expect(calls).toEqual(["whisper-cpp:-"]);
  });

  test("gewählter Anbieter läuft, auch wenn ein früherer verfügbar wäre", async () => {
    const { speech, calls } = setup({ settings: { speech: { stt: "gemini" } } });
    expect(await speech.transcribeBuffer(AUDIO)).toBe("Text von gemini");
    expect(calls).toEqual(["gemini:-"]);
  });

  test("Sprachcode geht an den Anbieter, auto nicht", async () => {
    const { speech, calls, setSettings } = setup({ settings: { speech: { language: "en" } } });
    await speech.transcribeBuffer(AUDIO);
    setSettings({ speech: { language: "auto" } });
    await speech.transcribeBuffer(AUDIO);
    expect(calls).toEqual(["whisper-cpp:en", "whisper-cpp:-"]);
  });
});

describe("Vorrang Datei vor .env vor Code", () => {
  test("Code-Standard auto", () => {
    const { speech } = setup();
    expect(speech.choice()).toEqual({
      stt: { value: "auto", source: "code" },
      tts: { value: "auto", source: "code" },
      language: { value: "auto", source: "code" },
    });
  });

  test("Umgebung gewinnt gegen den Code", () => {
    const { speech } = setup({ env: { SPEECH_STT: "gemini", SPEECH_TTS: " ElevenLabs " } });
    expect(speech.choice().stt).toEqual({ value: "gemini", source: "env" });
    expect(speech.choice().tts).toEqual({ value: "elevenlabs", source: "env" });
  });

  test("Konflikt: Datei elevenlabs, Umgebung gemini ergibt elevenlabs", async () => {
    const { speech, calls } = setup({ settings: { speech: { stt: "elevenlabs", tts: "gemini" } }, env: { SPEECH_STT: "gemini", SPEECH_TTS: "elevenlabs" } });
    expect(speech.choice().stt).toEqual({ value: "elevenlabs", source: "settings" });
    expect(speech.choice().tts).toEqual({ value: "gemini", source: "settings" });
    expect(await speech.transcribeBuffer(AUDIO)).toBe("Text von elevenlabs");
    expect(calls).toEqual(["elevenlabs:-"]);
  });

  test("gespeichertes auto überstimmt die Umgebung", () => {
    const { speech } = setup({ settings: { speech: { stt: "auto" } }, env: { SPEECH_STT: "gemini" } });
    expect(speech.choice().stt).toEqual({ value: "auto", source: "settings" });
  });

  test("ungültige Umgebung: auto mit einer Log-Zeile ohne Wert", () => {
    const { speech, logs } = setup({ env: { SPEECH_STT: "geheimwert-xyz", SPEECH_TTS: "browser" } });
    expect(speech.choice().stt).toEqual({ value: "auto", source: "code" });
    speech.choice();
    expect(logs.filter(l => l.includes("SPEECH_STT"))).toHaveLength(1);
    expect(logs.join("\n")).not.toContain("geheimwert");
    expect(speech.choice().tts).toEqual({ value: "browser", source: "env" });
  });

  test("Schema lehnt unbekannte IDs und Sprachen ab", () => {
    expect(settingsSchema.safeParse({ speech: { stt: "deepgram" } }).success).toBe(false);
    expect(settingsSchema.safeParse({ speech: { tts: "openai" } }).success).toBe(false);
    expect(settingsSchema.safeParse({ speech: { language: "deu" } }).success).toBe(false);
    expect(settingsSchema.safeParse({ speech: { language: "DE" } }).success).toBe(false);
    expect(settingsSchema.safeParse({ speech: { stt: "parakeet", tts: "pocket", language: "fr" } }).success).toBe(true);
    expect(settingsSchema.safeParse({ speech: { stt: "auto", tts: "auto", language: "auto" } }).success).toBe(true);
  });
});

describe("Sprechen für Telegram", () => {
  test("auto: Server-Kette qwen3-mlx, elevenlabs, gemini, am Ende null", async () => {
    const { speech, calls } = setup({ tts: { "qwen3-mlx": "throw", elevenlabs: "throw", gemini: "throw" } });
    expect(await speech.synthesizeServer("Hallo")).toBeNull();
    expect(calls).toEqual(["qwen3-mlx", "elevenlabs", "gemini"]);
  });

  test("auto: erster Erfolg gewinnt, nicht verfügbare übersprungen", async () => {
    const { speech, calls } = setup({ tts: { "qwen3-mlx": "unavailable" } });
    expect((await speech.synthesizeServer("Hallo"))?.toString()).toBe("audio-elevenlabs");
    expect(calls).toEqual(["elevenlabs"]);
  });

  test("browser gilt für Telegram als auto", async () => {
    const { speech, calls } = setup({ settings: { speech: { tts: "browser" } } });
    expect((await speech.synthesizeServer("Hallo"))?.toString()).toBe("audio-qwen3-mlx");
    expect(calls).toEqual(["qwen3-mlx"]);
  });

  test("fest gewählt: nur dieser, Fehler oder nicht verfügbar ergibt null", async () => {
    const a = setup({ settings: { speech: { tts: "gemini" } }, tts: { gemini: "throw" } });
    expect(await a.speech.synthesizeServer("x")).toBeNull();
    expect(a.calls).toEqual(["gemini"]);
    const b = setup({ settings: { speech: { tts: "pocket" } } });
    expect(await b.speech.synthesizeServer("x")).toBeNull();
    expect(b.calls).toEqual([]);
    expect(b.logs.join("\n")).toContain("Grund-pocket");
  });
});

describe("Synchrone Prüfungen", () => {
  test("isVoiceEnabled zählt nur Server-Anbieter", () => {
    const none = { "qwen3-mlx": "unavailable", elevenlabs: "unavailable", gemini: "unavailable" } as const;
    expect(setup({ tts: none }).speech.isVoiceEnabled()).toBe(false);
    expect(setup({ tts: none, settings: { speech: { tts: "browser" } } }).speech.isVoiceEnabled()).toBe(false);
    expect(setup({ settings: { speech: { tts: "browser" } } }).speech.isVoiceEnabled()).toBe(true);
    expect(setup({ settings: { speech: { tts: "pocket" } } }).speech.isVoiceEnabled()).toBe(false);
  });

  test("isTranscriptionEnabled und getTranscriptionProvider folgen der Wahl", () => {
    const a = setup();
    expect(a.speech.isTranscriptionEnabled()).toBe(true);
    expect(a.speech.getTranscriptionProvider()).toBe("whisper.cpp (local)");
    const b = setup({ stt: { "whisper-cpp": "unavailable" } });
    expect(b.speech.getTranscriptionProvider()).toBe("ElevenLabs");
    const c = setup({ settings: { speech: { stt: "whisper-cpp" } }, stt: { "whisper-cpp": "unavailable" } });
    expect(c.speech.isTranscriptionEnabled()).toBe(false);
    expect(c.speech.getTranscriptionProvider()).toBe("none");
    const d = setup({ stt: { parakeet: "ok" } });
    expect(d.speech.getTranscriptionProvider()).toBe("Parakeet (local)");
  });
});
