/**
 * Zeitangaben auf Deutsch und Englisch (Issue #308).
 *
 * parseWhen macht aus „morgen", „in 2 Stunden", „17:30", „Montag" oder einem
 * ISO-Datum einen Zeitpunkt; relativeTime beschreibt einen vergangenen
 * Zeitpunkt („vor 3 Stunden", „3 hours ago"). Gerechnet wird in der Zeitzone
 * des Nutzers (Parameter, sonst USER_TIMEZONE, sonst UTC), nie in der des
 * Prozesses. Kalendertage sind Ortstage, keine 24-Stunden-Blöcke; Dauern
 * („in 24 Stunden") sind echte Zeit.
 *
 * Ausnahme ist parseDeadline (Issue #314): Fristen von Zielen lesen die
 * englischen Formen wie seit jeher in der Zeitzone des Prozesses, damit jede
 * früher gespeicherte Frist auf die Millisekunde gleich bleibt.
 */

export interface WhenOptions {
  /** Bezugszeitpunkt, Standard: jetzt */
  now?: Date;
  /** IANA-Zeitzone, Vorrang vor USER_TIMEZONE */
  timeZone?: string;
}

export interface RelativeTimeOptions extends WhenOptions {
  /** Sprache des Texts, Standard "en" */
  locale?: "de" | "en";
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** Größter Abstand zu 1970, den Date darstellen kann */
const MAX_TIME = 8.64e15;

/**
 * Wie Date.UTC, aber ohne dessen Sonderfall: Date.UTC liest die Jahre 0 bis
 * 99 als 1900 bis 1999, ein ISO-Jahr 0050 ist aber das Jahr 50.
 */
function utcTime(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, millis = 0): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month, day);
  d.setUTCHours(hour, minute, second, millis);
  return d.getTime();
}

/** Date nur für darstellbare Zeitpunkte, sonst undefined */
function toDate(ms: number): Date | undefined {
  return Math.abs(ms) <= MAX_TIME ? new Date(ms) : undefined;
}

// ---------------------------------------------------------------------------
// Zeitzone
// ---------------------------------------------------------------------------

function acceptsZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Gewählte Zeitzone: Parameter, sonst USER_TIMEZONE; leer oder unbekannt ergibt UTC */
export function effectiveTimeZone(timeZone?: string): string {
  const wanted = (timeZone || process.env.USER_TIMEZONE || "").trim();
  return wanted && acceptsZone(wanted) ? wanted : "UTC";
}

/** Ortszeit-Felder eines Zeitpunkts; weekday 0 = Sonntag */
export interface Clock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number;
}

const readers = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function reader(zone: string): Intl.DateTimeFormat {
  let fmt = readers.get(zone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
      era: "short",
    });
    readers.set(zone, fmt);
  }
  return fmt;
}

/** Ortszeit eines Zeitpunkts in der Zone (auch für recurrence.ts) */
export function clockAt(ms: number, zone: string): Clock {
  const fields: Record<string, string> = {};
  for (const part of reader(zone).formatToParts(new Date(ms))) fields[part.type] = part.value;
  // Ohne Ära stünde das Jahr 0 als 1 da (1 v. Chr.)
  const year = fields.era === "BC" ? 1 - Number(fields.year) : Number(fields.year);
  return {
    year,
    month: Number(fields.month),
    day: Number(fields.day),
    hour: Number(fields.hour) % 24,
    minute: Number(fields.minute),
    second: Number(fields.second),
    weekday: WEEKDAY_INDEX[fields.weekday] ?? 0,
  };
}

