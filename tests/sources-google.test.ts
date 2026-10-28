/**
 * Issue #355: Quellen Kalender und Gmail über runSource. Ohne Netz: fetch
 * und Uhr (now) sind Attrappen, der Token-Speicher ist vor jedem Test leer.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { clearGoogleTokenCache } from "../src/lib/google/token";
import { calendarSource, followingDay, startOfDayIn } from "../src/lib/sources/calendar";
import { gmailSource, MAX_SHOWN, senderName } from "../src/lib/sources/gmail";
import { SOURCES } from "../src/lib/sources/list";
import { runSource } from "../src/lib/sources/run";
import type { Section, Source } from "../src/lib/sources/types";

const GOOGLE = { GOOGLE_CLIENT_ID: "client-attrappe", GOOGLE_CLIENT_SECRET: "secret-attrappe", GOOGLE_REFRESH_TOKEN: "refresh-attrappe" };
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const MESSAGES = "https://gmail.googleapis.com/gmail/v1/users/me/messages";

interface Call {
  url: string;
  init: RequestInit;
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Google-Attrappe: Token immer, alles andere über answer */
function fakeGoogle(answer: (url: URL, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === TOKEN_URL) return json({ access_token: "token-attrappe", expires_in: 3600 });
    return answer(new URL(url), init);
  }) as unknown as typeof fetch;
  return { fn, calls, api: () => calls.filter(c => c.url !== TOKEN_URL) };
}

async function sectionOf(source: Source, env: Record<string, string>, now: Date, fetchFn: typeof fetch): Promise<Section> {
  const outcome = await runSource(source, { env, now, fetch: fetchFn });
  if (outcome.status !== "ok") throw new Error(`unerwartet: ${outcome.status} ${"error" in outcome ? outcome.error : ""}`);
  return outcome.section;
}

