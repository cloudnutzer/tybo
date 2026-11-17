/**
 * Zeitplan einer Routine in Klartext (Issue #284, Entscheidung 0025).
 *
 * launchd: StartCalendarInterval (ein Eintrag oder eine Liste), StartInterval,
 * RunAtLoad, KeepAlive. PM2: einfache Cron-Ausdrücke aus cron_restart.
 * systemd (Issue #568): OnCalendar-Zeilen der Timer in der Form, die tybo
 * selbst schreibt (src/lib/services/systemd.ts), mit Zeitzone. Was
 * sich nicht sicher in Worte fassen lässt, heißt ehrlich „eigener Zeitplan
 * (<Rohwert>)", nie eine geratene Beschreibung.
 */

/** Zeitplan-Schlüssel eines Plists, unverändert übernommen */
export interface LaunchdSchedule {
  type: "launchd";
  StartCalendarInterval?: unknown;
  StartInterval?: unknown;
  RunAtLoad?: unknown;
  KeepAlive?: unknown;
  /** Andere Auslöser (WatchPaths, QueueDirectories, StartOnMount), nur die Namen */
  otherTriggers: string[];
}

/** Zeitplan eines PM2-Prozesses: cron_restart, sonst null */
export interface CronSchedule {
  type: "cron";
  cron: string | null;
}

/**
 * Zeitplan eines systemd-Timers (Issue #568): die OnCalendar-Zeilen
 * unverändert und, wenn sie sich lesen lassen, dieselben Einträge wie
 * StartCalendarInterval (Minute, Hour, Weekday) samt Zeitzone. calendar
 * null: mindestens eine Zeile ist nicht in der Form, die tybo schreibt.
 */
export interface SystemdSchedule {
  type: "systemd";
  onCalendar: string[];
  calendar: Record<string, number>[] | null;
  /** Zeitzone hinter den Terminen; null heißt die des Systems */
  timeZone: string | null;
}

export type RoutineSchedule = LaunchdSchedule | CronSchedule | SystemdSchedule;

const SYSTEMD_WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * Eine OnCalendar-Zeile in der Form von onCalendar() aus
 * src/lib/services/systemd.ts: „[Wochentag ]*-*-* HH:MM:00[ Zeitzone]“,
 * Stunde und Minute als Zahl oder *. Alles andere null (eigener Zeitplan).
 */
export function parseOnCalendar(expression: string): { entry: Record<string, number>; timeZone: string | null } | null {
  const m = /^(?:(Sun|Mon|Tue|Wed|Thu|Fri|Sat) )?\*-\*-\* (\*|\d{1,2}):(\*|\d{1,2}):00(?: ([A-Za-z][A-Za-z0-9_+\/-]*))?$/.exec(expression.trim());
  if (!m) return null;
  const entry: Record<string, number> = {};
  if (m[1]) entry.Weekday = SYSTEMD_WEEKDAYS[m[1]];
  if (m[2] !== "*") entry.Hour = Number(m[2]);
  if (m[3] !== "*") entry.Minute = Number(m[3]);
  if ((entry.Hour ?? 0) > 23 || (entry.Minute ?? 0) > 59) return null;
  return { entry, timeZone: m[4] ?? null };
}

/** Kennt Intl die Zeitzone? Nur dann lassen sich Termine darin rechnen */
function knownTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Zeitplan aus den OnCalendar-Zeilen eines Timers; verschiedene Zeitzonen machen ihn unlesbar */
export function scheduleFromTimer(onCalendarLines: string[]): SystemdSchedule {
  const parsed = onCalendarLines.map(parseOnCalendar);
  const zones = new Set(parsed.map(p => p?.timeZone ?? null));
  const zone = [...zones][0] ?? null;
  const readable = parsed.length > 0 && parsed.every(p => p !== null) && zones.size === 1 && (zone === null || knownTimeZone(zone));
  return {
    type: "systemd",
    onCalendar: onCalendarLines,
    calendar: readable ? parsed.map(p => p!.entry) : null,
    timeZone: readable ? parsed[0]!.timeZone : null,
  };
}
export type RoutineKind = "scheduled" | "daemon";

