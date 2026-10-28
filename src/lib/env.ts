/**
 * Lädt die .env des Projekts in process.env, ohne Fremdpaket.
 *
 * Den Inhalt zerlegt parseEnvContent aus ./env-file, derselbe Parser wie in
 * scripts/tybo.ts und beim Schreiben von Schlüsseln: Was dort geschrieben
 * wird, kommt hier unverändert wieder an (Issue #62, Anführungszeichen).
 *
 * Werte aus der Datei gewinnen gegen die vorhandene Umgebung. Fehlt die
 * Datei oder lässt sie sich nicht lesen, bleibt die Umgebung, wie sie ist.
 * Tests: tests/env-loader.test.ts.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnvContent } from "./env-file";

/**
 * Wurzel des Projekts, einmal beim Import bestimmt: GO_PROJECT_ROOT, wenn
 * gesetzt und nicht leer, sonst das Arbeitsverzeichnis
 */
export const PROJECT_ROOT: string = process.env.GO_PROJECT_ROOT ? process.env.GO_PROJECT_ROOT : process.cwd();

async function readOrEmpty(file: string): Promise<string> {
  try {
    return await readFile(file, "utf-8");
  } catch {
    return "";
  }
}

/** Liest die .env (Standard: PROJECT_ROOT/.env) und setzt jeden Eintrag in process.env */
export async function loadEnv(file?: string): Promise<void> {
  const entries = parseEnvContent(await readOrEmpty(file || join(PROJECT_ROOT, ".env")));
  Object.assign(process.env, entries);
}
