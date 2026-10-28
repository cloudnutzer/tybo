/**
 * Lokale Stimmen (Issue #252): Pocket TTS als Kindprozess mit Leerlauf-Ende,
 * Piper als eigener Prozess je Aufruf, Stimmen nur aus der Positivliste,
 * Qwen3-TTS mit ausgeschriebenem Sprachnamen. Nur Attrappen: kein Python,
 * kein Modell, kein Netzwerk; Dateien in einem temporären Verzeichnis.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpeech } from "../src/lib/speech/chain";
import { speechDir } from "../src/lib/speech/parakeet";
import { piperPaths, PIPER_VERSION, PIPER_VOICE } from "../src/lib/speech/piper";
import {
  createPocketServer,
  POCKET_DEFAULT_VOICE,
  POCKET_GUARD_SCRIPT,
  POCKET_IDLE_MS,
  POCKET_LANGUAGE,
  POCKET_NON_COMMERCIAL_VOICES,
  POCKET_VERSION,
  POCKET_VOICES,
  pocketPaths,
  resolvePocketVoice,
  type PocketChild,
  type PocketServerDeps,
} from "../src/lib/speech/pocket";
import type { RunResult } from "../src/lib/speech/process";
import { createTtsProviders, qwenLanguage, type ProviderDeps } from "../src/lib/speech/providers";
import { readWavInfo, AI_GENERATED_NOTE } from "../src/lib/speech/wav";
import type { Settings } from "../src/lib/settings";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** WAV wie aus pocket-tts serve: 24 kHz mono PCM16, Größen offen (Strom) */
function streamedWav(seconds = 1): Buffer {
  const data = Buffer.alloc(24_000 * 2 * seconds, 1);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(0xffffffff, 4);
  head.write("WAVE", 8, "latin1");
  head.write("fmt ", 12, "latin1");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(24_000, 24);
  head.writeUInt32LE(48_000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write("data", 36, "latin1");
  head.writeUInt32LE(0xffffffff, 40);
  return Buffer.concat([head, data]);
}

interface FakeChild extends PocketChild {
  cmd: string[];
  env: Record<string, string>;
  port: number;
  killed: string[];
  /** Simuliert Ende bzw. Absturz */
  exit(): void;
  ready: boolean;
}

interface WorldOpts {
  installed?: boolean;
  proof?: "ok" | "old" | "none";
  env?: Record<string, string | undefined>;
  settings?: Settings;
  /** Kinder, die sofort enden (etwa Port belegt), der Reihe nach */
  dieOnStart?: boolean[];
  /** Kinder, die nie bereit werden */
  neverReady?: boolean;
  piper?: boolean;
}

function world(o: WorldOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), "speech-pocket-"));
  roots.push(root);
  const cwd = join(root, "cwd");
  const tmp = join(root, "tmp");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(tmp, { recursive: true });
  const dir = speechDir(cwd);
  const paths = pocketPaths(dir);
  if (o.installed !== false) {
    mkdirSync(join(paths.venv, "bin"), { recursive: true });
    writeFileSync(paths.program, "#!/bin/sh\n");
    mkdirSync(paths.modelCache, { recursive: true });
    const proof = o.proof ?? "ok";
    if (proof !== "none") {
      writeFileSync(paths.proof, JSON.stringify({ version: 1, pocket: proof === "ok" ? POCKET_VERSION : "2.0.0", language: POCKET_LANGUAGE, voice: "juergen", probe: { loadMs: 1, synthMs: 1, audioSeconds: 1, rtf: 0.1, at: "x" } }));
    }
  }
  const pip = piperPaths(dir);
  if (o.piper) {
    mkdirSync(join(pip.venv, "bin"), { recursive: true });
    writeFileSync(pip.program, "#!/bin/sh\n");
    writeFileSync(pip.model, "onnx");
    writeFileSync(pip.config, "{}");
    writeFileSync(pip.proof, JSON.stringify({ version: 1, piper: PIPER_VERSION, voice: PIPER_VOICE, probe: { synthMs: 1, audioSeconds: 1, rtf: 0.2, at: "x" } }));
  }

  const env: Record<string, string | undefined> = { HOME: root, PATH: "/usr/bin", GEMINI_API_KEY: "KEY-MARKER-GEM", TELEGRAM_BOT_TOKEN: "TOKEN-MARKER", ...o.env };
  const children: FakeChild[] = [];
  const fetchCalls: { url: string; form?: Record<string, string> }[] = [];
  const authHeaders: (string | null)[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  const runCalls: string[][] = [];
  let clock = 0;
  let nextPort = 40_000;
  const dieQueue = [...(o.dieOnStart ?? [])];
  /** Hält die nächste Synthese an, bis release() kommt */
  let gate: { wait: Promise<void>; release: () => void } | null = null;

  const pocketDeps: PocketServerDeps = {
    spawn(cmd, opts) {
      let resolveExit!: () => void;
      const exited = new Promise<void>(r => (resolveExit = r));
      const portArg = Number(cmd[cmd.indexOf("--port") + 1]);
      const child: FakeChild = {
        cmd,
        env: opts.env,
        port: portArg,
        killed: [],
        ready: !o.neverReady,
        exited,
        kill(signal) {
          child.killed.push(signal ?? "SIGTERM");
          child.exit();
        },
        exit() {
          child.ready = false;
          resolveExit();
        },
      };
      children.push(child);
      if (dieQueue.shift()) child.exit();
      return child;
    },
    async fetch(url, init) {
      const form = typeof init?.body === "string" ? Object.fromEntries(new URLSearchParams(init.body)) : undefined;
      fetchCalls.push({ url, ...(form ? { form } : {}) });
      const headers = new Headers(init?.headers);
      authHeaders.push(headers.get("authorization"));
      const port = Number(new URL(url).port);
      const child = children.find(c => c.port === port && c.ready);
      if (!child) throw new TypeError("connection refused");
      // Wie der Wächter: nur mit dem Token dieses Starts
      if (headers.get("authorization") !== `Bearer ${child.env.TYBO_POCKET_TOKEN}`) return new Response("nicht berechtigt", { status: 401 });
      if (url.endsWith("/health")) return new Response('{"status":"healthy"}', { status: 200 });
      if (gate) await gate.wait;
      if (!child.ready) throw new TypeError("connection reset");
      return new Response(streamedWav(), { status: 200, headers: { "content-type": "audio/wav" } });
    },
    freePort: async () => nextPort++,
    now: () => clock,
    sleep: async ms => {
      clock += ms;
    },
    setTimer(fn, ms) {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer(handle) {
      (handle as { cleared: boolean }).cleared = true;
    },
  };

  const run: ProviderDeps["run"] = async cmd => {
    runCalls.push(cmd);
    const result = (r: Partial<RunResult>): RunResult => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false, ...r });
    if (cmd[0] === pip.program) {
      const out = cmd[cmd.indexOf("-f") + 1];
      writeFileSync(out, streamedWav());
      return result({});
    }
    if (cmd[0] === "ffmpeg") return result({ exitCode: 1 });
    // Qwen3-TTS: WAV unter dem Präfix
    const prefix = cmd[cmd.indexOf("--file_prefix") + 1];
    writeFileSync(join(tmp, `${prefix}_000.wav`), streamedWav());
    return result({});
  };

  const servers: { stop(): void }[] = [];
  const deps: ProviderDeps = {
    env: () => env,
    run,
    fetch: async () => {
      throw new Error("kein Netzwerk im Test");
    },
    exists: existsSync,
    which: () => null,
    readFile: path => readFile(path),
    writeFile: (path, data) => writeFile(path, data),
    unlink: path => unlink(path),
    mkdir: async path => {
      await mkdir(path, { recursive: true });
    },
    cwd: () => cwd,
    tmpDir: tmp,
    unique: () => "u1",
    pocket: pocketDeps,
    onPocketServer: s => servers.push(s),
  };
  const tts = createTtsProviders(deps);
  const logs: string[] = [];
  const speechFor = (settings: Settings) =>
    createSpeech({ stt: [], tts, getSettings: () => settings, env: () => env, log: l => logs.push(l), readFile: p => readFile(p) });
  const pocket = tts.find(p => p.id === "pocket")!;
  const piper = tts.find(p => p.id === "piper")!;
  const qwen = tts.find(p => p.id === "qwen3-mlx")!;
  return {
    root,
    tmp,
    paths,
    pip,
    env,
    children,
    fetchCalls,
    authHeaders,
    timers,
    runCalls,
    logs,
    servers,
    pocket,
    piper,
    qwen,
    speechFor,
    /** Zeitgeber auslösen, die nicht gelöscht sind */
    fireTimers() {
      for (const t of timers.splice(0)) if (!t.cleared) t.fn();
    },
    holdSynthesis() {
      let release!: () => void;
      gate = { wait: new Promise<void>(r => (release = r)), release: () => {} };
      gate.release = () => {
        release();
        gate = null;
      };
      return gate;
    },
    ttsRequests: () => fetchCalls.filter(c => c.url.endsWith("/tts")),
  };
}

