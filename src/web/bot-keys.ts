/**
 * Echte Quelle der Schlüssel-API (Issue #62) für src/bot.ts: liest und
 * schreibt die .env über src/lib/env-file.ts (Sicherung, atomar, 0600,
 * Sperre). Die Datei ist dieselbe, die bot.ts beim Start lädt:
 * join(process.cwd(), ".env"), bewusst nicht GO_PROJECT_ROOT. web:dev und
 * Demo nutzen createDemoKeys aus ./demo, Tests reichen eine eigene Datei herein.
 */

import { join } from "node:path";
import { deleteEnvValue, readEnvFile, setEnvValue, type EnvWriteOptions } from "../lib/env-file";
import { catalogGroup } from "./key-catalog";
import { KEY_EDIT_SWITCH, type KeysPort } from "./keys";

type Env = Record<string, string | undefined>;

export interface BotKeysOptions {
  /** Standard: .env im Arbeitsverzeichnis, wie loadEnv in src/bot.ts */
  envPath?: string;
  /** Standard: data/backups neben der .env */
  backupDir?: string;
  io?: EnvWriteOptions["io"];
}

export function defaultEnvPath(cwd = process.cwd()): string {
  return join(cwd, ".env");
}

export function createBotKeys(env: Env = process.env, options: BotKeysOptions = {}): KeysPort {
  const path = options.envPath ?? defaultEnvPath();
  // Der Schalter zählt so, wie er beim Start geladen wurde
  const atStart = (env[KEY_EDIT_SWITCH] ?? "").trim().toLowerCase() === "true";
  const write: EnvWriteOptions = { groupOf: catalogGroup, backupDir: options.backupDir, io: options.io };
  return {
    read: () => readEnvFile(path),
    async set(name, value) {
      await setEnvValue(path, name, value, write);
    },
    async remove(name) {
      return (await deleteEnvValue(path, name, write)).changed;
    },
    running: () => env,
    editEnabledAtStart: () => atStart,
  };
}
