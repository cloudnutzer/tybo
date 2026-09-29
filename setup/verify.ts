/**
 * Full Health Check
 *
 * Verifies environment variables, API connectivity,
 * launchd services, and optional integrations.
 *
 * Kanäle (Issue #228, Entscheidung 0021): Pflicht ist Telegram oder die
 * WebUI, geprüft mit checkChannels (src/setup/channels.ts) wie beim Start und
 * in der Einrichtung. Ohne Telegram, aber mit bereitem Kanal, sind Telegram,
 * getMe und die Agenten-Tokens „übersprungen“ (kein Aufruf an
 * api.telegram.org, auch bei übrig gebliebenen Agenten-Tokens). Halbes
 * Telegram oder kein Kanal ist ein Fehler. verifyChannels ist mit Env und
 * fetch testbar.
 *
 * Usage: bun run setup/verify.ts
 */

import { existsSync, readFileSync } from "fs";
import { userInfo } from "os";
import { join, dirname } from "path";
import { BRAND } from "../src/brand";
import { loadEnv } from "../src/lib/env";
import { checkChannels } from "../src/setup/channels";
import { supabaseHeaders } from "../src/lib/supabase-keys";
import { findLaunchctlLine, pm2Name, SUPABASE_SERVICE, SUPABASE_START_STATE } from "../src/lib/service-names";
import { DB_CONTAINER, isLocalSupabaseUrl, PROJECT_LABEL } from "../src/setup/local-supabase";
import { lingerCheckCommand, lingerCommand, parseShow, SYSTEMD_UNIT, SYSTEMD_UNIT_FILE, SYSTEMD_USER_DIR } from "./configure-systemd";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PROJECT_ROOT = dirname(import.meta.dir);

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
const WARN = yellow("~");
const SKIP = dim("-");

export interface CheckResult {
  name: string;
  status: "pass" | "fail" | "warn" | "skip";
  message: string;
}

const results: CheckResult[] = [];

export type Recorder = (name: string, status: CheckResult["status"], message: string) => void;
type Env = Record<string, string | undefined>;
type FetchFn = (input: string) => Promise<Response>;

function record(name: string, status: CheckResult["status"], message: string) {
  results.push({ name, status, message });
  const icon =
    status === "pass" ? PASS : status === "fail" ? FAIL : status === "warn" ? WARN : SKIP;
  console.log(`  ${icon} ${name}: ${message}`);
}

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

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const masked = (value: string) => (value.length > 8 ? value.slice(0, 4) + "..." + value.slice(-4) : "***");

function checkRequiredEnv(env: Env, rec: Recorder) {
  console.log(`\n${cyan("  [1/6] Required Environment Variables")}`);

  // Kanäle (Issue #228): Telegram oder WebUI, halbes Telegram nie
  const channels = checkChannels(env);
  rec("Channels", channels.ready ? "pass" : "fail", channels.message);
  if (channels.telegram.state === "ok") {
    rec("Telegram bot token", "pass", `TELEGRAM_BOT_TOKEN = ${masked(env.TELEGRAM_BOT_TOKEN!.trim())}`);
    rec("Telegram user ID", "pass", `TELEGRAM_USER_ID = ${masked(env.TELEGRAM_USER_ID!.trim())}`);
  } else if (channels.telegram.state === "halb") {
    rec("Telegram", "fail", `${channels.telegram.reason}. Beide Werte setzen oder beide entfernen.`);
  } else {
    rec("Telegram", "skip", channels.ready ? `Übersprungen: nicht eingerichtet, ${BRAND.name} läuft über die WebUI` : "Nicht eingerichtet");
  }
  if (channels.webui.state === "ok") rec("WebUI", "pass", "WEB_ENABLED=true, Passwort gesetzt");
  else if (channels.webui.state === "aus") rec("WebUI", "skip", "Aus (WEB_ENABLED ist nicht true)");
  else rec("WebUI", channels.ready ? "warn" : "fail", `Startet nicht: ${channels.webui.reason}`);

  // Database backend check (Convex or Supabase)
  const convexUrl = env.CONVEX_URL;
  const supabaseUrl = env.SUPABASE_URL;
  const hasConvex = convexUrl && !convexUrl.includes("your_");
  const hasSupabase = supabaseUrl && !supabaseUrl.includes("your_");

  if (hasConvex) {
    rec("Database backend", "pass", `Convex: ${masked(convexUrl!)}`);
  } else if (hasSupabase) {
    rec("Database backend", "pass", `Supabase: ${masked(supabaseUrl!)}`);
  } else {
    rec("Database backend", "fail", "No database configured (set CONVEX_URL or SUPABASE_URL in .env)");
  }
}

