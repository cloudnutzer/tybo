/**
 * Umzug der Sprach-Anbieter (Issue #248): whisper.cpp, ElevenLabs, Gemini
 * und Qwen3-TTS hinter der Sprach-Schnittstelle, mit Attrappen für
 * Subprozesse (RunFn) und fetch. Kein Netzwerk, kein Subprozess, kein
 * Modell; nur Dateien in einem temporären Verzeichnis.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpeech, TRANSCRIPTION_TEXT } from "../src/lib/speech/chain";
import { createSttProviders, createTtsProviders, extForMime, type ProviderDeps } from "../src/lib/speech/providers";
import type { RunResult } from "../src/lib/speech/process";
import { SpeechError } from "../src/lib/speech/types";
import { isVoiceEnabled, setSpeechForTests, textToSpeech } from "../src/lib/speech";
import { getSettings, setSettingsPath, type Settings } from "../src/lib/settings";
import { transcribeAudio, transcribeAudioBuffer, isTranscriptionEnabled, getTranscriptionProvider } from "../src/lib/transcribe";

const MARKERS = ["TRANSKRIPT-", "STDERR-MARKER", "ANTWORT-MARKER", "EINGABE-MARKER", "KEY-MARKER"];

type Mode = "ok" | "fail" | "empty" | "blank" | "timeout" | "missing" | "off";

interface WorldOpts {
  whisper?: Mode;
  elevenStt?: Mode;
  geminiStt?: Mode;
  qwen?: Mode;
  ffmpeg?: Mode;
  elevenTts?: Mode;
  geminiTts?: Mode;
  /** Programme im PATH (Standard: whisper-cli) */
  programs?: string[];
  settings?: Settings;
  env?: Record<string, string | undefined>;
}

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function world(o: WorldOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), "speech-"));
  roots.push(root);
  const cwd = join(root, "cwd");
  const tmp = join(root, "tmp");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const model = join(root, "ggml.bin");
  const python = join(root, "python");
  if (o.whisper !== "off") writeFileSync(model, "m");
  if (o.qwen !== "off") writeFileSync(python, "p");

  const env: Record<string, string | undefined> = {
    WHISPER_MODEL_PATH: model,
    LOCAL_TTS_PYTHON: python,
    ELEVENLABS_API_KEY: o.elevenStt === "off" && o.elevenTts === "off" ? undefined : "KEY-MARKER-11",
    ELEVENLABS_VOICE_ID: "voice1",
    GEMINI_API_KEY: o.geminiStt === "off" && o.geminiTts === "off" ? undefined : "KEY-MARKER-GEM",
    HOME: root,
    ...o.env,
  };
  const programs = new Set(o.programs ?? ["whisper-cli"]);
  const runCalls: string[][] = [];
  // Reihenfolge aller Aufrufe über beide Attrappen
  const calls: string[] = [];
  const fetchCalls: { url: string; init?: RequestInit }[] = [];
  const logs: string[] = [];

  const result = (r: Partial<RunResult>): RunResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, ...r });

  const run: ProviderDeps["run"] = async (cmd, opts) => {
    runCalls.push(cmd);
    calls.push(cmd[0] === "whisper-cli" ? "whisper" : cmd[0] === "ffmpeg" ? "ffmpeg" : "qwen");
    if (cmd[0] === "whisper-cli") {
      const m = o.whisper ?? "ok";
      if (m === "fail") return result({ exitCode: 1, stderr: "STDERR-MARKER whisper" });
      if (m === "timeout") return result({ exitCode: null, timedOut: true });
      if (m === "empty") return result({ stdout: "" });
      if (m === "blank") return result({ stdout: "   \n\t " });
      return result({ stdout: " TRANSKRIPT-WHISPER \n" });
    }
    if (cmd[0] === python) {
      const m = o.qwen ?? "ok";
      if (m === "fail") return result({ exitCode: 1, stderr: "STDERR-MARKER qwen" });
      const prefix = cmd[cmd.indexOf("--file_prefix") + 1];
      writeFileSync(join(opts.cwd!, `${prefix}_000.wav`), Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(2000)]));
      return result({});
    }
    if (cmd[0] === "ffmpeg") {
      const m = o.ffmpeg ?? "ok";
      if (m === "missing") throw new Error("ENOENT ffmpeg EINGABE-MARKER");
      if (m === "fail") return result({ exitCode: 1, stderr: "STDERR-MARKER ffmpeg" });
      writeFileSync(cmd[cmd.length - 1], Buffer.concat([Buffer.from("OggS"), Buffer.alloc(2000)]));
      return result({});
    }
    throw new Error("unerwarteter Befehl");
  };

  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchFake: ProviderDeps["fetch"] = async (url, init) => {
    fetchCalls.push({ url, init });
    calls.push(
      url.includes("speech-to-text") ? "eleven" : url.includes("gemini-2.0-flash") ? "gemini" : url.includes("text-to-speech") ? "eleven-tts" : "gemini-tts"
    );
    if (url.includes("speech-to-text")) {
      const m = o.elevenStt ?? "ok";
      if (m === "fail") return new Response("ANTWORT-MARKER eleven", { status: 500 });
      if (m === "empty") return json({ text: "" });
      if (m === "blank") return json({ text: "  " });
      return json({ text: "TRANSKRIPT-ELEVEN" });
    }
    if (url.includes("gemini-2.0-flash")) {
      const m = o.geminiStt ?? "ok";
      if (m === "fail") return new Response("ANTWORT-MARKER gemini", { status: 503 });
      if (m === "empty") return json({ candidates: [] });
      return json({ candidates: [{ content: { parts: [{ text: "TRANSKRIPT-GEMINI" }] } }] });
    }
    if (url.includes("text-to-speech")) {
      const m = o.elevenTts ?? "ok";
      if (m === "fail") return new Response("ANTWORT-MARKER eleven-tts", { status: 401 });
      return new Response(Buffer.from("ID3-mp3-daten"), { status: 200 });
    }
    if (url.includes("preview-tts")) {
      const m = o.geminiTts ?? "ok";
      if (m === "fail") return new Response("ANTWORT-MARKER gemini-tts", { status: 500 });
      return json({ candidates: [{ content: { parts: [{ inlineData: { data: Buffer.alloc(100, 1).toString("base64") } }] } }] });
    }
    throw new Error("unerwartete URL");
  };

  let seq = 0;
  const deps: ProviderDeps = {
    env: () => env,
    run,
    fetch: fetchFake,
    exists: existsSync,
    which: cmd => (programs.has(cmd) ? `/bin/${cmd}` : null),
    readFile: p => readFile(p),
    writeFile: (p, d) => writeFile(p, d),
    unlink: p => unlink(p),
    mkdir: async p => {
      await mkdir(p, { recursive: true });
    },
    cwd: () => cwd,
    tmpDir: tmp,
    unique: () => `u${++seq}`,
  };
  let settings: Settings = o.settings ?? {};
  const stt = createSttProviders(deps);
  const speech = createSpeech({
    stt,
    tts: createTtsProviders(deps),
    getSettings: () => settings,
    env: () => env,
    log: l => logs.push(l),
    readFile: p => readFile(p),
  });
  const audioFile = (name: string) => {
    const p = join(root, name);
    writeFileSync(p, "audio-bytes");
    return p;
  };
  return {
    speech,
    stt,
    calls,
    runCalls,
    fetchCalls,
    logs,
    cwd,
    tmp,
    env,
    audioFile,
    setSettings: (s: Settings) => (settings = s),
  };
}

