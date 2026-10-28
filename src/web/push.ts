/**
 * Web Push (Issue #225, Entscheidung 0021): Schlüssel, VAPID-Anmeldung und
 * Verschlüsselung, selbst gebaut auf WebCrypto und fetch, ohne neue
 * Abhängigkeit.
 *
 * - VAPID nach RFC 8292: JWT mit ES256, aud = Ursprung des Push-Endpunkts,
 *   exp höchstens 12 Stunden, sub = WEB_PUSH_SUBJECT (mailto: oder https:).
 *   Kopfzeile Authorization: vapid t=<jwt>, k=<öffentlicher Schlüssel>.
 * - Inhalt nach RFC 8291 mit aes128gcm (RFC 8188): pro Nachricht ein frisches
 *   ECDH-Schlüsselpaar und ein frisches Salt, getrennt vom VAPID-Schlüssel.
 * - Ziele nur über HTTPS zu bekannten Push-Diensten (Apple, Google, Mozilla,
 *   Microsoft), ohne Zugangsdaten und eigenen Port, ohne Weiterleitungen.
 *   Die Prüfung gilt beim Anlegen eines Abos und noch einmal beim Versand.
 *
 * Schlüssel liegen als base64url vor: öffentlich 65 Bytes (unkomprimierter
 * P-256-Punkt), privat 32 Bytes (Skalar d). Diese Datei liest und schreibt
 * keine Dateien; die .env schreibt ./bot-push.ts.
 */

import { BRAND } from "../brand";

/** Bytes mit eigenem ArrayBuffer, wie WebCrypto und fetch sie annehmen */
type Bytes = Uint8Array<ArrayBuffer>;

export interface VapidKeys {
  /** base64url, 65 Bytes, beginnt mit 0x04 */
  publicKey: string;
  /** base64url, 32 Bytes */
  privateKey: string;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export const PUSH_ENV = {
  publicKey: "WEB_PUSH_PUBLIC_KEY",
  privateKey: "WEB_PUSH_PRIVATE_KEY",
  subject: "WEB_PUSH_SUBJECT",
} as const;

/**
 * Wie validPushKeys, prüft zusätzlich, ob p256dh wirklich ein Punkt auf P-256
 * ist (WebCrypto lehnt sonst den Import ab). Vor dem Speichern eines Abos.
 */
export async function validPushKeysStrict(keys: unknown): Promise<boolean> {
  if (!validPushKeys(keys)) return false;
  try {
    await crypto.subtle.importKey("raw", fromBase64Url(keys.p256dh)!, { name: "ECDH", namedCurve: "P-256" }, false, []);
    return true;
  } catch {
    return false;
  }
}

/** Kontakt für die Push-Dienste, wenn WEB_PUSH_SUBJECT fehlt: keine E-Mail-Adresse */
export const DEFAULT_PUSH_SUBJECT = `https://${BRAND.domain}`;
/** RFC 8292 erlaubt 24 Stunden, das Issue höchstens 12 */
export const VAPID_TTL_SECONDS = 12 * 60 * 60;
export const DEFAULT_PUSH_TIMEOUT_MS = 10_000;
/** Standard-Lebensdauer beim Push-Dienst: ein Tag */
export const DEFAULT_PUSH_TTL = 24 * 60 * 60;
/** Satzgröße wie im RFC-Beispiel; eine Nachricht ist immer genau ein Satz */
const RECORD_SIZE = 4096;
/** 4096 Bytes Nachricht beim Push-Dienst minus Kopf (86), Tag (16) und Trennbyte */
export const MAX_PUSH_PLAINTEXT_BYTES = RECORD_SIZE - 86 - 16 - 1;
export const MAX_ENDPOINT_LENGTH = 2048;

/** Hosts der Push-Dienste; „.x" heißt: echte Subdomain von x */
const PUSH_HOSTS: ReadonlyArray<{ exact?: string; suffix?: string }> = [
  { suffix: ".push.apple.com" },
  { exact: "fcm.googleapis.com" },
  { suffix: ".push.services.mozilla.com" },
  { suffix: ".notify.windows.com" },
];

const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** base64url ohne Auffüllung; null bei anderen Zeichen */
export function fromBase64Url(value: string): Bytes | null {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value)) return null;
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export function toBase64Url(bytes: Uint8Array | ArrayBuffer): string {
  return Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
}