/** Abstand Ortszeit minus UTC in Millisekunden zum Zeitpunkt ms */
function zoneShift(ms: number, zone: string): number {
  const c = clockAt(ms, zone);
  const asUtc = utcTime(c.year, c.month - 1, c.day, c.hour, c.minute, c.second);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/**
 * Zeitpunkt einer Ortszeit. Gibt es die Ortszeit zweimal (Uhr wird
 * zurückgestellt), gilt die frühere; gibt es sie nicht (Uhr springt vor),
 * wird sie um die Lücke nach vorn geschoben. Außerhalb des darstellbaren
 * Bereichs NaN. Auch für recurrence.ts.
 */
export function fromLocal(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  second: number,
  zone: string,
  millis = 0
): number {
  const naive = utcTime(year, month - 1, day, hour, minute, second, millis);
  if (!(Math.abs(naive) <= MAX_TIME - 2 * DAY)) return NaN;
  // Die Verschiebung vor und nach einem möglichen Wechsel. Der gesuchte
  // Zeitpunkt liegt bis zu 14 Stunden neben naive, deshalb einen ganzen Tag
  // Abstand, sonst liegen bei großen Offsets (Pacific/Auckland) beide Proben
  // auf derselben Seite des Wechsels.
  const shiftBefore = zoneShift(naive - DAY, zone);
  const shiftAfter = zoneShift(naive + DAY, zone);
  const fits: number[] = [];
  for (const shift of new Set([shiftBefore, shiftAfter])) {
    const candidate = naive - shift;
    const c = clockAt(candidate, zone);
    if (c.year === year && c.month === month && c.day === day && c.hour === hour && c.minute === minute) {
      fits.push(candidate);
    }
  }
  if (fits.length) return Math.min(...fits);
  // Lücke: mit der Verschiebung von vor dem Sprung gerechnet landet die Zeit dahinter
  return naive - shiftBefore;
}

export interface CalendarDay {
  year: number;
  month: number;
  day: number;
}

/** Kalendertag um days Tage verschoben */
export function shiftDays(d: CalendarDay, days: number): CalendarDay {
  const moved = new Date(utcTime(d.year, d.month - 1, d.day + days));
  return { year: moved.getUTCFullYear(), month: moved.getUTCMonth() + 1, day: moved.getUTCDate() };
}

function endOfDay(d: CalendarDay, zone: string): Date | undefined {
  return toDate(fromLocal(d.year, d.month, d.day, 23, 59, 59, zone));
}

function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const lastDay = new Date(utcTime(year, month, 0)).getUTCDate();
  return day <= lastDay;
}

// ---------------------------------------------------------------------------
// parseWhen
// ---------------------------------------------------------------------------

const DAY_WORDS: Record<string, number> = {
  heute: 0,
  today: 0,
  morgen: 1,
  tomorrow: 1,
  übermorgen: 2,
  uebermorgen: 2,
  "the day after tomorrow": 2,
  "day after tomorrow": 2,
};

const WEEKDAY_WORDS: Record<string, number> = {
  sonntag: 0, so: 0, sunday: 0, sun: 0,
  montag: 1, mo: 1, monday: 1, mon: 1,
  dienstag: 2, di: 2, tuesday: 2, tue: 2, tues: 2,
  mittwoch: 3, mi: 3, wednesday: 3, wed: 3,
  donnerstag: 4, do: 4, thursday: 4, thu: 4, thur: 4, thurs: 4,
  freitag: 5, fr: 5, friday: 5, fri: 5,
  samstag: 6, sa: 6, sonnabend: 6, saturday: 6, sat: 6,
};

/** Einheiten nach „in N …": Kalendertage oder echte Dauer */
const UNIT_WORDS: Record<string, { days: number } | { ms: number }> = {
  tag: { days: 1 }, tage: { days: 1 }, tagen: { days: 1 }, day: { days: 1 }, days: { days: 1 },
  woche: { days: 7 }, wochen: { days: 7 }, week: { days: 7 }, weeks: { days: 7 },
  stunde: { ms: HOUR }, stunden: { ms: HOUR }, std: { ms: HOUR }, hour: { ms: HOUR }, hours: { ms: HOUR },
  minute: { ms: MINUTE }, minuten: { ms: MINUTE }, min: { ms: MINUTE }, minutes: { ms: MINUTE },
};

