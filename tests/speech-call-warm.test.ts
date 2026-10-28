/**
 * Erkenner und Stimme im Dauerbetrieb für den Telefonhörer (Issue #257,
 * Checkbox 3): warm() für Parakeet mit Prozess-Attrappe, gestreamte
 * Synthese für Pocket mit Fetch-Attrappe, PCM-Helfer, Anbieterwahl. Kein
 * sherpa-onnx, kein Pocket TTS.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildProof, parakeetPaths, speechDir } from "../src/lib/speech/parakeet";
import { capiLibrary, PARAKEET_WORKER_SCRIPT, sherpaPcm, startParakeetWarm, type WarmProc, type WarmSpawn } from "../src/lib/speech/parakeet-warm";
import { RECOGNIZER_CONFIG } from "../src/lib/speech/parakeet_worker";
import { createWavStreamParser, pcmToWav, resamplePcm16, wavToPcm } from "../src/lib/speech/pcm";
import { createPocketServer, pocketPaths, POCKET_LANGUAGE, POCKET_VERSION, type PocketChild, type PocketServerDeps } from "../src/lib/speech/pocket";
import { createSpeech } from "../src/lib/speech/chain";
import { createSttProviders, createTtsProviders, type ProviderDeps } from "../src/lib/speech/providers";
import { SpeechError, type SttProvider, type TtsProvider } from "../src/lib/speech/types";
import type { Settings } from "../src/lib/settings";
import { statFile } from "../src/setup/steps/speech";
import { placeFiles } from "./parakeet-fixture";
import { gate } from "./call-fixture";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Erkennungsprozess-Attrappe: liest Rahmen von stdin, antwortet je Rahmen
// ---------------------------------------------------------------------------

interface FakeWorker extends WarmProc {
  cmd: string[];
  env: Record<string, string>;
  frames: number[];
  killed: boolean;
  ready(): void;
  answer(text: string): void;
  crash(): void;
}

function workerSpawn(o: { autoReady?: boolean; autoAnswer?: (frameBytes: number, n: number) => string | null } = {}) {
  const spawned: FakeWorker[] = [];
  const spawn: WarmSpawn = (cmd, env) => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let resolveExit!: (code: number | null) => void;
    let pending = Buffer.alloc(0);
    let closed = false;
    const enc = new TextEncoder();
    const emit = (obj: unknown) => {
      if (!closed) controller.enqueue(enc.encode(`${JSON.stringify(obj)}\n`));
    };
    const exit = (code: number | null) => {
      if (closed) return;
      closed = true;
      try {
        controller.close();
      } catch {}
      resolveExit(code);
    };
    const w: FakeWorker = {
      cmd,
      env,
      frames: [],
      killed: false,
      stdout: new ReadableStream<Uint8Array>({ start: c => void (controller = c) }),
      exited: new Promise(r => (resolveExit = r)),
      stdin: {
        write(chunk) {
          pending = Buffer.concat([pending, Buffer.from(chunk)]);
          while (pending.length >= 4) {
            const len = pending.readUInt32LE(0);
            if (pending.length < 4 + len) break;
            pending = pending.subarray(4 + len);
            w.frames.push(len);
            const text = o.autoAnswer?.(len, w.frames.length);
            if (text !== null && text !== undefined) queueMicrotask(() => emit({ text }));
          }
        },
        flush() {},
        end() {},
      },
      kill() {
        w.killed = true;
        exit(null);
      },
      ready: () => emit({ ready: true }),
      answer: text => emit({ text }),
      crash: () => exit(139),
    };
    spawned.push(w);
    if (o.autoReady !== false) queueMicrotask(() => w.ready());
    return w;
  };
  return { spawn, spawned };
}

function parakeetWorld(o: { capi?: boolean; proof?: boolean; autoAnswer?: (len: number, n: number) => string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "speech-call-warm-"));
  roots.push(root);
  const workers = workerSpawn({ autoAnswer: o.autoAnswer ?? ((_len, n) => `Satz Nummer ${n}`) });
  const d: ProviderDeps = {
    env: () => ({ PATH: "/usr/bin", HOME: root, TELEGRAM_BOT_TOKEN: "TOKEN-MARKER", OPENAI_API_KEY: "KEY-MARKER" }),
    run: async () => ({ exitCode: 0, stdout: "0.1 -- 1.0: kalt erkannt", stderr: "", timedOut: false }),
    fetch: async () => new Response("", { status: 500 }),
    exists: existsSync,
    which: () => null,
    readFile: p => readFile(p),
    writeFile: (p, data) => writeFile(p, data),
    unlink: p => unlink(p),
    mkdir: async p => {
      await mkdir(p, { recursive: true });
    },
    cwd: () => root,
    tmpDir: root,
    unique: () => "u1",
    platform: "darwin",
    arch: "arm64",
    warmSpawn: workers.spawn,
  };
  const provider = createSttProviders(d).find(p => p.id === "parakeet")!;
  const paths = parakeetPaths(speechDir(root), "osx-arm64");
  const ready = async () => {
    await placeFiles(paths);
    if (o.proof !== false) {
      const proof = buildProof(paths, "osx-arm64", statFile, { wer: 0.04, ms: 300, at: "2026-10-01T00:00:00.000Z" })!;
      writeFileSync(paths.proof, JSON.stringify(proof));
    }
    if (o.capi !== false) writeFileSync(capiLibrary(paths, "osx-arm64"), "dylib");
  };
  return { root, provider, paths, workers, ready };
}

const pcm = (ms: number, value = 500) => {
  const b = Buffer.alloc(16 * ms * 2);
  for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(value, i * 2);
  return b;
};

describe("Parakeet im Dauerbetrieb", () => {
  test("ein Prozess für mehrere Äußerungen, Ergebnisse in Reihenfolge, Ende beim Auflegen", async () => {
    const w = parakeetWorld();
    await w.ready();
    expect(w.provider.canWarm!()).toBe(true);
    const handle = await w.provider.warm!();
    expect(w.workers.spawned).toHaveLength(1);
    const results = await Promise.all([
      handle.transcribe(pcmToWav(pcm(200), 16_000), "audio/wav", {}),
      handle.transcribe(pcmToWav(pcm(300), 16_000), "audio/wav", {}),
    ]);
    expect(results).toEqual(["Satz Nummer 1", "Satz Nummer 2"]);
    expect(await handle.transcribe(pcmToWav(pcm(100), 16_000), "audio/wav", {})).toBe("Satz Nummer 3");
    const worker = w.workers.spawned[0]!;
    // Rahmen: genau das PCM ohne WAV-Kopf
    expect(worker.frames).toEqual([200 * 32, 300 * 32, 100 * 32]);
    expect(w.workers.spawned).toHaveLength(1);
    handle.close();
    expect(worker.killed).toBe(true);
    await expect(handle.transcribe(pcmToWav(pcm(100), 16_000), "audio/wav", {})).rejects.toMatchObject({ kind: "exit" });
  });

  test("Befehl und Umgebung: Bun mit dem Skript, Pfade als JSON, C-API-Bibliothek, keine Schlüssel", async () => {
    const w = parakeetWorld();
    await w.ready();
    const handle = await w.provider.warm!();
    const worker = w.workers.spawned[0]!;
    expect(worker.cmd[0]).toBe(process.execPath);
    expect(worker.cmd[1]).toBe(PARAKEET_WORKER_SCRIPT);
    const args = JSON.parse(worker.cmd[2]!);
    expect(args).toMatchObject({ lib: capiLibrary(w.paths, "osx-arm64"), tokens: w.paths.tokens, encoder: w.paths.encoder, decoder: w.paths.decoder, joiner: w.paths.joiner });
    expect(worker.env.DYLD_LIBRARY_PATH).toBe(w.paths.libDir);
    expect(Object.keys(worker.env).sort()).toEqual(["DYLD_LIBRARY_PATH", "HOME", "PATH"]);
    expect(JSON.stringify(worker.env)).not.toContain("MARKER");
    handle.close();
  });

  test("ohne C-API-Bibliothek oder ohne Nachweis: kein Dauerbetrieb", async () => {
    const a = parakeetWorld({ capi: false });
    await a.ready();
    expect(a.provider.canWarm!()).toBe(false);
    await expect(a.provider.warm!()).rejects.toMatchObject({ kind: "unavailable" });
    const b = parakeetWorld({ proof: false });
    await b.ready();
    expect(b.provider.canWarm!()).toBe(false);
    expect(b.workers.spawned).toHaveLength(0);
  });

  test("Abbruch: sofort timeout, das späte Ergebnis wird übersprungen", async () => {
    const w = parakeetWorld({ autoAnswer: () => null });
    await w.ready();
    const handle = await w.provider.warm!();
    const worker = w.workers.spawned[0]!;
    const controller = new AbortController();
    const first = handle.transcribe(pcmToWav(pcm(100), 16_000), "audio/wav", { signal: controller.signal });
    const second = handle.transcribe(pcmToWav(pcm(100), 16_000), "audio/wav", {});
    controller.abort();
    await expect(first).rejects.toMatchObject({ kind: "timeout" });
    worker.answer("spät, gehört zur ersten");
    worker.answer("die zweite");
    expect(await second).toBe("die zweite");
    handle.close();
  });

  test("leeres Ergebnis ist empty, Absturz ist exit, falsches Format ist format", async () => {
    const w = parakeetWorld({ autoAnswer: (_l, n) => (n === 1 ? "" : null) });
    await w.ready();
    const handle = await w.provider.warm!();
    await expect(handle.transcribe(pcmToWav(pcm(100), 16_000), "audio/wav", {})).rejects.toMatchObject({ kind: "empty" });
    await expect(handle.transcribe(pcmToWav(pcm(100), 24_000), "audio/wav", {})).rejects.toMatchObject({ kind: "format" });
    const pending = handle.transcribe(pcmToWav(pcm(100), 16_000), "audio/wav", {});
    w.workers.spawned[0]!.crash();
    await expect(pending).rejects.toMatchObject({ kind: "exit" });
  });

  test("Prozess endet vor ready: exit; kein ready binnen Frist: timeout und beendet", async () => {
    const dead = workerSpawn({ autoReady: false });
    const root = mkdtempSync(join(tmpdir(), "speech-call-warm-"));
    roots.push(root);
    const paths = parakeetPaths(speechDir(root), "osx-arm64");
    const p = startParakeetWarm({ paths, key: "osx-arm64", threads: 2, spawn: dead.spawn, env: {} });
    dead.spawned[0]!.crash();
    await expect(p).rejects.toMatchObject({ kind: "exit" });
    const slow = workerSpawn({ autoReady: false });
    await expect(startParakeetWarm({ paths, key: "osx-arm64", threads: 2, spawn: slow.spawn, env: {}, readyTimeoutMs: 20 })).rejects.toMatchObject({ kind: "timeout" });
    expect(slow.spawned[0]!.killed).toBe(true);
  });

  test("Offsets der C-Struktur passen zur geprüften Version (608 Byte, Modell ab 8, Decodierung bei 528)", () => {
    expect(RECOGNIZER_CONFIG).toMatchObject({ size: 608, encoder: 8, tokens: 104, provider: 120, modelType: 128, decodingMethod: 528 });
    expect(sherpaPcm(pcmToWav(pcm(20), 16_000))!.length).toBe(640);
  });
});

// ---------------------------------------------------------------------------
// Pocket: gestreamte Antwort
// ---------------------------------------------------------------------------

function wavHead(rate = 24_000): Buffer {
  const head = pcmToWav(Buffer.alloc(0), rate);
  head.writeUInt32LE(0xffffffff, 4);
  head.writeUInt32LE(0xffffffff, 40);
  return head;
}

function pocketWorld(body: (controller: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "speech-call-pocket-"));
  roots.push(root);
  const paths = pocketPaths(speechDir(root));
  const children: Array<PocketChild & { env: Record<string, string>; port: number; ready: boolean }> = [];
  const forms: Array<Record<string, string>> = [];
  let port = 41_000;
  const deps: PocketServerDeps = {
    spawn(cmd, opts) {
      let resolveExit!: () => void;
      const child = {
        env: opts.env,
        port: Number(cmd[cmd.indexOf("--port") + 1]),
        ready: true,
        exited: new Promise<unknown>(r => (resolveExit = () => r(undefined))),
        kill() {
          child.ready = false;
          resolveExit();
        },
      };
      children.push(child);
      return child;
    },
    async fetch(url, init) {
      const child = children.find(c => c.port === Number(new URL(url).port) && c.ready);
      if (!child) throw new TypeError("refused");
      if (new Headers(init?.headers).get("authorization") !== `Bearer ${child.env.TYBO_POCKET_TOKEN}`) return new Response("", { status: 401 });
      if (url.endsWith("/health")) return new Response("{}", { status: 200 });
      forms.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
      return new Response(new ReadableStream<Uint8Array>({ start: c => void body(c) }), { status: 200, headers: { "content-type": "audio/wav" } });
    },
    freePort: async () => port++,
    now: () => 0,
    sleep: async () => {},
    setTimer: () => ({}),
    clearTimer: () => {},
  };
  const server = createPocketServer({ paths, env: () => ({ PATH: "/usr/bin" }), deps });
  return { server, children, forms };
}

describe("Pocket gestreamt", () => {
  test("Stücke kommen vor dem Ende der Synthese an; nur das Feld text; PCM ohne Kopf", async () => {
    const rest = gate();
    const first = Buffer.alloc(3840, 7);
    const w = pocketWorld(async c => {
      // Kopf und erstes Stück, dann wartet die „Synthese“
      c.enqueue(new Uint8Array(Buffer.concat([wavHead(), first.subarray(0, 1001)])));
      c.enqueue(new Uint8Array(first.subarray(1001)));
      await rest.promise;
      c.enqueue(new Uint8Array(Buffer.alloc(1920, 8)));
      c.close();
    });
    const got: Buffer[] = [];
    const it = w.server.synthesizeStream("Hallo du.", "juergen")[Symbol.asyncIterator]();
    // Das erste Stück ist da, obwohl die Synthese noch läuft
    let bytes = 0;
    while (bytes < first.length) {
      const step = await it.next();
      expect(step.done).toBe(false);
      got.push(step.value as Buffer);
      bytes += (step.value as Buffer).length;
    }
    expect(Buffer.concat(got).equals(first)).toBe(true);
    expect(got.every(g => g.length % 2 === 0)).toBe(true);
    rest.open();
    const tail = await it.next();
    expect((tail.value as Buffer).length).toBe(1920);
    expect((await it.next()).done).toBe(true);
    expect(w.forms).toEqual([{ text: "Hallo du." }]);
  });

  test("falsche Abtastrate im Kopf: format; leer: empty", async () => {
    const a = pocketWorld(c => {
      c.enqueue(new Uint8Array(Buffer.concat([wavHead(16_000), Buffer.alloc(100)])));
      c.close();
    });
    await expect((async () => {
      for await (const _ of a.server.synthesizeStream("Hallo.", "juergen"));
    })()).rejects.toMatchObject({ kind: "format" });
    const b = pocketWorld(c => {
      c.enqueue(new Uint8Array(wavHead()));
      c.close();
    });
    await expect((async () => {
      for await (const _ of b.server.synthesizeStream("Hallo.", "juergen"));
    })()).rejects.toMatchObject({ kind: "empty" });
  });

  test("Abbruch beendet die Anfrage, kein weiteres Stück", async () => {
    const never = gate();
    const w = pocketWorld(async c => {
      c.enqueue(new Uint8Array(Buffer.concat([wavHead(), Buffer.alloc(960, 1)])));
      await never.promise;
    });
    const controller = new AbortController();
    const out: Buffer[] = [];
    const run = (async () => {
      for await (const chunk of w.server.synthesizeStream("Langer Text.", "juergen", controller.signal)) {
        out.push(chunk);
        controller.abort();
      }
    })();
    await expect(run).rejects.toMatchObject({ kind: "timeout" });
    expect(out).toHaveLength(1);
  });

  test("nicht freigegebene Stimme: unavailable ohne Anfrage", async () => {
    const w = pocketWorld(c => c.close());
    await expect((async () => {
      for await (const _ of w.server.synthesizeStream("Hallo.", "cosette"));
    })()).rejects.toMatchObject({ kind: "unavailable" });
    expect(w.children).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PCM
// ---------------------------------------------------------------------------

describe("PCM-Helfer", () => {
  test("WAV-Strom mit geteiltem Kopf und ungerader Grenze", () => {
    const p = createWavStreamParser();
    const all = Buffer.concat([wavHead(), Buffer.from([1, 2, 3, 4, 5, 6])]);
    const out: Buffer[] = [];
    for (const piece of [all.subarray(0, 10), all.subarray(10, 45), all.subarray(45, 48), all.subarray(48)]) out.push(...p.push(piece));
    expect(p.sampleRate).toBe(24_000);
    expect(Buffer.concat(out)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6]));
    expect(out.every(o => o.length % 2 === 0)).toBe(true);
  });

  test("WAV-Strom: kleiner Kopf und mehr als 64 KB PCM im selben Stück", () => {
    const p = createWavStreamParser();
    const pcm = Buffer.alloc(100 * 1024);
    for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251;
    const out = p.push(Buffer.concat([wavHead(), pcm]));
    expect(Buffer.concat(out)).toEqual(pcm);
    expect(p.totalBytes).toBe(pcm.length);
  });

  test("WAV-Strom: Kopf über mehrere Stücke verteilt (mit LIST-Block), Ton in beliebigen Grenzen", () => {
    const p = createWavStreamParser();
    const fmtPart = wavHead().subarray(0, 36);
    const list = Buffer.alloc(8 + 1000);
    list.write("LIST", 0, "latin1");
    list.writeUInt32LE(1000, 4);
    const dataHead = Buffer.from("data\xff\xff\xff\xff", "latin1");
    const pcm = Buffer.alloc(70 * 1024, 7);
    const all = Buffer.concat([fmtPart, list, dataHead, pcm]);
    const out: Buffer[] = [];
    // Grenzen mitten in fmt, in LIST, in der data-Kennung und ungerade im Ton
    for (const cut of [[0, 20], [20, 500], [500, 1047], [1047, 1051], [1051, 40_001], [40_001, all.length]] as const) out.push(...p.push(all.subarray(cut[0], cut[1])));
    expect(p.sampleRate).toBe(24_000);
    expect(Buffer.concat(out)).toEqual(pcm);
    expect(out.every(o => o.length % 2 === 0)).toBe(true);
  });

  test("WAV-Strom: Kopf größer als 64 KB wird abgelehnt", () => {
    const p = createWavStreamParser();
    const list = Buffer.alloc(8);
    list.write("LIST", 0, "latin1");
    list.writeUInt32LE(70 * 1024, 4);
    expect(() => p.push(Buffer.concat([wavHead().subarray(0, 36), list]))).toThrow(SpeechError);
  });

  test("wavToPcm und Umrechnen der Abtastrate", () => {
    const pcm22 = Buffer.alloc(22_050 * 2, 0);
    const { sampleRate, pcm } = wavToPcm(pcmToWav(pcm22, 22_050));
    expect(sampleRate).toBe(22_050);
    expect(resamplePcm16(pcm, 22_050, 24_000).length).toBe(24_000 * 2);
    expect(resamplePcm16(pcm, 24_000, 24_000)).toEqual(pcm);
    expect(() => wavToPcm(Buffer.from("kein wav"))).toThrow(SpeechError);
  });
});

// ---------------------------------------------------------------------------
// Anbieterwahl und Vorwärmen
// ---------------------------------------------------------------------------

function stt(id: string, ok = true, local = true): SttProvider {
  return { id: id as SttProvider["id"], label: id, local, available: () => (ok ? { ok: true } : { ok: false, reason: "fehlt" }), transcribe: async () => "x" };
}
function tts(id: string, where: "server" | "browser" = "server", ok = true): TtsProvider {
  return { id: id as TtsProvider["id"], label: id, local: true, where, available: () => (ok ? { ok: true } : { ok: false }), synthesize: async () => ({ audio: Buffer.alloc(0), mime: "audio/wav" }) };
}
function speechWith(settings: Settings, sttList: SttProvider[], ttsList: TtsProvider[]) {
  return createSpeech({ stt: sttList, tts: ttsList, getSettings: () => settings, env: () => ({}), log: () => {}, readFile: async () => Buffer.alloc(0) });
}

describe("Anbieter für den Telefonhörer", () => {
  const sttAll = [stt("parakeet", false), stt("whisper-cpp"), stt("elevenlabs", true, false), stt("gemini", true, false)];
  const ttsAll = [tts("browser", "browser"), tts("qwen3-mlx"), tts("elevenlabs"), tts("gemini"), tts("pocket"), tts("piper"), tts("clone")];

  test("auto hört lokal: erster verfügbarer aus Parakeet, whisper.cpp; nie Cloud", () => {
    expect(speechWith({}, sttAll, ttsAll).callChoice().stt?.id).toBe("whisper-cpp");
    const onlyCloud = [stt("parakeet", false), stt("whisper-cpp", false), stt("elevenlabs", true, false)];
    const c = speechWith({}, onlyCloud, ttsAll).callChoice();
    expect(c.stt).toBeNull();
    expect(c.sttReason).toContain("Parakeet oder whisper.cpp");
  });

  test("fest gewählte Cloud-Erkennung: kein Telefonhörer, mit Grund", () => {
    const c = speechWith({ speech: { stt: "elevenlabs" } } as Settings, sttAll, ttsAll).callChoice();
    expect(c.stt).toBeNull();
    expect(c.sttReason).toContain("nur lokal");
  });

  test("Stimme: Pocket und Piper auf dem Server, alles andere (auch die eigene Stimme) der Browser", () => {
    for (const [choice, expected] of [
      ["pocket", "pocket"],
      ["piper", "piper"],
      ["clone", null],
      ["elevenlabs", null],
      ["qwen3-mlx", null],
      ["auto", null],
      ["browser", null],
    ] as const) {
      expect(speechWith({ speech: { tts: choice } } as Settings, sttAll, ttsAll).callChoice().tts?.id ?? null).toBe(expected);
    }
  });

  test("Pocket-Anbieter: warm startet den Prozess ohne Synthese, streamSampleRate 24 kHz", async () => {
    const root = mkdtempSync(join(tmpdir(), "speech-call-pocket-provider-"));
    roots.push(root);
    const paths = pocketPaths(speechDir(root));
    await mkdir(join(paths.venv, "bin"), { recursive: true });
    writeFileSync(paths.program, "#!/bin/sh\n");
    await mkdir(paths.modelCache, { recursive: true });
    writeFileSync(paths.proof, JSON.stringify({ version: 1, pocket: POCKET_VERSION, language: POCKET_LANGUAGE, voice: "juergen", probe: {} }));
    const spawned: string[][] = [];
    const posts: string[] = [];
    const d: ProviderDeps = {
      env: () => ({ PATH: "/usr/bin" }),
      run: async () => ({ exitCode: 0, stdout: "", stderr: "", timedOut: false }),
      fetch: async () => new Response("", { status: 500 }),
      exists: existsSync,
      which: () => null,
      readFile: p => readFile(p),
      writeFile: (p, data) => writeFile(p, data),
      unlink: p => unlink(p),
      mkdir: async p => {
        await mkdir(p, { recursive: true });
      },
      cwd: () => root,
      tmpDir: root,
      unique: () => "u",
      pocket: {
        spawn: cmd => {
          spawned.push(cmd);
          return { exited: new Promise(() => {}), kill: () => {} };
        },
        fetch: async (url, init) => {
          if (url.endsWith("/tts")) posts.push(String(init?.body));
          return new Response("{}", { status: 200 });
        },
        freePort: async () => 42_000,
        now: () => 0,
        sleep: async () => {},
        setTimer: () => ({}),
        clearTimer: () => {},
      },
    };
    const pocket = createTtsProviders(d).find(p => p.id === "pocket")!;
    expect(pocket.streamSampleRate).toBe(24_000);
    expect(typeof pocket.synthesizeStream).toBe("function");
    await pocket.warm!();
    expect(spawned).toHaveLength(1);
    expect(posts).toEqual([]);
  });
});