function expectNoMarkers(logs: string[]) {
  const all = logs.join("\n");
  for (const m of MARKERS) expect(all).not.toContain(m);
}

describe("Ohne speech-Einstellung: Reihenfolge wie vor dem Umbau", () => {
  for (const access of ["Datei", "Puffer"] as const) {
    const go = (w: ReturnType<typeof world>) =>
      access === "Datei" ? w.speech.transcribeFile(w.audioFile("a.ogg")) : w.speech.transcribeBuffer(Buffer.from("x"), "audio/ogg");

    test(`${access}: whisper.cpp zuerst`, async () => {
      const w = world();
      expect(await go(w)).toBe("TRANSKRIPT-WHISPER");
      expect(w.calls).toEqual(["whisper"]);
    });

    test(`${access}: nach whisper-Fehler ElevenLabs`, async () => {
      const w = world({ whisper: "fail" });
      expect(await go(w)).toBe("TRANSKRIPT-ELEVEN");
      expect(w.calls).toEqual(["whisper", "eleven"]);
    });

    for (const whisper of ["empty", "blank"] as const) {
      test(`${access}: nach leerem whisper-Ergebnis (${whisper}) ElevenLabs`, async () => {
        const w = world({ whisper });
        expect(await go(w)).toBe("TRANSKRIPT-ELEVEN");
        expect(w.calls).toEqual(["whisper", "eleven"]);
        expect(w.logs.join("\n")).toContain("Hören whisper-cpp: Fehler (leeres Ergebnis)");
      });
    }

    test(`${access}: whisper-Zeitlimit, ElevenLabs-Fehler, dann Gemini`, async () => {
      const w = world({ whisper: "timeout", elevenStt: "fail" });
      expect(await go(w)).toBe("TRANSKRIPT-GEMINI");
      expect(w.calls).toEqual(["whisper", "eleven", "gemini"]);
      expect(w.logs.join("\n")).toContain("Zeitlimit");
      expect(w.logs.join("\n")).toContain("HTTP 500");
    });

    test(`${access}: ohne Modelldatei direkt ElevenLabs`, async () => {
      const w = world({ whisper: "off" });
      expect(await go(w)).toBe("TRANSKRIPT-ELEVEN");
      expect(w.calls).toEqual(["eleven"]);
    });
  }

  test("Abweichung: ElevenLabs mit leerem text schaltet zu Gemini weiter", async () => {
    const w = world({ whisper: "off", elevenStt: "empty" });
    expect(await w.speech.transcribeBuffer(Buffer.from("x"))).toBe("TRANSKRIPT-GEMINI");
    expect(w.calls).toEqual(["eleven", "gemini"]);
  });

  test("Abweichung: Leerzeichen gelten als leer", async () => {
    const w = world({ whisper: "off", elevenStt: "blank", geminiStt: "off", geminiTts: "off" });
    expect(await w.speech.transcribeBuffer(Buffer.from("x"))).toBe(TRANSCRIPTION_TEXT.failed);
  });

  test("Abweichung: whisper und ElevenLabs gescheitert ohne Gemini ergibt [Transcription failed]", async () => {
    const w = world({ whisper: "fail", elevenStt: "fail", geminiStt: "off", geminiTts: "off" });
    expect(await w.speech.transcribeFile(w.audioFile("a.ogg"))).toBe("[Transcription failed]");
    expect(await w.speech.transcribeBuffer(Buffer.from("x"))).toBe("[Transcription failed]");
  });

  test("Abweichung: leere Gemini-Antwort ergibt [Transcription failed]", async () => {
    const w = world({ whisper: "off", elevenStt: "off", elevenTts: "off", geminiStt: "empty" });
    expect(await w.speech.transcribeBuffer(Buffer.from("x"))).toBe("[Transcription failed]");
  });

  test("Abweichung: whisper.cpp braucht auch das Programm", async () => {
    const w = world({ programs: [], elevenStt: "off", elevenTts: "off", geminiStt: "off", geminiTts: "off" });
    expect(w.speech.isTranscriptionEnabled()).toBe(false);
    expect(w.speech.getTranscriptionProvider()).toBe("none");
    expect(await w.speech.transcribeBuffer(Buffer.from("x"))).toBe(TRANSCRIPTION_TEXT.noneBuffer);
    expect(w.calls).toEqual([]);
    expect(w.speech.options().stt.find(s => s.id === "whisper-cpp")).toEqual({
      id: "whisper-cpp", label: "whisper.cpp", local: true, available: false, reason: "Programm whisper-cli nicht gefunden",
    });
  });

  test("textToSpeech-Kette: Qwen3 → ElevenLabs → Gemini, am Ende null", async () => {
    const w = world({ qwen: "fail", elevenTts: "fail", geminiTts: "fail" });
    expect(await w.speech.synthesizeServer("EINGABE-MARKER Hallo")).toBeNull();
    expect(w.calls).toEqual(["qwen", "eleven-tts", "gemini-tts"]);
    expectNoMarkers(w.logs);
  });

  test("textToSpeech: Qwen3 liefert Ogg/Opus, ohne ffmpeg WAV", async () => {
    const a = world();
    const ogg = await a.speech.synthesizeServer("Hallo");
    expect(ogg!.subarray(0, 4).toString()).toBe("OggS");
    expect(a.calls).toEqual(["qwen", "ffmpeg"]);
    expect(readdirSync(a.tmp)).toEqual([]);
    const b = world({ ffmpeg: "missing" });
    expect((await b.speech.synthesizeServer("Hallo"))!.subarray(0, 4).toString()).toBe("RIFF");
    const c = world({ ffmpeg: "fail" });
    expect((await c.speech.synthesizeServer("Hallo"))!.subarray(0, 4).toString()).toBe("RIFF");
    expect(readdirSync(c.tmp)).toEqual([]);
  });

  test("textToSpeech: ElevenLabs MP3, Gemini PCM als WAV", async () => {
    const a = world({ qwen: "off" });
    expect((await a.speech.synthesizeServer("Hallo"))!.toString()).toBe("ID3-mp3-daten");
    const b = world({ qwen: "off", elevenTts: "fail" });
    const wav = (await b.speech.synthesizeServer("Hallo"))!;
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.length).toBe(144);
  });

  test("textToSpeech kürzt auf 4500 Zeichen", async () => {
    const w = world({ qwen: "off" });
    await w.speech.synthesizeServer("a".repeat(5000));
    const body = JSON.parse(String(w.fetchCalls[0].init!.body));
    expect(body.text).toBe("a".repeat(4500) + "...");
  });
});

