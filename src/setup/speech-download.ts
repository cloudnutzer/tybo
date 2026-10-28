/**
 * Laden und Ablegen der Parakeet-Artefakte (Issue #251).
 *
 * - Je Artefakt eine Teildatei <name>.part unter models/speech/, als Strom
 *   geschrieben (nie das ganze Archiv im Speicher).
 * - Netzfehler im selben Lauf: bis zu drei Wiederaufnahmen per Range. Antwortet
 *   der Server auf Range mit 200 oder mit falschem Content-Range, beginnt die
 *   Datei von vorn; auch das höchstens drei Mal (sonst ewige Neustarts bei
 *   einem Server, der dauerhaft zu viel liefert).
 * - Fließen IDLE_TIMEOUT_MS lang keine Bytes, gilt das als Netzfehler; ein
 *   langsamer, aber laufender Download bricht nicht ab.
 * - SHA-256 gegen die Konstante; Abweichung löscht die Teildatei.
 * - Erst nach geprüfter Summe entpacken (tar) in einen Temp-Ordner neben dem
 *   Ziel, dann per rename an den Zielort. Ein vorhandenes, unvollständiges
 *   Ziel wird erst danach ersetzt (beiseite, neu hinein, alt löschen); geht
 *   das schief, kommt das alte zurück.
 * - Abbruch und jedes Ende ohne Erfolg löschen alle Teildateien und
 *   Temp-Ordner dieses Laufs. Ein neuer Lauf räumt Reste früherer Läufe
 *   zuerst weg und beginnt von vorn.
 */

import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Artifact } from "../lib/speech/parakeet";
import type { CommandRunner, HttpFetch } from "./context";

/** Dateisystem des Downloads; Tests setzen Spione oder Fehler ein */
export interface DownloadFs {
  /** Löscht Datei oder Ordner samt Inhalt; fehlt er, passiert nichts */
  remove(path: string): Promise<void>;
  /** Öffnet zum Schreiben; fresh: vorher leeren, sonst anhängen */
  open(path: string, fresh: boolean): Promise<{ write(chunk: Uint8Array): Promise<void>; close(): Promise<void> }>;
  /** Größe in Byte; fehlt die Datei: 0 */
  size(path: string): Promise<number>;
  sha256(path: string): Promise<string>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(dir: string): Promise<string[]>;
}

export const nodeDownloadFs: DownloadFs = {
  remove: path => rm(path, { recursive: true, force: true }),
  async open(path, fresh) {
    const handle = await open(path, fresh ? "w" : "a", 0o600);
    return {
      async write(chunk) {
        let done = 0;
        while (done < chunk.length) done += (await handle.write(chunk, done, chunk.length - done)).bytesWritten;
      },
      close: () => handle.close(),
    };
  },
  async size(path) {
    try {
      return (await stat(path)).size;
    } catch {
      return 0;
    }
  },
  sha256: path =>
    new Promise((resolve, reject) => {
      const hash = createHash("sha256");
      createReadStream(path)
        .on("data", chunk => hash.update(chunk))
        .on("error", reject)
        .on("end", () => resolve(hash.digest("hex")));
    }),
  mkdir: async path => {
    await mkdir(path, { recursive: true });
  },
  rename: (from, to) => rename(from, to),
  async exists(path) {
    try {
      await stat(path);
      return true;
    } catch {
      return false;
    }
  },
  async list(dir) {
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  },
};

/** Ohne neue Bytes so lange: Netzfehler, dann Wiederaufnahme */
export const IDLE_TIMEOUT_MS = 60_000;
/** Höchstens so viele Wiederaufnahmen nach Netzfehlern je Artefakt */
export const MAX_RESUMES = 3;
/** Höchstens so viele Neustarts von vorn (zu lang, falsches Content-Range) je Artefakt */
export const MAX_RESTARTS = 3;
/** Obergrenze für einen ganzen Download (der Standard von ctx.fetch wären 15 Sekunden) */
const DOWNLOAD_LIMIT_MS = 6 * 60 * 60 * 1000;
/** Entpacken des Modells (rund 640 MB) */
const UNPACK_TIMEOUT_MS = 15 * 60 * 1000;

export interface DownloadDeps {
  fetch: HttpFetch;
  fs: DownloadFs;
  run: CommandRunner;
  signal: AbortSignal;
  /** Fortschritt in Byte; done kann nach einem Neubeginn kleiner werden */
  progress?(done: number, total: number): void;
  idleTimeoutMs?: number;
}

export type StepResult = { ok: true } | { ok: false; aborted: boolean; message: string };

