/**
 * Attrappen für „Eigene Stimme" (Issue #253): Aufnahmen als WAV, ein
 * Arbeitsordner mit eingerichteten Klon-Engines (nur Nachweis-Dateien), ein
 * Pocket-Prozess als Attrappe und Qwen3-TTS Base als Prozess-Attrappe. Kein
 * Test startet Python, lädt ein Modell oder nutzt einen Hugging-Face-Token.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Settings } from "../src/lib/settings";
import { createCloneTts, QWEN_CLONE_MLX_AUDIO, QWEN_CLONE_REVISION, qwenClonePaths } from "../src/lib/speech/clone";
import { speechDir } from "../src/lib/speech/parakeet";
import { POCKET_CLONE_REVISION, POCKET_LANGUAGE, POCKET_VERSION, pocketClonePaths, pocketPaths, type PocketChild, type PocketServerDeps } from "../src/lib/speech/pocket";
import type { RunFn } from "../src/lib/speech/process";
import { voicesDir } from "../src/lib/speech/voices";

/** PCM16-WAV mono; extra: zusätzliche Blöcke (etwa Metadaten des Browsers) */
export function recordingWav(seconds: number, opts: { rate?: number; channels?: number; bits?: number; format?: number; extra?: Buffer } = {}): Buffer {
  const rate = opts.rate ?? 24_000;
  const channels = opts.channels ?? 1;
  const bits = opts.bits ?? 16;
  const bytesPerFrame = channels * (bits / 8);
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * bytesPerFrame);
  for (let i = 0; i < frames && bits === 16; i++) data.writeInt16LE(Math.round(Math.sin(i / 10) * 3000), i * bytesPerFrame);
  const extra = opts.extra ?? Buffer.alloc(0);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "latin1");
  head.writeUInt32LE(36 + extra.length + data.length, 4);
  head.write("WAVE", 8, "latin1");
  head.write("fmt ", 12, "latin1");
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(opts.format ?? 1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * bytesPerFrame, 28);
  head.writeUInt16LE(bytesPerFrame, 32);
  head.writeUInt16LE(bits, 34);
  head.write("data", 36, "latin1");
  head.writeUInt32LE(data.length, 40);
  // extra steht zwischen fmt und data
  return Buffer.concat([head.subarray(0, 36), extra, head.subarray(36), data]);
}

/** LIST/INFO-Block mit einem Kommentar, wie ihn ein Programm anhängen könnte */
export function infoChunk(comment: string): Buffer {
  const value = Buffer.from(`${comment}\0`, "latin1");
  const padded = Buffer.concat([value, Buffer.alloc(value.length & 1)]);
  const field = Buffer.alloc(8);
  field.write("ICMT", 0, "latin1");
  field.writeUInt32LE(value.length, 4);
  const head = Buffer.alloc(12);
  head.write("LIST", 0, "latin1");
  head.writeUInt32LE(4 + 8 + padded.length, 4);
  head.write("INFO", 8, "latin1");
  return Buffer.concat([head, field, padded]);
}

export interface CloneWorldOptions {
  /** Klon-Engine Pocket eingerichtet (Nachweis-Dateien); Standard true */
  pocket?: boolean;
  /** Qwen3-TTS Base eingerichtet; Standard false */
  qwen?: boolean;
  platform?: string;
  arch?: string;
  settings?: Settings;
  /** Vorhandener Ordner einer früheren Welt (Neustart mit derselben Ablage) */
  root?: string;
  /** Einstellungen aus einer anderen Quelle (etwa der echten Datei über src/lib/settings) */
  getSettings?: () => Settings;
  /** Prozess-Start statt der Qwen-Attrappe (etwa createRunProcess mit Spawn-Attrappe) */
  run?: RunFn;
  /** Umgebung der Engines; Standard PATH, HOME und ein Schlüssel als Marker */
  env?: Record<string, string>;
}

interface FakeChild extends PocketChild {
  cmd: string[];
  killed: string[];
}

const roots: string[] = [];
export function cleanupCloneWorlds(): void {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
}

