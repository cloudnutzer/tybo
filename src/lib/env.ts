/**
 * Go - Environment Loader
 *
 * Loads .env file from project root. No external dependencies.
 * Parsing (quotes included) lives in ./env-file, shared with scripts/tybo.ts
 * and the key writer, so written values load back unchanged (Issue #62).
 */

import { readFile } from "fs/promises";
import { join } from "path";
import { parseEnvContent } from "./env-file";

const PROJECT_ROOT = process.env.GO_PROJECT_ROOT || process.cwd();

export async function loadEnv(envPath?: string): Promise<void> {
  const path = envPath || join(PROJECT_ROOT, ".env");
  const content = await readFile(path, "utf-8").catch(() => "");

  for (const [key, value] of Object.entries(parseEnvContent(content))) {
    process.env[key] = value;
  }
}

export function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function optionalEnv(key: string, defaultValue: string = ""): string {
  return process.env[key] || defaultValue;
}

export { PROJECT_ROOT };