describe("Anbietervertrag: leerer Text wirft schon beim Anbieter", () => {
  const provider = (w: ReturnType<typeof world>, id: string) => w.stt.find(p => p.id === id)!;

  test("whisper.cpp: leeres und nur aus Leerraum bestehendes stdout wirft SpeechError empty, Temp-Datei gelöscht", async () => {
    for (const whisper of ["empty", "blank"] as const) {
      const w = world({ whisper });
      const err = await provider(w, "whisper-cpp").transcribe(Buffer.from("x"), "audio/ogg", {}).catch(e => e);
      expect(err).toBeInstanceOf(SpeechError);
      expect(err.kind).toBe("empty");
      expect(w.calls).toEqual(["whisper"]);
      expect(readdirSync(join(w.cwd, "uploads"))).toEqual([]);
    }
  });

  test("whisper.cpp: Text kommt ohne Leerraum am Rand zurück", async () => {
    const w = world();
    expect(await provider(w, "whisper-cpp").transcribe(Buffer.from("x"), "audio/ogg", {})).toBe("TRANSKRIPT-WHISPER");
  });

  test("ElevenLabs und Gemini: leerer Text wirft SpeechError empty", async () => {
    for (const [id, o] of [["elevenlabs", { elevenStt: "empty" }], ["elevenlabs", { elevenStt: "blank" }], ["gemini", { geminiStt: "empty" }]] as const) {
      const err = await provider(world(o), id).transcribe(Buffer.from("x"), "audio/ogg", {}).catch(e => e);
      expect(err).toBeInstanceOf(SpeechError);
      expect(err.kind).toBe("empty");
    }
  });
});

