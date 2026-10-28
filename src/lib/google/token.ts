/**
 * Zugriffstoken für Google (Issue #355), gemeinsam für Kalender, Gmail und
 * Board. Erneuert wird mit dem Refresh-Token aus GOOGLE_REFRESH_TOKEN; die
 * Einrichtung macht der Schritt `tybo setup google` (src/setup/steps/google.ts).
 *
 * - Zwischenspeicher im Prozess, gebunden an die Zugangsdaten (Hash aus allen
 *   drei Werten, nie im Klartext). Ein Token gilt bis 60 Sekunden vor seinem
 *   Ablauf laut expires_in; ohne gültiges expires_in wird es nicht gemerkt.
 * - Gleichzeitige Anfragen mit denselben Zugangsdaten teilen einen Abruf. Der
 *   hat ein eigenes Zeitlimit und hängt an keinem Signal eines Aufrufers:
 *   bricht einer ab, wirft nur sein Aufruf, die anderen bekommen das Token.
 * - Fehler nennen nur HTTP-Status und den OAuth-Fehlercode, nie den
 *   Antworttext von Google: Quellen reichen Fehler ins Log weiter.
 */
import { createHash } from "node:crypto";

type Env = Record<string, string | undefined>;

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** Der Token-Endpunkt nimmt nur Formulardaten */
export const TOKEN_FORM_HEADERS = { "Content-Type": "application/x-www-form-urlencoded" };
/** Zeitlimit des gemeinsamen Abrufs, Antwortkörper eingeschlossen */
export const TOKEN_TIMEOUT_MS = 15_000;
/** So lange vor dem Ablauf gilt ein gemerktes Token schon als verbraucht */
const EXPIRY_MARGIN_MS = 60_000;

const VARS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN"] as const;
const CHECK_HINT = "GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET und GOOGLE_REFRESH_TOKEN prüfen";

export interface TokenOptions {
  env?: Env;
  fetch?: typeof fetch;
  /** Uhr in Millisekunden, sonst Date.now */
  now?: () => number;
  /** Bricht nur diesen Aufruf ab, nie den gemeinsamen Abruf */
  signal?: AbortSignal;
  /** Zeitlimit eines neu gestarteten Abrufs, sonst TOKEN_TIMEOUT_MS */
  timeoutMs?: number;
}

interface Credentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}

const remembered = new Map<string, { token: string; expiresAt: number }>();
const inFlight = new Map<string, Promise<string>>();
/** Steigt beim Leeren; ein älterer Abruf trägt danach nichts mehr ein */
let epoch = 0;

const valueOf = (env: Env, name: string) => env[name]?.trim() ?? "";

function missingVars(env: Env): string[] {
  return VARS.filter(name => !valueOf(env, name));
}

/** Sind alle drei Zugangsdaten gesetzt? Ohne Netz */
export function googleReady(env: Env = process.env): boolean {
  return missingVars(env).length === 0;
}

/** Leert Zwischenspeicher und Verweise auf laufende Abrufe (für Tests) */
export function clearGoogleTokenCache(): void {
  remembered.clear();
  inFlight.clear();
  epoch++;
}

function keyFor(creds: Credentials): string {
  return createHash("sha256")
    .update([creds.clientId, creds.clientSecret, creds.refreshToken].join("\u0000"))
    .digest("hex");
}

/** OAuth-Fehlercode aus der Antwort, nur wenn er wie einer aussieht */
export function oauthCode(body: unknown): string | undefined {
  const code = (body as { error?: unknown } | null)?.error;
  return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : undefined;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

interface Grant {
  token: string;
  /** Lebensdauer in Sekunden; fehlt, wenn Google keine brauchbare nennt */
  lifetime?: number;
}

async function requestGrant(creds: Credentials, fetchFn: typeof fetch, signal: AbortSignal): Promise<Grant> {
  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    refresh_token: creds.refreshToken,
  });
  const response = await fetchFn(GOOGLE_TOKEN_URL, { method: "POST", signal, headers: TOKEN_FORM_HEADERS, body: form });
  const body = await readJson(response);
  if (!response.ok) {
    const code = oauthCode(body);
    const detail = code ? `HTTP ${response.status}, ${code}` : `HTTP ${response.status}`;
    throw new Error(`Google lehnt die Token-Erneuerung ab (${detail}), ${CHECK_HINT}`);
  }
  const data = (body ?? {}) as { access_token?: unknown; expires_in?: unknown };
  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new Error("Google-Antwort ohne access_token");
  }
  const lifetime = typeof data.expires_in === "number" && Number.isFinite(data.expires_in) && data.expires_in > 0 ? data.expires_in : undefined;
  return { token: data.access_token, lifetime };
}

/** Startet den gemeinsamen Abruf mit eigenem Zeitlimit */
function startShared(key: string, creds: Credentials, fetchFn: typeof fetch, now: () => number, timeoutMs: number): Promise<string> {
  const controller = new AbortController();
  const startedIn = epoch;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`Google antwortet nicht auf die Token-Erneuerung (Zeitlimit ${timeoutMs} ms)`);
      controller.abort(err);
      reject(err);
    }, timeoutMs);
  });
  const request = requestGrant(creds, fetchFn, controller.signal);
  request.catch(() => {}); // ein Fehler nach dem Zeitlimit bleibt still

  const shared: Promise<string> = Promise.race([request, expired])
    .then(grant => {
      if (grant.lifetime !== undefined && startedIn === epoch) {
        remembered.set(key, { token: grant.token, expiresAt: now() + grant.lifetime * 1000 });
      }
      return grant.token;
    })
    .finally(() => {
      clearTimeout(timer);
      if (inFlight.get(key) === shared) inFlight.delete(key);
    });
  shared.catch(() => {}); // wer abbricht, wartet nicht mehr; der Fehler gehört den übrigen
  inFlight.set(key, shared);
  return shared;
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Abgebrochen", "AbortError");
}

/** Wartet auf den gemeinsamen Abruf, bis das eigene Signal auslöst */
function untilAborted(shared: Promise<string>, signal: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Gültiges Zugriffstoken; wirft mit verständlicher Meldung ohne Antworttext */
export async function googleAccessToken(options: TokenOptions = {}): Promise<string> {
  const { signal } = options;
  if (signal?.aborted) throw abortReason(signal);
  const env = options.env ?? process.env;
  const missing = missingVars(env);
  if (missing.length > 0) throw new Error(`Google-Zugang unvollständig, es fehlt: ${missing.join(", ")}`);

  const creds: Credentials = {
    clientId: valueOf(env, "GOOGLE_CLIENT_ID"),
    clientSecret: valueOf(env, "GOOGLE_CLIENT_SECRET"),
    refreshToken: valueOf(env, "GOOGLE_REFRESH_TOKEN"),
  };
  const now = options.now ?? Date.now;
  const key = keyFor(creds);
  const hit = remembered.get(key);
  if (hit && now() < hit.expiresAt - EXPIRY_MARGIN_MS) return hit.token;

  const shared =
    inFlight.get(key) ?? startShared(key, creds, options.fetch ?? globalThis.fetch, now, options.timeoutMs ?? TOKEN_TIMEOUT_MS);
  return signal ? untilAborted(shared, signal) : shared;
}
