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

/**
 * Supabase auf diesem Rechner (Issue #165): einmaliger Aufruf von
 * `tybo datenbank start` beim Anmelden bzw. beim Start von PM2, kein Daemon
 */
export const SUPABASE_SERVICE = "supabase";

/**
 * Startzustand und Ergebnis von tybo-supabase unter PM2 (Issue #165), relativ
 * zum Projektordner: geschrieben von scripts/run-once-and-stay.ts, gelesen von
 * setup/verify.ts. Der PM2-Eintrag bleibt auch nach einem gescheiterten
 * Start „online“, der Status allein sagt darum nichts über den Start.
 */
export const SUPABASE_START_STATE = "data/supabase-start.json";

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

/**
 * systemd-Benutzerdienste (Issue #207) heißen wie die PM2-Prozesse,
 * `tybo-<dienst>`, die Datei `tybo-<dienst>.service`.
 */
export function systemdUnit(service: string): string {
  return `${PM2_PREFIX}${service}`;
}

export function systemdUnitFile(service: string): string {
  return `${systemdUnit(service)}.service`;
}
