/**
 * Issue #307 (U1-7): Verhalten der Sprach-Reste festgehalten, bevor sie neu
 * geschrieben werden. WAV-Kopf aus pcm.ts bei 16 und 24 kHz, die MIME-Wahl
 * des Dateiwegs (chain.ts) und beide Gemini-Anfragen (Hören und Sprechen)
 * samt Fehlerpfaden. fetch ist eine Attrappe: kein Netzwerk, kein Schlüssel.
 */

import { describe, expect, test } from "bun:test";
import { mimeForFile } from "../src/lib/speech/chain";
import { pcmToWav, wavToPcm } from "../src/lib/speech/pcm";
import { createSttProviders, createTtsProviders, type ProviderDeps } from "../src/lib/speech/providers";
import { SpeechError, type SttProvider, type TtsProvider } from "../src/lib/speech/types";

describe("pcmToWav", () => {
  for (const rate of [16_000, 24_000]) {
    test(`${rate} Hz: 44-Byte-Kopf für PCM16 mono, Nutzdaten unverändert dahinter`, () => {
      const pcm = Buffer.from([1, 2, 3, 4, 5, 6, 250, 251]);
      const wav = pcmToWav(pcm, rate);
      expect(wav.length).toBe(44 + pcm.length);
      expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
      expect(wav.readUInt32LE(4)).toBe(36 + pcm.length);
      expect(wav.toString("latin1", 8, 16)).toBe("WAVEfmt ");
      expect(wav.readUInt32LE(16)).toBe(16);
      expect(wav.readUInt16LE(20)).toBe(1);
      expect(wav.readUInt16LE(22)).toBe(1);
      expect(wav.readUInt32LE(24)).toBe(rate);
      expect(wav.readUInt32LE(28)).toBe(rate * 2);
      expect(wav.readUInt16LE(32)).toBe(2);
      expect(wav.readUInt16LE(34)).toBe(16);
      expect(wav.toString("latin1", 36, 40)).toBe("data");
      expect(wav.readUInt32LE(40)).toBe(pcm.length);
      expect(wav.subarray(44).equals(pcm)).toBe(true);
      expect(wavToPcm(wav)).toEqual({ sampleRate: rate, pcm });
    });
  }

  test("leere und ungerade Nutzdaten: Längen im Kopf stimmen", () => {
    expect(pcmToWav(Buffer.alloc(0), 24_000).readUInt32LE(40)).toBe(0);
    expect(pcmToWav(Buffer.alloc(0), 24_000).readUInt32LE(4)).toBe(36);
    const odd = pcmToWav(Buffer.alloc(101, 7), 16_000);
    expect(odd.readUInt32LE(40)).toBe(101);
    expect(odd.length).toBe(145);
  });

  test("Uint8Array statt Buffer geht genauso", () => {
    const bytes = new Uint8Array([9, 8, 7, 6]);
    expect(pcmToWav(bytes, 16_000).equals(pcmToWav(Buffer.from(bytes), 16_000))).toBe(true);
  });
});

describe("mimeForFile", () => {
  test("die fünf bekannten Endungen", () => {
    expect(mimeForFile("/tmp/a.ogg")).toBe("audio/ogg");
    expect(mimeForFile("/tmp/a.mp3")).toBe("audio/mpeg");
    expect(mimeForFile("/tmp/a.wav")).toBe("audio/wav");
    expect(mimeForFile("/tmp/a.m4a")).toBe("audio/mp4");
    expect(mimeForFile("/tmp/a.webm")).toBe("audio/webm");
  });

  test("Großschreibung zählt nicht", () => {
    expect(mimeForFile("/tmp/A.MP3")).toBe("audio/mpeg");
    expect(mimeForFile("/tmp/b.WebM")).toBe("audio/webm");
    expect(mimeForFile("C.M4A")).toBe("audio/mp4");
  });

  test("unbekannte, fehlende oder leere Endung: audio/ogg", () => {
    expect(mimeForFile("/tmp/a.flac")).toBe("audio/ogg");
    expect(mimeForFile("/tmp/a.oga")).toBe("audio/ogg");
    expect(mimeForFile("datei")).toBe("audio/ogg");
    expect(mimeForFile("datei.")).toBe("audio/ogg");
    expect(mimeForFile("")).toBe("audio/ogg");
  });

  test("nur die letzte Endung zählt, auch mit Punkten im Pfad", () => {
    expect(mimeForFile("/tmp/ordner.mp3/sprache.wav")).toBe("audio/wav");
    expect(mimeForFile("/tmp/a.wav.mp3")).toBe("audio/mpeg");
    expect(mimeForFile("/tmp/ordner.wav/datei")).toBe("audio/ogg");
  });
});

