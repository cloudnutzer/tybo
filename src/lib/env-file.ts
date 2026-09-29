/**
 * .env lesen und sicher schreiben (Issue #62, Schutzregeln in docs/webui/SPEC.md,
 * Entscheidung 0003). Grundlage für die Schlüssel-Seite (M6) und den
 * Einrichtungsassistenten (M8).
 *
 * Lesen: parseEnvContent ist der eine Parser für src/lib/env.ts und
 * scripts/tybo.ts. Wie bisher: Zeilen mit # am Anfang sind Kommentare, der
 * Name steht vor dem ersten =, der Wert wird getrimmt, die letzte Zeile
 * eines Namens gewinnt, ein # mitten im Wert gehört zum Wert. Neu: ein Wert
 * ganz in '...' steht wörtlich ohne die Anführungszeichen, ein Wert ganz in
 * "..." ebenso, dort mit \\ und \" als Maskierung. Folgt auf den Wert in
 * Anführungszeichen Leerraum und #, ist der Rest ein Inline-Kommentar. So
 * ergibt Schreiben und anschließendes Laden denselben Wert.
 *
 * Schreiben (setEnvValue, deleteEnvValue, updateEnvValues):
 * - Nur die betroffene Zeile ändert sich; Kommentare, Leerzeilen,
 *   Reihenfolge, CRLF und ein fehlender Schlussumbruch bleiben.
 * - Ein Inline-Kommentar der ersetzten Zeile bleibt stehen; der neue Wert
 *   steht dann in Anführungszeichen, damit er beim Laden nicht dazugehört.
 * - Neue Namen landen hinter der letzten gesetzten Variable derselben Gruppe
 *   (groupOf), sonst am Dateiende.
 * - Steht ein Name mehrfach da, wird die letzte (wirksame) Zeile ersetzt und
 *   die übrigen entfernt; Löschen entfernt alle. Auskommentierte Zeilen
 *   bleiben unberührt.
 * - Vor jedem Schreiben eine Sicherung nach data/backups/env-<zeit> (0600),
 *   dann temporäre Datei (von Anfang an 0600, im selben Ordner) und
 *   Umbenennen. Scheitert ein Schritt, bleibt die .env unverändert.
 * - Lesen, Ändern und Schreiben laufen unter einer Sperre (<pfad>.lock,
 *   auch zwischen Prozessen), damit keine Änderung verloren geht.
 * - Werte mit Zeilenumbruch oder Steuerzeichen werden abgelehnt.
 *
 * Welche Namen geändert werden dürfen, entscheidet der Aufrufer
 * (src/web/keys.ts mit src/web/key-catalog.ts); diese Datei kennt keine
 * Sperrliste, damit der Einrichtungsmodus (M8) sie mit eigenen Regeln nutzen kann.
 * Fehlermeldungen enthalten nie Werte.
 */

import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ENV_NAME_PATTERN, envValueProblem } from "../web/env-rules";
import { acquireFileLock, releaseFileLock } from "./file-lock";

export { ENV_NAME_PATTERN, envValueProblem, MAX_ENV_VALUE_LENGTH } from "../web/env-rules";

export class EnvFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvFileError";
  }
}

// ---------------------------------------------------------------------------
// Lesen
// ---------------------------------------------------------------------------

/** Wert in Anführungszeichen, danach ein Inline-Kommentar (Leerraum, dann #) */
const QUOTED_WITH_COMMENT = /^(?:'([^']*)'|"((?:[^"\\]|\\.)*)")(\s+#.*)$/;

