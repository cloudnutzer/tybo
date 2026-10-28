/**
 * Issue #249: strenges Hören für den Sprechmodus (recognize). Anders als
 * transcribe liefert es nie einen Platzhaltertext, sondern einen Grund, und
 * das Zeitlimit gilt für die ganze Erkennung. Anbieter, Subprozess und fetch
 * sind Attrappen: kein Netzwerk, kein Modell.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpeech, TRANSCRIPTION_TEXT } from "../src/lib/speech/chain";
import { createSttProviders, type ProviderDeps } from "../src/lib/speech/providers";
import type { RunResult } from "../src/lib/speech/process";
import { SpeechError, type SttProvider } from "../src/lib/speech/types";
import type { Settings } from "../src/lib/settings";
import type { SttId } from "../src/lib/speech/ids";

type Behavior = "ok" | "empty" | "none" | "throw" | "unavailable" | "hang";

function setup(behaviors: Partial<Record<SttId, Behavior>>, settings: Settings = {}) {
  const calls: string[] = [];
  const aborted: string[] = [];
  const logs: string[] = [];
  const all: Record<SttId, Behavior> = { parakeet: "unavailable", "whisper-cpp": "unavailable", elevenlabs: "unavailable", gemini: "unavailable", ...behaviors };
  const stt: SttProvider[] = (Object.keys(all) as SttId[]).map(id => ({
    id,
    label: id,
    local: false,
    available: () => (all[id] === "unavailable" ? { ok: false, reason: "fehlt" } : { ok: true }),
    transcribe: async (_audio, _mime, opts) => {
      calls.push(id);
      if (all[id] === "throw") throw new SpeechError("exit", 1);
      if (all[id] === "empty") return "  ";
      if (all[id] === "none") return "";
      if (all[id] === "hang") {
        // Hängt, bis das Zeitlimit das Signal auslöst
        await new Promise<void>(resolve => opts.signal!.addEventListener("abort", () => resolve(), { once: true }));
        aborted.push(id);
        throw new SpeechError("timeout");
      }
      return `  Text von ${id} \n`;
    },
  }));
  const speech = createSpeech({ stt, tts: [], getSettings: () => settings, env: () => ({}), log: l => logs.push(l), readFile: async () => Buffer.from("x") });
  return { speech, calls, aborted, logs };
}

const AUDIO = Buffer.from("audio");

describe("recognize", () => {
  test("auto: erster verfügbarer Anbieter, Text ohne Leerraum außen, mit Kennung", async () => {
    const { speech, calls } = setup({ "whisper-cpp": "ok", gemini: "ok" });
    expect(await speech.recognize(AUDIO, "audio/wav", { timeoutMs: 1000 })).toEqual({ ok: true, text: "Text von whisper-cpp", provider: "whisper-cpp" });
    expect(calls).toEqual(["whisper-cpp"]);
  });

  test("auto: Fehler und leere Ergebnisse schalten weiter", async () => {
    const { speech, calls } = setup({ "whisper-cpp": "throw", elevenlabs: "empty", gemini: "ok" });
    expect(await speech.recognize(AUDIO, "audio/wav", { timeoutMs: 1000 })).toEqual({ ok: true, text: "Text von gemini", provider: "gemini" });
    expect(calls).toEqual(["whisper-cpp", "elevenlabs", "gemini"]);
  });

  test("alle technisch gescheitert: Grund failed, nie der Platzhaltertext", async () => {
    const { speech, calls } = setup({ "whisper-cpp": "throw", gemini: "throw" });
    const result = await speech.recognize(AUDIO, "audio/wav", { timeoutMs: 1000 });
    expect(result).toEqual({ ok: false, reason: "failed" });
    expect(calls).toEqual(["whisper-cpp", "gemini"]);
    expect(JSON.stringify(result)).not.toContain(TRANSCRIPTION_TEXT.failed);
  });

  test("auto: leerer oder nur weißer Text ist empty, kein technischer Fehler, nie ein Platzhaltertext", async () => {
    for (const behavior of ["empty", "none"] as const) {
      const { speech, calls, logs } = setup({ "whisper-cpp": behavior, gemini: behavior });
      const result = await speech.recognize(AUDIO, "audio/wav", { timeoutMs: 1000 });
      expect(result).toEqual({ ok: false, reason: "empty" });
      // Bei auto bekommt trotzdem jeder verfügbare Anbieter seine Chance
      expect(calls).toEqual(["whisper-cpp", "gemini"]);
      expect(JSON.stringify(result)).not.toContain(TRANSCRIPTION_TEXT.failed);
      expect(logs.join("\n")).toContain("Fehler (leeres Ergebnis)");
    }
  });

  test("auto: ein Anbieter scheitert technisch, ein anderer hört nichts: empty", async () => {
    for (const order of [{ "whisper-cpp": "throw", gemini: "empty" }, { "whisper-cpp": "none", gemini: "throw" }] as const) {
      const { speech } = setup(order);
      expect(await speech.recognize(AUDIO, "audio/wav", { timeoutMs: 1000 })).toEqual({ ok: false, reason: "empty" });
    }
  });

  test("fest gewählt und leer: empty, kein anderer Anbieter", async () => {
    for (const behavior of ["empty", "none"] as const) {
      const { speech, calls } = setup({ "whisper-cpp": behavior, gemini: "ok" }, { speech: { stt: "whisper-cpp" } });
      expect(await speech.recognize(AUDIO, "audio/wav", { timeoutMs: 1000 })).toEqual({ ok: false, reason: "empty" });
      expect(calls).toEqual(["whisper-cpp"]);
    }
  });

  test("Telegram-Weg unverändert: leerer Text bleibt dort der Platzhalter [Transcription failed]", async () => {
    const fixed = setup({ "whisper-cpp": "none", gemini: "ok" }, { speech: { stt: "whisper-cpp" } });
    expect(await fixed.speech.transcribeBuffer(AUDIO, "audio/ogg")).toBe(TRANSCRIPTION_TEXT.failed);
    expect(fixed.calls).toEqual(["whisper-cpp"]);
    const auto = setup({ "whisper-cpp": "empty", gemini: "none" });
    expect(await auto.speech.transcribeBuffer(AUDIO, "audio/ogg")).toBe(TRANSCRIPTION_TEXT.failed);
    expect(await auto.speech.transcribeFile("aufnahme.ogg")).toBe(TRANSCRIPTION_TEXT.failed);
    // Bei auto rettet der nächste Anbieter weiterhin ein leeres Ergebnis
    const next = setup({ "whisper-cpp": "empty", gemini: "ok" });
    expect(await next.speech.transcribeBuffer(AUDIO, "audio/ogg")).toBe("  Text von gemini \n");
  });

  test("kein Anbieter verfügbar: unavailable, kein Aufruf", async () => {
    const { speech, calls } = setup({});
    expect(await speech.recognize(AUDIO, "audio/wav", { timeoutMs: 1000 })).toEqual({ ok: false, reason: "unavailable" });
    expect(calls).toEqual([]);
  });

  test("fest gewählt und nicht verfügbar: unavailable, kein anderer Anbieter", async () => {
    const { speech, calls, logs } = setup({ gemini: "ok" }, { speech: { stt: "whisper-cpp" } });
    expect(await speech.recognize(AUDIO, "audio/wav", { timeoutMs: 1000 })).toEqual({ ok: false, reason: "unavailable" });
    expect(calls).toEqual([]);
    expect(logs.join("\n")).toContain("whisper-cpp nicht verfügbar");
  });

  test("fest gewählt und gescheitert: failed, kein anderer Anbieter", async () => {
    const { speech, calls } = setup({ "whisper-cpp": "throw", gemini: "ok" }, { speech: { stt: "whisper-cpp" } });
    expect(await speech.recognize(AUDIO, "audio/wav", { timeoutMs: 1000 })).toEqual({ ok: false, reason: "failed" });
    expect(calls).toEqual(["whisper-cpp"]);
  });

  test("Zeitlimit gilt für die ganze Erkennung: Signal bricht ab, kein weiterer Anbieter", async () => {
    const { speech, calls, aborted, logs } = setup({ "whisper-cpp": "hang", gemini: "ok" });
    const started = Date.now();
    expect(await speech.recognize(AUDIO, "audio/wav", { timeoutMs: 40 })).toEqual({ ok: false, reason: "timeout" });
    expect(Date.now() - started).toBeLessThan(1000);
    await Bun.sleep(20);
    expect(aborted).toEqual(["whisper-cpp"]);
    expect(calls).toEqual(["whisper-cpp"]);
    expect(logs.join("\n")).toContain("Zeitlimit nach 40 ms");
  });

  test("Sprache aus den Einstellungen geht an den Anbieter", async () => {
    const seen: (string | undefined)[] = [];
    const stt: SttProvider[] = [
      { id: "gemini", label: "g", local: false, available: () => ({ ok: true }), transcribe: async (_a, _m, o) => (seen.push(o.language), "ja gut") },
    ];
    const speech = createSpeech({ stt, tts: [], getSettings: () => ({ speech: { language: "de" } }), env: () => ({}), log: () => {}, readFile: async () => Buffer.from("x") });
    expect((await speech.recognize(AUDIO, "audio/wav", { timeoutMs: 1000 })).ok).toBe(true);
    expect(seen).toEqual(["de"]);
  });
});

// --- whisper.cpp: Temp-Datei verschwindet auch bei Fehler und Zeitlimit ------------

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function whisperWorld(mode: "ok" | "fail" | "hang") {
  const root = mkdtempSync(join(tmpdir(), "speech-recognize-"));
  roots.push(root);
  const cwd = join(root, "cwd");
  mkdirSync(cwd, { recursive: true });
  const model = join(root, "ggml.bin");
  writeFileSync(model, "m");
  const seenFiles: string[] = [];
  const signals: (AbortSignal | undefined)[] = [];
  const result = (r: Partial<RunResult>): RunResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, ...r });
  const deps: ProviderDeps = {
    env: () => ({ WHISPER_MODEL_PATH: model }),
    run: async (cmd, opts) => {
      const file = cmd[cmd.indexOf("--file") + 1];
      seenFiles.push(file);
      signals.push(opts.signal);
      // Die Aufnahme liegt nur während des Laufs als Temp-Datei vor
      expect(existsSync(file)).toBe(true);
      if (mode === "fail") return result({ exitCode: 3, stderr: "geheim" });
      if (mode === "hang") {
        await new Promise<void>(resolve => opts.signal!.addEventListener("abort", () => resolve(), { once: true }));
        return result({ exitCode: null, timedOut: true });
      }
      return result({ stdout: " Hallo Welt \n" });
    },
    fetch: async () => {
      throw new Error("kein Netzwerk im Test");
    },
    exists: existsSync,
    which: cmd => (cmd === "whisper-cli" ? "/usr/bin/whisper-cli" : null),
    readFile: path => readFile(path),
    writeFile: (path, data) => writeFile(path, data),
    unlink: path => unlink(path),
    mkdir: async path => {
      await mkdir(path, { recursive: true });
    },
    cwd: () => cwd,
    tmpDir: root,
    unique: () => "u1",
  };
  const speech = createSpeech({
    stt: createSttProviders(deps),
    tts: [],
    getSettings: () => ({ speech: { stt: "whisper-cpp" } }),
    env: () => ({}),
    log: () => {},
    readFile: path => readFile(path),
  });
  const leftovers = () => (existsSync(join(cwd, "uploads")) ? readdirSync(join(cwd, "uploads")) : []);
  return { speech, seenFiles, signals, leftovers };
}

describe("whisper.cpp im Sprechmodus", () => {
  test("Erfolg: Text, Temp-Datei danach gelöscht, das Signal geht an den Subprozess", async () => {
    const w = whisperWorld("ok");
    expect(await w.speech.recognize(AUDIO, "audio/wav", { timeoutMs: 1000 })).toEqual({ ok: true, text: "Hallo Welt", provider: "whisper-cpp" });
    expect(w.seenFiles).toHaveLength(1);
    expect(w.seenFiles[0].endsWith(".wav")).toBe(true);
    expect(w.signals[0]).toBeInstanceOf(AbortSignal);
    expect(w.leftovers()).toEqual([]);
  });

  test("Fehler des Programms: failed, Temp-Datei gelöscht", async () => {
    const w = whisperWorld("fail");
    expect(await w.speech.recognize(AUDIO, "audio/wav", { timeoutMs: 1000 })).toEqual({ ok: false, reason: "failed" });
    expect(w.leftovers()).toEqual([]);
  });

  test("Zeitlimit: timeout, der Subprozess wird abgebrochen, Temp-Datei gelöscht", async () => {
    const w = whisperWorld("hang");
    expect(await w.speech.recognize(AUDIO, "audio/wav", { timeoutMs: 30 })).toEqual({ ok: false, reason: "timeout" });
    expect(w.signals[0]!.aborted).toBe(true);
    await Bun.sleep(30);
    expect(w.leftovers()).toEqual([]);
  });
});
