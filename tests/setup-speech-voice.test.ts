/**
 * Issue #252, Checkbox 3: Teil „Stimme“ im Schritt „sprache“. Pocket TTS
 * mit Installation im venv, Modell-Download, Probe mit Zeitmessung
 * (Ladezeit getrennt, RTF = Rechenzeit / Tondauer), Piper als Vorschlag
 * bzw. nach Zustimmung bei RTF > 1, ElevenLabs nur mit Schlüssel und Stimme.
 * Alles mit Attrappen: kein Python, kein pip, kein Modell, kein Netz.
 */

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setSettingsPath } from "../src/lib/settings";
import { speechDir, type Artifact } from "../src/lib/speech/parakeet";
import { piperPaths, type PiperArtifactId } from "../src/lib/speech/piper";
import { POCKET_GUARD_SCRIPT, pocketPaths, type PocketServerDeps } from "../src/lib/speech/pocket";
import { AI_GENERATED_NOTE, readWavInfo } from "../src/lib/speech/wav";
import type { SetupContext } from "../src/setup/context";
import type { RunEvent } from "../src/setup/model";
import { PIPER_FALLBACK_FIELD, PYTORCH_CPU_INDEX, VOICE_FIELD, VOICE_PROBE_TEXT } from "../src/setup/speech-voice";
import { existingFieldValues } from "../src/setup/steps";
import { runSpeech, SPEECH_FIELDS, speechInventory, speechPlan, speechStep } from "../src/setup/steps/speech";
import { cleanup, FULL_ENV } from "./setup-fixture";
import { runWith, scripted } from "./setup-terminal-fixture";
import { pathsOf, placeFiles, readJson, speechCtx, type SpeechCtxOptions } from "./parakeet-fixture";
import { get, login, post, startSetup, type Started, type TestCtx } from "./setup-web-fixture";
import { buildProof } from "../src/lib/speech/parakeet";
import { statFile } from "../src/setup/steps/speech";

const running: Started[] = [];
afterEach(async () => {
  setSettingsPath();
  for (const s of running.splice(0)) await s.server.stop();
});
afterAll(async () => {
  await cleanup();
});

/** WAV 24 kHz mono PCM16 mit offener Größe, wie pocket-tts serve es streamt */
function wav(seconds: number, rate = 24_000): Buffer {
  const data = Buffer.alloc(Math.round(rate * seconds) * 2, 1);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(0xffffffff, 4);
  head.write("WAVE", 8, "latin1");
  head.write("fmt ", 12, "latin1");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "latin1");
  head.writeUInt32LE(0xffffffff, 40);
  return Buffer.concat([head, data]);
}

type PipMode = "ok" | "fail" | "abort";

interface VoiceOpts extends SpeechCtxOptions {
  /** RTF der Pocket-Probe (Rechenzeit je Sekunde Ton) */
  rtf?: number;
  pip?: PipMode;
  /** partial: erster Aufruf hinterlässt einen halben Download im Cache und bricht ab, weitere laden fertig */
  model?: "ok" | "fail" | "abort" | "partial";
  python?: string | null;
}

