/**
 * Gemeinsame Helfer der Einrichtungsschritte: vorhandene Werte lesen und
 * .env nach den Regeln aus M6 schreiben (src/lib/env-file.ts).
 */

import { updateEnvValues } from "../../lib/env-file";
import { catalogGroup } from "../../web/key-catalog";
import { readSetupEnv, type SetupContext } from "../context";
import {
  enteredValues,
  errorsMessage,
  isTransientName,
  presentValue,
  validateValues,
  type ApplyResult,
  type SetupField,
  type SetupValues,
  type TestResult,
} from "../model";

/** Gesetzte Werte der genannten Variablen aus der .env des Kontexts */
export async function envValues(ctx: SetupContext, names: string[]): Promise<SetupValues> {
  const env = await readSetupEnv(ctx);
  const out: SetupValues = {};
  for (const name of names) {
    const v = presentValue(env, name);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/**
 * Fehlertext beim Schreiben, ohne Werte. saved nennt, was vorher im selben
 * Schritt schon gespeichert wurde; nur wenn das leer ist, stimmt „Nichts
 * wurde geändert“.
 */
export function writeProblem(what: string, e: unknown, saved: string[] = []): string {
  const code = (e as NodeJS.ErrnoException)?.code;
  const known = e instanceof Error && e.name === "EnvFileError" ? e.message : null;
  const outcome = saved.length ? `Schon gespeichert und nicht zurückgenommen: ${saved.join(", ")}.` : "Nichts wurde geändert.";
  return `${what} konnte nicht geschrieben werden${known ? `: ${known}` : code ? ` (${code})` : ""}. ${outcome}`;
}

/** Laufende Schreibvorgänge der .env, damit ein Abbruch sie nie abschneidet */
const envWrites = new Set<Promise<unknown>>();

/** Wartet, bis alle angefangenen Schreibvorgänge der .env fertig sind */
export async function waitForEnvWrites(): Promise<void> {
  while (envWrites.size) await Promise.allSettled([...envWrites]);
}

/**
 * Laufende Schutzschritte (etwa Portprüfung und Schutz-Stopp bei „Supabase auf
 * diesem Rechner“) mit der Warnung, die gilt, solange sie nicht fertig sind.
 * Ein Abbruch wartet auf sie auch nach der Schonfrist, sonst bliebe ein
 * offener Dienst ungeprüft zurück.
 */
const safetyWork = new Map<Promise<unknown>, string>();

/** Ausgang eines fertigen Schutzschritts; alert: der sichere Zustand ist nicht bestätigt */
export interface SafetyOutcome {
  text: string;
  alert: boolean;
}

/**
 * Ausgänge fertiger Schutzschritte, bis jemand sie abholt. Der Browser-
 * Einrichtungsmodus schreibt sie bei Strg+C ins Terminal: das Ergebnis des
 * Ablaufs ruft dann niemand mehr ab.
 */
const safetyOutcomes: SafetyOutcome[] = [];

/**
 * Meldet p als Schutzschritt an; warning: konkrete Warnung samt Befehl zum
 * Anhalten. outcome beschreibt das Ergebnis (leerer Text: nichts zu melden);
 * scheitert p, gilt warning als Ausgang mit Warnung.
 */
export async function trackSafetyWork<T>(p: Promise<T>, warning: string, outcome?: (value: T) => SafetyOutcome): Promise<T> {
  safetyWork.set(p, warning);
  try {
    const value = await p;
    const o = outcome?.(value);
    if (o?.text) safetyOutcomes.push(o);
    return value;
  } catch (e) {
    safetyOutcomes.push({ text: warning, alert: true });
    throw e;
  } finally {
    safetyWork.delete(p);
  }
}

/** Holt die gesammelten Ausgänge ab (danach ist die Liste leer) */
export function takeSafetyOutcomes(): SafetyOutcome[] {
  return safetyOutcomes.splice(0);
}

/** Warnungen der noch laufenden Schutzschritte (ohne doppelte) */
export function pendingSafetyWarnings(): string[] {
  return [...new Set(safetyWork.values())];
}

/** Wartet, bis alle angefangenen Schutzschritte fertig sind */
export async function waitForSafetyWork(): Promise<void> {
  while (safetyWork.size) await Promise.allSettled([...safetyWork.keys()]);
}

/**
 * Schreibt Änderungen in die .env (eine Sicherung, atomar, 0600). null
 * entfernt einen Namen. Leere Liste: nichts zu tun. saved: siehe writeProblem.
 *
 * Transiente Namen (Felder, die nur für einen Lauf gelten, Issue #161) weist
 * writeEnv ab, bevor irgendetwas geschrieben wird: der ganze Änderungssatz
 * gilt dann als Fehler, die .env bleibt unverändert. Im Einrichtungsmodus des
 * Browsers läuft das Schreiben durch ctx.writeLock (dessen Warteschlange).
 */
export async function writeEnv(ctx: SetupContext, changes: Array<[string, string | null]>, saved: string[] = []): Promise<ApplyResult> {
  const transient = changes.filter(([name]) => isTransientName(name)).map(([name]) => name);
  if (transient.length) {
    const outcome = saved.length ? `Schon gespeichert und nicht zurückgenommen: ${saved.join(", ")}.` : "Nichts wurde geändert.";
    return { ok: false, message: `Nicht gespeichert: ${[...new Set(transient)].join(", ")} gilt nur für diesen Lauf und gehört nicht in die .env. ${outcome}`, changed: [] };
  }
  if (changes.length === 0) return { ok: true, message: "Nichts zu ändern.", changed: [] };
  const write = () => writeEnvNow(ctx, changes, saved);
  const pending = ctx.writeLock ? ctx.writeLock(write) : write();
  envWrites.add(pending);
  try {
    return await pending;
  } finally {
    envWrites.delete(pending);
  }
}

async function writeEnvNow(ctx: SetupContext, changes: Array<[string, string | null]>, saved: string[]): Promise<ApplyResult> {
  try {
    // Nur echte Änderungen melden; die Datei entscheidet updateEnvValues selbst
    const current = await readSetupEnv(ctx);
    const effective = changes.filter(([name, value]) => (value === null ? name in current : current[name] !== value));
    const result = await updateEnvValues(ctx.envPath, changes, {
      backupDir: ctx.backupDir,
      now: ctx.now,
      io: ctx.envIo,
      groupOf: name => catalogGroup(name),
    });
    if (!result.changed) return { ok: true, message: "Schon so eingetragen, nichts geändert.", changed: [] };
    return { ok: true, message: "Gespeichert.", changed: effective.map(([name]) => name) };
  } catch (e) {
    return { ok: false, message: writeProblem(".env", e, saved), changed: [] };
  }
}

/** Die eingegebenen Werte der genannten Felder als .env-Änderungen; transiente nie */
export function enteredChanges(fields: SetupField[], values: SetupValues, merged: SetupValues): Array<[string, string]> {
  const entered = enteredValues(values);
  const out: Array<[string, string]> = [];
  for (const f of fields) {
    if (f.transient) continue;
    if (f.visible && !f.visible(merged)) continue;
    const v = entered[f.name];
    if (v !== undefined) out.push([f.name, v]);
  }
  return out;
}

/** Prüfregeln vor Test oder Schreiben; null, wenn alles passt */
export function invalid(fields: SetupField[], values: SetupValues, existing: SetupValues): TestResult | null {
  const errors = validateValues(fields, values, existing);
  return Object.keys(errors).length ? { ok: false, message: errorsMessage(errors) } : null;
}
