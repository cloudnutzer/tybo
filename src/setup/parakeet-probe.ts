/**
 * Probe für Parakeet in der Einrichtung (Issue #251): direkt am Kandidaten
 * unter models/speech, nicht über available() (der Nachweis entsteht erst
 * hier).
 *
 * - Sprache: setup/assets/parakeet-probe-de.wav gegen den Solltext daneben.
 *   Bestanden bei einer Wortfehlerrate von höchstens 20 % nach
 *   Normalisierung (Kleinschreibung, ohne Satzzeichen, Ziffern als deutsche
 *   Zahlwörter wie im Solltext).
 * - Stille: zwei Sekunden Stille, im Code erzeugt; das Ergebnis muss leer
 *   sein.
 *
 * Die Prozesse laufen über ctx.run (in Tests eine Attrappe); Temp-Dateien
 * liegen in einem eigenen Ordner unter models/speech und werden immer
 * gelöscht.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type ParakeetPaths,
  type PlatformKey,
  silenceWav,
  transcribeWithSherpa,
} from "../lib/speech/parakeet";
import type { RunFn } from "../lib/speech/process";
import { SpeechError } from "../lib/speech/types";
import type { SetupContext } from "./context";

export const PROBE_WAV = join(import.meta.dir, "..", "..", "setup", "assets", "parakeet-probe-de.wav");
export const PROBE_TEXT = join(import.meta.dir, "..", "..", "setup", "assets", "parakeet-probe-de.txt");
/** Höchste Wortfehlerrate, bei der die Probe besteht */
export const MAX_WER = 0.2;

const ONES = ["null", "eins", "zwei", "drei", "vier", "fünf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwölf", "dreizehn", "vierzehn", "fünfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn"];
const TENS = ["", "", "zwanzig", "dreißig", "vierzig", "fünfzig", "sechzig", "siebzig", "achtzig", "neunzig"];

/** Ganze Zahl von 0 bis 999 als deutsches Zahlwort; größere bleiben Ziffern */
export function germanNumber(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 999) return String(n);
  if (n < 20) return ONES[n];
  if (n < 100) {
    const one = n % 10;
    const ten = TENS[Math.floor(n / 10)];
    return one === 0 ? ten : `${one === 1 ? "ein" : ONES[one]}und${ten}`;
  }
  const rest = n % 100;
  const hundreds = Math.floor(n / 100);
  return `${hundreds === 1 ? "ein" : ONES[hundreds]}hundert${rest ? germanNumber(rest) : ""}`;
}

/** Wörter nach Normalisierung: klein, ohne Satzzeichen, Ziffern ausgeschrieben */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\d+/g, d => ` ${germanNumber(Number(d))} `)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

