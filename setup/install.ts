/**
 * Go Telegram Bot - Install & Prerequisites Checker
 *
 * Verifies system requirements, installs dependencies,
 * creates required directories, and prepares .env file.
 *
 * Usage: bun run setup/install.ts
 */

import { existsSync, mkdirSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { BRAND } from "../src/brand";
import { isBrandRepoUrl } from "../src/lib/repo-remote";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = dirname(import.meta.dir);
const REQUIRED_DIRS = ["logs", "temp", "uploads", "config"];

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

async function runCommand(
  cmd: string[],
  opts?: { cwd?: string }
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: opts?.cwd || PROJECT_ROOT,
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
// Checks
// ---------------------------------------------------------------------------

async function checkPlatform(): Promise<boolean> {
  const platform = process.platform;
  const supported = ["darwin", "win32", "linux"];
  if (supported.includes(platform)) {
    const names: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" };
    console.log(`  ${PASS} Platform: ${names[platform] || platform} (${platform})`);
    return true;
  }
  console.log(`  ${FAIL} Platform: ${platform} - supported platforms: macOS, Windows, Linux`);
  return false;
}

async function checkBun(): Promise<boolean> {
  const result = await runCommand(["bun", "--version"]);
  if (result.ok) {
    console.log(`  ${PASS} Bun: v${result.stdout}`);
    return true;
  }
  console.log(`  ${FAIL} Bun: not installed`);
  console.log(`      ${dim("Install: curl -fsSL https://bun.sh/install | bash")}`);
  return false;
}

/** Git-Prüfung; root und Befehle lassen sich für Tests ersetzen */
export async function checkGitRepo(
  root: string = PROJECT_ROOT,
  run: (cmd: string[]) => Promise<{ ok: boolean; stdout: string; stderr: string }> = (cmd) => runCommand(cmd, { cwd: root }),
): Promise<boolean> {
  const gitDir = join(root, ".git");
  if (!existsSync(gitDir)) {
    console.log(`  ${WARN} No git repository detected ${dim("(ZIP download?)")}`);
    console.log(`      ${yellow("Run")} ${cyan("bun run upgrade")} ${yellow("to connect to the official repo for future updates")}`);
    return false;
  }

  const remote = await run(["git", "remote", "get-url", "origin"]);
  if (remote.ok && isBrandRepoUrl(remote.stdout)) {
    console.log(`  ${PASS} Git: connected to ${BRAND.repo}`);
    return true;
  } else if (remote.ok) {
    console.log(`  ${WARN} Git remote: ${remote.stdout} ${dim("(not the official repo)")}`);
    console.log(`      ${yellow("Run")} ${cyan("bun run upgrade")} ${yellow("to connect for updates")}`);
    return false;
  }

  console.log(`  ${WARN} Git: no remote configured`);
  console.log(`      ${yellow("Run")} ${cyan("bun run upgrade")} ${yellow("to connect to the official repo")}`);
  return false;
}

async function checkClaude(): Promise<boolean> {
  // Check CLAUDE_PATH env var first
  const claudePath = process.env.CLAUDE_PATH;
  if (claudePath) {
    const result = await runCommand([claudePath, "--version"]);
    if (result.ok) {
      console.log(`  ${PASS} Claude CLI: ${result.stdout} ${dim(`(CLAUDE_PATH=${claudePath})`)}`);
      return true;
    }
  }

  // Fall back to which/where claude
  const findCmd = process.platform === "win32" ? ["where", "claude"] : ["which", "claude"];
  const which = await runCommand(findCmd);
  if (which.ok) {
    const version = await runCommand(["claude", "--version"]);
    console.log(
      `  ${PASS} Claude CLI: ${version.ok ? version.stdout : "found"} ${dim(`(${which.stdout})`)}`
    );
    return true;
  }

  console.log(`  ${WARN} Claude CLI: not found ${dim("(optional but recommended)")}`);
  console.log(`      ${dim("Install: npm install -g @anthropic-ai/claude-code")}`);
  return false;
}

// ---------------------------------------------------------------------------
// Install Steps
// ---------------------------------------------------------------------------

async function installDependencies(): Promise<boolean> {
  console.log(`\n  Installing dependencies...`);
  const result = await runCommand(["bun", "install"], { cwd: PROJECT_ROOT });
  if (result.ok) {
    console.log(`  ${PASS} Dependencies installed`);
    return true;
  }
  console.log(`  ${FAIL} bun install failed:`);
  console.log(`      ${result.stderr}`);
  return false;
}

function createDirectories(): void {
  for (const dir of REQUIRED_DIRS) {
    const fullPath = join(PROJECT_ROOT, dir);
    if (!existsSync(fullPath)) {
      mkdirSync(fullPath, { recursive: true });
      console.log(`  ${PASS} Created ${dir}/`);
    } else {
      console.log(`  ${PASS} ${dir}/ ${dim("(exists)")}`);
    }
  }
}

function setupEnvFile(): boolean {
  const envPath = join(PROJECT_ROOT, ".env");
  const examplePath = join(PROJECT_ROOT, ".env.example");

  if (existsSync(envPath)) {
    console.log(`  ${PASS} .env ${dim("(exists)")}`);
    return true;
  }

  if (!existsSync(examplePath)) {
    console.log(`  ${FAIL} .env.example not found - cannot create .env`);
    return false;
  }

  copyFileSync(examplePath, envPath);
  console.log(`  ${WARN} .env created from .env.example`);
  console.log(`      ${yellow(">>> You MUST edit .env and fill in your API keys <<<")}`);
  return false;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log(bold("  Go Telegram Bot - Setup"));
  console.log(dim("  ========================"));

  // 1. Prerequisites
  console.log(`\n${cyan("  [1/4] Checking prerequisites...")}`);
  const platformOk = await checkPlatform();
  if (!platformOk) {
    console.log(`\n  ${red("Setup aborted: unsupported platform.")}`);
    process.exit(1);
  }

  const bunOk = await checkBun();
  if (!bunOk) {
    console.log(`\n  ${red("Setup aborted: bun is required.")}`);
    process.exit(1);
  }

  const gitOk = await checkGitRepo();
  const claudeOk = await checkClaude();

  // 2. Dependencies
  console.log(`\n${cyan("  [2/4] Installing dependencies...")}`);
  const depsOk = await installDependencies();
  if (!depsOk) {
    console.log(`\n  ${red("Setup aborted: dependency installation failed.")}`);
    process.exit(1);
  }

  // 3. Directories
  console.log(`\n${cyan("  [3/4] Creating directories...")}`);
  createDirectories();

  // 4. Environment
  console.log(`\n${cyan("  [4/4] Environment file...")}`);
  const envReady = setupEnvFile();

  // Summary
  console.log(`\n${bold("  Next Steps:")}`);
  console.log(dim("  ----------"));

  const steps: string[] = [];

  if (!gitOk) {
    steps.push(`Connect to official repo for updates: ${cyan("bun run upgrade")}`);
  }

  if (!envReady) {
    steps.push(`Edit .env with your API keys: ${cyan("$EDITOR .env")}`);
  }

  if (!claudeOk) {
    steps.push(
      `Install Claude CLI (optional): ${cyan("npm install -g @anthropic-ai/claude-code")}`
    );
  }

  steps.push(`Verify configuration: ${cyan("bun run setup:verify")}`);
  steps.push(`Test Telegram connection: ${cyan("bun run test:telegram")}`);
  steps.push(`Test Supabase connection: ${cyan("bun run test:supabase")}`);
  if (process.platform === "darwin") {
    steps.push(`Configure launchd services: ${cyan("bun run setup:launchd -- --service all")}`);
  } else {
    steps.push(`Configure services: ${cyan("bun run setup:services -- --service all")}`);
  }
  steps.push(`Start the bot: ${cyan("bun run start")}`);

  steps.forEach((step, i) => {
    console.log(`  ${i + 1}. ${step}`);
  });

  console.log("");
}

if (import.meta.main) main().catch((err) => {
  console.error(`\n  ${red("Fatal error:")} ${err.message}`);
  process.exit(1);
});