describe("Feste Wahl", () => {
  test("speech.stt elevenlabs nutzt ElevenLabs, obwohl whisper.cpp verfügbar wäre", async () => {
    const w = world({ settings: { speech: { stt: "elevenlabs" } } });
    expect(await w.speech.transcribeFile(w.audioFile("a.ogg"))).toBe("TRANSKRIPT-ELEVEN");
    expect(await w.speech.transcribeBuffer(Buffer.from("x"))).toBe("TRANSKRIPT-ELEVEN");
    expect(w.calls).toEqual(["eleven", "eleven"]);
  });

  test("speech.stt elevenlabs mit Fehler ruft keinen anderen Anbieter", async () => {
    const w = world({ settings: { speech: { stt: "elevenlabs" } }, elevenStt: "fail" });
    expect(await w.speech.transcribeBuffer(Buffer.from("x"))).toBe("[Transcription failed]");
    expect(w.calls).toEqual(["eleven"]);
  });

  test("speech.tts browser: textToSpeech nutzt die Server-Kette", async () => {
    const w = world({ settings: { speech: { tts: "browser" } }, qwen: "off" });
    expect((await w.speech.synthesizeServer("Hallo"))!.toString()).toBe("ID3-mp3-daten");
    expect(w.speech.isVoiceEnabled()).toBe(true);
  });

  test("speech.tts browser ohne Server-Anbieter: isVoiceEnabled false", () => {
    const w = world({ settings: { speech: { tts: "browser" } }, qwen: "off", elevenStt: "off", elevenTts: "off", geminiStt: "off", geminiTts: "off" });
    expect(w.speech.isVoiceEnabled()).toBe(false);
  });

  test("speech.tts gemini nutzt nur Gemini", async () => {
    const w = world({ settings: { speech: { tts: "gemini" } } });
    expect((await w.speech.synthesizeServer("Hallo"))!.subarray(0, 4).toString()).toBe("RIFF");
    expect(w.calls).toEqual(["gemini-tts"]);
  });
});