describe("Pocket TTS: Stimmen", () => {
  test("Standardstimme juergen, aus CC-BY-4.0 und freigegeben", () => {
    expect(POCKET_DEFAULT_VOICE).toBe("juergen");
    expect(resolvePocketVoice("juergen")).toMatchObject({ license: "CC-BY-4.0", language: "german" });
  });

  test("keine freigegebene Stimme stammt aus expresso oder einer nicht kommerziellen Lizenz", () => {
    for (const v of Object.values(POCKET_VOICES)) {
      expect(v.source).not.toContain("expresso");
      expect(["CC0", "CC-BY-4.0"]).toContain(v.license);
      expect(POCKET_NON_COMMERCIAL_VOICES).not.toContain(v.name);
    }
    expect(POCKET_NON_COMMERCIAL_VOICES).not.toContain(POCKET_DEFAULT_VOICE);
  });

  test("expresso-Stimmen, unbekannte Namen und Adressen werden abgelehnt", () => {
    for (const name of [...POCKET_NON_COMMERCIAL_VOICES, "cosette", "alba", "marius", "hf://kyutai/tts-voices/expresso/x.wav", "https://example.org/a.wav", "toString", "__proto__", ""]) {
      expect(resolvePocketVoice(name)).toBeNull();
    }
  });

  test("POCKET_TTS_VOICE mit einer expresso-Stimme: nicht verfügbar, nichts startet", async () => {
    const w = world({ env: { POCKET_TTS_VOICE: "cosette" } });
    const avail = w.pocket.available();
    expect(avail.ok).toBe(false);
    expect(avail.reason).toContain("nicht freigegeben");
    expect(avail.reason).not.toContain("cosette");
    const result = await w.speechFor({ speech: { tts: "pocket" } }).synthesizeSpeech("Hallo");
    expect(result).toEqual({ ok: false, reason: "unavailable" });
    expect(w.children).toHaveLength(0);
  });

  test("Stimme je Anfrage: cosette und unbekannte abgelehnt, ohne Prozess und ohne Anfrage", async () => {
    const w = world();
    const speech = w.speechFor({ speech: { tts: "pocket" } });
    for (const voice of ["cosette", "alba", "unbekannt"]) {
      expect(await speech.synthesizeSpeech("Hallo", { voice })).toEqual({ ok: false, reason: "voice" });
    }
    expect(w.children).toHaveLength(0);
    expect(w.fetchCalls).toHaveLength(0);
    // Auch am Anbieter selbst vorbei an der Kette: abgelehnt
    await expect(w.pocket.synthesize("Hallo", { voice: "cosette" })).rejects.toThrow("unavailable");
    expect(w.children).toHaveLength(0);
  });
});

