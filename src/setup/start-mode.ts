/**
 * Moduswahl beim Start (Issue #66, Entscheidung 0011): normaler Bot oder
 * Einrichtungsmodus im Browser.
 *
 * Seit Issue #228 (Entscheidung 0021) entscheidet die Kanalprüfung
 * (./channels.ts): normaler Start mit Telegram, mit der WebUI allein oder mit
 * beidem. Ist kein Kanal bereit (nichts eingerichtet, halbes Telegram, WebUI
 * ohne Telegram ungültig), startet statt „FATAL“ der Einrichtungsmodus: kein
 * Telegram, keine Claude-Aufrufe, nur der Assistent auf 127.0.0.1
 * (src/setup/web-mode.ts). Nie ein Abbruch mit exit(1), sonst startet
 * launchd/PM2 den Bot in Schleife. `tybo setup --web` erzwingt den Modus auch
 * bei vollständiger .env.
 *
 * Reine Funktion ohne Seiteneffekte, damit sie sich ohne src/bot.ts testen
 * lässt; bot.ts ruft sie vor der Bot-Initialisierung auf.
 */

import { checkChannels } from "./channels";
import { presentValue } from "./model";

/** Die beiden Telegram-Werte; ohne WebUI braucht der Start beide */
export const REQUIRED_START_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID"] as const;

export type StartMode =
  | { mode: "normal" }
  /** Kein Kanal bereit; message ist der Grund für Log und Terminal */
  | { mode: "setup"; reason: "missing"; missing: string[]; message: string }
  | { mode: "setup"; reason: "forced"; missing: string[] };

export interface StartModeOptions {
  /** `tybo setup --web`: Einrichtungsmodus auch bei vollständiger .env */
  forceSetup?: boolean;
}

/** Telegram-Werte, die fehlen oder nur Platzhalter sind */
export function missingStartKeys(env: Record<string, string | undefined>): string[] {
  return REQUIRED_START_KEYS.filter(name => presentValue(env, name) === undefined);
}

export function chooseStartMode(env: Record<string, string | undefined>, options: StartModeOptions = {}): StartMode {
  const missing = missingStartKeys(env);
  if (options.forceSetup) return { mode: "setup", reason: "forced", missing };
  const channels = checkChannels(env);
  if (!channels.ready) return { mode: "setup", reason: "missing", missing, message: channels.message };
  return { mode: "normal" };
}