export function cloneWorld(o: CloneWorldOptions = {}) {
  const root = o.root ?? mkdtempSync(join(tmpdir(), "voice-clone-"));
  if (!o.root) roots.push(root);
  const cwd = join(root, "cwd");
  const tmp = join(root, "tmp");
  mkdirSync(tmp, { recursive: true });
  const dir = speechDir(cwd);
  const pp = pocketPaths(dir);
  const cp = pocketClonePaths(dir);
  const qp = qwenClonePaths(dir);
  if (o.pocket !== false) {
    mkdirSync(join(pp.venv, "bin"), { recursive: true });
    writeFileSync(pp.program, "#!/bin/sh\n");
    writeFileSync(pp.python, "#!/bin/sh\n");
    mkdirSync(pp.modelCache, { recursive: true });
    mkdirSync(cp.cloneCache, { recursive: true });
    writeFileSync(cp.cloneReady, "{}");
    writeFileSync(cp.cloneProof, JSON.stringify({ version: 1, pocket: POCKET_VERSION, language: POCKET_LANGUAGE, revision: POCKET_CLONE_REVISION, probe: { loadMs: 1, synthMs: 1, audioSeconds: 1, rtf: 0.1, at: "x" } }));
  }
  if (o.qwen) {
    mkdirSync(join(qp.venv, "bin"), { recursive: true });
    writeFileSync(qp.python, "#!/bin/sh\n");
    mkdirSync(qp.snapshot, { recursive: true });
    writeFileSync(qp.modelReady, "{}");
    writeFileSync(qp.proof, JSON.stringify({ version: 1, mlxAudio: QWEN_CLONE_MLX_AUDIO, revision: QWEN_CLONE_REVISION, probe: { synthMs: 1, audioSeconds: 1, rtf: 1.3, at: "x" } }));
  }

  const state = { settings: (o.settings ?? {}) as Settings };
  const children: FakeChild[] = [];
  const ttsTexts: string[] = [];
  const runCalls: { cmd: string[]; cwd?: string; env?: Record<string, string> }[] = [];
  /** Hält die nächste Pocket-Synthese an, bis release() kommt */
  let gate: { wait: Promise<void>; release: () => void } | null = null;

  const pocketDeps: PocketServerDeps = {
    spawn(cmd) {
      let resolveExit!: () => void;
      const exited = new Promise<void>(r => (resolveExit = r));
      const child: FakeChild = {
        cmd,
        killed: [],
        exited,
        kill(signal) {
          child.killed.push(signal ?? "SIGTERM");
          resolveExit();
        },
      };
      children.push(child);
      return child;
    },
    async fetch(url, init) {
      const alive = children.filter(c => c.killed.length === 0);
      if (!alive.length) throw new Error("verbindung weg");
      if (url.endsWith("/health")) return new Response("ok");
      ttsTexts.push(new URLSearchParams(String(init?.body ?? "")).get("text") ?? "");
      if (gate) {
        const g = gate;
        gate = null;
        await g.wait;
        if (!children.some(c => c.killed.length === 0)) throw new Error("verbindung weg");
      }
      return new Response(new Uint8Array(recordingWav(1)), { headers: { "content-type": "audio/wav" } });
    },
    freePort: async () => 41_000 + children.length,
    now: () => Date.now(),
    sleep: async () => {},
    setTimer: () => 0,
    clearTimer: () => {},
  };

  /** Qwen3-TTS Base als Prozess-Attrappe: schreibt das WAV, das mlx-audio schriebe */
  const fakeRun: RunFn = async (cmd, opts) => {
    runCalls.push({ cmd, ...(opts.cwd ? { cwd: opts.cwd } : {}), ...(opts.env ? { env: opts.env } : {}) });
    const prefix = cmd[cmd.indexOf("--file_prefix") + 1];
    if (opts.cwd && prefix) writeFileSync(join(opts.cwd, `${prefix}_000.wav`), recordingWav(2));
    return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
  };

  const run: RunFn = o.run ?? fakeRun;
  const settingsOf = o.getSettings ?? (() => state.settings);

  const clone = createCloneTts({
    env: () => o.env ?? { PATH: "/usr/bin", HOME: root, ANTHROPIC_API_KEY: "KEY-MARKER" },
    run,
    readFile: p => readFile(p),
    unlink: p => unlink(p),
    mkdir: async p => {
      await mkdir(p, { recursive: true });
    },
    exists: existsSync,
    cwd: () => cwd,
    tmpDir: tmp,
    unique: () => "u1",
    platform: o.platform ?? "darwin",
    arch: o.arch ?? "arm64",
    pocket: pocketDeps,
    cloneSelection: () => {
      const s = settingsOf().speech ?? {};
      return { ...(s.cloneVoice ? { voice: s.cloneVoice } : {}), ...(s.cloneEngine ? { engine: s.cloneEngine } : {}) };
    },
  });

  return {
    root,
    cwd,
    tmp,
    voices: voicesDir(cwd),
    state,
    clone,
    children,
    ttsTexts,
    runCalls,
    /** Nächste Pocket-Synthese anhalten */
    hold() {
      let release!: () => void;
      const wait = new Promise<void>(r => (release = r));
      gate = { wait, release };
      return release;
    },
    getSettings: () => state.settings,
    updateSettings: async (mutate: (s: Settings) => Settings) => {
      state.settings = mutate(state.settings);
      return state.settings;
    },
  };
}
