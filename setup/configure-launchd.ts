/**
 * Go Telegram Bot - launchd Configuration
 *
 * Generates plist files from templates, replaces placeholders,
 * installs to ~/Library/LaunchAgents, and loads services.
 *
 * Usage:
 *   bun run setup/configure-launchd.ts --service telegram-relay
 *   bun run setup/configure-launchd.ts --service all
 *
 * Services: telegram-relay, smart-checkin, morning-briefing, watchdog, supabase, all
 * („all“ nimmt supabase nur mit, wenn SUPABASE_URL in der .env auf das
 * Supabase dieses Rechners zeigt, Issue #165)
 *
 * Importsicher: main() läuft nur als Skript (import.meta.main). Die
 * Einrichtung (src/setup/steps/autostart.ts) ruft configureService mit
 * eigenen Pfaden und Befehlen auf, Tests mit Attrappen.
 *
 * Dienste heißen ai.tybo.<dienst> (Issue #101). Dienste anderer Namen
 * fasst configureService nie an (Issue #142).
 *
 * Ist der neue Dienst mit unveränderter Plist schon geladen, lädt
 * configureService ihn nicht neu; lässt sich das nicht feststellen
 * (launchctl list scheitert), bricht es ab, ohne etwas anzufassen. Weicht
 * seine Plist ab und lässt er sich nicht entladen, bricht configureService
 * ab: seine Plist bleibt, wie sie ist, und kein Dienst wird geladen.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { readEnvFile } from "../src/lib/env-file";
import { labelInLaunchctlList, launchdLabel, SUPABASE_SERVICE } from "../src/lib/service-names";
import { isLocalSupabaseUrl, LAUNCHD_EXIT_TIMEOUT_S } from "../src/setup/local-supabase";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = dirname(import.meta.dir);
const LAUNCH_AGENTS_DIR = join(process.env.HOME!, "Library", "LaunchAgents");

export const SERVICES = ["telegram-relay", "smart-checkin", "morning-briefing", "watchdog", "whatsapp-gateway", "cloudflare-tunnel", "supabase"] as const;
export type ServiceName = (typeof SERVICES)[number];

/**
 * Zeitgrenze für launchctl unload ai.tybo.supabase: launchd wartet bis zu
 * ExitTimeOut (LAUNCHD_EXIT_TIMEOUT_S), bis ein laufender Start kontrolliert
 * beendet ist; der Aufruf darf nicht vorher abbrechen
 */
export const SUPABASE_UNLOAD_TIMEOUT_MS = LAUNCHD_EXIT_TIMEOUT_S * 1000 + 60_000;

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

/** Alles, was nach außen greift; in Tests durch Attrappen ersetzbar */
export interface LaunchdDeps {
  projectRoot: string;
  launchAgentsDir: string;
  home: string;
  /** timeoutMs: Zeitgrenze, wo der Aufruf länger dauern darf (launchctl unload ai.tybo.supabase) */
  run(cmd: string[], options?: { timeoutMs?: number }): Promise<{ ok: boolean; stdout: string; stderr: string }>;
  exists(path: string): boolean;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  mkdir(path: string): void;
  log(line: string): void;
}

export function defaultLaunchdDeps(): LaunchdDeps {
  return {
    projectRoot: PROJECT_ROOT,
    launchAgentsDir: LAUNCH_AGENTS_DIR,
    home: process.env.HOME!,
    run: runCommand,
    exists: existsSync,
    readFile: path => readFileSync(path, "utf-8"),
    writeFile: (path, content) => writeFileSync(path, content, "utf-8"),
    mkdir: path => mkdirSync(path, { recursive: true }),
    log: line => console.log(line),
  };
}

export function plistPathFor(service: ServiceName, launchAgentsDir: string): string {
  return join(launchAgentsDir, `${launchdLabel(service)}.plist`);
}

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

async function resolvePath(cmd: string, deps: LaunchdDeps): Promise<string> {
  const result = await deps.run(["which", cmd]);
  return result.ok ? result.stdout : "";
}

