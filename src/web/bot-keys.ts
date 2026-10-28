/**
 * Echte Quelle der Schlüssel-API (Issue #62) für src/bot.ts: liest und
 * schreibt die .env über src/lib/env-file.ts (Sicherung, atomar, 0600,
 * Sperre). Die Datei ist dieselbe, die bot.ts beim Start lädt:
 * join(process.cwd(), ".env"), bewusst nicht GO_PROJECT_ROOT; im Release
 * von deploy.sh deren Ziel im Projektordner (defaultEnvPath). web:dev und
 * Demo nutzen createDemoKeys aus ./demo, Tests reichen eine eigene Datei herein.
 */

import { lstatSync, readlinkSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { deleteEnvValue, readEnvFile, setEnvValue, type EnvWriteOptions } from "../lib/env-file";
import { catalogGroup } from "./key-catalog";
import { KEY_EDIT_SWITCH, type KeysPort } from "./keys";

type Env = Record<string, string | undefined>;

export interface BotKeysOptions {
  /** Standard: defaultEnvPath(process.cwd(), env) */
  envPath?: string;
  /** Standard: data/backups neben der .env */
  backupDir?: string;
  io?: EnvWriteOptions["io"];
}

/**
 * Schreibpfad der .env: die Datei, die loadEnv in src/bot.ts liest. In einem
 * Release von deploy.sh (Issue #352) ist <cwd>/.env ein Link auf
 * DEPLOY_DIR/.env; dann wird diese echte Datei im Projektordner geschrieben
 * und übersteht jeden Deploy. Nur wenn der Link genau dorthin zeigt und das
 * Ziel selbst eine Datei ist (kein Link). Sonst bleibt es bei <cwd>/.env,
 * und src/lib/env-file.ts lehnt einen Link dort weiter ab.
 */
export function defaultEnvPath(cwd = process.cwd(), env: Env = process.env): string {
  const local = join(cwd, ".env");
  const project = (env.DEPLOY_DIR ?? "").trim();
  if (!project || !isAbsolute(project)) return local;
  const target = resolve(project, ".env");
  try {
    if (!lstatSync(local).isSymbolicLink()) return local;
    if (resolve(cwd, readlinkSync(local)) !== target) return local;
    if (!lstatSync(target).isFile()) return local;
  } catch {
    return local;
  }
  return target;
}

export function createBotKeys(env: Env = process.env, options: BotKeysOptions = {}): KeysPort {
  const path = options.envPath ?? defaultEnvPath(process.cwd(), env);
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
