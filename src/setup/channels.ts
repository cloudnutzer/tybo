/**
 * Kanalprüfung (Issue #228, Entscheidung 0021): tybo braucht mindestens einen
 * Kanal, Telegram oder die WebUI. Eine reine Funktion für alle, die das
 * wissen müssen: Start (./start-mode.ts), Einrichtung (Terminal, Browser,
 * POST /api/setup/finish) und setup:verify.
 *
 * Regeln:
 * - Telegram ok: TELEGRAM_BOT_TOKEN und TELEGRAM_USER_ID gesetzt, kein
 *   Platzhalter (presentValue), Nutzer-ID eine Zahl wie in telegramConfigured.
 *   fehlt: beide leer oder Platzhalter. halb: nur einer da oder Nutzer-ID
 *   ungültig.
 * - WebUI genau nach loadWebConfig: ok, aus (WEB_ENABLED nicht true) oder
 *   ungültig (Passwort, Port, WEB_PUBLIC_ORIGIN, Access-Werte).
 * - Bereit: Telegram ok, oder WebUI ok und Telegram fehlt. Halbes Telegram ist
 *   nie bereit, auch nicht mit gültiger WebUI: sonst liefe der Bot mit einem
 *   Tippfehler in der .env still ohne Telegram.
 */

import { BRAND } from "../brand";
import { isTelegramUserId } from "../lib/channels";
import { loadWebConfig } from "../web/config";
import { presentValue } from "./model";

type Env = Record<string, string | undefined>;

export type TelegramChannelState = "ok" | "fehlt" | "halb";
export type WebChannelState = "ok" | "aus" | "ungültig";

export interface ChannelCheck {
  telegram: { state: TelegramChannelState; reason: string };
  webui: { state: WebChannelState; reason: string };
  /** Mindestens ein Kanal eingerichtet und kein halbes Telegram */
  ready: boolean;
  /** Ein Satz: warum nicht bereit bzw. welche Kanäle laufen */
  message: string;
}

/** Satz, wenn kein Kanal eingerichtet ist */
export const NO_CHANNEL_MESSAGE = `Richte Telegram oder die WebUI ein, sonst erreicht dich ${BRAND.name} nirgends.`;

/** Satz bei halbem Telegram, mit Grund */
export function halfTelegramMessage(reason: string): string {
  return `Telegram halb eingerichtet: ${reason}. Beide Werte setzen oder beide entfernen.`;
}

function telegramChannel(env: Env): ChannelCheck["telegram"] {
  const token = presentValue(env, "TELEGRAM_BOT_TOKEN");
  const user = presentValue(env, "TELEGRAM_USER_ID");
  if (!token && !user) return { state: "fehlt", reason: "TELEGRAM_BOT_TOKEN und TELEGRAM_USER_ID fehlen" };
  if (!token) return { state: "halb", reason: "TELEGRAM_USER_ID ist gesetzt, TELEGRAM_BOT_TOKEN fehlt" };
  if (!user) return { state: "halb", reason: "TELEGRAM_BOT_TOKEN ist gesetzt, TELEGRAM_USER_ID fehlt" };
  if (!isTelegramUserId(user)) return { state: "halb", reason: "TELEGRAM_USER_ID ist keine Zahl" };
  return { state: "ok", reason: "Telegram eingerichtet" };
}

function webChannel(env: Env): ChannelCheck["webui"] {
  const web = loadWebConfig(env);
  if (web.status === "ok") return { state: "ok", reason: "WebUI eingerichtet" };
  if (web.status === "disabled") return { state: "aus", reason: "WEB_ENABLED ist nicht true" };
  return { state: "ungültig", reason: web.reason };
}

/** Kurzform für den Gesamtstatus der Einrichtung (OverallChannels in ./model.ts) */
export function overallChannels(env: Env): { ready: boolean; message: string; telegram: boolean; webui: boolean } {
  const c = checkChannels(env);
  return { ready: c.ready, message: c.message, telegram: c.telegram.state === "ok", webui: c.webui.state === "ok" };
}

export function checkChannels(env: Env): ChannelCheck {
  const telegram = telegramChannel(env);
  const webui = webChannel(env);
  if (telegram.state === "halb") return { telegram, webui, ready: false, message: halfTelegramMessage(telegram.reason) };
  if (telegram.state === "ok") {
    const message = webui.state === "ok" ? "Telegram und WebUI eingerichtet." : "Telegram eingerichtet.";
    return { telegram, webui, ready: true, message };
  }
  if (webui.state === "ok") return { telegram, webui, ready: true, message: "WebUI eingerichtet, Telegram nicht." };
  if (webui.state === "ungültig") {
    return { telegram, webui, ready: false, message: `WebUI falsch eingerichtet: ${webui.reason}. ${NO_CHANNEL_MESSAGE}` };
  }
  return { telegram, webui, ready: false, message: NO_CHANNEL_MESSAGE };
}

/**
 * Adresse der WebUI auf diesem Rechner (für Endtexte), null wenn die WebUI
 * nicht ok ist. Host und Port aus der geprüften Konfiguration (loadWebConfig):
 * bei „alle Adressen“ (0.0.0.0, ::) 127.0.0.1, sonst der eingetragene Host,
 * IPv6 in eckigen Klammern (::1 wird zu http://[::1]:<Port>)
 */
export function webLocalUrl(env: Env): string | null {
  const web = loadWebConfig(env);
  if (web.status !== "ok") return null;
  const { host, port } = web.config;
  const shown = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
  return `http://${shown}:${port}`;
}

/** Wie man tybo nach der Einrichtung erreicht, passend zu den eingerichteten Kanälen */
export function reachText(channels: { telegram: boolean; webui: boolean }, webUrl: string | null): string {
  const telegram = channels.telegram;
  const web = channels.webui && webUrl;
  if (telegram && web) return `Schreib deinem Bot in Telegram oder öffne die WebUI unter ${webUrl}.`;
  if (web) return `Öffne die WebUI unter ${webUrl}.`;
  if (telegram) return "Schreib deinem Bot in Telegram.";
  return NO_CHANNEL_MESSAGE;
}