function loadSchedule(deps: LaunchdDeps): ScheduleConfig {
  const schedulePath = join(deps.projectRoot, "config", "schedule.json");
  const examplePath = join(deps.projectRoot, "config", "schedule.example.json");

  if (deps.exists(schedulePath)) {
    try {
      return JSON.parse(deps.readFile(schedulePath));
    } catch {
      deps.log(`  ${yellow("!")} Could not parse config/schedule.json, using defaults`);
    }
  }

  if (deps.exists(examplePath)) {
    try {
      return JSON.parse(deps.readFile(examplePath));
    } catch {
      // fall through to defaults
    }
  }

  // Defaults
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

function generateCalendarIntervalsXml(intervals: ScheduleInterval[]): string {
  return intervals
    .map((interval) => {
      const parts: string[] = [];
      if (interval.hour !== undefined) {
        parts.push(`            <key>Hour</key>\n            <integer>${interval.hour}</integer>`);
      }
      if (interval.minute !== undefined) {
        parts.push(
          `            <key>Minute</key>\n            <integer>${interval.minute}</integer>`
        );
      }
      return `        <dict>\n${parts.join("\n")}\n        </dict>`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Service Configuration
// ---------------------------------------------------------------------------

/** Geladen laut `launchctl list`; null, wenn sich das nicht lesen ließ */
async function isLoaded(label: string, deps: LaunchdDeps): Promise<boolean | null> {
  const list = await deps.run(["launchctl", "list"]);
  return list.ok ? labelInLaunchctlList(list.stdout, label) : null;
}

export async function configureService(service: ServiceName, deps: LaunchdDeps = defaultLaunchdDeps()): Promise<boolean> {
  const label = launchdLabel(service);
  const templatePath = join(deps.projectRoot, "launchd", `${label}.plist.template`);
  const plistPath = plistPathFor(service, deps.launchAgentsDir);
  const log = deps.log;

  log(`\n  ${bold(service)}`);

  // Check template exists
  if (!deps.exists(templatePath)) {
    log(`  ${FAIL} Template not found: launchd/${label}.plist.template`);
    return false;
  }

  // Resolve paths
  const bunPath = await resolvePath("bun", deps);
  if (!bunPath) {
    log(`  ${FAIL} Could not find bun in PATH`);
    return false;
  }

  const claudePath = await resolvePath("claude", deps);
  const bunDir = dirname(bunPath);
  const claudeDir = claudePath ? dirname(claudePath) : "/usr/local/bin";
  const home = deps.home;

  // Load schedule config
  const schedule = loadSchedule(deps);

  // Read template
  let content = deps.readFile(templatePath);

  // Replace common placeholders
  content = content.replace(/\{\{BUN_PATH\}\}/g, bunPath);
  content = content.replace(/\{\{HOME\}\}/g, home);
  content = content.replace(/\{\{PROJECT_ROOT\}\}/g, deps.projectRoot);
  content = content.replace(/\{\{BUN_DIR\}\}/g, bunDir);
  content = content.replace(/\{\{CLAUDE_DIR\}\}/g, claudeDir);
  content = content.replace(/\{\{EXIT_TIMEOUT\}\}/g, String(LAUNCHD_EXIT_TIMEOUT_S));

  // Service-specific placeholders
  if (service === "cloudflare-tunnel") {
    const cloudflaredPath = await resolvePath("cloudflared", deps);
    if (!cloudflaredPath) {
      log(`  ${FAIL} Could not find cloudflared in PATH — install with: brew install cloudflared`);
      return false;
    }
    content = content.replace(/\{\{CLOUDFLARED_PATH\}\}/g, cloudflaredPath);
    log(`    Tunnel und Host aus der cloudflared-Konfiguration (z. B. wa.example.com → localhost:3001)`);
  }

  if (service === "smart-checkin") {
    const intervals = schedule.check_in_intervals || [
      { hour: 10, minute: 30 },
      { hour: 12, minute: 30 },
      { hour: 14, minute: 30 },
      { hour: 16, minute: 30 },
      { hour: 18, minute: 30 },
    ];
    const xml = generateCalendarIntervalsXml(intervals);
    content = content.replace(/\{\{CALENDAR_INTERVALS\}\}/g, xml);
    log(`    Schedule: ${intervals.length} check-in intervals`);
  }

  if (service === "morning-briefing") {
    const briefing = schedule.morning_briefing || { hour: 9, minute: 0 };
    content = content.replace(/\{\{BRIEFING_HOUR\}\}/g, String(briefing.hour));
    content = content.replace(/\{\{BRIEFING_MINUTE\}\}/g, String(briefing.minute));
    log(
      `    Schedule: ${String(briefing.hour).padStart(2, "0")}:${String(briefing.minute).padStart(2, "0")} daily`
    );
  }

  const existed = deps.exists(plistPath);
  const previous = existed ? deps.readFile(plistPath) : null;

  // Unveränderte Plist: ob der neue Dienst schon geladen ist, muss feststehen.
  // Ist das unklar, abbrechen, bevor irgendein Dienst entladen oder geladen wird
  const unchangedLoaded = previous === content ? await isLoaded(label, deps) : false;
  if (unchangedLoaded === null) {
    log(`  ${FAIL} State unknown: launchctl list failed, ${label} may be loaded, nothing changed`);
    return false;
  }

  // Schon eingerichtet und geladen: nicht neu laden (würde den Dienst neu starten)
  if (unchangedLoaded) {
    log(`  ${PASS} Unchanged and loaded: ${label}`);
    return true;
  }

  if (previous !== content) {
    // Unload existing if present. Bleibt er geladen oder ist sein Zustand
    // unklar, nichts überschreiben und nichts laden
    if (existed) {
      log(`    Unloading existing service...`);
      // Ein laufender Supabase-Start braucht zum Beenden bis zu ExitTimeOut
      const unload = await deps.run(["launchctl", "unload", plistPath], service === SUPABASE_SERVICE ? { timeoutMs: SUPABASE_UNLOAD_TIMEOUT_MS } : undefined);
      if (!unload.ok && (await isLoaded(label, deps)) !== false) {
        log(`  ${FAIL} Existing unload failed: ${label} is still loaded, nothing changed`);
        return false;
      }
    }

    // Ensure LaunchAgents directory exists
    if (!deps.exists(deps.launchAgentsDir)) {
      deps.mkdir(deps.launchAgentsDir);
    }

    deps.writeFile(plistPath, content);
    log(`  ${PASS} Written: ${dim(plistPath)}`);
  }

  // Load service
  const loadResult = await deps.run(["launchctl", "load", plistPath]);
  if (loadResult.ok) {
    log(`  ${PASS} Loaded: ${label}`);
  } else {
    log(`  ${FAIL} Load failed: ${loadResult.stderr}`);
    return false;
  }

  // Check status
  const listResult = await deps.run(["launchctl", "list"]);
  if (listResult.ok && labelInLaunchctlList(listResult.stdout, label)) {
    log(`  ${PASS} Status: running`);
  } else {
    log(`  ${yellow("!")} Status: loaded but not yet running ${dim("(may start on schedule)")}`);
  }

  return true;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log(bold("  Go Telegram Bot - launchd Configuration"));
  console.log(dim("  ========================================"));

  if (process.platform !== "darwin") {
    console.log(`\n  ${red("launchd is macOS-only.")}`);
    console.log(`  On Windows/Linux, use: ${cyan("bun run setup/configure-services.ts --service all")}`);
    process.exit(1);
  }

  // Parse --service flag
  const args = process.argv.slice(2);
  const serviceIdx = args.indexOf("--service");
  const serviceArg = serviceIdx !== -1 ? args[serviceIdx + 1] : undefined;

  if (!serviceArg) {
    console.log(`\n  ${red("Missing --service flag")}`);
    console.log(`\n  Usage:`);
    console.log(`    bun run setup/configure-launchd.ts --service telegram-relay`);
    console.log(`    bun run setup/configure-launchd.ts --service all`);
    console.log(`\n  Available services:`);
    for (const s of SERVICES) {
      console.log(`    - ${s}`);
    }
    console.log(`    - all`);
    process.exit(1);
  }

  // Determine which services to configure
  const targets = await selectServices(serviceArg, join(PROJECT_ROOT, ".env"));
  if (!targets) {
    console.log(`\n  ${red(`Unknown service: ${serviceArg}`)}`);
    console.log(`  Valid options: ${SERVICES.join(", ")}, all`);
    process.exit(1);
  }

  console.log(
    `\n  Configuring ${targets.length} service${targets.length > 1 ? "s" : ""}: ${cyan(targets.join(", "))}`
  );
  console.log(`  Project root: ${dim(PROJECT_ROOT)}`);

  let successCount = 0;
  let failCount = 0;

  for (const service of targets) {
    const ok = await configureService(service);
    if (ok) successCount++;
    else failCount++;
  }

  // Summary
  console.log(`\n${bold("  Summary:")}`);
  console.log(`  ${PASS} ${successCount} service${successCount !== 1 ? "s" : ""} configured`);
  if (failCount > 0) {
    console.log(`  ${FAIL} ${failCount} service${failCount !== 1 ? "s" : ""} failed`);
  }

  console.log(`\n  Useful commands:`);
  console.log(`    Check status:  ${cyan("launchctl list | grep ai.tybo")}`);
  console.log(`    View logs:     ${cyan(`tail -f ${PROJECT_ROOT}/logs/*.log`)}`);
  console.log(`    Unload all:    ${cyan("bun run uninstall")}`);
  console.log("");
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`\n  ${red("Fatal error:")} ${err.message}`);
    process.exit(1);
  });
}
