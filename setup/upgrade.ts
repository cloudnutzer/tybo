/**
 * Go Telegram Bot - Upgrade & Git Connection
 *
 * Detects if the project was downloaded as a ZIP (no git) or cloned,
 * and connects it to the official repo (BRAND.repo) so users can
 * pull future updates with `git pull`.
 *
 * Safe: all user config (.env, config/profile.md, schedule.json, tokens)
 * is gitignored, so updates never overwrite personal settings.
 *
 * Usage: bun run setup/upgrade.ts
 */

import { BRAND } from "../src/brand";
import { existsSync, readFileSync, readdirSync, copyFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { hasServiceLabels } from "../src/lib/service-names";
import { isBrandRepoUrl, repoCloneUrl } from "../src/lib/repo-remote";

const PROJECT_ROOT = dirname(import.meta.dir);
const REPO_URL = repoCloneUrl();
const BRANCH = "master";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;

const PASS = green("\u2713");
const FAIL = red("\u2717");
const WARN = yellow("!");
const INFO = cyan("\u2192");

export type RunResult = { ok: boolean; stdout: string; stderr: string };
export type Runner = (cmd: string[]) => Promise<RunResult>;

/** Führt Befehle im angegebenen Ordner aus */
export function makeRunner(cwd: string): Runner {
  return (cmd) => spawnIn(cmd, cwd);
}

async function spawnIn(cmd: string[], cwd: string): Promise<RunResult> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd,
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

/**
 * Ordner, Befehle, Plattform und Ausgabe des laufenden Upgrades. runUpgrade()
 * setzt sie; Tests geben eine temporäre Installation und Attrappen für git,
 * bun und launchctl mit.
 */
export interface UpgradeDeps {
  root: string;
  run: Runner;
  platform: NodeJS.Platform;
  log: (line?: string) => void;
}
let root = PROJECT_ROOT;
let run: Runner = makeRunner(PROJECT_ROOT);
let platform: NodeJS.Platform = process.platform;
let log: (line?: string) => void = console.log;

// ---------------------------------------------------------------------------
// User config files that should be preserved (all gitignored)
// ---------------------------------------------------------------------------

const USER_FILES = [
  ".env",
  "config/profile.md",
  "config/schedule.json",
  "config/.google-tokens.json",
  "checkin-state.json",
  "session-state.json",
  "memory.json",
  "news-history.json",
  "last-processed-call.json",
  "meeting-actions-state.json",
];

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

interface InstallInfo {
  hasGit: boolean;
  remoteUrl: string | null;
  isCorrectRemote: boolean;
  branch: string | null;
  hasUserConfig: boolean;
  userFiles: string[];
  version: string | null;
}

async function detectInstallation(): Promise<InstallInfo> {
  const hasGit = existsSync(join(root, ".git"));

  let remoteUrl: string | null = null;
  let isCorrectRemote = false;
  let branch: string | null = null;

  if (hasGit) {
    const remote = await run(["git", "remote", "get-url", "origin"]);
    if (remote.ok) {
      remoteUrl = remote.stdout;
      isCorrectRemote = isBrandRepoUrl(remoteUrl);
    }

    const br = await run(["git", "branch", "--show-current"]);
    if (br.ok) branch = br.stdout;
  }

  // Check which user files exist
  const userFiles: string[] = [];
  for (const f of USER_FILES) {
    if (existsSync(join(root, f))) {
      userFiles.push(f);
    }
  }

  // Get version from package.json
  let version: string | null = null;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    version = pkg.version || null;
  } catch {}

  return {
    hasGit,
    remoteUrl,
    isCorrectRemote,
    branch,
    hasUserConfig: userFiles.length > 0,
    userFiles,
    version,
  };
}

// ---------------------------------------------------------------------------
// Upgrade scenarios
// ---------------------------------------------------------------------------

/**
 * Scenario 1: ZIP download — no .git directory
 * Initialize git, connect to repo, fetch latest
 */
