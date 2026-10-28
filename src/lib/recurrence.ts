/**
 * Wiederholungen von Erinnerungen (Issue #321), gerechnet in der Zeitzone
 * des Nutzers (Parameter, sonst USER_TIMEZONE, sonst UTC, wie when.ts).
 *
 * Formate (so steht es in scheduled_tasks.recurrence):
 * - "daily HH:MM": jeden Tag zur selben Ortszeit
 * - "weekdays HH:MM": Montag bis Freitag zur selben Ortszeit; Wochentag in
 *   der Zeitzone des Nutzers, Feiertage zählen als Werktag
 * - "weekly <mon|tue|wed|thu|fri|sat|sun> HH:MM": einmal die Woche
 * - "every <n>h": alle n Stunden echte Dauer, n ganz ab 1 ohne feste
 *   Obergrenze (n Stunden müssen als Millisekunden eine sichere ganze Zahl sein)
 *
 * Über eine Zeitumstellung halten die ersten drei die Ortszeit (ein Abstand
 * von 23 bzw. 25 echten Stunden), "every" hält die Dauer. Fällt die Ortszeit
 * in die Lücke beim Vorstellen, rückt sie um die Lücke nach vorn; gibt es sie
 * beim Zurückstellen zweimal, gilt das erste Mal (beides wie in when.ts).
 * Weil die Uhrzeit in der Regel steht und nicht im letzten Termin, gilt am
 * Tag nach einer Lücke wieder die ursprüngliche Uhrzeit.
 *
 * Verpasste Termine werden nicht nachgeholt: nextDue liefert den ersten
 * Termin nach dem vorigen und nach jetzt.
 */
import { clockAt, effectiveTimeZone, fromLocal, shiftDays, type CalendarDay } from "./when";

export type Recurrence =
  | { every: "day"; hour: number; minute: number }
  | { every: "weekday"; hour: number; minute: number }
  | { every: "week"; weekday: number; hour: number; minute: number }
  | { every: "hours"; hours: number };

export interface RecurrenceOptions {
  /** IANA-Zeitzone, Vorrang vor USER_TIMEZONE */
  timeZone?: string;
}

export interface NextDueOptions extends RecurrenceOptions {
  /** Bezugszeitpunkt, Standard: jetzt */
  now?: Date;
}

const HOUR = 3_600_000;
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;

const pad = (n: number) => String(n).padStart(2, "0");

