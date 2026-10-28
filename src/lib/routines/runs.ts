/**
 * Lauf-Protokoll der Routinen (Issue #285, Entscheidung 0025): je Routine
 * die letzten 20 Läufe unter data/routines/<id>.json, geschrieben vom
 * Wrapper src/routine-run.ts, gelesen von der Übersicht.
 *
 * Zugelassen ist eine id nur, wenn sie zur Routine passt (Label ai.tybo.*
 * oder ein Label bzw. Präfix aus config/routines.json, dieselbe Regel wie
 * die Übersicht) und als Dateiname nie aus data/routines/ herausführt.
 *
 * Datei: { "id": "<label>", "runs": [älteste … neueste] }. Geschrieben wird
 * unter Sperre (file-lock.ts) und atomar (atomic-file.ts); die Sperre hält
 * nur Lesen, Ergänzen und Schreiben, nie den Lauf selbst.
 */

import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { atomicWriteFile } from "../atomic-file";
import { acquireFileLock, releaseFileLock, type FileLockOptions } from "../file-lock";
import { createStreamMasker, maskSecrets, type SecretValue } from "../jobs/mask";
import { LAUNCHD_PREFIX } from "../service-names";
import { stripInvisibleChars } from "../telegram";
import { matchesRoutine, type RoutinesConfig } from "./config";

/** Ein Lauf, wie ihn der Wrapper festhält */
export interface RoutineRun {
  /** ISO-Zeitpunkt */
  startedAt: string;
  endedAt: string;
  durationMs: number;
  /**
   * Exit-Code des Befehls; endete er durch ein Signal, 128 + Signalnummer
   * (wie in der Shell), 127, wenn er nicht starten konnte
   */
  exitCode: number;
  /**
   * Signal, wenn der Lauf abgebrochen wurde: das Signal, das der Wrapper
   * weitergegeben hat (SIGTERM von launchd), sonst das, an dem der Befehl
   * endete. Fehlt bei einem normalen Ende.
   */
  signal?: string;
  /** Letzte Zeilen von stdout und stderr zusammen, maskiert, höchstens TAIL_MAX_LINES und TAIL_MAX_BYTES */
  tail: string[];
  logPath?: string;
}

export const RUNS_DIR = join("data", "routines");
export const MAX_RUNS = 20;
export const TAIL_MAX_LINES = 20;
export const TAIL_MAX_BYTES = 4096;

/** Zeichen, die ein Label haben darf; kein Schrägstrich, kein Backslash */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/;

/**
 * Taugt die id als Dateiname unter data/routines/? Nur Buchstaben, Ziffern,
 * Punkt, Unterstrich und Bindestrich, kein „..", danach noch einmal geprüft,
 * dass der aufgelöste Pfad direkt im Ordner liegt.
 */
export function safeRoutineId(id: string): boolean {
  if (!SAFE_ID.test(id) || id.includes("..")) return false;
  const dir = resolve("/", RUNS_DIR);
  const file = resolve(dir, `${id}.json`);
  return dirname(file) === dir && basename(file) === `${id}.json`;
}

/** Gehört die id zu einer Routine (ai.tybo.<name> oder config/routines.json) und ist sie als Dateiname sicher? */
export function routineIdAllowed(id: string, config: RoutinesConfig): boolean {
  // data/routines/alerts.json ist der Meldezustand (Issue #287), nie ein Protokoll
  if (!safeRoutineId(id) || id === "alerts") return false;
  if (id.startsWith(LAUNCHD_PREFIX) && id.length === LAUNCHD_PREFIX.length) return false;
  return matchesRoutine(id, LAUNCHD_PREFIX, config);
}

/** Pfad des Protokolls; wirft bei einer unsicheren id */
export function runsFile(projectRoot: string, id: string): string {
  if (!safeRoutineId(id)) throw new Error(`Ungültige Routinen-Kennung: ${id}`);
  return join(projectRoot, RUNS_DIR, `${id}.json`);
}

