/**
 * Issue #355, Aufgabe 1: Was Kalender und Gmail ins Morgenbriefing liefern
 * (Überschrift, Symbol, Anzahl, Zeilen) und wie sie Google aufrufen. Ohne
 * Netz: fetch und Uhr sind Attrappen. Seit Issue #363 sammelt die Routine
 * src/routines/briefing.ts, die Zeilen sind deutsch.
 *
 * Ausnahme (vom Issue genannte Korrektur): das Ende des Kalenderfensters.
 * Der alte Abruf über fetchAll() endete um 23:59:59 (2027-01-14T22:59:59.000Z),
 * der neue endet um 0:00 des Folgetags; der Test „Kalenderfenster" hält den
 * neuen Wert fest.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { draftBriefing } from "../src/routines/briefing";

const KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "USER_TIMEZONE"];
const saved = Object.fromEntries(KEYS.map(k => [k, process.env[k]]));
const realFetch = globalThis.fetch;

interface Call {
  url: string;
  init: RequestInit;
}
let calls: Call[] = [];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

/** Google-Attrappe; Token ohne Gültigkeit, damit jeder Lauf es neu holt */
function google(answer: (url: URL) => Response | undefined) {
  calls = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input instanceof Request ? input.url : input);
    calls.push({ url, init });
    if (url === "https://oauth2.googleapis.com/token") return json({ access_token: "token-attrappe", expires_in: 0 });
    return answer(new URL(url)) ?? json({}, 404);
  }) as typeof fetch;
}

/** Abschnitte so, wie das Briefing sie bekommt */
async function briefing() {
  const { parts } = await draftBriefing({ name: "Alex" });
  const part = (id: string) => parts.find(p => p.id === id);
  const section = (id: string) => {
    const found = part(id);
    if (found?.status !== "ok") return undefined;
    return { name: found.title, emoji: found.symbol, lines: found.lines, count: found.count };
  };
  return { section, failed: (id: string) => part(id) !== undefined && part(id)!.status !== "ok" };
}

const googleCalls = (prefix: string) => calls.filter(c => c.url.startsWith(prefix));

beforeEach(() => {
  process.env.GOOGLE_CLIENT_ID = "client-attrappe";
  process.env.GOOGLE_CLIENT_SECRET = "secret-attrappe";
  process.env.GOOGLE_REFRESH_TOKEN = "refresh-attrappe";
  process.env.USER_TIMEZONE = "Europe/Berlin";
  // Donnerstag, 14. Januar 2027, 9 Uhr in Berlin; liegt nach jedem Token, das ein früherer Test im selben Prozess abgelegt haben kann
  setSystemTime(new Date("2027-01-14T08:00:00Z"));
});

