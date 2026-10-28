/**
 * Ortszeit für proaktive Meldungen (Issue #361).
 *
 * Alles, was an der Wanduhr des Nutzers hängt (Zeitfenster, Ruhezeit,
 * „heute schon gesendet"), rechnet mit der Ortszeit in USER_TIMEZONE. Abstände
 * (Mindestabstand, Snooze) sind dagegen echte Dauer in Millisekunden, damit
 * eine Zeitumstellung sie weder verlängert noch verkürzt.
 *
 * Zeitzone: USER_TIMEZONE, ohne Angabe UTC; lehnt Intl sie ab, ebenfalls UTC
 * (je Wert einmal ins Log).
 */

type Env = Record<string, string | undefined>;

/** Uhrzeit als "HH:MM" (00:00 bis 23:59) */
export const CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface LocalMoment {
  /** Kalenderdatum der Ortszeit, YYYY-MM-DD */
  date: string;
  /** Minuten seit Mitternacht der Ortszeit, 0 bis 1439 */
  minutes: number;
}

/** Zeitraum der Wanduhr: von (einschließlich) bis (ausschließlich), über Mitternacht erlaubt */
export interface ClockSpan {
  from: string;
  to: string;
}

const warned = new Set<string>();

function zoneAccepted(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** Wirksame Zeitzone: USER_TIMEZONE, sonst UTC */
export function proactiveTimeZone(env: Env = process.env): string {
  const wanted = env.USER_TIMEZONE?.trim() ?? "";
  if (wanted === "") return "UTC";
  if (zoneAccepted(wanted)) return wanted;
  if (!warned.has(wanted)) {
    warned.add(wanted);
    console.log(`[proactive] Zeitzone "${wanted}" unbekannt, rechne mit UTC`);
  }
  return "UTC";
}

/** "HH:MM" als Minuten seit Mitternacht; null bei ungültigem Wert */
export function clockMinutes(value: string): number | null {
  const m = CLOCK_TIME_PATTERN.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** Minuten seit Mitternacht als "HH:MM", Werte außerhalb eines Tages laufen um */
export function formatClock(minutes: number): string {
  const day = ((Math.trunc(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(day / 60)).padStart(2, "0")}:${String(day % 60).padStart(2, "0")}`;
}

/** Datum und Uhrzeit von at in der Zone */
export function localMoment(at: Date, zone: string): LocalMoment {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? "00";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    minutes: Number(part("hour")) * 60 + Number(part("minute")),
  };
}

/**
 * Liegt die Minute im Zeitraum? Gleiche Grenzen gelten als leerer Zeitraum;
 * ungültige Grenzen ebenso, damit eine kaputte Angabe nie zum Senden führt.
 */
export function withinSpan(minutes: number, span: ClockSpan): boolean {
  const start = clockMinutes(span.from);
  const end = clockMinutes(span.to);
  if (start === null || end === null || start === end) return false;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}