function concat(...parts: Bytes[]): Bytes {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

const encoder = new TextEncoder();

/**
 * Nur https, nur ein Host eines bekannten Push-Diensts (Subdomain-Grenze
 * beachtet: evilpush.apple.com passt nicht auf .push.apple.com), kein Port,
 * keine Zugangsdaten, kein Anker. null, wenn etwas nicht passt.
 */
export function parsePushEndpoint(raw: unknown): URL | null {
  if (typeof raw !== "string" || !raw || raw.length > MAX_ENDPOINT_LENGTH) return null;
  if (/[\s\u0000-\u001f\u007f]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port !== "" || url.hash) return null;
  const host = url.hostname;
  if (!host.split(".").every(label => HOST_LABEL.test(label))) return null;
  const known = PUSH_HOSTS.some(h => (h.exact ? host === h.exact : host.endsWith(h.suffix!) && host.length > h.suffix!.length));
  return known ? url : null;
}

/** Schlüssel eines Abos: p256dh ist ein unkomprimierter P-256-Punkt, auth 16 Bytes */
export function validPushKeys(keys: unknown): keys is PushTarget["keys"] {
  if (!keys || typeof keys !== "object") return false;
  const { p256dh, auth } = keys as Record<string, unknown>;
  if (typeof p256dh !== "string" || typeof auth !== "string" || p256dh.length > 100 || auth.length > 40) return false;
  const point = fromBase64Url(p256dh);
  const secret = fromBase64Url(auth);
  return !!point && point.length === 65 && point[0] === 4 && !!secret && secret.length === 16;
}

/** Kontakt für die Push-Dienste: nur mailto: oder https: (Apple verlangt eins davon) */
export function validPushSubject(value: string): boolean {
  if (!value || value.length > 200 || /[\s\u0000-\u001f\u007f]/.test(value)) return false;
  if (/^mailto:[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

function pointXY(publicKey: Bytes): { x: string; y: string } {
  return { x: toBase64Url(publicKey.slice(1, 33)), y: toBase64Url(publicKey.slice(33, 65)) };
}

async function importPrivate(publicKey: Bytes, d: Bytes, algorithm: "ECDSA" | "ECDH"): Promise<CryptoKey> {
  const jwk: JsonWebKey = { kty: "EC", crv: "P-256", d: toBase64Url(d), ...pointXY(publicKey), ext: false };
  const usages: KeyUsage[] = algorithm === "ECDSA" ? ["sign"] : ["deriveBits"];
  return crypto.subtle.importKey("jwk", jwk, { name: algorithm, namedCurve: "P-256" }, false, usages);
}

/** Neues VAPID-Schlüsselpaar mit WebCrypto */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  const jwk = await crypto.subtle.exportKey("jwk", pair.privateKey);
  return { publicKey: toBase64Url(raw), privateKey: jwk.d! };
}

/**
 * Prüft Form und Zusammengehörigkeit: beide Werte in der richtigen Länge,
 * und eine Signatur mit dem privaten Schlüssel lässt sich mit dem
 * öffentlichen prüfen. Wirft nie.
 */
export async function validateVapidKeys(keys: Partial<VapidKeys>): Promise<boolean> {
  const pub = fromBase64Url(keys.publicKey ?? "");
  const priv = fromBase64Url(keys.privateKey ?? "");
  if (!pub || pub.length !== 65 || pub[0] !== 4 || !priv || priv.length !== 32) return false;
  try {
    const signer = await importPrivate(pub, priv, "ECDSA");
    const verifier = await crypto.subtle.importKey("raw", pub, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const data = encoder.encode("tybo-push-check");
    const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signer, data);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, verifier, sig, data);
  } catch {
    return false;
  }
}

/**
 * VAPID-JWT (RFC 8292): aud ist der Ursprung des Endpunkts, exp jetzt plus
 * höchstens 12 Stunden. Die Signatur von WebCrypto ist schon r||s, wie JWS sie will.
 */
export async function vapidJwt(endpoint: string, subject: string, keys: VapidKeys, nowMs = Date.now()): Promise<string> {
  const pub = fromBase64Url(keys.publicKey);
  const priv = fromBase64Url(keys.privateKey);
  if (!pub || !priv) throw new Error("VAPID-Schlüssel ungültig");
  const header = toBase64Url(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = { aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + VAPID_TTL_SECONDS, sub: subject };
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const key = await importPrivate(pub, priv, "ECDSA");
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${toBase64Url(sig)}`;
}

export function vapidAuthorization(jwt: string, publicKey: string): string {
  return `vapid t=${jwt}, k=${publicKey}`;
}

async function hmac(key: Bytes, data: Bytes): Promise<Bytes> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

/** HKDF mit einem einzigen Block (Länge höchstens 32), wie RFC 8291 es beschreibt */
async function hkdf(salt: Bytes, ikm: Bytes, info: Bytes, length: number): Promise<Bytes> {
  const prk = await hmac(salt, ikm);
  return (await hmac(prk, concat(info, new Uint8Array([1])))).slice(0, length);
}

/** Zwischenwerte für die Tests gegen RFC 8291 Anhang A */
export interface EncryptTrace {
  ecdhSecret: Bytes;
  ikm: Bytes;
  cek: Bytes;
  nonce: Bytes;
  header: Bytes;
}

export interface EncryptOptions {
  /** Nur für Tests: festes Sender-Schlüsselpaar statt eines frischen */
  senderKeys?: VapidKeys;
  /** Nur für Tests: festes Salt statt 16 zufälliger Bytes */
  salt?: Bytes;
  trace?: (values: EncryptTrace) => void;
}

/**
 * Verschlüsselt eine Nachricht für ein Abo (RFC 8291 mit aes128gcm aus
 * RFC 8188): ein Satz, Trennbyte 0x02, keine Auffüllung. Ergebnis ist der
 * ganze Body mit Kopf (Salt, Satzgröße, Sender-Schlüssel).
 */
export async function encryptPushPayload(target: PushTarget["keys"], plaintext: Bytes, options: EncryptOptions = {}): Promise<Bytes> {
  if (!validPushKeys(target)) throw new Error("Schlüssel des Abos ungültig");
  if (plaintext.length > MAX_PUSH_PLAINTEXT_BYTES) throw new Error("Nachricht zu groß");
  const uaPublic = fromBase64Url(target.p256dh)!;
  const authSecret = fromBase64Url(target.auth)!;
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  if (salt.length !== 16) throw new Error("Salt muss 16 Bytes haben");

  let asPublic: Bytes;
  let asPrivate: CryptoKey;
  if (options.senderKeys) {
    asPublic = fromBase64Url(options.senderKeys.publicKey)!;
    asPrivate = await importPrivate(asPublic, fromBase64Url(options.senderKeys.privateKey)!, "ECDH");
  } else {
    // Pro Nachricht frisch, nie der VAPID-Schlüssel
    const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])) as CryptoKeyPair;
    asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    asPrivate = pair.privateKey;
  }
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asPrivate, 256));

  const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, RECORD_SIZE);
  const header = concat(salt, rs, new Uint8Array([asPublic.length]), asPublic);
  options.trace?.({ ecdhSecret, ikm, cek, nonce, header });

  const aes = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const record = concat(plaintext, new Uint8Array([2]));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, record));
  return concat(header, cipher);
}

export type PushUrgency = "very-low" | "low" | "normal" | "high";

export interface PushMessage {
  title: string;
  body?: string;
  /** Ersetzt eine ältere Benachrichtigung mit gleichem tag auf dem Gerät */
  tag?: string;
  /** Pfad innerhalb der WebUI, z. B. /#/einstellungen/benachrichtigungen */
  url?: string;
}

export interface SendOptions {
  keys: VapidKeys;
  subject: string;
  ttl?: number;
  urgency?: PushUrgency;
  /** Kopfzeile Topic: ersetzbare Nachricht beim Push-Dienst (höchstens 32 Zeichen base64url) */
  topic?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
}

/**
 * Ergebnis beim Push-Dienst: ok heißt angenommen, nicht zugestellt.
 * gone (404, 410): Abo gibt es nicht mehr, löschen. retry (413, 429, 5xx):
 * behalten. rejected: Ziel oder Schlüssel des Abos taugen nicht.
 */
export type SendResult =
  | { status: "ok"; code: number }
  | { status: "gone"; code: number }
  | { status: "retry"; code: number }
  | { status: "error"; code?: number; reason: string }
  | { status: "rejected"; reason: string };

const TOPIC_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** Host des Endpunkts für Logs: nie der Pfad (er ist das Abo selbst) */
export function endpointHost(endpoint: string): string {
  try {
    return new URL(endpoint).hostname;
  } catch {
    return "?";
  }
}

export async function sendPush(target: PushTarget, message: PushMessage, options: SendOptions): Promise<SendResult> {
  const url = parsePushEndpoint(target.endpoint);
  if (!url) return { status: "rejected", reason: "Ziel ist kein bekannter Push-Dienst" };
  if (!validPushKeys(target.keys)) return { status: "rejected", reason: "Schlüssel des Abos ungültig" };
  const plaintext = encoder.encode(JSON.stringify(message));
  if (plaintext.length > MAX_PUSH_PLAINTEXT_BYTES) return { status: "error", reason: "Nachricht zu groß" };
  let body: Bytes;
  let jwt: string;
  try {
    body = await encryptPushPayload(target.keys, plaintext);
    jwt = await vapidJwt(url.href, options.subject, options.keys, (options.now ?? Date.now)());
  } catch {
    return { status: "rejected", reason: "Verschlüsselung fehlgeschlagen" };
  }
  const headers: Record<string, string> = {
    Authorization: vapidAuthorization(jwt, options.keys.publicKey),
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(Math.max(0, Math.floor(options.ttl ?? DEFAULT_PUSH_TTL))),
    Urgency: options.urgency ?? "normal",
  };
  if (options.topic && TOPIC_PATTERN.test(options.topic)) headers.Topic = options.topic;
  const doFetch = options.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url.href, {
      method: "POST",
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_PUSH_TIMEOUT_MS),
    });
  } catch (e) {
    const timeout = e instanceof Error && (e.name === "TimeoutError" || e.name === "AbortError");
    return { status: "error", reason: timeout ? "Zeitlimit" : "Netzfehler" };
  }
  // Body nicht lesen: die Antworten der Dienste sind für uns ohne Nutzen
  await res.body?.cancel().catch(() => {});
  const code = res.status;
  if (code >= 200 && code < 300) return { status: "ok", code };
  if (code === 404 || code === 410) return { status: "gone", code };
  if (code === 413 || code === 429 || code >= 500) return { status: "retry", code };
  if (code >= 300 && code < 400) return { status: "error", code, reason: "Weiterleitung abgelehnt" };
  return { status: "error", code, reason: `Push-Dienst antwortet ${code}` };
}
