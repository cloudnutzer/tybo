/**
 * Push-Schlüssel beim Start des Bots und in `tybo setup webui` (Issue #225).
 * Adapter wie ./bot-keys: schreibt die .env über src/lib/env-file.ts und wird
 * nur von src/bot.ts und dem Einrichtungsschritt geladen, nie vom Web-Server
 * selbst (der bekommt fertige Schlüssel über startWebUi).
 *
 * - Beide Schlüssel da und gültig: benutzen, nichts schreiben.
 * - Beide fehlen: einmal mit WebCrypto erzeugen und gemeinsam in die .env
 *   schreiben, nur wenn unter der Sperre der .env noch keiner da ist
 *   (addEnvValuesIfMissing). Starten Bot und Einrichtung gleichzeitig, gewinnt
 *   der erste; der zweite liest dessen Schlüssel. Log: „Push-Schlüssel
 *   erzeugt", nie ein Wert.
 * - Nur einer da oder ungültig: nichts ersetzen, Push bleibt aus, Log mit
 *   Hinweis. Wer neu anfangen will, löscht beide Zeilen aus der .env.
 * - Schreiben scheitert: Push bleibt aus (Schlüssel nur im Speicher würden
 *   nach dem nächsten Start nicht mehr zu den Abos passen).
 *
 * Die .env-Sicherungen unter data/backups (0600, von setEnvValue und
 * updateEnvValues) enthalten die Schlüssel wie alle anderen Werte der .env;
 * sonst stehen sie nirgends in data/.
 */

import { join } from "node:path";
import { addEnvValuesIfMissing, readEnvFile, type EnvWriteOptions } from "../lib/env-file";
import { catalogGroup } from "./key-catalog";
import type { PushConfig } from "./push-api";
import { DEFAULT_PUSH_SUBJECT, generateVapidKeys, PUSH_ENV, validateVapidKeys, validPushSubject, type VapidKeys } from "./push";

type Env = Record<string, string | undefined>;

export interface EnsurePushKeysOptions {
  envPath: string;
  backupDir?: string;
  io?: EnvWriteOptions["io"];
  now?: () => Date;
  log?: (message: string) => void;
  /** Nur für Tests: feste Schlüssel statt neuer */
  generate?: () => Promise<VapidKeys>;
}

export type EnsurePushKeysResult =
  | { status: "ok"; keys: VapidKeys; created: boolean }
  | { status: "invalid"; reason: string }
  | { status: "error"; reason: string };

export const PUSH_KEY_TEXT = {
  created: "Push-Schlüssel erzeugt",
  incomplete: `Push aus: in der .env steht nur einer von ${PUSH_ENV.publicKey} und ${PUSH_ENV.privateKey}. Beide Zeilen löschen, dann legt tybo beim nächsten Start neue an (bisherige Geräte müssen Benachrichtigungen dann neu einschalten).`,
  invalid: `Push aus: ${PUSH_ENV.publicKey} und ${PUSH_ENV.privateKey} passen nicht zusammen oder sind kein P-256-Schlüsselpaar. Beide Zeilen löschen, dann legt tybo beim nächsten Start neue an.`,
  writeFailed: "Push aus: Push-Schlüssel ließen sich nicht in die .env schreiben",
  subject: `${PUSH_ENV.subject} ist weder mailto: noch https:, benutze ${DEFAULT_PUSH_SUBJECT}`,
} as const;

function pick(values: Env): { publicKey: string; privateKey: string } {
  return { publicKey: (values[PUSH_ENV.publicKey] ?? "").trim(), privateKey: (values[PUSH_ENV.privateKey] ?? "").trim() };
}

async function check(found: { publicKey: string; privateKey: string }): Promise<EnsurePushKeysResult | null> {
  if (!found.publicKey && !found.privateKey) return null;
  if (!found.publicKey || !found.privateKey) return { status: "invalid", reason: PUSH_KEY_TEXT.incomplete };
  if (!(await validateVapidKeys(found))) return { status: "invalid", reason: PUSH_KEY_TEXT.invalid };
  return { status: "ok", keys: found, created: false };
}

