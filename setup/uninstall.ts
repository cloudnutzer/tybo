/**
 * Go Telegram Bot - Uninstall Services (Cross-Platform)
 *
 * macOS: Unloads and removes all ai.tybo.* plist files
 * Windows/Linux: Stops tybo-* PM2 processes. Windows-Aufgaben (Go-<dienst>)
 * bleiben unberührt (Issue #142)
 *
 * Does NOT delete project files or .env.
 *
 * Usage: bun run setup/uninstall.ts
 */

import { existsSync, readdirSync, unlinkSync } from "fs";
import { join } from "path";
import { isServicePlist, pm2Name } from "../src/lib/service-names";

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

async function uninstallLaunchd() {
  const homeDir = process.env.HOME!;
  const LAUNCH_AGENTS_DIR = join(homeDir, "Library", "LaunchAgents");

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

    const unloadResult = await runCommand(["launchctl", "unload", fullPath]);
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

const PM2_SERVICES = ["telegram-relay", "smart-checkin", "morning-briefing", "watchdog"];

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
export async function uninstallPM2(run: UninstallRunner = runCommand) {
  const services = uninstallNames();

  // Stop PM2 processes
  const pm2Check = await run(["npx", "pm2", "jlist"]);
  if (pm2Check.ok) {
    let stoppedCount = 0;
    for (const name of services) {
      const result = await run(["npx", "pm2", "delete", name]);
      if (result.ok) {
        console.log(`  ${PASS} Stopped and removed: ${name}`);
        stoppedCount++;
      } else if (result.stderr.includes("not found")) {
        console.log(`  ${dim("-")} ${name}: not running`);
      } else {
        console.log(`  ${yellow("!")} ${name}: ${result.stderr}`);
      }
    }
    if (stoppedCount > 0) {
      await run(["npx", "pm2", "save"]);
    }
  } else {
    console.log(`  ${dim("PM2 not installed. Skipping.")}`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log(bold("  Go Telegram Bot - Uninstall Services"));
  console.log(dim("  ====================================="));

  if (process.platform === "darwin") {
    await uninstallLaunchd();
  } else {
    await uninstallPM2();
  }

  console.log(`\n  ${dim("Project files and .env were NOT removed.")}`);
  if (process.platform === "darwin") {
    console.log(`  ${dim("To reinstall services: bun run setup:launchd -- --service all")}`);
  } else {
    console.log(`  ${dim("To reinstall services: bun run setup:services -- --service all")}`);
  }
  console.log("");
}

if (import.meta.main) main().catch((err) => {
  console.error(`\n  ${red("Fatal error:")} ${err.message}`);
  process.exit(1);
});
