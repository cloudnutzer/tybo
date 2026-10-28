/**
 * Issue #354: Quellen Notion und Nachrichten mit fetch-Attrappen, kein Netz.
 * Je Quelle Erfolg, Zeitlimit (hängender Aufruf, Signal kommt an), 401 und
 * leere Liste; dazu Schemaannahmen und Tagesgrenze von Notion, die Wahl des
 * Nachrichten-Anbieters und dass unbelegte Nachrichten nicht erscheinen.
 */
import { describe, expect, test } from "bun:test";
import { newsSetup, newsSource, verifiedItems, DEFAULT_OPENROUTER_MODEL, DEFAULT_XAI_MODEL, MAX_NEWS } from "../src/lib/sources/news";
import { MAX_TASKS, notionSource } from "../src/lib/sources/notion";
import { runSource } from "../src/lib/sources/run";
import type { Source } from "../src/lib/sources/types";

interface Call {
  url: string;
  init: RequestInit;
  body: any;
}

/** fetch-Attrappe: merkt sich die Aufrufe, antwortet mit answer */
function fakeFetch(answer: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { url: String(input), init, body: init.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    return answer(call);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Antwortet erst, wenn das Signal auslöst, dann mit AbortError wie echtes fetch */
const hangUntilAbort = (call: Call) =>
  new Promise<Response>((_, reject) => {
    call.init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
  });

async function timeoutCase(source: Source, env: Record<string, string>) {
  const fake = fakeFetch(hangUntilAbort);
  const quick = { ...source, timeoutMs: 20 };
  const started = Date.now();
  const outcome = await runSource(quick, { env, fetch: fake.fn });
  expect(outcome.status).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(1000);
  expect(fake.calls[0].init.signal?.aborted).toBe(true);
}

// ---------------------------------------------------------------------------
// Notion
// ---------------------------------------------------------------------------

const NOTION_ENV = { NOTION_TOKEN: "secret_attrappe", NOTION_DATABASE_ID: "db123", USER_TIMEZONE: "Europe/Berlin" };
// 22:30 UTC am 18.10. ist in Berlin schon der 19.10.
const NOW = new Date("2026-10-18T22:30:00Z");

const page = (title: string, due: string | null, extra: Record<string, unknown> = {}) => ({
  url: `https://www.notion.so/${title.replace(/\s/g, "-")}`,
  properties: {
    Aufgabe: { type: "title", title: [{ plain_text: title.slice(0, 3) }, { plain_text: title.slice(3) }] },
    Due: { type: "date", date: due ? { start: due } : null },
    Status: { type: "status", status: { name: "Offen" } },
    ...extra,
  },
});

describe("Notion", () => {
  test("bereit nur mit Token und Datenbank", () => {
    expect(notionSource.ready(NOTION_ENV)).toBe(true);
    expect(notionSource.ready({ NOTION_TOKEN: "x" })).toBe(false);
    expect(notionSource.ready({ NOTION_DATABASE_ID: "x", NOTION_TOKEN: "  " })).toBe(false);
  });

  test("Erfolg: Abfrage nach Schema, heute in USER_TIMEZONE, Einträge mit Frist", async () => {
    const fake = fakeFetch(() =>
      json({ results: [page("Steuer abgeben", "2026-10-17"), page("Anrufen", "2026-10-19T09:00:00.000+02:00"), page("Ohne Datum", null)] }),
    );
    const outcome = await runSource(notionSource, { env: NOTION_ENV, now: NOW, fetch: fake.fn });
    expect(outcome.status === "ok" && outcome.section).toEqual({
      items: [
        { text: "Steuer abgeben", due: "2026-10-17", overdue: true, link: "https://www.notion.so/Steuer-abgeben" },
        { text: "Anrufen", due: "2026-10-19", link: "https://www.notion.so/Anrufen" },
        { text: "Ohne Datum", link: "https://www.notion.so/Ohne-Datum" },
      ],
    });
    const [call] = fake.calls;
    expect(call.url).toBe("https://api.notion.com/v1/databases/db123/query");
    expect(call.init.method).toBe("POST");
    const headers = new Headers(call.init.headers);
    expect(headers.get("authorization")).toBe("Bearer secret_attrappe");
    expect(headers.get("notion-version")).toBe("2022-06-28");
    expect(call.body).toEqual({
      filter: {
        and: [
          { property: "Due", date: { on_or_before: "2026-10-19" } },
          { property: "Status", status: { does_not_equal: "Done" } },
        ],
      },
      sorts: [{ property: "Due", direction: "ascending" }],
      page_size: MAX_TASKS,
    });
  });

  test("ohne USER_TIMEZONE gilt der Tag in UTC", async () => {
    const fake = fakeFetch(() => json({ results: [] }));
    await runSource(notionSource, { env: { NOTION_TOKEN: "t", NOTION_DATABASE_ID: "d" }, now: NOW, fetch: fake.fn });
    expect(fake.calls[0].body.filter.and[0].date.on_or_before).toBe("2026-10-18");
  });

  test("Seite ohne Titel-Eigenschaft und mit fremdem Schema bricht nicht", async () => {
    const fake = fakeFetch(() => json({ results: [{ properties: { Name: { type: "rich_text" } } }, {}] }));
    const outcome = await runSource(notionSource, { env: NOTION_ENV, now: NOW, fetch: fake.fn });
    expect(outcome.status === "ok" && outcome.section.items).toEqual([{ text: "(ohne Titel)" }, { text: "(ohne Titel)" }]);
  });

  test("leere Liste: leerer Abschnitt", async () => {
    const fake = fakeFetch(() => json({ results: [] }));
    const outcome = await runSource(notionSource, { env: NOTION_ENV, now: NOW, fetch: fake.fn });
    expect(outcome).toMatchObject({ status: "ok", section: { items: [] } });
  });

  test("401: Ausgang failed mit Hinweis, ohne den Antworttext", async () => {
    const fake = fakeFetch(() => json({ message: "API token is invalid. db123 intern" }, 401));
    const outcome = await runSource(notionSource, { env: NOTION_ENV, now: NOW, fetch: fake.fn });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error).toContain("401");
    expect(outcome.error).toContain("NOTION_TOKEN");
    expect(outcome.error).not.toContain("intern");
  });

  test("anderer Fehlerstatus: failed mit Status", async () => {
    const fake = fakeFetch(() => json({ message: "x" }, 400));
    expect(await runSource(notionSource, { env: NOTION_ENV, fetch: fake.fn })).toMatchObject({ status: "failed", error: "Notion antwortet mit HTTP 400" });
  });

  test("Zeitlimit: hängender Aufruf wird abgebrochen", () => timeoutCase(notionSource, NOTION_ENV));
});

// ---------------------------------------------------------------------------
// Nachrichten
// ---------------------------------------------------------------------------

describe("Nachrichten: Wahl des Anbieters", () => {
  test("Standard xAI mit XAI_API_KEY, Modell aus NEWS_MODEL", () => {
    expect(newsSetup({ XAI_API_KEY: "k" })).toEqual({ ok: true, provider: "xai", apiKey: "k", model: DEFAULT_XAI_MODEL });
    expect(newsSetup({ XAI_API_KEY: "k", NEWS_MODEL: "grok-x" })).toMatchObject({ ok: true, model: "grok-x" });
    expect(newsSetup({ NEWS_PROVIDER: " XAI ", XAI_API_KEY: "k" })).toMatchObject({ ok: true, provider: "xai" });
  });

  test("OpenRouter: Schlüssel und Modell NEWS_MODEL, sonst OPENROUTER_MODEL, sonst Standard", () => {
    expect(newsSetup({ NEWS_PROVIDER: "openrouter", OPENROUTER_API_KEY: "o" })).toEqual({
      ok: true,
      provider: "openrouter",
      apiKey: "o",
      model: DEFAULT_OPENROUTER_MODEL,
    });
    expect(newsSetup({ NEWS_PROVIDER: "openrouter", OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: "a/b" })).toMatchObject({ model: "a/b" });
    expect(newsSetup({ NEWS_PROVIDER: "openrouter", OPENROUTER_API_KEY: "o", OPENROUTER_MODEL: "a/b", NEWS_MODEL: "c/d" })).toMatchObject({ model: "c/d" });
  });

  test("fehlender Schlüssel und unbekannter Anbieter: nicht bereit, mit Grund", () => {
    expect(newsSetup({})).toEqual({ ok: false, provider: "xai", problem: "missing-key" });
    expect(newsSetup({ NEWS_PROVIDER: "openrouter", XAI_API_KEY: "k" })).toEqual({ ok: false, provider: "openrouter", problem: "missing-key" });
    expect(newsSetup({ NEWS_PROVIDER: "bing", XAI_API_KEY: "k" })).toEqual({ ok: false, provider: "bing", problem: "unknown-provider" });
    expect(newsSource.ready({})).toBe(false);
    expect(newsSource.ready({ NEWS_PROVIDER: "bing", XAI_API_KEY: "k" })).toBe(false);
    expect(newsSource.ready({ XAI_API_KEY: "k" })).toBe(true);
  });

  test("nicht bereit: der Lauf überspringt ohne Netz", async () => {
    const fake = fakeFetch(() => json({}));
    expect((await runSource(newsSource, { env: { NEWS_PROVIDER: "bing", XAI_API_KEY: "k" }, fetch: fake.fn })).status).toBe("skipped");
    expect(fake.calls).toHaveLength(0);
  });
});

const XAI_ENV = { XAI_API_KEY: "xai-attrappe" };

/** Antwort der xAI Responses API mit Text und Zitaten */
const xaiAnswer = (text: string, citations: string[], annotations: string[] = []) =>
  json({
    output: [
      { type: "web_search_call", status: "completed" },
      {
        type: "message",
        content: [{ type: "output_text", text, annotations: annotations.map(url => ({ type: "url_citation", url })) }],
      },
    ],
    citations,
  });

describe("Nachrichten über xAI", () => {
  test("Erfolg: Responses API mit Websuche, belegte Zeilen als Einträge", async () => {
    const fake = fakeFetch(() =>
      xaiAnswer(
        [
          "• Labor A stellt Modell B vor (https://example.com/a).",
          "- Firma C kauft D (https://www.news.test/c)",
          "Erfundene Meldung ohne Quelle",
          "Meldung mit fremder Quelle (https://unbelegt.test/x)",
        ].join("\n"),
        ["https://example.com/a"],
        ["https://news.test/c/?utm_source=openai#oben"],
      ),
    );
    const outcome = await runSource(newsSource, { env: XAI_ENV, fetch: fake.fn });
    expect(outcome.status === "ok" && outcome.section).toEqual({
      items: [
        { text: "Labor A stellt Modell B vor.", link: "https://example.com/a" },
        { text: "Firma C kauft D", link: "https://www.news.test/c" },
      ],
    });
    const [call] = fake.calls;
    expect(call.url).toBe("https://api.x.ai/v1/responses");
    expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer xai-attrappe");
    expect(call.body.model).toBe(DEFAULT_XAI_MODEL);
    expect(call.body.tools).toEqual([{ type: "web_search" }, { type: "x_search" }]);
  });

  test("ohne Belege: keine Einträge, Hinweis", async () => {
    const fake = fakeFetch(() => xaiAnswer("• Große Neuigkeit (https://example.com/a)", []));
    const outcome = await runSource(newsSource, { env: XAI_ENV, fetch: fake.fn });
    expect(outcome.status === "ok" && outcome.section).toEqual({ items: [], note: "Keine belegten Nachrichten aus der Suche." });
  });

  test("leere Antwort: leerer Abschnitt mit Hinweis", async () => {
    const fake = fakeFetch(() => json({ output: [], citations: [] }));
    const outcome = await runSource(newsSource, { env: XAI_ENV, fetch: fake.fn });
    expect(outcome).toMatchObject({ status: "ok", section: { items: [] } });
  });

  test("401: failed, Schlüssel abgelehnt", async () => {
    const fake = fakeFetch(() => json({ error: "bad key xai-attrappe" }, 401));
    const outcome = await runSource(newsSource, { env: XAI_ENV, fetch: fake.fn });
    expect(outcome).toMatchObject({ status: "failed", error: "xAI lehnt den Schlüssel ab (HTTP 401)" });
  });

  test("anderer Fehler (410): failed mit Status", async () => {
    const fake = fakeFetch(() => json({}, 410));
    expect(await runSource(newsSource, { env: XAI_ENV, fetch: fake.fn })).toMatchObject({ status: "failed", error: "xAI antwortet mit HTTP 410" });
  });

  test("Zeitlimit: hängender Aufruf wird abgebrochen", () => timeoutCase(newsSource, XAI_ENV));
});

describe("Nachrichten über OpenRouter", () => {
  const ENV = { NEWS_PROVIDER: "openrouter", OPENROUTER_API_KEY: "or-attrappe", NEWS_MODEL: "x/y" };

  test("Erfolg: Web-Plugin, Belege aus annotations", async () => {
    const fake = fakeFetch(() =>
      json({
        choices: [
          {
            message: {
              content: "1. Neues Modell veröffentlicht (https://example.org/m)\n2. Ohne Beleg (https://sonst.test/n)",
              annotations: [{ type: "url_citation", url_citation: { url: "https://example.org/m", title: "M" } }],
            },
          },
        ],
      }),
    );
    const outcome = await runSource(newsSource, { env: ENV, fetch: fake.fn });
    expect(outcome.status === "ok" && outcome.section).toEqual({ items: [{ text: "Neues Modell veröffentlicht", link: "https://example.org/m" }] });
    const [call] = fake.calls;
    expect(call.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(call.body.model).toBe("x/y");
    expect(call.body.plugins).toEqual([{ id: "web" }]);
    expect(new Headers(call.init.headers).get("authorization")).toBe("Bearer or-attrappe");
  });

  test("leere Liste: keine choices", async () => {
    const fake = fakeFetch(() => json({ choices: [] }));
    expect(await runSource(newsSource, { env: ENV, fetch: fake.fn })).toMatchObject({ status: "ok", section: { items: [] } });
  });

  test("401: failed", async () => {
    const fake = fakeFetch(() => json({}, 401));
    expect(await runSource(newsSource, { env: ENV, fetch: fake.fn })).toMatchObject({ status: "failed", error: "OpenRouter lehnt den Schlüssel ab (HTTP 401)" });
  });

  test("Zeitlimit", () => timeoutCase(newsSource, ENV));
});

describe("verifiedItems", () => {
  test(`höchstens ${MAX_NEWS} Einträge`, () => {
    const text = Array.from({ length: 8 }, (_, i) => `Meldung ${i} (https://example.com/${i})`).join("\n");
    const citations = Array.from({ length: 8 }, (_, i) => `https://example.com/${i}`);
    expect(verifiedItems({ text, citations })).toHaveLength(MAX_NEWS);
  });

  test("Zeile nur aus Adresse ergibt keinen Eintrag", () => {
    expect(verifiedItems({ text: "https://example.com/x", citations: ["https://example.com/x"] })).toEqual([]);
  });

  test("anderer Artikel auf demselben Host zählt nicht", () => {
    const text = ["Belegt (https://example.com/news/a)", "Erfunden (https://example.com/news/b)", "Startseite (https://example.com/)"].join("\n");
    expect(verifiedItems({ text, citations: ["https://example.com/news/a"] })).toEqual([{ text: "Belegt", link: "https://example.com/news/a" }]);
  });

  test("anderer X-Beitrag auf demselben Host zählt nicht", () => {
    const text = ["Beitrag eins (https://x.com/labor/status/111)", "Beitrag zwei (https://x.com/labor/status/222)", "Profil (https://x.com/labor)"].join("\n");
    expect(verifiedItems({ text, citations: ["https://x.com/labor/status/111"] })).toEqual([
      { text: "Beitrag eins", link: "https://x.com/labor/status/111" },
    ]);
  });

  test("andere Abfrage zählt nicht, Kampagnen-Parameter und Anker schon", () => {
    const text = ["Gleich (https://news.test/artikel?id=7)", "Anders (https://news.test/artikel?id=8)"].join("\n");
    expect(verifiedItems({ text, citations: ["https://NEWS.test/artikel/?id=7&utm_medium=x#teil"] })).toEqual([
      { text: "Gleich", link: "https://news.test/artikel?id=7" },
    ]);
  });
});