interface Sent {
  url: string;
  init?: RequestInit;
}

function deps(reply: (url: string) => Response, env: Record<string, string | undefined> = {}) {
  const sent: Sent[] = [];
  const unused = () => {
    throw new Error("nicht erwartet");
  };
  const d: ProviderDeps = {
    env: () => ({ GEMINI_API_KEY: "test-schluessel", HOME: "/nirgends", ...env }),
    run: unused,
    fetch: async (url, init) => {
      sent.push({ url, init });
      return reply(url);
    },
    exists: () => false,
    which: () => null,
    readFile: unused,
    writeFile: unused,
    unlink: unused,
    mkdir: unused,
    cwd: () => "/nirgends",
    tmpDir: "/nirgends",
    unique: () => "x",
  };
  return { d, sent };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function geminiStt(d: ProviderDeps): SttProvider {
  return createSttProviders(d).find(p => p.id === "gemini")!;
}

function geminiTts(d: ProviderDeps): TtsProvider {
  return createTtsProviders(d).find(p => p.id === "gemini")!;
}

async function kindOf(p: Promise<unknown>): Promise<{ kind: string; code?: number }> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SpeechError);
    const err = e as SpeechError;
    return err.code === undefined ? { kind: err.kind } : { kind: err.kind, code: err.code };
  }
  throw new Error("kein Fehler geworfen");
}

describe("Gemini hören", () => {
  test("Anfrage: Modell, Schlüssel in der Adresse, Auftrag und Ton als base64", async () => {
    const { d, sent } = deps(() => json({ candidates: [{ content: { parts: [{ text: " Hallo Welt " }] } }] }));
    const audio = Buffer.from("ton-bytes");
    const text = await geminiStt(d).transcribe(audio, "audio/ogg", {});
    // Text kommt so zurück, wie Gemini ihn liefert (die Kette trimmt selbst)
    expect(text).toBe(" Hallo Welt ");
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=test-schluessel");
    expect(sent[0].init?.method).toBe("POST");
    expect(sent[0].init?.headers).toEqual({ "Content-Type": "application/json" });
    expect("signal" in (sent[0].init ?? {})).toBe(false);
    expect(JSON.parse(String(sent[0].init?.body))).toEqual({
      contents: [
        {
          parts: [
            { text: "Transcribe this audio message accurately. Only output the transcription, nothing else." },
            { inline_data: { mime_type: "audio/ogg", data: audio.toString("base64") } },
          ],
        },
      ],
    });
  });

  test("Abbruchsignal geht an fetch, MIME wird durchgereicht", async () => {
    const { d, sent } = deps(() => json({ candidates: [{ content: { parts: [{ text: "ok" }] } }] }));
    const controller = new AbortController();
    await geminiStt(d).transcribe(Buffer.from("a"), "audio/webm", { signal: controller.signal });
    expect(sent[0].init?.signal).toBe(controller.signal);
    expect(JSON.parse(String(sent[0].init?.body)).contents[0].parts[1].inline_data.mime_type).toBe("audio/webm");
  });

  test("verfügbar nur mit GEMINI_API_KEY", () => {
    expect(geminiStt(deps(() => json({})).d).available()).toEqual({ ok: true });
    expect(geminiStt(deps(() => json({}), { GEMINI_API_KEY: undefined }).d).available()).toEqual({ ok: false, reason: "GEMINI_API_KEY fehlt" });
  });

  test("Fehlerpfade: HTTP-Status, kaputtes JSON, kein oder leerer Text", async () => {
    const stt = (r: Response) => geminiStt(deps(() => r).d).transcribe(Buffer.from("a"), "audio/ogg", {});
    expect(await kindOf(stt(new Response("nein", { status: 503 })))).toEqual({ kind: "http", code: 503 });
    expect(await kindOf(stt(new Response("kein json", { status: 200 })))).toEqual({ kind: "format" });
    expect(await kindOf(stt(json({ candidates: [] })))).toEqual({ kind: "empty" });
    expect(await kindOf(stt(json({})))).toEqual({ kind: "empty" });
    expect(await kindOf(stt(json({ candidates: [{ content: { parts: [{ text: "  \n" }] } }] })))).toEqual({ kind: "empty" });
    expect(await kindOf(stt(json({ candidates: [{ content: { parts: [{ text: 5 }] } }] })))).toEqual({ kind: "empty" });
  });
});

