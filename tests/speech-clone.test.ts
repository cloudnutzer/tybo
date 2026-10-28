/**
 * Issue #253, Checkbox 2: Vorlesen mit einer eigenen Stimme
 * (src/lib/speech/clone.ts) über Pocket TTS mit Klon-Gewichten und
 * Qwen3-TTS Base, beide mit Prozess-Attrappen. Dazu die Kette: nur im
 * Sprechmodus, nie in Telegram; jede Ausgabe gekennzeichnet.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSpeech } from "../src/lib/speech/chain";
import { qwenClonePaths } from "../src/lib/speech/clone";
import { speechDir } from "../src/lib/speech/parakeet";
import { POCKET_GUARD_SCRIPT, pocketClonePaths, pocketServeCommand, pocketPaths } from "../src/lib/speech/pocket";
import { createRunProcess, type SpawnFn } from "../src/lib/speech/process";
import { runFnFromContext } from "../src/setup/parakeet-probe";
import type { SetupContext } from "../src/setup/context";
import type { TtsProvider } from "../src/lib/speech/types";
import { AI_CLONED_NOTE, readWavInfo } from "../src/lib/speech/wav";
import { cleanupCloneWorlds, cloneWorld, recordingWav, type CloneWorldOptions } from "./voice-clone-fixture";

afterEach(() => cleanupCloneWorlds());

async function withVoice(o: CloneWorldOptions = {}) {
  const w = cloneWorld(o);
  const r = await w.clone.voices().create({ name: "Mia", consent: true, device: "Chrome auf macOS", audio: recordingWav(8) });
  if (!r.ok) throw new Error("Stimme erwartet");
  return { ...w, id: r.voice.id };
}

/** Kette mit dem Klon-Anbieter und einer Server-Stimme für Telegram */
function chain(w: ReturnType<typeof cloneWorld>) {
  const gemini: TtsProvider & { calls: number } = {
    id: "gemini",
    label: "Gemini",
    local: false,
    where: "server",
    calls: 0,
    available: () => ({ ok: true }),
    async synthesize() {
      gemini.calls++;
      return { audio: recordingWav(1), mime: "audio/wav" };
    },
  };
  const logs: string[] = [];
  const speech = createSpeech({ stt: [], tts: [gemini, w.clone.provider], getSettings: w.getSettings, env: () => ({}), log: l => logs.push(l), readFile: async () => Buffer.alloc(0) });
  return { speech, gemini, logs };
}

describe("Pocket TTS mit Klon-Gewichten", () => {
  test("Befehl des Wächters: Ordner der Stimmen und geprüfte Kennung statt Katalogstimme", () => {
    const pp = pocketPaths("/x/models/speech");
    expect(pocketServeCommand(pp, 4000, "clone:0123456789abcdef", "/x/data/speech/voices")).toEqual([
      pp.python, "-I", POCKET_GUARD_SCRIPT, "--port", "4000", "--language", "german", "--clone-dir", "/x/data/speech/voices", "--clone-id", "0123456789abcdef",
    ]);
    expect(() => pocketServeCommand(pp, 4000, "clone:0123456789abcdef")).toThrow();
    expect(pocketServeCommand(pp, 4000, "clone:../x", "/v")).toContain("--voice");
  });

  test("Probe: WAV mit Kennzeichnung, Prozess startet nur mit der Kennung", async () => {
    const w = await withVoice();
    const r = await w.clone.probe(w.id, "Hallo.");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.engine).toBe("pocket");
    expect(readWavInfo(r.audio).ICMT).toBe(AI_CLONED_NOTE);
    expect(w.children[0]!.cmd.slice(-4)).toEqual(["--clone-dir", w.voices, "--clone-id", w.id]);
    expect(w.ttsTexts).toEqual(["Hallo."]);
  });

  test("ohne Nachweis der Klon-Probe ist Pocket keine Klon-Engine", async () => {
    const w = await withVoice();
    unlinkSync(pocketClonePaths(speechDir(w.cwd)).cloneProof);
    expect(w.clone.engineStatus()).toMatchObject({ ready: false });
    expect(await w.clone.probe(w.id, "Hallo.")).toEqual({ ok: false, reason: "engine" });
    expect(w.children).toEqual([]);
  });

  test("Vergessen beendet den Prozess mit dieser Stimme; danach keine Ausgabe ohne Ablage", async () => {
    const w = await withVoice();
    expect((await w.clone.probe(w.id, "a")).ok).toBe(true);
    w.clone.forget(w.id);
    expect(w.children[0]!.killed).toEqual(["SIGTERM"]);
    await w.clone.voices().remove(w.id);
    expect(await w.clone.probe(w.id, "a")).toEqual({ ok: false, reason: "unbekannt" });
    expect(w.children).toHaveLength(1);
  });
});

