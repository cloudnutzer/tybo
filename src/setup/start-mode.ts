/**
 * Moduswahl beim Start (Issue #66, Entscheidung 0011): normaler Bot oder
 * Einrichtungsmodus im Browser.
 *
 * Der normale Start braucht beide Telegram-Pflichtwerte. Fehlt einer (leer
 * oder noch der Platzhalter aus .env.example), startet statt „FATAL“ der
 * Einrichtungsmodus: kein Telegram, keine Claude-Aufrufe, nur der Assistent
 * auf 127.0.0.1 (src/setup/web-mode.ts). `tybo setup --web` erzwingt den
 * Modus auch bei vollständiger .env.
 *
 * Reine Funktion ohne Seiteneffekte, damit sie sich ohne src/bot.ts testen
 * lässt; bot.ts ruft sie vor der Bot-Initialisierung auf.
 */

import { presentValue } from "./model";

/** Ohne diese Werte startet der Bot nicht (src/bot.ts) */
export const REQUIRED_START_KEYS = ["TELEGRAM_BOT_TOKEN", "TELEGRAM_USER_ID"] as const;

export type StartMode =
  | { mode: "normal" }
  | { mode: "setup"; reason: "missing"; missing: string[] }
  | { mode: "setup"; reason: "forced"; missing: string[] };

export interface StartModeOptions {
  /** `tybo setup --web`: Einrichtungsmodus auch bei vollständiger .env */
  forceSetup?: boolean;
}

/** Pflichtwerte, die fehlen oder nur Platzhalter sind */
export function missingStartKeys(env: Record<string, string | undefined>): string[] {
  return REQUIRED_START_KEYS.filter(name => presentValue(env, name) === undefined);
}

export function chooseStartMode(env: Record<string, string | undefined>, options: StartModeOptions = {}): StartMode {
  const missing = missingStartKeys(env);
  if (options.forceSetup) return { mode: "setup", reason: "forced", missing };
  if (missing.length) return { mode: "setup", reason: "missing", missing };
  return { mode: "normal" };
}
