/**
 * Issue #355: Google-Token-Abruf (src/lib/google/token.ts). Ohne Netz:
 * fetch und Uhr sind Attrappen.
 */
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { clearGoogleTokenCache, GOOGLE_TOKEN_URL, googleAccessToken, googleReady, TOKEN_TIMEOUT_MS } from "../src/lib/google/token";

const ENV = { GOOGLE_CLIENT_ID: "client-a", GOOGLE_CLIENT_SECRET: "secret-a", GOOGLE_REFRESH_TOKEN: "refresh-a" };

interface Call {
  url: string;
  init: RequestInit;
}

/** fetch-Attrappe; answer bekommt die laufende Nummer des Aufrufs */
function fakeFetch(answer: (n: number, init: RequestInit) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return answer(calls.length, init);
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const grant = (n: number, expires_in: unknown = 3600) => json({ access_token: `token-${n}`, expires_in, token_type: "Bearer" });

/** Uhr zum Vorstellen */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

/** Ein Versprechen, das der Test selbst einlöst */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => (resolve = r));
  return { promise, resolve };
}

const settle = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  clearGoogleTokenCache();
  // Systemzeit je Test fest, auch wo der Test keine eigene Uhr übergibt
  setSystemTime(new Date("2026-01-15T08:00:00Z"));
});

afterEach(() => setSystemTime());

