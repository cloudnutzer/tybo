/**
 * Anmeldung der WebUI: Passwortvergleich, Sessions, Login-Bremse und die
 * Host-/Origin-Prüfungen (docs/webui/decisions/0002-sicherheit.md).
 *
 * Sessions: Der Browser bekommt ein zufälliges Token (32 Byte). Auf der
 * Platte (data/web-sessions.json, Rechte 0600) liegt nur der SHA-256-Hash,
 * damit ein Neustart nicht abmeldet und die Datei allein keinen Zugang gibt.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join } from "node:path";
import { isLoopbackAddress } from "./cli-token";

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

export const DEFAULT_SESSION_FILE = join(
  process.env.GO_PROJECT_ROOT || process.cwd(),
  "data",
  "web-sessions.json"
);

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const HASH_PATTERN = /^[0-9a-f]{64}$/;

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

/**
 * Zeitkonstanter Vergleich: beide Seiten werden erst gehasht, damit auch
 * unterschiedliche Längen keinen frühen Abbruch verraten.
 */
export function passwordMatches(input: unknown, expected: string): boolean {
  if (typeof input !== "string" || !expected) return false;
  return timingSafeEqual(sha256(input), sha256(expected));
}

export function hashToken(token: string): string {
  return sha256(token).toString("hex");
}

interface SessionFile {
  version: 1;
  sessions: { hash: string; expires: number }[];
}

export interface SessionStoreOptions {
  file?: string;
  now?: () => number;
  ttlMs?: number;
}

export class SessionStore {
  private readonly file: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  /** Hash des Tokens → Ablaufzeitpunkt (ms) */
  private readonly sessions = new Map<string, number>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(options: SessionStoreOptions = {}) {
    this.file = options.file ?? DEFAULT_SESSION_FILE;
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? SESSION_TTL_MS;
  }

  /**
   * Liest die Datei. Fehlende oder kaputte Dateien ergeben keine Sessions,
   * nie eine Anmeldung. Einzelne kaputte Einträge werden übersprungen.
   */
  async load(): Promise<void> {
    this.sessions.clear();
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.file, "utf8"));
    } catch {
      return;
    }
    const list = (parsed as Partial<SessionFile> | null)?.sessions;
    if (!Array.isArray(list)) return;
    const now = this.now();
    for (const entry of list) {
      const hash = (entry as any)?.hash;
      const expires = (entry as any)?.expires;
      if (typeof hash !== "string" || !HASH_PATTERN.test(hash)) continue;
      if (typeof expires !== "number" || !Number.isFinite(expires) || expires <= now) continue;
      this.sessions.set(hash, expires);
    }
  }

  /** Legt eine Session an und gibt das Token zurück (nur für das Cookie). */
  async create(): Promise<string> {
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(hashToken(token), this.now() + this.ttlMs);
    await this.persist();
    return token;
  }

  isValid(token: string | null | undefined): boolean {
    if (!token || !TOKEN_PATTERN.test(token)) return false;
    const hash = hashToken(token);
    const expires = this.sessions.get(hash);
    if (expires === undefined) return false;
    if (expires <= this.now()) {
      this.sessions.delete(hash);
      return false;
    }
    return true;
  }

  /** Meldet ab. Kehrt erst zurück, wenn Speicher und Datei aktualisiert sind. */
  async revoke(token: string | null | undefined): Promise<void> {
    if (!token || !TOKEN_PATTERN.test(token)) return;
    if (this.sessions.delete(hashToken(token))) await this.persist();
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Schreibvorgänge nacheinander, atomar über eine temporäre Datei, Rechte 0600. */
  private persist(): Promise<void> {
    const run = async () => {
      const now = this.now();
      for (const [hash, expires] of this.sessions) if (expires <= now) this.sessions.delete(hash);
      const data: SessionFile = {
        version: 1,
        sessions: [...this.sessions].map(([hash, expires]) => ({ hash, expires })),
      };
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
      await chmod(tmp, 0o600);
      await rename(tmp, this.file);
    };
    const next = this.writeChain.then(run, run);
    this.writeChain = next.catch(() => {});
    return next;
  }
}

export interface LoginLimiterOptions {
  maxFailures?: number;
  windowMs?: number;
  now?: () => number;
}

/** Höchstens `maxFailures` Fehlversuche pro IP im gleitenden Fenster. */
export class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly maxFailures: number;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: LoginLimiterOptions = {}) {
    this.maxFailures = options.maxFailures ?? LOGIN_MAX_FAILURES;
    this.windowMs = options.windowMs ?? LOGIN_WINDOW_MS;
    this.now = options.now ?? Date.now;
  }

  private recent(ip: string): number[] {
    const cutoff = this.now() - this.windowMs;
    const list = (this.failures.get(ip) ?? []).filter(t => t > cutoff);
    if (list.length) this.failures.set(ip, list);
    else this.failures.delete(ip);
    return list;
  }

  isBlocked(ip: string): boolean {
    return this.recent(ip).length >= this.maxFailures;
  }

  recordFailure(ip: string): void {
    const list = this.recent(ip);
    list.push(this.now());
    this.failures.set(ip, list);
    // Speicher begrenzen: abgelaufene Einträge anderer IPs gelegentlich aufräumen
    if (this.failures.size > 1000) for (const key of [...this.failures.keys()]) this.recent(key);
  }
}

/** Zerlegt einen Host-Header in Name (klein, IPv6 ohne Klammern) und Port. */
export function parseHostHeader(host: string): { name: string; port: number | null } | null {
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+)(?::(\d{1,5}))?$/.exec(host.trim());
  if (!m) return null;
  const name = m[1].replace(/^\[|\]$/g, "").toLowerCase();
  return { name, port: m[2] === undefined ? null : Number(m[2]) };
}

