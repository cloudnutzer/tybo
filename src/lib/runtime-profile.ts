/**
 * Betriebsprofil des Bot-Prozesses (Issue #350): derselbe
 * Prozess läuft auf dem eigenen Rechner (local) oder auf einem Server (server).
 * Das Profil legt fest, wie Telegram-Updates ankommen:
 *
 * - local (Standard, auch ohne TYBO_PROFILE): Polling wie bisher.
 * - server: Webhook unter /telegram. TELEGRAM_WEBHOOK_SECRET ist Pflicht
 *   (16 bis 256 Zeichen aus A-Z, a-z, 0-9, _ und -; Zeichenvorrat von Telegram, Mindestlänge von tybo).
 *   Listener auf TELEGRAM_WEBHOOK_HOST (Standard 127.0.0.1, davor ein Proxy
 *   oder Tunnel mit https) und TELEGRAM_WEBHOOK_PORT (Standard 3080; nie der
 *   Health-Port oder der Port der WebUI). Mit TELEGRAM_WEBHOOK_URL (https)
 *   trägt der Bot den Webhook beim Start selbst bei Telegram ein.
 * - peer (Issue #353, Hybrid): der eigene Rechner hinter einem Server. Kein
 *   Polling, kein Webhook-Eingriff; Updates kommen nur über POST /relay am
 *   Health-Port (src/lib/hybrid/relay-endpoint.ts). Pflicht sind
 *   GATEWAY_SECRET und eine Datenbank (Supabase, für den Herzschlag).
 *
 * Ungültige Angaben ergeben keinen Eingang, nie einen Webhook ohne Secret und
 * nie stillschweigend Polling: auf einem Server pollt sonst womöglich ein
 * zweiter Bot mit demselben Token. Zurück zum Polling geht es mit
 * TYBO_PROFILE=local; grammY löscht den Webhook beim Start des Pollings.
 */
import type { TelegramIntake } from "./telegram-runtime";
import { selectBackend } from "./store";

type Env = Record<string, string | undefined>;

export type RuntimeProfileName = "local" | "server" | "peer";

export const DEFAULT_WEBHOOK_HOST = "127.0.0.1";
export const DEFAULT_WEBHOOK_PORT = 3080;
export const WEBHOOK_PATH = "/telegram";

export interface RuntimeProfile {
  name: RuntimeProfileName;
  telegram: TelegramIntake;
}

export type RuntimeProfileResult = { ok: true; profile: RuntimeProfile } | { ok: false; name: string; reason: string };

const SECRET_PATTERN = /^[A-Za-z0-9_-]{16,256}$/;

/** Port aus der env; leer heißt Standard, sonst 1 bis 65535 oder null */
function portFrom(raw: string | undefined, fallback: number): number | null {
  const text = (raw ?? "").trim();
  if (!text) return fallback;
  if (!/^\d{1,5}$/.test(text)) return null;
  const port = Number(text);
  return port >= 1 && port <= 65535 ? port : null;
}

function publicUrlFrom(raw: string | undefined): string | null | undefined {
  const text = (raw ?? "").trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function resolveRuntimeProfile(env: Env): RuntimeProfileResult {
  const name = (env.TYBO_PROFILE ?? "").trim().toLowerCase() || "local";
  if (name === "local") return { ok: true, profile: { name, telegram: { mode: "polling" } } };
  if (name === "peer") return peerProfile(env);
  if (name !== "server") return { ok: false, name, reason: `TYBO_PROFILE "${name}" ist unbekannt (local, server oder peer)` };

  const secret = (env.TELEGRAM_WEBHOOK_SECRET ?? "").trim();
  if (!secret) return { ok: false, name, reason: "TYBO_PROFILE=server braucht TELEGRAM_WEBHOOK_SECRET" };
  if (!SECRET_PATTERN.test(secret)) {
    return { ok: false, name, reason: "TELEGRAM_WEBHOOK_SECRET muss 16 bis 256 Zeichen aus A-Z, a-z, 0-9, _ und - haben" };
  }

  const port = portFrom(env.TELEGRAM_WEBHOOK_PORT, DEFAULT_WEBHOOK_PORT);
  if (port === null) return { ok: false, name, reason: "TELEGRAM_WEBHOOK_PORT ist kein gültiger Port (1 bis 65535)" };
  const healthPort = portFrom(env.HEALTH_PORT, 3000);
  const webEnabled = (env.WEB_ENABLED ?? "").trim().toLowerCase() === "true";
  const webPort = webEnabled ? portFrom(env.WEB_PORT, 3100) : null;
  if (port === healthPort || port === webPort) {
    return { ok: false, name, reason: `TELEGRAM_WEBHOOK_PORT ${port} ist schon vergeben (Health-Port oder WebUI)` };
  }

  const publicUrl = publicUrlFrom(env.TELEGRAM_WEBHOOK_URL);
  if (publicUrl === undefined) return { ok: false, name, reason: "TELEGRAM_WEBHOOK_URL muss eine https-Adresse sein" };

  const hostname = (env.TELEGRAM_WEBHOOK_HOST ?? "").trim() || DEFAULT_WEBHOOK_HOST;
  return {
    ok: true,
    profile: { name, telegram: { mode: "webhook", webhook: { hostname, port, path: WEBHOOK_PATH, secret, publicUrl } } },
  };
}

/** Eigener Rechner im Hybrid-Betrieb: ohne Geheimnis oder Datenbank kein Eingang, nie Polling */
function peerProfile(env: Env): RuntimeProfileResult {
  const name = "peer";
  if (!(env.GATEWAY_SECRET ?? "").trim()) return { ok: false, name, reason: "TYBO_PROFILE=peer braucht GATEWAY_SECRET" };
  if (selectBackend(env) !== "supabase") {
    return { ok: false, name, reason: "TYBO_PROFILE=peer braucht eine Datenbank (SUPABASE_URL und SUPABASE_SERVICE_ROLE_KEY)" };
  }
  return { ok: true, profile: { name, telegram: { mode: "relay" } } };
}