async function checkTelegram(env: Env, fetchFn: FetchFn, rec: Recorder) {
  console.log(`\n${cyan("  [2/6] Telegram Connectivity")}`);

  // Nur mit eingerichtetem Telegram (Issue #228): sonst kein Aufruf an api.telegram.org
  if (checkChannels(env).telegram.state !== "ok") {
    rec("Telegram API", "skip", "Übersprungen: Telegram ist nicht eingerichtet");
    return;
  }
  const token = env.TELEGRAM_BOT_TOKEN!.trim();

  try {
    const response = await fetchFn(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await response.json()) as { ok: boolean; result?: { username: string; id: number } };

    if (data.ok && data.result) {
      rec(
        "Telegram API",
        "pass",
        `Bot: @${data.result.username} (ID: ${data.result.id})`
      );
    } else {
      rec("Telegram API", "fail", "getMe returned ok=false - check token");
    }
  } catch (err: any) {
    rec("Telegram API", "fail", `Connection error: ${err.message}`);
  }
}

export async function checkDatabase() {
  console.log(`\n${cyan("  [3/6] Database Connectivity")}`);

  const convexUrl = process.env.CONVEX_URL;
  const supabaseUrl = process.env.SUPABASE_URL;
  const hasConvex = convexUrl && !convexUrl.includes("your_");
  const hasSupabase = supabaseUrl && !supabaseUrl.includes("your_");

  // Convex path
  if (hasConvex) {
    try {
      const { testConnection } = await import("../src/lib/convex");
      const result = await testConnection();
      if (result.includes("OK")) {
        record("Convex connection", "pass", result);
      } else {
        record("Convex connection", "fail", result);
      }
    } catch (err: any) {
      record("Convex connection", "fail", `Import/connection error: ${err.message}`);
    }
    return;
  }

  // Supabase path
  if (hasSupabase) {
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

    if (!key || key.includes("your_")) {
      record("Supabase connection", "fail", "SUPABASE_URL set but no valid key configured");
      return;
    }

    // Test messages table
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/messages?select=id&limit=1`, {
        headers: supabaseHeaders(key),
      });

      if (response.ok) {
        record("Supabase messages table", "pass", "Connected and accessible");
      } else if (response.status === 404) {
        record("Supabase messages table", "fail", "Table not found - run db/schema.sql");
      } else {
        const body = await response.text();
        record("Supabase messages table", "fail", `HTTP ${response.status}: ${body.slice(0, 100)}`);
      }
    } catch (err: any) {
      record("Supabase messages table", "fail", `Connection error: ${err.message}`);
    }

    // Test memory table
    try {
      const response = await fetch(`${supabaseUrl}/rest/v1/memory?select=id&limit=1`, {
        headers: supabaseHeaders(key),
      });

      if (response.ok) {
        record("Supabase memory table", "pass", "Connected and accessible");
      } else if (response.status === 404) {
        record("Supabase memory table", "warn", "Table not found - memory features unavailable");
      } else {
        record("Supabase memory table", "warn", `HTTP ${response.status}`);
      }
    } catch (err: any) {
      record("Supabase memory table", "fail", `Connection error: ${err.message}`);
    }
    return;
  }

  // Neither configured
  record("Database connection", "skip", "No database configured (set up in Phase 2)");
}

async function checkServices() {
  const services = ["telegram-relay", "smart-checkin", "morning-briefing", "watchdog"];

  if (process.platform === "darwin") {
    console.log(`\n${cyan("  [4/6] launchd Services")}`);

    await checkLaunchdServices(services);
  } else {
    console.log(`\n${cyan("  [4/6] Background Services")}`);

    // Bot als systemd-Benutzerdienst (Issue #207): die übrigen Dienste nur
    // über ein installiertes PM2, nie über npx
    if (process.platform === "linux" && (await checkSystemdService())) {
      const rest = services.filter(s => s !== "telegram-relay");
      if ((await runCommand(["pm2", "--version"])).ok) await checkPm2Services(rest, runCommand, record, undefined, ["pm2"]);
      else for (const service of rest) record(service, "skip", "Not installed (PM2 not installed)");
    } else {
      await checkPm2Services(services);
    }
  }
  await checkSupabaseService(process.platform, process.env);
}

/**
 * Supabase auf diesem Rechner (Issue #165), nur wenn SUPABASE_URL darauf
 * zeigt. Zwei Zeilen: der Dienst ai.tybo.supabase ist ein Einmalaufruf (Ende
 * mit Exit 0 ist Erfolg, kein Absturz), tybo-supabase unter PM2 bleibt über
 * die Hülle run-once-and-stay „online“ (gestoppt startet PM2 es beim
 * Hochfahren nicht, siehe setup/configure-services.ts), die Datenbank
 * selbst läuft in Docker (Container supabase_db_tybo). Weil die Hülle auch
 * nach einem gescheiterten Start „online“ bleibt, zählt unter PM2 zusätzlich
 * ihre Zustandsdatei (SUPABASE_START_STATE): nur wenn sie zur PID der Hülle
 * gehört und der Start mit Exit 0 endete (oder noch läuft), ist das Erfolg.
 * `run`, `rec` und `readState` sind in Tests Attrappen.
 */
export async function checkSupabaseService(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  run: typeof runCommand = runCommand,
  rec: typeof record = record,
  readState: () => string | null = () => {
    try {
      return readFileSync(join(PROJECT_ROOT, SUPABASE_START_STATE), "utf-8");
    } catch {
      return null;
    }
  }
): Promise<void> {
  if (!isLocalSupabaseUrl(env.SUPABASE_URL)) return;
  const name = "supabase (Autostart)";
  if (platform === "darwin") {
    const list = await run(["launchctl", "list"]);
    const line = list.ok ? findLaunchctlLine(list.stdout, SUPABASE_SERVICE) : null;
    if (!list.ok) rec(name, "fail", "launchctl list schlug fehl");
    else if (!line) rec(name, "warn", "Nicht eingerichtet: nach einem Neustart fehlt Supabase (tybo setup autostart)");
    else {
      const [pid, exitCode] = line.trim().split(/\s+/);
      if (pid !== "-") rec(name, "pass", `Startet gerade (PID: ${pid})`);
      else if (exitCode === "0") rec(name, "pass", "Eingerichtet, letzter Aufruf erfolgreich (Exit 0)");
      else rec(name, "warn", `Letzter Aufruf fehlgeschlagen (Exit ${exitCode}), siehe logs/supabase.log`);
    }
  } else {
    const jlist = await run(["npx", "pm2", "jlist"]);
    let procs: Array<{ name?: string; pid?: number; pm2_env?: { status?: string } }> | null = null;
    try {
      procs = jlist.ok ? JSON.parse(jlist.stdout) : null;
    } catch {}
    const proc = Array.isArray(procs) ? procs.find(p => p?.name === pm2Name(SUPABASE_SERVICE)) : undefined;
    if (!Array.isArray(procs)) rec(name, "skip", "PM2-Liste nicht lesbar");
    else if (!proc) rec(name, "warn", "Nicht in PM2 eingetragen: nach einem Neustart fehlt Supabase (tybo setup autostart)");
    else if (proc.pm2_env?.status === "online") {
      let state: { pid?: unknown; state?: unknown; exitCode?: unknown } | null = null;
      try {
        state = JSON.parse(readState() ?? "null");
      } catch {}
      if (!state || state.pid !== proc.pid) rec(name, "warn", "Eingerichtet, aber das Ergebnis des letzten Starts ist unbekannt (keine passende Zustandsdatei). Neu eintragen mit tybo setup autostart");
      else if (state.state === "läuft") rec(name, "pass", "Eingerichtet, Supabase startet gerade (Protokoll logs/supabase.log)");
      else if (state.exitCode === 0) rec(name, "pass", "Eingerichtet, letzter Start erfolgreich (Exit 0), startet Supabase bei jedem Hochfahren einmal (Protokoll logs/supabase.log)");
      else rec(name, "warn", `Letzter Start fehlgeschlagen (Exit ${String(state.exitCode)}): Ursache in logs/supabase.log, danach von Hand tybo datenbank start`);
    }
    else rec(name, "warn", `PM2-Status ${proc.pm2_env?.status ?? "unbekannt"}: so startet PM2 Supabase nach einem Neustart nicht. Neu eintragen mit tybo setup autostart`);
  }
  const ps = await run(["docker", "ps", "--filter", `label=${PROJECT_LABEL}`, "--format", "{{.Names}}"]);
  if (!ps.ok) rec("supabase (Datenbank)", "warn", "Docker antwortet nicht");
  else if (ps.stdout.split("\n").some(l => l.trim() === DB_CONTAINER)) rec("supabase (Datenbank)", "pass", `Container ${DB_CONTAINER} läuft`);
  else rec("supabase (Datenbank)", "fail", "Datenbank-Container läuft nicht: tybo datenbank start");
}

/**
 * launchd-Dienste unter ai.tybo.<dienst> (Issue #101). Dienste anderer Namen
 * zählen nicht (Issue #142). `run` und `rec` sind in Tests Attrappen.
 */
export async function checkLaunchdServices(
  services: string[],
  run: typeof runCommand = runCommand,
  rec: typeof record = record,
  readState: () => string | null = () => {
    try {
      return readFileSync(join(PROJECT_ROOT, SUPABASE_START_STATE), "utf-8");
    } catch {
      return null;
    }
  }
): Promise<void> {
  const result = await run(["launchctl", "list"]);
  if (!result.ok) {
    rec("launchctl", "fail", "Could not query launchctl");
    return;
  }

  for (const service of services) {
    const line = findLaunchctlLine(result.stdout, service);

    if (line) {
      const parts = line.trim().split(/\s+/);
      const pid = parts[0];
      const exitCode = parts[1];

      if (pid !== "-") {
        rec(service, "pass", `Running (PID: ${pid})`);
      } else if (exitCode === "0") {
        rec(service, "pass", `Loaded, last exit: 0 ${dim("(waiting for schedule)")}`);
      } else {
        rec(service, "warn", `Loaded but last exit code: ${exitCode}`);
      }
    } else {
      rec(service, "skip", "Not installed");
    }
  }
}

/**
 * Bot als systemd-Benutzerdienst (Issue #207). false: keine Dienstdatei da,
 * dann prüft der Aufrufer wie bisher PM2. Geprüft werden Lauf, Aktivierung
 * und Linger (Start nach einem Neustart ohne Anmeldung). `run`, `rec` und
 * `exists` sind in Tests Attrappen.
 */
export async function checkSystemdService(
  unitDir: string = SYSTEMD_USER_DIR,
  run: typeof runCommand = runCommand,
  rec: typeof record = record,
  user: string = (() => {
    try {
      return userInfo().username;
    } catch {
      return process.env.USER ?? "";
    }
  })(),
  exists: (path: string) => boolean = existsSync
): Promise<boolean> {
  if (!exists(join(unitDir, SYSTEMD_UNIT_FILE))) return false;
  const name = "telegram-relay";
  const show = await run(["systemctl", "--user", "show", SYSTEMD_UNIT_FILE, "--property=ActiveState,SubState,UnitFileState,MainPID"]);
  if (!show.ok) {
    rec(name, "fail", "systemd-Benutzerdienst antwortet nicht (systemctl --user); als normaler Benutzer prüfen, nicht über sudo");
    return true;
  }
  const p = parseShow(show.stdout);
  if (p.ActiveState === "active") rec(name, "pass", `Läuft als systemd-Benutzerdienst ${SYSTEMD_UNIT} (PID: ${p.MainPID ?? "?"})`);
  else if (p.ActiveState === "activating") rec(name, "warn", `systemd startet ${SYSTEMD_UNIT} gerade (neu), siehe logs/telegram-relay.error.log`);
  else rec(name, "fail", `systemd-Status ${p.ActiveState ?? "unbekannt"}: systemctl --user start ${SYSTEMD_UNIT}, Ursache in logs/telegram-relay.error.log`);
  if (p.UnitFileState !== "enabled") rec(`${name} (Autostart)`, "warn", `Nicht aktiviert, startet nicht mit dem Rechner: systemctl --user enable ${SYSTEMD_UNIT}`);
  const linger = await run(["loginctl", "show-user", user, "--property=Linger", "--value"]);
  if (linger.ok && linger.stdout.trim() === "yes") rec(`${name} (Linger)`, "pass", "Startet nach einem Neustart auch ohne Anmeldung");
  else if (linger.ok && linger.stdout.trim() === "no") rec(`${name} (Linger)`, "warn", `Startet nach einem Neustart erst mit der Anmeldung: ${lingerCommand(user)}`);
  // loginctl scheiterte: sudo hilft nicht zwingend, erst prüfen
  else rec(`${name} (Linger)`, "warn", `Ob er nach einem Neustart ohne Anmeldung startet, ließ sich nicht prüfen. Prüfen mit: ${lingerCheckCommand(user)} und systemctl status systemd-logind`);
  return true;
}

/**
 * PM2-Dienste unter tybo-<dienst> (Issue #101). Prozesse anderer Namen zählen
 * nicht (Issue #142). `run` und `rec` sind in Tests Attrappen.
 */
export async function checkPm2Services(
  services: string[],
  run: typeof runCommand = runCommand,
  rec: typeof record = record,
  readState: () => string | null = () => {
    try {
      return readFileSync(join(PROJECT_ROOT, SUPABASE_START_STATE), "utf-8");
    } catch {
      return null;
    }
  },
  pm2: string[] = ["npx", "pm2"]
): Promise<void> {
  const pm2Result = await run([...pm2, "jlist"]);
  if (!pm2Result.ok) {
    rec("PM2", "skip", "PM2 not installed (npm install -g pm2)");
    for (const service of services) {
      rec(service, "skip", "No service manager detected");
    }
    return;
  }
  let pm2List: Array<{ name: string; pm2_env?: { status?: string }; pid?: number }>;
  try {
    pm2List = JSON.parse(pm2Result.stdout);
    if (!Array.isArray(pm2List)) throw new Error("not an array");
  } catch {
    rec("PM2", "warn", "Could not parse PM2 output");
    return;
  }
  for (const service of services) {
    const proc = pm2List.find(p => p?.name === pm2Name(service));
    if (!proc) {
      rec(service, "skip", "Not registered in PM2");
      continue;
    }
    const status = proc.pm2_env?.status || "unknown";
    if (status === "online") {
      rec(service, "pass", `Running via PM2 (PID: ${proc.pid})`);
    } else {
      rec(service, "warn", `PM2 status: ${status}`);
    }
  }
}

async function checkAgentBots(env: Env, fetchFn: FetchFn, rec: Recorder) {
  console.log(`\n${cyan("  [5/6] Multi-Bot Agent Identities (Optional)")}`);

  const agentTokens: [string, string][] = [
    ["TELEGRAM_BOT_TOKEN_RESEARCH", "Research agent bot"],
    ["TELEGRAM_BOT_TOKEN_CONTENT", "Content agent bot"],
    ["TELEGRAM_BOT_TOKEN_FINANCE", "Finance agent bot"],
    ["TELEGRAM_BOT_TOKEN_STRATEGY", "Strategy agent bot"],
    ["TELEGRAM_BOT_TOKEN_CRITIC", "Critic agent bot"],
  ];

  // Ohne Telegram gibt es keine Agenten-Bots (Issue #228), auch bei übrig gebliebenen Tokens: kein getMe
  if (checkChannels(env).telegram.state !== "ok") {
    for (const [, label] of agentTokens) rec(label, "skip", "Übersprungen: Telegram ist nicht eingerichtet");
    return;
  }

  let configured = 0;
  for (const [key, label] of agentTokens) {
    const value = env[key];
    if (!value || value.includes("your_")) {
      rec(label, "skip", "Not configured (will use main bot)");
      continue;
    }

    configured++;
    try {
      const response = await fetchFn(`https://api.telegram.org/bot${value}/getMe`);
      const data = (await response.json()) as { ok: boolean; result?: { username: string; id: number } };
      if (data.ok && data.result) {
        rec(label, "pass", `@${data.result.username} (ID: ${data.result.id})`);
      } else {
        rec(label, "fail", `${key} token invalid — getMe returned ok=false`);
      }
    } catch (err: any) {
      rec(label, "fail", `${key} connection error: ${err.message}`);
    }
  }

  if (configured === 0) {
    console.log(dim(`        No agent bot tokens configured — all agents will use the main bot.`));
    console.log(dim(`        To enable multi-bot identities, see CLAUDE.md Phase 4.`));
  } else {
    console.log(dim(`        ${configured}/5 agent bots configured. Missing ones fall back to main bot.`));
  }
}