afterEach(() => {
  setSystemTime();
  globalThis.fetch = realFetch;
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const CALENDAR = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const GMAIL_LIST = "https://gmail.googleapis.com/gmail/v1/users/me/messages?";
const GMAIL_MESSAGE = "https://gmail.googleapis.com/gmail/v1/users/me/messages/";

function calendarAnswer(items: unknown[], status = 200) {
  google(url => (url.href.startsWith(CALENDAR) ? json({ items }, status) : undefined));
}

describe("Kalender im Briefing", () => {
  test("ganztägig und mit Uhrzeit, ohne Titel: Zeilen, Anzahl", async () => {
    calendarAnswer([
      { summary: "Urlaub", start: { date: "2027-01-14" }, end: { date: "2027-01-15" } },
      { summary: "Standup", start: { dateTime: "2027-01-14T09:00:00+01:00" }, end: { dateTime: "2027-01-14T10:30:00+01:00" } },
      { start: { dateTime: "2027-01-14T13:00:00Z" }, end: { dateTime: "2027-01-14T14:00:00Z" } },
    ]);
    expect((await briefing()).section("calendar")).toEqual({
      name: "Termine heute",
      emoji: "📅",
      lines: ["• ganztägig: Urlaub", "• 09:00 bis 10:30: Standup", "• 14:00 bis 15:00: (ohne Titel)"],
      count: 3,
    });
  });

  test("Termin mit Uhrzeit ohne Beginn oder Ende: bleibt mit Fragezeichen und zählt mit, kein freier Tag", async () => {
    calendarAnswer([
      { summary: "Ohne Ende", start: { dateTime: "2027-01-14T09:00:00+01:00" }, end: {} },
      { summary: "Ohne Zeiten", start: {}, end: {} },
    ]);
    expect((await briefing()).section("calendar")).toEqual({
      name: "Termine heute",
      emoji: "📅",
      lines: ["• 09:00 bis ?: Ohne Ende", "• ? bis ?: Ohne Zeiten"],
      count: 2,
    });
  });

  test("keine Termine: feste Zeile, Anzahl 0", async () => {
    calendarAnswer([]);
    expect((await briefing()).section("calendar")).toEqual({
      name: "Termine heute",
      emoji: "📅",
      lines: ["Keine Termine, der Tag ist frei"],
      count: 0,
    });
  });

  test("Aufruf: primärer Kalender, Parameter, Token im Kopf", async () => {
    calendarAnswer([]);
    await briefing();
    const [call] = googleCalls(CALENDAR);
    const url = new URL(call.url);
    expect(url.origin + url.pathname).toBe(CALENDAR);
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("orderBy")).toBe("startTime");
    expect(url.searchParams.get("maxResults")).toBe("15");
    expect(url.searchParams.get("timeMin")).toBe("2027-01-13T23:00:00.000Z");
    expect(new Headers(call.init.headers).get("Authorization")).toBe("Bearer token-attrappe");
  });

  test("Kalenderfenster: Ende um 0:00 des Folgetags", async () => {
    calendarAnswer([]);
    await briefing();
    expect(new URL(googleCalls(CALENDAR)[0].url).searchParams.get("timeMax")).toBe("2027-01-14T23:00:00.000Z");
  });

  test("HTTP-Fehler: statt des Abschnitts ein Fehlerhinweis", async () => {
    calendarAnswer([], 500);
    const result = await briefing();
    expect(result.section("calendar")).toBeUndefined();
    expect(result.failed("calendar")).toBe(true);
  });
});

/** Liste mit total Ungelesenen und count Kennungen; Details je Kennung */
function gmailAnswer(total: number, count: number, detail: (id: string) => Response) {
  const messages = Array.from({ length: count }, (_, i) => ({ id: `m${i + 1}` }));
  google(url => {
    if (url.href.startsWith(GMAIL_LIST)) return json({ resultSizeEstimate: total, messages });
    if (url.href.startsWith(GMAIL_MESSAGE)) return detail(url.pathname.split("/").pop()!);
    return undefined;
  });
}

const headers = (from?: string, subject?: string) => {
  const list = [];
  if (subject !== undefined) list.push({ name: "Subject", value: subject });
  if (from !== undefined) list.push({ name: "From", value: from });
  return json({ payload: { headers: list } });
};

const fromList = (id: string) => {
  const map: Record<string, () => Response> = {
    m1: () => headers("Alex Beispiel <alex@example.com>", "Hallo"),
    m2: () => headers("mia@example.com", "Rechnung"),
    m3: () => headers("Team <team@example.com>"),
    m4: () => headers("<nur@example.com>", "Nur Adresse"),
    m5: () => headers(undefined, "Ohne Absender"),
  };
  return (map[id] ?? (() => headers("Weitere <w@example.com>", `Betreff ${id}`)))();
};

describe("Gmail im Briefing", () => {
  test("zwölf Ungelesene: fünf Einträge, Rest-Zeile, Gesamtzahl", async () => {
    gmailAnswer(12, 10, fromList);
    expect((await briefing()).section("gmail")).toEqual({
      name: "Ungelesene Mails",
      emoji: "📧",
      lines: [
        "• Alex Beispiel: Hallo",
        "• mia@example.com: Rechnung",
        "• Team: (ohne Betreff)",
        "• <nur@example.com>: Nur Adresse",
        "• : Ohne Absender",
        "_und 7 weitere_",
      ],
      count: 12,
    });
  });

  test("Aufrufe: Liste mit is:unread in:inbox und maxResults 10, höchstens fünf Details mit Metadaten", async () => {
    gmailAnswer(12, 10, fromList);
    await briefing();
    const [list] = googleCalls(GMAIL_LIST);
    const listUrl = new URL(list.url);
    expect(listUrl.searchParams.get("q")).toBe("is:unread in:inbox");
    expect(listUrl.searchParams.get("maxResults")).toBe("10");
    expect(new Headers(list.init.headers).get("Authorization")).toBe("Bearer token-attrappe");
    const details = googleCalls(GMAIL_MESSAGE).filter(c => !c.url.startsWith(GMAIL_LIST));
    expect(details.map(c => new URL(c.url).pathname.split("/").pop())).toEqual(["m1", "m2", "m3", "m4", "m5"]);
    const detailUrl = new URL(details[0].url);
    expect(detailUrl.searchParams.get("format")).toBe("metadata");
    expect(detailUrl.searchParams.getAll("metadataHeaders")).toEqual(["Subject", "From"]);
  });

  test("keine Ungelesenen: feste Zeile, Anzahl 0", async () => {
    gmailAnswer(0, 0, fromList);
    expect((await briefing()).section("gmail")).toMatchObject({ lines: ["Keine ungelesenen Mails"], count: 0 });
  });

  test("ein Detailabruf scheitert: dieser Eintrag fehlt und zählt zum Rest", async () => {
    gmailAnswer(5, 5, id => (id === "m3" ? json({}, 500) : fromList(id)));
    expect((await briefing()).section("gmail")).toMatchObject({
      lines: ["• Alex Beispiel: Hallo", "• mia@example.com: Rechnung", "• <nur@example.com>: Nur Adresse", "• : Ohne Absender", "_und 1 weitere_"],
      count: 5,
    });
  });

  test("alle Detailabrufe scheitern: nur die Zahl der Ungelesenen", async () => {
    gmailAnswer(1, 1, () => json({}, 500));
    expect((await briefing()).section("gmail")).toMatchObject({ lines: ["1 ungelesene Mail"], count: 1 });
    gmailAnswer(5, 5, () => json({}, 500));
    expect((await briefing()).section("gmail")).toMatchObject({ lines: ["5 ungelesene Mails"], count: 5 });
    gmailAnswer(10, 10, () => json({}, 500));
    expect((await briefing()).section("gmail")).toMatchObject({ lines: ["10 ungelesene Mails"], count: 10 });
  });

  test("HTTP-Fehler der Liste: statt des Abschnitts ein Fehlerhinweis", async () => {
    google(url => (url.href.startsWith(GMAIL_LIST) ? json({}, 401) : undefined));
    const result = await briefing();
    expect(result.section("gmail")).toBeUndefined();
    expect(result.failed("gmail")).toBe(true);
  });
});

describe("Google-Zugang im Briefing", () => {
  test("Token per refresh_token an den Token-Endpunkt", async () => {
    calendarAnswer([]);
    await briefing();
    const token = googleCalls("https://oauth2.googleapis.com/token")[0];
    expect(token.init.method).toBe("POST");
    const body = new URLSearchParams(String(token.init.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("client_id")).toBe("client-attrappe");
    expect(body.get("client_secret")).toBe("secret-attrappe");
    expect(body.get("refresh_token")).toBe("refresh-attrappe");
  });

  test("ohne Zugangsdaten: kein Kalender, kein Gmail, kein Aufruf an Google", async () => {
    delete process.env.GOOGLE_REFRESH_TOKEN;
    calendarAnswer([]);
    const result = await briefing();
    expect(result.section("calendar")).toBeUndefined();
    expect(result.section("gmail")).toBeUndefined();
    expect(result.failed("calendar") || result.failed("gmail")).toBe(false);
    expect(calls.filter(c => c.url.includes("google"))).toEqual([]);
  });
});
