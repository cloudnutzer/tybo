/**
 * Attrappen für Parakeet (Issue #251): Kontext mit fester Plattform,
 * Arbeitsspeicher, freiem Platz und Programmen, dazu Test-Artefakte mit
 * eigenem Inhalt und eigener Prüfsumme, ein Download-Server als fetch und
 * Prozesse (tar, ffmpeg, sherpa-onnx) als ctx.run. Nichts geht ins Netz,
 * nichts startet tar, ffmpeg oder sherpa-onnx.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Artifact, ArtifactId, ParakeetPaths } from "../src/lib/speech/parakeet";
import { parakeetPaths, speechDir } from "../src/lib/speech/parakeet";
import type { CommandResult, CommandRunner, HttpFetch, SetupContext } from "../src/setup/context";
import { makeCtx } from "./setup-fixture";
import { PROFILE } from "./setup-web-fixture";

export const GIB = 1024 ** 3;
export const SOLLTEXT = "Guten Morgen. Bitte erinnere mich heute um drei Uhr an den Termin beim Zahnarzt und schreib mir danach eine kurze Einkaufsliste.";
/** So sieht die Ausgabe von sherpa-onnx aus (gemessen auf dem Mac, Issue #251) */
export const GOOD_STDOUT = [
  "0.102 -- 1.100: Guten Morgen.",
  "1.606 -- 6.700: Bitte erinnere mich heute um 3 Uhr an den Termin beim Tanarzt.",
  "7.174 -- 10.784: Und schreib mir danach eine kurze Einkaufsliste.",
  "",
].join("\n");
export const STDERR_MARKER = "STDERR-MARKER-geheim";
/** Diagnose von sherpa-onnx auf stderr (gekürzt), mit Marker */
export const DIAG_STDERR = `parse-options.cc:Read:374 ${STDERR_MARKER}\nCreating recognizer ...\nRecognizer created!\nStarted\nElapsed seconds: 0.448 s\nReal time factor (RTF): 0.448 / 10.800 = 0.041\n`;

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

export interface TestArtifact {
  art: Artifact;
  body: Buffer;
  /** Dateien, die „tar“ in archiveDir anlegt (relativ), mit Inhalt */
  contents: Record<string, string>;
}

/** Drei kleine Artefakte mit denselben Zielen wie die echten */
export function testArtifacts(paths: ParakeetPaths): TestArtifact[] {
  const make = (id: ArtifactId, file: string, body: string, target: string, archiveDir: string | undefined, contents: Record<string, string>): TestArtifact => {
    const b = Buffer.from(body);
    return {
      art: { id, file, url: `https://example.test/${file}`, bytes: b.length, sha256: sha(b), unpackedBytes: b.length * 2, ...(archiveDir ? { archiveDir } : {}), target },
      body: b,
      contents,
    };
  };
  const rel = (p: string, base: string) => p.slice(base.length + 1);
  const runtimeFiles: Record<string, string> = { [rel(paths.program, paths.runtimeDir)]: "programm" };
  for (const l of paths.libs) runtimeFiles[rel(l, paths.runtimeDir)] = "bibliothek";
  const modelFiles: Record<string, string> = {};
  for (const f of [paths.tokens, paths.encoder, paths.decoder, paths.joiner]) modelFiles[rel(f, paths.modelDir)] = `modell ${basename(f)}`;
  return [
    make("laufzeit", "laufzeit.tar.bz2", "LAUFZEIT-ARCHIV-".repeat(40), basename(paths.runtimeDir), "paket-laufzeit", runtimeFiles),
    make("vad", "silero_vad.onnx", "VAD-DATEI-".repeat(20), basename(paths.vad), undefined, {}),
    make("modell", "modell.tar.bz2", "MODELL-ARCHIV-".repeat(100), basename(paths.modelDir), "paket-modell", modelFiles),
  ];
}

export interface FetchCall {
  url: string;
  range?: string;
}

export type Serve = (art: TestArtifact, call: FetchCall, n: number) => Response | "netzfehler";

/** Ganze Datei, Range mit 206 und richtigem Content-Range */
export const serveFull: Serve = (t, call) => {
  const m = /^bytes=(\d+)-$/.exec(call.range ?? "");
  if (m) {
    const from = Number(m[1]);
    return new Response(new Uint8Array(t.body.subarray(from)), { status: 206, headers: { "content-range": `bytes ${from}-${t.body.length - 1}/${t.body.length}` } });
  }
  return new Response(new Uint8Array(t.body), { status: 200 });
};

/** Download-Server: Antwort je Artefakt über serve; zählt Aufrufe */
export function fakeDownloads(arts: TestArtifact[], serve: Serve = serveFull) {
  const calls: FetchCall[] = [];
  const fetch: HttpFetch = async (url, request = {}) => {
    const t = arts.find(a => a.art.url === url);
    const call: FetchCall = { url, ...(request.headers?.Range ? { range: request.headers.Range } : {}) };
    calls.push(call);
    if (!t) return new Response("nicht da", { status: 404 });
    const res = serve(t, call, calls.filter(c => c.url === url).length);
    if (res === "netzfehler") throw new TypeError("fetch failed");
    return res;
  };
  return { fetch, calls };
}

/** Ein Strom, der nach cut Byte mit Netzfehler abreißt */
export function cutResponse(body: Buffer, cut: number, status = 200, headers: Record<string, string> = {}): Response {
  let sent = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(new Uint8Array(body.subarray(0, cut)));
        return;
      }
      controller.error(new TypeError("Verbindung abgerissen"));
    },
  });
  return new Response(stream, { status, headers });
}

