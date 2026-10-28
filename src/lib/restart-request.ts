/**
 * Deferred bot restart ("Neustart nach Antwort").
 *
 * Whoever changes the bot's code while it is running (a Claude subprocess
 * answering a Telegram message, a deploy script, a terminal session) must
 * NOT send SIGTERM or `launchctl kickstart -k`: shutdown() in src/bot.ts
 * kills every running Claude subprocess, including the one that would
 * deliver the answer. On 14.9.2026 that turned the table-fix explanation
 * into a bare "Abgebrochen." in Telegram.
 *
 * Instead, request a restart by creating the marker file
 * data/restart-requested (`bun run restart:request "note"`). The bot checks
 * the marker after every delivered reply and every 30 s while idle, and
 * exits only when no Claude subprocess, agent execution or goal loop is running.
 * launchd (KeepAlive), PM2 or systemd (Restart=always, Issue #207) then
 * starts it again with the new code.
 * Ab dem Entschluss nimmt der Bot keine neuen Turns mehr an und antwortet
 * „startet gerade neu" (src/lib/restart-control.ts, Issue #190); aktive
 * Ziele laufen nach dem Start weiter.
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { BOT_SERVICE, launchdLabel } from "./service-names";

const execFileAsync = promisify(execFile);

export const RESTART_MARKER = join(
  process.env.GO_PROJECT_ROOT || process.cwd(),
  "data",
  "restart-requested"
);

/**
 * launchd-Labels, unter denen der Bot laufen kann: das eingestellte
 * (TYBO_LAUNCHD_LABEL), dann ai.tybo.telegram-relay (Issue #101, #142).
 * Gelesen beim Aufruf, nicht beim Import, damit Werte aus der .env zählen.
 */
export function supervisorLabels(env: Record<string, string | undefined>): string[] {
  const configured = env.TYBO_LAUNCHD_LABEL?.trim();
  return [...new Set([...(configured ? [configured] : []), launchdLabel(BOT_SERVICE)])];
}

/** Create the marker. `note` is shown in the log and the Telegram notice. */
export async function requestRestart(note = "", file = RESTART_MARKER): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${note.trim()}\n`, { mode: 0o600 });
}

/** The note (possibly "") when a restart is requested, null when not. */
export async function readRestartRequest(file = RESTART_MARKER): Promise<string | null> {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return null;
  }
}

export async function clearRestartRequest(file = RESTART_MARKER): Promise<void> {
  await unlink(file).catch(() => {});
}

export type Supervisor = "launchd" | "pm2" | "systemd";

/** Name für Meldungen */
export function supervisorName(supervisor: Supervisor): string {
  return supervisor === "pm2" ? "PM2" : supervisor;
}

/**
 * Which supervisor starts the bot again after process.exit()?
 * null means exiting would leave the bot dead (nohup, plain terminal),
 * so the caller must not exit and should ask for a manual restart instead.
 */
export interface SupervisorDeps {
  env: Record<string, string | undefined>;
  platform: NodeJS.Platform;
  /** Output of `launchctl list <label>`; tests pass a fake, never the real launchctl */
  launchctlList(label: string): Promise<string>;
  /**
   * Ausgabe von `systemctl --user show <unit> --property=MainPID,Restart`
   * (Issue #207); Tests setzen eine Attrappe ein, nie das echte systemctl
   */
  systemctlShow(unit: string): Promise<string>;
}

/**
 * Setzt die Dienstdatei von `tybo setup autostart` (setup/configure-systemd.ts):
 * Name des systemd-Benutzerdiensts, unter dem der Bot läuft
 */
export const SYSTEMD_UNIT_ENV = "TYBO_SYSTEMD_UNIT";

const defaultSupervisorDeps: SupervisorDeps = {
  env: process.env,
  platform: process.platform,
  launchctlList: async label =>
    (await execFileAsync("launchctl", ["list", label], { timeout: 5000 })).stdout,
  systemctlShow: async unit =>
    (await execFileAsync("systemctl", ["--user", "show", unit, "--property=MainPID,Restart"], { timeout: 5000 })).stdout,
};

/**
 * systemd zählt nur, wenn alles zusammenpasst: der Prozess läuft in einem
 * systemd-Dienst (INVOCATION_ID), die Dienstdatei von tybo hat ihren Namen
 * gesetzt, systemd nennt genau diese PID als Hauptprozess und startet nach
 * jedem Ende neu (Restart=always; on-failure startete nach einem sauberen
 * Exit nicht neu, der Bot bliebe aus).
 */
async function underSystemd(pid: number, d: SupervisorDeps): Promise<boolean> {
  const unit = d.env[SYSTEMD_UNIT_ENV]?.trim();
  if (!d.env.INVOCATION_ID || !unit || !/^[\w@.-]+\.service$/.test(unit)) return false;
  try {
    const props: Record<string, string> = {};
    for (const line of (await d.systemctlShow(unit)).split("\n")) {
      const at = line.indexOf("=");
      if (at > 0) props[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    return Number(props.MainPID) === pid && props.Restart === "always";
  } catch {
    // systemctl fehlt oder der Benutzer-Manager antwortet nicht
    return false;
  }
}

export async function detectSupervisor(
  pid = process.pid,
  deps: Partial<SupervisorDeps> = {}
): Promise<Supervisor | null> {
  const d = { ...defaultSupervisorDeps, ...deps };
  if (d.env.pm_id !== undefined) return "pm2";
  if (d.platform === "linux" && (await underSystemd(pid, d))) return "systemd";
  if (d.platform === "darwin") {
    for (const label of supervisorLabels(d.env)) {
      try {
        const stdout = await d.launchctlList(label);
        // Nur der exakt abgefragte Dienst zählt, und nur mit unserer PID
        const named = stdout.match(/"Label"\s*=\s*"([^"]*)"/);
        if (named && named[1] !== label) continue;
        const match = stdout.match(/"PID"\s*=\s*(\d+)/);
        if (match && Number(match[1]) === pid) return "launchd";
      } catch {
        // label not loaded or launchctl unavailable
      }
    }
  }
  return null;
}