describe("Pocket TTS: Verfügbarkeit", () => {
  test("ohne Installation, ohne Nachweis oder mit alter Version nicht verfügbar; available() startet nichts", () => {
    expect(world({ installed: false }).pocket.available()).toMatchObject({ ok: false });
    expect(world({ proof: "none" }).pocket.available()).toMatchObject({ ok: false });
    expect(world({ proof: "old" }).pocket.available()).toMatchObject({ ok: false });
    const w = world();
    expect(w.pocket.available()).toEqual({ ok: true });
    expect(w.children).toHaveLength(0);
    expect(w.fetchCalls).toHaveLength(0);
  });

  test("Einstellungsseite: Name, lokal, Namensnennung Kyutai", () => {
    const w = world();
    const opt = w.speechFor({}).options().tts.find(t => t.id === "pocket")!;
    expect(opt).toMatchObject({ label: "Pocket TTS (Kyutai)", local: true, where: "server", available: true });
    expect(opt.note).toContain("Kyutai");
    expect(opt.note).toContain("CC-BY-4.0");
  });
});

describe("Pocket TTS: Kindprozess", () => {
  test("startet erst beim ersten Aufruf, mit 127.0.0.1, freiem Port, german und juergen", async () => {
    const w = world();
    expect(w.children).toHaveLength(0);
    const speech = w.speechFor({ speech: { tts: "pocket" } });
    expect(w.children).toHaveLength(0);
    const result = await speech.synthesizeSpeech("Hallo Welt");
    expect(result).toMatchObject({ ok: true, mime: "audio/wav", provider: "pocket" });
    expect(w.children).toHaveLength(1);
    const c = w.children[0];
    // Wächter statt pocket-tts serve: Python des venv, isoliert, Stimme beim Start
    expect(c.cmd).toEqual([w.paths.python, "-I", POCKET_GUARD_SCRIPT, "--port", "40000", "--language", "german", "--voice", "juergen"]);
    expect(existsSync(POCKET_GUARD_SCRIPT)).toBe(true);
    // Offline und ohne Schlüssel des Bots; nur das Token dieses Starts
    expect(c.env.HF_HUB_OFFLINE).toBe("1");
    expect(c.env.HF_HOME).toBe(w.paths.hfHome);
    expect(JSON.stringify(c.env)).not.toContain("MARKER");
    expect(c.env.TYBO_POCKET_TOKEN).toMatch(/^[0-9a-f]{64}$/);
    // Synthese als Formular nur mit text (keine Stimme je Anfrage), mit Token
    expect(w.ttsRequests()).toEqual([{ url: "http://127.0.0.1:40000/tts", form: { text: "Hallo Welt" } }]);
    expect(w.authHeaders.every(h => h === `Bearer ${c.env.TYBO_POCKET_TOKEN}`)).toBe(true);
  });

  test("WAV trägt den Hinweis KI-generiert, die offene Größe ist berichtigt", async () => {
    const w = world();
    const result = await w.speechFor({ speech: { tts: "pocket" } }).synthesizeSpeech("Hallo");
    if (!result.ok) throw new Error("erwartet ok");
    expect(readWavInfo(result.audio).ICMT).toBe(AI_GENERATED_NOTE);
    const dataSize = result.audio.readUInt32LE(40);
    expect(dataSize).toBe(24_000 * 2);
  });

  test("gleichzeitige erste Aufrufe starten nur einen Prozess", async () => {
    const w = world();
    const speech = w.speechFor({ speech: { tts: "pocket" } });
    const all = await Promise.all([speech.synthesizeSpeech("Eins"), speech.synthesizeSpeech("Zwei"), speech.synthesizeSpeech("Drei")]);
    expect(all.every(r => r.ok)).toBe(true);
    expect(w.children).toHaveLength(1);
    expect(w.ttsRequests()).toHaveLength(3);
  });

  test("endet nach 10 Minuten ohne Aufruf; der nächste Aufruf startet neu", async () => {
    const w = world();
    const speech = w.speechFor({ speech: { tts: "pocket" } });
    await speech.synthesizeSpeech("Hallo");
    const idle = w.timers.filter(t => !t.cleared);
    expect(idle).toHaveLength(1);
    expect(idle[0].ms).toBe(POCKET_IDLE_MS);
    expect(POCKET_IDLE_MS).toBe(600_000);
    expect(w.children[0].killed).toEqual([]);
    w.fireTimers();
    expect(w.children[0].killed).toEqual(["SIGTERM"]);
    await speech.synthesizeSpeech("Noch mal");
    expect(w.children).toHaveLength(2);
  });

  test("ein neuer Aufruf schiebt das Leerlauf-Ende hinaus", async () => {
    const w = world();
    const speech = w.speechFor({ speech: { tts: "pocket" } });
    await speech.synthesizeSpeech("Eins");
    const first = w.timers[0];
    await speech.synthesizeSpeech("Zwei");
    expect(first.cleared).toBe(true);
    expect(w.timers.filter(t => !t.cleared)).toHaveLength(1);
    expect(w.children).toHaveLength(1);
  });

  test("eine laufende Synthese wird nicht wegen Leerlauf beendet", async () => {
    const w = world();
    const speech = w.speechFor({ speech: { tts: "pocket" } });
    await speech.synthesizeSpeech("Eins");
    const gate = w.holdSynthesis();
    const running = speech.synthesizeSpeech("Lang");
    await Bun.sleep(5);
    // Während der Synthese ist kein Leerlauf-Zeitgeber aktiv
    expect(w.timers.filter(t => !t.cleared)).toHaveLength(0);
    w.fireTimers();
    expect(w.children[0].killed).toEqual([]);
    gate.release();
    expect((await running).ok).toBe(true);
    expect(w.timers.filter(t => !t.cleared)).toHaveLength(1);
  });

  test("Absturz zwischen zwei Aufrufen: der nächste startet einen neuen Prozess", async () => {
    const w = world();
    const speech = w.speechFor({ speech: { tts: "pocket" } });
    await speech.synthesizeSpeech("Eins");
    w.children[0].exit();
    await Bun.sleep(1);
    const r = await speech.synthesizeSpeech("Zwei");
    expect(r.ok).toBe(true);
    expect(w.children).toHaveLength(2);
    expect(w.children[1].port).not.toBe(w.children[0].port);
  });

  test("Absturz während der Anfrage: einmal neu gestartet, dann geliefert", async () => {
    const w = world();
    const speech = w.speechFor({ speech: { tts: "pocket" } });
    await speech.synthesizeSpeech("Eins");
    const gate = w.holdSynthesis();
    const p = speech.synthesizeSpeech("Zwei");
    await Bun.sleep(5);
    w.children[0].exit();
    gate.release();
    const r = await p;
    expect(r.ok).toBe(true);
    expect(w.children).toHaveLength(2);
  });

  test("Port belegt (Prozess endet sofort): zweiter Versuch mit neuem Port", async () => {
    const w = world({ dieOnStart: [true] });
    const r = await w.speechFor({ speech: { tts: "pocket" } }).synthesizeSpeech("Hallo");
    expect(r.ok).toBe(true);
    expect(w.children.map(c => c.port)).toEqual([40000, 40001]);
  });

  test("startet zweimal nicht: Fehler ohne Text im Log, der nächste Aufruf versucht es neu", async () => {
    const w = world({ dieOnStart: [true, true] });
    const speech = w.speechFor({ speech: { tts: "pocket" } });
    expect(await speech.synthesizeSpeech("GEHEIMER-TEXT")).toEqual({ ok: false, reason: "failed" });
    expect(w.logs.join("\n")).toContain("Sprechen pocket: Fehler (Exit-Code ?)");
    expect(w.logs.join("\n")).not.toContain("GEHEIMER-TEXT");
    const again = await speech.synthesizeSpeech("Hallo");
    expect(again.ok).toBe(true);
    expect(w.children).toHaveLength(3);
  });

  test("wird nie bereit: nach der Frist beendet, Zeitlimit", async () => {
    const w = world({ neverReady: true });
    const r = await w.speechFor({ speech: { tts: "pocket" } }).synthesizeSpeech("Hallo");
    expect(r).toEqual({ ok: false, reason: "failed" });
    expect(w.logs.join("\n")).toContain("Zeitlimit");
    expect(w.children[0].killed).toEqual(["SIGTERM"]);
  });

  test("stop() beendet den eigenen Prozess (Ende des Bots)", async () => {
    const w = world();
    await w.speechFor({ speech: { tts: "pocket" } }).synthesizeSpeech("Hallo");
    expect(w.servers).toHaveLength(1);
    w.servers[0].stop();
    expect(w.children[0].killed).toEqual(["SIGTERM"]);
  });

  /** Kind, dessen Bereitschaft erst nach release() kommt (auch wenn es schon beendet wurde: verspätete Antwort) */
  function slowStart() {
    const root = mkdtempSync(join(tmpdir(), "speech-pocket-slow-"));
    roots.push(root);
    const paths = pocketPaths(speechDir(root));
    const spawned: string[][] = [];
    const kills: string[] = [];
    let release!: () => void;
    const ready = new Promise<void>(r => (release = r));
    const deps: PocketServerDeps = {
      spawn(cmd) {
        spawned.push(cmd);
        return { exited: new Promise(() => {}), kill: s => void kills.push(String(s)) };
      },
      async fetch(url) {
        if (url.endsWith("/health")) {
          await ready;
          return new Response("{}", { status: 200 });
        }
        return new Response(streamedWav(), { status: 200 });
      },
      freePort: async () => 40500,
      now: () => 0,
      sleep: async () => {},
      setTimer: () => 0,
      clearTimer: () => {},
    };
    const server = createPocketServer({ paths, env: () => ({}), deps });
    return { server, spawned, kills, release };
  }

  test("stop() vor der Bereitschaft beendet das startende Kind; verspätete Bereitschaft startet nichts", async () => {
    const w = slowStart();
    const p = w.server.synthesize("Hallo", "juergen");
    const settled = p.then(
      () => "ok",
      e => String(e),
    );
    await Bun.sleep(5);
    expect(w.spawned).toHaveLength(1);
    expect(w.server.children()).toBe(1);
    expect(w.server.isRunning()).toBe(false);
    w.server.stop();
    expect(w.kills).toEqual(["SIGTERM"]);
    expect(w.server.children()).toBe(0);
    // Bereitschaft kommt erst jetzt: gilt nicht mehr, kein zweiter Start
    w.release();
    expect(await settled).toContain("exit");
    await Bun.sleep(5);
    expect(w.server.isRunning()).toBe(false);
    expect(w.spawned).toHaveLength(1);
    expect(w.kills).toEqual(["SIGTERM"]);
  });

  test("Abbruch der Einrichtung während warmUp beendet den startenden Prozess", async () => {
    const w = slowStart();
    const controller = new AbortController();
    const p = w.server.warmUp("juergen", controller.signal).then(
      () => "ok",
      e => String(e),
    );
    await Bun.sleep(5);
    expect(w.server.children()).toBe(1);
    controller.abort();
    expect(w.kills).toEqual(["SIGTERM"]);
    w.release();
    expect(await p).not.toBe("ok");
    await Bun.sleep(5);
    expect(w.server.isRunning()).toBe(false);
    expect(w.server.children()).toBe(0);
    expect(w.spawned).toHaveLength(1);
  });

  test("nach stop() startet ein neuer Aufruf wieder normal", async () => {
    const w = slowStart();
    w.release();
    await w.server.synthesize("Eins", "juergen");
    w.server.stop();
    expect(w.server.isRunning()).toBe(false);
    await w.server.synthesize("Zwei", "juergen");
    expect(w.server.isRunning()).toBe(true);
    expect(w.spawned).toHaveLength(2);
  });

  test("Telegram-Kette (auto) nutzt Pocket nie still", async () => {
    const w = world();
    await w.speechFor({}).synthesizeServer("Hallo");
    expect(w.children).toHaveLength(0);
  });
});