const ABORTED: StepResult = { ok: false, aborted: true, message: "Abgebrochen." };

class NetError extends Error {}
class RestartError extends Error {}

function contentRangeOk(header: string | null, from: number, total: number): boolean {
  const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header?.trim() ?? "");
  return !!m && Number(m[1]) === from && Number(m[2]) === total - 1 && Number(m[3]) === total;
}

/**
 * Lädt ein Artefakt nach part und prüft die Summe. Wirft nie; bei Fehler
 * oder Abbruch ist part gelöscht.
 */
export async function downloadArtifact(art: Artifact<string>, part: string, deps: DownloadDeps): Promise<StepResult> {
  const { fs, signal } = deps;
  const idleMs = deps.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  await fs.remove(part);
  let resumes = 0;
  let restarts = 0;
  let fresh = true;
  let passed = false;
  try {
    for (;;) {
      if (signal.aborted) return ABORTED;
      const have = fresh ? 0 : await fs.size(part);
      try {
        await fetchInto(art, part, have, deps, idleMs);
        const size = await fs.size(part);
        if (size === art.bytes) break;
        // Zu lang: von vorn; zu kurz: wie ein abgerissener Download
        if (size > art.bytes) throw new RestartError();
        throw new NetError();
      } catch (e) {
        if (signal.aborted) return ABORTED;
        if (e instanceof HttpStatusError) return { ok: false, aborted: false, message: `${art.file}: der Server antwortete mit HTTP ${e.status}.` };
        if (e instanceof RestartError) {
          if (restarts >= MAX_RESTARTS) return { ok: false, aborted: false, message: `${art.file}: der Server lieferte mehrfach eine unpassende Datei (Größe oder Bereich falsch). Nichts wurde abgelegt.` };
          restarts++;
          fresh = true;
          continue;
        }
        if (resumes >= MAX_RESUMES) return { ok: false, aborted: false, message: `${art.file}: der Download brach mehrfach ab (Netz). Später noch einmal versuchen.` };
        resumes++;
        fresh = false;
      }
    }
    if (signal.aborted) return ABORTED;
    const sum = await fs.sha256(part);
    if (sum !== art.sha256) {
      return { ok: false, aborted: false, message: `${art.file}: die Prüfsumme stimmt nicht, die Datei wurde gelöscht. Nichts wurde abgelegt.` };
    }
    passed = !signal.aborted;
    return passed ? { ok: true } : ABORTED;
  } catch {
    return { ok: false, aborted: signal.aborted, message: `${art.file}: Schreiben der Teildatei fehlgeschlagen.` };
  } finally {
    // Nur ein geprüfter Download bleibt liegen (zum Entpacken)
    if (!passed) await fs.remove(part).catch(() => {});
  }
}

class HttpStatusError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
  }
}

/** Ein Abruf: schreibt ab have weiter oder (200, falsches Content-Range) von vorn */
async function fetchInto(art: Artifact<string>, part: string, have: number, deps: DownloadDeps, idleMs: number): Promise<void> {
  const idle = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => idle.abort(), idleMs);
  };
  arm();
  const signal = AbortSignal.any([deps.signal, idle.signal]);
  let res: Response;
  try {
    res = await deps.fetch(art.url, {
      timeoutMs: DOWNLOAD_LIMIT_MS,
      signal,
      headers: have > 0 ? { Range: `bytes=${have}-` } : {},
    });
  } catch {
    clearTimeout(timer);
    throw new NetError();
  }
  try {
    let fresh: boolean;
    if (have > 0 && res.status === 206) {
      if (!contentRangeOk(res.headers.get("content-range"), have, art.bytes)) {
        await res.body?.cancel().catch(() => {});
        throw new RestartError();
      }
      fresh = false;
    } else if (res.status === 200) {
      // Auch als Antwort auf Range: der ganze Inhalt, also von vorn
      fresh = true;
    } else {
      await res.body?.cancel().catch(() => {});
      throw new HttpStatusError(res.status);
    }
    if (!res.body) throw new NetError();
    const out = await deps.fs.open(part, fresh);
    let done = fresh ? 0 : have;
    deps.progress?.(done, art.bytes);
    const reader = res.body.getReader();
    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          throw new NetError();
        }
        // Abbruch oder Stillstand: cancel() beendet den Strom vorzeitig
        if (signal.aborted) throw new NetError();
        if (chunk.done) break;
        arm();
        await out.write(chunk.value);
        done += chunk.value.length;
        if (done > art.bytes) {
          reader.cancel().catch(() => {});
          throw new RestartError();
        }
        deps.progress?.(done, art.bytes);
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
      await out.close();
    }
  } finally {
    clearTimeout(timer);
  }
}