const OTHER_TRIGGERS = ["WatchPaths", "QueueDirectories", "StartOnMount"] as const;
const CALENDAR_KEYS = new Set(["Minute", "Hour", "Day", "Weekday", "Month"]);

/** Wochentage als Adverb, launchd und Cron zählen 0 und 7 als Sonntag */
const WEEKDAY_ADVERB = ["sonntags", "montags", "dienstags", "mittwochs", "donnerstags", "freitags", "samstags"];

export function scheduleFromPlist(plist: Record<string, unknown>): LaunchdSchedule {
  const schedule: LaunchdSchedule = { type: "launchd", otherTriggers: OTHER_TRIGGERS.filter(k => plist[k] !== undefined) };
  for (const key of ["StartCalendarInterval", "StartInterval", "RunAtLoad", "KeepAlive"] as const) {
    if (plist[key] !== undefined) schedule[key] = plist[key];
  }
  return schedule;
}

/** KeepAlive hält den Dienst am Leben: true oder eine Bedingung (Dict) */
function keepsAlive(value: unknown): boolean {
  return value === true || (typeof value === "object" && value !== null && !Array.isArray(value));
}

function hasTimedTrigger(s: LaunchdSchedule): boolean {
  return s.StartCalendarInterval !== undefined || s.StartInterval !== undefined;
}

/**
 * Zeitgesteuert oder Dauerdienst. Ein Zeitplan (StartCalendarInterval,
 * StartInterval) hat Vorrang: ein Kalenderplan mit bedingtem KeepAlive
 * (Neustart nach Fehler, wie ältere Plists von ai.tybo.smart-checkin) bleibt zeitgesteuert.
 * Ohne Zeitplan ist KeepAlive true oder als Bedingung ein Dauerdienst;
 * alles andere (RunAtLoad allein, KeepAlive false, gar nichts) zeitgesteuert.
 */
export function classifySchedule(s: RoutineSchedule): RoutineKind {
  if (s.type === "cron") return s.cron ? "scheduled" : "daemon";
  if (s.type === "systemd") return "scheduled";
  if (hasTimedTrigger(s)) return "scheduled";
  return keepsAlive(s.KeepAlive) ? "daemon" : "scheduled";
}

function raw(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function custom(value: unknown): string {
  return `eigener Zeitplan (${raw(value)})`;
}

function isInt(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function time(hour: number, minute: number): string {
  return `${pad(hour)}:${pad(minute)}`;
}

function joinWords(words: string[]): string {
  return words.length <= 1 ? words.join("") : `${words.slice(0, -1).join(", ")} und ${words[words.length - 1]}`;
}

/** Wochentage 0 bis 7 (0 und 7 Sonntag) in Klartext; Mo bis Fr heißt „werktags" */
function weekdaysText(days: number[]): string {
  const set = [...new Set(days.map(d => d % 7))].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7));
  if (set.length === 5 && [1, 2, 3, 4, 5].every(d => set.includes(d))) return "werktags";
  if (set.length === 2 && set.includes(0) && set.includes(6)) return "samstags und sonntags";
  if (set.length === 7) return "täglich";
  return joinWords(set.map(d => WEEKDAY_ADVERB[d]));
}

interface CalendarEntry {
  Minute?: number;
  Hour?: number;
  Day?: number;
  Weekday?: number;
  Month?: number;
}

/** Ein Kalender-Eintrag mit gültigen Werten; null bei unbekannten Schlüsseln oder Werten */
function parseEntry(value: unknown): CalendarEntry | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  for (const key of Object.keys(entry)) if (!CALENDAR_KEYS.has(key)) return null;
  const limits: Record<string, [number, number]> = { Minute: [0, 59], Hour: [0, 23], Day: [1, 31], Weekday: [0, 7], Month: [1, 12] };
  for (const [key, [min, max]] of Object.entries(limits)) {
    if (entry[key] !== undefined && !isInt(entry[key], min, max)) return null;
  }
  return entry as CalendarEntry;
}