describe("Piper", () => {
  test("eigener Prozess je Aufruf, Text als Datei, Temp-Dateien gelöscht", async () => {
    const w = world({ installed: false, piper: true });
    expect(w.piper.available()).toEqual({ ok: true });
    const r = await w.speechFor({ speech: { tts: "piper" } }).synthesizeSpeech("Hallo\nWelt");
    expect(r).toMatchObject({ ok: true, mime: "audio/wav", provider: "piper" });
    const cmd = w.runCalls[0];
    expect(cmd.slice(0, 5)).toEqual([w.pip.program, "-m", w.pip.model, "-c", w.pip.config]);
    expect(cmd).not.toContain("Hallo\nWelt");
    expect(readdirSync(w.tmp)).toEqual([]);
    if (r.ok) expect(readWavInfo(r.audio).ICMT).toBe(AI_GENERATED_NOTE);
  });

  test("ohne Einrichtung nicht verfügbar; Stimme je Anfrage abgelehnt", async () => {
    expect(world({ installed: false }).piper.available()).toMatchObject({ ok: false });
    const w = world({ installed: false, piper: true });
    expect(await w.speechFor({ speech: { tts: "piper" } }).synthesizeSpeech("Hallo", { voice: "andere" })).toEqual({ ok: false, reason: "voice" });
    expect(w.runCalls).toHaveLength(0);
  });

  test("Einstellungsseite: Namensnennung mit GPL-3.0 und CC0", () => {
    const opt = world({ installed: false, piper: true }).speechFor({}).options().tts.find(t => t.id === "piper")!;
    expect(opt.note).toContain("GPL-3.0");
    expect(opt.note).toContain("CC0");
  });
});

