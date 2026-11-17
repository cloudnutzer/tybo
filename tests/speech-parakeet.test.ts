/**
 * Issue #251, Checkbox 4: Anbieter „parakeet“ (sherpa-onnx) mit
 * Prozess-Attrappe (RunFn). Kein sherpa-onnx, kein ffmpeg, kein Modell; nur
 * Dateien in einem Temp-Ordner. Dazu runProcess mit harmlosen
 * Systemprogrammen (sh, sleep, touch) für Abbruch vor dem Start und SIGKILL.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpeech } from "../src/lib/speech/chain";
import { buildProof, parakeetPaths, PARAKEET_TIMEOUT_MS, PROOF_INVALID, speechDir, transcribeWithSherpa, type PlatformKey } from "../src/lib/speech/parakeet";
import { KILL_GRACE_MS, runProcess, type RunFn, type RunResult } from "../src/lib/speech/process";
import { createSttProviders, type ProviderDeps } from "../src/lib/speech/providers";
import { SpeechError, type SttProvider } from "../src/lib/speech/types";
import { DIAG_STDERR, GOOD_STDOUT, placeFiles, STDERR_MARKER } from "./parakeet-fixture";
import { statFile } from "../src/setup/steps/speech";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const WAV16 = (() => {
  const data = 3200;
  const b = Buffer.alloc(44 + data);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(36 + data, 4);
  b.write("WAVE", 8, "latin1");
  b.write("fmt ", 12, "latin1");
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36, "latin1");
  b.writeUInt32LE(data, 40);
  return b;
})();

/** Gleiche Rate und Kanäle, aber 32-Bit-Gleitkomma: muss über ffmpeg */
const WAV_FLOAT = (() => {
  const b = Buffer.from(WAV16);
  b.writeUInt16LE(3, 20);
  b.writeUInt16LE(32, 34);
  return b;
})();

type Mode = "gut" | "leer" | "exit" | "haengt";

interface World {
  root: string;
  provider: SttProvider;
  calls: string[][];
  opts: Array<Parameters<RunFn>[1]>;
  /** Gestartete und noch nicht beendete Prozesse */
  live(): number;
  logs: string[];
  uploads(): string[];
}

function world(o: { sherpa?: Mode; ffmpeg?: Mode | "fehlt"; files?: boolean; platform?: string; arch?: string } = {}): World {
  const root = mkdtempSync(join(tmpdir(), "parakeet-"));
  roots.push(root);
  const calls: string[][] = [];
  const opts: Array<Parameters<RunFn>[1]> = [];
  let live = 0;
  const result = (r: Partial<RunResult>): RunResult => ({ exitCode: 0, stdout: "", stderr: DIAG_STDERR, timedOut: false, ...r });
  const hang = (signal: AbortSignal | undefined, timeoutMs: number) =>
    new Promise<RunResult>(resolve => {
      const done = () => resolve(result({ exitCode: null, timedOut: true }));
      if (signal?.aborted) return done();
      signal?.addEventListener("abort", done, { once: true });
      setTimeout(done, Math.min(timeoutMs, 200));
    });
  const run: RunFn = async (cmd, o2) => {
    calls.push(cmd);
    opts.push(o2);
    if (o2.signal?.aborted) return result({ exitCode: null, timedOut: true });
    live++;
    try {
      if (cmd[0] === "ffmpeg") {
        const mode = o.ffmpeg ?? "gut";
        if (mode === "haengt") return await hang(o2.signal, o2.timeoutMs);
        if (mode === "exit") return result({ exitCode: 1 });
        writeFileSync(cmd[cmd.length - 1], WAV16);
        return result({});
      }
      const mode = o.sherpa ?? "gut";
      if (mode === "haengt") return await hang(o2.signal, o2.timeoutMs);
      if (mode === "exit") return result({ exitCode: 2 });
      if (mode === "leer") return result({ stdout: "" });
      return result({ stdout: GOOD_STDOUT });
    } finally {
      live--;
    }
  };
  const d: ProviderDeps = {
    env: () => ({}),
    run,
    fetch: async () => new Response("", { status: 500 }),
    exists: existsSync,
    which: cmd => (cmd === "ffmpeg" && o.ffmpeg !== "fehlt" ? "/usr/bin/ffmpeg" : null),
    readFile: async () => Buffer.alloc(0),
    writeFile: async (p, data) => writeFile(p, data),
    unlink: p => unlink(p),
    mkdir: async p => {
      await mkdir(p, { recursive: true });
    },
    cwd: () => root,
    tmpDir: root,
    unique: () => "u1",
    platform: o.platform ?? "darwin",
    arch: o.arch ?? "arm64",
  };
  const provider = createSttProviders(d).find(p => p.id === "parakeet")!;
  const logs: string[] = [];
  return {
    root,
    provider,
    calls,
    opts,
    live: () => live,
    logs,
    uploads: () => (existsSync(join(root, "uploads")) ? readdirSync(join(root, "uploads")) : []),
  };
}