/**
 * Ein Eintrag in Klartext. Fehlende Schlüssel bedeuten bei launchd „jeder
 * Wert"; beschrieben werden nur eindeutige Fälle (Minute gesetzt, Stunde
 * gesetzt oder ganz offen), sonst null.
 */
function entryText(e: CalendarEntry): string | null {
  if (e.Minute === undefined) return null;
  if (e.Hour === undefined) {
    return e.Day === undefined && e.Weekday === undefined && e.Month === undefined ? `stündlich zur Minute ${e.Minute}` : null;
  }
  const at = time(e.Hour, e.Minute);
  if (e.Month !== undefined) {
    return e.Day !== undefined && e.Weekday === undefined ? `jährlich am ${e.Day}.${e.Month}. um ${at}` : null;
  }
  if (e.Day !== undefined) return e.Weekday === undefined ? `monatlich am ${e.Day}. um ${at}` : null;
  if (e.Weekday !== undefined) return `${weekdaysText([e.Weekday])} ${at}`;
  return `täglich ${at}`;
}

/** StartCalendarInterval in Klartext: ein Eintrag oder eine Liste */
export function describeCalendar(value: unknown): string {
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0) return custom(value);
  const entries = list.map(parseEntry);
  if (entries.some(e => e === null)) return custom(value);
  const valid = entries as CalendarEntry[];
  if (valid.length === 1) return entryText(valid[0]) ?? custom(value);
  // Gleiche Uhrzeit an mehreren Wochentagen: „werktags 08:00"
  const first = valid[0];
  const sameTimeWeekdays = valid.every(
    e => e.Weekday !== undefined && e.Hour === first.Hour && e.Minute === first.Minute && e.Hour !== undefined && e.Minute !== undefined && e.Day === undefined && e.Month === undefined
  );
  if (sameTimeWeekdays) return `${weekdaysText(valid.map(e => e.Weekday!))} ${time(first.Hour!, first.Minute!)}`;
  // Täglich zu mehreren Uhrzeiten: „täglich 09:00, 13:00 und 17:00"
  const daily = valid.every(e => e.Hour !== undefined && e.Minute !== undefined && e.Day === undefined && e.Weekday === undefined && e.Month === undefined);
  if (daily) {
    const times = valid.map(e => [e.Hour!, e.Minute!] as const).sort((a, b) => a[0] * 60 + a[1] - (b[0] * 60 + b[1]));
    return `täglich ${joinWords([...new Set(times.map(([h, m]) => time(h, m)))])}`;
  }
  const texts = valid.map(entryText);
  return texts.every(t => t !== null) ? texts.join("; ") : custom(value);
}

/** StartInterval (Sekunden) in Klartext */
export function describeInterval(value: unknown): string {
  if (!isInt(value, 1, Number.MAX_SAFE_INTEGER)) return custom(value);
  const seconds = value;
  if (seconds % 3600 === 0) return seconds === 3600 ? "stündlich" : `alle ${seconds / 3600} Stunden`;
  if (seconds % 60 === 0) return seconds === 60 ? "jede Minute" : `alle ${seconds / 60} Minuten`;
  return `alle ${seconds} Sekunden`;
}

/**
 * Werte eines Cron-Felds als sortierte Menge: Zahl, Bereich, Liste, „*" und
 * Schritte („*\/n", „a-b/n"). null bei allem anderen (Namen, Sonderzeichen).
 */
export function cronValues(field: string, min: number, max: number): number[] | null {
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    let from = min;
    let to = max;
    if (m[1] !== "*") {
      const [a, b] = m[1].split("-").map(Number);
      from = a;
      to = b ?? (m[2] === undefined ? a : max);
    }
    if (step < 1 || from < min || to > max || from > to) return null;
    for (let v = from; v <= to; v += step) values.add(v);
  }
  return [...values].sort((a, b) => a - b);
}

function isFull(values: number[], min: number, max: number): boolean {
  return values.length === max - min + 1;
}