/**
 * Kanäle, Telegram und Agenten-Bots (Issue #228) mit übergebener Umgebung,
 * fetch und Aufzeichnung; main() ruft sie mit process.env und fetch.
 */
export async function verifyChannels(env: Env, fetchFn: FetchFn, rec: Recorder): Promise<void> {
  checkRequiredEnv(env, rec);
  await checkTelegram(env, fetchFn, rec);
  await checkAgentBots(env, fetchFn, rec);
}

function checkOptionalIntegrations() {
  console.log(`\n${cyan("  [6/6] Optional Integrations")}`);

  const optional: [string, string][] = [
    ["ELEVENLABS_API_KEY", "ElevenLabs (voice)"],
    ["GEMINI_API_KEY", "Gemini (transcription)"],
    ["OPENROUTER_API_KEY", "OpenRouter (fallback LLM)"],
  ];

  for (const [key, label] of optional) {
    const value = process.env[key];
    if (value && !value.includes("your_")) {
      record(label, "pass", "Configured");
    } else {
      record(label, "skip", "Not configured");
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log("");
  console.log(bold(`  ${BRAND.name} - Health Check`));
  console.log(dim("  =============================="));

  // Load environment
  await loadEnv(join(PROJECT_ROOT, ".env"));

  // Run all checks
  const fetchFn: FetchFn = input => fetch(input);
  checkRequiredEnv(process.env, record);
  await checkTelegram(process.env, fetchFn, record);
  await checkDatabase();
  await checkServices();
  await checkAgentBots(process.env, fetchFn, record);
  checkOptionalIntegrations();

  // Summary
  const passed = results.filter((r) => r.status === "pass").length;
  const failed = results.filter((r) => r.status === "fail").length;
  const warned = results.filter((r) => r.status === "warn").length;
  const skipped = results.filter((r) => r.status === "skip").length;

  console.log(`\n${bold("  Results:")}`);
  console.log(`  ${PASS} ${passed} passed`);
  if (failed > 0) console.log(`  ${FAIL} ${failed} failed`);
  if (warned > 0) console.log(`  ${WARN} ${warned} warnings`);
  if (skipped > 0) console.log(`  ${SKIP} ${skipped} skipped`);

  if (failed > 0) {
    console.log(`\n  ${red("Some checks failed. Review the errors above and fix before running the bot.")}`);
    process.exit(1);
  } else if (warned > 0) {
    console.log(`\n  ${yellow("All critical checks passed, but some warnings to review.")}`);
  } else {
    console.log(`\n  ${green("All checks passed! Ready to run.")}`);
  }

  console.log("");
}

if (import.meta.main) main().catch((err) => {
  console.error(`\n  ${red("Fatal error:")} ${err.message}`);
  process.exit(1);
});
