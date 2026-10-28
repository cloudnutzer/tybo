/**
 * Wrapper vor eine bestehende Plist setzen und wieder entfernen (Issue #286,
 * Entscheidung 0025). Reine Funktionen ohne Dateien und Befehle: sie prüfen
 * eine Plist (als Objekt aus `plutil -convert json`) und liefern die neuen
 * ProgramArguments oder den Grund, warum nichts geändert wird.
 *
 * Eingebunden heißt: ProgramArguments beginnt mit
 *   <bun> --no-env-file <projekt>/src/routine-run.ts --id <label> --
 * und danach stehen die alten ProgramArguments unverändert. --no-env-file
 * wie in den Vorlagen: Bun lädt sonst die .env des Arbeitsordners und
 * verändert die Umgebung des eigentlichen Befehls. Ausbinden entfernt genau
 * diesen Vorsatz (auch den der Vorlagen mit relativem src/routine-run.ts).
 */

import { BOT_SERVICE, SUPABASE_SERVICE, launchdLabel } from "../service-names";
import { classifySchedule, scheduleFromPlist } from "./schedule";

/** Pfad des Wrappers im Projekt */
export const WRAPPER_SCRIPT = "src/routine-run.ts";

const WRAPPER_PATTERN = /(^|\/)src\/routine-run\.ts$/;
/** Starter des Vorsatzes: bun, als Pfad oder Name; jedes andere Programm ist ein fremder Befehl */
const BUN_PATTERN = /(^|\/)bun$/;
/**
 * Erlaubte Folgen zwischen bun und dem Wrapper, genau diese: ohne, --no-env-file
 * (Vorlagen und einbinden), run (von Hand) und --no-env-file run
 */
const BUN_FLAG_FORMS: readonly (readonly string[])[] = [[], ["--no-env-file"], ["run"], ["--no-env-file", "run"]];

/** Dienste, die nie eingebunden werden: der Bot selbst und der einmalige Supabase-Start (beide ohne Wrapper in den Vorlagen) */
export const NEVER_WRAPPED = [launchdLabel(BOT_SERVICE), launchdLabel(SUPABASE_SERVICE)] as const;

export const WRAP_TEXT = {
  labelMismatch: (label: string, actual: string | null) =>
    actual ? `Die Plist trägt das Label ${actual}, nicht ${label}.` : `Die Plist hat kein Label (erwartet: ${label}).`,
  botService: (label: string) => `${label} ist der Bot-Dienst selbst und wird nie eingebunden.`,
  supabaseService: (label: string) => `${label} startet nur Supabase beim Anmelden und wird nicht eingebunden.`,
  daemon: (label: string) => `${label} ist ein Dauerdienst (KeepAlive ohne Zeitplan), kein Routinenlauf. Dauerdienste werden nicht eingebunden.`,
  program: (label: string) => `${label} nutzt den Schlüssel Program. Das wird (noch) nicht unterstützt, nichts geändert.`,
  noArguments: (label: string) => `${label} hat keine gültigen ProgramArguments (Liste aus Texten), nichts geändert.`,
  alreadyWrapped: (label: string) => `${label} ist schon eingebunden.`,
  foreignWrapper: (label: string) =>
    `${label} ruft src/routine-run.ts schon auf, aber nicht als Vorsatz mit --id ${label}. Bitte die Plist von Hand prüfen, nichts geändert.`,
  notWrapped: (label: string) => `${label} ist nicht eingebunden, nichts zu tun.`,
  badBun: "Der Pfad zu bun muss absolut sein.",
  badRoot: "Der Projektordner muss absolut sein.",
} as const;

export type WrapPlan =
  | { ok: true; changed: true; before: string[]; after: string[] }
  | { ok: true; changed: false; reason: string }
  | { ok: false; reason: string };

/** Vorsatz, den einbinden schreibt */
export function wrapperPrefix(bun: string, projectRoot: string, label: string): string[] {
  return [bun, "--no-env-file", `${projectRoot.replace(/\/+$/, "")}/${WRAPPER_SCRIPT}`, "--id", label, "--"];
}

/** Liste aus Texten; nur das Programm selbst darf nicht leer sein, leere Argumente danach sind gültig */
function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  if (!value.every(v => typeof v === "string") || value[0] === "") return null;
  return value as string[];
}

