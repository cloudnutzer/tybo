/**
 * Schritt „google“ (Issue #356): Anmeldung mit PKCE über einen Rückruf-Server
 * auf 127.0.0.1, Token-Tausch, Speichern nach den Regeln aus M6. Server,
 * Browser und Google sind Attrappen; ein Test startet den echten Server auf
 * einem freien Port, nichts geht ins Netz.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import type { HttpFetch, HttpRequest } from "../src/setup/context";
import {
  CALLBACK_PATH,
  createAuthRequest,
  exchangeCode,
  GOOGLE_AUTH_URL,
  GOOGLE_SCOPES,
  serveLoopback,
  waitForSignIn,
  type GoogleOAuthDeps,
  type ServeLoopback,
} from "../src/setup/google-oauth";
import type { RunEvent } from "../src/setup/model";
import { googleStep } from "../src/setup/steps/google";
import { clearGoogleTokenCache, GOOGLE_TOKEN_URL } from "../src/lib/google/token";
import { backupsOf, cleanup, makeCtx } from "./setup-fixture";
import { runWith, scripted } from "./setup-terminal-fixture";

afterAll(cleanup);
beforeEach(clearGoogleTokenCache);

/** Erfundene Testwerte, keine echten Zugangsdaten */
const G = {
  clientId: "1234567890-testclient.apps.googleusercontent.com",
  secret: "GOCSPX-test-secret-geheim-4711",
  code: "4/0test-auth-code-geheim-0815",
  refresh: "1//test-refresh-token-geheim-2222",
  access: "ya29.test-access-token-geheim-3333",
  oldRefresh: "1//alter-refresh-token-geheim-1111",
};
const LEAKS = [G.secret, G.code, G.refresh, G.access, G.oldRefresh];
const leaked = (value: unknown) => LEAKS.filter(s => JSON.stringify(value).includes(s));

// ---------------------------------------------------------------------------
// Attrappen
// ---------------------------------------------------------------------------

interface FakeServer {
  serve: ServeLoopback;
  handler?: (req: Request) => Response;
  port?: number;
  opened: number;
  closed: number;
  /** Ruft den Server wie ein Browser auf */
  get(path: string): Response;
}

function fakeServer(options: { busy?: boolean } = {}): FakeServer {
  const s: FakeServer = {
    opened: 0,
    closed: 0,
    serve(port, handler) {
      if (options.busy) throw Object.assign(new Error("Failed to start server. Is port in use?"), { code: "EADDRINUSE" });
      s.port = port;
      s.handler = handler;
      s.opened++;
      return { close: () => void s.closed++ };
    },
    get(path) {
      return s.handler!(new Request(`http://127.0.0.1:${s.port}${path}`));
    },
  };
  return s;
}

/** Google-Seite im Browser: liest state aus der Weiterleitung und ruft den Rückruf */
function googleAnswer(server: FakeServer, answer: "code" | "denied" | "nichts", log: string[] = []) {
  return async (url: string) => {
    log.push(url);
    if (answer === "nichts") return true;
    const redirect = server.get(new URL(url).pathname);
    const auth = new URL(redirect.headers.get("Location")!);
    const state = auth.searchParams.get("state")!;
    const query = answer === "code" ? `code=${encodeURIComponent(G.code)}&state=${state}` : `error=access_denied&state=${state}`;
    queueMicrotask(() => log.push(`antwort ${server.get(`${CALLBACK_PATH}?${query}`).status}`));
    return true;
  };
}

interface Seen {
  url: string;
  request: HttpRequest;
}

/** Google-Endpunkte: Token-Tausch, Erneuerung, Kalender, Gmail */
function fakeGoogle(options: { token?: () => Response; refresh?: () => Response; calendar?: number; gmail?: number } = {}) {
  const seen: Seen[] = [];
  const fetch: HttpFetch = async (url, request = {}) => {
    seen.push({ url, request });
    if (url === GOOGLE_TOKEN_URL) {
      const grant = new URLSearchParams(String(request.body)).get("grant_type");
      if (grant === "refresh_token") return options.refresh?.() ?? Response.json({ access_token: G.access, expires_in: 3600 });
      return options.token?.() ?? Response.json({ access_token: G.access, refresh_token: G.refresh, expires_in: 3600, scope: GOOGLE_SCOPES.join(" ") });
    }
    if (url.startsWith("https://www.googleapis.com/calendar/")) return new Response("{}", { status: options.calendar ?? 200 });
    if (url.startsWith("https://gmail.googleapis.com/")) return new Response("{}", { status: options.gmail ?? 200 });
    throw new Error(`Unerwartete Adresse ${url}`);
  };
  return { fetch, seen };
}