function suffix(): string {
  return randomBytes(4).toString("hex");
}

/** Teildateien und Temp-Ordner früherer Läufe */
export function isLeftover(name: string): boolean {
  return name.endsWith(".part") || name.startsWith(".tmp-");
}

export async function removeLeftovers(dir: string, fs: DownloadFs): Promise<void> {
  for (const name of await fs.list(dir)) if (isLeftover(name)) await fs.remove(join(dir, name));
}

/**
 * Legt ein geprüftes Artefakt ab: einzelne Datei per rename, Archiv über
 * einen Temp-Ordner neben dem Ziel. Danach ist part gelöscht.
 */
export async function placeArtifact(art: Artifact<string>, part: string, dir: string, deps: DownloadDeps): Promise<StepResult> {
  const { fs } = deps;
  const target = join(dir, art.target);
  if (!art.archiveDir) {
    // Ziel kann in einem Unterordner liegen (Piper-Stimme unter piper/)
    if (dirname(target) !== dir) await fs.mkdir(dirname(target));
    await fs.rename(part, target);
    return { ok: true };
  }
  const tmp = join(dir, `.tmp-${art.id}-${suffix()}`);
  try {
    await fs.mkdir(tmp);
    const res = await deps.run(["tar", "-xjf", part, "-C", tmp], { timeoutMs: UNPACK_TIMEOUT_MS, signal: deps.signal });
    if (deps.signal.aborted) return ABORTED;
    const unpacked = join(tmp, art.archiveDir);
    if (res.code !== 0 || !(await fs.exists(unpacked))) {
      return { ok: false, aborted: false, message: `${art.file}: Entpacken fehlgeschlagen (tar mit bzip2 nötig). Nichts wurde abgelegt.` };
    }
    await fs.remove(part);
    if (await fs.exists(target)) {
      // Unvollständiges Ziel: erst beiseite, dann das neue hinein, dann das alte weg
      const old = join(tmp, "alt");
      await fs.rename(target, old);
      try {
        await fs.rename(unpacked, target);
      } catch (e) {
        await fs.rename(old, target).catch(() => {});
        throw e;
      }
    } else {
      await fs.rename(unpacked, target);
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, aborted: deps.signal.aborted, message: `${art.file}: Ablegen fehlgeschlagen (${e instanceof Error ? e.name : "Fehler"}).` };
  } finally {
    await fs.remove(tmp);
  }
}

export interface InstallEvents<I extends string = string> {
  /** Beginn eines Artefakts (Index ab 0) */
  start?(art: Artifact<I>, index: number): void;
  progress?(art: Artifact<I>, done: number, total: number): void;
  unpack?(art: Artifact<I>): void;
}

/**
 * Lädt und legt die Artefakte der Reihe nach ab. Räumt vorher Reste früherer
 * Läufe weg; bei Fehler oder Abbruch alle Teildateien und Temp-Ordner. Schon
 * vollständig abgelegte Artefakte dieses Laufs bleiben (sie sind geprüft).
 */
export async function installArtifacts<I extends string>(dir: string, artifacts: Artifact<I>[], deps: DownloadDeps, events: InstallEvents<I> = {}): Promise<StepResult> {
  const { fs } = deps;
  await fs.mkdir(dir);
  await removeLeftovers(dir, fs);
  let ok = false;
  try {
    for (const [i, art] of artifacts.entries()) {
      if (deps.signal.aborted) return ABORTED;
      events.start?.(art, i);
      const part = join(dir, `${art.file}.part`);
      const got = await downloadArtifact(art, part, { ...deps, progress: (d, t) => events.progress?.(art, d, t) });
      if (!got.ok) return got;
      if (deps.signal.aborted) return ABORTED;
      events.unpack?.(art);
      const placed = await placeArtifact(art, part, dir, deps);
      if (!placed.ok) return placed;
    }
    ok = true;
    return { ok: true };
  } finally {
    if (!ok) await removeLeftovers(dir, fs);
  }
}

/** Platzbedarf in Byte: Archive plus entpackte Dateien (obere Grenze während des Entpackens), mit Reserve */
export const DISK_RESERVE_BYTES = 50_000_000;

export function diskNeeded(artifacts: Artifact<string>[]): number {
  if (!artifacts.length) return 0;
  return artifacts.reduce((sum, a) => sum + a.bytes + (a.archiveDir ? a.unpackedBytes : 0), 0) + DISK_RESERVE_BYTES;
}
