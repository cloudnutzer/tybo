/**
 * Zeitpunkt der Erinnerung an einen offenen Faden (Issue #292, Entscheidung 0025).
 *
 * nextReminderTime(base, deadline, env):
 * - Kandidat: base plus THREADS_REMIND_DAYS (Zahl größer 0, Dezimalstellen
 *   erlaubt, Standard 3). Ganze Tage zählen nach Ortszeit (gleiche Uhrzeit am
 *   Kalendertag, auch über einen Sommerzeit-Wechsel), der Rest als Dauer.
 * - Frist (Kalenderdatum YYYY-MM-DD): Der Frist-Termin ist 09:00 Ortszeit am
 *   Tag vor der Frist. Liegt er zwischen base + 12 Stunden und dem Kandidaten,
 *   gilt er. Liegt er früher als base + 12 Stunden und ist die Frist noch nicht
 *   vorbei (Ortsdatum von base), gilt base + 12 Stunden. Ist sie vorbei, gilt
 *   der Kandidat.
 * - Ruhezeit zuletzt: Standard 21:00 bis 07:59 Ortszeit, einstellbar seit
 *   Issue #293 (threads.quietHours bzw. THREADS_QUIET_HOURS, config.ts). Ein
 *   Zeitpunkt darin geht auf eine Stunde nach ihrem Ende (Standard 09:00),
 *   desselben Tages, wenn die Ruhezeit an diesem Tag noch endet, sonst des
 *   nächsten; liegt diese Stunde selbst in der Ruhezeit oder nach 23 Uhr,
 *   auf das Ende. Die Ruhezeit schiebt nur nach hinten.
 *
 * Zeitzone: USER_TIMEZONE, ohne Angabe UTC wie im übrigen Bot, ungültig UTC.
 * Ungültige Werte kommen je Wert einmal ins Log.
 */

import { describeThreadsSettings, QUIET_HOURS_DEFAULT, THREADS_REMIND_DAYS_DEFAULT, type QuietHours } from "./config";

type Env = Record<string, string | undefined>;

export { THREADS_REMIND_DAYS_DEFAULT };
/** „Später" verschiebt immer um 3 Tage, unabhängig von THREADS_REMIND_DAYS */
export const THREADS_LATER_DAYS = 3;
/** Mindestabstand vor einer Frist */
export const THREADS_MIN_GAP_MS = 12 * 3_600_000;
/** Standard-Ruhezeit (Ortszeit): ab QUIET_START bis vor QUIET_END, einstellbar (config.ts) */
export const QUIET_START_HOUR = QUIET_HOURS_DEFAULT.from;
export const QUIET_END_HOUR = QUIET_HOURS_DEFAULT.to;
/** Uhrzeit des Frist-Termins und, bei der Standard-Ruhezeit, die, auf die sie schiebt */
export const REMIND_HOUR = 9;

const DAY_MS = 86_400_000;

const logged = new Set<string>();
function logOnce(key: string, message: string): void {
  if (logged.has(key)) return;
  logged.add(key);
  console.log(`[threads] ${message}`);
}

/** Abstand der Erinnerung in Tagen: Einstellung, sonst THREADS_REMIND_DAYS (Zahl größer 0), sonst 3 (config.ts) */
export function remindDays(env: Env = process.env): number {
  return describeThreadsSettings(env).remindDays.value;
}

/** Ruhezeit: Einstellung, sonst THREADS_QUIET_HOURS, sonst 21-8 (config.ts) */
export function quietHours(env: Env = process.env): QuietHours {
  return describeThreadsSettings(env).quietHours.value;
}

/** USER_TIMEZONE, ohne Angabe UTC; lehnt Intl sie ab: UTC (einmal ins Log) */
export function reminderTimeZone(env: Env = process.env): string {
  const zone = env.USER_TIMEZONE?.trim() ?? "";
  if (zone === "") return "UTC";
  try {
    new Intl.DateTimeFormat("de-DE", { timeZone: zone });
    return zone;
  } catch {
    logOnce(`zone:${zone}`, "USER_TIMEZONE ungültig, Erinnerungen rechnen in UTC");
    return "UTC";
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(zone, f);
  }
  return f;
}

/** Ortszeit eines Zeitpunkts */
export function localParts(ts: number, zone: string): LocalParts {
  const out: Record<string, number> = {};
  for (const p of formatter(zone).formatToParts(new Date(ts))) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return { year: out.year, month: out.month, day: out.day, hour: out.hour % 24, minute: out.minute, second: out.second };
}