/** "HH:MM" bzw. "H:MM" als Stunde und Minute, sonst null */
function readClock(text: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const [hour, minute] = [Number(m[1]), Number(m[2])];
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/** Ganze Stunden ab 1, deren Dauer in Millisekunden exakt rechenbar bleibt */
const validHours = (hours: number) => Number.isSafeInteger(hours) && hours >= 1 && Number.isSafeInteger(hours * HOUR);

function readHours(text: string): number | null {
  const m = /^(\d+)h$/.exec(text);
  if (!m) return null;
  const hours = Number(m[1]);
  return validHours(hours) ? hours : null;
}

const words = (text: unknown) => (typeof text === "string" ? text.trim().toLowerCase().split(/\s+/).filter(Boolean) : []);

/** Liest eine vollständige Regel; alles andere (auch "daily" ohne Uhrzeit) ergibt null */
export function parseRecurrence(text: string): Recurrence | null {
  const [head, ...rest] = words(text);
  if (head === "daily" || head === "weekdays") {
    const clock = rest.length === 1 ? readClock(rest[0]) : null;
    return clock ? { every: head === "daily" ? "day" : "weekday", ...clock } : null;
  }
  if (head === "weekly") {
    const weekday = rest.length === 2 ? (DAY_NAMES as readonly string[]).indexOf(rest[0]) : -1;
    const clock = weekday >= 0 ? readClock(rest[1]) : null;
    return clock ? { every: "week", weekday, ...clock } : null;
  }
  if (head === "every") {
    const hours = rest.length === 1 ? readHours(rest[0]) : null;
    return hours ? { every: "hours", hours } : null;
  }
  return null;
}

/** Kanonische Textform einer Regel */
export function formatRecurrence(rule: Recurrence): string {
  if (rule.every === "hours") return `every ${rule.hours}h`;
  const clock = `${pad(rule.hour)}:${pad(rule.minute)}`;
  if (rule.every === "week") return `weekly ${DAY_NAMES[rule.weekday]} ${clock}`;
  return `${rule.every === "day" ? "daily" : "weekdays"} ${clock}`;
}

function validRule(rule: Recurrence): boolean {
  if (rule.every === "hours") return validHours(rule.hours);
  const clockOk = Number.isInteger(rule.hour) && rule.hour >= 0 && rule.hour <= 23 && Number.isInteger(rule.minute) && rule.minute >= 0 && rule.minute <= 59;
  if (rule.every === "week") return clockOk && Number.isInteger(rule.weekday) && rule.weekday >= 0 && rule.weekday <= 6;
  return clockOk;
}

/** Wochentag eines Kalendertags, 0 = Sonntag */
const weekdayOf = (day: CalendarDay) => new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();

function fitsDay(rule: Exclude<Recurrence, { every: "hours" }>, day: CalendarDay): boolean {
  const weekday = weekdayOf(day);
  if (rule.every === "weekday") return weekday >= 1 && weekday <= 5;
  if (rule.every === "week") return weekday === rule.weekday;
  return true;
}

/**
 * Nächster Termin nach dem vorigen (previous) und nach jetzt. Ungültige
 * Regel oder ungültiger Zeitpunkt: undefined.
 */
export function nextDue(rule: Recurrence, previous: Date, options: NextDueOptions = {}): Date | undefined {
  const last = previous?.getTime();
  const now = (options.now ?? new Date()).getTime();
  if (!rule || !validRule(rule) || !Number.isFinite(last) || !Number.isFinite(now)) return undefined;
  const after = Math.max(last, now);

  if (rule.every === "hours") {
    const step = rule.hours * HOUR;
    const steps = Math.max(1, Math.floor((after - last) / step) + 1);
    const at = last + steps * step;
    // Jenseits des Date-Bereichs gibt es keinen Termin mehr
    return Number.isFinite(new Date(at).getTime()) ? new Date(at) : undefined;
  }

  const zone = effectiveTimeZone(options.timeZone);
  const start = clockAt(after, zone);
  let day: CalendarDay = { year: start.year, month: start.month, day: start.day };
  // Höchstens acht Tage: ab heute liegt jeder Wochentag einmal darin
  for (let i = 0; i <= 8; i++, day = shiftDays(day, 1)) {
    if (!fitsDay(rule, day)) continue;
    const at = fromLocal(day.year, day.month, day.day, rule.hour, rule.minute, 0, zone);
    if (at > after) return new Date(at);
  }
  return undefined;
}

/**
 * Macht eine Regel vollständig: "daily", "weekdays" und "weekly" ohne
 * Uhrzeit bzw. Wochentag bekommen sie vom ersten Termin, in der Zeitzone des
 * Nutzers. Vollständige Regeln kommen in kanonischer Form zurück. Ungültig:
 * null.
 */
export function anchorRecurrence(text: string, firstDue: Date, options: RecurrenceOptions = {}): string | null {
  const full = parseRecurrence(text);
  if (full) return formatRecurrence(full);
  const [head, ...rest] = words(text);
  const ms = firstDue?.getTime();
  if (rest.length || !Number.isFinite(ms)) return null;
  const c = clockAt(ms, effectiveTimeZone(options.timeZone));
  const clock = `${pad(c.hour)}:${pad(c.minute)}`;
  if (head === "daily" || head === "weekdays") return `${head} ${clock}`;
  if (head === "weekly") return `weekly ${DAY_NAMES[c.weekday]} ${clock}`;
  return null;
}
