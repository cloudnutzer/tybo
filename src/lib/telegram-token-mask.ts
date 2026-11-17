/**
 * Telegram-Bot-Tokens aus jeder Log-Ausgabe fernhalten (Issue #526).
 *
 * Ein Netzfehler beim Versand trägt die volle Adresse samt Token, etwa
 * `path: "https://api.telegram.org/bot<token>/sendMessage"`, und landete so
 * vollständig im Fehlerlog. Hier wird jedes Token ersetzt, der Pfad bleibt
 * lesbar: `bot<verborgen>/sendMessage`, `file/bot<verborgen>/…`.
 *
 * Erkannt wird zweierlei:
 * - das Muster eines Bot-Tokens (Bot-Kennung, Doppelpunkt, mindestens 30
 *   Zeichen aus A-Z, a-z, 0-9, _ und -), auch mit URL-kodiertem Doppelpunkt
 *   (`%3A`). So fallen auch Tokens auf, die nicht mehr in der Umgebung stehen;
 * - die Werte von TELEGRAM_BOT_TOKEN und allen TELEGRAM_BOT_TOKEN_* (Agenten-
 *   Bots), wörtlich und URL-kodiert, auch wenn sie vom Muster abweichen.
 *
 * Maskiert wird immer der fertige Text: formatLogArgs formatiert wie
 * console.log (verschachtelte Fehler, `cause`, zyklische Objekte) und
 * maskiert danach. Der Originalfehler bleibt unverändert, Fehlerklassifikation
 * und Wiederholungslogik sehen weiter das echte Objekt.
 */
import { Console } from "node:console";
import { EventEmitter } from "node:events";
import { format } from "node:util";

type Env = Record<string, string | undefined>;

export const TOKEN_MASK = "<verborgen>";

/** Bot-Token: Kennung, Doppelpunkt (auch %3A), geheimer Teil */
export const TOKEN_PATTERN = /(?<![0-9])[0-9]{5,}(?::|%3[Aa])[A-Za-z0-9_-]{30,}/g;

const TOKEN_NAME = /^TELEGRAM_BOT_TOKEN(?:_[A-Z0-9_]+)?$/;