/**
 * Minuten einer Stunde in Klartext. „alle N Minuten" nur, wenn alle Abstände
 * gleich sind, auch der über die volle Stunde hinweg: „*\/45" heißt Minute 0
 * und 45, also abwechselnd 45 und 15 Minuten, und bleibt „eigener Zeitplan".
 */
function minutesText(minutes: number[]): string | null {
  if (minutes.length === 60) return "jede Minute";
  if (minutes.length === 1) return `stündlich zur Minute ${minutes[0]}`;
  const gaps = minutes.map((m, i) => (i + 1 < minutes.length ? minutes[i + 1] : minutes[0] + 60) - m);
  return gaps.every(g => g === gaps[0]) ? `alle ${gaps[0]} Minuten` : null;
}

/**
 * Einfache Cron-Ausdrücke (fünf Felder) in Klartext, sonst „eigener Zeitplan
 * (<Ausdruck>)". Beschrieben wird die Menge der Zeitpunkte, die der Ausdruck
 * ergibt, nicht seine Schreibweise.
 */
export function describeCron(expression: string): string {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return custom(expression);
  const minutes = cronValues(fields[0], 0, 59);
  const hours = cronValues(fields[1], 0, 23);
  const days = cronValues(fields[2], 1, 31);
  const months = cronValues(fields[3], 1, 12);
  const weekdays = cronValues(fields[4], 0, 7);
  if (!minutes || !hours || !days || !months || !weekdays) return custom(expression);
  if (!isFull(months, 1, 12)) return custom(expression);
  const allDays = isFull(days, 1, 31);
  // 0 und 7 sind beide Sonntag: „0-7" und „*" meinen jeden Tag
  const allWeekdays = new Set(weekdays.map(d => d % 7)).size === 7;
  if (isFull(hours, 0, 23)) return allDays && allWeekdays ? (minutesText(minutes) ?? custom(expression)) : custom(expression);
  if (minutes.length !== 1 || hours.length !== 1) return custom(expression);
  const at = time(hours[0], minutes[0]);
  if (allDays && allWeekdays) return `täglich ${at}`;
  if (allDays) return `${weekdaysText(weekdays)} ${at}`;
  return days.length === 1 && allWeekdays ? `monatlich am ${days[0]}. um ${at}` : custom(expression);
}

/** Zeitplan einer Routine in Klartext */
export function describeSchedule(s: RoutineSchedule): string {
  if (s.type === "cron") return s.cron ? describeCron(s.cron) : "Dauerdienst";
  if (s.type === "systemd") {
    if (s.onCalendar.length === 0) return "kein Zeitplan";
    if (!s.calendar) return custom(s.onCalendar.join(", "));
    const text = describeCalendar(s.calendar.length === 1 ? s.calendar[0] : s.calendar);
    return s.timeZone ? `${text} (${s.timeZone})` : text;
  }
  const parts: string[] = [];
  if (s.StartCalendarInterval !== undefined) parts.push(describeCalendar(s.StartCalendarInterval));
  if (s.StartInterval !== undefined) parts.push(describeInterval(s.StartInterval));
  if (parts.length) {
    const text = parts.join("; ");
    return s.RunAtLoad === true ? `${text}, auch beim Anmelden` : text;
  }
  if (keepsAlive(s.KeepAlive)) return "Dauerdienst";
  if (s.otherTriggers.length) return `eigener Zeitplan (${s.otherTriggers.join(", ")})`;
  if (s.RunAtLoad === true) return "beim Anmelden";
  return "kein Zeitplan";
}

// ---------------------------------------------------------------------------
// Nächster Lauf (Issue #285)
// ---------------------------------------------------------------------------

/** Systemzeitzone, in der launchd StartCalendarInterval auswertet */
export function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

interface WallTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0 Sonntag bis 6 Samstag */
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAY_SHORT: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wanduhrzeit eines Zeitpunkts in einer Zeitzone */
export function wallTime(ms: number, timeZone: string): WallTime {
  const parts: Record<string, string> = {};
  for (const p of formatter(timeZone).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    weekday: WEEKDAY_SHORT[parts.weekday] ?? 0,
  };
}