async function voiceWorld(o: VoiceOpts = {}) {
  const ctx = await speechCtx({ ...o, programs: o.python === null ? ["ffmpeg"] : ["ffmpeg", "python3"] });
  let clock = Date.parse("2026-10-01T08:00:00.000Z");
  ctx.now = () => new Date(clock);
  const dir = speechDir(ctx.root);
  const pp = pocketPaths(dir);
  const ip = piperPaths(dir);
  const calls: string[][] = [];
  let controller = new AbortController();
  let generates = 0;
  const rtf = o.rtf ?? 0.1;

  ctx.run = (async (cmd: string[], opts: { signal?: AbortSignal } = {}) => {
    calls.push(cmd);
    const ok = { code: 0, stdout: "", stderr: "" };
    if (cmd[0] === "python3" && cmd[1] === "-c") return { ...ok, stdout: `${o.python ?? "3.12"}\n` };
    if (cmd[0] === "python3" && cmd[1] === "-m" && cmd[2] === "venv") {
      await mkdir(join(cmd[3], "bin"), { recursive: true });
      await writeFile(join(cmd[3], "bin", "python"), "py");
      return ok;
    }
    if (cmd[1] === "-m" && cmd[2] === "pip") {
      const venv = dirname(dirname(cmd[0]));
      // Halb installiert: Dateien liegen schon da, bevor pip scheitert
      await writeFile(join(venv, "bin", "halb"), "x");
      if (o.pip === "fail") return { code: 1, stdout: "", stderr: "STDERR-MARKER" };
      if (o.pip === "abort") {
        controller.abort();
        return { code: -1, stdout: "", stderr: "", aborted: true };
      }
      const program = cmd.some(c => c.startsWith("pocket-tts")) ? "pocket-tts" : "piper";
      await writeFile(join(venv, "bin", program), "#!/bin/sh\n");
      return ok;
    }
    if (cmd[0] === pp.program && cmd[1] === "generate") {
      generates++;
      if (o.model === "partial" && generates === 1) {
        await mkdir(join(pp.modelCache, "blobs"), { recursive: true });
        await writeFile(join(pp.modelCache, "blobs", "abc.incomplete"), "halb");
        controller.abort();
        return { code: -1, stdout: "", stderr: "", aborted: true };
      }
      if (o.model === "partial") await rm(join(pp.modelCache, "blobs", "abc.incomplete"), { force: true });
      if (o.model === "fail") return { code: 1, stdout: "", stderr: "STDERR-MARKER" };
      if (o.model === "abort") {
        controller.abort();
        return { code: -1, stdout: "", stderr: "", aborted: true };
      }
      await mkdir(join(pp.modelCache, "blobs"), { recursive: true });
      await writeFile(cmd[cmd.indexOf("--output-path") + 1], wav(0.5));
      return ok;
    }
    if (cmd[0] === ip.program) {
      clock += 200;
      await writeFile(cmd[cmd.indexOf("-f") + 1], wav(1, 22_050));
      return ok;
    }
    throw new Error(`unerwarteter Befehl ${cmd.join(" ")}`);
  }) as SetupContext["run"];

  // Pocket-Prozess der Probe: Laden 1,5 s, Synthese rtf * Tondauer
  const spawned: string[][] = [];
  const killed: string[] = [];
  const pocketServer: PocketServerDeps = {
    spawn(cmd) {
      spawned.push(cmd);
      return { exited: new Promise(() => {}), kill: s => void killed.push(String(s)) };
    },
    async fetch(url) {
      if (url.endsWith("/health")) {
        clock += 1500;
        return new Response("{}", { status: 200 });
      }
      const audio = wav(5);
      clock += Math.round(rtf * 5 * 1000);
      return new Response(audio, { status: 200 });
    },
    freePort: async () => 41000,
    now: () => clock,
    sleep: async () => {},
    setTimer: () => 0,
    clearTimer: () => {},
  };

  // Piper-Stimme als kleine Dateien mit eigener Prüfsumme
  const bodies = new Map<string, Buffer>();
  const piperArtifacts: Artifact<PiperArtifactId>[] = (["piper-stimme", "piper-konfig"] as const).map(id => {
    const body = Buffer.from(`inhalt ${id}`);
    const file = id === "piper-stimme" ? "de_DE-thorsten-medium.onnx" : "de_DE-thorsten-medium.onnx.json";
    const url = `https://example.invalid/${file}`;
    bodies.set(url, body);
    return { id, file, url, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex"), unpackedBytes: body.length, target: join("piper", file) };
  });
  const fetched: string[] = [];
  ctx.fetch = async url => {
    fetched.push(url);
    const body = bodies.get(url);
    return body ? new Response(body, { status: 200 }) : new Response("nein", { status: 404 });
  };
  ctx.speechVoice = { pocketServer, piperArtifacts };

  async function run(values: Record<string, string>) {
    const events: RunEvent[] = [];
    const existing = await existingFieldValues(speechStep, ctx);
    const result = await runSpeech({ ...existing, ...values }, ctx, e => events.push(e), controller.signal);
    return { result, events };
  }
  return {
    ctx,
    dir,
    pp,
    ip,
    calls,
    spawned,
    killed,
    fetched,
    get controller() {
      return controller;
    },
    /** Neuer Lauf nach einem Abbruch */
    freshSignal() {
      controller = new AbortController();
    },
    run,
    settings: () => readJson(ctx.settingsPath).catch(() => null),
  };
}

/** Parakeet als eingerichtet ablegen, damit der Teil Hören nichts lädt */
async function hearingReady(ctx: SetupContext) {
  const paths = pathsOf(ctx);
  await placeFiles(paths);
  await writeFile(paths.proof, JSON.stringify(buildProof(paths, "osx-arm64", statFile, { wer: 0.05, ms: 400, at: "x" })));
  await mkdir(dirname(ctx.settingsPath), { recursive: true });
  await writeFile(ctx.settingsPath, JSON.stringify({ speech: { stt: "parakeet" } }));
}

describe("Teil Stimme: Felder und Plan", () => {
  test("Auswahl mit Beibehalten als Standard, Browser-Stimme, lokale Stimme mit Größen und Kyutai, ElevenLabs als Cloud", () => {
    const f = SPEECH_FIELDS.find(x => x.name === VOICE_FIELD)!;
    expect(f.default).toBe("keep");
    const labels = Object.fromEntries(f.choices!.map(c => [c.value, c.label]));
    expect(labels.keep).toBe("Beibehalten (die bisherige Einstellung bleibt unverändert)");
    expect(labels.browser).toBe("Browser-Stimme (ohne Installation, klingt je nach Gerät anders)");
    expect(labels.pocket).toContain("Jürgen, empfohlen: privat, alles auf deinem Rechner");
    expect(labels.pocket).toContain("Pocket TTS");
    expect(labels.pocket).toContain("220 MB Modell");
    expect(labels.pocket).toContain("CC-BY-4.0 Kyutai");
    expect(labels.elevenlabs).toContain("Cloud: Text geht an ElevenLabs");
  });

  test("Vorauswahl ist die eingestellte Stimme; auto gilt als Browser-Stimme", async () => {
    const a = await voiceWorld();
    expect((await existingFieldValues(speechStep, a.ctx))[VOICE_FIELD]).toBe("browser");
    const b = await voiceWorld({ settings: JSON.stringify({ speech: { tts: "pocket" } }) });
    expect((await existingFieldValues(speechStep, b.ctx))[VOICE_FIELD]).toBe("pocket");
  });

  test("ElevenLabs ohne Schlüssel und Stimme wird abgewiesen", async () => {
    const w = await voiceWorld({ env: "ELEVENLABS_API_KEY=k\n" });
    const f = SPEECH_FIELDS.find(x => x.name === VOICE_FIELD)!;
    const existing = await existingFieldValues(speechStep, w.ctx);
    expect(f.validate!("elevenlabs", existing)).toContain("ELEVENLABS_VOICE_ID");
    const ok = await voiceWorld({ env: "ELEVENLABS_API_KEY=k\nELEVENLABS_VOICE_ID=v\n" });
    expect(f.validate!("elevenlabs", await existingFieldValues(speechStep, ok.ctx))).toBeNull();
  });

  test("Plan für Pocket: Download getrennt nach Laufzeit und Modell, erst nach Ja, Messung, Namensnennung", async () => {
    const w = await voiceWorld();
    const plan = speechPlan({ ...(await existingFieldValues(speechStep, w.ctx)), [VOICE_FIELD]: "pocket" }).join(" ");
    expect(plan).toContain("Laufzeit pocket-tts 3.3.0 mit PyTorch ca. 170 MB");
    expect(plan).toContain("Stimme juergen ca. 220 MB");
    expect(plan).toContain("erst nach deinem Ja");
    expect(plan).toContain("RTF = Rechenzeit geteilt durch Tondauer");
    expect(plan).toContain("schlägt Piper vor");
    expect(plan).toContain("Kyutai");
    const linux = await voiceWorld({ platform: "linux", arch: "arm64" });
    const lplan = speechPlan({ ...(await existingFieldValues(speechStep, linux.ctx)), [VOICE_FIELD]: "pocket", [PIPER_FALLBACK_FIELD]: "true" }).join(" ");
    expect(lplan).toContain("ca. 250 MB (PyTorch aus dem CPU-Index, ohne CUDA)");
    expect(lplan).toContain("richtet der Lauf stattdessen Piper ein");
  });

  test("Terminal: lokale Stimme gewählt, „Jetzt ausführen?“ nein installiert nichts", async () => {
    const w = await voiceWorld({ env: FULL_ENV });
    // Weg, Umstellen, Stimme 3 (Pocket), Piper bei langsam nein, eigene Stimme Enter (nein, Issue #253), „Jetzt ausführen?“ nein
    const prompter = scripted(["", "", "3", "n", "", "n"]);
    const r = await runWith({ mode: "step", step: "sprache" }, w.ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.left()).toBe(0);
    expect(r.out).toContain("Lokale Stimme Pocket TTS: Download");
    expect(r.out).toContain("Nicht ausgeführt.");
    expect(w.calls).toEqual([]);
    expect(w.spawned).toEqual([]);
    expect(existsSync(join(w.ctx.root, "models"))).toBe(false);
  });
});

describe("Teil Stimme: Pocket TTS", () => {
  test("installiert, lädt das Modell online, misst offline, schreibt Nachweis und Probe, stellt um", async () => {
    const w = await voiceWorld();
    await hearingReady(w.ctx);
    const { result, events } = await w.run({ [VOICE_FIELD]: "pocket" });
    expect(result.ok).toBe(true);
    expect(result.audio).toBe("pocket");
    // venv, pip mit fester Version (Mac: ohne CPU-Index), Modell einmal online
    expect(w.calls.find(c => c[2] === "venv")).toEqual(["python3", "-m", "venv", w.pp.venv]);
    const pip = w.calls.find(c => c[2] === "pip")!;
    expect(pip).toContain("pocket-tts==3.3.0");
    expect(pip).not.toContain(PYTORCH_CPU_INDEX);
    const gen = w.calls.find(c => c[1] === "generate")!;
    expect(gen).toEqual(expect.arrayContaining(["--language", "german", "--voice", "juergen"]));
    // Probe über den Server wie im Bot
    expect(w.spawned[0]).toEqual([w.pp.python, "-I", POCKET_GUARD_SCRIPT, "--port", "41000", "--language", "german", "--voice", "juergen"]);
    expect(w.killed).toEqual(["SIGTERM"]);
    // Messung: Laden getrennt, RTF aus Rechenzeit und Tondauer
    const proof = await readJson(w.pp.proof);
    expect(proof).toMatchObject({ version: 1, pocket: "3.3.0", language: "german", voice: "juergen" });
    expect(proof.probe.loadMs).toBe(1500);
    expect(proof.probe.synthMs).toBe(500);
    expect(proof.probe.audioSeconds).toBe(5);
    expect(proof.probe.rtf).toBe(0.1);
    expect(result.message).toContain("Modell geladen in 1,50 s, 5,0 s Ton in 0,50 s erzeugt (RTF 0,10, schneller als Echtzeit)");
    // Hörbare Probe mit Kennzeichnung, Hinweis zum Abspielen und Namensnennung
    expect(readWavInfo(await readFile(w.pp.probeWav)).ICMT).toBe(AI_GENERATED_NOTE);
    expect(result.message).toContain("Probe anhören: afplay models/speech/pocket-probe.wav");
    expect(result.message).toContain("bun run notify --source datei --file models/speech/pocket-probe.wav");
    expect(result.message).toContain("Kyutai");
    expect((await w.settings()).speech).toEqual({ stt: "parakeet", tts: "pocket" });
    expect(events.some(e => e.label.startsWith("Stimme: Lade pocket-tts 3.3.0"))).toBe(true);
    // Nichts in den Ausgaben der Programme
    expect(JSON.stringify(result)).not.toContain("STDERR-MARKER");
    expect(VOICE_PROBE_TEXT).toContain("lokaler Stimme");
  });

  test("Linux: PyTorch aus dem CPU-Index", async () => {
    const w = await voiceWorld({ platform: "linux", arch: "x64" });
    await w.run({ [VOICE_FIELD]: "pocket" });
    const pip = w.calls.find(c => c[2] === "pip")!;
    expect(pip).toEqual(expect.arrayContaining(["--extra-index-url", PYTORCH_CPU_INDEX, "pocket-tts==3.3.0"]));
  });

  test("schon eingerichtet: nichts geladen, nur die Probe", async () => {
    const w = await voiceWorld();
    await hearingReady(w.ctx);
    await w.run({ [VOICE_FIELD]: "pocket" });
    const before = w.calls.length;
    const again = await w.run({ [VOICE_FIELD]: "pocket" });
    expect(again.result.ok).toBe(true);
    expect(w.calls.slice(before).filter(c => c[2] === "pip" || c[1] === "generate" || c[2] === "venv")).toEqual([]);
    expect(again.result.message).toContain("Vorlesen steht schon auf Pocket TTS");
  });

  test("RTF über 1 ohne Zustimmung: Pocket bleibt geprüft, das Vorlesen unverändert, Vorschlag Piper", async () => {
    const w = await voiceWorld({ rtf: 1.6 });
    await hearingReady(w.ctx);
    const { result } = await w.run({ [VOICE_FIELD]: "pocket" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("RTF 1,60, langsamer als Echtzeit");
    expect(result.message).toContain("Vorschlag: Piper");
    expect((await w.settings()).speech).toEqual({ stt: "parakeet" });
    expect(existsSync(w.ip.venv)).toBe(false);
    expect(w.fetched).toEqual([]);
  });

  test("RTF genau 1 gilt noch als Echtzeit", async () => {
    const w = await voiceWorld({ rtf: 1 });
    await hearingReady(w.ctx);
    const { result } = await w.run({ [VOICE_FIELD]: "pocket" });
    expect((await w.settings()).speech.tts).toBe("pocket");
    expect(result.message).toContain("RTF 1,00, schneller als Echtzeit");
  });

  test("RTF über 1 mit Zustimmung: Piper wird eingerichtet und eingestellt", async () => {
    const w = await voiceWorld({ rtf: 2 });
    await hearingReady(w.ctx);
    const { result } = await w.run({ [VOICE_FIELD]: "pocket", [PIPER_FALLBACK_FIELD]: "true" });
    expect(result.ok).toBe(true);
    expect(result.audio).toBe("piper");
    expect(result.message).toContain("Deshalb stattdessen Piper");
    expect((await w.settings()).speech.tts).toBe("piper");
    // piper ohne CPU-Index, Stimme mit Prüfsumme geladen
    const pips = w.calls.filter(c => c[2] === "pip");
    expect(pips[1]).toContain("piper-tts==1.8.0");
    expect(pips[1]).not.toContain(PYTORCH_CPU_INDEX);
    expect(w.fetched).toHaveLength(2);
    expect(await readFile(w.ip.model, "utf8")).toBe("inhalt piper-stimme");
    expect(await readJson(w.ip.proof)).toMatchObject({ version: 1, piper: "1.8.0", voice: "de_DE-thorsten-medium" });
    expect(result.message).toContain("GPL-3.0");
  });

  test("pip scheitert: halbe Umgebung gelöscht, kein Nachweis, Einstellung unverändert", async () => {
    const w = await voiceWorld({ pip: "fail" });
    await hearingReady(w.ctx);
    const { result } = await w.run({ [VOICE_FIELD]: "pocket" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Installation mit pip fehlgeschlagen (Exit-Code 1)");
    expect(result.message).not.toContain("STDERR-MARKER");
    expect(existsSync(w.pp.venv)).toBe(false);
    expect(existsSync(w.pp.proof)).toBe(false);
    expect((await w.settings()).speech).toEqual({ stt: "parakeet" });
  });

  test("Abbruch während pip: halbe Umgebung gelöscht, Hinweis auf den pip-Cache", async () => {
    const w = await voiceWorld({ pip: "abort" });
    await hearingReady(w.ctx);
    const { result } = await w.run({ [VOICE_FIELD]: "pocket" });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Abgebrochen. Die halbe Python-Umgebung ist gelöscht");
    expect(existsSync(w.pp.venv)).toBe(false);
    expect(w.spawned).toEqual([]);
  });

  test("Abbruch beim Modell: Umgebung bleibt, kein Nachweis, der nächste Lauf setzt fort", async () => {
    const w = await voiceWorld({ model: "abort" });
    await hearingReady(w.ctx);
    const { result } = await w.run({ [VOICE_FIELD]: "pocket" });
    expect(result.message).toContain("beim nächsten Lauf fortgesetzt");
    expect(existsSync(w.pp.program)).toBe(true);
    expect(existsSync(w.pp.proof)).toBe(false);
    expect(readdirSync(w.pp.dir).filter(n => n.startsWith(".tmp-"))).toEqual([]);
  });

  test("Wiederaufnahme: halber Modell-Download im Cache, der zweite Lauf lädt fertig, prüft und stellt um", async () => {
    const w = await voiceWorld({ model: "partial" });
    await hearingReady(w.ctx);
    const first = await w.run({ [VOICE_FIELD]: "pocket" });
    expect(first.result.message).toContain("beim nächsten Lauf fortgesetzt");
    // Zurück bleiben Cache-Ordner samt halber Datei, aber kein Nachweis der Vollständigkeit
    expect(existsSync(join(w.pp.modelCache, "blobs", "abc.incomplete"))).toBe(true);
    expect(existsSync(w.pp.modelReady)).toBe(false);
    expect(existsSync(w.pp.proof)).toBe(false);
    // Inventar und Plan sehen das Modell als fehlend
    const inv = await speechInventory(w.ctx);
    expect(inv.voice.pocket.model).toBe(false);
    expect(speechPlan({ ...(await existingFieldValues(speechStep, w.ctx)), [VOICE_FIELD]: "pocket" }).join(" ")).toContain("Stimme juergen ca. 220 MB");

    w.freshSignal();
    const before = w.calls.length;
    const second = await w.run({ [VOICE_FIELD]: "pocket" });
    expect(second.result.ok).toBe(true);
    const again = w.calls.slice(before);
    // Laufzeit bleibt, das Modell wird online fortgesetzt, dann die Probe
    expect(again.filter(c => c[2] === "venv" || c[2] === "pip")).toEqual([]);
    expect(again.filter(c => c[1] === "generate")).toHaveLength(1);
    expect(existsSync(join(w.pp.modelCache, "blobs", "abc.incomplete"))).toBe(false);
    expect(existsSync(w.pp.modelReady)).toBe(true);
    expect(await readJson(w.pp.proof)).toMatchObject({ version: 1, pocket: "3.3.0", voice: "juergen" });
    expect((await w.settings()).speech).toEqual({ stt: "parakeet", tts: "pocket" });
    // Danach gilt das Modell als vollständig: ein dritter Lauf lädt nichts
    const third = w.calls.length;
    await w.run({ [VOICE_FIELD]: "pocket" });
    expect(w.calls.slice(third).filter(c => c[1] === "generate")).toEqual([]);
  });

  test("ohne python3 oder mit zu altem Python: nichts geladen", async () => {
    const a = await voiceWorld({ python: null });
    await hearingReady(a.ctx);
    expect((await a.run({ [VOICE_FIELD]: "pocket" })).result.message).toContain("python3 fehlt");
    expect(a.calls.filter(c => c[2] === "venv")).toEqual([]);
    const b = await voiceWorld({ python: "3.9" });
    await hearingReady(b.ctx);
    expect((await b.run({ [VOICE_FIELD]: "pocket" })).result.message).toContain("nötig ist 3.10 bis 3.14");
    expect(b.calls.filter(c => c[2] === "venv")).toEqual([]);
  });

  test("zu wenig Platz oder Intel-Mac: nichts geladen", async () => {
    const a = await voiceWorld({ freeBytes: 900_000_000 });
    const ra = await a.run({ [VOICE_FIELD]: "pocket" });
    expect(ra.result.message).toContain("Zu wenig Platz: nötig sind ca. 1,6 GB frei");
    expect(a.calls.filter(c => c[2] === "venv")).toEqual([]);
    const b = await voiceWorld({ arch: "x64" });
    const rb = await b.run({ [VOICE_FIELD]: "pocket" });
    expect(rb.result.message).toContain("Lokale Stimmen gibt es hier nicht");
    expect(b.calls.filter(c => c[2] === "venv")).toEqual([]);
  });
});

describe("Teil Stimme: Browser, ElevenLabs, Piper direkt", () => {
  test("Browser-Stimme bei auto: nichts installiert, nichts geschrieben", async () => {
    const w = await voiceWorld();
    await hearingReady(w.ctx);
    const { result } = await w.run({});
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Vorlesen: Browser-Stimme, nichts installiert.");
    expect(w.calls).toEqual([]);
    expect((await w.settings()).speech).toEqual({ stt: "parakeet" });
  });

  test("qwen3-mlx und gemini bleiben ohne neue Eingabe: Vorauswahl beibehalten, Einstellung unverändert", async () => {
    for (const tts of ["qwen3-mlx", "gemini"]) {
      const w = await voiceWorld();
      await hearingReady(w.ctx);
      const original = { speech: { stt: "parakeet", tts, language: "de" }, other: { keep: 1 } };
      await writeFile(w.ctx.settingsPath, JSON.stringify(original));
      const before = await readFile(w.ctx.settingsPath, "utf8");
      expect((await existingFieldValues(speechStep, w.ctx))[VOICE_FIELD]).toBe("keep");
      expect(speechPlan(await existingFieldValues(speechStep, w.ctx)).join(" ")).toContain(`Vorlesen bleibt unverändert (${tts})`);
      const { result } = await w.run({});
      expect(result.ok).toBe(true);
      expect(result.message).toContain(`Vorlesen bleibt unverändert (${tts})`);
      expect(await readFile(w.ctx.settingsPath, "utf8")).toBe(before);
      expect(w.calls).toEqual([]);
    }
  });

  test("Terminal: bei qwen3-mlx nur bestätigen ändert weder Einstellung noch Anbieter für Telegram", async () => {
    const w = await voiceWorld({ env: FULL_ENV });
    await hearingReady(w.ctx);
    await writeFile(w.ctx.settingsPath, JSON.stringify({ speech: { stt: "parakeet", tts: "qwen3-mlx" } }));
    const before = await readFile(w.ctx.settingsPath, "utf8");
    const prompter = scripted(["", "", "", "", "", "", ""]);
    const r = await runWith({ mode: "step", step: "sprache" }, w.ctx, prompter);
    expect(r.code).toBe(0);
    const voiceQ = prompter.asked.find(a => a.question.includes("Stimme fürs Vorlesen"));
    expect(voiceQ).toBeDefined();
    expect(r.out).toContain("Beibehalten");
    expect(r.out).not.toContain("Vorlesen steht jetzt auf der Browser-Stimme");
    expect(await readFile(w.ctx.settingsPath, "utf8")).toBe(before);
    expect((await w.settings()).speech.tts).toBe("qwen3-mlx");
    expect(w.calls).toEqual([]);
  });

  test("ElevenLabs mit Schlüssel und Stimme: umgestellt, als Cloud benannt", async () => {
    const w = await voiceWorld({ env: "ELEVENLABS_API_KEY=k\nELEVENLABS_VOICE_ID=v\n" });
    await hearingReady(w.ctx);
    const { result } = await w.run({ [VOICE_FIELD]: "elevenlabs" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Cloud: der vorzulesende Text geht an ElevenLabs");
    expect((await w.settings()).speech.tts).toBe("elevenlabs");
    expect(w.calls).toEqual([]);
  });

  test("Piper direkt gewählt: Probe ohne getrennte Ladezeit, Nachweis, umgestellt", async () => {
    const w = await voiceWorld();
    await hearingReady(w.ctx);
    const { result } = await w.run({ [VOICE_FIELD]: "piper" });
    expect(result.ok).toBe(true);
    expect(result.message).toContain("1,0 s Ton in 0,20 s erzeugt (RTF 0,20");
    expect((await w.settings()).speech.tts).toBe("piper");
    expect(readWavInfo(await readFile(w.ip.probeWav)).ICMT).toBe(AI_GENERATED_NOTE);
    expect(readdirSync(w.ip.dir).filter(n => n.startsWith(".tmp-"))).toEqual([]);
  });

  test("Status nennt die Stimme", async () => {
    const w = await voiceWorld({ settings: JSON.stringify({ speech: { tts: "pocket" } }) });
    const items = (await speechStep.status(w.ctx)).items!;
    expect(items.find(i => i.label === "Stimme")!.detail).toBe("Pocket TTS (nicht eingerichtet)");
    expect((await speechInventory(w.ctx)).voice.tts).toBe("pocket");
  });

  test("Ablauf räumt keine fremden Dateien weg", async () => {
    const w = await voiceWorld({ pip: "fail" });
    await mkdir(w.dir, { recursive: true });
    await writeFile(join(w.dir, "eigene-datei.txt"), "bleibt");
    await w.run({ [VOICE_FIELD]: "pocket" });
    expect(existsSync(join(w.dir, "eigene-datei.txt"))).toBe(true);
    await rm(w.ctx.root, { recursive: true, force: true });
  });
});

describe("Teil Stimme im Browser (--web)", () => {
  test("Ablauf liefert die Probe als Kennung, die Datei nur angemeldet und nur unter festem Namen", async () => {
    const w = await voiceWorld();
    await hearingReady(w.ctx);
    const s = await startSetup({ ctx: w.ctx as TestCtx });
    running.push(s);
    const cookie = await login(s);
    // Ohne Probe: 404; ohne Anmeldung: 401
    expect((await get(s, "/api/setup/sprache/probe/pocket", cookie)).status).toBe(404);
    const start = await post(s, "/api/setup/steps/sprache/run", { values: { [VOICE_FIELD]: "pocket" } }, cookie);
    const { runId: id } = (await start.json()) as { runId: string };
    let data: any;
    for (let i = 0; i < 200; i++) {
      data = await (await get(s, `/api/setup/runs/${id}`, cookie)).json();
      if (data.state !== "laeuft") break;
      await Bun.sleep(10);
    }
    expect(data.state).toBe("fertig");
    expect(data.result.audio).toBe("pocket");
    expect(data.result.message).toContain("Kyutai");
    expect(data.result.message).toContain("Probe unten anhören.");
    expect(data.result.message).not.toContain("…");
    const audio = await get(s, "/api/setup/sprache/probe/pocket", cookie);
    expect(audio.status).toBe(200);
    expect(audio.headers.get("content-type")).toBe("audio/wav");
    expect(audio.headers.get("cache-control")).toBe("no-store");
    expect(readWavInfo(Buffer.from(await audio.arrayBuffer())).ICMT).toBe(AI_GENERATED_NOTE);
    expect((await get(s, "/api/setup/sprache/probe/pocket")).status).toBe(401);
    expect((await get(s, "/api/setup/sprache/probe/..%2Fparakeet", cookie)).status).toBe(404);
    expect((await get(s, "/api/setup/sprache/probe/piper", cookie)).status).toBe(404);
  });
});

describe("Teil Stimme im Browser: bestehende Wahl bleibt", () => {
  test("qwen3-mlx und gemini: Lauf ohne Stimmen-Eingabe lässt Einstellung und Telegram-Anbieter unverändert", async () => {
    for (const tts of ["qwen3-mlx", "gemini"]) {
      const w = await voiceWorld();
      await hearingReady(w.ctx);
      await writeFile(w.ctx.settingsPath, JSON.stringify({ speech: { stt: "parakeet", tts } }));
      const before = await readFile(w.ctx.settingsPath, "utf8");
      const s = await startSetup({ ctx: w.ctx as TestCtx });
      running.push(s);
      const cookie = await login(s);
      const start = await post(s, "/api/setup/steps/sprache/run", { values: {} }, cookie);
      expect(start.status).toBe(202);
      const { runId: id } = (await start.json()) as { runId: string };
      let data: any;
      for (let i = 0; i < 200; i++) {
        data = await (await get(s, `/api/setup/runs/${id}`, cookie)).json();
        if (data.state !== "laeuft") break;
        await Bun.sleep(10);
      }
      expect(data.state).toBe("fertig");
      expect(data.result.message).toContain(`Vorlesen bleibt unverändert (${tts})`);
      expect(data.result.changed).not.toContain(w.ctx.settingsPath);
      expect(await readFile(w.ctx.settingsPath, "utf8")).toBe(before);
      expect(w.calls).toEqual([]);
      await s.server.stop();
      running.splice(running.indexOf(s), 1);
    }
  });
});

describe("Gesamtprüfung und Löschen", () => {
  test("checkLocalTts: nur bei pocket oder piper, nur Dateien und Nachweis", async () => {
    const { checkLocalTts } = await import("../src/setup/speech-maintenance");
    const w = await voiceWorld();
    expect(checkLocalTts({ root: w.ctx.root, settingsText: null, envTts: undefined })).toBeNull();
    expect(checkLocalTts({ root: w.ctx.root, settingsText: JSON.stringify({ speech: { tts: "browser" } }), envTts: undefined })).toBeNull();
    const missing = checkLocalTts({ root: w.ctx.root, settingsText: null, envTts: "pocket" })!;
    expect(missing.status).toBe("fail");
    await hearingReady(w.ctx);
    await w.run({ [VOICE_FIELD]: "pocket" });
    const ok = checkLocalTts({ root: w.ctx.root, settingsText: await readFile(w.ctx.settingsPath, "utf8"), envTts: undefined })!;
    expect(ok).toMatchObject({ name: "Pocket TTS (lokale Stimme)", status: "pass" });
    expect(ok.message).toContain("Kyutai");
    // Eine expresso-Stimme in POCKET_TTS_VOICE macht die Prüfung rot
    expect(checkLocalTts({ root: w.ctx.root, settingsText: null, envTts: "pocket", pocketVoice: "cosette" })!.status).toBe("fail");
    expect(checkLocalTts({ root: w.ctx.root, settingsText: null, envTts: "piper" })!.status).toBe("fail");
  });

  test("Löschdialog nennt Pocket TTS und Piper", async () => {
    const { removeSpeechModels } = await import("../src/setup/speech-maintenance");
    const w = await voiceWorld();
    await mkdir(w.dir, { recursive: true });
    const asked: string[] = [];
    expect(await removeSpeechModels(w.ctx.root, async q => (asked.push(q), false), () => {})).toBe("behalten");
    expect(asked[0]).toContain("Pocket TTS, Piper");
  });
});

test("Ergebnis eines Ablaufs darf länger sein als Fortschritt: Hören und Stimme samt Namensnennung passen hinein", async () => {
  const { redactKnown, RUN_RESULT_MAX } = await import("../src/setup/web-server");
  expect(RUN_RESULT_MAX).toBe(1200);
  expect(redactKnown("x".repeat(1100), [], RUN_RESULT_MAX)).toHaveLength(1100);
  // Fortschritt und andere Meldungen bleiben bei 600
  expect(redactKnown("x".repeat(700), [])).toHaveLength(601);
});