describe("Gemini sprechen", () => {
  const pcm = Buffer.from([10, 0, 20, 0, 30, 0]);
  const ok = () => json({ candidates: [{ content: { parts: [{ inlineData: { data: pcm.toString("base64") } }] } }] });

  test("Anfrage: TTS-Modell, Text, nur Ton, Standardstimme Kore", async () => {
    const { d, sent } = deps(ok);
    const out = await geminiTts(d).synthesize("Guten Morgen", {});
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent?key=test-schluessel");
    expect(sent[0].init?.method).toBe("POST");
    expect(sent[0].init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(sent[0].init?.body))).toEqual({
      contents: [{ parts: [{ text: "Guten Morgen" }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "Kore" } } },
      },
    });
    // Roh-PCM mit 24 kHz wird zur WAV-Datei
    expect(out.mime).toBe("audio/wav");
    expect(out.audio.equals(pcmToWav(pcm, 24_000))).toBe(true);
  });

  test("Stimme: GEMINI_TTS_VOICE, sonst die Wahl im Aufruf vorrangig", async () => {
    const env = deps(ok, { GEMINI_TTS_VOICE: "Puck" });
    await geminiTts(env.d).synthesize("a", {});
    expect(JSON.parse(String(env.sent[0].init?.body)).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Puck");
    const own = deps(ok, { GEMINI_TTS_VOICE: "Puck" });
    await geminiTts(own.d).synthesize("a", { voice: "Charon" });
    expect(JSON.parse(String(own.sent[0].init?.body)).generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Charon");
  });

  test("langer Text wird nach 4500 Zeichen mit ... gekürzt", async () => {
    const { d, sent } = deps(ok);
    await geminiTts(d).synthesize("x".repeat(4500), {});
    expect(JSON.parse(String(sent[0].init?.body)).contents[0].parts[0].text).toBe("x".repeat(4500));
    await geminiTts(d).synthesize("y".repeat(4501), {});
    expect(JSON.parse(String(sent[1].init?.body)).contents[0].parts[0].text).toBe("y".repeat(4500) + "...");
  });

  test("kein Abbruchsignal an fetch (wie bisher)", async () => {
    const { d, sent } = deps(ok);
    await geminiTts(d).synthesize("a", { signal: new AbortController().signal });
    expect("signal" in (sent[0].init ?? {})).toBe(false);
  });

  test("verfügbar nur mit GEMINI_API_KEY, spricht auf dem Server", () => {
    const t = geminiTts(deps(ok).d);
    expect(t.available()).toEqual({ ok: true });
    expect(t.where).toBe("server");
    expect(t.local).toBe(false);
    expect(t.label).toBe("Gemini");
    expect(geminiTts(deps(ok, { GEMINI_API_KEY: undefined }).d).available()).toEqual({ ok: false, reason: "GEMINI_API_KEY fehlt" });
  });

  test("Fehlerpfade: HTTP-Status, kaputtes JSON, fehlende oder leere Tondaten", async () => {
    const tts = (r: Response) => geminiTts(deps(() => r).d).synthesize("a", {});
    expect(await kindOf(tts(new Response("nein", { status: 429 })))).toEqual({ kind: "http", code: 429 });
    expect(await kindOf(tts(new Response("kein json", { status: 200 })))).toEqual({ kind: "format" });
    expect(await kindOf(tts(json({ candidates: [] })))).toEqual({ kind: "format" });
    expect(await kindOf(tts(json({ candidates: [{ content: { parts: [{ inlineData: { data: "" } }] } }] })))).toEqual({ kind: "format" });
    expect(await kindOf(tts(json({ candidates: [{ content: { parts: [{ inlineData: { data: 7 } }] } }] })))).toEqual({ kind: "format" });
  });
});