/** Abstand der Zeitzone zu UTC in ms zu einem Zeitpunkt */
function offsetAt(ms: number, timeZone: string): number {
  const w = wallTime(ms, timeZone);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return asUtc - Math.floor(ms / 60_000) * 60_000;
}

/**
 * Zeitpunkt einer Wanduhrzeit. Gibt es sie zweimal (Umstellung auf
 * Winterzeit), gilt die frühere; gibt es sie nicht (Umstellung auf
 * Sommerzeit), die um die Lücke spätere (02:30 wird 03:30).
 */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const before = offsetAt(guess - 86_400_000, timeZone);
  const after = offsetAt(guess + 86_400_000, timeZone);
  const fits = [...new Set([before, after])]
    .map(o => guess - o)
    .filter(t => {
      const w = wallTime(t, timeZone);
      return w.year === year && w.month === month && w.day === day && w.hour === hour && w.minute === minute;
    });
  if (fits.length) return Math.min(...fits);
  return guess - before;
}

function range(from: number, to: number): number[] {
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

/** Wie viele Tage nach vorn gesucht wird: vier Jahre, damit auch der 29.2. gefunden wird */
const SEARCH_DAYS = 4 * 366 + 1;

/**
 * Nächster Zeitpunkt eines Kalender-Eintrags nach now (strikt später, auf
 * die Minute). Fehlende Schlüssel heißen „jeder Wert" wie bei launchd.
 * Sind Day und Weekday beide gesetzt, ist die Bedeutung nicht eindeutig
 * belegt: null.
 */
function nextForEntry(e: CalendarEntry, now: number, timeZone: string): number | null {
  if (e.Day !== undefined && e.Weekday !== undefined) return null;
  const hours = e.Hour === undefined ? range(0, 23) : [e.Hour];
  const minutes = e.Minute === undefined ? range(0, 59) : [e.Minute];
  const today = wallTime(now, timeZone);
  for (let i = 0; i < SEARCH_DAYS; i++) {
    // Kalendertag i Tage nach heute, Mittag als Anker gegen Umstellungen
    const anchor = new Date(Date.UTC(today.year, today.month - 1, today.day + i, 12));
    const y = anchor.getUTCFullYear();
    const mo = anchor.getUTCMonth() + 1;
    const d = anchor.getUTCDate();
    const wd = anchor.getUTCDay();
    if (e.Month !== undefined && e.Month !== mo) continue;
    if (e.Day !== undefined && e.Day !== d) continue;
    if (e.Weekday !== undefined && e.Weekday % 7 !== wd) continue;
    for (const h of hours) {
      for (const m of minutes) {
        const t = zonedTime(y, mo, d, h, m, timeZone);
        if (t > now) return t;
      }
    }
  }
  return null;
}

/**
 * Letzter Zeitpunkt eines Kalender-Eintrags bis einschließlich until, höchstens
 * days Kalendertage zurück. Rückwärts statt wiederholt vorwärts: je Tag nur
 * Stunden bis zur aktuellen, bei „jede Minute" also höchstens 60 Minuten am
 * ersten Tag und eine am Vortag. Day und Weekday zugleich: null wie nextForEntry.
 */
function lastForEntry(e: CalendarEntry, until: number, timeZone: string, days: number): number | null {
  if (e.Day !== undefined && e.Weekday !== undefined) return null;
  const hours = (e.Hour === undefined ? range(0, 23) : [e.Hour]).reverse();
  const minutes = (e.Minute === undefined ? range(0, 59) : [e.Minute]).reverse();
  const end = wallTime(until, timeZone);
  for (let i = 0; i <= days; i++) {
    const anchor = new Date(Date.UTC(end.year, end.month - 1, end.day - i, 12));
    const y = anchor.getUTCFullYear();
    const mo = anchor.getUTCMonth() + 1;
    const d = anchor.getUTCDate();
    if (e.Month !== undefined && e.Month !== mo) continue;
    if (e.Day !== undefined && e.Day !== d) continue;
    if (e.Weekday !== undefined && e.Weekday % 7 !== anchor.getUTCDay()) continue;
    for (const h of hours) {
      // Spätere Stunden desselben Tages liegen auch bei Zeitumstellung nach until
      if (i === 0 && h > end.hour) continue;
      for (const m of minutes) {
        const t = zonedTime(y, mo, d, h, m, timeZone);
        if (t <= until) return t;
      }
    }
  }
  return null;
}

/**
 * Letzter Termin eines StartCalendarInterval bis einschließlich until,
 * höchstens days Tage zurück. "invalid": Zeitplan nicht auswertbar, sobald
 * ein einziger Eintrag es ist (unbekannte Schlüssel oder Werte, leere Liste,
 * Day und Weekday zugleich, weder im Fenster noch in den nächsten vier Jahren
 * ein Termin wie bei nextRun); ein gültiger Eintrag daneben ändert daran
 * nichts. null: kein Eintrag hat einen Termin im Fenster, der letzte Termin
 * liegt also davor und ist unbekannt.
 */
export function lastCalendarRun(calendar: unknown, until: number, timeZone: string, days: number): number | null | "invalid" {
  const list = Array.isArray(calendar) ? calendar : [calendar];
  const entries = list.map(parseEntry);
  if (!list.length || entries.some(e => e === null)) return "invalid";
  let last: number | null = null;
  for (const e of entries as CalendarEntry[]) {
    const t = lastForEntry(e, until, timeZone, days);
    if (t === null && nextForEntry(e, until, timeZone) === null) return "invalid";
    if (t !== null && (last === null || t > last)) last = t;
  }
  return last;
}

export interface NextRunOptions {
  /** Jetzt in ms */
  now: number;
  /** Beginn des letzten Laufs in ms (aus dem Protokoll); null, wenn unbekannt */
  lastStart: number | null;
  /** Zeitzone für StartCalendarInterval; Standard die des Systems */
  timeZone?: string;
}

/**
 * Nächster Lauf in ms oder null.
 *
 * - StartCalendarInterval: frühester nächster Termin aller Einträge in der
 *   Zeitzone des Systems; ungültige Einträge machen das Ergebnis null.
 * - StartInterval: Beginn des letzten Laufs plus Intervall; ohne letzten
 *   Lauf null. Das Ergebnis kann in der Vergangenheit liegen (der Lauf ist
 *   fällig, etwa nach dem Ruhezustand); die Anzeige sagt dann „fällig".
 * - Beides: der frühere Zeitpunkt. PM2, RunAtLoad allein und Dauerdienste: null.
 * - systemd-Timer (Issue #568): wie StartCalendarInterval, in der Zeitzone
 *   des Timers, ohne eigene in der des Systems.
 */
export function nextRun(s: RoutineSchedule | null, opts: NextRunOptions): number | null {
  if (s?.type === "systemd") {
    if (!s.calendar) return null;
    const tz = s.timeZone ?? opts.timeZone ?? systemTimeZone();
    const times = s.calendar.map(e => parseEntry(e)).map(e => (e ? nextForEntry(e, opts.now, tz) : null));
    if (times.some(t => t === null)) return null;
    return Math.min(...(times as number[]));
  }
  if (!s || s.type !== "launchd") return null;
  const timeZone = opts.timeZone ?? systemTimeZone();
  const candidates: number[] = [];
  if (s.StartCalendarInterval !== undefined) {
    const list = Array.isArray(s.StartCalendarInterval) ? s.StartCalendarInterval : [s.StartCalendarInterval];
    const entries = list.map(parseEntry);
    if (!list.length || entries.some(e => e === null)) return null;
    for (const e of entries as CalendarEntry[]) {
      const t = nextForEntry(e, opts.now, timeZone);
      if (t !== null) candidates.push(t);
    }
  }
  if (s.StartInterval !== undefined && isInt(s.StartInterval, 1, Number.MAX_SAFE_INTEGER) && opts.lastStart !== null) {
    candidates.push(opts.lastStart + s.StartInterval * 1000);
  }
  return candidates.length ? Math.min(...candidates) : null;
}