async function upgradeFromZip(info: InstallInfo): Promise<boolean> {
  log(`\n${cyan(`  Connecting to ${BRAND.repo}...`)}`);

  // Step 1: Init git
  log(`  ${INFO} Initializing git...`);
  const init = await run(["git", "init"]);
  if (!init.ok) {
    log(`  ${FAIL} git init failed: ${init.stderr}`);
    return false;
  }
  log(`  ${PASS} Git initialized`);

  // Step 2: Add remote
  log(`  ${INFO} Adding remote origin → ${REPO_URL}`);
  const addRemote = await run(["git", "remote", "add", "origin", REPO_URL]);
  if (!addRemote.ok) {
    log(`  ${FAIL} Failed to add remote: ${addRemote.stderr}`);
    return false;
  }
  log(`  ${PASS} Remote added`);

  // Step 3: Fetch
  log(`  ${INFO} Fetching latest from ${BRANCH}...`);
  const fetch = await run(["git", "fetch", "origin", BRANCH]);
  if (!fetch.ok) {
    log(`  ${FAIL} Fetch failed: ${fetch.stderr}`);
    log(`  ${dim("    Check your internet connection and try again")}`);
    return false;
  }
  log(`  ${PASS} Fetched latest code`);

  // Step 4: Reset to track origin/master
  // This makes your working directory match the repo structure
  // while keeping all untracked files (your .env, config, etc.)
  log(`  ${INFO} Aligning with ${BRANCH} branch...`);
  const reset = await run(["git", "reset", "origin/" + BRANCH]);
  if (!reset.ok) {
    log(`  ${FAIL} Reset failed: ${reset.stderr}`);
    return false;
  }

  // Step 5: Set upstream tracking
  const checkout = await run(["git", "checkout", "-B", BRANCH, "--track", `origin/${BRANCH}`]);
  if (!checkout.ok) {
    // Fallback: just set the branch
    await run(["git", "branch", "-M", BRANCH]);
    await run(["git", "branch", "--set-upstream-to=origin/" + BRANCH, BRANCH]);
  }
  log(`  ${PASS} Now tracking origin/${BRANCH}`);

  // Step 6: Verify — check if git status works
  const status = await run(["git", "status", "--short"]);
  if (status.ok) {
    const modified = status.stdout.split("\n").filter((l) => l.trim()).length;
    if (modified > 0) {
      log(`  ${WARN} ${modified} local modifications detected ${dim("(this is normal for user config)")}`);
    } else {
      log(`  ${PASS} Clean — fully aligned with latest ${BRANCH}`);
    }
  }

  return true;
}

/**
 * Scenario 2: Has .git but wrong remote (e.g., personal fork)
 * Add the correct remote and set up tracking
 */
async function fixRemote(info: InstallInfo): Promise<boolean> {
  log(`\n${cyan("  Fixing remote to track official repository...")}`);

  // Check if 'upstream' already exists (exact remote name)
  const remotes = await run(["git", "remote"]);
  const hasUpstream = remotes.stdout.split("\n").some((name) => name.trim() === "upstream");

  if (hasUpstream) {
    // Update upstream URL
    await run(["git", "remote", "set-url", "upstream", REPO_URL]);
    log(`  ${PASS} Updated upstream → ${REPO_URL}`);
  } else if (info.remoteUrl && isBrandRepoUrl(info.remoteUrl)) {
    // Origin is already correct
    log(`  ${PASS} Origin already points to ${BRAND.repo}`);
  } else {
    // Add upstream for the official repo, keep origin as their fork
    await run(["git", "remote", "add", "upstream", REPO_URL]);
    log(`  ${PASS} Added upstream → ${REPO_URL}`);
    log(`  ${dim("    Your fork stays as 'origin', official repo is 'upstream'")}`);
    log(`  ${dim("    Pull updates: git pull upstream master")}`);
  }

  // Fetch from the correct remote
  const remoteName = hasUpstream || !info.isCorrectRemote ? "upstream" : "origin";
  log(`  ${INFO} Fetching latest from ${remoteName}/${BRANCH}...`);
  const fetch = await run(["git", "fetch", remoteName, BRANCH]);
  if (!fetch.ok) {
    log(`  ${FAIL} Fetch failed: ${fetch.stderr}`);
    return false;
  }
  log(`  ${PASS} Fetched latest code`);

  return true;
}

/**
 * Scenario 3: Properly cloned — just pull latest
 */
async function pullLatest(): Promise<boolean> {
  log(`\n${cyan("  Pulling latest updates...")}`);

  // Check for uncommitted changes first
  const status = await run(["git", "status", "--porcelain"]);
  const hasChanges = status.stdout.trim().length > 0;

  if (hasChanges) {
    // Stash any tracked file changes (won't affect .env etc. since they're gitignored)
    log(`  ${INFO} Stashing local changes...`);
    await run(["git", "stash"]);
  }

  const pull = await run(["git", "pull", "origin", BRANCH]);
  if (!pull.ok) {
    log(`  ${FAIL} Pull failed: ${pull.stderr}`);

    if (hasChanges) {
      log(`  ${INFO} Restoring stashed changes...`);
      await run(["git", "stash", "pop"]);
    }
    return false;
  }

  if (pull.stdout.includes("Already up to date")) {
    log(`  ${PASS} Already up to date`);
  } else {
    log(`  ${PASS} Updated successfully`);
    log(`  ${dim(pull.stdout.split("\n").slice(0, 5).join("\n  "))}`);
  }

  if (hasChanges) {
    log(`  ${INFO} Restoring stashed changes...`);
    const pop = await run(["git", "stash", "pop"]);
    if (!pop.ok) {
      log(`  ${WARN} Stash pop had conflicts — check manually`);
    }
  }

  return true;
}

// ---------------------------------------------------------------------------
// Post-upgrade: install new dependencies
// ---------------------------------------------------------------------------