async function withFiles(w: World, key: PlatformKey = "osx-arm64") {
  const paths = parakeetPaths(speechDir(w.root), key);
  await placeFiles(paths);
  return paths;
}

function writeProof(w: World, key: PlatformKey = "osx-arm64") {
  const paths = parakeetPaths(speechDir(w.root), key);
  const proof = buildProof(paths, key, statFile, { wer: 0.045, ms: 450, at: "2026-10-01T00:00:00.000Z" })!;
  writeFileSync(paths.proof, JSON.stringify(proof));
  return paths;
}

async function caught(p: Promise<unknown>): Promise<SpeechError> {
  try {
    await p;
  } catch (e) {
    return e as SpeechError;
  }
  throw new Error("kein Fehler");
}

describe("transcribe", () => {
  test("Erfolg: Segmente zusammengefügt, Aufruf wie in der sherpa-Anleitung, Bibliothekspfad gesetzt", async () => {
    const w = world();
    const paths = await withFiles(w);
    const text = await w.provider.transcribe(WAV16, "audio/wav", {});
    expect(text).toBe("Guten Morgen. Bitte erinnere mich heute um 3 Uhr an den Termin beim Tanarzt. Und schreib mir danach eine kurze Einkaufsliste.");
    // WAV mit PCM16, 16 kHz, mono geht ohne ffmpeg direkt an sherpa
    expect(w.calls.length).toBe(1);
    const cmd = w.calls[0];
    expect(cmd[0]).toBe(paths.program);
    expect(cmd).toContain(`--silero-vad-model=${paths.vad}`);
    expect(cmd).toContain(`--tokens=${paths.tokens}`);
    expect(cmd).toContain(`--encoder=${paths.encoder}`);
    expect(cmd).toContain(`--decoder=${paths.decoder}`);
    expect(cmd).toContain(`--joiner=${paths.joiner}`);
    expect(cmd).toContain("--model-type=nemo_transducer");
    expect(w.opts[0].env).toEqual({ DYLD_LIBRARY_PATH: paths.libDir });
    expect(w.uploads()).toEqual([]);
  });

  test("Linux: LD_LIBRARY_PATH statt DYLD_LIBRARY_PATH", async () => {
    const w = world({ platform: "linux", arch: "x64" });
    const paths = await withFiles(w, "linux-x64");
    await w.provider.transcribe(WAV16, "audio/wav", {});
    expect(w.opts[0].env).toEqual({ LD_LIBRARY_PATH: paths.libDir });
  });

  test("Nicht-WAV und Float-WAV gehen über ffmpeg zu PCM16, 16 kHz, mono; beide Temp-Dateien weg", async () => {
    for (const [audio, mime] of [[Buffer.from("OggS-irgendwas"), "audio/ogg"], [WAV_FLOAT, "audio/wav"]] as const) {
      const w = world();
      await withFiles(w);
      await w.provider.transcribe(audio, mime, {});
      expect(w.calls.map(c => c[0].split("/").pop())).toEqual(["ffmpeg", "sherpa-onnx-vad-with-offline-asr"]);
      expect(w.calls[0]).toEqual(expect.arrayContaining(["-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le"]));
      expect(w.calls[1][w.calls[1].length - 1]).toBe(w.calls[0][w.calls[0].length - 1]);
      expect(w.uploads()).toEqual([]);
    }
  });

  test("ffmpeg fehlt bei Nicht-WAV: format, ohne Prozess", async () => {
    const w = world({ ffmpeg: "fehlt" });
    await withFiles(w);
    const e = await caught(w.provider.transcribe(Buffer.from("OggS"), "audio/ogg", {}));
    expect(e).toBeInstanceOf(SpeechError);
    expect(e.kind).toBe("format");
    expect(w.calls).toEqual([]);
    expect(w.uploads()).toEqual([]);
  });

  test("fehlende Datei: unavailable, ohne Prozess", async () => {
    const w = world();
    const paths = await withFiles(w);
    rmSync(paths.joiner);
    const e = await caught(w.provider.transcribe(WAV16, "audio/wav", {}));
    expect(e.kind).toBe("unavailable");
    expect(w.calls).toEqual([]);
  });

  test("VAD fand nichts: leere Ausgabe ergibt empty; Temp-Datei weg", async () => {
    const w = world({ sherpa: "leer" });
    await withFiles(w);
    expect((await caught(w.provider.transcribe(WAV16, "audio/wav", {}))).kind).toBe("empty");
    expect(w.uploads()).toEqual([]);
  });

  test("Fehler des Programms: exit mit Code, ohne stderr in der Meldung; Temp-Datei weg", async () => {
    const w = world({ sherpa: "exit" });
    await withFiles(w);
    const e = await caught(w.provider.transcribe(WAV16, "audio/wav", {}));
    expect(e.kind).toBe("exit");
    expect(e.code).toBe(2);
    expect(e.message).not.toContain(STDERR_MARKER);
    expect(w.uploads()).toEqual([]);
  });

  test("Zeitüberschreitung ohne Signal: eigene Frist höchstens 30 s, Prozess beendet, Temp-Datei weg", async () => {
    const w = world({ sherpa: "haengt" });
    await withFiles(w);
    const e = await caught(w.provider.transcribe(WAV16, "audio/wav", {}));
    expect(e.kind).toBe("timeout");
    expect(w.opts[0].timeoutMs).toBeLessThanOrEqual(PARAKEET_TIMEOUT_MS);
    expect(w.opts[0].signal).toBeUndefined();
    expect(w.live()).toBe(0);
    expect(w.uploads()).toEqual([]);
  });

  test("Frist gilt für Wandlung und Erkennung zusammen: nach 20 s Wandlung bleiben sherpa höchstens 10 s", async () => {
    const w = world();
    const paths = await withFiles(w);
    let now = 1_000_000;
    const timeouts: number[] = [];
    const run: RunFn = async (cmd, o) => {
      timeouts.push(o.timeoutMs);
      if (cmd[0] === "ffmpeg") {
        now += 20_000;
        writeFileSync(cmd[cmd.length - 1], WAV16);
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
      }
      return { exitCode: 0, stdout: GOOD_STDOUT, stderr: "", timedOut: false };
    };
    const deps = { run, which: () => "/usr/bin/ffmpeg", writeFile: (p: string, d: Buffer) => writeFile(p, d), unlink: (p: string) => unlink(p), mkdir: async (p: string) => { await mkdir(p, { recursive: true }); } };
    const job = { paths, key: "osx-arm64" as const, tmpDir: join(w.root, "uploads"), unique: "frist", ext: "ogg", threads: 2, now: () => now };
    await transcribeWithSherpa(Buffer.from("OggS"), job, deps, existsSync);
    expect(timeouts).toEqual([PARAKEET_TIMEOUT_MS, PARAKEET_TIMEOUT_MS - 20_000]);
    // Schon abgelaufen: sherpa startet gar nicht
    timeouts.length = 0;
    const late: RunFn = async (cmd, o) => {
      timeouts.push(o.timeoutMs);
      now += 31_000;
      writeFileSync(cmd[cmd.length - 1], WAV16);
      return { exitCode: 0, stdout: "", stderr: "", timedOut: false };
    };
    expect((await caught(transcribeWithSherpa(Buffer.from("OggS"), job, { ...deps, run: late }, existsSync))).kind).toBe("timeout");
    expect(timeouts.length).toBe(1);
    expect(w.uploads()).toEqual([]);
  });

  test("Abbruch über signal während der Erkennung: alle eigenen Prozesse beendet, timeout, Temp-Dateien weg", async () => {
    const w = world({ sherpa: "haengt" });
    await withFiles(w);
    const controller = new AbortController();
    const p = w.provider.transcribe(Buffer.from("OggS"), "audio/ogg", { signal: controller.signal });
    await Bun.sleep(10);
    controller.abort();
    const e = await caught(p);
    expect(e.kind).toBe("timeout");
    expect(w.opts.every(o => o.signal === controller.signal)).toBe(true);
    expect(w.live()).toBe(0);
    expect(w.uploads()).toEqual([]);
  });

  test("Abbruch während ffmpeg: sherpa startet nicht mehr", async () => {
    const w = world({ ffmpeg: "haengt" });
    await withFiles(w);
    const controller = new AbortController();
    const p = w.provider.transcribe(Buffer.from("OggS"), "audio/ogg", { signal: controller.signal });
    // Erst abbrechen, wenn ffmpeg läuft: davor liegen Verzeichnis und Temp-Datei
    // auf der echten Platte, unter Last dauert das länger als eine feste Pause
    for (const end = Date.now() + 3000; w.calls.length === 0 && Date.now() < end; ) await Bun.sleep(2);
    controller.abort();
    expect((await caught(p)).kind).toBe("timeout");
    expect(w.calls.map(c => c[0])).toEqual(["ffmpeg"]);
    expect(w.live()).toBe(0);
    expect(w.uploads()).toEqual([]);
  });

  test("schon ausgelöstes Signal: kein Prozess, keine Temp-Datei", async () => {
    const w = world();
    await withFiles(w);
    const controller = new AbortController();
    controller.abort();
    expect((await caught(w.provider.transcribe(WAV16, "audio/wav", { signal: controller.signal }))).kind).toBe("timeout");
    expect(w.calls).toEqual([]);
    expect(w.uploads()).toEqual([]);
  });

  test("nicht unterstützte Plattform: unavailable", async () => {
    const w = world({ platform: "win32", arch: "x64" });
    expect((await caught(w.provider.transcribe(WAV16, "audio/wav", {}))).kind).toBe("unavailable");
    expect(w.provider.available()).toEqual({ ok: false, reason: "auf dieser Plattform nicht unterstützt (Windows)" });
  });
});

