/**
 * systemd-Benutzerdienst für den Bot (Issue #207, Linux, etwa Raspberry Pi).
 *
 * Nur der Bot selbst (telegram-relay) als `tybo-telegram-relay.service` unter
 * ~/.config/systemd/user; Check-in, Briefing und Supabase bleiben bei PM2.
 * Keine Root-Dienste: alles läuft über `systemctl --user`, nie über sudo
 * (unter sudo fehlt XDG_RUNTIME_DIR, und der Dienst gehörte root).
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

import { randomUUID } from "node:crypto";
import { realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  /**
   * Ersetzt eine bestehende Datei atomar (replaceFileAtomic): erst vollständig
   * in eine temporäre Datei daneben, dann umbenennen. Scheitert es, bleibt
   * die alte Datei unverändert.
   */
  replaceFile(path: string, content: string): void;
  mkdir(path: string): void;
}

/** Dateizugriffe von replaceFileAtomic, in Tests ersetzbar */
export interface ReplaceFs {
  realpath(path: string): string;
  mode(path: string): number;
  write(path: string, content: string, mode: number): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
}

const NODE_REPLACE_FS: ReplaceFs = {
  realpath: path => realpathSync(path),
  mode: path => statSync(path).mode & 0o7777,
  // wx: nie eine fremde Datei gleichen Namens überschreiben
  write: (path, content, mode) => writeFileSync(path, content, { encoding: "utf-8", mode, flag: "wx" }),
  rename: (from, to) => renameSync(from, to),
  unlink: path => unlinkSync(path),
};

/**
 * Ersetzt eine bestehende Datei, ohne sie je halb geschrieben zu hinterlassen
 * (Issue #561): Der neue Inhalt geht vollständig in eine temporäre Datei im
 * selben Ordner (gleiche Rechte), erst danach ersetzt rename die alte Datei in
 * einem Schritt. Scheitert das Schreiben mittendrin (voller Datenträger,
 * fehlende Rechte), bleibt die alte Datei Zeichen für Zeichen erhalten und die
 * temporäre wird entfernt. Ein Symlink bleibt ein Symlink: ersetzt wird sein
 * Ziel. Die temporäre Datei endet auf .tmp, systemd lädt sie also nie als
 * Dienst.
 */
export function replaceFileAtomic(path: string, content: string, fs: ReplaceFs = NODE_REPLACE_FS): void {
  const target = fs.realpath(path);
  const mode = fs.mode(target);
  const temp = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    fs.write(temp, content, mode);
    fs.rename(temp, target);
  } catch (e) {
    try {
      fs.unlink(temp);
    } catch {
      // nie angelegt oder schon weg
    }
    throw e;
  }
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
  | { reachable: true; fileExists: boolean; loaded: boolean; active: boolean; enabled: boolean; killMode?: string };

/** Eigenschaften aus `systemctl show` (Zeilen Name=Wert) */
export function parseShow(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out;
}

export async function systemdUnitState(deps: Pick<SystemdDeps, "unitDir" | "exists" | "run">): Promise<SystemdUnitState> {
  const fileExists = deps.exists(systemdUnitPath(deps.unitDir));
  const show = await deps.run(["systemctl", "--user", "show", SYSTEMD_UNIT_FILE, "--property=LoadState,ActiveState,UnitFileState,KillMode"], { timeoutMs: 15_000 });
  if (!show.ok) return { reachable: false, fileExists };
  const p = parseShow(show.stdout);
  if (!p.LoadState) return { reachable: false, fileExists };
  const loaded = p.LoadState === "loaded";
  return {
    reachable: true,
    fileExists,
    loaded,
    // „activating“ schließt das Warten auf den nächsten Neustart ein (auto-restart)
    active: ["active", "activating", "reloading"].includes(p.ActiveState ?? ""),
    enabled: p.UnitFileState === "enabled",
    // Wirksamer Wert samt Drop-ins, wie systemd ihn geladen hat; nur bei geladenem Dienst aussagekräftig
    ...(loaded && p.KillMode ? { killMode: p.KillMode } : {}),
  };
}