describe("Qwen3-TTS: Sprache als Name für mlx-audio", () => {
  test("Kürzel und Namen, unbekannt wird auto", () => {
    expect(qwenLanguage("de")).toBe("german");
    expect(qwenLanguage("DE")).toBe("german");
    expect(qwenLanguage("german")).toBe("german");
    expect(qwenLanguage("en")).toBe("english");
    expect(qwenLanguage("English")).toBe("english");
    expect(qwenLanguage("auto")).toBe("auto");
    expect(qwenLanguage("xx")).toBe("auto");
    expect(qwenLanguage("klingonisch")).toBe("auto");
    expect(qwenLanguage(undefined)).toBe("auto");
  });

  const qwenWorld = (o: WorldOpts) => {
    const w = world({ ...o, installed: false });
    const python = join(w.root, "python");
    writeFileSync(python, "p");
    w.env.LOCAL_TTS_PYTHON = python;
    return w;
  };
  const langArg = (w: ReturnType<typeof world>) => {
    const cmd = w.runCalls.find(c => c.includes("--lang_code"))!;
    return cmd[cmd.indexOf("--lang_code") + 1];
  };

  test("LOCAL_TTS_LANG=de: mlx-audio bekommt german", async () => {
    const w = qwenWorld({ env: { LOCAL_TTS_LANG: "de" } });
    await w.speechFor({}).synthesizeServer("Hallo");
    expect(langArg(w)).toBe("german");
  });

  test("ohne LOCAL_TTS_LANG (Standard de): german", async () => {
    const w = qwenWorld({});
    await w.speechFor({}).synthesizeServer("Hallo");
    expect(langArg(w)).toBe("german");
  });

  test("LOCAL_TTS_LANG=german bleibt german, unbekannt wird auto", async () => {
    const a = qwenWorld({ env: { LOCAL_TTS_LANG: "german" } });
    await a.speechFor({}).synthesizeServer("Hallo");
    expect(langArg(a)).toBe("german");
    const b = qwenWorld({ env: { LOCAL_TTS_LANG: "xx" } });
    await b.speechFor({}).synthesizeServer("Hallo");
    expect(langArg(b)).toBe("auto");
  });

  test("speech.language=de aus den Einstellungen wird ebenfalls abgebildet", async () => {
    const w = qwenWorld({ env: { LOCAL_TTS_LANG: "en" } });
    await w.speechFor({ speech: { language: "de" } }).synthesizeServer("Hallo");
    expect(langArg(w)).toBe("german");
  });
});