describe("Log der Kette: kein Transkript, kein stderr", () => {
  function chainWith(provider: SttProvider) {
    const logs: string[] = [];
    const speech = createSpeech({
      stt: [provider],
      tts: [],
      getSettings: () => ({ speech: { stt: "parakeet" } }),
      env: () => ({}),
      log: l => logs.push(l),
      readFile: async () => Buffer.alloc(0),
    });
    return { speech, logs };
  }

  test("Erfolg und Fehler: Log nennt Anbieter, Dauer, Ergebnis, nie Text oder Diagnose", async () => {
    const ok = world();
    await withFiles(ok);
    writeProof(ok);
    const a = chainWith(ok.provider);
    const r = await a.speech.recognize(WAV16, "audio/wav", { timeoutMs: 30_000 });
    expect(r).toMatchObject({ ok: true, provider: "parakeet" });
    const bad = world({ sherpa: "exit" });
    await withFiles(bad);
    writeProof(bad);
    const b = chainWith(bad.provider);
    expect(await b.speech.recognize(WAV16, "audio/wav", { timeoutMs: 30_000 })).toEqual({ ok: false, reason: "failed" });
    const all = [...a.logs, ...b.logs].join("\n");
    expect(all).toContain("[Sprache] Hören parakeet: ok");
    expect(all).toContain("[Sprache] Hören parakeet: Fehler (Exit-Code 2)");
    for (const secret of [STDERR_MARKER, "Guten Morgen", "Tanarzt", "Einkaufsliste"]) expect(all).not.toContain(secret);
  });

  test("Zeitlimit der Kette (30 s im Sprechmodus) bricht sherpa über das Signal ab", async () => {
    const w = world({ sherpa: "haengt" });
    await withFiles(w);
    writeProof(w);
    const { speech, logs } = chainWith(w.provider);
    expect(await speech.recognize(WAV16, "audio/wav", { timeoutMs: 20 })).toEqual({ ok: false, reason: "timeout" });
    await Bun.sleep(20);
    expect(w.opts[0].signal?.aborted).toBe(true);
    expect(w.live()).toBe(0);
    expect(w.uploads()).toEqual([]);
    expect(logs.join("\n")).not.toContain(STDERR_MARKER);
  });
});