/** Wortfehlerrate: Einfügungen, Auslassungen und Ersetzungen geteilt durch die Wörter des Solltexts */
export function wordErrorRate(reference: string, hypothesis: string): number {
  const ref = normalizeWords(reference);
  const hyp = normalizeWords(hypothesis);
  if (!ref.length) return hyp.length ? 1 : 0;
  let prev = Array.from({ length: hyp.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ref.length; i++) {
    const cur = [i];
    for (let j = 1; j <= hyp.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ref[i - 1] === hyp[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[hyp.length] / ref.length;
}

/** ctx.run als RunFn für die Erkennung (Umgebung ergänzt, nicht ersetzt) */
export function runFnFromContext(ctx: SetupContext): RunFn {
  return async (cmd, o) => {
    let env: Record<string, string> | undefined;
    if (o.env) {
      env = {};
      // replaceEnv (Klon-Engines, Issue #253): nur die übergebene Umgebung
      if (!o.replaceEnv) for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
      Object.assign(env, o.env);
    }
    const r = await ctx.run(cmd, {
      timeoutMs: o.timeoutMs,
      ...(o.signal ? { signal: o.signal } : {}),
      ...(env ? { env } : {}),
      ...(o.cwd ? { cwd: o.cwd } : {}),
    });
    return { exitCode: r.spawnError ? null : r.code, stdout: r.stdout, stderr: r.stderr, timedOut: !!r.timedOut || !!r.aborted };
  };
}

export type ProbeOutcome =
  | { ok: true; text: string; ms: number; wer: number }
  | { ok: false; aborted: boolean; message: string; text?: string; ms?: number; wer?: number };

function percent(x: number): string {
  return `${Math.round(x * 100)} %`;
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1).replace(".", ",")} s`;
}

export function describeProbe(p: { text: string; ms: number; wer: number }): string {
  return `Erkannt in ${seconds(p.ms)}: „${p.text}“ (Wortfehlerrate ${percent(p.wer)}).`;
}

/** Probe mit Sprache und mit Stille am Kandidaten; wirft nie */
export async function probeCandidate(ctx: SetupContext, paths: ParakeetPaths, key: PlatformKey, signal: AbortSignal, threads = 2): Promise<ProbeOutcome> {
  const tmpDir = join(paths.dir, `.tmp-probe-${randomBytes(4).toString("hex")}`);
  const now = () => ctx.now().getTime();
  const deps = {
    run: runFnFromContext(ctx),
    which: (cmd: string) => (ctx.which ?? Bun.which)(cmd),
    writeFile: (p: string, data: Buffer) => writeFile(p, data),
    unlink: (p: string) => rm(p, { force: true }),
    mkdir: async (p: string) => {
      await mkdir(p, { recursive: true });
    },
  };
  const exists = existsSync;
  const job = (unique: string) => ({ paths, key, tmpDir, unique, ext: "wav", threads, signal, now });
  try {
    let audio: Buffer;
    let expected: string;
    try {
      audio = await readFile(PROBE_WAV);
      expected = (await readFile(PROBE_TEXT, "utf8")).trim();
    } catch {
      return { ok: false, aborted: false, message: "Die Probe-Aufnahme fehlt (setup/assets)." };
    }
    const start = now();
    let text: string;
    try {
      text = await transcribeWithSherpa(audio, job("sprache"), deps, exists);
    } catch (e) {
      if (signal.aborted) return { ok: false, aborted: true, message: "Abgebrochen." };
      return { ok: false, aborted: false, message: `Probe nicht bestanden: Parakeet hat die Probe-Aufnahme nicht erkannt (${probeError(e)}).` };
    }
    const ms = now() - start;
    const wer = wordErrorRate(expected, text);
    if (wer > MAX_WER) {
      return { ok: false, aborted: false, text, ms, wer, message: `Probe nicht bestanden: ${describeProbe({ text, ms, wer })} Erlaubt sind höchstens ${percent(MAX_WER)}.` };
    }
    try {
      const heard = await transcribeWithSherpa(silenceWav(2), job("stille"), deps, exists);
      return { ok: false, aborted: false, text, ms, wer, message: `Stille-Probe nicht bestanden: in zwei Sekunden Stille wurden ${normalizeWords(heard).length} Wörter erkannt.` };
    } catch (e) {
      if (signal.aborted) return { ok: false, aborted: true, message: "Abgebrochen." };
      if (!(e instanceof SpeechError && e.kind === "empty")) {
        return { ok: false, aborted: false, text, ms, wer, message: `Stille-Probe nicht bestanden (${probeError(e)}).` };
      }
    }
    return { ok: true, text, ms, wer };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Art des Fehlers in Klartext, nie Ausgabe des Programms */
function probeError(e: unknown): string {
  if (!(e instanceof SpeechError)) return "interner Fehler";
  switch (e.kind) {
    case "exit":
      return `Programm endete mit Exit-Code ${e.code ?? "?"}`;
    case "timeout":
      return "Zeitlimit";
    case "empty":
      return "kein Text erkannt";
    case "unavailable":
      return "Dateien fehlen";
    case "format":
      return "Format nicht lesbar";
    default:
      return e.kind;
  }
}
