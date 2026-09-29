/**
 * Go Telegram Bot - Cross-Platform Service Configuration
 *
 * Sets up background services using PM2 (daemon) and
 * OS-native scheduling (periodic scripts).
 *
 * - macOS: Redirects to configure-launchd.ts
 * - Windows: PM2 for daemon + Task Scheduler for periodic scripts
 * - Linux: PM2 for daemon + cron for periodic scripts
 *
 * Usage:
 *   bun run setup/configure-services.ts --service telegram-relay
 *   bun run setup/configure-services.ts --service all
 *
 * Services: telegram-relay, smart-checkin, morning-briefing, watchdog, supabase, all
 *
 * supabase (Issue #165): PM2-Prozess tybo-supabase, der über die Hülle
 * scripts/run-once-and-stay.ts einmal `tybo datenbank start` ausführt und
 * danach ohne Arbeit stehen bleibt (autorestart aus). Nur so startet PM2 ihn
 * nach „pm2 save“ beim Hochfahren wieder; ein beendeter Eintrag („stopped“)
 * bliebe gestoppt. „all“ nimmt ihn nur mit, wenn SUPABASE_URL auf das
 * Supabase dieses Rechners zeigt.
 *
 * Importsicher: main() läuft nur als Skript (import.meta.main). Die
 * Einrichtung (src/setup/steps/autostart.ts) ruft configurePM2Service mit
 * eigenem PM2-Aufruf (ohne npx, damit nichts nachinstalliert wird) und
 * eigenen Pfaden auf, Tests mit Attrappen.
 *
 * PM2-Prozesse heißen tybo-<dienst> (Issue #101, #142); Prozesse anderer
 * Namen bleiben unberührt. Läuft schon ein tybo-<dienst>, wird er vor dem
 * Start entfernt; scheitert das, startet nichts. Danach sichert „pm2 save“
 * die Liste für den Neustart des Rechners. Windows-Aufgaben (Go-<dienst>)
 * und cron-Markierungen (# go-<dienst>) behalten ihre Namen: ohne Umstieg
 * liefen bestehende Einträge sonst doppelt.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { readEnvFile } from "../src/lib/env-file";
import { PM2_PREFIX as TYBO_PM2_PREFIX, pm2Name as tyboPm2Name, SUPABASE_SERVICE, SUPABASE_START_STATE } from "../src/lib/service-names";
import { isLocalSupabaseUrl, PM2_KILL_TIMEOUT_MS } from "../src/setup/local-supabase";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = dirname(import.meta.dir);
export const SERVICES = ["telegram-relay", "smart-checkin", "morning-briefing", "watchdog", "supabase"] as const;
export type ServiceName = (typeof SERVICES)[number];

/** Hülle für tybo-supabase: einmal ausführen, dann stehen bleiben */
export const ONCE_WRAPPER = "scripts/run-once-and-stay.ts";

/**
 * PM2-Optionen für tybo-supabase: kein Neustart durch PM2, und beim Beenden
 * die volle Frist für Bereinigung, Schutz-Stopp und Nachprüfung, bevor PM2
 * SIGKILL schickt (Nachweis: scripts/pm2-stop-proof.ts)
 */
export const SUPABASE_PM2_OPTIONS = ["--no-autorestart", "--kill-timeout", String(PM2_KILL_TIMEOUT_MS)];

/** Zeitgrenze für pm2 delete tybo-supabase: wartet bis zu PM2_KILL_TIMEOUT_MS */
export const SUPABASE_DELETE_TIMEOUT_MS = PM2_KILL_TIMEOUT_MS + 60_000;

/**
 * Dienste zu --service: ein bekannter Name genau so, „all“ alle, den
 * Supabase-Dienst aber nur, wenn SUPABASE_URL in der .env (envPath) auf das
 * Supabase dieses Rechners zeigt (Issue #165); fehlt die .env oder die
 * Adresse, ohne ihn. null bei unbekanntem Namen. Startet nichts.
 */
