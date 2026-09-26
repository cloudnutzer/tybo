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
 * exits only when no Claude subprocess or agent execution is running.
 * launchd (KeepAlive) or PM2 then starts it again with the new code.
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

export type Supervisor = "launchd" | "pm2";

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
}

const defaultSupervisorDeps: SupervisorDeps = {
  env: process.env,
  platform: process.platform,
  launchctlList: async label =>
    (await execFileAsync("launchctl", ["list", label], { timeout: 5000 })).stdout,
};

export async function detectSupervisor(
  pid = process.pid,
  deps: Partial<SupervisorDeps> = {}
): Promise<Supervisor | null> {
  const d = { ...defaultSupervisorDeps, ...deps };
  if (d.env.pm_id !== undefined) return "pm2";
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