const hanging = (_url: URL, init: RequestInit) =>
  new Promise<Response>((_, reject) => {
    init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

beforeEach(() => {
  clearGoogleTokenCache();
  // Uhr-Attrappe auch für den Token-Abruf, der die Systemzeit liest
  setSystemTime(new Date("2026-01-15T08:00:00Z"));
});

afterEach(() => setSystemTime());

describe("Liste", () => {
  test("Reihenfolge Kalender, Gmail, Notion, Nachrichten, Ziele", () => {
    expect(SOURCES.map(s => s.id)).toEqual(["calendar", "gmail", "notion-tasks", "news", "goals"]);
  });

  test("Kalender und Gmail bereit nur mit dem Google-Zugang", () => {
    for (const source of [calendarSource, gmailSource]) {
      expect(source.ready(GOOGLE)).toBe(true);
      expect(source.ready({ ...GOOGLE, GOOGLE_CLIENT_SECRET: "" })).toBe(false);
      expect(source.ready({})).toBe(false);
    }
  });
});

describe("Kalender: Fenster", () => {
  async function window(zone: string | undefined, now: string) {
    const fake = fakeGoogle(() => json({ items: [] }));
    const env: Record<string, string> = { ...GOOGLE };
    if (zone !== undefined) env.USER_TIMEZONE = zone;
    await sectionOf(calendarSource, env, new Date(now), fake.fn);
    const url = new URL(fake.api()[0].url);
    return [url.searchParams.get("timeMin"), url.searchParams.get("timeMax")];
  }

  const cases: [string, string | undefined, string, string, string][] = [
    ["Berlin, Wintertag", "Europe/Berlin", "2026-01-15T08:00:00Z", "2026-01-14T23:00:00.000Z", "2026-01-15T23:00:00.000Z"],
    ["Berlin, Sommertag", "Europe/Berlin", "2026-07-15T08:00:00Z", "2026-07-14T22:00:00.000Z", "2026-07-15T22:00:00.000Z"],
    ["Berlin, Umstellung auf Sommerzeit (23 Stunden)", "Europe/Berlin", "2026-03-29T10:00:00Z", "2026-03-28T23:00:00.000Z", "2026-03-29T22:00:00.000Z"],
    ["Berlin, Umstellung auf Winterzeit (25 Stunden)", "Europe/Berlin", "2026-10-25T10:00:00Z", "2026-10-24T22:00:00.000Z", "2026-10-25T23:00:00.000Z"],
    ["Berlin, kurz nach Mitternacht schon der nächste Tag", "Europe/Berlin", "2026-10-18T22:30:00Z", "2026-10-18T22:00:00.000Z", "2026-10-19T22:00:00.000Z"],
    ["New York kurz vor Mitternacht: lokaler Tag", "America/New_York", "2026-01-15T04:30:00Z", "2026-01-14T05:00:00.000Z", "2026-01-15T05:00:00.000Z"],
    ["ungültige Zeitzone: UTC", "Mars/Basis", "2026-01-15T08:00:00Z", "2026-01-15T00:00:00.000Z", "2026-01-16T00:00:00.000Z"],
    ["ohne Zeitzone: UTC", undefined, "2026-01-15T23:59:00Z", "2026-01-15T00:00:00.000Z", "2026-01-16T00:00:00.000Z"],
  ];
  for (const [label, zone, now, min, max] of cases) {
    test(label, async () => {
      expect(await window(zone, now)).toEqual([min, max]);
    });
  }

  test("Hilfen: Folgetag über Monats- und Jahresgrenze, Mitternacht in New York im Sommer", () => {
    expect(followingDay("2026-12-31")).toBe("2027-01-01");
    expect(followingDay("2028-02-28")).toBe("2028-02-29");
    expect(startOfDayIn("2026-07-04", "America/New_York").toISOString()).toBe("2026-07-04T04:00:00.000Z");
  });

  test("übrige Parameter, Token im Kopf, Signal bei fetch", async () => {
    const fake = fakeGoogle(() => json({ items: [] }));
    await sectionOf(calendarSource, GOOGLE, new Date("2026-01-15T08:00:00Z"), fake.fn);
    const [call] = fake.api();
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe(CALENDAR);
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("orderBy")).toBe("startTime");
    expect(url.searchParams.get("maxResults")).toBe("15");
    expect(new Headers(call.init.headers).get("Authorization")).toBe("Bearer token-attrappe");
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
    // auch der Token-Abruf bekommt fetch aus dem Kontext
    expect(fake.calls[0].url).toBe(TOKEN_URL);
  });
});

describe("Kalender: Termine", () => {
  const ENV = { ...GOOGLE, USER_TIMEZONE: "Europe/Berlin" };
  const NOW = new Date("2026-01-15T08:00:00Z");

  test("ganztägig: heute, mehrtägig über heute, gestern mit Ende heute fehlt, morgen fehlt", async () => {
    const fake = fakeGoogle(() =>
      json({
        items: [
          { summary: "Gestern", start: { date: "2026-01-14" }, end: { date: "2026-01-15" } },
          { summary: "Messe", start: { date: "2026-01-13" }, end: { date: "2026-01-17" } },
          { summary: "Urlaub", start: { date: "2026-01-15" }, end: { date: "2026-01-16" } },
          { summary: "Morgen", start: { date: "2026-01-16" }, end: { date: "2026-01-17" } },
        ],
      }),
    );
    const section = await sectionOf(calendarSource, ENV, NOW, fake.fn);
    expect(section.items).toEqual([
      { text: "Messe", allDay: true },
      { text: "Urlaub", allDay: true },
    ]);
  });

  test("mehrtägiger ganztägiger Termin erscheint an jedem seiner Tage", async () => {
    const event = { summary: "Messe", start: { date: "2026-01-13" }, end: { date: "2026-01-16" } };
    const days = ["2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15", "2026-01-16"];
    const seen: string[] = [];
    for (const day of days) {
      const fake = fakeGoogle(() => json({ items: [event] }));
      const section = await sectionOf(calendarSource, ENV, new Date(`${day}T10:00:00Z`), fake.fn);
      if (section.items.length) seen.push(day);
    }
    expect(seen).toEqual(["2026-01-13", "2026-01-14", "2026-01-15"]);
  });

  test("mit Uhrzeit: Beginn und Ende als Zeitpunkt; ohne Titel „(ohne Titel)“", async () => {
    const fake = fakeGoogle(() =>
      json({
        items: [
          { summary: "Standup", start: { dateTime: "2026-01-15T09:00:00+01:00" }, end: { dateTime: "2026-01-15T09:15:00+01:00" } },
          { start: { dateTime: "2026-01-15T13:00:00Z" }, end: { dateTime: "2026-01-15T14:00:00Z" } },
        ],
      }),
    );
    const section = await sectionOf(calendarSource, ENV, NOW, fake.fn);
    expect(section.items).toEqual([
      { text: "Standup", start: "2026-01-15T08:00:00.000Z", end: "2026-01-15T08:15:00.000Z" },
      { text: "(ohne Titel)", start: "2026-01-15T13:00:00.000Z", end: "2026-01-15T14:00:00.000Z" },
    ]);
  });

  test("mit Uhrzeit, aber ohne Beginn oder Ende: bleibt ein Eintrag ohne die fehlende Angabe", async () => {
    const fake = fakeGoogle(() =>
      json({
        items: [
          { summary: "Ohne Ende", start: { dateTime: "2026-01-15T09:00:00+01:00" } },
          { summary: "Kaputt", start: { dateTime: "kein Datum" }, end: {} },
        ],
      }),
    );
    const section = await sectionOf(calendarSource, ENV, NOW, fake.fn);
    expect(section.items).toEqual([{ text: "Ohne Ende", start: "2026-01-15T08:00:00.000Z" }, { text: "Kaputt" }]);
  });

  test("leere Liste: leerer Abschnitt", async () => {
    expect(await sectionOf(calendarSource, ENV, NOW, fakeGoogle(() => json({ items: [] })).fn)).toEqual({ items: [] });
    expect(await sectionOf(calendarSource, ENV, NOW, fakeGoogle(() => json({})).fn)).toEqual({ items: [] });
  });

  for (const status of [401, 500]) {
    test(`HTTP ${status}: failed ohne Antworttext`, async () => {
      const fake = fakeGoogle(() => json({ error: { message: "Kalender von Alex intern" } }, status));
      const outcome = await runSource(calendarSource, { env: ENV, now: NOW, fetch: fake.fn });
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") return;
      expect(outcome.error).toContain(String(status));
      expect(outcome.error).not.toContain("intern");
    });
  }

  test("Token abgelehnt: failed mit Code, ohne Beschreibung", async () => {
    const fn = (async () => json({ error: "invalid_grant", error_description: "Bad Request intern" }, 400)) as unknown as typeof fetch;
    const outcome = await runSource(calendarSource, { env: ENV, now: NOW, fetch: fn });
    expect(outcome).toMatchObject({ status: "failed" });
    if (outcome.status !== "failed") return;
    expect(outcome.error).toContain("invalid_grant");
    expect(outcome.error).not.toContain("intern");
  });

  test("hängender Abruf: timeout, das Signal kommt bei fetch an", async () => {
    const fake = fakeGoogle(hanging);
    const outcome = await runSource({ ...calendarSource, timeoutMs: 20 }, { env: ENV, now: NOW, fetch: fake.fn });
    expect(outcome.status).toBe("timeout");
    expect(fake.api()[0].init.signal?.aborted).toBe(true);
  });
});

describe("Gmail", () => {
  const NOW = new Date("2026-01-15T08:00:00Z");

  /** Liste mit total Ungelesenen und count Kennungen; Details je Kennung */
  function inbox(total: number, count: number, detail: (id: string) => Response | Promise<Response> = id => mail(`Absender ${id} <${id}@example.com>`, `Betreff ${id}`)) {
    const messages = Array.from({ length: count }, (_, i) => ({ id: `m${i + 1}` }));
    return fakeGoogle((url, init) => {
      if (url.pathname.endsWith("/messages")) return json({ resultSizeEstimate: total, messages });
      return detail(url.pathname.split("/").pop()!) ?? hanging(url, init);
    });
  }

  function mail(from?: string, subject?: string) {
    const headers = [];
    if (subject !== undefined) headers.push({ name: "Subject", value: subject });
    if (from !== undefined) headers.push({ name: "From", value: from });
    return json({ payload: { headers } });
  }

  test("Liste mit is:unread in:inbox; bei zehn Treffern höchstens fünf Detailabrufe mit Metadaten", async () => {
    const fake = inbox(10, 10);
    const section = await sectionOf(gmailSource, GOOGLE, NOW, fake.fn);
    const [list, ...details] = fake.api();
    const listUrl = new URL(list.url);
    expect(listUrl.origin + listUrl.pathname).toBe(MESSAGES);
    expect(listUrl.searchParams.get("q")).toBe("is:unread in:inbox");
    expect(listUrl.searchParams.get("maxResults")).toBe("10");
    expect(details).toHaveLength(MAX_SHOWN);
    for (const call of [list, ...details]) {
      expect(call.init.signal).toBeInstanceOf(AbortSignal);
      expect(new Headers(call.init.headers).get("Authorization")).toBe("Bearer token-attrappe");
    }
    const detailUrl = new URL(details[0].url);
    expect(detailUrl.searchParams.get("format")).toBe("metadata");
    expect(detailUrl.searchParams.getAll("metadataHeaders")).toEqual(["Subject", "From"]);
    expect(section.total).toBe(10);
    expect(section.items).toHaveLength(5);
  });

  test("Gesamtzahl 0: leerer Abschnitt ohne Detailabruf", async () => {
    const fake = inbox(0, 0);
    expect(await sectionOf(gmailSource, GOOGLE, NOW, fake.fn)).toEqual({ items: [], total: 0 });
    expect(fake.api()).toHaveLength(1);
  });

  test("ein Detailabruf von fünf scheitert (HTTP oder geworfen): nur dieser fehlt, Gesamtzahl bleibt", async () => {
    for (const broken of [() => json({}, 500), () => Promise.reject(new Error("Verbindung weg"))]) {
      clearGoogleTokenCache();
      const fake = inbox(5, 5, id => (id === "m2" ? broken() : mail(`${id} <${id}@example.com>`, `Betreff ${id}`)));
      const section = await sectionOf(gmailSource, GOOGLE, NOW, fake.fn);
      expect(section.items.map(i => i.text)).toEqual(["m1: Betreff m1", "m3: Betreff m3", "m4: Betreff m4", "m5: Betreff m5"]);
      expect(section.total).toBe(5);
    }
  });

  test("alle Detailabrufe scheitern: keine Einträge, Gesamtzahl bleibt", async () => {
    const section = await sectionOf(gmailSource, GOOGLE, NOW, inbox(12, 10, () => json({}, 503)).fn);
    expect(section).toEqual({ items: [], total: 12 });
  });

  test("Absendername, fehlender Betreff, Adresse ohne Namen", async () => {
    const answers: Record<string, Response> = {
      m1: mail("Alex Beispiel <alex@example.com>", "Hallo"),
      m2: mail("mia@example.com", "Rechnung"),
      m3: mail("Team <team@example.com>"),
      m4: mail(undefined, "Ohne Absender"),
    };
    const section = await sectionOf(gmailSource, GOOGLE, NOW, inbox(4, 4, id => answers[id]).fn);
    expect(section.items.map(i => i.text)).toEqual(["Alex Beispiel: Hallo", "mia@example.com: Rechnung", "Team: (ohne Betreff)", ": Ohne Absender"]);
    expect(senderName("<nur@example.com>")).toBe("<nur@example.com>");
    expect(senderName('"Mia" <mia@example.com>')).toBe('"Mia"');
  });

  test("HTTP-Fehler der Liste: failed ohne Antworttext", async () => {
    for (const status of [401, 500]) {
      clearGoogleTokenCache();
      const fake = fakeGoogle(() => json({ error: { message: "Postfach intern" } }, status));
      const outcome = await runSource(gmailSource, { env: GOOGLE, now: NOW, fetch: fake.fn });
      expect(outcome.status).toBe("failed");
      if (outcome.status !== "failed") return;
      expect(outcome.error).toContain(String(status));
      expect(outcome.error).not.toContain("intern");
    }
  });

  test("Zeitlimit während der Detailabrufe: timeout statt still fehlender Einträge, Signal kommt an", async () => {
    const fake = inbox(3, 3, () => undefined as unknown as Response);
    const outcome = await runSource({ ...gmailSource, timeoutMs: 20 }, { env: GOOGLE, now: NOW, fetch: fake.fn });
    expect(outcome.status).toBe("timeout");
    expect(fake.api().slice(1).every(c => c.init.signal?.aborted)).toBe(true);
  });
});