export async function selectServices(serviceArg: string, envPath: string): Promise<ServiceName[] | null> {
  if (serviceArg === "all") {
    const env = await readEnvFile(envPath).catch(() => ({}) as Record<string, string>);
    return SERVICES.filter(s => s !== SUPABASE_SERVICE || isLocalSupabaseUrl(env.SUPABASE_URL));
  }
  return SERVICES.includes(serviceArg as ServiceName) ? [serviceArg as ServiceName] : null;
}

/** PM2-Aufruf und Pfade; in Tests durch Attrappen ersetzbar */
export interface Pm2Deps {
  projectRoot: string;
  /** Befehl für PM2, etwa ["npx", "pm2"] oder ["pm2"] */
  pm2: string[];
  /** timeoutMs: Zeitgrenze, wo der Aufruf länger dauern darf (pm2 delete tybo-supabase) */
  run(cmd: string[], options?: { timeoutMs?: number }): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  log(line: string): void;
}

export function defaultPm2Deps(): Pm2Deps {
  return { projectRoot: PROJECT_ROOT, pm2: ["npx", "pm2"], run: runCommand, log: line => console.log(line) };
}

export const PM2_PREFIX = TYBO_PM2_PREFIX;

interface ScheduleInterval {
  hour?: number;
  minute?: number;
}

interface ScheduleConfig {
  morning_briefing?: {
    hour: number;
    minute: number;
    enabled: boolean;
  };
  check_in_intervals?: ScheduleInterval[];
}

// Daemon services (always-running) vs periodic (scheduled); supabase läuft
// als einmaliger PM2-Prozess (Issue #165), braucht also auch PM2
export const DAEMON_SERVICES: ServiceName[] = ["telegram-relay", "watchdog", "supabase"];
const PERIODIC_SERVICES: ServiceName[] = ["smart-checkin", "morning-briefing"];

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