function deps(server: FakeServer, openBrowser: GoogleOAuthDeps["openBrowser"], extra: Partial<GoogleOAuthDeps> = {}): Partial<GoogleOAuthDeps> {
  return { serve: server.serve, openBrowser, port: 8976, timeoutMs: 5_000, ...extra };
}

const OLD_ENV = `# Kommentar bleibt\nGOOGLE_CLIENT_ID=${G.clientId}\nGOOGLE_CLIENT_SECRET=${G.secret}\nGOOGLE_REFRESH_TOKEN=${G.oldRefresh}\n`;

async function googleCtx(options: { env?: string; answer?: "code" | "denied" | "nichts"; google?: Parameters<typeof fakeGoogle>[0]; server?: FakeServer; extra?: Partial<GoogleOAuthDeps> } = {}) {
  const server = options.server ?? fakeServer();
  const browser: string[] = [];
  const google = fakeGoogle(options.google);
  const ctx = await makeCtx({
    env: options.env,
    overrides: { fetch: google.fetch, googleOAuth: deps(server, googleAnswer(server, options.answer ?? "code", browser), options.extra) },
  });
  return { ctx, server, browser, google };
}

async function runStep(ctx: Awaited<ReturnType<typeof makeCtx>>, values: Record<string, string>, signal = new AbortController().signal) {
  const events: RunEvent[] = [];
  const result = await googleStep.run!(values, ctx, e => events.push(e), signal);
  return { result, events };
}

/** Nimmt host:port eine TCP-Verbindung an? (fetch auf eine fremde Adresse stört in Bun spätere Aufrufe) */
function reachable(host: string, port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect({ host, port, timeout: 1_000 });
    const end = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.once("connect", () => end(true));
    socket.once("error", () => end(false));
    socket.once("timeout", () => end(false));
  });
}

const INPUT = { GOOGLE_CLIENT_ID: G.clientId, GOOGLE_CLIENT_SECRET: G.secret };

// ---------------------------------------------------------------------------
// Anfrage an Google
// ---------------------------------------------------------------------------