function isRun(value: unknown): value is RoutineRun {
  if (typeof value !== "object" || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.startedAt === "string" &&
    typeof r.endedAt === "string" &&
    typeof r.durationMs === "number" &&
    typeof r.exitCode === "number" &&
    Number.isInteger(r.exitCode) &&
    (r.signal === undefined || typeof r.signal === "string") &&
    Array.isArray(r.tail) &&
    r.tail.every(l => typeof l === "string") &&
    (r.logPath === undefined || typeof r.logPath === "string")
  );
}

/** Läufe aus dem Dateiinhalt, älteste zuerst; ungültige Einträge fallen weg, ungültiges JSON heißt leer */
export function parseRuns(content: string | null): RoutineRun[] {
  if (!content) return [];
  try {
    const data = JSON.parse(content);
    const runs = Array.isArray(data?.runs) ? data.runs : [];
    return runs.filter(isRun).slice(-MAX_RUNS);
  } catch {
    return [];
  }
}

export interface AppendRunOptions {
  lock?: FileLockOptions;
  /** Nur für Tests: schreibt statt atomicWriteFile */
  write?: (path: string, content: string) => Promise<void>;
}

/** Hängt einen Lauf an (höchstens MAX_RUNS bleiben), unter Sperre und atomar */
export async function appendRun(projectRoot: string, id: string, run: RoutineRun, options: AppendRunOptions = {}): Promise<void> {
  const file = runsFile(projectRoot, id);
  await mkdir(dirname(file), { recursive: true });
  const lockPath = `${file}.lock`;
  const me = await acquireFileLock(lockPath, { waitMs: 10_000, ...options.lock });
  try {
    const current = await readFile(file, "utf-8").catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    const runs = [...parseRuns(current), run].slice(-MAX_RUNS);
    const content = `${JSON.stringify({ id, runs }, null, 2)}\n`;
    await (options.write ?? atomicWriteFile)(file, content);
  } finally {
    await releaseFileLock(lockPath, me);
  }
}

/** Byte-Länge in UTF-8 */
function bytes(text: string): number {
  return Buffer.byteLength(text, "utf-8");
}

/** Schneidet auf höchstens max Bytes, nie mitten in einem Zeichen */
export function truncateBytes(text: string, max: number): string {
  if (bytes(text) <= max) return text;
  const mark = "…";
  let out = "";
  let size = bytes(mark);
  for (const ch of text) {
    const n = bytes(ch);
    if (size + n > max) break;
    out += ch;
    size += n;
  }
  return out + mark;
}

/** Steht im Protokoll statt der Ausgabe, wenn die .env nicht lesbar war (Masken unvollständig) */
export const TAIL_WITHHELD = "Ausgabe nicht festgehalten: .env nicht lesbar, Masken unvollständig.";

interface TailLine {
  /** Ankunft des Zeilenendes, über beide Ströme hinweg fortlaufend */
  seq: number;
  /** seq beim Beginn der Zeile; danach richtet sich, was zuerst Platz macht */
  since: number;
  text: string;
}

interface TailStream {
  decoder: TextDecoder;
  masker: ReturnType<typeof createStreamMasker>;
  partial: string;
  /** seq beim Beginn der angefangenen Zeile: wie alt sie gegenüber anderen Zeilen ist */
  since: number;
  /** seq der Rohtext-Umbrüche, die der Maskierer noch nicht ausgegeben hat */
  newlines: number[];
  /** Ersetzte Geheimnisse mit Umbrüchen im zuletzt maskierten Text: Stelle und Anzahl */
  cuts: { at: number; count: number }[];
  /** Versatz für onMask, wenn ein Text aus zwei Maskierer-Aufrufen besteht */
  base: number;
}

/** Anzahl der Zeilenumbrüche */
function newlineCount(text: string): number {
  let n = 0;
  for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) n++;
  return n;
}

