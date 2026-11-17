/**
 * Gescheiterter Start der Claude-CLI (Issue #565). Unter Linux ist der Befehl
 * claude selbst: fehlt das Programm, wirft schon der Start (ENOENT). Unter
 * macOS startet /usr/bin/caffeinate -i claude …; caffeinate läuft, findet
 * claude nicht und endet mit Exit-Code 127 ohne Ausgabe. Beides wird hier zu
 * derselben Diagnose.
 *
 * Nicht jeder Startfehler heißt „nicht installiert“: ein fehlendes
 * Arbeitsverzeichnis meldet Bun ebenfalls als ENOENT, eines, das eine Datei
 * ist, als ENOTDIR, ein Programm ohne
 * Ausführungsrecht als EACCES. Die Diagnose enthält nur kontrollierte Felder
 * (Fehlercode, Systemaufruf, eigener Text), nie die Meldung des Fehlers: die
 * kann Pfade oder Teile der Umgebung enthalten.
 */

import { statSync } from "node:fs";

export interface ClaudeStartFailure {
  /** not_installed: Programm nicht gefunden; other: anderer Startfehler */
  kind: "not_installed" | "other";
  /** Fehlercode wie ENOENT oder EACCES, nur in dieser Form; sonst fehlt er */
  code?: string;
  /** Systemaufruf wie posix_spawn, nur in dieser Form */
  syscall?: string;
  /** Exit-Code des Wrappers (macOS: caffeinate meldet 127) */
  exitCode?: number;
  /** Eigene Beschreibung auf Deutsch, ohne Pfade und ohne Fehlermeldung */
  reason: string;
}

/** Meldung an den Nutzer, einmal je Gespräch (Issue #565) */
export const CLAUDE_NOT_INSTALLED_NOTICE =
  "Claude Code ist auf diesem Rechner nicht installiert oder nicht im Suchpfad des Dienstes. Prüfen mit: tybo pruefen";

/** Exit-Code einer Shell bzw. von caffeinate, wenn das Programm fehlt */
export const COMMAND_NOT_FOUND_EXIT = 127;

const CODE_FORM = /^E[A-Z0-9]{2,15}$/;
const SYSCALL_FORM = /^[a-z_]{2,20}$/;

function field(err: unknown, name: "code" | "syscall"): unknown {
  return err && typeof err === "object" ? (err as Record<string, unknown>)[name] : undefined;
}

/** Fehlercode eines Fehlers, nur wenn er wie ENOENT aussieht; sonst undefined */
export function safeErrorCode(err: unknown): string | undefined {
  const code = field(err, "code");
  return typeof code === "string" && CODE_FORM.test(code) ? code : undefined;
}

export interface StartContext {
  /** Arbeitsverzeichnis des Laufs */
  cwd: string;
  /** Ist CLAUDE_PATH gesetzt? Dann steht das im Grund */
  customPath: boolean;
  /** Nur Tests: ob der Pfad ein vorhandenes Verzeichnis ist */
  isDirectory?: (dir: string) => boolean;
}

/** Ob der Pfad ein vorhandenes Verzeichnis ist; eine Datei zählt nicht */
function isExistingDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Diagnose für einen Wurf beim Start */
export function classifySpawnError(err: unknown, ctx: StartContext): ClaudeStartFailure {
  const code = safeErrorCode(err);
  const rawSyscall = field(err, "syscall");
  const syscall = typeof rawSyscall === "string" && SYSCALL_FORM.test(rawSyscall) ? rawSyscall : undefined;
  const base = { ...(code ? { code } : {}), ...(syscall ? { syscall } : {}) };
  const isDirectory = ctx.isDirectory ?? isExistingDirectory;
  if (code === "ENOENT" || code === "ENOTDIR") {
    // Fehlt das Arbeitsverzeichnis oder ist es eine Datei, wirft der Start ebenfalls ENOENT bzw. ENOTDIR
    if (!isDirectory(ctx.cwd)) return { kind: "other", ...base, reason: "Arbeitsverzeichnis des Laufs fehlt oder ist kein Verzeichnis" };
    return { kind: "not_installed", ...base, reason: notFoundReason(ctx.customPath) };
  }
  if (code === "EACCES" || code === "EPERM") {
    return { kind: "other", ...base, reason: ctx.customPath ? "CLAUDE_PATH ist nicht ausführbar" : "Claude CLI ist nicht ausführbar" };
  }
  return { kind: "other", ...base, reason: "Start der Claude CLI fehlgeschlagen" };
}

/**
 * Diagnose für einen Lauf, der zwar startete, aber nichts lieferte: Exit-Code
 * 127 ohne Ausgabe heißt, der Wrapper (caffeinate) fand das Programm nicht.
 * Sonst undefined.
 */
export function classifyExit(exitCode: number | null, stdout: string, ctx: Pick<StartContext, "customPath">): ClaudeStartFailure | undefined {
  if (exitCode !== COMMAND_NOT_FOUND_EXIT || stdout.trim() !== "") return undefined;
  return { kind: "not_installed", exitCode, reason: notFoundReason(ctx.customPath) };
}

function notFoundReason(customPath: boolean): string {
  return customPath ? "Programm aus CLAUDE_PATH nicht gefunden" : "claude nicht im PATH des Dienstes";
}

/** Eine Logzeile aus den kontrollierten Feldern */
export function startFailureLogText(f: ClaudeStartFailure): string {
  const parts = [f.reason, f.code ? `code=${f.code}` : "", f.syscall ? `syscall=${f.syscall}` : "", f.exitCode !== undefined ? `exit=${f.exitCode}` : ""];
  return parts.filter(Boolean).join(", ");
}

