/**
 * Quelle Kalender (Issue #355): die Termine von heute aus dem primären
 * Google-Kalender. Bereit, wenn der Google-Zugang eingerichtet ist
 * (src/lib/google/token.ts).
 *
 * „Heute" ist der Kalendertag von ctx.now in ctx.timeZone. Das Fenster läuft
 * von 0:00 dieses Tages bis 0:00 des Folgetags, jeweils mit dem Versatz, der
 * zu diesem Zeitpunkt gilt; an den Tagen der Zeitumstellung hat es also 23
 * bzw. 25 Stunden. Ganztägige Termine zählen nur, wenn heute in
 * [start.date, end.date) liegt (Google nennt das Ende exklusiv).
 */
import { googleAccessToken, googleReady } from "../google/token";
import { dayIn } from "./run";
import type { Env, Section, SectionItem, Source, SourceContext } from "./types";

const EVENTS_URL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
export const MAX_EVENTS = 15;

interface EventTime {
  date?: string;
  dateTime?: string;
}

interface CalendarEvent {
  summary?: string;
  start?: EventTime;
  end?: EventTime;
}

/** Tag nach day, beide als YYYY-MM-DD */
export function followingDay(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, date + 1)).toISOString().slice(0, 10);
}

const wallClock = new Map<string, Intl.DateTimeFormat>();

/** Wie weit die Uhr in timeZone zum Zeitpunkt at vor UTC geht, in Millisekunden */
function zoneOffsetAt(at: number, timeZone: string): number {
  let format = wallClock.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    wallClock.set(timeZone, format);
  }
  const part: Record<string, number> = {};
  for (const { type, value } of format.formatToParts(new Date(at))) part[type] = Number(value);
  const shown = Date.UTC(part.year, part.month - 1, part.day, part.hour, part.minute, part.second);
  return shown - (at - (((at % 1000) + 1000) % 1000));
}

/** Zeitpunkt von 0:00 am Tag day in timeZone */
export function startOfDayIn(day: string, timeZone: string): Date {
  const [year, month, date] = day.split("-").map(Number);
  const midnightAsUtc = Date.UTC(year, month - 1, date);
  // Erst mit dem Versatz um Mitternacht UTC schätzen, dann mit dem am geschätzten Zeitpunkt nachrechnen
  const guess = midnightAsUtc - zoneOffsetAt(midnightAsUtc, timeZone);
  return new Date(midnightAsUtc - zoneOffsetAt(guess, timeZone));
}

/** Gültige Angaben als ISO-Zeitpunkt; was Google unvollständig liefert, fehlt im Eintrag */
function isoInstant(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const when = new Date(value);
  return Number.isNaN(when.getTime()) ? undefined : when.toISOString();
}

/** Eintrag für heute oder nichts */
function toItem(event: CalendarEvent, today: string): SectionItem | undefined {
  const text = event.summary || "(ohne Titel)";
  const firstDay = event.start?.date;
  if (firstDay) {
    const endDay = event.end?.date ?? followingDay(firstDay);
    return firstDay <= today && today < endDay ? { text, allDay: true } : undefined;
  }
  // Auch ohne Beginn oder Ende bleibt der Termin ein Eintrag und zählt mit
  const item: SectionItem = { text };
  const start = isoInstant(event.start?.dateTime);
  const end = isoInstant(event.end?.dateTime);
  if (start) item.start = start;
  if (end) item.end = end;
  return item;
}

export const calendarSource: Source = {
  id: "calendar",
  label: "Today's Calendar",
  ready: (env: Env) => googleReady(env),
  async collect(ctx: SourceContext): Promise<Section> {
    const today = dayIn(ctx.now, ctx.timeZone);
    const query = new URLSearchParams({
      timeMin: startOfDayIn(today, ctx.timeZone).toISOString(),
      timeMax: startOfDayIn(followingDay(today), ctx.timeZone).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: String(MAX_EVENTS),
    });
    const token = await googleAccessToken({ env: ctx.env, fetch: ctx.fetch, signal: ctx.signal });
    const response = await ctx.fetch(`${EVENTS_URL}?${query}`, {
      signal: ctx.signal,
      headers: { Authorization: `Bearer ${token}` },
    });
    // Antworttext nicht übernehmen: er kann Kalenderangaben enthalten
    if (response.status === 401) throw new Error("Google Kalender lehnt den Zugang ab (401), Google-Zugang prüfen");
    if (!response.ok) throw new Error(`Google Kalender antwortet mit HTTP ${response.status}`);
    const data = (await response.json()) as { items?: CalendarEvent[] };
    const events = Array.isArray(data.items) ? data.items : [];
    const items: SectionItem[] = [];
    for (const event of events) {
      const item = toItem(event, today);
      if (item) items.push(item);
    }
    return { items };
  },
};
