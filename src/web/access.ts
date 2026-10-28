/**
 * Cloudflare-Access-Nachweis (Issue #99, Entscheidung 0014): das zweite
 * Schloss vor der WebUI. Über den Tunnel muss jede Anfrage einen gültigen
 * Cf-Access-Jwt-Assertion tragen, sonst lehnt der Server sie ab. So öffnet
 * eine falsch konfigurierte Access-Regel nicht alles.
 *
 * Geprüft wird:
 * - Aufbau: drei base64url-Teile, Kopf und Inhalt als JSON-Objekte
 * - Algorithmus genau RS256, Schlüssel-ID (kid) im Kopf
 * - Signatur mit dem öffentlichen Schlüssel aus
 *   https://<team>.cloudflareaccess.com/cdn-cgi/access/certs
 * - iss genau https://<team>.cloudflareaccess.com, aud enthält WEB_ACCESS_AUD
 * - exp Pflicht, nbf und iat wenn vorhanden als Zahl; 30 Sekunden Spielraum für Uhren
 *
 * Schlüssel werden zwischengespeichert (eine Stunde). Eine unbekannte kid
 * lädt sie neu, aber höchstens einmal pro Minute und gleichzeitige Anfragen
 * teilen sich einen Abruf, damit wechselnde kids keine Abruf-Flut auslösen.
 * Scheitert der Abruf, gelten bekannte Schlüssel noch bis zu einem Tag.
 *
 * Ergebnisse nennen nur einen Grund, nie das Token oder Teile davon.
 */

import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import type { AccessConfig } from "./config";

/** Kopfzeile, die Cloudflare Access an den Tunnel weitergibt */
export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";

export type AccessReason =
  | "nicht-eingerichtet"
  | "fehlt"
  | "format"
  | "algorithmus"
  | "schluessel-unbekannt"
  | "schluesselabruf"
  | "signatur"
  | "iss"
  | "aud"
  | "zeitangaben"
  | "abgelaufen"
  | "noch-nicht-gueltig";

export type AccessResult = { ok: true } | { ok: false; reason: AccessReason };

/** Kurze Gründe fürs Log */
export const ACCESS_REASON_TEXT: Record<AccessReason, string> = {
  "nicht-eingerichtet": "Access nicht eingerichtet (WEB_ACCESS_TEAM, WEB_ACCESS_AUD)",
  fehlt: "Nachweis fehlt",
  format: "Nachweis unlesbar",
  algorithmus: "falscher Algorithmus",
  "schluessel-unbekannt": "unbekannter Schlüssel",
  schluesselabruf: "Schlüssel nicht abrufbar",
  signatur: "Signatur ungültig",
  iss: "falscher Aussteller",
  aud: "falsche Anwendung (aud)",
  zeitangaben: "Zeitangaben fehlen oder sind ungültig",
  abgelaufen: "abgelaufen",
  "noch-nicht-gueltig": "noch nicht gültig",
};

export const ACCESS_CACHE_MS = 60 * 60 * 1000;
export const ACCESS_MIN_REFRESH_MS = 60 * 1000;
export const ACCESS_MAX_STALE_MS = 24 * 60 * 60 * 1000;
export const ACCESS_FETCH_TIMEOUT_MS = 5000;
export const ACCESS_CLOCK_LEEWAY_S = 30;
const MAX_TOKEN_LENGTH = 16 * 1024;
const MAX_CERTS_BYTES = 256 * 1024;

/** Liefert die geparste JSON-Antwort der certs-Adresse oder wirft */
export type FetchCerts = (url: string, signal: AbortSignal) => Promise<unknown>;

export interface AccessVerifierOptions {
  access: AccessConfig;
  /** Standard: fetch ohne Weiterleitungen; Tests reichen eine Attrappe herein */
  fetchCerts?: FetchCerts;
  now?: () => number;
  cacheMs?: number;
  minRefreshMs?: number;
  maxStaleMs?: number;
  timeoutMs?: number;
  /** Nur Fehlernamen, nie Inhalte */
  log?: (message: string) => void;
}

export interface AccessVerifier {
  verify(token: string | null | undefined): Promise<AccessResult>;
}

export function accessIssuer(team: string): string {
  return `https://${team}.cloudflareaccess.com`;
}

export function accessCertsUrl(team: string): string {
  return `${accessIssuer(team)}/cdn-cgi/access/certs`;
}