/** Adressen der eigenen Netzwerkschnittstellen, ohne IPv6-Zonenangabe. */
export function localInterfaceAddresses(): string[] {
  const result: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const info of list ?? []) result.push(info.address.split("%")[0].toLowerCase());
  }
  return result;
}

/**
 * Schutz gegen DNS-Rebinding: Der Host-Header muss ein bekannter Name des
 * Rechners mit dem tatsächlichen Port des Servers sein.
 */
export function isAllowedHost(
  host: string | null | undefined,
  config: { port: number; allowedHosts: string[] },
  interfaceAddresses: string[] = localInterfaceAddresses()
): boolean {
  if (!host) return false;
  const parsed = parseHostHeader(host);
  if (!parsed) return false;
  const port = parsed.port ?? 80;
  if (port !== config.port) return false;
  const allowed = new Set([
    "localhost",
    "127.0.0.1",
    "::1",
    ...interfaceAddresses,
    ...config.allowedHosts.map(h => h.replace(/^\[|\]$/g, "").toLowerCase()),
  ]);
  return allowed.has(parsed.name);
}

/**
 * Schreibende Anfragen: Origin muss vorhanden sein und in Schema, Host und
 * Port genau zum Host-Header passen. Fehlender Origin und "null" gelten als fremd.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || origin === "null" || !host) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "http:") return false;
  if (url.origin !== origin.toLowerCase()) return false;
  return url.host === host.trim().toLowerCase();
}

/** Kopfzeile, die cloudflared bei getunnelten Anfragen mit der Besucher-IP setzt */
export const TUNNEL_CLIENT_IP_HEADER = "cf-connecting-ip";
/** Besucher-IP, wenn cloudflared eine leere, doppelte oder ungültige Angabe schickt */
export const TUNNEL_UNKNOWN_CLIENT = "tunnel-unbekannt";

export interface RequestOrigin {
  /** Über den Cloudflare Tunnel: Loopback-Verbindung mit CF-Connecting-IP und gesetztem WEB_PUBLIC_ORIGIN */
  tunneled: boolean;
  /**
   * Echte lokale Anfrage: Loopback-Verbindung, die nicht getunnelt ist. Nur
   * sie darf lokale Sonderrechte bekommen (Terminal-Schlüssel). Ohne
   * WEB_PUBLIC_ORIGIN bleibt es beim bisherigen Verhalten: jede
   * Loopback-Verbindung ist lokal, auch mit CF-Connecting-IP (Entscheidung 0014).
   */
  local: boolean;
  /** Für Login-Bremse und Log; nie Grundlage für Sonderrechte */
  clientIp: string;
}

/**
 * Woher eine Anfrage kommt (Issue #98), an genau einer Stelle. cloudflared
 * verbindet sich von 127.0.0.1 und setzt CF-Connecting-IP. Der Kopfzeile wird
 * nur bei einer Loopback-Verbindung und gesetztem WEB_PUBLIC_ORIGIN geglaubt;
 * von jeder anderen Adresse wird sie ignoriert. Als Besucher-IP gilt nur eine
 * einzelne gültige IP-Adresse, sonst ein fester Platzhalter, damit beliebige
 * Texte weder ins Log gelangen noch die Login-Bremse umgehen.
 */
export function requestOrigin(req: Request, peerIp: string, publicOrigin: string | null | undefined): RequestOrigin {
  const loopback = isLoopbackAddress(peerIp);
  const hasHeader = req.headers.has(TUNNEL_CLIENT_IP_HEADER);
  // Ohne öffentliche Adresse wie bisher: Kopfzeile egal, Loopback ist lokal
  if (!loopback || !hasHeader || !publicOrigin) return { tunneled: false, local: loopback, clientIp: peerIp };
  // Loopback mit Tunnel-Kopfzeile und öffentlicher Adresse: getunnelt, nie lokal
  const raw = (req.headers.get(TUNNEL_CLIENT_IP_HEADER) ?? "").trim();
  const clientIp = isIP(raw) ? raw.toLowerCase() : TUNNEL_UNKNOWN_CLIENT;
  return { tunneled: true, local: false, clientIp };
}

/**
 * Kopfzeilen, die cloudflared bzw. Cloudflare an weitergeleitete Anfragen
 * hängt. Ein Browser auf diesem Rechner schickt keine davon.
 */
export const TUNNEL_MARKER_HEADERS = [
  TUNNEL_CLIENT_IP_HEADER,
  "cf-ray",
  "cf-visitor",
  "cf-ipcountry",
  "cf-warp-tag-id",
  "cf-access-jwt-assertion",
  "x-forwarded-for",
] as const;

/**
 * Sieht nach Tunnel aus, unabhängig von WEB_PUBLIC_ORIGIN (Issue #99). Für
 * Server, die nur lokal gelten dürfen (Einrichtungsmodus): lieber eine
 * seltsame lokale Anfrage ablehnen als eine getunnelte durchlassen.
 */
export function hasTunnelHeaders(req: Request): boolean {
  return TUNNEL_MARKER_HEADERS.some(h => req.headers.has(h));
}

/**
 * Host-Prüfung für getunnelte Anfragen: genau der Host aus WEB_PUBLIC_ORIGIN,
 * ohne Port. WEB_ALLOWED_HOSTS und die Adressen des Rechners gelten hier nicht.
 */
export function isPublicHost(host: string | null | undefined, publicOrigin: string): boolean {
  if (!host) return false;
  return host.trim().toLowerCase() === new URL(publicOrigin).host;
}

/** Origin-Prüfung für getunnelte schreibende Anfragen: genau WEB_PUBLIC_ORIGIN */
export function isPublicOrigin(request: Request, publicOrigin: string): boolean {
  return request.headers.get("origin") === publicOrigin;
}