describe("Anmeldeadresse", () => {
  test("PKCE mit S256, state, beide Lese-Scopes, offline und Rücksprung auf 127.0.0.1", () => {
    const req = createAuthRequest(G.clientId, 8976);
    const url = new URL(req.url);
    expect(`${url.origin}${url.pathname}`).toBe(GOOGLE_AUTH_URL);
    const p = url.searchParams;
    expect(p.get("client_id")).toBe(G.clientId);
    expect(p.get("response_type")).toBe("code");
    expect(p.get("redirect_uri")).toBe("http://127.0.0.1:8976/callback");
    expect(p.get("scope")!.split(" ").sort()).toEqual([
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
    ]);
    expect(p.get("access_type")).toBe("offline");
    expect(p.get("prompt")).toBe("consent");
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(p.get("code_challenge")).toBe(createHash("sha256").update(req.verifier).digest("base64url"));
    // RFC 7636: 43 bis 128 Zeichen aus dem unreservierten Zeichenvorrat
    expect(req.verifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
    expect(p.get("state")).toBe(req.state);
    expect(req.state.length).toBeGreaterThanOrEqual(32);
  });

  test("state und Verifier sind bei jeder Anfrage neu", () => {
    const a = createAuthRequest(G.clientId, 8976);
    const b = createAuthRequest(G.clientId, 8976);
    expect(a.state).not.toBe(b.state);
    expect(a.verifier).not.toBe(b.verifier);
  });
});

// ---------------------------------------------------------------------------
// Rückruf-Server
// ---------------------------------------------------------------------------

describe("Warten auf die Anmeldung", () => {
  const signal = () => new AbortController().signal;

  test("Server läuft vor dem Browser; / leitet zu Google, falscher state wird abgewiesen, der richtige endet", async () => {
    const server = fakeServer();
    const order: string[] = [];
    const serve: ServeLoopback = (port, handler) => {
      order.push("server");
      return server.serve(port, handler);
    };
    let wrong: Response | undefined;
    let good: Response | undefined;
    const outcome = await waitForSignIn({
      clientId: G.clientId,
      deps: { serve, openBrowser: async () => true, port: 8976, timeoutMs: 5_000 },
      signal: signal(),
      onReady: start => {
        order.push("browser");
        expect(start).toBe("http://127.0.0.1:8976/");
        const redirect = server.get("/");
        expect(redirect.status).toBe(302);
        const auth = new URL(redirect.headers.get("Location")!);
        expect(auth.origin).toBe("https://accounts.google.com");
        const state = auth.searchParams.get("state")!;
        expect(server.get("/favicon.ico").status).toBe(404);
        wrong = server.get(`${CALLBACK_PATH}?code=fremd&state=falsch`);
        expect(server.get(`${CALLBACK_PATH}?code=fremd`).status).toBe(400);
        good = server.get(`${CALLBACK_PATH}?code=${encodeURIComponent(G.code)}&state=${state}`);
      },
    });
    expect(order).toEqual(["server", "browser"]);
    expect(wrong!.status).toBe(400);
    expect(good!.status).toBe(200);
    expect(outcome).toEqual({ ok: true, code: G.code, verifier: expect.any(String), redirectUri: "http://127.0.0.1:8976/callback" });
    // Die Seite im Browser nennt weder Code noch state
    const html = await good!.text();
    expect(html).not.toContain(G.code);
    expect(html).toContain("Verbunden");
    expect(server.closed).toBe(1);
  });

  test("Ablehnung bei Google endet mit Meldung, Server geschlossen", async () => {
    const server = fakeServer();
    const outcome = await waitForSignIn({
      clientId: G.clientId,
      deps: { serve: server.serve, openBrowser: async () => true, port: 8976, timeoutMs: 5_000 },
      signal: signal(),
      onReady: () => {
        const state = new URL(server.get("/").headers.get("Location")!).searchParams.get("state");
        server.get(`${CALLBACK_PATH}?error=access_denied&state=${state}`);
      },
    });
    expect(outcome).toMatchObject({ ok: false, reason: "abgelehnt", message: "Die Anmeldung bei Google wurde abgelehnt." });
    expect(server.closed).toBe(1);
  });

  test("Fehlercode von Google erscheint nur, wenn er wie einer aussieht", async () => {
    const server = fakeServer();
    const outcome = await waitForSignIn({
      clientId: G.clientId,
      deps: { serve: server.serve, openBrowser: async () => true, port: 8976, timeoutMs: 5_000 },
      signal: signal(),
      onReady: () => {
        const state = new URL(server.get("/").headers.get("Location")!).searchParams.get("state");
        server.get(`${CALLBACK_PATH}?error=${encodeURIComponent("<script>x</script>")}&state=${state}`);
      },
    });
    expect(outcome).toMatchObject({ ok: false, reason: "abgelehnt" });
    expect(JSON.stringify(outcome)).not.toContain("script");
  });

  test("Zeitlimit endet mit Meldung, Server geschlossen", async () => {
    const server = fakeServer();
    const outcome = await waitForSignIn({
      clientId: G.clientId,
      deps: { serve: server.serve, openBrowser: async () => true, port: 8976, timeoutMs: 20 },
      signal: signal(),
      onReady: () => {},
    });
    expect(outcome).toMatchObject({ ok: false, reason: "zeitlimit" });
    expect(server.closed).toBe(1);
    // Ein später Rückruf beendet nichts mehr
    expect(server.get("/").status).toBe(410);
  });

  test("Abbruch endet sofort, Server geschlossen", async () => {
    const server = fakeServer();
    const controller = new AbortController();
    const outcome = await waitForSignIn({
      clientId: G.clientId,
      deps: { serve: server.serve, openBrowser: async () => true, port: 8976, timeoutMs: 5_000 },
      signal: controller.signal,
      onReady: () => setTimeout(() => controller.abort(), 5),
    });
    expect(outcome).toMatchObject({ ok: false, reason: "abgebrochen" });
    expect(server.closed).toBe(1);
  });

  test("Belegter Port: klare Meldung, kein Browser", async () => {
    const server = fakeServer({ busy: true });
    let ready = false;
    const outcome = await waitForSignIn({
      clientId: G.clientId,
      deps: { serve: server.serve, openBrowser: async () => true, port: 8976, timeoutMs: 5_000 },
      signal: signal(),
      onReady: () => (ready = true),
    });
    expect(outcome).toMatchObject({ ok: false, reason: "port" });
    expect((outcome as { message: string }).message).toContain("Port 8976");
    expect(ready).toBe(false);
  });

  test("echter Server: nur 127.0.0.1, belegter Port wirft, nach dem Ende geschlossen", async () => {
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
    const port = probe.port!;
    // Port belegt: serveLoopback wirft
    expect(() => serveLoopback(port, () => new Response(""))).toThrow();
    probe.stop(true);

    const outcome = waitForSignIn({
      clientId: G.clientId,
      deps: { serve: serveLoopback, openBrowser: async () => true, port, timeoutMs: 5_000 },
      signal: new AbortController().signal,
      onReady: () => {},
    });
    await Bun.sleep(10);
    const redirect = await fetch(`http://127.0.0.1:${port}/`, { redirect: "manual" });
    expect(redirect.status).toBe(302);
    // Nicht über eine andere Adresse dieses Rechners erreichbar
    const lan = Object.values(networkInterfaces())
      .flat()
      .find(i => i && i.family === "IPv4" && !i.internal)?.address;
    if (lan) expect(await reachable(lan, port)).toBe(false);
    const state = new URL(redirect.headers.get("Location")!).searchParams.get("state");
    const done = await fetch(`http://127.0.0.1:${port}${CALLBACK_PATH}?code=abc&state=${state}`);
    expect(done.status).toBe(200);
    expect(done.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect((await outcome).ok).toBe(true);
    await Bun.sleep(10);
    expect(await reachable("127.0.0.1", port)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Token-Tausch
// ---------------------------------------------------------------------------

describe("Token-Tausch", () => {
  const input = { clientId: G.clientId, clientSecret: G.secret, code: G.code, verifier: "v".repeat(64), redirectUri: "http://127.0.0.1:8976/callback" };

  test("schickt Code, Verifier und Rücksprung, liefert beide Token", async () => {
    const google = fakeGoogle();
    const out = await exchangeCode(google.fetch, input, new AbortController().signal);
    expect(out).toEqual({ ok: true, refreshToken: G.refresh, accessToken: G.access });
    const body = new URLSearchParams(String(google.seen[0].request.body));
    expect(google.seen[0].request.method).toBe("POST");
    expect(Object.fromEntries(body)).toEqual({
      grant_type: "authorization_code",
      client_id: G.clientId,
      client_secret: G.secret,
      code: G.code,
      code_verifier: input.verifier,
      redirect_uri: input.redirectUri,
    });
  });

  test("ohne Refresh-Token: Erklärung, kein Token", async () => {
    const google = fakeGoogle({ token: () => Response.json({ access_token: G.access, expires_in: 3600 }) });
    const out = await exchangeCode(google.fetch, input, new AbortController().signal);
    expect(out.ok).toBe(false);
    expect((out as { message: string }).message).toContain("keinen Refresh-Token");
    expect(leaked(out)).toEqual([]);
  });

  test("Ablehnung nennt Status und Fehlercode, nie den Antworttext", async () => {
    const google = fakeGoogle({ token: () => Response.json({ error: "invalid_grant", error_description: `Code ${G.code} abgelaufen` }, { status: 400 }) });
    const out = await exchangeCode(google.fetch, input, new AbortController().signal);
    expect(out).toEqual({ ok: false, message: "Google lehnt den Token-Tausch ab (HTTP 400, invalid_grant)." });
  });
});

// ---------------------------------------------------------------------------
// Schritt
// ---------------------------------------------------------------------------

describe("Schritt google", () => {
  test("Status: fehlt, teilweise, erledigt, nie Werte", async () => {
    const empty = await makeCtx({ env: "" });
    expect((await googleStep.status(empty)).state).toBe("fehlt");
    const half = await makeCtx({ env: `GOOGLE_CLIENT_ID=${G.clientId}\nGOOGLE_CLIENT_SECRET=${G.secret}\n` });
    const halfStatus = await googleStep.status(half);
    expect(halfStatus.state).toBe("teilweise");
    expect(halfStatus.detail).toContain("GOOGLE_REFRESH_TOKEN");
    const full = await makeCtx({ env: OLD_ENV });
    const fullStatus = await googleStep.status(full);
    expect(fullStatus.state).toBe("erledigt");
    expect(fullStatus.fields).toEqual([
      { name: "GOOGLE_CLIENT_ID", set: true },
      { name: "GOOGLE_CLIENT_SECRET", set: true },
    ]);
    expect(JSON.stringify(fullStatus)).not.toContain(G.clientId);
    expect(leaked(fullStatus)).toEqual([]);
  });

  test("Ablauf: alle drei Werte zusammen gespeichert (eine Sicherung, 0600, Kommentar bleibt), ohne Geheimnisse in Meldungen", async () => {
    const { ctx, browser, server } = await googleCtx({ env: "# Kommentar bleibt\nUSER_NAME=Alex\n" });
    const { result, events } = await runStep(ctx, INPUT);
    expect(result.ok).toBe(true);
    expect(result.message).toContain("Kalender und Gmail sind lesbar");
    expect(result.changed.sort()).toEqual(["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"]);
    const env = await readFile(ctx.envPath, "utf8");
    expect(env).toContain("# Kommentar bleibt");
    expect(env).toContain("USER_NAME=Alex");
    expect(env).toContain(`GOOGLE_CLIENT_ID=${G.clientId}`);
    expect(env).toContain(`GOOGLE_CLIENT_SECRET=${G.secret}`);
    expect(env).toContain(`GOOGLE_REFRESH_TOKEN=${G.refresh}`);
    expect((await stat(ctx.envPath)).mode & 0o777).toBe(0o600);
    expect(await backupsOf(ctx)).toHaveLength(1);
    // Browser bekam nur die Startadresse ohne Werte
    expect(browser[0]).toBe("http://127.0.0.1:8976/");
    expect(server.closed).toBe(1);
    expect(events.map(e => e.at)).toEqual([1, 2, 3, 4, 5]);
    expect(events[1].detail).toContain("ssh -L 8976:127.0.0.1:8976");
    expect(JSON.stringify(events)).not.toContain(G.clientId);
    expect(leaked({ result, events })).toEqual([]);
    expect((await googleStep.status(ctx)).state).toBe("erledigt");
  });

  test("leere Eingaben behalten gespeicherte Client-ID und Secret, der Refresh-Token wird ersetzt", async () => {
    const { ctx } = await googleCtx({ env: OLD_ENV });
    const { result } = await runStep(ctx, {});
    expect(result.ok).toBe(true);
    const env = await readFile(ctx.envPath, "utf8");
    expect(env).toContain(`GOOGLE_CLIENT_SECRET=${G.secret}`);
    expect(env).toContain(`GOOGLE_REFRESH_TOKEN=${G.refresh}`);
    expect(env).not.toContain(G.oldRefresh);
    expect(result.changed).toEqual(["GOOGLE_REFRESH_TOKEN"]);
  });

  test.each([
    ["Ablehnung", { answer: "denied" as const }, "abgelehnt"],
    ["ohne Refresh-Token", { google: { token: () => Response.json({ access_token: G.access }) } }, "keinen Refresh-Token"],
    ["Token-Tausch abgelehnt", { google: { token: () => Response.json({ error: "invalid_client" }, { status: 401 }) } }, "invalid_client"],
    ["belegter Port", { server: fakeServer({ busy: true }) }, "Port 8976"],
    ["Zeitlimit", { answer: "nichts" as const, extra: { timeoutMs: 20 } }, "Keine Anmeldung"],
  ])("%s: vorhandene Zugangsdaten bleiben unverändert", async (_name, options, expected) => {
    const { ctx } = await googleCtx({ env: OLD_ENV, ...options });
    const { result } = await runStep(ctx, INPUT);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(expected);
    expect(result.message).toContain("Die .env ist unverändert.");
    expect(result.changed).toEqual([]);
    expect(await readFile(ctx.envPath, "utf8")).toBe(OLD_ENV);
    expect(await backupsOf(ctx)).toEqual([]);
    expect(leaked(result)).toEqual([]);
  });

  test("Abbruch während des Wartens: nichts geschrieben", async () => {
    const controller = new AbortController();
    const { ctx } = await googleCtx({ env: OLD_ENV, answer: "nichts" });
    const running = runStep(ctx, INPUT, controller.signal);
    setTimeout(() => controller.abort(), 5);
    const { result } = await running;
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Abgebrochen");
    expect(await readFile(ctx.envPath, "utf8")).toBe(OLD_ENV);
  });

  test("ungültige Client-ID: kein Server, kein Browser", async () => {
    const { ctx, server, browser } = await googleCtx({ env: "" });
    const { result } = await runStep(ctx, { GOOGLE_CLIENT_ID: "keine-id", GOOGLE_CLIENT_SECRET: G.secret });
    expect(result.ok).toBe(false);
    expect(result.message).toContain(".apps.googleusercontent.com");
    expect(server.opened).toBe(0);
    expect(browser).toEqual([]);
  });

  test("gespeichert, aber Gmail-API nicht aktiviert: ok false mit Hinweis", async () => {
    const { ctx } = await googleCtx({ env: "", google: { gmail: 403 } });
    const { result } = await runStep(ctx, INPUT);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Google-Zugang gespeichert");
    expect(result.message).toContain("Gmail API aktivieren");
    expect(result.changed).toHaveLength(3);
  });

  test("Verbindungstest erneuert nur das Token, öffnet nie eine Anmeldung", async () => {
    const { ctx, server, browser, google } = await googleCtx({ env: OLD_ENV });
    const result = await googleStep.test!({}, ctx);
    expect(result.ok).toBe(true);
    expect(result.items!.map(i => i.label)).toEqual(["Kalender", "Gmail"]);
    expect(server.opened).toBe(0);
    expect(browser).toEqual([]);
    expect(new URLSearchParams(String(google.seen[0].request.body)).get("grant_type")).toBe("refresh_token");
    expect(leaked(result)).toEqual([]);
  });

  test("Verbindungstest ohne Refresh-Token: Hinweis auf tybo setup google, keine Anmeldung", async () => {
    const { ctx, server, google } = await googleCtx({ env: `GOOGLE_CLIENT_ID=${G.clientId}\nGOOGLE_CLIENT_SECRET=${G.secret}\n` });
    const result = await googleStep.test!({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("tybo setup google");
    expect(server.opened).toBe(0);
    expect(google.seen).toEqual([]);
  });

  test("Verbindungstest mit abgelehnter Erneuerung: Meldung ohne Werte", async () => {
    const { ctx } = await googleCtx({ env: OLD_ENV, google: { refresh: () => Response.json({ error: "invalid_grant", error_description: G.oldRefresh }, { status: 400 }) } });
    const result = await googleStep.test!({}, ctx);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("invalid_grant");
    expect(leaked(result)).toEqual([]);
  });

  test("Terminal: tybo setup google zeigt Ablauf und Ergebnis, nie Secret, Code oder Token", async () => {
    const { ctx } = await googleCtx({ env: "" });
    // Client-ID, Client-Secret, „Jetzt ausführen?“
    const prompter = scripted([G.clientId, G.secret, ""]);
    const r = await runWith({ mode: "step", step: "google" }, ctx, prompter);
    expect(r.code).toBe(0);
    expect(prompter.asked.map(a => a.secret)).toEqual([false, true, false]);
    expect(r.out).toContain("Das passiert jetzt:");
    expect(r.out).toContain("http://127.0.0.1:8976/");
    expect(r.out).toContain("Google-Zugang gespeichert");
    expect(leaked(r.out)).toEqual([]);
    expect(await readFile(ctx.envPath, "utf8")).toContain(`GOOGLE_REFRESH_TOKEN=${G.refresh}`);
  });
});