async function runCommand(
  cmd: string[]
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const proc = Bun.spawn(cmd, {
      cwd: PROJECT_ROOT,
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

function loadSchedule(): ScheduleConfig {
  const schedulePath = join(PROJECT_ROOT, "config", "schedule.json");
  const examplePath = join(PROJECT_ROOT, "config", "schedule.example.json");

  if (existsSync(schedulePath)) {
    try {
      return JSON.parse(readFileSync(schedulePath, "utf-8"));
    } catch {
      console.log(`  ${yellow("!")} Could not parse config/schedule.json, using defaults`);
    }
  }

  if (existsSync(examplePath)) {
    try {
      return JSON.parse(readFileSync(examplePath, "utf-8"));
    } catch {}
  }

  return {
    morning_briefing: { hour: 9, minute: 0, enabled: true },
    check_in_intervals: [
      { hour: 10, minute: 30 },
      { hour: 12, minute: 30 },
      { hour: 14, minute: 30 },
      { hour: 16, minute: 30 },
      { hour: 18, minute: 30 },
    ],
  };
}

function getScriptPath(service: ServiceName, projectRoot = PROJECT_ROOT): string {
  const scriptMap: Record<ServiceName, string> = {
    "telegram-relay": "src/bot.ts",
    "smart-checkin": "src/smart-checkin.ts",
    "morning-briefing": "src/morning-briefing.ts",
    watchdog: "src/watchdog.ts",
    supabase: "scripts/tybo.ts",
  };
  return join(projectRoot, scriptMap[service]);
}

// ---------------------------------------------------------------------------
// PM2 Configuration (daemon services)
// ---------------------------------------------------------------------------

async function checkPM2(): Promise<boolean> {
  const result = await runCommand(["npx", "pm2", "--version"]);
  if (!result.ok) {
    console.log(`  ${FAIL} PM2 not found. Install with: ${cyan("npm install -g pm2")}`);
    return false;
  }
  console.log(`  ${PASS} PM2: v${result.stdout}`);
  return true;
}

/** Namen der Prozesse aus `pm2 jlist`; null, wenn die Liste nicht lesbar ist */
export async function pm2ProcessNames(deps: Pm2Deps): Promise<string[] | null> {
  const list = await deps.run([...deps.pm2, "jlist"]);
  if (!list.ok) return null;
  try {
    const parsed = JSON.parse(list.stdout);
    return Array.isArray(parsed) ? parsed.map((p: any) => String(p?.name ?? "")) : null;
  } catch {
    return null;
  }
}

export async function configurePM2Service(service: ServiceName, deps: Pm2Deps = defaultPm2Deps()): Promise<boolean> {
  const pm2Name = tyboPm2Name(service);
  const scriptPath = getScriptPath(service, deps.projectRoot);
  const logPath = join(deps.projectRoot, "logs", `${service}.log`);
  const log = deps.log;
  // Supabase (Issue #165): PM2-Optionen vor dem Trenner „--“, dahinter nur die
  // Argumente für bun. Die Hülle run-once-and-stay führt tybo datenbank start
  // einmal aus und bleibt dann stehen: nur ein laufender Eintrag startet nach
  // pm2 save beim Hochfahren wieder. SUPABASE_PM2_OPTIONS: kein Neustart durch
  // PM2, lange Frist beim Beenden. --state: Startzustand und Exit-Code für die
  // Gesamtprüfung
  const startArgs =
    service === SUPABASE_SERVICE
      ? [
          ...deps.pm2, "start", "bun",
          "--name", pm2Name,
          ...SUPABASE_PM2_OPTIONS,
          "--output", logPath,
          "--error", logPath,
          "--merge-logs",
          "--", "--no-env-file", join(deps.projectRoot, ONCE_WRAPPER),
          "--state", join(deps.projectRoot, SUPABASE_START_STATE),
          scriptPath, "datenbank", "start",
        ]
      : [
          ...deps.pm2, "start", "bun",
          "--name", pm2Name,
          "--", "run", scriptPath,
          "--output", logPath,
          "--error", logPath,
          "--merge-logs",
        ];

  log(`\n  ${bold(service)} (PM2 daemon)`);

  // Prozesse anderer Namen bleiben unberührt (Issue #142)
  const names = await pm2ProcessNames(deps);
  if (names === null) {
    log(`  ${FAIL} PM2 list unreadable (pm2 jlist), nothing changed`);
    return false;
  }

  // Vorhandenen neuen Prozess entfernen; bleibt er, startet kein weiterer
  if (names.includes(pm2Name)) {
    // Ein laufender Supabase-Start braucht zum Beenden bis zu PM2_KILL_TIMEOUT_MS
    const removed = await deps.run([...deps.pm2, "delete", pm2Name], service === SUPABASE_SERVICE ? { timeoutMs: SUPABASE_DELETE_TIMEOUT_MS } : undefined);
    if (!removed.ok) {
      log(`  ${FAIL} Existing delete failed: ${pm2Name} may still be running, nothing started`);
      return false;
    }
  }

  // Start with PM2
  const result = await deps.run(startArgs);

  if (result.ok) {
    log(`  ${PASS} Started: ${pm2Name}`);
    return true;
  } else {
    log(`  ${FAIL} Start failed: ${result.stderr}`);
    return false;
  }
}

/** „pm2 save“: sichert die Prozessliste für den Neustart des Rechners */
export async function savePM2(deps: Pm2Deps): Promise<boolean> {
  const save = await deps.run([...deps.pm2, "save"]);
  if (!save.ok) deps.log(`  ${FAIL} pm2 save failed: after a reboot the services are missing. Run "pm2 save" once.`);
  return save.ok;
}

// ---------------------------------------------------------------------------
// Windows Task Scheduler (periodic services)
// ---------------------------------------------------------------------------

async function configureWindowsTask(
  service: ServiceName,
  schedule: ScheduleConfig
): Promise<boolean> {
  const taskName = `Go-${service}`;
  const scriptPath = getScriptPath(service);
  const bunPath = "bun"; // Assumes bun is in PATH

  console.log(`\n  ${bold(service)} (Task Scheduler)`);

  // Delete existing task
  await runCommand(["schtasks", "/Delete", "/TN", taskName, "/F"]);

  if (service === "morning-briefing") {
    const briefing = schedule.morning_briefing || { hour: 9, minute: 0 };
    const time = `${String(briefing.hour).padStart(2, "0")}:${String(briefing.minute).padStart(2, "0")}`;

    const result = await runCommand([
      "schtasks", "/Create", "/TN", taskName,
      "/TR", `${bunPath} run ${scriptPath}`,
      "/SC", "DAILY",
      "/ST", time,
      "/F",
    ]);

    if (result.ok) {
      console.log(`  ${PASS} Scheduled daily at ${time}`);
      return true;
    } else {
      console.log(`  ${FAIL} Failed: ${result.stderr}`);
      return false;
    }
  }

  if (service === "smart-checkin") {
    const intervals = schedule.check_in_intervals || [
      { hour: 10, minute: 30 },
      { hour: 14, minute: 30 },
      { hour: 18, minute: 30 },
    ];

    // Windows Task Scheduler doesn't support multiple calendar intervals natively.
    // Create one task per interval.
    let allOk = true;
    for (let i = 0; i < intervals.length; i++) {
      const interval = intervals[i];
      const subTaskName = `${taskName}-${i + 1}`;
      const time = `${String(interval.hour || 0).padStart(2, "0")}:${String(interval.minute || 0).padStart(2, "0")}`;

      const result = await runCommand([
        "schtasks", "/Create", "/TN", subTaskName,
        "/TR", `${bunPath} run ${scriptPath}`,
        "/SC", "DAILY",
        "/ST", time,
        "/F",
      ]);

      if (result.ok) {
        console.log(`    ${PASS} Check-in #${i + 1}: ${time}`);
      } else {
        console.log(`    ${FAIL} Check-in #${i + 1} failed: ${result.stderr}`);
        allOk = false;
      }
    }
    return allOk;
  }

  // Watchdog: run every hour
  const result = await runCommand([
    "schtasks", "/Create", "/TN", taskName,
    "/TR", `${bunPath} run ${scriptPath}`,
    "/SC", "HOURLY",
    "/F",
  ]);

  if (result.ok) {
    console.log(`  ${PASS} Scheduled hourly`);
    return true;
  } else {
    console.log(`  ${FAIL} Failed: ${result.stderr}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Linux Cron (periodic services)
// ---------------------------------------------------------------------------

async function configureLinuxCron(
  service: ServiceName,
  schedule: ScheduleConfig
): Promise<boolean> {
  const scriptPath = getScriptPath(service);
  const logPath = join(PROJECT_ROOT, "logs", `${service}.log`);

  console.log(`\n  ${bold(service)} (cron)`);

  // Read current crontab
  const currentCron = await runCommand(["crontab", "-l"]);
  let cronLines = currentCron.ok ? currentCron.stdout.split("\n") : [];

  // Remove existing Go entries for this service
  const marker = `# go-${service}`;
  cronLines = cronLines.filter((l) => !l.includes(marker));

  const bunCmd = `cd ${PROJECT_ROOT} && bun run ${scriptPath} >> ${logPath} 2>&1 ${marker}`;

  if (service === "morning-briefing") {
    const briefing = schedule.morning_briefing || { hour: 9, minute: 0 };
    cronLines.push(`${briefing.minute} ${briefing.hour} * * * ${bunCmd}`);
    console.log(`  ${PASS} Scheduled daily at ${briefing.hour}:${String(briefing.minute).padStart(2, "0")}`);
  } else if (service === "smart-checkin") {
    const intervals = schedule.check_in_intervals || [
      { hour: 10, minute: 30 },
      { hour: 14, minute: 30 },
      { hour: 18, minute: 30 },
    ];
    for (const interval of intervals) {
      cronLines.push(`${interval.minute || 0} ${interval.hour || 0} * * * ${bunCmd}`);
    }
    console.log(`  ${PASS} Scheduled ${intervals.length} check-in intervals`);
  } else {
    // watchdog: every hour
    cronLines.push(`0 * * * * ${bunCmd}`);
    console.log(`  ${PASS} Scheduled hourly`);
  }

  // Write updated crontab
  const newCron = cronLines.filter(Boolean).join("\n") + "\n";
  const tmpFile = join(PROJECT_ROOT, "temp", ".crontab.tmp");
  writeFileSync(tmpFile, newCron);
  const result = await runCommand(["crontab", tmpFile]);

  if (result.ok) {
    return true;
  } else {
    console.log(`  ${FAIL} Failed to update crontab: ${result.stderr}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log(bold("  Go Telegram Bot - Service Configuration"));
  console.log(dim("  ========================================"));

  if (process.platform === "darwin") {
    console.log(`\n  macOS detected. Use: ${cyan("bun run setup:launchd -- --service all")}`);
    process.exit(0);
  }

  // Parse --service flag
  const args = process.argv.slice(2);
  const serviceIdx = args.indexOf("--service");
  const serviceArg = serviceIdx !== -1 ? args[serviceIdx + 1] : undefined;

  if (!serviceArg) {
    console.log(`\n  ${red("Missing --service flag")}`);
    console.log(`\n  Usage:`);
    console.log(`    bun run setup/configure-services.ts --service telegram-relay`);
    console.log(`    bun run setup/configure-services.ts --service all`);
    console.log(`\n  Available services:`);
    for (const s of SERVICES) {
      console.log(`    - ${s}`);
    }
    console.log(`    - all`);
    process.exit(1);
  }

  const targets = await selectServices(serviceArg, join(PROJECT_ROOT, ".env"));
  if (!targets) {
    console.log(`\n  ${red(`Unknown service: ${serviceArg}`)}`);
    console.log(`  Valid options: ${SERVICES.join(", ")}, all`);
    process.exit(1);
  }

  const platform = process.platform === "win32" ? "Windows" : "Linux";
  console.log(`\n  Platform: ${cyan(platform)}`);
  console.log(`  Project root: ${dim(PROJECT_ROOT)}`);
  console.log(`  Configuring: ${cyan(targets.join(", "))}`);

  // Ensure logs directory exists
  const logsDir = join(PROJECT_ROOT, "logs");
  if (!existsSync(logsDir)) {
    mkdirSync(logsDir, { recursive: true });
  }

  // Check PM2 for daemon services
  const hasDaemon = targets.some((t) => DAEMON_SERVICES.includes(t));
  if (hasDaemon) {
    const pm2Ok = await checkPM2();
    if (!pm2Ok) {
      console.log(`\n  ${red("PM2 is required for daemon services (telegram-relay, watchdog, supabase).")}`);
      console.log(`  Install: ${cyan("npm install -g pm2")}`);
      process.exit(1);
    }
  }

  const schedule = loadSchedule();
  let successCount = 0;
  let failCount = 0;

  for (const service of targets) {
    let ok: boolean;

    if (DAEMON_SERVICES.includes(service)) {
      ok = await configurePM2Service(service);
    } else if (process.platform === "win32") {
      ok = await configureWindowsTask(service, schedule);
    } else {
      ok = await configureLinuxCron(service, schedule);
    }

    if (ok) successCount++;
    else failCount++;
  }

  // Save PM2 state if any daemon services were configured
  if (hasDaemon && (await savePM2(defaultPm2Deps()))) {
    console.log(`\n  ${dim("PM2 state saved. Use 'pm2 startup' to auto-start on boot.")}`);
  }

  // Summary
  console.log(`\n${bold("  Summary:")}`);
  console.log(`  ${PASS} ${successCount} service${successCount !== 1 ? "s" : ""} configured`);
  if (failCount > 0) {
    console.log(`  ${FAIL} ${failCount} service${failCount !== 1 ? "s" : ""} failed`);
  }

  console.log(`\n  Useful commands:`);
  console.log(`    Check PM2 status:  ${cyan("npx pm2 status")}`);
  console.log(`    View PM2 logs:     ${cyan("npx pm2 logs")}`);
  console.log(`    Restart service:   ${cyan(`npx pm2 restart ${tyboPm2Name("telegram-relay")}`)}`);
  if (process.platform === "win32") {
    console.log(`    List tasks:        ${cyan("schtasks /Query /TN Go-*")}`);
  } else {
    console.log(`    View cron:         ${cyan("crontab -l")}`);
  }
  console.log(`    Uninstall all:     ${cyan("bun run uninstall")}`);
  console.log("");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n  ${red("Fatal error:")} ${err.message}`);
    process.exit(1);
  });
}
