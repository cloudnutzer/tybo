/**
 * Go Telegram Bot - Uninstall Services (Cross-Platform)
 *
 * macOS: Unloads and removes all ai.tybo.* plist files
 * Linux mit systemd (Issue #207): stoppt und entfernt den Benutzerdienst
 * tybo-telegram-relay.service; Linger bleibt an (andere Benutzerdienste
 * können davon abhängen). PM2 nur, wenn es installiert ist, und dann ohne npx.
 * Windows/Linux: Stops tybo-* PM2 processes. Windows-Aufgaben (Go-<dienst>)
 * bleiben unberührt (Issue #142)
 *
 * Does NOT delete project files or .env.
 *
 * Supabase auf diesem Rechner (Issue #165): entfernt wird nur der Dienst
 * ai.tybo.supabase bzw. tybo-supabase, nicht die Container und nicht die
 * Daten; die Ausgabe nennt tybo datenbank stop zum Anhalten.
 *
 * Usage: bun run setup/uninstall.ts
 */

import { existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { isServicePlist, launchdLabel, pm2Name, SUPABASE_SERVICE } from "../src/lib/service-names";
import { SYSTEMD_UNIT, SYSTEMD_UNIT_FILE, SYSTEMD_USER_DIR } from "./configure-systemd";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;

const PASS = green("\u2713");
const FAIL = red("\u2717");

async function runCommand(
  cmd: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { ok: code === 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch {
    return { ok: false, stdout: "", stderr: "Command not found" };
  }
}

// ---------------------------------------------------------------------------
// macOS: Uninstall launchd services
// ---------------------------------------------------------------------------

/** Hinweis nach dem Entfernen des Supabase-Diensts: Container und Daten bleiben */
export const SUPABASE_LEFT_RUNNING =
  "Supabase auf diesem Rechner läuft weiter (Docker-Container, die Daten bleiben). Anhalten: tybo datenbank stop";

/**
 * Entlädt und löscht alle ai.tybo.*-Plists. launchAgentsDir und run sind in
 * Tests ein Temp-Ordner und eine Attrappe.
 */
export async function uninstallLaunchd(
  LAUNCH_AGENTS_DIR = join(process.env.HOME!, "Library", "LaunchAgents"),
  run: UninstallRunner = runCommand
) {

  if (!existsSync(LAUNCH_AGENTS_DIR)) {
    console.log(`\n  ${dim("No LaunchAgents directory found. Nothing to uninstall.")}`);
    return;
  }

  const allFiles = readdirSync(LAUNCH_AGENTS_DIR);
  // Nur ai.tybo.*, Dienste anderer Namen bleiben (Issue #142)
  const goPlists = allFiles.filter(isServicePlist);

  if (goPlists.length === 0) {
    console.log(`\n  ${dim("No ai.tybo.* services found in ~/Library/LaunchAgents/.")}`);
    console.log(`  ${dim("Nothing to uninstall.")}`);
    return;
  }

  console.log(`\n  Found ${goPlists.length} service${goPlists.length !== 1 ? "s" : ""}:\n`);

  let unloadedCount = 0;
  let removedCount = 0;
  let errorCount = 0;

  for (const plist of goPlists) {
    const fullPath = join(LAUNCH_AGENTS_DIR, plist);
    const label = plist.replace(".plist", "");

    console.log(`  ${bold(label)}`);

    const unloadResult = await run(["launchctl", "unload", fullPath]);
    if (unloadResult.ok) {
      console.log(`    ${PASS} Unloaded`);
      unloadedCount++;
    } else if (unloadResult.stderr.includes("Could not find specified service")) {
      console.log(`    ${dim("-")} Was not loaded`);
    } else {
      console.log(`    ${yellow("!")} Unload: ${unloadResult.stderr}`);
    }

    try {
      unlinkSync(fullPath);
      console.log(`    ${PASS} Deleted: ${dim(fullPath)}`);
      removedCount++;
    } catch (err: any) {
      console.log(`    ${FAIL} Delete failed: ${err.message}`);
      errorCount++;
    }
  }

  if (goPlists.includes(`${launchdLabel(SUPABASE_SERVICE)}.plist`)) console.log(`\n  ${dim(SUPABASE_LEFT_RUNNING)}`);

  console.log(`\n${bold("  Summary:")}`);
  console.log(`  ${PASS} ${unloadedCount} service${unloadedCount !== 1 ? "s" : ""} unloaded`);
  console.log(`  ${PASS} ${removedCount} plist file${removedCount !== 1 ? "s" : ""} removed`);
  if (errorCount > 0) {
    console.log(`  ${FAIL} ${errorCount} error${errorCount !== 1 ? "s" : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Windows/Linux: Uninstall PM2 + scheduled tasks
// ---------------------------------------------------------------------------

const PM2_SERVICES = ["telegram-relay", "smart-checkin", "morning-briefing", "watchdog", SUPABASE_SERVICE];

/** PM2-Prozesse, die die Deinstallation entfernt: nur tybo-* (Issue #142) */
export function uninstallNames(): string[] {
  return PM2_SERVICES.map(pm2Name);
}

/** Befehlsaufruf, in Tests eine Attrappe */
export type UninstallRunner = (cmd: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

/**
 * Entfernt die tybo-*-PM2-Prozesse. Windows-Aufgaben (Go-<dienst>) fasst die
 * Deinstallation nicht an, auch nicht unter Windows (Issue #142).
 */
export async function uninstallPM2(run: UninstallRunner = runCommand, pm2: string[] = ["npx", "pm2"]) {
  const services = uninstallNames();

  // Stop PM2 processes
  const pm2Check = await run([...pm2, "jlist"]);
  if (pm2Check.ok) {
    let stoppedCount = 0;
    for (const name of services) {
      const result = await run([...pm2, "delete", name]);
      if (result.ok) {
        console.log(`  ${PASS} Stopped and removed: ${name}`);
        if (name === pm2Name(SUPABASE_SERVICE)) console.log(`    ${dim(SUPABASE_LEFT_RUNNING)}`);
        stoppedCount++;
      } else if (result.stderr.includes("not found")) {
        console.log(`  ${dim("-")} ${name}: not running`);
      } else {
        console.log(`  ${yellow("!")} ${name}: ${result.stderr}`);
      }
    }
    if (stoppedCount > 0) {
      await run([...pm2, "save"]);
    }
  } else {
    console.log(`  ${dim("PM2 not installed. Skipping.")}`);
  }
}

// ---------------------------------------------------------------------------
// Linux: systemd-Benutzerdienst (Issue #207)
// ---------------------------------------------------------------------------

/** Hinweis nach dem Entfernen: Linger bleibt, weil andere Benutzerdienste es brauchen können */
export const LINGER_LEFT_ON =
  "Linger bleibt eingeschaltet (andere Benutzerdienste können es brauchen). Ausschalten, wenn nichts anderes es braucht: loginctl disable-linger $USER (ohne Berechtigung mit sudo davor)";

/** Ergebnis auf dem systemd-Weg: keine Dienstdatei, entfernt, oder ein Schritt scheiterte */
export type SystemdUninstall = "none" | "removed" | "failed";

/**
 * Stoppt und entfernt tybo-telegram-relay.service. Scheitert das Stoppen,
 * bleibt die Dienstdatei (sonst liefe ein Bot ohne Datei weiter, den keine
 * Deinstallation mehr findet). unitDir, run und remove sind in Tests ein
 * Temp-Ordner und Attrappen. Nie über sudo: systemctl --user braucht die
 * Sitzung des Nutzers.
 */
export async function uninstallSystemd(
  unitDir = SYSTEMD_USER_DIR,
  run: UninstallRunner = runCommand,
  remove: (path: string) => void = unlinkSync
): Promise<SystemdUninstall> {
  const path = join(unitDir, SYSTEMD_UNIT_FILE);
  if (!existsSync(path)) {
    console.log(`\n  ${dim(`No systemd user service ${SYSTEMD_UNIT_FILE} found.`)}`);
    return "none";
  }
  console.log(`\n  ${bold(SYSTEMD_UNIT_FILE)}`);
  const disable = await run(["systemctl", "--user", "disable", "--now", SYSTEMD_UNIT]);
  if (!disable.ok) {
    console.log(`    ${FAIL} systemctl --user disable --now failed, service file kept: ${dim(path)}`);
    console.log(`    ${dim(`Check (not via sudo): systemctl --user status ${SYSTEMD_UNIT}`)}`);
    return "failed";
  }
  console.log(`    ${PASS} Stopped and disabled`);
  try {
    remove(path);
    console.log(`    ${PASS} Deleted: ${dim(path)}`);
  } catch (err: any) {
    console.log(`    ${FAIL} Delete failed: ${err.message}`);
    return "failed";
  }
  const reload = await run(["systemctl", "--user", "daemon-reload"]);
  if (!reload.ok) {
    console.log(`    ${FAIL} systemctl --user daemon-reload failed; run it once by hand`);
    return "failed";
  }
  console.log(`    ${dim(LINGER_LEFT_ON)}`);
  return "removed";
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export interface UninstallDeps {
  platform: NodeJS.Platform;
  run: UninstallRunner;
  unitDir: string;
  remove(path: string): void;
}

/** Deinstallation ohne Kopfzeilen; Rückgabe: Exit-Code der CLI (1, wenn der systemd-Dienst nicht sauber entfernt wurde) */
export async function runUninstall(deps: UninstallDeps): Promise<number> {
  let code = 0;
  if (deps.platform === "darwin") {
    await uninstallLaunchd(undefined, deps.run);
  } else {
    const systemd = deps.platform === "linux" ? await uninstallSystemd(deps.unitDir, deps.run, deps.remove) : "none";
    if (systemd === "failed") code = 1;
    if (systemd !== "none") {
      // systemd-Weg: PM2 (Supabase, Check-in, ...) nur, wenn es installiert ist, nie über npx
      if ((await deps.run(["pm2", "--version"])).ok) await uninstallPM2(deps.run, ["pm2"]);
      else console.log(`  ${dim("PM2 not installed. Skipping.")}`);
    } else {
      await uninstallPM2(deps.run);
    }
  }

  console.log(`\n  ${dim("Project files and .env were NOT removed.")}`);
  if (deps.platform === "darwin") {
    console.log(`  ${dim("To reinstall services: bun run setup:launchd -- --service all")}`);
  } else {
    console.log(`  ${dim("To reinstall the bot service: tybo setup autostart")}`);
    console.log(`  ${dim("To reinstall all PM2 services: bun run setup:services -- --service all")}`);
  }
  if (code !== 0) console.log(`\n  ${FAIL} ${red(`${SYSTEMD_UNIT} was not fully removed (see above).`)}`);
  console.log("");
  return code;
}

async function main() {
  console.log("");
  console.log(bold("  Go Telegram Bot - Uninstall Services"));
  console.log(dim("  ====================================="));
  process.exitCode = await runUninstall({ platform: process.platform, run: runCommand, unitDir: SYSTEMD_USER_DIR, remove: unlinkSync });
}

if (import.meta.main) main().catch((err) => {
  console.error(`\n  ${red("Fatal error:")} ${err.message}`);
  process.exit(1);
});
