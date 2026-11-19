/** Issue #674: ausschließlich Abruf-Attrappen, keine Anfrage an OpenRouter. */
import { describe, expect, test } from "bun:test";
import {
  createOpenRouterKey, OPENROUTER_KEY_CACHE_MS, OPENROUTER_KEY_TEXT,
  OPENROUTER_KEY_TIMEOUT_MS, OPENROUTER_KEY_URL, type OpenRouterKeyOptions,
} from "../src/web/openrouter-key";

// Absichtlich keine gültige Schlüsselform, nur ein erkennbarer Testwert.
const MARKER = "TESTWERT-674-VERTRAULICH";
const NOW = Date.parse("2026-11-18T12:00:00Z");
const DATA = { limit: 50, limit_remaining: 12.4, limit_reset: "monthly", usage: 37.6, usage_monthly: 3.2 };
const READING = { configured: true, limit: 50, remaining: 12.4, limitReset: "monthly", usage: 37.6, usageMonthly: 3.2, fetchedAt: new Date(NOW).toISOString() };
type Fetch = NonNullable<OpenRouterKeyOptions["fetch"]>;

function fixture(fetch: Fetch = async () => Response.json({ data: DATA }), options: Partial<OpenRouterKeyOptions> = {}) {
  const logs: string[] = [];
  const calls: Parameters<Fetch>[] = [];
  const port = createOpenRouterKey({
    key: () => `  ${MARKER}  `, now: () => NOW, log: line => logs.push(line),
    fetch: (...args) => { calls.push(args); return fetch(...args); }, ...options,
  });
  return { port, calls, logs };
}

