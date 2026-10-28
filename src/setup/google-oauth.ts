/**
 * Anmeldung bei Google für Kalender und Gmail (Issue #356), der Ablauf hinter
 * dem Schritt „google“ (src/setup/steps/google.ts).
 *
 * - Autorisierungscode mit PKCE (S256) und einmaligem state, nur Lesezugriff
 *   auf Kalender und Gmail. Desktop-Clients von Google erlauben jede
 *   Rücksprungadresse auf 127.0.0.1.
 * - Der Rückruf-Server bindet nur an 127.0.0.1 und läuft, bevor der Browser
 *   aufgeht. Er endet auf jedem Weg: Code erhalten, Ablehnung, Zeitlimit,
 *   Abbruch.
 * - Die Startadresse ist http://127.0.0.1:<port>/ und leitet zu Google weiter.
 *   So steht in Terminal und Browser keine Client-ID, und per SSH reicht eine
 *   Portweiterleitung.
 * - Nichts davon gibt Code, state, Geheimnis oder Antworttext von Google
 *   zurück an eine Oberfläche: Fehler nennen nur HTTP-Status und den
 *   OAuth-Fehlercode.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { BRAND } from "../brand";
import { GOOGLE_TOKEN_URL, oauthCode, TOKEN_FORM_HEADERS } from "../lib/google/token";
import type { HttpFetch } from "./context";
import type { StatusItem } from "./model";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
/** Nur Lesen: das Briefing zeigt Termine und ungelesene Mails */
export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
] as const;
export const CALLBACK_PORT = 8976;
export const CALLBACK_PATH = "/callback";
/** So lange wartet der Ablauf auf die Anmeldung im Browser */
export const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const EXCHANGE_TIMEOUT_MS = 15_000;
const API_TIMEOUT_MS = 15_000;

const CALENDAR_PROBE = "https://www.googleapis.com/calendar/v3/calendars/primary/events?maxResults=1";
const GMAIL_PROBE = "https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=1";

/** Laufender Rückruf-Server */
export interface LoopbackServer {
  close(): void;
}

/** Startet einen Server auf 127.0.0.1:port; wirft, wenn der Port belegt ist */
export type ServeLoopback = (port: number, handler: (req: Request) => Response) => LoopbackServer;

export interface GoogleOAuthDeps {
  serve: ServeLoopback;
  /** Öffnet die Adresse im Browser dieses Rechners; false, wenn das nicht ging */
  openBrowser(url: string): Promise<boolean>;
  port: number;
  timeoutMs: number;
}

export const serveLoopback: ServeLoopback = (port, handler) => {
  const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handler });
  return {
    // Erst sanft, damit die letzte Seite noch beim Browser ankommt; offene Verbindungen nach einer Sekunde hart
    close: () => {
      void server.stop();
      setTimeout(() => void server.stop(true), 1_000).unref();
    },
  };
};

export function startUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

export function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}${CALLBACK_PATH}`;
}

/** Befehl für die Portweiterleitung, wenn die Einrichtung per SSH läuft */
export function sshHint(port: number): string {
  return `ssh -L ${port}:127.0.0.1:${port} <dieser Rechner>`;
}

export interface AuthRequest {
  url: string;
  state: string;
  verifier: string;
}

/** Neue Anfrage mit frischem state und PKCE-Paar */
export function createAuthRequest(clientId: string, port: number): AuthRequest {
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const url = new URL(GOOGLE_AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(port),
    response_type: "code",
    scope: GOOGLE_SCOPES.join(" "),
    // offline + consent: Google schickt einen Refresh-Token, auch bei erneuter Anmeldung
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  return { url: url.toString(), state, verifier };
}

function sameState(received: string | null, expected: string): boolean {
  if (!received) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function page(status: number, title: string, text: string): Response {
  const html = `<!doctype html><html lang="de"><head><meta charset="utf-8"><title>${BRAND.name}: ${title}</title></head><body><h1>${title}</h1><p>${text}</p></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}

export type SignInOutcome =
  | { ok: true; code: string; verifier: string; redirectUri: string }
  | { ok: false; reason: "port" | "abgelehnt" | "zeitlimit" | "abgebrochen"; message: string };

export interface SignInOptions {
  clientId: string;
  deps: GoogleOAuthDeps;
  signal: AbortSignal;
  /** Der Server läuft: jetzt die Startadresse zeigen bzw. öffnen */
  onReady(start: string): void;
}

/**
 * Wartet auf die Anmeldung im Browser. Antwortet dem Browser nur mit festen
 * Seiten; Anfragen mit falschem state beenden das Warten nicht.
 */