async function defaultFetchCerts(url: string, signal: AbortSignal): Promise<unknown> {
  const res = await fetch(url, { signal, redirect: "error", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_CERTS_BYTES) throw new Error("Antwort zu groß");
  return JSON.parse(text);
}

/** Öffentliche RSA-Schlüssel (mindestens 2048 Bit) nach kid; ungültige Einträge fallen weg */
export function parseCerts(data: unknown): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  const list = (data as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(list)) return keys;
  for (const jwk of list) {
    if (!jwk || typeof jwk !== "object") continue;
    const { kid, kty, n, e } = jwk as Record<string, unknown>;
    if (typeof kid !== "string" || !kid || kty !== "RSA" || typeof n !== "string" || typeof e !== "string") continue;
    try {
      const key = createPublicKey({ key: { kty: "RSA", n, e }, format: "jwk" });
      if ((key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048) continue;
      keys.set(kid, key);
    } catch {
      // Kaputter Schlüssel: überspringen
    }
  }
  return keys;
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

function decodeJsonPart(part: string): Record<string, unknown> | null {
  if (!BASE64URL.test(part)) return null;
  try {
    const value = JSON.parse(Buffer.from(part, "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function createAccessVerifier(options: AccessVerifierOptions): AccessVerifier {
  const { team, aud } = options.access;
  const issuer = accessIssuer(team);
  const certsUrl = accessCertsUrl(team);
  const fetchCerts = options.fetchCerts ?? defaultFetchCerts;
  const now = options.now ?? Date.now;
  const cacheMs = options.cacheMs ?? ACCESS_CACHE_MS;
  const minRefreshMs = options.minRefreshMs ?? ACCESS_MIN_REFRESH_MS;
  const maxStaleMs = options.maxStaleMs ?? ACCESS_MAX_STALE_MS;
  const timeoutMs = options.timeoutMs ?? ACCESS_FETCH_TIMEOUT_MS;
  const log = options.log ?? (() => {});

  let keys = new Map<string, KeyObject>();
  /** Zeitpunkt des letzten erfolgreichen Abrufs */
  let fetchedAt = -Infinity;
  /** Zeitpunkt des letzten Versuchs, erfolgreich oder nicht */
  let attemptedAt = -Infinity;
  let lastFailed = false;
  let inflight: Promise<void> | null = null;

  function refresh(): Promise<void> {
    if (inflight) return inflight;
    attemptedAt = now();
    inflight = (async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const fresh = parseCerts(await fetchCerts(certsUrl, controller.signal));
        if (fresh.size === 0) throw new Error("keine gültigen Schlüssel");
        keys = fresh;
        fetchedAt = now();
        lastFailed = false;
      } catch (e) {
        lastFailed = true;
        log(`Access: Schlüsselabruf fehlgeschlagen (${e instanceof Error ? e.name : typeof e})`);
      } finally {
        clearTimeout(timer);
        inflight = null;
      }
    })();
    return inflight;
  }

  async function keyFor(kid: string): Promise<KeyObject | AccessReason> {
    const age = now() - fetchedAt;
    const fresh = age < cacheMs;
    if (fresh && keys.has(kid)) return keys.get(kid)!;
    // Veraltet oder unbekannte kid: neu laden, aber gebremst
    if (inflight) await inflight;
    else if (now() - attemptedAt >= minRefreshMs) await refresh();
    if (now() - fetchedAt >= cacheMs + maxStaleMs) keys = new Map();
    const key = keys.get(kid);
    if (key) return key;
    return lastFailed ? "schluesselabruf" : "schluessel-unbekannt";
  }

  return {
    async verify(token) {
      const value = (token ?? "").trim();
      if (!value) return { ok: false, reason: "fehlt" };
      if (value.length > MAX_TOKEN_LENGTH) return { ok: false, reason: "format" };
      const parts = value.split(".");
      if (parts.length !== 3 || !BASE64URL.test(parts[2])) return { ok: false, reason: "format" };
      const header = decodeJsonPart(parts[0]);
      const payload = decodeJsonPart(parts[1]);
      if (!header || !payload) return { ok: false, reason: "format" };
      if (header.alg !== "RS256") return { ok: false, reason: "algorithmus" };
      const kid = header.kid;
      if (typeof kid !== "string" || !kid || kid.length > 256) return { ok: false, reason: "format" };

      const key = await keyFor(kid);
      if (typeof key === "string") return { ok: false, reason: key };
      let valid = false;
      try {
        valid = verifySignature(
          "RSA-SHA256",
          Buffer.from(`${parts[0]}.${parts[1]}`),
          key,
          Buffer.from(parts[2], "base64url")
        );
      } catch {
        valid = false;
      }
      if (!valid) return { ok: false, reason: "signatur" };

      if (payload.iss !== issuer) return { ok: false, reason: "iss" };
      const audience = payload.aud;
      const audOk = typeof audience === "string" ? audience === aud : Array.isArray(audience) && audience.includes(aud);
      if (!audOk) return { ok: false, reason: "aud" };

      const { exp, nbf, iat } = payload;
      if (!isTime(exp) || (nbf !== undefined && !isTime(nbf)) || (iat !== undefined && !isTime(iat))) {
        return { ok: false, reason: "zeitangaben" };
      }
      const seconds = now() / 1000;
      if (seconds >= exp + ACCESS_CLOCK_LEEWAY_S) return { ok: false, reason: "abgelaufen" };
      if (nbf !== undefined && seconds + ACCESS_CLOCK_LEEWAY_S < nbf) return { ok: false, reason: "noch-nicht-gueltig" };
      return { ok: true };
    },
  };
}
