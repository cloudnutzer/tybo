/**
 * Zuletzt genutztes Gespräch im Terminal-Chat (Issue #60): ~/.config/tybo/state.json,
 * Ordner 0700, Datei 0600, atomar über eine temporäre Datei. Enthält nur die
 * Gesprächs-ID, keinen Schlüssel. Fehlt die Datei oder ist sie kaputt, gilt
 * sie als leer; Schreibfehler halten den Chat nicht auf. Der Ordner heißt
 * wie der Befehl (BRAND.cli, Issue #142); ein früherer Ordner wird nicht
 * gelesen.
 */

import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { BRAND } from "../brand";

export interface TyboState {
  conversationId?: string;
}

/** Datei im Konfigurationsordner; dev: eigene Datei für web:dev, damit der echte Stand bleibt */
export function stateFile(home: string, dev = false): string {
  return join(home, ".config", BRAND.cli, dev ? "state-dev.json" : "state.json");
}

const ID_PATTERN = /^[A-Za-z0-9-]{1,64}$/;

export async function loadState(file: string): Promise<TyboState> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const id = parsed?.conversationId;
    return typeof id === "string" && ID_PATTERN.test(id) ? { conversationId: id } : {};
  } catch {
    return {};
  }
}

export async function saveState(file: string, state: TyboState): Promise<boolean> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(tmp, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    await rename(tmp, file);
    return true;
  } catch {
    await unlink(tmp).catch(() => {});
    return false;
  }
}