export type SherpaMode = "gut" | "schlecht" | "leer" | "exit" | "haengt" | "stille-text";

export interface ProcessWorld {
  run: CommandRunner & { calls: string[][]; envs: Array<Record<string, string> | undefined> };
  /** Anzahl laufender (gestarteter, nicht beendeter) Prozesse */
  live(): number;
}

/**
 * Prozess-Attrappe: tar legt die Dateien des Archivs an, sherpa-onnx
 * antwortet je nach Modus (Stille-WAV erkennt es am Namen), ffmpeg schreibt
 * die Ausgabedatei. „haengt“ endet erst über das Signal.
 */
export function fakeProcesses(arts: TestArtifact[], sherpa: SherpaMode = "gut", tar: "ok" | "kaputt" = "ok"): ProcessWorld {
  const calls: string[][] = [];
  const envs: Array<Record<string, string> | undefined> = [];
  let live = 0;
  const run = (async (cmd: string[], options = {}) => {
    calls.push(cmd);
    envs.push(options.env);
    if (options.signal?.aborted) return { code: -1, stdout: "", stderr: "", aborted: true } as CommandResult;
    live++;
    try {
      if (cmd[0] === "tar") {
        if (tar === "kaputt") return { code: 2, stdout: "", stderr: "bzip2: Daten kaputt" };
        const archive = cmd[2];
        const into = cmd[4];
        const t = arts.find(a => archive.endsWith(`${a.art.file}.part`));
        if (!t?.art.archiveDir) return { code: 1, stdout: "", stderr: "unbekannt" };
        for (const [rel, text] of Object.entries(t.contents)) {
          const p = join(into, t.art.archiveDir, rel);
          await mkdir(dirname(p), { recursive: true });
          await writeFile(p, text);
        }
        return { code: 0, stdout: "", stderr: "" };
      }
      if (cmd[0].endsWith("sherpa-onnx-vad-with-offline-asr")) {
        const wav = cmd[cmd.length - 1];
        const silence = wav.includes("stille");
        if (sherpa === "haengt") {
          await new Promise<void>(resolve => {
            if (options.signal?.aborted) return resolve();
            options.signal?.addEventListener("abort", () => resolve(), { once: true });
            setTimeout(resolve, options.timeoutMs ?? 1000);
          });
          return { code: -1, stdout: "", stderr: DIAG_STDERR, timedOut: !options.signal?.aborted, aborted: !!options.signal?.aborted };
        }
        if (sherpa === "exit") return { code: 3, stdout: "", stderr: DIAG_STDERR };
        if (silence && sherpa !== "stille-text") return { code: 0, stdout: "", stderr: DIAG_STDERR };
        if (sherpa === "leer") return { code: 0, stdout: "", stderr: DIAG_STDERR };
        if (sherpa === "schlecht") return { code: 0, stdout: "0.1 -- 3.0: Hallo Welt, das ist etwas ganz anderes.\n", stderr: DIAG_STDERR };
        return { code: 0, stdout: GOOD_STDOUT, stderr: DIAG_STDERR };
      }
      return { code: -1, stdout: "", stderr: "Befehl nicht gefunden", spawnError: "ENOENT" };
    } finally {
      live--;
    }
  }) as ProcessWorld["run"];
  run.calls = calls;
  run.envs = envs;
  return { run, live: () => live };
}

export interface SpeechCtxOptions {
  platform?: NodeJS.Platform;
  arch?: string;
  ramBytes?: number;
  freeBytes?: number | null;
  programs?: string[];
  env?: string;
  settings?: string;
  overrides?: Partial<SetupContext>;
}

/** Setup-Kontext für den Schritt „sprache“ in einem frischen Testordner */
export async function speechCtx(o: SpeechCtxOptions = {}) {
  const programs = new Set(o.programs ?? ["ffmpeg"]);
  const ctx = await makeCtx({
    env: o.env ?? "",
    profile: PROFILE,
    ...(o.settings !== undefined ? { settings: o.settings } : {}),
    overrides: {
      platform: o.platform ?? "darwin",
      arch: o.arch ?? "arm64",
      totalMem: () => o.ramBytes ?? 16 * GIB,
      freeDisk: async () => (o.freeBytes === undefined ? 100_000_000_000 : o.freeBytes),
      which: cmd => (programs.has(cmd) ? `/usr/bin/${cmd}` : null),
      ...o.overrides,
    },
  });
  return ctx;
}

export function pathsOf(ctx: SetupContext, key: "osx-arm64" | "linux-x64" | "linux-aarch64" = "osx-arm64"): ParakeetPaths {
  return parakeetPaths(speechDir(ctx.root), key);
}

/** Legt die Dateien eines Artefakts direkt am Zielort an (wie nach einem früheren Lauf) */
export async function placeFiles(paths: ParakeetPaths, ids: ArtifactId[] = ["laufzeit", "vad", "modell"]): Promise<void> {
  const files: string[] = [];
  if (ids.includes("laufzeit")) files.push(paths.program, ...paths.libs);
  if (ids.includes("vad")) files.push(paths.vad);
  if (ids.includes("modell")) files.push(paths.tokens, paths.encoder, paths.decoder, paths.joiner);
  for (const f of files) {
    await mkdir(dirname(f), { recursive: true });
    await writeFile(f, `inhalt ${basename(f)}`);
  }
}

export async function readJson(path: string): Promise<any> {
  return JSON.parse(await readFile(path, "utf8"));
}
