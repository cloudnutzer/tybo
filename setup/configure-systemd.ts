/**
 * systemd-Benutzerdienst für den Bot (Issue #207, Linux, etwa Raspberry Pi).
 *
 * Nur der Bot selbst (telegram-relay) als `tybo-telegram-relay.service` unter
 * ~/.config/systemd/user; Check-in, Briefing, Watchdog und Supabase bleiben
 * bei PM2. Keine Root-Dienste: alles läuft über `systemctl --user`, nie über
 * sudo (unter sudo fehlt XDG_RUNTIME_DIR, und der Dienst gehörte root).
 *
 * Die Dienstdatei setzt PATH selbst: ein Benutzerdienst bekommt nur
 * /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin, also weder
 * ~/.bun/bin noch ~/.local/bin (native Claude CLI). Restart=always, weil der
 * Neustart nach Antwort (bun run restart:request) den Prozess sauber mit
 * Exit 0 beendet; on-failure startete ihn dann nicht neu. Protokoll wie unter
 * launchd in logs/telegram-relay.log bzw. .error.log: das Journal eines
 * Benutzers ist auf Debian ohne die Gruppe adm oder systemd-journal oft
 * nicht lesbar.
 *
 * Linger: ohne `loginctl enable-linger <user>` startet der Benutzerdienst
 * nach einem Neustart erst mit der ersten Anmeldung. Versucht wird es ohne
 * sudo (mit polkit geht das); scheitert es an der Berechtigung, nennt der
 * Assistent den einen sudo-Befehl, statt selbst sudo aufzurufen. Andere
 * Fehler bekommen einen Prüfhinweis ohne sudo.
 *
 * Importsicher, alles, was nach außen greift, kommt über SystemdDeps (Tests:
 * Attrappen, Temp-Ordner).
 */

import { dirname, join } from "node:path";
import { BRAND } from "../src/brand";
import { SYSTEMD_UNIT_ENV } from "../src/lib/restart-request";
import { BOT_SERVICE, systemdUnit, systemdUnitFile } from "../src/lib/service-names";

export const SYSTEMD_UNIT = systemdUnit(BOT_SERVICE);
export const SYSTEMD_UNIT_FILE = systemdUnitFile(BOT_SERVICE);
/** Ordner der Benutzerdienste, wie systemd ihn sucht (für uninstall und verify) */
export const SYSTEMD_USER_DIR = join(process.env.XDG_CONFIG_HOME || join(process.env.HOME || "", ".config"), "systemd", "user");
/** Umgebungsvariable in der Dienstdatei: daran erkennt detectSupervisor() den Dienst */
export { SYSTEMD_UNIT_ENV };

export interface SystemdDeps {
  projectRoot: string;
  home: string;
  /** ~/.config/systemd/user */
  unitDir: string;
  /** /run/systemd/system: gibt es nur, wenn der Rechner mit systemd läuft */
  runDir: string;
  user: string;
  run(cmd: string[], options?: { timeoutMs?: number }): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  exists(path: string): boolean;
  writeFile(path: string, content: string): void;
  mkdir(path: string): void;
}

export function systemdUnitPath(unitDir: string): string {
  return join(unitDir, SYSTEMD_UNIT_FILE);
}

/** Läuft der Rechner mit systemd? (sagt nichts über den Benutzer-Manager) */
export function systemdBooted(deps: Pick<SystemdDeps, "runDir" | "exists">): boolean {
  return deps.exists(deps.runDir);
}

/**
 * Zustand des Diensts. „unreachable“: der Benutzer-Manager antwortet nicht
 * (keine Anmeldesitzung, über sudo oder su gestartet, XDG_RUNTIME_DIR fehlt).
 */
export type SystemdUnitState =
  | { reachable: false; fileExists: boolean }
  | { reachable: true; fileExists: boolean; loaded: boolean; active: boolean; enabled: boolean };