describe("available(): nur mit passendem Nachweis", () => {
  test("ohne Dateien: nicht eingerichtet", () => {
    const w = world();
    expect(w.provider.available()).toEqual({ ok: false, reason: "nicht eingerichtet, tybo setup sprache ausführen" });
  });

  test("Dateien da, kein Nachweis: Probe fehlt", async () => {
    const w = world();
    await withFiles(w);
    expect(w.provider.available()).toEqual({ ok: false, reason: PROOF_INVALID });
  });

  test("mit passendem Nachweis: ok; ohne Prozess, ohne Netz", async () => {
    const w = world();
    await withFiles(w);
    writeProof(w);
    expect(w.provider.available()).toEqual({ ok: true });
    expect(w.calls).toEqual([]);
  });

  test("entwertet: Datei fehlt, Größe geändert, nur Änderungszeit geändert, andere Plattform, andere Version", async () => {
    const cases: Array<[string, (w: World, paths: ReturnType<typeof parakeetPaths>) => void]> = [
      ["Datei fehlt", (_w, p) => rmSync(p.encoder)],
      ["Bibliothek fehlt", (_w, p) => rmSync(p.libs[0])],
      ["Größe geändert", (_w, p) => writeFileSync(p.tokens, "anderer, längerer Inhalt")],
      ["Änderungszeit geändert", (_w, p) => utimesSync(p.vad, new Date("2030-01-01"), new Date("2030-01-01"))],
      ["andere Plattform", (_w, p) => writeFileSync(p.proof, JSON.stringify({ ...JSON.parse(readFileSync(p.proof, "utf8")), platform: "linux-x64" }))],
      ["andere Version", (_w, p) => writeFileSync(p.proof, JSON.stringify({ ...JSON.parse(readFileSync(p.proof, "utf8")), sherpa: "1.13.7" }))],
      ["kaputtes JSON", (_w, p) => writeFileSync(p.proof, "{kaputt")],
    ];
    for (const [name, change] of cases) {
      const w = world();
      await withFiles(w);
      const paths = writeProof(w);
      expect(w.provider.available().ok).toBe(true);
      change(w, paths);
      expect({ name, result: w.provider.available() }).toEqual({ name, result: { ok: false, reason: PROOF_INVALID } });
    }
  });
});

