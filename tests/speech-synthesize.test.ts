/**
 * Issue #249, Checkbox 3: strenge Sprachausgabe für den Sprechmodus
 * (synthesizeSpeech) und die Kennzeichnung erzeugter WAV-Dateien im
 * LIST/INFO-Block. Anbieter, Subprozess und fetch sind Attrappen: kein
 * Netzwerk, kein Modell, kein ElevenLabs.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BRAND } from "../src/brand";
import { createSpeech } from "../src/lib/speech/chain";
import type { TtsId } from "../src/lib/speech/ids";
import { pcmToWav } from "../src/lib/speech/pcm";
import { createTtsProviders, type ProviderDeps } from "../src/lib/speech/providers";
import { SpeechError, type SpeechOpts, type TtsProvider } from "../src/lib/speech/types";
import { AI_GENERATED_NOTE, readWavInfo, tagWavAiGenerated } from "../src/lib/speech/wav";
import type { Settings } from "../src/lib/settings";
import { audioDurationSeconds } from "../src/web/audio-duration";
import { mp3FrameFixture, oggOpusFixture, wavFixture } from "./audio-fixture";

/** Jeder Block der Datei mit Kennung und Größe; wirft, wenn der Aufbau nicht aufgeht */
function wavChunks(wav: Buffer): { id: string; size: number }[] {
  expect(wav.toString("latin1", 0, 4)).toBe("RIFF");
  expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
  expect(wav.toString("latin1", 8, 12)).toBe("WAVE");
  const out: { id: string; size: number }[] = [];
  let pos = 12;
  while (pos < wav.length) {
    const size = wav.readUInt32LE(pos + 4);
    out.push({ id: wav.toString("latin1", pos, pos + 4), size });
    pos += 8 + size + (size & 1);
  }
  expect(pos).toBe(wav.length);
  return out;
}

describe("tagWavAiGenerated", () => {
  test("hängt einen gültigen LIST/INFO-Block mit Hinweis und Programm an, der Ton bleibt gleich", () => {
    const original = wavFixture();
    const tagged = tagWavAiGenerated(original);
    expect(AI_GENERATED_NOTE).toBe(`KI-generiert (${BRAND.name})`);
    expect(wavChunks(tagged).map(c => c.id)).toEqual(["fmt ", "data", "LIST"]);
    expect(readWavInfo(tagged)).toEqual({ ICMT: AI_GENERATED_NOTE, ISFT: BRAND.name });
    // Der Anfang samt Tondaten ist unverändert (bis auf die Gesamtgröße im Kopf)
    expect(tagged.subarray(8, original.length).equals(original.subarray(8))).toBe(true);
    expect(audioDurationSeconds(tagged, "audio/wav")).toBe(audioDurationSeconds(original, "audio/wav"));
    // Der Hinweis steht als Klartext in der Datei (maschinenlesbar)
    expect(tagged.includes(Buffer.from(`ICMT`))).toBe(true);
    expect(tagged.includes(Buffer.from(`${AI_GENERATED_NOTE}\0`, "latin1"))).toBe(true);
  });

  test("zweimal kennzeichnen ändert nichts mehr", () => {
    const once = tagWavAiGenerated(wavFixture());
    expect(tagWavAiGenerated(once).equals(once)).toBe(true);
    expect(wavChunks(once).filter(c => c.id === "LIST")).toHaveLength(1);
  });

  test("ungerade Länge der Tondaten: der neue Block beginnt auf gerader Position", () => {
    const odd = pcmToWav(Buffer.alloc(101, 7), 24_000);
    const tagged = tagWavAiGenerated(odd);
    const chunks = wavChunks(tagged);
    expect(chunks.map(c => c.id)).toEqual(["fmt ", "data", "LIST"]);
    expect(chunks[1].size).toBe(101);
    expect(readWavInfo(tagged).ICMT).toBe(AI_GENERATED_NOTE);
  });

  test("offene Größe des data-Blocks (Strom) wird auf die echte Länge gesetzt", () => {
    for (const open of [0xffffffff, 0]) {
      const stream = pcmToWav(Buffer.alloc(200, 1), 24_000);
      stream.writeUInt32LE(open, 40);
      const tagged = tagWavAiGenerated(stream);
      const chunks = wavChunks(tagged);
      expect(chunks.map(c => c.id)).toEqual(["fmt ", "data", "LIST"]);
      expect(chunks[1].size).toBe(200);
      expect(readWavInfo(tagged).ICMT).toBe(AI_GENERATED_NOTE);
    }
  });

  test("kein WAV: unverändert", () => {
    for (const other of [oggOpusFixture(), mp3FrameFixture(), Buffer.from("RIFFxxxxWEBP"), Buffer.alloc(0)]) {
      expect(tagWavAiGenerated(other)).toBe(other);
    }
    expect(readWavInfo(oggOpusFixture())).toEqual({});
  });
});

// --- synthesizeSpeech mit Anbieter-Attrappen -----------------------------------------

