/**
 * Konfiguration der WebUI aus der Umgebung (docs/webui/decisions/0002-sicherheit.md).
 * Reine Funktion: liest nur das übergebene env-Objekt, keine Seiteneffekte.
 */

import { isIP } from "node:net";

export interface WebConfig {
  host: string;
  /** 1 bis 65535 aus der Umgebung; 0 (freier Port) nur in Tests über createWebServer */
  port: number;
  password: string;
  /** Zusätzlich erlaubte Host-Namen, klein geschrieben, ohne Port */
  allowedHosts: string[];
  /**
   * Öffentliche Adresse hinter dem Cloudflare Tunnel (Issue #98, Entscheidung
   * 0014), z. B. https://app.tybo.ai. Ohne sie gibt es keine getunnelten
   * Anfragen, alles bleibt wie im Heimnetz.
   */
  publicOrigin?: string | null;
  /**
   * Cloudflare Access (Issue #99, Entscheidung 0014): Team-Name
   * (<team>.cloudflareaccess.com) und Application Audience Tag. Nur beide
   * zusammen; fehlt es, sind getunnelte Anfragen immer abgelehnt.
   */
  access?: AccessConfig | null;
}

export interface AccessConfig {
  /** Klein geschrieben, gültiger Subdomain-Name, z. B. meinteam */
  team: string;
  aud: string;
}

export type WebConfigResult =
  | { status: "ok"; config: WebConfig }
  | { status: "disabled" }
  | { status: "invalid"; reason: string };

export const DEFAULT_WEB_HOST = "127.0.0.1";
export const DEFAULT_WEB_PORT = 3100;
export const MIN_PASSWORD_LENGTH = 12;

type Env = Record<string, string | undefined>;

export function loadWebConfig(env: Env): WebConfigResult {
  if ((env.WEB_ENABLED ?? "").trim().toLowerCase() !== "true") return { status: "disabled" };

  const password = env.WEB_PASSWORD ?? "";
  if (!password) return { status: "invalid", reason: "WEB_ENABLED ist gesetzt, aber WEB_PASSWORD fehlt" };
  if ([...password].length < MIN_PASSWORD_LENGTH) {
    return { status: "invalid", reason: `WEB_PASSWORD ist kürzer als ${MIN_PASSWORD_LENGTH} Zeichen` };
  }

  const rawPort = (env.WEB_PORT ?? "").trim();
  let port = DEFAULT_WEB_PORT;
  if (rawPort) {
    if (!/^\d{1,5}$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
      return { status: "invalid", reason: "WEB_PORT ist kein gültiger Port (1 bis 65535)" };
    }
    port = Number(rawPort);
  }

  const host = (env.WEB_HOST ?? "").trim() || DEFAULT_WEB_HOST;
  const allowedHosts = (env.WEB_ALLOWED_HOSTS ?? "")
    .split(",")
    .map(h => h.trim().toLowerCase())
    .filter(Boolean);

  const rawOrigin = (env.WEB_PUBLIC_ORIGIN ?? "").trim();
  let publicOrigin: string | null = null;
  if (rawOrigin) {
    publicOrigin = parsePublicOrigin(rawOrigin);
    if (!publicOrigin) {
      return {
        status: "invalid",
        reason: "WEB_PUBLIC_ORIGIN muss eine https-Adresse ohne Pfad sein, z. B. https://app.tybo.ai",
      };
    }
  }

  const access = parseAccessConfig(env);
  if (access.status === "invalid") return { status: "invalid", reason: access.reason };

  return { status: "ok", config: { host, port, password, allowedHosts, publicOrigin, access: access.access } };
}

/** Team-Name von Cloudflare Zero Trust: ein einzelner Subdomain-Teil */
const ACCESS_TEAM_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Application Audience Tag: bei Cloudflare 64 Hex-Zeichen; hier bewusst etwas weiter, aber ohne Sonderzeichen */
const ACCESS_AUD_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

/**
 * WEB_ACCESS_TEAM und WEB_ACCESS_AUD (Issue #99). Beide leer: kein Access
 * (null). Nur eins gesetzt oder ungültig: die WebUI startet nicht, damit ein
 * Tippfehler auffällt statt still jede getunnelte Anfrage abzulehnen.
 * Den Team-Namen darf man auch als ganze Adresse (meinteam.cloudflareaccess.com) eintragen.
 */
export function parseAccessConfig(
  env: Env
): { status: "ok"; access: AccessConfig | null } | { status: "invalid"; reason: string } {
  let team = (env.WEB_ACCESS_TEAM ?? "").trim().toLowerCase();
  const aud = (env.WEB_ACCESS_AUD ?? "").trim();
  if (!team && !aud) return { status: "ok", access: null };
  if (!team || !aud) {
    return { status: "invalid", reason: "WEB_ACCESS_TEAM und WEB_ACCESS_AUD gehören zusammen, eins davon fehlt" };
  }
  team = team.replace(/^https:\/\//, "").replace(/\/$/, "").replace(/\.cloudflareaccess\.com$/, "");
  if (!ACCESS_TEAM_PATTERN.test(team)) {
    return {
      status: "invalid",
      reason: "WEB_ACCESS_TEAM ist kein gültiger Team-Name (nur a-z, 0-9 und -, z. B. meinteam für meinteam.cloudflareaccess.com)",
    };
  }
  if (!ACCESS_AUD_PATTERN.test(aud)) {
    return { status: "invalid", reason: "WEB_ACCESS_AUD ist kein gültiger Application Audience Tag" };
  }
  return { status: "ok", access: { team, aud } };
}

/**
 * Nur https, nur Schema und Domain, keine IP-Adresse (Standardport 443, kein eigener Port), ohne
 * Zugangsdaten, Pfad, Suche oder Anker. Ein abschließendes „/" wird entfernt.
 * Ergebnis ist klein geschrieben, genau so, wie Browser den Origin senden.
 */
export function parsePublicOrigin(raw: string): string | null {
  const value = raw.trim().replace(/\/$/, "");
  if (!/^https:\/\/[A-Za-z0-9.-]+$/.test(value)) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || !url.hostname.includes(".")) return null;
  if (isIP(url.hostname) !== 0) return null;
  if (url.hostname.startsWith(".") || url.hostname.endsWith(".") || url.hostname.includes("..")) return null;
  return url.origin;
}