/** Werte von TELEGRAM_BOT_TOKEN und TELEGRAM_BOT_TOKEN_* (Haupt- und Agenten-Bots) */
export function telegramTokensFromEnv(env: Env): string[] {
  const out = new Set<string>();
  for (const [name, value] of Object.entries(env)) {
    if (!TOKEN_NAME.test(name) || typeof value !== "string") continue;
    const token = value.trim();
    // Zu kurze Werte (Platzhalter, "x") würden harmlose Stellen treffen
    if (token.length >= 8) out.add(token);
  }
  return [...out];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Bekannte Werte wörtlich und URL-kodiert, längste zuerst */
function knownVariants(tokens: readonly string[]): string[] {
  const variants = new Set<string>();
  for (const token of tokens) {
    variants.add(token);
    variants.add(encodeURIComponent(token));
    variants.add(encodeURIComponent(token).replace(/%3A/g, "%3a"));
  }
  return [...variants].filter(v => v.length >= 8).sort((a, b) => b.length - a.length);
}

function knownPattern(variants: readonly string[]): RegExp | null {
  return variants.length ? new RegExp(variants.map(escapeRegExp).join("|"), "g") : null;
}

/** Text ohne Bot-Tokens; Pfade wie bot<verborgen>/sendMessage bleiben lesbar */
export function maskTelegramTokens(text: string, tokens: readonly string[] = []): string {
  const known = knownPattern(knownVariants(tokens));
  const out = known ? text.replace(known, TOKEN_MASK) : text;
  return out.replace(TOKEN_PATTERN, TOKEN_MASK);
}

/**
 * Tokens in der Form, in der sie in Bytes stehen, die als latin1 gelesen
 * wurden: UTF-8-Bytes, Zeichen für Zeichen. So lassen sich Bytes maskieren
 * und zählen, ohne sie zu verändern (latin1 bildet jedes Byte auf genau ein
 * Zeichen ab und zurück).
 */
export function latin1Tokens(tokens: readonly string[]): string[] {
  return tokens.map(token => Buffer.from(token, "utf8").toString("latin1"));
}

/** Zeichen, aus denen ein Token nach dem Muster besteht (auch %3A) */
const PATTERN_CHAR = /[A-Za-z0-9_:%-]/;
/** so viel bleibt bei einer erzwungenen Teilung mindestens hinten: länger als jedes Token samt Kodierung */
const TAIL_KEEP = 1024;

export type MaskRange = readonly [start: number, end: number];

/**
 * Bereiche [Anfang, Ende), die maskTelegramTokens ersetzen würde, aufsteigend
 * und ohne Überlappung: erst die bekannten Werte, dann das Muster in den
 * Lücken dazwischen. Das ist dieselbe Reihenfolge wie in maskTelegramTokens;
 * TOKEN_MASK beginnt und endet mit Zeichen außerhalb des Musters, also reicht
 * dort kein Treffer über eine ersetzte Stelle, und jede Lücke lässt sich für
 * sich durchsuchen.
 */
function rangesFor(text: string, variants: readonly string[]): MaskRange[] {
  const known = knownPattern(variants);
  const knownRanges: MaskRange[] = known ? [...text.matchAll(known)].map(m => [m.index, m.index + m[0].length] as const) : [];
  const out: MaskRange[] = [];
  let pos = 0;
  for (const range of [...knownRanges, [text.length, text.length] as const]) {
    for (const m of text.slice(pos, range[0]).matchAll(TOKEN_PATTERN)) out.push([pos + m.index, pos + m.index + m[0].length]);
    if (range[1] > range[0]) out.push(range);
    pos = range[1];
  }
  return out;
}

/** Fundstellen im ganzen Text, wie maskTelegramTokens sie ersetzt */
export function maskRanges(text: string, tokens: readonly string[] = []): MaskRange[] {
  return rangesFor(text, knownVariants(tokens));
}

/** Text bis end, jede Fundstelle (auch eine, die über end reicht) durch TOKEN_MASK ersetzt */
export function applyMaskRanges(text: string, ranges: readonly MaskRange[], end = text.length): string {
  let out = "";
  let pos = 0;
  for (const [s, e] of ranges) {
    if (s >= end) break;
    out += text.slice(pos, s) + TOKEN_MASK;
    pos = Math.min(e, end);
  }
  return out + text.slice(pos, end);
}

export interface TokenSafeSplit {
  /** bis hier ist der Text fertig, der Rest wartet auf weitere Zeichen */
  cut: number;
  /** Fundstellen, die vor cut beginnen (die letzte reicht im Ausnahmefall über cut) */
  ranges: MaskRange[];
}

/**
 * Stelle, an der sich ein Text teilen lässt, ohne dass ein Token über die
 * Grenze reicht, und die Fundstellen davor: Der vordere Teil wird mit
 * applyMaskRanges maskiert oder anhand von ranges gezählt, der hintere wartet
 * auf weitere Zeichen. Normalerweise ist das der Anfang des letzten Laufs aus
 * Zeichen, die zu einem Token gehören können (davor steht ein Zeilenende, ein
 * Leerzeichen, ein Schrägstrich o. Ä.).
 *
 * Ist dieser Lauf länger als maxTail (riesige Zeile ohne Trennzeichen), wird
 * in ihm geteilt, zunächst vor den letzten TAIL_KEEP Zeichen: Ein
 * unvollständiges Token am Ende ist kürzer und bleibt hinten. Die Fundstellen
 * kommen dabei aus dem ganzen Text, wie maskTelegramTokens sie sieht, und
 * überlappen sich nie. Liegt die Stelle in einer Fundstelle, kommt diese ganz
 * nach hinten oder, wenn sie am Anfang des Laufs beginnt, ganz nach vorne.
 * Nur eine Fundstelle, die am Anfang des Laufs beginnt und bis ans Ende
 * reicht (das Muster wächst vielleicht noch), wird geteilt: Vorne steht dann
 * ihr ganzer Anfang als TOKEN_MASK, hinten nur Zeichen, die ohne Kennung
 * und Doppelpunkt kein Token sind. So bleibt der wartende Rest immer kürzer
 * als maxTail plus das neue Stück.
 */
export function tokenSafeSplit(text: string, tokens: readonly string[], maxTail: number): TokenSafeSplit {
  const variants = knownVariants(tokens);
  const extra = new Set(variants.join(""));
  let run = text.length;
  while (run > 0) {
    const ch = text[run - 1]!;
    if (ch === "\n" || !(PATTERN_CHAR.test(ch) || extra.has(ch))) break;
    run--;
  }
  const keep = Math.max(TAIL_KEEP, (variants[0]?.length ?? 0) + 64);
  // Keine Fundstelle reicht über den Anfang des Laufs: alle ihre Zeichen gehören zum Lauf
  if (text.length - run <= Math.max(maxTail, keep)) return { cut: run, ranges: rangesFor(text.slice(0, run), variants) };
  const ranges = rangesFor(text, variants);
  let cut = text.length - keep;
  const inside = ranges.find(([s, e]) => s < cut && cut < e);
  if (inside) {
    const [s, e] = inside;
    if (s > run) cut = s;
    else if (e < text.length) cut = e;
  }
  return { cut, ranges: ranges.filter(([s]) => s < cut) };
}

/** true, wenn der Text ein Bot-Token enthält (Muster oder bekannter Wert) */
export function containsTelegramToken(text: string, tokens: readonly string[] = []): boolean {
  return maskTelegramTokens(text, tokens) !== text;
}

/** Wie console.log formatieren (Fehler samt Eigenschaften, cause, Zyklen), dann maskieren */
export function formatLogArgs(args: readonly unknown[], tokens: readonly string[] = []): string {
  return maskTelegramTokens(format(...args), tokens);
}

/** Eine Fehlermeldung für eine Logzeile: message bzw. String(), maskiert */
export function safeErrorMessage(error: unknown, tokens: readonly string[] = telegramTokensFromEnv(process.env)): string {
  const raw = error instanceof Error ? error.message : String(error);
  return maskTelegramTokens(raw, tokens);
}

/**
 * Kopie eines Werts für strukturierte Logs (Datenbank-Log): alle Zeichenketten
 * maskiert, Fehler als { name, message, stack, cause, … } mit allen eigenen
 * Eigenschaften (auch nicht aufzählbaren), Zyklen als "[Zyklus]". Das
 * Original wird nie verändert.
 */
export function maskDeep(value: unknown, tokens: readonly string[] = [], seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === "string") return maskTelegramTokens(value, tokens);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Zyklus]";
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map(item => maskDeep(item, tokens, seen));
    if (value instanceof Date) return value;
    const out: Record<string, unknown> = {};
    const keys = value instanceof Error ? new Set(["name", ...Object.getOwnPropertyNames(value)]) : new Set(Object.keys(value));
    for (const key of keys) {
      let item: unknown;
      try {
        item = (value as Record<string, unknown>)[key];
      } catch {
        continue;
      }
      if (typeof item === "function") continue;
      out[maskTelegramTokens(key, tokens)] = maskDeep(item, tokens, seen);
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

// ---------------------------------------------------------------------------
// Ausgabe des Bot-Prozesses
// ---------------------------------------------------------------------------

//
// write, end und das Leeren beim Prozessende teilen je Stream einen Puffer.
// Was am Ende eines write noch der Anfang eines Tokens sein kann, wartet
// auf weitere Daten (tokenSafeSplit). end verarbeitet den Abschlusschunk
// zusammen mit diesem Rest, bevor der native Stream endet. Bytes
// (Buffer, Uint8Array) werden als latin1 gelesen, maskiert und Byte für Byte
// unverändert weitergegeben, auch ein halbes UTF-8-Zeichen am Ende.
//
// Die console-Methoden von Bun schreiben nativ an stdout/stderr vorbei.
// Deshalb ersetzt installLogMask jede Methode des console-Objekts durch die
// eines Console aus node:console, das in genau diese write-Funktionen
// schreibt (log, error, dir, table, assert, count, group, time, …).
// console.write (nur Bun) geht direkt an stdout.write. Was übrig bleibt
// (Profiler, Heap-Snapshot), bekommt nur maskierte Kopien seiner Argumente.

const INSTALLED = Symbol.for("tybo.telegramTokenMask");
/** so lang darf ein Lauf aus Token-Zeichen ohne Trennzeichen höchstens warten */
const STREAM_MAX_TAIL = 16 * 1024;

type ConsoleLike = Record<string, unknown>;
interface WritableLike {
  write: (chunk: unknown, ...rest: unknown[]) => unknown;
  end?: (chunk?: unknown, ...rest: unknown[]) => unknown;
}

export interface LogMaskOptions {
  /** bekannte Tokens, bei jeder Ausgabe neu gelesen (die .env kann später geladen werden) */
  tokens?: () => readonly string[];
  console?: ConsoleLike;
  /** Standard: process.stdout, process.stderr */
  stdout?: WritableLike;
  stderr?: WritableLike;
}

const flushers: (() => void)[] = [];
let exitHookInstalled = false;
let crashHooksInstalled = false;

/**
 * Unbehandelte Fehler und Promise-Ablehnungen gibt Bun nativ aus, an console
 * und stdout/stderr.write vorbei, samt allen Eigenschaften und cause, also mit
 * vollem Token. Das gilt auch für ein throw oder await auf oberster Ebene
 * (Bun meldet beides als uncaughtException). Dieser Rückfall greift nur,
 * solange niemand sonst auf das Ereignis hört (der Bot meldet sich über
 * installSignalHandlers in src/app/lifecycle.ts an und beendet geordnet,
 * davor schützt nur er): Er gibt den Fehler maskiert auf stderr aus und
 * beendet wie Bun mit Code 1. Verschluckt wird nichts.
 */
function crashFallback(event: "uncaughtException" | "unhandledRejection", message: string) {
  return (reason: unknown): void => {
    if (process.listenerCount(event) > 1) return;
    logErrorMasked(message, reason);
    process.exit(1);
  };
}
const onUncaughtException = crashFallback("uncaughtException", "Uncaught exception:");
const onUnhandledRejection = crashFallback("unhandledRejection", "Unhandled rejection:");

/** Schreibt, was noch auf ein mögliches Token-Ende wartet, maskiert hinaus (beim Beenden des Prozesses) */
export function flushLogMask(): void {
  for (const flush of flushers) flush();
}

/** Zeichenkette oder Bytes als latin1-Text; undefined für alles andere */
function chunkAsLatin1(chunk: unknown, encoding: unknown): string | undefined {
  if (typeof chunk === "string") {
    const enc = typeof encoding === "string" && Buffer.isEncoding(encoding) ? encoding : "utf8";
    return Buffer.from(chunk, enc).toString("latin1");
  }
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString("latin1");
  if (chunk instanceof ArrayBuffer) return Buffer.from(chunk).toString("latin1");
  return undefined;
}

function maskStream(stream: WritableLike, tokens: () => readonly string[]): void {
  const marked = stream as WritableLike & { [INSTALLED]?: boolean };
  if (marked[INSTALLED]) return;
  const original = stream.write as (this: WritableLike, chunk: unknown, ...rest: unknown[]) => unknown;
  const originalEnd = stream.end;
  let pending = "";
  let ended = false;

  // Einziger Übergang vom ungeprüften Puffer zu ausgabefertigen Bytes.
  // Beim Abschluss gibt es keine nächste Portion mehr: auch ohne Trennzeichen
  // wird der ganze Rest maskiert. Danach darf nichts erneut gepuffert werden.
  function take(text: string, final = false): Buffer {
    pending += text;
    const known = latin1Tokens(tokens());
    if (final || ended) {
      const ready = maskTelegramTokens(pending, known);
      pending = "";
      return Buffer.from(ready, "latin1");
    }
    const { cut, ranges } = tokenSafeSplit(pending, known, STREAM_MAX_TAIL);
    const ready = applyMaskRanges(pending, ranges, cut);
    pending = pending.slice(cut);
    return Buffer.from(ready, "latin1");
  }

  stream.write = (chunk: unknown, ...rest: unknown[]) => {
    const text = chunkAsLatin1(chunk, rest[0]);
    if (text === undefined) return original.call(stream, chunk, ...rest);
    const callback = rest.find(r => typeof r === "function") as ((err?: Error | null) => void) | undefined;
    const ready = take(text);
    if (!ready.length && !ended) {
      if (callback) process.nextTick(callback);
      return true;
    }
    return original.call(stream, ready, ...(callback ? [callback] : []));
  };

  if (originalEnd) {
    stream.end = (chunk?: unknown, ...rest: unknown[]) => {
      const callback = [chunk, ...rest].find(arg => typeof arg === "function");
      const text = chunk == null || typeof chunk === "function" ? "" : chunkAsLatin1(chunk, rest[0]);
      if (text === undefined) return originalEnd.call(stream, chunk, ...rest);
      const ready = take(text, true);
      // Vor dem nativen end schließen: Manche Ströme rufen darin this.write
      // auf, andere (Bun) schreiben direkt. Beide erhalten nur fertige Bytes;
      // ein Rückruf in write darf sie nicht wieder bis zum Prozessende halten.
      ended = true;
      return originalEnd.call(stream, ready.length ? ready : undefined, ...(callback ? [callback] : []));
    };
  }

  flushers.push(() => {
    if (ended || !pending) return;
    original.call(stream, take("", true));
  });
  marked[INSTALLED] = true;
}

/** Alle Methodennamen eines console-Objekts, auch geerbte */
function methodNames(target: object): string[] {
  const names = new Set<string>();
  for (let o: object | null = target; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
    for (const key of Object.getOwnPropertyNames(o)) names.add(key);
  }
  return [...names].filter(name => name !== "constructor" && name !== "Console" && typeof (target as ConsoleLike)[name] === "function");
}

function maskConsole(target: ConsoleLike, stdout: WritableLike, stderr: WritableLike, tokens: () => readonly string[]): void {
  if ((target as { [INSTALLED]?: boolean })[INSTALLED]) return;
  // node:console braucht Ströme mit Ereignissen; write wird bei jedem Aufruf
  // neu nachgeschlagen und landet so in der maskierten Funktion
  const sink = (stream: WritableLike) =>
    Object.assign(new EventEmitter(), { write: (chunk: unknown, ...rest: unknown[]) => stream.write(chunk, ...rest) });
  const inner = new Console({ stdout: sink(stdout) as never, stderr: sink(stderr) as never, colorMode: false }) as unknown as ConsoleLike;
  for (const name of methodNames(target)) {
    const original = target[name] as (...args: unknown[]) => unknown;
    const replacement = inner[name];
    if (name === "write") {
      target.write = (...data: unknown[]) => {
        let bytes = 0;
        for (const item of data) {
          const chunk = typeof item === "string" || ArrayBuffer.isView(item) ? item : String(item);
          bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.byteLength;
          stdout.write(chunk);
        }
        return bytes;
      };
    } else if (name === "trace") {
      // console.trace von node:console verliert unter Bun die Meldung
      target.trace = (...args: unknown[]) => {
        const frames = (new Error().stack ?? "").split("\n").slice(2).join("\n");
        (inner.error as (...a: unknown[]) => void)("%s", `Trace: ${format(...args)}${frames ? `\n${frames}` : ""}`);
      };
    } else if (typeof replacement === "function") {
      target[name] = (...args: unknown[]) => (replacement as (...a: unknown[]) => unknown).apply(inner, args);
    } else {
      target[name] = (...args: unknown[]) => original.apply(target, args.map(arg => maskDeep(arg, tokens())));
    }
  }
  (target as { [INSTALLED]?: boolean })[INSTALLED] = true;
}

/**
 * Maskiert ab jetzt jede Ausgabe über console und über stdout/stderr, auch
 * Bytes und Tokens, die über write-/end-Aufrufe verteilt sind, und
 * unbehandelte Fehler und Promise-Ablehnungen (crashFallback), bis
 * installSignalHandlers übernimmt. Mehrfacher Aufruf wirkt einmal.
 */
export function installLogMask(options: LogMaskOptions = {}): void {
  const tokens = options.tokens ?? (() => telegramTokensFromEnv(process.env));
  const stdout = options.stdout ?? (process.stdout as unknown as WritableLike);
  const stderr = options.stderr ?? (process.stderr as unknown as WritableLike);
  maskStream(stdout, tokens);
  maskStream(stderr, tokens);
  maskConsole((options.console ?? console) as unknown as ConsoleLike, stdout, stderr, tokens);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once("exit", flushLogMask);
  }
  if (!crashHooksInstalled && !options.stdout && !options.stderr) {
    crashHooksInstalled = true;
    process.on("uncaughtException", onUncaughtException);
    process.on("unhandledRejection", onUnhandledRejection);
  }
}

/** console.error(message, error) ohne Token: Standard für logError in Telegram-Modulen */
export function logErrorMasked(message: string, error: unknown): void {
  console.error(formatLogArgs([message, error], telegramTokensFromEnv(process.env)));
}
