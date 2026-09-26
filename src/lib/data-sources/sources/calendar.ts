/**
 * Google Calendar Data Source
 *
 * Fetches today's events from Google Calendar REST API.
 * Uses Google OAuth refresh token — no MCP or Keychain needed.
 *
 * Required env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 */

import { register } from "../registry";
import { isGoogleAuthAvailable, getGoogleAccessToken } from "../google-auth";
import type { DataSource, DataSourceResult } from "../types";

const calendarSource: DataSource = {
  id: "calendar",
  name: "Today's Calendar",
  emoji: "📅",

  isAvailable(): boolean {
    return isGoogleAuthAvailable();
  },

  async fetch(): Promise<DataSourceResult> {
    const token = await getGoogleAccessToken();
    const tz = process.env.USER_TIMEZONE || "UTC";

    // Calculate today's bounds in user's timezone
    const now = new Date();
    const formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const todayStr = formatter.format(now); // "2026-02-13"

    const timeMin = `${todayStr}T00:00:00`;
    const timeMax = `${todayStr}T23:59:59`;

    const params = new URLSearchParams({
      timeMin: new Date(timeMin + getTimezoneOffset(tz)).toISOString(),
      timeMax: new Date(timeMax + getTimezoneOffset(tz)).toISOString(),
      singleEvents: "true",
      orderBy: "startTime",
      maxResults: "15",
    });

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Calendar API error (${response.status}): ${text}`);
    }

    const data = await response.json();
    const events = data.items || [];

    if (events.length === 0) {
      return { lines: ["No events today — open schedule"], meta: { count: 0 } };
    }

    const lines = events.map((event: any) => {
      const summary = event.summary || "(no title)";

      if (event.start?.date) {
        // All-day event
        return `• 📌 ${summary} (all day)`;
      }

      const startTime = new Date(event.start.dateTime);
      const endTime = new Date(event.end.dateTime);
      const timeStr = formatTimeRange(startTime, endTime, tz);
      return `• ${timeStr} — ${summary}`;
    });

    return { lines, meta: { count: events.length } };
  },
};

function formatTimeRange(start: Date, end: Date, tz: string): string {
  const fmt = (d: Date) =>
    d.toLocaleTimeString("en-US", {
      timeZone: tz,
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    });
  return `${fmt(start)}–${fmt(end)}`;
}

function getTimezoneOffset(tz: string): string {
  // Get the offset string for a timezone, e.g. "+01:00" or "-05:00"
  try {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "longOffset",
    }).formatToParts(now);
    const offsetPart = parts.find((p) => p.type === "timeZoneName");
    if (offsetPart?.value) {
      // "GMT+01:00" → "+01:00"
      const match = offsetPart.value.match(/GMT([+-]\d{2}:\d{2})/);
      if (match) return match[1];
    }
  } catch {}
  return "+00:00";
}

register(calendarSource);
