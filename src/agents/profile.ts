/**
 * Nutzerprofil für die Prompts (Issue #358): config/profile.md im
 * Arbeitsverzeichnis, angelegt von `tybo setup profil`.
 *
 * Gelesen wird beim ersten Zugriff, danach gilt der gemerkte Text bis zum
 * Neustart (wie bisher; eine Änderung am Profil braucht einen Neustart).
 * Fehlt die Datei oder ist sie unlesbar, ist das Profil leer.
 */
import { readFile } from "fs/promises";
import { join } from "path";

let profileRead: Promise<string> | undefined;

/** Pfad der Profildatei, relativ zum Arbeitsverzeichnis beim Aufruf */
export function userProfilePath(): string {
  return join(process.cwd(), "config", "profile.md");
}

/** Profiltext oder "" ohne Datei; gleichzeitige Aufrufe teilen sich einen Lesevorgang */
export function getUserProfile(): Promise<string> {
  profileRead ??= readFile(userProfilePath(), "utf-8").catch(() => "");
  return profileRead;
}

/** Nur für Tests: nächster Zugriff liest die Datei neu */
export function forgetUserProfile(): void {
  profileRead = undefined;
}