/** Versatz der Ortszeit gegen UTC zum Zeitpunkt ts (ms) */
function offsetAt(ts: number, zone: string): number {
  const p = localParts(ts, zone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/**
 * Zeitpunkt einer Ortszeit (Tag darf überlaufen, etwa day 32). Fällt die
 * Uhrzeit in die Lücke der Zeitumstellung, gilt der spätere Zeitpunkt.
 */
export function zonedTime(zone: string, year: number, month: number, day: number, hour = 0, minute = 0, second = 0, ms = 0): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const first = wall - offsetAt(wall, zone);
  const second_ = wall - offsetAt(first, zone);
  return Math.max(first, second_);
}

/** Ortsdatum als YYYY-MM-DD */
export function localDate(ts: number, zone: string): string {
  const p = localParts(ts, zone);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** Ortsdatum als TT.MM.JJJJ */
export function localDateText(ts: number, zone: string): string {
  const p = localParts(ts, zone);
  return `${String(p.day).padStart(2, "0")}.${String(p.month).padStart(2, "0")}.${p.year}`;
}

/** Liegt die volle Stunde hour in der Ruhezeit? (über Mitternacht, wenn from > to) */
export function inQuietHours(hour: number, quiet: QuietHours = QUIET_HOURS_DEFAULT): boolean {
  return quiet.from > quiet.to ? hour >= quiet.from || hour < quiet.to : hour >= quiet.from && hour < quiet.to;
}

/** Stunde, auf die die Ruhezeit schiebt: eine nach ihrem Ende, wenn die frei ist, sonst das Ende (Standard 9) */
export function quietTargetHour(quiet: QuietHours = QUIET_HOURS_DEFAULT): number {
  const next = quiet.to + 1;
  return next <= 23 && !inQuietHours(next, quiet) ? next : quiet.to;
}

/** Ruhezeit (Standard 21:00 bis 07:59 Ortszeit)? */
export function isQuietTime(ts: number, zone: string, quiet: QuietHours = QUIET_HOURS_DEFAULT): boolean {
  return inQuietHours(localParts(ts, zone).hour, quiet);
}

/** Schiebt einen Zeitpunkt aus der Ruhezeit (Standard: auf 09:00, vor 08:00 derselbe Tag, ab 21:00 der nächste) */
export function applyQuietHours(ts: number, zone: string, quiet: QuietHours = QUIET_HOURS_DEFAULT): number {
  const p = localParts(ts, zone);
  if (!inQuietHours(p.hour, quiet)) return ts;
  // Endet die Ruhezeit heute noch (Stunde vor dem Ende), derselbe Tag, sonst der nächste
  const day = p.hour < quiet.to ? p.day : p.day + 1;
  return zonedTime(zone, p.year, p.month, day, quietTargetHour(quiet));
}

/** base plus days: ganze Tage nach Ortszeit (gleiche Uhrzeit), der Rest als Dauer */
export function addLocalDays(base: number, days: number, zone: string): number {
  const whole = Math.floor(days);
  const rest = Math.round((days - whole) * DAY_MS);
  const p = localParts(base, zone);
  const ms = base - Math.floor(base / 1000) * 1000;
  const shifted = whole === 0 ? base : zonedTime(zone, p.year, p.month, p.day + whole, p.hour, p.minute, p.second, ms);
  return shifted + rest;
}

/** 09:00 Ortszeit am Tag vor der Frist */
export function deadlineReminderTime(deadline: string, zone: string): number {
  const [y, m, d] = deadline.split("-").map(Number);
  return zonedTime(zone, y, m, d - 1, REMIND_HOUR);
}

/** Zeitpunkt der nächsten Erinnerung (siehe oben) */
export function nextReminderTime(base: number, deadline?: string, env: Env = process.env): number {
  const zone = reminderTimeZone(env);
  const candidate = addLocalDays(base, remindDays(env), zone);
  let at = candidate;
  if (deadline) {
    const due = deadlineReminderTime(deadline, zone);
    const min = base + THREADS_MIN_GAP_MS;
    if (due >= min && due <= candidate) at = due;
    else if (due < min && localDate(base, zone) <= deadline) at = min;
  }
  return applyQuietHours(at, zone, quietHours(env));
}

/** „Später": jetzt plus 3 Tage mit Ruhezeit-Regel, unabhängig von THREADS_REMIND_DAYS */
export function laterReminderTime(now: number, env: Env = process.env): number {
  const zone = reminderTimeZone(env);
  return applyQuietHours(addLocalDays(now, THREADS_LATER_DAYS, zone), zone, quietHours(env));
}