describe("Sprache, MIME und Temp-Dateien", () => {
  test("Sprachcode geht an whisper.cpp und, als Name, an Qwen3; auto wie bisher", async () => {
    const w = world({ settings: { speech: { language: "en" } } });
    await w.speech.transcribeBuffer(Buffer.from("x"));
    await w.speech.synthesizeServer("Hallo");
    const whisperCmd = w.runCalls.find(c => c[0] === "whisper-cli")!;
    const qwenCmd = w.runCalls.find(c => c.includes("--lang_code"))!;
    expect(whisperCmd[whisperCmd.indexOf("--language") + 1]).toBe("en");
    // mlx-audio kennt nur ausgeschriebene Namen (Issue #252)
    expect(qwenCmd[qwenCmd.indexOf("--lang_code") + 1]).toBe("english");

    const a = world({ env: { LOCAL_TTS_LANG: "fr" } });
    await a.speech.transcribeBuffer(Buffer.from("x"));
    await a.speech.synthesizeServer("Hallo");
    const w2 = a.runCalls.find(c => c[0] === "whisper-cli")!;
    const q2 = a.runCalls.find(c => c.includes("--lang_code"))!;
    expect(w2[w2.indexOf("--language") + 1]).toBe("auto");
    expect(q2[q2.indexOf("--lang_code") + 1]).toBe("french");
    const b = world();
    await b.speech.synthesizeServer("Hallo");
    const q3 = b.runCalls.find(c => c.includes("--lang_code"))!;
    expect(q3[q3.indexOf("--lang_code") + 1]).toBe("german");
  });

  test("Dateiweg: MIME aus der Endung an ElevenLabs und Gemini", async () => {
    const w = world({ whisper: "off", elevenStt: "fail" });
    await w.speech.transcribeFile(w.audioFile("a.m4a"));
    const form = w.fetchCalls[0].init!.body as FormData;
    const file = form.get("file") as File;
    expect(file.type).toBe("audio/mp4");
    expect(file.name).toBe("audio.m4a");
    const gem = JSON.parse(String(w.fetchCalls[1].init!.body));
    expect(gem.contents[0].parts[1].inline_data.mime_type).toBe("audio/mp4");
    const x = world({ whisper: "off" });
    await x.speech.transcribeFile(x.audioFile("a.flac"));
    expect(((x.fetchCalls[0].init!.body as FormData).get("file") as File).type).toBe("audio/ogg");
  });

  test("Pufferweg: whisper-Temp-Datei mit Endung aus dem MIME, danach gelöscht", async () => {
    const w = world();
    await w.speech.transcribeBuffer(Buffer.from("x"), "audio/mpeg");
    const file = w.runCalls[0][w.runCalls[0].indexOf("--file") + 1];
    expect(file.startsWith(join(w.cwd, "uploads", "whisper_tmp_"))).toBe(true);
    expect(file.endsWith(".mp3")).toBe(true);
    expect(readdirSync(join(w.cwd, "uploads"))).toEqual([]);
  });

  test("Temp-Datei im Pufferweg auch nach Fehler gelöscht", async () => {
    for (const whisper of ["fail", "timeout", "empty", "blank"] as const) {
      const w = world({ whisper });
      await w.speech.transcribeBuffer(Buffer.from("x"), "audio/ogg; codecs=opus");
      const file = w.runCalls[0][w.runCalls[0].indexOf("--file") + 1];
      expect(file.endsWith(".ogg")).toBe(true);
      expect(existsSync(file)).toBe(false);
      expect(readdirSync(join(w.cwd, "uploads"))).toEqual([]);
    }
  });

  test("extForMime bereinigt", () => {
    expect(extForMime("audio/ogg; codecs=opus")).toBe("ogg");
    expect(extForMime("audio/mpeg")).toBe("mp3");
    expect(extForMime("audio/../../etc")).toBe("ogg");
    expect(extForMime("audio/we b")).toBe("web");
    expect(extForMime("")).toBe("ogg");
    expect(extForMime("audio/x-flac")).toBe("xflac");
  });
});