describe("OpenRouter-Schlüssel: Felder und Schutz", () => {
  test("nur erlaubte Felder, Bearer getrimmt, feste URL und keine Umleitung", async () => {
    const { port, calls, logs } = fixture(async () => Response.json({ data: { ...DATA,
      label: MARKER, key: MARKER, usage_daily: 1, usage_weekly: 2, is_free_tier: false, extra: { secret: MARKER },
    }, secret: MARKER }));
    const result = await port.read();
    expect(result).toEqual(READING);
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe(OPENROUTER_KEY_URL);
    expect(calls[0][1].headers).toEqual({ accept: "application/json", Authorization: `Bearer ${MARKER}` });
    expect(calls[0][1].redirect).toBe("error");
    expect(calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(JSON.stringify(result)).not.toContain(MARKER);
    expect(logs).toEqual([]);
  });

  test.each([undefined, "", " \n\t "])("ohne Schlüssel (%j) kein Abruf", async key => {
    const { port, calls } = fixture(undefined, { key: () => key });
    expect(await port.read()).toEqual({ configured: false });
    expect(calls).toHaveLength(0);
  });

  test("Schlüssel wird erst bei jedem Aufruf gelesen, auch vor einem Cachetreffer", async () => {
    let key: string | undefined;
    const { port, calls } = fixture(undefined, { key: () => key });
    expect(await port.read()).toEqual({ configured: false });
    key = MARKER;
    expect(await port.read()).toEqual(READING);
    key = " ";
    expect(await port.read()).toEqual({ configured: false });
    expect(calls).toHaveLength(1);
  });

  test("ohne Limit bleiben null und Monatsverbrauch erhalten", async () => {
    const { port } = fixture(async () => Response.json({ data: { ...DATA, limit: null, limit_remaining: null, limit_reset: null } }));
    expect(await port.read()).toEqual({ ...READING, limit: null, remaining: null, limitReset: null });
  });

  test.each(["daily", "weekly", "monthly", null, "yearly", MARKER])("Erneuerung %j", async reset => {
    const { port } = fixture(async () => Response.json({ data: { ...DATA, limit_reset: reset } }));
    expect(await port.read()).toEqual({ ...READING, limitReset: ["daily", "weekly", "monthly"].includes(reset!) ? reset : null });
  });

  test("negativer Rest wird als Zahl weitergegeben, die Oberfläche begrenzt die Anzeige", async () => {
    const { port } = fixture(async () => Response.json({ data: { ...DATA, limit_remaining: -0.5 } }));
    expect(await port.read()).toEqual({ ...READING, remaining: -0.5 });
  });

  for (const field of ["limit", "limit_remaining", "usage", "usage_monthly"]) {
    test(`${field}: nur endliche Zahlen, keine fehlenden Felder`, async () => {
      for (const value of ["50", undefined, true, {}, [], NaN, Infinity, -Infinity]) {
        // json()-Attrappe erhält auch NaN/Infinity, die JSON.stringify in null umwandeln würde.
        const { port } = fixture(async () => ({ ok: true, status: 200,
          json: async () => ({ data: { ...DATA, [field]: value } }),
        }) as Response);
        expect(await port.read()).toEqual({ configured: true, error: OPENROUTER_KEY_TEXT.unavailable });
      }
    });
  }

  test.each([
    null, [], {}, { data: null }, { data: [] }, { data: "falsch" },
    { data: { ...DATA, limit_remaining: null } }, { data: { ...DATA, usage: null } },
    { data: { ...DATA, usage_monthly: null } }, { data: { ...DATA, limit_reset: 5 } },
    { data: { ...DATA, limit_reset: undefined } },
  ])("kaputte Antwort %j", async body => {
    expect(await fixture(async () => Response.json(body)).port.read()).toEqual({ configured: true, error: OPENROUTER_KEY_TEXT.unavailable });
  });
});

describe("OpenRouter-Schlüssel: Frist, Fehler und Zwischenspeicher", () => {
  test("fünf Sekunden Frist, fünf Minuten Cache ab fertiger Antwort, danach erneut", async () => {
    expect(OPENROUTER_KEY_TIMEOUT_MS).toBe(5000);
    expect(OPENROUTER_KEY_CACHE_MS).toBe(300000);
    let now = NOW;
    const { port, calls } = fixture(async () => { now += 1000; return Response.json({ data: DATA }); }, { now: () => now });
    const first = await port.read();
    expect(first).toEqual({ ...READING, fetchedAt: new Date(NOW + 1000).toISOString() });
    now += OPENROUTER_KEY_CACHE_MS - 1;
    expect(await port.read()).toEqual(first);
    expect(calls).toHaveLength(1);
    now++;
    expect(await port.read()).not.toEqual(first);
    expect(calls).toHaveLength(2);
  });

  test("gleichzeitige Aufrufe teilen eine Abfrage", async () => {
    const gate = Promise.withResolvers<Response>();
    const { port, calls } = fixture(() => gate.promise);
    const first = port.read();
    const second = port.read();
    expect(calls).toHaveLength(1);
    gate.resolve(Response.json({ data: DATA }));
    expect(await first).toEqual(READING);
    expect(await second).toEqual(READING);
  });

  const failures: [string, Fetch, string][] = [
    ...[401, 403, 429, 500, 302].map(status => [`HTTP ${status}`, async () => new Response(MARKER, { status }),
      status === 401 || status === 403 ? OPENROUTER_KEY_TEXT.rejected : OPENROUTER_KEY_TEXT.unavailable] as [string, Fetch, string]),
    ["Netzfehler", async () => { throw new Error(`ENOTFOUND ${MARKER}`); }, OPENROUTER_KEY_TEXT.unavailable],
    ["kaputtes JSON", async () => new Response(`{${MARKER}`), OPENROUTER_KEY_TEXT.unavailable],
    ["falscher Feldtyp", async () => Response.json({ data: { ...DATA, limit: MARKER } }), OPENROUTER_KEY_TEXT.unavailable],
    ["Signal ignoriert", () => new Promise(() => {}), OPENROUTER_KEY_TEXT.timeout],
    ["Signal beachtet", (_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error(MARKER)));
    }), OPENROUTER_KEY_TEXT.timeout],
    ["Body hängt", async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as Response, OPENROUTER_KEY_TEXT.timeout],
  ];
  for (const [label, fetch, error] of failures) test(`${label}: fester Text, keine Geheimnisse, sofort wiederholbar`, async () => {
    let fail = true;
    const { port, calls, logs } = fixture((...args) => fail ? fetch(...args) : Promise.resolve(Response.json({ data: DATA })), { timeoutMs: 15 });
    const result = await port.read();
    expect(result).toEqual({ configured: true, error });
    expect(logs).toEqual([`OpenRouter-Schlüssel: ${error}`]);
    expect(JSON.stringify([result, logs])).not.toContain(MARKER);
    expect(JSON.stringify([result, logs])).not.toContain("ENOTFOUND");
    if (error === OPENROUTER_KEY_TEXT.timeout) expect(calls[0][1].signal.aborted).toBe(true);
    fail = false;
    expect(await port.read()).toEqual(READING);
    expect(calls).toHaveLength(2);
  });

  test("abgelaufener Erfolg verdeckt keinen Fehler; späte Antwort nach Frist füllt den Cache nicht", async () => {
    let now = NOW;
    const late = Promise.withResolvers<Response>();
    let count = 0;
    const { port } = fixture(() => ++count === 2 ? late.promise : Promise.resolve(Response.json({ data: DATA })), { timeoutMs: 15, now: () => now });
    expect(await port.read()).toEqual(READING);
    now += OPENROUTER_KEY_CACHE_MS;
    expect(await port.read()).toEqual({ configured: true, error: OPENROUTER_KEY_TEXT.timeout });
    late.resolve(Response.json({ data: { ...DATA, usage: 999 } }));
    await late.promise;
    expect(await port.read()).toEqual({ ...READING, fetchedAt: new Date(now).toISOString() });
    expect(count).toBe(3);
  });
});
