/**
 * Lokaler Schlüssel für den Terminal-Zugang (Issue #59, Entscheidung 0010).
 *
 * Der Web-Server legt bei jedem Start einen neuen zufälligen Schlüssel
 * (32 Byte) in data/cli-token ab, Rechte 0600, atomar über eine temporäre
 * Datei. Beim geordneten Stopp wird er ungültig und die Datei gelöscht, aber
 * nur, wenn sie noch diesen Schlüssel enthält (ein neuerer Server behält
 * seinen). Nach SIGKILL bleibt die Datei liegen; sie gilt dann nichts mehr,
 * weil nur der Schlüssel im Speicher des laufenden Servers zählt.
 *
 * Gültig ist der Schlüssel nur mit einer Verbindung von 127.0.0.1 oder ::1
 * (isLoopbackAddress); die Adresse kommt immer aus der Verbindung selbst,
 * nie aus Host- oder Forwarded-Kopfzeilen.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const CLI_TOKEN_FILE_NAME = "cli-token";

/** data/cli-token im Projekt des Bots (wie data/web-sessions.json) */
export function defaultCliTokenFile(root: string = process.env.GO_PROJECT_ROOT || process.cwd()): string {
  return join(root, "data", CLI_TOKEN_FILE_NAME);
}

/** Genau die Loopback-Adressen; ::ffff:127.0.0.1 ist 127.0.0.1 auf einem IPv6-Socket (WEB_HOST=::) */
export function isLoopbackAddress(address: string | null | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

/**
 * Liest „Authorization: Bearer <schlüssel>".
 * - null: kein Bearer-Schema (keine Kopfzeile, Basic usw.), also keine Terminal-Anfrage
 * - { token: null }: Bearer-Schema, aber fehlerhaft („Bearer", „Bearer a b"); gilt als
 *   gescheiterte Terminal-Anmeldung, nicht als Browser-Anfrage
 * - { token }: Bearer mit genau einem Wert
 */
export function parseBearer(header: string | null | undefined): { token: string | null } | null {
  const value = header ?? "";
  if (!/^Bearer(?:[ \t]|$)/i.test(value)) return null;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(value);
  return { token: m ? m[1] : null };
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

export interface CliToken {
  /** Zeitkonstanter Vergleich (beide Seiten gehasht); nach remove() immer false */
  matches(value: string | null | undefined): boolean;
  isActive(): boolean;
  /** Kennung für Live-Verbindungen des Terminals, enthält den Schlüssel nicht */
  readonly sessionId: string;
  /** Macht den Schlüssel ungültig und löscht die Datei, wenn sie noch ihn enthält */
  remove(): Promise<void>;
}

/** Schreibt einen neuen Schlüssel nach `file` (Rechte 0600) und gibt ihn als Prüfer zurück. */
export async function createCliToken(file: string): Promise<CliToken> {
  const token = randomBytes(32).toString("base64url");
  const hash = sha256(token);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, token, { mode: 0o600, flag: "wx" });
    await chmod(tmp, 0o600);
    await rename(tmp, file);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
  let active = true;
  return {
    sessionId: `cli:${createHash("sha256").update(`cli-session:${token}`).digest("hex")}`,
    matches(value) {
      if (!active || typeof value !== "string" || !value) return false;
      return timingSafeEqual(sha256(value), hash);
    },
    isActive: () => active,
    async remove() {
      active = false;
      try {
        if ((await readFile(file, "utf8")).trim() === token) await unlink(file);
      } catch {
        // Schon weg oder nicht lesbar: nichts zu tun
      }
    },
  };
}

/** Für das Terminal: gespeicherter Schlüssel oder null, wenn die Datei fehlt oder leer ist */
export async function readCliToken(file: string): Promise<string | null> {
  try {
    const value = (await readFile(file, "utf8")).trim();
    return value || null;
  } catch {
    return null;
  }
}