/**
 * Beendet der geladene Dienst beim Neustart auch die Hintergrund-Jobs? true
 * nur, wenn systemd einen anderen Wert als KillMode=process meldet; unbekannt
 * (nicht geladen, Wert fehlt) zählt nicht als veraltet.
 */
export function killModeOutdated(state: SystemdUnitState): boolean {
  return state.reachable && state.killMode !== undefined && state.killMode !== KILL_MODE;
}

/**
 * Pfade in der Dienstdatei: systemd liest Leerzeichen, Anführungszeichen, %
 * und $ als Syntax, ein : zerlegte PATH. Solche Pfade lehnt die Einrichtung
 * ab, statt sie halb richtig zu maskieren.
 */
export function unitPathOk(path: string): boolean {
  return /^\/[\p{L}\p{N}_.\/+@,=~-]*$/u.test(path);
}

/**
 * KillMode=process (Issue #561): Beim Stoppen oder Neustarten beendet systemd
 * nur den Bot selbst. Ohne die Zeile gilt control-group, und systemd beendet
 * alle Prozesse der Kontrollgruppe, auch die Wächter der Hintergrund-Jobs
 * (eine eigene Prozess-Session verlässt die Kontrollgruppe nicht). Die
 * Motor-Aufrufe beendet der Bot beim Herunterfahren selbst und wartet auf ihr
 * Ende (src/app/bot-shutdown.ts). Folge: Nach einem Absturz des Bots bleiben
 * auch seine übrigen Kindprozesse stehen, bis sie von selbst enden.
 * Nachweis auf echtem systemd: scripts/systemd-job-proof.ts.
 */
export const KILL_MODE = "process";
export const KILL_MODE_LINE = `KillMode=${KILL_MODE}`;
const KILL_MODE_COMMENT = "# Nur den Bot beenden: Hintergrund-Jobs laufen über einen Neustart hinweg weiter";

export interface UnitInput {
  projectRoot: string;
  home: string;
  bunPath: string;
  /** Ordner der Claude CLI (CLAUDE_PATH oder gefunden); fehlt: nur die Standardorte */
  claudeDir?: string;
  /**
   * Ordner von Codex (CODEX_PATH oder gefunden, Issue #566); fehlt: nur die
   * Standardorte. Ein Server nur mit Codex fände sonst `codex` nicht, wenn
   * es etwa über npm in ~/.npm-global/bin oder unter nvm liegt.
   */
  codexDir?: string;
}

