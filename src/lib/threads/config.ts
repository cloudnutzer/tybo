/**
 * Einstellungen der offenen Fäden (Issue #293, Entscheidung 0025).
 *
 * Vorrang wie bei den übrigen Einstellungen: config/settings.json
 * (threads.enabled, threads.remindDays, threads.quietHours) vor .env
 * (THREADS, THREADS_REMIND_DAYS, THREADS_QUIET_HOURS) vor Standard. Gelesen
 * wird bei jedem Aufruf (getSettings liest die Datei nur bei Änderung neu),
 * also wirkt eine Änderung aus der WebUI ohne Neustart beim nächsten Turn
 * bzw. Durchgang der Erinnerungen.
 *
 * - enabled: Datei true/false; sonst THREADS=off (Groß- und Kleinschreibung
 *   egal) aus, alles andere an; Standard an.
 * - remindDays: Datei ganze Tage 1 bis 14; .env eine Zahl größer 0
 *   (Dezimalstellen erlaubt, wie bisher); Standard 3.
 * - quietHours: Ruhezeit in vollen Stunden Ortszeit (USER_TIMEZONE), von
 *   (einschließlich) bis (ausschließlich), über Mitternacht erlaubt
 *   ({ from: 21, to: 8 } heißt 21:00 bis 07:59). Datei { from, to } mit 0 bis
 *   23, verschieden; .env THREADS_QUIET_HOURS als "21-8" oder "21:00-08:00"
 *   (nur volle Stunden); Standard 21-8. Ungültige .env-Werte fallen auf den
 *   Standard zurück und kommen je Wert einmal ins Log.
 */

import { getSettings, type Settings } from "../settings";

type Env = Record<string, string | undefined>;
export type ThreadsSource = "settings" | "env" | "code";

export interface QuietHours {
  /** Beginn, volle Stunde 0 bis 23 (einschließlich) */
  from: number;
  /** Ende, volle Stunde 0 bis 23 (ausschließlich) */
  to: number;
}

export const THREADS_REMIND_DAYS_DEFAULT = 3;
export const THREADS_REMIND_DAYS_MIN = 1;
export const THREADS_REMIND_DAYS_MAX = 14;
export const QUIET_HOURS_DEFAULT: QuietHours = Object.freeze({ from: 21, to: 8 });

export interface ThreadsSettings {
  enabled: { value: boolean; source: ThreadsSource };
  remindDays: { value: number; source: ThreadsSource };
  quietHours: { value: QuietHours; source: ThreadsSource };
}

const logged = new Set<string>();

/** Nur für Tests: „einmal ins Log" vergessen, damit Testdateien im selben Prozess sich nicht stören */
export function resetThreadsConfigLogForTests(): void {
  logged.clear();
}

function logOnce(key: string, message: string): void {
  if (logged.has(key)) return;
  logged.add(key);
  console.log(`[threads] ${message}`);
}

function validHour(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 23;
}

/** Gültige Ruhezeit: zwei verschiedene volle Stunden */
export function isQuietHours(value: unknown): value is QuietHours {
  const q = value as QuietHours;
  return !!q && typeof q === "object" && validHour(q.from) && validHour(q.to) && q.from !== q.to;
}

/** "21-8", "21:00-08:00" (auch mit Leerzeichen) als Ruhezeit; null bei allem anderen */
export function parseQuietHours(raw: string): QuietHours | null {
  const m = /^\s*(\d{1,2})(?::00)?\s*-\s*(\d{1,2})(?::00)?\s*$/.exec(raw);
  if (!m) return null;
  const q = { from: Number(m[1]), to: Number(m[2]) };
  return isQuietHours(q) ? q : null;
}

/** Wirksame Einstellungen der Fäden mit Quelle (siehe oben) */
export function describeThreadsSettings(env: Env = process.env, settings: Settings = getSettings()): ThreadsSettings {
  const own = settings.threads;

  let enabled: ThreadsSettings["enabled"];
  if (typeof own?.enabled === "boolean") enabled = { value: own.enabled, source: "settings" };
  else if ((env.THREADS ?? "").trim() !== "") enabled = { value: env.THREADS!.trim().toLowerCase() !== "off", source: "env" };
  else enabled = { value: true, source: "code" };

  let remindDays: ThreadsSettings["remindDays"] = { value: THREADS_REMIND_DAYS_DEFAULT, source: "code" };
  if (Number.isInteger(own?.remindDays) && own!.remindDays! >= THREADS_REMIND_DAYS_MIN && own!.remindDays! <= THREADS_REMIND_DAYS_MAX) {
    remindDays = { value: own!.remindDays!, source: "settings" };
  } else {
    const raw = env.THREADS_REMIND_DAYS?.trim() ?? "";
    if (raw !== "") {
      const n = /^\d+(\.\d+)?$|^\.\d+$/.test(raw) ? Number(raw) : NaN;
      if (Number.isFinite(n) && n > 0) remindDays = { value: n, source: "env" };
      else logOnce(`days:${raw}`, `THREADS_REMIND_DAYS ungültig, nehme ${THREADS_REMIND_DAYS_DEFAULT} Tage`);
    }
  }

  let quietHours: ThreadsSettings["quietHours"] = { value: { ...QUIET_HOURS_DEFAULT }, source: "code" };
  if (isQuietHours(own?.quietHours)) {
    quietHours = { value: { from: own!.quietHours!.from, to: own!.quietHours!.to }, source: "settings" };
  } else {
    const raw = env.THREADS_QUIET_HOURS?.trim() ?? "";
    if (raw !== "") {
      const parsed = parseQuietHours(raw);
      if (parsed) quietHours = { value: parsed, source: "env" };
      else logOnce(`quiet:${raw}`, "THREADS_QUIET_HOURS ungültig, nehme 21-8");
    }
  }

  return { enabled, remindDays, quietHours };
}