describe("ElevenLabs-Stimme als Anbieter-Einstellung", () => {
  function elevenWorld(env: Record<string, string | undefined>) {
    const urls: string[] = [];
    const deps: ProviderDeps = {
      env: () => env,
      run: async () => {
        throw new Error("kein Prozess");
      },
      fetch: async url => {
        urls.push(url);
        return new Response(Buffer.from("ID3-mp3"), { status: 200 });
      },
      exists: () => false,
      which: () => null,
      readFile: path => readFile(path),
      writeFile: async () => {},
      unlink: async () => {},
      mkdir: async () => {},
      cwd: () => "/nicht/da",
      tmpDir: "/nicht/da",
      unique: () => "u",
    };
    const tts = createTtsProviders(deps);
    const speech = (settings: Settings) => createSpeech({ stt: [], tts, getSettings: () => settings, env: () => env, log: () => {}, readFile: p => readFile(p) });
    return { tts, urls, speech };
  }

  test("wählbar nur mit ELEVENLABS_API_KEY und ELEVENLABS_VOICE_ID, als Cloud gekennzeichnet", () => {
    const none = elevenWorld({}).speech({}).options().tts.find(t => t.id === "elevenlabs")!;
    expect(none).toMatchObject({ available: false, reason: "ELEVENLABS_API_KEY fehlt" });
    const noVoice = elevenWorld({ ELEVENLABS_API_KEY: "KEY-MARKER" }).speech({}).options().tts.find(t => t.id === "elevenlabs")!;
    expect(noVoice).toMatchObject({ available: false, reason: "ELEVENLABS_VOICE_ID fehlt" });
    const both = elevenWorld({ ELEVENLABS_API_KEY: "KEY-MARKER", ELEVENLABS_VOICE_ID: "stimme-a" }).speech({}).options().tts.find(t => t.id === "elevenlabs")!;
    // local: false ergibt im Reiter „Sprechen" den Hinweis „Cloud: Text geht an ElevenLabs."
    expect(both).toEqual({ id: "elevenlabs", label: "ElevenLabs", local: false, where: "server", available: true });
    expect(JSON.stringify(both)).not.toContain("KEY-MARKER");
  });

  test("Stimme aus ELEVENLABS_VOICE_ID, eine Stimme je Aufruf geht vor", async () => {
    const w = elevenWorld({ ELEVENLABS_API_KEY: "KEY-MARKER", ELEVENLABS_VOICE_ID: "stimme-a" });
    const speech = w.speech({ speech: { tts: "elevenlabs" } });
    expect(await speech.synthesizeSpeech("Hallo")).toMatchObject({ ok: true, mime: "audio/mpeg", provider: "elevenlabs" });
    expect(await speech.synthesizeSpeech("Hallo", { voice: "stimme-b" })).toMatchObject({ ok: true });
    expect(w.urls).toEqual(["https://api.elevenlabs.io/v1/text-to-speech/stimme-a", "https://api.elevenlabs.io/v1/text-to-speech/stimme-b"]);
  });

  test("ELEVENLABS_VOICE_ID ist auf der Schlüssel-Seite pflegbar", async () => {
    const { KEY_CATALOG } = await import("../src/web/key-catalog");
    const entry = KEY_CATALOG.find(e => e.name === "ELEVENLABS_VOICE_ID");
    expect(entry).toMatchObject({ group: "Dienste", editable: true });
  });
});