/** Inhalt der Dienstdatei; null, wenn ein Pfad darin nicht sicher geht */
export function renderSystemdUnit(input: UnitInput): string | null {
  const bunDir = dirname(input.bunPath);
  const pathDirs = [...new Set([bunDir, ...(input.claudeDir ? [input.claudeDir] : []), ...(input.codexDir ? [input.codexDir] : []), join(input.home, ".bun", "bin"), join(input.home, ".local", "bin"), "/usr/local/bin", "/usr/bin", "/bin"])];
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
${KILL_MODE_COMMENT}
${KILL_MODE_LINE}
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
 * daemon-reload, dann enable --now. claudePath und codexPath: CLAUDE_PATH
 * und CODEX_PATH aus der .env; ein absoluter Pfad gilt, sonst sucht which.
 * Ein unsicherer Ordner (Leerzeichen, $, %) verhindert die Dienstdatei wie
 * bei Claude (unsafe-path), statt still zu fehlen.
 */
export async function installSystemdService(deps: SystemdDeps, claudePath?: string, codexPath?: string): Promise<ConfigureResult> {
  const bunPath = await which("bun", deps);
  if (!bunPath) return { ok: false, reason: "no-bun" };
  const claude = claudePath?.startsWith("/") ? claudePath : await which(claudePath || "claude", deps);
  const codex = codexPath?.startsWith("/") ? codexPath : await which(codexPath || "codex", deps);
  const unit = renderSystemdUnit({
    projectRoot: deps.projectRoot,
    home: deps.home,
    bunPath,
    claudeDir: claude ? dirname(claude) : undefined,
    codexDir: codex ? dirname(codex) : undefined,
  });
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
// Alte Dienstdatei nachziehen (Issue #561)
// ---------------------------------------------------------------------------

/**
 * already: wirksam ist schon KillMode=process; fixed: Zeile eingetragen bzw.
 * neu geladen und bestätigt; own-setting: die Dienstdatei setzt selbst einen
 * anderen KillMode, das bleibt so; overridden: Datei stimmt, ein Drop-in setzt
 * etwas anderes; no-file/no-section: keine Dienstdatei bzw. kein Abschnitt
 * [Service] an der erwarteten Stelle; write/reload: Schreiben bzw.
 * daemon-reload scheiterte; unreachable: der Benutzer-Manager antwortet nicht.
 */
export type KillModeOutcome =
  | { kind: "already" | "fixed" | "no-file" | "no-section" | "reload" | "unreachable" }
  | { kind: "own-setting" | "overridden"; value: string }
  | { kind: "write"; code?: string };

const KILL_MODE_ANY = /^[ \t]*KillMode[ \t]*=[ \t]*(\S*)[ \t]*$/gm;

async function loadedKillMode(deps: SystemdDeps): Promise<string | null> {
  const show = await deps.run(["systemctl", "--user", "show", SYSTEMD_UNIT_FILE, "--property=KillMode"], { timeoutMs: 15_000 });
  if (!show.ok) return null;
  return parseShow(show.stdout).KillMode ?? null;
}

/**
 * Trägt KillMode=process in eine bestehende Dienstdatei ein, gleich unter
 * [Service], und lädt sie mit daemon-reload neu. Alles andere in der Datei
 * bleibt, wie es ist; setzt sie selbst einen anderen KillMode, bleibt auch
 * der. Der laufende Bot wird nicht neu gestartet: systemd nimmt den neuen
 * Wert beim nächsten Beenden. Wiederholbar: ein zweiter Lauf findet den Wert
 * schon wirksam und tut nichts.
 */
export async function ensureKillMode(deps: SystemdDeps): Promise<KillModeOutcome> {
  const before = await loadedKillMode(deps);
  if (before === null) return { kind: "unreachable" };
  if (before === KILL_MODE) return { kind: "already" };
  const path = systemdUnitPath(deps.unitDir);
  if (!deps.exists(path)) return { kind: "no-file" };
  let text: string;
  try {
    text = deps.readFile(path);
  } catch (e) {
    return { kind: "write", code: (e as NodeJS.ErrnoException)?.code };
  }
  const own = [...text.matchAll(KILL_MODE_ANY)].map(m => m[1]);
  const last = own.at(-1);
  if (last !== undefined && last !== KILL_MODE) return { kind: "own-setting", value: last };
  if (last === undefined) {
    const lines = text.split("\n");
    const at = lines.findIndex(l => l.trim() === "[Service]");
    if (at < 0) return { kind: "no-section" };
    lines.splice(at + 1, 0, KILL_MODE_COMMENT, KILL_MODE_LINE);
    try {
      // atomar: ein Fehler mittendrin lässt die bestehende Datei samt Anpassungen stehen
      deps.replaceFile(path, lines.join("\n"));
    } catch (e) {
      return { kind: "write", code: (e as NodeJS.ErrnoException)?.code };
    }
  }
  // Datei trägt den Wert (jetzt oder schon vorher, nur nicht geladen): neu laden
  const reload = await deps.run(["systemctl", "--user", "daemon-reload"], { timeoutMs: 30_000 });
  if (!reload.ok) return { kind: "reload" };
  const after = await loadedKillMode(deps);
  if (after === null) return { kind: "unreachable" };
  return after === KILL_MODE ? { kind: "fixed" } : { kind: "overridden", value: after };
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