describe("googleReady", () => {
  test("nur mit allen drei Werten, leere und Leerzeichen zählen nicht", () => {
    expect(googleReady(ENV)).toBe(true);
    expect(googleReady({ ...ENV, GOOGLE_CLIENT_SECRET: undefined })).toBe(false);
    expect(googleReady({ ...ENV, GOOGLE_REFRESH_TOKEN: "" })).toBe(false);
    expect(googleReady({ ...ENV, GOOGLE_CLIENT_ID: "  " })).toBe(false);
    expect(googleReady({})).toBe(false);
  });

  test("ohne Argument gilt process.env", () => {
    const saved = Object.fromEntries(Object.keys(ENV).map(k => [k, process.env[k]]));
    try {
      Object.assign(process.env, ENV);
      expect(googleReady()).toBe(true);
      delete process.env.GOOGLE_REFRESH_TOKEN;
      expect(googleReady()).toBe(false);
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("Abruf", () => {
  test("POST an den Token-Endpunkt mit refresh_token", async () => {
    const fake = fakeFetch(n => grant(n));
    expect(await googleAccessToken({ env: ENV, fetch: fake.fn })).toBe("token-1");
    expect(fake.calls[0].url).toBe(GOOGLE_TOKEN_URL);
    expect(fake.calls[0].init.method).toBe("POST");
    const body = new URLSearchParams(String(fake.calls[0].init.body));
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "refresh_token",
      client_id: "client-a",
      client_secret: "secret-a",
      refresh_token: "refresh-a",
    });
  });

  test("fehlende Zugangsdaten: Fehler mit den Variablennamen, kein HTTP-Aufruf", async () => {
    const fake = fakeFetch(n => grant(n));
    const error = await googleAccessToken({ env: { GOOGLE_CLIENT_ID: "x" }, fetch: fake.fn }).catch(e => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("GOOGLE_CLIENT_SECRET");
    expect(error.message).toContain("GOOGLE_REFRESH_TOKEN");
    expect(error.message).not.toContain("GOOGLE_CLIENT_ID");
    expect(fake.calls).toHaveLength(0);
  });
});

describe("Zwischenspeicher", () => {
  test("zweiter Abruf innerhalb der Gültigkeit ohne HTTP-Aufruf", async () => {
    const time = clock();
    const fake = fakeFetch(n => grant(n));
    expect(await googleAccessToken({ env: ENV, fetch: fake.fn, now: time.now })).toBe("token-1");
    time.advance(3600_000 - 61_000);
    expect(await googleAccessToken({ env: ENV, fetch: fake.fn, now: time.now })).toBe("token-1");
    expect(fake.calls).toHaveLength(1);
  });

  test("59 Sekunden vor Ablauf: neuer Abruf", async () => {
    const time = clock();
    const fake = fakeFetch(n => grant(n));
    await googleAccessToken({ env: ENV, fetch: fake.fn, now: time.now });
    time.advance(3600_000 - 59_000);
    expect(await googleAccessToken({ env: ENV, fetch: fake.fn, now: time.now })).toBe("token-2");
    expect(fake.calls).toHaveLength(2);
  });

  for (const [label, value] of [
    ["fehlt", undefined],
    ["0", 0],
    ["negativ", -5],
    ["Text", "3600"],
  ] as const) {
    test(`expires_in ${label}: nicht gemerkt`, async () => {
      const fake = fakeFetch(n => json(value === undefined ? { access_token: `token-${n}` } : { access_token: `token-${n}`, expires_in: value }));
      expect(await googleAccessToken({ env: ENV, fetch: fake.fn })).toBe("token-1");
      expect(await googleAccessToken({ env: ENV, fetch: fake.fn })).toBe("token-2");
    });
  }

  for (const [label, change] of [
    ["anderer Refresh-Token", { GOOGLE_REFRESH_TOKEN: "refresh-b" }],
    ["andere Client-ID", { GOOGLE_CLIENT_ID: "client-b" }],
    ["anderes Secret", { GOOGLE_CLIENT_SECRET: "secret-b" }],
  ] as const) {
    test(`${label}: neuer Abruf trotz gültigem Eintrag`, async () => {
      const time = clock();
      const fake = fakeFetch(n => grant(n));
      expect(await googleAccessToken({ env: ENV, fetch: fake.fn, now: time.now })).toBe("token-1");
      time.advance(60_000);
      expect(await googleAccessToken({ env: { ...ENV, ...change }, fetch: fake.fn, now: time.now })).toBe("token-2");
      // der alte Eintrag bleibt für die alten Zugangsdaten gültig
      expect(await googleAccessToken({ env: ENV, fetch: fake.fn, now: time.now })).toBe("token-1");
      expect(fake.calls).toHaveLength(2);
    });
  }
});

describe("gemeinsamer Abruf", () => {
  test("drei gleichzeitige Anfragen: ein HTTP-Aufruf, dasselbe Token", async () => {
    const time = clock();
    const answer = deferred<Response>();
    const fake = fakeFetch(() => answer.promise);
    const all = Promise.all([1, 2, 3].map(() => googleAccessToken({ env: ENV, fetch: fake.fn, now: time.now })));
    await settle();
    answer.resolve(grant(1));
    expect(await all).toEqual(["token-1", "token-1", "token-1"]);
    // das gemeinsame Ergebnis liegt danach im Speicher
    time.advance(60_000);
    expect(await googleAccessToken({ env: ENV, fetch: fake.fn, now: time.now })).toBe("token-1");
    expect(fake.calls).toHaveLength(1);
  });

  test("Signal einer Anfrage löst aus: nur diese wirft, mit ihrem Grund; die anderen bekommen das Token", async () => {
    const time = clock();
    const answer = deferred<Response>();
    const fake = fakeFetch(() => answer.promise);
    const own = new AbortController();
    const first = googleAccessToken({ env: ENV, fetch: fake.fn, now: time.now, signal: own.signal });
    const second = googleAccessToken({ env: ENV, fetch: fake.fn, now: time.now, signal: new AbortController().signal });
    const third = googleAccessToken({ env: ENV, fetch: fake.fn, now: time.now });
    await settle();
    const reason = new Error("Quelle abgebrochen");
    own.abort(reason);
    await expect(first).rejects.toBe(reason);
    // der gemeinsame Abruf hängt nicht am Signal der Quelle
    expect(fake.calls[0].init.signal?.aborted).toBe(false);
    answer.resolve(grant(1));
    expect(await second).toBe("token-1");
    expect(await third).toBe("token-1");
    expect(fake.calls).toHaveLength(1);
  });

  test("bereits ausgelöstes Signal: wirft sofort, auch bei Treffer im Speicher", async () => {
    const fake = fakeFetch(n => grant(n));
    const done = new AbortController();
    done.abort(new Error("schon weg"));
    await expect(googleAccessToken({ env: ENV, fetch: fake.fn, signal: done.signal })).rejects.toThrow("schon weg");
    expect(fake.calls).toHaveLength(0);
    await googleAccessToken({ env: ENV, fetch: fake.fn });
    await expect(googleAccessToken({ env: ENV, fetch: fake.fn, signal: done.signal })).rejects.toThrow("schon weg");
    expect(fake.calls).toHaveLength(1);
  });

  test("hängender Endpunkt: Zeitlimit beendet den Abruf mit Fehler, Signal kommt bei fetch an", async () => {
    expect(TOKEN_TIMEOUT_MS).toBe(15_000);
    const fake = fakeFetch(
      (_n, init) =>
        new Promise<Response>((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const error = await googleAccessToken({ env: ENV, fetch: fake.fn, timeoutMs: 20 }).catch(e => e as Error);
    expect(error.message).toContain("Zeitlimit 20 ms");
    expect(fake.calls[0].init.signal?.aborted).toBe(true);
  });

  test("hängender Antwortkörper zählt zum Zeitlimit; späte Antwort trägt nichts ein", async () => {
    const body = deferred<void>();
    const slowBody = () =>
      new Response(
        new ReadableStream({
          async start(stream) {
            await body.promise;
            stream.enqueue(new TextEncoder().encode(JSON.stringify({ access_token: "spaet", expires_in: 3600 })));
            stream.close();
          },
        }),
      );
    let n = 0;
    const fake = fakeFetch(() => (++n === 1 ? slowBody() : grant(n)));
    await expect(googleAccessToken({ env: ENV, fetch: fake.fn, timeoutMs: 20 })).rejects.toThrow("Zeitlimit");
    body.resolve();
    await settle();
    expect(await googleAccessToken({ env: ENV, fetch: fake.fn })).toBe("token-2");
  });

  test("Leeren während eines Abrufs: das späte Ergebnis landet nicht im Speicher", async () => {
    const answer = deferred<Response>();
    let n = 0;
    const fake = fakeFetch(() => (++n === 1 ? answer.promise : grant(n)));
    const early = googleAccessToken({ env: ENV, fetch: fake.fn });
    await settle();
    clearGoogleTokenCache();
    answer.resolve(grant(1));
    expect(await early).toBe("token-1");
    expect(await googleAccessToken({ env: ENV, fetch: fake.fn })).toBe("token-2");
  });
});

describe("Fehlertexte", () => {
  test("HTTP 400 invalid_grant: Status und Code, keine Beschreibung, kein sonstiger Antworttext", async () => {
    const fake = fakeFetch(() => json({ error: "invalid_grant", error_description: "Token has been expired or revoked.", hint: "intern-123" }, 400));
    const error = await googleAccessToken({ env: ENV, fetch: fake.fn }).catch(e => e as Error);
    expect(error.message).toContain("400");
    expect(error.message).toContain("invalid_grant");
    expect(error.message).toContain("GOOGLE_REFRESH_TOKEN");
    expect(error.message).not.toContain("expired or revoked");
    expect(error.message).not.toContain("intern-123");
  });

  test("Fehlercode mit fremden Zeichen oder Text statt JSON: nur der Status", async () => {
    for (const response of [json({ error: "<b>boese</b>" }, 401), new Response("Interner Fehler xyz", { status: 500 })]) {
      clearGoogleTokenCache();
      const error = await googleAccessToken({ env: ENV, fetch: fakeFetch(() => response).fn }).catch(e => e as Error);
      expect(error.message).toContain(`HTTP ${response.status})`);
      expect(error.message).not.toContain("boese");
      expect(error.message).not.toContain("xyz");
    }
  });

  test("Antwort ohne access_token: Fehler", async () => {
    const error = await googleAccessToken({ env: ENV, fetch: fakeFetch(() => json({ expires_in: 3600 })).fn }).catch(e => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("access_token");
  });

  test("nach einem Fehler versucht die nächste Anfrage neu", async () => {
    const fake = fakeFetch(n => (n === 1 ? json({ error: "temporarily_unavailable" }, 503) : grant(n)));
    await expect(googleAccessToken({ env: ENV, fetch: fake.fn })).rejects.toThrow("503");
    expect(await googleAccessToken({ env: ENV, fetch: fake.fn })).toBe("token-2");
    expect(fake.calls).toHaveLength(2);
  });
});
