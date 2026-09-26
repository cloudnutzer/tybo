/**
 * Namen der Hintergrunddienste (Entscheidung 0015, Issue #101, #142).
 *
 * launchd-Labels heißen `ai.tybo.<dienst>`, PM2-Prozesse `tybo-<dienst>`.
 * Dienste anderer Namen erkennt und fasst tybo nie an. Log-Dateien und
 * Datenordner behalten ihre Namen.
 */

export const LAUNCHD_PREFIX = "ai.tybo.";
export const PM2_PREFIX = "tybo-";

/** Dienst des Bots selbst */
export const BOT_SERVICE = "telegram-relay";

export function launchdLabel(service: string): string {
  return `${LAUNCHD_PREFIX}${service}`;
}

export function pm2Name(service: string): string {
  return `${PM2_PREFIX}${service}`;
}

/** Letzte Spalte einer Zeile aus `launchctl list` (das Label) */
function lineLabel(line: string): string {
  return line.trim().split(/\s+/).pop() ?? "";
}

/**
 * Ist das Label in der Ausgabe von `launchctl list` geladen? Verglichen wird
 * exakt mit der letzten Spalte, damit `ai.tybo.telegram-relay-alt` nicht als
 * `ai.tybo.telegram-relay` zählt.
 */
export function labelInLaunchctlList(stdout: string, label: string): boolean {
  return stdout.split("\n").some(line => lineLabel(line) === label);
}

/**
 * Zeile eines Diensts in `launchctl list` unter ai.tybo.<dienst> (für
 * setup/verify.ts). Exakter Vergleich der letzten Spalte; null, wenn er
 * nicht geladen ist.
 */
export function findLaunchctlLine(stdout: string, service: string): string | null {
  const label = launchdLabel(service);
  return stdout.split("\n").find(line => lineLabel(line) === label) ?? null;
}

/** Plist eines tybo-Diensts (für setup/uninstall.ts) */
export function isServicePlist(fileName: string): boolean {
  return fileName.startsWith(LAUNCHD_PREFIX) && fileName.endsWith(".plist");
}

/** Läuft in `launchctl list` irgendein tybo-Dienst? (für setup/upgrade.ts) */
export function hasServiceLabels(stdout: string): boolean {
  return stdout.split("\n").some(line => lineLabel(line).startsWith(LAUNCHD_PREFIX));
}