/** Liest die Schlüssel aus der .env und legt sie an, wenn beide fehlen. Wirft nie. */
export async function ensurePushKeys(options: EnsurePushKeysOptions): Promise<EnsurePushKeysResult> {
  const log = options.log ?? (() => {});
  let file: Record<string, string>;
  try {
    file = await readEnvFile(options.envPath);
  } catch (e) {
    return { status: "error", reason: `${PUSH_KEY_TEXT.writeFailed} (${e instanceof Error ? e.name : typeof e})` };
  }
  const existing = await check(pick(file));
  if (existing) return existing;

  const keys = await (options.generate ?? generateVapidKeys)();
  let written: boolean;
  try {
    const result = await addEnvValuesIfMissing(
      options.envPath,
      [
        [PUSH_ENV.publicKey, keys.publicKey],
        [PUSH_ENV.privateKey, keys.privateKey],
      ],
      { groupOf: catalogGroup, backupDir: options.backupDir, io: options.io, now: options.now }
    );
    written = result.changed;
  } catch (e) {
    return { status: "error", reason: `${PUSH_KEY_TEXT.writeFailed} (${e instanceof Error ? e.name : typeof e})` };
  }
  if (written) {
    log(PUSH_KEY_TEXT.created);
    return { status: "ok", keys, created: true };
  }
  // Jemand anderes war schneller: dessen Schlüssel gelten
  let after: Record<string, string>;
  try {
    after = await readEnvFile(options.envPath);
  } catch (e) {
    return { status: "error", reason: `${PUSH_KEY_TEXT.writeFailed} (${e instanceof Error ? e.name : typeof e})` };
  }
  return (await check(pick(after))) ?? { status: "error", reason: PUSH_KEY_TEXT.writeFailed };
}

/** Kontakt aus WEB_PUSH_SUBJECT, sonst https://<BRAND.domain> */
export function pushSubject(env: Env, log: (message: string) => void = () => {}): string {
  const raw = (env[PUSH_ENV.subject] ?? "").trim();
  if (!raw) return DEFAULT_PUSH_SUBJECT;
  if (validPushSubject(raw)) return raw;
  log(PUSH_KEY_TEXT.subject);
  return DEFAULT_PUSH_SUBJECT;
}

export interface PrepareBotPushOptions {
  /** Standard: .env im Arbeitsverzeichnis, wie loadEnv in src/bot.ts */
  envPath?: string;
  backupDir?: string;
  io?: EnvWriteOptions["io"];
  log?: (message: string) => void;
  generate?: () => Promise<VapidKeys>;
}

/**
 * Für src/bot.ts vor startWebUi: nur mit eingeschalteter WebUI. Stehen beide
 * Schlüssel schon in der Umgebung, zählen die (ohne Schreiben); sonst die .env.
 * null heißt: Push aus (Grund steht im Log). Wirft nie.
 */
export async function prepareBotPush(env: Env, options: PrepareBotPushOptions = {}): Promise<PushConfig | null> {
  const log = options.log ?? ((m: string) => console.log(`[web] ${m}`));
  if ((env.WEB_ENABLED ?? "").trim().toLowerCase() !== "true") return null;
  const fromEnv = await check(pick(env));
  let result: EnsurePushKeysResult;
  if (fromEnv?.status === "ok") {
    result = fromEnv;
  } else {
    result = await ensurePushKeys({
      envPath: options.envPath ?? join(process.cwd(), ".env"),
      backupDir: options.backupDir,
      io: options.io,
      log,
      generate: options.generate,
    });
  }
  if (result.status !== "ok") {
    log(result.reason);
    return null;
  }
  // Mit Telegram sind Meldungen auf neuen Geräten standardmäßig aus (Issue #226)
  return { keys: result.keys, subject: pushSubject(env, log), telegram: !!(env.TELEGRAM_BOT_TOKEN ?? "").trim() };
}
