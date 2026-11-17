/**
 * Nachtcheck (Issue #526): sucht in logs/ nach Telegram-Bot-Tokens.
 *
 * Geprüft wird jede Datei unter logs/, in Unterordnern jeder Tiefe, auch
 * die .gz-Archive der Logrotation. Erkannt wird das Muster eines Bot-Tokens
 * und jeder bekannte Wert aus TELEGRAM_BOT_TOKEN und TELEGRAM_BOT_TOKEN_*;
 * maskierte Pfade (bot<verborgen>/…) zählen nicht.
 *
 * Gelesen wird stückweise als Strom, auch beim Entpacken: Der Speicher
 * bleibt klein, egal wie groß eine Datei oder ein entpacktes Archiv ist.
 * Geteilt wird nie mitten in einem Token (tokenSafeSplit), auch nicht in
 * einer riesigen Zeile ohne Zeilenende.
 *
 * Was nicht vollständig geprüft werden kann, steht ausdrücklich als „nicht
 * geprüft“ mit Grund im Ergebnis, nie still übergangen: unlesbare Dateien
 * und Ordner, während der Prüfung verschwundene Einträge (Logrotation),
 * symbolische Links und andere Sonderdateien, Archive, die entpackt größer
 * als MAX_UNPACKED_BYTES wären, und alles, wofür das Zeitlimit nicht mehr
 * reicht. Ergebnis sind nur Dateinamen und Anzahl, nie eine Fundzeile: die
 * enthielte das Token.
 */
import { createReadStream, type Dirent } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { createGunzip } from "node:zlib";
import { join, relative } from "node:path";
import { latin1Tokens, maskRanges, tokenSafeSplit } from "./telegram-token-mask";

export const CHUNK_BYTES = 1024 * 1024;
/** so lang darf ein Lauf aus Token-Zeichen ohne Trennzeichen werden, bevor in ihm geteilt wird */
export const MAX_RUN_BYTES = 4 * CHUNK_BYTES;
/** Obergrenze für den entpackten Inhalt eines Archivs */
export const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
/** Zeitlimit der ganzen Prüfung, unter dem Zeitlimit des Nachtchecks (60 s) */
export const DEFAULT_DEADLINE_MS = 45_000;

export interface TokenScanResult {
  /** logs/ fehlt */
  missing: boolean;
  /** vollständig geprüfte Dateien */
  scanned: number;
  /** Datei (relativ zu logs/) und Anzahl Fundstellen */
  hits: { file: string; count: number }[];
  /** Datei oder Ordner (relativ zu logs/) und Grund */
  skipped: { file: string; reason: string }[];
}

export interface TokenScanOptions {
  /** Zeitlimit in ms ab Beginn der Prüfung */
  deadlineMs?: number;
  maxUnpackedBytes?: number;
  now?: () => number;
  /** für Tests: läuft vor dem Lesen jedes Unterordners und jeder Datei (Logrotation nachstellen) */
  beforeRead?: (path: string) => void | Promise<void>;
}

/**
 * Zählt Fundstellen in einem Strom aus Stücken; kein Token wird an einer
 * Stückgrenze geteilt. Gezählt wird, was maskTelegramTokens ersetzen würde
 * (dieselben Fundstellen, dieselbe Teilung wie bei der Ausgabe des Bots).
 */
export class StreamCounter {
  private carry = "";
  count = 0;
  constructor(private readonly tokens: readonly string[]) {}

  push(chunk: Buffer): void {
    const text = this.carry + chunk.toString("latin1");
    const { cut, ranges } = tokenSafeSplit(text, this.tokens, MAX_RUN_BYTES);
    this.count += ranges.length;
    this.carry = text.slice(cut);
  }

  end(): number {
    this.count += maskRanges(this.carry, this.tokens).length;
    this.carry = "";
    return this.count;
  }
}

class Stop extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

const code = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code;