type Behavior = "wav" | "ogg" | "mp3" | "html" | "throw" | "unavailable";

function setup(settings: Settings, behaviors: Partial<Record<TtsId, Behavior>> = {}, env: Record<string, string | undefined> = {}) {
  const calls: { id: TtsId; text: string; opts: SpeechOpts }[] = [];
  const logs: string[] = [];
  const all: Record<TtsId, Behavior> = { browser: "throw", "qwen3-mlx": "ogg", elevenlabs: "mp3", gemini: "wav", pocket: "unavailable", ...behaviors };
  const tts: TtsProvider[] = (Object.keys(all) as TtsId[]).map(id => ({
    id,
    label: id,
    local: id !== "elevenlabs" && id !== "gemini",
    where: id === "browser" ? "browser" : "server",
    available: () => (all[id] === "unavailable" ? { ok: false, reason: "fehlt" } : { ok: true }),
    synthesize: async (text, opts) => {
      calls.push({ id, text, opts });
      const b = all[id];
      if (b === "throw") throw new SpeechError("http", 500);
      if (b === "wav") return { audio: wavFixture(), mime: "audio/x-wav" };
      if (b === "ogg") return { audio: oggOpusFixture(), mime: "audio/ogg; codecs=opus" };
      if (b === "html") return { audio: Buffer.from("<html>Fehler</html>"), mime: "text/html" };
      return { audio: mp3FrameFixture(), mime: "audio/mp3" };
    },
  }));
  const speech = createSpeech({ stt: [], tts, getSettings: () => settings, env: () => env, log: l => logs.push(l), readFile: async () => Buffer.from("x") });
  return { speech, calls, logs };
}

describe("synthesizeSpeech", () => {
  test("auto und browser: Grund browser, kein Server-Anbieter wird gerufen (anders als für Telegram)", async () => {
    for (const settings of [{}, { speech: { tts: "auto" } }, { speech: { tts: "browser" } }] as Settings[]) {
      const { speech, calls } = setup(settings);
      expect(await speech.synthesizeSpeech("Hallo")).toEqual({ ok: false, reason: "browser" });
      expect(calls).toEqual([]);
      // Telegram nutzt dieselbe Wahl weiter als Kette
      expect(await speech.synthesizeServer("Hallo")).not.toBeNull();
    }
  });

  test("SPEECH_TTS aus der Umgebung zählt wie die Einstellung", async () => {
    const { speech, calls } = setup({}, {}, { SPEECH_TTS: "elevenlabs" });
    const result = await speech.synthesizeSpeech("Hallo");
    expect(result.ok && result.provider).toBe("elevenlabs");
    expect(calls.map(c => c.id)).toEqual(["elevenlabs"]);
  });

  test("fest gewählter Anbieter: nur er, der MIME-Typ bleibt erhalten und wird vereinheitlicht", async () => {
    const mp3 = await setup({ speech: { tts: "elevenlabs" } }).speech.synthesizeSpeech("Hallo");
    expect(mp3).toMatchObject({ ok: true, mime: "audio/mpeg", provider: "elevenlabs" });
    const ogg = await setup({ speech: { tts: "qwen3-mlx" } }).speech.synthesizeSpeech("Hallo");
    expect(ogg).toMatchObject({ ok: true, mime: "audio/ogg", provider: "qwen3-mlx" });
    // Ogg und MP3 bleiben Byte für Byte, was der Anbieter lieferte
    expect(ogg.ok && ogg.audio.equals(oggOpusFixture())).toBe(true);
    expect(mp3.ok && mp3.audio.equals(mp3FrameFixture())).toBe(true);
  });

  test("WAV trägt den Hinweis KI-generiert im LIST/INFO-Block", async () => {
    const { speech } = setup({ speech: { tts: "gemini" } });
    const result = await speech.synthesizeSpeech("Hallo");
    expect(result).toMatchObject({ ok: true, mime: "audio/wav", provider: "gemini" });
    if (!result.ok) throw new Error("unerwartet");
    expect(readWavInfo(result.audio)).toEqual({ ICMT: AI_GENERATED_NOTE, ISFT: BRAND.name });
    expect(wavChunks(result.audio).map(c => c.id)).toEqual(["fmt ", "data", "LIST"]);
  });

  test("nicht verfügbar: unavailable, kein Ausweichen auf einen anderen Anbieter", async () => {
    const { speech, calls, logs } = setup({ speech: { tts: "pocket" } });
    expect(await speech.synthesizeSpeech("Hallo")).toEqual({ ok: false, reason: "unavailable" });
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toContain("Sprechen pocket nicht verfügbar");
  });

  test("Fehler des Anbieters und unerwarteter Typ: failed; der Text steht nie im Log", async () => {
    const thrown = setup({ speech: { tts: "elevenlabs" } }, { elevenlabs: "throw" });
    expect(await thrown.speech.synthesizeSpeech("GEHEIMER-TEXT")).toEqual({ ok: false, reason: "failed" });
    const html = setup({ speech: { tts: "gemini" } }, { gemini: "html" });
    expect(await html.speech.synthesizeSpeech("GEHEIMER-TEXT")).toEqual({ ok: false, reason: "failed" });
    expect([...thrown.logs, ...html.logs].join("\n")).not.toContain("GEHEIMER-TEXT");
  });

  test("Stimme und Sprache je Aufruf gehen an den Anbieter; eine ungültige Stimme wird vorher abgelehnt", async () => {
    const { speech, calls } = setup({ speech: { tts: "gemini", language: "de" } });
    expect((await speech.synthesizeSpeech("Hallo", { voice: "Kore_2" })).ok).toBe(true);
    expect(calls[0].opts).toEqual({ language: "de", voice: "Kore_2" });
    expect((await speech.synthesizeSpeech("Hallo")).ok).toBe(true);
    expect(calls[1].opts).toEqual({ language: "de" });
    for (const voice of ["", "-rf", "a b", "../x", "a".repeat(65), "ä"]) {
      expect(await speech.synthesizeSpeech("Hallo", { voice })).toEqual({ ok: false, reason: "voice" });
    }
    expect(calls).toHaveLength(2);
  });
});