async function postUpgrade(oldVersion: string | null): Promise<void> {
  // Re-read version
  let newVersion: string | null = null;
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    newVersion = pkg.version || null;
  } catch {}

  if (oldVersion !== newVersion) {
    log(`\n${cyan("  Version changed:")} ${dim(oldVersion || "unknown")} → ${green(newVersion || "unknown")}`);
  }

  // Always reinstall dependencies after upgrade
  log(`  ${INFO} Installing dependencies...`);
  const install = await run(["bun", "install"]);
  if (install.ok) {
    log(`  ${PASS} Dependencies updated`);
  } else {
    log(`  ${WARN} bun install had issues: ${install.stderr.substring(0, 200)}`);
  }

  // Run schema (safe — IF NOT EXISTS)
  log(`  ${INFO} Checking database schema...`);
  const schemaPath = join(root, "db", "schema.sql");
  if (existsSync(schemaPath)) {
    log(`  ${PASS} Schema file ready ${dim("(run in Supabase SQL editor if new tables were added)")}`);
  }
}

/**
 * Neustart-Hinweis nach dem Update, leer ohne geladene tybo-Dienste.
 * `setup:launchd` lädt eine unveränderte Plist nicht mehr neu (Issue #101),
 * der laufende Bot bliebe beim alten Code. restart:request beendet ihn nach
 * der laufenden Antwort, launchd (KeepAlive) startet ihn mit dem neuen Code;
 * die zeitgesteuerten Dienste starten bei jedem Lauf ohnehin frisch.
 */
export function restartHint(launchctlStdout: string): string[] {
  if (!hasServiceLabels(launchctlStdout)) return [];
  return [
    `\n  ${WARN} Running services detected, restart the bot to use the new code:`,
    `      ${cyan('bun run restart:request "Update"')}`,
    `  ${dim("    Scheduled services (check-in, briefing, watchdog) pick up the new code on their next run.")}`,
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/** Upgrade mit den angegebenen Abhängigkeiten, Rückgabe ist der Exit-Code */
export async function runUpgrade(deps: Partial<UpgradeDeps> = {}): Promise<number> {
  root = deps.root ?? PROJECT_ROOT;
  run = deps.run ?? makeRunner(root);
  platform = deps.platform ?? process.platform;
  log = deps.log ?? console.log;
  return main();
}

async function main(): Promise<number> {
  log("");
  log(bold(`  ${BRAND.name} Upgrade`));
  log(dim("  ============="));

  // Check git is available
  const gitCheck = await run(["git", "--version"]);
  if (!gitCheck.ok) {
    log(`\n  ${FAIL} Git is not installed. Install git first.`);
    return 1;
  }

  // Detect current state
  log(`\n${cyan("  [1/3] Detecting installation...")}`);
  const info = await detectInstallation();

  log(`  ${info.hasGit ? PASS : FAIL} Git repository: ${info.hasGit ? "yes" : "no (ZIP download)"}`);
  if (info.remoteUrl) {
    log(`  ${info.isCorrectRemote ? PASS : WARN} Remote: ${info.remoteUrl}`);
  }
  if (info.branch) {
    log(`  ${PASS} Branch: ${info.branch}`);
  }
  log(`  ${PASS} Version: ${info.version || "unknown"}`);
  log(`  ${PASS} User config: ${info.userFiles.length} files preserved`);
  if (info.userFiles.length > 0) {
    for (const f of info.userFiles) {
      log(`      ${dim(f)}`);
    }
  }

  // Choose upgrade path
  log(`\n${cyan("  [2/3] Upgrading...")}`);
  let success = false;

  if (!info.hasGit) {
    // ZIP download — connect to repo
    log(`  ${INFO} Detected ZIP installation — connecting to official repo`);
    success = await upgradeFromZip(info);
  } else if (!info.isCorrectRemote) {
    // Wrong remote — fix it
    log(`  ${INFO} Remote doesn't point to ${BRAND.repo}, adding upstream`);
    success = await fixRemote(info);
  } else {
    // Proper clone — just pull
    log(`  ${INFO} Proper clone detected — pulling latest`);
    success = await pullLatest();
  }

  if (!success) {
    log(`\n  ${red("Upgrade failed. Your config files are safe.")}`);
    log(`  ${dim("Try manually: git pull origin master")}`);
    return 1;
  }

  // Post-upgrade
  log(`\n${cyan("  [3/3] Post-upgrade...")}`);
  await postUpgrade(info.version);

  // Summary
  log(`\n${bold("  Done!")}`);
  log(`  ${PASS} Connected to ${REPO_URL}`);
  log(`  ${PASS} All user config preserved (${info.userFiles.length} files)`);
  log(`\n  ${dim("Future updates:")} ${cyan("bun run upgrade")} ${dim("or")} ${cyan("git pull origin master")}`);

  // Check if services need restart
  if (platform === "darwin") {
    const services = await run(["launchctl", "list"]);
    if (services.ok) for (const line of restartHint(services.stdout)) log(line);
  }

  log("");
  return 0;
}

if (import.meta.main) runUpgrade().then((code) => process.exit(code), (err) => {
  console.error(`\n  ${red("Fatal error:")} ${err.message}`);
  process.exit(1);
});