describe("Logs ohne Inhalt", () => {
  test("weder Transkript noch stderr noch Antworttext noch Schlüssel", async () => {
    const w = world({ whisper: "fail", elevenStt: "fail" });
    expect(await w.speech.transcribeBuffer(Buffer.from("x"))).toBe("TRANSKRIPT-GEMINI");
    const v = world({ qwen: "fail", elevenTts: "fail", ffmpeg: "missing" });
    await v.speech.synthesizeServer("EINGABE-MARKER");
    const ok = world();
    await ok.speech.transcribeFile(ok.audioFile("a.ogg"));
    await ok.speech.synthesizeServer("EINGABE-MARKER");
    for (const logs of [w.logs, v.logs, ok.logs]) expectNoMarkers(logs);
    expect(w.logs.join("\n")).toContain("Hören whisper-cpp: Fehler (Exit-Code 1)");
    expect(w.logs.join("\n")).toContain("Hören gemini: ok");
    expect(v.logs.join("\n")).toContain("Sprechen elevenlabs: Fehler (HTTP 401)");
  });
});

describe("Aufrufer über transcribe.ts und speech/index.ts", () => {
  afterEach(() => setSpeechForTests());

  test("Exporte delegieren an die Sprach-Schnittstelle", async () => {
    const w = world({ settings: { speech: { stt: "gemini" } } });
    setSpeechForTests(w.speech);
    expect(await transcribeAudio(w.audioFile("a.ogg"))).toBe("TRANSKRIPT-GEMINI");
    expect(await transcribeAudioBuffer(Buffer.from("x"))).toBe("TRANSKRIPT-GEMINI");
    expect(isTranscriptionEnabled()).toBe(true);
    expect(getTranscriptionProvider()).toBe("Gemini");
    expect((await textToSpeech("Hallo"))!.subarray(0, 4).toString()).toBe("OggS");
    expect(isVoiceEnabled()).toBe(true);
  });

  test("Browser-Stimme zählt nicht als Server-Stimme (Hüllen in speech/index.ts, Issue #367)", async () => {
    const withServer = world({ settings: { speech: { tts: "browser" } }, qwen: "off" });
    setSpeechForTests(withServer.speech);
    expect(isVoiceEnabled()).toBe(true);
    expect((await textToSpeech("Hallo"))!.toString()).toBe("ID3-mp3-daten");
    const browserOnly = world({ settings: { speech: { tts: "browser" } }, qwen: "off", elevenStt: "off", elevenTts: "off", geminiStt: "off", geminiTts: "off" });
    setSpeechForTests(browserOnly.speech);
    expect(isVoiceEnabled()).toBe(false);
    expect(await textToSpeech("Hallo")).toBeNull();
  });
});

describe("Einstellungen ohne Neustart", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "speech-settings-"));
    setSettingsPath(join(dir, "settings.json"));
  });
  afterEach(() => {
    setSettingsPath();
    rmSync(dir, { recursive: true, force: true });
  });

  test("Änderung der Datei wirkt beim nächsten Aufruf", async () => {
    const real = createSpeech({ stt: [], tts: [], getSettings, env: () => ({}), log: () => {}, readFile: p => readFile(p) });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ speech: { stt: "gemini" } }));
    expect(real.choice().stt).toEqual({ value: "gemini", source: "settings" });
    writeFileSync(join(dir, "settings.json"), JSON.stringify({ speech: { stt: "elevenlabs" } }));
    expect(real.choice().stt).toEqual({ value: "elevenlabs", source: "settings" });
    rmSync(join(dir, "settings.json"));
    expect(real.choice().stt).toEqual({ value: "auto", source: "code" });
  });
});