const IN_AMOUNT = /^in (\d+) ([a-zäöü]+)$/;
const CLOCK_GERMAN = /^(\d{1,2})(?:[:.](\d{2}))? uhr$/;
const CLOCK_PLAIN = /^(\d{1,2}):(\d{2})$/;
const CLOCK_AMPM = /^(\d{1,2})(?::(\d{2}))? ?(am|pm)$/;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})[t ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(z|([+-])(\d{2}):?(\d{2}))?$/;

/** Wert eines eigenen Eintrags; geerbte Namen wie „constructor" zählen nicht */
function lookup<T>(words: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(words, key) ? words[key] : undefined;
}

/** Uhrzeit allein: heute, wenn sie noch kommt, sonst morgen */
function nextClock(hour: number, minute: number, now: number, zone: string): Date | undefined {
  if (hour > 23 || minute > 59) return undefined;
  const today = clockAt(now, zone);
  const todayAt = fromLocal(today.year, today.month, today.day, hour, minute, 0, zone);
  if (todayAt > now) return toDate(todayAt);
  const tomorrow = shiftDays(today, 1);
  return toDate(fromLocal(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, 0, zone));
}

/** Eingabe in der Form, die alle Leser vergleichen: NFC, klein, Leerraum zusammengezogen */
function normalized(input: string): string {
  return String(input ?? "").normalize("NFC").trim().toLowerCase().replace(/\s+/g, " ");
}

/** Kalendertag einer reinen Tagesangabe (Tageswort, Wochentag, „in N Tagen/Wochen", ISO-Datum) */
function dayOf(text: string, today: Clock): CalendarDay | undefined {
  const dayWord = lookup(DAY_WORDS, text);
  if (dayWord !== undefined) return shiftDays(today, dayWord);

  const weekday = lookup(WEEKDAY_WORDS, text.replace(/\.$/, ""));
  if (weekday !== undefined) return shiftDays(today, (weekday - today.weekday + 7) % 7 || 7);

  const amount = IN_AMOUNT.exec(text);
  const unit = amount ? lookup(UNIT_WORDS, amount[2]) : undefined;
  if (amount && unit && "days" in unit) return shiftDays(today, Number(amount[1]) * unit.days);

  const date = ISO_DATE.exec(text);
  if (date) {
    const [year, month, day] = [Number(date[1]), Number(date[2]), Number(date[3])];
    return isRealDate(year, month, day) ? { year, month, day } : undefined;
  }
  return undefined;
}

/**
 * Nur der Kalendertag einer reinen Tagesangabe („morgen", „Freitag", „in 3
 * Tagen", „2026-10-20"), in der Zeitzone wie parseWhen. Uhrzeiten, Dauern
 * und alles andere: undefined. Für Erinnerungen, die eine eigene Uhrzeit
 * setzen (Issue #322).
 */
export function parseDay(input: string, options: WhenOptions = {}): CalendarDay | undefined {
  const text = normalized(input);
  const now = (options.now ?? new Date()).getTime();
  if (!text || !Number.isFinite(now)) return undefined;
  return dayOf(text, clockAt(now, effectiveTimeZone(options.timeZone)));
}

/**
 * Liest eine Zeitangabe. Liefert undefined, wenn sie leer, unbekannt oder
 * ungültig ist (Stunde über 23, Minute über 59, 13pm, 30. Februar, negative
 * Zahl). Tagesangaben enden um 23:59:59 Ortszeit.
 */
export function parseWhen(input: string, options: WhenOptions = {}): Date | undefined {
  const text = normalized(input);
  if (!text) return undefined;
  const zone = effectiveTimeZone(options.timeZone);
  const now = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(now)) return undefined;
  const today = clockAt(now, zone);

  const day = dayOf(text, today);
  if (day) return endOfDay(day, zone);

  const amount = IN_AMOUNT.exec(text);
  if (amount) {
    const unit = lookup(UNIT_WORDS, amount[2]);
    // Tage und Wochen hat dayOf schon gelesen
    if (!unit || "days" in unit) return undefined;
    return toDate(now + Number(amount[1]) * unit.ms);
  }

  const german = CLOCK_GERMAN.exec(text) ?? CLOCK_PLAIN.exec(text);
  if (german) return nextClock(Number(german[1]), Number(german[2] ?? 0), now, zone);

  const ampm = CLOCK_AMPM.exec(text);
  if (ampm) {
    const hour12 = Number(ampm[1]);
    if (hour12 < 1 || hour12 > 12) return undefined;
    const hour = (hour12 % 12) + (ampm[3] === "pm" ? 12 : 0);
    return nextClock(hour, Number(ampm[2] ?? 0), now, zone);
  }

  // Ein ISO-Datum, das dayOf nicht genommen hat, ist kein echter Tag
  if (ISO_DATE.test(text)) return undefined;

  const stamp = ISO_DATETIME.exec(text);
  if (stamp) {
    const [year, month, day, hour, minute] = [1, 2, 3, 4, 5].map(i => Number(stamp[i]));
    const second = Number(stamp[6] ?? 0);
    // Bruchteil auf Millisekunden: ".1" sind 100 ms
    const millis = Number((stamp[7] ?? "").padEnd(3, "0"));
    if (!isRealDate(year, month, day) || hour > 23 || minute > 59 || second > 59) return undefined;
    if (stamp[8] === undefined) return toDate(fromLocal(year, month, day, hour, minute, second, zone, millis));
    let offset = 0;
    if (stamp[8] !== "z") {
      const [offsetHours, offsetMins] = [Number(stamp[10]), Number(stamp[11])];
      if (offsetMins > 59) return undefined;
      offset = (stamp[9] === "-" ? -1 : 1) * (offsetHours * 60 + offsetMins);
    }
    if (Math.abs(offset) > 18 * 60) return undefined;
    return toDate(utcTime(year, month - 1, day, hour, minute, second, millis) - offset * MINUTE);
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// parseDeadline
// ---------------------------------------------------------------------------

const DEADLINE_SPAN = /^in\s+(\d+)\s+(hour|day|week)s?$/;
const DEADLINE_CLOCK = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/;

/**
 * Frist eines Ziels. Die englischen Formen gelten wie bisher, gerechnet mit
 * den Ortsmethoden von Date, also in der Zeitzone des Prozesses:
 * „today", „tomorrow", „in N days/weeks" enden um 23:59:59 des Ortstags;
 * „in N hours" verschiebt die Wanduhr um N Stunden (über einen
 * Zeitumstellungstag also nicht genau N echte Stunden); eine Uhrzeit („17",
 * „5:30pm", auch „25" oder „13pm") gilt heute, wenn sie noch nicht vorbei
 * ist, sonst morgen, und genau jetzt zählt als heute; jeder andere Text, den
 * `new Date` versteht, gilt so, wie Date ihn liest (ein reines ISO-Datum also
 * um 0 Uhr UTC). Erst was davon nichts trifft, liest parseWhen in
 * `options.timeZone` (deutsche Angaben). Unlesbar: undefined. Ergibt eine
 * englische Form kein gültiges Datum („in 99999999999 days"), wirft sie wie
 * bisher den RangeError von toISOString().
 */
export function parseDeadline(input: string, options: WhenOptions = {}): Date | undefined {
  const raw = String(input ?? "");
  const text = raw.trim().toLowerCase();
  if (!text) return undefined;
  const now = options.now ?? new Date();
  const at = new Date(now.getTime());
  if (!Number.isFinite(at.getTime())) return undefined;
  // toISOString wirft bei ungültigem Datum, wie früher in parseRelativeDate
  const checked = (date: Date) => (date.toISOString(), date);
  const dayEnd = (days: number) => {
    at.setDate(at.getDate() + days);
    at.setHours(23, 59, 59, 0);
    return checked(at);
  };

  if (text === "today") return dayEnd(0);
  if (text === "tomorrow") return dayEnd(1);

  const span = DEADLINE_SPAN.exec(text);
  if (span) {
    const n = Number(span[1]);
    if (span[2] === "day") return dayEnd(n);
    if (span[2] === "week") return dayEnd(n * 7);
    at.setHours(at.getHours() + n);
    return checked(at);
  }

  const clock = DEADLINE_CLOCK.exec(text);
  if (clock) {
    let hour = Number(clock[1]);
    if (clock[3] === "pm" && hour < 12) hour += 12;
    if (clock[3] === "am" && hour === 12) hour = 0;
    at.setHours(hour, Number(clock[2] ?? 0), 0, 0);
    if (at.getTime() < now.getTime()) at.setDate(at.getDate() + 1);
    return checked(at);
  }

  const stated = new Date(raw);
  if (Number.isFinite(stated.getTime())) return stated;

  return parseWhen(raw, options);
}

// ---------------------------------------------------------------------------
// relativeTime
// ---------------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function amount(n: number, de: boolean, singularDe: string, pluralDe: string, singularEn: string): string {
  if (de) return `vor ${n} ${n === 1 ? singularDe : pluralDe}`;
  return `${n} ${singularEn}${n === 1 ? "" : "s"} ago`;
}

/**
 * Beschreibt, wie lange ein Zeitpunkt her ist (abgerundet). Unter einer
 * Minute und in der Zukunft „gerade eben"/„just now"; ab 30 Tagen das Datum
 * in der Zeitzone (de 16.09.2026, en 2026-09-16).
 */
export function relativeTime(date: Date, options: RelativeTimeOptions = {}): string {
  const de = options.locale === "de";
  const now = (options.now ?? new Date()).getTime();
  const then = date.getTime();
  const past = now - then;
  if (!(past >= MINUTE)) return de ? "gerade eben" : "just now";
  if (past < HOUR) return amount(Math.floor(past / MINUTE), de, "Minute", "Minuten", "minute");
  if (past < DAY) return amount(Math.floor(past / HOUR), de, "Stunde", "Stunden", "hour");
  const days = Math.floor(past / DAY);
  if (days < 30) return amount(days, de, "Tag", "Tagen", "day");
  const c = clockAt(then, effectiveTimeZone(options.timeZone));
  return de ? `${pad(c.day)}.${pad(c.month)}.${c.year}` : `${c.year}-${pad(c.month)}-${pad(c.day)}`;
}