// --- Echte Anbieter mit Attrappen für fetch und Subprozess: die Stimme kommt an -------

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function providerWorld() {
  const root = mkdtempSync(join(tmpdir(), "speech-synthesize-"));
  roots.push(root);
  const tmp = join(root, "tmp");
  mkdirSync(tmp, { recursive: true });
  const python = join(root, "python");
  writeFileSync(python, "p");
  const fetchCalls: { url: string; body: any }[] = [];
  const runCalls: string[][] = [];
  const deps: ProviderDeps = {
    env: () => ({ LOCAL_TTS_PYTHON: python, ELEVENLABS_API_KEY: "test-schluessel", ELEVENLABS_VOICE_ID: "standard-stimme", GEMINI_API_KEY: "test-schluessel", HOME: root }),
    run: async (cmd, opts) => {
      runCalls.push(cmd);
      if (cmd[0] === python) {
        const prefix = cmd[cmd.indexOf("--file_prefix") + 1];
        writeFileSync(join(opts.cwd!, `${prefix}_000.wav`), pcmToWav(Buffer.alloc(2000, 1), 24_000));
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
      // ffmpeg fehlt: es bleibt beim WAV
      throw new Error("ENOENT");
    },
    fetch: async (url, init) => {
      fetchCalls.push({ url, body: JSON.parse(String(init?.body)) });
      if (url.includes("text-to-speech")) return new Response(mp3FrameFixture(), { status: 200 });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(100, 1).toString("base64") } }] } }] }));
    },
    exists: existsSync,
    which: () => null,
    readFile: p => readFile(p),
    writeFile: (p, d) => writeFile(p, d),
    unlink: p => unlink(p),
    mkdir: async p => {
      await mkdir(p, { recursive: true });
    },
    cwd: () => root,
    tmpDir: tmp,
    unique: () => "u1",
  };
  const speechFor = (tts: TtsId) =>
    createSpeech({ stt: [], tts: createTtsProviders(deps), getSettings: () => ({ speech: { tts } }), env: () => ({}), log: () => {}, readFile: p => readFile(p) });
  return { speechFor, fetchCalls, runCalls };
}

describe("Stimme je Aufruf bei den echten Anbietern", () => {
  test("ElevenLabs: Stimme in der Adresse, ohne Angabe die eingestellte", async () => {
    const w = providerWorld();
    expect((await w.speechFor("elevenlabs").synthesizeSpeech("Hallo", { voice: "andereStimme1" })).ok).toBe(true);
    expect((await w.speechFor("elevenlabs").synthesizeSpeech("Hallo")).ok).toBe(true);
    expect(w.fetchCalls.map(c => c.url)).toEqual([
      "https://api.elevenlabs.io/v1/text-to-speech/andereStimme1",
      "https://api.elevenlabs.io/v1/text-to-speech/standard-stimme",
    ]);
  });

  test("Gemini: voiceName im Auftrag, das WAV ist gekennzeichnet", async () => {
    const w = providerWorld();
    const result = await w.speechFor("gemini").synthesizeSpeech("Hallo", { voice: "Puck" });
    expect(w.fetchCalls[0].body.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe("Puck");
    expect(result.ok && result.mime).toBe("audio/wav");
    expect(result.ok && readWavInfo(result.audio).ICMT).toBe(AI_GENERATED_NOTE);
  });

  test("Qwen3-TTS: --voice als eigenes Argument, WAV ohne ffmpeg gekennzeichnet", async () => {
    const w = providerWorld();
    const result = await w.speechFor("qwen3-mlx").synthesizeSpeech("Hallo", { voice: "ryan" });
    const cmd = w.runCalls[0];
    expect(cmd[cmd.indexOf("--voice") + 1]).toBe("ryan");
    expect(result.ok && result.mime).toBe("audio/wav");
    expect(result.ok && readWavInfo(result.audio).ICMT).toBe(AI_GENERATED_NOTE);
  });
});