const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MiB` : `${Math.round(bytes / 1024)} KiB`);

/** Fundstellen in einer Datei; wirft Stop, wenn sie nicht vollständig geprüft werden kann */
async function countInFile(
  path: string,
  tokens: readonly string[],
  limits: { maxUnpackedBytes: number; deadline: number; now: () => number }
): Promise<{ count: number; stop?: Stop }> {
  const counter = new StreamCounter(tokens);
  const source = createReadStream(path, { highWaterMark: CHUNK_BYTES });
  let stream: AsyncIterable<Buffer> = source;
  let gunzip: ReturnType<typeof createGunzip> | undefined;
  if (path.endsWith(".gz")) {
    gunzip = createGunzip({ chunkSize: 64 * 1024 });
    source.on("error", err => gunzip!.destroy(err));
    source.pipe(gunzip);
    stream = gunzip;
  }
  let unpacked = 0;
  try {
    for await (const chunk of stream) {
      if (gunzip) {
        unpacked += chunk.length;
        if (unpacked > limits.maxUnpackedBytes) {
          return { count: counter.end(), stop: new Stop(`entpackt größer als ${size(limits.maxUnpackedBytes)}, nur der Anfang geprüft`) };
        }
      }
      counter.push(chunk);
      if (limits.now() > limits.deadline) return { count: counter.end(), stop: new Stop("Zeitlimit erreicht, nur der Anfang geprüft") };
    }
    return { count: counter.end() };
  } finally {
    source.destroy();
    gunzip?.destroy();
  }
}

function reasonFor(err: unknown, what: "Datei" | "Ordner"): string {
  if (code(err) === "ENOENT") return "während der Prüfung verschwunden (Logrotation?)";
  if (code(err) === "Z_DATA_ERROR" || code(err) === "Z_BUF_ERROR" || /incorrect header|unexpected end|invalid/i.test(String((err as Error)?.message))) {
    return "kein gültiges Archiv";
  }
  return `${what} nicht lesbar`;
}

export async function scanLogsForTokens(logsDir: string, tokens: readonly string[] = [], options: TokenScanOptions = {}): Promise<TokenScanResult> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.deadlineMs ?? DEFAULT_DEADLINE_MS);
  const maxUnpackedBytes = options.maxUnpackedBytes ?? MAX_UNPACKED_BYTES;
  const known = latin1Tokens(tokens);
  const result: TokenScanResult = { missing: false, scanned: 0, hits: [], skipped: [] };
  const skip = (path: string, reason: string) => result.skipped.push({ file: relative(logsDir, path) || ".", reason });

  // Ordner der Reihe nach, ohne Tiefengrenze; symbolische Links werden nie
  // verfolgt, also gibt es keine Schleifen
  const dirs = [logsDir];
  const files: string[] = [];
  while (dirs.length) {
    const dir = dirs.shift()!;
    let entries: Dirent[];
    try {
      if (dir !== logsDir) await options.beforeRead?.(dir);
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (dir === logsDir && code(err) === "ENOENT") return { ...result, missing: true };
      skip(dir, reasonFor(err, "Ordner"));
      continue;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) dirs.push(path);
      else if (entry.isFile()) files.push(path);
      else if (entry.isSymbolicLink()) skip(path, "symbolischer Link, nicht verfolgt");
      else skip(path, "keine normale Datei");
    }
  }

  files.sort();
  for (const [i, path] of files.entries()) {
    if (now() > deadline) {
      for (const rest of files.slice(i)) skip(rest, "Zeitlimit erreicht");
      break;
    }
    const file = relative(logsDir, path);
    try {
      await options.beforeRead?.(path);
      // Zwischen Auflisten und Lesen kann die Logrotation die Datei ersetzt haben
      if (!(await lstat(path)).isFile()) {
        skip(path, "keine normale Datei mehr");
        continue;
      }
      const { count, stop } = await countInFile(path, known, { maxUnpackedBytes, deadline, now });
      if (count > 0) result.hits.push({ file, count });
      if (stop) skip(path, stop.reason);
      else result.scanned++;
    } catch (err) {
      skip(path, reasonFor(err, "Datei"));
    }
  }
  return result;
}

export interface TokenScanCheck {
  status: "ok" | "warn" | "na";
  detail: string;
  hint?: string;
}

/** Ergebnis für den Nachtcheck: nur Fundort und Anzahl */
export function evaluateTokenScan(scan: TokenScanResult): TokenScanCheck {
  if (scan.missing) return { status: "na", detail: "kein Ordner logs/" };
  const skipped = scan.skipped.length ? `; nicht geprüft: ${scan.skipped.map(s => `${s.file} (${s.reason})`).join(", ")}` : "";
  if (scan.hits.length) {
    const total = scan.hits.reduce((sum, h) => sum + h.count, 0);
    return {
      status: "warn",
      detail: `${total} Fundstelle(n) in ${scan.hits.map(h => `${h.file} (${h.count}x)`).join(", ")}${skipped}`,
      hint: "Token in den genannten Dateien maskieren oder die Dateien löschen; im Zweifel das Token bei @BotFather erneuern",
    };
  }
  if (scan.skipped.length) return { status: "warn", detail: `keine Fundstelle in ${scan.scanned} Datei(en)${skipped}` };
  return { status: "ok", detail: `keine Fundstelle in ${scan.scanned} Datei(en)` };
}