/** Eigenschaften aus `systemctl show` (Zeilen Name=Wert) */
export function parseShow(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

export async function systemdUnitState(deps: SystemdDeps): Promise<SystemdUnitState> {
  const fileExists = deps.exists(systemdUnitPath(deps.unitDir));
  const show = await deps.run(["systemctl", "--user", "show", SYSTEMD_UNIT_FILE, "--property=LoadState,ActiveState,UnitFileState"], { timeoutMs: 15_000 });
  if (!show.ok) return { reachable: false, fileExists };
  const p = parseShow(show.stdout);
  if (!p.LoadState) return { reachable: false, fileExists };
  return {
    reachable: true,
    fileExists,
    loaded: p.LoadState === "loaded",
    // „activating“ schließt das Warten auf den nächsten Neustart ein (auto-restart)
    active: ["active", "activating", "reloading"].includes(p.ActiveState ?? ""),
    enabled: p.UnitFileState === "enabled",
  };
}

/**
 * Pfade in der Dienstdatei: systemd liest Leerzeichen, Anführungszeichen, %
 * und $ als Syntax, ein : zerlegte PATH. Solche Pfade lehnt die Einrichtung
 * ab, statt sie halb richtig zu maskieren.
 */
export function unitPathOk(path: string): boolean {
  return /^\/[\p{L}\p{N}_.\/+@,=~-]*$/u.test(path);
}

export interface UnitInput {
  projectRoot: string;
  home: string;
  bunPath: string;
  /** Ordner der Claude CLI (CLAUDE_PATH oder gefunden); fehlt: nur die Standardorte */
  claudeDir?: string;
}

/** Inhalt der Dienstdatei; null, wenn ein Pfad darin nicht sicher geht */
export function renderSystemdUnit(input: UnitInput): string | null {
  const bunDir = dirname(input.bunPath);
  const pathDirs = [...new Set([bunDir, ...(input.claudeDir ? [input.claudeDir] : []), join(input.home, ".bun", "bin"), join(input.home, ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin"])];
  if (![input.projectRoot, input.bunPath, ...pathDirs].every(unitPathOk)) return null;
  const logs = join(input.projectRoot, "logs");
  return `# Angelegt von ${BRAND.cli} setup autostart. Nach einer Änderung:
#   systemctl --user daemon-reload && systemctl --user restart ${SYSTEMD_UNIT}
[Unit]
Description=${BRAND.name} (Telegram-Bot)
# Nie aufgeben: nach Fehlstarts (etwa ohne Netz beim Hochfahren) weiter versuchen
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=${input.projectRoot}
ExecStart=${input.bunPath} run src/bot.ts
Environment=PATH=${pathDirs.join(":")}
Environment=${SYSTEMD_UNIT_ENV}=${SYSTEMD_UNIT_FILE}
Restart=always
RestartSec=5
StandardOutput=append:${join(logs, "telegram-relay.log")}
StandardError=append:${join(logs, "telegram-relay.error.log")}

[Install]
WantedBy=default.target
`;
}

async function which(cmd: string, deps: SystemdDeps): Promise<string> {
  const r = await deps.run(["which", cmd], { timeoutMs: 10_000 });
  const path = r.ok ? r.stdout.split("\n")[0].trim() : "";
  return path.startsWith("/") ? path : "";
}

export type ConfigureResult = { ok: true } | { ok: false; reason: "no-bun" | "unsafe-path" | "write" | "reload" | "enable"; code?: string };

/**
 * Legt die Dienstdatei an (nur, wenn sie fehlt) und startet den Dienst:
 * daemon-reload, dann enable --now. claudePath: CLAUDE_PATH aus der .env.
 */
export async function installSystemdService(deps: SystemdDeps, claudePath?: string): Promise<ConfigureResult> {
  const bunPath = await which("bun", deps);
  if (!bunPath) return { ok: false, reason: "no-bun" };
  const claude = claudePath?.startsWith("/") ? claudePath : await which(claudePath || "claude", deps);
  const unit = renderSystemdUnit({ projectRoot: deps.projectRoot, home: deps.home, bunPath, claudeDir: claude ? dirname(claude) : undefined });
  if (!unit) return { ok: false, reason: "unsafe-path" };
  try {
    // systemd legt den Ordner der Protokolldatei nicht an
    deps.mkdir(join(deps.projectRoot, "logs"));
    deps.mkdir(deps.unitDir);
    deps.writeFile(systemdUnitPath(deps.unitDir), unit);
  } catch (e) {
    return { ok: false, reason: "write", code: (e as NodeJS.ErrnoException)?.code };
  }
  return startSystemdService(deps, false);
}

/** daemon-reload (wenn nötig), dann enable --now */
export async function startSystemdService(deps: SystemdDeps, loaded: boolean): Promise<ConfigureResult> {
  if (!loaded) {
    const reload = await deps.run(["systemctl", "--user", "daemon-reload"], { timeoutMs: 30_000 });
    if (!reload.ok) return { ok: false, reason: "reload" };
  }
  const enable = await deps.run(["systemctl", "--user", "enable", "--now", SYSTEMD_UNIT], { timeoutMs: 60_000 });
  return enable.ok ? { ok: true } : { ok: false, reason: "enable" };
}

/** Läuft schon, fehlt nur die Aktivierung: enable ohne --now startet nichts neu */
export async function enableSystemdService(deps: SystemdDeps): Promise<boolean> {
  return (await deps.run(["systemctl", "--user", "enable", SYSTEMD_UNIT], { timeoutMs: 30_000 })).ok;
}

// ---------------------------------------------------------------------------
// Linger
// ---------------------------------------------------------------------------

export type LingerState = "yes" | "no" | "unknown";

/** Anmeldename, wie er in Befehle darf; sonst $USER (setzt die Shell ein) */
function userArg(user: string): string {
  return /^[a-z_][a-z0-9_.-]*\$?$/i.test(user) ? user : "$USER";
}

export function lingerCommand(user: string): string {
  return `sudo loginctl enable-linger ${userArg(user)}`;
}

export function lingerCheckCommand(user: string): string {
  return `loginctl show-user ${userArg(user)} -p Linger`;
}

export async function lingerState(deps: SystemdDeps): Promise<LingerState> {
  const r = await deps.run(["loginctl", "show-user", deps.user, "--property=Linger", "--value"], { timeoutMs: 15_000 });
  if (!r.ok) return "unknown";
  const v = r.stdout.trim();
  return v === "yes" ? "yes" : v === "no" ? "no" : "unknown";
}

/**
 * Linger einschalten, ohne sudo. „needs-sudo“: loginctl lehnte wegen
 * fehlender Berechtigung ab (etwa ohne polkit); „failed“: loginctl scheiterte
 * aus einem anderen Grund (logind nicht erreichbar, Benutzer unbekannt), sudo
 * hilft dann nicht; „unverified“: lief durch, aber die Nachprüfung sagt nicht
 * „yes“.
 */
export type LingerOutcome = "already" | "enabled" | "needs-sudo" | "failed" | "unverified";

/** Fehlertexte von loginctl/polkit bei fehlender Berechtigung; die Ausgabe selbst geht nie nach außen */
const PERMISSION_DENIED = /access denied|permission denied|not authorized|interactive authentication required|operation not permitted/i;

export async function ensureLinger(deps: SystemdDeps): Promise<LingerOutcome> {
  if ((await lingerState(deps)) === "yes") return "already";
  const enable = await deps.run(["loginctl", "enable-linger", deps.user], { timeoutMs: 30_000 });
  if (!enable.ok) return PERMISSION_DENIED.test(enable.stderr) ? "needs-sudo" : "failed";
  return (await lingerState(deps)) === "yes" ? "enabled" : "unverified";
}