/**
 * Die letzten Zeilen einer Ausgabe aus zwei Strömen. Jeder Strom wird erst
 * als UTF-8 dekodiert (auch über Stücke hinweg), dann maskiert
 * (createStreamMasker, ein Geheimnis über zwei Stücke wird erkannt), dann in
 * Zeilen geteilt; abgeschnitten wird erst danach. Leere Zeilen zählen nicht.
 *
 * Reihenfolge: Der Maskierer hält das Ende eines Stroms zurück, eine Zeile
 * kann also erst ankommen, wenn der andere Strom schon weiter ist. Jede
 * Zeile trägt deshalb die Ankunft ihres Zeilenumbruchs im Rohtext (seq) und
 * wird danach einsortiert. Enthält ein Geheimnis selbst Umbrüche, fehlen sie
 * in der maskierten Ausgabe; der Maskierer meldet jede Ersetzung (onMask),
 * und deren Umbrüche fallen an der richtigen Stelle aus der Warteschlange.
 * Sie hält so nur Umbrüche, die der Maskierer noch zurückhält.
 *
 * Grenzen gelten schon beim Sammeln: höchstens TAIL_MAX_LINES fertige
 * Zeilen, und fertige Zeilen und angefangene Zeilen aller Ströme zusammen
 * höchstens TAIL_MAX_BYTES (Umbrüche mitgezählt). Platz macht immer das
 * Älteste: die älteste fertige Zeile fällt weg, oder die angefangene Zeile,
 * die vor ihr begann, wird gekürzt oder verworfen. Neueste Ausgabe bleibt.
 */
export class TailCollector {
  private lines: TailLine[] = [];
  private lineBytes = 0;
  private seq = 0;
  private streams = new Map<string, TailStream>();

  constructor(private readonly secrets: readonly SecretValue[]) {}

  private stream(name: string): TailStream {
    let s = this.streams.get(name);
    if (!s) {
      const created: TailStream = {
        decoder: new TextDecoder("utf-8"),
        masker: createStreamMasker(this.secrets, (value, at) => {
          const count = newlineCount(value);
          if (count) created.cuts.push({ at: created.base + at, count });
        }),
        partial: "",
        since: 0,
        newlines: [],
        cuts: [],
        base: 0,
      };
      s = created;
      this.streams.set(name, s);
    }
    return s;
  }

  /** Rohtext eines Stroms annehmen: Umbrüche zählen, maskieren, in Zeilen teilen */
  private take(name: string, raw: string, final: boolean): void {
    const s = this.stream(name);
    for (let i = raw.indexOf("\n"); i !== -1; i = raw.indexOf("\n", i + 1)) s.newlines.push(++this.seq);
    s.cuts = [];
    s.base = 0;
    let text = s.masker.push(raw);
    if (final) {
      s.base = text.length;
      text += s.masker.end();
    }
    this.addText(s, text, final);
  }

  private dropCut(s: TailStream): void {
    const cut = s.cuts.shift()!;
    s.newlines.splice(0, cut.count);
  }

  private addText(s: TailStream, text: string, final: boolean): void {
    const all = s.partial + text;
    const offset = s.partial.length;
    // Die angefangene Zeile steckt jetzt in all, sie zählt nicht doppelt
    s.partial = "";
    let start = 0;
    for (let i = all.indexOf("\n"); i !== -1; i = all.indexOf("\n", start)) {
      // Umbrüche aus Geheimnissen vor diesem Umbruch gehören zu keiner Zeile
      while (s.cuts.length && s.cuts[0].at < i - offset) this.dropCut(s);
      const seq = s.newlines.shift() ?? ++this.seq;
      // Die erste Zeile setzt die angefangene fort und ist so alt wie sie
      this.addLine(all.slice(start, i), seq, start === 0 && offset > 0 ? s.since : seq);
      start = i + 1;
    }
    while (s.cuts.length) this.dropCut(s);
    // Ein Rest ohne Umbruch endet erst mit dem Strom, bekommt also eine neue seq
    const rest = all.slice(start);
    if (final) {
      const seq = ++this.seq;
      this.addLine(rest, seq, start === 0 && offset > 0 ? s.since : seq);
    } else {
      // Eine neu begonnene Zeile ist jünger als alles bisher Gesammelte
      if (rest && (start > 0 || offset === 0)) s.since = ++this.seq;
      s.partial = rest;
    }
    this.limit();
  }

