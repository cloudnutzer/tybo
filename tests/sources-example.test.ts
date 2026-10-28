/**
 * Issue #354: Die Vorlage für eigene Quellen ist selbst eine lauffähige
 * Quelle (mit fetch-Attrappe geprüft), steht aber in keiner Liste. Der alte
 * Ordner src/lib/data-sources mit Register und Vorlage ist weg (Issue #355).
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "fs";
import { join } from "path";
import { exampleSource } from "../src/lib/sources/example";
import { SOURCES } from "../src/lib/sources/list";
import { runSource } from "../src/lib/sources/run";

const ENV = { EXAMPLE_API_KEY: "attrappe", USER_TIMEZONE: "Europe/Berlin" };
const NOW = new Date("2026-10-18T22:30:00Z");

function fakeFetch(answer: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return answer(String(input), init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("Vorlage example.ts", () => {
  test("steht in keiner Liste", () => {
    expect(SOURCES.map(s => s.id)).not.toContain(exampleSource.id);
    expect(SOURCES).not.toContain(exampleSource);
  });

  test("bereit nur mit EXAMPLE_API_KEY", () => {
    expect(exampleSource.ready({})).toBe(false);
    expect(exampleSource.ready({ EXAMPLE_API_KEY: " " })).toBe(false);
    expect(exampleSource.ready(ENV)).toBe(true);
  });

  test("Erfolg: Tag in USER_TIMEZONE, Signal und Schlüssel kommen an, Einträge statt Markdown", async () => {
    const fake = fakeFetch(() =>
      json([{ title: "Erste", date: "2026-10-19T08:00:00Z", url: "https://example.com/1" }, { title: "" }, { title: "Zweite" }]),
    );
    const outcome = await runSource(exampleSource, { env: ENV, now: NOW, fetch: fake.fn });
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.section.items).toEqual([
      { text: "Erste", due: "2026-10-19", link: "https://example.com/1" },
      { text: "Zweite" },
    ]);
    expect(fake.calls[0].url).toContain("day=2026-10-19");
    expect(fake.calls[0].init.signal).toBeInstanceOf(AbortSignal);
    expect((fake.calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer attrappe");
  });

  test("leere Liste: keine Einträge, Hinweis", async () => {
    const outcome = await runSource(exampleSource, { env: ENV, now: NOW, fetch: fakeFetch(() => json([])).fn });
    expect(outcome).toMatchObject({ status: "ok", section: { items: [], note: "Nothing new today" } });
  });

  test("401: failed ohne Antworttext", async () => {
    const outcome = await runSource(exampleSource, { env: ENV, fetch: fakeFetch(() => json({ secret: "intern" }, 401)).fn });
    expect(outcome.status).toBe("failed");
    if (outcome.status !== "failed") return;
    expect(outcome.error).toContain("401");
    expect(outcome.error).not.toContain("intern");
  });

  test("Zeitlimit: hängender Aufruf wird abgebrochen", async () => {
    const fake = fakeFetch(
      (_url, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const outcome = await runSource({ ...exampleSource, timeoutMs: 20 }, { env: ENV, fetch: fake.fn });
    expect(outcome.status).toBe("timeout");
    expect(fake.calls[0].init.signal?.aborted).toBe(true);
  });

  test("der alte Ordner src/lib/data-sources ist ganz entfernt", () => {
    expect(existsSync(join(import.meta.dir, "../src/lib/data-sources"))).toBe(false);
  });
});