describe("Qwen3-TTS Base (Prozess-Attrappe)", () => {
  test("Befehl offline mit Referenz, Referenztext und fester Revision; keine Schlüssel in der Umgebung", async () => {
    const w = await withVoice({ pocket: false, qwen: true });
    const r = await w.clone.probe(w.id, "-Hallo");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.engine).toBe("qwen3-base");
    expect(readWavInfo(r.audio).ICMT).toBe(AI_CLONED_NOTE);
    const call = w.runCalls[0]!;
    const qp = qwenClonePaths(speechDir(w.cwd));
    expect(call.cmd.slice(0, 4)).toEqual([qp.python, "-I", "-m", "mlx_audio.tts.generate"]);
    expect(call.cmd[call.cmd.indexOf("--model") + 1]).toBe(qp.snapshot);
    expect(call.cmd[call.cmd.indexOf("--ref_audio") + 1]).toBe(join(w.voices, w.id, "reference.wav"));
    expect(call.cmd).toContain("--text=-Hallo");
    expect(call.cmd.find(c => c.startsWith("--ref_text="))).toStartWith("--ref_text=Heute ist ein ruhiger Morgen.");
    expect(call.cmd[call.cmd.indexOf("--lang_code") + 1]).toBe("german");
    expect(call.env).toMatchObject({ HF_HOME: qp.hfHome, HF_HUB_OFFLINE: "1" });
    expect(JSON.stringify(call.env)).not.toContain("KEY-MARKER");
    // Temp-Datei aufgeräumt
    expect((await import("node:fs")).readdirSync(w.tmp)).toEqual([]);
  });

  test("am Spawn-Übergang: nur die freigegebene Umgebung, ohne process.env und Schlüssel des Bots", async () => {
    const spawned: Parameters<SpawnFn>[0][] = [];
    const spawn: SpawnFn = o => {
      spawned.push(o);
      const prefix = o.cmd[o.cmd.indexOf("--file_prefix") + 1];
      if (o.cwd && prefix) writeFileSync(join(o.cwd, `${prefix}_000.wav`), recordingWav(2));
      return { stdout: new Response("").body!, stderr: new Response("").body!, exited: Promise.resolve(0), kill: () => {} };
    };
    // Synthetische Schlüssel in der Umgebung des Bots (Marker, keine echten Werte)
    const marker = "SYNTHETIC-BOT-SECRET";
    const before = { ...process.env };
    process.env.TELEGRAM_BOT_TOKEN = marker;
    process.env.ANTHROPIC_API_KEY = marker;
    process.env.WEB_PASSWORD = marker;
    process.env.TYBO_TEST_ONLY_KEY = marker;
    try {
      const w = await withVoice({
        pocket: false,
        qwen: true,
        run: createRunProcess(spawn),
        env: { PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/home/x", LANG: "de_DE.UTF-8", TELEGRAM_BOT_TOKEN: marker, OPENAI_API_KEY: marker, SUPABASE_SERVICE_ROLE_KEY: marker },
      });
      const r = await w.clone.probe(w.id, "Hallo");
      expect(r.ok).toBe(true);
      expect(spawned).toHaveLength(1);
      const env = spawned[0]!.env!;
      const qp = qwenClonePaths(speechDir(w.cwd));
      expect(env).toMatchObject({ PATH: "/opt/homebrew/bin:/usr/bin", HOME: "/home/x", LANG: "de_DE.UTF-8", HF_HOME: qp.hfHome, HF_HUB_OFFLINE: "1", HF_HUB_DISABLE_TELEMETRY: "1" });
      expect(JSON.stringify(env)).not.toContain(marker);
      for (const name of ["TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "WEB_PASSWORD", "TYBO_TEST_ONLY_KEY", "OPENAI_API_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) expect(env[name]).toBeUndefined();
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
      Object.assign(process.env, before);
    }
  });

  test("ohne replaceEnv ergänzt runProcess die Umgebung wie bisher (andere Anbieter)", async () => {
    const spawned: Parameters<SpawnFn>[0][] = [];
    const spawn: SpawnFn = o => {
      spawned.push(o);
      return { stdout: new Response("").body!, stderr: new Response("").body!, exited: Promise.resolve(0), kill: () => {} };
    };
    await createRunProcess(spawn)(["x"], { timeoutMs: 1000, env: { EXTRA: "1" } });
    expect(spawned[0]!.env).toMatchObject({ EXTRA: "1", PATH: process.env.PATH });
  });

  test("Einrichtung (runFnFromContext): replaceEnv reicht nur die freigegebene Umgebung weiter", async () => {
    const seen: (Record<string, string> | undefined)[] = [];
    const ctx = { run: async (_cmd: string[], o: { env?: Record<string, string> }) => (seen.push(o.env), { code: 0, stdout: "", stderr: "" }) } as unknown as SetupContext;
    const run = runFnFromContext(ctx);
    await run(["x"], { timeoutMs: 1000, env: { PATH: "/usr/bin", HF_HUB_OFFLINE: "1" }, replaceEnv: true });
    await run(["x"], { timeoutMs: 1000, env: { EXTRA: "1" } });
    expect(seen[0]).toEqual({ PATH: "/usr/bin", HF_HUB_OFFLINE: "1" });
    expect(seen[1]).toMatchObject({ EXTRA: "1", PATH: process.env.PATH });
  });

  test("nur auf dem Mac mit Apple Silicon", async () => {
    const w = await withVoice({ pocket: false, qwen: true, platform: "linux", arch: "x64" });
    expect(w.clone.engineStatus().ready).toBe(false);
    expect(await w.clone.probe(w.id, "a")).toEqual({ ok: false, reason: "engine" });
    expect(w.runCalls).toEqual([]);
  });

  test("Wahl der Engine: speech.cloneEngine, wenn eingerichtet, sonst die erste eingerichtete", async () => {
    const w = await withVoice({ pocket: true, qwen: true });
    expect(w.clone.activeEngine()?.id).toBe("pocket");
    w.state.settings = { speech: { cloneEngine: "qwen3-base" } };
    expect(w.clone.activeEngine()?.id).toBe("qwen3-base");
    unlinkSync(qwenClonePaths(speechDir(w.cwd)).proof);
    expect(w.clone.activeEngine()?.id).toBe("pocket");
  });
});

describe("Kette: eigene Stimme nur im Sprechmodus", () => {
  test("Sprechmodus mit gewählter Stimme: WAV mit „KI-generiert, geklonte Stimme\"", async () => {
    const w = await withVoice({ settings: {} });
    w.state.settings = { speech: { tts: "clone", cloneVoice: w.id } };
    const { speech } = chain(w);
    const r = await speech.synthesizeSpeech("Guten Morgen.");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.provider).toBe("clone");
    expect(r.mime).toBe("audio/wav");
    expect(readWavInfo(r.audio).ICMT).toBe(AI_CLONED_NOTE);
    expect(speech.localMode().tts).toMatchObject({ id: "clone", label: "Mia (KI-Stimme)", available: true });
  });

  test("Telegram und /voice übernehmen die Auswahl nie: Server-Kette statt eigener Stimme", async () => {
    const w = await withVoice();
    w.state.settings = { speech: { tts: "clone", cloneVoice: w.id } };
    const { speech, gemini } = chain(w);
    const audio = await speech.synthesizeServer("Hallo Telegram");
    expect(audio).not.toBeNull();
    expect(gemini.calls).toBe(1);
    expect(w.ttsTexts).toEqual([]);
    expect(w.children).toEqual([]);
    expect(readWavInfo(audio!).ICMT).toBeUndefined();
  });

  test("keine andere Stimme je Aufruf", async () => {
    const w = await withVoice();
    w.state.settings = { speech: { tts: "clone", cloneVoice: w.id } };
    const { speech } = chain(w);
    expect(await speech.synthesizeSpeech("a", { voice: "juergen" })).toEqual({ ok: false, reason: "voice" });
    expect(w.children).toEqual([]);
  });

  test("ohne gewählte Stimme oder ohne Einwilligung: nicht verfügbar, nichts erzeugt", async () => {
    const w = await withVoice();
    w.state.settings = { speech: { tts: "clone" } };
    const { speech } = chain(w);
    expect(await speech.synthesizeSpeech("a")).toEqual({ ok: false, reason: "unavailable" });
    w.state.settings = { speech: { tts: "clone", cloneVoice: w.id } };
    unlinkSync(join(w.voices, w.id, "consent.json"));
    expect(await speech.synthesizeSpeech("a")).toEqual({ ok: false, reason: "unavailable" });
    expect(speech.localMode().tts).toMatchObject({ id: "clone", available: false, label: "Eigene Stimme (KI-Stimme)" });
    expect(w.children).toEqual([]);
  });

  test("Anzeige in der Auswahl: „<Name> (KI-Stimme)\"", async () => {
    const w = await withVoice();
    w.state.settings = { speech: { cloneVoice: w.id } };
    const { speech } = chain(w);
    expect(speech.options().tts.find(t => t.id === "clone")).toMatchObject({ label: "Mia (KI-Stimme)", available: true, where: "server" });
  });
});