/** Wert einer Zeile nach dem ersten =, wie ihn alle Lader sehen */
export function parseEnvValue(raw: string): string {
  const t = raw.trim();
  const commented = QUOTED_WITH_COMMENT.exec(t);
  if (commented) return commented[1] ?? commented[2].replace(/\\(["\\])/g, "$1");
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1);
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(["\\])/g, "$1");
  return t;
}

/** Name einer aktiven Zeile oder null (Kommentar, Leerzeile, kein =) */
function lineKey(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const eq = trimmed.indexOf("=");
  if (eq < 0) return null;
  const key = trimmed.slice(0, eq).trim();
  return key || null;
}

/** Alle Variablen einer .env; die letzte Zeile eines Namens gewinnt */
export function parseEnvContent(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const key = lineKey(line);
    if (!key) continue;
    const trimmed = line.trim();
    out[key] = parseEnvValue(trimmed.slice(trimmed.indexOf("=") + 1));
  }
  return out;
}

/** Liest die Datei; fehlt sie, ist das Ergebnis leer */
export async function readEnvFile(path: string): Promise<Record<string, string>> {
  try {
    return parseEnvContent(await readFile(path, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return {};
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Werte prüfen und kodieren
// ---------------------------------------------------------------------------

const PLAIN_VALUE = /^[A-Za-z0-9_\-.:/+=@,~%]+$/;

/**
 * Wert so, wie er hinter NAME= steht; wirft bei ungültigen Werten. Mit
 * comment (Inline-Kommentar samt führendem Leerraum) immer in
 * Anführungszeichen, damit der Lader den Kommentar vom Wert trennt.
 */
export function encodeEnvValue(value: string, comment = ""): string {
  const problem = envValueProblem(value);
  if (problem) throw new EnvFileError(problem);
  let encoded: string;
  if (PLAIN_VALUE.test(value) && !comment) encoded = value;
  else if (!value.includes("'")) encoded = `'${value}'`;
  else encoded = `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  encoded += comment;
  // Sicherheitsnetz: was geschrieben wird, muss genau so wieder geladen werden
  if (parseEnvValue(encoded) !== value) throw new EnvFileError("Der Wert lässt sich nicht sicher speichern");
  return encoded;
}

/**
 * Inline-Kommentar einer Zeile samt führendem Leerraum oder "". Bei Werten
 * ohne Anführungszeichen beginnt er beim ersten # nach Leerraum; der Lader
 * rechnet ihn dort weiter zum Wert, beim Ersetzen bleibt er trotzdem stehen.
 */
function inlineComment(text: string): string {
  const raw = text.slice(text.indexOf("=") + 1).trim();
  const commented = QUOTED_WITH_COMMENT.exec(raw);
  if (commented) return commented[3];
  if (raw.length >= 2 && (raw[0] === "'" || raw[0] === '"') && raw.endsWith(raw[0])) return "";
  const at = raw.search(/\s+#/);
  return at < 0 ? "" : raw.slice(at);
}

// ---------------------------------------------------------------------------
// Inhalt ändern (ohne Dateizugriff)
// ---------------------------------------------------------------------------

interface Line {
  text: string;
  eol: string;
}

function splitLines(content: string): Line[] {
  if (content === "") return [];
  const parts = content.split("\n");
  const lines: Line[] = parts.map((text, i) => {
    if (i === parts.length - 1) return { text, eol: "" };
    return text.endsWith("\r") ? { text: text.slice(0, -1), eol: "\r\n" } : { text, eol: "\n" };
  });
  // Endet die Datei mit einem Umbruch, ist der letzte Teil leer
  if (lines[lines.length - 1].text === "") lines.pop();
  return lines;
}

function joinLines(lines: Line[]): string {
  return lines.map(l => l.text + l.eol).join("");
}

export interface EnvChangeOptions {
  /** Gruppe eines Namens für die Einfügeposition neuer Einträge; undefined heißt Dateiende */
  groupOf?(name: string): string | undefined;
}

export interface EnvChange {
  content: string;
  changed: boolean;
}

function checkName(name: string): void {
  if (!ENV_NAME_PATTERN.test(name)) throw new EnvFileError("Ungültiger Variablenname");
}

/** Setzt name auf value (value null: entfernen). Rein, für Tests und M8. */
export function applyEnvChange(content: string, name: string, value: string | null, options: EnvChangeOptions = {}): EnvChange {
  checkName(name);
  const lines = splitLines(content);
  const hits: number[] = [];
  lines.forEach((l, i) => {
    if (lineKey(l.text) === name) hits.push(i);
  });

  if (value === null) {
    if (hits.length === 0) return { content, changed: false };
    const drop = new Set(hits);
    const kept = lines.filter((_, i) => !drop.has(i));
    // War die letzte Zeile ohne Umbruch betroffen, bleibt die Datei ohne Schlussumbruch
    if (drop.has(lines.length - 1) && lines[lines.length - 1].eol === "" && kept.length > 0) {
      kept[kept.length - 1] = { ...kept[kept.length - 1], eol: "" };
    }
    return { content: joinLines(kept), changed: true };
  }

  const text = `${name}=${encodeEnvValue(value)}`;
  const eol = lines.find(l => l.eol)?.eol ?? "\n";

  if (hits.length > 0) {
    const last = hits[hits.length - 1];
    const drop = new Set(hits.slice(0, -1));
    // Inline-Kommentar der ersetzten Zeile bleibt stehen
    const comment = inlineComment(lines[last].text.trim());
    const replaced = comment ? `${name}=${encodeEnvValue(value, comment)}` : text;
    const next: Line[] = [];
    lines.forEach((l, i) => {
      if (drop.has(i)) return;
      next.push(i === last ? { text: replaced, eol: l.eol } : l);
    });
    const result = joinLines(next);
    return { content: result, changed: result !== content };
  }

  // Neu: hinter die letzte Variable derselben Gruppe, sonst ans Ende
  const group = options.groupOf?.(name);
  let at = lines.length - 1;
  if (group !== undefined) {
    for (let i = lines.length - 1; i >= 0; i--) {
      const key = lineKey(lines[i].text);
      if (key && options.groupOf!(key) === group) {
        at = i;
        break;
      }
    }
  }
  const next = lines.slice();
  if (at < 0) {
    next.push({ text, eol });
  } else if (next[at].eol === "") {
    // Letzte Zeile ohne Umbruch: sie bekommt einen, die neue bleibt ohne
    next[at] = { ...next[at], eol };
    next.splice(at + 1, 0, { text, eol: "" });
  } else {
    next.splice(at + 1, 0, { text, eol });
  }
  return { content: joinLines(next), changed: true };
}

// ---------------------------------------------------------------------------
// Datei schreiben
// ---------------------------------------------------------------------------

/** Dateioperationen, in Tests austauschbar (Fehlerfälle) */
export interface EnvFileIo {
  writeFile(path: string, data: string, options: { mode: number; flag: string }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
}

const defaultIo: EnvFileIo = {
  writeFile: (path, data, options) => writeFile(path, data, options),
  rename: (from, to) => rename(from, to),
};

export interface EnvWriteOptions extends EnvChangeOptions {
  /** Ordner der Sicherungen, Standard data/backups neben der .env */
  backupDir?: string;
  now?(): Date;
  io?: Partial<EnvFileIo>;
  /** Wartezeit auf die Sperre in Millisekunden */
  lockWaitMs?: number;
}

export interface EnvWriteResult {
  /** false: Datei war schon so, nichts geschrieben */
  changed: boolean;
  /** Pfad der Sicherung; null ohne Schreiben oder bei neu angelegter Datei */
  backup: string | null;
}

export function defaultBackupDir(envPath: string): string {
  return join(dirname(envPath), "data", "backups");
}

function backupStamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/** Legt die Sicherung mit eindeutigem Namen an (nie überschreiben), Rechte 0600 */
async function writeBackup(dir: string, content: string, date: Date, io: EnvFileIo): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const base = join(dir, `env-${backupStamp(date)}`);
  for (let n = 1; n < 1000; n++) {
    const path = n === 1 ? base : `${base}-${n}`;
    try {
      await io.writeFile(path, content, { mode: 0o600, flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === "EEXIST") continue;
      throw e;
    }
    await chmod(path, 0o600);
    return path;
  }
  throw new EnvFileError("Keine freie Sicherungsdatei");
}

/** Liest die Datei; null, wenn sie fehlt. Verweise werden nicht beschrieben. */
async function readCurrent(path: string): Promise<string | null> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new EnvFileError(".env ist ein Verweis, wird nicht verändert");
    if (!info.isFile()) throw new EnvFileError(".env ist keine Datei");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    throw e;
  }
  return readFile(path, "utf8");
}

const queues = new Map<string, Promise<unknown>>();

/** Hintereinander im Prozess, dazu die Dateisperre gegen andere Prozesse */
function serialized<T>(path: string, lockWaitMs: number | undefined, fn: () => Promise<T>): Promise<T> {
  const run = (queues.get(path) ?? Promise.resolve())
    .catch(() => {})
    .then(async () => {
      const lock = `${path}.lock`;
      const owner = await acquireFileLock(lock, lockWaitMs === undefined ? {} : { waitMs: lockWaitMs });
      try {
        return await fn();
      } finally {
        await releaseFileLock(lock, owner);
      }
    });
  queues.set(path, run);
  run.finally(() => {
    if (queues.get(path) === run) queues.delete(path);
  }).catch(() => {});
  return run;
}

async function modify(
  path: string,
  changes: ReadonlyArray<readonly [string, string | null]>,
  options: EnvWriteOptions,
  /** Unter der Sperre geprüft: false heißt, nichts schreiben */
  guard?: (current: Record<string, string>) => boolean,
): Promise<EnvWriteResult> {
  // früh ablehnen, vor Sperre und Sicherung
  for (const [name, value] of changes) {
    checkName(name);
    if (value !== null) encodeEnvValue(value);
  }
  const io: EnvFileIo = { ...defaultIo, ...options.io };
  return serialized(path, options.lockWaitMs, async () => {
    const current = await readCurrent(path);
    if (guard && !guard(parseEnvContent(current ?? ""))) return { changed: false, backup: null };
    let content = current ?? "";
    let changed = false;
    for (const [name, value] of changes) {
      const change = applyEnvChange(content, name, value, options);
      content = change.content;
      changed ||= change.changed;
    }
    if (!changed || content === (current ?? "")) return { changed: false, backup: null };

    const backup =
      current === null
        ? null
        : await writeBackup(options.backupDir ?? defaultBackupDir(path), current, options.now?.() ?? new Date(), io);

    const temp = join(dirname(path), `.env.${randomUUID()}.tmp`);
    try {
      await io.writeFile(temp, content, { mode: 0o600, flag: "wx" });
      await chmod(temp, 0o600);
      await io.rename(temp, path);
    } finally {
      await unlink(temp).catch(() => {});
    }
    return { changed: true, backup };
  });
}

/** Setzt einen Wert; legt die Datei an, wenn sie fehlt (dann ohne Sicherung) */
export function setEnvValue(path: string, name: string, value: string, options: EnvWriteOptions = {}): Promise<EnvWriteResult> {
  return modify(path, [[name, value]], options);
}

/** Entfernt alle aktiven Zeilen des Namens; changed false, wenn er nicht gesetzt war */
export function deleteEnvValue(path: string, name: string, options: EnvWriteOptions = {}): Promise<EnvWriteResult> {
  return modify(path, [[name, null]], options);
}

/**
 * Mehrere Werte in einem Schritt (Einrichtung, M8): eine Sicherung, ein
 * atomares Ersetzen; null entfernt den Namen. Ungültige Namen oder Werte
 * lehnen alles ab, bevor etwas geschrieben wird.
 */
export function updateEnvValues(
  path: string,
  changes: ReadonlyArray<readonly [string, string | null]>,
  options: EnvWriteOptions = {},
): Promise<EnvWriteResult> {
  return modify(path, changes, options);
}

/**
 * Setzt die Werte nur, wenn unter der Sperre noch keiner der Namen einen
 * Wert hat (Push-Schlüssel, Issue #225): Starten Bot und Einrichtung
 * gleichzeitig, gewinnt der erste, der zweite ändert nichts. Vorhandene
 * Werte werden nie ersetzt, auch nicht, wenn nur einer davon fehlt.
 */
export function addEnvValuesIfMissing(
  path: string,
  values: ReadonlyArray<readonly [string, string]>,
  options: EnvWriteOptions = {},
): Promise<EnvWriteResult> {
  return modify(path, values, options, current => values.every(([name]) => (current[name] ?? "").trim() === ""));
}