describe("runProcess (Issue #251): Abbruch vor dem Start, SIGKILL nach der Schonfrist, env ergänzt", () => {
  test("schon ausgelöstes Signal startet nichts", async () => {
    const dir = mkdtempSync(join(tmpdir(), "runproc-"));
    roots.push(dir);
    const controller = new AbortController();
    controller.abort();
    const r = await runProcess(["touch", join(dir, "gestartet")], { timeoutMs: 5_000, signal: controller.signal });
    expect(r.timedOut).toBe(true);
    expect(existsSync(join(dir, "gestartet"))).toBe(false);
  });

  test("ein Prozess, der SIGTERM ignoriert, endet nach der Schonfrist per SIGKILL", async () => {
    const controller = new AbortController();
    const start = Date.now();
    // Ein einzelner Prozess ohne Kinder, der SIGTERM abfängt und weiterläuft
    const p = runProcess([process.execPath, "-e", 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'], { timeoutMs: 60_000, signal: controller.signal });
    setTimeout(() => controller.abort(), 300);
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(Date.now() - start).toBeLessThan(KILL_GRACE_MS + 5_000);
  }, 15_000);

  test("env ergänzt die Umgebung, statt sie zu ersetzen", async () => {
    const r = await runProcess(["sh", "-c", 'printf "%s|%s" "$TYBO_TEST_VAR" "${PATH:+gesetzt}"'], { timeoutMs: 5_000, env: { TYBO_TEST_VAR: "wert" } });
    expect(r.stdout).toBe("wert|gesetzt");
  });
});