export async function waitForSignIn(options: SignInOptions): Promise<SignInOutcome> {
  const { deps, signal } = options;
  if (signal.aborted) return { ok: false, reason: "abgebrochen", message: "Abgebrochen." };
  const request = createAuthRequest(options.clientId, deps.port);
  let settle!: (outcome: SignInOutcome) => void;
  const done = new Promise<SignInOutcome>(resolve => (settle = resolve));
  let finished = false;
  const finish = (outcome: SignInOutcome) => {
    if (finished) return;
    finished = true;
    settle(outcome);
  };

  const handler = (req: Request): Response => {
    const url = new URL(req.url);
    if (req.method !== "GET") return page(405, "Nicht erlaubt", "Diese Adresse nimmt nur Aufrufe aus dem Browser an.");
    if (finished) return page(410, "Schon beendet", `Diese Anmeldung ist vorbei. Starte sie bei Bedarf neu mit ${BRAND.cli} setup google.`);
    if (url.pathname === "/") return new Response(null, { status: 302, headers: { Location: request.url, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
    if (url.pathname !== CALLBACK_PATH) return page(404, "Nicht gefunden", "Diese Seite gibt es nicht.");
    if (!sameState(url.searchParams.get("state"), request.state)) {
      return page(400, "Ungültige Anfrage", "Diese Antwort gehört nicht zur laufenden Anmeldung.");
    }
    const error = url.searchParams.get("error");
    if (error) {
      const code = /^[a-z_]{1,64}$/.test(error) ? error : "unbekannt";
      finish({
        ok: false,
        reason: "abgelehnt",
        message: code === "access_denied" ? "Die Anmeldung bei Google wurde abgelehnt." : `Google hat die Anmeldung nicht abgeschlossen (${code}).`,
      });
      return page(200, "Nicht verbunden", `Die Anmeldung wurde nicht abgeschlossen. Du kannst dieses Fenster schließen.`);
    }
    const code = url.searchParams.get("code");
    if (!code) return page(400, "Ungültige Anfrage", "In der Antwort fehlt der Code von Google.");
    finish({ ok: true, code, verifier: request.verifier, redirectUri: redirectUri(deps.port) });
    return page(200, "Verbunden", `Die Anmeldung ist angekommen. Du kannst dieses Fenster schließen, ${BRAND.name} macht im Terminal bzw. in der Einrichtung weiter.`);
  };

  let server: LoopbackServer;
  try {
    server = deps.serve(deps.port, handler);
  } catch {
    return {
      ok: false,
      reason: "port",
      message: `Port ${deps.port} auf diesem Rechner ist belegt, die Antwort von Google kann nicht ankommen. Läuft noch eine andere Google-Einrichtung? Diese beenden und erneut versuchen.`,
    };
  }
  const timer = setTimeout(
    () => finish({ ok: false, reason: "zeitlimit", message: `Keine Anmeldung innerhalb von ${Math.round(deps.timeoutMs / 60_000) || 1} Minuten.` }),
    deps.timeoutMs,
  );
  const onAbort = () => finish({ ok: false, reason: "abgebrochen", message: "Abgebrochen." });
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    options.onReady(startUrl(deps.port));
    return await done;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", onAbort);
    server.close();
  }
}

export type ExchangeOutcome = { ok: true; refreshToken: string; accessToken: string } | { ok: false; message: string };

async function jsonOf(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Tauscht den Code gegen Refresh- und Zugriffstoken; Meldung ohne Antworttext */
export async function exchangeCode(
  fetchFn: HttpFetch,
  input: { clientId: string; clientSecret: string; code: string; verifier: string; redirectUri: string },
  signal: AbortSignal,
): Promise<ExchangeOutcome> {
  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
  });
  let response: Response;
  try {
    response = await fetchFn(GOOGLE_TOKEN_URL, { method: "POST", headers: TOKEN_FORM_HEADERS, body: form.toString(), timeoutMs: EXCHANGE_TIMEOUT_MS, signal });
  } catch {
    return { ok: false, message: signal.aborted ? "Abgebrochen." : "Google war für den Token-Tausch nicht erreichbar." };
  }
  const body = await jsonOf(response);
  if (!response.ok) {
    const code = oauthCode(body);
    const hint = code === "invalid_client" ? " Client-ID und Client-Secret prüfen." : "";
    return { ok: false, message: `Google lehnt den Token-Tausch ab (HTTP ${response.status}${code ? `, ${code}` : ""}).${hint}` };
  }
  const data = (body ?? {}) as { refresh_token?: unknown; access_token?: unknown };
  if (typeof data.refresh_token !== "string" || !data.refresh_token) {
    return {
      ok: false,
      message:
        "Google hat keinen Refresh-Token geschickt. Unter https://myaccount.google.com/permissions den Zugriff dieser App entfernen und die Einrichtung wiederholen.",
    };
  }
  if (typeof data.access_token !== "string" || !data.access_token) return { ok: false, message: "Google-Antwort ohne Zugriffstoken." };
  return { ok: true, refreshToken: data.refresh_token, accessToken: data.access_token };
}

async function probeApi(fetchFn: HttpFetch, url: string, token: string, label: string, api: string, signal?: AbortSignal): Promise<StatusItem> {
  try {
    const response = await fetchFn(url, { headers: { Authorization: `Bearer ${token}` }, timeoutMs: API_TIMEOUT_MS, signal });
    await response.body?.cancel().catch(() => {});
    if (response.ok) return { label, ok: true, detail: "Lesezugriff funktioniert." };
    const fix = response.status === 403 ? `In der Google Cloud Console die ${api} aktivieren und beim Anmelden den Zugriff erlauben.` : undefined;
    return { label, ok: false, detail: `Google antwortet mit HTTP ${response.status}.`, ...(fix ? { fix } : {}) };
  } catch {
    return { label, ok: false, detail: signal?.aborted ? "Abgebrochen." : "Google war nicht erreichbar." };
  }
}

/** Prüft mit einem Zugriffstoken, ob Kalender und Gmail lesbar sind */
export async function probeGoogleApis(fetchFn: HttpFetch, accessToken: string, signal?: AbortSignal): Promise<StatusItem[]> {
  return [
    await probeApi(fetchFn, CALENDAR_PROBE, accessToken, "Kalender", "Google Calendar API", signal),
    await probeApi(fetchFn, GMAIL_PROBE, accessToken, "Gmail", "Gmail API", signal),
  ];
}