/**
 * Länge des Wrapper-Vorsatzes am Anfang der Liste, wenn er genau so aussieht:
 * <…/bun> [eine Folge aus BUN_FLAG_FORMS] <…/src/routine-run.ts> --id <label> --.
 * null, wenn die Liste nicht so beginnt (anderes Programm als bun, andere
 * Flags, andere --id).
 */
export function wrapperPrefixLength(args: readonly string[], label: string): number | null {
  if (!BUN_PATTERN.test(args[0] ?? "")) return null;
  for (const flags of BUN_FLAG_FORMS) {
    const i = 1 + flags.length;
    if (!flags.every((flag, k) => args[1 + k] === flag)) continue;
    if (!WRAPPER_PATTERN.test(args[i] ?? "")) continue;
    if (args[i + 1] !== "--id" || args[i + 2] !== label || args[i + 3] !== "--") return null;
    return i + 4;
  }
  return null;
}

/** Kommt der Wrapper irgendwo in der Liste vor? */
function mentionsWrapper(args: readonly string[]): boolean {
  return args.some(a => WRAPPER_PATTERN.test(a));
}

/**
 * Gemeinsame Prüfungen: Label stimmt, nicht Bot oder Supabase, kein
 * Dauerdienst (nach classifySchedule, ein Zeitplan mit bedingtem KeepAlive
 * bleibt zeitgesteuert), kein Program, gültige ProgramArguments.
 */
function checkPlist(plist: Record<string, unknown>, label: string): { ok: true; args: string[] } | { ok: false; reason: string } {
  const actual = typeof plist.Label === "string" ? plist.Label : null;
  if (actual !== label) return { ok: false, reason: WRAP_TEXT.labelMismatch(label, actual) };
  if (label === launchdLabel(BOT_SERVICE)) return { ok: false, reason: WRAP_TEXT.botService(label) };
  if (label === launchdLabel(SUPABASE_SERVICE)) return { ok: false, reason: WRAP_TEXT.supabaseService(label) };
  if (classifySchedule(scheduleFromPlist(plist)) === "daemon") return { ok: false, reason: WRAP_TEXT.daemon(label) };
  if (plist.Program !== undefined) return { ok: false, reason: WRAP_TEXT.program(label) };
  const args = stringList(plist.ProgramArguments);
  if (!args) return { ok: false, reason: WRAP_TEXT.noArguments(label) };
  return { ok: true, args };
}

/** Neue ProgramArguments für einbinden; die alten bleiben Zeichen für Zeichen dahinter */
export function wrapProgramArguments(plist: Record<string, unknown>, label: string, bun: string, projectRoot: string): WrapPlan {
  if (!bun.startsWith("/")) return { ok: false, reason: WRAP_TEXT.badBun };
  if (!projectRoot.startsWith("/")) return { ok: false, reason: WRAP_TEXT.badRoot };
  const checked = checkPlist(plist, label);
  if (!checked.ok) return checked;
  const before = checked.args;
  if (wrapperPrefixLength(before, label) !== null) return { ok: false, reason: WRAP_TEXT.alreadyWrapped(label) };
  if (mentionsWrapper(before)) return { ok: false, reason: WRAP_TEXT.foreignWrapper(label) };
  return { ok: true, changed: true, before: [...before], after: [...wrapperPrefix(bun, projectRoot, label), ...before] };
}

/** Alte ProgramArguments für ausbinden: genau der Vorsatz fällt weg; ohne Wrapper bleibt alles, wie es ist */
export function unwrapProgramArguments(plist: Record<string, unknown>, label: string): WrapPlan {
  const checked = checkPlist(plist, label);
  if (!checked.ok) return checked;
  const before = checked.args;
  const length = wrapperPrefixLength(before, label);
  if (length === null) {
    return mentionsWrapper(before) ? { ok: false, reason: WRAP_TEXT.foreignWrapper(label) } : { ok: true, changed: false, reason: WRAP_TEXT.notWrapped(label) };
  }
  const after = before.slice(length);
  if (!after.length || after[0] === "") return { ok: false, reason: WRAP_TEXT.noArguments(label) };
  return { ok: true, changed: true, before: [...before], after };
}