  private addLine(raw: string, seq: number, since = seq): void {
    const line = raw.replace(/\r$/, "");
    if (line.trim() === "") return;
    const text = truncateBytes(line, TAIL_MAX_BYTES);
    let at = this.lines.length;
    while (at > 0 && this.lines[at - 1].seq > seq) at--;
    this.lines.splice(at, 0, { seq, since, text });
    this.lineBytes += bytes(text);
    this.limit();
  }

  /** Angefangene Zeilen aller Ströme: Bytes und Anzahl der nicht leeren */
  private partials(): { size: number; count: number } {
    let size = 0;
    let count = 0;
    for (const s of this.streams.values()) {
      if (!s.partial) continue;
      size += bytes(s.partial);
      count++;
    }
    return { size, count };
  }

  /** Fertige und angefangene Zeilen zusammen, als stünden sie untereinander */
  private total(): number {
    const p = this.partials();
    return this.lineBytes + p.size + Math.max(0, this.lines.length + p.count - 1);
  }

  /** Gemeinsame Grenze durchsetzen: das Älteste macht Platz, fertige Zeile oder angefangene */
  private limit(): void {
    while (this.lines.length > TAIL_MAX_LINES) this.lineBytes -= bytes(this.lines.shift()!.text);
    for (let excess = this.total() - TAIL_MAX_BYTES; excess > 0; excess = this.total() - TAIL_MAX_BYTES) {
      let oldest: TailStream | undefined;
      for (const s of this.streams.values()) if (s.partial && (!oldest || s.since < oldest.since)) oldest = s;
      let line = -1;
      for (let i = 0; i < this.lines.length; i++) if (line < 0 || this.lines[i].since < this.lines[line].since) line = i;
      if (line >= 0 && (!oldest || this.lines[line].since < oldest.since)) {
        this.lineBytes -= bytes(this.lines.splice(line, 1)[0].text);
        continue;
      }
      if (!oldest) break;
      const room = bytes(oldest.partial) - excess;
      oldest.partial = room < 16 ? "" : truncateBytes(oldest.partial, room);
    }
  }

  /** Was gerade gesammelt ist, in Bytes: fertige Zeilen, angefangene Zeilen aller Ströme, beides zusammen; dazu wartende Umbrüche */
  buffered(): { lines: number; partial: number; total: number; queued: number } {
    let queued = 0;
    for (const s of this.streams.values()) queued += s.newlines.length;
    return { lines: this.lineBytes + Math.max(0, this.lines.length - 1), partial: this.partials().size, total: this.total(), queued };
  }

  push(name: string, chunk: Uint8Array): void {
    const s = this.stream(name);
    this.take(name, stripInvisibleChars(s.decoder.decode(chunk, { stream: true })), false);
  }

  /** Eine fertige Zeile (etwa die Fehlermeldung, wenn der Befehl nicht startet) */
  note(line: string): void {
    this.addLine(maskSecrets(line, this.secrets), ++this.seq);
  }

  /** Ende aller Ströme: Reste ausgeben, dann höchstens TAIL_MAX_LINES Zeilen mit zusammen TAIL_MAX_BYTES */
  finish(): string[] {
    for (const [name, s] of this.streams) this.take(name, stripInvisibleChars(s.decoder.decode()), true);
    this.streams.clear();
    const out: string[] = [];
    let size = 0;
    for (let i = this.lines.length - 1; i >= 0; i--) {
      // Zeilenumbrüche zählen mit, als stünden die Zeilen untereinander in einer Datei
      const sep = out.length ? 1 : 0;
      const budget = TAIL_MAX_BYTES - size - sep;
      const full = maskSecrets(this.lines[i].text, this.secrets);
      // Eine Zeile, die ganz passt, kommt immer mit; gekürzt wird nur mit genug Platz
      if (bytes(full) > budget && budget < 16) break;
      const line = truncateBytes(full, budget);
      out.unshift(line);
      size += bytes(line) + sep;
      if (line !== full) break;
    }
    return out;
  }
}
